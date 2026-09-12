// ============================================================================
// PRT-712 的判据。
//
// 这一组盯的**不是**"九个指标算得对不对"，而是**读不出来时会不会显示成 0**。
//
// 一个仪表盘把读不到的指标画成 0，与一个把"着火了"画成绿色的仪表盘，
// 在"值班的人会不会去看一眼"上是同一个东西——而且前者更糟：
// 它看起来是**有读数**的，所以没人会去怀疑它。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  METRIC_CODES,
  METRIC_DEFS,
  METRIC_KEYS,
  computeMetrics,
  metricsSummary,
  readMetrics,
  renderMetrics,
} from './metrics.mjs'

/** 一份"什么都有"的完整快照。 */
function fullSnapshot(over = {}) {
  return {
    'queue-depth': 4,
    'oldest-pending-age-ms': 90_000,
    'active-leases': 2,
    'dead-letter-count': 1,
    'upgrade-result': 'succeeded',
    leasesExpired: 1,
    leasesTotal: 10,
    attemptsRetried: 2,
    attemptsTotal: 8,
    upMs: 900,
    observedMs: 1000,
    modelErrors: 3,
    modelCalls: 100,
    ...over,
  }
}

// ── 定义表 ──────────────────────────────────────────────────────────────────

test('① 九个指标一个都不少，且**顺序**与 spec §6.6 逐字一致', () => {
  assert.deepEqual([...METRIC_KEYS], [
    'queue-depth',
    'oldest-pending-age-ms',
    'active-leases',
    'lease-expiry-rate',
    'attempt-retry-rate',
    'dead-letter-count',
    'runtime-availability',
    'model-error-rate',
    'upgrade-result',
  ])
})

test('① 每个指标都有标签、说明与单位（`state` 类的单位是 null）', () => {
  for (const k of METRIC_KEYS) {
    const d = METRIC_DEFS[k]
    assert.equal(d.key, k)
    assert.ok(typeof d.label === 'string' && d.label.length > 0, k)
    assert.ok(typeof d.hint === 'string' && d.hint.length > 0, `${k} 没有说明`)
    if (d.kind === 'state') assert.equal(d.unit, null)
    else assert.ok(typeof d.unit === 'string', `${k} 没有单位`)
  }
  assert.equal(Object.isFrozen(METRIC_DEFS), true)
})

test('① 比值的定义必须指名分子与分母（否则"读不出来"无从判断）', () => {
  for (const k of METRIC_KEYS) {
    const d = METRIC_DEFS[k]
    if (d.kind !== 'ratio') continue
    assert.equal(Array.isArray(d.ratioOf) && d.ratioOf.length === 2, true, `${k} 没指名 ratioOf`)
  }
})

// ── ★ 核心：读不出来 ≠ 0 ────────────────────────────────────────────────────

test('② ★ 缺读数时**值是 null 而不是 0**，且带原因', () => {
  const m = computeMetrics({})
  for (const k of METRIC_KEYS) {
    // 「升级结果」没有 notApplicable 判据，同样是 null
    assert.equal(m[k].value, null, `${k} 缺读数时给了 ${JSON.stringify(m[k].value)}`)
    assert.equal(m[k].known, false)
    assert.ok(m[k].reasonText && m[k].reasonText.length > 0, `${k} 没说明为什么读不出来`)
  }
})

test('② ★ 真的 0 与「读不出来」是**两个不同的东西**（这是本模块存在的理由）', () => {
  const realZero = computeMetrics(fullSnapshot({ 'queue-depth': 0, 'active-leases': 0 }))
  assert.equal(realZero['queue-depth'].value, 0)
  assert.equal(realZero['queue-depth'].known, true)
  assert.equal(realZero['queue-depth'].display, '0 个')

  const noData = computeMetrics(fullSnapshot({ 'queue-depth': null }))
  assert.equal(noData['queue-depth'].value, null)
  assert.equal(noData['queue-depth'].known, false)
  assert.equal(noData['queue-depth'].display, '—')
  assert.notEqual(noData['queue-depth'].display, realZero['queue-depth'].display,
    '「0 个」与「—」在显示上必须不同，否则渲染层会把它们混起来')
})

