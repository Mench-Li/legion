# T-101 测试执行报告 —— 四能力批验收测试（R-1 跨空间技能 / R-2 分层规范 / R-3 移除空间 / R-4 对话 AI 回复）

> 角色：tester（测试执行）｜执行任务：T-101（分支 w/T-101，独立 worktree）｜基线：HEAD = **dd2fbe3**（promote T-100）
> 用例基线：本 worktree 的 docs/TEST_CASES.md 现文已被 T-106「产出文档预览」链取代；四能力批唯一用例基线 = **T-098 commit 497b2d8 版 docs/TEST_CASES.md（109 条 TC-Sx-yy）**，已自 git 恢复至 scratch/baseline/（与 T-100 审查同一 AC 基线；REQUIREMENTS-T095 / TASK_BREAKDOWN-T097 同批恢复）。
> 范围：只执行与记录（不改实现）。被审实现 = T-099 commit 104f99a（promote a018666 → 82d610c → 95a1b35 → f1ed9eb T-100 → dd2fbe3）。
> 证据目录：docs/T101-evidence/（16 个编号证据文件 + README，原始命令输出）。

## 0. 结论速览（判定：**非全绿** —— 4 项可复现 FAIL，其中 3 项 = T-100 必改 M1/M2/M3 复核确认，1 项 = 新增集成回归 F4）

- ✅ **机器可跑后端/数据面 99 用例 0 失败 + L1 冒烟 35/35**（真实命令复跑，证据见 §2）：team-hub 5 套件 68/68（skills 20 · rules 7 · spaces 5 · chat 23 · calendar 13）+ goal 回归 14/14 + plugins 纯函数 17/17（skills-fingerprint 6 · norms 7 · chat-responder 4）+ chat L1 冒烟 35/35 断言。
- ❌ **F1 = T-100 M1（复核确认）**：ChatView mergeNewest 只增不覆盖 + SSE 不消费 chat:fail/chat:retry → awaiting→replied/failed 状态在**同一会话实时视图不流转**（⏳ 常驻 / ❌+重试按钮不出现）。TC-S11-02/03 未达成。归属：workbench/src/components/ChatView.tsx（T-099 产物，未修）。
- ❌ **F2 = T-100 M2（复核确认）**：registerSkill 内容改版回 pending 不清 grants → B 空间 general 复审视图（SkillsPanel 固定 member=general&include=pending）带出 A 的 pending 草稿全文 → 违 AC-R1-7「published only 才可跨空间」与外泄承诺。归属：team-hub/server.mjs registerSkill/listSkills（T-099 产物，未修）。
- ❌ **F3 = T-100 M3（复核确认）**：awaiting 超龄兜底 markStaleAwaiting 只扫最新 500 条 + listAwaitingReplies「先 LIMIT min(n*4,800) 再过滤」+ 守护扫单恒 sinceMsgId=0 无游标 → 高活跃空间产生**幽灵 awaiting**（不进队列、永不 failed、UI 永久 ⏳）→ AC-R4-4 兜底语义缺口。归属：team-hub/server.mjs 1003-1048 行 + plugins/src/index.ts sweepChatReplies（T-099 产物，未修）。
- ❌ **F4（新增缺陷，T-100 未见——审查快照 a018666 早于引入提交）**：**HEAD 的 workbench/src/App.tsx 314-330 行含已提交的合并冲突标记**（<<<<<<< Updated upstream … >>>>>>> Stashed changes）→ workbench tsc --noEmit TS1185 ×3 失败 → 四能力 UI（S2/S6/S8/S11）所在前端在 HEAD **无法编译/构建**。归属：commit **82d610c**（「resolve stash-pop 冲突」把冲突标记原样提交；位于 promote T-100 链 a018666→dd2fbe3 之间；作者 Mench-Li，非 T-099 实现 diff）。
- ⚪ **O2 复核结论修正**：T-100 建议项 O2 声称「retryChatReply 取 .task 得 undefined → 每次重试报错」——HTTP 实测（真实 server.mjs 进程）三个 chat 写接口响应均为 {ok:true, task}，api.ts 的 .task 消费链一致、task 可取、retry 后 aiStatus 正确回 awaiting → **未复现**（另记录：POST /api/chat/replies/fail 的 task={skipped,source} 非消息本体，但唯一调用方 plugins chat-responder 不消费返回值，无用户影响）。
- ⚠️ 环境受限项（如实登记 + 复现步骤，不冒充通过）：vite build（esbuild spawn EPERM，T-047/T-060 同因先例）；浏览器 L2（F4 修复前构建不可行，全 UI 层无法逐条勾选）；plugins worker-regression / slice-orchestration（沙箱禁 git 子进程夹具：实测 git init 失败）；宿主守护端到端（S10 真实一轮 ≤120s 回复需宿主守护+LLM 通道）。

