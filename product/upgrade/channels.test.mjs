// ============================================================================
// PRT-810 的判据：internal / canary / stable 三类发布通道的分级放量。
//
// spec §9.2 line 695–701：「canary：少量**明确接受**灰度的用户」。
// 这句话里有两个词——少量（份额）与明确接受（选择加入）——而两类最常见的
// 实现各自只做了半个：
//
//   · 只比 `manifest.channel === 用户选的通道` → 所有把通道设成 canary 的人
//     都拿到灰度版本，包括只是随手点了一下的那些；
//   · 只按版本哈希分桶、不问同意 → 替用户做了决定。
//
//   > 一个"按清单上的通道字段分发"的实现，
//   > 与一个"谁都能把通道改成 canary 从而拿到灰度版本"的实现，是同一个东西。
//
// 第二个盯点是**晋级**：`internal → stable` 的跳级让两道验证网一起失效，
// 而报表上仍然写着"通过了通道晋级"。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CHANNEL_CODES,
  CHANNEL_LABELS,
  CHANNELS_CHECKED,
  DEFAULT_SOAK_DAYS,
  RELEASE_CHANNELS,
  RING_ACCEPTS,
  RINGS,
  assertPromotion,
  canaryBucket,
  isOffered,
  nextChannel,
  planPromotion,
  selectOffered,
} from '../../product/upgrade/channels.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const CANARY_RELEASE = Object.freeze({ version: '0.9.0', channel: 'canary' })

/** 找出落桶 >= percent 与 < percent 的各一个种子（用于驱动"名单内外"两格）。 */
function seedsFor(percent, version = '0.9.0') {
  const inBucket = []
  const outBucket = []
  for (let i = 0; i < 2000 && (inBucket.length === 0 || outBucket.length === 0); i += 1) {
    const seed = `seed-${i}`
    const bucket = canaryBucket({ ringSeed: seed, version })
    if (bucket < percent) inBucket.push(seed)
    else outBucket.push(seed)
  }
  return { inBucket, outBucket }
}

// ── ① 通道与环是两组东西 ────────────────────────────────────────────────────

test('① 三档通道与三档环同名，且接受关系是**单向**的', () => {
  assert.deepEqual([...RELEASE_CHANNELS], ['internal', 'canary', 'stable'])
  assert.deepEqual([...RINGS], ['internal', 'canary', 'stable'])
  assert.equal(Object.keys(CHANNEL_LABELS).length, 3)
  assert.deepEqual([...RING_ACCEPTS.internal].sort(), ['canary', 'internal', 'stable'])
  assert.deepEqual([...RING_ACCEPTS.canary].sort(), ['canary', 'stable'])
  assert.deepEqual([...RING_ACCEPTS.stable], ['stable'])
  // ★ 反向不成立：canary 环拿不到 internal 发布，stable 环拿不到 canary 发布。
  assert.equal(RING_ACCEPTS.canary.includes('internal'), false)
  assert.equal(RING_ACCEPTS.stable.includes('canary'), false)
})

test('① ★★ 「发布通道」与「本地环」是两个字段：stable 环看不到 canary 发布', () => {
  // 即使显式加入了灰度、即使放量 100%，stable 环也不该拿到 canary 版本：
  // 放量比例控制的是 canary 环内部谁先拿到，不是跨环的可见性。
  const r = isOffered({ release: CANARY_RELEASE, ring: 'stable', canaryOptIn: true, canaryPercent: 100 })
  assert.equal(r.offered, false, 'stable 环拿到了 canary 发布')
  assert.equal(r.code, CHANNEL_CODES.NOT_PUBLISHED_FOR_RING)

  const internal = isOffered({
    release: { version: '0.9.0', channel: 'internal' }, ring: 'stable', canaryOptIn: true, canaryPercent: 100,
  })
  assert.equal(internal.offered, false, 'stable 环拿到了内部发布')
  assert.equal(internal.code, CHANNEL_CODES.NOT_PUBLISHED_FOR_RING)
})

