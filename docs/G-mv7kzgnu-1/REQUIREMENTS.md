# T-203 需求说明：为软件流水线空间仍未换头像的 Agent（soldier-* 与 general）选取头像

> 阶段：需求澄清（requirement）｜任务：T-203（[auto-goal]，所属目标 G-mv7kzgnu-1 · software · chain）
> 上游 goal 原句（将军）：**软件流水线空间仍然有几个Agent没有换上头像，几个soldier和general，为他们选取头像**
> 本目标文档目录：docs/G-mv7kzgnu-1/（本文即该目录 REQUIREMENTS.md；不写/不碰仓库根 docs/ 槽位与其他目标目录下的同名阶段文档）
> 下游：T-204 researcher（RESEARCH.md）→ T-205 breaker（TASK_BREAKDOWN.md）→ T-206 test-designer（TEST_CASES.md）→ T-207 coder → T-208 reviewer → T-209 tester（TEST_REPORT.md）→ T-210 devops（DEPLOY.md）
> 评估基准：w/T-203 HEAD `22ae3a25`（2026-10-14）；本文 file:line 均指本 worktree 内容
> 实测数据基准：`team-hub/team.db`（2026/10/14 12:03 快照，只读查询）；复现命令见 §11

## 0. 文档状态与阅读说明

- 三类标注（全文统一）：
  - ✅ **已确认口径**：由源码 / 实测数据 / 设计文档钉死，下游可直接依据；
  - ⚖️ **待将军裁决（D-*）**：影响范围/语义/优先级的关键分歧；裁决前按「倾向 + 默认值」推进，**默认值是假设不是结论**（§7.2）；
  - ❓ **开放问题（O-*）**：默认取值已写明，供将军补充输入（§8.2）。
- **本阶段只产出本文档**：不做技术选型与实现细节（令牌分配算法、是否落 roster 行、头像来源是位面还是图片、前端组件改造方式 → 交 T-204 researcher 与后续阶段）、不写代码、不改仓库实现、不调用 taskctl / 看板写接口、不 push。
- 所有「验收口径」写成**可测语句**（断言 / 命令 / 判据），供 breaker 切分、test-designer 直转用例、将军对照验收。
- **归属边界**：本目标 = **展示层（头像）补齐**。与身份模型、任务归属、流水线契约的交互只做「不破坏」约束，不改其语义（§5.2）。
- **与上一目标的关系**：上一目标 G-mv1s6y49-1（起名 + 头像）**显式排除**了「外部执行者伪成员」（证据见 §2.4）。本目标是同一问题的**剩余面**，不是推翻上一轮：术语、令牌形态、位面表、两级来源（图片/矢量）全部沿用，只把上一轮排除在外的身份补上。

## 1. 目标解读：将军诉求 → 可验收语义

| 原句片段 | 澄清后语义 | 现状定性（证据见 §2） | 对应需求 |
| --- | --- | --- | --- |
| 「**软件流水线空间**」 | Legion 指挥台的 `software` 空间（spaces 表 id=software，显示名「软件流水线」） | 该空间 roster 8 个岗位；按 `/api/roster` 逻辑离线复算（§2.1/§11）**返回 12 条**（8 内编 + 4 外部执行者） | R-1、R-2 |
| 「**仍然有几个Agent没有换上头像**」 | 「有头像」= avatar 是合法令牌 `human:<key>` **且**能解析到位面表里的人形位面（不是灰阶占位）；「没有换上头像」= 不满足该判据 | **实测**：software 空间 **4 条**不满足 —— `soldier-a`、`soldier-b`、`soldier-auto`、`general`（avatar 全是 `'⚙️'`，非法令牌 ⇒ 渲染灰阶占位人形）；另有侧栏底部用户卡 `general` 的头像是硬编码字符 `⚙` | R-1、R-2、R-3 |
| 「**几个soldier和general**」 | 就是上一条那 4 条外部执行者条目的 `soldier` 字段值：3 个 `soldier-*` + 1 个 `general`（名字恰好与将军的描述一致） | 4 条来自历史任务的 `tasks.soldier`，由 `team-hub/routes/team-views.mjs:118-120` 合成，avatar 硬编码 `'⚙️'` | R-2、R-3、R-8 |
| 「**为他们选取头像**」 | 给这 4 个身份 + 将军（general）本人配上**确定性的人形头像**，且在此前显示它们的所有界面一致 | 现状 0/4 有合法令牌；侧栏用户卡是字符 `⚙` | R-2、R-3、R-4、R-5、R-6 |
| （隐含）「**仍然**」 | 上一轮（G-mv1s6y49-1）已把 25 个内编岗位换上人形令牌与图片，本目标只补 **上一轮明确排除的那一类身份** | 上一轮 A-1 原文：「**不含**外部执行者伪成员」；TASK_BREAKDOWN 纪律：「不改外部执行者 `'⚙️'` 口径」（§2.4） | §2.4、§5.2 |

## 2. 现状盘点（✅ 证据锚定）

### 2.1 目标对象枚举（实测，可复现）

对 `team-hub/team.db`（只读）按 `team-views.mjs` 的 `/api/roster` 逻辑复算：

```
== scope software == roster: 8  external pseudo-agents: 4
   EXTERNAL: soldier-a     | name = "soldier-a · 执行中"     | avatar = "⚙️" -> 合法令牌? false | tasks: T-001:done
   EXTERNAL: soldier-b     | name = "soldier-b · 执行中"     | avatar = "⚙️" -> 合法令牌? false | tasks: T-002:done
   EXTERNAL: soldier-auto  | name = "soldier-auto · 执行中" | avatar = "⚙️" -> 合法令牌? false | tasks: T-004:done
   EXTERNAL: general       | name = "general · 执行中"       | avatar = "⚙️" -> 合法令牌? false | tasks: T-003:done
   roster rows with non-token avatar: 0
== scope ozon == roster: 10  external pseudo-agents: 1
   EXTERNAL: soldier-market | avatar = "⚙️" -> 合法令牌? false | tasks: T-162:done,T-163:done
== scope gf001 == roster: 3  external pseudo-agents: 0
== scope default == roster: 3  external pseudo-agents: 0
```