## 1. 环境

| 项 | 值 |
| --- | --- |
| node | v24.19.0（node:sqlite 可用，team-hub 零第三方依赖直跑） |
| 基线 | worktree w/T-101 @ dd2fbe3（promote T-100）；git status 初始干净（无 WIP 需续作） |
| deps | plugins/workbench node_modules = 主仓库 junction（main repo 既有 install）；plugins 无 typescript 二进制 → 借 workbench 内 tsc（与 T-100 同法） |
| plugins/lib | 由本树 TS 现场编译（noEmit exit 0 → emit exit 0，见 evidence 16） |
| 执行纪律 | 只跑真实命令留证；不改任何实现文件；不 push；沙箱禁写共享 .git → 改动留 worktree 由守护捕获 diff |

## 2. 执行记录（命令 → 结果 → 证据文件）

| # | 命令（worktree 根） | 结果 | 证据 |
| --- | --- | --- | --- |
| L0-1 | node plugins/tests/skills-fingerprint.test.mjs | ✅ 6/6 fail 0 | docs/T101-evidence/01 |
| L0-2 | node plugins/tests/norms.test.mjs | ✅ 7/7 fail 0 | 02 |
| L0-3 | node plugins/tests/chat-responder.test.mjs | ✅ 4/4 fail 0 | 03 |
| L0-4 | node team-hub/skills.test.mjs | ✅ 20/20 fail 0 | 04 |
| L0-5 | node team-hub/rules.test.mjs | ✅ 7/7 fail 0 | 05 |
| L0-6 | node team-hub/spaces.test.mjs | ✅ 5/5 fail 0 | 06 |
| L0-7 | node team-hub/chat.test.mjs | ✅ 23/23 fail 0 | 07 |
| L0-8 | node team-hub/calendar.test.mjs（存量回归） | ✅ 13/13 fail 0 | 08 |
| L1-1 | node team-hub/chat-l1-smoke.mjs（真实 HTTP 子进程 ×3 + SSE + 鉴权 + 超龄兜底） | ✅ 35/35 断言 + 进程级异常 0 | 09 |
| R-1 | node scratch/repro/m1-merge-ghost.mjs（ChatView 合并/SSE 逻辑逐字转写推演） | ❌ 3 FAIL（A2/B1/B2） | 10 |
| R-2 | node scratch/repro/m2-leak.mjs（server.mjs DAO 直调真实库） | ❌ 1 FAIL（草稿泄漏实证） | 11 |
| R-3 | node scratch/repro/m3-ghost.mjs（DAO 直调；CHAT_REPLY_TIMEOUT_MS=100 注入） | ❌ 2 FAIL（M3-1 兜底漏网 / M3-2 队列饥饿）+ 对照组 PASS | 12 |
| R-4 | node scratch/repro/o2-unwrap.mjs（真实 HTTP 服务进程） | ✅ 7/7 PASS（O2 未复现） | 13 |
| T-1 | node workbench/node_modules/typescript/bin/tsc -p workbench/tsconfig.json --noEmit | ❌ **3 error TS1185**（App.tsx 314/328/330 冲突标记） | 14/15 |
| T-2 | node workbench/node_modules/typescript/bin/tsc -p plugins/tsconfig.json --noEmit | ✅ exit 0（0 诊断） | 16 |
| T-3 | node team-hub/goal.test.mjs（82d610c 新特性回归面，防 server.mjs 合并破坏） | ✅ 14/14 fail 0 | 控制台留证 |
| B-1 | node workbench/node_modules/vite/bin/vite.js build --config workbench/vite.config.ts | ⚠️ spawn EPERM（esbuild 服务子进程；沙箱既有边界） | scratch/vite-attempt.txt |
| B-2 | node plugins/tests/worker-regression.test.mjs | ⚠️ git init 失败（沙箱禁 git 子进程夹具；宿主专用） | 控制台留证 |

