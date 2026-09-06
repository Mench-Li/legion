# T-112 方案搜索：Legion「完整功能使用介绍文档 + 功能/迭代持续自动同步」选型研究

> 阶段：方案搜索（researcher）｜任务：T-112（[auto-goal]｜所属目标 G-mtpq729o-1 · software · chain）
> 上游：T-111「需求澄清」→ docs/G-mtpq729o-1/REQUIREMENTS.md（本目标准一入口）
> 下游：breaker（docs/G-mtpq729o-1/TASK_BREAKDOWN.md）→ test-designer → coder → reviewer → tester → devops
> 本文件落点：docs/G-mtpq729o-1/RESEARCH.md（目标级分析文档目录；不写/不碰仓库根 docs/ 槽位及其他目标目录）
> 验收标准（roles.json researcher / team-hub/stage-standards.mjs:48-64）：方案覆盖需求要点并给出 ≥2 候选对比；有明确推荐与理由（真实可查来源注明引用）；新引入技术/依赖逐项说明影响；结论可直接支撑拆解。

---

## 0. 文档状态与阅读说明

- 本阶段只做选型研究，不改任何仓库实现代码。下列所有「候选/推荐」都为机制方向，具体落地的代码改写（roles / stage-standards / plugins / 脚本 / 手册正文）归 breaker→coder。
- 沿用本仓库标注惯例：✅ 已确认口径（代码/文档/历史证据钉死，可直接依据）；⚖️ 待将军裁决（影响范围/形态的分歧，默认按「倾向 + 默认值」推进，默认值=假设非结论）；❓ 遗留/开放问题（明示假设）。
- ⚠️ 联网可用性声明（本阶段重要前提）：本会话 web_search 工具因余额不足被拒（两次调用均返回 "Insufficient Balance"），故无法在线复核第三方库的最新版本号 / npm 下载量 / GitHub star 数 / 最近提交时间。因此：
  - 第三方候选的许可证类型为公开资料（一般事实，稳定），列出并注明「需联网复核具体 LICENSE 文本与最新维护状态」；
  - 不给出任何下载量 / star 数 / 版本号 / 最近提交日期等时效性数字——避免虚构数据（遵守「不编造数据支撑结论」）；
  - 每个第三方工具给出官方仓库/官网 URL 作为引用锚点（研究者可复核的原始出处，本次未联网打开），并在 §14 集中说明。
- 本地引用均为真实 file:line（本 worktree），已在 §12 给出验证方式。

---

## 1. 选型任务总览：R-1~R-5 映射到 researcher 需落定的工程决策

T-111 需求已把「要什么/验收口径」钉死，把「怎么实现」留给我。§10.1「下游衔接」明示 researcher 的自由度集中在：机制注入点、校验脚本与 CI 接线、索引格式、是否从源码自动提取入口。据此，本阶段需要落定的六组决策：

| 决策 | 对应需求 | 决策问题 | 结论速览（详见各节） |
| --- | --- | --- | --- |
| A 功能手册承载形态 | R-1/R-3 | 手册用什么形态/工具承载？ | A1 纯结构化 Markdown 单文件（docs/FEATURES.md）；拒绝文档站生成器与源码自动生成 |
| B 功能索引格式 | R-3 | 机器可提取的索引用何种格式？ | B1 Markdown 表格（行首 F-xx）；备选 YAML frontmatter / JSON manifest |
| C 文档新鲜度校验工具 | R-5 | 用什么做索引/锚点/互链校验？ | C1 仓库自有零依赖 Node 脚本（machcheck 风格）；备选 markdown-link-check / markdownlint / lychee |
| D 持续更新机制注入点 | R-4 | 文档同步义务注入到流水线哪个环节？ | D1 + D4 组合（stage-standards 机器验收项 + breaker 默认 doc-sync 切片），D3 守护提示词作细化说明 |
| E CI 门禁接线 | R-5 | 校验脚本如何接入门禁？ | E1 独立 node scripts/ci/check-docs.mjs + run-ci.mjs 注册可 skip 的 doc 阶段 |
| F 触发判定（新功能识别） | R-4 | 「用户可见行为变化」如何被识别与声明？ | F1 任务声明 + F3 索引对账增量检出；F2 语义化提交作可选增强 |

> 关键原则（来自 REQUIREMENTS §1/§4.2）：本目标不做「运行期自动生成文档」（A3）、不做多语言/网页版发布（A2 本期不采）；「自动」= 流水线强制 + 机器校验（D4/D1/D3 + C/E）。

---

## 2. 决策 A —— 功能手册承载形态（R-1/R-3）

