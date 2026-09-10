import { useCallback, useEffect, useRef, useState } from 'react'
import { createChatConversation, fetchChatConversations, fetchChatHealth, fetchChatMessages, fetchChatReplySettings, fetchSpaces, hubBase, postChatMessage, retryChatReply, saveChatReplySettings, subscribeHubAudit, uploadChatAttachment } from '../api'
import type { ChatAttachmentRef, ChatConversation, ChatHealthInfo, ChatMessage, SpaceInfo } from '../types'
import { mergeById } from '../dedupe'
import { aiStateView, canSend, chatHealthView, chatSseLabel, maxSeqOf, replyModelOf, sendFailText, shouldRefillChat } from '../chatUi'
import type { ChatHealthLite, ChatMsgLite } from '../chatUi'
import { toast } from './Toast'

export * from '../chatUi'

const MAX_BODY = 8000 // 与后端 MAX_CHAT_BODY 对齐（TC-S1-12 / TC-S2-10）
const PAGE = 50 // 每页条数（TC-S1-08 后端契约 limit≤200）；「加载更早」用 before 游标翻页（P1-4 / TC-S2-04）

// ── S8（R-3/R-4 决策 F1+G1）：附件客户端护栏（与服务端 CHAT_ATTACH_* 默认值一致；服务端仍做权威校验）──
const ATTACH_MAX_BYTES = 10 * 1024 * 1024 // ≤10MB（CHAT_ATTACH_MAX_BYTES 默认）
const ATTACH_MAX_PER_MSG = 3 // 每消息 ≤3（CHAT_ATTACH_MAX_PER_MSG 默认）
const ATTACH_EXT_BLACKLIST = new Set(['exe', 'dll', 'bin', 'zip', 'rar', '7z', 'tar', 'gz', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'pdf', 'doc', 'docx', 'xls', 'xlsx'])

/** S8：发送前待绑定的附件（file 仅持有引用，不读全文进 draft/body）。 */
interface PendingFile {
  fileName: string
  size: number
  file: File
  /** 上传成功后服务端返回的 staged 附件 id。 */
  id?: number
  /** 上传失败可读原因（chip 标红，可移除；发送按钮禁用直到移除或重传成功）。 */
  error?: string
}

function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

/** S8：消息附件标识数据源（meta.attachments=[{id,fileName,size}]，纯引用）。 */
function attOf(m: ChatMessage): ChatAttachmentRef[] {
  const a = m.meta?.attachments
  if (!Array.isArray(a)) return []
  return a.filter((x): x is ChatAttachmentRef =>
    !!x && typeof x === 'object'
    && Number.isInteger((x as { id?: unknown }).id)
    && typeof (x as { fileName?: unknown }).fileName === 'string'
    && typeof (x as { size?: unknown }).size === 'number'
  )
}

