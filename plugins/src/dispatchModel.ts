// plugins/src/dispatchModel.ts
// ============================================================================
// 派工用哪个模型 —— **纯函数**（BUG-027）
//
// ## 由来
//
// 实测（2026-10-12）这套系统里有**两个派工引擎**，只有一个在跑；而**在跑的那个
// 从不问"这个岗位用哪个模型"**：
//
//   · DSH 插件守护（本文件所在的那个，`plugins/src/index.ts`）—— 在跑，
//     但它取模型只走宿主的"默认模型"服务（DSH 的 `agent-default-model`），
//     于是**所有岗位用同一个模型**；
//   · Legion orchestrator worker（`product/orchestrator/worker.mjs`）—— 会读
//     `employee_model_bindings`，但它**没在跑**（`run_attempts` 0 行）。
//
// 全仓对此的证据：`plugins/src/**` 里匹配 `model-bindings` / `employee_model_bindings`
// / `primaryProfile` = **0 处**；而 `agent_models` 里躺着 17 行真实意图
// （`coder→flash`、`requirement→pro`、`gf001/reviewer→pro`…）。
//
// ## 本模块的判定顺序（**冻结快照优先**）
//
//   ① 任务上已经冻结了模型（工作流阶段）⇒ 用**它**。冻结的意义就是"这次不许被后改的配置影响"，
//      拿实时绑定去覆盖它是**倒退**：同一份审批过的任务会在两次重试里用不同的模型。
//   ② 没有冻结 ⇒ 按 `(空间, 岗位)` 去问绑定，命中主档案 ⇒ 用主档案的 provider/model。
//   ③ 其余情况（没绑定 / 绑定坏了 / 中枢读不到 / provider 不支持 agentOptions）
//      ⇒ **回落平台默认模型**，但 `source` 与 `note` 必须**说清是哪一种**。
//
// ## 关于 ③：回落是**用户裁决的**，但"不静默"是我加的要求
//
// 将军 2026-10-12 裁决：缺绑定**回落默认模型**（不拒跑）。这与仓库别处"不猜"的纪律相反，
// 因此这里加一条自己的纪律：**回落必须留痕迹**。
//
//   仓库里另一处写着同一件事（`orchestrator/worker/run-inputs.mjs`）：
//     "让它顶班会用一个没人选过的模型跑完这次运行，而且不报错"
//   —— 那句话反对的不是"回落"，是"**不报错**"。
//
//   > 一个"用了默认模型并且说了出来"的回落，
//   > 与一个"用了默认模型而没人知道"的回落，
//   > 在账单上是同一件事，在排障时是两件完全不同的事。
//
// 所以 `note` 是返回值的一部分，而不是可选装饰：调用方（守护）把它写进日志、写进
// 任务的「AI 执行过程」评论、也写进派工活动。
// ============================================================================

/** 最终用的模型来自哪里。 */
export const DISPATCH_MODEL_SOURCES = Object.freeze(['frozen', 'binding', 'default-fallback'] as const)
export type DispatchModelSource = (typeof DISPATCH_MODEL_SOURCES)[number]

/** 一次绑定解析的读数（把 HTTP 形状归一化之后的东西）。 */
export type BindingReadingKind = 'ok' | 'no-binding' | 'broken' | 'unreachable' | 'hub-off'

export interface BindingPrimary {
  profileId: string
  provider: string
  model: string
  reasoningEffort: string | null
}

export interface BindingReading {
  kind: BindingReadingKind
  primary: BindingPrimary | null
  /** 一句话说清"为什么是这个 kind"，直接进日志。 */
  detail: string
}

/**
 * 传给 DSH agent 的模型覆盖。
 *
 * 形状与**既有的冻结那条路**逐字一致（`agentOptionsForFrozenModel` 的产物在
 * `plugins/src/index.ts` 里就被声明为 `Record<string, string> | null`）：
 * 不在这里另立一个更严的类型 —— 那会让"冻结的"和"绑定的"两条路在
 * 启动子代理的那一处长得不一样，而它们本该是同一个东西。
 */
export type AgentModelOptions = Record<string, string>