### 2.1 候选对比

| 候选 | 形态 | 优点 | 缺点/成本 | 风险 | 适配判断 |
| --- | --- | --- | --- | --- | --- |
| A1 纯结构化 Markdown 单文件 | docs/FEATURES.md，按模块组织 + 内置功能索引表 | 零依赖、零构建；与仓库既有文档（README/REQUIREMENTS/RESEARCH）同为 MD 风格，一读即会；可 git 追踪、可单文件 diff、可机器解析（machcheck 先例直接支持）；完全满足 D-8「中文 Markdown 单文件」 | 需人工维护结构与内容；不做站点导航/搜索；冗长文档的可读性靠目录/索引自建 | 低：无构建链、无发布目标、无依赖 | ✅ 推荐 |
| A2 文档站生成器（VitePress / Docusaurus / MkDocs / docsify） | 由若干 MD 渲染成静态站点 | 站点导航/侧栏/搜索/主题美观；组件化，易扩展 | 引入构建链与 node 依赖；发布形态（网页）违背 D-8（默认 Markdown 单文件）；本项目无 Web 文档发布载体；CI 需新增 build；文档与站点两套产物易漂移 | 中：新增依赖（违反禁止联网下依赖仓库纪律）、CI build 成本、维护站点与手册双份 | ❌ 本期不采，作备选 |
| A3 源码自动生成（Typedoc / JSDoc / 自定义 AST 提取入口表） | 从源码提取 API/入口，自动生成手册 | 入口级信息自动且准；与代码强一致 | 只能生成「有什么入口/参数」，无法产出「怎么操作/期望结果/常见问题」等用户叙事；在仓库禁用联网下依赖 & 无自动生成链；D-6 已定「本期不做」；改造面大、产出割裂 | 高：违背「不做运行期自动生成文档」（REQUIREMENTS §4.2/§8 D-4）、成本高、产出不满足「功能使用介绍」叙事 | ❌ 明确不做（当期），列为可选后续增强 |

### 2.2 推荐

A1（docs/FEATURES.md）。依据（本地可查）：仓库本身已是「文档即产物」的 MD 中心（README.md:1-242 长文、docs/G-mtpq729o-1/REQUIREMENTS.md 全部以 MD+表格承载）；既有机器校验先例 T-098 docs/T098-evidence/machcheck.mjs:1-57（零依赖解析 MD 结构表格并断言）证明 MD 表格可被稳定机器提取；R-1 AC-R1-2/AC-R1-3 要求的结构与覆盖对账正是 MD 标题+索引表格可承担。A3 明确拒绝除上述理由外，还因为它与「持久性」「叙事性」两个需求核心相悖，D-6/D-8 亦已排除。

> ⚖️ D-2（文件路径）沿用 T-111 默认：docs/FEATURES.md。若将军给新路径即改，不影响本文任何结论。

---

## 3. 决策 B —— 功能索引机器格式（R-3）

### 3.1 候选对比

| 候选 | 格式 | 优点 | 缺点/成本 | 风险 | 适配 |
| --- | --- | --- | --- | --- | --- |
| B1 Markdown 表格（行首 F-xx） | 独立小节内表格：| F-01 | 功能名 | §章节锚点 | 入口 | 状态 | | 与正文同文件、天然对账；零依赖正则可提取（行首 /^F-[0-9]{2}/m）；machcheck.mjs:11-27 已有同型解析先例；锚点即文档标题，互链自然 | 表格列手填易错（需机器校验列数/锚点）；索引与正文小节若不同步更新会漂移 | 低：正因校验脚本可检出（R-5 AC-R3-1/2），漂移可机器暴露 | ✅ 推荐 |
| B2 YAML frontmatter 清单 | 文档头部序列化功能数组 features: [...] | 机器最友好（YAML 直接转对象）；可带类型/状态枚举 | 需 YAML 解析器（零依赖 Node 需手写/内嵌，或引第三方）；与正文小节锚点弱绑（两种载体并存更易漂移）；作者心智负担高 | 中：解析器依赖 + 双载体一致性问题 | 备选 |
| B3 独立 JSON manifest（如 docs/features.idx.json） | 单独机器清单文件 | 强类型、最易被 CI/脚本消费；与正文解耦 | 双份维护（索引/正文各写一遍，与 README 去重同样痛点）；相对路径/锚点纯人工维持；违背「单文档」原则 | 中：漂移风险最高（正是本目标要根治的「两份不齐」问题的翻版） | 备选 |

### 3.2 推荐