test('② ★ 渲染时未知一律是「—」+ 原因，**绝不**是 0', () => {
  const lines = renderMetrics({ metrics: computeMetrics({ 'queue-depth': 0 }) })
  const joined = lines.join('\n')
  const qLine = lines.find((l) => l.startsWith('队列深度'))
  assert.equal(qLine, '队列深度：0 个', '真的 0 要显示成 0')
  const leaseLine = lines.find((l) => l.startsWith('活跃 lease'))
  assert.ok(leaseLine.includes('—'), leaseLine)
  assert.ok(!leaseLine.includes('0'), `未知被渲染成了 0：${leaseLine}`)
  assert.ok(joined.includes('没有读到这个指标'), '要说明为什么')
})

test('② `null` / `NaN` / `Infinity` / 字符串 / 布尔 都算读不出来', () => {
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, '3', true, {}, []]) {
    const m = computeMetrics(fullSnapshot({ 'queue-depth': bad }))
    assert.equal(m['queue-depth'].value, null,
      `${JSON.stringify(bad)} 被当成了读数：${JSON.stringify(m['queue-depth'].value)}`)
    assert.equal(m['queue-depth'].known, false)
  }
})

test('② 负读数算读不出来（一个 -1 个任务是没有意义的）', () => {
  const m = computeMetrics(fullSnapshot({ 'active-leases': -1 }))
  assert.equal(m['active-leases'].value, null)
  assert.ok(m['active-leases'].reasonText.includes('负'))
})

// ── ★ 比值的分母为 0 ────────────────────────────────────────────────────────

test('③ ★ 分母为 0 时比值是 null，**不是 0%**（"还没有观察过"≠"没有失败"）', () => {
  // 这正是"上线第一天，错误率 0%，一切正常"这句话的来历。
  const m = computeMetrics(fullSnapshot({ modelErrors: 0, modelCalls: 0 }))
  assert.equal(m['model-error-rate'].value, null,
    '0/0 被算成了 0%：那说的是"没有失败"，而事实是"还没有观察过"')
  assert.equal(m['model-error-rate'].known, false)
  assert.equal(m['model-error-rate'].reason, METRIC_CODES.NO_OBSERVATIONS)
  assert.ok(m['model-error-rate'].reasonText.includes('还没有观察过'))
  assert.ok(m['model-error-rate'].reasonText.includes('不是'), '要写明它不是什么')
})

test('③ 分子为 0 而分母不为 0 时**是**真的 0%（这条不能一起被防掉）', () => {
  const m = computeMetrics(fullSnapshot({ modelErrors: 0, modelCalls: 50 }))
  assert.equal(m['model-error-rate'].value, 0)
  assert.equal(m['model-error-rate'].known, true)
  assert.equal(m['model-error-rate'].display, '0.0%')
})

test('③ ★ 分子大于分母时**不硬算、也不截成 100%**（那是替它编一个数）', () => {
  const m = computeMetrics(fullSnapshot({ leasesExpired: 11, leasesTotal: 10 }))
  assert.equal(m['lease-expiry-rate'].value, null)
  assert.equal(m['lease-expiry-rate'].reason, METRIC_CODES.READ_FAILED)
  assert.ok(m['lease-expiry-rate'].reasonText.includes('不是同一口径') ||
    m['lease-expiry-rate'].reasonText.includes('分子大于分母'))
})

test('③ 比值缺任一侧都算读不出来（只给分子不给分母是不够的）', () => {
  const a = computeMetrics(fullSnapshot({ modelCalls: undefined }))
  assert.equal(a['model-error-rate'].value, null)
  assert.ok(a['model-error-rate'].reasonText.includes('modelCalls'), a['model-error-rate'].reasonText)
})

test('③ 比值读数不是有限数时算读不出来', () => {
  const m = computeMetrics(fullSnapshot({ modelErrors: NaN, modelCalls: 10 }))
  assert.equal(m['model-error-rate'].value, null)
})

test('③ 比值的显示保留一位小数（给人看的方向性读数）', () => {
  const m = computeMetrics(fullSnapshot({ modelErrors: 3, modelCalls: 100 }))
  assert.equal(m['model-error-rate'].display, '3.0%')
  const n = computeMetrics(fullSnapshot({ upMs: 900, observedMs: 1000 }))
  assert.equal(n['runtime-availability'].display, '90.0%')
})

// ── 「此刻不适用」是第三种结果 ──────────────────────────────────────────────

