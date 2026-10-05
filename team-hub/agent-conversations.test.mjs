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

// ── 汇报落点（BUG-003 → 修法 C 之后的形态）─────────────────────────────────
//
// 现场（BUG-003）：同一个 (空间, 岗位) 有两条同名会话——绑定那条（汇报流）与
// `conversations.agent_role` 那条（人在用），用户对着自己那条永远看不到汇报。
// 修法 C 把两条收敛成一条之后，这里守的是：
//   ① 汇报落进**那条唯一的主对话**（有 agent_role、也是 binding），作者是该岗位身份；
//   ② 只落**一份**（不再有"各一份"的多播副本）；
//   ③ 对账幂等：重复跑不加消息。
test('★ 汇报落进唯一的主对话（agent_role 即为绑定会话），一份、幂等、作者身份正确',() => {
  const role='coder'
  const conv=hub.createConversation({ scope:'agent-test', agentRole:role, by:'general' })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_conversation_bindings WHERE conv_id=?').get(conv.id).n,1,
    '修法 C 之后主对话**就是**绑定会话（两条同名会话已收敛为一条）')
  assert.equal(db.prepare('SELECT agent_role FROM conversations WHERE id=?').get(conv.id).agent_role,role)
  db.prepare("UPDATE tasks SET status='done',version=version+1,updatedAt=? WHERE id='T-9999'").run(new Date().toISOString())
  service.reconcile()
  const rows=db.prepare('SELECT * FROM messages WHERE conv_id=? ORDER BY id').all(conv.id)
  const taskReport=rows.filter(r => /已完成/.test(r.body))
  assert.equal(taskReport.length,1,'汇报必须落进主对话，且只落一份')
  assert.equal(taskReport[0].author,'agent:agent-test:coder',
    '作者必须是该会话里这位 Agent 说话用的身份：用稳定 agent_id 会让对话中心把它显示成一串 uuid')
  assert.equal(JSON.parse(taskReport[0].meta).source,'progress')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM conversations WHERE scope='agent-test' AND agent_role=? AND id<>?").get(role,conv.id).n,0,
    '不许再有任何第二条带同一 agent_role 的会话')
  // 幂等：再对账两次不许加消息
  const before=db.prepare('SELECT COUNT(*) AS n FROM messages').get().n
  service.reconcile();service.reconcile()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,before)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conv_id=? AND body LIKE '%已完成%'").get(conv.id).n,1)
})

