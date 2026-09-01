#!/usr/bin/env node
/**
 * render —— 从权威任务库（scrum/tasks.json）与军团状态（state.json）聚合生成看板：
 *   - scrum/board.json   机器可读看板快照（goal 进度、列、卡、士兵统计、版本/评论/描述）
 *   - scrum/KANBAN.md    文本看板（可在聊天里直接展示）
 *   - scrum/kanban.html  自包含单文件看板（双击即开只读；serve.mjs 下可拖拽写回）
 *
 * 用法：node legion/scrum/render.mjs [--out DIR]
 * 将军每轮更新任务后运行一次，看板即刷新；serve.mjs 每次写操作后也会自动运行本脚本。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TASKS_FILE = join(ROOT, 'scrum', 'tasks.json')
const STATE_FILE = join(ROOT, 'state.json')
const COLUMN_ORDER = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done']
const COLUMN_LABEL = {
  backlog: 'Backlog（未批准）',
  todo: 'Todo（已批准）',
  in_progress: 'In Progress（进行中）',
  in_review: 'In Review（待验证）',
  blocked: 'Blocked（受阻）',
  done: 'Done（完成）',
  canceled: 'Canceled（已取消）',
}
const PRIORITY_LABEL = { high: '🔴高', medium: '🟡中', low: '🟢低' }

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 由角色名派生稳定的徽章色相（0-360） */
function hueOf(role) {
  let sum = 0
  for (const ch of role) sum += ch.codePointAt(0)
  return sum % 360
}

