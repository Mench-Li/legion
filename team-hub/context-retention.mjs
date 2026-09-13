// team-hub/context-retention.mjs
// ============================================================================
// 上下文快照的**保留策略**（PRT-409 收尾 / PRT-904 的快照面，spec line 748）
//
// ## 为什么快照不能沿用日志那一套
//
// `product/lifecycle/retention.mjs` 管的是 log / event / artifact。
// 快照**不属于其中任何一类**，因为它是**证据**：
//
//   > 一份快照存在的唯一理由是回答"模型当时看到了什么"。
//   > 删掉它，这个问题的答案就永久消失，而且**不可撤回**——
//   > 不像日志可以再打一遍，也不像产物可以重新生成。
//
// 把快照挂到 `event` 的 30 天上限上会很方便，代价是：
//
//   > 一个"用日志的 30 天上限顺便清掉快照"的实现，
//   > 与一个"30 天之后再也回答不了那次运行看到了什么"的实现，
//   > 是同一个东西——只不过前者的配置看起来是统一的。
//
// 所以快照有**自己的**策略对象、**自己的**类名、**自己的**默认值：
//
//   默认是 `{ maxAgeDays: null, maxBytes: null }` —— **故意不设上限**。
//   在现有 doctrine 里 `null` 与 `undefined` 是两个不同的意思
//   （`null` = "我故意不设"，`undefined` = "我忘了配"），
//   而"默认保留全部证据"正是那个**故意的**选择：删证据必须是有人明确要求的动作。
//
// ## ★ 第二条：清掉之后必须留下**墓碑**
//
// `contextStore().get()` 对"没有这一行"返回 `null`，路由给 404 `CONTEXT_NOT_FOUND`。
// 如果清理由此**借用**同一个 404：
//
//   > 一份"被保留策略清掉"的快照，与一份"从来没有过"的快照，
//   > 在 `GET` 回来时是同一个 404——
//   > 只不过前者意味着"这次的输入我们已经丢掉了"，
//   > 而后者意味着"你查错了 id"。
//
// 对一个以"可还原"为卖点的产品，这两件事的差别就是全部意义所在。
// 所以清理**不是 delete**，是**搬家**：正文删掉、留下
//
//   「这个 attemptId 存在过，内容哈希是 X，在某时刻被某人以某理由清掉了」。
//
// 墓碑里**没有正文**（那是清掉它的理由），但它回答了"它是不是存在过"。
//
// ## ★ 第三条：字节不是字符
//
// `maxBytes` 比的是**字节**。而快照正文里大量是中文——UTF-8 下一个汉字 3 字节。
// 拿 `String.length`（UTF-16 码元数）去比字节：
//
//   > 一个"拿字符数当字节数去比容量上限"的保留策略，
//   > 与一个"上限比配置的宽三倍"的保留策略，是同一个东西——
//   > 只不过它在纯英文数据上恰好是对的。
//
// 所以本模块的用量一律用 `Buffer.byteLength(text, 'utf8')`，不碰 `.length`。
//
// ## 与 `planRetention` 的关系：**不合并**
//
// 两者看起来像同一件事（都有时间/容量两条规则、都从最旧的开始删）。
// 但没有复用它的实现，理由和"不给快照挂 event 类"是同一条：
// 复用会把"删一条日志"与"删一份证据"变成同一条代码路径，
// 而这条路径上任何一次改动都会**同时**作用于两者——
// 于是一次为了日志调的参数会悄悄改变证据的去留。
// 判据（时间/容量、最旧优先、被引用的不删）是**照抄**的，实现是分开的。
// ============================================================================

/** 策略版本。改动默认值或判据时递增。 */
export const SNAPSHOT_RETENTION_VERSION = 'legion/context-snapshot-retention@1'

/** 快照在保留台账里的**类名**。它不在 `RETENTION_CLASSES` 里，这是有意的。 */
export const SNAPSHOT_CLASS_ID = 'context-snapshot'

