// ============================================================================
// F-02 权限内核（team-hub 侧策略核心）
//
// PRT-611 扩展了它的 canonical operation。在此之前，F-02 判"这次调用是不是我
// 批准的那一次"用的是 `JSON.stringify(a) === JSON.stringify(b)`。
// 它坏在两个**方向不同**的地方，而只有一个方向会有人来报 bug：
//
// **① 键的书写顺序被当成了操作身份的一部分。**
// `JSON.stringify` 按插入顺序输出；`{a,b}` 与 `{b,a}` 是**同一个对象**，
// 却得到不同的字符串。顶层因为 `normalizeOperation` 固定了字段顺序而侥幸没事，
// 但 `metadata` 是 `{ ...input.metadata }`——它的键序由调用方决定。
// 于是一次 `{path, mode}` 的批准，遇到 `{mode, path}` 的再次调用就会被拒。
//
//   > 一个把「键的书写顺序」当成「操作的身份」的一部分的审批绑定，
//   > 与一个"每次执行都要重新问一遍"的审批绑定，
//   > 在"用户会不会觉得这个审批按钮没用"上是同一个东西。
//
// 这个方向是**拒绝**，也就是 fail-closed。它不造成任何危险，所以没人为它报 bug
// ——这才是它值得写下来的原因。
//
// **② 规范化丢掉的字段，等于审批没有绑定到它。**
// 这个方向是**放行**，才是真正危险的那一个。`normalizeOperation` 收的是一组写死的
// 字段，任何新加的、没被列进去的字段都会被静默丢掉：审批绑定的于是成了
// "前若干个字段恰好相同"，而不是"这次操作相同"。
//
//   > 一个"忘了把新字段放进规范化集合"的哈希，
//   > 与一个"只绑定到前六个字段"的哈希，是同一个东西——
//   > 而它的方向是**放行**。
//
// 所以 PRT-611 做三件事：
//   ① 指纹用**规范化 JSON**（键排序、NFC、-0 归一）算，键序不再影响身份；
//   ② 指纹带 domain separator，与 DSH 侧的 `canonicalOperationHash`
//      **在构造上**不可互换（§6.5：「两者使用不同的 Schema 和 domain separator」）；
//   ③ 一条**加载时**自检：`OPERATION_KEYS` 必须与 `normalizeOperation` 真正产出的
//      字段**逐个对齐**。加字段却忘了同步名单，启动就崩。
//
// ---------------------------------------------------------------------------
// （补记）写下上面那段的当天，这份名单里**还没有** `toolName` / `callId`：
// spec line 470 明说授权主体含这两个键，而 `normalizeOperation` 根本没读它们。
// 于是"规范化丢掉的字段等于没绑定"这句话在它自己身上应验了，方向正是**放行**：
//
//     operationFingerprint({…同一份 scope/actor/action/target/taskId, toolName:'file_write'})
//   === operationFingerprint({…同一份,                                        toolName:'file_delete'})
//     → sha256:69969e47…（两个工具、同一个身份）
//
//   > 一个「键的名字没进名单」的字段，
//   > 与一个「审批从来没有绑定到它」的字段，是同一个东西——
//   > 只不过前者在代码里看起来是被规范化照顾过的。
//
// 所以补上三件事：`toolName` / `callId` 进名单；「不可变工具参数」用一个载体
// 字段 `argsHash` 收进指纹。参数身份**不在这里算**——它归 PRT-613 的
// `hashToolArguments` 所有（那个函数已经把工具名算了进去），本模块只负责搬运。
// 自己再实现一份参数哈希，与"两个模块对同一份参数给出两个身份"是同一个东西。
// ============================================================================

import { canonicalJson, domainSeparatedHash, nfc } from '../runtime/contracts/canonical.mjs'
// 参数身份归 PRT-613 所有，本模块**不**另算一份。`team-hub/` → `runtime/dsh-composition/`
// 是本仓库既有的方向（同一个方向上的还有 `team-hub/tool-call-log.mjs`）。
import { hashToolArguments } from '../runtime/dsh-composition/tool-args.mjs'

