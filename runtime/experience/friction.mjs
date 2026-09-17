// runtime/experience/friction.mjs
// ============================================================================
// F-18 经验图谱 / 摩擦学习（spec §4.4）：
//
//   「扩展任务、文件、技能、错误关系图；
//     纠正、拒绝、回滚和重复失败**先形成审核草稿**。」
//
// ---------------------------------------------------------------------------
// ★ 本模块与旧实现（`plugins/src/experience.ts`）最要紧的一处分歧
//
// 旧实现从**评论散文**里数信号——正则匹配"打回"、"退回："、"将军验收"、
// "缺失产出文档"这些中文短语，数出轮次再加权求和。
//
// 它有用例、也能跑，但它有一个致命性质：**它无法被证伪**。
// 有人把"打回"改写成"请修订"（或反过来），分数就变了；
// 而一个恰好因为措辞改动而变成 0 的摩擦分，与一个"这段时间确实没有摩擦"的
// 摩擦分，在报表上是同一个 0。
//
//   > 一个「从评论文本里数出来」的摩擦分，
//   > 与一个「因为有人改了措辞而变成 0」的摩擦分，是同一个东西——
//   > 只不过前者看起来在测量某样东西。
//
// 新架构里这些信号**本来就是结构化的**：拒绝是 `run_validations.decision`，
// 重做是同一个任务的第 2、3 次 attempt，结果是 `run_reconciliations`，
// 交接是 `run_handoffs`。所以本模块**只从结构化字段取值**，
// 并且有一条结构级用例钉住"这里不出现对文本做正则匹配"。
//
// ---------------------------------------------------------------------------
// ② ★ 缺失的输入是"不知道"，不是 0
//
// 这是 F-15 那条纪律在这一层的重演：每个数字都要有一个"不知道"的邻居。
//
// 调用方没传 `validations` 时，`rejected` **不能**是 0。因为 0 是一个**结论**
// （"这段时间没有任何一次拒绝"），而"我没拿到拒绝记录"是另一件事。
// 而且这个区分会一路影响总分：把缺失当 0 求和，会得到一个**看起来完全正常**
// 的低分——摩擦数据没到，报表却显示"一切顺利"。
//
//   > 一个「把没拿到的输入当 0」的摩擦分，
//   > 与一个「数据没到就报告"没有摩擦"」的摩擦分，是同一个东西。
//
// 所以：任何一维是"不知道"时，`complete: false`，而 `score` 是 `null`
// ——不是"已知那几维的和"。要一个部分分就得显式要（`partialScore`）。
//
// ---------------------------------------------------------------------------
// ③ 草稿**不是**知识
//
// 要求里写的是"**先形成审核草稿**"。这句话的全部重量在"审核"两个字上：
// 一个自动生效的"经验"，与一个把一次偶发失败永久写进规则的系统，是同一个东西
// ——而后者会在没人注意的时候开始让所有人都绕路。
//
// 所以草稿的生命周期是封闭的：`draft → promoted | discarded`，
// 而两个终点都需要一个**人**和一个**封闭词表里的理由**。
// 没有"自动晋升"这条路，也没有"随手删掉"这条路：
// 丢弃同样要写理由，因为"这条教训被谁按什么理由扔了"正是它消失的方式。
// ============================================================================

/** 形态版本。结构变了必须递增。 */
export const FRICTION_VERSION = 'legion/friction@1'

/**
 * 摩擦的维度，**封闭词表**。
 *
 * 每一项都对应新架构里一个真实存在的结构化字段（见文件头 ①）：
 *   · `rejected`       —— 验收被拒（`run_validations.decision`）
 *   · `rework`         —— 同一任务被重做（第 2 次及以后的 attempt）
 *   · `rollback`       —— 回滚（能力包账上的 `rollback` 记录）
 *   · `repeatFailure`  —— 同一任务连续失败（≥2 次失败 attempt）
 *   · `unknownOutcome` —— 结果不明、需要对账（`run_reconciliations`）
 *
 * ★ `handoff` **不在**这里：交接是流程的正常一环，不是摩擦。
 *   把正常步骤算进摩擦分，会让"这个流程本来就要经手三个人"读成"这个流程有问题"，
 *   而那会让人开始优化一个根本不需要优化的东西。
 */
export const FRICTION_DIMENSIONS = Object.freeze([
  'rejected', 'rework', 'rollback', 'repeatFailure', 'unknownOutcome',
])

/** 每一维的权重。改动会改变历史可比性，所以版本号要跟着动。 */
export const FRICTION_WEIGHTS = Object.freeze({
  rejected: 3,
  rework: 2,
  rollback: 4,
  repeatFailure: 5,
  unknownOutcome: 2,
})