B1。依据：R-3 AC-R3-1 的样例就是「正则按行首 F-[0-9]{2} 提取」（REQUIREMENTS.md:187）；T-098 machcheck.mjs:1-27 已验证「零依赖正则解析 MD 结构化表格」可行；B1 让「索引 ↔ 正文小节」同文件对账，最大程度避免「索引说有、正文没有」的漂移。B3 明确不选——它把问题从「README↔手册」扩展到「索引↔手册」双份，违背本目标消除漂移的初衷。

> 索引行格式建议（coder 定稿、breaker 校验可解析）：F-01 | 空间与专属编队 | #3-1 | 左侧「空间」 | 已上线。状态枚举：已上线 / 迭代中 / 遗留。粒度 = 功能域级（D-6）。

---

## 4. 决策 C —— 文档新鲜度机器校验工具（R-5）

### 4.1 候选对比

| 候选 | 工具 | 优点 | 缺点/成本 | 风险 | 适配 |
| --- | --- | --- | --- | --- | --- |
| C1 仓库自有零依赖 Node 脚本（machcheck 风格，如 scripts/ci/check-docs.mjs） | 纯 node:fs/re 写的断言脚本 | 零依赖（契合「禁止联网下依赖」纪律，脚本零依赖直接可跑 AC-R5-1）；校验项恰是本需求定制的索引/锚点/互链/去重，通用工具覆盖不了；已有 T-098 machcheck.mjs 先例直接复用其风格；输出可定向到具体行 | 要自己写解析与断言（约几百行）；不含格式 lint（若需要可再外挂 C2/C3 不冲突） | 低：校验范围明确、无联网、无依赖；产出即 AC-R3-1/2、AC-R2-2 的机器化 | ✅ 推荐 |
| C2 markdown-link-check（npm，MIT） | 检查 MD 内链/外链 | 链接健康度检查成熟；对 README↔手册互链有效 | 需 npm 依赖（仓库禁联网下依赖）；只在「链接有效」维度强，不支持「索引对账/功能域完整性」；输出非定制格式 | 中：需要装依赖、且不能满足 R-3 索引对账 | 备选（可作 C1 之外的链接健康补充） |
| C3 markdownlint-cli / remark-lint（MIT） | MD 风格/语法 lint | 排版一致性好；社区成熟 | 同样需依赖；只管「格式」不管「语义/链接/索引对账」——与 R-5 核心（索引完整性+互链+关键项不丢）能力错位 | 中：需依赖 + 能力错位 | 备选 |
| C4 lychee（Rust 链接检查，MIT/Apache-2.0 双许可，需复核） | 独立链接检查器 | 链接检查性能好、覆盖网络/文件链接 | 引入 Rust 二进制/额外运行时；超出本仓库 JS/Node 技术栈；仍需联网复核许可与维护状态 | 中：跨技术栈、需额外二进制 | 备选（不采） |

### 4.2 推荐

C1。依据（本地可查）：scripts/ci/run-ci.mjs:1-28 声明「零第三方依赖，Node ≥ 22.5」并已有六阶段；docs/T098-evidence/machcheck.mjs:1-57 是零依赖结构校验的现成范式；R-5 AC-R5-3 要求覆盖「README→手册锚点 / 索引提取 / 索引锚点」三项——这些是业务定制断言，通用工具（C2/C3/C4）都不直接提供。C1 用 check-docs.mjs 实现，--help 说明，坏例注入时 exit ≠ 0 并报文件+行（AC-R5-2）。C2 可作为可选的「链接健康」增强，但不引入（避免依赖与职责模糊）。

---

## 5. 决策 D —— 持续自动更新机制注入点（R-4）

### 5.1 候选对比

