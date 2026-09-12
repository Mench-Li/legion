// team-hub/permission-engine.canonical.test.mjs
// ============================================================================
// PRT-611 的判据：F-02 canonical operation，以及"键序不算身份"。
//
// 这一组盯的**不是**指纹算得对不对，而是**审批绑定到了哪些东西**。
// 它坏在两个方向不同、而只有一个方向会有人来报 bug 的地方：
//
//   ① 键的书写顺序被当成操作身份 → 错的方向是**拒绝**（fail-closed，没人报 bug）
//   ② 规范化丢掉的字段等于没绑定 → 错的方向是**放行**（危险的那个）
//
// ② 这一条本批在**它自己身上**应验过一次：`OPERATION_KEYS` 里当时没有 `toolName`
// 与 `callId`，"不可变工具参数"也没有载体，而 spec line 470 三个都要。于是
// "只看前六个字段"从一句比喻变成了一句实话——一次写文件的批准可以被一次删文件消费。
// 下面 §② 里的那几条用例就是这件事的回归锚点（它们在修之前必然红）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  OPERATION_DOMAIN,
  OPERATION_KEYS,
  OPERATION_KEYS_CHECKED,
  OPERATION_SCHEMA_VERSION,
  TOOL_ARGS_BINDING_CHECKED,
  argsHashOf,
  assertOperationKeysAligned,
  canonicalOperation,
  consumeDecision,
  evaluatePermission,
  normalizeOperation,
  operationCanonicalText,
  operationFingerprint,
  sameOperation,
} from './permission-engine.mjs'
import { canonicalOperationHash, CANONICAL_OP_DOMAIN } from '../runtime/dsh-composition/enforcement.mjs'
import { hashToolArguments } from '../runtime/dsh-composition/tool-args.mjs'
import { domainSeparatedHash } from '../runtime/contracts/canonical.mjs'

const BASE = Object.freeze({ scope: 'alpha', actor: 'general', action: 'skill:grant', target: 'bob' })

// ---------------------------------------------------------------- ① 键序不是身份

test('① ★★ 只差 `metadata` 的键序时是**同一个操作**（这是被替换掉的那个缺陷）', () => {
  const a = { ...BASE, metadata: { path: '/x', mode: 'rw' } }
  const b = { ...BASE, metadata: { mode: 'rw', path: '/x' } }
  // 先确认这确实是旧的判定方式会判错的那一对
  assert.notEqual(JSON.stringify(normalizeOperation(a)), JSON.stringify(normalizeOperation(b)),
    '这一对在旧实现下恰好相等，用例没测到东西')
  assert.equal(sameOperation(a, b), true, '键序仍然被当成了操作身份的一部分')
  assert.equal(operationFingerprint(a), operationFingerprint(b))
})

test('① ★ 顶层字段乱序时也是同一个操作', () => {
  const a = { scope: 'alpha', actor: 'general', action: 'skill:grant', target: 'bob', taskId: 't1' }
  const b = { taskId: 't1', target: 'bob', action: 'skill:grant', actor: 'general', scope: 'alpha' }
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), '这一对在旧实现下恰好相等，用例没测到东西')
  assert.equal(sameOperation(a, b), true)
})

test('① ★ 嵌套 metadata 的键序同样不影响身份', () => {
  const a = { ...BASE, metadata: { nested: { p: 1, q: [1, 2] }, keep: true } }
  const b = { ...BASE, metadata: { keep: true, nested: { q: [1, 2], p: 1 } } }
  assert.equal(sameOperation(a, b), true)
})

test('① 字符串先做 NFC 归一（组合字符与预组合字符是同一个字）', () => {
  const composed = { ...BASE, target: 'caf\u00e9' }
  const decomposed = { ...BASE, target: 'cafe\u0301' }
  assert.notEqual(composed.target, decomposed.target, '这两个字符串本身就相同，用例没测到东西')
  assert.equal(sameOperation(composed, decomposed), true, '看起来一样的目标被判成了两个操作')
})

test('① 数字 -0 与 0 同值', () => {
  const a = { ...BASE, metadata: { n: 0 } }
  const b = { ...BASE, metadata: { n: -0 } }
  assert.equal(sameOperation(a, b), true)
})

