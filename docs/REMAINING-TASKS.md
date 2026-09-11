# Legion 剩余待办清单

> 更新时间：2026-09-10
> 当前基线：`main`（P0 hardening 已合入）
> **状态：本清单已清空** —— P1-1～P3-3 共 14 项全部完成（最后一项 P3-2 于 2026-09-10 合入 main）。
> 清单外的候选 #1（CI `test` 阶段挂起）已于 2026-09-10 修复，证据 `docs/CI-TEST-STAGE-evidence/verify-evidence.md`；
> 候选 #2（`dual-write` 偶发失败）已于 2026-09-10 定性并修复，证据 `docs/DUAL-WRITE-RACE-evidence/verify-evidence.md`；
> 候选 #4（插件配置面未统一）已于 2026-09-10 修复（**P3-4**），证据 `docs/P3-4-evidence/verify-evidence.md`；
> 候选 #6（前端无浏览器自动化）已于 2026-09-10 补齐（**P4-1**），证据 `docs/P4-1-evidence/verify-evidence.md`；
> 候选 #9（宿主插件导入失败诊断）已于 2026-09-10 修复（**P4-2**），证据 `docs/P4-2-evidence/verify-evidence.md`。
> 全量基线：**39 套件 / 981 用例，`run-ci --only test` PASS**（以 `docs/STATUS.md` 记录的数字为准）。

本文记录当前尚未完成的产品、架构和发布工作。已完成的安全加固、CI 扩展、artifact 路径安全、插件 token 传播和白板 WebSocket 鉴权不在本文重复列出。

## 清单清空后的「已知待办候选」

以下条目**不是**清单内的正式任务，而是各切片在证据文档里如实登记的边界，按「对当前可用性的实际影响」排序，供下一轮选做：

1. ~~**CI `test` 阶段无法整体跑完**~~ → **已于 2026-09-10 修复**（根因：`notify-hub-smoke` 的 `setup()`
   先起服务、后导入被测模块，导入因 `api.ts` 相对导入缺 `.ts` 扩展名抛错 → 调用方拿不到 ctx →
   hub 子进程泄漏 → 测试进程不退出、`node --test` 永不输出该文件结果。修复过程中全量运行又暴露并修掉
   三处连带问题：P3-2 端口校验误拒 `0`、配置非法时 import 期 `process.exit` 会杀宿主/测试进程、
   CI 从未构建 `team-hub/lib` 导致 p13 只能靠残留产物通过）。**证据**：`docs/CI-TEST-STAGE-evidence/verify-evidence.md`。
2. ~~**`dual-write` 有一次未定性的偶发失败**~~ → **已于 2026-09-10 定性并修复**：不是 `audit.seq` 撞号，
   而是**启动期并发**的两个真实缺陷 —— ① 迁移竞态（两进程同时打开新库，各自读到「列不存在」并都执行
   `ALTER TABLE` → 后到者 `duplicate column name` 崩溃）；② `PRAGMA journal_mode = WAL` **不受
   `busy_timeout` 约束**（实测另一连接持锁时 106ms 内即抛 `database is locked`），而新库首次启动必经此步。
   两者都让后到进程在模块加载期退出；宿主侧因外壳有 `.catch` 不会崩，而是 `/team-hub` 路由缺失直到重启。
   **修复**：启动期迁移统一走 `ensureColumn`（`BEGIN IMMEDIATE` 内重读列名）+ 破坏性 goal 重建入事务 +
   WAL 切换自带 ~6s 有界重试；新增两个回归锚点（双进程同时启动迁移同一新库 / 同时升级旧形状 goal 表）。
   **证据**：`docs/DUAL-WRITE-RACE-evidence/verify-evidence.md`。同时定量澄清：`busy_timeout` 对
   **普通写事务确实生效**（实测按预算等待 2066ms 后成功），所以 P1-1 的 audit.seq 设计是成立的。
3. **`notify` 套件曾超时一次、未复现**（2026-09-10 全量运行中 1 次）：被套件级 300s 超时杀掉，
   落盘日志显示 hub-smoke 的 2 个用例都已通过（391ms / 5068ms）、此后无任何输出；而单跑（含 `CI=true`）
   19s 自行退出、15/15 通过。`node --test` 的逐文件输出语义与该现象相矛盾（说明是**另一个文件**没退出，
   但它只有纯函数用例、无子进程无定时器），故**未得出机制级结论**。缓解已到位：套件级超时（连后代进程
   一起清理）+ 超时现场快照 + 失败套件原始输出落盘（`.ci/<run>/suites/<套件>.log`）——**再出现时先看现场快照**。
4. ~~**插件配置面未统一**~~ → **已于 2026-09-10 修复（P3-4）**：`plugins/` 的提示词预算
   （`CHAT_CTX_*` / `NORMS_*`）纳入统一配置体系，`spaceDigest`（默认 4000）与 `chatResponder`（默认 8000）
   **同一变量两种语义**的问题被收口——总预算仍是 `CHAT_CTX_BUDGET_CHARS`（8000），摘要子预算改用独立变量
   `CHAT_CTX_DIGEST_BUDGET_CHARS`（4000）；同时修掉 `chatContext.ts` 硬编码 `4000` 绕过 env 的那处
   （该路径下 `CHAT_CTX_*` 曾完全不起作用）。`board-plugin` / `services-plugin` 的环境读取面也一并纳入 schema 与
   跨进程校验（含「services-plugin 会覆盖子进程端口」这条只有把两边摆在一起才看得出的规则）。
   **证据**：`docs/P3-4-evidence/verify-evidence.md`；手册：`docs/CONFIG.md` §3.4–3.6。
5. **白板多实例共享存储未实现**（P3-1 已登记）：当前是单实例多房间；ADR-0008 记录了被否方案与
   「转 v2」的触发条件（真正需要横向扩展时再启动）。
6. ~~**前端仍无浏览器自动化**~~ → **已于 2026-09-10 补齐（P4-1）**：新增零依赖 CDP 基座
   `scripts/e2e/cdp.mjs`（真实 Chrome/Edge + 真实鼠标事件 + canvas 像素 + 页面异常收集），
   并以 `tests/browser/whiteboard-ui.e2e.test.mjs` **7 例**把 P3-1 登记为「只能人工走查」的白板前端行为
   变成可复跑断言：进入房间的房间标签/标题/角色同步、真实绘制 → 服务端落库 + canvas 真的出像素、
   只读房间的 UI 降级（工具禁用 + 强行绘制零写入）、切换房间与 URL/token 语义、非法房间号提示、
   主路径无页面异常、限流下的可读提示与部分丢弃。已接入 `run-ci` 的 `test` 阶段（套件名 `e2e-browser`），
   无浏览器环境下整组 SKIP（不伪绿）。**证据**：`docs/P4-1-evidence/verify-evidence.md`；手册：`docs/E2E.md`。
   **仍未覆盖**：workbench 与 board-plugin 前端、视觉回归、多浏览器矩阵、网络故障注入（见 `docs/E2E.md` §6）。
7. **指标与审计为进程内**（P3-1 边界）：重启归零、无长期归档；`/api/rooms/<id>/audit` 只返回当前进程事件。
8. **`serve.mjs` 对未知资源路径仍回退 SPA 200 HTML**（`docs/STATUS.md` 限制 #12）：既是 SPA 需要，
   也让「资源不存在」的探测更费解，属于可继续收敛的小项。
