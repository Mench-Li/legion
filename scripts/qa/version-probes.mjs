#!/usr/bin/env node
// scripts/qa/version-probes.mjs —— T-197 的**破坏性验证**
// ============================================================================
// 每条探针做三件事：**改到**（真的改掉一处实现）→ 跑用例 → **逐字节还原**。
// 合格条件是四个一起满足：`改到 ∧ 变红 ∧ 逐字节还原 ∧ 非崩溃`。
//
// ## 为什么"变红"必须逐条证，而不是相信用例写得好
//
// 本工具守的是一条**两处都语法合法**的错误：版本号在
// `desktop/package.json` 与 `product/release/runtime-manifest.json` 里各写一份，
// 改一处、漏一处，两个文件都仍然是合法 JSON、都能被各自的读者读出来。
//
//   > 一条"两处必须相等"的判据，在它自己失效时，
//   > 与一条"两处本来就相等"的判据，输出的是同一个 ✔。
//
// 所以每条判据都要被**真的弄坏一次**，看它是否真的变红。
//
// ## 其中一条探针特别值得看：V6
//
// 它把 `renderVersionManifest` 里那行 `manifestFormat` **删掉**——也就是
// 把 2026-10-10 发现的真 bug **改回去**。若它不变红，说明那处修复没有判据守着，
// 下一次有人"顺手简化渲染器"就会把"产物装不进去"这个缺口带回来。
//
// ## V8 第一次写错了，记在这里
//
// 它原本改的是 `if (built.ok !== true) { return … }` 那道守卫，预期变红，
// 实测 **fail=0**。原因不是判据缺失，而是**探针选错了位置**：那道守卫是
// **冗余的**——下面还有一道 `if (manifestText === '')` 挡住同一个条件
// （`renderVersionManifest` 对不成功的组装结果返回空串）。
//
//   > 一条"改了却不变红"的探针，可能说明判据缺失，
//   > 也可能说明**改的那处本来就没有独立作用**——
//   > 两者在输出上都是同一个 ✖，而只有前一种需要补判据。
//
// 改成"绕开组装器、自己拼 JSON"之后，它才真正落在那条**唯一的**校验路径上。
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_TEST = 'scripts/release/version.test.mjs'

const PROBES = [
  {
    id: 'V1',
    test: 'scripts/release/version.test.mjs',
    desc: '`checkVersions` 忽略 legionVersion 的不一致（只比 desktop 与 productVersion）',
    file: 'scripts/release/version.mjs',
    find: `  if (src.desktopVersion !== src.productVersion || src.productVersion !== src.legionVersion) {`,
    replace: `  if (src.desktopVersion !== src.productVersion) {`,
  },
  {
    id: 'V2',
    test: 'scripts/release/version.test.mjs',
    desc: '`isSemver` 一律放行（`v1`、`1.2`、前导零都不再被拒）',
    file: 'scripts/release/version.mjs',
    find: `  return typeof value === 'string'
    && /^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$/.test(value)`,
    replace: `  return typeof value === 'string' && value.length > 0`,
  },
  {
    id: 'V3',
    test: 'scripts/release/version.test.mjs',
    desc: '`bump` 只改一处（package.json）—— 即"改了一个文件、另一个忘了"',
    file: 'scripts/release/version.mjs',
    find: `  if (!dryRun) {
    writeFileSync(join(root, VERSION_SOURCES.desktopPackage), desktopText)
    writeFileSync(join(root, VERSION_SOURCES.runtimeManifest), manifestText)
  }`,
    replace: `  if (!dryRun) {
    writeFileSync(join(root, VERSION_SOURCES.desktopPackage), desktopText)
  }`,
  },
  {
    id: 'V4',
    test: 'scripts/release/version.test.mjs',
    desc: '`bump --dry-run` 仍然落盘（"先看看"变成了"已经改了"）',
    file: 'scripts/release/version.mjs',
    find: `  if (!dryRun) {
    writeFileSync(join(root, VERSION_SOURCES.desktopPackage), desktopText)
    writeFileSync(join(root, VERSION_SOURCES.runtimeManifest), manifestText)
  }`,
    replace: `  {
    writeFileSync(join(root, VERSION_SOURCES.desktopPackage), desktopText)
    writeFileSync(join(root, VERSION_SOURCES.runtimeManifest), manifestText)
  }`,
  },
  {
    id: 'V5',
    test: 'scripts/release/version.test.mjs',
    desc: '派生成照抄 DSH 版本（不再是 major.minor + patch 归零）',
    file: 'scripts/release/version.mjs',
    find: `  return Object.freeze({ ok: true, productVersion: \`\${m[1]}.\${m[2]}.0\`, rule: 'DSH 的 major.minor + patch 归零' })`,
    replace: `  return Object.freeze({ ok: true, productVersion: String(dshVersion), rule: '照抄' })`,
  },
  {
    id: 'V6',
    test: 'scripts/release/version.test.mjs',
    desc: '★ 把渲染器丢 manifestFormat 的**真 bug 改回去**（产物装不进去，但仍是合法 JSON）',
    file: 'product/launcher/runtime-manifest.mjs',
    find: `    \`  "manifestFormat": \${JSON.stringify(MANIFEST_FORMAT)}\`,\n`,
    replace: '',
  },
  {
    id: 'V7',
    test: 'scripts/release/version.test.mjs',
    desc: '渲染器丢掉 releasedAt（"什么时候出的"这一栏消失，其它都还在）',
    file: 'product/launcher/runtime-manifest.mjs',
    find: `    ...(result.manifest.releasedAt === undefined
      ? []
      : [\`  "releasedAt": \${JSON.stringify(result.manifest.releasedAt)}\`]),\n`,
    replace: '',
  },
  {
    id: 'V8',
    test: 'scripts/release/version.test.mjs',
    desc: '`bump` 绕开生产组装器，自己拼 JSON 落盘（清单校验整条被跳过）',
    file: 'scripts/release/version.mjs',
    find: `  const manifestText = renderVersionManifest(built)`,
    // 手拼一份"看起来对"的清单：字段齐全、也是合法 JSON，但**没有经过**
    // `buildVersionManifest` 的 `validateManifest` 与补丁层交叉验证。
    // 这正是"两份清单长得一样、一份是验过的"这个缺口。
    replace: `  const manifestText = \`\${JSON.stringify({
    manifestFormat: 'legion/version-manifest@1',
    productVersion: nextVersion, legionVersion: nextVersion, dshVersion: nextDsh,
    dshCompositionPatchVersion: 1, runtimeContractVersion: 1, packProtocolVersion: 1,
    schemaVersion: src.runtimeManifest.schemaVersion, channel: channel ?? src.channel,
  }, null, 2)}\\n\``,
  },
]

