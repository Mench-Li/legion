<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-10-14**（w/T-206 HEAD `9c4e242d`） 的基线，其中的 file:line、测试数量、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-206 测试用例 / 验收测试：为软件流水线空间仍未换头像的 Agent（soldier-* 与 general）选取头像

> 角色：test-designer（测试用例设计）｜阶段：测试用例设计｜执行任务：T-206（[auto-goal]｜所属目标 G-mv7kzgnu-1 · software · chain）
> 上游：[REQUIREMENTS.md](./REQUIREMENTS.md)（T-203 需求：R-1~R-11 + 35 条 AC + D-*/O-*）→ [RESEARCH.md](./RESEARCH.md)（T-204 方案：**方案 A = L1 投影层修复 + T1 静态映射表 + V 矢量位面**，只改 `team-hub/routes/team-views.mjs:119` 一处读出口）→ [TASK_BREAKDOWN.md](./TASK_BREAKDOWN.md)（T-205 拆解：**「## slices」S1~S5**，每片第 4 段机器验收行 = 本文用例逐条翻译的唯一基准；§1.1 冻结令牌、§1.2 冻结接口、§1.3 不变量、§6 锚点 E1/E2/R-8 容量）
> 目标上下文（将军裁决）：contextVersion=0 为空；按 TASK_BREAKDOWN 默认口径推进 —— **D-1 不落 roster 行 · D-3 实现统一覆盖、验收门槛只算 software · D-4 3D 不联动 · D-5 纳入 S8 技能授权标签**。
> 下游：T-207 coder 按本文 §9 附录 B 骨架把 P0 用例落成断言；T-208 reviewer 按 BR/AC 必查项复核；T-209 tester 按 §2 分层逐条执行并把结果写入 `docs/G-mv7kzgnu-1/TEST_REPORT.md`；T-210 devops 按 §4.5 接入文档门禁。
> 依据：TASK_BREAKDOWN「## slices」S1~S5 每片验收行（分号分句）+ REQUIREMENTS §4 的 35 条 AC + §6 成功标准 M-1~M-7 + LEGION.md 纪律与本任务阶段验收（覆盖 主路径 + 边界 + 异常；每条含 前置条件 / 操作步骤 / 期望结果与判据；验收标准用例化；关键业务规则正反向成对）。
>
> **权威基线 / 命名空间提醒**：本目标分析文档目录 = `docs/G-mv7kzgnu-1/`。仓库根 `docs/TEST_CASES.md` 与其它 `docs/G-*` 的同名文档属其它目标，**禁止读写**。本文只写 `docs/G-mv7kzgnu-1/TEST_CASES.md` 与本目标自检证据 `docs/G-mv7kzgnu-1/T206-evidence/`。
>
> **边界声明（本阶段只做与不做）**：✅ 做 —— 把 S1~S5 验收行与 35 条 AC 逐条翻译成可执行用例（含前置/步骤/期望与 PASS/FAIL 判据）、关键业务规则正反向成对、交付可直接照抄的测试代码骨架；🚫 不做 —— **不执行用例**（执行是 T-209 tester 的职责，本文只给命令与判据）、**不写业务实现代码**、**不预写各切片文件域内的 `*.test.mjs`**（TASK_BREAKDOWN 已把它们划给 coder 的文件域；预写会与 coder 合入冲突，且 CI「套件清单完备性」按 `git ls-files '*.test.mjs'` 全仓点名，未登记的测试文件会让门禁变红）、不调用 taskctl / 看板写接口、不 push、不联网。
>
> **工作区状态**：本任务在独立 worktree（分支 `w/T-206`）执行；判定基准 HEAD `9c4e242d`（promote T-205，本 worktree 实测），Node v24.19.0（仓库实测），`git status --short` 起手为空。本目录现有 REQUIREMENTS.md / RESEARCH.md / TASK_BREAKDOWN.md / T204-evidence/（本文为首次产出，无旧版）。本阶段未对 live 库 `team-hub/team.db` 与主工作区做任何写入型改动。

## 0. 结论速览（TL;DR）

- 交付单件：本文档 `docs/G-mv7kzgnu-1/TEST_CASES.md` + 自检证据 `docs/G-mv7kzgnu-1/T206-evidence/`。共 **73 条用例**（S1 20 / S2 15 / S3 12 / S4 9 / S5 9 / E2E 8）；🟢 主路径 52 / 🟡 边界 6 / 🔴 异常·反向 15；P0 51 / P1 21 / P2 1。每条含 **前置条件 / 操作步骤 / 期望结果与通过判据**；ID 唯一、类别与优先级枚举合法、7 列完整、35 条 AC 全覆盖、15 条 BR 正反向配对、4 段骨架语法合法 —— 均由 §8 的机器自检脚本复跑复核（输出见 `T206-evidence/01-doc-machcheck.txt`）。
- 验收标准被用例化：TASK_BREAKDOWN「## slices」S1~S5 验收行逐分句 + REQUIREMENTS §4 的 35 条 AC + §6 的 M-1~M-7 逐条映射（§7 追溯矩阵 + §6 E2E 表「追溯」列）；PASS/FAIL 判据写进每条「期望结果 / 通过判据」列与 §3 唯一线表，不留「应该没问题」式结论。
- 关键业务规则正反向成对（§5，BR-1~BR-15）：读出口只产出合法令牌或空串（正/反 · emoji 注入）、冻结令牌唯一（正/反 · 两行同令牌注入）、两端 parity（正/反 · 只改一端）、确定性（正/反 · 注入 Math.random）、无副作用（正/反 · 注入 INSERT roster 行）、无破图降级（正/反 · 模拟 404）、假绿防线（正/反 · 注入 `human:general`）、general 客户端图形化（正/反 · 换回齿轮/「管」）、三处同源（正/反 · 换第二个来源）、单一视觉来源（正/反 · 加第二套表）、池满降级（正/反 · 异常入参）、S8 兜底（正/反 · 删兜底）、CI 登记（正/反 · 删登记）、banner（正/反 · 删 banner）、文档口径（正/反 · 改回旧口径）。
- 测试代码落点（§9 附录 B，可直接照抄）：S1 → 追加到 `team-hub/team-views-routes.test.mjs`（改写既有 ⑥ + 新增 ⑥c/⑥d）；S2 → 新增 `workbench/scripts/external-avatar-parity.test.mjs`（ts.transpileModule + node:test，零新增依赖，须登记进 `scripts/ci/run-ci.mjs`）；S3 → 追加到 `workbench/scripts/agent-avatar-surfaces.test.mjs`；S4 → 追加到 `workbench/scripts/agent-avatar-settings.test.mjs`。**本文只给骨架，不在本阶段物化测试文件**（理由见上方边界声明；先例 = 上一目标 `docs/G-mv1s6y49-1/TEST_CASES.md` §9）。
- 现存基线（本会话实测，仅环境事实；本阶段**不执行**本文用例 —— 执行为 T-209 职责）：`team-views-routes.test.mjs` 17/17 · `migrate-avatars.test.mjs` 7/7 · `seed-roster.test.mjs` exit 0 · `agent-avatar.test.mjs` 12/12 · `avatar-photo.test.mjs` 10/10 · `mobile/avatar-parity.test.mjs` 6/6 · `agent-avatar-surfaces.test.mjs` 5/5 · `agent-avatar-settings.test.mjs` 6/6 —— 全绿（fail 0）。
- 现状缺口（本会话复跑 `probe-avatar-gap.mjs` 实测，未改动）：software 4 条外部执行者（soldier-a/b/auto + general）avatar 全为 `'⚙️'` ⇒ 同一张灰阶占位人形；ozon `soldier-market` 同类第 5 条；图片池 20/20 占满、备用位面空闲 `s11..s15` 恰 5 个。

## 1. 输入、工作假设与硬性不变量

### 1.1 输入（唯一依据链）

| 输入 | 本用例取用方式 |
| --- | --- |
| REQUIREMENTS §4 的 R-1~R-11 与 35 条 AC | 作为「验收口径」逐条映射（§7 矩阵每行一个 AC，无悬空）；每条 AC 必须在 §7 出现且承载用例存在 |
| REQUIREMENTS §6 的 M-1~M-7 | 作为端到端用例（§4.6 E2E-1~E2E-8）的判据来源 |
| REQUIREMENTS §2 的现状证据与 G1~G5 缺口 | 作为「现状缺口 → 切片 → 用例」索引（§4.0），供 tester 先复现后对照 |
| TASK_BREAKDOWN「## slices」S1~S5 第 4 段 | 机器验收行逐分句 = §4 各用例的「追溯」列（记作「Sx 验收 n」） |
| TASK_BREAKDOWN §1.1 冻结令牌表 / §1.2 冻结接口 | general=s11、soldier-a=s12、soldier-b=s13、soldier-auto=s14、soldier-market=s15；`EXTERNAL_AVATAR_TOKENS` / `externalAvatarFor(name, usedTokens)` / `EXTERNAL_AGENT_AVATARS` / `externalAvatarToken(name)` |
| TASK_BREAKDOWN §1.3 不变量 / §6 锚点 | 零新增依赖、位面表规模不变、不落 roster、身份红线、纯函数 → I-1~I-7；E1（代码测试钉点）、E2（banner）、R-8 容量 |
| RESEARCH §2.2 反例 / §2.3 S7 口径修正 / §6.5 兜底 | 决定「假绿防线」用例（TC-S2-05/15）、「移动端不设展示用例」（A-5）、「池满→空串」（TC-S1-05） |

### 1.2 工作假设（将军未否决即按此展开；翻转只影响取值，不影响断言语义）