9. ~~**宿主插件导入失败的诊断可读性**~~ → **已于 2026-09-10 修复（P4-2）**：新增诊断层
   `tests/p13-fixture/host-diagnostics.mjs`——把「哪个插件条目 / 哪个入口文件 / 原始错误 / 该怎么修」
   直接从宿主输出与**组合行真值**（fixture 刚写下的 `cordis.patch.yml`）里解析出来：
   启动前预检（入口产物缺失即点名 + 构建命令）、启动期装载失败（按装载器点名的 **组合行 id** 精确反查）、
   裸 `Cannot find module/package` 反查条目、`pending` 服务、路由 404 归因（`routeMissDetail`）。
   `waitReady` 失败不再抛「host not ready within Nms」：进程一退出（并等 stdio 排空）即抛
   `HostBootError`（可读文本 + 结构化 `diagnosis`）。**验证方式**：负向夹具在真实宿主上复现
   「导入期抛错」与「入口产物缺失」两种失败各一例，断言诊断点名到条目且 <30s 出结论；
   另有「健康宿主零误报」对照（防诊断变噪音源）、「不制造噪音」回归（已归因的 code 碎片不重复报）
   与 25 例纯函数单测。实测现场读数：进程已退出场景 **7ms** 给出结论（旧行为=等满 60s 报「未就绪」）。
   套件 `p13-host-injection` 由 9 → **14 例**（+**25 例**同组纯函数）；**证据**：
   `docs/P4-2-evidence/verify-evidence.md`。
   **未覆盖（诚实登记）**：pending 的日志形状取自 harness 源码、未在真实宿主复现；裸包名条目不判存在性；
   日志匹配仍是字符串规则（harness 文案变更会失效）。
10. **白板「重连窗口内的绘制会被静默丢弃」**（P4-1 浏览器 E2E 发现，尚未修）：切换房间/断线重连时，
    `main.mjs` 的 `send()` 只在 `ws.readyState === OPEN` 时发送，其余情况**静默 return**——
   即连接尚未建立的这段时间里用户画的东西会无声消失（既无提示也不入队列）。
    复现：`?room=main` → 点「切换」到新房间 → 在新连接就绪前立刻拖拽，元素不会出现在任何房间。
    方向（择一）：把未发送的操作**入队**并在 welcome 后补发，或至少像只读态那样**给出可见提示**。
    现有 E2E 通过等服务端报「房间已打开」规避了这条竞态（`waitRoomOpen`），因此不会误判为产品缺陷。

## 状态说明

- **可独立实施**：不依赖 DSH 宿主，可在本仓库完成并自动验证。
- **宿主依赖**：需要真实 DSH checkout、宿主进程或插件注入环境。
- **架构决策**：实现前需要确认唯一数据源或兼容策略。
- **暂缓**：价值明确，但当前优先级低于核心稳定性工作。

## P1：架构与发布可靠性

### P1-1 team-hub 两套服务实现合并

状态：**已完成**（第 1 步代码收敛 + 第 2 步 board hub v2 化 / v1 退役 / 现场切换验收 **13/13 全 PASS**） —— 决策 `docs/P1-1-DECISION.md`；evidence `docs/P1-1-evidence/verify-evidence.md`（第 1 步）、`docs/P1-1-evidence/step2-code-evidence.md`（第 2 步，含四轮现场根因表）；runbook `docs/P1-1-step2-runbook.md`（§0b 部署链 junction 检查）

问题：

- `team-hub/server.mjs` 是完整 v2 独立服务，负责任务、空间、目标、聊天、日历、规范、技能、附件、审计和 SSE。
- `team-hub/src/index.ts` 是 DSH 宿主插件适配器，仍保留一套基于 `taskctl.mjs` 的旧任务 API 实现。
- 两套实现的数据来源、配置入口、鉴权和接口覆盖范围不同，后续容易出现修一处、漏一处的行为漂移。

涉及改动（第 1 步已实施；第 2 步已合入代码，待现场执行）：

第 1 步（`d47c6f5` 之后）：
1. ✅ 以 `server.mjs` 作为唯一业务实现（决策 D1=选项 A：v2 唯一权威）。
2. ✅ `server.mjs` 导出可复用 `handle(req, res, stripPrefix?)` + `disposeHub()` + `DEFAULT_DB_FILE`；`handle` 支持可选前缀剥离。
3. ✅ `src/index.ts` 只做 DSH `webServer` 前缀路由注册 + env 配置转接，删除 taskctl 子进程旧实现。
4. ✅ 统一数据池：宿主外壳缺省与 8787 同 `team-hub/team.db`。
5. ✅ 删除重复 taskctl 业务逻辑（442 行 → 外壳 ~90 行）。
6. ✅ 新增 `tests/contract/team-hub-parity.test.mjs` 双形态对拍。

第 2 步（代码就绪，现场切换 = 重启宿主 + 归档 + probe）：
7. ✅ board-plugin hub 模式 v2 化（`board-plugin/src/index.ts` + 新 `hub-panels.ts`）：hub 写后不再渲染本地 v1、`/api/board/events` SSE 桥接上游 v2 `/api/events`（事件泵）、`/api/activity(+/events)` 转发 v2 audit、hub 面板 = v2 动态页（自渲染 + SSE 刷新 + transition/comment）、`reject/promote` → 501 降级指引（D3：v1 worktree 语义退役）。本地模式（无 hub 自托管）原样保留。
8. ✅ services-plugin 退役 `serve.mjs :4820` 托管行（v1 看板不再自动拉起；serve.mjs 文件保留供测试/本地）。
9. ✅ `scripts/ci/archive-v1-scrum.mjs` v1 文件库归档脚本（前置检查：4820 关闭 + 无近期写者）。
10. ✅ `scripts/live/p11-step2-verify.mjs` 现场验收 probe + `docs/P1-1-step2-runbook.md`（回滚预案）。
11. ✅ 测试扩展：board-plugin http-contract 37 项（+5：hub 面板/501/activity 转发/SSE 桥×2）；P1-3 fixture 增 `p13-board-hub` hub 模式实例 → 6/6（含同宿主 v2 全链路）。

验收标准：

- ✅ 独立服务和 DSH 宿主对同一请求返回相同状态码、字段和错误语义（parity 对拍）。
- ✅ v2 API 在宿主模式可用（team-hub 全组 138/138）。
- ✅ 不再存在第二套任务状态机和鉴权实现。
- ✅（第 2 步现场，2026-09-09）宿主 `/team-hub` = v2 外壳（config 含 `db=team-hub/team.db`）；board 面板 = v2 动态页、`/api/board` = v2 裸数组且与 8787 直连**同池**；`:4820` 无监听 + `scrum/tasks.json` 已归档；写冒烟 create 200；reject → 501。`p11-step2-verify.mjs` **13/13 PASS**，SSE 桥端到端实测 PASS。

风险：~~现场切换由用户执行~~ → 已完成（四轮重启逐次暴露并修掉：陈旧副本非 junction、detectHub 单次探测竞态、audit.seq 双进程撞号）。回滚预案见 runbook §4。**遗留提醒**：若 profile 重装使 `@dsh-external` 副本回归，需重查 junction（runbook §0b）。

### P1-2 board-plugin 宿主 HTTP 契约测试

状态：**已完成**（2026-09-09，随 board-plugin 宿主 HTTP 契约套件合入）

已完成内容：

- 新增 `board-plugin/tests/http-contract.test.mjs`：构造最小 fake `webServer` context，注入编译后的
  board-plugin（`lib/index.js`）并启动临时 HTTP 服务；写入隔离的 `tasks.json`、`activity.jsonl`、
  `board.json`、`daemon.json`、`roles.json` 与 artifact fixture（`tests/fixtures/`，含 taskctl/render
  替身、kanban/console 页面、roles 映射）。
- 覆盖 32 项：`/api/artifact` 逐条（raw/content-type/越界 400/未知任务 404/越权 `../` 根外盘符 `.git`
  403/符号链接 link-out 逃逸 403 + link-in 放行/缺失 404/octet-stream）、`/api/board`、
  `/api/activity`（limit）、`/api/config`、`/api/daemon`、`/api/patch`、kanban/console 前缀重写、
  本地写接口（create/transition 乐观锁 409/comment/reject/promote）、SSE 初始 + 增量，以及 hub 模式
  （fake team-hub）scope/token/错误映射（乐观锁 409、业务 400、非 JSON 500 文案）。
