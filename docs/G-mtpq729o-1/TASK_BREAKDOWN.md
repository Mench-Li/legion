<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-06**（commit `7ffa303`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-113 任务拆解：Legion「完整功能使用介绍文档 + 功能/迭代持续自动同步」

> 角色：breaker（任务拆解）｜阶段：任务拆解｜执行任务：T-113（[auto-goal]｜所属目标 G-mtpq729o-1 · software · chain）
> 上游：T-111 需求澄清（docs/G-mtpq729o-1/REQUIREMENTS.md，R-1~R-5 + AC-R* / D-1~D-9 默认值即基线）→ T-112 方案搜索（docs/G-mtpq729o-1/RESEARCH.md，决策 A~F 结论 + §11 切片建议与依赖）
> 下游：守护解析本文件「## slices」注册 coder_Si → tester_Si 微链 → 逐切片开发/测试；阶段链 T-114 用例设计 → T-115 coder → T-116 review → T-117 test → T-118 devops
> 依据：LEGION.md 纪律、本任务验收标准与边界、T-111 REQUIREMENTS §5（AC-R1-1..5 / AC-R2-1..4 / AC-R3-1..4 / AC-R4-1..5 / AC-R5-1..4）、§8 D-1..D-9（默认值即基线）、T-112 RESEARCH §11（5 条切片建议 + 依赖顺序）
>
> **权威基线/命名空间提醒（重要）**：本目标分析文档目录 = docs/G-mtpq729o-1/。仓库根 docs/REQUIREMENTS.md、docs/RESEARCH.md、docs/TASK_BREAKDOWN.md 等根槽位文件属其他目标/遗留链，**禁止读写**。本拆解只写本文（docs/G-mtpq729o-1/TASK_BREAKDOWN.md），不改任何仓库实现；下游 doc-sync 契约文件域统一用**绝对仓库相对路径** docs/FEATURES.md 与 README.md，禁止写 docs/G-mtpq729o-1/FEATURES.md（那是阶段分析文档目录，产品手册长期固定 docs/FEATURES.md，D-2/RESEARCH §8 默认）。
>
> **工作区状态**：docs/G-mtpq729o-1/ 现仅 REQUIREMENTS.md 与 RESEARCH.md，无本文旧版（T-113 本阶段首次产出）。

## 0. 结论速览（TL;DR）

- 拆解产物：**5 个切片（S1~S5）**，文件域互不重叠，按需求分组：
  - **文档组（P0 首版交付物，先）**：S1 功能手册首版 + 功能索引（docs/FEATURES.md）；S2 README 收敛 + 总览导航 + 与手册互链去重（README.md）。
  - **机制组（P0「持续性工作」流程侧核心）**：S4 持续自动更新机制注入点（任务级 feature/docSync 标记 + 条件化契约 D2 + 验收项 D1 + 提示词 D3）。
  - **门禁组（P1 机器校验）**：S3 校验脚本 check-docs.mjs；S5 CI 门禁接线（run-ci.mjs 注册可 skip 的 doc 阶段）。
- 需求全覆盖映射（无遗漏）：R-1→S1、R-3→S1（索引内容）+S3（索引解析/锚点校验）、R-2→S2、R-4→S4、R-5→S3（AC-R5-1/2/3）+S5（AC-R5-4）。
- 全批**零新增运行时依赖**：采纳 A1（纯 Markdown 单文件手册）+ B1（Markdown 表格索引，行首 F-xx）+ C1（自写零依赖 Node 脚本）+ E1（独立脚本 + run-ci 可 skip 的 doc 阶段）+ F1/F3（任务声明 + 索引对账增量检出）。「自动」= 流水线强制 + 机器校验，不做运行期自动生成文档（REQUIREMENTS §4.2 / A-3）。
- **文件域纪律（并行合入安全前提）**：同一文件只允许 1 个切片并发持有。本批 5 片文件域两两不相交（S1=docs/FEATURES.md、S2=README.md、S3=scripts/ci/check-docs.mjs、S4=team-hub/stage-standards.mjs+roles.json+plugins/src/index.ts、S5=scripts/ci/run-ci.mjs）；无同文件串行冲突，后台并发槽位可全部并行（依赖链除外）。

