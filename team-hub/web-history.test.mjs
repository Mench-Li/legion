// P2-8① team-hub 侧：浏览器助手抓取历史（按空间持久化）契约测试。
//
// 起隔离 hub 进程（独立临时 DB + 随机端口），只测服务端语义：
//   - 写入后可按空间读回；同 (scope,url) 只保留一行并累加 hits（历史=「抓过哪些地址」，不是逐次流水）
//   - 失败抓取（errorCode）同样入历史（失败原因也是历史的一部分）
//   - 空间隔离：别的空间读不到
//   - 每空间容量上限：超出按 updatedAt 最旧清理（trimmed 回报条数）
//   - 关键字过滤（url/title）、stats 汇总、单条/整空间清除
//   - 参数校验：缺 scope/url → 400
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'team-hub', 'server.mjs')

function boot(port, db) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, TEAM_HUB_PORT: String(port), TEAM_HUB_HOST: '127.0.0.1', TEAM_HUB_DB: db, TEAM_HUB_TOKEN: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  child.stderr.on('data', (d) => { err += d })
  const ready = new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      fetch(`http://127.0.0.1:${port}/api/config`)
        .then((r) => { if (r.ok) resolve() })
        .catch(() => {})
        .finally(() => {
          if (Date.now() - t0 > 15000) reject(new Error('hub boot timeout: ' + err.slice(-300)))
          else setTimeout(tick, 120)
        })
    }
    tick()
  })
  return { child, ready, port }
}

const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
}).then(async (r) => ({ status: r.status, json: await r.json() }))

const get = (port, path) => fetch(`http://127.0.0.1:${port}${path}`).then(async (r) => ({ status: r.status, json: await r.json() }))