const MODES = new Set(['deny', 'ask', 'allow-once', 'allow-for-task', 'allow-by-policy'])
const REQUIRED = ['scope', 'actor', 'action', 'target']

/**
 * F-02 操作对象的**闭合**字段集合。授权判定与审批绑定都只看这些字段。
 *
 * 「闭合」是重点：这个名单之外的字段**不参与**审批身份，因此往里加字段
 * 而不改这个名单，等于让那个字段可以被随便改。加载时的自检就是为了拦这件事。
 */
export const OPERATION_KEYS = Object.freeze([
  'scope', 'actor', 'action', 'target', 'taskId', 'unattended', 'metadata',
  // spec line 470 的授权主体里还有这三个。它们**必须**在这里：`canonicalOperation`
  // 只取名单里的字段，漏一个就等于那个字段是"可以随便改的"。
  'toolName', 'callId', 'argsHash',
])

/** 申请批准时用的 domain。与 DSH 侧的 `CANONICAL_OP_DOMAIN` **不同**。 */
export const OPERATION_DOMAIN = 'legion.permission.operation.v1'

/**
 * canonical operation 的 schema 版本。
 *
 * **1 → 2**（PRT-611 补记）：授权主体新增 `toolName` / `callId` / `argsHash`，
 * canonical 形式**变了**，所以按 `runtime/dsh-composition/enforcement.mjs:39` 那条
 * "改变 canonical 形式必须递增它"的既有纪律递增。
 *
 * 递增的代价是**零**，这一点值得写下来——因为"要不要动版本号"通常会被当成一个有风险
 * 的取舍，然后被拖着不动：
 *
 *   · 加字段本身就已经改变了哈希（新键进了 canonical JSON），所以在途审批
 *     **无论递不递增都会失效**，方向是 fail-closed（重新批准），不是放行；
 *   · 这个常量**没有被持久化、也没有被跨版本比较过**（全仓只有 `operationFingerprint`
 *     一处消费它），所以递增不会让任何历史行变得无法解释。
 *
 * 不递增则会让两个**不同的** canonical 形式共用同一个版本号——而那正是版本号存在的理由：
 *
 *   > 一个「改了 canonical 形式却不动版本号」的实现，
 *   > 与一个「版本号已经回答不了'这行哈希是按哪种形式算的'」的实现，
 *   > 是同一个东西——只不过前者在代码审查里看起来是"改动最小"的那一个。
 */
export const OPERATION_SCHEMA_VERSION = 2

/**
 * 「不可变工具参数」在授权主体里的载体：`argsHash` 的值从哪里来。
 *
 * 参数身份**不是**本模块的事——它归 PRT-613 的 `hashToolArguments` 所有，
 * 那个函数已经把 `toolName` 算进了哈希（`file_write` 与 `file_delete` 在参数
 * 相同时是**两个**身份）。这里只做搬运。
 *
 *   > 一个「自己再实现一份参数哈希」的审批绑定，
 *   > 与一个「两个模块对同一份参数给出两个身份」的绑定，是同一个东西——
 *   > 只不过后者在任何**单侧**的用例里都是绿的。
 */
export function argsHashOf({ toolName, args } = {}) {
  return hashToolArguments({ toolName, args }).canonicalHash
}

/** 参数载体自检用的样本。 */
const SAMPLE_TOOL_ARGS = Object.freeze({
  toolName: 'file_write',
  args: { path: 'repo/notes.txt', mode: 'w' },
})

/**
 * 装载时算一次，留下的是**两个算出来的值**，不是一个布尔标记。
 *
 * `argsHash` 就是载体字段该被填成的东西；`otherToolNameArgsHash` 是换掉工具名
 * 之后的另一个值——"工具名确实是参数身份的一部分"这句话在本模块这边的证据。
 * `ok: true` 是随手就能写出来的字面量，而这两个哈希要伪造就得把参数哈希再实现一遍。
 */
