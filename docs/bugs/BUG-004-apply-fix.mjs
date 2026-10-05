// docs/bugs/BUG-004-apply-fix.mjs — 把 14 条岗位模型绑定从死供应商改到活供应商（**写入生产中枢**，手动运行）
//
// 用法：node docs/bugs/BUG-004-apply-fix.mjs [--dry-run]
//
// 三步（都走中枢 API，带审计与 SSE，与界面写操作同一条路）：
//   ① 登记 fjd-ds 的三个型号进中枢的模型档案（`POST /api/model-profiles`）。
//      不登记这一步，第②步会被 `NO_PROFILES` 拒——档案表空着时**任何**绑定都写不进去。
//   ② 把 `agent_models` 里 provider=custom-ds 的绑定改成 fjd-ds（**model id 不变**：
//      deepseek-v4-pro-openai / deepseek-v4-flash-openai 在 fjd-ds 下都存在）。
//   ③ 给"有绑定的空间"补一条 `assistant` 绑定（对话回复的解析链优先它；
//      此前 assistant 行全为 0 ⇒ 只能兜底到"第一行"，答案取决于插入顺序）。
//
// 幂等：档案按 id 判重（已存在则跳过）；绑定已是 fjd-ds 则跳过；assistant 行存在则覆盖。
const DRY = process.argv.includes('--dry-run')
const HUB = process.env.BUG004_HUB ?? 'http://127.0.0.1:8787'
const ACTOR = 'general'
const PROVIDER = 'fjd-ds'

// 与 DSH 档案（C:\Users\11150\.dsh\profiles\desktop\cordis.patch.yml 的 llm-pi-ai.providers.fjd-ds）
// **逐项一致**：baseURL 与三个型号、以及各自的 contextWindow / maxTokens。
const BASE_URL = 'https://fjbigmodel.fjdac.cn/v1'
const PROFILES = [
  { id: 'fjd-ds-deepseek-v4-pro-openai', model: 'deepseek-v4-pro-openai', displayName: 'FJD · deepseek-v4-pro-openai' },
  { id: 'fjd-ds-deepseek-v4-flash-openai', model: 'deepseek-v4-flash-openai', displayName: 'FJD · deepseek-v4-flash-openai', limits: { maxTokens: 393216 } },
  { id: 'fjd-ds-deepseek-v4-flash-vision-openai', model: 'deepseek-v4-flash-vision-openai', displayName: 'FJD · deepseek-v4-flash-vision-openai', limits: { maxTokens: 393216 } },
]
const ASSISTANT_MODEL = 'deepseek-v4-flash-openai'

const get = async (p) => (await fetch(HUB + p)).json()
const post = async (p, body) => {
  const r = await fetch(HUB + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let parsed = null
  try { parsed = await r.json() } catch { /* 空体 */ }
  return { status: r.status, body: parsed }
}

const report = { profilesCreated: [], profilesSkipped: [], bindingsChanged: [], bindingsSkipped: [], assistant: [], errors: [] }

// ── ① 模型档案 ────────────────────────────────────────────────────────────────
const existing = new Set(((await get('/api/model-profiles')).profiles ?? []).map(p => p.id))
console.log(`① 模型档案：现有 ${existing.size} 条`)
for (const p of PROFILES) {
  if (existing.has(p.id)) { report.profilesSkipped.push(p.id); console.log(`   跳过（已存在）${p.id}`); continue }
  const payload = {
    actor: ACTOR,
    profile: {
      id: p.id, displayName: p.displayName, runtimeType: 'dsh', provider: PROVIDER, model: p.model,
      endpoint: BASE_URL, secretRef: 'FJD_DS_API_KEY',
      ...(p.limits ? { limits: p.limits } : {}),
    },
  }
  if (DRY) { console.log(`   [dry] 将创建 ${p.id}`); continue }
  const r = await post('/api/model-profiles', payload)
  if (r.status === 200 && r.body?.ok !== false) { report.profilesCreated.push(p.id); console.log(`   已创建 ${p.id}`) }
  else { report.errors.push(`创建档案 ${p.id} 失败：${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); console.log(`   ✗ ${p.id} → ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`) }
}

// ── ② 把死供应商的绑定改过来 ─────────────────────────────────────────────────
const rows = await get('/api/models')
const stale = rows.filter(r => r.provider === 'custom-ds')
console.log(`② 岗位绑定：共 ${rows.length} 条，其中指向 custom-ds 的 ${stale.length} 条`)
const spacesWithBindings = new Set(rows.map(r => r.scope))
for (const row of stale) {
  if (DRY) { console.log(`   [dry] ${row.scope}/${row.role}: custom-ds → ${PROVIDER}（${row.model}）`); continue }
  const r = await post('/api/models', { scope: row.scope, role: row.role, provider: PROVIDER, model: row.model, by: ACTOR })
  if (r.status === 200 && r.body?.ok !== false) { report.bindingsChanged.push(`${row.scope}/${row.role}`); console.log(`   ✓ ${row.scope}/${row.role} → ${PROVIDER}/${row.model}`) }
  else {
    const b = r.body ?? {}
    report.errors.push(`改绑定 ${row.scope}/${row.role} 失败：${r.status} ${b.message ?? b.error ?? ''} ${b.hint ?? ''}`)
    console.log(`   ✗ ${row.scope}/${row.role} → ${r.status} ${JSON.stringify(b).slice(0, 200)}`)
  }
}
const alreadyOk = rows.filter(r => r.provider !== 'custom-ds')
if (alreadyOk.length > 0) report.bindingsSkipped = alreadyOk.map(r => `${r.scope}/${r.role}=${r.provider}`)

// ── ③ 守卫兜底：给每个有绑定的空间补 assistant 行 ────────────────────────────
console.log(`③ assistant 绑定：有绑定的空间 ${[...spacesWithBindings].join('、') || '（无）'}`)
for (const scope of spacesWithBindings) {
  if (DRY) { console.log(`   [dry] ${scope}/assistant → ${PROVIDER}/${ASSISTANT_MODEL}`); continue }
  const r = await post('/api/models', { scope, role: 'assistant', provider: PROVIDER, model: ASSISTANT_MODEL, by: ACTOR })
  if (r.status === 200 && r.body?.ok !== false) { report.assistant.push(`${scope}/assistant`); console.log(`   ✓ ${scope}/assistant → ${PROVIDER}/${ASSISTANT_MODEL}`) }
  else { report.errors.push(`写 assistant ${scope} 失败：${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); console.log(`   ✗ ${scope}/assistant → ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`) }
}

// ── 读回验证 ────────────────────────────────────────────────────────────────
if (!DRY) {
  const after = await get('/api/models')
  const stillStale = after.filter(r => r.provider === 'custom-ds')
  const profiles = (await get('/api/model-profiles')).profiles ?? []
  console.log('\n=== 读回 ===')
  console.log(`模型档案：${profiles.length} 条 → ${profiles.map(p => `${p.provider}/${p.model}`).join('，')}`)
  console.log(`岗位绑定：${after.length} 条；仍指向 custom-ds 的 ${stillStale.length} 条`)
  for (const scope of [...new Set(after.map(r => r.scope))]) {
    const list = after.filter(r => r.scope === scope).map(r => `${r.role}=${r.provider}/${r.model}`)
    console.log(`  ${scope}: ${list.join('  ')}`)
  }
  report.verified = { profiles: profiles.length, bindings: after.length, stillStale: stillStale.length }
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.errors.length === 0 && stillStale.length === 0 ? 0 : 1)
} else {
  console.log('\n（dry-run：什么都没写）')
}