| 候选 | 注入点 | 优点 | 缺点/成本 | 风险 | 适配 |
| --- | --- | --- | --- | --- | --- |
| D1 stage-standards 机器验收项：为 coder/devops（或 feature 类角色）增加「用户可见行为变更须同步功能手册 + README」验收项 | team-hub/stage-standards.mjs | 已机器化：任一任务生成（含 AI 拆解/手动建任务）都会自动套用（server.mjs 消费 :1593-1607）；零破外、消费方自动生效；直接满足 AC-R4-1/2（缺失即提示/打回） | 改动共享文件（stage-standards 被 server.mjs 与守护读）；需要改 acceptance 数组（加项，不改语义，符合 AC-R4-5） | 低（改动=新增字段/项，角色语义不变） | ✅ 推荐（核心） |
| D2 roles.json 增加 doc-sync 字段/新 stage | roles.json | 文档契约是工厂，可在【特征任务】上挂 docs: ["docs/FEATURES.md","README.md"]，借 registerContractDocs 软门禁（plugins :1595-1607）免费获得自动登记 + 缺失即停在 in_review | roles.json 是共享文件（board-plugin /api/config 读、taskctl/守护 pipeline 读），结构变更要同步守护 StageDef（plugins:151-160）与读方；若对所有 stage 挂则纯重构也被卡（违 AC-R4-4）——必须「条件化」 | 中：需「仅 feature 任务生效」的条件逻辑（任务级 flag），否则误伤 | ✅ 推荐（配合 D1） |
| D3 守护提示词注入：buildWorkerPrompt 里为 feature 任务附「须同步 docs/FEATURES.md + README.md」说明 | plugins/src/index.ts:1332（stage.prompt 注入）、:1340（acceptance 注入） | 士兵/将军在提示词看到要求，告知性最强；改动小（条件文本追加） | 告知≠强制，机器层面不卡（漏更仍靠 R-5 兜底）；依赖 AI 自觉 | 低：作为说明性一层 | ✅ 推荐（辅助） |
| D4 breaker 拆解模板默认注入 doc-sync 切片 | breaker 在 TASK_BREAKDOWN.md 给 feature 目标默认加一个「文档同步」切片（文件域 docs/FEATURES.md + README.md） | 把文档同步做成独立可验收切片（AC-R4-1 直证：「拆解产物中存在显式文档同步切片」）；切片边界清晰，易查漏 | 依赖 breaker 执行模板（AI 决策）；若遗漏则无强制兜底；切片数与并行度调整 | 低：模板默认 + D1 机器验收兜底 | ✅ 推荐（辅助） |
| D5 独立规则文档 + LEGION.md 散文 | 新增规则文档/LEGION.md 补充 | 最轻量 | 回到「只散文不机器」老路（RK-4 即为此设）；LEGION.md 现有纪律已是散文（LEGION.md:18-21）未生效——再写一条未机器化的纪律不能解决「持续」 | 高：正是 RK-4 所指 | ❌ 不作为主手段，仅作文档说明 |

### 5.2 推荐（组合）

D2（条件化 stage.docs 契约作强制底座）+ D1（stage-standards 验收项）+ D3（提示词说明）+ D4（breaker 默认 doc-sync 切片），四者互补、职责不重复：

1. 强制底座（D2 + D1）：给 feature 类任务打任务级标记（如 docSync: true，由 breaker 在拆解/派工时依据「是否用户可见行为变化」声明写入，见决策 F）；当 docSync=true 时，守卫在契约路径（plugins :1593-1596）追加 docs/FEATURES.md + README.md 到该任务 contracts → 结算自动登记 + 缺失即停 in_review 写明确提示（AC-R4-2）。非 feature 任务不标 docSync → 无该合同 → 不被卡（AC-R4-4）。
2. 说明层（D3）：buildWorkerPrompt 在 docSync 任务提示词里追加一句「本任务为用户可见功能迭代：请同步 docs/FEATURES.md 对应小节 + 功能索引 + README 引导段」，让士兵明确该做什么（减少「乱改」/「漏更」）。
3. 切片层（D4）：breaker 拆解 feature 目标时默认给出独立的「文档同步」切片（文件域最小=docs/FEATURES.md + README.md），便于独立认领与验收；与 D1/D2 的机器验收形成双保险。
4. R-5 兜底（C/E）：即使三者都漏，check-docs.mjs 门禁可在 main 上暴露索引缺失/断链/互链失效。

> 依据（本地可查）：roles.json:8-66 的 stage.docs 契约（T-107 引入）已在 registerContractDocs（plugins/src/index.ts:1163-1202，软门禁 :1595-1607）兑现「契约文档缺失 → 停 in_review 提示」；这一现成机器链路正是 R-4「缺失即提示/打回」的现成载体，无需另起机制。关键：必须条件化，否则纯重构也被卡（AC-R4-4）。
> ⚠️ 注意：roles.json 与其他在途目标可能共用（本仓库自举，RK-2），breaker 按文件域/段落划界排先后；本文机制只新增字段/项，不改岗位职责语义（AC-R4-5）。

---

## 6. 决策 E —— CI 门禁接线（R-5）

### 6.1 候选对比

