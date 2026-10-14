<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-10-14**（commit `bb0fcc17`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-205 任务拆解：为软件流水线空间仍未换头像的 Agent（soldier-* 与 general）选取头像（并行切片）

> 角色：breaker（任务拆解）｜阶段：任务拆解｜执行任务：T-205（[auto-goal]｜所属目标 G-mv7kzgnu-1 · software · chain）
> 上游：[REQUIREMENTS.md](./REQUIREMENTS.md)（T-203 需求，含 R-1~R-11 + AC-R* + D-1~D-5）→ [RESEARCH.md](./RESEARCH.md)（T-204 方案：**推荐方案 A = L1 投影层修复 + T1 静态映射表 + V 矢量位面**，只改 `team-hub/routes/team-views.mjs:119` 一处读出口，零新增依赖 / 零新增图片 / 离线自足）
> 目标上下文（将军裁决，v0）：contextVersion=0 为空；本拆解严格按 RESEARCH §6 的默认值推进——**D-1 不落 roster 行（保持投影）· D-3 实现统一覆盖、验收门槛只算 software · D-4 3D 不联动 · D-5 纳入 S8 技能授权标签**。
> 下游：守护解析本文件「## slices」按文件域注册并行派工；T-206 用例设计 → T-207 coder → T-208 reviewer → T-209 tester → T-210 devops
> 评估基线：**w/T-205 worktree HEAD `bb0fcc17`**（2026-10-14，Node v24.19.0）；本文 file:line 均指本 worktree 内容；**本阶段只产出本文档，不改任何仓库实现、不调用 taskctl、不 push**。
> 上游依赖落实情况（本会话实测）：`docs/G-mv7kzgnu-1/REQUIREMENTS.md` 已在 main（commit `7c04b9cf`）；`docs/G-mv7kzgnu-1/RESEARCH.md` 目前是 **w/T-204 worktree 里的未提交文件**（`git log --all -- docs/G-mv7kzgnu-1/RESEARCH.md` 为空），本拆解以该文件内容为依据，并假设其随 T-204 promote 进入 main（见 §6 锚点 E2）。

## 1. 拆解口径与冻结契约

### 1.1 目标对象 → 冻结令牌（来自 RESEARCH §6.2，下游不得另作选择）

| 身份 | 令牌 | 客户端位面 key | 说明 |
| --- | --- | --- | --- |
| `general` | `human:s11` | `s11` | 将军本人（人类）；与 software 8 个内编岗位都不同位面（AC-R3-3） |
| `soldier-a` | `human:s12` | `s12` | 历史一次性士兵名（T-001） |
| `soldier-b` | `human:s13` | `s13` | 历史一次性士兵名（T-002） |
| `soldier-auto` | `human:s14` | `s14` | 执行守护的写者身份 |
| `soldier-market` | `human:s15` | `s15` | ozon 同类缺口第 5 条（D-3：一并覆盖，**验收门槛只算 software**） |

> 5 个身份**刚好用满** `s11..s15` 这 5 个空闲备用位面；位面表 40 个 key、移动端镜像与图片池 **一律不动**。

### 1.2 切片间冻结接口（切片只许用这些名字对接，不许各自发明）

- **服务端**（切片 S1，落在 `team-hub/agent-avatars.mjs`）：新增只读表 `EXTERNAL_AVATAR_TOKENS`（name → token）与纯函数 `externalAvatarFor(name, usedTokens)`；签名可微调，但**语义冻结**：静态表命中即返回冻结令牌；未命中按确定性规则在**未被占用的备用位面**里分配；无位面可用时返回 `''`（占位语义，不是 emoji / 非法串）。`team-hub/routes/team-views.mjs:119` 改用它。
- **客户端**（切片 S2，新增 `workbench/src/avatar/external-agents.ts`）：`EXTERNAL_AGENT_AVATARS`（与 `EXTERNAL_AVATAR_TOKENS` 逐项相同）+ `externalAvatarToken(name): string`；由 `workbench/src/avatar/index.ts` 二次导出。
- **双端一致性**不是「应该一致」，而是由 S2 的 `workbench/scripts/external-avatar-parity.test.mjs` 逐项断言。
- **位置**：S1 只改 `team-hub/**` 三个文件；S2 只改 `workbench/src/avatar/**`、新测试与 `scripts/ci/run-ci.mjs`；S3/S4 只改各自的两个组件 + 其源码扫描套件；**同一文件只属于一个切片**。

