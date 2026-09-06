# T-109 测试执行报告（tester）——「环节产出文档在任务详情直接打开预览」

> 角色：测试执行（tester）｜执行任务：T-109（worktree w/T-109 @ HEAD 310002a = promote T-108，含 T-107 编码实现 S1..S7）
> 被测基线：docs/REQUIREMENTS.md（T-103 R-1..R-4 / AC-R1-x..R4-x）→ docs/RESEARCH.md（T-104）→ docs/TASK_BREAKDOWN.md（T-105 S1..S8 机器验收行）→ **docs/TEST_CASES.md（T-106，82 条用例）**——用例执行基准；前置审查意见 docs/review/T-108-REVIEW.md（M1/M2 必须修改项，本报告逐项复核）。
> 结论速览：**判定 = 非全绿**。后端数据面（S1/S2/S3/S6 L0 套件 4+7+16+10、S4 渲染 11、S3 L1 HTTP 冒烟）全绿；hub 回归 6 套件 82/82、plugins/board-plugin tsc 0 诊断全绿。**3 项可复现 FAIL**：F1（前端 workbench 在 HEAD 不可编译：App.tsx 已提交合并冲突标记 TS1185×3，T-101 F4 同缺陷仍在）、F2（M1 复核命中：docsDir 目标契约登记不感知目标级目录 → 误停 in_review / 误登记根路径旧文档，含生产 T-111 实锤）、F3（M2 复核命中：登记写失败并入 missing → 错误停闸归因）。另有多项环境受限项（沙箱 EPERM / 无浏览器 / 无宿主），按 R-18 如实登记不冒充通过。

## 1. 环境与方法

| 项 | 值 |
| --- | --- |
| 执行机 | Windows 沙箱 workspace-write、禁网、无审批；node v24.19.0；被测代码 = 本 worktree（w/T-109 @ 310002a），非 main 工作树（main 有他目标未提交改动，避免混淆） |
| 依赖 | plugins/workbench/board-plugin node_modules 经 junction 指向 main 同款（沙箱无网络安装）；plugins/lib 用 DSH checkout tsc 编译产出（exit 0，与 src 一致） |
| 分层 | L0 = node 直跑各切片契约套件；L1 = 真进程 HTTP 冒烟（hub listen + 临时双树仓库）；静态红线 = grep / git diff；缺陷复核 = 驱动真实 plugins lib apply 结算的确定性探针 + live hub 库只读核对 |
| 用例基准 | docs/TEST_CASES.md §4（82 条，S1 13/S2 10/S3 15/S4 12/S5 10/S6 8/S7 6/S8 8；P0 71/P1 11）——自动化落点 = T-107 落盘的 5 个测试文件；S5/S7/S8 前端面以 typecheck + 静态断言 + 受限记录覆盖 |
| 环境受限判据 | node 内 spawnSync/spawn 管道捕获 → EPERM（任务书记录的沙箱边界，探针见证据 10）；vite/esbuild spawn → EPERM；无浏览器 → L2 手工清单受限；无 DSH 宿主 → S7 托管态受限 |

证据目录：docs/T109-evidence/（01 环境 / 02..06 各切片套件 / 07 typecheck / 08 hub 回归 / 09 worker-regression / 10 taskctl 受限根因 / 11 L1 冒烟 / 12 静态红线 / 13 M1M2 探针 / 14 live 产物 / 15 App.tsx 冲突）；复现脚本 scratch/t109-probes/。

## 2. 用例执行矩阵（实测结果与证据）

