// team-hub/field-invalidation.test.mjs
// ============================================================================
// PRT-609 的判据：改变已批准操作的**任一**关键字段后无法继续执行
//
// spec §6.5：
//   「审批绑定不可变 `ToolExecution` 参数的 canonical operation 哈希；
//     **任一授权关键字段变化都会使审批失效**。」
// 阶段 6 完成标准：「改变已批准操作的任一关键字段后无法继续执行。」
//
// 这是一句**全称命题**。全称命题不能用"我试了三个字段"来交付——
// 一个覆盖了 6/7 个字段的测试，与一个 0/7 的测试，在"剩下那个字段改了会怎样"
// 上是同一个东西：**没有答案**。
//
//   > 一个「测了大部分字段」的覆盖，与一个「没测的字段照样能放行」的覆盖，
//   > 在「它到底拦不拦得住」上是同一个东西。
//
// 所以这一组对 OPERATION_KEYS 里的**每一个**字段造一个确实不同的值，逐个走真实
// 路径（申请 → 批准 → 改字段 → 再调用），断言**必须被拒**。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FIELD_MUTATIONS,
  FIELD_SENSITIVITY_CHECKED,
  MUTATION_BASE,
  OPERATION_KEYS,
  OPERATION_KEYS_CHECKED,
  assertEveryKeyAffectsFingerprint,
  assertFieldSensitivity,
  assertMutationNotNoop,
  canonicalOperation,
  mutateField,
  operationCanonicalText,
  operationFingerprint,
} from './permission-engine.mjs'
import { BINDING_CODES, BINDING_HASH_COLUMN } from './approval-binding.mjs'

// ---------------------------------------------------------------- ① 逐字段自检

test('① ★★ 名单里的**每一个**字段都真的影响指纹（全称命题的构造性证明）', () => {
  const e = FIELD_SENSITIVITY_CHECKED
  assert.deepEqual(e.keysChecked, [...OPERATION_KEYS], '自检没有覆盖 OPERATION_KEYS 的全部字段')
  assert.deepEqual(e.insensitive, [], `这些字段改了不会让审批失效：${e.insensitive.join('、')}`)
  assert.deepEqual(e.unmutable, [])
  assert.deepEqual(e.noopMutations, [])
})

test('① ★★ 证据是**逐个字段算出来的那一对指纹**，不是布尔标记', () => {
  // `ok: true` 是随手就能写出来的字面量；要伪造"这个字段进了指纹"，
  // 就得真的算出两个不同的指纹。
  assert.equal(FIELD_SENSITIVITY_CHECKED.perKey.length, OPERATION_KEYS.length)
  for (const r of FIELD_SENSITIVITY_CHECKED.perKey) {
    assert.ok(OPERATION_KEYS.includes(r.key), `证据里出现了名单外的字段 ${r.key}`)
    assert.equal(r.mutatedCanonicalDiffers, true, `${r.key} 的变异是空操作——这条读数测不到东西`)
    assert.equal(r.affectsFingerprint, true, `${r.key} 改了但指纹没变`)
    assert.notEqual(r.baseFingerprint, r.mutatedFingerprint, r.key)
    // 指纹形如 `sha256:<64 hex>`。写成"长度必须 64"会把前缀算漏——
    // 而一个按错长度断言的自检，与一个没有断言的自检，在"它验了什么"上是同一个东西。
    assert.match(r.baseFingerprint, /^sha256:[0-9a-f]{64}$/, r.key)
  }
})

