# T-116 代码审查报告（review）——「生成完整功能使用介绍文档 + 功能/迭代持续自动同步」

> 审查对象（本任务 = coder 任务 T-115 已合入主分支交付的独立代码审查）：
> - 目标 G-mtpq729o-1「生成完整功能使用介绍文档，并作为持续性工作，每当有新功能或功能迭代自动更新该文档+README」；
> - 被审交付（提交 f0261fc → 87ccc1e → ce87364，现全部在 HEAD=ce87364）：**S1** 新增 `docs/FEATURES.md` 功能使用手册（~282 行）；**S2** README 收敛互链去重；**S3** 新增 `scripts/ci/check-docs.mjs` 文档新鲜度机器校验；**S5** `scripts/ci/run-ci.mjs` 接入 doc 阶段；**S4** `plugins/src/index.ts` 的 registerContractDocs/docSync 契约块（1196-1236）、buildWorkerPrompt 提示词段（1385-1390）、`team-hub/stage-standards.mjs` 的 coder/devops 验收项（102/148）。
> - 审查方式：**只读**。对 HEAD 中的最终形态逐一正读（FEATURES.md / README.md / check-docs.mjs / run-ci.mjs / plugins registerContractDocs+settle 门禁 / buildWorkerPrompt / stage-standards / roles.json / 契约纯函数）+ 静态走查（文档互链锚点展开核对、契约软门禁可达性、docSync 全链路接线、判定边界）。**未运行仓库任何脚本/CI、未执行 git、未修改任何源码/脚本文件**；唯一产物 = 本审查文档 `docs/review/T-116-REVIEW.md`。
> - 结论分级：**P0 阻断** / **P1 必须修改** / **P2 建议优化**。本批无 P0，存在 **1 项 P1 + 9 项 P2**（详见 §2）。

---

## 0. 验证与证据评估

| 环节 | 审查方式 | 结果 |
| --- | --- | --- |
| S1 FEATURES.md | 全文正读（282 行） | 完整、非占位；17 个模块节 + F-01..F-18 索引 + §5 故障排查/术语附录（详 §1-S1） |
| S2 README.md | 全文正读（177 行），逐一展开互链锚点与 FEATURES 标题比对 | 互链有效、无死链；存在近义重复与章节号错位（§2-P2-2 / P2-3） |
| S3 check-docs.mjs | 全文正读（203 行），静态走查 8 类校验逻辑与边界 | 逻辑成立、正反例有据；评价与提示词/判定口径有 1 项 P2（slug 一致性） |
| S5 run-ci.mjs doc 阶段 | 全文正读 stageDoc（332-338）+ STAGES（341-349）+ CLI 解析（40-53） | 门禁真实接入；`--only/--skip` 过滤正确；存在可 `--skip doc` 绕过（§2-P2-10，低） |
| S4 doc-sync 契约 | plugins registerContractDocs（1196-1236）+ settle 门禁（1636-1654）+ buildWorkerPrompt（1385-1390）+ stage-standards（102/148）+ roles.json（coder 41-44 无 docs / devops 61-65） | 条件化追加、提示词、验收项三者齐全；但**机械强制「漏更即停」对 docSync 任务不可达**（§2-P1-1），且插件侧改动**无真实测试**（仅有 scratch 仿真，§2-P2-8） |
| 运行证据 docs/G-mtpq729o-1/T115-evidence/ | 逐份读 01-07 + README | S3/S5 证据真实有力（正反例齐）；S4 证据为「语法诊断=0 + 复刻仿真」，强度弱于真跑（详 §0.1） |

