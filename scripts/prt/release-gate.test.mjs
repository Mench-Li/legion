// scripts/prt/release-gate.test.mjs
// ============================================================================
// PRT-614：**可执行发布检查单**的判据。
//
// `release-gate.mjs`（runtime 侧）是判据，本脚本是它唯一的**生产调用方**。
// 这一组盯的是三个"报表会不会说谎"的入口：
//
//   ① 没给证据 → 门禁**不满足**（"没检查"不等于"检查通过"）
//   ② 门禁不满足 → 指标 verdict 是 `not-a-metric-yet`，**不是** `pass`
//   ③ 退出码由**门禁**决定，指标不参与（指标是报表，门禁是闸门）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseArgs, releaseReport, render } from './release-gate.mjs'
import { READINESS_ITEMS } from '../../runtime/dsh-composition/release-gate.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = join(ROOT, 'scripts', 'prt', 'release-gate.mjs')

/** 跑 CLI，返回 {code, out}。**不**抛——退出码是要断言的东西。 */
function runCli(args) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe', cwd: ROOT })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

const READY_EVIDENCE = {
  selfCheck: {
    checks: [
      { name: 'composition-patch-layer', ok: true, reasons: [] },
      { name: 'runtime-probe', ok: true, reasons: [] },
      { name: 'sandbox-enforcement', ok: true, reasons: [] },
      { name: 'enforcement-mapping', ok: true, reasons: [] },
    ],
  },
  path: 'product-runtime',
  decisionSourceRecorded: true,
  legacyHighRiskTools: [],
  schedulers: ['legion'],
  observations: { attempted: 4, unapproved: 0 },
}

const withEvidence = (obj, fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-gate-'))
  try {
    const p = join(dir, 'evidence.json')
    writeFileSync(p, JSON.stringify(obj), 'utf8')
    return fn(p, dir)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------- 参数

test('① `parseArgs` 认参数，未知参数**报错**而不是被忽略', () => {
  assert.deepEqual(parseArgs(['--evidence', 'a.json']), { evidence: 'a.json', json: false, help: false })
  assert.deepEqual(parseArgs(['--json']), { evidence: null, json: true, help: false })
  assert.deepEqual(parseArgs(['-h']), { evidence: null, json: false, help: true })
  // 未知参数必须是 error：静默忽略会让 `--evidnce` 这种拼错变成"没给证据"，
  // 而"没给证据"的结论是"门禁不满足"——真因（打错字）被一条更响的结论盖住。
  const bad = parseArgs(['--evidnce', 'a.json'])
  assert.ok(bad.error, '未知参数必须报错')
  assert.match(bad.error, /未知参数/)
})

// ---------------------------------------------------------------- 纯函数

test('② ★★ 空证据 → 门禁不满足，且**全部** 7 项都报未就绪', () => {
  const r = releaseReport({})
  assert.equal(r.gate.satisfied, false)
  assert.equal(r.gate.unsatisfied.length, READINESS_ITEMS.length)
  // 每一项都要带码，才有得排查
  for (const item of r.gate.items.filter((i) => !i.ok)) assert.match(item.code, /^release-gate-/)
})

test('② ★★ 空证据时指标不是 pass（本批的核心判据，在 CLI 这一层再钉一次）', () => {
  const r = releaseReport({})
  assert.equal(r.metric.verdict, 'not-a-metric-yet')
  assert.equal(r.metric.metricValid, false)
})

test('② ★ 完全就绪 + 有尝试 + 无未批准 → 门禁满足且指标 pass', () => {
  const r = releaseReport(READY_EVIDENCE)
  assert.equal(r.gate.satisfied, true, r.gate.reasons.join('；'))
  assert.equal(r.metric.verdict, 'pass')
})

test('② ★★ 渲染出来的报表**带着 verdict**，不是只有一个数字', () => {
  // 只打印数字正是本模块要防的那件事：
  //   > 一个「报表上写着'未批准高风险写操作为零'」的发布门禁，
  //   > 与一个「因为没有一条高风险写被真的试过、于是那个数字当然是零」的发布门禁，
  //   > 是同一个东西——只不过前者看起来是一个通过的指标。
  const text = render(releaseReport({}))
  assert.match(text, /verdict\s*:\s*not-a-metric-yet/)
  assert.match(text, /不是证据/)
  assert.match(text, /门禁：不满足/)
  // 就绪项逐条列出，而不是一句"门禁未通过"
  assert.match(text, /组合补丁层生效/)
  assert.match(text, /唯一调度器/)
})

test('② ★ legacy 上还有高风险工具时，报表逐条给出**处置**（不只是列个名单）', () => {
  const text = render(releaseReport({ ...READY_EVIDENCE, path: 'legacy', legacyHighRiskTools: ['file_delete'] }))
  assert.match(text, /legacy 高风险工具处置/)
  assert.match(text, /拒绝 file_delete/)
})

// ---------------------------------------------------------------- 端到端（真跑 CLI）

test('③ ★★ 无证据 → 退出码 1（门禁是闸门）', () => {
  const r = runCli([])
  assert.equal(r.code, 1)
  assert.match(r.out, /门禁：不满足/)
})

test('③ ★★ 完全就绪 → 退出码 0', () => {
  withEvidence(READY_EVIDENCE, (p) => {
    const r = runCli(['--evidence', p])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /门禁：满足/)
    assert.match(r.out, /verdict\s*:\s*pass/)
  })
})

test('③ ★★ 退出码由门禁决定，**不由指标决定**', () => {
  // 门禁满足但指标不是 pass（0 次尝试）→ 仍然退出 0。
  // 反过来（用指标当退出码）会让一个"这次没跑过高风险写"的发布
  // 因为"没有数据"而失败——而那是把报表当闸门。
  withEvidence({ ...READY_EVIDENCE, observations: { attempted: 0, unapproved: 0 } }, (p) => {
    const r = runCli(['--evidence', p])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /verdict\s*:\s*no-evidence/)
  })
})