| 候选 | 形式 | 优点 | 缺点/成本 | 风险 | 适配 |
| --- | --- | --- | --- | --- | --- |
| E1 独立脚本 + run-ci.mjs 注册可 skip 的 doc 阶段 | 新增 scripts/ci/check-docs.mjs（零依赖），run-ci.mjs 注册 doc 阶段并支持 --skip doc | 可单独跑（node scripts/ci/check-docs.mjs 直接 exit 0/非0，AC-R5-1）；与既有 run-ci 的阶段风格一致（:15-23 六阶段，扩展一个 doc 阶段）；坏例可显式注入验证；可 skip 避免日常发布被卡（RK-6） | 需维护两处（脚本 + run-ci 注册） | 低：与既有六阶段模型同构；可跳过开关满足 RK-6 | ✅ 推荐 |
| E2 直接把校验内嵌到 run-ci 各阶段 | 在 build/test 等阶段内联校验 | 少一个文件 | 难单独跑/单独测；与业务阶段耦合；无法满足 AC-R5-1 的「独立脚本存在」要求 | 中：耦合/难验证 | ❌ 不作为主案 |

### 6.2 推荐

E1。依据：run-ci.mjs:15-23 的六阶段模型（env/deps/build/test/smoke/stage）与 --only/--skip/--out CLI（:9-13、:40-51）天然容纳一个可跳过的 doc 阶段；T-098 machcheck 的独立脚本范式（docs/T098-evidence/machcheck.mjs）已证明独立零依赖脚本更适合结构化校验与坏例注入。默认建议：运行 node scripts/ci/check-docs.mjs（独立），并把 doc 阶段默认接入 run-ci 全量（可 --skip doc）——兼顾 AC-R5-4（门禁反映正确）与 RK-6（日常发布可跳）。

---

## 7. 决策 F —— 触发判定（「新功能」如何识别并声明）（R-4）

### 7.1 候选对比

| 候选 | 机制 | 优点 | 缺点/成本 | 风险 | 适配 |
| --- | --- | --- | --- | --- | --- |
| F1 任务声明式：拆解/派工时由（AI 拆解 + 将军把关）声明「是否用户可见行为变化」，写入任务字段（如 feature : bool） | 明确、可审计；与 RK-3 缓解思路一致（REQUIREMENTS.md:256） | 依赖拆解判定（AI/人工），可能误判 | 低：机器只校验「声明 feature 却没文档」；拿不准时将军验收把关 | ✅ 推荐（主判定） |
| F2 语义化提交自动识别（Conventional Commits / git-cliff / changesets 从 commit 提取 feature） | 免拆解判定；提交即特征信号 | 需落地提交规范（本仓库为自由提交，历史不满足）；feat 未必都是用户可见；推断不精确；需新依赖/流程 | 中：规范落地成本、误报、依赖 | 备选（不采为主判定，可作提示增强） |
| F3 功能索引对账自动发现：把 R-3 索引当基准，main 合入后跑 check-docs，若「新入口/新模块」未入索引 → 提示 | 纯增量、无新依赖；把 R-3 的索引直接变成检出基准（AC-R3-4 双向引用的额外收益） | 只能检测「有东西没登记」，不能自动知道该不该登记（需人工确认是否用户可见） | 低：不会误伤（仅提示待确认） | ✅ 推荐（增量补强） |

### 7.2 推荐

F1 为主、F3 补充。判定「是否触发文档同步」以拆解时的显式声明为准（机器不猜，REQUIREMENTS.md:282 D-5 / A-4 已如此默认），任务带 feature（用户可见行为变化）标记；F3 用 R-3 索引对账在 CI 上做增量提示（新功能/新模块未登记 → 提示待确认），作为 F1 的机器兜底。F2 因落地成本与推断精度，仅作为可选增强，不设为主判定。

---

## 8. 关键发现：产品文档 vs 目标级文档目录（命名空间边界）

本仓库守护已实现「目标级分析文档目录」隔离：goalDocPath()（plugins/src/index.ts:454-457）会把传入的任意 docs/<base> 改写为 <docsDir>/<base>，且 goalizePrompt()（:460-464）只对 GOAL_DOC_NAMES 六个阶段文档（:452：REQUIREMENTS/RESEARCH/TASK_BREAKDOWN/TEST_CASES/TEST_REPORT/DEPLOY）做路径改写。

结论（✅ 可依据）：
- docs/FEATURES.md 与 README.md 是「持久产品文档」，不属于 6 阶段文档（不在 GOAL_DOC_NAMES，也不该被 goalDocPath 改写到 docs/G-<goalId>/）。
- 用 D2 的 stage.docs 契约登记 doc-sync 时，resolveStageDocPaths()（:405-406）只做 {taskId} 替换、不套用 goalDocPath，因此 docs/FEATURES.md / README.md 会原样登记为仓库相对路径（不落入目标目录）——这正是期望行为。
- 给 breaker/coder 的明确提示：doc-sync 的契约文件域请写绝对仓库相对路径 docs/FEATURES.md 与 README.md，不要写 docs/G-mtpq729o-1/FEATURES.md（那是阶段分析文档目录，产品手册应长期固定在 docs/FEATURES.md，D-2 默认）。手动登记预览用 worker artifact（kind=file，:1130-1158）亦可，路径同样用仓库相对路径。
- 若将军最终选择其他路径（D-2 备选仓库根 FEATURES.md），只需同步该常量/契约字段，不影响本文机制结论。