test('① ★★ 自检**真的会拦**"字段在名单里但不进指纹"', () => {
  // 这正是 `assertOperationKeysAligned` 拦不住的那一类：名字对齐完全通过，
  // 字段也确实在名单里，**但它不再进入指纹**——于是改它审批照样通过。
  //
  //   > 一个「名单里有、但值根本不进指纹」的字段，
  //   > 与一个「不在名单里」的字段，是同一个东西——
  //   > 只不过前者看起来是被保护着的。
  //
  // 注入一个**忽略某个字段**的指纹函数，就是构造那次"忘记把它算进去"。
  const ignoring = (op) => {
    const { taskId, ...rest } = canonicalOperation(op)
    return operationFingerprint(rest)
  }
  const evidence = assertEveryKeyAffectsFingerprint({ fingerprintOf: ignoring })
  assert.deepEqual(evidence.insensitive, ['taskId'], '忽略 taskId 的指纹没有被识别出来')
  assert.throws(() => assertFieldSensitivity(evidence), /taskId.*不会改变指纹|in_sensitive|改变它的值不会改变指纹/s)
  // 而且报错信息要指向**危险方向**（改了照样放行），不是一句泛泛的失败
  assert.throws(() => assertFieldSensitivity(evidence), /任一关键字段变化都会使审批失效/)
})

test('① ★★ 自检**真的会拦**"加了字段却没给它变异值"（跳过与验过同形）', () => {
  // 新增一个字段到 OPERATION_KEYS、却忘了给 FIELD_MUTATIONS 加一条时，
  // 逐字段自检会**静默跳过**它——"跳过"与"验过了"在这份证据上长得一模一样。
  // 这是本自检要防的形状在它自己身上复发。
  const keys = [...OPERATION_KEYS, 'newField']
  const evidence = assertEveryKeyAffectsFingerprint({ keys })
  assert.deepEqual(evidence.unmutable, ['newField'])
  assert.throws(() => assertFieldSensitivity(evidence), /没有变异值/)
  assert.throws(() => assertFieldSensitivity(evidence), /静默跳过/)
})

test('① ★★ 自检**真的会拦**"变异被规范化吃掉"（这条读数恒真）', () => {
  // 一个「变异本身就是空操作」的逐字段测试，
  // 与一个「每个字段都能影响指纹」的测试，在读数上完全一样。
  const mutations = { ...FIELD_MUTATIONS, taskId: MUTATION_BASE.taskId } // 与原值相同
  const evidence = assertEveryKeyAffectsFingerprint({ mutations })
  assert.deepEqual(evidence.noopMutations, ['taskId'])
  assert.throws(() => assertFieldSensitivity(evidence), /没有改变规范化文本/)
  // 而且这条陷阱在**端到端**那边是被 `mutateField` 拦住的（见下面 ② 那条用例）：
  // 这里证明"空操作可被识别"，⑨ 证明"空操作造不出来"。
})

test('① ★★ `mutateField` 不制造空操作（把陷阱变成一声报错）', () => {
  // `mutateField` 与 `FIELD_MUTATIONS` 的分工：前者按**给定基准**造值，后者是
  // 相对 `MUTATION_BASE` 的固定表。用错后者会在换个基准时静默变成空操作——
  // 本仓库实测踩过一次。
  const allDefault = { scope: 's', actor: 'a', action: 'x', target: 't', taskId: null, unattended: false, metadata: {} }
  for (const base of [allDefault, MUTATION_BASE]) {
    for (const key of OPERATION_KEYS) {
      const mutated = mutateField(base, key)
      assert.notEqual(operationCanonicalText(mutated), operationCanonicalText(base), `${key}：规范化文本没变`)
      assert.notEqual(operationFingerprint(mutated), operationFingerprint(base), `${key}：指纹没变`)
    }
  }
  // 基准里没有的字段要报错，而不是悄悄造一个
  assert.throws(() => mutateField(allDefault, 'notAField'), /基准里没有字段/)
})

