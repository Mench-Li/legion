<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-10-10**（w/T-196 HEAD `76839540`） 的基线，其中的 file:line、版本与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-196 方案研究：Agent 人性化名称 + 人性化头像（选型对比与推荐）

> 阶段：方案搜索（researcher）｜任务：T-196（[auto-goal]，所属目标 G-mv1s6y49-1 · software · chain）
> 上游需求：[REQUIREMENTS.md](./REQUIREMENTS.md)（T-195 产出，基线 w/T-195 HEAD `58172b9c`）→ 本文件 → 下游 breaker [TASK_BREAKDOWN.md](./TASK_BREAKDOWN.md)（T-197）→ T-198 → T-199 → T-200 → T-201 → T-202
> 评估基线：**w/T-196 HEAD `76839540`（2026-10-10 15:54:57 +0800）**；运行时 Node **v24.19.0**、Git **2.55.0.windows.5**（本 worktree 实测，§2.1）
> **边界声明**：本阶段**只做调研与选型对比**，不写实现、不改任何代码、不调用 taskctl/看板写接口、不 push。文中所有「落点建议」都是给 T-197/T-199 的输入，**不是已落地的实现**。
> **联网口径**：本阶段只**读取公开元数据页**（npm registry / GitHub API / jsDelivr 文件清单 / 项目官方文档）用于核验许可与维护度，**未下载、未安装任何依赖**；仓库纪律「禁止联网下载依赖」（LEGION.md）在本阶段未被触碰。

## 0. 结论速览（TL;DR）

**推荐：方案 A —— 自研「参数化人形内联 SVG 头像」+ 静态 `role → 头像位面` 一对一映射表；`roster.avatar` 沿用现有 TEXT 列，存稳定令牌 `human:<id>`。**
**名称：静态 `role → 展示名` 一对一表（两段式：拟人称呼 + 现有 kind 职能副标题），同样零新增依赖。**

一句话依据：头像这件事在本仓库要同时满足「**人形**（不可 emoji/首字）」「**离线**（禁联网）」「**零新增运行时依赖**（AC-R8-2 默认不批）」「**13 个展示面 + 3 个静态根**」「**确定性、无破图**」——只有**内联 SVG 由代码生成**这一形态同时满足全部五条（§3.1、§9）；本仓库已有三处同形态先例：`workbench/src/components/UiIcon.tsx:1-16`（内联 SVG，零依赖）、`workbench/mobile/make-icons.mjs`（产物可重现、不入库二进制）、`workbench/src/components/Employee3D.tsx:12-38`（canvas 程序化人形脸）。艺术质量是 A 的主要风险（§10 RK-A1），若将军判定 A 的观感不达标，再走**方案 B**（移植 DiceBear 的 CC0 风格，需将军放行一次性入库，§3.2）。

| 关键决策 | 推荐 | 主要备选 | 取舍理由（要点） |
| --- | --- | --- | --- |
| 头像**艺术来源** | **方案 A：自研参数化人形（与 3D 体素人形同一视觉语言）** | 方案 B：DiceBear **CC0** 风格（Pixel Art / Voxel Art，§3.2）／方案 C：构建期预生成资产库（§3.3） | A 零依赖、零联网、可逐面内联、可由测试断言；B 艺术质量最高但**需要一次性联网入库（违反 LEGION.md）→ 必须将军放行**，且新增约 0.5 MB 供应链面；C 只是载体变体，不解决「艺术从哪来」 |
| 头像**载体** | **内联 SVG（一个 React 组件供 13 面）** | 静态文件 `workbench/public/avatars/*.svg`（`<img>`） | 内联 SVG 不需要任何资源路径 ⇒ 天然满足「无破图（AC-R4-3）」，且**绕开多个静态根**（`workbench/dist` 与 `workbench/mobile`，§2.4）与 Service Worker 长缓存（RK-8）；静态文件需处理 404 回退与多根部署 |
| `roster.avatar` **数据形态** | **沿用 TEXT，语义改为稳定令牌 `human:<id>`**（不建新列、不改主键） | 存 SVG data URI（否决：体积大、无法断言唯一性）／新增 `avatar_kind` 列（否决：迁移面无收益） | 现列已是 TEXT（`team-hub/server.mjs:1328`），令牌最小编号；旧 emoji 值走统一回退（R-10 / O-5），不写坏数据 |
| 头像**唯一性机制** | **静态 `role → <id>` 一对一表（可证唯一）** | 由 `hash(role)` 生成特征（**否决：碰撞是概率性的**） | AC-R3-3 要求「同空间两两不同」且 O-4 要 ≥30 个位面；鸽巢意义上必须**构造上唯一**，哈希只能给概率。`identitySeed`（`sceneState.ts:49-53`）已存在，但它服务于 3D 外观，不要再叠一层 |
| 头像**确定性种子** | **按 `role` 取（不按 `scope+role`）** | 复用现有 `appearanceSeed = identitySeed(scope\0role)`（**否决：会使同 role 跨空间分叉，违反 AC-R5-1**） | 同一 role 可被复制进第二个空间（`agent-intake.mjs:145-168`），而 `/api/agents` 按 role **首见名胜**（`read-models.mjs:253-263`）⇒ 头像必须只由 role 决定 |
| 命名机制 | **静态 `role → 展示名` 一对一表 + 保留 kind 职能副标题（两段式）** | 程序化中文名生成库（否决：需联网、且生成质量不可审） | AC-R2-1（同空间唯一）+ AC-R5-1（跨空间同 role 一致）在「name 是 role 的单射函数」下**自动成立**；AC-R1-3 靠现有 kind 承载职能（`seed-roster.mjs:21-54` 已有职能短语） |
| 3D 场景联动（O-3） | **v1 不联动，只保证 3D 标签名称与 S1 一致** | 联动（否决：需改 `appearanceSeed` 口径，牵动 3D 视觉回归） | 与上游默认一致（REQUIREMENTS ❓O-3）；且 3D 外观种子与头像种子口径不同，联动等于把两件事绑死 |

## 1. 研究方法与证据分级

本阶段结论只用**可查证**来源，每条结论标注级别：

| 级别 | 含义 | 本文件用法 |
| --- | --- | --- |
| **A** | 本 worktree **实测可复现**（命令＋file:line） | 现状盘点、资源通道、可复用基座、渲染面清单 |
| **B** | 项目**官方文档**（DiceBear 官方站、其 JS 库文档） | 确定性 seed 语义、ESM/运行时要求、风格许可分组 |
| **C** | **npm registry / GitHub API / jsDelivr** 元数据（版本、许可、依赖、体积、星数、末次提交、下载量） | 第三方库的许可、成熟度、维护活跃度 |
| **D** | 厂商**自述**的对比页/营销表述（本阶段未独立复核） | 仅作背景与线索，**不作为选型依据** |

