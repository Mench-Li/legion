import { createHash } from 'node:crypto'

export const WORKFLOW_PACK_FORMAT = 'legion/workflow-pack@1'
export const WORKFLOW_PACK_LIMITS = Object.freeze({ bytes: 2_000_000, roles: 32, stages: 32, prompt: 20_000, assets: 128, assetBytes: 256_000 })

const fail = code => { throw Object.assign(new Error(code), { code }) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keysOnly = (value, allowed) => Object.keys(value).every(key => allowed.includes(key))
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/
const packageIdPattern = /^[a-z0-9][a-z0-9.-]{0,95}$/
const hostPathPattern = /(?:[A-Za-z]:[\\/](?:Users|Documents|project|Projects|workspace|Workspaces)[\\/]|\\\\[^\\\s]+\\[^\\\s]+|\/home\/[^\s/]+\/)/i
const credentialPattern = /(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*[^\s"']+/i

function assertPortableText(value, code) {
  if (hostPathPattern.test(value)) fail(code)
  if (credentialPattern.test(value)) fail(code)
}

function normalizeRole(value, index) {
  if (!object(value) || !keysOnly(value, ['role', 'name', 'kind', 'avatar'])) fail('WORKFLOW_PACK_ROLE_INVALID')
  const role = typeof value.role === 'string' ? value.role.trim() : ''
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const kind = typeof value.kind === 'string' ? value.kind.trim() : ''
  const avatar = typeof value.avatar === 'string' ? value.avatar : '🤖'
  if (!idPattern.test(role) || !name || name.length > 128 || kind.length > 256 || avatar.length > 16) fail(`WORKFLOW_PACK_ROLE_INVALID_${index}`)
  return { role, name, kind, avatar }
}

function normalizeStage(value, index) {
  if (!object(value) || !keysOnly(value, ['role', 'label', 'prompt', 'next', 'gate', 'artifact', 'docs', 'enabled'])) fail('WORKFLOW_PACK_STAGE_INVALID')
  const role = typeof value.role === 'string' ? value.role.trim() : ''
  const label = typeof value.label === 'string' ? value.label.trim() : ''
  const prompt = typeof value.prompt === 'string' ? value.prompt : ''
  const next = value.next === null || value.next === undefined || value.next === '' ? null : String(value.next).trim()
  const gate = value.gate === true
  const artifact = typeof value.artifact === 'string' && value.artifact.trim() ? value.artifact.trim() : null
  const docs = value.docs === null || value.docs === undefined ? null : value.docs
  if (!idPattern.test(role) || !label || label.length > 128 || prompt.length > WORKFLOW_PACK_LIMITS.prompt
    || (next !== null && !idPattern.test(next)) || typeof value.gate !== 'undefined' && typeof value.gate !== 'boolean'
    || (artifact !== null && (artifact.length > 512 || artifact.startsWith('/') || /^[A-Za-z]:/.test(artifact) || artifact.split(/[\\/]/).includes('..')))
    || (docs !== null && (!Array.isArray(docs) || docs.length > 16 || docs.some(path => typeof path !== 'string'
      || !path.trim() || path.length > 512 || path.startsWith('/') || /^[A-Za-z]:/.test(path)
      || path.replace(/\\/g, '/').split('/').some(part => !part || part === '..'))))
    || gate && artifact === null) fail(`WORKFLOW_PACK_STAGE_INVALID_${index}`)
  assertPortableText(prompt, `WORKFLOW_PACK_STAGE_INVALID_${index}`)
  return { role, label, prompt, next, gate, artifact,
    docs: docs === null ? null : docs.map(path => path.replace(/\\/g, '/').trim()), enabled: value.enabled !== false }
}

function normalizeAsset(value, index) {
  if (!object(value) || !keysOnly(value, ['id', 'type', 'title', 'path', 'content'])) fail('WORKFLOW_PACK_ASSET_INVALID')
  const { id, type, title, path, content } = value
  if (typeof id !== 'string' || !idPattern.test(id) || !['skill', 'document', 'template'].includes(type)
    || typeof title !== 'string' || !title.trim() || title.length > 200
    || typeof path !== 'string' || !path.trim() || path.length > 512
    || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.replace(/\\/g, '/').split('/').some(part => !part || part === '..')
    || typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > WORKFLOW_PACK_LIMITS.assetBytes) fail(`WORKFLOW_PACK_ASSET_INVALID_${index}`)
  assertPortableText(content, `WORKFLOW_PACK_ASSET_INVALID_${index}`)
  return { id, type, title: title.trim(), path: path.replace(/\\/g, '/'), content }
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!object(value)) return JSON.stringify(value)
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

export function workflowPackDigest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function validateWorkflowPack(raw, { maxBytes = WORKFLOW_PACK_LIMITS.bytes } = {}) {
  if (!object(raw) || !keysOnly(raw, ['format', 'id', 'version', 'name', 'description', 'scope', 'roles', 'stages', 'assets'])) fail('WORKFLOW_PACK_MANIFEST_INVALID')
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > maxBytes) fail('WORKFLOW_PACK_TOO_LARGE')
  if (raw.format !== WORKFLOW_PACK_FORMAT || typeof raw.id !== 'string' || !packageIdPattern.test(raw.id)
    || typeof raw.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(raw.version)
    || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 128
    || typeof raw.description !== 'string' || raw.description.length > 2000
    || !object(raw.scope) || !keysOnly(raw.scope, ['id', 'name'])
    || typeof raw.scope.id !== 'string' || !idPattern.test(raw.scope.id)
    || typeof raw.scope.name !== 'string' || !raw.scope.name.trim() || raw.scope.name.length > 128) fail('WORKFLOW_PACK_MANIFEST_INVALID')
  if (!Array.isArray(raw.roles) || raw.roles.length < 1 || raw.roles.length > WORKFLOW_PACK_LIMITS.roles
    || !Array.isArray(raw.stages) || raw.stages.length < 1 || raw.stages.length > WORKFLOW_PACK_LIMITS.stages
    || (raw.assets !== undefined && (!Array.isArray(raw.assets) || raw.assets.length > WORKFLOW_PACK_LIMITS.assets))) fail('WORKFLOW_PACK_CONTENT_INVALID')
  const roles = raw.roles.map(normalizeRole)
  const stages = raw.stages.map(normalizeStage)
  const assets = (raw.assets ?? []).map(normalizeAsset)
  const unique = rows => rows.length === new Set(rows.map(row => row.role ?? row.id)).size
  if (!unique(roles) || !unique(stages) || !unique(assets)) fail('WORKFLOW_PACK_DUPLICATE_ID')
  const roleIds = new Set(roles.map(role => role.role))
  const stageIds = new Set(stages.map(stage => stage.role))
  if ([...roleIds].some(id => !stageIds.has(id)) || [...stageIds].some(id => !roleIds.has(id))) fail('WORKFLOW_PACK_ROLE_STAGE_MISMATCH')
  if (stages.some(stage => stage.next !== null && !stageIds.has(stage.next))) fail('WORKFLOW_PACK_NEXT_INVALID')
  const pack = Object.freeze({ format: WORKFLOW_PACK_FORMAT, id: raw.id, version: raw.version,
    name: raw.name.trim(), description: raw.description, scope: Object.freeze({ id: raw.scope.id, name: raw.scope.name.trim() }),
    roles: Object.freeze(roles.map(Object.freeze)), stages: Object.freeze(stages.map(Object.freeze)),
    assets: Object.freeze(assets.map(Object.freeze)) })
  return Object.freeze({ pack, digest: workflowPackDigest(pack) })
}

// Plan-only helper shared by preview UI/API and the transactional installer.
// The caller supplies the stored receipt and a normalized snapshot of target data.
export function planWorkflowPackInstall(validated, { receipt = null, scopeExists = false, currentDigest = null } = {}) {
  const { pack, digest } = validated
  if (receipt === null) return Object.freeze({ action: scopeExists ? 'conflict' : 'install', reason: scopeExists ? 'SCOPE_ALREADY_EXISTS' : null,
    packageId: pack.id, version: pack.version, scope: pack.scope.id, digest })
  if (receipt.packId !== pack.id || receipt.scope !== pack.scope.id) return Object.freeze({ action: 'conflict', reason: 'PACKAGE_RECEIPT_MISMATCH', packageId: pack.id, version: pack.version, scope: pack.scope.id, digest })
  if (receipt.version === pack.version && receipt.digest === digest) return Object.freeze({ action: 'current', reason: null, packageId: pack.id, version: pack.version, scope: pack.scope.id, digest })
  if (currentDigest !== receipt.appliedDigest) return Object.freeze({ action: 'conflict', reason: 'LOCAL_EDITS', packageId: pack.id, version: pack.version, scope: pack.scope.id, digest })
  return Object.freeze({ action: 'upgrade', reason: null, packageId: pack.id, version: pack.version, scope: pack.scope.id, digest })
}

export function ensureWorkflowPackSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_pack_installs (
    pack_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    version TEXT NOT NULL,
    digest TEXT NOT NULL,
    applied_digest TEXT NOT NULL,
    installed_at TEXT NOT NULL,
    roles_json TEXT NOT NULL,
    assets_json TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS workflow_pack_assets (
    scope TEXT NOT NULL,
    pack_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (scope, pack_id, asset_id)
  )`)
}

function scopeSnapshot(db, scope, { roles = null, assets = null } = {}) {
  const rosterRows = db.prepare('SELECT role, name, kind, avatar FROM roster WHERE scope = ? ORDER BY role').all(scope)
  const stageRows = db.prepare('SELECT role, label, prompt, next, gate, artifact, docs, enabled FROM space_stages WHERE scope = ? ORDER BY role').all(scope)
  const assetRows = db.prepare('SELECT asset_id AS id, type, title, path, content FROM workflow_pack_assets WHERE scope = ? ORDER BY asset_id').all(scope)
  const normalizedStages = stageRows.map(row => ({ role: row.role, label: row.label, prompt: row.prompt ?? '', next: row.next ?? null,
    gate: row.gate === 1, artifact: row.artifact ?? null,
    docs: row.docs === null ? null : JSON.parse(row.docs), enabled: row.enabled !== 0 }))
  const selectedAssets = assets === null ? assetRows : assets.length === 0 || typeof assets[0] !== 'string'
    ? assets : assets.map(id => assetRows.find(row => row.id === id)).filter(Boolean)
  const selectedRoles = roles === null ? rosterRows : roles.length === 0 || typeof roles[0] !== 'string'
    ? roles : roles.map(id => rosterRows.find(row => row.role === id)).filter(Boolean)
  return { roles: selectedRoles, stages: normalizedStages, assets: selectedAssets }
}

export function workflowPackAppliedDigest(db, scope, { roles = null, assets = null } = {}) {
  return workflowPackDigest(scopeSnapshot(db, scope, { roles, assets }))
}

export function inspectWorkflowPackInstall(db, validated) {
  ensureWorkflowPackSchema(db)
  const { pack } = validated
  const receiptRow = db.prepare('SELECT * FROM workflow_pack_installs WHERE pack_id = ?').get(pack.id)
  const scopeExists = Boolean(db.prepare('SELECT id FROM spaces WHERE id = ?').get(pack.scope.id))
  const receipt = receiptRow === undefined ? null : { packId: receiptRow.pack_id, scope: receiptRow.scope,
    version: receiptRow.version, digest: receiptRow.digest, appliedDigest: receiptRow.applied_digest }
  const currentDigest = receipt === null ? null : workflowPackAppliedDigest(db, pack.scope.id,
    { roles: JSON.parse(receiptRow.roles_json), assets: JSON.parse(receiptRow.assets_json) })
  return planWorkflowPackInstall(validated, { receipt, scopeExists, currentDigest })
}

export function installWorkflowPack(db, validated, { withTx = mutate => {
  db.exec('BEGIN IMMEDIATE')
  try { const value = mutate(); db.exec('COMMIT'); return value }
  catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
}, now = () => new Date().toISOString(), workspaceDir = '', audit = () => {} } = {}) {
  ensureWorkflowPackSchema(db)
  return withTx(() => {
    const plan = inspectWorkflowPackInstall(db, validated)
    if (plan.action === 'current') return { ...plan, installed: false }
    if (plan.action === 'conflict') throw Object.assign(new Error(plan.reason), { code: plan.reason, statusCode: 409 })
    const { pack } = validated
    const receipt = db.prepare('SELECT * FROM workflow_pack_installs WHERE pack_id = ?').get(pack.id)
    const roles = receipt === undefined ? null : JSON.parse(receipt.roles_json)
    const assets = receipt === undefined ? null : JSON.parse(receipt.assets_json)
    const timestamp = now()
    if (receipt === undefined) {
      db.prepare(`INSERT INTO spaces (id, name, private, local_dir, remote_url, createdAt, updatedAt)
        VALUES (?, ?, 0, ?, '', ?, ?)`).run(pack.scope.id, pack.scope.name, workspaceDir, timestamp, timestamp)
    } else {
      db.prepare('UPDATE spaces SET name = ?, local_dir = ?, updatedAt = ? WHERE id = ?')
        .run(pack.scope.name, workspaceDir || db.prepare('SELECT local_dir FROM spaces WHERE id = ?').get(pack.scope.id)?.local_dir || '', timestamp, pack.scope.id)
      for (const role of roles ?? []) {
        if (!pack.roles.some(item => item.role === role)) db.prepare('DELETE FROM roster WHERE scope = ? AND role = ?').run(pack.scope.id, role)
      }
      for (const assetId of assets ?? []) {
        if (!pack.assets.some(item => item.id === assetId)) db.prepare('DELETE FROM workflow_pack_assets WHERE scope = ? AND pack_id = ? AND asset_id = ?').run(pack.scope.id, pack.id, assetId)
      }
    }
    const upsertRole = db.prepare(`INSERT INTO roster (scope, role, name, kind, avatar, sort) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, role) DO UPDATE SET name=excluded.name, kind=excluded.kind, avatar=excluded.avatar, sort=excluded.sort`)
    for (const [index, role] of pack.roles.entries()) upsertRole.run(pack.scope.id, role.role, role.name, role.kind, role.avatar, index)
    const upsertStage = db.prepare(`INSERT INTO space_stages (scope, role, label, prompt, next, gate, artifact, docs, sort, enabled, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, role) DO UPDATE SET label=excluded.label, prompt=excluded.prompt, next=excluded.next,
        gate=excluded.gate, artifact=excluded.artifact, docs=excluded.docs, sort=excluded.sort, enabled=excluded.enabled, updatedAt=excluded.updatedAt`)
    for (const [index, stage] of pack.stages.entries()) upsertStage.run(pack.scope.id, stage.role, stage.label, stage.prompt,
      stage.next, stage.gate ? 1 : 0, stage.artifact, stage.docs === null ? null : JSON.stringify(stage.docs), index, stage.enabled ? 1 : 0, timestamp)
    const upsertAsset = db.prepare(`INSERT INTO workflow_pack_assets (scope, pack_id, asset_id, type, title, path, content)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scope, pack_id, asset_id) DO UPDATE SET
      type=excluded.type, title=excluded.title, path=excluded.path, content=excluded.content`)
    for (const asset of pack.assets) upsertAsset.run(pack.scope.id, pack.id, asset.id, asset.type, asset.title, asset.path, asset.content)
    const appliedDigest = workflowPackAppliedDigest(db, pack.scope.id,
      { roles: pack.roles.map(({ role, name, kind, avatar }) => ({ role, name, kind, avatar })), assets: pack.assets })
    db.prepare(`INSERT INTO workflow_pack_installs (pack_id, scope, version, digest, applied_digest, installed_at, roles_json, assets_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(pack_id) DO UPDATE SET scope=excluded.scope, version=excluded.version,
      digest=excluded.digest, applied_digest=excluded.applied_digest, installed_at=excluded.installed_at,
      roles_json=excluded.roles_json, assets_json=excluded.assets_json`)
      .run(pack.id, pack.scope.id, pack.version, validated.digest, appliedDigest, timestamp,
        JSON.stringify(pack.roles.map(item => item.role)), JSON.stringify(pack.assets.map(item => item.id)))
    audit(pack, validated.digest, plan.action)
    return { ...plan, installed: true }
  })
}

// Startup may add the built-in package once, but must never silently claim an
// existing scope or upgrade package content on behalf of the user.
export function bootstrapWorkflowPack(db, validated, options = {}) {
  const plan = inspectWorkflowPackInstall(db, validated)
  if (plan.action !== 'install') return { ...plan, installed: false, skipped: true }
  return { ...installWorkflowPack(db, validated, options), skipped: false }
}