- 产物 API 断言与 `scrum/artifact-detail.test.mjs`（K4-B/K5-A）同一语义组。
- 顺带修复 board-plugin 相对产物路径白名单回退缺陷（`src/index.ts`：候选路径存在但 realpath 复检不通过
  —— 仓库内 junction 指向根外 —— 不再回退到该可穿透路径，整体 403）。
- 接入发布门禁：`scripts/ci/run-ci.mjs` test 阶段在配置 `DSH_CHECKOUT` 时构建 board-plugin 并跑该套件
  （镜像 plugins 先例；无 checkout 时 SKIP 不伪造通过）。

验收标准核对：

- board-plugin 独立测试可在无完整 DSH GUI 的情况下运行：✅ `node --test board-plugin/tests/http-contract.test.mjs`（32/32）。
- 与 `scrum/artifact-detail.test.mjs` 使用同一组语义断言：✅。
- 真实宿主注入测试另行保留，不用 mock 结果冒充宿主验证：✅（注入冒烟仍列 P1-3，本套件仅用 fixture 替身覆盖 HTTP 契约面）。

### P1-3 DSH 宿主真实插件注入冒烟

状态：**已完成**（2026-09-09，证据见 `docs/P1-3-evidence/verify-evidence.md`）

问题：

- 当前已验证插件可编译、纯函数测试和部分静态契约。
- 尚未在真实 DSH 宿主验证 `inject` 生命周期、`webServer.register`、route prefix、插件加载和前端面板注入。

涉及改动：

- 启动真实 DSH 宿主 fixture（隔离 `$DSH_HOME` + 自定义 profile + dsh-base bundle，真实
  `apps/cli/lib/bin.js`；不触碰生产 3080 宿主/配置与真实任务库）。✅
- 加载 team-hub、board-plugin、plugins（profile patch insert + node_modules junction，同生产形态）。✅
- 验证 `/api/config`、`/api/board`、`/api/artifact`、SSE 和 token 矩阵。✅
- 验证宿主关闭时 watcher、SSE、定时器和数据库连接正确清理。✅

验收标准：

- 真实宿主启动、访问、关闭全流程无异常：✅（5 用例全绿，含 `ctx.appExit` bounded 优雅退出）。
- token、scope、路由前缀和插件 UI 注入均通过：token/路由前缀/注入全过；
  插件 UI（board-plugin client 半 conversation.view iframe）需真实 GUI 面验证，
  登记边界（见 evidence「诚实边界」，P0 §3 dev_inject 曾覆盖注入链路）。

顺带修复（真实宿主注入才暴露的 board-plugin 缺陷，http-contract 32/32 回归仍绿）：

- 冷启动 mount 崩溃：`watch(board.json)` 文件未生成时 ENOENT → 改目录级 watch + filename 分派。
- detectHub 硬编码 `127.0.0.1:3080` → 改探测同宿主 `ctx.webServer.port` 的 /team-hub
  （隔离/异端口宿主部署不再错配到其他实例）。

门禁：`scripts/ci/run-ci.mjs` test 阶段新增 `p13-host-injection` 套件组（无 DSH_CHECKOUT 整组 SKIP）。

## P2：接口与数据一致性

### P2-1 v1/v2 任务状态、分页和 SSE 语义统一

状态：**已完成**（2026-09-09，随 v1v2 契约对比测试与文档基线合入）

问题：

- v1 使用 `tasks.json/activity.jsonl`，v2 使用 SQLite。
- 任务状态、分页字段、SSE 初始事件、activity 结构和错误码存在潜在差异。

已完成改动：

- **契约表入库**：`docs/CONTRACT-V1V2.md` —— v1/v2/board-plugin 三路只读盘点收敛为统一接口契约表
  （任务公共字段子集、写接口入参、错误分类矩阵、SSE 生命周期、登记差异 R1-R10），作为后续实现与
  测试断言锚点。
- **v1 低风险对齐**（`scrum/serve.mjs`）：
  - `/api/activity` limit 加 cap 500（对齐 v2 上限，消除「无上限全量读」分叉；缺省 50 不变，0/NaN 兜底）。
  - 未知路径/静态缺失 404 由 text/plain 统一为 JSON `{error}`（对齐 v2/board-plugin 错误响应形态）。
- **v2 事件信封统一**（`team-hub/server.mjs`）：新增 `auditEvent()`（audit 行 → 对外事件对象），
  REST `/api/activity` 与 SSE `/api/events` 共用——既有平铺字段（seq/ts/member/scope/action/taskId/
  goalId/detail）不变，补 `event`(=action)/`id`(=seq)/`payload`(=detail) 兼容信封字段。
- **SSE 协议改造**（P2-3，见下条目）：id: 行 + Last-Event-ID 增量回放。
- **共享 fixture 契约测试**：`tests/contract/v1v2-contract.test.mjs` —— 同一业务场景（create → comment →
  transition）分别打真实 v1（serve.mjs + 临时任务库 + taskctl/render 副本 fixture）与真实 v2
  （server.mjs + mkdtemp SQLite），断言：写响应壳 `{ok,task}`、22 个任务公共字段两端一致、错误分类
  矩阵（缺参 400/非法迁移 400/乐观锁 409/未知路径 404 JSON）、`/api/activity` limit 尾部语义、v1
  `/api/board`（渲染快照）与 v2 `/api/board`（任务裸数组）语义登记、v2 SSE 信封与 Last-Event-ID、
  v1 双流既有形态锁定。
- 门禁接线：`scripts/ci/run-ci.mjs` test 阶段新增 `v1v2-contract` 套件组。

验收标准核对：

- 同一业务场景 v1/v2 公共字段与错误分类一致：✅（写契约 describe 5 用例 + 错误矩阵）。
- 保留 v1 兼容字段、不再新增语义分叉：✅（v1 仅对齐 cap 与 404 形态，未动字段面；差异登记 R1-R10）。
- SSE 统一序号、heartbeat 与断线清理：✅（v2 /api/events id: 行 + Last-Event-ID + 既有 :hb/close 清理锁定；
  v1 无全局 seq 维持回放+指纹去重，契约登记 S3）。

范围说明：v1/v2 数据底座不同是架构事实（P1-1 另立）；P2-1 统一契约面（字段/错误/SSE 行为），不合并实现。

### P2-2 team-hub 读接口权限模型统一

状态：**已完成**（2026-09-09，随远程读面鉴权门禁合入）

问题与现状（改动前）：

- team-hub 的 token 只保护写接口（`handleWrite`/附件上传），约 30 个 GET/SSE 读端点
  （`/api/board`、`/api/activity`、`/api/events`、`/api/skills`、`/api/members`、`/api/roster`、
  `/api/chat/*` 等）在非回环监听时无需任何 token 即可读取任务/审计/技能/聊天元数据。

已完成改动：

- `team-hub/server.mjs`：
  - 导出 `isLoopbackHost` / `readAuthRequired`（纯函数决策）：非回环监听 + 已配 token → 读面必须鉴权；
    本地回环（127.0.0.1/localhost/::1）无论是否配 token 读面保持开放（开发体验不回退）。
  - `handle()` 顶部统一读面门禁：远程保护模式下除 `/api/config`（能力发现）与 OPTIONS 外，全部
    端点（读/SSE/写）都需 token；未知路径同受门禁（不泄露端点存在性）。
  - `authorized()` 支持三种携带方式（对齐 v1 serve.mjs）：`Authorization: Bearer` / `x-dsh-token` /
    `?token=`（后者供 EventSource 等无法自定 header 的读订阅）。
- 测试：`team-hub/security.test.mjs` 增加决策纯函数用例；新增 `team-hub/read-auth.test.mjs`
  （远程模式 HTTP 矩阵：无 token/错 token 401、三种携带方式 200、config 放行、SSE 401/`?token=` 200、
  写面 401、OPTIONS 204、未知路径 401/404）与 `team-hub/read-open-loopback.test.mjs`
  （回环 + 已配 token：读/SSE/config 无 token 仍 200，写面仍 401、带 token 可写——不回退锁定）。
