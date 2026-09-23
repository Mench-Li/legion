# PRT-251 续：`ports.runtime` 没有任何路径到达 DSH 进程

> spec §6.3：Launcher 负责按**进程清单**组装每个组件的启动计划，端口是计划的一部分。
> spec §6.6 line 298：端口冲突必须在启动前判出来，而不是让它表现成「引擎起不来」。
>
> 日期：2026-09-17　状态：**缺口已修（本文含实现、判据与破坏性验证）**
> 关系：PRT-251 的续篇。记录 `ports.runtime` 这条**从配置到监听**的链断在哪里，
> 以及修它的时候撞出来的**两个更坏的东西**（§3、§4）。

---

## 1 缺口一句话

`product/process-manifest.mjs` 给 runtime 声明了 `portKey: 'runtime'` / `defaultPort: 3080`，
于是 `--port.runtime=3081` 会被**收下**、会进计划、会出现在诊断里——**但它到不了 DSH**。
改这个端口的唯一外部表现是：Launcher 以为端口换了，DSH 仍然绑 3080。

> 一个「配置里有这个端口、计划里也有这个端口」的部署，
> 与一个「端口配了但没有任何进程读它」的部署，在**启动成功**这个读数上是同一个东西——
> 只不过前者会在 3080 被占用时，报一句与真因无关的话。

## 2 事实：端口在三个地方停住了

| 层 | 坐标 | 读数 |
| --- | --- | --- |
| 配置收下 | `product/config.mjs`、`product/launcher/cli.mjs` 的 `--port.<进程>` | ✅ 收下 |
| 计划带上 | `product/process-manifest.mjs:126-127` `portKey: 'runtime'` / `defaultPort: DEFAULT_PORTS.runtime` | ✅ 带上 |
| 就绪探测用它 | `launcher.mjs` 的 `awaitReadiness()`（`proc.url` 由 `proc.port` 拼出） | ✅ 用它 |
| **交给 DSH** | `process-manifest.mjs:125` `argsTemplate: []`；`:142-156` `envNames` 里**没有任何端口键** | ❌ **断在这** |

对齐两侧的对照（同文件、同一张表）：

- workbench：`argsTemplate: ['--port', '{port}']` ⇒ 端口真的进了 argv；
- team-hub / whiteboard：`PORT_ENV_KEYS`（`launcher.mjs:100`）里有环境变量键 ⇒ 端口真的进了 env；
- **runtime：两条都没有。** 它既不在 `argsTemplate` 里，也不在 `PORT_ENV_KEYS` 里。

DSH 那一侧**是有入口的**（所以这不是「DSH 不支持」，是「我们没接」）：

- `apps/cli/src/args.ts:147` 起：launcher 自己的旗标只有
  `--profile` / `--from-default-profile` / `--patch` / `--dump-config`；
- `packages/bundle/web-app/src/startup.ts:53`：`--port <port>`
  （`'listen port; pass 0 to let the OS pick a free one'`）——它是 **app 旗标**；
- `packages/bundle/web-app/cordis.patch.yml:134-139`：`webserver` 行的
  `config.port: !!js ctx.webStartup.port ?? 3080`——**这就是 `--port` 的去处**。

## 3 ★ 修的时候撞出来的第一件事：`--port` 会把 `--patch` 吃掉

这是本缺口**真正的坑**，也是它值得单独成文的原因。

`apps/cli/src/args.ts` 的 launcher 解析器带 `allowUnknownOption()` +
`passThroughOptions()` + `.argument('[args...]')`：**遇到第一个不认识的 token 就停止
解析自己的旗标，从那以后所有东西都属于被启动的 app**。

而 Launcher 的 argv 组装是（`process-manifest.mjs:310-317`）：

```
[…configured.args, …argsTemplate, …extras]
      ↑ 含 --profile    ↑ 目前是 []   ↑ 含 --patch <覆盖层文件>
```

于是**最自然的那个修法**（把 `argsTemplate` 填成 `['--port', '{port}']`）会拼出：

```
dsh --profile web --port 3081 --patch legion-host.patch.yml
                           └─ 不认识的 token，从这里开始全是 app 参数 ─┘
```

DSH 会**照常启动**、**照常监听 3081**、**照常打印 URL**——而 `--patch` 变成了
app 参数里一个没人读的字符串。**强制面补丁层静默消失**，而这一切没有任何报错。

> 一个「端口修好了但强制面没了」的启动，
> 与一个「端口没修好、强制面还在」的启动，在**启动成功**这个读数上是同一个东西——
> 只不过前者把 Legion 的全部强制面在无声中撤掉了，而它看起来更像一次成功的修复。

（PRT-257 的 `dsh-overlay.mjs:231-232` 已经有一条断言钉着「`--patch` 必须在
`runtime.command` 自己的参数**之后**」——那条断言守的是前半段；它**不覆盖**
「`--patch` 必须在 **app 参数之前**」这后半段，因为在那之前没有任何 app 参数。）

