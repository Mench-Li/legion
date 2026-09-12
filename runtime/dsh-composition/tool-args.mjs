// runtime/dsh-composition/tool-args.mjs
// ============================================================================
// PRT-613：审批、UI、审计与执行看到**同一份**不可变工具参数
//
// spec §6.5 line 468：
//   「审批绑定不可变 `ToolExecution` 参数的 canonical operation 哈希；
//     DSH `tools/pre-execute` **不允许改写工具参数**，因为审计、UI 和实际执行
//     必须看到相同输入。Legion 如需改变参数，只能**拒绝当前调用**并要求模型或
//     工具定义产生一个新的 Tool Call，**不能在审批后静默改写**。」
//
// spec line 935：「保证审批、UI、审计与执行看到同一不可变工具参数，禁止 pre-execute 改写。」
//
// ---------------------------------------------------------------------------
// 为什么"四个面都同意"这句话自己证明不了自己
//
// 最容易写出来的实现是这样：冻结时算一个哈希，四个观察面各自**按自己的副本重算**
// 一遍哈希，相等就通过。它在被改写时**照样通过**——因为那个"自己的副本"已经是被
// 改写过的样子了，重算出来的哈希当然与它自己一致。
//
//   > 一个「每个观察面各自按自己的副本重算哈希、再比哈希」的校验，
//   > 与一个「从不校验」的校验，在「pre-execute 到底能不能改写参数」上是同一个东西——
//   > 只不过前者会打印一行"四个面一致"。
//
// 所以身份必须**随体携带**：冻结的那一刻算一次，之后所有观察面读到的都是
// **携带的那个值**，没有任何一个面有机会"按自己的副本重新证明自己"。
// 而改写检测是**唯一**一处重算的地方，它拿重算值去比携带值——方向固定。
//
// ---------------------------------------------------------------------------
// 另外三条同样安静的失效
//
// **① 浅冻结。** `Object.freeze({arguments:{path:'a'}})` 冻不住 `path`。
// 而"哪个文件被写"恰恰在第二层。
//
//   > 一个只冻结了最外层的"不可变"参数，
//   > 与一个「内层随时可以被悄悄改掉」的参数，是同一个东西——
//   > 只不过前者会通过 `Object.isFrozen()` 的检查。
//
// **② 绑定到 UI 文案。** UI 需要一句给人看的摘要。若审批绑定的是摘要，
// 那么摘要相同的两次不同调用会共用一次批准。
//
//   > 一个「绑定到 UI 文案」的审批，与一个「绑定到参数摘要」的审批，
//   > 是同一个东西——只不过前者让参数在文案相同的所有位置自由变化。
//
// **③ 改写时"重试一次"而不是拒绝。** spec 明说只能**拒绝当前调用**并要求产生
// 一个新的 Tool Call。一个"用新参数重新走一遍审批"的自动补救，与静默改写
// 在"用户批的是不是被执行的那次"上是同一个东西。
// ============================================================================

import { createHash } from 'node:crypto'

import { canonicalJson, nfc } from '../contracts/canonical.mjs'

export const TOOL_ARGS_VERSION = 'legion/tool-args@1'

/** 必须看到同一份参数的四个面。顺序固定，便于诊断输出稳定。 */
export const OBSERVATION_SURFACES = Object.freeze(['approval', 'ui', 'audit', 'execution'])

export const ARG_FREEZE_CODES = Object.freeze({
  REWRITTEN: 'tool-args-rewritten',
  SURFACE_MISMATCH: 'tool-args-surface-mismatch',
  NOT_DEEP_FROZEN: 'tool-args-not-deep-frozen',
  BOUND_TO_SUMMARY: 'tool-args-bound-to-summary',
  NOT_FROZEN_BODY: 'tool-args-not-a-frozen-body',
})

/** 参与身份的参数最大嵌套深度。超过就抛：不猜。 */
export const MAX_ARG_DEPTH = 32