方法：
1. 逐条读上游 REQUIREMENTS.md（R-1~R-11、AC、D-*、O-*），抽出「留给 researcher」的开放点（载体、格式、生成算法、存储与迁移、13 面改造范围、命名可落地方案）。
2. 在本 worktree 做结构实测（glob/grep/read/命令行），**逐条复核上游 §2 的 file:line**，把漂移记录下来（§2.2 末）。
3. 对候选第三方库，取 npm registry + GitHub API + jsDelivr 文件清单的真实元数据（不引用营销数字）；官方文档仅用于语义（B 级）。
4. 关键外部数据在正文逐条附 URL 与抓取日期（§11）；厂商自述一律标 **D**。
5. 无法独立复核的项（A 的观感、B 的浏览器包体实测）明确列为**风险**，不写成结论（§10）。

## 2. 现状基线实测（证据级别 A）

### 2.1 版本与工具链

| 项 | 实测值 | 命令 |
| --- | --- | --- |
| 评估基线 HEAD | `76839540a6a611e8da0315f636b2499e68836de3`（2026-10-10 15:54:57 +0800） | `git log -1 --format=%H%x20%ci` |
| Node | v24.19.0 | `node --version` |
| Git | 2.55.0.windows.5 | `git --version` |
| workbench 运行时依赖 | 仅 5 个：`@react-three/drei`、`@react-three/fiber`、`react`(19)、`react-dom`(19)、`three`；dev 5 个 | `workbench/package.json`；`workbench/node_modules` 实测只有这 5 个包 + `.bin/.pnpm/.vite-temp` |
| 仓库内是否已有头像库 | **无**。`workbench/pnpm-lock.yaml` 中 avatar/dicebear/boring/jdenticon 命中 **0** 处；`.skills-cache` 之外无任何头像素材 | grep 计数 |
| 全仓 SVG 文件 | **3 个**，全部在 `.skills-cache/main/teamai-cli-main/assets/`（第三方技能缓存，**不属于本产品资产**） | `glob **/*.svg` |

> 结论：产品侧**没有任何头像素材库、也没有头像相关依赖**。这不是「还没加」，而是被两条纪律共同约束（禁联网下载依赖 + AC-R8-2 默认不批新增运行时依赖）。

### 2.2 数据面（谁存、存什么）

| 项 | 实测 | 证据 |
| --- | --- | --- |
| roster 表 | `(scope, role)` 主键；`name TEXT NOT NULL`、`kind TEXT DEFAULT ''`、`avatar TEXT DEFAULT '🤖'`、`sort INTEGER` | `team-hub/server.mjs:1322-1332`（avatar 在 :1328） |
| 写入口 1（入编/upsert） | 按 `(scope, role)` upsert name/kind/avatar；avatar 缺省 `'🤖'` | `team-hub/routes/agent-intake.mjs:82-86` |
| 写入口 2（选人入编） | 把全局目录某 role 的 name/kind/avatar **复制**进目标空间 ⇒ **同一 role 可存在多个 scope** | `team-hub/routes/agent-intake.mjs:145-168` |
| 写入口 3（种子） | `seed-roster.mjs` 幂等 upsert，**覆盖** name/kind/avatar/sort | `team-hub/scripts/seed-roster.mjs:66-69`（ROSTERS 表在 :19-55） |
| 注册表 | `agent_registry` 复制 roster 的 name/avatar，`ON CONFLICT(scope, role)` **只更新 name/avatar** | `team-hub/agent-conversations.mjs:61-64` |
| 读出口 A | `GET /api/roster`：roster 行 → agent 视图；缺省头像 `'🤖'`，外部执行者 `'⚙️'` | `team-hub/routes/team-views.mjs:84`、`:112-118` |
| 读出口 B | `GET /api/agents`：`ORDER BY role, scope` 后**按 role 去重、首见名胜**（首见 = scope 字典序最小者） | `team-hub/routes/read-models.mjs:253-263` |

> **上游 file:line 漂移（重要，breaker 别照抄）**：REQUIREMENTS.md 记的 `read-models.mjs:221-224`（按 role 首见名胜）在当前 `76839540` 上实际在 **:253-263**；上游记的 `team-views.mjs:73-117`、`server.mjs:1328`、`seed-roster.mjs:19-55` **仍然准确**。原因：上游基线是 `58172b9c`，本 worktree 是 `76839540`（期间 `read-models.mjs` 前面插入了新路由）。

### 2.3 渲染面逐面对账（13 面，实测 file:line）

| # | 展示面 | 实测位置 | 现状 | 与上游一致？ |
| --- | --- | --- | --- | --- |
| S1 | 人员目录列表行 | `workbench/src/components/WorkspaceNavigation.tsx:62`（`className="directory-avatar"` + `a.name.slice(0,1)`） | 名称首字文本 | ✅ |
| S2 | Agent 工作区头部 | `workbench/src/components/AgentWorkspace.tsx:111` | 名称首字文本 | ✅ |
| S3 | 中心面板 Agent 卡 | `workbench/src/components/CenterPanel.tsx:216`、`:236` | `{a.avatar}` 文本 | ✅ |
| S4 | 中心面板 v1 兜底 | `CenterPanel.tsx:21`（8 个**动物** emoji）、`:49`（`AVATARS[i % 8]`） | 第三套来源 | ✅ |
| S5 | 服务端兜底 | `team-views.mjs:84`（`'🤖'`）、`:117`（`'⚙️'`） | 文本 | ✅ |
| S6 | 3D 员工标签 | `Employee3D.tsx:122-128`（`Html` 标签只显示 name/状态/任务） | 无头像 | ✅ |
| S7 | 3D 人物外观 | `Employee3D.tsx:50`（`PALETTES[appearanceSeed % 6]`，6 色调色板 `:8`）、`sceneState.ts:69,75` | 与 avatar 无关 | ✅ |
| S8 | 场景 Agent 列表 | `workbench/src/components/SceneAgentList.tsx:15` | `{agent.avatar}` 文本 | ✅ |
| S9 | 新建空间选人 / 新建智能体 | `NewSpaceModal.tsx:12`（25 个 emoji `AVATAR_CHOICES`）、`:28`/`:64`（缺省 `'🤖'`）、`:182`、`:197-198`（`<select>`） | emoji 下拉 | ✅ |
| S10 | 模型设置成员行 | `ModelConfigModal.tsx:65`（投影 avatar）、`:122` | `{avatar}` 文本 | ✅ |
| S11 | 技能授权成员名 | `SkillsPanel.tsx:315-318`（`${a.avatar} ${a.name}`）、`:767`、`:786` | 拼成纯文本 | ✅ |
| S12 | 任务弹窗成员 | `AgentTasksModal.tsx:95` | `{agent.avatar}` 文本 | ✅ |
| S13 | 移动端 | `workbench/mobile/app.mjs:401-407`：`<option>` 的 `textContent = ${a.name}（${a.role}）` | **连头像插槽都没有** | ✅（并见下「未记录约束」） |

**CSS 载体（全部是文本徽章，无图片通道）——实测规则原文：**

