#!/usr/bin/env node
/**
 * run-ci.mjs — Legion 目标级发布前本地 CI 门禁（零第三方依赖，Node >= 22.5）。
 *
 * 本脚本是 T-093（部署与 CI/CD，devops 收尾）交付的统一发布流水线，整合自
 * w/T-043 / w/T-063 / w/T-064 各切片 devops 草案（均未合入 main），按最终 main HEAD
 * （06480ba，三中心 + 日程/通知 + 平台切片全部 promote 后）重新对齐并收口。
 *
 * 用法：
 *   node scripts/ci/run-ci.mjs                            # 全量门禁（env,deps,build,test,smoke,stage,doc）
 *   node scripts/ci/run-ci.mjs --only build,test          # 只跑某阶段
 *   node scripts/ci/run-ci.mjs --skip smoke               # 跳过某阶段
 *   node scripts/ci/run-ci.mjs --out docs/T093-evidence/ci-run   # 证据输出目录（ci.log + summary.json）
 *
 * 阶段：
 *   env    环境自检（node 版本 / 仓库根 / git head）
 *   deps   workbench 依赖就绪（node_modules 缺失时尝试 junction 指向主 checkout；失败即 FAIL 并给指引）
 *   build  whiteboard build（静态前端装配）+ workbench build（tsc --noEmit && vite build，产物 dist/）
 *   test   L0 契约/基线（node --test）：chat 13 + skills 12 + calendar 13 + files-api 40 + web 24
 *          + contracts 56 + whiteboard 158（12 文件，含真实服务 e2e、P3-1 治理端到端与前端静态契约）
 *          配置 DSH_CHECKOUT 时另跑 plugins 与 board-plugin 外部 DSH 回归
 *          （board-plugin 宿主 HTTP 契约：/api/artifact 逐条、/api/board、/api/events、hub 模式）
 *   smoke  L1 真实服务冒烟（仓库既有冒烟脚本直跑 + 白板真实进程探活 + v1 看板启停）
 *   stage  发布物暂存：releases/legion-<gitHead>-<date>/（dist 快照 + MANIFEST.json + SHA256SUMS.txt）
 *   doc    文档新鲜度校验：node scripts/ci/check-docs.mjs（README + docs/FEATURES.md 结构/链接/索引一致；可 --skip doc）
 *
 * 通过标准：全部阶段 PASS，exit code 0；输出落 --out 目录（默认 .ci/<时间戳>/）。
 * 沙箱说明：本仓库既有边界 = pwsh/受限 shell 拦截子进程 pipe 捕获（spawn EPERM）；
 * 在普通终端或 run_code 宿主进程执行本脚本即可全量直跑（T-043 先例，命令与产物与普通终端一致）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, statSync, rmSync, symlinkSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SELF_DIR, '..', '..')            // 仓库根（本 worktree）
const WORKBENCH = join(ROOT, 'workbench')
const WHITEBOARD = join(ROOT, 'whiteboard')

// ---------- CLI ----------
const argMap = new Map()
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const val = process.argv[i + 1]
    argMap.set(key, val !== undefined && !String(val).startsWith('--') ? val : 'true')
  }
}
const ONLY = String(argMap.get('only') || '').split(',').map(s => s.trim()).filter(Boolean)
const SKIP = String(argMap.get('skip') || '').split(',').map(s => s.trim()).filter(Boolean)
const OUT_DIR = resolve(ROOT, String(argMap.get('out') || '').trim() || join('.ci', new Date().toISOString().replace(/[:.]/g, '-')))
const LOG_FILE = join(OUT_DIR, 'ci.log')

// ---------- 小工具 ----------
function tee(s) { process.stdout.write(s + '\n'); try { appendFileSync(LOG_FILE, s + '\n') } catch { /* ignore */ } }

function exec(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const cwd = opts.cwd || ROOT
    const env = { ...process.env, CI: 'true', ...(opts.env || {}) }
    const child = spawn(cmd, args, { cwd, env, windowsHide: true, shell: opts.shell === true })
    let out = '', err = ''
    let tree = ''
    child.stdout.on('data', d => { out += d.toString() })
    child.stderr.on('data', d => { err += d.toString() })
    const timer = opts.timeoutMs ? setTimeout(() => {
      // 超时必须连**后代进程**一起杀，并留下现场快照 —— 见 killTree 注释里的实测代价。
      tree = describeDescendants(child.pid)
      killTree(child.pid)
    }, opts.timeoutMs) : null
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolvePromise({ code, out, err, tree }) })
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolvePromise({ code: -2, out, err: e.message, tree }) })
  })
}

