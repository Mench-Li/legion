// scrum/taskctl.ttl.test.mjs — P2(任务 TTL/幂等认领/转派) + P4(inbox) 契约测试。
// 运行：node --test scrum/taskctl.ttl.test.mjs
// 通过 LEGION_TASKS_FILE 指向临时库，以子进程调用 taskctl.mjs（测真实 CLI 契约）。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const TASKCTL = join(dirname(fileURLToPath(import.meta.url)), 'taskctl.mjs')
let tmp
let env

function ctl(argv) {
  const r = spawnSync(process.execPath, [TASKCTL, ...argv], { env, encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`taskctl ${argv.join(' ')} 失败：${r.stderr.trim()}`)
  }
  return JSON.parse(r.stdout)
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'legion-taskctl-'))
  env = { ...process.env, LEGION_TASKS_FILE: join(tmp, 'tasks.json') }
  ctl(['init'])
})

after(() => rmSync(tmp, { recursive: true, force: true }))

describe('TTL + 幂等认领 (P2)', () => {
  it('create --ttl-minutes 记录 ttlMinutes', () => {
    const t = ctl(['create', '--title', '任务A', '--ttl-minutes', '15'])
    assert.equal(t.ttlMinutes, 15)
    assert.equal(t.expiresAt, null)
  })

  it('claim 设置 expiresAt = claimedAt + ttl', () => {
    const t = ctl(['create', '--title', '任务B', '--ttl-minutes', '10'])
    ctl(['approve', t.id])
    const claimed = ctl(['claim', t.id, '--soldier', 'coder'])
    assert.equal(claimed.status, 'in_progress')
    assert.equal(claimed.ttlMinutes, 10)
    assert.ok(claimed.expiresAt !== null)
    const diffMs = new Date(claimed.expiresAt).getTime() - new Date(claimed.claimedAt).getTime()
    assert.equal(diffMs, 10 * 60_000)
  })

  it('claim --ttl-minutes 覆盖任务默认 TTL', () => {
    const t = ctl(['create', '--title', '任务C', '--ttl-minutes', '60'])
    ctl(['approve', t.id])
    const claimed = ctl(['claim', t.id, '--soldier', 'coder', '--ttl-minutes', '5'])
    assert.equal(claimed.ttlMinutes, 5)
  })

  it('幂等：同 request-id + 同士兵重复认领 → 返回当前任务，version 不递增', () => {
    const t = ctl(['create', '--title', '任务D'])
    ctl(['approve', t.id])
    const a = ctl(['claim', t.id, '--soldier', 'coder', '--request-id', 'req-1'])
    const b = ctl(['claim', t.id, '--soldier', 'coder', '--request-id', 'req-1'])
    assert.equal(a.version, b.version) // 幂等命中不 bump
    assert.equal(b.status, 'in_progress')
  })

  it('幂等不误伤：不同 request-id 认领已认领任务 → 拒绝', () => {
    const t = ctl(['create', '--title', '任务E'])
    ctl(['approve', t.id])
    ctl(['claim', t.id, '--soldier', 'coder', '--request-id', 'req-a'])
    assert.throws(() => ctl(['claim', t.id, '--soldier', 'coder', '--request-id', 'req-b']), /无法认领/)
  })

  it('release-stale 认 expiresAt：过期未完成 → 释放回 todo', () => {
    const t = ctl(['create', '--title', '任务F', '--ttl-minutes', '10'])
    ctl(['approve', t.id])
    ctl(['claim', t.id, '--soldier', 'coder'])
    // 直接篡改 expiresAt 到过去（claimedAt 保持近期），只触发 TTL 路径而非年龄路径
    const file = env.LEGION_TASKS_FILE
    const db = JSON.parse(readFileSync(file, 'utf8'))
    db.tasks[t.id].expiresAt = new Date(Date.now() - 1 * 60_000).toISOString()
    writeFileSync(file, JSON.stringify(db, null, 2))
    const res = ctl(['release-stale', '--older-than', '60'])
    assert.ok(res.released.includes(t.id))
    const after = ctl(['get', t.id])
    assert.equal(after.status, 'todo')
    assert.equal(after.soldier, null)
    assert.equal(after.expiresAt, null)
  })
})

