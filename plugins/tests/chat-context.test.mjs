/**
 * chat-context.test.mjs — P2-6 附件上下文生命周期与 gatherChatContext 降级回归。
 *
 * 两块覆盖（此前均为 0 覆盖）：
 *   A. `plugins/src/chatContext.ts` 的 gatherChatContext：空间摘要与附件内容收集，
 *      纪律是「任一步失败仅降级（null/占位），绝不 throw」——否则上下文故障会把源消息误标 failed。
 *   B. 附件生命周期全链路（真实 team-hub）：staged → sent → 引用留存 → TTL 清理后
 *      **引用仍在但内容不可读**（引用与内容生命周期解耦），以及内容不入 messages 表（TC-S6-09）。
 *
 * 运行：node --test plugins/tests/chat-context.test.mjs
 *      （A 组 import 编译产物 plugins/lib/chatContext.js —— 与同目录其它 plugins 测试一致；
 *        lib 由 `npm run build` / run-ci 的 plugins build 步骤产出，故本文件**不需要** strip-types。）
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ───────────────────────── A. gatherChatContext（假 hub + 临时目录，无真实服务依赖）─────────────────────────

const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-chatctx-'))
let ctxMod

before(async () => {
  const mod = await import('../../plugins/lib/chatContext.js')
  ctxMod = mod.default && mod.default.gatherChatContext ? mod.default : mod
})

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

/** 起一个假 hub：按 paths 映射返回响应（可模拟 404 / 空内容 / 挂起）。 */
async function fakeHub(handlers) {
  const srv = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const h = handlers[url.pathname]
    if (!h) { res.statusCode = 404; res.end('not found'); return }
    h(url, req, res)
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { url: 'http://127.0.0.1:' + String(srv.address().port), close: () => new Promise((r) => srv.close(r)) }
}

describe('P2-6-A gatherChatContext：空间摘要降级四态', () => {
  it('bindingDir 未提供 → spaceDigest undefined（不尝试读取）', async () => {
    const out = await ctxMod.gatherChatContext({ hubUrl: 'http://127.0.0.1:1', scope: 's', convId: 1, by: 'g' })
    assert.equal(out.spaceDigest, undefined)
    assert.deepEqual(out.attachments, [])
  })

  it('bindingDir=null（空间未绑定仓库）→ spaceDigest null（提示词层占位）', async () => {
    const out = await ctxMod.gatherChatContext({ bindingDir: null, hubUrl: '', scope: 's', convId: 1, by: 'g' })
    assert.equal(out.spaceDigest, null)
  })

  it('绑定目录不存在 → unavailable 占位且不 throw', async () => {
    const out = await ctxMod.gatherChatContext({
      bindingDir: join(tmpRoot, 'not-exist-dir'), hubUrl: '', scope: 's', convId: 1, by: 'g',
    })
    assert.ok(out.spaceDigest, '仍返回对象（降级）')
    assert.equal(out.spaceDigest.text, '')
    assert.ok(String(out.spaceDigest.unavailable).length > 0, '给出不可用原因')
  })

  it('绑定目录有内容 → text 非空 + sourceNote 标注只读快照', async () => {
    const dir = join(tmpRoot, 'repo')
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'README.md'), '# 空间仓库\n\n这是用于测试的说明文件。\n', 'utf8')
    writeFileSync(join(dir, 'docs', 'a.md'), '# 文档\n内容\n', 'utf8')
    const out = await ctxMod.gatherChatContext({
      bindingDir: dir, hubUrl: '', scope: 'software', convId: 1, by: 'g',
      bindingMeta: { name: 'software', remoteUrl: 'https://example.com/x.git' },
    })
    assert.ok(out.spaceDigest && out.spaceDigest.text.length > 0, '摘要非空：' + JSON.stringify(out.spaceDigest))
    assert.ok(String(out.spaceDigest.sourceNote).includes('只读'))
    assert.ok(out.spaceDigest.generatedAt)
  })
})

