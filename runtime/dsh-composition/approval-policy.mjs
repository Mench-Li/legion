// runtime/dsh-composition/approval-policy.mjs
// ============================================================================
// PRT-607（后半）：无人值守策略
//
// spec line 929：「`PRT-607`：接入审批箱和无人值守策略。」
// spec line 472：无人值守模式下，要求人工审批的操作**默认拒绝或保持等待**，
//   不自动降级为允许。
// spec §6.6 line 451：ask、allow-once → `tools/pre-execute` → `ctx.approval`；
//   Legion answerer 把请求写入审批箱；只有 `allowed-once` 执行。
// spec §6.6 line 452：无人值守禁止询问 → `approval/policy=never`，
//   DSH 在 answerer waterfall 前拒绝。
// spec line 495：Legion 必须**声明自己的** permission preset 表，不复用 DSH 默认表。
//   默认表把 `workspace-write`↔`ask` 与 `danger-full-access`↔`never` 绑定，
//   若按默认表实现「无人值守 = `never`」，沙箱会**同时**被降级为 `danger-full-access`。
// spec line 1083：无人值守 preset 不得把 sandbox 降级为 `danger-full-access`；
//   `legion-unattended` 必须保持 `workspace-write`。
// spec line 1084：承载 Run 的 session 在 Run 期间无法改写 approval policy 或 preset，
//   任何改写都留下审计记录。
//
// 一句话：**无人值守不是"没有人所以放行"，而是"没有人所以不能放行"。**
//
//   > 一个「无人值守时把需要审批的操作自动放行」的降级，
//   > 与一个「无人值守等于没有权限门」的实现，是同一个东西。
// ============================================================================

import { LEGION_PERMISSION_PRESETS } from './patch-layer.mjs'

export const APPROVAL_POLICY_VERSION = 'legion/approval-policy@1'

/** 本模块的决策闭集。**每一个都是一件不同的事**，不许合并。 */
export const APPROVAL_DECISIONS = Object.freeze([
  'allow-by-policy',   // 策略自己就允许，不需要人
  'ask',               // 要问人（有人可问）
  'hold',              // 保持等待（现在没人可问，但以后可能有）
  'deny',              // 拒绝
])

export const POLICY_CODES = Object.freeze({
  BAD_POLICY: 'approval-policy-unknown',
  BAD_PRESET: 'approval-preset-not-legion',
  PRESET_SANDBOX_DOWNGRADE: 'approval-preset-sandbox-downgrade',
  BAD_INPUT: 'approval-input-malformed',
  NEVER_MUST_NOT_ALLOW: 'approval-never-would-allow',
  UNATTENDED_WOULD_ALLOW: 'approval-unattended-would-allow',
  FROZEN_DURING_RUN: 'approval-knob-frozen',
  SILENT_DOWNGRADE: 'approval-silent-downgrade',
})

function fail(code, message) {
  const err = new Error(`${message}（${code}）`)
  err.code = code
  return err
}

/**
 * Legion 自己的 approval policy 闭集。**不复用 DSH 默认表**。
 *
 * `never` 的含义**只是**"不问人"，它**不**蕴含"沙箱可以放开"。
 * 把这两件事绑在一起是 DSH 默认表的做法，也是 spec line 495 明确要避开的坑。
 *
 *   > 一个「无人值守 = `approval/policy=never`」的实现，
 *   > 与一个「无人值守 = 沙箱同时升到 `danger-full-access`」的实现，是同一个东西——
 *   > 只不过前者的配置看起来只改了"要不要问人"这一个旋钮。
 */
export const APPROVAL_POLICIES = Object.freeze(['ask', 'never'])

/** 沙箱档位（用于校验 preset，不用于判定放行）。 */
export const SANDBOX_MODES = Object.freeze(['workspace-write', 'danger-full-access'])

/**
 * 一个操作对"人"的需求。
 *
 * | 值 | 含义 |
 * | --- | --- |
 * | `none` | 策略已经允许，不需要人过目 |
 * | `ask` | 需要人来决定这一次 |
 * | `allow-once` | 已经有了针对这一个 canonical 哈希的一次性批准 |
 */
export const HUMAN_REQUIREMENTS = Object.freeze(['none', 'ask', 'allow-once'])