/**
 * 深冻结。**递归**，不是 `Object.freeze` 一层。
 *
 * 只冻一层时 `Object.isFrozen(body)` 是 `true`，看起来"不可变"——
 * 而 `body.arguments.path = '/etc/passwd'` 照样成功，且**哪个文件被写**恰恰
 * 就在第二层。
 *
 *   > 一个只冻结了最外层的"不可变"参数，
 *   > 与一个「内层随时可以被悄悄改掉」的参数，是同一个东西——
 *   > 只不过前者会通过 `Object.isFrozen()` 的检查。
 *
 * 循环引用直接抛：一个自引用的参数既无法规范化，也无法证明它不可变。
 */
export function deepFreeze(value, depth = 0) {
  if (depth > MAX_ARG_DEPTH) {
    throw new Error(`工具参数嵌套超过 ${MAX_ARG_DEPTH} 层——不猜它的身份，直接拒绝`)
  }
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key], depth + 1)
  return value
}

/** 深冻结自检：**逐层**确认，而不是只看最外层。 */
export function assertDeepFrozen(value, path = '', depth = 0) {
  if (depth > MAX_ARG_DEPTH) throw new Error(`工具参数嵌套超过 ${MAX_ARG_DEPTH} 层`)
  if (value === null || typeof value !== 'object') return Object.freeze({ frozenPaths: Object.freeze([path || '<root>']) })
  const children = Object.keys(value).map((k) => assertDeepFrozen(value[k], path === '' ? k : `${path}.${k}`, depth + 1))
  if (!Object.isFrozen(value)) {
    throw new Error(
      `内部错误（PRT-613）：工具参数的 \`${path || '<root>'}\` 没有被冻结——`
      + '浅冻结在 `Object.isFrozen()` 上看不出来，而"哪个文件被写"在第二层',
    )
  }
  return Object.freeze({ frozenPaths: Object.freeze(children.flatMap((c) => c.frozenPaths)) })
}

/**
 * 参数的 canonical 文本与哈希。
 *
 * ★ `toolName` **必须**进哈希。F-02 的授权主体里本来就有 `toolName`
 * （`CANONICAL_OP_KEYS`），而本函数第一版只哈希了 `args` —— 于是
 * `file_write` 与 `file_delete` 在参数相同时得到**同一个身份**，
 * 一次"写文件"的批准会覆盖一次"删文件"。
 *
 *   > 一个「只把参数算进身份、没把工具名算进去」的哈希，
 *   > 与一个「同一个参数在任意工具下都算同一次操作」的哈希，是同一个东西——
 *   > 而它的方向是**放行**。
 *
 * 这正是本批的用例抓出来的（`⑤ 不同 toolName 是不同身份`）。
 * `canonicalJson` 来自共享基础库（键排序、NFC、`-0`→`0`、`undefined` 键省略），
 * 因此"同一个参数对象换一种写法"得到同一个身份。
 */
export function hashToolArguments(options) {
  // `= {}` 的默认值只对 `undefined` 生效，`null` 会直接解构出错——抛出的是
  // `Cannot destructure property 'toolName' of … as it is null`，
  // 与"工具名是空的"是同一个条件，却给出一句与工具名毫无关系的报错。
  //
  //   > 一个「同一个条件报出两种毫无关系的错误」的校验，
  //   > 与一个「排查时要先猜是哪种空」的校验，是同一个东西。
  const { toolName, args } = options ?? {}
  const name = nfc(String(toolName ?? '')).trim()
  if (name === '') throw new Error('hashToolArguments 需要非空 toolName（工具名是参数身份的一部分）')
  const text = canonicalJson(args)
  return Object.freeze({
    canonicalText: text,
    canonicalHash: `sha256:${createHash('sha256')
      .update(`${TOOL_ARGS_VERSION}\u0000${name}\u0000${text}`)
      .digest('hex')}`,
  })
}

/**
 * 冻一次参数，得到**冻结体**。
 *
 * 冻结体是四个观察面唯一的信息来源。它携带：
 *   · `arguments`   —— 深冻结的参数（**唯一副本**）
 *   · `canonicalText` / `canonicalHash` —— 冻结那一刻算出的身份
 *   · `identityOf`  —— 身份是**携带**的，不是各面重算的（见文件头）
 *
 * `summary` 是给人看的摘要，**只**挂在冻结体上供 UI 渲染。
 * 它不参与身份，也**不能**被当作身份使用（见 `assertNotBoundToSummary`）。
 */
