# T-099 测试报告 —— 四能力切片 S1–S11 集成回归锚定（R-1 跨空间技能 / R-2 分层规范 / R-3 移除空间 / R-4 对话 AI 回复）

> 基线：worktree `w/T-099` @ main `fa9c568`（promote T-105）。切片拆分/用例口径见 `docs/TEST_CASES.md`（T-098 四能力版，与 REQUIREMENTS/RESEARCH/TASK_BREAKDOWN 的 T-103~105 预览链版本不同，以本仓 TEST_CASES 为准）。

## 0. 结论速览
- ✅ **后端（team-hub）5 套件 68 用例 0 失败**：skills 20/20 · rules 7/7 · spaces 5/5 · chat 23/23 · calendar 13/13（`node team-hub/<x>.test.mjs` 直跑形态 exit 0）。
- ✅ **插件纯函数 3 套件 17 用例 0 失败**：skills-fingerprint 6/6 · norms 7/7 · chat-responder 4/4；`tsc -p plugins/tsconfig.json --noEmit` exit 0；lib 编译产物生成。
- ✅ **workbench 前端 `tsc --noEmit` 0 诊断**；`vite build` 段在沙箱 EPERM 受限（esbuild service spawn），复现步骤见 §6——宿主可跑完整 `pnpm --dir workbench build`。
- ✅ 文档联动：README §3.1/§3.8/§3.8.1（职责总纲 + 移除空间 + 跨空间技能 + 对话 AI 回复）、LEGION.md 规范分层总纲、server.mjs 头注释 API 面更新。
- 🟡 宿主专用项（环境受限 + 复现步骤，不冒充通过）：chat-l1-smoke / responder 端到端 / GUI L2 / plugins slice·worker 回归（git spawn EPERM）——见 §6。

## 1. 切片覆盖 → 交付落点

| 切片 | 能力 | 主要落点 | 状态 |
| --- | --- | --- | --- |
| S1 | R-1 跨空间技能后端 | `team-hub/server.mjs`：listSkills 可见性（grants 引用式）、revokeSkill（过滤幂等）、general 门禁、include=pending 收口、audit.scope=技能归属 | ✅ skills 20/20 |
| S2 | R-1 UI | `workbench/src/components/SkillsPanel.tsx`：共享来源标注/只读、授权目标空间选择器、撤销、pending 收口视图；`api.ts` revokeSkill/member 参数 | ✅ tsc 0 |
| S3 | R-1 守护缓存 | `plugins/src/skillsCache.ts`（指纹刷新） | ✅ 6/6 |
| S4 | R-2 全局层载体 | `team-hub/server.mjs` rules 表/DAO/路由（MAX_RULES_LEN=3000） | ✅ rules 7/7 |
| S5 | R-2 分层注入 | `plugins/src/norms.ts`（两段合并/预算截断/legacy 逐字兼容）+ index.ts 接线 | ✅ norms 7/7 |
| S6 | R-2 规范 UI+总纲 | `workbench/src/components/RulesPanel.tsx` + Sidebar/App 接线 + README/LEGION 职责总纲 | ✅ tsc 0 + grep |
| S7 | R-3 删除语义后端 | `team-hub/server.mjs`：11 表级联删除、`GET /api/spaces/impact` 只读预检、受保护/confirm 校验 | ✅ spaces 5/5 |
| S8 | R-3 删除 UI | `SpaceSettingsModal.tsx` 危险区 type-to-confirm + 影响预检 + 删除当前空间切回全部空间；App 接线 | ✅ tsc 0 |
| S9 | R-4 回复数据面 | `team-hub/server.mjs`：chat_reply_settings、awaiting 打标、replies 队列/超龄 failed、answer/retry/fail CAS | ✅ chat 23/23 |
| S10 | R-4 守护执行 | `plugins/src/chatResponder.ts` + index.ts responder 扫单（无工具子代理、CAS 幂等、失败回写） | ✅ 纯函数 4/4 + tsc |
| S11 | R-4 UI 三态 | `ChatView.tsx`：身份泛化（general=我，其余对方）+ awaiting/replied/failed 三态 + 重试 + 🤖/模型徽标 | ✅ tsc 0 |
| S12 | 收口 | 本报告 | ✅ |

## 2. 后端 team-hub 逐套件运行记录（失败=0）

