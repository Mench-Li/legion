// workbench/scripts/agent-avatar-settings.test.mjs — S5 桌面展示面（二）源码扫描。
// 运行：node workbench/scripts/agent-avatar-settings.test.mjs（源码扫描，同 identity-gate.test.mjs）
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')
const C = (f) => 'workbench/src/components/' + f

describe('S5 桌面展示面（二）', () => {
  test('TC-S5-01/02 新建弹窗无 emoji 头像表、无缺省 emoji、请求体不提交 avatar（将军裁决 #1）', () => {
    const src = read(C('NewSpaceModal.tsx'))
    assert.ok(!src.includes('AVATAR_CHOICES'), '不得保留 emoji 下拉表')
    assert.ok(!/avatar:\s*'\u{1F916}'/u.test(src), '不得保留缺省 emoji')
    assert.ok(!/createAgent\([^)]*avatar/u.test(src), '新建请求体不得提交 avatar 字段')
    assert.ok(!/<select[^>]*avatar/u.test(src), '不得保留头像下拉配置')
  })

  test('TC-S5-03/04/05 三处成员头像改用组件，S11 不再拼纯文本（AC-R4-1）', () => {
    for (const f of ['ModelConfigModal.tsx', 'SkillsPanel.tsx', 'AgentTasksModal.tsx']) {
      assert.ok(read(C(f)).includes('<AgentAvatar'), f + ' 必须使用 <AgentAvatar')
    }
    assert.ok(!read(C('SkillsPanel.tsx')).includes('${a.avatar} ${a.name}'), 'S11 不得把头像与名字拼成纯文本')
    assert.ok(!/\{a\.avatar\} \{a\.name\}/.test(read(C('SkillsPanel.tsx'))), 'S11 不得把 avatar 当文本节点')
  })

  test('TC-S5-06 四处无第二套硬编码头像来源（AC-R4-4）', () => {
    for (const f of ['NewSpaceModal.tsx', 'ModelConfigModal.tsx', 'SkillsPanel.tsx', 'AgentTasksModal.tsx']) {
      assert.ok(!/const AVATARS\s*=/.test(read(C(f))), f + ' 不得有第二套头像表')
      assert.ok(!/AVATAR_CHOICES/.test(read(C(f))), f + ' 不得有 emoji 候选表')
    }
  })

  test('TC-S5-08 不新增成员编辑入口（将军裁决 #1 反向锚定）', () => {
    for (const f of ['NewSpaceModal.tsx', 'ModelConfigModal.tsx']) {
      assert.ok(!read(C(f)).includes('编辑资料'), f + ' 不得新增编辑成员入口')
      assert.ok(!read(C(f)).includes('头像上传'), f + ' 不得新增头像上传入口')
    }
  })

  test('TC-S5-09 旧 emoji/空令牌一律走同一组件回退（AC-R9-1）', () => {
    for (const f of ['ModelConfigModal.tsx', 'SkillsPanel.tsx', 'AgentTasksModal.tsx']) {
      assert.ok(/token=\{[^}]*\.?avatar/.test(read(C(f))), f + ' 令牌必须来自成员 avatar 字段')
    }
  })

  test('TC-S5-10 createAgent 签名兼容（可选 avatar 保留）', () => {
    const src = read('workbench/src/api.ts')
    assert.ok(src.includes('createAgent'), 'createAgent 仍在')
    assert.ok(/createAgent\(input: \{[^}]*avatar\?: string/.test(src), 'createAgent 的可选 avatar 参数必须保留（兼容）')
  })
})
