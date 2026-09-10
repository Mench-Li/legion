<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-06**（commit `7ffa303`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# T-117 复测执行报告：Legion「完整功能使用介绍文档 + 功能/迭代持续自动同步」（G-mtpq729o-1）
> 角色：tester（测试执行）～阶段：测试执行～执行任务：T-117（[auto-goal]）～所属目标：G-mtpq729o-1 · software · chain
> 依据：docs/G-mtpq729o-1/TEST_CASES.md（T-114，66 条用例）→ TASK_BREAKDOWN.md（T-113，S1~S5 机器验收行）→ REQUIREMENTS.md（T-111，AC-R1~R5）→ RESEARCH.md（T-112）
> 被测交付：T-115 coder 合入（f0261fc）的 S1~S5（docs/FEATURES.md、README.md、scripts/ci/check-docs.mjs、scripts/ci/run-ci.mjs doc 阶段、team-hub/stage-standards.mjs + plugins/src/index.ts docSync 机制）+ 本轮修复（main ca9b45c / a39ba9f / 8f5591b / 022b559，见 §1）
> 证据目录：docs/G-mtpq729o-1/T117-evidence/（命令输出原件；本报告仅引用与要点摘录）
> 复测说明：本报告为 RC-1~RC-4 将军裁决（2026-09-07 08:42，v8 答复）后的复测结论；round-1 报告（8 FAIL）已被本报告取代

## 0. 结论速览（判定表 + 一句话结论）
| 切片 | 用例 | ✅ PASS | ❌ FAIL | ⏸ backlog 放行 | 判定 |
| --- | --- | --- | --- | --- | --- |
| S1 功能手册+索引（docs/FEATURES.md） | 15 | 15 | 0 | 0 | ✅ 内容全绿 |
| S2 README 收拢+互链去重（README.md） | 13 | 12 | 0 | 1（TC-S2-13，RC-4→backlog 将军裁决放行） | ⏸ 仅 backlog 项，非阻塞 |
| S3 校验脚本（check-docs.mjs） | 10 | 10 | 0 | 0 | ✅ RC-1 修复已验证（真实 CRLF 检出） |
| S4 持续同步机制（stage-standards/roles/plugins） | 15 | 15 | 0 | 0 | ✅ RC-2 接线 + V-1 修复已验证（链上 E2E + 干净检出 typecheck） |
| S5 CI doc 门禁（run-ci.mjs） | 13 | 13 | 0 | 0 | ✅ RC-3 修复已验证（失败明细可读） |
| **合计** | **66** | **65** | **0** | **1（backlog 放行）** | **复测通过 → done** |

**一句话结论**：round-1 报告的 **RC-1（CRLF 假红）/ RC-2（docSync 无声明/持久化通道）/ RC-3（stageDoc 失败明细被吞）三项缺陷均已修复并在复测中逐项验证通过**；复测另发现并修复 **V-1（P0，ca9b45c 提交树 plugins 不可 typecheck，技能 bundle 实现漏提交）**，干净检出验证通过；RC-4（TC-S2-13 FEATURES→README 反向锚链）按将军裁决记 backlog、本期放行，不构成门禁阻塞。剩余仅宿主环境受限复现步骤（R-18，见 §5.3），如实记录不冒充通过。

## 1. 本轮修复基线（main HEAD 链）
| 提交 | 内容 | 对应裁决/发现 |
| --- | --- | --- |
| ca9b45c | RC-1：check-docs.mjs 读取后 `\r\n`→`\n` 归一化再跑行正则（脚本侧，不引入 .gitattributes）；RC-3：run-ci stageDoc 失败态保留 check-docs 原始输出尾部；RC-2：docSync 纯函数 resolveStageDocPathsWithDocSync + 消费端替换 | 将军答复 RC-1/2/3 |
| a39ba9f | guardian §2 blocked 续做先 claim 再重派（answers>0），修复将军答复后任务停留 blocked 致 worker 心跳失败 | 复测现场（08:42 重派卡 blocked） |
| 8f5591b | guardian workerFailStreak 不被每轮 🟢 派工评论打断 → give-up/调解可达（防无限重派死循环） | 复测现场（3 轮失败仍自动重派不结算） |
| 022b559 | V-1：提交 skillsCache.ts 的 formatSkill/SkillBundle 实现，修复干净检出 plugins tsc TS2305 | 复测发现（04b，P0） |

