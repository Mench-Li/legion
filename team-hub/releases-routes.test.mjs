// team-hub/releases-routes.test.mjs —— 发布目录托管
//
// 守的是「给到用户下载」这条链上最容易静默坏掉的三处：
//   · 缓存策略：通道清单必须每次回源，发布目录必须能长缓存（两者**相反**）；
//   · 续传：安装包上百 MB，不认识 Range 就等于"断了从头再来"；
//   · 只链接**确实存在**的文件：门口页那条纪律不能只在门口页成立。
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createReleaseRoutes, latestInstaller, manifestSha256, readReleaseManifest } from './routes/releases.mjs'

/** 造一个发布目录现场。返回 { root, req } 之类的工具。 */
function scene(t, { releaseIds = ['r-2026-10-01', 'r-2026-10-05'], withExe = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'legion-releases-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'feeds', 'stable'), { recursive: true })
  writeFileSync(join(root, 'feeds', 'stable', 'win-x64.json'), JSON.stringify({ version: '1.2.3' }))
  for (const [i, id] of releaseIds.entries()) {
    const dir = join(root, 'releases', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ releaseId: id }))
    if (withExe) writeFileSync(join(dir, 'Legion-Setup-win-x64.exe'), Buffer.alloc(1000, i + 1))
    // mtime 拉开：`latestInstaller` 按"什么时候被放上来"挑最新
    const when = new Date(Date.UTC(2026, 9, 1 + i))
    utimesSync(join(dir, 'manifest.json'), when, when)
    if (withExe) utimesSync(join(dir, 'Legion-Setup-win-x64.exe'), when, when)
  }
  writeFileSync(join(root, 'secret.env'), 'TOKEN=leak')
  return root
}

/** 用假的 req/res 走一次真实 dispatch，并把流出来的字节收全。 */
async function fetchPath(routes, path, { method = 'GET', headers = {} } = {}) {
  const chunks = []
  const outHeaders = {}
  const res = {
    writeHead(status, h) { this.status = status; Object.assign(outHeaders, h) },
    end(body) { if (body !== undefined) chunks.push(Buffer.from(body)); this.ended = true },
    // 流式分支用 pipe：给一个可写接口。
    write(c) { chunks.push(Buffer.from(c)); return true },
    on() { return this },
    once() { return this },
    emit() { return true },
    endCalled: false,
  }
  const handled = await routes.dispatch({ method, url: path, headers }, res, { path })
  // `createReadStream(...).pipe(res)` 是异步的，等一小会儿让数据流出来。
  if (!res.ended) await new Promise((r) => setTimeout(r, 60))
  return { handled, status: res.status, headers: outHeaders, body: Buffer.concat(chunks) }
}