test('① ★★ 空操作复核**可以被直接调到**（内联时它一次都没触发过）', () => {
  // `assertMutationNotNoop` 单独导出，正是因为它在 `mutateField` 的调用路径上
  // **永远不触发**（mutateField 构造的变异永远有效）。破坏性验证把内联判断改成
  // `if (false)` 时一处都没变红——那就是"一个永远不会触发的复核"。
  //
  //   > 一个永远不会触发的复核，与没有复核，
  //   > 在「它到底拦不拦得住」上是同一个东西。
  //
  // 所以这里直接喂一对"相同"的 base/mutated，验它真的会抛。
  const base = { scope: 's', actor: 'a', action: 'x', target: 't', taskId: null, unattended: false, metadata: {} }
  assert.throws(
    () => assertMutationNotNoop({ base, mutated: { ...base }, key: 'target' }),
    /空操作/,
    '相同的 base/mutated 没有被识别为空操作',
  )
  // 真的变了就安静通过，并且返回一个可判定的值（不是 undefined）
  assert.equal(assertMutationNotNoop({ base, mutated: { ...base, target: 't2' }, key: 'target' }), true)
  // 报错要指出是哪个字段（否则排查时不知道是哪次变异）
  assert.throws(() => assertMutationNotNoop({ base, mutated: { ...base }, key: 'target' }), /target/)
})

test('① ★ 两个名单互相对齐（字段名层面）', () => {
  // 这是 PRT-611 的那条自检，PRT-609 的逐字段自检是它的**下一层**。
  // 两条都要在：前者拦"字段没进名单"，后者拦"进了名单但没进指纹"。
  assert.equal(OPERATION_KEYS_CHECKED.ok, true)
  assert.deepEqual(OPERATION_KEYS_CHECKED.missing, [])
  assert.deepEqual(OPERATION_KEYS_CHECKED.extra, [])
})

test('① ★ 变异基准的每个字段都是**非默认值**（否则变异可能被规范化吃掉）', () => {
  // `taskId` 的默认值是 `null`、`unattended` 的默认值是 `false`、`metadata` 是 `{}`。
  // 基准若用默认值，某些变异（例如 unattended: false → false）就是空操作。
  assert.equal(MUTATION_BASE.unattended, true, 'unattended 的基准必须是 true，否则变异是空操作')
  assert.notEqual(MUTATION_BASE.taskId, null)
  assert.ok(MUTATION_BASE.taskId)
  assert.ok(MUTATION_BASE.metadata && Object.keys(MUTATION_BASE.metadata).length > 0)
  assert.notEqual(MUTATION_BASE.metadata, FIELD_MUTATIONS.metadata)
})

// ---------------------------------------------------------------- ② 端到端

const root = mkdtempSync(join(tmpdir(), 'legion-field-inv-'))
process.env.TEAM_HUB_DB = join(root, 'team.db')
const mod = await import('./server.mjs')
const db = mod.db

let seq = 0
/** 为每个字段造一组**互不干扰**的基准操作（action 唯一 → 规则也唯一）。 */
function baseOp() {
  seq += 1
  const action = `p609:act:${seq}`
  mod.upsertPermissionRule({ id: `p609-rule-${action}`, scope: 'legion', action, target: 'tgt-609', mode: 'ask', by: 'general' })
  return {
    scope: 'legion', actor: 'general', action, target: 'tgt-609',
    taskId: null, unattended: false, metadata: {},
  }
}

