// workbench/scripts/account-page.test.mjs
// ============================================================================
// 账号管理（P0）—— 账号页**结构/文案/无障碍**的源码级守卫。
//
// 为什么读源码而不是跑组件：指挥台没有 jsdom/渲染器（与 identity-gate 同一条
// 边界）；本套件要守的是"区块在不在、顺序对不对、失败态有没有、按钮有没有
// 可访问名"这类结构问题。真实交互（键盘/读屏/双浏览器会话）由 T-226 手工走查。
//
// 对应用例：docs/G-mvt9or0l-1/TEST_CASES.md §4.4（TC-S4-*）
// ============================================================================
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (relPath) => readFileSync(new URL(relPath, import.meta.url), 'utf8')
const panel = read('../src/components/AccountPanel.tsx')
const device = read('../src/components/DevicePanel.tsx')
const settings = read('../src/components/WorkspaceSettings.tsx')
const css = read('../src/index.css')

const headings = [...panel.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1].trim())
const firstHeadingIndex = (title) => headings.indexOf(title)

describe('账号页结构（S4）', () => {
  it('TC-S4-01 七区块齐全且顺序正确', () => {
    const wanted = ['账号摘要', '基础信息', '账号信息', '账号安全', '登录中的设备', '执行设备', '账号管理']
    const indexes = wanted.map((title) => firstHeadingIndex(title))
    indexes.forEach((idx, i) => assert.ok(idx >= 0, `缺区块：${wanted[i]}`))
    assert.deepEqual([...indexes].sort((a, b) => a - b), indexes, '区块顺序必须递增')
  })

  it('TC-S4-02 摘要同时渲染 displayName 与 name，系统角色有文字', () => {
    assert.match(panel, /\{me\.displayName\}/)
    assert.match(panel, /\{me\.name\}/)
    assert.match(panel, /系统管理员/)
    assert.match(panel, /普通成员/)
  })

  it('TC-S4-03 用户名标注不可修改，且没有用户名输入框', () => {
    assert.match(panel, /登录名不可修改/)
    assert.match(panel, /用户名（登录名）/)
    assert.doesNotMatch(panel, /id="account-username"/)
  })

  it('TC-S4-04 账号信息字段齐全', () => {
    for (const label of ['用户 ID', '注册时间', '账号状态', '空间与角色', '当前会话', '活跃会话数', '执行设备数']) {
      assert.ok(panel.includes(label), `账号信息缺 ${label}`)
    }
  })

  it('TC-S4-05 账号安全同时含改口令表单与退出登录', () => {
    assert.match(panel, /type="password"/)
    assert.ok(panel.includes('改口令'))
    assert.ok(panel.includes('退出登录'))
  })

  it('TC-S4-06 当前会话标注「这台（现在）」，非当前才有「退出这台」', () => {
    assert.match(panel, /s\.sessionId === sessions\.currentId/)
    assert.match(panel, /这台（现在）/)
    assert.match(panel, /退出这台/)
  })

  it('TC-S4-07 执行设备三件事都在：配对码 / 换令牌 / 撤销', () => {
    for (const fn of ['makeCode', 'rotate', 'revoke']) {
      assert.ok(device.includes(`function ${fn}(`), `设备面板缺 ${fn}`)
    }
  })

  it('TC-S4-08 管理员区按 systemRole 条件渲染，用户列表显示「显示名（用户名）」', () => {
    assert.match(panel, /me\?\.systemRole === 'admin' &&/)
    assert.match(panel, /\{u\.displayName \?\? u\.name\}（\{u\.name\}）/)
  })

  it('TC-S4-09 本机机器令牌模式整块不渲染（判据不减少）', () => {
    assert.match(panel, /const active = hasSession\(\)/)
    assert.match(panel, /if \(!active && loaded\) return null/)
  })

  it('TC-S4-10 非管理员不请求用户列表：listUsers 只在 systemRole==admin 分支内', () => {
    const m = /if \(info\.systemRole === 'admin'\) setUsers\(await listUsers\(\)/.exec(panel)
    assert.ok(m, 'listUsers 必须在管理员分支内')
    const calls = panel.match(/listUsers\(/g) ?? []
    assert.equal(calls.length, 1, 'listUsers 只出现一次（管理员分支）')
  })

  it('TC-S4-11 三路读取用 allSettled，每区块独立错误态与重试', () => {
    assert.match(panel, /Promise\.allSettled\(\[fetchMe\(\), listSessions\(\), listDevices\(\)\]\)/)
    assert.doesNotMatch(panel, /Promise\.all\(\[fetchMe/)
    assert.match(panel, /sectionErrors/)
    const retry = panel.match(/>重试</g) ?? []
    assert.ok(retry.length >= 3, `独立错误态的重试入口至少 3 处，实际 ${retry.length}`)
  })

  it('TC-S4-12 初次加载有明确加载文案，不先渲染空表单', () => {
    assert.match(panel, /正在读取账号…/)
  })

  it('TC-S4-13 空态齐全：无会话 / 无设备 / 未加入空间', () => {
    assert.match(panel, /没有可显示的会话/)
    assert.match(device, /还没有设备/)
    assert.match(panel, /还没有加入任何空间/)
  })

  it('TC-S4-14 显示名纯文本渲染，无 dangerouslySetInnerHTML', () => {
    assert.doesNotMatch(panel, /dangerouslySetInnerHTML/)
    assert.match(panel, /\{me\.displayName\}/)
  })

  it('TC-S4-15 保存/撤销结果经 role=status / aria-live 播报', () => {
    assert.match(panel, /role="status"/)
    assert.match(panel, /aria-live="polite"/)
  })

  it('TC-S4-16 表单控件有可见 label；动作按钮有可访问名', () => {
    assert.match(panel, /htmlFor="account-display-name"/)
    assert.match(panel, /htmlFor="account-current-password"/)
    assert.match(panel, /htmlFor="account-new-password"/)
    for (const label of ['保存显示名', '取消', '改口令', '退出登录', '退出这台', '生成重置码', '生成邀请码']) {
      assert.ok(panel.includes(label), `缺可访问名：${label}`)
    }
  })

  it('TC-S4-17 忙碌时按钮禁用且保存有防重复提交保护', () => {
    const disabled = panel.match(/disabled=\{busy\}/g) ?? []
    assert.ok(disabled.length >= 5, `忙碌禁用至少 5 处，实际 ${disabled.length}`)
    assert.match(panel, /if \(busy\) return/)
  })

  it('TC-S4-18 保存后用服务端返回值回填，而不是只用本地草稿', () => {
    assert.match(panel, /const user = await updateProfile\(/)
    assert.match(panel, /setMe\(prev => \(prev === null \? prev : \{ \.\.\.prev, \.\.\.user \}\)\)/)
    assert.match(panel, /setDraftDisplayName\(user\.displayName\)/)
  })

  it('TC-S4-19 当前会话分支不渲染撤销按钮', () => {
    assert.match(panel, /s\.sessionId === sessions\.currentId[\s\S]{0,400}这台（现在）/)
  })

  it('TC-S4-20 长文本不撑破布局：overflow-wrap / word-break / min-width:0', () => {
    assert.match(css, /account-display-name[^}]*overflow-wrap: anywhere/)
    assert.match(css, /word-break: break-word/)
    assert.match(css, /min-width: 0/)
  })

  it('TC-S4-21 状态用文字而非只靠颜色', () => {
    assert.match(panel, /已停用/)
    assert.match(panel, /正常/)
    assert.match(panel, /这台（现在）/)
    assert.match(device, /还没连过/)
    assert.match(device, /'在线' : '离线'/)
  })

  it('TC-S4-22 账号页只挂一次；settings-connections 路由 id 不变', () => {
    assert.equal((settings.match(/<AccountPanel \/>/g) ?? []).length, 1)
    assert.equal((settings.match(/<DevicePanel/g) ?? []).length, 0, 'DevicePanel 已由 AccountPanel 内部挂载')
    assert.match(settings, /active === 'settings-connections'/)
    assert.match(settings, /账号与连接/)
  })

  it('TC-S4-23 DevicePanel 向后兼容：未传 devices 时自取，传入时用容器数据', () => {
    assert.match(device, /devices\?: DeviceRow\[\] \| null/)
    assert.match(device, /const controlled = devicesProp !== undefined/)
    assert.match(device, /const rows = controlled \? devicesProp \?\? \[\] : devices/)
    assert.match(device, /if \(!controlled\) void reload\(\)/)
  })
})