// ★ **历史不许被重新盖章**（BUG-003 实测教训 → 修法 C 把它升格为通用规则）。
//   实测：在生产库副本上对一条新会话跑一次对账，会灌进 43 条几周前的终态
//   （`T-006 任务状态：已取消。`…），每条都被 insertMessage 盖上"现在"的时间戳。
//   判据：超窗口的旧事件**一条都不投影**；新事件照常投。
test('★ 历史事件不补播：超窗口的旧终态不许以"现在"的戳写进主对话',() => {
  const old=new Date(Date.now()-72*60*60*1000).toISOString()   // 72 小时前（超出 24h 新鲜窗口）
  db.prepare('INSERT OR REPLACE INTO roster(scope,role,name) VALUES(?,?,?)').run('agent-test','writer2','文案员')
  db.prepare('INSERT INTO tasks(id,title,scope,role,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)')
    .run('T-9940','文案','agent-test','writer2','done',old,old)
  service.syncRoster()
  const w=service.list('agent-test').find(x => x.role==='writer2')
  const bound=service.conversation({ agentId:w.agentId,scope:w.scope,by:'general' })
  service.reconcile();service.reconcile()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conv_id=?').get(bound.convId).n,0,
    '超窗口的旧终态被投影了（会被盖上"现在"的时间戳 ⇒ 几周前的事件看起来刚刚发生）')
  // 新事件（把 updatedAt 推到"现在"）照常投
  db.prepare("UPDATE tasks SET status='canceled',version=version+1,updatedAt=? WHERE id='T-9940'").run(new Date().toISOString())
  service.reconcile()
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conv_id=? AND body LIKE '%已取消%'").get(bound.convId).n,1,
    '新鲜事件必须照常投影（窗口不是"什么都不报"）')
})
// ── 修法 C（单入口）：一个 (空间, 岗位) 只有一条主对话 ────────────────────────
//
// 现场：同一个 (空间, 岗位) 有两条同名会话——对话中心那条（`agent_role`，人在这里说话）
// 与汇报流那条（binding，汇报写在这里）。用户对着自己那条永远看不到汇报（BUG-003）。
// C 的判据：① 新建即带 agent_role 且走到同一条；② 已有 agent_role 会话时**收养**它；
// ③ 迁移把存量双子收敛（binding 搬迁、两条标题各就各位、一条消息都不搬）。
test('★ C：新建的直接会话就带 agent_role（界面按它找得到同一条），任务会话不带',() => {
  db.prepare('INSERT OR REPLACE INTO roster(scope,role,name) VALUES(?,?,?)').run('agent-c','coder','编码员C')
  db.prepare('INSERT INTO tasks(id,title,scope,role,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)')
    .run('T-9921','任务会话C','agent-c','coder','todo',new Date().toISOString(),new Date().toISOString())
  service.syncRoster()
  const ac=service.list('agent-c').find(x => x.role==='coder')
  const direct=service.conversation({ agentId:ac.agentId,scope:'agent-c',by:'general' })
  const row=db.prepare('SELECT title, agent_role FROM conversations WHERE id=?').get(direct.convId)
  assert.equal(row.agent_role,'coder','直接会话必须是该岗位的主对话（否则界面按 agent_role 找不到它）')
  assert.equal(row.title,'编码员C','主对话用纯岗位名（它同时承载汇报，加「· 汇报流」反而误导）')
  const task=service.conversation({ agentId:ac.agentId,scope:'agent-c',taskId:'T-9921',by:'general' })
  assert.equal(db.prepare('SELECT agent_role FROM conversations WHERE id=?').get(task.convId).agent_role,null,
    '任务会话不是主对话，不该带 agent_role')
  assert.equal(db.prepare('SELECT title FROM conversations WHERE id=?').get(task.convId).title,'编码员C · T-9921')
  // 幂等：重复进入返回同一条，且不再新建
  const again=service.conversation({ agentId:ac.agentId,scope:'agent-c',by:'general' })
  assert.equal(again.convId,direct.convId)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM conversations WHERE scope='agent-c' AND agent_role='coder'").get().n,1,
    '一个 (空间, 岗位) 只能有一条带 agent_role 的会话')
})

test('★★ C：已有「对话中心」会话时**收养**它，而不是再建一条同名的',() => {
  db.prepare('INSERT OR REPLACE INTO roster(scope,role,name) VALUES(?,?,?)').run('agent-adopt','coder','编码员D')
  service.syncRoster()
  const ad=service.list('agent-adopt').find(x => x.role==='coder')
  // 模拟"界面先建了对话中心那条"：带 agent_role、但还没有 binding
  const legacy=hub.createConversation({ scope:'agent-adopt', agentRole:'coder', by:'general' })
  const before=db.prepare('SELECT COUNT(*) n FROM conversations WHERE scope=?').get('agent-adopt').n
  const bound=service.conversation({ agentId:ad.agentId,scope:'agent-adopt',by:'general' })
  assert.equal(bound.convId,legacy.id,'必须收养既有的 agent_role 会话，而不是新建（否则又长出一条双子）')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM conversations WHERE scope=?').get('agent-adopt').n,before,
    '收养不许新建会话')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_conversation_bindings WHERE conv_id=?').get(legacy.id).n,1,
    '收养后这条会话要拿到 binding（汇报与控制命令才写得进来）')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM conversations WHERE scope='agent-adopt' AND agent_role='coder'").get().n,1)
})

