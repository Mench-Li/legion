import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'legion-skill-perm-'))
process.env.TEAM_HUB_DB = join(root, 'team.db')
const mod = await import('./server.mjs')
const port = await new Promise(resolve => mod.server.listen(0, '127.0.0.1', () => resolve(mod.server.address().port)))
const base = `http://127.0.0.1:${port}`

test('unattended cross-scope skill grant requires and accepts approval request', async () => {
  mod.registerSkill({ id: 'guarded', name: 'Guarded', scope: 'software', prompt: 'x' })
  mod.reviewSkill('guarded', 'publish')
  const pending = await fetch(base + '/api/skills/grant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'guarded', grants: ['scope:research'], by: 'general', unattended: true }) })
  assert.equal(pending.status, 202)
  const payload = await pending.json()
  assert.ok(payload.requestId)
  mod.decidePermission({ requestId: payload.requestId, decision: 'approve', by: 'general' })
  const done = await fetch(base + '/api/skills/grant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'guarded', grants: ['scope:research'], by: 'general', unattended: true, permissionRequestId: payload.requestId }) })
  assert.equal(done.status, 200)
  assert.ok(mod.getSkill('guarded').grants.includes('scope:research'))
})

test.after(async () => { await new Promise(resolve => mod.server.close(resolve)); try { mod.db.close() } catch {}; rmSync(root, { recursive: true, force: true }) })