export const TOOL_ARGS_BINDING_CHECKED = Object.freeze({
  toolName: SAMPLE_TOOL_ARGS.toolName,
  otherToolName: 'file_delete',
  argsHash: argsHashOf(SAMPLE_TOOL_ARGS),
  otherToolNameArgsHash: argsHashOf({ ...SAMPLE_TOOL_ARGS, toolName: 'file_delete' }),
})

/**
 * 工具授权主体的三个字段——**要么整套齐，要么整套不填**（见 `normalizeOperation`）。
 *
 * 作为一个导出常量而不是内联数组：`approval-binding.mjs` 与测试需要用**同一份**
 * 名单去问"这个主体是不是工具主体"，各抄一份的话，下一次加字段时两边会分叉。
 */
export const TOOL_SUBJECT_KEYS = Object.freeze(['toolName', 'callId', 'argsHash'])

export function normalizeOperation(input = {}) {
  const operation = {
    scope: String(input.scope ?? '').trim(),
    actor: String(input.actor ?? '').trim(),
    action: String(input.action ?? '').trim(),
    target: String(input.target ?? '').trim(),
    taskId: input.taskId == null ? null : String(input.taskId).trim() || null,
    unattended: input.unattended === true,
    metadata: input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? { ...input.metadata } : {},
    // 与 `taskId` 同一套纪律：没有就是 `null`（不是空串），有就 trim 掉空白。
    // 三个字段都是**可选**的——`skill:grant` 这类操作本来就没有工具，把它们塞进
    // `REQUIRED` 会把一次合法的无工具操作变成一次崩溃。
    toolName: input.toolName == null ? null : String(input.toolName).trim() || null,
    callId: input.callId == null ? null : String(input.callId).trim() || null,
    // 「不可变工具参数」的载体。值是 `argsHashOf` 算出来的那个字符串，
    // 这里只搬运与规范化，**不**重算（见文件头）。
    argsHash: input.argsHash == null ? null : String(input.argsHash).trim() || null,
  }
  for (const field of REQUIRED) if (!operation[field]) throw new Error(`${field} required`)
  return operation
}

/**
 * 收进 canonical operation：**只有** `OPERATION_KEYS` 里的字段参与，
 * 每个字符串过 NFC，可选字段补成规范默认值。
 *
 * 返回对象按 `OPERATION_KEYS` 的顺序构造。顺序本身不影响指纹
 * （`canonicalJson` 会排序），这样做只是为了让 `deepEqual` 与诊断输出稳定。
 */
export function canonicalOperation(operationInput = {}) {
  const operation = normalizeOperation(operationInput)
  const out = {}
  for (const key of OPERATION_KEYS) out[key] = operation[key]
  out.scope = nfc(out.scope)
  out.actor = nfc(out.actor)
  out.action = nfc(out.action)
  out.target = nfc(out.target)
  if (out.taskId !== null) out.taskId = nfc(out.taskId)
  if (out.toolName !== null) out.toolName = nfc(out.toolName)
  if (out.callId !== null) out.callId = nfc(out.callId)
  if (out.argsHash !== null) out.argsHash = nfc(out.argsHash)
  return Object.freeze(out)
}

/**
 * 一次 F-02 操作的指纹：`sha256(domain \u0000 schemaVersion \u0000 canonicalJson(op))`。
 *
 * 键序无关（`canonicalJson` 排序）、`-0` 与 `0` 同值、组合字符与预组合字符同字
 * （NFC）。因此"同一个操作"在任何书写方式下都得到同一个指纹。
 */
export function operationFingerprint(operationInput = {}) {
  return domainSeparatedHash(OPERATION_DOMAIN, OPERATION_SCHEMA_VERSION, canonicalOperation(operationInput))
}

/** canonical 文本，仅供诊断。**不用于比较**——比较一律走指纹。 */
export function operationCanonicalText(operationInput = {}) {
  return canonicalJson(canonicalOperation(operationInput))
}