**处置**：端口不走 `argsTemplate`，走一个**新的、位置明确的**字段（§5），
并把「launcher 旗标必须在 app 旗标之前」写成**判据**而不只是一句注释。

## 4 ★ 撞出来的第二件事：runtime 的就绪探测**永远不可能通过**

把端口接通之后，下一个问题立刻出现，而且它比端口本身更硬。

`process-manifest.mjs:129` 给 runtime 声明的就绪判据是：

```js
readiness: { kind: 'http', path: '/', expectStatus: 200, timeoutMs: 60000, intervalMs: 500 }
```

而真实 `dsh --profile web` 对 `/` 的回答是 **401**。实测（本机在跑的那个 DSH）：

```
GET http://127.0.0.1:3080/        -> 401
GET http://127.0.0.1:3080/api/health -> 401
GET http://127.0.0.1:3080/healthz -> 404
```

依据在 DSH 源码里，且是**设计如此**：
`packages/client/connection/src/browser-auth.ts:233-237` 的 `authorizeIndex()`
原文——「A valid root query token mints the cookie and redirects to clean `/`;
a valid cookie lets the caller serve the index; **every other request receives the
same minimal 401 response**」。启动令牌走 `?token=`（同文件 `:15` `TOKEN_QUERY = 'token'`）。

而 401 在 `readiness.mjs:34` 的 `FATAL_PROBE_CODES` 里落到 `http-status-mismatch`：
**不可重试、立刻熔断**（`launcher.mjs:945-948`：`fatal: result.retryable !== true
&& result.code !== 'readiness-timeout'`）。

★ 后果是**双重的**，而且方向相反：

1. 端口修好了、DSH 也真的起来了、`/` 也真的 200 不了 ⇒ Launcher 判 runtime **不可就绪**，
   而且判的是**致命**（不是「还早」）；
2. 反过来，如果 3080 上**恰好有另一个** HTTP 服务对 `/` 答 200，这条判据会**通过**——
   于是 Launcher 宣布「执行引擎已就绪」，而那个端口后面根本不是 DSH。

`readiness.mjs` 的文件头写的正是要防第 2 条（「残留的旧实例、别的程序……都会让端口能连、
甚至让 `/api/config` 返回 200」），理由是团队 hub 的 `/api/config` 会回 `auth`/`db`/`port`
可作**身份断言**。DSH 这一侧**没有等价物**：它故意让所有未认证请求同形。

DSH 自己给出的、被它明确设计为「给 supervisor 用的」信号是**stdout 那一行**：
`packages/bundle/web-app/src/index.ts:255-271` 的注释逐字写着
「The URL line and browser handoff are readiness signals: **supervisors RPC as soon as
they observe the line**」，输出格式是
`dsh web: <authenticatedUrl>`（`printUrl` 默认 `true`，同文件 `:62`）。

**状态**：§4 这条**已在后续一批修掉**（见 §8）。当时它没有被和端口改动混在一起，
理由是它要**新增一种就绪判据**（stdout 行），而那件事独立于端口接线——
混在一批里会让「端口通了」与「就绪判据换了」在验证上分不开。
下面 §8 记的就是那一批。

## 5 修法（已实施）

### 5.1 端口走一个位置明确的字段，不走 `argsTemplate`

`PROCESS_SPECS` 的 runtime 那一行新增 `portArgv`：

```js
portArgv: Object.freeze(['--port']),   // 只声明旗标；值由计划按本次端口拼
```

`materializeProcessPlan()` 把它**追加在 `extras` 之后**：

```js
[…configured.args, …argsTemplate, …extras, …portArgvExpanded]
```

于是 argv 是 `dsh --profile web --patch <覆盖层> --port 3081`——
**launcher 旗标全部在前，app 旗标全部在后**，§3 那个坑在**结构上**不可能再出现。

为什么是「新字段」而不是「把 `--port` 塞进 `extraArgs`」：`extraArgs` 的语义是
「覆盖层追加的一段」，`dsh-overlay.mjs` 与它的用例都按那个语义断言顺序。
两件不同的事共用一个数组，会让「覆盖层没接上」与「端口没接上」在读数上同形。

### 5.2 端口同时进 env 吗——不进

`PORT_ENV_KEYS` **不加** runtime，理由与 workbench 那句逐字相同
（`launcher.mjs:96-98`）：「两条路径都能决定同一件事时，『实际生效的是哪一个』
会变成每次排障都要重新确认的问题」。

### 5.3 实现坐标