| 类 | 实测规则 | 位置 |
| --- | --- | --- |
| `.agent-avatar` | `width/height:32px; border-radius:9px; display:flex; align-items:center; justify-content:center; font-size:14px; bg var(--panel-2); border 1px var(--line-2)` | `workbench/src/index.css:708-718` |
| `.directory-avatar` | `display:grid;place-items:center;border-radius:50%;width:37px;height:37px;flex-shrink:0;background:#e3e9f0;color:#5b748e;font-size:14px;font-weight:600`（另有 3 组空间配色变体、1 组 `30px/12px` 窄屏变体、1 组 `display:none`） | `workbench/src/workspace.css`（**压缩/长行文件**，全文 26,556 B，`.directory-avatar` 命中落在第 3/6/7 行，单行极长） |
| `.scene-agent-avatar` | `font-size:12px` | `index.css:845` |
| `.ao-avatar` | `font-size:14px` | `index.css:2548` |
| `.agent-tag-avatar` | `margin-right:3px;font-size:11px` | `index.css:1448` |

> **上游未记录、但影响拆解的实测发现（2 条）**：
> 1. **S13 的 `<option>` 无法承载图片**（HTML `<option>` 只渲染文本）。所以「移动端显示同一头像」（AC-R11-1）**必然要求改移动端交互结构**（自定义下拉/头部头像），这**不是**换个头像载体就能自动满足的。上游 §2.3 只记了「无头像」，未把它记成一条结构性约束。
> 2. `workbench/src/workspace.css` 是**压缩/长行文件**（26.5 KB，单行极长）——在它里面改 `.directory-avatar` 的样式必须整行处理，容易误伤。建议头像样式新增到可读的 `index.css` 或新文件。

### 2.4 资源通道（三个静态根 —— 决定了「静态资产」方案的迁移成本）

| 根 | 服务者 | 覆盖面 | 证据 |
| --- | --- | --- | --- |
| `workbench/dist`（Vite 产物；`public/` 会被原样拷入） | `workbench/scripts/serve.mjs`（默认 ROOT=dist，`DSH_WORKBENCH_ROOT` 可覆盖） | S1~S12（桌面指挥台） | `workbench/scripts/serve.mjs:59-62`；`workbench/vite.config.ts`（`outDir:'dist'`）；`workbench/public/` 实测**只有 `legion-icon.png`**，`workbench/index.html:7-8` 与 `Sidebar.tsx:87` 用 `%BASE_URL%` / `import.meta.env.BASE_URL` 引用它 ⇒ **`public/` 通道可用** |
| `workbench/mobile`（**独立根**） | team-hub `createMobileRoutes({ root: <ROOT>/workbench/mobile })`，挂载 `/mobile` | S13（手机端） | `team-hub/server.mjs:7701,7951`；`team-hub/routes/mobile.mjs:49-63`；移动端自有 `icon-192.png`/`icon-512.png` 与 `manifest.webmanifest`（相对 `./`）⇒ **静态头像若要覆盖 S13，必须往第二个根再部署一份** |
| `site/` | team-hub `routes/site.mjs`，**MIME 白名单** `.css/.png/.svg/.ico/.webmanifest/.txt`（**故意没有 `.html`**），`realpathSync` 复检防符号链接逃逸；图片缓存 1h、css 长缓存、其余 `no-store` | 产品站/下载页（**不在本目标 13 面内**） | `team-hub/routes/site.mjs:55-62`、`:376-399`、`:411-415` |

> 结论：**内联 SVG 载体天然只有一条通道**（组件代码），不需要往多个静态根各部署一份；静态文件载体则要同时解决「桌面 dist」「mobile 独立根」「404 回退」「SW 长缓存」四件事（§3.4）。

### 2.5 可复用基座（选型必须复用，避免另造）

| 基座 | 位置（w/T-196 `76839540`） | 对本方案的意义 |
| --- | --- | --- |
| **内联 SVG 组件先例（零依赖）** | `workbench/src/components/UiIcon.tsx:1-16`：`paths: Record<string, React.ReactNode>` 存 `<path>/<rect>/<circle>`，`<svg viewBox="0 0 24 24" stroke="currentColor" aria-hidden>` | 参数化人形头像**直接沿用这个形态**：数据表存人形部件、组件拼成 `<svg>`；零依赖、可被 `react-dom/server` 断言 |
| **程序化人形先例** | `Employee3D.tsx:12-24`（`faceTexture()`：canvas 8×8 画皮肤/眼/嘴）、`:26-38`（`shirtTexture()`）、`:8`（6 色调色板）、`:50`（`tone = PALETTES[appearanceSeed % 6]`）、`:99-103`（头/脸/发/眉的体素结构） | 人形**部件清单与配色体系已经存在**：肤色 `#e9bd93`、发色 `#28364b`、上衣 6 色、状态色。2D 头像应**复用同一套颜色常量与「体素/像素」视觉语言**，否则 2D 名册与 3D 场景会是两套脸 |
| **「产物可重现、不入库二进制」先例** | `workbench/mobile/make-icons.mjs:1-8`：注释明言「图标是**可重现的产物**，而不是源文件……零依赖：直接写 PNG」，全文用 `node:zlib` 的 `deflateSync` 手写 PNG（含 CRC32 表） | 方案 C 的现成范式：若要位图资产，用脚本生成 + 版本化；**同时它也是「不引入二进制资产」这条既有约定的证据** |
| **确定性哈希** | `sceneState.ts:49-53`（FNV-1a `identitySeed`）、`:69,75`（`key = ${scope}\0${role}`，`appearanceSeed = identitySeed(key)`） | 已有一个确定哈希可复用；但见 §0 决策表：**头像种子口径必须是 role 而非 scope+role**，且唯一性靠静态表而非哈希 |
| **纯逻辑单测范式（无 jsdom）** | `workbench/scripts/identity-gate.test.mjs:1-14` 明言指挥台**没有组件级测试环境**，因此用 `readFileSync + 正则` 读源码断言；`workbench/scripts/doc-render.test.mjs:11,46` 用 `react-dom/server` 的 `renderToString` 做**服务端渲染断言**（无需 jsdom） | 头像方案必须**可被这两种测试手段验证**：内联 SVG 组件 → `renderToString` 断言 `<svg>` 与部件差异；静态资产 → 只能断言文件存在/URL 拼接，**验不到「人形」** |

### 2.6 纪律与红线（不可违背，实测锚定）

| 约束 | 出处（实测） | 对选型的硬约束 |
| --- | --- | --- |
| 禁止联网下载依赖 | LEGION.md（派工注入）+ REQUIREMENTS §2.4/AC-R8-1 | 实现阶段**不能** `npm/pnpm install` 任何头像库；运行时也不得有外部请求 |
| 默认不新增运行时依赖 | REQUIREMENTS A-6 / AC-R8-2 | 新增依赖**必须将军批准**并写入本文件；默认假设是**不批** |
| 身份红线 | `docs/superpowers/specs/2026-10-01-agent-conversations-progress-design.md:81`：「名字、头像、模型和规则是**可变化属性，不能用来生成身份**」；`:79` 唯一约束 `(scope, rosterKey)`；`:83` 多实例启用前禁止「先复制两个头像，再继续用 role 归属」 | 头像**不得**进键/唯一约束/前端 key；不得用 avatar 区分多实例 |
| 界面规范已允许图片 | `docs/superpowers/specs/2026-10-02-legion-interface-design.md:140`：「**头像使用图片或名称首字**，不要求生成新品牌图标」；`:93` 每行含头像+名称+副标题；`:111` 顶部显示头像+名称 | 「图片形态」是设计已预留的形态，不需要为形态再走设计变更 |
| 不接受的形态 | REQUIREMENTS ⚖️D-2（倾向：不接受纯 emoji）、§5.2-4（不做 AI 生成/在线图床） | 候选必须排除 emoji、名称首字、几何色块、动物 emoji、在线 API |
| 头像库规模要求 | REQUIREMENTS ❓O-4（默认 ≥30 张且互不撞脸，覆盖 25 岗位 + 自建余量） | 方案必须能构造 **≥30 个互不重复的人形位面** |

