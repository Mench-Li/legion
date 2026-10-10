<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-10-10**（commit `272e23a7`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-197 任务拆解：Agent 人性化名称 + 人性化头像（并行切片）

> 角色：breaker（任务拆解）｜阶段：任务拆解｜执行任务：T-197（[auto-goal]｜所属目标 G-mv1s6y49-1 · software · chain）
> 上游：[REQUIREMENTS.md](./REQUIREMENTS.md)（T-195 需求：R-1~R-11 + AC-R* + D-*）→ [RESEARCH.md](./RESEARCH.md)（T-196 方案：推荐方案 A「自研参数化人形内联 SVG + 静态 role→位面表 + avatar 存 `human:<id>` 令牌」与「静态 role→展示名一对一表」）
> 目标上下文（将军裁决，v1）：创建时自动生成头像、暂不需要配置；头像必须拟人且非 emoji；范围包含全部（含后续自建）；两段式命名。
> 下游：守护解析本文件「## slices」注册切片（**每个切片 = coder_Si → tester_Si 微链**，见 [sliceOrchestration.ts](../../plugins/src/sliceOrchestration.ts)）；阶段链 T-198 用例设计 → 各切片 coder/tester → T-200 reviewer → T-201 tester → T-202 devops
> 评估基线：**w/T-197 HEAD `3ba01559`**（本会话实测，Node v24.19.0）；本文 file:line 均指本 worktree 内容；**本阶段只产出本文档，不改任何仓库实现**。

---

## 0. 结论速览（TL;DR）

拆解产物：**7 个切片（S1~S7）**，文件域两两不相交（逐文件核对，见 §5.3），全部映射 R-1~R-11：

- **前端头像基座（P0，无前置）**：S1 = 参数化人形内联 SVG 组件 + 位面表（25 岗位 + `s01`..`s15` 备用）+ 令牌解析 + 现有文本徽章 CSS 图形化。这是唯一被其他前端切片引用的基座。
- **数据面（P0，无前置）**：S2 = 静态 `role→展示名` 一对一表 + 种子重写（幂等 + 不覆盖自定义）。
- **接口面（P0，无前置）**：S3 = 新建成员自动分配人形令牌（不再默认 `'🤖'`）+ 三个读出口兜底收敛。
- **展示面接入（P0，依赖 S1）**：S4 = 人员目录/Agent 头部/中心面板/场景列表（展示面 S1~S4、S8）；S5 = 新建空间/模型设置/技能授权/任务弹窗（S9~S12）。
- **移动端（P2，依赖 S1）**：S6 = S13 成员选择与会话头的内联人形头像（`<option>` 装不下图片，必须改交互结构）。
- **收口（P2，依赖 S1~S6）**：S7 = 六个新增测试文件登记进 `scripts/ci/run-ci.mjs` + 受影响文档同步。

四条硬约束：

