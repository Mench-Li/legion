#!/usr/bin/env node
// scripts/update/verify-mirrors.mjs —— 多线路下载：**每条线路都必须与原站同字节**
// ============================================================================
// 起因（2026-10-09）。站点只经 Cloudflare Tunnel 对外，境内访客被分配到
// 洛杉矶边缘，195MB 安装包实测 **约 1.8 KB/s**（源站直连 connect 仅 0.06s）。
// 修法是给下载加**国内镜像**，而镜像带来的第一个风险不是"没配"，是
// **镜像上的字节与原站不同**：
//
//   > 一个"能下完、但下到的是另一份二进制"的镜像，
//   > 与一个"下不动的镜像"，在"这次下载有没有让用户中毒"这件事上不是一个东西——
//   > 只不过前者在**下载进度条**上看起来完全成功。
//
// 客户端有签名清单兜底（`product/update/` 那条线会校验 sha256，不符就拒收），
// 所以坏镜像**不会**变成坏安装——但它会变成一个 100% 失败率的下载，
// 而那时用户已经等了十分钟。这道闸把它提前到**发布时**发现。
//
// ## 两个必须说清的边界
//
// ① **速度是在跑这个脚本的机器上量的。** 它不能代表别的地区：
//    同一时刻，境内镜像对境内用户快、对境外用户可能很慢。所以
//    "从本机量到国内镜像很快"这句话，**不能**推出"境内用户下得快"。
//    要判断真实体验，得分别在境内与境外的机器上各跑一次。
// ② 默认只抽样（`--sample-bytes`），因为逐个线路拉完整 195MB 很贵。
//    抽样能证明 **可达性、总长度、Range 支持与实测速率**，
//    **不能**证明字节一致 —— 那需要 `--full`。
//    所以摘要一致那一列在抽样模式下是 `未验`，而**不是** `通过`。
//
// 用法：
//   node scripts/update/verify-mirrors.mjs --lines ./download-lines.json
//   node scripts/update/verify-mirrors.mjs --lines ./download-lines.json --manifest ./manifest.json
//   node scripts/update/verify-mirrors.mjs --lines ./download-lines.json --full
// ============================================================================

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { loadDownloadLines } from '../../team-hub/download-lines.mjs'

export const VERIFY_MIRRORS_FORMAT = 'legion/verify-mirrors@1'

function parseArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const next = argv[i + 1]
    args.set(token.slice(2), next !== undefined && !String(next).startsWith('--') ? next : 'true')
  }
  return args
}

const num = (v, d) => (typeof v === 'string' && Number.isFinite(Number(v)) ? Number(v) : d)

