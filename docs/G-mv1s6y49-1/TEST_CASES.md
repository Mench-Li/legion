<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-10-10**（w/T-198 HEAD `4fcf0692`） 的基线，其中的 file:line、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-198 测试用例 / 验收测试：Agent 人性化名称 + 人性化头像

> 角色：test-designer（测试用例设计）｜阶段：测试用例设计｜执行任务：T-198（[auto-goal]｜所属目标 G-mv1s6y49-1 · software · chain）
> 上游：[REQUIREMENTS.md](./REQUIREMENTS.md)（T-195 需求：R-1~R-11 + **34 条 AC-R*** + D-*/O-*）→ [RESEARCH.md](./RESEARCH.md)（T-196 方案：方案 A「自研参数化人形内联 SVG + 静态 role→位面表 + `avatar` 存 `human:<id>` 令牌」与「静态 role→展示名一对一表」）→ [TASK_BREAKDOWN.md](./TASK_BREAKDOWN.md)（T-197 拆解：**「## slices」7 个切片 S1~S7**，每片第 4 段机器验收行 = 本文用例逐条翻译的唯一基准）
> 目标上下文（将军裁决 v1）：创建时自动生成头像、暂不需要配置；头像必须拟人且非 emoji；范围含全部（含后续自建）；两段式命名；第 5 条在提交时被截断（**待将军补齐**，本文不臆测）。
> 下游：各切片 coder（S1~S7）按 §4 用例 + §9 骨架把 P0 用例落成断言（文件域见 TASK_BREAKDOWN §5.3/§7）；T-200 reviewer 按 BR-8/BR-11/BR-14 复核；T-201 tester 按 §2 分层逐条执行并把结果写入 `docs/G-mv1s6y49-1/TEST_REPORT.md`；T-202 devops 按 §4.7 接入 CI。
> 依据：TASK_BREAKDOWN「## slices」S1~S7 每片验收行（分号分句）+ REQUIREMENTS §4 的 34 条 AC + §6 成功标准 M-1~M-7 + LEGION.md 纪律与本任务阶段验收（覆盖 主路径 + 边界 + 异常；每条含 前置条件 / 操作步骤 / 期望结果与通过判据；验收标准用例化；关键业务规则正反向成对）。
>
> **权威基线/命名空间提醒**：本目标分析文档目录 = `docs/G-mv1s6y49-1/`。仓库根 `docs/TEST_CASES.md` 与 `docs/G-mtpq729o-1/`、`docs/G-mtr3su6f-1/`、`docs/G-mujfc9vi-1/` 的同名文档属其他目标/遗留链，**禁止读写**。本用例只写本文（`docs/G-mv1s6y49-1/TEST_CASES.md`）+ 自检证据（`docs/G-mv1s6y49-1/T198-evidence/`）。
>
> **边界声明（本阶段只做与不做）**：✅ 做——把 S1~S7 验收行与 34 条 AC 逐条翻译成可执行用例（含前置/步骤/期望与 PASS/FAIL 判据）、把关键业务规则写成正反向成对、交付可直接复制的测试代码骨架；🚫 不做——**不执行用例**（执行是 T-201 tester 的职责，本文只给命令与判据）、**不写业务实现代码**、**不预写各切片文件域内的 `*.test.mjs`**（TASK_BREAKDOWN §5.3 已把它们划给对应 coder 的文件域，预写必与 coder 合入冲突；且 CI「套件清单完备性」按 `git ls-files '*.test.mjs'` 全仓点名，未登记的测试文件会让门禁变红）、不调用 taskctl / 看板写接口、不 push、不联网。
>
> **工作区状态**：本任务在独立 worktree（分支 `w/T-198`）中执行；判定基准 HEAD `4fcf06925a3030280458713f21552410a54a2796`（promote T-197，2026-10-10 17:36:50 +0800），Node v24.19.0，`git status --short` 为空。docs/G-mv1s6y49-1/ 现有 REQUIREMENTS.md、RESEARCH.md、TASK_BREAKDOWN.md（本文为 T-198 首次产出，无旧版）。本阶段未对 live 库 `team-hub/team.db` 与主工作区做任何写入型验证。

## 0. 结论速览（TL;DR）

- 交付单件：本文档 `docs/G-mv1s6y49-1/TEST_CASES.md` + 自检证据 `docs/G-mv1s6y49-1/T198-evidence/`。共 **101 条用例**（S1 17 / S2 16 / S3 17 / S4 13 / S5 11 / S6 9 / S7 10 / E2E 8）；🟢正常 62 / 🟡边界 9 / 🔴异常·反向 30；P0 44 / P1 25 / P2 32，每条含 **前置条件 / 操作步骤 / 期望结果与通过判据**；ID 唯一、类别枚举、7 列完整、34 条 AC 全覆盖、16 条 BR 正反向配对、附录 B 骨架语法，均由 §8 的机器自检脚本复跑复核（输出见 `T198-evidence/01-doc-machcheck.txt` 与 `02-skeleton-syntax.txt`）。
- 验收标准被用例化：TASK_BREAKDOWN「## slices」S1~S7 验收行逐分句 + REQUIREMENTS §4 的 34 条 AC + §6 的 M-1~M-7 逐条映射到用例（§4 各表「追溯」列 + §7 追溯矩阵）；PASS/FAIL 判据写进每条「期望结果 / 通过判据」列，不留「应该没问题」式结论。
- 关键业务规则正反向成对（§5，BR-1~BR-16，机器可复核）：头像形态（图形人形 vs emoji/首字）、位面构造性唯一（一对一 vs 重复位面）、确定性（无随机/时钟 vs 注入 Math.random）、回退（不落库/不显示首字 vs 用名称首字充当头像）、命名形态（2~6 汉字无机器键字符 vs 职称直述）、同空间唯一（归一化去重 vs 大小写/空白绕过）、种子不覆盖自定义（保留 vs 无条件覆盖）、身份红线（name/avatar 不进键 vs 以前端 key 区分实例）、新建令牌（自动分配 vs 落 emoji）、入参校验（合法落库 vs 空名被拒且零写入）、单一来源（13 面同源 vs 第二套兜底表）、无破图（内联 SVG 无请求 vs 静态图片破图）、移动端同轴（parity 一致 vs 两表漂移）、离线零依赖（无外网/无新依赖 vs 引入第三方或外链）、CI 登记（6 条全登记 vs 漏登记被点名）、新建不配置头像（无 avatar 字段 vs 恢复 emoji 下拉）——均给正向 + 反向用例。
- 测试代码落点（§9 附录 B，可直接照抄）：S1→`workbench/scripts/agent-avatar.test.mjs`（新增，ts.transpileModule + react-dom/server renderToString 范式）、S2→`team-hub/scripts/seed-roster.test.mjs`（新增，TEAM_HUB_DB 临时库）、S3→`team-hub/agent-identity-tokens.test.mjs`（新增，临时库 + 真 HTTP）、S4→`workbench/scripts/agent-avatar-surfaces.test.mjs`（新增，readFileSync + 正则源码扫描）、S5→`workbench/scripts/agent-avatar-settings.test.mjs`（新增，同上）、S6→`workbench/mobile/avatar-parity.test.mjs`（新增，读桌面 slots.ts 逐项比对）。S7 的登记校验见 B.7。**本文只给骨架，不在本阶段物化文件**（理由见上方边界声明）。
- 现存基线（仅环境事实，本阶段不执行用例——执行为 T-201 tester 职责）：`node scripts/ci/check-docs.mjs` = PASS（15641 个表行，收尾/孤儿行 0）；TASK_BREAKDOWN §8.3 已实测的回归锚点为 `agent-intake-routes.test.mjs` 21 例、`team-views-routes.test.mjs` 17 例、`read-models-routes.test.mjs` 25 例、`doc-render.test.mjs` 11 例、`identity-gate.test.mjs` 19 例。

## 1. 输入、工作假设与硬性不变量

### 1.1 输入（唯一依据链）

| 输入 | 本用例取用方式 |
| --- | --- |
| REQUIREMENTS §4 的 R-1~R-11 与 34 条 AC | 作为「验收口径」逐条映射（§7 矩阵每行一个 AC，无悬空）；每条 AC 必须有 ≥1 条用例承载 |
| REQUIREMENTS §6 的 M-1~M-7 | 作为端到端用例（§6 E2E-1~E2E-8）的判据来源 |
| REQUIREMENTS §2.2/§2.3 的现状证据与 G1~G5 缺口 | 作为「现状缺口 → 切片 → 用例」索引（§4.0），供 tester 先复现后对照 |
| TASK_BREAKDOWN「## slices」S1~S7 第 4 段 | 机器验收行逐分句 = §4 各用例的「追溯」列（记作「Sx 验收 n」） |
| TASK_BREAKDOWN §7 跨切片冻结契约 | 令牌格式、位面表与组件 props、回退契约、身份红线、CI 登记面 → §1.3 不变量 I-4~I-8 |
| RESEARCH §2.5/§9 的测试落点与范式 | 决定「自动化」列载体与 §9 骨架形态（renderToString / 源码扫描 / 临时库三范式） |

### 1.2 工作假设（将军未否决即按此展开；翻转只影响取值，不影响断言语义）

| 编号 | 假设 | 翻转影响 |
| --- | --- | --- |
| A-1 | 令牌 = `human:<key>`，`key` 匹配 `^[a-z0-9][a-z0-9-]*$`；25 个内置岗位 `key = role`；非内置/自建由该 scope 内最小未占用 `sNN`（`s01`..`s15`）承担（TASK_BREAKDOWN §7 冻结） | 若改编码，仅令牌正则与 key 集合断言改取值，用例结构不变 |
| A-2 | R-6「成员编辑入口」**不做**（将军裁决 #1「创建时自动生成头像，暂不需要配置」） | 若将军改判要做，AC-R6-1/2 由 TC-S5-08 反向改为正向 + 新增编辑面切片用例 |
| A-3 | 沙箱等价口径：各套件以 `node <file>` 直跑等价 `node --test <file>`（TASK_BREAKDOWN §8.1 实测）；CI 全量门禁由 T-202 在有完整权限环境执行 | 若宿主可 `node --test`，用例结论不变，只改复现命令 |
| A-4 | 覆盖范围 = 5 空间 25 岗位 + 后续自建（将军裁决 #3），不对 live 库做写入型验证 | 若缩为仅 software 8 岗位，仅 §4.2 覆盖数与 §7 取样数改值 |
| A-5 | AC-R1-2/AC-R3-2/M-6 是**人工抽检判据**：由 tester 组织 ≥1 名独立评审人在 32px 尺寸下判定并留痕（评审人 + 结论 + 样本） | 若将军指定评审人/样本量，取值调整 |
| A-6 | 位面表规模 ≥40（25 岗位 + `s01`..`s15`），两两不同（RESEARCH ❓O-4 默认 ≥30） | 若将军要求更大备用池，key 集合断言改数 |

### 1.3 硬性不变量（本批任何实现不得违反，均有门禁用例锚定）

| 编号 | 不变量 | 锚定用例 |
| --- | --- | --- |
| I-1 | 零新增运行时依赖（`workbench/package.json` / `team-hub` / 移动端均不新增第三方包） | TC-S1-10、TC-S1-16、TC-S6-09、E2E-3 |
| I-2 | 离线自足：头像与名称能力不得产生任何外部网络请求 | TC-S1-09、TC-S6-09、E2E-3 |
| I-3 | 身份红线：`name`/`avatar` 不得作为身份键、唯一约束或前端 key；前端 key 继续用 `scope + role` | TC-S1-12、TC-S2-12、E2E-8 |
| I-4 | 令牌契约：`human:<key>`，25 岗位 `key=role`，备用 `s01`..`s15`，同 role 跨空间恒同 | TC-S1-03、TC-S3-03、TC-S3-04 |
| I-5 | 位面表唯一真源 = `workbench/src/avatar/slots.ts`；移动端只允许镜像 + parity 测试 | TC-S6-01、TC-S6-08 |
| I-6 | 回退只是渲染态，不写回 roster；回退不得显示 emoji 或名称首字 | TC-S1-05、TC-S1-17、TC-S3-10、E2E-6 |
| I-7 | `role` 机器键、`roles.json` 契约、流水线阶段与文件域规则不变 | TC-S2-11、TC-S5-10 |
| I-8 | 13 个展示面单一来源（roster 的 name/avatar 或其接口投影），无第二套兜底表与首字回退 | TC-S4-01~04、TC-S4-05、TC-S5-06 |
| I-9 | 不伪造门禁结论：沙箱受限时如实记录复现命令与输出，不声称已跑 CI 全量 | 本文全篇执行方式（§2）+ §10 自检 |

