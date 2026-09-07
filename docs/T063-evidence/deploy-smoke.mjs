// deploy-smoke.mjs — T-063 devops: real-process boot smoke for S3 /api/files list/read/download
// Spawns `node scripts/serve.mjs` (the isMain path) as a child process, then verifies the S3 read-only endpoints
// over real HTTP. Requires only Node builtins. Run: node docs/T063-evidence/deploy-smoke.mjs
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const PORT = 5199
const workbench = new URL('../../workbench/', import.meta.url).pathname.replace(/^\//, '')
const tmp = mkdtempSync(join(tmpdir(), 'legion-deploy-smoke-'))
const repo = join(tmp, 'repo')
mkdirSync(join(repo, 'docs'), { recursive: true })
mkdirSync(join(repo, '.git'), { recursive: true })
writeFileSync(join(repo, 'README.md'), 'hello deploy world\n')
writeFileSync(join(repo, 'docs', 'guide.txt'), 'guide payload')
writeFileSync(join(repo, '.git', 'config'), '[core]')

const spacesJson = JSON.stringify([{ id: 'smoke', name: 'smoke', localDir: repo.replace(/\\/g, '/') }])
console.log('FIXTURE=' + repo)
console.log('SPACES_JSON=' + spacesJson)

const child = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: workbench,
  env: { ...process.env, DSH_WORKBENCH_SPACES_JSON: spacesJson, DSH_WORKBENCH_PORT: String(PORT), DSH_WORKBENCH_HOST: '127.0.0.1' },
  stdio: 'inherit',
})

const base = 'http://127.0.0.1:' + PORT
async function json(path, { mode = 'json' } = {}) {
  const res = await fetch(base + path)
  const text = await res.text()
  if (mode === 'json') { let body = null; try { body = JSON.parse(text) } catch {} ; return { status: res.status, body } }
  return { status: res.status, body: text }
}

// wait for readiness
let up = false
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(base + '/api/files/list?scope=smoke&path='); if (r.status === 200) { up = true; break } } catch {} 
  await new Promise((r) => setTimeout(r, 200))
}
console.log('UP=' + up)
if (!up) { console.log('SERVER DID NOT COME UP'); child.kill('SIGKILL'); rmSync(tmp, { recursive: true, force: true }); process.exit(1) }

const list = await json('/api/files/list?scope=smoke&path=')
console.log('LIST_HTTP=' + list.status)
console.log('LIST_BODY=' + JSON.stringify(list.body))
const names = (list.body?.entries ?? []).map(e => e.name)
console.log('LIST_NAMES=' + JSON.stringify(names))
console.log('LIST_DIRS_FIRST=' + ((list.body?.entries ?? []).filter(e=>e.type==='dir').length > 0))

const rd = await json('/api/files/read?scope=smoke&path=README.md')
console.log('READ_HTTP=' + rd.status)
console.log('READ_BODY=' + JSON.stringify(rd.body))

// download byte fidelity
const dlResp = await fetch(base + '/api/files/download?scope=smoke&path=README.md')
const dlBuf = Buffer.from(await dlResp.arrayBuffer())
const srcBuf = readFileSync(join(repo, 'README.md'))
const byteMatch = srcBuf.length === dlBuf.length && srcBuf.equals(dlBuf)
console.log('DL_HTTP=' + dlResp.status + ' DISPOSITION=' + dlResp.headers.get('content-disposition') + ' CONTENT_TYPE=' + dlResp.headers.get('content-type'))
console.log('DL_BYTE_MATCH=' + byteMatch + ' srcLen=' + srcBuf.length + ' dlLen=' + dlBuf.length)

const git = await json('/api/files/read?scope=smoke&path=.git/config')
console.log('GIT_READ_HTTP=' + git.status + ' GIT_BODY=' + JSON.stringify(git.body))

const nb = await json('/api/files/list?scope=nobind&path=')
console.log('NOBIND_HTTP=' + nb.status)
console.log('NOBIND_BODY=' + JSON.stringify(nb.body))

const ghost = await json('/api/files/read?scope=smoke&path=nope.txt')
console.log('GHOST_HTTP=' + ghost.status + ' GHOST_BODY=' + JSON.stringify(ghost.body))

const trav = await json('/api/files/read?scope=smoke&path=..%2Foutside.txt')
console.log('TRAVERSAL_HTTP=' + trav.status + ' TRAVERSAL_BODY=' + JSON.stringify(trav.body))

child.kill('SIGKILL')
rmSync(tmp, { recursive: true, force: true })
console.log('DONE')