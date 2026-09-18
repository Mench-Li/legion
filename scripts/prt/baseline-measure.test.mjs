// scripts/prt/baseline-measure.test.mjs — PRT-009 基线采集器的口径单测
//
// 三条主张必须由用例守住，否则它们只是注释里的愿望：
//
//   ① **单价缺失时费用必须是 null，不能是 0**。0 会让「未配置单价」看起来像「免费」，
//      预算检查会因此静默失效。
//   ② **价格只有一个来源**：`PRICING` 就是契约里的记录表，本文件不再自带第二套形状
//      （两套形状必然漂移，而漂移的表现是两个模块对同一笔用量给出两个都"看起来正常"的数）。
//   ③ **「待采集」清单必须随证据结清**：这里用**真实证据文件**核对结清状态，
//      并断言 `estimated-cost` 的数**能从证据重算**——不是抄进代码的常量。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEEPSEEK_PRICE_TABLE, createPriceTable } from '../../runtime/contracts/price-table.mjs'
import {
  PENDING_ITEMS,
  PRICING,
  estimateCost,
  estimateGoldenFlowCost,
  resolvePending,
} from './baseline-measure.mjs'

/** 仓库根（本文件位于 `<root>/scripts/prt/`）。 */
const ROOT_FOR_TESTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 一张最小的、可控的价目表：每百万 token，输入 3 / 输出 15（**不同价**）。 */
const PRICED = createPriceTable({
  version: '2026-01-01',
  currency: 'USD',
  effectiveAtMs: 0,
  models: { 'm-1': { billingUnit: 'per-mtok', perUnitIn: 3, perUnitOut: 15 } },
})

// ---------------------------------------------------------------- ① 费用口径

test('estimateCost：没有价的模型返回 null（不是 0）——0 会让预算检查静默失效', () => {
  assert.equal(estimateCost({ tokensIn: 1_000_000, tokensOut: 1_000_000, model: 'm-2' }, PRICED), null)
  assert.equal(estimateCost({ tokensIn: 10, tokensOut: 10, model: '不存在' }, PRICING), null)
  assert.equal(estimateCost({ tokensIn: 1_000_000, tokensOut: 0, model: 'example-model-x' }), null)
})

test('estimateCost：不是契约价目表（老形状 / null）返回 null，而不是抛错', () => {
  // 采集器不因为拿到一个坏表就整轮失败：它返回"不知道"，由调用方如实记成待采集。
  assert.equal(estimateCost({ tokensIn: 1, tokensOut: 1, model: 'm' }, { perMillionTokens: {} }), null)
  assert.equal(estimateCost({ tokensIn: 1, tokensOut: 1, model: 'm' }, null), null)
})

test('estimateCost：输入与输出分别计价（"一个价算两遍"是缺陷，不是口径）', () => {
  // 2M input × 3 + 0.5M output × 15 = 6 + 7.5 = 13.5
  assert.equal(estimateCost({ tokensIn: 2_000_000, tokensOut: 500_000, model: 'm-1' }, PRICED), 13.5)
  // 若按输入价算输出，会得到 2.5M × 3 = 7.5。两个数不同，说明方向价真的生效。
  assert.notEqual(estimateCost({ tokensIn: 2_000_000, tokensOut: 500_000, model: 'm-1' }, PRICED), 7.5)
})

// ---------------------------------------------------------------- ② 价目表来源

test('PRICING 现状：就是契约里的记录表（只有一份形状，且带出处）', () => {
  assert.equal(PRICING, DEEPSEEK_PRICE_TABLE)
  assert.equal(PRICING.version, 'deepseek-2026-09-15')
  assert.equal(PRICING.retrievedAt, '2026-09-15')
  assert.match(PRICING.sourceUrl, /api-docs\.deepseek\.com/)
  // 两个曾经留空的网关 id 现在有价，但如实标着"推导别名"
  for (const model of ['deepseek-v4-pro-openai', 'deepseek-v4-flash-openai']) {
    assert.ok(PRICING.models[model], `${model} 应已登记（否则费用估算连「缺哪个模型」都报不出来）`)
    assert.equal(PRICING.models[model].sourceKind, 'derived')
  }
  // 表里有的模型真的算出数；默认 basis 是 peak + cache miss（每百万 0.3）
  assert.equal(estimateCost({ tokensIn: 1_000_000, tokensOut: 0, model: 'deepseek-flash' }), 0.3)
})

