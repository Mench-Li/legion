#!/usr/bin/env node
/**
 * T-125 tester 证据脚本（L2 上下文注入代理）：真实隔离 hub + 真实附件上传/取回 + 真实绑定目录摘要
 * → gatherChatContext → buildChatAnswerPrompt 全链（不含 LLM 出站，E2E-2/E2E-3 的确定性代理）。
 * 覆盖：绑定仓库摘要含真实内容（DIGEST 标记）/ 附件内容含独有事实（FACT 标记）/ 两标记进入最终提示词 /
 *       无附件对照（attachments=[]）/ 跨会话取回 → 占位不抛 / 未绑定 → 摘要 null + 提示词降级占位 /
 *       真实仓库（本 legion 仓库）摘要引用真实顶层目录。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync as wf } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO = process.cwd()
const tmpRoot = mkdtempSync(join(tmpdir(), 'legion-t125-ctx-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = []
const check = (name, pass, got) => { rows.push({ name, pass }); console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + (got !== undefined ? ' | ' + JSON.stringify(got) : '')) }

const { gatherChatContext } = await import(pathToFileURL(join(REPO, 'plugins', 'lib', 'chatContext.js')).href)
const { buildChatAnswerPrompt } = await import(pathToFileURL(join(REPO, 'plugins', 'lib', 'chatResponder.js')).href)

async function post(base, path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let d = null; try { d = await r.json() } catch {}
  return { status: r.status, data: d }
}
const get = async (base, path) => { const r = await fetch(base + path); let d = null; try { d = await r.json() } catch {} ; return { status: r.status, data: d } }

async function startHub() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const dbFile = join(tmpRoot, 'hub-' + port + '.db')
    const child = spawn(process.execPath, ['team-hub/server.mjs'], { cwd: REPO,
      env: { ...process.env, TEAM_HUB_DB: dbFile, TEAM_HUB_PORT: String(port), TEAM_HUB_TOKEN: '' }, stdio: 'ignore' })
    const base = 'http://127.0.0.1:' + port
    for (let i = 0; i < 100; i += 1) {
      try { const r = await fetch(base + '/api/config'); if (r.ok && (await r.json()).db === dbFile) return { child, base } } catch {}
      await sleep(100)
    }
    child.kill()
  }
  throw new Error('hub not ready')
}

const UNIQ = Date.now().toString(36)
const DIGEST = 'DIGEST_MARK_' + UNIQ
const FACT = 'FACT_UNIQ_' + UNIQ

// 绑定目录 fixture：README.md 含 DIGEST 标记 + src/ 结构
const bindDir = join(tmpRoot, 'bind-alpha')
mkdirSync(join(bindDir, 'src'), { recursive: true })
wf(join(bindDir, 'README.md'), 'Alpha 绑定仓库测试\n本仓库独特标记：' + DIGEST + '\n', 'utf8')
wf(join(bindDir, 'src', 'main.txt'), '源码占位', 'utf8')

const { child, base } = await startHub()
try {
  // 上传含独有事实的文本文件
  const factBody = '这是上传文件的独有事实：' + FACT + '（用于对照无附件时不出现）'
  const up = await fetch(base + '/api/chat/attachments?scope=alpha&by=general&fileName=fact-' + UNIQ + '.txt', { method: 'PUT', body: factBody })
  const att = await up.json()
  check('上传 UTF-8 文本附件 → staged（id/sha 落盘引用）', up.status === 200 && att.status === 'staged' && Number.isInteger(att.id) && att.size === Buffer.byteLength(factBody), att)

  const cv = (await post(base, '/api/chat/conversations', { scope: 'alpha', title: 'L2 上下文', kind: 'space', by: 'general' })).data.task.id
  const m1 = (await post(base, '/api/chat/messages', { conv: cv, kind: 'text', body: '基于附件与空间内容回答', by: 'general', attachmentIds: [att.id] })).data.task
  check('带附件发消息 → meta.attachments 仅引用(id/fileName/size)，body 无文件正文', {
    pass: m1.meta.aiStatus === 'awaiting' && Array.isArray(m1.meta.attachments) && m1.meta.attachments[0].id === att.id && !m1.body.includes(FACT) && !m1.meta.body,
    got: JSON.stringify({ meta: m1.meta, bodyLen: (m1.body || '').length }),
  })

  // 守护侧同款调用：gatherChatContext(bindingDir=真实绑定目录, attachmentRefs=本次消息引用)
  const ctx = await gatherChatContext({ hubUrl: base, scope: 'alpha', convId: cv, by: 'alpha-assistant', attachmentRefs: m1.meta.attachments, bindingDir: bindDir, bindingMeta: { name: 'Alpha 测试空间' } })
  check('空间摘要含绑定仓库真实内容（DIGEST 标记）', ctx.spaceDigest && typeof ctx.spaceDigest.text === 'string' && ctx.spaceDigest.text.includes(DIGEST), { len: ctx.spaceDigest?.text?.length, has: ctx.spaceDigest?.text?.includes(DIGEST) })
  check('附件内容经归属校验取回且含独有事实（FACT 标记）', ctx.attachments.length === 1 && ctx.attachments[0].content !== null && ctx.attachments[0].content.includes(FACT), { file: ctx.attachments[0]?.fileName, has: ctx.attachments[0]?.content?.includes(FACT) })

  const prompt = buildChatAnswerPrompt({ scope: 'alpha', convTitle: 'L2 上下文', context: [{ id: m1.id, author: m1.author, body: m1.body }], identity: 'alpha-assistant', spaceDigest: ctx.spaceDigest, attachments: ctx.attachments })
  check('最终提示词同时注入绑定仓库事实与附件事实（E2E-2/3 的确定性代理）', prompt.includes(DIGEST) && prompt.includes(FACT), { digestIn: prompt.includes(DIGEST), factIn: prompt.includes(FACT) })

  // 对照①：无附件同问 → attachments 为空（附件仅当次，历史不回填 AC-R4-6 代理）
  const m2 = (await post(base, '/api/chat/messages', { conv: cv, kind: 'text', body: '无附件同问', by: 'general' })).data.task
  const ctx2 = await gatherChatContext({ hubUrl: base, scope: 'alpha', convId: cv, by: 'alpha-assistant', attachmentRefs: m2.meta.attachments, bindingDir: bindDir, bindingMeta: { name: 'Alpha 测试空间' } })
  check('对照：第二条无附件消息 → attachments=[]（不泄漏第一条附件）', ctx2.attachments.length === 0, ctx2.attachments.length)
  const prompt2 = buildChatAnswerPrompt({ scope: 'alpha', convTitle: 'L2 上下文', context: [{ id: m2.id, author: m2.author, body: m2.body }], identity: 'alpha-assistant', spaceDigest: ctx2.spaceDigest, attachments: ctx2.attachments })
  check('对照：无附件提示词不含 FACT 独有事实', !prompt2.includes(FACT), { factIn: prompt2.includes(FACT) })

  // 对照②：跨会话取回 → 占位 readError 不 throw（TC-S6-03 语义代理）
  const ctxBad = await gatherChatContext({ hubUrl: base, scope: 'alpha', convId: 999999, by: 'alpha-assistant', attachmentRefs: m1.meta.attachments, bindingDir: bindDir })
  check('跨会话取回附件 → 占位 readError（不抛、不冒充内容）', ctxBad.attachments.length === 1 && ctxBad.attachments[0].content === null && typeof ctxBad.attachments[0].readError === 'string' && ctxBad.attachments[0].readError.length > 0, ctxBad.attachments[0])

  // 对照③：未绑定空间 → 摘要 null + 提示词固定降级占位（AC-R2-4）
  const ctxNo = await gatherChatContext({ hubUrl: base, scope: 'alpha', convId: cv, by: 'alpha-assistant', attachmentRefs: [], bindingDir: null })
  const promptNo = buildChatAnswerPrompt({ scope: 'alpha', convTitle: 'L2 上下文', context: [{ id: m1.id, author: m1.author, body: m1.body }], identity: 'alpha-assistant', spaceDigest: ctxNo.spaceDigest, attachments: ctxNo.attachments })
  check('未绑定 → spaceDigest=null 且提示词含「未绑定」降级占位', ctxNo.spaceDigest === null && promptNo.includes('未绑定'), { null: ctxNo.spaceDigest === null, ph: promptNo.includes('未绑定') })

  // 对照④：真实 legion 仓库绑定 → 摘要引用真实顶层结构（E2E-2 仓库可见性代理）
  const ctxReal = await gatherChatContext({ hubUrl: base, scope: 'software', convId: cv, by: 'software-assistant', attachmentRefs: [], bindingDir: REPO, bindingMeta: { name: 'software', remoteUrl: '' } })
  const realDigest = ctxReal.spaceDigest?.text ?? ''
  const realDirs = ['team-hub', 'plugins', 'docs', 'workbench', 'scripts']
  check('真实仓库绑定 → 摘要含【顶层结构】且引用真实顶层目录（非编造）', realDigest.includes('顶层结构') && realDirs.every((d) => realDigest.includes(d)), { len: realDigest.length, missing: realDirs.filter((d) => !realDigest.includes(d)) })

  const failed = rows.filter((r) => !r.pass)
  console.log('\n==== L2 上下文注入汇总 ====')
  console.log('总断言 ' + rows.length + '，PASS ' + (rows.length - failed.length) + '，FAIL ' + failed.length)
} finally {
  child.kill()
  await sleep(300)
  rmSync(tmpRoot, { recursive: true, force: true })
}
