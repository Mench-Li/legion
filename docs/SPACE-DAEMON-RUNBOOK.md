# 新空间接入 Runbook：守护实例 + 流水线

> 适用场景：在指挥台「新建空间 + 编队」之后，让该空间「发布目标」能真的自动派工。
> 本文由 T-127 现场核验后落地（ozon 空间目标 G-mttwdurn-1 停滞 16 小时的根因与修复过程见第 5 节）。
> 参考实现：`roles-ozon.json` + DSH profile `cordis.patch.yml` 的 `legion-scrum-worker-ozon` 行。

## 1. 心智模型：一个守护实例 = 一个空间

| 事实 | 依据 |
| --- | --- |
| `scope` 是实例启动期常量，扫单只拉本 scope 任务 | `plugins/src/index.ts` scope 解析 + `listTasks()` → `/api/board?scope=<scope>` |
| 只有 `mode:'mediator'` 的实例跨空间，且**不认领、不派工**（只做合入调解） | `sweep()` 开头 `if (config.mode === 'mediator') { await sweepMediation(); return }` |
| 任务是否本实例的活，看 `task.role ∈ 流水线 stage 集合` | `if (isPipeline && stageOf(t) === undefined && t.role !== 'discussion') continue` |
| 目标链任务的 role 来自**该空间编队**（roster），不是 roles.json | `team-hub/server.mjs` `createGoalChain()`：`SELECT role… FROM roster WHERE scope=? ORDER BY sort` |

**推论（新空间必须同时满足两条）**：
1. profile 里有一行 `scope = <spaceId>` 的 worker 实例；
2. 该实例的流水线文件里，每个 `stage.role` 与该空间编队的 role **逐字一致**。

少第 1 条 → 目标链创建成功但永远停在 todo（指挥台看起来"目标停滞"）。
少第 2 条 → 守护能扫到任务，但按"未知角色"整批跳过（日志无异常，只有 inbox 不消费）。

## 2. 开通四步（约 10 分钟）

> **SP-P0 起：流水线定义住进数据面**。下面 Step 2 改为把阶段契约写入 team-hub（`space_stages` 表），
> 守护每轮扫单从 `GET /api/pipeline` 读取（数据面优先，部署面 `rolesFile` 仅作离线兜底）。
> 好处：新增/改编队时不需要再改宿主配置文件，且 Step 4 的自检会把「编队与流水线不一致」当场报出来。

**Step 1 取编队 role 清单**

```powershell
Invoke-RestMethod "http://127.0.0.1:8787/api/roster?scope=<spaceId>" | % agents | ft role,name
```

**Step 2 导入流水线到数据面**（`roles-<spaceId>.json` 仍可作为**可版本化的导入源**，模板：`roles-ozon.json`）

```powershell
# 从 roles 文件一键导入（整批 upsert；--dry-run 先看差异与告警）
node team-hub/scripts/seed-pipeline.mjs --scope <spaceId> --file roles-<spaceId>.json --runtime-enabled
```

每个 stage 的 `role` 必须与 Step 1 输出**逐字一致**，顺序 = 目标链推进顺序。也可直接调 API：
`POST /api/pipeline {scope, stages:[…], runtime:{enabled:true}}`（仅 general）。
写入期即校验：role 形状/唯一、`next` 可达、`gate:true` 必须有 `artifact`、`docs` 必须是仓库相对路径。

**Step 3 在 profile 里 insert worker 行**（`$DSH_HOME/profiles/web/cordis.patch.yml` 的 `insert:` 列表）

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `id` | `legion-scrum-worker-<spaceId>` | 新 id，不能与既有行重名 |
| `scope` | `<spaceId>` | 必须等于 space id（**数据面流水线以 scope 为 key，必须显式**） |
| `rolesFile` | `D:/project/DSH/legion/roles-<spaceId>.json` | 现在只作离线兜底（hub 不可达时用）；缺省 = `<repoRoot>/roles.json` |
| `repoRoot` / `workspace` | 空间绑定仓库路径 | 仅兜底；hub 模式下每轮按 `/api/spaces` 的 `localDir` 覆盖 |
| `worktreeRoot` | `<repo>/\.legion-worktrees` | 隔离分支 `w/<任务ID>` 的挂载点；需在该仓库 `.gitignore` 忽略 |
| `hubUrl` | `http://127.0.0.1:8787` | 必须显式指向 team-hub v2 |
| `logFile` | `…/dsh-scrum-worker-<spaceId>.log` | 不设会与 software 实例共用同一日志文件 |
| `mediateMergeFails` | `false` | 公共调解员已统一处理合入失败 |