/** 需要人参与的需求（`none` 之外的全部）。 */
const NEEDS_HUMAN = Object.freeze(['ask', 'allow-once'])

/**
 * 审批箱能返回的结果闭集（与 `enforcement.mjs` 的 `APPROVAL_OUTCOMES` 同源）。
 *
 * 在这里**重新声明而不是 import**：本模块与 enforcement 是同一层的两个模块，
 * 互相 import 会造出一个环。而两处必须一致——所以有一条自检把两边对起来（见
 * `assertOutcomeSetMatchesEnforcement`）。
 */
const APPROVAL_OUTCOMES_SET = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

/**
 * 校验 policy 名。不认识的**抛**，不给默认值。
 *
 *   > 一个「不认识的 policy 就按 `ask` 处理」的兜底，
 *   > 与一个「拼错的 `nver` 被当成 `ask`、于是无人值守时会去问一个不在场的人」的兜底，
 *   > 是同一个东西。
 */
export function assertPolicy(policy) {
  if (typeof policy !== 'string' || !APPROVAL_POLICIES.includes(policy)) {
    throw fail(
      POLICY_CODES.BAD_POLICY,
      `不认识的 approval policy ${JSON.stringify(policy)}；可选 ${JSON.stringify([...APPROVAL_POLICIES])}。` +
      '不给兜底——一个"不认识的 policy 就按 ask 处理"的兜底，' +
      '与一个"拼错的名字被当成问人、于是无人值守时会去问一个不在场的人"的兜底，是同一个东西',
    )
  }
  return policy
}

/**
 * 校验 preset 是 **Legion 自己的**那两个之一，且没有把沙箱降级。
 *
 * 这是 spec line 495 与 line 1083 的机械落点。两件事都要查：
 *
 *   ① preset **名**必须是 Legion 声明的（`legion-attended` / `legion-unattended`）。
 *      复用 DSH 默认表意味着"无人值守"这个语义由 DSH 的表决定，
 *      而 DSH 的表把 `never` 与 `danger-full-access` 绑在一起。
 *
 *      > 一个「复用 DSH 默认 preset 表」的实现，
 *      > 与一个「无人值守时沙箱悄悄升到 danger-full-access」的实现，是同一个东西——
 *      > 只不过前者的代码里没有任何一行写着 danger-full-access。
 *
 *   ② 无人值守 preset 的 sandbox **必须**是 `workspace-write`。
 *
 * ## 为什么 `table` 是参数
 *
 * 第 ② 条在真实表上**永远为假**（`legion-unattended` 就是 `workspace-write`），
 * 于是它看起来像一道防线，实际上从来没被执行过——一条不可能触发的检查
 * 与一条不存在的检查，在"它到底拦住了什么"上是同一个东西。
 *
 * 让表可注入，这条检查才**能被验证**：测试传一张被改坏的
 * （`legion-unattended` → `danger-full-access`）表，断言它抛。
 * 这也是它唯一的用途——生产调用点不传这个参数。
 */
export function assertPreset(preset, { table = LEGION_PERMISSION_PRESETS } = {}) {
  if (typeof preset !== 'string' || preset.trim() === '') {
    throw fail(POLICY_CODES.BAD_PRESET, `preset 必须是非空字符串，收到 ${JSON.stringify(preset)}`)
  }
  const known = table[preset]
  if (known === undefined) {
    throw fail(
      POLICY_CODES.BAD_PRESET,
      `preset ${JSON.stringify(preset)} 不是 Legion 声明的档位；` +
      `可选 ${JSON.stringify(Object.keys(table))}。` +
      '一个「复用 DSH 默认 preset 表」的实现，与一个「无人值守时沙箱悄悄升到 danger-full-access」的实现，' +
      '是同一个东西——只不过前者的代码里没有任何一行写着 danger-full-access',
    )
  }
  if (preset === 'legion-unattended' && known.sandbox !== 'workspace-write') {
    throw fail(
      POLICY_CODES.PRESET_SANDBOX_DOWNGRADE,
      `legion-unattended 的 sandbox 是 ${JSON.stringify(known.sandbox)}，必须是 'workspace-write'（spec line 1083）。` +
      '一个「无人值守 preset 把沙箱降级」的实现，' +
      '与一个「无人值守 = 无沙箱」的实现，是同一个东西',
    )
  }
  return Object.freeze({ preset, ...known, policy: known.approval })
}