1. **零新增第三方依赖**（REQUIREMENTS A-6 / AC-R8-2）：头像 = 内联 SVG 由代码生成，不引入 DiceBear 等任何库（RESEARCH §0/§6.1）。
2. **零文件域交叉**：除 `workbench/src/index.css` 与 `workbench/src/workspace.css` 归 S1 独占外，**无任何文件出现在两个切片**（详见 §5.3）；`scripts/ci/run-ci.mjs` 是新增测试文件的**唯一登记面**，只归 S7。
3. **切片间无 blockedBy 机制**：守护只给每个切片 `blockedBy = [test-designer 任务]`（[server.mjs:5404-5441](../../team-hub/server.mjs#L5404-L5441)），**切片之间不会自动串行**；默认并发 2 个 coder 槽（[index.ts:202-204](../../plugins/src/index.ts#L202-L204)、[:3652-3670](../../plugins/src/index.ts#L3652-L3670)）。因此本文按**拓扑顺序注册**（§5.1），并明示 S4/S5/S6 必须先有 S1 合入。
4. **沙箱实测**：本机 `node --test <file>` 与 `pnpm` 因 spawn EPERM 不可用；等价直跑命令见 §8.3（已实测）。

---

## 1. 拆解口径与依据

- 上游 REQUIREMENTS 的 R-1~R-11 与 AC-R* 是**验收条款**，RESEARCH §8/§9 的落点是**文件域骨架**；本文只做切分与排序，**不改变需求语义与方案结论**（任务边界「不做：不改变需求语义与方案结论」）。
- 切片粒度 = **一个士兵一轮可独立实现、独立验收的垂直单元**（一个模块/一个数据面/一组展示面 + 其测试），验收写成「命令 + 期望」。
- 切片数量 7，落在允许区间 2~8。
- **同文件独占**：`workbench/src/index.css` 与 `workbench/src/workspace.css`（压缩/长行文件）归 S1；四个前端组件面按文件分给 S4/S5；`scripts/ci/run-ci.mjs` 归 S7。任何切片不得越界改别人的文件域。
- **不做**：不写实现、不跑 taskctl、不 push、不联网（LEGION.md 变更纪律）。
- **与本目标其他任务的衔接**：T-198 用例设计可直接把本文各切片第 4 段转成用例；T-201 的验收须含「展示面遍历」与「人工抽检判据（M-6）」。

---

## 2. 需求 → 切片映射（覆盖性检查）

| 需求 | 优先级 | 承载切片 | 覆盖说明 |
| --- | --- | --- | --- |
| R-1 人性化展示名（2~6 汉字、可读职能） | P0 | S2 | 静态 `role→名` 一对一表 + 种子；职能由既有 `kind` 承载（两段式） |
| R-2 唯一性与身份稳定（name/avatar 不进身份） | P0 | S2（同空间/全局名唯一）+ S1/S4/S5（avatar 只做渲染入参，静态扫描断言不进 key） | `sceneState.ts:69` 的 key 仍是 `scope+role`，不动 |
| R-3 人性化头像（人形、可辨、可区分、稳定） | P0 | S1 | 参数化人形内联 SVG；位面表 >=40 个 key（25 岗位两两不同 + 15 备用） |
| R-4 全展示面一致（消除 3 套来源 + 首字回退） | P0 | S4（S1~S4、S8）+ S5（S9~S12）+ S6（S13） | 逐面改用同一 `AgentAvatar`；S4 删除 `CenterPanel` 的动物表 `AVATARS` |
| R-5 跨空间同 role 名称/头像一致 | P1 | S2（name 是 role 的单射）+ S3（令牌由 role 决定） | `/api/agents` 首见合并（`read-models.mjs:256-263`）不再有漂移源 |
| R-6 成员编辑入口与持久化 | P1 | **不做（将军裁决 #1）** | 裁决「创建时自动生成头像，暂不需要配置」；既有 `POST /api/agents` upsert 能力保留，不新增 UI |
| R-7 开箱即用 + 新建不再默认 `'🤖'` | P1 | S2（种子）+ S3（接口缺省）+ S5（去掉新建弹窗的 emoji 下拉） | 空库播种后 `COUNT(avatar='🤖')=0` |
| R-8 离线自足、零新增依赖 | P1 | S1（内联 SVG 无网络/无静态根）+ S7（断言 `package.json` 未新增依赖） | 内联 SVG 绕开 `workbench/dist` 与 `workbench/mobile` 两个静态根与 SW 长缓存 |
| R-9 回退与降级 | P2 | S1（令牌非法/缺省 → 确定性灰阶占位人形）+ S6（移动端降级为纯名称不报错） | 回退只发生在渲染态，不写回 roster |
| R-10 无损迁移与自定义保护 | P2 | S2 | 种子只替换「旧默认值白名单」，自定义 name/avatar 保留；行数与主键不变 |
| R-11 移动端与 3D 覆盖 | P2 | S6（移动端 S13）；**3D 标签无需改动** | S6 见 `Employee3D.tsx:122-128` 只显示 name，已取同一 roster 来源；3D 人物外观（`sceneState.ts:75` 的 `appearanceSeed`）按 ❓O-3 默认**不联动** |

**13 个展示面的切片归属（RESEARCH §2.3 编号）**：

| 展示面 | 位置（本 worktree 实测） | 承载切片 |
| --- | --- | --- |
| S1 人员目录列表行 | `WorkspaceNavigation.tsx:62` | S4 |
| S2 Agent 工作区头部 | `AgentWorkspace.tsx:111` | S4 |
| S3 中心面板 Agent 卡 | `CenterPanel.tsx:216`、`:236` | S4 |
| S4 中心面板 v1 动物兜底 | `CenterPanel.tsx:21`、`:49` | S4（删除） |
| S5 服务端兜底 | `team-views.mjs:84`（`'🤖'`）、`:117`（`'⚙️'`） | S3（`'🤖'` → 令牌；外部执行者 `'⚙️'` 保持） |
| S6 3D 员工标签 | `Employee3D.tsx:122-128` | **无改动**（name 已同源） |
| S7 3D 人物外观 | `Employee3D.tsx:50`、`sceneState.ts:69,75` | **无改动**（O-3 不联动） |
| S8 场景 Agent 列表 | `SceneAgentList.tsx:15` | S4 |
| S9 新建空间选人/新建智能体 | `NewSpaceModal.tsx:12,28,182,197` | S5（去掉 emoji 下拉） |
| S10 模型设置成员行 | `ModelConfigModal.tsx:122` | S5 |
| S11 技能授权成员名 | `SkillsPanel.tsx:318,767,786` | S5 |
| S12 任务弹窗成员 | `AgentTasksModal.tsx:95` | S5 |
| S13 移动端 | `workbench/mobile/app.mjs:401-407` | S6 |

> **无遗漏**：R-1~R-11 与 13 个展示面全部有承载切片或「无改动」的明确判定；无「无法验收的悬空任务」——每个切片第 4 段都是可跑的 node 命令 + 期望。

---

## slices
- S1 | 头像基座：参数化人形内联 SVG 组件 + 位面表 + 令牌解析 + 文本徽章 CSS 图形化 | workbench/src/avatar/, workbench/src/index.css, workbench/src/workspace.css, workbench/scripts/agent-avatar.test.mjs | node workbench/scripts/agent-avatar.test.mjs 退出码 0 且 fail 0（仿 doc-render.test.mjs 的 ts.transpileModule + react-dom/server renderToString 范式，已实测可用）：渲染结果含 <svg 且不含单个 Unicode 字符文本节点（AC-R3-1）；位面表 key 集合含 25 个岗位 role 与备用 s01..s15 共 >=40 个、位面两两不同（AC-R3-3）；同 token 连续两次渲染结果逐字节相同且不依赖时间或随机（AC-R3-4）；未知或空或 emoji 旧值 token 渲染确定性灰阶占位人形而不是名称首字或 emoji（R-9/AC-R9-2）；25 个 role 各有且仅有一个位面（一对一，可断言单射）；组件 props 与导出名符合 §7 冻结契约；node node_modules/typescript/bin/tsc --noEmit 在 workbench 目录退出码 0；workbench/package.json 的 dependencies 未新增任何条目（AC-R8-2）；只改本切片文件域
- S2 | team-hub 数据面：静态 role→展示名一对一表 + 种子重写（幂等、不覆盖自定义） | team-hub/scripts/seed-roster.mjs, team-hub/scripts/seed-roster.test.mjs | TEAM_HUB_DB 指向临时库时 node team-hub/scripts/seed-roster.test.mjs 退出码 0 且 fail 0：空库播种 5 空间 25 岗位后每个 name 非空、匹配 ^[一-龥]{2,6}$ 且不含 a-z0-9-_ 字符集（AC-R1-1）；25 个 name 两两不同、同空间重复计数 0（AC-R2-1）；avatar 全部匹配 ^human:[a-z0-9-]+$ 且 COUNT(avatar='🤖')=0（AC-R7-1）；跨空间同 role 的 name 与 avatar 各只有一个不同取值（AC-R5-1）；连续执行两次结果集逐行相同（AC-R7-3）；把某行改成自定义 name 与 human:zz9 后重跑该行不变、而旧默认职称名与 emoji 头像被替换为新值（AC-R10-1/AC-R10-2）；迁移前后 roster 行数、每个空间的 role 集合与 (scope,role) 主键集合均不变（AC-R10-3）；种子逻辑以可导出纯函数形式提供且 CLI 行为不变；只改本切片文件域
- S3 | team-hub 接口面：新建成员自动分配人形令牌 + 三个读出口兜底收敛 | team-hub/routes/agent-intake.mjs, team-hub/routes/team-views.mjs, team-hub/routes/read-models.mjs, team-hub/agent-intake-routes.test.mjs, team-hub/team-views-routes.test.mjs, team-hub/read-models-routes.test.mjs, team-hub/agent-identity-tokens.test.mjs | TEAM_HUB_DB 指向临时库时 node team-hub/agent-identity-tokens.test.mjs 退出码 0 且 fail 0：POST /api/agents 不带 avatar 或传空或传 '🤖' 时落库为 human:<role> 令牌而不是 emoji（AC-R7-2）；role 不在 25 岗位内时落到该 scope 内未被占用的最小备用 key sNN，同 scope 两名自建成员令牌互不相同（AC-R3-3/AC-R7-2）；跨 scope 同 role 恒得同一令牌（AC-R5-1）；name 缺省或空仍被拒（400，AC-R6-3，现状已满足只加断言）；GET /api/roster 的成员头像缺省不再是 emoji（外部执行者 '⚙️' 保持不变，术语表已排除）；GET /api/agents 跨空间首见合并后同 role 的 name 与 avatar 各只有一个取值（AC-R5-1）；node team-hub/agent-intake-routes.test.mjs 退出码 0 且 21 例不回归、node team-hub/team-views-routes.test.mjs 退出码 0 且 17 例不回归、node team-hub/read-models-routes.test.mjs 退出码 0 且 25 例不回归；只改本切片文件域
- S4 | 桌面展示面接入（一）：人员目录、Agent 头部、中心面板、场景列表 | workbench/src/components/WorkspaceNavigation.tsx, workbench/src/components/AgentWorkspace.tsx, workbench/src/components/CenterPanel.tsx, workbench/src/components/SceneAgentList.tsx, workbench/scripts/agent-avatar-surfaces.test.mjs | node workbench/scripts/agent-avatar-surfaces.test.mjs 退出码 0 且 fail 0（源码扫描，仿 identity-gate.test.mjs 的 readFileSync + 正则范式，已实测可用）：四个文件都出现 <AgentAvatar 且 WorkspaceNavigation.tsx 与 AgentWorkspace.tsx 不再有 name.slice(0, 1) 充当成员头像（AC-R4-1）；CenterPanel.tsx 不再定义 AVATARS 常量、不再有 i % 8 之类的第二套头像来源（AC-R4-4）；四个文件成员头像取值只来自 roster 的 avatar 令牌（或统一回退），无硬编码头像表（AC-R4-1）；CenterPanel.tsx 与 SceneAgentList.tsx 不再把 avatar 直接当文本节点渲染；node node_modules/typescript/bin/tsc --noEmit 在 workbench 目录退出码 0（前置条件：S1 已合入）；只改本切片文件域
- S5 | 桌面展示面接入（二）：新建空间、模型设置、技能授权、任务弹窗 | workbench/src/components/NewSpaceModal.tsx, workbench/src/components/ModelConfigModal.tsx, workbench/src/components/SkillsPanel.tsx, workbench/src/components/AgentTasksModal.tsx, workbench/scripts/agent-avatar-settings.test.mjs | node workbench/scripts/agent-avatar-settings.test.mjs 退出码 0 且 fail 0：NewSpaceModal.tsx 不再有 AVATAR_CHOICES emoji 表、不再有缺省 avatar '🤖'、新建智能体请求体不再提交 avatar 字段（AC-R7-2 与将军裁决「暂不需要配置」）；ModelConfigModal.tsx、SkillsPanel.tsx、AgentTasksModal.tsx 三处成员头像改用 <AgentAvatar 而不是把 avatar 当文本渲染（AC-R4-1）；SkillsPanel.tsx 的成员名与头像不再拼成一个纯文本字符串（S11 面一致）；四处均无硬编码第二套头像来源；node node_modules/typescript/bin/tsc --noEmit 在 workbench 目录退出码 0（前置条件：S1 已合入）；只改本切片文件域
- S6 | 移动端（S13）：成员选择与会话头的内联人形头像 + 与桌面位面表零漂移 | workbench/mobile/avatar.mjs, workbench/mobile/app.mjs, workbench/mobile/index.html, workbench/mobile/sw.js, workbench/mobile/avatar-parity.test.mjs | node workbench/mobile/avatar-parity.test.mjs 退出码 0 且 fail 0：mobile/avatar.mjs 的位面 key 集合与 workbench/src/avatar/slots.ts 逐项相同（读文件比对，防两套位面表漂移）；同 token 在移动端渲染出 <svg 而不再是 emoji 文本；app.mjs 的成员选择不再只用 <option> 文本承载成员（<option> 无法渲染图片），会话头渲染内联 SVG 人形（AC-R11-1）；令牌缺失或非法时降级为纯名称且函数不抛错（AC-R9-3）；node workbench/mobile/board.test.mjs、node workbench/mobile/timeline.test.mjs、node workbench/mobile/refresh-loop.test.mjs 三个基线套件退出码 0 不回归；只改本切片文件域
- S7 | 收口：六个新增测试文件登记进 CI 清单 + 受影响文档同步 | scripts/ci/run-ci.mjs, README.md, workbench/README.md, docs/FEATURES.md, docs/STATUS.md | node scripts/ci/run-ci.mjs --only test 的「套件清单完备性」段输出 PASS 套件清单完备且无 FAIL 套件清单不完备（新增六个 *.test.mjs 全部有归属：workbench/scripts/agent-avatar.test.mjs、team-hub/scripts/seed-roster.test.mjs、team-hub/agent-identity-tokens.test.mjs、workbench/scripts/agent-avatar-surfaces.test.mjs、workbench/scripts/agent-avatar-settings.test.mjs、workbench/mobile/avatar-parity.test.mjs）；已登记路径与仓库内实际文件逐一比对 0 缺 0 多；node scripts/ci/check-docs.mjs 退出码 0（README + docs/FEATURES.md 结构/索引/互链 + 本目录 banner 全覆盖，本会话基线 PASS）；workbench/README.md 的编队段与 docs/FEATURES.md §3.2 更新为新两段式展示名与人性化头像口径且不含过程叙事；README.md 与 docs/FEATURES.md 的功能索引 5 列不破；docs/STATUS.md 的测试基线更新为实测新读数；只改本切片文件域

## 4. 依赖关系（blockedBy）与工作量估计

工作量刻度：S ≈ 0.5 轮 ｜ M ≈ 1 轮 ｜ L ≈ 1 轮满 ｜ XL ≈ 1.5 轮（需再拆）。

| 切片 | blockedBy | 依赖理由 | 工作量 |
| --- | --- | --- | --- |
| S1 | 无（行内起点） | 位面表与组件是 S4/S5/S6 的公共前置；本身不 import 任何未落地模块 | L |
| S2 | 无 | 纯 team-hub 数据面，只 import 既有 `server.mjs` 的 db | M |
| S3 | 无 | 只依赖 §7 冻结的令牌字符串约定（`human:<key>`），不 import 前端代码 | M |
| S4 | S1 | 引用 S1 的 `AgentAvatar` 组件与 CSS 类 | M |
| S5 | S1 | 同上 | M |
| S6 | S1 | 引用同样的令牌契约，且 parity 测试读 `workbench/src/avatar/slots.ts` | L |
| S7 | S1, S2, S3, S4, S5, S6 | 登记清单按 §7 冻结路径写死，但完备性校验需六个文件已入库；文档须描述实现后的真实行为 | M |

**无循环依赖**：依赖沿「S1 基座 → {S4,S5,S6} 展示面 → S7 收口」与「S2/S3 数据与接口面」两个方向，最长路径 S1→S6→S7 或 S1→S4→S7，无回边。

**⚠️ 机制提醒**：守护注册切片时只写 `blockedBy = [test-designer 任务]`（[server.mjs:5420](../../team-hub/server.mjs#L5420)），**上表的 blockedBy 不会变成任务的依赖字段**——它只是本文给人看的排序依据。落地时靠 §5.1 的注册顺序 + coder 槽位（默认 2）近似满足；**并发 >2 时严禁把 S1 与 S4/S5/S6 同时派工**。

---

## 5. 执行顺序与并行关系

### 5.1 注册顺序 = 派工顺序（守护按注册顺序派工）

S1 → S2 → S3 → S4 → S5 → S6 → S7。

- 第 1 对（S1、S2）互相独立，可并发；第 2 对（S3、S4）中 S3 与 S1 无关、S4 依赖 S1（按顺序 S1 已先完成）；第 3 对（S5、S6）均依赖 S1；S7 最后。
- 若 S1 一轮未完成而 S4 已被派工，S4 会因找不到 `workbench/src/avatar/` 的模块而 typecheck 失败——这是**已知的串行约束**，不是 S4 的实现缺陷；S4 的源码扫描测试仍可独立通过。

### 5.2 可并行组合

| 组合 | 是否可并行 | 依据 |
| --- | --- | --- |
| S1 与 S2 | ✅ 可并行 | 文件域不相交（`workbench/src/**` 对 `team-hub/scripts/**`） |
| S2 与 S3 | ✅ 可并行 | 数据面（种子）对接口面；令牌格式已在 §7 冻结 |
| S4 与 S5 与 S6 | ✅ 可并行（均在 S1 合入后） | 四个组件文件域互不相交，移动端目录独立 |
| S3 与 S4/S5/S6 | ✅ 可并行 | team-hub 对 workbench |
| S4/S5/S6 与 S1 未完成 | 🚫 不建议 | 组件模块尚不存在，frontend typecheck 必红 |

### 5.3 文件域独占核对（逐文件，零交叉）

| 文件 | 唯一归属 |
| --- | --- |
| `workbench/src/avatar/**`、`workbench/src/index.css`、`workbench/src/workspace.css` | S1 |
| `team-hub/scripts/seed-roster.mjs`（+ 新测试） | S2 |
| `team-hub/routes/agent-intake.mjs`、`team-hub/routes/team-views.mjs`、`team-hub/routes/read-models.mjs`（+ 三个既有测试与新测试） | S3 |
| `workbench/src/components/WorkspaceNavigation.tsx`、`AgentWorkspace.tsx`、`CenterPanel.tsx`、`SceneAgentList.tsx` | S4 |
| `workbench/src/components/NewSpaceModal.tsx`、`ModelConfigModal.tsx`、`SkillsPanel.tsx`、`AgentTasksModal.tsx` | S5 |
| `workbench/mobile/avatar.mjs`、`app.mjs`、`index.html`、`sw.js` | S6 |
| `scripts/ci/run-ci.mjs`、`README.md`、`workbench/README.md`、`docs/FEATURES.md`、`docs/STATUS.md` | S7 |

> **明确不改**：`team-hub/server.mjs`（列级 `avatar TEXT DEFAULT '🤖'` 保持——它只影响绕过 API 的直接 SQL，改它会把 emoji 语义搬进 20+ 处测试夹具；R-7 的「新建不默认 🤖」由 S3 的 API 路径承载，产品面靠 S1 的统一回退不出现 emoji 头像）、`team-hub/agent-conversations.mjs`（registry 复制逻辑无需改，原样复制令牌即可）、`Employee3D.tsx` 与 `sceneState.ts`（O-3 不联动）、`roles.json` 与 `roles-ozon.json`（role 机器键不可改）。

---

## 6. 子任务明细（完成 = 什么 / 测试锚点 / 纪律）

> 每切片的**可测口径以「## slices」对应行第 4 段为准**；以下为给人看的落地要点。

### 6.1 S1 头像基座【R-3 + R-9 + R-8 · 工作量 L】

- **目标**：新增 `workbench/src/avatar/` —— 位面表（25 个岗位 role + 备用 `s01`..`s15`，每个位面是一组人形特征数据：肤色/发型/发色/上衣/配饰/眼镜/胡须）+ 纯解析函数 `resolveSlot(token)` + React 组件 `AgentAvatar`；艺术语言复用 `Employee3D.tsx:8,12-38,99-103` 的肤色 `#e9bd93`、发色 `#28364b`、6 色上衣，保证 2D 名册与 3D 场景同调（RESEARCH RK-A2）。组件形态直接沿用 `UiIcon.tsx:1-16` 的「数据表 + `<svg viewBox="0 0 32 32">`」零依赖先例。
- **产出**：`workbench/src/avatar/slots.ts`、`AgentAvatar.tsx`、`avatar.css`、`index.ts`；`workbench/src/index.css` 与 `workbench/src/workspace.css` 中现有文本徽章类（`.agent-avatar` [:708-718](../../workbench/src/index.css#L708-L718)、`.ao-avatar` [:2548](../../workbench/src/index.css#L2548)、`.scene-agent-avatar` [:845](../../workbench/src/index.css#L845)、`.agent-tag-avatar` [:1448](../../workbench/src/index.css#L1448)、`.directory-avatar`）的图形化适配；`workbench/scripts/agent-avatar.test.mjs`。
- **DoD**：`node workbench/scripts/agent-avatar.test.mjs` exit 0（范式已实测：`doc-render.test.mjs` 11 例 pass）；`node node_modules/typescript/bin/tsc --noEmit`（cwd=workbench）exit 0（基线实测 0）。
- **测试锚点**：renderToString 含 `<svg`、25+15 位面两两不同、同 token 幂等、非法/空/emoji → 占位人形、25 role 单射。
- **纪律**：`workspace.css` 是压缩/长行文件（26.5 KB），改动必须整行处理且**只归 S1**；不引入任何图片资源与静态文件（避免 `workbench/dist` 与 `workbench/mobile` 两个静态根与 SW 长缓存）；`avatar` 不得进入任何 key/唯一约束（身份红线 `design:81`）。

### 6.2 S2 数据面：名称表与种子【R-1 + R-2 + R-5 + R-10 + R-7 · 工作量 M】

- **目标**：把 `seed-roster.mjs:19-55` 的 `ROSTERS` 由「职称 + emoji」改为「两段式展示名 + `human:<role>` 令牌」；抽出可导出纯函数（如 `buildRosterSeed()` 与 `applyRosterSeed(db, opts)`）供测试直调，CLI 行为不变；把无条件覆盖（`:66-69`）改为「只替换旧默认值白名单（旧职称名 / 旧 emoji 集 / 空），保留用户显式自定义值」，满足幂等与 AC-R10-1。
- **产出**：`team-hub/scripts/seed-roster.mjs`、`team-hub/scripts/seed-roster.test.mjs`。
- **DoD**：`TEAM_HUB_DB` 指向临时库时 `node team-hub/scripts/seed-roster.test.mjs` exit 0（临时库范式见 `team-hub/agent-intake-routes.test.mjs:20`）。
- **测试锚点**：空库播种后 name/avatar 形态、全局唯一、跨空间同 role 一致、两次幂等、自定义保留、旧默认替换、行数/主键不变。
- **纪律**：改 `name` 不动 `role`（契约键）；不新增依赖；不删既有 25 行中的任何 role。

### 6.3 S3 接口面：令牌缺省与读出口【R-7 + R-5 + R-3 + R-6 校验 · 工作量 M】

- **目标**：`agent-intake.mjs:86` 的缺省 `'🤖'` 改为自动分配人形令牌（role 在 25 岗位内 → `human:<role>`；否则取该 scope 内未占用的最小 `sNN`）；`agent-intake.mjs:153-163` 的复制入编路径原样复制令牌；`team-views.mjs:84` 的成员历史兜底 `'🤖'` 改为令牌（`:117` 外部执行者 `'⚙️'` 保持不变）；`read-models.mjs:256-263` 保持按 role 首见合并但断言同 role 的 name/avatar 恒单值。
- **产出**：三个路由文件 + 三个既有测试更新 + 新增 `team-hub/agent-identity-tokens.test.mjs`。
- **DoD**：新增测试 exit 0；三个基线套件不回归（本会话实测：21 / 17 / 25 例）。
- **测试锚点**：API 缺省令牌、备用 key 同 scope 不重复、跨 scope 同 role 一致、空名仍 400、roster/agents 读出口单值。
- **纪律**：不动 `team-hub/server.mjs` 的列级 DEFAULT；不改外部执行者 `'⚙️'` 口径；不新增写入口与鉴权旁路。

### 6.4 S4 桌面展示面（一）【R-4 · 工作量 M】

- **目标**：把 `WorkspaceNavigation.tsx:62` 的 `a.name.slice(0, 1)`、`AgentWorkspace.tsx:111` 的 `agent.name.slice(0, 1)` 换成 `<AgentAvatar token={a.avatar} ... />`；`CenterPanel.tsx` 删除 `:21` 的 `AVATARS` 动物表与 `:49` 的轮换，`:216`/`:236` 改用组件；`SceneAgentList.tsx:15` 改用组件。
- **产出**：四个 tsx + `workbench/scripts/agent-avatar-surfaces.test.mjs`。
- **DoD**：源码扫描测试 exit 0；`node node_modules/typescript/bin/tsc --noEmit`（cwd=workbench）exit 0（前置：S1 已合入）。
- **测试锚点**：四个文件均含 `<AgentAvatar`、无 `name.slice(0, 1)` 头像、无 `AVATARS`/`i % 8`、无硬编码头像表、无文本 avatar 渲染。
- **纪律**：不改 `index.css`/`workspace.css`（S1 独占）；不改组件内部；S11 面的文本拼接不在本切片。

### 6.5 S5 桌面展示面（二）【R-4 + R-7 · 工作量 M】

- **目标**：`NewSpaceModal.tsx` 删除 `:12` 的 `AVATAR_CHOICES`、`:28`/`:64` 的缺省 `'🤖'`、`:182`/`:197` 的 emoji 下拉与提交体里的 `avatar` 字段（将军裁决「创建时自动生成头像，暂不需要配置」）；`ModelConfigModal.tsx:122`、`SkillsPanel.tsx:318,767,786`、`AgentTasksModal.tsx:95` 改用 `<AgentAvatar`。
- **产出**：四个 tsx + `workbench/scripts/agent-avatar-settings.test.mjs`。
- **DoD**：源码扫描测试 exit 0；`node node_modules/typescript/bin/tsc --noEmit`（cwd=workbench）exit 0（前置：S1 已合入）。
- **测试锚点**：无 emoji 头像表与缺省 `'🤖'`、请求体无 `avatar`、三处非文本头像、S11 分层渲染。
- **纪律**：不在本切片恢复「编辑成员」入口（R-6 依裁决不做）；不改 `api.ts` 的 `createAgent` 签名（可选参数保留兼容）。

### 6.6 S6 移动端 S13【R-11 + R-9 · 工作量 L】

- **目标**：新增 `workbench/mobile/avatar.mjs`（纯 JS 位面表镜像 + 内联 SVG 字符串生成，零依赖）；`app.mjs:390-422` 的成员选择与会话头改为渲染内联 SVG 人形（HTML `<option>` 只渲染文本，必须改交互结构——RESEARCH §2.3 发现 1 / RK-M1）；`index.html` 加头像样式；`sw.js` 视需要提升缓存版本。`avatar-parity.test.mjs` 读 `workbench/src/avatar/slots.ts` 比对 key 集合，防止两套位面表漂移（仓库既有 `mobile-board-parity.test.mjs` 同范式）。
- **产出**：`workbench/mobile/avatar.mjs`、`app.mjs`、`index.html`、`sw.js`、`workbench/mobile/avatar-parity.test.mjs`。
- **DoD**：parity 测试 exit 0；三个既有多端套件 exit 0（`board.test.mjs` / `timeline.test.mjs` / `refresh-loop.test.mjs`）。
- **测试锚点**：key 集合逐项相同、渲染出 `<svg`、非法令牌降级为纯名称不抛错、既有 3 套件不回归。
- **纪律**：移动端是**独立静态根**（`workbench/mobile`，见 `routes/mobile.mjs`），不得引用 `workbench/src/` 的 TS 源（运行期不可达）——只做位面表镜像 + parity 测试；不改移动端其它页签与后端路由。

### 6.7 S7 收口：CI 登记与文档【R-8 + R-9 文档面 · 工作量 M】

- **目标**：把六个新增 `*.test.mjs` 登记进 `scripts/ci/run-ci.mjs` 的 `suites`（否则命中 [:5167-5255](../../scripts/ci/run-ci.mjs#L5167-L5255) 的「套件清单完备性」红）；同步 `README.md`、`workbench/README.md`（`:81-85`、`:92` 的职称清单与 emoji 描述）、`docs/FEATURES.md` §3.2（`:68-75`）、`docs/STATUS.md` 的测试基线。
- **产出**：`scripts/ci/run-ci.mjs`、`README.md`、`workbench/README.md`、`docs/FEATURES.md`、`docs/STATUS.md`。
- **DoD**：`node scripts/ci/run-ci.mjs --only test` 的完备性段 PASS；`node scripts/ci/check-docs.mjs` exit 0（本会话基线 PASS）。
- **测试锚点**：登记数 6、路径逐一存在、文档关键句与新口径一致、无过程叙事、索引 5 列不破。
- **纪律**：`scripts/ci/run-ci.mjs` 只归本切片（避免多切片同改冲突）；不改其它目标的阶段文档；`docs/G-mv1s6y49-1/` 下每个 md 必须带历史 banner（check-docs 的 `SNAPSHOT_RE` 会把 `G-*` 目录当证据快照，见 [check-docs.mjs:213](../../scripts/ci/check-docs.mjs#L213)）。

---

## 7. 跨切片共享契约（冻结，防两份实现漂移）

- **头像令牌**：`avatar = "human:" + key`；`key` 匹配 `^[a-z0-9][a-z0-9-]*$`。25 个内置岗位的 `key = role`（`human:requirement`、`human:coder` …）；非内置/自建 role 由 S3 分配备用 key `s01`..`s15`（**最小未占用者**，同 scope 内唯一）。
- **位面表（S1 定稿，S3/S6 消费）**：`workbench/src/avatar/slots.ts` 导出 `resolveSlot(token)`、`assertSlotTable()`（或等价）；key 集合 = 25 个 role + `s01`..`s15`，共 >=40，两两不同。**任何切片不得自写第二份位面表**（移动端例外：只允许镜像 + parity 测试，见 §6.6）。
- **组件契约（S1 定稿，S4/S5 消费）**：`workbench/src/avatar/AgentAvatar.tsx` 默认导出 `AgentAvatar`，props 为 `{ token?: string | null, name?: string, size?: number, className?: string }`；`token` 缺失/非法时渲染确定性占位人形（不显示名称首字、不显示 emoji）。
- **回退契约（R-9）**：回退只是渲染态，**不写回 roster**（AC-R9-2）；内联 SVG 无网络请求，因此不存在「破图」，也不需要 `onerror`。
- **身份红线（R-2）**：`name`/`avatar` 不得作为身份键、唯一约束或前端 key；前端 key 继续用 `scope + role`（`sceneState.ts:69`）。
- **CI 登记面（S7 独占）**：新增测试路径已在本文冻结为 6 条；S7 按此写死，不新增第 7 条。

---

## 8. 环境约束与验证纪律（本会话实测，下游必须遵守）

### 8.1 沙箱子进程限制（已实测）

- `node --test <file>` → **exit 1 / EPERM**（`node:test` runner 以管道 stdio spawn 子进程，被沙箱拒绝）。
- `node --test --test-isolation=none <file>` → **可用**（实测 `identity-gate.test.mjs` 19 pass）。
- `node <file>` 直跑 → **可用**（既有测试文件头部即写明这是沙箱等价口径）。
- `pnpm exec tsc` / `pnpm --dir workbench build` → **EPERM**（corepack 经管道 spawn）。
- 等价替代：`node node_modules/typescript/bin/tsc --noEmit`（cwd = `workbench`）→ **exit 0**。

**强制要求**：各切片的验收命令一律用 §8.3 的等价直跑形式；CI 全量门禁（`node scripts/ci/run-ci.mjs`）留到 devops/tester 在有完整沙箱权限的环境执行，本地受限时如实记录复现命令与输出，不得声称已跑。

### 8.2 数据与仓库隔离

- team-hub 侧测试一律 `process.env.TEAM_HUB_DB = <临时目录>/team.db` 后再 `import` `server.mjs`（范式：`agent-intake-routes.test.mjs:20`）；**禁止**对 live 库 `team-hub/team.db` 做写入型验证。
- 前端测试不引入 jsdom：用 `ts.transpileModule` + `renderToString`（范式：`doc-render.test.mjs:25-46`）或 `readFileSync` + 正则源码扫描（范式：`identity-gate.test.mjs`）。

### 8.3 基线命令（本会话实测，供逐条对照）

| 命令 | 本会话基线 | 用途 |
| --- | --- | --- |
| `node team-hub/agent-intake-routes.test.mjs` | exit 0（21 pass / 0 fail） | S3 回归锚点 |
| `node team-hub/team-views-routes.test.mjs` | exit 0（17 pass / 0 fail） | S3 回归锚点 |
| `node team-hub/read-models-routes.test.mjs` | exit 0（25 pass / 0 fail） | S3 回归锚点 |
| `node workbench/scripts/doc-render.test.mjs` | exit 0（11 pass / 0 fail） | S1 测试范式可用性证明 |
| `node workbench/scripts/identity-gate.test.mjs` | exit 0（19 pass / 0 fail） | S4/S5 源码扫描范式可用性证明 |
| `node node_modules/typescript/bin/tsc --noEmit`（cwd=`workbench`） | exit 0 | S1/S4/S5 前端门禁基线 |
| `node scripts/ci/check-docs.mjs` | PASS（写入本文前 15562、写后 15641 个表行，收尾/孤儿行 0 异常） | S7 文档门禁基线 |
| `node scripts/ci/evidence-banner.mjs --dry-run` | 新增标注 0 / 新建 0 / 已存在 81 | 本目录 banner 覆盖证据 |

> 基线 HEAD = `3ba01559575743934b4663fadc7c9e3268ce50d5`；Node = v24.19.0。

---

## 9. 风险、边界与不做

| 风险 | 影响切片 | 缓解 |
| --- | --- | --- |
| RK-A1 自绘人形的**观感**是否达「能看出是人形」（AC-R3-2 人工判据 >=4/5） | S1 | S1 先出 2~3 张 32px 样张给将军预审，再全量接入；样张不达标走 RESEARCH 方案 B（需将军放行一次性入库） |
| RK-A2 2D 头像与 3D 人物外观是两套绘制代码 | S1 | 复用 `Employee3D.tsx:8,99-103` 的皮肤/发色/上衣 6 色常量 |
| RK-M1 `<option>` 装不下图片 → 移动端必须改交互结构 | S6 | 单列切片（本节与 §6.6）；成本已计入 L |
| RK-W1 `workspace.css` 是压缩长行文件 | S1 | 样式优先落 `index.css`/新 `avatar.css`；必须改 `workspace.css` 时只由 S1 整行处理 |
| RK-R1「人性化」是主观判据 | S1/S2 | 保留 AC-R1-2/AC-R3-2 人工抽检 + 将军确认最终名单（❓O-1） |
| 两套位面表（桌面 TS + 移动端 JS）漂移 | S6 | `avatar-parity.test.mjs` 读文件逐项比对 key 集合 |
| 切片间无 blockedBy 机制、并发槽位 2 | S1/S4/S5/S6 | §5.1 拓扑注册顺序；并发 >2 时禁止同时派 S1 与 S4/S5/S6 |

**不做（任一切片不得越界）**：引入任何第三方头像库或新增运行时依赖；AI 在线生成头像 / 上传裁剪 / 在线图床 / Gravatar（REQUIREMENTS §5.2-4、A-6）；emoji、名称首字、几何色块、动物 emoji 作为成员头像（⚖️D-2）；改 `role` 机器键与流水线契约；把 `name`/`avatar` 当身份键；3D 人物外观与头像联动（O-3 默认不联动）；新增「编辑成员」UI（将军裁决 #1）；改 `team-hub/server.mjs` 的列级 DEFAULT；碰其它目标/其它任务的文档与产物。

---

## 10. 与本任务验收标准对照（自检）

| 本任务验收标准 | 本文落点 |
| --- | --- |
| 把需求/方案拆成可独立认领、可独立验收的子任务 | §2 覆盖性映射 + §0 七切片 + §5.3 文件域独占核对 |
| 每个子任务带验收标准 + 依赖关系（blockedBy）+ 工作量估计 | 「## slices」第 4 段（可测验收）+ §4（blockedBy 与工作量刻度） |
| 每个子任务有「完成 = 什么」的可测口径 | 每切片验收均为「node 命令 + 退出码/通过数期望」；§6 逐条给 DoD 与测试锚点 |
| 任务顺序/并行关系明确，无循环依赖、无遗漏 | §5.1 注册顺序 + §5.2 并行表 + §4 无回边说明 + §2 全覆盖检查 |
| 不写实现、不改需求语义与方案结论 | 全文只做切分与排序；§11 列出的接口冻结项是否需要将军复核已明示 |

---

## 11. 本阶段假设与待将军确认

- **假设 A1（接口冻结，非方案变更）**：令牌 `human:<key>` 中 `key = role`（内置 25 岗位）、备用 key `s01`..`s15`（自建/空间专属 role 由 S3 按 scope 分配最小未占用者）。这是 RESEARCH §0「静态 role→<id> 一对一表」与 §8「迁移按 role 生成令牌」的**最小可并行化落点**；若将军希望备用池更大或 key 换编码，只改 §7 一处，切片划分不变。
- **假设 A2（依将军裁决 #1）**：R-6「成员编辑入口」**不做**（暂不需要配置）；R-7 的「新建不再默认 🤖」只由 API 与新建弹窗承载，不改列级 DEFAULT。若将军要编辑入口，按 R-6 单开一个 P1 切片（文件域：新增组件 + `team-hub/routes/agent-intake.mjs` 的读接口），不影响本 7 切片。
- **假设 A3（沙箱等价口径）**：切片验收用 `node <file>` 直跑等价 `node --test <file>`；CI 全量门禁由 devops/tester 在有完整权限的环境执行。§8.1 已给出实测证据。
- **假设 A4（覆盖范围）**：5 空间 25 岗位 + 全部自建/空间专属 role（含 ozon 的 `soldier-*`）走同一套令牌与位面表；3D 标签只保证名称同源，人物外观不动。
- 本阶段不改需求语义与方案结论；上述假设若被将军修正，由守护带回并只影响对应切片的文件域或 §7 契约。