### 1.3 不变量（每个切片都必须自查，T-208 reviewer 逐条核）

1. 不新增运行时依赖：`workbench/package.json` 的 `dependencies` 仍恰好 5 个（TC-S1-10）。
2. 不改位面表规模：`slots.ts` / `mobile/avatar.mjs` 仍各 40 个 key，桌面与移动端逐 key 一致（`avatar-parity.test.mjs` / `avatar-photo.test.mjs` 保持绿）。
3. 不落 roster 行：`/api/spaces` 的 `agentCount`、`/api/agents` 的 role 集合、3D 人数、任务归属语义改前改后完全一致（AC-R9-2/AC-R9-4）。
4. 不把 `name`/`avatar` 变成身份键（AC-R9-3）；avatar 不作 React key（S4 既有断言）。
5. 纯函数：分配路径不含 `Math.random` / `Date.now` / 网络（AC-R5-3）。

## slices

- S1 | 服务端外部执行者头像令牌：静态映射表 + 未命中兜底 + /api/roster 投影修复 | team-hub/agent-avatars.mjs, team-hub/routes/team-views.mjs, team-hub/team-views-routes.test.mjs | node team-hub/team-views-routes.test.mjs 退出码 0 且 fail 0；用例⑥改写后断言 external 条目的 avatar 不再是齿轮 emoji、非空时必须通过 isAvatarToken；已点名身份返回冻结令牌 general=human:s11、soldier-a=human:s12、soldier-b=human:s13、soldier-auto=human:s14、soldier-market=human:s15；未登记名字在「有空位」夹具里拿到合法令牌、在「池满」夹具里返回空串 ''（绝不返回 emoji 或非法字符串，AC-R7-1/AC-R7-2）；同一名字与同一占用集合连续两次调用结果字符串相等（AC-R5-1/AC-R5-3）；除 avatar 外 /api/roster 每条结果字段逐字段与基线相同（AC-R9-1）；node team-hub/scripts/migrate-avatars.test.mjs 与 node team-hub/scripts/seed-roster.test.mjs 退出码 0（内编分配与迁移口径不回归，AC-R4-3/AC-R9-2）；实现路径不含 Math.random、Date.now、fetch（AC-R5-3）；只改本切片文件域
- S2 | 客户端「名字→令牌」共享模块 + 两端 parity 断言 + 新套件登记 CI | workbench/src/avatar/external-agents.ts, workbench/src/avatar/index.ts, workbench/scripts/external-avatar-parity.test.mjs, scripts/ci/run-ci.mjs | node workbench/scripts/external-avatar-parity.test.mjs 退出码 0 且 fail 0（用 ts.transpileModule 装载 .ts，同 agent-avatar.test.mjs 范式，零新增依赖）；客户端 EXTERNAL_AGENT_AVATARS 与 team-hub/agent-avatars.mjs 的 EXTERNAL_AVATAR_TOKENS 逐项相等（同名字两端同令牌）；每个令牌匹配 human:<key> 且 resolveSlot(key) !== null、key 不等于 placeholder（AC-R1-1/AC-R2-3）；5 个已点名身份的令牌与位面 key 两两不同、key 不在 BUILTIN_ROLE_KEYS、且与 software 8 个内编岗位当前 key 不重合（AC-R4-1/AC-R4-2）；externalAvatarToken(name) 对同一 name 恒返回同一值、模块源码不含 Math.random、Date.now、fetch（AC-R5-3）；node -e "const s=require('fs').readFileSync('scripts/ci/run-ci.mjs','utf8'); if(!s.includes('external-avatar-parity.test.mjs')) process.exit(1)" 退出码 0（防「写好了但不会被任何套件执行」）；在 workbench 目录执行 node node_modules/typescript/bin/tsc --noEmit 退出码 0；只改本切片文件域
- S3 | general 的两处客户端展示面：侧栏底部用户卡（S2）+ 左轨空间管理员徽标（S3） | workbench/src/components/Sidebar.tsx, workbench/src/components/WorkspaceNavigation.tsx, workbench/scripts/agent-avatar-surfaces.test.mjs | node workbench/scripts/agent-avatar-surfaces.test.mjs 退出码 0 且 fail 0；新增断言 Sidebar.tsx 的 .user-avatar 内渲染 <AgentAvatar 图形节点、该文件不再把齿轮字符（U+2699）作为头像内容（AC-R3-1）；WorkspaceNavigation.tsx 的 .workspace-user 徽标改用 <AgentAvatar、不再有文字「管」（AC-R3-1）；两处 general 令牌都从 workbench/src/avatar/external-agents.ts 导入的同一常量取得（源码断言两文件均 import 该模块），因而与 /api/roster 的 general 条目一致（AC-R3-2/AC-R6-2，两端表格由 S2 parity 锁死）；既有 S4 断言（四个面含 <AgentAvatar、无第二套 AVATARS 表、avatar 不作 React key）不回归（AC-R4-4/AC-R9-3）；在 workbench 目录执行 node node_modules/typescript/bin/tsc --noEmit 退出码 0；只改本切片文件域
- S4 | 技能授权标签（S8）：不在 /api/agents 目录的 id 也渲染头像 | workbench/src/components/SkillsPanel.tsx, workbench/scripts/agent-avatar-settings.test.mjs | node workbench/scripts/agent-avatar-settings.test.mjs 退出码 0 且 fail 0；新增断言 SkillsPanel.tsx 对不在 /api/agents 目录的成员 id（general、soldier-a、soldier-b、soldier-auto）仍渲染 <AgentAvatar（用 external-agents 兜底），不再整块缺席（AC-R6-3，D-5 取「纳入」）；既有 TC-S5-03/04/05/06/09 不回归，且不引入第二套视觉表（无 AVATARS= / AVATAR_CHOICES，AC-R4-4/AC-R6-4）；在 workbench 目录执行 node node_modules/typescript/bin/tsc --noEmit 退出码 0；只改本切片文件域
- S5 | 文档口径同步 + 证据快照 banner 治理（关闭 RESEARCH E2） | workbench/README.md, docs/FEATURES.md, docs/G-mv7kzgnu-1/REQUIREMENTS.md, docs/G-mv7kzgnu-1/RESEARCH.md | node scripts/ci/evidence-banner.mjs --check 退出码 0（缺失目录 0，缺失清单不含 docs/G-mv7kzgnu-1；前提：本目录各阶段产物已各自带 banner，见 §6）；node scripts/ci/check-docs.mjs 退出码 0（README 与 docs/FEATURES.md 结构/互链 + docs/ 表格形状 + 证据快照 banner 全覆盖）；workbench/README.md 不再含「零图片资源」（node -e 读文件正则断言退出码 0，该说法自 2026-10-13 起已过期）；workbench/README.md 与 docs/FEATURES.md 不再含齿轮 emoji 加 xxx 加 执行中 的旧口径（node -e 断言退出码 0），改写为与实现一致的「外部执行者也拿 human:<key> 人形令牌」口径（R-7 文档面）；两文件不出现过程叙事（P1/P2/P3…已交付 / 切片 Sx…已交付）；只改本切片文件域