function progressOf(tasks) {
  const rows = Object.values(tasks)
  const total = rows.filter(t => t.status !== 'canceled').length
  const done = rows.filter(t => t.status === 'done').length
  return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

/**
 * 清洗文本为短预览（借鉴 dsh-worktable 的 cleanPreviewText：带宽非 Token 成本）：
 * 去掉 ``` 围栏与行内代码、压缩空白，截断到 max 字符。
 */
function cleanPreview(text, max = 80) {
  const t = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/** 状态 → 发光语义（借鉴 worktable 的 done/need/busy 提醒镜像）：in_review=待你决定(黄) > blocked=受阻(红) > done=完成(绿) > in_progress=工作中(蓝)。 */
function glowOf(status) {
  if (status === 'in_review') return 'need'
  if (status === 'blocked') return 'danger'
  if (status === 'done') return 'done'
  if (status === 'in_progress') return 'busy'
  return null
}

function buildBoard() {
  const tasks = readJson(TASKS_FILE, null)
  if (tasks === null) throw new Error(`tasks.json 不存在（${TASKS_FILE}）：先运行 taskctl init`)
  const state = readJson(STATE_FILE, {})
  const progress = progressOf(tasks.tasks)

  const columns = COLUMN_ORDER.map(status => ({
    id: status,
    label: COLUMN_LABEL[status],
    cards: Object.values(tasks.tasks)
      .filter(t => t.status === status)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(card => ({
        id: card.id,
        title: card.title,
        description: card.description,
        priority: card.priority,
        role: card.role,
        soldier: card.soldier,
        claimedRound: card.claimedRound,
        claimedAt: card.claimedAt,
        ordersVersion: card.ordersVersion,
        acceptance: card.acceptance,
        parent: card.parent,
        blocks: card.blocks,
        blockedBy: card.blockedBy,
        version: card.version,
        comments: card.comments,
        latestComment: ((c) => c ? { by: c.by, at: c.at, text: cleanPreview(c.text) } : null)((card.comments ?? []).slice(-1)[0]),
        evidence: card.evidence.length,
        patches: (card.patches ?? []).map(p => ({ id: p.id, at: p.at, by: p.by, summary: p.summary, files: p.files })),
        artifacts: (card.artifacts ?? []).map(a => ({ kind: a.kind, title: a.title, path: a.path, at: a.at, by: a.by })),
        glow: glowOf(card.status),
        progress: ((p) => {
          const last = (p ?? []).slice(-1)[0]
          return last ? { percent: last.percent, note: last.note, at: last.at, by: last.by } : null
        })(card.progress),
        updatedAt: card.updatedAt,
      })),
  }))
  const canceled = Object.values(tasks.tasks).filter(t => t.status === 'canceled').length

  const soldiers = {}
  for (const t of Object.values(tasks.tasks)) {
    if (t.soldier === null) continue
    const s = soldiers[t.soldier] ?? { role: t.soldier, inProgress: 0, inReview: 0, done: 0, blocked: 0, total: 0 }
    s.total += 1
    if (t.status === 'in_progress') s.inProgress += 1
    if (t.status === 'in_review') s.inReview += 1
    if (t.status === 'done') s.done += 1
    if (t.status === 'blocked') s.blocked += 1
    soldiers[t.soldier] = s
  }

  return {
    generatedAt: new Date().toISOString(),
    goal: {
      objective: state.objective ?? '（未填写目标）',
      phase: state.phase ?? 'unknown',
      roundsCompleted: state.roundsCompleted ?? 0,
      progress,
      progressBar: bar(progress.percent),
    },
    totals: { open: progress.total - progress.done, done: progress.done, total: progress.total, canceled },
    columns,
    soldiers: Object.values(soldiers).sort((a, b) => a.role.localeCompare(b.role)),
  }
}

function bar(percent, width = 20) {
  const filled = Math.round((percent / 100) * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

function renderMarkdown(board) {
  const lines = ['# 军团看板（KANBAN）', '']
  lines.push('## Goal 进度', '')
  lines.push(`**${board.goal.objective}**`, '')
  lines.push(`\`${board.goal.progressBar}\` **${board.goal.progress.percent}%**（${board.goal.progress.done}/${board.goal.progress.total} 完成）· 阶段 ${board.goal.phase} · 已完成 ${board.goal.roundsCompleted} 轮`, '')
  lines.push('', '## 士兵统计', '', '| 士兵 | 进行中 | 待验证 | 完成 | 受阻 | 总计 |', '| --- | --- | --- | --- | --- | --- |')
  for (const s of board.soldiers) {
    lines.push(`| ${s.role} | ${s.inProgress} | ${s.inReview} | ${s.done} | ${s.blocked} | ${s.total} |`)
  }
  if (board.soldiers.length === 0) lines.push('| （尚无认领任务的士兵） | | | | | |')
  lines.push('')
  for (const col of board.columns) {
    lines.push(`## ${col.label}（${col.cards.length}）`, '')
    if (col.cards.length === 0) {
      lines.push('_空_', '')
      continue
    }
    for (const c of col.cards) {
      const tags = [
        c.priority !== 'medium' ? PRIORITY_LABEL[c.priority] : '',
        c.soldier ? `@${c.soldier}` : '',
        c.claimedRound ? `第${c.claimedRound}轮认领` : '',
        c.blockedBy.length > 0 ? `依赖:${c.blockedBy.join(',')}` : '',
      ].filter(Boolean).join(' ')
      lines.push(`- **${c.id}** ${c.title}${tags ? `（${tags}）` : ''}`)
      if (c.acceptance.length > 0) lines.push(`  - 验收：${c.acceptance.join('；')}`)
    }
    lines.push('')
  }
  lines.push(`_生成于 ${board.generatedAt}；运行 \`node legion/scrum/render.mjs\` 刷新_`)
  return `${lines.join('\n')}\n`
}

function renderHtml(board) {
  const data = JSON.stringify(board)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<title>军团看板 · ${board.goal.objective.slice(0, 40)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; background: #0f1420; color: #e6e9f0; }
  header { padding: 14px 20px; background: #161d2e; border-bottom: 1px solid #242f45; position: sticky; top: 0; z-index: 10; }
  h1 { margin: 0 0 6px; font-size: 18px; }
  .goal-line { display: flex; align-items: center; gap: 12px; font-size: 13px; color: #9aa6bd; }
  .progress { flex: 1; max-width: 520px; height: 14px; background: #1d2740; border-radius: 7px; overflow: hidden; }
  .progress > i { display: block; height: 100%; background: linear-gradient(90deg, #3b82f6, #22c55e); }
  .meta { font-size: 12px; color: #6b7a94; margin-left: auto; }
  .toolbar { display: flex; align-items: center; gap: 10px; margin-top: 10px; flex-wrap: wrap; }
  .toolbar select, .toolbar button { background: #1a2237; color: #e6e9f0; border: 1px solid #26334e; border-radius: 8px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
  .toolbar .hint { color: #6b7a94; font-size: 12px; }
  .soldiers { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .soldier { display: flex; align-items: center; gap: 6px; background: #1a2237; border: 1px solid #26334e; border-radius: 999px; padding: 3px 10px 3px 4px; font-size: 12px; cursor: pointer; user-select: none; }
  .soldier .dot { width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; color: #0f1420; font-weight: 700; }
  .soldier .counts { color: #7d8aa3; }
  .soldier.active { outline: 2px solid #60a5fa; }
  main { display: flex; gap: 12px; padding: 14px; overflow-x: auto; align-items: flex-start; }
  .column { flex: 0 0 300px; min-width: 280px; background: #131a2b; border: 1px solid #212c45; border-radius: 10px; padding: 8px; }
  .column.drag-over { outline: 2px dashed #60a5fa; background: #16203a; }
  .column h2 { margin: 4px 6px 10px; font-size: 13px; color: #9aa6bd; display: flex; justify-content: space-between; }
  .column h2 .n { background: #1d2740; border-radius: 999px; padding: 0 8px; font-size: 11px; }
  .card { background: #1a2237; border: 1px solid #26334e; border-left: 3px solid #3b82f6; border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; font-size: 12px; cursor: grab; }
  .card.dragging { opacity: .4; }
  .card.done { opacity: .62; border-left-color: #22c55e; }
  .card.blocked { border-left-color: #ef4444; }
  .card h3 { margin: 0 0 4px; font-size: 13px; }
  .card .tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: #232f4d; color: #aeb9d1; }
  .tag.p-high { background: #4c1d24; color: #fda4af; }
  .tag.p-low { background: #173b2a; color: #86efac; }
  .tag.soldier { background: #1e3a5f; }
  .acceptance { margin-top: 6px; color: #7d8aa3; }
  .acceptance li { margin-left: 14px; }
  .prog { margin-top: 6px; position: relative; height: 14px; background: #1a2237; border-radius: 7px; overflow: hidden; }
  .prog-bar { height: 100%; background: linear-gradient(90deg, #2563eb, #60a5fa); border-radius: 7px; }
  .prog-text { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 10px; color: #e6e9f0; }
  .preview { margin-top: 6px; color: #7d8aa3; font-size: 11px; line-height: 1.4; max-height: 2.9em; overflow: hidden; }
  .card.glow-need { outline: 2px solid #facc15; box-shadow: 0 0 10px rgba(250, 204, 21, .35); }
  .card.glow-danger { outline: 2px solid #f87171; box-shadow: 0 0 10px rgba(248, 113, 113, .4); }
  .card.glow-done { outline: 2px solid #4ade80; box-shadow: 0 0 8px rgba(74, 222, 128, .28); }
  .card.glow-busy { outline: 2px solid #60a5fa; box-shadow: 0 0 8px rgba(96, 165, 250, .28); }
  .footer { margin-top: 6px; color: #5d6a85; font-size: 11px; display: flex; justify-content: space-between; }
  .footer button { background: none; border: none; color: #7d8aa3; cursor: pointer; font-size: 11px; padding: 0; }
  .footer button:hover { color: #e6e9f0; }
  .empty { color: #44506a; text-align: center; padding: 14px 0; font-size: 12px; }
  .toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); background: #1a2237; border: 1px solid #26334e; border-radius: 8px; padding: 8px 14px; font-size: 12px; z-index: 60; max-width: 80vw; }
  .toast.err { border-color: #ef4444; color: #fda4af; }
  .modal { position: fixed; inset: 0; background: rgba(10,14,24,.72); display: flex; align-items: center; justify-content: center; z-index: 50; }
  .modal .panel { background: #131a2b; border: 1px solid #26334e; border-radius: 12px; padding: 18px 20px; width: min(520px, 90vw); max-height: 84vh; overflow: auto; }
  .modal h3 { margin: 0 0 12px; font-size: 15px; }
  .modal label { display: block; font-size: 12px; color: #9aa6bd; margin: 10px 0 4px; }
  .modal input, .modal textarea, .modal select { width: 100%; background: #0f1420; color: #e6e9f0; border: 1px solid #26334e; border-radius: 8px; padding: 7px 9px; font-size: 12px; font-family: inherit; }
  .modal .row { display: flex; gap: 10px; }
  .modal .row > div { flex: 1; }
  .modal .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
  .modal .actions button { background: #1d2740; color: #e6e9f0; border: 1px solid #26334e; border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: 12px; }
  .modal .actions button.primary { background: #2563eb; border-color: #2563eb; }
  .comment { border-top: 1px solid #212c45; padding: 8px 0; font-size: 12px; }
  .comment .who { color: #60a5fa; font-size: 11px; }
  .comment .at { color: #5d6a85; font-size: 10px; margin-left: 6px; }
  .comment .text { margin-top: 3px; white-space: pre-wrap; color: #c6cede; }
  .activity-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 320px; max-width: 88vw; background: #121a2c; border-left: 1px solid #26334e; z-index: 40; transform: translateX(100%); transition: transform .2s ease; display: flex; flex-direction: column; }
  .activity-drawer.open { transform: translateX(0); }
  .activity-head { padding: 12px 14px; border-bottom: 1px solid #242f45; display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
  .activity-head button { background: none; border: none; color: #9aa6bd; cursor: pointer; font-size: 18px; line-height: 1; }
  .activity-feed { flex: 1; overflow-y: auto; padding: 8px 12px; }
  .activity-item { display: flex; gap: 8px; padding: 7px 0; border-bottom: 1px solid #1a2440; font-size: 12px; align-items: flex-start; }
  .activity-item .a-ico { flex: 0 0 auto; }
  .activity-item .a-task { color: #60a5fa; font-weight: 600; flex: 0 0 auto; }
  .activity-item .a-text { color: #c6cede; flex: 1; }
  .activity-item .a-time { flex: 0 0 auto; color: #5d6a85; font-size: 11px; margin-top: 1px; }
  .activity-empty { color: #44506a; font-size: 12px; padding: 12px 0; }
</style>
</head>
<body>
<header>
  <h1>🏛 军团看板 <span style="font-size:12px;color:#6b7a94" id="mode-label"></span></h1>
  <div class="goal-line">
    <span id="goal-title">${escapeHtml(board.goal.objective)}</span>
    <span id="goal-meta"></span>
    <span class="meta" id="live-badge"></span>
  </div>
  <div class="toolbar">
    <label style="font-size:12px;color:#9aa6bd">以身份操作
      <select id="identity"></select>
    </label>
    <button type="button" id="btn-create">＋ 新建任务</button>
    <button type="button" id="btn-token">🔑 令牌</button>
    <button type="button" id="btn-activity">⚡ 动态</button>
    <a href="console.html" style="text-decoration:none"><button type="button" id="btn-console">🖥 总指挥部</button></a>
    <span class="hint" id="drag-hint"></span>
  </div>
  <div class="soldiers" id="soldiers"></div>
</header>
<aside class="activity-drawer" id="activity-drawer">
  <div class="activity-head"><span>⚡ 动态<span id="activity-count" style="color:#6b7a94"></span></span><button type="button" id="btn-activity-close">×</button></div>
  <div class="activity-feed" id="activity-feed"><div class="activity-empty">暂无动态（守护派工后这里实时滚动）</div></div>
</aside>
<main id="board"></main>
<script id="board-data" type="application/json">${data}</script>
<script>
  let board = JSON.parse(document.getElementById('board-data').textContent)
  const hue = role => { let s = 0; for (const ch of role) s += ch.codePointAt(0); return s % 360 }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
  const fmt = iso => { const d = new Date(iso); return d.toLocaleString('zh-CN', { hour12: false }) }
  const label = { backlog: 'Backlog', todo: 'Todo', in_progress: '进行中', in_review: '待验证', blocked: '受阻', done: '完成', canceled: '已取消' }
  const pri = { high: '高', medium: '中', low: '低' }
  const TRANSITIONS = { backlog:['todo','blocked','canceled'], todo:['in_progress','blocked','canceled'], in_progress:['in_review','todo','blocked','canceled'], in_review:['done','todo','in_progress','blocked','canceled'], blocked:['todo','in_progress','canceled'], done:['in_progress','canceled'], canceled:[] }
  const LIVE = location.protocol === 'http:' || location.protocol === 'https:'
  let filter = null
  let dragging = null
  let detail = null
  const AKIND = { claim: '🚀', dispatch: '▶️', done: '✅', blocked: '⛔', released: '♻️', redispatch: '🔁', aborted: '⚠️' }
  let activity = []

  const identity = {
    get() { return localStorage.getItem('kanban.identity') || 'general' },
    set(v) { localStorage.setItem('kanban.identity', v) },
  }
  const token = {
    get() { return localStorage.getItem('kanban.token') || '' },
    set(v) { localStorage.setItem('kanban.token', v) },
  }

  function toast(msg, kind) {
    const el = document.createElement('div')
    el.className = 'toast' + (kind === 'err' ? ' err' : '')
    el.textContent = msg
    document.body.appendChild(el)
    setTimeout(() => el.remove(), 4200)
  }

  function findCard(id) {
    for (const col of board.columns) {
      const c = col.cards.find(c => c.id === id)
      if (c) return { ...c, status: col.id }
    }
    return null
  }

  async function api(path, body) {
    const headers = { 'content-type': 'application/json' }
    const t = token.get()
    if (t) headers['authorization'] = 'Bearer ' + t
    let r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) })
    if (r.status === 401) {
      const t2 = prompt('看板开启了令牌保护，请输入令牌：', t)
      if (!t2) return { ok: false, error: '未提供令牌' }
      token.set(t2)
      headers['authorization'] = 'Bearer ' + t2
      r = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) })
    }
    const data = await r.json().catch(() => ({}))
    return { ok: r.ok, error: data.error, data }
  }

  async function handleDrop(id, from, to) {
    if (from === to) return
    const allowed = TRANSITIONS[from] || []
    if (!allowed.includes(to)) {
      toast('非法迁移：' + label[from] + ' → ' + label[to] + '（服务端同样会拒绝）', 'err')
      return
    }
    const card = findCard(id)
    if (!card) return
    const r = await api('/api/transition', { id, to, by: identity.get(), ifVersion: card.version })
    if (r.ok) toast(id + ' → ' + label[to] + ' ✓')
    else if (r.error) toast(r.error, 'err')
  }

  function card(c, status) {
    const canDrag = LIVE ? 'draggable="true"' : ''
    return \`
    <div class="card \${esc(status)}" \${canDrag} data-id="\${esc(c.id)}" data-status="\${esc(status)}" data-glow="\${c.glow || ''}" data-detail="\${esc(c.id)}" style="cursor:pointer">
      <h3>\${esc(c.id)} · \${esc(c.title)}</h3>
      \${c.description ? \`<div style="color:#9aa6bd;margin:4px 0">\${esc(c.description.slice(0, 120))}\${c.description.length > 120 ? '…' : ''}</div>\` : ''}
      <div class="tags">
        <span class="tag p-\${esc(c.priority)}">\${pri[c.priority] || c.priority}</span>
        \${c.role ? \`<span class="tag role" style="background:#2b3a55;color:#dbe6ff">⚙ \${esc(c.role)}</span>\` : ''}
        \${c.soldier ? \`<span class="tag soldier" style="background:hsl(\${hue(c.soldier)},70%,25%)">@\${esc(c.soldier)}\</span>\` : ''}
        \${c.claimedRound ? \`<span class="tag">第\${c.claimedRound}轮认领</span>\` : ''}
        \${c.ordersVersion ? \`<span class="tag">orders v\${c.ordersVersion}</span>\` : ''}
        \${c.blockedBy.length ? \`<span class="tag">依赖:\${esc(c.blockedBy.join(','))}</span>\` : ''}
        \${c.evidence ? \`<span class="tag">✓\${c.evidence} 证据</span>\` : ''}
        \${c.patches && c.patches.length ? \`<span class="tag">📄\${c.patches.length} diff</span>\` : ''}
        \${c.artifacts && c.artifacts.length ? \`<span class="tag">📦\${c.artifacts.length} 产物</span>\` : ''}
      </div>
      \${c.acceptance.length ? \`<ul class="acceptance">\${c.acceptance.map(a => \`<li>\${esc(a)}\</li>\`).join('')}</ul>\` : ''}
      \${c.progress ? \`<div class="prog"><div class="prog-bar" style="width:\${Math.max(0, Math.min(100, c.progress.percent))}%"></div><span class="prog-text">\${c.progress.percent}%\${c.progress.note ? ' · ' + esc(c.progress.note) : ''}</span></div>\` : ''}
      \${c.latestComment ? \`<div class="preview">\${esc(c.latestComment.by)}: \${esc(c.latestComment.text)}</div>\` : ''}
      <div class="footer"><span>\${c.comments.length} 评论</span><span><button type="button" data-detail="\${esc(c.id)}">详情/评论</button> · v\${c.version} · \${fmt(c.updatedAt)}</span></div>
    </div>\`
  }

  function identityBar() {
    const el = document.getElementById('identity')
    const roles = ['general', ...board.soldiers.map(s => s.role)]
    el.innerHTML = roles.map(r => \`<option value="\${esc(r)}"\${identity.get() === r ? ' selected' : ''}>\${esc(r)}</option>\`).join('')
    el.onchange = () => { identity.set(el.value); toast('身份：' + el.value) }
    const hint = document.getElementById('drag-hint')
    hint.textContent = LIVE ? '拖拽卡片跨列即迁移状态；in_review→done 需身份 general' : '文件模式只读；运行 serve.mjs 后拖拽生效'
  }

  function soldiersBar() {
    const el = document.getElementById('soldiers')
    el.innerHTML = board.soldiers.map(s => \`
      <span class="soldier\${filter === s.role ? ' active' : ''}" data-role="\${esc(s.role)}">
        <span class="dot" style="background:hsl(\${hue(s.role)},70%,60%)">\${s.role[0].toUpperCase()}</span>
        \${esc(s.role)}
        <span class="counts">▶\${s.inProgress} ✓\${s.done} ⛔\${s.blocked}</span>
      </span>\`).join('') || '<span class="soldier">尚无认领任务的士兵</span>'
    el.querySelectorAll('.soldier').forEach(el => el.onclick = () => {
      filter = filter === el.dataset.role ? null : el.dataset.role
      render()
    })
  }

  async function viewPatch(patchId) {
    const r = await fetch('/api/patch?id=' + encodeURIComponent(patchId))
    if (!r.ok) { toast('diff 读取失败', 'err'); return }
    const text = await r.text()
    const overlay = document.createElement('div')
    overlay.className = 'modal'
    overlay.innerHTML = \`
      <div class="panel" style="width:min(760px,92vw)">
        <h3>改动 diff · \${esc(patchId)}</h3>
        <pre style="background:#0f1420;border:1px solid #26334e;border-radius:8px;padding:10px;overflow:auto;max-height:60vh;font-size:11px;color:#c6cede;white-space:pre">\${esc(text.slice(0, 60000))}</pre>
        <div class="actions"><button type="button" data-close>关闭</button></div>
      </div>\`
    document.body.appendChild(overlay)
    overlay.querySelector('[data-close]').onclick = () => overlay.remove()
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
  }

  function detailModal() {
    const c = detail ? findCard(detail) : null
    if (!c) return
    const overlay = document.createElement('div')
    overlay.className = 'modal'
    overlay.innerHTML = \`
      <div class="panel">
        <h3>\${esc(c.id)} · \${esc(c.title)} <span class="tag">\${label[c.status]}</span></h3>
        \${c.description ? \`<div style="color:#c6cede;white-space:pre-wrap;font-size:12px">\${esc(c.description)}</div>\` : ''}
        \${c.acceptance.length ? \`<ul class="acceptance">\${c.acceptance.map(a => \`<li>\${esc(a)}\</li>\`).join('')}</ul>\` : ''}
        \${c.patches && c.patches.length ? \`<div style="margin-top:10px;color:#9aa6bd;font-size:12px">改动 diff（\${c.patches.length}）</div>\${c.patches.map(p => \`<div class="comment"><span class="who">#\${esc(p.id)}</span><span class="at">\${fmt(p.at)}</span><div class="text">\${esc(p.summary)}\${p.files && p.files.length ? '（' + esc(p.files.join(', ')) + '）' : ''}</div><button type="button" data-patch="\${esc(p.id)}" style="margin-top:4px;background:#1d2740;color:#e6e9f0;border:1px solid #26334e;border-radius:8px;padding:3px 10px;cursor:pointer;font-size:11px">查看 diff</button></div>\`).join('')}\` : ''}
        \${c.artifacts && c.artifacts.length ? \`<div style="margin-top:10px;color:#9aa6bd;font-size:12px">产物（\${c.artifacts.length}，最新一条可在下方预览）</div>\${c.artifacts.map((a, i) => \`<div class="comment"><span class="who">📦 \${esc(a.title || a.kind)}</span><span class="at">\${fmt(a.at)}</span><div class="text">\${esc(a.path)}</div>\${i === c.artifacts.length - 1 && a.kind === 'html' ? \`<iframe src='/api/artifact?task=\${esc(c.id)}&raw=1' style="width:100%;height:300px;border:1px solid #26334e;border-radius:8px;background:#fff;margin-top:4px"></iframe>\` : ''}\${i === c.artifacts.length - 1 && a.kind === 'url' ? \`<div style="margin-top:4px"><a href="\${esc(a.path)}" target="_blank" rel="noopener" style="color:#60a5fa">打开链接 ↗</a></div>\` : ''}\${i === c.artifacts.length - 1 && a.kind === 'file' ? \`<div style="margin-top:4px"><a href='/api/artifact?task=\${esc(c.id)}&raw=1' target="_blank" rel="noopener" style="color:#60a5fa">下载文件 ⬇</a></div>\` : ''}</div>\`).join('')}\` : ''}
        <div style="margin-top:10px;color:#9aa6bd;font-size:12px">评论（\${c.comments.length}）</div>
        \${c.comments.map(cm => \`<div class="comment"><span class="who">@\${esc(cm.by)}</span><span class="at">\${fmt(cm.at)}</span><div class="text">\${esc(cm.text)}</div></div>\`).join('') || '<div style="color:#5d6a85;font-size:12px;padding:6px 0">暂无评论</div>'}
        <label>追加评论（\${esc(identity.get())} 身份；退回任务请写清原因）</label>
        <textarea id="cmt-text" rows="2" placeholder="例如：验收不通过，需要补充 X……"></textarea>
        <div class="actions">
          <button type="button" data-close>关闭</button>
          \${c.status === 'in_review' ? \`<button type="button" class="primary" id="act-approve">✅ 通过验收</button><button type="button" id="act-reject">↩ 打回重做</button>\` : ''}
          \${c.status === 'done' ? \`<button type="button" class="primary" id="act-promote">🔀 promote 合并</button>\` : ''}
          <button type="button" class="primary" id="cmt-send">提交评论</button>
        </div>
      </div>\`
    document.body.appendChild(overlay)
    overlay.querySelector('[data-close]').onclick = () => { overlay.remove(); detail = null }
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); detail = null } })
    overlay.querySelector('#cmt-send').onclick = async () => {
      const text = overlay.querySelector('#cmt-text').value.trim()
      if (!text) { toast('评论不能为空', 'err'); return }
      const r = await api('/api/comment', { id: c.id, by: identity.get(), text })
      overlay.remove(); detail = null
      toast(r.ok ? c.id + ' 评论已提交' : (r.error || '评论失败'), r.ok ? undefined : 'err')
    }
    overlay.querySelectorAll('[data-patch]').forEach(btn => { btn.onclick = () => viewPatch(btn.dataset.patch) })
    const approveBtn = overlay.querySelector('#act-approve')
    if (approveBtn) approveBtn.onclick = async () => {
      const r = await api('/api/transition', { id: c.id, to: 'done', by: identity.get(), ifVersion: c.version })
      overlay.remove(); detail = null
      toast(r.ok ? c.id + ' 已通过验收 → done' : (r.error || '通过失败'), r.ok ? undefined : 'err')
    }
    const rejectBtn = overlay.querySelector('#act-reject')
    if (rejectBtn) rejectBtn.onclick = async () => {
      const reason = prompt('打回原因（会写进评论并回滚 worktree 改动）：', '')
      if (reason === null) return
      if (!reason.trim()) { toast('打回原因不能为空', 'err'); return }
      const r = await api('/api/reject', { id: c.id, by: identity.get(), reason: reason.trim(), ifVersion: c.version })
      overlay.remove(); detail = null
      toast(r.ok ? c.id + ' 已打回 → todo' : (r.error || '打回失败'), r.ok ? undefined : 'err')
    }
    const promoteBtn = overlay.querySelector('#act-promote')
    if (promoteBtn) promoteBtn.onclick = async () => {
      const r = await api('/api/promote', { id: c.id, by: identity.get(), ifVersion: c.version })
      toast(r.ok ? c.id + ' 已 promote 合并' : (r.error || 'promote 失败'), r.ok ? undefined : 'err')
    }
  }

  function createModal() {
    const overlay = document.createElement('div')
    overlay.className = 'modal'
    overlay.innerHTML = \`
      <div class="panel">
        <h3>新建任务（backlog，将军批准后士兵才可认领）</h3>
        <label>标题</label><input id="n-title" placeholder="一句话说清做什么">
        <label>描述（可选）</label><textarea id="n-desc" rows="3" placeholder="上下文、目标、成功定义"></textarea>
        <label>验收标准（每行一条，可选）</label><textarea id="n-acc" rows="3" placeholder="每行一条验收标准"></textarea>
        <div class="row">
          <div><label>优先级</label><select id="n-pri"><option value="high">高</option><option value="medium" selected>中</option><option value="low">低</option></select></div>
        </div>
        <div class="actions">
          <button type="button" data-close>取消</button>
          <button type="button" class="primary" id="n-send">创建</button>
        </div>
      </div>\`
    document.body.appendChild(overlay)
    overlay.querySelector('[data-close]').onclick = () => overlay.remove()
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
    overlay.querySelector('#n-send').onclick = async () => {
      const title = overlay.querySelector('#n-title').value.trim()
      if (!title) { toast('标题不能为空', 'err'); return }
      const r = await api('/api/create', {
        title,
        description: overlay.querySelector('#n-desc').value.trim(),
        acceptance: overlay.querySelector('#n-acc').value.split('\\n').map(s => s.trim()).filter(Boolean),
        priority: overlay.querySelector('#n-pri').value,
      })
      overlay.remove()
      toast(r.ok ? '任务已创建（backlog）' : (r.error || '创建失败'), r.ok ? undefined : 'err')
    }
  }

  function render() {
    const el = document.getElementById('board')
    el.innerHTML = board.columns.map(col => {
      const cards = col.cards.filter(c => !filter || c.soldier === filter)
      return \`
      <section class="column" data-col="\${col.id}">
        <h2><span>\${label[col.id]}</span><span class="n">\${cards.length}</span></h2>
        \${cards.map(c => card(c, col.id)).join('') || '<div class="empty">空</div>'}
      </section>\`
    }).join('')
    soldiersBar()
    identityBar()
    goalMeta()
    applyGlow()
  }

  // ── 待决提醒镜像（借鉴 dsh-worktable 的 done/need 发光 + ack 生命周期）──
  // 发光只显示「当前状态 ≠ 上次 ack 状态」的任务：点开详情即 ack，状态转移后重新点亮。
  function ackMap() {
    try { return JSON.parse(localStorage.getItem('legion.notifyAck.v1') || '{}') } catch { return {} }
  }
  function applyGlow() {
    const m = ackMap()
    document.querySelectorAll('.card[data-glow]').forEach(el => {
      const g = el.dataset.glow
      if (!g) return
      el.classList.toggle('glow-' + g, m[el.dataset.id] !== g)
    })
  }
  function ack(id, status) {
    const m = ackMap()
    m[id] = status
    try { localStorage.setItem('legion.notifyAck.v1', JSON.stringify(m)) } catch {}
    applyGlow()
  }

  function goalMeta() {
    const el = document.getElementById('goal-meta')
    if (el) {
      const g = board.goal
      el.innerHTML = \`<span class="progress"><i style="width:\${g.progress.percent}%"></i></span><strong>\${g.progress.percent}%</strong><span>\${g.progress.done}/\${g.progress.total} 完成</span><span class="meta">阶段 \${g.phase} · 第 \${g.roundsCompleted} 轮 · \${fmt(g.generatedAt)}</span>\`
    }
    document.title = \`军团看板 · \${board.goal.objective.slice(0, 40)}\`
  }

  function apply(next) { board = next; render() }

  function wireDrag() {
    const el = document.getElementById('board')
    let suppressClick = false
    el.addEventListener('dragstart', e => {
      const cardEl = e.target.closest('.card')
      if (!cardEl) return
      dragging = { id: cardEl.dataset.id, from: cardEl.dataset.status }
      cardEl.classList.add('dragging')
      e.dataTransfer.effectAllowed = 'move'
    })
    el.addEventListener('dragend', e => {
      const cardEl = e.target.closest('.card')
      if (cardEl) cardEl.classList.remove('dragging')
      dragging = null
      suppressClick = true
      setTimeout(() => { suppressClick = false }, 200)
    })
    el.addEventListener('dragover', e => {
      const col = e.target.closest('.column')
      if (!col || !dragging) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      col.classList.add('drag-over')
    })
    el.addEventListener('dragleave', e => {
      const col = e.target.closest('.column')
      if (col) col.classList.remove('drag-over')
    })
    el.addEventListener('drop', e => {
      e.preventDefault()
      const col = e.target.closest('.column')
      if (col) col.classList.remove('drag-over')
      if (!dragging) return
      void handleDrop(dragging.id, dragging.from, col.dataset.col)
      dragging = null
    })
    el.addEventListener('click', e => {
      if (suppressClick) return
      const btn = e.target.closest('[data-detail]')
      if (btn) {
        detail = btn.dataset.detail
        ack(detail, findCard(detail)?.status ?? '')
        detailModal()
      }
    })
  }

  function startPolling() {
    const badge = document.getElementById('live-badge')
    if (badge) badge.textContent = '● 轮询中'
    setInterval(async () => {
      try { const r = await fetch('/api/board'); if (r.ok) apply(await r.json()) } catch { /* 服务器未就绪时静默重试 */ }
    }, 5000)
  }
  function startSSE() {
    const es = new EventSource('/api/board/events')
    es.onopen = () => { const badge = document.getElementById('live-badge'); if (badge) badge.textContent = '● 实时' }
    es.onmessage = e => { try { apply(JSON.parse(e.data)) } catch { /* 推送瞬间的重渲染冲突可忽略 */ } }
    es.onerror = () => { es.close(); startPolling() }
  }
  function renderActivity() {
    const el = document.getElementById('activity-feed')
    if (!el) return
    if (activity.length === 0) {
      el.innerHTML = '<div class="activity-empty">暂无动态（守护派工后这里实时滚动）</div>'
    } else {
      el.innerHTML = activity.slice(0, 50).map(a => \`<div class="activity-item"><span class="a-ico">\${AKIND[a.kind] || '•'}</span><span class="a-task">\${esc(a.taskId || '')}</span><span class="a-text">\${esc(a.text || '')}</span><span class="a-time">\${fmt(a.ts)}</span></div>\`).join('')
    }
    const n = document.getElementById('activity-count')
    if (n) n.textContent = activity.length ? ' · ' + activity.length + ' 条' : ''
  }
  function pushActivity(e) { activity.unshift(e); if (activity.length > 200) activity.length = 200; renderActivity() }
  function startActivityPolling() {
    setInterval(async () => { try { const r = await fetch('/api/activity?limit=50'); if (r.ok) { activity = await r.json(); renderActivity() } } catch { /* 静默重试 */ } }, 5000)
  }
  function startActivitySSE() {
    const es = new EventSource('/api/activity/events')
    es.onmessage = e => { try { pushActivity(JSON.parse(e.data)) } catch { /* 忽略坏行 */ } }
    es.onerror = () => { es.close(); startActivityPolling() }
  }
  function boot() {
    render()
    wireDrag()
    document.getElementById('btn-create').onclick = createModal
    document.getElementById('btn-token').onclick = () => {
      const t = prompt('看板写操作令牌（留空清除）：', token.get())
      if (t === null) return
      token.set(t)
      toast(t ? '令牌已保存' : '令牌已清除')
    }
    document.getElementById('btn-activity').onclick = () => document.getElementById('activity-drawer').classList.toggle('open')
    document.getElementById('btn-activity-close').onclick = () => document.getElementById('activity-drawer').classList.remove('open')
    const mode = document.getElementById('mode-label')
    if (LIVE) {
      document.querySelector('meta[http-equiv="refresh"]')?.remove()
      if (mode) mode.textContent = '(Scrum · 实时 · 拖拽写回)'
      if (window.EventSource) { startSSE(); startActivitySSE() } else { startPolling(); startActivityPolling() }
    } else if (mode) {
      mode.textContent = '(Scrum · 文件模式 · 只读 · 30s 自动刷新)'
    }
  }
  boot()
</script>
</body>
</html>
`
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function formatTime(iso) {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

function main() {
  const args = process.argv.slice(2)
  const outDir = args[0] === '--out' ? args[1] : join(ROOT, 'scrum')
  if (outDir === undefined) throw new Error('--out 需要一个目录')
  mkdirSync(outDir, { recursive: true })

  const board = buildBoard()
  const boardFile = join(outDir, 'board.json')
  const mdFile = join(outDir, 'KANBAN.md')
  const htmlFile = join(outDir, 'kanban.html')
  writeFileSync(boardFile, `${JSON.stringify(board, null, 2)}\n`)
  writeFileSync(mdFile, renderMarkdown(board))
  writeFileSync(htmlFile, renderHtml(board))
  process.stdout.write(
    `${JSON.stringify({ ok: true, goal: board.goal.progress.percent, done: board.goal.progress.done, total: board.goal.progress.total, board: boardFile, kanban: mdFile, html: htmlFile }, null, 2)}\n`,
  )
}

main()