| 文件 | 改动 |
| --- | --- |
| `product/process-manifest.mjs` | runtime 行新增 `portArgv: ['--port']`；`materializeProcessPlan()` 在 `extras` 之后展开它 |
| `product/launcher/launcher.mjs` | **未改**——端口本来就经 `proc.port` 进了计划与就绪 URL |
| `product/process-manifest.test.mjs` | 新例：argv 顺序、默认端口、`portArgv` 只对声明了它的进程生效 |
| `product/launcher/runtime-contract-wiring.test.mjs` | 新例（真 Launcher、真 argv）：覆盖层仍在 launcher 段 |

## 6 复现与核对（**机器判据**）

```bash
# ① 端口真的进了 argv，且**在所有 launcher 旗标之后**
node --test product/process-manifest.test.mjs

# ② 真 Launcher 拼出来的 argv 里，--patch 仍在 launcher 段
node --test product/launcher/runtime-contract-wiring.test.mjs

# ③ 反向控制：DSH 真的吃这个 argv
#    （不起服务、不碰用户在跑的 profile：--dump-config 只组合后打印并退出）
dsh --profile web --port 3081 --help      # → --port 是 app 旗标
dsh --profile web --port 3081 --dump-config >/dev/null   # → 组合通过、exit 0
```

★ 最要紧的一条判据是**顺序**，不是「含有 `--port`」：
一个只断言 `args.includes('--port')` 的用例，对 §3 那个坑**完全不敏感**——
它的 argv 里 `--port` 在、`--patch` 也在，只是后者已经不在 launcher 段里了。

### 6.1 判据落在哪一层（**一条刻意的分工**）

| 用例 | 层 | 它断的是 |
| --- | --- | --- |
| `process-manifest.test.mjs`「端口进 argv，且在所有 launcher 旗标之后」 | 纯计划 | 顺序（`--patch` 早于**整个 app 段**）——**确定性**，因为 `extraArgs` 由用例自己注入 |
| `process-manifest.test.mjs`「恰好出现一次」 | 纯计划 | 端口没有第二个来源（workbench 本来就有一次，不能多） |
| `process-manifest.test.mjs`「两处都给了端口」 | 纯计划 | 权威冲突必须阻塞 |

★ **§9 之后这张表要连着读**：本表的用例名与断言在续批里被**加强**过
（`includes` → 完整 argv 的 `deepEqual`，`--patch < --port` → `--patch <` 三个 app 旗标）。
加强而不是新增，是因为本表第 4 行暴露的那个形状——
「只查 `includes()` 的用例对『跑到错误那一段去了』完全不敏感」——
在 app 段从一项变成三项之后**风险变大了**：多出来的两项每一个都可能单独跑错位置。
| `runtime-contract-wiring.test.mjs` ①d | **真 Launcher** | 端口真的进了生产 argv、值是本次计划那个、且不进 env |

⚠️ **诚实说清 ①d 的射程**：那套 harness 是 `enforcementOverlay: false` 建的
（`runtime-contract-wiring.test.mjs:275`，它刻意不验强制面，以免身份诊断混进来），
所以它的 argv 里**没有 `--patch`**，①d 里那条顺序断言因此**在那套 harness 下不执行**。
它是有意的：顺序的确定性判据在纯计划那一层（`extraArgs` 由用例自己给）。
**但这条限制必须写下来**——否则 ①d 读起来像"真启动路径也验了顺序"，
而实际上它验的是"端口真的到了生产 argv"。

本批第一次跑破坏性验证时**正是这里露了馅**：⑲（把端口段插到 `extras` 前面）
最初指向 ①d，结果是「0 条变红」——不是因为变异没破坏性质，而是因为**靶子不在射程里**
（那条断言被 `if (patchAt >= 0)` 跳过了）。改为指向纯计划那一层之后 1/1 咬住。

> 一个"在没有那个条件时悄悄跳过"的断言，
> 与一个"那条性质其实没被守住"的实现，在绿灯清单上是同一个东西。

### 6.2 破坏性验证（每条都必须**变红**）

```bash
$env:MUTATE_ONLY='⑱,⑲,⑳'; node scripts/probes/mutate.mjs
```

`scripts/probes/mutate.mjs` 的 ⑱–⑳ 是本批新增的三条。**三条全部咬住**：

| 变异 | 期望变红 | 实际 |
| --- | --- | --- |
| ⑱ runtime 不再声明 `portArgv` | ①d | ✔ 红 1 条（端口回不到 argv，即本缺口复现） |
| ⑲ 端口段插到 `extras` **前面** | 端口进 argv | ✔ 红 1 条（`--patch` 落进 app 段） |
| ⑳ 两处都给了端口却不报冲突 | 两处都给了端口 | ✔ 红 1 条 |

```bash
node scripts/prt/progress-check.mjs
node scripts/prt/spec-progress.mjs --check
```

## 7 诚实边界

1. **没有起过一个由 Launcher 完整启动的部署**（用户的 DSH 正在 3080 上跑着，
   本批不动它）。判据落在**计划与 argv** 上，那正是本缺口的发生层。
