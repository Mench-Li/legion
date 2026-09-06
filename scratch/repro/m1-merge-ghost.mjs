// M1 repro: ChatView mergeNewest 只增不覆盖 → 源消息 awaiting→replied/failed 的 meta 流转本地不实时
// 方法: 从 workbench/src/components/ChatView.tsx 逐字转写 mergeNewest 合并算法(159-172 行)与 SSE 分支(179-198 行)，
// 用真实服务端数据流喂入, 验证本地视图是否随服务端 meta 更新。转写仅去 TS 类型标注, 算法逐字保留。
const ChatView = {
  // ChatView.tsx 159-176 行逐字逻辑（TS 标注去除）
  async mergeNewest(msgs, fetchNewest) {
    const list = await fetchNewest()
    // setMsgs(prev => {...}) 函数式更新: 以下为 prev/list 的纯合并
    return (prev) => {
      if (prev.length === 0) return list
      const maxId = prev[prev.length - 1].id
      const newer = list.filter(m => m.id > maxId)
      return newer.length > 0 ? mergeById(prev, newer) : prev
    }
  },
  // SSE 分支 ChatView.tsx 181-188 行: 只处理 chat:message / chat:create
  sseHandle(action, convId, activeConv, handlers) {
    if (action === 'chat:message' && convId === activeConv) handlers.onMessage()
    else if (action === 'chat:create') handlers.onCreate()
    // chat:fail / chat:retry / 超龄标 failed → 无任何分支 → 不触发刷新
    return handlers.touched
  },
}
function mergeById(a, b) {
  const map = new Map()
  for (const m of a) map.set(m.id, m)
  for (const m of b) map.set(m.id, m)
  return [...map.values()].sort((x, y) => x.id - y.id)
}

let fail = 0
const check = (name, ok, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''))
  if (!ok) fail++
}
const serverNow = (msgs, id, patch) => msgs.map(m => (m.id === id ? { ...m, ...patch } : m))

// ── 场景 A: 成功回复 (awaiting→replied + 新回复消息) ──
{
  // 视图已含用户消息 id=1 (发送后本地 mergeById(prev,[msg]) 落 awaiting)
  let view = [{ id: 1, author: 'general', body: '帮我看看这段代码', meta: { aiStatus: 'awaiting' } }]
  // 服务端: 源消息已被回复方 CAS 置 replied, 并落第二条回复
  let server = [
    { id: 1, author: 'general', body: '帮我看看这段代码', meta: { aiStatus: 'replied', repliedAt: 't', replyMsg: 2 } },
    { id: 2, author: 'software-assistant', body: '好的，这段代码…', meta: { aiModel: 'deepseek-v4' } },
  ]
  // SSE chat:message 触发 mergeNewest
  const updater = await ChatView.mergeNewest(view, async () => server)
  view = updater(view)
  const src = view.find(m => m.id === 1)
  check('A1: 新回复气泡被追加显示', view.some(m => m.id === 2), 'view=' + JSON.stringify(view.map(m => m.id)))
  check('A2(核心): 源消息应实时显示 replied（本地仍 awaiting=⏳常驻）', src.meta.aiStatus === 'replied',
    '实际 aiStatus=' + src.meta.aiStatus + '（mergeNewest 只追加 id>maxId 的新消息, 同 id 源消息不覆盖）')
}

// ── 场景 B: 失败 (awaiting→failed, 无新消息) ──
{
  let view = [{ id: 10, author: 'general', body: 'q', meta: { aiStatus: 'awaiting' } }]
  let server = [{ id: 10, author: 'general', body: 'q', meta: { aiStatus: 'failed', aiError: '回复超时(120000ms 内未收到回复方应答)' } }]
  // 服务端 audit 发 chat:fail 帧; SSE 分支逐字转写: chat:fail 不触发任何刷新
  let touched = { onMessage: 0, onCreate: 0 }
  ChatView.sseHandle('chat:fail', 5, 5, { onMessage: () => touched.onMessage++, onCreate: () => touched.onCreate++ })
  check('B1: chat:fail 事件应触发同会话刷新(实际无任何分支消费)', touched.onMessage + touched.onCreate > 0,
    'SSE 分支只消费 chat:message/chat:create, chat:fail 被丢弃')
  // 15s 轮询兜底 → mergeNewest 也只追加不覆盖
  const updater = await ChatView.mergeNewest(view, async () => server)
  view = updater(view)
  check('B2(核心): 失败态应实时呈现 ❌+重试按钮（本地仍 awaiting）', view[0].meta.aiStatus === 'failed',
    '实际 aiStatus=' + view[0].meta.aiStatus + '（连 15s 轮询也不覆盖同 id 消息 → 重试按钮永不出现）')
}

// ── 场景 C: 控制 —— 若按整页 mergeById 合并, 两场景均应正确流转 ──
{
  let view = [{ id: 1, author: 'general', body: 'q', meta: { aiStatus: 'awaiting' } }]
  let server = [
    { id: 1, author: 'general', body: 'q', meta: { aiStatus: 'replied' } },
    { id: 2, author: 'software-assistant', body: 'a', meta: { aiModel: 'x' } },
  ]
  view = mergeById(view, server)
  check('C(修复假设验证): 整页 mergeById 后源消息流转为 replied', view.find(m => m.id === 1).meta.aiStatus === 'replied')
}

console.log(fail === 0 ? '== M1 结论: 未复现（期望外）==' : '== M1 结论: 确认 UI 三态不实时流转缺陷（' + fail + ' 项 FAIL）==')
process.exit(fail === 0 ? 0 : 1)
