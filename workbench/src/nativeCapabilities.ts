// workbench/src/nativeCapabilities.ts
// ============================================================================
// 本地 Agent 工具（`dsh-native`）的**能力声明**：能读到的从 provider 自报的真值推导，
// 读不到的如实标注为用户声明。
//
// ## 为什么（这是一处"发布成功、派工必失败"的缺陷）
//
// 面板上原来有 4 个复选框（支持工具过滤 / 提供本地 Agent 拦截 / 支持会话续接 /
// 支持取消执行），而 `outputSchema`（结构化输出）**连复选框都没有，硬编码 `true`**：
//
//     const capabilities = { textInput: true, textOutput: true, outputSchema: true,
//                            toolFilter: nativeToolFilter, localAgent: nativeLocalAgent,
//                            sessionResume: nativeSessionResume, cancellation: nativeCancellation }
//
// 可这份声明是**真的会被按它拒收**的 —— 三处：
//
//   · `plugins/src/index.ts`（派工）：要求 `frozenConfig.capabilities.outputSchema === true`，
//     且与 `subagentProvider(ctx, name).capabilities` 逐位相等，否则**抛错**；
//   · `team-hub/server.mjs`（认领）：要求声明与节点心跳上报的 outputSchema/toolFilter/
//     cancellation **逐位相等**，否则**抛错**。
//
// ⇒ 一个 provider 若自报 `outputSchema: false`，用户在 UI 上**看不到**（没有那个复选框）、
//   **也改不了**（硬编码 true），发布**成功**，然后**每一次派工都抛错**。
//
//   > 一个"发布成功、派工必失败"的配置，
//   > 与一个"发布时就报错"的配置，在**用户还没派工**的时候看上去一模一样 ——
//   > 区别只在第一次派工之后，而那时他已经在查任务为什么不动了。
//
// 参考项目 `agent-network`（Apache-2.0）的 #622 是同一形状：能力/就绪是**声明**而不是**读数**，
// 于是界面对跑不起来的东西照样打勾。它的修法是让 daemon 逐个自测并上报；我们这里同理 ——
// 读数已经在心跳里了（`providers[<name>].declared`），本模块只负责**用它**。
//
// ## 哪些能推导、哪些不能（查证过的，不是猜的）
//
// | 能力位 | 本机有真来源？ | 依据 |
// |---|---|---|
// | `outputSchema` | **有** | `subagents.getProvider(name).capabilities.outputSchema`；DSH 的 `assertCapabilities` 真按它拒收 |
// | `toolFilter`   | **有** | 同上 |
// | `cancellation` | **有** | 同上（本仓适配器恒为 true：DSH run handle 提供 `dispose()`） |
// | `localAgent`   | **没有** | 它说的是"运行时交回的句柄带不带本地 Agent"（集成模式下硬要求），provider 描述符里**没有这一位** |
// | `sessionResume`| **没有** | 全仓检索：**没有任何消费方**，只在能力表里被读写 |
//
// 所以本模块**只推导前三项**；后两位如实标注为"本机读不出来、需你确认"。
// 把后两位也"推导"出来（比如猜 true）会比现状更坏：那会把一个猜测伪装成读数。
//
// 读数**缺席**时（旧守护不上报、或本轮自检还没跑到）三项也退回用户声明 ——
// 保持既有行为，但界面必须说清"这只是声明"。
// ============================================================================

/** 与 `team-hub/harness-store.mjs` 的 `parseCapabilities` 同一套键。 */
export interface ToolCapabilities {
  textInput: boolean
  textOutput: boolean
  outputSchema: boolean
  toolFilter: boolean
  localAgent: boolean
  sessionResume: boolean
  cancellation: boolean
}

/** provider 自报的能力位（心跳读数里的 `declared`）。 */
export interface DeclaredCapabilities {
  readonly outputSchema?: boolean
  readonly toolFilter?: boolean
  readonly cancellation?: boolean
  readonly permissionMode?: string
  readonly systemProxyMode?: string
}

/** 用户为**读数推不出来**的能力位所做的声明（读数在场时仅后两位生效）。 */
export interface UserDeclaredCapabilities {
  readonly toolFilter: boolean
  readonly localAgent: boolean
  readonly sessionResume: boolean
  readonly cancellation: boolean
}

/** 有真来源、能从读数推导的三位。 */
export const DERIVED_KEYS = Object.freeze(['outputSchema', 'toolFilter', 'cancellation'] as const)
/** 没有真来源、只能由用户声明的两位。 */
export const ASSUMED_KEYS = Object.freeze(['localAgent', 'sessionResume'] as const)

export const ASSUMED_REASONS: Readonly<Record<typeof ASSUMED_KEYS[number], string>> = Object.freeze({
  localAgent: '本机读不出来：它说的是"运行时交回的句柄带不带本地 Agent"（集成模式下硬要求），provider 描述符里没有这一位。',
  sessionResume: '本机读不出来，且当前没有任何消费方确认它 —— 如实声明即可，留着是为了将来接续会话。',
})