describe('发布目录托管', () => {
  test('① 通道清单 no-store，发布目录可长缓存（两者必须相反）', async (t) => {
    const root = scene(t)
    const routes = createReleaseRoutes({ root })
    const feed = await fetchPath(routes, '/legion/feeds/stable/win-x64.json')
    assert.equal(feed.status, 200)
    // 通道清单每次回源：否则客户端会**一直**看到一个过期的通道，
    // 而"新版本发布了但它看不到"与"还没发布"在界面上长得一样。
    assert.equal(feed.headers['cache-control'], 'no-store')

    const rel = await fetchPath(routes, '/legion/releases/r-2026-10-05/manifest.json')
    assert.equal(rel.status, 200)
    // 发布目录长缓存是安全的，前提正是 `releaseId` 唯一且**不可覆盖**（设计文档 §4）。
    assert.match(rel.headers['cache-control'], /max-age=\d+/)
  })

  test('② Range：206 + content-range，且只回那一段字节', async (t) => {
    const root = scene(t)
    const routes = createReleaseRoutes({ root })
    const p = '/legion/releases/r-2026-10-05/Legion-Setup-win-x64.exe'
    const part = await fetchPath(routes, p, { headers: { range: 'bytes=10-19' } })
    assert.equal(part.status, 206)
    assert.equal(part.headers['content-range'], 'bytes 10-19/1000')
    assert.equal(part.headers['content-length'], '10')
    assert.equal(part.body.length, 10)
    // 整份的字节数也要对得上，否则上面那条可能只是"恰好十字节"。
    const full = await fetchPath(routes, p)
    assert.equal(full.status, 200)
    assert.equal(full.headers['content-length'], '1000')
    assert.equal(full.body.length, 1000)
    // `accept-ranges` 要在**整份**响应里也出现，否则客户端要先试一整次才知道能续。
    assert.equal(full.headers['accept-ranges'], 'bytes')
  })

  test('③ 越界 Range 是 416（带 */size），看不懂的 Range 降级成整份 200', async (t) => {
    const root = scene(t)
    const routes = createReleaseRoutes({ root })
    const p = '/legion/releases/r-2026-10-05/Legion-Setup-win-x64.exe'
    const bad = await fetchPath(routes, p, { headers: { range: 'bytes=5000-' } })
    assert.equal(bad.status, 416)
    assert.equal(bad.headers['content-range'], 'bytes */1000')

    // ★ 看不懂就**忽略**，不是 416。RFC 允许降级，而"看不懂就拒"
    //   会把一个本来能下完的请求变成失败——多段 Range 正是最常见的那一种。
    const weird = await fetchPath(routes, p, { headers: { range: 'bytes=0-10,20-30' } })
    assert.equal(weird.status, 200)
    assert.equal(weird.body.length, 1000)
  })

  test('④ 白名单：不在表里的扩展名一律 404（发布目录与安装包同域，尤其要紧）', async (t) => {
    const root = scene(t)
    const routes = createReleaseRoutes({ root })
    // `.env` 是"运营者往目录里丢文件"时最可能顺手放进去的那一个。
    const leak = await fetchPath(routes, '/legion/secret.env')
    assert.equal(leak.status, 404)
    assert.equal(leak.body.toString(), 'TYPE_NOT_SERVED')
    assert.equal(leak.body.includes('TOKEN=leak'), false)
  })

  test('⑤ 路径穿越被拦下（含编码形式）', async (t) => {
    const root = scene(t)
    const routes = createReleaseRoutes({ root })
    for (const p of ['/legion/../secret.env', '/legion/%2e%2e/secret.env', '/legion/..%2fsecret.env']) {
      const r = await fetchPath(routes, p)
      // 200/403/404 都可以是"拦下了"，**唯一不能**的是把内容发出去。
      assert.equal(r.body.includes('TOKEN=leak'), false, `${p} 泄露了目录外的文件`)
    }
  })

  test('⑥ 目录外的路径与方法不归本族管（否则会把 API 全吞掉）', async (t) => {
    const routes = createReleaseRoutes({ root: scene(t) })
    assert.equal((await fetchPath(routes, '/api/board')).handled, false)
    assert.equal((await fetchPath(routes, '/mobile/')).handled, false)
    assert.equal((await fetchPath(routes, '/legion/x.json', { method: 'POST' })).handled, false)
  })

  test('⑦ HEAD 有同样的头但没有正文', async (t) => {
    const routes = createReleaseRoutes({ root: scene(t) })
    const r = await fetchPath(routes, '/legion/feeds/stable/win-x64.json', { method: 'HEAD' })
    assert.equal(r.status, 200)
    assert.equal(r.body.length, 0)
    assert.ok(Number(r.headers['content-length']) > 0)
  })

  test('⑧ 自定义挂载点可用', async (t) => {
    const routes = createReleaseRoutes({ root: scene(t), mount: '/dl/' })
    assert.equal((await fetchPath(routes, '/dl/feeds/stable/win-x64.json')).status, 200)
    assert.equal((await fetchPath(routes, '/legion/feeds/stable/win-x64.json')).handled, false)
  })
})

