# 模型运行期调度（Model Runtime）设计

> 状态：**设计稿 v0.2**（§12.2 三个问题已于 2026-10-30 裁定，可进入 P0 拆解）
> 关联：[README.md](../README.md)（总览）· [ORCHESTRATION-V3.md](ORCHESTRATION-V3.md)（编排分层）· [DECISION-legion-owns-model-config.md](DECISION-legion-owns-model-config.md)（模型配置归属）· [FEATURES.md](FEATURES.md)（模型 × 智能体配置）
> 一句话：**Legion 已经有"能不能换模型"的策略（`canSwitchModel`）和"花多少钱"的账本（`budget-ledger`），缺的是一层在运行期真正消费候选链、记录每次切换理由的调度器；本设计把这层补上，形态参考 magpie，边界按 Legion 自己的纪律收紧。**

---

## 0. 决策摘要（TL;DR）

1. **调度粒度是 attempt，不是 task。** attempt 已有幂等键、租约、预算预留和 `unknown` 语义，是天然的重试点；任务级重试会把一次 429 变成一次 30 分钟的重跑。
2. **候选来源就是现有的 `chain`**（primary + fallbackProfiles），不新增"模型池"概念；账号/Key 池留到 P2 作为可选扩展。
3. **切换必须过价格守卫。** 复用 [`canSwitchModel`](../runtime/contracts/price-table.mjs)：更便宜或同价放行，更贵需批准（任务上一次性的显式标记，或将军在调度台操作），任一侧未定价一律拒绝。
4. **只有"第一个副作用之前"允许切换。** 一旦工具调用成功返回，失败一律走 `unknown`，不重试、不换模型。
5. **配置错误不等于运行故障。** `PRIMARY_UNRESOLVED` 继续硬失败，不允许 fallback 顶替（沿用 [run-inputs.mjs](../orchestrator/worker/run-inputs.mjs) 的现有纪律）。
6. **Rest 落库、跨 worker 共享。** 限流到几点、配额何时重置要能被另一台宿主看见，不能只存在进程内存里。
7. **默认影子模式。** 先只记录"本来会怎么切"，不改变执行行为；观察一周再开 `enforce`。
8. **不做协议网关、不做订阅接入、不做静默升价。** magpie 的传输层能力不在本设计范围内，见 §2。
9. **网关是可选的第四种来源。** `runtime_type=gateway` 让订阅/中转模型以 native 方式进入候选链；不部署网关时它不存在，不影响现有 `dsh` 路径。

---

## 1. 背景与现状

### 1.1 现在已经有什么

| 模块 | 位置 | 现在负责 | 与本设计的关系 |
| --- | --- | --- | --- |
| 模型绑定解析 | [orchestrator/model-binding/index.mjs](../orchestrator/model-binding/index.mjs) | 纯函数：`(scope, role) → chain`（primary + fallbacks，去重、跳过已下线） | 输入的候选来源，不改它的判定 |
| 运行期取模型 | [orchestrator/worker/run-inputs.mjs](../orchestrator/worker/run-inputs.mjs) | 只取 `chain[0]`，且要求 `role === 'primary'`；`ok:false` 时硬失败 | 要改成"取整条链"，但保留硬失败规则 |
| 换模型授权 | [runtime/contracts/price-table.mjs](../runtime/contracts/price-table.mjs) | `canSwitchModel`：更贵需 `approved`；未定价拒绝 | 直接复用，不重写判据 |
| 预算账本 | [team-hub/budget-ledger.mjs](../team-hub/budget-ledger.mjs) | 预留 → 结算 / `locked`；冻结价目表版本 | 切换候选时要决定"按谁预留"（§6.4） |
| 阶段 Attempt | `agent_workflow_stage_attempts` | `running / completed / unknown`，带 `provider_run_id` | 决策记录挂在 attempt 上 |
| 执行入口 | [plugins/src/index.ts](../plugins/src/index.ts)（约 L2571–L2700） | 选 provider → 开 attempt → 跑 subagent → 回报 | 本设计的唯一运行时插入点 |
| 租约与超时 | `workerTimeoutMs` / `staleMinutes` | 25 分钟中止；40 分钟无进展回收 | 与切换互为影响，§6.6 |

### 1.2 三个缺口

1. **链解析出来了，但没人消费。** `resolveModelChain` 返回 `chain`、`perRunBudget`，`run-inputs` 只用第一位；fallback 在运行期从未被尝试。结果是：一个 429 或一次 provider 启动失败，直接把任务打到 `RetryableFailure`，烧一次重试额度、再排一次队、再冷启动一次。
2. **没有"休息"概念。** 失败之后只有任务级退避（指数猜），没有"这个账号要等到 14:20""这个 key 本周配额已尽"的运行期状态；同一轮里其他候选的健康度完全不可见。
3. **没有决策记录。** 换过模型、为什么换、换到哪、贵了多少，事后只有一行"已切换到备用模型"。这与 [model-binding/index.mjs](../orchestrator/model-binding/index.mjs) 开头写的"换模型同时改变成本、质量、数据去了哪，三件都不可见时一次用错模型的运行事后没有痕迹"直接冲突。