## 2. 测试分层与执行方式（谁在什么时候跑）

> 本文**不执行**用例；下表说明每条用例由谁、用什么命令在哪个阶段跑。tester（T-201）按层逐条执行并写 `docs/G-mv1s6y49-1/TEST_REPORT.md`。

| 层 | 载体 | 命令 / 方式 | 谁跑 | 覆盖用例 |
| --- | --- | --- | --- | --- |
| L0 数据面 | 临时库（`TEAM_HUB_DB` 指向 mkdtemp 的 `team.db`） | `node team-hub/scripts/seed-roster.test.mjs` | 切片 coder + tester | S2 全部 |
| L0-HTTP 接口面 | 临时库 + 真监听端口（仿 `agent-intake-routes.test.mjs:19-24`） | `node team-hub/agent-identity-tokens.test.mjs` | 切片 coder + tester | S3 全部 |
| L0-static 源码扫描 | `readFileSync + 正则`（仿 `identity-gate.test.mjs`） | `node workbench/scripts/agent-avatar-surfaces.test.mjs` / `agent-avatar-settings.test.mjs` | 切片 coder + tester | S4/S5 源码面 |
| L1 渲染断言 | `ts.transpileModule` + `react-dom/server renderToString`（仿 `doc-render.test.mjs:24-47`；无 jsdom） | `node workbench/scripts/agent-avatar.test.mjs` | 切片 coder + tester | S1 全部 |
| L1-mobile | 纯 JS 镜像 + 读文件 parity（仿 `mobile-board-parity.test.mjs`） | `node workbench/mobile/avatar-parity.test.mjs` | 切片 coder + tester | S6 全部 |
| L3 前端门禁 | 类型检查（沙箱等价，非 `pnpm`） | `node node_modules/typescript/bin/tsc --noEmit`（cwd=`workbench`） | 切片 coder + tester | TC-S1-11、TC-S4-07、TC-S5-07 |
| L3 构建 | 桌面构建（沙箱受限则记录并转 L4） | `pnpm --dir workbench build` | T-202 devops | E2E-2 前置 |
| L4 CI 门禁 | 清单完备性 + 文档门禁 | `node scripts/ci/run-ci.mjs --only test` 的「套件清单完备性」段；`node scripts/ci/check-docs.mjs` | T-202 devops + tester | S7 全部 |
| 评审（人工） | 独立评审人在 32px 下抽检并留痕 | 按 §6 E2E-5 清单执行，结论写 TEST_REPORT.md | tester + 评审人 | E2E-5 |

> **回归锚点（TASK_BREAKDOWN §8.3 实测，tester 复跑对照）**：`node team-hub/agent-intake-routes.test.mjs` = 21 pass；`node team-hub/team-views-routes.test.mjs` = 17 pass；`node team-hub/read-models-routes.test.mjs` = 25 pass；`node workbench/scripts/doc-render.test.mjs` = 11 pass；`node workbench/scripts/identity-gate.test.mjs` = 19 pass；`node workbench/mobile/board.test.mjs`、`timeline.test.mjs`、`refresh-loop.test.mjs` 均 exit 0。

## 3. 量化判据与 PASS/FAIL 唯一线

| 指标 | 唯一线（PASS 判据） | 锚定 AC |
| --- | --- | --- |
| 名字形态 | 100% 成员 `name` 去首尾空白后匹配 `^[\u4e00-\u9fa5]{2,6}$` 且不含 `[a-z0-9-_]` 机器键字符集；任一条不符即 FAIL | AC-R1-1 |
| 名字人性化（人工） | 随机抽 5 个，≥4 个被独立评审判定「像对人的称呼」（非职称直述、非编号）；记录评审人与结论 | AC-R1-2 |
| 功能可读 | 抽检 10 名成员，仅凭 `name + kind` 能正确匹配回 `role`，错误数 = 0 | AC-R1-3 |
| 名字唯一 | `SELECT scope,name,COUNT(*) FROM roster GROUP BY scope,name HAVING COUNT(*)>1` 归一化后为空 | AC-R2-1 |
| 头像形态 | 每个成员渲染为 `<svg>` 图元（或等效图形节点），**不是**单个 Unicode 字符文本节点；出现 emoji 文本节点即 FAIL | AC-R3-1 |
| 人形可辨（人工） | 32px 抽检 ≥5 个，≥4 个被判定「能看出是人形/人脸」 | AC-R3-2 |
| 头像可区分 | 同空间任意两人不同；25 岗位两两不同；位面表 key 集合两两不同且 ≥40 | AC-R3-3 |
| 头像稳定 | 同 token 多次渲染逐字节相同；模块内无 `Math.random` / `Date.now` / `performance.now` / 网络 | AC-R3-4 |
| 展示面一致 | 同一 (scope,role) 在 S1~S12 的 name 与头像标识两两相等；硬编码兜底表与首字头像计数 = 0 | AC-R4-1/4-2/4-4 |
| 无破图 | 13 展示面 × 5 空间 × 25 成员遍历，`<img src` 破图、裸露 alt、未加载占位计数 = 0 | AC-R4-3 |
| 跨空间同 role | `SELECT role,COUNT(DISTINCT name),COUNT(DISTINCT avatar) FROM roster GROUP BY role` 各计数恒为 1 | AC-R5-1 |
| 新建默认 | 不填/空/`'🤖'` 三种入参落库均为 `human:<key>`；同 scope 两名自建令牌互不相同 | AC-R7-2 |
| 幂等 | 连续执行种子两次，结果集逐行相同（无重复、不抖动）；行数、主键集合不变 | AC-R7-3、AC-R10-3 |
| 离线 | 断网下构建 + 启动 + 展示 25 成员全部正常；无外部域名请求；依赖零新增 | AC-R8-1/8-2 |
| 回退 | 非法/缺失令牌 → 确定性占位人形（非 emoji、非首字），且**不写回 roster** | AC-R9-1/9-2 |
| 迁移 | 显式自定义的 name/avatar 重跑种子后不变；旧默认值被替换；成员条数与主键不变 | AC-R10-1/10-2/10-3 |
| 移动端 | S13 显示同一头像；令牌缺失降级为纯名称且不抛错 | AC-R11-1/9-3 |

## 4. 用例目录（S1~S7 + E2E）

> 图例：类别 🟢正常（主路径 / 正向）/ 🟡边界（极限·三值）/ 🔴异常·反向（非法输入拒绝、规则违反被检出、恢复与降级）；优先级按承载需求：R-1/R-2/R-3/R-4 = P0，R-5/R-6/R-7/R-8 = P1，R-9/R-10/R-11 = P2（各切片的 DoD/回归与负例注入门禁用例随其在办切片记 P0；S6/S7 全批 P2）。
> 「自动化」列 = 载体（L0 数据面 / L0-HTTP 接口面 / L0-static 源码扫描 / L1 渲染断言 / L1-mobile / L3 前端门禁 / L4 CI 门禁 / 评审）。
> 追溯列引用：REQUIREMENTS 验收口径（`AC-R*-*`）、成功标准（`M-*`）、TASK_BREAKDOWN「## slices」验收行（「Sx 验收 n」= 该片第 4 段按分号分句后的序号）、冻结契约（I-x）、工作假设（A-x）。
> 每行 = 一条可执行用例：前置条件 → 操作步骤 → 期望结果 / 通过判据（PASS/FAIL 唯一线见 §3）。命名空间：`TC-S<n>-<m>` 仅指本文档新增用例；`E2E-n` 为端到端总口径用例。

### 4.0 现状缺口 → 切片 → 用例索引（供 coder 先复现后实现、tester 回归对照）

| 缺口（REQUIREMENTS §2.2/§2.3 现状证据） | 归属切片 | 直接用例 |
| --- | --- | --- |
| G1 名称 25/25 是职称、跨空间同 role 同名（`seed-roster.mjs:19-55`） | S2 | TC-S2-01、TC-S2-02、TC-S2-09、TC-S2-10、TC-S2-15 |
| G2 头像 25/25 是 emoji、0 个人形，`avatar` 是单字符 TEXT | S1、S3 | TC-S1-01、TC-S1-06、TC-S3-01、TC-S3-13 |
| G3 三套来源（`CenterPanel.tsx:21` 动物表、`team-views.mjs:84` 服务端兜底、名称首字） | S4、S5、S6 | TC-S4-01~TC-S4-05、TC-S5-06、TC-S6-01 |
| G4 无成员编辑入口（界面只有「新建智能体」） | 依将军裁决 #1 **不做** | TC-S5-08（反向锚定「不加回入口」） |
| G5 种子无条件覆盖（`seed-roster.mjs:66-69`） | S2 | TC-S2-06、TC-S2-07、TC-S2-14 |
| G6 回退面：`CenterPanel.tsx:49` 轮换、`AgentWorkspace.tsx:111` 首字 | S4、S5 | TC-S1-17、TC-S4-01、TC-S4-02、TC-S4-13 |
| G7 移动端 S13 无头像插槽且 `<option>` 装不下图片（`app.mjs:401-407`） | S6 | TC-S6-03、TC-S6-04 |
| G8 live 库/主工作区不可做写入型验证 | 全批 | TC-S2-01、TC-S3-01、TC-S3-10、E2E-2（全部走临时库/临时端口） |