/**
 * ★ 核心判定：这一次调用能不能放行。
 *
 * ## 不变量（本模块存在的全部理由）
 *
 *   **`policy === 'never'` 或"现场没有人"时，任何需要人的操作都不能得到 `allow-by-policy`。**
 *
 * 也就是说：`never` 只能产出 `deny` 或 `hold`。它**不会**、也**不许**产出放行。
 *
 *   > 一个「无人值守时把需要审批的操作自动放行」的降级，
 *   > 与一个「无人值守等于没有权限门」的实现，是同一个东西。
 *
 * ## `hold` 与 `deny` 是两件事
 *
 *   · `deny`：这次就是不行。审计上是一次**拒绝**。
 *   · `hold`：现在问不到人，**保持等待**。审计上是一次**挂起**。
 *
 * 混成一件，后果是：把"我们问不到人"记成"人拒绝了"，
 * 于是值班的人去追问一个从未被问过的人。
 *
 *   > 一个「问不到人就当没人反对」的默认，
 *   > 与一个「超时算通过」的默认，是同一个东西。
 *
 * 什么时候给 `hold` 而不是 `deny`：策略允许询问（`ask`），只是现场暂时没人。
 * 这时候挂起是对的——人回来就能批。策略是 `never` 时给 `deny`：
 * 那是一个**决定**（"这个岗位不许问人"），不是一个故障。
 *
 * @param {object} p
 * @param {'ask'|'never'} p.policy       session 的 approval policy
 * @param {'none'|'ask'|'allow-once'} p.requirement  这一次调用对"人"的需求
 * @param {boolean} p.attended           现场有没有人可问
 * @param {boolean} [p.highRisk]         是不是高风险写（spec §6.6 line 466 的类别）
 * @param {string|null} [p.preset]       权限档位名（给了就一起校验）
 * @returns {{decision: string, code: string|null, reason: string, policy: string, requirement: string, attended: boolean, highRisk: boolean, needsHuman: boolean, allowed: boolean, waited: boolean}}
 */
export function decideApproval({
  policy, requirement, attended, highRisk = false, preset = null,
} = {}) {
  const p = assertPolicy(policy)
  if (!HUMAN_REQUIREMENTS.includes(requirement)) {
    throw fail(
      POLICY_CODES.BAD_INPUT,
      `不认识的 requirement ${JSON.stringify(requirement)}；可选 ${JSON.stringify([...HUMAN_REQUIREMENTS])}`,
    )
  }
  if (typeof attended !== 'boolean') {
    throw fail(
      POLICY_CODES.BAD_INPUT,
      `attended 必须是布尔值，收到 ${JSON.stringify(attended)}。` +
      '一个「没有明确说现场有没有人」的输入，与一个「默认现场有人、于是去问一个不在场的人」的输入，是同一个东西',
    )
  }
  if (preset !== null) assertPreset(preset)

  const needsHuman = NEEDS_HUMAN.includes(requirement)

  // ① 不需要人的操作：策略直接允许。
  if (!needsHuman) {
    return Object.freeze({
      decision: 'allow-by-policy',
      code: null,
      reason: '策略已经允许，不需要人过目',
      policy: p, requirement, attended, highRisk, needsHuman: false,
      allowed: true, waited: false,
    })
  }

  // ② 需要人。**从这里开始，`never` 与"现场没人"都只能走向 deny / hold。**
  if (p === 'never') {
    // `requirement === 'allow-once'` 也走这里：policy=never 的 session 里
    // 不存在"已经批准过"这回事——批准本身就需要问人。
    //
    //   > 一个「policy=never 但带一次性批准就放行」的判定，
    //   > 与一个「无人值守时，只要之前有人批过一次就永远放行」的判定，是同一个东西。
    return Object.freeze({
      decision: 'deny',
      code: POLICY_CODES.NEVER_MUST_NOT_ALLOW,
      reason: `策略是 never，而这次调用需要人（${requirement}）——无人值守下不询问、也不放行`,
      policy: p, requirement, attended, highRisk, needsHuman: true,
      allowed: false, waited: false,
    })
  }

  // ③ policy === 'ask'
  if (!attended) {
    return Object.freeze({
      decision: 'hold',
      code: null,
      reason: `策略是 ask，但现场没有人可问（${requirement}）——保持等待，不自动放行`,
      policy: p, requirement, attended, highRisk, needsHuman: true,
      allowed: false, waited: true,
    })
  }
  return Object.freeze({
    decision: 'ask',
    code: null,
    reason: `策略是 ask 且现场有人——去问人（${requirement}）`,
    policy: p, requirement, attended, highRisk, needsHuman: true,
    allowed: false, waited: false,
  })
}