| 套件 | 命令（worktree 根） | 结果 |
| --- | --- | --- |
| skills | `node team-hub/skills.test.mjs` | ✅ tests 20 / pass 20 / fail 0（exit 0） |
| rules（S4 新增） | `node team-hub/rules.test.mjs` | ✅ tests 7 / pass 7 / fail 0 |
| spaces（S7 新增） | `node team-hub/spaces.test.mjs` | ✅ tests 5 / pass 5 / fail 0 |
| chat（含 S9 新增） | `node team-hub/chat.test.mjs` | ✅ tests 23 / pass 23 / fail 0 |
| calendar（存量回归） | `node team-hub/calendar.test.mjs` | ✅ tests 13 / pass 13 / fail 0 |

覆盖要点（对应 TEST_CASES）：S1 授权后 scope=B 两种形态（省略 member/member=role1）含 S、C 不含、revoke 后即时消失且技能仍 published、重复 revoke/grant 幂等、非 general grant/review/revoke 4xx+零审计、include=pending 仅 general（非 general 不泄 pending/rejected prompt）、pending 单查 404、源空间删除后 B 无悬空；S4 默认 getRule、saveRule upsert、>MAX 400 零落库、audit rules:update；S7 造数 11 表 removed 逐表计数、post-删除逐表 0 + scopes/spaces 干净、confirm 矩阵 4xx 零删除、software/default 受保护、非 general forceGeneral 语义、impact 只读两查零变化 + 未知 id 400、在办任务可删；S9 表自举（旧库无表自动建）、默认开/关/持久化、awaiting/非 awaiting、身份过滤自触发保护、队列含上下文（不含自身、按序）、sinceMsgId、CAS answer 后重复 skipped 单回复、超时（CHAT_REPLY_TIMEOUT_MS=200）awaiting→failed+meta.error、retry 边界 8000/8001、fail 端点幂等 + audit chat:fail；HTTP 路由契约（settings/replies 非法入参 400、/api/config 存活）。

## 3. 插件（S3/S5/S10）typecheck + 纯函数套件

- `node plugins\node_modules\typescript\bin\tsc -p plugins\tsconfig.json --noEmit` → **exit 0（0 诊断）**；`tsc -p plugins\tsconfig.json`（emit）→ lib 生成 index/skillsCache/norms/chatResponder.js。
- 纯函数套件（`node plugins/tests/<x>.test.mjs`）：**skills-fingerprint 6/6**（同量改版刷新 / 同指纹不刷新 / 顺序稳定 / 撤销移除刷新 / 空列表不崩 / 授权-撤销状态机）、**norms 7/7**（两段顺序 + 空间层后置优先声明 / 文件族组合 LEGION→AGENTS→agent.md 固定序 + 单文件 + 全缺 / 仅 LEGION 无全局逐字兼容 `REPO_RULES_HEADER` / 空输入零段 / 预算截断带真实数字 + 围栏配对 + 合计超限 / 三值法 100/101 / 全局空降级）、**chat-responder 4/4**（身份默认 <scope>-assistant + override + 非 general / 提示词含身份+标题+systemHint+按序历史+禁工具 / 不可答如实说明护栏 / 无历史不崩）。
- 既有 plugins slice-orchestration / worker-regression 套件需真实 git 工作树（`git init`/commit/merge 隔离夹具）：沙箱内 Node spawn git → EPERM（见 §6），属宿主专用；本片未触碰其被测路径（仅新增纯函数模块 + sweep 接线，index.ts 编译通过）。

## 4. 前端 workbench（S2/S6/S8/S11）

- `node plugins\node_modules\typescript\bin\tsc -p workbench\tsconfig.json --noEmit` → **exit 0（0 诊断）**（S2 SkillsPanel 共享视图/来源标注/授权目标空间选择/撤销；S6 RulesPanel 两分区 + Sidebar「📜 规范」+ App 接线；S8 SpaceSettingsModal 危险区 type-to-confirm + 影响预检 + 删除当前空间切回全部空间回调；S11 ChatView 三态/身份泛化/重试/🤖+模型徽标 + api.ts revokeSkill/fetchSkills(member)/rules/impact/deleteSpace/retryChatReply/reply-settings 帮助函数）。
- 安全断言（评审/grep）：SkillsPanel / RulesPanel / SpaceSettingsModal / ChatView 均无 `dangerouslySetInnerHTML`；AI 正文/规范内容/prompt/影响清单一律 React 文本节点或 `<pre>`/`<textarea>`。
- `pnpm --dir workbench build` 的 vite 段受限记录见 §6；tsc 段（脚本第一步）全绿 = 本沙箱可跑部分。