test('① ★ 没有发布通道、或通道不认识 → 都不给（不认识的通道不是"稳定"）', () => {
  const none = isOffered({ release: { version: '0.9.0' }, ring: 'internal' })
  assert.equal(none.offered, false)
  assert.equal(none.code, CHANNEL_CODES.NOT_PUBLISHED)

  const unknown = isOffered({ release: { version: '0.9.0', channel: 'nightly' }, ring: 'internal' })
  assert.equal(unknown.offered, false)
  assert.equal(unknown.code, CHANNEL_CODES.NOT_PUBLISHED)
  assert.ok(unknown.reason.includes('nightly'), unknown.reason)
})

test('① ★★ 认不出的环一律拒绝（默认放行会让新加的环自动收到一切）', () => {
  const r = isOffered({ release: CANARY_RELEASE, ring: 'beta', canaryOptIn: true, canaryPercent: 100 })
  assert.equal(r.offered, false)
  assert.equal(r.code, CHANNEL_CODES.RING_UNKNOWN)
  assert.ok(r.reason.includes('beta'), r.reason)
})

// ── ② 分桶是一条真门槛 ──────────────────────────────────────────────────────

test('② ★★ 分桶是确定性的：同一个 (种子, 版本) 永远落同一个桶', () => {
  const a = canaryBucket({ ringSeed: 'machine-1', version: '0.9.0' })
  assert.equal(a, canaryBucket({ ringSeed: 'machine-1', version: '0.9.0' }))
  assert.ok(Number.isInteger(a) && a >= 0 && a < 100, `桶号越界：${a}`)
  // 换版本 → 换桶。否则一个版本进了放量，之后所有版本都跟着进。
  assert.notEqual(a, canaryBucket({ ringSeed: 'machine-1', version: '0.9.1' }))
  // 换机器 → 一般换桶。
  assert.notEqual(a, canaryBucket({ ringSeed: 'machine-2', version: '0.9.0' }))
})

test('② ★★ 放量率是一条真门槛：0% 谁都拿不到，100% 谁都拿得到', () => {
  const seeds = Array.from({ length: 200 }, (_, i) => `seed-${i}`)
  const hit = (percent) => seeds.filter((s) => canaryBucket({ ringSeed: s, version: '0.9.0' }) < percent).length

  assert.equal(hit(0), 0, '放量 0% 时仍然有人拿到了 canary')
  assert.equal(hit(100), 200, '放量 100% 时有人拿不到')
  const half = hit(50)
  assert.ok(half > 60 && half < 140, `放量 50% 时实际命中 ${half}/200，分布不像均匀`)

  // 单调：放量率小的命中集合一定被放量率大的包含。
  const low = seeds.filter((s) => canaryBucket({ ringSeed: s, version: '0.9.0' }) < 10)
  const high = seeds.filter((s) => canaryBucket({ ringSeed: s, version: '0.9.0' }) < 30)
  assert.ok(low.every((s) => high.includes(s)), '放量 10% 的机器不在 30% 的集合里——门槛不单调')
})

// ── ③ canary 的两道门 ───────────────────────────────────────────────────────

test('③ ★★ canary 需要"显式同意"加"真门槛"，两条缺一不可', () => {
  // 门一：没有显式同意。
  const noOptIn = isOffered({ release: CANARY_RELEASE, ring: 'canary', canaryOptIn: false, canaryPercent: 100 })
  assert.equal(noOptIn.offered, false, '没有显式同意就拿到了金丝雀版本')
  assert.equal(noOptIn.code, CHANNEL_CODES.CANARY_NOT_OPTED_IN)

  // 门二：同意了，但落在这一批的名单之外。
  const { outBucket } = seedsFor(50)
  const outside = isOffered({
    release: CANARY_RELEASE, ring: 'canary', canaryOptIn: true, canaryPercent: 50, ringSeed: outBucket[0],
  })
  assert.equal(outside.offered, false, '在放量名单之外却拿到了金丝雀版本')
  assert.equal(outside.code, CHANNEL_CODES.CANARY_OUT_OF_BUCKET)
  assert.ok(outside.bucket >= 50, `落桶 ${outside.bucket} 本该在 50% 之外`)

  // 两道门都过 → 给。
  const { inBucket } = seedsFor(50)
  const inside = isOffered({
    release: CANARY_RELEASE, ring: 'canary', canaryOptIn: true, canaryPercent: 50, ringSeed: inBucket[0],
  })
  assert.equal(inside.offered, true, inside.reason)
  assert.equal(inside.code, CHANNEL_CODES.OFFERED)

  // 同样的名单外种子，放量 100% → 给。证明拦住它的是**比例**而不是别的。
  const all = isOffered({
    release: CANARY_RELEASE, ring: 'canary', canaryOptIn: true, canaryPercent: 100, ringSeed: outBucket[0],
  })
  assert.equal(all.offered, true, '100% 放量时名单外的人仍然拿不到')
})