export function freezeToolArguments({ toolName, args, summary = null, frozenAtMs = null } = {}) {
  const name = nfc(String(toolName ?? '')).trim()
  if (name === '') throw new Error('freezeToolArguments 需要非空 toolName')
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('freezeToolArguments 需要 args（一个对象）')
  }
  // 先按值算身份，再冻结。反过来的话冻结体会被写进哈希之后又被"规范化"改变。
  const frozenArgs = deepFreeze(structuredClone(args))
  const { canonicalText, canonicalHash } = hashToolArguments({ toolName: name, args: frozenArgs })
  assertDeepFrozen(frozenArgs)
  const body = {
    toolName: name,
    arguments: frozenArgs,
    canonicalText,
    canonicalHash,
    summary: summary === null ? null : String(summary),
    frozenAtMs: frozenAtMs === null ? null : Number(frozenAtMs),
  }
  return Object.freeze(body)
}

function assertFrozenBody(frozen) {
  if (frozen === null || typeof frozen !== 'object'
    || typeof frozen.canonicalHash !== 'string' || typeof frozen.canonicalText !== 'string'
    || frozen.arguments === null || typeof frozen.arguments !== 'object') {
    throw new Error(
      `内部错误（PRT-613）：这不是一个冻结体（需要 arguments / canonicalText / canonicalHash）——`
      + '让观察面各自去"构造一个看起来像冻结体的东西"，等于把身份交给每个面自己决定',
    )
  }
  return frozen
}

/**
 * 某个观察面看到的东西。
 *
 * ★ 返回的 `canonicalHash` / `canonicalText` 是**携带的那个值**，不是重算的。
 * 这正是 PRT-613 的全部机制：没有任何一个面有机会"按自己的副本重新证明自己"。
 *
 * 返回值是叶字段构成的小对象，**不含** `frozen.arguments` 的引用之外的东西——
 * 四个面拿到的是同一个 `arguments` 对象（同一个引用），不是四份拷贝。
 */
export function observe({ frozen, surface } = {}) {
  const body = assertFrozenBody(frozen)
  const s = String(surface ?? '')
  if (!OBSERVATION_SURFACES.includes(s)) {
    throw new Error(`未知的观察面 ${JSON.stringify(surface)}（合法值：${OBSERVATION_SURFACES.join(' / ')}）`)
  }
  return Object.freeze({
    surface: s,
    toolName: body.toolName,
    // 同一个引用：四个面看到的是同一份参数，不是四份内容相同的副本
    arguments: body.arguments,
    canonicalText: body.canonicalText,
    canonicalHash: body.canonicalHash,
    // UI 用；**不参与**身份（`assertNotBoundToSummary` 守这件事）
    summary: body.summary,
  })
}

/**
 * 四个面必须看到同一份身份。
 *
 * 拿的是 `observe` 的返回值——它们携带同一个哈希。这条断言的价值在于：
 * 若有人把 `observe` 改成"按自己的副本重算"，那么当某个面的副本被改过时，
 * 它会重算出**与冻结体不同**的值，这条就会红。
 */
export function assertSameAcrossSurfaces({ frozen, surfaces = OBSERVATION_SURFACES, observeOf = observe } = {}) {
  const body = assertFrozenBody(frozen)
  const seen = surfaces.map((s) => observeOf({ frozen: body, surface: s }))
  const hashes = [...new Set(seen.map((v) => v.canonicalHash))]
  const texts = [...new Set(seen.map((v) => v.canonicalText))]
  const sameReference = seen.every((v) => v.arguments === body.arguments)
  if (hashes.length !== 1 || texts.length !== 1 || !sameReference) {
    throw new Error(
      `内部错误（PRT-613）：观察面之间看到的参数不是同一份——`
      + `哈希集合 ${JSON.stringify(hashes)}，文本集合 ${JSON.stringify(texts)}，同一引用=${sameReference}。`
      + '审计、UI、审批与执行看到的必须是相同输入（spec §6.5 line 468）',
    )
  }
  return Object.freeze({
    canonicalHash: hashes[0],
    canonicalText: texts[0],
    sameReference,
    surfaces: Object.freeze(seen.map((v) => v.surface)),
  })
}

