import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const temporary = mkdtempSync(join(tmpdir(), 'legion-agent-main-chat-'))
let hub
before(async () => {
  process.env.TEAM_HUB_DB = join(temporary, 'team.db')
  hub = await import('./server.mjs')
  for (const scope of ['chat-a', 'chat-b']) hub.db.prepare('INSERT INTO roster(scope,role,name,kind,avatar,sort) VALUES (?,?,?,?,?,?)').run(scope,'coder','同名编码员','代码实现','',0)
})
after(() => { hub?.db.close(); rmSync(temporary, {recursive:true,force:true}) })
test('同岗位重复打开复用会话；不同空间同名岗位隔离；旧同名会话不被认领', () => {
  const legacy = hub.createConversation({scope:'chat-a',title:'同名编码员',kind:'direct',by:'general'})
  const a = hub.createConversation({scope:'chat-a',agentRole:'coder',by:'general'})
  const repeated = hub.createConversation({scope:'chat-a',agentRole:'coder',by:'general'})
  const b = hub.createConversation({scope:'chat-b',agentRole:'coder',by:'general'})
  assert.equal(a.id,repeated.id); assert.notEqual(a.id,b.id); assert.notEqual(a.id,legacy.id)
  assert.equal(a.agentRole,'coder'); assert.equal(a.kind,'direct')
  const count=hub.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE scope = ? AND action = 'chat:create'").get('chat-a').n
  assert.equal(count,2,'幂等重新打开不能再写 chat:create')
})
test('缺少具体空间、岗位、操作者或跨空间不存在的岗位，拒绝绑定且不落库', () => {
  const before=hub.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n
  for(const input of [{agentRole:'coder',by:'general'},{scope:'',agentRole:'coder',by:'general'},{scope:'chat-a',agentRole:'',by:'general'},{scope:'chat-a',agentRole:'missing',by:'general'},{scope:'chat-a',agentRole:'coder'}])assert.throws(()=>hub.createConversation(input))
  assert.equal(hub.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n,before)
})
test('等待回复载荷包含服务端岗位与该空间任务记录，客户端冒名元数据不改变绑定', () => {
  hub.createTask({title:'A 的编码任务',scope:'chat-a',role:'coder',by:'general'})
  hub.createTask({title:'B 的编码任务',scope:'chat-b',role:'coder',by:'general'})
  const claimed=hub.createTask({title:'岗位任务由临时执行者处理',scope:'chat-a',role:'coder',by:'general'})
  hub.db.prepare('UPDATE tasks SET soldier=? WHERE id=?').run('temporary-worker',claimed.id)
  const conv=hub.createConversation({scope:'chat-a',agentRole:'coder',by:'general'})
  const msg=hub.postMessage({conv:conv.id,body:'进展如何？',by:'general',meta:{agentRole:'missing'}})
  const queued=hub.listAwaitingReplies({scope:'chat-a'}).find(x=>x.id===msg.id)
  assert.equal(queued.agent.role,'coder');assert.equal(queued.agent.identity,'agent:chat-a:coder')
  assert.ok(queued.agent.tasks.some(t=>t.title==='A 的编码任务'));assert.ok(!queued.agent.tasks.some(t=>t.title==='B 的编码任务'))
  assert.ok(queued.agent.tasks.some(t=>t.title==='岗位任务由临时执行者处理'),'与仓库岗位任务归属规则一致')
  const result=hub.postAiReply({msgId:msg.id,body:'当前记录为待批准。',by:queued.agent.identity})
  assert.equal(result.reply.author,'agent:chat-a:coder')
  assert.equal(hub.postAiReply({msgId:msg.id,body:'重复回复',by:queued.agent.identity}).skipped,true)
  const self=hub.postMessage({conv:conv.id,body:'系统记录',by:queued.agent.identity})
  assert.notEqual(self.meta.aiStatus,'awaiting')
})
test('空间会话继续使用旧回复身份，且不携带 Agent 上下文', () => {
  const conv=hub.createConversation({scope:'chat-b',title:'空间讨论',by:'general'})
  const msg=hub.postMessage({conv:conv.id,body:'空间问题',by:'general'})
  const queued=hub.listAwaitingReplies({scope:'chat-b'}).find(x=>x.id===msg.id)
  assert.equal(queued.agent,undefined)
})
test('岗位移除后保留历史但拒绝新消息，已排队的消息明确失败', () => {
  const conv=hub.createConversation({scope:'chat-b',agentRole:'coder',by:'general'})
  const msg=hub.postMessage({conv:conv.id,body:'等待中的问题',by:'general'})
  hub.db.prepare('DELETE FROM roster WHERE scope=? AND role=?').run('chat-b','coder')
  assert.throws(()=>hub.postMessage({conv:conv.id,body:'新问题',by:'general'}),/已不在空间编队/)
  assert.ok(hub.listMessages({conv:conv.id}).some(m=>m.id===msg.id))
  assert.ok(!hub.listAwaitingReplies({scope:'chat-b'}).some(m=>m.id===msg.id))
  assert.equal(hub.listMessages({conv:conv.id}).find(m=>m.id===msg.id).meta.aiStatus,'failed')
})