test('② ★★ 对**每一个**关键字段：改了它，那张已批准的票就用不了', () => {
  const failures = []
  for (const key of OPERATION_KEYS) {
    const base = baseOp()
    const pending = mod.checkPermission({ ...base, attemptId: `att-609-${key}` })
    assert.equal(pending.status, 'pending', `${key}：夹具应当产生一条待批准请求`)
    const decided = mod.decidePermission({ requestId: pending.requestId, decision: 'approve', by: 'general' })
    assert.equal(decided.status, 'approved', `${key}：夹具应当能批准`)

    // ⚠️ 用 `mutateField(base, key)` 而**不是** `FIELD_MUTATIONS[key]`。
    //
    // `FIELD_MUTATIONS` 是相对 `MUTATION_BASE`（`unattended: true`）定义的一张表。
    // 拿它来变异这里的基准（`unattended: false`）时，`false → false` 是一次**空操作**，
    // 那个字段于是"通过了"检查而其实一次都没被改过。本用例第一版就是这么写的，
    // 实测在 `unattended` 上假绿。
    //
    //   > 一张「相对于某个基准定义」的变异表，
    //   > 与一张「换个基准就变成空操作」的变异表，是同一个东西——
    //   > 只不过后者不会报错，只会让用例绿得毫无意义。
    const mutated = mutateField(base, key)

    if (key === 'action') {
      // action 变了就是**另一个操作**（规则也对不上）。它仍然必须不能被放行，
      // 但拒绝的路径允许是"需要新的批准"而不是"操作变了"——因为绑定的
      // `permissionRequestId` 指向的那张票也确实不是给这个 action 的。
      const r = mod.checkPermission({ ...mutated, attemptId: `att-609-${key}` })
      if (r.allowed === true) failures.push(`${key}：改了 action 却直接放行了`)
      continue
    }
    let threw = null
    try {
      const r = mod.checkPermission({ ...mutated, attemptId: `att-609-${key}`, permissionRequestId: pending.requestId })
      if (r.allowed === true) failures.push(`${key}：改了字段却仍然 allowed=true`)
    } catch (e) {
      threw = e
    }
    if (threw === null) failures.push(`${key}：改了字段却没有抛错`)
    else if (!String(threw.message).includes(BINDING_CODES.OPERATION_CHANGED)) {
      failures.push(`${key}：拒绝理由不是 operation-changed，而是 ${threw.message.slice(0, 120)}`)
    }
  }
  assert.deepEqual(failures, [], `以下字段没有让审批失效：\n  ${failures.join('\n  ')}`)
})

test('② ★★ 没改字段时那张票**确实能用**（否则上一条的"被拒"什么都没证明）', () => {
  // 一个"所有调用都被拒"的实现也能让上一条用例全绿。
  // 必须同时证明：同一个操作、同一张票，**不改字段就能放行**。
  const base = baseOp()
  const attemptId = 'att-609-ok'
  const pending = mod.checkPermission({ ...base, attemptId })
  mod.decidePermission({ requestId: pending.requestId, decision: 'approve', by: 'general' })
  const ok = mod.checkPermission({ ...base, attemptId, permissionRequestId: pending.requestId })
  assert.equal(ok.allowed, true, '没改字段却放行不了——上一条用例的"被拒"证明不了任何事')
})

test('② ★★ 被拒之后那张票**没有**被消耗（用户不必重新走一遍审批）', () => {
  // 一次"改字段"的尝试若把票消费掉，用户会看到"我批准的票被一次失败的调用吃掉了"。
  const base = baseOp()
  const attemptId = 'att-609-keep'
  const pending = mod.checkPermission({ ...base, attemptId })
  mod.decidePermission({ requestId: pending.requestId, decision: 'approve', by: 'general' })
  try {
    mod.checkPermission({ ...base, metadata: { evil: true }, attemptId, permissionRequestId: pending.requestId })
  } catch { /* 预期被拒 */ }
  const row = db.prepare('SELECT status FROM permission_requests WHERE requestId=?').get(pending.requestId)
  assert.equal(row.status, 'approved', '一次失败的调用把票消费掉了')
  // 而且原操作仍然能用
  const ok = mod.checkPermission({ ...base, attemptId, permissionRequestId: pending.requestId })
  assert.equal(ok.allowed, true)
})

test('② ★★ 被拒的调用**不改写**那一行绑定的操作（不静默改写）', () => {
  // spec §6.5：「Legion 如需改变参数，只能拒绝当前调用并要求模型或工具定义产生
  // 一个新的 Tool Call，**不能在审批后静默改写**。」
  const base = baseOp()
  const attemptId = 'att-609-nowrite'
  const pending = mod.checkPermission({ ...base, attemptId })
  mod.decidePermission({ requestId: pending.requestId, decision: 'approve', by: 'general' })
  const before = db.prepare(`SELECT operation, ${BINDING_HASH_COLUMN} AS h FROM permission_requests WHERE requestId=?`).get(pending.requestId)
  try {
    mod.checkPermission({
      ...base, action: `${base.action}-evil`, target: 'tgt-evil',
      attemptId, permissionRequestId: pending.requestId,
    })
  } catch { /* 预期被拒 */ }
  const after = db.prepare(`SELECT operation, ${BINDING_HASH_COLUMN} AS h FROM permission_requests WHERE requestId=?`).get(pending.requestId)
  assert.equal(after.operation, before.operation, '被拒的调用改写了那一行绑定的操作')
  assert.equal(after.h, before.h, '被拒的调用改写了绑定哈希')
})

