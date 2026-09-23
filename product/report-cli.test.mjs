// product/report-cli.test.mjs
// ============================================================================
// 第 16 条第一刀（`legion --report=<kind>`）**自己的判据**
//
// ## 为什么这个套件的重点不是"三份报告现在打得出来"
//
// "三份都打得出来"只说明**今天**那三个模块没坏。它完全不能说明这个入口**有没有用**：
// 一个 `renderReport` 无论收到什么都返回第一份报告的实现，在这里也是全绿。
//
// 所以这个套件对三件事各做一次**反面控制**：
//   · 不认识的 kind **不许回落**（这是本入口唯一一个"错得很安静"的方向）；
//   · 渲染出空串 / 抛异常**必须各有具名码**（不然"报告是空的"会被读成"报告说没事"）；
//   · 表**不许变空**（表空了 ⇒ 上面那两条守卫没有任何输入）。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { REPORT_CLI_CODES, REPORT_KINDS, renderReport, reportKindIds } from './report-cli.mjs'
import { run } from './launcher/cli.mjs'

/** 收集输出的收集器（与 `cli.test.mjs` 同一形状）。 */
function collector() {
  const lines = []
  return { lines, write: (m) => lines.push(String(m)), text: () => lines.join('\n') }
}

test('① 报告表是封闭的、非空的，且顺序稳定', () => {
  assert.deepEqual(reportKindIds(), ['checklist', 'privacy', 'runbook'])
  // ★ 非空守卫：表空了，"三份都能渲染"这条断言会**一条都不跑**却仍然是绿的。
  assert.equal(REPORT_KINDS.length, 3, '报告表被抽空了 ⇒ 下面那些"都能渲染"什么也没证明')
  for (const k of REPORT_KINDS) {
    assert.equal(typeof k.kind, 'string')
    assert.equal(typeof k.what, 'string')
    assert.equal(typeof k.render, 'function')
    assert.equal(typeof k.data, 'function')
  }
})

test('② 三种 kind 都渲染得出非空文字；--json 那份可解析且非空', () => {
  for (const kind of reportKindIds()) {
    const r = renderReport(kind)
    assert.equal(r.ok, true, `${kind} 渲染失败：${r.message ?? ''}`)
    assert.equal(typeof r.text, 'string')
    assert.ok(r.text.trim().length > 40, `${kind} 渲染出来的东西太短（${r.text.length} 字符）⇒ 报告是空的`)
    // 默认那份是给人读的：不许整段是 JSON
    assert.ok(!r.text.trim().startsWith('{'), `${kind} 默认输出看起来是 JSON ⇒ 人读的那份没接上`)
  }
  const j = renderReport('checklist', { json: true })
  assert.equal(j.ok, true)
  assert.doesNotThrow(() => JSON.parse(j.text))
  assert.equal(typeof j.data, 'object')
  assert.ok(Object.keys(j.data).length > 0, '`--json` 那份是空对象')
})

test('③ ★ 负面控制：不认识的 kind 具名拒绝，且消息里列出**全部**可选项', () => {
  const r = renderReport('relase-checklist')          // 故意拼错
  assert.equal(r.ok, false)
  assert.equal(r.code, REPORT_CLI_CODES.UNKNOWN_KIND)
  for (const kind of reportKindIds()) {
    assert.ok(r.message.includes(kind), `拒绝信息里没列出可选值「${kind}」：${r.message}`)
  }
  // ★ 而且它**不许**悄悄回落成第一份：
  assert.equal(r.text, undefined, '拒绝的时候还带了正文 ⇒ 调用方可能把正文打出来')
})

test('④ ★ 载荷控制：注入一张假表，三条守卫必须都会红', () => {
  const kinds = [
    { kind: 'blank', what: '渲染成空串', render: () => '   \n  ', data: () => ({}) },
    { kind: 'boom-render', what: '渲染抛错', render: () => { throw new Error('渲染炸了') }, data: () => ({}) },
    { kind: 'boom-data', what: '判定抛错', render: () => 'x', data: () => { throw new Error('判定炸了') } },
  ]
  const blank = renderReport('blank', { kinds })
  assert.equal(blank.ok, false)
  assert.equal(blank.code, REPORT_CLI_CODES.NOT_TEXT, '渲染出空白却没报 NOT_TEXT ⇒ "报告是空的"会被读成"报告说没事"')

  const boomRender = renderReport('boom-render', { kinds })
  assert.equal(boomRender.ok, false)
  assert.equal(boomRender.code, REPORT_CLI_CODES.RENDER_FAILED)
  assert.ok(boomRender.message.includes('渲染炸了'), '失败信息里没有原始原因')

  const boomData = renderReport('boom-data', { kinds })
  assert.equal(boomData.ok, false)
  assert.equal(boomData.code, REPORT_CLI_CODES.RENDER_FAILED)

  // ★ 同一张假表上，认识的 kind 照常成功 ⇒ 上面三条不是"恒红"
  assert.equal(renderReport('blank', { kinds, json: true }).ok, true, '`--json` 那条路被连带判红了')
})

test('⑤ CLI 接线：旗标真的接到了这个 handler（退出码与输出一起看）', async () => {
  // ★ 这一条防的是"旗标写在帮助里、派发却没接"——那正是 `--help` 自己漂移过的那个形状。
  const bad = collector()
  const codeBad = await run({ argv: ['--report=relase'], env: {}, write: bad.write })
  assert.equal(codeBad, 2, '参数错必须是 2（与 --set-log-policy 同一条口径）')
  assert.ok(bad.text().includes('checklist'), `拒绝信息里没列可选项：${bad.text()}`)

  const ok = collector()
  const codeOk = await run({ argv: ['--report=checklist'], env: {}, write: ok.write })
  assert.equal(codeOk, 0)
  assert.ok(ok.text().trim().length > 40, '退出码是 0，而输出是空的')

  const js = collector()
  const codeJs = await run({ argv: ['--report=runbook', '--json'], env: {}, write: js.write })
  assert.equal(codeJs, 0)
  assert.doesNotThrow(() => JSON.parse(js.text()), '--json 打出来的不是 JSON')
})
