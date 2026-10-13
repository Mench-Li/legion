// workbench/src/goalNodeChoice.ts
// ============================================================================
// 「发布目标时,该用哪个执行节点?」—— **纯判定**,不碰网络、不碰 React。
//
// ## 用户要的流程
//
//   「任务创建后，自动扫描，再推用户确认使用哪个节点」
//
// 我们把它落在**目标发布**这一步,而不是每个任务上。理由不是省事,是**架构硬约束**:
//
//   `team-hub/server.mjs` 的认领路径明写:同一目标的链上出现两个不同节点 ⇒
//   409 `AGENT_NODE_WORKSPACE_MISMATCH`,原话是「跨节点 workspace/Git 交接尚未实现」。
//
//   ⇒ **一条链只能落在一台机器上**。所以"逐任务选节点"既做不到、也没必要;
//     正确的粒度是**每个目标(链)一次**。
//
//     > 一个"每次任务都问一次"的提示，与一个"每个目标问一次"的提示，
//     > 在**只有一台机器**的时候都是同一个答案 ——
//     > 区别只在于前者把同一个问题问了 N 遍，而其中 N-1 遍没有信息量。
//
// ## ★★ 最要紧的一条:**默认不绑定**
//
// 绑定是**硬绑定**。任务快照里写了节点之后,认领路径要求:
//
//     expectedNode.id === requestedAgentNodeId   （否则 409 AGENT_NODE_MISMATCH）
//
// 而 `requestedAgentNodeId` 来自**守护自己的** `config.agentNodeId`。
// 也就是说:**绑定了节点,就必须有配着同一个 agentNodeId 的守护在跑**,
// 否则这条链上的每一个任务都**一件都领不走**。
//
// 实测本机守护的 `agentNodeId` 是**空的**、注册节点数是 **0** ⇒ 一旦默认绑定,
// 今天能跑的流水线会当场全停。所以:
//
//   · 没有登记节点 / 没有就绪节点 ⇒ **不绑定**,并按今天的语义继续(任一在线节点认领);
//   · 有就绪节点 ⇒ **呈现**给用户,**只有他显式确认**才绑定。
//
//     > 一个"替用户选好了"的默认值，与一个"用户选好了"的值，
//     > 在**它恰好对**的时候是同一个东西 ——
//     > 区别只在它错的那次，而硬绑定的错法是"整条链一件都领不走"。
// ============================================================================

/** 执行节点在界面上的最小形状（`/api/agent-nodes` 的子集）。 */
export interface NodeLike {
  readonly id?: string
  readonly label?: string
  readonly status?: string
  readonly observedProviders?: readonly string[]
  readonly enabled?: boolean
}

/** 扫描结论的四种情形。**每一档该说的话不同**，所以不许合并。 */
export type NodeScanKind =
  /** 一个节点都没登记 —— 这是**今天就能跑**的状态，不是错误。 */
  | 'none-registered'
  /** 登记了，但没有一个 ready（没心跳 / 心跳过期 / 能力不符）。 */
  | 'none-ready'
  /** 恰好一个 ready ⇒ 可以当建议值，但**仍需用户确认**（硬绑定的代价见文件头）。 */
  | 'single-ready'
  /** 多个 ready ⇒ 这才是一次**真正的选择**。 */
  | 'multiple-ready'

export interface NodeScan {
  readonly kind: NodeScanKind
  /** ready 的节点（`single-ready` 时长度为 1，`multiple-ready` 时 >1）。 */
  readonly readyNodes: readonly NodeLike[]
  /** 登记了但没就绪的节点（用来解释"为什么只有一个可选"）。 */
  readonly notReadyNodes: readonly NodeLike[]
  /** 建议绑定的节点 id（只有 `single-ready` 才给；其余为 null）。 */
  readonly suggestedNodeId: string | null
  /** 给用户看的一句话。 */
  readonly headline: string
  /** 是否值得**弹出一次确认**（只有"有得选"时才值得）。 */
  readonly shouldAsk: boolean
}

/**
 * 扫描节点列表,给出结论。
 *
 * @param nodes `/api/agent-nodes?scope=` 的返回
 */