### 0.1 证据强度注记
- **S3/S5 证据扎实**：01（check-docs 正向 PASS + --help）、03（run-ci `--only doc` PASS / `--skip doc --only env` PASS）、04（坏内联锚点/坏索引列/README断链 → exit 1 且报**文件:行**，还原后 PASS）、07（坏链 → run-ci doc 阶段 FAIL exit=1，还原后 PASS）——正反两条都走了机器并带行号，可信。
- **S4 证据偏弱**：证据 README 自己已如实登记「完整 tsc -p plugins 无法在沙箱运行（无 node_modules/peerDeps、禁网装），按 R-18 记录复现步骤，不冒充通过」。plugins 侧的 registerContractDocs/docSync 改动**只用 TypeScript 语法解析（parseDiagnostics=0）验证 + scratch 仿真**。而 `scratch/s4-docsync-sim.mjs` 是**复刻（copy）逻辑的可执行脚本**（读 roles.json + 自实现 stageContractDocs/settleContractPaths，未 import 真实 plugins 代码），且它只覆盖「路径追加（AC-R4-1/4）、幂等、路径命名空间」——**未覆盖 AC-R4-2（漏更即停）**，也未验证真实代码行为。结论：S4 的「机制接线」成立，但「机器强制行为」未被证明，且我静态走查发现其不可达（§2-P1-1）。
- **S1/S2 验证**：evidence 02 显示 `node scratch/verify-docs.mjs`（pass=25/fail=0）——这也是 scratch 脚本，非入库测试；但 S1/S2 交付物是文档本体，其正确性由本审查直接正读判定（见 §1-S1/S2），不依赖该脚本强度。

---

## 1. 验收口径逐条核对

> 对照目标 R-1..R-5 / AC-R1-x..R5-x、TASK_BREAKDOWN 的 S1..S5 机械验收行、TEST_CASES 的 TC-Sx-xx 逐条核对。结论 = 通过 / 部分通过 / 不通过，均附依据。