/**
 * 单维上限。
 *
 * 没有上限时，一次"卡了 40 轮"会把总分压成"这个岗位一直很差"，
 * 而它可能只是一次环境故障；上限让"偶发但严重"与"长期系统性"分得开。
 */
export const FRICTION_CAPS = Object.freeze({
  rejected: 5,
  rework: 5,
  rollback: 3,
  repeatFailure: 5,
  unknownOutcome: 5,
})

/** 到了这个分就该出草稿。 */
export const FRICTION_DRAFT_MIN = 6

export const FRICTION_CODES = Object.freeze({
  /** 入参形状不合法。 */
  BAD_INPUT: 'friction-input-malformed',
  // ★ 这里**没有** `BAD_DIMENSION`。维度名是模块内部的封闭词表，
  //   调用方永远不传维度名，所以那个码不会有任何触发点。
  //   一个定义了却到不了的分支，与一段被注释掉的代码是同一个东西——
  //   只不过前者会让覆盖率看起来更高。（用例 ⑤ 就是这么发现它的。）
  /** 要部分分时不带 `allowPartial` —— 见文件头 ②。 */
  INCOMPLETE: 'friction-incomplete',
  /** 草稿缺必要字段。 */
  BAD_DRAFT: 'friction-draft-malformed',
  /** 草稿状态迁移不合法（比如已经晋升过又晋升一次）。 */
  BAD_TRANSITION: 'friction-draft-transition',
  /** 晋升/丢弃的理由不在封闭词表里。 */
  BAD_REASON: 'friction-draft-reason-unknown',
  /** 晋升/丢弃没有署名的人。 */
  NO_ACTOR: 'friction-draft-no-actor',
})

/**
 * 理由的**封闭词表**。
 *
 * 不接自由文本：自由文本的理由在三个月后无法聚合，于是
 * "这类问题一共发生过几次"永远回答不了——而那正是把草稿留下来的目的。
 *
 *   > 一个「理由写成自由文本」的审核记录，
 *   > 与一个「每次都是不同的人用不同的话说同一件事」的记录，是同一个东西——
 *   > 只不过前者看起来写了理由。
 */
export const PROMOTE_REASONS = Object.freeze([
  'recurring',        // 反复出现，值得固化成规则
  'high-impact',      // 只发生一次但代价很大
  'safety',           // 涉及安全/凭证/数据丢失
  'verified-by-human', // 人工复核确认了因果
])

export const DISCARD_REASONS = Object.freeze([
  'one-off',        // 偶发，没有复现
  'already-known',  // 已有规则覆盖
  'environmental',  // 环境/基础设施问题，不是流程问题
  'not-actionable', // 无法转成可执行的动作
])

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 一维的计数。
 *
 * 返回 `{ count, known }`：`known:false` 表示**调用方没给这一维的数据**，
 * 而 `count` 此时是 `null`（不是 0）。
 *
 * ★ `match` 是这一维的**判据**，不是可选的。
 *   第一版写成"`validations` 有几条就记几次拒绝"，于是这个维度实际测量的是
 *   「验收事件发生了多少次」——一个任务被验收 10 次就报 10 次拒绝，
 *   哪怕 10 次全是通过。用例当场把它抓出来了（"换个评论文本分数该一样"
 *   那条看起来在查散文，其实先撞上的是这里）。
 *   所以计数与判据放在一起：**一个只数长度、不看内容的计数，
 *   与一个数错东西的计数，在报表上是同一个数。**
 */
function dimension({ value, what, match = null }) {
  if (value === undefined || value === null) return { count: null, known: false }
  if (!Array.isArray(value)) {
    throw fail(FRICTION_CODES.BAD_INPUT, `${what} 必须是数组（收到 ${typeof value}）`)
  }
  if (match === null) return { count: value.length, known: true }
  for (const item of value) {
    if (!isPlainObject(item)) {
      throw fail(FRICTION_CODES.BAD_INPUT, `${what} 里每一项都必须是一个对象`)
    }
  }
  return { count: value.filter(match).length, known: true }
}

/**
 * 从**结构化事实**里收摩擦信号。
 *
 * 每个入参都是"这段时间内发生的那些行"：
 *   · `validations`     —— 验收记录，`decision === 'rejected'` 计一次拒绝
 *   · `attempts`        —— 尝试记录，`{ taskId, state }`；按 taskId 数重做与连续失败
 *   · `rollbacks`       —— 回滚记录（数组，长度即次数）
 *   · `reconciliations` —— 对账记录（结果不明）
 *
 * ★ 每个入参**都可以不给**，而不给就是 `known:false`（见文件头 ②）。
 *   这个区分一路传到 `score`：任何一维不知道 ⇒ `score` 是 `null`。
 */
