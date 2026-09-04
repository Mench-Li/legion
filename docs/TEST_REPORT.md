# T-061 测试执行报告（tester）—— S1 team-hub 扩表扩 /api/chat/* + 审计/SSE

> 角色：tester（测试执行）｜任务：T-061｜分支：w/T-061（独立 worktree）｜日期：2026-09-04
> 测试对象：S1 对话中心后端——team-hub 扩表（新增 conversations / messages 两表）、扩 /api/chat/conversations|messages REST、审计（chat:create / chat:message 统一走 audit()，by 必填 + SSE 广播）、SSE（复用既有单一 /api/events 流，按结构事件广播 chat:*）。
> 被测基线：S1 实现已由 promote T-042 / T-045 合入本分支（HEAD = 8c5903b "promote T-058"，其后无再触碰 server.mjs 的 S1 提交）→ 本阶段按该已合入基线复验 S1，未改任何实现代码。
> 依据用例：docs/TEST_CASES.md §S1（TC-S1-01..18）+ TASK_BREAKDOWN S1 AC1..AC6。
> 取代声明：本报告取代 docs/TEST_REPORT.md 上版（T-058 S3 报告；git 历史可回溯）。本阶段只执行与记录：不修 bug、不改实现代码；证据 = 真实命令输出（存 docs/T061-evidence/）。

---

## 0. 结论速览

