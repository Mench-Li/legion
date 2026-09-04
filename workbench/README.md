# Legion Workbench —— 军团指挥台（独立 Web 应用）

把 legion 的看板/中枢数据投影为「AI Office 式」作战仪表盘，并承载 v2 主控操作：任务详情与 AI 执行过程、
智能体任务清单、任务调度/验收、持续执行编排、模型×智能体配置。中枢模式（team-hub v2 :8787）下为**真分区主控台**；
无中枢时回退 serve.mjs（:4820）只读 v1 视图。

## 快速开始

```bash
# 1) 先启动数据源（legion 看板服务）
cd D:\project\DSH\legion
node scrum\serve.mjs --port 4820 --host 0.0.0.0 --token legion-kanban-4820

# 2) 启动工作台
cd D:\project\DSH\legion\workbench
pnpm install
pnpm dev          # 开发模式 → http://127.0.0.1:5173

# 生产模式
pnpm build        # 产出 dist/
node scripts/serve.mjs --port 5173   # 独立静态服务 → http://127.0.0.1:5173
```

## 数据源配置

- 默认 `http://127.0.0.1:4820`；可在右上角「⚙ 数据源」修改（存 localStorage）。
- 页面刷新后可用 `?api=http://其他主机:4820` 覆盖（跨机器/局域网）。
- 写操作（新建任务、验收、打回、评论）需令牌：右上角「🔑 令牌」填入 `--token` 值。

## 与转型路线图的对应

| 截图元素 | 本应用实现 | 状态 |
| --- | --- | --- |
| 顶部 KPI（任务/完成/待处理/AI 员工/资源） | `KpiBar`，资源为客户端本机指标 | ✅ |
| 左侧模块 + 工作空间 | `Sidebar`：中枢模式下工作空间 = 全部空间 + team-hub 真实分区（`/api/scopes`），真分区切换 | ✅ |
| 右侧「当前任务集」泳道 | `MissionPanel`：中枢模式走 `/api/missions?scope=`（scopeAware=true）；v1 回退 serve.mjs 或客户端聚合；每岗任务按状态排序（进行中→待认领→已完成）+「展开全部 N」看全量 | ✅ |
| 右侧「实时动态」 | `ActivityFeed`：SSE 实时流 | ✅ |
| 快捷工具 | `QuickTools`：「打开内部看板」→ openKanban（经典看板新窗口）；「文件浏览/浏览网页」→ 进入文件中心/浏览器面板（`onOpenModule` 导航）；截图 OCR/语音待 DSH 工具面 | ✅/⏳ |
| 对话中心 | `ChatPanel`：team-hub v2 `/api/chat/*` 真实接入（会话列表/新建/发送/历史，随当前空间隔离）；实时 = 中枢**单一 `/api/events`** 按 `chat:*` kind 过滤；纯文本渲染（无 raw HTML） | ✅ |
| 文件中心 | `FilesPanel`：serve.mjs `/api/files`（同源，仅回环）——列表/逐层进入/文本预览（截断+行数）/二进制提示/下载/上传（409→覆盖确认）/新建目录/重命名/删除（confirm 二次确认）；未绑定空间 → 引导打开空间设置 | ✅ |
| 浏览器助手 | `BrowserPanel`：serve.mjs `/api/web/fetch`（SSRF 防护代理）——地址栏（自动补 https://）+ 标题/正文/链接结构化结果 + 分错误文案与重试；`ssrf_blocked` 明确文案 | ✅ |
| 日程日历 / 通知中心 | `Sidebar` 模块为**占位**：点击给出「P1 后续阶段接入」提示（不静默无响应，TC-S8-03） | ⏳ |
| 技能中心 | `SkillsPanel`：team-hub v2 技能库真实接入——列表（含待审/被拒复审视角）、注册新技能（提交即 pending）、将军发布/驳回、按成员或 scope 授权；随当前空间过滤，15s 轮询刷新 | ✅ |
| 中央智能体状态 | `CenterPanel`：**中枢模式下智能体 = 当前工作空间的专属编队**（每空间不同职业，team-hub `/api/roster`）；首页 = 3D 办公场景（编队绕会议桌、状态色实时投影），「智能体」模块 = 2D 状态总览；v1 回退看板聚合 | ✅ |
| 底部命令栏 | 新建任务/任务调度/导出日报可用；**全部暂停/继续已真实接入**（`/api/pause`/`/api/resume`，守护扫单前读取 control.json）；安排会议待引擎 | ✅/⏳ |
| 中央 3D 办公场景 | `Scene3D.tsx`（three + @react-three/fiber v9 + drei，懒加载独立 chunk）：等距办公室、会议桌 + 空椅一圈、AI 员工发光头部随状态变色（🟢进行中/🟡待验收/🔴受阻/🔵待命）、头顶名牌带任务数、目标进度环、轨道控制 + 自动旋转 | ✅ |

