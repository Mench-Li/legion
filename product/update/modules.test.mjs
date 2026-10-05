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

test('★★★ selfCheckAll() 必须覆盖**每一个**有自检的模块（新增一层要同时进两处）', async () => {
  // ★ 这条是我自己漏过一次之后补的：加 `recovery.mjs` 时我把 `EXPECTED_MODULES`
  //   与 `CHECKED_EXPORTS` 都改了，**忘了**改 `index.mjs` 的 `selfCheckAll()`。
  //   于是那个汇总读了 22 层，而实际上有 23 个模块带自检——
  //   上面那条"结论都是 ok"照样全绿，因为**它读的不是同一张清单**。
  //
  //   > 一份"汇总"漏掉一项时，它不会报错——它会**少报一个数**。
  //   > 而少报的那一项，恰恰是刚加的那个。
  //
  //   为什么必须两处都有：`CHECKED_EXPORTS` 是**测试**清单（只有跑测试时才读），
  //   而 `selfCheckAll()` 是**运行时**汇总（`product/update/index.mjs` 导出它，
  //   给桌面端/诊断用）。两处漏一处的后果不同，所以两处都要，且必须相等。
  const mod = await import(new URL('./index.mjs', import.meta.url))
  const all = await mod.selfCheckAll()
  const inSummary = [...all.results.map((r) => r.layer)].sort()
  const expected = Object.keys(CHECKED_EXPORTS).sort()
  assert.deepEqual(inSummary, expected,
    'selfCheckAll() 覆盖的层与有自检的模块对不上。缺的那一层不会让任何用例变红，'
    + '只会让运行时汇总**少报一个数**：\n'
    + `  只在 CHECKED_EXPORTS 里：${expected.filter((x) => !inSummary.includes(x)).join(', ') || '(无)'}\n`
    + `  只在 selfCheckAll 里：${inSummary.filter((x) => !expected.includes(x)).join(', ') || '(无)'}`)
  // 顺带把它**逐层**读过：汇总说全绿，就要求每一层真的 ok。
  for (const layer of all.results) {
    assert.equal(layer.ok, true, `${layer.layer} 在汇总里不是 ok：${JSON.stringify(layer.problems)}`)
  }
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

// ---------------------------------------------------------------------------
// ★★★ 每个**声明**的错误码都必须有**发出点**
// ---------------------------------------------------------------------------

/** 被扫描的目录：更新与升级两层（设计 §5–§9 的实现都在这里）。 */
const CODE_SCAN_DIRS = Object.freeze(['product/update', 'product/upgrade', 'product/launcher'])

/**
 * 扫出"声明了却从来不会被返回"的错误码。
 *
 * 判据（对表 `X_CODES` 里的项 `NAME`）：在**非用例**的 `.mjs` 里出现过
 * `X_CODES.NAME`（表定义本身写的是 `NAME: '字面量'`，所以任何 `X_CODES.NAME`
 * 都是**使用**），或者那个字面量出现在定义文件**之外**。
 *
 * 为什么这条判据值得单独存在：
 *
 *   `transport.mjs` 里有一段注释记着上一个同类缺陷——
 *   `BAD_HEADERS: 'net-bad-headers'`，**从来没有被任何分支返回过**。
 *   当时的结论是：
 *
 *   > 声明了却不发出的错误码，与一条不存在的判据是同一回事：
 *   > 读代码的人会以为"响应头有问题"这个情形被处理了。
 *
 *   ★ 而同一个缺陷在**隔壁的** `host.mjs` 里又躺了很久
 *     （`BAD_LENGTH: 'host-bad-length'`），另外还有十处散在七个文件里。
 *     一次机械扫描把它们全找了出来，每一处的判据其实都在——只是落在
 *     **别的形态**上（一个布尔字段、一个 `verdict` 字符串、另一个模块的码、
 *     或者干脆是 `code: null`）。所以每一处都是"删掉"，不是"补一条判据"。
 *
 *   > 教训在一个文件里学到了，而**隔壁那个文件**没有照做——
 *   > 这类不一致比一次孤立的手误更值得用一条机械判据钉住。
 */
function findDeclaredButNeverEmitted(readFile, listDir) {
  const files = []
  const collect = (dir) => {
    for (const entry of listDir(dir)) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) collect(rel)
      else if (entry.name.endsWith('.mjs')) files.push(rel)
    }
  }
  for (const dir of CODE_SCAN_DIRS) collect(dir)

  // ★★ 发出点只在**生产**文件里找，**不能**把用例算进去。
  //
  //   这一条是我自己撞出来的：第一版把用例也当成了"提到这个码"的证据，
  //   而本文件（`modules.test.mjs`）的注释里为了讲清这个缺陷，
  //   **原样写出**了 `BAD_LENGTH: 'host-bad-length'`。于是：
  //
  //     · 我把 host-bad-length 加回 `HOST_CODES` 做变异测试；
  //     · 守卫扫到"用例里提到过这个码" ⇒ 判定它有发出点 ⇒ **放行**。
  //
  //   也就是说**这条判据被它自己的说明文字弄瞎了**，而且只对它在注释里
  //   点名的那几个码失灵——正是它最该盯住的那几个。
  //
  //   > 一条判据的**解释**不能让这条判据失效；
  //   > 而"证据从哪来"这件事，比"判据怎么写"更容易出错。
  //
  //   原理上也站得住：**用例不可能"发出"一个错误码**——它只能断言。
  //   所以把用例排除掉不是绕过误报，是把判据的定义改对。
  const prod = files.filter((f) => !f.endsWith('.test.mjs'))
  const text = new Map(files.map((f) => [f, readFile(f)]))

  const dead = []
  for (const file of prod) {
    const src = text.get(file)
    const tableRe = /export const ([A-Z][A-Z0-9_]*CODES)\s*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\)/g
    let table
    while ((table = tableRe.exec(src)) !== null) {
      const tableName = table[1]
      const defStart = table.index
      const defEnd = table.index + table[0].length
      for (const item of table[2].matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*'([a-z0-9][a-z0-9-]{3,})'/gm)) {
        const [, name, code] = item
        let used = false
        // 只在**生产**文件里找证据（见上面那段注释）。
        for (const other of prod) {
          const otherText = text.get(other)
          const hits = [...otherText.matchAll(new RegExp(`\\b${tableName}\\.${name}\\b`, 'g'))]
          if (hits.some((h) => !(other === file && h.index > defStart && h.index < defEnd))) { used = true; break }
          if (other !== file && (otherText.includes(`'${code}'`) || otherText.includes(`"${code}"`))) { used = true; break }
        }
        if (!used) dead.push(`${file} :: ${tableName}.${name} = ${code}`)
      }
    }
  }
  return dead
}

test('★★★ 每个声明的错误码都必须有发出点（"声明了却不发出"与"判据不存在"是一回事）', async () => {
  const { readFileSync, readdirSync } = await import('node:fs')
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const dead = findDeclaredButNeverEmitted(
    (rel) => readFileSync(`${root}${rel}`, 'utf8'),
    (rel) => readdirSync(`${root}${rel}`, { withFileTypes: true }),
  )
  assert.deepEqual(dead, [],
    '这些错误码被声明了，但**没有任何分支会返回它们**。读代码的人会以为那个情形被处理了，'
    + '所以要么补上发出点，要么把这个码删掉：\n' + dead.join('\n'))
})
