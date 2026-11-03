# @agent：从"被点名"到"开工"的完整链路

日期：2026-11-02 ｜ superagent HEAD `6337fc8` vs Legion
证据分级：**[实证]** 读过代码给 file:line；**[推断]**；**[待核]**

---

## 0. 三句话

1. **@ 不是"打招呼"，它是 superagent 里唯一的 explicit 授权入口**：在 GitHub 上，名单内的人 @ 智能体 = `explicit`；除此之外的一切（bot、未 @、未点名的人）最多是 `inferred`，要 `auto` 档 + 命中规则才动。（`docs/002-authorization.md:11-16,48-53`）
2. **它不需要公网入口**：入站通道是**智能体账号的 GitHub 通知 API**（`notifications?all=true&per_page=50&since=…`，`sources/github.ts:304`），不是 webhook。这是"没有公网 IP 也能做 @agent"的关键设计。
3. **Legion 的 @ 是结构化的、且只对内**：`mesh_send({ to: '<角色名>' })`（`mesh/README.md:25-28`）——寻址靠**字段**不靠文本解析；`team-hub` 里没有任何 user-mention 解析（grep `mention` 全为 `id@version` 误命中）。外部身份与文本级 @ 都没有。

---

## 1. GitHub 侧：点名 → 事件 → 准入 → 回话

| 环节 | 实现 | 证据 |
| --- | --- | --- |
| **识别 @** | 正则带边界：`(?:^|[^a-zA-Z0-9_@])@login(?![a-zA-Z0-9_-])`，大小写不敏感 → 不会把 `foo@login.com` 或 `@login-x` 误判成点名 | `github-trigger.ts:60-61` |
| **命中哪些载体** | 评论正文、review 正文、Issue/PR 正文；无正文的评论与 `APPROVED/CHANGES_REQUESTED` review 也各自成为一个事件（文本写成 `APPROVED review of commit …`）→ **一个"批准"就能唤醒等评审的执行者** | `github-trigger.ts:54-58,65-77` |
| **身份判定** | `human = isHumanLogin(user) && !sameName(user.login, agent)`：`[bot]`/GitHub App 不算人；**智能体自己 @ 自己也不算** → 天然防自触发环 | `github-trigger.ts:46-47,62-63` |
| **事件 ID 幂等** | `key('github-comment', html_url, comment.id, updated_at)`：同一条评论重复读到 → 同一个 Trigger（只成一个工单）；**编辑过 → 新 version → 新 Trigger** | `github-trigger.ts:68`、`docs/001-domain.md:28` |
| **入站通道** | 轮询**通知**（`all=true&since=<cursor>`），再按 `repository.full_name` 过滤；游标与失败重试表原子推进；410 已删 Issue 记错后丢弃 | `sources/github.ts:297-342` |
| **编辑加 @ 不算** | "A mention added by a later edit to the body is not read: only the author can be the actor of the body" → **防事后追认**。文档也明说：想补 @ 就发新评论 | `github.ts:353`、`docs/006-deployment.md:147` |
| **回话地址** | `channel = githubChannel(number, html_url)`，inline review comment 带 `path:line` 与 diff 片段 → 回到**原会话/原 review 线程** | `github-trigger.ts:7-11,72` |

**准入怎么接上**：`explicit` 的定义就写在 Source 的 policy 段里 —— "An account on the list mentions the agent's account in an Issue or a comment"（`github.ts:79`）。也就是说：**@ 只是把消息变成"明确的请求"，能不能成还得过名单**；名单外的人 @ 了也只是按准入表判（默认 ignore），bot 的 @ 永远只能是 `inferred`（`github.ts:77`、`docs/002-authorization.md:56-79`）。

**默认最小接收**：不开 `observeIssues/observePulls/observeComments/observeCi` 时，**只有点了名的事件进来**（`github.ts:51-55`）。噪声默认最小。

## 2. 飞书侧：同一个语义，另一套形状

| 环节 | 实现 | 证据 |
| --- | --- | --- |
| 识别 | `event.mentions.some(m => m.id === botId || m.id === botAppId)`；私聊另记 `addressed: 'direct'` | `feishu-trigger.ts:35-42` |
| 名字还原 | `withMentionNames()` 把 `@_user_1` 之类的占位 key 换回 `@真实姓名`，否则模型读到的是一串 key | `feishu-trigger.ts:19-21` |
| 接收档位 | 每个群 `listen: 'mentions' \| 'all'`；未列出的群 `otherChats: 'none' \| 'mentions'`；默认最严 | `feishu.ts:24-28,44-47` |
| 准入 | "名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置" | `feishu.ts:89` |
| 线程 | 靠 `root_id / parent_id / thread_id` 归并到 Thread | `feishu-trigger.ts:42,77` |

## 3. 端到端时序（GitHub）

```
① 人在 Issue 里评论 "@agent-doer 把登录限流改成滑动窗口"
② GitHub 给 agent 账号推一条 notification（无需 webhook、无需公网）
③ Source 每分钟轮询 notifications → 解析 issue/PR 号 → 读线程
④ 建 Trigger：addressed=mention, human=true, actor=<人的 login>, id 确定
⑤ Gate：名单内 → explicit；名单外 → 准入表（默认 ignore，留 Disposition 记录）
⑥ Assessment：逐条规则判 → accept → Ticket + Mandate(strength=explicit, sender=…)
⑦ Executor 在独立 session/目录干活；Channel 回到同一 Issue 评论（先 ack，后结果）
⑧ 该 Issue 线程与它开的 PR 进入 Subscription：后续评论无需再 @ 即可续跑，但不扩权
```