/**
 * 两次调用是不是**同一个操作**。
 *
 * 这是 `JSON.stringify(a) === JSON.stringify(b)` 的替代品。用指纹而不是文本比较，
 * 是因为文本比较会把键序算进去。
 *
 * 它**不**做部分匹配：少一个字段的 `other` 会走 `normalizeOperation` 的默认值，
 * 因此 `{scope,actor,action,target}` 与同一组字段加 `taskId: null` 是同一个操作
 * （`null` 就是 `taskId` 的默认值），而 `taskId: 'x'` 不是。这是有意的——
 * 默认值相同的两次调用本来就该是同一个操作。
 */
export function sameOperation(a, b) {
  try {
    return operationFingerprint(a) === operationFingerprint(b)
  } catch {
    // 任一侧无法规范化（缺必需字段、metadata 里塞了不能表达的值）→ **判不同**。
    // 判"相同"会让一次来路不明的调用继承别人的批准。
    return false
  }
}

/**
 * 自检：`OPERATION_KEYS` 必须与 `normalizeOperation` 真正产出的字段**逐个对齐**。
 *
 * **为什么需要它**：`canonicalOperation` 只取 `OPERATION_KEYS` 里的字段。
 * 谁往 `normalizeOperation` 里加了一个字段（比如 `runId`）却忘了加进名单，
 * 那个字段就不会进入指纹——**改了它，审批照样通过**。
 * 而这个错误在代码里完全看不出来：`normalizeOperation` 的输出里有它，
 * 所有既有用例也都还是绿的。
 *
 * 把样本做成参数，是为了让用例能喂一对**故意错位**的名单进来，验它真的会拦：
 * 一个只能对"当前恰好正确的那份输入"作答的校验，与一个恒真的校验，同形。
 */
export function assertOperationKeysAligned(
  keys = OPERATION_KEYS,
  sample = SAMPLE_OPERATION,
) {
  const produced = Object.keys(normalizeOperation(sample))
  const declared = [...keys]
  // 产出了却没进名单 → 这个字段改了也不会让审批失效（**危险方向**）
  const missing = produced.filter((k) => !declared.includes(k))
  // 名单里有但产出里没有 → 指纹里恒为 undefined，规范化在这里静默丢字段
  const extra = declared.filter((k) => !produced.includes(k))
  return Object.freeze({
    ok: missing.length === 0 && extra.length === 0,
    missing: Object.freeze(missing),
    extra: Object.freeze(extra),
  })
}

/** 自检样本：**每个可选字段都填上**，这样"漏列"才看得出来。 */
const SAMPLE_OPERATION = Object.freeze({
  scope: 's', actor: 'a', action: 'act', target: 't',
  taskId: 'k', unattended: true, metadata: { z: 1 },
  toolName: 'file_write', callId: 'call-k', argsHash: 'sha256:sample',
})

// 加载即执行，并留下**真正算出来的**证据（产出的字段名）。
// 不导出一个布尔"通过"标记：`ok: true` 是随手就能写出来的字面量，
// 而能把它写成 true 的，恰恰就是那个把自检删掉的证据。
export const OPERATION_KEYS_CHECKED = Object.freeze({
  ...assertOperationKeysAligned(),
  producedKeys: Object.freeze(Object.keys(normalizeOperation(SAMPLE_OPERATION))),
})

// ============================================================================
// PRT-609：字段变化必须让审批失效
//
// spec §6.5：「审批绑定不可变 `ToolExecution` 参数的 canonical operation 哈希；
//            **任一授权关键字段变化都会使审批失效**。」
// 完成标准（阶段 6）：「改变已批准操作的**任一**关键字段后无法继续执行。」
//
// `assertOperationKeysAligned` 只比**字段名**：名单里有的、`normalizeOperation`
// 产出的，两边对齐就通过。它拦不住下面这一类：
//
//   `canonicalOperation` 里写了 `if (key === 'taskId') continue`
//   —— 名字对齐仍然通过，`taskId` 也确实在名单里，**但它不再进入指纹**。
//   于是改了 `taskId` 的调用会命中同一张审批票，而"任一关键字段变化都会使审批失效"
//   这句话在 `taskId` 上变成了一句空话。
//
//   > 一个「名单里有、但值根本不进指纹」的字段，
//   > 与一个「不在名单里」的字段，是同一个东西——
//   > 只不过前者看起来是被保护着的。
//
// 所以这里的判据是**构造性的**：对名单里的**每一个**字段，造一个**确实不同**的值，
// 验指纹**必须**改变。这是把一句全称命题（"任一字段"）变成逐个字段的实测。
//
// 两个读数都要，而且它们证明的是**不同**的事：
//   · `mutatedCanonicalDiffers` —— 这个变异不是空操作（否则下面那条恒真，测不到东西）
//   · `affectsFingerprint`    —— 这个字段真的进了指纹
// 只有后者会让人以为前者也成立：
//
//   > 一个「变异本身就是空操作」的逐字段测试，
//   > 与一个「每个字段都能影响指纹」的测试，在读数上完全一样。
// ============================================================================