describe('转派 (P2)', () => {
  it('reassign 换士兵 + 记录转派评论', () => {
    const t = ctl(['create', '--title', '任务G'])
    ctl(['approve', t.id])
    ctl(['claim', t.id, '--soldier', 'coder'])
    const r = ctl(['reassign', t.id, '--soldier', 'tester', '--by', 'general'])
    assert.equal(r.soldier, 'tester')
    assert.equal(r.status, 'in_progress')
    assert.ok(r.comments.some(c => c.text.includes('转派') && c.text.includes('coder') && c.text.includes('tester')))
  })

  it('reassign 到 done 任务 → 拒绝', () => {
    const t = ctl(['create', '--title', '任务H'])
    ctl(['approve', t.id])
    ctl(['claim', t.id, '--soldier', 'coder'])
    ctl(['transition', t.id, '--to', 'in_review', '--by', 'coder'])
    ctl(['transition', t.id, '--to', 'done', '--by', 'general'])
    assert.throws(() => ctl(['reassign', t.id, '--soldier', 'tester']), /不可转派/)
  })
})

describe('inbox 计数 (P4)', () => {
  it('inbox --role 统计待认领 todo/blocked', () => {
    const a = ctl(['create', '--title', '待办1', '--role', 'coder', '--status', 'todo'])
    const b = ctl(['create', '--title', '待办2', '--role', 'coder', '--status', 'todo'])
    ctl(['create', '--title', '别角色', '--role', 'tester', '--status', 'todo'])
    ctl(['claim', a.id, '--soldier', 'coder']) // 认领后不再算 inbox
    const inbox = ctl(['inbox', '--role', 'coder'])
    assert.equal(inbox.count, 1)
    assert.deepEqual(inbox.tasks.map(t => t.id), [b.id])
  })

  it('inbox --soldier 按角色名等价过滤', () => {
    const inbox = ctl(['inbox', '--soldier', 'tester'])
    assert.equal(inbox.count, 1)
  })
})

describe('progress 进度心跳 (P3)', () => {
  it('progress 追加且不 bump version（遥测）', () => {
    const t = ctl(['create', '--title', '进度任务'])
    assert.deepEqual(t.progress, [])
    const before = t.version
    const p1 = ctl(['progress', t.id, '--by', 'coder', '--percent', '40', '--note', '实现中'])
    assert.equal(p1.version, before) // 不 bump
    assert.equal(p1.progress.length, 1)
    assert.equal(p1.progress[0].percent, 40)
    assert.equal(p1.progress[0].note, '实现中')
    // 第二次追加
    const p2 = ctl(['progress', t.id, '--by', 'coder', '--percent', '100', '--note', '完成'])
    assert.equal(p2.progress.length, 2)
    assert.equal(p2.version, before) // 仍不 bump
    assert.equal(p2.progress[1].percent, 100)
  })

  it('percent 越界/非整数拒绝', () => {
    const t = ctl(['create', '--title', '越界'])
    assert.throws(() => ctl(['progress', t.id, '--by', 'c', '--percent', '101']), /0-100/)
    assert.throws(() => ctl(['progress', t.id, '--by', 'c', '--percent', '-1']), /0-100/)
    assert.throws(() => ctl(['progress', t.id, '--by', 'c', '--percent', 'x']), /0-100/)
  })
})

describe('artifact 产物登记 (worktable-②)', () => {
  it('artifact 追加并校验 kind/path', () => {
    const t = ctl(['create', '--title', '产物任务'])
    assert.deepEqual(t.artifacts, [])
    const a1 = ctl(['artifact', t.id, '--by', 'coder', '--kind', 'html', '--path', 'D:/x/report.html', '--title', '验收报表'])
    assert.equal(a1.artifacts.length, 1)
    assert.equal(a1.artifacts[0].kind, 'html')
    assert.equal(a1.artifacts[0].title, '验收报表')
    assert.equal(a1.artifacts[0].path, 'D:/x/report.html')
    const a2 = ctl(['artifact', t.id, '--by', 'coder', '--kind', 'file', '--path', 'D:/x/out.txt'])
    assert.equal(a2.artifacts.length, 2)
    assert.throws(() => ctl(['artifact', t.id, '--by', 'c', '--kind', 'exe', '--path', 'x']), /kind/)
    assert.throws(() => ctl(['artifact', t.id, '--by', 'c']), /kind|path/)
  })
})