| # | 口径 | 结论 | 依据 |
| --- | --- | --- | --- |
| S1 / AC-R1-1,3,4（完整功能使用手册） | **通过** | docs/FEATURES.md 是面向使用者的操作手册而非占位：§0 一句话定位、§1 面向读者、§2 快速开始（2.1 三件套 / 2.2 DSH Desktop 自动启停 / 2.3 三分钟体验循环）、§3 按模块的 17 个小节（3.1..3.17），每节统一含「入口 / 功能 / 操作步骤 / 期望结果 / 相关设置与边界」，§4 功能索引（F-01..F-18，5 列 + 状态枚举），§5 故障排查 + 术语表 + 关联文档。模块内容与 README §3 模块导航**一一对应**（明细 3.2 编队、3.4 任务详情审计、3.5 目标状态/version、3.7 守护流水线、3.8 模型档位、3.9-.14 三中心+规范/技能/日历通知、3.15 审计、3.16 接口、3.17 v1）。**非半成品/未写「待补」类占位**。 |
| S2 / AC-R2-1..2,3（README 收敛互链去重） | **通过（1 项 P2）** | README 收敛为「总览 + 快速开始 + 模块导航 + 关联文档入口」，全文约 12 处 `docs/FEATURES.md#<锚点>` 互链，我逐一对 featurE 标题展开比对**全部命中真实标题**（如 `#23-三分钟体验循环`←`### 2.3 三分钟体验循环`、`#38-模型-智能体配置`←`### 3.8 模型 × 智能体配置`、`#316-team-hub-数据与接口一览`←`### 3.16 team-hub 数据与接口一览`），无死链。README 顶部显式声明「细节以手册为准并互链去重」。**P2**：README §4「team-hub v2 一览」与 FEATURES §3.16 存在大段近义重复（存储/写纪律/状态机/接口域），未构成 >=3 行逐字块故 check-docs 不报，但与「去重」口径相悖（§2-P2-2）。 |
| S3 / AC-R3-1..3、AC-R5-2、BR-1..3（check-docs 机器校验） | **通过（1 项 P2）** | check-docs.mjs 零第三方依赖（仅 node:fs/re/path），8 类校验：索引行数>=18/5 列/状态枚举、索引锚点=真实标题、正文>=5 行且含「入口/操作」、README→手册互链锚点 0 失效、>=3 行逐字块=0、关键项不丢（三件套/DSH Desktop/三分钟循环）、无过程叙事（P1/P2/P3·已交付 / Sx·已交付=0）、内联锚点=[t](#a) 锚点必须真实。判定逻辑经我逐分支走查：坏索引列/坏锚点/断链均会 FAIL 并带**文件:行**（evidence 04/07 佐证）；无误杀。**P2**：校验器用**自有 slugify** 与标题比对，未验证与 GitHub/渲染端 slug 一致性（§2-P2-1）；内联锚点校验当前空转（§2-P2-6）。 |
| S5 / AC-R5-4（CI 门禁） | **通过（1 项低 P2）** | run-ci.mjs 新增 stageDoc（332-338）调 check-docs.mjs 并以 exit code 判定，纳入默认 STAGES（341-349）。doc 阶段**默认必跑**（非 --only/skip 白名单内默认全部执行），坏链负例被证 exit=1 拦截（evidence 07）。**P2**：可通过 `--skip doc` 跳过（§2-P2-10，低；标准逃生口，非缺陷但需注明「发布门禁须用无 skip 形式」）。 |
| S4 / AC-R4-1,2,4,5（doc-sync 契约/提示词/验收项） | **部分通过（1 项 P1）** | 三要素齐全：**① D2 条件化追加**——registerContractDocs(1200-1202) 与 settle 门禁(1638-1640) 在 `t.docSync===true` 时把 `docs/FEATURES.md`+`README.md` 追加进契约路径，且非 docSync 不追加（AC-R4-4，I-4）；追加路径为仓库相对路径、不被 goalizeContractPath 改写到目标目录（FEATURES/README 不在 GOAL_DOC_NAMES，471-476 不改写，AC-R4 的 I-2/I-3）。**② D1 验收项**——stage-standards coder(102)/devops(148) 增加「用户可见行为变更（feature/docSync）须同步功能手册 + 功能索引 + README 引导段；纯重构豁免」（只加项不改岗位语义，AC-R4-5）。**③ D3 提示词**——buildWorkerPrompt(1385-1390) 对 docSync 任务注入「请同步 docs/FEATURES.md 对应小节 + §4 功能索引 + README 引导段」。**P1**：机械强制「漏更即停」（AC-R4-2）对 docSync 任务**不可达**（§2-P1-1）——这正是「持续自动更新保证」的核心缺口。 |
| 环境/零依赖/语法 | **通过** | check-docs.mjs / run-ci.mjs 零新增运行时依赖；plugins 改动仅新增 `docSync?: boolean \| null` 字段 + 条件追加/注入，逻辑归一致；roles.json 仅新增 docs 字段（+ 保留 artifact），不改变 Gate/prompt 语义。语法 parseDiagnostics=0（evidence 06）。完整 `tsc -p plugins` 因沙箱缺 node_modules/peerDeps 无法复跑（R-18，如实登记，非通过结论）——与 T-108 同类环境受限一致。 |

---

## 2. 结论分级与问题清单

### 2.1 必须修改（P1）

**P1-1【高】doc-sync 的机械强制「漏更即停」（AC-R4-2）对 docSync 任务不可达，内容新鲜度无任何机器校验**

- **位置**：plugins/src/index.ts —— `registerContractDocs`（1196-1236，尤其 1200-1202 追加 FEATURES/README + 1213-1215 判缺）与 settle 软门禁（1646-1652）；`roles.json` coder（41-44，**无 docs**）/ devops（61-65，docs=docs/DEPLOY.md）；`check-docs.mjs`（只判结构/互链/索引，无「新功能是否写入手册」判定）；对照 TASK_BREAKDOWN（行 28）与 TEST_CASES（行 192）的 `AC-R4-2`。
- **问题**：软门禁**只判文件存在性 `existsSync`**。而对 docSync 任务追加进契约的是 `docs/FEATURES.md` 与 `README.md`——这两个文件在 S1 一旦建立便**恒存在**，因此：
  1. **对一个 coder docSync 任务**（coder 无 stage.docs，契约路径 = 追加后的 [FEATURES, README]），missing 恒为空 → 软门禁**永不触发** → 工人「完全没动手册」也能直接 done 并 autoPromote，无任何「需同步功能文档」提示。
  2. **对 devops docSync 任务**，契约 = [docs/DEPLOY.md, FEATURES, README]，三者均已在仓存在 → 同样 missing 恒空，恒定放行。
  3. **check-docs 只判结构自洽**（锚点/索引列数/无逐字块），**不判「新功能是否多了一条 F-xx/新增小节」**——一个「声明了 docSync 却完全未更新手册」的改动照样过 CI。
  - 于是目标 AC-R4-2 设计的「功能任务未做文档同步直接提交 → 停 in_review 并有提示」这一**机器强制底座在当前实现下对 docSync 任务不可达**；契约追加对「无既有新文档槽位」的 docSync 任务而言，仅在任务审计里多登记了 FEATURES/README 两个**本来就在**的产物（可见性价值），**不带来新鲜度强制力**。
  - 印证：`scratch/s4-docsync-sim.mjs`（evidence 05）只覆盖 AC-R4-1/4 + 幂等 + 路径命名空间，**未覆盖 AC-R4-2**；`plugins/tests/*.mjs` 中**无任何 docSync/FEATURES 相关用例**（grep 为零），即 AC-R4-2 既未被仿真也未入库验证，且静态走查证明其不可达。
- **修改建议**（择一或组合，按目标口径取舍）：
  1. **给 docSync 任务加「diff 非空」机器校验**：settle 时对比 FEATURES.md/README.md 相对**基线**（上一成功 docSync 或最近 promote 的 HEAD）存在**非空 diff**，否则停 in_review 并提示「需同步功能文档（AC-R4-2）」。这是最直接地把「漏更即停」落到 docSync 任务的改法。
  2. **check-docs 增补「新鲜度基线」**：维护/比对功能索引行数或新增小节白名单（如把「功能性变更应新增 F-xx」纳入判定），使 CI 对「漏更」也能拦截。
  3. 若目标口径确认为「**结构门禁 + 提示词义务**即达标，不要求机器证明内容被更新」，则应在契约/文档中**明示该口径**并补一条 AC-R4-2 的**可达前提说明**（例如 docSync 仅对「存在新文档槽位」的阶段有效），避免将军误以为机制能拦漏更。
  - 无论哪种口径，建议**补一条真实复现 AC-R4-2 的用例**（用真实 plugins 逻辑而非复刻脚本），避免本缺口再次被无测试掩盖。

### 2.2 建议优化（P2）

**P2-1【中】check-docs 用自有 slugify 判定锚点，未验证与渲染端（GitHub 风格）slug 一致性——「自洽」≠「真实可达」**
- 位置：check-docs.mjs slugify（80-86）与 headSlug 构建（93-96）、README→手册互链判定（143-155）。
- 问题：`slugify` 是自有实现（去特定标点 + 保 `\w`/汉字/空格/连字符 + 空格转 `-`）。它对 README 锚点与 FEATURES 标题**在同一 slug 空间内自洽**（故 check-docs 绿），但若该空间与真实渲染端（Markdown 渲染器 / GitHub slugger）存在标点处理差异，则「CI 绿 ≠ 界面上锚点真的能跳转」。我对其余当前锚点逐一按 GitHub 习惯展开均命中（如 `2.3 三分钟体验循环`→`23-三分钟体验循环`），故**当前无实际断链**，但校验器本身给不出「与渲染端一致」的保证。
- 建议：用一个与渲染端逐字对齐的 slug 契约（或直接对齐 GitHub slugger 规则），并在 check-docs 尾部补几条「中文/标点/多空格」锚点用例以固化。

**P2-2【中】README §4「team-hub v2 一览」与 FEATURES §3.16 大段近义重复，与「互链去重」口径相悖**
- 位置：README 119-133（存储/写纪律/状态机/接口域表）vs FEATURES 197-201（team-hub 数据与接口一览）。
- 问题：两处对 team.db 表清单、写纪律（handleWrite/by/audit/SSE）、状态机（todo→in_progress→in_review→done/blocked/乐观锁）与关键接口域的描述**高度重合**；只是 README 拆成多条 bullet + 接口表、FEATURES 合成一段散文，未构成 >=3 行逐字块（故 check-docs 不报），但『细节集中到手册、README 只引导』的去重意图被削弱。
- 建议：README §4 收敛为「一句话总览 + 指向 FEATURES §3.16」的引导；接口表若保留，标注「权威以 FEATURES §3.16 / team-hub/server.mjs 为准」。

**P2-3【低】README 模块导航 §3.x 与 FEATURES 模块节 §3.x 编号错位**
- 位置：README §3.9（94-102，三中心+规范/技能）vs FEATURES §3.9-§3.14；README §3.10/§3.11/§3.12（106-113：审计/数据接口/v1）vs FEATURES §3.15/§3.16/§3.17。
- 问题：两者对前几个模块编号一致（3.1-3.8），但「三中心」在 README 合为 §3.9 一个、在 FEATURES 拆为 §3.9-§3.14 六节，导致其后 README §3.10=FEATURES §3.15、§3.11=§3.16、§3.12=§3.17，**编号系统性错位**。虽有显式锚点链接可跳转，但读者按「§3.10」文字互指时易误读。
- 建议：要么让 README 模块导航沿用手册章节号（如实标注 3.9=手册 3.9-3.14），要么在 README 开头注明「模块号与手册章节号不对应，以锚点链接为准」。

**P2-4【中】doc-sync 契约路径追加逻辑在 registerContractDocs 与 settle 门禁两处重复同字面**
- 位置：plugins/src/index.ts 1200-1202（`if (t.docSync === true) for (const p of ['docs/FEATURES.md','README.md']) …push`）与 1638-1640（`if (isPipeline && stage && t.docSync === true) { for (const p of ['docs/FEATURES.md','README.md']) …push }`）。
- 问题：同一「 docSync → 追加 FEATURES+README」字面逻辑写了两遍，各自独立。当前一致，但任何一侧改动（如换个文件名/数组）会立即分叉且无测试约束（P1-1 所述的无测试更放大此风险）。语义上 1638-1640 的追加还是「让 contractPaths.length>0 从而进入 registerContractDocs」的必需项，耦合晦涩。
- 建议：抽成单一纯函数（如 `appendDocSyncContractPaths(contractPaths, t)`），settle 与 registerContractDocs 都调用它；统一入参（registerContractDocs 目前自算 rawPaths，与 settle 的 contractPaths 是两套，建议收敛为一套来源）。

**P2-5【低】registerContractDocs 内的 contractPaths 与 rawPaths 双套路径来源**
- 位置：plugins 1636（`const contractPaths = …stageContractDocs(stage)`）+ 1642-1643（传给 registerContractDocs）vs registerContractDocs 1198（`const rawPaths = resolveStageDocPaths(stage, t.id)` 自算）。
- 问题：settle 用 `contractPaths` 决定是否进入并作 docSync 追加，registerContractDocs 内部又 `resolveStageDocPaths` 重算一份 `rawPaths`（再到 1200-1202 自己追加一遍 FEATURES/README）。两套来源耦合，读起来「追加了两次」的观感，实际因为二者独立互相不出错，但维护上易踩「只改一处」的坑。
- 建议：registerContractDocs 直接接收 settle 算好的 contractPaths（或其 `{taskId}` 已展开版），消除内部重算。

**P2-6【低】check-docs 第 8 项「内联锚点链接」校验当前空转**
- 位置：check-docs.mjs 158-167（inlineRe `[t](#a)`）内联锚点校验；实际两文件均无 `[文本](#锚点)` 形式链接（README 全是 `[x](docs/FEATURES.md#…)`，FEATURES 用「§5.3」文字互指）。
- 问题：该校验项在现状下对两个文件都是**零命中、恒空**，只起了「防护未来注入坏锚点」的作用；真正在做互链校验的是第 4 项（README→手册）。同时第 3 项「正文含入口/操作」是宽松启发式（§5.1 故障排查靠表内「写操作/操作者身份」的『操作』二字命中，属偶然）。
- 建议：明确第 8 项定位（写死为空转守卫的注记），或将「正文非空」断言从「含『入口/操作』」改为「含『入口』或含『操作步骤』」等更贴合语义的锚点词；否则新增内联锚点贡献收益为 0。

**P2-7【低】check-docs 只做单向（README→FEATURES）互链/索引校验，未做反向覆盖**
- 位置：check-docs 143-155（README→手册互链，total>=8）与 106-119（索引→标题）+ 122-140（索引→正文）。
- 问题：校验了「README 指向的锚点在手册中存在」「索引每一行指向真实标题/正文」，但**未校验「FEATURES 每个模块节都能从 README 导航到」**，也未校验是否存在**未被索引收录、README 不可达**的孤儿章节。故「手册漏了一节而 README 没链接」不会被检。
- 建议：补一个反向覆盖——遍历 FEATURES 所有 `### 3.x` 模块节标题，要求每节要么被 README `#…` 互链、要么被功能索引 F-xx 收录；孤儿节即 FAIL。

**P2-8【低】S4 插件侧改动无入库测试，仅靠 scratch 复刻仿真（测试保真缺口）**
- 位置：`plugins/tests/*.mjs` 无 docSync/FEATURES 用例（grep 为零）；`scratch/s4-docsync-sim.mjs` 为复刻逻辑、非 import 真实代码；evidence 06 仅 parseDiagnostics=0。
- 问题：doc-sync 的 registerContractDocs 条件追加、buildWorkerPrompt 注入、stage-standards 验收项——这三处 S4 改动**没有任何真实入库测试**，验证依赖「复刻脚本 + 语法解析」。若真实代码与复刻有一字之差（或路径来源改动，见 P2-4/5），无测试兜底。T-108 亦曾登记 plugins 套件需宿主补跑的同型环境受限。
- 建议：在 plugins/tests 增补 docSync 契约测试（import 真实 `stageContractDocs`/`resolveStageDocPaths`，断言 docSync 任务契约含 FEATURES+README、非 docSync 不含、幂等、goalize 不改写）；宿主补跑 `pnpm install && pnpm typecheck` 与 plugins `node --test`，并按 R-18 留证据。

**P2-9【低】功能索引把「故障排查」编为 F-18，语义上非功能模块**
- 位置：FEATURES §4（231-233，F-18 故障排查 → §5.1）。
- 问题：索引标注为「功能索引」，但 F-18 指向的是 §5.1 排障（非用户可操作「功能」），且 §5 属于「故障排查与术语附录」章节类别。作为索引条目标注状态「已上线」略牵强；但作为「从索引直达排障」的入口仍可用。
- 建议：把 F-18 从功能索引剔除或改为「附：排障入口」引一行，避免与「功能」语义混淆；或保留但注明「非功能、为排障直达」。

**P2-10【低】CI doc 门禁可被 `--skip doc` 绕过（标准逃生口，需注明强度）**
- 位置：run-ci.mjs 50-51（`--skip` 解析）+ 341-349（STAGES）+ stageDoc（332-338）。
- 问题：doc 阶段默认必跑、真实门禁（evidence 07 拦截坏链），但任何调用方可用 `--skip doc` 跳过。与其他阶段一致（env/deps 等同样可 skip），属既有口径，非缺陷；但若将军预期「发布前文档新鲜度**必须**经过」，需在 DEPLOY.md/CI 文档注明「发布门禁须用不含 `--skip doc` 的形式」，否则漏跑风险由调用方承担。
- 建议：在 docs/DEPLOY.md 或 run-ci.mjs 头注释补一句「doc 为发布强制项；正式发布请勿 `--skip doc`」。

---

## 3. 与既有机制（T-107/T-108 时代 registerContractDocs / artifact 契约）的兼容性观察

- **T-108 的两个必须修改项在最终 HEAD 已被修正**（无论归因于 T-114 还是 T-115，现 HEAD 行为正确）：
  - **M1（登记路径不感知目标级 docsDir）**：registerContractDocs 在 1209 行 `goalizeContractPath(goal, rawRel)`，与 gate 校验 `goalDocPath`（1684）、`goalizePrompt`（462-467）同源；且 goalizeContractPath（471-476）只改写 GOAL_DOC_NAMES 六类槽位、**不改写 FEATURES/README**（故 docSync 契约路径稳定于 `docs/FEATURES.md` / `README.md`，不漂移到目标目录）——符合 AC-R4 的 I-2/I-3（契约路径为仓库相对路径，非目标级目录）。
  - **M2（登记写入失败与「文档缺失」混为一谈）**：registerContractDocs 的 catch（1227-1232）只 `log` 记录，**不再 push 进 missing**；missing 仅在 `!existsSync(abs)`（1213-1215）时聚入——因此「写入失败」≠「缺失」，不会误停 in_review、不会错误归因。软门禁口径收敛为「缺才停、写失败不断流程」。
  - 说明：这两处修正比 T-108 审查时改进，避免了我本可复述的 M1/M2 旧问题；doc-sync 块是在其**基础之上**继续追加，未引入回归。
- **非 docSync 行为不回归（AC-R4-4 / I-4）**：追加仅在 `t.docSync === true` 时发生；`registerContractDocs` 对非 docSync 任务的路径 = `stageContractDocs(stage)`（roles.json stage.docs / artifact 回退），与既有 T-107 行为一致。`stage-standards` 顶多是**新增** coder/devops 一条验收项（102/148），未改动岗位语义（AC-R4-5）。
- **契约返回结构兼容**：`registerContractDocs` 继续返回 `{registered, missing}` + `contractDocSummary`（1239-1245），与 T-108 的 S2 结算契约签名一致，doc-sync 只是扩充了 registered/missing 的路径集合。
- **零新增运行时依赖**：check-docs.mjs / run-ci.mjs 只用 node: 内置模块；doc 阶段经 `exec(process.execPath,[check-docs.mjs])` 复用既有 spawn 通道（与 T-093 收口的统一 CI 结构一致）。roles.json 仅增 `docs`（reit docs 保留 artifact 语义，T-108 的 O7 注记依旧适用：plugin 登记只用 docs、gate 校验只用 artifact，双字段并存需维护者对齐）。
- **登记可见性副作用（属预期，非缺陷）**：每个 docSync 任务的审计会多登记 `docs/FEATURES.md` + `README.md` 两条产物（kind=file）。跨任务各自独立登记（不同任务不互相去重，digest 幂等只在**同任务同 path 同字节**时跳过，1218-1219），故多 docSync 任务会产生重复的「登记 FEATURES/README」记录。这强化了「契约登记=可见性」而非「新鲜度强制」的定位，与 P1-1 的结论互为印证。

---

## 4. 与目标验收对照的总体结论

- **无 P0**。交付主体成立：FEATURES.md 是**完整、可操作、面向使用者**的功能手册（17 模块节 + 18 条功能索引 + 排障/术语附录），无占位/半成品；README 收敛互链有效、无死链；check-docs.mjs 结构/互链/索引机器校验逻辑正确、正反例有据（坏锚点/坏列/断链均带文件:行 FAIL）；run-ci.mjs doc 阶段作为**默认必跑**的 CI 门禁真实接入；doc-sync 的**契约追加（D2）+ 验收项（D1）+ 提示词（D3）+ 结构门禁（S3）+ CI 门禁（S5）**五环接线**齐全**。
- **1 项 P1（必须修改/需明确）**：P1-1——doc-sync 的机械强制「漏更即停」（AC-R4-2）对 docSync 任务**不可达**（软门禁只判存在性、FEATURES/README 恒存在 → 恒放行；check-docs 只判结构不判内容），导致目标「每当有新功能自动更新该文档」的**内容新鲜度**没有机器强制，且该缺口**无任何真实用例覆盖**。这是本批唯一可能影响目标真实交付价值的点，请将军据此明确口径（补齐机制 / 或明示「结构门禁+提示词义务」为达标口径）并补一条复现用例。
- **9 项 P2（建议优化）**，可排期、不影响主线合入：主要是 README§4 与手册近义重复、README/手册章节号错位、doc-sync 契约逻辑两处重复、check-docs 自有 slug 与渲染端一致性/反向覆盖/空转项、S4 插件改动缺入库测试、F-18 语义、`--skip doc` 强度注明。
- **兼容性**：与 T-107/T-108 时代的 registerContractDocs/artifact 契约**向前兼容**——T-108 的 M1/M2 在最终 HEAD 已修正，非 docSync 行为不回归、契约返回结构不变、零新增依赖。
- **沙箱限制如实登记**：完整 `tsc -p plugins` 与 plugins `node --test` 因本 worktree 无 node_modules/peerDeps 无法复跑（R-18），与 T-108 同型；S4 插件侧逻辑由**正读源码 + 静态走查**判定（见 §1-S4 / §2-P1-1），不冒充通过。
- 本审查只产出意见（docs/review/T-116-REVIEW.md），未改动任何源码/脚本文件。