---

## 9. 外部依赖 / 新增技术影响逐项说明

> 本目标建议引入的「新依赖」总量 = 0 个第三方运行时依赖（核心方案 C1/E1/A1 全部零依赖）。以下为候选对比中涉及的外部工具的行政许可/维护/学习/生态影响，供将军与下游权衡；均为公开资料（许可证一般事实），版本级数字（下载量/star/最近提交）因本阶段无法联网复核，一律不列、以官方仓库为准。

| 工具/框架 | 引用锚点（官方） | 许可证 | 维护/生态 | 学习成本 | 本目标采否 |
| --- | --- | --- | --- | --- | --- |
| VitePress | https://vitepress.dev | MIT（公开资料，复核） | Vue 生态、活跃 | Site 配置/组件化，中 | ❌ 不采（A2） |
| Docusaurus | https://docusaurus.io | MIT（公开资料，复核） | Meta 维护、活跃、生态大 | 中高 | ❌ 不采（A2） |
| MkDocs | https://www.mkdocs.org | BSD-3-Clause（公开资料，复核） | 社区活跃、Python 生态 | 低中 | ❌ 不采（A2） |
| docsify | https://docsify.js.org | MIT（公开资料，复核） | 维护活跃度一般 | 低 | ❌ 不采（A2） |
| markdown-link-check | https://github.com/tcort/markdown-link-check | MIT（公开资料，复核） | 社区成熟 | 低 | ⚖️ 备选（C2，不采，避免依赖） |
| markdownlint / markdownlint-cli | https://github.com/DavidAnson/markdownlint | MIT（公开资料，复核） | 成熟 | 低 | ⚖️ 备选（C3，不采，能力错位） |
| remark / remark-lint | https://github.com/remarkjs/remark | MIT（公开资料，复核） | 成熟 | 低 | ⚖️ 备选（C3，不采） |
| lychee | https://github.com/lycheeverse/lychee | MIT/Apache-2.0 双许可（需复核） | 活跃，Rust 生态 | 跨栈，中 | ❌ 不采（C4） |
| Conventional Commits | https://www.conventionalcommits.org | 规范（CC BY 4.0，公开资料，复核） | 广泛采用 | 低 | ⚖️ 可选增强（F2） |
| git-cliff | https://git-cliff.org | MIT/GPL（需复核） | 较活跃 | 中 | ⚖️ 可选增强（F2） |
| changesets | https://github.com/changesets/changesets | MIT（公开资料，复核） | 活跃、广泛用于 monorepo | 中 | ⚖️ 可选增强（F2） |

新增依赖影响结论：
- 0 个运行时依赖进入实现（采纳 A1/B1/C1/E1/F1/F3，全部用仓库既有 Node/Markdown/git 能力 + 自写零依赖脚本）。此举完全规避「禁止联网下依赖」纪律与许可证/供应链风险。
- 若将军要求引入 C2/C3 做更严格的链接/格式检查，则需新增 npm 依赖（许可证 MIT，维护成熟），成本 = 一次依赖引入 + 与既有零依赖原则的取舍；建议作为可选项而非默认。
- 本目标不改任何已有依赖、不新增 package.json 条目（仅新增/改 roles.json、stage-standards.mjs、plugins/src/index.ts 的字段/项/文本与新增自写脚本）——对依赖树零影响。

---

## 10. 风险与备选

