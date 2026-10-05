#!/usr/bin/env node
/**
 * legion-start.mjs —— Legion 的**单入口**：一条命令把军团拉起来（不依赖用户先开 DSH）。
 *
 * ## 它到底做了什么（以及为什么是这几件）
 *
 * 「只启动 Legion 就完成一切」不能理解成"没有 DSH 进程也能派工"：执行面（士兵守护）
 * 是**宿主内的插件**，它需要活着的 DSH 宿主。所以单入口要做的是**替用户把那个宿主
 * 拉起来并盯住它**：
 *
 *   ① 接线   —— `scripts/legion-profile.mjs --wire`（幂等；缺什么补什么）
 *   ② 找宿主 —— Legion DataDir 现役指针 → 用户级 `@deepseek-ai/dsh`（见 findDshEntry）
 *   ③ 拉宿主 —— `<node> <dsh 的 bin.js> <app 段>`，**档案名走环境变量 `DSH_PROFILE`**（见 hostArgv ③）
 *   ④ 盯就绪 —— 数据面 :8787 / 指挥面 :5173 / **执行面**（守护心跳前进）
 *   ⑤ 盯退出 —— 子进程活着就继续盯；退出就如实报出退出码
 *
 * ## ★ 判据里为什么必须有"执行面"
 *
 * 只探端口会把「服务在、守护死」报成健康 —— 这不是假想：本仓库 2026-10-03 就出现过
 * 8787/5173 都 200、而守护因为一个坏 import 一直 fetch failed 的状态。
 * 一个把那种状态报成"军团已就绪"的入口，比没有入口更坏（它会让人停止排查）。
 *
 * ## 用法
 *
 *   node scripts/legion-start.mjs                 # 接线 + 拉宿主 + 盯就绪（前台，Ctrl+C 结束）
 *   node scripts/legion-start.mjs --check         # 只体检：不接线、不拉宿主
 *   node scripts/legion-start.mjs --profile web   # 换档案（默认 web）
 *   node scripts/legion-start.mjs --no-spawn      # 已有军团就不重复起宿主
 *   node scripts/legion-start.mjs --no-wait-ready # 拉起后只观察 12s 就回收（隔离验证用）
 *   node scripts/legion-start.mjs --host-args "web --port 19517 --no-open"   # 追加 app 段
 *   node scripts/legion-start.mjs --dsh-home <dir>   # 只对本次子进程生效的 DSH_HOME（隔离验证）
 *   node scripts/legion-start.mjs --runtime-command "node <...>/dsh/lib/bin.js"
 *
 * 退出码：0 就绪（或已就绪）；3 找不到 DSH 入口；4 未就绪/超时；5 接线失败；6 宿主启动失败。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

// ── 参数 ────────────────────────────────────────────────────────────────────
function parseArgv(argv) {
  const o = {
    profile: process.env.DSH_PROFILE || 'web',
    check: false, wire: true, readyTimeoutMs: 180000, pollMs: 2000,
    runtimeCommand: null, noSpawn: false,
    hostArgs: null, noWaitReady: false, dshHome: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile') o.profile = argv[++i]
    else if (a.startsWith('--profile=')) o.profile = a.slice(10)
    else if (a === '--check') { o.check = true; o.wire = false }
    else if (a === '--no-spawn') o.noSpawn = true
    else if (a === '--no-wait-ready') o.noWaitReady = true
    else if (a === '--host-args') o.hostArgs = argv[++i]
    else if (a.startsWith('--host-args=')) o.hostArgs = a.slice(12)
    else if (a === '--dsh-home') o.dshHome = argv[++i]
    else if (a.startsWith('--dsh-home=')) o.dshHome = a.slice(11)
    else if (a === '--no-wire') o.wire = false
    else if (a === '--ready-timeout') o.readyTimeoutMs = Number(argv[++i])
    else if (a.startsWith('--ready-timeout=')) o.readyTimeoutMs = Number(a.slice(16))
    else if (a === '--runtime-command') o.runtimeCommand = argv[++i]
    else if (a.startsWith('--runtime-command=')) o.runtimeCommand = a.slice(18)
    else if (a === '--help' || a === '-h') o.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return o
}

const log = (m) => console.log(m)

// ── ① 找宿主入口 ───────────────────────────────────────────────────────────
/**
 * 两处候选，按"这份 Legion 真正会用哪一份"排序：
 *   1. Legion 自己的 DataDir 运行时（`%LOCALAPPDATA%\Legion\data\runtime\dsh\current.json` 现役指针）
 *      —— 产品 Launcher 走的就是它（`product/launcher/runtime-resolve.mjs` 的 installed-pointer）。
 *   2. 用户级 profile 依赖里的 dsh（`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js`）。
 *   3. 都没有 → 报出来并给两条修法（装运行时 / 手写 --runtime-command）。
 * 刻意**不做**任何联网安装：一个会自己联网装宿主的启动器，在离线机器上会先超时再报一个
 * 与真实原因无关的错。
 */
