# T-200 代码审查报告：Agent 人性化两段式展示名 + 参数化人形内联 SVG 头像

> 角色：reviewer（代码审查）｜任务：T-200｜所属目标：G-mv1s6y49-1（software · chain）｜依赖上游：T-199（coder，已 done）
> 审查对象：T-199 提交 `02da65f4`（合入 main 的合并提交 `05e1bd41`）
> 审查方式：只读代码 + 独立复跑 + 定向探针；**不替人改代码**
> 本报告落盘路径：`docs/review/T-200-REVIEW.md`（按仓库约定 per-task 独立文件，不写公共 `docs/REVIEW.md`）

---

## 0. 必须先说清的事实：本 worktree 不含 T-199 代码

- 本 worktree 分支 `w/T-200`，HEAD = `8ef43753`；T-199 的提交 `02da65f4` 与其合并 `05e1bd41` **不在本 HEAD 的祖先链上**：
  - `git merge-base --is-ancestor 02da65f4 HEAD` → exit 1；`Test-Path workbench/src/avatar/AgentAvatar.tsx` → False。
  - `git worktree list` 显示 main 在 `05e1bd41`（已含 T-199），T-199 代码在 `.legion-worktrees/T-199`（`02da65f4`）。
- 因此本次审查的**真实对象 = `02da65f4` 的 diff 以及它在 main（`05e1bd41`）树上的落盘代码**；所有复跑命令都在 main worktree 只读执行，未修改任何仓库代码。
- 本 worktree 里另有 `desktop/package.json`、`product/release/runtime-manifest.json` 处于已修改状态，`desktop/pnpm-lock.yaml`、`desktop/pnpm-workspace.yaml` 未跟踪——这些是**别的任务/版本的改动**（版本号 0.1.3→0.1.4），不属于 T-200，按 LEGION.md 工作区边界纪律**原样保留、未触碰**。

---

## 1. 验收标准逐条对照

### 1.1 任务级验收标准（审查员三条）

| 验收标准 | 结论 | 依据 |
| --- | --- | --- |
| 对照验收标准与编码规范逐条审查，每条结论有依据 | ✅ 满足 | 本文 §1.2 逐条对照 R-1~R-11；§2 给出可复跑命令与读数；§4 每条问题带 位置 + 探针/源码依据 |
| 给出问题清单：每项含 严重度 + 位置 + 修改建议 | ✅ 满足 | §4 共 11 项，每项均含「严重度 / 位置 / 修改建议」 |
| 明确区分「必须修改」与「建议优化」 | ✅ 满足 | §4.1 必须修改（2 项）与 §4.2 建议优化（9 项）分栏 |

### 1.2 目标级验收条款（REQUIREMENTS R-1~R-11 与 AC）对照

