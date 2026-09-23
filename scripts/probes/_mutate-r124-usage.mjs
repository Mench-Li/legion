// scripts/probes/_mutate-r124-usage.mjs — 破验：用量投影的判据真的咬得住吗？
//
//   M1: 「读不到」改成返回全 0 对象        ⇒ 期望红（★ 最危险：0 是一个测量结论）
//   M2: 五种"读不到"合成一个码            ⇒ 期望红
//   M3: 不相干事件返回**新对象**          ⇒ 期望红（投影契约承重条款）
//   M4: `messages` 那一格不参与判定        ⇒ 期望红（全 0 对象会被当成有效读数）
//   M5: 把 `totalTokens` 也加进 input      ⇒ 期望红（低估一个量级的那条）
//   M6: 负数被当作合法计数                 ⇒ 期望红
//   M7: 反向——好状态被判成 null            ⇒ 期望红（证明 M1/M4 不是恒红）
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const SRC = 'runtime/dsh-composition/usage-projection.mjs'
const SUITE = 'runtime/dsh-composition/usage-projection.test.mjs'

const snap = readFileSync(SRC)
copyFileSync(SRC, `${SRC}.mutbak`)
const restore = () => copyFileSync(`${SRC}.mutbak`, SRC)

const toLF = (s) => s.replace(/\r\n/g, '\n')
const applyMutant = (text, from, to) => {
  const norm = toLF(text)
  const i = norm.indexOf(toLF(from))
  if (i < 0) return null
  const mutated = norm.slice(0, i) + toLF(to) + norm.slice(i + toLF(from).length)
  return text.includes('\r\n') ? mutated.replace(/\n/g, '\r\n') : mutated
}
const green = () => {
  try { execFileSync(process.execPath, ['--test', SUITE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return true }
  catch { return false }
}

const MUTANTS = [
  // M1 ★ 最危险：读不到时编一个 0
  ['M1 ★「读不到」返回全 0 对象', `  if (!Number.isSafeInteger(state.messages) || state.messages <= 0) return null
  return {
    tokensIn: state.inputTokens,
    tokensOut: state.outputTokens,
    cacheReadTokens: state.cacheReadTokens,
    messages: state.messages,
  }`,
  `  return {
    tokensIn: state.inputTokens,
    tokensOut: state.outputTokens,
    cacheReadTokens: state.cacheReadTokens,
    messages: state.messages,
  }`],
  // M2 五种读不到合成一个
  ['M2 五种"读不到"合成一个码', `  SESSION_NOT_FOUND: 'LEGION_USAGE_SESSION_NOT_FOUND',`, `  SESSION_NOT_FOUND: 'LEGION_USAGE_NO_SESSIONS_SERVICE',`],
  // M3 不相干事件返回新对象
  ['M3 不相干事件返回新对象', `  const u = usageOf(event)
  if (u === null) return state
  return {`, `  const u = usageOf(event)
  if (u === null) return { ...state }
  return {`],
  // M4 messages 不参与判定
  ['M4 messages 不参与判定', `  if (!Number.isSafeInteger(state.messages) || state.messages <= 0) return null`, `  if (!Number.isSafeInteger(state.messages)) return null`],
  // M5 totalTokens 并进 input（低估一个量级那条）
  ['M5 把 cacheRead 当成没花', `  const cacheReadTokens = num(u.cacheReadTokens)`, `  const cacheReadTokens = 0`],
  // M6 负数当合法
  ['M6 负数被当作合法计数', `  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && Number.isSafeInteger(v) && v >= 0 ? v : 0)`, `  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && Number.isSafeInteger(v) ? v : 0)`],
  // M7 反向：好状态被判成 null
  ['M7 ★ 反向：好状态被判成 null', `  if (!Number.isSafeInteger(state.messages) || state.messages <= 0) return null`, `  if (!Number.isSafeInteger(state.messages) || state.messages >= 0) return null`],
]

let bad = 0
try {
  for (const [name, from, to] of MUTANTS) {
    if (Buffer.compare(snap, readFileSync(SRC)) !== 0) { console.log(`✖ ${name}：上一轮留了残渣`); restore(); bad++; continue }
    const mutated = applyMutant(readFileSync(`${SRC}.mutbak`, 'utf8'), from, to)
    if (mutated === null) { console.log(`✖ ${name}：变异点找不到`); bad++; continue }
    writeFileSync(SRC, mutated)
    const g = green()
    console.log(`${g ? '✖' : '✔'} ${name} → ${g ? '**没咬住**' : '咬住（红）'}`)
    if (g) bad++
    restore()
  }
} finally {
  restore()
  unlinkSync(`${SRC}.mutbak`)
  const same = Buffer.compare(snap, readFileSync(SRC)) === 0
  console.log(`还原逐字节相同：${same ? '✔' : '✖'}`)
  if (!same) process.exit(1)
}
if (bad > 0) process.exit(1)