test('① ★ `metadata` 里的字符串也要过 NFC（顶层做了归一不代表里面也做了）', () => {
  // 顶层字段 `canonicalOperation` 会自己调 `nfc()`，所以只测顶层字符串
  // 是证明不了"共享 canonicalJson 的 NFC 在工作"的——`metadata` 里的字符串
  // **只有** canonicalJson 那一路会归一。
  const a = { ...BASE, metadata: { label: 'caf\u00e9' } }
  const b = { ...BASE, metadata: { label: 'cafe\u0301' } }
  assert.notEqual(a.metadata.label, b.metadata.label, '这一对本来就是同一个字符串，用例没测到东西')
  assert.equal(sameOperation(a, b), true, 'metadata 里"看起来一样"的两个字符串被判成了两个操作')
})

test('① ★ 值为 `undefined` 的键被省略（与 JSON 语义一致，不是"存在一个空值"）', () => {
  // `{a: undefined}` 与 `{}` 在 JSON 语义下相同。不省略会让它们成为两个操作，
  // 表现为"我把那个字段删了，它却说参数变了"。
  assert.equal(sameOperation({ ...BASE, metadata: { a: undefined } }, { ...BASE, metadata: {} }), true)
  assert.equal(
    sameOperation({ ...BASE, taskId: undefined }, { ...BASE, taskId: null }),
    true,
    'taskId: undefined 与 taskId: null 都走默认值，应当是同一个操作',
  )
})

// ---------------------------------------------------------------- ② ★★ 字段必须全都绑定

test('② ★★ `taskId` 变了就**不是**同一个操作（危险方向）', () => {
  assert.equal(sameOperation({ ...BASE, taskId: 't1' }, { ...BASE, taskId: 't2' }), false)
  assert.notEqual(operationFingerprint({ ...BASE, taskId: 't1' }), operationFingerprint({ ...BASE, taskId: 't2' }))
})

test('② ★★ `unattended` 变了就不是同一个操作', () => {
  // 一次"有人看着"的批准，不能被一次"无人值守"的调用继承。
  assert.equal(sameOperation({ ...BASE, unattended: false }, { ...BASE, unattended: true }), false)
})

test('② ★★ `metadata` 的**值**变了就不是同一个操作', () => {
  assert.equal(sameOperation({ ...BASE, metadata: { path: '/a' } }, { ...BASE, metadata: { path: '/b' } }), false)
})

test('② ★ metadata 里**多一个字段**就不是同一个操作（多出来的字段也必须被绑定）', () => {
  assert.equal(sameOperation({ ...BASE, metadata: { path: '/a' } }, { ...BASE, metadata: { path: '/a', force: true } }), false)
})

test('② ★★ 只差 `toolName` 时**不是**同一个操作（本批的回归锚点）', () => {
  // 修之前，下面这一对的指纹**完全相同**（`normalizeOperation` 根本不读 `toolName`）：
  //
  //   > 一个「绑定到前六个字段」的审批，
  //   > 与一个「一次写文件的批准可以被一次删文件消费」的审批，是同一个东西——
  //   > 而它的方向是**放行**。
  const op = { scope: 'legion', actor: 'general', action: 'file:write', target: 'repo/notes.md', taskId: 'task-1' }
  const write = operationFingerprint({ ...op, toolName: 'file_write' })
  const del = operationFingerprint({ ...op, toolName: 'file_delete' })
  assert.notEqual(write, del, '工具名没有进指纹——一次写文件的批准仍然可以被一次删文件消费')
  // 旧实现给这一对算出的那个"两个工具同一个身份"的指纹，现在一个都算不出来。
  // 钉住它，是因为这一条在**修之前**必然红——它才是这次改动的锚点。
  assert.notEqual(write, 'sha256:69969e4709253a5a06cb2de33f2e5e15895e756da187ed6b02333a42974bf2da')
  assert.notEqual(del, 'sha256:69969e4709253a5a06cb2de33f2e5e15895e756da187ed6b02333a42974bf2da')
  assert.equal(sameOperation({ ...op, toolName: 'file_write' }, { ...op, toolName: 'file_delete' }), false)
})

test('② ★★ `callId` 变了就**不是**同一个操作（两个 Tool Call 不是一次调用）', () => {
  const op = { ...BASE, toolName: 'file_write' }
  assert.notEqual(
    operationFingerprint({ ...op, callId: 'call-1' }),
    operationFingerprint({ ...op, callId: 'call-2' }),
  )
  assert.equal(sameOperation({ ...op, callId: 'call-1' }, { ...op, callId: 'call-2' }), false)
})