## 3. 切片 / 用例 → 结果映射（四能力批，TC 号取 T-098 基线）

| 切片 | 能力面 | 机器可跑部分 | UI/宿主部分 | 结论 |
| --- | --- | --- | --- | --- |
| S1 | R-1 后端共享 | skills.test 20/20（TC-S1-01..11 落套件；P1 并发 TC-S1-13 未入套件） | — | ✅ 基本语义通过；F2 见 M2 泄漏 |
| S2 | R-1 UI | api 形态静态核对 + grep（SkillsPanel 空间视图固定带 member=general&include=pending） | L2 浏览器清单（TC-S2-01..09）不可执行（F4） | ⚠️ F4 阻塞 |
| S3 | R-1 缓存指纹 | skills-fingerprint 6/6 | — | ✅ |
| S4 | R-2 后端 | rules 7/7（TC-S4-01..06） | — | ✅ |
| S5 | R-2 注入 | norms 7/7（TC-S5-01..06/08） | — | ✅（O8 legacy 截断边界建议项仍成立） |
| S6 | R-2 UI | RulesPanel 静态 + tsc（O5 dirty、O6 3000 硬编码建议项仍成立） | L2 不可执行（F4） | ⚠️ |
| S7 | R-3 删除后端 | spaces 5/5（造数级联/保护矩阵/confirm/在办可删） | — | ✅ |
| S8 | R-3 删除 UI | SpaceSettingsModal 静态 + api.deleteSpace 接线核对 | L2 不可执行（F4） | ⚠️ |
| S9 | R-4 数据面 | chat 23/23 + L1 smoke 35/35（TC-S9-01..13 落套件） | — | ✅ 数据面正确；F3 大库窗口缺陷 |
| S10 | R-4 守护 | chat-responder 4/4 + index.ts 扫单静态核对 | 宿主 E2E TC-S10-09 受限 | ✅ 纯函数；⚠️ 宿主 E2E；F3 涉守护无游标 |
| S11 | R-4 UI 三态 | ChatView 三态骨架/渲染安全静态核对 | L2 不可执行 + **F1**（实时流转/失败重试） | ❌ F1（TC-S11-02/03） |
| S12 | 集成回归收口 | 本报告 §2/§6 | — | ❌ 非全绿（F1-F4） |

## 4. FAIL 明细（复现步骤 + 归属；只报告不改代码）

### F1（= T-100 M1，复核确认）ChatView AI 三态/失败重试不实时流转
- 位置：workbench/src/components/ChatView.tsx mergeNewest（159-176 行：167-172 只追加 id > 当前 maxId 的新消息，同 id 源消息不覆盖）；SSE 分支（181-198 行只消费 chat:message / chat:create）。
- 复现（推演脚本 scratch/repro/m1-merge-ghost.mjs，合并算法与 SSE 分发逐字转写自源码）：① 视图已有源消息 id=1（meta.aiStatus=awaiting，发送后本地合并所致）；② 服务端源消息被 CAS 置 replied 并落回复 id=2；③ 触发 mergeNewest → 本地 = [id1(仍 awaiting), id2] → 源气泡 ⏳ 常驻（A2 FAIL）；④ 失败路径：服务端 chat:fail/chat:retry 帧到达 → SSE 无分支消费（B1 FAIL），15s 轮询 mergeNewest 只追加不覆盖 → failed 态永不呈现 → ❌ + 重试按钮永不出现（B2 FAIL）；⑤ 修复假设对照：整页 mergeById 合并则正确流转（C PASS）。
- 期望：TC-S11-02/03（awaiting→replied/failed→重试实时流转）。
- 归属：T-099 ChatView.tsx（T-100 已报 M1，复核确认未修）。

