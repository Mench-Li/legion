// scripts/probes/_mutate-r125-wiring.mjs — 破验②的**接线**部分（投影模块本身见 _mutate-r124）。
//
//   M1: 端口不再带出 `id`                ⇒ 期望红（归因键丢了）
//   M2: 两个来源都读不到时合成全 0        ⇒ 期望红（★ 最危险）
//   M3: 结果对象有 usage 时也优先走投影   ⇒ 期望红（第一手读数被降级）
//   M4: 端口抛错时上抛                    ⇒ 期望红（坏端口把成功的运行变成失败）
//   M5: 投影的费用自己乘一遍（第二份算术）⇒ 期望红
//   M6: 反向——有用量时返回 null           ⇒ 期望红（证明 M2 不是恒红）
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const FILES = ['runtime/adapters/dsh/port.mjs', 'runtime/adapters/dsh/usage.mjs']
const SUITE = 'runtime/adapters/dsh/adapter.test.mjs'
const PORT = FILES[0]
const USAGE = FILES[1]

const snaps = new Map()
for (const f of FILES) { snaps.set(f, readFileSync(f)); copyFileSync(f, `${f}.mutbak`) }
const restore = (f) => copyFileSync(`${f}.mutbak`, f)
const restoreAll = () => { for (const f of FILES) restore(f) }

const toLF = (s) => s.replace(/\r\n/g, '\n')
const applyMutant = (text, from, to) => {
  const norm = toLF(text)
  const i = norm.indexOf(toLF(from))
  if (i < 0) return null
  const m = norm.slice(0, i) + toLF(to) + norm.slice(i + toLF(from).length)
  return text.includes('\r\n') ? m.replace(/\n/g, '\r\n') : m
}
const green = () => {
  try { execFileSync(process.execPath, ['--test', SUITE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return true }
  catch { return false }
}

const MUTANTS = [
  ['M1 端口不再带出 id（归因键丢了）', PORT,
    "  const sessionId = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null",
    '  const sessionId = null'],
  ['M2 ★ 两个来源都读不到时合成全 0', USAGE,
    `  const fromProjection = collectUsageFromProjection({ host, sessionId, model, pricing })
  if (fromProjection !== null) return { usage: fromProjection, source: 'projection' }

  return { usage: null, source: null }`,
    `  const fromProjection = collectUsageFromProjection({ host, sessionId, model, pricing })
  if (fromProjection !== null) return { usage: fromProjection, source: 'projection' }

  return { usage: { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 }, source: null }`],
  ['M3 第一手读数被降级（投影优先）', USAGE,
    `  const fromResult = collectUsage(result, { pricing, model })
  if (fromResult !== null) return { usage: fromResult, source: 'result' }

  const fromProjection = collectUsageFromProjection({ host, sessionId, model, pricing })
  if (fromProjection !== null) return { usage: fromProjection, source: 'projection' }`,
    `  const fromProjection = collectUsageFromProjection({ host, sessionId, model, pricing })
  if (fromProjection !== null) return { usage: fromProjection, source: 'projection' }

  const fromResult = collectUsage(result, { pricing, model })
  if (fromResult !== null) return { usage: fromResult, source: 'result' }`],
  ['M4 端口抛错时上抛', USAGE,
    `  } catch {
    // 端口那一侧坏了不该让一次成功的运行变成失败（与 \`estimateCostUsd\` 同一条取舍）。
    return null
  }`,
    `  } catch (e) {
    throw e
  }`],
  ['M5 投影自己乘一遍费用（第二份算术）', USAGE,
    '    estimatedCostUsd: estimateCostUsd({ model, tokensIn: inTok, tokensOut: outTok, pricing }),',
    '    estimatedCostUsd: (inTok ?? 0) * 0.000001 + (outTok ?? 0) * 0.000002,'],
  ['M6 ★ 反向：有用量时也返回 null', USAGE,
    `  const fromProjection = collectUsageFromProjection({ host, sessionId, model, pricing })
  if (fromProjection !== null) return { usage: fromProjection, source: 'projection' }`,
    `  const fromProjection = collectUsageFromProjection({ host, sessionId, model, pricing })
  if (false) return { usage: fromProjection, source: 'projection' }`],
]

let bad = 0
try {
  for (const [name, file, from, to] of MUTANTS) {
    for (const [f, s] of snaps) {
      if (Buffer.compare(s, readFileSync(f)) !== 0) { console.log(`✖ ${name}：${f} 有残渣`); restoreAll(); process.exit(1) }
    }
    const mutated = applyMutant(readFileSync(`${file}.mutbak`, 'utf8'), from, to)
    if (mutated === null) { console.log(`✖ ${name}：变异点找不到`); bad++; continue }
    writeFileSync(file, mutated)
    const g = green()
    console.log(`${g ? '✖' : '✔'} ${name} → ${g ? '**没咬住**' : '咬住（红）'}`)
    if (g) bad++
    restore(file)
  }
} finally {
  restoreAll()
  let same = true
  for (const f of FILES) { unlinkSync(`${f}.mutbak`); if (Buffer.compare(snaps.get(f), readFileSync(f)) !== 0) same = false }
  console.log(`还原逐字节相同：${same ? '✔' : '✖'}`)
  if (!same) process.exit(1)
}
if (bad > 0) process.exit(1)
