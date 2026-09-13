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

  // 源文件编码自检：**这一类损坏不会被 build/test 发现**。
  //
  // 起因是一次真实的教训：用 PowerShell 的 Get-Content/Set-Content 往返改写一个 UTF-8
  // 源文件，一个多字节 CJK 字符被写成了 U+FFFD。文件仍然能被 Node 解析（被吃掉的字符
  // 在字符串字面量**内部**），测试照样跑，只是那句错误信息悄悄变了样——而 `git diff`
  // 对**未跟踪**的文件什么都不说，所以在新文件上它完全隐形。
  //
  //   > 一个「在多字节字符被吃掉之后仍然能通过语法检查」的文件，
  //   > 与一个「看起来没变、其实信息已经变了」的文件，是同一个东西。
  {
    const r = await exec(process.execPath, [join('scripts', 'ci', 'encoding-check.mjs'), '--quiet'], { cwd: ROOT })
    const tail = (r.out.trim().split('\n').pop() || '').trim()
    lines.push(`  encoding: ${r.code === 0 ? 'PASS' : 'FAIL'} ${tail}`)
    if (r.code !== 0) {
      ok = false
      lines.push((r.err || r.out).trim().split('\n').slice(-8).map(l => '    ' + l).join('\n'))
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
    {
      // PRT-611：F-02 canonical operation —— 键序不是操作身份。
      //
      // 这一组盯的**不是**指纹算得对不对，而是**审批绑定到了哪些东西**。
      // 被替换掉的 `JSON.stringify(a) === JSON.stringify(b)` 坏在两个方向不同、
      // 而只有一个方向会有人来报 bug 的地方：
      //
      //   ① 键的书写顺序被当成操作身份。`metadata` 的键序由调用方决定，
      //      于是一次 `{path,mode}` 的批准遇到 `{mode,path}` 的再次调用就被拒。
      //      这个方向是**拒绝**（fail-closed），不造成危险，所以没人为它报 bug
      //      ——这才是它值得写下来的原因。
      //
      //        > 一个把「键的书写顺序」当成「操作的身份」的一部分的审批绑定，
      //        > 与一个"每次执行都要重新问一遍"的审批绑定，
      //        > 在"用户会不会觉得这个审批按钮没用"上是同一个东西。
      //
      //   ② 规范化**丢掉**的字段，等于审批没有绑定到它。这个方向是**放行**，
      //      才是真正危险的那一个。
      //
      //        > 一个"忘了把新字段放进规范化集合"的哈希，
      //        > 与一个"只绑定到前六个字段"的哈希，是同一个东西——
      //        > 而它的方向是**放行**。
      //
      // 所以有一条**加载时自检**：`OPERATION_KEYS` 必须与 `normalizeOperation`
      // 真正产出的字段逐个对齐——加字段却忘了同步名单，启动就崩，因为
      //「一个必须靠人记得去同步的名单，与一个迟早会不同步的名单，
      //   在「新加的字段能不能改变审批」上是同一个东西」。
      label: 'canonical-operation（PRT-611：键序不是操作身份，字段必须全都绑定）',
      files: ['team-hub/permission-engine.canonical.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-611 **补记**：授权主体补上 `toolName` / `callId` / `argsHash`，
      // 并补上那个一直缺失的**生产者**。
      //
      // spec line 470 要求主体含 `toolName`、`callId` 和不可变工具参数，而
      // `OPERATION_KEYS` 原来一个都没有——实测两个不同工具在其余字段相同时得到
      // **同一个指纹**，而 `approval-binding` 的 `bindingHash` 就是这个指纹：
      // 一次"写文件"的批准可以被一次"删文件"消费。
      //
      // ★ 这一套盯的是**接线**那一半，而不是引擎那一半：
      //
      //   > 一个「引擎已经把工具名算进授权主体」的修复，
      //   > 与一个「送进来的主体里从来没有工具名」的修复，是同一个东西——
      //   > 只不过前者的用例是绿的：引擎确实绑了，只是从来没人给它绑的东西。
      //
      // `tool-request.mjs` 的投影里本来就有 `toolName`/`callId`/`frozenBody.canonicalHash`，
      // 缺的就是那个把它们搬进 F-02 主体的函数。桥只能建在 `team-hub/` 这一侧
      // （`team-hub/` → `runtime/dsh-composition/` 是既有方向，反向实测 0 处）。
      //
      // ★ 桥里最值钱的一条是 `FROZEN_HASH_DRIFT`：投影**自带**一个哈希、同时自带
      // 一份参数，两者对不上时抛。没有它，一张"参数被换过、哈希还是老的"投影会
      // 安静地通过，而所有哈希比对都是绿的——因为绑的是一份没人执行过的参数。
      // 这条检查在写用例时**当场拦住了我自己的夹具**（改了 `arguments` 忘了改
      // `frozenHash`），那一次红是对的。
      label: 'tool-request-bridge（PRT-611 补记：投影 → F-02 授权主体）',
      files: ['team-hub/tool-request-bridge.test.mjs'],
      cwd: ROOT,
    },
    {
      // 阶段 8（PRT-801..813，spec line 979–995）：安装、升级与回滚。
      //
      // 覆盖：产品版本清单与精确锁定、可签名安装包、升级前兼容性/磁盘/在途任务
      // 预检、数据库与配置备份、幂等迁移、原子程序切换与升级后健康检查、
      // 安全回滚或向前修复、internal/canary/stable 通道、升级审计与用户通知、
      // N-1 升级窗口与恢复演练、Windows 文件占用/长路径/子进程树退出。
      //
      // ★ 升级的失败方式与安装不同：安装失败是一个干净的"没装上"，
      //   而升级失败是**一个既不是旧版也不是新版的目录**。所以这里的重点
      //   落在"切换是否原子"与"回滚是否有一条真走通的路"上，而不是版本号比较。
      //
      // ⚠️ 诚实边界见 `docs/superpowers/prt/` 阶段 8 文档；本套件只保证
      //   "判据与用例自洽"，不代表这些流程已经在真实安装上跑通过。
      label: 'product-upgrade（阶段 8 PRT-801..813：安装包、预检、备份、迁移、原子切换与回滚）',
      files: [
        'product/upgrade/audit.test.mjs',
        'product/upgrade/backup.test.mjs',
        'product/upgrade/channels.test.mjs',
        'product/upgrade/manifest.test.mjs',
        'product/upgrade/migration.test.mjs',
        'product/upgrade/package.test.mjs',
        'product/upgrade/preflight.test.mjs',
        'product/upgrade/switchover.test.mjs',
        'product/upgrade/upgrade.test.mjs',
      ],
      cwd: ROOT,
    },
    {
      // PRT-907（spec §10 line 990）：支持诊断与故障处置手册。
      //
      // 这一套盯的**不是**"有没有一份手册"，而是**支持人员照着它做的时候会不会撞墙**。
      //
      // 手写手册最常见的失效方式与隐私说明一样，只是更致命：它写在最需要它的
      // 那一刻之前，而命令行、错误码、目录布局都会变。
      //
      //   > 一个「写着运行 `legion --doctor`」的手册，
      //   > 与一个「支持人员在客户现场发现这个开关不存在」的手册，是同一个东西——
      //   > 只不过前者在文档评审里看起来是完备的。
      //
      // 所以核心手段是：**手册挂在代码自己的开关表上**。手册里每一个引用到的
      // 命令行开关，都在装载期拿去与 `product/launcher/cli.mjs` 的 `CLI_FLAGS`
      // 核对——**CLI 一改，这一套就红**，这份手册不可能悄悄过期。
      // 同理 `exit-code` 档要与**真实的 `EXIT_CODES`** 交叉核对。
      //
      // ★ 四个判据：①症状必须**可观测**（"用户说不好用"不算，且 kind 是闭集、
      //   码/读数必须真的是个标识符）；②每条处置必须有**"这步没用怎么办"**
      //   （死胡同：*照着做完仍然卡住的人此时比没有手册时更困惑*）；
      //   ③诊断步骤**声明它在产品坏掉时是否可用**，不可用的必须写明先做什么
      //   （*而最需要它的时候正是产品坏掉的时候*）；④每一类故障必须有
      //   **自己特有**的处置（全都写"导包并联系支持"等于只有一条处置）。
      //
      // ⚠️ 诚实边界：这是一份**人为撰写**的手册，本套件只检查它的内部一致性
      //   与"引用的东西是否真实存在"，**不能**证明某条处置真的解决那个故障。
      //   处置的具体动作（"换端口"、"留证据再升级"）没有任何自动化验证。
      label: 'support-runbook（PRT-907：可观测症状、死胡同、坏掉时可用性、分类可区分）',
      files: ['product/support/runbook.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-905（spec §10 line 988）：数据导出入口。
      //
      // 备份与恢复已由 `product/upgrade/backup.mjs`（PRT-806/812）实现；
      // 本套件补的是**第三件事——数据导出**，而它与前两件**不是同一个东西**：
      //
      //   · **备份**要能原样恢复：字节保真、含 WAL 与索引、只有本产品打得开；
      //   · **导出**要能**被别人读**：稳定 schema、通用格式、自描述。
      //
      //   > 一个「把数据库文件复制一份」的导出，
      //   > 与一个「用户拿到一个打不开的 .db」的导出，是同一个东西——
      //   > 只不过前者在"导出成功"这个返回值上是完全正确的。
      //
      // 所以核心判据是**导出条目必须是可移植格式**（json/ndjson/csv/text），
      // `sqlite`/`db`/二进制是**备份**格式、不是导出格式。
      //
      // ★ 另外三条：**导出不得改动源**（为了导出一致快照而 checkpoint WAL，
      //   是对运行中的产品做了一次写操作，而用户以为导出是只读的）；
      //   **部分导出必须报**（工作区默认不导出，但静默漏掉一个类与故意排除
      //   一个类，对用户是不一样的）；**密钥库永远不进导出包**（它是"不可能勾"，
      //   不是"默认不勾"——导出包会被复制、上传、发给支持人员）。
      //
      // ★ 与 PRT-904/908 一样，导出/卸载**两张表必须覆盖同一批类**——
      //   漏一个类，那个类的数据会无声地不出现在导出包里（自检核对）。
      //
      // ⚠️ 诚实边界：`planExport` 只产出计划与清单，**本仓库没有写 zip 的代码**，
      //   也没有把导出接到任何 CLI —— 它是判据，不是"产品现在能导出了"。
      //   `stores` 由调用方枚举，一份不完整的 `stores` 会让导出报告"导完了"。
      label: 'data-export（PRT-905：可移植格式、只读导出、密钥永不入包、自描述清单）',
      files: ['product/lifecycle/data-export.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-255（spec §8 line 857）：在**隔离测试空间**完成安装、运行、取消、
      // 重启和诊断验证。
      //
      // 这一套与其它 launcher 套件的分工要说清楚：`launcher.test.mjs` 直接驱动
      // **库**，`cli.test.mjs` 覆盖参数/退出码/`--init`。两者都不能回答 PRT-255
      // 真正问的那个问题：
      //
      //     **一个新用户，只用文档上的那几个开关，能不能把产品装起来并且跑起来？**
      //
      //   > 一个「所有模块的单元测试都通过」的产品，
      //   > 与一个「装完之后起不来」的产品，是同一个东西——
      //   > 只不过前者在一张张绿灯清单上看起来是完整的。
      //
      // 所以这里把产品**自己的入口**（`product/launcher/cli.mjs`）当**子进程**
      // 驱动，五步各自的判据都是**下一步骤能成立**才算上一步做完了：
      // 安装要文件真的落盘、运行要**自己连一次端口**、取消要**端口真的能再绑上**、
      // 重启要**同一组端口**还能起来、诊断要包真的落盘。
      //
      // ★ 这一套第一次跑就抓到了一个真缺陷，而且是"装得上、起不来"那一类：
      //   `resolveLayout` 的 `homeDir`/`appDataDir` 两个入参**唯一的生产调用方
      //   从来没传过**，于是产品家目录恒为 null → `secretsFile` 恒为 null →
      //   每次启动都被 `SECRETS_PLACEMENT_INVALID` 拒绝。更糟的是当时**没有任何
      //   一条诊断说得出这件事**，用户看到的唯一线索是"请先解析产品目录布局"，
      //   而布局是解析过的、命令行用户也无从照做。两处都已修，并各有用例钉住。
      //
      // ⚠️ 诚实边界：隔离的是**用户数据**（DataDir/配置），**不是程序**——
      //   程序树就是本仓库，因为进程入口按安装目录解析，这与真实产品一致
      //   （安装目录是程序，数据目录是用户的数据）。
      //   ②本平台**无法真的送控制台 Ctrl+C**：`child.kill('SIGTERM')` 在 Windows
      //   上是无条件终止，所以 CLI 里"收到信号 → 优雅收尾"那段代码在这条路径上
      //   跑不到；优雅停止的内部行为由 `supervisor.test.mjs` / `launcher.test.mjs`
      //   在进程内验证，这里验证的是**取消对用户的可观测后果**（进程结束、
      //   端口放开、同一组端口能再起来）——后者才是决定他能不能接着用的那件事。
      //   ③只覆盖 team-hub + workbench 两个进程；runtime/orchestrator 的入口在
      //   本仓库里不存在（`ENTRY_MISSING`），白板未纳入。
      //   ④用例是**真起进程**的，因此在 CI 里耗时约 10 秒且会占端口。
      label: 'isolated-space（PRT-255：安装/运行/取消/重启/诊断五步端到端）',
      files: ['product/launcher/isolated-space.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-711（spec §6.3）：产品状态 → Orchestrator 认领行为。
      //
      // `product/runtime-state.mjs` 早已把那张表做全了，但**没有任何生产调用方**
      // ——于是它从不生效：worker 只问「我能不能执行」（有没有 executor、阶段齐不齐），
      // 从不问「现在该不该执行」。
      //
      //   > 一个"引擎在、我就认领"的 worker，
      //   > 与一个在升级过程中继续把任务领走并跑起来的 worker，
      //   > 是同一个东西——只不过前者在"我能不能执行"这个问题上回答得完全正确。
      //
      // 本套件钉的是**接线**，不是判定（判定由原来那批 ㉒①–㉒⑳ 覆盖）：
      //   ① 闸门排在 `hub.claim()` **之前**——判据不是"闸门被调用了"，
      //      而是**hub 一次都没被调用过**。一个"先认领再问闸门"的实现，
      //      在"闸门被调用"这个计数上看起来是完全正确的。
      //   ② **每轮都重新问**：升级是运行中发生的，只在启动时判一次，
      //      等于在升级开始的下一秒又开始认领。
      //   ③ **问不出来 ≠ 可以认领**：闸门抛错或返回空一律落成"不认领"。
      //   ④ 没装闸门时状态里是 `not-installed` 而不是被读成"放行"。
      //
      // ⚠️ 诚实边界：`getOverrides()`（升级中 / 部分能力）今天由调用方给，
      //   **没有**从 Launcher 或升级流程实时接过来——也就是说"正在升级"这一档
      //   在真实部署里还没有人把它置为 true；接上它是 PRT-810/809 那一侧的线。
      //   `degraded` 的 `satisfiedCapabilities` 同理：判据在，喂给它的人还没有。
      //   闸门只在本进程内生效：它管的是"这个 worker 认不认领"，
      //   不是服务端的强制（服务端的资格判定在 `team-hub/claim-policy.mjs`）。
      label: 'claim-gate（PRT-711：闸门先于认领、每轮重问、问不出来就不动、未装可见）',
      files: ['orchestrator/worker/claim-gate.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-909（spec §10 line 992；完成标准 line 995）：产品发布检查清单。
      //
      // 与 PRT-614 同一条纪律——**门禁先于数字**。在 PRT-614 那里它是
      // "未批准的写操作数为 0"不能替代"门禁已满足"；在这里它是
      // "清单上每一项都打了勾"不能替代"每一项都有**这一次**的证据"。
      //
      // 一份清单最容易写成的样子是一列布尔，而"我们**从来没跑过**这条流程"
      // 与"我们跑过、它通过了"在那一列里是**同一个值**：
      //
      //   > 一个「证据缺失时默认算过」的发布清单，
      //   > 与一个「所有项都过」的清单，在报表上是同一个东西。
      //
      // 所以判定是**四值**的：pass / fail / no-evidence / stale，
      // 且只有 `pass` 算通过。`stale` 单独一档是因为 line 995 要的是
      // **可重复**验收证据——三个月前那次发布会话里递过来的一份 JSON，
      // 与这次什么都没跑，在"这次发布验证了什么"上完全等价。
      //
      // ★ 每一项都带 `evidenceFrom`（一份真实路径），**装载期会去核对它存在**
      //   ——*一个「指向一份不存在的东西」的检查项，与一个「永远不会被跑」的
      //   检查项，是同一个东西，只不过前者在清单上看起来是被覆盖的*。
      //
      // ⚠️ 诚实边界：清单**没有接任何证据生产者**，所以当前真实读数必然是
      //   "每一项都没跑过"（`realReadyWithoutEvidence === false`，有用例钉住）。
      //   这份清单绿不了，除非有人真的跑过那六条流程。
      label: 'release-checklist（PRT-909：商业 Alpha 六流程发布清单）',
      files: ['product/release/checklist.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-903 / PRT-906：隐私与模型调用说明、崩溃报告的授权与脱敏。spec §10 line 743–750。
      //
      // **PRT-903**：隐私说明最常见的失效方式不是写错，而是**写完就旧了**——
      // 代码里多加一条出境通道、多收一个字段，说明里一个字都不变，而它读起来
      // 依然完整。所以说明**挂在代码自己的允许名单上**（直接读
      // `heartbeat.ALLOWED_PAYLOAD_KEYS`、`data-classes` 台账、`CONSENT_PURPOSE_IDS`），
      // 允许名单一变就红：
      //
      //   > 一个「手写的隐私说明」，
      //   > 与一个「代码里新增了一条出境通道、而说明里一个字都没变」的说明，
      //   > 是同一个东西——只不过前者读起来是完整的。
      //
      // ★ 最要紧的一句：**「心跳默认关着」不能推出「没有数据出境」**。
      //   `DEFAULT_HEARTBEAT_POLICY.enabled === false` 很容易被读成"数据不出门"，
      //   而模型调用是**必然**出境的（由 DSH 投递，本仓库看不到目的地）。
      //
      //   > 一个「心跳关闭，因此没有数据出境」的隐私说明，
      //   > 与一个「用户的目标与代码正在被送给模型供应商」的说明，是同一个东西——
      //   > 只不过前者在"我们自己的通道"这个范围内是完全正确的。
      //
      //   所以出境通道分三类且 `delegated-dsh` 必须非空。
      //
      // ★ 装载期自检**抓出了一个真缺口**：`model-call` 要求用户同意却没有对应
      //   同意事项（`consentPurpose: null`）——一条"要求同意"却无处表达的通道。
      //   已在 `crash-report.mjs` 补同名事项。这是本模块存在的理由的自我演示。
      //
      // **PRT-906**：授权不能集中在一个布尔上——诊断包由用户主动生成，
      // 而崩溃报告是进程崩了、**没有人在场可以问**。三个坑：①"先存下来以后再问"
      // 等于在没人同意过的磁盘上留着未脱敏的转储；②"没同意"与"没说"合并会让
      // 读不出来的配置变成默认同意；③撤销只影响将来等于用户点了拒绝而那份报告
      // 还在等着某天被上传。同意状态是**三分**的（granted/denied/unknown），
      // 出厂默认全部 unknown。`transmit: uploadOk && captureLocal` 挡的是
      // "只勾了上传、于是临时生成一个未脱敏的副本直接发走"。
      // "带脱敏映射表"不算已脱敏——原文与占位符的对应关系就在包里。
      label: 'privacy-and-consent（PRT-903/906：隐私说明与崩溃报告授权）',
      files: [
        'product/release/privacy.test.mjs',
        'product/diagnostics/crash-report.test.mjs',
      ],
      cwd: ROOT,
    },
    {
      // 阶段 10（PRT-1001..1006，spec line 997–1006）：能力包协议。
      //
      // 完成标准（line 1006）：更新能力包不改变运行中目标；不兼容、缺依赖、
      // 哈希错误或越权包在**创建目标前**失败。
      //
      // ★ 三个最关键的破坏都变红：`planOf` 回落到最新版（运行中目标被升级改变）、
      //   越权基线取自**包自己的声明**（"以自己为基线"永远干净）、
      //   预检不通过仍建出目标。
      //
      // ⚠️ **诚实边界**：`runtime/packs/` 在整仓里**零生产调用方**——
      // 没接 `RunContextSnapshot`（spec §6.5 line 344 要求它第一行是
      // CompiledTeamPlan 快照）、没进 `runtime/contracts/index.mjs`。
      // 所以 PRT-1004 的"运行中版本固定"与 line 1006 的"创建目标前失败"
      // 是**对一个注入接缝**成立的，不是对运行中的产品成立的。
      // 另外 PRT-1002 的"签名"是**注入 verifier 的接缝**，不是密码学实现。
      label: 'pack-protocol（阶段 10 PRT-1001..1006：包清单与哈希预检、安装记录、不可变计划与运行中版本固定、越权与密钥、内置首包）',
      files: [
        'runtime/packs/manifest.test.mjs',
        'runtime/packs/store.test.mjs',
        'runtime/packs/compiled-plan.test.mjs',
        'runtime/packs/authority.test.mjs',
        'runtime/packs/builtin/software-delivery.test.mjs',
      ],
      cwd: ROOT,
    },
    {
      // PRT-619 / PRT-620 / PRT-617：Run 期间冻结与改写审计、跨点一致性、两段超时。
      //
      // **PRT-619**（spec line 941）：PRT-607 只实现了**拒绝**，本批补的是
      // 冻结**快照**与改写**审计**——没有审计，"策略在 Run 期间没变"是一句
      // 事后无法查证的话。
      //
      // **PRT-620**（spec line 942 / line 479）：guard 只有**降级**语义、
      // 没有放行语义，所以被 pre-execute + `allowed-once` 放行的调用**不可能**
      // 被 guard 拒绝；违规必须能**定位到具体强制点**。
      //
      // **PRT-617**（spec line 939 / line 476–477）：两段超时（连接 + 响应）
      // 必须**各自可观测**，且 team-hub 不可达要 `unavailable` fail closed——
      // **不得**"等 team-hub 恢复后再询问"，也不得伪装成 rejected。
      //
      // ⚠️ **诚实边界**：大半新 API 没有生产调用方（记类型与不变量，不是
      // "已经拦住了"）；`portsPhases` 默认 `false` 是刻意的——默认 `true` 会让
      // 现有端口（都不调 `onConnected`）在 2s 后报 `CONNECT_TIMEOUT`、
      // 改变既有行为，所以真实链路上目前只能拿到 `PHASE_UNREPORTED`；
      // "审计可定位"≠有审计读取方（没有 `tool_calls → 检查器` 的适配器）。
      label: 'dsh-composition 冻结/跨点/可用性（PRT-619/620/617）',
      files: [
        'runtime/dsh-composition/knob-freeze.test.mjs',
        'runtime/dsh-composition/guard-consistency.test.mjs',
        'runtime/dsh-composition/availability.test.mjs',
      ],
      cwd: ROOT,
    },
    {
      // PRT-904 / PRT-908：数据生命周期——保留策略与卸载去留。spec §10 line 748–749。
      //
      // 这两个任务共用一份**数据分类台账**（`data-classes.mjs`），因为它们是同一个
      // 问题：*这份数据属于哪一类，因此该拿它怎么办？*
      //
      //   > 一个「保留策略按一张类表、卸载按另一张类表」的实现，
      //   > 与一个「某一天卸载会删掉保留策略承诺保留的东西」的实现，是同一个东西——
      //   > 只不过前者在任何单独一张表上都是自洽的。
      //
      // **PRT-904 的三个安静的坑**：
      //   ① 只对一个类做容量核算、却把结果当成总用量 → 另外两类无界增长；
      //   ② 删掉最新而不是最旧 → 用量确实降下来了，"指标完全成功"；
      //   ③ 删掉还被进行中 Run 引用的产物 → 失败发生在很久之后的另一步。
      //
      // ⚠️ **坑③ 是我第一版的真实 bug**：引用检查只写在**容量**那一轮，
      // 漏了**时间**那一轮，于是"超过 30 天的产物"照样被删、哪怕它正被一个
      // 进行中的 Run 用着。用例把它打红了（探针 53② 就是把它改回去）。
      //
      //   > 一个「在两条删除规则里只有一条做了引用检查」的保留策略，
      //   > 与一个「按时间清掉的正好是还在用那个」的策略，是同一个东西——
      //   > 只不过它在容量那一条规则上是完全正确的。
      //
      // **PRT-908 的核心**：判据不接受"要删什么"作为输入，而接受**磁盘上实际
      // 存在什么**。因为"按清单删了几个路径、报告成功"的失败方式是漏掉一个落点时
      // 照样返回 ok。认不出类别的落点进 `refuse`——**"少删了"可补救，"误删了"不能**。
      //
      // ★ "保留数据"与"把凭据留在磁盘上"是两件事：`keep-data` 必须留下 team.db
      // 而删掉密钥库。而分类器必须**先判密钥、再判容器**——否则一个把密钥库配在
      // dataDir 下的用户会被归成"业务数据库"，于是 keep-data 会**静默地留下凭据**。
      // 三种模式对凭据的表态必须不同（program-only 留、另两个删）。
      label: 'data-lifecycle（PRT-904/908：保留策略与卸载去留）',
      files: [
        'product/lifecycle/retention.test.mjs',
        'product/lifecycle/uninstall.test.mjs',
      ],
      cwd: ROOT,
    },
    {
      // PRT-901 / PRT-902：第三方组件清单与 SBOM，以及商业分发条件。spec §10 line 745。
      //
      // 这一套盯的**不是**"能不能生成一份 SBOM"，而是**那份 SBOM 会不会漏东西**。
      // 本仓库没有根 package.json，依赖分散在 7 个 workspace 清单里，而其中一份属于
      // 一棵**被跟踪的 vendored 第三方源码树**（`.skills-cache/` 下 499 个文件）。
      //
      // ⚠️ 这里写准确——**第一版注释写错了**：那棵树**是**有清单的，所以"只读清单"
      // 的 SBOM **会**扫到它。它漏掉的是另一种：**没有清单的 vendored 代码**，
      // 以及落在被跳过目录（`docs/`、`scratch/`）下的采集副本。
      //
      //   > 一个「从各 workspace 的 package.json 依赖生成的 SBOM」，
      //   > 与一个「只覆盖了"恰好带清单的那些"第三方代码」的 SBOM，是同一个东西——
      //   > 只不过前者看起来是完整的。
      //
      // 所以判据**两个来源都收**，而"哪些是 vendored 树"由调用方**注入**——
      // 不可注入时，用例没法在假磁盘上验证"多了一棵没有清单的树"。
      //
      // ★ 第二个坑：`.skills-cache/main/teamai-cli-main` 既是一棵 vendored 树、
      // 又有一份清单。第一版两处都记，于是同一个 MIT 组件被数了两次
      // （`permissive: 2`）——**这是我在真实仓库上跑出来才发现的**。
      //
      //   > 一个「同一份代码在报表里出现两次、于是'覆盖了 2 个宽松许可组件'」的 SBOM，
      //   > 与一个「其实只有 1 个」的 SBOM，是同一个东西——只不过前者让人以为覆盖面更大。
      //
      // ★ 第三个：「没读到许可」与「没有许可」必须报**不同的原因**。43 个依赖的许可
      // 写在它们自己的 package.json 里，而依赖树不在磁盘上——把它们都报成"没有许可"
      // 是一次夸大，而夸大一个合规缺口与漏报一个，在"这份报表能不能用来做决定"上
      // 是同一个东西。`private: true` 的 workspace 同理：它不随产品分发，
      // 与"未知"混成一个会让真正的未知被淹掉。
      label: 'compliance-inventory（PRT-901/902：清单与 SBOM 的覆盖面、分发条件）',
      files: [
        'product/compliance/inventory.test.mjs',
        'scripts/prt/sbom.test.mjs',
      ],
      cwd: ROOT,
    },
    {
      // PRT-614：新强制面完成前的 legacy 高风险工具禁用 + 发布门禁。
      //
      // spec line 936；§6.6 line 472。本套盯的**不是**"门禁能不能跑"，
      // 而是**报表会不会说谎**：
      //
      //   > 一个「报表上写着'未批准高风险写操作为零'」的发布门禁，
      //   > 与一个「因为没有一条高风险写被真的试过、于是那个数字当然是零」的发布门禁，
      //   > 是同一个东西——只不过前者看起来是一个通过的指标。
      //
      // spec line 472 的最后半句就是这件事：「"未批准高风险写操作为零"**只在该门禁
      // 满足后**成为发布指标」。所以 `evaluateReleaseMetric` 在门禁未满足时返回
      // `not-a-metric-yet`，**不是** `pass`——即使 `unapproved === 0`。
      //
      // ★ 顺序判据：门禁**先于**数字被检查。反过来写（先看 `unapproved === 0`）
      // 会在"门禁没满足但恰好 0 次未批准"时给出 pass——那才是危险的那一半。
      // 用例**两个方向都打**（0 次未批准、以及 3 次未批准），而不只是零那一侧。
      //
      // ★ 第二条：`0 / 0` 不是证据。一个从没被尝试过的类别，与一个被尝试且全部
      // 合规的类别，在报表上是同一个 `0`。
      //
      // ★ 第三条：legacy + 高风险 + 门禁未满足 → **拒绝**；而 product-runtime 上
      // **不**禁止（否则就变成"永久禁用"，那不是 spec 说的"在完成接线**前**禁止"）。
      label: 'release-gate（PRT-614：legacy 高风险工具禁用与发布门禁不可以说谎）',
      files: [
        'runtime/dsh-composition/release-gate.test.mjs',
        'scripts/prt/release-gate.test.mjs',
      ],
      cwd: ROOT,
    },
    {
      // PRT-608：审批绑定到**写下来的**规范化操作哈希。
      //
      // PRT-611 已经把"两次调用是不是同一个操作"换成了规范化指纹。但如果审批行里
      // 只存操作 JSON、验证时再算一遍指纹，那么**审批的身份是由今天这份代码定义的**。
      // 后果很具体：有人往 `OPERATION_KEYS` 加了一个字段（这正是 PRT-611 的加载时
      // 自检在鼓励的事），所有还在等待的审批会在一夜之间悄悄改变含义——昨天批准的
      // 那次调用今天可能对不上，更糟的是反过来。而整个过程没有一条日志，
      // 因为每一次验证都在"用当前规则算一遍"。
      //
      //   > 一个"每次验证时按当前规则重算身份"的审批绑定，
      //   > 与一个"审批的含义由你读它的那一刻的代码决定"的绑定，
      //   > 是同一个东西——只不过前者的失效方式是**静默重绑**。
      //
      // 所以批准的那一刻算出哈希、写进那一行。另一半是迁移遗留的行（哈希为 NULL）：
      //
      //   > 一个"老的审批行没有哈希，那就跳过哈希校验"的回退，
      //   > 与一个"任何审批都放行"的回退，是同一个东西。
      //
      // NULL 哈希是一个**独立的拒绝码**，而不是"不检查"；而且**有意不回填**——
      // 回填等于"用今天的规则替一批旧行算出它们的身份"，那正是上面那条纪律要防的事。
      label: 'approval-binding（PRT-608：审批绑定到写下来的哈希，没有哈希就拒绝）',
      files: ['team-hub/approval-binding.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-615：审批 TTL（spec §6.4）。
      //
      // `AwaitingApproval` 期间 heartbeat 继续续租，但**绝不超过审批截止时刻**。
      // 这一条不是"过期了就清掉"那么轻：审批过期而 Attempt 还停在 `AwaitingApproval`，
      // 表现是任务安静地停在那里——界面上它是一条待审批的待办，而审批已经过期，
      // 于是它既不会被批准、也不进等人工列表。
      //
      //   > 一个「审批已过期、而 Attempt 还在等这份审批」的状态，
      //   > 与一个「任务永远停在那里、谁也不管」的状态，是同一个东西。
      //
      // 另一半是租约的上界：越过截止时刻后**拒绝续期**，而不是续一个很短的租约——
      // 续短租约会让租约先于自动拒绝到期，另一个 worker 领走同一条任务并重复执行
      // 它正在等审批的那个外部写操作，直接违背 §15。
      //
      //   > 一个「在审批到期的前一刻把任务让给别人重做」的暂停，
      //   > 与一个「把同一件已经做过一半的外部写操作再交给第二个人做一遍」的暂停，
      //   > 是同一个东西。
      label: 'approval-ttl（PRT-615：审批 TTL 到期自动拒绝，租约不得越过截止时刻）',
      files: ['team-hub/approval-ttl.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-616：`allow-once` 的原子占位（spec §6.5）。
      //
      // PRT-608 的行级 CAS 保证的是"**这一行**只被消费一次"。而危险场景里根本
      // 不存在"这一行"：同一 Attempt 内两次参数完全相同的并发调用会各自写下一条
      // 待批准行，各被批准一次，然后**各自**成功消费一次——行级 CAS 全程尽职，
      // 而同一个操作执行了两次。
      //
      //   > 一个「每一行都只被消费一次」的 CAS，
      //   > 与一个「同一个操作被放行两次」的 CAS，在「它到底防住了什么」上是同一个东西。
      //
      // 所以要第二把锁，它的键**不是行**，而是"这一次授权的内容"：
      // `(attemptId, bindingHash)`，落在 `approval_consumptions` 的主键上。
      // 键必须带无歧义的分隔符，且缺 Attempt 时不能退化成一把全局哈希锁——
      // 那会让合法调用被**永久**拒绝。
      label: 'allow-once（PRT-616：同一 Attempt 内同一 canonical 哈希只放行一次）',
      files: ['team-hub/allow-once.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-609：字段变化必须让审批失效（spec §6.5，阶段 6 完成标准）。
      //
      // 「**任一**授权关键字段变化都会使审批失效」是一句**全称命题**，
      // 不能用"我试了三个字段"来交付——一个覆盖了 6/7 个字段的测试，
      // 与一个 0/7 的测试，在"剩下那个字段改了会怎样"上是同一个东西：没有答案。
      //
      // PRT-611 的 `assertOperationKeysAligned` 只比**字段名**，它拦不住
      // "字段在名单里、但值根本不进指纹"——那正是本套件逐字段构造性验证的对象。
      label: 'field-invalidation（PRT-609：改变已批准操作的任一关键字段后无法继续执行）',
      files: ['team-hub/field-invalidation.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-610：持久化工具调用、决定与**决定来源**、结果和幂等键（spec §6.8）。
      //
      // 来源列存在的全部意义是 §6.8 那句"否则事后无法区分策略拒绝与沙箱兜底拒绝，
      // 而这两类的修复动作不同"。所以本套件盯四件事：
      //   ① 来源闭合、且与强制点语义一致（guard 只有降级语义、没有 allow 语义）
      //   ② 原始输入与 canonical 输入同时保存，且能对得起来
      //   ③ 幂等键按 callId（§6.5：与 F-02 的哈希不是一回事），且不含观察 metadata
      //   ④ 结果四态——`unknown`（已派发但结果未知）必须与 `none` 分开
      label: 'tool-call-log（PRT-610：工具调用、决定来源、结果与幂等键的持久化）',
      files: ['team-hub/tool-call-log.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-613：审批、UI、审计与执行看到**同一份**不可变工具参数（spec §6.5 line 468）。
      //
      // 盯四件事：
      //   ① 冻结是**递归**的（浅冻结在 `Object.isFrozen()` 上看不出来，
      //      而"哪个文件被写"在第二层）
      //   ② 身份是**携带**的 —— 没有任何一个观察面有机会"按自己的副本重新证明自己"；
      //      这一步只在**序列化边界**上可观测（进程内重算与携带恒等）
      //   ③ pre-execute **不允许改写工具参数**：只能拒绝当前调用，不能静默改写
      //   ④ 身份必须含 `toolName`，且 UI 摘要**不参与**身份
      label: 'tool-args（PRT-613：审批/UI/审计/执行看到同一份不可变工具参数）',
      files: ['runtime/dsh-composition/tool-args.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-602：统一 ToolRequest 投影 + Enforcement Bridge（spec §6.5 line 470、§6.8 line 479）。
      //
      // 盯四件事：
      //   ① 授权主体就是强制面那一份键集合，观察 metadata **拒**而不是**滤**
      //   ② 目标推导**只发生一次**，且推不出来 / 不唯一时**拒绝**（不兜底、不猜）
      //   ③ 四个摄入适配器只摆放、不再推导 —— 报告同一个哈希与同一份参数
      //   ④ guard 只有降级语义；同一哈希上"pre-execute 放行而 guard 拒绝"
      //      必须能被审计定位到具体强制点
      label: 'tool-request（PRT-602：统一 ToolRequest 投影与 Enforcement Bridge）',
      files: ['runtime/dsh-composition/tool-request.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-607（后半）：无人值守策略（spec line 929、line 472、line 495/1083、line 1084）。
      //
      // 一句话：**无人值守不是"没有人所以放行"，而是"没有人所以不能放行"。**
      //
      //   > 一个「无人值守时把需要审批的操作自动放行」的降级，
      //   > 与一个「无人值守等于没有权限门」的实现，是同一个东西。
      //
      // 盯四件事：
      //   ① `never` 在任何组合下都不放行（含"已经有过一次性批准"也不算数）
      //   ② 现场没人时 `ask` 只**挂起**（hold），不放行、也不伪装成"人拒绝了"
      //   ③ 审批箱的结果**不能**把一个 deny/hold 改成放行；`unavailable` 变成挂起
      //   ④ Legion 自己的 preset 表：`legion-unattended` 必须保持 `workspace-write`，
      //      不得因为"无人值守 = never"而顺带把沙箱升到 `danger-full-access`
      //      （spec line 495：DSH 默认表把这两件事绑在一起，复用它就是那个坑）
      //
      // 第 ④ 条的沙箱降级检查在**真实表上永远为假**，所以 `assertPreset` 让表可注入，
      // 用例传一张**被改坏的表**证明它真的会拦——否则它就是一条从不执行的检查。
      //
      //   > 一个「检查一个不可能出现的值」的检查，
      //   > 与一条不存在的检查，在"它到底拦住了什么"上是同一个东西。
      label: 'approval-policy（PRT-607：无人值守不是"没人所以放行"）',
      files: ['runtime/dsh-composition/approval-policy.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-612：Legion 权限语义 → DSH 强制面的**固定映射**（spec §6.6 line 445–454）。
      //
      // 两组文件、两个方向：
      //   · runtime 侧查"表本身自洽"（决定来源恰等于审计口径、config 点不在里面、
      //     补丁行与原语真的存在、未知模式不兜底、`allow-once` 必须经过审批箱）；
      //   · team-hub 侧查"跨层那份声明与引擎真正接受的那五个是不是同一张表"——
      //     映射模块不能 import permission-engine（分层方向），所以它**声明**了一份，
      //     而声明的东西不会自己保持一致。
      //
      //     > 一个「本模块自己声明一份模式表」的实现，
      //     > 与一个「两份表迟早不一样」的实现，是同一个东西——
      //     > 只不过前者在任何**单侧**的用例里都是绿的。
      //
      // ★ 本批最要紧的一条：`mapPermissionMode` 是 PRT-607 那个判定函数唯一的**生产
      // 调用方**，且它把"无人值守怎么办"**整体委托**给它，不自己再判一遍——
      // 否则就是"两处对无人值守的判断迟早不一样"。
      //
      // ★ 第二条：spec line 452 那个"在 waterfall **前**拒绝"字面落成
      // `answererInvoked`——只有判定结果是 `ask` 时才把请求送进 answerer。
      // 无人值守时仍然送进去，等于"去问一个不在场的人、然后一直等下去"。
      label: 'enforcement-mapping（PRT-612：权限语义到强制面的固定映射）',
      files: [
        'runtime/dsh-composition/enforcement-mapping.test.mjs',
        'team-hub/enforcement-mapping-binding.test.mjs',
      ],
      cwd: ROOT,
    },
    {
      // PRT-606：区分外部 API 读取与写入权限（spec line 928、§6.6 line 465/466）。
      //
      // 本模块要防的不是"权限表写错了"，而是**一串"看起来是读"的东西**：
      //
      //   > 一个「只看请求行上的 method」的检查，
      //   > 与一个「`GET /api/items/1` + `X-HTTP-Method-Override: DELETE` 真的删掉了」的检查，
      //   > 是同一个东西——而它的方向是放行。
      //
      // 而且它**刻意不复用** PRT-604 的文件系统路径规范化器——URL 路径没有盘符、
      // 永远大小写敏感，那是两件事。套件里有一条用例专门钉住这个区别。
      label: 'external-api-scope（PRT-606：读权限的六种变写形态）',
      files: ['runtime/dsh-composition/external-api-scope.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-605：命令、网络与 MCP 权限控制（spec line 927、§6.6 line 461–464）。
      //
      // 三条"出去做事"的通道，共同点：**被检查的是字符串，真正执行的是它被解释后的结果**。
      //
      //   > 一个「检查字符串」的权限门，
      //   > 与一个「检查完之后字符串才被解释成动作」的权限门，是同一个东西。
      //
      // 所以每条规则都是"不解释"：命令必须已分词 argv，URL 必须真解析器拆，MCP 必须成对。
      label: 'execution-scope（PRT-605：命令/网络/MCP 的字符串匹配是放行）',
      files: ['runtime/dsh-composition/execution-scope.test.mjs'],
      cwd: ROOT,
    },
    {
      // 编码完整性门禁自身的判据（scripts/ci/encoding-check.mjs）。
      //
      // 为什么它需要一个套件：这道检查保护的是**一类不会被别处发现**的损坏——
      // U+FFFD 在字符串字面量内部时语法完全正常、测试全绿，只是信息变了。
      // 它自己的判据（哪一类判失败、哪一类只记账、什么不可能出现）必须是被钉住的。
      label: 'encoding-check（源文件编码完整性的判据）',
      files: ['scripts/ci/encoding-check.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-604：文件与工作目录范围限制（spec line 926、§6.6 line 449/454/460）。
      //
      // 盯四件事：
      //   ① 包含判定**不能**用字符串比：边界、链接、`..`、尾点尾空格
      //   ② 解析必须**迭代**（`exists()` 看不穿链接），且只施加在存在前缀上
      //      —— 因为写操作恰好都是新文件
      //   ③ Windows 的那些坑：盘符相对、无盘符、设备命名空间、设备名、UNC
      //   ④ 范围表只能收窄；pre-execute 与 guard **两处**都查
      label: 'path-scope（PRT-604：越界路径的字符串比较是放行）',
      files: ['runtime/dsh-composition/path-scope.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-603：EmployeeManifest 工具白名单（spec line 925、§6.9 line 488–489）。
      //
      // 盯四件事：
      //   ① 清单挂在 agent 平面，**只能收窄**：越权、通配符、字段不闭合一律抛
      //   ② 未知工具与 hard floor 动作**必须被点名**（否则空集恒真 = 全部放行）
      //   ③ 每条规则都要真的能触发（写了但触发不了的检查 = 不存在）
      //   ④ 与桥接线：白名单在**策略端口之前**跑，拒绝即定案且理由带规则名
      label: 'employee-manifest（PRT-603：岗位工具白名单只能收窄）',
      files: ['runtime/dsh-composition/employee-manifest.test.mjs'],
      cwd: ROOT,
    },
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
    // `dual-write-smoke` 守「两个进程同时启动、迁移同一新库」的**行为**，
    // 并在第 3 个锚点里按**源码**禁掉两种坏写法（自己 exec ALTER / try-catch 吞掉 ALTER）。
    // `schema-util.test.mjs` 守的是那个并发原语**自己**的两种调用形态：
    // 顶层（自己开事务）与**已在事务里**（不能再开一个——运行面仓储的 createApproval
    // 端口正是在它自己的 BEGIN IMMEDIATE 里调它，2026-09-12 真实炸过三条状态机用例）。
    //
    //   > 一个「只测了顶层调用」的原语测试，
    //   > 与一个「调用方一旦把它放进事务、它就在完全不相关的地方炸掉」的原语，
    //   > 是同一个东西。
    {
      label: 'dual-write（P1-1 双进程写同库竞态：启动期迁移原子性 / schema-util 原语）',
      files: ['scripts/ci/dual-write-smoke.test.mjs', 'team-hub/schema-util.test.mjs'],
      cwd: ROOT,
    },
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
    // PRT 进度表的派生数字自检。这张表的汇总区是人手维护的，而数字由明细推导；
    // 两者不一致时读者看汇总得到一个"还剩多少"，看明细得到另一个答案——
    // 而汇总在文件末尾、明细在中部，几乎没人会去核对。
    // 这个脚本的作者自己就把阶段 3 的计数写错过两次，所以它被自动化了。
    { label: 'prt-progress（进度表派生数字自检：阶段标题、汇总各列、合计行都必须等于明细）', files: ['scripts/prt/progress-check.test.mjs'], cwd: ROOT },
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
    {
      // PRT-601：工具能力描述与风险等级。
      //
      // 这一组盯的**不是**"登记表里有没有那些工具"，而是**风险等级能不能被填低**。
      //
      // 一张"每个工具自己填一个风险等级"的登记表，失效方式很具体：一个会删文件的
      // 工具把自己的等级填成 low，于是它被自动放行；一个会往外部 API 写数据的工具
      // 填成 low，于是在无人值守的夜里被自动放行。没有谁在撒谎——填表的人真的觉得
      // "这就是个小工具"。
      //
      //   > 一个允许工具把自己的风险等级**填低**的登记表，
      //   > 与一个"所有工具都是低风险"的登记表，是同一个东西。
      //
      // 所以声明分两层，只有一层能被填低：`capabilities` 是**结构化的事实**
      // （会读文件、会执行命令、会往外部写），`declaredRisk` 只是建议值，
      // **只能往上抬**。有效风险 = max(声明, 能力蕴含的下限)。另一半是未知工具：
      // 一个没在登记表里的工具名，是一个"我不知道它会干什么"的工具。
      //
      //   > 一个"没在登记表里"的工具被当成"没有风险声明"，
      //   > 与一个"所有未知工具都自动放行"的强制面，是同一个东西。
      label: 'tool-capability（PRT-601：风险等级只能往上抬，未知工具默认最严）',
      files: ['runtime/dsh-composition/tool-capability.test.mjs'],
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
    // PRT-253/259 + PRT-706：产品配置文件的**读取侧**与首次运行初始化。
    // 这一组的断言全部指向配置系统特有的**静默失败**：
    //   ① 坏 JSON / 读不出来 / 类型不对（`"8787"` 而不是 `8787`）——
    //      退回默认值后用户以为自己的设置生效了，而端口比较其实永远不成立；
    //   ② UTF-8 BOM——Windows 上手工编辑配置的**常态**，`JSON.parse` 会直接拒绝；
    //   ③ 首次运行初始化会**建目录、写文件**，且这三件事不可逆：
    //      不得写进安装目录、不得替用户创建工作区、不得覆盖已有配置。
    {
      label: 'product-config（PRT-253/259/706：配置分层读取、诊断、首次运行初始化）',
      files: ['product/config.test.mjs', 'product/init.test.mjs'],
      cwd: ROOT,
    },
    // PRT-301：持久化运行状态机 + Orchestrator worker 入口。
    // 这一组的断言几乎全是**拒绝**，因为状态机最危险的失效方式不是「写错一个状态」，
    // 而是「本该拒绝的迁移被接受了」：接受了之后没有异常、没有日志，
    // 只有用户看到「已完成」变回「进行中」，或者任务链在某处静静断掉。
    // 三条各自对应一种不可逆后果：UnknownOutcome 自动重试 = 重复外部副作用；
    // 过期 worker 写入 = 覆盖别人的结果；无可重试的未知错误码默认重试 = 烧光队列。
    // worker 侧的核心断言是「**不认领自己执行不了的任务**」：
    // 一个「积极」的 worker 会照常认领然后立刻失败，把重试额度烧光。
    // 另有真实进程用例证明入口能被拉起来、会写状态文件；
    // 它同时也记录了一条平台事实——Windows 上「终止」不走信号处理器。
    {
      label: 'orchestrator（PRT-301：运行状态机、失败分类与恢复判定、worker 生命周期）',
      files: ['orchestrator/state-machine/state-machine.test.mjs', 'orchestrator/worker/worker.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-304：任务扫描与认领策略。
      //
      // 认领有**两条**查询路径，差别只在「从哪一侧去找这条任务」：
      //   A. 从等着的尝试里挑（已有第 N 次尝试）
      //   B. 从可入队的看板任务里挑（还没有任何尝试）
      // 它们的**任务级资格必须完全一致**。
      //
      // 这件事看起来是显然的，但它有一个很坏的失效模式：两条 SQL 各写一遍资格
      // 条件，有人给其中一条加了条件（或改了个状态名），另一条没跟着改。于是
      // **同一个任务从一条路径领不到、从另一条领得到**——而"领得到"的后果是
      // 具体的：一条被将军拦下的任务（hold=1）会在操作员以为它停着的时候被执行，
      // 连带它的外部写操作。
      //
      //   > 一个「从等着的尝试里挑」与一个「从可入队的任务里挑」各写一遍资格
      //   > 条件的认领逻辑，与一个「被将军拦下的任务照样会被领走」的认领逻辑，
      //   > 是同一个东西——只是前者只在某一条路径上发生，平时看不出来。
      //
      // 所以资格规则提取成了 `team-hub/claim-policy.mjs`：`TASK_GATES` 只写一份，
      // 两条 SQL 都由它生成，run-store 加载时自检两条路径确实共用同一组资格。
      // 这一组用例逐条比对两条 SQL、并用**真的库**验"被拦下的任务两条路径都领不走"。
      label: 'claim-policy（PRT-304：两条认领路径的资格条件不许分家）',
      files: ['team-hub/claim-policy.test.mjs'],
      cwd: ROOT,
    },
    // 阶段 3：运行实体（PRT-302 租约与权威时间 / PRT-303 Attempt 与不可覆盖历史 / PRT-313 epoch 拒写）。
    // 三层断言各自解决一类**只有那一层才看得见**的缺陷，因此三层都要有：
    //   ① run-store：仓储语义（并发领取只能有一个赢家、过期 epoch 拒写、
    //      回收的两条分支、历史不可覆盖）。用真实 node:sqlite + 注入时钟，
    //      「租期到期」是确定性跨过去的，不 sleep。
    //   ② run-routes：HTTP 契约（具名错误码有没有传到响应体里、到期时间是不是服务端算的、
    //      回收接口有没有强制要求「哪些状态已越过外部写边界」）。错误码被路由吞掉时，
    //      worker 只能靠文案猜，而文案会变。
    //   ③ run-plane-e2e：真 team-hub + 真 worker 客户端。前两层各自全绿也可能合起来错：
    //      worker 曾把 `{ok, claimed}` 信封当成 claim 对象用，于是**任务被领走却没人做**
    //      ——这个缺陷在两层单测里都看不见（仓储不经 HTTP，worker 的假 hub 已经解过包）。
    {
      label: 'run-plane（PRT-302/303/313：租约与权威时间、Attempt 不可覆盖、epoch 拒写、运行面 HTTP 契约与端到端）',
      files: ['team-hub/run-store.test.mjs', 'team-hub/run-routes.test.mjs', 'team-hub/run-plane-e2e.test.mjs'],
      cwd: ROOT,
    },
    // PRT-309/310/311：重试退避与 Dead Letter、人工处置、幂等。
    // 这一组问的是「失败了之后会怎样」——四类都不会报错的静默失败：
    // 无限重试、任务停在中间态、挂起的任务静默消失、重复执行已生效的外部写。
    {
      label: 'run-policy（PRT-309/310/311：重试额度与退避、Dead Letter、人工处置、幂等键与 Unknown Outcome）',
      files: ['team-hub/run-store-policy.test.mjs'],
      cwd: ROOT,
    },
    // PRT-314：多 worker 并发语义。竞争者是真的**操作系统进程**，
    // 不是同一进程里的两条连接——同一事件循环里两条 BEGIN IMMEDIATE
    // 不可能真的同时发出，因此那种测法证明不了「两个进程抢的时候不会都赢」。
    // 这一组当场抓到过一个真实缺陷：`ensureColumn` 的非原子写法让两个并发启动的
    // 进程各执行一次 ALTER，后者在**模块加载期**因 duplicate column name 崩溃。
    {
      label: 'run-concurrency（PRT-314：WAL 跨进程可见、busy_timeout 等待、真并发领取只有一个赢家、并发补列）',
      files: ['team-hub/run-concurrency.test.mjs'],
      cwd: ROOT,
    },
    // PRT-312：**强制终止** worker 的整链路演练。
    // 这里被杀的是真的操作系统进程（orchestrator/worker/scripts/kill-drill-worker.mjs），
    // 因此验的是「进程没了之后磁盘上留下的东西，会让回收做出正确判断」，
    // 而不只是「回收函数写对了」。三条判据对应阶段 3 完成标准逐字：
    // 不丢任务、不伪装成功、不重复执行已确认的外部写操作。
    // PRT-307：机器验收。执行成功之后的**独立关卡**——「执行成功了」与
    // 「做出来的东西满足验收判据」是两件事。
    // 三组各自的落点：判据核验（纯函数，可穷举）、结论落库与状态推进、
    // 以及从 HTTP 进来那条路的错误码/状态码区分。
    {
      label: 'acceptance（PRT-307：判据核验的三种结论、散文判据=人工判据、未知判据不得当成通过）',
      files: ['orchestrator/acceptance/acceptance.test.mjs'],
      cwd: ROOT,
    },
    // PRT-307：验收接入运行面。核心判据是「一条**从未被验收过**的尝试不能进
    // Completed」——若只记录 requiresPersist 而不核验它，那句话只是事件流里
    // 的一段 JSON，而"没人验收过"会被写成"已验收"。
    {
      label: 'acceptance-store（PRT-307：验收结论落库、状态按结论推进、无验收记录不得进 Completed）',
      files: ['team-hub/acceptance-store.test.mjs'],
      cwd: ROOT,
    },
    {
      label: 'acceptance-routes（PRT-307：机器验收的 HTTP 契约与错误码/状态码区分）',
      files: ['team-hub/acceptance-routes.test.mjs'],
      cwd: ROOT,
    },
    // PRT-305：岗位、流水线与团队快照。纯函数，因此能穷举边界：
    // 链尾 / 链断 / 岗位被停用 / 岗位改名 / 自我循环 / 上一环没留结论。
    // 「链断」与「链尾」在数据上长得一模一样（都表现为"查不到下一岗位"），
    // 而前者必须报错、后者是正常的——这一组问的就是能不能把它们分开。
    {
      // 名字刻意不叫 `pipeline`：已经有一个同名的套件（空间流水线的 SP-P0 契约，
      // workbench 侧）。两个同名套件会让 CI 输出里"哪个 pipeline 红了"变成一道谜题。
      label: 'prt-pipeline（PRT-305：岗位与流水线、链断 vs 链尾、交接任务的拼装与幂等键）',
      files: ['orchestrator/pipeline/pipeline.test.mjs'],
      cwd: ROOT,
    },
    // PRT-308：交接。核心是 spec 第 333 行的「当前 Task 收口并**原子创建**
    // 下一岗位任务」——因此用例既验"后继真的被建出来了"，也验"建任务失败时
    // 整笔回滚"（原子性的可验证形态）。
    {
      label: 'handoff-store（PRT-308：交接的原子性、幂等重放、链断与环的拒绝）',
      files: ['team-hub/handoff-store.test.mjs'],
      cwd: ROOT,
    },
    {
      label: 'handoff-routes（PRT-308：交接的 HTTP 契约，走真实的 createTask/readPipeline 接线）',
      files: ['team-hub/handoff-routes.test.mjs'],
      cwd: ROOT,
    },
    // PRT-306：workspace/worktree 隔离。大部分用例跑**真 git**（临时目录里 init
    // 一个仓库）：`git worktree` 的语义太容易记错，用假 git 测等于在测自己的想象。
    // 重点在**拒绝**——拒绝不安全 id、拒绝嵌套布局、拒绝覆盖陌生目录、
    // 拒绝回收脏工作区、拒绝把"git 说成功"当成"工作区可用"。
    {
      label: 'workspace（PRT-306：worktree 隔离、按 Attempt 分配、删除是拒绝边界）',
      files: ['orchestrator/workspace/workspace.test.mjs'],
      cwd: ROOT,
    },
    {
      label: 'workspace-wiring（PRT-306：工作区阶段接入 worker，隔离模式可见）',
      files: ['orchestrator/worker/workspace-wiring.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-501（spec §6.6/§6.7）：ModelProfile 数据模型与 API。
      // 三组分开放：纯存储语义（CAS/墓碑/审计守卫）、HTTP 契约
      // （状态码、响应体不含密钥）、以及合同层的密钥判据回归。
      label: 'model-store（PRT-501：ModelProfile 仓储，CAS + 墓碑 + 审计不含密文）',
      files: ['team-hub/model-store.test.mjs'],
      cwd: ROOT,
    },
    {
      label: 'model-routes（PRT-501：模型档案 HTTP 契约，响应体与审计均无密钥）',
      files: ['team-hub/model-routes.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-502（spec §6.6）：岗位模型绑定与 fallback。
      // 纯解析逻辑与存储/路由分三组：排序与解释（纯函数）、
      // 仓储特有的"坏数据不许当成没有"、以及 HTTP 契约（状态码三分 + 无密钥）。
      label: 'model-binding（PRT-502：岗位模型候选链，主档案不可用不许降级）',
      files: ['orchestrator/model-binding/model-binding.test.mjs'],
      cwd: ROOT,
    },
    {
      label: 'binding-store（PRT-502：绑定仓储，坏数据不许当成"没有备用"）',
      files: ['team-hub/binding-store.test.mjs'],
      cwd: ROOT,
    },
    {
      label: 'binding-routes（PRT-502：绑定 HTTP 契约，状态码三分且无密钥）',
      files: ['team-hub/binding-routes.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-511（spec §6.6 第 408 行）：带版本的价目表。
      label: 'price-table（PRT-511：版本冻结、未知模型不返回 0、换模型择价）',
      files: ['runtime/contracts/price-table.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-503 / PRT-510：单次运行预算账本（原子预留 / 结算 / 取消 / 未知结果锁定）。
      label: 'budget-ledger（PRT-503/510/511：预留→结算/锁定，超支不裁剪，锁定须人工处置）',
      files: ['team-hub/budget-ledger.test.mjs'],
      cwd: ROOT,
    },
    {
      label: 'budget-routes（PRT-503/510/511：预算与价目表 HTTP 契约，真钱路径的状态码三分）',
      files: ['team-hub/budget-routes.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-504（spec §6.6 第 402 行）：连通性 / 可用性 / 能力验证。
      label: 'model-probe（PRT-504：失败分类必须分对——SECRET_UNAVAILABLE ≠ AUTH_FAILED）',
      files: ['runtime/contracts/model-probe.test.mjs'],
      cwd: ROOT,
    },
    {
      // spec §6.7 的**写**一半：凭证的新增/更新/轮换/删除。
      //
      // 在它之前，`security/secrets/store.mjs` 的 put/rotate/remove 在整个
      // 仓库里**零生产调用方**——有实现、有套件、有文档，而没有任何入口
      // 能触发它们。所以这一组同时守两件事：
      //   · 管理面本身的契约（响应里永远没有值、打不开就 fail closed）；
      //   · **写路径引入的两个新问题**（读路径上不存在，所以此前没人遇到）：
      //     ① 写入走「临时文件 + rename」，Windows 上 mode 0o600 被忽略、
      //        新文件的 ACE 继承自目录 ⇒ 每一次写入都会重置上一次的加固；
      //     ② 全新安装上第一次写入**必然**发生在"文件还不存在 ⇒ 没加固过"之后。
      label: 'secret-admin（spec §6.7 凭证管理的写一半：新增/更新/轮换/删除、fail closed、每次写完复核 ACL）',
      files: ['team-hub/secret-admin.test.mjs'],
      cwd: ROOT,
    },
    {
      // 同一半的 HTTP 契约，外加本节最要害的那根线：
      // **写成功之后探测缓存必须失效**（`probe-service.mjs:39` 要的调用方）。
      // 一组分开写是因为它需要真实服务器（独立进程 + 独立库 + 独立端口），
      // 而上一组不需要。
      label: 'secret-routes（spec §6.7 凭证管理的 HTTP 契约；含"写成功→探测缓存失效"这根线）',
      files: ['team-hub/secret-routes.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-710：脱敏诊断包导出（spec §6.7 把「诊断包」列为密钥不得出现的地方）。
      //
      // 这一组守四件事，每件都对应一个真实会发生的误读：
      //   ① **结构性排除优先于文本过滤**——密钥库/凭证/业务库**根本不进包**，
      //      且被排除的文件**一次都没有被读过**（过滤器认不出的新形态会静默漏过，
      //      路径排除不会）；
      //   ② 「没包含」与「被排除」可区分（每个候选都有去向与理由——一份漏收的包
      //      与一份刻意排除的包，对排查者是同一个东西）；
      //   ③ **0 次脱敏命中 ≠ 包是干净的**（计数器只说明"表认出了几个"）；
      //   ④ 判定用的是**落盘后读回来的字节**，不是内存副本——复检没过就作废，
      //      而不是"发出去但附一句警告"（带着已知泄漏发出去的包已经离开这台机器）。
      label: 'diagnostic-package（PRT-710：结构性排除优先 / 被排除的从未被读过 / 落盘后复检 / 泄漏即作废）',
      files: ['product/diagnostics/redact-package.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-710 的**入口**：`legion --diagnostics=<dir>`。
      //
      // 核心只有一条：**诊断入口必须在产品坏掉的时候还能用**。
      // 诊断包最需要在什么时候拿到？产品起不来的时候。把它挂在"配置能解析、
      // 布局合法才往下走"的流程后面，等于在最需要它的那一刻恰好用不了。
      //
      //   > 一个只在产品健康时才可用的诊断入口，与一个不存在的诊断入口，
      //   > 在最需要它的那一刻是同一个东西。
      //
      // 所以这一组逐条验证它**不依赖**那些东西：布局有 error、配置是坏 JSON，
      // 它照样出包；同时验证它**不启动任何进程**、密钥库不进包、
      // 退出码把"泄漏"(8) 与"其它失败"(9) 分开。
      label: 'diagnostics-cli（PRT-710 入口：产品坏掉时仍可用 / 不启动进程 / 泄漏退出码分开）',
      files: ['product/diagnostics/diagnostics-cli.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-709：日志轮转与磁盘保护。
      //
      // 这一批修的**不是一个功能缺失，是一个会卡死子进程的 bug**：
      // `product/launcher/` 里原本没有任何地方读 `child.stdout`，而子进程是按
      // `stdio: ['ignore','pipe','pipe']` 起的。一个话多的子进程写满管道缓冲区
      // 之后会**永久阻塞在 write 上**——不退出、不报错、也不再干活，
      // 于是熔断器看不到失败、永远不会介入。
      //
      // 所以第一组的判据不是"日志好不好看"，而是：
      //   · **不接 sink 时也必须排空**（用真实子进程写 2 MiB，
      //     不排空它就会卡住——这是用假流测不出来的）；
      //   · 轮转**绝不删活动文件**、**绝不删代数 1**（磁盘写满时删掉当前日志，
      //     等于把证据和空间一起弄没了）；
      //   · 文件被占着时**如实报失败**，不假装成功、也不转而删活动文件；
      //   · 「读不出来」≠「目录是空的」，「没查磁盘」≠「空间充足」。
      label: 'log-rotation（PRT-709：轮转/保留/磁盘保护——绝不删活动文件，被占用时如实报失败）',
      files: ['product/logging/rotation.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-709 的写入侧：按行脱敏（跨数据块的密钥也要认出来）、
      // 巨型单行切断落盘、写入错误不抛回子进程的数据处理器。
      label: 'log-sink（PRT-709：按行脱敏 / 巨型单行切断 / 写入错误不炸启动器）',
      files: ['product/logging/sink.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-709 的**接线**。这一组不可省：整个 bug 的形状就是"管道被写满后卡住"，
      // 而假 stream 不会满——用假流验证过的排空，与真的排空，
      // 在"子进程会不会卡住"上原本是同一个答案。
      label: 'log-wiring（PRT-709 接线：真实子进程 2 MiB 输出不被卡死 / 停止时 flush / 定时器 unref）',
      files: ['product/logging/log-wiring.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-705：孤儿进程清理。
      //
      // 这一组盯的**不是**"能不能把残留进程杀掉"，而是**会不会杀错**。
      //
      // 记录里写着 `pid=4321`。那个进程退出了，系统把 4321 分配给了用户的
      // 编辑器。按号码去杀，杀掉的是编辑器——不可撤销，而且用户完全不知道
      // 为什么。所以这里绝大多数断言问的是同一件事：**该不该动手。**
      //
      //   > 一个按号码去杀的清理动作，与一个随机杀进程的动作，
      //   > 在"会不会误伤"上是同一个东西——只是前者看起来有理有据。
      label: 'run-record（PRT-705 孤儿进程：PID 会被回收，映像名对不上的一律不动手）',
      files: ['product/launcher/run-record.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-711：Runtime 健康状态 → 产品状态 → **Orchestrator 行为**。
      //
      // `productStateOf` 已经做出了 §6.3 表格的前两列；这一组守的是第三列——
      // 而那一列才是这张表真正要决定的事：现在能不能认领新任务、
      // 已经认领的怎么办、lease 要不要继续延长。
      //
      // 关键断言不是"六态都映射到了"，而是**认不出时会不会照常干活**：
      // 一个没见过的状态如果落到"默认可以认领"，那么产品的每一次"状态不明"
      // 都会变成一次在坏掉的产品上执行的自动化——而执行花用户的钱、
      // 改用户的代码、发用户的消息。
      //
      //   > 一个在状态不明时"默认照常执行"的系统，与一个在状态不明时
      //   > 随机执行一部分任务的系统，在"用户的钱会不会被乱花"上是同一个东西。
      label: 'runtime-state（PRT-711：六态 → 认领策略；状态不明时绝不默认放行）',
      files: ['product/runtime-state.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-712：最小系统指标（spec §6.6 的九个）。
      //
      // 这一组盯的**不是**"九个指标算得对不对"，而是**读不出来时会不会显示成 0**。
      //
      // 一个仪表盘把读不到的指标画成 0，与一个把"着火了"画成绿色的仪表盘，
      // 在"值班的人会不会去看一眼"上是同一个东西——而且前者更糟：
      // 它看起来是**有读数**的，所以没人会去怀疑它。
      //
      // 比值的分母为 0 是同一个坑的另一半：0 次失败 / 0 次尝试填 0%，
      // 说的是"没有失败"，而事实是"还没有观察过"——
      // 这正是"上线第一天，错误率 0%，一切正常"这句话的来历。
      label: 'metrics（PRT-712：九个指标；「读不出来」绝不显示成 0）',
      files: ['product/metrics.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-712（后半）：仪表盘的**生产数据源**。
      //
      // 上一组把九个指标的口径做全了（34 例），`readMetrics(source)` 也早就留好了
      // 注入点——而它的 `source` **从来只有测试传过**。
      //
      //   > 一个「口径完整但没人喂它数」的仪表盘，
      //   > 与一个什么都不显示的仪表盘，是同一个东西——
      //   > 只不过前者有一份写得非常仔细的指标定义。
      //
      // 这一组把数据源接上，并起**真的 SQLite 库**：
      // 新增的 `run-store.metricsCounts()` 是真的 SQL，而 SQL 的错误方式恰好是
      // "看起来对"（列名写错、`IN ()` 恒假、聚合返回 null）。拿假库测，
      // 测的只是算术，真正会错的那一半一行都没执行。
      //
      // 三个"零与没有"必须分开，这是本组的主线：
      //   ① 队列为空 → 最老待办年龄是**不适用**，不是 `0 毫秒`（0 读作"刚有一个任务进来"）；
      //   ② 库连不上 → 那六个指标"读不出来"，**不是 0**（恒 0 的读数点会让库挂掉看起来像一切正常）；
      //   ③ 从没升过级 → `upgrade-result` 是 `never-run`（一个确定的事实），不是"读不出来"。
      //
      // ★ ③ 是本批发现的**真缺陷**：`upgrade/audit.mjs` 空记录时返回 `'not-started'`，
      //   而指标层允许的词是 `'never-run'`——两张词表各自都对，接起来之后
      //   **一台从未升级过的新装机器，仪表盘上"升级结果"永远显示"—"**。
      //
      // ⚠️ 诚实边界：九个指标里有**两个今天没有任何生产者**
      //   （`runtime-availability`、`model-error-rate`）——本组不假装它们有数，
      //   而是要求 `createMetricsSource()` 把它们**逐个点名**列在 `missing` 里。
      //   另：`metricsCounts()` 目前**只被这个数据源使用**，还没有界面/CLI 消费者；
      //   `lease-expiry-rate` 的分母（`lease_epoch > 0`）是"曾经被租出去过"，
      //   与"当前在途"是两个集合，若日后有别的消费者要按需重新确认口径。
      label: 'metrics-source（PRT-712：生产数据源接上真库；「没有」不等于「零」）',
      files: ['product/metrics-source.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-402~406 的生产数据面：把 hub 上真有的东西读成装配路由要的 `sources`。
      //
      // `createHubContextStage` 早就留好了 `loadSources(lease)` 注入点，
      // 而它的**默认值是 `async () => ({})`**：
      //
      //   > 一个"零来源"的运行会冻结出一份**完全合法**的空快照。
      //   > 于是"这次运行看了 0 个来源"与"我们忘了接线"在下游是同一种记录，
      //   > 而模型会照着一份空上下文继续跑完，并把结论写进回执。
      //
      // kill-drill 走的正是这条路（发零来源 → 合法空快照），所以这个缺口在演练里
      // **看起来完全正常**。这一组盯的就是"到底取到了什么"。
      //
      // ★ 本组的主线：**读失败不是"没有"**。
      //   hub 上根本没有的东西（teamPlan / employeeManifest / 用户反馈 /
      //   上游交付 / 工作区状态）与"有但这次读失败了"，在快照里都表现为
      //   "这条来源不在"。前者是世界的形状，后者是故障——
      //   *一个把每一次网络抖动都静默地变成一次"上下文更少的运行"的实现，
      //   在快照账本上看起来与一个正常运行的实现完全一样。*
      //   故 404（问过了，它说没有）与 500/超时（我们没问到）必须走不同的路。
      //
      // 这一套**起真的 hub**：本模块的全部工作就是在读面上取数（端点路径、
      // 查询参数名、响应形状）。用假 hub 测，测的只是算术，
      // 真正会错的那一半（端点名写错、字段名写错）一行都没执行。
      //
      // ⚠️ 诚实边界：hub 今天**没有** teamPlan / employeeManifest / 用户反馈 /
      //   上游交付 / 工作区状态的读端点——本模块不假装取到，而是把它们
      //   逐个点名列在 `availability().unserved` 里（原因写到具体缺什么）。
      //   另：`createHubContextStage` 的默认 `loadSources` **仍是**零来源，
      //   生产 CLI 入口的 executor 仍为 null（PRT-253/311），
      //   所以这条接线目前**还没有真实部署走过**。
      label: 'sources-loader（PRT-402~406：来源装配接上真 hub；读失败 ≠ 没有）',
      files: ['orchestrator/worker/sources-loader.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-411（收尾）：**生产路径**真的把来源装配接上了。
      //
      // `createHubContextStage` 的 `loadSources` 默认是 `async () => ({})`，
      // `createProductionExecutor` 会把它透传下去——但**生产路径从不传它**：
      //
      //   > 一个"零来源"的运行与一个"来源齐备"的运行，
      //   > 在快照账本上都写着"已冻结"——
      //   > 只不过前者的模型是在一个我们没告诉它任何事的世界里动手。
      //
      // 这与 `budgetActor` 是**同一类**接缝缺陷（那一个的教训就写在
      // executor-binding.mjs 里）。所以判据不是"参数传下去了没有"——
      // 参数传下去而没人用，与没传，在结果上是一样的：
      //
      //   判据是**经过生产入口之后，冻结出来的快照里到底有没有真来源**。
      //
      // 因此这一套起**真的 hub**（判据是"库里真的多了一条来源"，
      // 假 hub 只能测"我们发出了一个形状正确的请求"），并绑定一个最小的
      // DSH 宿主端口，让 `productionExecutorProvider` 真的把引擎造出来。
      //
      // ★ 本组抓到一个**真缺陷**：hub 的 `rowToTask` 给的是 ISO 的
      //   `createdAt`/`updatedAt`，而 `sources.mjs` 认的是
      //   `createdAtMs`/`updatedAtMs`——**字段名错配**（`acquiredAt` 其实
      //   能解析 ISO，错的是键名）。后果不是少一个字段而是整条装配 **400**。
      //   直到本批，`taskSource`/`goalContextSource`/`publishedSources`
      //   才第一次被喂真实 hub 对象；在那之前它们只有用例里手搓的输入，
      //   而那些输入恰好都用了 `*Ms` 的名字。
      //
      //     > 一个"用例里一直用对字段名"的模块，
      //     > 与一个"只认自己发明的时间字段名"的模块，是同一个东西——
      //     > 只不过前者的用例全绿，而它一接上真实数据就 400。
      //
      //   修法是在**边界**换名字（`withEpochMs`），不去放松
      //   `acquiredAt` 那条"不拿现在当默认值"的拒绝——那条拒绝是对的。
      //
      // ⚠️ 诚实边界：生产路径仍要求 DSH 宿主端口已绑定
      //   （`bindDshRuntime`，PRT-214/215）；没有绑定时照旧
      //   `EXECUTOR_HOST_PORT_REQUIRED` 且不认领——本批没有放松那条拒绝。
      //   所以这套用例是**自己绑一个最小端口**来驱动那条路的。
      label: 'executor-binding-sources（PRT-411 收尾：生产路径接上真来源，而非零来源快照）',
      files: ['orchestrator/worker/executor-binding-sources.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-410（收尾）：以**真实运行**为起点的端到端回放 + 跨进程重放 + 跨进程重算。
      //
      // `context-e2e.test.mjs` 那条路的起点是**直接 POST 装配接口**——
      // 验的是"装配路由"，不是"一次真实运行真的会走到这里"：
      //
      //   > 一个"直接调装配接口"的端到端用例，
      //   > 与一个"从运行起点走一遍"的端到端用例，
      //   > 在断言数量上可以完全一样——
      //   > 只不过前者永远发现不了"运行那条路根本没接装配"。
      //
      // 所以这里的起点是 `productionExecutorProvider` → `buildContext(lease)`。
      //
      // ## 为什么"跨进程"要单独验
      //
      // 同进程里读回来一致，可能只是因为那份对象还在内存里。而快照要回答的是
      // "**以后**有人问'模型当时看到了什么'"——那个"以后"通常在另一个进程里。
      //
      //   > 一个只在写它的那个进程里验得过的哈希，
      //   > 与一个写进库里但再也验不过的哈希，是同一个东西——
      //   > 只不过前者的用例全绿。
      //
      // 所以这一套真的**另起 node 进程**：跨进程重放（只给库路径 + attemptId）、
      // 三个进程独立重算（规范化跨进程稳定）、跨进程篡改一个字符后必须验不过。
      //
      // ★ 本组抓到**第二处接缝缺陷**（与 loadSources 同类）：路由一直接受
      //   `associations`、库里也一直有 `goal_id`/`task_id`/`employee_id`/
      //   `team_plan_id` 四列并建了索引——而生产路径**从不发它**，于是那四列恒为 NULL：
      //
      //     > 一份"查不出它属于哪个任务"的快照，
      //     > 与一份"没有归属概念"的快照，在库里长得一模一样——
      //     > 只不过前者的列、索引与路由全都写好了，看起来像是有人维护的。
      //
      //   本地路径**做了**（`associations: { goalId, taskId, … }`），
      //   生产路径漏了。少了它，按任务回放上下文这条查询根本不成立。
      //
      // ★ 还有一条**边界**被钉住：两次**独立种子**的运行不会同哈希，
      //   而原因必须被证明是"内容里的时间戳"（抹掉时间字段后正文逐字节相同），
      //   否则"哈希不同"就变成一个可以随便解释的现象。
      label: 'context-replay-run（PRT-410 收尾：真实运行起点的回放、跨进程重放与重算、归属落库）',
      files: ['team-hub/context-replay-run.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-412（收尾）：不可信来源**不能改变审批策略**。
      //
      // spec line 900：「标记不可信来源并验证其不能扩大权限**或改变审批策略**」。
      // "不能扩大权限"那一半早已交付；"不能改变审批策略"那一半此前**做不了**，
      // 当时的记录很诚实：「审批策略本身尚未接线，没有东西可断言"没变"」。
      // 现在 PRT-619 的 Run 旋钮快照把 `approvalPolicy`/`permissionPreset`
      // 冻结在 Run 启动那一刻，于是"没变"终于有了可断言的对象。
      //
      // ★ 为什么必须端到端：`AUTHORITY_BEARING_KEYS` 是一条**键名**检查，
      //   它挡得住"来源对象带了 approvalPolicy 这个键"，
      //   挡不住更真实的路径——来源的**正文里**写着"approvalPolicy: never"。
      //   正文是文本，它**会**进上下文（不可信 ≠ 不可见：整段丢掉会让模型
      //   看不到真实世界）。所以要验的不是"进不进得来"，而是**进来之后有没有用**：
      //
      //     > 一段写在上下文里、写着"审批策略改成 never"的文本，
      //     > 与一段真的把审批策略改成了 never 的文本，
      //     > 在"这次 Run 的审批策略是什么"这个问题上必须是两个答案——
      //     > 而它们在快照里长得一模一样。
      //
      // ★ 本组还抓到一个**测试自身的盲点**（已修）：`createContextSource`
      //   有**两层**独立的拒绝——`AUTHORITY_BEARING_KEYS`（先）与
      //   `SOURCE_ALLOWED_KEYS` 白名单（后）。同一个键两层都拒，
      //   于是**只看状态码与码名分辨不出是哪一层拦下的**：
      //
      //     > 一个"因为它是禁止字段所以拒绝"的响应，
      //     > 与一个"因为它是未知字段所以拒绝"的响应，
      //     > 在状态码与错误码上长得一模一样——
      //     > 只不过前者告诉调用方"这件事原则上不许做"，
      //     > 后者会让调用方去改个名字再试一次。
      //
      //   实测：把 `approvalPolicy` 从 AUTHORITY_BEARING_KEYS 里删掉后，
      //   请求**仍然**被拒、状态码与码名一字不变，只是理由退化成了"未知字段"。
      //   所以现额外断言**拒绝理由**点了"权限/策略"，且**不是**"未知字段"。
      label: 'context-untrusted-authority（PRT-412 收尾：不可信来源不能改变审批策略）',
      files: ['team-hub/context-untrusted-authority.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-713：默认关闭、显式选择加入的脱敏健康心跳。
      //
      // 这一组盯的**不是**"加密了没有"，而是**关了之后还会不会再发一次**。
      //
      // 对一个已经点过"关闭"的用户来说，"关掉之后还在发"与"根本没关"没有区别。
      // 这类代码最常见的失败不是忘了加密，而是：定时器到点了而 stop() 只是置了
      // 一个标志、发送是异步的所以清完定时器之后 resolve 的那一次照发、
      // 重启后配置读回来又变成默认开、出错路径上偷偷重试。
      //
      //   > 一个"关了之后还会再发一次"的心跳，与一个根本没关的心跳，
      //   > 在"用户点了关闭之后数据还会不会出去"上是同一个东西。
      //
      // 载荷那一半守的是"允许名单而不是拒绝名单"：拒绝名单的实现会在有人
      // 往上游加字段时**静默外流**它。
      label: 'heartbeat（PRT-713：默认关闭；关闭之后一份都不再发；载荷走允许名单）',
      files: ['product/heartbeat.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-707：首次运行向导。
      //
      // spec §6.10 的完成标准是「干净 Windows 机器不打开终端即可完成安装后
      // 启动、模型配置、运行和停止」。这一组盯的**不是**"六个步骤跑得通不通"，
      // 而是**向导报「完成」时到底看没看过产品**。
      //
      // 向导最容易犯的错是把"每一步都返回了 ok"当成"产品可用了"：start() 说它
      // 启动了，那说的是"我发出了 spawn"；模型配置写进去了，那说的是"我写了一条
      // 记录"；所有步骤都没报错，那说的是"没有异常冒到这一层"。于是用户看到
      // 「安装完成，一切就绪」，然后第一次点运行就失败，而这时他已经关掉了向导。
      //
      //   > 一个"每一步都返回成功就报完成"的向导，与一个"不管做没做成都说
      //   > 完成了"的向导，在"用户第一次点运行的时候会不会成功"上是同一个东西。
      //
      // 所以最后一步不是汇总前面几步的返回值，而是**重新去看一眼产品**：
      // 独立观测（就绪探针 + 模型能否解析），只有观测到正面结论才算过。
      // 观测失败、抛错、返回说不清的东西——一律不算过。
      label: 'wizard（PRT-707：报「完成」必须建立在实测之上，不汇总步骤返回值）',
      files: ['product/launcher/wizard.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-708：系统托盘与「打开 Workbench」。
      //
      // 这一组盯的**不是**"菜单项画得对不对"，而是**点了「退出」之后
      // 进程还在不在跑**。
      //
      // 这是托盘类功能最经典的失败：用户右键 → 退出 → 图标消失了，他合理地
      // 认为"产品关了"。而实际上子进程还在跑、还在占端口、还在花钱。等他下次
      // 启动，会看到「端口被其他进程占用」——一句与他的操作毫无关系的话。
      //
      //   > 一个把图标藏起来、进程还在跑的「退出」，与一个根本没有退出按钮的
      //   > 托盘，在"用户以为关了的时候产品还在不在跑"上是同一个东西。
      //
      // 所以 quit 不是"关闭窗口"，而是一次**有结果的停止动作**：调 stop()
      // → 重新看一眼产品是不是真的都不在了 → 观测到确实停了才让进程退出；
      // 没停就报出来，并继续保持托盘在（用户还能再试一次）。
      label: 'tray（PRT-708：退出是一次有结果的停止，不是把图标藏起来）',
      files: ['product/launcher/tray.test.mjs'],
      cwd: ROOT,
    },
    {
      label: 'probe（PRT-504：探测执行器，假 transport 覆盖全部分类 + 凭证不落判定/缓存）',
      files: ['runtime/probe/probe.test.mjs'],
      cwd: ROOT,
    },
    {
      label: 'probe-http（PRT-504：真实 HTTP transport 对真服务，能力只报有证据的）',
      files: ['runtime/probe/http.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-505 的"生产调用方" + PRT-509 的读/轮换/删除泄漏断言。
      label: 'secret-resolver（PRT-505/509：明文后端构造即拒、轮换自动失效探测缓存、明文不进诊断）',
      files: ['runtime/probe/secret-resolver.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-508（spec §6.6 第 403 行）：配置导入导出，导出**永远不含密钥**。
      label: 'config-bundle（PRT-508：导出剥掉 secretRef、导入挡密钥、冲突默认不覆盖、悬空引用拦下）',
      files: ['runtime/contracts/config-bundle.test.mjs'],
      cwd: ROOT,
    },
    {
      label: 'config-bundle-routes（PRT-508：导出/计划/应用三条路由，plan 必须不写库）',
      files: ['team-hub/config-bundle-routes.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-509 的「跨账户与 ACL 加固」。关键用例用本机 `icacls` 的真实输出，
      // 而那份真实输出恰好是不安全的（有沙箱组与未解析 SID）。
      label: 'secret-acl（PRT-509：文件访问控制——"查不出来"必须与"是安全的"分开）',
      files: ['security/secrets/acl.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-254 的「Secret Store 最小闭环」：密钥库文件位置、fail closed 保护判定、
      // 解析器真的接上、诊断不泄漏。
      label: 'product-secrets（PRT-254：密钥库不得在 DataDir 内 / 明文后端 fail closed / 解析器真的接上）',
      files: ['product/secrets.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-509 事故的回归锁定：推送验证的判据。
      // 旧判据 `-match '... ->'` **同时匹配成功与失败输出**，于是"被拒绝"被判成
      // "推送成功"——两次拒绝之后都以为推上去了。
      label: 'push-verify（PRT-509 事故：拒绝输出也含 `->`，判据必须是远端 tip 而非命令输出）',
      files: ['scripts/prt/push-verify.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-257 的「自检」+ PRT-254 的生产调用方接通：什么该**阻止启动**、
      // 什么只该**提醒**。分界判错的两个方向都不报错，所以每一条等级都单独钉住。
      label: 'launcher-secrets（PRT-254/257：明文后端与位置不合法阻止启动，打不开只提醒）',
      files: ['product/launcher/secrets-check.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-252：Workbench 模型配置的产品化校验。三个**很容易被合并成一个**的区别：
      // 「校验不了」≠「配置错了」、「一个档案都没有」≠「未知供应商」、「合法」≠「能跑」。
      label: 'model-config（PRT-252：校验不了 ≠ 配置错了 / 合法 ≠ 能跑 / 配置错误要在配置时说出来）',
      files: ['runtime/contracts/model-config.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-507：模型设置页。这一组守的是「后端加了码、前端还是笼统提示 —— 那条码就等于没加」。
      // 其中最重要的一条：**「没探测过」（503 unavailable）不是「探测失败」**——
      // 渲染成红色"连接失败"会让用户去查网络与供应商状态，而真相是本机密钥库的问题。
      label: 'model-settings（PRT-507：没探测过 ≠ 探测失败 / 未知不猜 / 每个码都要可行动）',
      files: ['workbench/scripts/model-settings.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-506：迁移老的非敏感模型配置。这一组守的是一次迁移最危险的产物——
      // **一份看起来可用的配置**。老数据里没有 runtimeType、endpoint、凭证，
      // 三样都不许猜；迁移的正确产物是「确定的部分 + 待补清单」。
      label: 'model-migration（PRT-506：迁移不猜协议/地址/凭证，产出的是待补清单而非"迁移完成"）',
      files: ['team-hub/model-migration.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-507 后端：把 PRT-504 的探测接上 Workbench。
      // 在此之前 `git grep createModelProbe` 的非测试命中**只有它自己的实现文件**：
      // 整套实现 + 两个套件 + 文档都在，而没有任何入口能触发它。
      label: 'probe-service（PRT-507：一个没有任何入口的功能，和一个不存在的功能，从用户角度看完全一样）',
      files: ['team-hub/probe-service.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-507 前端收尾：模型配置的客户端层。
      // 这一层此前**完全不存在**——后端把档案 CRUD / 绑定 / 探测 / 迁移 / 导入导出
      // 都做完了，而前端一个客户端函数都没有（**功能在、测试在、文档在，没有入口**）。
      // 三条判断：方法+路径必须与服务端逐字对上（错法只报 404 不报错）；
      // 结构化错误必须真的到达调用方（hubPost 原本把 code/field/hint/candidates 压成一句字符串）；
      // 每条路径都要在平台契约里真实存在（交叉校验，不靠人记得同步）。
      label: 'model-api（PRT-507：客户端路径与服务端契约交叉校验 / 结构化错误必须到达调用方）',
      files: ['workbench/scripts/model-api.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-401（spec §6.5）：Context Source 与 RunContextSnapshot。
      // 守的是「任一员工运行都能还原其实际输入、来源版本、过滤和裁剪原因」——
      // 重点是**能否区分**："没有这个来源" vs "有但被裁掉了"、
      // "精确 token 数" vs "保守估算"、"快照哈希" vs "一次工具调用的批准哈希"。
      // 并引入共享的 canonical JSON 基础库：审批与快照用**不同 domain separator**，
      // 因此在构造上不可互换（原先审批侧有一份自己的实现，两份无人维持一致）。
      label: 'context-snapshot（PRT-401：来源默认不可信 / 裁剪计数守恒 / 哈希 domain 分离）',
      files: ['runtime/contracts/context.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-407：Context Assembler。核心是**第三种状态**——"部分包含"。
      // `sources`/`excluded` 只能表达"整个进了"/"整个没进"，而截断产出的第三种
      // 如果不记，一份截断过的快照会声称模型看过了全文，而 spec §6.5 要的
      // 恰恰是「还原其**实际**输入」。
      label: 'context-assembler（PRT-407：裁剪三账本守恒 / 权限只拿元数据 / 必需来源放不下即失败）',
      files: ['runtime/context/assembler.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-413：token 计量。守的是一条**方向性**性质：估算器必须不低估。
      // 低估 → 以为放得下，把超限内容发出去，在供应商侧失败而**钱已经花了**；
      // 高估 → 提前裁一点，没有金钱代价。所以"保守"是可测的上界性质。
      label: 'context-tokenizer（PRT-413：估算器必须是可测的上界 / 不许自称精确）',
      files: ['runtime/context/tokenizer.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-409：快照持久化。守"没有持久化就等于无法查看"——
      // 在写入这张表之前，快照只存在于一次函数调用的栈上，
      // 于是阶段 4 的完成标准无论装配器做得多对都无法达成。
      label: 'context-store（PRT-409：快照不可变 / 落库前与读回时都验哈希）',
      files: ['team-hub/context-store.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-411：`buildContext` 阶段的真实实现 + 「冻结时点」真的是一道闸门。
      //
      // 为什么值得单独一套：`runtime/context/` 下的装配器、来源、脱敏、tokenizer、
      // 快照仓储**全部已交付、各有套件、全绿**，却一个生产调用方都没有
      // ——「模块写好、用例绿、没人调用」与「功能不存在」在用户看来完全一样。
      // 这套用例守的就是那句"真的会冻结"，以及"冻结不了时会失败"。
      label: 'context-stage（PRT-411：冻结时点 / 闸门 / canRead fail closed / 接线不靠猜）',
      files: ['orchestrator/worker/context-stage.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-410 + PRT-412：上下文的**端到端**契约。
      //
      // 与上面那四条 `context-*` 套件的分工不是"覆盖更多"，而是**换了一层**：
      // 那四条验的是纯函数（输入是内存里的对象），这一条验的是
      // "跨过 HTTP 与 SQLite 之后那四条性质还成立吗"。
      // 序列化会吃掉 `undefined`、把所有数字变成 double——
      // 而哈希是对内容算的，一次往返就可能让"确定"变成"不确定"。
      //
      // PRT-412 那一半尤其只能在这一层验：调用方对抗的是**一条 HTTP 响应**。
      // "不可信来源想带 grants 会被拒"在用例里成立，但若那次拒回来的是
      // `code: null`，调用方就只能去匹配文案——判据会随措辞变更而碎。
      label: 'context-e2e（PRT-410/412：确定性 / 越权 / 超限 / 回放 / 不可信不扩权，跨 HTTP 与落库）',
      files: ['team-hub/context-e2e.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-253：生产执行引擎的**入口**。
      //
      // 上下文装配（PRT-401~413）交付了一整套机器并且每件都有套件、全绿，
      // 而 `executor` 默认 `null`——**没有任何真实部署走过那条路**。
      //
      //   > 一个功能没有入口，与一个功能不存在，在用户看来完全一样。
      //
      // 这一条要说清的正是那个接缝：**适配器必须把冻结的正文当提示词发出去**。
      // 在接线之前，适配器是自己拼 `任务：…\n目标：…` 的——
      // 那份拼出来的文本会静静地取代冻结的正文，而库里那份快照看起来
      // 完全正常，装配器的 22 例端到端也全绿。
      //
      //   > 一份被冻结、被哈希、被审计、然后**没有被用上**的上下文，
      //   > 与一份从未被冻结的上下文，在"模型看到了什么"这个问题上是同一个答案。
      label: 'executor（PRT-253：冻结的正文就是模型的输入 / 三道拒绝不降级 / 拒绝的理由说得清）',
      files: ['orchestrator/worker/executor.test.mjs'],
      cwd: ROOT,
    },
    {
      // 装配链的**端到端**验证：最近四批各自交付、各自全绿，而
      // **没有任何一条用例把它们接起来跑过一次**。
      //
      //   > 「注册了、跑了、过了」≠「这条路被测过」。
      //
      // 接缝上的错恰恰是每一块的套件都看不见的：它们各自的假件补上了对方那一半。
      // 这一组只用最外层的假件（DSH 引擎 + hub 的 HTTP），中间四块全用真实现，
      // 从"组合树观察结果"一路走到"账本已结算"。
      //
      // 写它的时候当场抓到两个真 bug（都已修）：
      //   · `productionExecutorProvider` 根本没有 `budgetActor` 的来源——
      //     PRT-510 的套件把它直接传给 `createProductionExecutor`，
      //     而**生产路径不经过那一步**，于是闸门永远不会被建起来；
      //   · 引擎故障的正确行为是**分类成有名字的终态**而不是抛，
      //     第一版断言写成 `assert.rejects`，那是在要求实现做它刻意不做的事。
      label: 'e2e-assembly（装配链端到端：观察 → 自检 → 注册 → 预留 → 执行 → 结算）',
      files: ['runtime/dsh-composition/e2e-assembly.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-215 落地 + PRT-257 的「应用自检与修复入口」。
      //
      // `startupSelfCheck()`、`probeSandbox()`、`bindDshRuntime()` 三件东西
      // 此前**都只在自己的模块里存在，没有任何调用者**。后果里最重的一条是：
      //
      //   「强制面未生效时禁止自动执行」这条保证**从未被行使过**。
      //
      //   > 一个宣言从没被行使过，与这个宣言不存在，在行为上完全一样。
      //
      // 所以最要紧的一条不是"自检算得对不对"（那有自己的套件），
      // 而是**自检没过时端口到底有没有被注册**——注册了就代表
      // 一个独立进程的 worker 可能已经开始认领任务了。
      label: 'dsh-bootstrap（PRT-215/257：自检未过则不注册 / 端口不全当场拒绝 / 修复入口覆盖全部检查项）',
      files: ['runtime/dsh-composition/bootstrap.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-257 的「修复入口」后半：**让修复计划真的被行使**。
      //
      // 在它之前 `repairPlanFor()` 的产物只被打印给人看，没有任何代码执行过
      // 其中任何一个动作——而**一个只有计划没有执行的修复入口，与一句
      // 「请重装产品」没有区别**（用户拿到的是同一件事）。
      //
      // 这一组守两条：
      //   · 判决来自**重新自检**，applier 的返回值只进 `applierSaid`
      //     （修复是唯一"做错了反而更糟"的操作：静默地什么都没修，比没有修复入口坏）；
      //   · `reapply-composition-patch` **必须显式批准**——DSH profile 是
      //     `patchReload: 'live'`，往运行中的 profile 写入会改掉发起修复的进程自己的强制面。
      label: 'dsh-repair（PRT-257：修复计划真的被执行；判决来自重新自检；live-reload 动作必须显式批准）',
      files: ['runtime/dsh-composition/repair.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-510 的**运行侧**接线。
      //
      // 账本（`team-hub/budget-ledger.mjs`）早就完整实现了预留/采集/结算/锁定，
      // 有套件、全绿、HTTP 路由齐全——而执行路径上一次都没调用过它。
      // 与 PRT-253 同一个形状的缺口。
      //
      // 要害不是"账本算得对不对"（那已经有 20+ 例守着），是三条：
      //   ① 预留发生在**花钱之前**（顺序，不是存在性）
      //   ② 预留与结算**永远成对**，包括引擎抛错那条路径
      //   ③ 失败的方向永远是"钱还占着"，而不是"钱放掉了"
      //
      //   > 「花了多少」可以在事后回答；「还能不能花」只能在事前回答。
      label: 'budget-gate（PRT-510：预留先于执行 / 抛错也结算 / 结果未知即锁定 / 没接闸门可见）',
      files: ['orchestrator/worker/budget-gate.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-408：上下文脱敏。与日志脱敏（PRT-208）的区别不是程度，是**不可撤回性**
      // ——日志写错了还能删，发给模型就撤不回来了。守的是"**发出去的东西里没有密钥**"，
      // 所以最要紧的一条用例走完整链路断言 finalText 里没有密钥；
      // 只测 `redactText` 返回了标记是不够的，那证明不了装配器用上了它。
      label: 'context-redaction（PRT-408：脱敏先于截断 / 账本只记路径不记原值 / 与日志脱敏共用一张表）',
      files: ['runtime/context/redaction.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-402~406：来源装配。守三条判断：权限是 manifest 的**内容**而不是来源上的
      // 活字段；按**谁写的**判可信性（不是按挂在谁下面）；同一份输入必须装配出
      // 同一个哈希（键序是数据的函数，不是读取路径的函数）。
      label: 'context-sources（PRT-402~406：来源装配 / 不可信默认 / 确定性序列化）',
      files: ['runtime/context/sources.test.mjs'],
      cwd: ROOT,
    },
    {
      label: 'run-kill-drill（PRT-312：真实进程被强杀后不丢任务、不伪装成功、不重复外部写）',
      files: ['team-hub/run-kill-drill.test.mjs'],
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
    // PRT-251 / PRT-703 / PRT-704：最小 Product Launcher（启动前体检、白名单注入、
    // 就绪判据与身份断言、退避熔断、优雅停止）。
    // 这一组里有**真实进程**用例（真 team-hub + 真 workbench，临时端口 + 临时 DataDir），
    // 它们不是「多余的端到端」：本批次的**两条缺陷正是它们发现的**——
    //   ① workbench 的 hub 上游默认指 8787，于是它去代理了**别的** hub 实例，
    //      而 `/hub/api/config` 照样返回 200（没有身份断言就会报「就绪」）；
    //   ② 就绪期望值被字符串化后与 number 严格比较永远不成立，真实运行被误报成
    //      `identity-mismatch`（类型问题伪装成安全问题）。
    // 另外它们同时钉住 PRT-003 的越界写入：launcher 必须把写路径指到 DataDir，
    // 而 team-hub/.gitignore 的 `*.db` 会让写进安装目录的库**不出现在 git status 里**。
    {
      label: 'product-launcher（PRT-251/703/704：启动前体检、白名单注入、就绪身份断言、退避熔断）',
      files: [
        'product/launcher/allowlist.test.mjs',
        'product/launcher/ports.test.mjs',
        'product/launcher/readiness.test.mjs',
        'product/launcher/supervisor.test.mjs',
        'product/launcher/launcher.test.mjs',
        'product/launcher/cli.test.mjs',
      ],
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
  // ── 套件清单完备性（2026-09-12 加）────────────────────────────────────────
  //
  // `suites` 里 team-hub/ 这类目录是**逐个文件列举**的，不像 plugins/ whiteboard/
  // 那样整目录 glob。于是新写一个 `team-hub/xxx.test.mjs` 而忘记登记，它**永远不会跑**
  // ——而"没跑"与"跑了且通过"在 CI 摘要里长得一样（都不出现）。
  //
  // 这不是假设：本次 PRT-607 期间我新写的 `team-hub/schema-util.test.mjs`
  // （守 `ensureColumn` 的事务嵌套分支）就是这样漏掉的，是**事后手写脚本**才发现的。
  //
  //   > 一个「写好了但没登记的测试文件」，
  //   > 与一条不存在的断言，在"它到底拦住了什么"上是同一个东西——
  //   > 而它比不存在的断言更糟：仓库里明明有那段代码，读代码的人会以为它被守着。
  //
  // 判据：`git ls-files` 里所有 `*.test.mjs`，要么被某个套件显式列出或落在某个
  // glob 目录里，要么出现在下面的**豁免表**中（豁免必须写明理由）。
  {
    const EXEMPT = new Map([
      // T042 的浏览器 e2e 采集副本：它是**证据留存**，不是本仓库的测试套件，
      // 依赖当时沙箱的路径与产物，在 CI 里跑会伪造出"这个仓库测过它"的印象。
      ['docs/T042-evidence/wb-e2e-sandbox-copy.test.mjs', '证据留存副本，非本仓库测试面'],
    ])
    // ★ 必须按每个套件**自己的 cwd** 解析，换成仓库相对路径。
    //   第一版直接收 `s.files` 的原文，于是 whiteboard 那组（来自
    //   whiteboard/package.json 的 test 脚本、相对 wbDir）一个都对不上，
    //   7 个本来在跑的用例被误报成"不会被任何套件执行"。
    //
    //   > 一个「按文件名字符串比对」的完备性检查，
    //   > 与一个「把 cwd 也算进去」的完备性检查，在"它报出来的缺失是真的吗"上不是同一个东西。
    const rel = (cwd, f) => {
      const p = join(cwd || ROOT, f)
      return p.startsWith(ROOT) ? p.slice(ROOT.length + 1).replace(/\\/g, '/') : p.replace(/\\/g, '/')
    }
    const listed = new Set()
    for (const s of suites) for (const f of s.files) listed.add(rel(s.cwd, f))
    // ★ 两个**有条件**的套件目录：plugins/board-plugin 只在 `DSH_CHECKOUT` 可用时才 push
    //   进 `suites`（否则整组 SKIP，见上面 `if (dsh)` 分支）。没有 DSH_CHECKOUT 时
    //   它们不在 `listed` 里，但它们**有归属**——只是这一次不跑。
    //
    //   > 一个「没配 DSH_CHECKOUT 所以没跑」的套件，
    //   > 与一个「永远没登记过」的套件，在"它有没有归属"上不是同一个东西。
    //
    //   本检查问的是**归属**（有没有人负责跑它），不是**这一次跑没跑**（那是 SKIP 的语义）。
    const conditionalDirs = ['plugins/tests/', 'board-plugin/tests/']
    const tracked = await exec('git', ['ls-files', '*.test.mjs'], { cwd: ROOT })
    const all = tracked.out.split('\n').map((x) => x.trim()).filter(Boolean)
    const missing = all
      .filter((f) => !listed.has(f))
      .filter((f) => !conditionalDirs.some((d) => f.startsWith(d)))
      .filter((f) => !EXEMPT.has(f))
    if (missing.length > 0) {
      const listing = missing.map((f) => `      ${f}`).join('\n')
      return {
        ok: false,
        detail: detail.join('\n') + '\n' +
          `  FAIL 套件清单不完备：${missing.length} 个 *.test.mjs 不会被任何套件执行（等于不存在的断言）\n` +
          listing + '\n' +
          '      把它们加进 stageTest 的 suites（或放进某个套件的 cwd 相对路径下 / 登记到 EXEMPT 并写明理由）。',
      }
    }
    detail.push(`  PASS 套件清单完备（${all.length} 个 *.test.mjs 全部有归属）`)
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