| 切片/用例域 | 执行方式（命令） | 实际结果 | 结论 | 证据 |
| --- | --- | --- | --- | --- |
| S1 契约数据模型（TC-S1-01..06 域） | node plugins/tests/doc-contract.test.mjs | 4/4 pass；七岗 docs 逐岗存在且 path 与 prompt 一致、coder 无 docs（AC-R1-1）；{taskId} 模板展开（AC-R1-3 前置）；docs 缺省回退 artifact；JSON.parse 合法；roles.json 快照字节不变 | ✅ 通过 | 02-s1-doc-contract.txt；12-static-redline.txt |
| S2 结算自动登记/软门禁（TC-S2-01..08 域） | node plugins/tests/artifact-register.test.mjs | 7/7 pass；requirement 无 artifact 报告亦登记相对路径+digest（AC-R1-2）；reviewer 动态名展开登记（AC-R1-3）；缺失 → in_review+含期望路径提示（AC-R1-4）；gate researcher 不回归（AC-R1-5）；补全重跑闭环（G-R2）；coder 零契约登记+自填 artifact 不回退；同字节幂等/变化追加（AC-R2-3 数据源） | ✅ 通过（**注**：无 docsDir/写失败夹具 = 测试盲区，见 F2/F3） | 03-s2-artifact-register.txt |
| S3 hub 内容端点（TC-S3-01..15 域） | node team-hub/artifact-content.test.mjs | 16/16 pass；主分支态逐字一致（AC-R3-1）；分支态优先/删目录回退主仓（AC-R3-2）；存量绝对路径剥前缀（K10）；../、.git 段、他人 worktree、根外绝对路径 → 403（AC-R3-3）；错误码 404/400 可区分（K9）；512KB 截断/二进制 previewable=false（AC-R3-6） | ✅ 通过 | 04-s3-artifact-content.txt |
| S3 L1 真进程 HTTP | node docs/T107-evidence/s3-l1-smoke.mjs | RESULT: PASS；GET content 200 source=worktree 逐字；digest 落库 PASS；i=9→400、未知任务→404 | ✅ 通过 | 11-l1-smoke.txt |
| S4 渲染器（TC-S4-01..12 域） | node workbench/scripts/doc-render.test.mjs | 11/11 pass；结构可读（AC-R3-4）；script/img onerror 按文本、javascript:/data: 拒绝、白名单/相对/# 放行（AC-R3-5）；子集外语法文本回退不吞内容；真实文档 REQUIREMENTS/RESEARCH 节选渲染正常 | ✅ 通过 | 05-s4-doc-render.txt |
| S6 看板逐条 + serve.mjs（TC-S6-01..08 域） | node scrum/artifact-detail.test.mjs | 10/10 pass；render --out 逐条生成器 + 旧「仅最新一条」块移除（AC-R4-1/2）；serve /api/artifact i 逐条 + 分支态优先 + md content-type + url/file 语义 + 越界 400/未知 404/越权 403（AC-R4-3） | ✅ 通过 | 06-s6-artifact-detail.txt |
| 类型检查 | plugins / board-plugin tsc -p tsconfig.json --noEmit；workbench 同 | plugins exit 0（0 诊断）；board-plugin exit 0（0 诊断）；**workbench exit 2：App.tsx(314,1)/(328,1)/(330,1) TS1185 ×3**（唯一错误 = 冲突标记，非本批组件代码） | ⚠️ 见 F1 | 07-typechecks.txt |
| 前端构建（S5/S8 门） | workbench build 前门 tsc 已失败；vite build 触发 esbuild spawn EPERM | vite build 在加载配置阶段 spawn EPERM（环境受限，R-18 复现：esbuild 服务子进程被沙箱拒）；即便绕过 EPERM，前置 tsc --noEmit 已因 F1 失败 | ❌ FAIL（F1） | 07-typechecks.txt |
| 静态红线（I-1/I-2） | grep dangerouslySetInnerHTML（S4/S5/S6/S7 目标文件）；package.json diff | 目标文件零命中（exit 1）；92cd5e1..835dc77 package.json 五份 diff 为空 = 零新增运行时依赖 | ✅ 通过 | 12-static-redline.txt |
| hub 回归面（I-9） | goal/skills/calendar/chat/spaces/rules 六套件 | 14/14 + 20/20 + 13/13 + 23/23 + 5/5 + 7/7 = **82/82 pass**（goal.test 另覆盖 docsDir 双模式解析） | ✅ 通过 | 08-hub-regression.txt |
| plugins worker-regression（I-9） | node plugins/tests/worker-regression.test.mjs | 5/7 pass；2 条 git-init spawn 用例 EPERM（沙箱边界，环境受限） | ✅ 5 绿 + 2 受限 | 09-plugins-worker-regression.txt |
| scrum taskctl.ttl（回归面） | node scrum/taskctl.ttl.test.mjs + EPERM 探针 | 探针 {status:null,error:"EPERM"} → 套件子进程 spawn 全挂（环境受限，非代码缺陷；taskctl.mjs 未被本批改动） | 环境受限 | 10-taskctl-ttl-env.txt |
| M1/M2 审查项复核 | scratch/t109-probes/probe-m1m2.mjs（驱动真实 lib apply 结算） | **F2（M1）与 F3（M2）确定性复现**（见 §3） | ❌ FAIL | 13-m1m2-probes.txt |
| live 数据核对 | node 只读 SQLite team-hub/team.db | 当前链 T-108 契约登记 docs/review/T-108-REVIEW.md（相对路径+digest）→ 主路径登记线上生效；**docsDir 目标 T-111 契约登记 = 根路径 docs/REQUIREMENTS.md（旧文档误登记）** | ⚠️ F2 生产实锤 | 14-live-artifacts.txt |

