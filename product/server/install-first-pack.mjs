#!/usr/bin/env node
// product/server/install-first-pack.mjs
// ============================================================================
// 装最小可用流程包（空间 + 编队 + 流水线阶段）。
//
// ## 为什么单独成文件而不是 `node -e` 内联
//
// 内联那版踩过一个坑：同时在**同一个** `-e` 脚本里用 `require()` 与顶层 `await`，
// Node 会抛 `ERR_AMBIGUOUS_MODULE_SYNTAX`——它无法判断该按 CommonJS 还是 ESM 解析。
// 而且那次的报错被调用方包成了"登录环节失败"，于是**真实原因（模块格式）
// 被伪装成了口令问题**，排查方向直接跑偏。
//
//   > 一个"把失败笼统报成上一步出错"的调用方，
//   > 与一个"确实上一步就失败了"的调用方，在只看那句提示时是同一个东西。
//
// 所以：**用文件**，用 `import`，报错如实往外抛。
//
// 用法：node install-first-pack.mjs [baseUrl] [packPath] [passwordFile]
// ============================================================================
import { readFileSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787'
const PACK_PATH = process.argv[3] ?? '/srv/legion-hub/first-space.pack.json'
const PW_FILE = process.argv[4] ?? '/etc/legion-hub/first-admin-password.txt'
const NAME = process.env.LEGION_ADMIN_NAME ?? 'legion'

const password = readFileSync(PW_FILE, 'utf8').replace(/[\r\n]+$/, '')
const pack = JSON.parse(readFileSync(PACK_PATH, 'utf8'))

const post = async (path, body, token) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

const login = await post('/api/identity/login', { name: NAME, password, label: 'install-pack' })
if (login.status !== 200 || typeof login.json?.accessToken !== 'string') {
  // 如实报"登录失败"并带上服务端的原话——**不**替它猜原因。
  console.error(`登录失败（HTTP ${login.status}）：${login.json?.error ?? login.text.slice(0, 200)}`)
  process.exit(1)
}
const token = login.json.accessToken

// ── 先授空间角色 ────────────────────────────────────────────────────────────
//
// 引导出来的是**系统管理员**，而系统角色管的是"造邀请 / 停用账号"，
// **不是**"看所有数据"。不给空间角色，读任何空间都 403。
// 这一步与装包是"让这个空间对这个账号真正可用"的两半，放在一起——
// 分开的话，只做一半的表现都是"登录成功但手机上什么都没有"。
const me = await fetch(BASE + '/api/identity/me', { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json())
const userId = me?.user?.userId
if (typeof userId !== 'string') {
  console.error(`拿不到 userId（/api/identity/me 返回 ${JSON.stringify(me).slice(0, 160)}）`)
  process.exit(1)
}
const scopeId = pack?.scope?.id ?? 'default'
const grant = await post('/api/identity/roles/grant', { userId, space: scopeId, role: 'owner' }, token)
if (grant.status !== 200) {
  console.error(`授空间角色失败（HTTP ${grant.status}）：${grant.json?.error ?? grant.text.slice(0, 200)}`)
  process.exit(1)
}
console.log(`授权：${userId} → ${scopeId}/${grant.json.role}`)

const preview = await post('/api/workflow-packs/preview', { by: 'general', pack }, token)
if (preview.status !== 200) {
  console.error(`预览失败（HTTP ${preview.status}）：${preview.json?.error ?? preview.text.slice(0, 200)}`)
  process.exit(1)
}
// `action: 'current'` = 这个版本已经装过、且本地没有改动 → **直接收工**。
// 装包是幂等的，脚本要能重跑：把它当失败会让"再跑一次确认"变成一次假报警，
// 而假报警会训练人去忽略这个脚本的输出。
const planned = preview.json?.task ?? {}
if (planned.action === 'current') {
  console.log(JSON.stringify({ ok: true, scope: planned.scope ?? scopeId, alreadyInstalled: true, version: planned.version ?? null }))
  process.exit(0)
}

const install = await post('/api/workflow-packs/install', { by: 'general', pack }, token)
if (install.status !== 200) {
  console.error(`装包失败（HTTP ${install.status}）：${install.json?.error ?? install.text.slice(0, 200)}`)
  process.exit(1)
}
// ★ 结果在 `task` 下面：`handleWrite` 的统一信封是 `{ ok:true, task:<结果> }`。
//   读错层级时输出会变成 `{"ok":true}`——**看起来像成功、其实什么都没打出来**，
//   而那正是"日志没写对"最坑的形状：它不报错，只是把信息丢了。
const r = install.json?.task ?? {}
console.log(JSON.stringify({
  ok: r.installed === true,
  scope: r.scope ?? null,
  version: r.version ?? null,
  roles: r.roles ?? null,
  stages: r.stages ?? null,
  installed: r.installed === true,
}))
if (r.installed !== true) {
  console.error(`装包返回里没有 installed=true：${install.text.slice(0, 200)}`)
  process.exit(1)
}