// ---------------------------------------------------------------- ③ 从证据重算

test('estimateGoldenFlowCost：从**真的证据文件**重算，数对得上记录表', () => {
  const evidence = JSON.parse(
    readFileSync(join(ROOT_FOR_TESTS, 'docs/superpowers/prt/prt-009-gf001-execution.json'), 'utf8'),
  )
  const text = estimateGoldenFlowCost(evidence)
  assert.equal(typeof text, 'string')
  assert.match(text, /3 段/)
  assert.match(text, /deepseek-v4-flash-openai/)
  assert.match(text, /含推导别名/, '网关 id 是推导别名，必须在结果里自报家门')
  assert.match(text, /deepseek-2026-09-15/)
  assert.match(text, /默认上界/)

  // 独立算一遍：三段均 off-peak（2026-09-11 12:36 UTC 起，非 peak 时段），
  // 输入按 cacheRead 拆成 hit / miss 两段。
  const runs = evidence.execution.runs
  let expected = 0
  for (const run of runs) {
    const t = run.tokens
    expected += (t.input / 1e6) * 0.15 + (t.cacheRead / 1e6) * 0.003 + (t.output / 1e6) * 0.6
  }
  assert.match(text, new RegExp(`\\$${expected.toFixed(6)}`))
})

test('estimateGoldenFlowCost：证据里 input **不含** cacheRead（丢掉它金额会明显偏低）', () => {
  // reportedTotal = input + output + cacheRead ⇒ input 是 cache-miss 部分。
  // 这条用例只有 1M cacheRead：正确的数是 $0.003000（off-peak hit），
  // 若把 cacheRead 当成 0 就会变成 $0.000000。
  const single = {
    execution: {
      runs: [{
        model: 'deepseek-v4-flash-openai',
        startedAt: '2026-09-11T12:36:45.045Z', // 周五 12:36 UTC → off-peak
        tokens: { input: 0, output: 0, cacheRead: 1_000_000 },
      }],
    },
  }
  assert.match(estimateGoldenFlowCost(single), /\$0\.003000/)
})

test('estimateGoldenFlowCost：没有一段能定价时返回 null（→ 仍记为待采集，不编数）', () => {
  assert.equal(estimateGoldenFlowCost(null), null)
  assert.equal(estimateGoldenFlowCost({ execution: { runs: [] } }), null)
  assert.equal(estimateGoldenFlowCost({
    execution: { runs: [{ model: 'nope', tokens: { input: 1, output: 1 } }] },
  }), null)
})

// ---------------------------------------------------------------- ④ 待采集清单

test('resolvePending：有证据则结清，缺文件/缺字段则如实记为待采集', () => {
  const items = [
    { key: 'a', what: 'A', blockedBy: 'x', resolvedBy: { file: 'e.json', extract: (j) => j.value ?? null } },
    { key: 'b', what: 'B', blockedBy: 'y', resolvedBy: { file: 'e.json', extract: (j) => j.missing ?? null } },
    { key: 'c', what: 'C', blockedBy: 'z', resolvedBy: null },
  ]
  const out = resolvePending({
    items,
    root: '/root',
    readFile: (p) => {
      assert.equal(p.replace(/\\/g, '/'), '/root/e.json')
      return JSON.stringify({ value: '42' })
    },
  })
  assert.deepEqual(out.map((x) => x.status), ['measured', 'blocked', 'blocked'])
  assert.equal(out[0].measured, '42')
  assert.equal(out[0].evidence, 'e.json')
  assert.equal(out[1].unresolvedReason?.includes('取不到该字段'), true)
  assert.equal(out[2].measured, null)
})