## 1. 机器可读切片清单（守护据此注册并行派工，逐行严格遵循：每行四段用 | 分隔，段内不再出现 |；第 2 段文件逗号分隔；第 4 段验收分号分隔）

## slices
- S1 | 功能手册首版 + 功能索引（docs/FEATURES.md） | docs/FEATURES.md | node -e 读取 docs/FEATURES.md 输出 OK 且 exit 0;标题含「功能使用介绍」或「使用手册」（node 正则断言 =1）;六类章节（一句话定位/面向读者/快速开始/模块章节/功能索引/故障排查与术语附录）各自存在且非空（node 断言每类含 1 个以上 ## 或 ### 标题）;功能索引行数 ≥ 18（node 正则 /^F-[0-9]{2}/ 计数），每条 F 行四段分列 0 坏列（node 用 String.fromCharCode(124) 切分校验 4 列）;索引章节锚点逐个在全文标题存在 0 失效（node 抽取并比对）;索引每条功能对应正文小节 ≥5 行（node 断言）；正文无「P1/P2/P3 切片已交付」式过程叙事（node 正则计数 =0，状态用 已上线/迭代中/遗留）;内容抽自 README §2/§3/§4 并更新到当前行为；零新增依赖
- S2 | README 收敛 + 总览导航 + 与手册互链去重 | README.md | node -e 读取 README.md exit 0;README 含指向 docs/FEATURES.md 的章节互链（node 正则计数 ≥ 8 处）;README 所有指向 docs/FEATURES.md 的锚点链接在 docs/FEATURES.md 中真实存在 0 失效（node 抽取并解析）;README 与 docs/FEATURES.md 逐字重复的 ≥3 行操作步骤段落 = 0（node 行块去重断言）;README §2 快速开始（三件套命令/DSH Desktop 自启/三分钟循环）三项关键内容与 §6 故障排查全部行在 README 或手册之一存在（node 逐项断言，迁移项含互链）;README 为「当前产品现状」口径，P0-P3/T-0xx 过程叙事收敛到 docs/P*-LIVE-ROLLOUT 并在附录互链（node 断言正文无新累积过程叙事）;README 结构/表格可渲染（既有 doc-render 或结构断言）;零新增依赖
- S3 | 文档新鲜度校验脚本 check-docs.mjs | scripts/ci/check-docs.mjs | node scripts/ci/check-docs.mjs --help 输出用法说明且 exit 0;node scripts/ci/check-docs.mjs（当前 README+FEATURES 满足时）exit 0;负用例：向 docs/FEATURES.md 注入一个失效锚点链接后 node scripts/ci/check-docs.mjs exit ≠ 0 且报错含文件与锚点行;覆盖项 ≥ 3：README→手册锚点（AC-R2-2）/索引提取（AC-R3-1）/索引锚点（AC-R3-2），另 AC-R2-1 段落去重与 AC-R2-3 关键项以脚本或人工清单二选一;脚本仅用 node:fs/re/path，无 node_modules 依赖（零第三方依赖）;负例注入后文本可还原（git checkout 或快照）
- S4 | 持续自动更新机制注入点（任务级 feature/docSync 标记 + 条件化契约 D2 + 验收项 D1 + 提示词 D3） | team-hub/stage-standards.mjs, roles.json, plugins/src/index.ts | 为 feature/docSync 类任务在契约路径追加 docs/FEATURES.md + README.md（D2 条件化，非 feature 不追加，AC-R4-4）;stage-standards 为 coder/devops 增加「用户可见行为变更须同步功能手册 + README」机器验收项（D1，只加项不改岗位语义，AC-R4-5 语义）;buildWorkerPrompt 在 docSync 任务提示词追加「请同步 docs/FEATURES.md 对应小节 + 功能索引 + README 引导段」（D3）;AC-R4-1：按现状生成一条功能类目标链，其拆解产物存在显式文档同步切片或带 doc-sync 验收项任务（文件域含 docs/FEATURES.md 或 README.md）;AC-R4-2：模拟某功能任务未做文档同步直接提交 → 停 in_review 且有「需同步功能文档」类提示;AC-R4-4：一条纯重构/测试类任务链无 doc-sync 要求且流程不被卡;AC-R4-5：既有 stage.docs 产物登记/预览（T-107）不回归，roles.json 仅新增字段/模板，岗位职责语义不变;插件/服务 typecheck 0 诊断（环境受限时如实记录复现步骤）;零新增运行时依赖
- S5 | CI 门禁接线（run-ci.mjs 注册可 skip 的 doc 阶段） | scripts/ci/run-ci.mjs | node scripts/ci/run-ci.mjs 全量时新增 doc 阶段 PASS（README+FEATURES 满足，AC-R5-4）;注入坏链接后 node scripts/ci/run-ci.mjs 的 doc 阶段 FAIL;node scripts/ci/run-ci.mjs --skip doc 跳过 doc 阶段且其余既有阶段不失败;run-ci 阶段清单 = 既有六阶段 + doc（node 断言阶段数组）；失败输出可查（证据文件/输出要点）;零新增依赖