test('P2-8① 抓取历史：写入/累加/隔离/过滤/清理/清除', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-wh-'))
  const db = join(dir, 'team.db')
  const port = 30000 + Math.floor(Math.random() * 12000)
  const hub = boot(port, db)
  try {
    await hub.ready

    // 缺参数 → 400（不静默写坏行）
    assert.equal((await post(port, '/api/web/history', { url: 'https://a.test/' })).status, 400, '缺 scope 应 400')
    assert.equal((await post(port, '/api/web/history', { scope: 'software' })).status, 400, '缺 url 应 400')

    // 首次写入
    const w1 = await post(port, '/api/web/history', {
      scope: 'software', url: 'https://a.test/doc', finalUrl: 'https://a.test/doc', title: 'A 文档', excerpt: '摘要',
      status: 200, bytes: 1234, ms: 88, cached: false,
    })
    assert.equal(w1.status, 200)
    assert.equal(w1.json.ok, true)
    assert.equal(w1.json.updated, false, '首次为插入')
    assert.equal(w1.json.hits, 1)

    // 同 (scope,url) 重复 → 同一行，hits 累加，字段更新为最近一次
    const w2 = await post(port, '/api/web/history', {
      scope: 'software', url: 'https://a.test/doc', title: 'A 文档 v2', status: 200, bytes: 2222, ms: 40, cached: true,
    })
    assert.equal(w2.json.updated, true, '重复为更新')
    assert.equal(w2.json.hits, 2)
    assert.equal(w2.json.id, w1.json.id, 'id 不变（同一行累加）')

    // 失败抓取也入历史（errorCode 是历史的一部分）
    await post(port, '/api/web/history', { scope: 'software', url: 'https://blocked.test/x', errorCode: 'ssrf_blocked', ms: 3 })
    await post(port, '/api/web/history', { scope: 'software', url: 'https://slow.test/y', errorCode: 'timeout', ms: 10000 })
    // 另一空间：不得互相可见
    await post(port, '/api/web/history', { scope: 'marketing', url: 'https://m.test/p', title: 'M 页', status: 200, bytes: 10 })

    const r1 = await get(port, '/api/web/history?scope=software')
    assert.equal(r1.status, 200)
    assert.equal(r1.json.scope, 'software')
    assert.equal(r1.json.items.length, 3, '同 URL 只占一行：3 行（不是 4 条记录）')
    const doc = r1.json.items.find(i => i.url === 'https://a.test/doc')
    assert.equal(doc.hits, 2, 'hits 累加')
    assert.equal(doc.title, 'A 文档 v2', '标题取最近一次')
    assert.equal(doc.cached, true, 'cached 取最近一次')
    assert.equal(doc.host, 'a.test', 'host 由 url 解析')
    assert.equal(r1.json.stats.total, 3)
    assert.equal(r1.json.stats.failed, 2, '两条失败计入 failed')
    assert.equal(r1.json.stats.bytes, 2222, 'bytes 汇总 = 该空间各地址最近一次成功抓取字节之和（失败行 bytes 为 null）')

    const r2 = await get(port, '/api/web/history?scope=marketing')
    assert.equal(r2.json.items.length, 1, '空间隔离：marketing 只有自己那条')
    assert.equal(r2.json.items[0].url, 'https://m.test/p')

    // 关键字过滤（url 与 title 都能命中；大小写不敏感）
    const f1 = await get(port, '/api/web/history?scope=software&q=BLOCKED')
    assert.equal(f1.json.items.length, 1)
    assert.equal(f1.json.items[0].url, 'https://blocked.test/x')
    const f2 = await get(port, '/api/web/history?scope=software&q=文档 v2')
    assert.equal(f2.json.items.length, 1, 'title 命中')
    assert.equal(f2.json.items.length + (await get(port, '/api/web/history?scope=software&q=不存在')).json.items.length, 1)

    // limit 生效（按 updatedAt 倒序）
    const l1 = await get(port, '/api/web/history?scope=software&limit=2')
    assert.equal(l1.json.items.length, 2)
    assert.deepEqual(l1.json.items.map(i => i.updatedAt).sort(), [...l1.json.items.map(i => i.updatedAt)].sort(), '倒序：最近在前')
    assert.ok(new Date(l1.json.items[0].updatedAt) >= new Date(l1.json.items[1].updatedAt))

    // 空间容量上限：maxPerScope=2 → 插入第 3 个地址时清理最旧（trimmed 回报）
    await post(port, '/api/web/history', { scope: 'cap', url: 'https://c1.test/', updatedAt: '2020-01-01T00:00:00.000Z' })
    await new Promise(r => setTimeout(r, 5))
    await post(port, '/api/web/history', { scope: 'cap', url: 'https://c2.test/' })
    await new Promise(r => setTimeout(r, 5))
    const cap3 = await post(port, '/api/web/history', { scope: 'cap', url: 'https://c3.test/', maxPerScope: 2 })
    assert.equal(cap3.json.trimmed, 1, '超出上限清理 1 条')
    const capRows = await get(port, '/api/web/history?scope=cap')
    assert.equal(capRows.json.items.length, 2)
    assert.ok(!capRows.json.items.some(i => i.url === 'https://c1.test/'), '被清掉的是最旧那条')

    // 单条清除 / 整空间清除
    const clr1 = await post(port, '/api/web/history/clear', { scope: 'software', id: doc.id })
    assert.equal(clr1.json.removed, 1, '按 id 删除 1 条')
    assert.equal((await get(port, '/api/web/history?scope=software')).json.items.length, 2)
    const clr2 = await post(port, '/api/web/history/clear', { scope: 'software' })
    assert.equal(clr2.json.removed, 2, '整空间清除 2 条')
    assert.equal((await get(port, '/api/web/history?scope=software')).json.items.length, 0)
    assert.equal((await get(port, '/api/web/history?scope=marketing')).json.items.length, 1, '清除只作用于指定空间')
    assert.equal((await post(port, '/api/web/history/clear', { scope: '' })).status, 400, '缺 scope 应 400')

    // 缺 scope 读 → 400（不返回全库）
    assert.equal((await get(port, '/api/web/history')).status, 400)
  } finally {
    try { hub.child.kill() } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 300))
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})