export const SNAPSHOT_RETENTION_CODES = Object.freeze({
  /** 没有传 nowMs —— 不猜"现在"，什么都不清。 */
  NO_CLOCK: 'snapshot-retention-no-clock',
  /** 策略缺少 maxAgeDays 或 maxBytes（**显式 null 不算缺**）。 */
  POLICY_INCOMPLETE: 'snapshot-retention-policy-incomplete',
  /** 行的形状不对（缺 attemptId / 时间 / 大小）。 */
  ROW_MALFORMED: 'snapshot-retention-row-malformed',
  /** 已过期但所属 Run 仍在跑 —— 保留，并说明为什么没清。 */
  PINNED: 'snapshot-retention-pinned-by-active-run',
  /** 用量超出上限，但剩下的都不能清（都被引用）—— 如实报出来。 */
  CAP_UNREACHABLE: 'snapshot-retention-cap-unreachable',
})

/**
 * 默认策略：**保留全部**（显式的 `null`，不是"忘了配"）。
 *
 * 换一个说法：这个默认值的意思是"证据默认不销毁"。
 * 一个有上限的默认值会成为一次**静默的数据丢失**——
 * 它在用户没做任何决定的情况下，把"能还原"变成了"过期查不到"。
 */
export const DEFAULT_SNAPSHOT_RETENTION = Object.freeze({
  maxAgeDays: null,
  maxBytes: null,
})

const DAY_MS = 24 * 60 * 60 * 1000

/** UTF-8 字节数。**不用 `.length`**，理由见文件头第三条。 */
export function utf8Bytes(text) {
  if (typeof text !== 'string') return 0
  return Buffer.byteLength(text, 'utf8')
}

/**
 * 一条快照行的字节占用：正文 + payload 两份都要算。
 *
 * 只算 `final_text` 会低估：`payload_json` 里还有全部来源、分段与账本，
 * 在来源多的时候它比正文大得多。而**低估用量会让上限失去意义**。
 */
export function snapshotRowBytes({ finalText = '', payloadJson = '' } = {}) {
  return utf8Bytes(finalText) + utf8Bytes(payloadJson)
}

/**
 * 算一份快照保留计划。
 *
 * @param {object} args
 * @param {ReadonlyArray<{attemptId: string, runId: string, frozenAtMs: number, finalText?: string, payloadJson?: string, bytes?: number}>} args.rows
 *   全部**现存**的快照行（只含仍然在库里的；墓碑不参与——它们已经没有正文了）
 * @param {object} [args.policy]
 * @param {number} args.nowMs
 * @param {ReadonlyArray<string>} [args.activeRunIds] 仍在跑的 Run id
 * @returns {{version: string, purge: ReadonlyArray<object>, keep: ReadonlyArray<object>,
 *            findings: ReadonlyArray<object>, usage: object, cap: object }}
 */