## 2. 依赖关系、执行顺序与并行（给人看）

### 2.1 blockedBy 一览（注册顺序 = 派工顺序；本批无同文件硬串行，仅内容/校验依赖）

| 切片 | blockedBy | 依赖理由 | 工作量 |
| --- | --- | --- | --- |
| S1 | 无（行内起点） | 功能手册是全批其余片的内容/锚点基准，且为全新文件，无前置 | L |
| S2 | S1（手册定稿章节锚点后互链才稳定；去重断言需两文件并存） | README 互链指向手册锚点、去重/关键项断言依赖手册存在；S1 先定锚点结构 | M |
| S3 | S1 + S2（校验对象为 README+FEATURES 两文件，须两者都成文） | check-docs 的 AC-R5-1 要求「当前文档满足时 exit 0」，须有真实 README+FEATURES 方可完成正向用例；与 S1/S2 不同文件 | M |
| S4 | 无（机制为独立配置/契约注入，可并行） | 只新增字段/项/文本与条件化契约逻辑，不依赖手册成文即能实现与 AC-R4-1/2/4 验证；与 S1~S3/S5 文件域不相交 | L |
| S5 | S3（run-ci 接线须引用 check-docs 脚本，脚本须先存在） | doc 阶段调用 scripts/ci/check-docs.mjs，脚本未成文则接线无对象；与 S3 不同文件 | S |

**无循环依赖**：依赖沿「手册/内容 → 校验 → 接线」与独立机制两条方向，无回边。

### 2.2 执行顺序与并行建议

- **默认安全路径（当前生产守护单 worker，按注册顺序派工）**：S1 → S2 → S3 → S4 → S5。注册顺序即派工顺序，已按依赖拓扑排好。
- **若将军提升并发槽位（maxWorkers ≥ 2）**：因本批文件域两两不相交，除下述依赖链外全部可并行：S1 先行；S2 依赖 S1；S3 依赖 S1+S2；S5 依赖 S3；S4 无依赖可随时并行。可并行组合示例：{S1, S4}、{S2, S4}、{S3, S4}、{S5, S4}。S4 是唯一可全程并行跑在后台的切片。
- **共享文件警示（RR-6/RK-2）**：S4 改动的 team-hub/stage-standards.mjs、roles.json、plugins/src/index.ts 为多目标共用；本文机制只新增字段/项/文本，不改岗位职责语义（AC-R4-5）。若与在途其他目标同改，交由既有 mediator 合入调解。
- **文档级共享说明**：README.md 在 S2 中为唯一持有切片（S2 专属文件域），不与其它切片二次持有；S1 手册含的「修订记录/关联文档」若需提及 README 尾部附录，由 S2 统一成文，避免双写。

