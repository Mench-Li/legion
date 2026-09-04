import { useCallback, useEffect, useRef, useState } from 'react'
import { createChatConversation, fetchChatConversations, fetchChatMessages, hubBase, postChatMessage, subscribeHubAudit } from '../api'
import type { ChatConversation, ChatMessage } from '../types'
import { toast } from './Toast'

const MAX_BODY = 8000 // 与后端 MAX_CHAT_BODY 对齐（TC-S1-12 / TC-S2-10）
const PAGE = 50 // 每页条数（TC-S1-08 后端契约 limit≤200）；「加载更早」用 before 游标翻页（P1-4 / TC-S2-04）

function fmt(ts: string | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

/** 按 id 合并两批升序消息（去重保序；live 合并/加载更早/发送追加共用）。 */
function mergeById(a: ChatMessage[], b: ChatMessage[]): ChatMessage[] {
  const map = new Map<number, ChatMessage>()
  for (const m of a) map.set(m.id, m)
  for (const m of b) map.set(m.id, m)
  return [...map.values()].sort((x, y) => x.id - y.id)
}

function authorLabel(m: ChatMessage): string {
  return m.author === 'general' ? '将军' : m.author
}

/**
 * 对话中心（S2 ChatView + 接线）。数据/写源 = team-hub v2 /api/chat/*（统一 handleWrite + 审计 + 单一 /api/events SSE）。
 * - 实时 = 中枢**单一** /api/events 按 action chat:* 过滤（I8 / TC-S2-08）：本面板只开 1 个 hub EventSource，
 *   不新增第二个 hub 事件连接，也不影响右侧「实时动态」既有 v1 流。
 * - 分页（P1-4 / TC-S2-04）：默认加载最近 PAGE 条；顶部「加载更早」按 before=最旧 id 向前翻页，旧消息可完整回溯。
 * - 渲染安全（S2 AC5 / I5 / TC-S2-09/11）：正文只做纯文本（white-space:pre-wrap + React 文本节点），kind 白名单外按文本兜底，
 *   全程无 dangerouslySetInnerHTML，任何 <img onerror>/<script>/[x](javascript:) 都只是文本。
 * - 失败路径（S2 AC6 / TC-S2-07/10）：中枢不可达/写失败 → toast 错误且草稿不丢；EventSource 原生自动重连 + 15s 轮询兜底。
 */
export function ChatView({ scope, hubMode }: { scope: string | null; hubMode: boolean }): React.JSX.Element {
  const [convs, setConvs] = useState<ChatConversation[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [msgs, setMsgs] = useState<ChatMessage[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<number | null>(null)
  const stickRef = useRef(true) // 是否贴底（新消息自动滚到底部；用户上翻读历史时不抢滚动）
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

  // 会话切换 → 清空并拉最近 PAGE 条（TC-S2-05：不串显上一会话内容）
  useEffect(() => {
    if (activeId === null) {
      setMsgs([])
      setHasOlder(false)
      setLoadingMsgs(false)
      return
    }
    let cancelled = false
    setMsgs([])
    setHasOlder(false)
    setLoadingMsgs(true)
    stickRef.current = true
    fetchChatMessages(activeId, { limit: PAGE })
      .then(list => {
        if (cancelled) return
        setMsgs(list)
        setHasOlder(list.length === PAGE) // 正好一页 = 可能还有更早
      })
      .catch((e: unknown) => {
        if (cancelled) return
        toast('err', `消息加载失败：${e instanceof Error ? e.message : String(e)}`)
      })
      .finally(() => {
        if (!cancelled) setLoadingMsgs(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeId])

  // hub 模式 + scope：清空并加载会话列表（scope 变化后不沿用旧空间会话——会话 id 全局自增跨空间可能撞号）
  useEffect(() => {
    if (!hubMode || !scope) {
      setConvs([])
      setMsgs([])
      setHasOlder(false)
      setActiveId(null)
      return
    }
    let cancelled = false
    setConvs([])
    setMsgs([])
    setActiveId(null)
    void loadConvs().then(() => {
      // loadConvs 完成即选中首个会话；消息由 activeId effect 拉取
      if (cancelled) return
      setLoadingMsgs(false)
    })
    return () => {
      cancelled = true
    }
  }, [hubMode, scope, loadConvs])

  /** 拉最新一页并**合并**进当前列表（只追加更新的消息，不冲掉已加载的更早历史）。 */
  const mergeNewest = useCallback(async (convId: number): Promise<void> => {
    try {
      const list = await fetchChatMessages(convId, { limit: PAGE })
      setMsgs(prev => {
        if (prev.length === 0) return list
        const maxId = prev[prev.length - 1].id
        const newer = list.filter(m => m.id > maxId)
        return newer.length > 0 ? mergeById(prev, newer) : prev
      })
    } catch {
      /* 后台轮询/事件刷新失败静默（下次轮询再试） */
    }
  }, [])

  // 单一 /api/events 按 kind 过滤（I8 / TC-S2-08）：chat:* 事件驱动本会话即时刷新；15s 轮询兜底断线窗口
  useEffect(() => {
    if (!hubMode || !scope) return
    const off = subscribeHubAudit(ev => {
      if (!String(ev.action).startsWith('chat:')) return
      const conv = ev.detail?.conv
      const n = activeRef.current
      if (ev.action === 'chat:message' && Number(conv) === n) void mergeNewest(n)
      else if (ev.action === 'chat:create') void loadConvs()
    })
    const poll = window.setInterval(() => {
      const n = activeRef.current
      if (n !== null) void mergeNewest(n)
      void loadConvs() // 刷新会话列表（last_message_at / updatedAt 排序，轻量）
    }, 15000)
    return () => {
      off()
      window.clearInterval(poll)
    }
  }, [hubMode, scope, loadConvs, mergeNewest])

  // 贴底自动滚动（新消息/新会话）；用户上翻读历史时不抢滚动（stickRef 由 onScroll 维护）
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [msgs, loadingMsgs, loadingOlder])

  /** 加载更早一页（P1-4 / TC-S2-04）：before = 当前最旧消息 id，向前翻页并保持阅读位置。 */
  const loadOlder = async (): Promise<void> => {
    const oldest = msgs[0]?.id
    if (activeId === null || oldest === undefined || loadingOlder) return
    setLoadingOlder(true)
    const el = scrollRef.current
    const prevH = el?.scrollHeight ?? 0
    try {
      const older = await fetchChatMessages(activeId, { before: oldest, limit: PAGE })
      setMsgs(prev => mergeById(older, prev))
      setHasOlder(older.length === PAGE)
      // 顶部插入内容 → 滚动位置下移 = 高度增量（rAF 在渲染后执行）
      requestAnimationFrame(() => {
        const now = scrollRef.current
        if (now && prevH > 0) now.scrollTop += now.scrollHeight - prevH
      })
    } catch (e) {
      toast('err', `加载更早消息失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoadingOlder(false)
    }
  }

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
    if (!title) {
      toast('err', '请输入会话标题')
      return
    }
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
    if (body.length > MAX_BODY) {
      toast('err', `消息超长（上限 ${MAX_BODY} 字符）`)
      return
    }
    if (activeId === null) {
      toast('err', '请先新建/选择一个会话')
      return
    }
    setSending(true)
    try {
      const msg = await postChatMessage({ conv: activeId, body, kind: 'text', clientTs: new Date().toISOString() })
      setDraft('') // 成功后清草稿
      stickRef.current = true
      setMsgs(prev => mergeById(prev, [msg])) // 气泡即时出现（无整页刷新）
      void loadConvs() // 会话 last_message_at/排序即时更新（轻量）
    } catch (e) {
      // 失败：草稿保留（TC-S2-07/10），toast 错误
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
              <div className="chat-conv-meta">
                {c.kind === 'space' ? '空间会话' : c.kind}
                {c.last_message_at ? ` · ${fmt(c.last_message_at)}` : ' · 空'}
              </div>
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
              {hasOlder && (
                <div className="chat-older-bar">
                  <button className="btn ghost" disabled={loadingOlder} onClick={() => void loadOlder()}>
                    {loadingOlder ? '⏳ 加载中…' : `↑ 加载更早消息（已显示最近 ${msgs.length} 条）`}
                  </button>
                </div>
              )}
              <div
                className="chat-msgs"
                ref={scrollRef}
                onScroll={e => {
                  const el = e.currentTarget
                  stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
                }}
              >
                {loadingMsgs && msgs.length === 0 && <div className="chat-empty">⏳ 加载中…</div>}
                {!loadingMsgs && msgs.length === 0 && <div className="chat-empty">还没有消息，发第一条吧</div>}
                {msgs.map(m => (
                  <div key={m.id} className="chat-row">
                    <div className={`chat-author${m.author === 'general' ? ' me' : ''}`}>{authorLabel(m)} · {fmt(m.createdAt)}</div>
                    <div className={m.author === 'general' ? 'chat-bubble me' : 'chat-bubble'}>{m.body}</div>
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
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
                <div className="chat-composer-bar">
                  <span style={{ fontSize: 10, color: draft.length > MAX_BODY ? '#ff8f8f' : 'var(--muted-2)' }}>
                    {draft.length}/{MAX_BODY}
                    {draft.length > MAX_BODY ? '（超长，发送会被拒绝）' : ''}
                  </span>
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