**Step 4 保存即热生效**（profile 的 patch 层被 watch，无需重启宿主），30 秒内逐项验证：

```powershell
# ① 开通预检：一条命令列出全部阻塞项（流水线/编队一致性/守护在线/工作区绑定/队列停滞）
Invoke-RestMethod "http://127.0.0.1:8787/api/spaces/provision?id=<spaceId>" | % checks | ft level,code,message
# ② 实例日志出现空间绑定与流水线来源
Get-Content "$env:USERPROFILE\.dsh\super-injector\dsh-scrum-worker-<spaceId>.log" -Tail 10
# ③ 心跳成员在线（kind=worker）
Invoke-RestMethod http://127.0.0.1:8787/api/members | ? member -like "*@<spaceId>"
# ④ 首环被认领
Invoke-RestMethod "http://127.0.0.1:8787/api/board?scope=<spaceId>" | ft id,status,soldier,role
# ⑤ 隔离 worktree 落地
git -C <repo> worktree list
```

通过标准：预检无 `error` 级项（`daemon-offline` 是最常见的 error），日志出现
`空间流水线来源=hub（scope=…，version=…，N 环：…）`，成员在线，发布目标后首环进入 `in_progress`。

## 3. 流水线文件字段语义（守护真实消费点）

| 字段 | 消费点 | 要点 |
| --- | --- | --- |
| `role` | 认领闸门 `stageByRole.has(task.role)` | 与编队 role 逐字一致；一个 role 只能出现一个 stage 定义 |
| `label` | 派工提示词「当前角色」、完成评论 | 中文岗位名 |
| `prompt` | 角色职责注入（`goalizePrompt` 会按目标改写其中的 `docs/REQUIREMENTS.md` 等六槽位） | 写清产物路径、证据纪律、边界、联网口径 |
| `next` | 完成后流转/自动合入 | 非空 → `autoPromote` + `done` + 建/解锁下一环；`null` → 末段自动收官（免将军验收） |
| `gate` | 人工闸门 | `true` → 合入主分支后停 `in_review` 等将军验收；**打回**即带原因重做 |
| `artifact` | 闸门产物存在性校验 | 校验路径 = `<目标 docsDir>/<basename>`，故只适合 `docs/<六槽位名>.md`（REQUIREMENTS / RESEARCH / TASK_BREAKDOWN / TEST_CASES / TEST_REPORT / DEPLOY） |
| `docs` | 契约产出文档自动登记 + 软门禁 | 守卫 `done` 结算时按此逐条登记为任务产物（任务详情可一键预览）；**任一缺失 → 任务停 `in_review`** 并写明缺哪个文件 |

**七个必须知道的坑**

1. `docs` 里**非六槽位路径**（如 `research/ozon/selection.md`）不会被目标化改写，按仓库相对路径原样登记 → 业务资料库可以按业务真实路径声明契约（`roles-ozon.json` 即如此）。
2. `docs` 是**软门禁**：声明了就必须真产出，否则停在 `in_review`。只声明你有把握产出的主文档，次要产物写进 prompt 即可。
3. `gate:true` 的 `artifact` 用 `docs/REQUIREMENTS.md` 这类槽位名，并在 prompt 里明确要求把结论写进目标目录的对应文件，否则会因"找不到文档"卡在 `in_review`。（**SP-P0 起写入期就拦**：`gate:true` 而无 `artifact` 的提交会被 400 拒绝。）
4. **数据面优先，文件是兜底**：守护每轮扫单读 `GET /api/pipeline?scope=`（按内容指纹 `version` 增量刷新），改数据面**下一轮即生效**；`rolesFile` 只在 hub 不可达或该空间未配置流水线时生效。改数据面用 `POST /api/pipeline` 或 `seed-pipeline.mjs`——**不要在跑着守护时只改文件然后期待生效**。
5. 目标链在创建时就按编队预建全部阶段任务（`blockedBy` 串链），所以 `advancePipeline` 的"补建 next"通常不会触发——链推进靠依赖解锁，不靠 `next`；但 `next` 仍决定"是否自动合入并前进"与"哪一环收尾"。
6. **入链 = 编队 ∩ 流水线启用岗位**（SP-P0）：编队里的观察员/管理员不再被串进链；两者零交集时发布会直接 400 并回滚，不再生成一条永远不会动的链。
7. 目标链的阶段前缀标签优先取数据面 `label`（如【需求调研】）；无数据面配置时仍回退 `GOAL_STAGE_LABELS` 按位置套用（该回退路径会给出「代码开发/代码审查」这类错配标题，只影响标题不影响派工）。