- 消费方 token 头同步：
  - Workbench `api.ts`：新增 `hubGet`（hub GET 统一带 Bearer）与 `hubEventSourceUrl`（hub 审计 SSE
    以 `?token=` 追加）；~20 个 hub 读函数全部改走 `hubGet`，`subscribeHubAudit` 改走带 token URL；
    v1（apiBase）读面本就开放不动；CalendarView 自带 token 头不动。
  - board-plugin：hub GET/POST 早已带 Bearer（P1-2 契约套件已验证），无需改动。
  - scrum v1 `serve.mjs`：读面按既有契约开放（零 token 看板/console），写面 token 门禁不变，无需改动。
- 门禁接线：`scripts/ci/run-ci.mjs` test 阶段新增 `read-auth` 套件组
  （read-auth.test.mjs + read-open-loopback.test.mjs）。
- 顺带修复 `board-plugin/tests/http-contract.test.mjs` 清理抖动：Windows 含 junction 的临时目录
  快速递归删除偶发 EPERM 导致套件假红（5/6 复现）——改为先删 junction + 宽容重试、失败仅遗留可回收
  临时目录不抛（8/8 稳定 exit 0）。

验收标准核对：

- 非回环监听无 token 时拒绝启动（既有 `validateSecurityConfig`）+ 读面全门禁：✅（HTTP 矩阵验证）。
- 正确 token 可读、错误 token 401：✅（Bearer/x-dsh-token/?token= 三路验证）。
- 本地回环开发体验不回退：✅（回环 + token 场景锁定：读开放、写面仍门禁；team-hub 全组 137/137）。

范围说明：本项覆盖 team-hub v2 读面与 Workbench/board-plugin/scrum 消费方 token 头；scope/member
一致性过滤属既有实现（skills include=pending 收口等），不在本项新增。

### P2-3 SSE 生命周期和断线恢复统一

状态：**已完成**（2026-09-09，随 v2 /api/events 信封与 Last-Event-ID 合入）

问题：

- v1、v2、board-plugin 各自维护 SSE 客户端集合。
- 初始事件、增量事件、heartbeat、重连和重复事件处理方式不同。

已完成改动：

- **统一事件信封**（v2 /api/events + REST /api/activity 共用 `auditEvent()`）：data 帧在既有平铺字段
  （seq/ts/member/scope/action/taskId/goalId/detail）之上补 `event`(=action)/`id`(=seq)/`payload`
  (=detail) 兼容字段；SSE 帧加 `id: <seq>` 行（浏览器 EventSource 原生断点续传基础）。
- **Last-Event-ID 支持**（`team-hub/server.mjs` /api/events）：读 `Last-Event-ID` 头，合法序号 → 只回放
  `seq > N` 的增量（升序）；无/非法 → 回退最近 30 条升序回放（不报错）。
- **heartbeat/关闭清理**：15s `:hb` 注释帧 + close 时 clearInterval + Set 删除既有同构行为，契约测试锁定。
- **前端去重抽纯函数 + 单测**：`workbench/src/dedupe.ts`（`dedupeSeqDesc`/`mergeById`/
  `activityFingerprint`/`dedupeByFingerprint`），NotifyView/ChatView/App 改为复用；
  新增 `workbench/scripts/dedupe.test.mjs` 9 用例（docs/review/T-100-REVIEW.md O5 缺口收口）。
- **断线/乱序测试**：`tests/contract/v1v2-contract.test.mjs` SSE describe —— 连接回放升序、信封字段、
  Last-Event-ID 增量续传（seq=max+1 单条、无重复）、非法 Last-Event-ID 回退、15s 心跳实测、
  v1 双流既有形态锁定。
- 门禁接线：`scripts/ci/run-ci.mjs` test 阶段新增 `dedupe` 套件组。

验收标准核对：

- 统一事件字段 id/event/scope/seq/ts/payload：✅（v2 data 帧含全部 6 字段，payload 兼容 detail）。
- 支持 Last-Event-ID：✅（HTTP 级续传测试）。
- 统一 heartbeat、关闭清理和前端去重：✅（心跳/清理契约锁定；去重三口径统一纯函数 + 单测）。
- 断线重连和乱序事件测试：✅（Last-Event-ID 断线续传 + 去重函数乱序收敛）。

范围说明：v1 activity 事件无全局 seq（activity.jsonl 文件追加模型），Last-Event-ID 完整闭环在 v2/
board-plugin-hub 成立；v1 维持「连接回放 + 内容指纹去重」（App.tsx seenEvents），契约表 S3 登记；
board-plugin hub 模式 SSE 桥接（R9）属跨宿主改造，登记移交 P1-3/P1-1（真实宿主联调）一并验证。

## P2：Workbench 功能完善

### P2-4 通知中心增强

状态：**已完成**（2026-09-10）—— 统一模型与纯函数 `workbench/src/notify.ts`；面板 `NotifyView.tsx`；回归 `workbench/scripts/notify.test.mjs`（13）+ `notify-hub-smoke.test.mjs`（2，真实 hub/SSE）

当前已有 audit 派生通知、未读徽标和 scope 级已读游标。

已完成：

- ✅ **分类、优先级和来源统一**：`notifyCategory`（task/goal/space/model/skill，按动作前缀）、
  `notifyPriority`（high = 拦截/转派/测试报告/目标发布·收尾·取消 + transition 落到 blocked·in_review；
  low = 批注/目标上下文/模型清除/空间更新；其余 normal）、`source`（当前唯一 = hub-audit，预留扩展位）；
  文案表 `NOTIFY_ACTION_LABEL` 与白名单一同迁入 notify.ts（api.ts re-export 保持兼容）。
- ✅ **批量标记已读**：已读状态升级为「连续游标 + 显式 seq 集合」（新增键 `legion.notify.readseq.<scope>`，
  旧游标键继续生效），`applyMarkRead` 带压实（补满连续区间即推进游标并清理）；UI 支持行多选 +
  「标记选中已读」+「全部已读」+「仅未读」筛选 + 分类页签（含各类未读数）。
- ✅ **任务、目标、空间跳转协议统一**：`jumpOf` 产出 task/goal/space/model/skill/none，UI 只按 kind 分发；
  语义统一为**动作所属域优先**（目标类动作即使带 taskId 也跳目标面板，与分类一致——P2-4 前为 taskId 优先）。
- ✅ **SSE 实时去重和断线恢复**：seq 去重降序共用 `mergeNotifyItems`（回放/轮询/乱序同语义）；
  `shouldRefill` 基于**未过滤全量流的 seq 水位**判缺口（audit seq 全局单调，跳变即漏帧）；
  `subscribeHubAudit` 新增 `onStatus` 上报连接状态与打开次数 → 重连成功或检出缺口**立即重拉补齐**
  （不再等 15s 轮询），面板显示实时连接状态与补齐次数。
- 回归：`notify` 套件接入 run-ci（15 用例：13 纯函数 + 2 端到端）。端到端用真实 hub 进程 + 真实
  `/api/events` 验证：chat:* 过滤有效、transition→blocked 判 high、**已读操作期间服务端 audit 零新行**、
  kill 服务后同实例自动重连（opens≥2 → reconnected）并继续收帧。

### P2-5 日程日历增强

状态：**已完成**（2026-09-10）—— 数据面 `team-hub/server.mjs`（重复展开/更新/冲突/关联）；前端 `workbench/src/calendar.ts`（纯函数）+ `CalendarView.tsx`（月/周视图 + 编辑弹层）；回归 `team-hub/calendar.test.mjs`（29）+ `workbench/scripts/calendar-ui.test.mjs`（12）

当前已有 team-hub 日历数据面和 Workbench 面板。

**三项语义决策（用户拍板，2026-09-10）**：

1. **时间 = 字面本地时间（naive local）**：`start`/`end` 原样存储、原样返回、**不做任何时区换算**
   （既不转 UTC，也不套浏览器时区）；跨时区参与者需自行换算。依据：本地优先单机部署、
   全天 date-only 语义天然正确、零迁移（改动前生产 `calendar_events` 为 0 条）、无 DST 陷阱。
   代码中以 `Date.UTC` 仅作**单调比较/运算**，不表示该值被解释为 UTC 时刻。
