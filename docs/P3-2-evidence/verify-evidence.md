<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **P3-2 入库时** 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/CONFIG.md](../CONFIG.md)（统一配置参考）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P3-2 统一配置系统 · 验证证据

**切片**：P3-2 统一配置系统（统一 schema 与优先级 · 启动脱敏摘要 · 统一 token/host/port/DB 路径/附件目录 · 配置校验命令）
**日期**：2026-09-10
**代码位置**：`packages/shared/src/config.mjs`（引擎）、`scripts/config/{scan,sync,check,cross-checks,config.test}.mjs`、
`scripts/config/fixtures/{good,bad}.env`、`team-hub/config-schema.mjs`、`workbench/scripts/config-schema.mjs`、
`whiteboard/apps/server/src/config-schema.mjs`（+ 同步副本 `whiteboard/packages/shared/src/config.mjs`）、
`team-hub/server.mjs`、`workbench/scripts/serve.mjs`、`whiteboard/apps/server/src/index.js`（入口接线）、
`scripts/ci/run-ci.mjs`（env 阶段配置自检 + test 阶段 config 套件）
**参考手册**：`docs/CONFIG.md`
**测试**：`scripts/config/config.test.mjs`（27 例）

---

## 1. 交付内容与验证方式

| 子项 | 实现 | 验证 |
| --- | --- | --- |
| ① 统一 schema 与优先级 | 引擎 `defineSchema/resolveConfig/coerce`；优先级 **CLI > env > 默认**；结果带 `sources`；三份 schema 共 54 字段（12/21/21） | 单测 8 例（优先级三级、空串视为未设置、五类型含 min/max/choices、coerce 边界、unknownEnv/foreignEnv、schema 自检、CLI 解析）；`scan --check` 三进程全绿 |
| ② 启动脱敏摘要 | 三进程监听前各打一行 `[config] …`；secret → `***(N 位)`；复合值走字段级 `redact` 钩子 | 真实启动冒烟 3/3（见 §3.1）；单测 2 例断言「摘要与 JSON 都不含明文」；**单测抓到真实泄漏**（`WHITEBOARD_ROOMS` 内嵌房间 token）后修复 |
| ③ 统一 token/host/port/DB 路径/附件目录 | 三进程入口核心项改走引擎；新增 `--port/--host/--token`；相对路径与「显式提供即原样使用」语义不变 | 真实启动冒烟（含 CLI 覆盖与临时库）；回归批次 418 例 + 白板 158 例无回归；「默认值漂移」单测直接比对三进程自身常量 |
| ④ 配置校验命令 | `check.mjs`（10 条跨进程规则 + 脱敏摘要 + `--json/--env-file/--isolated-env/--strict/--show-source`）；`scan.mjs --check`；`sync.mjs --check` | 夹具端到端：good PASS(strict)、bad FAIL 且错误码符合预期；`--json` 可解析且无明文；用法错误码 2；CI env 阶段三项接入 |

## 2. 关键设计决策与取舍

1. **不引入配置文件**（用户已确认的轻量路线）：env/CLI 仍是唯一注入面，运行时语义零变更。
   代价：无法「一份文件描述全部配置」；收益：活跃部署零迁移风险，且本次改动的可回归面最小。
2. **非法值报错退出，不静默回退**：`TEAM_HUB_PORT=abc` 会立刻 `exit 1` 并给出可执行的排查命令，
   而不是悄悄起在 8787。「服务起在意外端口」是比启动失败更贵的故障。
3. **脱敏放在引擎、不放调用方**：`sensitive` 与 `redact` 两类字段都经 `redactConfig`，
   摘要 / `--json` / 未来任何导出共用一条路径。**这是被单测逼出来的设计**——最初 `WHITEBOARD_ROOMS`
   被当普通字符串，`main:room-token:rw` 会整串进日志。
4. **schema 必须被机器校验，否则必然过期**：`scan.mjs --check` 把「代码里读了哪些 env」与
   「schema 里声明了哪些」强制对齐；`config.test.mjs` 的「默认值漂移」用例把 schema 的 `default`
   与三进程代码里的真实默认值比对（**通过 import 各进程自己的常量**，不读引擎输出，避免自我印证）。