/** 读一份清单：本地路径或 URL。返回对象或 `null`（读不到就如实说读不到，不猜）。 */
async function readManifest(source, { timeoutMs }) {
  if (typeof source !== 'string' || source === '') return null
  try {
    if (/^https?:\/\//.test(source)) {
      const res = await fetch(source, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) return null
      return JSON.parse(await res.text())
    }
    const file = resolve(source)
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch { return null }
}

/**
 * 抽样拉一段：返回总长度、是否支持 Range、这段的字节数与耗时。
 *
 * ★ 总长度取自 `Content-Range` 的分母而不是 `Content-Length`：
 *   206 响应的 `Content-Length` 是**这一块**的长度，拿它当文件大小会让
 *   "三条线路大小一致"这条判据永远通过（三条都等于抽样字节数）。
 */
export async function probeLine(url, { sampleBytes = 4 * 1024 * 1024, timeoutMs = 30_000 } = {}) {
  const started = Date.now()
  let res
  try {
    res = await fetch(url, {
      redirect: 'error', // 与客户端同一姿态：不跟随跨 origin 重定向
      headers: { Range: `bytes=0-${sampleBytes - 1}`, 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { ok: false, code: 'request-failed', reason: `${error?.name ?? 'Error'}: ${error?.message ?? error}` }
  }
  if (res.status !== 206 && res.status !== 200) {
    return { ok: false, code: 'bad-status', reason: `HTTP ${res.status}`, status: res.status }
  }
  const rangeSupported = res.status === 206
  const contentRange = res.headers.get('content-range') ?? ''
  const totalFromRange = /^bytes \d+-\d+\/(\d+)$/.exec(contentRange.trim())
  const declaredTotal = totalFromRange ? Number(totalFromRange[1]) : Number(res.headers.get('content-length') ?? NaN)

  const hash = createHash('sha256')
  let received = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      hash.update(value)
      // 200（不支持 Range）时会把整个文件拉下来——那就到此为止，
      // 免得一个"不支持断点续传"的镜像把这次校验变成一次完整下载。
      if (!rangeSupported && received >= sampleBytes) { await reader.cancel(); break }
    }
  } catch (error) {
    return { ok: false, code: 'read-failed', reason: `${error?.message ?? error}`, received }
  }
  const elapsedMs = Date.now() - started
  return {
    ok: true,
    status: res.status,
    rangeSupported,
    // 只信 `Content-Range` 的分母；拿不到就记 `null`（**不**拿 content-length 冒充）。
    totalBytes: Number.isSafeInteger(declaredTotal) && declaredTotal > 0 ? declaredTotal : null,
    sampleBytes: received,
    sampleSha256: hash.digest('hex'),
    elapsedMs,
    bytesPerSecond: elapsedMs > 0 ? Math.round((received / elapsedMs) * 1000) : null,
  }
}

/** 完整拉一遍并算 sha256（`--full` 用）。 */
export async function downloadDigest(url, { timeoutMs = 30 * 60_000 } = {}) {
  const started = Date.now()
  let res
  try {
    res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    return { ok: false, code: 'request-failed', reason: `${error?.message ?? error}` }
  }
  if (!res.ok) return { ok: false, code: 'bad-status', reason: `HTTP ${res.status}` }
  const hash = createHash('sha256')
  let bytes = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    hash.update(value)
  }
  const elapsedMs = Date.now() - started
  return {
    ok: true, bytes, sha256: hash.digest('hex'), elapsedMs,
    bytesPerSecond: elapsedMs > 0 ? Math.round((bytes / elapsedMs) * 1000) : null,
  }
}

const mbps = (bps) => (Number.isFinite(bps) && bps > 0 ? `${(bps / 1048576).toFixed(2)} MB/s` : '—')

/**
 * 校验一组线路。纯函数式地接 `probe` / `digest` 注入，便于用例喂假网络。
 *
 * 判据（全部要过）：
 *   ① 每条线路可达且返回 206（**Range 必须支持**：设计 §4 要求断点续传——
 *      "断了就得从头再来"在移动网络上是常态性失败）
 *   ② 各线路报告的总长度**一致**（不一致 = 至少有一条不是同一份文件）
 *   ③ 给了清单时，总长度与清单的 `artifacts.installer.sizeBytes` 一致
 *   ④ `--full` 时各行 sha256 两两一致，且与清单的 sha256 一致
 */
export async function verifyMirrors({ lines, expected = null, full = false, sampleBytes = 4 * 1024 * 1024, timeoutMs = 30_000, probe = probeLine, digest = downloadDigest }) {
  const rows = []
  for (const line of lines) {
    const p = await probe(line.url, { sampleBytes, timeoutMs })
    const row = { id: line.id, label: line.label, url: line.url, probe: p, full: null }
    if (full && p.ok) row.full = await digest(line.url, { timeoutMs: timeoutMs * 60 })
    rows.push(row)
  }

  const failures = []
  const reachable = rows.filter((r) => r.probe.ok)
  for (const r of rows) {
    if (!r.probe.ok) failures.push(`${r.id}：不可达（${r.probe.code}：${r.probe.reason}）`)
    else if (r.probe.rangeSupported !== true) failures.push(`${r.id}：不支持 Range（HTTP ${r.probe.status}）——断点续传不可用`)
    else if (r.probe.totalBytes === null) failures.push(`${r.id}：响应里没有可用的总长度（既没有 Content-Range 也没有 Content-Length）`)
  }

  // ② 总长度一致
  const totals = new Set(reachable.map((r) => r.probe.totalBytes).filter((t) => t !== null))
  if (totals.size > 1) {
    failures.push(`各线路报告的总长度不一致：${[...totals].join(' / ')}——至少有一条不是同一份文件`)
  }

  // ③ 与清单一致
  const total = totals.size === 1 ? [...totals][0] : null
  if (expected !== null && Number.isFinite(expected.sizeBytes) && total !== null && total !== expected.sizeBytes) {
    failures.push(`总长度与清单不符：线路报 ${total}，清单说 ${expected.sizeBytes}`)
  }

  // ④ 完整摘要一致
  if (full) {
    const digests = new Set()
    for (const r of rows) {
      if (!r.full?.ok) { failures.push(`${r.id}：完整下载失败（${r.full?.code}：${r.full?.reason}）`); continue }
      digests.add(r.full.sha256)
      if (expected !== null && typeof expected.sha256 === 'string' && expected.sha256 !== '' && r.full.sha256 !== expected.sha256) {
        failures.push(`${r.id}：摘要与清单不符（线路 ${r.full.sha256.slice(0, 12)}… / 清单 ${expected.sha256.slice(0, 12)}…）`)
      }
    }
    if (digests.size > 1) failures.push(`各线路的完整摘要不一致：${[...digests].map((d) => d.slice(0, 12)).join(' / ')}…`)
  }

  return { ok: failures.length === 0, rows, failures, totalBytes: total, full, sampleBytes }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const linesPath = typeof args.get('lines') === 'string' ? args.get('lines') : null
  if (linesPath === null) {
    process.stderr.write('verify-mirrors 需要 --lines <线路表文件>（格式见 product/release/download-lines.example.json）\n')
    process.exit(2)
  }
  const loaded = loadDownloadLines(linesPath)
  if (loaded.problems.length > 0) {
    // 线路表本身不合法时**不猜**：把问题逐条打出来就退出。
    for (const p of loaded.problems) process.stderr.write(`线路表不合格：${p.code}: ${p.message}\n`)
    process.exit(2)
  }
  if (loaded.lines.length === 0) {
    process.stderr.write(`线路表里没有线路：${linesPath}\n`)
    process.exit(2)
  }

  const sampleBytes = num(args.get('sample-bytes'), 4 * 1024 * 1024)
  const timeoutMs = num(args.get('timeout-ms'), 30_000)
  const full = args.get('full') === 'true'

  const manifestSource = typeof args.get('manifest') === 'string' ? args.get('manifest') : null
  let expected = null
  if (manifestSource !== null) {
    const manifest = await readManifest(manifestSource, { timeoutMs })
    const installer = manifest?.artifacts?.installer ?? manifest?.installer ?? null
    if (installer === null) {
      process.stderr.write(`清单里没有 artifacts.installer：${manifestSource}\n`)
      process.exit(2)
    }
    expected = { sizeBytes: installer.sizeBytes, sha256: installer.sha256 }
  }

  process.stdout.write(`多线路校验（${VERIFY_MIRRORS_FORMAT}）：${loaded.lines.length} 条线路`
    + `${expected ? `，对照清单 ${expected.sizeBytes} 字节` : '，未给清单（只做线路之间互比）'}\n`)
  process.stdout.write(`★ 速度是在**本机**量的，不代表其他地区。要判断真实体验请分别在境内/境外各跑一次。\n\n`)

  const r = await verifyMirrors({ lines: loaded.lines, expected, full, sampleBytes, timeoutMs })

  const pad = (s, n) => String(s).padEnd(n, ' ')
  process.stdout.write(`${pad('线路', 14)}${pad('状态', 8)}${pad('总长度', 14)}${pad('Range', 7)}${pad('抽样子节', 11)}${pad('实测', 12)}摘要\n`)
  process.stdout.write('-'.repeat(104) + '\n')
  for (const row of r.rows) {
    const p = row.probe
    const digestCol = r.full
      ? (row.full?.ok ? `${row.full.sha256.slice(0, 12)}…` : '失败')
      : '未验（需 --full）'
    process.stdout.write(
      `${pad(row.id, 14)}${pad(p.ok ? `HTTP ${p.status}` : '不可达', 8)}`
      + `${pad(p.ok ? (p.totalBytes ?? '未知') : '—', 14)}`
      + `${pad(p.ok ? (p.rangeSupported ? '✔' : '✖') : '—', 7)}`
      + `${pad(p.ok ? p.sampleBytes : '—', 11)}`
      + `${pad(p.ok ? mbps(p.bytesPerSecond) : '—', 12)}${digestCol}\n`,
    )
  }
  process.stdout.write('-'.repeat(104) + '\n')
  if (r.ok) {
    process.stdout.write(`✔ 全部通过（${r.rows.length} 条线路${full ? '，且完整摘要一致' : '；**摘要未验**，要验请加 --full'}）\n`)
  } else {
    for (const f of r.failures) process.stdout.write(`✖ ${f}\n`)
  }
  process.exit(r.ok ? 0 : 1)
}