- software 的 8 个内编岗位（`requirement 析言 / researcher 探微 / breaker 分略 / test-designer 构验 / coder 衡码 / reviewer 鉴微 / tester 寻瑕 / devops 启舟`）avatar **全部**是 `human:<role>`，且都在 20 张图片资产表里（`workbench/src/avatar/photo-assets.ts:31-50`）—— 即上一轮已覆盖，**本目标不重复处理**。
- 全库 roster 共 24 行，**0 行** avatar 非法 ⇒ 缺口 100% 落在「外部执行者伪成员」这一类。
- 4 个身份语义**互不相同**（澄清价值点，见 ❓O-5）：`soldier-a`/`soldier-b` = 早期一次性士兵名（T-001/T-002，2026-08 的“可直接执行士兵”时代）；`soldier-auto` = **执行守护**的写者身份（workbench/src/components/TaskDetailModal.tsx:309-312 把 `soldier-auto` 认作守护）；`general` = **将军本人**（`by=general` 是全站写纪律，workbench/src/api.ts:864）。

### 2.2 这些条目是怎么来的（写/读链路）

- **不是 roster 行**：4 条都来自 `tasks.soldier`，没有任何 `roster` 行。合成代码 `team-hub/routes/team-views.mjs:74-84, 112-120`：
  - 只跳过 `canceled`；`done` 任务仍会把 `soldier` 带进结果；
  - `if (rosterRoles.has(t.role ?? t.soldier)) continue` —— 不在编队的执行者才合成；
  - `:119` 合成调用 `summarize(soldier, <soldier> + ' · 执行中', list, '', '⚙️', true)` —— **avatar 硬编码 `'⚙️'`，external=true**。
- **读出口**：`GET /api/roster`（`team-views.mjs:55-123`）返回这些条目；`GET /api/agents`（`read-models.mjs:250-264`）只读 roster，**不含**外部执行者。
- **成员计数**：`/api/spaces` 的 `agentCount` 只数 `roster` 行（`read-models.mjs:196-201`）⇒ 外部执行者**不计入**空间成员数；但侧栏分组头显示的是 `/api/roster` 的 `list.length`（`WorkspaceNavigation.tsx:62-63`），**含**外部执行者。这两个数字口径不同，改实现时不能混（RK-2）。

### 2.3 现状渲染链路与展示面（S1–S8）

渲染器 `workbench/src/avatar/AgentAvatar.tsx:221-243`：`resolveSlot(token) ?? PLACEHOLDER_SLOT` → 有图走 `<img>`，无图走内联 SVG 人形；**令牌非法 ⇒ 统一的灰阶占位人形 `PLACEHOLDER_SLOT`**（`slots.ts:76-84`，key='placeholder'，灰阶 `#cbd3dc`）。

| # | 展示面 | 位置 | 现状（这 4 条 + general） |
| --- | --- | --- | --- |
| S1 | 侧栏 Agent 目录行 | `workbench/src/components/WorkspaceNavigation.tsx:58-63` | `<AgentAvatar token={a.avatar}>` + `{a.name}`；token=`'⚙️'` ⇒ **灰阶占位人形**，名字显示「soldier-a · 执行中」等 |
| S2 | 侧栏底部用户卡（general 本人） | `workbench/src/components/Sidebar.tsx:174-180` | **硬编码文字头像** `<div className="user-avatar">⚙</div>` + `name=general / role=空间管理员` ❌ |
| S3 | 左轨「空间管理员」徽标 | `workbench/src/components/WorkspaceNavigation.tsx:45` | 文字「管」，**无头像** ❌ |
| S4 | Agent 工作区头部 | `workbench/src/components/AgentWorkspace.tsx:112` | `<AgentAvatar token={agent.avatar}>`；外部成员同样是占位人形 |
| S5 | 场景 Agent 列表 | `workbench/src/components/SceneAgentList.tsx:13-20` | `<AgentAvatar token={avatar}>`；同 S1 |
| S6 | 3D 场景人物 | `workbench/src/scene/sceneState.ts:63-77` → `Employee3D.tsx:50,100,117` | 外部成员**统一灰色人形**（`agent.external ? '#586879'`），与头像**无关联** ⚖️D-4 |
| S7 | 移动端成员 chip / picker | `workbench/mobile/app.mjs:541-563`（`renderAvatar(a.avatar, 22/24)`） | 令牌非法 ⇒ 移动端占位人形；镜像实现见 `workbench/mobile/avatar.mjs:96` |
| S8 | 技能授权标签 | `workbench/src/components/SkillsPanel.tsx:316-320, 546, 681, 793` | `general` / `soldier-a` 这类 id **不在 `/api/agents` 目录**里 ⇒ `a` 为 undefined ⇒ **整块不渲染头像**，只剩纯文本 ❌ |

> 结论：这 4 条 + general 目前**没有任何一处在显示人形头像**。S1/S4/S5/S6/S7 显示的是**没有脸的灰阶占位**（或 3D 的灰人），S2/S3/S8 是**文字/字符**。这与将军「没有换上头像」的描述一致。

### 2.4 上一目标为什么漏掉这一类（✅ 原文证据）

