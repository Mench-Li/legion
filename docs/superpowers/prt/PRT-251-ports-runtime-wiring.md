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

**状态**：§4 这条**没有在本批修**。理由不是难，而是它要**新增一种就绪判据**
（stdout 行），而那是 `readiness.mjs` / `launcher.mjs` 的一件事**独立**于端口接线的改动。
把它和端口改动混在一批里，会让「端口通了」与「就绪判据换了」两件事在验证上分不开——
而 §4 的证据（401 实测 + 源码坐标）已经足够让它单独成一条可执行的工作项。
**它记在这里，不假装已修。**

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
| `process-manifest.test.mjs`「端口进 argv，且在所有 launcher 旗标之后」 | 纯计划 | 顺序（`--patch` 早于 `--port`）——**确定性**，因为 `extraArgs` 由用例自己注入 |
| `process-manifest.test.mjs`「恰好出现一次」 | 纯计划 | 端口没有第二个来源（workbench 本来就有一次，不能多） |
| `process-manifest.test.mjs`「两处都给了端口」 | 纯计划 | 权威冲突必须阻塞 |
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
$env:MUTATE_ONLY='⑱,⑲,⑳'; node scratch/mutate.mjs
```

`scratch/mutate.mjs` 的 ⑱–⑳ 是本批新增的三条。**三条全部咬住**：

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
2. **§4 未修**（见上）。所以本批之后 `ports.runtime` 通了，而一个真实部署**仍然**
   会在就绪探测上失败——只是失败的**原因**从「端口没接」变成「就绪判据错了」，
   两者都指向明确的位置。这条必须如实说：**不要把它读成「runtime 现在能起来了」**。
3. `--host` **未接**：DSH 缺省 `127.0.0.1`，与清单的 `host: '127.0.0.1'` 一致，
   所以今天不需要;清单若改成别的值，这条链同样会断（同一个形状，未接）。
4. `--no-open` **未接**：`web-app/cordis.patch.yml:158` 把 `openBrowser` 接到
   `ctx.webStartup.openBrowser`，而它缺省为 `true` ⇒ 由 Launcher 启动的 runtime
   **会弹一个浏览器窗口**。这在「Launcher 自动拉起引擎」的场景下是错的，但它是
   §4 同一条线的另一面（都属「app 旗标没人传」），**本批未动**。
5. 本批**不主张**新建任务号：它是 PRT-251 的续篇，与 `PRT-214`/`PRT-253` 的续篇同例。
