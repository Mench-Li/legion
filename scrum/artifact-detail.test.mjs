// scrum/artifact-detail.test.mjs — R-4/S6 经典看板详情逐条可交互（服务态）契约测试。
// 运行：node scrum/artifact-detail.test.mjs（node:test 内联执行；不依赖 node --test 的 spawn 子进程）
// fixture 仿 taskctl.ttl.test.mjs：临时任务库经 env 注入（LEGION_TASKS_FILE / LEGION_SCRUM_DIR /
// LEGION_ARTIFACT_ROOT），serve.mjs 以 import 方式加载（非 main：不 watch、不 listen），测试自清真实数据不受影响。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
const renderFile = join(here, 'render.mjs')
const serveFile = join(here, 'serve.mjs')

const tmp = mkdtempSync(join(tmpdir(), 'legion-artifact-detail-'))
const scrumDir = join(tmp, 'scrum')
const artRoot = join(tmp, 'repo')
mkdirSync(join(scrumDir, 'patches'), { recursive: true })
mkdirSync(join(artRoot, 'docs'), { recursive: true })
mkdirSync(join(artRoot, 'out'), { recursive: true })
mkdirSync(join(artRoot, '.legion-worktrees', 'T-200', 'docs'), { recursive: true })

const T0 = '2026-09-01T00:00:00.000Z'
const T1 = '2026-09-02T00:00:00.000Z'

// 主仓库根文件（主分支态）
writeFileSync(join(artRoot, 'docs', 'x.md'), '# 方案\nMAIN 主仓内容\n', 'utf8')
writeFileSync(join(artRoot, 'docs', 'main.md'), 'MAIN-ONLY\n', 'utf8')
writeFileSync(join(artRoot, 'out', 'a.html'), '<p>AA</p>', 'utf8')
writeFileSync(join(artRoot, 'out', 'b.html'), '<p>BB</p>', 'utf8')
// 分支态（未 promote）：.legion-worktrees/<taskId>/ 优先
writeFileSync(join(artRoot, '.legion-worktrees', 'T-200', 'docs', 'x.md'), '# 方案\nBRANCH 分支态 v2\n', 'utf8')

function task(id, artifacts, status = 'in_review') {
  return {
    id, title: 'fixture ' + id, description: '', acceptance: [], priority: 'medium',
    status, version: 1, soldier: null, claimedRound: null, claimedAt: null, parent: null,
    role: 'requirement', scope: 'default', hold: false, blocks: [], blockedBy: [],
    comments: [], evidence: [], patches: [], artifacts, progress: [], updatedAt: T1,
  }
}

const tasks = {
  'T-200': task('T-200', [
    { by: 'soldier-auto', at: T0, kind: 'file', path: 'docs/x.md', title: '需求文档（md）' },
    { by: 'soldier-auto', at: T0, kind: 'html', path: 'out/a.html', title: 'A 预览页' },
    { by: 'soldier-auto', at: T0, kind: 'url', path: 'https://example.test/x', title: '外部参考' },
    { by: 'soldier-auto', at: T1, kind: 'html', path: 'out/b.html', title: 'B 预览页' },
  ]),
  'T-MAIN': task('T-MAIN', [{ by: 'soldier-auto', at: T1, kind: 'file', path: 'docs/main.md', title: '主仓 md' }]),
  'T-EMPTY': task('T-EMPTY', []),
  'T-MISSING': task('T-MISSING', [{ by: 'soldier-auto', at: T0, kind: 'file', path: 'docs/nope.md', title: '不存在' }]),
  'T-EVIL': task('T-EVIL', [{ by: 'soldier-auto', at: T0, kind: 'file', path: '../secret.md' }]),
  'T-EVILABS': task('T-EVILABS', [{ by: 'soldier-auto', at: T0, kind: 'file', path: 'C:/Windows/win.ini' }]),
  'T-GIT': task('T-GIT', [{ by: 'soldier-auto', at: T0, kind: 'file', path: '.git/config' }]),
}
writeFileSync(join(scrumDir, 'tasks.json'), JSON.stringify({ schemaVersion: 1, nextId: 999, tasks }, null, 2), 'utf8')

let mod = null
let base = ''
let server = null

before(async () => {
  process.env.LEGION_SCRUM_DIR = scrumDir
  process.env.LEGION_ARTIFACT_ROOT = artRoot
  process.env.LEGION_TASKS_FILE = join(scrumDir, 'tasks.json')
  mod = await import(pathToFileURL(serveFile).href)
  server = mod.server
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const addr = server.address()
  base = 'http://127.0.0.1:' + addr.port
})

after(() => {
  try { if (server) server.close() } catch { /* 已关闭 */ }
  rmSync(tmp, { recursive: true, force: true })
})

async function getArtifact(qs) {
  const res = await fetch(base + '/api/artifact?' + qs)
  let body = null
  try { body = await res.json() } catch { /* 非 JSON（raw/302） */ }
  return { status: res.status, ct: res.headers.get('content-type'), body }
}

