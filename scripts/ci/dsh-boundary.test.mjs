// dsh-boundary.test.mjs — PRT-002 / PRT-108 DSH 执行面边界扫描单测
//
// 覆盖四类：
//   ① 记号识别：点号/下标访问、inject 声明、包说明符，都要抓到。
//   ② 反误报：前缀包名（dsh-agent vs dsh-agent-default-model）、相似服务名、注释提及，
//      都不得计数——边界检查一旦误报就会被当成噪音绕过，比不检查更糟。
//   ③ 判定语义：超出基线 / 新文件 / 必须为零 / 适配层豁免，四种结果的归因必须准确。
//   ④ 棘轮真实性：当前仓库扫描结果必须与基线一致，且**新增一处调用点真的会红**。
//      第 ④ 类是本套件的存在理由——只测纯函数的边界检查无法证明它真的拦得住回归。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanSource, scanRepo, diffAgainstBaseline, totalOf } from './dsh-boundary.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const CLI = join(HERE, 'dsh-boundary.mjs')
const BASELINE = JSON.parse(readFileSync(join(HERE, 'dsh-boundary-baseline.json'), 'utf8'))

// ---------------------------------------------------------------- ① 记号识别

test('① 点号访问 ctx.<执行面服务> 被计数', () => {
  const hits = scanSource('const x = ctx.subagents.start()\nconst y = ctx.agentDefaultModel.currentSelection()')
  assert.equal(hits['ctx.subagents'], 1)
  assert.equal(hits['ctx.agentDefaultModel'], 1)
})

test('① 下标访问 ctx["<服务>"] 与点号等价', () => {
  assert.equal(scanSource("ctx['subagents']")['ctx.subagents'], 1)
  assert.equal(scanSource('ctx["agentDefaultModel"]')['ctx.agentDefaultModel'], 1)
})

test('① inject 声明被计数（含多行数组）', () => {
  const hits = scanSource("export const inject = [\n  'timer',\n  'agents',\n  'subagents',\n]")
  assert.equal(hits['inject.agents'], 1)
  assert.equal(hits['inject.subagents'], 1)
  assert.equal(hits['inject.timer'], undefined, '非执行面服务不得进基线')
})

test('① 包说明符被计数', () => {
  const hits = scanSource("import type { Agent } from '@deepseek-ai/dsh-agent'\nconst m = require('@deepseek-ai/dsh-subagent')")
  assert.equal(hits['@deepseek-ai/dsh-agent'], 1)
  assert.equal(hits['@deepseek-ai/dsh-subagent'], 1)
})

// ---------------------------------------------------------------- ② 反误报

test('② 前缀包名不互相误伤：dsh-agent-default-model 不得记成 dsh-agent', () => {
  const hits = scanSource("import type {} from '@deepseek-ai/dsh-agent-default-model'")
  assert.equal(hits['@deepseek-ai/dsh-agent-default-model'], 1)
  assert.equal(hits['@deepseek-ai/dsh-agent'], undefined, '长包名被短包名吞掉即为词边界缺陷')
})

test('② 相似服务名不互相误伤：ctx.agentPresets 不得记成 ctx.agents', () => {
  const hits = scanSource('ctx.agentPresets.get()')
  assert.equal(hits['ctx.agentPresets'], 1)
  assert.equal(hits['ctx.agents'], undefined)
})

test('② 更长标识符不误配：ctx.subagentsX / ctx.agentsOf 均不计数', () => {
  assert.deepEqual(scanSource('ctx.subagentsX'), {})
  assert.deepEqual(scanSource('ctx.agentsOfThing'), {})
})

test('② 非执行面宿主能力不计数（team-hub/board-plugin 会合法用到它们）', () => {
  const src = 'ctx.effect(() => {})\nctx.logger.info("x")\nctx.webServer.get("/")\nctx.setInterval(fn, 1)\nctx.plugin(P)'
  assert.deepEqual(scanSource(src), {}, '把宿主平面算进棘轮会让真正的边界告警被噪音淹没')
})