### 2.3 D4（breaker 默认 doc-sync 切片）约定——本文件作为机制设计载体

- R-4 的 D4「breaker 拆解模板默认注入 doc-sync 切片」属**拆解约定/流程规范**（此为 C3 说明层 + D1 机器验收兜底）：**后续任何「用户可见功能迭代」类目标（feature 类）在 breaker 拆解时，默认附一个独立的「文档同步」切片**（文件域 = docs/FEATURES.md + README.md 对应段），其验收项对齐 R-4 的 AC-R4-1/3；非 feature 目标不强制。本文即把该约定与机器化底座（S4）一并落地，供将军与后续目标参照。本文自身的 5 片是「建造文档系统」的切片，非该约定的试点目标（试点须另设用户可见功能目标，见 §4）。

## 3. 子任务明细（每切片 = 一个士兵一轮可完成并验收；「验收」以 §1 机器行逐条为准；工作量刻度 S ≈ 0.5 轮 ｜ M ≈ 1 轮 ｜ L ≈ 1 轮满）

#### S1 功能手册首版 + 功能索引【P0 · docs/FEATURES.md · 行内起点】
- **目标**：按 RESEARCH A1/B1 产出 docs/FEATURES.md（零依赖中文 Markdown 单文件功能手册）：结构 = 一句话定位 / 面向读者(新手将军与后续 AI 任务) / 快速开始(启动三件套/DSH Desktop 自启/三分钟体验循环，承接 README §2) / 分模块章节(按 REQUIREMENTS §2.5 的 18 功能域各一节) / 功能索引(R-3，独立小节固定表格：每行 = F-xx | 功能名 | 章节锚点 | 入口 | 状态(已上线/迭代中/遗留)) / 故障排查 / 术语与附录(含与 README/workbench-README/scrum-README/PLUGINS/DEPLOY 的关联关系)。内容从 README §2/§3/§4 抽取整理并更新到当前行为，去掉「P1/P2/P3 已交付」式过程性叙述。
- **产出（文件域）**：docs/FEATURES.md（新建，本切片专属，不与任何切片共用）。
- **依赖**：无（行内起点）。**工作量**：L。**完成 =（DoD）**：§1 S1 行逐条有真实命令输出为证（存在性 / 标题含「功能使用介绍」/ 六类章节非空 / 索引 ≥18 行且 0 坏列 / 锚点 0 失效 / 每域小节 ≥5 行 / 无过程叙事）= 完成；无需动 README 与任何代码。
- **测试锚点（test-designer 直转）**：索引正则可提取性（F-[0-9]{2} 计数 ≥18）、索引四列结构校验、锚点有效性与正文小节非空断言、六类章节标题存在性、README 期望信息在手册中的承接关系。
- **纪律**：只写 docs/FEATURES.md；手册面向「使用」不写内部架构/源码导读；不新增依赖；文档路径用 docs/FEATURES.md（勿写目标级目录）。

