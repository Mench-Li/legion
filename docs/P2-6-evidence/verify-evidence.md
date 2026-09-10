<!-- evidence-banner:start -->
> ⚠️ **历史快照 —— 不作为当前状态依据。** 本目录文档反映 **2026-09-10**（commit `adec685`） 的基线，其中的测试数量、端口、命令与结论只代表当时状态。
> 当前状态请看：[docs/STATUS.md](../STATUS.md)（状态与测试基线）· [README.md](../../README.md)（总览）· [docs/DEPLOY.md](../DEPLOY.md)（部署）· 最新 CI 证据 `.ci/<run>/summary.json`。
<!-- evidence-banner:end -->

# P2-6 对话中心真实闭环 — 验收证据

> 日期：2026-09-10　提交：`main`（P2-6）
> 结论：四项待改动全部落地；**真实守护 + 真实模型**的端到端链路已在生产环境验证通过。
> 决策（用户拍板）：真实模型 E2E 允许在生产 `software` 空间跑 1 条探针（留痕不删）；
> UI 验证采用「纯函数抽取 + 单测」形态（不引入前端渲染测试设施）。

## 0. 前置能力（改动前已存在，本任务不重复建设）

| 能力 | 位置 |
| --- | --- |
| 会话/消息/分页/scope 隔离/审计 | `team-hub/server.mjs`（`/api/chat/*`） |
| awaiting/replied/failed 状态机 + CAS 回写 + 重试 | `postAiReply` / `failAiReply` / `retryAiReply` |
| 回复开关（per-scope）/身份/系统提示词/模型选择 | `chat_reply_settings` + `/api/chat/reply-settings` |
| 守护 chat-responder（拉队列 → 真实子代理 → 回写） | `plugins/src/index.ts`（`answerChatMessage`） |
| 提示词与身份构建 | `plugins/src/chatResponder.ts` |
| 上下文收集（空间摘要 + 附件内容） | `plugins/src/chatContext.ts` |
| 附件数据面（staged/sent、TTL、上限、越权） | `team-hub/server.mjs`（`chat_attachments`） |
| 前端面板（SSE + 15s 轮询 + 健康条 + 重试按钮） | `workbench/src/components/ChatView.tsx` |

## 1. 真实 DSH 守护与模型通道 E2E ✅

探针：`scripts/live/p26-chat-e2e.mjs`（可复跑；生产 8787，`scope=software`）。

真实运行结果（2026-09-10）：

```
[+  0s] health: online=true enabled=true modelResolved=true
        model={"provider":"custom-ds","model":"deepseek-v4-flash-openai","source":"daemon-heartbeat"}
[+  0s] 创建探针会话 conv=2 title=P2-6 真实模型通道探针（可留痕）
[+  0s] 发送消息 id=4 author=p26-probe
[+  0s] 发送后状态: aiStatus=awaiting（期望 awaiting）
[+ 12s] 状态变化: awaiting → replied
[+ 12s] 会话消息数=2 回复条数=1

状态流转: awaiting → replied
轮询观测序列: ["awaiting","awaiting","replied"]
回复者: software-assistant
回复正文: 已收到 P2-6 真实模型通道端到端探针消息；我是运行在 DeepSeek Harness 中的
          deepseek-v4-flash-openai 模型，本次仅作一句话确认，未调用任何工具、未读写文件或访问网络。
meta: {"replyTo":4,"aiModel":"deepseek-v4-flash-openai"}
耗时: 12s
```

**这条链路是真闭环**：前端/探针发消息 → 服务端据开关标 `awaiting` + 进队列 →
**真实守护进程**（`soldier-auto@software`，节拍 30s，实际 12s 内命中）拉取 → `ctx.subagents.start`
起**真实模型子代理**（`custom-ds / deepseek-v4-flash-openai`）→ 结构化 `{reply}` 回写
`/api/chat/replies/answer` → 服务端 CAS 置 `replied` 并落一条 `author=software-assistant` 的回复消息 →
前端 SSE `chat:message` 实时呈现。全程无夹具、无桩模型。

## 2. awaiting → replied/failed 的前端合并与断线恢复 ✅

**问题根因（已修）**：AI 三态是**同一条源消息的 meta 更新**，只「追加新 id」的合并会让气泡
永远停在「等待回复」。`workbench/src/chatUi.ts` 的 `mergeChatMessages` 明确以同 id 覆盖语义
（实现委托 `dedupe.mergeById`，单一实现）并有回归锚点。

真实链路验证：`scripts/live/p26-chat-resilience.mjs`（隔离 hub 实例，**23/23 PASS**）：