/**
 * 把审批箱返回的结果合到判定上。
 *
 * 这里是第二个容易出错的关口：**answerer 的结果不能把 `hold`/`deny` 变成放行。**
 *
 *   > 一个「审批箱超时后返回 unavailable、调用方把它当放行」的实现，
 *   > 与一个「问不到人就放行」的实现，是同一个东西。
 *
 * `unavailable` 只在 `hold` 上成立（"我们问不到人"本来就该挂起）；
 * 在已经是 `deny` 的判定上它是**不一致**——拒绝不需要问人就能成立。
 */
export function applyApprovalOutcome(verdict, outcome, { audience = null } = {}) {
  if (verdict === null || typeof verdict !== 'object' || !APPROVAL_DECISIONS.includes(verdict.decision)) {
    throw fail(POLICY_CODES.BAD_INPUT, `applyApprovalOutcome 需要一份本模块产出的判定，收到 ${JSON.stringify(verdict?.decision)}`)
  }
  if (!APPROVAL_OUTCOMES_SET.has(outcome)) {
    throw fail(
      POLICY_CODES.BAD_INPUT,
      `不认识的审批结果 ${JSON.stringify(outcome)}；可选 ${JSON.stringify([...APPROVAL_OUTCOMES_SET])}。` +
      '一个"不认识的结果就放行"的兜底，与一个"审批箱坏了也照过"的兜底，是同一个东西',
    )
  }
  const outcomesThatAllow = ['allowed-once']
  const grants = outcomesThatAllow.includes(outcome)

  // ★ 不变量：`deny` 与 `hold` 的判定**永远不会**被审批结果改成放行。
  //   这不是"多余的一层"——它是这个方法唯一不能被删掉的那一行。
  if (verdict.allowed === false && verdict.decision !== 'ask' && grants) {
    throw fail(
      POLICY_CODES.UNATTENDED_WOULD_ALLOW,
      `判定是 ${verdict.decision}（allowed=false），而审批结果 ${outcome} 试图放行。` +
      '一个「已经决定不放行的调用被一个"允许"结果覆盖」的实现，' +
      '与一个「无人值守时只要审批箱说行就行」的实现，是同一个东西',
    )
  }

  // `ask` 的判定遇到 `allowed-once` ⇒ 真的放行。
  if (verdict.decision === 'ask' && grants) {
    return Object.freeze({
      ...verdict,
      decision: 'allow-by-policy',
      allowed: true,
      waited: false,
      reason: `${verdict.reason}；审批箱返回 ${outcome}`,
      outcome,
      audience: audience ?? null,
    })
  }
  // `ask` 的判定遇到拒绝 / 取消 ⇒ 拒绝（**不是**放行，也不是挂起）
  if (verdict.decision === 'ask' && ['rejected', 'cancelled'].includes(outcome)) {
    return Object.freeze({
      ...verdict,
      decision: 'deny',
      allowed: false,
      waited: false,
      reason: `${verdict.reason}；审批箱返回 ${outcome}`,
      outcome,
      audience: audience ?? null,
    })
  }
  // `ask` 的判定遇到 unavailable ⇒ **保持等待**（不是放行，也不是拒绝）
  //
  //   > 一个「问不到人就当没人反对」的默认，
  //   > 与一个「超时算通过」的默认，是同一个东西。
  if (verdict.decision === 'ask' && outcome === 'unavailable') {
    return Object.freeze({
      ...verdict,
      decision: 'hold',
      allowed: false,
      waited: true,
      reason: `${verdict.reason}；审批箱不可用——保持等待，不自动放行`,
      outcome,
      audience: audience ?? null,
    })
  }
  // `hold` / `deny` 剩下的情形：结果不改变决定。
  return Object.freeze({ ...verdict, outcome, audience: audience ?? null })
}

