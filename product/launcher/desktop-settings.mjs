import { lstatSync, readFileSync, realpathSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { layoutDiagnostics, samePath } from '../paths.mjs'

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

export function assertDesktopSetupLayout(layout) {
  const diagnostic = layoutDiagnostics(layout).find(item => item.severity === 'error')
  if (diagnostic) throw invalid(diagnostic.code)
  selectedWorkspace(layout.workspaceDir)
  for (const path of [layout.dataDir, layout.productConfigPath, layout.cacheDir, layout.logDir,
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
