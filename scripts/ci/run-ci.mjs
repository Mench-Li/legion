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
    { label: 'static-serve（静态托管：产物缺失 404 而非断流 + 导航/资源区分 + SPA 回退/穿越防护）', files: ['workbench/scripts/static-serve.test.mjs'], cwd: ROOT },
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
    // PRT-002/PRT-108：DSH 执行面边界扫描。前 3 类覆盖记号识别、反误报与判定语义；
    // 第 4 类在**真实仓库**上放一个真实探针文件跑真实 CLI，证明棘轮拦得住回归——
    // 只测纯函数无法证明扫描范围（git ls-files 口径）本身是对的（该缺陷已在开发中真实出现过一次）。
    { label: 'dsh-boundary（PRT-002 依赖清单 / PRT-108 执行面边界棘轮）', files: ['scripts/ci/dsh-boundary.test.mjs'], cwd: ROOT },
    // PRT-101~107：Runtime Contract 与内存 Fake Adapter。**零 DSH 依赖**（由 dsh-boundary 的
    // must-be-zero 判定强制），因此本套件在无 DSH_CHECKOUT 的机器上也必须全绿——
    // 这正是阶段 1 完成标准「不启动 DSH 即可测试编排」的可执行形式。
    {
      label: 'runtime-contract（PRT-101~107：契约、错误分类、能力协商、Fake Adapter 编排）',
      files: ['runtime/contracts/contract.test.mjs', 'runtime/contracts/fake-adapter.test.mjs'],
      cwd: ROOT,
    },
    // PRT-007：旧系统平台契约基线（HTTP/表/状态机）。第 ④ 类用例把「当前源码提取结果」
    // 与已记录基线对账——它是**提醒**而不是迁移门禁：迁移期旧路径仍在正常演进，
    // 做成硬门禁会让每次功能提交都红，最后被人无脑 --record 刷掉，反而失去对拍价值。
    { label: 'prt-baseline（PRT-007 平台契约基线与漂移定位）', files: ['scripts/prt/baseline-snapshot.test.mjs'], cwd: ROOT },
    // PRT-004：黄金流程定义。核心断言是**夹具没有漂移**——黄金流程的全部价值建立在
    // 「输入固定」上，夹具一悄悄变，阶段 3 的新旧对拍就退化成「输入不同却以为行为不同」。
    { label: 'prt-golden-flow（PRT-004 黄金流程与固定夹具冻结）', files: ['scripts/prt/golden-flow.test.mjs'], cwd: ROOT },
    // PRT-005/009：旧路径执行证据提取。核心断言是**两个总体不混为一谈**——
    // `audit.scope` 是动作发起者的空间视图，不是任务所属空间，
    // 按它过滤会丢掉「将军从 default 视图推进 software 任务」这类行，
    // 使序列截断、耗时被低估（实测 p50 从 4184s 误算成 2531s）。
    // 这类错误不抛异常、只给出偏小的数，必须由用例守着。
    { label: 'prt-old-path（PRT-005/009 旧路径执行证据：状态序列、耗时、人工介入）', files: ['scripts/prt/old-path-evidence.test.mjs'], cwd: ROOT },
    // 阶段 0 完成标准：黄金流程执行台。核心断言是**验收四项独立重算**——
    // 真跑 npm test、真读 README、真看 git diff，不采信 agent 自述。
    // 同时钉死隔离性、流水线契约，以及「配置的岗位模型 vs 实际执行模型」的对拍
    // （真实执行里 planner 声明 pro 却跑了 flash，必须被点名）。
    { label: 'prt-gf001（阶段 0 黄金流程执行台：独立验收 + 配置不变量 + 模型偏差）', files: ['scripts/prt/gf001-run.test.mjs'], cwd: ROOT },
    // PRT-009：真实执行的 token/耗时证据提取。核心断言是**多帧 zstd 必须逐帧解**——
    // 整段一次性解压只得到第一帧（会话头），工具会「成功」报出 0 token。
    // 这类失败不报错、只给 0，必须由用例守着。
    { label: 'prt-usage（PRT-009 会话用量提取：多帧解码、token 口径、归属判定）', files: ['scripts/prt/dsh-session-usage.test.mjs'], cwd: ROOT },
    // PRT-009：基线采集器的口径与「待采集清单必须随证据结清」。
    // 清单长期不变会变成噪音；这条用例在证据文件被删/改坏时让 CI 变红。
    { label: 'prt-measure（PRT-009 基线采集：费用口径 + 待采集清单结清状态）', files: ['scripts/prt/baseline-measure.test.mjs'], cwd: ROOT },
    // PRT-001/003：进程/数据拓扑与配置密钥清单。复用 scripts/config 的扫描器（单一权威实现），
    // 自带第二份 env 正则会让两份实现漂移，而漂移的表现是「两份都不可信」。
    { label: 'prt-topology（PRT-001 拓扑 / PRT-003 配置与密钥来源清单）', files: ['scripts/prt/topology-inventory.test.mjs'], cwd: ROOT },
    // PRT-008/010：术语冻结与 DSH 组合分层基线。无 DSH_HOME 的机器上「与现状对账」
    // 那条用例会 skip 并说明原因，不会假装通过。
    { label: 'prt-composition（PRT-008 术语 / PRT-010 DSH 组合分层基线）', files: ['scripts/prt/composition-baseline.test.mjs'], cwd: ROOT },
    // PRT-006：备份/恢复验证。**用合成夹具**，不读现场库——CI 机器上没有产出机那份
    // team.db，依赖它会让本套件在 CI 上永远 skip 或永远红。夹具的关键是留一个
    // 未 checkpoint 的 WAL（插入后保持连接打开），否则「只复制 .db 会丢数据」无从证明。
    { label: 'prt-backup（PRT-006 备份/恢复验证：三条路线 + 陈旧 WAL 危害）', files: ['scripts/prt/backup-restore-verify.test.mjs'], cwd: ROOT },
    // 阶段 3 评审闸门：热点文件改动节奏。本套件直接锁定「正确写法 vs 错误写法」的差异——
    // `git log -n 40 -- <file>` 会先按路径过滤再截断，恒返回 40，把「该开工」读成「不能开工」。
    { label: 'prt-churn（阶段 3 评审闸门：热点文件改动节奏探针）', files: ['scripts/prt/hot-file-churn.test.mjs'], cwd: ROOT },
    // 阶段 2：DshRuntimeAdapter。全部用假宿主端口，覆盖真实 DSH 无法稳定复现的故障
    // （run.result 永不结算、abort 无效、畸形结果、事件流中断）。
    { label: 'dsh-adapter（PRT-201~209：DSH 适配器契约、脱敏、看门狗与取消/恢复）', files: ['runtime/adapters/dsh/adapter.test.mjs'], cwd: ROOT },
    // PRT-210/211：阶段 2 的**完成标准**在两处容易被读错的地方被钉死。
    //   ① 对拍：旧调用是 `plugins/src/index.ts` 里的复刻件，不是调用的那份代码。
    //      复刻会腐化，而**失去意义的对拍会静默通过**——所以有漂移检测守着它。
    //   ② 边界：DSH 有整套 continuable session 能力，但阶段 2 的适配器是一次性的。
    //      危险在"看起来实现了"：契约里有个可选能力叫 session-resume，
    //      照抄 DSH 上报的能力就会对外宣称支持恢复，而 recover() 只会说"继续等"，
    //      按这个宣称实现"崩溃后接着跑"得到的会是**重跑**（副作用翻倍）。
    {
      label: 'dsh-parity（PRT-210：新旧路径对拍 + 复刻件漂移检测 + 敏感信息不出现在输出）',
      files: ['runtime/adapters/dsh/parity.test.mjs'],
      cwd: ROOT,
    },
    {
      label: 'dsh-session-boundary（PRT-211：continuable session 的身份/权限/续接/取消/恢复边界）',
      files: ['runtime/adapters/dsh/session-boundary.test.mjs'],
      cwd: ROOT,
    },
    // 阶段 2：强制面（PRT-212~215）。本组用例的**核心断言全是「不生效」**——
    // 这类检查的危险失效方式是「看起来生效了」：行挂上了但没激活、
    // preset 行在但表没被覆盖、沙箱返回 partial、confine 原样返回输入 argv。
    // 四种都在组合树/返回值里长得像成功，因此必须由用例逐一钉死。
    {
      label: 'dsh-enforcement（PRT-212：canonical op 哈希、hard floor、fail-closed 策略门与双段超时审批）',
      files: ['runtime/dsh-composition/enforcement.test.mjs'],
      cwd: ROOT,
    },
    {
      label: 'dsh-composition（PRT-213~215：组合补丁层对账、沙箱实际管制探测、启动自检门禁）',
      files: ['runtime/dsh-composition/composition.test.mjs'],
      cwd: ROOT,
    },
    // 阶段 2.5：产品层契约（PRT-258 / PRT-254 目录部分）。**不启动任何进程**——
    // 「依赖顺序错了」「两个进程抢同一端口」「声明的入口根本不存在」这三类缺陷
    // 如果只在真机启动时暴露，表现分别是偶发 500、后启动者静默退出、任务一直没人做，
    // 全都不是一条明确的错误。因此判据必须能在 spawn 之前跑。
    // 另有一条用例把 MANIFEST_KNOWN_GAPS 与「对真实仓库跑出来的结果」对账：
    // 缺口补上时用例变红，逼着文档与清单一起更新（反向漂移比漏做更难发现）。
    {
      label: 'product-runtime（PRT-258：目录布局不变量、配置优先级、进程清单与启动波次）',
      files: ['product/paths.test.mjs', 'product/process-manifest.test.mjs'],
      cwd: ROOT,
    },
    // 阶段 2.5 / 阶段 5：密钥库最小闭环（PRT-505，PRT-258 的第四份契约）。
    // 这一组的断言集中在两类**不会抛异常**的失败上：
    //   ① 元数据接口（list / toJSON / 审计 / 错误对象）把值或密文带出去——
    //      它不会报错，只会把密钥写进日志与诊断包；
    //   ② 受保护后端不可用时**退化**为明文，于是「密钥受保护」在配置最特殊的
    //      那台机器上悄悄失效。
    // 另有一条在 Windows 上跑**真实 DPAPI 往返**：只用假加解密函数只能证明
    // 「我调用了自己的函数」，证明不了密文落盘、重启可解、换 blob 即解不开。
    {
      label: 'secret-store（PRT-505：引用校验、DPAPI 往返、fail-closed 与脱敏）',
      files: ['security/secrets/secrets.test.mjs'],
      cwd: ROOT,
    },
    // P4-2（候选 #9）：宿主插件导入失败诊断。host-diagnostics.test.mjs 是**纯函数**单测
    // （无 DSH 依赖，任何机器都跑）；p13-host-injection.test.mjs 内含负向用例，用真实宿主
    // 复现「入口在导入期抛错 / 入口产物缺失」两种失败并断言诊断点名到条目。
    { label: 'p13-host-injection（P1-3 真实宿主插件注入冒烟 + P4-2 导入失败诊断）', files: ['tests/p13-fixture/host-diagnostics.test.mjs', 'tests/p13-fixture/p13-host-injection.test.mjs'], cwd: ROOT },
    // P4-1：真实浏览器 DOM 端到端（零依赖 CDP 基座，见 scripts/e2e/cdp.mjs）。
    // P4-3 增补两条竞态用例（⑧⑨）：连接未就绪窗口内的绘制必须入队 + 可见提示 + 重连后补发。
    // 找不到 Edge/Chrome 时整组 **SKIP**（用例侧显式调用 describe.skip 并打印探测路径），不计失败、也不假绿。
    { label: 'e2e-browser（P4-1 真实浏览器：白板房间/角色/只读/限流 + P4-3 重连窗口补发）', files: ['tests/browser/whiteboard-ui.e2e.test.mjs'], cwd: ROOT },
  ]
  const wbDir = WHITEBOARD
  const wbPkg = JSON.parse(readFileSync(join(wbDir, 'package.json'), 'utf8'))
  const wbTests = ((wbPkg.scripts && wbPkg.scripts.test) || '').split(/\s+/).filter(t => t.endsWith('.mjs'))
  // 文件数从 package.json 的 test 脚本**算出来**，不写死：写死的数字已经漂移过一次
  // （脚本里 15 个、标签写 12），而标签正是排障时的第一手信息。
  suites.push({ label: 'whiteboard（' + wbTests.length + ' 文件含真实服务 e2e、P3-1 治理端到端、P4-5 审计归档跨重启、P4-6 单实例目录锁与前端静态契约）', files: wbTests, cwd: wbDir })
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

