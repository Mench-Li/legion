import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runGit } from './git-plumbing.mjs'

const temp = join(process.env.TEMP ?? process.env.TMP ?? 'C:/Windows/Temp', `legion-accepted-checkpoint-http-${randomUUID()}`)
mkdirSync(temp, { recursive: true })
process.env.TEAM_HUB_DB = join(temp, 'team.db')
process.env.TEAM_HUB_TOKEN = ''
const mod = await import('./server.mjs')
await new Promise((resolveListen) => mod.server.listen(0, '127.0.0.1', resolveListen))
const base = `http://127.0.0.1:${mod.server.address().port}`

const post = async (path, body) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, text, json: JSON.parse(text) }
}

after(() => {
  try { mod?.server?.closeAllConnections?.() } catch { /* no active connections */ }
  try { mod?.server?.close?.() } catch { /* already closed */ }
  try { mod?.db?.close?.() } catch { /* already closed */ }
  rmSync(temp, { recursive: true, force: true })
})

test('manual acceptance records a frozen checkpoint for the next workflow stage', async () => {
  const taskId = `T-checkpoint-${randomUUID().slice(0, 8)}`
  const scope = 'accepted-checkpoint-test'
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workspace = join(repoRoot, '.legion-worktrees', taskId)
  mkdirSync(workspace, { recursive: true })
  const callGit = (args) => {
    const result = runGit(args, workspace)
    assert.equal(result.ok, true, `${args.join(' ')} failed: ${result.stderr}`)
    return result.stdout.trim()
  }
  try {
    callGit(['init', '--initial-branch', `w/${taskId}`])
    callGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'base'])
    mkdirSync(join(workspace, 'docs'), { recursive: true })
    const content = '# Requirements\n\nAccepted for implementation.\n'
    writeFileSync(join(workspace, 'docs', 'REQUIREMENTS.md'), content)
    const digest = createHash('sha256').update(content).digest('hex')

    mod.db.prepare(`INSERT INTO tasks
      (id,title,priority,status,scope,hold,role,soldier,goalId,version,fileDomain,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      taskId, 'Accepted requirement stage', 'high', 'in_review', scope, 0, 'requirement', null, null, 1,
      JSON.stringify([]), new Date().toISOString(), new Date().toISOString(),
    )
    const snapshot = {
      source: 'goal-agent-workflow',
      workflowStageId: 'design',
      reviewWorkflow: { stageDefinitionsById: { design: { role: 'requirement', nextStageIds: ['implement'] } } },
    }
    mod.db.prepare('UPDATE tasks SET agent_selection_snapshot=?, artifacts=? WHERE id=?').run(
      JSON.stringify(snapshot),
      JSON.stringify([{ by: 'general', at: new Date().toISOString(), kind: 'file', path: 'docs/REQUIREMENTS.md', title: 'Requirements', digest }]),
      taskId,
    )

    const accepted = await post('/api/transition', { id: taskId, to: 'done', by: 'general', scope })
    assert.equal(accepted.status, 200, accepted.text)
    assert.equal(accepted.json.task.status, 'done')
    const checkpoint = accepted.json.task.evidence.find((item) => item.text.startsWith('agent-workflow-stage-checkpoint:'))
    assert.ok(checkpoint, 'the downstream stage needs a checkpoint marker in upstream evidence')
    const value = JSON.parse(checkpoint.text.slice('agent-workflow-stage-checkpoint:'.length))
    assert.equal(value.stageId, 'design')
    assert.match(value.sourceCommit, /^[0-9a-f]{40,64}$/)
    assert.equal(callGit(['rev-parse', 'HEAD']), value.sourceCommit)
    assert.equal(callGit(['show', `${value.sourceCommit}:docs/REQUIREMENTS.md`]), content.trimEnd())
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})
