// workbench/scripts/agent-avatar.test.mjs — S1 头像基座：渲染/位面唯一/确定性/回退/离线门禁。
// 运行：node workbench/scripts/agent-avatar.test.mjs（沙箱 spawn 受限时直跑等效；宿主可 node --test）
// 载入方式：ts.transpileModule 直跑等效（同 doc-render.test.mjs，零新增依赖）；
// 转译产物写到本目录下，保证 `react/jsx-runtime` 能从 workbench/node_modules 解析。
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { renderToString } from 'react-dom/server'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const react = require('react')
const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src', 'avatar')
const tmpSlots = join(here, '.agent-avatar.slots.mjs')
const tmpComponent = join(here, '.agent-avatar.render.mjs')

const ROLES = [
  'requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops',
  'market-analyst', 'content-planner', 'ad-optimizer', 'growth-hacker', 'brand-copy',
  'product-manager', 'ux-designer', 'ui-designer', 'user-researcher', 'data-analyst',
  'ops-specialist', 'campaign-planner', 'support-lead', 'data-ops',
  'assistant', 'research-assistant', 'writer',
]
const SPARES = Array.from({ length: 15 }, (_, i) => 's' + String(i + 1).padStart(2, '0'))
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u

let AgentAvatar
let mod

function transpile(from, to, rewrite) {
  const out = ts.transpileModule(readFileSync(from, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  })
  if (out.diagnostics && out.diagnostics.length) throw new Error('transpile 诊断：' + JSON.stringify(out.diagnostics))
  let code = out.outputText
  if (rewrite) code = code.replace(/['"]\.\/slots['"]/g, "'./.agent-avatar.slots.mjs'")
  writeFileSync(to, code, 'utf8')
}

before(() => {
  transpile(join(SRC, 'slots.ts'), tmpSlots, false)
  transpile(join(SRC, 'AgentAvatar.tsx'), tmpComponent, true)
})
before(async () => {
  mod = await import(pathToFileURL(tmpSlots).href)
  AgentAvatar = (await import(pathToFileURL(tmpComponent).href)).default
})
after(() => {
  try { rmSync(tmpSlots, { force: true }) } catch { /* 清理 */ }
  try { rmSync(tmpComponent, { force: true }) } catch { /* 清理 */ }
})

const render = (token, extra) => renderToString(react.createElement(AgentAvatar, Object.assign({ token }, extra || {})))
const avatarSources = () => ['slots.ts', 'AgentAvatar.tsx', 'index.ts', 'assets'].map(f => { try { return readFileSync(join(SRC, f), 'utf8') } catch { return '' } }).join('\n')

describe('S1 头像基座', () => {
  test('TC-S1-01 渲染为 <svg 且没有单个字符文本节点（AC-R3-1）', () => {
    const html = render('human:requirement')
    assert.ok(html.includes('<svg'), '必须含 <svg 根节点')
    assert.equal(html.replace(/<[^>]*>/g, '').trim(), '', '不得有文本节点（emoji/首字）')
  })

  test('TC-S1-02 25 个岗位头像两两不同（AC-R3-3）', () => {
    const marks = ROLES.map(r => render('human:' + r))
    for (const m of marks) assert.ok(m.includes('<svg'))
    assert.equal(new Set(marks).size, ROLES.length, '25 个岗位头像必须两两不同')
  })

  test('TC-S1-03 位面表 = 25 岗位 ∪ s01..s15，>=40 且单射、确定性（AC-R3-3）', () => {
    const keys = mod.slotKeys()
    assert.equal(keys.length, ROLES.length + SPARES.length)
    assert.ok(keys.length >= 40)
    assert.equal(new Set(keys).size, keys.length, 'key 必须两两不同')
    for (const r of ROLES) assert.ok(keys.includes(r), '缺岗位位面：' + r)
    for (const s of SPARES) assert.ok(keys.includes(s), '缺备用位面：' + s)
    for (const r of ROLES) {
      const a = mod.resolveSlot('human:' + r)
      const b = mod.resolveSlot('human:' + r)
      assert.ok(a && b)
      assert.deepEqual(a, b, '同一 role 两次解析必须同值')
    }
    const slots = ROLES.map(r => JSON.stringify(mod.resolveSlot('human:' + r)))
    assert.equal(new Set(slots).size, ROLES.length, '25 个岗位各有且仅有一个位面（单射）')
  })

  test('TC-S1-04 同 token 幂等，且源码无随机/时钟/网络（AC-R3-4、AC-R8-1）', () => {
    assert.equal(render('human:coder'), render('human:coder'))
    const src = avatarSources()
    for (const banned of ['Math.random', 'Date.now', 'performance.now', 'new Date', 'fetch(', 'XMLHttpRequest', 'http://', 'https://']) {
      assert.ok(!src.includes(banned), '禁止出现 ' + banned)
    }
  })

  test('TC-S1-05/06/07/17 缺失/emoji/非法令牌 → 确定性占位人形，不显示名称首字（AC-R9-1/9-2、AC-R4-1）', () => {
    const values = [undefined, null, '', '   ', '\u{1F916}', '\u{1F9ED}', '\u{2699}\u{FE0F}', 'human:', 'human:UNKNOWN', 'HUMAN:requirement', 'human:requirement ', 'human:a/../b', 'not-a-token', '<img src=x>']
    const marks = values.map(v => render(v, { name: '析言' }))
    for (let i = 0; i < values.length; i += 1) {
      const html = marks[i]
      assert.ok(html.includes('<svg'), '必须渲染占位人形：' + String(values[i]))
      assert.ok(!EMOJI_RE.test(html.replace(/<[^>]*>/g, '')), '不得渲染 emoji 文本：' + String(values[i]))
      assert.ok(!html.includes('析'), '回退不得用 name 首字：' + String(values[i]))
    }
    assert.equal(new Set(marks.slice(0, 4).map(h => h)).size, 1, '空/缺失令牌必须落到同一占位人形')
  })

  test('TC-S1-08 组件契约：默认导出 + props + size/className 生效', () => {
    assert.equal(typeof AgentAvatar, 'function')
    const html = render('human:requirement', { size: 48, className: 'x-y' })
    assert.ok(html.includes('48'), 'size 必须反映到渲染尺寸')
    assert.ok(html.includes('x-y'), 'className 必须透传到根节点')
    const boundary = [0, -1, 1024, NaN].map(s => render('human:requirement', { size: s }))
    for (const h of boundary) assert.ok(h.includes('<svg'), '非法 size 仍必须渲染人形')
  })

  test('TC-S1-09 离线自足：无 <img、无 url( 外链、无网络调用（AC-R8-1）', () => {
    const src = avatarSources()
    for (const banned of ['<img', 'url(', 'src=', 'onerror']) {
      assert.ok(!src.includes(banned), '头像不得依赖 ' + banned)
    }
  })

  test('TC-S1-10 依赖零新增（AC-R8-2）', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@react-three/drei', '@react-three/fiber', 'react', 'react-dom', 'three'])
  })

  test('TC-S1-12 身份红线：avatar/name 不进 key/唯一约束（AC-R2-3）', () => {
    const src = readFileSync(join(SRC, 'AgentAvatar.tsx'), 'utf8')
    assert.ok(!/key=\{[^}]*\b(avatar|name)\b/.test(src), 'avatar/name 不得作为 React key')
    assert.ok(!/PRIMARY KEY|UNIQUE/.test(src))
  })
})