## 3. 候选方案

### 3.1 方案 A（推荐）：自研参数化「人形内联 SVG」头像

**形态**：在 `workbench/src/` 下新增一个**头像组件 + 一张静态位面表**。位面表把「人形特征」写成数据（如 `{ skin, hair, hairColor, top, accessory, glasses, beard }`），组件把数据渲染成 `<svg viewBox="0 0 32 32">`；`roster.avatar` 存**稳定令牌** `human:<id>`，由**唯一解析函数**把令牌映射到位面（`role` 与 `<id>` 一对一，§9）。

- **艺术遗产复用**：肤色/发色/上衣 6 色/体素结构直接对齐 `Employee3D.tsx:8,12-38,99-103`，保证 2D 名册与 3D 场景是「同一支军队」的视觉语言。
- **规模构造**：位面空间需按构造保证 ≥30 个互异组合（例：皮肤 6 × 发型 8 × 配饰 4 × 上衣 6 ≫ 30），但**实际选用必须人工审定**（见 RK-A1）。
- **唯一性与确定性**：唯一性由**静态表**保证（可写断言）；确定性天然成立（无随机、无时间、无设备相关量）。
- **与 13 个面的对接**：一个组件 + 一个 CSS 类替换现有文本徽章；S1/S2 目前误用首字（`WorkspaceNavigation.tsx:62`、`AgentWorkspace.tsx:111`）改为同一组件；S4 的动物兜底表删除（AC-R4-1）。
- **回退（R-9）**：令牌无法解析或组件抛错时，渲染**确定性的灰阶占位人形**（同一组件），而不是首字或 emoji——因为在本载体下**没有网络请求，「破图」不成立**。

### 3.2 方案 B：移植 DiceBear 的 **CC0** 风格（Pixel Art / Voxel Art）

DiceBear 是同领域最成熟的开源头像库；**软件本体 MIT、每个风格由画师各自选许可**（B/C 级，§11 引用 1~4）。真正与「人形 + 可商用无归属义务」同时匹配的是其 **CC0 1.0 的 42 个风格**，其中最贴合本仓库像素/体素语言的两个：

| 风格 | 形态（官方描述） | 许可 | 定义文件（单风格） |
| --- | --- | --- | --- |
| **Pixel Art** | 「low-resolution vector avatar style that renders **half-body characters** as crisp pixel sprites with retro hairstyles, eyes, and colored tops」 | **CC0 1.0**（作者 DiceBear；Figma 源亦为作者本人） | `dist/pixel-art.min.json` = **44,813 B** |
| **Voxel Art** | 「blocky vector avatar style that stacks small 3D cubes into **full-body characters** with hair, outfits, glasses, and beards」 | **CC0 1.0**（作者 DiceBear） | `dist/voxel-art.min.json` = **138,196 B** |
| Pixel Art Neutral | Pixel Art 的中性变体 | CC0 1.0 | `dist/pixel-art-neutral.min.json` = **16,001 B** |

**集成方式（v10 官方 JS 库）**：需 `@dicebear/core`（MIT、**零依赖**、纯 ESM、浏览器/Node≥22/构建期均可） + `@dicebear/styles`（定义文件包，**按风格各自许可**）；用法 `new Style(def)` + `new Avatar(style,{seed}).toString()`，**同 seed 恒得同一头像**（B 级，§11 引用 4）。

- **优点**：艺术质量与多样性有专业保障；CC0 无归属义务；体素/像素风格与现有 3D 人形**天然同调**；确定性 seed 是官方一等公民；库活跃（GitHub 9,819★、末次提交 2026-09-28、0 open issues）。
- **缺点/风险**：
  1. **必须一次性联网入库**（`npm install @dicebear/core @dicebear/styles`）⇒ **直接违反 LEGION.md 的禁联网纪律**，必须将军**明确放行**；AC-R8-2 也要破例记录。
  2. 供应链面新增约 **0.5 MB**（core unpacked 461,015 B）+ 单风格 44 KB；若整包 `@dicebear/styles` 入库则是 **7,745,477 B / 126 files**（**不推荐整包**，只取单风格 JSON）。
  3. 学习成本：要理解 DiceBear **definition schema 1.4**（`canvas.elements` / `components` / 变体权重）；虽然 v10 的 JSON 是**声明式**的（理论上可自写渲染器），但**自写渲染器不是小工作量**。
  4. 风格 JSON 的 `meta.license` 已内嵌 CC0 声明（机器可读）——保留它即可满足合规留痕；但若改用 CC BY 4.0 风格（Adventurer / Micah / Personas / Miniavs / Croodles / Toon Head / Dylan / Big Ears / Big Smile / Fun Emoji / Glyphs），则**产生强制归属义务**，这是最容易踩的坑。
  5. 浏览器包体未实测（本阶段禁联网安装）⇒ 列为不确定项（§10 RI-B1）。
  6. **9.x 与 10.x 是两代结构**：9.x 是逐风格 npm 包（可从 `@dicebear/collection@9.4.2` 的 dependencies 看到 31 个 `@dicebear/<style>@9.4.2`），10.x 收敛成 `@dicebear/core` + `@dicebear/styles` 的 JSON 定义；用旧代会出现「文档与实现不同代」的维护陷阱。

### 3.3 方案 C：构建期预生成静态 SVG/PNG 资产库（载体变体）

用 `node` 脚本（沿用 `make-icons.mjs` 的零依赖形态）在**构建期/提交前**生成 `workbench/public/avatars/<id>.svg`（或 PNG），运行时 `<img src="%BASE_URL%avatars/<id>.svg">`。

- **注意**：C **不解决「艺术从哪来」**——它必须与 A 或 B 组合（A 提供部件、C 提供离线烘焙；或 B 提供定义、C 先在构建期把 25~30 个种子烘焙成静态文件，从而**运行时零依赖**）。
- **优点**：运行时零渲染成本；移动端/3D 标签可以用同样的 URL；容易做「一张图一眼看全 25 个头像」的评审材料。
- **缺点**：**多个静态根要分别覆盖**（`workbench/dist`、`workbench/mobile`，§2.4）；必须实现 404 回退（R-9/AC-R9-1）；Service Worker 对图片走 `cacheFirst`（RK-8）会残留旧图；**测试只能断言文件/URL，无法断言「人形」**（§2.5）；仓库已有「资产应为可重现产物」的明示例（`make-icons.mjs:4`），入库二进制与既有倾向相反。

