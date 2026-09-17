# T-117 测试执行报告：Legion「完整功能使用介绍文档 + 功能/迭代持续自动同步」（G-mtpq729o-1）

> 角色：tester（测试执行）｜阶段：测试执行｜执行任务：T-117（[auto-goal]｜所属目标 G-mtpq729o-1 · software · chain）
> 依据：docs/G-mtpq729o-1/TEST_CASES.md（T-114，66 条用例）→ TASK_BREAKDOWN.md（T-113，S1~S5 机器验收行）→ REQUIREMENTS.md（T-111，AC-R1~R5）→ RESEARCH.md（T-112）
> 被测交付：T-115 coder 合入（f0261fc）的 S1~S5（docs/FEATURES.md、README.md、scripts/ci/check-docs.mjs、scripts/ci/run-ci.mjs doc 阶段、team-hub/stage-standards.mjs + plugins/src/index.ts docSync 机制）；本 worktree 分支 w/T-117（HEAD ce87364，含 T-116 review 调解合入）
> 证据目录：docs/G-mtpq729o-1/T117-evidence/（命令输出原件；本报告仅引用与要点摘录）

## 0. 结论速览（判定表 + 一句话结论）

| 切片 | 用例 | ✅ PASS | ❌ FAIL | ⛔ 环境受限 | 判定 |
| --- | --- | --- | --- | --- | --- |
| S1 功能手册+索引（docs/FEATURES.md） | 15 | 15 | 0 | 0 | ✅ 内容全绿 |
| S2 README 收敛+互链去重（README.md） | 13 | 12 | 1（TC-S2-13，P2） | 0 | ⚠️ 1 个 P2 内容缺口 |
| S3 校验脚本（check-docs.mjs） | 10 | 9 | 1（TC-S3-02） | 0 | ❌ CRLF 兼容缺陷（门禁假红） |
| S4 持续同步机制（stage-standards/roles/plugins） | 15 | 9 | 4（TC-S4-01/04/06/07） | 2（TC-S4-12/13） | ❌ docSync 接线缺口（E2E 不可达） |
| S5 CI doc 门禁（run-ci.mjs） | 13 | 11 | 2（TC-S5-02/07） | 0 | ❌ 门禁当前 checkout 假红 + 错误细节被吞 |
| **合计** | **66** | **56** | **8** | **2** | **未全绿 → 本批需修复/裁决后复测** |

**一句话结论**：S1/S2 文档内容与 S3/S5 校验逻辑在**作者工作态（LF 文本）**下全部验证通过（文档本身结构/索引/锚点/去重/关键项/无叙事 42 项独立断言全过，check-docs 8 类校验 LF 下 exit 0，负例注入可检出并还原）；但验收复跑发现 **4 类真实缺陷/缺口** 使「全绿」不成立：

- **RC-1（S3-02 / S5-02，P0 级）**：`check-docs.mjs` 不兼容 CRLF 行尾 —— 本仓库 `core.autocrlf=true`（无 .gitattributes），任何 fresh Windows checkout 工作区文件为 CRLF，脚本逐行 `^…$` 正则无法匹配带 \r 行 → 44 处假红；当前主 checkout 与 T-117 worktree 均复现。作者 T-115 证据之所以全绿，是因为其运行发生在自写 LF 工作态、未经 checkout 转换。**归属 scripts/ci/check-docs.mjs（S3）/ 间接使 S5 doc 门禁不可用。**
- **RC-2（S4-01/04/06/07，P0 级）**：docSync 机制**只有消费端没有声明/持久化通道** —— team-hub 无 tasks.docSync 列、`/api/create` 丢弃 docSync/feature 字段、目标链/切片展开不携带该标记（实测 POST /api/goal + /api/create 后任务对象无 docSync）；plugins 三处 `t.docSync===true` 分支在真实 hub 流中不可达 → AC-R4-1/2/4 E2E 无法成立。**归属 S4 接线（team-hub/server.mjs + 任务创建/链生成链路）。**
- **RC-3（S5-07，P1）**：run-ci `stageDoc` 对输出只保留含 PASS/FAIL 的行，check-docs 缺失（模块级错误）时 doc 阶段 FAIL 但可读错误细节被过滤吞掉 → 判据「可读错误（非静默吞错）」不满足。**归属 scripts/ci/run-ci.mjs。**
- **RC-4（S2-13，P2）**：FEATURES.md 无指向 README 的反向锚点链接（仅正文 code 路径提及）→ 「README↔手册双向引用」缺一侧。**归属内容迭代（非门禁）。**