| 出处 | 原文 | 含义 |
| --- | --- | --- |
| docs/G-mv1s6y49-1/REQUIREMENTS.md:28 | 「我的 Agent」= ……**不含** DSH 子代理角色名、**不含**外部执行者伪成员 | 对象边界把它排除了 |
| docs/G-mv1s6y49-1/REQUIREMENTS.md:271 | **A-1 对象**：……非 DSH 子代理、**非外部执行者** | 假设清单同样排除 |
| docs/G-mv1s6y49-1/TASK_BREAKDOWN.md:175 | **纪律**：……**不改外部执行者 `'⚙️'` 口径** | 实现阶段被明令保持现状 |
| docs/G-mv1s6y49-1/TEST_CASES.md:181（TC-S3-07） | 外部执行者**仍为 `'⚙️'`**（术语表已排除，保持现状） | 测试用例把现状**固化**为期望 |

⇒ 上一轮不是“做错了”，而是**按当时的对象边界做完了**；本目标就是把这最后一类补上，且必须**同步改掉这三处口径**（否则下游会拿旧用例判本目标“失败”）。这一条要写进 §9 交接。

### 2.5 缺口判定

- **G1** ❌ 软件流水线空间 4 个外部执行者条目（`soldier-a`/`soldier-b`/`soldier-auto`/`general`）**无合法头像令牌**，渲染为灰阶占位（非法令牌 `'⚙️'`）。
- **G2** ❌ 将军（general）本人在侧栏用户卡（S2）与左轨（S3）是**文字/字符**头像。
- **G3** ❌ 服务端仍在**主动产出**非法头像令牌（`team-views.mjs:119`），违反了上一轮建立的“读出口只投影合法令牌”口径（同文件 `:116` 对内编行已经这么做了）。
- **G4** ❌ 没有任何机制保证**后续新增**的外部执行者身份能自动拿到头像（`allocateAvatarToken` 只在 `POST /api/agents` 的入编路径被调用，`agent-intake.mjs:84-92`；外部执行者不经过它）。
- **G5** ⚠️ 同类缺口不止 software：实测 `ozon/soldier-market` 也是 `'⚙️'`（范围待裁决 ⚖️D-3）。

## 3. 术语表（本文档唯一口径，下游不得另作解释）

| 术语 | 定义 | 明确不指 |
| --- | --- | --- |
| 内编成员 | `roster` 表中以 (scope, role) 唯一标识的编队智能体（上一轮已覆盖的对象） | 外部执行者 |
| 外部执行者（伪成员） | 出现在某 scope 的 `tasks.soldier`、但**没有对应 roster 行**的执行者身份，由 `/api/roster` 合成（`team-views.mjs:118-120`，`external=true`） | 内编成员、DSH 子代理 |
| soldier 身份键 | 外部执行者的身份名，即 `tasks.soldier` 的值（本文实测为 `soldier-a`/`soldier-b`/`soldier-auto`/`general`） | roster 的 role 机器键（虽是同类字符串，但语义不同） |
| 将军（general） | 人类操作者/指挥官的身份 id，全站写纪律 `by='general'`；侧栏用户卡显示为「general · 空间管理员」 | 某个 AI 员工岗位 |
| 头像令牌 | `avatar` 字段的合法取值形态：`human:<key>`（`agent-avatars.mjs:16`、`slots.ts:86`） | emoji、文字、空串 |
| 头像位面（slot） | 位面表里一组人形特征（肤色/发色/发型/上衣/配饰/底色），25 个内置 role key + `s01..s15` 备用 key（`slots.ts:13-22`） | 图片资产 |
| 占位人形 | `PLACEHOLDER_SLOT`：令牌缺失/非法时渲染的**统一灰阶人形**（`slots.ts:76-84`） | “有头像”——**占位不算换上头像** |
| 有头像（本目标判据） | avatar 是合法令牌 **且** `resolveSlot(avatar) !== null`（命中位面表，非 placeholder） | 只渲染出「人形组件」（占位也是人形组件） |
| 图片资产 | `photo-assets.ts` 的 20 张 256×256 WebP（`workbench/public/avatars/`、`workbench/mobile/avatars/`） | 位面/矢量 |
| 展示面 | §2.3 列出的 S1–S8 | 数据模型内部字段 |

## 4. 需求清单（编号 + 优先级 + 背景/目标/验收口径）

优先级：**P0** 本目标验收门槛；**P1** 应做；**P2** 可延后（须在验收时显式说明）。

### R-1 [P0] 固定「有没有换上头像」的机器判据
- **背景**：上一轮的判据只看“令牌是否合法”，而占位人形同样是合法渲染路径 —— 只看组件有无会把“灰阶剪影”判成“已换头像”（§2.3、术语表）。
- **目标**：给出一个不依赖颜色/肉眼、桌面与手机同用的判定：合法令牌 **且** 解析命中位面表。
- **验收口径**：
  - **AC-R1-1**：对 `GET /api/roster` 的每条结果断言 `isAvatarToken(avatar) === true` 且 `resolveSlot(avatar) !== null`（两端同名函数：team-hub `agent-avatars.mjs` / workbench `slots.ts`）。
  - **AC-R1-2**：判据可复现：用 §11 的脚本对 `team-hub/team.db` 快照跑，software 空间命中 **4** 条（soldier-a/b/auto + general），与 §2.1 一致。
  - **AC-R1-3**：判据中**不得**出现 `PLACEHOLDER_SLOT`/灰阶色值作为通过条件；占位必须判为“未换头像”。

