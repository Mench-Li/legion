#!/usr/bin/env node
/**
 * download-lines-probes.mjs — 多线路下载（T-196）的**破坏性验证**。
 *
 * 判据全绿与"根本没测到东西"在报表上是同一个东西，所以每条关键判据都要有探针
 * 证明它**真的会红**。报告四件事而不是红/绿：
 *   `applied`（补丁真的改到字节）/ `red`（**断言级**失败，崩溃不算证据）/
 *   `restored`（逐字节还原）/ 锚点命中数。
 *
 * 锚点匹配**对行尾不敏感**：本仓不同文件的行尾不一致（`cdp.mjs` 是全文 CRLF），
 * 而 LF 锚点对 CRLF 文件一次都命不中——它的表现却像"这条判据测不出来"。
 *
 * 用法：`node scripts/qa/download-lines-probes.mjs`
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_TEST = 'team-hub/download-lines.test.mjs'

const PROBES = [
  {
    id: 'D1',
    desc: '选线路时忽略访客地区（CN 访客不再命中 cn 线路）',
    file: 'team-hub/download-lines.mjs',
    find: `  if (cc !== null) featured = list.find((l) => l.countries.includes(cc)) ?? null`,
    replace: `  if (false) featured = list.find((l) => l.countries.includes(cc)) ?? null`,
  },
  {
    id: 'D2',
    desc: '配错时不再 fail closed（有问题也给线路）',
    file: 'team-hub/download-lines.mjs',
    find: `    lines: Object.freeze(problems.length === 0 ? lines : []),`,
    replace: `    lines: Object.freeze(lines),`,
  },
  {
    id: 'D3',
    desc: '路由不再读 CF-IPCountry（按地区选线整条失效）',
    file: 'team-hub/routes/site.mjs',
    find: `    const country = typeof req.headers?.['cf-ipcountry'] === 'string'
      ? req.headers['cf-ipcountry']
      : null`,
    replace: `    const country = null`,
  },
  {
    id: 'D4',
    desc: '渲染层不再筛协议（href 里能塞 javascript:）',
    file: 'team-hub/routes/site.mjs',
    find: `    .filter((l) => l !== null && typeof l === 'object' && isHttpUrl(l.url))`,
    replace: `    .filter((l) => l !== null && typeof l === 'object')`,
  },
  {
    id: 'D5',
    desc: '默认放行明文 http（安装包可被中间人替换）',
    file: 'team-hub/download-lines.mjs',
    find: `  if (parsed.protocol === 'http:' && allowInsecureHttp !== true) {`,
    replace: `  if (false && parsed.protocol === 'http:' && allowInsecureHttp !== true) {`,
  },
  {
    id: 'D6',
    desc: '备选线路不再渲染（选了线路却看不到别的线路）',
    file: 'team-hub/routes/site.mjs',
    find: `  const othersRow = has && otherLines.length > 0`,
    replace: `  const othersRow = false && has && otherLines.length > 0`,
  },
  // ── 上传器（SigV4）────────────────────────────────────────────────────────
  {
    id: 'O1',
    test: 'scripts/update/oss-put.test.mjs',
    desc: '签名密钥派生链写错（已知向量必须红）',
    file: 'scripts/update/oss-put.mjs',
    find: `  const kService = hmac(kRegion, service)`,
    replace: `  const kService = hmac(kRegion, 'not-the-service')`,
  },
  {
    id: 'O2',
    test: 'scripts/update/oss-put.test.mjs',
    desc: 'URI 编码退回 Buffer.map（空格会被编成 0，非 ASCII 会被编成 000）',
    file: 'scripts/update/oss-put.mjs',
    find: `    return Array.from(Buffer.from(ch, 'utf8'), (b) => \`%\${b.toString(16).toUpperCase().padStart(2, '0')}\`).join('')`,
    replace: `    return Buffer.from(ch, 'utf8').map((b) => \`%\${b.toString(16).toUpperCase().padStart(2, '0')}\`).join('')`,
  },
  {
    id: 'O3',
    test: 'scripts/update/oss-put.test.mjs',
    desc: '时刻取两次（头与签名跨秒不一致 → 偶发 SignatureDoesNotMatch）',
    file: 'scripts/update/oss-put.mjs',
    find: `    region, accessKey, secretKey, date: now,`,
    replace: `    region, accessKey, secretKey, date: new Date(),`,
  },
  {
    id: 'O4',
    test: 'scripts/update/oss-put.test.mjs',
    desc: '缺失的 bucket 被拼成字面量 undefined（打到 /undefined/ 却像个正常的 404）',
    file: 'scripts/update/oss-put.mjs',
    find: `  const hasBucket = typeof bucket === 'string' && bucket.trim() !== ''`,
    replace: `  const hasBucket = true`,
  },
  {
    id: 'O5',
    test: 'scripts/update/oss-put.test.mjs',
    desc: '公开读自检恒通过（403 也当成"已生效"，要等用户点开链接才发现）',
    file: 'scripts/update/oss-put.mjs',
    find: `    return {
      ok: res.ok,
      status: res.status,
      detail: res.ok ? '' : describeS3Error(text),
    }`,
    replace: `    return { ok: true, status: res.status, detail: '' }`,
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
console.log('\n破坏性验证（T-196 多线路下载）\n')
console.log(`${pad('探针', 6)}${pad('改到', 6)}${pad('变红', 6)}${pad('还原', 8)}说明`)
console.log('-'.repeat(108))
for (const r of results) {
  const mark = (b) => (b ? '✔' : '✖')
  const ok = r.applied && r.red && r.restored && !r.crashed
  console.log(`${pad(r.id, 6)}${pad(mark(r.applied), 6)}${pad(mark(r.red), 6)}${pad(mark(r.restored), 8)}${ok ? '' : '← '}${r.desc}｜${r.detail}`)
}
const bad = results.filter((r) => !(r.applied && r.red && r.restored && !r.crashed))
console.log('-'.repeat(108))
console.log(`合计 ${results.length - bad.length}/${results.length} 条探针同时满足：改到 ∧ 变红 ∧ 逐字节还原 ∧ 非崩溃\n`)
if (bad.length > 0) {
  for (const r of bad) console.log(`  ${r.id}  ${r.desc}｜${r.detail}`)
  process.exit(1)
}
process.exit(0)