2. ~~**§4 未修**（见上）。~~ **已在 §8 修掉。** 上面这句原文保留划掉，
   因为它记录了当时的真实状态：本批之后 `ports.runtime` 通了，而一个真实部署
   **仍然会**在就绪探测上失败——只是原因从「端口没接」变成「就绪判据错了」。
3. ~~`--host` **未接**~~：**已在 §9 接上**（`hostArgv`）。原文保留：
   当时 DSH 缺省 `127.0.0.1` 与清单的 `host: '127.0.0.1'` 一致，
   所以"不用它也能跑"——但那是**两边缺省值恰好相同**，不是链子接上了。
4. ~~`--no-open` **未接**~~：**已在 §9 接上**（`boolArgv`）。原文保留：
   `web-app/cordis.patch.yml:158` 把 `openBrowser` 接到
   `ctx.webStartup.openBrowser`，缺省 `true` ⇒ 由 Launcher 启动的 runtime
   **会弹一个浏览器窗口**。
5. 本批**不主张**新建任务号：它是 PRT-251 的续篇，与 `PRT-214`/`PRT-253` 的续篇同例。

---

## 8 后续批：§4 已修 —— 就绪判据改成 DSH 自己那一行

### 8.1 修法

`process-manifest.mjs` 给 runtime 的就绪判据从「对 `/` 要 200」改成
「stdout 上出现那一行」：

```js
readiness: Object.freeze({
  kind: 'stdout',
  stream: 'stdout',
  expectMatch: '^dsh web:\\s+(https?://\\S+)',
  portGroup: 1,
  timeoutMs: 120000,     // 见 8.3：信号在 Loader 结算之后才打，60s 不够稳
  intervalMs: 250,
  verified: false,
})
```

`readiness.mjs` 新增三件东西，且**只有一套等待循环**：

| 新增 | 作用 |
| --- | --- |
| `READINESS_KINDS` | `http` / `stdout` / `none` 三种判据的显式枚举 |
| `createLineCollector()` | 按行收集子进程输出，**有界**（`maxLines` / `maxLineBytes`），并提供 `clear(key)` |
| `probeStdoutOnce()` | 从行缓冲里找那一行，取出端口，与 `plannedPort` 比对 |
| `waitForProbe()` | **唯一**的等待循环；`waitForReadiness`（http）与 `waitForStdoutReadiness` 都只是包一层 |

★ **为什么只有一套循环**：两套循环会长出两套超时语义，而
`readiness.mjs` 里「不要睡过 deadline（30s 的承诺不能变成 30.25s）」那条约束
只会在其中一套上被想起来。「两种判据对 30 秒的理解不一样」是那种只有到现场
才会发现的漂移——而它的表现是「有的进程超时快、有的慢」，看起来像进程的问题。

`launcher.mjs` 三处接线：

1. `onOutput` 里**先** `outputLines.push(...)` 再写日志 sink。
   顺序不是随意的：sink 可能根本没建起来（那是遗憾，不是故障），
   绑在一起会让「没有日志」顺带变成「永远等不到就绪」。
2. `awaitReadiness()` 新增 `stdout` 分支，且**必须排在**原来那条
   `if (r.kind !== 'http' …) { handle.markReady(); return }` 早退**之前**——
   那条的判据是「不是 http」，任何别的判据都会被它当成「没有就绪判据」
   而**立刻算就绪**。于是「判据没实现」与「判据通过了」是同一个读数。
3. spawn 循环里每次 `.start()` **之前** `outputLines.clear(proc.key)`。

### 8.2 ★ 它比 HTTP 探测**更强**——这是"为什么可以换"的关键

那行文字来自**我们 spawn 的那个进程本身**，那是一份身份证明。
对一个端口发请求不是：谁都可以在那个端口上听着。

这正好补上了 §4 里指出的那个缺口——team-hub 有 `/api/config` 可做身份断言，
DSH 没有等价物（它故意让所有未认证请求同形），
**它的身份恰恰在「这是我儿子说的」这件事上**。

### 8.3 两个刻意的取值

- **超时 60s → 120s**：`announceReady()` 在 Loader 整棵树结算**之后**才打，
  不是端口一张开就有。判据变严了，等待窗口也得跟着放宽——
  否则「判据对了但 60 秒不够」会表现成一次假超时，
  而假超时最难查：它看起来像「DSH 起得慢」。
- **匹配只取 URL 那一段**（`(https?://\S+)`）：后面可能还跟着 `(LAN: …)`，
  而我们要的是回环那个。整行匹配会让 LAN 那一段把结果带偏。