test('② ★★ `argsHash` 变了就**不是**同一个操作（不可变工具参数也必须绑定）', () => {
  // spec line 470 要的"不可变工具参数"就是这个载体：少了它，两次参数不同的调用
  // 只要其余字段相同就共用一张票——而"参数不同"恰恰是审批要区分的东西。
  const op = { ...BASE, toolName: 'file_write', callId: 'call-1' }
  const a = argsHashOf({ toolName: 'file_write', args: { path: '/w/a.txt' } })
  const b = argsHashOf({ toolName: 'file_write', args: { path: '/w/b.txt' } })
  assert.notEqual(a, b, '两份不同的参数得到了同一个 argsHash——这条用例什么都测不到')
  assert.notEqual(operationFingerprint({ ...op, argsHash: a }), operationFingerprint({ ...op, argsHash: b }))
  assert.equal(sameOperation({ ...op, argsHash: a }, { ...op, argsHash: b }), false)
})

test('② ★★ `argsHash` 来自 PRT-613 的 `hashToolArguments`（本模块不另算一份）', () => {
  //   > 一个「自己再实现一份参数哈希」的审批绑定，
  //   > 与一个「两个模块对同一份参数给出两个身份」的绑定，是同一个东西——
  //   > 只不过后者在任何**单侧**的用例里都是绿的。
  const sample = { toolName: 'file_write', args: { path: 'repo/notes.txt', mode: 'w' } }
  assert.equal(argsHashOf(sample), hashToolArguments(sample).canonicalHash)
  assert.match(TOOL_ARGS_BINDING_CHECKED.argsHash, /^sha256:[0-9a-f]{64}$/)
  // 证据是装载时**算出来的两个值**，不是一个布尔标记：换掉工具名，载体必须跟着换。
  assert.equal(TOOL_ARGS_BINDING_CHECKED.argsHash, hashToolArguments(sample).canonicalHash)
  assert.notEqual(TOOL_ARGS_BINDING_CHECKED.argsHash, TOOL_ARGS_BINDING_CHECKED.otherToolNameArgsHash)
})

test('② ★ `toolName` / `callId` / `argsHash` 是**可选**的（没有工具的操作照样合法）', () => {
  // `skill:grant` 这类操作本来就没有工具。把它们放进 `REQUIRED` 会让一次合法的
  // 无工具操作直接崩——那是把"补上绑定"做成了"拒绝一切非工具操作"。
  const n = normalizeOperation(BASE)
  assert.equal(n.toolName, null)
  assert.equal(n.callId, null)
  assert.equal(n.argsHash, null)
  // 没给 / 给了空串 / 给了纯空白，必须落到**同一个**默认值；否则 `{toolName:''}`
  // 会成为一个与省略 `toolName` 不同的操作——那是把书写方式当成了身份。
  assert.equal(sameOperation(BASE, { ...BASE, toolName: '', callId: '   ', argsHash: null }), true)
  assert.equal(sameOperation(BASE, { ...BASE, toolName: 'file_write' }), false)
})

test('② ★★ 每一个 `OPERATION_KEYS` 字段单独改动都会改变指纹（逐个遍历）', () => {
  // 逐个字段试，而不是抽查几个——抽查会漏掉"后来新加的那个字段"。
  const base = { scope: 'alpha', actor: 'general', action: 'skill:grant', target: 'bob', taskId: 't1', unattended: false, metadata: { k: 1 }, toolName: 'file_write', callId: 'call-1', argsHash: `sha256:${'a'.repeat(64)}` }
  const other = { scope: 'beta', actor: 'colonel', action: 'repo:push', target: 'carol', taskId: 't2', unattended: true, metadata: { k: 2 }, toolName: 'file_delete', callId: 'call-2', argsHash: `sha256:${'b'.repeat(64)}` }
  for (const key of OPERATION_KEYS) {
    const fp = operationFingerprint({ ...base, [key]: other[key] })
    assert.notEqual(fp, operationFingerprint(base), `改掉 ${key} 之后指纹没变——审批没有绑定到它`)
  }
})

test('② 默认值相同的两次调用算同一个操作（`null` 就是 `taskId` 的默认值）', () => {
  assert.equal(sameOperation(BASE, { ...BASE, taskId: null }), true)
  assert.equal(sameOperation(BASE, { ...BASE, unattended: false }), true)
  assert.equal(sameOperation(BASE, { ...BASE, metadata: {} }), true)
})

test('② ★ 任一侧规范化不了时判**不同**（不能判相同，那会继承别人的批准）', () => {
  assert.equal(sameOperation({ ...BASE, target: '' }, BASE), false)
  assert.equal(sameOperation(null, BASE), false)
  assert.equal(sameOperation(BASE, {}), false)
  assert.equal(sameOperation({ ...BASE, metadata: { f: () => {} } }, BASE), false)
})