/**
 * ★ 本模块的结果闭集必须与 `enforcement.mjs` 的 `APPROVAL_OUTCOMES` 完全一致。
 *
 * 两处各有一份是因为互相 import 会成环。但"两份"在这里是**危险**的：
 *
 *   > 一个「本模块认为 `unavailable` 是合法结果、而审批箱那一侧从不产出它」的差异，
 *   > 与一个「超时永远走不到该走的那条分支」的差异，是同一个东西。
 *
 * 由测试把两处对起来（测试可以同时 import 两边，模块自己不行）。
 */
export function approvalOutcomeSet() {
  return Object.freeze([...APPROVAL_OUTCOMES_SET])
}

/**
 * Run 期间旋钮冻结（spec line 1084 / PRT-619 的一半）。
 *
 * 这里只做**判定**：Run 进行中改写 approval policy 或 preset 一律拒绝。
 * 改写审计与持久化属于 PRT-619。
 *
 *   > 一个「Run 期间可以改 approval policy」的实现，
 *   > 与一个「§6.8 的'在 Run 快照中冻结'无法兑现」的实现，是同一个东西。
 */
export function assertKnobsUnchanged({ before, after, runActive } = {}) {
  if (before === null || typeof before !== 'object' || after === null || typeof after !== 'object') {
    throw fail(POLICY_CODES.BAD_INPUT, 'assertKnobsUnchanged 需要 before 与 after 两份旋钮快照')
  }
  const changed = []
  for (const key of ['approvalPolicy', 'permissionPreset']) {
    if (before[key] !== after[key]) changed.push({ key, before: before[key] ?? null, after: after[key] ?? null })
  }
  if (changed.length === 0) return Object.freeze({ changed: false, frozen: runActive === true, changes: Object.freeze([]) })
  if (runActive === true) {
    throw fail(
      POLICY_CODES.FROZEN_DURING_RUN,
      `Run 进行中不允许改写 ${JSON.stringify(changed.map((c) => c.key))}。` +
      '一个「Run 期间可以改 approval policy」的实现，' +
      '与一个「在 Run 快照中冻结的旋钮其实已经变了」的实现，是同一个东西',
    )
  }
  return Object.freeze({ changed: true, frozen: false, changes: Object.freeze(changed) })
}

// ---------------------------------------------------------------- 装载自检

/** ① `never` 在任何组合下都不放行。 */
export function assertNeverNeverAllows() {
  const rows = []
  for (const requirement of HUMAN_REQUIREMENTS) {
    for (const attended of [true, false]) {
      for (const highRisk of [true, false]) {
        const v = decideApproval({ policy: 'never', requirement, attended, highRisk })
        rows.push(Object.freeze({
          requirement, attended, highRisk,
          decision: v.decision, allowed: v.allowed,
        }))
      }
    }
  }
  return Object.freeze({
    rows: Object.freeze(rows),
    // 需要人的那些组合里，**无一**放行
    needsHumanRows: rows.filter((r) => r.requirement !== 'none'),
    allowedCount: rows.filter((r) => r.requirement !== 'none' && r.allowed).length,
    decisions: Object.freeze([...new Set(rows.filter((r) => r.requirement !== 'none').map((r) => r.decision))]),
  })
}

/** ② 现场没人时，`ask` 只产出 `hold`（挂起），不产出放行、也不产出"拒绝"。 */
export function assertUnattendedHoldsRatherThanDenies() {
  const rows = HUMAN_REQUIREMENTS.map((requirement) => {
    const v = decideApproval({ policy: 'ask', requirement, attended: false })
    return Object.freeze({ requirement, decision: v.decision, allowed: v.allowed, waited: v.waited })
  })
  const needsHuman = rows.filter((r) => r.requirement !== 'none')
  return Object.freeze({
    rows: Object.freeze(rows),
    needsHumanDecisions: Object.freeze([...new Set(needsHuman.map((r) => r.decision))]),
    allowedCount: needsHuman.filter((r) => r.allowed).length,
    heldCount: needsHuman.filter((r) => r.waited).length,
    //   > 一个「问不到人就当没人反对」的默认，
    //   > 与一个「超时算通过」的默认，是同一个东西。
    // 所以这里必须是"挂起"，不是"放行"。
  })
}

