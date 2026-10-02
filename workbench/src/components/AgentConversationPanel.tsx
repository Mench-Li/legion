import { useEffect, useRef, useState } from 'react'
import { fetchChatMessages, fetchRule, fetchSkills, hubRequest, subscribeHubAudit } from '../api'
import type { ChatMessage, RosterAgent } from '../types'

interface Task {
  id:string; title:string; status:string; version:number; hold:boolean; dispatchHoldOwned:boolean; artifacts:unknown[]
  attempt:{ id:string; state:string; lease_epoch:number; external_effect:string | null } | null
  runBinding:{ run_id:string } | null
}
interface Detail {
  agentId:string; role:string; scope:string; executionState:string; tasks:Task[]
  questions:Array<{ id:string; task_id:string; body:string; status:string; version:number }>
  commands:Array<{ id:string; task_id:string; status:string; result:string | null; type:string }>
}
type Intent='ask' | 'feedback' | 'create_task'

export function AgentConversationPanel({ agent,onOpenTask,view='chat' }: {
  agent:RosterAgent; onOpenTask:(id:string) => void; view?:'chat' | 'artifacts' | 'records' | 'rules'
}): React.JSX.Element {
  const scope=agent.scope ?? 'default'
  const [detail,setDetail]=useState<Detail | null>(null),[conv,setConv]=useState<number | null>(null)
  const [messages,setMessages]=useState<ChatMessage[]>([]),[taskId,setTaskId]=useState(''),[draft,setDraft]=useState('')
  const [intent,setIntent]=useState<Intent>('ask'),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [olderAvailable,setOlderAvailable]=useState(false),[newCount,setNewCount]=useState(0)
  const [rules,setRules]=useState(''),[skills,setSkills]=useState<Array<{ id:string; name:string }>>([])
  const generation=useRef(0),feed=useRef<HTMLDivElement>(null),stick=useRef(true)
  const seenMessages=useRef(new Set<number>())
  const retry=useRef<{ payload:string; id:string } | null>(null)
  const controlRetry=useRef<{ payload:string; id:string } | null>(null), historyLoaded=useRef(false)
  useEffect(() => {
    let active=true
    if (view==='rules') { setRules('');setSkills([]);void Promise.all([fetchRule(scope),fetchSkills({ scope })]).then(([r,s]) => {
      if (active) { setRules(r.content);setSkills(s) }
    }).catch(e => { if (active) setError(String(e)) }) }
    return () => { active=false }
  },[scope,view])
  useEffect(() => {
    let active=true,loading=false
    const gen=++generation.current
    setDetail(null);setConv(null);setMessages([]);setTaskId('');setDraft('');setIntent('ask');setError('');setBusy(false);retry.current=null
    controlRetry.current=null;historyLoaded.current=false;stick.current=true;setNewCount(0)
    seenMessages.current.clear()
    async function refresh() {
      if (loading) return
      loading=true
      try {
        const result=await hubRequest('GET',`/api/agents?scope=${encodeURIComponent(scope)}`) as { agents:Detail[] }
        const d=result.agents.find(a => a.role===agent.role)
        if (!d) throw new Error('该岗位尚未注册，等待编队同步。')
        const binding=await hubRequest('POST','/api/agent-conversations',{ agentId:d.agentId,scope,by:'general' }) as { convId:number }
        const rows=await fetchChatMessages(binding.convId,{ limit:50 })
        if (!active || generation.current!==gen) return
        setDetail(d);setConv(binding.convId);setError('')
        const unseen=rows.filter(m => !seenMessages.current.has(m.id))
        if (!stick.current && seenMessages.current.size && unseen.length) setNewCount(n => n+unseen.length)
        for (const m of rows) seenMessages.current.add(m.id)
        setMessages(old => {
          return [...new Map([...old,...rows].map(m => [m.id,m])).values()].sort((a,b) => a.id-b.id)
        })
        if (!historyLoaded.current) setOlderAvailable(rows.length===50)
        if (stick.current && view==='chat') {
          requestAnimationFrame(() => { if (active && feed.current) feed.current.scrollTop=feed.current.scrollHeight })
          const last=rows.at(-1)
          if (last && document.visibilityState==='visible') await hubRequest('POST','/api/agent-read-cursors',{ scope,conv:binding.convId,messageId:last.id,by:'general' })
        }
      } catch(e) { if (active) setError(e instanceof Error ? e.message : String(e)) }
      finally { loading=false }
    }
    void refresh()
    const timer=setInterval(() => void refresh(),3000)
    const unsub=subscribeHubAudit(() => void refresh(),{ scope })
    return () => { active=false;generation.current++;clearInterval(timer);unsub() }
  },[scope,agent.role,view])
  async function send(question?:Detail['questions'][number]) {
    if (!conv || !detail || busy || !draft.trim()) return
    if ((intent==='feedback' || question) && !(question?.task_id ?? taskId)) { setError('请选择具体任务。');return }
    const gen=generation.current
    const payload={ scope,conv,body:draft.trim(),intent:question ? 'answer_question' : intent,
      target:taskId || question ? { taskId:question?.task_id ?? taskId } : null,
      ...(question ? { questionId:question.id,questionVersion:question.version } : {}),by:'general' }
    const encoded=JSON.stringify(payload)
    if (retry.current?.payload!==encoded) retry.current={ payload:encoded,id:crypto.randomUUID() }
    setBusy(true);setError('')
    try {
      await hubRequest('POST','/api/agent-messages',{ ...payload,clientRequestId:retry.current!.id })
      const rows=await fetchChatMessages(conv,{ limit:50 })
      if (generation.current!==gen) return
      for (const m of rows) seenMessages.current.add(m.id)
      retry.current=null;setDraft('');setMessages(old => [...new Map([...old,...rows].map(m => [m.id,m])).values()].sort((a,b) => a.id-b.id))
    } catch(e) { if (generation.current===gen) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (generation.current===gen) setBusy(false) }
  }
  async function control(type:string,t:Task) {
    if (!detail || busy) return
    let resolutionNote:string | undefined
    if (type==='resume_with_feedback') {
      const note=window.prompt('核对本次运行的工具记录及外部系统，确认没有已发生的外部写入后填写依据。填写后将创建新一轮执行；结果不确定请取消。')
      if (!note?.trim()) return
      resolutionNote=note.trim()
    }
    const gen=generation.current
    const payload={ scope,agentId:detail.agentId,taskId:t.id,taskVersion:t.version,
      attemptId:t.attempt?.id,leaseEpoch:t.attempt?.lease_epoch,runId:t.runBinding?.run_id,type,by:'general',
      ...(resolutionNote ? { resolutionNote,confirmedNoExternalEffects:true } : {}) }
    const encoded=JSON.stringify(payload)
    if (controlRetry.current?.payload!==encoded) controlRetry.current={ payload:encoded,id:crypto.randomUUID() }
    setBusy(true);setError('')
    try { await hubRequest('POST','/api/agent-commands',{ ...payload,clientRequestId:controlRetry.current!.id });controlRetry.current=null }
    catch(e) { if (generation.current===gen) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (generation.current===gen) setBusy(false) }
  }
  async function older() {
    if (!conv || !messages.length) return
    const gen=generation.current
    try { const rows=await fetchChatMessages(conv,{ before:messages[0].id,limit:50 });if (generation.current!==gen) return
      historyLoaded.current=true;setMessages(old => [...new Map([...rows,...old].map(m => [m.id,m])).values()].sort((a,b) => a.id-b.id));setOlderAvailable(rows.length===50) }
    catch(e) { if (generation.current===gen) setError(String(e)) }
  }
  if (view==='rules') return <div><p>岗位：{agent.role} · 空间：{scope}</p><p>空间规范（岗位的实际生效规则以本轮输入快照为准）</p><pre style={{ whiteSpace:'pre-wrap' }}>{rules || '尚无空间规范'}</pre><p>空间技能目录</p>{skills.map(s => <p key={s.id}>{s.name} · {s.id}</p>)}<p>请在工作台“规范”和“技能”管理规则；修改影响新执行。岗位授权与实际纳入项请查看运行输入。</p>{error && <p role="alert">{error}</p>}</div>
  if (view==='artifacts') return <div>{detail?.tasks.map(t => <section key={t.id}><button onClick={() => onOpenTask(t.id)}>{t.id} · {t.title}</button><pre>{JSON.stringify(t.artifacts,null,2)}</pre></section>)}{error && <p role="alert">{error}</p>}</div>
  if (view==='records') return <div><p>打开任务可查看实际输入、事件与证据。</p>{detail?.tasks.map(t => <p key={t.id}><button onClick={() => onOpenTask(t.id)}>{t.id}</button> · {t.attempt?.state ?? '无运行记录'} · {t.runBinding?.run_id ?? '无执行连接'}</p>)}{detail?.commands.map(c => <p key={c.id}>{c.task_id} · {c.type} · {c.status} · {c.result}</p>)}{error && <p role="alert">{error}</p>}</div>
  return <div className="agent-conversation">
    <p>{detail?.executionState ?? '读取状态中'} · 进度依据保存记录回答；复杂答问需要在线回复守护</p>
    {error && <p role="alert" style={{ color:'var(--red)' }}>{error}</p>}
    <label>关联任务 <select value={taskId} onChange={e => setTaskId(e.target.value)}><option value="">全部任务（只读询问）</option>{detail?.tasks.map(t => <option key={t.id} value={t.id}>{t.id} · {t.title}</option>)}</select></label>
    {detail?.tasks.filter(t => t.id===taskId).map(t => <div key={t.id} className="agent-chat-controls"><button onClick={() => onOpenTask(t.id)}>查看任务与证据</button>
      {!t.hold && !['done','canceled'].includes(t.status) && <button disabled={busy} onClick={() => void control('hold_task',t)}>暂停后续调度</button>}
      {t.hold && t.dispatchHoldOwned && !['done','canceled'].includes(t.status) && <button disabled={busy} onClick={() => void control('release_hold',t)}>恢复后续调度</button>}
      {t.attempt?.state==='Running' && t.runBinding && <button disabled={busy} onClick={() => void control('stop_run',t)}>停止本次执行</button>}
      {t.attempt?.state==='Running' && t.runBinding && !t.hold && t.attempt.external_effect==='absent' && <button disabled={busy} onClick={() => void control('restart_with_feedback',t)}>停止后重新执行</button>}
      {t.attempt?.state==='Cancelled' && t.runBinding && t.hold && t.dispatchHoldOwned && <button disabled={busy} onClick={() => void control('resume_with_feedback',t)}>核对后按新要求重跑</button>}
    </div>)}
    <div ref={feed} className="agent-chat-feed" onScroll={() => { const f=feed.current;stick.current=!!f && f.scrollHeight-f.scrollTop-f.clientHeight<40;if (stick.current) setNewCount(0) }}>
      {olderAvailable && <button onClick={() => void older()}>加载更早消息</button>}
      {messages.map(m => <article key={m.id} className={`agent-chat-message ${m.author==='general' ? 'mine' : ''}`}><small>{m.author==='general' ? '我' : m.author===detail?.agentId ? agent.name : '系统'} · {new Date(m.createdAt).toLocaleTimeString()}</small>
        <div style={{ whiteSpace:'pre-wrap' }}>{m.body}</div>{typeof m.meta?.taskId==='string' && <button onClick={() => onOpenTask(String(m.meta?.taskId))}>查看 {m.meta.taskId}</button>}
        {m.meta?.aiStatus==='awaiting' && <small>等待只读模型答问</small>}{m.meta?.aiStatus==='failed' && <small>答问失败：{String(m.meta.aiError ?? '请重新询问')}</small>}
      </article>)}{!messages.length && <p>询问工作进度，或选择任务后追加要求。</p>}
    </div>
    {newCount>0 && <button onClick={() => { stick.current=true;setNewCount(0);if (feed.current) feed.current.scrollTop=feed.current.scrollHeight }}>{newCount} 条新消息</button>}
    {detail?.questions.filter(q => q.status==='open').map(q => <div key={q.id}><p>{q.task_id} 待决策：{q.body}</p><button disabled={busy || !draft.trim()} onClick={() => void send(q)}>用输入内容回答</button></div>)}
    <div className="agent-chat-compose"><select value={intent} onChange={e => setIntent(e.target.value as Intent)}><option value="ask">询问</option><option value="feedback">追加要求（下一轮生效）</option><option value="create_task">创建新任务</option></select>
      <textarea aria-label="给 Agent 的消息" value={draft} maxLength={8000} onChange={e => setDraft(e.target.value)} placeholder="询问进度，或选择任务后追加要求" onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key==='Enter') void send() }} />
      <button disabled={busy || !conv || !draft.trim()} onClick={() => void send()}>{busy ? '提交中' : '发送'}</button></div>
  </div>
}