5. **白板用同步副本**：白板 Docker 构建上下文是 `whiteboard/`（只 `COPY packages apps scripts`），
   无法 import 仓库根 `packages/shared`。为避免两份脱敏实现分叉，采用「单一实现 + 副本 + 逐字节校验」。
   这是**本仓库特有的折衷**，边界已写入 `docs/CONFIG.md` §8。

## 3. 复跑命令与实测输出

### 3.1 三进程真实启动（脱敏摘要 + CLI 覆盖）

```bash
# team-hub：临时库 + 非默认端口 + token
TEAM_HUB_DB=$TEMP/p32-hub.db TEAM_HUB_PORT=18787 TEAM_HUB_TOKEN='super-secret-hub-token-abc' node team-hub/server.mjs
# whiteboard：CLI 覆盖端口 + 内存库
WHITEBOARD_TOKEN='board-secret-xyz-1234' WB_IN_MEMORY=1 node whiteboard/apps/server/src/index.js --port 18080 --host 127.0.0.1
# workbench：CLI 覆盖端口 + 写 token
DSH_WORKBENCH_TOKEN='wb-secret-abc-999' node workbench/scripts/serve.mjs --port 18173
```

实测（原文照抄，仅截断长字段）：

```
[config] team-hub port=18787 host=127.0.0.1 token=***(26 位) dbFile=<TEMP>\p32-hub.db attachMaxBytes=10485760 …
[team-hub] v2 独立服务已启动：http://127.0.0.1:18787（db=<TEMP>\p32-hub.db，鉴权=on）

[config] whiteboard port=18080 host=127.0.0.1 token=***(21 位) ttlMs=10000 dbPath=apps/server/data/whiteboard.db … rooms=(空) controlOpen=false roomIdleMs=300000 maxRooms=50 … roomsDir=<…>\whiteboard\apps\server\data\rooms
[whiteboard] listening on http://127.0.0.1:18080 (rooms=:memory:, ttl=10000ms, maxConn=200)

[config] workbench port=18173 host=127.0.0.1 token=***(17 位) teamHubToken=(未设置) hubUpstream=http://127.0.0.1:8787 … staticRoot=<…>\workbench\dist
legion-workbench 已启动：http://127.0.0.1:18173（中枢默认 http://127.0.0.1:8787，可用 DSH_HUB_UPSTREAM 覆盖）
```

- **CLI 覆盖生效**：三进程摘要里的 port 均为命令行传入值（白板与 workbench 原本只支持 env）。
- **明文密钥零泄漏**：三次冒烟都对完整输出做了 `-match '<明文>'` 判定，结果均为 `False`；
  grep 全文也确认没有 `super-secret-hub-token-abc` / `board-secret-xyz-1234` / `wb-secret-abc-999`。
- **非法值不静默**：`TEAM_HUB_PORT=abc` → `[config] team-hub 配置错误：TEAM_HUB_PORT 必须是整数，实际 "abc"`
  并 `exit 1`（未启动监听）。

### 3.2 扫描器：找出「看不见的配置面」

```bash
node scripts/config/scan.mjs            # 人读清单（含疑似字面量与动态读取位置）
node scripts/config/scan.mjs --check    # 门禁用
```

实测（`--check` 结论行）：

```
scan: PASS（全部 env 读取点与疑似字面量均已处理；共 85 个疑似字面量）
```

三进程直接读取的 env 键各 12 个（team-hub 12 / workbench 12 / whiteboard 12，均为**直接** `process.env.X`），
但真正的配置面远不止这些——扫描器的第 ②③ 类识别补上了间接读取：

| 进程 | 直接读取看不到、但确实在生效的配置 |
| --- | --- |
| workbench | `DSH_WORKBENCH_CHUNK_SIZE`、`DSH_WORKBENCH_MAX_UPLOAD_TOTAL`、`DSH_WEB_CACHE_TTL_MS`、`DSH_WEB_CACHE_MAX`、`DSH_WEB_QUOTA_SPACE_RPM`、`DSH_WEB_QUOTA_CONCURRENCY`、`DSH_WEB_QUOTA_HOST_RPM`、`DSH_WEB_QUOTA_DAILY_BYTES`、`DSH_WEB_AUDIT_MAX_BYTES`（9 项，经 `envBytes(name, def)` 读取） |
| whiteboard | `WB_MAX_CONNECTIONS`、`WB_MAX_CONNECTIONS_PER_ROOM`、`WB_MAX_CONNECTIONS_PER_IP`、`WB_MAX_MESSAGE_BYTES`、`WB_MAX_OPS_PER_MESSAGE`、`WB_MESSAGE_RATE_PER_SEC`、`WB_MESSAGE_BURST`、`WB_RATE_STRIKES`（经 `limits.mjs` 的 `env[key]`）、`WB_ROOM_IDLE_MS`、`WB_MAX_ROOMS`（经 `rooms.mjs`） |