| 编号 | 假设 | 翻转影响 |
| --- | --- | --- |
| A-1 | 令牌 = `human:<key>`，`key` 匹配 `^[a-z0-9][a-z0-9-]*$`；本目标判据 = 令牌合法 **且** `resolveSlot(token) !== null`（REQUIREMENTS §3 术语表 + RESEARCH §2.2 反例） | 若判据只看格式，TC-S2-05/15 的「假绿」断言即失效——这正是本条存在的理由 |
| A-2 | 冻结令牌（TASK_BREAKDOWN §1.1）：general=`human:s11`、soldier-a=`human:s12`、soldier-b=`human:s13`、soldier-auto=`human:s14`、soldier-market=`human:s15` | 若改分配，仅 §4/§9 的令牌字面量改值，用例结构不变 |
| A-3 | 分配机制 = 静态表优先 + 未命中确定性兜底；备用池 = `s01..s15`，其中 `s11..s15` 被静态表保留 ⇒ 未登记身份只能用 `s01..s10`；池满返回 `''`（RESEARCH §6.5 + TASK_BREAKDOWN §6「R-8 容量」） | 若实现不保留 `s11..s15`，「有空位/池满」夹具的取值改数，TC-S1-04/05/19 的期望值随之调整 |
| A-4 | 客户端 mirror：`workbench/src/avatar/external-agents.ts` 导出 `EXTERNAL_AGENT_AVATARS` 与 `externalAvatarToken`，由 `avatar/index.ts` 二次导出；两端由 `external-avatar-parity.test.mjs` 逐项锁死（TASK_BREAKDOWN §1.2） | 若签名微调，仅骨架调用面改，断言集合不变 |
| A-5 | 移动端口径（RESEARCH §2.3 修正）：外部执行者**不进** `/api/agents`，故**不设**移动端展示用例；移动端只用既有位面 parity 守「同 token 同位面」 | 若将军要求移动端也展示这 4 条，需新增移动端取数改造切片与展示用例 |
| A-6 | D-1 不落 roster 行 / D-3 实现统一覆盖、验收门槛只算 software / D-4 3D 不联动 / D-5 纳入 S8 | 若 D-3 判「不纳入」，TC-S1-11/E2E-2 的口径改「显式列出并说明」；若 D-5 判「不纳入」，TC-S4-01~04/08 转为反向锚定 |
| A-7 | E1：`team-hub/team-views-routes.test.mjs:137` 把 `'⚙️'` 固化成期望，必须**改写**而非删除（TASK_BREAKDOWN §6 E1） | 若删除该用例，R-8 兜底的天然用例同时消失，TC-S1-10 改判 FAIL |
| A-8 | R-8（后续新增自动覆盖）：本目标**默认不满足**（5 个已点名占满 `s11..s15`）；**不得写成必过**（TASK_BREAKDOWN §6） | 若将军裁决扩容 `s16..s24`，需 4 处同步（`slots.ts` / `mobile/avatar.mjs` / `agent-avatar.test.mjs` 的 SPARES / `avatar-parity.test.mjs` 的 40 断言），TC-S1-04/05 升级为必过 |
| A-9 | 沙箱等价：各套件以 `node <file>` 直跑等价 `node --test <file>`；CI 全量门禁由 T-210 在有完整权限环境执行 | 若宿主可 `node --test`，结论不变，只改复现命令 |
| A-10 | 人工判据（「看得出是人形」「两两不同」）由 tester 组织 ≥1 名独立评审人判定并留痕（评审人 + 结论 + 样本） | 若将军指定评审人/样本量，取值调整 |

### 1.3 硬性不变量（本批任何实现不得违反，均有门禁用例锚定）

| 编号 | 不变量 | 锚定用例 |
| --- | --- | --- |
| I-1 | 零新增运行时依赖（`workbench/package.json` 的 `dependencies` 仍恰好 5 个） | TC-S2-10、TC-S3-08、TC-S4-07 |
| I-2 | 位面表规模不变（`slots.ts` 与 `mobile/avatar.mjs` 仍各 40 个 key，逐项一致） | TC-S2-07、TC-S2-09 |
| I-3 | 不落 roster 行：`/api/spaces.agentCount`、`/api/agents` 的 role 集合、3D 人数、任务归属改前改后一致 | TC-S1-08、TC-S1-16、E2E-6 |
| I-4 | 身份红线：`name`/`avatar` 不作身份键 / React key / 唯一约束 | TC-S3-06、TC-S1-09、E2E-6 |
| I-5 | 纯函数：分配路径不含 `Math.random` / `Date.now` / `fetch` / 外链 | TC-S1-07、TC-S1-20、TC-S2-04 |
| I-6 | 单一视觉来源：不得新增第二套画法/配色/候选表（允许新增「名字→令牌」映射，它不定义任何颜色/形状） | TC-S4-03、TC-S2-14 |
| I-7 | 本目标新增文档自带 `evidence-banner`；不伪造门禁结论 | TC-S5-02、TC-S5-08、§10 自检 |
| I-8 | E1/E2 两个既有锚点必须显式处置（E1 改写、E2 补 banner），不得静默绕过 | TC-S1-10、TC-S5-01 |

## 2. 测试分层与执行方式（谁在什么时候跑）

> 本文**不执行**用例；下表说明每条用例由谁、用什么命令、在哪个阶段跑。tester（T-209）按层逐条执行并写 `docs/G-mv7kzgnu-1/TEST_REPORT.md`。

| 层 | 载体 | 命令 / 方式 | 谁跑 | 覆盖用例 |
| --- | --- | --- | --- | --- |
| L0 数据面 | 临时库（`TEAM_HUB_DB` 指向 mkdtemp 的 `team.db`） | `node team-hub/scripts/migrate-avatars.test.mjs` / `seed-roster.test.mjs` | 切片 coder + tester | S1 回归 |
| L0-HTTP 接口面 | 临时库 + 真监听端口（仿 `team-views-routes.test.mjs:17-22`） | `node team-hub/team-views-routes.test.mjs` | 切片 coder + tester | S1 主路径/边界/异常 |
| L1-parity 两端同轴 | `ts.transpileModule` 装载两端模块逐项比对 | `node workbench/scripts/external-avatar-parity.test.mjs` | 切片 coder + tester | S2 全部 |
| L1 渲染断言 | `ts.transpileModule` + `react-dom/server renderToString`（仿 `agent-avatar.test.mjs`；无 jsdom） | `node workbench/scripts/agent-avatar.test.mjs` | 切片 coder + tester | TC-S3-11、TC-S4-04/09、E2E-7 |
| L1-mobile | 纯 JS 镜像 + 读文件 parity | `node workbench/mobile/avatar-parity.test.mjs` | 切片 coder + tester | TC-S2-09、E2E-5 移动端口径 |
| L0-static 源码扫描 | `readFileSync` + 正则（仿 `agent-avatar-surfaces.test.mjs`） | `node workbench/scripts/agent-avatar-surfaces.test.mjs` / `agent-avatar-settings.test.mjs` | 切片 coder + tester | S3/S4/S5 源码面 |
| L3 前端门禁 | 类型检查（沙箱等价，非 `pnpm`） | `node node_modules/typescript/bin/tsc --noEmit`（cwd=`workbench`） | 切片 coder + tester | TC-S2-10、TC-S3-08、TC-S4-07 |
| L4 文档/CI 门禁 | banner 覆盖 + 文档结构 + 套件清单完备性 | `node scripts/ci/evidence-banner.mjs --check` · `node scripts/ci/check-docs.mjs` · `node scripts/ci/run-ci.mjs --only test` | T-210 devops + tester | S5 全部、TC-S2-12 |
| 评审（人工） | 独立评审人在对照图上判定并留痕 | `node workbench/scripts/render-avatar-sheet.mjs --only=s11,s12,s13,s14,s15`，按 §4.6 E2E-8 执行 | tester + 评审人 | E2E-8 |

> **回归锚点（本会话实测，tester 复跑对照）**：`team-hub/team-views-routes.test.mjs` = 17 pass；`team-hub/scripts/migrate-avatars.test.mjs` = 7 pass；`team-hub/scripts/seed-roster.test.mjs` = exit 0；`workbench/scripts/agent-avatar.test.mjs` = 12 pass；`workbench/scripts/avatar-photo.test.mjs` = 10 pass；`workbench/mobile/avatar-parity.test.mjs` = 6 pass；`workbench/scripts/agent-avatar-surfaces.test.mjs` = 5 pass；`workbench/scripts/agent-avatar-settings.test.mjs` = 6 pass。全部 fail 0。

## 3. 量化判据与 PASS/FAIL 唯一线

| 指标 | 唯一线（PASS 判据） | 锚定 AC |
| --- | --- | --- |
| 令牌合法且命中 | 100% 外部条目满足 `isAvatarToken(avatar)` 且 `resolveSlot(avatar) !== null`；任一条不满足即 FAIL | AC-R1-1 |
| 无非法令牌 | `/api/roster`（全空间）+ `/api/agents` 的 `avatar` 非空时非法计数 = 0；`'⚙️'` 计数 = 0 | AC-R7-1 |
| 冻结令牌 | 5 个已点名身份逐条等于 `human:s11`~`human:s15`；任一不等即 FAIL | AC-R2-1 |
| 唯一可辨 | software 12 条（8+4）的 `avatar` / 解析 key / 图片文件各自去重后仍为 12；4 条不与 8 内编共用 key/图 | AC-R4-1/4-2 |
| 确定性 | 同一 `(scope, soldier)` 连续 3 次请求 + 重启后字符串相等；分配路径零随机/零时钟/零网络 | AC-R5-1/5-3 |
| 无副作用 | `/api/spaces.agentCount`、`/api/agents` role 集合、task 归属、`/api/roster` 除 `avatar` 外字段逐条与基线相同 | AC-R9-1/9-2/9-4 |
| 两端同轴 | 客户端表与 `EXTERNAL_AVATAR_TOKENS` `deepEqual`；两端位面 key 集合与字段逐项相同 | AC-R6-2 |
| 单一来源 | 第二套视觉表（`const AVATARS =` / `AVATAR_CHOICES`）计数 = 0 | AC-R4-4 |
| 池满降级 | 未命中且池满时返回 `''`（占位语义）；**绝不**返回 emoji / 非法字符串 | AC-R7-2 |
| 假绿防线 | `resolveSlot('human:general') === null` 且 `resolveSlot('human:s11') !== null`（格式合法 ≠ 已换头像） | AC-R1-1 |
| 无破图 | 全部展示面在图片 404 / 令牌非法时显示占位人形；破图 / 裸露 alt/文件名 / emoji 文本计数 = 0 | AC-R6-4/R10-1 |
| 文档口径 | 旧齿轮现状句（`⚙️ … 执行中`）与「零图片资源」命中 = 0；界面齿轮图标（`CommandBar`/`Sidebar` 图标位）不受误伤 | AC-R7-3 |
| banner 覆盖 | `evidence-banner --check` 退出码 0，缺失清单不含 `docs/G-mv7kzgnu-1` | E2 |
| 人形可辨（人工） | 对照图上 5 个位面抽检 ≥4/5 被判定「看得出是人形/人脸」且 5 张两两不同（评审留痕） | M-1（RK-A1） |

## 4. 用例目录（S1~S5 + E2E）