test('② ★★ 改字段的拒绝会留审计，且带上**两个**哈希（能看出改了什么）', () => {
  const base = baseOp()
  const attemptId = 'att-609-audit'
  const pending = mod.checkPermission({ ...base, attemptId })
  mod.decidePermission({ requestId: pending.requestId, decision: 'approve', by: 'general' })
  try {
    mod.checkPermission({ ...base, target: 'tgt-changed', attemptId, permissionRequestId: pending.requestId })
  } catch { /* 预期被拒 */ }
  const row = db.prepare("SELECT * FROM audit WHERE action='permission:binding-rejected' AND taskId=?").get(pending.requestId)
  assert.ok(row, '改字段被拒没有留痕')
  const detail = JSON.parse(row.detail)
  assert.equal(detail.code, BINDING_CODES.OPERATION_CHANGED)
  assert.ok(detail.bindingHash, '审计里没有"票上绑的是哪个操作"')
  assert.ok(detail.actualHash, '审计里没有"这次调用是哪个操作"——排查时看不出改了什么')
  assert.notEqual(detail.bindingHash, detail.actualHash)
})

test('② ★★ 逐字段的哈希变化与指纹变化**是同一件事**（不是两套算法）', () => {
  // 审批绑定用的哈希若与逐字段自检用的指纹不是同一个函数，
  // 那么自检证明的是"某个别的函数"对字段敏感。
  const base = baseOp()
  const pending = mod.checkPermission({ ...base, attemptId: 'att-609-same' })
  const row = db.prepare(`SELECT ${BINDING_HASH_COLUMN} AS h FROM permission_requests WHERE requestId=?`).get(pending.requestId)
  assert.equal(row.h, operationFingerprint(base), '票上绑的哈希与 operationFingerprint 不是同一个')
  for (const key of OPERATION_KEYS) {
    // 同样用 `mutateField`：固定的 `FIELD_MUTATIONS` 换个基准就可能变成空操作，
    // 而空操作在这里恰好会让断言**通过**（两个相同的哈希）。
    assert.notEqual(operationFingerprint(mutateField(base, key)), row.h, `${key}：改了它，指纹与票上的哈希相同`)
  }
})

test('② ★ 键序与书写方式不影响"同一个操作"（PRT-611 的保证仍然成立）', () => {
  // PRT-609 加的是"改字段必然失效"，不能反过来把"同一个操作"判成不同。
  const base = baseOp()
  // ① 顶层键的书写顺序
  const reorderedTop = {
    metadata: base.metadata, unattended: base.unattended, taskId: base.taskId,
    target: base.target, action: base.action, actor: base.actor, scope: base.scope,
  }
  assert.equal(operationFingerprint(base), operationFingerprint(reorderedTop), '顶层键序影响了操作身份')
  // ② `metadata` 里的键序（顶层字段序由 normalizeOperation 固定，metadata 由调用方决定）
  const m1 = { ...base, metadata: { a: 1, b: 2 } }
  const m2 = { ...base, metadata: { b: 2, a: 1 } }
  assert.equal(operationFingerprint(m1), operationFingerprint(m2), 'metadata 的键序影响了操作身份')
  // ③ 组合字符与预组合字符同字
  assert.equal(
    operationFingerprint({ ...base, target: 'cafe\u0301' }),
    operationFingerprint({ ...base, target: 'caf\u00e9' }),
    'NFC 没有生效',
  )
  // ④ 但**内容**不同就是不同（否则上面三条都是空的）
  assert.notEqual(operationFingerprint(m1), operationFingerprint({ ...base, metadata: { a: 1, b: 3 } }))
  assert.notEqual(operationFingerprint(base), operationFingerprint(m1), 'metadata 从空变成非空，身份却没变')
})

test.after(() => { try { db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) })