/** ③ 审批结果不能把 deny / hold 改成放行。 */
export function assertOutcomeCannotOverrideADenial() {
  const hold = decideApproval({ policy: 'ask', requirement: 'ask', attended: false })
  const deny = decideApproval({ policy: 'never', requirement: 'ask', attended: true })
  const rows = ['allowed-once', 'rejected', 'cancelled', 'unavailable'].map((outcome) => {
    let holdCode = null
    try { applyApprovalOutcome(hold, outcome) } catch (err) { holdCode = err.code }
    let denyCode = null
    try { applyApprovalOutcome(deny, outcome) } catch (err) { denyCode = err.code }
    return Object.freeze({ outcome, holdCode, denyCode })
  })
  return Object.freeze({
    hold: Object.freeze({ decision: hold.decision, allowed: hold.allowed }),
    deny: Object.freeze({ decision: deny.decision, allowed: deny.allowed }),
    rows: Object.freeze(rows),
    // deny 上任何结果都不许放行（allowed-once 会抛，其余不改决定）
    denyNeverAllows: rows.every((r) => r.denyCode !== null || r.outcome !== 'allowed-once'),
    // hold 上 allowed-once 也要抛（hold 是"没人可问"，一个放行结果与它矛盾）
    holdAllowedOnceThrows: rows.find((r) => r.outcome === 'allowed-once').holdCode === POLICY_CODES.UNATTENDED_WOULD_ALLOW,
  })
}

/** ④ `ask` + 有人可问 + `allowed-once` ⇒ 放行；其余结果不放行。 */
export function assertOnlyAllowedOnceGrants() {
  const ask = decideApproval({ policy: 'ask', requirement: 'ask', attended: true })
  const rows = ['allowed-once', 'rejected', 'cancelled', 'unavailable'].map((outcome) => {
    const v = applyApprovalOutcome(ask, outcome)
    return Object.freeze({ outcome, decision: v.decision, allowed: v.allowed, waited: v.waited })
  })
  return Object.freeze({
    ask: Object.freeze({ decision: ask.decision, allowed: ask.allowed }),
    rows: Object.freeze(rows),
    grantedOutcomes: Object.freeze(rows.filter((r) => r.allowed).map((r) => r.outcome)),
    // 只有 allowed-once 会放行——不是"除了拒绝之外的都放行"
    onlyAllowedOnce: rows.filter((r) => r.allowed).length === 1
      && rows.find((r) => r.allowed).outcome === 'allowed-once',
    // unavailable 变成挂起，不是放行、也不是拒绝
    unavailableDecision: rows.find((r) => r.outcome === 'unavailable').decision,
  })
}

/** ⑤ preset 表：Legion 自己的两个，且无人值守不降级沙箱。 */
export function assertLegionPresetsDoNotDowngradeSandbox() {
  const names = Object.keys(LEGION_PERMISSION_PRESETS)
  const rows = names.map((name) => {
    let code = null
    let out = null
    try { out = assertPreset(name) } catch (err) { code = err.code }
    return Object.freeze({ name, ok: code === null, code, sandbox: out?.sandbox ?? null, policy: out?.policy ?? null })
  })
  // 无人值守那个必须是 workspace-write（spec line 1083）
  const unattended = rows.find((r) => r.name === 'legion-unattended')
  // 而 DSH 默认表的诱惑：`never` 配 `danger-full-access`
  let dshDefaultCode = null
  try { assertPreset('default') } catch (err) { dshDefaultCode = err.code }
  // ★ 第 ② 条检查在真实表上永远为假。用一张**被改坏的表**证明它真的会拦——
  //   否则它就是一条从不执行的检查。
  //
  //   > 一个「检查一个不可能出现的值」的检查，
  //   > 与一条不存在的检查，在"它到底拦住了什么"上是同一个东西。
  const tampered = {
    'legion-attended': { sandbox: 'workspace-write', approval: 'ask' },
    'legion-unattended': { sandbox: 'danger-full-access', approval: 'never' },
  }
  let tamperedCode = null
  let tamperedSandbox = null
  try {
    assertPreset('legion-unattended', { table: tampered })
  } catch (err) {
    tamperedCode = err.code
  }
  tamperedSandbox = tampered['legion-unattended'].sandbox
  // 对照组：同一张表里 attended 那个仍然是合法的 ⇒ 抛的是**降级**而不是"表坏了"
  let tamperedAttendedCode = null
  try { assertPreset('legion-attended', { table: tampered }) } catch (err) { tamperedAttendedCode = err.code }
  return Object.freeze({
    names: Object.freeze(names),
    rows: Object.freeze(rows),
    unattended: Object.freeze({ ok: unattended.ok, sandbox: unattended.sandbox, policy: unattended.policy }),
    unattendedSandbox: unattended.sandbox,
    // 不认识的 preset 名要抛（复用 DSH 默认表 == 名字不在 Legion 的表里）
    unknownPresetCode: dshDefaultCode,
    allLegionPresetsOk: rows.every((r) => r.ok),
    downgrade: Object.freeze({
      tamperedSandbox,
      caughtCode: tamperedCode,
      // 同一张表里合法的那个仍然通过 —— 证明拦的是"降级"这件事本身
      controlCode: tamperedAttendedCode,
    }),
  })
}