export function findDshEntry({ env = process.env, home = homedir() } = {}) {
  const out = []
  const dataDir = env.LEGION_DATA_DIR || (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Legion', 'data') : null)
  if (dataDir) {
    const pointer = join(dataDir, 'runtime', 'dsh', 'current.json')
    if (existsSync(pointer)) {
      try {
        const j = JSON.parse(readFileSync(pointer, 'utf8'))
        const entry = typeof j.entry === 'string' ? j.entry : null
        if (entry && existsSync(entry)) out.push({ kind: 'legion-data-dir', entry, version: j.version ?? null, pointer })
        else out.push({ kind: 'legion-data-dir', entry: null, broken: true, pointer, detail: `指针里的 entry 不存在：${entry}` })
      } catch (e) {
        out.push({ kind: 'legion-data-dir', entry: null, broken: true, pointer, detail: `指针不是合法 JSON：${e.message}` })
      }
    }
  }
  const userLevel = join(env.DSH_HOME || join(home, '.dsh'), 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(userLevel)) out.push({ kind: 'user-profile', entry: userLevel, version: versionOfUserLevel(userLevel) })
  return out
}

function versionOfUserLevel(bin) {
  try {
    const pkg = join(dirname(dirname(bin)), 'package.json')
    return JSON.parse(readFileSync(pkg, 'utf8')).version ?? null
  } catch { return null }
}

/** 从候选里挑一个：优先 DataDir（产品线），其次用户级。 */
export function pickDshEntry(cands) {
  return cands.find((c) => c.entry) ?? null
}

// ── ② 就绪判据 ─────────────────────────────────────────────────────────────
const HUB_URL = 'http://127.0.0.1:8787'
const WB_URL = 'http://127.0.0.1:5173'

async function httpOk(url, timeoutMs = 4000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ac.signal })
    return r.status
  } catch { return 0 } finally { clearTimeout(t) }
}

/**
 * 执行面判据：`<legion根>/scrum/daemon.json` 的 mtime 必须在观察窗口内**前进**。
 * 只"存在"不算 —— 一份三天前的心跳与一个活着的守护，在 `existsSync` 上是同一个东西。
 */
export function daemonHeartbeat({ root = ROOT, now = () => Date.now() } = {}) {
  const f = join(root, 'scrum', 'daemon.json')
  try {
    const st = statSync(f)
    return { path: f, mtimeMs: st.mtimeMs, ageMs: now() - st.mtimeMs }
  } catch { return { path: f, mtimeMs: null, ageMs: null } }
}

export async function probe({ root = ROOT, heartbeatWindowMs = 120000 } = {}) {
  const hub = await httpOk(`${HUB_URL}/api/config`)
  const wb = await httpOk(`${WB_URL}/`)
  const proxy = await httpOk(`${WB_URL}/hub/api/config`)
  const hb = daemonHeartbeat({ root })
  return {
    hub, wb, proxy,
    heartbeat: hb,
    executor: typeof hb.ageMs === 'number' && hb.ageMs <= heartbeatWindowMs,
  }
}