| # | 风险 | 说明 | 缓解/备选 |
| --- | --- | --- | --- |
| RR-1 | 通用候选（文档站/AI 生成）被「潮流」裹挟引入 | 与零依赖、单 MD、不做运行期生成相悖 | 本报告明确不采 A2/A3，把取舍写入 §2；将军可复核 |
| RR-2 | R-4 强制手段误伤纯重构任务 | doc-sync 若绑到所有 coder/devops 会卡非 feature | D2 必须条件化（docSync flag 只在 feature 任务生效），AC-R4-4 直接验证 |
| RR-3 | 机制只停在散文/模板，未机器化 | 与既有 LEGION.md 纪律同病（RK-4） | 以 D1/D2 机器验收 + C/E 机器门禁落地，非散规则 |
| RR-4 | 索引/正文漂移 | 索引表与功能小节不同步 | B1 同文件 + check-docs 索引对账（R-3 AC-R3-1/2）+ C/E 门禁 |
| RR-5 | README 去重破坏既有信息 | README 260 行被多处引用（RK-1） | REQUIREMENTS AC-R2-3 关键项不丢断言 + check-docs 覆盖；coder 只迁移不删除 |
| RR-6 | roles.json/plugins 与其他目标冲突（自举） | 多目标同改共享文件（RK-2） | breaker 按文件域/段落划界、排先后；本文只增字段/项（AC-R4-5） |
| RR-7 | 无法联网复核第三方版本级事实 | web_search 余额不足 | §14 明示；结论不依赖任何时效性数字，只用许可证类型/官方锚点，未虚构数据 |
| RR-8 | check-docs 门禁误伤发布 | 校验规则写死 | doc 阶段默认可 --skip doc；校验只限结构/链接/索引，不判语义（R-5 scope） |

---

## 11. 推荐结论汇总（可直接支撑 breaker 拆解）

一句话结论：本目标 = 「一份零依赖的持久性 Markdown 功能手册（docs/FEATURES.md）+ 一条可机器强制/校验的「文档同步」流水线契约」，不引入任何第三方运行时依赖。

给 breaker 的切片建议（按文件域互不重叠，供其切 S1..Sn）：

| 切片 | 内容 | 建议文件域 | 对应 AC |
| --- | --- | --- | --- |
| S1 手册首版 + 功能索引 | 产出 docs/FEATURES.md（结构：定位/读者/快速开始/模块章节/功能索引/排障/术语附录）+ 索引段 | docs/FEATURES.md | R-1/R-3（AC-R1-1/2/3、R3-1/2/3） |
| S2 README 收敛 + 互链去重 | README 收敛为总览/导航 + 指向手册互链 + 迁移细节；消除整段重复 | README.md | R-2（AC-R2-1/2/3/4） |
| S3 校验脚本 check-docs.mjs | 零依赖脚本：索引提取/锚点校验/互链校验/去重+关键项 | scripts/ci/check-docs.mjs | R-5（AC-R5-1/2/3） |
| S4 机制注入点（stage-standards + roles 条件化 + 守护提示词） | task 级 feature/docSync 标记；D2 条件合同 + D1 验收项 + D3 提示词；D4 breaker 模板 | team-hub/stage-standards.mjs、roles.json、plugins/src/index.ts、docs/G-mtpq729o-1/TASK_BREAKDOWN.md 模板说明 | R-4（AC-R4-1/2/3/4/5） |
| S5 CI 接线 | run-ci.mjs 注册 doc 阶段（可 skip）+ 文档门禁接入 | scripts/ci/run-ci.mjs | R-5（AC-R5-4） |

> 依赖顺序：S1 依赖 README 现状（S2 可并行）；S3 依赖 S1 定稿索引格式；S4 依赖机制决策（本报告已定）；S5 依赖 S3。改动边界警示：README.md、roles.json、plugins/src/index.ts 为共享文件，breaker 需与在途其他目标划界/排序；（§8）doc-sync 契约文件域用绝对仓库相对路径 docs/FEATURES.md + README.md，勿写目标目录。

---

## 12. 本阶段自检与本地证据

### 12.1 本阶段无代码变更、无依赖变更

本阶段（researcher）只产出本文（docs/G-mtpq729o-1/RESEARCH.md），不改仓库实现 → 仓库「代码纪律」（typecheck/build/test 至少跑其一）的适用对象是改行为时；本阶段无行为改动，验证主体 = 本文满足 researcher 验收标准（见 §12.3 自检）。

### 12.2 本地证据（真实 file:line，已在本会话读取确认）