/** 逐字段变异自检的基准操作：**每个字段都是非默认值**，否则变异可能被规范化吃掉。 */
export const MUTATION_BASE = Object.freeze({
  scope: 'scope-base', actor: 'actor-base', action: 'action:base', target: 'target-base',
  taskId: 'task-base', unattended: true, metadata: { probe: 'base' },
  toolName: 'file_write', callId: 'call-base', argsHash: `sha256:${'a'.repeat(64)}`,
})

/** 每个字段的变异值。**必须覆盖 `OPERATION_KEYS` 的全部字段**（见下面的自检）。 */
export const FIELD_MUTATIONS = Object.freeze({
  scope: 'scope-mut', actor: 'actor-mut', action: 'action:mut', target: 'target-mut',
  taskId: 'task-mut', unattended: false, metadata: { probe: 'mut' },
  toolName: 'file_delete', callId: 'call-mut', argsHash: `sha256:${'b'.repeat(64)}`,
})

/**
 * 相对**任意**基准造一个确实不同的值。
 *
 * ⚠️ 为什么不能到处复用 `FIELD_MUTATIONS`：那张表是相对 `MUTATION_BASE`
 * （`unattended: true`）定义的。拿它去变异一个 `unattended: false` 的基准，
 * `false → false` 就是一次**空操作**——而空操作对应的"指纹变了"这条读数恒为真，
 * 测不到任何东西。这正是下面这个函数存在的理由：
 *
 *   > 一张「相对于某个基准定义」的变异表，
 *   > 与一张「换个基准就变成空操作」的变异表，是同一个东西——
 *   > 只不过后者不会报错，只会让用例绿得毫无意义。
 *
 * 本仓库在 PRT-609 的端到端用例里**实测踩到过**这一次：基准的
 * `unattended: false` 配上表里的 `unattended: false`，于是那个字段"通过了"
 * 逐字段检查，而它其实一次都没被改过。
 *
 * 变异后立即复核一次，变了才返回：把空操作这个陷阱变成一声明确的报错，
 * 而不是一个安静通过的读数。复核本身见下面的 `assertMutationNotNoop`。
 */
export function mutateField(base, key) {
  if (!Object.prototype.hasOwnProperty.call(base, key)) {
    throw new Error(`内部错误（PRT-609）：基准里没有字段 \`${key}\``)
  }
  const value = base[key]
  let next
  if (key === 'unattended') {
    next = !(value === true)
  } else if (key === 'metadata') {
    const m = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    next = { ...m, __mutationProbe: `${String(m.__mutationProbe ?? '')}x` }
  } else if (value === null || value === undefined) {
    next = 'mut'
  } else {
    // `~` 能挺过 `nfc` 与 `trim`，所以拼接出来的值与原来的**必然**不同。
    next = `${value}~`
  }
  const mutated = { ...base, [key]: next }
  assertMutationNotNoop({ base, mutated, key })
  return mutated
}