- ★ **必须要求后面真的跟一个 URL**，不能只锚 `^dsh web:`。已对着 DSH 源码
  核过（`packages/bundle/web-app/src/index.ts`）：

  | 行 | 内容 |
  | --- | --- |
  | `:271` | `console.log(\`dsh web: ${authenticatedUrl}${…}\`)` ← **判据要的就是它** |
  | `:274` | `console.log('dsh web: opening the default browser; pass --no-open to disable')` |

  第 274 行**也**以 `dsh web: ` 开头，而且它在 `printUrl` 为假、`handoffBrowser`
  为真时（`:252` 的条件是 `printUrl \|\| handoffBrowser`）**仍然会打**。
  于是"只锚前缀"的判据会在 **URL 那一行根本没打出来**的时候被这一行满足——
  一次**假就绪**，而它看起来完全正常。用例 ⑳ 把这条单独钉住。

- ⚠️ **判据成立的前提是 `printUrl` 为真**（缺省 `true`，`:62`）。
  已核 `runtime/dsh-composition/legion-host.patch.yml` **没有**动
  `printUrl` / `openBrowser` / `webStartup`，所以今天成立。
  但若将来有人为了"不打印 URL"把它关掉，**就绪判据会静默失效**
  （进程起得来，而 Launcher 永远等不到那一行 ⇒ 120 秒假超时）。
  这条依赖**没有**被任何判据守着，如实记在这里。

### 8.4 ★ 凭证：`redactText()` 拦不住这一行，所以只能"不把它带出来"

DSH 那一行是 `dsh web: http://127.0.0.1:<port>/?token=<启动令牌>`——
**那是一枚浏览器凭证**，拿到它就能进那个 Web 面。

而共享的 `redactText()`（`runtime/contracts/redact-patterns.mjs`）的
「URL 内嵌凭证」只认 `user:pass@` 形态，**不认查询串里的 `?token=`**。
所以日志/诊断的脱敏那道闸对它是**无效**的：

```js
redactText('dsh web: http://127.0.0.1:3081/?token=S3CRET').text
//  ⇒ 原样返回，令牌还在（用例 ㉑ 把这条事实钉住）
```

于是保护只能来自设计：`probeStdoutOnce()` 的读数里**只有**
「哪条模式匹配上了」+「端口对不对」，**没有那一行**。
诊断文案报成 `stdout:/<模式>/`，不报匹配内容。

> 一个「反正有脱敏」的假设，与一个「脱敏其实不认这种形态」的事实，
> 在被写进日志之前是同一个东西。

### 8.5 机器判据

```bash
node --test product/launcher/readiness.test.mjs      # 24 例，⑯–⑳ / ㉑ / ㉒ 是新增
node --test product/process-manifest.test.mjs
```

★ 最要紧的一条是 **⑯**：它起一个**真的子进程**，那个子进程同时做两件事——
在 `/` 上答 **401**（像 DSH）、在 stdout 上打那一行（像 DSH）——
然后在**同一次真实启动**上比两条判据：

| 判据 | 结果 |
| --- | --- |
| `stdout` | ✔ 通过，且取到的端口 === 它报的端口 |
| `http`（旧的） | ✖ `http-status-mismatch`，且 **`retryable: false`** |

把「它只是会超时」与「它会立刻熔断」分开钉住，是因为两者在「启动失败」
这个读数上一样，而排查方向完全不同。

**㉒ 是源级钉子**，如实标注：它断的是 `launcher.mjs` 的 spawn 循环里
**确实**调了 `outputLines.clear(proc.key)`。要行为化地验它，得让一个真 DSH
先报一次就绪、再崩、再重启——那需要一份真检出与几十秒。但那一句**必须**
被某个东西钉住：删掉它时套件其余用例**全绿**
（`createLineCollector.clear` 自己有用例，而「有没有人调它」是另一件事）。

### 8.6 破坏性验证（追加 ㉛–㉝、㉟、㊳）

| 变异 | 期望变红 | 实际 |
| --- | --- | --- |
| ㉛ stdout 判据不再比对端口 | ⑰ | ✔ 红 1 条 |
| ㉜ 把匹配到的**整行**塞进读数 | ㉑ | ✔ 红 1 条 |
| ㉝ `clear()` 变成空操作 | ⑱ | ✔ 红 1 条 |
| ㉟ spawn 循环不再清行缓冲 | ㉒（源级钉子） | ✔ 红 1 条 |
| ㊳ `expectMatch` 写成编译不过的正则 | 清单声明 | ✔ 红 1 条 |

★ 全量 harness 一次：**33/33 咬住，还原后全绿**（基线也全绿）。

### 8.6.1 ★ 这一批咬出来的三件"假绿"，都比改动本身值钱

**(1) 替身替错了 DSH 的行为。** `runtime-contract-wiring.test.mjs` 的 runtime 替身
以前对 `/` 答 **200**——那正是旧判据想要的东西，而**真 DSH 答 401**。
于是那一组用例的 8 条，其"就绪"绿灯来自一个 DSH 不会有的行为。
判据一改，它们集体以 135 秒超时变红——**红的不是新判据，是替身与真身不一致**。
修法是把替身改成 401 + 打那一行（§8.6 之前那一步），改完 1.9 秒全绿。