export function collectFriction({ validations, attempts, rollbacks, reconciliations } = {}) {
  // ★ `validations` 这一维的判据是 `decision === 'rejected'`——
  //   只数长度会把"验收发生在几次"记成"被拒了几次"。
  //   认不出的 decision（上游词表变了）一律**不算**拒绝：把未知读成"没问题"
  //   与把未知读成"有问题"都是在猜，而这里选择不猜。
  const rejected = dimension({
    value: validations,
    what: 'validations',
    match: (v) => String(v.decision ?? '').trim() === 'rejected',
  })
  const rollback = dimension({ value: rollbacks, what: 'rollbacks' })
  const unknownOutcome = dimension({ value: reconciliations, what: 'reconciliations' })

  // 重做与连续失败都从 `attempts` 推，但它们**不是**同一个数：
  // 重做是"同一任务尝试了不止一次"，连续失败是"其中至少两次是失败"。
  let rework = { count: null, known: false }
  let repeatFailure = { count: null, known: false }
  if (attempts !== undefined && attempts !== null) {
    if (!Array.isArray(attempts)) {
      throw fail(FRICTION_CODES.BAD_INPUT, `attempts 必须是数组（收到 ${typeof attempts}）`)
    }
    const byTask = new Map()
    for (const a of attempts) {
      if (!isPlainObject(a)) {
        throw fail(FRICTION_CODES.BAD_INPUT, 'attempts 里每一项都必须是一个对象')
      }
      const id = String(a.taskId ?? '').trim()
      // ★ 没有 taskId 的尝试**不静默归到一个"未知任务"桶**里：
      //   那会把"三条不同任务的失败"读成"同一个任务失败了三次"，
      //   于是一个偶发问题被报成系统性问题。
      if (id === '') {
        throw fail(
          FRICTION_CODES.BAD_INPUT,
          'attempts 里有一项没有 taskId。**不能**把它归进一个"未知任务"桶：' +
          '那会把"三条不同任务的失败"读成"同一个任务失败了三次"——' +
          '一个偶发问题被报成系统性问题',
        )
      }
      if (!byTask.has(id)) byTask.set(id, [])
      byTask.get(id).push(a)
    }
    let reworkCount = 0
    let repeatCount = 0
    for (const [, list] of byTask) {
      // 重做：同一任务出现第 2 次及以后，每一次算一次。
      if (list.length > 1) reworkCount += list.length - 1
      // 连续失败：这一个任务里失败的 attempt 有 ≥2 次。
      const failed = list.filter((a) => isFailureState(a.state)).length
      if (failed >= 2) repeatCount += failed - 1
    }
    rework = { count: reworkCount, known: true }
    repeatFailure = { count: repeatCount, known: true }
  }

  const raw = { rejected: rejected.count, rework: rework.count, rollback: rollback.count, repeatFailure: repeatFailure.count, unknownOutcome: unknownOutcome.count }
  const known = {
    rejected: rejected.known, rework: rework.known, rollback: rollback.known,
    repeatFailure: repeatFailure.known, unknownOutcome: unknownOutcome.known,
  }
  const unknownDimensions = FRICTION_DIMENSIONS.filter((d) => !known[d])

  // 逐维封顶。**封顶只作用于已知的那些**——不知道的那一维保持 `null`。
  const capped = {}
  for (const d of FRICTION_DIMENSIONS) {
    capped[d] = known[d] ? Math.min(raw[d], FRICTION_CAPS[d]) : null
  }

  return Object.freeze({
    version: FRICTION_VERSION,
    counts: Object.freeze(raw),
    capped: Object.freeze(capped),
    known: Object.freeze(known),
    unknownDimensions: Object.freeze(unknownDimensions),
    // ★ `complete` 是一个**独立的读数**：调用方不必自己去翻 unknownDimensions。
    complete: unknownDimensions.length === 0,
  })
}

/** 哪些 attempt 状态算"失败"。不在这张表里的状态一律**不算**失败。 */
const FAILURE_STATES = Object.freeze([
  'failed', 'RetryableFailure', 'DeadLetter', 'TimedOut', 'Cancelled',
])

function isFailureState(state) {
  return FAILURE_STATES.includes(String(state ?? '').trim())
}