| 需求 | 结论 | 依据（位置 / 证据） |
| --- | --- | --- |
| R-1 人性化展示名（2~6 汉字 + 职能） | ✅ 数据面满足；❓O-1 名单待将军确认 | `team-hub/scripts/seed-roster.mjs` 两段式种子；S2 测试断言 `^[一-龥]{2,6}$`、25 名两两不同，实测 6 pass |
| R-2 唯一性与身份稳定（name/avatar 不进身份键） | ✅ 满足 | 四个展示面与 `AgentAvatar.tsx` 均无 `key={...avatar}`（S4 扫描测试 TC-S4-11 + 源码 grep）；`sceneState.ts:69` 的 key=scope+role 未改 |
| R-3 人性化头像（人形/可区分/稳定） | ⚠ 基本满足，但备用池越界（见 M1）；AC-R3-2「人形可辨」为人工判据，留 T-201 | S1 测试 9 pass（`<svg>`、无文本节点、25 两两不同、同 token 幂等）；AC-R3-2 属视觉判据，源码扫描无法证明 |
| R-4 全展示面一致（消除 3 套来源与首字回退） | ✅ 代码层满足 | 四处 `name.slice(0,1)` 与 `AVATARS` 表已清零（git grep 命中 0）；S4/S5 扫描测试 5+6 pass |
| R-5 跨空间同 role 名称/头像一致 | ✅ 满足 | 令牌由 role 单射（`human:<role>`）；S2/S3 测试实测通过 |
| R-6 成员编辑入口 | ✅ 按将军裁决 #1「不做」 | 无新增编辑入口（S5 测试 TC-S5-08 反向锚定通过） |
| R-7 开箱即用 + 新建不再默认 🤖 | ✅ 满足 | 种子落令牌；新建不带 avatar 时 `allocateAvatarToken` 分配；S3 测试与探针确认不落 emoji |
| R-8 离线自足、零新增依赖 | ✅ 满足 | S1 测试 TC-S1-09/10：头像源码无 `fetch/http/img/url(`，`workbench/package.json` 依赖集未变；T-199 diff 未改任何 package.json |
| R-9 回退与降级 | ✅ 满足（移动端 `avatarLabel` 为死代码，见 S2） | 占位人形不写回（S3 TC-S3-10 读端点零写入）；移动端非法令牌不抛错（S6 TC-S6-04） |
| R-10 无损迁移与自定义保护 | ⚠ 自定义 name / 合法令牌保留；非令牌自定义头像被覆盖且无备份（见 S3） | S2 迁移测试 6 pass；`seed-roster.mjs:113-114` |
| R-11 移动端覆盖 | ✅ 满足 | `workbench/mobile/avatar.mjs` + `app.mjs` 药丸条/会话头内联 SVG；parity 测试 6 pass |

---

## 2. 独立复跑读数（main worktree，只读；HEAD `05e1bd41`）

> 沙箱限制：在 **main worktree** 中写文件被 DSH 沙箱拒绝（EPERM），`agent-avatar.test.mjs` / `avatar-parity.test.mjs` 会写临时文件，故这两支在本 worktree 内用**自带 scratch 目录 + 最小依赖副本**复跑（结构镜像 `workbench/`，不改任何仓库文件）。其余命令直接在 main worktree 运行。

| 套件 | 命令 | 读数 |
| --- | --- | --- |
| S1 头像基座 | `node workbench/scripts/agent-avatar.test.mjs` | **9 pass / 0 fail**，exit 0 |
| S2 数据面 | `node team-hub/scripts/seed-roster.test.mjs` | **6 pass / 0 fail**，exit 0 |
| S3 接口面 | `node team-hub/agent-identity-tokens.test.mjs` | **9 pass / 0 fail**，exit 0 |
| S4 展示面一 | `node workbench/scripts/agent-avatar-surfaces.test.mjs` | **5 pass / 0 fail**，exit 0 |
| S5 展示面二 | `node workbench/scripts/agent-avatar-settings.test.mjs` | **6 pass / 0 fail**，exit 0 |
| S6 移动端 | `node workbench/mobile/avatar-parity.test.mjs` | **6 pass / 0 fail**，exit 0 |
| 回归：agent-intake / team-views / read-models | `node team-hub/*-routes.test.mjs` | 21 / 17 / 25 pass，0 fail |
| 回归：mobile board / timeline / refresh-loop | `node workbench/mobile/*.test.mjs` | 21 / 16 / 6 pass，0 fail |
| 回归：sw-shell / identity-gate | `node workbench/scripts/*.test.mjs` | 7 / 19 pass，0 fail |
| 前端 typecheck | `node node_modules/typescript/bin/tsc --noEmit`（cwd=`workbench`） | exit 0 |
| 文档门禁 | `node scripts/ci/check-docs.mjs` | PASS（11 类校验全绿） |
| CI 登记 | `scripts/ci/run-ci.mjs` 内 6 条新套件 | 6 条齐全、路径均存在 |

**定向探针（我自己写的只读探针，导入真实 `team-hub/server.mjs`，临时库）实测输出：**

```
PROBE-1 idempotency: human:s01 / human:s02 / human:s01 -> DRIFT
PROBE-2 tokens: custom-1=human:s01 ... custom-15=human:s15 custom-16=human:s16
PROBE-2 mobile resolveSlot: s15=s15 s16=null(placeholder)
PROBE-2 slotKeys length=40 has_s16=false
```

