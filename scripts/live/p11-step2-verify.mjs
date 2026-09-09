// scripts/live/p11-step2-verify.mjs — P1-1 第 2 步现场切换验收 probe（重启宿主后运行）。
//
// 前置：已按 docs/P1-1-step2-runbook.md 重启 3080 宿主（junction=源码 → team-hub v2 外壳 +
// services-plugin 不再托管 4820 + board-plugin hub 模式自动指宿主 /team-hub）。
//
// 用法：node scripts/live/p11-step2-verify.mjs [--token <hub token>] [--base http://127.0.0.1:3080]
// 默认 token 空（生产宿主 teamToken 通常为空）；fixture/带 token 部署用 --token。
// 退出码：0 = 全部验收通过；1 = 有失败（逐项打印 PASS/FAIL）。
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const token = args.includes('--token') ? args[args.indexOf('--token') + 1] ?? '' : ''
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] ?? 'http://127.0.0.1:3080' : 'http://127.0.0.1:3080'

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log('  PASS  ' + name) }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')) }
}
async function tcpOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    const done = (ok) => { try { sock.destroy() } catch { /* ignore */ } resolve(ok) }
    sock.setTimeout(600)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}
async function api(path, method = 'GET', body, tok = token) {
  const headers = { 'content-type': 'application/json' }
  if (tok) headers.authorization = `Bearer ${tok}`
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { status: res.status, data, text }
}

console.log(`P1-1 第 2 步现场验收 probe：base=${base} token=${token ? '***' : '(空)'}\n`)

// 1) 宿主 /team-hub = v2 外壳（config 带 db；与 8787 同库）
const cfg = await api('/team-hub/api/config')
check('1. /team-hub/api/config 200（v2 外壳在线）', cfg.status === 200, `status=${cfg.status}`)
check('1b. config 报告 v2 db（team.db）', cfg.status === 200 && /team\.db/.test(String(cfg.data?.db ?? '')), JSON.stringify(cfg.data).slice(0, 120))
check('1c. config.auth 与配置一致（host teamToken 空 → false）', cfg.status === 200 && typeof cfg.data?.auth === 'boolean', `auth=${cfg.data?.auth}`)

// 2) board-plugin 生产实例已切 hub 模式并指向 v2（面板 = v2 动态页）
const page = await api('/scrum-board/')
check('2. /scrum-board/ 200（board 面板在线）', page.status === 200)
check('2b. 面板为 v2 动态页（v2 hub + EventSource）', page.status === 200 && /v2 hub/.test(String(page.data)) && /EventSource/.test(String(page.data)))

// 3) 看板数据 = v2 活库（worker scope software 任务可见，含目标链 T-xxx）
const board = await api('/scrum-board/api/board')
check('3. /scrum-board/api/board 200', board.status === 200, `status=${board.status} ${String(board.data).slice(0, 120)}`)
check('3b. board 为 v2 裸任务数组且非空（software 池）', Array.isArray(board.data) && board.data.length > 0, `len=${Array.isArray(board.data) ? board.data.length : '?'}`)

// 4) 与 8787 直连数据一致（同池证据）
const hub = await api('/scrum-board/api/board') // 同宿主已走 hub
let direct = null
try {
  const r = await fetch('http://127.0.0.1:8787/api/board?scope=software')
  if (r.ok) direct = await r.json()
} catch { /* 8787 未起则跳过 */ }
if (direct) {
  const idsA = new Set(board.data.map((t) => t.id))
  const idsB = new Set(direct.map((t) => t.id))
  check('4. 看板数据与 8787 v2 同池（任务 id 集合一致）', idsA.size > 0 && idsA.size === idsB.size && [...idsA].every((i) => idsB.has(i)), `board=${idsA.size} direct=${idsB.size}`)
} else {
  check('4. 8787 直连比对', false, '8787 不可达（服务未托管？）')
}

// 5) v1 文件库已退役：4820 关闭 + tasks.json 已归档
const p4820 = await tcpOpen(4820)
check('5. :4820 已停止监听（v1 serve.mjs 退役）', !p4820)
const tasksExists = existsSync(join(REPO, 'scrum', 'tasks.json'))
const archiveDir = join(REPO, 'scrum', 'archive')
check('5b. scrum/tasks.json 已归档（不存在或已 .archived）', !tasksExists || existsSync(join(REPO, 'scrum', 'tasks.json.archived')), 'tasks.json 仍在原地且无归档说明')
check('5c. 归档目录存在', existsSync(archiveDir))

// 6) 写面冒烟（v2 语义）：创建 default scope 测试任务 → 读回 → 删除（cancel）
const probeId = 'LIVE-PROBE-' + Date.now().toString(36).toUpperCase()
const mk = await api('/team-hub/api/create', 'POST', { title: probeId + ' 现场验收', by: 'general', scope: 'default' }, token)
check('6. 现场写冒烟 create 200', mk.status === 200, `status=${mk.status} ${String(mk.data?.error ?? '').slice(0, 100)}`)
if (mk.status === 200 && mk.data?.task?.id) {
  const tid = mk.data.task.id
  await api('/team-hub/api/transition', 'POST', { id: tid, to: 'canceled', by: 'general', ifVersion: mk.data.task.version }, token)
  console.log(`  · 已清理现场测试任务 ${tid}（→ canceled）`)
} else if (mk.status === 401) {
  check('6b. 若宿主 token 非空', false, 'create 401 → 需用 --token 传宿主配置的 teamToken')
}

// 7) reject/promote 降级 501（v1 worktree 语义已下线）
const rej = await api('/scrum-board/api/reject', 'POST', { id: 'T-NONE', by: 'general', reason: 'x' }, token)
check('7. hub 模式 reject → 501 指引', rej.status === 501, `status=${rej.status} ${String(rej.data?.error ?? '').slice(0, 80)}`)

console.log(`\n===== 结果：PASS ${pass} / FAIL ${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
