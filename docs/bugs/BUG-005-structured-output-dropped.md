# BUG-005｜模型答了，答案被扔掉：「未拿到结构化结果」被当成「没有答案」

> 发现于 BUG-004 修复后的第一次重试（你让我点的那一下）。**已修复，待宿主重启生效。**

## 1. 现象

BUG-004 修好之后（同一个会话、23 秒前刚成功回复过一条），重试 `msg 165`（「什么进展了」）：

```text
+41s  源消息 aiStatus=failed
      aiError=AI 回复失败：原因暂不可识别。请点击「重试」…
```

而守护日志给出的失败文案是**没有原文片段**的 `empty-other` 兜底。同一时间、同一模型、
同一会话的 `msg 180` 却成功了 —— 说明它不是配置问题，是**这一条回答走了另一条路**。

## 2. 证据：模型答得很完整，只是没走结构化工具

那次的子代理会话（`~/.dsh/storages/session_projcache/sessions/42e5d691-….json`）：

| 读数 | 值 |
| --- | --- |
| `llmMs` / `decodeTokens` | **5686 / 1134** |
| `steps` / `lastTurnCompleted` | **1 / true** |
| 输出正文 | **120 字**的完整进展汇报（「基于当前任务记录…T-177 修复：CI test 阶段…」） |

同时 `conv 25` 里**没有**这条回复 —— 一段已经生成好的答案，被丢在了子代理会话里。

## 3. 根因：harness 的既定行为 + Legion 的判据太窄

DSH 的 in-process 结构化运行时（`@deepseek-ai/dsh-subagent-in-process-driver` 的 `readResult`）：

```js
if (structured !== void 0) {
    if (structured.captured !== void 0) return { output, structured: structured.captured.value, stopReason }
    if (stopReason === "completed") return { output, stopReason: "error" }   // ← 完成被改写成 error
}
return { output, stopReason }
```

即：**请求了 `outputSchema` 但模型没有产出结构化结果时，harness 把 `completed` 改写成
`error`、并丢掉 `structured`**（这是它刻意的纪律——"无法命名的结束按未完成上报，而不是静默当成功"）。

而 Legion 的守护只认结构化那一条路：

```js
if (result === null || result.stopReason !== 'completed' || result.structured === undefined) { 判失败 }
const answer = String(result.structured.reply ?? '').trim()
```

于是：
1. 模型**经常**直接给纯文本——因为 Legion 自己的回复提示词就写着「回答以纯文本输出，
   不要用代码块包裹整篇回答」；提示词与 `outputSchema` 的要求**互相拉扯**；
2. 一旦模型走了文本这条路，`structured === undefined` ⇒ 整条答案被丢；
3. 分类器收到的 `stopReason` 是 harness 改写后的 `'error'`、`error` 字段是 `undefined`
   ⇒ 落到 `empty-other`，产出那句最不可操作的「原因暂不可识别」。

**这里失去的不是一次调用，而是一份已经拿到的答案。** 判据"没有结构化结果"被当成了"没有答案"。

## 4. 修法

`plugins/src/index.ts` 的 `answerChatMessage`，取答案从"只有一条路"改为"两条路"：

1. **首选**结构化结果（`stopReason === 'completed'` 且有 `structured`）——不变；
2. **回落**到 `result.output` 里的文本块（`type === 'text'` 拼接），**只要非空就用它作答**；
   并在日志里留一行说明回落发生了（回落没有 `reply` 字段的约束，必须**可见**）；
3. 两条都空时，才走原来的失败路径 + 分类器文案。

没有放宽"什么时候算失败"：**没有可用输出**仍然判失败（另有单测守着）。

## 5. 判据

```bash
node scripts/ci/build-external-package.mjs plugins          # plugins/tests 跑的是 lib/ 构建产物
node --test plugins/tests/chat-replies-agent.test.mjs       # 6 例（新增 2 例）
```

| 用例 | 断言 |
| --- | --- |
| ★ 结构化缺失但有文本 | 必须**回写文本**、身份仍是 `agent:software:coder`、**不许同时写一条失败** |
| 结构化缺失且文本为空 | 必须判失败（回落不是万能兜底，消息不许挂在 `awaiting`） |

**反向验证**：把 `const answer = structuredReply.length > 0 ? structuredReply : outputText`
改回 `const answer = structuredReply` 并重建 ⇒ 第一条用例**红**（5/1）；恢复即绿（6/6）。

连带不回归：`chat-responder` / `chat-error-classifier` / `chat-context` 共 **33 例**全绿。

## 6. 边界

- **生效需要宿主重启**：实测确认宿主**不热重载**守护插件——重建 `lib/` 之后重试 `msg 165`
  仍然走旧代码（同样的 `empty-other` 文案）。这与 BUG-002 第二半同一次重启即可一并生效。
- 本修复**不改变**失败分类器的五类枚举（有单测钉着），也不改变"什么时候判失败"的语义边界。
- 落回文本意味着回答**没有** `{reply}` 的形状约束。对"对话回复"这个用途是等价的（内容就是答案）；
  若将来这个通道要承载结构化字段（如引用事件 ID），那时应当**先让提示词与 outputSchema 一致**，
  而不是继续依赖回落。
- 提示词与 `outputSchema` 的拉扯**未在本次修改**：提示词仍写"以纯文本输出"。这是有意为之——
  改提示词会影响回答风格，而回落已经让两种输出都能落地；要改应单独评估。