> 一个按"我以为它是什么样"搭起来的替身，
> 与一个按"它实际是什么样"搭起来的替身，在**被验的那条判据**上读数相同；
> 差别要等到判据换掉的那一天才显形，而那时它表现为"新判据是坏的"。

**(2) 端到端范围用例的假绿。** ㉞ 第一次跑出 **0 条变红**：把 `--include` 的范围
从 `start()` 里拿掉，用例 ㉚ 仍然绿。原因是本机 3080 上跑着用户的 DSH，
而 runtime 的缺省端口就是 3080 ⇒ 体检在 `ports` 阶段就失败 ⇒ `start()`
**根本走不到接管** ⇒ "盘上没写"成立，但它与"范围生效了"毫无关系。
修法是 `allowPortInUse` + 断言 `pre.ok === true` + 断言接管**真的执行过**
（`LEGACY_ADOPTION` 诊断存在）。三处一起加，这个形状才不会回来。

> 一条"因为什么都没跑所以盘上没写"的用例，
> 与一条"因为范围生效所以盘上没写"的用例，在盘上是同一个读数。

**(3) `expect` 写成了断言消息。** ㊲ 与 ㊳ 先后踩到：harness 的 `expect` 比的是
**用例名**，而我把"污染全量读数""编译不过"这种**断言消息**写了进去。
用例确实红了，harness 却报"没咬住"。

> 一个把"红了"读成"没红"的判据，比没有判据更坏——
> 它会让人去改一个本来正确的实现。

同一类问题在 ③ 那批也出现过一次（⑳ 的 `expect: 'PORT_AUTHORITY_CONFLICT'`）。
**这条已经犯了三次**，所以在这里合并记一条：
`expect` 只接受用例名的**子串**，且用例名里的 markdown 粗体标记
（`**不许**污染`）会把词隔开——写子串时要避开它。

### 8.7 追加的诚实边界

- **仍然没有起过一个由 Launcher 完整启动的部署。** ⑯ 用的是「像 DSH 那样」的
  真子进程，不是真的 DSH。**不要把本批读成「完整切换已经能成功了」**——
  它说的是「就绪判据这一条不再是拦路的那一条」。（`--host` / `--no-open`
  已在 §9 接上。）
- **那一行本身没有在真 DSH 上观测过**：`:271` 的格式是**读源码**核实的
  （不是我看着一个真 DSH 打出来的）。本机那个 DSH 在 3080 上跑着，
  动它不在这批的授权范围里。
- 120s 是**推理出来的**取值（信号在 Loader 结算之后），**没有在真机上量过**
  DSH 从 spawn 到打那一行要多久。
- ⑯ 起真子进程；在禁止管道 stdio 的沙箱模式下它会被拒（EPERM）。
  本仓库的既有套件已经依赖真子进程，所以这不是新约束。
- ★ **一条教训（本批第 5 项工作记录）**：这一批中途用 PowerShell 的
  `Get-Content -Raw` + `Set-Content -Encoding UTF8` 改过一个用例文件，
  而它把 UTF-8 的中文按 GBK 读进来又写回去，**整个文件的中文注释与用例名
  全毁了**（GBK 有无法映射的字节，逆向还原也有损）。修复方式是
  `git checkout --` 取回原始文件再用编辑工具重放改动。
  教训：**这个仓库的源码里有大量中文，任何"读进来再写回去"的
  非 UTF-8 感知路径都会静默毁掉它**——而且毁掉之后
  `node --check` 仍然是通过的（中文只出现在注释与字符串里），
  只有用例名对不上时才会以"变异没咬住"这种**看起来像实现问题**的方式暴露。

---

## 9 后续批：`--host` / `--no-open` 已接（app 段补全）

### 9.1 修法：一个概念，三个字段

§5.1 把 `--port` 从 `argsTemplate` 里拆出来，理由是它是**位置敏感**的：
必须在所有 launcher 旗标之后。而"位置敏感"不是端口的特性，是**整个 app 段**的特性。
于是本批把那一段补全成三个字段，语义上是同一件事的三种形态：

| 字段 | 形态 | 值来自 | 本轮 |
| --- | --- | --- | --- |
| `portArgv: ['--port']` | 值旗标 | `ports.runtime` | PRT-251 续 |
| `hostArgv: ['--host']` | 值旗标 | 本 spec 的 `host` | **本批** |
| `boolArgv: ['--no-open']` | **开关**（无值） | 无 | **本批** |

