# T-045 验收证据 —— S1：team-hub 扩表扩 /api/chat/* + 审计/SSE

> 角色：coder｜波次：1｜任务号：T-045｜分支：w/T-045（worktree）
> 范围：team-hub 对话中心后端（conversations/messages 建表与迁移、/api/chat/* REST、审计 chat:*/SSE 广播、chat 契约测试）
> 对照：docs/TASK_BREAKDOWN.md S1 AC1..AC6；docs/TEST_CASES.md TC-S1-01..18

## 0. 基线与本任务改动说明

- worktree 基线 = main @ f5975ac（promote T-042）。该基线已含上一轮经 promote 合入的 S1 实现
  （team-hub/server.mjs 的 chat 建表 + 老库自动建表 + DAO + /api/chat/conversations|messages REST +
  统一写纪律 audit/SSE + GET /api/activity 审计可查），chat.test.mjs 亦随基线存在。
- 本任务对基线完整复验（DAO 级 13 用例、REST/SSE/鉴权 L1 冒烟、typecheck/build、skills 回归），
  复验中未发现需修改的实现缺陷：TC-S1-01..17 在真实 HTTP/SSE 上逐条通过。故不改动
  server.mjs 行为代码（对已全绿实现做无意义 churn 反而违背「不绕过测试、改动只在任务范围」纪律）。
- 本任务交付（把验收要求的「事件冒烟」从一次性脚本固化为可重复执行的测试资产 + 证据）：
  1. team-hub/chat-l1-smoke.mjs（新增，S1 测试资产，零第三方依赖）——起两个真实 server.mjs
     （无 token / TEAM_HUB_TOKEN=tk），随机端口 + 临时库 + /api/config.db 实例确认，逐条断言
     TC-S1-01..17 共 22 项（含 SSE live 事件 ≤5s、订阅断开不崩、401/200 鉴权矩阵）；失败退出码非 0。
  2. docs/T045-evidence/（本目录）：README（本文件）+ 三次运行原始输出
     （01-chat-dao-test.txt / 02-skills-regression.txt / 03-chat-l1-smoke.txt）。

## 1. 验收标准逐条对应

| 验收标准 | 结果 | 证据（命令 + 输出要点） |
| --- | --- | --- |
| chat.test.mjs 全绿 + 事件冒烟（含 scope 隔离 / author 必填 / 分页） | 通过 | 见下方逐条；事件冒烟 = L1 冒烟 TC-S1-14（真实 SSE） |
| 实现满足验收标准与用例；真实跑过 typecheck / build / 测试并在证据给出命令与输出要点 | 通过 | 见 §2 命令表（全部真实执行，输出存本目录） |
| 改动仅在任务范围内；新引入依赖有说明 | 通过 | 改动仅 team-hub 域测试资产 + 本证据目录；package.json 零新增（TC-S1-18） |

### 1.1 chat.test.mjs 全绿（13/13）

命令：node team-hub/chat.test.mjs  → tests 13 / pass 13 / fail 0（TC-S1-01..13、TC-S1-16；套件 5）。
用例覆盖：会话创建与 scope 过滤列表（TC-S1-01/02）、反向隔离 + 跨 scope 写不串（TC-S1-03）、
kind 枚举与缺 by 拒绝且无审计留痕（TC-S1-04/05）、author=by 防冒名（TC-S1-07）、分页 10/10/5 无重
无漏升序 + before 游标（TC-S1-08）、边界（空会话/超界/非法 limit）（TC-S1-09）、未知会话（TC-S1-10）、
空正文（TC-S1-11）、长度 8000/8001（TC-S1-12）、chat:* 审计留痕形状（TC-S1-13）、老库自动建表 + 存量无损（TC-S1-16）。
原文：01-chat-dao-test.txt（尾行 pass 13 / fail 0，exit 0）。

### 1.2 事件冒烟（scope 隔离 / author 必填 / 分页 在真实 HTTP/SSE 上的 L1 断言）