test('③ ★ 门禁不满足但门禁项全过不了时也**不**看指标：退出码仍是 1', () => {
  withEvidence({ ...READY_EVIDENCE, schedulers: ['a', 'b'] }, (p) => {
    const r = runCli(['--evidence', p])
    assert.equal(r.code, 1)
    assert.match(r.out, /唯一调度器/)
  })
})

test('③ ★★ 证据文件不存在 → 退出码 2，且**不**用空证据继续', () => {
  // 空证据会被读成"全部未就绪"——那是正确的结论，但把它伪装成"我们查过了"
  // 会让真因（打错路径）被这条更响的结论盖住。
  const r = runCli(['--evidence', 'definitely-not-here-9f3a.json'])
  assert.equal(r.code, 2)
  assert.match(r.out, /证据文件不存在/)
  assert.doesNotMatch(r.out, /门禁：/)
})

test('③ ★ 证据文件不是合法 JSON → 退出码 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-gate-bad-'))
  try {
    const p = join(dir, 'bad.json')
    writeFileSync(p, '{ not json', 'utf8')
    const r = runCli(['--evidence', p])
    assert.equal(r.code, 2)
    assert.match(r.out, /不是合法 JSON/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('③ ★ `--json` 输出可被解析，且形状与纯函数一致', () => {
  withEvidence(READY_EVIDENCE, (p) => {
    const r = runCli(['--evidence', p, '--json'])
    assert.equal(r.code, 0)
    const parsed = JSON.parse(r.out)
    assert.equal(parsed.gate.satisfied, true)
    assert.equal(parsed.metric.verdict, 'pass')
    assert.equal(parsed.version, releaseReport(READY_EVIDENCE).version)
  })
})

test('③ ★ `--help` 退出 0 并列出证据字段（否则没人知道该给什么）', () => {
  const r = runCli(['--help'])
  assert.equal(r.code, 0)
  for (const field of ['selfCheck', 'decisionSourceRecorded', 'legacyHighRiskTools', 'schedulers', 'observations']) {
    assert.match(r.out, new RegExp(field))
  }
})

test('③ ★ 未知参数 → 退出码 2（不能静默当作没给证据）', () => {
  const r = runCli(['--evidnce', 'x.json'])
  assert.equal(r.code, 2)
  assert.match(r.out, /未知参数/)
})