#### S2 README 收敛 + 总览导航 + 与手册互链去重【P0 · README.md】
- **目标**：按 RESEARCH A1/B1 与 REQUIREMENTS R-2：README.md 收敛为「产品总览 + 快速开始 + 模块导航 + 关联文档入口」——保留 §1 组件表 / §2 快速开始 / §3 模块导航级介绍(每模块一段引导 + 指向手册对应章节的互链) / §6 排障关键项 / 附录；把逐步操作细节迁移到手册（不删除，只迁移+互链），消除两处全文复制的操作步骤段落；历史/过程叙事(P0-P3、T-0xx)收敛到 docs/P*-LIVE-ROLLOUT 等记录文档并在附录互链。
- **产出（文件域）**：README.md（本切片专属，不与任何切片共用）。
- **依赖**：S1（手册定稿章节锚点后互链稳定；去重断言需两文件并存）。**工作量**：M。**完成 =（DoD）**：§1 S2 行逐条有真实命令输出为证（互链 ≥8 处 / 锚点 0 失效 / 去重 0 重复块 / 关键项不丢 / 无过程叙事累积 / 可渲染）= 完成。
- **测试锚点**：README→手册锚点解析、≥3 行逐字重复块检测、快速开始三件套命令与 DSH Desktop 自启与三分钟循环关键串保留、故障排查表全部「现象」行主题仍在二文件之一、表格渲染结构完好。
- **纪律**：只迁移不删除（REQUIREMENTS R-2 scope out）；不把手册整段复制回 README；不新增第三份重复文档；只改 README.md。

#### S3 文档新鲜度校验脚本 check-docs.mjs【P1 · scripts/ci/check-docs.mjs】
- **目标**：按 RESEARCH C1/E1：新增零依赖 Node 脚本 scripts/ci/check-docs.mjs（仅 node:fs/re/path；machcheck 风格），实现结构/链接/索引一致性校验：README→手册锚点有效性(AC-R2-2)、功能索引提取与列数校验(AC-R3-1)、索引锚点有效性(AC-R3-2)，并覆盖 AC-R2-1 段落去重与 AC-R2-3 关键项(脚本或人工清单二选一)；--help 说明；坏例注入时 exit ≠ 0 且报错含文件+行；当前文档满足时 exit 0。
- **产出（文件域）**：scripts/ci/check-docs.mjs（新建，本切片专属）。
- **依赖**：S1 + S2（校验对象为 README+FEATURES，两者成文方可跑正向用例）。**工作量**：M。**完成 =（DoD）**：§1 S3 行逐条有真实命令输出为证（正向 exit 0 / 坏例 exit ≠ 0 且指向具体文件+行 / 覆盖 ≥3 项 / --help / 零 node_modules 依赖）= 完成。
- **测试锚点**：为 test-designer 提供坏锚点/坏索引/断链的注入用例素材；输出到具体文件与行号。
- **纪律**：零依赖纯 Node；不联网、不装依赖；只判结构/链接/索引一致，不判语义（R-5 scope）。

#### S4 持续自动更新机制注入点【P0 · team-hub/stage-standards.mjs + roles.json + plugins/src/index.ts】
- **目标**：按 RESEARCH D1/D2/D3 组合落地「文档同步」机器强制底座：1) D2 条件化 stage.docs 契约——为 feature/docSync 类任务在契约路径追加 docs/FEATURES.md + README.md（注册到该任务 contracts，结算自动登记 + 缺失即停 in_review 提示；非 feature 不追加，AC-R4-4）；2) D1 stage-standards 为 coder/devops 增加「用户可见行为变更须同步功能手册 + README」机器验收项（只加项不改岗位语义，AC-R4-5）；3) D3 buildWorkerPrompt 在 docSync 任务提示词追加「请同步 docs/FEATURES.md 对应小节 + 功能索引 + README 引导段」；4) 任务级 feature/docSync 标记的声明/写入口径对齐 F1（拆解时声明，机器不猜）。涉及改动：stage-standards.mjs「acceptance 数组」/ roles.json「stage.docs 契约（条件化挂 docSyn」/ plugins/src/index.ts「registerContractDocs 条件注册 + buildWorkerPrompt 提示词段」。
- **产出（文件域）**：team-hub/stage-standards.mjs、roles.json、plugins/src/index.ts（三文件本切片专属，不与任何切片共用）。
- **依赖**：无（机制为独立配置/契约注入，可并行于 S1/S2/S3/S5）。**工作量**：L。**完成 =（DoD）**：§1 S4 行逐条有真实命令输出为证（生成功能类目标拆解含 doc-sync 切片 / 未做文档同步任务停 in_review 有明确提示 / 纯重构不被卡 / T-107 产物登记预览不回归 / 类型诊断 0 / 零新增依赖）= 完成。
- **测试锚点（依赖宿主流水线）**：AC-R4-1/2/4 需在真实或模拟流水线跑通；typecheck 0 诊断；roles.json/plugins 改动的回归断言（既有 worker 套件）。
- **纪律**：只增字段/项/文本，不改岗位职责语义（AC-R4-5）；doc-sync 契约文件域用绝对仓库相对路径 docs/FEATURES.md + README.md（RESEARCH §8），勿写目标级目录；零新增依赖；环境受限时如实记录复现步骤不冒充通过。