### R-2 [P0] 软件流水线空间 4 个外部执行者获得人形头像
- **背景**：`team-views.mjs:119` 对外部执行者硬编码 `'⚙️'`；实测 4 条全部非法（§2.1）。
- **目标**：software 空间下 `soldier-a`、`soldier-b`、`soldier-auto`、`general` 4 条，其 `/api/roster` 返回的 `avatar` 为合法令牌并解析到**人形位面或图片**。
- **验收口径**：
  - **AC-R2-1 令牌合法且命中**：4 条 `isAvatarToken(avatar) && resolveSlot(avatar) !== null`（R-1 判据）。
  - **AC-R2-2 无 emoji 头像**：对这 4 条的响应体与渲染 DOM 扫描，头像节点内**不出现** emoji 码点（U+2600–U+27BF、U+1F300–U+1FAFF）作为头像内容（对比：上一轮 TC-S3-07 曾把 `'⚙️'` 固定为期望，本目标推翻该条）。
  - **AC-R2-3 无占位**：这 4 条解析出的位面 key ≠ `'placeholder'`；4 条渲染出的图形不是同一个占位剪影。
  - **AC-R2-4 计数归零**：§2.1 脚本在改后对 software 返回“不满足条数 = 0”。

### R-3 [P0] 将军（general）本人在各展示面有头像，且两处一致
- **背景**：侧栏底部用户卡是硬编码字符 `⚙`（`Sidebar.tsx:174-180`），左轨是文字「管」（`WorkspaceNavigation.tsx:45`），目录里的 general 条目是占位人形（§2.1）。
- **目标**：general 在 S1（目录条目）、S2（用户卡）、S3（左轨徽标）显示**同一人形头像**。
- **验收口径**：
  - **AC-R3-1 图形节点**：`.user-avatar` 内是图形节点（`img`/`svg`）而不是单个 Unicode 字符；DOM 文本中不再出现 `⚙` 或 `管` 作为头像内容。
  - **AC-R3-2 两处一致**：抓取 S1 的 general 条目与 S2 用户卡渲染出的头像标识（令牌或图片文件名），两两相等。
  - **AC-R3-3 与 AI 员工可区分**：general 的头像 key/图片与 software 空间 8 个内编岗位**均不相同**（见 ❓O-1）。

### R-4 [P0] 头像唯一、可区分（不与任何内编成员撞）
- **背景**：备用位面池 `s01..s15` 目前已被占用 `s01..s10`（`photo-assets.ts:42-50` 与实测令牌表），余量有限；外部执行者是**后加入**的一类身份。
- **目标**：software 空间内所有 Agent 条目的头像两两不同；4 个外部身份与 8 个内编岗位不共用令牌、不共用图片文件。
- **验收口径**：
  - **AC-R4-1 空间内两两不同**：software 空间 12 条（8+4）的 `avatar` 去重后仍为 12；解析出的位面 key 去重后仍为 12；若走图片，图片文件去重后仍为 12。
  - **AC-R4-2 不抢占内编位面**：4 条外部令牌的 key **不在** `BUILTIN_ROLE_KEYS`（`slots.ts:13-19`）里，也不等于 8 个内编岗位当前使用的 key。
  - **AC-R4-3 跨空间不误伤**：`ozon` 等空间的既有内编令牌（`s01..s10`）在本次改动后**逐条不变**（除 ⚖️D-3 明确纳入的外部条目外）。

### R-5 [P0] 确定性：同一身份每次得到同一头像
- **背景**：外部执行者条目是**每次请求按任务实时合成**的（`team-views.mjs:74-120`），没有可持久化的 roster 行；若用随机/时间派生，刷新一次变一次。
- **目标**：同一 `(scope, soldier)` 在多次请求、进程重启、桌面与手机两端得到同一头像；且不覆盖已存在的合法令牌。
- **验收口径**：
  - **AC-R5-1 重复一致**：对同一 scope 连续请求 `/api/roster` ≥3 次，4 条外部条目的 `avatar` 逐次相同（字符串相等）。
  - **AC-R5-2 重启一致**：重启 hub 进程后再次请求，4 条令牌不变。
  - **AC-R5-3 纯函数**：解析/分配路径不得调用 `Math.random` / `Date.now` / 网络（沿用 `slots.ts:5-9` 的既有纪律）。
  - **AC-R5-4 幂等**：重复执行种子/迁移不改变已存在的合法令牌（沿用 `seed-roster.mjs:112-114` 的“只替换旧默认值”与 `agent-avatars.mjs:118-133` 的“写前再确认”）。

### R-6 [P0] 全展示面一致（S1–S8）
- **背景**：§2.3 里 8 个面分属 3 类行为：合法组件+非法令牌（S1/S4/S5/S6/S7）、文字头像（S2/S3）、整块缺席（S8）。
- **目标**：同一身份在 S1–S8 的**头像与名称**一致；任一展示面都不再出现「文字/字符代替头像」或「整块没有头像」。
- **验收口径**：
  - **AC-R6-1 逐面存在**：S1/S2/S3 对 general、S1/S4/S5/S6/S7 对 4 条外部身份，均能取到一个头像标识（令牌或图片文件名）且非 placeholder。
  - **AC-R6-2 逐面相等**：同一身份在 S1/S2/S4/S5 抓取的头像标识两两相等；移动端（S7）与桌面同 key 得到同位面（既有 `avatar-parity.test.mjs` 口径）。
  - **AC-R6-3 S8 明确**：技能授权标签对 `general`/`soldier-*` 这类**不在目录**的 id，要么显示同一头像，要么显式声明本目标不含此面（若取后者，须在 ⚖️D-5 记录并给出理由）。
  - **AC-R6-4 无破图**：在所有面上，令牌非法/图片 404 时显示占位人形或名称（不出现破图图标、不裸露文件名/alt）。

### R-7 [P1] 服务端不再产出非法头像令牌
- **背景**：`team-views.mjs:119` 是**唯一仍在主动产出** `'⚙️'` 的地方（同文件 :116 对内编行已收敛为“非法 ⇒ 空串”）。G3。
- **目标**：所有读出口的 `avatar` 字段只会是：合法令牌、或显式空串（`''`，语义=占位人形）。
- **验收口径**：
  - **AC-R7-1 全量扫描**：遍历 `GET /api/roster`（`scope=` 空 = 全部空间）与 `GET /api/agents` 的全部条目，`avatar` 非空时必满足 `isAvatarToken`；非法计数 = 0。
  - **AC-R7-2 空串语义**：出现 `''` 的条目必须在前端确定性渲染占位人形，且不写回任何库表。
  - **AC-R7-3 不误伤图标**：`⚙`/`⚙️` 作为**界面齿轮图标**的既有用法（如 `Sidebar.tsx:125-136`、`CommandBar.tsx:104`）不受影响；本项只约束 `avatar` 字段与头像节点。

