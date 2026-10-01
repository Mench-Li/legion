import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir=mkdtempSync(join(tmpdir(),'legion-agent-chat-'))
process.env.TEAM_HUB_DB=join(dir,'test.db')
const hub=await import('./server.mjs')
const service=hub.agentConversations, db=hub.db
after(() => { hub.server.closeAllConnections?.();hub.server.close();hub.disposeHub(); db.close(); rmSync(dir,{ recursive:true,force:true }) })
db.prepare('INSERT OR REPLACE INTO roster(scope,role,name) VALUES(?,?,?)').run('agent-test','coder','编码员')
db.prepare('INSERT OR REPLACE INTO roster(scope,role,name) VALUES(?,?,?)').run('agent-other','coder','另一位')
db.prepare('INSERT INTO tasks(id,title,scope,role,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)').run('T-9999','登录','agent-test','coder','todo',new Date().toISOString(),new Date().toISOString())
service.syncRoster()
const a=service.list('agent-test').find(a => a.role==='coder')
const cv=service.conversation({ agentId:a.agentId,scope:a.scope,by:'general' })
const send=(body,extra={}) => service.send({ conv:cv.convId,scope:a.scope,by:'general',clientRequestId:crypto.randomUUID(),body,...extra })

test('stable identity survives roster rename and separate spaces have different IDs',() => {
  db.prepare('UPDATE roster SET name=? WHERE scope=?').run('新名字',a.scope)
  service.syncRoster()
  assert.equal(service.list(a.scope)[0].agentId,a.agentId)
  assert.notEqual(service.list('agent-other')[0].agentId,a.agentId)
})
test('direct binding is unique, task binding distinct, cross scope rejected',() => {
  assert.equal(service.conversation({ agentId:a.agentId,scope:a.scope,by:'general' }).convId,cv.convId)
  assert.notEqual(service.conversation({ agentId:a.agentId,scope:a.scope,taskId:'T-9999',by:'general' }).convId,cv.convId)
  assert.throws(() => service.conversation({ agentId:a.agentId,scope:'agent-other',by:'general' }),{ code:'AGENT_NOT_FOUND' })
})
test('status query replies immediately from records without model queue or progress loop',() => {
  const result=send('做到哪里了？')
  const user=db.prepare('SELECT * FROM messages WHERE id=?').get(result.messageId)
  assert.equal(JSON.parse(user.meta).aiStatus,undefined)
  const reply=db.prepare('SELECT * FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT 1').get(cv.convId)
  assert.match(reply.body,/T-9999/)
  assert.equal(JSON.parse(reply.meta).generatedFromRecords,true)
})
test('message retries use same ID; changed content under same key conflicts',() => {
  const input={ body:'进度',conv:cv.convId,scope:a.scope,by:'general',clientRequestId:'same-request' }
  const first=service.send(input), second=service.send(input)
  assert.equal(first.messageId,second.messageId)
  assert.throws(() => service.send({ ...input,body:'另一条' }),{ code:'IDEMPOTENCY_CONFLICT' })
})
test('general conversation queues a read-only answer with record context',() => {
  const m=send('解释这个设计取舍')
  const row=db.prepare('SELECT meta FROM messages WHERE id=?').get(m.messageId)
  assert.equal(JSON.parse(row.meta).aiStatus,'awaiting')
  assert.equal(JSON.parse(row.meta).agentContext.agentId,a.agentId)
})
test('feedback requires task, persists for existing context loader, receipt is not model input acknowledgement',() => {
  assert.throws(() => send('加验证码',{ intent:'feedback' }),{ code:'TARGET_AMBIGUOUS' })
  const result=send('加验证码',{ intent:'feedback',target:{ taskId:'T-9999' } })
  const t=db.prepare('SELECT * FROM tasks WHERE id=?').get('T-9999')
  assert.equal(JSON.parse(t.feedback)[0].id,result.feedbackId)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_feedback_inclusions').get().n,0)
  db.prepare('INSERT INTO run_attempts(id,task_id,scope,attempt_no,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?)').run('test-attempt','T-9999',a.scope,1,'Queued',Date.now(),Date.now())
  service.includeFeedback('test-attempt',{ sources:[{ type:'user-feedback',id:result.feedbackId }] })
  service.includeFeedback('test-attempt',{ sources:[{ type:'user-feedback',id:result.feedbackId }] })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_feedback_inclusions').get().n,1)
})
test('reports recover and duplicate projection creates one message per conversation',() => {
  db.prepare("UPDATE tasks SET status='in_review',version=version+1 WHERE id='T-9999'").run()
  service.reconcile()
  const before=db.prepare('SELECT COUNT(*) AS n FROM messages').get().n
  service.reconcile()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,before)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body LIKE '%待验收%'").get().n,2)
})
test('hold is persistent, release versioned and stale commands rejected',() => {
  db.prepare("UPDATE tasks SET status='todo' WHERE id='T-9999'").run()
  const t=db.prepare("SELECT * FROM tasks WHERE id='T-9999'").get()
  const c=service.command({ agentId:a.agentId,scope:a.scope,taskId:t.id,taskVersion:t.version,by:'general',clientRequestId:'hold',type:'hold_task' })
  assert.equal(c.status,'succeeded')
  assert.equal(db.prepare('SELECT hold FROM tasks WHERE id=?').get(t.id).hold,1)
  assert.throws(() => service.command({ agentId:a.agentId,scope:a.scope,taskId:t.id,taskVersion:t.version,by:'general',clientRequestId:'stale',type:'release_hold' }),{ code:'TASK_VERSION_CONFLICT' })
  service.command({ agentId:a.agentId,scope:a.scope,taskId:t.id,taskVersion:t.version+1,by:'general',clientRequestId:'release',type:'release_hold' })
  assert.equal(db.prepare('SELECT hold FROM tasks WHERE id=?').get(t.id).hold,0)
})
test('unknown execution binding cannot be stopped, cross scope messages fail',() => {
  const t=db.prepare("SELECT * FROM tasks WHERE id='T-9999'").get()
  assert.throws(() => service.command({ agentId:a.agentId,scope:a.scope,taskId:t.id,taskVersion:t.version,by:'general',clientRequestId:'stop-unknown',type:'stop_run' }),{ code:'STALE_RUN_TARGET' })
  assert.throws(() => service.send({ conv:cv.convId,scope:'agent-other',by:'general',clientRequestId:'cross',body:'进度' }),{ code:'CONVERSATION_NOT_FOUND' })
})
test('read cursor advances monotonically, rejects unrelated messages',() => {
  const msgs=db.prepare('SELECT id FROM messages WHERE conv_id=? ORDER BY id').all(cv.convId)
  service.read({ conv:cv.convId,scope:a.scope,by:'general',messageId:msgs.at(-1).id })
  service.read({ conv:cv.convId,scope:a.scope,by:'general',messageId:msgs[0].id })
  assert.equal(db.prepare('SELECT message_id FROM agent_read_cursors WHERE conv_id=?').get(cv.convId).message_id,msgs.at(-1).id)
  assert.throws(() => service.read({ conv:cv.convId,scope:a.scope,by:'general',messageId:-1 }),{ code:'MESSAGE_NOT_FOUND' })
})

