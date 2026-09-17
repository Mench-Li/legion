// runtime/experience/graph.mjs
// ============================================================================
// F-18 经验图谱（spec §4.4）：「扩展任务、文件、技能、错误**关系图**」。
//
// ---------------------------------------------------------------------------
// ★ 唯一真正要紧的纪律：图里只有**被记下来的**边
//
// 最容易走偏的一步是"顺手补一条"：既然两个任务改了同一个文件，
// 就把它们连起来；既然同一个错误出现在同一个技能上，就加一条。
// 那样图会立刻变得很稠、很好看，查询也能给出"相关经验"。
//
// 但从此以后，"这条边是谁加的、依据什么"**没有任何地方能回答**——
// 而一条推断出来的边与一条人工确认的边，在图里长得完全一样。
//
//   > 一个「顺手补边」的关系图，
//   > 与一个「每条边都可能有依据、也可能只是巧合」的关系图，是同一个东西——
//   > 只不过前者的查询结果看起来很丰富。
//
// 所以本模块**只做存储与遍历**，不做任何推断：`addEdge` 只接受显式给出的边，
// 而每条边都带着 `source`（谁记的）与 `reason`（依据什么）。
//
// ---------------------------------------------------------------------------
// ② 撤销也是**记录**，不是删除
//
// 一条记错的边必须能被收回，否则图会永久带着噪声。但收回**不能**是删除：
//
//   > 一个「删掉记错的边」的图，
//   > 与一个「这条边到底存不存在过、为什么被收回」无从回答的图，是同一个东西。
//
// 所以 `retract` 追加一条**收回记录**，而"现在有效的边"是从整条记录流
// **推导**出来的（与 F-20 的账、F-19 的冻结同一条纪律：记录是唯一的真相，
// 状态是它的推导）。整条记录流仍然只追加，没有任何 UPDATE/DELETE。
//
// ---------------------------------------------------------------------------
// ③ 遍历必须**抗环**
//
// 这张图天然有环：错误 → 任务 → 同一错误 → …… 一个没有 visited 集合的
// 递归遍历会在这种图上**挂死**，而它在一个小测试图上跑得好好的。
//
//   > 一个「在测试用的树上跑得过」的遍历，
//   > 与一个「在真实的带环图上挂死」的遍历，是同一个东西。
//
// ============================================================================

/** 形态版本。 */
export const GRAPH_VERSION = 'legion/experience-graph@1'

/** 节点种类，**封闭词表**（§4.4 点名了四类）。 */
export const NODE_KINDS = Object.freeze(['task', 'file', 'skill', 'error'])

/**
 * 边的种类，**封闭词表**。
 *
 * 每一种都对应一句能被人读出来的话：
 *   · `touched`   —— 这个任务改动了这个文件
 *   · `used`      —— 这个任务用了这个技能
 *   · `failedWith`—— 这个任务以这个错误结束
 *   · `retriedBy` —— 这个错误在另一个任务上又出现了一次（重复失败）
 *   · `fixedBy`   —— 这个错误被这条经验/技能处置过
 *
 * ★ 没有 `related` 这种兜底种类。一个"什么都往里装"的边种类，
 *   与一个"所有边都是 related、于是没有任何查询能区分它们"的图，是同一个东西。
 */
export const EDGE_KINDS = Object.freeze(['touched', 'used', 'failedWith', 'retriedBy', 'fixedBy'])

export const GRAPH_CODES = Object.freeze({
  BAD_NODE: 'experience-graph-node-malformed',
  BAD_NODE_KIND: 'experience-graph-node-kind-unknown',
  BAD_EDGE: 'experience-graph-edge-malformed',
  BAD_EDGE_KIND: 'experience-graph-edge-kind-unknown',
  NODE_MISSING: 'experience-graph-node-missing',
  EDGE_MISSING: 'experience-graph-edge-missing',
  ALREADY_RETRACTED: 'experience-graph-edge-already-retracted',
  NO_ACTOR: 'experience-graph-no-actor',
})

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const nodeKey = (kind, id) => `${kind}:${id}`