## 服务端配套（第 2 步，legion 引擎侧）

- `serve.mjs`（`scripts/serve.mjs`）新增 `GET /api/files/list|read|download`（S3）、`PUT /api/files/upload` 与 `POST /api/files/mkdir|rename|delete`（S4，仅回环 + `--token`/`DSH_WORKBENCH_TOKEN` 写鉴权、`overwrite=1`/`confirm=yes` 语义；上传按 Content-Length 预检 + 流式限长（413），正文先落同目录临时文件、收体完整后原子改名发布——中断/超限不破坏原文件，P0-1）、`POST /api/web/fetch`（S6 SSRF 防护代理 + 零依赖正文抽取）；文件/网页接口均有 `isMain` 守卫 + 纯函数导出供契约测试（`files-api.test.mjs`/`web.test.mjs`）。
- `serve.mjs` 新增 `GET /api/missions`（服务端任务集聚合，`?scope=`）、
  `POST /api/pause` / `POST /api/resume`（全局暂停/继续，写 `scrum/control.json`）、
  `/api/config` 增加 `paused` 字段。
- `dsh-scrum-worker`（`plugins/src/index.ts`）每轮扫单前读取 `control.json`：
  `paused:true` 时跳过认领/派工但保留心跳（`daemon.json` 带 `paused` 字段）。
  **守护插件已重新编译（`plugins/lib/index.js`，含空间仓库绑定消费逻辑）；正在运行的 Desktop 需重启一次才能加载新逻辑。**
- 真 scope 分区（工作空间数据隔离）由 team-hub v2（SQLite `tasks.scope`）提供；
  v1 文件模式 `scopeAware=false`，任何 `?scope=` 均返回全部任务。

## 真 scope 分区（team-hub v2，SQLite）

- **中枢模式**：工作台挂载后自动探测 `http://127.0.0.1:8787`（右上角「🧭 中枢」可改地址/清除）。
  探测成功 → 「工作空间」列出 team-hub 真实分区（`/api/scopes`），「当前任务集」走
  `/api/missions?scope=`（`scopeAware=true`，真分区），「新建任务」写入当前分区（`/api/create` 带 `scope`）。
- **team-hub v2 侧新增**：`GET /api/missions?scope=`（SQLite 按 tasks.scope 聚合，响应与 serve.mjs 同构）、
  `GET /api/scopes`（tasks+members 的 distinct scope）。
- **数据迁移**：`node team-hub/scripts/migrate-tasks.mjs --scope software` 把 `scrum/tasks.json`
  导入 SQLite（幂等）；示例：`curl -X POST http://127.0.0.1:8787/api/create -H "Content-Type: application/json" -d '{"title":"…","scope":"marketing","by":"general"}'`。
- v1 模式（中枢不可达）：自动回退 serve.mjs /api/missions（`scopeAware=false`）→ 客户端聚合，空间切换仅透传并提示。

## 工作空间专属编队（team-hub v2 /api/roster）

- **每个工作空间（scope）有自己的智能体队伍**——任务分区 + 编队分区双管齐下，空间间智能体差异化、专业化：
  software=软件流水线 8 岗位（需求分析师/方案研究员/…/部署运维员）、marketing=市场部 5 岗（市场分析师/内容策划/投放优化师/用户增长/品牌文案）、
  product=产品部 5 岗、ops=运营部 4 岗、default=通用 3 岗。`node team-hub/scripts/seed-roster.mjs` 幂等播种/刷新。