/** ⑥ 未知 policy / requirement / attended 都要 fail-closed，不给默认。 */
export function assertUnknownInputsFailClosed() {
  const rows = [
    { label: 'policy 拼错', fn: () => decideApproval({ policy: 'nver', requirement: 'ask', attended: true }) },
    { label: 'policy 缺失', fn: () => decideApproval({ requirement: 'ask', attended: true }) },
    { label: 'policy 为 null', fn: () => decideApproval({ policy: null, requirement: 'ask', attended: true }) },
    { label: 'requirement 不认识', fn: () => decideApproval({ policy: 'ask', requirement: 'maybe', attended: true }) },
    { label: 'requirement 缺失', fn: () => decideApproval({ policy: 'ask', attended: true }) },
    { label: 'attended 缺失', fn: () => decideApproval({ policy: 'ask', requirement: 'ask' }) },
    { label: 'attended 是字符串', fn: () => decideApproval({ policy: 'ask', requirement: 'ask', attended: 'yes' }) },
    { label: 'preset 不认识', fn: () => decideApproval({ policy: 'ask', requirement: 'ask', attended: true, preset: 'default' }) },
  ]
  const out = rows.map((r) => {
    let code = 'NO-THROW'
    try { r.fn() } catch (err) { code = err.code }
    return Object.freeze({ label: r.label, code })
  })
  // 若"缺少 attended 就当有人"，这些会静默变成去问人
  return Object.freeze({
    rows: Object.freeze(out),
    allRejected: out.every((o) => o.code !== 'NO-THROW'),
    codes: Object.freeze([...new Set(out.map((o) => o.code))]),
  })
}

/** ⑦ Run 期间旋钮冻结。 */
export function assertKnobsFrozenDuringRun() {
  const before = { approvalPolicy: 'ask', permissionPreset: 'legion-attended' }
  const same = { ...before }
  const changedPolicy = { approvalPolicy: 'never', permissionPreset: 'legion-attended' }
  const changedPreset = { approvalPolicy: 'ask', permissionPreset: 'legion-unattended' }
  const run = (a, b, active) => {
    let code = 'NO-THROW'
    let res = null
    try { res = assertKnobsUnchanged({ before: a, after: b, runActive: active }) } catch (err) { code = err.code }
    return Object.freeze({ code, changed: res?.changed ?? null, frozen: res?.frozen ?? null })
  }
  return Object.freeze({
    unchangedIdle: run(before, same, false),
    unchangedRunning: run(before, same, true),
    policyRunning: run(before, changedPolicy, true),
    presetRunning: run(before, changedPreset, true),
    policyIdle: run(before, changedPolicy, false),
    presetIdle: run(before, changedPreset, false),
  })
}

export const APPROVAL_POLICY_CHECKED = Object.freeze({
  version: APPROVAL_POLICY_VERSION,
  policies: APPROVAL_POLICIES,
  decisions: APPROVAL_DECISIONS,
  requirements: HUMAN_REQUIREMENTS,
  sandboxModes: SANDBOX_MODES,
  codes: POLICY_CODES,
  neverNeverAllows: assertNeverNeverAllows(),
  unattended: assertUnattendedHoldsRatherThanDenies(),
  outcomeCannotOverride: assertOutcomeCannotOverrideADenial(),
  onlyAllowedOnceGrants: assertOnlyAllowedOnceGrants(),
  presets: assertLegionPresetsDoNotDowngradeSandbox(),
  unknownInputs: assertUnknownInputsFailClosed(),
  knobs: assertKnobsFrozenDuringRun(),
})