test('resolvePending：证据文件读不到时不抛错，而是回落为待采集并写明原因', () => {
  const items = [{ key: 'a', what: 'A', blockedBy: 'x', resolvedBy: { file: 'gone.json', extract: (j) => j.v ?? null } }]
  const out = resolvePending({ items, root: '/root', readFile: () => { throw new Error('ENOENT') } })
  assert.equal(out[0].status, 'blocked')
  assert.match(out[0].unresolvedReason, /ENOENT/)
})

// ---------------------------------------------------------------- ⑤ 真实证据核对

test('真实待采集清单：GF-001 执行后应有五项结清、一项仍阻塞（且原因不是「需要真实执行」）', () => {
  // 这条用例的价值在于：**证据文件被删/被改坏时 CI 会红**。
  // 只写文档不设守卫，下一次重构就会把证据文件顺手删掉，而没人发现。
  const out = resolvePending({ readFile: (p) => readFileSync(p, 'utf8'), root: ROOT_FOR_TESTS })
  const measured = out.filter((x) => x.status === 'measured').map((x) => x.key)
  const blocked = out.filter((x) => x.status !== 'measured').map((x) => x.key)

  assert.deepEqual(measured.sort(), [
    'end-to-end-latency', 'estimated-cost', 'human-intervention-rate',
    'old-path-task-state-sequence', 'token-usage',
  ])
  assert.deepEqual(blocked.sort(), ['peak-resource'])

  // 仍阻塞的那一项**不是**「还缺一次真实执行」——那个理由已经用掉了。
  for (const x of out.filter((i) => i.status !== 'measured')) {
    assert.ok(!x.blockedBy.includes('需要一次真实执行'), `${x.key} 的阻塞原因应已更新：${x.blockedBy}`)
  }

  // ★★ 而"不许写某句话"这条规则**本身不够**——它可以被绕过去：
  //   把「需要一次真实执行」改写成「仍缺一次真实执行留下的读数」，
  //   字面不匹配、意思一模一样，判据全绿。
  //
  //   > 一条"禁止某个措辞"的判据，挡不住任何一次**换词**的重述；
  //   > 它挡住的只是偷懒，挡不住误解。
  //
  //   所以这里再加一条**正面**要求：阻塞原因必须说出**机制现在到哪一步了**。
  //   `peak-resource` 这一项的机制（外部采样器 + 退出路径交出读数）已经交付，
  //   理由里就必须写明"不再是缺机制"，否则读的人会以为还在等采样器。
  //   本轮之前它写的正是过期的「需在执行期外部采样」+ 一个与平台无关的
  //   PRT-011 裁决——两项都是"在等一个其实没有人在等的东西"。
  for (const x of out.filter((i) => i.status !== 'measured')) {
    assert.match(x.blockedBy, /已交付|已接线|不再是/,
      `${x.key} 的阻塞理由必须说明机制到哪一步了，而不是只重复"还缺一个数"：${x.blockedBy}`)
  }

  // 而 `peak-resource` 的理由要**点名**那个采样器文件——
  // 否则"已交付"是一句没有指涉的话，读的人无从核对。
  const peak = out.find((x) => x.key === 'peak-resource')
  assert.ok(peak, 'peak-resource 必须在清单里')
  assert.match(peak.blockedBy, /peak-resource\.mjs/)
  assert.match(peak.blockedBy, /describePeakResource/)

  // 结清项必须能回指到具体证据文件，而不是只写「已采集」。
  for (const x of out.filter((i) => i.status === 'measured')) {
    assert.ok(x.evidence, `${x.key} 应给出证据文件路径`)
    assert.ok(readFileSync(join(ROOT_FOR_TESTS, x.evidence), 'utf8').length > 0, `${x.evidence} 应存在且非空`)
  }

  // 结清的 `estimated-cost` 必须给出一个金额与它的出处信息，而不是一句"已估算"。
  const cost = out.find((x) => x.key === 'estimated-cost')
  assert.equal(cost.status, 'measured')
  assert.match(cost.measured, /\$\d+\.\d{6} USD/)
  assert.match(cost.measured, /deepseek-2026-09-15@2026-09-15/)

  assert.equal(PENDING_ITEMS.length, 6)
})