function runningTask(taskId,attemptId) {
  db.prepare('INSERT INTO tasks(id,title,scope,role,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)').run(taskId,'控制测试',a.scope,a.role,'in_progress',new Date().toISOString(),new Date().toISOString())
  db.prepare('INSERT INTO run_attempts(id,task_id,scope,attempt_no,state,worker_id,lease_epoch,lease_expires_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(attemptId,taskId,a.scope,1,'Running','worker-a',7,Date.now()+600000,Date.now(),Date.now())
  const input={ scope:a.scope,workerId:'worker-a',attemptId,leaseEpoch:7,runId:`run-${attemptId}` }
  service.runtime(input)
  return input
}
test('run-bound cancellation waits for terminal, repeated delivery and stale leases are safe',() => {
  const r=runningTask('T-9998','cancel-attempt')
  const t=db.prepare('SELECT * FROM tasks WHERE id=?').get('T-9998')
  const c=service.command({ ...r,agentId:a.agentId,taskId:t.id,taskVersion:t.version,type:'stop_run',by:'general',clientRequestId:'cancel' })
  assert.equal(c.status,'queued')
  assert.equal(service.runtime(r).commands.length,1)
  assert.equal(service.runtime(r).commands.length,1)
  service.reconcile();assert.equal(service.getCommand(c.commandId,a.scope).status,'claimed')
  assert.throws(() => service.runtime({ ...r,leaseEpoch:6 }),{ code:'STALE_RUN_TARGET' })
  db.prepare("UPDATE run_attempts SET state='Cancelled' WHERE id=?").run(r.attemptId)
  service.reconcile();assert.equal(service.getCommand(c.commandId,a.scope).status,'succeeded')
  assert.equal(db.prepare('SELECT hold FROM tasks WHERE id=?').get(t.id).hold,1)
})
test('question decisions reject duplicates and old attempts; partial inputs are labelled',() => {
  const r=runningTask('T-9997','question-attempt')
  const q=service.question({ ...r,body:'选择存储？',clientRequestId:'question1',options:['SQLite','Postgres'] })
  assert.equal(service.question({ ...r,body:'选择存储？',clientRequestId:'question1',options:['SQLite','Postgres'] }).questionId,q.questionId)
  const result=send('SQLite',{ intent:'answer_question',target:{ taskId:'T-9997' },questionId:q.questionId,questionVersion:1 })
  assert.throws(() => send('Postgres',{ intent:'answer_question',target:{ taskId:'T-9997' },questionId:q.questionId,questionVersion:1 }),{ code:'QUESTION_RESOLVED' })
  service.includeFeedback(r.attemptId,{ sources:[{ id:result.feedbackId,type:'user-feedback',truncated:true }] })
  assert.match(db.prepare('SELECT body FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT 1').get(cv.convId).body,/截断/)
  service.includeFeedback('cancel-attempt',{ sources:[{ id:result.feedbackId,type:'user-feedback' }] })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_feedback_inclusions WHERE feedback_id=?').get(result.feedbackId).n,1)
})
test('blocked production comments create one persistent question',() => {
  db.prepare("UPDATE tasks SET status='blocked',comments=? WHERE id='T-9999'").run(JSON.stringify([{ by:'soldier-auto',at:'now',text:'❓ 待将军确认：接口协议？' }]))
  service.reconcile();service.reconcile()
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_questions WHERE task_id='T-9999'").get().n,1)
})
test('expired command becomes unknown and prevents release or automatic replay',() => {
  const r=runningTask('T-9996','expired-attempt'), t=db.prepare("SELECT * FROM tasks WHERE id='T-9996'").get()
  const c=service.command({ ...r,agentId:a.agentId,taskId:t.id,taskVersion:t.version,type:'stop_run',by:'general',clientRequestId:'expired' })
  db.prepare('UPDATE run_attempts SET lease_expires_at_ms=0 WHERE id=?').run(r.attemptId)
  service.reconcile();assert.equal(service.getCommand(c.commandId,a.scope).status,'unknown')
  assert.throws(() => service.command({ agentId:a.agentId,scope:a.scope,taskId:t.id,taskVersion:t.version+1,type:'release_hold',by:'general',clientRequestId:'unsafe-release' }),{ code:'OUTCOME_UNKNOWN' })
})
test('events persist while running and recover a single report after replay',() => {
  const r=runningTask('T-9995','event-attempt')
  const event={ runId:r.runId,seq:1,type:'artifact.produced',artifact:{ path:'out.txt' } }
  service.runtime({ ...r,events:[event] });service.runtime({ ...r,events:[event] })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM run_events WHERE attempt_id=?').get(r.attemptId).n,1)
  service.reconcile();const before=db.prepare('SELECT COUNT(*) n FROM messages').get().n
  service.reconcile();assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n,before)
  assert.throws(() => service.runtime({ ...r,runId:'other',events:[{ ...event,runId:'other' }] }),{ code:'STALE_RUN_TARGET' })
})
test('confirmed stopped run requires explicit side-effect reconciliation before new dispatch',() => {
  const t=db.prepare("SELECT * FROM tasks WHERE id='T-9998'").get()
  const input={ agentId:a.agentId,scope:a.scope,taskId:t.id,taskVersion:t.version,attemptId:'cancel-attempt',runId:'run-cancel-attempt',leaseEpoch:7,
    type:'resume_with_feedback',by:'general',clientRequestId:'resume',resolutionNote:'外部工具记录已核对，没有发生写入' }
  assert.throws(() => service.command(input),{ code:'RECONCILIATION_REQUIRED' })
  const c=service.command({ ...input,confirmedNoExternalEffects:true })
  assert.equal(c.status,'succeeded')
  assert.equal(db.prepare('SELECT status,hold FROM tasks WHERE id=?').get(t.id).status,'todo')
  assert.equal(db.prepare('SELECT hold FROM tasks WHERE id=?').get(t.id).hold,0)
  assert.equal(db.prepare('SELECT resolved_by FROM run_attempts WHERE id=?').get(input.attemptId).resolved_by,'general')
})
test('manual pause removes automatic resume ownership',() => {
  const t=db.prepare("SELECT * FROM tasks WHERE id='T-9995'").get()
  service.command({ agentId:a.agentId,scope:a.scope,taskId:t.id,taskVersion:t.version,type:'hold_task',by:'general',clientRequestId:'ownership' })
  service.manualHold(t.id,true)
  assert.throws(() => service.command({ agentId:a.agentId,scope:a.scope,taskId:t.id,taskVersion:t.version+1,type:'release_hold',by:'general',clientRequestId:'ownership-release' }),{ code:'HOLD_NOT_OWNED' })
})
test('real HTTP exposes persistent conversations, idempotent messages and scope errors',async () => {
  await new Promise(resolve => hub.server.listen(0,'127.0.0.1',resolve))
  const base=`http://127.0.0.1:${hub.server.address().port}`
  const post=async (path,body) => { const res=await fetch(base+path,{ method:'POST',headers:{ 'Content-Type':'application/json' },body:JSON.stringify(body) });return { status:res.status,body:await res.json() } }
  const c=await post('/api/agent-conversations',{ scope:a.scope,agentId:a.agentId,by:'general' })
  assert.equal(c.status,200);assert.equal(c.body.convId,cv.convId)
  const input={ scope:a.scope,conv:cv.convId,body:'进度',by:'general',clientRequestId:'http-progress' }
  const first=await post('/api/agent-messages',input),second=await post('/api/agent-messages',input)
  assert.equal(first.status,200);assert.equal(first.body.messageId,second.body.messageId)
  assert.equal((await post('/api/agent-messages',{ ...input,scope:'agent-other' })).status,404)
  const { createHubSourceLoader }=await import('../orchestrator/worker/sources-loader.mjs')
  const reader={ async read(path) { const res=await fetch(base+path);const body=await res.json();if (!res.ok) throw Object.assign(Error(body.error),{ status:res.status });return body } }
  const f=await post('/api/agent-messages',{ ...input,body:'必须加入可观测性',intent:'feedback',target:{ taskId:'T-9997' },clientRequestId:'http-feedback' })
  assert.equal(f.status,200)
  const sources=await createHubSourceLoader({ hub:reader,scope:a.scope }).loadSources({ taskId:'T-9997',scope:a.scope,role:a.role })
  assert.ok(sources.userFeedback.some(x => x.id===f.body.feedbackId),'production loader preserves feedback identity')
  const frozen=await post('/api/context-snapshots/assemble',{ attemptId:'question-attempt',runId:'run-question-attempt',scope:a.scope,frozenAtMs:Date.now(),
    sources,canReadAll:true,associations:{ taskId:'T-9997' },actor:'worker-a' })
  assert.equal(frozen.status,200,JSON.stringify(frozen.body))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_feedback_inclusions WHERE feedback_id=?').get(f.body.feedbackId).n,1)
  const persisted=await (await fetch(base+'/api/context-snapshots/question-attempt?verify=1')).json()
  assert.ok(JSON.stringify(persisted).includes('必须加入可观测性'))
  db.prepare('DELETE FROM agent_feedback_inclusions WHERE feedback_id=?').run(f.body.feedbackId)
  service.reconcile()
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_feedback_inclusions WHERE feedback_id=?').get(f.body.feedbackId).n,1,'reconciliation repairs missing receipt after snapshot commit')
})
