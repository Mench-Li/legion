#!/usr/bin/env node
// scripts/prt/dsh-session-usage.mjs
// ============================================================================
// 真实执行证据提取器：从 DSH 会话转录里读出**模型实际用量**与墙钟耗时（PRT-009）
//
// ## 为什么需要它：旧路径根本没有这个数据
//
// PRT-009 的 `token-usage` / `estimated-cost` / `end-to-end-latency` 三项长期空白，
// 台账里写的阻塞原因是「需要一次真实模型执行」。2026-09-11 黄金流程 GF-001
// 真实跑完之后，执行本身**已经产生**了这些数据——只是不在 team-hub 的库里，
// 而在 DSH 自己落盘的会话转录中（每轮 assistant 消息都带 provider 上报的 usage）。
//
// 所以本次采集不是「再跑一次」，而是**把已经发生的真实执行读出来**：
// 数值来自 provider 上报的 usage 字段，不是估算，也不是自述。
//
// ## 坑一：`.jsonl.zstd` 是**多帧拼接**，不是单个 zstd 流
//
// 每个追加批次写一个独立 zstd 帧。`zstdDecompressSync(整个文件)` 只解出**第一帧**——
// 对本仓库的会话文件，第一帧恰好只有一行 `{"type":"session",...}` 头部（294 字节）。
// 于是工具会「成功」返回 0 条 usage，看起来像「这个会话没花 token」。
// 这种失败不报错、只给 0，是最难发现的一类。因此下面按**帧魔数**逐帧拆开再解。
//
// ## 坑二：`totalTokens` 不是「输入 + 输出」
//
// 实测 81 条 usage 记录全部满足：`totalTokens = inputTokens + outputTokens + cacheReadTokens`。
// 也就是说 `inputTokens` **不含**缓存命中的输入；把 total 当作 input+output 会低估约一个量级
// （GF-001 三轮合计：input 68822 / output 50122，而 total 1682208，其中 1563264 是缓存读）。
// 本工具三个分量分别报，并**校验**该恒等式；不成立时记 `mismatch` 而不是静默相加。
//
// ## 只报事实，不做推断
//
// 不换算费用（单价未定，见 baseline-measure.mjs 的 PRICING）、不推断「模型够不够用」。
// 会话里记着什么就报什么；没记着的（如进程峰值内存）**不在这里编**。
//
// 用法：
//   node scripts/prt/dsh-session-usage.mjs --cwd-prefix=D:/project/DSH/gf001-scratch
//   node scripts/prt/dsh-session-usage.mjs --json --out=usage.json
//   node scripts/prt/dsh-session-usage.mjs --help
// ============================================================================
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数（RFC 8878）：每帧都以它开头，因此可用来切分拼接流。 */
export const ZSTD_FRAME_MAGIC = Object.freeze([0x28, 0xb5, 0x2f, 0xfd])

/** 会话转录文件名（实测 DSH `session.v3` 布局）。 */
export const SESSION_FILE = 'session.v3.jsonl.zstd'

/** 默认会话根目录。 */
export function defaultSessionsRoot(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  return join(home, 'sessions')
}

/**
 * 切出所有 zstd 帧的起始偏移。
 *
 * 不解析帧头长度字段：只需**起点**，因为从任一帧起点调用 decompress 就只能得到该帧内容。
 * 魔数在压缩数据里也可能偶然出现，被误切的帧解压会抛错 → 由 `decodeSessionBuffer`
 * 记成坏帧而不是当成数据。宁可少读一帧，也不把垃圾当用量。
 */
export function findFrameOffsets(buf) {
  const [a, b, c, d] = ZSTD_FRAME_MAGIC
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === a && buf[i + 1] === b && buf[i + 2] === c && buf[i + 3] === d) offsets.push(i)
  }
  return offsets
}

/**
 * 解出会话转录的全部记录。
 *
 * @returns {{records: object[], frames: number, badFrames: number, undecodableLines: number}}
 */
export function decodeSessionBuffer(buf) {
  const offsets = findFrameOffsets(buf)
  // 没有魔数：可能是未压缩的 JSONL（测试与未来格式都用得上），按文本直接读。
  const chunks = offsets.length === 0 ? [buf.toString('utf8')] : []
  let badFrames = 0
  for (const off of offsets) {
    try {
      chunks.push(zstdDecompressSync(buf.subarray(off)).toString('utf8'))
    } catch {
      badFrames += 1
    }
  }

  const records = []
  let undecodableLines = 0
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (line === '') continue
      try {
        const v = JSON.parse(line)
        if (v !== null && typeof v === 'object') records.push(v)
      } catch {
        undecodableLines += 1
      }
    }
  }
  return { records, frames: offsets.length, badFrames, undecodableLines }
}

/** 读并解一个转录文件。 */
export function decodeSessionFile(file) {
  return decodeSessionBuffer(readFileSync(file))
}