## 2. 逐用例结果（判据与证据）
图例：✅=通过 ～⏸=backlog 放行（将军裁决）。「证据」列指向 T117-evidence/ 文件。
### 2.1 S1（TC-S1-01..15）：15/15 ✅
| ID | 期望判据要点 | 结果 | 实际 / 证据 |
| --- | --- | --- | --- |
| TC-S1-01..15 | 手册存在/标题/六类章节/功能索引 18 行/锚点/状态枚举/小节行数/入口操作/无叙事/承接 README/关键词覆盖/边界与负例 | ✅ | 01-s1-s2-assert.txt：S1 15/15 全 PASS（round-3 harness 实跑，断言与 check-docs 同源规则互证） |

### 2.2 S2（TC-S2-01..13）：12/13 ✅ + 1 ⏸ backlog
| ID | 期望判据要点 | 结果 | 实际 / 证据 |
| --- | --- | --- | --- |
| TC-S2-01..12 | README 非空/互链数≥8/锚点 0 失效/去重/关键项/围栏/表格/负例边界 | ✅ | 01-s1-s2-assert.txt：S2 12/12 通过项全 PASS |
| TC-S2-13 | FEATURES→README 反向锚点链接 ≥1（实际=0） | ⏸ | 01 尾部：`[FAIL] TC-S2-13 …（实际=0——将军裁决 RC-4 记 backlog 本期不补）`；将军 08:42 答复第 4 项：记 backlog，不阻塞 |

### 2.3 S3（TC-S3-01..10）：10/10 ✅（RC-1 已验证）
| ID | 期望判据要点 | 结果 | 实际 / 证据 |
| --- | --- | --- | --- |
| TC-S3-02 POS | **真实 CRLF checkout（core.autocrlf=true，无 .gitattributes，文件 w/crlf）** 下 check-docs 全绿 exit 0 | ✅ | 02-s3-check-docs.txt + 03-s3-negatives.txt：`check-docs: PASS（…8 类校验项全绿）exit=0`（round-2/3 双跑一致）；RC-1 归一化后不再 44 处假 FAIL |
| TC-S3-01/03/04/08/10 | --help/8 项覆盖/零三方依赖 import 面 | ✅ | 02：--help 列 8 项校验、imports 仅 node:fs/path/url |
| TC-S3-05/06/07/09 NEG | 坏内联锚点/4 列索引行/坏互链锚点注入 → exit=1 且 FAIL 行带行列细节；还原后 exit=0 | ✅ | 02 尾部 + 03-s3-negatives：NEG05 `FEATURES.md:284 内联锚点失败`、NEG06 `FEATURES.md:216 索引行列数 4（需 5 列）`、NEG07 `README.md:179 互链锚点失败` 均 exit=1；git blob 字节级还原后 exit=0，git diff 空 |

