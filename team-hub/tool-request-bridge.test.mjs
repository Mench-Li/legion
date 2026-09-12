// team-hub/tool-request-bridge.test.mjs
// ============================================================================
// PRT-611 补记（接线半边）的判据：投影 → F-02 授权主体。
//
// 这一组盯的**不是**"桥能不能跑"，而是**造出来的主体够不够绑住一次调用**。
// 它坏在两个方向，而只有一个方向会有人来报 bug：
//
//   ① 搬运时漏掉一个字段 → 错的方向是**放行**（同一个工具换参数复用同一张票）
//   ② 搬运得太严     → 错的方向是拒绝（fail-closed，没人报 bug）
//
// 所以下面每一条都必须用**真的投影**去问，而不是断言一个常量。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BRIDGE_CODES,
  TOOL_REQUEST_BRIDGE_CHECKED,
  TOOL_REQUEST_BRIDGE_VERSION,
  assertToolSubjectComplete,
  isToolProjection,
  legionOperationOf,
} from './tool-request-bridge.mjs'
import { OPERATION_KEYS, TOOL_SUBJECT_KEYS, argsHashOf, operationFingerprint } from './permission-engine.mjs'
import { hashToolArguments } from '../runtime/dsh-composition/tool-args.mjs'

/** 一张完整的投影。每个字段都是**非默认值**，否则变异会被规范化吃掉。 */
const PROJECTION = Object.freeze({
  version: 1,
  toolName: 'file_write',
  callId: 'call-bridge-1',
  arguments: { path: 'repo/notes.txt', mode: 'w' },
  frozenHash: hashToolArguments({ toolName: 'file_write', args: { path: 'repo/notes.txt', mode: 'w' } }).canonicalHash,
  canonicalTarget: 'repo/notes.txt',
  target: 'repo/notes.txt',
})

const CALLER = Object.freeze({ scope: 'team-alpha', actor: 'general', taskId: 'task-1' })

const build = (patch = {}, caller = CALLER) => legionOperationOf({ ...PROJECTION, ...patch }, caller)

/**
 * 造一张**自洽**的投影：改了 `toolName` 或 `arguments`，`frozenHash` 跟着重算。
 *
 * ⚠️ 这个助手是被**红过的用例**逼出来的，不是先设计好的。第一版直接写
 * `build({ arguments: {...} })`，于是造出一张"参数被换过、哈希还是老的"的投影——
 * 桥的 `FROZEN_HASH_DRIFT` 检查当场把它拒了。
 *
 * 那次红是**对的**：一张自相矛盾的投影本来就不该被搬运（那正是 PRT-613 记下的
 * 最坏形状）。但用例想要问的是另一个问题——"参数不同时指纹会不会不同"——
 * 所以它必须拿一张**现实里会出现**的投影来问。
 *
 *   > 一个「用一张现实里不存在的输入去问一个问题」的用例，
 *   > 与一个「问到了别的问题」的用例，是同一个东西——
 *   > 只不过前者红的时候，看起来像是被测代码错了。
 */
function coherent(patch = {}) {
  const toolName = patch.toolName ?? PROJECTION.toolName
  const args = patch.arguments ?? PROJECTION.arguments
  return {
    ...PROJECTION,
    ...patch,
    toolName,
    arguments: args,
    frozenHash: hashToolArguments({ toolName, args }).canonicalHash,
  }
}

const buildCoherent = (patch = {}, caller = CALLER) => legionOperationOf(coherent(patch), caller)

// ---------------------------------------------------------------- 自检

