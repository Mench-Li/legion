// docs/bugs/BUG-002-verify.mjs — Bug #2「Agent 对话失败」的现场复现 / 修复验证（A/B 对拍）
//
// 全程**不碰生产库**：两边的中枢都跑在 team.db 的**副本**上（638ms 级的临时目录），
// 端口用 8791/8792，写入只落副本。
//
// 对拍的两边（各自一份 team.db 副本 + 各自的代码树，`../product/*` 这类相对 import 才解析得对）：
//   A：修复后的 `team-hub/server.mjs`（本工作区 `.legion-worktrees/bugs`）→ 队列应当**看见**新提问
//   B：修复前的同一文件（主检出 `D:\project\DSH\legion`＝HEAD a8ff20de）→ 队列恒为空
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO = process.cwd()
const BEFORE_REPO = process.env.BUG002_BEFORE_REPO ?? 'D:/project/DSH/legion'
// ★ 快照取**生产库**（主检出的 team-hub/team.db，跑在 :8787 的那个）：本工作区的 team-hub/*.db
//   是 gitignore 的，工作区里那份只有测试留下的空表——用它复现不出"137 条消息把新提问挤出窗口"。
//   全程只**读着复制**一次，两个变体各写各的副本。
const SRC_DB = process.env.BUG002_SNAPSHOT_DB ?? join(BEFORE_REPO, 'team-hub', 'team.db')
const SCOPE = 'software'
const root = mkdtempSync(join(tmpdir(), 'bug2-ab-'))

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) return true } catch { /* 还没起来 */ }
    await sleep(250)
  }
  return false
}
async function post(base, path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function get(base, path) {
  const r = await fetch(base + path)
  return { status: r.status, body: await r.json().catch(() => null) }
}

/** 为一个变体准备：库副本（放临时目录，生产库只被读着复制一次）。 */
function dbCopy(name) {
  const dir = join(root, name)
  mkdirSync(join(dir, 'team-hub'), { recursive: true })
  const target = join(dir, 'team-hub', 'team.db')
  copyFileSync(SRC_DB, target)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(SRC_DB + suffix)) copyFileSync(SRC_DB + suffix, target + suffix)
  }
  return target
}

async function startVariant(label, { port, repo }) {
  const db = dbCopy(label)
  const child = spawn(process.execPath, [join(repo, 'team-hub', 'server.mjs')], {
    cwd: repo,
    env: { ...process.env, TEAM_HUB_DB: db, TEAM_HUB_PORT: String(port), TEAM_HUB_HOST: '127.0.0.1', TEAM_HUB_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  const out = []
  child.stdout.on('data', c => out.push(String(c)))
  child.stderr.on('data', c => out.push(String(c)))
  const base = `http://127.0.0.1:${port}`
  const up = await waitHttp(base + '/api/config')
  return { label, base, child, out, up, db }
}

const variants = []
try {
  // B 先起（旧实现＝主检出），A 后起（修复后＝本工作区）——两边各自一份库副本。
  const B = await startVariant('before', { port: 8792, repo: BEFORE_REPO })
  const A = await startVariant('after', { port: 8791, repo: REPO })
  variants.push(A, B)
  if (!A.up || !B.up) throw new Error(`中枢没起来：after=${A.up} before=${B.up}\n${A.out.join('')}\n${B.out.join('')}`)

  const result = { window: {}, after: {}, before: {} }

  for (const v of variants) {
    // 1) 现场形状：本空间的消息条数与 id 区间（两边是同一份快照）
    const spaces = await get(v.base, '/api/spaces')
    result.window[v.label] = { spacesOk: spaces.status === 200 }

    // 2) 找**用户当时用的那条**会话：带 agent_role 的岗位会话（现场是「编码工程师」，agent_role=coder）。
    //    不带 agent_role 的会话走的是另一条写路径（/api/agent-messages），与本 Bug 的复现无关。
    const convs = await get(v.base, `/api/chat/conversations?scope=${SCOPE}`)
    const list = convs.body?.conversations ?? []
    const conv = list.find(c => c.agentRole === 'coder') ?? list.find(c => c.agentRole)
    if (!conv) throw new Error(`${v.label}：快照里没有带岗位绑定的 ${SCOPE} 会话，无法复现`)
    result[v.label].conv = { id: conv.id, title: conv.title, agentRole: conv.agentRole ?? null }

    // 3) 发一条**新提问**（正是用户做的那件事）：它应当进 awaiting 队列
    const sent = await post(v.base, '/api/chat/messages', { conv: conv.id, body: '什么进展了（BUG-002 复现）', by: 'general' })
    const msg = sent.body?.task ?? sent.body
    result[v.label].sent = { status: sent.status, id: msg?.id, aiStatus: msg?.meta?.aiStatus, error: sent.body?.error }
    if (sent.status !== 200) throw new Error(`${v.label}：发消息失败 ${sent.status} ${sent.body?.error ?? ''}`)

    // 4) 守护会做的那个请求（固定 sinceMsgId=0，limit=20）
    const queue = await get(v.base, `/api/chat/replies?scope=${SCOPE}&limit=20`)
    const ids = (queue.body?.messages ?? []).map(m => m.id)
    result[v.label].queue = { status: queue.status, count: ids.length, ids, containsFresh: msg?.id ? ids.includes(msg.id) : null }
    if (v.label === 'after') result.after.agentPayload = (queue.body?.messages ?? [])[0]?.agent ?? null
  }

  console.log(JSON.stringify(result, null, 2))
  const ok = result.after.queue.containsFresh === true && result.before.queue.containsFresh === false
  console.log(ok
    ? '\nPASS：修复后新提问进得了队列；修复前同一个提问进不去（这就是「Agent 对话失败」的机器读数）'
    : '\nFAIL：A/B 差别不符合预期，看上面的读数')
  process.exitCode = ok ? 0 : 1
} finally {
  for (const v of variants) { try { v.child.kill() } catch { /* ignore */ } }
  await sleep(300)
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