第⑧步是最容易被忽略的：**@ 只在开头需要一次**。之后线程里的讨论自动回流，这正是 superagent 敢让人"@ 一下就走开"的原因（`docs/001-domain.md:37`、`docs/003-execution.md:108-116`）。

---

## 4. Legion 现状：有"寻址"，没有"点名"

| 能力 | Legion | 证据 |
| --- | --- | --- |
| 结构化寻址（发给某个角色） | **有**，而且比 @ 更可靠：角色名 → agent id 由 roster 绑定，工具从 `exec.agent` 解析，不靠自报；`to:'all'` 可广播 | `mesh/README.md:19-28` |
| 文本级 @ 解析 | **无**（team-hub 内 grep `mention` 无相关命中） | — |
| 外部身份（一个对外账号） | **无**（没有 GitHub/Feishu 集成） | — |
| 评论 → 唤醒执行者 | **有，但语义是"退回纠错"**：`in_progress` 且本角色认领后有人评论 → 视为被将军退回，派纠错 worker（提示词附最新评论） | `plugins/src/index.ts:10-11` |
| 评论 = 新指令 / 续跑 | **无**：评论只会触发"重做"，不会触发"追加范围"或"回答提问" | 同上 |
| 自 @ 防护 / 编辑追认防护 | 无对应物（因为没有文本 @） | — |

**这同时补上了上一份报告里那条 [待核]**：Legion 的评论**会**唤醒执行者，但只走 rework 通道（把人话当"驳回"）；`ready/blocked` 之后的续跑仍要将军重新派工。

**关键差别一句话**：
> superagent 的 @ 是**对外身份 + 授权入口**；Legion 的 @ 是**对内路由 + 任务归属**。前者解决"外人怎么合法地把活交进来"，后者解决"活交给谁"。

---

## 5. 如果给 Legion 加"@agent"：分三层，别一次做三层

### L1 内部 @（已有，别动）
`mesh_send({to})` + `send_message` 唤醒。已经是"结构化 @ 的更好形态"，无需改。

### L2 看板 @（推荐先做，3–5 天）
在**任务评论**里支持 `@角色名`，语义分两种（这正是现在缺的）：

| 写法 | 语义 | 落点 |
| --- | --- | --- |
| `@coder 这里改成滑动窗口` | **追加/改需求**（不是退回） | 生成一条 `order` 输入投给该任务当前执行者；任务回 `todo` 续跑（保留原 mandate 范围，超范围则要求新任务） |
| `@general 这个口径要你定` | **升级给人/将军** | 生成 attention（见上一份报告 §1），任务进 `awaiting_answer` |

实现要点（照抄 superagent 的四条纪律）：
1. **只用名单做准入**：`@` 只把强度提到 explicit，**不能绕过** `claim-policy` 的 gate；发表者必须是空间成员（`members` 已有）。
2. **自 @ 不算**：评论者 = 任务当前认领者时，`@自己` 视为普通评论。
3. **编辑不追认**：只有**新增评论**能触发；编辑旧评论不产生新输入（`github.ts:353` 的同款理由）。
4. **确定性 ID 去重**：`inputId = hash(taskId, commentId, editedAt)`，同一评论不重复投递。

### L3 外部 @（暂不做，但要留缝）
真要在 GitHub/飞书里 @ 军团，前提是**军团得有一个对外身份**（一个 bot 账号 / 一个 GitHub App），以及一个"不需要公网入口"的拉取通道。superagent 的答案是：**轮询该账号的通知**。这条对 Legion 的启示不是"接 GitHub"，而是：
- 若将来接任意外部源，**优先选"可轮询的账号通知/收件箱"，而不是自建 webhook**（部署成本差一个数量级）；
- 外部事件一律先落 `LegionEvent`（上一份报告 §3.4），再由评估决定是否开工——**@ 只是让它有资格被评估**。

---

## 6. 四个可以直接抄的实现细节

| 细节 | 为什么值得抄 |
| --- | --- |
| **边界感知的 mention 正则** `(?:^\|[^a-zA-Z0-9_@])@name(?![a-zA-Z0-9_-])` | 直接把 `a@b.com`、`@name-x`、`@name2` 排除，避免"看起来 @ 了其实没有" |
| **`human` 与 `addressed` 分开两个字段** | `addressed` 决定"是不是明确请求"，`human` 决定"能不能授权"。合成一个布尔值就会把"bot @ 了我"误判成授权 |
| **事件 ID 含 version（updated_at）** | 编辑 = 新事件、重复读 = 同一事件，两个目标同时满足；Legion 的 audit 可以直接复用这个范式 |
| **回复地址随事件携带（channel）** | 回话永远回到"话被说出来的地方"，而不是新建线程；这是"@ 一下就走开"能成立的最后一环 |

---

## 7. 风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| @ 变成万能钥匙 | 一旦 `@` 能提级到 explicit，人会用它绕过批准 | 名单 + 空间成员 + 只提级不越 gate |
| 评论语义歧义 | "增补"与"驳回"都是人话 | 用前缀/结构化字段区分（`@coder+` vs `@coder`），或先只做"驳回"这一种并明确提示 |
| 自触发环 | 执行者 @ 自己或 @ 守护导致循环 | `human` 判定 + 执行者自身评论不触发 |
| 编辑追认 | 事后改评论骗过审计 | 只认新增评论；编辑只更新文本不入队 |
| 噪声 | 每条评论都进事件流 | 只有 @ 或结构化字段才造输入；其余仅入 audit |