> 这正是「统一配置 schema」的价值所在：**在本次改动前，这些键既不在任何文档里，也没有任何地方能列出它们。**

### 3.3 校验命令与夹具

```bash
node scripts/config/check.mjs --env-file=scripts/config/fixtures/good.env --isolated-env --strict --quiet
# → config check: PASS（error 0，warning 0，strict）        exit=0

node scripts/config/check.mjs --env-file=scripts/config/fixtures/bad.env --isolated-env --quiet
# → config check: FAIL（error 5，warning 3）                exit=1
#   ✖ DSH_WORKBENCH_PORT 必须是整数，实际 "not-a-port"
#   ✖ WB_MAX_CONNECTIONS 必须是整数，实际 "abc"
#   ✖ [port_conflict] team-hub 与 workbench 监听同一端口 5173
#   ✖ [hub_upstream_port_mismatch] workbench 的 hub 上游端口 9999 与 team-hub 监听端口 5173 不一致
#   ✖ [exposed_without_token] whiteboard 监听地址 0.0.0.0 会对非本机暴露，但未配置 token
#   ⚠ [static_root_missing] workbench 静态产物目录不存在：workbench/dist-does-not-exist
#   ⚠ [db_inside_rooms_dir] 白板 DB_PATH（data/rooms/whiteboard.db）位于房间目录 WB_ROOMS_DIR（data/rooms）之内
#   ⚠ [workbench_token_unset] workbench 未配置 DSH_WORKBENCH_TOKEN…

# JSON 形态（供 CI/诊断消费）——确认无明文密钥、ok 标志正确
node scripts/config/check.mjs --env-file=scripts/config/fixtures/good.env --isolated-env --json
# → {"ok":true,…,"processes":{"team-hub":{…"values":{"token":"***(17 位)"…}}}}
#   脚本判定：JSON 可解析=True；含明文 secret=False
```

### 3.4 对**当前真实环境**跑一次（不带夹具）

```bash
node scripts/config/check.mjs
```

```
✖ [hub_upstream_port_mismatch] workbench 的 hub 上游端口 8787 与 team-hub 监听端口 3080 不一致（/hub/* 代理会连不上）
⚠ [static_root_missing] workbench 静态产物目录不存在：workbench/dist（浏览器访问 / 会 404，API 仍可用）
⚠ [workbench_token_unset] workbench 未配置 DSH_WORKBENCH_TOKEN：文件写/删除等写操作将拒绝（预期用于只读部署）
⚠ 环境变量 DSH_WEB_URL 前缀属于本进程但未在 schema 中声明 →（已按 foreignEnv 登记后消除误报）
config check: FAIL（error 1，warning 3）
```

三条都是**真实信号**，不是误报：本会话环境里 `TEAM_HUB_PORT=3080`（宿主设置）与 workbench 默认上游 8787
确实不一致；`workbench/dist` 在本工作树中确实未构建；`DSH_WEB_URL` 是 DSH 宿主自用变量、
与 workbench 的 `DSH_WEB_*` 前缀撞名（已登记为 `foreignEnv`，不再误报为拼写错误）。
这也说明**门禁不能直接用这一条**——CI 里跑的是 `--isolated-env` 夹具版本。

### 3.5 门禁与回归