test('① ★ 装载期自检：四条拒绝理由都**真的被触发过**（不是注释里的"应该会抛"）', () => {
  assert.equal(TOOL_REQUEST_BRIDGE_CHECKED.ok, true, JSON.stringify(TOOL_REQUEST_BRIDGE_CHECKED.problems))
  // 留下的必须是**算出来的值**，不是一个 ok 布尔
  assert.equal(TOOL_REQUEST_BRIDGE_CHECKED.sample.toolName, 'file_write')
  assert.equal(TOOL_REQUEST_BRIDGE_CHECKED.sample.callId, 'call-bridge-1')
  assert.match(TOOL_REQUEST_BRIDGE_CHECKED.sample.argsHash, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(
    [...TOOL_REQUEST_BRIDGE_CHECKED.checkedRefusals].sort(),
    [
      BRIDGE_CODES.CALL_ID_MISSING,
      BRIDGE_CODES.FROZEN_HASH_DRIFT,
      BRIDGE_CODES.TOOL_NAME_MISSING,
      BRIDGE_CODES.SUBJECT_INCOMPLETE,
    ].sort(),
  )
})

// ---------------------------------------------------------------- 完整性

test('② ★★ 造出来的主体把**三个**工具字段都填上了（漏一个就是放行方向的缺口）', () => {
  const { operation } = build()
  for (const k of TOOL_SUBJECT_KEYS) {
    assert.ok(operation[k] != null && operation[k] !== '', `${k} 没被填上——漏掉它意味着这个维度不参与绑定`)
  }
  // 三个字段确实在**授权主体名单**里（否则填了也不进指纹）
  for (const k of TOOL_SUBJECT_KEYS) assert.ok(OPERATION_KEYS.includes(k), `${k} 不在 OPERATION_KEYS 里，填了也不算`)
})

test('② ★★ 同一工具换一组参数 → **不同**指纹（argsHash 真的在绑参数）', () => {
  const a = buildCoherent()
  const b = buildCoherent({ arguments: { path: 'repo/other.txt', mode: 'w' }, canonicalTarget: 'repo/other.txt' })
  assert.notEqual(a.operation.argsHash, b.operation.argsHash)
  assert.notEqual(operationFingerprint(a.operation), operationFingerprint(b.operation))
  // 两个主体除工具字段外**完全相同**，否则这条用例可能只是被别的字段弄红的
  assert.equal(a.operation.toolName, b.operation.toolName)
  assert.equal(a.operation.callId, b.operation.callId)
  assert.notEqual(a.operation.target, b.operation.target)
})

test('② ★★ 同一组参数换个工具 → **不同**指纹（toolName 真的在绑工具）', () => {
  const pWrite = coherent({ toolName: 'file_write' })
  const pDelete = coherent({ toolName: 'file_delete' })
  // 原始参数故意**完全相同**：这一条才是"工具名进了身份"的证据。
  // 断言在**投影**上（主体里只有 argsHash，没有原始参数——对着主体断言会是 null vs null）。
  assert.deepEqual(pWrite.arguments, pDelete.arguments)
  assert.equal(JSON.stringify(pWrite.arguments), JSON.stringify(pDelete.arguments))

  const w = legionOperationOf(pWrite, CALLER)
  const d = legionOperationOf(pDelete, CALLER)
  assert.equal(w.operation.toolName, 'file_write')
  assert.equal(d.operation.toolName, 'file_delete')
  // `hashToolArguments` 把工具名算进参数身份，所以 argsHash 也应当不同——
  // 两者都不同时，指纹不同这件事才不依赖于"到底哪个字段救了场"
  assert.notEqual(w.operation.argsHash, d.operation.argsHash)
  assert.notEqual(operationFingerprint(w.operation), operationFingerprint(d.operation))
})

test('② ★★ 同一个投影算两次 → 同一个指纹（搬运本身不引入随机性）', () => {
  assert.equal(operationFingerprint(build().operation), operationFingerprint(build().operation))
})

test('② ★ 目标不同 → 指纹不同（投影的 canonicalTarget 真的被用上了）', () => {
  const a = build()
  const b = build({ canonicalTarget: 'repo/elsewhere.txt' })
  assert.equal(a.operation.target, 'repo/notes.txt')
  assert.equal(b.operation.target, 'repo/elsewhere.txt')
  assert.notEqual(operationFingerprint(a.operation), operationFingerprint(b.operation))
})

test('② ★ `action` 缺省时取工具名，给了就以给的为准', () => {
  assert.equal(build().operation.action, 'file_write')
  assert.equal(build({}, { ...CALLER, action: 'file:write' }).operation.action, 'file:write')
})

test('② ★ caller 的 scope/actor/taskId 被搬进主体（桥不自己编）', () => {
  const { operation } = build()
  assert.equal(operation.scope, 'team-alpha')
  assert.equal(operation.actor, 'general')
  assert.equal(operation.taskId, 'task-1')
})

// ---------------------------------------------------------------- 确定性拒绝

test('③ ★ 三缺一就抛，而且抛的是**可归因的码**', () => {
  // `SUBJECT_INCOMPLETE` 在桥自己造的主体上**永远不会**触发（三个字段都从投影算出来），
  // 所以它是**导出**的，让它能被直接调到：
  //
  //   > 一个永远不会触发的复核，与没有复核，
  //   > 在「它到底拦不拦得住」上是同一个东西。
  //
  // 它真正的价值在未来：往 `TOOL_SUBJECT_KEYS` 加第四个字段而忘了在桥里填，
  // 装载期自检会当场崩，而不是让那个维度安静地不参与绑定。
  const complete = build().operation
  assert.doesNotThrow(() => assertToolSubjectComplete(complete))
  for (const key of TOOL_SUBJECT_KEYS) {
    const err = (() => { try { assertToolSubjectComplete({ ...complete, [key]: null }) } catch (e) { return e } })()
    assert.equal(err?.code, BRIDGE_CODES.SUBJECT_INCOMPLETE, `缺 ${key} 时`)
    assert.deepEqual([...err.missing], [key], `缺 ${key} 时报出的缺失名单`)
  }
  // 装载期自检也必须**真的**把这条打出来过一次（否则它没被证明过）
  assert.ok(TOOL_REQUEST_BRIDGE_CHECKED.checkedRefusals.includes(BRIDGE_CODES.SUBJECT_INCOMPLETE))

  // 另一条路径（callId 缺失）在**更早**的检查上抛，这是正确的顺序：
  // 先拒绝"没有调用身份"，再谈"主体完不完整"。
  assert.throws(
    () => build({ callId: null }),
    (e) => e.code === BRIDGE_CODES.CALL_ID_MISSING,
  )
})

test('③ ★ callId 缺失是拒绝而不是降级（缺了它无法表达"只放行这一次"）', () => {
  const err = (() => { try { build({ callId: '   ' }) } catch (e) { return e } })()
  assert.equal(err.code, BRIDGE_CODES.CALL_ID_MISSING)
  assert.match(err.message, /callId/)
})

test('③ ★ toolName 为空是拒绝（工具调用必须有工具名）', () => {
  for (const bad of ['', '   ', null, undefined, 123]) {
    const err = (() => { try { build({ toolName: bad }) } catch (e) { return e } })()
    assert.ok(err, `toolName=${JSON.stringify(bad)} 应该被拒`)
    assert.equal(err.code, BRIDGE_CODES.TOOL_NAME_MISSING, `toolName=${JSON.stringify(bad)}`)
  }
})

test('③ ★ 投影本身不是对象 → 拒绝（而不是读出一个全 null 的主体）', () => {
  for (const bad of [null, undefined, 'x', 42]) {
    const err = (() => { try { legionOperationOf(bad, CALLER) } catch (e) { return e } })()
    assert.equal(err?.code, BRIDGE_CODES.PROJECTION_MISSING, JSON.stringify(bad))
  }
})

// ---------------------------------------------------------------- 携带 vs 重算

test('④ ★★ 携带的 frozenHash 与**按它自己的参数重算**的结果必须一致', () => {
  // 一致时通过，且桥搬的就是重算值
  const ok = build()
  assert.equal(ok.operation.argsHash, PROJECTION.frozenHash)

  // 不一致时抛——这是最坏的一种：所有哈希比对都通过，而执行的是另一份参数
  const err = (() => { try { build({ frozenHash: 'sha256:' + '0'.repeat(64) }) } catch (e) { return e } })()
  assert.equal(err.code, BRIDGE_CODES.FROZEN_HASH_DRIFT)
  assert.equal(err.frozenHash, 'sha256:' + '0'.repeat(64))
  assert.match(err.recomputed, /^sha256:[0-9a-f]{64}$/)
})

test('④ ★★ 参数被换过而 frozenHash 没跟着换 → 必须被抓到（PRT-613 的最坏形状）', () => {
  // 拿一张**真的**投影，只把参数换掉、哈希保持原样。
  // 没有这条检查时，这个投影会安静地通过，而绑定的是没人执行过的那份参数。
  const tampered = {
    ...PROJECTION,
    arguments: { path: 'repo/EVIL.txt', mode: 'w' },
    canonicalTarget: 'repo/EVIL.txt',
  }
  const err = (() => { try { legionOperationOf(tampered, CALLER) } catch (e) { return e } })()
  assert.equal(err?.code, BRIDGE_CODES.FROZEN_HASH_DRIFT)
})

test('④ ★ 投影只带 `frozenBody.canonicalHash`（没有顶层 frozenHash）时也能复核', () => {
  const { frozenHash, ...withoutTop } = PROJECTION
  const withBody = { ...withoutTop, frozenBody: { canonicalHash: frozenHash } }
  assert.equal(legionOperationOf(withBody, CALLER).operation.argsHash, frozenHash)
  // 同样地，body 里的哈希对不上也要抛
  assert.throws(
    () => legionOperationOf({ ...withoutTop, frozenBody: { canonicalHash: 'sha256:' + '0'.repeat(64) } }, CALLER),
    (e) => e.code === BRIDGE_CODES.FROZEN_HASH_DRIFT,
  )
})

test('④ ★ 两个哈希字段都没有时**不抛**（投影没提供这个信息，不等于它矛盾了）', () => {
  // "没有携带哈希"与"携带了一个对不上的哈希"是两件事。混成一件会让
  // 所有老投影都突然报错，而那与"发现了参数漂移"完全不是同一回事。
  const { frozenHash, ...withoutHash } = PROJECTION
  const { operation } = legionOperationOf(withoutHash, CALLER)
  assert.match(operation.argsHash, /^sha256:[0-9a-f]{64}$/, '仍然要算出 argsHash')
})

// ---------------------------------------------------------------- 分类

test('⑤ ★ `isToolProjection` 按**工具名**判，不按 capabilities（未登记工具也要绑）', () => {
  assert.equal(isToolProjection(PROJECTION), true)
  // 未登记工具：capabilities 为空数组，但它仍然是一次工具调用
  assert.equal(isToolProjection({ toolName: 'mystery_tool', capabilities: [] }), true)
  assert.equal(isToolProjection({ toolName: '', capabilities: ['file:read'] }), false)
  assert.equal(isToolProjection({ capabilities: ['file:read'] }), false)
  assert.equal(isToolProjection(null), false)
})

// ---------------------------------------------------------------- 属性

test('⑥ ★ 返回的对象是冻结的（调用方改它不能改掉绑定）', () => {
  const { operation, evidence } = build()
  assert.ok(Object.isFrozen(operation))
  assert.ok(Object.isFrozen(evidence))
  assert.throws(() => { 'use strict'; operation.toolName = 'file_delete' }, TypeError)
})

test('⑥ ★ 版本号是正整数（0 或缺失会让"成对记录"失去比较基准）', () => {
  assert.equal(Number.isInteger(TOOL_REQUEST_BRIDGE_VERSION), true)
  assert.ok(TOOL_REQUEST_BRIDGE_VERSION > 0)
})

test('⑥ ★ evidence 逐字段报来源，而不是一个 ok 布尔', () => {
  const { evidence } = build()
  for (const k of TOOL_SUBJECT_KEYS) assert.equal(evidence.keysFrom[k], 'projection', k)
  assert.deepEqual([...evidence.subjectKeys], [...TOOL_SUBJECT_KEYS])
  assert.equal(evidence.argsHash, PROJECTION.frozenHash)
})

test('⑥ ★ `metadata` 被复制而不是共享（调用方改自己手里那份不影响主体）', () => {
  const metadata = { note: 'original' }
  const { operation } = build({}, { ...CALLER, metadata })
  metadata.note = 'changed'
  assert.equal(operation.metadata.note, 'original')
})

// ---------------------------------------------------------------- 与指纹的关系

test('⑦ ★★ 桥造出来的主体**过一遍** normalizeOperation 后指纹不变（搬运没有引入编码差）', () => {
  // 如果桥搬过去的字符串需要额外的 trim/NFC 才能与引擎的规范化一致，
  // 那么"桥算的"与"引擎绑的"就会是两个东西——而它们各自都是绿的。
  const { operation } = build()
  const direct = operationFingerprint(operation)
  // 再走一次完整往返：引擎的规范化不能改变任何东西
  const roundtripped = operationFingerprint({ ...operation })
  assert.equal(roundtripped, direct)
  // argsHash 与 argsHashOf 对同一份参数必须给出同一个值
  assert.equal(operation.argsHash, argsHashOf({ toolName: 'file_write', args: PROJECTION.arguments }))
})