/**
 * 超时清理：杀掉该进程的**整棵子树**。
 *
 * 实测代价（2026-09-10）：只 `child.kill()` 直接子进程时，`node --test` 运行器派生的
 * 「每文件测试进程」以及测试自己起的 hub 子进程会继续存活；它们继承了运行器的 stdout/stderr
 * 管道，于是 `close` 事件迟迟不触发 —— 一次套件超时（预算 300s）最终让整个 test 阶段跑了
 * **1153s**（多挂 850s），期间还有进程在写库。
 * Windows 用 `taskkill /T /F`（POSIX 用进程组信号）才能真正收干净。
 */
function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 尽力而为 */ }
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* 尽力而为 */ } }
}

/** 超时现场快照：列出该进程仍存活的后代及其命令行（跨平台，失败即返回空串）。
 *  没有它，「套件超时」只能得到一句「可能泄漏句柄」，无法知道到底是哪些进程没退。 */
function describeDescendants(pid) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object ProcessId,Name,CommandLine | Format-List`],
        { encoding: 'utf8', timeout: 8000, windowsHide: true })
      return (r.stdout || '').trim()
    }
    const r = spawnSync('ps', ['-eo', 'pid,ppid,args'], { encoding: 'utf8', timeout: 8000 })
    const pids = new Set([String(pid)])
    const lines = (r.stdout || '').split('\n')
    const picked = []
    for (const line of lines) { const cols = line.trim().split(/\s+/); if (cols.length > 2 && pids.has(cols[1])) { pids.add(cols[0]); picked.push(line.trim()) } }
    return picked.join('\n')
  } catch { return '' }
}

/** 单个测试套件的硬上限。测试进程若泄漏句柄（子进程/定时器）会永不退出，
 *  而 `node --test` 只在文件进程退出后才输出结果 → CI 表现为「零输出、永久等待」，
 *  比失败更糟（无法产出全量基线）。这里给每个套件加硬上限，把「卡死」变成「明确的 FAIL」。
 *
 *  注意：**不要**用 `--test-force-exit` 来兜底。实测（Windows / Node 24.19）它会触发 libuv 断言
 *  `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c line 94`，
 *  把本来全绿的套件（本仓 workbench/scripts/static-serve.test.mjs）变成「文件级失败」
 *  （exit=1、tests=7/pass=6/fail=1）——即用假失败换掉了假挂起。
 *  真正该做的是让测试自己回收句柄（见 notify-hub-smoke 的泄漏自检），外加这条超时兜底。 */
const TEST_SUITE_TIMEOUT_MS = 300000

async function runNodeTests(label, files, cwd, nodeArgs = []) {
  const t0 = Date.now()
  const r = await exec(process.execPath, [...nodeArgs, '--test', ...files], { cwd, timeoutMs: TEST_SUITE_TIMEOUT_MS })
  const elapsed = Date.now() - t0
  const timedOut = elapsed >= TEST_SUITE_TIMEOUT_MS - 500
  const all = r.out + '\n' + r.err
  // 超时现场快照并入 raw：没有它，「套件超时」只剩一句「可能泄漏句柄」，
  // 无法知道到底是哪些后代进程没退（本次排查正是缺这份证据）。
  const raw = timedOut && r.tree ? all + '\n\n[超时现场] 运行器仍存活的后代进程：\n' + r.tree + '\n' : all
  const num = (re) => { const m = re.exec(all); return m ? Number(m[1]) : NaN }
  const counts = { tests: num(/\btests\s+(\d+)/), pass: num(/\bpass\s+(\d+)/), fail: num(/\bfail\s+(\d+)/) }
  const ok = r.code === 0 && (Number.isNaN(counts.fail) || counts.fail === 0)
  const failLines = all.split('\n').filter(l => /^not ok|# fail|^✖/.test(l)).slice(0, 8).join(' | ')
  const detail = label + ': exit=' + r.code + ' tests=' + counts.tests + ' pass=' + counts.pass + ' fail=' + counts.fail
    + (timedOut ? '（套件超过 ' + Math.round(TEST_SUITE_TIMEOUT_MS / 1000) + 's 被杀（已连后代进程一起清理）：可能存在泄漏句柄或死锁）' : '')
  return { ok, code: r.code, detail: ok ? detail : detail + ' FAIL: ' + (failLines || '(see ci.log)'), raw }
}

function sha256File(file) { return createHash('sha256').update(readFileSync(file)).digest('hex') }

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const e of readdirSync(src)) {
    const s = join(src, e), d = join(dest, e)
    if (statSync(s).isDirectory()) copyDir(s, d)
    else copyFileSync(s, d)
  }
}
function isSymlink(p) { try { return lstatSync(p).isSymbolicLink() } catch { return false } }

const BIN_PKG = { tsc: 'typescript', vite: 'vite' }
function resolveBin(binName) {
  const pkgName = BIN_PKG[binName] || binName
  const pkgJson = join(WORKBENCH, 'node_modules', pkgName, 'package.json')
  if (!existsSync(pkgJson)) return null
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'))
  let rel = null
  if (typeof pkg.bin === 'string') rel = pkg.bin
  else if (pkg.bin && typeof pkg.bin === 'object') rel = pkg.bin[binName] || pkg.bin[Object.keys(pkg.bin)[0]]
  return rel ? join(WORKBENCH, 'node_modules', pkgName, rel) : null
}

async function runPackageScript(cwd, script) {
  const parts = String(script).split('&&').map(s => s.trim()).filter(Boolean)
  const outs = []
  for (const part of parts) {
    const tokens = part.split(/\s+/).filter(Boolean)
    const head = tokens[0], rest = tokens.slice(1)
    let r
    if (head === 'node') r = await exec(process.execPath, [resolve(cwd, rest[0]), ...rest.slice(1)], { cwd })
    else {
      const binFile = resolveBin(head)
      r = binFile ? await exec(process.execPath, [binFile, ...rest], { cwd }) : { code: -3, out: '', err: 'cannot resolve bin ' + head + ' in ' + cwd }
    }
    outs.push(r)
    if (r.code !== 0) break
  }
  const joined = { out: outs.map(o => o.out).join(''), err: outs.map(o => o.err).join('') }
  const bad = outs.find(o => o.code !== 0)
  return bad ? { code: bad.code, ...joined } : { code: 0, ...joined }
}

const stageResults = []

// ---------- 阶段 ----------
async function stageEnv() {
  const lines = []
  lines.push('  root=' + ROOT)
  lines.push('  node=' + process.versions.node + '（要求 >= 22.5，node:sqlite）')
  lines.push('  platform=' + process.platform + ' ' + process.arch)
  const gitR = await exec('git', ['rev-parse', '--short', 'HEAD'])
  lines.push('  git head=' + (gitR.code === 0 ? gitR.out.trim() : '(git 不可用)'))
  let ok = Number(process.versions.node.split('.')[0]) >= 22 && gitR.code === 0

  // P3-2 配置自检（统一配置系统）：三项都是「配置面是否仍然自洽」的机械检查——
  //   ① scan --check   三进程的每个 env 读取点都必须在各自 schema 中声明
  //   ② sync --check   白板副本与根配置引擎逐字节一致（防两份脱敏实现分叉）
  //   ③ check 夹具     用 --isolated-env 消除宿主会话变量影响，good 夹具必须 PASS(strict)
  // 注意：真实环境下的 `check.mjs`（不带夹具）会把当前 shell 的变量算进去，其结果依赖本机，
  // 因此不作为门禁判据——门禁只认「引擎与 schema 自洽」这一确定性部分。
  const cfgChecks = [
    ['scan', [join('scripts', 'config', 'scan.mjs'), '--check']],
    ['sync', [join('scripts', 'config', 'sync.mjs'), '--check']],
    ['check(good fixture)', [join('scripts', 'config', 'check.mjs'), '--env-file=scripts/config/fixtures/good.env', '--isolated-env', '--strict', '--quiet']],
  ]
  for (const [label, args] of cfgChecks) {
    const r = await exec(process.execPath, args, { cwd: ROOT })
    const tail = (r.out.trim().split('\n').pop() || '').trim()
    lines.push(`  config ${label}: ${r.code === 0 ? 'PASS' : 'FAIL'} ${tail}`)
    if (r.code !== 0) {
      ok = false
      lines.push((r.err || r.out).trim().split('\n').slice(-6).map(l => '    ' + l).join('\n'))
    }
  }
  return { ok, detail: 'env 自检：\n' + lines.join('\n') }
}

async function stageDeps() {
  const nm = join(WORKBENCH, 'node_modules')
  const usable = () => existsSync(nm) && existsSync(join(nm, 'typescript', 'package.json')) && existsSync(join(nm, 'vite', 'package.json'))
  if (existsSync(nm) && usable()) {
    const kind = isSymlink(nm) ? 'junction/符号链接（指向已安装依赖目录）' : '普通目录（pnpm 安装）'
    return { ok: true, detail: 'deps: workbench/node_modules 就绪（' + kind + '）' }
  }
  const candidates = [resolve(ROOT, '..', '..'), resolve(ROOT, '..')] // worktree → 主 checkout
  for (const cand of candidates) {
    const target = join(cand, 'workbench', 'node_modules')
    if (existsSync(target) && existsSync(join(target, 'typescript', 'package.json')) && existsSync(join(target, 'vite', 'package.json'))) {
      try {
        if (existsSync(nm)) rmSync(nm, { recursive: true, force: true })
        symlinkSync(target, nm, 'junction')
        return { ok: true, detail: 'deps: 已建 junction workbench/node_modules -> ' + target }
      } catch (e) { return { ok: false, detail: 'deps: junction 建立失败 ' + e.message } }
    }
  }
  return { ok: false, detail: 'deps: workbench/node_modules 不可用且未找到主 checkout 依赖。请执行 cd workbench && pnpm install（禁网纪律：需本地 store/缓存，不自动联网下载）。' }
}

async function stageBuild() {
  const detail = []
  // 1) whiteboard build（零依赖 node 脚本：共享模块 -> 静态前端）
  const wbPkg = JSON.parse(readFileSync(join(WHITEBOARD, 'package.json'), 'utf8'))
  const wbScript = (wbPkg.scripts && wbPkg.scripts.build) || 'node scripts/build.mjs'
  const r1 = await runPackageScript(WHITEBOARD, wbScript)
  if (r1.code !== 0) return { ok: false, detail: 'build: whiteboard FAIL(exit=' + r1.code + ') ' + (r1.err || r1.out).slice(-600) }
  detail.push('build: whiteboard PASS（' + wbScript + '）')
  // 2) workbench build（等价 pnpm build = tsc --noEmit && vite build）
  const wb2 = JSON.parse(readFileSync(join(WORKBENCH, 'package.json'), 'utf8'))
  const wbScript2 = (wb2.scripts && wb2.scripts.build) || 'tsc --noEmit && vite build'
  const r2 = await runPackageScript(WORKBENCH, wbScript2)
  if (r2.code !== 0) {
    return { ok: false, detail: 'build: workbench FAIL(exit=' + r2.code + ')\n' + (r2.err || r2.out).slice(-1500) }
  }
  const indexFile = join(WORKBENCH, 'dist', 'index.html')
  const hasIndex = existsSync(indexFile)
  const refs = hasIndex ? (readFileSync(indexFile, 'utf8').match(/assets\/[^"']+/g) || []) : []
  const viteTail = r2.out.split('\n').filter(l => /dist\/|built in|modules transformed/.test(l)).slice(-12).join('\n')
  detail.push('build: workbench PASS（' + wbScript2 + '）')
  detail.push(viteTail ? '  vite 输出要点：\n' + viteTail.split('\n').map(l => '    ' + l).join('\n') : '  (vite 无要点输出)')
  if (!hasIndex || refs.length === 0) return { ok: false, detail: detail.join('\n') + '\nbuild: workbench/dist 产物不完整' }
  detail.push('build: dist/index.html 存在，引用 assets x' + refs.length)
  return { ok: true, detail: detail.join('\n') }
}

async function stageTest() {
  const suites = [
    { label: 'chat（对话中心契约）', files: ['team-hub/chat.test.mjs'], cwd: ROOT },
    { label: 'skills（共享技能回归）', files: ['team-hub/skills.test.mjs'], cwd: ROOT },
    { label: 'permissions（F-02 权限内核与审批）', files: ['team-hub/permission-engine.test.mjs', 'team-hub/permissions.test.mjs', 'team-hub/skills-permission.test.mjs'], cwd: ROOT },
    { label: 'calendar（日程日历契约）', files: ['team-hub/calendar.test.mjs'], cwd: ROOT },
    { label: 'calendar-ui（P2-5 日历前端纯函数：周视图/重复文案/关联跳转/表单校验）', files: ['workbench/scripts/calendar-ui.test.mjs'], cwd: ROOT, nodeArgs: ['--experimental-strip-types'] },
    { label: 'chat-ui（P2-6 对话前端纯函数：健康判定/AI 三态/合并/断线补齐）', files: ['workbench/scripts/chat-ui.test.mjs'], cwd: ROOT, nodeArgs: ['--experimental-strip-types'] },
    { label: 'spaces（空间删除级联）', files: ['team-hub/spaces.test.mjs'], cwd: ROOT },
    { label: 'pipeline（空间流水线：编队即流水线 SP-P0）', files: ['team-hub/pipeline.test.mjs'], cwd: ROOT },
    { label: 'goal（目标生命周期）', files: ['team-hub/goal.test.mjs'], cwd: ROOT },
    { label: 'rules（规范数据面）', files: ['team-hub/rules.test.mjs'], cwd: ROOT },
    { label: 'artifact（产物读取）', files: ['team-hub/artifact-content.test.mjs'], cwd: ROOT },
    { label: 'security（监听安全配置）', files: ['team-hub/security.test.mjs'], cwd: ROOT },
    { label: 'read-auth（远程读面鉴权矩阵）', files: ['team-hub/read-auth.test.mjs', 'team-hub/read-open-loopback.test.mjs'], cwd: ROOT },
    { label: 'files-api（文件中心契约）', files: ['workbench/scripts/files-api.test.mjs'], cwd: ROOT },
    { label: 'files-p27（P2-7 文件中心后端：冲突四策略/分片续传/搜索批量/git 只读）', files: ['workbench/scripts/files-p27.test.mjs'], cwd: ROOT },
    { label: 'files-ui（P2-7 文件中心前端纯函数：策略/分片进度/git 标记与 diff 分类）', files: ['workbench/scripts/files-ui.test.mjs'], cwd: ROOT, nodeArgs: ['--experimental-strip-types'] },
    { label: 'web（浏览器助手契约）', files: ['workbench/scripts/web.test.mjs'], cwd: ROOT },
    { label: 'static-serve（静态托管：产物缺失 404 而非断流 + SPA 回退/穿越防护）', files: ['workbench/scripts/static-serve.test.mjs'], cwd: ROOT },
    { label: 'web-p28（P2-8 浏览器助手增强：缓存与 304 复用 / Readability-lite 抽取 / 配额与 429 / 可选截图）', files: ['workbench/scripts/web-p28.test.mjs'], cwd: ROOT },
    { label: 'web-history（P2-8 team-hub 抓取历史：按空间持久化、累加、隔离、清理）', files: ['team-hub/web-history.test.mjs'], cwd: ROOT },
    { label: 'browser-ui（P2-8 浏览器助手前端纯函数：限流文案、缓存与质量徽标、截图三态、配额读数）', files: ['workbench/scripts/browser-ui.test.mjs'], cwd: ROOT, nodeArgs: ['--experimental-strip-types'] },
    { label: 'doc-render（文档产物契约）', files: ['workbench/scripts/doc-render.test.mjs'], cwd: ROOT },
    { label: 'skill-importer（技能导入契约）', files: ['workbench/scripts/skill-importer.test.mjs'], cwd: ROOT },
    { label: 'hub-board（v2 看板投影）', files: ['workbench/scripts/hub-board.test.mjs'], cwd: ROOT, nodeArgs: ['--experimental-strip-types'] },
    { label: 'artifact-policy（共享路径策略）', files: ['packages/shared/test/artifact-policy.test.mjs'], cwd: ROOT },
    { label: 'config（P3-2 统一配置：引擎语义/跨进程规则/夹具端到端/默认值漂移）', files: ['scripts/config/config.test.mjs'], cwd: ROOT },
    { label: 'scrum（任务生命周期与产物）', files: ['scrum/artifact-detail.test.mjs', 'scrum/taskctl.ttl.test.mjs'], cwd: ROOT },
    { label: 'contracts（平台契约基线）', files: ['tests/contract/contracts.test.mjs'], cwd: ROOT },
    { label: 'v1v2-contract（P2-1 双服务契约对比 + P2-3 SSE 信封/续传）', files: ['tests/contract/v1v2-contract.test.mjs'], cwd: ROOT },
    { label: 'team-hub-parity（P1-1 双形态对拍：独立服务 vs 宿主前缀外壳）', files: ['tests/contract/team-hub-parity.test.mjs'], cwd: ROOT },
    { label: 'dedupe（P2-3 前端去重纯函数）', files: ['workbench/scripts/dedupe.test.mjs'], cwd: ROOT, nodeArgs: ['--experimental-strip-types'] },
    { label: 'notify（P2-4 通知分类/优先级/批量已读/跳转/去重补齐）', files: ['workbench/scripts/notify.test.mjs', 'workbench/scripts/notify-hub-smoke.test.mjs'], cwd: ROOT, nodeArgs: ['--experimental-strip-types'] },
    { label: 'hub-event-stream（F-01 scope/游标/信封）', files: ['workbench/scripts/hub-event-stream.test.mjs'], cwd: ROOT, nodeArgs: ['--experimental-strip-types'] },
    { label: 'dual-write（P1-1 双进程写同库竞态：audit.seq/task id 唯一）', files: ['scripts/ci/dual-write-smoke.test.mjs'], cwd: ROOT },
    { label: 'p13-host-injection（P1-3 真实宿主插件注入冒烟）', files: ['tests/p13-fixture/p13-host-injection.test.mjs'], cwd: ROOT },
  ]
  const wbDir = WHITEBOARD
  const wbPkg = JSON.parse(readFileSync(join(wbDir, 'package.json'), 'utf8'))
  const wbTests = ((wbPkg.scripts && wbPkg.scripts.test) || '').split(/\s+/).filter(t => t.endsWith('.mjs'))
  suites.push({ label: 'whiteboard（12 文件含真实服务 e2e、P3-1 治理端到端与前端静态契约）', files: wbTests, cwd: wbDir })
  const detail = []
  let allOk = true
  const dsh = process.env.DSH_CHECKOUT
  if (dsh && existsSync(join(dsh, 'packages'))) {
    // p13-host-injection 需要 `@dsh-external/dsh-team-hub` 的**构建产物**：
    // team-hub/package.json 的 main 指向 ./lib/index.js，而 lib/ 是未跟踪产物。
    // 此前没有任何阶段构建它 → 该套件只能在本机恰好残留 lib/ 时通过，干净检出必失败
    // （真实表现：宿主 60s 未就绪，因为 loader 报 `Cannot find module .../team-hub/lib/index.js`）。
    // 这里显式构建，使该套件可从零复现；同时 p13 在没有可用 DSH_CHECKOUT 时仍按纪律 SKIP。
    const th = await exec(process.execPath, [join(ROOT, 'scripts', 'ci', 'build-external-package.mjs'), 'team-hub'], { cwd: ROOT, env: { DSH_CHECKOUT: dsh } })
    if (th.code !== 0) {
      return { ok: false, detail: `  FAIL team-hub build（exit=${th.code}）：${(th.err || th.out).slice(-1200)}` }
    }
    detail.push('  PASS team-hub build（DSH_CHECKOUT=' + dsh + '）')
    const ext = await exec(process.execPath, [join(ROOT, 'scripts', 'ci', 'build-external-package.mjs'), 'plugins'], { cwd: ROOT, env: { DSH_CHECKOUT: dsh } })
    if (ext.code !== 0) {
      return { ok: false, detail: `  FAIL plugins build（exit=${ext.code}）：${(ext.err || ext.out).slice(-1200)}` }
    }
    suites.push({ label: 'plugins（外部 DSH 回归）', files: readdirSync(join(ROOT, 'plugins', 'tests')).filter(f => f.endsWith('.test.mjs')).map(f => join('plugins', 'tests', f)), cwd: ROOT })
    detail.push('  PASS plugins build（DSH_CHECKOUT=' + dsh + '）')
    // P1-2：board-plugin 宿主 HTTP 契约回归（fake webServer + fixture 替身；真实宿主注入冒烟属 P1-3，不在此冒充）
    const bp = await exec(process.execPath, [join(ROOT, 'scripts', 'ci', 'build-external-package.mjs'), 'board-plugin'], { cwd: ROOT, env: { DSH_CHECKOUT: dsh } })
    if (bp.code !== 0) {
      return { ok: false, detail: `  FAIL board-plugin build（exit=${bp.code}）：${(bp.err || bp.out).slice(-1200)}` }
    }
    suites.push({ label: 'board-plugin（宿主 HTTP 契约回归）', files: readdirSync(join(ROOT, 'board-plugin', 'tests')).filter(f => f.endsWith('.test.mjs')).map(f => join('board-plugin', 'tests', f)), cwd: ROOT })
    detail.push('  PASS board-plugin build（DSH_CHECKOUT=' + dsh + '）')
  } else {
    detail.push('  SKIP plugins/board-plugin（未配置可用 DSH_CHECKOUT；外部宿主测试不伪造通过）')
  }
  for (const s of suites) {
    const cwd = s.cwd || ROOT
    const r = await runNodeTests(s.label, s.files.map(f => join(cwd, f)), cwd, s.nodeArgs || [])
    allOk = allOk && r.ok
    detail.push('  ' + (r.ok ? 'PASS' : 'FAIL') + ' ' + r.detail)
    if (!r.ok) {
      // 失败套件的**原始输出**必须落盘：只留 6 行摘要曾导致事后无法定性偶发失败
      // （实测：一次 dual-write 偶发失败只留下「文件级失败」摘要，断言原文已丢失）。
      try {
        const dir = join(OUT_DIR, 'suites')
        mkdirSync(dir, { recursive: true })
        const safe = s.label.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 60)
        writeFileSync(join(dir, safe + '.log'), r.raw + '\n')
        detail.push('       原始输出：' + relative(ROOT, join(dir, safe + '.log')).split(sep).join('/'))
      } catch { /* 落盘失败不影响判定 */ }
      detail.push('  ' + (r.raw.split('\n').filter(l => /^not ok|^✖/.test(l)).slice(0, 6).join('\n  ')))
    }
  }
  return { ok: allOk, detail: detail.join('\n') }
}

// ---------- L1 冒烟（复用仓库既有冒烟脚本 + 白板真实进程 + v1 看板） ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
async function waitHttp(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 20000
  const t0 = Date.now()
  let last = ''
  while (Date.now() - t0 < timeoutMs) {
    try { const res = await fetch(url); if (res.ok) return { ok: true }; last = 'status=' + res.status } catch (e) { last = e.message }
    await sleep(400)
  }
  return { ok: false, err: last }
}

async function stageSmoke() {
  const detail = []
  const kids = []
  let allOk = true
  const stopAll = async () => { for (const k of kids) { try { k.kill() } catch { /* */ } } await sleep(600) }
  const spawnChild = (label, args, env, cwd) => {
    const child = spawn(process.execPath, args, { cwd: cwd || ROOT, env: { ...process.env, CI: 'true', ...env }, windowsHide: true })
    kids.push(child)
    child.on('exit', () => { /* 主动回收 */ })
    return child
  }
  const check = (cond, name, extra) => {
    detail.push('  [smoke] ' + (cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? ' — ' + String(extra).slice(0, 200) : ''))
    if (!cond) allOk = false
    return cond
  }
  const runSmokeScript = async (label, scriptPath) => {
    const r = await exec(process.execPath, [scriptPath], { cwd: ROOT, timeoutMs: 180000 })
    const tail = (r.out + '\n' + r.err).split('\n').filter(l => /汇总|passed|PASS|FAIL|断言通过/.test(l)).slice(-14).join(' | ')
    const ok = r.code === 0
    detail.push('  [smoke] ' + (ok ? 'PASS' : 'FAIL') + ' ' + label + '（exit=' + r.code + '）')
    detail.push('    输出要点：' + (tail || '(空)'))
    if (!ok) allOk = false
    return ok
  }

  try {
    // 1) 对话中心 L1（chat-l1-smoke：22 项断言，真实进程 + SSE + 鉴权矩阵）
    await runSmokeScript('chat-l1-smoke.mjs（对话 L1 22 项）', join(ROOT, 'team-hub', 'chat-l1-smoke.mjs'))
    // 2) 对话中心 S2 数据面（chat-s2-smoke：9 项，依赖 dist —— build 阶段已产出）
    await runSmokeScript('chat-s2-smoke.mjs（对话 S2 数据面 9 项）', join(WORKBENCH, 'scripts', 'chat-s2-smoke.mjs'))
    // 3) 文件中心 S5 数据面（files-s5-smoke：32 项，进程内 serve.mjs 路由）
    await runSmokeScript('files-s5-smoke.mjs（文件 S5 数据面 32 项）', join(WORKBENCH, 'scripts', 'files-s5-smoke.mjs'))

    // 4) whiteboard 真实进程探活（:18473，临时内存库）
    const wbPort = 18473
    spawnChild('whiteboard', [join(WHITEBOARD, 'apps', 'server', 'src', 'index.js')],
      { PORT: String(wbPort), DB_PATH: ':memory:' }, WHITEBOARD)
    const wh = await waitHttp('http://127.0.0.1:' + wbPort + '/healthz')
    if (wh.ok) {
      const hres = await fetch('http://127.0.0.1:' + wbPort + '/healthz')
      const hbody = await hres.text()
      const rres = await fetch('http://127.0.0.1:' + wbPort + '/')
      const rbody = await rres.text()
      check(wh.ok && hbody.includes('"ok":true'), 'whiteboard 真实进程 /healthz 200', hbody.slice(0, 120))
      check(rres.ok && /text\/html/.test(rres.headers.get('content-type') || '') && rbody.length > 1000, 'whiteboard GET / 200 html', 'bytes=' + rbody.length)
    } else { check(false, 'whiteboard 真实进程 /healthz', 'timeout ' + (wh.err || '')) }

    // 5) v1 看板（遗留引擎启停冒烟：随机端口 + token）
    const v1Port = 18853
    const boardFile = join(ROOT, 'scrum', 'board.json')
    const hadBoard = existsSync(boardFile)
    if (!hadBoard) writeFileSync(boardFile, '{"tasks":{}}', 'utf8')
    spawnChild('v1', [join(ROOT, 'scrum', 'serve.mjs'), '--port', String(v1Port), '--host', '127.0.0.1', '--token', 'ci-v1-tk'], {})
    const v1Ready = await waitHttp('http://127.0.0.1:' + v1Port + '/api/config')
    if (v1Ready) {
      const cfg = await (await fetch('http://127.0.0.1:' + v1Port + '/api/config')).json()
      check(cfg && cfg.auth === true, 'v1 看板 /api/config auth=true（--token 生效）', JSON.stringify(cfg || {}).slice(0, 160))
    } else { check(false, 'v1 看板 :' + v1Port + ' 启动', 'timeout') }
  } catch (e) {
    allOk = false
    detail.push('  [smoke] 异常: ' + (e && e.message ? e.message : String(e)))
  } finally {
    await stopAll()
    detail.push('  [smoke] 子进程已回收')
  }
  return { ok: allOk, detail: detail.join('\n') }
}

async function stageStage() {
  const gitHead = await exec('git', ['rev-parse', '--short', 'HEAD'])
  const head = (gitHead.out || '').trim() || 'dev'
  const releaseDir = join(ROOT, 'releases', 'legion-' + head + '-' + new Date().toISOString().slice(0, 10))
  try {
    const dist = join(WORKBENCH, 'dist')
    if (!existsSync(dist)) return { ok: false, detail: 'stage: workbench/dist 不存在：请先跑 build 阶段' }
    rmSync(releaseDir, { recursive: true, force: true })
    mkdirSync(releaseDir, { recursive: true })
    copyDir(dist, join(releaseDir, 'dist'))
    const tracked = ['workbench/scripts/serve.mjs', 'team-hub/server.mjs', 'team-hub/stage-standards.mjs', 'scrum/serve.mjs', 'services-plugin/index.js', 'whiteboard/apps/server/src/index.js']
    const sums = tracked.filter(f => existsSync(join(ROOT, f))).map(f => sha256File(join(ROOT, f)) + '  ' + f)
    const walkDist = (dir, base) => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e)
        const rel = base + '/' + e
        if (statSync(full).isDirectory()) walkDist(full, rel)
        else sums.push(sha256File(full) + '  dist' + rel)
      }
    }
    walkDist(dist, '')
    writeFileSync(join(releaseDir, 'SHA256SUMS.txt'), sums.join('\n') + '\n', 'utf8')
    const brief = stageResults.map(s => s.name + ':' + s.status).join(',')
    const manifest = {
      name: 'legion-release', version: head, gitHead: head,
      builtAt: new Date().toISOString(), node: process.versions.node, platform: process.platform,
      ciStages: brief,
      releaseNotes: '见 docs/DEPLOY.md（T-093 目标级发布 runbook）',
      distFiles: sums.filter(s => s.includes('  dist')).length,
    }
    writeFileSync(join(releaseDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    return { ok: true, detail: 'stage: 发布物暂存 -> ' + releaseDir + '\n' + JSON.stringify(manifest) }
  } catch (e) {
    return { ok: false, detail: 'stage: ' + (e && e.message ? e.message : String(e)) }
  }
}

async function stageDoc() {
  // 文档新鲜度校验（R-5 / S3）：调用零依赖脚本 check-docs.mjs，验证 README + docs/FEATURES.md 结构/链接/索引一致。
  const r = await exec(process.execPath, [join(ROOT, 'scripts', 'ci', 'check-docs.mjs')], { cwd: ROOT })
  const ok = r.code === 0
  // RC-3 修复（T-117 实测）：原实现只保留 PASS|FAIL 过滤行，check-docs 缺失/脚本语法错等模块级错误被吞
  // （ci.log 仅剩「doc: … exit=1」+「[doc] -> FAIL」，排障只能另跑 check-docs）。失败态改为带原始输出尾部。
  const raw = (r.out + '\n' + r.err).trim()
  let extra = ''
  if (ok) {
    const tail = raw.split('\n').filter(l => /PASS|FAIL/.test(l)).slice(-4).join(' | ')
    if (tail) extra = '\n  输出要点：' + tail
  } else {
    const lines = raw.split('\n').filter(Boolean)
    const fails = lines.filter(l => /^FAIL:/.test(l))
    const tail = (fails.length > 0 ? fails.slice(-10) : lines.slice(-12)).join('\n  ')
    extra = '\n  失败明细：\n  ' + tail
  }
  return { ok, detail: 'doc: 文档新鲜度校验（check-docs.mjs）exit=' + r.code + extra }
}

// ---------- 主流程 ----------
const STAGES = [
  { name: 'env', label: '环境自检', fn: stageEnv },
  { name: 'deps', label: '依赖就绪', fn: stageDeps },
  { name: 'build', label: '构建（whiteboard + workbench dist）', fn: stageBuild },
  { name: 'test', label: 'L0 契约/基线测试', fn: stageTest },
  { name: 'smoke', label: 'L1 真实服务冒烟', fn: stageSmoke },
  { name: 'stage', label: '发布物暂存', fn: stageStage },
  { name: 'doc', label: '文档新鲜度校验（check-docs.mjs）', fn: stageDoc },
]

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  try { appendFileSync(LOG_FILE, '') } catch { /* ignore */ }
  const wanted = STAGES.filter(s => (ONLY.length === 0 || ONLY.includes(s.name)) && !SKIP.includes(s.name))
  if (wanted.length === 0) { tee('no stages selected'); process.exit(2) }
  tee('Legion CI run: root=' + ROOT + ' node=' + process.versions.node)
  tee('all stages: ' + STAGES.map(s => s.name).join(',') + ' | out=' + OUT_DIR)
  tee('selected: ' + wanted.map(s => s.name).join(' -> '))
  let failed = 0
  for (const s of wanted) {
    const t0 = Date.now()
    tee('')
    tee('===== [' + s.name + '] ' + s.label + ' =====')
    try {
      const res = await s.fn()
      const status = res.ok ? 'PASS' : 'FAIL'
      if (!res.ok) failed += 1
      stageResults.push({ name: s.name, status, ms: Date.now() - t0 })
      tee(res.detail)
      tee('[' + s.name + '] -> ' + status + ' (' + (Date.now() - t0) + 'ms)')
    } catch (e) {
      failed += 1
      stageResults.push({ name: s.name, status: 'FAIL', ms: Date.now() - t0 })
      tee('[' + s.name + '] exception: ' + (e && e.message ? e.message : String(e)))
    }
  }
  tee('')
  tee('===== SUMMARY =====')
  for (const r of stageResults) tee('  ' + r.name.padEnd(6) + ' ' + r.status + ' (' + r.ms + 'ms)')
  writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify({ root: ROOT, outDir: OUT_DIR, finishedAt: new Date().toISOString(), stages: stageResults, failed }, null, 2) + '\n', 'utf8')
  tee('summary.json -> ' + join(OUT_DIR, 'summary.json'))
  process.exit(failed === 0 ? 0 : 1)
}

main()