## 4. 新空间完整开通清单（建议照此逐项打勾）

- [ ] 空间创建：`localDir` 指向真实 git 仓库（隔离 worktree/合入依赖它）
- [ ] 该仓库 `.gitignore` 忽略 `.legion-worktrees/`
- [ ] 编队（roster）：role 命名稳定、可长期引用（流水线要靠它对齐）
- [ ] `roles-<spaceId>.json`：与编队逐字对齐，产物路径按业务真实路径
- [ ] `seed-pipeline.mjs --scope <id> --file roles-<spaceId>.json --runtime-enabled` 导入数据面
- [ ] profile 追加 worker 行（字段见 §2 Step 3）
- [ ] `GET /api/spaces/provision?id=<spaceId>` 无 error 级项
- [ ] 需要人工把关的阶段加 `gate:true` + `artifact`（分析类建议加）
- [ ] 发布目标，确认首环进入 `in_progress` 且有 `🟢 已派 AI worker 开始执行` 评论

## 5. 多实例已知限制（产品化待办，均已在本机复核）

| # | 现象 | 根因 | 建议 |
| --- | --- | --- | --- |
| 1 | 两个 worker 实例抢写同一个 `scrum/daemon.json`，看板/健康页显示的守护身份会跳变 | 状态文件名只有 worker/mediator 两级（mediator 才分文件） | 按 scope 命名 `daemon-<scope>.json`，读端聚合 |
| 2 | 「⏸ 全局暂停」会同时停掉所有空间 | `control.json` 全局共享，被所有实例读 | per-scope 控制文件 + 指挥台按空间暂停 |
| 3 | 「⚡ 持续执行编排」开关与「🤖 派 AI 执行」按钮无实际消费者 | 只写 hub `exec_state` / `exec_requests`，守护侧从不读 | 接线到守护（按 scope 开关派工）或下线该控件 |
| 4 | 业务空间目标链标题出现「代码开发/代码审查」 | `GOAL_STAGE_LABELS` 按位置套 | 【SP-P0 已缓解】配了数据面流水线的空间改用流水线 `label`；未配置空间仍走回退 |
| 5 | 技能桥共享 `~/.dsh/skills`：同名技能 id 会被后同步的空间覆盖 | marker + tombstone 机制按 id 收敛 | 约定全局唯一 id，或按空间分目录 |
| 6 | 「模型配置」里给空间/岗位选的模型对派工不生效（worker 走宿主默认模型） | `ensureForeman` 用 `agentDefaultModel.currentSelection()`；只有 chat-responder 读 `/api/models` | 派工时按 `agent_models(scope, role)` 选模型 |
| 7 | 新增空间必须在 profile 里手工加一行，指挥台没有任何入口 | 部署面（DSH profile 配置）与产品面（workbench 空间管理）未打通 | SP-P2 一键开通（SP-P0 已提供 `space_runtime` 与开通预检作为数据基础） |
| 8 | 编队里出现非执行成员（观察员/管理员）会把 `blockedBy` 链卡死 | 建链原按「全编队」 | 【SP-P0 已修】入链 = 编队 ∩ 流水线启用岗位；预检报出未入链成员 |

## 6. 产品化路线（分阶段）与当前进度

目标：将军在指挥台新建空间 → 编队 → 点「开通执行」→ 空间立刻可自动派工，不需要碰 profile 文件。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **SP-P0** | **编队即流水线（配置单源）**：`space_stages` / `space_runtime` 表 + `GET/POST /api/pipeline` + `GET /api/spaces/provision` 开通预检 + `seed-pipeline.mjs` 导入；守护改为每轮从 hub 取流水线（`rolesFile` 仅作离线兜底）；入链 = 编队 ∩ 流水线启用岗位；链标题取流水线 label | ✅ 已完成（分支 `w/space-pipeline`） |
| SP-P1 | **单进程多空间编排**：一个守护实例跑 N 个空间；per-scope 状态文件/日志/暂停/并发；space_runtime 生效（enabled=false 即不接管）；修 §5 的 1/2/7 | ⏳ 待启动 |
| SP-P2 | **一键开通 + 模板**：空间模板（编队/流水线/技能/工作区骨架）、空间复制、开通向导（选模板 → 绑工作区 → 点开通 = 写 space_stages+space_runtime 并自动挂载执行器）；工作区三模式（本地目录 / git 远端自动 clone / 无仓库）；指挥台「执行健康」卡 | ⏳ 待启动 |
| SP-P3 | **执行后端可插拔 + 凭据**：`executor` 抽象（local-subagent / remote-agent / container）、secret store（模型与 git 凭据不进明文配置）、每空间预算与配额 | ⏳ 待启动 |