function patchText(original, find, replace) {
  const eol = /\r\n/.test(original) ? '\r\n' : '\n'
  const norm = original.replace(/\r\n/g, '\n')
  const occurrences = norm.split(find).length - 1
  if (occurrences !== 1) return { occurrences, patched: null, eol }
  const patched = norm.replace(find, replace)
  return { occurrences, patched: eol === '\r\n' ? patched.replace(/\n/g, '\r\n') : patched, eol }
}

function readOutcome(out) {
  const fail = /^ℹ fail (\d+)$/m.exec(out)
  const pass = /^ℹ pass (\d+)$/m.exec(out)
  return {
    failCount: fail ? Number(fail[1]) : null,
    passCount: pass ? Number(pass[1]) : null,
    // runner 没产出汇总 = 崩溃式变红，按纪律**不算证据**
    crashed: fail === null,
    assertions: /AssertionError|ERR_ASSERTION/.test(out),
  }
}

const results = []
for (const p of PROBES) {
  const abs = join(ROOT, p.file)
  const original = readFileSync(abs, 'utf8')
  const { occurrences, patched, eol } = patchText(original, p.find, p.replace)
  const row = { ...p, occurrences, eol, applied: false, red: false, crashed: false, restored: false, detail: '' }
  if (occurrences !== 1 || patched === null) {
    row.detail = occurrences === 0
      ? `锚点未命中（行尾=${eol}，已归一后仍不匹配：写法漂移？）`
      : `锚点命中 ${occurrences} 次（应为 1）`
    results.push(row)
    continue
  }
  try {
    writeFileSync(abs, patched)
    row.applied = readFileSync(abs, 'utf8') !== original
    const r = spawnSync(process.execPath, ['--test', p.test ?? DEFAULT_TEST], { cwd: ROOT, encoding: 'utf8', timeout: 240_000 })
    const o = readOutcome(`${r.stdout ?? ''}${r.stderr ?? ''}`)
    row.crashed = o.crashed
    row.red = o.failCount !== null && o.failCount > 0
    row.detail = o.crashed
      ? 'runner 未产出汇总（崩溃式变红，按纪律不算证据）'
      : `fail=${o.failCount} pass=${o.passCount}${o.assertions ? ' 含断言级失败' : ''}`
  } finally {
    writeFileSync(abs, original)
    row.restored = readFileSync(abs, 'utf8') === original
  }
  results.push(row)
}

const pad = (s, n) => String(s).padEnd(n, ' ')
console.log('\n破坏性验证（T-197 桌面端版本号）\n')
console.log(`${pad('探针', 6)}${pad('改到', 6)}${pad('变红', 6)}${pad('还原', 8)}说明`)
console.log('-'.repeat(112))
for (const r of results) {
  const mark = (b) => (b ? '✔' : '✖')
  const ok = r.applied && r.red && r.restored && !r.crashed
  console.log(`${pad(r.id, 6)}${pad(mark(r.applied), 6)}${pad(mark(r.red), 6)}${pad(mark(r.restored), 8)}${ok ? '' : '← '}${r.desc}｜${r.detail}`)
}
const bad = results.filter((r) => !(r.applied && r.red && r.restored && !r.crashed))
console.log('-'.repeat(112))
console.log(`合计 ${results.length - bad.length}/${results.length} 条探针同时满足：改到 ∧ 变红 ∧ 逐字节还原 ∧ 非崩溃\n`)
if (bad.length > 0) {
  for (const r of bad) console.log(`  ${r.id}  ${r.desc}｜${r.detail}`)
  process.exit(1)
}
process.exit(0)