// ---------- DSH 执行面边界（PRT-108 棘轮） ----------
// Product Runtime 的边界承诺在 Orchestrator/Adapter 建成前，唯一可执行的形式是
// **不让 DSH 执行面耦合继续增长**。dsh-boundary.mjs 用基线棘轮守住这一点：
// 迁移期既有调用点登记为「待迁移债务」，新代码一律不得新增。
// 放在 env 之后、其余阶段之前——它是纯静态检查（秒级），失败时应尽早失败，
// 而不是等四分钟的 test 阶段跑完才报。
async function stageBoundary() {
  const r = await exec(process.execPath, [join(ROOT, 'scripts', 'ci', 'dsh-boundary.mjs'), '--check'], { cwd: ROOT })
  const ok = r.code === 0
  const raw = (r.out + '\n' + r.err).trim()
  let extra = ''
  if (ok) {
    const line = raw.split('\n').filter(l => /dsh-boundary: PASS/.test(l)).slice(-1)[0]
    if (line) extra = '\n  ' + line.trim()
  } else {
    const lines = raw.split('\n').filter(Boolean)
    const fails = lines.filter(l => /^\s*FAIL \[/.test(l))
    const tail = (fails.length > 0 ? fails.slice(-10) : lines.slice(-12)).join('\n  ')
    extra = '\n  违规明细（优先移入 runtime/adapters/dsh/；确属迁移期债务才显式下移基线）：\n  ' + tail
  }
  return { ok, detail: 'boundary: DSH 执行面边界棘轮（dsh-boundary.mjs）exit=' + r.code + extra }
}

// ---------- 主流程 ----------
const STAGES = [
  { name: 'env', label: '环境自检', fn: stageEnv },
  { name: 'boundary', label: 'DSH 执行面边界（PRT-108 棘轮）', fn: stageBoundary },
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
