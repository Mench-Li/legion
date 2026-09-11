// runtime/adapters/dsh/session-boundary.mjs
// ============================================================================
// PRT-211：DSH continuable session 的**边界**。
//
// 任务是「验证 DSH continuable session 的身份、权限继承、事件续接、取消和恢复边界」。
// 本文件把该验证的结论固化成**可执行的判据**，并把「验证到什么程度」写进代码。
//
// ## 证据分级（这一节是本文件最重要的部分）
//
// 我不想让「读到了类型签名」被当成「验证了行为」。两者差别很大：
//
//   api-surface-verified   从**运行中**的 Inspect 注册表读到的真实签名。
//                          能证明「该方法存在、参数是什么」，**不能**证明它在特定时序下的行为。
//   behavior-unverified    **没有**端到端跑过一次 continuable session。
//
// 因此本批次**不**声称完成了「验证」这个词的全部含义。已证实的是接口面与边界划分；
// 未证实的是权限是否真的沿 parent→child 生效、事件续接在崩溃后是否真的可恢复。
// 那需要一个真实 parent/child 会话对，属阶段 3 的事（见 `OWNERSHIP`）。
//
// ## 结论：阶段 2 的 Adapter 是**一次性（one-shot）**的
//
// DSH **有**一整套 continuable session 能力（见 `DSH_CONTINUABLE_SURFACE`），
// 但它们**不在** Adapter 的端口上，也**不在** Adapter 的契约里。
// 这不是遗漏，是划分：Adapter 负责「跑一次 Run」，多轮续接属于编排器（阶段 3）。
//
// 危险不在「没实现」，而在**看起来实现了**：契约里有个可选能力叫 `session-resume`，
// Adapter 只要照抄 DSH 上报的能力，就会对外宣称支持恢复——
// 而它的 `recover()` 只会说「继续等同一个 run」，那是**等待**，不是**恢复**。
// 一旦有人按这个宣称去实现「崩溃后接着跑」，得到的会是**重跑**（副作用翻倍）。
// `checkContinuableBoundary()` 就是拦这个的。
// ============================================================================

/**
 * 证据分级。给判据用，不是给自己免责用的——
 * 读到签名就只敢说读到签名，没跑过就写没跑过。
 */
export const EVIDENCE_LEVEL = Object.freeze({
  apiSurface: 'api-surface-verified',
  behavior: 'behavior-unverified',
})

/**
 * DSH continuable session 的**真实**接口面。
 *
 * 来源：运行中 harness 的 Inspect 注册表（`Service.listService`），服务键 `subagents` /
 * `agents` / `sessions` / `agentLoop`。签名逐字抄自该注册表，不是从文档转述。
 */
export const DSH_CONTINUABLE_SURFACE = Object.freeze([
  Object.freeze({ service: 'subagents', signature: 'async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart>', role: 'identity' }),
  Object.freeze({ service: 'subagents', signature: 'async sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options: SubagentSendMessageOptions): Promise<MessageId>', role: 'event-resumption' }),
  Object.freeze({ service: 'subagents', signature: 'interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void', role: 'cancel' }),
  Object.freeze({ service: 'subagents', signature: 'async drainContinuableChildren(parent: Agent, childIds: readonly SessionId[]): Promise<void>', role: 'cancel' }),
  Object.freeze({ service: 'subagents', signature: 'async drainContinuableDescendants(parents: readonly Agent[]): Promise<void>', role: 'cancel' }),
  Object.freeze({ service: 'subagents', signature: 'async listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]>', role: 'identity' }),
  Object.freeze({ service: 'subagents', signature: 'async listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]>', role: 'identity' }),
  Object.freeze({ service: 'subagents', signature: 'interruptByParent(childSessionId: SessionId, parentSessionId: SessionId, mode: \'continuable\'): SubagentInterruptReceipt', role: 'cancel' }),
  Object.freeze({ service: 'agents', signature: 'async resume(options: ResumeAgentOptions): Promise<AgentHandle>', role: 'recovery' }),
  Object.freeze({ service: 'agents', signature: 'isOwnedBy(id: SessionId, owner: Agent): boolean', role: 'identity' }),
  Object.freeze({ service: 'agents', signature: 'enter(agent: Agent, owner: Agent | undefined): () => void', role: 'identity' }),
  Object.freeze({ service: 'agentLoop', signature: 'async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>', role: 'recovery' }),
  Object.freeze({ service: 'sessions', signature: 'fork(source: SessionForkSource, boundary?: SessionSeq, childSessionId?: SessionId): Session', role: 'recovery' }),
  Object.freeze({ service: 'approval', signature: 'setPolicy(agent: Agent, policy: ApprovalPolicy): void', role: 'permission' }),
  Object.freeze({ service: 'approval', signature: 'overrideOf(session: Session): ApprovalPolicy | undefined', role: 'permission' }),
])

