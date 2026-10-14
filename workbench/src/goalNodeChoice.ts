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
  /** 此刻在跑几个 / 上限几个；`null`/缺失 = **未知**（老守护不上报或心跳过期）。 */
  readonly busy?: number | null
  readonly capacity?: number | null
  /** 机器标识；`null`/缺失 = **未知**。 */
  readonly machineId?: string | null
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

// ════════════════════════════════════════════════════════════════════════════
// 自动选择（B 档，2026-10-13）
//
// 用户的诉求：「如果只有一个节点，那直接分派，无需用户指定；创建目标后，如果用户没有
// 指定，优先按照外部 agent 空闲自主选择节点；都忙碌情况下再按默认配置，排队等待。」
// 并选定「**同机则改派、跨机则排队**」。
//
// ## 判据不是"谁最闲"，而是"是不是同一台机器"
//
// 绑定是**硬绑定**（整条链钉在一台上）。所以：
//   · **同机**：改派是安全的（共享文件系统）⇒ **保持不绑定**，让抢占式均衡继续工作。
//     这反而是更强的负载均衡 —— 任何空闲守护都能抢任何任务。
//   · **跨机**：一条链横跨两台 = 未实现场景（409 WORKSPACE_MISMATCH）⇒ **必须绑定**，
//     并挑最闲的那台。
//
//   > 一个"选最闲的绑定上去"的策略，与一个"同机就不绑"的策略，
//   > 在**只有一台机器**的时候是同一个结果 ——
//   > 区别只在多台机器时，而那时前者会把抢占式均衡换成静态指派。
//
// ## 五档决定（顺序即优先级）
//
//   ① 没有就绪节点        ⇒ 不绑（无可绑；与今天一致）
//   ② 恰好一个就绪节点    ⇒ **不绑**。它自然会认领；绑了反而在它掉线时挡死别的节点
//   ③ 有节点但机器标识缺失 ⇒ 不绑（**不知道就别乱钉**）
//   ④ 全在同一台机器      ⇒ 不绑（同机 ⇒ 改派）
//   ⑤ 跨机器              ⇒ 绑**最闲**的那台（跨机 ⇒ 排队）
// ════════════════════════════════════════════════════════════════════════════

/** 自动决定的结果。 */
export interface AutoNodeDecision {
  /** 要绑定的节点 id；`null` = **不绑定**（任一在线执行服务可认领）。 */
  readonly nodeId: string | null
  /** 为什么这么决定（给用户看的一句话）。 */
  readonly reason: string
  /** 决定所依据的档位，便于判据与界面措辞对齐。 */
  readonly kind:
    | 'none-ready'
    | 'single-ready'
    | 'machine-unknown'
    | 'same-machine'
    | 'cross-machine'
  /** 参与决策的机器标识（去了空值、去重、排序），便于界面显示"跨了哪几台"。 */
  readonly machines: readonly string[]
}

/** 一个就绪节点"用了多少" —— 未知一律按"最不可信"处理（见下）。 */
function loadRatio(node: NodeLike): number {
  const busy = typeof node.busy === 'number' ? node.busy : null
  const capacity = typeof node.capacity === 'number' && node.capacity > 0 ? node.capacity : null
  if (busy === null || capacity === null) return Number.POSITIVE_INFINITY
  return busy / capacity
}

/** 节点是否"确实空闲"（有可信的忙闲读数，且没跑满）。 */
export function isNodeIdle(node: NodeLike): boolean {
  const busy = typeof node.busy === 'number' ? node.busy : null
  const capacity = typeof node.capacity === 'number' && node.capacity > 0 ? node.capacity : null
  if (busy === null || capacity === null) return false
  return busy < capacity
}

/**
 * 按负载排序候选（挑最闲的那台）。
 *
 * ★ 排序规则里"未知"必须排在**最后**：
 *   忙闲未知的节点可能是**已经失联**的机器，把它排在"确实空闲"的前面，
 *   等于优先把活儿交给最不可信的那台。
 *
 *   > 一个"忙闲未知"的节点，与一个"确实空闲"的节点，
 *   > 只有在**排序规则**里被分开，选择器才不会总是挑错。
 */
export function rankNodesByLoad(nodes: readonly NodeLike[]): readonly NodeLike[] {
  return [...nodes].sort((a, b) => {
    const ra = loadRatio(a)
    const rb = loadRatio(b)
    if (ra !== rb) return ra - rb              // 负载比例升序
    const ia = isNodeIdle(a) ? 0 : 1
    const ib = isNodeIdle(b) ? 0 : 1
    if (ia !== ib) return ia - ib              // 确实空闲的排在前
    const ba = typeof a.busy === 'number' ? a.busy : Number.POSITIVE_INFINITY
    const bb = typeof b.busy === 'number' ? b.busy : Number.POSITIVE_INFINITY
    if (ba !== bb) return ba - bb
    return String(a.id ?? '').localeCompare(String(b.id ?? ''))  // 稳定收尾，避免同分抖动
  })
}

/** 取机器标识（`null` = 未知）。
 *
 * ★ 只做 `trim`，**刻意不做大小写归一**。两个方向的错误代价不对等：
 *   · 同一台被误判成跨机 ⇒ 多余绑定（丢掉抢占式均衡，但任务照跑）；
 *   · 跨机被误判成同一台 ⇒ 整条链横跨两台 = **未实现场景**，任务 409 卡住。
 *   后者贵得多，所以这里**尽可能区分**。
 *
 *   > 一个"尽可能合并"的判断，与一个"尽可能区分"的判断，
 *   > 在**两边的错误一样贵**的时候才是等价的选择。
 */