export function planSnapshotRetention({
  rows = [], policy = DEFAULT_SNAPSHOT_RETENTION, nowMs, activeRunIds = [],
} = {}) {
  const findings = []
  const active = new Set(activeRunIds)

  // ① 没有"现在"就不清任何东西。与 `planRetention` 同一条纪律：
  //    猜一个当前时间的后果是**删掉不该删的**，而这个方向不可撤回。
  if (!Number.isFinite(nowMs)) {
    return Object.freeze({
      version: SNAPSHOT_RETENTION_VERSION,
      purge: Object.freeze([]),
      keep: Object.freeze([...rows]),
      findings: Object.freeze([Object.freeze({
        code: SNAPSHOT_RETENTION_CODES.NO_CLOCK,
        detail: '没有给 nowMs，无法判断"多久以前"——不猜当前时间，一份证据都不清',
      })]),
      usage: Object.freeze({ bytes: null, count: rows.length }),
      cap: Object.freeze({ maxBytes: policy?.maxBytes ?? null, maxAgeDays: policy?.maxAgeDays ?? null }),
    })
  }

  // ② 策略健全性。**显式 null 合法**（= 故意不设上限），undefined 是"忘了配"。
  //    注意：这里**不**把"两个都不设"当成问题——那是默认值本身。
  //    报出来的只有"字段整个缺席"，因为那才是配置事故。
  const policyObj = policy ?? {}
  if (policyObj.maxAgeDays === undefined || policyObj.maxBytes === undefined) {
    findings.push(Object.freeze({
      code: SNAPSHOT_RETENTION_CODES.POLICY_INCOMPLETE,
      detail: '快照保留策略缺少 maxAgeDays 或 maxBytes；'
        + '不设上限要**显式写 null**——"忘了配"与"故意保留全部证据"必须能区分',
    }))
  }

  // ③ 逐行核算大小。缺字段的行**不清**（宁可留着一份算不出大小的证据，
  //    也不要删掉一份本来该留的），报 finding。
  const sized = []
  for (const r of rows) {
    if (r === null || typeof r !== 'object'
      || typeof r.attemptId !== 'string' || r.attemptId === ''
      || !Number.isInteger(r.frozenAtMs)) {
      findings.push(Object.freeze({
        code: SNAPSHOT_RETENTION_CODES.ROW_MALFORMED,
        detail: `快照行形状不对（attemptId=${JSON.stringify(r?.attemptId)}，`
          + `frozenAtMs=${JSON.stringify(r?.frozenAtMs)}）：算不出它多旧多大，**不清**`,
      }))
      continue
    }
    const bytes = Number.isInteger(r.bytes)
      ? r.bytes
      : snapshotRowBytes({ finalText: r.finalText, payloadJson: r.payloadJson })
    sized.push({ attemptId: r.attemptId, runId: r.runId ?? null, frozenAtMs: r.frozenAtMs, bytes })
  }

  const totalBytes = sized.reduce((a, e) => a + e.bytes, 0)

  // ④ ★ 排序方向：**最旧的在前**。
  //    与 `planRetention` 一样，这个方向必须写死在这里——
  //    写反了不会报错，只会把**最新的**证据删掉，而报表看起来完全正常。
  //    同刻的用 attemptId 兜底排序，让计划是确定的（否则同一批输入两次算出不同的清理集）。
  const ordered = [...sized].sort((a, b) => (a.frozenAtMs - b.frozenAtMs)
    || (a.attemptId < b.attemptId ? -1 : (a.attemptId > b.attemptId ? 1 : 0)))

  const purge = []
  const keep = []
  const ageLimitMs = Number.isFinite(policyObj.maxAgeDays) ? policyObj.maxAgeDays * DAY_MS : null
  const byteLimit = Number.isFinite(policyObj.maxBytes) ? policyObj.maxBytes : null

  // ⑤ 先按**时间**判，再按**容量**判。两轮都遵守"被进行中 Run 引用的不删"。
  //
  //    `planRetention` 的第一版只在容量那一轮做了引用判断，漏了时间那一轮，
  //    于是"超过 30 天的产物"照样被删掉，哪怕它正被一个进行中的 Run 用着。
  //    这里从一开始就让两轮共用同一个 `decide` —— 一个判断写两遍就会有一天只改一处。
  const doomed = new Set()
  const pinned = new Set()
  const decide = (entry, why) => {
    if (doomed.has(entry.attemptId)) return
    if (entry.runId !== null && active.has(entry.runId)) {
      pinned.add(entry.attemptId)
      findings.push(Object.freeze({
        code: SNAPSHOT_RETENTION_CODES.PINNED,
        attemptId: entry.attemptId,
        runId: entry.runId,
        detail: `快照 ${entry.attemptId} 按${why}该清理，但它的 Run ${entry.runId} 仍在跑——保留。`
          + '一份还在被用的上下文，与一份已经收口的上下文不是一回事',
      }))
      return
    }
    doomed.add(entry.attemptId)
    purge.push(Object.freeze({
      attemptId: entry.attemptId, runId: entry.runId, frozenAtMs: entry.frozenAtMs,
      bytes: entry.bytes, reason: why,
    }))
  }

  if (ageLimitMs !== null) {
    const cutoff = nowMs - ageLimitMs
    for (const e of ordered) if (e.frozenAtMs < cutoff) decide(e, `${policyObj.maxAgeDays} 天前的旧快照`)
  }

  // 容量那一轮从**最旧的**开始删到够为止。
  //
  // 这里用"随时重算留下部分的字节数"而不是增量加减：增量的写法要在
  // 三个地方（时间轮已删的、容量轮新删的、被引用的）保持同步，
  // 而其中任何一处漏了都不会报错，只会让上限**看起来**达到了。
  // 重算的成本可以忽略（行数是快照数，不是日志数），换来的是一条不会算错的规则。
  const keptBytes = () => sized.filter((e) => !doomed.has(e.attemptId)).reduce((a, e) => a + e.bytes, 0)
  if (byteLimit !== null) {
    for (const e of ordered) {
      if (keptBytes() <= byteLimit) break
      if (doomed.has(e.attemptId)) continue
      decide(e, `容量超出上限（现存 ${totalBytes} 字节 > 上限 ${byteLimit}，从最旧的开始清）`)
    }
    const projected = keptBytes()
    if (projected > byteLimit) {
      findings.push(Object.freeze({
        code: SNAPSHOT_RETENTION_CODES.CAP_UNREACHABLE,
        detail: `清掉所有能清的之后用量仍是 ${projected} 字节，超过上限 ${byteLimit}——`
          + '剩下的都被进行中的 Run 引用着。'
          + '**如实报出来**，而不是继续删：一个"上限达到了"的报表与一个"上限其实没达到"的报表，'
          + '在只看有没有 finding 的人眼里是同一个东西',
      }))
    }
  }

  for (const e of ordered) if (!doomed.has(e.attemptId)) keep.push(Object.freeze({ ...e }))

  return Object.freeze({
    version: SNAPSHOT_RETENTION_VERSION,
    purge: Object.freeze(purge),
    keep: Object.freeze(keep),
    findings: Object.freeze(findings),
    usage: Object.freeze({
      bytes: totalBytes,
      count: sized.length,
      purgeBytes: purge.reduce((a, e) => a + e.bytes, 0),
      purgeCount: purge.length,
      pinnedCount: pinned.size,
    }),
    cap: Object.freeze({
      maxBytes: byteLimit, maxAgeDays: Number.isFinite(policyObj.maxAgeDays) ? policyObj.maxAgeDays : null,
    }),
  })
}