/**
 * 把一次观察**序列化**出去（跨进程 / HTTP / 落库时的样子）。
 *
 * 这一步才让"身份是**携带**的"这件事可观测。
 *
 * 为什么进程内看不出区别：冻结体的 `arguments` 是深冻结的，任何一面按它重算
 * 都必然得到同一个哈希——重算与携带在进程内**恒等**。本仓库的破坏性验证实测
 * 证实了这一点：把 `observe` 改成"按 `body.arguments` 重算"，一处都没红。
 *
 *   > 一个「在进程内比较携带值与重算值」的校验，
 *   > 与一个恒真的校验，在「跨进程之后还对不对得上」上是同一个东西——
 *   > 因为进程内根本没有第二种可能。
 *
 * 真正的风险在边界上：观察面拿到的是**它自己那份副本**（反序列化之后的）。
 * 若它"按自己的副本重算"，重算值当然与它自己一致——复核永远通过，
 * 而参数可能已经被换过了。`assertObservationFaithful` 就是那条复核。
 */
export function serializeObservation(observation) {
  if (observation === null || typeof observation !== 'object'
    || typeof observation.canonicalHash !== 'string') {
    throw new Error('serializeObservation 需要一次观察的结果（含 canonicalHash）')
  }
  return JSON.parse(JSON.stringify({
    surface: observation.surface,
    toolName: observation.toolName,
    arguments: observation.arguments,
    canonicalText: observation.canonicalText,
    canonicalHash: observation.canonicalHash,
    summary: observation.summary ?? null,
  }))
}

/**
 * 复核一份**反序列化后**的观察确实属于那个冻结体。
 *
 * 判据方向固定：用**携带的**哈希去比**冻结体**的哈希，再用参数重算比冻结体。
 * 若写成"用这份观察自己的参数重算，再与它自己携带的哈希比"，一份被篡改过的观察
 * 也能自证清白：
 *
 *   > 一个「用被检查对象自己的数据去证明被检查对象」的复核，
 *   > 与一个恒真的复核，是同一个东西。
 *
 * 最后那一步（重算参数）抓的是最坏的一种形状：**哈希对、参数被换过**——
 * 所有哈希比对都会通过，而执行的是另一份参数。
 */
export function assertObservationFaithful({ frozen, observation, hashOf = hashToolArguments } = {}) {
  const body = assertFrozenBody(frozen)
  if (observation === null || typeof observation !== 'object') {
    throw new Error('assertObservationFaithful 需要一份观察')
  }
  if (observation.canonicalHash !== body.canonicalHash) {
    throw new Error(
      `观察面携带的身份与冻结体不一致（${ARG_FREEZE_CODES.SURFACE_MISMATCH}）：`
      + `观察携带 ${observation.canonicalHash}，冻结体是 ${body.canonicalHash}`,
    )
  }
  if (observation.canonicalText !== body.canonicalText) {
    throw new Error(
      `观察面携带的 canonical 文本与冻结体不一致（${ARG_FREEZE_CODES.SURFACE_MISMATCH}）`,
    )
  }
  const own = hashOf({ toolName: body.toolName, args: observation.arguments })
  if (own.canonicalHash !== body.canonicalHash) {
    throw new Error(
      `观察面携带的**参数**与冻结体不一致（${ARG_FREEZE_CODES.SURFACE_MISMATCH}）：`
      + `同一份携带哈希之下，参数重算得 ${own.canonicalHash}。`
      + '这正是"哈希对、参数被换过"的形状——所有哈希比对都会通过，而执行的是另一份参数',
    )
  }
  return Object.freeze({ faithful: true, surface: observation.surface, canonicalHash: body.canonicalHash })
}

/**
 * 被观察的东西**是不是**冻结体携带的那一份。
 *
 * 这是**唯一**一处重算哈希的地方，而且方向固定：重算 candidate，比携带值。
 *
 * 反过来写（两边都从 candidate 算）会永远相等：
 *
 *   > 一个「两边都按同一个副本算哈希」的改写检测，
 *   > 与一个「恒真」的改写检测，是同一个东西。
 *
 * `hashOf` 可注入，让"两边都重算"这件事能被**真的构造出来**：正确实现下
 * 这份不一致永远为假，那段断言永远不触发。
 */
