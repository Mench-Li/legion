// workbench/scripts/reveal-open.test.mjs —— 「打开所在位置」契约测试（POST /api/files/reveal）。
//
// 覆盖：① 落点计算（文件=选中 / 目录=打开 / ''=空间根）与平台打开器；② 目标不存在时回落到根内最近既有祖先
// 并回传 missing（产物登记后 worktree 被回收的常态）；③ 安全矩阵与读面同强度——根内越界 / 绝对路径 /
// 符号链接逃逸 / .git 内部一律拒绝，且鉴权（写令牌）不能替代路径校验；④ 未注册/未绑定空间给可理解引导。
//
// 不真的拉起文件管理器：DSH_WORKBENCH_REVEAL_DRY=1 → 服务端只回传将要执行的 opener/args 与落点
// （dry-run 是 serve.mjs 的测试注入口，与 DSH_WORKBENCH_SPACES_JSON / DSH_WORKBENCH_TOKEN 同法）。
// 运行：node workbench/scripts/reveal-open.test.mjs
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const serveUrl = pathToFileURL(require.resolve('./serve.mjs')).href + '?reveal=' + Date.now()

// 两个实例：plain（未配 token，写放行）+ tok（DSH_WORKBENCH_TOKEN=tk，鉴权矩阵）
process.env.DSH_WORKBENCH_REVEAL_DRY = '1'
delete process.env.DSH_WORKBENCH_TOKEN
const m = await import(serveUrl)
process.env.DSH_WORKBENCH_TOKEN = 'tk'
const mTok = await import(serveUrl + '&tok=1')
delete process.env.DSH_WORKBENCH_TOKEN

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-reveal-'))
const root = join(tmpRoot, 'repo')
const outsideDir = join(tmpRoot, 'outside')
const BS = String.fromCharCode(92)
let linkOutMade = false

before(() => {
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'nested', 'deep'), { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'config'), '[core]')
  writeFileSync(join(root, 'docs', 'guide.txt'), 'guide')
  writeFileSync(join(root, 'nested', 'deep', 'produced.md'), '# 产出')
  mkdirSync(outsideDir, { recursive: true })
  writeFileSync(join(outsideDir, 'secret.txt'), 'secret')
  try { symlinkSync(outsideDir, join(root, 'link-out'), 'junction'); linkOutMade = true } catch { /* 无权限则跳过 */ }
  process.env.DSH_WORKBENCH_SPACES_JSON = JSON.stringify([{ id: 'fx', name: '文件夹具', localDir: root }])
})

const bases = { plain: '', token: '' }
before(async () => {
  const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  await listen(m.server); bases.plain = 'http://127.0.0.1:' + m.server.address().port
  await listen(mTok.server); bases.token = 'http://127.0.0.1:' + mTok.server.address().port
})