export function scanNodes(nodes: readonly NodeLike[] | null | undefined): NodeScan {
  const list = (nodes ?? []).filter((n): n is NodeLike => n !== null && typeof n === 'object' && typeof n.id === 'string' && n.id !== '')
  const readyNodes = list.filter((n) => n.status === 'ready')
  const notReadyNodes = list.filter((n) => n.status !== 'ready')

  if (list.length === 0) {
    return {
      kind: 'none-registered',
      readyNodes: [], notReadyNodes: [], suggestedNodeId: null, shouldAsk: false,
      // 这不是错误，是**默认部署**：不绑节点，任一在线执行服务都能认领。
      headline: '尚未登记任何执行节点。本条链**不绑定节点**，由任一在线的执行服务认领（当前默认行为）。',
    }
  }
  if (readyNodes.length === 0) {
    return {
      kind: 'none-ready',
      readyNodes: [], notReadyNodes, suggestedNodeId: null, shouldAsk: false,
      headline: `登记了 ${list.length} 个执行节点，但**没有一个就绪**（${notReadyNodes.map((n) => `${n.id}:${n.status ?? 'unknown'}`).join('、')}）。`
        + '本条链**不绑定节点**；等某个节点心跳就绪后，任一在线节点仍可认领。',
    }
  }
  if (readyNodes.length === 1) {
    const only = readyNodes[0]
    return {
      kind: 'single-ready',
      readyNodes, notReadyNodes, suggestedNodeId: String(only.id), shouldAsk: true,
      headline: `本空间有 **1 个就绪执行节点**：${only.label ?? only.id}（${only.id}）。`
        + '下面的建议是它 —— 但**默认保持不绑定**，你可以直接沿用默认。',
    }
  }
  return {
    kind: 'multiple-ready',
    readyNodes, notReadyNodes, suggestedNodeId: null, shouldAsk: true,
    headline: `本空间有 **${readyNodes.length} 个就绪执行节点**：${readyNodes.map((n) => n.label ?? n.id).join('、')}。`
      + '整条链只能落在**同一台**上（跨节点交接尚未实现），请选一个。',
  }
}

/**
 * 绑定前的**后果提示**（绑定是硬的,所以必须说清代价）。
 *
 * 返回 null = 无需额外提示。
 */
export function bindingWarning(nodeId: string | null | undefined): string | null {
  const id = typeof nodeId === 'string' ? nodeId.trim() : ''
  if (id === '') return null
  // 这条提示来自认领路径本身（server.mjs:6089 的 AGENT_NODE_MISMATCH）：
  // 任务绑了节点,而认领方带的 agentNodeId 不是它 ⇒ 409。
  return `已绑定到「${id}」。**认领这条链的执行服务必须配同一个 \`agentNodeId\`**（${id}），`
    + '否则链上每个任务都会因节点不匹配而无法认领（不是重试就会好，是配置不一致）。'
}

/**
 * 工作流阶段绑的节点 vs 本次选择的节点 —— 冲突要在**发布时**说清。
 *
 * 背景：同一条链出现两个节点时,认领路径会抛 409 `AGENT_NODE_WORKSPACE_MISMATCH`
 * （「跨节点 workspace/Git 交接尚未实现」）。但那要**等到认领**才发生 ——
 * 用户看到的是"任务不动"。这里把它提前到发布时。
 *
 * @param stageNodeIds 冻结工作流各阶段绑定的节点 id（去重前）
 * @param chosenNodeId 本次选择（null = 不绑定）
 */
export function crossNodeConflict(
  stageNodeIds: readonly (string | null | undefined)[],
  chosenNodeId: string | null | undefined,
): { kind: 'none' } | { kind: 'workflow-internal'; nodeIds: readonly string[] } | { kind: 'against-choice'; stageNodeId: string; chosenNodeId: string } {
  const distinct = [...new Set(stageNodeIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim()))]

  if (distinct.length > 1) {
    // 工作流自己就要求两台机器 —— 这与用户选什么无关，先报它。
    return { kind: 'workflow-internal', nodeIds: distinct }
  }
  const chosen = typeof chosenNodeId === 'string' ? chosenNodeId.trim() : ''
  if (distinct.length === 1 && chosen !== '' && distinct[0] !== chosen) {
    return { kind: 'against-choice', stageNodeId: distinct[0], chosenNodeId: chosen }
  }
  return { kind: 'none' }
}

/** 把冲突翻成一句能读的话;无冲突返回 null。 */
export function describeCrossNodeConflict(conflict: ReturnType<typeof crossNodeConflict>): string | null {
  if (conflict.kind === 'none') return null
  const tail = '跨节点 workspace/Git 交接**尚未实现**：同一条链出现两个节点时，任务会在认领时报 409、表现为"任务不动"。'
  if (conflict.kind === 'workflow-internal') {
    return `这条工作流把不同阶段绑到了不同节点（${conflict.nodeIds.join('、')}）。${tail}`
  }
  return `你选的节点「${conflict.chosenNodeId}」与工作流阶段绑定的「${conflict.stageNodeId}」不同。${tail}`
}
