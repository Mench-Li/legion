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

// ── T-207：general 的两处客户端展示面（S2 用户卡 / S3 左轨徽标）图形化 ──────────
const GEAR_CHAR = '\u2699'

describe('T-207 general 客户端展示面（S2/S3）', () => {
  test('TC-S3-01 用户卡头像图形化，不再用齿轮字符（AC-R3-1）', () => {
    const src = read(C('Sidebar.tsx'))
    const m = /<div className="user-avatar">([\s\S]*?)<\/div>/.exec(src)
    assert.ok(m, '必须仍有 .user-avatar 节点')
    assert.ok(m[1].includes('<AgentAvatar'), '.user-avatar 内必须是 <AgentAvatar>')
    assert.ok(!new RegExp('user-avatar">\\s*' + GEAR_CHAR).test(src), '不得再把齿轮字符当头像内容')
  })

  test('TC-S3-02 左轨管理员徽标图形化，不再用「管」文字（AC-R3-1）', () => {
    const src = read(C('WorkspaceNavigation.tsx'))
    assert.ok(/className="workspace-user"[\s\S]{0,160}<AgentAvatar/.test(src), '.workspace-user 内必须是 <AgentAvatar>')
    assert.ok(!/className="workspace-user"[^>]*>管</.test(src), '不得再用「管」充当徽标')
  })

  test('TC-S3-03/04 两处同源 + general 令牌 = human:s11（AC-R3-2 / AC-R6-2）', () => {
    for (const f of ['Sidebar.tsx', 'WorkspaceNavigation.tsx']) {
      assert.ok(/from\s+['"][^'"]*external-agents['"]/.test(read(C(f))), f + ' 必须从 external-agents 取常量')
    }
    const ext = read('workbench/src/avatar/external-agents.ts')
    assert.ok(/general['"]?\s*:\s*['"]human:s11['"]/.test(ext), 'general 必须是 human:s11')
  })

  test('TC-S3-12 界面齿轮图标不被误伤（AC-R7-3）', () => {
    assert.ok(read(C('Sidebar.tsx')).includes(GEAR_CHAR), 'Sidebar 的界面齿轮用法仍在')
    assert.ok(read(C('CommandBar.tsx')).includes('模型配置'), 'CommandBar 的模型配置入口仍在')
  })
})
