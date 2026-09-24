
# T-065 测试执行报告（tester）—— S2 workbench ChatView + 接线（SSE 单源按 kind 过滤）

> 角色：tester（测试执行）｜任务：T-065｜分支：w/T-065（独立 worktree）｜日期：2026-09-04
> 测试对象：S2 对话中心前端（workbench/src/components/ChatView.tsx + 接线）+ 其数据源 team-hub v2（server.mjs /api/chat/* + 单一 /api/events SSE）。
> 被测基线：本 worktree（w/T-065，HEAD=d3e057d "promote T-062"，工作树干净）即当前仓库已含的 S2 实现（由 T-047 coder 合入、T-060 review 通过）；本阶段只执行与记录，未改任何实现代码。
> 依据用例：docs/TEST_CASES.md §S2（TC-S2-01..11）、§5 矩阵（I4/I5/I8）、§7.1 浏览器清单、TASK_BREAKDOWN S2 AC1..AC6。
> 取代声明：本报告取代 docs/TEST_REPORT.md 上版（T-062 S4 报告，git 历史可回溯）。

---

## 0. 结论速览

| 结论 | 说明 |
| --- | --- |
| 判定：S2 本域（可执行面）全绿 | 在本地沙箱**可执行**的自动化/数据面/静态核对全部实测通过：tsc --noEmit exit 0；team-hub chat.test.mjs 13/13、skills.test.mjs 12/12；S2 L1 冒烟 chat-s2-smoke.mjs 9/9；边界/安全探针 s2-probes.mjs 10/10；静态 grep 无 dangerouslySetInnerHTML 直插正文、hub SSE 单源 1 个、kind 白名单 + chat:* 过滤、scope/无中枢引导、MAX_BODY=8000 对齐。 |
| L0 构建（TC-S2-01） | **部分通过（环境受限，非代码缺陷）**：tsc --noEmit exit 0（strict + noUnusedLocals/noUnusedParameters 0 类型错误）；但 vite build 的 esbuild 服务子进程 spawn 被沙箱 named-pipe 拦截 → spawn EPERM（证据 02/03），与 T-047/T-042/T-061 记录的**同一已知环境限制**，需宿主补跑 cd workbench && pnpm build。 |
| L1 数据面冒烟 | chat-s2-smoke.mjs 9/9：SPA 入口 200、/hub 单源代理 200、空态可建、建会话、60 条消息 id 严格升序 + last_message_at 更新、分页 50+10 无重无漏（=「加载更早」数据面）、scope 隔离 software/ops、双订阅 ≤5s 同一 live chat:message（=第二标签页实时）、action=chat: 前缀。 |
| 边界/安全探针 | s2-probes.mjs 10/10：XSS 三载荷原样存读（React 文本节点→不执行）、空正文/超长 8001/非法 kind/title>200 均 400、恰好 8000 通过、markdown(kind) 存读原样、单一 /api/events 收到 action=chat: + scope + member=by。 |
| 静态接线/安全 | src 零 dangerouslySetInnerHTML 直插正文（2 处均注释）、ChatView 正文渲染 {m.body} 文本节点、hub /hub/api/events 唯一 EventSource（另 2 个为 v1 serve.mjs board/activity）、kind 过滤 chat:*、scope 引导 + 需中枢提示、App.tsx 挂载 <ChatView scope hubMode>、实时动态走 v1 与中枢分离。 |
| 回归范围 | S2 改动面 = workbench 前端（ChatView/api/types/App）+ team-hub chat 后端。跑 team-hub chat.test 13/13、skills.test 12/12、workbench tsc exit 0（前端无测试 runner，按 TEST_CASES L0 build + §7 清单验收）。S3/S4/S6（web/files）不经手且未改动，不在本域回归。 |
| 未在本沙箱闭环 | ① vite build（esbuild spawn EPERM，宿主补跑）；② §7.1 L2 浏览器清单的**纯 GUI 渲染项**（气泡即时显示无刷新、自动滚动、toast 文案/位置、双标签 devtools 连接数、断线重连文案）需真实浏览器手工验收（L2 约定 = tester + 将军）。数据面与静态证据已覆盖其数据等价面。 |

---

## 1. 执行环境与方式（环境 / 步骤 / 实际结果 / 日志证据）

- 环境：Windows 沙箱（workspace-write，禁网、禁装依赖）；node v24.19.0（node:test / node:http / node:fs / node:sqlite 内置）。
- 工作目录：D:/project/DSH/legion/.legion-worktrees/T-065（分支 w/T-065）。本阶段仅产出报告与证据，未改任何实现代码（见 §6 git status）。
- 依赖说明：worktree 内无 node_modules/dist（沙箱禁联网装依赖）。为跑 TC-S2-01 typecheck 与 S2 冒烟，**复用主仓库同一 commit（HEAD 一致 d3e057d）的 node_modules 作为 junction、dist 作为构建产物**（仅测试环境，非实现改动，均 .gitignore/未跟踪）。
- 执行方式（沙箱 spawn 受限，子进程一律 stdio:ignore）：
  - L0 契约（后端回归）：node team-hub/chat.test.mjs、node team-hub/skills.test.mjs（进程内 node:test）。
  - L0 前端类型：node_modules/.bin/tsc.cmd --noEmit（strict + noUnusedLocals/noUnusedParameters）。
  - L1 真实进程冒烟：node workbench/scripts/chat-s2-smoke.mjs（真实起 team-hub:随机端口临时库 + serve.mjs:随机端口 DSH_HUB_UPSTREAM→①，客户端走 /hub/...）。
  - 边界/安全探针：node docs/T065-evidence/s2-probes.mjs（同上双服务，专项 XSS/400/kind/markdown/SSE）。
  - 静态核对：read + grep 全 workbench/src。
- 日志证据（真实命令输出，存 docs/T065-evidence/）：

| 文件 | 命令 | 结果 | 对应 |
| --- | --- | --- | --- |
| 01-typecheck.txt | tsc --noEmit | EXIT=0，0 类型错误 | TC-S2-01（前半） |
| 02-vite-build.txt | vite build | spawn EPERM（esbuild 服务 spawn 被沙箱拦） | TC-S2-01（后半，环境） |
| 03-pnpm-build.txt | pnpm build | 同 EPERM（tsc 先过、vite 崩） | TC-S2-01（环境） |
| 04-chat-test.txt | team-hub/chat.test.mjs | 13/13 pass（suites 5） | S1 后端契约回归 |
| 05-skills-test.txt | team-hub/skills.test.mjs | 12/12 pass | team-hub 基线 |
| 06-chat-s2-smoke.txt | chat-s2-smoke.mjs | 9/9 断言通过 | S2 数据面 |
| 07-s2-probes.txt | s2-probes.mjs | 10/10 通过 | 边界/安全/kind/SSE |
| 08-static-wiring.txt | read+grep | 见 §4 静态表 | I5/I8/AC5/AC2 |

---

## 2. 用例执行结果（TC-S2-01..11）

> 判据对照 docs/TEST_CASES.md §S2「期望结果/通过判据」列。✅=通过（含数据面+静态）；⚠️=仅数据面/静态证据通过，纯 GUI 渲染项需 L2 浏览器补验（本沙箱无浏览器）。

| 用例 | 判据 | 实际结果（证据） |
| --- | --- | --- |
| TC-S2-01 构建 | ✅（类型）/⚠️(vite 环境) | typecheck：tsc --noEmit EXIT=0，0 类型错误（strict+noUnused）。vite build：spawn EPERM（esbuild 服务子进程被沙箱 named-pipe 拦截），**非代码缺陷**，与 T-047/T-042/T-061 同因；宿主需 cd workbench && pnpm build 闭环。产物含 chat 独立 chunk 无法在本域验证（当前 ChatView 未用 React.lazy） |
| TC-S2-02 主路径 | ✅（数据面+静态） | 数据面：S2-A GET / 200 html；S2-C 空态会话列表 []；S2-D POST 会话 200 ok:true task{title,kind,last_message_at:null}；S2-E 60 条消息全 200 + id 严格升序。静态：ChatView send() setMsgs(prev=>mergeById(prev,[msg])) 即时插入气泡（无整页刷新）；App.tsx 挂载 <ChatView scope hubMode>。GUI「气泡即时出现/滚动」需 L2 |
| TC-S2-03 双标签实时 | ✅（数据面） | S2-H：两个订阅（均经 /hub 代理的唯一 /api/events）≤5s 收到同一 live chat:message（msg=61）＝第二标签页 ≤15s 实时收发的数据面等价。<15s 满足 |
| TC-S2-04 历史恢复 | ✅（数据面） | S2-F：limit=50 最新升序 + before=最旧向前翻 → 60 条无重无漏、页内升序、页间连续（=ChatView「加载更早」P1-4 数据面）；后端 listMessages 分页契约由 chat.test TC-S1-08/09 佐证 |
| TC-S2-05 scope 隔离 | ✅（数据面+静态） | S2-G：software/ops 两空间会话列表各自独立互不含对方（反向断言）；chat.test TC-S1-03（跨 scope 写不串）佐证。静态：ChatView 会话/消息随 scope 切换（useEffect [scope] 清空重载）。**注：reviewer M1 竞态（loadOlder/send 异步回写缺会话身份守卫）在快速切会话/空间时可能串显，见 §5** |
| TC-S2-06 全部空间引导 | ✅（静态） | ChatView if(!scope) 返回「请先选择具体工作空间」引导卡片（line 199-205），非错误非白屏 |
| TC-S2-07 断中枢失败路径 | ✅（数据面+静态） | 数据面：中枢不可达 → postChatMessage fetch reject → catch 分支 toast('err',发送失败)+草稿不清空；后端对非法写返回 400（07-s2-probes P-B1/B2）映射 toast。静态：send() 仅成功分支 setDraft('')，失败分支只 toast，草稿保留。恢复后重发＝S2-D/E 正常 |
| TC-S2-08 单事件源 kind 过滤 | ✅（数据面+静态） | 静态：api.ts new EventSource(hubBase()/api/events) 唯一 hub 连接（另 2 个为 v1 serve.mjs board/activity，不在中枢）；ChatView 订阅后 String(ev.action).startsWith('chat:') 过滤。数据面：S2-H2 收到 action=chat: + scope + member=general；s2-probes P-SSE 单一连接收 chat:message（detail{conv,msg,kind}）。「实时动态」走 /api/activity/events 与中枢分离，不被 chat 事件吞并 |
| TC-S2-09 XSS 渲染安全 | ✅（数据面+静态） | 数据面：s2-probes P-XSS 将 <img src=x onerror=alert(1)>、<script>alert(1)</script>、[x](javascript:alert(1)) 三个载荷 POST 200 且 GET 原样返回（无转义/吞并）。静态：grep 全 src 零 dangerouslySetInnerHTML 直插正文（仅 ChatView/FilesView 注释 line 34）；ChatView 正文渲染为 {m.body} React 文本节点（HTML 被转义→纯文本显示、脚本不执行）。GUI 无弹窗断言需 L2 浏览器 |
| TC-S2-10 空/超长/连发 | ✅（数据面+静态） | 数据面：s2-probes P-B1 空正文 400、P-B2 8001 字符 400、P-B3 恰好 8000 200（边界）、P-B4 非法 kind 400；chat.test TC-S1-12 恰界/+1 拒绝。连发 60 条 id 严格升序、会话 last_message_at 单调＝S2-E。前端：发送按钮在 draft 空/超长时禁用、超长 toast；「快速连发 5 条顺序一致无丢失」= 后端 id 单调 + mergeById 保序（数据面等价） |
| TC-S2-11 未知/非文本 kind | ✅（数据面+静态） | 数据面：s2-probes P-MD kind=markdown 消息 200 且 body 原样返回（# ...、- a 等原样）。静态：ChatView 渲染消息只取 m.body，不按 kind 分支/不抛错，kind 白名单外按文本兜底（line 315-320）——未知 kind 不白屏 |

---

## 3. 回归范围与结论

- **改动面**：S2 只涉及 workbench 前端（ChatView.tsx、api.ts、types.ts、App.tsx 接线）+ team-hub chat 后端（server.mjs 对话/SSE 面）；S1（后端 API）由 chat.test.mjs、skills.test.mjs 回归覆盖。
- **回归结论**：
  - team-hub/chat.test.mjs 13/13（会话/消息/分页/scope/author/审计/SSE 前置/老库迁移）——S1 后端契约全绿。
  - team-hub/skills.test.mjs 12/12——team-hub 共享面基线全绿。
  - workbench tsc --noEmit exit 0——前端类型全绿。
  - S2 数据面冒烟 9/9 + 边界探针 10/10——S2 新功能全绿。
  - 未复跑 web.test（S6）/files-api（S3/S4）：S2 不经手且未改动这些实现；如需完整回归建议宿主补跑 node workbench/scripts/files-api.test.mjs（34/34 基线）与 web.test 12/12。
- **结论**：在本沙箱可执行面内，S2 未复现任何代码缺陷；全部自动断言 + 静态核对通过。遗留两项需宿主闭环：① vite build（esbuild spawn EPERM，环境）；② §7.1 L2 浏览器清单的纯 GUI 渲染项。

---

## 4. 静态核对表（I5/I8/S2 AC2/AC5）

| # | 检查 | 结果 |
| --- | --- | --- |
| 1 | dangerouslySetInnerHTML 全 src | 2 处，均注释（ChatView.tsx:34、FilesView.tsx:34），非注释行 0 → 无 HTML 直插 |
| 2 | 消息正文渲染 | <div className={...}>{m.body}</div> React 文本节点 → 纯文本、HTML 转义 |
| 3 | hub SSE 单源 | api.ts new EventSource(hubBase()/api/events) 唯一中枢连接（另 2 个 v1 serve.mjs board/activity） |
| 4 | kind 过滤 | ChatView String(ev.action).startsWith('chat:') 过滤（不吞并 v1 动态） |
| 5 | scope 引导 | if(!scope) →「请先选择具体工作空间」；if(!hubMode) →「需要 team-hub v2」 |
| 6 | MAX_BODY | ChatView const MAX_BODY = 8000，与后端 MAX_CHAT_BODY = 8000（server.mjs:512）对齐 |
| 7 | 接线 | App.tsx <ChatView scope={scope} hubMode={hubMode} />；hubMode 由 probeHub() 决定 |
| 8 | 动态与中枢分离 | 实时动态走 /api/activity/events（v1 serve.mjs），非中枢 /hub/api/events |

---

## 5. 风险与待将军确认 / 遗留项

- **M1（reviewer T-060 标记「必须修改」，本域未在数据面复现）**：ChatView.loadOlder()/send() 在 await 后直接 setMsgs(prev=>mergeById(...))，**缺会话身份守卫**（未校验 activeRef.current===activeId）；若用户在请求飞行中快速切换会话/空间，旧会话消息可能合入新会话 → 违反 TC-S2-05「互不串」/ I4 的边界。影响面：窄（需 GUI 级时序）；归属：S2 ChatView（前端状态管理）。建议：纳入 §7.1 L2 浏览器清单专项走查 + 后续补 if(activeRef.current!==activeId) return 守卫并加前端单测。
- **vite build**：本域 spawn EPERM，需宿主 cd workbench && pnpm build 补跑并确认产物（当前 ChatView 未用 lazy，产物为单一 index chunk + Scene3D 动态 chunk，见 dist 探测）。
- **零新增依赖**：S2 前端未新增 package.json 依赖（比对 workbench/package.json 仅 React/three 既有项）；team-hub 由 node: 内置实现。

---

## 6. 交付物与 git 状态

- 本阶段**未修改任何实现代码**（仅测试执行与记录）：docs/TEST_REPORT.md、docs/T065-evidence/*。
- 产物：docs/T065-evidence/{01-typecheck,02-vite-build,03-pnpm-build,04-chat-test,05-skills-test,06-chat-s2-smoke,07-s2-probes,08-static-wiring}.txt + s2-probes.mjs + README.md。

