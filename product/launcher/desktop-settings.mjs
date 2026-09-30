import { lstatSync, readFileSync, realpathSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { layoutDiagnostics, samePath } from '../paths.mjs'
import { assertWritableConfig, USER_SETTINGS_FILENAME, validateConfigValues } from '../config.mjs'

const filename = 'desktop.settings.json'
function invalid(code = 'DESKTOP_SETTINGS_INVALID') {
  return Object.assign(new Error('Desktop settings invalid'), { code })
}

// Check existing ancestors too: a private data path must not redirect a settings
// write to a different product's directory through a junction.
function guard(path) {
  let current = path
  for (;;) {
    try { if (lstatSync(current).isSymbolicLink()) throw invalid('DESKTOP_SETTINGS_LINK') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}

export function selectedWorkspace(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0') || !isAbsolute(value)) {
    throw invalid('WORKSPACE_SELECTION_INVALID')
  }
  try {
    const canonical = realpathSync(value)
    if (!lstatSync(canonical).isDirectory()) throw invalid('WORKSPACE_SELECTION_INVALID')
    return canonical
  } catch { throw invalid('WORKSPACE_SELECTION_INVALID') }
}

export function validateDesktopIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('DESKTOP_IDENTITY_INVALID')
  if (Object.keys(value).some(key => !['actor', 'scope', 'action', 'allowWorkspaceWrites'].includes(key))) throw invalid('DESKTOP_IDENTITY_INVALID')
  const text = field => typeof value[field] === 'string' && value[field].trim() !== ''
    && value[field].trim().length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value[field])
  if (!text('actor') || !text('scope') || !text('action') || typeof value.allowWorkspaceWrites !== 'boolean') {
    throw invalid('DESKTOP_IDENTITY_INVALID')
  }
  return Object.freeze({ actor: value.actor.trim(), scope: value.scope.trim(), action: value.action.trim(),
    allowWorkspaceWrites: value.allowWorkspaceWrites })
}

export function assertDesktopSetupLayout(layout) {
  const diagnostic = layoutDiagnostics(layout).find(item => item.severity === 'error')
  if (diagnostic) throw invalid(diagnostic.code)
  selectedWorkspace(layout.workspaceDir)
  for (const path of [layout.dataDir, layout.productConfigPath, layout.cacheDir, layout.logDir,
    join(layout.productHome, USER_SETTINGS_FILENAME),
    join(layout.workspaceDir, '.legion')]) guard(path)
}

export function readDesktopSettings(dataDir) {
  const path = join(dataDir, filename)
  guard(path)
  let stat
  try { stat = lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw invalid() }
  if (!stat.isFile() || stat.size > 8192) throw invalid()
  let value
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw invalid() }
  if (value?.version !== 1 || Object.keys(value).some(key => !['version', 'workspace'].includes(key))) throw invalid()
  const workspace = selectedWorkspace(value.workspace)
  if (!samePath(value.workspace, workspace, process.platform)) throw invalid('WORKSPACE_SELECTION_CHANGED')
  return Object.freeze({ version: 1, workspace })
}

// Called only by the product owner while it holds the existing DataDir lease.
// Workspace selection is configuration, not approval to execute a task.
export function writeDesktopSettings(layout) {
  const workspace = selectedWorkspace(layout.workspaceDir)
  const path = join(layout.dataDir, filename)
  guard(path)
  const temporary = join(layout.dataDir, `.desktop-settings-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, workspace }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return { state: 'setup-required', phase: 'identity', workspace }
}

// Identity policy lives in the highest-precedence product-owned user-settings
// layer. Project-local settings therefore cannot replace its actor or widen its
// path fence. The DSH-facing JSON environment form and the independent Runtime
// path table are generated from the same selected workspace.
export function writeDesktopIdentity(layout, input) {
  const identity = validateDesktopIdentity(input)
  const workspace = selectedWorkspace(layout.workspaceDir)
  const pathScope = Object.freeze({ version: 'legion/path-scope@1', platform: layout.platform,
    read: Object.freeze([workspace]), write: Object.freeze(identity.allowWorkspaceWrites ? [workspace] : []) })
  const pathScopeJson = JSON.stringify({ platform: layout.platform, read: [workspace], write: pathScope.write })
  const path = join(layout.productHome, USER_SETTINGS_FILENAME)
  guard(path)
  let values = {}
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > 256 * 1024) throw invalid('DESKTOP_SETTINGS_INVALID')
    values = JSON.parse(readFileSync(path, 'utf8'))
    if (values === null || typeof values !== 'object' || Array.isArray(values)) throw invalid('DESKTOP_SETTINGS_INVALID')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const updated = {
    ...values,
    runtime: {
      ...(values.runtime && typeof values.runtime === 'object' && !Array.isArray(values.runtime) ? values.runtime : {}),
      pathScope,
      env: {
        ...(values.runtime?.env && typeof values.runtime.env === 'object' && !Array.isArray(values.runtime.env) ? values.runtime.env : {}),
        LEGION_ACTOR: identity.actor,
        LEGION_SCOPE: identity.scope,
        LEGION_ENFORCEMENT_ACTION: identity.action,
        LEGION_PATH_SCOPE: pathScopeJson,
        LEGION_APPROVAL_POLICY: 'ask',
        LEGION_ATTENDED: 'true',
        LEGION_PERMISSION_PRESET: 'legion-attended',
      },
    },
  }
  assertWritableConfig(updated)
  if (validateConfigValues(updated, { layer: 'user-settings' }).some(diagnostic => diagnostic.severity === 'error')) throw invalid('DESKTOP_IDENTITY_INVALID')
  const temporary = join(layout.productHome, `.settings-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return { state: 'setup-required', phase: 'model', workspace }
}
