// scripts/prt/golden-flow.test.mjs — PRT-004 黄金流程定义单测
//
// 本套件的核心断言是**夹具没有漂移**：黄金流程的全部价值建立在「输入固定」上，
// 一旦夹具悄悄变了而哈希没变（或哈希变了没人注意），阶段 3 的新旧对拍就会退化成
// 「两次输入不同却以为两条路径行为不同」。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FIXTURE_FILES,
  FIXTURE_HASH,
  GOLDEN_FLOW_ID,
  GOLDEN_TASK,
  assertFixtureHash,
  checkFixtureHygiene,
  fixtureFileHashes,
  fixtureHash,
  materializeFixture,
} from './golden-flow.mjs'

// ---------------------------------------------------------------- 夹具冻结

test('夹具哈希与冻结值一致（漂移会在这里红）', () => {
  const res = assertFixtureHash()
  assert.equal(res.ok, true, `夹具已漂移：expected ${res.expected}，actual ${res.actual}`)
  assert.equal(FIXTURE_HASH, fixtureHash())
})

test('夹具哈希是稳定的（同一输入重复计算相同）', () => {
  assert.equal(fixtureHash(), fixtureHash())
})

test('夹具哈希对内容敏感：改一个字节即改变摘要', () => {
  const base = fixtureHash()
  const tweaked = fixtureHash({ ...FIXTURE_FILES, 'README.md': FIXTURE_FILES['README.md'] + 'x' })
  assert.notEqual(base, tweaked)
})

test('夹具哈希对路径敏感：内容互换也会改变摘要', () => {
  // 只对内容做有序拼接（不含路径）会漏掉这种情况
  const swapped = fixtureHash({
    ...FIXTURE_FILES,
    'README.md': FIXTURE_FILES['package.json'],
    'package.json': FIXTURE_FILES['README.md'],
  })
  assert.notEqual(fixtureHash(), swapped)
})

test('夹具哈希对文件集合敏感：增删文件即改变摘要', () => {
  const base = fixtureHash()
  assert.notEqual(base, fixtureHash({ ...FIXTURE_FILES, 'extra.txt': 'x\n' }))
  const fewer = { ...FIXTURE_FILES }
  delete fewer['README.md']
  assert.notEqual(base, fixtureHash(fewer))
})

test('每个夹具文件的哈希互不相同（无重复内容）', () => {
  const per = fixtureFileHashes()
  const values = Object.values(per)
  assert.equal(new Set(values).size, values.length)
  assert.equal(values.length, Object.keys(FIXTURE_FILES).length)
  assert.match(fixtureHash(), /^[0-9a-f]{64}$/)
})

test('夹具规范：LF、无制表符、全 ASCII、安全路径', () => {
  assert.deepEqual(checkFixtureHygiene(), [])
})

test('夹具规范检查真的会报错（不是永远返回空数组）', () => {
  const bad = (content) => checkFixtureHygiene({ 'f.txt': content })
  assert.ok(bad('a\r\n').some((p) => /CR/.test(p)), 'CR 未被识别')
  assert.ok(bad('a\tb\n').some((p) => /制表符/.test(p)), '制表符未被识别')
  assert.ok(bad('no newline').some((p) => /LF 结尾/.test(p)), '缺尾换行未被识别')
  assert.ok(bad('中文\n').some((p) => /非 ASCII/.test(p)), '非 ASCII 未被识别')
  assert.ok(checkFixtureHygiene({ '../escape.txt': 'x\n' }).some((p) => /安全/.test(p)), '越界路径未被识别')
  assert.ok(checkFixtureHygiene({ '/abs.txt': 'x\n' }).some((p) => /安全/.test(p)), '绝对路径未被识别')
  // 合规内容零告警，避免误报
  assert.deepEqual(checkFixtureHygiene({ 'ok.txt': 'fine\n' }), [])
})

test('物化夹具写出全部文件，且拒绝不合规夹具', () => {
  const written = []
  const res = materializeFixture((path, content) => written.push([path, content]))
  assert.equal(res.files, Object.keys(FIXTURE_FILES).length)
  assert.equal(written.length, res.files)
  assert.equal(res.hash, FIXTURE_HASH)
  for (const [path, content] of written) {
    assert.equal(content, FIXTURE_FILES[path])
    assert.ok(path.length > 0)
  }
})

// ---------------------------------------------------------------- 流程定义

test('黄金流程满足「单目标 + 至少两岗位交接」', () => {
  assert.equal(GOLDEN_FLOW_ID, 'GF-001')
  assert.ok(GOLDEN_TASK.handoffs.length >= 2, '至少两段交接')
  const roles = new Set(GOLDEN_TASK.handoffs.flatMap((h) => [h.from, h.to]))
  assert.ok(roles.size >= 2, '至少两个岗位')
  for (const h of GOLDEN_TASK.handoffs) {
    assert.ok(h.deliverable.length > 0, '每段交接必须有明确交付物')
  }
})

test('验收契约全部可机器判定（无主观项）', () => {
  const a = GOLDEN_TASK.acceptance
  assert.equal(a.schema.type, 'object')
  assert.deepEqual(
    [...a.schema.required].sort(),
    ['filesChanged', 'readmeUpdated', 'testCommand', 'testPassed'],
  )
  for (const [field, spec] of Object.entries(a.schema.properties)) {
    assert.ok(['string', 'boolean', 'array'].includes(spec.type), `${field} 类型不可机器判定`)
  }
  assert.ok(a.prompt.length > 0)
})

test('预期任务状态序列与 team-hub 迁移表一致', async () => {
  const { extractTransitions } = await import('./baseline-snapshot.mjs')
  const { readFileSync } = await import('node:fs')
  const { dirname, join, resolve } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const server = readFileSync(join(ROOT, 'team-hub', 'server.mjs'), 'utf8')
  const transitions = extractTransitions(server, 'TRANSITIONS')

  const seq = GOLDEN_TASK.expectedTaskStateSequence
  assert.ok(seq.length >= 2, '序列至少要有一跳')
  for (let i = 1; i < seq.length; i += 1) {
    const from = seq[i - 1]
    const to = seq[i]
    assert.ok(
      (transitions[from] ?? []).includes(to),
      `黄金流程预期序列含非法迁移 ${from} -> ${to}（team-hub 只允许 ${(transitions[from] ?? []).join('/')}）`,
    )
  }
})

test('夹具初始状态确实缺少 greet（否则黄金任务无事可做）', () => {
  const cli = FIXTURE_FILES['src/cli.mjs']
  const readme = FIXTURE_FILES['README.md']
  const tests = FIXTURE_FILES['test/cli.test.mjs']
  for (const [name, content] of [['cli.mjs', cli], ['README.md', readme], ['cli.test.mjs', tests]]) {
    assert.doesNotMatch(content, /greet/, `夹具 ${name} 已包含 greet，黄金任务的前提被破坏`)
  }
})

test('夹具已有 --version / help / 未知命令三条分支（任务有真实上下文）', () => {
  const cli = FIXTURE_FILES['src/cli.mjs']
  assert.match(cli, /--version/)
  assert.match(cli, /help/)
  assert.match(cli, /unknown command/)
  assert.match(FIXTURE_FILES['test/cli.test.mjs'], /node:test/)
})