- 环境受限（R-18，不冒充通过）：TC-S4-12 plugins typecheck、TC-S4-13 plugins 既有套件回归 —— worktree 无 node_modules（禁网不可装），复现步骤见 §5.3。

## 1. 环境与执行方式

| 项 | 事实 |
| --- | --- |
| Node | v24.19.0（≥22.5 满足） |
| 工作区 | D:\project\DSH\legion\.legion-worktrees\T-117（w/T-117，HEAD ce87364） |
| 行尾事实 | `git config core.autocrlf=true`；无 .gitattributes；`git ls-files --eol` 显示 README.md/docs/FEATURES.md/check-docs.mjs/run-ci.mjs 均 **i/lf w/crlf**；提交 blob 实测纯 LF（282 LF / 0 CRLF），工作区文件 CRLF（282 CRLF） |
| 依赖 | 仓库根与 plugins 均无 node_modules（不随 git 分发；禁网不安装） |
| 执行方式 | L0 文档/脚本断言经 run_code 宿主进程直跑（pwsh 沙箱子进程 pipe 捕获 EPERM，T-093 先例）；S3/S5 负例注入在 **scratch/t117-lf-mirror/（LF 归一化镜像副本）** 执行——仓库真实文档零改动零残留；S4 用 scratch team-hub 实例（随机端口+独立 DB）实测 API |
| 独立性 | 内容断言用自写 harness（docs/G-mtpq729o-1/T117-evidence/assert-docs.mjs，42 项）与 check-docs.mjs 双轨互证 |

## 2. 逐用例结果（判据与证据）

图例：✅=通过 ｜ ❌=失败 ｜ ⛔=环境受限（记录复现步骤，不冒充通过）。「证据」列指向 T117-evidence/ 文件。

### 2.1 S1（TC-S1-01..15，15/15 ✅）

| ID | 期望判据要点 | 结果 | 实际 / 证据 |
| --- | --- | --- | --- |
| TC-S1-01 | docs/FEATURES.md 存在、非空、有效 MD | ✅ | 31988 字节，首行 # 标题；assert-docs S1-01；01 |
| TC-S1-02 | 标题含「功能使用介绍/使用手册」 | ✅ | 首行「# Legion 功能使用介绍」；01 |
| TC-S1-03 | 六类章节各 ≥1 ##/### 且非空 | ✅ | 六类标题齐全，章节域正文 4~99 行；01 + check-docs 同类断言 |
| TC-S1-04 | 索引 ≥18 行、5 列 0 坏列 | ✅ | F-01..F-18 恰 18 行、0 坏列；01 |
| TC-S1-05 | 索引锚点 = 真实标题 0 失效 | ✅ | 列3 锚点全部命中标题集；01 |
| TC-S1-06 | 每条功能正文小节 ≥5 行且含入口/操作 | ✅ | 18/18 小节 ≥5 行、均含入口/操作；01 |
| TC-S1-07 | 状态枚举 ∈{已上线,迭代中,遗留}；无过程叙事 | ✅ | 17 已上线+1 遗留、0 迭代中；叙事计数=0；01 |
| TC-S1-08 | 内容承接 README §2/§3/§4 并更新到当前行为 | ✅ | 手册 3.x 小节 17 ≥ README 引导 12；含三件套/Desktop/三分钟细节；01 |
| TC-S1-09 | 18 功能域（§2.5 基线）逐域有章节/索引行 | ✅ | 18 域全命中 F 行与对应小节；01 |
| TC-S1-10 | 边界：18 行下界恰通过 | ✅ | 实际恰 18 行且 ≥18 断言通过（下界=当前值，无越界误报）；01 |
| TC-S1-11 | 反：坏列（4/6 列）检出 | ✅ | 内存注入 4 列行 → cols=4≠5 检出；check-docs 同判（TC-S3-06 实测）；01/02 |
| TC-S1-12 | 反：失效锚点检出 | ✅ | 坏锚点不在标题集可检出；check-docs 锚点类校验同源；01/02 |
| TC-S1-13 | 反：注入「P1 切片 S5-S8 已交付」检出 | ✅ | 注入后计数=1 可检出；01 |
| TC-S1-14 | 反：<5 行空壳小节检出 | ✅ | 内容 0 空壳；阈值逻辑（<5 检出）经样本验证；01 |
| TC-S1-15 | 零新增依赖；无目标级目录路径 | ✅ | 纯 MD 无构建链；无 package.json 变更；无 docs/G-*/FEATURES.md 书写；01/05 |