### 2.4 S4（TC-S4-01..15）：15/15 ✅（RC-2 + V-1 已验证）
| ID | 期望判据要点 | 结果 | 实际 / 证据 |
| --- | --- | --- | --- |
| TC-S4-01/AC-R4-1 | /api/goal {docSync:true} → 8 岗链任务字段承接：coder 1/1 true、非 coder true=0 | ✅ | 04a-hub-e2e.txt（round-3，scratch 独立 DB：fresh create、8 岗 roster）：`chain 8 tasks docSync 分布: breaker:false coder:true devops:false …（coder 1/1 true; non-coder true=0）`；goal.docSync=true type=boolean |
| TC-S4-04 | 持久化读通：GET /api/board 手工 coder 任务 {docSync:true} → true、普通任务 → false（无 undefined） | ✅ | 04a：`GET /api/board … docSync=true type=boolean; plain task -> docSync=false` |
| TC-S4-06 | /api/create {docSync:true} 透传落列；无标记/显式 false → false | ✅ | 04a：`POST /api/create {docSync:true} -> task.docSync=true; 无标记 -> false; 显式 false -> false` |
| TC-S4-07 | slice 模式 coder_Si 承接（T-031/033 true）、tester/devops false；重复展开幂等不重建 | ✅ | 04a：`coder_Si 2/2 true; tester/devops true=0`；`重复展开 -> {created:[], existed:[T-031..T-035]}` |
| 别名 | goal {feature:true} → docSync=true；默认无标记 → false | ✅ | 04a：`feature 别名 -> goal.docSync=true; 默认 -> goal.docSync=false` |
| TC-S4-12 | plugins 干净检出 typecheck（tsc -p plugins/tsconfig.json --noEmit）exit 0 | ✅ | 04b-plugins-tests.txt：ca9b45c 干净树 FAIL（TS2305 formatSkill，即 V-1）；**022b559 后干净检出（w/T-117 HEAD=022b559）tsc exit=0**（§5.2 复跑） |
| TC-S4-13 | plugins 既有套件回归（node --test tests/*.test.mjs，junction 依赖 + lib） | ✅ | 04b：`tests=52 pass=52 fail=0`（round-2/3 junction 实跑）；main 侧 54/54（含新增回归，见 05） |
| TC-S4-02/03/05/08..11/14/15 | stage-standards/roles/白名单/幂等/单路径失败不中断等静态走查 | ✅ | 04c-s4-static.txt：逐项源码行号引用（102/:148 acceptance、GOAL_DOC_NAMES、resolveStageDocPathsWithDocSync、幂等 continue、逐路径 try/catch、roles.json 0 改动、零新增运行时依赖） |

### 2.5 S5（TC-S5-01..13）：13/13 ✅（RC-3 已验证）
| ID | 期望判据要点 | 结果 | 实际 / 证据 |
| --- | --- | --- | --- |
| TC-S5-02 | --only doc（真实 CRLF checkout）exit 0 | ✅ | 03-s5-run-ci.txt：`[TC-S5-02/06/12 正向] --only doc … exit=0 … [doc] -> PASS (115ms)` |
| TC-S5-07 | check-docs 缺失（模块级失败）时 doc 阶段 FAIL **且可读错误明细不被吞** | ✅ | 03：负例注入 `README.md:179 互链锚点失败` → `exit=1 … 失败明细： FAIL: …README.md:179 …`（RC-3 修复后明细保留） |
| TC-S5-04/09/10/11/… | 负例注入→FAIL；--skip doc --only env；STAGES 顺序；import 面无新增 | ✅ | 03：S504 NEG exit=1 + summary.json failed=1；S508 全链、S509 skip、S510/511 静态断言均在录 |

## 3. 环境与执行方式
| 项 | 事实 |
| --- | --- |
| Node | v24.19.0（≥22.5 满足） |
| 工作区 | D:\project\DSH\legion\.legion-worktrees\T-117（w/T-117，复测基线 ca9b45c，证据收尾 HEAD=022b559） |
| 行尾事实 | `git config core.autocrlf=true`；无 .gitattributes；`git ls-files --eol` 显示 README.md/docs/FEATURES.md/check-docs.mjs/run-ci.mjs 均 **i/lf w/crlf**；提交 blob 全 LF，工作区文件 CRLF（round-3 00-env 实录） |
| 复测执行 | S1/S2 由自写 harness（assert-docs-r3.mjs，与 check-docs 双轨互证）；S3/S5 在 **worktree 真实 CRLF 检出**直接执行（RC-1 修复后主进程直跑；run-ci 由宿主主进程 spawn 直跑）；S4 用 scratch 独立 team-hub 实例（随机端口 + 独立 DB，8 岗 roster）实测 API；plugins 套件经 junction node_modules + lib 复现实跑 |
| 独立性 | S1/S2 判据 harness 42 项与 check-docs 同源规则双轨互证；NEG 注入均 git blob 字节级还原，git diff 空 |

## 4. 修复验证对照（round-1 FAIL → round-2 结论）
| round-1 缺陷 | round-1 判据 | round-2 修复 | round-2 验证 |
| --- | --- | --- | --- |
| RC-1（P0，TC-S3-02/S5-02）CRLF 假红 | 44 处假 FAIL | ca9b45c：check-docs 解析前 `\r\n`→`\n` 归一化 | 真实 CRLF 检出 POS exit=0 全绿；NEG 注入仍正确 FAIL（02/03） |
| RC-2（P0，TC-S4-01/04/06/07）docSync 无声明/持久化通道 | hub 无 tasks.docSync 列、/api/create 丢字段、goal 链/slice 不带标记 | ca9b45c：tasks/goal docSync 列 + createGoalChain/expandGoalSlices/api/goal/api/create 透传 + rowTo 幂等读；breaker/将军入口为声明权威 | 链上 E2E（04a）：coder 1/1、slice coder_Si 2/2、别名/默认/显式 false/幂等全绿 |
| RC-3（P1，TC-S5-07）stageDoc 失败明细被吞 | 失败只留 PASS/FAIL 尾行 | ca9b45c：stageDoc 失败态带原始输出尾部 | NEG 注入 FAIL 行含 README.md:179 明细（03） |
| V-1（P0，复测新发现，TC-S4-12）提交树不可 typecheck | 干净检出 TS2305 formatSkill | 022b559：提交 skillsCache.ts formatSkill/SkillBundle 实现 | 干净检出（w/T-117@022b559）tsc exit=0（§5.2） |
| RC-4（P2，TC-S2-13）手册缺 README 反向锚链 | 反向锚链=0 | 将军裁决记 backlog，本期不补 | 非门禁阻塞，S2 仅此 1 项放行 |

## 5. 回归范围与结论
### 5.1 回归范围
- 本轮合入内容 = f0261fc（T-115）+ ca9b45c/a39ba9f/8f5591b/022b559（RC1-3 修复 + V-1 修复），对照 cba1fb7（T-114 基线）。
- 触面（不改动、须防回归）：roles.json（未被本目标改动）、team-hub 既有 stage.docs 契约登记（T-107）、run-ci 既有六阶段（env→stage）、plugins 既有 worker/artifact 套件。
- 静态回归结论（05-regression.txt）：
  1. roles.json：cba1fb7..HEAD 0 改动 → 角色/契约数据模型不变（doc-contract.test.mjs EXPECTED 断言通过）。
  2. stage-standards.mjs：仅追加 coder/devops 各 1 条 acceptance（102/:148 带豁免条款），角色 do/dont 语义未改。
  3. team-hub/server.mjs：RC-2 为纯增量（goal/tasks docSync 列、insertGoalTask/createTask/rowToTask/rowToGoal 读写、api/goal 与 /api/create 透传、expandGoalSlices 读目标声明）；既有任务/目标读写路径行为不变（hub E2E 中默认 false、别名 boolean、读回正常幂等）。
  4. plugins/src/index.ts：docSync 消费改为纯函数 resolveStageDocPathsWithDocSync（既有 stage.docs 语义不变：非 docSync 原样返回）；T-107 登记/预算路径 M1 回归在 artifact-register 套件 52/52 通过。
  5. run-ci.mjs：仅 stageDoc 失败态输出增强 + doc 阶段保持；STAGES 六阶段 + doc 顺序与 --only/--skip 语义实测保持。
  6. 行尾事实（00-env）：README/FEATURES/check-docs/run-ci 均 i/lf w/crlf（core.autocrlf=true）；check-docs RC-1 归一化后真实 CRLF checkout 全绿。

### 5.2 干净检出复验（V-1 修复，宿主/主进程执行）
```
git worktree 指向 w/T-117（HEAD=022b559，含 skillsCache.ts 实现，无工作树 WIP）
node <repo>/workbench/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/tsc.js -p plugins/tsconfig.json --noEmit
→ exit=0（修复前 ca9b45c 干净树 exit=2 TS2305）
```
main 工作树全量：plugins tsc exit=0；node --test plugins/tests/*.test.mjs = 54/54（含 a39ba9f blocked 续做认领、8f5591b 交错 ⚠/🟢 streak 不归零等新增回归）。

### 5.3 环境受限复现步骤（宿主执行，R-18，不冒充通过）
```bash
# run-ci 全量五阶段（deps/build/test/smoke/stage）需宿主 node_modules + 可用端口：
cd <repo> && node scripts/ci/run-ci.mjs            # 宿主主进程直跑
# S4 真实守护 worker 闭环（T-107 线）需宿主 reload legion-scrum-worker / legion-mediator 插件：
# 本批修复（a39ba9f/8f5591b）随插件 reload 生效，宿主重启 profile 后由守护自身验证
```

## 6. 结论
1. **复测通过**：round-1 的 8 项 FAIL 全部解决——RC-1/RC-2/RC-3 修复均已在真实环境复测转绿，V-1（复测新发现 P0）已修复并干净检出验证；仅 TC-S2-13（RC-4）按将军裁决 backlog 放行。
2. **S1/S2 文档内容质量过线**：39/40 独立断言 + check-docs 同源互证，唯一放行项为将军裁决的 backlog 内容迭代项（非门禁）。
3. **门禁逻辑在仓库真实状态（CRLF checkout）下可用**：RC-1 归一化后 check-docs 与 run-ci doc 阶段在 autocrlf Windows checkout 上不再假红，R-5 机器校验成立。
4. **持续同步机制链路完整**：docSync 声明（goal/tasks 字段，breaker/将军入口）→ 链上任务/slice coder 承接 → plugins 消费纯函数 → 手册/README 落盘登记，E2E 实测打通（AC-R4-1/2/4）。
5. **整体判定：T-117 复测通过（65 PASS / 0 FAIL / 1 backlog 放行）→ done**，放行 T-118（devops）收尾部署。

## 附录 A 证据清单（docs/G-mtpq729o-1/T117-evidence/）
| 文件 | 内容 |
| --- | --- |
| 00-env.txt | 环境基线（round-3：node/git/HEAD=ca9b45c/autocrlf/lf-crlf 行尾事实） |
| 01-s1-s2-assert.txt | harness 输出：S1 15/15 + S2 12P + 1 backlog（TC-S2-13），RESULT pass=39 fail=1 |
| 02-s3-check-docs.txt | --help；真实 CRLF POS exit=0；NEG 05/06/07 注入+还原（行列细节）；import 面 |
| 03-s3-negatives.txt | S3 负例注入原始输出（POS/NEG exit 码对照） |
| 03-s5-run-ci.txt | S5：--only doc 真 CRLF exit 0；NEG 注入失败明细保留；--skip/顺序/summary.json/ci.log |
| 04a-hub-e2e.txt | RC-2 链上 E2E（scratch 独立 DB + 8 岗 roster）：chain 分布/slice/别名/持久化/create 透传/幂等 |
| 04b-plugins-tests.txt | TC-S4-12 typecheck（V-1 发现：干净树 TS2305 vs main 工作树 exit 0）+ TC-S4-13 套件 52/52 |
| 04c-s4-static.txt | S4 静态走查逐项（源码行号引用） |
| 05-regression.txt | 迁移语义（ensureColumn docSync）、回归范围、静态回归结论、已知残留 |
| assert-docs-r3.mjs | S1/S2 独立 harness（42 项，与 check-docs 双轨互证，round-3 版） |

复现命令速查：
```bash
node scripts/ci/check-docs.mjs                      # RC-1：真实 CRLF checkout 下全绿 exit 0
node scripts/ci/check-docs.mjs --help               # 校验项 8 类
node scripts/ci/run-ci.mjs --only doc               # S5 doc 门禁（真 CRLF exit 0）
node scripts/ci/run-ci.mjs --skip doc --only env    # 可跳且其它阶段正常
node docs/G-mtpq729o-1/T117-evidence/assert-docs-r3.mjs  # 内容断言 39P（S1/S2 机器行）
# V-1 干净检出复验：w/T-117 @ 022b559 上 plugins tsc --noEmit → exit 0
```