已完成的 SP-P0 具体改动：

1. **编队即流水线**：阶段定义从部署面 `roles.json` 搬进数据面 `space_stages`（role/label/prompt/next/gate/artifact/docs/sort/enabled），空间执行配置进 `space_runtime`。
   - 收益：改编队不必再改宿主配置；配错（编队与流水线零交集）当场 400 + 回滚，而不是静默生成一条永不推进的链。
   - 兼容：`rolesFile` 仍是 hub 不可达或未配置时的兜底；software 空间两路内容已逐字段对拍一致（`GET /api/pipeline` 与 `roles.json` 等价）。
2. **开通预检**：`GET /api/spaces/provision?id=` 一条命令列出流水线/编队一致性、守护在线、工作区绑定、队列停滞等全部阻塞项与修复指引（对治「目标停在 todo 无人知晓」）。
3. **入链规则**：目标链 = 编队 ∩ 流水线启用岗位（`enabled=false` 的岗位不入链不派工），从机制上消除 `blockedBy` 链死锁。
4. **剩余待办**（P1+）：单进程多空间、`space_runtime.enabled` 实际生效、指挥台流水线编辑器、§5 的 1/2/3/6 号问题。

## 7. 存量空间迁移（升级到 SP-P0 之后）

数据面为空 = 行为不变（守护回退 `rolesFile`），所以升级是**无破坏**的；要让某个存量空间也用数据面，按需导入即可：

```powershell
# software：导入后与 roles.json 内容逐字段一致（已对拍），仅来源标注变为 hub
node team-hub/scripts/seed-pipeline.mjs --scope software --file roles.json

# 业务空间（如 ozon）：导入后才能享受「入链 = 编队 ∩ 流水线」与预检
node team-hub/scripts/seed-pipeline.mjs --scope ozon --file roles-ozon.json --runtime-enabled
```

导入后 `daemon.json` 的 `pipeline.source` 会从 `file` 变为 `hub`（`version` 为内容指纹），
日志出现 `空间流水线来源=hub（scope=…，version=…，N 环：…）`；两者都可作为「已切到数据面」的证据。

## 8. 把 SP-P0 激活到运行中的部署

代码合入后，**运行中的进程不会自动换码**：hub 是常驻 node 进程（services-plugin 托管），
守护是 DSH 宿主里的插件实例。按下面顺序激活（每一步都可独立验证，失败可单步回退）：

```powershell
# ① 合入（分支 w/space-pipeline → main；本次是快进合并）
git -C D:\project\DSH\legion merge --ff-only w/space-pipeline

# ② 重建宿主实际加载的构建产物（lib/ 是构建输出，不在版本控制里）
$env:DSH_CHECKOUT='D:\project\DSH\dsh\deepseek-harness'
node D:\project\DSH\legion\scripts\ci\build-external-package.mjs team-hub
node D:\project\DSH\legion\scripts\ci\build-external-package.mjs plugins

# ③ 重启 team-hub（services-plugin 对子进程异常退出会自愈拉起；~1 分钟窗口）
$pid8787 = (Get-NetTCPConnection -LocalPort 8787 -State Listen).OwningProcess
Stop-Process -Id $pid8787 -Force
# 等它自己回来；30s 内没回来就用同一命令行手工拉起：
# Start-Process node -ArgumentList 'D:\project\DSH\legion\team-hub\server.mjs' -WorkingDirectory 'D:\project\DSH\legion'

# ④ 新路由自检（旧进程会 404，新进程返回空流水线）
Invoke-RestMethod "http://127.0.0.1:8787/api/pipeline?scope=software" | Select-Object version, activeRoles

# ⑤ 导入存量空间流水线（内容与既有 roles.json 逐字段一致，只换来源）
node D:\project\DSH\legion\team-hub\scripts\seed-pipeline.mjs --scope software --file roles.json
node D:\project\DSH\legion\team-hub\scripts\seed-pipeline.mjs --scope ozon --file roles-ozon.json --runtime-enabled

# ⑥ 让守护实例重新挂载以加载新构建（改任一该行配置值即触发该行热重载；
#    DSH Desktop 重启同样会全量重新挂载）
#    验证：日志出现「空间流水线来源=hub」+ daemon.json.pipeline.source=hub
```

