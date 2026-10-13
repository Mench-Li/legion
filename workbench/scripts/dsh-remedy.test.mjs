// workbench/scripts/dsh-remedy.test.mjs
// 运行：node --experimental-strip-types workbench/scripts/dsh-remedy.test.mjs
//
// ============================================================================
// 「装上缺的 bundle」这条修法的**可粘贴性**判据。
//
// 守的是一句话：面板原来打印的是
//
//     dsh plugin --profile <profile-name> add @deepseek-ai/dsh-subagent-codex
//
// 它**看着能跑、其实跑不了**，两处都在 DSH 源码里核对过：
//   ① `<profile-name>` 是字面占位符，而 `--profile` 是 requiredOption；
//   ② 这台机器的 profile 是 `desktop`，DSH 明确拒绝（Electron 独占）。
//
//   > 一条**看起来能跑**的修法命令，比"没有命令、只说清该做什么"更糟：
//   > 前者会让人以为自己照做了（粘贴 → 报错 → 回头怀疑是别的地方坏了）。
//
// 所以本文件的核心判据是**"什么时候必须不给命令"**，而不是"命令长什么样"。
// ============================================================================
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bundleInstallRemedy,
  isAcceptableProfileName,
  profileManagedByDesktop,
  resolveProfileName,
} from '../src/dshRemedy.ts'

const CODEX = '@deepseek-ai/dsh-subagent-codex'
const CLAUDE = '@deepseek-ai/dsh-subagent-claude-code'

describe('Desktop 独占判定', () => {
  test('★ 大小写不敏感（DSH 用的是 profile.toLowerCase() === "desktop"）', () => {
    for (const name of ['desktop', 'Desktop', 'DESKTOP', 'DeSkToP']) {
      assert.equal(profileManagedByDesktop(name), true, name + ' 应当判为 Desktop 独占')
    }
    for (const name of ['web', 'tui', 'headless', 'desktop2', 'my-desktop', null, undefined, '']) {
      assert.equal(profileManagedByDesktop(name), false, String(name) + ' 不该判为 Desktop 独占')
    }
  })
})

describe('修法命令：什么时候给、什么时候不给', () => {
  test('★ 普通 profile ⇒ 给一条**填好真名**的可粘贴命令', () => {
    const r = bundleInstallRemedy('web', [CODEX])
    assert.equal(r.kind, 'pasteable')
    assert.equal(r.command, `dsh plugin --profile web add ${CODEX}`)
    // 命令里**不得**残留占位符 —— 那正是原来那句的毛病
    assert.ok(!r.command.includes('<'), '不得残留占位符：' + r.command)
    assert.ok(!r.command.includes('>'), '不得残留占位符：' + r.command)
  })

  test('★★ desktop profile ⇒ **不给命令**（DSH 会拒绝它）', () => {
    // 这是本次修的核心：原来给的那句在这台机器上必然是 exit 1。
    const r = bundleInstallRemedy('desktop', [CODEX])
    assert.equal(r.kind, 'no-command', 'Desktop 独占时不该给出一条跑不了的命令')
    assert.ok(!('command' in r), 'no-command 分支不得带 command 字段')
    assert.match(r.explanation, /managed exclusively by the Electron application/, '要引用 DSH 的原文拒绝理由')
    assert.match(r.explanation, /命令行装不了/)
    // 必须给出**替代做法**，不能只说"不行"
    assert.ok(r.steps.some(s => s.includes('插件')), '要指向 Desktop 的插件配置界面')
    assert.ok(r.steps.some(s => s.includes(CODEX)), '要说清到底要装什么')
  })

  test('★ 大小写不同的 Desktop 也拦（否则会漏一条跑不了的命令）', () => {
    for (const name of ['Desktop', 'DESKTOP']) {
      assert.equal(bundleInstallRemedy(name, [CODEX]).kind, 'no-command', name)
    }
  })

  test('★★ profile 未知 ⇒ **不给命令**（宁可不给，也不给带占位符的假命令）', () => {
    for (const unknown of [null, undefined, '']) {
      const r = bundleInstallRemedy(unknown, [CODEX])
      assert.equal(r.kind, 'no-command', String(unknown) + ' 应当走"不给命令"分支')
      // 但要把**形状**用文字讲清楚，并把包名列出来（用户能自己填）
      assert.ok(r.steps.some(s => s.includes('dsh plugin --profile')), '要说明命令的形状')
      assert.ok(r.steps.some(s => s.includes(CODEX)))
      assert.match(r.explanation, /还不知道/)
    }
  })

  test('★ 非法 profile 名也走"不给命令"（DSH 的 resolveProfileDir 都不收）', () => {
    for (const bad of ['a/b', 'a\\b', '.', '..', 'node_modules']) {
      const r = bundleInstallRemedy(bad, [CODEX])
      assert.equal(r.kind, 'no-command', JSON.stringify(bad) + ' 不该被拼进命令')
    }
  })

  test('★ 没有包名 ⇒ 不给命令（空 add 只会得到用法错误）', () => {
    for (const empty of [[], [''], ['  '], null, undefined]) {
      const r = bundleInstallRemedy('web', empty)
      assert.equal(r.kind, 'no-command')
      assert.match(r.explanation, /还不知道需要装哪个/)
    }
  })

  test('★ 非法包名拒绝拼命令（防拼出一条被 shell 解析出别的意思的行）', () => {
    for (const bad of ['a b', 'a;rm -rf /', 'a|b', '$(whoami)', '`id`', 'a>b', 'a&b', '@scope/', '../x', 'a"b', "a'b"]) {
      const r = bundleInstallRemedy('web', [bad])
      assert.equal(r.kind, 'no-command', JSON.stringify(bad) + ' 不该被拼进命令')
      assert.match(r.explanation, /不合法/)
      assert.ok(!('command' in r))
    }
  })

  test('多个包时按顺序拼在同一条命令里（一次装完，不用粘两遍）', () => {
    const r = bundleInstallRemedy('tui', [CODEX, CLAUDE])
    assert.equal(r.kind, 'pasteable')
    assert.equal(r.command, `dsh plugin --profile tui add ${CODEX} ${CLAUDE}`)
  })

  test('★ 命令形状与 DSH 自己的用法示例一致', () => {
    // DSH: apps/cli/src/args.ts:99 `dsh plugin --profile tui add <package>`
    const r = bundleInstallRemedy('tui', ['some-plugin'])
    assert.equal(r.command, 'dsh plugin --profile tui add some-plugin')
    // 且 --profile 在 add 之前（requiredOption 的位置）
    assert.ok(r.command.indexOf('--profile') < r.command.indexOf('add'))
  })
})