2. **重复 = 简单规则**（不做完整 RRULE）：`{ freq: daily|weekly|monthly, interval, until|count, exdates }`，
   规则存列、**查询侧展开**为实例（不落多行）；删除支持「仅本次（写例外日）」与「整串」。
3. **关联 = 双向**：事件可带 `taskId`/`goalId`（入库列 + 索引），日程 → 任务详情（复用 TaskDetailModal），
   任务详情 → 「📅 关联日程」区块（新增反向端点）。

已完成：

- ✅ **事件与任务/目标关联**：`calendar_events` 新增 `taskId`/`goalId` 列（幂等 ALTER 补列 + 索引）；
  新增 `GET /api/calendar/events/by-link?taskId|goalId[&from&to]`（带窗展开实例、无窗每条一行）；
  前端编辑弹层可填任务号/目标号，条目显示 🔗 并点击直达；任务详情面板新增「关联日程」区块
  （`api.ts` 新增 `fetchHubCalendarByLink`，一年窗口内展开）。
- ✅ **编辑、删除、时区和时间区间完善**：
  · 新增 `POST /api/calendar/events/update`（**局部更新**：只改传入字段 + scope 归属校验 + audit `calendar:update`；
    start 单独变更时用既有 end 兜底校验，避免产生倒序区间）；
  · 删除升级为 `mode: series|occurrence`（仅本次 = 写 `exdates`；删到最后一个实例自动整串移除）；
  · 时间区间：表单新增**结束时间**与**全天**开关，条目悬停/弹层显示 `10:00–11:30` 区间；
  · 时区：按决策 1 明确文档化为字面本地时间（前端弹层显式提示，不再有隐含换算假设）。
- ✅ **明确是否支持重复事件**：按决策 2 **支持简单重复**——每天/每周/每月 + 间隔（1-99）+
  结束条件（日期或次数，二选一）+ 例外日；`expandCalendarDates` 负责窗内展开（monthly 始终以
  **原始 start 的日号**计算第 k 次，避免 1/31→2/28→3/28 的漂移；上限 `MAX_CALENDAR_INSTANCES=400` 防放大）。
- ✅ **冲突检测与更完整视图**：
  · 新增 `GET /api/calendar/conflicts?scope&start&end[&allDay&excludeId]`（左闭右开重叠判定，
    全天按整天、非全天缺省 1 小时；同事件可返回多个实例；**仅提示、不阻断写入**）；
    前端在编辑/新建弹层去抖 250ms 查询并以黄色提示块展示，保存仍可继续。
  · 视图：新增**周视图**（7 列、每列列出当天全部条目、支持左右翻周、双击/＋号在该日新建），
    与月视图一键切换；月视图保留 7×N 网格与「+N 更多」折叠。
- 回归：
  · `calendar`（后端契约，29 用例）：规则校验零副作用、daily/weekly/monthly 展开与 count/until 上界、
    monthly 日钳制、exdates 与单次删除、删到空整串移除、展开上限抛错、局部更新与越权/无字段/倒序校验、
    冲突判定（相邻不算、全天边界、excludeId、scope 隔离、不阻断写入）、by-link 正反查（无窗/带窗两种语义）、
    字面时间语义（含 `Z` 后缀原样保留）、旧契约兼容与补列幂等。
  · `calendar-ui`（前端纯函数，12 用例）：实例日归组、区间文本、周网格与标题（跨月/跨年）、
    重复文案、关联跳转（任务优先）、草稿生成/校验（含 2026-13-01 与 2026-02-30 真实存在性校验）、
    入参拼装、冲突提示文案。

**已知边界（诚实登记）**：重复规则不支持「单次修改」（改某一次会改整串规则）、不支持按星期几/
第几个工作日的复杂规则；`until`/`count` 二选一；字面时间语义下跨时区协作需人工换算。

**两处审计取舍（已固定为断言，见 notify.test.mjs）**：

- 「仅本次」删除记为 `calendar:update`（detail 带 `mode:'occurrence'` + `occurrenceDate`，并写 `exdates`），
  而非 `calendar:delete`——因为**数据事实是规则被更新、事件仍存在**；若记成 delete 会让消费方
  误判「该事件已被删除」。整串删除才是 `calendar:delete`。
- 日历动作（`calendar:create/update/delete`）**不入通知白名单**：日程多为自己创建/修改，
  进通知只产生自操作噪音；审计仍全量留痕，可在活动流查看。

### P2-6 对话中心真实闭环

状态：**已完成**（2026-09-10）—— evidence `docs/P2-6-evidence/verify-evidence.md`
探针 `scripts/live/p26-chat-e2e.mjs`（真实守护+真实模型）、`scripts/live/p26-chat-resilience.mjs`（续传/缺口/失败路径 23 检查）
回归 `workbench/scripts/chat-ui.test.mjs`（9）+ `plugins/tests/chat-context.test.mjs`（13）

当前已有会话、消息、awaiting/replied/failed、重试、附件和 scope 隔离。

**两项决策（用户拍板）**：真实模型 E2E 允许在生产 `software` 空间跑 1 条探针（留痕不删）；
UI 验证采用「纯函数抽取 + 单测」形态（不引入 jsdom/react 渲染设施）。

已完成：

- ✅ **真实 DSH 守护与模型通道 E2E**：真实探针跑通全闭环——生产 8787 `software` 空间发 1 条消息 →
  服务端标 `awaiting` 入队 → **真实守护进程**（`soldier-auto@software`）拉取 →
  `ctx.subagents.start` 起**真实模型子代理**（`custom-ds / deepseek-v4-flash-openai`）→
  结构化回写 → CAS 置 `replied` → **12s 内**收到 `author=software-assistant` 的真实回复，
  meta `{replyTo, aiModel}` 完整。全程无夹具、无桩模型。
- ✅ **awaiting → replied/failed 的前端合并和断线恢复**：
  · 合并：三态是**同一条源消息的 meta 更新**，只追加新 id 会让气泡永停「等待回复」——
    `chatUi.mergeChatMessages` 明确同 id 覆盖语义（委托 `dedupe.mergeById`，单一实现）并加回归锚点。
  · 断线恢复三层：`reconnected` 回调立即重拉（不等 15s 轮询）+ `shouldRefillChat` 以**全量事件流
    seq 水位**检出缺口即补齐（首帧建基线不误报）+ 顶栏 SSE 四态可视化（已连接/已重连第 N 次/
    重连中/已断开，断开仍可手动刷新）。
  · 真实链路已验证：带 `Last-Event-ID` 续传从 `watermark+1` 开始且 seq 连续；**不带**该头时服务端
    只回放**最近 30 条**（有界）——这正是缺口层必须存在的原因，两层叠加才是完整恢复语义。
- ✅ **模型不可用、超时、守护离线的完整 UI 验证**：判定逻辑抽到 `workbench/src/chatUi.ts` 并单测
  （9 用例）：端点缺失/加载中灰态**不误导**、最近失败红态给「重试」可行动指引、守护离线/模型未配置/
  开关关闭黄态各给修复动作（三项并列不互相掩盖）、全就绪绿态 + 诚实标注；发送侧 401/403 →
  未授权 + token 指引、网络类 → 中枢不可达，**均含「草稿已保留」**；AI 三态栏位文案全覆盖。
- ✅ **附件上下文生命周期和清理测试**：新增 `plugins/tests/chat-context.test.mjs`（13 用例；
  此前 `gatherChatContext` **零覆盖**）。A 组：摘要四态降级、非法引用过滤、hub 不可达/404/空内容
  均给 `readError` 且**绝不 throw**（否则上下文故障会误标源消息 failed）、请求四参契约。
  B 组（真实 hub）：staged→sent 流转 + 消息只存引用（反向断言正文不入 `messages` 表）、
  **staged 不可读（403）而绑定后可读**、跨会话/跨空间 403、缺 by 400、未知 id 404、
  TTL 到期**引用留存但内容不可读**（与 gatherChatContext 降级端到端接上）、历史消息不回填、
  重复/跨空间/超限引用被拒、孤儿 staged 按 TTL 清理。