function renderProbe(p, label) {
  const ok = (b) => (b ? '✅' : '❌')
  const hb = p.heartbeat
  const age = typeof hb.ageMs === 'number' ? `${Math.round(hb.ageMs / 1000)}s 前` : '（无心跳文件）'
  return [
    `${label}`,
    `  数据面 team-hub :8787/api/config        ${ok(p.hub === 200)}  (${p.hub || '无响应'})`,
    `  指挥面 workbench :5173/                 ${ok(p.wb === 200)}  (${p.wb || '无响应'})`,
    `  中枢代理 :5173/hub/api/config           ${ok(p.proxy === 200)}  (${p.proxy || '无响应'})`,
    `  执行面 守护心跳 ${age}                 ${ok(p.executor)}`,
  ].join('\n')
}

// ── ③ 拉宿主 ───────────────────────────────────────────────────────────────
/** 把"一条命令"拆成 argv（支持带引号的路径；不做 shell 展开）。 */
export function splitCommand(cmd) {
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(String(cmd))) !== null) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/**
 * 宿主 argv。三件事必须分开，每一件都实测过：
 *
 *   ① `--runtime-command` 是"一条命令"（见 CLI 文档 / product 侧同名配置键），
 *      所以先**按引号拆分**，不能把整串当一个文件名；
 *   ② 自动解析出来的入口是**一个 `.js` 文件**（`…/@deepseek-ai/dsh/lib/bin.js`，有时是
 *      `.mjs`/`.cjs`）。直接 `spawn(那个路径)` 在 Windows 上是 `EFTYPE`——
 *      于是"找不到可执行文件"与"入口不存在"报出同一个错。所以脚本入口要**用 node 跑**；
 *   ③ ★ **档案名走环境变量 `DSH_PROFILE`，绝不当 `--profile X` 传**：`--profile` 是
 *      **node 自己的旗标**（V8 CPU profiler），会被 node 吃掉，DSH 根本看不到。
 *      实测（`scratch/probe-cli-shapes.mjs`，两运行时 × 三形状）：
 *        · `node bin.js --profile probe web` 两运行时都拒绝
 *          （0.1.5-rc.2：`web takes none of parent --profile…`；0.2.0-rc.2：`too many arguments … got 1: web`）
 *        · `DSH_PROFILE=probe node bin.js web --port …` → ✅ `dsh web: http://127.0.0.1:19941/?token=…`
 *
 * 追加的 app 段（`web --port … --no-open`）来自 `--host-args`，刻意不进 profile 层。
 */
export function hostArgv({ entry, hostArgs, nodePath = process.execPath }) {
  const parts = splitCommand(entry)
  const isScript = parts.length === 1 && /\.(mjs|cjs|js)$/i.test(parts[0])
  const head = isScript ? [nodePath, ...parts] : parts
  const extra = hostArgs ? splitCommand(hostArgs) : []
  return [...head, ...extra]
}

