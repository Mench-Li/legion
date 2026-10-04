# BUG-002｜「Agent 对话失败」：回复队列永远看不见新消息

> 现象、现场读数、根因、修法、判据、边界。判据都是**可复跑的命令**。

## 1. 现象

在「编码工程师」的会话里问「什么进展了」（界面上的原文，22:35:43），等到的是：

```text
× 回复失败：回复超时（120000ms 内未收到回复方应答）
```

同时对话头部健康点是「最近回复失败」，而**守护进程全程在线**（心跳正常）。
界面上看不出任何可操作的方向——「回复超时」听起来像模型慢或网络差，实际两者都不是。

## 2. 现场读数（2026-10-04，全部只读）

| 读数 | 值 | 说明 |
| --- | --- | --- |
| `GET /api/chat/health?scope=software` | `online:true`、`modelResolved:true`、`model: fjd-ds/deepseek-v4-flash-vision-openai` | 守护在线、回复开关开、模型已解析——三个前提**都满足** |
| 同上的 `lastFail` | `msgId:165 convId:25 aiError:"回复超时（120000ms 内未收到回复方应答）"` | 就是界面上那一条 |
| `GET /api/chat/reply-settings?scope=software` | `enabled: true` | 不是"回复被关掉了" |
| `GET /api/chat/replies?scope=software&limit=20` | `messages: []` | **队列是空的**（这就是根因所在） |
| 守护日志 `dsh-scrum-worker.log` | 最后一次 `chat-responder` 行在 **2026-09-10** | 一个月里一次都没处理过对话消息，却**一行错都没有** |
| 该日志同期 | 每 30s 一轮扫单（认领/流水线）照常 | 守护在扫，只是"没东西可答" |
| `messages`（scope=software） | **137 条**，id 区间 `1..169` | 关键数字：**>80** |

### 2.1 把队列取数语句原样跑一遍

守护每轮请求的就是这一条（它固定传 `sinceMsgId=0`）：

```sql
SELECT * FROM messages WHERE scope='software' AND id > 0 ORDER BY id ASC LIMIT 80;
```

| 读数 | 值 |
| --- | --- |
| 窗口命中的 id 区间 | `1 .. 80` |
| 窗口内 awaiting 条数 | **0** |
| 用户那条提问（id 165）在窗口里吗 | **不在** |
| 换成 `ORDER BY id DESC LIMIT 80` | 最新 169 在窗口里，165 也在 |

**新消息永远进不了窗口** ⇒ 队列恒为空 ⇒ 守护无事可做 ⇒ 120s 后服务端兜底标
`failed`（`markStaleAwaiting` 只在队列被拉取时执行，所以那句"超时"是**唯一**能被看见的痕迹）。

> 空队列是**正常状态**。于是"守护根本没看见这条消息"与"没有消息"在日志上同形——
> 这就是这个 Bug 能在生产里安静地活一个月的原因。

## 3. 根因

`team-hub/server.mjs` 的 `listAwaitingReplies`：

```js
// 旧写法
db.prepare('SELECT * FROM messages WHERE scope = ? AND id > ? ORDER BY id ASC LIMIT ?')
  .all(sc, since, Math.min(n * 4, 800))
```

- 调用方（守护 `sweepChatReplies`）**从不带 `sinceMsgId`**（它没有游标），路由默认补 0；
- `n = limit = 20` ⇒ 窗口 80 条；
- `id ASC` ⇒ 窗口 = 本空间**最早**的 80 条。

于是在 `software` 空间攒到 137 条消息之后，任何新提问都落在窗口之外。
**旧实现在消息数 < 80 的空间里完全正确**——这正是它活了这么久的原因
（实测 2026-09-06 / 09-10 的两次成功回复，都发生在该空间只有个位数消息时）。

这不是新发现：`docs/review/T-100-REVIEW.md` 的 **M3 🟠**（2026-09）已经把它写成
「**队列饥饿**：`listAwaitingReplies` 先按 id 取 `LIMIT n*4` 条再 JS 过滤 awaiting……
即使前面有更老的 awaiting 也会被窗口截掉，守护反复空转」，并给了两条建议。
当时的结论是"若按低活跃本地工具接受窗口限制，请在头注释与 TEST_CASES 记录边界"——
**边界没有记录，也没有用例**，于是它在下一次高活跃空间里直接命中了默认的 `software`。

## 4. 修法

| 位置 | 改动 |
| --- | --- |
| `team-hub/server.mjs` `listAwaitingReplies` | 窗口从**最新**一侧取：`ORDER BY id DESC LIMIT ?` 后 `rows.reverse()`。对外契约不变（仍是「`id > since` 的 awaiting、**升序**返回」），但新消息一定在窗口里。`limit` 截断后取窗口内最早的那条（先来先答，不饿死）。 |
| `plugins/src/index.ts` `answerChatMessage` | 岗位会话的回复方身份改用服务端给的 `msg.agent.identity`（`agent:<scope>:<role>`），并把 `msg.agent` 传进提示词。见下。 |