describe('P2-6-A gatherChatContext：附件内容收集与降级（核心纪律：绝不 throw）', () => {
  it('无 attachmentRefs → 空数组；非法引用（id 非正整数）被过滤', async () => {
    const out1 = await ctxMod.gatherChatContext({ hubUrl: 'http://127.0.0.1:1', scope: 's', convId: 7, by: 'g' })
    assert.deepEqual(out1.attachments, [])
    const out2 = await ctxMod.gatherChatContext({
      hubUrl: 'http://127.0.0.1:1', scope: 's', convId: 7, by: 'g',
      attachmentRefs: [{ id: 0, fileName: 'x', size: 1 }, { id: -1, fileName: 'y', size: 1 }, { id: 1.5, fileName: 'z', size: 1 }, null],
    })
    assert.deepEqual(out2.attachments, [], '非法 id 全被过滤（不发起请求）')
  })

  it('hub 不可达 → 每条附件给出 readError 占位，不 throw', async () => {
    const out = await ctxMod.gatherChatContext({
      hubUrl: 'http://127.0.0.1:1', scope: 's', convId: 7, by: 'g',
      attachmentRefs: [{ id: 11, fileName: 'a.txt', size: 3 }],
    })
    assert.equal(out.attachments.length, 1)
    assert.equal(out.attachments[0].content, null)
    assert.ok(String(out.attachments[0].readError).startsWith('读取失败'), '降级原因：' + out.attachments[0].readError)
    assert.equal(out.attachments[0].fileName, 'a.txt', '文件名仍透出（提示词可说明缺了哪个附件）')
  })

  it('附件返回 404 / 内容为空 → 分别给出可读 readError，均不 throw', async () => {
    const hub = await fakeHub({
      '/api/chat/attachments/content': (url, req, res) => {
        const id = url.searchParams.get('id')
        if (id === '404') { res.statusCode = 404; res.end('附件不存在'); return }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ content: '' })) // 内容为空（已过清理窗口的典型表现）
      },
    })
    try {
      const out = await ctxMod.gatherChatContext({
        hubUrl: hub.url, scope: 's', convId: 7, by: 'g',
        attachmentRefs: [{ id: 404, fileName: 'gone.txt', size: 5 }, { id: 200, fileName: 'empty.txt', size: 5 }],
      })
      assert.equal(out.attachments.length, 2)
      assert.ok(String(out.attachments[0].readError).includes('HTTP 404'), '带状态码：' + out.attachments[0].readError)
      assert.ok(String(out.attachments[1].readError).includes('内容为空'))
      assert.ok(out.attachments.every(a => a.content === null))
    } finally { await hub.close() }
  })

  it('正常取回 → content 就位；hubUrl 末尾斜杠被规范化；请求带 id/conv/scope/by 四参', async () => {
    const seen = []
    const hub = await fakeHub({
      '/api/chat/attachments/content': (url, req, res) => {
        seen.push({
          id: url.searchParams.get('id'), conv: url.searchParams.get('conv'),
          scope: url.searchParams.get('scope'), by: url.searchParams.get('by'),
        })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ content: '附件正文内容' }))
      },
    })
    try {
      const out = await ctxMod.gatherChatContext({
        hubUrl: hub.url + '///', scope: 'software', convId: 42, by: 'soldier',
        attachmentRefs: [{ id: 9, fileName: 'spec.md', size: 6 }],
      })
      assert.equal(out.attachments.length, 1)
      assert.equal(out.attachments[0].content, '附件正文内容')
      assert.equal(out.attachments[0].readError, undefined)
      assert.deepEqual(seen[0], { id: '9', conv: '42', scope: 'software', by: 'soldier' }, '四参齐全（服务端据此做归属/越权校验）')
    } finally { await hub.close() }
  })
})

// ───────────────────────── B. 附件生命周期全链路（真实 team-hub，隔离库）─────────────────────────