### 3.4 载体横向对比（A/B 共用）

| 维度 | 内联 SVG（推荐） | 静态 `.svg` 文件 | 静态 `.png` 文件 |
| --- | --- | --- | --- |
| 新增部署点 | **0** | 桌面 dist + mobile 根（2 处） | 同上 + 需多倍图/尺寸 |
| 破图风险（AC-R4-3） | **无**（无请求） | 有（需 `onerror` 回退） | 有 |
| SW 长缓存残留（RK-8） | **无** | 有（图片 1h~cacheFirst） | 有 |
| 可测性（§2.5） | **`renderToString` 可断言部件/URL** | 只能断言文件存在 | 同左 |
| 缩放/清晰度 | 矢量任意尺寸 | 矢量任意尺寸 | 32px 需专门导出 |
| 运行时成本 | 每头像一个 `<svg>` 子树（25~30 面，可忽略） | 图片解码 | 图片解码 |
| 能否用在 3D 标签（S6）内 | 是（`Html` 内是普通 DOM） | 是 | 是 |

## 4. 对比矩阵（优点 / 缺点 / 成本 / 风险）

| 项 | 方案 A：自研参数化内联 SVG | 方案 B：DiceBear CC0（Pixel/Voxel Art） | 方案 C：构建期静态资产库 |
| --- | --- | --- | --- |
| 满足「人形」（AC-R3-1/2） | 取决于自绘质量（**主要风险**） | **强**（专业画师作品） | 取决于 A/B 的艺术来源 |
| 离线自足（AC-R8-1） | ✅ 天然满足 | ⚠️ 运行时离线，但**入库需一次性联网** | ✅ 运行时离线 |
| 零新增运行时依赖（AC-R8-2） | ✅ **0** | ❌ 需 `@dicebear/core`（+ styles），**须将军批准** | ✅ 0（运行时） |
| 唯一性可证明（AC-R3-3） | ✅ 静态表断言 | ✅ 可断言（不同 seed / 校验产物） | ✅ 可断言文件集 |
| 确定性（AC-R3-4） | ✅ | ✅ 官方语义保证（B 级） | ✅ |
| 覆盖 13 面 | ✅（一个组件） | ✅ | ⚠️ 需覆盖多个静态根 |
| 无破图（AC-R4-3） | ✅ 最优 | ✅ | ⚠️ 需回退实现 |
| 一次落地成本 | 中（自绘部件 + 表 + 13 面接入） | 低~中（接库 + 接面），但**多一道审批门** | 中（生成脚本 + 多根部署 + 回退） |
| 长期维护成本 | 自持（无上游版本） | 跟上游（10.x → 后续 major 可能破坏；styles 已拆成独立包/仓库） | 自持 + 产物再生成 |
| 供应链/许可风险 | **无** | 许可分级复杂（CC0 安全 / CC BY 4.0 需归属 / 艺术家属自定条款） | 继承 A/B |
| 对 O-4（≥30 互异）的把握 | 需人工审定位面表 | 强（风格变体极多） | 同 A/B |
| 与既有视觉语言一致性 | **最强**（复用 3D 配色/体素） | 强（Voxel Art 尤其） | 同 A/B |
| 可回归性 | 最好（`renderToString` + 源码扫描） | 中（需断言库调用/产物） | 差（只能断言文件） |
| 综合 | **推荐（v1）** | **备选/升级路径（需将军放行）** | 载体备选（与 A 组合） |

## 5. 评估后否决的候选（含真实数据，避免「潮流方案」）

| 候选 | 真实元数据（C 级，2026-10-10 抓取） | 否决理由 |
| --- | --- | --- |
| **纯 emoji / 拟人 emoji** | — | 现状已 25/25 是 emoji（REQUIREMENTS §2.2）；⚖️D-2 倾向明示不接受 |
| **名称首字** | — | AC-R3-1 明示不接受（设计规范 `:140` 也只把它列为**回退**） |
| **boring-avatars**（几何/渐变） | v2.0.4、MIT、**零依赖**、unpacked 28,669 B、peer `react>=18`/`react-dom>=18`；GitHub 6,449★、末次提交 2026-06-19；npm 周下载 651,045 | 生成的是**抽象几何/渐变**（官方描述「round avatars from any username and color palette」），**不是人形** ⇒ 直接违背 AC-R3-2 |
| **jdenticon**（identicon） | v3.3.0、MIT、依赖 `canvas-renderer ~2.2.0`、unpacked 721,184 B；GitHub 1,752★、末次提交 **2024-05-10**、3 open issues；周下载 116,893 | 几何 identicon，非人形；且引入传递依赖 + 上游已 2 年多无提交 |
| **avataaars（npm 组件）** | v2.0.0、MIT、依赖 **lodash + prop-types**、peer **`react ^17.0.0`**、unpacked 1,062,097 B；GitHub 843★、末次提交 2024-03-04、**33 open issues** | peer 版本与本仓 **React 19** 冲突；带 lodash 等传递依赖；上游停滞、issue 积压 ⇒ 与「零新增依赖 + 成熟维护」双违背。（注：**DiceBear 的 Avataaars 风格**是另一条路，但其许可属「艺术家属自定条款（free for personal and commercial use）」而非标准 OSI 许可，优先级低于 CC0） |
| **Multiavatar** | npm `@multiavatar/multiavatar` v1.0.7、license **「SEE LICENSE IN LICENSE」（非 OSI）**、零依赖、unpacked **2,785,173 B**；GitHub 1,971★、末次提交 **2022-03-26**、license `NOASSERTION` | LICENSE v1.0 明文 **Restrictions**：「不得复制类似或竞争产品/服务」「不得重新打包或改品牌」「必须作为你产品的**附加**而非产品本身」——对本产品是**法务不确定性**；且上游 4 年多无提交。虽然人形与确定性都满足，仍不推荐 |
| **Gravatar / 在线头像 API / DiceBear HTTP API** | 其官方 HTTP API 免费（**D 级自述**） | 需要**出网**（AC-R8-1 断网 0 外部请求）；且把头像可用性绑到第三方 |
| **AI 生成人像 / 在线图床 / 上传裁剪** | — | REQUIREMENTS §5.2-4 明确排除；⚖️D-5 倾向 v1 不做 |
| **新建 `avatar_kind` 列 / 存 SVG data URI** | — | 列已是 TEXT（`server.mjs:1328`）；data URI 体积大、无法断言唯一性、会让 3 个写入口（`agent-intake.mjs:82-86`、`:161-163`、`seed-roster.mjs:66-69`）都要改语义 |

## 6. 新引入技术/依赖逐项影响（许可 / 维护 / 学习成本 / 生态）

### 6.1 方案 A 实际新引入的「技术」（无外部依赖）

