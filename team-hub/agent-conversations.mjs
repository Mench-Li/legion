import { randomUUID, createHash } from 'node:crypto'
import { redactValue } from '../runtime/adapters/dsh/redact.mjs'

const parse = (value, fallback = []) => { try { return JSON.parse(value ?? '') } catch { return fallback } }
const keyOf = (...parts) => JSON.stringify(parts)
const id = prefix => `${prefix}-${randomUUID()}`
/** 汇报流会话的标题后缀（BUG-003 的顺手项）。
 *
 *  为什么需要：同一个 (空间, 岗位) 有两条会话——这条汇报流（`agent_conversation_bindings`）
 *  与对话中心那条（`conversations.agent_role`），标题都是岗位名。空间会话列表里那条
 *  与 Agent 页面的那条**同名不同内容**，用户分不出哪条是汇报。
 *  加一个后缀只为可分辨；它不改任何数据归属，也不改会话的身份（身份是 binding_key）。 */
export const REPORT_STREAM_SUFFIX = ' · 汇报流'
const reportStreamTitle = (agentName) => `${agentName}${REPORT_STREAM_SUFFIX}`
export class AgentConversationError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status }
}
const fail = (code, message, status) => { throw new AgentConversationError(code, message, status) }
const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) fail('MISSING_PARAM', `${label} 必填且不超过 200 字符`)
  return value.trim()
}