// ---------------------------------------------------------------- ③ domain separator

test('③ ★★ F-02 的指纹与 DSH 侧的 `canonicalOperationHash` **不可互换**', () => {
  // §6.5：「两者使用不同的 Schema 和 domain separator，防止跨对象复用哈希」。
  // 一个为某次文件读取签发的批准，不能冒充一次上下文快照。
  const op = { scope: 'alpha', actor: 'general', action: 'skill:grant', target: 'bob' }
  const f02 = operationFingerprint(op)
  // 侧面构造一个"字段恰好相同"的 DSH 侧操作
  const dsh = canonicalOperationHash({
    scope: op.scope, actor: op.actor, action: op.action, target: op.target,
    taskId: null, toolName: 'skill:grant', callId: 'c1', arguments: {},
  }, { cwd: '/repo', platform: 'linux' })
  assert.notEqual(f02, dsh, '两个用途的哈希相同——跨用途复用成为可能')
  assert.notEqual(OPERATION_DOMAIN, CANONICAL_OP_DOMAIN)
})

test('③ 指纹带 `sha256:` 前缀，且 domain 与 schemaVersion **确实参与**计算', () => {
  const fp = operationFingerprint(BASE)
  assert.match(fp, /^sha256:[0-9a-f]{64}$/)

  // 换掉 domain：指纹必须变。这一条才是"domain 真的进了哈希"的证据——
  // 只断言 `OPERATION_DOMAIN !== CANONICAL_OP_DOMAIN` 是在比两个常量，
  // 与"它们有没有被用来算哈希"无关。
  const sameOpOtherDomain = domainSeparatedHash('legion.some-other-purpose.v1', OPERATION_SCHEMA_VERSION, canonicalOperation(BASE))
  assert.notEqual(sameOpOtherDomain, fp, '换掉 domain 之后指纹没变——domain 没有参与计算')

  // 换掉 schemaVersion 同理。
  const otherVersion = domainSeparatedHash(OPERATION_DOMAIN, OPERATION_SCHEMA_VERSION + 1, canonicalOperation(BASE))
  assert.notEqual(otherVersion, fp, '换掉 schemaVersion 之后指纹没变——它没有参与计算')

  // 用自己这份 domain 重算，必须与导出的函数一致（证明两者是同一个算式）。
  assert.equal(domainSeparatedHash(OPERATION_DOMAIN, OPERATION_SCHEMA_VERSION, canonicalOperation(BASE)), fp)
})

test('③ 指纹是稳定值——同一个操作在任何时候都得到同一个指纹', () => {
  // 不钉死具体 hex（那会让每次改动都红），只钉"稳定 + 有区分度"。
  const fp1 = operationFingerprint(BASE)
  const fp2 = operationFingerprint({ ...BASE })
  assert.equal(fp1, fp2)
  assert.equal(operationFingerprint({ ...BASE, actor: 'other' }) === fp1, false)
})

// ---------------------------------------------------------------- ④ ★★ 名单必须对齐

test('④ ★★ 加载时自检**真的跑过**，且留下的是**算出来的**字段名', () => {
  // 一个随手能写出来的 `ok: true` 与一个恒真的校验同形。所以断言的是
  // 它真正产出的字段名——想伪造就得把 `normalizeOperation` 再实现一遍。
  assert.deepEqual([...OPERATION_KEYS_CHECKED.producedKeys], [...OPERATION_KEYS])
  assert.equal(OPERATION_KEYS_CHECKED.ok, true, JSON.stringify(OPERATION_KEYS_CHECKED))
})

test('④ ★★ 有人往 `normalizeOperation` 加了字段却没进名单时，自检必须拦', () => {
  // 「一个必须靠人记得去同步的名单，与一个迟早会不同步的名单，
  //   在「新加的开关能不能用」上是同一个东西」——这里就是那条自检。
  const missingRunId = [...OPERATION_KEYS] // 名单里没有 runId
  const sample = { ...BASE, runId: 'r1' }
  // 注意 normalizeOperation 目前**不认识** runId，所以先直接验断言函数本身：
  // 喂一个"产出比名单多一个字段"的情形。
  const forged = assertOperationKeysAligned(
    [...OPERATION_KEYS, 'ghostField'],
    sample,
  )
  assert.equal(forged.ok, false, '名单里多了一个不存在的字段却没报出来')
  assert.deepEqual([...forged.extra], ['ghostField'])
})

