import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'legion-permissions-'))
process.env.TEAM_HUB_DB = join(root, 'team.db')
const mod = await import('./server.mjs')

test('permission API stores policy and returns allow/deny/ask decisions', () => {
  mod.upsertPermissionRule({ id: 'skill-ask', scope: 'software', action: 'skill:grant', mode: 'ask', by: 'general' })
  const ask = mod.checkPermission({ scope: 'software', actor: 'general', action: 'skill:grant', target: 'alice' })
  assert.equal(ask.status, 'pending')
  assert.ok(ask.requestId)
  const inbox = mod.listPermissionInbox('software')
  assert.equal(inbox.length, 1)
  const approved = mod.decidePermission({ requestId: ask.requestId, decision: 'approve', by: 'general' })
  assert.equal(approved.status, 'approved')
  assert.equal(mod.decidePermission({ requestId: ask.requestId, decision: 'approve', by: 'general' }).status, 'approved')
})

test('hard floor cannot be overridden and one-time approval consumes once', () => {
  mod.upsertPermissionRule({ id: 'delete-allow', mode: 'allow-by-policy', action: 'file:delete', by: 'general' })
  assert.equal(mod.checkPermission({ scope: 'software', actor: 'general', action: 'file:delete', target: 'x' }).allowed, false)
  mod.upsertPermissionRule({ id: 'once', scope: 'software', action: 'skill:revoke', target: 'alice', mode: 'allow-once', by: 'general' })
  const pending = mod.checkPermission({ scope: 'software', actor: 'general', action: 'skill:revoke', target: 'alice' })
  mod.decidePermission({ requestId: pending.requestId, decision: 'approve', by: 'general' })
  assert.equal(mod.checkPermission({ scope: 'software', actor: 'general', action: 'skill:revoke', target: 'alice', permissionRequestId: pending.requestId }).allowed, true)
  assert.equal(mod.checkPermission({ scope: 'software', actor: 'general', action: 'skill:revoke', target: 'alice', permissionRequestId: pending.requestId }).allowed, false)
})

// ------------------------------------------------------------------ PRT-611
//
// 下面这两组走**真的 server**，因为被修掉的两个缺陷都在 `checkPermission` 里，
// 而不在纯函数里。

test('PRT-611 ★★ 批准之后，`metadata` 键序不同的同一次调用**不该**被拒', () => {
  mod.upsertPermissionRule({ id: 'meta-once', scope: 'software', action: 'file:read', target: '/data/x', mode: 'allow-once', by: 'general' })
  const first = mod.checkPermission({
    scope: 'software', actor: 'general', action: 'file:read', target: '/data/x',
    metadata: { path: '/data/x', mode: 'rw' },
  })
  assert.equal(first.status, 'pending')
  mod.decidePermission({ requestId: first.requestId, decision: 'approve', by: 'general' })

  // 执行时的 metadata 键序恰好相反 —— 这是**同一个操作**。
  const second = mod.checkPermission({
    scope: 'software', actor: 'general', action: 'file:read', target: '/data/x',
    permissionRequestId: first.requestId,
    metadata: { mode: 'rw', path: '/data/x' },
  })
  assert.equal(second.allowed, true, '键序被当成了操作身份的一部分（"明明批了，它说操作不匹配"）')
  assert.equal(second.status, 'consumed')
})

test('PRT-611 ★★ 批准之后，`metadata` 的**值**变了必须被拒', () => {
  mod.upsertPermissionRule({ id: 'meta2-once', scope: 'software', action: 'repo:read', target: '/repo/y', mode: 'allow-once', by: 'general' })
  const first = mod.checkPermission({
    scope: 'software', actor: 'general', action: 'repo:read', target: '/repo/y',
    metadata: { branch: 'main' },
  })
  mod.decidePermission({ requestId: first.requestId, decision: 'approve', by: 'general' })
  assert.throws(
    () => mod.checkPermission({
      scope: 'software', actor: 'general', action: 'repo:read', target: '/repo/y',
      permissionRequestId: first.requestId,
      metadata: { branch: 'release' },
    }),
    /operation mismatch/,
    '改掉了已批准操作的字段却仍然放行',
  )
})

test('PRT-611 ★★ 待批准请求的去重粒度与消费时的绑定粒度**一致**', () => {
  // 缺陷原形：去重只看 scope/actor/action/target，消费时却看全部字段。
  // 于是 `taskId` 不同的一次调用会复用上一条待批准请求，用户批准之后
  // 消费方因为指纹不同而拒绝 —— 用户看到"我批了，它说操作不匹配"。
  mod.upsertPermissionRule({ id: 'dedup-ask', scope: 'software', action: 'file:write', target: '/w/z', mode: 'ask', by: 'general' })

  const a = mod.checkPermission({
    scope: 'software', actor: 'general', action: 'file:write', target: '/w/z', taskId: 'task-A',
  })
  const againA = mod.checkPermission({
    scope: 'software', actor: 'general', action: 'file:write', target: '/w/z', taskId: 'task-A',
  })
  assert.equal(againA.requestId, a.requestId, '同一个操作应当复用同一条待批准请求')

  const b = mod.checkPermission({
    scope: 'software', actor: 'general', action: 'file:write', target: '/w/z', taskId: 'task-B',
  })
  assert.notEqual(b.requestId, a.requestId,
    'taskId 不同却复用了同一条待批准请求——批准 A 之后消费 B 会因指纹不同而被拒')

  // 而且两条请求批准之后，各自的调用都能真的通过。
  mod.decidePermission({ requestId: a.requestId, decision: 'approve', by: 'general' })
  mod.decidePermission({ requestId: b.requestId, decision: 'approve', by: 'general' })
  const okA = mod.checkPermission({
    scope: 'software', actor: 'general', action: 'file:write', target: '/w/z', taskId: 'task-A',
    permissionRequestId: a.requestId,
  })
  const okB = mod.checkPermission({
    scope: 'software', actor: 'general', action: 'file:write', target: '/w/z', taskId: 'task-B',
    permissionRequestId: b.requestId,
  })
  assert.equal(okA.allowed, true)
  assert.equal(okB.allowed, true)
})

test.after(() => { try { mod.db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) })