- 切换左侧工作空间 → 中央 3D 场景 / 智能体总览随之换成该空间的编队（人数、职业、状态全不同）。
- **状态实时投影**：每人按该空间任务的 `soldier` 认领聚合（进行中/待验收/受阻/待命 + 任务清单）；
  未入编队但认领了该空间任务的执行者（含旧士兵名）以「⚙️ xxx · 执行中」合流展示——即使任务已完成也保留（标注「已完成 N」），切空间不丢信息。
- **「全部空间」视图**：`/api/roster` 不带 scope 时聚合全部分区（`scope=all`），每名智能体带 scope 标注，跨空间一目了然。
- 数据流：`GET /api/roster?scope=`；v1 模式（中枢不可达）回退从看板按角色聚合。

## 新建工作空间（侧边栏「＋ 新建空间」）

- 两步弹窗：① 空间 id（唯一）+ 中文名 → ② **配置编队**——从全局智能体目录勾选（`GET /api/agents`，
  25+ 类岗位按 role 去重、标注来源空间，支持搜索），或**内联新建智能体**（role/名称/职责/头像，`POST /api/agents` 直接写入本空间）。
- 提交 = `POST /api/spaces` 建空间 + `POST /api/spaces/{id}/agents` 选人入编；空间名、编队人数实时显示在侧边栏；
  创建后自动切到新空间（空任务 → 编队全员待命，新建任务即入该空间）。
- 第一步可顺便配置**仓库绑定**（可选）：点「📂 选择文件夹」浏览选定该空间的本地目录（选中即其代码仓库，
  自动识别并预填远程），**远程仓库 URL 留空 = 仅本地 / 不进共享仓库**。没填不影响建空间，之后随时可改（见下节）。
- 旧空间（seed/迁移）未注册中文名时由 `GET /api/spaces` 推导合并显示原始 id；`seed-roster.mjs` 会补注册名。

## 空间仓库绑定（每个空间自己的本地文件夹 + 远程仓库）

不同工作空间可能对应**不同的本地文件夹 + 远程仓库**组合——如软件流水线跑 `D:/project/DSH/legion` +
`github.com/Mench-Li/legion.git`，个人业务空间（ozon/shop 之类）则只在自己的本地目录、不进共享仓库：

- **入口**：侧边栏工作空间行上的「⚙」→ `SpaceSettingsModal`（新建空间第一步也可顺便配置）：编辑
  显示名 / 🏠 本地·私有标记 / **本地文件夹** / **远程仓库 URL**。
- **本地文件夹 = 选文件夹，不手填**（与 DSH 工作空间选目录一致）：`FolderPickerField` + `FolderPickerModal`
  导航浏览本机目录（数据源 = workbench 自带同源接口 `GET /api/fs/home|/list?path=`，仅回环地址可访问），
  列表里带 `.git` 的目录标「⛁ 仓库」。选定后自动 git 探测（`POST /api/fs/inspect`：show-toplevel / 分支 /
  remotes）——该文件夹即本空间的**代码仓库**：是仓库 → 显示仓库根与分支，并把 `origin`（无 origin 取首个
  fetch remote）预填到远程仓库；不是仓库 → 提示仅本地使用（worktree 隔离不可用）；选中的是某仓库子目录时，
  隔离仓库根自动取所属仓库根（toplevel），worker 目录仍为所选文件夹。
- **存储**：team-hub `spaces` 表 `local_dir` / `remote_url` 列（老库启动时自动补列）；`GET /api/spaces`
  返回这两个字段；`POST /api/spaces` 幂等 upsert（审计记 `space:create` / `space:update`）。
- **消费方**：`dsh-scrum-worker` 守护在 hub 模式下每轮扫单从 `/api/spaces` 解析**本 scope** 的绑定——
  命中 `localDir` 时用它作为该空间的 worker 工作目录，其所属仓库根作为隔离仓库根（worktree / pre-push 守卫 /
  LEGION.md 注入 / 自动 promote 全走它）；`daemon.json` 新增 `repo { root, binding, localDir, remoteUrl }` 自述；
  未绑定 / hub 不可达时回退注入配置（`repoRoot` / `workspace` / `worktreeRoot`）。
- **边界**：remoteUrl 为空 = 仅本地 / 不进共享仓库；push 纪律不变——`w/*` worktree 分支仍一律禁止 push。