test('④ ★ 空队列时"最老待办年龄"是**不适用**，不是 0 毫秒', () => {
  // 显示 0 秒会让人以为"刚有任务进来"。
  const m = computeMetrics(fullSnapshot({ 'queue-depth': 0, 'oldest-pending-age-ms': 0 }))
  assert.equal(m['oldest-pending-age-ms'].value, null)
  assert.equal(m['oldest-pending-age-ms'].reason, METRIC_CODES.NOT_APPLICABLE)
  assert.ok(m['oldest-pending-age-ms'].reasonText.includes('queue-empty'))
})

test('④ 队列非空时"最老待办年龄"照常给读数（不适用判据不能过头）', () => {
  const m = computeMetrics(fullSnapshot({ 'queue-depth': 3, 'oldest-pending-age-ms': 5000 }))
  assert.equal(m['oldest-pending-age-ms'].value, 5000)
  assert.equal(m['oldest-pending-age-ms'].display, '5000 毫秒')
})

test('④ 队列深度本身读不出来时，"年龄"也是不适用而非数字（判据依赖一个未知量）', () => {
  const m = computeMetrics(fullSnapshot({ 'queue-depth': null, 'oldest-pending-age-ms': 0 }))
  assert.notEqual(m['oldest-pending-age-ms'].known, true)
})

// ── 类别值（升级结果）──

test('⑤ 升级结果的四个取值都能翻译成中文', () => {
  const want = { succeeded: '成功', failed: '失败', 'rolled-back': '已回滚', 'never-run': '从未执行' }
  for (const [v, text] of Object.entries(want)) {
    const m = computeMetrics(fullSnapshot({ 'upgrade-result': v }))
    assert.equal(m['upgrade-result'].value, v)
    assert.equal(m['upgrade-result'].display, text)
    assert.equal(m['upgrade-result'].known, true)
  }
  assert.equal(METRIC_DEFS['upgrade-result'].allowed.length, 4)
})

test('⑤ ★ 没见过的升级结果**不**翻译成最接近的那一个（猜出来的"成功"会让人收工）', () => {
  const m = computeMetrics(fullSnapshot({ 'upgrade-result': 'partially-succeeded' }))
  assert.equal(m['upgrade-result'].value, null)
  assert.equal(m['upgrade-result'].known, false)
  assert.ok(m['upgrade-result'].reasonText.includes('不是一个已知取值'))
})

test('⑤ 升级结果缺失时是"还没有读到"，不是"从未执行"', () => {
  // 这两件事不一样：前者是读不到，后者是确实没跑过。
  const m = computeMetrics(fullSnapshot({ 'upgrade-result': null }))
  assert.equal(m['upgrade-result'].value, null)
  assert.ok(m['upgrade-result'].reasonText.includes('还没有读到'))
})

// ── 异步读数：一个坏了不能拖垮全部 ──────────────────────────────────────────

test('⑥ ★ 一个读数点抛错时，**只有那一个**指标未知，其余照常', async () => {
  const r = await readMetrics({
    ...fullSnapshot(),
    'dead-letter-count': () => { throw new Error('库被锁了') },
  })
  assert.equal(r.metrics['dead-letter-count'].known, false)
  assert.equal(r.metrics['dead-letter-count'].value, null)
  assert.equal(r.metrics['queue-depth'].known, true, '一个坏掉的读数点不该让整个仪表盘消失')
  assert.equal(r.metrics['queue-depth'].value, 4)
})

test('⑥ ★ 读数点失败有**单独的诊断码**，与"没有数据"分开（一个是坏了，一个是空的）', async () => {
  const r = await readMetrics({ 'dead-letter-count': () => { throw new Error('库被锁了') } })
  const d = r.diagnostics.find((x) => x.reader === 'dead-letter-count')
  assert.ok(d, '读数点失败没有被报出来')
  assert.equal(d.code, METRIC_CODES.READ_FAILED)
  assert.notEqual(d.code, METRIC_CODES.NO_DATA,
    '「坏了」与「空的」必须是两个码，否则排障时无法区分')
  assert.ok(d.message.includes('库被锁了'), d.message)
})

test('⑥ 算出来是未知的也要有诊断（界面上一个「—」要有对应的解释）', async () => {
  const r = await readMetrics({ 'queue-depth': 2 })
  const codes = r.diagnostics.map((d) => d.code)
  assert.ok(codes.includes(METRIC_CODES.NO_DATA), `缺 NO_DATA 诊断：${codes.join(',')}`)
})

test('⑥ "此刻不适用"**不算**告警（那是正常状态，报出来只会让日志变吵）', async () => {
  const r = await readMetrics({ 'queue-depth': 0, 'oldest-pending-age-ms': 0 })
  const codes = r.diagnostics.map((d) => d.code)
  assert.ok(!codes.includes(METRIC_CODES.NOT_APPLICABLE), codes.join(','))
})