### R-8 [P1] 后续新增/自建的外部执行者自动获得头像
- **背景**：外部执行者不经过 `POST /api/agents`，因此 `allocateAvatarToken`（`agent-avatars.mjs:28-40`，只按 roster 行判占用）覆盖不到它们。参考（**非本目标权威**）：姊妹目标 G-mv1s6y49-1 的将军裁决第 3 条「范围包含所有的，包括后续自建的」。
- **目标**：任何 scope 下新出现的 `tasks.soldier`（不在 roster 中）在 `/api/roster` 里都自动得到确定性人形头像，无需人工点名。
- **验收口径**：
  - **AC-R8-1**：造一条 scope 内的任务 `soldier='soldier-x-<唯一后缀>'`（状态非 canceled），`GET /api/roster` 该条目 `avatar` 满足 R-1 判据。
  - **AC-R8-2**：删除/取消该任务后再次请求，结果回到不含该条目（不残留半成品状态）。
  - **AC-R8-3**：该分配**不要求**出现新的 `roster` 行；若实现选择落行，须满足 R-9 且经 ⚖️D-1 裁决。

### R-9 [P1] 补头像不产生不可见副作用（成员计数 / 身份 / 归属不变）
- **背景**：`/api/spaces` 的 `agentCount` 只数 roster 行（`read-models.mjs:196-201`），侧栏分组头数的是 `/api/roster` 条数（含外部）；KPI「AI 员工」与 `SpaceOverview` 只数 `!external`（`SpaceOverview.tsx:25`）；身份红线要求 name/avatar 不参与身份（`docs/superpowers/specs/2026-10-01-agent-conversations-progress-design.md:81`）。
- **目标**：改动前后“谁是成员、有多少成员、任务归谁”的语义不变。
- **验收口径**：
  - **AC-R9-1 字段不变**：`/api/roster` 每条结果里除 `avatar` 外的字段（`role/name/kind/mode/chips/done/total/external/scope/tasks`）逐字段与基线相同。
  - **AC-R9-2 计数口径**：`/api/spaces` 的 `agentCount` 与 `/api/agents` 的 role 集合在改前/改后完全一致（外部执行者不应因为补头像而变成成员）。
  - **AC-R9-3 身份红线**：不新增以 `name`/`avatar` 为键的唯一约束或前端 key（前端 key 仍是 `scope + role`/`soldier`）。
  - **AC-R9-4 归属不变**：`tasks.soldier`/`tasks.role` 不被改写；不新增写接口与鉴权旁路。

### R-10 [P2] 回退与降级
- **背景**：图片加载失败、移动端弱网、Service Worker 缓存（`workbench/mobile/sw.js`）都可能裸露破图。
- **目标**：任何头像不可用时显示确定的占位人形，不出现破图、不显示文件名、不出现 emoji 回退。
- **验收口径**：
  - **AC-R10-1 404 降级**：模拟某图片 404，该身份显示占位人形（矢量），无破图图标、无裸露 alt/文件名。
  - **AC-R10-2 回退不落库**：回退只是渲染态，不写回 roster / 不改变接口返回值。
  - **AC-R10-3 移动端不报错**：移动端（S7）在头像缺失时降级为占位/纯名称，控制台无异常。

### R-11 [P2] 其它空间的同类缺口（ozon 等）
- **背景**：实测 `ozon/soldier-market` 同样是 `'⚙️'`（§2.1）；`gf001`/`default` 当前为 0 条。
- **目标**：同一实现应天然覆盖其它空间；本目标**验收门槛只把 software 作为 P0**，其它空间作为 P1 回归面（取决于 ⚖️D-3）。
- **验收口径**：
  - **AC-R11-1**：若 D-3 判“纳入”，则全空间跑 R-1 判据，不满足条数 = 0；若判“不纳入”，software 之外的不满足条数须在验收报告中**显式列出并说明**，不得沉默。

## 5. 范围边界

### 5.1 做什么（In scope）

1. 固定「有/没有换上头像」的机器判据（R-1）。
2. 软件流水线空间 4 个外部执行者身份（`soldier-a`/`soldier-b`/`soldier-auto`/`general`）的人形头像（R-2）。
3. 将军（general）本人在 S1/S2/S3 的头像与一致性（R-3）。
4. 唯一性/可区分（R-4）、确定性（R-5）、全展示面一致（R-6）。
5. 服务端读出口不再产出非法令牌（R-7）、后续新增身份自动覆盖（R-8）、无不可见副作用（R-9）、回退（R-10）。
6. 其它空间同类缺口的覆盖口径（R-11，待 D-3）。
7. 口径承接：上一目标 `docs/G-mv1s6y49-1/TEST_CASES.md:181`（TC-S3-07「外部执行者仍为 `'⚙️'`」）已被本目标推翻，但其目录**不属于本工作区**——本目标只在**自己的** docs/G-mv7kzgnu-1/ 与本目标 T-206 用例中写明新口径，**不直接修改** docs/G-mv1s6y49-1/ 下任何文件；`README`/`docs/FEATURES.md` 中涉及头像覆盖范围的描述由实现阶段更新。
8. 证据留痕：本阶段以本文档 §2.1/§11 的形式给出可复现枚举；实现阶段的前后对照数据同样写入 docs/G-mv7kzgnu-1/。