## 3. 失败项（FAIL，均可复现；归属明确）

### F1【红·阻塞前端交付面】HEAD 的 workbench/src/App.tsx 含已提交合并冲突标记 → workbench 无法编译/构建
- 复现：`tsc -p workbench/tsconfig.json --noEmit`（或 package.json build 前置门）→ `src/App.tsx(314,1)/(328,1)/(330,1): error TS1185: Merge conflict marker encountered`，exit 2。App.tsx 314 <<<<<<< Updated upstream、328 =======、330 >>>>>>> Stashed changes（314-330 行含冲突双侧代码）。
- 影响：本批 S5（TaskDetailModal「产出文档」直达区）与 S4 组件所在的 workbench 前端在 HEAD **不可编译/构建** → AC-R2-x / S5 / S8 的 L2 浏览器验收与发布面被阻塞；T-101 F4 同缺陷自 82d610c 起至今未修。
- 归属：commit 82d610c（「resolve stash-pop 冲突」把冲突标记原样提交，作者 Mench-Li，promote/调解链产物，**非 T-107 本批实现 diff**；T-107 批内组件自身 tsc 0 诊断）。修复 = 手工解决该 3 行冲突（保留 handleSpaceDeleted 与 handlePublishGoal 二者），已超出 tester「只报告」边界。
- 证据：15-apptsx-conflict.txt；07-typechecks.txt；T-101 报告（git show 766c7df:docs/TEST_REPORT.md）F4 历史登记。

### F2【红·并行 docsDir 目标面】S2 契约登记不感知目标级 docsDir（T-108 M1 复核命中，含确定性探针 + 生产实锤）
- 复现（scratch/t109-probes/probe-m1m2.mjs，驱动真实 plugins lib apply 结算；roles.json 契约 + goal docsDir=docs/G-DIR-1）：
  - A1（worker 按提示词只写了 docs/G-DIR-1/REQUIREMENTS.md）：实际 **0 条登记** + 任务被软门禁停 in_review + 评论误报「契约产出文档缺失：docs/REQUIREMENTS.md」；期望 = 登记 docs/G-DIR-1/REQUIREMENTS.md 且照常进闸门。
  - A2（仓库根存在他目标的旧 docs/REQUIREMENTS.md）：实际**登记了根路径旧文档**（path=docs/REQUIREMENTS.md，digest 为旧内容）而真实交付物 docs/G-DIR-1/REQUIREMENTS.md 未登记；期望 = 只登记目标目录文档。
- 生产实锤：live team.db 中 T-111（goal G-mtpq729o-1，docsDir=docs/G-mtpq729o-1）契约登记条目 = `{path:"docs/REQUIREMENTS.md", title:"需求澄清产出文档", digest:…}`——即把主仓根目录他目标的旧 REQUIREMENTS.md 登记成 T-111 的产出；T-111 真文档在 docs/G-mtpq729o-1/REQUIREMENTS.md（commit 7ffa303 单文件）。任务详情预览将打开错误文档。
- 根因/归属：plugins/src/index.ts registerContractDocs（1169-1199）按 roles.json 静态 rel（resolveStageDocPaths）解析登记与判缺，未与同结算流程 gate 校验的 goalDocPath(goal, artifact)（1637）同源；T-107 实现，T-108 M1 已列「必须修改」未处理；S1/S2 测试无 docsDir 夹具（测试盲区）。
- 当前目标 G-mtpaab3x-1 docsDir=null，**主路径不受 F2 影响**（live T-108 登记正确即为证），但任何带 docsDir 的并行目标（如 G-mtpq729o-1，P2/P3 已上线的运营模式）结算即触发。