## 三中心：对话 / 文件 / 浏览器（S1~S7）

三个中心在左侧模块区与 QuickTools 双入口均可进入（`App.active` 状态一致），实现位置：
- **对话中心** `ChatPanel.tsx`：`fetchChatConversations / createChatConversation / fetchChatMessages / postChatMessage / subscribeHubAudit`（`api.ts`）。
  写 = team-hub `POST /api/chat/*`（统一 handleWrite，`by:'general'` 注入），审计/SSE 由服务端 DAO 留痕；前端**不再另开事件源**——订阅既有 `/hub/api/events` 并过滤 `action.startsWith('chat:')`，`detail.conv` 命中当前会话即刷新。
  边界：需中枢可达 + 选中**具体空间**（「全部空间」给出引导）；消息 ≤8000 字符；kind 白名单外消息与任何 HTML/脚本内容都按**纯文本**渲染（无 `dangerouslySetInnerHTML`）。
- **文件中心** `FilesPanel.tsx`：`fetchFileList / fetchFilePreview / fileDownloadUrl / filesUpload / filesMkdir / filesRename / filesDelete`。
  同源调 serve.mjs `/api/files/*`（仅回环；写请求需令牌则 401 映射 toast）。文件根 = 当前空间 `local_dir`（team-hub `/api/spaces`）；`../`/盘符/根外 symlink/`.git` 内部等越界与仓库内路径由服务端 `resolveInsideRoot`/realpath 守卫拒绝，前端只展示服务端错误文案。
  边界：未选空间/未绑定 → 面板引导（含「打开空间设置」跳转）；上传同名 → 409 → confirm 覆盖（带 `overwrite=1`）；删除 → confirm 后发 `confirm='yes'`。
- **浏览器助手** `BrowserPanel.tsx`：`webFetchPage`（POST `/api/web/fetch`）。无 scheme 输入自动补 `https://`（`normalizeUrl`），非法/空输入提示不发请求；
  结果字段 = 服务端白名单结构化（title/text/excerpt/links），正文按 `<pre>` 纯文本展示；错误码分别映射文案（`ssrf_blocked`→「已拦截：禁止访问内网地址」、timeout/too_large/http_4xx/dns_error/unsupported/empty_content 等）+「重试」。`timeoutMs` 为整条链（含重定向）**总超时**——重定向递归共享同一 deadline，不逐跳重置计时（P0-3）；最近抓取历史 localStorage（datalist 复用）。

> 测试注入口：抓本地 mock 页需 `DSH_WEB_FETCH_ALLOW_PRIVATE=1` 启动 serve.mjs（仅测试/本地演示；生产默认关闭）。

## 技能中心（team-hub v2）

- 左侧「🧩 技能中心」→ 真实技能库（需中枢可达；不可达时面板给出启动提示）。
- 列表含**复审者视角**（`?include=pending`）：已发布/待复审/已驳回三态徽章、版本、scope、owner、prompt（折叠查看）、授权对象。
- 操作：`＋ 注册新技能`（id 须小写字母/数字开头，提交即 pending）、待审项可「✅ 发布 / 驳回」、已发布项可「🔑 授权」（成员 id 或 `scope:xxx`）。
- 数据流：`GET /api/skills`、`POST /api/skills/register|review|grant`，15s 轮询 + 操作后即时刷新；士兵/守护只读取已发布技能。

## 任务详情与 AI 执行过程（点击任务）