describe('P2-6-B 附件生命周期：staged → sent → 引用留存 → 内容失效', () => {
  let mod, base = '', tmp, hubDir
  const SCOPE = 'p26-att'

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'legion-att-life-'))
    process.env.TEAM_HUB_DB = join(tmp, 'team.db')
    process.env.CHAT_ATTACH_TTL_MS = '3600000' // 1h（本 describe 手动注入 nowMs，不依赖真实等待）
    process.env.CHAT_ATTACH_STAGED_TTL_MS = '1800000'
    mod = await import('../../team-hub/server.mjs?att-life=' + String(Date.now()))
    await new Promise((r) => mod.server.listen(0, '127.0.0.1', r))
    base = 'http://127.0.0.1:' + String(mod.server.address().port)
    hubDir = join(tmp, 'uploads') // UPLOADS_ROOT = dirname(DB_FILE)/uploads
  })

  after(async () => {
    try { mod?.server?.closeAllConnections?.() } catch { /* 无连接 */ }
    try { await new Promise((r) => mod?.server?.close(r)) } catch { /* 已关闭 */ }
    try { mod?.db?.close() } catch { /* 已关闭 */ }
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }) } catch { /* win 句柄未释放 */ }
  })

  const get = async (p) => {
    const res = await fetch(base + p)
    const text = await res.text()
    let json = null
    try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
    return { status: res.status, json, text }
  }
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await res.text()
    let json = null
    try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
    return { status: res.status, json, text }
  }
  /** 读一条消息行（meta 以 JSON 字符串落库，此处解析回对象以便断言引用形状）。 */
  const readMsg = (id) => {
    const row = mod.db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
    assert.ok(row, '消息应存在：' + String(id))
    return { ...row, meta: row.meta ? JSON.parse(row.meta) : null }
  }
  /** 附件行是否仍在（TTL 断言按**本用例的附件 id**判定，避免受同 scope 其它用例残留影响）。 */
  const attExists = (id) => mod.db.prepare('SELECT COUNT(*) AS c FROM chat_attachments WHERE id = ?').get(id).c === 1

  it('上传 staged → 发送后转 sent；消息 meta 只存引用；内容不写入 messages 表（TC-S6-09）', async () => {
    const conv = mod.createConversation({ scope: SCOPE, title: '附件生命周期', kind: 'space', by: 'general' })
    const content = '机密附件正文：这段内容只应存在于附件文件，不得进入消息体或 messages 表。'
    const att = mod.uploadChatAttachment({ scope: SCOPE, fileName: 'secret.txt', content: Buffer.from(content, 'utf8'), by: 'general' })
    assert.equal(att.id > 0, true)
    const row0 = mod.db.prepare('SELECT * FROM chat_attachments WHERE id = ?').get(att.id)
    assert.equal(row0.status, 'staged', '上传后为 staged')
    assert.ok(existsSync(join(hubDir, row0.path)), '文件已落盘')

    const msg = mod.postMessage({ conv: conv.id, body: '请看附件', by: 'general', attachmentIds: [att.id] })
    const row1 = mod.db.prepare('SELECT * FROM chat_attachments WHERE id = ?').get(att.id)
    assert.equal(row1.status, 'sent', '绑定后转 sent')
    assert.equal(msg.meta.attachments.length, 1)
    assert.deepEqual(
      { id: msg.meta.attachments[0].id, fileName: msg.meta.attachments[0].fileName },
      { id: att.id, fileName: 'secret.txt' },
      'meta 只存 {id,fileName,size} 引用',
    )
    // 反向断言：内容字符串不出现在消息行任何字段（含 meta 序列化）里
    const rawMsg = mod.db.prepare('SELECT * FROM messages WHERE id = ?').get(msg.id)
    const dump = JSON.stringify(rawMsg)
    assert.ok(!dump.includes('机密附件正文'), '附件内容不得写入消息行：' + dump.slice(0, 200))
    assert.ok(!dump.includes(content.slice(0, 10)))
  })

  it('内容读取契约：**staged 不可读**（须先绑定）；绑定后本人可取回；越权/缺身份/未知 id 均被拒', async () => {
    const convA = mod.createConversation({ scope: SCOPE, title: '会话A', kind: 'space', by: 'general' })
    const convB = mod.createConversation({ scope: SCOPE, title: '会话B', kind: 'space', by: 'general' })
    const att = mod.uploadChatAttachment({ scope: SCOPE, fileName: 'ctx.txt', content: Buffer.from('上下文内容', 'utf8'), by: 'general' })
    // 契约：未绑定（staged）的附件内容不可读——读取要求 status=sent + scope 与 conv 双匹配，
    // 这是**有意的安全属性**（附件只在绑定到具体会话消息后才可被读取，避免上传即全网可读）。
    const staged = await get('/api/chat/attachments/content?id=' + String(att.id) + '&conv=' + String(convA.id) + '&scope=' + SCOPE + '&by=general')
    assert.equal(staged.status, 403, 'staged 不可读（须先绑定消息）：' + staged.text.slice(0, 120))
    mod.postMessage({ conv: convA.id, body: '绑定', by: 'general', attachmentIds: [att.id] })
    // 绑定后：正确会话 + 正确 scope → 可取回
    const ok = await get('/api/chat/attachments/content?id=' + String(att.id) + '&conv=' + String(convA.id) + '&scope=' + SCOPE + '&by=general')
    assert.equal(ok.status, 200, ok.text)
    assert.equal(ok.json.content, '上下文内容')
    assert.equal(ok.json.fileName, 'ctx.txt')
    // 错 conv（跨会话引用）→ 403
    const wrongConv = await get('/api/chat/attachments/content?id=' + String(att.id) + '&conv=' + String(convB.id) + '&scope=' + SCOPE + '&by=general')
    assert.equal(wrongConv.status, 403, '跨会话读取被拒：' + wrongConv.text.slice(0, 120))
    // 错 scope → 403
    const wrongScope = await get('/api/chat/attachments/content?id=' + String(att.id) + '&conv=' + String(convA.id) + '&scope=other&by=general')
    assert.equal(wrongScope.status, 403, '跨空间读取被拒')
    // 缺 by → 400（操作者身份是审计与准入前提）
    const noBy = await get('/api/chat/attachments/content?id=' + String(att.id) + '&conv=' + String(convA.id) + '&scope=' + SCOPE)
    assert.equal(noBy.status, 400, '缺操作者身份被拒：' + noBy.text.slice(0, 120))
    // 未知 id → 404
    const unknown = await get('/api/chat/attachments/content?id=999999&conv=' + String(convA.id) + '&scope=' + SCOPE + '&by=general')
    assert.equal(unknown.status, 404, unknown.text)
  })

  it('引用与内容生命周期解耦：清理窗口后引用仍在消息 meta，但内容读取失败', async () => {
    const conv = mod.createConversation({ scope: SCOPE, title: '过期会话', kind: 'space', by: 'general' })
    const att = mod.uploadChatAttachment({ scope: SCOPE, fileName: 'expiring.txt', content: Buffer.from('会过期的内容', 'utf8'), by: 'general' })
    const msg = mod.postMessage({ conv: conv.id, body: '带会过期的附件', by: 'general', attachmentIds: [att.id] })
    const row = mod.db.prepare('SELECT * FROM chat_attachments WHERE id = ?').get(att.id)
    const file = join(hubDir, row.path)
    assert.ok(existsSync(file))
    // 未到期 → 不清本附件（removed 是 scope 级计数，故按本附件行判定，避免同 scope 其它用例残留干扰）
    const ttlMs = Number(process.env.CHAT_ATTACH_TTL_MS)
    mod.cleanupChatAttachments({ scope: SCOPE, nowMs: new Date(row.createdAt).getTime() + Math.floor(ttlMs / 2) })
    assert.ok(attExists(att.id), '未到期不清理')
    assert.ok(existsSync(file), '未到期文件仍在')
    // 到期（sent 超过 TTL）→ 清理行 + 文件
    const after = mod.cleanupChatAttachments({ scope: SCOPE, nowMs: new Date(row.createdAt).getTime() + ttlMs + 1000 })
    assert.ok(after.removed >= 1, '到期清理：' + JSON.stringify(after))
    assert.ok(!attExists(att.id), '本附件行已删除')
    assert.ok(!existsSync(file), '文件已删除')
    // 关键：消息 meta 里的**引用仍留存**（历史消息可读、可解释「附件已过期」），但内容读取失败
    const reread = readMsg(msg.id)
    assert.equal(reread.meta.attachments.length, 1, '消息 meta 引用不随清理消失')
    const gone = await get('/api/chat/attachments/content?id=' + String(att.id) + '&conv=' + String(conv.id) + '&scope=' + SCOPE + '&by=general')
    assert.equal(gone.status, 404, '内容不可读：' + gone.text.slice(0, 120))
    // gatherChatContext 对此的降级：readError 占位，不 throw（端到端接上 A 组的纪律）
    const bundle = await ctxMod.gatherChatContext({
      hubUrl: base, scope: SCOPE, convId: conv.id, by: 'general',
      attachmentRefs: reread.meta.attachments,
    })
    assert.equal(bundle.attachments.length, 1)
    assert.equal(bundle.attachments[0].content, null)
    assert.ok(String(bundle.attachments[0].readError).includes('404'), '过期附件在提示词层降级为 readError：' + bundle.attachments[0].readError)
  })

  it('历史消息不回填附件：后续无附件消息的 meta 不含 attachments；重复使用已绑定附件被拒', async () => {
    const conv = mod.createConversation({ scope: SCOPE, title: '回填检查', kind: 'space', by: 'general' })
    const att = mod.uploadChatAttachment({ scope: SCOPE, fileName: 'once.txt', content: Buffer.from('只能用一次', 'utf8'), by: 'general' })
    mod.postMessage({ conv: conv.id, body: '第一条带附件', by: 'general', attachmentIds: [att.id] })
    const plain = mod.postMessage({ conv: conv.id, body: '第二条不带附件', by: 'general' })
    assert.ok(!plain.meta || plain.meta.attachments === undefined || plain.meta.attachments.length === 0, '历史附件不回填到后续消息')
    // 已绑定附件不可重复使用（防一条附件被多条消息引用）
    assert.throws(() => mod.postMessage({ conv: conv.id, body: '再绑一次', by: 'general', attachmentIds: [att.id] }), /已被绑定/)
    // 跨 scope 引用被拒
    const convOther = mod.createConversation({ scope: 'p26-att-other', title: '别空间', kind: 'space', by: 'general' })
    assert.throws(() => mod.postMessage({ conv: convOther.id, body: '跨空间引用', by: 'general', attachmentIds: [att.id] }), /不属于|跨|scope/)
    // 数量上限（CHAT_ATTACH_MAX_PER_MSG 默认 3）：4 个 → 拒
    const ids = []
    for (let i = 0; i < 4; i += 1) {
      ids.push(mod.uploadChatAttachment({ scope: SCOPE, fileName: 'n' + String(i) + '.txt', content: Buffer.from('x', 'utf8'), by: 'general' }).id)
    }
    assert.throws(() => mod.postMessage({ conv: conv.id, body: '四个附件', by: 'general', attachmentIds: ids }), /超限/)
  })

  it('孤儿 staged 附件按 staged TTL 清理（未被任何消息引用的上传残留）', async () => {
    const att = mod.uploadChatAttachment({ scope: SCOPE, fileName: 'orphan2.txt', content: Buffer.from('没人要', 'utf8'), by: 'general' })
    const row = mod.db.prepare('SELECT * FROM chat_attachments WHERE id = ?').get(att.id)
    const stagedTtl = Number(process.env.CHAT_ATTACH_STAGED_TTL_MS)
    mod.cleanupChatAttachments({ scope: SCOPE, nowMs: new Date(row.createdAt).getTime() + Math.floor(stagedTtl / 2) })
    assert.ok(attExists(att.id), '未到期不清理')
    const done = mod.cleanupChatAttachments({ scope: SCOPE, nowMs: new Date(row.createdAt).getTime() + stagedTtl + 1000 })
    assert.ok(done.removed >= 1)
    assert.ok(!attExists(att.id), '过期孤儿附件行已删除')
  })
})