after(() => {
  delete process.env.DSH_WORKBENCH_SPACES_JSON
  delete process.env.DSH_WORKBENCH_REVEAL_DRY
  for (const srv of [m.server, mTok.server]) {
    try { srv.closeAllConnections?.() } catch { /* 无连接 */ }
    try { srv.close() } catch { /* 已关 */ }
  }
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function reveal(base, body, headers = {}) {
  const res = await fetch(base + '/api/files/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

const rRoot = () => realpathSync(root)

describe('① 落点计算 + 平台打开器（dry-run 断言真实将执行的命令）', () => {
  it('文件 → kind=file，落点=该文件，打开器选中该文件（Windows: explorer.exe /select,<abs>）', async () => {
    const r = await reveal(bases.plain, { scope: 'fx', path: 'docs/guide.txt' })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, true)
    assert.equal(r.json.kind, 'file')
    assert.equal(r.json.abs, join(rRoot(), 'docs', 'guide.txt'))
    assert.equal(r.json.dir, join(rRoot(), 'docs'))
    assert.equal(r.json.missing, false)
    assert.equal(r.json.dryRun, true, 'dry-run：只回传命令，不真的拉起')
    assert.equal(r.json.spawned, false)
    if (process.platform === 'win32') {
      assert.equal(r.json.opener, 'explorer.exe')
      assert.deepEqual(r.json.args, ['/select,' + join(rRoot(), 'docs', 'guide.txt')])
    } else if (process.platform === 'darwin') {
      assert.equal(r.json.opener, 'open')
      assert.deepEqual(r.json.args, ['-R', join(rRoot(), 'docs', 'guide.txt')])
    } else {
      assert.equal(r.json.opener, 'xdg-open')
      assert.deepEqual(r.json.args, [join(rRoot(), 'docs')], 'Linux 无统一「选中」入口 → 打开所在目录')
    }
  })

  it('目录 → kind=dir，直接打开该目录（不是选中）', async () => {
    const r = await reveal(bases.plain, { scope: 'fx', path: 'nested/deep' })
    assert.equal(r.status, 200)
    assert.equal(r.json.kind, 'dir')
    assert.equal(r.json.abs, join(rRoot(), 'nested', 'deep'))
    assert.equal(r.json.dir, join(rRoot(), 'nested', 'deep'))
    if (process.platform === 'win32') assert.deepEqual(r.json.args, [join(rRoot(), 'nested', 'deep')])
  })

  it("path='' / '.' → 空间根目录本身（文件中心「打开空间目录」）", async () => {
    for (const p of ['', '.', './']) {
      const r = await reveal(bases.plain, { scope: 'fx', path: p })
      assert.equal(r.status, 200)
      assert.equal(r.json.kind, 'dir')
      assert.equal(r.json.abs, rRoot())
      assert.equal(r.json.dir, rRoot())
      assert.equal(r.json.missing, false)
    }
  })
})

describe('② 目标不存在 → 回落到根内最近既有祖先并回传 missing（不报错）', () => {
  it('docs/missing.md（父目录存在）→ 落点=docs 目录 + missing=true', async () => {
    const r = await reveal(bases.plain, { scope: 'fx', path: 'docs/missing.md' })
    assert.equal(r.status, 200)
    assert.equal(r.json.missing, true)
    assert.equal(r.json.kind, 'dir')
    assert.equal(r.json.abs, join(rRoot(), 'docs'))
  })

  it('gone/deep/produced.md（整条链都不存在）→ 落点=空间根 + missing=true', async () => {
    const r = await reveal(bases.plain, { scope: 'fx', path: 'gone/deep/produced.md' })
    assert.equal(r.status, 200)
    assert.equal(r.json.missing, true)
    assert.equal(r.json.abs, rRoot())
    assert.ok(r.json.abs.startsWith(rRoot()), '回落点绝不越出空间根')
  })
})

describe('③ 安全矩阵：根内越界 / 绝对路径 / .git / 符号链接逃逸一律拒（与读面同强度）', () => {
  it('相对路径越界（../、..\\、深层 ../）→ 拒绝且不泄漏根外路径', async () => {
    for (const p of ['../outside/secret.txt', 'docs/../../outside/secret.txt', '..' + BS + 'outside' + BS + 'secret.txt']) {
      const r = await reveal(bases.plain, { scope: 'fx', path: p })
      assert.ok([400, 403].includes(r.status), `${p} 应被拒（实际 ${r.status}）`)
      assert.match(r.json.error, /越界|相对路径/)
      assert.ok(!String(r.json.abs ?? '').includes('secret'), '拒绝响应不带根外落点')
    }
  })

  it('绝对路径（盘符 / 前导斜杠）→ 拒绝', async () => {
    for (const p of ['C:' + BS + 'Windows', '/etc/passwd']) {
      const r = await reveal(bases.plain, { scope: 'fx', path: p })
      assert.ok([400, 403].includes(r.status), `${p} 应被拒（实际 ${r.status}）`)
      assert.match(r.json.error, /相对路径|越界/)
    }
  })

  it('.git 内部 → 403（防凭证/元数据经「打开所在位置」外泄）', async () => {
    const r = await reveal(bases.plain, { scope: 'fx', path: '.git/config' })
    assert.equal(r.status, 403)
    assert.match(r.json.error, /\.git/)
  })

  it('NUL 字符 → 400 且进程存活', async () => {
    const r = await reveal(bases.plain, { scope: 'fx', path: 'docs/' + String.fromCharCode(0) + 'x.txt' })
    assert.equal(r.status, 400)
    const alive = await reveal(bases.plain, { scope: 'fx', path: 'docs/guide.txt' })
    assert.equal(alive.status, 200, '拒绝畸形输入后服务仍可用')
  })

  it('符号链接逃逸（junction 指向根外）→ 403', async (t) => {
    if (!linkOutMade) { t.skip('本机无创建 junction 权限'); return }
    const r = await reveal(bases.plain, { scope: 'fx', path: 'link-out/secret.txt' })
    assert.equal(r.status, 403)
    assert.match(r.json.error, /符号链接|越界/)
  })

  it('非 POST（GET）→ 不匹配路由（404），不会触发打开动作', async () => {
    const res = await fetch(bases.plain + '/api/files/reveal?scope=fx&path=docs/guide.txt')
    assert.equal(res.status, 404)
  })
})

describe('④ 写令牌鉴权：配 token 时无 Bearer 401、带 Bearer 200；鉴权不替代路径校验', () => {
  it('无 Authorization → 401', async () => {
    const r = await reveal(bases.token, { scope: 'fx', path: 'docs/guide.txt' })
    assert.equal(r.status, 401)
    assert.match(r.json.error, /token/)
  })

  it('错误 Bearer → 401', async () => {
    const r = await reveal(bases.token, { scope: 'fx', path: 'docs/guide.txt' }, { authorization: 'Bearer nope' })
    assert.equal(r.status, 401)
  })

  it('正确 Bearer → 200 且落点正确', async () => {
    const r = await reveal(bases.token, { scope: 'fx', path: 'nested/deep/produced.md' }, { authorization: 'Bearer tk' })
    assert.equal(r.status, 200)
    assert.equal(r.json.abs, join(rRoot(), 'nested', 'deep', 'produced.md'))
  })

  it('带正确 token 仍拒绝越界（鉴权 ≠ 路径校验）', async () => {
    const r = await reveal(bases.token, { scope: 'fx', path: '../outside/secret.txt' }, { authorization: 'Bearer tk' })
    assert.ok([400, 403].includes(r.status))
    assert.match(r.json.error, /越界|相对路径/)
  })
})

describe('⑤ 空间解析失败 → 可理解引导（未注册 / 未绑定 / 缺 scope）', () => {
  it('未注册空间 → 400 + 「未注册」引导', async () => {
    const r = await reveal(bases.plain, { scope: 'ghost', path: 'docs/guide.txt' })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /未注册：请先在空间设置/)
  })

  it('未绑定本地文件夹 → 400 + 「尚未绑定」引导', async () => {
    process.env.DSH_WORKBENCH_SPACES_JSON = JSON.stringify([{ id: 'nobind', name: 'x', localDir: '' }])
    const r = await reveal(bases.plain, { scope: 'nobind', path: 'docs/guide.txt' })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /尚未绑定本地文件夹/)
    process.env.DSH_WORKBENCH_SPACES_JSON = JSON.stringify([{ id: 'fx', name: '文件夹具', localDir: root }])
  })

  it('缺 scope → 400 且提示缺少参数', async () => {
    const r = await reveal(bases.plain, { path: 'docs/guide.txt' })
    assert.equal(r.status, 400)
    assert.match(r.json.error, /scope/)
  })
})

describe('⑥ 纯函数 planReveal 直测（不依赖 HTTP）', () => {
  it('同一目标：文件/目录/根 三态 + missing 旗标', async () => {
    const r = await m.resolveScopeLocalDir('fx')
    assert.deepEqual(m.planReveal(r, 'docs/guide.txt'), { abs: join(rRoot(), 'docs', 'guide.txt'), rel: 'docs/guide.txt', kind: 'file', missing: false })
    assert.deepEqual(m.planReveal(r, 'nested'), { abs: join(rRoot(), 'nested'), rel: 'nested', kind: 'dir', missing: false })
    assert.deepEqual(m.planReveal(r, ''), { abs: rRoot(), rel: '', kind: 'dir', missing: false })
    assert.equal(m.planReveal(r, 'docs/ghost.md').missing, true)
  })

  it('反斜杠分隔的产物路径同样解析（Windows 登记习惯）', async () => {
    const r = await m.resolveScopeLocalDir('fx')
    const p = m.planReveal(r, 'nested' + BS + 'deep' + BS + 'produced.md')
    assert.equal(p.abs, join(rRoot(), 'nested', 'deep', 'produced.md'))
    assert.equal(p.kind, 'file')
  })

  it('dirname 兜底：文件落点的 dir 是其所在目录', async () => {
    const r = await m.resolveScopeLocalDir('fx')
    const plan = m.planReveal(r, 'docs/guide.txt')
    assert.equal(dirname(plan.abs), join(rRoot(), 'docs'))
  })
})