function machineOf(node: NodeLike): string | null {
  const m = typeof node.machineId === 'string' ? node.machineId.trim() : ''
  return m === '' ? null : m
}

/**
 * 自动决定"这条链要不要绑、绑哪台"。
 *
 * 五档的措辞刻意不同：用户读到的那句话应当**直接对应判据**，
 * 而不是一句含糊的"已自动选择"。
 */
export function decideAutoNode(nodes: readonly NodeLike[] | null | undefined): AutoNodeDecision {
  const ready = (nodes ?? []).filter((n): n is NodeLike => n !== null && typeof n === 'object'
    && typeof n.id === 'string' && n.id !== '' && n.status === 'ready')
  const machines = [...new Set(ready.map(machineOf).filter((m): m is string => m !== null))].sort()
  /** 没上报机器标识的节点（`missing` 在下面几档里用来决定"敢不敢下判断"）。 */
  const missing = ready.filter((n) => machineOf(n) === null)

  // ① 没有就绪节点
  if (ready.length === 0) {
    return {
      kind: 'none-ready',
      nodeId: null,
      machines,
      reason: '当前没有就绪的执行节点 ⇒ 本条链**不绑定节点**，等任一执行服务上线后由它认领。',
    }
  }

  // ② 恰好一个就绪节点 —— 不需要用户指定，也**不需要绑定**
  if (ready.length === 1) {
    const only = ready[0]
    return {
      kind: 'single-ready',
      nodeId: null,
      machines,
      reason: `只有 1 个就绪执行节点（${only.label ?? only.id}）⇒ **不绑定**，它将直接认领。`
        + '（绑了反而在它掉线时挡死后来上线的节点。）',
    }
  }

  // ③ 机器标识**已经证成跨机** ⇒ 绑定（哪怕还有节点没上报）。
  //
  //    ★ 顺序很要紧：这一档必须排在"有节点没上报就放弃"**之前**。
  //      第一版把"有未知节点 ⇒ 不绑定"放在了前面，于是**已经证明**存在两台机器时，
  //      反而因为第三个节点没上报而退化成不绑定 —— 把已证成的跨机风险原样放回去。
  //
  //      > 一个"证据不足就退让"的规则，
  //      > 与一个"证据已经够了还在退让"的规则，
  //      > 在**所有节点都上报**的时候是同一个东西 ——
  //      > 区别只在有节点没上报的那次，而那次恰好是最需要它下判断的。
  if (machines.length >= 2) {
    const ranked = rankNodesByLoad(ready)
    const pick = ranked[0]
    const idleCount = ready.filter(isNodeIdle).length
    const busyNote = idleCount > 0
      ? `当前有 ${idleCount} 个空闲，选最闲的那个。`
      : '当前都忙 ⇒ **排队等待**（任务留在 todo，等它腾出并发后认领）。'
    const loadNote = typeof pick.busy === 'number' && typeof pick.capacity === 'number'
      ? `（${pick.busy}/${pick.capacity}）`
      : '（忙闲未知，按兜底顺序选中）'
    const unknownNote = missing.length > 0
      ? `另有 ${missing.length} 个节点未上报机器标识，已按最不优先处理。`
      : ''
    return {
      kind: 'cross-machine',
      nodeId: String(pick.id),
      machines,
      reason: `就绪节点跨了 ${machines.length} 台机器（${machines.join('、')}）⇒ **绑定**到最闲的`
        + `${pick.label ?? pick.id}${loadNote}，避免同一条链横跨两台（交接尚未实现）。${busyNote}${unknownNote}`,
    }
  }

  // ④ 只有一台已知机器，且**全部**节点都上报了标识 ⇒ 同机 ⇒ 不绑（同机 ⇒ 改派）
  if (machines.length === 1 && missing.length === 0) {
    return {
      kind: 'same-machine',
      nodeId: null,
      machines,
      reason: `${ready.length} 个就绪节点**都在同一台机器上**（${machines[0]}）⇒ **不绑定**：`
        + '同机可以改派，保持"谁空闲谁认领"，比钉死在一台上更能吃满并发。',
    }
  }

  // ⑤ 其余 = **判不清**：已知只有一台机器，但还有节点没上报标识（它可能在另一台上）。
  //
  //    这里**刻意不猜**。两个方向各有各的代价，而且方向相反：
  //      · 不绑 ⇒ 若那个未知节点其实在另一台机器上，这条链可能跨机（未实现场景）；
  //      · 绑   ⇒ 若它其实同一台机器，就白白丢掉了抢占式均衡。
  //    判不清时**不改变默认行为**（不绑定 = 与今天完全一致），并把这件事实说出来，
  //    把决定权交回给用户（界面上仍可手动指定节点）。
  //
  //    > 一个"数据不全时按最坏情况假设"的策略，与一个"数据不全时沿用今天的默认"的策略，
  //    > 在**数据齐全**的时候是同一个东西 ——
  //    > 区别只在它不全的那次，而那时前者会悄悄改变既定行为。
  return {
    kind: 'machine-unknown',
    nodeId: null,
    machines,
    reason: `${ready.length} 个就绪节点里有 ${missing.length} 个没上报机器标识 ⇒ **不绑定**`
      + '（无法确定它们是否同一台机器）。若你确实要把这条链钉在某台上，请手动指定。',
  }
}

/**
 * 最终要绑的节点 id：**用户显式指定优先，否则用自动决定**。
 *
 * ★ 手动指定永远压过自动 —— 自动是为了省事，不是为了夺走控制权。
 */
export function effectiveNodeId(manualChoice: string | null | undefined, decision: AutoNodeDecision): string | null {
  const manual = typeof manualChoice === 'string' ? manualChoice.trim() : ''
  if (manual !== '') return manual
  return decision.nodeId
}
