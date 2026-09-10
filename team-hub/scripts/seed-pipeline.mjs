#!/usr/bin/env node
/**
 * 空间流水线种子（SP-P0）：把部署面的 roles*.json 导入 hub 数据面（space_stages）——「编队即流水线」的入口命令。
 *
 * 用法：
 *   node team-hub/scripts/seed-pipeline.mjs --scope ozon --file roles-ozon.json
 *   node team-hub/scripts/seed-pipeline.mjs --scope software --file roles.json --runtime-enabled
 *   node team-hub/scripts/seed-pipeline.mjs --scope ozon --file roles-ozon.json --dry-run
 *
 * 参数：
 *   --scope <id>        必填：目标工作空间 id（与 spaces.id / roster.scope 一致）
 *   --file <path>       roles 文件路径（默认 roles.json；相对路径按仓库根解析）
 *   --hub <url>         team-hub 地址（默认 http://127.0.0.1:8787）
 *   --by <member>       操作者身份（默认 general；/api/pipeline 仅允许 general）
 *   --runtime-enabled   同时把该空间 space_runtime.enabled 置 true（P1 起守护据此判断是否接管该空间）
 *   --runtime-max <n>   并发上限 1..8（默认沿用现值/1）
 *   --dry-run           只打印将要提交的载荷与差异，不写库
 *
 * 为什么走 HTTP 而不是直接写库：写入期校验（role 形状/唯一性、next 可达、gate 必须有 artifact、
 * docs 必须是仓库相对路径）与审计/SSE 都在服务端；绕过它就会把「配错的流水线」直接写进数据面，
 * 这正是本阶段要消除的那类静默故障。hub 未启动时会明确报错并给出启动指引。
 *
 * 幂等：整批 upsert（提交内容即权威），重复执行只报「无变化」。
 */
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function argOf(name, fallback = '') {
  const i = process.argv.indexOf('--' + name)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  return v !== undefined && !String(v).startsWith('--') ? v : 'true'
}
const has = (name) => process.argv.includes('--' + name)

const scope = String(argOf('scope', '')).trim()
const fileArg = String(argOf('file', 'roles.json')).trim()
const hub = String(argOf('hub', process.env.LEGION_HUB_URL || 'http://127.0.0.1:8787')).replace(/\/+$/, '')
const by = String(argOf('by', 'general')).trim()
const dryRun = has('dry-run')
const runtimeEnabled = has('runtime-enabled')
const runtimeMax = Number(argOf('runtime-max', '1'))

function die(msg, code = 1) {
  console.error('seed-pipeline: ' + msg)
  process.exit(code)
}
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(scope)) die('缺少或非法 --scope（小写字母/数字开头，可含连字符）')
const file = isAbsolute(fileArg) ? fileArg : join(ROOT, fileArg)

let raw
try {
  raw = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  die(`无法读取 roles 文件 ${file}：${e instanceof Error ? e.message : String(e)}`)
}
const stages = Array.isArray(raw.stages) ? raw.stages : null
if (stages === null || stages.length === 0) die(`${file} 里没有 stages 数组（该文件不是 roles 流水线格式）`)

/** 只提交流水线语义字段：未知字段不透传（避免把 hub 无需的宿主配置写进数据面）。 */
const payloadStages = stages.map((s, i) => ({
  role: s.role,
  label: s.label ?? s.role,
  prompt: typeof s.prompt === 'string' ? s.prompt : '',
  next: s.next ?? null,
  gate: s.gate === true,
  ...(typeof s.artifact === 'string' && s.artifact.trim() !== '' ? { artifact: s.artifact.trim() } : {}),
  ...(Array.isArray(s.docs) && s.docs.length > 0 ? { docs: s.docs } : {}),
  ...(s.enabled === false ? { enabled: false } : {}),
  sort: i,
}))
const body = {
  scope,
  by,
  stages: payloadStages,
  ...(runtimeEnabled || argOf('runtime-max', '') !== ''
    ? { runtime: { enabled: runtimeEnabled || undefined, maxWorkers: Number.isInteger(runtimeMax) ? runtimeMax : 1 } }
    : {}),
}
if (body.runtime && body.runtime.enabled === undefined) {
  // 只给了并发：沿用现值，别把 enabled 意外改成 false
  delete body.runtime.enabled
}

async function api(path, init) {
  let res
  try {
    res = await fetch(hub + path, init)
  } catch (e) {
    die(`连接 team-hub 失败（${hub}）：${e instanceof Error ? e.message : String(e)}\n  请先启动 hub：node team-hub/server.mjs（或经 DSH 宿主插件启动），再用 --hub 指向实际地址`)
  }
  const text = await res.text()
  let json = null
  try { json = text.length > 0 ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

const before = await api(`/api/pipeline?scope=${encodeURIComponent(scope)}`)
if (before.status !== 200) die(`读取现值失败：HTTP ${before.status} ${before.text.slice(0, 300)}`)
const prev = new Map((before.json?.stages ?? []).map(s => [s.role, s]))
const added = payloadStages.filter(s => !prev.has(s.role)).map(s => s.role)
const dropped = [...prev.keys()].filter(r => !payloadStages.some(s => s.role === r))
const changed = payloadStages.filter(s => {
  const p = prev.get(s.role)
  if (!p) return false
  return p.label !== s.label || (p.prompt ?? '') !== s.prompt || (p.next ?? null) !== (s.next ?? null)
    || p.gate !== s.gate || (p.artifact ?? null) !== (s.artifact ?? null)
    || JSON.stringify(p.docs ?? null) !== JSON.stringify(s.docs ?? null) || p.enabled !== (s.enabled !== false)
}).map(s => s.role)

console.log(`seed-pipeline: scope=${scope} file=${file}`)
console.log(`  提交 ${payloadStages.length} 环：${payloadStages.map(s => `${s.role}(${s.label})`).join(' → ')}`)
console.log(`  差异：新增 ${added.length ? added.join('、') : '无'} / 更新 ${changed.length ? changed.join('、') : '无'} / 删除 ${dropped.length ? dropped.join('、') : '无'}`)
console.log(`  现值 version=${before.json?.version ?? '(空)'}，runtime=${JSON.stringify(before.json?.runtime ?? null)}`)

if (dryRun) {
  console.log('  --dry-run：未写库。提交载荷预览：')
  console.log(JSON.stringify(body, null, 2))
  process.exit(0)
}

const r = await api('/api/pipeline', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
if (r.status !== 200) die(`写入失败：HTTP ${r.status} ${r.json?.error ?? r.text.slice(0, 400)}`)
const t = r.json?.task ?? {}
console.log(`  已写入：stages=${t.stages} added=${t.added} dropped=${(t.dropped ?? []).join('、') || '无'} version=${t.version}`)
console.log(`  生效轮次（${(t.activeRoles ?? []).length}）：${(t.activeRoles ?? []).join(' → ')}`)
for (const w of t.warnings ?? []) console.log(`  [${w.level}] ${w.code}: ${w.message}`)
console.log(`\n下一步：node -e "fetch('${hub}/api/spaces/provision?id=${scope}').then(r=>r.json()).then(j=>console.log(j.ok?'✅ 可自动循环':'❌ 仍有阻塞：',j.checks.filter(c=>c.level!=='ok').map(c=>c.code).join(',')))"`)