export function assertNotRewritten({ frozen, candidate, hashOf = hashToolArguments } = {}) {
  const body = assertFrozenBody(frozen)
  const recomputed = hashOf({ toolName: body.toolName, args: candidate ?? body.arguments })
  if (recomputed.canonicalHash !== body.canonicalHash) {
    throw new Error(
      `工具参数被改写了（${ARG_FREEZE_CODES.REWRITTEN}）：`
      + `冻结时的身份是 ${body.canonicalHash}，现在算出来的是 ${recomputed.canonicalHash}。`
      + 'spec §6.5：Legion 如需改变参数，只能**拒绝当前调用**并要求模型或工具定义'
      + '产生一个新的 Tool Call，**不能在审批后静默改写**',
    )
  }
  if (recomputed.canonicalText !== body.canonicalText) {
    throw new Error(
      `工具参数的 canonical 文本被改写（${ARG_FREEZE_CODES.REWRITTEN}）：`
      + '哈希相同但文本不同，说明规范化过程本身不稳定',
    )
  }
  return Object.freeze({ unchanged: true, canonicalHash: body.canonicalHash, code: null })
}

/**
 * 审批**不能**绑定到 UI 摘要上。
 *
 *   > 一个「绑定到 UI 文案」的审批，与一个「绑定到参数摘要」的审批，
 *   > 是同一个东西——只不过前者让参数在文案相同的所有位置自由变化。
 *
 * `boundHashOf` 可注入：正确实现下这件事永远为假，那段断言永远不触发。
 */
export function assertNotBoundToSummary({ frozen, boundHash = null, boundText = null, summaryHash = null } = {}) {
  const body = assertFrozenBody(frozen)
  const summary = body.summary
  // ⚠️ 顺序有讲究：**先**查"绑定到摘要"这两条**具体**的诊断，再查通用的"不是参数身份"。
  //
  // 反过来的话，绑定摘要哈希的情形会先撞上通用检查、抛一句"绑定的不是参数身份"，
  // 于下面第二条**永远不可达**——而它才是能让人立刻看出"你把 UI 文案当身份了"的那一条。
  //
  //   > 一个被前一道更宽的判断挡住的、更具体的诊断，
  //   > 与一个不存在的诊断，在「值班的人能不能看出是哪一种错」上是同一个东西。
  //
  // 本仓库在 PRT-613 的用例里实测踩到过：`boundHash: summaryHash` 报的是通用那条。
  if (summary !== null) {
    if (boundText !== null && boundText === summary && boundText !== body.canonicalText) {
      throw new Error(
        `审批绑定的是一句 UI 文案（${ARG_FREEZE_CODES.BOUND_TO_SUMMARY}）：`
        + `${JSON.stringify(boundText)}。摘要相同的两次**不同**调用会共用这一次批准`,
      )
    }
    if (boundHash !== null && summaryHash !== null && boundHash === summaryHash) {
      throw new Error(
        `审批绑定到的是摘要的哈希（${ARG_FREEZE_CODES.BOUND_TO_SUMMARY}）——`
        + '摘要相同即视为同一个操作，等于不绑定参数',
      )
    }
  }
  if (boundHash !== null && boundHash !== body.canonicalHash) {
    throw new Error(
      `审批绑定的不是参数身份（${ARG_FREEZE_CODES.BOUND_TO_SUMMARY}）：`
      + `绑定值 ${boundHash} 与参数哈希 ${body.canonicalHash} 不同`,
    )
  }
  return Object.freeze({ ok: true, canonicalHash: body.canonicalHash, summaryParticipates: false })
}

/**
 * pre-execute 的返回值只能用**冻结体**，不能带一份自己的参数。
 *
 * spec 明说 pre-execute **不允许改写工具参数**。一个"返回了新的 execution"
 * 的实现必须有两条路之一：同哈希放行，或**拒绝当前调用**。
 * "用新参数自动重走审批"不在其中——它与静默改写在"用户批的是不是被执行的那次"
 * 上是同一个东西。
 */