```
== 1. SSE 基线 ==
  ✓ seq 严格递增（无重复/无回退）
  ✓ 在线期间无缺口（shouldRefillChat 不误报）
  ✓ chat:message 事件可被前端按 action 过滤到
== 2. 断线期间的写入：重连续传 + 缺口判据 ==
  ✓ 续传拿到断线期间的增量帧 — seqs=[3,4,5] watermark=2
  ✓ 续传从 watermark+1 开始（无重复、无空洞）
  ✓ 续传帧 seq 连续（前端不会误判缺口 → 不触发多余重拉）
  ✓ AI 回复也走 chat:message 审计（前端按 action 过滤可收到）
  ✓ 无续传头 → 回放有界（最近 30 条）
  ✓ 补拉拿到断线期间全部用户消息（无丢失）— count=4
  ✓ 补拉拿到守护在断线期间写下的回复行
  ✓ 源消息三态终值随补拉可得（awaiting → replied）
  ✓ 源消息记录回复行 id（replyMsg）
  ✓ 模型名落在回复行 meta.aiModel（源消息元数据不含模型）
== 3. 失败路径 ==
  ✓ 发消息即标 awaiting
  ✓ 标记失败成功（body 字段名是 error）
  ✓ 状态转 failed / 失败原因可读（前端展示用）
  ✓ 重试成功（failed → awaiting）／重试后清掉 aiError
  ✓ 重复重试不产生二次入队（CAS 幂等）
```

**前端新增的恢复层**（`ChatView.tsx` + `chatUi.ts`）：

1. **SSE 连接状态可视化**：`chatSseLabel(state, opens)` 四态（已连接 / 已重连（第 N 次）/
   重连中 / 已断开），顶栏显示圆点 + 文案，断开时仍可点击手动刷新。
2. **重连即补齐**：`subscribeHubAudit` 的 `onStatus` 在 `reconnected` 时立即重拉当前会话消息
   与会话列表，不等 15s 轮询。
3. **缺口判据**：`shouldRefillChat(watermark, seqs)` 以全量事件流的 seq 水位检测跳变
   （首帧只建基线不误报；`NaN` 忽略），检出即重拉并累加「补齐 N 次」计数。

> **为什么续传之外还要缺口层（诚实说明）**：服务端 `/api/events` 在**带** `Last-Event-ID` 时
> 只回放增量（浏览器原生 `EventSource` 会自动带该头），但**不带**该头时只回放**最近 30 条**
> （有界）。因此「断线久到超出回放窗口」「连接online但中间丢帧」两种情况服务端续传都不保证完整，
> 必须有本地水位判据兜底。两层叠加才是完整恢复语义。

## 3. 模型不可用、超时、守护离线的完整 UI 验证 ✅（纯函数形态）

判定逻辑从组件内联抽到 `workbench/src/chatUi.ts`，`workbench/scripts/chat-ui.test.mjs` **9/9 PASS**：

| 场景 | 判定与文案（断言锚点） |
| --- | --- |
| 端点缺失 | 灰态「健康状态未知」——**不误导**为"离线" |
| 加载中 | 灰态「检测中…」 |
| **最近失败**（含 provider 超时/foreman down） | 红态，title 含原因 + 「重试」可行动指引 |
| **守护离线** | 黄态，含「守护离线：请启动守护进程（scrum-worker）后重试」 |
| **模型未配置** | 黄态，含「模型未配置：…选择 assistant 可用模型」 |
| 开关关闭 | 黄态，含「AI 回复未开启：点「⚙ 回复设置」打开开关」 |
| 三项同时缺失 | 黄态，三条并列（不互相掩盖） |
| 全就绪 | 绿态 + 诚实标注「已解析不代表 provider 实际可用」 |
| 超时/失败文案（发送侧） | 401/403 → 未授权 + token 指引；网络类 → 中枢不可达；**均含「草稿已保留」** |
| AI 三态栏位 | awaiting「等待 AI 回复…」/ failed「回复失败：原因」+ 可重试 / replied「已回复 · 模型」 |

**诚实的覆盖边界**：这是**判定与文案**的自动覆盖，不是真实浏览器渲染验证——组件树/DOM 文案
未做自动断言（用户选择的形态，不引入 jsdom/react 渲染设施）。真实渲染行为依靠现场核对。

## 4. 附件上下文生命周期和清理 ✅

新增 `plugins/tests/chat-context.test.mjs`（**13/13 PASS**，已随 plugins 套件进 CI）——
此前 `gatherChatContext` **零测试覆盖**。

**A 组：`gatherChatContext` 降级纪律**（假 hub + 临时目录，无外部依赖）