- **入口**：右侧「当前任务集」任意任务行、任务调度弹窗、智能体任务清单里的任务，点击即打开**任务详情弹窗**（`TaskDetailModal`）。
- 详情内容：
  - **🤖 AI 执行过程**：执行该任务的 AI 智能体沉淀的过程记录 = evidence（`isEvidence:true` 评论）与评论的时间流——AI 的每一步行动/产出/汇报都在这里，是「任务详情看到 AI 工作过程」的落点；
  - **⏱ 进展时间线**：`GET /api/activity?taskId=`（goal:publish / claim / transition / comment / evidence / reassign / model:set / exec:*），中文可读；
  - 📋 任务描述、🎯 验收标准、🚧 边界（做什么 ✅ / 不做什么 🚫）、🔗 依赖解锁提醒；
  - **状态操作**：todo →「▶ 开工 / 🔒 认领」；in_progress →「📮 提交验收 / 归还待办」；in_review →「✓ 验收通过(general) / ↩ 打回重做」；blocked →「解阻」；另有「💬 评论/记录」「转派」「**🤖 派 AI 执行**」（写 `POST /api/exec/request`，请求执行守护认领）与「🖐 **拦截自动 / 🚀 放行**」（`POST /api/hold`，拦截后守护不再自动认领/执行）。
  - **派工防重**：已认领并派工的 in_progress 任务 →「🤖 AI 执行中（已派工）」禁用按钮（依 `comments/by=soldier-auto` 或 `soldier` 已绑判断），过程区文案说明 AI 正在执行——不再出现「进行中却提示还没有 AI 执行」的误导（守护派工成功即写 `🟢 已派 AI worker…` 评论，见 plugins 派工路径）。
  - **🧾 审计工作台（L1/L2）**：任务收尾（in_review/done）在 AI 执行过程下方展示「审计：改动 × 证据」——最新轮补丁的改动文件清单（A/M/D/R 徽标 + ±行数，`POST /api/patch` 结构化 files）逐文件「▾ 查看 diff」（按文件切 hunks）/「✓ / ✘ 批注」（`POST /api/review-notes`，`review_notes` 列）；测试报告（`testReport` ✅/❌+失败用例）与产物（`artifacts`）同屏；整体结论一键批注；**打回自动把 issue 批注拼进原因评论**（下一轮 worker 认领时经守护 feedback 注入提示词，闭环）。
  - **⚠ 并行改动重叠（L3）**：审计区顶部展示 `GET /api/overlaps?scope=&id=` 结果——本任务改到的文件同时被其他任务改动时逐文件列出对方任务/状态（黄条=含 in_progress/in_review 的活风险）。
  - **验收标准/边界自动生成**：发布目标建链、`POST /api/create` 建任务都会**按岗位自动注入验收标准 + 边界**（模板见 `team-hub/stage-standards.mjs`；自定义 `acceptance`/`boundary` 可覆盖；历史在途 `[auto-goal]` 任务在服务启动时自动补种）；执行 worker 的提示词与验收视图同步携带——验收按清单逐条对照，不再「凭感觉」。
- 数据流：`GET /api/task?id=`（team-hub 单任务接口）+ `GET /api/activity?taskId=`；状态操作与调度弹窗共用 `/api/transition|claim|reassign|comment`；审计批注走 `/api/review-notes`、重叠走 `/api/overlaps`。

## 智能体任务清单（点击智能体）

- **入口**：中部「🤖 智能体」2D 总览卡、或 3D 办公场景里的智能体（点身体/名牌均可）→ 打开该智能体的「任务清单」。
- 清单按 **🟢 运行中（进行中/待验收/受阻）/ ⚪ 待办 / ✅ 已完成** 分组（`GET /api/board?scope=` 按 `soldier=role` + `role=role` 过滤，roster 投影数据先展示后刷新）；点任务行 → 进入任务详情。
- 头部显示该角色**默认模型徽标**（若已配置）。

## 自动交接与持续执行（守护全自动流水线）

- **自动交接是默认行为（含写码）**：守护（scrum-worker）扫单后自动认领「依赖已解、未被拦截」的流水线任务并按岗位派 AI 执行；上一环验收 done 自动解锁下一环——需求→方案→拆解→用例→编码→审查→测试→部署整链无人值守流转。编码在隔离 worktree（`w/<id>`，pre-push 拦 push）进行，验收通过才合回主分支；每个任务停在 🟡 待验收等你对照 🎯 验收标准 + 📦 证据验收。
- **将军干预**：任务详情 / 调度台新增「🖐 拦截自动 / 🚀 放行」（`POST /api/hold {id, hold}`：拦截后守护不再认领/执行，直到放行）；「转派」同步 soldier 与 role 到目标岗位（流水线外岗位 = 人工托管）；↩ 打回重做附原因；CommandBar「⏸ 全部暂停」随时停。
- 侧栏「⚡ 持续执行编排」与「🤖 派 AI 执行」是另一条**执行守护（将军 agent 侧）**通道：`POST /api/exec` 开关按空间持久化；`GET /api/exec/queue?scope=` 列自动队列（`[auto-goal]` 链、非写码角色）；`POST /api/exec/request` 手动派活；`GET /api/exec/requests` 待消费请求。后台表：`exec_state`、`exec_requests`。