test('② 局部同名对象（业务代码自己的 ctx）不计数', () => {
  // docs 与测试里存在大量这种局部 ctx（如 ctx.manifest / ctx.hub / ctx.txt）
  assert.deepEqual(scanSource('for (const ctx of items) { ctx.manifest, ctx.hub, ctx.txt }'), {})
})

test('② 扫描是词法的：注释与字符串里的记号同样计数（刻意偏保守，非缺陷）', () => {
  // 这是**有意**的口径：棘轮宁可多算也不能漏算——漏算会让回归溜过门禁，
  // 多算只表现为「注释里提了一句就红」，改词或更新基线即可恢复。
  // 真正的实现是带注释剥离的词法器，而半吊子剥离（如按 // 截断）会在
  // `const u = 'https://x' ; ctx.subagents.start()` 这类行上**吞掉真实调用**，
  // 把假阳性换成假阴性——对边界门禁而言这是更坏的交易。
  // 当前仓库实际影响：plugins/src/index.ts 的 6 处 ctx.subagents 中有 2 处是注释提及。
  assert.equal(scanSource('/** ctx.subagents 上注册的 provider 名 */')['ctx.subagents'], 1)
  assert.equal(scanSource("// 不要用 ctx.subagents.start()")['ctx.subagents'], 1)
})

// ---------------------------------------------------------------- ③ 判定语义

const BASE1 = { baseline: { 'legacy/a.mjs': { 'ctx.subagents': 6 } } }

test('③ 与基线持平或低于基线均通过', () => {
  assert.equal(diffAgainstBaseline({ 'legacy/a.mjs': { 'ctx.subagents': 6 } }, BASE1).length, 0)
  assert.equal(diffAgainstBaseline({ 'legacy/a.mjs': { 'ctx.subagents': 2 } }, BASE1).length, 0)
})

test('③ 超出基线次数被归因为 increased', () => {
  const v = diffAgainstBaseline({ 'legacy/a.mjs': { 'ctx.subagents': 7 } }, BASE1)
  assert.equal(v.length, 1)
  assert.equal(v[0].kind, 'increased')
  assert.equal(v[0].actual, 7)
  assert.equal(v[0].allowed, 6)
})

test('③ 基线中不存在的新记号被归因为 new-token', () => {
  const v = diffAgainstBaseline({ 'legacy/a.mjs': { 'ctx.subagents': 6, 'ctx.agentDefaultModel': 1 } }, BASE1)
  assert.equal(v.length, 1)
  assert.equal(v[0].kind, 'new-token')
  assert.equal(v[0].token, 'ctx.agentDefaultModel')
})

test('③ 基线外的文件被归因为 new-file（棘轮的核心作用）', () => {
  const v = diffAgainstBaseline({ 'plugins/src/newFeature.ts': { 'ctx.subagents': 1 } }, BASE1)
  assert.equal(v.length, 1)
  assert.equal(v[0].kind, 'new-file')
})

test('③ 边界模块必须为零，且不接受基线例外', () => {
  const v = diffAgainstBaseline({ 'orchestrator/scheduler/scan.ts': { 'ctx.subagents': 1 } }, BASE1)
  assert.equal(v.length, 1)
  assert.equal(v[0].kind, 'must-be-zero')

  // 即使有人把它写进基线，也必须照样红——否则一次 --update-baseline 就能洗白违规
  const withBaselineEntry = { baseline: { 'orchestrator/scheduler/scan.ts': { 'ctx.subagents': 1 } } }
  const v2 = diffAgainstBaseline({ 'orchestrator/scheduler/scan.ts': { 'ctx.subagents': 1 } }, withBaselineEntry)
  assert.equal(v2.length, 1)
  assert.equal(v2[0].kind, 'must-be-zero')
})

test('③ 适配层豁免：runtime/adapters/dsh 允许调用执行面 API', () => {
  const scan = { 'runtime/adapters/dsh/subagents.ts': { 'ctx.subagents': 3, '@deepseek-ai/dsh-agent': 1 } }
  assert.equal(diffAgainstBaseline(scan, BASE1).length, 0)
})