> 图例：类别 🟢 正常（主路径/正向）/ 🟡 边界（极限·三值）/ 🔴 异常·反向（非法输入拒绝、规则违反被检出、恢复与降级）；优先级按承载需求：R-1/R-2/R-3/R-4 = P0，R-5~R-8 及回归/文档/CI = P1，可延后项 = P2（各切片的 DoD/回归与负例注入门禁用例随其在办切片记 P0/该片优先级）。
> 「自动化」列 = 载体（L0 数据面 / L0-HTTP 接口面 / L0-static 源码扫描 / L1 渲染断言 / L1-parity / L1-mobile / L3 前端门禁 / L4 文档·CI 门禁 / 评审）。
> 追溯列引用：REQUIREMENTS 验收口径（`AC-R*-*`）、成功标准（`M-*`）、TASK_BREAKDOWN「## slices」验收行（「Sx 验收 n」= 该片第 4 段按分号分句后的序号）、冻结契约（I-x）、工作假设（A-x）、锚点（E1/E2/RK-*）。表中「或」= 逻辑或（避免与表格分隔符冲突）。
> 每行 = 一条可执行用例：前置条件 → 操作步骤 → 期望结果 / 通过判据（PASS/FAIL 唯一线见 §3）。命名空间：`TC-S<n>-<m>` 仅指本文档新增用例；`E2E-n` 为端到端总口径用例。

### 4.0 现状缺口 → 切片 → 用例索引（供 coder 先复现后实现、tester 回归对照）

| 缺口（REQUIREMENTS §2 / RESEARCH §2 现状证据） | 归属切片 | 直接用例 |
| --- | --- | --- |
| G1 software 4 条外部执行者无合法令牌，渲染灰阶占位（`team-views.mjs:119` 硬编码 `'⚙️'`） | S1 | TC-S1-02、TC-S1-03、TC-S1-08、E2E-1 |
| G2 general 在用户卡（`Sidebar.tsx:175`）与左轨（`WorkspaceNavigation.tsx:45`）是文字/字符头像 | S3 | TC-S3-01、TC-S3-02、TC-S3-09 |
| G3 服务端仍在主动产出非法令牌（`team-views.mjs:119`） | S1 | TC-S1-07、TC-S1-14、E2E-2 |
| G4 无机制保证后续新增外部身份自动有头像（`allocateAvatarToken` 只扫 roster 行） | S1 | TC-S1-04、TC-S1-05、TC-S1-19（**R-8 默认不满足**，见 §6） |
| G5 `ozon/soldier-market` 同类缺口第 5 条 | S1 | TC-S1-11、E2E-4 |
| S8 技能授权标签对不在目录的 id 整块不渲染头像 | S4 | TC-S4-01、TC-S4-02、TC-S4-08 |
| E1 代码测试把 `'⚙️'` 固化成期望 | S1 | TC-S1-10、TC-S1-14 |
| E2 `docs/G-mv7kzgnu-1` 缺历史快照 banner | S5 | TC-S5-01、TC-S5-02、TC-S5-08 |