test('★★ C：存量迁移把双子收敛——binding 搬到 agent_role 那条，历史那条只改标题',() => {
  db.prepare('INSERT OR REPLACE INTO roster(scope,role,name) VALUES(?,?,?)').run('agent-merge','coder','编码员E')
  service.syncRoster()
  const am=service.list('agent-merge').find(x => x.role==='coder')
  // 造出**修复前**的现场形态（必须用裸 SQL：修法 C 之后走 API 已经建不出双子——
  // 那正是修法的目的）。修复前的形态是：汇报流那条**不带** agent_role、被 binding 指着；
  // 对话中心那条带 agent_role。库上本来就有 `idx_agent_main_conversation`
  // 唯一索引（(scope, agent_role) WHERE agent_role IS NOT NULL），所以"两条都带 agent_role"
  // 在库层面根本不允许——双子的成因正是**绑定那条没有 agent_role**。
  const streamId=Number(db.prepare("INSERT INTO conversations(scope,title,kind,participants,createdAt,updatedAt,last_message_at) VALUES(?,?,'direct','[]',?,?,NULL)")
    .run('agent-merge','编码员E · 汇报流',new Date().toISOString(),new Date().toISOString()).lastInsertRowid)
  db.prepare('INSERT INTO agent_conversation_bindings VALUES(?,?,?,?,?)').run(streamId,'agent-merge',am.agentId,null,JSON.stringify(['agent-merge',am.agentId,null]))
  const stream={ convId: streamId }
  const t=db.prepare("INSERT INTO conversations(scope,title,kind,participants,createdAt,updatedAt,last_message_at,agent_role) VALUES(?,?,'direct','[]',?,?,NULL,?)")
    .run('agent-merge','编码员E',new Date().toISOString(),new Date().toISOString(),'coder')
  const twinId=Number(t.lastInsertRowid)
  assert.notEqual(stream.convId,twinId)
  // 历史那条里放一条汇报，证明迁移**不搬消息**
  const msgId=db.prepare('INSERT INTO messages(conv_id,scope,author,kind,body,meta,createdAt) VALUES(?,?,?,?,?,?,?)')
    .run(stream.convId,'agent-merge','agent-x','text','历史汇报','{"source":"progress"}',new Date().toISOString()).lastInsertRowid
  const out=service.convergeAgentConversations()
  assert.ok(out.adopted.some(x => x.to===twinId && x.from===stream.convId),`迁移没认出这对双子：${JSON.stringify(out)}`)
  assert.equal(db.prepare('SELECT conv_id FROM agent_conversation_bindings WHERE binding_key=?').get(JSON.stringify(['agent-merge',am.agentId,null])).conv_id,twinId,
    'binding 必须搬到 agent_role 那条（主对话）')
  assert.equal(db.prepare('SELECT agent_role FROM conversations WHERE id=?').get(twinId).agent_role,'coder','主对话保留 agent_role')
  assert.equal(db.prepare('SELECT title FROM conversations WHERE id=?').get(twinId).title,'编码员E','主对话标题回到纯岗位名')
  assert.equal(db.prepare('SELECT agent_role FROM conversations WHERE id=?').get(stream.convId).agent_role,null,
    '历史那条必须摘掉 agent_role：否则两条都带它，界面会随机命中')
  assert.match(db.prepare('SELECT title FROM conversations WHERE id=?').get(stream.convId).title,/历史汇报/,
    '历史那条要给出去向标记，而不是悄悄变成一条同名会话')
  assert.equal(db.prepare('SELECT conv_id FROM messages WHERE id=?').get(msgId).conv_id,stream.convId,
    '迁移不许搬消息：历史会话里的汇报原样留着')
  // 幂等：再跑一次不该重复做（此时已无双子）
  const again=service.convergeAgentConversations()
  assert.equal(again.adopted.length,0,`重复执行不该再次搬迁：${JSON.stringify(again)}`)
  assert.equal(db.prepare('SELECT title FROM conversations WHERE id=?').get(stream.convId).title,'编码员E · 历史汇报（已并入主对话）','重复执行不许改写历史标题')
  // 收敛之后：这个岗位只剩一条带 agent_role 的会话，且新汇报落在它上面、作者是岗位身份
  db.prepare("UPDATE tasks SET status='done',version=version+1,updatedAt=? WHERE id='T-9999'").run(new Date().toISOString())
  service.reconcile()
  assert.equal(db.prepare("SELECT COUNT(*) n FROM conversations WHERE scope='agent-merge' AND agent_role='coder'").get().n,1)
  assert.equal(db.prepare("SELECT agent_role FROM conversations WHERE id=?").get(twinId).agent_role,'coder')
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
