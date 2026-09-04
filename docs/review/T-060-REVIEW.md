# T-060 代码审查报告（review）——S2 workbench ChatView + 接线（SSE 单源按 kind 过滤）

> 审查对象（本任务 = S2 对话中心前端的独立代码审查）：
> - coder 提交 **81d4433**（T-047，11 文件 +553/−49）：ChatPanel.tsx → ChatView.tsx 改名 + 增强（补 P1-4「加载更早」分页、SSE 单源按 kind 过滤收口、失败路径/草稿保留），App.tsx 接线、index.css、workbench/README、L1 资产 workbench/scripts/chat-s2-smoke.mjs、docs/T047-evidence/*；
> - 该提交经 promote（3dbc66a，人工合入）进入主线；blob 级核对：ChatView.tsx / chat-s2-smoke.mjs 与合入态逐字节一致（App.tsx 合入时与主线其它改动冲突解决，chat 接线两行在合入态中保持）。
> 审查基线 = 本 worktree 分支 w/T-060 @ main HEAD 8c5903b（含全部 promote）。
> 审查方式：组件全文与接线链正读（ChatView.tsx 全 376 行、api.ts chat 面、types、App.tsx 接线、team-hub server.mjs chat/SSE 路由）+ 独立复跑（typecheck / DAO 回归 / S2 L1 冒烟）+ 静态检查（SSE 单源、XSS 面、残留引用、文档同步）。只给反馈，未改任何实现代码。
> 结论分级：**必须修改**（验收 AC 未达成 / 实测行为缺陷 / 安全承诺失实）与**建议优化**（可排期）。严重度 🔴高 / 🟠中 / 🟡低。

---

## 0. 验证证据（独立复跑，非引用提交自述）

| 验证项 | 命令/方式 | 结果 |
| --- | --- | --- |
| 环境 | node v24.19.0（沙箱 workspace-write；node_modules/dist 经 junction 指向主 checkout，gitignore） | 与 coder 自述一致 |
| 前端类型 | node workbench/node_modules/typescript/bin/tsc -p workbench/tsconfig.json --noEmit（strict + noUnusedLocals/noUnusedParameters） | **exit 0**（与 coder 01 一致） |
| S1 DAO 回归（同文件域） | node team-hub/chat.test.mjs | tests 13 / pass 13 / fail 0，exit 0（TC-S1-03/06/07 scope 隔离 + author 绑定、TC-S1-08/09 分页与边界、TC-S1-12 上限、TC-S1-13 审计、TC-S1-16 老库迁移全绿） |
| 技能模块回归 | node team-hub/skills.test.mjs | tests 12 / pass 12 / fail 0，exit 0 |
| S2 L1 冒烟（真实双服务） | node workbench/scripts/chat-s2-smoke.mjs（起 team-hub server.mjs 临时库 + serve.mjs 随机端口 + /hub 同源代理 = 浏览器 ChatView 同款路径） | **9/9 断言通过，exit 0**（S2-A..H2：SPA 入口 / /hub 代理 / 空态 / 新建 / 连发 60 条 id 严格升序 / 分页 50+10 无重无漏 / scope 双向隔离 / 双订阅 ≤5s 同一 live chat:message） |
| vite build | node node_modules/vite/bin/vite.js build（workbench） | **exit 1：esbuild spawn EPERM**（沙箱拦截 Go 子进程 stdio pipe）——与 coder 03-build-attempt 记录完全同因复现，属环境受限而非代码问题；tsc 环节已 0 错误 |
| SSE 单源静态核对 | grep workbench/src 全部 EventSource / subscribeHubAudit / api/events | hub 事件连接仅 api.ts:491 subscribeHubAudit 一处（ChatView 是唯一调用者）；subscribeBoard/subscribeActivity 均指向 apiBase()（serve.mjs v1 端点）而非 hub——「不新增第二个 hub 事件连接」成立 |
| XSS 面静态核对 | git grep dangerouslySetInnerHTML + 全文正读渲染路径 | 无使用（仅 2 处注释声明）；消息正文经 React 文本节点 + white-space:pre-wrap 渲染，kind 不参与渲染（未知 kind 按纯文本兜底，TC-S2-11） |
| 改动范围 | git show 81d4433 --stat；git status | 全部落在 S2 文件域（workbench 对话组件/接线/样式/README + 证据 + 冒烟资产）；零新增依赖（未触 package.json） |
| 残留引用 | git grep ChatPanel（全仓，含 docs） | 根 README.md:137 仍写 ChatPanel（见 O2）；docs/T047-evidence 为历史描述，无碍 |

### 0.1 审查口径注记
- 任务说明（波次 2）「S2 workbench ChatView + 接线，SSE 单源按 kind 过滤」= TASK_BREAKDOWN.md S2（AC1..AC6）+ TEST_CASES.md TC-S2-01..11；本波 S2 编码 = 在上一轮已 promote 的 S2 首版（23a9957 ChatPanel）之上做「改名收口 + 补 P1-4 分页 + SSE 单源复验 + 证据沉淀」——按 coder 假设 1 的口径审查，不重复评审上一轮等价实现。
- build 环节：coder 与 reviewer（本会话）均被沙箱 EPERM 拦截 esbuild spawn，无法产出最终构建绿证 → 登记为**待宿主确认项 §3**（与 T-042/T-046 同因先例），不判为代码缺陷。

---

## 1. 验收口径逐条核对（依据 = TASK_BREAKDOWN.md S2 AC1–AC6 + TEST_CASES.md TC-S2-01..11 + 波次 acceptance）

| # | 口径 | 结论 | 依据 |
| --- | --- | --- | --- |
| S2 AC1 | pnpm build 全绿（tsc strict + noUnusedLocals/noUnusedParameters 零错误） | ⚠️ **tsc 通过（build 环节待宿主）** | 本审查独立复跑 tsc exit 0（0 错误）；vite/esbuild 沙箱 EPERM 复现（coder 已如实留档 03）；宿主补跑 pnpm build 后放行（登记 §3） |
| S2 AC2 | 行为跟随当前空间；「全部空间」引导先选空间；切空间会话/消息互不串 | ✅ 通过（含 1 项竞态注记 → M1） | 代码：scope=null → 引导分支（195–206 行）；切空间/会话 effect 清空 convs/msgs/activeId（64–115 行）；数据面 S2-G 双向隔离冒烟过。**注记**：loadOlder/send 的异步回写缺会话身份守卫，飞行中切换存在把 A 会话数据串进 B 视图的竞态（M1，代码推理） |
| S2 AC3 | 主路径可用（:5173）：新建会话→发消息→气泡即时出现；第二标签页 ≤15s SSE 实时收到；刷新后历史仍在 | ✅ 通过（数据面 + 静态；GUI 项留 L2） | S2 冒烟 A/B/D/E/H 数据面全绿（气泡即时 = send 后本地 mergeById 追加，代码 248 行；双订阅 ≤5s）；刷新历史 = GET /api/chat/messages 幂等重拉 + 分页 50+10 无重无漏（S2-F）；GUI 渲染项在证据 §3 L2 清单 |
| S2 AC4 | 实时订阅复用单一 /api/events 按 kind（chat:*）过滤；不新增第二个 hub 事件连接；不影响右侧「实时动态」 | ✅ 通过 | ChatView 仅 subscribeHubAudit() 一处 EventSource（hubBase + /api/events，api.ts:491）；回调 filter action.startsWith(chat:) 后按 detail.conv === active 才刷新（135–141 行）；全仓静态核对无第二个 hub 事件源；冒烟 S2-H/H2 即走该单一源 |
| S2 AC5 | 渲染安全：纯文本渲染、无 dangerouslySetInnerHTML 直插用户正文 | ✅ 通过 | 正文经 React 文本节点（{m.body}，318 行）+ white-space:pre-wrap；grep 无使用；kind 白名单外按文本兜底（渲染不依赖 kind） |
| S2 AC6 | 失败路径：中枢不可达/写失败 → toast 错误且草稿不丢；EventSource 断线自动重连 | ✅ 通过 | send 失败 catch 不清 draft（250–252 行，成功后 246 行才清）；hub 不可达加载 → toast + 引导分支；服务端已发 retry: 2000 + 15s 轮询兜底（142–146 行）。**注记**：断线期间轮询 loadConvs 每 15s 弹一次 toast（O3） |
| TC-S2-01 | build | ⚠️ 同 AC1（tsc 0 错误；vite 待宿主） | §0 |
| TC-S2-02 | 发送主路径 | ✅ 数据面（S2-A/B/D/E）；GUI 渲染见 L2 | §0 |
| TC-S2-03 | 双标签 ≤15s 实时 | ✅ 数据面（S2-H ≤5s 更严） | §0 |
| TC-S2-04 | 刷新历史仍在（≥50 条可完整回溯） | ✅ 数据面（S2-F 60 条 50+10 无重无漏、页间连续）；GUI 翻页见 L2 | §0；P1-4 已实现（hasOlder/loadOlder 代码 41/160–180 行） |
| TC-S2-05 | scope 切换不串 | ✅ 数据面（S2-G 双向）；前端清空逻辑代码确认；**M1 竞态注记** | §0 + M1 |
| TC-S2-06 | 「全部空间」引导 | ✅ 代码/静态（195–206 行） | |
| TC-S2-07 | 停中枢草稿保留 | ✅ 代码/静态（send catch 不清 draft）；GUI 见 L2 | |
| TC-S2-08 | 单事件源连接数（devtools） | ✅ 静态 + 数据面（唯一 hub EventSource；连接数核对属 L2 devtools） | §0 |
| TC-S2-09 | XSS 纯文本 | ✅ 静态（grep + 渲染路径正读） | §0 |
| TC-S2-10 | 空输入/超长/连发 | ✅ 代码/数据面（按钮禁用 + 8000 前置拦截；后端 400 兜底 TC-S1-12 回归过；连发 60 条升序 S2-E） | |
| TC-S2-11 | 未知 kind 按文本 | ✅ 代码/静态（渲染不依赖 kind） | |
| 波次 acceptance 1 | 对照验收标准与编码规范逐条审查，每条结论有依据 | ✅ 本报告 §1/§2 逐条给依据 | |
| 波次 acceptance 2 | 问题清单含严重度 + 位置 + 修改建议 | ✅ §2 | |
| 波次 acceptance 3 | 明确区分「必须修改」与「建议优化」 | ✅ §2.1 / §2.2 | |

**结论：S2 ChatView 功能正确、接线与 SSE 单源按 kind 过滤成立（代码 + 数据面 + 静态三层一致），渲染安全面扎实（AC5），无 P0；存在 1 项必须修改（M1 异步回写竞态，AC2「互不串」的边缘违例，改动 3–5 行）+ 7 项建议优化。build 最终绿证与 GUI（L2）需宿主/将军环境完成（已登记）。**

---

## 2. 问题清单

### 2.1 必须修改（建议收口前处理；改动量小，不阻塞主路径运行）

#### M1 🟠 loadOlder()/send() 异步回写缺会话身份守卫 —— 切换会话/空间竞态把 A 会话数据串进 B 视图（AC2「互不串」边缘违例）
- **位置**：workbench/src/components/ChatView.tsx loadOlder（160–180 行）与 send（232–256 行）。
- **问题**：两处均在 await 之后**无条件**把结果写入当前列表——setMsgs(prev => mergeById(older, prev))（168 行）/ setMsgs(prev => mergeById(prev, [msg]))（248 行）。守卫只在请求**发起前**检查一次（162 行 activeId === null / 239 行 activeId === null），await 返回后不再校验 activeId/scope 是否仍一致（对比：SSE 事件路径在回调里先比 Number(conv) === activeRef.current（139 行）才有防护；mergeNewest 按 maxId 增量过滤亦有天然低危）。时序推演：用户在会话 A 点击「↑ 加载更早」/发送后**立即**点会话 B（或切空间）→ B 的切换 effect（64–92 行）先清空 msgs 并拉 B 首页；若 A 的响应在 B 首页之后返回 → A 的旧分页/刚发消息被合并进 B 的列表，**永久串显**（后续只有再次切换会话才会全量重设，轮询/SSE 均为追加式）；若 A 响应先返回而 B 首页后到，也会造成短暂错显被覆盖的闪烁。TC-S2-05 只覆盖服务端隔离（S2-G），前端这套状态机竞态无测试无守卫——跨会话浏览（先读 A 再点 B）与发送后立刻换会话都是常见交互。
- **修改建议**（约 3–5 行）：await 前后各取一次会话身份快照（如 const convAtStart = activeId，响应时比对 activeRef.current === convAtStart，不等则丢弃）；loadOlder 额外复用 activeId effect 的 cancelled 模式或加一个递增 token。同步给 send()。并建议把「发送/加载更早后立即切换会话，回到新会话不残留旧会话消息」补进 evidence §3 L2 清单或抽 mergeById 纯函数做单测（见 O1）。

### 2.2 建议优化（可排期；按影响降序）

#### O1 🟡 IME 中文输入法 Enter 会误触发发送（主路径体验缺陷，修复 1 行）
- **位置**：ChatView.tsx onKeyDown（328–333 行）——if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send() }，未检查 e.nativeEvent.isComposing。
- **问题**：中文/日文输入法下按 Enter 上屏候选/组词时浏览器仍派发 keydown（isComposing=true），会把**未完成输入的半截文本**直接发送；本面板界面为中文（toLocaleTimeString("zh-CN")、中文 placeholder/按钮），属高频率路径。依据为标准键盘事件语义（本沙箱无浏览器，未实测，请将军 L2 走查确认一步：中文输入法敲 Enter 确认候选 → 不应发出消息）。同仓库 FilesPanel/BrowserPanel 的 Enter 提交同样缺守卫，可一并修。
- **建议**：if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)。

#### O2 🟡 根 README.md:137 仍写旧组件名 ChatPanel（文档同步残留）
- **位置**：README.md（仓库根）第 137 行「💬 对话中心（ChatPanel）…」——coder 更新了 workbench/README.md 但漏了根 README 的同段落。
- **问题**：仓库规则「修改行为的同时更新受影响文档」；ChatPanel→ChatView 改名后根 README 名称残留，且该段落描述的功能已落后（无「加载更早」分页）。git grep 全仓仅此一处实质残留。
- **建议**：与 T-047 同批把根 README 该行改为 ChatView 并补一句分页能力。

#### O3 🟡 中枢断线时 15s 轮询每次失败都弹 toast（噪音，可静默降级）
- **位置**：ChatView.tsx poll（142–146 行）每 15s 调 loadConvs()；loadConvs catch（58–60 行）无条件 toast。
- **问题**：中枢长时间不可达时，用户每 15s 收到一条「会话列表加载失败」toast（Toast 展示 4.2s），持续刷屏；mergeNewest 的失败反而已静默（127–129 行注释承认后台刷新失败静默）。轮询属后台兜底，应与用户主动操作区分错误提示策略。
- **建议**：轮询驱动的 loadConvs 失败不 toast（仅首次/由空态转失败提示一次），或引入连续失败 N 次后静默；用户主动刷新/切换时保留 toast。

#### O4 🟡 dev 模式（pnpm dev，vite）无 /hub 代理，默认 hubBase=/hub 直接 404
- **位置**：vite.config.ts 无 server.proxy；api.ts hubBase() 默认 /hub（23–29 行）。
- **问题**：pnpm dev（README §2.1 开发法）下 ChatView 默认请求 http://127.0.0.1:5173/hub/api/... → vite 无代理 → 404，会话列表空 + toast；必须手动把「🧭 中枢」设为绝对地址 http://127.0.0.1:8787（跨源可用——server.mjs 有 ACAO * + OPTIONS）才能工作。生产法（serve.mjs 托管）无此问题，故主路径验收不受影响，但 dev 首体验差且不易察觉。
- **建议**：vite.config server.proxy 加 /hub → (DSH_HUB_UPSTREAM ?? http://127.0.0.1:8787) 的转发，与 serve.mjs /hub 行为对齐（一处配置即可）。

#### O5 🟡 前端状态机无自动化测试；mergeById 等纯逻辑未导出（测试覆盖注记）
- **位置**：ChatView.tsx mergeById（17–22 行）/ loadOlder / hasOlder 边界；workbench 无组件/纯函数测试目录。
- **问题**：本 diff 新增的分页合并/去重/追加逻辑（M1 竞态正在此类）只被数据面冒烟覆盖，UI 状态机（msgs 合并、hasOlder 翻转、stickRef 滚动策略）零自动化测试；TC-S2-02/03/04/05/06/07/10/11 的 UI 断言只能靠 L2 人肉。合并/去重逻辑出错时冒烟仍可能全绿（冒烟打的是服务端数据面，不是组件状态）。
- **建议**：把 mergeById（及可选 olderPage 判定）抽为纯函数模块（如 workbench/src/chatMerge.ts）并补 node --test 或 vitest 单测（零新依赖优先：纯函数 + node:test）；至少把 M1 修复配套的时序用例固化。

#### O6 🟡 SSE chat:message 每事件一次「全量最新页」回拉（事件洪峰下的冗余请求）
- **位置**：ChatView.tsx 139 行 → mergeNewest（118–130 行）对每条 chat:message 拉取最新 PAGE 条再增量合并。
- **问题**：事件本身不带正文（detail 只有 conv/msg/kind），客户端必须回拉才能显示新消息——低频单用户无碍；但连发/多端高频（如他端灌 60 条）时本端 60 次 GET /api/chat/messages（每次回 50 行）+ 60 次 loadConvs（send 路径另发），冗余放大。
- **建议**：事件回调做 ~300ms 防抖合并刷新（同 tick 多条只拉一次）；远期可选服务端在 chat:message detail 携带 body（体积权衡后定），或 /api/chat/messages 支持 after=id 增量拉取（服务端 TC-S1 侧补一条契约）。

#### O7 🟡 继承性注记：GET /api/chat/messages 无调用者权限/scope 门禁（S1 域既有，不在本 diff）
- **位置**：team-hub/server.mjs listMessages（608–624 行）只按 conv id 校验会话存在，未校验请求者与会话 scope 的关系；会话 id 全局自增可枚举 → 知晓 id 即可跨空间读消息/在任意会话发言（写侧 author=by 绑定但 by 由 hubPost 默认 general 注入）。鉴权 off（本地）时无碍；鉴权 on 场景属 S1 域设计问题（T-055 R-1「scope 软隔离跨分区读写」相关）。
- **建议**：不在 S2 前端范围处理；建议登记 S1 后端后续项（读接口按 scope 校验或按 token 绑定成员过滤），本报告仅作继承性留痕。

---

## 3. 结论与放行建议
- **功能判定**：S2 ChatView + 接线实现正确——AC2/AC3/AC4/AC5/AC6 逐条成立（除 M1 边缘竞态），TC-S2-01..11 无未达成项（build 环节待宿主、GUI 项待 L2）；SSE 单源按 kind 过滤（AC4/TC-S2-08）与纯文本渲染安全（AC5）均有静态 + 数据面双重证据。
- **待宿主/将军确认项（不阻塞本 review 结论，阻塞 promote 前放行）**：
  1. 宿主环境跑 cd workbench && pnpm build（沙箱 EPERM 复现，非代码问题）确认构建绿；
  2. evidence §3 L2 清单浏览器逐条勾选（含 TC-S2-03/04/05/07 的 GUI 形态、devtools 单源连接数）；
  3. M1 修复建议在 promote 前或紧随其后的小修任务里落地（本审查未改任何代码）。
- **promote 建议**：修复 M1（3–5 行）后可 promote；O1（IME）为 1 行高频体验修复，建议与 M1 同批或紧随；O2 为文档一行同步。O3–O7 可排期后续。