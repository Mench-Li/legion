// scratch/_mutate-budget-alert.mjs —— 变异验证：把守卫逐条拆掉，看用例会不会红（**不提交**）
//
// ★ 为什么要做：一组**全绿**的用例并不能证明守卫有牙齿——它也可能什么都没查。
//   做法是把被验的那一行**改坏**，要求至少一条用例整红；改不红的守卫，
//   与没有那条守卫，在"它有没有挡住过回归"上是同一个回答。
import { copyFileSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const MOD = 'D:/project/DSH/legion/team-hub/budget-alert.mjs'
const BAK = 'D:/project/DSH/legion/scratch/_budget-alert.mjs.bak'

const MUTATIONS = [
  {
    name: 'M1 规则 1 拆掉：confidence 不 exact 时的动作下限改成 none',
    find: "  partial: 'review',\n  unknown: 'review',",
    repl: "  partial: 'none',\n  unknown: 'none',",
  },
  {
    name: 'M2 allClear 少一个合取项：去掉 confidence === exact',
    find: "configured && level === 'ok' && confidence === 'exact',",
    repl: "configured && level === 'ok',",
  },
  {
    name: 'M3 不认识的阈值名静默忽略（删掉那条拒绝）',
    find: "  if (unknown.length > 0) {\n    throw fail(BUDGET_ALERT_CODES.THRESHOLDS_INVALID,",
    repl: "  if (false) {\n    throw fail(BUDGET_ALERT_CODES.THRESHOLDS_INVALID,",
  },
  {
    name: 'M4 阈值判定从 >= 改成 >（恰好等于时不动作）',
    find: 'if (ratio >= t && levelIndex(rung) > levelIndex(level)) {',
    repl: 'if (ratio > t && levelIndex(rung) > levelIndex(level)) {',
  },
  {
    name: 'M5 没给上限时落回一个默认值（而不是抛）',
    find: "  if (limit === undefined || limit === null) {\n    throw fail(BUDGET_ALERT_CODES.LIMIT_REQUIRED,",
    repl: "  if (limit === undefined || limit === null) {\n    limit = { amount: 1e9, currency: null };\n    if (false) throw fail(BUDGET_ALERT_CODES.LIMIT_REQUIRED,",
  },
  {
    name: 'M6 没配阈值时也算 allClear（"没配告警"读成"一切正常"）',
    find: "  const fromConfidence = configured ? ACTION_FLOOR_FOR_CONFIDENCE[confidence] : 'review'",
    repl: "  const fromConfidence = ACTION_FLOOR_FOR_CONFIDENCE[confidence]",
  },
  {
    name: 'M7 阈值不递增时放行（降级那级于是永远不被观察到）',
    find: '    if (!(ratios[lo] < ratios[hi])) {',
    repl: '    if (false) {',
  },
]

function runSuite() {
  // ★ 解析器踩过一次坑：node 的 spec reporter 打的是 `ℹ fail 3`，
  //   而我第一版写的是 `/# fail (\d+)/`（那是 TAP 的形状）⇒ 每一条都读成 -1，
  //   于是**七条全被判成"漏网"**——而它们其实每条都咬住了（红的那几条名字都对）。
  //   > 一个读不出"红了几条"的解析器，会让一次**全部咬住**的变异验证
  //   > 看起来像一次**全部漏网**。两种结论的处置完全相反。
  const parse = (out) => {
    const spec = /ℹ fail (\d+)/.exec(out)
    if (spec) return Number(spec[1])
    const tap = /# fail (\d+)/.exec(out)
    if (tap) return Number(tap[1])
    return /ℹ pass (\d+)/.test(out) ? 0 : -1
  }
  try {
    const out = execFileSync('node', ['--test', 'team-hub/budget-alert.test.mjs'], {
      cwd: 'D:/project/DSH/legion', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    })
    return { fail: parse(out), out }
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    return { fail: parse(out), out }
  }
}

const orig = readFileSync(MOD, 'utf8')
copyFileSync(MOD, BAK)
console.log('基线：' + JSON.stringify(runSuite().fail === 0 ? '20/20 全绿' : '基线就不绿！'))

let allCaught = true
try {
  for (const mu of MUTATIONS) {
    if (!orig.includes(mu.find)) {
      console.log(`⚠ ${mu.name}\n    没找到锚点，这条变异没做（锚点：${JSON.stringify(mu.find.slice(0, 50))}）`)
      allCaught = false
      continue
    }
    const mutated = orig.replace(mu.find, mu.repl)
    if (mutated === orig) { console.log(`⚠ ${mu.name} 没有改变文件`); allCaught = false; continue }
    writeFileSync(MOD, mutated, 'utf8')
    const { fail, out } = runSuite()
    const reds = [...out.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1].slice(0, 46))
    const caught = fail > 0
    if (!caught) allCaught = false
    console.log(`${caught ? '✓ 咬住' : '✖ 漏网'} ${mu.name}`)
    console.log(`     红 ${fail} 条：${[...new Set(reds)].slice(0, 4).join(' | ') || '(无)'}`)
    writeFileSync(MOD, orig, 'utf8')
  }
} finally {
  writeFileSync(MOD, orig, 'utf8')
  unlinkSync(BAK)
}

console.log('\n全部变异都被咬住 ? ' + allCaught)
console.log('还原后基线：' + JSON.stringify(runSuite().fail === 0 ? '20/20 全绿' : '还原失败！'))
console.log('还原后与原文逐字相同 ? ' + (readFileSync(MOD, 'utf8') === orig))
