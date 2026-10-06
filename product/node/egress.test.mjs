// product/node/egress.test.mjs
// 远程 Agent 通道 S-E：出境策略。
//
// 这组用例守的是用户已确认的边界：**只传结构化进展与摘要**。
// 每条断言都对应"如果它不成立，什么东西会离开这台电脑"。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EGRESS_CODES,
  EGRESS_FIELDS,
  EGRESS_LIMITS,
  inspectText,
  projectFailure,
  projectLedger,
  projectProgress,
  projectTerminal,
} from './egress.mjs'

// ── 结构白名单 ──────────────────────────────────────────────────────────────

test('进展只带白名单字段：多出来的键一个都出不去', () => {
  // 模拟"调用方手滑把整个上下文交给了进展"。
  const { value, droppedFields } = projectProgress({
    kind: 'step',
    summary: '正在运行测试',
    // 下面这些**必须**被拦下：
    env: { PATH: '/usr/bin', SECRET: 'x' },
    sourceCode: 'function main() { ... }',
    cwd: 'D:/project/private',
    stack: 'Error: ...\n  at ...',
    rawOutput: 'x'.repeat(5000),
  })
  assert.deepEqual(Object.keys(value).sort(), ['kind', 'summary'])
  assert.ok(droppedFields.includes('env'))
  assert.ok(droppedFields.includes('sourceCode'))
  assert.ok(droppedFields.includes('rawOutput'))
  // 丢字段要**如实记账**：静默丢弃会让"某字段没传出去"与"那个字段本来就是空的"
  // 在对面看起来一样。
  assert.deepEqual(EGRESS_FIELDS.progress, ['kind', 'summary', 'detail'])
})

test('终态只带 outcome/summary/artifacts；产物内容类字段进不来', () => {
  const { value, droppedFields } = projectTerminal({
    outcome: 'completed',
    summary: '已提交',
    artifacts: [{ path: 'src/a.mjs', hash: 'abc', size: 12, content: 'FULL SOURCE', stdout: 'logs' }],
    fullDiff: '...',
  })
  assert.deepEqual(Object.keys(value).sort(), ['artifacts', 'outcome', 'summary'])
  assert.deepEqual(Object.keys(value.artifacts[0]).sort(), ['hash', 'path', 'size'])
  assert.ok(droppedFields.includes('fullDiff'))
})

test('账本只允许身份与状态，摘要与路径进不来（对账不是绕道）', () => {
  const { value } = projectLedger([
    { taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 2, state: 'Running', summary: '我改了 config.mjs', path: 'D:/secret' },
  ])
  assert.deepEqual(Object.keys(value[0]).sort(), ['attemptId', 'leaseEpoch', 'state', 'taskId'])
})

// ── 内容过滤 ────────────────────────────────────────────────────────────────

test('私钥块整段拦下（不做局部替换）', () => {
  const key = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKC...', '-----END RSA PRIVATE KEY-----'].join('\n')
  const r = inspectText(`部署用的东西：\n${key}`, { field: 'summary' })
  // ★ 半段私钥与整段一样不能用，所以不能"只替换密钥那几行然后照发"。
  assert.equal(r.ok, false)
  assert.equal(r.text, '[已拦下：包含私钥块]')
  assert.equal(r.notices[0].code, EGRESS_CODES.REDACTED)
})

test('疑似环境变量转储被拦下，正常的"提到一个变量名"不拦', () => {
  const dump = ['PATH=/usr/bin', 'AWS_SECRET_ACCESS_KEY=abc123', 'HOME=/root', 'TOKEN=xyz', 'SHELL=/bin/bash'].join('\n')
  const r = inspectText(dump, { field: 'summary' })
  assert.equal(r.ok, false)
  assert.equal(r.notices[0].code, EGRESS_CODES.ENV_DUMP)

  // 只提到一两个变量名属于正常叙述。
  const fine = inspectText('环境里 TIMEOUT_MS=30000 看起来不对', { field: 'summary' })
  assert.equal(fine.ok, true)
  assert.ok(fine.text.includes('TIMEOUT_MS'))
})

test('疑似 base64/二进制大块被拦下', () => {
  const r = inspectText(`附件内容 ${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVph'.repeat(10)}`, { field: 'summary' })
  assert.equal(r.ok, false)
  assert.equal(r.notices[0].code, EGRESS_CODES.BLOB)
})