## 模型 × 智能体配置（底部「⚙️ 模型配置」）

- 底部命令栏「⚙️ 模型配置」（选中具体工作空间后可用）→ `ModelConfigModal`：每行一个智能体（角色），下拉选该角色的**默认模型**；未配置 = 平台默认（custom-ds / deepseek-v4-flash-openai）。
- 存储：team-hub `agent_models` 表（scope×role×provider×model），`GET/POST /api/models`、`POST /api/models/clear`（全部走审计）。
- 候选模型 = 本机 DSH 部署真实可用模型（`~/.dsh/settings.yaml` 的 provider.models），按省 token 档位分组：

  | 档位 | 模型 |
  | --- | --- |
  | ⚡ 轻量（省 token） | `custom-ds/deepseek-v4-flash-openai`、`zai-coding-cn/glm-5.3-flash`、`zai-coding-cn/glm-5-turbo` |
  | 🔶 均衡 | `custom-gpt/gpt-5.6-luna`、`gpt-5.6-terra`、`zai-coding-cn/glm-5.1` |
  | 🟣 旗舰/强推理 | `custom-ds/deepseek-v4-pro-openai`、`custom-gpt/gpt-5.6-sol`、`zai-coding-cn/glm-5.2` |
  | 👁 视觉 | `custom-ds/deepseek-v4-flash-vision-openai`、`zai-coding-cn/glm-5v-turbo` |

  典型省 token 策略：分析类（requirement/researcher/breaker）→ 轻量；写码/审查（coder/reviewer）→ 旗舰强模型；测试/运维 → 轻量或均衡。配置在 AI 执行该角色任务时被执行守护读取作为模型选择依据。

## 目录

```
workbench/
  src/
    api.ts            数据层：board/activity/config/missions + SSE 订阅 + 写接口 + team-hub 中枢（hub 探测/scopes/分区创建/exec/models/task/空间仓库配置 createSpace·updateSpaceConfig）
    missions.ts       任务集聚合视图（按角色泳道 + 状态统计，客户端兜底）
    components/
      Scene3D.tsx     中央 3D 办公场景（three + @react-three/fiber v9 + drei，懒加载 chunk；智能体可点击）
      Sidebar / KpiBar / CenterPanel / MissionPanel /
      ActivityFeed / QuickTools / CommandBar /
      TaskDetailModal     任务详情（AI 执行过程 / 时间线 / 验收 / 派 AI 执行）
      AgentTasksModal     智能体任务清单（运行中/待办/已完成 + 模型徽标）
      ModelConfigModal    模型×智能体配置（按角色选默认模型）
      SpaceSettingsModal  空间设置（名称 / 本地·私有 / 本地文件夹 + 远程仓库绑定）
      FolderPickerField   仓库绑定的「本地文件夹」字段（选文件夹 + git 探测 + 远程建议）
      FolderPickerModal   选文件夹弹窗（/api/fs 目录浏览，照搬 DSH 工作空间选目录）
      HubSchedulerModal / SchedulerModal / GoalModal / NewTaskModal / NewSpaceModal / Toast
  scripts/serve.mjs  生产静态服务（SPA 回退 + /hub 代理 + /api/fs 目录浏览/仓库探测，仅回环访问）
```

## 说明与边界

- 只读接口完全开放；写接口与 serve.mjs 的 `--token` 一致（Bearer / x-dsh-token / ?token）。
- 任务集（mission）= 按 `soldier`/role 聚合的任务泳道，命名优先 `/api/config` 的
  pipeline 中文标签，未匹配回退原始 role id；不改动 scrum 引擎数据模型。
- 中枢模式下 KPI/看板/动态仍来自 serve.mjs（v1 本地视图），任务集/空间/新建任务来自
  team-hub v2；两套数据源并存期间请只写其中一个（守护换 v2 后以 SQLite 为准）。
- 全局「全部暂停/继续」已真实接入（serve.mjs `/api/pause`/`/api/resume`）；「安排会议」待引擎。