```bash
# 配置自检（CI env 阶段新增）
node scripts/config/scan.mjs --check          # PASS
node scripts/config/sync.mjs --check          # PASS（白板副本与根引擎逐字节一致）
node scripts/config/check.mjs --env-file=scripts/config/fixtures/good.env --isolated-env --strict --quiet   # PASS

# 新增套件
node --test scripts/config/config.test.mjs    # 27 例全通过

# 白板全量
cd whiteboard && npm test                     # 158 例 / 30 套件全通过

# 受影响面回归（team-hub 15 套件 + workbench 14 套件 + artifact-policy + config，一次 node --test）
# → tests 418 / suites 131 / pass 418（见下方说明）
```

回归说明（避免夸大）：首次运行该批次时 `workbench/scripts/doc-render.test.mjs` 失败，
原因是**新工作树没有 `workbench/node_modules`**（报 `Cannot find package 'react-dom'`），
与本切片改动无关；为工作树接上依赖后该文件 11/11 通过，批次结论为 418/418 全绿。

## 4. 遇到的问题与修复

| # | 问题 | 处理 |
| --- | --- | --- |
| 1 | 扫描器首版只认 `process.env.X`，三进程「恰好」各 12 个键——**可疑的整齐**正是漏检信号 | 增加两类识别：② `env.NAME` / `env['NAME']`（含 `options.env.NAME`）③ 疑似 env 形态的大写字面量；结果立即暴露 10 个 workbench 间接键与白板 9 个 `WB_*` 键 |
| 2 | 字面量启发式把 `COMMIT`/`DELETE`/`SIGINT`/`ENOENT` 等键名列成候选 | 每份 schema 提供 `nonEnvLiterals` 显式排除（附理由）；同时把「本 schema 声明的 env 前缀」视为已处理，消掉 8 条前缀字符串误报 |
| 3 | 白板副本与根实现「同步后立刻不一致」 | 头部剥离逻辑改为**按固定 4 行精确剥离**（原实现会把根文件自身的顶部注释一起吃掉）；写入路径不再读旧副本 |
| 4 | 白板 schema 的 import 路径少一层目录（`../packages` → `apps/server/packages`） | 改为 `../../../packages/shared/src/config.mjs`（与同目录 `room.mjs` 的先例一致） |
| 5 | **真实泄漏**：`WHITEBOARD_ROOMS` 内嵌每房间 token，被当普通字符串打印 | 引擎新增字段级 `redact` 钩子；白板 `rooms` 字段用 `maskRoomTokens` → `main:***:rw`（保留房间与角色，隐去 token）；单测覆盖 |
| 6 | **认知偏差**：schema 把 workbench 审计轮转默认值写成 4MiB | 「默认值漂移」单测抓出真实值为 5MiB（`WEB_AUDIT.DEFAULT_MAX_BYTES`），已改为与代码一致 |
| 7 | `static_root_missing` 规则在**未显式配置**时静默跳过——而产物缺失最常见于默认配置 | 规则改为「未配置时按内置默认 `workbench/dist` 检查」 |
| 8 | `unknownEnv` 把 DSH 宿主的 `DSH_WEB_URL` 报成拼写错误 | schema 新增 `foreignEnv`（登记「前缀撞名的外部变量」+ 归属 + 理由） |
| 9 | `parseArgv` 对「裸开关 + 位置参数」的语义不明 | 明确为「后跟非 `--` token 时视作取值」，与仓库既有 `workbench/scripts/serve.mjs` 解析约定一致，并写入引擎注释 |
| 10 | `.env` 里同一个键写两次会被静默取末值 | `parseEnvFileDetailed` 报出 `duplicates` / 无法解析的 `invalid` 行，`check.mjs` 计入 warning |
| 11 | 单测自身两处错误（`parseArgv` 期望与仓库约定不符；`exposed_without_token` 忘了夹具里已配 token） | 修正测试并在用例名/注释里写明判定依据 |
| 12 | 我第一版 PowerShell 汇总脚本用 `node --test <file>` 提取计数，首套件之后的数字全是假的（复用上一个值） | 改为单次 `node --test` 跑完整集合 + 末尾汇总，用 `Node` 自己输出的 `tests/pass/fail` 计数 |
| 13 | 核对 `README.md` §9.2 时发现**既有文档漂移**（非本切片引入）：`CHAT_DAEMON_ONLINE_MS` 被列为可配 env，实际是 team-hub 的**代码常量**（`server.mjs` 导出，不读 env）；`CHAT_CTX_BUDGET_CHARS` 被列在服务端项里，实际由**插件**读取（且两处默认值不同） | 修正 README 该表（标注「代码常量，env 不可配」与「读 env 的是插件」），并交叉引用 `docs/review/T-124-REVIEW.md`；**未改插件代码、未把插件纳入 schema**（超出本切片范围，留给后续切片决策） |

