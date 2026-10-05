# BUG-004｜对话回复仍然失败的真因：**全部 14 条岗位模型绑定都指向一个已不存在的供应商**

> ✅ **已修复并活体验证（2026-10-05 01:40）**：登记 3 条 `fjd-ds` 档案 + 改 14 条绑定 + 补 2 条
> `assistant` 绑定（零错误），随后把失败的那条消息重试 → **40 秒后收到真实回复**
> （`aiModel=deepseek-v4-flash-openai`）。读数见 §7。
>
> 这是 BUG-002 的**下一条**（不是替代）。BUG-002 修的"守护看不见消息"已经**活体验证通过**——
> 修完之后守护 **10 秒内**就看见了消息并开始回答；它在**模型调用**这一步失败，
> 0 token 立即返回，而旧守护的分类器只能说「原因暂不可识别」。
> 本记录给出这一步的真因、证据链与修法。

## 1. 活体验读数（2026-10-05 01:29–01:30，生产中枢）

```text
会话 25（编码工程师）发前最后一条 id=165，共 1 条
已发送：HTTP 200，msg=172，aiStatus=awaiting
  +10s  源消息 aiStatus=failed
        aiError=AI 回复失败：原因暂不可识别。请点击「重试」；…
```

| 读数 | 值 | 含义 |
| --- | --- | --- |
| 队列 ⇒ 守护 | **10 秒内被看见**（此前整整一个月一条都没被处理） | **BUG-002 的队列修复活体验证通过** |
| 源消息终态 | `failed`（分类器文案「原因暂不可识别」） | 守护**答了**，但在模型调用处失败 |
| 子代理会话 `sessionStats` | `turns:1, steps:1, **llmMs:0**, decodeTokens:0` | 模型调用**根本没发生/立即失败** |
| 子代理会话 `tokenUsage.totals` | 全 `0` | 同上（不是"答得慢"，是没答） |
| 子代理会话 `modelSelection.lastUsed` | **`custom-ds` / `deepseek-v4-flash-openai`** | 它用的**不是**默认那个 `fjd-ds` |

## 2. 证据链（每一环都可复跑）

### 2.1 绑定表里所有 14 条都指向 `custom-ds`

```text
$ python docs/bugs/BUG-004-provider-check.py
agent_models 按 provider 统计： custom-ds  14        ← 只有这一个供应商，14 条全是它
software: requirement / researcher / breaker / test-designer / coder / tester / devops / general
          / soldier-a / soldier-b / soldier-auto     （11 条）
gf001:    planner / implementer / reviewer            （ 3 条）
每个空间的 assistant 行 = 0  ← 守护的解析链会兜底到"第一行"，而第一行也是 custom-ds
```

### 2.2 DSH 档案里**没有** `custom-ds`

`C:\Users\11150\.dsh\profiles\desktop\cordis.patch.yml` 的 `llm-pi-ai.providers` 只声明了
**`fjd-ds`**（baseURL `https://fjbigmodel.fjdac.cn/v1`，models 三个 `-openai` 型号）；
`cordis.yml` 与 patch 层里 `custom-ds` **一次都没出现**（`git`/`Select-String` 双查）。

> 而这个会话本身就跑在 `fjd-ds/deepseek-v4-flash-vision-openai` 上——**供应商是活的，
> 只是名字不再是 `custom-ds`**。绑定表停在了改名之前（旧日志 2026-09-08/09-10 的
> 成功回复写的正是 `provider=custom-ds`）。

### 2.3 中枢自己也修不了：模型档案表是空的

```text
$ python docs/bugs/BUG-004-registry-check.py
model_profiles 行数 = 0
agent_models   : ('custom-ds', 14)
```

`POST /api/models`（界面「⚡ 快速分配」保存走的就是它）第一件事是校验
（`runtime/contracts/model-config.mjs` 的 `validateAgentModelSelection`）：

| 档案表 | 判定 | 文案 |
| --- | --- | --- |
| `[]`（今天） | `NO_PROFILES` **拒绝** | 「还没有登记任何模型档案，因此无法把它指定给智能体。」 |
| 缺该供应商 | `UNKNOWN_PROVIDER` 拒绝 | 「没有已登记的供应商「X」。」 |

也就是说：**今天从界面改这个绑定会被拒**（`NO_PROFILES`），而"登记模型档案"那一页
（`POST /api/model-profiles`）没有任何一行——**登记表空着，绑定表指着一个不存在的供应商**。

### 2.4 健康端点给出的是**另一个答案**

```text
GET /api/chat/health?scope=software
  model: { provider: fjd-ds, model: deepseek-v4-flash-vision-openai, source: daemon-heartbeat }
  modelResolved: true
```

界面因此显示"模型已解析"（对），而**回复实际用的是绑定表里的 `custom-ds`**（死）。
同一个问题（"用哪个模型回答"）有两个数据源，且它们不一致——
这正是这个 Bug 能在"看起来一切正常"的状态下持续的原因。

## 3. 因果链（三层，第一层已修）

```text
① 队列取数窗口取的是最早 80 条 ⇒ 守护恒空转        【BUG-002，已修，活体验证 10s 内看见】
② 守护拿到消息后用的身份/上下文是旧的               【BUG-002 第二半，已修，待宿主重启】
③ 解析出的模型指向已不存在的 provider custom-ds    【BUG-004，本记录】← 现在卡在这一层
   └ 子代理 0 token 立即失败；旧分类器只能给"原因暂不可识别"
```

## 4. 修法（两步，都是写配置；**需要你确认**）