export function resolvePreExecuteResult({ frozen, proposed } = {}) {
  const body = assertFrozenBody(frozen)
  if (proposed === undefined || proposed === null) {
    return Object.freeze({ kind: 'unchanged', arguments: body.arguments, canonicalHash: body.canonicalHash })
  }
  // 先比身份。**不**比对象引用，也比不了：一次 JSON 往返就会换掉引用。
  const verdict = assertNotRewritten({ frozen: body, candidate: proposed })
  return Object.freeze({ kind: 'unchanged', arguments: body.arguments, canonicalHash: verdict.canonicalHash })
}

// ---------------------------------------------------------------- 装载时自检

/**
 * 自检：`observe` 必须**携带**身份，而不是各面重算。
 *
 * 做法：拿一个冻结体，人为构造"某个面的副本被改过"的情形——
 * 若 `observe` 是按传入对象重算的，它就会算出与冻结体不同的哈希。
 * 正确实现下这条**永远为假**，所以 `observeOf` 可注入，
 * 让"重算式实现"能被真的构造出来。
 *
 *   > 一段永远不会触发的断言，与一段不存在的断言，
 *   > 在「它到底拦不拦得住」上是同一个东西。
 */
export function assertIdentityIsCarried({ frozen, observeOf = observe, hashOf = hashToolArguments } = {}) {
  const body = assertFrozenBody(frozen)
  const perSurface = OBSERVATION_SURFACES.map((s) => {
    const seen = observeOf({ frozen: body, surface: s })
    // 这个面**自己**重算会得到什么（用于比对：它是否等于它携带的值）
    const own = hashOf({ toolName: body.toolName, args: seen.arguments ?? body.arguments })
    return Object.freeze({
      surface: s,
      carried: seen.canonicalHash,
      recomputedFromItsOwnCopy: own.canonicalHash,
      carriedMatchesOwnCopy: seen.canonicalHash === own.canonicalHash,
    })
  })
  const recomputers = perSurface.filter((p) => !p.carriedMatchesOwnCopy)
  const inconsistent = perSurface.filter((p) => p.carried !== body.canonicalHash)
  return Object.freeze({
    frozenHash: body.canonicalHash,
    perSurface: Object.freeze(perSurface),
    // 一个"按自己副本重算"的 observe 会在副本被改过时把 carried 变成重算值，
    // 于是 carried 不再等于 frozenHash
    inconsistentSurfaces: Object.freeze(inconsistent.map((p) => p.surface)),
    // 这条抓的是更细的一层：observe 报的哈希与它自己那份副本算出的不一致
    // （正常情况下两者相等；不相等说明 observe 报的是别处的值）
    recomputingSurfaces: Object.freeze(recomputers.map((p) => p.surface)),
  })
}

export function assertIdentityCarried(evidence = assertIdentityIsCarried({ frozen: SAMPLE_FROZEN })) {
  if (evidence.inconsistentSurfaces.length > 0) {
    throw new Error(
      `内部错误（PRT-613）：观察面 ${evidence.inconsistentSurfaces.join('、')} 报出的哈希`
      + `与冻结体携带的 ${evidence.frozenHash} 不一致——身份没有被携带，而是各面各算`,
    )
  }
  return evidence
}

const SAMPLE_FROZEN = freezeToolArguments({
  toolName: 'file_write',
  args: { path: '/w/sample.txt', mode: 'w', nested: { deep: { value: 1 } } },
  summary: '写入 /w/sample.txt',
  frozenAtMs: 0,
})

// 装载即执行。导出的是**逐个面算出来的那一对哈希**（携带的 / 自己重算的），
// 不是一个布尔 ok。
export const TOOL_ARGS_CHECKED = Object.freeze({
  version: TOOL_ARGS_VERSION,
  surfaces: OBSERVATION_SURFACES,
  ...assertIdentityCarried(),
  sampleFrozenHash: SAMPLE_FROZEN.canonicalHash,
  // 深冻结的证据：**算出来的路径列表**，不是一个布尔值
  sampleFrozenPaths: assertDeepFrozen(SAMPLE_FROZEN.arguments).frozenPaths,
})