### 5.2 明确不做什么（Out of scope）

1. **不做技术选型与实现细节**：外部身份的令牌分配算法（哈希派生 / 备用池 / 独立前缀）、是否新增 roster 行、是否新增第 21 张图片、读出口改写方式、前端组件改造方式 → T-204 researcher 与后续阶段（本阶段只给判据与约束）。
2. **不改身份模型与契约**：不引入 name/avatar 作为身份键，不动 `agent_registry` 主键，不改 `role` 机器键、流水线阶段链、文件域规则、任务归属语义。
3. **不清理/不删除历史身份**：`soldier-a`/`soldier-b` 等历史遗留条目是否该继续出现在目录里（它们是 `done` 任务推导出来的，却显示「· 执行中」）→ 见 ⚖️D-2，本目标只补头像。
4. **不做 3D 场景美术重做**：不动 `Employee3D` 的人物外观体系与调色板；外部成员是否与头像联动见 ⚖️D-4。
5. **不重设计任务中心/任务详情的处理人展示**（目前只显示文本，无头像）→ 见 ❓O-4。
6. **不做头像上传/裁剪/在线图床/AI 在线生成**（离线自足是硬约束）。
7. **不给 DSH 子代理角色名配头像**（上一轮同样排除）。
8. **不碰其它工作区/其它任务的产物与文件**（工作区纪律；只提交本任务文档）。
9. **本阶段不写代码、不跑 taskctl、不 push**。

## 6. 成功标准（可度量，可测试）

| 编号 | 标准 | 判据 |
| --- | --- | --- |
| M-1 | 覆盖 | software 空间 `/api/roster` 全部 12 条满足 R-1 判据（不满足 = 0）；其中 4 条外部身份是本次新增覆盖 |
| M-2 | 无非法令牌 | `/api/roster`（全空间）+ `/api/agents` 的 `avatar` 非法计数 = 0（AC-R7-1） |
| M-3 | 唯一可辨 | software 空间 12 条 `avatar`/`key`/`图片` 各自去重后仍为 12（AC-R4-1）；4 条不与 8 内编共用 key/图（AC-R4-2） |
| M-4 | 稳定 | 连续 3 次请求 + 重启后 4 条令牌不变（AC-R5-1/2）；既有内编与 ozon 令牌逐条不变（AC-R4-3） |
| M-5 | 一致 | general 在 S1/S2/S3、4 条外部身份在 S1/S4/S5/S6/S7 的头像标识两两相等（AC-R6-1/2、AC-R3-2） |
| M-6 | 无副作用 | 除 `avatar` 外 `/api/roster` 字段不变；`agentCount`、`/api/agents` role 集合、任务归属不变（AC-R9-1/2/4） |
| M-7 | 无破图 | 全部展示面在图片 404 / 令牌非法时显示占位人形，破图/裸露 alt/文件名 = 0（AC-R6-4、AC-R10-1） |

## 7. 风险与依赖假设

### 7.1 风险

| 编号 | 风险 | 影响 | 证据/来源 | 需求侧缓解 |
| --- | --- | --- | --- | --- |
| RK-1 | 外部执行者**没有 roster 行**，令牌只能从 `tasks.soldier` 推导；备用池占用判定（`agent-avatars.mjs:28-40`）只扫 roster 行，推导出的 key 可能与将来真实成员的 sNN 分配**撞车** | 撞车 = 两个身份同一张脸，且事后难察觉 | agent-avatars.mjs:28-40；实测 `s01..s10` 已占用 | AC-R4-1/2（唯一性判据）+ R-5（确定性）；具体分配策略交 researcher |
| RK-2 | 若实现选择“落 roster 行”来给头像，会连锁改变 `agentCount`、侧栏分组计数、3D 人数、`SpaceOverview` 的 `!external` 过滤，并触发 `agent-intake` 的岗位清单写入事务（`agent-intake.mjs:82-99`） | 静默副作用：成员数从 8 变 12、3D 多出 4 个灰人 | read-models.mjs:196-201、SpaceOverview.tsx:25、agent-intake.mjs:82-99 | AC-R9-1/2（计数口径不变）+ ⚖️D-1；R-8-AC3 要求落行须显式裁决 |
| RK-3 | `⚙️` 同时是**界面齿轮图标**（多处 CSS/组件），粗暴全局替换会误伤 UI | 图标消失/文案失真 | Sidebar.tsx:125-136、CommandBar.tsx:104 | AC-R7-3（只约束 `avatar` 字段与头像节点） |
| RK-4 | 移动端是**镜像实现**（`mobile/avatar.mjs` 与 `src/avatar/slots.ts`+`photo-assets.ts` 两份表），任一端漏改则 parity 破 | 桌面有头像、手机没有（或相反） | mobile/avatar.mjs:1-6；avatar-parity.test.mjs | AC-R6-2 + 复跑 `avatar-parity.test.mjs` / `avatar-photo.test.mjs` |
| RK-5 | 图片资产只有 **20 张**，在用令牌已有 21 个（`s10` 已回落矢量） | 新增身份若也想用“照片”会不够 | photo-assets.ts:11-21、:42-50 | 需求只要求“人形头像”（矢量也算，术语表已定义）；用不用照片交 researcher（❓O-2） |
| RK-6 | 「有头像」被误判成“组件渲染出来了”（占位也是人形组件） | 验收走过场，问题原样留下 | slots.ts:76-84、AgentAvatar.tsx:223 | R-1 判据 + AC-R2-3（key ≠ placeholder） |
| RK-7 | 上一轮的 TC-S3-07 **把现状固化成期望**（“外部执行者仍为 `'⚙️'`”） | 本目标改动会让旧用例“红”，被误判为回归 | docs/G-mv1s6y49-1/TEST_CASES.md:181 | §9 交接：本目标 T-206 必须**显式改写**该口径；T-209 复跑时按新口径判定 |
| RK-8 | Service Worker 缓存旧头像/旧页面（`mobile/sw.js` 对非代码走 cacheFirst） | 刷新后仍看到旧图，误判“没生效” | mobile/sw.js | AC-R5-1（重复请求一致）+ 验收时强制刷新/清缓存 |
| RK-9 | `soldier-auto` 是**执行守护**、`general` 是**人类将军**，给它们与 AI 员工一模一样的脸会让用户误解身份 | 语义误导 | TaskDetailModal.tsx:309-312；api.ts:864 | ❓O-1 / ❓O-5：默认都给头像（按 goal 原句），但需将军确认是否需要区分标识 |
| RK-10 | 这些条目是 `done` 任务推导出来的却显示「· 执行中」（`team-views.mjs:119` 的固定文案） | 用户对“为什么他们还在”产生新的疑问 | team-views.mjs:119 | ⚖️D-2：本目标只补头像，文案/清理另立 bug（不夹带） |

