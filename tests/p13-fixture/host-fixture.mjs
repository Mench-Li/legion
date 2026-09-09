/**
 * P1-3 host-injection fixture helper: boot a REAL DSH host process
 * (`dsh --profile p13fixture` over an isolated $DSH_HOME) whose profile
 * composition mounts the three legion host plugins
 * (@dsh-external/dsh-team-hub, dsh-scrum-board, dsh-scrum-worker) against the
 * real webServer + base bundles — no fakes, no port 3080, no production DB.
 *
 * Requires DSH_CHECKOUT pointing at the dsh harness checkout
 * (D:\project\DSH\dsh\deepseek-harness). Modules resolving without it are a
 * misconfiguration of the P1-3 gate, not a skip.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync, symlinkSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function requireDshCheckout() {
  const candidate = process.env.DSH_CHECKOUT || ''
  if (candidate !== '' && existsSync(join(candidate, 'packages'))) return candidate
  const alt = 'D:/project/DSH/dsh/deepseek-harness'
  if (existsSync(join(alt, 'packages'))) return alt
  throw new Error('P1-3 gate requires DSH_CHECKOUT (a dsh harness checkout with packages/)')
}

const DSH = requireDshCheckout()
export const CLI_BIN = join(DSH, 'apps', 'cli', 'lib', 'bin.js')
const PROFILE = 'p13fixture'
const EXTERNAL = {
  'dsh-team-hub': join(REPO, 'team-hub'),
  'dsh-scrum-board': join(REPO, 'board-plugin'),
  'dsh-scrum-worker': join(REPO, 'plugins'),
}

/** An OS-assigned free port (release immediately; boot race window is small). */
export function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.once('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => res(port))
    })
  })
}

function scrumFixture(parent) {
  const scrumDir = join(parent, 'scrum')
  mkdirSync(scrumDir, { recursive: true })
  for (const f of ['taskctl.mjs', 'render.mjs']) copyFileSync(join(REPO, 'scrum', f), join(scrumDir, f))
  writeFileSync(join(scrumDir, 'tasks.json'), JSON.stringify({ schemaVersion: 1, nextId: 1, tasks: {} }))
  writeFileSync(join(scrumDir, 'activity.jsonl'), '')
  return scrumDir
}

/**
 * Build one isolated fixture: home + profile composition + junctions + scrum.
 * @param {{ port: number, teamToken?: string, workerIntervalMs?: number }} opts
 */
export function makeFixture({ port, teamToken = 'p13-fixture-token', workerIntervalMs = 5000 }) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-p13-home-'))
  const profileDir = join(home, 'profiles', PROFILE)
  mkdirSync(join(profileDir, 'node_modules', '@dsh-external'), { recursive: true })
  const scrumDir = scrumFixture(join(home, 'workspace'))
  const repoRoot = join(home, 'workspace')

  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-p13fixture',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, undefined, 2) + '\n')
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')

  // The three legion plugins resolve exactly as in the production web profile
  // (profile node_modules/@dsh-external/* -> legion sources), but against an
  // isolated fixture scrum db and a never-reached worker scope.
  for (const [pkg, target] of Object.entries(EXTERNAL)) {
    const link = join(profileDir, 'node_modules', '@dsh-external', pkg)
    try { symlinkSync(target, link, 'junction') } catch { /* already there */ }
  }
  // control-plugin is a plain file-URL entry (the loader supports file: names).
  const control = resolve(join(REPO, 'tests', 'p13-fixture', 'control-plugin.mjs'))

  const scrumDirYaml = scrumDir.replace(/\\/g, '/')
  const repoRootYaml = repoRoot.replace(/\\/g, '/')
  const controlYaml = control.replace(/\\/g, '/')
  const logFileYaml = join(home, 'p13-worker.log').replace(/\\/g, '/')
  const hubDbYaml = join(home, 'workspace', 'p13-hub.db').replace(/\\/g, '/')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), `# P1-3 fixture user patch layer (isolated host, never the 3080 web profile).
- insert:
    - id: p13-webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config:
        host: '127.0.0.1'
        port: ${port}
    - id: p13-agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard
    - id: p13-control
      name: 'file:///${controlYaml}'
    - id: p13-team-hub
      name: '@dsh-external/dsh-team-hub'
      config:
        routePrefix: '/team-hub'
        teamToken: '${teamToken}'
        dbPath: '${hubDbYaml}'
    - id: p13-board
      name: '@dsh-external/dsh-scrum-board'
      config:
        scrumDir: '${scrumDirYaml}'
        routePrefix: '/scrum-board'
        hubUrl: ''
        hubProbe: false
        hubToken: '${teamToken}'
        scope: 'software'
        artifactRoots: []
    # P1-1 第 2 步：第二个 board 实例走 hub 模式（显式 hubUrl 指向宿主 /team-hub v2）
    - id: p13-board-hub
      name: '@dsh-external/dsh-scrum-board'
      config:
        scrumDir: '${scrumDirYaml}'
        routePrefix: '/scrum-board-hub'
        hubUrl: 'http://127.0.0.1:${port}/team-hub'
        hubToken: '${teamToken}'
        scope: 'default'
        artifactRoots: []
    - id: p13-worker
      name: '@dsh-external/dsh-scrum-worker'
      config:
        role: 'soldier-auto'
        intervalMs: ${workerIntervalMs}
        maxWorkers: 1
        workerTimeoutMs: 600000
        staleMinutes: 30
        provider: 'spawn'
        agentPreset: 'code'
        scrumDir: '${scrumDirYaml}'
        workspace: '${repoRootYaml}'
        isolate: false
        repoRoot: '${repoRootYaml}'
        worktreeRoot: ''
        denyTools: []
        rolesFile: ''
        logFile: '${logFileYaml}'
        hubUrl: 'http://127.0.0.1:${port}/team-hub'
        hubToken: '${teamToken}'
        scope: '__p13fixture__'
        sliceCoderSlots: 1
        sliceTesterSlots: 1
        perGoalSliceCap: 1
        maxFixPerSlice: 1
        mode: 'worker'
        mediateMergeFails: false
        dshSkillsDir: ''
`)

  return {
    home, profileDir, scrumDir, repoRoot, port, base: `http://127.0.0.1:${port}`,
    cleanup() {
      try { rmTree(home) } catch { /* tmp may linger; acceptable */ }
    },
  }
}