/**
 * 摩擦分。
 *
 * ★ 默认**拒绝**在数据不完整时给分（见文件头 ②）：把已知那几维加起来
 *   会得到一个看起来完全正常的低分，而"数据没到"与"没有摩擦"在报表上是同一个数。
 *   要部分分必须显式传 `allowPartial: true`，且返回值里带着 `partial: true`，
 *   于是那个数字**走到哪里都带着自己的局限**。
 */
export function frictionScore(signals, { allowPartial = false } = {}) {
  if (!isPlainObject(signals) || !isPlainObject(signals.capped) || !isPlainObject(signals.known)) {
    throw fail(FRICTION_CODES.BAD_INPUT, 'frictionScore 需要 collectFriction 的返回值')
  }
  if (!signals.complete && !allowPartial) {
    throw fail(
      FRICTION_CODES.INCOMPLETE,
      `摩擦数据不完整（缺 ${JSON.stringify(signals.unknownDimensions)}），**不给分**。` +
      '把已知的那几维加起来会得到一个看起来完全正常的低分——' +
      '而"数据没到"与"这段时间没有摩擦"在报表上是同一个数。' +
      '确实要一个部分分就显式传 `{ allowPartial: true }`',
    )
  }
  let score = 0
  for (const d of FRICTION_DIMENSIONS) {
    const c = signals.capped[d]
    if (c === null) continue
    score += c * FRICTION_WEIGHTS[d]
  }
  return Object.freeze({
    score,
    complete: signals.complete,
    // ★ 部分分**带着自己的局限**走：调用方拿到的不是裸数字。
    partial: !signals.complete,
    missing: signals.unknownDimensions,
  })
}

/** 到阈值就该出草稿。数据不完整时**不出**——理由见文件头 ②。 */
export function shouldDraft(signals) {
  if (!isPlainObject(signals) || typeof signals.complete !== 'boolean') {
    throw fail(FRICTION_CODES.BAD_INPUT, 'shouldDraft 需要 collectFriction 的返回值')
  }
  if (!signals.complete) return Object.freeze({ draft: false, reason: 'incomplete-data', score: null })
  const s = frictionScore(signals)
  return Object.freeze({
    draft: s.score >= FRICTION_DRAFT_MIN,
    reason: s.score >= FRICTION_DRAFT_MIN ? 'above-threshold' : 'below-threshold',
    score: s.score,
  })
}

/**
 * 造一份**审核草稿**。
 *
 * 草稿**不是**知识（见文件头 ③）：它的初始状态恒为 `'draft'`，
 * 而且本模块**没有**任何"自动晋升"的出口。
 */
export function buildDraft({ subject, signals, evidence = null, createdAtMs = null } = {}) {
  if (!isPlainObject(subject)) {
    throw fail(FRICTION_CODES.BAD_DRAFT, 'buildDraft 需要 subject（这条草稿是关于什么的）')
  }
  const kind = String(subject.kind ?? '').trim()
  const id = String(subject.id ?? '').trim()
  if (kind === '' || id === '') {
    throw fail(
      FRICTION_CODES.BAD_DRAFT,
      'subject 必须同时有 `kind` 与 `id`。缺一个时草稿会指向"某个东西"，' +
      '而一条指向"某个东西"的教训在被晋升之后没有任何地方能应用它',
    )
  }
  const s = frictionScore(signals)
  const top = FRICTION_DIMENSIONS
    .filter((d) => signals.capped[d] !== null && signals.capped[d] > 0)
    .map((d) => Object.freeze({ dimension: d, capped: signals.capped[d], weight: FRICTION_WEIGHTS[d] }))
    .sort((a, b) => b.capped * b.weight - a.capped * a.weight)

  return Object.freeze({
    version: FRICTION_VERSION,
    status: 'draft',
    subject: Object.freeze({ kind, id }),
    score: s.score,
    // 逐维读数留在草稿上：只有总分时，"这条教训在说什么"无从判断，
    // 而审阅的人要做的正是那个判断。
    dimensions: Object.freeze(top),
    counts: signals.counts,
    evidence: evidence === null ? null : Object.freeze({ ...evidence }),
    createdAtMs,
    // 留证：这份草稿的分数**从来不完整过**吗？审阅的人有权知道。
    complete: signals.complete,
    promotedBy: null,
    promotedReason: null,
    discardedBy: null,
    discardedReason: null,
  })
}

function assertActor(actor, what) {
  const a = String(actor ?? '').trim()
  if (a === '') {
    throw fail(
      FRICTION_CODES.NO_ACTOR,
      `${what}必须署名。不署名时"这条规则是谁加进去的"事后无从回答——` +
      '而一条找不到作者的规则，在被怀疑时只能整条删掉，没有人能替它说话',
    )
  }
  return a
}