### 7.2 依赖与假设（显式标注，**不当作结论**）

- **A-1 对象**：「没有换上头像的几个 soldier 和 general」= software 空间 `/api/roster` 里 4 个外部执行者条目（`soldier-a`/`soldier-b`/`soldier-auto`/`general`）+ 侧栏用户卡/左轨的 general（§2.1、§2.3 实测）。**不指** DSH 子代理、**不指**其它空间的普通岗位（那些已有头像）。
- **A-2 形态**：沿用既有 `human:<key>` 令牌 + 两级来源（图片优先、矢量兜底）；**人形**是底线，emoji/文字/首字不算（沿用上一轮将军裁决 #2 的语义，本目标 context v0 未重申，故列为假设）。
- **A-3 身份合并**：目录里的 `general` 外部条目与侧栏用户卡是**同一人（将军）**，应显示同一头像。
- **A-4 范围**：software 为 P0 门槛；其它空间（ozon 实测 1 条）默认一并覆盖但只作 P1 回归面（待 ⚖️D-3）。
- **A-5 离线**：头像能力离线自足，不新增运行时依赖（LEGION.md 纪律）。
- **A-6 契约**：不改 role/身份/任务归属语义（R-9）。
- **A-7 姊妹目标裁决不自动沿用**：G-mv1s6y49-1 的将军裁决与本文档口径只作**参考**，本目标 contextVersion=0 为空；若将军要沿用，请写入目标上下文（❓O-6）。
- **A-8 交付**：本阶段只提供本文档，下游按本文档链读取。

## 8. 待裁决项（⚖️D-*）与开放问题（❓O-*）

### 8.1 待将军裁决（裁决前按倾向默认推进）

- **⚖️D-1** 这 4 个外部身份要不要变成**正式成员**（落 roster 行），还是保持“任务推导的投影”（只让读出口返回合法令牌）？
  倾向：**保持投影，不落 roster 行** —— 落行会改成员计数/3D 人数/空间指标并触发岗位清单写入（RK-2），而 goal 原句只说“选取头像”。依据：§2.2、R-9。
- **⚖️D-2** `done` 任务推导出的历史身份（`soldier-a`/`soldier-b`）继续显示且标注「· 执行中」，是否要在本目标顺带修正/隐藏？
  倾向：**不在本目标做**（只补头像）；显示名与幽灵状态另立 bug 任务，避免一个头像目标夹带目录语义变更。依据：RK-10、§5.2-3。
- **⚖️D-3** 范围是否包含 software 之外的同类缺口（实测 `ozon/soldier-market`）与“全部空间”视图？
  倾向：**实现上统一覆盖、验收门槛只算 software**（同一代码路径，额外成本近零；但避免把验收面摊大到其它空间的既有差异）。依据：§2.1、R-11。
- **⚖️D-4** 3D 场景里 `external` 成员目前统一灰色人形（`Employee3D.tsx:50`），是否要与头像联动？
  倾向：**不联动**（沿用上一目标 O-3 的判断），只保证 3D 标签名称一致。依据：§2.3 S6、§5.2-4。
- **⚖️D-5** 技能授权标签（S8）里 `general`/`soldier-*` 这类不在目录的 id 是否要补头像？
  倾向：**纳入**（同一判据，成本低），但若要缩小范围须显式声明并在验收报告中列出。依据：AC-R6-3。

### 8.2 开放问题（默认取值已写明，供将军补充）

- **❓O-1 general 的头像要不要与 AI 员工明显区分（将军是人，不是 AI 员工）？** 默认：**同风格人形、独立位面/图片**，且与 8 个内编岗位都不同（AC-R3-3）。
- **❓O-2 这 4 个头像从哪来：复用备用矢量位面（`s11..`）还是补图片？** 默认：交 T-204 researcher 出 2 个备选（成本/一致性/观感），硬约束 = 与内编不撞 + 离线 + 确定性（R-4/R-5/R-8）。
- **❓O-3 `ozon/soldier-sourcing` 目前没有图片、落到矢量人形（`photo-assets.ts:20`），这算不算“没换上头像”？** 默认：**算已换**（矢量人形符合术语表的“人形头像”），但记录在案；若将军认为矢量与照片的混用看起来“没换”，则并入 R-11。
- **❓O-4 任务中心/任务详情里的处理人（`soldier`/`role` 文本）是否要加头像？** 默认：**不纳入**（本目标=补齐“已有的、以头像展示身份的”展示面），列为可选 backlog。
- **❓O-5 `soldier-auto`（执行守护）是否需要一个“守护/非员工”的视觉标识，而不是一张普通员工脸？** 默认：按 goal 原句给普通头像；若将军要区分，请给标识口径（沿用 ❓O-1 的字段机制）。
- **❓O-6 本目标是否沿用姊妹目标 G-mv1s6y49-1 的将军裁决（自动生成头像 / 必须拟人非 emoji / 含后续自建）？** 默认：本目标 contextVersion=0 为空，**不自动沿用**，但 A-2/A-8 已按同一语义取默认值；将军答复会写入目标上下文供下游对齐。