test('③ ★★ 比例是 0、或没有种子时都不给：抽不出来的分桶与"全部命中"是同一个东西', () => {
  const zero = isOffered({ release: CANARY_RELEASE, ring: 'canary', canaryOptIn: true, canaryPercent: 0 })
  assert.equal(zero.offered, false)
  assert.equal(zero.code, CHANNEL_CODES.CANARY_OUT_OF_BUCKET)
  assert.ok(zero.reason.includes('没有放开'), zero.reason)

  const noSeed = isOffered({
    release: CANARY_RELEASE, ring: 'canary', canaryOptIn: true, canaryPercent: 50, ringSeed: null,
  })
  assert.equal(noSeed.offered, false, '没有种子却被放进了灰度名单')
  assert.equal(noSeed.code, CHANNEL_CODES.CANARY_OUT_OF_BUCKET)
  assert.ok(noSeed.reason.includes('复现'), noSeed.reason)
})

test('③ ★ internal 环自己不受 canary 的两道门限制（它就是发布方）', () => {
  const r = isOffered({ release: CANARY_RELEASE, ring: 'internal', canaryOptIn: false, canaryPercent: 0 })
  assert.equal(r.offered, true, r.reason)
})

// ── ④ 选出可升级的那个 ──────────────────────────────────────────────────────

test('④ ★★ `selectOffered` 在多个可选项里挑**最高**的那个（按版本降序，不是字符串序）', () => {
  const candidates = [
    { version: '0.9.5', channel: 'stable' },
    { version: '0.10.0', channel: 'stable' },
    { version: '0.11.0', channel: 'internal' },
  ]
  const stable = selectOffered(candidates, { ring: 'stable' })
  assert.equal(stable.selected.version, '0.10.0',
    `稳定环选中了 ${stable.selected.version}：字符串比较会把 "0.10.0" 排到 "0.9.5" 后面`)
  assert.deepEqual(stable.offered.map((o) => o.release.version), ['0.10.0', '0.9.5'])
  assert.equal(stable.rejected.some((r) => r.verdict.code === CHANNEL_CODES.NOT_PUBLISHED_FOR_RING), true)

  const internal = selectOffered(candidates, { ring: 'internal' })
  assert.equal(internal.selected.version, '0.11.0')
})

test('④ ★ 已经在跑这个版本（或更新的）时不再提供：不给降级', () => {
  const r = selectOffered([{ version: '0.9.0', channel: 'stable' }], { ring: 'stable', currentVersion: '0.9.0' })
  assert.equal(r.selected, null, '当前版本自己又被提供了一次')
  assert.equal(r.rejected[0].verdict.code, CHANNEL_CODES.NOT_NEWER)

  const older = selectOffered([{ version: '0.8.0', channel: 'stable' }], { ring: 'stable', currentVersion: '0.9.0' })
  assert.equal(older.selected, null)
  assert.equal(older.rejected[0].verdict.code, CHANNEL_CODES.NOT_NEWER)
})

test('④ ★★ 没有可选项时说清楚"没有"，且 `rejected` 带上理由（否则用户只看到"没有更新"）', () => {
  const r = selectOffered([{ version: '0.11.0', channel: 'internal' }], { ring: 'stable' })
  assert.equal(r.selected, null)
  assert.equal(r.rejected.length, 1)
  assert.ok(r.reason.includes('不适用于本机'), r.reason)

  const empty = selectOffered([], { ring: 'stable' })
  assert.equal(empty.selected, null)
  assert.equal(empty.reason, '没有候选版本')
  assert.deepEqual([...empty.offered], [])
})