function fmt(ts: string | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

/** 按 id 合并两批升序消息（去重保序；live 合并/加载更早/发送追加共用）。实现见 ../dedupe.ts（P2-3 S6 抽纯函数可测）。 */

function authorLabel(m: ChatMessage): string {
  return m.author === 'general' ? '将军' : m.author
}

/** R-4/S11：author 身份泛化——general = 「我」，其余（含 <scope>-assistant）一律对方侧渲染（TC-S11-01/06）。 */
function isMe(author: string): boolean {
  return author === 'general'
}

/** 是否 AI 回复方（S9/S10 身份 <scope>-assistant 或携带 aiStatus/aiModel 元数据；旧消息兼容按普通气泡，TC-S11-07）。 */
function isBot(m: ChatMessage): boolean {
  const meta = (m.meta ?? null) as Record<string, unknown> | null
  const st = meta?.aiStatus
  const mod = meta?.aiModel
  if (typeof st === 'string' || typeof mod === 'string') return true
  return typeof m.author === 'string' && /-assistant$/.test(m.author)
}

function metaStr(m: ChatMessage, key: string): string | undefined {
  const meta = (m.meta ?? null) as Record<string, unknown> | null
  const v = meta?.[key]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * 会话/空间身份守卫（R-A5 / T-060-M1 / TC-S3-01..06）：判定「发起时快照」相对「当前视图身份」是否已陈旧。
 * 每个异步写回在 await 之后、写状态（setMsgs/setDraft…）之前调用：
 *   - scopeAtCall/convAtCall = 请求发起时读到的身份快照；
 *   - scopeNow/convNow       = 写回时刻 scopeRef.current / activeRef.current（随每次 render 同步 prop/state）。
 * 返回 true = 用户在请求飞行期间切走了会话或空间 → 调用方**仅**复位 loading/sending 等标志并丢弃本次合并，
 * 绝不把旧会话/旧空间数据写进当前视图。比纯 convId 比对更严格：会话 id 全局自增跨空间可能撞号（见 scope effect 注释），
 * 故身份取 (scope, convId) 二元组；scope 未变时退化为纯 convId 比对。 */
function identityStale(scopeAtCall: string | null, convAtCall: number | null, scopeNow: string | null, convNow: number | null): boolean {
  return scopeAtCall !== scopeNow || convAtCall !== convNow
}

/**
 * 对话中心（S2 ChatView + 接线）。数据/写源 = team-hub v2 /api/chat/*（统一 handleWrite + 审计 + 单一 /api/events SSE）。
 * - 实时 = 中枢**单一** /api/events 按 action chat:* 过滤（I8 / TC-S2-08）：本面板只开 1 个 hub EventSource，
 *   不新增第二个 hub 事件连接，也不影响右侧「实时动态」既有 v1 流。
 * - 分页（P1-4 / TC-S2-04）：默认加载最近 PAGE 条；顶部「加载更早」按 before=最旧 id 向前翻页，旧消息可完整回溯。
 * - 会话/空间身份守卫（R-A5 / T-060-M1 / TC-S3-01..06）：loadOlder/send/mergeNewest/loadConvs 等异步写回在
 *   await 返回后、写 setMsgs/setDraft 等状态前，比对「发起时快照 (scope, convId)」与 scopeRef/activeRef 当前值；
 *   不匹配（用户已切走会话/空间）= 仅复位 loading/sending 等标志并丢弃本次合并，绝不清/改当前视图（防切会话/切空间竞态串显）。
 * - 渲染安全（S2 AC5 / I5 / TC-S2-09/11）：正文只做纯文本（white-space:pre-wrap + React 文本节点），kind 白名单外按文本兜底，
 *   全程无 dangerouslySetInnerHTML，任何 <img onerror>/<script>/[x](javascript:) 都只是文本。
 * - 失败路径（S2 AC6 / TC-S2-07/10）：中枢不可达/写失败 → toast 错误且草稿不丢；EventSource 原生自动重连 + 15s 轮询兜底。
 */
export function ChatView({ scope, hubMode, spaces, onPickScope }: {
  scope: string | null
  hubMode: boolean
  /** S7（R-2）：可选空间列表（「全部空间」视图选空间入口；缺省时组件自行 fetchSpaces）。 */
  spaces?: SpaceInfo[]
  /** S7（R-2）：点选某工作空间后回调（App 传 selectScope）。 */
  onPickScope?: (scopeId: string) => void
}): React.JSX.Element {
  const [convs, setConvs] = useState<ChatConversation[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [msgs, setMsgs] = useState<ChatMessage[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [retryingId, setRetryingId] = useState<number | null>(null) // R-4/S11：正在重试的消息 id
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<number | null>(null)
  const scopeRef = useRef<string | null>(null) // 空间身份镜像（R-A5 守卫用）：render 期同步 scope prop
  const stickRef = useRef(true) // 是否贴底（新消息自动滚到底部；用户上翻读历史时不抢滚动）
  activeRef.current = activeId
  scopeRef.current = scope
  // S7（R-1/R-2 决策 B1）：对话健康聚合（GET /api/chat/health 30s 轮询 + 发送/重试/设置后即时刷新；灰态=端点缺失不误导）
  const [health, setHealth] = useState<ChatHealthInfo | null>(null)
  const [healthNote, setHealthNote] = useState<string | null>(null)
  // S7（R-1 决策 D-4）：回复设置弹窗（每空间 AI 开关 enabled 必含；model/identity/systemHint 可选）
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<{ enabled: boolean; model: string; identity: string; systemHint: string } | null>(null)
  // S8（R-3 决策 F1 附件）：composer 附件（📎 选择 → 客户端预检 → 上传 staged → 发送携带 attachmentIds）
  const [attachFiles, setAttachFiles] = useState<PendingFile[]>([])
  const [attachBusy, setAttachBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // S7（R-2）：空间选择入口的列表兜底（props.spaces 未提供/为空时组件自行拉取）
  const [localSpaces, setLocalSpaces] = useState<SpaceInfo[]>([])
  const [localSpacesErr, setLocalSpacesErr] = useState('')
  // P2-6：SSE 连接状态与缺口补齐计数（断线恢复可观测；缺口判据见 chatUi.shouldRefillChat）
  const [sseStatus, setSseStatus] = useState<{ state: 'open' | 'reconnected' | 'reconnecting' | 'closed'; opens: number }>({ state: 'open', opens: 0 })
  const [seqWatermark, setSeqWatermark] = useState(0)
  const [refillCount, setRefillCount] = useState(0)
  const seqWatermarkRef = useRef(0)
  const refillCountRef = useRef(0)

  const loadConvs = useCallback(async (): Promise<void> => {
    const scopeAtCall = scope
    try {
      const list = await fetchChatConversations(scope)
      // 空间身份守卫（R-A5）：await 期间空间已切走 → 旧空间会话列表/自动选中不回写当前视图
      if (scopeAtCall !== scopeRef.current) return
      setConvs(list)
      setActiveId(cur => (cur !== null && list.some(c => c.id === cur) ? cur : (list[0]?.id ?? null)))
    } catch (e) {
      if (scopeAtCall === scopeRef.current) toast('err', `会话列表加载失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [scope])

  // S7（R-2）：「全部空间」视图拉取空间列表（props.spaces 为空时兜底；成功后缓存 localSpaces 供切换回来看）
  useEffect(() => {
    if (!hubMode || scope) return
    let cancelled = false
    if (!(spaces && spaces.length > 0) && localSpaces.length === 0 && localSpacesErr === '') {
      setLocalSpacesErr('loading')
      fetchSpaces()
        .then(list => { if (!cancelled) { setLocalSpaces(list); setLocalSpacesErr('') } })
        .catch((e: unknown) => { if (!cancelled) setLocalSpacesErr(e instanceof Error ? e.message : String(e)) })
    }
    return () => { cancelled = true }
  }, [hubMode, scope, spaces, localSpaces.length, localSpacesErr])

  // S7（R-1/B1）：对话健康状态拉取（空间身份守卫：await 返回后 scope 已切走 → 丢弃）
  const loadHealth = useCallback(async (): Promise<void> => {
    const sc = scopeRef.current
    if (!hubMode || !sc) return
    try {
      const h = await fetchChatHealth(sc)
      if (scopeRef.current !== sc) return
      setHealth(h)
      setHealthNote(null)
    } catch (e) {
      if (scopeRef.current !== sc) return
      setHealth(null)
      setHealthNote('健康端点不可用（不影响收发）' + (e instanceof Error ? '：' + e.message : ''))
    }
  }, [hubMode])

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

  /** 拉最新一页并**就地合并**进当前列表（同 id 覆盖 meta 流转、新消息追加，不冲掉已加载的更早历史）。 */
  const mergeNewest = useCallback(async (): Promise<void> => {
    const scopeAtCall = scopeRef.current
    const convAtCall = activeRef.current
    if (convAtCall === null) return
    try {
      const list = await fetchChatMessages(convAtCall, { limit: PAGE })
      // 会话/空间身份守卫（R-A5 / TC-S3-06）：轮询/SSE 触发时身份正确、返回时已切走的「第二类竞态」同样丢弃
      if (identityStale(scopeAtCall, convAtCall, scopeRef.current, activeRef.current)) return
      setMsgs(prev => {
        if (prev.length === 0) return list
        // 就地合并最新一页（T-100-M1 / T-101-F1 修复）：同 id 消息以最新版本覆盖、新消息追加——
        // AI 三态（awaiting→replied/failed）是**同一条源消息的 meta 更新**，只「追加更新 id」会漏掉它，
        // 导致气泡停在「等待回复/回复失败」不实时流转。mergeById(prev, list) 保序去重、list 覆盖同 id；
        // prev 中早于最新一页的更早历史（loadOlder 已加载部分）原样保留。
        return mergeById(prev, list)
      })
    } catch {
      /* 后台轮询/事件刷新失败静默（下次轮询再试） */
    }
  }, [])

  // 单一 /api/events 按 kind 过滤（I8 / TC-S2-08）：chat:* 事件驱动本会话即时刷新；15s 轮询兜底断线窗口
  // P2-6 增强：① 上报 SSE 连接状态（可观测）；② 用**未过滤全量事件流**的 seq 水位检出缺口 → 立即重拉补齐
  // （audit seq 全局单调，跳变即漏帧；只靠 15s 轮询会让 AI 三态流转延迟可见）。
  useEffect(() => {
    if (!hubMode || !scope) return
    const off = subscribeHubAudit(ev => {
      // 缺口检测必须先于 chat 过滤：seq 水位来自全量流，若只看 chat:* 会把其它 action 的丢帧判成连续
      if (shouldRefillChat(seqWatermarkRef.current, [ev.seq])) {
        refillCountRef.current += 1
        setRefillCount(refillCountRef.current)
        const n = activeRef.current
        if (n !== null) void mergeNewest()
        void loadConvs()
      }
      // 水位推进用 chatUi.maxSeqOf 统一口径（忽略非法值；只前进不回退）
      const nextWatermark = maxSeqOf([seqWatermarkRef.current, ev.seq])
      if (nextWatermark !== seqWatermarkRef.current) {
        seqWatermarkRef.current = nextWatermark
        setSeqWatermark(nextWatermark)
      }
      if (!String(ev.action).startsWith('chat:')) return
      if (ev.scope !== scope) return // 空间身份守卫（R-A5）：只响应当前空间事件（跨空间会话 id 可能撞号）
      const conv = ev.detail?.conv
      const n = activeRef.current
      if (ev.action === 'chat:message' && Number(conv) === n) void mergeNewest()
      else if (ev.action === 'chat:create') void loadConvs()
    }, { scope })
    void loadHealth() // 进入空间即刷健康（守护/开关/模型/最近失败）
    const poll = window.setInterval(() => {
      const n = activeRef.current
      if (n !== null) void mergeNewest()
      void loadConvs() // 刷新会话列表（last_message_at / updatedAt 排序，轻量）
      void loadHealth() // 健康轮询（同 15s 节拍）
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
    const scopeAtCall = scope // 发起时身份快照（R-A5 / TC-S3-02/04）
    const convAtCall = activeId
    setLoadingOlder(true)
    const el = scrollRef.current
    const prevH = el?.scrollHeight ?? 0
    try {
      const older = await fetchChatMessages(convAtCall, { before: oldest, limit: PAGE })
      // 会话/空间身份守卫：await 期间已切走 → 丢弃本次合并（不写 msgs/hasOlder/滚动；finally 仍复位 loadingOlder）
      if (identityStale(scopeAtCall, convAtCall, scopeRef.current, activeRef.current)) return
      setMsgs(prev => mergeById(older, prev))
      setHasOlder(older.length === PAGE)
      // 顶部插入内容 → 滚动位置下移 = 高度增量（rAF 在渲染后执行）
      requestAnimationFrame(() => {
        const now = scrollRef.current
        if (now && prevH > 0) now.scrollTop += now.scrollHeight - prevH
      })
    } catch (e) {
      if (!identityStale(scopeAtCall, convAtCall, scopeRef.current, activeRef.current)) {
        toast('err', `加载更早消息失败：${e instanceof Error ? e.message : String(e)}`)
      }
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
    // S7（R-1/R-2）：死路卡 →「选择工作空间开始对话」入口（复用 /api/spaces；点选经 onPickScope → App.selectScope）
    const spaceList = spaces && spaces.length > 0 ? spaces : localSpaces
    return (
      <div className="center-col">
        <div className="panel goal-card" style={{ maxWidth: 620 }}>
          <span style={{ color: 'var(--yellow)' }}>💬 选择工作空间开始对话</span>
          <span style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.8, display: 'block', marginTop: 6 }}>
            对话随工作空间隔离：回复方会依据该空间的绑定仓库内容作答，也可随消息上传文本文件作为上下文。
            从下方选择一个工作空间即可开始对话。
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
            {spaceList.map(s => (
              <button key={s.id} type="button" className="btn primary"
                title={s.localDir ? '本地仓库：' + s.localDir : ''}
                onClick={() => onPickScope ? onPickScope(s.id) : undefined}>
                {s.name || s.id}{s.localDir ? ' 📁' : ''}
              </button>
            ))}
            {spaceList.length === 0 && (
              <span style={{ fontSize: 11, color: 'var(--muted-2)' }}>
                {localSpacesErr && localSpacesErr !== 'loading' ? '空间列表加载失败：' + localSpacesErr : '正在加载工作空间列表…（若为空请先在左侧创建/绑定工作空间）'}
              </span>
            )}
          </div>
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
    const scopeAtCall = scope
    setCreating(false)
    try {
      const conv = await createChatConversation({ scope: scopeAtCall as string, title, kind: 'space' })
      // 空间身份守卫（R-A5 / J5-A）：await 期间空间已切走 → 不把旧空间新建会话设为当前（跨空间撞号会污染新空间视图）
      if (scopeAtCall !== scopeRef.current) return
      setActiveId(conv.id)
      void loadConvs()
      toast('ok', `会话「${conv.title}」已创建`)
    } catch (e) {
      toast('err', `创建失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // ── S7（R-1，B1）/ P2-6：健康状态呈现（灰/绿/黄/红；红态 = 最近失败可行动文案，黄态 = 前提缺失修复动作，灰态 = 端点缺失不误导）──
  // 判定逻辑已抽到 chatUi.chatHealthView（可单测：模型不可用/超时/守护离线的文案与优先级），此处只取用。
  const healthDot = chatHealthView(health as ChatHealthLite | null, healthNote ?? '')

  // ── S7（R-1，D-4）：回复设置弹窗（enabled 必含且默认开；model/identity/systemHint 可选；保存后健康即时刷新）──
  const openSettings = async (): Promise<void> => {
    if (!scope) return
    setSettingsOpen(true)
    setSettingsDraft(null)
    setSettingsSaving(true)
    try {
      const cur = await fetchChatReplySettings(scope)
      if (scopeRef.current !== scope) return
      setSettingsDraft({ enabled: cur.enabled, model: cur.model ?? '', identity: cur.identity ?? '', systemHint: cur.systemHint ?? '' })
    } catch (e) {
      if (scopeRef.current !== scope) return
      toast('err', '回复设置读取失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      if (scopeRef.current === scope) setSettingsSaving(false)
    }
  }
  const saveSettings = async (): Promise<void> => {
    if (!scope || !settingsDraft) return
    setSettingsSaving(true)
    try {
      await saveChatReplySettings({
        scope,
        enabled: settingsDraft.enabled,
        model: settingsDraft.model.trim() || undefined,
        identity: settingsDraft.identity.trim() || undefined,
        systemHint: settingsDraft.systemHint.trim() || undefined,
      })
      toast('ok', settingsDraft.enabled ? 'AI 回复已开启：新消息将进入回复队列' : 'AI 回复已关闭：新消息不再进入回复队列（人-人消息不受影响）')
      setSettingsOpen(false)
      void loadHealth()
    } catch (e) {
      toast('err', '回复设置保存失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setSettingsSaving(false)
    }
  }

  // ── S8（R-3）：📎 附件（选择 → 客户端预检 → 上传 staged；内容绝不进 draft/body，仅当次回复上下文）──
  const precheckFile = (f: File): string | null => {
    const dot = f.name.lastIndexOf('.')
    const ext = dot >= 0 ? f.name.slice(dot + 1).toLowerCase() : ''
    if (ext.length === 0) return '无法识别文件类型（无扩展名）：' + f.name + '（仅文本类 UTF-8 文件可作回复上下文）'
    if (ATTACH_EXT_BLACKLIST.has(ext)) return '扩展名类型不支持作为上下文：.' + ext + '（仅文本类 UTF-8 文件可作回复上下文）'
    if (f.size > ATTACH_MAX_BYTES) return '附件超大小（上限 10MB）：' + f.name
    return null
  }
  const pickAttachFiles = async (list: FileList | null): Promise<void> => {
    if (!list || list.length === 0 || !scope) return
    const scopeNow = scope
    const files = Array.from(list)
    const room = Math.max(0, ATTACH_MAX_PER_MSG - attachFiles.length)
    const picked: PendingFile[] = []
    for (const f of files.slice(0, room)) {
      const pre = precheckFile(f)
      if (pre) { toast('err', pre); continue }
      picked.push({ fileName: f.name, size: f.size, file: f })
    }
    if (files.length > room) toast('err', '附件数量超限（每消息至多 ' + ATTACH_MAX_PER_MSG + ' 个），已忽略 ' + String(files.length - room) + ' 个')
    if (picked.length === 0) return
    setAttachFiles(cur => [...cur, ...picked])
    setAttachBusy(true)
    try {
      const results = await Promise.all(picked.map(async (a): Promise<{ fileName: string; id?: number; error?: string }> => {
        try {
          const ref = await uploadChatAttachment({ scope: scopeNow, fileName: a.fileName, content: a.file })
          return { fileName: a.fileName, id: ref.id }
        } catch (e) {
          return { fileName: a.fileName, error: e instanceof Error ? e.message : String(e) }
        }
      }))
      if (scopeRef.current !== scopeNow) {
        setAttachFiles([]) // 上传期间已切换空间：staged 孤儿由服务端 TTL 清理，不绑当前会话
        toast('err', '上传期间已切换工作空间，附件已取消（可重新选择）')
        return
      }
      setAttachFiles(cur => cur.map(a => {
        const hit = results.find(r => r.fileName === a.fileName)
        return hit ? { ...a, id: hit.id, error: hit.error } : a
      }))
      for (const r of results) {
        if (r.error) toast('err', '附件「' + r.fileName + '」上传失败：' + r.error)
      }
    } finally {
      setAttachBusy(false)
    }
  }
  const removeAttach = (i: number): void => setAttachFiles(cur => cur.filter((_, j) => j !== i))

  const send = async (): Promise<void> => {
    const body = draft
    if (!body.trim() || sending || attachBusy) return
    if (body.length > MAX_BODY) {
      toast('err', `消息超长（上限 ${MAX_BODY} 字符）`)
      return
    }
    if (activeId === null) {
      toast('err', '请先新建/选择一个会话')
      return
    }
    // S8（R-3）：附件未就绪（上传中/失败）→ 拦截并提示，不静默发送
    const notReady = attachFiles.find(a => a.id === undefined || a.error !== undefined)
    if (notReady) {
      toast('err', `附件「${notReady.fileName}」${notReady.error ? '上传失败：' + notReady.error : '尚未上传完成'}，请先移除或等待上传成功后再发送`)
      return
    }
    const scopeAtCall = scope // 发起时身份快照（R-A5 / TC-S3-01/03/04）
    const convAtCall = activeId
    const attachmentIds = attachFiles.map(a => a.id as number)
    setSending(true)
    try {
      const msg = await postChatMessage({
        conv: convAtCall,
        body,
        kind: 'text',
        clientTs: new Date().toISOString(),
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      })
      // 会话/空间身份守卫：await 期间已切走 → 不清当前草稿、不合并、不刷新列表（消息已入库，切回发起会话可见）
      if (identityStale(scopeAtCall, convAtCall, scopeRef.current, activeRef.current)) return
      setDraft('') // 成功后清草稿
      setAttachFiles([]) // S8：附件已随消息绑定，清槽
      stickRef.current = true
      setMsgs(prev => mergeById(prev, [msg])) // 气泡即时出现（无整页刷新）
      void loadConvs() // 会话 last_message_at/排序即时更新（轻量）
      void loadHealth() // 消息入队（可能产生失败/回复）→ 健康条即时刷新
    } catch (e) {
      if (!identityStale(scopeAtCall, convAtCall, scopeRef.current, activeRef.current)) {
        // 失败：草稿与附件槽均保留（TC-S2-07/10 / TC-S8-07），toast 错误
        // P2-6：文案由 chatUi.sendFailText 统一产出（区分未授权/中枢不可达，并明示「草稿已保留」）
        toast('err', sendFailText(e))
      }
    } finally {
      setSending(false)
    }
  }

  /** R-4/S11：重试一条失败消息（TC-S11-03）——服务端 CAS 重置 failed→awaiting 并重新入队；
   *  本地用返回值**原位替换**该消息（不新增气泡）。会话/空间身份守卫同其它写回。 */
  const doRetry = async (m: ChatMessage): Promise<void> => {
    const scopeAtCall = scope
    const convAtCall = activeId
    if (retryingId === m.id) return
    setRetryingId(m.id)
    try {
      const updated = await retryChatReply(m.id)
      if (identityStale(scopeAtCall, convAtCall, scopeRef.current, activeRef.current)) return
      setMsgs(prev => prev.map(x => (x.id === updated.id ? updated : x)))
      toast('ok', '已重新提交回复，等待 AI 回复…')
      void loadHealth() // 重试后健康条即时刷新（失败态→等待态）
    } catch (e) {
      if (!identityStale(scopeAtCall, convAtCall, scopeRef.current, activeRef.current)) {
        toast('err', `重试失败：${e instanceof Error ? e.message : String(e)}`)
      }
    } finally {
      setRetryingId(null)
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
        <span
          className="chat-health"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 10, cursor: 'pointer', flex: 'none' }}
          title={healthDot.title}
          onClick={() => void loadHealth()}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: healthDot.color, display: 'inline-block', flex: 'none' }} />
          <span style={{ fontSize: 11, color: healthDot.color }}>{healthDot.label}</span>
        </span>
        {/* P2-6：实时连接状态与缺口补齐计数（断线恢复可观测；断开时仍可手动刷新）*/}
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 8, flex: 'none', cursor: 'pointer' }}
          title={'实时通道：' + chatSseLabel(sseStatus.state, sseStatus.opens).text + '（事件水位 seq=' + String(seqWatermark) + (refillCount > 0 ? '，已自动补齐 ' + String(refillCount) + ' 次' : '') + '）'}
          onClick={() => { const n = activeId; if (n !== null) void mergeNewest(); void loadConvs() }}
        >
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: chatSseLabel(sseStatus.state, sseStatus.opens).color, display: 'inline-block', flex: 'none' }} />
          <span style={{ fontSize: 10.5, color: 'var(--muted-2)' }}>
            {chatSseLabel(sseStatus.state, sseStatus.opens).text}
            {refillCount > 0 ? ' · 补齐 ' + String(refillCount) : ''}
          </span>
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          <button className="btn ghost" title="AI 回复设置（开关/模型/身份/systemHint）" onClick={() => void openSettings()}>⚙ 回复设置</button>
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
                {msgs.map(m => {
                  const me = isMe(m.author)
                  const bot = isBot(m)
                  const st = metaStr(m, 'aiStatus')
                  // P2-6：回复模型在**回复行**的 meta 上（服务端 postAiReply 写 {replyTo, aiModel}），
                  // 源消息 meta 只有 aiStatus/repliedAt/replyMsg → 必须回到列表按 replyMsg 找，否则永远显示不出模型。
                  const aiModel = (st === 'replied' ? replyModelOf(m as ChatMsgLite, msgs as ChatMsgLite[]) : null) ?? metaStr(m, 'aiModel')
                  // P2-6：三态文案由 chatUi.aiStateView 统一产出（失败原因也走它，避免组件内联文案与单测断言漂移）
                  const aiView = aiStateView(m as ChatMsgLite, 'general', msgs as ChatMsgLite[])
                  return (
                    <div key={m.id} className={`chat-row${me ? ' me-row' : ''}${bot ? ' bot-row' : ''}`}>
                      <div className={`chat-author${me ? ' me' : ''}`}>
                        {authorLabel(m)}
                        {bot && <span className="chip" style={{ marginLeft: 4 }} title="AI 回复">🤖</span>}
                        {bot && aiModel && <span className="chip" style={{ marginLeft: 4 }} title="AI 回复模型">{aiModel}</span>}
                        <span style={{ color: 'var(--muted-2)', fontSize: 11 }}> · {fmt(m.createdAt)}</span>
                      </div>
                      <div className={me ? 'chat-bubble me' : 'chat-bubble'}>
                        {m.body}
                      </div>
                      {attOf(m).length > 0 && (
                        <div className="chat-att-labels" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2, justifyContent: me ? 'flex-end' : 'flex-start', maxWidth: '78%' }}>
                          {attOf(m).map(a => (
                            <span key={a.id} className="chip" title={'附件：' + a.fileName + '（' + fmtSize(a.size) + '）'} style={{ fontSize: 10, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              📎 {a.fileName}（{fmtSize(a.size)}）
                            </span>
                          ))}
                        </div>
                      )}
                      {aiView?.state === 'awaiting' && (
                        <div className="chat-ai-state pending">
                          <span className="chat-ai-spinner">◌</span> AI 正在回复…（提交于 {fmt(m.createdAt)}）
                        </div>
                      )}
                      {aiView?.state === 'replied' && (
                        <div className="chat-ai-state done">✓ AI 已回复{aiModel ? `（${aiModel}）` : ''}</div>
                      )}
                      {aiView?.state === 'failed' && (
                        <div className="chat-ai-state failed">
                          ❌ {aiView.text}
                          <button
                            className="btn small"
                            disabled={retryingId === m.id}
                            onClick={() => void doRetry(m)}
                            style={{ marginLeft: 8 }}
                          >
                            {retryingId === m.id ? '重试中…' : '↻ 重试'}
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="chat-composer">
                <textarea
                  value={draft}
                  rows={3}
                  placeholder={'输入消息（Enter 发送 / Shift+Enter 换行；上限 ' + String(MAX_BODY) + ' 字符）… 可点「📎 附件」上传文本文件作为本次回复上下文'}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void send()
                    }
                  }}
                />
                {attachFiles.length > 0 && (
                  <div className="chat-attach-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 6 }}>
                    {attachFiles.map((a, i) => (
                      <span key={i} className="chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, maxWidth: '100%' }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📎 {a.fileName}（{fmtSize(a.size)}）</span>
                        {a.id === undefined && a.error === undefined && <span style={{ color: 'var(--yellow)', fontSize: 10 }}>上传中…</span>}
                        {a.id === undefined && a.error !== undefined && <span style={{ color: 'var(--red)', fontSize: 10 }} title={a.error}>⚠ 失败</span>}
                        {a.id !== undefined && <span style={{ color: 'var(--green)', fontSize: 10 }}>✓</span>}
                        <button type="button" className="chip-x" disabled={attachBusy} style={{ padding: '0 6px' }} title="移除附件"
                          onClick={() => removeAttach(i)}>✕</button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="chat-composer-bar">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    style={{ display: 'none' }}
                    onChange={e => { void pickAttachFiles(e.target.files); e.target.value = '' }}
                  />
                  <button type="button" className="btn ghost" disabled={attachBusy || sending}
                    title="添加文本文件作为本次回复上下文（≤10MB、每消息至多 3 个、仅文本类 UTF-8；黑名单类型/二进制会被拒绝）"
                    onClick={() => fileInputRef.current?.click()}>
                    {attachBusy ? '⏳ 上传中…' : '📎 附件'}
                  </button>
                  <span style={{ fontSize: 10, color: draft.length > MAX_BODY ? '#ff8f8f' : 'var(--muted-2)' }}>
                    {draft.length}/{MAX_BODY}
                    {draft.length > MAX_BODY ? '（超长，发送会被拒绝）' : ''}
                  </span>
                  <button className="btn primary"
                    title={attachFiles.some(a => a.id === undefined || a.error !== undefined) ? '附件未就绪：请等待上传完成或移除失败附件' : undefined}
                    disabled={sending || attachBusy || !canSend(draft, attachFiles.filter(a => a.id !== undefined && a.error === undefined).length) || attachFiles.some(a => a.id === undefined || a.error !== undefined)}
                    onClick={() => void send()}>
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

      {settingsOpen && scope && (
        <div className="modal-mask" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              ⚙ AI 回复设置（{scope}）
              <span className="x" onClick={() => setSettingsOpen(false)}>✕</span>
            </div>
            <div className="modal-body">
              {settingsDraft === null ? (
                <div className="chat-empty" style={{ padding: '18px 0' }}>{settingsSaving ? '⏳ 读取中…' : '设置不可用（读取失败）'}</div>
              ) : (
                <>
                  <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, cursor: 'pointer', lineHeight: 1.6 }}>
                    <input type="checkbox" checked={settingsDraft.enabled} style={{ marginTop: 2 }}
                      onChange={e => setSettingsDraft(d => (d ? { ...d, enabled: e.target.checked } : d))} />
                    <span>
                      AI 回复{settingsDraft.enabled ? '（已开启）' : '（已关闭）'}：开启后发送消息会进入 AI 回复队列；关闭时人-人消息正常、零出站
                    </span>
                  </label>
                  <div className="field">
                    <label>模型（可选；留空 = 空间 agent_models / 守护默认）</label>
                    <input value={settingsDraft.model} maxLength={200} placeholder="如 deepseek-chat"
                      onChange={e => setSettingsDraft(d => (d ? { ...d, model: e.target.value } : d))} />
                  </div>
                  <div className="field">
                    <label>回复身份（可选；默认 {scope}-assistant）</label>
                    <input value={settingsDraft.identity} maxLength={200} placeholder={scope + '-assistant'}
                      onChange={e => setSettingsDraft(d => (d ? { ...d, identity: e.target.value } : d))} />
                  </div>
                  <div className="field">
                    <label>systemHint（可选；≤2000 字符，作为助手行为设定）</label>
                    <textarea rows={3} value={settingsDraft.systemHint} maxLength={2000}
                      onChange={e => setSettingsDraft(d => (d ? { ...d, systemHint: e.target.value } : d))} />
                  </div>
                </>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setSettingsOpen(false)}>取消</button>
              <button className="btn primary" disabled={settingsSaving || settingsDraft === null} onClick={() => void saveSettings()}>
                {settingsSaving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

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