/**
 * 台账自检：默认策略必须是**显式**的，且"不设上限"必须能被表达。
 *
 * 与 `assertRetentionBounded` 同样的形状——留下算出来的值，不是一个 `ok` 布尔。
 */
export function assertSnapshotRetentionExplicit(policy = DEFAULT_SNAPSHOT_RETENTION) {
  const problems = []
  for (const key of ['maxAgeDays', 'maxBytes']) {
    if (!Object.hasOwn(policy, key)) {
      problems.push(`默认策略缺少 ${key}：不设上限必须**显式写 null**，缺席与故意不设不可区分`)
    }
  }
  if (policy.maxAgeDays !== null && !(Number.isInteger(policy.maxAgeDays) && policy.maxAgeDays > 0)) {
    problems.push(`maxAgeDays 只能是正整数或显式 null，收到 ${JSON.stringify(policy.maxAgeDays)}`)
  }
  if (policy.maxBytes !== null && !(Number.isInteger(policy.maxBytes) && policy.maxBytes > 0)) {
    problems.push(`maxBytes 只能是正整数或显式 null，收到 ${JSON.stringify(policy.maxBytes)}`)
  }
  return Object.freeze({
    ok: problems.length === 0,
    problems: Object.freeze(problems),
    version: SNAPSHOT_RETENTION_VERSION,
    classId: SNAPSHOT_CLASS_ID,
    defaults: Object.freeze({ maxAgeDays: policy.maxAgeDays, maxBytes: policy.maxBytes }),
    // "默认不清任何东西"是这个模块最重要的一条性质，所以它要被算出来、被断言，
    // 而不是只写在注释里。
    deletesNothingByDefault: policy.maxAgeDays === null && policy.maxBytes === null,
  })
}

export const SNAPSHOT_RETENTION_CHECKED = assertSnapshotRetentionExplicit()