### F3【橙·容错面】登记写入失败并入 missing → 错误停闸归因（T-108 M2 复核命中）
- 复现（同一探针 B 场景）：docs/REQUIREMENTS.md 真实存在 + hub POST /api/artifact 返回 500 → 实际任务停 in_review + 评论「契约产出文档缺失」；期望 = 区分「写失败」（登记失败记 log/评论、流程继续）与「文件缺失」，不得把将军引向补文档的错误动作。
- 根因/归属：plugins/src/index.ts registerContractDocs catch（1192-1195）把任何异常 push 进 missing → 软门禁（1599-1606）误判；T-107 实现，T-108 M2 已列「必须修改」未处理；无 hub 失败路径测试用例。
- 证据：13-m1m2-probes.txt（A1/A2/B 三段实际输出）。

## 4. 环境受限项（R-18 如实登记，非产品缺陷；宿主可复跑命令给出）

| 项 | 现象 | 宿主复跑命令 |
| --- | --- | --- |
| plugins worker-regression 2 条 git-init 用例 | 沙箱 EPERM（node 内 spawn git） | node plugins/tests/worker-regression.test.mjs（宿主 git 可用时预期 7/7） |
| scrum taskctl.ttl.test.mjs（15 条） | spawnSync EPERM（探针 {status:null,error:"EPERM"}） | node scrum/taskctl.ttl.test.mjs（宿主预期 15/15，本批未改 taskctl.mjs） |
| workbench vite build | esbuild 服务子进程 EPERM；且前置 tsc 已因 F1 失败 | 修复 F1 后 pnpm --dir workbench build |
| L2 浏览器手工清单（TEST_CASES §7） | 沙箱无浏览器；且前端不可构建（F1） | 修复 F1 后按 TEST_CASES §7.1/7.2 清单逐条勾选 |
| S7 DSH 托管态（board-plugin 实弹） | 沙箱无 DSH 宿主；以 tsc 0 诊断 + 代码审查断言覆盖 | 宿主 DSH 环境按 TEST_CASES 附录 B S7 冒烟 |

## 5. 回归范围与结论

- **回归范围**：T-107 diff（33 文件，92cd5e1..835dc77）涉及全部消费方——plugins（S1/S2 纯函数+结算）、team-hub（S3 端点）、scrum（S6 render/serve）、board-plugin（S7）、workbench（S4/S5）；对应回归面 = 上述 L0 套件 + hub 六套件（82/82）+ worker-regression（5 绿）+ typecheck + 红线静态断言 + live 数据只读核对。
- **结论**：
  1. **后端数据面成立**：S1 4/4、S2 7/7、S3 16/16、S6 10/10、S4 11/11、S3 L1 HTTP PASS；hub 回归 82/82；plugins/board-plugin tsc 0 诊断；零新增运行时依赖；XSS 红线零命中。主路径（docsDir=null，本目标形态）结算登记在**生产已生效**（T-108 → docs/review/T-108-REVIEW.md 相对路径+digest）。
  2. **判定非全绿**：F1（前端不可编译，阻塞 S5/S8 UI 面与发布）、F2/F3（T-108 M1/M2 必须修改项复核命中，docsDir 并行目标与写失败容错场景错误停闸/误登记）。
  3. **建议处置**：F1 = 将军或调解侧解决 82d610c 遗留冲突标记（保留双侧函数）后重跑 workbench tsc/build → L2 清单；F2 = registerContractDocs 路径解析与 gate 同源 goalize + 增补 docsDir 夹具用例；F3 = failed≠missing 区分 + 增补 hub 失败用例；随后由 devops（T-110）回归宿主面。
- 本报告只做执行与报告，未改任何实现代码（唯一写入 = 本报告 docs/TEST_REPORT.md + 证据 docs/T109-evidence/ + 复现探针 scratch/t109-probes/；junction 型 node_modules/lib 为运行环境搭建，非代码改动）。