function rmTree(dir) {
  // Windows-safe recursive removal with retry for transient locks.
  for (let i = 0; i < 6; i++) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); return } catch { /* retry */ }
  }
}

/** Spawn the real dsh host over the fixture profile; buffers stdout+stderr. */
export function spawnHost(fx, { env = {}, cwd = REPO } = {}) {
  const child = spawn(process.execPath, [CLI_BIN, '--profile', PROFILE], {
    cwd,
    env: {
      ...process.env,
      DSH_HOME: fx.home,
      DSH_AGENTS_HOME: join(fx.home, 'agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: 'keyless-p13-no-model-call',
      ...env,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logs = { out: '', err: '' }
  child.stdout.on('data', (d) => { logs.out += d })
  child.stderr.on('data', (d) => { logs.err += d })
  child._p13logs = logs
  return child
}

/** Poll GET /__p13/ready until 200 or deadline. */
export async function waitReady(base, { timeoutMs = 45000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base + '/__p13/ready', { signal: AbortSignal.timeout(2000) })
      if (res.ok) return await res.json()
      lastErr = new Error('ready status ' + res.status)
    } catch (e) { lastErr = e }
    await sleep(intervalMs)
  }
  throw new Error('host not ready within ' + timeoutMs + 'ms' + (lastErr ? ': ' + lastErr.message : ''))
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/** Wait until child's captured stdout/stderr contains `fragment`. */
export async function waitLog(child, fragment, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const logs = child._p13logs || {}
    if ((logs.out + logs.err).includes(fragment)) return true
    await sleep(200)
  }
  return false
}

/** Minimal HTTP helper (JSON). */
export async function req(base, method, path, body, token) {
  const headers = { 'content-type': 'application/json' }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let data
  try { data = text.length > 0 ? JSON.parse(text) : null } catch { data = text }
  return { status: res.status, data, headers: res.headers }
}

/**
 * Collect SSE frames: resolve on `resolveOn(frames)` (or idle after a frame
 * when idleMs>0, or timeout). Always destroys the socket so node --test exits.
 */
export function sseCollect(base, path, { headers = {}, timeoutMs = 6000, resolveOn = null, idleMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req0 = http.request(new URL(base + path), { headers }, (res) => {
      let buf = ''
      const frames = []
      let idleTimer = null
      const done = (extra) => {
        clearTimeout(timer)
        if (idleTimer) clearTimeout(idleTimer)
        try { req0.destroy() } catch { /* closed */ }
        resolve({ status: res.statusCode, frames, ...extra })
      }
      const armIdle = () => {
        if (idleMs <= 0) return
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => done({ idle: true }), idleMs)
      }
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        buf += chunk
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          frames.push(frame)
          if (resolveOn && resolveOn(frames)) return done()
          armIdle()
        }
      })
      res.on('end', () => done())
      res.on('error', (e) => { clearTimeout(timer); req0.destroy(); reject(e) })
    })
    const timer = setTimeout(() => done({ timedOut: true }), timeoutMs)
    req0.on('error', (e) => { clearTimeout(timer); reject(e) })
    req0.end()
  })
}

/** Wait for one or more SSE connections to be closed by the server (EOF). */
export function waitSseClosed(client, { timeoutMs = 6000 } = {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    const onEnd = () => { clearTimeout(timer); resolve(true) }
    client.once('end', onEnd)
    client.once('close', onEnd)
    client.once('error', onEnd)
  })
}