| 结论 | 说明 |
| --- | --- |
| 判定：全绿 | S1 对话中心后端（扩表 + 扩 /api/chat/* + 审计/SSE）全部实测通过，无失败项。功能契约、scope 隔离、by 写纪律 + author 绑定、分页不重不漏、正文长度上限、审计留痕、SSE ≤5s、鉴权 401/200 矩阵、老库自动建表迁移——逐条验证成立。 |
| L0 契约 | chat.test.mjs 13/13（suites 5）、skills.test.mjs 12/12（suites 5）、contracts.test.mjs 56/56（suites 8）——均 exit 0 |
| L1 真实进程 | chat-l1-smoke.mjs 22/22 断言通过、进程级异常 0（真实 server.mjs ×2 + 随机端口 + 临时库） |
| L1 SSE 延迟 | live chat:message 推送 avg 234ms（min 229 / max 241），远低于 ≤5s 验收（TC-S1-14） |
| 静态 | 零新增运行时依赖（package.json dependencies: {}；S1 文件 imports 全 node: 内置）；team-hub typecheck 仅因 worktree 缺 @types/node（env 限制）未跑通——S1 为纯 JS、不在 TS 构建图，见 §3 |
| 回归 | 同模块 skills 12/12、L0 全量基线 contracts 56/56 全绿；S1 改动集中于 team-hub/server.mjs（+新增 chat 测试资产），未触前端/其他模块（详见 §4） |

---

## 1. 执行环境与方式（环境 / 步骤 / 实际结果 / 日志证据）

- 环境：Windows 沙箱（workspace-write，禁网）；node v24.19.0（唯一运行时，提供 node:sqlite）；零第三方依赖下载。
- 工作目录：D:/project/DSH/legion/.legion-worktrees/T-061（分支 w/T-061）。本阶段只产出报告与证据，未改任何实现代码。
- 执行方式：
  - L0：node team-hub/chat.test.mjs、node team-hub/skills.test.mjs、node tests/contract/contracts.test.mjs（node:test 进程内直跑等效，沙箱 spawn 受限时同 T-039 §2 注）。
  - L1：node team-hub/chat-l1-smoke.mjs——spawn 两真实 server.mjs 子进程（无 token / token=tk），随机端口 + 独立临时库，以 /api/config 回读 db 路径确认真实实例后再断言；覆盖 REST / SSE / audit / 鉴权 22 项断言。
  - SSE 延迟：自建探针 docs/T061-evidence/sse-latency.mjs——起真实 server.mjs，订阅 /api/events 等待回放刷完，连续 3 次 POST 写消息，测 POST→live chat:message 事件 TTFB。
- 日志证据（真实命令输出，存 docs/T061-evidence/）：01-chat-dao.txt、02-skills-regression.txt、03-chat-l1-smoke.txt、04-contracts-baseline.txt、05-sse-latency.txt、06-typecheck.txt；另 node --check 对 server.mjs / 三个测试脚本均 exit 0。

---

## 2. 用例执行结果（TC-S1-01..18；每行 前置/步骤/实际结果，判据 = TEST_CASES「期望结果」列）

| 用例 | 判定 | 实际结果（证据） |
| --- | --- | --- |
| TC-S1-01 🟢P0 创建会话 | ✅ PASS | L0：createConversation → id>0、createdAt/updatedAt 有值、last_message_at=null；列表含新会话且按 updatedAt desc 排首。L1：POST /api/chat/conversations → 200 ok:true、task.id>0 |
| TC-S1-02 🟢P0 scope 过滤 | ✅ PASS | L0+L1：GET /api/chat/conversations?scope=software 只含 software 会话，一条也不含 default/marketing（正向） |
| TC-S1-03 🔴P0 scope 隔离反向 | ✅ PASS | L0+L1：default 列表查不到 software 会话；跨 scope 写（消息 body 带 scope:marketing）消息仍落 software 会话（消息 scope=会话 scope）不串 |
| TC-S1-04 🔴P0 kind 非法 | ✅ PASS | L0：kind=channel → 抛「kind 必须 ∈ {space,direct,task}」；L1：HTTP 400 且 error 指明合法枚举 |
| TC-S1-05 🔴P0 缺 by / 非法 JSON | ✅ PASS | L0：缺 by → 抛「缺少操作者身份 by」；L1：①缺 by → 400「缺少操作者身份 by」②非法 JSON body → 400（非 500）③失败写无 chat: 审计留痕（/api/activity 前后 chat 计数不变） |
| TC-S1-06 🟢P0 发消息 | ✅ PASS | L0+L1：POST /api/chat/messages → 200、author=by、createdAt 有值、会话 last_message_at 更新（≥ 会话旧 updatedAt） |
| TC-S1-07 🔴P0 author 冒名绑定 | ✅ PASS | L0+L1：传 author:other 恒等于 by（服务端绑定），author≠other |
| TC-S1-08 🟢P0 分页 10/10/5 | ✅ PASS | L0+L1：25 条消息 limit=10 → 三页 10/10/5，页内 id 升序、页间游标连续（id<上一页最旧）、拼接无重无漏（Set size=25 与全量一致） |
| TC-S1-09 🟡P0 分页边界 | ✅ PASS | L0+L1：空会话 → []；before 早于最旧 → []；before 晚于最新 → 全量（页尾语义）；缺省 limit=50；limit=0/-1/1.5/abc → 400 |
| TC-S1-10 🔴P0 未知会话 | ✅ PASS | L0+L1：POST 消息到 conv=999999 → 400「会话不存在」；list → 400；不落任何消息行 |
| TC-S1-11 🔴P0 空正文 | ✅ PASS | L0+L1：body='' 与 '   ' → 400「消息正文不能为空」 |
| TC-S1-12 🟡P1 正文长度上限 | ✅ PASS | L0+L1：MAX_CHAT_BODY=8000 恰好通过 → 200/入库；8001 → 400「消息正文超长」且不落库（列表仍只 1 条） |
| TC-S1-13 🟢P0 审计留痕 | ✅ PASS | L0：chat:create（member=general、scope=software、detail.conv=convId）与 chat:message（member=coder、detail.msg=number）存在，审计 seq 升序。L1：GET /api/activity?scope=software 可查得 chat:* 行 |
| TC-S1-14 🟢P1 SSE 事件 ≤5s | ✅ PASS | L1：订阅 /api/events 期间 POST chat:message（by=coder）→ ≤5s 收到 live 事件 {action:chat:message,member:coder,scope:software,detail.msg:number}。延迟实测 avg 234ms（max 241ms）≤5000ms |
| TC-S1-15 🟡P1 断开不崩 | ✅ PASS | L1：一个订阅端主动断开后继续 POST → 服务存活（返回 200）、其余订阅端仍收到事件；eventClients 无泄漏（重复断开/订阅后连接数不回涨） |
| TC-S1-16 🟢P1 老库迁移 | ✅ PASS | L0：旧 schema（tasks/skills 有数据、无 conversations/messages）import 后自动建两表、存量任务/技能数据无损；迁移后可建会话 + 发消息 |
| TC-S1-17 🔴P1 token 401/200 矩阵 | ✅ PASS | L1：TEAM_HUB_TOKEN=tk → ①无 token 写 → 401「Bearer token 无效」②错 token 写 → 401 ③对 token 写 → 200 ④无 token 读 → 200 放行 |
| TC-S1-18 🟢P2 零新增依赖 | ✅ PASS | package.json dependencies: {}；S1 文件 server.mjs / chat.test.mjs / chat-l1-smoke.mjs imports 全为 node: 内置（http/sqlite/fs/crypto/path/url/test/assert/os/child_process）。证据见 §3 依赖核验 |

合计：TC-S1-01..18 全部 ✅ PASS，0 失败。

---

## 3. 依赖与静态核验（TC-S1-18 / S1 AC6）

- package.json：dependencies: {}（零运行时依赖）；peerDependencies / devDependencies 为插件构建用（cordis/schemastery/@types/node/typescript），非 S1 功能所引。
- S1 文件 import 面（grep）：server.mjs 仅 node:http / node:sqlite / node:fs / node:crypto / node:path / node:url + 本地 ./stage-standards.mjs；chat.test.mjs / chat-l1-smoke.mjs / skills.test.mjs 仅 node:test / node:assert/strict / node:fs / node:os / node:path / node:sqlite / node:child_process——全部内置，零新增依赖。
- node --check 对 server.mjs / chat.test.mjs / chat-l1-smoke.mjs / skills.test.mjs 均 exit 0（语法有效）。
- team-hub typecheck（tsc -p team-hub/tsconfig.json --noEmit）：exit 非 0，报 TS2688：Cannot find type definition file for 'node'——worktree 无 node_modules（@types/node 为 devDependency，未安装）。此为环境依赖缺失，非代码缺陷：S1 功能为纯 JS（server.mjs + .mjs 测试），不在 TS 构建图（tsconfig 仅含 src/index.ts 插件面）。按规则不擅自安装，如实声明。

---

## 4. 回归范围与结论

- 回归范围：S1 改动集中于 team-hub/server.mjs（新增 chat 两表 schema、createConversation/listConversations/postMessage/listMessages DAO、/api/chat/* 路由、chat:* 审计 + 复用统一 handleWrite 与单一 /api/events SSE 广播）及新增测试资产 team-hub/chat.test.mjs、chat-l1-smoke.mjs。audit()/handleWrite/broadcastAudit 为 server.mjs 既有基础设施的复用与扩展，故同模块回归跑 skills.test.mjs（12/12）确认 skills 端点与旧库迁移未受损。
- 回归结论：
  - L0 全量：chat 13/13、skills 12/12、contracts 56/56——全绿。
  - 同模块（team-hub）无回归：skills 提交/列表/审/授权、旧库迁移均 12/12。
  - 跨模块：S1 未触 workbench 前端（S2）/ files-api（S3/S4）/ web-fetch（S6），契约基线 contracts.test.mjs 56/56 确认白板收敛断言未破。
  - 未发现 S1 引入的既有模块回归。
- 结论：S1 功能契约、scope 隔离、写纪律（by/author 绑定）、分页、正文上限、审计、SSE、鉴权、迁移、零依赖全部达成，判定全绿；无失败项、无待将军确认的卡点。本阶段未修改任何实现代码（仅新增报告与证据资产 docs/T061-evidence/）。

---
证据见 docs/T061-evidence/（README.md 链接各日志）。