/** 关注面（与 PRT-211 的措辞一一对应）。 */
export const CONTINUABLE_ASPECTS = Object.freeze(['identity', 'permission', 'event-resumption', 'cancel', 'recovery'])

/** 阶段 2 的 Adapter **只**有这些端口方法（与 `port.mjs` 一致）。 */
export const ADAPTER_PORT_METHODS = Object.freeze(['startRun', 'probeRuntime'])

/**
 * 谁拥有哪一面。
 *
 * 划分理由：Adapter 的契约是「执行一次 Run 并给出终态」，它没有跨轮次的身份。
 * 多轮续接需要「这个任务的第 N 轮」这个概念，那是编排器的状态机。
 */
export const OWNERSHIP = Object.freeze({
  identity: Object.freeze({
    owner: 'orchestrator',
    stage: '阶段 3',
    detail: '一次性 Run 的 runId 是 Adapter 的身份；continuable child 的 SessionId 属于编排器。'
      + 'Adapter 的 startRun 端口**不返回** session id，因此它无法在事后寻址那个子会话——'
      + '这是端口形状决定的，不是实现疏漏。',
  }),
  permission: Object.freeze({
    owner: 'host-composition',
    stage: '阶段 2（PRT-212~215，已交付声明与探测）',
    detail: 'approval.setPolicy 是**按 agent** 设置的，overrideOf 是**按 session** 查询的。'
      + '因此子会话的权限不是「继承」来的一个值，而是要在子 agent 上**显式设置**。'
      + '把「继承」当作已成立，就会在子会话上留下未设置的策略。',
  }),
  'event-resumption': Object.freeze({
    owner: 'orchestrator',
    stage: '阶段 4',
    detail: 'sendMessage 是往一个**活着的** continuable child 追加轮次，不是「重放事件流」。'
      + '崩溃后想把事件流续上，需要编排器自己持久化进度（阶段 4 的上下文边界）。',
  }),
  cancel: Object.freeze({
    owner: 'adapters',
    stage: '阶段 2（已交付）',
    detail: '一次性 Run 的取消 = abort + 宽限期强制终态，已实现且受测。'
      + 'parent-scoped 的 interruptByParent 属于编排器。',
  }),
  recovery: Object.freeze({
    owner: 'adapters',
    stage: '阶段 2（已交付，且**刻意保守**）',
    detail: 'recover() 只回答「同一个 runId 现在处于什么状态」，'
      + '**不**提供跨进程重启的恢复。未知 runId 判 outcome-unknown 并禁止自动重试写入。',
  }),
})

/** 恢复判定的三种取值（与 `runtime/contracts` 的 recoveryResult 对齐）。 */
export const RECOVERY_DECISIONS = Object.freeze({
  alreadyTerminal: 'already-terminal',
  resumeSameRun: 'resume-same-run',
  outcomeUnknown: 'outcome-unknown',
})

/**
 * 把恢复判定翻译成**该做什么**。
 *
 * 这里的核心危险是一个词义混淆：`resume-same-run` 的字面像是「可以接着跑」，
 * 实际含义是「**继续等**同一个 run 的终态」。它不是「再调一次 execute」——
 * 那会是**第二次执行**，副作用翻倍。
 */
