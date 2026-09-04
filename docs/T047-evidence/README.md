# T-047 验收证据 —— S2：workbench ChatView + 接线（SSE 单源按 kind 过滤）

> 角色：coder｜任务：T-047｜分支：w/T-047（独立 worktree，基线 main @ 2bd55a1 promote T-045）
> 范围（docs/TASK_BREAKDOWN.md S2；docs/TEST_CASES.md TC-S2-01..11）：对话中心前端面板 + 接线 + 实时订阅，
> 数据源 = T-045/S1 的 team-hub v2 /api/chat/* 与单一 /api/events SSE。
> 本任务按「上一轮经 promote 合入的 S2 首版（ChatPanel）」做 S2 交付收口：改名对齐拆解产出名
> ChatView、补评审 P1-4「对话历史仅最近 50 条无加载更早」（TC-S2-04 完整历史恢复）、全量复验并沉淀证据。

## 0. 改动清单（git status 可见；均未 commit，交守护/将军 promote 时落库）

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| workbench/src/components/ChatView.tsx | 新增（原 ChatPanel.tsx 改名 + 增强） | 对话中心面板：会话列表/新建/发送/消息区/分页「加载更早」/实时合并刷新/草稿保留 |
| workbench/src/components/ChatPanel.tsx | 删除（rename 至 ChatView.tsx） | 按拆解产出名与 TC-S2-09「grep ChatView」对齐 |
| workbench/src/App.tsx | 2 行 | import 与 active==='chat' 分支改用 ChatView（接线不变） |
| workbench/src/index.css | +3 行 | .chat-older-bar「加载更早」样式（复用既有 token） |
| workbench/README.md | 2 处 | 组件名 ChatPanel→ChatView + 分页能力说明 |
| workbench/scripts/chat-s2-smoke.mjs | 新增（L1 测试资产） | S2 主路径 + 实时收发的 HTTP/SSE 冒烟（零第三方依赖，起真实双服务） |
| docs/T047-evidence/* | 新增 | 本证据目录 |

未触碰：serve.mjs（S4/T-048 并行域）、FilesPanel/BrowserPanel/Sidebar 逻辑（S5/S7 域）、team-hub/*（S1 域）。
未新增任何运行时依赖（沿用既有 react/vite/tsc；node_modules 与 dist 为 gitignore 的 junction，仅本地验证用）。

## 1. 验收标准逐条对应

| 验收标准 | 结果 | 证据 |
| --- | --- | --- |
| pnpm build 绿 + :5173 主路径浏览器验收 | ⚠️ 见下 | tsc 环节 exit 0；vite/esbuild 子进程 spawn 被本沙箱 EPERM 拦截（03-build-attempt.txt，与 T-042 同因、会话无提权）；HTTP/SSE 主路径数据面已对真实 :5173 同款宿主全绿（04-s2-smoke.txt 9/9），GUI 渲染走查清单见 §3 供将军 L2 验收 |
| 实现满足验收标准与用例；真实跑过 typecheck / build / 测试并在证据给出命令与输出要点 | 通过 | typecheck exit 0（01）；DAO 测试 13/13 + 回归 12/12（02）；S2 L1 冒烟 9/9（04）；build 尝试与受限原因留档（03）；安全 grep（05） |
| 改动仅在任务范围内；新引入依赖有说明 | 通过 | 改动全在 S2 文件域（workbench/src 对话部分 + README + 本证据）；零新增依赖；新增测试资产为零依赖 node 脚本 |

### 1.1 拆解 AC（TASK_BREAKDOWN S2）逐条

- AC1 pnpm build 全绿：tsc strict + noUnusedLocals/noUnusedParameters → exit 0（01-typecheck.txt）。
  vite build 环节本沙箱 EPERM（esbuild Go 子进程 stdio pipe 被拦；03-build-attempt.txt）——环境受限非代码问题；未用 React.lazy（无独立 chunk 要求）。
- AC2 行为跟随当前空间：「全部空间」（scope=null）与 hub 不可达两分支给出引导文案（ChatView.tsx 顶部）；
  切空间重置会话/消息（ChatView 挂载 effect 对 scope 置空 active，防全局自增会话 id 跨空间撞号串显）；数据面隔离由 S1 后端保障，L1 冒烟 S2-G 正向+反向断言过。
- AC3 主路径可用（:5173）：数据面 = S2 冒烟 A–H 9/9（经 serve.mjs /hub 同源代理 = 浏览器同款路径）：
  新建会话→连发 60 条→列表 last_message_at 更新；双订阅 ≤5s 收同一 live chat:message（第二标签页 ≤15s 的数据面等价）；
  刷新后历史仍在 = GET messages 幂等可重拉（S2-F 分页 50+10 无重无漏）。GUI 步骤清单见 §3。
- AC4 实时订阅复用单一 /api/events 按 kind 过滤：ChatView 仅 subscribeHubAudit() 一处 EventSource
  （hubBase() + '/api/events'，I8/TC-S2-08），事件回调 filter action.startsWith('chat:')；
  冒烟 S2-H 事件即走该单一源；右侧「实时动态」流为 serve.mjs 独立端点（subscribeActivity，非 hub），互不影响——未新增第二个 hub 事件连接。
- AC5 渲染安全：正文 React 文本节点 + white-space:pre-wrap；grep 无 dangerouslySetInnerHTML 使用（05）；kind 白名单外按文本兜底（渲染不依赖 kind）。
- AC6 失败路径：发送失败 catch → toast 错误且草稿不丢（成功才 setDraft('')）；
  超长（>8000）客户端前置拦截 + 后端 400 兜底 toast；中枢不可达 → 加载失败 toast + 引导分支；
  EventSource 原生自动重连（retry: 2000 服务端已发），另留 15s 轮询兜底断线窗口（ChatView 内）。

### 1.2 测试用例（TC-S2-01..11）逐条状态

| 用例 | 状态 | 说明 |
| --- | --- | --- |
| TC-S2-01 build | ⚠️ | tsc 0 错误；vite build 沙箱 EPERM（03），需宿主跑 pnpm build（基线曾 615 modules 全绿） |
| TC-S2-02 发送主路径 | ✅ 数据面 | S2 冒烟 A–E（新建会话→发消息→列表更新）；GUI 渲染见 §3 |
| TC-S2-03 双标签 ≤15s | ✅ 数据面 | S2-H 双订阅 ≤5s 同一条 chat:message（更严于 15s） |
| TC-S2-04 刷新历史仍在 | ✅（含 >50） | S2-F：60 条分页 50+10 无重无漏、页间连续 ——「加载更早」（P1-4）已实现，>50 条旧消息可达 |
| TC-S2-05 scope 切换不串 | ✅ 数据面 | S2-G 双向隔离；前端切空间清空会话/消息（代码）；GUI 见 §3 |
| TC-S2-06 全部空间引导 | ✅ 代码/静态 | ChatView scope=null →「请先选择具体工作空间」引导分支存在 |
| TC-S2-07 停中枢草稿保留 | ✅ 代码/静态 | 发送 catch 不丢 draft + toast；EventSource 断线原生重连 + 15s 轮询兜底（GUI 实测见 §3） |
| TC-S2-08 单事件源连接数 | ✅ 静态/数据面 | 仅 1 处 EventSource(hub /api/events) + chat:* filter；未新增 hub 端点；动态流走 serve.mjs 独立端点 |
| TC-S2-09 XSS 纯文本 | ✅ 静态 | 05-security-grep：无 dangerouslySetInnerHTML 使用；正文文本节点渲染 |
| TC-S2-10 空输入/超长/连发 | ✅ 代码/数据面 | 空输入按钮禁用；>8000 前置 toast + 后端 400（S1 TC-S1-12 已验）；连发 60 条顺序单调（S2-E id 严格升序） |
| TC-S2-11 未知 kind 按文本 | ✅ 代码/静态 | 渲染不依赖 kind；kind=markdown 未勾选 X-1 时原样纯文本显示 |

## 2. 真实执行过的验证命令与输出要点

| 命令（worktree 根） | 结果要点 | 原文 |
| --- | --- | --- |
| node workbench/node_modules/typescript/bin/tsc -p workbench/tsconfig.json --noEmit | exit 0，0 错误 | 01-typecheck.txt |
| node team-hub/chat.test.mjs | pass 13 / fail 0，exit 0 | 02-dao-tests.txt |
| node team-hub/skills.test.mjs | pass 12 / fail 0，exit 0 | 02-dao-tests.txt |
| node workbench/scripts/chat-s2-smoke.mjs | 9/9 断言通过，exit 0（真实双服务 + /hub 同源代理） | 04-s2-smoke.txt |
| pnpm build（workbench） | tsc 环节过 → vite/esbuild spawn EPERM（沙箱），exit 1 | 03-build-attempt.txt |
| grep dangerouslySetInnerHTML workbench/src | 仅 2 处注释（ChatView/FilesPanel），无使用 | 05-security-grep.txt |

环境注记：本会话 DSH 沙箱拦截 Node child_process spawn（stdio pipe → EPERM），且无提权通道；与 T-042 记录的
build 受限同因（TEST_REPORT.md §6.1）。node_modules 与 dist 为指向主 checkout 的 junction（gitignore，不入库），未联网、未安装任何新依赖。

## 3. L2 浏览器手工验收清单（供将军在 :5173 勾选；数据面等价证据见 §1.2）

启动（README §2.1 生产法）：1) node team-hub/server.mjs（:8787 中枢） 2) pnpm build 3) node scripts/serve.mjs --port 5173；
或开发法 pnpm dev 并把右上角「🧭 中枢」设为 http://127.0.0.1:8787。

- [ ] 选中具体空间（如 software）→ 侧栏「💬 对话中心」→ 会话列表出现（空态可「＋ 新会话」）
- [ ] 新建会话 → 输入消息 → 发送 → 气泡即时出现（无整页刷新）
- [ ] 第二标签页同空间同会话 → ≤15s 内自动出现新消息（本任务 L1 已证 ≤5s）
- [ ] 刷新页面 → 历史消息仍在；会话消息 >50 条时顶部「↑ 加载更早消息」可翻到最早（P1-4）
- [ ] 切到另一空间 → 会话/消息随之切换且不含前一空间数据；「全部空间」下打开 → 先选空间引导
- [ ] 停掉中枢后发送 → toast 错误 + 输入框草稿保留；恢复中枢 → 重发成功
- [ ] 发送含 script / img onerror / javascript: 链接样本文本 → 纯文本显示、无弹窗（L1 冒烟 S2-E 已含样本入库存证）
- [ ] devtools：hub 事件源连接数不增加（ChatView 仅 /hub/api/events 一处）；右侧「实时动态」流正常

## 4. 假设与边界

- 假设 1：本任务交付口径 = S2 拆解 AC1..AC6 + TC-S2-01..11；上一轮 S2 首版已在基线（promote 历史合入），本任务以「改名收口 + 补 P1-4 分页 + 复验 + 证据」交付，不重写等价实现。
- 假设 2：P1-3（GET conversations 缺省全 scope）属 S1 后端域（server.mjs），非 S2 前端范围，未改动；前端始终带 scope 请求，规避该读口对 UI 的影响。
- 假设 3：workbench/dist junction 用于 L1 起 serve.mjs（静态壳仅为入口 200 验证）；产物打包需宿主环境重跑 pnpm build 后 L2 走查。
- 遗留：vite build 的最终绿证需将军/宿主环境执行（本会话沙箱 EPERM + 无提权），命令 cd workbench && pnpm build。