test('④ `nextChannel` 给出下一站，stable 没有下一站', () => {
  assert.equal(nextChannel('internal'), 'canary')
  assert.equal(nextChannel('canary'), 'stable')
  assert.equal(nextChannel('stable'), null)
  assert.equal(nextChannel('beta'), null)
})

// ── ⑤ 晋级 ──────────────────────────────────────────────────────────────────

test('⑤ ★★ 晋级只能**逐级**，不能跨级（跨级等于跳过一次真实用户的观察）', () => {
  const skip = planPromotion({
    from: 'internal', to: 'stable', enteredAtMs: 0, promotedAtMs: 99 * DAY_MS,
  })
  assert.equal(skip.allowed, false, 'internal 直接晋级到 stable 被放行')
  assert.equal(skip.code, CHANNEL_CODES.PROMOTION_SKIP)
  assert.ok(skip.reason.includes('跳级'), skip.reason)
})

test('⑤ ★★ 反向晋级与原地"晋级"是两个不同的码（两种不同的配置错误）', () => {
  const back = planPromotion({ from: 'canary', to: 'internal', enteredAtMs: 0, promotedAtMs: 99 * DAY_MS })
  assert.equal(back.allowed, false)
  assert.equal(back.code, CHANNEL_CODES.PROMOTION_BACKWARD)

  const same = planPromotion({ from: 'canary', to: 'canary', enteredAtMs: 0, promotedAtMs: 99 * DAY_MS })
  assert.equal(same.allowed, false)
  assert.equal(same.code, CHANNEL_CODES.PROMOTION_SAME, '原地不动被报成了"方向反了"，排障会从错的地方开始')
  assert.notEqual(same.code, back.code)

  const unknown = planPromotion({ from: 'beta', to: 'stable', enteredAtMs: 0, promotedAtMs: 99 * DAY_MS })
  assert.equal(unknown.allowed, false)
  assert.equal(unknown.code, CHANNEL_CODES.RING_UNKNOWN)
})

test('⑤ ★★ 观察期不够时不许晋级，且报出**还差多久**', () => {
  const required = DEFAULT_SOAK_DAYS['canary->stable']
  const early = planPromotion({
    from: 'canary', to: 'stable', enteredAtMs: 0, promotedAtMs: 3 * DAY_MS,
  })
  assert.equal(early.allowed, false, `canary→stable 只观察了 3 天却被放行（要求 ${required} 天）`)
  assert.equal(early.code, CHANNEL_CODES.SOAK_INSUFFICIENT)
  assert.equal(early.soakDays, required)
  assert.equal(early.soakRequiredMs, required * DAY_MS)
  assert.equal(early.soakActualMs, 3 * DAY_MS)
  assert.ok(early.reason.includes('少于要求的'), early.reason)

  const enough = planPromotion({
    from: 'canary', to: 'stable', enteredAtMs: 0, promotedAtMs: required * DAY_MS,
  })
  assert.equal(enough.allowed, true, enough.reason)
  assert.equal(enough.code, null)
})

test('⑤ ★★ 观察期**算不出来**是独立的一档：要去翻部署记录，不是"再等几天"', () => {
  const r = planPromotion({ from: 'canary', to: 'stable' })
  assert.equal(r.allowed, false, '没有进入时刻却被放行')
  assert.equal(r.code, CHANNEL_CODES.SOAK_UNOBSERVED)
  assert.notEqual(r.code, CHANNEL_CODES.SOAK_INSUFFICIENT,
    '"算不出停留期"与"停留期不够"被压成了一档：前者要去查记录，后者只要等')
  assert.equal(r.soakActualMs, null)
  assert.ok(r.reason.includes('不等于'), r.reason)
})

test('⑤ ★ 两段路的观察期不同（internal→canary 更短，因为离得近）', () => {
  assert.ok(DEFAULT_SOAK_DAYS['internal->canary'] < DEFAULT_SOAK_DAYS['canary->stable'])
  const r = planPromotion({
    from: 'internal', to: 'canary',
    enteredAtMs: 0, promotedAtMs: DEFAULT_SOAK_DAYS['internal->canary'] * DAY_MS,
  })
  assert.equal(r.allowed, true, r.reason)
  assert.equal(r.soakDays, DEFAULT_SOAK_DAYS['internal->canary'])
})