describe('profile 名解析', () => {
  test('★ 优先 DSH_PROFILE', () => {
    assert.equal(resolveProfileName({ DSH_PROFILE: 'web' }), 'web')
    assert.equal(resolveProfileName({ DSH_PROFILE: 'web', DSH_PROFILE_DIR: '/x/profiles/other' }), 'web')
  })

  test('★ 退回 DSH_PROFILE_DIR 的目录名（DSH 自己也是 basename(profileDir)）', () => {
    assert.equal(resolveProfileName({ DSH_PROFILE_DIR: 'C:\\Users\\a\\.dsh\\profiles\\desktop' }), 'desktop')
    assert.equal(resolveProfileName({ DSH_PROFILE_DIR: '/home/a/.dsh/profiles/tui' }), 'tui')
    assert.equal(resolveProfileName({ DSH_PROFILE_DIR: '/home/a/.dsh/profiles/tui/' }), 'tui', '结尾斜杠不影响')
  })

  test('两个都没有 / 名字非法 ⇒ null（面板据此不给命令）', () => {
    assert.equal(resolveProfileName({}), null)
    assert.equal(resolveProfileName(null), null)
    assert.equal(resolveProfileName(undefined), null)
    assert.equal(resolveProfileName({ DSH_PROFILE: '' }), null)
    assert.equal(resolveProfileName({ DSH_PROFILE: 'a/b' }), null, '非法名不该被当成有效值')
    assert.equal(resolveProfileName({ DSH_PROFILE_DIR: '' }), null)
  })

  test('本机实际环境形状：desktop', () => {
    // 本机实测 DSH_PROFILE=desktop、DSH_PROFILE_DIR=...\.dsh\profiles\desktop
    assert.equal(resolveProfileName({
      DSH_PROFILE: 'desktop',
      DSH_PROFILE_DIR: 'C:\\Users\\11150\\.dsh\\profiles\\desktop',
    }), 'desktop')
    // 而它正是"命令行不给命令"的那种 profile —— 这条链的终点：
    const r = bundleInstallRemedy('desktop', [CODEX])
    assert.equal(r.kind, 'no-command')
  })
})

describe('profile 名规则（照抄 DSH 的 resolveProfileDir）', () => {
  test('接受与拒绝的边界', () => {
    for (const ok of ['web', 'tui', 'headless', 'my-profile', 'a_b', 'A1']) {
      assert.equal(isAcceptableProfileName(ok), true, ok + ' 应当接受')
    }
    for (const bad of ['', '.', '..', 'node_modules', 'a/b', 'a\\b', '/abs', null, undefined, 1, {}]) {
      assert.equal(isAcceptableProfileName(bad), false, JSON.stringify(bad) + ' 应当拒绝')
    }
  })
})