## 5. 已知边界（诚实登记）

1. **只覆盖活跃三进程**：`scrum` 已退役（无 schema 覆盖），两个 DSH 插件（`board-plugin` /
   `services-plugin`）的配置仍由宿主 composition 管理，不在本体系内。
2. **不支持热更新**：配置在启动时解析一次；改配置需重启进程（与改动前一致）。
3. **`check.mjs` 不发网络请求**：只做配置面一致性；上游 hub 是否真的在监听、`DB_PATH` 是否可写、
   附件目录是否有权限，只有真跑起来才知道。这是刻意的取舍——校验命令要能在离线环境秒级运行。
4. **token 一致性规则在单份环境里不可触发**：team-hub 与 workbench 读的是同一个 `TEAM_HUB_TOKEN`，
   只有分别在不同 shell 配置启动时才可能不一致；该规则由**构造两份配置**的单测覆盖（见 §3.3 与用例名）。
5. **`check.mjs` 默认读当前 shell 环境**：在 DSH 会话内直接跑会把宿主的 `TEAM_HUB_PORT` / `DSH_WEB_URL`
   算进来，出现「真实但与本机会话相关」的结论；门禁与复核都用 `--isolated-env`。
6. **白板副本是折衷**：若白板 Docker 上下文改为仓库根、或白板拆为独立仓库，应改为直接引用/发包，
   并删除 `whiteboard/packages/shared/src/config.mjs` 与 `scripts/config/sync.mjs`。
7. **schema 只保证「已声明」，不保证「语义正确」**：类型/范围能自动校验，
   但「默认值业务上是否合理」（如限流阈值是否合适）仍靠人工评审与压测。
8. **`config.test.mjs` 的漂移用例依赖可导入的进程模块**：team-hub 用例用临时库导入 `server.mjs`，
   workbench 用例导入 `serve.mjs`（需要 `workbench/node_modules` 存在，否则该文件会因缺依赖而失败——
   白板用例无此依赖）。
9. **插件配置面未统一**：`plugins/`（守护）读取 `CHAT_CTX_BUDGET_CHARS`、`CHAT_CTX_FILE_CAP_CHARS`
   等变量，且存在**同一变量两处默认值不同**的既有问题（`docs/review/T-124-REVIEW.md` S4）。
   P3-2 按决策**不改插件**，仅在 `README.md` §9.2 标注事实并交叉引用该审查记录；
   纳入统一配置需要单独切片（插件不在三个活跃进程内）。
10. **`CHAT_DAEMON_ONLINE_MS` 不是配置项**：它是 team-hub 的代码常量（不读 env），因此
    **不应**出现在任何 schema 中——schema 只声明「真正从环境读取的键」。README 原描述已修正。

## 6. 环境陷阱（复跑时容易踩）

- **在 DSH 会话内直接跑 `check.mjs`** 会读到宿主注入的 `TEAM_HUB_PORT=3080` 与 `DSH_WEB_URL`，
  出现与会话相关的 FAIL；复跑请加 `--isolated-env`（或先清理这两个变量）。
- **新工作树没有 `workbench/node_modules`**：`doc-render` 等前端相关套件会报 `Cannot find package 'react-dom'`，
  需先接上依赖/做 junction；这不是代码缺陷。
- **Windows 控制台中文乱码**：`node` 输出里的中文在 PowerShell 直读时可能显示为乱码
  （`***(26 浣?`），文件内容本身正常，判定请用「不含明文」这类布尔断言而非目视比对。
- **`git commit -F` 的临时文件不要放 `.git/`**：worktree 里 `.git` 是**文件**不是目录，
  `Set-Content .git/msg.txt` 会失败；且该仓库纪律要求不用 PowerShell 写源码/文档文件。
- **回归批次需排除 `notify-hub-smoke.test.mjs`**：该用例在 main 上会永久挂起（既有问题，非本切片引入，
  只做只读诊断、未修复）。