/**
 * 复核一次变异**确实**改变了规范化文本。
 *
 * 单独导出，而不是留在 `mutateField` 里当一个内联的 `if` —— 理由是本仓库
 * **实测**出来的：`mutateField` 自己构造的变异**永远**有效（每个分支都附了一个
 * 挺得过 `nfc`/`trim` 的后缀），所以那个内联判断在自己的调用路径上**永远不触发**。
 * 破坏性验证把内联判断改成 `if (false)` 时，一处都没变红。
 *
 *   > 一个永远不会触发的复核，与没有复核，
 *   > 在「它到底拦不拦得住」上是同一个东西。
 *
 * 所以它必须**可以被直接调用**：用例喂一对相同的 base/mutated 进来，验它真的会抛。
 * 这样它对 `mutateField` 未来被改成"查表式"的写法也仍然有效——而那正是这次
 * 假绿发生过的形状。
 */
export function assertMutationNotNoop({ base, mutated, key = null, canonicalTextOf = operationCanonicalText } = {}) {
  if (canonicalTextOf(mutated) === canonicalTextOf(base)) {
    const where = key === null ? '这次' : `对 \`${key}\` 的`
    throw new Error(
      `内部错误（PRT-609）：${where}变异没有改变规范化文本——这是一次空操作，`
      + '"指纹变了"那条读数对它恒为真，测不到任何东西',
    )
  }
  return true
}

/**
 * 逐字段验：名单里的每个字段，改了它指纹就必须变。
 *
 * `keys` / `mutations` / `fingerprintOf` 可注入，理由与前几处一样：
 * 正确实现下"某个字段不影响指纹"**永远为假**，那段断言永远不触发——
 *
 *   > 一段永远不会触发的断言，与一段不存在的断言，
 *   > 在「它到底拦不拦得住」上是同一个东西。
 *
 * 注入一个**忽略某个字段**的 `fingerprintOf`，就能验这道比较是活的。
 */
export function assertEveryKeyAffectsFingerprint({
  keys = OPERATION_KEYS,
  mutations = FIELD_MUTATIONS,
  base = MUTATION_BASE,
  fingerprintOf = operationFingerprint,
  canonicalTextOf = operationCanonicalText,
} = {}) {
  const declared = [...keys]
  // 名单里有、但没给变异值的字段会被**静默跳过** —— 那正是本自检要防的形状
  // 在它自己身上复发（新增一个字段，于是那个字段没人验）。
  const unmutable = declared.filter((k) => !Object.prototype.hasOwnProperty.call(mutations, k))
  const baseFp = fingerprintOf(base)
  const baseText = canonicalTextOf(base)
  const perKey = []
  const insensitive = []
  const noopMutations = []
  for (const key of declared) {
    if (unmutable.includes(key)) continue
    const mutated = { ...base, [key]: mutations[key] }
    const mutatedText = canonicalTextOf(mutated)
    const mutatedCanonicalDiffers = mutatedText !== baseText
    const fp = fingerprintOf(mutated)
    const affectsFingerprint = fp !== baseFp
    perKey.push(Object.freeze({
      key, mutatedCanonicalDiffers, affectsFingerprint,
      baseFingerprint: baseFp, mutatedFingerprint: fp,
    }))
    // 变异是空操作 → 这条读数不能证明任何事，必须单独报出来（否则读数会被误读）
    if (!mutatedCanonicalDiffers) noopMutations.push(key)
    if (!affectsFingerprint) insensitive.push(key)
  }
  return Object.freeze({
    keysChecked: Object.freeze(declared.filter((k) => !unmutable.includes(k))),
    unmutable: Object.freeze(unmutable),
    noopMutations: Object.freeze(noopMutations),
    insensitive: Object.freeze(insensitive),
    perKey: Object.freeze(perKey),
  })
}

/**
 * 装载时执行，**并留下一份会抛错的证据**。
 *
 * 三个失败条件各自对应一个不同的、都很安静的缺陷：
 *   · `unmutable`       —— 加了字段却没给它变异值 → 那个字段没人验
 *   · `noopMutations`   —— 变异被规范化吃掉 → 这条读数恒真，等于没测
 *   · `insensitive`     —— **字段在名单里但不进指纹** → 改它审批照样通过（危险方向）
 */
