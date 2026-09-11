// scripts/prt/dsh-session-usage.test.mjs — 会话用量提取器单测
//
// 这套用例的重心不是「函数能跑」，而是**两个不会报错的错误**：
//
//   ① `.jsonl.zstd` 是多帧拼接。`zstdDecompressSync(整个文件)` 只解第一帧，
//      而第一帧恰好只有一行会话头 → 工具会「成功」报出 0 token。
//      这条用**真实的多帧缓冲区**钉死，而不是靠注释提醒。
//
//   ② `totalTokens = input + output + cacheRead`（input 不含缓存读）。
//      把它当 input+output 会低估约一个量级；且上游口径若变了必须**记账**，
//      不能静默相加。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

import {
  ZSTD_FRAME_MAGIC,
  collectUsage,
  cwdUnder,
  decodeSessionBuffer,
  findFrameOffsets,
  listSessionFiles,
  normalizePath,
  SESSION_FILE,
  summarizeSession,
} from './dsh-session-usage.mjs'

// ---------------------------------------------------------------- 夹具构造

const HEADER = {
  type: 'session',
  version: 3,
  id: 'sess-1',
  createdAt: 1_700_000_000_000,
  cwd: 'D:\\project\\DSH\\gf001-scratch\\.legion-worktrees\\T-144',
  parentSession: 'scrum-worker-foreman-1',
  origin: 'subagent',
  delegationDepth: 1,
  agentPreset: 'ptc',
}

function usageMsg(seq, time, u) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: { turn: 1, step: seq, message: { role: 'assistant', source: { model: 'deepseek-v4-flash-openai' } }, usage: u },
  }
}

/** 把记录按「每次追加一帧」的真实形态拼接（这是本仓库会话文件的实测形态）。 */
function frames(...lines) {
  return Buffer.concat(lines.map((l) => zstdCompressSync(Buffer.from(`${l}\n`))))
}

function tempSessionsRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-usage-'))
}

// ---------------------------------------------------------------- ① 多帧解码

test('findFrameOffsets：按魔数切出**每一**帧，不是只认第一帧', () => {
  const buf = frames('{"a":1}', '{"a":2}', '{"a":3}')
  const offsets = findFrameOffsets(buf)
  assert.equal(offsets.length, 3)
  assert.deepEqual(offsets.map((o) => buf.subarray(o, o + 4)), [0, 1, 2].map(() => Buffer.from(ZSTD_FRAME_MAGIC)))
})

test('decodeSessionBuffer：多帧拼接必须解出**全部**帧（回归：单次解压只能拿到第一帧）', () => {
  const buf = frames(
    JSON.stringify(HEADER),
    JSON.stringify(usageMsg(1, 1000, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, totalTokens: 115 })),
    JSON.stringify(usageMsg(2, 2000, { inputTokens: 20, outputTokens: 7, cacheReadTokens: 200, totalTokens: 227 })),
  )

  // 先证明「坑」真实存在：整段一次性解压只得到第一帧，也就是只有会话头。
  const naive = zstdDecompressSync(buf).toString('utf8').split('\n').filter(Boolean)
  assert.equal(naive.length, 1, '单次解压只能得到第一帧——这正是必须逐帧解的原因')

  const { records, frames: frameCount, badFrames } = decodeSessionBuffer(buf)
  assert.equal(frameCount, 3)
  assert.equal(badFrames, 0)
  assert.equal(records.length, 3, '三个记录都要读到')
  assert.equal(records[1].data.usage.inputTokens, 10)
})

test('decodeSessionBuffer：无魔数时按未压缩 JSONL 读（格式演进不至于把工具打瞎）', () => {
  const buf = Buffer.from(`${JSON.stringify(HEADER)}\n${JSON.stringify(usageMsg(1, 1, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, totalTokens: 2 }))}\n`)
  const { records, frames: frameCount } = decodeSessionBuffer(buf)
  assert.equal(frameCount, 0)
  assert.equal(records.length, 2)
})

test('decodeSessionBuffer：坏帧不抛异常，记数后继续（宁可少读也不要崩）', () => {
  const good = zstdCompressSync(Buffer.from('{"type":"session","id":"s"}\n'))
  // 伪造一段「有魔数但解不开」的字节
  const bogus = Buffer.concat([Buffer.from(ZSTD_FRAME_MAGIC), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])])
  const { records, badFrames, undecodableLines } = decodeSessionBuffer(Buffer.concat([good, bogus]))
  assert.equal(badFrames, 1)
  assert.equal(records.length, 1)
  assert.equal(undecodableLines, 0)
})