export interface Derivation {
  /** 合并后的完整声明，可直接送给 `registerAgentToolConfig`。 */
  readonly capabilities: ToolCapabilities
  /** 哪些位来自读数（值可信）。 */
  readonly derived: readonly string[]
  /** 哪些位来自用户（值只是声明）。 */
  readonly assumed: readonly string[]
  /**
   * 拦下发布的理由（空 = 可以发）。
   *
   * ★ 只在**读数明确不满足硬要求**时才拦。读数**缺席**时一律不拦 ——
   *   自检有 10 分钟 TTL 且旧守护根本不上报，拿"没读到"去拦等于
   *   "我刚装好却不让发"。（同一条纪律在 provider 候选那边也写着。）
   */
  readonly blockers: readonly string[]
  /** 值得提醒、但不拦的理由（例如读数缺席）。 */
  readonly warnings: readonly string[]
}

/**
 * 推导本地 Agent 的能力声明。
 *
 * @param declared 本机读数里的 `declared`；`null`/`undefined` = **没读到**（不是"不支持"）
 * @param user     四项用户声明 —— 读数在场时只有 `localAgent`/`sessionResume` 生效
 */
export function deriveNativeCapabilities(
  declared: DeclaredCapabilities | null | undefined,
  user: UserDeclaredCapabilities,
): Derivation {
  const hasReading = isUsableReading(declared)
  const blockers: string[] = []
  const warnings: string[] = []

  if (!hasReading) {
    warnings.push('本机还没有上报这个 provider 的能力读数（守护自检约 10 分钟一轮）。'
      + '下面的能力声明**只是声明**，派工时才会与真实 provider 逐位核对；对不上就会派工失败。')
  } else if (declared.outputSchema !== true) {
    // 硬要求：`plugins/src/index.ts`（派工）与 `team-hub/server.mjs`（认领）都要求它为 true。
    // 在这里拦下，比让他发布成功、然后每次派工都抛错要好。
    blockers.push('本机读数显示这个 provider **不支持结构化输出**（outputSchema=false），'
      + '而工作流阶段硬性要求它：现在发布的话，配置会保存成功，但**每一次派工都会失败**。'
      + '请换一个支持结构化输出的 provider，或不要把它用在跨 Agent 工作流里。')
  }

  const capabilities: ToolCapabilities = hasReading
    ? {
        textInput: true,
        textOutput: true,
        outputSchema: declared.outputSchema === true,
        toolFilter: declared.toolFilter === true,
        localAgent: user.localAgent,
        sessionResume: user.sessionResume,
        cancellation: declared.cancellation === true,
      }
    : {
        textInput: true,
        textOutput: true,
        // 读数缺席 ⇒ 退回用户声明（含此前的硬编码 true 行为），但上面已经 warn 过。
        outputSchema: true,
        toolFilter: user.toolFilter,
        localAgent: user.localAgent,
        sessionResume: user.sessionResume,
        cancellation: user.cancellation,
      }

  return {
    capabilities,
    derived: hasReading ? [...DERIVED_KEYS] : [],
    assumed: hasReading ? [...ASSUMED_KEYS] : [...ASSUMED_KEYS, ...DERIVED_KEYS],
    blockers,
    warnings,
  }
}

/** 读数够不够用：三个布尔位**齐全**才算读到了。 */
export function isUsableReading(declared: DeclaredCapabilities | null | undefined): declared is Required<Pick<DeclaredCapabilities, 'outputSchema' | 'toolFilter' | 'cancellation'>> {
  if (declared === null || declared === undefined || typeof declared !== 'object') return false
  return DERIVED_KEYS.every(key => typeof declared[key] === 'boolean')
}

/**
 * 从心跳读数里取某个 provider 的自报能力位。
 *
 * `null` = 没读到（未知），与"读到了、值为 false"**必须分得开** ——
 * 前者不拦发布，后者拦。这正是本模块存在的理由。
 */
export function declaredFor(
  readiness: { providers?: Record<string, { declared?: unknown }> } | null | undefined,
  providerName: string,
): DeclaredCapabilities | null {
  const raw = readiness?.providers?.[providerName]?.declared
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of DERIVED_KEYS) {
    if (typeof record[key] === 'boolean') out[key] = record[key]
  }
  if (typeof record.permissionMode === 'string' && record.permissionMode !== '') out.permissionMode = record.permissionMode
  if (typeof record.systemProxyMode === 'string') out.systemProxyMode = record.systemProxyMode
  // 三个布尔位不齐 ⇒ 当作**没读到**：把"缺位"读成 false 会把版本问题伪装成能力问题。
  return isUsableReading(out as DeclaredCapabilities) ? out as DeclaredCapabilities : null
}

/** 读数里这个 provider 的就绪状态（`null` = 没读到）。 */
export function readinessStateOf(
  readiness: { providers?: Record<string, { state?: unknown }> } | null | undefined,
  providerName: string,
): string | null {
  const state = readiness?.providers?.[providerName]?.state
  return typeof state === 'string' ? state : null
}