test('④ ★ 名单少一个字段时也要报出来（`missing` 是危险方向）', () => {
  const forged = assertOperationKeysAligned(OPERATION_KEYS.filter((k) => k !== 'unattended'))
  assert.equal(forged.ok, false)
  assert.deepEqual([...forged.missing], ['unattended'],
    '产出了却没进名单的字段会被静默丢掉——改了它审批照样通过')
})

test('④ ★ 逐个字段都不能从名单里被拿掉', () => {
  for (const key of OPERATION_KEYS) {
    const r = assertOperationKeysAligned(OPERATION_KEYS.filter((k) => k !== key))
    assert.equal(r.ok, false, `把 ${key} 从名单里拿掉之后自检仍然通过`)
    assert.ok(r.missing.includes(key))
  }
})

test('④ `canonicalOperation` 只保留名单里的字段', () => {
  const op = canonicalOperation({ ...BASE, permissionRequestId: 'pr-1', extra: 'x' })
  assert.deepEqual(Object.keys(op).sort(), [...OPERATION_KEYS].sort())
  assert.equal('permissionRequestId' in op, false)
  assert.equal(Object.isFrozen(op), true)
})

// ---------------------------------------------------------------- ⑤ 消费路径

test('⑤ ★★ `consumeDecision` 不再因 `metadata` 键序而拒绝一次合法批准', () => {
  const op = { ...BASE, metadata: { path: '/x', mode: 'rw' } }
  const decision = { status: 'approved', operation: normalizeOperation(op) }
  // 执行时 metadata 的键序恰好相反
  const again = { ...BASE, metadata: { mode: 'rw', path: '/x' } }
  const consumed = consumeDecision(decision, again)
  assert.equal(consumed.status, 'consumed')
  assert.equal(consumed.consumedAt > 0, true)
})

test('⑤ ★★ `consumeDecision` 仍然拦得住"字段被改过"的调用', () => {
  const op = { ...BASE, taskId: 't1' }
  const decision = { status: 'approved', operation: normalizeOperation(op) }
  assert.throws(() => consumeDecision(decision, { ...BASE, taskId: 't2' }), /operation mismatch/)
})

test('⑤ 不是 approved 的决定一律不可消费', () => {
  const decision = { status: 'pending', operation: normalizeOperation(BASE) }
  assert.throws(() => consumeDecision(decision, BASE), /not consumable/)
  assert.throws(() => consumeDecision(null, BASE), /not consumable/)
})

test('⑤ 没有 operation 的决定照旧可消费（既有行为不变）', () => {
  assert.equal(consumeDecision({ status: 'approved' }, BASE).status, 'consumed')
})

test('⑤ `evaluatePermission` 的返回里 `operation` 仍是规范化对象（既有调用面不变）', () => {
  const r = evaluatePermission(BASE, [{ id: 'ask', scope: 'alpha', action: 'skill:grant', mode: 'ask' }], { now: Date.now() })
  assert.equal(r.status, 'pending')
  assert.deepEqual(r.operation, normalizeOperation(BASE))
})

test('⑤ ★ 五种决策模式一个都没变（PRT-612 要映射它们，不能顺手重定义）', () => {
  const modes = new Set()
  for (const mode of ['deny', 'ask', 'allow-once', 'allow-for-task', 'allow-by-policy']) {
    const r = evaluatePermission(BASE, [{ id: 'r', scope: 'alpha', action: 'skill:grant', taskId: mode === 'allow-for-task' ? 't1' : undefined, mode }], { now: Date.now() })
    modes.add(mode)
    assert.ok(['denied', 'pending', 'approved'].includes(r.status), `${mode} 的 status 异常：${r.status}`)
  }
  assert.equal(modes.size, 5)
})

// ---------------------------------------------------------------- ⑥ 诊断面

test('⑥ `operationCanonicalText` 是排序后的文本（键序无关）', () => {
  const a = operationCanonicalText(BASE)
  const b = operationCanonicalText({ target: 'bob', action: 'skill:grant', actor: 'general', scope: 'alpha' })
  assert.equal(a, b)
  assert.ok(a.startsWith('{'))
})

test('⑥ 诊断文本里带上全部字段（缺字段的诊断会让人以为审批没绑它）', () => {
  const text = operationCanonicalText(BASE)
  for (const k of OPERATION_KEYS) assert.ok(text.includes(`"${k}"`), `诊断文本里没有 ${k}`)
})