### 2.2 S2（TC-S2-01..13，12 ✅ / 1 ❌）

| ID | 期望判据要点 | 结果 | 实际 / 证据 |
| --- | --- | --- | --- |
| TC-S2-01 | README 存在非空、当前现状口径 | ✅ | 14384 字节 MD；01 |
| TC-S2-02 | README→手册互链 ≥8 处 | ✅ | 实测 20 处 ≥ 8；01 |
| TC-S2-03 | 互链锚点 0 失效 | ✅ | 20 锚点 slug 全命中（bad=[]）；01 |
| TC-S2-04 | 与手册 ≥3 行逐字重复块 = 0 | ✅ | dup=0；01 |
| TC-S2-05 | 关键项不丢（三件套/DSH Desktop 自启/三分钟/排障主题） | ✅ | 主题均在 README 或手册之一；排障「现象→处理」行主题齐；01 |
| TC-S2-06 | 正文无 P0-P3/T-0xx 累积叙事；附录互链记录文档 | ✅ | 正文（去附录）无叙事；附录互链 P0-CONFIRMATION/P1~P3 LIVE-ROLLOUT；01 |
| TC-S2-07 | 可渲染：标题/表格/围栏结构完好 | ✅ | 围栏配对、表头+分隔行存在；01 |
| TC-S2-08 | 反/边界：`#nonexist` 锚点检出 | ✅ | headSlug 无该锚点；实测 README 断链 → check-docs FAIL README.md:63 文件+行；01/02 |
| TC-S2-09 | 边界：恰 3 行同文块 → 检出；2 行不判 | ✅ | 阈值=≥3；实际 0 重复块；样本验证计数条件；01 |
| TC-S2-10 | 反：删「三件套」→ 关键项缺失检出 | ✅ | 删除注入后二文件均无 → 可检出；01 |
| TC-S2-11 | 反：断链/目标级路径漂移检出 | ✅ | docs/G-*/FEATURES.md 模式不在 README；断链注入实测检出；01/02 |
| TC-S2-12 | 零新增依赖 | ✅ | README 纯 MD；无 package.json 变更；05 |
| TC-S2-13 | 手册首/末含指向 README 快速开始/排障的反向锚点链接 | ❌ | FEATURES.md 全文 0 个 README 锚点链接（仅 `README.md` code 路径与 §5.1/§6 语义互指）——双向引用缺「手册→README」锚链一侧；P2，非门禁项 |

### 2.3 S3（TC-S3-01..10，9 ✅ / 1 ❌）

| ID | 期望判据要点 | 结果 | 实际 / 证据 |
| --- | --- | --- | --- |
| TC-S3-01 | --help exit 0 且输出用法/校验项 | ✅ | exit 0，列出 8 项校验与用法；02 |
| TC-S3-02 | 正向：当前文档满足时 exit 0 | ❌ | 当前 checkout（CRLF）**假红 44 处 FAIL exit 1**；LF 归一化镜像 exit 0 PASS——内容无问题，脚本不兼容 CRLF 行尾（RC-1，详见 §4.1）；02/03 |
| TC-S3-03 | 覆盖 ≥3 项且含 AC-R2-2/R3-1/R3-2；去重/关键项以脚本或人工二选一 | ✅ | 8 项覆盖：索引提取/索引锚点/正文非空/README→手册锚点/段落去重/关键项不丢/无叙事/内联锚点（去重与关键项在脚本内实现）；02 |
| TC-S3-04 | 仅 node:fs/re/path 等内置，零 node_modules | ✅ | import 区仅 node:fs/path/url；05 |
| TC-S3-05 | 反：坏内联锚点 → exit≠0 报文件+锚点行；还原 exit 0 | ✅ | LF 镜像：注入 `#no-such-heading-xyz` → exit 1、FAIL docs/FEATURES.md:4；还原 exit 0；02 |
| TC-S3-06 | 反：索引坏列 → exit≠0 报索引+行；还原 exit 0 | ✅ | LF 镜像：F-18 删一列 → exit 1、行 233「索引行列数=4」；还原 exit 0；02 |
| TC-S3-07 | 反：README→手册断链 → exit≠0 报 README 文件+行；还原 exit 0 | ✅ | LF 镜像：注入坏锚点 → exit 1、README.md:63；还原 exit 0；02 |
| TC-S3-08 | 只判结构/链接/索引，不判语义 | ✅ | 脚本注释与 --help 明示 scope（I-6）；02 |
| TC-S3-09 | 边界：0 坏锚点 exit 0 / 1 坏锚点 exit≠0 | ✅ | LF 下 0→PASS、1→FAIL 实测（不误报）；02 |
| TC-S3-10 | 零第三方依赖；沙箱直跑不联网 | ✅ | 纯 node: 内置；脚本直跑无需网络；02/05 |