describe('render.mjs：产物区逐条可交互（AC-R4-1/2，K8-A）', () => {
  it('fixture 任务库经 --out 生成 kanban.html：产物区代码含逐条条目生成器与预览/降级分支，旧版“只最新一条”已移除', () => {
    const out = join(tmp, 'out')
    const run = spawnSync(process.execPath, [renderFile, '--out', out], {
      env: { ...process.env, LEGION_TASKS_FILE: join(scrumDir, 'tasks.json') },
      stdio: 'ignore', encoding: 'utf8',
    })
    assert.equal(run.status, 0, 'node scrum/render.mjs --out 应成功')
    const html = readFileSync(join(out, 'kanban.html'), 'utf8')
    assert.ok(html.includes('function artifactSection(c)'), '含逐条条目生成函数 artifactSection')
    assert.ok(html.includes('function wireArtifacts(overlay, taskId)'), '含逐条预览开关 wireArtifacts')
    assert.ok(html.includes('wireArtifacts(overlay, c.id)'), 'detailModal 打开时接线逐条预览')
    assert.ok(html.includes('data-artact'), '条目按钮带 data-artact 动作标记')
    assert.ok(html.includes('▶ html 预览'), 'html 条目有独立预览入口（多条不再只最新）')
    assert.ok(html.includes('▶ 预览'), 'md/txt 条目有预览动作')
    assert.ok(html.includes('打开链接 ↗'), 'url 条目保留外链')
    assert.ok(html.includes('本地双击（file://）模式无法取回文件内容'), 'file:// 双击模式降级提示存在')
    assert.ok(!html.includes('最新一条可在下方预览'), '旧版“仅最新一条”UI 已移除')
    // board 内嵌 JSON 应含两条 html 产物（AC-R4-2 多条 html 逐条的数据源）
    const m = /<script id="board-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
    assert.ok(m, 'board-data 内嵌存在')
    const board = JSON.parse(m[1])
    const card = board.columns.flatMap(c => c.cards).find(c => c.id === 'T-200')
    assert.ok(card, 'T-200 在生成看板内')
    assert.equal(card.artifacts.length, 4)
    assert.equal(card.artifacts.filter(a => a.kind === 'html').length, 2, '两条 html 均入看板数据')
  })
})

describe('serve.mjs /api/artifact 逐条内容服务（AC-R4-1 / K4-B）', () => {
  it('i=0 元信息 + raw 返回分支态 md 全文（worktree 优先，content-type text/markdown）', async () => {
    const meta = await getArtifact('task=T-200&i=0')
    assert.equal(meta.status, 200)
    assert.equal(meta.body.i, 0)
    assert.equal(meta.body.kind, 'file')
    assert.equal(meta.body.total, 4)
    assert.equal(meta.body.exists, true)
    const raw = await fetch(base + '/api/artifact?task=T-200&i=0&raw=1')
    assert.equal(raw.status, 200)
    assert.match(raw.headers.get('content-type') ?? '', /^text\/markdown/)
    const text = await raw.text()
    assert.ok(text.includes('BRANCH 分支态 v2'), '分支态目录文件优先读取')
  })
  it('主仓兜底：无分支态文件时读主仓库根并返回全文', async () => {
    const raw = await fetch(base + '/api/artifact?task=T-MAIN&i=0&raw=1')
    assert.equal(raw.status, 200)
    assert.equal(await raw.text(), 'MAIN-ONLY\n')
  })
  it('两条 html 逐条独立可预览（i=1、i=3 各自返回对应文件，text/html）', async () => {
    for (const [i, needle] of [[1, 'AA'], [3, 'BB']]) {
      const raw = await fetch(base + '/api/artifact?task=T-200&i=' + i + '&raw=1')
      assert.equal(raw.status, 200)
      assert.match(raw.headers.get('content-type') ?? '', /^text\/html/)
      assert.ok((await raw.text()).includes('<p>' + needle + '</p>'))
    }
  })
  it('i 缺省兼容既有语义取最新一条（idx=total-1）', async () => {
    const meta = await getArtifact('task=T-200')
    assert.equal(meta.status, 200)
    assert.equal(meta.body.i, 3)
    assert.equal(meta.body.kind, 'html')
  })
  it('url 产物保留外链语义：raw 缺省返回 {url:true} 元信息', async () => {
    const meta = await getArtifact('task=T-200&i=2')
    assert.equal(meta.status, 200)
    assert.equal(meta.body.url, true)
    assert.equal(meta.body.path, 'https://example.test/x')
  })
  it('越界/非法 i → 400 可区分；未知任务 404；无产物 404', async () => {
    const over = await getArtifact('task=T-200&i=9')
    assert.equal(over.status, 400)
    assert.match(over.body.error, /越界/)
    const bad = await getArtifact('task=T-200&i=abc')
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /非法/)
    assert.equal((await getArtifact('task=T-UNKNOWN&i=0')).status, 404)
    assert.equal((await getArtifact('task=T-EMPTY&i=0')).status, 404)
  })
  it('白名单安全：../ 越权、根外盘符、.git 段 → 403 可区分（AC-R3-3 v1 面）', async () => {
    for (const [taskId, errRe] of [['T-EVIL', /不在允许根内/], ['T-EVILABS', /不在允许根内/], ['T-GIT', /不在允许根内/]]) {
      const r = await getArtifact('task=' + taskId + '&i=0&raw=1')
      assert.equal(r.status, 403)
      assert.match(r.body.error, errRe)
    }
  })
  it('文件不存在（主仓与分支态均无）→ 404 明确文案', async () => {
    const r = await getArtifact('task=T-MISSING&i=0&raw=1')
    assert.equal(r.status, 404)
    assert.match(r.body.error, /不存在/)
  })
  it('file 产物（非 html/md/txt）raw → application/octet-stream 下载语义', async () => {
    writeFileSync(join(artRoot, 'out', 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]))
    const t = task('T-BIN', [{ by: 'soldier-auto', at: T0, kind: 'file', path: 'out/blob.bin', title: '二进制' }])
    const raw2 = readFileSync(join(scrumDir, 'tasks.json'), 'utf8')
    const db = JSON.parse(raw2)
    db.tasks['T-BIN'] = t
    writeFileSync(join(scrumDir, 'tasks.json'), JSON.stringify(db, null, 2), 'utf8')
    const r = await fetch(base + '/api/artifact?task=T-BIN&i=0&raw=1')
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type') ?? '', /application\/octet-stream/)
    assert.equal((await r.arrayBuffer()).byteLength, 3)
  })
})