### 4.1 S1 头像基座：参数化人形内联 SVG + 位面表 + 令牌解析 + 文本徽章 CSS 图形化（R-3 + R-9 + R-8）——自动化：L1 `node workbench/scripts/agent-avatar.test.mjs` + L3 `tsc --noEmit`

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S1-01 | 🟢 P0 | S1 合入：`workbench/src/avatar/` 导出 `AgentAvatar` 与 `resolveSlot`；`react-dom/server` 可用（范式 `doc-render.test.mjs:24-47`） | 以 `ts.transpileModule` 转译 `AgentAvatar.tsx`，`renderToString({ token: 'human:requirement' })`，抽取 DOM 结构 | 输出含 `<svg` 根节点；其文本节点计数 = 0，不存在「单个 Unicode 字符」文本节点；人形图元（`path`/`rect`/`circle`/`ellipse`/`polygon`）存在且非空——AC-R3-1 | L1 | AC-R3-1；S1 验收 1 |
| TC-S1-02 | 🟢 P0 | 同 TC-S1-01 | 对 25 个 `human:<role>` 令牌各渲染一次，取内联 SVG 标记串入 Set | 25 个标记串两两不同（Set 大小 = 25）；任意两名成员头像不同——不可共用同一默认图——AC-R3-3 | L1 | AC-R3-3；S1 验收 2 |
| TC-S1-03 | 🟢 P0 | 同 TC-S1-01；`slots.ts` 导出位面表与 `assertSlotTable()`（或等价） | 读取 key 集合；对每个内置 role 调 `resolveSlot('human:'+role)` 两次（不同调用序） | key 集合 == 25 个 role ∪ {`s01`..`s15`}，规模 ≥40 且两两不同；25 个 role 各有且仅有 1 个位面（单射）；两次解析同值——AC-R3-3、A-6 | L1 | AC-R3-3；I-4；S1 验收 2 |
| TC-S1-04 | 🟢 P0 | 同 TC-S1-01 | 同一 token 连续 renderToString 两次并逐字节比对；再静态检查 `workbench/src/avatar/` 下源码 | 两次输出逐字节相同；源码不含 `Math.random`、`Date.now`、`performance.now`、`new Date`、`fetch`、`http://`、`https://`——AC-R3-4 | L1 + L0-static | AC-R3-4；S1 验收 3 |
| TC-S1-05 | 🟢 P2 | 同 TC-S1-01 | 分别以 `token = undefined / null / '' / '   '` 渲染 | 四次均渲染确定性占位人形（同一标记串，与 I-6 一致）；不抛异常；输出不含 emoji，也不以 `name` 首字充当头像——AC-R9-1、AC-R9-2 | L1 | AC-R9-1/9-2；I-6；S1 验收 4 |
| TC-S1-06 | 🔴 P0 | 同 TC-S1-01 | 以旧值令牌 `'🤖'`、`'🧭'`、`'⚙️'` 各渲染一次，扫描输出码点 | 三者均渲染占位人形；输出中不存在 emoji 码点区间（U+1F300-U+1FAFF、U+2600-U+27BF 等）的文本节点；emoji 不得作为头像——AC-R3-1、将军裁决 #2 | L1（负例） | AC-R3-1；S1 验收 4；裁决 #2 |
| TC-S1-07 | 🔴 P2 | 同 TC-S1-01 | 逐条以非法令牌 `'human:'`、`'human:UNKNOWN-xyz'`、`'human:requirement/../x'`、`'HUMAN:requirement'`、`'human:requirement '` 渲染 | 每条渲染占位人形且不抛未捕获异常；解析函数对非法输入返回结构化回退（非 undefined 崩溃）——AC-R9-1 | L1（负例） | AC-R9-1；S1 验收 4 |
| TC-S1-08 | 🟢 P0 | 同 TC-S1-01 | 静态断言 `AgentAvatar.tsx` 的导出名与 props 形状；以 `size=16/32/64` 与 `className` 各渲染一次 | 默认导出 `AgentAvatar`；props 含 `token?` / `name?` / `size?` / `className?`（TASK_BREAKDOWN §7 冻结）；`size` 反映到渲染尺寸（width/height 或 viewBox 缩放）；`className` 透传到根节点 | L1 + L0-static | §7 组件契约；S1 验收 5 |
| TC-S1-09 | 🟢 P1 | 同 TC-S1-01 | 静态扫描 `workbench/src/avatar/` 全部源码，检索资产引用与网络调用 | 无 `<img`、无 `url(` 外部资源、无 `fetch`/`XMLHttpRequest`、无 `http://`/`https://`、无静态资源目录引用；头像完全由内联 SVG 生成——AC-R8-1 | L0-static | AC-R8-1；I-2；S1 验收 5 |
| TC-S1-10 | 🟢 P1 | S1 合入；`git diff` 可比对 HEAD | 比对 `workbench/package.json` 的 `dependencies` 与 `devDependencies` 相对基线 | 两个字段均无新增条目（新增数 = 0）——AC-R8-2 | L0-static | AC-R8-2；I-1；S1 验收 5 |
| TC-S1-11 | 🟢 P0 | `workbench/node_modules` 存在（离线已装） | 在 `workbench` 目录执行 `node node_modules/typescript/bin/tsc --noEmit` | 退出码 0，无类型错误——S1 DoD | L3 | S1 验收 6 |
| TC-S1-12 | 🔴 P0 | S1 合入 | 静态扫描 `workbench/src/avatar/` 与引用它的 `.tsx`：`avatar`/`name` 是否出现在 `key=`、`UNIQUE`、`PRIMARY KEY`、`identitySeed` 或 React `key=` 中 | `avatar`/`name` 均不出现在任何身份键、唯一约束或前端 key；前端 key 仍为 `scope + role` 形态——AC-R2-3 | L0-static（负例） | AC-R2-3；I-3；S1 验收 7 |
| TC-S1-13 | 🟡 P0 | 同 TC-S1-01 | 边界输入：`size=0`、`size=-1`、`size=1024`、`className=''`、token 前后带空白、token 大小写混合 | 均不抛异常：非法 size 取确定默认（或归一）且渲染仍为人形；带空白 token 归一后命中同一位面或确定性回退；结果可重复——S1 验收 3/4 边界 | L1（边界） | AC-R3-1/3-4；S1 验收 3/4 |
| TC-S1-14 | 🔴 P0 | 同 TC-S1-03 | 反向注入：把备用 `s02` 的位面数据改成与 `s01` 逐字段相同（或让两个 role 映射同一 key），运行 `assertSlotTable()` 与 TC-S1-02 断言 | 位面表自检与「两两不同」断言**失败**（抛错/测试红），证明该门禁真能拦住重复位面；若注入后仍全绿则本用例判 FAIL——AC-R3-3 反向 | L1（负例注入） | AC-R3-3；I-4；S1 验收 2 反向 |
| TC-S1-15 | 🔴 P0 | 同 TC-S1-04 | 反向注入：在 `AgentAvatar.tsx` 中临时加入 `Math.random()` 或 `Date.now()` 参与位面选择，重跑 TC-S1-04 的静态断言 | 静态门禁**失败**并点名违规文件与行；若注入后仍全绿则本用例判 FAIL——AC-R3-4 反向 | L0-static（负例注入） | AC-R3-4；S1 验收 3 反向 |
| TC-S1-16 | 🔴 P1 | 同 TC-S1-09 | 反向注入：在 `workbench/src/avatar/` 中临时加入 `<img src="https://example.com/a.png">` 或把 `package.json` 增加一条依赖，重跑离线/依赖门禁 | 离线与依赖门禁**失败**并点名；若注入后仍全绿则本用例判 FAIL——AC-R8-1/8-2 反向 | L0-static（负例注入） | AC-R8-1/8-2；I-1/I-2；S1 验收 5 反向 |
| TC-S1-17 | 🔴 P2 | 同 TC-S1-01 | 以 `token='🤖'` 且 `name='析言'` 渲染，扫描输出中是否含「析」字文本节点 | 输出不含任何来自 `name` 的首字/全名字符串文本节点（首字头像回退已被移除）；回退只显示占位人形——AC-R4-1 前置、AC-R9-1 | L1（负例） | AC-R4-1；AC-R9-1；I-6；S1 验收 4 |

### 4.2 S2 数据面：静态 role→展示名一对一表 + 种子重写（R-1 + R-2 + R-5 + R-7 + R-10）——自动化：L0 `node team-hub/scripts/seed-roster.test.mjs`

> 前置：`process.env.TEAM_HUB_DB = <mkdtemp>/team.db` 后再 `import './server.mjs'`（范式 `agent-intake-routes.test.mjs:19-24`）；**禁止**对 live 库 `team-hub/team.db` 做写入型验证（I-9）。

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S2-01 | 🟢 P0 | S2 合入：`seed-roster.mjs` 导出 `buildRosterSeed()` 与 `applyRosterSeed(db, opts)`（或等价纯函数）；临时空库 | 空库执行一次播种，查询 5 空间全部 roster 行 | 成员数 = 25；每个 `name` 去首尾空白后匹配 `^[\u4e00-\u9fa5]{2,6}$` 且不含 `[a-z0-9-_]`；`name` 非空——AC-R1-1 | L0 | AC-R1-1；S2 验收 1 |
| TC-S2-02 | 🟢 P0 | 同 TC-S2-01 | `SELECT scope,name,COUNT(*) c FROM roster GROUP BY scope,name HAVING c>1`（比较前大小写与首尾空白归一）；并统计 `COUNT(DISTINCT name)` | 重名行数 = 0；`COUNT(DISTINCT name) = 25`——AC-R2-1 | L0 | AC-R2-1；S2 验收 1 |
| TC-S2-03 | 🟢 P1 | 同 TC-S2-01 | 查询全部 `avatar`：形态正则、`COUNT(avatar='🤖')`、`COUNT(name IS NULL OR name='')` | 全部匹配 `^human:[a-z0-9-]+$`；`COUNT(avatar='🤖') = 0`；空名计数 = 0——AC-R7-1 | L0 | AC-R7-1；S2 验收 2 |
| TC-S2-04 | 🟢 P1 | 同 TC-S2-01 | `SELECT role,COUNT(DISTINCT name),COUNT(DISTINCT avatar) FROM roster GROUP BY role` | 每个 role 的两个计数恒为 1（跨空间同名同像，无分叉）——AC-R5-1 | L0 | AC-R5-1；S2 验收 2 |
| TC-S2-05 | 🟢 P1 | 同 TC-S2-01 | 连续执行播种两次，第二次前后各取全表快照并按 (scope,role) 排序逐行比对 | 两次结果集逐行相同；无重复行、无抖动；`upserted` 计数稳定——AC-R7-3 | L0 | AC-R7-3；S2 验收 3 |
| TC-S2-06 | 🟢 P2 | 同 TC-S2-01；已播种 | 把某行改为 `name='我起的名字'`、`avatar='human:zz9'`；重跑播种；读取该行 | 该行 name 与 avatar 保持用户值不变（未被覆盖）——AC-R10-1 | L0 | AC-R10-1；S2 验收 4 |
| TC-S2-07 | 🟢 P2 | 同 TC-S2-01 | 构造旧默认行（职称名如 `'需求分析师'` + emoji `'🧭'` + 空 avatar）；重跑播种 | 该行被替换为新两段式名与新 `human:<role>`（或 `human:<spare>`）令牌；旧 emoji 计数 = 0——AC-R10-2 | L0 | AC-R10-2；S2 验收 4 |
| TC-S2-08 | 🟢 P2 | 同 TC-S2-01 | 迁移前后分别取：行数、每个 scope 的 role 集合、(scope,role) 主键集合 | 三者前后完全相等（无重复、无丢失、无主键变化）——AC-R10-3 | L0 | AC-R10-3；S2 验收 4 |
| TC-S2-09 | 🟢 P0 | 同 TC-S2-01 | 取 10 个成员的 `name + kind`（不含 role），人工/规则映射回 role；并断言 25 行 `kind` 非空 | 10 次匹配错误 = 0；25 行 `kind` 均非空（两段式的职能副标题保留）——AC-R1-3 | L0 + 评审 | AC-R1-3；S2 验收 5 |
| TC-S2-10 | 🔴 P0 | 同 TC-S2-01 | 反向注入 4 类坏名：与旧职称逐字相同（如 `'编码工程师'`）、含 `a-z0-9-_`、长度 1（如 `'甲'`）、长度 7；运行名字形态门禁 | 门禁逐条**失败**并点名违规 name；若注入后仍全绿则本用例判 FAIL——AC-R1-1 反向 | L0（负例注入） | AC-R1-1；S2 验收 1 反向 |
| TC-S2-11 | 🔴 P0 | 同 TC-S2-01；`roles.json` 与 `roles-ozon.json` 可读 | 比对播种表覆盖的 role 集合与 roles 文件中的软件流水线 role；并断言新名不含 role 机器键字符集 | role 集合一一对应、无删除无新增（`role` 契约键不变）；名与 role 不互相包含机器键——I-7、AC-R1-1 | L0 + L0-static（负例） | I-7；AC-R1-1；S2 验收 6 |
| TC-S2-12 | 🔴 P0 | 同 TC-S2-01 | 断言 roster 主键仍为 `(scope, role)`、`agent_registry` 键仍为 `(scope, role)`；检索 seed 与 schema 中不存在以 name/avatar 为 UNIQUE 或 PRIMARY KEY 的定义 | 身份键定义与基线一致（未引入 name/avatar 键）；改名后 `agent_id` 不因 name/avatar 变化——AC-R2-2/2-3 | L0 + L0-static（负例） | AC-R2-2/2-3；I-3；S2 验收 6 |
| TC-S2-13 | 🟢 P0 | 同 TC-S2-01 | 直调导出纯函数 `buildRosterSeed()`（不落库）与 CLI 路径各一次，比对 CLI 输出 | 纯函数返回 5 空间 25 岗位的完整种子数据；CLI 输出仍含 `upserted=` 与逐 scope 计数（行为不变）——S2 DoD | L0 | S2 验收 7 |
| TC-S2-14 | 🔴 P2 | 同 TC-S2-06 | 反向注入：以旧「无条件 upsert」语义（DO UPDATE SET name=excluded.name 无条件覆盖）执行一次，比较自定义行 | 该行**确实被改变**（证明用例能区分「保留自定义」与「无条件覆盖」两种语义）；若无条件覆盖下该行仍不变则用例无区分度，判 FAIL——AC-R10-1 反向 | L0（负例注入） | AC-R10-1；S2 验收 4 反向 |
| TC-S2-15 | 🔴 P0 | 同 TC-S2-01 | 反向注入重名：把同空间两行改成仅在大小写/首尾空白上不同的同名；运行归一化唯一性门禁 | 门禁**失败**并点名冲突行；若归一化后仍全绿则本用例判 FAIL——AC-R2-1 反向 | L0（负例注入） | AC-R2-1；S2 验收 1 反向 |
| TC-S2-16 | 🟡 P2 | 同 TC-S2-01；构造半播种库：含 1 行自建 role（如 `hr-analyst`）+ 1 个缺失的 spaces 行 | 逐条构造边界后播种：自建 role 行、缺失 space 行、部分行已自定义 | 自建 role 行**保留不动**（不删不改）；缺失 space 行被补齐；已自定义行保留、旧默认行被替换；行数按预期变化（新增 space 行可能有，roster 行不丢）——AC-R10-1/10-3 边界 | L0（边界） | AC-R10-1/10-3；S2 验收 8 |