#### S5 CI 门禁接线（run-ci.mjs 注册可 skip 的 doc 阶段）【P1 · scripts/ci/run-ci.mjs】
- **目标**：按 RESEARCH E1：在 scripts/ci/run-ci.mjs 的既有六阶段（env/deps/build/test/smoke/stage）基础上新增可跳过的 doc 阶段（调用 S3 的 scripts/ci/check-docs.mjs）；支持 --skip doc 以满足 RK-6（日常发布可跳）；默认接入全量时 PASS/FAIL 正确反映（注入坏链接 → FAIL，全绿 → PASS）。
- **产出（文件域）**：scripts/ci/run-ci.mjs（本切片专属，不与任何切片共用）。
- **依赖**：S3（脚本须先存在）。**工作量**：S。**完成 =（DoD）**：§1 S5 行逐条有真实命令输出为证（doc 阶段 PASS / 坏链 FAIL / --skip doc 可跳 / 阶段清单 = 六阶段+doc / 零新增依赖）= 完成。
- **测试锚点**：run-ci 阶段列表断言、--skip/--only 开关与既有阶段不回归、失败输出定位到具体文件+行。
- **纪律**：零新增依赖；不改既有阶段语义；输出证据可查（证据文件/输出要点）。

## 4. 需求 / 方案 / 切片对照（无遗漏自检）

| 需求（T-111 REQUIREMENTS §5，AC 口径） | 覆盖切片 | 方案落点（T-112 RESEARCH） |
| --- | --- | --- |
| R-1（P0）功能手册首版：AC-R1-1/2/3 | S1（手册结构/覆盖/索引）；AC-R1-4（可走通抽测）与 AC-R1-5（与现状一致 0 不符）由手册内容支撑、在 T-117 测试/将军抽测阶段实跑 | A1（docs/FEATURES.md 纯 MD 单文件） |
| R-2（P0）README 收敛 + 互链去重：AC-R2-1/2/3/4 | S2（互链/去重/关键项/可渲染）；机器化子集由 S3 校验（AC-R5-3） | A1 + R-2 scope（收敛为总览/入口） |
| R-3（P0）功能索引：AC-R3-1/2/3/4 | S1（索引内容与格式）+ S3（提取/锚点校验）+ S2（README↔手册双向引用 AC-R3-4） | B1（Markdown 表格索引，行首 F-xx） |
| R-4（P0）持续自动更新机制：AC-R4-1/2/3/4/5 | S4（机制注入点，覆盖 AC-R4-1/2/4/5）；AC-R4-3（试点闭环）为跨切片端到端，须 S1+S2+S4+S5 齐备后在真实功能目标上验证（归 T-114 用例 / T-117 测试） | D1+D2+D3+D4 组合 + F1/F3 触发判定 |
| R-5（P1）文档新鲜度机器校验：AC-R5-1/2/3/4 | S3（AC-R5-1/2/3）+ S5（AC-R5-4 CI 接线） | C1（machcheck 风格零依赖脚本）+ E1（run-ci 注册可 skip 的 doc 阶段） |
| 全局：零新增运行时依赖 | 全切片纪律（每片零新增依赖断言） | RESEARCH §9 结论（0 运行时依赖） |