> ⚠️ **实测更正（2026-09-10）**：改配置值确实会触发该行**重新挂载**（`apply()` 重跑、新配置生效——
> 实测 `intervalMs` 改动被守护读走），但**同进程内不会重新加载模块代码**：宿主用 ESM 动态 import
> 按解析后的 URL 缓存，`lib/index.js` 路径不变 → 缓存命中 → 仍是旧代码（实测 `daemon.json` 仍写旧形状、
> 无 `pipeline.source`、日志无「空间流水线来源=hub」）。
> **因此：宿主侧插件的代码变更必须重启 DSH 宿主（重启该 profile）才生效**；配置文件/mount 参数变更才可热生效。
> 重启后按 ⑥ 的判据验收。

**回退**：`git -C D:\project\DSH\legion reset --hard <合并前 HEAD>` + 重复 ②③（重建旧产物并重启 hub）。
数据面无害：旧代码根本不读 `/api/pipeline`，所以「先 seed、后换码」不会造成任何行为差异。

**为什么不能跳过 ②**：`lib/` 不在版本控制内（`team-hub/lib`、`plugins/lib`、`board-plugin/lib` 均为构建输出），
DSH 宿主与 services-plugin 加载的都是 `lib/index.js`——只改 `src/` 不影响运行中的进程。

### 8.1 本机实际激活记录（2026-09-10）

| 步 | 实际动作 | 观察到的结果 |
| --- | --- | --- |
| ① 合入 | 分支先 `rebase main`（main 已前进到 P2-5），再 `merge --ff-only` | main 推到 `2c92f5f`；`run-ci.mjs` 的 calendar-ui 行与 pipeline 行自动合并共存 |
| ② 重建 | `tsc -p team-hub/tsconfig.json`、`tsc -p plugins/tsconfig.json` | `plugins/lib/index.js` 中 `stagesFromHubPayload`/`refreshPipelineFromHub`/`resolveDiscussion` 均可命中 |
| ③ 重启 hub | 结束 :8787 监听进程 | services-plugin **约 1 秒**自愈拉起（同库 `team.db`，无数据丢失） |
| ④ 新路由 | `GET /api/pipeline?scope=software` | 200（空态指纹 `da39a3ee5e6b4b0d`）；此前旧进程为 404 |
| ⑤ 导入 | `seed-pipeline --scope software` / `--scope ozon --runtime-enabled` | software `e7c0f44ad10d63cd`（8 环）、ozon `f474056e0fd6bd80`（6 环） |
| ⑥ 验收 | 线上数据面 vs `roles.json` 逐字段对拍；两空间预检 | **8/8 完全一致**；software `ok=true`、ozon `ok=true` |

**尚未做（有意）**：运行中的两个守护实例仍加载旧构建——它们的流水线来源在**下次重新挂载时**才切到 hub。
两种触发方式任选：DSH Desktop 重启（全量重挂载），或改任一该行配置值（只热重载该行，秒级）。
在此之前数据面已就绪但**无任何行为差异**（旧守护根本不读 `/api/pipeline`，且 software 的 hub 内容与文件逐字段相同）。

> 更正：上面的「改配置值即可切源」经实测**不成立**——热重载只重跑 `apply()`（配置生效），不重新加载模块代码，
> 故旧守护不会开始读数据面。已实测：改 `intervalMs` 后守护确实读到新值，但 `daemon.json` 仍是旧形状、无 `pipeline.source`。
> 结论：**要切到 hub 来源，必须重启 DSH 宿主**（重启 profile）。因此建议与下一次守护侧代码变更（SP-P1）合并为一次重启。

**升级期间若 main 还有别的在写工作流**：合入前先确认「本次要改的文件」不在对方的未提交清单里（`git status --short`）。
若重叠（本次 `scripts/ci/run-ci.mjs` 一度重叠），用 `git stash push -- <该文件>` → 快进 → `git stash pop`，
并在动手前把对方的在写文件逐字备份到临时目录；恢复后抽检内容与备份是否等价（注意 git 可能做行尾规范化）。

