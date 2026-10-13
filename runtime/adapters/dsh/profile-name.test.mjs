// runtime/adapters/dsh/profile-name.test.mjs
// ============================================================================
// 「这个守护跑在哪个 profile 上」的判据。
//
// 这块存在的唯一理由是**别给出一条跑不了的命令**，所以判据的重点是两条相反的边界：
//   · 该给名字时必须给对（否则面板只能给占位符）；
//   · 该认不出来时必须认不出来（宁可不给，也不给假的）。
//
// 第三路（argv 认 Desktop 宿主）是 2026-10-13 实机补的 —— 因为前两路在那台机器上**都取不到**，
// 而 Desktop 用户的正确答案本来就是"命令行装不了、去界面"，认出来才算答对。
// ============================================================================
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { isAcceptableProfileName, resolveProfileName } from './profile-name.mjs'

const DESKTOP_ARGV = [
  'D:\\software\\dsh\\DeepSeek Harness.exe',
  '--expose-internals',
  'D:\\software\\dsh\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js',
]

describe('profile 名合法性（照抄 DSH 的 resolveProfileDir）', () => {
  test('接受普通名字', () => {
    for (const ok of ['web', 'tui', 'headless', 'desktop', 'my-profile', 'a_b', 'A1']) {
      assert.equal(isAcceptableProfileName(ok), true, ok + ' 应当接受')
    }
  })

  test('拒绝 DSH 也不收的形状', () => {
    for (const bad of ['', '.', '..', 'node_modules', 'a/b', 'a\\b', '/abs', null, undefined, 1, {}, []]) {
      assert.equal(isAcceptableProfileName(bad), false, JSON.stringify(bad) + ' 应当拒绝')
    }
  })

  test('★ 刻意**不设长度上限**（DSH 没有这条规则，加了就是我们自己的偏差）', () => {
    // 第一版我顺手写了 `length <= 64`（学的是入站边界那边的防御）。
    // 但这里问的是"DSH 认不认这个名字"，而 DSH 只禁四个形状、不限制长度 ——
    // 加一条 DSH 没有的约束，会让一个合法名字被判成"不知道"，于是面板从"能给命令"
    // 退化成"给不出"。那是**我们**的问题，不是用户的。
    // （入站边界那边的长度上限另有其理：它约束的是**来自网络的不可信输入**。）
    assert.equal(isAcceptableProfileName('x'.repeat(65)), true)
    assert.equal(isAcceptableProfileName('x'.repeat(200)), true)
  })

  test('★ 这条规则**不保证 shell 安全**（空格与分号都是 DSH 允许的）', () => {
    // 拼命令前的 shell 安全闸在别处（workbench/src/dshRemedy.ts 的 bundleInstallRemedy）。
    // 在这里写清楚，是为了让下一个读到这份规则的人不去指望它防命令注入。
    assert.equal(isAcceptableProfileName('my profile'), true, 'DSH 允许空格')
    assert.equal(isAcceptableProfileName('a;id'), true, 'DSH 允许分号（注意不能拿它当 shell 校验用）')
    // 反过来说：它**确实**挡住的只有那几个 DSH 自己也不收的形状
    assert.equal(isAcceptableProfileName('a/b'), false)
  })
})

describe('resolveProfileName 的三路', () => {
  test('① DSH_PROFILE 优先', () => {
    assert.equal(resolveProfileName({ env: { DSH_PROFILE: 'web' } }), 'web')
    assert.equal(
      resolveProfileName({ env: { DSH_PROFILE: 'web', DSH_PROFILE_DIR: '/x/profiles/tui' } }),
      'web', '有直接值时不该回退',
    )
    assert.equal(resolveProfileName({ env: { DSH_PROFILE: '  web  ' } }), 'web', '两端空白要吃掉')
  })

  test('② 退回 DSH_PROFILE_DIR 的目录名（DSH 自己也是 basename(profileDir)）', () => {
    assert.equal(resolveProfileName({ env: { DSH_PROFILE_DIR: 'C:\\Users\\a\\.dsh\\profiles\\tui' } }), 'tui')
    assert.equal(resolveProfileName({ env: { DSH_PROFILE_DIR: '/home/a/.dsh/profiles/tui' } }), 'tui')
    assert.equal(resolveProfileName({ env: { DSH_PROFILE_DIR: '/home/a/.dsh/profiles/tui/' } }), 'tui', '结尾斜杠不影响')
  })

  test('★★ ③ 前两路都取不到、argv 带 dsh-desktop-host ⇒ desktop（实机补的那一路）', () => {
    // 实机症状：心跳里 profile 一直是 null，而同一台机器 pwsh 里 DSH_PROFILE=desktop 明明有值
    // ⇒ 那是**为工具进程注入**的，宿主进程自己读不到。argv 是宿主身上可靠得多的证据。
    assert.equal(resolveProfileName({ env: {}, argv: DESKTOP_ARGV }), 'desktop')
    assert.equal(resolveProfileName({ env: { DSH_PROFILE: '' }, argv: DESKTOP_ARGV }), 'desktop')
  })

  test('★ ③ 不抢前两路：有真名时就听真名的', () => {
    assert.equal(resolveProfileName({ env: { DSH_PROFILE: 'web' }, argv: DESKTOP_ARGV }), 'web')
  })

  test('★★ 认不出来时返回 null（面板据此**不给**带占位符的假命令）', () => {
    for (const input of [
      {}, undefined, null,
      { env: {} },
      { env: { DSH_PROFILE: '' } },
      { env: { DSH_PROFILE: 'a/b' } },      // 非法名不算有效值
      { env: { DSH_PROFILE_DIR: '' } },
      { env: { DSH_PROFILE_DIR: 'C:\\Users\\a\\.dsh\\profiles\\node_modules' } },  // 目录名非法
      { env: {}, argv: [] },
      { env: {}, argv: ['node', 'D:\\x\\some-other-entry.js'] },  // 不是 desktop 宿主
    ]) {
      assert.equal(resolveProfileName(input), null, JSON.stringify(input) + ' 应当认不出来')
    }
  })

  test('argv 判据只认字面 dsh-desktop-host，不做模糊匹配', () => {
    assert.equal(resolveProfileName({ env: {}, argv: ['dsh-desktop-host'] }), 'desktop')
    assert.equal(resolveProfileName({ env: {}, argv: ['my-dsh-desktop-host-notes.md'] }), 'desktop',
      '包含即算（这条判据只用于"认出 Desktop"，认错的后果是多指向界面一次，不是给出坏命令）')
    assert.equal(resolveProfileName({ env: {}, argv: [1, null, undefined] }), null, '非字符串 argv 不该炸')
  })

  test('脏数据不炸', () => {
    assert.doesNotThrow(() => resolveProfileName())
    assert.doesNotThrow(() => resolveProfileName({ env: {}, argv: null }))
    assert.doesNotThrow(() => resolveProfileName({ env: null, argv: null }))
  })
})