## 3. 依赖关系（blockedBy）与工作量估计

工作量刻度：S ≈ 0.5 轮 ｜ M ≈ 1 轮 ｜ L ≈ 1.5 轮（需再拆即超预算）。

| 切片 | blockedBy | 依赖理由 | 工作量 |
| --- | --- | --- | --- |
| S1 | 无（行内起点） | 服务端静态表与 /api/roster 投影是权威源；只 import 既有模块，不依赖任何未落地文件 | L |
| S2 | S1 | 客户端镜像必须与 S1 的 EXTERNAL_AVATAR_TOKENS 逐项一致，parity 测试要 import S1 的表；早于 S1 落地会照错的表写用例 | M |
| S3 | S2 | 复用 S2 的 workbench/src/avatar/external-agents.ts 常量与 index.ts 导出 | M |
| S4 | S2 | 同上 | M |
| S5 | S1, S2, S3, S4 | 文档必须描述实现后的真实行为；banner 覆盖需本目录产物已在库 | S |

**无循环依赖**：依赖沿「S1 → S2 → {S3, S4} → S5」单向，最长路径 S1→S2→S3→S5，无回边。

**机制提醒**：守护注册切片时的任务级 blockedBy 只指向本目标的 test-designer（T-206），**上表的 blockedBy 不会自动变成任务依赖字段**——它只是本文给人看的排序依据。落地时靠 §4 的注册顺序 + coder 槽位近似满足；**并发 > 2 时严禁把 S3/S4 排到 S2 之前**（它们 import S2 的模块，会编译不过）。

