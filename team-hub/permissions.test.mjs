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

test.after(() => { try { mod.db.close() } catch {} ; rmSync(root, { recursive: true, force: true }) })