**第 1 步：把活着的供应商登记进中枢**（`POST /api/model-profiles`，逐型号一条）——
按 DSH 档案里真实存在的 `fjd-ds` 三个型号登记（`secretRef` 指向 `FJD_DS_API_KEY`，
与档案里 `apiKeyEnv` 一致）。**不登记这一步，第 2 步会被 `NO_PROFILES` 拒。**

**第 2 步：把 14 条绑定从 `custom-ds` 改到 `fjd-ds`**（`POST /api/models`，provider 改名、
model id 不变——`deepseek-v4-pro-openai` 与 `deepseek-v4-flash-openai` 在 `fjd-ds` 下**都存在**）：

| 现在 | 改成 |
| --- | --- |
| `custom-ds / deepseek-v4-flash-openai`（6 条） | `fjd-ds / deepseek-v4-flash-openai` |
| `custom-ds / deepseek-v4-pro-openai`（8 条） | `fjd-ds / deepseek-v4-pro-openai` |

**顺带建议（可选）**：给每个有对话的空间补一条 **`assistant`** 绑定
（如 `fjd-ds / deepseek-v4-flash-openai`）。现在 `assistant` 行为 0，守护的解析链
（`assistant` → `''` → 第一行）只能兜底到"第一行"，于是**答案取决于绑定表的插入顺序**——
那不是一个能解释的选择。

**为什么不能只改界面**：界面里"登记模型档案"与"快速分配"都要经过中枢校验，
而登记表空 + 供应商名不存在，两条路都过不去；同时「供应商与模型」页依赖
`DSH_MODELS_BASE_URL`（**BUG-001 的注入侧，要等宿主重启**）。所以今天最直接的路径是
用中枢 API 写这两步（我会带上审计与 SSE，与其他写操作一致）。

## 5. 判据

```bash
# ① 绑定与档案现状（只读）
python docs/bugs/BUG-004-provider-check.py
python docs/bugs/BUG-004-registry-check.py

# ② 改完之后：绑定里不该再有 custom-ds，且每空间有 assistant 行
# ③ 端到端：再跑一次活体验证，期望「回复出现」而不是 0-token 失败
node docs/bugs/BUG-002-live-verify.mjs --conv 25 --scope software --timeout 260
```

## 6. 边界

- 本记录最初**只做诊断**（未改配置）；§7 的两步写入是在你批准后执行的，全部走中枢 API
  （带审计与 SSE），写入前后都读回对比。
- 活体验证在 conv 25 留下两条**你已批准**的消息：id=172（验证提问，现已 `replied`）与
  id=179（AI 回复）；另有 id=176/178 是**真实任务汇报**（T-175/T-176 完成）——它们能出现在
  这条会话里，正是 BUG-003 修法 A 生效的证据（见 §7）。
- `custom-ds` 是否**曾经**在 DSH 档案里存在过，本记录只能证明"现在不存在"；
  旧守护日志（2026-09-08/09-10）显示当时回复成功且 `provider=custom-ds`——
  也就是说改名/迁移发生在 09-10 之后，而**绑定表没有被一起迁走**。
- **仍待一次 DSH 宿主重启**（与 BUG-001/BUG-002 同一次）：回复现在的作者是
  `software-assistant`（旧守护不知道岗位身份）；重启后才是 `agent:software:coder`
  并带上该岗位任务记录。这不影响"能回复"这个结论。

## 7. 修复与验证读数（2026-10-05 01:38–01:40）

**修法**（`docs/bugs/BUG-004-apply-fix.mjs`，先 `--dry-run` 复核再执行）：

| 步 | 动作 | 结果 |
| --- | --- | --- |
| ① | 登记 3 条 `fjd-ds` 档案（`fjd-ds-deepseek-v4-{pro,flash,flash-vision}-openai`，endpoint 与型号**逐项对齐** DSH 档案，`secretRef=FJD_DS_API_KEY`） | 创建 3 条，0 错误 |
| ② | 14 条绑定 `custom-ds` → `fjd-ds`（model id 不变） | 改 14 条，0 错误 |
| ③ | `software` / `gf001` 各补一条 `assistant` 绑定（`fjd-ds/deepseek-v4-flash-openai`） | 写 2 条，0 错误 |

读回：模型档案 **3** 条；岗位绑定 **16** 条；仍指向 `custom-ds` 的 **0** 条。

**端到端**（不发新消息，把那条失败的重试）：

```bash
node docs/bugs/BUG-002-live-verify.mjs --conv 25 --scope software --retry 172 --timeout 260
```

```text
重试 msg 172：HTTP 200 → aiStatus=awaiting
  +10s awaiting  +20s awaiting  +30s awaiting
  +40s replied  新回复=1
结果：40s 后收到回复 —— author=software-assistant
```

**会话 25 的完整读回**——一次同时证明三个修复：

| msg | author | 说明 | 证明了什么 |
| --- | --- | --- | --- |
| 165 | general | 你最初的「什么进展了」（`failed`，现在可以点重试） | — |
| **172** | general | 我的验证提问 → **`replied`** | BUG-002 队列 + BUG-004 模型都好了 |
| **176 / 178** | `agent:software:coder` | `T-175 / T-176 任务状态：已完成。` | **BUG-003 修法 A 生效**：汇报真的落进了用户打开的这条会话（多播 + 标题后缀都是活的） |
| **179** | `software-assistant` | AI 回复正文，`aiModel=deepseek-v4-flash-openai` | 模型调用真的发生了（不再是 0 token）；作者仍是旧守护身份 ⇒ 待宿主重启 |