### 1.3 为什么现在做（实测，2026-10-29）

| 引擎 | 样本 | 平均耗时 | 区间 |
| --- | --- | --- | --- |
| `claude-code` | 4 | 27.8 min | 23.2 – 35.5 |
| `spawn` | 4 | 36.3 min | 29.0 – 46.9 |
| `codex` | 4 | 7.1 min | 1.0 – 15.2 |

- 一次阶段跑 25–47 分钟，意味着**任何一次中途失败的时间成本都是半小时级**；在 attempt 内换一个候选，最坏只是多花几分钟，而不是重排整条链。
- 同期有 8 次 attempt 落在 `unknown`，其中 claude-code 的报错是"Agent 启动结果未知或启动请求失败"——**启动阶段就会失败**，而这类失败恰恰是最该原地换候选的。
- `staleMinutes=40` 与 `spawn` 实测 46.9 分钟上限冲突（§6.6），说明"长跑"已经是常态，调度层必须按长跑设计。

---

## 2. 从 magpie 借什么、不借什么

magpie 的价值不在"它也做路由"，而在于它把**运行期消费候选链**这件事拆成了可复用的形态：候选集、休息状态、逐次尝试的 trace、会话粘性。

| magpie 的做法 | 来源 | 借 / 不借 | 理由 |
| --- | --- | --- | --- |
| 候选集 + 逐次尝试 + 每次记 `try`（状态码/耗时/原因） | [gateway/routing.go](https://github.com/yetone/magpie/blob/main/internal/gateway/routing.go) | **借** | 正是 Legion 缺的运行期形态 |
| Rest：限流读到 `retry-after`、配额读到窗口重置、其余指数 | 同上 | **借** | 比"指数猜"精确，直接缩短无谓等待 |
| 会话/账号粘性（缓存值钱时不换） | [claude_subscription.go](https://github.com/yetone/magpie/blob/main/internal/gateway/claude_subscription.go) | **借（软约束）** | Legion 的 worktree 生命周期不支持常驻进程，只能做"同 repo+role 优先同 profile" |
| 路由组（smart/order/pace…） | [gateway-routing.md](https://github.com/yetone/magpie/blob/main/docs/subsystems/gateway-routing.md) | **部分借** | 只借"有序链 + 健康过滤"，不借按配额重置排序（Legion 没有账号池） |
| 协议互转（OpenAI/Anthropic/Gemini） | `internal/gateway/ir.go` | **不借** | Legion 的 provider 是 dsh 原生 adapter，加一层网关只会多一个故障点 |
| 多账号/多 Key 池、warm-up | `internal/provider/*` | **不借（P2 再议）** | 涉及凭据分发与配额窗口，先把单 Key 的链跑通 |
| 订阅账号桥接 | `internal/gateway/claude_subscription.go` | **不借** | 供应商条款风险；Legion 只用用户自有 key |
| 静默 failover（agent 永不看到错误） | README | **不借** | 与"不得未批准升价"冲突；Legion 要"可解释地停下"，不是"假装成功" |
| 无鉴权 loopback 网关 | `gateway.go`（`Token = "magpie"`，accepts anything） | **不借** | Legion 已有写令牌与作用域，保持 |

---

## 3. 分层与生命周期

### 3.1 分层

```
plugins/src/index.ts（执行入口：开 attempt、调 provider）
        │  只问一句："这次 attempt 用哪个候选、失败后能不能换"
        ▼
orchestrator/model-runtime/（新增，纯判定 + 有副作用的胶水分离）
   ├─ classify.mjs   失败分类（纯函数：provider 错误 → FailureClass）
   ├─ admit.mjs      候选过滤（纯函数：chain + rest + 预算 + 价格守卫 → 可试候选）
   ├─ index.mjs      循环：试 → 分类 → 记 Rest → 下一个（依赖全部注入）
   └─ store.mjs      hub 读写（rest / decision），可替换为内存实现供测试
        │
        ▼
team-hub：model_rest / model_decisions 两张表 + 两个读接口
```

**判定与 IO 分离**：`classify`、`admit` 是纯函数，单测不需要起 hub；`index.mjs` 只做编排，所有依赖（`runProvider`、`now`、`record`、`rest`）注入，便于用假 provider 验证"第 2 个候选被试过"。

### 3.2 一次 attempt 的状态迁移

```
resolved ──admit──▶ admitted ──pick c1──▶ running(c1)
                                          │
              ┌───────────────────────────┼──────────────────────────┐
              ▼                           ▼                          ▼
        success(结算)              retryable(记 rest)          hard/config/aborted
              │                           │                          │
              ▼                           ▼                          ▼
           settled                 running(c2) …            settled / unknown
                                          │
                                     candidates 空
                                          ▼
                                   waiting(until = min(rest.until))
```

`waiting` 不是新任务状态，而是 attempt 的终态之一：任务回 `todo`，`next_attempt_at_ms` 取最近一个 Rest 到期时间（复用现有队列闸门，不新增状态机状态）。

---

## 4. 领域模型

### 4.1 Candidate（两种形态）

候选不总是"Legion 能改配置的模型档案"。按引擎分两类，切换方式完全不同：

| 类型 | 形态 | 模型由谁决定 | 能否在同一 attempt 内换模型 |
| --- | --- | --- | --- |
| native | `{ kind: 'native', provider, modelRef }` | Legion（物化进 dsh 配置） | 能：换一次 provider 调用即可，秒级 |
| external | `{ kind: 'external', engine, modelArg }` | CLI 自己（启动参数/环境变量） | 不能：进程内的模型不可变，只能结束进程后重开 |

公共字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `kind` | `native` \| `external` | 决定走 §5 的哪条路径 |
| `engine` | `spawn` \| `codex` \| `claude-code` | external 必填；native 由 adapter 决定 |
| `modelRef` | string \| null | native：`model_profiles.id` |
| `modelArg` | string \| null | external：传给 CLI 的模型参数（`--model` / `-m`） |
| `role` | `primary` \| `fallback` | 来自 `resolveModelChain`，原样保留 |
| `order` | number | 链上位置 |
| `costClass` | `known` \| `subscription` \| `unknown` | external 常用；价格守卫按此比较（§5.5） |
| `priceTier` | number \| null | `known` 时由价目表估算；其余为 `null` |
| `restUntil` | number \| null | 来自 `model_rest` |
| `eligible` | boolean | 过滤结果 |
| `skipReason` | string \| null | 具名原因，进决策记录 |

#### 4.1.1 候选来源矩阵

`kind` 不由调用方自由指定，而是**由 `model_profile.runtime_type` 推导**——否则一段代码可以把 external 候选当 native 热切，绕过"进程内模型不可变"的事实。

| `runtime_type` | 候选 `kind` | 模型由谁决定 | 切换语义 | 价格口径 | 合规 |
| --- | --- | --- | --- | --- | --- |
| `dsh` | native | Legion（物化进 llm-pi-ai） | attempt 内，秒级 | `known`（价目表） | 低 |
| `gateway` | native | 网关（Legion 只选模型名） | attempt 内，秒级 | `known` 或 `unknown` | 取决于网关上游 |
| `claude-cli` | external | CLI（启动参数） | attempt 级重开，分钟级 | `subscription` / `unknown` | 低（就是 Claude Code） |
| `codex-cli` | external | CLI（启动参数） | attempt 级重开，分钟级 | `subscription` / `unknown` | 低（就是 Codex） |

两条推导规则：

1. `runtime_type` 缺失时默认 `dsh`；**拼错则拒绝**，不回落（一次拼错会静默把网关候选当成直连候选）。
2. `gateway` 归 native：对 Legion 来说它只是"另一个 base URL"，进程内可换；真正的不可换发生在网关之后，由网关自己的错误码体现。

### 4.2 Rest

| 字段 | 说明 |
| --- | --- |
| `scope` + `profile_id` | 主键；同一 profile 在不同空间可独立休息 |
| `reason` | `rate-limited` / `quota-exhausted` / `auth-failed` / `connect-failed` / `server-error` / `start-failed` |
| `until_ms` | 到期时间；来自上游 `retry-after`、配额重置，或本地指数 |
| `source` | `upstream`（上游给的）或 `local`（推算的），用于事后判断可信度 |

**Auth 失败特殊处理**：`auth-failed` 的 Rest 不自动过期，只能由一次成功探测或人工清理解除；否则会把"key 失效"变成"每 60 秒重试一次"。

### 4.3 ModelDecision（append-only）

| 字段 | 说明 |
| --- | --- |
| `id` / `attempt_id` / `seq` | 一次 attempt 内自增 |
| `chosen_profile` | 实际使用的候选 |
| `reason_code` | `PRIMARY` / `FAILOVER_NOT_MORE_EXPENSIVE` / `FAILOVER_APPROVED` / `ALL_RESTED` / `SKIPPED_*` |
| `candidates_json` | 当时的候选快照（含 `skipReason`），用于事后复盘 |
| `estimated_cost` + `currency` | 冻结价目表版本的估算；未定价为 `null` |
| `cache_hint` | `warm`（同 repo+role 近期用过同 profile）/ `cold`，只做记录，不做承诺 |
| `at_ms` | 记录时间 |

**不含 prompt、不含响应正文、不含密钥**。决策记录只回答"为什么是它"，不回答"说了什么"。

### 4.4 FailureClass

| class | 典型信号 | 可切换 | 记 Rest | 退避来源 |
| --- | --- | --- | --- | --- |
| `connect` | DNS/TLS/连接重置 | 是 | 60s | 本地 |
| `rate-limited` | 429 | 是 | `retry-after` | 上游 |
| `quota-exhausted` | 余额/配额耗尽 | 是 | 重置时间 | 上游 |
| `auth` | 401/403 | 是（换 key 才有意义） | 长休 | 人工 |
| `server` | 5xx / overloaded | 是 | 60s→10m 指数 | 本地 |
| `start-failed` | "Agent 启动结果未知或启动请求失败" | 是（一次） | 30s | 本地 |
| `context-overflow` | 超窗口 | 是（换更大窗口） | 无 | — |
| `aborted` | 用户取消/看门狗 | 否 | 无 | — |
| `config` | `PRIMARY_UNRESOLVED` 等 | 否 | 无 | — |
| `side-effect-started` | 工具已产生外部写入 | 否 | 无 | — |

### 4.5 model_profile 的 runtime_type 扩展

现表已有 `runtime_type` 列（当前 15 条全是 `dsh`），扩展为四态即可，不新增概念：

| `runtime_type` | 必填字段 | 可选字段 | 说明 |
| --- | --- | --- | --- |
| `dsh` | `provider`, `model`, `secret_ref` | `reasoning_effort`, `limits_json` | 现有行为，不动 |
| `gateway` | `base_url`, `protocol`, `models[]` | `secret_ref`, `health`, `limits_json` | 订阅/中转模型统一入口 |
| `claude-cli` | `engine`（固定 `claude-code`） | `model_arg`, `permission_profile` | 不填 `model_arg` 就用 CLI 当前配置 |
| `codex-cli` | `engine`（固定 `codex`） | `model_arg`, `permission_profile` | 同上 |

`protocol` 的取值以宿主能力为准：当前 DSH 只见到 `openai-completions` / `openai-responses`；若宿主支持 `anthropic`，网关可以少一层转换，否则网关需自行对外提供 OpenAI 兼容面。

**为什么用现有列而不是新表**：模型绑定（`agent_models` / `employee_model_bindings`）已经按 `profile id` 引用；把来源塞进同一张表，绑定、价目表、预算都不用改，只改"怎么把 profile 变成一次调用"。

---

## 5. 运行期算法

### 5.1 主循环（伪代码）

```
async function runAttempt(ctx):
  res = resolveChain(scope, role)              // 现有纯函数
  if (!res.ok) return fail('config', res.code) // 硬失败，不换

  cands = admit({ chain: res.chain, scope, budget: res.perRunBudget, now })
  if (cands.eligible.length === 0)
    return waitUntil(minRest(cands))           // 明确"等 T 或人工"

  for c of cands.eligible:
    if (c.role === 'fallback'):
      verdict = canSwitchModel({ from: primary, to: c.profileId, ... })
      if (!verdict.allowed) { recordSkip(c, verdict.code); continue }
    recordDecision(c)
    r = await runProvider(c, { guard: firstSideEffect })
    switch (classify(r)):
      case 'success':      return settled(c)
      case 'config':       return fail(c)            // 任何候选都不换
      case 'aborted':      return cancelled(c)
      case 'side-effect':  return unknown(c)         // 已有副作用，禁止重试
      case 'wait':         rest(c, r.retryAfter); continue
      default:             rest(c, backoff(c)); continue

  return fail('all-candidates-rested')       // 带每个候选的原因
```

### 5.2 四条守卫（缺一不可）

1. **价格守卫**：`canSwitchModel` 返回 `false` 就不切；`PRICE_UNKNOWN` 也拒绝——这是刻意的，补价目表比放行便宜。
2. **副作用守卫**：`firstSideEffect()` 一旦触发，后续所有失败都归 `unknown`，与 [plugins/src/index.ts](../plugins/src/index.ts) 里"确认外部执行未产生副作用前不会自动重试"的现有纪律一致。
3. **配置守卫**：`PRIMARY_UNRESOLVED` 不进候选循环；fallback 只为"运行时连不上"存在，不为"配置写错了"兜底。
4. **同 provider 守卫（P1）**：`to.provider !== from.provider` 默认拒绝，记 `CROSS_PROVIDER_BLOCKED`；只有空间级 `allowCrossProvider`（P3，默认关）打开才放行。跨 provider 改变的不只是成本，还有"数据去了哪"。

### 5.3 退避取值顺序

```
上游 retry-after（秒/HTTP-date）
  > 配额重置时间（usage 接口）
  > 本地指数：base 60s × 2^n，上限 10min，带 ±20% 抖动
```

同一 profile 连续失败 3 次后进入"慢探测"：每 10 分钟最多试一次，避免把限流打成封禁。

### 5.4 缓存亲和（软约束）

```
affinityKey = repoId + '|' + role
```

- 同 key 最近 30 分钟成功用过的 profile，排到同价候选的最前；**不跨价格档**，不覆盖 Rest，不覆盖健康过滤。
- 只记录 `cache_hint`，不承诺命中——Legion 没有 magpie 那种常驻会话，能复用的只有供应商侧前缀缓存。
- 为什么不做常驻会话：worktree 在任务结束后回收，进程常驻会与写入租约、清理策略冲突；这是与 magpie 最大的形态差异，必须显式写下来。

### 5.5 外部 CLI 引擎（claude / codex）怎么"切模型"

**核心事实：外部 CLI 的模型跑在它自己的进程里，Legion 改不了运行中的那个模型。** 因此对 external 候选，"切模型"不是热切换，而是**结束当前进程、用另一个 `modelArg` 或另一个引擎重开一个 attempt**。

| 路径 | 粒度 | 耗时 | 前提 |
| --- | --- | --- | --- |
| native 换候选 | 同一 attempt 内 | 秒级 | 通过价格守卫 |
| external 换引擎/模型 | attempt 级重启 | 分钟级 | 证明"尚未产生副作用" |

**判定流程**：

```
before = snapshot(worktree)        // HEAD + git status --porcelain
run external(engine, modelArg)
失败时：
  ├─ 启动失败 / 401 / 模型不存在 / 429（尚未出现首个 tool_use）
  │     ├─ worktreeDiff(before) 为空 ──▶ rest(当前) → 换下一个 external 候选重开
  │     └─ 有改动 ────────────────────▶ unknown（保留 worktree，人工核对）
  └─ 已出现 tool_use 或进程中途崩溃 ───▶ unknown（不重开、不换）
```

"worktree 没变"是 external 路径唯一可靠的副作用证据：外部 CLI 不保证吐结构化事件，但**它写过什么，git 一定看得见**。

**模型注入方式**：

| 引擎 | 指定模型 | 备注 |
| --- | --- | --- |
| `claude-code` | `claude --model <id>` 或环境变量 `ANTHROPIC_MODEL` | 若走本地代理（如 cc-switch），`<id>` 必须是代理认得的名字 |
| `codex` | `codex -m <id>`（或 `-c model=<id>`） | 以本机版本 `--help` 为准 |
| `spawn` | 不需要参数，Legion 物化 `model_profile` | native 路径 |

**价格守卫的适配**：external 常常拿不到准确单价（订阅、包月、代理），所以 `canSwitchModel` 需要 `costClass`：

| 组合 | 判定 |
| --- | --- |
| `known` vs `known` | 走 `canSwitchModel` 原判据 |
| `subscription` vs `subscription` | 视为同价，允许 |
| 任一侧 `unknown` | 拒绝，除非 `approved` |

**交接包**：重开进程不能让新模型从零开始，否则等于把 30 分钟白跑。重开时注入：

```
attempt-retry.json
  ├─ 已完成步骤（从 evidence / checkpoint 提取）
  ├─ 已改文件清单（git status + diff --stat）
  ├─ 当前阻塞点与最后一个错误
  └─ 验收标准摘要（来自任务的 acceptance）
```

worktree 不变、分支不变，只换引擎与 `modelArg`；新进程的首条消息就是这个交接包。

---

## 6. 与现有模块的接线

### 6.1 run-inputs：从"取链首"到"取整条链"

`resolveModelProfileRef` 现在返回单个 `modelProfileRef`。改动：

| 现在 | 改成 |
| --- | --- |
| 返回 `modelProfileRef: chain[0].id` | 返回 `chain: [{id, role}]` + `primaryProfileRef`（兼容旧调用方） |
| `ok:false` 时 `refuse` | 不变（继续硬失败） |
| 调用方只用第一位 | 调用方把整条链交给 `model-runtime` |

**兼容策略**：保留 `modelProfileRef` 字段一个版本周期，新代码读 `chain`；旧测试不动。

### 6.2 执行入口：一个循环替换一次调用

`plugins/src/index.ts` 的 `beginWorkflowStageAttempt` 与随后的 provider 调用之间插入 `modelRuntime.run({...})`。要求：

- `runProvider` 以回调注入，插件不直接依赖 `orchestrator/model-runtime` 的内部实现；
- 每次切换前先 `activity('model:switch', ...)`，保证 SSE 上能看到；
- attempt 记录里的 `provider_run_id` 每次切换都更新，后处理以最后一次为准。

### 6.3 hub 接口（只读为主）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/model-runtime/rest?scope=` | 当前 Rest 列表（看板/诊断用） |
| `POST` | `/api/model-runtime/rest/clear` | 人工解除（需 `by` + 审计） |
| `GET` | `/api/model-runtime/decisions?taskId=` | 任务详情"模型决策"时间线 |

写路径只有一条：内部 `rest(profile, until, reason)`，不开放任意写，防止把 Rest 当成调度开关。

### 6.4 预算：按 primary 预留，切换时补差

- 预留仍按 attempt 的 primary 上限（不变，避免一开跑就占两份）。
- 切换到更便宜候选：不动预留。
- 切换到同价候选：不动预留。
- 切换到更贵候选：**本来就不允许**（除非 `approved`）；批准时先 `reserve` 差额，失败则放弃切换。
- 结算时用实际使用的候选与冻结价目表，不重算历史。

### 6.5 审计

| action | 时机 | 必带字段 |
| --- | --- | --- |
| `model:decision` | 每次选定候选 | `attemptId, profileId, reasonCode, candidates` |
| `model:switch` | 真正切换 | `from, to, failureClass, costDelta` |
| `model:rest` | 记 Rest | `profileId, reason, until, source` |
| `model:exhausted` | 全候选不可用 | `retryAt, reasons[]` |

### 6.6 与租约/超时的联动（必须先修）

现状：`workerTimeoutMs=25min` 低于 claude-code 均值 27.8min；`staleMinutes=40min` 低于 spawn 上限 46.9min。这两条线任一触发，都会把"正在跑的 attempt"变成"可被另一个 worker 认领的任务"。

本设计要求：

1. 长阶段期间每 5–10 分钟写一次 progress（20/40/60/80），让租约按"有进展"续期；
2. `staleMinutes` 提到 ≥ 75，`workerTimeoutMs` 提到 ≥ 60，或按 provider 分档；
3. 切换本身不重置 attempt 的开始时间（否则 25 分钟的超时会被无限续命）。

### 6.7 网关 profile：最小字段与健康检查

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 唯一；建议 `gw-<host>-<name>` |
| `base_url` | 是 | 只接受 `http://127.0.0.1:*` 或 `https://`；写库前校验 scheme 与 host |
| `protocol` | 是 | `openai-completions` / `openai-responses`（`anthropic` 视宿主支持） |
| `secret_ref` | 否 | 网关自己的 key，与上游 key 分离；不落明文 |
| `models[]` | 是 | 网关声明的模型名；**空数组等于不可用**，不是"全部" |
| `health` | 否 | `{ path, intervalSeconds, timeoutMs, failuresBeforeRest }`，默认 `/v1/models` / 60s / 5s / 3 |
| `limits_json` | 否 | 可选并发与超时上限；不承担计费 |

**健康检查语义**：

1. 启动时探测一次：`2xx` 且模型列表非空 → healthy；否则该 profile 直接标不可用。
2. 周期探测（默认 60s）；连续 `failuresBeforeRest` 次失败 → `rest(profile, 60s→10m 指数)`。
3. 任意一次成功 → **立刻解除 Rest**（网关恢复是客观事实，不需要人工，这与 `auth` 不同）。
4. 探测只打 `models` 端点，**不发 prompt、不消耗额度**。

| 现象 | class | Rest |
| --- | --- | --- |
| 连接拒绝 / 超时 | `connect` | 60s 起，指数到 10min |
| 401 / 403 | `auth` | 不自动过期，等人换 key |
| 5xx | `server` | 指数 |
| 2xx 但模型列表为空 | `config` | 不 Rest；判该 profile 不可用并告警 |

**安全边界**：

- 网关是新增出网点：默认只允许回环；远程网关必须显式配置并落审计。
- 日志只记 host，不记完整 URL 与 key。
- Legion 不落盘 prompt；网关侧是否记录由网关自己负责，接入时确认。

### 6.8 升价批准：一次性、可审计

不新造开关表，用现有的 `tasks` 加两列 + 审计：

| 位置 | 字段 | 语义 |
| --- | --- | --- |
| `tasks` | `allow_price_increase` | 0/1；将军在调度台或任务详情打开 |
| `tasks` | `price_increase_consumed_at` | 非空 = 已消费；写入时把上一列清零 |
| `audit` | `model:approve-price-increase` | 记录操作者、开关动作、任务与时刻 |

**消费时机（顺序不可乱）**：

1. 价格守卫返回 `MORE_EXPENSIVE_NEEDS_APPROVAL`，且 `allow_price_increase = 1`；
2. 先 `reserve` 差额；**预留失败 → 不消费、不切换**（标记保持可用，稍后可重试）；
3. 预留成功 → 置 `price_increase_consumed_at`、清零 `allow_price_increase`、发起调用；
4. 调用在首副作用前失败 → 标记**不自动恢复**（失败后要重新点一次）：一次点击不能变成多次花钱。

**调度台操作**：任务行 ⋯ 菜单 → "允许升价一次"，与 `hold` 同级，但只影响模型切换、不影响任务流转。接口 `POST /api/task/price-increase { id, on, by }`，写审计并推 SSE。

**边界**：同一次 attempt 里连续切两次更贵候选，第二次仍需要新标记（一次标记只覆盖一次执行）。

---

## 7. 可观测性

| 指标 | 定义 | 用途 |
| --- | --- | --- |
| `switch_rate` | 发生切换的 attempt / 总 attempt | 判断候选质量 |
| `rest_hit_rate` | 首个候选处于 Rest 的比例 | 判断是否该扩候选 |
| `time_to_first_token` | 按候选/引擎分桶 | 解释"为什么慢" |
| `cost_per_accepted_task` | 目标内已验收任务的平均费用 | 与业务价值对齐 |
| `cache_hint_hit` | `warm` 标记中实际出现缓存读取的比例 | 验证亲和是否值得保留 |
| `exhausted_wait` | `model:exhausted` 的等待时长分布 | 决定是否要扩候选 |

任务详情新增一条"模型决策"时间线：候选列表（含跳过原因）→ 选中的 → 结果 → 若切换，显示贵了多少。

Rest 的到期时间只在任务详情与 `/api/model-runtime/rest` 出现；**任务卡不新增字段**（§12.2 裁定 3）。

---

## 8. 配置

```yaml
modelRuntime:
  enabled: false              # 默认关；先 shadow
  mode: shadow                # shadow | enforce
  maxSwitchesPerAttempt: 2
  allowPricier: false         # 只由 canSwitchModel 的 approved 覆盖
  restDefaults:
    connect: 60s
    serverBase: 60s
    serverMax: 10m
    startFailed: 30s
    auth: manual              # 不自动过期
  affinity:
    enabled: true
    windowMinutes: 30
  probe:
    afterFailures: 3
    interval: 10m
```

- 进 `configSchema`（zod），未知字段拒绝——拼错的 `maxSwitch` 被忽略等于没有上限。
- `shadow` 模式下仍然写 Rest 与决策记录，但**不改变执行**；用一周数据校准默认值后再开 `enforce`。

---

## 9. 安全与合规

1. **不引入外部网关**：provider 仍是 dsh adapter，密钥仍走 DPAPI 凭据库；本设计不新增任何出网路径。
2. **决策记录不含敏感内容**：只存 profile id、原因码、金额；`candidates_json` 里不得出现 `secret_ref`。
3. **不自动升价**：唯一入口是 `canSwitchModel` 的 `approved`（§6.8 的一次性标记），且批准必须留下操作者。
4. **只用用户自有 key**：不做订阅账号桥接，不读取其它 CLI 的登录态。
5. **Rest 的写权限收敛**：只允许运行期内部写；人工清除走带审计的接口。

---

## 10. 分阶段落地

| 阶段 | 范围 | 改动面 | 验收 | 回滚 |
| --- | --- | --- | --- | --- |
| P0 记录 | Rest 表 + 决策记录 + 分类器；不切换 | 新模块 + hub 两张表 + 审计 | 影子模式跑一周，决策记录与实际选择一致 | 删表 + 关开关 |
| P1 切换 | native：首副作用前 failover + 价格守卫（仅同 provider）；external：attempt 级重开（§5.5） | `run-inputs`、执行入口、worktree diff 探针、任务两列 | 注入 429/连接失败，验证第 2 个候选被使用且未升价；external 仅在 worktree 无改动时重开；跨 provider 被拒 | 开关回 shadow |
| P2 健康 | 上游 `retry-after`/重置时间接入；启动失败重试一次；`gateway` profile 与周期健康检查 | classify + probe + profile 路由 | 限流等待接近上游值；网关断开后 60s 内被标 Rest 并切走 | 退回本地指数、关闭 gateway |
| P3 亲和与账 | 缓存亲和 + 成本 KPI + OTLP 导出；跨 provider 开关（默认关） | 调度器 + usage + settings | `cost_per_accepted_task` 可读且可复算；开关关闭时跨 provider 仍被拒 | 关亲和、关开关 |

每阶段独立可验收；P0 不改任何执行行为，风险最低，建议先做。

---

## 11. 验收标准

| 编号 | 场景 | 判据 | 证据 |
| --- | --- | --- | --- |
| AC-01 | 主候选 429，备用同价 | 切到备用并完成；决策记录 `FAILOVER_NOT_MORE_EXPENSIVE` | 假 provider 单测 + 审计 |
| AC-02 | 主候选 429，备用更贵 | **不切**；返回 `MORE_EXPENSIVE_NEEDS_APPROVAL` | 单测 |
| AC-03 | 备用未定价 | **不切**；返回 `PRICE_UNKNOWN` | 单测 |
| AC-04 | 主档案配置错误 | 硬失败，不消费 fallback | 复用现有 `PRIMARY_UNRESOLVED` 用例 |
| AC-05 | 工具已产生写入后失败 | `unknown`，不重试、不切换 | 执行入口集成用例 |
| AC-06 | 全候选 Rest | 任务回 `todo`，`next_attempt_at_ms` = 最早到期 | hub 用例 |
| AC-07 | 上游给 `retry-after: 120` | Rest 到期 ≈ now+120s，而非指数值 | 单测 |
| AC-08 | 认证失败 | Rest 不自动过期；需人工清除 | 单测 |
| AC-09 | 切换 3 次 | 第 3 次被 `maxSwitchesPerAttempt` 拒绝 | 单测 |
| AC-10 | 影子模式 | 决策记录写入，但 provider 调用次数不变 | 集成用例 |
| AC-11 | external 启动失败（模型不存在/401），worktree 无改动 | 换 `modelArg` 重开；决策记录 `FAILOVER_EXTERNAL_RESTART` | 集成用例 |
| AC-12 | external 已写文件后崩溃 | `unknown`；保留 worktree；不重开 | 集成用例 |
| AC-13 | external 两个候选都是 `subscription` | 允许切换（同档），不触发升价 | 单测 |
| AC-14 | `runtime_type` 拼错 | 配置被拒绝，不回落 `dsh` | 单测 |
| AC-15 | 网关 401 | `auth` Rest，不自动过期 | 单测 |
| AC-16 | 网关连续 3 次 5xx | Rest 指数增长；候选链切到下一个 | 集成用例 |
| AC-17 | 网关模型列表为空 | 判该 profile 不可用并告警，不退化为"全部模型" | 单测 |
| AC-18 | 任务标记=1，切到更贵候选 | 先预留差额再调用；`price_increase_consumed_at` 写入、标记清零 | 集成用例 |
| AC-19 | 未标记者切更贵 | 拒绝 `MORE_EXPENSIVE_NEEDS_APPROVAL`，标记不被消费 | 单测 |
| AC-20 | 跨 provider 候选（默认） | 拒绝并记 `CROSS_PROVIDER_BLOCKED` | 单测 |
| AC-21 | 任务卡 | 不出现 Rest 字段；Rest 只在详情与接口 | UI 断言 |

---

## 12. 风险与开放问题

### 12.1 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 切换导致重复副作用 | 重复写文件/重复提交 | 副作用守卫；只有首副作用前可换 |
| 预算被重复预留 | 余额被占两次 | 只按 primary 预留；更贵切换先补差 |
| Rest 被当成调度开关 | 人为制造"某模型不可用" | 写路径内部化；人工清除需审计 |
| 价目表缺项让切换失效 | 备用永远不可用 | 明确 `PRICE_UNKNOWN` 是**预期**行为；补价目表作为运维动作 |
| 亲和与 worktree 冲突 | 复用失败、误导 | 亲和只做排序，不做承诺；记录 `cache_hint` 验证 |
| 多宿主同时写 Rest | 状态抖动 | 以 `(scope, profile)` 为主键，写入幂等（取更晚的 `until`） |
| 与回收器叠加 | 双写者 | §6.6 先修阈值与心跳 |

### 12.2 已裁定（2026-10-30）

| # | 问题 | 裁定 | 落到哪 |
| --- | --- | --- | --- |
| 1 | 更贵候选的批准入口 | 任务上放"允许升价一次"标记；同时允许将军在调度台操作。标记是**一次性**的，消费后自动清零 | §6.8 |
| 2 | fallback 是否跨 provider | P1 只允许**同 provider** 内切换；跨 provider 作为 P3 的可选开关，默认关 | §5.2、§10 |
| 3 | Rest 是否上任务卡 | 只在**任务详情**展示；卡片不加，避免信息过载 | §7 |

三条的理由（一句话）：

1. 标记放任务上，是因为"这次值得多花钱"是**任务级判断**；放全局会变成长期授权，放模型上又太碎。
2. 先同 provider，是因为跨 provider 改变的不只是成本，还有"数据去了哪"；这一条要单独开关、单独审计。
3. 卡片是扫视用的，详情是判断用的；Rest 属于后者。

---

## 13. 附录

### 13.1 与 magpie 的概念对照

| magpie | Legion 本设计 | 差异 |
| --- | --- | --- |
| candidate（key/account） | candidate（model_profile） | Legion 的粒度是模型档案，不是账号 |
| Rest（内存 + 到期） | `model_rest`（落库） | Legion 多宿主，必须共享 |
| try trace（Routing 页） | `model_decisions` + 任务时间线 | Legion 要能回答"为什么"，不止"发生了什么" |
| 静默 failover | 有序 failover + 价格守卫 | Legion 宁可停下，不偷偷花钱 |
| 账号池 + pace | 无（P2 再议） | 没有订阅账号这个维度 |
| 常驻会话保缓存 | 软亲和 | worktree 生命周期不允许常驻 |

### 13.2 术语

| 术语 | 含义 |
| --- | --- |
| attempt | 一次阶段执行尝试，有幂等键、租约与预算预留 |
| candidate | 一个可被尝试的模型档案 |
| Rest | 某候选在一段时间内不可用的状态 |
| 副作用边界 | 第一次成功的外部写入；越过后不允许重试 |
| 影子模式 | 只记录决策、不改变执行的运行模式 |