## 4. 执行顺序与并行关系

1. **第 1 波（串行起点）**：S1 —— 冻结令牌形态，改 team-hub/routes/team-views.mjs:119 与配套路由测试。
2. **第 2 波（依赖 S1）**：S2 —— 客户端镜像 + parity + CI 登记；S1 的令牌形态在此被两端锁死。
3. **第 3 波（并行）**：S3 与 S4 —— 文件域零交叉（组件不同、扫描套件不同），可同时派工。
4. **第 4 波（收口）**：S5 —— 文档与 banner；必须在 S1~S4 行为冻结后写。
5. 全程回归（不占切片文件域，由 T-209 执行）：node workbench/mobile/avatar-parity.test.mjs、node workbench/scripts/avatar-photo.test.mjs、node workbench/scripts/agent-avatar.test.mjs。

## 5. 每个切片的「完成 = 什么」（对照需求，防黑盒）

| 切片 | 覆盖需求 | 观察点（可自动验证，不靠肉眼） |
| --- | --- | --- |
| S1 | R-2 / R-5 / R-7 / R-9（+ R-8 兜底分支） | /api/roster 的 external 条目 avatar 通过 isAvatarToken 且不再是齿轮 emoji；5 个已点名身份逐条等于冻结令牌；除 avatar 外字段与基线逐字段相同 |
| S2 | R-1 / R-4 / R-5 / R-7（+ R-8 两端一致） | 两端表格逐项相等；5 个位面 key 两两不同且不在 BUILTIN_ROLE_KEYS；resolveSlot(key) 非 null 且非 placeholder |
| S3 | R-3 / R-6 / R-9 | .user-avatar 与 .workspace-user 内是 AgentAvatar 图形节点；两处同常量；文件内无齿轮字符 / 「管」充当头像 |
| S4 | R-6（S8）/ R-10（AC-R6-4） | 不在目录的 id 仍有 AgentAvatar；无第二套视觉表；无破图路径（走组件回退） |
| S5 | R-7（文档面）/ E2 门禁 | evidence-banner --check 与 check-docs.mjs 退出码 0；过期口径短语为 0 |

## 6. 必须显式处理的锚点与风险（供 T-206 / T-207 / T-208 / T-209 / T-210）

| # | 锚点 / 风险 | 现状（实测） | 归属切片与要求 |
| --- | --- | --- | --- |
| E1 | team-hub/team-views-routes.test.mjs:137 断言 ext.avatar 等于齿轮 emoji —— **可执行测试把现状固化成期望** | 本会话 node team-hub/team-views-routes.test.mjs = 17 例全绿 | **S1**：改写期望而不是删除（它同时是 R-8 兜底的天然用例，造的是未登记名字 solo-soldier） |
| E2 | docs/G-mv7kzgnu-1/ 缺历史快照 banner | 本会话 node scripts/ci/evidence-banner.mjs --check = FAIL（1 个目录缺 banner，已覆盖 84），点名 docs//G-mv7kzgnu-1；REQUIREMENTS.md 无 banner，RESEARCH.md 尚在 T-204 worktree | **S5**：给 REQUIREMENTS.md 与（已 promote 的）RESEARCH.md 补 banner；本文件（T-205 产物）已自带 banner。**T-206 / T-209 / T-210 的新文档也必须自带 banner**，否则 S5 的 --check 会红 |
| R-8 容量 | 方案 A 默认（备用池不扩容）下，5 个已点名身份占满 s11..s15，**未登记的新外部名字没有空闲位面可分配**，只能落空串（占位） | RESEARCH §4.3 / §6.5 / §6.6 / RK-A2 | **S1** 实现兜底分支并测两条路径；**T-206 不得把 AC-R8-1 写成必过**，应显式记为「默认不满足 / 需扩容 s16..s24（4 处同步：slots.ts、mobile/avatar.mjs、agent-avatar.test.mjs 的 SPARES、avatar-parity.test.mjs 的 40 断言）」；扩容超出方案 A 默认，待将军裁决 |
| 移动端 | 外部执行者**不进** /api/agents（read-models.mjs:256 只投影 roster），因此不出现在移动端成员列表 | RESEARCH §2.3 口径修正 | **不设移动端切片**；移动端只用既有 avatar-parity.test.mjs 守「同一 token 两端同位面」（AC-R6-2），由 T-209 复跑 |
| 3D / 文案 | Employee3D 的 external 统一灰人（D-4 不联动）；done 任务推导出的身份仍显示「· 执行中」（D-2 另立 bug） | REQUIREMENTS §2.3 / RK-10 | **不设切片**；本目标只补头像，不夹带 |
| 反例 | human:general 语法合法但位面表无 general key ⇒ 仍落占位人形 | RESEARCH §2.2 实测（renderAvatar('human:general') 与空串渲染相同） | **T-206 必须钉住**：R-1 判据是「合法 **且** resolveSlot 非 null」，只看格式会把假绿当通过 |
| 归因 | 团队经验 T-196（上一轮同题）：将军要求「创建时自动生成头像 / 必须拟人非 emoji / 范围含后续自建」 | 本目标 contextVersion=0 为空 | 本拆解按同语义取默认（拟人矢量、含后续自建兜底口径），但**不当作本目标裁决**；如需沿用请将军写入目标上下文 |