describe('挑最新那一份安装包', () => {
  test('挑的是**确实存在 exe** 的最新一份，不是名字最像的那一个', (t) => {
    const root = scene(t, { releaseIds: ['r-old', 'r-new'] })
    const latest = latestInstaller(root)
    assert.equal(latest.releaseId, 'r-new', 'mtime 更晚的那一份才是最新')
    assert.equal(latest.sizeBytes, 1000)
    assert.ok(latest.file.endsWith('Legion-Setup-win-x64.exe'))
  })

  test('只有目录、没有安装包就**不返回**它（门口页那条纪律不能只在那儿成立）', (t) => {
    // 一个"目录在这儿但文件还没传上来"的中间态，必须表现成"没有可下载的"，
    // 而不是给门口页一个点开 404 的链接——只不过这次的假链接是代码生成的。
    const root = scene(t, { releaseIds: ['r-new'], withExe: false })
    assert.equal(latestInstaller(root), null)
  })

  test('目录不存在时返回 null，不抛也不造目录', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'legion-releases-empty-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    assert.equal(latestInstaller(root), null)
    assert.equal(latestInstaller(join(root, 'nope')), null)
  })
})

// ── 发布清单（`releases/<id>/manifest.json`） ────────────────────────────────
//
// 官网的下载区拿它取 sha256 与版本号。守两条：
//   · 读不到 / 字段不对 ⇒ **当作没有**，不是抛错，也不是给一个空值
//     （一个显示成空的校验值看起来像"校验过了"）；
//   · `releaseId` 不能靠它往目录外读。
//
// 注：这里**曾经**还测过 `manifestChanges()`（清单里的 `changes[]`）。
// 业主看过官网后要求撤掉「本次更新」那一块，该函数已随之删除。

describe('读发布清单', () => {
  const SHA = 'b8be07da8fcb0dc6dff3561328ce8385a9193256b8d42ef883d60dce7b0ffee3'

  function withManifest(t, body) {
    const root = mkdtempSync(join(tmpdir(), 'legion-manifest-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    mkdirSync(join(root, 'releases', 'r-1'), { recursive: true })
    writeFileSync(join(root, 'releases', 'r-1', 'manifest.json'), typeof body === 'string' ? body : JSON.stringify(body))
    return root
  }

  test('读到清单：取出 productVersion 与 sha256', (t) => {
    const root = withManifest(t, {
      releaseId: 'r-1', productVersion: '0.1.0',
      artifacts: { installer: { path: 'Legion-Setup-win-x64.exe', sizeBytes: 204641180, sha256: SHA } },
      // 清单独有这个字段；官网已经不显示它了，解析层也不该去读（见文件头）。
      changes: ['把**正文**送到电脑端', '修了鉴权'],
    })
    const m = readReleaseManifest(root, 'r-1')
    assert.equal(m.productVersion, '0.1.0')
    assert.equal(manifestSha256(m), SHA)
  })

  test('★ 缺文件 / 坏 JSON / 非法 releaseId ⇒ null，不抛', (t) => {
    const root = withManifest(t, '{ 这不是 JSON')
    assert.equal(readReleaseManifest(root, 'r-1'), null, '坏 JSON')
    assert.equal(readReleaseManifest(root, 'r-不存在'), null, '没有这份发布')
    assert.equal(readReleaseManifest(root, ''), null, '空 id')
    assert.equal(readReleaseManifest('', 'r-1'), null, '空 root')
    // 不能靠 releaseId 往目录外读。
    assert.equal(readReleaseManifest(root, '../../etc'), null)
    assert.equal(readReleaseManifest(root, 'a/b'), null)
    assert.equal(readReleaseManifest(root, 'a\\b'), null)
  })

  test('★ sha256 只认 64 位十六进制；缺失/畸形一律"没有"', () => {
    assert.equal(manifestSha256({}), '')
    assert.equal(manifestSha256(null), '')
    assert.equal(manifestSha256({ artifacts: { installer: { sha256: 'abc' } } }), '')
    assert.equal(manifestSha256({ artifacts: { installer: { sha256: SHA.toUpperCase() } } }), SHA, '大写要归一成小写')
    assert.equal(manifestSha256({ artifacts: {} }), '')
  })
})