### 4.1 S1 服务端外部执行者头像令牌：静态映射表 + 未命中兜底 + `/api/roster` 投影修复（R-2 + R-5 + R-7 + R-9，兜底 R-8）——自动化：L0-HTTP `node team-hub/team-views-routes.test.mjs` + L0 回归

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S1-01 | 🟢 P0 | S1 合入：`team-hub/agent-avatars.mjs` 导出 `EXTERNAL_AVATAR_TOKENS` 与纯函数 `externalAvatarFor(name, usedTokens)` | 读表；对 5 个已点名身份分别以 `usedTokens = []` 与 `usedTokens = 全部 `s01..s15` 调用 | 逐条返回冻结令牌 general=`human:s11`、soldier-a=`human:s12`、soldier-b=`human:s13`、soldier-auto=`human:s14`、soldier-market=`human:s15`；同一 name 两次调用字符串相等且与 `usedTokens` 无关 —— AC-R2-1、AC-R5-1 | L0 | AC-R2-1；AC-R5-1；S1 验收 2 |
| TC-S1-02 | 🟢 P0 | S1 合入；临时库 + 真端口；software 造一条 `soldier='general'` 且 roster 无 general 行的任务 | `GET /api/roster?scope=software`，取 `external===true` 的条目 | `ext.avatar === 'human:s11'`；`isAvatarToken(ext.avatar) === true`；`ext.avatar !== '⚙️'` —— AC-R2-1 | L0-HTTP | AC-R2-1；S1 验收 1 |
| TC-S1-03 | 🟢 P0 | 同 TC-S1-02 | software 造 4 条外部任务：`soldier-a`/`soldier-b`/`soldier-auto`/`general`（`role` 与 soldier 同名，roster 无这些行） | 4 条逐条等于 `human:s12`/`human:s13`/`human:s14`/`human:s11`；4 条 `avatar` 去重后 = 4 —— AC-R2-1、AC-R4-1 | L0-HTTP | AC-R2-1；AC-R4-1；S1 验收 2 |
| TC-S1-04 | 🟢 P1 | 临时库中 `s01..s10` 全空闲、`s11..s15` 被静态表保留 | 调 `externalAvatarFor('solo-new', [])` | 返回合法 `human:sNN`（`NN` 属于 `s01..s10`）；不等于任何冻结令牌 —— AC-R8-1（**默认口径，非必过**，见 §6） | L0 | AC-R8-1；S1 验收 3 |
| TC-S1-05 | 🟡 P1 | 同 TC-S1-04；池满夹具：`s01..s10` 全部列入 `usedTokens` | 调 `externalAvatarFor('solo-new', ['human:s01' … 'human:s10'])` | 返回**空串 `''`**（占位语义）；**绝不**返回 emoji、`'⚙️'` 或非法字符串 —— AC-R7-2、AC-R8-1 | L0（边界） | AC-R7-2；AC-R8-1；S1 验收 3 |
| TC-S1-06 | 🟢 P0 | 同 TC-S1-04 | 同一 `(name, usedTokens)` 连续调用两次；再打乱 `usedTokens` 顺序调用一次 | 三次结果字符串相等（顺序无关）—— AC-R5-1、AC-R5-3 | L0 | AC-R5-1；AC-R5-3 |
| TC-S1-07 | 🟢 P0 | S1 合入 | 读 `team-hub/agent-avatars.mjs` 全文与 `team-hub/routes/team-views.mjs` 源码，检索禁止项 | 两文件均不含 `Math.random`、`Date.now`、`fetch(`、`http://`、`https://`；`/api/roster` 段不含 `new Date`（`/api/overlaps` 段的 `new Date` 不属本判据）—— AC-R5-3 | L0-static | AC-R5-3；I-5；S1 验收 4 |
| TC-S1-08 | 🟢 P0 | 同 TC-S1-02；库内已有 4 条外部任务 | `GET /api/roster`（scope 空 = 全部空间）遍历每条；并对比请求前后 `SELECT COUNT(*) FROM roster` | 每条 `avatar === ''` 或 `isAvatarToken(avatar)`，非法计数 = 0；roster 行数**不变**（未落行）—— AC-R7-1、AC-R9-2 | L0-HTTP | AC-R7-1；AC-R9-2；S1 验收 5 |
| TC-S1-09 | 🟢 P0 | S1 合入；基线 commit `9c4e242d` | `git diff 9c4e242d -- team-hub/routes/team-views.mjs team-hub/agent-avatars.mjs`；并对同一 fixture 逐字段比对 external 条目 | `team-views.mjs` 的改动只在 `:119` 的 avatar 实参（`'⚙️'` → 令牌调用），`role/name/kind/mode/chips/done/total/external/scope/tasks` 表达式未变；同一 fixture 下除 `avatar` 外逐字段相等 —— AC-R9-1 | L0 + L0-static | AC-R9-1；S1 验收 6 |
| TC-S1-10 | 🟢 P0 | S1 合入 | 读 `team-hub/team-views-routes.test.mjs`，检索 `assert.equal(ext.avatar, '⚙️')` | 该断言**已被改写**（不再是齿轮期望）；同一用例仍断言 `ext.avatar === ''` 或 `isAvatarToken(ext.avatar)` —— E1、RK-7 | L0-static | E1；RK-7；S1 验收 1 |
| TC-S1-11 | 🟢 P1 | 同 TC-S1-02；`scope` 空聚合 | 造 ozon 的 `soldier='soldier-market'` 外部任务 | 该条 `avatar === 'human:s15'`（D-3 默认统一覆盖）—— AC-R11-1（P1 回归面） | L0-HTTP | AC-R11-1；D-3；S1 验收 2 |
| TC-S1-12 | 🟢 P0 | S1 合入 | `node team-hub/team-views-routes.test.mjs` | 退出码 0、fail 0（改写后用例数 ≥ 17 且全绿）—— S1 DoD | L0-HTTP | S1 验收 7 |
| TC-S1-13 | 🟢 P0 | S1 合入；既有迁移/种子套件可跑 | `node team-hub/scripts/migrate-avatars.test.mjs` 与 `node team-hub/scripts/seed-roster.test.mjs` | 均退出码 0、fail 0（内编分配与迁移口径不回归）—— AC-R4-3、AC-R9-2 | L0 | AC-R4-3；AC-R9-2；S1 验收 8 |
| TC-S1-14 | 🔴 P0 | S1 合入 | 反向注入：把 `team-views.mjs:119` 的 avatar 实参改回 `'⚙️'`（或让 `externalAvatarFor` 返回 `'⚙️'`），复跑 TC-S1-02/08 | 断言**变红**并点名 avatar 字段；若注入后仍全绿则本用例判 FAIL —— AC-R7-1 反向 | L0-HTTP（负例注入） | AC-R7-1；S1 验收 1 反向 |
| TC-S1-15 | 🔴 P0 | S1 合入 | 反向注入：把静态表中 `soldier-b` 的令牌改成与 `soldier-a` 相同（`human:s12`），复跑 TC-S1-03 唯一性断言 | 断言**变红**；若仍全绿则判 FAIL —— AC-R4-1 反向 | L0（负例注入） | AC-R4-1；S1 验收 2 反向 |
| TC-S1-16 | 🔴 P1 | S1 合入 | 反向注入：在 `/api/roster` 的 external 分支加 `INSERT INTO roster` 落行，复跑 TC-S1-08 的行数与 agentCount 断言 | 副作用断言**变红**并点名行数或 `agentCount` 变化；若仍全绿则判 FAIL —— AC-R9-2 反向 | L0-HTTP（负例注入） | AC-R9-2；S1 验收 5 反向 |
| TC-S1-17 | 🔴 P0 | 同 TC-S1-04 | 异常入参：`externalAvatarFor('', [])`、`(null, [])`、`(undefined, [])`、`('⚙️', [])`、`('A B', [])`、超长名字 | 一律不抛未捕获异常；返回值只可能是合法令牌或 `''`；**任何情况下不返回 emoji/非法串** —— AC-R7-1 异常 | L0（异常） | AC-R7-1；S1 验收 3 |
| TC-S1-18 | 🟢 P0 | 同 TC-S1-02 | 回归 ⑥b：造一条已入编队任务（`role` 命中 roster）与一条 `canceled` 任务 | external 分组条数 = 0（已入编队 / canceled 都不进 external），既有语义不回归 —— AC-R9-1、AC-R9-4 | L0-HTTP | AC-R9-1；AC-R9-4；S1 验收 6 |
| TC-S1-19 | 🟡 P1 | 同 TC-S1-04 | 边界：`usedTokens` 只占用 `s01..s09`（留 1 个空位） | 返回**唯一**剩余空位令牌 `human:s10`；两次调用稳定 —— AC-R5-1 边界 | L0（边界） | AC-R5-1；S1 验收 3 边界 |
| TC-S1-20 | 🔴 P0 | S1 合入 | 反向注入：让分配路径引入 `Math.random()` 或 `Date.now()` 参与选择，复跑 TC-S1-06/07 | 确定性/纯函数断言**变红**并点名违规文件；若仍全绿则判 FAIL —— AC-R5-3 反向 | L0-static（负例注入） | AC-R5-3；I-5；S1 验收 4 反向 |

### 4.2 S2 客户端「名字→令牌」共享模块 + 两端 parity 断言 + 新套件登记 CI（R-1 + R-4 + R-5 + R-7）——自动化：L1-parity `node workbench/scripts/external-avatar-parity.test.mjs` + L3 `tsc --noEmit` + L4 套件清单

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S2-01 | 🟢 P0 | S2 合入：`workbench/src/avatar/external-agents.ts` 导出 `EXTERNAL_AGENT_AVATARS` 与 `externalAvatarToken(name)`；服务端表可读 | parity 测试逐项比对客户端表与 `team-hub/agent-avatars.mjs` 的 `EXTERNAL_AVATAR_TOKENS` | 两端表 `deepEqual`（同名字同令牌，无多无少）—— AC-R6-2、AC-R5-1 | L1-parity | AC-R6-2；AC-R5-1；S2 验收 1 |
| TC-S2-02 | 🟢 P0 | 同 TC-S2-01 | 对表中每个令牌与 `externalAvatarToken(name)` 的结果调用 `resolveSlot` | 每个令牌匹配 `human:<key>`；`resolveSlot(token) !== null`；解析出的 `key !== 'placeholder'` —— AC-R1-1、AC-R1-3、AC-R2-3 | L1-parity | AC-R1-1；AC-R1-3；AC-R2-3；S2 验收 2 |
| TC-S2-03 | 🟢 P0 | 同 TC-S2-01；可读 `slots.ts` 的 `BUILTIN_ROLE_KEYS` 与 software 8 内编令牌 | 取 5 个 key 与 25 个 `BUILTIN_ROLE_KEYS`、software 8 内编 key 比对 | 5 个 key 两两不同；均不在 `BUILTIN_ROLE_KEYS`；与 software 8 内编当前 key 无交集 —— AC-R4-1、AC-R4-2 | L1-parity | AC-R4-1；AC-R4-2；S2 验收 3 |
| TC-S2-04 | 🟢 P0 | 同 TC-S2-01 | 同一 name 连续调 `externalAvatarToken` 两次；静态扫描 `external-agents.ts` 与 `avatar/index.ts` | 两次字符串相等；源码不含 `Math.random`、`Date.now`、`performance.now`、`new Date`、`fetch(`、`http://`、`https://` —— AC-R5-3 | L1-parity + L0-static | AC-R5-3；S2 验收 4 |
| TC-S2-05 | 🟢 P0 | `slots.ts` 与 `mobile/avatar.mjs` 可读 | 断言 `resolveSlot('human:general') === null` 且 `resolveSlot('human:s11') !== null` | 前者为 `null`（防「格式合法即已换头像」的假绿）；后者非 `null` —— AC-R1-1、RK-A3 | L1-parity（负例锚） | AC-R1-1；RK-A3；S2 验收 2 |
| TC-S2-06 | 🟢 P1 | S2 合入 | `node -e` 读 `scripts/ci/run-ci.mjs`，检索 `external-avatar-parity.test.mjs` | 命中（新增套件已登记进 CI 清单）—— S2 验收 6 | L0-static | S2 验收 6 |
| TC-S2-07 | 🟢 P0 | 同 TC-S2-01 | 取 `slots.ts` 的 `slotKeys()` 与 `mobile/avatar.mjs` 的 `slotKeys()` | 两者均为 40 个 key 且逐项相同（位面表规模未因本目标扩容）—— I-2、AC-R6-2 | L1-parity | I-2；AC-R6-2；S2 验收 7 |
| TC-S2-08 | 🟢 P0 | S2 合入 | `node workbench/scripts/external-avatar-parity.test.mjs` | 退出码 0、fail 0 —— S2 DoD | L1-parity | S2 验收 5 |
| TC-S2-09 | 🟢 P0 | S2 合入 | `node workbench/mobile/avatar-parity.test.mjs` | 退出码 0、fail 0（两端逐 key parity 不回归）—— AC-R6-2、AC-R10-3 | L1-mobile | AC-R6-2；AC-R10-3；S2 验收 7 |
| TC-S2-10 | 🟢 P0 | `workbench/node_modules` 存在；S2 合入 | 在 `workbench` 目录执行 `node node_modules/typescript/bin/tsc --noEmit` | 退出码 0（新模块与导出可编译；`dependencies` 仍恰好 5 个）—— S2 DoD、I-1 | L3 | I-1；S2 验收 8 |
| TC-S2-11 | 🔴 P0 | S2 合入 | 反向注入：只改客户端 `external-agents.ts` 某一条令牌（不动服务端表），复跑 TC-S2-01 | parity 断言**变红**并点名两端差异项；若仍全绿则判 FAIL —— AC-R6-2 反向 | L1-parity（负例注入） | AC-R6-2；S2 验收 1 反向 |
| TC-S2-12 | 🔴 P1 | S2 合入 | 反向注入：从 `scripts/ci/run-ci.mjs` 的 suites 删掉 `external-avatar-parity.test.mjs` 登记，跑 `node scripts/ci/run-ci.mjs --only test` 的套件清单完备性段 | 输出 `FAIL 套件清单不完备` 并点名该文件；若仍 PASS 则判 FAIL —— S2 验收 6 反向 | L4（负例注入） | S2 验收 6 反向 |
| TC-S2-13 | 🟡 P1 | 同 TC-S2-01 | 边界/异常：`externalAvatarToken('')`、`(null)`、`(undefined)`、`('solo-new')`、`('⚙️')` | 未登记 name 返回合法令牌或 `''`；空/非字符串入参返回 `''` 且不抛错；任何情况不返回 emoji/非法串 —— AC-R7-2 边界 | L1-parity（边界） | AC-R7-2；S2 验收 2 边界 |
| TC-S2-14 | 🔴 P1 | S2/S3/S4 合入 | 反向注入：在 `external-agents.ts` 里加一张 `const AVATARS = {...}` 视觉表或 `AVATAR_CHOICES`，复跑 surfaces/settings 门禁 | 单一来源门禁**变红**并点名该文件；若仍全绿则判 FAIL —— I-6 反向 | L0-static（负例注入） | I-6；S2 验收 9 |
| TC-S2-15 | 🔴 P0 | S2 合入 | 反向注入：把 external 表某条改成 `human:general`（格式合法但位面表无此 key），复跑 TC-S2-02 | 「命中位面」断言**变红**并点名该条；若仍全绿则判 FAIL —— AC-R1-1 反向（假绿防线） | L1-parity（负例注入） | AC-R1-1；RK-A3；S2 验收 2 反向 |

### 4.3 S3 general 的两处客户端展示面：侧栏底部用户卡（S2）+ 左轨空间管理员徽标（S3）（R-3 + R-6 + R-9）——自动化：L0-static `node workbench/scripts/agent-avatar-surfaces.test.mjs` + L3 `tsc --noEmit`

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S3-01 | 🟢 P0 | S3 合入：`Sidebar.tsx` 用户卡改用 `<AgentAvatar>` | 读 `Sidebar.tsx`；正则抽取 `.user-avatar` 节点内容 | 节点内是 `<AgentAvatar`；文件不再把 U+2699 齿轮字符作为头像内容（`user-avatar">\s*⚙` 形态计数 = 0）—— AC-R3-1 | L0-static | AC-R3-1；S3 验收 1 |
| TC-S3-02 | 🟢 P0 | S3 合入：`WorkspaceNavigation.tsx` 左轨徽标改用 `<AgentAvatar>` | 读 `WorkspaceNavigation.tsx`；检索 `.workspace-user` 节点 | 节点内是 `<AgentAvatar`；不再有文字「管」充当徽标（`workspace-user"[^>]*>管<` 形态计数 = 0）—— AC-R3-1 | L0-static | AC-R3-1；S3 验收 2 |
| TC-S3-03 | 🟢 P0 | 同 TC-S3-01/02 | 检索两个文件的 import 语句 | 两文件均从 `workbench/src/avatar/external-agents`（或其二次导出 `avatar/index`）导入**同一常量**；未各写一份字面量 —— AC-R3-2 | L0-static | AC-R3-2；S3 验收 3 |
| TC-S3-04 | 🟢 P0 | S1、S2、S3 合入 | 取两处 general 令牌（源码常量）与 `/api/roster` 的 general external 条目 `avatar` | 三处相等且均等于 `human:s11` —— AC-R3-2、AC-R6-2 | L0-static + L0-HTTP | AC-R3-2；AC-R6-2；S3 验收 3 |
| TC-S3-05 | 🟢 P0 | S2 合入 | 比对 general key `s11` 与 software 8 内编 key 集合 | `s11` 不在内编 8 个 key 中（也不在 25 个 `BUILTIN_ROLE_KEYS`）—— AC-R3-3 | L1-parity | AC-R3-3；S3 验收 4 |
| TC-S3-06 | 🟢 P0 | S3 合入 | 复跑既有 surfaces 断言（四个面含 `<AgentAvatar`、无 `const AVATARS =`、`avatar` 不作 React key） | 全部仍绿；若因本片改动变红则判 FAIL —— AC-R9-3、AC-R4-4 | L0-static | AC-R9-3；AC-R4-4；S3 验收 5 |
| TC-S3-07 | 🟢 P0 | S3 合入 | `node workbench/scripts/agent-avatar-surfaces.test.mjs` | 退出码 0、fail 0 —— S3 DoD | L0-static | S3 验收 6 |
| TC-S3-08 | 🟢 P0 | `workbench/node_modules` 存在；S3 合入 | 在 `workbench` 目录执行 `node node_modules/typescript/bin/tsc --noEmit` | 退出码 0 —— S3 验收 7、I-1 | L3 | I-1；S3 验收 7 |
| TC-S3-09 | 🔴 P0 | S3 合入 | 反向注入：把 `.user-avatar` 换回齿轮字符、把 `.workspace-user` 换回「管」，复跑 TC-S3-01/02 | 断言**变红**并点名文件；若仍全绿则判 FAIL —— AC-R3-1 反向 | L0-static（负例注入） | AC-R3-1；S3 验收 1 反向 |
| TC-S3-10 | 🔴 P1 | S3 合入 | 反向注入：让 `Sidebar.tsx` 从另一处（如硬编码 `'human:s12'`）取 general 令牌，复跑 TC-S3-03/04 | 同源与一致性断言**变红**；若仍全绿则判 FAIL —— AC-R3-2 反向 | L0-static（负例注入） | AC-R3-2；S3 验收 3 反向 |
| TC-S3-11 | 🟡 P1 | S2/S3 合入；渲染脚手架可用 | 以 `token='human:s11'`、`token=''`、`token='⚙️'` 渲染 `<AgentAvatar>`，扫描输出 | 三种输入均渲染图形节点（`<svg` 或 `<img`）；文本节点为空；无 emoji 文本、无 name 首字 —— AC-R6-4、AC-R2-3 边界 | L1（边界） | AC-R6-4；AC-R2-3；S3 验收 1 边界 |
| TC-S3-12 | 🟢 P1 | S3 合入 | 读 `Sidebar.tsx` 与 `CommandBar.tsx`，检索**界面齿轮图标**用法 | `Sidebar.tsx` 的图标位齿轮与 `CommandBar.tsx` 的「⚙️ 模型配置」仍在；本目标只改头像节点，不误伤图标 —— AC-R7-3 | L0-static | AC-R7-3；S3 验收 8 |

### 4.4 S4 技能授权标签（S8）：不在 `/api/agents` 目录的 id 也渲染头像（R-6）——自动化：L0-static `node workbench/scripts/agent-avatar-settings.test.mjs` + L3 `tsc --noEmit`

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S4-01 | 🟢 P0 | S4 合入：`SkillsPanel.tsx` 三处成员标签（`:546` / `:681` / `:793`） | 读源码，检索三处成员标签的头像渲染 | 三处均渲染 `<AgentAvatar`，且对**不在目录**的 id（`general`/`soldier-a`/`soldier-b`/`soldier-auto`）也渲染（经 `external-agents` 兜底）—— AC-R6-3、D-5 | L0-static | AC-R6-3；D-5；S4 验收 1 |
| TC-S4-02 | 🟢 P0 | 同 TC-S4-01 | 检索 `{a && <AgentAvatar` 条件形态 | 「目录查不到 ⇒ 整块不渲染头像」的形态消失（`{a && <AgentAvatar` 计数 = 0）—— AC-R6-3 | L0-static | AC-R6-3；S4 验收 1 |
| TC-S4-03 | 🟢 P0 | 同 TC-S4-01 | 扫描 `SkillsPanel.tsx` 的常量表与图片用法 | 无 `const AVATARS =`、无 `AVATAR_CHOICES`、无 `<img ... avatar`（不新增第二套视觉表 / 破图路径）—— AC-R4-4、I-6 | L0-static（负例） | AC-R4-4；I-6；S4 验收 2 |
| TC-S4-04 | 🟢 P0 | 同 TC-S4-01；`AgentAvatar` 回退契约可用 | 以不在目录的 id 渲染 S8 标签，取头像标识 | 走 `<AgentAvatar>` 的组件回退（非法/空令牌 → 占位人形），不出现破图、不裸露 alt/文件名 —— AC-R6-4 | L0-static + L1 | AC-R6-4；S4 验收 3 |
| TC-S4-05 | 🟢 P0 | S4 合入 | 复跑既有 settings 断言 TC-S5-03/04/05/06/09 | 全部仍绿；若因本片改动变红则判 FAIL —— AC-R6-2 | L0-static | AC-R6-2；S4 验收 4 |
| TC-S4-06 | 🟢 P0 | S4 合入 | `node workbench/scripts/agent-avatar-settings.test.mjs` | 退出码 0、fail 0 —— S4 DoD | L0-static | S4 验收 5 |
| TC-S4-07 | 🟢 P0 | `workbench/node_modules` 存在；S4 合入 | 在 `workbench` 目录执行 `node node_modules/typescript/bin/tsc --noEmit` | 退出码 0 —— S4 验收 6、I-1 | L3 | I-1；S4 验收 6 |
| TC-S4-08 | 🔴 P0 | S4 合入 | 反向注入：删掉 S8 对不在目录 id 的 external 兜底（恢复 `{a && …}`），复跑 TC-S4-01/02 | 断言**变红**并点名 `SkillsPanel.tsx`；若仍全绿则判 FAIL —— AC-R6-3 反向 | L0-static（负例注入） | AC-R6-3；S4 验收 1 反向 |
| TC-S4-09 | 🟡 P1 | 同 TC-S4-01 | 边界：成员 id 为 `''`、命中目录的 `coder`、不在目录的 `general` 三种 | 三种均渲染出图形或确定性占位（不抛错、不出现纯文本头像、不出现破图）—— AC-R6-4 边界 | L0-static + L1（边界） | AC-R6-4；S4 验收 3 边界 |

### 4.5 S5 文档口径同步 + 证据快照 banner 治理（关闭 RESEARCH E2）——自动化：L4 `evidence-banner --check` + `check-docs.mjs` + 源码扫描

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S5-01 | 🟢 P1 | S5 合入：本目录各阶段产物均已 promote | `node scripts/ci/evidence-banner.mjs --check` | 退出码 0；缺失清单**不含** `docs/G-mv7kzgnu-1` —— E2 | L4 | E2；S5 验收 1 |
| TC-S5-02 | 🟢 P1 | 本文件（TEST_CASES.md）已写入 | 检索本文件首 4 行 | 含 `<!-- evidence-banner:start -->` 段 —— E2、I-7 | L0-static | E2；I-7；S5 验收 1 |
| TC-S5-03 | 🟢 P1 | S5 合入 | `node scripts/ci/check-docs.mjs` | 退出码 0（README/FEATURES/STATUS 一致 + banner 覆盖完整 + 表格形状 0 异常）—— S5 验收 2 | L4 | S5 验收 2 |
| TC-S5-04 | 🟢 P1 | S5 合入 | 读 `workbench/README.md`，检索「零图片资源」 | 命中数 = 0（该说法自 2026-10-13 起已过期）—— S5 验收 3 | L0-static | S5 验收 3 |
| TC-S5-05 | 🟢 P1 | 同 TC-S5-04 | 读 `workbench/README.md` 与 `docs/FEATURES.md`，检索旧口径 `⚙️ … 执行中` | 两文件均不再把齿轮 emoji 作为外部执行者的现状描述 —— AC-R7-1（文档面）、RK-7 | L0-static | AC-R7-1；RK-7；S5 验收 4 |
| TC-S5-06 | 🟢 P1 | 同 TC-S5-04 | 检索改写后的口径句 | 两文件含「外部执行者也拿 `human:<key>` 人形令牌」的口径（与实现一致）—— AC-R2-1（文档面） | L0-static | AC-R2-1；S5 验收 4 |
| TC-S5-07 | 🟢 P2 | 同 TC-S5-04 | 检索过程叙事（`P1/P2/P3…已交付`、`切片 Sx…已交付`） | 两文件命中数 = 0（产品文档不写过程）—— S5 验收 5 | L0-static | S5 验收 5 |
| TC-S5-08 | 🔴 P1 | S5 合入 | 反向注入：删掉本目录任一 top-level md 的 banner 段，复跑 TC-S5-01 | banner 门禁**变红**并点名该文件；若仍绿则判 FAIL —— E2 反向 | L4（负例注入） | E2；S5 验收 1 反向 |
| TC-S5-09 | 🔴 P1 | S5 合入 | 反向注入：把 `workbench/README.md` 的旧口径句改回，复跑 TC-S5-05 | 文档口径门禁**变红**；若仍绿则判 FAIL —— AC-R7-1 反向 | L0-static（负例注入） | AC-R7-1；S5 验收 4 反向 |

### 4.6 端到端验收用例（对应 REQUIREMENTS §6 的 M-1~M-7；tester 在 T-209 逐条执行写报告）

> 每个 E2E 用例都在**隔离环境**中执行：临时库（`TEAM_HUB_DB=mkdtemp/team.db`）+ 空闲端口；**不触碰 live 库与主工作区**。E2E-8 的人工判据须在 TEST_REPORT.md 中记录评审人、样本与结论。

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| E2E-1 | 🟢 P0 | S1 合入；`team-hub/team.db` 或其副本 | 复跑枚举脚本（改后口径）：统计 software 空间 `/api/roster` 中 `avatar` 不满足 R-1 判据（合法 **且** 命中位面）的条数 | 不满足条数 = **0**（改前为 4）—— M-1、AC-R1-2、AC-R2-4 | L0 | M-1；AC-R1-2；AC-R2-4 |
| E2E-2 | 🟢 P0 | S1 合入；全空间数据 | 遍历 `GET /api/roster`（scope 空）与 `GET /api/agents` 全部条目，统计 `avatar` 非空但不满足 `isAvatarToken` 的条数 | 非法计数 = **0**（改前 software+ozon 共 5 条）—— M-2、AC-R7-1、AC-R7-3 | L0-HTTP | M-2；AC-R7-1；AC-R7-3 |
| E2E-3 | 🟢 P0 | S1/S2 合入 | software 12 条（8 内编 + 4 外部）分别取 `avatar`、解析 key、图片文件 | 三者各自去重后仍为 **12**；4 条外部不与 8 内编共用 key/图 —— M-3、AC-R4-1、AC-R4-2 | L0 + L1 | M-3；AC-R4-1；AC-R4-2 |
| E2E-4 | 🟢 P0 | S1 合入；可重启 hub | 同一 scope 连续请求 `/api/roster` ≥3 次；重启 hub 后再请求；另比对 ozon/gf001/default 内编令牌与基线 | 4 条外部令牌逐次相同；重启后不变；其它空间内编令牌逐条不变 —— M-4、AC-R5-1、AC-R5-2、AC-R4-3 | L0-HTTP | M-4；AC-R5-1；AC-R5-2；AC-R4-3 |
| E2E-5 | 🟢 P0 | S1~S4 合入 | 抓取同一身份在 S1（目录）/S2（用户卡）/S3（左轨）/S4（工作区头部）/S5（场景列表）/S8（技能标签）的头像标识，两两比对 | general 在 S1/S2/S3 相等；4 条外部在 S1/S4/S5/S8 相等；S7 移动端按位面 parity 口径（外部不进 `/api/agents`，不出展示用例，见 A-5）—— M-5、AC-R6-1、AC-R6-2、AC-R3-2 | L2 | M-5；AC-R6-1；AC-R6-2；AC-R3-2 |
| E2E-6 | 🟢 P0 | S1 合入 | 改前/改后取 `/api/spaces` 的 `agentCount`、`/api/agents` 的 role 集合、`tasks.soldier`/`role` 值、`/api/roster` 除 `avatar` 外字段 | 全部逐项相同（外部执行者未因补头像变成成员、归属未被改写）—— M-6、AC-R9-1、AC-R9-2、AC-R9-4 | L0-HTTP | M-6；AC-R9-1；AC-R9-2；AC-R9-4 |
| E2E-7 | 🔴 P0 | S1~S4 合入；可注入非法令牌/404 | 注入非法令牌与模拟图片 404，遍历各展示面 | 显示确定性占位人形；无破图图标、无裸露 alt/文件名、无 emoji 回退；回退不写回库 —— M-7、AC-R10-1、AC-R10-2、AC-R10-3、AC-R6-4 | L2 + L1（负例） | M-7；AC-R10-1；AC-R10-2；AC-R10-3；AC-R6-4 |
| E2E-8 | 🟡 P0 | S2 合入；可运行对照图工具 | `node workbench/scripts/render-avatar-sheet.mjs --only=s11,s12,s13,s14,s15` 生成对照图，由 ≥1 名独立评审人判定「看得出是人形」且 5 张两两不同 | 人形可辨 ≥4/5 且两两不同 5/5；记录评审人、样本与结论 —— RK-A1、M-1 | 评审 | RK-A1；M-1 |

## 5. 关键业务规则：正向 + 反向成对（验收标准用例化的机器可复核部分）

> 每条业务规则必须有**正向**（🟢，主路径成立）与**反向**（🔴，规则被违反时能被检出/拒绝）两类用例；§8 的机器自检逐行校验「正向引用必须 🟢、反向引用必须 🔴，且引用存在」。

| BR | 业务规则（一句话） | 正向用例（🟢） | 反向用例（🔴） |
| --- | --- | --- | --- |
| BR-1 | 外部执行者头像 = 合法 `human:<key>` **且** 命中位面表；绝不产 emoji / 非法串 | TC-S1-02 | TC-S1-14 |
| BR-2 | 已点名身份 → 冻结令牌，构造性唯一、与占用集合/顺序无关 | TC-S1-01 | TC-S1-15 |
| BR-3 | 两端「名字→令牌」表逐项同轴（镜像 + parity），位面表规模不回归（40） | TC-S2-01 | TC-S2-11 |
| BR-4 | 确定性：同 name 恒同令牌，分配路径零随机/零时钟/零网络 | TC-S1-06 | TC-S1-20 |
| BR-5 | 补头像不落 roster 行、不改成员计数与任务归属（无不可见副作用） | TC-S1-08 | TC-S1-16 |
| BR-6 | 任何头像不可用 → 确定性占位人形，无破图/无裸露 alt/无 emoji 回退，且不写回库 | TC-S4-04 | E2E-7 |
| BR-7 | 假绿防线：令牌「格式合法」≠「已换头像」，判据 = 合法 **且** 命中位面 | TC-S2-02 | TC-S2-15 |
| BR-8 | general 客户端两处（用户卡/左轨）图形化，不再用字符/文字充当头像 | TC-S3-01 | TC-S3-09 |
| BR-9 | general 在 S1/S2/S3 三处同源一致（同常量、同令牌 `human:s11`） | TC-S3-03 | TC-S3-10 |
| BR-10 | 单一视觉来源：不得新增第二套画法/配色/候选表（允许「名字→令牌」映射） | TC-S4-03 | TC-S2-14 |
| BR-11 | 未登记/池满 → 空串占位语义，绝不 emoji/非法串（R-8 默认口径） | TC-S1-04 | TC-S1-17 |
| BR-12 | S8 技能授权标签对不在 `/api/agents` 目录的 id 也渲染头像（D-5 纳入） | TC-S4-01 | TC-S4-08 |
| BR-13 | 新增 `*.test.mjs` 必须登记进 CI 套件清单（否则判 FAIL 点名） | TC-S2-06 | TC-S2-12 |
| BR-14 | 本目标新增文档自带历史快照 banner（含 TEST_CASES.md） | TC-S5-02 | TC-S5-08 |
| BR-15 | 文档口径同步：旧「⚙️ × 执行中」「零图片资源」不再作现状，且不误伤界面齿轮图标 | TC-S5-05 | TC-S5-09 |

## 6. R-8 口径（**非门槛**，TASK_BREAKDOWN §6 强制显式记录）

> TASK_BREAKDOWN §6「R-8 容量」要求：**T-206 不得把 AC-R8-1 写成必过**。方案 A 默认下，5 个已点名身份占满 `s11..s15`，未登记的新外部名字没有空闲位面可分配，只能落空串（占位语义）。因此本目标对 R-8 的口径是：

| 项 | 口径 | 用例 |
| --- | --- | --- |
| AC-R8-1（新 name 自动拿到合法头像） | **默认不满足**：在 static 表命中之外，只有「有空位」夹具里能拿到合法令牌；真实 software 空间里 `s01..s10` 已被内编占用 ⇒ 未登记名字落 `''` | TC-S1-04（有空位）、TC-S1-05（池满） |
| AC-R8-2（取消任务后不残留半成品） | 不设必过用例；行为等价于「投影是每次请求实时合成」，无库副作用（由 TC-S1-08 的「不落行」间接覆盖） | TC-S1-08 |
| AC-R8-3（不要求新增 roster 行；若落行须显式裁决） | 本目标按 D-1 **不落行**；落行是反向注入点，由 TC-S1-16 检出 | TC-S1-16 |
| 若要 AC-R8-1 必过 | 需将军裁决扩容 `s16..s24`，并 4 处同步：`slots.ts` / `workbench/mobile/avatar.mjs` / `agent-avatar.test.mjs` 的 `SPARES` / `avatar-parity.test.mjs` 的 40 断言 | —— |

## 7. 验收口径 → 用例追溯矩阵（35 条 AC 全覆盖；§8 机器校验「无悬空 AC、无重复行」）

| AC | 口径摘要 | 承载用例 | 判据类型 |
| --- | --- | --- | --- |
| AC-R1-1 | 每条 roster 结果满足 `isAvatarToken` 且 `resolveSlot !== null` | TC-S1-02、TC-S2-02、TC-S2-05、TC-S2-15 | 接口 + parity + 负例注入 |
| AC-R1-2 | 判据可复现：software 命中 4 条与实测一致 | E2E-1 | 枚举脚本复跑 |
| AC-R1-3 | 判据不得把 `PLACEHOLDER_SLOT` / 灰阶色值作为通过条件 | TC-S2-02、TC-S1-17 | parity + 异常 |
| AC-R2-1 | 4 条外部身份 `avatar` 合法且命中（人形位面/图片） | TC-S1-01、TC-S1-02、TC-S1-03、TC-S5-06 | 接口 + 数据面 |
| AC-R2-2 | 响应体与渲染 DOM 无 emoji 码点作头像内容 | TC-S1-08、TC-S1-17 | 全量扫描 + 异常 |
| AC-R2-3 | 4 条解析 key ≠ `'placeholder'`，不是同一张剪影 | TC-S2-02、TC-S3-11 | parity + 渲染 |
| AC-R2-4 | 改后 software「不满足条数 = 0」 | E2E-1 | 枚举脚本复跑 |
| AC-R3-1 | `.user-avatar` 内是图形节点，DOM 无 `⚙` / `管` 作头像内容 | TC-S3-01、TC-S3-02、TC-S3-11 | 源码扫描 + 渲染 |
| AC-R3-2 | S1 的 general 条目与 S2 用户卡头像标识相等 | TC-S3-04、E2E-5 | 源码 + 跨面比对 |
| AC-R3-3 | general 的头像 key/图片与 software 8 内编均不相同 | TC-S3-05、TC-S2-03 | parity |
| AC-R4-1 | software 空间内两两不同（12 条唯一） | TC-S1-03、TC-S2-03、E2E-3 | 接口 + parity + 端到端 |
| AC-R4-2 | 4 条外部 key 不在 `BUILTIN_ROLE_KEYS`、不与 8 内编重合 | TC-S2-03、E2E-3 | parity + 端到端 |
| AC-R4-3 | 其它空间既有内编令牌逐条不变 | TC-S1-13、E2E-4 | 回归 + 端到端 |
| AC-R5-1 | 连续 ≥3 次请求 4 条令牌逐次相同 | TC-S1-06、E2E-4 | 数据面 + 端到端 |
| AC-R5-2 | 重启 hub 后 4 条令牌不变 | E2E-4 | 端到端 |
| AC-R5-3 | 分配路径无 `Math.random` / `Date.now` / 网络 | TC-S1-07、TC-S1-20、TC-S2-04 | 静态扫描 + 负例注入 |
| AC-R5-4 | 幂等：重复执行种子/迁移不改变已存在的合法令牌 | TC-S1-06、TC-S1-13 | 数据面 + 回归 |
| AC-R6-1 | S1/S2/S3 对 general、S1/S4/S5/S8 对 4 条外部身份均可取到头像标识 | E2E-5 | 跨面比对 |
| AC-R6-2 | 同身份跨面头像标识两两相等；移动端同 key 同位面 | TC-S2-01、TC-S2-07、TC-S2-09、TC-S3-04、E2E-5 | parity + 端到端 |
| AC-R6-3 | S8 对不在目录的 id 显示同一头像（D-5 取「纳入」） | TC-S4-01、TC-S4-02、TC-S4-08 | 源码扫描 + 负例注入 |
| AC-R6-4 | 令牌非法/图片 404 时显示占位人形（不破图、不裸露文件名/alt） | TC-S4-04、TC-S3-11、E2E-7 | 渲染 + 端到端 |
| AC-R7-1 | `/api/roster` + `/api/agents` 非空 `avatar` 必满足 `isAvatarToken`，非法计数 = 0 | TC-S1-08、E2E-2 | 全量扫描 + 端到端 |
| AC-R7-2 | 出现 `''` 的条目确定性渲染占位人形且不写回库 | TC-S1-05、TC-S2-13 | 边界 |
| AC-R7-3 | `⚙`/`⚙️` 作界面齿轮图标的既有用法不受影响 | TC-S3-12、E2E-2 | 源码扫描 |
| AC-R8-1 | 新外部名字自动得头（**非门槛 · 默认不满足**，见 §6） | TC-S1-04、TC-S1-05 | 非门槛（默认口径） |
| AC-R8-2 | 取消任务后不残留半成品（非门槛） | — | 非门槛（不设必过） |
| AC-R8-3 | 分配不要求新增 roster 行（非门槛） | — | 非门槛（不设必过） |
| AC-R9-1 | 除 `avatar` 外字段逐字段与基线相同 | TC-S1-09、TC-S1-18、E2E-6 | diff + 端到端 |
| AC-R9-2 | `agentCount` 与 `/api/agents` role 集合前后一致 | TC-S1-08、TC-S1-16、E2E-6 | 接口 + 负例注入 |
| AC-R9-3 | 不新增以 name/avatar 为键的唯一约束或前端 key | TC-S1-09、TC-S3-06 | 源码扫描 |
| AC-R9-4 | `tasks.soldier`/`role` 不被改写；不新增鉴权旁路 | TC-S1-18、E2E-6 | 接口 + 端到端 |
| AC-R10-1 | 模拟图片 404 显示占位人形（矢量），无破图/裸露 alt | E2E-7 | 端到端（负例） |
| AC-R10-2 | 回退只是渲染态，不写回 roster | E2E-7 | 端到端（负例） |
| AC-R10-3 | 移动端头像缺失时降级不报错 | TC-S2-09、E2E-7 | parity + 端到端 |
| AC-R11-1 | 全空间跑 R-1 判据（D-3 默认统一覆盖，门槛只算 software） | TC-S1-11 | 接口（P1 回归面） |

> **M-1~M-7 追溯**：M-1 → E2E-1；M-2 → E2E-2；M-3 → E2E-3；M-4 → E2E-4；M-5 → E2E-5；M-6 → E2E-6；M-7 → E2E-7（判据摘要见 §3 与 §4.6）。**AC-R8-1/2/3 为非门槛**（§6），不作为本目标验收放行条件。

## 8. 附录 A：用例文档自检（machcheck，供 coder/tester 一键复核）

- 脚本：`docs/G-mv7kzgnu-1/T206-evidence/machcheck-test-cases.mjs`（零第三方依赖，仅 `node:fs` / `node:path` / `node:os` / `node:child_process`）。
- 运行：`node docs/G-mv7kzgnu-1/T206-evidence/machcheck-test-cases.mjs`
- 校验项：① 用例行 9 段（7 列）完整且无空列；② ID 唯一；③ 类别（🟢/🟡/🔴）与优先级（P0/P1/P2）枚举合法；④ §0 声明的总数 / 各切片 / 各类别 / 各优先级与实测一致；⑤ 35 条 AC 在 §7 恰好各出现一次，且引用的用例存在（无悬空 AC）；⑥ §5 的 15 条 BR 正反向配对（正向引用必须 🟢、反向必须 🔴）；⑦ §9 附录 B 的 ~~~js` 骨架逐个 `node --check`；⑧ M-1~M-7 在 §7 有追溯行。
- 产物：`T206-evidence/01-doc-machcheck.txt`（主校验输出）；结论即文首 §0 的机器自检读数。
- 说明：本脚本**只校验文档结构与骨架语法**，不执行任何业务用例（执行是 T-209 tester 的职责）。

## 9. 附录 B：逐切片可照抄测试代码骨架（coder 在各切片文件域内物化；**本阶段不预写文件**，以免与 coder 合入冲突、并避免未登记 `*.test.mjs` 触发 CI「套件清单完备性」红）

> 使用前提：S1 尚未合入时 S2/S3/S4 的骨架会因模块不存在而红——这是 TASK_BREAKDOWN §3 已声明的串行约束，不是骨架缺陷。函数名以各切片实现为准（语义冻结见 TASK_BREAKDOWN §1.2），骨架给出的是**断言集合**，coder 只需替换调用面。

### B.1 S1 服务端 → 追加到 `team-hub/team-views-routes.test.mjs`（既有文件，改写 ⑥ 而不是删除）

~~~js
// 追加到 team-hub/team-views-routes.test.mjs（S1 文件域）。运行：node team-hub/team-views-routes.test.mjs
// 顶部追加 import：import { EXTERNAL_AVATAR_TOKENS, externalAvatarFor, isAvatarToken } from './agent-avatars.mjs'
const FROZEN = {
  general: 'human:s11', 'soldier-a': 'human:s12', 'soldier-b': 'human:s13',
  'soldier-auto': 'human:s14', 'soldier-market': 'human:s15',
}
const FROZEN_TOKENS = Object.values(FROZEN)
const SPARE_TOKENS = Array.from({ length: 15 }, (_, i) => 'human:s' + String(i + 1).padStart(2, '0'))
const FREE_TOKENS = SPARE_TOKENS.filter((t) => !FROZEN_TOKENS.includes(t))
const GEAR = '\u2699\uFE0F'

test('⑥（改写）外部执行者的头像不再是齿轮 emoji，非空时必须是合法令牌', async () => {
  reset()
  mkRoster('default', 'r', '正式岗位')
  mkTask('s1', { role: 'solo-soldier', soldier: 'solo-soldier', status: 'in_progress' })
  const ext = (await get('/api/roster')).body.agents.find((a) => a.external)
  assert.ok(ext, '未入编队的执行者必须仍返回')
  assert.notEqual(ext.avatar, GEAR, '本轮推翻旧期望：不再产出齿轮 emoji')
  assert.ok(ext.avatar === '' || isAvatarToken(ext.avatar), '非空必须是 human:<key>：' + ext.avatar)
})

test('⑥c 已点名的外部身份逐条拿到冻结令牌（AC-R2-1 / AC-R4-1）', async () => {
  reset()
  mkRoster('software', 'devops', '启舟')
  let n = 0
  for (const name of Object.keys(FROZEN)) {
    n += 1
    mkTask('ext' + n, { scope: 'software', role: name, soldier: name, status: 'in_progress' })
  }
  const ext = (await get('/api/roster?scope=software')).body.agents.filter((a) => a.external)
  assert.equal(ext.length, 5, '5 个已点名外部身份都要出现')
  for (const a of ext) assert.equal(a.avatar, FROZEN[a.role], a.role + ' 必须拿到冻结令牌')
  assert.equal(new Set(ext.map((a) => a.avatar)).size, 5, '5 条令牌两两不同')
})

test('⑥d 静态表 + 兜底都是纯函数（AC-R5-1 / AC-R5-3；R-8 非门槛口径）', () => {
  assert.deepEqual(EXTERNAL_AVATAR_TOKENS, FROZEN)
  for (const name of Object.keys(FROZEN)) {
    assert.equal(externalAvatarFor(name, []), FROZEN[name])
    assert.equal(externalAvatarFor(name, SPARE_TOKENS), FROZEN[name], '已点名身份不受占用集合影响')
  }
  assert.equal(externalAvatarFor('solo-new', []), externalAvatarFor('solo-new', []), '同 name 同集合恒同')
  const spare = externalAvatarFor('solo-new', [])
  assert.ok(spare === '' || isAvatarToken(spare), '只可能是合法令牌或空串：' + spare)
  assert.ok(!FROZEN_TOKENS.includes(spare), '未登记名字不得抢占冻结令牌')
  assert.equal(externalAvatarFor('solo-new', FREE_TOKENS), '', '池满必须返回空串（占位语义）')
  for (const bad of ['', null, undefined, GEAR]) {
    const got = externalAvatarFor(bad, [])
    assert.ok(got === '' || isAvatarToken(got), '异常入参只返回合法令牌或空串：' + String(got))
  }
})
~~~

### B.2 S2 客户端镜像 + 两端 parity → 新增 `workbench/scripts/external-avatar-parity.test.mjs`（并登记进 `scripts/ci/run-ci.mjs`）

~~~js
// workbench/scripts/external-avatar-parity.test.mjs（S2 新增）
// 运行：node workbench/scripts/external-avatar-parity.test.mjs（ts.transpileModule 装载 .ts，零新增依赖）
import { describe, test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SRC = resolve(ROOT, 'workbench', 'src', 'avatar')
const TMP_CLIENT = join(HERE, '.external-agents.mjs')
const TMP_SLOTS = join(HERE, '.external-slots.mjs')

function transpile(from, to, rewrite) {
  const out = ts.transpileModule(readFileSync(from, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  })
  let code = out.outputText
  if (rewrite) code = code.replace(/['"]\.\/slots['"]/g, "'./.external-slots.mjs'")
  writeFileSync(to, code, 'utf8')
}

transpile(join(SRC, 'slots.ts'), TMP_SLOTS, false)
transpile(join(SRC, 'external-agents.ts'), TMP_CLIENT, true)
const SLOTS = await import(pathToFileURL(TMP_SLOTS).href)
const CLIENT = await import(pathToFileURL(TMP_CLIENT).href)
const SERVER = await import(pathToFileURL(resolve(ROOT, 'team-hub', 'agent-avatars.mjs')).href)

after(() => {
  try { rmSync(TMP_CLIENT, { force: true }) } catch { /* 清理 */ }
  try { rmSync(TMP_SLOTS, { force: true }) } catch { /* 清理 */ }
})

const SOFTWARE_BUILTIN = ['requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops']

describe('S2 外部执行者「名字→令牌」客户端镜像 + 两端 parity', () => {
  test('TC-S2-01 两端表逐项相等（AC-R6-2 / AC-R5-1）', () => {
    assert.deepEqual(CLIENT.EXTERNAL_AGENT_AVATARS, SERVER.EXTERNAL_AVATAR_TOKENS)
  })

  test('TC-S2-02/05 令牌合法 + 命中位面 + 假绿防线（AC-R1-1 / AC-R1-3 / RK-A3）', () => {
    for (const [name, token] of Object.entries(CLIENT.EXTERNAL_AGENT_AVATARS)) {
      assert.match(token, /^human:[a-z0-9][a-z0-9-]*$/, name)
      const slot = SLOTS.resolveSlot(token)
      assert.ok(slot && slot.key !== 'placeholder', name + ' 必须命中位面表：' + token)
    }
    assert.equal(SLOTS.resolveSlot('human:general'), null, '格式合法但无位面 = 假绿，必须为 null')
    assert.notEqual(SLOTS.resolveSlot('human:s11'), null, '已登记空闲位面必须真的换脸')
  })

  test('TC-S2-03 5 个 key 两两不同且不与内编撞（AC-R4-1 / AC-R4-2）', () => {
    const keys = Object.values(CLIENT.EXTERNAL_AGENT_AVATARS).map((t) => t.slice('human:'.length))
    assert.equal(new Set(keys).size, keys.length)
    for (const k of keys) {
      assert.ok(!SLOTS.BUILTIN_ROLE_KEYS.includes(k), k + ' 不得占用内编岗位 key')
      assert.ok(!SOFTWARE_BUILTIN.includes(k), k + ' 不得占用 software 内编 key')
    }
  })

  test('TC-S2-07 位面表两端仍 40 key 且逐项相同（I-2 / AC-R6-2）', async () => {
    const MOBILE = await import(pathToFileURL(resolve(ROOT, 'workbench', 'mobile', 'avatar.mjs')).href)
    const a = [...SLOTS.slotKeys()].sort()
    const b = [...MOBILE.slotKeys()].sort()
    assert.deepEqual(a, b)
    assert.equal(a.length, 40)
  })

  test('TC-S2-04/13 纯函数与边界（AC-R5-3 / AC-R7-2）', () => {
    for (const [name, token] of Object.entries(CLIENT.EXTERNAL_AGENT_AVATARS)) {
      assert.equal(CLIENT.externalAvatarToken(name), token)
      assert.equal(CLIENT.externalAvatarToken(name), token)
    }
    for (const bad of ['', 'solo-new', null, undefined]) {
      const got = CLIENT.externalAvatarToken(bad)
      assert.ok(got === '' || /^human:/.test(String(got)), '只可能是合法令牌或空串：' + String(got))
    }
    const src = readFileSync(join(SRC, 'external-agents.ts'), 'utf8')
    for (const banned of ['Math.random', 'Date.now', 'performance.now', 'new Date', 'fetch(', 'http://', 'https://']) {
      assert.ok(!src.includes(banned), '不得出现 ' + banned)
    }
  })
})
~~~

### B.3 S3 general 两处客户端面 → 追加到 `workbench/scripts/agent-avatar-surfaces.test.mjs`

~~~js
// 追加到 workbench/scripts/agent-avatar-surfaces.test.mjs（S3 文件域）。运行：node workbench/scripts/agent-avatar-surfaces.test.mjs
const GEAR_CHAR = '\u2699'

test('TC-S3-01 用户卡头像图形化，不再用齿轮字符（AC-R3-1）', () => {
  const src = read('workbench/src/components/Sidebar.tsx')
  const m = /<div className="user-avatar">([\s\S]*?)<\/div>/.exec(src)
  assert.ok(m, '必须仍有 .user-avatar 节点')
  assert.ok(m[1].includes('<AgentAvatar'), '.user-avatar 内必须是 <AgentAvatar>')
  assert.ok(!new RegExp('user-avatar">\\s*' + GEAR_CHAR).test(src), '不得再把齿轮字符当头像内容')
})

test('TC-S3-02 左轨管理员徽标图形化，不再用「管」文字（AC-R3-1）', () => {
  const src = read('workbench/src/components/WorkspaceNavigation.tsx')
  assert.ok(/className="workspace-user"[\s\S]{0,160}<AgentAvatar/.test(src), '.workspace-user 内必须是 <AgentAvatar>')
  assert.ok(!/className="workspace-user"[^>]*>管</.test(src), '不得再用「管」充当徽标')
})

test('TC-S3-03/04 两处同源 + general 令牌 = human:s11（AC-R3-2 / AC-R6-2）', () => {
  for (const f of ['Sidebar.tsx', 'WorkspaceNavigation.tsx']) {
    assert.ok(/from\s+['"][^'"]*external-agents['"]/.test(read('workbench/src/components/' + f)), f + ' 必须从 external-agents 取常量')
  }
  const ext = read('workbench/src/avatar/external-agents.ts')
  assert.ok(/general['"]?\s*:\s*['"]human:s11['"]/.test(ext), 'general 必须是 human:s11')
})

test('TC-S3-12 界面齿轮图标不被误伤（AC-R7-3）', () => {
  assert.ok(read('workbench/src/components/Sidebar.tsx').includes(GEAR_CHAR), 'Sidebar 的界面齿轮用法仍在')
  assert.ok(read('workbench/src/components/CommandBar.tsx').includes('模型配置'), 'CommandBar 的模型配置入口仍在')
})
~~~

### B.4 S4 技能授权标签（S8）→ 追加到 `workbench/scripts/agent-avatar-settings.test.mjs`

~~~js
// 追加到 workbench/scripts/agent-avatar-settings.test.mjs（S4 文件域）。运行：node workbench/scripts/agent-avatar-settings.test.mjs
test('TC-S4-01/02 S8 对不在目录的 id 也渲染头像（AC-R6-3 / D-5）', () => {
  const src = read('workbench/src/components/SkillsPanel.tsx')
  const avatars = (src.match(/<AgentAvatar/g) || []).length
  assert.ok(avatars >= 3, '三处成员标签都要渲染 <AgentAvatar>，实测 ' + avatars)
  assert.ok(!/\{a\s*&&\s*<AgentAvatar/.test(src), '不得再是「目录查不到 ⇒ 不渲染头像」的条件形态')
  assert.ok(/external-agents/.test(src), '必须引用 external-agents 兜底表')
})

test('TC-S4-03 无第二套视觉表 / 无破图路径（AC-R4-4 / I-6）', () => {
  const src = read('workbench/src/components/SkillsPanel.tsx')
  assert.ok(!/const AVATARS\s*=/.test(src), '不得有第二套头像表')
  assert.ok(!src.includes('AVATAR_CHOICES'), '不得有 emoji 候选表')
  assert.ok(!/<img[^>]*avatar/i.test(src), '头像不走 <img（防破图/裸露 alt）')
})
~~~

### B.5 S5 文档口径 + banner → 无需新增测试文件（由 `evidence-banner.mjs` / `check-docs.mjs` 与 `node -e` 断言覆盖）

~~~js
// node -e 口径（S5 验收 3/4 的可复制命令；在仓库根运行）
const { readFileSync } = require('node:fs')
const readme = readFileSync('workbench/README.md', 'utf8')
const features = readFileSync('docs/FEATURES.md', 'utf8')
const bad1 = readme.includes('零图片资源')
const GEAR_ROW = /⚙️[^\n]{0,12}执行中/
const bad2 = GEAR_ROW.test(readme) || GEAR_ROW.test(features)
if (bad1 || bad2) {
  console.error('FAIL 旧口径仍在：零图片资源=' + bad1 + ' 齿轮执行中=' + bad2)
  process.exit(1)
}
console.log('PASS 文档口径已同步（零图片资源=0，齿轮执行中=0）')
~~~

## 10. 附录 C：本阶段自检（逐条对应 T-206 验收标准）与关联文档

| T-206 验收标准 | 本文落点 | 结论 |
| --- | --- | --- |
| 用例覆盖 主路径 + 边界 + 异常，每条含 前置条件 / 步骤 / 期望结果 | §4 各表 7 列（ID / 类·优 / 前置条件 / 操作步骤 / 期望结果与通过判据 / 自动化 / 追溯）；类别 🟢 52 / 🟡 6 / 🔴 15 | ✅ |
| 验收标准被用例化：有明确的通过 / 失败判据 | §3 唯一线表 + 每条「期望结果 / 通过判据」列 + §7 的 35 条 AC 全覆盖矩阵 + §6 E2E 的 M-1~M-7 | ✅ |
| 关键业务规则同时有正向与反向用例 | §5 的 BR-1~BR-15 逐条配对（正向引用必 🟢、反向引用必 🔴，§8 机器校验） | ✅ |
| 做：把验收标准逐条翻译成可执行用例 | §4 全部用例可追溯到 S1~S5 验收行分句与 AC 编号；§9 骨架可照抄 | ✅ |
| 不做：不执行用例（执行是 tester 的职责） | §2 明示分层与执行人；本文只给命令与判据，未跑任何业务用例（§0 的读数是**既有基线**的环境事实） | ✅ |
| 不做：不写业务实现代码 | 本任务只新增 `docs/G-mv7kzgnu-1/TEST_CASES.md` 与 `T206-evidence/` 自检脚本/输出；未改任何产品源码 | ✅ |
| 能落成测试代码的尽量一并写出 | §9 附录 B 给出 4 段可照抄骨架（逐个 `node --check` 通过，证据 `01-doc-machcheck.txt`），并说明为何不预写文件（文件域 + CI 清单完备性） | ✅ |
| 上游依赖：T-205 应已完成 | 本 worktree HEAD `9c4e242d promote T-205`；REQUIREMENTS/RESEARCH/TASK_BREAKDOWN 均在本目录可读 | ✅ |

| 关联文档 | 关系 |
| --- | --- |
| [REQUIREMENTS.md](./REQUIREMENTS.md) | 需求与 35 条 AC 的权威来源（本文 §7 逐条追溯） |
| [RESEARCH.md](./RESEARCH.md) | 方案 A 的选型、供给盘点与「假绿」反例（本文 §4/§6 的依据） |
| [TASK_BREAKDOWN.md](./TASK_BREAKDOWN.md) | S1~S5 切片、冻结令牌/接口、不变量与锚点 E1/E2（本文 §4 用例的翻译基准） |
| `docs/G-mv7kzgnu-1/T206-evidence/README.md` | 本阶段自检证据说明（machcheck 脚本与输出） |
| `docs/G-mv7kzgnu-1/TEST_REPORT.md`（T-209 产出） | tester 按本文 §2/§4.6 逐条执行后的结果登记（尚未产出） |