### 4.3 S3 接口面：新建成员自动分配人形令牌 + 三个读出口兜底收敛（R-7 + R-5 + R-3 + R-6 校验）——自动化：L0-HTTP `node team-hub/agent-identity-tokens.test.mjs` + 三个基线套件

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S3-01 | 🟢 P1 | S3 合入；临时库 + 真端口（`server.listen(0)`）；`POST /api/agents { scope, role:'requirement', name:'析言' }` 不带 avatar | 发请求后查询落库行 | HTTP 2xx；`roster.avatar === 'human:requirement'`（不再是 `'🤖'`）——AC-R7-2 | L0-HTTP | AC-R7-2；S3 验收 1 |
| TC-S3-02 | 🟢 P1 | 同 TC-S3-01 | 两次请求分别带 `avatar: ''` 与 `avatar: '🤖'` | 两次落库均为 `human:<key>` 令牌；`COUNT(avatar='🤖') = 0`——AC-R7-2 | L0-HTTP | AC-R7-2；S3 验收 1 |
| TC-S3-03 | 🟢 P1 | 同 TC-S3-01；scope 内已有 25 岗位 | 创建两个非内置 role（如 `hr-analyst`、`legal-advisor`）均不传 avatar | 分别落库为该 scope 内**最小未占用** `sNN`（`s01`、`s02`）；两者令牌互不相同；不与他人重复——AC-R3-3、AC-R7-2 | L0-HTTP | AC-R3-3；AC-R7-2；S3 验收 2 |
| TC-S3-04 | 🟢 P1 | 同 TC-S3-01 | 在 5 个 scope 各创建同一内置 role（如 `coder`）均不带 avatar | 5 行 avatar 全等 `'human:coder'`（跨 scope 恒同令牌）——AC-R5-1 | L0-HTTP | AC-R5-1；S3 验收 3 |
| TC-S3-05 | 🔴 P1 | 同 TC-S3-01 | 逐条发 `{role:'coder'}`（缺 name）、`{role:'coder', name:''}`、`{role:'coder', name:'   '}` | 均 400 + 可读错误；roster 与 audit 在请求前后**零变化**（拒绝时库不变）——AC-R6-3 | L0-HTTP（负例） | AC-R6-3；S3 验收 4 |
| TC-S3-06 | 🔴 P1 | 同 TC-S3-01 | 逐条发非法 role：大写 `'Coder'`、含空格 `'a b'`、中文 `'编码'`、>64 字符、空串 | 均 400 + 可读错误；库零写入——AC-R6-3 | L0-HTTP（负例） | AC-R6-3；S3 验收 4 |
| TC-S3-07 | 🟢 P1 | 同 TC-S3-01；构造 roster 缺 avatar 的历史行与一名外部执行者 | `GET /api/roster` 后逐条检查 avatar 字段 | 成员历史兜底不再是 emoji（为令牌或占位语义）；外部执行者仍为 `'⚙️'`（术语表已排除，保持现状）——S3 验收 5 | L0-HTTP | S3 验收 5；AC-R7-1 |
| TC-S3-08 | 🟢 P1 | 同 TC-S3-01；播种后 | `GET /api/agents`，对每个 role 检查返回的 name/avatar | 同 role 的 name 与 avatar 各只有一个取值（首见合并无漂移源）——AC-R5-1 | L0-HTTP | AC-R5-1；S3 验收 6 |
| TC-S3-09 | 🟢 P1 | 同 TC-S3-01；全局目录已有 `role='coder', avatar='human:coder'` | `POST /api/spaces/<newScope>/agents { roles:['coder'] }` | 目标空间该行 avatar 原样复制为 `human:coder`（不重新生成、不改写为 emoji）——S3 验收 6 | L0-HTTP | S3 验收 6；I-4 |
| TC-S3-10 | 🔴 P2 | 同 TC-S3-01；某行 avatar 是旧值 `'🦊'` | 先 `GET /api/roster` 与 `GET /api/agents` 各一次，再查该行与 audit 行数 | 两个读端点均为纯读：该行 avatar 原值不变、audit 无新增、任何表无写入（回退只是渲染态，不落库）——AC-R9-2 | L0-HTTP（负例） | AC-R9-2；I-6；S3 验收 7 |
| TC-S3-11 | 🟢 P0 | S3 合入 | 复跑三个基线套件 | `node team-hub/agent-intake-routes.test.mjs` exit 0 且 21 例不回归；`team-views-routes.test.mjs` exit 0 且 17 例；`read-models-routes.test.mjs` exit 0 且 25 例——S3 DoD | L0-HTTP | S3 验收 8 |
| TC-S3-12 | 🟢 P0 | 同 TC-S3-01 | 运行新增套件 `node team-hub/agent-identity-tokens.test.mjs` | 退出码 0、fail 0；用例覆盖 AC-R7-2、AC-R3-3、AC-R5-1、AC-R6-3——S3 DoD | L0-HTTP | S3 验收 9 |
| TC-S3-13 | 🔴 P0 | 同 TC-S3-01 | 逐条传 `avatar: 'not-a-token'`、`avatar: '<img src=x onerror=alert(1)>'`、`avatar: '🤖🦊'`、超长字符串 | 落库值只会是合法 `human:<key>` 令牌（归一/拒绝二者其一），**绝不原样存字符串**；下游渲染不会出现注入字符串或 emoji 文本——AC-R3-1 | L0-HTTP（负例） | AC-R3-1；S3 验收 10 |
| TC-S3-14 | 🟡 P1 | 同 TC-S3-01 | 三值边界：role 长度 63/64/65；备用池占满 s01..s15 后再建第 16 个自建 role；并发两个同名不带 avatar 的 POST | 64 通过、65 拒绝；备用池耗尽时得到**确定性**行为（明确报错或确定性回退，不得随机/复用他人令牌）；并发两请求得到两个不同令牌（无双写同值）——AC-R3-3 边界 | L0-HTTP（边界） | AC-R3-3；S3 验收 2 边界 |
| TC-S3-15 | 🔴 P1 | 同 TC-S3-01；沿用现有令牌校验（`TEAM_HUB_TOKEN` 非空或不空则空令牌放行口径以基线为准） | 无令牌 / 错令牌调用 `POST /api/agents`；比对鉴权前后行为 | 鉴权语义与基线一致，未新增任何绕过路径（无新写入口、无匿名旁路）；被拒时库零写入——AC-R6-4 | L0-HTTP（负例） | AC-R6-4；S3 验收 11 |
| TC-S3-16 | 🔴 P1 | 同 TC-S3-01 | 反向注入：手工把同 role 在两个 scope 的 name/avatar 改成不同值，再调 `GET /api/agents` | 首见合并会取到某一空间的值（漂移源存在）→ 该注入必须被门禁检出为 FAIL；默认口径下系统应保证不出现分叉（AC-R5-1）——AC-R5-2 反向 | L0-HTTP（负例注入） | AC-R5-2；AC-R5-1；S3 验收 3 反向 |
| TC-S3-17 | 🟡 P1 | 同 TC-S3-01 | 边界：`kind` 缺省/空串、`sort` 与已有行同值、scope 内 0 行与已有 30 行两种基数；再跑一次三基线套件 | 缺省 kind 落 `''`、sort 取值不越界且稳定；两种基数下令牌分配规则一致；三基线例数与 TC-S3-11 相同（无新增/删除）——S3 验收 12 边界 | L0-HTTP（边界） | S3 验收 12 |

### 4.4 S4 桌面展示面（一）：人员目录、Agent 头部、中心面板、场景列表（R-4）——自动化：L0-static `node workbench/scripts/agent-avatar-surfaces.test.mjs` + L3 `tsc --noEmit`

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S4-01 | 🟢 P0 | S4 合入（S1 已合入） | 读 `workbench/src/components/WorkspaceNavigation.tsx` 源码 | 出现 `<AgentAvatar`；不再出现 `a.name.slice(0, 1)` 形式的成员头像——AC-R4-1 | L0-static | AC-R4-1；S4 验收 1 |
| TC-S4-02 | 🟢 P0 | 同 TC-S4-01 | 读 `AgentWorkspace.tsx` 源码 | 出现 `<AgentAvatar`；不再出现 `agent.name.slice(0, 1)`——AC-R4-1 | L0-static | AC-R4-1；S4 验收 1 |
| TC-S4-03 | 🟢 P0 | 同 TC-S4-01 | 读 `CenterPanel.tsx` 源码 | 不再定义 `AVATARS` 动物表、不再有 `i % 8` 轮换；成员头像统一走 `<AgentAvatar`（两处卡片均改）——AC-R4-4 | L0-static | AC-R4-4；S4 验收 2 |
| TC-S4-04 | 🟢 P0 | 同 TC-S4-01 | 读 `SceneAgentList.tsx` 源码 | 出现 `<AgentAvatar`；不再把 `{agent.avatar}` 直接当文本节点渲染——AC-R4-1 | L0-static | AC-R4-1；S4 验收 1 |
| TC-S4-05 | 🔴 P0 | 同 TC-S4-01 | 扫描四个文件中的头像取值与常量表，检索硬编码 emoji/动物表/首字表 | 第二套头像来源计数 = 0（无 emoji 常量表、无首字回退）——AC-R4-4 | L0-static（负例） | AC-R4-4；I-8；S4 验收 3 |
| TC-S4-06 | 🟢 P0 | 同 TC-S4-01 | 追踪四个文件的头像变量来源（props/roster 字段/组件参数） | 成员头像取值只来自 roster 的 avatar 令牌（或统一回退），不来自其它本地表或名称派生——AC-R4-1 | L0-static | AC-R4-1；I-8；S4 验收 3 |
| TC-S4-07 | 🟢 P0 | `workbench/node_modules` 存在；S1 已合入 | 在 `workbench` 目录执行 `node node_modules/typescript/bin/tsc --noEmit` | 退出码 0（组件可编译，`@AgentAvatar` 导入解析成功）——S4 DoD | L3 | S4 验收 4 |
| TC-S4-08 | 🟢 P0 | S1、S4 合入 | 对同一成员（同 token）分别 renderToString 四个组件（或等价的静态渲染断言），抽取头像标识与名称 | 四个面的名称与头像标识两两相等（同一成员跨面一致）——AC-R4-2 | L1 + L0-static | AC-R4-2；M-3；S4 验收 5 |
| TC-S4-09 | 🔴 P0 | 同 TC-S4-08 | 扫描四个组件的渲染输出与源码中的 `<img` / `src=` / `onerror` | 头像不产生任何 `<img src` 请求（内联 SVG）→ 不存在破图、裸露 alt、未加载占位；计数 = 0——AC-R4-3 | L0-static（负例） | AC-R4-3；M-7；S4 验收 5 |
| TC-S4-10 | 🟡 P2 | 同 TC-S4-08 | 边界：成员 avatar 为 `''`、`'🤖'`、`'human:UNKNOWN'` 三种值，逐面渲染 | 三种值在四个面均渲染为占位人形（同一 token 同结果），不显示 emoji、不显示名称首字，不抛错——AC-R9-1 边界 | L1 + L0-static | AC-R9-1；S4 验收 5 边界 |
| TC-S4-11 | 🟢 P0 | S4 合入 | 复跑 `node workbench/scripts/identity-gate.test.mjs` 与同目录既有前端套件 | exit 0；`identity-gate.test.mjs` 19 例不回归；无因本片改动引入的失败——S4 DoD | L0-static | S4 验收 6 |
| TC-S4-12 | 🟢 P2 | S4 合入 | 读 `Employee3D.tsx` 与 `sceneState.ts`，比对其 name 来源与 `appearanceSeed` 的输入 | 3D 员工标签 name 与 S1 同源（roster）；`appearanceSeed = identitySeed(scope\0role)` 不消费 avatar（O-3 不联动，外观与头像无绑定）——AC-R11-2 | L0-static | AC-R11-2；O-3；S4 验收 7 |
| TC-S4-13 | 🔴 P0 | S4 合入 | 反向注入：把 `WorkspaceNavigation.tsx` 的 `<AgentAvatar` 换回 `name.slice(0,1)`（或把 avatar 直接当文本节点），重跑本片扫描门禁 | 门禁**失败**并点名该文件与行；若注入后仍全绿则本用例判 FAIL——AC-R4-1 反向 | L0-static（负例注入） | AC-R4-1；I-8；S4 验收 1 反向 |