`materializeProcessPlan()` 里的顺序固定为
`[…configured.args, …args, …extras, …hostArgs, …portArgs, …boolArgs]`：
**launcher 段 → app 段**，app 段内部先值旗标后开关。
固定顺序不是洁癖——`deepEqual` 这种"完整 argv"的断言只有在顺序确定时才写得出来，
而 §6.1 已经证明过：只查 `includes()` 的用例对"跑到错误那一段去了"完全不敏感。

### 9.2 ★ 为什么两个**值**来源要阻塞，而重复一个**开关**要跳过

这是本批唯一一个**看起来可以共用一条规则、其实必须分开**的地方。

```
两个【值】来源  ＝ 两个不同的答案  ⇒ 谁生效取决于 argv 先后 ⇒ 阻塞启动
重复一个【开关】＝ 同一个断言说两遍 ⇒ 再写一个是噪音       ⇒ 跳过，不报错
```

所以 `runtime.command` 里已经写了 `--port` / `--host` 时产出
`PORT_AUTHORITY_CONFLICT` / `HOST_AUTHORITY_CONFLICT`（都是 error、都阻塞），
而里面已经写了 `--no-open` 时**什么都不报**。

> 把开关也按值旗标处理，等于因为用户写了一句"不要开浏览器"就**拒绝启动**——
> 而那条命令正是产品想要的形状。

`--host` 那一面比端口更隐蔽：`ports.mjs:175` 拿**清单的** `host` 去做 `canBind()`
探测。于是两个 host 来源意味着「探测说 `127.0.0.1` 可用、而进程其实绑在别处」
是可能的，且外部看不出差别——与 §5.1 里"端口是谁的"那个形状逐字相同。

★ 注意配置里**没有** `NO_OPEN_CONFLICT` 这个码，而且不该有（`config-schema.mjs`
里那条注释是刻意写的）。

### 9.3 ★ `--no-open` 不是"少一个便利"，是绕过一道闸

Launcher **自己**管着"打开界面"这个决定，而且管得比裸进程更严：
`tray-wiring.mjs` 只在见过 `READINESS_VERIFIED` **之后**才把 workbench 地址
交给浏览器，并且为此写了一段理由（"`status().processes[].url` 是**计划**，
不是**读数**"）。

一个由 Launcher 拉起的 runtime 自己弹浏览器，等于**绕过**那道闸：

> 在没有任何人观测过它是否就绪之前，用户的桌面上就多了一个页面。

这也解释了为什么它属于 PRT-251 这条线（"app 旗标没人传"），
而不是一条独立的体验优化。

### 9.4 `--host` 今天不改变行为，但也不是装饰

`host` 这个字段在接上 `hostArgv` 之前就已经**参与探测**（`canBind`），
所以"清单说 `127.0.0.1`、探测也探 `127.0.0.1`、而真正 bind 的是 DSH 自己的缺省值"
这件事，全靠**两边缺省值恰好相同**才对得上。接上之后 `host` 才从
"参与探测的字段"变成"参与探测**并且**决定实际监听"的字段。

而这条差别要等到有人改 `host` 那天才显形——那时如果没接上，
表现是「探测按新 host、进程按旧缺省」，即**体检通过而服务不在那儿**。

⚠️ 顺带核到一条 DSH 的硬约束：`--host 0.0.0.0` 会被 DSH 自己
`program.error` 拒绝（`startup.ts:75`，原文：
"intentionally not supported yet for safety: it would expose remote code execution
to the network; use 127.0.0.1 instead"）。清单侧的 `validateProcessPlan()`
早就有 `NON_LOOPBACK_BIND` 挡着同样的东西，两处口径一致——这是好事，
但**两处是各自独立的**，不是一处挡两处。

### 9.5 机器判据

```bash
node --test product/process-manifest.test.mjs            # 19 例（+5）
node --test product/launcher/runtime-resolve.test.mjs     # 19 例（生产 argv 的端到端）
```

| 用例 | 它断的是 |
| --- | --- |
| 清单「端口进 argv，且**在所有 launcher 旗标之后**」 | **完整 argv**（`deepEqual`，不是 includes）+ 三个 app 旗标全在 `--patch` 之后 + 开关不带值 |
| 清单「`--no-open` 进了 runtime 的 argv，且**只有**它带这个开关」 | 开关没扩散到别的进程（那是 DSH 的旗标，别的进程的解析器对未知旗标行为各不相同） |
| 清单「开关旗标用户已经写了 ⇒ 跳过，而不是报冲突」 | §9.2 那条规则本身 |
| 清单「`--host` 两处都给了 → 与 `--port` 同一条规则」 | host 冲突也阻塞；**且不误报端口冲突**（用户没写 `--port`） |
| 清单「`host` 与 `hostArgv` 一一对应」 | 两个方向的静默空操作（有 host 无 `hostArgv`＝接了个寂寞；有 `hostArgv` 无 host＝一个什么都不发的字段） |
| 清单「开关旗标是**零参数**的」 | `['--no-open','true']` 会让 DSH 把 `true` 当位置参数，而 argv **仍然**"包含 `--no-open`" |
| 清单「清单契约版本被钉住」 | 见 §9.5.1 |
| `runtime-resolve`「没有 `--runtime-command` 时，命令来自 current.json」 | ★ **生产 argv 的真实形状**——真 `createLauncher().start()`、真 spawn，argv 逐字相等 |