- 空间摘要四态：未提供 `bindingDir` → `undefined`；`null`（空间未绑定）→ 降级占位；
  目录不存在 → `unavailable` + 原因；目录有内容 → `text` + 「只读快照」标注。
- 附件收集：无引用 → 空数组；非法 id（0/负数/小数/null）被过滤且**不发请求**；
  hub 不可达 / HTTP 404 / 内容为空 → 分别给出可读 `readError`，**一律不 throw**
  （否则上下文故障会把源消息误标 failed）。
- 请求契约：带 `id/conv/scope/by` 四参（服务端据此做归属与越权校验）；`hubUrl` 末尾斜杠被规范化。

**B 组：附件生命周期全链路**（真实 hub，隔离库）

- **staged → sent 流转**：上传为 `staged` → 绑定消息后转 `sent`；消息 `meta.attachments`
  只存 `{id,fileName,size}` 引用；**反向断言**附件正文不出现在 `messages` 行任何字段（TC-S6-09）。
- **内容读取准入**：**staged 不可读（403）**——附件只在绑定到具体会话消息后才可读；
  绑定后同 scope + 同 conv 可取回；跨会话 / 跨空间 → 403；缺 `by` → 400；未知 id → 404。
- **引用与内容生命周期解耦**：TTL 到期后附件行 + 落盘文件被删除，但**消息 meta 的引用仍在**
  （前端可解释「附件已过期」）；此时 `gatherChatContext` 把该附件降级为含 404 的 `readError`，
  端到端接上 A 组的降级纪律。
- **历史消息不回填**：后续无附件消息的 meta 不含 `attachments`；已绑定附件重复引用被拒
  （「已被绑定」）；跨 scope 引用被拒（「不属于该空间」）；超过 `CHAT_ATTACH_MAX_PER_MSG` 被拒（「超限」）。
- **孤儿清理**：未被引用的 `staged` 残留按 staged TTL 清理（未到期不动，到期删行）。

## 5. 过程中修掉的真实缺陷

1. **「已回复 · 模型」永远显示不出模型**：服务端把模型写在**回复行**的 meta
   （`{replyTo, aiModel}`），源消息 meta 只有 `aiStatus/repliedAt/replyMsg`；
   原实现只读源消息 `meta.aiModel` → 恒为 `undefined`。新增 `replyModelOf(msg, list)`
   按 `replyMsg` 回查回复行，组件接线后模型名才能真正显示（回归锚点在 chat-ui 套件）。
2. **合并逻辑两份实现**：`chatUi.mergeChatMessages` 与 `dedupe.mergeById` 语义重复 →
   改为委托，保留单一实现（避免两处合并逻辑各自演化）。
3. **401/403 未被识别为未授权**：发送失败文案原要求同时出现 token 字样，导致仅带状态码的
   错误（api.ts 封装只带状态码，如 `chat messages 401`）落到通用文案；改为按状态码
   （`\b40[13]\b`）独立判定。
4. **空列表时同批重复 id 未去重**：`mergeChatMessages([], [m, m])` 会留下两条（回放/重试
   返回同一条消息时出现）；委托 `mergeById` 后统一走 map 去重。

## 6. 复跑方式

```powershell
cd D:\project\DSH\legion
# 自动回归（进 CI）
node --test --experimental-strip-types workbench/scripts/chat-ui.test.mjs   # 9 用例
node --test plugins/tests/chat-context.test.mjs                             # 13 用例
# 真实链路探针（需要运行中的生产守护与真实模型；不在 CI 中跑）
node scripts/live/p26-chat-e2e.mjs          # 真实守护 + 真实模型（手工，消耗少量 token）
node scripts/live/p26-chat-resilience.mjs   # 隔离 hub 的续传/缺口/失败路径（23 检查）
```

## 7. 已知边界（诚实登记）

1. **真实探针只跑了 1 条消息**（用户授权的范围）：覆盖成功路径（12s 内 replied）与真实模型
   回写；**未**在生产上人为制造 provider 超时/守护离线（故障态由隔离实例与纯函数测试覆盖）。
2. **UI 验证是判定层而非渲染层**：未引入 jsdom/react 渲染测试，DOM 文案无自动断言。
3. **断线恢复仍有窗口**：SSE 断开期间前端只能靠 `reconnected` 回调与 seq 缺口重拉；
   若浏览器标签页被挂起（定时器冻结），补齐会延后到下次唤醒/轮询。
4. **附件内容为文本**（`kind='text'`，UTF-8 读回）：二进制附件的上下文注入未支持。
5. 生产 `software` 空间的探针会话（`conv=2`，标题「P2-6 真实模型通道探针（可留痕）」）
   **保留不删**，可随时复查真实回复内容。