- 过程中修掉 4 个真实缺陷：①「已回复 · 模型」永远显示不出模型（模型在**回复行** meta，
  须按 `replyMsg` 回查）；② 合并逻辑两份实现（改为委托）；③ 401/403 未识别为未授权；
  ④ 空列表时同批重复 id 未去重。

**已知边界（诚实登记）**：真实探针只跑 1 条消息（用户授权范围），未在生产人为制造 provider 超时/
守护离线（故障态由隔离实例与纯函数测试覆盖）；UI 验证是**判定层而非渲染层**（DOM 文案无自动断言）；
标签页被挂起时补齐会延后到唤醒；附件内容按 UTF-8 文本注入，二进制附件未支持；
生产探针会话保留不删（可复查）。

### P2-7 文件中心增强 ✅ 已完成（2026-09-10）

当前已有目录、读写、上传、重命名、删除、token 和路径安全。

四项全部落地（后端 serve.mjs `/api/files/*` + 前端 FilesView / filesUi.ts）：

- **批量操作和搜索**：`GET /api/files/search`（文件名大小写不敏感子串、`recursive` 递归、上限触顶
  返回 `truncated=true` 不静默丢结果）+ `POST /api/files/batch`（delete/move，**逐项报告成败**，
  单项失败不回滚其余项，上限 200 项/次）。前端多选 + 批量下载/移动/删除，命中高亮，移动目标先校验相对路径。
- **上传冲突策略**：`strategy=ask|overwrite|skip|rename`（服务端权威；`overwrite=1` 保留为兼容别名）。
  ask 为默认（409 → 前端询问后带明确策略重试）；skip 不落盘且**零副作用**；rename 自动加 `-1/-2`
  后缀并回传实际落盘名。未知策略一律 400（不静默降级）。前端记忆选择（localStorage 不可用时降级 ask）。
- **大文件分片与断点续传**：`POST /upload/init` + `PUT /upload/chunk` + `POST /upload/complete`
  + `DELETE /upload/abort`。会话状态**只落磁盘**（`.dsh-uploads/<id>.json` + `.part`），「已收字节」
  即 `.part` 长度 → 进程重启/刷新页面后仍可续传；offset 不匹配返回 409 并回传真实 `received`
  供前端校正（不重传已成功的片）；未收齐 complete 返回 400 且**保留会话**。前端 >8MB 自动走分片，
  带进度条、片数与取消。
- **git 状态/差异展示（只读）**：`GET /api/files/git/status|diff|log`。状态含分支、领先/落后、
  逐文件标记（区分暂存与工作区、R 带原路径、冲突 U）；diff 支持「工作区 vs 索引 / 已暂存 vs HEAD」
  两态，二进制与超长显式标注；另有最近提交列表。**不提供 stage/commit/checkout**——只读端点，
  并有「调用前后 `git status --porcelain` 逐字节一致 + 无 index.lock」的反向断言兜底。

- 修掉 3 个真实缺陷：① `gitDiff` 对**文件路径**执行 `git -C` 必然失败 → isRepo 误判 false
  （前端会因此隐藏整个 git 面板），改为按所在目录探测仓库根；② 对已删除文件抛 400 而非可读说明；
  ③ `.dsh-uploads` 会话目录可被文件中心浏览/删除 → 一次列表操作即可静默破坏断点续传，改为与
  `.git` 同级拒绝（403）。
- 测试：`workbench/scripts/files-p27.test.mjs` 36 例（后端契约，含 HTTP 真路由与 token 门禁）+
  `workbench/scripts/files-ui.test.mjs` 19 例（前端纯判定层），两套件均已注册到 `run-ci` 的 `test` 阶段
  （test 阶段套件数 29 → 31）；`files-api` 41 例不回归。
  **注意**：本轮**未能**跑完整 `test` 阶段获取全量基线——main 上 `notify-hub-smoke` 会让该阶段永久等待
  （非本切片引入：同套件在 `1203f52` 上 2/2 通过并退出，在 `fcbc1bd`/`3339642` 上零输出不结束）。
  只读诊断已定位根因：`workbench/src/api.ts` L2 `from './hubEventStream'` **缺 `.ts` 扩展名**
  （Node ESM 解析失败 → 两个测试在 `setup()` 抛错），叠加 `setup()` 先起 hub 子进程、后动态导入且失败路径
  不 kill 子进程 → 子进程泄漏使测试文件进程不退出，而 `node --test` 会缓冲该文件输出直到其退出。
  最小修法（一个 token）与加固建议见 `docs/P2-7-evidence/verify-evidence.md` §7。
- 证据：`docs/P2-7-evidence/verify-evidence.md`。

**已知边界（诚实登记）**：批量下载**逐个触发，不做 zip 打包**（避免自研 zip 写入器）；
分片为**顺序**上传（offset 必须等于已收字节），不做并发分片与逐片哈希校验（仅校总长度）；
「移动到」只支持已存在目录（沿用服务端 rename 语义）；搜索只匹配**文件名**（不做内容全文检索）；
git 面板只读，无暂存/提交能力；`.dsh-uploads` 会话由管理端按需清理（本期未做定时回收）。

### P2-8 浏览器助手增强 ✅ 已完成（2026-09-10）

当前已有 SSRF、私网、协议、重定向、超时和大小限制；四项全部落地（后端 `workbench/scripts/serve.mjs`
`/api/web/*` + `team-hub/server.mjs` 历史表 + 前端 `BrowserView` / `browserUi.ts`）：

- **空间级抓取历史与缓存**：team-hub 新增 `web_fetch_history` 表与 `POST/GET /api/web/history`、
  `POST /api/web/history/clear`（读支持关键字过滤与 stats 汇总；容量默认 200/空间，超出按最旧清理并回报 `trimmed`）。
  同 `(scope,url)` 只保留一行并累加 `hits`——逐次流水仍在 serve 侧 web 审计 JSONL，两者分工不重复。
  serve 侧缓存为**进程内 TTL + ETag/Last-Modified 条件请求**：新鲜命中不发网络请求；过期但存校验器则带
  `If-None-Match`/`If-Modified-Since` 重新验证，304 → 复用内容并刷新 TTL（`cached` + `revalidated`）；
  **截断结果不入缓存**（否则调大 `maxBytes` 后会一直拿到旧截断内容）；缓存键 = **空间 + URL + maxBytes**。
  抓取后 fire-and-forget 回写 hub（失败只 console，不影响抓取响应）。
- **更好的正文提取**：零依赖 Readability-lite——剔除 nav/aside/footer/header/form/dialog 与 class/id 命中样板词的容器；
  轻量标签栈扫描候选容器（`article`/`main`/`[role=main]` 与块级 `div`/`section`），按
  `文本长度×(1−2×链接密度) + 段落/标题加权 + 语义标签加成` 打分选块；结构化渲染（标题→`#`、列表→`-`、
  代码→围栏、引用→`>`、表格→`|`）；返回 `quality` 元数据（策略/得分/字数/标题数/段落数/列表项/链接密度/
  候选数/剔除块数/markdown/截断/短内容）。**短页面优先用显式语义容器**而非整页回退（避免把导航带进正文）。
  既有 `extractHtml` 契约不变（`web.test.mjs` 24 例不回归）。
- **可选截图能力**：**不引入** Playwright/Puppeteer；探测本机已装 Edge/Chrome 并以 `--headless=new --screenshot` 截图，
  需显式 `DSH_WEB_SHOT_ENABLE=1` 启用（**默认关闭**，因为会真实启动浏览器进程）；
  `DSH_WEB_SHOT_BROWSER` 显式指定时**互斥**（只认它）。截图同样过协议白名单与 SSRF 校验，
  落在 `workbench/data/shots/<scope>/`（**不在静态根 `dist/` 内**，避免被直接暴露且不被 `vite build` 清掉），
  读取端点仅回环、仅 `.png`、防目录穿越；未启用/未找到浏览器返回 409 与开启指引（不静默失败）。