/**
 * 列出会话根目录下的全部转录文件。
 *
 * 布局：`<root>/<cwd-dir-name>/<sessionId>/session.v3.jsonl.zstd`（实测）。
 * 容错：缺失的目录返回空列表而不是抛错——「本机没有会话」与「工具坏了」是两回事。
 */
export function listSessionFiles(sessionsRoot) {
  if (!existsSync(sessionsRoot)) return []
  const out = []
  for (const cwdDir of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!cwdDir.isDirectory()) continue
    const cwdPath = join(sessionsRoot, cwdDir.name)
    for (const sessionDir of readdirSync(cwdPath, { withFileTypes: true })) {
      if (!sessionDir.isDirectory()) continue
      const file = join(cwdPath, sessionDir.name, SESSION_FILE)
      if (existsSync(file)) out.push({ file, sessionDir: sessionDir.name, cwdDir: cwdDir.name })
    }
  }
  return out
}

/**
 * 路径比较用的规范化：分隔符统一为 `/`、去掉尾部 `/`、Windows 下大小写不敏感。
 *
 * 为什么不能直接 `startsWith`：转录里记的是 `D:\project\...\T-144`，
 * 调用方传进来的可能是 `D:/project/...`；字面比较会静默选不中任何会话。
 */
export function normalizePath(p) {
  const s = String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/** 该会话的 cwd 是否落在给定前缀下（含前缀自身）。 */
export function cwdUnder(cwd, prefix) {
  const c = normalizePath(cwd)
  const p = normalizePath(prefix)
  if (p === '') return true
  return c === p || c.startsWith(`${p}/`)
}

/**
 * 汇总一个会话的用量与耗时。
 *
 * 只读叶子字段，不序列化记录对象本身。
 */
export function summarizeSession(records) {
  const header = records.find((r) => r.type === 'session') ?? {}
  const usageBearing = records.filter(
    (r) => r.type === 'assistant/message' && r.data !== null && typeof r.data === 'object' && r.data.usage,
  )

  const tokens = { input: 0, output: 0, cacheRead: 0, reportedTotal: 0 }
  let accountedTotal = 0
  let usageMismatch = 0
  for (const r of usageBearing) {
    const u = r.data.usage
    const input = num(u.inputTokens)
    const output = num(u.outputTokens)
    const cacheRead = num(u.cacheReadTokens)
    tokens.input += input
    tokens.output += output
    tokens.cacheRead += cacheRead
    tokens.reportedTotal += num(u.totalTokens)
    accountedTotal += input + output + cacheRead
    // 恒等式不成立只记账，不纠正：纠正会把「上游改了口径」这件事藏起来。
    if (num(u.totalTokens) !== input + output + cacheRead) usageMismatch += 1
  }

  const times = records.map((r) => r.time).filter((t) => typeof t === 'number' && Number.isFinite(t))
  const startedAt = times.length > 0 ? Math.min(...times) : null
  const endedAt = times.length > 0 ? Math.max(...times) : null

  const modelSet = new Set()
  for (const r of records) {
    const m = r?.data?.message?.source?.model ?? r?.data?.source?.model ?? r?.data?.model
    if (typeof m === 'string' && m !== '') modelSet.add(m)
  }

  const sandbox = records.find((r) => r.type === 'sandbox/mode')
  const approval = records.find((r) => r.type === 'approval/policy')
  const descriptor = records.find((r) => r.type === 'subagent/descriptor')
  const context = records.find((r) => r.type === 'request/context')

  return {
    sessionId: header.id ?? null,
    cwd: header.cwd ?? null,
    parentSession: header.parentSession ?? null,
    origin: header.origin ?? null,
    delegationDepth: header.delegationDepth ?? null,
    agentPreset: header.agentPreset ?? null,
    label: descriptor?.data?.label ?? null,
    createdAt: isoOrNull(header.createdAt),
    startedAt: isoOrNull(startedAt),
    endedAt: isoOrNull(endedAt),
    durationMs: startedAt !== null && endedAt !== null ? endedAt - startedAt : null,
    provider: context?.data?.provider ?? null,
    contextWindow: context?.data?.contextWindow ?? null,
    models: [...modelSet].sort(),
    sandboxMode: sandbox?.data?.mode ?? null,
    approvalPolicy: approval?.data?.policy ?? null,
    counts: {
      steps: records.filter((r) => r.type === 'step/start').length,
      assistantMessages: records.filter((r) => r.type === 'assistant/message').length,
      toolCalls: records.filter((r) => r.type === 'tool/call').length,
      usageBearing: usageBearing.length,
    },
    tokens: {
      ...tokens,
      // 自算的合计：即便上游 totalTokens 口径变了，这个值仍是三个分量之和，可对账。
      accountedTotal,
      mismatchRecords: usageMismatch,
    },
  }
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function isoOrNull(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/**
 * 采集：把 `cwd` 落在 `cwdPrefix` 下的会话全部汇总，并给出合计。
 *
 * 为什么按**转录里的 cwd** 而不是按目录名匹配：目录名是从 cwd 折叠出来的，
 * 折叠是有损的（空格、`:`、`\` 都变成 `-`），两个不同 cwd 可能折成同一个名字。
 * 转录里记着逐字的 cwd，用它判定归属不会有歧义。
 */
export function collectUsage({ sessionsRoot = defaultSessionsRoot(), cwdPrefix = '', requireUsage = true } = {}) {
  const files = listSessionFiles(sessionsRoot)
  const sessions = []
  const skipped = []

  for (const entry of files) {
    const decoded = decodeSessionFile(entry.file)
    const summary = summarizeSession(decoded.records)
    // 头部都没有的目录不是会话（例如守护 foreman 的空壳），明确跳过并留痕。
    if (summary.sessionId === null) {
      skipped.push({ dir: entry.cwdDir, sessionDir: entry.sessionDir, why: 'no session header' })
      continue
    }
    if (!cwdUnder(summary.cwd, cwdPrefix)) continue
    // 守护 foreman 自己不做模型调用（0 条 usage），默认排除以免污染合计；
    // 但它仍可被 `requireUsage: false` 带回来对照（它的存在说明「谁派的工」）。
    if (requireUsage && summary.counts.usageBearing === 0) continue
    sessions.push({ ...summary, frames: decoded.frames, badFrames: decoded.badFrames })
  }

  sessions.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))

  const totals = sessions.reduce(
    (acc, s) => {
      acc.input += s.tokens.input
      acc.output += s.tokens.output
      acc.cacheRead += s.tokens.cacheRead
      acc.reportedTotal += s.tokens.reportedTotal
      acc.accountedTotal += s.tokens.accountedTotal
      acc.usageBearing += s.counts.usageBearing
      acc.durationMs += s.durationMs ?? 0
      acc.mismatchRecords += s.tokens.mismatchRecords
      return acc
    },
    { input: 0, output: 0, cacheRead: 0, reportedTotal: 0, accountedTotal: 0, usageBearing: 0, durationMs: 0, mismatchRecords: 0 },
  )

  return {
    sessionsRoot,
    cwdPrefix,
    requireUsage,
    scannedFiles: files.length,
    sessions,
    skipped,
    totals,
  }
}

// ------------------------------------------------------------------ CLI

function usage() {
  console.log('dsh-session-usage.mjs — 从 DSH 会话转录提取真实模型用量与耗时（PRT-009）')
  console.log('')
  console.log('  --sessions-root=<dir>   会话根目录（默认 $DSH_HOME/sessions）')
  console.log('  --cwd-prefix=<path>     只看 cwd 在该路径下的会话（如黄金流程的 scratch 仓库）')
  console.log('  --all                   连 0 用量的守护会话一并列出')
  console.log('  --json                  机器可读输出')
  console.log('  --out=<path>            同时写入文件')
  console.log('  --help                  本说明')
  console.log('')
  console.log('数值来自 provider 上报的 usage；不换算费用、不推断缺失项。')
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) return usage()
  const arg = (name, fallback) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback

  const out = collectUsage({
    sessionsRoot: arg('sessions-root', defaultSessionsRoot()),
    cwdPrefix: arg('cwd-prefix', ''),
    requireUsage: !argv.includes('--all'),
  })

  const text = JSON.stringify(out, null, 2)
  if (argv.includes('--json') || argv.includes('--out=')) {
    console.log(text)
  } else {
    console.log(`会话根：${out.sessionsRoot}`)
    console.log(`扫描 ${out.scannedFiles} 个转录，命中 ${out.sessions.length} 个会话（cwd 前缀：${out.cwdPrefix || '(全部)'}）`)
    console.log('')
    for (const s of out.sessions) {
      const t = s.tokens
      console.log(`  ${s.cwd}  [${s.models.join(',') || '模型未记录'}]`)
      console.log(`    ${s.sessionId}  ${s.startedAt} → ${s.endedAt}  ${((s.durationMs ?? 0) / 1000).toFixed(1)}s  ${s.counts.assistantMessages} 条 assistant`)
      console.log(`    tokens: input ${t.input} / output ${t.output} / cacheRead ${t.cacheRead} / total ${t.reportedTotal}`)
    }
    console.log('')
    const tt = out.totals
    console.log(`合计：input ${tt.input} / output ${tt.output} / cacheRead ${tt.cacheRead} / total ${tt.reportedTotal}（自算 ${tt.accountedTotal}）`)
    console.log(`      ${tt.usageBearing} 条带用量的 assistant 消息，口径不符 ${tt.mismatchRecords} 条`)
    if (out.skipped.length > 0) console.log(`跳过 ${out.skipped.length} 个非会话目录`)
  }

  const outPath = arg('out', null)
  if (outPath) {
    writeFileSync(outPath, `${text}\n`, 'utf8')
    console.log(`已写入 ${outPath}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