export interface DispatchModelDecision {
  agentOptions: AgentModelOptions | null
  source: DispatchModelSource
  /** **必须**带给用户看的一句话：这次用什么模型、为什么。 */
  note: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * 把 `/api/model-bindings/resolve` 的响应归一化成读数。
 *
 * 四种失败**分开报**，因为修法不同：
 *   · `no-binding`（404）—— 去**建绑定**；
 *   · `broken`（200 但 resolution.ok=false，或链首不是主档案）—— 去**看那条绑定出了什么事**；
 *   · `unreachable` —— 去**看中枢进程**；
 *   · `hub-off` —— 去**看守护的 hubUrl 配置**。
 *
 *   > 一句"没拿到模型"，
 *   > 在"没有绑定"与"绑定坏了"两种情况下，对用户来说不是同一句话。
 */
export function parseBindingResolution(status: number, body: unknown): BindingReading {
  const b = (body ?? {}) as Record<string, unknown>
  if (status === 404) {
    return { kind: 'no-binding', primary: null, detail: `岗位的模型绑定不存在（HTTP 404${str(b.code) === '' ? '' : ` ${str(b.code)}`}）` }
  }
  if (status !== 200) {
    return { kind: 'unreachable', primary: null, detail: `模型绑定解析接口返回 HTTP ${status}${str(b.error) === '' ? '' : `：${str(b.error)}`}` }
  }
  if (b.ok !== true) {
    return { kind: 'unreachable', primary: null, detail: `模型绑定解析响应里 ok 不是 true：${JSON.stringify(b.ok)}` }
  }
  const resolution = (b.resolution ?? null) as Record<string, unknown> | null
  if (resolution === null || typeof resolution !== 'object') {
    return { kind: 'broken', primary: null, detail: '响应里没有 resolution 对象' }
  }
  if (resolution.ok !== true) {
    return {
      kind: 'broken', primary: null,
      detail: `这条绑定解析不出来（${str(resolution.code) || '无码'}）：${str(resolution.message) || '无说明'}`,
    }
  }
  const chain = Array.isArray(resolution.chain) ? resolution.chain : []
  const first = (chain[0] ?? null) as Record<string, unknown> | null
  const provider = str(first?.provider)
  const model = str(first?.model)
  const profileId = str(first?.id)
  if (first === null || first.role !== 'primary' || provider === '' || model === '' || profileId === '') {
    return {
      kind: 'broken', primary: null,
      detail: `解析说 ok 但链首不是一条可用的主档案（role=${JSON.stringify(first?.role)} id=${JSON.stringify(first?.id)} provider=${JSON.stringify(first?.provider)} model=${JSON.stringify(first?.model)}）`,
    }
  }
  return {
    kind: 'ok',
    primary: {
      profileId, provider, model,
      reasoningEffort: str(first.reasoningEffort) === '' ? null : str(first.reasoningEffort),
    },
    detail: `绑定主档案 ${profileId}（${provider}/${model}）`,
  }
}

/**
 * 决定这次派工用哪个模型。
 *
 * @param input.frozen   任务冻结快照给出的模型（有就优先；来自工作流阶段快照）
 * @param input.reading  绑定读数（`null` = 没去问过）
 * @param input.scope    这次派工的空间（进 note，便于排障时对着看）
 * @param input.role     这次派工的岗位（进 note）
 * @param input.agentOptionsSupported 当前 provider 是否吃 `agentOptions`
 *        （缺省 `true`；调用方从宿主的 provider 能力表里读。**不支持时不静默丢弃**，
 *        而是回落并说明——否则"绑定了却没生效"会看起来像"绑定没建"）
 */
export function decideDispatchModel(input: {
  frozen?: AgentModelOptions | null
  reading?: BindingReading | null
  scope: string
  role: string
  agentOptionsSupported?: boolean
}): DispatchModelDecision {
  const scope = str(input.scope) || '(未知空间)'
  const role = str(input.role) || '(未知岗位)'
  const frozen = input.frozen ?? null
  const supported = input.agentOptionsSupported !== false

  if (frozen !== null) {
    return {
      agentOptions: frozen,
      source: 'frozen',
      note: `模型 ${frozen.provider}/${frozen.model}（任务冻结快照指定）`,
    }
  }

  const reading = input.reading ?? null
  if (reading !== null && reading.kind === 'ok' && reading.primary !== null) {
    const p = reading.primary
    if (!supported) {
      // 绑定了，但当前 provider 不吃 agentOptions：**说出来**，否则看起来像"绑定没建"。
      return {
        agentOptions: null,
        source: 'default-fallback',
        note: `⚠ 岗位 ${scope}/${role} 的绑定是 ${p.provider}/${p.model}，但当前 provider 不支持 agentOptions ⇒ 这次用了**平台默认模型**`,
      }
    }
    return {
      agentOptions: {
        provider: p.provider,
        model: p.model,
        ...(p.reasoningEffort === null ? {} : { reasoningEffort: p.reasoningEffort }),
      },
      source: 'binding',
      note: `模型 ${p.provider}/${p.model}（岗位 ${scope}/${role} 的绑定，主档案 ${p.profileId}）`,
    }
  }

  const why = reading === null
    ? '这次没有去问绑定'
    : reading.kind === 'no-binding'
      ? `岗位 ${scope}/${role} 没有模型绑定`
      : reading.kind === 'hub-off'
        ? '这个守护没有配 hubUrl，问不到绑定'
        : reading.kind === 'broken'
          ? `岗位 ${scope}/${role} 的绑定读不出来（${reading.detail}）`
          : `问不到中枢的绑定解析（${reading.detail}）`
  return {
    agentOptions: null,
    source: 'default-fallback',
    note: `⚠ ${why} ⇒ 这次用了**平台默认模型**（岗位 ${scope}/${role} 没有被指定的模型）`,
  }
}
