# 单入口自启：只启动 Legion，不手工启 DSH（设计与现状）

> 目标（用户 2026-09-30 提出）：**后期应当是反向的 —— 只需要启动 Legion，
> 就能直接完成所有内容，不依赖 DSH 的 web/desktop 启动。**
>
> 本文记录：现在能直接做到哪一步、缺哪一环、以及朝向目标的中间形态。
> 档案接线（本目标的第一步）见 [档案接线](PROFILE-WIRING.md)；产品化那条线的现状见
> [`product/launcher/`](../../product/launcher/) 与 [STATUS.md](STATUS.md) 里 PRT-257 的记述。

## 1. 一个绕不开的事实：执行面**就在 DSH 宿主里**

`dsh-scrum-worker` 是一个 DSH 插件：它在**宿主进程内**起 interval、认领任务、用宿主的
subagent 能力派工。所以"不依赖 DSH 启动"这句话，正确的读法是
**"不依赖用户手工去点 DSH Desktop 或敲 `dsh web`"**，而不是"没有 DSH 进程也能派工"：

| 层 | 谁提供 | 能不能脱离 DSH 进程 |
| --- | --- | --- |
| 数据面 `team-hub :8787` | 纯 node 脚本 | ✅ 能（现在就由 `legion-services` 托管） |
| 指挥面 `workbench :5173` | 纯 node 脚本 + 静态产物 | ✅ 能 |
| **执行面（守护/派工）** | **DSH 插件**（宿主进程内） | ❌ 不能——它需要一个活着的 DSH 宿主 |

结论：单入口要做的不是"去掉 DSH"，而是**由 Legion 自己把那个宿主拉起来并盯住它**
（谁启动、用哪个 profile、补丁层指哪、退出怎么收回、崩了怎么重启）。

## 2. 宿主的启动命令行（本机实测形状）

```text
"D:\software\dsh\DeepSeek Harness.exe" --expose-internals \
  D:\software\dsh\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js \
  <dsh 包目录> <profile 目录> <runtime 目录> <pnpm> <runtime bin> ...
```

- Desktop 的 profile 是 `C:\Users\11150\.dsh\profiles\desktop`（GUI 在 `:19387`）。
- 同一套 CLI 的 `web` 模式：`dsh web`（profile 取 `web`，默认 `:3080`）。
- 官方 CLI 垫片：`D:\software\dsh\resources\runtime\cli\bin\dsh.cmd`
  （内部就是 `DeepSeek Harness.exe --expose-internals <cli.js> %*`，并设 `ELECTRON_RUN_AS_NODE=1`）。
- 环境里已有 `DSH_HOME` / `DSH_PROFILE` / `DSH_PROFILE_DIR` / `DSH_WEB_URL`，
  **但没有 `dsh` 在 PATH 上** —— 所以"单入口"必须自己解析 CLI 路径，不能指望 `dsh` 命令存在。

## 3. 两条路径，按代价从低到高

### 路径 A（已落地第一批）：`scripts/legion-start.mjs`

```
node scripts/legion-start.mjs                 # 接线 + 拉宿主 + 盯就绪（前台，Ctrl+C 结束回收）
node scripts/legion-start.mjs --check         # 只体检：不接线、不拉宿主，报当前就绪情况
node scripts/legion-start.mjs --profile web   # 换档案（默认 web）
node scripts/legion-start.mjs --no-spawn      # 已有军团就不重复起宿主（会明说"已经就绪"）
```

职责四件：① 调 `legion-profile.mjs --wire`（幂等）② 找宿主入口并拉起
③ 盯三面就绪（数据面 / 指挥面 / **执行面心跳前进**）④ 盯退出并如实报退出码。
宿主入口按"这份 Legion 真正会用哪一份"排序：Legion DataDir 的 `current.json` 现役指针
（产品 Launcher 走的就是它）→ 用户级 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js`。
**刻意不联网安装**：一个会在离线机器上先超时、再报一个与真实原因无关的错的安装器，
比没有安装器更坏。

**已实测**（2026-10-03，本机军团正在运行时）：

```
$ node scripts/legion-start.mjs --check
① 跳过接线（--no-wire/--check）
体检（不启动任何东西）
  数据面 team-hub :8787/api/config        ✅  (200)
  指挥面 workbench :5173/                 ✅  (200)
  中枢代理 :5173/hub/api/config           ✅  (200)
  执行面 守护心跳 9s 前                    ✅