// ---------------------------------------------------------------- ② 口径

test('summarizeSession：totalTokens 口径 = input + output + cacheRead（缓存读不得漏计）', () => {
  const { records } = decodeSessionBuffer(frames(
    JSON.stringify(HEADER),
    JSON.stringify(usageMsg(1, 1000, { inputTokens: 2598, outputTokens: 220, cacheReadTokens: 8192, totalTokens: 11010 })),
  ))
  const s = summarizeSession(records)
  assert.deepEqual(s.tokens, {
    input: 2598, output: 220, cacheRead: 8192, reportedTotal: 11010, accountedTotal: 11010, mismatchRecords: 0,
  })
})

test('summarizeSession：口径不符要记账，不得静默纠正', () => {
  const { records } = decodeSessionBuffer(frames(
    JSON.stringify(HEADER),
    // 上游把 total 写成 input+output（漏掉缓存读）——必须被认出来
    JSON.stringify(usageMsg(1, 1000, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, totalTokens: 150 })),
  ))
  const s = summarizeSession(records)
  assert.equal(s.tokens.mismatchRecords, 1)
  assert.equal(s.tokens.reportedTotal, 150, '报出上游给的值')
  assert.equal(s.tokens.accountedTotal, 1050, '同时给出自算值，便于对账')
})

test('summarizeSession：没有 usage 的消息不参与合计', () => {
  const { records } = decodeSessionBuffer(frames(
    JSON.stringify(HEADER),
    JSON.stringify({ type: 'system/message', seq: 1, time: 500, data: {} }),
    JSON.stringify(usageMsg(2, 1000, { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, totalTokens: 10 })),
  ))
  const s = summarizeSession(records)
  assert.equal(s.counts.assistantMessages, 1)
  assert.equal(s.counts.usageBearing, 1)
  assert.equal(s.tokens.reportedTotal, 10)
})

test('summarizeSession：耗时取首末记录时间；模型/沙箱/审批等事实逐字带出', () => {
  const { records } = decodeSessionBuffer(frames(
    JSON.stringify(HEADER),
    JSON.stringify({ type: 'sandbox/mode', seq: 0, time: 900, data: { mode: 'workspace-write', source: 'delegation' } }),
    JSON.stringify({ type: 'approval/policy', seq: 1, time: 950, data: { policy: 'never', source: 'delegation' } }),
    JSON.stringify({ type: 'request/context', seq: 2, time: 960, data: { provider: 'custom-ds', model: 'deepseek-v4-flash-openai', contextWindow: 262144 } }),
    JSON.stringify(usageMsg(3, 4000, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, totalTokens: 2 })),
  ))
  const s = summarizeSession(records)
  assert.equal(s.sessionId, 'sess-1')
  assert.equal(s.startedAt, new Date(900).toISOString())
  assert.equal(s.endedAt, new Date(4000).toISOString())
  assert.equal(s.durationMs, 3100)
  assert.equal(s.sandboxMode, 'workspace-write')
  assert.equal(s.approvalPolicy, 'never')
  assert.equal(s.provider, 'custom-ds')
  assert.equal(s.contextWindow, 262144)
  assert.deepEqual(s.models, ['deepseek-v4-flash-openai'])
})

// ---------------------------------------------------------------- ③ 归属判定

test('cwdUnder：分隔符与大小写差异不得让会话选不中', () => {
  const sessionsCwd = 'D:\\project\\DSH\\gf001-scratch\\.legion-worktrees\\T-144'
  assert.equal(cwdUnder(sessionsCwd, 'D:/project/DSH/gf001-scratch'), true, '斜杠方向不同仍应命中')
  assert.equal(cwdUnder(sessionsCwd, 'd:/PROJECT/dsh/GF001-SCRATCH'), true, 'Windows 下大小写不敏感')
  assert.equal(cwdUnder(sessionsCwd, 'D:/project/DSH/gf001-scratch/.legion-worktrees/T-144'), true, '等于前缀自身')
  assert.equal(cwdUnder(sessionsCwd, 'D:/project/DSH/legion'), false, '前缀不同必须不命中')
  // 前缀是另一个仓库名的**前缀**时不能误判（gf001-scratch vs gf001-scratch-2）
  assert.equal(cwdUnder('D:/project/DSH/gf001-scratch-2/x', 'D:/project/DSH/gf001-scratch'), false)
})