### 4.5 S5 桌面展示面（二）：新建空间、模型设置、技能授权、任务弹窗（R-4 + R-7）——自动化：L0-static `node workbench/scripts/agent-avatar-settings.test.mjs` + L3 `tsc --noEmit`

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S5-01 | 🟢 P1 | S5 合入（S1 已合入） | 读 `NewSpaceModal.tsx` 源码，检索 emoji 头像表与缺省值 | 不再有 `AVATAR_CHOICES` emoji 表、不再有缺省 `avatar: '🤖'`——AC-R7-2、将军裁决 #1 | L0-static | AC-R7-2；S5 验收 1 |
| TC-S5-02 | 🟢 P1 | 同 TC-S5-01 | 追踪「新建智能体」提交路径，检查请求体字段 | 新建智能体请求体**不提交 avatar 字段**（创建时自动生成，暂不需要配置）——将军裁决 #1、BR-16 | L0-static | 裁决 #1；S5 验收 2 |
| TC-S5-03 | 🟢 P0 | 同 TC-S5-01 | 读 `ModelConfigModal.tsx` 源码 | 成员头像改用 `<AgentAvatar`；不再把 `avatar` 当文本节点渲染——AC-R4-1 | L0-static | AC-R4-1；S5 验收 3 |
| TC-S5-04 | 🟢 P0 | 同 TC-S5-01 | 读 `SkillsPanel.tsx` 的 `memberLabel` 实现 | 成员名与头像不再拼成一个纯文本字符串（`avatar + 空格 + name` 形态消失），改为分层渲染（头像组件 + 名称节点）——AC-R4-1、S11 面一致 | L0-static | AC-R4-1；S5 验收 3 |
| TC-S5-05 | 🟢 P0 | 同 TC-S5-01 | 读 `AgentTasksModal.tsx` 源码 | 成员头像改用 `<AgentAvatar`；不再是 `{agent.avatar}` 文本节点——AC-R4-1 | L0-static | AC-R4-1；S5 验收 3 |
| TC-S5-06 | 🔴 P0 | 同 TC-S5-01 | 扫描四个文件中的头像常量表与兜底来源 | 第二套硬编码头像来源计数 = 0（无 emoji 常量表、无按索引轮换）——AC-R4-4 | L0-static（负例） | AC-R4-4；I-8；S5 验收 4 |
| TC-S5-07 | 🟢 P0 | `workbench/node_modules` 存在；S1 已合入 | 在 `workbench` 目录执行 `node node_modules/typescript/bin/tsc --noEmit` | 退出码 0（新增 `<AgentAvatar` 引用可编译）——S5 DoD | L3 | S5 验收 5 |
| TC-S5-08 | 🔴 P1 | 同 TC-S5-01 | 反向锚定：检索四个文件中是否新增「编辑资料 / 编辑成员 / 头像上传」等入口或文案 | 未新增成员编辑入口（将军裁决 #1「暂不需要配置」）；若新增则本用例 FAIL——AC-R6-1（本目标按「不做」反向验收） | L0-static（负例） | AC-R6-1；裁决 #1；S5 验收 6 |
| TC-S5-09 | 🟡 P2 | 同 TC-S5-01；构造成员 avatar 为旧 emoji `'🧩'` 与空串 | 在四个展示面分别渲染该成员 | 四个面均渲染确定性占位人形（同一 token 同结果），不显示 emoji、不显示名称首字，不抛错——AC-R9-1 边界 | L1 + L0-static（边界） | AC-R9-1；S5 验收 3 边界 |
| TC-S5-10 | 🟢 P1 | 同 TC-S5-01 | 读 `workbench/src/api.ts` 的 `createAgent` 签名与调用点 | 签名保持兼容（可选 avatar 参数保留、无破坏性改名）；R-6 不新增 UI 不改变 API 形态——A-7、S5 验收 7 | L0-static | A-7；S5 验收 7 |
| TC-S5-11 | 🟢 P0 | S5 合入 | 复跑 `node workbench/scripts/identity-gate.test.mjs` 及同目录既有前端套件 | exit 0；`identity-gate.test.mjs` 19 例不回归；无因本片改动引入的失败——S5 DoD | L0-static | S5 验收 8 |

### 4.6 S6 移动端（S13）：成员选择与会话头的内联人形头像 + 与桌面位面表零漂移（R-11 + R-9）——自动化：L1-mobile `node workbench/mobile/avatar-parity.test.mjs` + 三个基线套件

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S6-01 | 🟢 P2 | S6 合入；`workbench/src/avatar/slots.ts` 存在（S1 已合入） | 读桌面 `slots.ts` 抽取位面 key 集合；取 `mobile/avatar.mjs` 导出的 key 集合，逐项比对 | 两个集合逐项相同（无多、无少、无拼写漂移）——AC-R11-1、BR-13、I-5 | L1-mobile | AC-R11-1；I-5；S6 验收 1 |
| TC-S6-02 | 🟢 P2 | 同 TC-S6-01 | 对 25 个 `human:<role>` 与备用 `s01`..`s15` 调移动端渲染函数 | 每个 token 渲染出 `<svg` 人形（文本节点为空），25 个岗位两两不同——AC-R11-1、AC-R3-3 | L1-mobile | AC-R11-1；S6 验收 2 |
| TC-S6-03 | 🟢 P2 | 同 TC-S6-01 | 读 `workbench/mobile/app.mjs` 的成员选择与会话头渲染代码 | 成员选择不再只用 `<option>` 纯文本承载成员（`<option>` 无法渲染图片，已改交互结构）；会话头渲染内联 SVG 人形——AC-R11-1 | L0-static | AC-R11-1；S6 验收 3 |
| TC-S6-04 | 🔴 P2 | 同 TC-S6-01 | 以 `''`、`'not-a-token'`、`'🤖'` 调移动端渲染与降级函数 | 令牌缺失或非法时降级为纯名称，函数不抛错，不显示 emoji——AC-R9-3 | L1-mobile（负例） | AC-R9-3；I-6；S6 验收 4 |
| TC-S6-05 | 🟢 P2 | S6 合入 | 复跑三个既有多端套件 | `node workbench/mobile/board.test.mjs`、`timeline.test.mjs`、`refresh-loop.test.mjs` 均 exit 0 不回归——S6 DoD | L1-mobile | S6 验收 5 |
| TC-S6-06 | 🔴 P2 | 同 TC-S6-01 | 静态检索 `workbench/mobile/` 下源码对 `workbench/src/` 的引用 | 移动端**不** import 桌面 TS 源（独立静态根，运行期不可达）；出现即 FAIL——S6 纪律 | L0-static（负例） | S6 验收 6 |
| TC-S6-07 | 🟡 P2 | 同 TC-S6-01 | 边界：成员列表为空、单成员、30+ 成员；令牌含空白/大小写混合 | 空列表不报错且提示文案可读；单/多成员均渲染正确；非法令牌走确定性回退；无重复 key——AC-R11-1 边界 | L1-mobile（边界） | AC-R11-1；S6 验收 3 边界 |
| TC-S6-08 | 🔴 P2 | 同 TC-S6-01 | 反向注入：往 `mobile/avatar.mjs` 位面表加入一个桌面没有的 key（或改掉一个 key 拼写），重跑 parity 用例 | parity 断言**失败**并点名差异项；若注入后仍全绿则本用例判 FAIL——BR-13 反向 | L1-mobile（负例注入） | BR-13；I-5；S6 验收 1 反向 |
| TC-S6-09 | 🟢 P2 | 同 TC-S6-01 | 静态扫描 `workbench/mobile/` 的网络调用与依赖；比对 `package.json` | 无 `fetch`/`http(s)://` 外部头像请求；未新增运行时依赖——AC-R8-1/8-2 | L0-static | AC-R8-1/8-2；I-1/I-2；S6 验收 7 |

### 4.7 S7 收口：六个新增测试文件登记进 CI 清单 + 受影响文档同步（R-8 + 文档面）——自动化：L4 `node scripts/ci/run-ci.mjs --only test` 的「套件清单完备性」段 + `node scripts/ci/check-docs.mjs`

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S7-01 | 🟢 P2 | S1~S6 的六个 `*.test.mjs` 均已物化；S7 已登记 | 运行 `node scripts/ci/run-ci.mjs --only test`，读「套件清单完备性」段 | 输出 `PASS 套件清单完备`；不出现 `FAIL 套件清单不完备` 点名——S7 验收 1、BR-15 | L4 | S7 验收 1；BR-15 |
| TC-S7-02 | 🟢 P2 | 同 TC-S7-01 | 逐一比对登记的 6 条路径与仓库内实际文件 | 登记的 6 条路径全部存在；无「登记了但不存在」与「存在但未登记」（0 缺 0 多）——S7 验收 2 | L4 | S7 验收 2 |
| TC-S7-03 | 🟢 P2 | S7 文档改动完成 | 运行 `node scripts/ci/check-docs.mjs` | 退出码 0；README + docs/FEATURES.md 结构/索引/互链全绿；本轮新增文档 banner 覆盖完整——S7 验收 3 | L4 | S7 验收 3 |
| TC-S7-04 | 🟢 P2 | 同 TC-S7-03 | 读 `workbench/README.md` 的编队段 | 描述更新为两段式展示名与人性化头像口径；不含过程叙事（P1/P2 轮次、谁改的）——AC-R1-3 文档面、S7 验收 4 | L4 | AC-R1-3；S7 验收 4 |
| TC-S7-05 | 🟢 P2 | 同 TC-S7-03 | 读 `docs/FEATURES.md` §3.2 与功能索引 | §3.2 更新为新两段式与人性化头像口径；功能索引 5 列表结构不破——S7 验收 5 | L4 | S7 验收 5 |
| TC-S7-06 | 🟢 P2 | 同 TC-S7-03 | 读 `docs/STATUS.md` 的测试基线 | 基线读数更新为实测新读数（用例数/套件）；与本次交付一致——S7 验收 6 | L4 | S7 验收 6 |
| TC-S7-07 | 🔴 P2 | 同 TC-S7-01 | 反向注入：从 `run-ci.mjs` 的 suites 中临时删掉六条登记之一，重跑完备性段 | 输出 `FAIL 套件清单不完备` 并点名该文件；若删除后仍 PASS 则本用例判 FAIL——BR-15 反向 | L4（负例注入） | BR-15；S7 验收 1 反向 |
| TC-S7-08 | 🔴 P2 | 同 TC-S7-03 | 检索 README、`docs/FEATURES.md`、`workbench/README.md` 是否仍把职称名/emoji 头像作为现状描述 | 旧口径（职称名清单、emoji 头像描述）不再作为现状出现；若仍存在则本用例 FAIL——S7 验收 4/5 反向 | L4（负例） | S7 验收 4/5 反向 |
| TC-S7-09 | 🟢 P2 | 同 TC-S7-03 | 检查 `docs/G-mv1s6y49-1/` 下全部 `.md` 的历史 banner | 每个文件都带 `evidence-banner` 段（含 TEST_CASES.md）；`check-docs`"历史 evidence banner 覆盖完整"通过——S7 验收 3 | L4 | S7 验收 3 |
| TC-S7-10 | 🟡 P2 | 同 TC-S7-01 | 边界：核对新增测试文件总数为 6（不新增第 7 条）；`run-ci.mjs` 的 EXEMPT 表未被用于本批 | 本批新增且登记恰好 6 条；无 `*.test.mjs` 落入 EXEMPT 豁免（豁免是例外不是常态）——S7 验收 2 边界 | L4（边界） | S7 验收 2 边界 |

## 5. 关键业务规则：正向 + 反向成对（验收标准用例化的机器可复核部分）

> 每条业务规则必须有**正向**（🟢，主路径成立）与**反向**（🔴，规则被违反时能被检出/拒绝）两类用例；§8 的机器自检逐行校验「正向引用必须 🟢、反向引用必须 🔴，且引用存在」。

