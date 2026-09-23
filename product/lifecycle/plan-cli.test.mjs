// product/lifecycle/plan-cli.test.mjs
// ============================================================================
// 第 16 条第二刀的判据：三份**计划**的入口。
//
// 要钉死的三件事：
//   ① 计划表是**封闭**的，且不认识的 kind 是**具名拒绝**（不回落成第一份）；
//   ② 模式**必须显式给**：给错时计划整份不可用、打出来、且退出码是 2；
//   ③ 有发现**不改退出码**——那些发现是内容，脚本丢掉它们就再也看不见了。
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PLAN_CLI_CODES, PLAN_KINDS, renderPlan, planKindIds, layoutRoots,
} from './plan-cli.mjs'
import { run } from '../launcher/cli.mjs'

/** 收集输出的收集器（与 `cli.test.mjs` / `report-cli.test.mjs` 同一形状）。 */
function collector() {
  const lines = []
  return { lines, write: (m) => lines.push(String(m)), text: () => lines.join('\n') }
}

/** 一个临时的数据目录，用来当"产品自己的落点"（真的走盘）。 */
function withLayout(fn) {
  const root = mkdtempSync(join(tmpdir(), 'legion-plan-cli-'))
  try {
    const logs = join(root, 'logs')
    const cache = join(root, 'cache')
    const data = join(root, 'data')
    mkdirSync(logs); mkdirSync(cache); mkdirSync(data)
    writeFileSync(join(logs, 'a.log'), 'x'.repeat(10))
    writeFileSync(join(cache, 'b.bin'), 'y'.repeat(20))
    writeFileSync(join(data, 'mystery.db'), 'z')
    return fn({ logDir: logs, cacheDir: cache, dataDir: data })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('① 计划表是封闭的、非空的，且顺序稳定', () => {
  assert.deepEqual(planKindIds(), ['uninstall', 'export', 'retention'])
  assert.equal(PLAN_KINDS.length, 3, '计划表被抽空了 ⇒ 下面"三份都能渲染"什么也没证明')
  for (const k of PLAN_KINDS) {
    assert.equal(typeof k.kind, 'string')
    assert.equal(typeof k.flag, 'string')
    assert.equal(typeof k.what, 'string')
    assert.equal(typeof k.run, 'function')
    assert.equal(typeof k.render, 'function')
    assert.equal(typeof k.unusable, 'function')
  }
  // ★ 模式只有卸载那一份要（其余两份**不许**偷偷要一个模式：那会让它们在某些机器上必然失败）
  assert.deepEqual(PLAN_KINDS.filter((k) => k.needsMode).map((k) => k.kind), ['uninstall'])
})

test('② ★★ 不认识的 kind 是具名拒绝，且**不回落成第一份**', () => {
  const r = renderPlan('uninstal', { layout: {} })
  assert.equal(r.ok, false)
  assert.equal(r.code, PLAN_CLI_CODES.UNKNOWN_KIND)
  assert.equal(r.text, undefined, '不认识的 kind 不许打出**任何**一份计划')
  for (const k of planKindIds()) {
    assert.ok(r.message.includes(k), `拒绝信息里没列出可选项 ${k}：${r.message}`)
  }
})

test('③ 三份计划都能渲染出非空正文；`--json` 那份能解析', () => {
  withLayout((layout) => {
    for (const kind of planKindIds()) {
      const r = renderPlan(kind, { layout, mode: 'program-only' })
      assert.equal(r.ok, true, `${kind} 没渲染出来：${r.message}`)
      assert.ok(r.text.trim().length > 120, `${kind} 的正文太短（${r.text.length} 字符）——像没扫到东西`)
      const j = renderPlan(kind, { layout, mode: 'program-only', json: true })
      assert.doesNotThrow(() => JSON.parse(j.text), `${kind} --json 打出来的不是 JSON`)
      const data = JSON.parse(j.text)
      assert.equal(data.kind, kind)
      assert.ok(typeof data.stores === 'number')
    }
  })
})

test('④ ★★★ 卸载模式**必须显式且认识**：给错时计划整份不可用 + 打出合法值', () => {
  withLayout((layout) => {
    const r = renderPlan('uninstall', { layout, mode: 'purge-everything' })
    assert.equal(r.ok, false, '不认识模式却报成功 ⇒ 用户会以为那三个字是一个有效模式')
    assert.equal(r.code, PLAN_CLI_CODES.MODE_UNKNOWN)
    assert.ok(r.text !== undefined, '模式不认识时正文也要打出来（让人看见合法值）')
    for (const m of ['program-only']) {
      assert.ok(r.text.includes(m), `正文里没列合法模式 ${m}`)
    }
    // ★ 反面控制：认识模式时**不许**报那个码（否则上面那条是假绿）
    const okR = renderPlan('uninstall', { layout, mode: 'program-only' })
    assert.equal(okR.code, null)
    assert.equal(okR.ok, true)
  })
})

test('⑤ ★★ 要扫的根**只来自 layout**：一个默认值都不加，且安装目录在列表里', () => {
  assert.deepEqual(layoutRoots({}), [], '布局空着却给出了根 ⇒ 那是本模块自己发明了一个默认值')
  const layout = {
    installDir: 'C:\\prod\\app', dataDir: 'C:\\prod\\data', logDir: 'C:\\prod\\logs',
    secretsFile: 'C:\\prod\\secrets\\credentials.json',
  }
  const roots = layoutRoots(layout).map((r) => r.dir)
  assert.deepEqual(roots, ['C:\\prod\\app', 'C:\\prod\\data', 'C:\\prod\\logs', 'C:\\prod\\secrets\\credentials.json'])
  // ★ 安装目录漏了会怎样：program-only 的"会删"永远是"无"，而模式名正说着要删程序
  assert.ok(roots.includes(layout.installDir), '安装目录不在要扫的根里 ⇒ program-only 计划会让用户以为没有程序要删')
  // 重复的根只扫一次
  assert.equal(layoutRoots({ dataDir: 'C:\\x', logDir: 'C:\\x' }).length, 1)
})

test('⑥ ★ 一个都没扫到时，正文自己说出来（"没扫"不许变成一份看着干净的计划）', () => {
  const r = renderPlan('export', { layout: {} })
  assert.ok(r.text.includes('scan-no-roots'), `正文里没有报"一个根都没给"：${r.text.slice(0, 200)}`)
})

test('⑦ ★★ 载荷控制：抛错 ⇒ 具名拒绝；空白 ⇒ NOT_TEXT（都不许抛出来）', () => {
  const boom = renderPlan('export', { layout: {}, scan: () => { throw new Error('磁盘炸了') } })
  assert.equal(boom.code, PLAN_CLI_CODES.RENDER_FAILED)
  assert.equal(boom.text, undefined)

  const blankPlans = [{
    kind: 'export', flag: '--export-plan', what: '空的那份', needsMode: false,
    run: () => ({}), render: () => [], unusable: () => false,
  }]
  const blank = renderPlan('export', { layout: {}, plans: blankPlans, scan: () => ({ roots: [], stores: [], findings: [], truncated: false, scanned: 0 }) })
  assert.equal(blank.code, PLAN_CLI_CODES.NOT_TEXT)
  assert.equal(blank.text, undefined)
})

test('⑧ ★★ 正文自己声明"这是计划"（零副作用），且拒绝清单看得见', () => {
  withLayout((layout) => {
    const r = renderPlan('uninstall', { layout, mode: 'program-only' })
    assert.ok(r.text.includes('零副作用'), '正文没说"这是计划、什么都没做" ⇒ 与"已经删了"同形')
    assert.ok(r.text.includes('拒绝'), '拒绝清单没打出来 ⇒ 用户会以为"没列出来的都删了"')
    const e = renderPlan('export', { layout })
    assert.ok(e.text.includes('导出计划'))
    const t = renderPlan('retention', { layout, nowMs: 5_000_000_000 })
    assert.ok(t.text.includes('保留计划'))
    assert.ok(t.text.includes('用量 / 上限') || t.text.includes('上限'))
  })
})

test('⑨ ★★★ CLI 接线：旗标真的接到了派发（退出码与输出一起看）', async () => {
  const bad = collector()
  const codeBad = await run({ argv: ['--uninstall-plan=purge-everything'], env: {}, write: bad.write })
  assert.equal(codeBad, 2, '卸载模式不认识是**参数错** ⇒ 2（与 --report 的 kind 不认识同一条口径）')
  assert.ok(bad.text().includes('program-only'), `拒绝信息里没列合法模式：${bad.text().slice(0, 200)}`)

  const ok = collector()
  const codeOk = await run({ argv: ['--uninstall-plan=program-only'], env: {}, write: ok.write })
  assert.equal(codeOk, 0, `认识模式却退出 ${codeOk}：${ok.text().slice(0, 200)}`)
  assert.ok(ok.text().trim().length > 80, '退出码是 0，而输出是空的')

  const js = collector()
  const codeJs = await run({ argv: ['--export-plan', '--json'], env: {}, write: js.write })
  assert.equal(codeJs, 0)
  assert.doesNotThrow(() => JSON.parse(js.text()), '--json 打出来的不是 JSON')

  const ret = collector()
  const codeRet = await run({ argv: ['--retention-plan'], env: {}, write: ret.write })
  assert.equal(codeRet, 0)
  assert.ok(ret.text().includes('保留计划'))
})