/**
 * 晋升：`draft → promoted`。
 *
 * 这是草稿变成"能影响后续行为的东西"的**唯一**入口，而它要求三样：
 * 一个署名的人、一个封闭词表里的理由、以及草稿仍处于 `draft`。
 */
export function promoteDraft({ draft, by, reason, atMs = null, rule = null } = {}) {
  assertDraft(draft)
  if (draft.status !== 'draft') {
    throw fail(
      FRICTION_CODES.BAD_TRANSITION,
      `草稿已经是 \`${draft.status}\`，不能再次晋升。**一次草稿只有一个终点**：` +
      '一个可以被晋升两次的草稿，与一个"这条规则被两拨人分别加了两次"的系统，' +
      '是同一个东西——而第二次加的人以为自己在补一个缺口',
    )
  }
  const actor = assertActor(by, '晋升')
  if (!PROMOTE_REASONS.includes(reason)) {
    throw fail(
      FRICTION_CODES.BAD_REASON,
      `晋升理由 ${JSON.stringify(reason)} 不在封闭词表里（合法：${PROMOTE_REASONS.join(' / ')}）。` +
      '不接自由文本——自由文本的理由三个月后无法聚合，' +
      '而"这类问题一共发生过几次"正是把草稿留下来的目的',
    )
  }
  return Object.freeze({
    ...draft,
    status: 'promoted',
    promotedBy: actor,
    promotedReason: reason,
    promotedAtMs: atMs,
    rule: rule === null ? null : Object.freeze({ ...rule }),
  })
}

/**
 * 丢弃：`draft → discarded`。
 *
 * ★ 丢弃**同样**要署名与理由。看起来多余——扔掉一条不成熟的草稿有什么好记的？
 *   但"这条教训被谁按什么理由扔了"正是它消失的方式：
 *
 *   > 一个「可以随手丢掉的草稿」，
 *   > 与一个「真实的教训安静地消失、而没有任何地方留下痕迹」的系统，
 *   > 是同一个东西——只不过前者看起来在保持整洁。
 */
export function discardDraft({ draft, by, reason, atMs = null } = {}) {
  assertDraft(draft)
  if (draft.status !== 'draft') {
    throw fail(FRICTION_CODES.BAD_TRANSITION, `草稿已经是 \`${draft.status}\`，不能再次处置`)
  }
  const actor = assertActor(by, '丢弃')
  if (!DISCARD_REASONS.includes(reason)) {
    throw fail(
      FRICTION_CODES.BAD_REASON,
      `丢弃理由 ${JSON.stringify(reason)} 不在封闭词表里（合法：${DISCARD_REASONS.join(' / ')}）。` +
      '**丢弃也要写理由**：一条教训消失的方式，与它被写下来的方式同样值得留痕',
    )
  }
  return Object.freeze({
    ...draft,
    status: 'discarded',
    discardedBy: actor,
    discardedReason: reason,
    discardedAtMs: atMs,
  })
}

function assertDraft(draft) {
  if (!isPlainObject(draft) || draft.version !== FRICTION_VERSION) {
    throw fail(
      FRICTION_CODES.BAD_DRAFT,
      `不是一份 ${FRICTION_VERSION} 的草稿（收到 ${JSON.stringify(draft?.version)}）。` +
      '形态版本对不上时**不猜**：旧草稿按新规则读出来的字段含义可能已经不同',
    )
  }
  if (!['draft', 'promoted', 'discarded'].includes(draft.status)) {
    throw fail(FRICTION_CODES.BAD_DRAFT, `草稿状态 ${JSON.stringify(draft.status)} 不在封闭词表里`)
  }
}

/** 一批草稿的读数。用来回答"积压了多少条还没人看"。 */
export function draftBacklog(drafts) {
  if (!Array.isArray(drafts)) throw fail(FRICTION_CODES.BAD_INPUT, 'draftBacklog 需要数组')
  const by = { draft: 0, promoted: 0, discarded: 0 }
  for (const d of drafts) {
    assertDraft(d)
    by[d.status] += 1
  }
  return Object.freeze({
    ...by,
    total: drafts.length,
    // ★ 积压率只对"已经处置过的"有意义；一条都还没处置时它是 `null`
    //   而不是 0——0% 积压会被读成"流程很健康"。
    openRatio: by.draft + by.promoted + by.discarded === 0
      ? null
      : by.draft / (by.draft + by.promoted + by.discarded),
  })
}