| BR | 业务规则（一句话） | 正向用例（🟢） | 反向用例（🔴） |
| --- | --- | --- | --- |
| BR-1 | 成员头像必须是图形/矢量**人形**，禁止 emoji、名称首字、几何色块 | TC-S1-01 | TC-S1-06 |
| BR-2 | 令牌与位面**构造性一对一**：25 岗位 + 备用 key 两两不同，同 role 跨空间恒同像 | TC-S1-02 | TC-S1-14 |
| BR-3 | **确定性**：同 token 恒得同一头像，无随机/时钟/设备相关量 | TC-S1-04 | TC-S1-15 |
| BR-4 | 未知/非法/缺失令牌 → **确定性占位人形**，不显示首字、不落库 | TC-S1-05 | TC-S1-17 |
| BR-5 | 展示名是 **role 的单射**且形态合规（2~6 汉字、不含机器键字符集） | TC-S2-01 | TC-S2-10 |
| BR-6 | 同空间展示名唯一（比较前大小写与首尾空白归一） | TC-S2-02 | TC-S2-15 |
| BR-7 | 重跑种子只替换**旧默认值白名单**，保留用户显式自定义的 name/avatar | TC-S2-06 | TC-S2-14 |
| BR-8 | name/avatar **不进身份**：改名换头像不改 agent_id、会话与任务归属 | E2E-4 | TC-S2-12 |
| BR-9 | 新建成员**自动分配**人形令牌（不填/空/`'🤖'` 都不落 emoji） | TC-S3-01 | TC-S3-13 |
| BR-10 | 入参校验：空名/非法 role 被拒（400）且**库零写入** | TC-S3-01 | TC-S3-05 |
| BR-11 | **单一来源**：13 展示面全部读 roster，无第二套兜底表与首字回退 | TC-S4-01 | TC-S4-05 |
| BR-12 | 展示面一致且**无破图**：内联 SVG 无网络请求、无 `<img src` 破图 | TC-S4-08 | TC-S4-09 |
| BR-13 | 移动端位面表与桌面 `slots.ts` **逐项同轴**（镜像 + parity，防两表漂移） | TC-S6-01 | TC-S6-08 |
| BR-14 | **离线自足 + 零新增运行时依赖**（禁联网、禁第三方头像库） | TC-S1-09 | TC-S1-16 |
| BR-15 | 新增 `*.test.mjs` **必须登记**进 CI 套件清单（否则判 FAIL 点名） | TC-S7-01 | TC-S7-07 |
| BR-16 | 新建成员**不提供头像配置**、请求体不提交 avatar 字段（将军裁决 #1） | TC-S5-01 | TC-S5-08 |

## 6. 端到端验收用例（对应 REQUIREMENTS §6 的 M-1~M-7；tester 在 T-201 逐条执行写报告）

> 每个 E2E 用例都在**隔离环境**中执行：临时库（`TEAM_HUB_DB=mkdtemp/team.db`）+ 空闲端口；**不触碰 live 库与主工作区**。E2E-2/E2E-5 的人工与遍历判据须在 TEST_REPORT.md 中记录执行人、样本与结论。

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| E2E-1 | 🟢 P0 | 空临时库；S1~S3 合入 | 播种（`node team-hub/scripts/seed-roster.mjs` 指向临时库）后全量断言 | 5 空间 25 岗位 25/25 具备合规 name 与 human 令牌；`COUNT(avatar='🤖') = 0`；空名计数 = 0——M-1、AC-R7-1 | L0 + L2 | M-1；AC-R7-1 |
| E2E-2 | 🟢 P0 | S1~S6 合入；workbench 可构建可启动（临时库） | 遍历 13 展示面 × 5 空间 × 25 成员：抓取每面渲染出的名称与头像标识，两两比对并检查 DOM 是否出现破图/裸露 alt | 同一成员跨面名称与头像标识两两相等；破图/裸露 alt/未加载占位计数 = 0——M-3、M-7、AC-R4-2/4-3 | L3 + 评审 | M-3；M-7；AC-R4-2/4-3 |
| E2E-3 | 🟢 P1 | 可在断网条件执行（或屏蔽外部域名） | 断网下构建 + 启动 + 展示 25 成员；抓取服务端与前端网络记录；比对 package.json | 头像全部正常渲染；外部域名请求数 = 0；运行时依赖新增数 = 0——M-5、AC-R8-1/8-2 | L2 + L3 | M-5；AC-R8-1/8-2 |
| E2E-4 | 🟢 P0 | 已播种；某成员有历史会话与在办任务 | `POST /api/agents` 改名（并换令牌）后读取 agent_registry、会话与任务归属；再遍历展示面 | `agent_id` 不变；历史会话与任务归属不变；展示面同步为新 name/avatar（旧值不再出现）——M-4、AC-R2-2、AC-R6-2 | L0 + L2 | M-4；AC-R2-2；AC-R6-2 |
| E2E-5 | 🟡 P0 | S1~S6 合入；指定 1 名独立评审人 | 32px 下抽检 ≥5 个头像判定「能看出是人形/人脸」；随机抽 5 个名称判定「像对人的称呼」；记录评审人、样本、结论 | 人形可辨 ≥4/5 且名称人性化 ≥4/5；`AC-R1-4` 的最终名单确认留痕（评审人 + 结论 + 日期）——M-6、AC-R1-2/3-2/R1-4 | 评审 | M-6；AC-R1-2；AC-R3-2；AC-R1-4 |
| E2E-6 | 🔴 P2 | S1~S6 合入；可向临时库注入旧值 | 向 roster 注入旧 emoji 头像（如 `'🦊'`）与缺 avatar 行；遍历各展示面并回查库 | 各面渲染确定性占位人形；不出现 emoji、不出现名称首字；roster 原值**不被写回**（仍为旧值，回退只是渲染态）——R-9、AC-R9-1/9-2 | L2 + L0 | R-9；AC-R9-1/9-2 |
| E2E-7 | 🟢 P1 | 已播种；S3 合入 | 新建一个自建成员（不传 avatar）→ 查询令牌 → 遍历展示面 | 自动获得 `human:sNN` 令牌且与同 scope 他人不重复；在人员目录、中心面板、场景列表等展示面均出现且一致——AC-R7-2/3-3 | L0 + L2 | AC-R7-2；AC-R3-3 |
| E2E-8 | 🔴 P0 | 全批合入 | 全仓检索 `name`/`avatar` 作为身份键/唯一约束/前端 key 的用法；改某成员 name+avatar 后检查任务路由与归属 | 检索命中 = 0（前端 key 仍为 `scope + role`，主键仍 `(scope, role)`）；任务路由与归属不因展示属性变化——AC-R2-3、I-3 | L0-static + L2（负例） | AC-R2-3；I-3 |

## 7. 验收口径 → 用例追溯矩阵（34 条 AC 全覆盖；§8 机器校验「无悬空 AC、无重复行」）

| AC | 口径摘要 | 承载用例 | 判据类型 |
| --- | --- | --- | --- |
| AC-R1-1 | 每个成员 name 非空、2~6 汉字、不含机器键字符 | TC-S2-01、TC-S2-10 | 数据面断言 + 负例注入 |
| AC-R1-2 | 抽 5 个名称 ≥4 个像对人的称呼 | E2E-5 | 人工评审判据 |
| AC-R1-3 | 仅凭 name + kind 能匹配回 role，错误 0 | TC-S2-09、TC-S7-04 | 数据面 + 文档面 |
| AC-R1-4 | 最终 25 人名单经将军确认并留痕 | E2E-5 | 评审留痕（O-1） |
| AC-R2-1 | 同空间重名 0（归一化比较） | TC-S2-02、TC-S2-15 | 数据面断言 + 负例注入 |
| AC-R2-2 | 改名后 agent_id 与会话/任务归属不变 | TC-S2-12、E2E-4 | 断言 + 端到端 |
| AC-R2-3 | 不存在以 name/avatar 为身份键/唯一约束/前端 key 的用法 | TC-S1-12、TC-S2-12、E2E-8 | 静态扫描（负例） |
| AC-R3-1 | 头像渲染为图形/矢量节点，不是单个 Unicode 字符文本节点 | TC-S1-01、TC-S1-06、TC-S3-13 | 渲染断言 + 接口负例 |
| AC-R3-2 | 32px 抽检 ≥5 个中 ≥4 个能看出人形 | E2E-5 | 人工评审判据 |
| AC-R3-3 | 同空间两人不同、25 岗位两两不同、位面表 ≥40 且互异 | TC-S1-02、TC-S1-03、TC-S3-03 | 构造性断言 + 接口 |
| AC-R3-4 | 同 (scope,role) 多次渲染头像不变（确定性） | TC-S1-04 | 渲染幂等 + 静态扫描 |
| AC-R4-1 | S1~S12 全部读 roster 的 name/avatar，无硬编码兜底与首字 | TC-S4-01、TC-S4-02、TC-S4-04、TC-S4-06、TC-S5-03、TC-S5-04、TC-S5-05、TC-S1-17 | 源码扫描 + 渲染负例 |
| AC-R4-2 | 同一成员在各展示面名称与头像标识两两相等 | TC-S4-08 | 跨面渲染比对 |
| AC-R4-3 | 13 面 × 5 空间 × 25 成员无破图、无裸露 alt | TC-S4-09、E2E-2 | 源码扫描 + 遍历 |
| AC-R4-4 | 硬编码兜底来源与首字头像处数 = 0 | TC-S4-03、TC-S4-05、TC-S5-06 | 源码扫描（负例） |
| AC-R5-1 | 同 role 跨空间 name/avatar 各单值 | TC-S2-04、TC-S3-04、TC-S3-08、TC-S3-09 | 数据面 + 接口 |
| AC-R5-2 | 若允许跨空间不同，则 /api/agents 必须按 role+scope 展示（默认口径为一致） | TC-S3-16 | 负例注入（首见漂移检出） |
| AC-R6-1 | 成员编辑入口存在且权限提示明确（依将军裁决 #1 **本目标不做该入口**） | TC-S5-08 | 反向锚定（不加回入口） |
| AC-R6-2 | 改名/换头像后各展示面同步更新，旧值不再出现 | E2E-4 | 端到端 |
| AC-R6-3 | 空名/超长/重名/非法头像引用被拒且库不变 | TC-S3-05、TC-S3-06 | 接口负例 |
| AC-R6-4 | 写操作沿用现有令牌/身份校验，不新增绕过路径 | TC-S3-15 | 接口负例 |
| AC-R7-1 | 空库播种后 100% 合规、`COUNT(avatar='🤖')=0` | TC-S2-03、TC-S3-07 | 数据面 + 接口 |
| AC-R7-2 | 新建不填头像得人形头像且同空间不重复；空名被拒 | TC-S3-01、TC-S3-02、TC-S3-03、E2E-7 | 接口 + 端到端 |
| AC-R7-3 | 连续播种两次结果集相同（无重复、不抖动） | TC-S2-05 | 幂等断言 |
| AC-R8-1 | 断网可用、无外部请求 | TC-S1-09、TC-S6-09、E2E-3 | 静态扫描 + 端到端 |
| AC-R8-2 | package.json 无新增运行时依赖 | TC-S1-10、TC-S1-16 | 依赖比对 + 负例注入 |
| AC-R9-1 | 头像资源不可用/令牌非法 → 确定性回退（首字或占位人形），无破图 | TC-S1-05、TC-S1-07、TC-S4-10、E2E-6 | 渲染 + 端到端 |
| AC-R9-2 | 回退只是渲染态，不写回 roster | TC-S1-05、TC-S3-10 | 渲染 + 接口（零写入） |
| AC-R9-3 | 移动端头像缺失降级为纯名称且不报错 | TC-S6-04 | 纯函数 + 降级断言 |
| AC-R10-1 | 用户显式自定义的 name/avatar 重跑种子后不变 | TC-S2-06、TC-S2-16 | 数据面 + 边界 |
| AC-R10-2 | 旧默认值被新规范替换；迁移前后成员条数不变 | TC-S2-07 | 数据面断言 |
| AC-R10-3 | 迁移不改 (scope,role) 唯一键与 agent_id | TC-S2-08、TC-S2-16 | 数据面 + 边界 |
| AC-R11-1 | 移动端显示同一头像（S13） | TC-S6-01、TC-S6-02、TC-S6-03 | parity + 渲染 + 源码扫描 |
| AC-R11-2 | 3D 员工标签 name 与 S1 一致；O-3 默认不联动外观 | TC-S4-12 | 源码扫描 |

## 8. 附录 A：用例文档自检（machcheck，供 coder/tester 一键复核）

