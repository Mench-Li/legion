// scripts/prt/baseline-measure.test.mjs — PRT-009 基线采集器的口径单测
//
// 两条主张必须由用例守住，否则它们只是注释里的愿望：
//
//   ① **单价缺失时费用必须是 null，不能是 0**。0 会让「未配置单价」看起来像「免费」，
//      预算检查会因此静默失效。
//   ② **「待采集」清单必须随证据结清**。长期挂着同一份清单，读的人会默认它没变——
//      清单就变成了噪音。这里用**真实证据文件**核对结清状态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PENDING_ITEMS, PRICING, estimateCost, resolvePending } from './baseline-measure.mjs'

/** 仓库根（本文件位于 `<root>/scripts/prt/`）。 */
const ROOT_FOR_TESTS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ---------------------------------------------------------------- ① 费用口径

test('estimateCost：单价缺失返回 null（不是 0）——0 会让预算检查静默失效', () => {
  const pricing = { asOf: 'UNSET', perMillionTokens: { 'm-1': { input: null, output: null } } }
  assert.equal(estimateCost({ tokensIn: 1_000_000, tokensOut: 1_000_000, model: 'm-1' }, pricing), null)
})

test('estimateCost：表里没有的模型也返回 null，不得当成免费', () => {
  assert.equal(estimateCost({ tokensIn: 10, tokensOut: 10, model: '不存在' }, PRICING), null)
})

test('estimateCost：两个单价都齐时按每百万 token 计算', () => {
  const pricing = { asOf: '2026-01-01', perMillionTokens: { 'm-1': { input: 3, output: 15 } } }
  // 2M input × 3 + 0.5M output × 15 = 6 + 7.5 = 13.5
  assert.equal(estimateCost({ tokensIn: 2_000_000, tokensOut: 500_000, model: 'm-1' }, pricing), 13.5)
})

test('estimateCost：只有一个单价缺失也返回 null（半个价格算不出总价）', () => {
  const pricing = { asOf: '2026-01-01', perMillionTokens: { 'm-1': { input: 3, output: null } } }
  assert.equal(estimateCost({ tokensIn: 1_000, tokensOut: 1_000, model: 'm-1' }, pricing), null)
})

test('PRICING 现状：GF-001 实测用到的模型已登记，但价格仍是 null（无来源不填）', () => {
  assert.equal(PRICING.asOf, 'UNSET')
  for (const model of ['deepseek-v4-pro-openai', 'deepseek-v4-flash-openai']) {
    const entry = PRICING.perMillionTokens[model]
    assert.ok(entry, `${model} 应已登记（否则费用估算连「缺哪个模型」都报不出来）`)
    assert.equal(entry.input, null)
    assert.equal(entry.output, null)
  }
})

// ---------------------------------------------------------------- ② 待采集清单

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

// ---------------------------------------------------------------- ③ 真实证据核对

test('真实待采集清单：GF-001 执行后应有四项结清、两项仍阻塞（且原因不是「需要真实执行」）', () => {
  // 这条用例的价值在于：**证据文件被删/被改坏时 CI 会红**。
  // 只写文档不设守卫，下一次重构就会把证据文件顺手删掉，而没人发现。
  const out = resolvePending({ readFile: (p) => readFileSync(p, 'utf8'), root: ROOT_FOR_TESTS })
  const measured = out.filter((x) => x.status === 'measured').map((x) => x.key)
  const blocked = out.filter((x) => x.status !== 'measured').map((x) => x.key)

  assert.deepEqual(measured.sort(), [
    'end-to-end-latency', 'human-intervention-rate', 'old-path-task-state-sequence', 'token-usage',
  ])
  assert.deepEqual(blocked.sort(), ['estimated-cost', 'peak-resource'])

  // 仍阻塞的两项都**不是**「还缺一次真实执行」——那个理由已经用掉了。
  for (const x of out.filter((i) => i.status !== 'measured')) {
    assert.ok(!x.blockedBy.includes('需要一次真实执行'), `${x.key} 的阻塞原因应已更新：${x.blockedBy}`)
  }

  // 结清项必须能回指到具体证据文件，而不是只写「已采集」。
  for (const x of out.filter((i) => i.status === 'measured')) {
    assert.ok(x.evidence, `${x.key} 应给出证据文件路径`)
    assert.ok(readFileSync(join(ROOT_FOR_TESTS, x.evidence), 'utf8').length > 0, `${x.evidence} 应存在且非空`)
  }

  assert.equal(PENDING_ITEMS.length, 6)
})