// ---------------------------------------------------------------- ④ 棘轮真实性

test('④ 当前仓库扫描结果与基线完全一致（不多不少）', () => {
  const scan = scanRepo()
  const baseline = BASELINE.baseline
  assert.deepEqual(
    Object.keys(scan).sort(),
    Object.keys(baseline).sort(),
    '扫描到的文件集合与基线不一致：新增依赖文件或基线未下移',
  )
  for (const [file, hits] of Object.entries(scan)) {
    assert.deepEqual(hits, baseline[file], `${file} 的记号与基线不一致`)
  }
})

test('④ 基线不含适配层与边界模块（豁免项不得混进债务清单）', () => {
  for (const file of Object.keys(BASELINE.baseline)) {
    assert.ok(!file.startsWith('runtime/adapters/dsh/'), `适配层不应进基线：${file}`)
    for (const pre of BASELINE.rules.mustBeZeroPrefixes) {
      assert.ok(!file.startsWith(pre), `边界模块不应进基线：${file}`)
    }
  }
})

test('④ 仓库当前状态通过 --check（CI 门禁即为绿）', () => {
  const out = execFileSync(process.execPath, [CLI, '--check'], { cwd: ROOT, encoding: 'utf8' })
  assert.match(out, /dsh-boundary: PASS/)
})

test('④ 真的新增一处执行面调用会让 --check 变红', () => {
  // 端到端证明棘轮拦得住回归：在真实仓库里加一个真实文件，跑真实 CLI。
  // 这是纯函数单测无法替代的部分——扫描范围（git ls-files 口径）出错时纯函数仍会全绿。
  const dir = join(ROOT, 'plugins', 'src')
  const file = join(dir, '__boundary_ratchet_probe.mjs')
  try {
    writeFileSync(file, 'export const probe = () => ctx.subagents.start()\n', 'utf8')
    let code = 0
    let out = ''
    try {
      out = execFileSync(process.execPath, [CLI, '--check'], { cwd: ROOT, encoding: 'utf8' })
    } catch (e) {
      code = e.status
      out = String(e.stdout || '')
    }
    assert.equal(code, 1, '新增执行面依赖必须让 --check 以 1 退出')
    assert.match(out, /__boundary_ratchet_probe\.mjs/)
    assert.match(out, /new-file/)
  } finally {
    rmSync(file, { force: true })
  }
})

test('④ --update-baseline 拒绝把边界模块写进基线', () => {
  // 用临时 git 仓库验证拒绝逻辑，避免污染真实仓库
  const tmp = mkdtempSync(join(ROOT, '.tmp-boundary-guard-'))
  try {
    mkdirSync(join(tmp, 'orchestrator'), { recursive: true })
    writeFileSync(join(tmp, 'orchestrator', 'x.mjs'), 'ctx.subagents.start()\n', 'utf8')
    execFileSync('git', ['init', '-q'], { cwd: tmp })
    execFileSync('git', ['add', '-A'], { cwd: tmp })
    const script = readFileSync(CLI, 'utf8')
    writeFileSync(join(tmp, 'scan.mjs'), script, 'utf8')
    // 探针目录不属于仓库，脚本的 ROOT 会解析到临时目录；此处只断言拒绝分支存在且可触发
    let code = 0
    try {
      execFileSync(process.execPath, [join(tmp, 'scan.mjs'), '--update-baseline'], { cwd: tmp, encoding: 'utf8' })
    } catch (e) {
      code = e.status
    }
    assert.equal(code, 1, '边界模块进入基线必须被拒绝')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('④ 记号总数与清单口径一致（供 PRT-002 文档引用）', () => {
  const scan = scanRepo()
  const total = Object.values(scan).reduce((n, h) => n + totalOf(h), 0)
  assert.ok(total > 0, '当前仓库必然存在待迁移的执行面债务')
  // 基线是债务快照；总数变化必须伴随基线变更，因此这里用基线自身对账
  const baselineTotal = Object.values(BASELINE.baseline).reduce((n, h) => n + totalOf(h), 0)
  assert.equal(total, baselineTotal)
})