## 3. 我动过什么 / 没动什么

- **没有修改任何产品代码、测试代码或文档。** 唯一落盘产物 = 本报告。
- 复跑 S1/S6 时在 `D:\project\DSH\legion\.legion-worktrees\T-200\.tmp-verify\` 下建过一次性 scratch（拷贝 `workbench/package.json`、`src/avatar/**`、`mobile/avatar*.mjs`、`mobile/app.mjs`、`index.html` 与 `react/react-dom/typescript` 最小依赖，仅用于绕过 main worktree 的写限制），**验证后已整目录删除**；`Test-Path .tmp-verify` = False。
- 未触碰 `desktop/package.json`、`product/release/runtime-manifest.json` 及两个未跟踪 pnpm 文件（非本任务）。

---

## 4. 问题清单

### 4.1 必须修改（Must Fix）

#### M1【中】备用头像池越界：服务端分配 s01..s99，位面表只有 s01..s15 —— 第 16 个自建成员起退化为占位人形

- **严重度**：中（契约层面是硬冲突；触发条件为同一 scope ≥16 个自建 role）
- **位置**：
  - `team-hub/agent-avatars.mjs:35`（`for (let i = 1; i <= 99; i += 1)`）
  - `workbench/src/avatar/slots.ts:22`（`SPARE_KEYS` 15 个）
  - `workbench/mobile/avatar.mjs:19`（镜像同样 15 个）
  - 冻结契约：`docs/G-mv1s6y49-1/TASK_BREAKDOWN.md` §7「备用 key `s01`..`s15`」
- **证据**：探针 PROBE-2 —— 连续创建 16 个自建 role，第 16 个落库为 `human:s16`；两端位面表 `slotKeys().length = 40` 且 `has_s16 = false`，`resolveSlot('human:s16') = null` → 渲染灰阶占位人形。违反 AC-R3-1（每个成员有可渲染人形）与 AC-R3-3（可区分）。
- **修改建议**：二选一并使三处口径一致：
  - (a) 把 `allocateAvatarToken` 上限改为 15，池满时走一个**明确定义**的回退（当前 `return 'human:' + role` 同样解析不到位面，仍渲染占位，需在契约中写清"池满即占位"）；或
  - (b) 把位面表扩到 s01..s99（`slots.ts` + `mobile/avatar.mjs` + parity 测试同步），并更新 TASK_BREAKDOWN §7 与 IMPLEMENTATION 文档。
  - 倾向 (b) 更贴合将军「范围包含全部含后续自建」，但 99 个位面需 `assertSlotTable()` 保证两两不同（构造合法即可）；无论选哪条，**"池满后是什么"必须有确定语义并被测试钉住**。

#### M2【中】同一自建 role 重复 POST 时头像漂移（非幂等 + 备用令牌抖动）

- **严重度**：中
- **位置**：`team-hub/routes/agent-intake.mjs:86-87`（upsert 路径无条件调用 `allocateAvatarToken`）+ `team-hub/agent-avatars.mjs:31-38`（`used` 集合把现有行自己的令牌也计入）
- **证据**：探针 PROBE-1 —— 对同一 `(software, hr-analyst)` 连续 3 次 `POST /api/agents`（不带 avatar），落库头像 `human:s01 → human:s02 → human:s01`（**DRIFT**）。
- **影响**：
  - 与 IMPLEMENTATION.md「头像由 role 单射决定、确定性」矛盾；自建 role 的头像实际是"每次 POST 重新摇号"；
  - 破坏 AC-R3-4 的稳定性承诺（同一 (scope, role) 多次落库头像不再恒定）与"服务端幂等"注释；
  - 每次重复提交都会占用并释放备用令牌，进一步放大 M1 的池耗尽风险。
- **修改建议**：分配前先查当前行的头像；只有"新建"或"现值非法/非令牌"时才分配，现值已是合法令牌则原样复用。示意（只给方向，不代改）：
  ```js
  const existing = db.prepare('SELECT avatar FROM roster WHERE scope = ? AND role = ?').get(targetScope, role.trim())
  const kept = existing && isAvatarToken(existing.avatar) ? existing.avatar : null
  const avatar = isAvatarToken(providedAvatar) ? providedAvatar : (kept ?? allocateAvatarToken(db, targetScope, role.trim()))
  ```
  并补一条"同一自建 role 重复 POST 头像不变"的用例（见 S7）。

### 4.2 建议优化（Suggested）

#### S1【低-中】创建接口接受任意"格式合法但不在位面表"的令牌，可绕过自动分配 / 造成同空间重像

- **位置**：`team-hub/routes/agent-intake.mjs:87`（只做 `isAvatarToken` 正则校验）、`team-hub/agent-avatars.mjs:16-20`
- **问题**：客户端显式传 `human:zzz` 会被原样落库，解析不到位面 → 渲染占位人形；同一 scope 两个成员还可被显式设成同一令牌（违反 AC-R3-3）。
- **建议**：创建路径只接受能解析到内置 25 key 或备用 sNN 的令牌，否则一律走分配；或在文档中显式声明"显式传令牌=高级用法，允许占位"。考虑到 UI 已不再提交 avatar，收敛风险很低。

#### S2【低】移动端 `avatarLabel(token, name)` 的 `token` 形参未使用，且 `app.mjs` 从未调用它

- **位置**：`workbench/mobile/avatar.mjs:61-63`；唯一调用方在测试 `workbench/mobile/avatar-parity.test.mjs:69-70`
- **建议**：要么在 `app.mjs` 降级路径真正使用，要么删除该导出并同步删除两条测试断言（AC-R9-3 已由"占位人形 + 名称常显"满足）。

#### S3【中】迁移覆盖非令牌自定义头像时不备份原值

- **位置**：`team-hub/scripts/seed-roster.mjs:114`（非令牌头像 → 直接替换为 `row.avatar`）
- **问题**：REQUIREMENTS ❓O-5 默认「一律替换为人形，但**迁移前备份原值并公示**」未落实；用户自选 emoji 头像被静默覆盖、不可追溯。
- **建议**：覆盖前把原值落审计/日志（或先公示），对齐 O-5；若将军认可直接覆盖，请在文档中显式豁免该默认。

#### S4【低】新建自建成员后本地目录以空令牌入列，弹窗内短暂显示占位人形

- **位置**：`workbench/src/components/NewSpaceModal.tsx:60-70`（成功回调里 `setCatalog(... avatar: '')`）
- **问题**：服务端已分配 `human:<key>`，但本地 catalog 写空串 → 在新空间弹窗的成员列表里该成员显示占位人形，直到重新 `fetchAgents()` 才恢复。
- **建议**：使用 `createAgent` 的返回值（服务端响应含分配后的令牌）填充本地 catalog，或创建后调 `loadCatalog()`。

#### S5【低】头像无障碍标签统一为「成员头像」，未带成员名；`name` prop 声明却未使用

- **位置**：`workbench/src/avatar/AgentAvatar.tsx:13`（`name?`）、`:47`（`aria-label="成员头像"`）；`workbench/mobile/avatar.mjs:88`
- **建议**：`aria-label={name ? name + ' 的头像' : '成员头像'}`（name 只用于可读文述，不作 key/唯一约束，不触身份红线）；移动端 `renderAvatar` 可加同义可选参数。

#### S6【低】桌面与移动端是两套渲染代码，parity 测试只比对位面字段、不比对生成的 SVG 标记

- **位置**：`workbench/mobile/avatar-parity.test.mjs`（只 `deepEqual` `resolveSlot` 结果与 key 集合）
- **问题**：任一侧修改 path/结构而字段不变时不会被测出，"零漂移"承诺只覆盖数据不覆盖渲染。
- **建议**：补一条"同一 token 两端 SVG 归一化后相同"的断言，或把标记拼接抽成可复用模板。

#### S7【低】测试缺口：未覆盖"重复 POST 幂等"与"备用池边界（第 15/16 个）"

- **位置**：`team-hub/agent-identity-tokens.test.mjs`
- **问题**：M1/M2 正是从这两个空白处逃逸的（现有 TC-S3-03 只验两名自建互不相同）。
- **建议**：补 `重复 POST 同一自建 role ⇒ 头像不变` 与 `第 15 个命中 s15、第 16 个行为符合契约` 两条用例。

#### S8【低】`GET /api/agents`（read-models）未收敛旧 emoji 令牌，与 `/api/roster`（team-views）口径不一致

- **位置**：`team-hub/routes/read-models.mjs:256-259`（原样投影 `r.avatar`；未改为"合法令牌或占位语义"）
- **说明**：前端统一用 `AgentAvatar` 渲染，旧 emoji 会显示为占位人形、**不会露出 emoji**，故产品面无害；但接口层仍可能吐出 `'🤖'`，与 S3 切片宣称的"三个读出口兜底收敛"不符。
- **建议**：与 `team-views.mjs:115` 同口径收敛为令牌或 `''`，或在文档中显式豁免该出口。

#### S9【低】「两段式」的职能段在中心面板/Agent 头部显示的是 role 机器键而非 kind

- **位置**：`workbench/src/components/CenterPanel.tsx`（`<div className="agent-role">{a.role}</div>`，两处）、`AgentWorkspace.tsx` 头部 `{agent.role}`（kind 只在页签栏与技能面板出现）
- **问题**：名称段（如「衡码」）本身不直述职能，而最显眼的编队卡片副标题给的是 `coder` 机器键，将军「起人性化但能体现功能属性的名字」在两段式主展示面读不到人可读职能。
- **建议**：卡片副标题改用/并列 `kind`（role 契约键仅作小号灰字），或在 `title` 中带上 kind。此项涉及展示口径，建议与将军确认选择后落到 S4/S5 展示面。**不改 role 契约键。**

#### 文档读数小误差（合并入 S8 之外单列一行）

- `docs/G-mv1s6y49-1/IMPLEMENTATION.md` §4 记 `sw-shell.test.mjs` 为 **6 pass**，实测 **7 pass**（预缓存清单加入 `avatar.mjs` 后用例数上升）。建议更正读数，避免下游 tester/devops 以旧基线对账。

---

## 5. 结论与残余风险

- **总体结论：T-199 的方向与主体实现正确、验证扎实**——六支新测试 41/41 通过、关键基线回归全绿、typecheck 0、文档门禁 PASS；AC-R2-3 身份红线、AC-R4-1 单一来源、AC-R8-2 零新增依赖、AC-R10-1 自定义保留均经独立复跑确认。**「必须修改」只有 2 项，都是自建 role 备用令牌路径的边界/幂等问题，不影响 25 个内置岗位的主路径。**
- **必须修改 2 项**（M1 池越界、M2 重复提交漂移）建议在 T-201 验收前修掉，并各补一条用例（S7）。
- **建议优化 9 项**不影响主路径放行，可按优先级处理。
- **留待 T-201（tester）的残余风险**（源码扫描测试无法证明，需人工/浏览器判据）：
  1. **AC-R3-2 人形可辨**与 **M-6 人工抽检**——需 32px 样张人工评审；
  2. **AC-R4-2 逐面一致 / AC-R4-3 无破图**——13 个展示面 × 5 空间 × 25 成员的浏览器遍历（含手机端 `<option>`→药丸条的新交互）；
  3. **css 落地范围**：S1 原定改 `workbench/src/index.css` / `workspace.css`，实际以新增 `workbench/src/avatar/avatar.css` 承载图形化适配（未改那两个文件）——需在真机/浏览器确认 `.agent-avatar`、`.ao-avatar`、`.scene-agent-avatar`、`.directory-avatar`、`.skill-grant-tag` 内 SVG 的尺寸/裁圆符合设计稿（尤其 SkillsPanel 成员标签处 SVG 走默认 32px、无专用容器类）。