export function assertFieldSensitivity(evidence = assertEveryKeyAffectsFingerprint()) {
  if (evidence.unmutable.length > 0) {
    throw new Error(
      `内部错误（PRT-609）：\`${evidence.unmutable.join('、')}\` 在 OPERATION_KEYS 里但没有变异值——`
      + '逐字段自检会**静默跳过**它们，而"跳过"与"验过了"在这份证据上长得一模一样',
    )
  }
  if (evidence.noopMutations.length > 0) {
    throw new Error(
      `内部错误（PRT-609）：对 \`${evidence.noopMutations.join('、')}\` 的变异没有改变规范化文本——`
      + '这是一次空操作，它对应的读数恒为真，测不到任何东西',
    )
  }
  if (evidence.insensitive.length > 0) {
    throw new Error(
      `内部错误（PRT-609）：\`${evidence.insensitive.join('、')}\` 在 OPERATION_KEYS 里，`
      + '但**改变它的值不会改变指纹**——审批绑定不到这个字段，'
      + '于是"任一关键字段变化都会使审批失效"在这几个字段上是一句空话（spec §6.5）',
    )
  }
  return evidence
}

// 加载即执行。导出的是**逐个字段算出来的那一对指纹**，不是一个 ok 标记。
export const FIELD_SENSITIVITY_CHECKED = Object.freeze(assertFieldSensitivity())

function specificity(rule) {
  return ['scope', 'actor', 'action', 'target'].reduce((n, key) => n + (rule[key] ? 1 : 0), 0)
}

export function matchRule(operationInput, rules = [], now = Date.now()) {
  const operation = normalizeOperation(operationInput)
  return rules
    .filter(rule => MODES.has(rule.mode))
    .filter(rule => !rule.expiresAt || Number(rule.expiresAt) > now)
    .filter(rule => ['scope', 'actor', 'action', 'target'].every(key => !rule[key] || String(rule[key]) === operation[key]))
    .filter(rule => !rule.taskId || rule.taskId === operation.taskId)
    .sort((a, b) => specificity(b) - specificity(a) || Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))[0] || null
}

function isHardFloor(operation) {
  return operation.metadata.irreversible === true || ['file:delete', 'repo:push', 'credential:write'].includes(operation.action)
}

export function evaluatePermission(operationInput, rules = [], context = {}) {
  const operation = normalizeOperation(operationInput)
  const now = Number(context.now || Date.now())
  if (isHardFloor(operation)) return { operation, allowed: false, decision: 'deny', mode: 'deny', reason: 'hard-floor', matchedRule: null, status: 'denied' }
  const rule = matchRule(operation, rules, now)
  const mode = rule?.mode || (operation.unattended ? 'deny' : 'ask')
  if (!MODES.has(mode)) return { operation, allowed: false, decision: 'deny', mode: 'deny', reason: 'invalid-mode', matchedRule: rule, status: 'denied' }
  if (mode === 'allow-by-policy') return { operation, allowed: true, decision: 'allow', mode, reason: 'policy', matchedRule: rule, status: 'approved' }
  if (mode === 'allow-for-task' && operation.taskId) return { operation, allowed: true, decision: 'allow', mode, reason: 'task-policy', matchedRule: rule, status: 'approved' }
  if (mode === 'allow-once') return { operation, allowed: false, decision: 'allow-once', mode, reason: 'approval-required', matchedRule: rule, status: 'pending' }
  if (mode === 'ask') return { operation, allowed: false, decision: 'ask', mode, reason: 'approval-required', matchedRule: rule, status: 'pending' }
  return { operation, allowed: false, decision: 'deny', mode, reason: mode === 'deny' ? 'policy' : 'invalid-task', matchedRule: rule, status: 'denied' }
}

export function consumeDecision(decision, operationInput) {
  const operation = normalizeOperation(operationInput)
  if (decision?.status !== 'approved') throw new Error('decision not consumable')
  // PRT-611：原来这里是 `JSON.stringify(decision.operation) !== JSON.stringify(operation)`。
  // 改成指纹比较，键序不再影响身份。
  if (decision.operation && !sameOperation(decision.operation, operation)) throw new Error('operation mismatch')
  return { ...decision, operation, status: 'consumed', consumedAt: Date.now() }
}

export { MODES }