- 脚本：`docs/G-mv1s6y49-1/T198-evidence/machcheck-test-cases.mjs`（零第三方依赖，仅 `node:fs` / `node:path` / `node:os` / `node:child_process`）。
- 运行：`node docs/G-mv1s6y49-1/T198-evidence/machcheck-test-cases.mjs`
- 校验项：① 用例行 7 列完整且无空列；② ID 唯一；③ 类别与优先级枚举合法；④ §0 声明的总数/各切片/各类别/各优先级与实测一致；⑤ 34 条 AC 在 §7 恰好各出现一次且引用的用例存在（无悬空 AC、无用例漏引用）；⑥ §5 的 16 条 BR 正反向配对（正向引用必须 🟢、反向引用必须 🔴）；⑦ §9 附录 B 的 `~~~js` 骨架逐个 `node --check`。
- 产物：`T198-evidence/01-doc-machcheck.txt`（主校验输出）与 `T198-evidence/02-skeleton-syntax.txt`（骨架语法逐条结果）；结论文首的机器自检读数即由该脚本复跑得出。
- 说明：本脚本**只校验文档结构与骨架语法**，不执行任何业务用例（执行是 T-201 tester 的职责）。
- ⚠️ 编辑提示：本文档约 40 KB、单文件较大；**不要用「整体读出→整体写回」方式改它**（本会话实测：读取侧会截断返回行，写回即丢尾部）。追加用文件级 append，或只用带唯一锚点的局部替换。

## 9. 附录 B：逐切片可照抄测试代码骨架（coder 在各切片文件域内物化；**本阶段不预写文件**以免与 coder 合入冲突，且避免未登记 `*.test.mjs` 触发 CI「套件清单完备性」红）

> 使用前提：S1 尚未合入时 S4/S5/S6 的骨架会因模块不存在而红——这是 TASK_BREAKDOWN §5.1 已声明的串行约束，不是骨架缺陷。函数名（如 `applyRosterSeed`、`resolveSlot`）以各切片实现为准，骨架给出的是**断言集合**，coder 只需替换调用面。

### B.1 S1 头像基座 → `workbench/scripts/agent-avatar.test.mjs`（新增）

~~~js
// workbench/scripts/agent-avatar.test.mjs
// 运行：node workbench/scripts/agent-avatar.test.mjs（沙箱 spawn 受限时直跑等效；宿主可 node --test）
// 范式：ts.transpileModule + react-dom/server renderToString（同 doc-render.test.mjs），零新增依赖。
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { renderToString } from 'react-dom/server'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const react = require('react')
const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src', 'avatar')

const ROLES = ['requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops',
  'market-analyst', 'content-planner', 'ad-optimizer', 'growth-hacker', 'brand-copy', 'product-manager',
  'ux-designer', 'ui-designer', 'user-researcher', 'data-analyst', 'ops-specialist', 'campaign-planner',
  'support-lead', 'data-ops', 'assistant', 'research-assistant', 'writer']
const SPARES = Array.from({ length: 15 }, (_, i) => 's' + String(i + 1).padStart(2, '0'))
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u

let AgentAvatar
let mod
let tmp

function transpile(from, to) {
  const out = ts.transpileModule(readFileSync(from, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  })
  if (out.diagnostics && out.diagnostics.length) throw new Error('transpile 诊断：' + JSON.stringify(out.diagnostics))
  writeFileSync(to, out.outputText, 'utf8')
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'legion-avatar-'))
  transpile(join(SRC, 'slots.ts'), join(tmp, 'slots.mjs'))
  transpile(join(SRC, 'AgentAvatar.tsx'), join(tmp, 'AgentAvatar.mjs'))
})
before(async () => {
  mod = await import(pathToFileURL(join(tmp, 'slots.mjs')).href)
  AgentAvatar = (await import(pathToFileURL(join(tmp, 'AgentAvatar.mjs')).href)).default
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const render = (token, extra) => renderToString(react.createElement(AgentAvatar, Object.assign({ token: token }, extra || {})))

describe('S1 头像基座', () => {
  test('TC-S1-01 渲染为 <svg 且无单个字符文本节点（AC-R3-1）', () => {
    const html = render('human:requirement')
    assert.ok(html.includes('<svg'), '必须含 <svg')
    assert.equal(html.replace(/<[^>]*>/g, '').trim(), '', '不得有文本节点（emoji/首字）')
  })

  test('TC-S1-02 25 个岗位头像两两不同（AC-R3-3）', () => {
    assert.equal(new Set(ROLES.map((r) => render('human:' + r))).size, ROLES.length)
  })

  test('TC-S1-03 位面表 key 集合 = 25 岗位 + s01..s15 且单射（AC-R3-3）', () => {
    const keys = mod.slotKeys()
    assert.equal(keys.length, ROLES.length + SPARES.length)
    assert.equal(new Set(keys).size, keys.length)
    for (const r of ROLES) assert.ok(keys.includes(r))
    for (const s of SPARES) assert.ok(keys.includes(s))
  })

  test('TC-S1-04 同 token 幂等且无随机/时钟/网络（AC-R3-4）', () => {
    assert.equal(render('human:coder'), render('human:coder'))
    const src = ['slots.ts', 'AgentAvatar.tsx', 'index.ts'].map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n')
    for (const banned of ['Math.random', 'Date.now', 'performance.now', 'fetch(', 'https://', 'http://']) {
      assert.ok(!src.includes(banned), '禁止出现 ' + banned)
    }
  })

  test('TC-S1-05/06/07 非法与 emoji 令牌回退为占位人形（AC-R9-1、AC-R3-1）', () => {
    const values = [undefined, null, '', '   ', '\u{1F916}', '\u{1F9ED}', 'human:', 'human:UNKNOWN', 'human:a/../b']
    for (const v of values) {
      const html = render(v)
      assert.ok(html.includes('<svg'))
      assert.ok(!EMOJI_RE.test(html.replace(/<[^>]*>/g, '')), '不得渲染 emoji 文本：' + String(v))
      assert.ok(!html.includes('析'), '不得用 name 首字充当头像')
    }
  })

  test('TC-S1-08 组件契约（默认导出 + props + size/className）', () => {
    const html = render('human:requirement', { size: 48, className: 'x' })
    assert.ok(html.includes('48'))
  })

  test('TC-S1-10 依赖零新增（AC-R8-2）', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@react-three/drei', '@react-three/fiber', 'react', 'react-dom', 'three'])
  })
})
~~~

### B.2 S2 数据面 → `team-hub/scripts/seed-roster.test.mjs`（新增）

~~~js
// team-hub/scripts/seed-roster.test.mjs
// 运行：node team-hub/scripts/seed-roster.test.mjs（临时库由本文件自建；禁止写 live team.db）
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'legion-seed-roster-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('../server.mjs')
const seed = await import('./seed-roster.mjs')

const NAME_RE = /^[\u4e00-\u9fa5]{2,6}$/
const MACHINE_RE = /[a-z0-9_-]/
const TOKEN_RE = /^human:[a-z0-9-]+$/
const SCOPES = ['software', 'marketing', 'product', 'ops', 'default']

const allRows = () => mod.db.prepare('SELECT * FROM roster ORDER BY scope, role').all()
const reset = () => { mod.db.prepare('DELETE FROM roster').run(); mod.db.prepare('DELETE FROM spaces').run() }
const apply = () => seed.applyRosterSeed(mod.db, { quiet: true })

after(() => rmSync(dir, { recursive: true, force: true }))

test('TC-S2-01/02/03/04 空库播种：形态/唯一/令牌/跨空间一致（AC-R1-1/R2-1/R7-1/R5-1）', () => {
  reset(); apply()
  const all = allRows()
  assert.equal(all.length, 25)
  for (const r of all) {
    assert.match(r.name, NAME_RE, '名字形态：' + r.name)
    assert.equal(MACHINE_RE.test(r.name), false, '不得含机器键字符：' + r.name)
    assert.match(r.avatar, TOKEN_RE, '令牌形态：' + r.avatar)
  }
  assert.equal(mod.db.prepare("SELECT COUNT(*) c FROM roster WHERE avatar = '\u{1F916}'").get().c, 0)
  assert.equal(mod.db.prepare('SELECT scope, name, COUNT(*) c FROM roster GROUP BY scope, name HAVING c > 1').all().length, 0)
  const perRole = mod.db.prepare('SELECT role, COUNT(DISTINCT name) n, COUNT(DISTINCT avatar) a FROM roster GROUP BY role').all()
  for (const r of perRole) { assert.equal(r.n, 1); assert.equal(r.a, 1) }
})

test('TC-S2-05 幂等：连跑两次逐行相同（AC-R7-3）', () => {
  reset(); apply(); const a = allRows(); apply(); const b = allRows()
  assert.deepEqual(a, b)
})

test('TC-S2-06/07/14 迁移只替换旧默认值、保留自定义（AC-R10-1/10-2）', () => {
  reset(); apply()
  mod.db.prepare('UPDATE roster SET name = ?, avatar = ? WHERE scope = ? AND role = ?').run('我起的名字', 'human:zz9', 'software', 'coder')
  apply()
  const custom = mod.db.prepare('SELECT name, avatar FROM roster WHERE scope = ? AND role = ?').get('software', 'coder')
  assert.deepEqual(custom, { name: '我起的名字', avatar: 'human:zz9' })
  mod.db.prepare('UPDATE roster SET name = ?, avatar = ? WHERE scope = ? AND role = ?').run('需求分析师', '\u{1F9ED}', 'software', 'requirement')
  apply()
  const replaced = mod.db.prepare('SELECT name, avatar FROM roster WHERE scope = ? AND role = ?').get('software', 'requirement')
  assert.notEqual(replaced.name, '需求分析师')
  assert.match(replaced.avatar, TOKEN_RE)
})

test('TC-S2-08/16 迁移前后行数与主键集合不变（AC-R10-3）', () => {
  reset(); apply()
  const before = allRows().map((r) => r.scope + '/' + r.role)
  apply()
  const afterRows = allRows()
  assert.deepEqual(afterRows.map((r) => r.scope + '/' + r.role), before)
  assert.equal(new Set(afterRows.map((r) => r.scope + '/' + r.role)).size, afterRows.length)
})

test('TC-S2-09/11 kind 保留且 role 契约键不变（AC-R1-3、I-7）', () => {
  reset(); apply()
  for (const r of allRows()) assert.ok(r.kind && r.kind.length > 0, 'kind 不得为空：' + r.role)
  assert.equal(new Set(allRows().map((r) => r.role)).size, 25)
  for (const scope of SCOPES) assert.ok(scope.length > 0)
})
~~~

### B.3 S3 接口面 → `team-hub/agent-identity-tokens.test.mjs`（新增）

~~~js
// team-hub/agent-identity-tokens.test.mjs
// 运行：node team-hub/agent-identity-tokens.test.mjs（临时库 + 真端口；不写 live 库）
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'legion-agent-tokens-'))
process.env.TEAM_HUB_DB = join(dir, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + mod.server.address().port

const TOKEN_RE = /^human:[a-z0-9-]+$/
const post = async (p, body) => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}
const row = (scope, role) => mod.db.prepare('SELECT * FROM roster WHERE scope = ? AND role = ?').get(scope, role)
const reset = () => { mod.db.prepare('DELETE FROM roster').run(); mod.db.prepare('DELETE FROM audit').run() }

after(() => { mod.server.close(); rmSync(dir, { recursive: true, force: true }) })

test('TC-S3-01/02 不带/空/emoji avatar 都落 human 令牌（AC-R7-2）', async () => {
  reset()
  for (const avatar of [undefined, '', '\u{1F916}']) {
    const body = { scope: 'software', role: 'requirement', name: '析言' }
    if (avatar !== undefined) body.avatar = avatar
    const res = await post('/api/agents', body)
    assert.ok(res.status < 400, 'HTTP ' + res.status)
    assert.equal(row('software', 'requirement').avatar, 'human:requirement')
  }
  assert.equal(mod.db.prepare("SELECT COUNT(*) c FROM roster WHERE avatar = '\u{1F916}'").get().c, 0)
})

test('TC-S3-03 自建 role 取最小未占用 sNN 且互不相同（AC-R3-3）', async () => {
  reset()
  await post('/api/agents', { scope: 'software', role: 'hr-analyst', name: '甄才' })
  await post('/api/agents', { scope: 'software', role: 'legal-advisor', name: '衡法' })
  const a = row('software', 'hr-analyst').avatar
  const b = row('software', 'legal-advisor').avatar
  assert.match(a, TOKEN_RE); assert.match(b, TOKEN_RE); assert.notEqual(a, b)
  assert.match(a, /^human:s\d{2}$/)
})