- **更细的限流和配额**：空间级每分钟请求数（默认 30）、在途并发（默认 3）、每日字节配额（默认 200MB），
  另有目标站点级每分钟请求数（默认 30）；超限 → **HTTP 429 + Retry-After + `code`**
  （`rate_limited`/`concurrency_limited`/`daily_quota_exceeded`），界面按成因给可行动指引。
  **未标注 scope 的调用（脚本/自测/运维）不限流**——配额是按空间的界面治理手段，无空间调用只落审计。
  `GET /api/web/meta` 返回配额快照与截图能力状态，界面展示「本分钟剩余 / 进行中 / 今日已用」。
- 修掉 5 个真实缺陷：① 缓存键原不含空间 → 跨空间串内容且**绕过配额**；② `DSH_WEB_SHOT_BROWSER` 原是候选首项
  → 想验证「未找到浏览器」分支时会意外拉起真 Edge；③ 短页面误回退整页（把导航带进正文）；
  ④ 截图默认目录落在静态根 `dist/` 内；⑤ 后端未加载路由时前端把「能力未就绪」误报成「本空间还没有记录」。
- 测试：`workbench/scripts/web-p28.test.mjs` 21 例（抽取质量/缓存与 304/配额与 429/截图三态/历史降级）、
  `workbench/scripts/browser-ui.test.mjs` 21 例（前端纯判定层）、`team-hub/web-history.test.mjs` 1 例（20+ 断言），
  均注册到 `run-ci` 的 `test` 阶段（该阶段套件数 31 → 34）；`web.test.mjs` 24 例与 `files-api` 等既有套件不回归。
  另有跨进程端到端脚本 `docs/P2-8-evidence/e2e-history.mjs`（真拉起 team-hub 临时实例）17/17 通过。
  生产 :5173 已重建并验证（live `index-IsXYBz15.js` 与构建产物一致）。
- 证据：`docs/P2-8-evidence/verify-evidence.md`。

**已知边界（诚实登记）**：缓存在**进程内**（重启即失效；TTL 默认 5 分钟）；配额计数也在**进程内**
（重启清零，非持久账目）；截图是**尽力而为的本机浏览器截图**（不自带浏览器，未装 Edge/Chrome 则不可用，
无 JS 交互与等待策略）；正文抽取为启发式（非第三方 Readability，无 DOM 语义理解）；
历史按空间上限裁剪（默认 200 条，超出丢最旧）；`team-hub` 未运行时历史不可用（界面明确说明而非假装空历史）。
**注意**：本切片同样**未能**跑完整个 `test` 阶段获取全量基线——main 上 `notify-hub-smoke` 会让该阶段永久等待
（根因与最小修法见 `docs/P2-7-evidence/verify-evidence.md` §7），本切片按套件逐个验证，未伪造全量基线。

## P3：生产级能力

### P3-1 白板多房间与连接治理 ✅ 已完成（2026-09-10）

原状：单实例、单进程、单房间，仅一个全局 token，无连接/频率限制，`/healthz` 只回 `{ok,storage,ts}`。
四项全部落地（`whiteboard/apps/server/src/` + 前端 `apps/web` + `packages/shared/src/room.mjs`）：

- **房间 ID、房间级存储与成员权限**：房间 ID 规则 `^[a-z0-9][a-z0-9_-]{0,63}$`（刻意排除大写与点号，
  顺带封死路径穿越），非法 ID 在升级阶段 400 拒绝且**不静默回退**到 default。每房间**独立 SQLite 文件**
  `data/rooms/<id>.db`，首个连接惰性打开、空闲且无人在线时关闭（关闭前落快照）；房间数上限默认 50，
  超限**拒绝新房间而不驱逐已有房间**。权限按房间配 `WHITEBOARD_ROOMS="main:tokA:rw,view:tokB:ro,open-room::rw"`：
  未声明房间沿用全局 token 语义（回环开发可不配），已声明房间只认自己的 token（全局 token 不能越权进私有房间），
  非法配置项打印告警而非静默忽略；角色 `rw`/`ro`，只读连接写入被服务端拒绝（`op_denied`，且不广播被拒的 op）。
- **连接数 / 消息大小 / 消息频率限制（分级）**：连接数按全局/单房间/单 IP 三档，在**握手之前**裁决，
  超限返回 503（体带可区分的 reason）；消息过大（按 UTF-8 字节）与 op 条数过多、畸形 JSON → 立即 1009/1008 断开；
  频率超限走令牌桶：先丢弃并回 `rate_limited` + `retryAfterMs` 告警（告警按最小间隔节流），
  窗口内累计丢弃达阈值才断开——网络抖动只丢消息，持续冲击才断开。
- **指标、审计与更完整的健康检查**：`/metrics`（计数器 + 实时仪表盘 + 生效限流参数 + 房间明细 +
  拒绝原因分布 + 关闭码分布）、`/readyz`（逐房间存储健康 + tick 心跳新鲜度，停摆可感知）、
  `/api/rooms`、`/api/rooms/<id>`、`/api/rooms/<id>/audit?type=&limit=`（审计 JSONL 落盘 + 内存环形缓冲，
  按大小轮转保留 3 份）；`/healthz` **保持既有契约**（`ok`/`storage`/`ts` 与 200/503 语义）并附房间/在线读数。
  控制面（metrics/readyz/api/rooms）默认**仅回环**，远程需 Bearer token 或 `WB_CONTROL_OPEN=1`。
- **实例形态：明确继续单实例**（ADR-0008）。被否方案（多实例共享存储、单库加 room 列、房间成员表、
  一律断开/一律丢弃）逐条记录理由与转 v2 触发条件（连接数持续越过 200/50、需要跨进程共享同一房间、
  可用性要求高于单点）；StorageProvider 与 RoomRegistry 均保留可替换注入边界。

修掉 3 个真实缺陷：① 房间化后暴露原**全局广播**会把 A 房间的图形画到 B 房间（改为按房间广播）；
② 单 IP 连接上限初版默认 10，把同一 NAT/公司出口的第 11 个正常用户与仓库自带 bench（20 客户端同 IP）
一并拒掉，默认值改为 50 并加「单 IP 不得小于单房间上限」的回归断言；
③ **静态托管**（`workbench/scripts/serve.mjs`）先发 200 头再读文件，产物缺失时只能断流，
客户端看到 `fetch failed` 而非可读原因（这正是本次 CI smoke 在新建 worktree 里给出误导性失败的根因）——
改为先确认可读再写头，缺失时 404 + 「请先 vite build」指引，并新增 `static-serve` 套件锁定。

测试：白板 `npm test` **158 例**（原 70 → 新增 88：房间注册表 20、权限/房间配置解析与 safeEqual 5、
限流 17、指标审计 13、治理端到端 20、前端房间纯逻辑 12、前端静态契约 6），CI 白板套件由 7 文件升为 12 文件；
另在 workbench 侧新增静态托管回归 `static-serve` 6 例，并确认 `web` 24/24 与 `web-p28` 21/21 不回归；
压测 gate 与 soak 均过（20×20：P95 109ms；50×10：500 op 全收敛、P95 223ms）；
另用真实文件型房间跑生产路径验证 18/18（真实进程重启后按房间恢复、磁盘 DB 与审计 JSONL 落盘）。
证据：`docs/P3-1-evidence/verify-evidence.md`。

**已知边界（诚实登记）**：指标与审计为**进程内**（重启归零）；审计按大小轮转保留 3 份，无长期归档与压缩；
角色只有 rw/ro 两档（无按元素/区域细粒度权限，无操作级回放）；单 IP 限制为**粗粒度**防滥用且
**不信任** `X-Forwarded-For`（反代大部署需在边界做真实客户端识别）；房间空闲关闭依赖 tick 心跳；
多实例共享存储**未实现**（ADR-0008 记录了触发条件）；前端仅做判定层测试（不引入 jsdom/浏览器自动化）。