### 2.4 S4（TC-S4-01..15，9 ✅ / 4 ❌ / 2 ⛔）

| ID | 期望判据要点 | 结果 | 实际 / 证据 |
| --- | --- | --- | --- |
| TC-S4-01 | 生成 feature/docSync 目标链或直调 → coder/devops contracts 追加 FEATURES+README（绝对仓库相对路径） | ❌ | 追加逻辑存在（plugins:1199-1202 与 1637-1640）但**在未导出闭包内**，导出纯函数 stageContractDocs/resolveStageDocPaths 不含 docSync；hub 实测 `/api/goal{feature,docSync}` 与 `/api/create{docSync:true}` 字段被丢弃、链任务（8 岗）无 docSync → 无任何真实任务可触发（RC-2，详见 §4.2）；复刻 sim 逻辑通过（7/7）但不能替代真实链路 |
| TC-S4-02 | roles/stage-standards：coder/devops 增加「用户可见行为变更须同步手册+README」机器验收项 | ✅ | stage-standards.mjs coder 追加（:102）、devops 追加（:148），文案含豁免条款；roles.json 未被改动（只增不改岗位语义，AC-R4-5）；04 |
| TC-S4-03 | buildWorkerPrompt 对 docSync 任务提示词含「同步 FEATURES 对应小节+索引+README 引导段」；路径不被 goalize 改写 | ✅ | plugins:1385-1390 注入完整文案；goalize 仅改写 GOAL_DOC_NAMES 白名单（:454/471-475），docs/FEATURES.md 与 README.md 不在其中 → I-3 满足（源码级；运行触发受 RC-2 影响）；04 |
| TC-S4-04 | 结算登记：feature 任务存在→registered / 缺失→missing | ❌ | 登记逻辑完整（:1196-1236 幂等/digest/双写）但 docSync 永不为 true → 真实任务上不可达、无法验证（RC-2） |
| TC-S4-05 | 非 feature 任务不追加 docs 契约、不被卡 | ✅ | 无 docSync 标记不追加（plugins 条件分支）；roles coder/devops 无 docs → contractPaths=[] 不登记不卡；现状全部任务（含本批）即该形态运行正常（AC-R4-4 正向成立）；04/05 |
| TC-S4-06 | 反：feature 任务未做文档同步直接提交 → 停 in_review 有提示 | ❌ | 需 docSync=true 真实任务 → 不可达（RC-2）；停闸逻辑在源码（:1646-1653 评论「契约产出文档缺失」+ transitionTo in_review）仅复刻/源码级成立 |
| TC-S4-07 | 反：feature 只改 README 不改 FEATURES → 仍停 in_review | ❌ | 同 TC-S4-06 不可达（RC-2）；missing 判定按路径存在性（FEATURES 缺失即 missing）逻辑在，无法真实执行 |
| TC-S4-08 | 契约路径写成目标级目录 docs/G-*/FEATURES.md → 检出失败 | ✅ | 契约路径为代码硬编码绝对仓库相对路径 docs/FEATURES.md + README.md（无任何入口可写目标级变体）；goalize 白名单不含二者（I-2/I-3）；两文档正文也无目标级路径书写（TC-S1-15/TC-S2-11）；04 |
| TC-S4-09 | 条件化边界：无行为变化 bug 修复不声明 → 不追加不被卡 | ✅ | 与 TC-S4-05 同源：不声明即不追加（现状即边界态成立）；04 |
| TC-S4-10 | 幂等：重复结算不重复登记/提示不刷屏 | ✅ | settle includes 去重（:1639）+ 登记 digest 比对（:1218-1219）；sim 幂等断言过；04 |
| TC-S4-11 | 异常：登记写失败不入 missing、归因清晰、进程存活 | ✅ | :1227-1232 catch 记日志、绝不并入 missing（M2 语义，与 T-108 M2 修复一致）；单路径失败不中断整批；04 |
| TC-S4-12 | plugins typecheck 0 诊断 | ⛔ | 环境受限：无 node_modules、plugins 依赖 @deepseek-ai/* peerDeps（禁网不装）→ `tsc -p plugins/tsconfig.json --noEmit` 不可执行。复现：cd plugins && pnpm install && pnpm typecheck（宿主）。R-18 记录，不冒充通过 |
| TC-S4-13 | 既有套件回归：node --test plugins/tests/*.test.mjs | ⛔ | 环境受限：tests import ../lib/index.js（构建产物），需 pnpm install && build。静态核：roles.json 无字段语义变化；registerContractDocs 既有 stage.docs 逻辑未被改动（T-107 面）；plugins/tests 8 套件 **0 docSync 断言** → S4 机制无自动化覆盖（缺口同 RC-2 一并建议补）；04 |
| TC-S4-14 | 零新增运行时依赖 | ✅ | T-115 对 plugins/src/index.ts 仅 +16 行（docSync 消费/注释）无新 import；全批无 package.json/pnpm-lock 变更；05 |
| TC-S4-15 | 失败兜底：单路径登记抛错不中断整批、missing 记对 | ✅ | 逐路径 try/catch（:1212-1232）：existsSync 缺失 → missing 计入 continue；登记抛错 → 记日志继续下一条；05 |

### 2.5 S5（TC-S5-01..13，11 ✅ / 2 ❌）

| ID | 期望判据要点 | 结果 | 实际 / 证据 |
| --- | --- | --- | --- |
| TC-S5-01 | 阶段清单 = 六阶段 + doc | ✅ | STAGES=[env,deps,build,test,smoke,stage,doc] 7 项、doc 末位；03 |
| TC-S5-02 | 全量/--only doc：doc 阶段 PASS、无既有阶段失败 | ❌ | 真实 checkout（CRLF）：`--only doc` → doc FAIL exit 1（44 处假红，同 RC-1）；LF 镜像 → doc PASS exit 0。门禁在 Windows/CRLF checkout 假红 → 当前不可用；03/§4.1 |
| TC-S5-03 | --skip doc 且其它阶段正常 | ✅ | `--skip doc --only env` exit 0、selected=env；03 |
| TC-S5-04 | 反：坏链 → doc FAIL 且输出定位文件+行 | ✅ | LF 镜像注入坏锚点 → doc FAIL exit 1、输出 README.md:63 FAIL 行；还原 → PASS；03 |
| TC-S5-05 | --only doc 只跑 doc；--skip doc 剔除 doc | ✅ | 源码筛选逻辑 + 实测 selected 行（doc 单独 / env 剔除 doc）；03 |
| TC-S5-06 | 失败输出可查（ci.log/summary.json） | ✅ | summary.json stages=[{name:doc,status:FAIL,ms}]；ci.log 含 `[doc] -> FAIL (Nms)`；03 |
| TC-S5-07 | 反：check-docs 缺失/语法错 → doc FAIL 且可读错误 | ❌ | 临时移除 check-docs.mjs → doc 阶段 FAIL exit 1（非静默）✓，但 ci.log/输出**无可读错误细节**——stageDoc 的 tail 只保留含 PASS/FAIL 的行，模块级错误（Cannot find module）被过滤吞掉 → 「可读错误」判据不满足（RC-3，详见 §4.3） |
| TC-S5-08 | 既有阶段选择/执行逻辑不因新增 doc 回归 | ✅ | --only/--skip 语义与阶段清单保持（实测 --only env/doc、--skip doc）；运行级其余阶段需宿主（R-18 部分）；03/05 |
| TC-S5-09 | 默认全量含 doc；--skip doc 有效 | ✅ | STAGES 默认全跑含 doc；--skip doc 从 selected 剔除（源码+实测）；03 |
| TC-S5-10 | 依赖顺序：doc 依赖 check-docs 存在、注册序 env→…→doc、无循环 | ✅ | doc 调 check-docs（缺失即 FAIL 实测）；doc 末位注册；无循环依赖；03 |
| TC-S5-11 | 零新增依赖 | ✅ | run-ci imports 全 node:（child_process/fs/path/url/crypto）；无 package.json 变更；05 |
| TC-S5-12 | 输出含 `[doc] … PASS/FAIL` 可 grep 行 | ✅ | `[doc] -> PASS (97ms)` / `[doc] -> FAIL (121ms)` 实测；03 |
| TC-S5-13 | 反：坏锚点 + --skip doc → exit 0（不阻塞发布） | ✅ | LF 镜像注入坏锚点后 `--skip doc --only env` → exit 0；03 |

## 3. 失败项与根因（复现步骤 / 期望 / 实际 / 归属 / 严重度）

### 3.1 RC-1（❌ TC-S3-02、TC-S5-02）check-docs.mjs CRLF 行尾不兼容 → 门禁假红 【P0 / S3+S5】
- 复现步骤：
  1. 在 `core.autocrlf=true` 的 Windows 环境 fresh checkout 本仓库（或任何 worktree/副本）；`git ls-files --eol` 显示 README.md、docs/FEATURES.md 等 **w/crlf**；
  2. `node scripts/ci/check-docs.mjs`；
- 期望：exit 0（文档内容满足全部 8 类校验——LF 归一化镜像下确实 exit 0）。
- 实际：exit 1、44 处 FAIL（6×「缺少章节类别」+ 18×「索引锚点不存在」+ 20×「互链锚点失效」）——全部因行尾 \r：脚本逐行 `headingOf(/^(#{1,6})\s+(.+)$/)` 不带 m 旗标，无法匹配以 \r 结尾的行 → 标题集为空 → 六类/锚点/互链连锁失败。
- 证据：提交 blob 实测纯 LF（282 LF/0 CRLF）而工作区文件 CRLF（282 CRLF）；02/03 含 44 处 FAIL 输出与 LF 镜像 exit 0 对照；T-115 作者证据（01/03/04/07）之所以 PASS = 其运行于自写 LF 工作态（未经 checkout 转换），**换任何 fresh checkout/CI 即假红**。
- 归属：scripts/ci/check-docs.mjs（S3；并间接使 S5 doc 门禁在 Windows checkout 不可用）。修复方向（供将军定夺）：脚本解析前归一化 \r（`text.replace(/\r/g,'')`）或标题/行解析改用 m 旗标/逐行 strip；或仓库补 .gitattributes 强制 LF（涉及全仓策略，需将军拍板）。

### 3.2 RC-2（❌ TC-S4-01/04/06/07）docSync 机制无声明/持久化通道 → 持续同步 E2E 不可达 【P0 / S4】
- 复现步骤：
  1. scratch team-hub 实例（独立 DB）`POST /api/create {role:'coder', docSync:true, …}` → 返回任务对象**无 docSync 字段**；`GET /api/task` 亦无（对比：同模式 fileDomain 有列有读写、正常持久化）；
  2. `POST /api/goal {objective:'用户可见小功能…', feature:true, docSync:true}` → 生成的 8 岗链任务（requirement…devops）全部无 docSync；
  3. 仓库全量 grep：docSync 仅 7 处命中于 plugins/src/index.ts（3 处消费+接口字段+注释）与 stage-standards 验收项文案、scratch sim —— **无任何写入口**。
- 期望（AC-R4-1/2/4）：feature/docSync 任务 contracts 追加 FEATURES+README、缺失即停 in_review 有提示、非 feature 不误伤。
- 实际：plugins 三处 `t.docSync===true` 分支（契约追加 :1200/:1638、提示词注入 :1385）逻辑正确（源码+复刻 sim 7/7 通过）但 `t.docSync` 在真实 hub 流中恒为 undefined → **机制整体不可达**：任何任务都不会被追加 docs 契约、不会因缺手册被停闸。现状=所有任务都是「非 feature 态」（TC-S4-05/09 因此成立），等于 doc-sync 强制层没有上线。
- 归属：S4 接线 —— team-hub/server.mjs（tasks 增 docSync 列 + ensureColumn + createTask/rowToTask 读写 + /api/create 透传）+ 任务创建链路（goal 链/切片展开可带 docSync 声明，或按 RESEARCH F1 增加 breaker/派工侧声明入口）。另建议补自动化测试（plugins/tests 现 0 docSync 断言，TC-S4-13 关联）。
- 备注：TEST_CASES 假设 H-1「若实现用别的字段名仅改断言取值」未获满足的正是「字段既无声明入口也无持久化」——这是实现缺口而非测试口径问题。

### 3.3 RC-3（❌ TC-S5-07）run-ci doc 阶段错误细节被过滤 【P1 / S5】
- 复现步骤：临时把 scripts/ci/check-docs.mjs 改名 → `node scripts/ci/run-ci.mjs --only doc --out scratch/t117-ci3` → 观察输出与 ci.log。
- 期望：doc 阶段 FAIL 且输出可读错误（如 Cannot find module）。
- 实际：doc 阶段 FAIL exit 1（正确检出异常 ✓）但 ci.log/stdout 只有 `doc: 文档新鲜度校验…exit=1` + `[doc] -> FAIL (83ms)`，模块级错误被 stageDoc 的 tail 过滤（只保留含 PASS|FAIL 的行）吞掉 → 排障需另跑 check-docs 才知道原因。
- 归属：scripts/ci/run-ci.mjs stageDoc（错误路径保留原始 stderr/error 尾部即可）。

### 3.4 RC-4（❌ TC-S2-13，P2）手册缺 README 反向锚点链接
- 现象：docs/FEATURES.md 全文 0 个指向 README 的 markdown 锚点链接（README→手册 20 处互链，手册→README 仅有 `README.md` code 路径与 §5.1/§6 语义互指）。
- 影响：README↔手册「双向引用」缺一侧（AC-R3-4/AC-R2-2 反向口径为 P2）；不影响机器门禁（check-docs 不校验反向）。
- 归属：内容迭代（S1/S2 文档），建议手册序言/§5.3 补「快速开始/排障 → README §2/§6」的锚点互链。

## 4. 关键发现与对比（证据摘要）

### 4.1 CRLF 缺陷证据（T-115 作者态 vs fresh checkout）
- `git ls-files --eol`：README.md、docs/FEATURES.md、check-docs.mjs、run-ci.mjs、TEST_CASES.md 全部 i/lf w/crlf。
- 提交 blob（git cat-file）实测纯 LF；工作区 282 处 CRLF。
- T-115-evidence/01 记录的 `check-docs: PASS` 在 fresh checkout **不可复现**（当前 44 FAIL）——差异唯一来源 = 行尾（LF 镜像立即 PASS）。这是本批最需要将军知晓的「日志证据与复跑不一致」根因。
- 附带影响：仓库内其它逐行 `^…$` 解析文档的脚本存在同类风险（本批 verify-docs.mjs 因用 /gm 免于受影响，T-115 证据 02 在当前 checkout 复跑仍 25/25 PASS——对照 01 的 44 FAIL 进一步证明差异在脚本行解析方式而非文档内容）。

### 4.2 S4 接线缺口实测（scratch team-hub）
- `POST /api/create {docSync:true}` → 200，返回 task 无 docSync（无列可写，字段被静默丢弃）；GET 亦无。
- `POST /api/goal {feature:true, docSync:true}` → 8 岗链任务 0 个带 docSync。
- 对照 fileDomain：有列（ensureColumn :384）、createTask 读取（:1331）、rowToTask 输出（:491）→ 持久化通道完整；docSync 三者皆无 → 接线遗漏坐实。
- 复刻 sim（scratch/s4-docsync-sim.mjs，coder T-115 交付）7/7 通过：仅能证明「若 t.docSync===true 则追加逻辑正确」，不能证明真实可达。

### 4.3 S5-07 输出（ci.log 节选）
```
===== [doc] 文档新鲜度校验（check-docs.mjs） =====
doc: 文档新鲜度校验（check-docs.mjs）exit=1
[doc] -> FAIL (83ms)
```
（check-docs.mjs 缺失时无底层错误文本 → 归因难。）

## 5. 回归范围与结论

### 5.1 回归范围
- 本批改动文件域：README.md、docs/FEATURES.md（新建）、scripts/ci/check-docs.mjs（新建）、scripts/ci/run-ci.mjs、team-hub/stage-standards.mjs、plugins/src/index.ts（+ T117-evidence 与本报告为 T-117 新增）。
- 触碰面（不改动、须防回归）：roles.json（未被本目标改动）、team-hub 既有 stage.docs 契约登记（T-107）、run-ci 既有六阶段（env…stage）、plugins 既有 worker/artifact 套件。
- 回归结论：
  - run-ci 阶段数组仍为六阶段+doc、--only/--skip 语义保持（实测）；doc 阶段接线调用 check-docs（缺失→FAIL）——**除 RC-1 假红外接线正确**。
  - roles.json 0 改动 → 岗位/契约数据模型不变（doc-contract.test.mjs EXPECTED 与现状一致，coder 无 docs）。
  - stage-standards 仅追加 2 条 acceptance（coder/devops），岗位 do/dont 语义未改。
  - plugins/src/index.ts docSync 三处均为新增条件分支，未改动既有登记/结算主路径 → 静态看无既有功能回归风险；**动态回归（node --test plugins/tests）环境受限未执行**（TC-S4-13，复现步骤：宿主 junction 依赖后 `cd plugins && pnpm install && pnpm build && node --test tests/*.test.mjs`）。
- 文档级回归：FEATURES.md/README.md 与 README §2/§3/§4 既有内容无丢失（关键项断言全过）；T-115 收敛只迁移未删除（去重 0 块佐证未整段复制回 README）。

### 5.2 结论
1. **S1（手册+索引）15/15 与 S2 主体 12/13 通过**——首版功能手册结构/覆盖/索引/状态口径达标，可作为将军抽测与后续 doc-sync 试点的基础。
2. **S3/S5 门禁逻辑（LF 语义）正确但当前仓库态不可用**（RC-1 假红）：任何 autocrlf Windows checkout 上 doc 门禁必红 → 需先修 check-docs CRLF 兼容（或定 .gitattributes 策略），否则 S5「发布前 CI 门禁」与 R-5 机器校验在宿主上不成立。
3. **S4 持续同步机制未达上线态**（RC-2）：消费端就绪、声明/持久化端缺失 → AC-R4-1/2/4 试点闭环（REQUIREMENTS §6 验收 2/4）无法真实执行。
4. **环境受限项如实记录**（TC-S4-12/13：plugins typecheck 与套件回归、S4 流水线 L2/L3）——复现步骤见 §5.1/§2.4，未冒充通过。
5. **总体判定：本批未全绿（56 PASS / 8 FAIL / 2 受限）→ 需要修复（RC-1/RC-2/RC-3）与裁决（RC-4 是否本期补、CRLF 策略）后复测**；文档内容本身质量过关。

### 5.3 环境受限复现步骤（宿主执行，R-18）
```bash
# TC-S4-12 plugins typecheck（需依赖）
cd plugins && pnpm install && pnpm typecheck        # tsc -p tsconfig.json --noEmit
# TC-S4-13 plugins 既有套件回归（需先 build 出 ../lib）
cd plugins && pnpm build && node --test tests/*.test.mjs
```

## 6. ❓ 待将军确认（每条附倾向与依据）

- **❓ RC-1 CRLF 修复口径**：倾向「check-docs.mjs 解析前归一化 \r（最小改动、不动仓库策略）」，备选「仓库补 .gitattributes 强制 LF（全仓统一但影响面大，需评估其它脚本/工具）」。依据：提交 blob 已全 LF，问题只在 checkout 转换；归一化只影响本脚本。
- **❓ RC-2 docSync 接线补法**：倾向「team-hub tasks 增加 docSync 列 + /api/create（及 goal 链/切片展开）透传 + breaker 在 feature 切片验收行声明 feature/docSync（F1）」，补 plugins/tests 自动化断言；请将军裁决声明入口的权威位置（任务字段 vs 切片验收行文本）。
- **❓ RC-4（TC-S2-13，P2）**：是否本期由后续迭代补「手册→README」反向锚链，还是记入 backlog；本项不影响任何门禁与 AC-R1~R5 主判据。
- **❓ 修复归属**：RC-1/RC-3 归 S3/S5（可走 fix 回炉或新切片），RC-2 归 S4 接线——请将军指定派工方式（本批打回重做 or 后续目标承载）。

## 附录 A 证据清单（docs/G-mtpq729o-1/T117-evidence/）

| 文件 | 内容 |
| --- | --- |
| README.md | 本证据目录索引 |
| assert-docs.mjs | 独立内容断言 harness（S1/S2 机器行，CRLF 归一化，42 项） |
| 00-env.txt | 环境基线（node/git/autocrlf/node_modules） |
| 01-s1-s2-assert.txt | harness 输出：42 PASS / 1 FAIL（TC-S2-13） |
| 02-s3-check-docs.txt | --help；CRLF 假红 44 FAIL 输出；LF 镜像正向 exit 0；TC-S3-05/06/07 负例注入+还原；import 区 |
| 03-s5-run-ci.txt | STAGES 清单断言；CRLF --only doc FAIL / --skip doc PASS；LF 镜像正/负/skip；summary.json 与 ci.log 摘录 |
| 04-s4-review.txt | plugins docSync 三处源码走查；goalize 白名单；team-hub 无列/无透传证据；hub API 实测记录；sim 7/7；环境受限复现步骤；stage-standards 验收项行号 |
| 05-regression.txt | 改动文件域、零依赖断言（import 区/无 package.json）、回归范围与静态结论 |

复现命令速查：
```bash
node scripts/ci/check-docs.mjs                        # RC-1：CRLF checkout 上 44 FAIL（LF 下 PASS）
node scripts/ci/check-docs.mjs --help                 # 校验项 8 类
node docs/G-mtpq729o-1/T117-evidence/assert-docs.mjs  # 内容断言 42 项
node scripts/ci/run-ci.mjs --only doc                 # S5 doc 门禁
node scripts/ci/run-ci.mjs --skip doc --only env      # 可跳且其它阶段正常
node scratch/s4-docsync-sim.mjs                       # S4 复刻逻辑 7/7（仅逻辑，非真实链路）
```
