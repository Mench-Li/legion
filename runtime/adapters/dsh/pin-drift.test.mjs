// runtime/adapters/dsh/pin-drift.test.mjs
// ============================================================================
// `pin-drift` 的判据（T9，2026-09-24）。
//
// 门禁 `scripts/prt/dsh-pin-drift.mjs` 回答的是「**声明的**锚点今天还在不在」。
// 它有一个**看不见**的方向，是 T9 的变异探针当场撞出来的：
//
//   把一条结论的锚点数组从 2 个删成 1 个 ⇒ 门禁照样 PASS（15 → 14 个锚点）。
//
//   > 一条"引用了两句话"的结论与一条"引用了同一句话、而另一句被悄悄删掉"的结论，
//   > 在只看门禁读数的世界里是同一个绿 —— 只不过后者的证据**比看起来弱**。
//
// 所以这里补的是**强度**这一维：锚点数是**声明的强度**，它被显式钉住；
// 删一条就必须同时改这张表（那一步在 diff 里看得见）。
//
// ★ 与 W-3 的 `host-plane.manifest.json`、W-4 的"八条闭集"是同一条纪律：
//   一个"当时想到几条就写几条"的声明集，与一个"声明集被钉住"的声明集，
//   在只有前者的读数上是同一个绿。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkDshPins, pinnedSources } from './pin-drift.mjs'
import { resolveDshCheckout } from '../../../scripts/lib/dsh-checkout.mjs'

/**
 * 每条结论**有几条**锚点。★ 这张表是**显式**的：它不推导自锚点数组。
 *
 * 为什么钉"数量"而不是"内容"：内容由门禁在那个检出里逐字核（那是它的强项），
 * 而"是不是少了一条"只有在**数量**上才看得出来。两个读数各管一半。
 */
const ANCHOR_BUDGET = Object.freeze({
  CHILD_POLICY_NOT_INHERITED: 3,
  SET_POLICY_MAY_WRITE_NOTHING: 2,
  POLICY_CHANGE_ALWAYS_SAYS_USER: 2,
  OWNERSHIP_IS_LIVE_ONLY: 3,
  OWNERSHIP_BY_REFERENCE_NOT_BY_ID: 2,
  SENDER_MUST_BE_LIVE_TARGET_NEED_NOT_BE: 3,
})

const here = resolveDshCheckout({ env: process.env, need: 'packages' })
const observed = here.checkout !== null
const result = checkDshPins({ checkoutRoot: here.checkout })

test('① ★★★ 每条结论的**锚点数**被显式钉住（删一条声明 ⇒ 红）', () => {
  const codes = result.rows.map((r) => r.code).sort()
  assert.deepEqual(codes, Object.keys(ANCHOR_BUDGET).sort(),
    '结论集与 ANCHOR_BUDGET 的键集不一致 —— 加了/删了结论，这张表要同时改')
  for (const row of result.rows) {
    assert.equal(row.anchors.length, ANCHOR_BUDGET[row.code],
      `${row.code} 的锚点数从 ${ANCHOR_BUDGET[row.code]} 变成了 ${row.anchors.length}。`
      + '★ 锚点数就是这条引用的**强度**：删掉一条而没改这张表，等于把证据悄悄削薄。'
      + '确实要删：把 ANCHOR_BUDGET 一起改（那一步在 diff 里看得见），并想清楚'
      + '"剩下这几条还够不够支撑这条结论"。')
  }
  assert.equal(result.checkedAnchors, 15, '锚点总数变了')
  assert.equal(result.checkedAnchors, Object.values(ANCHOR_BUDGET).reduce((a, b) => a + b, 0))
})

test('② ★★ 锚点自身不许是"同一个证据算两次"（同一结论内不得重复、不得为空）', () => {
  for (const row of result.rows) {
    const list = row.anchors.map((a) => String(a.anchor ?? a))
    for (const a of list) assert.ok(a.trim().length > 0, `${row.code} 里有一个空锚点`)
    assert.equal(new Set(list).size, list.length,
      `${row.code} 的锚点里有重复：${JSON.stringify(list)} —— 重复的锚点让"两个证据"看起来像两个，`
      + '实际只核了一句话')
  }
})

test('③ ★★★ 未观察时**不许**报"通过"（"没核"与"核过了"必须分开）', () => {
  const none = checkDshPins({ checkoutRoot: null })
  assert.equal(none.observed, false, '没有检出时必须报 observed:false')
  assert.equal(none.ok, false,
    '★ 没有检出却报 ok:true —— 这正是模块文件头点名的那条：'
    + '"没人给观察结果"静默变成"观察结果是空"，报出一个**错的诊断**')
  assert.equal(none.checkedAnchors, 0)
})

test('④ ★★ 被引文件是三份（少一份说明出处被改写；多一份要一起登记）', () => {
  assert.deepEqual(pinnedSources().slice().sort(), [
    'packages/core/agent/src/index.ts',
    'packages/interaction/user-approval/src/index.ts',
    'packages/subagent/subagent/src/continuation.ts',
  ])
})

test('⑤ 本地有检出时：15 个锚点在今天这份检出里逐字命中', (t) => {
  if (!observed) return t.skip('本机没有 DSH 检出 ⇒ 这是"未观察"，不是"通过"')
  assert.equal(result.ok, true,
    `锚点漂了：${JSON.stringify(result.rows.filter((r) => r.anchors.some((a) => a.found === false)))}`)
  assert.equal(result.driftCount, 0)
})