test('⑥ 读数点是同步值时也能用（不必都包成函数）', async () => {
  const r = await readMetrics({ 'queue-depth': 7 })
  assert.equal(r.metrics['queue-depth'].value, 7)
})

test('⑥ `logger` 收到读数点失败，便于排障', async () => {
  const seen = []
  await readMetrics({ 'queue-depth': () => { throw new Error('boom') } }, { logger: (m) => seen.push(m) })
  assert.equal(seen.length, 1)
  assert.ok(seen[0].includes('boom'), seen[0])
})

test('⑥ `unknownCount` 数得对，且是冻结的', async () => {
  const r = await readMetrics(fullSnapshot())
  assert.equal(r.unknownCount, 0, '完整快照不该有未知指标')
  assert.equal(Object.isFrozen(r), true)
  assert.equal(Object.isFrozen(r.metrics), true)
  assert.equal(Object.isFrozen(r.diagnostics), true)
})

test('⑥ 完整快照下九个指标全部有读数（正向对照）', async () => {
  const r = await readMetrics(fullSnapshot())
  for (const k of METRIC_KEYS) {
    assert.equal(r.metrics[k].known, true, `${k} 在完整快照下却是未知：${r.metrics[k].reasonText}`)
  }
})

// ── 摘要（给 PRT-713 的心跳用）──

test('⑦ ★ 摘要里**不含**读不出来的指标（填 0 会让远端把它当成真实读数）', async () => {
  const r = await readMetrics(fullSnapshot({ 'dead-letter-count': null }))
  const s = metricsSummary(r)
  assert.equal('dead-letter-count' in s, false,
    '未知的指标进了摘要：远端收到一个 0，而这正是本模块通篇要防的事')
  assert.equal('queue-depth' in s, true)
})

test('⑦ 摘要带观察计数（远端能知道这份摘要有多完整）', async () => {
  const r = await readMetrics(fullSnapshot({ 'dead-letter-count': null }))
  const s = metricsSummary(r)
  assert.equal(s.observedMetrics, 8)
  assert.equal(s.totalMetrics, 9)
})

test('⑦ ★ 摘要只含数与类别值，**不含标签/路径/任务名**（心跳是最省事的外流通道）', async () => {
  const r = await readMetrics(fullSnapshot())
  const s = metricsSummary(r)
  const allowed = new Set([...METRIC_KEYS, 'observedMetrics', 'totalMetrics'])
  for (const k of Object.keys(s)) {
    assert.ok(allowed.has(k), `摘要里出现了不该有的键：${k}`)
  }
  // 值的形状：数字或短类别值，绝不是一个路径或一句话
  for (const k of METRIC_KEYS) {
    if (!(k in s)) continue
    const v = s[k]
    if (typeof v === 'string') {
      assert.ok(METRIC_DEFS[k].allowed.includes(v), `${k} 的字符串值不是受控类别：${v}`)
      assert.ok(v.length < 32, `${k} 的值太长，像是被塞进了自由文本`)
    } else {
      assert.equal(typeof v, 'number', `${k} 的值形状不对`)
    }
  }
})

test('⑦ 摘要与渲染都是冻结的（渲染层改它不会影响别的调用方）', () => {
  const r = { metrics: computeMetrics(fullSnapshot()) }
  assert.equal(Object.isFrozen(renderMetrics(r)), true)
  assert.equal(Object.isFrozen(metricsSummary(r)), true)
  const lines = renderMetrics(r)
  assert.equal(lines.length, METRIC_KEYS.length)
})

// ── 不可变性 ────────────────────────────────────────────────────────────────

test('⑧ 指标对象是冻结的，`computeMetrics` 每次返回新对象', () => {
  const a = computeMetrics(fullSnapshot())
  const b = computeMetrics(fullSnapshot())
  assert.equal(Object.isFrozen(a), true)
  assert.equal(Object.isFrozen(a['queue-depth']), true)
  assert.notEqual(a, b)
  assert.notEqual(a['queue-depth'], b['queue-depth'])
})

test('⑧ `computeMetrics` 不改动传入的快照（读数与计算必须分开）', () => {
  const snap = fullSnapshot()
  const before = JSON.stringify(snap)
  computeMetrics(snap)
  assert.equal(JSON.stringify(snap), before)
})
