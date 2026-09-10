<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-06**（commit `7ffa303`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-114 测试用例 / 验收测试：Legion「完整功能使用介绍文档 + 功能/迭代持续自动同步」

> 角色：test-designer（测试用例设计）｜阶段：测试用例设计｜执行任务：T-114（[auto-goal]｜所属目标 G-mtpq729o-1 · software · chain）
> 上游：T-111 需求澄清（docs/G-mtpq729o-1/REQUIREMENTS.md，R-1~R-5 + AC-R1-1..5 / AC-R2-1..4 / AC-R3-1..4 / AC-R4-1..5 / AC-R5-1..4 + D-1..D-9 默认值即基线）→ T-112 方案搜索（docs/G-mtpq729o-1/RESEARCH.md，决策 A1/B1/C1/D1+D2+D3/D4/E1/F1+F3 + §11 切片建议）→ T-113 任务拆解（docs/G-mtpq729o-1/TASK_BREAKDOWN.md：**「## slices」5 个切片 S1~S5**，每片机器验收行 = 本用例唯一拆解基准）
> 下游：守护按 TASK_BREAKDOWN 注册 coder_Si → tester_Si 微链；coder 按本文档「自动化落点 / 附录 B」把 P0 用例落成机器断言与契约测试；tester 按 §2 分层逐条执行并把结果写入 docs/G-mtpq729o-1/TEST_REPORT.md；devops 按 §6 端到端接入 CI 门禁。
> 依据：T-113 TASK_BREAKDOWN §1 机器验收行（每片 DoD 分句）、T-111 REQUIREMENTS §5 AC-* 口径、T-112 RESEARCH 决策与设计要点、LEGION.md 纪律与 T-114 阶段验收（覆盖 主路径+边界+异常；每条含 前置/步骤/期望与通过判据；关键业务规则正反向成对）。
>
> **权威基线/命名空间提醒**：本目标分析文档目录 = docs/G-mtpq729o-1/。仓库根 docs/TEST_CASES.md 等根槽位文件属其他目标/遗留链，**禁止读写**。本用例只写本文（docs/G-mtpq729o-1/TEST_CASES.md）；doc-sync 契约文件域统一为绝对仓库相对路径 **docs/FEATURES.md 与 README.md**，禁止写 docs/G-mtpq729o-1/FEATURES.md（那是阶段分析文档目录，产品手册长期固定 docs/FEATURES.md，D-2/RESEARCH §8）。
>
> **工作区状态**：docs/G-mtpq729o-1/ 现仅 REQUIREMENTS.md、RESEARCH.md、TASK_BREAKDOWN.md，无本文旧版（T-114 本阶段首次产出）。

## 0. 结论速览

