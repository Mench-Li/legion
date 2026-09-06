// docs/T107-evidence/s3-l1-smoke.mjs — R-3/S3 hub 内容端点真实 HTTP L1 冒烟（零外部依赖）。
// 启动一个临时 team-hub 进程（临时库+临时仓库根 fixture）→ 经 HTTP 建空间/建任务/登记产物 →
// GET /api/artifact/content 验证主路径与错误码；输出要点写 docs/T107-evidence/s3-l1-smoke.txt。
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, mkdirSync as mk } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const hubFile = join(repo, 'team-hub', 'server.mjs')
const port = 18797
const outLines = []
const say = (line) => { outLines.push(line); console.log(line) }

const tmp = mkdtempSync(join(tmpdir(), 'hub-s3-l1-'))
const repoRoot = join(tmp, 'repo')
mkdirSync(join(repoRoot, 'docs'), { recursive: true })
mkdirSync(join(repoRoot, '.legion-worktrees', 'T-001', 'docs'), { recursive: true })
writeFileSync(join(repoRoot, 'docs', 'x.md'), 'MAIN-1\n', 'utf8')
writeFileSync(join(repoRoot, '.legion-worktrees', 'T-001', 'docs', 'x.md'), 'BRANCH-L1\n', 'utf8')
const dbFile = join(tmp, 'team.db')
const logFile = join(tmp, 'hub.log')

const child = spawn(process.execPath, [hubFile], {
  env: { ...process.env, TEAM_HUB_PORT: String(port), TEAM_HUB_DB: dbFile },
  stdio: ['ignore', 'ignore', 'ignore'],
})
const base = 'http://127.0.0.1:' + port
let exitCode = 1
try {
  // wait for server up
  let up = false
  for (let k = 0; k < 50; k += 1) {
    try { const r = await fetch(base + '/api/config'); if (r.ok) { up = true; break } } catch { /* not yet */ }
    await new Promise(res => setTimeout(res, 200))
  }
  if (!up) throw new Error('hub 未在 ' + port + ' 启动')

  async function post(path, body) {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }
  async function getArt(path) {
    const r = await fetch(base + path)
    const ct = r.headers.get('content-type') ?? ''
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = text.slice(0, 60) }
    return { status: r.status, ct, body }
  }

  // 1) 空间绑定（boundLocalDirFor 用 local_dir 定位仓库根）
  const sp = await post('/api/spaces', { id: 'software', name: '软件流水线', by: 'general', localDir: repoRoot })
  say('POST /api/spaces → ' + sp.status + (sp.body?.ok ? ' ok' : ' ' + JSON.stringify(sp.body).slice(0, 120)))
  // 2) 建任务（空库 → T-001）
  const cr = await post('/api/create', { by: 'general', title: 'S3 L1 冒烟', role: 'requirement', scope: 'software' })
  const taskId = cr.body?.task?.id ?? (cr.body?.error ? '' : '')
  say('POST /api/create → ' + cr.status + ' id=' + taskId)
  if (!taskId) throw new Error('建任务失败：' + JSON.stringify(cr.body))
  // 3) 登记契约产物（相对路径 + 内容在分支态 worktree 目录）
  const D64 = 'b'.repeat(64)
  const ar = await post('/api/artifact', { id: taskId, by: 'soldier-auto', kind: 'file', path: 'docs/x.md', title: '需求文档', digest: D64, scope: 'software' })
  const getT = await getArt('/api/task?id=' + taskId)
  const stored = getT.body?.task?.artifacts ?? getT.body?.artifacts ?? []
  say('digest 落库校验: ' + (stored[0]?.digest === D64 ? 'PASS' : 'FAIL got=' + JSON.stringify(stored[0])))
  say('POST /api/artifact → ' + ar.status)
  // 4) 主路径：GET content（worktree 分支态优先 → BRANCH-L1）
  const g1 = await getArt('/api/artifact/content?task=' + taskId + '&i=0')
  say('GET /api/artifact/content?task=' + taskId + '&i=0 → status=' + g1.status + ' ct=' + g1.ct)
  say('  body=' + JSON.stringify(g1.body).slice(0, 200))
  // 5) 错误码：越界 400 / 未知任务 404
  const g2 = await getArt('/api/artifact/content?task=' + taskId + '&i=9')
  say('i=9 → status=' + g2.status + ' error=' + (g2.body?.error ?? ''))
  const g3 = await getArt('/api/artifact/content?task=T-NOPE&i=0')
  say('未知任务 → status=' + g3.status + ' error=' + (g3.body?.error ?? ''))
  if (g1.status !== 200 || !String(g1.body?.content ?? '').includes('BRANCH-L1')) throw new Error('主路径断言失败')
  if (g2.status !== 400) throw new Error('越界错误码断言失败')
  if (g3.status !== 404) throw new Error('未知任务错误码断言失败')
  say('RESULT: PASS')
  exitCode = 0
} catch (e) {
  say('RESULT: FAIL — ' + (e instanceof Error ? e.message : String(e)))
} finally {
  child.kill()
  await new Promise(res => setTimeout(res, 300))
  rmSync(tmp, { recursive: true, force: true })
  const target = join(here, 's3-l1-smoke.txt')
  writeFileSync(target, outLines.join('\n') + '\n', 'utf8')
  console.log('log written: ' + target)
  process.exit(exitCode)
}
