// workbench/scripts/agent-avatar-surfaces.test.mjs — S4 桌面展示面（一）源码扫描。
// 运行：node workbench/scripts/agent-avatar-surfaces.test.mjs（readFileSync + 正则，同 identity-gate.test.mjs）
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')
const C = (f) => 'workbench/src/components/' + f
const FACES = ['WorkspaceNavigation.tsx', 'AgentWorkspace.tsx', 'CenterPanel.tsx', 'SceneAgentList.tsx']

describe('S4 桌面展示面（一）', () => {
  test('TC-S4-01/02/04 四个面均用 <AgentAvatar 且无首字回退（AC-R4-1）', () => {
    for (const f of FACES) assert.ok(read(C(f)).includes('<AgentAvatar'), f + ' 必须使用 <AgentAvatar')
    assert.ok(!read(C('WorkspaceNavigation.tsx')).includes('name.slice(0, 1)'))
    assert.ok(!read(C('AgentWorkspace.tsx')).includes('name.slice(0, 1)'))
  })

  test('TC-S4-03/05 中心面板删除动物表与轮换、无第二套头像来源（AC-R4-4）', () => {
    const src = read(C('CenterPanel.tsx'))
    assert.ok(!/AVATARS\s*=/.test(src), '不得保留动物兜底表')
    assert.ok(!/i % 8/.test(src), '不得保留按索引轮换')
    for (const f of FACES) assert.ok(!/const AVATARS\s*=/.test(read(C(f))), f + ' 不得有第二套头像表')
  })

  test('TC-S4-04/09 场景列表不再把 avatar 当文本节点，且全程无 <img 破图（AC-R4-1/4-3）', () => {
    const src = read(C('SceneAgentList.tsx'))
    assert.ok(!/>\s*\{agent\.avatar\}/.test(src), '不得把 avatar 直接当文本渲染')
    for (const f of FACES) {
      const text = read(C(f))
      assert.ok(!/<img[^>]*avatar/i.test(text), f + ' 头像不得走 <img（会破图/裸露 alt）')
    }
    // 头像面本身不得出现任何 <img（品牌图标等非头像图不在此列）。
    assert.ok(!/<img/.test(read(C('SceneAgentList.tsx'))))
    assert.ok(!/<img/.test(read(C('CenterPanel.tsx'))))
  })

  test('TC-S4-06 头像取值只来自 roster 令牌或统一空值回退（AC-R4-1）', () => {
    for (const f of FACES) {
      const src = read(C(f))
      assert.ok(src.includes('AgentAvatar'), f)
      assert.ok(/token=\{[^}]*avatar/.test(src), f + ' 令牌必须来自成员 avatar 字段')
    }
  })

  test('TC-S4-11 既有身份门禁不回归（源码层不引入 avatar/name 身份键）', () => {
    for (const f of FACES) {
      const src = read(C(f))
      assert.ok(!/key=\{[^}]*\.avatar/.test(src), f + ' avatar 不得作为 React key')
    }
  })
})