### F2（= T-100 M2，复核确认）共享技能改版回 pending 期跨空间带出草稿
- 位置：team-hub/server.mjs registerSkill 762-763 行（内容变化分支只 UPDATE 内容/status/contentHash，grants 列未动）+ listSkills 787-800 行（includePending 时 status 过滤失效，grantedByScope 仍命中）。
- 复现（DAO 直调真实库，scratch/repro/m2-leak.mjs）：① A=software 注册 s-csharp → publish → grant [scope:marketing]；② B=marketing published-only 列表含 S（正向 PASS）；③ A 改版（prompt=v2-SECRET…）→ status=pending v2 且 grants 原样保留（根因实证 PASS）；④ B published-only 不再含 S（正确 PASS）；⑤ listSkills({scope:marketing, member:general, includePending:true})（= SkillsPanel 空间视图固定请求形态）→ **返回含 S 且 prompt=v2-SECRET 全文（FAIL）**。
- 期望：AC-R1-7 / TC-S1-07 —— pending/rejected 草稿跨 scope 零泄漏（general 复审视图只应在归属 scope 见草稿）。
- 归属：T-099 team-hub/server.mjs（T-100 已报 M2，复核确认未修）。

### F3（= T-100 M3，复核确认）awaiting 兜底/回复队列仅覆盖窗口 → 幽灵 ⏳
- 位置：team-hub/server.mjs markStaleAwaiting 1005 行（ORDER BY id DESC LIMIT 500 全 scope 窗口）+ listAwaitingReplies 1031 行（先 id>since ASC LIMIT min(n*4,800) 再 JS 过滤）+ plugins/src/index.ts sweepChatReplies 2219 行（GET /api/chat/replies 恒不带 sinceMsgId 游标）。
- 复现（DAO 直调，scratch/repro/m3-ghost.mjs，注入 CHAT_REPLY_TIMEOUT_MS=100）：控制组（<80 条消息）awaiting 入队可取、超龄→failed（PASS，窗口内语义正常）；主场景 80 条普通消息 → awaiting 消息 id=82 → 再灌 500 条（总 581 条）：超时后触发兜底 → id=82 不在最新 500 窗口 → **仍 awaiting（M3-1 FAIL，应 failed）**；守护同款拉取（sinceMsgId=0&limit=20 → 只查前 80 行）→ **队列不含 id=82（M3-2 FAIL）** → 幽灵 awaiting：不进队、永不 failed、UI 永久 ⏳。对照：窗口内新 awaiting 超龄正常 failed（PASS → 差异仅在窗口边界）。
- 期望：AC-R4-4 —— 任何超龄 awaiting 最终被标 failed 退出；队列能让守护取到全部待答 awaiting。
- 归属：T-099 team-hub/server.mjs + plugins/src/index.ts（T-100 已报 M3，复核确认未修）。

