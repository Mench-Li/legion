// workbench/mobile/avatar-parity.test.mjs — S6 移动端：位面表与桌面逐项同轴 + 内联人形渲染。
// 运行：node workbench/mobile/avatar-parity.test.mjs（读桌面 slots.ts 逐项比对 key 集合）
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

import * as mobile from './avatar.mjs'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const TMP = resolve(HERE, '.desktop-slots.mjs')

const ROLES = [
  'requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops',
  'market-analyst', 'content-planner', 'ad-optimizer', 'growth-hacker', 'brand-copy',
  'product-manager', 'ux-designer', 'ui-designer', 'user-researcher', 'data-analyst',
  'ops-specialist', 'campaign-planner', 'support-lead', 'data-ops',
  'assistant', 'research-assistant', 'writer',
]
const SPARES = Array.from({ length: 15 }, (_, i) => 's' + String(i + 1).padStart(2, '0'))
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u

let desktop

before(() => {
  const src = readFileSync(resolve(ROOT, 'workbench/src/avatar/slots.ts'), 'utf8')
  const out = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
  if (out.diagnostics && out.diagnostics.length) throw new Error('transpile 诊断：' + JSON.stringify(out.diagnostics))
  writeFileSync(TMP, out.outputText, 'utf8')
})
before(async () => { desktop = await import(pathToFileURL(TMP).href) })
after(() => { try { rmSync(TMP, { force: true }) } catch { /* 清理 */ } })

describe('S6 移动端头像', () => {
  test('TC-S6-01 两端位面 key 集合逐项相同（BR-13、I-5）', () => {
    assert.deepEqual([...mobile.slotKeys()].sort(), [...desktop.slotKeys()].sort(), '两套位面表不得漂移')
    assert.equal(mobile.slotKeys().length, 40)
    for (const r of ROLES) assert.ok(mobile.slotKeys().includes(r))
    for (const s of SPARES) assert.ok(mobile.slotKeys().includes(s))
  })

  test('TC-S6-01b 两端每个 key 的位面字段逐项相同（防只改 key 不改图形）', () => {
    for (const key of desktop.slotKeys()) {
      assert.deepEqual(mobile.resolveSlot('human:' + key), desktop.resolveSlot('human:' + key), '位面漂移：' + key)
    }
  })

  test('TC-S6-02/03 渲染为 <svg 人形而非 emoji，25 岗位两两不同（AC-R11-1）', () => {
    const marks = ROLES.map(r => mobile.renderAvatar('human:' + r, 22))
    for (const html of marks) {
      assert.ok(html.includes('<svg'), '必须渲染内联 SVG')
      assert.equal(html.replace(/<[^>]*>/g, '').trim(), '', '不得有文本节点（emoji/首字）')
    }
    assert.equal(new Set(marks).size, ROLES.length, '25 个岗位头像两两不同')
  })

  test('TC-S6-04 非法/缺失令牌降级为纯名称且不抛错（AC-R9-3、I-6）', () => {
    for (const bad of ['', 'not-a-token', '\u{1F916}', 'human:', 'human:UNKNOWN', null, undefined]) {
      assert.doesNotThrow(() => mobile.renderAvatar(bad, 22))
      const html = mobile.renderAvatar(bad, 22)
      assert.ok(html.includes('<svg'), '回退仍是占位人形而不是破图/emoji')
      assert.ok(!EMOJI_RE.test(html))
    }
    assert.equal(mobile.avatarLabel('', '衡码'), '衡码', '缺令牌时降级为纯名称')
    assert.equal(typeof mobile.avatarLabel('not-a-token', '衡码'), 'string')
  })

  test('TC-S6-06 移动端不 import 桌面 TS 源，且无网络调用（独立静态根、离线自足）', () => {
    const app = readFileSync(resolve(HERE, 'app.mjs'), 'utf8')
    assert.ok(!/from\s+['"][^'"]*workbench\/src/.test(app), '移动端不得 import 桌面 TS 源')
    const av = readFileSync(resolve(HERE, 'avatar.mjs'), 'utf8')
    for (const banned of ['fetch(', 'XMLHttpRequest', 'http://', 'https://', '<img']) {
      assert.ok(!av.includes(banned), '移动端头像不得依赖 ' + banned)
    }
  })

  test('TC-S6-06b 成员选择不再只有 <option> 纯文本（AC-R11-1）', () => {
    const app = readFileSync(resolve(HERE, 'app.mjs'), 'utf8')
    assert.ok(app.includes('agent-chips'), '成员选择必须有图形容器')
    assert.ok(app.includes('renderAvatar('), '成员选择必须渲染内联 SVG')
    const html = readFileSync(resolve(HERE, 'index.html'), 'utf8')
    assert.ok(html.includes('id="agent-chips"'), 'index.html 必须有成员选择容器')
  })
})