function spawnHost({ entry, profile, hostArgs, env = process.env }) {
  const argv = hostArgv({ entry, hostArgs })
  const [file, ...args] = argv
  const child = spawn(file, args, {
    cwd: ROOT,
    // 档案名经 `DSH_PROFILE` 交给 DSH（理由见 hostArgv ③）
    env: { ...env, ELECTRON_RUN_AS_NODE: '1', DSH_PROFILE: profile },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const lines = []
  const feed = (buf) => {
    for (const l of String(buf).split('\n')) {
      const s = l.trim()
      if (!s) continue
      lines.push(s)
      if (lines.length > 200) lines.shift()
      log(`  [宿主] ${s}`)
    }
  }
  child.stdout?.on('data', feed)
  child.stderr?.on('data', feed)
  return { child, lines }
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  let o
  try { o = parseArgv(process.argv.slice(2)) } catch (e) { console.error(`参数错误：${e.message}`); process.exit(2) }
  if (o.help) {
    console.log('用法：node scripts/legion-start.mjs [--check] [--profile web|desktop] [--no-wire] [--no-spawn]')
    console.log('      [--no-wait-ready] [--host-args "<app 段>"] [--dsh-home <dir>] [--runtime-command "<cmd>"]')
    return
  }

  // ── 架构约束（**最早**判，不等到就绪检查之后）──
  // 实测（`scratch/probe-runtime-profiles.mjs`，两个运行时都试过）：
  //   node <任何 dsh bin.js> --profile desktop → exit 1
  //     error: profile "desktop" is managed exclusively by the Electron application
  // 而 `--profile web` 两个运行时都能装载，且 web 档案的补丁层**确实被应用**（组合输出里出现
  // 5 处 `# == @deepseek-ai/dsh-base, patched by …\profiles\web\cordis.patch.yml`）。
  // 所以：单入口能拉的只有 web 档案；desktop 档案的自动启动**只能**由 DSH Desktop 完成
  // （它确实做到了 —— `.legion-services.log` 里有实证）。
  // ★ 这条必须排在最前：否则"已经有军团在跑"的短路会先返回 0，用户永远看不到这条约束。
  //   但 `--check` 是只读体检、不拉宿主，所以它照样可以看 desktop 的现状。
  if (o.profile === 'desktop' && !o.check) {
    console.error('✗ profile "desktop" 不能由命令行启动：DSH 把它独占给 Electron 应用。')
    console.error('  实测错文：error: profile "desktop" is managed exclusively by the Electron application')
    console.error('  两条路：')
    console.error('   ① 用 DSH Desktop 启动（desktop 档案的 Legion 插件已接好，会随它自动起）')
    console.error('   ② 要命令行单入口，就用 web 档案：node scripts/legion-start.mjs --profile web')
    process.exit(7)
  }

  // ── 档案接线 ──
  if (o.wire) {
    log(`① 接线档案 profile=${o.profile}`)
    const r = spawnSync(process.execPath, [join(HERE, 'legion-profile.mjs'), '--wire', '--profile', o.profile], { cwd: ROOT, stdio: 'inherit' })
    if (r.status !== 0) { console.error(`✗ 接线失败（exit ${r.status}）：先修档案再接`); process.exit(5) }
  } else {
    log('① 跳过接线（--no-wire/--check）')
  }

  // ── --check：只体检，不拉宿主 ──
  if (o.check) {
    const p = await probe()
    console.log(renderProbe(p, '体检（不启动任何东西）'))
    if (o.profile === 'desktop') {
      console.log('  注：desktop 档案**不能**由命令行启动（DSH 独占给 Electron），本行只体检它的现状')
    }
    const ready = p.hub === 200 && p.wb === 200 && p.proxy === 200 && p.executor
    // ★ 用 exitCode 而不是 process.exit()：Windows 上还有未清的 libuv 句柄时硬退会踩
    //   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（本文件实测过一次）。
    process.exitCode = ready ? 0 : 4
    return
  }

  // ── 找宿主入口 ──
  const cands = findDshEntry(o.dshHome ? { env: { ...process.env, DSH_HOME: o.dshHome } } : {})
  const picked = pickDshEntry(cands)
  log('② 宿主入口')
  for (const c of cands) log(`  · ${c.kind}: ${c.entry ?? `（不可用：${c.detail ?? '未知'}）`}${c.version ? ` v${c.version}` : ''}`)
  if (!picked && !o.runtimeCommand) {
    console.error('✗ 找不到可用的 DSH 宿主入口。两条修法：')
    console.error('  ① 用产品安装器装运行时：node product/launcher/cli.mjs --runtime-install-plan --workspace=<仓库根>')
    console.error('  ② 显式给命令行：node scripts/legion-start.mjs --runtime-command="node <...>/dsh/lib/bin.js"')
    process.exit(3)
  }

  // ── 已经就绪就不重复起（避免第二个宿主抢端口）──
  // ★ 只在**默认档案**（web/desktop，它们托管的正是那三个端口）上做这个短路。
  //   换个 profile（探测/备用档案）时，那个军团与本次要起的宿主无关，不能替它回答"已就绪"。
  const isDefaultCombatProfile = o.profile === 'web' || o.profile === 'desktop'
  const pre = await probe()
  if (isDefaultCombatProfile && pre.hub === 200 && pre.wb === 200 && pre.proxy === 200 && pre.executor) {
    console.log(renderProbe(pre, '③ 已经就绪'))
    if (o.noSpawn) { console.log(`\n指挥台：${WB_URL}`); return }
    console.log('   → 已有军团在跑，本入口不再重复启动宿主（避免第二个宿主抢端口）')
    console.log(`\n指挥台：${WB_URL}`)
    return
  }
  console.log(renderProbe(pre, '③ 启动前现状'))

  if (o.noSpawn) {
    console.error('✗ --no-spawn 且当前未就绪：本模式不启动宿主，请去掉 --no-spawn 或先排查上面的 ❌')
    process.exitCode = 4
    return
  }

  // ── 拉宿主 ──
  const entry = o.runtimeCommand ?? picked.entry
  log(`④ 启动宿主：${hostArgv({ entry, hostArgs: o.hostArgs }).join(' ')}   （DSH_PROFILE=${o.profile}）`)
  const host = spawnHost({
    entry, profile: o.profile, hostArgs: o.hostArgs,
    // `--dsh-home` 只对**这一次子进程**生效：用来在隔离的假 DSH_HOME 里验证"能不能拉起宿主"，
    // 不影响本机真实档案。
    env: o.dshHome ? { ...process.env, DSH_HOME: o.dshHome } : process.env,
  })
  let exited = null
  host.child.on('exit', (code, sig) => { exited = { code, sig }; log(`  [宿主] 退出 code=${code} sig=${sig ?? ''}`) })

  // `--no-wait-ready`：把"拉起来"与"等到就绪"分开。用来在**隔离环境**里验证"入口能不能拉起宿主"
  // （此刻真实 8787/5173 被占，就绪判据对它不适用）；等一小会儿看它有没有立刻死掉。
  if (o.noWaitReady) {
    await new Promise((r) => setTimeout(r, 12000))
    if (exited) { console.error(`✗ 宿主在 12s 内退出（code=${exited.code}）：上面几行是它的输出`); process.exit(6) }
    console.log('✓ 宿主已拉起且在 12s 内保持存活（--no-wait-ready：不判就绪，随后回收）')
    try { host.child.kill() } catch { /* 已退出 */ }
    return
  }

  let ready = false
  const deadline = Date.now() + o.readyTimeoutMs
  const firstHb = daemonHeartbeat().mtimeMs
  while (Date.now() < deadline) {
    if (exited) { console.error(`✗ 宿主提前退出（code=${exited.code}）：上面几行是它的输出`); process.exit(6) }
    const p = await probe()
    const hbAdvanced = typeof p.heartbeat.mtimeMs === 'number' && p.heartbeat.mtimeMs !== firstHb
    if (p.hub === 200 && p.wb === 200 && p.proxy === 200 && (p.executor || hbAdvanced)) {
      ready = true
      console.log(renderProbe(p, '⑤ 就绪'))
      console.log(`\n指挥台：${WB_URL}\n中枢：  ${HUB_URL}\n（宿主前台运行中；Ctrl+C 结束并回收）`)
      break
    }
    await new Promise((r) => setTimeout(r, o.pollMs))
  }

  const shutdown = () => {
    try { host.child.kill() } catch { /* 已退出 */ }
    process.exit(ready ? 0 : 4)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  if (!ready) { console.error('✗ 就绪超时'); shutdown() }

  // 就绪后继续盯：宿主死了就如实报出来（不静默）
  await new Promise((res) => host.child.on('exit', res))
  console.error(`✗ 宿主已退出（code=${exited?.code ?? '?'}）——军团执行面随之停止`)
  process.exit(exited?.code ? 1 : 0)
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  main().catch((e) => { console.error(`legion-start 失败：${e.stack ?? e.message}`); process.exit(1) })
}