### 9.5.1 ★ 顺带补上一次**漏掉**的递增：`PROCESS_MANIFEST_VERSION` 1 → 2

这个常量的注释写着「清单结构变化时递增」，而**加字段就是结构变化**：

| 批次 | 加的东西 | 版本 |
| --- | --- | --- |
| PRT-251 续 | runtime 行新增 `portArgv` | 留在 `1` |
| **本批** | runtime 行新增 `hostArgv` / `boolArgv` | **提到 `2`** |

于是这个常量的含义与它的值**已经不一致了两批**：一个读
`PROCESS_MANIFEST_VERSION === 1` 的消费者，有理由认为行上不存在这三个字段，
而它们一直都在。

把它提上去而不是继续留着，是因为：

> 一个说"结构没变"的版本号，与一个真的没变的清单，
> 在只读代码的人眼里是同一个东西。

⚠️ 今天**没有**任何消费者读这个值（全仓库只有 `product/index.mjs` 的再导出；
`role-pack` / `packs` 那些 `manifestVersion` 是**另一套东西**，我核过）。
所以这次递增**不改变任何行为**——它的作用是把"这个常量说了谎"变成
"它说的是真的"。值由用例钉住（变异 ㊹ 验它真的会被红）。

★ 这是一次**补账**，不是本批的功能改动。我把它单独列出来是因为
"我修了 A 顺便发现 B 记错了"这件事如果只体现在 diff 里，
下一个人会以为版本号本来就是 2。

### 9.6 破坏性验证（追加 ㊴–㊸）

```bash
$env:MUTATE_ONLY='㊴,㊵,㊶,㊷,㊸,㊹'; node scripts/probes/mutate.mjs
```

| 变异 | 期望变红 | 实际 |
| --- | --- | --- |
| ㊴ runtime 不再声明 `boolArgv` | `runtime-resolve` 端到端 | ✔ 红 2 条 |
| ㊵ 开关也按值旗标处理（用户写了就报错） | 「而不是报冲突」 | ✔ 红 1 条 |
| ㊶ 开关总是追加（不跳过 ⇒ 两次） | 「而不是报冲突」 | ✔ 红 1 条 |
| ㊷ runtime 不再声明 `hostArgv` | 「端口进 argv」 | ✔ 红 6 条 |
| ㊸ `boolArgv` 写成带值形态 | 「零参数」 | ✔ 红 7 条 |
| ㊹ 契约版本留在 `1` | 「清单契约版本被钉住」 | ✔ 红 1 条 |

★ ㊴ 与 ㊷ 的 `expect` 刻意指向**端到端**那条（㊴）与**完整 argv**那条（㊷），
不是清单的字段存在性断言：`包含 --no-open` 与 `真的带着 --no-open 去 spawn`
是两件事，而后者才是用户会看到的东西。

★ ㊸ 是本批最值得留着的一条：带值之后 argv 里**仍然**"包含 `--no-open`"，
所以**所有**用 `includes()` 写的用例照绿，只有"零参数"那条看得出来。
它同时是 §9.5 里那条设计（完整 argv + 开关不带值）的**必要性证明**。

### 9.7 本批的诚实边界

- **仍然没有起过一个由 Launcher 完整启动的部署。** §9.5 最硬的那条
  用真 `start()` 与真 spawn 抓到了**生产 argv**，但被 spawn 的那个 runtime
  是**替身**（否则会去抢 3080，而用户那个 DSH 正在上面跑）。
  所以本批证明的是「argv 是对的」，**不是**「DSH 收到这些旗标之后行为是对的」。
- **`--no-open` 之后的行为没有观测过**：我没有看着一个真 DSH 在带 `--no-open`
  时不弹浏览器。判据是"旗标在 argv 里"＋"DSH 的帮助文本把它列为 app 族旗标"，
  不是"我见过它不弹"。
- **`--host` 的值一律来自清单**，产品配置里**没有** `host` 这一项
  （只有 `ports.*`）。所以「想让 runtime 绑别的地址」今天做不到——
  这与 spec §10「默认只监听 loopback」一致，但**不是**一条被文档
  明确裁决过的限制，如实记在这里。
- **`openBrowser` 仍然缺省为 `true`**：`legion-host.patch.yml` 没有动它。
  本批是让 Launcher **显式地**不要它，而不是改掉 DSH 的缺省。
  若将来有人从 `runtime.command` 里手写启动，仍然会弹——那是他们的选择。