| 引入项 | 许可 | 维护 | 学习成本 | 生态/风险 |
| --- | --- | --- | --- | --- |
| 自研参数化人形 SVG 组件（新增 `workbench/src/components/AgentAvatar.tsx` 一类文件，命名由 coder 定） | 自有代码，无第三方许可 | 自持；无上游版本漂移 | 低：形态与 `UiIcon.tsx:1-16` 同构（数据表 + `<svg>`） | 无供应链面；风险是**观感**（RK-A1）与位面表可维护性 |
| 静态 `role → <id>` 位面表 + 令牌解析函数 | 自有代码/数据 | 自持；新增 role 时要补一行 | 低 | 需与 `seed-roster` 的 25 个 role 保持同步（建议加「表长度 == roster role 数」断言） |
| `react-dom/server` 的 `renderToString` 测试 | 已在本仓使用（`doc-render.test.mjs:11`） | 随 React 19 | 低（已有先例） | **不新增依赖** |

### 6.2 方案 B 若被放行，则逐项如下

| 包 | 许可（C 级实测） | 维护活跃度（C 级实测） | 体积/依赖 | 学习成本 | 生态 |
| --- | --- | --- | --- | --- | --- |
| `@dicebear/core` | **MIT** | GitHub `dicebear/dicebear`：**9,819★ / 424 fork / 0 open issues**，末次提交 **2026-09-28**，创建 2017-03-21，未归档；npm 最新 **v10.7.0**；周下载 **490,294** | **零 dependencies**；unpacked **461,015 B / 69 files**；**纯 ESM** | 中：`new Style(def)` + `new Avatar(style,{seed}).toString()`；需理解 schema 1.4 与「同 seed 恒同像」 | 官方支持 JS/TS、PHP、Python、Rust、Go、Dart、C#（**D 级自述**）；有 React/RN/Vue/Svelte/Angular 接入文档；**纯 ESM** 与 Vite 7 兼容 |
| `@dicebear/styles`（**只取单风格**） | 包级 `license: SEE LICENSE IN LICENSE.md`；**逐风格不同**（CC0 42 / CC BY 4.0 14 / MIT 1 / 艺术家属自定 4） | 独立仓库 `dicebear/styles`：10★、末次提交 2026-09-27、license `NOASSERTION` | 包 unpacked **7,745,477 B / 126 files**；**只需 `dist/pixel-art.min.json` 44,813 B**（或 voxel-art 138,196 B） | 低（当作静态 JSON 资源） | 定义文件自带 `meta.license`（机器可读 CC0 声明），合规留痕容易 |
| （不推荐）9.x 代的逐风格包 | `@dicebear/collection@9.4.2` 为 MIT，但 dependencies 里挂了 **31 个** `@dicebear/<style>@9.4.2` | 官方现行版本为 **10.x**（站点页脚：Versions 10.x(current) / 9.x） | 整包会拖入全部风格 | — | 会造成「文档与实现不同代」的维护陷阱 |

> **B 的合规红线（务必写进任务）**：只用 **CC0** 风格（Pixel Art / Voxel Art / Pixel Art Neutral）；**不得**引入 CC BY 4.0 风格（否则强制归属）；**不得**引入 Avataaars / Bottts（艺术家属自定条款）；引入时**保留** JSON 内 `meta.license` 与 `@dicebear/core` 的 MIT 许可声明。

### 6.3 方案 C 若采用

| 引入项 | 许可 | 维护 | 学习成本 | 生态 |
| --- | --- | --- | --- | --- |
| 构建期资产生成脚本（`node:zlib` 手写 PNG / 或直接写 SVG 文本） | 自有代码 | 自持；产物需再生成 | 低（`make-icons.mjs` 已有完整 CRC32 + deflate 的 PNG 写法可抄） | 无新依赖；但**产物入库**与「可重现产物」的既有倾向相反（`make-icons.mjs:4`） |

## 7. 名称方案（需求的后半段，同样零依赖）

**结论：静态 `role → 展示名` 一对一表 + 保留现有 `kind` 作职能副标题（两段式），不引入任何命名库。**

- **为什么一对一表就够**：
  - AC-R2-1（同空间不重名）：同空间内 role 互不相同，而 `name` 是 role 的**单射函数** ⇒ **同空间必然唯一**。
  - AC-R5-1（跨空间同 role 名称一致）：`name` 只由 role 决定 ⇒ **恒一致**，且 `/api/agents` 的「首见名胜」合并（`read-models.mjs:253-263`）不再有漂移源。
  - AC-R1-3（仅凭 name + kind 能匹配回 role）：职能由 **kind** 承载——现有 25 个 kind 已是职能短语（`seed-roster.mjs:21-54`，如「需求澄清与拆解」「技术选型与搜索」），不必塞进名字。
- **命名规则（给 T-199 的输入，不是最终名单）**：
  1. `name` 取 **2 个汉字**（落在 AC-R1-1 的 2~6 区间，且不含 `a-z0-9-_` 机器键字符集）；
  2. 名字尽量取**与该岗位动作同源的汉字**，读起来像对人的称呼、又不与职能完全脱钩（例：`requirement`→「析言」、`researcher`→「甄源」、`reviewer`→「核明」——**这三个只是规则示例，不是名单**）；
  3. **25 个 role 必须给出 25 个互不相同的名字**（断言 `COUNT(DISTINCT name) == COUNT(DISTINCT role)`）；
  4. 最终名单按 **O-1** 由 coder 出草案、将军确认（本阶段不代将军拍板名单）。
- **不推荐的替代**：程序化中文名生成（需引入库/数据 → 违反禁联网；且生成质量不可审，容易产出「不像对人的称呼」的名字，正好撞上 AC-R1-2 的人工判据）。

## 8. 数据形态与迁移建议（`roster.avatar`）

| 问题 | 建议 | 理由/证据 |
| --- | --- | --- |
| 列形态 | **保持 `avatar TEXT`**，语义从「单字符 emoji」改为「头像引用令牌 `human:<id>`」 | 现列已是 TEXT（`server.mjs:1328`）；改列会牵动 3 个写入口（`agent-intake.mjs:82-86`、`:161-163`、`seed-roster.mjs:66-69`）与 2 个读出口（`team-views.mjs:84,114`、`read-models.mjs:256-262`）+ `agent_registry` 复制（`agent-conversations.mjs:61-64`） |
| 令牌格式 | `human:<id>`（`<id>` 取位面表键，与 role 一对一） | 人类可读、可 SQL 断言、可做唯一性检查；不用 data URI（体积 + 无法断言） |
| 旧值处置 | **不删除、不猜测**：任何非 `human:*` 的值（emoji、空、`⚙️`）一律走**统一回退渲染**（灰阶占位人形），迁移时**备份原值**（REQUIREMENTS O-5 要求公示） | RK-1；AC-R9-2（回退不落库） |
| 迁移脚本 | 幂等、按 role 生成令牌；**不得覆盖**用户显式改过的值（R-10 / AC-R10-1） | 现 `seed-roster` 是**无条件覆盖**（`seed-roster.mjs:68`）⇒ 迁移必须先解决「默认值 vs 自定义值」的判定（建议只覆盖「旧默认值白名单」，如 `'🤖'` / 空 / legacy emoji 集） |
| 唯一性校验 | 断言 `SELECT role, COUNT(DISTINCT avatar) FROM roster GROUP BY role` 恒为 1，且**跨 role** 的头像集合大小 == 位面表大小（覆盖 25 + 自建余量，O-4 ≥30） | AC-R5-1、AC-R3-3 |
| 前端 key | 继续用 `scope + role`（`sceneState.ts:69` 的 `key`），**avatar 不进 key** | 身份红线 `design:81`；AC-R2-3 |