### P3-2 统一配置系统 ✅ 已完成（2026-09-10）

原问题：配置分散在环境变量、CLI、services-plugin、DSH 宿主和 Workbench 本地设置。

**决策（四项分叉点已确认）**：覆盖**活跃三进程**（team-hub / workbench / whiteboard）；
`scrum` 已退役（只在 schema 登记状态、不改代码），两个 DSH 插件的配置仍由宿主 composition 管理；
统一强度取**轻量路线**——统一 schema + 优先级 + 校验命令 + 启动脱敏摘要，**不引入新配置文件**
（env/CLI 仍是唯一注入面，运行时语义零变更）；不做可视化配置界面（CLI + 摘要 + 文档足够）。

已完成：

- ✅ **统一配置 schema 与优先级**：引擎 `packages/shared/src/config.mjs`（`defineSchema` / `resolveConfig` /
  `coerce` / `redactConfig` / `formatSummary`），优先级 **CLI > env > 默认值**，结果带 `sources`
  （可回答「这个值从哪来」）。三份 schema 共 **54 个字段**：team-hub 12 / workbench 21 / whiteboard 21。
  类型校验覆盖 `int/bool/enum/csv/path`（含 min/max/choices）；**非法值报错退出，不静默回退**。
- ✅ **启动时输出脱敏后的最终配置摘要**：三进程在监听前各打一行，secret 只显示 `***(N 位)` 或 `(未设置)`；
  复合值走字段级脱敏（`WHITEBOARD_ROOMS=main:<token>:rw` → `main:***:rw`）。
  摘要与 `--json` 共用同一脱敏路径。
- ✅ **统一 token、host、port、DB 路径与附件目录**：三进程入口的核心项统一走引擎解析
  （`team-hub/server.mjs` 的 `PORT/HOST/TOKEN/DB_FILE`、`workbench/scripts/serve.mjs` 的
  `port/host/token/staticRoot`、`whiteboard/apps/server/src/index.js` 的 `PORT/HOST/DB_PATH/TOKEN`），
  并新增 `--port/--host/--token` 命令行覆盖（此前只有 workbench 支持）。
  相对路径与「显式提供即原样使用」的既有语义保持不变。
- ✅ **配置校验命令**：`node scripts/config/check.mjs`（`--process` / `--json` / `--env-file` /
  `--isolated-env` / `--strict` / `--show-source`）；配套
  `scripts/config/scan.mjs --check`（每个 env 读取点必须在 schema 中声明）与
  `scripts/config/sync.mjs --check`（白板副本与根引擎逐字节一致）。
  10 条**跨进程一致性规则**（端口冲突、hub 上游端口不符、token 缺失/不一致/未使用、非回环无 token、
  静态产物缺失、DB 落在房间目录内、写 token 未配）。

**额外收获（不是预设计划的一部分，但更有价值）**：扫描器与单测抓出了此前**不可见的配置面**——

- workbench 有 10 个经 `envBytes(name, def)` **间接**读取的环境变量（`DSH_WORKBENCH_CHUNK_SIZE`、
  `DSH_WORKBENCH_MAX_UPLOAD_TOTAL`、`DSH_WEB_CACHE_TTL_MS`、`DSH_WEB_CACHE_MAX`、`DSH_WEB_QUOTA_*` 四项、
  `DSH_WEB_AUDIT_MAX_BYTES`），白板有 9 个经 `env[key]` 间接读取的 `WB_*` 键：直接扫描（`process.env.X`）
  **完全看不到**它们，只有把「间接读取」和「疑似 env 字面量」纳入识别才暴露出来。
- `WHITEBOARD_ROOMS` 内嵌每房间 token，原本会被当普通字符串打进启动摘要（**真实泄漏**，由单测抓到），
  现已走字段级脱敏。
- schema 写默认值时暴露一处**认知偏差**：workbench 审计轮转默认值实际是 5MiB，而我按印象写成 4MiB；
  「默认值漂移」单测（直接 import 三进程自己的常量比对）把它挡住了。

门禁：`env` 阶段新增三项配置自检（scan / sync / check 夹具，用 `--isolated-env` 消除宿主会话变量影响），
`test` 阶段新增 `config` 套件 **27 例**。白板 158 例与 team-hub/workbench 各套件无回归。

证据：`docs/P3-2-evidence/verify-evidence.md`；参考手册：`docs/CONFIG.md`。

**已知边界（诚实登记）**：只覆盖活跃三进程（`scrum` 与两个 DSH 插件不在体系内）；
配置在启动时解析一次，**不支持热更新**；`check.mjs` 只做配置面一致性，**不发网络请求**
（上游 hub 是否真在跑只有连上去才知道）；**单份环境无法触发 token 一致性规则**（两进程读同一个
`TEAM_HUB_TOKEN`，只有分别在不同 shell 配置时才会不一致，该规则靠构造两份配置的单测覆盖）；
`check.mjs` 默认读当前 shell 环境，在 DSH 会话里直接跑会把宿主的 `TEAM_HUB_PORT` / `DSH_WEB_URL`
算进来（真实但与本机会话相关的告警，用 `--isolated-env` 复核）；
白板副本是**本仓库特有的折衷**（Docker 构建上下文隔离所致），若白板改为以仓库根为上下文或拆为独立仓库，
应改为直接引用并删除副本与 `sync.mjs`。

### P3-3 历史 evidence 文档治理

状态：**已完成**（2026-09-10）—— 当前状态入口 `docs/STATUS.md`；标注工具 `scripts/ci/evidence-banner.mjs`

当前部分历史报告仍保留旧测试数量、旧默认 host 或旧构建命令。

已完成：

- ✅ **标记历史 evidence 不可作为当前状态依据**：`scripts/ci/evidence-banner.mjs` 为 `docs/` 下全部
  **47 个证据快照目录**（`*-evidence/`、`G-*/`，含嵌套）的 **61 个顶层 md** 写入统一 banner
  （`⚠️ 历史快照 —— 不作为当前状态依据`，含基线日期与 commit）；目录无 md 时自动建入口 README。
  脚本幂等（重复运行 0 改写），`--check` 供 CI 校验，`--force` 供模板升级后重写。
- ✅ **统一当前状态入口**：新建 `docs/STATUS.md`（形态/拓扑表、双进程同库等关键约定、25 套件
  测试基线表、复跑命令、按可信度分层的文档地图、已知限制、维护约定）；`README.md` 顶部链接
  STATUS 并**修正过期描述**（原文称 `scrum/` 保留 `:4820` 独立页面，实际 P1-1 第 2 步已退役托管）。
- ✅ **增加生成时间和基线 commit**：banner 内基线取该目录**首次入库提交**（`git log --diff-filter=A`）
  的短 hash 与日期；STATUS.md 记录最近全量基线 commit 与结果。
- ✅ **机器校验**：`check-docs.mjs` 新增第 9/10 类校验项（STATUS 存在且含基线/CI 证据/复跑命令 +
  README 已链接 + 证据快照 banner 覆盖完整），接入 run-ci `doc` 阶段。三项负测试（去掉 banner、
  去掉 README 链接、去掉 STATUS 关键字段）均按预期 FAIL，恢复后 PASS。

## 推荐实施顺序

1. P1-1：先决定 team-hub 唯一权威实现。
2. P1-2：~~补 board-plugin 独立 HTTP 契约测试~~（已完成，见上节）。
3. P2-1：统一 v1/v2 任务和 SSE 公共语义。
4. P2-2：~~统一 team-hub 读接口权限模型~~（已完成，见上节）。
5. P1-3：在真实 DSH 宿主完成插件注入冒烟。
6. P2-3：统一 SSE 断线恢复。
7. P2-4～P2-8：按用户价值选择 Workbench 功能增强。
8. P3：在确认部署规模后再做白板和配置系统的生产化改造。

