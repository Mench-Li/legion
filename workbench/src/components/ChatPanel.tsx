import { useCallback, useEffect, useRef, useState } from 'react'
import { createChatConversation, fetchChatConversations, fetchChatMessages, hubBase, postChatMessage, subscribeHubAudit } from '../api'
import type { ChatConversation, ChatMessage } from '../types'
import { toast } from './Toast'

const MAX_BODY = 8000 // 与后端 MAX_CHAT_BODY 对齐（TC-S1-12/S2-10）
const PAGE = 50

function fmt(ts: string | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

function bubbleClass(m: ChatMessage): string {
  return m.author === 'general' ? 'chat-bubble me' : 'chat-bubble'
}

function authorLabel(m: ChatMessage): string {
  return m.author === 'general' ? '将军' : m.author
}

/**
 * 对话中心（S2）。数据/写源 = team-hub v2 /api/chat/*（统一 handleWrite + 审计 + 单一 /api/events SSE）。
 * 渲染安全（S2 AC5 / I5）：正文只做纯文本（white-space:pre-wrap），kind 白名单外按文本兜底（TC-S2-11），
 * 全程无 dangerouslySetInnerHTML，任何 <img onerror>/<script>/[x](javascript:) 都只是文本。
 */
export function ChatPanel({ scope, hubMode }: { scope: string | null; hubMode: boolean }): React.JSX.Element {
  const [convs, setConvs] = useState<ChatConversation[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [msgs, setMsgs] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<number | null>(null)
  activeRef.current = activeId

  const loadConvs = useCallback(async (): Promise<void> => {
    try {
      const list = await fetchChatConversations(scope)
      setConvs(list)
      setActiveId(cur => (cur !== null && list.some(c => c.id === cur) ? cur : (list[0]?.id ?? null)))
    } catch (e) {
      toast('err', `会话列表加载失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [scope])

  const loadMsgs = useCallback(async (convId: number): Promise<void> => {
    setLoadingMsgs(true)
    try {
      const list = await fetchChatMessages(convId, { limit: PAGE })
      setMsgs(list)
    } catch (e) {
      setMsgs([])
      toast('err', `消息加载失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoadingMsgs(false)
    }
  }, [])

  useEffect(() => {
    if (!hubMode || !scope) { setConvs([]); setMsgs([]); setActiveId(null); return }
    let cancelled = false
    void loadConvs().then(() => { if (!cancelled && activeRef.current !== null) void loadMsgs(activeRef.current) })
    return () => { cancelled = true }
  }, [hubMode, scope, loadConvs, loadMsgs])

  useEffect(() => {
    if (activeId !== null) void loadMsgs(activeId)
  }, [activeId, loadMsgs])

  // 单一 /api/events 按 kind 过滤（I8/TC-S2-08）：chat:* 事件驱动本会话即时刷新
  useEffect(() => {
    if (!hubMode || !scope) return
    const off = subscribeHubAudit(ev => {
      if (!String(ev.action).startsWith('chat:')) return
      const conv = ev.detail?.conv
      const n = activeRef.current
      if (ev.action === 'chat:message' && Number(conv) === n) void loadMsgs(n)
      else if (ev.action === 'chat:create') void loadConvs()
    })
    const poll = window.setInterval(() => {
      const n = activeRef.current
      if (n !== null) void loadMsgs(n)
    }, 15000)
    return () => { off(); window.clearInterval(poll) }
  }, [hubMode, scope, loadConvs, loadMsgs])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs, loadingMsgs])

  if (!hubMode) {
    return (
      <div className="center-col">
        <div className="panel goal-card">
          <span style={{ color: 'var(--yellow)' }}>💬 对话中心需要 team-hub v2（中枢）</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            启动 <code>node team-hub/server.mjs</code>（:8787）后本面板自动可用；右上角「🧭 中枢」可指定地址
          </span>
        </div>
      </div>
    )
  }

  if (!scope) {
    return (
      <div className="center-col">
        <div className="panel goal-card">
          <span style={{ color: 'var(--yellow)' }}>💬 请先选择具体工作空间</span>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
            对话随空间隔离（scope 分区）。在左侧「工作空间」选择一个具体空间后即可会话（「全部空间」视图不可发消息）
          </span>
        </div>
      </div>
    )
  }

  const active = convs.find(c => c.id === activeId) ?? null

  const startCreate = (): void => {
    setNewTitle(`${scope} 工作空间对话`)
    setCreating(true)
  }

  const doCreate = async (): Promise<void> => {
    const title = newTitle.trim()
    if (!title) { toast('err', '请输入会话标题'); return }
    setCreating(false)
    try {
      const conv = await createChatConversation({ scope: scope as string, title, kind: 'space' })
      setActiveId(conv.id)
      void loadConvs()
      toast('ok', `会话「${conv.title}」已创建`)
    } catch (e) {
      toast('err', `创建失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const send = async (): Promise<void> => {
    const body = draft
    if (!body.trim() || sending) return
    if (body.length > MAX_BODY) { toast('err', `消息超长（上限 ${MAX_BODY} 字符）`); return }
    if (activeId === null) { toast('err', '请先新建/选择一个会话'); return }
    setSending(true)
    try {
      await postChatMessage({ conv: activeId, body, kind: 'text', clientTs: new Date().toISOString() })
      setDraft('') // 成功后清草稿
      await loadMsgs(activeId)
    } catch (e) {
      // 失败：草稿保留（TC-S2-07/10）
      toast('err', `发送失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="center-col">
      <div className="panel goal-card chat-head">
        <span className="tag">💬 对话中心</span>
        <span style={{ fontSize: 12, color: 'var(--text)' }}>
          {scope}
          <span style={{ color: 'var(--muted-2)', fontSize: 11 }}> · {convs.length} 个会话 · team-hub（{hubBase()}）</span>
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <button className="btn primary" onClick={startCreate}>＋ 新会话</button>
        </span>
      </div>

      <div className="chat-layout">
        <div className="chat-conv-list panel">
          <div className="chat-conv-title">会话</div>
          {convs.length === 0 && <div className="chat-empty">暂无会话，点「＋ 新会话」开始</div>}
          {convs.map(c => (
            <div
              key={c.id}
              className={`chat-conv${c.id === activeId ? ' active' : ''}`}
              onClick={() => setActiveId(c.id)}
            >
              <div className="chat-conv-name">{c.title}</div>
              <div className="chat-conv-meta">{c.kind === 'space' ? '空间会话' : c.kind}{c.last_message_at ? ` · ${fmt(c.last_message_at)}` : ' · 空'}</div>
            </div>
          ))}
        </div>

        <div className="chat-main panel">
          {active ? (
            <>
              <div className="chat-main-head">
                <span className="chat-conv-name">{active.title}</span>
                <span className="chip">#{active.id}</span>
                <span className="chip">参与者 {active.participants.length}</span>
              </div>
              <div className="chat-msgs" ref={scrollRef}>
                {loadingMsgs && msgs.length === 0 && <div className="chat-empty">⏳ 加载中…</div>}
                {!loadingMsgs && msgs.length === 0 && <div className="chat-empty">还没有消息，发第一条吧</div>}
                {msgs.map(m => (
                  <div key={m.id} className="chat-row">
                    <div className={`chat-author${m.author === 'general' ? ' me' : ''}`}>{authorLabel(m)} · {fmt(m.createdAt)}</div>
                    <div className={bubbleClass(m)}>{m.body}</div>
                  </div>
                ))}
              </div>
              <div className="chat-composer">
                <textarea
                  value={draft}
                  rows={3}
                  placeholder={'输入消息（Enter 发送 / Shift+Enter 换行；上限 ' + String(MAX_BODY) + ' 字符）…'}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
                  }}
                />
                <div className="chat-composer-bar">
                  <span style={{ fontSize: 10, color: draft.length > MAX_BODY ? '#ff8f8f' : 'var(--muted-2)' }}>{draft.length}/{MAX_BODY}{draft.length > MAX_BODY ? '（超长，发送会被拒绝）' : ''}</span>
                  <button className="btn primary" disabled={sending || draft.trim().length === 0} onClick={() => void send()}>
                    {sending ? '发送中…' : '发送 ➤'}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="chat-empty" style={{ padding: 40, textAlign: 'center' }}>
              选择一个会话，或点「＋ 新会话」创建
            </div>
          )}
        </div>
      </div>

      {creating && (
        <div className="modal-mask" onClick={() => setCreating(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              ＋ 新建会话（{scope}）
              <span className="x" onClick={() => setCreating(false)}>✕</span>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>会话标题（≤200 字符）</label>
                <input value={newTitle} maxLength={200} onChange={e => setNewTitle(e.target.value)} autoFocus />
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setCreating(false)}>取消</button>
              <button className="btn primary" disabled={!newTitle.trim()} onClick={() => void doCreate()}>创建会话</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}