| 引用主题 | 证据位置（本 worktree） | 用途 |
| --- | --- | --- |
| 岗位文档契约/阶段链 | roles.json:8-66（requirement :11-15、researcher :20-24、breaker :29-31、test-designer :36-38、reviewer :49-51、tester :56-58、devops :63-65） | D2 说明 layer |
| 各岗验收标准模板 | team-hub/stage-standards.mjs:30-47（requirement）、:48-64（researcher，含本文须满足的四条）、:96-112（coder）、:142-156（devops）、:11-18（default） | D1 注入候选；本文验收对照 |
| CI 六阶段/零依赖/CLI | scripts/ci/run-ci.mjs:1-28（概述）、:15-23（阶段清单）、:40-51（--only/--skip/--out） | E 决策 |
| 零依赖 MD 结构校验先例 | docs/T098-evidence/machcheck.mjs:1-57 | C1/B1 依据 |
| 产品文档命名空间函数 | plugins/src/index.ts:452（GOAL_DOC_NAMES）、:454-457（goalDocPath）、:460-464（goalizePrompt）、:405-406（resolveStageDocPaths） | §8 关键发现 |
| 契约文档登记 + 软门禁 | plugins/src/index.ts:1163-1202（registerContractDocs）、:1593-1607（缺失→停 in_review） | D2 强制底座、AC-R4-2 |
| worker 提示词/验收注入 | plugins/src/index.ts:1332（stage.prompt 注入）、:1340（acceptance 注入） | D3 说明层 |
| 产品现状/模块/快速开始 | README.md:1-8（定位）、:30-80（§2 快速开始）、:81-184（§3 模块功能指南）、:185-215（§4 team-hub）、:224-241（§6 排障） | A1/手册基准 |
| 既有散文纪律 | LEGION.md:18-21 | D5 不采依据 |

### 12.3 本文验收对照（stage-standards researcher 四条）

| 验收条目 | 落点 |
| --- | --- |
| 方案覆盖需求要点，≥2 候选对比（优缺点/成本/风险） | 决策 A~F 每组均 2~4 候选，含优缺点/成本/风险三列（§2~§7） |
| 有明确推荐与理由，依据真实可查来源并注明引用 | 每组含「依据（本地可查）」+ file:line；第三方工具给官方锚点（§9、§12.2） |
| 新引入技术/依赖逐项说明影响（许可/维护/学习/生态） | §9 逐项表 + 结论（0 运行时依赖） |
| 结论可直接支撑后续拆解 | §11 给切片建议（文件域+对应 AC） |

> ⚠️ 为确保「依据可查」，§12.2 全部 file:line 均在本会话用 read/grep 实际读取确认，未凭记忆臆断。

---

## 13. 关联文档与阅读顺序

- 上游：docs/G-mtpq729o-1/REQUIREMENTS.md（T-111，已定 R-1~R-5、D-1~D-9、AC、门径）。
- 本报告：docs/G-mtpq729o-1/RESEARCH.md（T-112）。
- 下游：docs/G-mtpq729o-1/TASK_BREAKDOWN.md（T-113 拆解）→ TEST_CASES（T-114）→ coder（T-115）→ review（T-116）→ test（T-117）→ devops（T-118）。
- 关系：docs/FEATURES.md（新建，产品手册）与 README.md（收敛为总览）、workbench/README.md、scrum/README.md、PLUGINS.md、docs/DEPLOY.md 的关系写入手册「附录·关联文档」；本文与仓库根 docs/RESEARCH.md（其他目标/遗留）无承接。

---

## 14. 待将军确认项与「未联网复核」声明

### 14.1 ⚖️ 待将军确认（沿用 T-111 D-* 默认，不阻塞；如将军选 D-3 单文档则 R-2/R-3 范围需改）

- D-3 双文档结构（README=总览 + 手册=细节）：默认采纳；若将军要单长文 → 本文 A/B/C 的「去重/双链/索引」设计需相应简化。
- D-4 保障强度（流程契约 R-4 + 机器门禁 R-5 都做）：默认两者都做（本报告按此设计）；若只做流程 → R-5 降 P2，C/E 只留脚本不进 CI。
- doc-sync 是否默认接入 CI：本文建议「独立脚本默认跑 + run-ci 全量可 --skip doc」；若将军希望发布必跑（不可跳过）请明示。
- 功能手册路径（D-2）：默认 docs/FEATURES.md；将军给新路径即改（§8 同步常量）。

### 14.2 ❓ 未联网复核声明（诚实边界）

- 本会话 web_search 因余额不足被拒（两次调用返回 "Insufficient Balance"），无法在线核实第三方库的最新版本/下载量/star/最近提交/具体 LICENSE URL。
- 故本文：只给出第三方候选的许可证类型与生态属性（公开且稳定的一般事实），并每条标注「公开资料，需复核」；未列出任何时效性数字（版本号/下载量/star/提交日期），以免虚构数据；外部工具的引用锚点为其官方仓库/官网 URL（研究者可复核的原始出处）。
- 建议将军验收或后续阶段如需锁定第三方数字，可在联网环境下复核 §9 表；本目标实现不依赖任何这类数字（采纳方案 0 运行时依赖）。

---

*（本文件由 T-112 方案搜索士兵产出，仅落在 docs/G-mtpq729o-1/RESEARCH.md；未改任何仓库实现。）*