## 5. 文档联动
- `README.md`：§3.1 移除空间（入口/确认/级联 11 类/受保护/磁盘残留运维提示）；§3.8 对话 AI 回复（R-4）+ 技能中心跨空间共享（R-1）+ 新增「📜 规范中心」条目；§3.8.1 规范载体职责总纲表（四类载体分工/入口/优先级——空间层文件族=仓库规则、rules 全局层=跨空间规范、skills=技能内容、roles.json stage.prompt/stage-standards=岗位模板）。
- `LEGION.md`：「规范分层总纲（R-2）」节。
- `team-hub/server.mjs` 头注释 API 面更新（skills revoke/include、rules、reply-settings/replies/answer|retry|fail、spaces/impact、delete 级联说明）。

## 6. 环境受限项汇总（含复现步骤，不冒充通过）

| 项 | 现象 | 复现步骤 | 宿主预期 |
| --- | --- | --- | --- |
| workbench `vite build` | esbuild service spawn EPERM | `pnpm --dir workbench build`（沙箱）：vite 载入配置阶段 `spawn EPERM`（esbuild ensureServiceIsRunning） | 宿主执行同命令 → `tsc --noEmit && vite build` 全绿 |
| plugins 既有回归（slice-orchestration / worker-regression） | `git init 失败`（空 stderr） | `node plugins/tests/slice-orchestration.test.mjs` / `worker-regression.test.mjs`：测试内 `spawnSync('git', …)` 被沙箱 EPERM | 宿主 `node plugins/tests/<x>.test.mjs` 直跑；被测路径本片未改动 |
| chat-l1-smoke（真实进程 HTTP） | 需 spawn 子服务进程（stdio pipe 受限） | 宿主 `node team-hub/chat-l1-smoke.mjs`（startServer 内 spawn 受限）；文件已扩展 S9 断言（settings/awaiting/开关关/超龄 failed/SSE）并 `node --check` 通过 | 宿主 exit 0，断言含 S9 13 项 |
| 对话 AI 回复端到端（S10 TC-S10-01/09） | 需真实守护 + 模型通道 + 浏览器 | 宿主起 hub(:8787) + scrum-worker + workbench(:5173)，software 空间开关开 → 发消息 → ≤120s 见 `<scope>-assistant` 回复；关开关零出站；失败注入 → failed 呈现 | 三路径与 TEST_CASES 判据一致 |
| GUI L2 清单（S2/S6/S8/S11 浏览器交互） | 沙箱无浏览器 | 宿主按 TEST_CASES §4.2/4.6/4.8/4.11 L2 行逐条勾选 | 各判据通过；本片已把数据面/请求形状在 API 与套件层锚定 |

## 7. 可复跑命令清单（worktree 根；沙箱直跑形态，宿主可 `node --test`）

```bash
# L0 team-hub 套件（直跑 = 沙箱等价形态）
node team-hub/skills.test.mjs; node team-hub/rules.test.mjs; node team-hub/spaces.test.mjs; node team-hub/chat.test.mjs; node team-hub/calendar.test.mjs
# L0 插件纯函数
node plugins/tests/skills-fingerprint.test.mjs; node plugins/tests/norms.test.mjs; node plugins/tests/chat-responder.test.mjs
# 类型检查/编译
node plugins\node_modules\typescript\bin\tsc -p plugins\tsconfig.json --noEmit
node plugins\node_modules\typescript\bin\tsc -p plugins\tsconfig.json   # emit lib（gitignored）
node plugins\node_modules\typescript\bin\tsc -p workbench\tsconfig.json --noEmit
# 宿主专用（沙箱受限，见 §6）
pnpm --dir workbench build
node team-hub/chat-l1-smoke.mjs
node plugins/tests/slice-orchestration.test.mjs; node plugins/tests/worker-regression.test.mjs
```

## 8. 已知约束（测试基建，非缺陷）
- 同一 SQLite 文件被第二个 server.mjs 模块实例再次**写**入会撞 audit.seq（两实例各自按 max(seq)+1 计算 nextSeq）→ 套件内对同一 db 的第二个 import 必须只读（chat.test 已按此约束实现并用主模块回写）。
- `node --test`（spawn 子进程形态）与 Node 子进程 spawn 在沙箱 EPERM → 一律改直跑形态等价验证。
- 沙箱零新运行时依赖：S3/S5/S10 新增纯函数模块、S1/S4/S7/S9 服务端扩展均零第三方依赖；typescript 为 plugins 既有 devDependency（junction 指向主检出 node_modules，untracked）。

> 责任声明：以上命令与输出为本片在沙箱内真实执行结果；宿主受限项均附复现步骤并标注「环境受限」，未以受限代替通过。改动 diff 由守护捕获，将军可按 diff 验收。