exit=0

$ node scripts/legion-start.mjs --no-spawn --no-wire
② 宿主入口
  · legion-data-dir: C:\Users\11150\AppData\Local\Legion\data\runtime\dsh\versions\0.1.5-rc.2\…\lib\bin.js v0.1.5-rc.2
  · user-profile:    C:\Users\11150\.dsh\profiles\node_modules\@deepseek-ai\dsh\lib\bin.js v0.2.0-rc.2
③ 已经就绪（四行 ✅）→ 不再重复启动宿主
exit=0
```

**诚实边界（这一批没做到的）**：`spawnHost()` 那条分支**没有在本机真跑过**——
本机已经有 DSH Desktop 在跑（它自己就是宿主），再拉一个 web 宿主会变成两个宿主同时扫单
（同一个 `scope=software`、同一个仓库）。要证明"从零拉起"，需要在**没有 Legion 宿主**的
状态或另一台机器上跑；本机要跑就得先关掉 Desktop（会中断当前 GUI 会话）。
所以现在能确证的是：**入口能找对宿主、能判对就绪、在已就绪时不重复起**；
"它会成功把宿主拉起来"仍是一个**待验证**的断言。

### 路径 B（产品形态）：走 `product/launcher/` —— 侦察结论（2026-10-03）

`product/launcher/` **不是半成品**：Legion 自己的 DataDir 已初始化，DSH 运行时
**0.1.5-rc.2 已装好**，四个 `@dsh-external/*` junction 已真实建成（`install-complete.json`
里 `legionRoute: "junction-from-install-dir"`），`launcher-run.json` 里还有一次 5 个进程的
成功启动记录（`run-1790240886715-2728`，2026-09-24）。

入口与判据（实测）：

| 事项 | 事实 | 证据 |
| --- | --- | --- |
| 入口 | `node product/launcher/cli.mjs [flags]`（在仓库根跑） | `cli.mjs:1872-1877` |
| 缺 `--workspace` | **拒绝**，exit 3（`WORKSPACE_NOT_CONFIGURED`） | `product/paths.mjs:401` |
| `runtime.command` 为空 | **不是**"必须手填"：走 `<DataDir>/runtime/dsh/current.json` 现役指针，拼 `node <entry> --profile <name>` | `runtime-resolve.mjs:334-397`、`:252-269` |
| `--profile` | **CLI 没有暴露**这个开关（`dshProfile` 默认 `'web'`） | `runtime-resolve.mjs:93`，cli 里 grep 0 命中 |
| 端口被占 | **阻塞**：exit 4 `PORT_IN_USE` | `launcher.mjs:1449-1452` |
| identity 三件 | 缺则**阻塞**（本机已配好：`owner:11150` / `software` / `employee-run`） | `enforcement-identity.mjs:109`、`cli.mjs:495` |
| headless | **不能**替宿主：`dsh headless` 是一次性任务运行器；且 Launcher 的就绪判据写死 stdout 的 `^dsh web:\s+(https?://\S+)`，headless 永不匹配 → 120s 超时 | `dsh --help`；`product/process-manifest.mjs:245-253` |

**真正缺的那一环**：全仓**没有任何代码创建/填充 `$DSH_HOME/profiles/<name>`**。
DSH 自己提供 `--from-default-profile <name>`（从随发行模板初始化一个自定义 profile），
但 Legion 侧从未调用它。也就是说产品化这条线缺的不是"启动能力"，而是
**"宿主侧那棵树谁负责"**——这正好就是本批 `scripts/legion-profile.mjs` 干的事，
可以整体搬进 `product/launcher/`（或由 installer 调它）。

另一个待定论的点（只读证据无法判定）：DSH 解析 `@dsh-external/*` 时，
命中的是 **DataDir 运行时树**里的那 4 个 junction，还是 **profile 树**里的那 4 个
（两套都在）。这需要一次真启动 + 刻意破坏其中一套来定论。

## 3.5 隔离验证做了什么、发现了什么（2026-10-03 第二轮）

为了**不靠"应该能行"**，我们在 `%TEMP%` 造了一套假 `DSH_HOME`（`scratch/make-probe-profile.mjs`），
用真 DSH 运行时起真宿主，脚本是 `scratch/probe-cli-shapes.mjs` / `scratch/probe-legiondir-root.mjs`。

### 已经被抓到并修掉的三处真 bug（都在"拉起宿主"这条路上）

| # | 症状 | 根因 | 修法 |
| --- | --- | --- | --- |
| ① | `spawn` 直接 `EFTYPE` | 解析出来的入口是**一个 `.js` 文件**，却被当成可执行文件 spawn | 脚本入口用 `node` 跑（`hostArgv` ②） |
| ② | 宿主 `error: too many arguments … got 1: web`（0.2.0-rc.2）/ `web takes none of parent --profile…`（0.1.5-rc.2） | 这两条错是**两个运行时对"launcher 段 + app 段"组合的不同解析**在同一处冒出来；档案名走环境变量是**已实测能起来**的那一种形状 | 档案名走 `DSH_PROFILE` 环境变量（`hostArgv` ③）。★ 2026-10-03 第三轮**更正**：早先写的"`--profile` 被 node 吃掉"是**错的**——把 profile 名换成一个不存在的名字，DSH 会报错退出（`--profile no-such-profile-xyz` → exit 1），说明 **DSH 确实看得到这个旗标**。见 3.6 |
| ③ | 隔离探针**一次都没走到 spawn** | "已就绪"短路对任何 profile 都生效，真实军团替探针档案回答了"已就绪" | 短路只对默认档案（web/desktop）生效 |

### 已经确证的（磁盘/日志事实）

- `legion-start --no-wait-ready` 在假 `DSH_HOME` 里**真的把宿主拉起来了**：宿主打印
  `dsh web: http://127.0.0.1:19517/?token=…`，12 秒内保持存活（随后 SIGTERM 回收）；
  真实 8787/5173/19387 全程不受影响。
- `- insert:` 里那一行的 **`config` 确实会交给插件**：`teamHubPort: 19887` 出现在插件自己的挂载行里。
- `services-plugin` 的 `legionDir` **有守卫**：只有"看起来像 legion 根"（三个入口文件都在）的目录才被采纳；
  空目录/无效路径会被**正确拒绝**并回落到"插件自身位置"，挂载行会写明来源是 `config.legionDir` 还是回退。

## 3.6 隔离沙箱的边界（第三轮实测，含一处自我更正）

**沙箱做不到"手搓一个任意 profile 来验证插件装载"**，这是本轮量出来的边界，不是猜测：

| 实验 | 做法 | 读数 | 说明 |
| --- | --- | --- | --- |
| 探针插件是否被装载 | 在 profile 的 `node_modules/@probe/hello` 放一个零依赖插件，`apply()` 时写标记文件；补丁里 `- insert: - name: '@probe/hello'` | 宿主就绪 ✅，**标记文件始终不出现** ❌ | 不是"包解析不到"，而是这一行根本没被装载 |
| 补丁文件是否被读 | 把 `cordis.patch.yml` 写成**顶层映射**（DSH 的 `parsePatchList` 对这种形状必抛 `must be a top-level YAML array…`） | 宿主**照常就绪**，那条错**一次都没出现** ❌ | 该形状的补丁文件**根本没被读** |
| 对照 | 补丁文件**删掉** / 写成合法空数组 `[]` | 照常就绪 | 说明"就绪"这个读数对这个实验**不敏感** |

两个实验合起来指向同一件事：**手搓的 profile 目录不等于 DSH 认可的 profile** ——
DSH 大概只对"由它自己的机制创建/登记过"的 profile 应用用户补丁层，手写一个
`profiles/<name>/` 目录能让它起来，但补丁层不会被装载。

所以：**"手搓档案"这条验证路走不通**（不是 Legion 的问题）；要验"全新档案装载插件"，
必须走 DSH 自己的建档案机制（例如 `dsh --from-default-profile <name>` 或
`dsh plugin --profile <name> add <pkg>`），那是下一轮的事。

**对本目标的影响**：`web` 与 `desktop` 两个**真实**档案都是经 DSH 机制存在并被装载的
（`.legion-services.log` 里有补丁行生效的实证：`legion-services 挂载` + 两个服务被拉起），
所以本目标的"两个档案都能随宿主自动起"不受这条边界影响；
受影响的只有"用沙箱预演新档案"这种验证手段。

## 3.7 运行时 × 档案：谁能起、补丁层有没有被应用（第三轮结论，含一处更正）

脚本 `scratch/probe-runtime-profiles.mjs`（`--dump-config`，只组合、不监听端口、不写库）：

| 运行时 | `--profile web` | `--profile desktop` |
| --- | --- | --- |
| 0.1.5-rc.2（Legion DataDir） | exit 0，**5 处** `patched by …\profiles\web\cordis.patch.yml`；组合树里 `@dsh-external/dsh-legion-services` ×1、`dsh-scrum-worker` ×7 | **exit 1**：`profile "desktop" is managed exclusively by the Electron application` |
| 0.2.0-rc.2（用户级） | exit 0，同样 5 处分节 + 同样的 Legion 行 | **exit 1**，同一条错文 |

### 两条硬结论

1. **`--profile <name>` 是对的写法**，我上一轮写的"`--profile` 被 node 吃掉"**是错的，更正**：
   判别实验是把档案名换成一个**不存在的名字** —— `node <bin.js> --profile no-such-profile-xyz --dump-config`
   → **exit 1**（DSH 报错）；不给 `--profile` → `error: --profile <name> is required`。
   两个运行时都会因为"没有这个档案"而失败，说明**DSH 确实收到了这个旗标**。
   于是产品 Launcher 现有的 argv 形状（`runtime-resolve.mjs:261` →
   `args: [entryPath, '--profile', profile, ...]`，再由 `process-manifest.mjs:487`
   拼成 `node <entry> …`）**是可行的**，不需要为它改形状。
   （`legion-start` 里改用 `DSH_PROFILE` 依然有效、也已实测，但它是**等价替代**，不是唯一正解。）
2. **命令行只能起 web 档案**：`desktop` 被 DSH **独占给 Electron**，任何 CLI 都起不来。
   这条把"单入口"的适用范围钉死了：
   - **web 档案**：`legion-start` 能接线、能拉宿主、能判就绪（CLI 单入口成立）；
   - **desktop 档案**：自动启动**只能**由 DSH Desktop 触发 —— 而它**确实触发了**
     （`.legion-services.log` 2026-10-03T03:32:54Z 的挂载与启停记录、守护心跳至今在走）。
   所以"两个档案都随宿主自动起"这句话，准确的形态是：
   **desktop 靠 Desktop 自己起、web 可以靠 CLI 起**；`legion-start` 因此对 desktop
   只做只读体检（`--check` 照常、不带 `--check` 直接 exit 7 并说明两条路），不再让人白等一次超时。


## 4. 判据（什么叫"单入口成了"）

一条命令，从**没有任何 Legion 进程**的状态开始，在 60 秒内达到：

| 检查 | 判据 |
| --- | --- |
| 数据面 | `GET :8787/api/config` → 200 |
| 指挥面 | `GET :5173/` → 200 且 `GET :5173/hub/api/config` → 200（中枢可达） |
| 执行面 | `scrum/daemon.json` 的 `mtime` 在窗口内前进 ≥1 次（守护真的在扫单） |
| 幂等 | 再跑一次不产生第二个宿主/第二个 8787 监听 |
| 退出 | 停掉入口后 8787/5173 都被回收（不留孤儿） |

这张表就是验收标准；**"服务起来了"不算"军团起来了"**——守护不在扫单的军团，
与一个没有军团的看板，在指挥台上长得一模一样。