### F4（新增，T-100 未覆盖）HEAD workbench/src/App.tsx 含已提交的合并冲突标记 → 前端不可编译
- 位置：workbench/src/App.tsx 314-330 行：314 <<<<<<< Updated upstream；328 =======；330 >>>>>>> Stashed changes（冲突两侧代码均被保留：R-3/S8 的 handleSpaceDeleted 对撞 goal 侧注释文本）。
- 复现：node workbench/node_modules/typescript/bin/tsc -p workbench/tsconfig.json --noEmit → App.tsx(314,1)/(328,1)/(330,1): error TS1185: Merge conflict marker encountered（exit 2）。全文仅这 3 个错误 → 四能力四个 UI 组件自身 0 诊断，仅 App.tsx 壳无法通过。
- 引入提交：82d610c（a018666→dd2fbe3 之间，消息「…合并外部 promote 残留（resolve stash-pop 冲突）」，作者 Mench-Li）。T-100 审查快照 a018666 无此问题 → T-099/T-100 各自声明的「workbench tsc 0 诊断」在各自快照成立，但 promote T-100 后 HEAD 已回归。
- 影响：前端 tsc/build 全线失败 → S2/S6/S8/S11 的 L2 验收与发布在 HEAD 不可执行。
- 归属：82d610c（守护/自动化侧的跨批 promote 合并把冲突标记提交入库；非 T-099 实现 diff）。

## 5. 环境受限项（如实登记 + 复现步骤，不冒充通过）

| 项 | 现象/复现 | 宿主预期 |
| --- | --- | --- |
| vite build | node workbench/node_modules/vite/bin/vite.js build → Error: spawn EPERM（esbuild 服务子进程；T-047/T-060 同因） | 修复 F4 后 cd workbench && pnpm build |
| 浏览器 L2（TC-S2/S6/S8/S11 逐条勾选） | 构建不可行（F4）+ 无浏览器通道 | 修 F4 → build → 按 T-098 §7 清单勾选（F1 修复后重点验三态实时流转与重试路径） |
| plugins worker-regression / slice-orchestration | 实测 git init 失败（沙箱禁 git 子进程夹具，T-091 同因） | 宿主跑全套件 |
| S10 宿主端到端 | 发送 → ≤120s 收到 <scope>-assistant 回复 / 关开关零出站 / 失败注入 → failed 呈现 | 宿主守护 + LLM 通道（TC-S10-09）；本沙箱已绿数据面与纯函数 |
| git 提交 | 沙箱禁写共享 .git（index.lock Permission denied）→ 改动留 worktree 由守护捕获（T-091 同例） | 守护 promote 时捕获 diff |

## 6. 回归范围与结论

- **回归范围**：四能力批（R-1..R-4 / S1-S12）全文件域 + 相邻集成面。已跑：team-hub 全 6 套件（含 calendar 存量、goal 新特性防 server.mjs 合并破坏）85+ 用例、plugins 纯函数 17/17 + tsc、chat L1 冒烟 35/35、XSS grep（零 dangerouslySetInnerHTML 直插服务端文本；ChatView 第 69 行仅注释声明）。未回归/待宿主：vite build、浏览器 L2、plugins git 夹具套件、宿主守护 E2E、workbench 壳 tsc（F4 阻塞）。
- **结论**：四能力后端语义与数据面（R-1/R-2/R-3/R-4 DAO/HTTP 层）实测全部通过，与 T-100 审查一致；但**验收判定非全绿**：
  1. T-100 三项必改（M1/M2/M3）独立复跑**全部复核确认仍在**（F1/F2/F3，附最小复现脚本 scratch/repro/；改动量均小：F1≈8 行、F2≈2-3 行 + 1 断言、F3 需 awaiting 游标/专用查询或显式登记窗口边界）。
  2. **新增集成回归 F4**：82d610c 把合并冲突标记提交进 workbench/src/App.tsx，HEAD 前端无法 tsc/build —— 当前最优先修复项（阻塞 S2/S6/S8/S11 全部 L2 验收与发布）。
  3. T-100 O2 建议项 HTTP 实测**未复现**（.task 消费链一致），建议降级/关闭；O1（CSS 缺失）、O3（retry 无 failed-only 前置）、O5（RulesPanel dirty）、O6（前端 3000 与后端 env 脱钩）、O7（读接口鉴权）、O8（legacy 截断边界）建议项仍成立。
- **放行建议（供将军/宿主）**：F4 → F1+F2（集中小改、风险低）→ F3（可紧随）→ 宿主补跑 §5 清单后按 T-098 §7 完成 L2 勾选。