export function classifyRecovery(decision) {
  switch (decision) {
    case RECOVERY_DECISIONS.alreadyTerminal:
      return {
        decision,
        isResumption: false,
        action: 'report-terminal',
        mayReExecute: false,
        // 再跑就是一个**新的 run**（新的 runId），不是恢复
        note: '已结算。若业务需要重做，那是一次**新 Run**，必须换 runId 并重新走授权。',
      }
    case RECOVERY_DECISIONS.resumeSameRun:
      return {
        decision,
        isResumption: false,
        action: 'keep-waiting',
        mayReExecute: false,
        note: 'resume-same-run 是「继续等」，**不是**「再调一次 execute」。再调会被同 runId 的活跃登记拒绝。',
      }
    case RECOVERY_DECISIONS.outcomeUnknown:
      return {
        decision,
        isResumption: false,
        action: 'require-human',
        mayReExecute: false,
        note: '无法确认是否已产生外部副作用 → 只读重试可以，写入类**禁止**自动重试（否则可能重复下单/重复提交）。',
      }
    default:
      return {
        decision,
        isResumption: false,
        action: 'unknown',
        mayReExecute: false,
        note: `未识别的恢复判定：${JSON.stringify(decision)}。不得据此自动重试。`,
      }
  }
}

/**
 * 检查 Adapter 是否对外宣称了自己**兑现不了**的 continuable 能力。
 *
 * @param {object} inputs
 * @param {Record<string, boolean>} inputs.capabilities 能力协商结果
 * @param {Record<string, unknown>} [inputs.port] 宿主端口（用来判断真有实现）
 * @returns {{ok: boolean, findings: Array<{code: string, detail: string}>}}
 */
export function checkContinuableBoundary({ capabilities = {}, port = {} } = {}) {
  const findings = []

  // ① 宣称 session-resume，但端口上没有恢复语义的实现。
  if (capabilities['session-resume'] === true) {
    const hasResumePort = typeof port.resumeRun === 'function' || typeof port.subscribeRun === 'function'
    if (!hasResumePort) {
      findings.push({
        code: 'UNHONORED_SESSION_RESUME',
        // 这是**必须**拦住的一条：如果只是"能力列表多一项"，后果是有人按它去实现
        // 「崩溃后接着跑」，而实际行为是重跑——副作用翻倍，且账面上看不出来。
        detail: '能力协商宣称 session-resume=true，但宿主端口没有 resumeRun/subscribeRun。'
          + '本 Adapter 的 recover() 只回答同一 runId 的当前状态（等待，而非恢复）。'
          + '按这个宣称实现「崩溃后接着跑」会得到**重跑**，副作用翻倍。'
          + '应把 session-resume 报为 false，直到真正实现跨进程恢复。',
      })
    }
  }

  // ② 端口上出现了 Adapter 契约之外的 continuable 方法 → 说明有人把编排器职责塞进了适配器。
  const suspicious = Object.keys(port).filter((k) => /^(startContinuable|sendMessage|drainContinuable|listDescendants|interruptByParent)$/.test(k))
  if (suspicious.length > 0) {
    findings.push({
      code: 'ORCHESTRATOR_DUTY_IN_ADAPTER',
      detail: `宿主端口上出现了 continuable 操作方法：${suspicious.join('、')}。`
        + '这些属于编排器（阶段 3）：Adapter 的契约是「执行一次 Run 并给出终态」，'
        + '它没有跨轮次的身份概念。放进适配器会让阶段 3 无法独立替换编排实现。',
    })
  }

  return { ok: findings.length === 0, findings }
}

/**
 * 每个关注面的当前状态（供证据文档与自检报告使用）。
 *
 * 这里刻意**不**返回 "verified: true" 这样的字段——因为行为级验证没做。
 * 想让人看到的是 `evidence` 那一栏。
 */
export function describeContinuableBoundary() {
  return {
    evidenceLevel: EVIDENCE_LEVEL,
    aspects: CONTINUABLE_ASPECTS.map((aspect) => ({
      aspect,
      ...OWNERSHIP[aspect],
      // 全部只到接口面。写成逐面不同的分级会暗示「某些面验证得更深」——
      // 而实际上五个面**都没有**做过运行时行为验证。要一致地诚实。
      evidence: EVIDENCE_LEVEL.apiSurface,
      behaviorVerified: false,
    })),
    surfaceSize: DSH_CONTINUABLE_SURFACE.length,
    adapterPortMethods: [...ADAPTER_PORT_METHODS],
    caveat: '接口面已从运行中的注册表核实；**权限继承与事件续接的运行时行为未经端到端验证**'
      + '（需要一个真实 parent/child 会话对，属阶段 3）。不要把前者读成后者。',
  }
}