/** Same connection and transaction authority as chat/tasks. No model or process ownership here. */
export function createAgentConversationService({ db, withTx, audit, clock = Date.now, recordRunEvents, createTask }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_registry (
      agent_id TEXT PRIMARY KEY, scope TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL,
      avatar TEXT, archived INTEGER NOT NULL DEFAULT 0, UNIQUE(scope, role));
    CREATE TABLE IF NOT EXISTS agent_conversation_bindings (
      conv_id INTEGER PRIMARY KEY, scope TEXT NOT NULL, agent_id TEXT NOT NULL,
      task_id TEXT, binding_key TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS agent_request_receipts (
      scope TEXT NOT NULL, actor TEXT NOT NULL, request_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(scope,actor,request_id));
    CREATE TABLE IF NOT EXISTS agent_feedback (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, agent_id TEXT NOT NULL, task_id TEXT NOT NULL,
      message_id INTEGER NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, superseded INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS agent_feedback_inclusions (
      feedback_id TEXT NOT NULL, attempt_id TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(feedback_id,attempt_id));
    CREATE TABLE IF NOT EXISTS agent_questions (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, agent_id TEXT NOT NULL, task_id TEXT NOT NULL,
      attempt_id TEXT, body TEXT NOT NULL, options_json TEXT NOT NULL, status TEXT DEFAULT 'open',
      version INTEGER DEFAULT 1, answer TEXT, answered_by TEXT, source_message_id INTEGER);
    CREATE TABLE IF NOT EXISTS agent_commands (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, agent_id TEXT NOT NULL, task_id TEXT NOT NULL,
      attempt_id TEXT, run_id TEXT, lease_epoch INTEGER, worker_id TEXT, type TEXT NOT NULL,
      status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, claimed_at INTEGER);
    CREATE TABLE IF NOT EXISTS agent_dispatch_holds (
      task_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, previous_hold INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_reports (
      report_id TEXT PRIMARY KEY, source_key TEXT NOT NULL, conv_id INTEGER NOT NULL,
      source_refs TEXT NOT NULL, message_id INTEGER, state TEXT DEFAULT 'pending',
      UNIQUE(source_key,conv_id));
    CREATE TABLE IF NOT EXISTS agent_read_cursors (
      actor TEXT NOT NULL, scope TEXT NOT NULL, conv_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
      PRIMARY KEY(actor,scope,conv_id));
    CREATE TABLE IF NOT EXISTS agent_run_bindings (
      attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      worker_id TEXT NOT NULL, lease_epoch INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_agent_feedback_task ON agent_feedback(scope,task_id);
    CREATE INDEX IF NOT EXISTS idx_agent_commands_attempt ON agent_commands(attempt_id,status);
  `)
  const iso = () => new Date(clock()).toISOString()
  function syncRoster() {
    return withTx(() => {
      db.prepare('UPDATE agent_registry SET archived=1').run()
      for (const row of db.prepare('SELECT scope,role,name,avatar FROM roster').all()) {
        db.prepare(`INSERT INTO agent_registry(agent_id,scope,role,name,avatar,archived) VALUES(?,?,?,?,?,0)
          ON CONFLICT(scope,role) DO UPDATE SET name=excluded.name,avatar=excluded.avatar,archived=0`)
          .run(id('agent'), row.scope, row.role, row.name, row.avatar)
      }
    })
  }
  function agent(agentId, scope) {
    const row = db.prepare('SELECT * FROM agent_registry WHERE agent_id=? AND scope=?').get(agentId, required(scope, 'scope'))
    if (!row) fail('AGENT_NOT_FOUND', '该空间不存在此 Agent', 404)
    return row
  }
  function taskFor(a, taskId) {
    const t = db.prepare('SELECT * FROM tasks WHERE id=? AND scope=?').get(taskId, a.scope)
    if (!t || (t.role ?? t.soldier) !== a.role) fail('TARGET_MISMATCH', '任务不属于该空间和 Agent', 409)
    return t
  }
  function binding(convId, scope) {
    const b = db.prepare('SELECT * FROM agent_conversation_bindings WHERE conv_id=? AND scope=?').get(Number(convId), required(scope, 'scope'))
    if (!b) fail('CONVERSATION_NOT_FOUND', 'Agent 会话不存在', 404)
    return b
  }
  function latest(taskId) { return db.prepare('SELECT * FROM run_attempts WHERE task_id=? ORDER BY attempt_no DESC LIMIT 1').get(taskId) ?? null }
  function detail(agentId, scope) {
    const a = agent(agentId, scope)
    const tasks = db.prepare('SELECT * FROM tasks WHERE scope=? AND COALESCE(role,soldier)=? ORDER BY updatedAt DESC').all(scope, a.role)
      .map(t => ({ id: t.id, title: t.title, status: t.status, version: t.version, hold: !!t.hold,
        artifacts: parse(t.artifacts), testReport: t.testReport, attempt: latest(t.id),
        dispatchHoldOwned:!!db.prepare('SELECT task_id FROM agent_dispatch_holds WHERE task_id=?').get(t.id),
        runBinding: db.prepare('SELECT * FROM agent_run_bindings WHERE attempt_id=?').get(latest(t.id)?.id ?? '') ?? null }))
    const active = tasks.filter(t => !['done','canceled'].includes(t.status))
    return { ...a, agentId: a.agent_id, tasks, activeTasks: active,
      executionState: active.some(t => t.attempt?.state === 'Running') ? 'running' : active.length ? 'queued-or-blocked' : 'idle',
      evidenceAsOf: iso(), questions:db.prepare('SELECT * FROM agent_questions WHERE agent_id=? ORDER BY rowid DESC LIMIT 50').all(agentId),
      commands:db.prepare('SELECT * FROM agent_commands WHERE agent_id=? ORDER BY rowid DESC LIMIT 50').all(agentId),
      capabilities: { recordQuery: true, modelAnswer: 'requires-chat-worker', liveSteer: false, nativePause: false } }
  }
  function list(scope) { return db.prepare('SELECT * FROM agent_registry WHERE scope=? AND archived=0 ORDER BY role').all(required(scope,'scope')).map(a => detail(a.agent_id, scope)) }
  function conversation({ agentId, scope, taskId = null, by }) {
    required(by, 'by'); const a = agent(agentId, scope)
    if (taskId) taskFor(a, taskId)
    return withTx(() => {
      const bindingKey = keyOf(scope, agentId, taskId)
      const existing = db.prepare('SELECT conv_id FROM agent_conversation_bindings WHERE binding_key=?').get(bindingKey)
      if (existing) return { convId: existing.conv_id, agentId, taskId }
      if (a.archived) fail('AGENT_ARCHIVED', 'Agent 已归档', 409)
      const time = iso()
      const r = db.prepare(`INSERT INTO conversations(scope,title,kind,participants,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?)`).run(scope, taskId ? `${a.name} · ${taskId}` : reportStreamTitle(a.name), taskId ? 'task' : 'direct', JSON.stringify(['general',agentId]), time, time)
      const convId = Number(r.lastInsertRowid)
      db.prepare('INSERT INTO agent_conversation_bindings VALUES(?,?,?,?,?)').run(convId,scope,agentId,taskId,bindingKey)
      audit(by,scope,'chat:create',taskId,{ conv: convId,agentId })
      return { convId, agentId, taskId }
    })
  }
  function insertMessage(b, author, body, meta, kind = 'text') {
    const safe = redactValue({ body, meta }).value
    const time = iso()
    const r = db.prepare('INSERT INTO messages(conv_id,scope,author,kind,body,meta,createdAt) VALUES(?,?,?,?,?,?,?)')
      .run(b.conv_id,b.scope,author,kind,safe.body,JSON.stringify(safe.meta),time)
    const messageId = Number(r.lastInsertRowid)
    db.prepare('UPDATE conversations SET updatedAt=?,last_message_at=? WHERE id=?').run(time,time,b.conv_id)
    audit(author,b.scope,'chat:message',meta.taskId ?? null,{ conv: b.conv_id,msg:messageId,agentId:b.agent_id })
    return messageId
  }
  function once(scope, actor, requestId, payload, operation) {
    required(actor, 'by'); required(requestId, 'clientRequestId')
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    return withTx(() => {
      const old = db.prepare('SELECT * FROM agent_request_receipts WHERE scope=? AND actor=? AND request_id=?').get(scope,actor,requestId)
      if (old) { if (old.payload_hash !== hash) fail('IDEMPOTENCY_CONFLICT','相同请求键的内容不同',409); return parse(old.result_json,{}) }
      const result = operation()
      db.prepare('INSERT INTO agent_request_receipts VALUES(?,?,?,?,?)').run(scope,actor,requestId,hash,JSON.stringify(result))
      return result
    })
  }
  function selectedTask(a, b, target, requiredTarget = false) {
    const taskId = b.task_id ?? target?.taskId ?? null
    if (b.task_id && target?.taskId && target.taskId !== b.task_id) fail('TARGET_MISMATCH','不能改变任务会话目标',409)
    if (!taskId && requiredTarget) fail('TARGET_AMBIGUOUS','请选择本消息关联的任务',409)
    return taskId ? taskFor(a,taskId) : null
  }
  function evidence(a, t) {
    const d = detail(a.agent_id,a.scope)
    const selected = t ? d.tasks.filter(x => x.id === t.id) : d.tasks.slice(0,10)
    return { agentId:a.agent_id, name:a.name, role:a.role, evidenceAsOf:iso(), tasks:selected.map(x => {
      const events = x.attempt ? db.prepare('SELECT event_seq,type,at_ms FROM run_events WHERE attempt_id=? ORDER BY event_seq DESC LIMIT 5').all(x.attempt.id) : []
      return { ...x, recentEvents: events }
    }) }
  }
  function statusText(records) {
    if (!records.tasks.length) return '当前没有已保存的任务记录。'
    return records.tasks.map(t => `${t.id} ${t.title}：任务状态 ${t.status}${t.hold ? '，已暂停后续调度' : ''}；本轮 ${t.attempt?.state ?? '尚无执行记录'}。${t.recentEvents?.[0] ? `最近事件 ${t.recentEvents[0].type}。` : '没有过程事件记录。'}`).join('\n') + '\n依据已保存的执行记录；运行结束不代表已验收。'
  }
  function feedback(b,a,t,messageId,body,by = 'general') {
    const stopped=t.status==='canceled' && latest(t.id)?.state==='Cancelled' && !!db.prepare('SELECT task_id FROM agent_dispatch_holds WHERE task_id=?').get(t.id)
    if (t.status==='done' || (t.status==='canceled' && !stopped)) fail('TASK_TERMINAL','已完成任务请创建关联的新任务',409)
    const feedbackId = id('feedback')
    db.prepare('INSERT INTO agent_feedback VALUES(?,?,?,?,?,?,?,0)').run(feedbackId,a.scope,a.agent_id,t.id,messageId,body,iso())
    // Existing production source loader reads task.feedback. One authoritative input path.
    const existing = parse(t.feedback)
    existing.push({ id:feedbackId, by, at:iso(), text:body })
    db.prepare('UPDATE tasks SET feedback=?,version=version+1,updatedAt=? WHERE id=? AND version=?')
      .run(JSON.stringify(existing),iso(),t.id,t.version)
    insertMessage(b,'system:agent', '要求已保存，将在下一次执行时生效；当前运行未变更。', { source:'command',semanticType:'feedback_receipt',feedbackId,taskId:t.id })
    return feedbackId
  }
  function send(input) {
    const b = binding(input.conv,input.scope), a = agent(b.agent_id,b.scope)
    if (a.archived) fail('AGENT_ARCHIVED','Agent 已归档',409)
    const body = requiredBody(input.body), intent = input.intent ?? 'ask'
    if (!['ask','feedback','answer_question','create_task'].includes(intent)) fail('INVALID_INTENT','不支持的消息意图')
    return once(b.scope,input.by,input.clientRequestId,{ conv:b.conv_id,body,intent,target:input.target ?? null,questionId:input.questionId ?? null,questionVersion:input.questionVersion ?? null }, () => {
      const t = selectedTask(a,b,input.target,intent !== 'ask' && intent !== 'create_task')
      const records = evidence(a,t)
      const isStatus = /进度|做到|状态|正在做|做什么|完成了吗|status|progress/i.test(body)
      const meta = { source:'user',semanticType:intent,agentId:a.agent_id,taskId:t?.id ?? null }
      if (intent === 'ask' && !isStatus) { meta.aiStatus='awaiting'; meta.aiStatusAt=iso(); meta.agentContext=records }
      const messageId = insertMessage(b,input.by,body,meta)
      if (intent === 'ask' && isStatus) insertMessage(b,a.agent_id,statusText(records),{ source:'answer',semanticType:'answer',replyToMessageId:messageId,...records,generatedFromRecords:true })
      let feedbackId = null, createdTask = null
      if (intent === 'feedback') feedbackId = feedback(b,a,t,messageId,body,input.by)
      if (intent === 'answer_question') {
        const q = db.prepare('SELECT * FROM agent_questions WHERE id=? AND scope=? AND agent_id=? AND task_id=?').get(input.questionId,b.scope,a.agent_id,t.id)
        if (!q || q.status !== 'open' || q.version !== input.questionVersion) fail('QUESTION_RESOLVED','问题版本已变化或不存在',409)
        if (q.attempt_id && latest(t.id)?.id !== q.attempt_id) fail('STALE_RUN_TARGET','旧运行问题不能影响新执行',409)
        db.prepare("UPDATE agent_questions SET status='answered',answer=?,answered_by=?,source_message_id=?,version=version+1 WHERE id=? AND version=?")
          .run(body,input.by,messageId,q.id,q.version)
        feedbackId = feedback(b,a,t,messageId,`问题：${q.body}\n用户决定：${body}`,input.by)
        // Legacy soldier state machine detects a human reply in comments.
        const notes=parse(t.comments)
        notes.push({ by:input.by,at:iso(),text:`问题答复：${body}`,questionId:q.id })
        db.prepare('UPDATE tasks SET comments=?,version=version+1,updatedAt=? WHERE id=?').run(JSON.stringify(notes),iso(),t.id)
      }
      if (intent === 'create_task') {
        if (!createTask) fail('UNSUPPORTED_CAPABILITY','任务创建未接线',409)
        createdTask = createTask({ by:input.by,scope:a.scope,role:a.role,title:body.slice(0,200),description:body })
        insertMessage(b,'system:agent',`已创建任务 ${createdTask.id}，等待调度。`,{ source:'command',taskId:createdTask.id })
      }
      return { messageId,feedbackId,taskId:createdTask?.id ?? t?.id ?? null,convId:b.conv_id }
    })
  }
  function requiredBody(body) {
    if (typeof body !== 'string' || !body.trim() || body.length > 8000) fail('INVALID_BODY','消息应为 1 到 8000 字符')
    return body.trim()
  }
  function read({ conv,scope,by,messageId }) {
    const b = binding(conv,scope); required(by,'by')
    const m = db.prepare('SELECT id FROM messages WHERE id=? AND conv_id=?').get(messageId,b.conv_id)
    if (!m) fail('MESSAGE_NOT_FOUND','消息不属于会话',404)
    return withTx(() => { db.prepare(`INSERT INTO agent_read_cursors VALUES(?,?,?,?) ON CONFLICT(actor,scope,conv_id)
      DO UPDATE SET message_id=MAX(message_id,excluded.message_id)`).run(by,scope,b.conv_id,messageId); return { ok:true } })
  }
  function command(input) {
    const a = agent(input.agentId,input.scope), t = taskFor(a,input.taskId)
    if (a.archived) fail('AGENT_ARCHIVED','Agent 已归档',409)
    return once(a.scope,input.by,input.clientRequestId,{ type:input.type,taskId:t.id,taskVersion:input.taskVersion,attemptId:input.attemptId ?? null,runId:input.runId ?? null,leaseEpoch:input.leaseEpoch ?? null,resolutionNote:input.resolutionNote ?? null,confirmedNoExternalEffects:input.confirmedNoExternalEffects ?? false }, () => {
      if (db.prepare('SELECT version FROM tasks WHERE id=?').get(t.id)?.version !== input.taskVersion) fail('TASK_VERSION_CONFLICT','任务版本已变化',409)
      if (!['hold_task','stop_run','restart_with_feedback','release_hold','resume_with_feedback'].includes(input.type)) fail('UNSUPPORTED_CAPABILITY','不支持该控制命令',409)
      const cId = id('command'), attempt = latest(t.id)
      const run = attempt ? db.prepare('SELECT * FROM agent_run_bindings WHERE attempt_id=?').get(attempt.id) : null
      if (input.type==='resume_with_feedback') {
        const hold=db.prepare('SELECT * FROM agent_dispatch_holds WHERE task_id=?').get(t.id)
        if (!hold || !t.hold || !attempt || attempt.state!=='Cancelled' || attempt.id!==input.attemptId || run?.run_id!==input.runId || attempt.lease_epoch!==input.leaseEpoch) fail('STALE_RUN_TARGET','仅可重跑当前已确认停止且仍由本通道暂停的任务',409)
        const note=requiredBody(input.resolutionNote)
        if (input.confirmedNoExternalEffects!==true) fail('RECONCILIATION_REQUIRED','必须核对外部副作用并填写依据',409)
        db.prepare("UPDATE run_attempts SET external_effect='absent',resolved_by=?,resolved_note=? WHERE id=?").run(input.by,note,attempt.id)
        db.prepare("UPDATE agent_commands SET status='succeeded',result='人工核对已停止且未发生外部副作用' WHERE task_id=? AND attempt_id=? AND status='unknown'").run(t.id,attempt.id)
        db.prepare("UPDATE tasks SET status='todo',hold=?,soldier=NULL,claimedAt=NULL,claimedRound=NULL,ttlMinutes=NULL,expiresAt=NULL,claimRequestId=NULL,version=version+1,updatedAt=? WHERE id=?").run(hold.previous_hold,iso(),t.id)
        db.prepare('DELETE FROM agent_dispatch_holds WHERE task_id=?').run(t.id)
        db.prepare('INSERT INTO agent_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(cId,a.scope,a.agent_id,t.id,attempt.id,run.run_id,attempt.lease_epoch,attempt.worker_id,input.type,'succeeded',note,iso(),null)
        audit(input.by,a.scope,'agent:reconcile-restart',t.id,{ attemptId:attempt.id,commandId:cId,note })
        const cv=conversation({ agentId:a.agent_id,scope:a.scope,by:input.by })
        insertMessage(binding(cv.convId,a.scope),'system:agent','人工核对已记录，任务已排队等待新一轮执行及新的上下文。',{ source:'command',commandId:cId,taskId:t.id })
        return { commandId:cId,status:'succeeded' }
      }
      if (input.type === 'stop_run' || input.type === 'restart_with_feedback') {
        if (!run || attempt.state !== 'Running' || run.run_id !== input.runId || attempt.id !== input.attemptId || attempt.lease_epoch !== input.leaseEpoch) fail('STALE_RUN_TARGET','当前执行身份不匹配或未提供控制接线',409)
      }
      if (['done','canceled'].includes(t.status)) fail('TASK_TERMINAL','终态任务不可直接重跑',409)
      if (input.type === 'release_hold') {
        const hold = db.prepare('SELECT * FROM agent_dispatch_holds WHERE task_id=?').get(t.id)
        if (!hold) fail('HOLD_NOT_OWNED','该暂停不是 Agent 命令创建的',409)
        if (db.prepare("SELECT id FROM agent_commands WHERE task_id=? AND status IN ('queued','claimed','unknown')").get(t.id)) fail('OUTCOME_UNKNOWN','控制结果尚未确定，不能恢复调度',409)
        db.prepare('UPDATE tasks SET hold=?,version=version+1 WHERE id=? AND version=?').run(hold.previous_hold,t.id,t.version)
        db.prepare('DELETE FROM agent_dispatch_holds WHERE task_id=?').run(t.id)
      } else {
        const existing=db.prepare('SELECT * FROM agent_dispatch_holds WHERE task_id=?').get(t.id)
        if (input.type==='hold_task' && (existing || t.hold)) fail('TASK_HELD','任务已被其他请求暂停',409)
        if (db.prepare("SELECT id FROM agent_commands WHERE task_id=? AND status IN ('queued','claimed','unknown')").get(t.id)) fail('OUTCOME_UNKNOWN','已有执行控制请求待确认',409)
        if (existing) db.prepare('UPDATE agent_dispatch_holds SET command_id=? WHERE task_id=?').run(cId,t.id)
        else db.prepare('INSERT INTO agent_dispatch_holds VALUES(?,?,?)').run(t.id,cId,Number(t.hold ?? 0))
        db.prepare('UPDATE tasks SET hold=1,version=version+1 WHERE id=? AND version=?').run(t.id,t.version)
      }
      const status = ['hold_task','release_hold'].includes(input.type) ? 'succeeded' : 'queued'
      db.prepare('INSERT INTO agent_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(cId,a.scope,a.agent_id,t.id,
        attempt?.id ?? null,run?.run_id ?? null,attempt?.lease_epoch ?? null,attempt?.worker_id ?? null,input.type,status,null,iso(),null)
      const cv = conversation({ agentId:a.agent_id,scope:a.scope,by:input.by })
      const b = binding(cv.convId,a.scope)
      insertMessage(b,'system:agent', status === 'queued' ? '停止请求已保存，等待执行端确认。' : input.type === 'release_hold' ? '后续调度已恢复。' : '已暂停后续调度。', { source:'command',commandId:cId,taskId:t.id })
      return { commandId:cId,status }
    })
  }
  function leaseCheck(input) {
    const row = db.prepare('SELECT * FROM run_attempts WHERE id=?').get(input.attemptId)
    if (!row || row.scope !== input.scope || row.worker_id !== input.workerId || row.lease_epoch !== input.leaseEpoch || row.lease_expires_at_ms <= clock() || row.state !== 'Running') fail('STALE_RUN_TARGET','运行租约已变化',409)
    return row
  }
  function runtime(input) {
    const lease = leaseCheck(input), t = db.prepare('SELECT * FROM tasks WHERE id=?').get(lease.task_id)
    const a = db.prepare('SELECT * FROM agent_registry WHERE scope=? AND role=? AND archived=0').get(lease.scope,t.role ?? t.soldier)
    if (!a) return { commands:[],unsupported:'AGENT_NOT_REGISTERED' }
    const old = db.prepare('SELECT * FROM agent_run_bindings WHERE attempt_id=?').get(lease.id)
    if (old && (old.run_id !== input.runId || old.worker_id !== input.workerId || old.lease_epoch !== input.leaseEpoch)) fail('STALE_RUN_TARGET','执行绑定不可覆盖',409)
    // RunStore owns a separate transaction wrapper. Persist events before the
    // binding/control transaction; replay is idempotent if the process stops here.
    if (Array.isArray(input.events) && input.events.length) {
      if (input.events.length > 100) fail('EVENT_LIMIT','单批事件最多 100 条')
      for (const e of input.events) if (e.runId !== input.runId || !Number.isSafeInteger(e.seq) || e.seq < 1) fail('INVALID_EVENT','事件身份或序号不符')
      recordRunEvents({ attemptId:lease.id,leaseEpoch:input.leaseEpoch,events:input.events.map(e => ({ seq:e.seq,type:e.type,event:redactValue(e).value })) })
    }
    return withTx(() => {
      db.prepare('INSERT OR IGNORE INTO agent_run_bindings VALUES(?,?,?,?,?)').run(lease.id,required(input.runId,'runId'),a.agent_id,input.workerId,input.leaseEpoch)
      const commands = db.prepare("SELECT * FROM agent_commands WHERE attempt_id=? AND run_id=? AND lease_epoch=? AND status IN ('queued','claimed')").all(lease.id,input.runId,input.leaseEpoch)
      for (const c of commands) db.prepare("UPDATE agent_commands SET status='claimed',claimed_at=? WHERE id=?").run(clock(),c.id)
      return { commands }
    })
  }
  function question(input) {
    const lease = leaseCheck(input), run = db.prepare('SELECT * FROM agent_run_bindings WHERE attempt_id=?').get(lease.id)
    if (!run || run.run_id !== input.runId) fail('STALE_RUN_TARGET','运行未绑定',409)
    return once(lease.scope,input.workerId,input.clientRequestId,{ question:input.body,options:input.options ?? [],attemptId:lease.id }, () => {
      const qId = id('question'), text = requiredBody(input.body)
      const options = Array.isArray(input.options) ? input.options.filter(x => typeof x === 'string').slice(0,10) : []
      db.prepare('INSERT INTO agent_questions(id,scope,agent_id,task_id,attempt_id,body,options_json) VALUES(?,?,?,?,?,?,?)')
        .run(qId,lease.scope,run.agent_id,lease.task_id,lease.id,text,JSON.stringify(options))
      const cv = conversation({ agentId:run.agent_id,scope:lease.scope,taskId:lease.task_id,by:input.workerId })
      insertMessage(binding(cv.convId,lease.scope),run.agent_id,text,{ source:'progress',semanticType:'question',questionId:qId,questionVersion:1,taskId:lease.task_id,options })
      return { questionId:qId,version:1 }
    })
  }
  /**
   * 把一条汇报投影成消息：**绑定会话各一份 + 该岗位的「对话中心」会话一份**（BUG-003）。
   *
   * 为什么是多播而不是换目标：界面上给用户打开的是 `conversations.agent_role` 那条会话
   * （`workbench/src/components/ChatView.tsx` 的 `list.find(c => c.agentRole === agent.role)`），
   * 而汇报只写进 `agent_conversation_bindings` 那条 ⇒ 同一个 (空间, 岗位) 有两条同名会话，
   * 用户对着自己那条**永远看不到汇报**（实测：conv 7 有 32 条汇报、conv 25 有 0 条）。
   * `agent_reports` 的唯一键本来就是 `(source_key, conv_id)`，**同一事件在每个会话各一份投影**
   * 是设计允许的形状；多播因此不需要迁移、不需要改任何协议。
   *
   * 副本的 `author` 用 `agent:<scope>:<role>`（该会话里这位 Agent 说话时用的身份，与 AI 回复
   * 回写时的身份**同一个**）；绑定会话里仍用稳定 `agent_id`（`AgentConversationPanel` 按它认人）。
   * 两处身份约定不同是"两套会话"这件事的一部分，不是笔误。
   *
   * ★ **只播本轮新产生的事件，不补播存量**：`insertMessage` 的时间戳是"现在"，
   *   而存量汇报描述的是几周前的状态。实测在生产库副本上补播一次会往用户那条会话里
   *   灌 43 条历史状态（`T-006 任务状态：已取消。`……），每一条都以**当前时刻**出现——
   *   那不是"补全历史"，是**把旧事件重新盖章成刚刚发生**。
   *   所以：副本只在主场确有新投递（或该 Agent 一个绑定会话都没有）时写。
   *   代价是部署后那条会话要等**下一次状态变化**才有第一条汇报，这一点写进了文档。
   */
  function report(a, taskId, sourceKey, body, sourceRefs, meta = {}) {
    const cv = conversation({ agentId: a.agent_id, scope: a.scope, by: 'system:agent-report' })
    const convs = db.prepare('SELECT * FROM agent_conversation_bindings WHERE agent_id=? AND (task_id IS NULL OR task_id=?)').all(a.agent_id, taskId)
    const roleConv = db.prepare('SELECT id FROM conversations WHERE scope=? AND agent_role=?').get(a.scope, a.role)
    const multicast = roleConv && !convs.some(b => b.conv_id === roleConv.id)
      ? { conv_id: roleConv.id, scope: a.scope, agent_id: a.agent_id, task_id: null, author: `agent:${a.scope}:${a.role}` }
      : null
    /** 投递一份；返回本次是否**新写了一条消息**（已投递过 → false）。 */
    const deliver = (b) => withTx(() => {
      const rId=id('report')
      db.prepare('INSERT OR IGNORE INTO agent_reports(report_id,source_key,conv_id,source_refs) VALUES(?,?,?,?)').run(rId,sourceKey,b.conv_id,JSON.stringify(sourceRefs))
      const r = db.prepare('SELECT * FROM agent_reports WHERE source_key=? AND conv_id=?').get(sourceKey,b.conv_id)
      if (r.message_id) return false
      const messageId=insertMessage(b,b.author ?? a.agent_id,body,{ source:'progress',semanticType:'progress',agentId:a.agent_id,taskId,sourceRefs,reportId:r.report_id,...meta })
      db.prepare("UPDATE agent_reports SET message_id=?,state='delivered' WHERE report_id=?").run(messageId,r.report_id)
      return true
    })
    let fresh = false
    for (const b of convs) if (deliver(b)) fresh = true
    if (multicast && (fresh || convs.length === 0)) deliver(multicast)
    return cv
  }
  function reconcile() {
    syncRoster()
    // A crash after snapshot persistence but before its receipt is repaired here.
    const snapshotsExist=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='run_context_snapshots'").get()
    for (const row of snapshotsExist ? db.prepare(`SELECT s.attempt_id,s.payload_json FROM run_context_snapshots s
      JOIN run_attempts a ON a.id=s.attempt_id
      WHERE EXISTS (SELECT 1 FROM agent_feedback f WHERE f.task_id=a.task_id AND f.scope=a.scope
        AND NOT EXISTS (SELECT 1 FROM agent_feedback_inclusions i WHERE i.feedback_id=f.id AND i.attempt_id=a.id))`).all() : []) {
      includeFeedback(row.attempt_id,parse(row.payload_json,{}))
    }
    for (const a of db.prepare('SELECT * FROM agent_registry WHERE archived=0').all()) {
      for (const t of db.prepare('SELECT * FROM tasks WHERE scope=? AND COALESCE(role,soldier)=?').all(a.scope,a.role)) {
        const attempt=latest(t.id)
        // Production soldiers already publish blocking questions through task comments.
        // Project that authoritative path; keep comments available to legacy clients.
        if (t.status==='blocked') for (const [index,note] of parse(t.comments).entries()) {
          if (!String(note.text ?? '').includes('❓')) continue
          const qId=`question-${createHash('sha256').update(keyOf(t.id,index,note.at,note.text)).digest('hex')}`
          if (db.prepare('SELECT id FROM agent_questions WHERE id=?').get(qId)) continue
          withTx(() => {
            db.prepare('INSERT OR IGNORE INTO agent_questions(id,scope,agent_id,task_id,attempt_id,body,options_json) VALUES(?,?,?,?,?,?,?)')
              .run(qId,a.scope,a.agent_id,t.id,attempt?.id ?? null,String(note.text),'[]')
            report(a,t.id,keyOf('question',qId),String(note.text),[{ taskId:t.id,commentIndex:index }],{ semanticType:'question',questionId:qId,questionVersion:1 })
          })
        }
        if (attempt) report(a,t.id,keyOf('attempt',attempt.id,attempt.state),`${t.id} 本轮状态：${attempt.state}。${attempt.state === 'Completed' ? '本轮已结束，交付仍以任务验收为准。' : ''}`,[{ attemptId:attempt.id,state:attempt.state }])
        if (['done','in_review','blocked','canceled'].includes(t.status)) report(a,t.id,keyOf('task',t.id,t.version,t.status),`${t.id} 任务状态：${t.status === 'done' ? '已完成' : t.status === 'in_review' ? '待验收' : t.status === 'blocked' ? '受阻' : '已取消'}。`,[{ taskId:t.id,version:t.version }])
        if (attempt) for (const ev of db.prepare("SELECT * FROM run_events WHERE attempt_id=? AND type IN ('artifact.produced','run.failed','run.cancelled','run.outcome_unknown') ORDER BY event_seq").all(attempt.id)) {
          report(a,t.id,keyOf('event',attempt.id,ev.event_seq),`${t.id} 已记录 ${ev.type}。请查看运行记录和产物；此消息不代表验收通过。`,[{ attemptId:attempt.id,eventSeq:ev.event_seq }],{ attemptId:attempt.id })
        }
      }
    }
    settleCommands()
  }
  function settleCommands() {
    for (const c of db.prepare("SELECT * FROM agent_commands WHERE status IN ('queued','claimed','unknown')").all()) {
      const attempt = db.prepare('SELECT * FROM run_attempts WHERE id=?').get(c.attempt_id)
      let status=null, result=null
      if (!attempt || attempt.lease_epoch !== c.lease_epoch || latest(c.task_id)?.id !== c.attempt_id) { status='superseded'; result='执行身份已变化，旧命令不再执行。' }
      else if (attempt.state === 'Cancelled') { status='succeeded'; result='本次执行已确认停止。' }
      else if (['Completed','DeadLetter'].includes(attempt.state)) { status='superseded'; result='执行已经结束，未将其记为取消。' }
      else if (attempt.state === 'UnknownOutcome' || attempt.lease_expires_at_ms <= clock()) { status='unknown'; result='停止结果待确认，禁止自动重跑。' }
      if (!status || status===c.status) continue
      if (c.status==='unknown' && c.type==='restart_with_feedback' && attempt?.state==='Cancelled' && attempt.external_effect!=='absent') continue
      withTx(() => {
        db.prepare('UPDATE agent_commands SET status=?,result=? WHERE id=?').run(status,result,c.id)
        if (status==='succeeded' && c.type==='restart_with_feedback') {
          // Cancelled is a terminal attempt. Queue a new task attempt via existing claim path.
          const t=db.prepare('SELECT * FROM tasks WHERE id=?').get(c.task_id)
          const hold=db.prepare('SELECT * FROM agent_dispatch_holds WHERE task_id=? AND command_id=?').get(t.id,c.id)
          if (!hold || Number(t.hold)!==1 || attempt.external_effect !== 'absent') {
            db.prepare("UPDATE agent_commands SET status='unknown',result=? WHERE id=?").run('暂停所有权或外部副作用需人工核对，未重跑。',c.id)
            result='暂停所有权或外部副作用需人工核对，未重跑。'
          } else {
            db.prepare("UPDATE tasks SET status='todo',hold=?,soldier=NULL,claimedAt=NULL,claimedRound=NULL,ttlMinutes=NULL,expiresAt=NULL,claimRequestId=NULL,version=version+1,updatedAt=? WHERE id=?").run(hold.previous_hold,iso(),t.id)
            db.prepare('DELETE FROM agent_dispatch_holds WHERE task_id=? AND command_id=?').run(t.id,c.id)
            result+=' 已排队等待新一轮执行，使用新的上下文。'
            db.prepare('UPDATE agent_commands SET result=? WHERE id=?').run(result,c.id)
          }
        }
        const cv=conversation({ agentId:c.agent_id,scope:c.scope,by:'system:agent-control' })
        insertMessage(binding(cv.convId,c.scope),'system:agent',result,{ source:'command',commandId:c.id,taskId:c.task_id })
      })
    }
  }
  function includeFeedback(attemptId,snapshot) {
    const attempt=db.prepare('SELECT * FROM run_attempts WHERE id=?').get(attemptId)
    if (!attempt) return
    const sources = new Map((snapshot?.sources ?? []).filter(s => s.type==='user-feedback').map(s => [String(s.id).replace(/^comment:/,''),s]))
    return withTx(() => {
      for (const f of db.prepare('SELECT * FROM agent_feedback WHERE superseded=0 AND scope=? AND task_id=?').all(attempt.scope,attempt.task_id)) {
        const source=sources.get(f.id)
        if (!source) continue
        const row=db.prepare('INSERT OR IGNORE INTO agent_feedback_inclusions VALUES(?,?,?)').run(f.id,attemptId,iso())
        if (!row.changes) continue
        const a=agent(f.agent_id,f.scope)
        report(a,f.task_id,keyOf('inclusion',f.id,attemptId),source.truncated ? '追加要求的一部分已纳入本轮输入，预算导致截断；请查看输入快照。' : '追加要求已纳入本轮输入；是否实现仍需验证。',[{ feedbackId:f.id,attemptId,truncated:!!source.truncated }])
      }
    })
  }
  /**
   * 把**已经存在**的汇报流会话标题补上后缀（BUG-003 顺手项，幂等）。
   *
   * 只动一类行：`agent_conversation_bindings.task_id IS NULL`（直接绑定那条 = 汇报流），
   * 且标题**正好等于**岗位名（既没有后缀、也不是任务会话 `岗位名 · T-xxx`）。
   * 已有后缀的不动，用户能看见的历史标题不会被反复改写。
   * 这是纯展示层改写：会话身份是 `binding_key`，标题从来不参与匹配。
   */
  function backfillReportStreamTitles() {
    const rows = db.prepare(`SELECT b.conv_id, r.name FROM agent_conversation_bindings b
      JOIN agent_registry r ON r.agent_id = b.agent_id
      WHERE b.task_id IS NULL`).all()
    for (const row of rows) {
      const conv = db.prepare('SELECT title FROM conversations WHERE id=?').get(row.conv_id)
      if (!conv || conv.title !== row.name) continue
      db.prepare('UPDATE conversations SET title=? WHERE id=?').run(reportStreamTitle(row.name), row.conv_id)
    }
  }
  function getCommand(commandId,scope) {
    const c=db.prepare('SELECT * FROM agent_commands WHERE id=? AND scope=?').get(commandId,required(scope,'scope'))
    if (!c) fail('COMMAND_NOT_FOUND','命令不存在',404)
    return c
  }
  function manualHold(taskId,hold) {
    if (!hold && db.prepare("SELECT id FROM agent_commands WHERE task_id=? AND status IN ('queued','claimed','unknown')").get(taskId)) fail('OUTCOME_UNKNOWN','停止结果尚未确认，不能恢复调度',409)
    db.prepare('DELETE FROM agent_dispatch_holds WHERE task_id=?').run(taskId)
  }
  syncRoster()
  backfillReportStreamTitles()
  return { syncRoster,backfillReportStreamTitles,list,detail,conversation,send,read,command,runtime,question,reconcile,includeFeedback,getCommand,manualHold,
    binding: (convId) => db.prepare('SELECT * FROM agent_conversation_bindings WHERE conv_id=?').get(Number(convId)) ?? null }
}