- 交付单件：本文档（docs/G-mtpq729o-1/TEST_CASES.md）。共 **66 条用例**（S1 15 / S2 13 / S3 10 / S4 15 / S5 13；🟢正常 34 / 🟡边界 12 / 🔴异常 20；P0=50 / P1=13 / P2=3），每条含 前置条件 / 操作步骤 / 期望结果与通过判据；计数/ID 唯一性/类别/优先级/追溯引用完整性已符合 T-098 machcheck 式自检范式（§7 附录 A 供 runner 一键复核），并经一次性 Node 脚本自检（见证据 docs/G-mtpq729o-1/T114-evidence/01-doc-machcheck.txt，66/66 唯一、0 悬空引用、0 未知类别）。
- 验收标准用例化：T-113 TASK_BREAKDOWN §1 机器验收行（S1~S5）每条 + T-111 AC-R1-1..5 / AC-R2-1..4 / AC-R3-1..4 / AC-R4-1..5 / AC-R5-1..4 + 设计决策（A1/B1/C1/D1/D2/D3/D4/E1/F1/F3）+ 不变量（I-1..I-8，§1.3）逐条映射到用例（§6 追溯矩阵）；PASS/FAIL 判据写进每条「期望结果 / 通过判据」列，无黑盒结论。
- 关键业务规则正反向成对（§4.0）：功能索引存在性与完整性（正向=索引在且 ≥18 行 / 反向=缺失或坏列或锚点失效即失败）、doc-sync 条件化契约（正向=feature 任务追加 docs 契约 / 反向=非 feature 不追加不被卡）、README↔手册互链（正向=锚点有效 / 反向=注入坏链接即失败）、CI doc 阶段门禁（正向=全绿 PASS / 反向=坏链 FAIL / 可 --skip doc 跳过）、文档状态口径（正向=无过程叙事 / 反向=出现 P1/P2/P3 过程叙事即失败）、校验脚本零依赖（正向=仅 node:fs/re/path / 反向=引用第三方依赖即失败）——均给正向 + 反向用例。
- 测试代码落点：S1/S2 → docs/FEATURES.md / README.md 的内联机器断言由 coder 以 `node -e` 落盘、tester 复跑；S3 → scripts/ci/check-docs.mjs 本体（正向/负例均由脚本自身承担）；S4 → plugins 既有 worker-regression.test.mjs / artifact 相关套件追加 describe + DB 直调断言 + typecheck；S5 → scripts/ci/run-ci.mjs 的 doc 阶段注册断言 + 坏链注入。骨架与代码片段见附录 B。**本阶段不新增/不预写切片域内可执行测试文件**（同仓库惯例：S1~S5 目标代码未实现，预写必全红；测试文件所有权已由 TASK_BREAKDOWN §1 第 2 段划给各 coder 文件域），仅交付用例 + 可照抄骨架。
- 现存基线（预估，待 tester 实测确认）：既有 plugins 测试套件（plugins/tests/*.test.mjs）、team-hub worker-regression、run-ci 六阶段、T-098 machcheck 先例——S4/S5 改动不得使其回归（§4.12 回归用例）。
- 环境事实（写进各用例执行说明）：本 worktree **无 node_modules/dist**（不随 git 分发）；plugins typecheck（tsc -p plugins/tsconfig.json --noEmit）、workbench build、S4 AC-R4-1/2/4 流水线闭环需宿主/CI，按「环境受限 + 复现步骤」记录不冒充通过（仓库 R-18 惯例）；`node scripts/ci/check-docs.mjs` 为纯 Node 直跑、沙箱可跑；`node scripts/ci/run-ci.mjs` 子进程 spawn 在沙箱可能 EPERM（errno -4048），以普通终端/宿主执行并按测试文件头「沙箱受限直跑等效」惯例处理。

## 1. 输入、工作假设与硬性不变量

### 1.1 输入与假设

| 输入 | 说明 |
| --- | --- |
| REQUIREMENTS（T-111，docs/G-mtpq729o-1/REQUIREMENTS.md）§5 | R-1（P0 手册 AC-R1-1..5）/ R-2（P0 README 收敛 AC-R2-1..4）/ R-3（P0 功能索引 AC-R3-1..4）/ R-4（P0 持续机制 AC-R4-1..5）/ R-5（P1 机器校验 AC-R5-1..4）—— 验收口径逐条可测试 |
| TASK_BREAKDOWN.md（T-113）§1 | S1~S5 机器验收行（每行含命令、期望、DoD）—— 本用例逐条翻译对象 |
| RESEARCH.md（T-112） | A1（docs/FEATURES.md 纯 MD 单文件）+ B1（Markdown 表格索引，行首 F-xx）+ C1（check-docs.mjs 零依赖脚本）+ D1/D2/D3/D4（机制注入组合）+ E1（run-ci 注册可 skip doc 阶段）+ F1/F3（任务声明 + 索引对账）—— 端点/语义默认依据 |
| 代码基线 | w/T-114 HEAD == promote T-113（代码与上游一致；T-111/T-112/T-113 仅改 docs）；本批 5 片文件域两两不相交（§5 依赖顺序） |
| 假设 H-1 | S4 任务级 feature/docSync 标记：由 breaker 在拆解/派工时依据「是否用户可见行为变化」声明写入任务字段（如 `docSync: true` / `feature: true`；F1），机器只校验「声明 feature 却没文档」（RESEARCH §7.1）。若实现用别的字段名，仅改本组用例断言取值，语义不变 |
| 假设 H-2 | S4 D2 条件化 stage.docs 契约：feature/docSync 任务在角色契约路径追加 `docs/FEATURES.md` + `README.md`（经 registerContractDocs 软门禁，plugins :1593-1607）；非 feature 任务不追加（AC-R4-4）。追加路径用绝对仓库相对路径，非目标级目录（RESEARCH §8，I-2） |
| 假设 H-3 | S4 D1 stage-standards 验收项：为 coder/devops 增加「用户可见行为变更须同步功能手册 + README」机器验收项（只加项不改岗位语义，AC-R4-5） |
| 假设 H-4 | S4 D3 buildWorkerPrompt 提示词：docSync 任务提示词追加「请同步 docs/FEATURES.md 对应小节 + 功能索引 + README 引导段」（plugins :1332/1340 附近） |
| 假设 H-5 | S3 check-docs.mjs 校验项 = AC-R2-2（README→手册锚点）/ AC-R3-1（索引提取）/ AC-R3-2（索引锚点）至少三项，另 AC-R2-1（段落去重）与 AC-R2-3（关键项不丢）以脚本或人工清单二选一（R-5 AC-R5-3） |
| 假设 H-6 | S5 run-ci.mjs doc 阶段调用 `node scripts/ci/check-docs.mjs`，默认接入全量、支持 `--skip doc`（RK-6 可跳） |
| 假设 H-7 | 功能索引行格式：`| F-01 | 功能名 | 章节锚点 | 入口 | 状态 |`（5 单元格；列切分校验以 `String.fromCharCode(124)` 判 4 段分隔 → 5 列；状态枚举 = 已上线 / 迭代中 / 遗留；粒度 = 功能域级，D-6） |
| 假设 H-8 | 功能域基线 = REQUIREMENTS §2.5 的 18 功能域（将军确认后定稿，D-6）；索引行数 ≥ 18 |

### 1.2 决策闸门默认值（D 系列，本用例判定依据；将军未否决即按默认展开）

| 闸门/决策 | 默认（本用例按此展开） | 对立主张 | 翻转影响 |
| --- | --- | --- | --- |
| D-1 对象范围 | Legion 平台用户可见面（workbench + 三中心 + 服务形态 + v1 遗留边界）；插件族/桌面适配以「服务与插件形态」速览呈现 | 含逐插件详述 | S1 覆盖对账期望变化 |
| D-2 手册路径 | docs/FEATURES.md | 仓库根 FEATURES.md / docs/USAGE.md | S1/S2/S3/S5 路径断言变化（常量替换） |
| D-3 双文档结构 | README=总览/入口 + 手册=细节，互链去重 | 单长文 README | S2 去重/互链断言变化 |
| D-4 保障强度 | 流程契约(R-4) + 机器门禁(R-5) 都做 | 只做流程 | S3/S5 顺序与优先级变化 |
| D-5 触发口径 | 用户可见行为变化触发；纯重构/测试不触发（AC-R4-4） | 所有变更触发 | S4 条件化断言翻转 |
| D-6 基线/粒度 | §2.5 草案、功能域级、不做源码自动提取 | 按钮级 / 自动化提取 | S1 索引行数与覆盖断言变化 |
| D-7 v1 遗留 | 纳入「遗留与迁移」一章（边界说明 + 迁移指引） | 不纳入 | S1 覆盖对账（含 v1） |
| D-8 语言/形态 | 中文 Markdown 单文件 | 多语言/网页版 | S1 存在性与结构断言不变 |
| D-9 产出时机 | 首版手册与机制同批交付 | 先手册后机制 | 本批切片顺序不变（S1/S2 文档组 + S4 机制组并行） |

### 1.3 硬性不变量（本批任何实现不得违反，均有门禁用例锚定）

| # | 不变量 | 门禁用例 |
| --- | --- | --- |
| I-1 | 零新增运行时依赖（全批；文档为纯 Markdown，脚本仅 node:fs/re/path，CI 复用既有阶段模型） | TC-S1-15 / S2-12 / S3-10 / S4-14 / S5-11 |
| I-2 | doc-sync 契约文件域用绝对仓库相对路径 docs/FEATURES.md + README.md；禁止写目标级目录（RESEARCH §8） | TC-S4-03 / S4-08 |
| I-3 | docs/FEATURES.md 与 README.md 是持久产品文档，不在 GOAL_DOC_NAMES，不被 goalDocPath 改写进目标目录 | TC-S4-03 / S1-15 |
| I-4 | 条件化：仅 feature/docSync 任务追加 docs 契约；非 feature 不追加（AC-R4-4） | TC-S4-05 / S4-09 |
| I-5 | 只增字段/项/文本，不改岗位职责语义（AC-R4-5）；roles.json/stage-standards 语义不变 | TC-S4-12 / S4-13 |
| I-6 | 校验脚本只判结构/链接/索引一致，不判语义（R-5 scope） | TC-S3-08 / S5-06 |
| I-7 | 校验脚本零第三方依赖纯 Node（node:fs/re/path） | TC-S3-10 |
| I-8 | 手册状态口径 = 已上线 / 迭代中 / 遗留；无「P1/P2/P3 切片已交付」式过程叙事 | TC-S1-07 / S1-13 |

## 2. 测试分层与执行方式（谁在什么时候跑）

> 与仓库既有批次同构；命令以 `node <file>` 直跑等效为准。**node_modules 不在本 worktree**：plugins typecheck / workbench build 按 R-18 记录「环境受限 + 复现步骤」（宿主 junction 后执行），不冒充通过。

| 层 | 载体/命令 | 覆盖 | 执行者/时机 | 环境注记 |
| --- | --- | --- | --- | --- |
| L0 | 文档机器断言：`node -e '<S1/S2 DoD 内联断言>'`；S3 校验脚本 `node scripts/ci/check-docs.mjs`；S5 `node scripts/ci/run-ci.mjs [--skip doc]` | 各切片结构/链接/索引/门禁纯逻辑 | coder 随实现交付自跑；tester 验收复跑 | 沙箱直跑已验证（纯 Node）；node v22.5+ |
| L1 | 机制契约/流程断言：plugins `node --test plugins/tests/*.test.mjs`（S4 追加 describe）；DB/微链直调断言 | S4 契约路径/软门禁/条件化/回归 | tester（S4 后） | 宿主/CI；沙箱受限记录复现步骤 |
| L2 | 端到端人工/宿主验收：将军发布用户可见功能目标 → 拆解自动带 doc-sync → 合入时文档同步 → CI doc 阶段通过 | S4 AC-R4-1/2/3 试点闭环；§6 端到端 | 将军 + tester | 宿主可达面；受限如实标注 |
| L3 | 集成回归 + typecheck：`tsc -p plugins/tsconfig.json --noEmit`、既有 run-ci 六阶段 | S4 回归（AC-R4-5）、S5 既有阶段不回归 | tester / devops | 宿主不可达部分如实标注，不冒充通过 |

### 2.1 关键命令与 env（tester/coder 照抄）

| 用途 | 命令 / env | 说明 |
| --- | --- | --- |
| 手册存在性/标题 | `node -e "const fs=require('fs');const t=fs.readFileSync('docs/FEATURES.md','utf8');if(!/功能使用介绍|使用手册/.test(t))process.exit(2);console.log('OK')"` | S1 验收 1/2 |
| 六类章节存在非空 | `node -e "..."`（正则统计各章节标题 ≥1 且非空，见附录 B 骨架） | S1 验收 3 |
| 索引行数/坏列 | `node -e "..."`（`/^F-[0-9]{2}/m` 计数 ≥18；`String.fromCharCode(124)` 切分校验 5 列） | S1 验收 4 |
| 索引锚点有效 | `node -e "..."`（提取 F 行锚点与全文标题比对 0 失效） | S1 验收 5 |
| 每域小节 ≥5 行 | `node -e "..."`（按章节标题切片统计行数） | S1 验收 6 |
| 无过程叙事 | `node -e "..."`（正则计数 `P1/P2/P3.*已交付|切片 S[0-9].*已交付` = 0） | S1 验收 7 |
| 互链 ≥8 处/锚点有效 | `node -e "..."`（README 指向 docs/FEATURES.md 链接计数；提取锚点解析） | S2 验收 1/2 |
| 去重 0 块 | `node -e "..."`（README 与 FEATURES 行块比对 ≥3 行同文块 = 0） | S2 验收 3 |
| 关键项不丢 | `node -e "..."`（三件套/DSH Desktop 自启/三分钟循环/排障行逐项断言在二文件之一） | S2 验收 4 |
| 脚本 --help | `node scripts/ci/check-docs.mjs --help` | S3 验收 1 |
| 脚本正向/负例 | `node scripts/ci/check-docs.mjs`（当前满足 exit 0）；注入坏锚点后再跑 exit ≠ 0 | S3 验收 2/3 |
| 插件类型 | `tsc -p plugins/tsconfig.json --noEmit`（node_modules 就位后） | S4 DoD；缺失按 R-18 记录 |
| CI doc 阶段 | `node scripts/ci/run-ci.mjs`（全量）；`node scripts/ci/run-ci.mjs --skip doc`；`--only test` | S5 验收 1/2/3 |
| 机制契约断言 | `node --test plugins/tests/worker-regression.test.mjs` 等（宿主/CI） | S4 回归 |

## 3. 量化判据与建议默认值（PASS/FAIL 唯一线）

> ⚖️ 为实现期可配值（如索引行数下限、互链数、时长），做「值-1 / 值 / 值+1」三值法断言；定值后无需改用例。

| 指标 | 建议默认 | PASS 判据 |
| --- | --- | --- |
| 手册存在性 | docs/FEATURES.md | 存在且为有效 MD，标题含「功能使用介绍」或「使用手册」（AC-R1-1） |
| 六类章节 | 定位/读者/快速开始/模块章节/功能索引/排障与术语附录 | 每类 ≥1 个 ##/### 标题且非空（AC-R1-2） |
| 索引行数（R-3） | ≥18（18 个功能域，D-6） | ≥18 且 0 坏列、0 失效锚点（AC-R3-1/2），每域正文 ≥5 行（AC-R3-3） |
| 过程叙事（R-1） | =0 | 无「P1/P2/P3 切片已交付」式叙事，状态用 已上线/迭代中/遗留（AC-R1-5） |
| README 互链（R-2） | ≥8 处 | 指向 docs/FEATURES.md 链接计数 ≥8，锚点 0 失效（AC-R2-2） |
| 去重（R-2） | =0 | README 与手册 ≥3 行同文操作步骤块 = 0（AC-R2-1），关键项不丢（AC-R2-3） |
| 校验脚本（R-5） | 正向 exit 0；负例 exit ≠ 0 | --help 可用；覆盖 ≥3 项；零第三方依赖（AC-R5-1/2/3） |
| CI doc 阶段（R-5） | 默认可 skip | 全量 PASS；坏链 FAIL；--skip doc 跳过且其它阶段不失败（AC-R5-4） |
| doc-sync 契约（R-4） | 条件化 | feature 任务追加 docs 契约且缺失即停 in_review；非 feature 不追加不被卡（AC-R4-1/2/4/5） |

## 4. 用例目录

> 图例：类别 🟢正常 / 🟡边界 / 🔴异常；优先级 P0（切片验收门槛）/ P1 / P2；「自动化」= node -e 内联断言 / check-docs 脚本 / node --test（plugins 面）/ L1 / L2 浏览器 / 评审（grep + 代码审查断言）。
> 追溯列引用：T-111 验收口径（AC-R1-x / AC-R2-x / AC-R3-x / AC-R4-x / AC-R5-x）、T-113 TASK_BREAKDOWN §1 机器验收行（Sx 验收 1/2/… = 该片 DoD 分句）、决策（A1/B1/C1/D1/D2/D3/D4/E1/F1/F3）、闸门（G-Rx=D-x）、不变量（I-x）、假设（H-x）。
> 复现索引（§4.0）给「现状缺口 → 本批切片 → 用例」映射，供 coder 先复现后实现、tester 回归时对照。

### 4.0 现状缺口 → 切片 → 用例索引

| 缺口（现状证据，T-111 §2 / T-113 §5） | 归属切片 | 直接用例 |
| --- | --- | --- |
| G1 无独立功能手册（README 为混合长文，README.md:1-242） | S1/S2 | TC-S1-01/02/03、TC-S2-01 |
| G2 无功能索引、机器可读清单（git grep 无 FEATURES/feature index 命中） | S1/S3 | TC-S1-04/05/06、TC-S3-02/03 |
| G3 README 与手册无去重互链（README 260 行细节堆叠） | S2 | TC-S2-03/04/05、TC-S3-04 |
| G4 无文档新鲜度机器校验（run-ci 六阶段无 doc 阶段，scripts/ci/run-ci.mjs:15-23） | S3/S5 | TC-S3-01..10、TC-S5-01..13 |
| G5 无 doc-sync 条件化契约与触发口径（roles.json coder/devops 无 docs 字段；plugins registerContractDocs 仅按阶段 docs） | S4 | TC-S4-01..15 |
| G6 README 含过程性叙述（P0-P3、T-0xx），非纯「当前现状」 | S2 | TC-S2-06、TC-S1-07 |
| G7 校验脚本无独立可跑先例（T-098 machcheck 有先例，未进 CI） | S3 | TC-S3-01 |

### 4.1 S1 功能手册首版 + 功能索引（docs/FEATURES.md）【P0 · 行内起点】
自动化：coder 以 `node -e` 内联断言落盘（附录 B 骨架），tester 复跑；覆盖六类章节/索引/锚点/无过程叙事。

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S1-01 | 🟢 P0 | coder 合入 docs/FEATURES.md（w/T-115 切片合到 main 后） | `node -e "const fs=require('fs');const t=fs.readFileSync('docs/FEATURES.md','utf8');console.log(t.length>0?'OK':'EMPTY')"` | exit 0 且输出 OK；文件存在、非空、为有效 Markdown（含 `#` 标题）——AC-R1-1 | node -e（L0） | AC-R1-1；S1 验收 1；I-1 |
| TC-S1-02 | 🟢 P0 | 同 TC-S1-01 | `node -e "...if(!/功能使用介绍|使用手册/.test(t))process.exit(2)"` | exit 0；标题含「功能使用介绍」或「使用手册」（正则断言 =1，防多手册/软链混淆）——AC-R1-1 | node -e（L0） | AC-R1-1；S1 验收 2 |
| TC-S1-03 | 🟢 P0 | 同 TC-S1-01 | `node -e "..."` 统计六类章节（一句话定位/面向读者/快速开始/模块章节/功能索引/故障排查与术语附录）标题 | 每类 ≥1 个 `##` 或 `###` 标题且所属正文非空（行数 >0）；六类齐全无缺——AC-R1-2 | node -e（L0） | AC-R1-2；S1 验收 3 |
| TC-S1-04 | 🟢 P0 | 同 TC-S1-01 | `node -e "..."`（`/^F-[0-9]{2}/m` 计数；`String.fromCharCode(124)` 切分校验 5 列） | 索引行数 ≥18；每条 F 行 5 列（0 坏列，缺段/多段即失败）——AC-R3-1 | node -e（L0） | AC-R3-1；S1 验收 4；B1；I-8 |
| TC-S1-05 | 🟢 P0 | 同 TC-S1-01（索引已在） | `node -e "..."`（提取 F 行锚点与全文标题比对） | 索引中每个章节锚点在全文真实存在，0 失效——AC-R3-2 | node -e（L0） | AC-R3-2；S1 验收 5 |
| TC-S1-06 | 🟢 P0 | 同 TC-S1-01（索引已在） | `node -e "..."`（按章节标题切片统计正文行数） | 索引每条功能对应正文小节 ≥5 行（无空壳），且含「入口」或「操作」字样——AC-R3-3 | node -e（L0） | AC-R3-3；S1 验收 6 |
| TC-S1-07 | 🟢 P0 | 同 TC-S1-01 | `node -e "..."`（正则计数 `P1/P2/P3.*已交付|切片 S[0-9]+.*已交付`；状态字段统计） | 正文无「P1/P2/P3 切片已交付」式过程叙事计数 =0；状态字段取值 ∈ {已上线, 迭代中, 遗留}——AC-R1-5 | node -e（L0） | AC-R1-5；S1 验收 7；I-8 |
| TC-S1-08 | 🟢 P0 | 同 TC-S1-01 | 内容抽检：比对手册各模块章节与 README §2/§3/§4 对应小节 | 手册已抽取整理 README 功能指南并更新到当前行为（非照抄，去过程性叙述）；`node -e` 断言手册含 README §2/§3/§4 各模块标题或关键词 >0——AC-R1-4 | node -e + 评审 | AC-R1-4；S1 验收 8 |
| TC-S1-09 | 🟢 P0 | 同 TC-S1-01 | 覆盖对账：§2.5 基线 18 功能域（安装启动/空间编队/中央视图/任务集与详情/发布目标/调度验收/自动交接/模型配置/对话/文件/浏览器/规范/技能/日历通知/收尾审计/team-hub/v1 遗留/排障）逐域在手册有章节或小节 | 每个功能域在手册有对应 `##`/`###` 小节，锚点可在文档内跳转；将军确认保留的域无缺——AC-R1-3 | node -e（回归） | AC-R1-3；D-6；D-7 |
| TC-S1-10 | 🟡 P0 | 同 TC-S1-01 | 索引行数三值法：构造恰 18 行、恰 19 行的 FEATURES 副本（或断言当前 ≥18） | 18 行 → 通过（下界恰满足）；19 行 → 通过；`node -e` 断言 ≥18 不误报——AC-R3-1 边界 | node -e（边界） | AC-R3-1；D-6 |
| TC-S1-11 | 🔴 P0 | 同 TC-S1-01 | 注入坏列：在任意 F 行手工删一列（3 列）或加一列（5 列变 6 列） | `node -e` 0 坏列断言失败（exit ≠ 0），报错指向具体 F 行——AC-R3-1 反向（B1 四段校验） | node -e（负例） | AC-R3-1；B1 |
| TC-S1-12 | 🔴 P0 | 同 TC-S1-01 | 注入失效锚点：把某 F 行锚点改为不存在的标题（如 `#999`） | `node -e` 锚点 0 失效断言失败，报错含文件名与锚点名；还原后通过（git checkout 或快照）——AC-R3-2 反向 | node -e（负例） | AC-R3-2 |
| TC-S1-13 | 🔴 P0 | 同 TC-S1-01 | 注入过程叙事：在某小节插入「P1 切片 S5-S8 已交付」文本 | `node -e` 无过程叙事断言失败（计数 ≠ 0）——AC-R1-5 反向；还原后通过 | node -e（负例） | AC-R1-5；I-8 |
| TC-S1-14 | 🔴 P1 | 同 TC-S1-01 | 正文小节过短注入：把某功能对应的正文小节压缩到 <5 行 | `node -e` ≥5 行断言失败（空壳检出）——AC-R3-3 反向；还原后通过 | node -e（负例） | AC-R3-3 |
| TC-S1-15 | 🔴 P0 | 同 TC-S1-01 | `git diff` 核对 package.json / imports；手册为纯 Markdown 无构建链 | 零新增依赖（无 package.json 变更、无新 import）；手册不引入任何运行时构建——I-1；`node -e` 断言手册无 `docs/G-mtpq729o-1/FEATURES.md` 路径书写（命名空间，I-3） | 评审 + node -e | I-1；I-3；D-2 |

### 4.2 S2 README 收敛 + 总览导航 + 与手册互链去重（README.md）【P0】
自动化：coder 收敛 README 后以 `node -e` 内联断言落盘；tester 复跑互链/去重/关键项/无过程叙事。

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S2-01 | 🟢 P0 | coder 合入 README.md（收敛版） | `node -e "const fs=require('fs');const t=fs.readFileSync('README.md','utf8');console.log(t.length>0?'OK':'EMPTY')"` | exit 0 且输出 OK；README 存在、非空、为当前产品现状口径（不再堆叠历史过程叙事）——AC-R2-4 | node -e（L0） | AC-R2-4；S2 验收 1 |
| TC-S2-02 | 🟢 P0 | 同 TC-S2-01（FEATURES 已在） | `node -e ".../(docs\/FEATURES\.md#[\w-]+)/g..."` 计数指向 docs/FEATURES.md 的章节互链 | 互链计数 ≥8（README 各模块小节均有「📖 详见功能手册 §x.y」）——AC-R2-2 | node -e（L0） | AC-R2-2；S2 验收 1 |
| TC-S2-03 | 🟢 P0 | 同 TC-S2-02 | 解析 README 中所有指向 docs/FEATURES.md 的锚点链接，比对 FEATURES.md 全文标题 | 每个互链锚点在 FEATURES.md 真实存在（0 失效），无死链——AC-R2-2 | node -e（L0） | AC-R2-2；S2 验收 2 |
| TC-S2-04 | 🟢 P0 | 同 TC-S2-02 | 段落级去重：把 README 与 FEATURES 按行分块，比对 ≥3 行的重复操作步骤块 | 除引用/链接/表格头外，≥3 行同文块数量 = 0（无整段复制）——AC-R2-1 | node -e（L0） | AC-R2-1；S2 验收 3 |
| TC-S2-05 | 🟢 P0 | 同 TC-S2-02 | 关键项断言：三件套命令 / DSH Desktop 自启 / 三分钟循环 三个主题在 README 或手册之一存在（迁移项含互链） | 三主题均出现于二文件之一；README §2 快速开始三件套/§6 排障全部「现象」行主题仍在——AC-R2-3 | node -e（L0） | AC-R2-3；S2 验收 4 |
| TC-S2-06 | 🟢 P0 | 同 TC-S2-01 | 过程叙事检查：README 正文无 P0-P3、T-0xx 累积过程叙事（已收敛到 docs/P*-LIVE-ROLLOUT 并在附录互链） | 正文无新增过程叙事（正则计数 =0）；附录含与记录文档的互链——AC-R2-4 | node -e（L0） | AC-R2-4；S2 验收 5 |
| TC-S2-07 | 🟢 P0 | 同 TC-S2-01 | 渲染检查：run-ci 既有 doc-render 或结构断言（node 校验 README 表格/标题结构） | README 结构与表格在既有渲染下正常（无坏表/坏链），既有 doc-render 断言通过——AC-R2-4 | L0 + 评审 | AC-R2-4；S2 验收 6 |
| TC-S2-08 | 🟡 P0 | 同 TC-S2-01 | 互链锚点三值法：构造指向 FEATURES 不存在锚点 `#nonexist` 的 README 副本文档 | `node -e` 锚点 0 失效断言失败（exit ≠ 0），报错含 README 行号——AC-R2-2 边界反向 | node -e（边界/负例） | AC-R2-2 |
| TC-S2-09 | 🟡 P0 | 同 TC-S2-01 | 去重阈值边界：构造一段恰 3 行的同文操作块 | ≥3 行判重；恰 3 行 → 检出；恰 2 行 → 不判重（阈值正确）——AC-R2-1 边界 | node -e（边界） | AC-R2-1 |
| TC-S2-10 | 🔴 P0 | 同 TC-S2-01 | 关键项丢失注入：从 README 把「三件套命令」整段删除且手册也无对应 | `node -e` 关键项不丢断言失败（该主题在二文件之一缺失）——AC-R2-3 反向；还原后通过 | node -e（负例） | AC-R2-3 |
| TC-S2-11 | 🔴 P1 | 同 TC-S2-01 | 断链注入：README 出现指向 `docs/FEATURES.md#bad` 或相对路径漂移（如 `docs/G-mtpq729o-1/FEATURES.md`） | 锚点解析 0 失效断言失败（目标级目录路径被检出，I-2/I-3）；还原后通过 | node -e（负例） | AC-R2-2；I-2；I-3 |
| TC-S2-12 | 🟢 P1 | 同 TC-S2-01 | `git diff` 核对 package.json / imports；README 纯 Markdown 无构建链 | 零新增依赖（无 package.json 变更、无新 import）——I-1 | 评审 | AC-R2-4；S2 验收 6；I-1 |
| TC-S2-13 | 🟡 P2 | 同 TC-S2-01 | 互链方向：FEATURES 手册首/末含指向 README 快速开始/排障的关键反向链接 | 反向关键链接存在且指向 README 有效锚点（不逐节互链刷屏）——AC-R2-2 反向 | 评审 | AC-R2-2；D-3 |

### 4.3 S3 文档新鲜度校验脚本 check-docs.mjs（scripts/ci/check-docs.mjs）【P1】
自动化：脚本本体承担正向/负例断言；tester 直接跑脚本。

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S3-01 | 🟢 P0 | coder 合入 scripts/ci/check-docs.mjs | `node scripts/ci/check-docs.mjs --help` | exit 0 且输出用法说明（校验项/用法/--help 说明）——AC-R5-1 | check-docs（L0） | AC-R5-1；S3 验收 1；C1 |
| TC-S3-02 | 🟢 P0 | README+FEATURES 均满足（S1/S2 成文） | `node scripts/ci/check-docs.mjs` | exit 0（当前文档满足时全绿）；覆盖 ≥3 项：README→手册锚点 / 索引提取 / 索引锚点——AC-R5-1/3 | check-docs（L0） | AC-R5-1/3；S3 验收 2 |
| TC-S3-03 | 🟢 P0 | 同 TC-S3-02 | 检查脚本覆盖项：`node scripts/ci/check-docs.mjs --help` 列出校验项（≥3 项） | 覆盖项 ≥3 且包含 AC-R2-2/AC-R3-1/AC-R3-2 三机器子集；AC-R2-1/AC-R2-3 以脚本或人工清单二选一（脚本若实现即覆盖）——AC-R5-3 | check-docs（L0） | AC-R5-3；S3 验收 4 |
| TC-S3-04 | 🟢 P0 | 同 TC-S3-02 | `git diff` / 读脚本 import 区 | 脚本仅 `node:fs` / `node:path` / `node:url` 等 node: 内置（零 node_modules 第三方依赖）——AC-R5-1 | 评审 | AC-R5-1；S3 验收 5；I-1；I-7 |
| TC-S3-05 | 🔴 P0 | 同 TC-S3-02 | 负例注入：向 docs/FEATURES.md 插入一个失效锚点链接（如 `[x](#no-such-heading)`）→ `node scripts/ci/check-docs.mjs` → 还原（git checkout docs/FEATURES.md） | exit ≠ 0 且输出包含具体文件（docs/FEATURES.md）与锚点/行号——AC-R5-2；还原后重跑 exit 0（无残留副作用） | check-docs（负例） | AC-R5-2；S3 验收 3 |
| TC-S3-06 | 🔴 P0 | 同 TC-S3-02 | 负例：索引坏列注入（F-99 行删一列）→ 跑脚本 → 还原 | exit ≠ 0 且报错含「索引」与具体行；还原后 exit 0——AC-R3-1 反向 | check-docs（负例） | AC-R3-1；AC-R5-2 |
| TC-S3-07 | 🔴 P1 | 同 TC-S3-02 | 负例：README→手册断链注入 → 跑脚本 → 还原 | exit ≠ 0 且报错含 README 文件名与行号（互链失效被检出）——AC-R2-2 反向 | check-docs（负例） | AC-R2-2；AC-R5-2 |
| TC-S3-08 | 🟡 P0 | 同 TC-S3-02 | 校验范围检查：脚本只判结构/链接/索引，不判语义 | 脚本对「手册语义是否正确」不输出结论（无语义判定，I-6）；`--help` 说明 scope——AC-R5 scope | 评审 | AC-R5；S3 验收 5；I-6 |
| TC-S3-09 | 🟡 P1 | 同 TC-S3-02 | 阈值边界：注入 1 个坏锚点 vs 0 个坏锚点 | 0 坏锚点 exit 0；1 坏锚点 exit ≠ 0（边界判据明确，不误报）——AC-R5-1/2 边界 | check-docs（边界） | AC-R5-1/2 |
| TC-S3-10 | 🔴 P0 | 同 TC-S3-02 | `git diff` 核对 package.json / node_modules | 零第三方依赖（无 package.json 变更、无 node_modules 引用）——I-1；沙箱内 `node scripts/ci/check-docs.mjs` 可直接跑不联网 | 评审 | AC-R5-1；I-1；I-7 |

### 4.4 S4 持续自动更新机制注入点（team-hub/stage-standards.mjs + roles.json + plugins/src/index.ts）【P0】
自动化：plugins tests（node --test，宿主/CI）+ DB 直调断言 + typecheck + 流水线闭环（AC-R4-1/2/4）。

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S4-01 | 🟢 P0 | coder 合入 S4（stage-standards/roles/plugins 改动） | 生成一条功能类目标链（或调用 stageContractDocs/resolveStageDocPaths 直调），feature/docSync 任务绑定 coder/devops 阶段 | 该任务 contracts 追加 `docs/FEATURES.md` + `README.md`（D2 条件化）；追加路径为绝对仓库相对路径，非目标级目录（I-2/I-3）——AC-R4-1 | node --test + DB 直调 | AC-R4-1；S4 验收 1；D2；I-2 |
| TC-S4-02 | 🟢 P0 | 同 TC-S4-01 | 读 roles.json / stage-standards.mjs 的 coder、devops 阶段定义 | roles.json 的 stage.docs 契约（或等价机器契约）新增 `docs/FEATURES.md` / `README.md` 项；`stage-standards` 为 coder/devops 增加「用户可见行为变更须同步功能手册 + README」验收项（D1）——AC-R4-5 | 评审 + node 断言 | AC-R4-5；S4 验收 2；D1 |
| TC-S4-03 | 🟢 P0 | 同 TC-S4-01 | 调用 buildWorkerPrompt（或读插件注入）对 badged docSync 任务生成提示词 | 提示词含「请同步 docs/FEATURES.md 对应小节 + 功能索引 + README 引导段」（D3）；`docs/FEATURES.md` 未被 goalizePrompt 改写进目标目录（I-3）——AC-R4-1 说明层 | node --test + 评审 | AC-R4-1；S4 验收 3；D3；I-3 |
| TC-S4-04 | 🟢 P0 | 同 TC-S4-01 | 契约注入语义验证：registerContractDocs 对 feature 任务的 contracts 逐条登记（通过 hubPost /api/artifact 或 taskctl artifact） | feature 任务结算时 FEATURES.md/README.md 存在 → 登记成功（registered 含两路径）；缺失 → 进 missing——AC-R4-2 正向前置 | node --test + L1 | AC-R4-2；S4 验收 4；D2 |
| TC-S4-05 | 🟢 P0 | 同 TC-S4-01 | 非 feature 任务契约检查：生成一条纯重构/测试类任务（无 docSync 标记） | 该任务 contracts **不含** docs/FEATURES.md/README.md（不追加），流程不被文档要求卡住——AC-R4-4 | node --test + DB 直调 | AC-R4-4；S4 验收 5；D5；I-4 |
| TC-S4-06 | 🔴 P0 | 同 TC-S4-01 | 负例：模拟某 feature 任务未做文档同步直接提交（worktree 无 FEATURES.md/README.md）→ 走结算 | 任务停在 in_review，评论含「需同步功能文档」/「契约产出文档缺失」类提示；不 autoPromote 不误判成功——AC-R4-2 | node --test（流水线模拟） | AC-R4-2；S4 验收 4；D2 |
| TC-S4-07 | 🔴 P0 | 同 TC-S4-01 | 负例：feature 任务只改了 README 没改 FEATURES → 提交 | 同样停在 in_review（缺失 FEATURES.md）并提示；补 FEATURES.md 后重跑 → 登记成功、提示消除、照常流转——AC-R4-2 反向 | node --test（流水线模拟） | AC-R4-2；D2 |
| TC-S4-08 | 🔴 P0 | 同 TC-S4-01 | 负例：feature 任务把契约路径写成目标级目录 `docs/G-mtpq729o-1/FEATURES.md`（I-2 违反） | 契约/登记路径被检出为目标级目录（或与 docs/FEATURES.md 不一致）→ 断言失败，提示须用绝对仓库相对路径——I-2/I-3 | node --test + 评审 | AC-R4-5；I-2；I-3；D-2 |
| TC-S4-09 | 🟡 P0 | 同 TC-S4-01 | 条件化边界：feature= 不确定/模糊任务（如 bug 修复但无行为变化）声明不含 docSync | 不追加 docs 契约（非 feature 不误伤），流程不被卡——AC-R4-4 边界 | node --test（边界） | AC-R4-4；D-5 |
| TC-S4-10 | 🟡 P0 | 同 TC-S4-01 | 契约追加的幂等性：同一 feature 任务重复结算（多轮打回/重跑） | contracts 追加不重复（同一 path 不重复登记）；缺失提示不刷屏（幂等，AC-R2-3 多轮惯例）——AC-R4-2 边界 | node --test（边界） | AC-R4-2；D2 |
| TC-S4-11 | 🔴 P1 | 同 TC-S4-01 | 契约登记写失败注入：hub 不可达或 /api/artifact 抛错 | 登记失败并入 missing，软门禁停 in_review 且归因清晰（不再把「登记写失败」误判为「文档缺失」，T-108 M2 修复语义）；进程存活——AC-R4-2 异常 | node --test（异常） | AC-R4-2；I-6；T-108 M2 |
| TC-S4-12 | 🟢 P0 | 同 TC-S4-01 | `tsc -p plugins/tsconfig.json --noEmit`（node_modules 就位后） | typecheck 0 诊断；受限时如实记录复现步骤（R-18），不冒充通过——AC-R4-5 | L0 typecheck | AC-R4-5；S4 验收 6 |
| TC-S4-13 | 🟢 P0 | 同 TC-S4-01 | 既有套件回归：`node --test plugins/tests/*.test.mjs`（宿主/CI）+ worker 套件 | 既有 stage.docs 产物登记/预览（T-107）、派工/流转套件不回归；roles.json 仅新增字段/项，岗位职责语义不变——AC-R4-5 | node --test（回归） | AC-R4-5；S4 验收 7；I-5 |
| TC-S4-14 | 🟢 P1 | 同 TC-S4-01 | `git diff` 核对 package.json / imports | 零新增运行时依赖（无 package.json 变更、无新 import）——I-1 | 评审 | AC-R4-5；I-1 |
| TC-S4-15 | 🔴 P1 | 同 TC-S4-01 | 失败兜底：registerContractDocs 在登记某路径抛错时 catch 吞错（现有逻辑 :1186-1190） | 单路径失败不中断整批登记（其它路径仍登记）；missing 记对该路径；不产生 500 风暴、进程存活——AC-R4-2 异常 | node --test（异常） | AC-R4-2；D2 |

### 4.5 S5 CI 门禁接线（run-ci.mjs 注册可 skip 的 doc 阶段）【P1】
自动化：run-ci.mjs 阶段清单断言 + 坏链注入 + --skip doc。

| ID | 类/优 | 前置条件 | 操作步骤 | 期望结果 / 通过判据 | 自动化 | 追溯 |
| --- | --- | --- | --- | --- | --- | --- |
| TC-S5-01 | 🟢 P0 | coder 合入 run-ci.mjs（含 doc 阶段注册） | `node scripts/ci/run-ci.mjs --only env`（或 `node -e` 读取 STAGES）——先验证阶段清单 | 阶段数组 = 既有六阶段（env/deps/build/test/smoke/stage）**+** doc（共 7 阶段，doc 在末位或按注册序）——AC-R5-4 | node -e（L0） | AC-R5-4；S5 验收 1/4；E1 |
| TC-S5-02 | 🟢 P0 | README+FEATURES 满足 | `node scripts/ci/run-ci.mjs`（全量，宿主/终端；沙箱受限时记录复现步骤） | 新增 doc 阶段 PASS（README+FEATURES 满足时）；无既有阶段失败——AC-R5-4 | run-ci（L0） | AC-R5-4；S5 验收 1；E1 |
| TC-S5-03 | 🟢 P0 | 同 TC-S5-01 | `node scripts/ci/run-ci.mjs --skip doc --only env,test`（或 --only test） | 跳过 doc 阶段且其它既有阶段正常执行不失败（RK-6 日常发布可跳）——AC-R5-4 | run-ci（L0） | AC-R5-4；S5 验收 3；RK-6 |
| TC-S5-04 | 🔴 P0 | 同 TC-S5-02 | 负例：注入坏链接（FEATURES 失效锚点或 README 断链）后 `node scripts/ci/run-ci.mjs --only doc` | doc 阶段 FAIL 且输出定位到具体文件+行（AC-R5-2 语义）；整体 exit ≠ 0；还原后 doc 阶段 PASS——AC-R5-4 | run-ci（负例） | AC-R5-4；S5 验收 2 |
| TC-S5-05 | 🟡 P0 | 同 TC-S5-01 | `node scripts/ci/run-ci.mjs --skip doc` 全量 vs `--only doc` | `--only doc` 只跑 doc 阶段；`--skip doc` 跳过 doc 且在阶段清单输出可见（阶段选择正确）——AC-R5-4 边界 | run-ci（边界） | AC-R5-4；S5 验收 3/4 |
| TC-S5-06 | 🟡 P0 | 同 TC-S5-01 | 失败输出可查性：注入坏链后检查证据文件/输出 | 失败输出进 ci.log / summary.json；summary.json 中 doc 阶段 status=FAIL 且失败计数可查——AC-R5-4 | 评审 | AC-R5-4；S5 验收 2/5 |
| TC-S5-07 | 🔴 P1 | 同 TC-S5-01 | 负例：doc 阶段调用的 check-docs.mjs 缺失/不可执行（临时改名或注入语法错） | doc 阶段 FAIL 且输出含「doc」+ 可读错误（非静默吞错）；其它阶段不受影响——AC-R5-4 异常 | run-ci（异常） | AC-R5-4；E1 |
| TC-S5-08 | 🟢 P1 | 同 TC-S5-01 | 既有阶段不回归：`node scripts/ci/run-ci.mjs --only test`（对照既有 test 阶段） | 既有六阶段选择/执行逻辑不因新增 doc 阶段回归（阶段清单正确；--only/--skip 语义保持）——AC-R5-4 | run-ci（回归） | AC-R5-4；S5 验收 4 |
| TC-S5-09 | 🟡 P2 | 同 TC-S5-01 | 默认接入 vs 可跳：确认 doc 阶段默认接入全量、且 `--skip doc` 有效（RK-6 默认可跳） | 默认全量含 doc 阶段；--skip doc 跳过后其余阶段仍按 `--skip` 参数组合正确执行——AC-R5-4 | run-ci（边界） | AC-R5-4；RK-6 |
| TC-S5-10 | 🔴 P1 | 同 TC-S5-01 | 并发/顺序：doc 阶段在依赖链上位于 S3 之后、且不阻塞其它可并行阶段 | 依赖顺序正确（doc 依赖 check-docs 脚本存在；无循环依赖）；阶段执行顺序为注册序（env→deps→build→test→smoke→stage→doc）——AC-R5-4 | 评审 | S5 验收 4；T-113 §2.1 |
| TC-S5-11 | 🟢 P1 | 同 TC-S5-01 | 零依赖：`git diff` 核对 run-ci.mjs import 区 / package.json | 零新增依赖（复用既有 node: 模块，无第三方）——I-1 | 评审 | I-1；S5 验收 6 |
| TC-S5-12 | 🟡 P2 | 同 TC-S5-01 | doc 阶段输出含「doc」阶段名与 PASS/FAIL 状态 | ci.log / stdout 中含 `[doc] ... PASS/FAIL` 行（可被 grep 断言）——AC-R5-4 | 评审 | AC-R5-4；S5 验收 5 |
| TC-S5-13 | 🔴 P1 | 同 TC-S5-01 | 注入坏锚点后跑 `node scripts/ci/run-ci.mjs --skip doc` | 跳过后 exit 0（不被 doc 阶段卡住）——表明 doc 阶段可跳且不阻塞发布（RK-6 门禁边界） | run-ci（边界/负例） | AC-R5-4；RK-6 |

## 4.x 关键业务规则正反向成对（显式正向 + 反向）

> 下列每条业务规则同时给出正向用例与反向用例（判定语义不依赖单侧证据），对应本批核心行为。

| # | 业务规则（唯一线） | 正向用例 | 反向用例 | 判据 |
| --- | --- | --- | --- | --- |
| BR-1 | 功能索引存在且可用（R-3） | TC-S1-04/05/06（索引 ≥18 行、锚点有效、小节非空） | TC-S1-11/12/14（坏列/失效锚点/空壳 → 断言失败） | `node -e` 0 坏列、0 失效锚点、每域 ≥5 行 |
| BR-2 | 手册状态口径无过程叙事（R-1） | TC-S1-07（状态 ∈ {已上线,迭代中,遗留}，叙事计数 =0） | TC-S1-13（注入 P1/P2 叙事 → 计数 ≠0 失败） | 正则计数 =0 |
| BR-3 | README↔手册互链去重（R-2） | TC-S2-02/03/04（互链 ≥8、锚点有效、无整段重复） | TC-S2-08/10/11（坏锚点/关键项丢失/目标级路径 → 失败） | 锚点 0 失效、≥3 行同文块 =0、关键项不丢 |
| BR-4 | doc-sync 条件化契约（R-4） | TC-S4-01/04（feature 任务追加 docs 契约并登记） | TC-S4-05/06/07/09（非 feature 不追加；feature 缺失 → 停 in_review） | 仅 feature 追加；缺失即停 in_review 提示 |
| BR-5 | 校验脚本零依赖纯 Node（R-5） | TC-S3-02/04（正向 exit 0、仅 node: 内置） | TC-S3-05/06/07（坏链/坏列/断链 → exit ≠ 0 并指向文件+行） | 正向 exit 0；负例 exit ≠ 0 报文件名+行 |
| BR-6 | CI doc 阶段门禁可跳（R-5） | TC-S5-01/02（阶段清单 7 项、全量 PASS） | TC-S5-04/07（坏链/脚本缺失 → doc 阶段 FAIL）；TC-S5-03/13（--skip doc 跳过不阻塞） | 坏链 FAIL；--skip doc 可跳且不卡发布 |
| BR-7 | doc-sync 契约路径 = 仓库相对路径非目标目录（I-2/I-3/RESEARCH §8） | TC-S4-03（路径不被 goalizePrompt 改写） | TC-S4-08（写成目标级目录 → 检出失败） | 路径含 docs/FEATURES.md（非 docs/<goalId>/FEATURES.md） |

## 6. 追溯矩阵（验收标准 → 用例）

| 验收标准（T-111 / T-113） | 覆盖用例 |
| --- | --- |
| AC-R1-1（手册存在、标题语义） | TC-S1-01/02 |
| AC-R1-2（六类章节结构完整） | TC-S1-03/15 |
| AC-R1-3（覆盖对账：18 功能域均有章节） | TC-S1-09 |
| AC-R1-4（可走通抽测：快速开始/模块主路径） | TC-S1-08 |
| AC-R1-5（与现状一致、无过时/过程叙事） | TC-S1-07/13 |
| AC-R2-1（README 与手册去重 0 块） | TC-S2-04/09 |
| AC-R2-2（README→手册互链锚点有效） | TC-S2-02/03/08/11 |
| AC-R2-3（关键信息不丢：三件套/自启/三分钟/排障） | TC-S2-05/10 |
| AC-R2-4（README 可渲染、当前现状口径） | TC-S2-01/06/07/12 |
| AC-R3-1（索引可提取 ≥18 行、0 坏列） | TC-S1-04/10/11、TC-S3-03 |
| AC-R3-2（索引锚点有效 0 失效） | TC-S1-05/12 |
| AC-R3-3（每条功能正文小节 ≥5 行非空） | TC-S1-06/14 |
| AC-R3-4（README↔手册双向引用） | TC-S2-13 |
| AC-R4-1（功能类目标链拆解含 doc-sync 切片/验收项） | TC-S4-01/03 |
| AC-R4-2（未做文档同步 → 停 in_review 有明确提示） | TC-S4-04/06/07/10/11/15 |
| AC-R4-3（试点闭环：功能合入后手册+README+索引同步、CI 校验通过） | §6 端到端（L2/试点，依赖 S1+S2+S4+S5 齐备） |
| AC-R4-4（非功能不误伤：纯重构/测试无 doc-sync 不被卡） | TC-S4-05/09 |
| AC-R4-5（stage.docs 回归、roles 只增字段/项、岗位语义不变） | TC-S4-02/08/12/13/14 |
| AC-R5-1（脚本存在且零依赖可跑、--help） | TC-S3-01/02/04/10 |
| AC-R5-2（坏例注入 exit ≠ 0 报文件+行） | TC-S3-05/06/07 |
| AC-R5-3（覆盖 ≥3 项：README→手册锚点/索引提取/索引锚点） | TC-S3-03 |
| AC-R5-4（CI 门禁接线：PASS/FAIL/可跳） | TC-S5-01..13 |
| S1 机器行（存在/标题/六类/索引/锚点/小节/无叙事/内容承接） | TC-S1-01..15 |
| S2 机器行（互链 ≥8/锚点 0 失效/去重 0 块/关键项不丢/无过程叙事/可渲染） | TC-S2-01..13 |
| S3 机器行（--help/正向 exit 0/负例 exit ≠ 0/覆盖 ≥3/零依赖/可还原） | TC-S3-01..10 |
| S4 机器行（条件化追加/D1 验收项/D3 提示词/AC-R4-1/2/4/5/typecheck/零依赖） | TC-S4-01..15 |
| S5 机器行（doc 阶段 PASS/坏链 FAIL/--skip doc/阶段清单 7 项/零依赖） | TC-S5-01..13 |

## 7. 端到端验收总口径（对应 REQUIREMENTS §6，供将军快速验收）

1. **首版交付验收**：`node -e` 六类章节/索引 ≥18/锚点有效/无叙事通过；README 互链 ≥8/去重 0 块；按手册快速开始走通三分钟循环，抽 3 个功能域按手册复现成功（AC-R1-4/5 人工抽测，tester 代跑并记录）；README 与手册无整段重复（R-1/R-2/R-3 全绿 → TC-S1-01..15、TC-S2-01..13、TC-S3-01..10）。
2. **持续机制验收（试点）**：将军发布一个「用户可见小功能」目标 → 拆解自动带 doc-sync 切片（S4/TC-S4-01），该功能合入时手册+README+索引同步更新，CI doc 阶段校验通过（S5/TC-S5-02），main 上该功能「手册可查、README 有引导」——依赖 S1+S2+S4+S5 齐备后在真实功能目标上验证（归 tester 执行）。
3. **不误伤边界**：一条纯重构任务不被文档要求卡住（TC-S4-05/09）。
4. **缺失提示边界**：故意不做文档同步的任务停在 in_review 且有明确提示，可打回（TC-S4-06/07）。
5. **机器门禁边界**：注入失效链接/坏索引 → 校验脚本失败并指明位置（TC-S3-05/06/07、TC-S5-04）。

## 8. 环境与验证事实（写进执行说明，不冒充通过）

- 本 worktree **无 node_modules/dist**（不随 git 分发）；plugins typecheck（`tsc -p plugins/tsconfig.json --noEmit`）与 S4 流水线闭环（AC-R4-1/2/4 需真实/模拟流水线）按仓库 R-18 惯例记录「环境受限 + 复现步骤」（宿主 junction 后执行），不冒充通过。
- `node scripts/ci/check-docs.mjs` 为纯 Node 直跑，沙箱可跑；`node scripts/ci/run-ci.mjs` 子进程 spawn 在沙箱可能 EPERM（errno -4048），按测试文件头「沙箱受限直跑等效」惯例处理（普通终端/宿主执行）。
- 负例注入（TC-S3-05/06/07、TC-S3-09、TC-S5-04/07）涉及改动 docs/FEATURES.md / README.md / run-ci.mjs，须在注入后**还原**（git checkout 或快照）再跑正向（T-113 §5 纪律）。

## 附录 A 自检脚本（供 runner 一键复核计数/唯一性/类别/优先级/追溯引用）

> 落点建议：docs/G-mtpq729o-1/T114-evidence/machcheck.mjs（T-098 范式）。运行：`node docs/G-mtpq729o-1/T114-evidence/machcheck.mjs > docs/G-mtpq729o-1/T114-evidence/01-doc-machcheck.txt`。
> 本附录给出校验逻辑说明，供 tester/runner 复现；计数/ID 唯一性/表结构/追溯引用完整性以脚本输出为准（本阶段为设计，未执行）。

```js
// 伪代码（与 T-098 machcheck.mjs 同构）：扫描 | TC-S 行，校验
// 1) ID 唯一（无 DUP）；2) 类别码点 ∈ {🟢,🟡,🔴}（无 unknown）；3) 优先级 P0/P1/P2；
// 4) 每片序号连续（01..n），无跳号；5) 追溯列中 TC-Sx-y 引用均为 declared 的 ID（无 danglingRef）。
// 判定：duplicate=0 && unknownCategory=0 && danglingRef=0 → PASS，否则 FAIL。
```

## 附录 B 自动化落点与可照抄骨架（coder/tester 用）

> 本阶段不新增/不预写切片域内可执行测试文件（S1~S5 目标代码未实现；测试文件所有权已由 TASK_BREAKDOWN §1 第 2 段划给各 coder 文件域），只给可照抄骨架。

### B.1 S1/S2 文档机器断言（coder 以 `node -e` 内联，tester 复跑）

```bash
# 存在性 + 标题
node -e "const fs=require('fs');const t=fs.readFileSync('docs/FEATURES.md','utf8');if(!/功能使用介绍|使用手册/.test(t))process.exit(1);console.log('S1 header OK')"
# 索引行数 ≥18 + 0 坏列（5 列）
node -e "const fs=require('fs');const t=fs.readFileSync('docs/FEATURES.md','utf8');const rows=t.split('\n').filter(l=>/^F-[0-9]{2}/.test(l));if(rows.length<18)process.exit(1);for(const r of rows){if(r.split(String.fromCharCode(124)).map(s=>s.trim()).filter(Boolean).length!==5)process.exit(2);}console.log('S1 index rows='+rows.length)"
# 索引锚点 0 失效（提取 -> 全文标题比对）
node -e "const fs=require('fs');const t=fs.readFileSync('docs/FEATURES.md','utf8');const heads=new Set([...t.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m=>m[1].trim()));const rows=t.split('\n').filter(l=>/^F-[0-9]{2}/.test(l));const bad=rows.filter(r=>{const c=r.split(String.fromCharCode(124)).map(s=>s.trim());return !heads.has(c[2]||'');});if(bad.length)process.exit(1);console.log('S1 anchors OK')"
# README 互链 ≥8 + 无过程叙事
node -e "const fs=require('fs');const r=fs.readFileSync('README.md','utf8');const n=(r.match(/docs\/FEATURES\.md#[\w-]+/g)||[]).length;if(n<8)process.exit(1);console.log('S2 links='+n)"
```

### B.2 S3 校验脚本结构（scripts/ci/check-docs.mjs 骨架）

```js
// 仅用 node:fs / node:path / node:url（零第三方）
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
let fails = 0
const check = (ok, msg) => { if (!ok) { fails++; console.error('FAIL: ' + msg) } }
// ... 校验项：索引提取(≥18/0坏列) / 索引锚点(0失效) / README→手册锚点(0失效) / 去重(≥3行同文块=0) / 关键项不丢
if (process.argv.includes('--help')) { console.log('check-docs ... 校验项说明'); process.exit(0) }
check(fails === 0, 'docs 校验')
process.exit(fails === 0 ? 0 : 1)
```

### B.3 S4 机制断言（plugins tests 面，宿主/CI）

```js
// 契约条件化：feature 任务 contracts 含 docs/FEATURES.md + README.md；非 feature 不含
import { resolveStageDocPaths } from '../src/index.ts'   // 或视导出路径调整
const contracts = resolveStageDocPaths({ docs: ['docs/FEATURES.md','README.md'] }, 'T-000')
assert.ok(contracts.includes('docs/FEATURES.md') && contracts.includes('README.md'))
// 提示词注入：buildWorkerPrompt 对 docSync 任务含「请同步 docs/FEATURES.md 对应小节」段
```

### B.4 S5 CI 阶段注册断言（run-ci.mjs 阶段清单）

```js
const expected = ['env','deps','build','test','smoke','stage','doc']
const names = STAGES.map(s => s.name)
const missing = expected.filter(n => !names.includes(n))
if (missing.length) process.exit(1)   // 阶段数组 = 六阶段+doc
```

## 附录 C 关联文档与阅读顺序

- 上游：docs/G-mtpq729o-1/REQUIREMENTS.md（T-111）、RESEARCH.md（T-112）、TASK_BREAKDOWN.md（T-113）。
- 本文件：docs/G-mtpq729o-1/TEST_CASES.md（T-114 用例设计）。
- 下游：docs/G-mtpq729o-1/TEST_REPORT.md（T-117 测试执行）；docs/DEPLOY.md（T-118）。
- 关系：本用例只认定 docs/G-mtpq729o-1/ 目录版本；仓库根 docs/TEST_CASES.md（其他目标/遗留链）无承接关系。

*（本文件由 T-114 测试用例设计士兵产出，仅落在 docs/G-mtpq729o-1/TEST_CASES.md；未改任何仓库实现。）*