### 4.1 为什么连岗位身份一起修

服务端**早就**在队列载荷里给了岗位上下文（`listAwaitingReplies` 的 `agent: {role,name,kind,identity,tasks}`），
`chatResponder.ts` **早就**支持把它写成提示词里的「岗位任务记录」块（还有单测），
`team-hub/agent-main-chat.test.mjs` **早就**断言队列里必须有它——**只差守护这一句传递**。

不接的后果有三条，都指向"看起来答了、其实答错了"：

1. 提示词说的是"你是本空间的对话助手"，于是「发给编码工程师」被一条通用助手规则回答；
2. 回写 `by` 用 `software-assistant`，而界面按 `agent:<scope>:<role>` 认领回复者
   （`ChatView.tsx` 的 `m.author === \`agent:${scope}:${agent.role}\``），回复会显示成别人；
3. 防自我触发的比较基准也跟着错（岗位自己的进度消息 `author` 与回复身份不是同一个字符串）。

## 5. 判据（可复跑）

```bash
# ① 队列窗口：新消息必须进得了窗口；升序/limit/sinceMsgId 契约不变
node --test team-hub/chat.test.mjs            # 53 例（含新增 2 例）

# ② 守护接线：岗位身份 + 岗位任务记录进提示词；空间会话不回归
node scripts/ci/build-external-package.mjs plugins   # plugins/tests 跑的是 lib/ 构建产物
node --test plugins/tests/chat-replies-agent.test.mjs # 4 例

# ③ 端到端 A/B（在**库副本**上跑两个中枢，不碰生产库）
node docs/bugs/BUG-002-verify.mjs
```

③ 的读数（本机实测，`after` = 本工作区，`before` = 主检出＝HEAD）：

| 变体 | 会话 | 新提问 | 队列 | 队里有它吗 |
| --- | --- | --- | --- | --- |
| after（修复后） | conv 25「编码工程师」(agent_role=coder) | id 170 `aiStatus=awaiting` | **1 条** | **是**（并带 `agent.identity=agent:software:coder`、16 条岗位任务记录） |
| before（修复前） | 同上 | id 170 `aiStatus=awaiting` | **0 条** | **否** |

**反向验证**（证明判据真的会红，不是"碰巧绿"）：

- 把 `team-hub/server.mjs` 恢复成旧实现 → `team-hub/chat.test.mjs` 新增的 2 例**红**
  （`pass 51 / fail 2`），恢复即绿（`53/53`）；
- 把 `plugins/src/index.ts` 恢复成旧接线并重建 `lib/` → `chat-replies-agent.test.mjs`
  **3 例红**（身份、防冒名、失败回写），恢复即绿（`4/4`）。

## 6. 影响面与已知边界

- 修复只动「队列怎么取数」与「守护怎么称呼自己」，**不改超时值、不改 CAS、不改队列返回形状**；
  既有 53 例 chat 契约 + 31 例 plugins 对话用例全绿（含空间会话的旧身份路径）。
- **部署要动两处**（本 Bug 跨进程）：主检出的 `team-hub/server.mjs`（中枢侧）与
  `plugins/`（守护侧，且 `plugins/lib` 是构建产物，须 `node scripts/ci/build-external-package.mjs plugins` 重建）。
  **守护的接线改动要重启 DSH 宿主**才会加载新的 `lib/`。
- 残留窗口边界（本次**未**动）：队列仍只扫最近 `limit*4`（默认 80）条。若 120s 内同一空间灌进
  >80 条更新的消息，更老的 awaiting 仍可能被挤出去——现实中守护每 30s 拉一次、单轮答 3 条，
  远达不到这个速率。要彻底消除，得给 awaiting 建专用游标表（T-100 评审的建议①）。
- `markStaleAwaiting` 仍只扫最新 500 条（T-100 评审 M3 的另一半）：同一空间 120s 内涌入 >500 条
  消息时，窗口外的 awaiting 不会被兜底标 failed（会长期停在 ⏳）。同样属于"高活跃空间"边界。
- ★ **超时预算相等**（本次也**未**动，留给下一个 Bug）：守护的单条回复预算
  `min(workerTimeoutMs, 120000)` 与服务端兜底 `CHAT_REPLY_TIMEOUT_MS=120000` **完全相同**，
  而兜底从**消息落库那一刻**起算、守护最多晚 `intervalMs=30s` 才开始跑 ⇒ 模型只要花
  >90s，服务端一定先标 `failed`，守护随后算出的**可行动分类文案会被 CAS 丢弃**，
  用户看到的永远是最不可操作的「回复超时」。这不是本次的故障原因（本次队列里根本没有它），
  但修好队列之后它会成为下一个可见失败。
