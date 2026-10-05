// product/update/modules.test.mjs
// ============================================================================
// 装载期自检的汇总回归
//
// 每个模块在装载时都会把自己那几条核心判据真的跑一遍，并把结论挂在
// `*_CHECKED` 上。这一条测试做的事很简单：**把它们全部读一遍，并要求
// 全部为 ok**。
//
// 为什么值得单独一条测试：这些自检的价值在于"有人放宽了某条拒绝时下一次
// 启动就暴露"。而如果没有人读那些结论，它们就只是一段启动时白跑的开销——
// 一个 `ok: false` 躺在那里，而 CI 全绿。
//
// 除此之外它还钉住两件事：
//   · 模块清单（文件集）不会在重构里被悄悄删掉；
//   · 每个模块**都能在普通 Node 里载入**（不依赖 Electron、不依赖网络）。
// ============================================================================

import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const EXPECTED_MODULES = Object.freeze([
  'barrier', 'cache', 'canonical', 'client', 'closure', 'config', 'credential', 'envelope',
  'errors', 'extract', 'feed', 'health', 'helper', 'host', 'index', 'install', 'journal',
  'platform-build',
  // ★ `recovery`（设计 §8 line 190 的数据备份恢复入口）在这个表里是**必须**的：
  //   这张表守的是"每个模块都在，且都能在普通 Node 里载入"，
  //   而"新加了一个模块但没人知道"正是它要拦的事。
  'recovery',
  'release', 'schedule', 'semver', 'state', 'transport', 'zip',
])

/** 模块 → 它导出的自检结论名。 */
const CHECKED_EXPORTS = Object.freeze({
  canonical: 'CANONICAL_CHECKED',
  envelope: 'ENVELOPE_CHECKED',
  semver: 'SEMVER_CHECKED',
  release: 'RELEASE_CHECKED',
  feed: 'FEED_CHECKED',
  host: 'HOST_CHECKED',
  transport: 'TRANSPORT_CHECKED',
  schedule: 'SCHEDULE_CHECKED',
  cache: 'CACHE_CHECKED',
  state: 'STATE_CHECKED',
  config: 'CONFIG_CHECKED',
  errors: 'ERRORS_CHECKED',
  extract: 'EXTRACT_CHECKED',
  closure: 'CLOSURE_CHECKED',
  zip: 'ZIP_CHECKED',
  health: 'HEALTH_CHECKED',
  'platform-build': 'PLATFORM_BUILD_CHECKED',
  journal: 'JOURNAL_CHECKED',
  barrier: 'BARRIER_CHECKED',
  credential: 'CREDENTIAL_CHECKED',
  install: 'INSTALL_CHECKED',
  helper: 'HELPER_CHECKED',
  recovery: 'RECOVERY_CHECKED',
})

test('每个更新模块都在，且都能在普通 Node 里载入', async () => {
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const present = readdirSync(dir)
    .filter((name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs'))
    .map((name) => name.replace(/\.mjs$/, ''))
    .sort()
  assert.deepEqual(present, [...EXPECTED_MODULES],
    '更新模块文件集与预期不符（新增/删除模块时请同步这张表）')
  for (const name of EXPECTED_MODULES) {
    const mod = await import(new URL(`./${name}.mjs`, import.meta.url))
    assert.ok(mod !== null && mod !== undefined, `${name}.mjs 没有导出任何东西`)
  }
})

test('★ 所有装载期自检结论都是 ok', async () => {
  const failures = []
  for (const [name, exportName] of Object.entries(CHECKED_EXPORTS)) {
    const mod = await import(new URL(`./${name}.mjs`, import.meta.url))
    const checked = mod[exportName]
    assert.ok(checked !== undefined, `${name}.mjs 没有导出 ${exportName}`)
    if (checked.ok !== true) {
      failures.push(`${name}: ${(checked.problems ?? []).join('；') || '(没有给出问题列表)'}`)
    }
  }
  assert.deepEqual(failures, [], `装载期自检未通过：\n${failures.join('\n')}`)
})

test('自检结论本身是检查过的（不是恒真的占位）', async () => {
  // ★ 一条"永远返回 ok:true"的自检比没有自检更糟：它会让"有人放宽了某条
  //   拒绝"看起来已经通过。所以这里逐条要求自检**真的报出了一个读数**。
  const requirements = Object.freeze({
    canonical: (c) => c.vectorCount >= 4 && c.rejectedCount >= 10,
    envelope: (c) => c.rejectedCases >= 8,
    semver: (c) => c.differenceCount >= 1,
    release: (c) => c.rejectedCases >= 15,
    feed: (c) => c.rejectedCases >= 8,
    host: (c) => c.rejectedOriginsOrSample !== undefined || c.sample !== undefined,
    schedule: (c) => Array.isArray(c.sample.ladder) && c.sample.ladder.length === 3,
    state: (c) => c.sample.chainLength >= 11,
    install: (c) => c.steps.length >= 8,
    extract: (c) => c.executableExtensions >= 15,
    health: (c) => c.loopbackHosts.length >= 3,
    'platform-build': (c) => c.codes.UNSUPPORTED === 'platform-build-unsupported',
    closure: (c) => c.protocol === 'legion/update-closure@1',
    zip: (c) => c.methods.DEFLATE === 8,
  })
  for (const [name, predicate] of Object.entries(requirements)) {
    const mod = await import(new URL(`./${name}.mjs`, import.meta.url))
    // 模块名里的连字符要换成下划线：`platform-build` → `PLATFORM_BUILD_CHECKED`。
    // （不带这个替换时，带连字符的模块会被查成 `PLATFORM-BUILD_CHECKED`——
    // 一个永远 undefined 的读数，于是这条用例对那个模块**什么也没检查**。）
    const checked = mod[`${name.toUpperCase().replace(/-/g, '_')}_CHECKED`]
    assert.ok(predicate(checked), `${name} 的自检读数看起来是占位的：${JSON.stringify(checked?.sample ?? checked)}`)
  }
})

test('更新模块不导入 Electron、不发起网络请求', async () => {
  // `product/update/` 是纯逻辑层：它必须能在 Node、CI、以及 helper 的
  // 随包 Node 里跑。Electron 只出现在 `desktop/`。
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const { readFileSync } = await import('node:fs')
  for (const name of EXPECTED_MODULES) {
    const source = readFileSync(`${dir}${name}.mjs`, 'utf8')
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    assert.equal(/from 'electron'|require\('electron'\)/.test(code), false, `${name}.mjs 导入了 Electron`)
  }
})