test('⑤ ★★ 观察期策略可以注入：一份"故意做短"的策略必须能驱动到拦住的那一侧', () => {
  // 这一条证明"观察期检查"不是恒真的：把要求改到 30 天，7 天的晋级就该被拦。
  const strict = { 'internal->canary': 30, 'canary->stable': 30 }
  const r = planPromotion({
    from: 'canary', to: 'stable', enteredAtMs: 0, promotedAtMs: 7 * DAY_MS, soakDays: strict,
  })
  assert.equal(r.allowed, false, '把观察期要求改成 30 天后，7 天的晋级仍然通过了')
  assert.equal(r.soakDays, 30)
})

test('⑤ `assertPromotion` 在失败时抛，并带上码', () => {
  assert.throws(
    () => assertPromotion({ from: 'internal', to: 'stable', enteredAtMs: 0, promotedAtMs: 99 * DAY_MS }),
    (e) => { assert.equal(e.code, CHANNEL_CODES.PROMOTION_SKIP); return true },
  )
  const ok = assertPromotion({
    from: 'internal', to: 'canary',
    enteredAtMs: 0, promotedAtMs: DEFAULT_SOAK_DAYS['internal->canary'] * DAY_MS,
  })
  assert.equal(ok.allowed, true)
  assert.equal(ok.code, null)
})

// ── ⑥ 装载期自检 ────────────────────────────────────────────────────────────

test('⑥ ★ 装载期自检留下的是算出来的值，八条判据都真的跑过', () => {
  assert.deepEqual([...CHANNELS_CHECKED.problems], [])
  assert.equal(CHANNELS_CHECKED.ok, true)
  const s = CHANNELS_CHECKED.samples
  assert.equal(s.noOptInOffered, false)
  assert.equal(s.noOptInCode, CHANNEL_CODES.CANARY_NOT_OPTED_IN)
  assert.equal(s.stableInternalOffered, false)
  assert.equal(s.stableInternalCode, CHANNEL_CODES.NOT_PUBLISHED_FOR_RING)
  assert.equal(s.unknownRingOffered, false)
  assert.equal(s.unknownRingCode, CHANNEL_CODES.RING_UNKNOWN)
  assert.equal(s.skipAllowed, false)
  assert.equal(s.skipCode, CHANNEL_CODES.PROMOTION_SKIP)
  assert.equal(s.tooFastAllowed, false)
  assert.equal(s.tooFastCode, CHANNEL_CODES.SOAK_INSUFFICIENT)
  assert.equal(s.goodAllowed, true)
  assert.equal(s.unobservedCode, CHANNEL_CODES.SOAK_UNOBSERVED)
  assert.equal(s.sameCode, CHANNEL_CODES.PROMOTION_SAME)
  // 分桶门槛两头都真的算过，不是一句"分桶是均匀的"。
  assert.equal(s.zeroPercentHits, 0)
  assert.equal(s.fullPercentHits, 200)
  assert.ok(s.halfPercentHits > 0 && s.halfPercentHits < 200, `50% 命中 ${s.halfPercentHits}/200`)
  assert.equal(s.selectedVersion, '0.10.0')
})

test('⑥ ★★ 自检值不是"恒真"的：把放量比例注入成 0，命中数就是 0', () => {
  // 这一条与上面那条配对：装载期样本里的 `fullPercentHits === 200` 之所以有意义，
  // 是因为同一台机器上 `zeroPercentHits === 0`。两者一起才说明门槛真的在动。
  const probes = Array.from({ length: 50 }, (_, i) => `p-${i}`)
  const atZero = probes.filter((s) => canaryBucket({ ringSeed: s, version: 'v' }) < 0).length
  const atTwenty = probes.filter((s) => canaryBucket({ ringSeed: s, version: 'v' }) < 20).length
  const atHundred = probes.filter((s) => canaryBucket({ ringSeed: s, version: 'v' }) < 100).length
  assert.equal(atZero, 0)
  assert.equal(atHundred, 50)
  assert.ok(atTwenty < atHundred, '放量 20% 与 100% 的命中集合一样大——门槛没有在动')
})