## 9. 推荐落点（给 T-197 breaker / T-199 coder 的输入，非实现）

1. **单一解析函数**：`avatar 令牌 → 位面` 只允许一处实现（建议 `workbench/src/` 下的纯函数 + 组件），13 个面全部经它取值；S4 的 `AVATARS`（`CenterPanel.tsx:21`）与 S1/S2 的首字用法**删除**（AC-R4-1 / AC-R4-4）。
2. **数据只带令牌**：位面表是唯一真源；`role → <id>` 一对一，跨空间同 role 恒同像（AC-R5-1）。
3. **一个组件覆盖桌面各面**：替换文本徽章；CSS 新增独立类（**不要改压缩行 `workspace.css`**，建议落 `index.css` 或新文件）。
4. **S13（mobile）单独切片**：`<option>` 装不下图片（§2.3 发现 1），必须改交互结构（自定义下拉或头部头像）——建议 breaker 把它**单列一个任务/成本项**，不要混在「换头像」里。
5. **测试落点**（沿用既有范式，§2.5）：
   - `renderToString(AgentAvatar)`：断言输出含 `<svg>`（**不是单个 Unicode 字符文本节点**，AC-R3-1）、断言 25 个位面两两不同、断言同 token 两次渲染结果一致（AC-R3-4）；
   - 源码扫描断言（仿 `identity-gate.test.mjs`）：`CenterPanel.tsx` 不再有 `AVATARS` 动物表、`AgentWorkspace.tsx`/`WorkspaceNavigation.tsx` 不再对 name 取首字、avatar 不出现在任何 key/唯一约束中（AC-R2-3、AC-R4-1）；
   - `seed-roster` 幂等 + 不覆盖自定义（AC-R7-3、AC-R10-1）。
6. **不要动的东西**：`role` 机器键、`appearanceSeed = identitySeed(scope\0role)`（`sceneState.ts:75`）与 3D 人物外观（O-3 默认不联动）、`agentId`/`rosterKey` 语义。
7. **依赖口径**：v1 落地**新增运行时依赖 = 0**（AC-R8-2 通过）；若最终选 B，需先有将军的书面放行。

## 10. 风险与不确定项

| 编号 | 风险/不确定 | 影响 | 缓解 |
| --- | --- | --- | --- |
| **RK-A1** | 方案 A 的**观感**是否达到「人性化、能看出是人形」（AC-R3-2 人工判据 ≥4/5）——本阶段**未做视觉样张**，无法预判 | 若判不达标，需返工或升级到 B | 先出 **2~3 张 32px 样张**给将军预审（放在 T-199 早期，而不是全部接完 13 面再评审）；样张不达标就走 B（需放行） |
| **RK-A2** | 2D 头像与 3D 人物外观是两套绘制代码，可能视觉打架 | 观感不一致，评审争议 | 复用 `Employee3D.tsx:8,99-103` 的**颜色常量与体素结构**，并写进实现约定 |
| **RI-B1** | 若选 B：`@dicebear/core` 的**浏览器包体**未实测（本阶段禁联网安装） | 可能影响首屏 | 实施时先跑 bundle 分析；必要时改为方案 C（构建期烘焙成静态文件，运行时零依赖） |
| **RI-B2** | 若选 B：`@dicebear/styles` 包级许可是「SEE LICENSE IN LICENSE.md」，**逐风格不同** | 误选 CC BY 4.0 风格会产生强制归属义务 | 只用 CC0 风格；把风格页 LICENSE 段与 JSON 内 `meta.license` 一起留痕（§11 引用 2、3） |
| **RI-B3** | 若选 B：v10 是**纯 ESM**，且 styles 已从主仓拆到独立仓库/独立包 | 版本升级与仓库分裂带来的维护面 | 锁版本 + 只取单风格 JSON；跟踪 10.x → 11.x 的 breaking |
| **RK-1**（承上游） | `avatar` 是单字符 TEXT，图片形态需改数据语义 | 迁移复杂 | §8 的令牌方案：不改列、不改主键、统一回退 |
| **RK-2**（承上游） | `seed-roster` 无条件覆盖 name/avatar（`seed-roster.mjs:68`） | 用户自定义被回滚 | R-10；迁移只覆盖「旧默认值白名单」 |
| **RK-8**（承上游） | Service Worker 对图片走 cacheFirst（`workbench/mobile/sw.js`） | 旧头像残留 | **内联 SVG 载体天然规避**（无图片请求） |
| **RK-M1**（本阶段发现） | S13 用 `<option>` 渲染成员（`mobile/app.mjs:401-407`） | 「移动端同一头像」无法靠换载体自动满足 | 单列切片，改交互结构（§9 第 4 条） |
| **RK-W1**（本阶段发现） | `workbench/src/workspace.css` 是压缩/长行文件（26.5 KB） | 在该文件做样式手术易误伤 | 头像样式落 `index.css`/新文件（§9 第 3 条） |
| **RK-R1** | 「人性化」是主观判据（承上游 RK-7） | 验收争议 | 保留 AC-R1-2/AC-R3-2 抽检 + O-1 名单确认；把样张预审前移 |

## 11. 引用来源（可查证）

**本仓库（A 级，均在本 worktree `76839540` 实测）**：`team-hub/server.mjs:1322-1332,7701,7951`、`team-hub/scripts/seed-roster.mjs:19-69`、`team-hub/routes/agent-intake.mjs:82-86,145-168`、`team-hub/routes/team-views.mjs:84,112-118`、`team-hub/routes/read-models.mjs:253-263`、`team-hub/agent-conversations.mjs:61-64`、`team-hub/routes/site.mjs:55-62,376-399,411-415`、`team-hub/routes/mobile.mjs:49-63`、`workbench/src/components/` 下的 `WorkspaceNavigation/AgentWorkspace/CenterPanel/SceneAgentList/ModelConfigModal/SkillsPanel/AgentTasksModal/NewSpaceModal/Employee3D/UiIcon` .tsx、`workbench/src/scene/sceneState.ts:49-53,69,75`、`workbench/src/index.css:708-718,845,1448,2548`、`workbench/src/workspace.css`、`workbench/scripts/identity-gate.test.mjs`、`workbench/scripts/doc-render.test.mjs:11,46`、`workbench/scripts/serve.mjs:59-62`、`workbench/vite.config.ts`、`workbench/mobile/make-icons.mjs`、`workbench/mobile/app.mjs:401-407`、`workbench/mobile/manifest.webmanifest`、`docs/superpowers/specs/2026-10-01-agent-conversations-progress-design.md:79-83`、`docs/superpowers/specs/2026-10-02-legion-interface-design.md:93,111,140`、`docs/G-mv1s6y49-1/REQUIREMENTS.md`、`LEGION.md`。