test('normalizePath：去掉尾部斜杠，统一分隔符', () => {
  assert.equal(normalizePath('D:\\a\\b\\'), normalizePath('D:/a/b'))
})

// ---------------------------------------------------------------- ④ 采集

function writeSession(root, cwdDir, sessionDir, buf) {
  const dir = join(root, cwdDir, sessionDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, SESSION_FILE), buf)
}

test('collectUsage：按转录里的 cwd 过滤，并按需排除 0 用量的守护会话', () => {
  const root = tempSessionsRoot()
  try {
    const target = frames(
      JSON.stringify(HEADER),
      JSON.stringify(usageMsg(1, 1000, { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, totalTokens: 11 })),
    )
    writeSession(root, '--D-project-DSH-gf001-scratch-.legion-worktrees-T-144--', 'sess-1', target)
    // 同前缀下另一次（失败的）执行：前缀命中但调用方可以按 cwd 再筛
    writeSession(root, '--D-project-DSH-gf001-scratch-.legion-worktrees-T-138--', 'sess-2', frames(
      JSON.stringify({ ...HEADER, id: 'sess-2', cwd: 'D:\\project\\DSH\\gf001-scratch\\.legion-worktrees\\T-138' }),
      JSON.stringify(usageMsg(1, 1000, { inputTokens: 99, outputTokens: 9, cacheReadTokens: 0, totalTokens: 108 })),
    ))
    // 别的仓库：不得被前缀命中
    writeSession(root, '--D-project-DSH-legion--', 'sess-3', frames(
      JSON.stringify({ ...HEADER, id: 'sess-3', cwd: 'D:\\project\\DSH\\legion' }),
      JSON.stringify(usageMsg(1, 1000, { inputTokens: 500, outputTokens: 500, cacheReadTokens: 0, totalTokens: 1000 })),
    ))
    // 守护空壳：有会话头但没有模型调用
    writeSession(root, '--D-project-DSH-gf001-scratch-.legion-worktrees-T-145--', 'scrum-worker-foreman-9', frames(
      JSON.stringify({ ...HEADER, id: 'foreman-9', cwd: 'D:\\project\\DSH\\gf001-scratch\\.legion-worktrees\\T-145' }),
    ))

    const out = collectUsage({ sessionsRoot: root, cwdPrefix: 'D:/project/DSH/gf001-scratch' })
    assert.equal(out.scannedFiles, 4)
    assert.deepEqual(out.sessions.map((s) => s.sessionId).sort(), ['sess-1', 'sess-2'], '守护空壳默认排除；别的仓库不命中')
    assert.equal(out.totals.reportedTotal, 119)

    const withForeman = collectUsage({ sessionsRoot: root, cwdPrefix: 'D:/project/DSH/gf001-scratch', requireUsage: false })
    assert.equal(withForeman.sessions.length, 3, '--all 时把 0 用量的守护会话带回来对照')

    // 调用方按 cwd 精筛出「成功的那一轮」
    const successOnly = out.sessions.filter((s) => s.cwd.endsWith('T-144'))
    assert.equal(successOnly.length, 1)
    assert.equal(successOnly[0].tokens.reportedTotal, 11)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collectUsage：会话根不存在时返回空集，不抛错', () => {
  const out = collectUsage({ sessionsRoot: join(tmpdir(), 'dsh-usage-definitely-missing'), cwdPrefix: '' })
  assert.deepEqual(out.sessions, [])
  assert.equal(out.scannedFiles, 0)
})

test('collectUsage：没有会话头的目录进 skipped，留痕而不是静默丢弃', () => {
  const root = tempSessionsRoot()
  try {
    writeSession(root, '--x--', 'broken', frames('{"type":"step/start"}'))
    const out = collectUsage({ sessionsRoot: root, cwdPrefix: '' })
    assert.equal(out.sessions.length, 0)
    assert.equal(out.skipped.length, 1)
    assert.equal(out.skipped[0].why, 'no session header')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listSessionFiles：只认 session.v3.jsonl.zstd，别的文件不算会话', () => {
  const root = tempSessionsRoot()
  try {
    writeSession(root, '--a--', 'sess-x', frames(JSON.stringify(HEADER)))
    writeFileSync(join(root, '--a--', 'sess-x', 'other.jsonl'), 'x')
    writeFileSync(join(root, '--a--', 'loose.txt'), 'x')
    const files = listSessionFiles(root)
    assert.equal(files.length, 1)
    assert.equal(files[0].sessionDir, 'sess-x')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