### 各阶段交接要点

- **T-206 test-designer**：直接转 M-1~M-7 与 AC-R1-1/2/3、AC-R2-1/2/3/4、AC-R3-1/2/3、AC-R4-1/2/3、AC-R5-1/2/3/4、AC-R6-1/2/4、AC-R7-1/2/3、AC-R9-1/2/3/4、AC-R10-1/2/3；必须显式改写 E1 期望与上一目标 docs/G-mv1s6y49-1/TEST_CASES.md:181 的 TC-S3-07 口径（**不改该文件**，只在本目录写新口径）；新文档自带 banner。
- **T-207 coder**：按 §1.1/§1.2 冻结契约与 §3 顺序落地；不要用哈希做主口径、不要落 roster 行、不要动 role / agent_registry / appearanceSeed / Employee3D 调色板 / 位面表。
- **T-208 reviewer 必查**：AC-R4-2（不与内编撞位面）、AC-R7-1（读出口无非法令牌）、AC-R9-2（成员计数不变）、AC-R5-3（纯函数无随机/时钟）、C3（是否偷偷新增了第二套**视觉**表）。
- **T-209 tester**：验收含「枚举脚本复跑（不满足 = 0）」「连续 3 次请求 + 重启后令牌不变」「桌面/移动端同位面 parity」「图片 404 / 令牌非法降级」「其它空间令牌逐条不变」五组；移动端不设展示用例（见上表）。
- **T-210 devops**：部署后提示强刷 / 清 Service Worker（workbench/mobile/sw.js 对非代码资源走 cacheFirst，RK-8）；并在 promote 前跑 node scripts/ci/evidence-banner.mjs 与本目录 banner 覆盖检查（E2）。

## 7. 本阶段自检（逐条对应 T-205 任务验收标准）

| 任务验收标准 | 对应章节 | 结论 |
| --- | --- | --- |
| 把需求 / 方案拆成可独立认领、可独立验收的子任务 | §1（冻结契约）+ slices 小节（S1~S5，每片一个垂直单元 + 独立文件域 + 独立命令） | ✅ 5 个切片，均来自 RESEARCH 方案 A 的推荐落点，无悬空任务 |
| 每个子任务带：验收标准 + 依赖关系（blockedBy）+ 工作量估计 | slices 小节第四段（命令+期望）+ §3 表（blockedBy 与工作量） | ✅ 每片都有可跑命令与阻塞关系，无循环依赖 |
| 每个子任务有「完成 = 什么」的可测口径，不留不可验收的黑盒 | §5 表（切片 → 需求 → 观察点）+ slices 小节第四段 | ✅ 全部为退出码 / 断言 / 文件内容判据，无「应该没问题」 |
| 任务顺序 / 并行关系明确，无循环依赖、无遗漏 | §3（依赖图 S1→S2→{S3,S4}→S5）+ §4（四波派工） | ✅ 最长路径单向；移动端 / 3D / 文案等**故意不设切片**并在 §6 说明理由，非遗漏 |
| 边界：不写实现、不改需求语义与方案结论 | 全文只给判据与冻结接口；§1.1/§1.2 逐字承接 RESEARCH §6 默认值 | ✅ 本阶段未改任何仓库实现，唯一改动 = 本文件 |
| 上游依赖：T-204 应已完成 | 文档头「上游依赖落实情况」：REQUIREMENTS 在 main，RESEARCH 在 w/T-204 worktree（未提交） | ⚠️ 已在 §6 锚点 E2 记录，不阻塞拆解 |