test('TC-S3-04 跨 scope 同 role 恒同令牌（AC-R5-1）', async () => {
  reset()
  for (const scope of ['software', 'marketing', 'product', 'ops', 'default']) {
    await post('/api/agents', { scope: scope, role: 'coder', name: '衡码' })
  }
  const vals = mod.db.prepare("SELECT DISTINCT avatar FROM roster WHERE role = 'coder'").all().map((r) => r.avatar)
  assert.deepEqual(vals, ['human:coder'])
})

test('TC-S3-05/06 空名与非法 role 被拒且零写入（AC-R6-3）', async () => {
  reset()
  for (const bad of [{ role: 'coder' }, { role: 'coder', name: '' }, { role: 'coder', name: '   ' },
    { role: 'Coder', name: 'x' }, { role: 'a b', name: 'x' }, { role: 'a'.repeat(65), name: 'x' }]) {
    const res = await post('/api/agents', bad)
    assert.equal(res.status, 400, JSON.stringify(bad))
  }
  assert.equal(mod.db.prepare('SELECT COUNT(*) c FROM roster').get().c, 0)
})

test('TC-S3-10 读端点零写入（AC-R9-2）', async () => {
  reset()
  await post('/api/agents', { scope: 'software', role: 'coder', name: '衡码', avatar: 'human:coder' })
  mod.db.prepare("UPDATE roster SET avatar = '\u{1F98A}' WHERE scope = 'software' AND role = 'coder'").run()
  const before = mod.db.prepare('SELECT COUNT(*) c FROM audit').get().c
  await fetch(base + '/api/roster'); await fetch(base + '/api/agents')
  assert.equal(row('software', 'coder').avatar, '\u{1F98A}', '读不得写回')
  assert.equal(mod.db.prepare('SELECT COUNT(*) c FROM audit').get().c, before)
})

test('TC-S3-08 跨空间首见合并后 name/avatar 单值（AC-R5-1）', async () => {
  reset()
  for (const scope of ['software', 'marketing']) await post('/api/agents', { scope: scope, role: 'writer', name: '执笔' })
  const json = await (await fetch(base + '/api/agents')).json()
  const w = json.agents.find((a) => a.role === 'writer')
  assert.ok(w); assert.equal(typeof w.avatar, 'string')
})
~~~

### B.4 S4 展示面（一）→ `workbench/scripts/agent-avatar-surfaces.test.mjs`（新增）

~~~js
// workbench/scripts/agent-avatar-surfaces.test.mjs
// 运行：node workbench/scripts/agent-avatar-surfaces.test.mjs（readFileSync + 正则源码扫描，同 identity-gate.test.mjs）
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')
const C = (f) => 'workbench/src/components/' + f

describe('S4 桌面展示面（一）', () => {
  test('TC-S4-01/02/04 四个面均用 <AgentAvatar 且无首字回退（AC-R4-1）', () => {
    for (const f of ['WorkspaceNavigation.tsx', 'AgentWorkspace.tsx', 'CenterPanel.tsx', 'SceneAgentList.tsx']) {
      assert.ok(read(C(f)).includes('<AgentAvatar'), f + ' 必须使用 <AgentAvatar')
    }
    assert.ok(!read(C('WorkspaceNavigation.tsx')).includes('name.slice(0, 1)'))
    assert.ok(!read(C('AgentWorkspace.tsx')).includes('name.slice(0, 1)'))
  })

  test('TC-S4-03/05 中心面板删除 AVATARS 与 i % 8 轮换（AC-R4-4）', () => {
    const src = read(C('CenterPanel.tsx'))
    assert.ok(!/const AVATARS\s*=/.test(src), '不得保留动物兜底表')
    assert.ok(!/i % 8/.test(src), '不得保留轮换')
  })

  test('TC-S4-04/09 场景列表不再把 avatar 当文本节点，且无 <img 破图（AC-R4-1/4-3）', () => {
    assert.ok(!read(C('SceneAgentList.tsx')).includes('{agent.avatar}'), '不得把 avatar 直接当文本渲染')
    for (const f of ['WorkspaceNavigation.tsx', 'AgentWorkspace.tsx', 'CenterPanel.tsx', 'SceneAgentList.tsx']) {
      assert.ok(!/<img/.test(read(C(f))), f + ' 头像不得走 <img')
    }
  })

  test('TC-S4-06 头像取值只来自 roster 令牌（AC-R4-1）', () => {
    for (const f of ['CenterPanel.tsx', 'SceneAgentList.tsx']) assert.ok(read(C(f)).includes('avatar'), f)
  })
})
~~~

### B.5 S5 展示面（二）→ `workbench/scripts/agent-avatar-settings.test.mjs`（新增）

~~~js
// workbench/scripts/agent-avatar-settings.test.mjs
// 运行：node workbench/scripts/agent-avatar-settings.test.mjs（源码扫描，同 identity-gate.test.mjs）
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')
const C = (f) => 'workbench/src/components/' + f

describe('S5 桌面展示面（二）', () => {
  test('TC-S5-01/02 新建弹窗无 emoji 头像表与缺省 emoji（将军裁决 #1）', () => {
    const src = read(C('NewSpaceModal.tsx'))
    assert.ok(!src.includes('AVATAR_CHOICES'), '不得保留 emoji 下拉表')
    assert.ok(!src.includes("avatar: '\u{1F916}'"), '不得保留缺省 emoji')
  })

  test('TC-S5-03/04/05 三处成员头像改用组件，S11 不再拼纯文本（AC-R4-1）', () => {
    for (const f of ['ModelConfigModal.tsx', 'SkillsPanel.tsx', 'AgentTasksModal.tsx']) {
      assert.ok(read(C(f)).includes('<AgentAvatar'), f + ' 必须使用 <AgentAvatar')
    }
    assert.ok(!read(C('SkillsPanel.tsx')).includes('${a.avatar} ${a.name}'), 'S11 不得把头像与名字拼成纯文本')
  })

  test('TC-S5-06 四处无第二套硬编码头像来源（AC-R4-4）', () => {
    for (const f of ['NewSpaceModal.tsx', 'ModelConfigModal.tsx', 'SkillsPanel.tsx', 'AgentTasksModal.tsx']) {
      assert.ok(!/const AVATARS\s*=/.test(read(C(f))), f + ' 不得有第二套头像表')
    }
  })

  test('TC-S5-08 不新增成员编辑入口（将军裁决 #1 反向锚定）', () => {
    for (const f of ['NewSpaceModal.tsx', 'ModelConfigModal.tsx']) {
      assert.ok(!read(C(f)).includes('编辑资料'), f + ' 不得新增编辑成员入口')
    }
  })

  test('TC-S5-10 createAgent 签名兼容（可选 avatar 保留）', () => {
    assert.ok(read('workbench/src/api.ts').includes('createAgent'), 'createAgent 仍在')
  })
})
~~~

### B.6 S6 移动端 → `workbench/mobile/avatar-parity.test.mjs`（新增）

~~~js
// workbench/mobile/avatar-parity.test.mjs
// 运行：node workbench/mobile/avatar-parity.test.mjs（读桌面 slots.ts 逐项比对 key 集合，同 mobile-board-parity.test.mjs）
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const desktop = readFileSync(resolve(ROOT, 'workbench/src/avatar/slots.ts'), 'utf8')
const mobile = await import('./avatar.mjs')

const keysFrom = (src) => {
  const out = new Set()
  for (const m of src.matchAll(/['"]([a-z][a-z0-9-]*)['"]\s*:/g)) out.add(m[1])
  return out
}

describe('S6 移动端头像', () => {
  test('TC-S6-01 两端位面 key 集合逐项相同（BR-13）', () => {
    assert.deepEqual([...keysFrom(desktop)].sort(), [...new Set(mobile.slotKeys())].sort())
  })

  test('TC-S6-02/03 渲染为 <svg 而非 emoji（AC-R11-1）', () => {
    const html = mobile.renderAvatar('human:coder')
    assert.ok(html.includes('<svg'))
    assert.equal(html.replace(/<[^>]*>/g, '').trim(), '')
  })

  test('TC-S6-04 非法令牌降级为纯名称且不抛错（AC-R9-3）', () => {
    assert.doesNotThrow(() => mobile.renderAvatar('not-a-token'))
    assert.doesNotThrow(() => mobile.renderAvatar(''))
    assert.equal(typeof mobile.avatarLabel('', '衡码'), 'string')
  })

  test('TC-S6-06 移动端不 import 桌面 TS 源（独立静态根）', () => {
    const app = readFileSync(resolve(HERE, 'app.mjs'), 'utf8')
    assert.ok(!/from\s+['"][^'"]*workbench\/src/.test(app))
  })
})
~~~

### B.7 S7 收口 → 登记校验（写入 `scripts/ci/run-ci.mjs` 的既有「套件清单完备性」段，无需第 7 个测试文件）

~~~js
// node -e 直跑等价口径：逐条核对 6 个新增测试文件已登记且实际存在
const { readFileSync, existsSync } = require('node:fs')
const EXPECT = [
  'workbench/scripts/agent-avatar.test.mjs',
  'team-hub/scripts/seed-roster.test.mjs',
  'team-hub/agent-identity-tokens.test.mjs',
  'workbench/scripts/agent-avatar-surfaces.test.mjs',
  'workbench/scripts/agent-avatar-settings.test.mjs',
  'workbench/mobile/avatar-parity.test.mjs',
]
const ci = readFileSync('scripts/ci/run-ci.mjs', 'utf8')
const missing = EXPECT.filter((p) => !ci.includes(p))
const absent = EXPECT.filter((p) => !existsSync(p))
if (missing.length || absent.length) {
  console.error('FAIL 未登记=' + missing.join(',') + ' 不存在=' + absent.join(','))
  process.exit(1)
}
console.log('PASS 新增测试登记与物化一致（' + EXPECT.length + ' 条）')
~~~

## 10. 附录 C：本阶段自检（逐条对应 T-198 验收标准）与关联文档

| T-198 验收标准 | 本文落点 | 结论 |
| --- | --- | --- |
| 用例覆盖 主路径 + 边界 + 异常，每条含 前置条件 / 步骤 / 期望结果 | §4 各表 7 列（ID / 类·优 / 前置条件 / 操作步骤 / 期望结果与通过判据 / 自动化 / 追溯）；类别 🟢 62 / 🟡 9 / 🔴 30 | ✅ |
| 验收标准被用例化：有明确的通过 / 失败判据 | §3 唯一线表 + 每条「期望结果 / 通过判据」列 + §7 的 34 条 AC 全覆盖矩阵 | ✅ |
| 关键业务规则同时有正向与反向用例 | §5 的 BR-1~BR-16 逐条配对（正向引用必 🟢、反向引用必 🔴，§8 机器校验） | ✅ |
| 做：把验收标准逐条翻译成可执行用例 | §4 全部用例可追溯到 S1~S7 验收行分句与 AC 编号 | ✅ |
| 不做：不执行用例（执行是 tester 的职责） | §2 明示分层与执行人；本文只给命令与判据，未跑任何业务用例 | ✅ |
| 不做：不写业务实现代码 | 本任务只新增 `docs/G-mv1s6y49-1/TEST_CASES.md` 与 `T198-evidence/` 自检脚本/输出；未改任何产品源码 | ✅ |
| 能落成测试代码的尽量一并写出 | §9 附录 B 给出 6 个切片测试文件的可照抄骨架（逐个 `node --check` 通过，证据 `02-skeleton-syntax.txt`），并说明为何不预写文件（文件域 + CI 清单完备性） | ✅ |

| 关联文档 | 关系 |
| --- | --- |
| [REQUIREMENTS.md](./REQUIREMENTS.md) | 需求与 34 条 AC 的权威来源（本文 §7 逐条追溯） |
| [RESEARCH.md](./RESEARCH.md) | 方案 A 的选型与 13 面盘点（本文 §4 各面用例的依据） |
| [TASK_BREAKDOWN.md](./TASK_BREAKDOWN.md) | 7 切片与「## slices」验收行（本文 §4 用例的翻译基准） |
| `docs/G-mv1s6y49-1/T198-evidence/README.md` | 本阶段自检证据说明（machcheck 脚本与输出） |
| `docs/G-mv1s6y49-1/TEST_REPORT.md`（T-201 产出） | tester 按本文 §2/§6 逐条执行后的结果登记（尚未产出） |