test('长文本按终端日志收敛为头尾，且**保留尾部**（错误通常在末尾）', () => {
  const lines = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行`)
  lines.push('最后一行：构建失败')
  const r = inspectText(lines.join('\n'), { field: 'summary' })
  assert.equal(r.ok, true)
  assert.ok(r.text.includes('第 1 行'), '应保留开头')
  assert.ok(r.text.includes('最后一行：构建失败'), '必须保留尾部——错误通常出现在末尾')
  assert.ok(r.text.includes('省略'))
  assert.equal(r.notices[0].code, EGRESS_CODES.LOG_DUMP)
})

test('超长摘要被截断并留下可读的痕迹', () => {
  const r = inspectText('字'.repeat(EGRESS_LIMITS.summaryChars + 500), { field: 'summary' })
  assert.equal(r.ok, true)
  assert.ok(r.text.length < EGRESS_LIMITS.summaryChars + 100)
  assert.match(r.text, /\[截断，原 \d+ 字符\]/)
  assert.equal(r.notices[0].code, EGRESS_CODES.TRUNCATED)
})

test('命中既有密钥模式表的值被替换（与服务端入库前同一个来源）', () => {
  // `sk-` 形态的 API key。
  const r = inspectText('调用失败，用的 key 是 sk-abcdefghijklmnopqrstuvwxyz012345', { field: 'summary' })
  assert.equal(r.ok, true)
  assert.ok(!r.text.includes('sk-abcdefghijklmnopqrstuvwxyz012345'))
  assert.ok(r.notices.some((n) => n.code === EGRESS_CODES.REDACTED))
})

// ── 投影组合行为 ────────────────────────────────────────────────────────────

test('进展被拦下时仍然发一条可读的说明，而不是丢整帧', () => {
  const { value, notices } = projectProgress({ kind: 'step', summary: '-----BEGIN OPENSSH PRIVATE KEY-----\nx' })
  // 手机应该看到一个"它被拦下了"的进展，而不是一个没有任何进展的运行。
  assert.equal(value.kind, 'step')
  assert.equal(value.summary, '[已拦下：包含私钥块]')
  assert.ok(notices.length > 0)
})

test('产物的 path 保留（它正是"引用"本身），但内容字段被剔除', () => {
  const { value } = projectTerminal({
    outcome: 'completed',
    summary: 'ok',
    artifacts: [{ path: 'reports/out.md', hash: 'sha256:aa', size: 42 }],
  })
  assert.equal(value.artifacts[0].path, 'reports/out.md')
  assert.equal(value.artifacts[0].hash, 'sha256:aa')
})

test('产物条数与路径长度都有界', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.txt` }))
  const { value, notices } = projectTerminal({ outcome: 'completed', summary: 'ok', artifacts: many })
  assert.equal(value.artifacts.length, EGRESS_LIMITS.artifacts)
  assert.ok(notices.some((n) => n.code === EGRESS_CODES.TRUNCATED))

  const longPath = projectTerminal({ outcome: 'completed', summary: 'ok', artifacts: [{ path: 'a'.repeat(1000) }] })
  assert.ok(longPath.value.artifacts[0].path.length <= EGRESS_LIMITS.artifactPathChars + 40)
})

test('失败帧只带 failureCode 与限长的 detail', () => {
  const { value, droppedFields } = projectFailure({
    failureCode: 'tool-crash',
    detail: 'x'.repeat(2000),
    stack: 'Error: ...',
    env: { TOKEN: 'x' },
  })
  assert.deepEqual(Object.keys(value).sort(), ['detail', 'failureCode'])
  assert.ok(value.detail.length <= EGRESS_LIMITS.detailChars + 40)
  assert.ok(droppedFields.includes('stack'))
  assert.ok(droppedFields.includes('env'))
})

test('账本投影丢弃缺身份的行，并给条数上限', () => {
  const { value, notices } = projectLedger([
    { taskId: 'T-1', attemptId: 'att-1', leaseEpoch: 1, state: 'Running' },
    { taskId: 'T-2', state: 'Running' },                       // 缺 attemptId
    ...Array.from({ length: 600 }, (_, i) => ({ taskId: `T-${i}`, attemptId: `att-${i}`, leaseEpoch: 1, state: 'Running' })),
  ])
  assert.equal(value.length, 500)
  assert.ok(notices.some((n) => n.code === EGRESS_CODES.TRUNCATED))
  assert.ok(value.every((e) => typeof e.attemptId === 'string'))
})