**D 系列默认采纳**（T-111 §8，将军未否决即基线）：D-1 对象 = Legion 平台用户可见面；D-2 手册路径 docs/FEATURES.md；D-3 双文档结构（README=总览 + 手册=细节）；D-4 保障强度 = 流程契约(R-4) + 机器门禁(R-5) 都做；D-5 触发口径 = 用户可见行为变化，纯重构/测试除外（如将军翻转，仅 S4/S5 与 doc-sync 契约范围调整）；D-6 基线 = §2.5 草案、粒度=功能域级、不做源码自动提取；D-7 v1 遗留纳入「遗留与迁移」一章；D-8 中文 Markdown 单文件；D-9 首版与机制同批交付（本文按此拆解，S1/S2 文档组 + S3/S5 门禁组 + S4 机制组并行推进）。

## 5. 边界、风险与假设（breaker 视角）

- 🚫 本拆解不写实现、不改需求语义与方案结论；范围以 T-111 REQUIREMENTS R-1~R-5 为准，不拆 out-of-scope 内容（不做运行期自动生成文档/不做多语言/网页版/截图集/不做源码自动提取入口/不新增第三方依赖）。
- 🚫 不拆出无法验收的悬空任务：每片 DoD 与 §1 机器行逐条对应 AC；文档组/机制组/门禁组均有明确存在性与可校验口径。
- ⚠️ 风险 RK-1（README 去重动主文档）：S2 只迁移不删除 + 互链；RK-2/RR-6（README/roles.json/plugins 共享文件跨目标冲突）：文件域隔离 + mediator 合入调解 + 只增字段/项；RK-3（触发判定主观）：F1 任务声明 + F3 索引对账兜底；RK-4（机制停留散文）：S4 机器验收 + S3/S5 门禁兜底；RK-5（完整性枚举漏功能）：§2.5 基线 + 索引 + 抽测 + 打回闭环；RK-6（CI 门禁误伤发布）：doc 阶段默认可 --skip doc（S5）/ 只判结构链接不判语义（S3）。
- ⚠️ 命名空间红线（RESEARCH §8）：doc-sync 契约字段一律写绝对仓库相对路径 docs/FEATURES.md 与 README.md；若将军改手册路径（D-2 备选），仅需同步该常量/契约字段，不影响本拆解机制结论。
- ℹ️ 环境与验证事实：本 worktree 无 node_modules；plugins/workbench 的 typecheck/build 需宿主或安装环境，下游如实记录受限与复现步骤（仓库 R-18 惯例）；node --test 子进程 spawn 在本沙箱可能 EPERM（errno -4048），按测试文件头注释「沙箱受限直跑等效」验证。S3 负例注入涉及改动 docs/FEATURES.md，须在注入后还原（git checkout 或快照）再跑正向。

## 6. 端到端验收总口径（供将军快速验收，对应 REQUIREMENTS §6）

1. **首版交付验收**：docs/FEATURES.md 目录完整、功能索引在、README 收敛并互链；按手册快速开始走通三分钟循环，抽 3 个功能域按手册复现成功；README 与手册无整段重复（R-1/R-2/R-3 全绿）。
2. **持续机制验收（试点）**：将军发布一个「用户可见小功能」目标 → 其拆解自动带文档同步切片（R-4），该功能合入时手册+README+索引同步更新，CI 文档校验通过（R-5），main 上该功能「手册可查、README 有引导」。
3. **不误伤边界**：一条纯重构任务不被文档要求卡住（AC-R4-4）。
4. **缺失提示边界**：故意不做文档同步的任务停在 in_review 且有明确提示，可打回（AC-R4-2）。
5. **机器门禁边界**：注入失效链接/坏索引 → 校验脚本失败并指明位置（AC-R5-2）。

*（本文件由 T-113 任务拆解士兵产出，仅落在 docs/G-mtpq729o-1/TASK_BREAKDOWN.md；未改任何仓库实现。）*