## 9. 下游交接（本目录文档链）

- **给 T-204 researcher（只给问题边界，不给答案）**：需要评估——（a）外部执行者身份 → 头像令牌的分配机制（哈希派生 vs 备用池 vs 独立前缀），如何保证与 `agent-avatars.mjs` 的 roster 备用池不撞（RK-1）；（b）是否落 roster 行（⚖️D-1）及其副作用清单；（c）general 的独立位面/图片来源；（d）4 个头像用矢量还是图片（❓O-2，图片只剩 20 张已用 21 令牌，RK-5）；（e）S8 技能授权标签的补头像方式（⚖️D-5）。输出 2–3 备选 + 取舍。
- **给 T-205 breaker**：建议按文件域切片——① team-hub 读出口/令牌分配（`team-hub/**`，含 `team-views.mjs`、`agent-avatars.mjs`）；② workbench 展示面（`workbench/src/**`，含 `Sidebar.tsx`、`WorkspaceNavigation.tsx`、`AgentAvatar.tsx`/位面表）；③ 移动端镜像（`workbench/mobile/**`，须与 ② 同批，RK-4）；④ 文档同步。R-4（唯一性）与 R-9（无副作用）必须与 ① 同域。
- **给 T-206 test-designer**：可直接转用例的判据 = M-1~M-7 与 AC-R1-1/2/3、AC-R2-1/2/3/4、AC-R3-1/2/3、AC-R4-1/2/3、AC-R5-1/2/3/4、AC-R6-1/2/4、AC-R7-1/2/3、AC-R9-1/2/3/4、AC-R10-1/2/3。**必须显式改写**上一目标 `docs/G-mv1s6y49-1/TEST_CASES.md:181` 的 TC-S3-07 期望（RK-7），并在用例表里注明“外部执行者不再保持 `'⚙️'`”。
- **给 T-208 reviewer 的必查项**：AC-R4-2（不与内编撞位面）、AC-R7-1（无非法令牌）、AC-R9-2（成员计数不变）、AC-R5-3（纯函数、无随机/时钟）。
- **给 T-209 tester**：验收需含「§11 枚举脚本复跑（不满足 = 0）」「重复请求 + 重启一致性」「桌面/手机两条渲染路径」「图片 404 降级」四组；人工判据（“看得出是人形”）须记录评审人与结论。
- **给 T-210 devops**：部署后需确认已构建产物包含新令牌逻辑（实测口径：`workbench/dist/assets/*.js` 含 `agent-avatar-svg`/`#cbd3dc`，见 §2.3 方法），并提示刷新/清 Service Worker 缓存（RK-8）。

## 10. 本阶段自检（逐条对应任务验收标准）

1. **逐条覆盖核心诉求**：§1 表格逐片段澄清（「软件流水线空间」「仍然」「几个soldier和general」「为他们选取头像」），§4 每条需求均含 **背景 / 目标 / 验收口径** ✅
2. **明确范围边界**：§5.1 做什么 8 条 + §5.2 明确不做什么 9 条；不确定项集中在 §7.2 / §8 **显式标注为假设**，未把假设当结论 ✅
3. **关键术语无歧义**：§3 术语表给出「不指」列（尤其区分“内编成员 vs 外部执行者”、“有头像 vs 渲染出人形组件”）；成功标准 §6 M-1~M-7 每条指向可执行断言 ✅
4. **下游可用需求清单**：R-1~R-11 含编号 + 优先级 + 背景/目标/AC；风险与依赖假设见 §7 ✅
5. **不越界**：未做技术选型（只给判据与约束，分配机制交 researcher）、未写代码、未改仓库实现、未调用 taskctl、未 push ✅
6. **实测而非推测**：对象集合由只读查询 `team-hub/team.db` 得出并给出复现命令（§11），不是“按描述猜” ✅

## 11. 附录：枚举判据的复现命令（只读）

```js
// node .probe.mjs —— 需要 Node ≥22（本仓库实测 Node v24.19.0，用内置 node:sqlite；无需 better-sqlite3）
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('D:/project/DSH/legion/team-hub/team.db', { readOnly: true })
const TOKEN = /^human:[a-z0-9][a-z0-9-]*$/   // = team-hub/agent-avatars.mjs:16
for (const scope of db.prepare('SELECT DISTINCT scope FROM roster ORDER BY scope').all().map(r => r.scope)) {
  const roster = db.prepare('SELECT role, avatar FROM roster WHERE scope = ?').all(scope)
  const rosterRoles = new Set(roster.map(r => r.role))
  const bad = roster.filter(r => !TOKEN.test(String(r.avatar || '').trim()))
  const tasks = db.prepare("SELECT id,status,role,soldier FROM tasks WHERE scope = ? AND status != 'canceled'").all(scope)
  const ext = new Map()
  for (const t of tasks) {
    if (t.status === 'canceled' || !t.soldier) continue
    if (rosterRoles.has(t.role ?? t.soldier)) continue
    const a = ext.get(t.soldier) ?? []; a.push(t.id); ext.set(t.soldier, a)
  }
  console.log(scope, '| roster:', roster.length, '| 非法令牌 roster:', bad.length, '| 外部执行者:', [...ext.keys()].join(',') || '(无)')
}
```

> 说明：`/api/roster` 需要鉴权，无法直接 curl；上表用 `team-views.mjs:74-120` 的同一段判断（只跳过 canceled、按 `rosterRoles` 过滤、其余合成 external）在库上离线复算，结果与 §2.1 一致。