**外部（C 级 = registry/API 元数据，B 级 = 官方文档；抓取日期均为 2026-10-10）**：

1. DiceBear 许可总览（B）：https://www.dicebear.com/licenses/ —— 软件本体 MIT（`dicebear/dicebear`，Copyright Florian Körner）；风格分四档：**CC0 1.0（42 个**，含 Pixel Art / Pixel Art Neutral / Voxel Art / Voxel Bot / Notionists / Open Peeps / Lorelei / Initial Face / Thumbs 等）、**CC BY 4.0（14 个**，含 Adventurer / Micah / Personas / Miniavs / Croodles / Toon Head / Dylan / Big Ears / Big Smile / Fun Emoji / Glyphs）、**MIT（1 个**，Icons，基于 Bootstrap Icons）、**艺术家属自定条款（4 个**，Avataaars / Bottts，Pablo Stanley，「free for personal and commercial use」）。
2. DiceBear 风格页「Pixel Art」（B）：https://www.dicebear.com/styles/pixel-art/ —— 「**half-body characters** as crisp pixel sprites」；**License: CC0 1.0**（Creator: DiceBear）；定义文件 URL `https://cdn.hopjs.net/npm/@dicebear/styles@10.6.0/dist/pixel-art.min.json`。
3. DiceBear 风格页「Voxel Art」（B）：https://www.dicebear.com/styles/voxel-art/ —— 「**full-body characters** with hair, outfits, glasses, and beards」；**License: CC0 1.0**；定义文件 `.../dist/voxel-art.min.json`。
4. DiceBear JavaScript 库文档（B）：https://www.dicebear.com/how-to-use/js-library/ —— 「written in **TypeScript**」；「Both packages are **pure ESM**」；浏览器 / **Node.js（version 22 or higher）** / **构建期**均可；「**The same seed will always produce the same avatar**」（确定性）；需 `@dicebear/core` + `@dicebear/styles`。
5. DiceBear「vs. alternatives」对比页（**D 级，厂商自述**）：https://www.dicebear.com/understand/dicebear-vs-alternatives/ —— 61 styles、Dependencies「–」、Deterministic，及与 Boring Avatars / Avvvatars / Multiavatar / Jdenticon 的横向表（**本文件仅作线索，关键数字已用 GitHub API 复核**）。
6. npm registry 最新版本元数据：`https://registry.npmjs.org/@dicebear/core/latest`（v10.7.0、MIT、**dependencies = {}**、unpacked 461,015 B / 69 files）；`.../@dicebear/styles/latest`（v10.6.0、`SEE LICENSE IN LICENSE.md`、0 deps、7,745,477 B / 126 files）；`.../boring-avatars/latest`（v2.0.4、MIT、0 deps、peer react>=18、28,669 B）；`.../jdenticon/latest`（v3.3.0、MIT、dep `canvas-renderer ~2.2.0`、721,184 B）；`.../avataaars/latest`（v2.0.0、MIT、deps lodash+prop-types、**peer react ^17.0.0**、1,062,097 B）；`.../@multiavatar/multiavatar/latest`（v1.0.7、`SEE LICENSE IN LICENSE`、0 deps、2,785,173 B）；`.../@dicebear/collection/latest`（v9.4.2、MIT、deps 为 31 个 `@dicebear/<style>@9.4.2`，unpacked 19,148 B）。
7. jsDelivr 文件清单 API：`https://data.jsdelivr.com/v1/packages/npm/@dicebear/styles@10.6.0` —— 126 个文件；`dist/pixel-art.min.json` **44,813 B**、`dist/voxel-art.min.json` **138,196 B**、`dist/pixel-art-neutral.min.json` **16,001 B**。
8. GitHub API：`api.github.com/repos/dicebear/dicebear`（9,819★ / 424 fork / 0 open issues / MIT / pushed_at 2026-09-28 / created 2017-03-21）；`/repos/dicebear/styles`（10★、pushed_at 2026-09-27、`NOASSERTION`）；`/repos/boringdesigners/boring-avatars`（6,449★、2026-06-19）；`/repos/dmester/jdenticon`（1,752★、2024-05-10、3 open issues）；`/repos/fangpenlin/avataaars`（843★、2024-03-04、33 open issues）；`/repos/multiavatar/Multiavatar`（1,971★、**2022-03-26**、`NOASSERTION`）。
9. Multiavatar LICENSE v1.0 全文（B/C）：https://raw.githubusercontent.com/multiavatar/Multiavatar/main/LICENSE —— Restrictions：「does not include the right to replicate a similar or competing product/service」「not allowed to re-package the existing set of avatar designs, or re-brand it」「should always be treated as an addition to your product, but not as the product on its own」。
10. npm 下载量 API：`https://api.npmjs.org/downloads/point/last-week/<pkg>`（2026-10-02 ~ 2026-10-08）：`@dicebear/core` 490,294；`boring-avatars` 651,045；`jdenticon` 116,893。

## 12. 本阶段自检（逐条对应任务验收标准）

| 验收标准 | 对应章节 | 结论 |
| --- | --- | --- |
| 方案覆盖需求要点，给出 **≥2 个候选方案对比（优缺点/成本/风险）** | §3（A/B/C 三个候选 + 载体横向）+ §4 对比矩阵 | ✅ 3 个候选、14 个维度对比；R-1~R-11 的硬约束逐条映射 |
| **明确推荐与理由**，依据为**真实可查来源并注明引用** | §0 推荐（A）+ §3.1 + §11（外部 10 条 + 仓库 30 余处 file:line，附抓取日期与分级） | ✅ 每条外部数据可回溯到 URL/API；厂商自述标 D 级不作依据 |
| **新引入技术/依赖逐项说明影响（许可/维护/学习成本/生态）** | §6（A 的 3 项、B 的 2 个包 + 9.x 旧代、C 的 1 项，逐项四维） | ✅ 许可有 MIT / CC0 / CC BY 4.0 / 自定条款四档结论；维护有星数/末次提交/下载量；体积有 unpacked 与单文件字节数 |
| **方案结论可直接支撑后续任务拆解** | §8（数据形态与迁移）+ §9（落点 7 条）+ §10（风险 11 条） | ✅ 含 2 条上游未记录、会影响拆解规模的实测发现（S13 `<option>`、`workspace.css` 长行文件） |
| 边界：只调研不实现、不改代码 | 全文 | ✅ 未改任何代码/配置；仅只读 grep/read/glob + 元数据页抓取 |
| 不确定项列为风险与备选 | §10 + §5 + §0 决策表「主要备选」列 | ✅ A 的观感、B 的包体与拆包、S13 交互均为显式风险/不确定项 |
| 不编造数据 | §11 每条附 URL 与抓取日期；本仓数据附 file:line；上游行号漂移已标注 | ✅ 唯一无独立出处的数字（DiceBear 对比页的星数/风格数）已标注 D 级并用 GitHub API 复核 |