/** 造一张空图。**只追加**：没有任何 remove/update 出口。 */
export function createGraph({ now = () => 0 } = {}) {
  /** 节点：key → {kind, id, atMs}。节点本身也只在第一次出现时写入。 */
  const nodes = new Map()
  /** **唯一**的真相：一条只追加的记录流（`node` / `edge` / `retract`）。 */
  const log = []
  let edgeSeq = 0

  function requireNode(kind, id, { atMs, create = true } = {}) {
    if (!NODE_KINDS.includes(kind)) {
      throw fail(
        GRAPH_CODES.BAD_NODE_KIND,
        `节点种类 ${JSON.stringify(kind)} 不在封闭词表里（合法：${NODE_KINDS.join(' / ')}）。` +
        '不给默认种类——一个"不认识的种类就归到 other"的图，' +
        '与一个"所有没归类的东西挤在一起"的图，是同一个东西',
      )
    }
    const name = String(id ?? '').trim()
    if (name === '') {
      throw fail(GRAPH_CODES.BAD_NODE, `${kind} 节点的 id 是空的`)
    }
    const key = nodeKey(kind, name)
    if (!nodes.has(key) && create) {
      const node = Object.freeze({ kind, id: name, atMs: atMs ?? null })
      nodes.set(key, node)
      log.push(Object.freeze({ seq: log.length + 1, type: 'node', node }))
    }
    return key
  }

  return Object.freeze({
    get version() { return GRAPH_VERSION },

    /** 记一个节点（重复记录是幂等的：节点只在第一次出现时进日志）。 */
    addNode({ kind, id, atMs = null } = {}) {
      const key = requireNode(kind, id, { atMs })
      return nodes.get(key)
    },

    /**
     * 记一条边。
     *
     * ★ 三个必填项缺一不可：`source`（谁记的）与 `reason`（依据什么）
     *   是这条边以后唯一能自证的东西（见文件头 ★）。
     */
    addEdge({ from, to, kind, source, reason = null, atMs = null } = {}) {
      if (!isPlainObject(from) || !isPlainObject(to)) {
        throw fail(GRAPH_CODES.BAD_EDGE, 'addEdge 需要 `from` 与 `to`，各自形如 `{ kind, id }`')
      }
      if (!EDGE_KINDS.includes(kind)) {
        throw fail(
          GRAPH_CODES.BAD_EDGE_KIND,
          `边种类 ${JSON.stringify(kind)} 不在封闭词表里（合法：${EDGE_KINDS.join(' / ')}）。` +
          '**没有 `related` 这种兜底种类**：一个"什么都往里装"的边种类，' +
          '与一个"所有边都是 related、于是没有任何查询能区分它们"的图，是同一个东西',
        )
      }
      const who = String(source ?? '').trim()
      if (who === '') {
        throw fail(
          GRAPH_CODES.NO_ACTOR,
          '边必须记下 `source`（谁记的）。一条不知道谁加的边，' +
          '在被怀疑时只能整条删掉——而"删掉"会让依赖它的查询静默少一条结果',
        )
      }
      // ★ 两端节点必须**先显式存在**：不隐式创建。
      //   隐式创建会让一个拼错的 id 安静地变成一个新节点，
      //   而"这个文件从没被碰过"与"我把文件名打错了"于是长得一样。
      //
      //   ★ 两端的报错**必须一样详细**：终点侧只写一句"不存在"时，
      //     读的人会以为终点与起点是两种不同的情况，于是去查一个不存在的区别。
      //     （第一次跑用例时正是如此：本用例断言两侧都给出了理由，
      //     而终点侧只有一句"不存在"。）
      const notCreated = (key, which) => fail(
        GRAPH_CODES.NODE_MISSING,
        `${which} ${key} 不存在。**不隐式创建**：一个拼错的 id 会安静地变成一个新节点，` +
        '而"这个文件从没被碰过"与"我把文件名打错了"于是长得一样',
      )
      const fromKey = nodeKey(from.kind, String(from.id ?? '').trim())
      const toKey = nodeKey(to.kind, String(to.id ?? '').trim())
      if (!nodes.has(fromKey)) throw notCreated(fromKey, '起点')
      if (!nodes.has(toKey)) throw notCreated(toKey, '终点')
      edgeSeq += 1
      const edge = Object.freeze({
        edgeId: `e${edgeSeq}`, from: fromKey, to: toKey, kind,
        source: who, reason: reason === null ? null : String(reason), atMs,
      })
      log.push(Object.freeze({ seq: log.length + 1, type: 'edge', edge }))
      return edge
    },

    /**
     * 收回一条边：`draft → promoted | discarded` 那类"终点"的图版本。
     *
     * **追加**一条收回记录，不删除任何东西（见文件头 ②）。
     */
    retract({ edgeId, by, reason = null, atMs = null } = {}) {
      const id = String(edgeId ?? '').trim()
      if (id === '') throw fail(GRAPH_CODES.BAD_EDGE, 'retract 需要 edgeId')
      const actor = String(by ?? '').trim()
      if (actor === '') {
        throw fail(
          GRAPH_CODES.NO_ACTOR,
          '收回边必须署名。没有署名的收回，与"这条边安静地消失了"是同一个东西',
        )
      }
      if (!log.some((r) => r.type === 'edge' && r.edge.edgeId === id)) {
        throw fail(GRAPH_CODES.EDGE_MISSING, `边 ${id} 不存在，收不回一条从来不存在过的边`)
      }
      if (log.some((r) => r.type === 'retract' && r.edgeId === id)) {
        throw fail(
          GRAPH_CODES.ALREADY_RETRACTED,
          `边 ${id} 已经被收回过。重复收回会把"被收回了几次"变成一个没有意义的数`,
        )
      }
      log.push(Object.freeze({
        seq: log.length + 1, type: 'retract', edgeId: id, by: actor,
        reason: reason === null ? null : String(reason), atMs,
      }))
      return Object.freeze({ retracted: true, edgeId: id, by: actor })
    },

    /** 一条边现在是否有效（= 被追加过、且没有被追加过收回记录）。 */
    isActive(edgeId) {
      const id = String(edgeId ?? '').trim()
      const added = log.some((r) => r.type === 'edge' && r.edge.edgeId === id)
      const gone = log.some((r) => r.type === 'retract' && r.edgeId === id)
      return added && !gone
    },

    /** 全部节点。 */
    nodes() {
      return Object.freeze([...nodes.values()])
    },

    /** 某个节点。不存在时返回 `null`（不是抛，也不是空节点）。 */
    node({ kind, id } = {}) {
      const key = nodeKey(kind, String(id ?? '').trim())
      return nodes.get(key) ?? null
    },

    /**
     * 现在有效的边。
     *
     * ★ 这是一个**推导**：从只追加的记录流里，按 edgeId 剔除被收回的。
     *   记录流本身是唯一真相，所以"这条边为什么不在结果里"永远能答。
     */
    edges({ kind = null, from = null, to = null } = {}) {
      const gone = new Set(log.filter((r) => r.type === 'retract').map((r) => r.edgeId))
      return Object.freeze(
        log
          .filter((r) => r.type === 'edge' && !gone.has(r.edge.edgeId))
          .map((r) => r.edge)
          .filter((e) => (kind === null || e.kind === kind)
            && (from === null || e.from === nodeKey(from.kind, String(from.id ?? '').trim()))
            && (to === null || e.to === nodeKey(to.kind, String(to.id ?? '').trim()))),
      )
    },

    /** 已经收回的边（保留下来的痕迹，用来回答"发生过什么"）。 */
    retractions() {
      return Object.freeze(log.filter((r) => r.type === 'retract').map((r) => Object.freeze({
        edgeId: r.edgeId, by: r.by, reason: r.reason, atMs: r.atMs,
      })))
    },

    /** 一条边的全部记录（追加 + 收回），按发生顺序。 */
    historyOf(edgeId) {
      const id = String(edgeId ?? '').trim()
      return Object.freeze(log.filter(
        (r) => (r.type === 'edge' && r.edge.edgeId === id) || (r.type === 'retract' && r.edgeId === id),
      ).map((r) => Object.freeze({ ...r })))
    },

    /**
     * 从某个节点出发、按边种类能到达的节点。
     *
     * ★ 带 `visited`（见文件头 ③）：这张图天然有环，
     *   而一个没有 visited 的递归遍历会在真实的带环图上挂死。
     */
    reachable({ kind, id, edgeKinds = null, depth = 3 } = {}) {
      const start = nodeKey(kind, String(id ?? '').trim())
      if (!nodes.has(start)) {
        throw fail(GRAPH_CODES.NODE_MISSING, `起点 ${start} 不存在`)
      }
      const allow = edgeKinds === null ? null : new Set(edgeKinds)
      const seen = new Set([start])
      let frontier = [start]
      const reached = []
      for (let d = 0; d < depth; d += 1) {
        const next = []
        for (const cur of frontier) {
          for (const e of this.edges()) {
            if (e.from !== cur) continue
            if (allow !== null && !allow.has(e.kind)) continue
            if (seen.has(e.to)) continue   // ★ 环就挡在这里
            seen.add(e.to)
            reached.push(nodes.get(e.to))
            next.push(e.to)
          }
        }
        if (next.length === 0) break
        frontier = next
      }
      return Object.freeze(reached)
    },

    /** 读数：够不够回答"这张图有没有内容"。 */
    stats() {
      const active = this.edges()
      const byKind = {}
      for (const k of EDGE_KINDS) byKind[k] = active.filter((e) => e.kind === k).length
      const byNodeKind = {}
      for (const k of NODE_KINDS) byNodeKind[k] = [...nodes.values()].filter((n) => n.kind === k).length
      return Object.freeze({
        nodes: nodes.size,
        edges: active.length,
        retracted: log.filter((r) => r.type === 'retract').length,
        // ★ 日志长度单独给出：`edges + retracted` **不等于**它（还有节点记录），
        //   而把三个数凑成一个"看起来自洽"的等式，会让对不上时没人发现。
        records: log.length,
        byKind: Object.freeze(byKind),
        byNodeKind: Object.freeze(byNodeKind),
      })
    },

    /** 原始记录流（只读副本）。诊断用：它是这张图**唯一**的真相。 */
    log() {
      return Object.freeze(log.map((r) => Object.freeze({ ...r })))
    },
  })
}