命令：node team-hub/chat-l1-smoke.mjs  → 22/22 断言通过，进程级异常 0（exit 0）。关键行：
- scope 隔离：TC-S1-02 software 列表不含 default 会话 / TC-S1-03 default 列表查不到 software 会话（PASS）
- author 必填与绑定：TC-S1-05 ① 缺 by → 400「缺少操作者身份 by」/ TC-S1-07 author 冒名被服务端绑定（PASS）
- 分页：TC-S1-08 分页 10/10/5：无重无漏、页内升序、页间游标连续 / TC-S1-09 空会话 []、limit=0/abc → 400（PASS）
- 事件冒烟（SSE）：TC-S1-14 订阅 /api/events 期间写入 ≤5s 收到 live chat:message
  → 收到事件 {"seq":34,...,"member":"coder","scope":"software","action":"chat:message","detail":{"conv":1,"msg":29,"kind":"text"}}
- 订阅断开韧性：TC-S1-15 断开不崩服务、其余订阅端仍收到事件（PASS）
- 审计可查：TC-S1-13 /api/activity 含 chat:create / chat:message（member/scope/detail 形状）（PASS）
- 鉴权矩阵：TC-S1-17 ①② 无/错 token 写 → 401「Bearer token 无效」；③ 对 token → 200；④ 无 token 读 → 200 放行（PASS）
原文：03-chat-l1-smoke.txt（尾行 L1 冒烟汇总：22/22 断言通过，exit 0）。

### 1.3 回归：skills.test.mjs 12/12（同一 server.mjs 未破坏既有模块）

命令：node team-hub/skills.test.mjs  → tests 12 / pass 12 / fail 0（exit 0）。原文：02-skills-regression.txt。

## 2. 真实执行过的验证命令与输出要点

| 命令（在 worktree 根执行） | 结果要点 |
| --- | --- |
| node --version | v24.19.0（内置 node:sqlite 可用，零新增依赖前提成立） |
| node team-hub/chat.test.mjs | pass 13 / fail 0，exit 0 |
| node team-hub/skills.test.mjs | pass 12 / fail 0，exit 0 |
| node team-hub/chat-l1-smoke.mjs | 22/22 断言通过，进程级异常 0，exit 0 |
| node D:/project/DSH/dsh/deepseek-harness/node_modules/typescript/bin/tsc -p team-hub/tsconfig.json --noEmit | exit 0（typecheck 0 错误） |
| node D:/project/DSH/dsh/deepseek-harness/node_modules/typescript/bin/tsc -p team-hub/tsconfig.json | exit 0（build 产出 lib/index.js + lib/types/index.d.ts，gitignore 不入库） |

说明：复用本地 DSH checkout（D:/project/DSH/dsh/deepseek-harness）的 typescript，与
team-hub/scripts/build.sh 的约定一致；team-hub/node_modules 以 junction 指向该 checkout 的 vendor 包，
全部本地，未联网、未安装任何新依赖。

## 3. 假设与边界说明

- 假设 1：本任务验收对象 = docs/TASK_BREAKDOWN.md S1（AC1..AC6）与 docs/TEST_CASES.md TC-S1-01..18；
  基线已含上一轮合入的 S1 实现且复验全绿，故本任务以「复验 + 固化事件冒烟资产 + 证据」交付，
  不重写等价实现（重写会制造与既有全绿代码的不必要冲突面）。
- 假设 2：沙箱内 node --test 因 spawn EPERM 受限，chat.test.mjs 直跑等效（文件头已注明宿主环境
  亦可 node --test team-hub/chat.test.mjs）；L1 冒烟以子进程 stdio ignore 起真实服务（沙箱允许路径）。
- 改动文件清单（git diff 范围）：team-hub/chat-l1-smoke.mjs（新增）；docs/T045-evidence/*（新增证据）。
  team-hub/server.mjs / chat.test.mjs / package.json 零改动；零新增运行时依赖（TC-S1-18：只用
  node:sqlite / node:http / node:child_process / node:fs 内置模块）。

## 4. 附：本地提交说明（沙箱限制）

- 本 soldier 会话的文件沙箱为 workspace-write 且仅覆盖 worktree 目录
  （D:/project/DSH/legion/.legion-worktrees/T-045），.git 元数据位于其外
  （D:/project/DSH/legion/.git/worktrees/T-045），git add/commit 写 index.lock
  被拒（Permission denied）；本会话禁用提权，故不强行绕过 git 内部结构。
- 改动以未提交工作树状态留在 w/T-045 分支（变更文件：team-hub/chat-l1-smoke.mjs、
  docs/T045-evidence/*），由守护/将军在验收与 promote 时按既有流程提交与合并。

