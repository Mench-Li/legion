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
 *   doc    文档新鲜度校验：node scripts/ci/check-docs.mjs（README + docs/FEATURES.md 结构/链接/索引一致）
 *          + 进度表自检：node scripts/prt/spec-progress.mjs --check（spec 的进度区与台账一致；可 --skip doc）
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

// ★ DSH 检出的**唯一**一份判定（见 `stageTest` 里那段 `dshFound`）。
import { resolveDshCheckout } from '../lib/dsh-checkout.mjs'
import { parseSuiteCounts, countsFragment } from './parse-suite-output.mjs'

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

/**
 * 有跳过时跟在汇总行后面的那句话。
 *
 * ★ 它说的是**怎么自己判断**，而不是"跳过是坏的"：跳过的合法理由有三种
 *   （干净检出上没有 DSH、posix 上跑不了 win32 分支、机器上没有浏览器），
 *   而**不合法**的那一种是"机器上明明有，只是环境变量没设"。
 *   这两者在 `skipped=N` 这一个数字上完全同形，所以必须把话说到能分辨为止。
 */
const SKIPPED_NOTE = '跳过可能是合法的（干净检出上没有 DSH 检出 / posix 上跑不了 win32 分支 / '
  + '没有浏览器），也可能是**环境没配上**（检出就在盘上而 DSH_CHECKOUT 没设）。'
  + '分辨方法：把 DSH_CHECKOUT 指向那份检出再跑一次，看 skipped 是否降下来。'

async function runNodeTests(label, files, cwd, nodeArgs = []) {
  const t0 = Date.now()
  const r = await exec(process.execPath, [...nodeArgs, '--test', ...files], { cwd, timeoutMs: TEST_SUITE_TIMEOUT_MS })
  const elapsed = Date.now() - t0
  const timedOut = elapsed >= TEST_SUITE_TIMEOUT_MS - 500
  const all = r.out + '\n' + r.err
  // 超时现场快照并入 raw：没有它，「套件超时」只剩一句「可能泄漏句柄」，
  // 无法知道到底是哪些后代进程没退（本次排查正是缺这份证据）。
  const raw = timedOut && r.tree ? all + '\n\n[超时现场] 运行器仍存活的后代进程：\n' + r.tree + '\n' : all
  // ★★★ 计数解析抽到 `./parse-suite-output.mjs`（第 35 轮）——**因为这一格
  //   两个方向都被咬过**：先是 `skipped` 没被解析（看不见），后是 `re.exec` 取
  //   **第一个**匹配（看见了一个假的：一个用例的**名字**改写了一次读数）。
  //   抽出来是为了**能测**：`parse-suite-output.test.mjs` 直接喂两段输出对比。
  const counts = parseSuiteCounts(all)
  //   ★ `skipped` 曾经**没有被解析**（2026-09-17 的教训，留在 `parse-suite-output.mjs` 里）：
  //   「`skipped: N` 看得见」那句话曾经是**假的**——摘要只有 tests/pass/fail，
  //   跳过数只能靠 `tests - pass - fail` 反推，而"反推"与"看见"不是同一件事。
  //   实测代价：四个真进程套件 **38 条里跳过 20 条**，而读数是
  //   `exit=0 tests=38 pass=18 fail=0`——一个字都没说"有 20 条没跑"。
  //
  //   > 一个"跳过了 20 条真进程断言"的 PASS，
  //   > 与一个"全部跑过"的 PASS，在摘要行上是同一个东西——
  //   > 只不过前者的绿来自**没跑**，而注释还在替它保证"看得见"。
  const ok = r.code === 0 && (Number.isNaN(counts.fail) || counts.fail === 0)
  const failLines = all.split('\n').filter(l => /^not ok|# fail|^✖/.test(l)).slice(0, 8).join(' | ')
  // ★ 机读读数行：套件可以打印 `MEASURE <名字>=<值> …`，摘要**成败都带上它**。
  //
  //   为什么需要这个机制（2026-09-18）：
  //   `product/launcher/run-credential-dsh-process.test.mjs`（PRT-509 缺口③）
  //   的超时只把**实测耗时**写进 `FAIL` 分支的文案里。于是：
  //
  //     一次**通过**的运行 ⇒ 摘要只有 `exit=0 tests=1 pass=1`
  //     一次**刚好卡进预算**的运行 ⇒ **同一行**
  //
  //   > 一条只在失败时报告读数的时间判据，无法区分「很快」与「刚刚卡进预算」——
  //   > 而这两种情形对"这个看门狗该设多大"给出的是**相反**的建议。
  //
  //   实测方差有多大：同一个套件，单独跑 **3.4s / 3.6s**，
  //   而 2026-09-18 那次 CI 里 **>240s**（被看门狗杀）⇒ 约 **70 倍**。
  //   所以这里要的不是"把预算调大一点"，而是**让每一次运行都留下一个数**。
  //
  //   约定：行首 `MEASURE ` 之后是 `key=value` 对（空格分隔）。不做解析，
  //   原样带进摘要——CI 不该理解业务读数的语义，只负责**不让它消失**。
  const measureLines = all.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('MEASURE '))
    .slice(0, 4)
  const detail = label + ': exit=' + r.code + ' ' + countsFragment(counts)
    + (measureLines.length ? ' | ' + measureLines.join(' | ') : '')
    + (timedOut ? '（套件超过 ' + Math.round(TEST_SUITE_TIMEOUT_MS / 1000) + 's 被杀（已连后代进程一起清理）：可能存在泄漏句柄或死锁）' : '')
  return { ok, code: r.code, detail: ok ? detail : detail + ' FAIL: ' + (failLines || '(see ci.log)'), raw, counts }
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
// ★★★ 第 28 轮：`summary.json` 此前只记 `HEAD` 这个**名字**，不记**树的状态**。
//
//   本轮实测发现：我这一天跑的全量 CI **每一次都跑在一棵脏树上**
//   （另一个会话在本工作树里留了 13 个已改文件 + 441 个未跟踪文件），
//   而我把它们逐条写成"**交付 HEAD** `xxxxxxx`，9/9 PASS，exit 0"。
//
//   `git head=<sha>` 回答的是"**哪个提交**"，不是"**跑的哪棵树**"。
//   这两个问题在同一份绿报告里长得一模一样，而读者会把前者当成后者。
//
//   ⇒ 把树的状态**记进产物**并**警告**。这样
//     「这次 CI 跑的是一棵干净的交付树」与
//     「它跑在一棵混着别人在制品的树上」就不再同形。
async function readTreeState() {
  const headR = await exec('git', ['rev-parse', '--short', 'HEAD'])
  const head = headR.code === 0 ? headR.out.trim() : '(git 不可用)'
  const r = await exec('git', ['status', '--porcelain'])
  if (r.code !== 0) {
    // ★ 读不出来就说"读不出来"，**不说"干净"**——
    //   "没法判断"与"没问题"不能印成同一行（本仓的老规矩）。
    return { known: false, reason: 'git status 不可用', dirty: null, head }
  }
  const entries = r.out.split('\n').filter((l) => l.trim() !== '')
  // 前两列是 XY 状态码；未跟踪是 `??`，已改/已暂存是别的组合。
  const modified = entries.filter((l) => !l.startsWith('??'))
  const untracked = entries.filter((l) => l.startsWith('??'))
  return {
    known: true,
    head,
    dirty: entries.length > 0,
    modifiedCount: modified.length,
    untrackedCount: untracked.length,
    // 指纹只取"改了什么"的路径清单的哈希，不落盘具体路径（可能上千条）
    fingerprint: createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 16),
  }
}

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
    {
      // PRT-214：静态 hard floor 的**派生**（spec §6.8 `:437-440` 控制面那一格）。
      //
      // 名单本身在 `runtime/dsh-composition/enforcement.mjs`（定义强制面的地方），
      // 控制面与 DSH 侧目录取到的是**同一个数组对象**。这一组盯的就是那件事：
      // 谁把名单改回"两处各声明一份"，恒等断言立刻红（实测破验 3/3 咬）。
      label: 'permissions（F-02 权限内核与审批）', files: ['team-hub/permission-engine.test.mjs', 'team-hub/permissions.test.mjs', 'team-hub/skills-permission.test.mjs', 'team-hub/run-floor.test.mjs'], cwd: ROOT,
    },
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
      // PRT-610 的**路由**那一半（真 HTTP）。
      //
      // 上面那组验的是"账写对没有"；这一组验的是"账有没有出口"。
      // 两者分开是因为它们的失败模式完全不同——
      //
      //   > 一个「模块写好了、判据也留好了」的表，
      //   > 与一个「从来没有被 CREATE 过」的表，
      //   > 在"决定来源有没有被记录"上是同一个东西。
      //
      // 着重要钉的是 ★★★：`release-gate.mjs` 的就绪判据 `decisionSourceRecorded`
      // 在本批之前**全仓没有产出者**，于是它永远判否——而它写得很谨慎
      // （"缺失的证据不是证据"），所以看起来是"这套部署还没记录"，
      // 而不是"没有任何地方能告诉我们"。`GET /api/tool-calls/evidence` 就是那个产出点。
      //
      // 另外三条：三态证据（表不在 / 读不出来 / 读得出来必须分得开）、
      // 前缀路由不许吃掉 `/evidence`、以及**刻意没有写路径**
      // （一个可以由外部直接写入的执行账，与一个"审计里的执行历史可以是任意值"的账，
      //   是同一个东西）。
      label: 'tool-call-http（PRT-610：就绪判据的产出点、三态证据、账没有写路径）',
      files: ['team-hub/tool-call-http.test.mjs'],
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
      // ★ 2026-09-18 第 20 轮：`external-api-scope` 这一组也多一个文件，
      //   守的是**与 605 那一组同形**的另一半——判定器对了，不等于生产里跑得起来：
      //
      //   · `external-api-scope-port`：把 URL 拆成 `{host, method, path, query, …}`
      //     给 `checkExternalApi`。★ 而"怎么拆"决定了那 24 例里的三条检查是
      //     **会触发**还是**从不触发**——`new URL()` 会把端口从 hostname 上摘掉
      //     （`HOST_HAS_PORT` 永不触发）、会把 `..` 折叠掉（`PATH_ESCAPE` 永不触发）、
      //     会把 userinfo 解析掉。套件 ④a/④b/④c 就是那三条的反向读数。
      //     ★★ 而它们红的方式很特殊：退回 `new URL()` 时那三条会变成
      //     `ENDPOINT_NOT_GRANTED`——**方向仍然是拒**，所以一个只看 `allowed` 的
      //     用例抓不到它。⇒ 那三条断言的是**码**。
      //     还包括"归一化器不幂等"（⑩：`normalizeApiGrant` 在端点上挂派生字段
      //     `parsed`，所以已归一化的表再喂一次会抛）。
      label: 'external-api-scope（PRT-606：读权限的六种变写形态）',
      files: [
        'runtime/dsh-composition/external-api-scope.test.mjs',
        'runtime/dsh-composition/external-api-scope-port.test.mjs',
      ],
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
      //
      // ★ 2026-09-18 第 19 轮：这一组现在多两个文件，它们守的是**同一件事的另一半**
      //   ——判定器对了，不等于**生产里跑得起来**：
      //
      //   · `scope-facts`：事实**只算一次**（在投影里），端口只读不推。
      //     六处各自兜底"今天恰好一致"，用例全绿——而那正是不一致藏身的地方。
      //     还包括"未登记工具按参数证据反推"（否则换个没登记的名字就能绕开执行面）。
      //   · `execution-scope-port`：装配期就归一化（坏表**现在**抛，不留到第一次调用）；
      //     端口只读 `projection.scopeFacts`；★ 以及 **MCP 那一条未接、且具名地说未接**。
      label: 'execution-scope（PRT-605：命令/网络/MCP 的字符串匹配是放行）',
      files: [
        'runtime/dsh-composition/execution-scope.test.mjs',
        'runtime/dsh-composition/scope-facts.test.mjs',
        'runtime/dsh-composition/execution-scope-port.test.mjs',
      ],
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
      // ★★★ 门禁自己的一条判据：**"跳过了多少条断言"必须出现在摘要里**。
      //
      // 本文件的四处注释此前都写着「`skipped: N` 看得见」，而实现里
      // `counts` 只解析了 tests/pass/fail —— `skipped` **从来没被解析过**。
      // 代价是实测到的：四个真进程套件 38 条里跳过 20 条，而 CI 四行读数是
      // `exit=0 tests=38 pass=18 fail=0`，摘要里一个字都没说。
      //
      // 这一组的对象是**本文件写下的那几行**（源码级断言），所以它必须与
      // 它验的东西一起被跑 —— 否则"跳过看得见"这件事本身也会悄悄失效。
      label: 'skip-visibility（门禁摘要必须说出跳过了多少条断言）',
      files: ['scripts/ci/skip-visibility.test.mjs'],
      cwd: ROOT,
    },
    {
      // ★★★ 「那 232 条跳过里，有多少条其实是**能跑的**」——把一句话变成读数。
      //
      // 21 个跑真 DSH 进程的套件各自手写了 `process.env.DSH_CHECKOUT ?? null`，
      // 于是变量没导出的那台机器上它们**整组跳过**，而 CI 报 `PASS`。
      // 其中有 **6 个套件 `pass=0`**：跑了 0 条、报绿。
      //
      // `tests/dsh-checkout.mjs` 是**一份**实现（候选里第一条是结构性的
      // `<ROOT>/../dsh/deepseek-harness`，不是硬编码的绝对路径），
      // 这一组钉住它的语义——**全部用人造文件系统**，因为它在
      // 「这台机器上没有 DSH」时最需要说对话，而那正是它不能被跳过的时候。
      //
      //   > 一个「只在有 DSH 的机器上才验得了」的解析器用例，
      //   > 与一个真的验过它的用例，在最需要它的那台机器上是同一个东西：
      //   > 都是"整组跳过"。
      //
      // ★★ 而**这一组自己**也踩过一次同形的坑，值得写在这里：
      //   用例当时用自己写死的 `ROOT = 'D:/project/DSH/legion'` 去核对
      //   模块算出来的 `REPO_ROOT`，于是"模块算得对不对"这件事
      //   两条读数**问都没问**——而模块第一版确实算错了
      //   （`resolve(HERE, '..')`，少了在 `scripts/lib/` 下该有的那一级），
      //   只在 win32 上被那条硬编码字面量救成绿的。
      //   判据 ⑳ 因此改成**从模块自己的 `REPO_ROOT` 出发**比对，
      //   并要求 posix 上（无盘符字面量）也解析得出来。
      //
      //   > 一个"用自己写死的根去核对别人算出来的根"的判据，
      //   > 与没有这条判据，在作者那台机器上是同一个东西。
      label: 'dsh-checkout（检出解析器：没找到 / 找到了但没构建 / 变量指错了 是三句话）',
      files: ['tests/dsh-checkout.test.mjs'],
      cwd: ROOT,
    },
    {
      // ★★★ 「这三道范围检查在生产里到底有没有跑」——把一句话变成读数。
      //
      // PRT-604/605/606 在台账里都是 ✅，而它们各自的套件验的是"检查器对不对"。
      // 这三道检查**都是注入式的**（桥的可选端口 / 独立模块），于是有一个
      // 前面那些套件**结构上问不到**的问题：生产装配到底注入了没有？
      //
      //   > 一个「端口没接上、而没接上时检查自动放行」的组合根，
      //   > 与一个「路径范围限制没有生效」的组合根，是同一个东西——
      //   > 只不过前者的证据里有一行诚实的 `pathScope:false`。
      //
      // 读数（2026-09-18 第 19 轮更新）：PRT-605（命令/网络/MCP）**已经接线**，
      // 而 PRT-606（外部 API）**仍然连端口都没有**。
      //
      //   ① 现在钉三件事：`pathScope` 键在、`executionScope` 键在、
      //   而 **env 没配时两格读数都是 `false`**——没配不等于"接了个空的"；
      //   配上了则 ①b / ①c 各自翻成 true，且 ①c 一路走到 `preExecute`
      //   看真实裁决（★ "那一格对了"与"这一道真的会拦人"不是同一件事）。
      //
      //   ② **没有**变成空断言：它换了一个对象——`externalApiScope` 仍不许出现，
      //   而它上一版自己写着"端口出现时请把台账与记账一起更新"，
      //   本轮照做了（PRT-605 的账动了，PRT-606 的没动）。
      // `whitelist` 与 `external-api-scope` 仍未接。
      label: 'production-scope-wiring（PRT-604/605/606：检查器对不对 ≠ 生产里跑没跑）',
      files: ['runtime/dsh-composition/production-scope-wiring.test.mjs'],
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
      files: [
        'runtime/dsh-composition/path-scope.test.mjs',
        // ★ 同族的**装配点**（2026-09-18）：`path-scope.mjs` 的判定逻辑早就齐了，
        //   缺的是"那份表从哪来"——全仓 `narrowScopeToWorkspace` 零生产调用方。
        //   它盯三条装配期拒绝（缺表 / 无读根 / 有写根却没工作区根）+ 一条**往返**
        //   （产物必须能被**真** `checkPathScope` 吃下去——只看自己字段清单的断言
        //   抓不到"多带一个字段"，而那正是我写第一版时犯的真错）。
        //   ★ 缺表那一条的要害：`tool-request.mjs` 的 `scopeGuard` 在 `pathScope === null` 时**放行**，
        //   所以"没配上"在今天的表现是**放行一切**，不是拒绝一切。
        'runtime/dsh-composition/scope-table-binding.test.mjs',
        // ★ 同族的**投递点**（2026-09-18，第 19 条 §9.2 第 4 步）：表装配好了，
        //   但 `tool-request.mjs` 的 `scopeGuard` 要的是一个**函数**（`pathScope(projection)`），
        //   而全仓到它之前没有任何地方把表变成那个函数 ⇒ 端口恒为 `null` ⇒ 放行。
        //   它盯三个 fail-closed 决定（方向未知按 write / 目标缺失拒绝 /
        //   表在装配期就校验）与"缺席如实是 absent 且落到执行面就是放行"。
        'runtime/dsh-composition/scope-port.test.mjs',
        // ★ 同族的**第二份投递点**（2026-09-18，第 19 条 §9.2 第 5 步，F-21）：
        //   与上面那条是**同一个形状**——`registry.mjs` 的 `decide()` 早就写好了，
        //   织进桥的 `decision-port.mjs` 也写好了，而"那份声明从哪来"**零生产调用方**
        //   ⇒ `enforcementSurfaces().connectorJudgment` 恒为 `false`。
        //   它盯四件事：缺席**如实**是 `absent`（不许折成空表，否则读数说"装好了"
        //   而一次判定都不做）/ 显式空表**具名拒绝** / 重名工具**装配期**就停 /
        //   配坏了**抛**而不是当作没配。
        //   ⚠️ 连同**已知限度**：推导式归属触发不了登记表那条「未声明就拒绝」
        //   （`connector-port.mjs` 文件头 ⑦），判据在 ④c。
        'runtime/dsh-composition/connector-port.test.mjs',
      ],
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
    {
      // PRT-603 的**接线侧**那一半（2026-09-18 第 21 轮）。
      //
      // 上面那一组证明"清单只能收窄"，但它喂的全是 **Legion 能力名**；
      // 生产里那个端口拿到的是**执行面（DSH）的工具名**。两者**结构上不相交**，
      // 于是"每一条规则都能触发"与"真名字进来时它放行过谁"是两件事：
      //
      //   > 一个「用 Legion 名字把每一条规则都走到拒绝」的套件，
      //   > 与一个「真名字进来时这道检查到底放行过谁」的套件，
      //   > 在摘要里都是绿的——只不过前者的绿是**词汇表自己对自己**的绿。
      //
      // ★★★ 跑出来的读数（这是 `DECISION-RUNREQUEST-EXECUTION-PLANE.md` §11.5
      //   逐字留下的"我没有跑过一次"）：把一份**真实算出来**的 permit 喂进
      //   `permitsTool`，喂 Legion 名字 ⇒ 放行；喂 DSH 名字 ⇒ **一个都不放行**，
      //   而且把 `maxRisk` 抬到最高也救不了（从"风险超上限"挪到"未知工具必须点名"）。
      //   两条"修复动作"互相指错方向——所以这一道**不能**靠加一个映射接上：
      //   反向映射在 `bash` / `pwsh` / `web_fetch` 上是一对多（④），
      //   而 `bash` 那一堆里同时塌着低风险的 `git-status` 与高风险的 `git-push`。
      //
      // 另两件：§11.3 留下的"`grant` 从哪来"（①：宿主显式注入，不给就抛，
      // 而 `preset` 那一半来自 host 组合的补丁层表）、以及本轮新查出的
      // **两个同名 EmployeeManifest**（⑤：一个方向抛、另一个方向丢字段）。
      label: 'whitelist-limb（PRT-603 的另一半：真名字进来时这道白名单放行过谁）',
      files: ['scripts/prt/whitelist-limb.test.mjs'],
      cwd: ROOT,
    },
    // PRT-610 的**出站车道**（决策表第 19 条 / 第 15 项的施工）。两半分开登记，
    // 因为它们各自能被单独跑出一个"绿"而合起来仍然不通——而那种绿是本轮之前
    // 全部有关工具账的绿的样子。
    //
    // ★ 环的证据在 `toolcall-drain` ①：执行面（无 token）写 spool →
    //   worker（有 token）收账 → **真 SQLite** 里出现带 `decisionSource` 的行 →
    //   `toolCallLogEvidence().recorded` 由 `false` 翻成 `true`。
    //   在那之前，`release-gate.mjs` 的 `decisionSourceRecorded` 在全仓
    //   **没有任何产出者**：它写得很谨慎（"缺失的证据不是证据"），于是永远判否。
    //
    // ★ 两半的判据都刻意断言**码与行号**，而不是"跑通了"：
    //   · 写入侧 ①：Run id 含分隔符时**拒绝而不消毒**（消毒会让 `a/b` 与 `a_b`
    //     落进同一个目录 ⇒ 两个 Run 合流成一本账）；①c 挡的是 win32 会静默去掉的
    //     尾部点/空格——它与"消毒"是同一个后果，而一个字符都没被替换；
    //   · 写入侧 ②：中间一行坏掉时，好的照常读回、坏的**带行号具名**、
    //     `complete:false`——而"跳过派"读出的**记录数完全一样**，
    //     差别只在 `complete` 上，所以只看 `records.length` 的人分不出这两者；
    //   · 写入侧 ⑤：**不**校验 `decisionSource` 的语义（词表只有
    //     `team-hub/tool-call-log.mjs` 那一份），并有一条断言**读源码**确认
    //     这里没有抄第二份来源名单；
    //   · 收账侧 ③：收两遍行还是一行（崩溃后重跑必须安全），且有一条断言确认
    //     本模块**不出现** `unlinkSync`/`writeFileSync`——"收完就删 + 记游标"
    //     会在崩溃后把没落账的几条当成"已经收过了"。
    { label: 'toolcall-spool（PRT-610 出站车道·写入侧：执行面无凭证时怎么把账带出去）', files: ['runtime/toolcall/spool.test.mjs'], cwd: ROOT },
    { label: 'toolcall-drain（PRT-610 出站车道·收账侧：整条环走到真库，把 decisionSourceRecorded 翻成 true）', files: ['orchestrator/worker/toolcall-drain.test.mjs'], cwd: ROOT },
    // 文档**表格列数一致性**（第 22 轮顺带建立）。修第 23 条那个"单元格里有未转义
    // 竖线"时发现在全仓是**一类**问题，于是把它变成可复跑的读数而不是一次性修。
    //
    // ★ 两半：① 八份**权威文档**（承载裁决/台账/报告的那几份）必须 **0 处**——
    //   那张表里错一格，就是"把**后果**当成**决定**来读"；
    //   ② 全仓已跟踪 md 走**棘轮**（基线 87，全在历史评审记录里）——
    //   新增判红，**减少只报警**（与可达性探针同一条纪律：把别人修好的事
    //   判成回归的闸门，会在共享工作树上天天红）。
    //
    // ★ ② 是**假阳性护栏**，不是顺手多写一条：第一版检查器没处理 `\|`
    //   （CommonMark 的代码跨度里它**是**字面竖线），于是全仓报出 934 处、
    //   其中 847 处是假的——一个"到处都是假红"的检查与一个"找不出真的那一处"
    //   的检查，在"它能不能挡住回归"上是同一个东西。
    //
    // ★ ④b 是本轮**自己踩到**的一处：`git ls-files` 默认按 `core.quotePath`
    //   把非 ASCII 路径转义并加引号，于是本仓 8 个
    //   `whiteboard/docs/adr/ADR-*.md` 打不开、被记成 `missing`——
    //   总数虚高，而它们自己的缺陷**一处都数不到**。改用 `-z`。
    { label: 'doc-table（文档表格列数一致性：八份权威文档 0 处 + 全仓棘轮不许涨）', files: ['scripts/prt/doc-table-integrity.test.mjs'], cwd: ROOT },
    { label: 'calendar（日程日历契约）', files: ['team-hub/calendar.test.mjs'], cwd: ROOT },
    { label: 'calendar-ui（P2-5 日历前端纯函数：周视图/重复文案/关联跳转/表单校验）', files: ['workbench/scripts/calendar-ui.test.mjs'], cwd: ROOT, nodeArgs: ['--experimental-strip-types'] },
    { label: 'chat-ui（P2-6 对话前端纯函数：健康判定/AI 三态/合并/断线补齐）', files: ['workbench/scripts/chat-ui.test.mjs'], cwd: ROOT, nodeArgs: ['--experimental-strip-types'] },
    { label: 'spaces（空间删除级联）', files: ['team-hub/spaces.test.mjs'], cwd: ROOT },
    { label: 'pipeline（空间流水线：编队即流水线 SP-P0）', files: ['team-hub/pipeline.test.mjs'], cwd: ROOT },
    { label: 'goal（目标生命周期）', files: ['team-hub/goal.test.mjs', 'team-hub/goal-closed.test.mjs'], cwd: ROOT },
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
    { label: 'notify（P2-4 通知分类/优先级/批量已读/跳转/去重补齐 + P4-7 句柄泄漏自检）', files: ['workbench/scripts/notify.test.mjs', 'workbench/scripts/notify-hub-smoke.test.mjs'], cwd: ROOT, nodeArgs: ['--experimental-strip-types'] },
    // ★ 2026-09-16（main 整合）：下面这一条**是本次合并补登记的**，不是新写的套件。
    //
    //   `reveal-open.test.mjs` 是 `main` 侧 P4-7「打开所在位置」带来的契约测试（21 例，全绿），
    //   但**两侧的 run-ci.mjs 都没有登记它**：main 那一版根本没有"套件清单完备性"这道检查
    //   （`git show origin/main:scripts/ci/run-ci.mjs | grep 套件清单不完备` 为空），
    //   所以它不登记也不红；而本分支加了那道检查，于是合并一落地它就红了。
    //
    //   > 一道"每个测试文件都必须有归属"的检查，
    //   > 在一棵**只有它自己**的树上，与在一棵刚和"没有这道检查"的树合并过的树上，
    //   > 报出来的东西不是同一类：前者是"我漏登记了"，后者是"**对面**从来没登记过"。
    //   > 两种都要修，但只有第二种能证明这道检查的价值——它第一次运行就抓到了一份
    //   > **在两个分支上都存在、却谁也没跑过**的断言。
    //
    //   选择"登记"而不是"加进 EXEMPT"：这 21 例断言是真的、且真的能过（实测 21/21），
    //   豁免它们等于把一份可执行的证据降级成一份声明。
    { label: 'reveal-open（P4-7 打开所在位置：落点计算/祖先回落/安全矩阵与读面同强度/引导）', files: ['workbench/scripts/reveal-open.test.mjs'], cwd: ROOT },
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
    {
      // PRT-253 续批三：跨进程 Runtime Contract 的**线路协议**。
      //
      // 这一套盯的是「流断了」与「跑完了」必须**不同形**：`execute` 有五种结束方式，
      // 而 `WIRE_ENDING_YIELDS_OUTCOME` 里**恰好一项为 true**。把这张表写成数据
      // 而不是写成一串 `if`，就是为了让用例能断言那个"恰好一项"——
      //
      //   > 一个把 `transport-failed` 也标成 true 的实现，
      //   > 会在那条断言上变红，而它的其余用例**全都还是绿的**。
      //
      // 装载期还有 `assertWireCoversContract()` 把线路操作集合钉在契约方法集合上：
      // 契约加了方法而线路没跟上时，这是**装载期**的响声，不是某次运行的静默缺项。
      label: 'runtime-contract-wire（PRT-253：跨进程线路协议与 execute 的五种结束方式）',
      files: ['runtime/contracts/wire.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-214 缺口①：**按 Run 派生的静态 hard floor 怎么过线**。
      //
      // 这一套在契约层钉三件事，都与"读数像不像"有关：
      //   · 「没人给下限」与「给了一份空下限」必须**不同形**——生产侧的
      //     `deriveRunFloor()` 在派生失败时给的正是 `derived:false` + `floor:null`，
      //     把它读成"这次没有东西该被禁止"，就是把一次失败洗成一次没有；
      //   · 键集合闭合：跨进程时"我不认识的字段"可能是**更严**的约束，
      //     猜它是装饰的代价落在安全侧，所以多一个键就具名拒绝；
      //   · 三种状态各有各的名字，不是两个布尔。
      //
      //   > 一个把"派生失败"与"派生出一份空名单"读成同一个值的契约，
      //   > 与一个把它们分开的契约，在从来不失败的用例里是同一个东西。
      label: 'runtime-contract-run-floor（PRT-214：按 Run 的下限过线，三态可分且键集闭合）',
      files: ['runtime/contracts/run-floor.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-214 缺口①的**安装点**：下限装在哪一格、按谁的生命周期撤。
      //
      // 装点是「那一次 Run 的目标 Agent 自己的作用域」，不是装配级：Runtime 进程
      // 长命、一个进程服务很多次 Run，装配级的下限**必然等于第一个 Run 的下限**
      // 并被后面每一个 Run 继承——它比"没有下限"更坏，因为第二个 Run 看起来有下限。
      //
      // ★ 无下限（`absent`）的处置按 spec §6.8 `:479`：「legacy 路径在完成 DSH
      //   强制面接线前**禁止高风险工具**」。所以缺席装的是**高风险名单**那一档，
      //   不是"拒绝一切"——后者会把"还没接线"表现成"产品干不了活"，而且那**不是**
      //   那一条要求写的东西。反过来说，"给了一份下限但我读不懂"（`refused`）
      //   仍然拒绝一切：那种情况下连"哪些是高风险的"都不知道。
      label: 'dsh-composition-run-floor（PRT-214：下限按那次 Run 装、随 Run 撤，缺席＝发布前姿态）',
      files: ['runtime/dsh-composition/run-floor.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-214 缺口①：**真 DSH 进程**里的读数。
      //
      // 判据全部是**带外**的磁盘哨兵，不是"某一层说它拒了"：`isError:true`
      // 只说明有东西拒了，`turn/end` 正常只说明那轮没崩。只有"该被拒的那个
      // 哨兵不存在"**加上**"同一进程里对照组的哨兵存在且内容匹配"合起来，
      // 才等于"拒绝来自**这份**下限"。
      //
      // ★ 缺席那一档必须同时给出**两半**读数：高风险工具被拒、低风险工具放行。
      //   只给前一半的话，"一个把工具全禁掉的实现"也满足它——
      //   而那正是这一批要修掉的那个语义。这一对才是判据。
      //
      // ★ 安全形状：每个子进程自己的一次性 `DSH_HOME`（tmpdir 下、spawn 前断言）、
      //   `patchReload: 'startup'`、删 `DSH_SNAPSHOT` 一族、`spawnSync` 超时、跑完整棵删。
      //   约 3.5 秒。**从不**读写任何真实 profile。
      label: 'dsh-composition-run-floor-dsh-process（PRT-214：下限在真进程里按 Run 生效且真的拦得住）',
      files: ['runtime/dsh-composition/run-floor-dsh-process.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-253 续批三：**Runtime 进程侧**的契约服务端。
      //
      // 鉴权 fail closed，且 `NO_TOKEN`(403) 与 `UNAUTHORIZED`(401) 是**两条可分**的码：
      // 「这台没配令牌」与「你给的令牌不对」要修的地方不一样。
      // 监听器一律绑 port 0（临时端口），绝不占固定端口——操作者机器上跑着真服务。
      label: 'runtime-contract-server（PRT-253：契约服务端、回环监听、鉴权 fail closed）',
      files: ['runtime/dsh-composition/runtime-contract-server.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-253 续批四：**临时端口怎么让另一个进程知道**。
      //
      // 服务端绑 `port: 0`（绝不占固定端口），于是端口是随机的——消费方凭什么知道它？
      // 由**真正绑上了的那个进程**把实际端口写进 DataDir（`pid`/`host`/`port`/`wireVersion`，
      // 原子 tmp+rename）。被否决的替代方案是"Launcher 先分配再传"：那条路的失败模式
      // 落在看不见的地方——`reserveEphemeralPort` 是"先绑再放开"，窗口里被抢时 Runtime
      // 里那一行报 `LISTEN_FAILED`（正确），**但 Runtime 进程自己仍然健康**（`/` 照样 200）
      // ⇒ Launcher 报就绪并交出一个已不属于任何人的端口 ⇒ worker 读到 `RUNTIME_UNREACHABLE`
      // （"配了但够不着"），真因只在另一个进程的一份服务值里。
      //
      //   > 一个把「端口被抢」报成「端点够不着」的部署，
      //   > 会让排障的人去查网络，而问题在分配。
      //
      // ★ 发布记录里**结构上放不下 token**：只有那四个字段（有用例钉住字段清单）。
      label: 'runtime-contract-publication（PRT-253：端口发布与陈旧判据，读不到就具名拒绝）',
      files: ['runtime/dsh-composition/runtime-contract-publication.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-253 续批四：契约服务端那一行自己的输入契约（真 `apply` 与真 Context）。
      label: 'runtime-contract-server-row（PRT-253：契约行自己的输入契约与具名拒绝）',
      files: ['runtime/dsh-composition/plugins/runtime-contract-server-row.test.mjs'],
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
  // ★ PRT-611 续：**可达性**探针 —— "这个模块在生产里到得了吗？"
  //
  // 台账与对照表的 ✅ 口径是「有代码落点 + 可复跑的判据」，里面**没有**"到得了"这一格。
  // 于是"唯一的导入者也是死的"这种传递死亡读不出来：
  //
  //   `runtime/packs/store.mjs`（PRT-1003，✅）有 1 个非测试导入者 ⇒ 看起来是活的，
  //   而那 1 个是 `runtime/packs/builtin/software-delivery.mjs`，它有 0 个导入者。
  //
  //   > 一个「唯一的导入者也是死的」的模块，
  //   > 与一个「真的有人在用」的模块，在"有几个非测试导入者"上是同一个东西。
  //
  // 本组从**真实入口**（进程入口 / scripts / package.json / **清单字符串**）出发跑 BFS，
  // 断言：正对照成立（探针活着）、没有未分类的不可达模块、基线里没有已删除的文件、
  // 四族 gap 的读数仍在。**基线过期（模块变可达）不判红**——那是好消息，不是回归。
  { label: 'reachability（PRT-611 续：可达性探针——已交付但生产里到不了）', files: ['scripts/prt/reachability.test.mjs'], cwd: ROOT },
  // ★ 这一套与上一套是**同一个形状**的两个方向，分开注册是有意的：
  //   · reachability —— 基线里每条 `gap` 必须写得出**裁决处指针**（§5 第 N 条，且 N 存在）
  //   · intervention-coverage —— 台账里每一条**非 ✅** 的行必须被 §5 **点名**
  // 两者治的都是"两份清单之间没人交叉核对"。本仓为此漏过两次
  // （§5 第 20 条、第 21 条），两次都是"一条待办谁也没在看"。
  { label: 'intervention-coverage（PRT-611 续：台账非 ✅ 的行必须被 §5 点到名——治“没有任何人在等它”）', files: ['scripts/prt/intervention-coverage.test.mjs'], cwd: ROOT },
  // ★ 第三套，同一个形状的**第三个方向**：前两套核的是"两份**清单**"，
  //   这一套核的是"**文档里声称的数字** ↔ **产物里真实的值**"。
  //
  //   起因是 2026-09-18 实测到的一处漂移：`docs/MULTI-AGENT-FEATURE-STATUS.md`
  //   写 `PATCH_LAYER_ROWS` **4** 行、枚举里也漏了第 5 行，而产物是 **5** 行
  //   （第 5 行 2026-09-15 就加了，读数没人跟着改）。
  //
  //     > 一个"当时数对过"的数字，与一个"现在还是对的"数字，
  //     > 在文档里长得一样——区别只在有没有人回去数第二遍。
  //
  //   锚点找不到（`ANCHOR_MISSING`）与锚点命中多于一处（`ANCHOR_AMBIGUOUS`）
  //   **都判红**：前者防止判据静默失去检查对象，后者防止判据靠文档行序选数字。
  //   套件里对**每一条**文档锚点做反面控制（改掉声称 ⇒ 必须红），
  //   并对 `runtime` 进程不得持有 `TEAM_HUB_TOKEN` 这条边界做**对称**载荷控制。
  { label: 'boundary-facts（PRT-611 续：文档**数字**与**坐标**↔ 产物真实的值，含执行面凭证边界；'
    + '并含"我方判据文件不得冒充清单"——一张记账表曾被可达性探针读成清单，把 4 个模块假装成生产入口）', files: ['scripts/prt/boundary-facts.test.mjs'], cwd: ROOT },
  // ★★ 第五套，同一族的**第三种断言**：**计数**。
  //
  //   前三套核的是"两份清单之间"、"数字 ↔ 产物"、"对照表自己"；
  //   这一套核的是主表里那 32 处"套件 X（N 例）"——**声明**↔ **真跑出来的用例数**。
  //
  //   起因（2026-09-18）：这一族本会话撞到第 3 次 ——
  //   ① `usage-rollup.mjs` 声称"降级已实现"（而它是零）；
  //   ② `baseline-snapshot.mjs` 声称"没接进 CI"（而它在跑）；
  //   ③ `NOT_FORWARDED_YET` 两条理由指错行号，而门禁只查"理由够不够 40 字"。
  //   第 24 轮把③（**坐标**）做成判据；这一轮做②的**计数**那一半。
  //
  //   实测：主表 33 处声明里 **31 处对、3 处错**（13→64 / 25→98 / 32→37）。
  //   三个数都不是"写的时候算错了"，而是**写完之后用例还在长**——
  //   而那三格描述的是**今天的状态**。
  //
  //   > 一个"写的时候数对了"的数字，与一个"昨天数对了"的数字，
  //   > 在文档里长得一模一样——而后者是**借来的**权威。
  //
  //   ⚠️ 它**只查主表**（`| F-NN …|` 那 15 行）。全仓扫下来有 106 处对不上，
  //   绝大多数是**历史读数**（"本轮…5 例"、evidence 日志里当时的数）——
  //   那些**必须**留着旧值，改它们就是篡改历史。测试④专门钉住这一点：
  //   拿一条历史读数去喂，它必须**不**报。
  //
  //   ⚠️ 它**真跑文件**（32 个，串行 ≈ 18s）。**不能**复用 CI 的套件行计数：
  //   一行**聚合多个文件**（`path-scope` = 4 个文件 ⇒ 67），而声明是**一个数**
  //   —— 拿聚合总数比单个数会得到 135 处假发现（第一版就是这么错的）。
  { label: 'suite-counts（主表"套件 X（N 例）"的**计数声明** ↔ 真跑的用例数；'
    + '★ 只查主表：历史读数必须冻结、当前读数必须跟着代码走）',
    files: ['scripts/prt/suite-counts.test.mjs'], cwd: ROOT },
  // ★★ 第六套，同一族的**第五种形态**：这次是**同一张表的两个格子互相矛盾**。
  //
  //   功能表里「状态」格与「还差什么」格各由人填，而**没有任何东西**
  //   检查它们是否相容。第 27 轮实测找到 **2 行**：
  //
  //     F-22「后端与工作区」  状态 🟡（没做完）  还差什么 `—`（不差什么）
  //     F-24「ACL 与安全姿态」状态 🟡（没做完）  还差什么 `—`（不差什么）
  //
  //   > 一行 🟡 配一个 `—`，与一行 ✅ 在表里长得一模一样——
  //   > 而读者只会看「状态」那一列。
  //
  //   规则只有一条、且不需要猜：状态格的**终点**既不是 ✅ 也不是 ⏸
  //   ⇒「还差什么」格不许为空。
  //
  //   ⚠️ ✅ 与 ⏸ 必须豁免：表中 **21 行 ✅ 与 2 行 ⏸ 正是**用 `—` 写的，
  //   而那是**正确**的写法。一条"任何状态下都不许 `—`"的规则会红在
  //   23 个正确的地方，然后被人整体关掉——那比没有更坏。
  { label: 'feature-table-status（功能表「状态」格与「还差什么」格必须相容：'
    + '🟡/⬜ 配空占位 = 没做完却说不差什么；✅/⏸ 豁免）',
    files: ['scripts/prt/feature-table-status.test.mjs'], cwd: ROOT },
  // ★★ 第七套，同一族的**第六种形态**：这次是**读数的适用范围**。
  //
  //   第 24～27 轮我跑了 5 次全量 CI，逐条写成
  //     「全量 CI（**交付 HEAD**）| 9/9 PASS，exit 0（HEAD `dd6eb8f`，`.ci/r27b`）」
  //   而 `summary.json` 里当时只有 `git head=<sha>` —— **提交的名字，不是树的状态**。
  //   本轮实测：那一天**每一次**全量 CI 都跑在一棵脏树上
  //   （同一工作树里还有另一个会话的在制品）。
  //
  //   > `git head` 回答"哪个提交"，读者读成"哪棵树"。
  //   > 在一份 9/9 PASS 的报告里，这两个问题**长得一模一样**。
  //
  //   ⇒ 「交付 HEAD」那一行必须用**封闭词表**写出树的状态：
  //       `干净树`  或  `脏树 <N> 改 + <M> 未跟踪`
  //     自由文本（"已确认工作树"）不算 —— 那种形状与真的提了树，
  //     在正则下的区别是猜出来的。
  //
  //   ⚠️ 本条只跑**文档层**。第二层（真读 `.ci/*/summary.json` 交叉核对）
  //   在同一个模块里，但**不能**进 CI：`.ci/` 在 `.gitignore:43`、
  //   tracked 文件数 0 ⇒ 全新检出里那份产物根本不存在，
  //   在 CI 里它会永远"没有可核对的产物"，而**那种绿是假的**。
  { label: 'ci-reading-integrity（「全量 CI 9/9 PASS @ <sha>」必须写出**跑在哪棵树**上：'
    + '`git head` 是提交的名字、不是树的状态；封闭词表 干净树 / 脏树 N 改 + M 未跟踪）',
    files: ['scripts/prt/ci-reading-integrity.test.mjs'], cwd: ROOT },
  // ★★ 第八套，同一族的**第七种形态**：这次是**跨文档的状态各说各话**。
  //
  //   目标原话是「**以这份文档**要增加的功能为基础」，指的就是
  //   `docs/MULTI-AGENT-FEATURE-OPTIMIZATION.md`。而它 §4 每个功能标题后面
  //   括着**写作当时**的状态注记：
  //
  //     #### F-03 Runtime Manager（规格已定义，产品级闭环待补）
  //     #### F-10 Permission Engine（控制面基础已落地，DSH 工具全量接线待收口）
  //     #### F-12 Product Launcher（产品级 Launcher 待完成）
  //
  //   实测：**8 条带注记的标题里 7 条说"还没做完"，而状态表里那 7 条全是 ✅**
  //   （只有 F-04 仍是 🟡，它的注记是对的）。
  //
  //   > 一份说"F-12 待完成"的设计文档，与一份说"F-12 ✅"的进度表，
  //   > 放在一起，**读者信哪一份取决于他先打开哪一份**。
  //
  //   处置：注记**一个字都不删**（设计期快照，删了等于篡改历史），
  //   而是在规格里加一节 §1.2 **校准表**写下取代关系，由这条判据核对。
  //
  //   规则：① 注记说没做完 + 状态表已全 ✅ ⇒ 必须在校准表里；
  //        ② 校准表写的状态必须等于状态表当前状态（校准表自己会过期）；
  //        ③ 校准表不许有"注记还没被取代"的条目。
  { label: 'spec-status-calibration（目标点名的**输入文档**里，标题状态注记必须与状态表对得上：'
    + '"说没做完"的注记若已被取代，必须在 §1.2 校准表里；校准表与状态表双向核对）',
    files: ['scripts/prt/spec-status-calibration.test.mjs'], cwd: ROOT },
  // ★★ 第九套，同一族的**第九种形态**：引用的路径**读者解析不出来**。
  //
  //   第 25 轮就发现 F-21 那格引的是 `plugins/connector-feedback.mjs`，而文件在
  //   `runtime/dsh-composition/plugins/connector-feedback.mjs`——当时判断
  //   "代码落点正确性归第 27 轮那种判据管"，**没有**顺手改。第 31 轮把它量完。
  //
  //   ★ 量出来的第一版读数是「49 个引用里 **23 个解不开**」——**那是假读数，两次**：
  //     ① 遍历没排 worktree 副本，`server.mjs` 的计数被撑成 38；
  //     ② 我把每个名字独立拼路径，而这一列**有惯例**：
  //        第一个带目录的路径确立目录，其后的裸文件名继承它。
  //   按惯例重扫 ⇒ 0 个真缺陷；按"带 `/` 就必须原样存在"再筛 ⇒ **恰好 1 个**（F-21）。
  //
  //   规则：R1 带目录的路径必须存在；R2 裸名必须在全仓**恰好一个**同名文件
  //         （这才是这列简写的合法性条件）；R3 裸名先试沿本格目录继承。
  { label: 'feature-landing-paths（功能表「代码落点」列的每个路径都要让读者找得到：'
    + '带目录的存在；裸名全仓唯一——它今天仍然"看起来是对的"，因为名字没错、文件也都在）',
    files: ['scripts/prt/feature-landing-paths.test.mjs'], cwd: ROOT },
  // ★ 第 33 轮：把目标文档 §9「商业 Alpha 完成标准」那条链**逐节**投影到真实接线上。
  //
  //   起因：目标文档把"做完了"写成一条九节的链，而"还剩什么没做"在本仓散落在
  //   **四个**地方（台账 145 行 / §5 的 29 条裁决项 / 46 项不可达 / §5.x 各节散文），
  //   **没有一处回答"这条链断在哪一节"**。于是同一个问题每次都要重读四个地方。
  //
  //     > 一份"还剩 5 项"的台账，与一份"这条链断在第 5 节"的投影，
  //     > 对"下一步该做什么"给出的答案不是同一个东西。
  //
  //   它今天给出的读数是：**L5 硬断**，L7/L9 软缺口，整条链**不全绿**。
  //
  //   ⚠️ 两处最容易写错、已被 8 条变异钉住的地方：
  //     ① 第一版把"这一节有活实现"定义成"至少一个模块可达"⇒ **九节全绿**，
  //        而它对"断在哪一节"一个字都没说。⇒ 每一节必须显式写下**核心模块**。
  //     ② "不可达"与"不可达且**没人打算接**"不许同形：
  //        `product/upgrade/switchover.mjs` 不可达属 `deliberate`（CLI 按路径调），
  //        而 `runtime/toolcall/spool.mjs` 不可达属 `gap`（真缺挂点）。
  { label: 'alpha-chain-trace（目标文档 §9 那条九节链逐节投影：'
    + '核心模块没人挂 = 硬断；支撑模块没人挂 = 软缺口——两者不许同形）',
    files: ['scripts/prt/alpha-chain-trace.test.mjs'], cwd: ROOT },
  // ★★ 第十一套（第 35 轮）：**台账每一条 ✅ 的"可复跑证据"必须解得开**。
  //
  //   到第 34 轮为止，本仓为非 ✅ 的那 5 行立过判据、为 §5 的裁决表立过判据，
  //   而**那 140 个 ✅ 的证据栏从来没有被任何东西核对过**。
  //   台账自己的口径写着 "✅ = 有代码/文档交付物 + **可复跑的用例或实测证据**"
  //   ⇒ "可复跑"是 ✅ 的定义的一部分。
  //
  //     ⚠️ 三条规则只收**形状无歧义**的点名（套件别名 / 带目录的路径 / 裸名）：
  //        · 套件别名必须是**一行 CI 套件**（`prt-topology` 在磁盘上没有同名文件）
  //        · 裸名必须在全仓**恰好一个**同名文件——这正是"简写合法"的条件
  //        · **不**去散文里找文件名，也**不**把"没有点名套件"判红（口径允许实测证据）
  //
  //   本批读数：套件 96 + 带目录 33 + 裸名 39，抓出 **3 处歧义裸名**（已修文档）。
  { label: 'ledger-evidence（台账 140 条 ✅ 的"可复跑证据"必须解得开：'
    + '套件点名要真的是一行 CI 套件，裸文件名要在全仓唯一）',
    files: ['scripts/prt/ledger-evidence.test.mjs'], cwd: ROOT },
  // ★★ 第十二套（第 35 轮，**被我自己踩出来的**）：
  //   「**名字像**」与「**真的跑到**」不是同一个东西。
  //
  //   本轮的收尾复核里，我拿 `node scripts/ci/run-ci.mjs --only boundary`
  //   当成了"边界类判据都验过了"——而 `boundary-facts` **不在** `boundary` 阶段里，
  //   它在 **`test`** 阶段（`boundary` 阶段跑的是 PRT-108 棘轮 + PRT-211 锚点漂移）。
  //   于是那次"验证"一个字节都没跑到要验的判据，而它的输出写着 `boundary PASS`；
  //   结果那一轮的收尾提交把一个**红的**判据发了出去
  //   （散文写 873 秒、表里 873594ms 四舍五入是 874——我把四舍五入写成了截断）。
  //
  //     ⚠️ 同类陷阱还有一对：`--only doc` **不跑** `doc-table` / `doc-render`。
  //        所以这里判的不是"相似该不该存在"，而是**它有没有被写下来**。
  { label: 'stage-scope（`--only <阶段>` 与套件名**像**但不是一回事：'
    + 'boundary↔boundary-facts、doc↔doc-table/doc-render 必须声明过）',
    files: ['scripts/prt/stage-scope.test.mjs'], cwd: ROOT },
  // ★★ 第十三套（第 35 轮，**同样是本轮被自己咬出来的**）：计数解析器本身。
  //
  //   起因：`ledger-evidence` 有一个用例的**名字**里带了字面量
  //   `tests 21 / pass 20 / skipped 1`（它是夹具）。node 把用例名打进 stdout，
  //   而当时的解析用 `re.exec(all)` 取的是**第一个**匹配
  //   ⇒ 那一行被读成 `tests=21 pass=20 skipped=1`，而它真实是 **10/10/0**；
  //   `test` 阶段的总 `skipped` 也跟着从 1 变 2，多出来的那一条**根本不存在**。
  //
  //     ⚠️ 这一格两个方向都被咬过：
  //        · 看不见：`skipped` 曾经**没被解析**（38 条里跳过 20 条，摘要一个字没说）
  //        · 看见了一个假的：**一个用例的名字改写了一次 CI 的读数**
  //     两个方向都让一个数说谎，所以解析器抽成了模块，并在这里直接喂两段输出对比。
  { label: 'parse-suite-output（CI 计数解析：取**最后**一个匹配，'
    + '且输出里有东西长得像摘要时必须说出来——"一个用例的名字改写过一次读数"）',
    files: ['scripts/ci/parse-suite-output.test.mjs'], cwd: ROOT },
  // ★★ 第十四套（第 36 轮）：**目标文档自己的实现投影表**。
  //
  //   第 35 轮核的是**台账**里 140 条 ✅ 的可复跑证据。而"目标实现了没有"还有
  //   **第二份**权威表：`docs/MULTI-AGENT-FEATURE-STATUS.md` 的 F-01～F-25。
  //   它此前**没有任何判据核对**，于是两类形状都能长期存在：
  //     ① **凭空点名**：引用台账里不存在的 PRT、不是 CI 套件的"套件名"、
  //        或全仓同名的裸用例文件 ⇒ 读者按它去复核会**找不到**；
  //     ② ★★ **一个 🟡 行说"不差什么"**——本仓第 27 轮**真的**发生过
  //        （F-22/F-24 的缺口写在「依据」格里，而「还差什么」是 `—`）。
  //        「格子里有信息、而放错了格子，按这一列读表的人读不到它」。
  //
  //   上线第一次就在真仓库里抓出一处：F-01 点的裸名 `contract.test.mjs`
  //   全仓有 2 个（45 例 / 26 例），已按内容判定改成全路径。
  { label: 'feature-evidence（目标文档的实现投影表：点名的 PRT / 套件 / 用例文件必须解得开，'
    + '且 🟡 行必须说清还差什么——"一个 🟡 行说\'不差什么\'，与\'已做完\'长得一模一样"）',
    files: ['scripts/prt/feature-evidence.test.mjs'], cwd: ROOT },
  // ★★ 第十五套（第 37 轮）：目标文档 **§7「测试与指标」** 的逐条投影。
  //
  //   §7 此前**没有任何判据、也没有任何文档引用它**——`git grep §7` 在整仓里
  //   只命中别的东西。于是"§7 满足了没有"**无法回答**，而那是目标文档自己的一节。
  //
  //   它真正防的形状有两条：
  //     ① **一整节要求没人认领**：§7 有 6 条，谁都没说它们各自托着 §6 的哪条退出条件；
  //     ② ★★ **把观测性指标读成未完成任务**：§7 第 6 条那 6 个「持续观察」指标
  //        在 §6 的**五条退出条件里一条都没提到**。
  //
  //        > 一条**观测性**要求与一条**完成标准**，在"未实现"这个读数下长得一模一样——
  //        > 而前者不该拦发布，后者该。把它们混起来，要么永远关不掉，
  //        > 要么用"指标没做"去否掉一个已经达标的发布。
  //
  //   所以每条要求必须自报 `kind`（退出条件 / 观测），观测档必须写出**为什么
  //   它不是完成标准**，退出条件档声明的退出条件必须在 §6 里**逐字找得到**。
  { label: 'spec-tests-7（目标文档 §7 的逐条投影：每条要求托着 §6 哪条退出条件 / '
    + '或为什么它不是完成标准；落点必须解得开）',
    files: ['scripts/prt/spec-tests-7.test.mjs'], cwd: ROOT },
  // ★★ 第十六套（第 38 轮）：目标文档 **§2 那 5 条「不可突破的边界」**。
  //
  //   第 38 轮实测：那一行在**整仓里只出现一次**（就是它自己）——
  //   **没有任何判据、没有任何模块、也没有任何别处的文档引用过**。
  //
  //     > 五条「不可突破的边界」与五句没人读过的愿望，
  //     > 在"它们有没有被守住"这个读数下是同一个东西。
  //
  //   它真正防的形状：
  //     ① **边界没人认领**：哪几条有机械判据、哪几条只是设计决定，此前无法回答；
  //     ② ★★ **机械判据的空转**：本轮的探针第一版是**整套假阴性**——它调的 `rg`
  //        在本机**不在 PATH 上**，而 `catch { return [] }` 把 ENOENT 与"没有匹配"
  //        吞成了同一个值 ⇒ 5 条边界**全部**报 0 命中。
  //
  //        > 一个依赖缺失的检索器，与一个真的什么都没匹配到的仓库，
  //        > 在"零命中"这个读数下是同一个东西——只不过前者的 0 来自**没跑**。
  //
  //   所以每个机械判据都要报**它扫了几个文件**，扫到 0 ⇒ 红；
  //   声称有判据而判据解析不到 ⇒ 红；设计档必须写出**为什么它没有机械形状**。
  //   4 条机械（单一 Harness 目录 / 三层里不许有 agentLoop / 控制面库只有一本 /
  //   产品代码里不许有装 DSH 这一步）+ 1 条如实记为设计决定（worktree 不是安全沙箱）。
  { label: 'design-boundaries（目标文档 §2 的 5 条「不可突破的边界」：每条都要有归属，'
    + '机械判据必须真的跑、且真的查了东西）',
    files: ['scripts/prt/design-boundaries.test.mjs'], cwd: ROOT },
  // ★ 第四套，同一个形状的**第四个方向**：前三套核的是"两份**清单**之间"或
  //   "**数字**↔产物"，这一套核的是"**对照表自己**"。
  //
  //   起因是 2026-09-18 在 `docs/MULTI-AGENT-FEATURE-STATUS.md` 里量出的**两处**：
  //     · F-11 写"三道范围检查在生产里从未被注入"，而第一道（`pathScope`）早已
  //       接进生产组合根；同一格还写 `whitelist`"连端口都没有"，而桥的入参表里
  //       **就有它**——**有位无值**，不是无位；
  //     · F-15 写 `peak-resource`"阻塞于 PRT-011 平台裁决"，而 PRT-011 在
  //       2026-09-11 就裁完了，且它裁的是**分发形态**、与目标平台无关。
  //
  //     > 一个手写的状态与一个被核过的状态，在表格里长得一模一样；
  //     > 区别是前者会在代码变了之后**继续那么写**。
  //
  //   ★ 它**只**断言两件"错了就一定是错"的事：25 条编号全被指到（拆分行也算）、
  //   每行落点**至少一条**解析得到。
  //
  //   ★★★ 它**刻意不判"状态词表"**——那已经有一个所有者：
  //   `scripts/prt/progress-check.test.mjs` 的用例 ⑥，而那条判据**明确许可箭头
  //   写法**（`okStatus` 里有 `/^[✅🟡⬜⏸]+→[✅🟡⬜⏸]+$/`）。
  //   本判据的第一版**自己抄了一份词表**并据此"订正"了真文档里三格箭头，
  //   于是**把那条既有判据弄红了**（全量 CI 抓到的）。
  //
  //     > 一道看不见某类改动的闸门，比没有闸门更危险；
  //     > 而**一道看得见的闸门，比我以为"没有闸门"更常见**。
  //
  //   ⇒ 一个形状只能有一个所有者：两份词表并存必然漂移，而漂移的那一天
  //   没人知道该信哪一份。本套改为**钉住那个所有者还在**（判据文本 +
  //   它被登记进 `run-ci`）——"文件里留着字"与"它真的会被跑"是两件事。
  //
  //   ★ 它**不**判"功能做完没有"——那不是读数能回答的问题，是产物与裁决的问题。
  //   也**不**断言"每条落点都解析得到"——单元格大量使用同目录裸名、大括号展开、
  //   目录通配与**路由**，把那些一律判红会让判据**红在正确的地方**，那会教人删掉它。
  //   （探针第一版报了 22 条"落点不存在"，逐条查下来**一条真的都没有**。）
  //   ★ 拿不到文件清单（干净检出/无 git）时，落点那一段**显式记成"无法判定"并跳过**，
  //   不许伪装成"通过"，也不许让 29 行全红。
  { label: 'feature-table（F-01～F-25 对照表 ↔ 它自己指的产物：25 条编号全在、'
    + '每行至少一条落点解析得到；状态词表**归 progress-check ⑥**，本套只钉住那个所有者还在）',
  files: ['scripts/prt/feature-table.test.mjs'], cwd: ROOT },
  // PRT-611 续：「声明了却没人读」的扫描**接进 CI**。
  //   ★ 起因：台账引用了 `scratch/scan-silent-declarations3.mjs` 的读数
  //   （"还剩 3 个，一个都没改"），而**没有任何东西在跑它** ⇒
  //   它的读数从 3 漂到 0 没人发现，原因是**有人把那三个字段的名字写进了文档**
  //   （含 `boundary-facts.mjs` 里的手钉），纯词频就把"提及"当成了"读者"。
  //   > 一份被引用、但**没有任何东西在跑**的读数，
  //   > 与一份"已经不再成立"的读数，在台账里长得一模一样。
  //   ★ 扫描器内部已有两重断言：**已知集合一致**（新出现/少一个都红）
  //   + **五种字段的正对照**（含"只在注释/字符串里被提到"与
  //   "含引号的正则之后的真读者"这两种——正是它自己栽过的两个坑）。
  { label: 'silent-declarations（PRT-611 续：哑声明扫描 + 五种字段正对照，防"判据被弄瞎"）', files: ['scripts/prt/silent-declarations.test.mjs'], cwd: ROOT },
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
      // PRT-214 组合根：`assembleEnforcement()` / `bootstrapDshRuntime()` /
      // `bindDshRuntime()` 此前**只有用例在调**，于是 worker 的 `executor`
      // 永远是 `HOST_PORT_REQUIRED`——「强制面未生效时禁止自动执行」这条保证
      // **从未被行使过**。
      //
      //   > 一个宣言从没被行使过，与这个宣言不存在，在行为上完全一样。
      //
      // 这一组最要紧的三条不是"配置解析对不对"，而是：
      //   ① 装配**只发生一次**，两行共用**同一份**桥与**同一本**登记簿
      //      （断言身份 `===`，不是形状——形状相同的两份登记簿在这里恒真）；
      //   ② 组合根拿不到时，行模块**拒绝**且**不挂一个空的 listener**
      //      （并配一条反向对照：装好了就真的挂上，否则"没挂"是空的）；
      //   ③ `root.bind` 真的把 `productionExecutorProvider()` 从
      //      `HOST_PORT_REQUIRED` 翻成可用、`unbind` 再翻回去。
      //
      // 全是注入的假件：端口是假的，绝不注册进任何真 `ToolRuntime`。
      label: 'dsh-composition-root（PRT-214：只装配一次 / 行模块拒绝而不空挂 / 绑定真的翻转 provider）',
      files: ['runtime/dsh-composition/root.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-214 续：组合根的**第一个生产调用方**。
      //
      // `root.test.mjs` 证明的是"装一次、拒绝不空挂、绑定翻转 provider"——
      // 而在此之前 `installEnforcementRoot()` 只被用例调过，于是 `enforcementRoot()`
      // 在真实部署里永远是 `null`：
      //
      //   > 一个"有人可以调"的装配入口，与一个"从来没有被调用过"的装配入口，
      //   > 在运行的部署上是同一个东西——只不过前者的用例是绿的。
      //
      // 这一套盯的就是那一件事，外加两个只在**真 cordis Context** 上才立得住的判据：
      //   · 补丁层的行序**不携带加载语义**，所以"根先装好"必须由服务依赖保证——
      //     用例把根行**最后**加载，两行运行期模块仍然激活；反向也跑一遍；
      //   · 根真的缺席时那两行是 **pending**（由挂载审计报未激活），不是抛、
      //     也不是静默 no-op。这两条路必须可分。
      //
      // 需要 DSH_CHECKOUT 的那几条逐条 `t.skip()`（`skipped: N` 看得见）；
      // 其余（拒绝码、配置闭集、`decide` 适配器、与 product/ 的键名对账）照常跑。
      label: 'dsh-composition-root-row（PRT-214 续：真正调用组合根那一行，且激活与行序无关）',
      files: ['runtime/dsh-composition/plugins/root-row.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-214：**真 DSH 进程**里的读数。
      //
      // 上面两套都不是 DSH 进程：`patch-loadable` 是解析期接受（形状检查），
      // `root-row.test.mjs` 下半部分是自己 `new` 出来的**真 cordis `Context`**。
      // 而 `--dump-config` 看起来更像证过了——它 code 0，输出里还带着锚定好的
      // `file://…/root-row.mjs`。但 `dump-config.js` 自己写着 "without booting or
      // evaluating"，`renderConfigDump()` 只**解析并锚定**，从不实例化。
      //
      //   > 一条"被解析并锚定"的补丁行，
      //   > 与一条"被真的挂进进程"的补丁行，在 dump 的输出里完全同形——
      //   > 只不过前者从来没有 `apply` 过。
      //
      // 所以这一套不看 dump，它启动**真 CLI**（`apps/cli/lib/bin.js`），用探针行的
      // stderr 读数回答"apply 跑没跑"，并给出四条此前没有的读数：
      //   · dump 锚定但 `apply` 未执行（对照组，其余几条的前提）；
      //   · 真 profile 启动时补丁行的 `apply` **真的跑了**；
      //   · 真 `legion-host.patch.yml` 的 root-row 跑了并**拒绝**（具名码，启动失败）
      //     —— 拒绝不是成功，这条断言的就是拒绝本身；
      //   · 全链：根行装好 → 服务发布 → 两行运行期模块由挂载审计报 ACTIVE →
      //     真 `tools/pre-execute` 瀑布**认领**（`deny`）一次调用；
      //     外加反向对照：根行缺席时 DSH 自己报 `pending (waiting for service: …)`。
      //
      // ★ 安全形状写进用例本身：每个子进程都吃**自己的临时 `DSH_HOME`**
      //   （`os.tmpdir()` 下，启动前断言），profile 声明 `bundles: []`
      //   ——一个 bundle 层都不挂，于是 web/llm/凭据/网络那一整片行根本不进树；
      //   `DSH_SNAPSHOT` 从子进程环境删掉；每个子进程都有 spawnSync 超时上界。
      //   **从不**读写 `~/.dsh`，**从不**把补丁文件写进真实 profile。
      //
      // 需要 DSH_CHECKOUT 的那几条逐条 `t.skip()`（`skipped: N` 看得见）；
      // 缺席的宿主不伪造通过。
      label: 'dsh-composition-root-row-dsh-process（PRT-214：apply 在**真 DSH 进程**里跑没跑，含全链与否决对照）',
      files: ['runtime/dsh-composition/plugins/root-row-dsh-process.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-253 续：`bindDshRuntime()` 的**生产调用方**。
      //
      // 这一套问的是一个此前答"否"的问题：worker 的 `productionExecutorProvider()`
      // 在真实部署里能不能造出引擎？在那批之前，`bindDshRuntime()` 与
      // `bootstrapDshRuntime()` **只有用例在调**，于是答案永远是
      // `EXECUTOR_HOST_PORT_REQUIRED`——「强制面未生效时禁止自动执行」与预算闸门
      // 从来没被行使过。
      //
      //   > 一个"写好了、也验证过被调用"的注册口，
      //   > 与一个"没有任何生产代码调用它"的注册口，在运行的部署上是同一个东西——
      //   > 只不过前者的用例是绿的。
      //
      // 需要 DSH_CHECKOUT 的那几条逐条 `t.skip()`；其余照常跑。
      label: 'dsh-composition-runtime-host-row（PRT-253：bindDshRuntime 的生产调用方与它的具名拒绝）',
      files: ['runtime/dsh-composition/plugins/runtime-host-row.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-253 续：**真 DSH 进程**里的读数。
      //
      // 判据是 **worker 自己那个模块**（`orchestrator/worker/executor-binding.mjs`）的
      // 读数，不是副本：挂上这一行 ⇒ `ok=true code=none`；只少这一行补丁 ⇒
      // `ok=false code=EXECUTOR_HOST_PORT_REQUIRED`；有行但没有端口工厂 ⇒
      // 进程 exit 1 + 具名码。三个读数两两不同形。
      //
      // ★ 安全形状同上：每个子进程自己的临时 `DSH_HOME`（tmpdir 下、启动前断言）、
      //   `bundles: []`、删掉 `DSH_SNAPSHOT`、`spawnSync` 超时、跑完删干净。
      //   **从不**读写 `~/.dsh`。本行**不进** `legion-host.patch.yml`（理由见其文件头）。
      label: 'dsh-composition-runtime-host-row-dsh-process（PRT-253：生产调用方在**真 DSH 进程**里绑定生效）',
      files: ['runtime/dsh-composition/plugins/runtime-host-row-dsh-process.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-253 解阻批：**那条残留要求拿掉了，绑定真的建立得起来**。
      //
      // 上一版 `bindDshRuntime` 硬要求 `canRead`，于是 Runtime 进程里的注册方
      // 以 `RUNTIME_HOST_REGISTRAR_NO_CAN_READ_SOURCE` 拒绝 ⇒ 整个绑定建立不起来。
      // 但本仓库的**跨进程**部署形状下，那个进程里**没有任何东西读**这个绑定的
      // `canRead`：`runtime/dsh-composition/enforcement.mjs` 全文 0 处、
      // `runtime/adapters/dsh/port.mjs` 的方法表里没有权限面、权威（岗位清单 / lease）
      // 在 worker 一侧。为一个没有读者的输入拦住整个绑定，是把"接线遗漏"与
      // "进程里根本没有这个读者"混成同一条拒绝。
      //
      // ★ 而**两条 fail closed 一字未放松**，且各自有用例真的守着：
      //   · 同进程：`productionExecutorProvider()` 读到绑定的 canRead 不是函数 ⇒
      //     `EXECUTOR_CAN_READ_REQUIRED`；
      //   · 跨进程：`productionExecutorProviderFromEnv` 没有调用方给的 canRead ⇒ 同一个码。
      //   （我独立破验过同进程那道门：把它改成恒不进入 ⇒ 正好只让守着它的那条用例变红。）
      //
      // ★ 安全形状同上：一次性 `DSH_HOME`（tmpdir 下、启动前断言）、`bundles: []`、
      //   `patchReload: 'startup'`、删 `DSH_SNAPSHOT`、spawnSync 超时、跑完整棵删，
      //   监听一律 port 0，**从不**读写 `~/.dsh`。
      //
      // ⚠️ 诚实边界：正例读数是在**一个声明过的能力探针替身**下取得的；真探针在真进程里
      //   只能确认 **1/4**（`structured-result`），真取值下自检仍然拒绝
      //   （那正是 `AFTER` 那条读数）。所以"绑定建立" ≠ "真引擎完成真任务"。
      label: 'dsh-composition-runtime-host-binding-unblocked（PRT-253：绑定在真进程里建立得起来，两条 fail closed 未放松）',
      files: ['runtime/dsh-composition/plugins/runtime-host-binding-unblocked-dsh-process.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-253 续批二：`runtimeHost` 探针与 `canRead` 的**生产来源**。
      //
      // 这一套盯的是"探针不许乐观"：版本从进程现场的安装读（读不到 ⇒ null ⇒ 判不兼容）；
      // 四项能力里只有一项有真来源，另外三项按**未确认**报（fail closed）；
      // `canRead` 没有合法来源 ⇒ 具名拒绝，**没有**默认放行、**没有**抄替身。
      //
      //   > 一个"全 true 的能力表"，与一个"真的验过的能力表"，
      //   > 在 `checkCompatibility` 的返回值上是同一个读数——
      //   > 只不过前者会在一个从未验过的引擎上判"兼容"。
      label: 'dsh-composition-runtime-host-registrar（PRT-253：探针与 canRead 的生产来源，不乐观）',
      files: ['runtime/dsh-composition/plugins/runtime-host-registrar-row.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-253 续批二：**真 DSH 进程**里，注册方在场/缺席是两个不同的具名读数。
      //
      // N↔R 只差**一个模块路径**却是两个不同的码；S↔S2 唯一变量是桩 provider 的一个布尔值。
      // ★ 安全形状同上：每个子进程自己的一次性 `DSH_HOME`（tmpdir 下、spawn 前断言）、
      //   `bundles: []`、`patchReload: 'startup'`、删 `DSH_SNAPSHOT`、`spawnSync` 超时、
      //   跑完整棵删。**从不**读写 `~/.dsh`，**从不**把补丁层写进任何真实 profile。
      label: 'dsh-composition-runtime-host-registrar-dsh-process（PRT-253：注册方在场/缺席在真 DSH 进程里可分）',
      files: ['runtime/dsh-composition/plugins/runtime-host-registrar-row-dsh-process.test.mjs'],
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
      files: [
      'product/config.test.mjs',
      'product/init.test.mjs',
      // ★ 第 19 条 §9.2 第 3 步：执行面两半数据的**同一个**读取点。
      //   它把"这个键压根没配"与"配了但解释不通"分开——
      //   前者如实记成 `absent`（因为 `pathScope === null` 在执行面是**放行**），
      //   后者由两半各自的模块具名上抛，不压成"读取失败"。
      'product/execution-plane-config.test.mjs',
    ],
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
    // F-05（MULTI-AGENT-FEATURE-OPTIMIZATION.md §4.1）——当时**没有** PRT 编号的一条缺口，
    // 因此这一组是它唯一的判据。它分两半，理由不同：
    //
    //   前半「运行明细作为可持久化 RunEvent 写入控制面」：
    //     改动前 `executor.mjs` 的事件循环只留终态与用量/产物，13 种契约事件里
    //     **11 种读完即弃**。于是"这次用了哪个模型、调了哪些工具"事后无从回答。
    //     用例分三层（仓储 / executor 接线 / 真 hub HTTP），因为它们失效的方式不同：
    //     仓储层全绿也可能没有任何调用方，而"有用例"不等于"已生效"。
    //
    //   后半「可靠投递状态机」：
    //     改动前 `broadcastAudit` 丢掉 `res.write` 的返回值、异常被事件循环吞掉，
    //     读数是"发过了"。用具例锁住三件事——`delivered` 只能由 CAS 从
    //     `delivering` 得到、`suppressed` 必须带封闭词表里的原因、崩了只能落
    //     `unknown`（既不许说 `delivered` 谎报可见性，也不许回 `pending` 重投
    //     一个可能已经到达的事件）。
    {
      label: 'run-events（F-05 前半：13 种 RunEvent 明细落控制面，三条出口都带明细）',
      files: ['team-hub/run-events.test.mjs'],
      cwd: ROOT,
    },
    {
      label: 'event-delivery（F-05 后半：投递六态、CAS 交付、封闭抑制原因、崩溃收敛为 unknown）',
      files: ['team-hub/event-delivery.test.mjs', 'team-hub/event-delivery-wiring.test.mjs'],
      cwd: ROOT,
    },
    // F-16（MULTI-AGENT-FEATURE-OPTIMIZATION.md §4.4）——自动化计划 / 运行历史。
    //
    // spec 那一行是"日历只做投影；新增计划、运行、时区、skip-on-overlap、
    // 补跑和审批暂停状态"，而它点出的六件事每一件都对应一个**不会报错的失效**：
    //   · 日历不是投影 → 翻页产生运行行（"上个月跑了 400 次"里 380 次是有人看过）
    //   · 时区回落本地 → 每天都成功，只不过跑在错的时间上
    //   · 跳过不记账 → "没被触发"与"被跳过了"同形
    //   · 补跑默认 all → 停机三天之后一次性重放三天的工作
    //   · 等待审批合进 running → 这条计划从此永远不再触发（静默停摆）
    //
    // 两套用例的失效方式不同，都要有：仓储层（22 例，含**真 Intl** 的时区
    // 换算与 DST 边界）+ 真 hub HTTP 接线层（7 例，含"投影端点打 50 次
    // 运行表一行都不多"）。
    {
      label: 'automation（F-16：日历只做投影、真时区、skip-on-overlap、补跑三策略、审批暂停）',
      files: ['team-hub/automation-store.test.mjs', 'team-hub/automation-http.test.mjs'],
      cwd: ROOT,
    },
    // F-17（§4.3）——长会话压缩：**不可变原文 + 版本化摘要 + 引用回原文**。
    //
    // 三件事各自的失效方向都是**不可逆**的，所以它们是分开验的：
    //   · 原文可改写 → "摘要读起来不对"这件事无法被证伪（没有东西可以对）
    //   · 摘要不版本化 → 一次更差的摘要会盖掉上一个好摘要，且无痕迹
    //   · 没有回引 → 摘要是一段无法复核的文本，读者只能选择相信它
    // 加上 baseVersion CAS（不检查时两个进程会各写一份"版本 1"）、
    // 区间不许重叠（重叠时同一条消息会被算两次）这两条并发判据。
    {
      label: 'compaction（F-17：不可变原文、版本化摘要、回引完整性、baseVersion CAS）',
      files: ['team-hub/compaction-store.test.mjs', 'team-hub/compaction-http.test.mjs'],
      cwd: ROOT,
    },
    // F-15（§4.4）——用量/成本汇总：按 scope、goal、task、employee、model
    // 记录 token、调用次数、耗时和成本。
    //
    // 闸门那一半（reserve/observe/settle、硬阻止、暂停、锁）已由
    // `budget-ledger` 与 `budget-gate` 覆盖。本组补的是另一半：**把已经
    // 记下来的事实按五个维度读出来**，而它的全部难点在于"每一个数字都有
    // 一个'不知道'的邻居"：
    //   · NULL token 不是 0（`SUM` 会把它当 0 加进去）
    //   · 缺价的金额不是 0（算进去会**低估**总成本，而报表看着正常）
    //   · 未结束的 Attempt 没有耗时（用 now-created 顶替会把"卡住"画成"在跑"）
    //   · 未归属维度要进显式桶（丢掉它们会让各维度之和不等于总额）
    //   · 混币种的金额之和没有意义（必须报出来，不许替调用方换算）
    //   · 耗时**不许按记账次数重复计算**（本模块第一版真的写错了这一处：
    //     JOIN 到 usage_records 之后一条 Attempt 被算了 N 遍，
    //     而"每条恰好记一笔"的时候完全看不出来）
    {
      label: 'usage-rollup（F-15：五个维度 × 四个量，且"不知道"必须与 0 分得开）',
      files: ['team-hub/usage-rollup.test.mjs', 'team-hub/usage-rollup-http.test.mjs'],
      cwd: ROOT,
    },
    // F-15 的后半：**告警与降级**（第 23 轮补）。
    //
    // spec 那一行要四件事：「支持**告警、降级、暂停和硬阻止**」。
    // 上面两组覆盖了「暂停 / 硬阻止」（`budget-ledger` 的预留超限 ⇒ 取消）
    // 与「读出来」（`usage-rollup`）。而**告警与降级此前一件都没有**：
    // `budget-ledger.mjs` 里 `降级` / `告警` / `degrade` / `alert` 的出现次数
    // **全部是 0** —— 而 `usage-rollup.mjs` 的文件头**声称**它已实现。
    //
    //   > 一行写着"已实现"的覆盖声明，与一行真的已实现，
    //   > 在排期表上是同一个东西——只不过前者会让下一轮的人**不去看它**。
    //
    // 本组钉住的是这两件事里**唯一会致命的那一处**：
    // 一张把"不知道"当成"还没花"的告警。已知花费 0 元 / 上限 100 元 /
    // 但有 7 条账目金额未知 ⇒ `spent / limit = 0` ⇒ "离上限还远"，
    // 而那 7 笔里可能有一笔早就超了。
    // ⇒ 求值把**两个正交的东西分开报**（`level` 只由已知金额算、
    //   `confidence` 由"不知道几条"算），再用一条规则接起来：
    //   **`confidence !== 'exact'` 时 `action` 永远不许是 `none`**。
    //   本组 20 例里有 7 处变异被逐条咬住（`M1`..`M7`）。
    //
    // ★ 并且它刻意**不**读模型绑定里的 `perRunBudget` 当上限：那是**单次运行**
    //   的天花板，而这里比的是**时间窗内的累计花费**。那个比值算得出来、
    //   通常落在 0..1、看起来完全正常——但它没有意义。
    {
      label: 'budget-alert（F-15：告警与降级 —— "不知道"不许被读成"没事"）',
      files: ['team-hub/budget-alert.test.mjs', 'team-hub/budget-alert-http.test.mjs'],
      cwd: ROOT,
    },
    // F-20 缺口③：能力包安装事实的**持久化**。
    //
    // 这一组存在的理由与 F-15 那组同源，方向相反：F-15 是"记录了却读不出来"，
    // 这一条是"算得出来却存不下去"。`runtime/packs/store.mjs` 的账**纯内存**
    // （它自己第 129 行写着），于是"安装事实"在重启之后什么都不剩——
    // 而 `enabledPacks()` / `installedList()` 正是依赖预检的基线：
    // 基线空了，每个包都会突然报"缺依赖"，而它们其实都装着。
    //
    //   > 一本重启即失忆的账，与一本从来没有写过的账，
    //   > 在"现在装了什么"这个问题上是同一个回答。
    //
    // 两个文件分工：`pack-facts.test.mjs` 钉账本自身的纪律（seq 的 CAS、
    // 只追加、坏账整本拒绝），`pack-facts-http.test.mjs` 钉**跨模块实例**
    // 的重建——而"同一个实例里再读一次永远是对的"，所以后者才是真判据。
    {
      label: 'pack-facts（F-20：安装事实落盘、跨重启重建、可导出给 Git 审阅）',
      files: ['team-hub/pack-facts.test.mjs', 'team-hub/pack-facts-http.test.mjs'],
      cwd: ROOT,
    },
    // F-19 缺口②：冻结的岗位包。
    //
    // 这一组的重心是**冻结这件事能不能被证伪**：
    //   · `runtime/employee/role-pack.test.mjs` 钉"七类版本都固化了"——
    //     缺一类即拒（**不给默认空值**）、承载内容的那四类必须有哈希
    //     （★ 版本号是标签、哈希才是身份）、对账时"版本没变而内容变了"
    //     必须与"版本变了"分成两个码。
    //   · `team-hub/role-pack-store.test.mjs` 钉"冻结之后改不动"：
    //     主键 `(scope, role_pack_id, version)` 让多版本**同时存在**，
    //     同版本同内容幂等、同版本不同内容 409。
    //   · `team-hub/role-pack-http.test.mjs` 钉那个 409 **真的走得到网络上**
    //     ——库里抛 409 与客户端收到 409 之间隔着 `handleRun` 的
    //     `Number(e?.statusCode) || 400`，那层一旦不认识它，调用方就会把
    //     "版本冲突"读成"请求格式不对"，于是永远不去递增版本号。
    {
      label: 'role-pack（F-19：七类版本固化、冻结不可改、对账分两种漂移）',
      files: [
        'runtime/employee/role-pack.test.mjs',
        'team-hub/role-pack-store.test.mjs',
        'team-hub/role-pack-http.test.mjs',
      ],
      cwd: ROOT,
    },
    // F-18 经验图谱 / 摩擦学习。
    //
    // ★ 这一组里最要紧的是**执行面与旧实现的分歧**：
    //   `plugins/src/experience.ts` 从评论**散文**里数信号（正则匹配"打回"、
    //   "退回："这类中文短语）。它有用例、也能跑，但它无法被证伪——
    //   有人改了措辞，分数就变了，而"因为改词变成 0"与"确实没有摩擦"是同一个 0。
    //   新架构里这些信号本来就是结构化的（拒绝是 `run_validations.decision`，
    //   重做是同一任务的第 2 次 attempt），所以 `friction.test.mjs` 里有一条
    //   **结构级**用例断言模块源码中不出现正则字面量。
    // 另一条主线是"缺失的输入是**不知道**、不是 0"——把缺失当 0 求和会得到
    // 一个看起来完全正常的低分，而"数据没到"与"没有摩擦"于是同形。
    {
      label: 'experience（F-18：摩擦只从结构化字段算、草稿不是知识、图只记不推断）',
      files: [
        'runtime/experience/friction.test.mjs',
        'runtime/experience/graph.test.mjs',
        'team-hub/experience-store.test.mjs',
        'team-hub/experience-http.test.mjs',
      ],
      cwd: ROOT,
    },
    // F-21 连接器 / MCP 登记表。
    //
    // spec §4.4：`server/tool 级策略、风险等级、SecretStore 和故障隔离`。
    // 四条主线的判据各自对应一个"看起来能用、其实在撒谎"的写法：
    //   · **未声明的工具必须拒绝**——`if (declared === undefined) return 'allow'`
    //     的含义其实是"只要有人往 MCP server 上加一个工具，它自动获得授权"。
    //   · **风险只能往上抬**，且不认识的能力名/风险等级要**报错**而不是兜底：
    //     兜底成最严看起来安全，实际最坏——整个连接器莫名其妙全要人批，
    //     而没有任何一处报错指出原因是能力名拼错了。
    //   · **故障隔离**：开路必须带截止时间（不带时一次临时故障变永久停用，
    //     而"永久"与"临时"在状态读数上长得一样）；半开只放**一个**探针
    //     （放所有请求过去时，探针这一步本身就在打你正在保护的东西）；
    //     一个连接器失败不牵连别的；`unknown` 健康 ≠ healthy。
    //   · **落盘面**按内容哈希冻结（同版本换内容 = 409），因为连接器声明说的是
    //     "一个外部进程能拿到什么权限"；故障事件**必须点名**连接器。
    // 另外两组结构级用例：`connector-store.test.mjs` ①**从执行面源码里抽**
    // 词表逐字比对（再抄一遍互相核对时，两边一起写错它全绿），
    // `connector-http.test.mjs` ⑤ 断言路由守卫写成**字面量**
    // （正则守卫会悄悄不进平台契约——PRT-507 那个坑）。
    // ★ `target-binding.test.mjs`（2026-09-18）是**跨两半**的那一组：
    //   策略在控制面、连接目标在部署配置，两边在 `bindConnectorTargets` 汇合。
    //   它同时盯三条 fail-closed 拒绝——少了它们，"漏配"与"这个连接器没配"
    //   在读数上同形。
    // ★ `outcome-port.test.mjs`（2026-09-18）是那一组的**反馈面**：
    //   `registry.mjs` 的 `decide()` 读熔断器，而在此之前改它的
    //   `recordOutcome()` **生产调用方是 0 处**——于是判定面接上去会得到一个
    //   **永远合闸**的熔断器。这一套里 ① 是**端到端**的（真调 decide 看跳闸），
    //   ② 钉住"判不出来"是**第三个桶**（折成成功让坏连接器隐身、折成失败冤枉好连接器），
    //   ④ 钉住**永不抛**（宿主兜异常不算数），①a 钉住"探针不回来不许永久卡死"。
    // ★ `decision-port.test.mjs`（2026-09-18）是**判定面**那一半：
    //   把 `registry.decide()` 织进强制面桥的 `decide` 端口。三条最要紧的：
    //   ① 连接器层的 `allow` **不许短路政策门**（取名太像"总开关"，
    //      而它只是"这个连接器允许这个工具"）；② 连接器层的 `ask`
    //      **不许把政策门的 `deny` 降级**成一次"可以被人批准"的调用；
    //   ⑩ 与 `outcome-port`/`registry` 合起来跑一条**闭环**——探针 ask 出去、
    //      结果永远不回来时，靠 `CIRCUIT_COOLDOWN_MS` 那个窗口放一条新的。
    //   ⚠️ 另有一处**两套词汇表**：桥读 `kind`、注册表读 `decision`
    //      （与 `declaredRisk`/`risk` 是同一类）。⑨a 专门用交叉喂**钉住**
    //      "两边都收"这种好心兼容不许出现。
    {
      label: 'connectors（F-21：未声明即拒绝、风险只能上抬、密钥只许引用、熔断的开路与探针**都**有截止时间、反馈面永不抛、判定面取严且永不短路政策门、DSH 公开名逐字镜像）',
      files: [
        'runtime/connectors/registry.test.mjs',
        'runtime/connectors/target-binding.test.mjs',
        'runtime/connectors/outcome-port.test.mjs',
        'runtime/connectors/decision-port.test.mjs',
        // ★ 2026-09-18 第 17 轮：DSH 公开名的镜像 + 命名空间归属。
        //   它是 `registry.mjs` 那条「未声明就拒绝」在生产里**唯一**可达的路径
        //   （判定面靠命名空间归属，而命名空间与"有没有被声明过"无关）。
        //   本套件里 ①a 那一条**对着 DSH 真源码切片求值**对跑 18 组——
        //   少了它，这个镜像只是"读起来很像 DSH"，而"很像"与"逐字等价"
        //   在干净名字上是同一个字符串。
        'runtime/connectors/public-name.test.mjs',
        'team-hub/connector-store.test.mjs',
        'team-hub/connector-http.test.mjs',
      ],
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
      // PRT-253 续批：`RunRequest` 那三个"猜不出来"的必填字段的来源。
      // 本套件同时钉住三层：纯装配（`resolveRunInputs`）、模型绑定的解析链
      // （任务上的岗位 → `(scope, role)` 绑定）、以及**生产入口真的交出了端口**
      // （源级钉子——那个入口有顶层 await，import 不进来）。
      label: 'run-inputs（PRT-253 续批：workspaceId/modelProfileRef/workdir 的来源与接线）',
      files: ['orchestrator/worker/run-inputs.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-214 缺口②：授权身份（`scope` / `taskId` / `cwd`）按 **Run** 生效。
      //
      // 这一套里最要紧的几条都是**成对**的：一个 Run 用甲空间、另一个用乙空间，
      // 断言两边的授权哈希真的不同；再拿"没有覆盖时两边必须相同"作反面控制。
      //
      //   *一个"用进程级身份服务所有 Run"的实现，
      //   与一个"每次 Run 各带各的空间身份"的实现，
      //   在只有一个空间的那些用例里是同一个东西。*
      label: 'run-identity（PRT-214 续：授权身份按 Run 生效，多空间不错标）',
      files: ['runtime/dsh-composition/run-identity.test.mjs'],
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
      label: 'run-record（PRT-705 孤儿进程：PID 会被回收，映像名对不上的一律不动手；'
        + '并含 PRT-009 那半条"峰值读数落盘读得回"——字段分「必须有/可以有」两档，'
        + '"没采到"必须写 null 不许写 0）',
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
      // PRT-253 续批三：**worker 侧**的契约客户端。
      //
      // 它经 `executor.mjs` **既有的 `adapterFactory` 注入点**接入——执行逻辑一行未改。
      // 不编默认 URL、不编空 token：本地绑定优先；两条都不通时 `EXECUTOR_HOST_PORT_REQUIRED`
      // **一字未改**（既有套件钉着它，本批不放松那条拒绝）。
      label: 'runtime-contract-client（PRT-253：worker 侧的契约客户端，缺配置时老读数不变）',
      files: ['orchestrator/worker/runtime-contract-client.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-253 续批三：★ **两个真进程**之间的读数。
      //
      // 这是本批存在的理由。在此之前，"绑定生效"是在**同一个** DSH 进程内读出来的，
      // 而 `product/process-manifest.mjs` 把 `runtime` 与 `orchestrator` 声明成**两个进程**
      // ——于是那条读数证明的是"一个进程内通"，而部署要求的是"两个进程之间通"。
      //
      //   > 一个"在一个进程里绑好了"的绑定，
      //   > 与一个"从来没绑过"的绑定，在**消费它的那个进程**里是同一个读数。
      //
      // 判据：本测试进程 `resetDshRuntimeBinding()` 之后**没有任何本地绑定**，
      // 经**产品自己的入口** `productionExecutorProviderFromEnv` 拿到引擎；
      // `execute` 真的进了另一个进程（对端打印 `START-RUN-CALLED`，
      // **不是**靠"返回了 completed"推断——一个把请求丢进虚空却仍回 completed 的替身
      // 也会让后者变绿）。八种处境逐条给出**两两不同形**的读数。
      //
      // ★ 安全形状：真 `dsh` 子进程吃自己的一次性 `DSH_HOME`（tmpdir 下、spawn 前断言）、
      //   `bundles: []`、`patchReload: 'startup'`、删 `DSH_SNAPSHOT`、spawnSync 超时、
      //   跑完整棵删；监听器一律 **port 0**（绝不占固定端口——操作者机器上有真服务）；
      //   令牌值不出现在任何一侧的可读输出里（有反向锚用例）。
      //   需要 DSH_CHECKOUT 的那几条逐条 `t.skip()`，缺席时不伪造通过。
      label: 'runtime-contract-cross-process（PRT-253：worker 跨进程拿到引擎，逐条对照可分）',
      files: ['orchestrator/worker/runtime-contract-cross-process.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-009 `peak-resource` 的**每 Run 窗口**（worker 侧那一半）。
      //
      // ★★ 这一条是 2026-09-18 补登记的，而它记的正是本仓最那类缺陷：
      //    `e0b83af` 把这个套件文件提交了，**却没把它登记进任何套件**——
      //    于是 21 条断言一次都不会跑，而 CI 摘要上看不出任何异常。
      //    发现它靠的不是谁去读代码，是 `stageTest` 里那道
      //    **套件清单完备性**门禁：
      //
      //      FAIL 套件清单不完备：1 个 *.test.mjs 不会被任何套件执行（等于不存在的断言）
      //        orchestrator/worker/run-peak-resource.test.mjs
      //
      //    > 「写了一个用例」与「那个用例会被执行」，在 `git log` 上是同一件事。
      //    > 前者只留下一行记录，后者才留下一条判据——
      //    > 而两者在提交信息里长得一样。
      //
      //    ⚠️ 登记时**不要**把它并进 `runtime-contract-cross-process` 那一行：
      //    两件事的失败面不同（一个是跨进程契约，一个是资源采样），
      //    合并之后一次失败会同时指向两个套件名，排障时反而多一层猜测。
      label: 'run-peak-resource（PRT-009：每 Run 一个窗口，采的是另一个进程——先认端点再信 pid）',
      files: ['orchestrator/worker/run-peak-resource.test.mjs'],
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
      // PRT-409（右半部分）：上下文快照的**导出**——自验证，且**离线**可验。
      //
      // spec line 897：「`PRT-409`：持久化快照并支持查看和导出。」
      //
      // ★ 本组盯的不是"导出的字段对不对"，而是**两个哈希的分工**。
      //   快照自带 `snapshotHash`，盖住冻结下来的正文；导出文件还有一层**封皮**
      //   （从哪个 attempt 导的、谁导的、什么时候导的）：
      //
      //     > 一个"正文哈希在导出里验得过、而封皮没有任何哈希"的导出，
      //     > 与一个"谁都能把 attemptId 换成另一个 Attempt"的导出，是同一个东西——
      //     > 只不过前者看起来是可验证的。
      //
      //   把封皮里的 attemptId 改掉、正文一字不动，单哈希验证**照样通过**，
      //   于是一份指着错误 Attempt 的文件"验过了"。对审计来说这比没有导出更坏：
      //   它是一份**盖过章的错证据**。
      //
      // ★ 为什么离线验证要**另起进程**：一份"要连回那台服务器才能验证"的导出，
      //   不是导出，是截图。在同一个进程里"不碰库"是自我承诺；
      //   另起一个没有库、连数据库路径都没传的 node 进程去验，才是一个事实。
      //
      // ★ 本组自己也踩到两处，都已修（细节见文件头与 probe 汇总）：
      //   ① 导出哈希的覆盖范围第一版写的是"列举 {envelope, snapshot}"，
      //      于是顶层冗余的 snapshotHash **不在覆盖范围内**；而 `ok` 又把 findings
      //      算了进去，于是那条用例照样绿——**两条防线里有一条从没被执行过**：
      //         > 一个"两条互相覆盖、于是谁都可以不存在"的实现，
      //         > 与一个"只有一条、而它是好的"实现，在用例上看起来一模一样。
      //   ② 路由的缺参校验与构建器的缺参校验是**两层、同状态码、不同理由**，
      //      只断言状态码分辨不出是哪一层拦下的——于是路由那一层可以整层不存在
      //      而用例全绿。（本项目**第二次**踩到同一形状，PRT-412 是第一次。）
      label: 'context-export（PRT-409 右半部分：快照导出的两哈希分工与离线验证）',
      files: ['team-hub/context-export.test.mjs'],
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
      // PRT-406 收尾：**逐条**区分"系统内容"与"外部内容"。
      //
      // 这一组补的是进度行里自己写下的那条未交付：
      // 「没有产品侧调用点去传 skillTrust/documentTrust，运维安装的 skill
      //   目前也被当外部内容」。保守不假，但它是靠**根本没有"运维安装"这条路**
      // 换来的——`origin` 字段此前在库里不存在，两类来源在数据上本来就分不开。
      //
      //   > 一个"因为分不开所以一律按外部内容处理"的系统，
      //   > 与一个"压根没打算区分"的系统，在每一条内容都来自成员时
      //   > 是同一个东西——只不过前者会让那个缺口看起来像一次**安全取舍**。
      //
      // 本组必须**起真 hub**：要验的是"客户端改不动 origin"，而边界落在
      // 真实写入路径上（INSERT 语句、ensureColumn 默认值、路由读不读 body）。
      // 在假 store 上验这件事，等于验了一个从没执行过的 INSERT。
      //
      // ★ 其中一条钉的是本批**真的踩过**的坑：`trustForOrigin`（origin → 可信性）
      // 被当成逐条判定函数（条目 → 可信性）传下去时**不抛错**，
      // 只是每条都落到 untrusted——方向还在安全一侧，所以只有**肯定性**
      // 断言（"某些条目**是** trusted"）能发现它。
      label: 'context-prt406-trust（PRT-406 收尾：运维/成员来源逐条区分 + 显式文档数据面）',
      files: ['team-hub/context-prt406-trust.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-710 收尾：**启动失败时自动出诊断包**。
      //
      // 补的是 `--diagnostics=<dir>` 之外的那一步：那条命令要求用户在
      // **产品已经坏掉之后**还想起来、并且能够，手工敲一次。而这一整条
      // 任务的定位就是"诊断包最需要在产品坏掉的时候拿到"。
      //
      //   > 一个"坏掉之后可以手工导出"的诊断包，
      //   > 与一个"坏掉时会自动留下证据"的诊断包，
      //   > 在用户记得去敲那条命令的时候是同一个东西。
      //
      // 自动写盘 = **失败循环里自动写盘**，所以这一组的重心不是"能出包"，
      // 而是三条界：磁盘有界（反复失败留下的包不超过 keep，用真文件系统数）、
      // 只动自己认得的（`diagnostics/` 里别人的东西一个都不删）、
      // 失败不换原因（诊断包出不来时**仍然**报原来的启动失败，且退出码仍是 5）。
      //
      // 第 ③ 条最要紧，因为它的坏形态**看起来像正常工作**：用户读到的第一行
      // 会从"端口被占用"变成一句关于工具的抱怨。
      label: 'auto-export（PRT-710 收尾：启动失败自动留诊断包 + 磁盘上界）',
      files: ['product/diagnostics/auto-export.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-713 收尾：**真实的发送通道 + 同意采集 + Launcher 接线**。
      //
      // 这三条缺口有一个共同点：**它们都不让任何一条用例变红。**
      // 一个注入式 transport 让所有"什么不许发"的用例都能跑绿；
      // 一道"因为没人能提供那个值所以永远拦着"的闸让"没同意就不发"也跑绿；
      // 一个没有生产调用方的模块让全部单测跑绿。
      //
      //   > 一个"所有闸门都被测过、但门后没有路"的心跳，
      //   > 与一个"真的能发出去"的心跳，在测试报告上是同一个读数——
      //   > 只不过前者永远不会因为网络、超时、证书而失败，
      //   > 所以它**也不会**因为那些原因被修好。
      //
      // 网络部分注入的是 `requestImpl`（套接字那一层），URL 解析、超时定时器、
      // 排空响应、状态码判定、不重试这些**全部真的被执行**。
      // 本套件**没有**跑过真实 HTTPS 请求——这是诚实边界。
      label: 'heartbeat-wiring（PRT-713 收尾：真实 https 通道 + 同意记录 + Launcher 接线）',
      files: ['product/heartbeat-wiring.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-709 收尾：**改日志策略的入口**。
      //
      // PRT-709 的正文里有一句自我更正：「`logPolicy` **已**接在产品配置文件的键上……
      // 真正还缺的是**改它们的界面**（用户得手编配置文件）」。
      //
      //   > 一个"改了但没有任何反应"的配置界面，
      //   > 与一个"这个键根本不生效"的配置界面，在用户看来是同一个东西——
      //   > 只不过前者会让他反复改同一个地方。
      //
      // 所以这一层的重心不止"能改"，还有**能看懂现在是什么值、它是谁给的**：
      // `--log-policy` 打印的每一项都带来源。
      label: 'log-policy-cli（PRT-709 收尾：日志策略的查看与修改入口 + provenance）',
      files: ['product/launcher/log-policy-cli.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-707 收尾：**把向导接上一个真的界面**。
      //
      // 本行正文里最大的一条诚实边界是「向导是状态机……但**没有任何 UI 或 CLI
      // 子命令在用它**」。这一批把它接到 CLI 上（**CLI 仍然是终端**，
      // 所以"不打开终端"那一条没有被消灭——这一点留在诚实边界里）。
      //
      // 本套件的重心是三个"看起来一样、其实不一样"：
      //   ① 读不到输入 ≠ 空回答（前者会让向导带着空密钥走到 verify，
      //      报"模型不可用"，而那时用户已经没有地方可以填密钥了）；
      //   ② 没问过 ≠ 用户拒绝（两者都不写同意记录，但要修的地方完全不同）；
      //   ③ 可选步骤 ≠ 必答题。
      label: 'wizard-cli（PRT-707 收尾：向导的 CLI 驱动 + 可选步骤 + 同意采集点）',
      files: ['product/launcher/wizard-cli.test.mjs'],
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
      files: [
        'product/launcher/tray.test.mjs',
        // ★ 同一条线的另一头：上面那套只证"托盘自己的判据对"（菜单可用性、
        //   退出必须被确认），而这套证"**它真的被接上了**"——`tray.mjs` 此前
        //   只被自己的用例引用过，也就意味着**没有任何东西在启动路径上碰它**。
        //
        //    这套钉的是接线层那一处最容易写错、且写错了在正常机器上**看不出**
        //    的地方：`launcher.status().processes[].url` 是**启动计划**里算好的
        //    字符串（`process-manifest.mjs` 在任何 spawn 之前就拼好了），不是一次
        //    观测。两种写法在产品从未换过端口的那台机器上给出同一个地址、跑出
        //    同一片绿——差别只出现在那一行**没就绪**的时候：计划写法会把一个
        //    "应该有"的地址交给浏览器，用户看到"浏览器打不开"，而真因在产品这边。
        //
        //    接线的口径是：只有 `state === 'ready'` **且** `readiness.code`
        //    是生产方导出的那个"真的量过并过了"的码，才交出地址；否则 `null`
        //    →「打开 Workbench」灰掉并说明理由（fail-closed）。
        //
        //    ★ 本套件此前如实记着一条边界：这里**不产生原生托盘图标**
        //      （零依赖 Node 画不了）。**那条边界已经被下一套件消掉。**
        'product/launcher/tray-wiring.test.mjs',
        // ★★ PRT-708 的另一半：**真的把图标画出来**。
        //
        //   上一套的诚实边界是「零依赖 Node 拿不到原生托盘 API，真实实现需要
        //   一个原生模块**或平台脚本**」——**或者平台脚本那一半从来没做过**。
        //   本套件做的是后者：生成一个 PowerShell 宿主，用平台上**随系统发货**
        //   的 WinForms `NotifyIcon` 把图标挂上去。零第三方依赖、零原生模块。
        //
        //   ★ 菜单来自模型这件事是**构造性**的，不是靠断言维持的：
        //     菜单写在一个**单独的 JSON** 里（`tray-menu.json`），生成物只负责读它。
        //     于是「换一份菜单模型」时**生成物逐字节相同**——脚本里既没有菜单文案
        //     也没有动作 id（独立复核：11/11，含这一条）。
        //     *一份「脚本里也写了一遍菜单」的实现，与一份「菜单来自模型」的实现，
        //     在两边今天恰好一样的那些运行里是同一个东西。*
        //
        //   ★ 本机实测（真宿主，带外判据）：解析到的是随 Windows 发货的
        //     PowerShell 5.1（`pwsh` 不在 PATH、PW7 未安装，前 19 个候选全不存在），
        //     `process.kill(pid,0)` 与 `tasklist` 都确认那个 PID 真的是活进程；
        //     `stop()` 之后两者都确认它没了。生成的脚本里 `Dispose()` 在 `exited`
        //     之前——**顺序本身是判据**（先摘图标，再报收工；反过来就是幽灵图标）。
        //
        //   ★ 条件语义：解析不到任何一档 shell（非 win32 / 无 shell 的机器）时，
        //     真宿主那几条逐条 SKIP 并写明理由，不伪造通过。约 14 秒。
        'product/launcher/tray-icon.test.mjs',
      ],
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
      // PRT-509 路线 A′：`$DSH_HOME/.credentials.yaml` 的**只读**回退来源。
      //
      // ★ 这一套的价值有一半在它的第 ⑥ 组：把同一批夹具喂给 **DSH 自己的**
      //   `parseCredentialsDocument`，断言两边在"接受/拒绝"上一致，并逐条钉住
      //   一份"我们更严"的清单（DSH 接受、我们拒绝）。
      //
      //   没有那一组的话，"手写的子集读取器"与"真的读懂了 DSH 的格式"在
      //   用例上是同一个读数——只不过前者会在 DSH 换个写法的第二天，
      //   安静地把一份凭证文件读错或者整份读不出来。
      //
      //   未设 `DSH_CHECKOUT` 时 ⑥ 组逐条 skip（并留下跳过的条数），
      //   跑不了不算跑过。
      label: 'dsh-credentials（PRT-509 A′：只读子集读取器 + 与 DSH 真解析器的交叉核对）',
      files: ['security/secrets/dsh-credentials.test.mjs'],
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
      // PRT-509 缺口 ③ 的**真进程**那一半：真 `apps/cli` 入口 + 真 profile +
      // 真 `--patch` 覆盖层 + 真 `dsh-credentials-local`，起点是 Legion 材料化的
      // 那份 `.credentials.yaml`，读数由挂进那棵树的探针插件写回。
      //
      // ★ 它与 `run-credential-materialization.test.mjs` 里那条 ★★★★★ 是**两件事**，
      //   缺一不可：那条是**进程内**手工 `new Context()` 去问 DSH 的提供方类，
      //   它绕过了 profile 装载与启动顺序——而"我们指过去了"与"它读到了"之间的
      //   那一截恰好就在那里（覆盖层按 id 没命中时 DSH 是 warn-and-skip，
      //   而"文件写好了、覆盖层也写好了"在那种情况下逐字成立）。
      //   判据里有 `source === 'file'`：值从继承的环境变量里来也算绿的话，
      //   这条用例就答不出"文件到底有没有被读"。
      //
      // 未设 `DSH_CHECKOUT` 或缺 CLI 构建产物时**整条 skip**（并说明原因）；
      // 起一个真宿主约 25s，超时 120s。
      label: 'run-credential-dsh-process（PRT-509 缺口 ③：真 DSH 进程启动期从材料化文件读到值）',
      files: ['product/launcher/run-credential-dsh-process.test.mjs'],
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
      // PRT-507 的**界面状态**那一层。与上面两组是不同的问题：
      //   · model-settings 守「没探测过 ≠ 探测失败」（一条判定的渲染）；
      //   · 这一组守「**读不出来 ≠ 是空的**」（一次异步读取的三态）。
      // 后者更危险一点：空状态是**可操作**的——用户会照着"你还没有任何凭证"
      // 重新录入钥匙，而真相是密钥库打不开，录进去的每一次都会失败。
      // 同组还钉住：503 的线上形状里根本没有 `unavailable` 字段（只能按状态码分类）、
      // 删除的 `removed:false` 是幂等不是失败、以及岗位解析链的字段名适配。
      label: 'model-settings-ui（PRT-507：读不出来 ≠ 是空的 / 503 没有 unavailable 字段 / 幂等 ≠ 失败）',
      files: ['workbench/scripts/model-settings-ui.test.mjs'],
      cwd: ROOT,
      nodeArgs: ['--experimental-strip-types'],
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
      // PRT-413 收尾：字节级 BPE 与产物装载。
      //
      // 这一组守的是"**精确**必须真的是精确的"。本仓库拿不到任何供应商词表，
      // 所以用一份**自己手算得出来**的极小词表验证算法本身：
      // `hello` → `hell` + `o` = 2 个 token。如果这里只用"不抛错""返回正数"，
      // 那么这份实现与一个 `count = () => 1` 的桩在用例上是分不开的。
      label: 'context-bpe（PRT-413：BPE 切分与手算一致 / 未覆盖时给上界 / 坏产物一律拒绝）',
      files: ['runtime/context/bpe.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-413 收尾：**接线**。前一组证明编码器算得对，这一组证明它接上了。
      //
      // 「模块写好、用例全绿、没人调用」与「功能不存在」在用户看来完全一样
      // （本项目在 PRT-504 上栽过一次）。所以这里起一个**真的 team-hub**，
      // 走真的 HTTP 路由，并在 import 前设 `LEGION_TOKENIZER_DIR` 观察差别：
      // 没配 → 估算；配了 → **同一个路由**给出 `kind: exact` 且 token 数是那份词表算的。
      label: 'context-tokenizer-wiring（PRT-413：配了词表就真的用上 / 精确值不许在摘要里说"约"）',
      files: ['runtime/context/tokenizer-registry-wiring.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-402：TeamPlan 与 EmployeeManifest 的数据面。
      //
      // 它守的是"那两条来源到底存不存在"这件事本身——在此之前的实情是：
      // `sources.mjs` 的两个来源函数都做全了、都是 `required: true`，
      // 而 hub 没有读端点，于是**每次运行**都产出两条 `missing` 候选。
      //
      //   > 一个"每次运行都缺两条必需来源"的产品，
      //   > 与一个"这次运行确实没有团队计划"的运行，在快照上长得一模一样——
      //   > 只不过前者的那两条缺失**永远**不会消失，于是没有人会去看它们。
      label: 'context-plan-store（PRT-402：计划冻结不可改写 / 岗位清单 version 服务端递增 / 明文密钥 fail closed）',
      files: ['team-hub/context-plan-store.test.mjs'],
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
      // PRT-214：approval answerer 插件 × 真 cordis 的 `approval/request` 瀑布。
      //
      // 驱动的是 DSH `ApprovalService.decide()` 里那一行**原样的**派发：
      //   `ctx.waterfall(target, 'approval/request', req, () => 'unavailable')`
      // 并额外做一条**源码契约检查**（直接读 DSH 的源文件），确认事件名、
      // 兜底值、以及"`'never'` 在派发之前就决定"这三件事没变。
      //
      //   *一个"对着自己抄下来的契约"测的用例，
      //   与一个"对着真契约"测的用例，在别人改契约那天是同一个东西——
      //   只不过前者一直是绿的。*
      //
      // 这一套的 ★★★★★ 用例是被**断验证逼出来**的：我第一版把"没有投影就 next()"
      // 测成"结局 == unavailable"，而把它改成"抢答再答不上来"**照样是绿的**——
      // 因为 DSH 的兜底值也是 unavailable。要区分它们，必须有**一个下游答主在场**。
      //
      // 条件套件：需要 DSH_CHECKOUT，逐条 SKIP（不伪造通过）。
      label: 'approval-answerer（PRT-214：answerer 链 × 真 approval/request 瀑布）',
      files: ['runtime/dsh-composition/approval-answerer.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-214：pre-execute 插件 × 真 DSH ToolRuntime，以及**第一次全链路集成**。
      //
      // 此前两个半边各自被验证过，但**从未连起来**。本套件把这条链在真运行时里
      // 跑通：策略说 `ask` → 投影进登记簿 → answerer 认领 → 审批箱说
      // `allowed-once` → 工具**真的执行**；说 `rejected` → 一次都不执行。
      //
      //   *一个"两个半边各自全绿"的实现，
      //   与一个"两个半边能接上"的实现，在各自的用例里是同一个东西——
      //   只不过前者的失败发生在**生产**里。*
      //
      // 三条 ★ 用例是这一轮实测抓出来的真问题：
      //   ① `ask` 需要 `exec.agent`，否则 DSH 直接拒绝
      //      （`serviceAsk`：no agent to route it through）——
      //      第一版用例没带，于是每个全链路用例都"没通过审批"；
      //   ② 我写的 `approval` 替身**直接回答**，把 answerer 链整条短路了，
      //      全链路却"看起来是绿的"，直到一条断言"审批箱被问过几次"暴露了 0；
      //   ③ 我原来的"装载顺序有讲究"是一句**错误的因果**——断验证把顺序倒过来
      //      全部用例照样绿（两次 `ctx.plugin` 都 `await` 到底，没有窗口）。
      label: 'pre-execute（PRT-214：策略门 × 真 pre-execute 瀑布 + 全链路集成）',
      files: ['runtime/dsh-composition/pre-execute.test.mjs'],
      cwd: ROOT,
    },
    {
      // ★★ F-21 **第二半**（2026-09-18）：把 `tools/result` 接到连接器熔断器的
      //    反馈面。这一行与 pre-execute 那一行的分工必须**在套件层面**也看得出：
      //
      //      pre-execute 订的是 `tools/pre-execute`（水瀑，`(exec, next)`，**判定**）
      //      本行        订的是 `tools/result`      （emit，`(exec, result)`，**观测**）
      //
      //    ★ 写成水瀑签名（带 `next`）时 `next` 是 `undefined`，每次结果都抛；
      //      而 DSH 契约承诺**兜住** listener 的异常 ⇒ 什么都记不上、什么都不报。
      //      所以 ①a 是**结构级**的：它直接盯签名。
      //
      //    ★ 卸载（③）不是洁癖：留着第二个监听器会让失败被记**两遍**，
      //      而熔断阈值是 3 ⇒ **两次**真失败就跳闸。慢一倍地跳闸与快一倍地
      //      跳闸，在"它拦住了一次该拦的调用"上看不出来。
      label: 'connector-feedback（F-21 第二半：tools/result 只观测不判定，且卸载真的卸掉）',
      files: ['runtime/dsh-composition/plugins/connector-feedback.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-214：员工 agent preset（spec §6.9 的 **agent 平面**那一半）。
      //
      // 它的失败模式与强制面**不同**：强制面坏掉是"该拦的没拦"，
      // 员工 preset 坏掉是"该有的工具没有"——后者**不报错**。
      //
      //   *一个"清单给了权限、preset 没给工具"的 preset，
      //   与一个"这个岗位本来就没有这个权限"的 preset，在模型那里是同一个东西——
      //   只不过前者会让一次本该成功的工作变成一句"我做不到"。*
      //
      // 所以本套件守三件事：① 工具行由**授权推导**、每一项都要有交代；
      // ② 覆盖不到的工具**失败**而不是 warn；③ 永不携带强制面、
      // 永不写随部署分发的 preset 目录。
      //
      // 需要 DSH_CHECKOUT 的只有"真 loader 解析"与"包真的装了"那几条，
      // 纯渲染逻辑照常跑；缺 DSH 时逐条 SKIP（不伪造通过）。
      label: 'employee-preset（PRT-214：员工 agent preset 渲染 × 授权覆盖）',
      files: [
        'runtime/dsh-composition/employee-preset.test.mjs',
        // ★ 同一条线的另一头：上面那套只证"**解析得进去**"（真 loader 读 YAML +
        //   每一行都指向装了的包），这套证"**挂得上**"——真 DSH 子进程里问
        //   DSH 自己 roster 服务的 `standingKeyFor(id)` —— 那才是"这一份组合
        //   真的能被挂起来"，而不只是"文本能被读成节点"。
        //   这里刻意**不写**那个服务在 DSH 里的访问路径记号：它是 DSH 执行面，
        //   写进 `scripts/` 会被 PRT-108 边界闸判成执行面泄漏（确实被它拦过）。
        //
        //   *一个"能被解析器读进去"的 preset，与一个"能真的挂上"的 preset，
        //   在渲染器的用例里是同一个东西——只不过前者的用例是绿的，
        //   而它从未被任何 mount 读过。*
        //
        //   ★ 这套第一次跑，抓到的就是缺口本身：渲染器把 tool-fs-search 渲染成
        //   **不带 config**，而那一行的 `sampleOverCapGlobResults` 是必填、
        //   兜底只在宿主行上（preset 行不继承）——于是"发现层判健康、挂载层具名
        //   拒绝"，而**每一个授权了 read-file 的员工 preset 都挂不上**。
        //   渲染器已修（表里声明 + 渲染器透传），这套随之从"记录缺口"翻成
        //   **回归哨兵**：断言的个数也跟着从四种拒绝降到三种——*一条"四种拒绝
        //   两两不同"的断言，在只剩三种时会红，那不是它坏了，是它如实地说
        //   "我守的那个局面已经变了"。*
        //
        //   条件套件：需要 DSH_CHECKOUT，逐条 SKIP（不伪造通过）。
        'runtime/dsh-composition/employee-preset-mount-dsh-process.test.mjs',
      ],
      cwd: ROOT,
    },
    {
      // PRT-214：enforcement 插件模块的**一致性**用例——对着真 DSH 运行时。
      //
      // 测的全部是**别人的契约**：`ctx.tools.guard()` 是不是真同步、真单调
      // （DSH 原文："no guard can force-allow a call another guard denied"）、
      // guard 返回 string 会不会真变成一次 deny、卸载插件后 guard 还在不在。
      //
      //   *一个用替身喂出来的"强制面已生效"，
      //   与一个从没被真运行时拦下过的"强制面已生效"，是同一个东西——
      //   只不过前者的用例数是完整的。*
      //
      // 这一步实测抓到两个我自己的错：`ToolRuntime` 有
      // `static inject = ['systemPrompt']`（不提供就挂载但不激活），
      // 以及 Cordis **不允许**不声明 inject 就按属性访问服务
      // （`cannot get property "tools" without inject`）。
      //
      // 条件套件：需要 DSH_CHECKOUT，逐条 SKIP（不伪造通过）。
      label: 'enforcement-plugin（PRT-214：enforcement 插件模块 × 真 DSH 运行时）',
      files: ['runtime/dsh-composition/enforcement-plugin.test.mjs'],
      cwd: ROOT,
    },
    {
      // ★★★ 台账上三行长期卡着的那半句话，在这一套里变成了一条能跑的读数：
      //
      //   > 没有真引擎跑完过真任务；没有任何真 DSH 进程执行过工具调用。
      //
      // 在此之前，仓库里所有"工具被调用过"的读数都来自形状检查、进程内假想、
      // 或对日志文本的字符串匹配。这一套起一个**真的 DSH 子进程**
      // （`--profile headless`，一次性 `os.tmpdir()` home，无凭证、无网络、
      // 无监听端口），让它真的派发一次 `pwsh`，然后**不看它说了什么，
      // 只看磁盘上多了什么**。
      //
      //   一个"日志里出现了 tool/call"的判据，
      //   与一个"工具真的跑过"的判据，
      //   在模型本来就会调工具的那些运行里给出同一片绿——
      //   只不过前者的绿，在工具被拒绝、被沙箱挡住、或压根没派发出去时也是绿的。
      //
      // 承重的是**带外副作用**：子进程 cwd 下那个 sentinel 文件的字节必须等于
      // **测试进程** mint 的随机 token，而那个只供应模型流的桩
      // **不 import 任何文件系统模块**（第三条用例逐条读桩的源码）。
      // 一个没有文件系统能力的模块，写不出一个只有真 `pwsh` 进程才写得出的文件。
      //
      // ★ 负对照是同一条命令**逐字节**减去模型接缝那两块（被机器核对过），
      //   落回 shipped 路由 → exit 1 + `MISSING_CREDENTIAL` + **0 条 tool/call**。
      //   没有这一条，"它跑通了"也可能是因为工具有别的理由跑起来了。
      //
      // 条件套件：需要 DSH_CHECKOUT，逐条 SKIP（不伪造通过）。
      // 另有一条平台闸：工具面是 `pwsh`（posix 上 `dsh-base` 换 `tool-bash`），
      // 而 posix 分支**从未被观测过**，所以在非 win32 上逐条 SKIP 并写明原因，
      // 而不是把一条没跑过的路径放进 CI 赌它是绿的。
      label: 'headless-real-tool（真 DSH 进程 × 真工具执行：带外副作用 + 负对照）',
      files: ['runtime/dsh-composition/headless-real-tool.test.mjs'],
      cwd: ROOT,
    },
    {
      // ★★★ PRT-212 的诚实边界是这句：「还没有任何一个真 DSH 进程，通过审批口
      // 执行过一次工具调用。」而更要紧的是下一句：Legion 的**强制层从未被证明
      // 能在一个真进程里真的拦住一次真工具调用**。这一套补的是后一截。
      //
      //   一条"日志里写着 denied"的断言，
      //   与一条"工具真的没跑起来"的断言，
      //   在拒绝真的生效的那些运行里给出同一片绿——
      //   只不过前者的绿，在一个把拒绝记进日志、却照样放行的钩子上也是绿的。
      //
      // 所以承重断言是**带外副作用**：那条命令若真被执行，文件必然出现；
      // **只有它不出现，才等于"工具没有执行"**，其余都是归因。
      //
      // ★ 这一套还独立读出了那个很难看的当前事实：`DEFAULT_HARD_FLOOR` 是**空的**
      //   （`enforcement.mjs:32-35`），而 `legion-host.patch.yml` 里
      //   `legion-enforcement-hard-floor` 那一行**也没有带 config**——
      //   也就是说**按今天这份补丁文件原样跑，这个下限一条规则都不拦**。
      //
      //     *一个"挂上去了、但规则集为空"的下限，
      //     与一个"从未挂上去"的下限，在真进程里给出同一个读数——
      //     只不过前者在组合树里看得见。*
      //
      //   所以这一套用一层**测试自己的** overlay 把规则喂给那一行，并在文件头
      //   写明这是本套件声明的、不是 shipped 补丁里的；被禁前缀刻意选在
      //   **工作区之内**（对照能写、且真的写成功），否则"哨兵不存在"既可能来自
      //   DSH 的沙箱、也可能来自 Legion 的下限，两条读数长得一样，实验就是空的。
      //
      // 条件套件：需要 DSH_CHECKOUT，逐条 SKIP（不伪造通过）。
      label: 'enforcement-real-process（PRT-212：真进程里 Legion 下限真的拦住了真工具）',
      files: ['runtime/dsh-composition/enforcement-real-process.test.mjs'],
      cwd: ROOT,
    },
    {
      // ★★★ PRT-211 / PRT-212：审批口在**真 DSH 进程**里响了三侧，而且本机跑得通。
      //
      // 手法是 `--profile acp`——DSH 那个 "automation-only JSON-RPC stdio" 面
      // （**一行一条 JSON**，没有 Content-Length 头）。它不可能被折成一次 `input`：
      // `session/new` 返回服务端随机 UUID，`session/prompt` 要带着它，
      // 而中途服务端还会**反向**发一条 `session/request_permission` 要现场作答。
      // 所以这一套用 `spawn` + 自己的对话循环。
      //
      //   ALLOW   perm=2 sentinel1=1 sentinel3=1   ← 批准 → 真的执行
      //   REJECT  perm=1 sentinel1=0 sentinel3=1   ← 拒绝 → 没执行，且**同进程对照真的跑了**
      //   NEVER   perm=0 asked=1 decided=rejected  ← 闸被咨询了，而审批口**一次都没响**
      //
      // ★ 最后一行是本套件最要紧的判别：*一条"审批没通过"的断言，与一条"审批口根本
      //   没被问过"的断言，在"工具没跑起来"这个读数上是同一个东西*——现在它由
      //   断言分开，而不是靠散文。
      //
      // ★ 前提纠正（本批实测推翻了一个过重的推论）：DSH 自己的 sandbox 升级 e2e
      //   在本机**永远 skip**（`hasRunner = hasBwrap || hasSeatbelt`，而 Windows 两样都没有），
      //   因为那条用例需要**先真的被拒一次**。但**审批口本身**不需要沙箱运行器：
      //   `packages/sandbox/sandbox/src/escalation.ts:162` 比的是**这一次调用的有效模式**
      //   （per-call truth），只要请求比它更宽且带上 `sandbox_permissions` 就会走到 `:173` 的审批口。
      //
      // ★ 层不同：本套件驱动的是**外部客户端会话面**；而
      //   `runtime/adapters/dsh/session-boundary.mjs` 审计的主要是**进程内 父↔continuable 子**
      //   那个面（`subagents.startContinuable` 等）。该面由**下一个**套件驱动，
      //   本套件**不翻转那个文件里的任何 `behaviorVerified`**。
      //
      // ★ 前提再纠正（后一批实测又推翻了这里原来的一句话）：这里原先写的是
      //   「一次性 acp 进程**没有父 agent**，所以那个面驱动不了」。**前半句按字面是错的**：
      //   ACP 的 `session/new` 逐字调用 DSH 侧的 **agents 服务**（`packages/acp/acp/src/session.ts:128`），
      //   进程里有一个活的**根** agent。精确的说法是它**不拥有任何 continuable 子会话**，
      //   而那不是阻碍——下一个套件自己现造一个父 agent 就把整个面驱动起来了。
      //
      // ★ 写这条注释时又踩了那个坑（本会话第三次）：`scripts/ci/dsh-boundary.mjs`
      //   扫的是文件**文本**里的执行面记号，**注释里的也算**。第一版在这里写出了
      //   那两个记号（"会话服务"与"agent 服务"的点号形式），闸当场红，
      //   报的是 `[new-file]` + 「实际 2，允许 0 —— 文件不在基线中，却出现 DSH 执行面记号」。
      //   第二版我把那句报错**照抄**进了注释，于是那个记号又被数了一次——**还是红**。
      //
      //   ——一条文本扫描分不出「注释里提了一句」与「真的依赖它」，
      //   也分不出「这是一句报错」与「这是一处依赖」。
      //   所以这里改成散文描述，连报错也不照抄。
      //
      //     一个"这个进程里没有那个角色"的读数，
      //     与一个"那个角色提供的服务不存在"的读数，
      //     在没人问过那个服务的时候是同一个东西——
      //     只不过前者说的是角色，而后者说的是能力。
      //
      // 条件套件：需要 DSH_CHECKOUT，逐条 SKIP（不伪造通过）。
      label: 'session-boundary-real-process（PRT-211/212：真进程里的续接、cwd 前置条件与审批口三侧）',
      files: ['runtime/dsh-composition/session-boundary-real-process.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-211：**进程内 父↔continuable 子** 那个面。
      //
      // `session-boundary.mjs` 的 `DSH_CONTINUABLE_SURFACE` 是 15 条，是一个
      // **静态源码锚点审计**（`:70` / `:436` 逐字写着 `behaviorVerified: false`）。
      // 本套件是**另一层**：真进程、真派生、真投递、真打断、真释放。
      // 它不改那个文件一个字，也不翻转它的任何一面——用例里断言
      // `DSH_CONTINUABLE_SURFACE.length === 15` 就是"本层没动上一层"的读数。
      //
      // ★ 本套件最要紧的读数（都是"只有跑起来才看得见"的那一类）：
      //   · `startContinuable` 真的建立了一个 durable 子会话，且 `childId` **跨
      //     Activation 稳定**——一个已释放的 Activation 之后，同一个 id 又被
      //     冷启动跑出下一轮。前提同时成立（投递那刻目标不在册）才说明是冷恢复。
      //   · `sendMessage` 的送达判据落在**孩子自己那一轮**的模型流上（带着父级 mint
      //     的 token），不是返回值。*一条"sendMessage 返回了 MessageId"的断言，
      //     与一条"那个孩子真的收到了"的断言，在投递失败时前半句也是绿的。*
      //   · 打断分得开"被干净打断"与"进程死了"：挂起的那条流**观察到 abort**，
      //     孩子自己的 durable 日志以 `turn/end {"kind":"aborted"}` 收尾，
      //     读数落盘之后再问 ACP 一次仍能开新会话。
      //
      // ★ 冷恢复 ≠ 续跑：那是**重建会话再开一轮**，不是把中断的执行接着跑完。
      //   "编排器必须自己持久化进度"这条结论不变，但理由变了。
      //
      // 条件套件：需要 DSH_CHECKOUT，逐条 SKIP（不伪造通过）。
      label: 'subagents-surface-real-process（PRT-211：真进程里派生/投递/打断/释放一个 continuable 子会话）',
      files: ['runtime/dsh-composition/subagents-surface-real-process.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-214：补丁文档的**形状**与 YAML 生成器（不连 DSH）。
      //
      // 为什么值得单独一套：补丁层的落盘形式此前是一个**自由格式的散文文件**，
      // 而 DSH 对它的要求是硬的——顶层数组、`insert: EntryOptions[]`、
      // 字段名必须在 `PatchOptions` 里。仓库此前的用例只断言
      // 「磁盘上的 YAML == renderPatchYaml()」，也就是**生成物与自己的声明一致**：
      //
      //   *一个"与自己的声明完全一致"的补丁层，
      //   与一个"能被 DSH 加载"的补丁层，在用例上是同一个东西——
      //   只不过前者的用例是绿的，而它从未被任何解析器读过。*
      //
      // 本套件守的是 `patch-format.mjs` 自己的判据，其中最要紧的一条是
      // **每个拒绝码都够得着**：一个写了却永远触发不了的分支，与一个不存在的分支，
      // 在"它到底拦住了什么"上是同一个东西。
      //
      // 真管线那一半在 `patch-loadable.test.mjs`（条件套件，需 DSH_CHECKOUT）。
      label: 'patch-format（PRT-214：补丁文档形状检查与 YAML 生成）',
      files: ['runtime/dsh-composition/patch-format.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-212：把工具调用投影送进 team-hub 审批箱，并把人/策略的决定带回来。
      //
      // 为什么值得单独一套：`createApprovalAnswerer`（阶段期限、`unavailable` vs
      // `rejected`、闭集外的值不当放行）早已写好，`tool-request.mjs` 也早已把
      // 端口留好，`tool-request-bridge.mjs` 甚至已经把投影翻成了完整的 F-02 主体。
      // **三块都在，而中间那条线不存在**——`requestApproval` 在全仓库只有
      // `null`（默认）或测试里的 `async () => 'rejected'`。
      //
      //   *一个"answerer 写得对、端口处处留好、而从来没有人填过它"的审批，
      //   与一个"根本没有审批"的审批，在运行时的表现是同一个东西——
      //   只不过前者的用例是绿的。*
      //
      // ★ 起一个**真的 hub**。这套件里几乎每个判据都取决于**别人写的**东西：
      // 状态串叫什么、判定体放在响应的哪一层、`by` 是不是必填、绑定的哈希对不对得上。
      // 实测抓到三条只有发过请求才知道的：
      //   ① `check` **必填 `by`**（`handleWrite` 先 `requireMember`）——
      //      缺了它 400，而端口会记成"审批箱不可达"，把**参数缺失**报成**基础设施故障**；
      //   ② 判定体在 **`task`** 下面（`{ok:true, task:result}`）不在顶层——
      //      从顶层读永远是 `undefined` → `UNKNOWN_STATUS`；
      //   ③ `approved` 有**两个**来源（策略放行不落行、人批准落在行上有 `decidedBy`）——
      //      一律当策略放行会打出一张自相矛盾的凭据：
      //      `human:false` + `reason:"策略直接放行"` + `decidedBy:"general"`。
      //
      // 还有一条端到端的：**凭据不是装饰**——`ticket.requestId` + 绑定真的能拿去
      // `/api/permissions/check` 消费掉，而换一份参数就必须被拒。
      // *一个"批准了、也返回 allowed-once、而拿回来的票据根本消费不了"的端口，
      // 与一个"什么都没接"的端口，在用户那里都是"我批了，执行时说操作不匹配"。*
      label: 'approval-port（PRT-212：审批端口 → team-hub 审批箱，起真 hub）',
      files: ['team-hub/approval-port.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-214 续：**审批端口注册方**——把工厂注册进 DSH 进程的那一段接线
      // （`team-hub/approval-registrar-row.mjs`，它也是补丁层 root 行的模块）。
      //
      // 这套件盯的是四件此前没有任何判据的事：默认导出**就是**真的 root row 插件
      // 对象（`===`，不是替身）；注册**真的发生**（模块求值期）且"注册了/没注册"
      // 两种读数可分；没有 hub 地址时抛**具名码**而不是造一个永远问不到人的端口；
      // 工厂交出来的是**真端口**（按 `/api/permissions/check` 的协议说话），
      // 并且把 401 翻成 `unavailable`（故障）而**不是** `rejected`（人说不）。
      //
      //   一个"把 401 记成审批箱答了但读不懂"的适配，
      //   与一个"审批箱真的换了状态串"的适配，在屏幕上都是 `UNKNOWN_STATUS`——
      //   只不过前者要值班的人去翻 hub 的鉴权配置，而 prompt 指的是错的那份代码。
      //
      // 假的只有 HTTP 传输（注入 `fetchImpl`）：`hubIo()` → `approvalHubOf()` →
      // `createHubApprovalPort()` 三段全是产品代码。
      label: 'approval-registrar（PRT-214 续：审批端口工厂的注册方与它的错误翻译）',
      files: ['team-hub/approval-registrar-row.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-409 最后一件：上下文快照**查看**界面（spec line 897「支持查看和导出」）。
      //
      // 与其它 `*-ui` 套件同一个形状：界面判定抽进 `workbench/src/snapshotView.ts`
      // 的纯函数里，用 `node --test` 钉住，组件只负责渲染。
      //
      // 本套件盯的三件事都是**可信度**问题，不是排版问题：
      //   ① 验证结论是**三态**（通过 / 哈希对不上 / 未校验）。
      //      "没验过"与"验过了通过"长得一样，等于把一次未经校验的展示
      //      伪装成一次校验过的展示。
      //   ② 三本账（候选/入选/排除/截断/脱敏）必须显式说出来——
      //      一份**截断过的**快照只显示正文时，用户会以为模型读完了全文。
      //   ③ 被清掉的快照是**单独一屏**（hub 给 410 + 墓碑），
      //      不是"无数据"：*一次"这份证据被清掉了"与一次"你查错了 id"，
      //      在屏幕上长得一模一样*。
      //
      // ★ 起一个**真的 hub**：本模块的全部工作就是"拿 hub 给的响应决定显示什么"，
      // 而状态码、字段名、410 的形状、三本账放在哪一层，只能由真 hub 回答。
      // 实测抓到过一件事：`excluded`/`truncations`/`redactions` 住在
      // `snapshot.*` 里，**不在顶层**；从顶层读会永远得到 `[]`，
      // 于是"排除 0"——
      //   *一个"从错误的层级读账本"的界面，与一个"这份快照确实没有排除任何来源"
      //   的界面，长得一模一样，只不过前者会在一次越权过滤之后向用户显示
      //   "来源已完整清点"。*
      label: 'snapshot-view（PRT-409：快照查看界面——验证三态 / 三本账 / 墓碑屏，起真 hub）',
      files: ['workbench/scripts/snapshot-view.test.mjs'],
      cwd: ROOT,
      nodeArgs: ['--experimental-strip-types'],
    },
    {
      // PRT-409 收尾：快照保留策略 + 墓碑。
      //
      // 为什么不能并进 `context-store`：那套问的是"存进去的东西对不对"，
      // 这套问的是"**留下来的东西该不该留**"——两个问题的答案没有任何重叠，
      // 合起来只会让一次为前者写的改动顺手改掉后者的判据。
      //
      // 本套件盯的三件事：
      //   ① **清掉之后必须留墓碑**。`get()` 的 `null` 把"从来没存在过"与
      //      "被策略清掉了"压成了同一个，而这两件事对一次审计的差别就是全部意义。
      //      所以 purged 给 **410** 而不是 404。
      //   ② **默认不销毁任何证据**（显式 `{maxAgeDays:null,maxBytes:null}`）。
      //      一个有上限的默认值会成为一次静默的数据丢失。
      //   ③ **字节不是字符**。快照正文大量是中文，UTF-8 下一个汉字 3 字节；
      //      拿 `.length` 比字节上限在纯英文数据上恰好是对的。
      label: 'context-retention（PRT-409 收尾：保留策略从最旧清起 / 被引用的不删 / 清掉必留墓碑）',
      files: ['team-hub/context-retention.test.mjs'],
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
      // PRT-253 canRead 授权批：**这条缝在现有契约下合不上**，而这一套就是那份判据。
      //
      // 结论是 (B)：per-attempt 授权**确实不跨**那条边界。它判在 **worker** 里，受众是 **hub**
      // （`context-stage.mjs` 的 `createHubContextStage` 把它变成 `POST /api/context-snapshots/
      // assemble` 的 `canReadAll`/`canReadIds`），而 Runtime 进程**只**收到 RunRequest
      // ——`runtime/dsh-composition/enforcement.mjs` 全文对 `canRead` **零命中**。
      //
      // 所以本套用例不是"证明功能生效"，而是**把这条边界钉成一条会响的线**：
      // 谁哪天把读权限字段塞进 RunRequest，这里就红，逼他先回答
      // "同一份授权被评估两次、两次不一致怎么办"。
      //
      // ★ 判据一律是 `deepEqual` 比**完整键集**而不是 `includes`：
      //   *"多加一个字段"正是这里要找的东西，而 `includes` 会漏掉它。*
      label: 'can-read-authorization-boundary（PRT-253：读权限字段真的不跨进程边界）',
      files: ['runtime/dsh-composition/can-read-authorization-boundary.test.mjs'],
      cwd: ROOT,
    },
    {
      // PRT-253 canRead 授权批：worker 侧**授权来源**的可核对的读数。
      //
      // 真 `claim()` 的返回值里没有任何读权限字段（`D-CLAIMED-READAUTH-LOOKING (none)`）——
      // 与上一条合起来说明：边界**两处同时关着**（lease 不带、`defaultRequestFor` 逐字段挑值也不放）。
      // 这是**读数**不是推断：串行造两个变异时，只改 lease 那一侧，`defaultRequestFor`
      // 仍会把授权丢掉。
      label: 'can-read-authorization-source（PRT-253：lease 认领结果里没有读权限字段）',
      files: ['orchestrator/worker/can-read-authorization-source.test.mjs'],
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
      files: [
        'security/secrets/secrets.test.mjs',
        // PRT-509 / spec §6.7（`line 428`）：**在途 Run 的凭证不因轮换而中途替换**。
        //
        // store 的 `rotate()` 上原写着一句「在途 Run 已把凭证解析进进程内」——
        // 而**没有任何对象在做那件事**：store 刻意不缓存，同一个 `get(ref)`
        // 在轮换前后返回两个不同的值。于是那句话把一个**承诺**写成了**事实**。
        //
        //   > 一句"在途 Run 已把凭证解析进进程内"的注释，
        //   > 与一个真的把凭证解析进进程内的机制，
        //   > 在读到那句话的人眼里是同一个东西——
        //   > 只不过前者会在某一次轮换之后，让一个跑到一半的任务换掉手里的钥匙。
        //
        // 本组钉的是那个机制（`run-credentials.mjs`），两个方向都要：
        // 在途 Run 拿旧值、**轮换后新建的 Run 拿新值**。
        //
        // ★ 其中一条是**数数**的：句柄开出来之后 `store.get` 的调用次数必须
        //   一次都不涨。一个"每次都重读"的实现，在轮换还没发生的那些日子里
        //   与"抓了一次"的实现读出**一模一样**的结果——
        //   *一个"抓了一次"的实现，与一个"每次都重读、只是恰好还没轮换"的实现，
        //   在那次轮换到来之前是同一个东西。*
        'security/secrets/run-credentials.test.mjs',
        // PRT-509 写侧：把 Run 的**冻结凭证句柄**写成一份 DSH 真的读得回来的
        // `.credentials.yaml`。此前 Legion 对那个文件只有**读**的一侧，于是
        // "一个解析成功的凭证"与"某个模型客户端能拿到它"之间那一段是空的。
        //
        // ★ 本组最要紧的不是"我把值写进了文件"，而是**那个文件被真实读者读回来了**：
        //   每次落盘之前，先把文档交给 `dsh-credentials.mjs` 的**真实读者**读一遍，
        //   逐条比对名字与值是否逐字相等；证不出来就**不写**（`VERIFICATION_FAILED`）。
        //
        //   *一个"写出去的格式符合我自己以为的格式"的用例，
        //   与一个"真实读者读得回来"的用例，在两边各自单测时是同一片绿——
        //   只不过前者的绿，在读者一改键空间语法的那天照样是绿的。*
        //
        // ★ 结构性原因也在这里被钉住：Legion 的模型引用是 `legion/model/<id>`（**三段**），
        //   而 DSH 的 `records` 只收两段、`refs` 一个斜杠都不收 ⇒ `planDshLookup()`
        //   对它返回 `{addressable:false, space:null}`。所以"持有、但既不可寻址又没映射"
        //   必须是**具名拒绝**而不是跳过——*一个"文件看起来完整、就是少了最要紧那一把钥匙"
        //   的读数，与一个"文件本来就只该有这么多"的读数，在 `cat` 的输出里长得一模一样。*
        'security/secrets/credential-materializer.test.mjs',
      ],
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
        // PRT-257：DSH 强制面覆盖层的**接线**（`--patch` 到底有没有交给 runtime）。
        // 17 条里只有 2 条需要 DSH_CHECKOUT（真 DSH CLI），其余照常跑；
        // 缺检出时那 2 条逐条 `t.skip()`，于是 `skipped: 2` 看得见——
        // 一个"整组被跳过、计数里什么都不显示"的套件，与一个压根不存在的套件，
        // 在"这次到底跑了什么"上是同一个东西。
        'product/launcher/dsh-overlay.test.mjs',
        // PRT-251 续 ④：旧数据接管（安装目录内的 `team.db` → DataDir）。
        //
        // 缺口的形状是"写路径已经指到 DataDir、而 DataDir 里没有数据"，
        // 所以这一组的判据必须落在**两端之间**：计划三态、真 SQLite 快照、
        // 幂等、以及 Launcher 在"该接却没接成"时**拒绝启动**。
        // 其中 ⑥ 用真 WAL 把两条路径并排比一次——那是本模块存在的全部理由。
        'product/launcher/legacy-data-adoption.test.mjs',
        // PRT-509：Run 凭证的**材料化接线**（`launcher.start()` 里那次调用）。
        //
        // 这一条存在的理由与上面那组同源：`openRunCredentials()` 与
        // `materializeRunCredentials()` 两边**各自都有用例、都全绿**，而它们在
        // 生产里的调用方数是 **0**。把 `start()` 里那一段整段删掉时，那个模块
        // 自己的 15 条仍然全绿——因为那一组只测"算得对不对"，不测"有没有人算"。
        //
        //   > 一个"能力齐全、测试全绿、而没有任何生产代码调用它"的模块，
        //   > 与一个不存在的模块，在部署上是同一个东西——只不过前者的报告是绿的。
        //
        // 所以本组钉的是三件**只有真接线才有**的事：`start()` 之后读数不是 null、
        // 盘上真的有一份 `.credentials.yaml`、而那份文件在**产品家目录**下
        // 而不是 operator 的真实 home 里。
        'product/launcher/run-credential-materialization.test.mjs',
        // PRT-509 缺口 B1：ACL 的 **runner 与 owner** 的生产接线。
        //
        // 与上面那条是**同一类**缺口，而且它更隐蔽一点：`security/secrets/acl.mjs`
        // 判据齐全、用例全绿，而 `launcher.mjs` 里 `secretsRun` / `secretsOwner`
        // 两个入参**从来没有生产调用方给过值**（全仓只有"声明"与"传参"两处）。
        // 于是生产上恒为 `ACL_NO_RUNNER` + 「不知道文件所有者」——两条都不拦启动，
        // 于是变成诊断里**永远出现、永远说同一句**的告警。
        //
        //   > 一份"判据齐全、28 条用例全绿、而生产里每次都说'没有 runner'"
        //   > 的访问控制检查，与一份不存在的访问控制检查，在被保护的文件上
        //   > 是同一个东西——只不过它看起来**像查过了**。
        //
        // 本组除了纯函数读数，还包含三条**真 `whoami` + 真 `icacls`** 的用例
        // （inspect → harden → 独立复验）。前一层全绿也可能 runner 根本不在 PATH 上，
        // 而那种情况下生产读数与"没接线"完全一样。
        'product/launcher/secrets-acl-runner.test.mjs',
        // PRT-257 的**另一半**：修复入口（spec `line 275`        // 「禁止自动执行，**提示修复或回滚**」）。
        //
        // `REPAIR_ACTIONS` / `repairPlanFor()` 早在 `runtime/dsh-composition/
        // bootstrap.mjs` 里把逐项修法算了出来，计划也跟着拒绝走到了
        // `refusal.repair`——而 `product/launcher/` 里对前两者的引用次数曾是 **0**。
        //
        //   > 一份"算出来了、也跟着拒绝走了、但没有任何人能照着做"的修复计划，
        //   > 与一份不存在的修复计划，对用户是同一个东西。
        //
        // 本组钉的是那个出口，以及**三个退出码必须分开**：0 全过 / 1 有待修项 /
        // **3 拿不到诊断（不是 0）**。最后那一条是这一组存在的理由：
        // 一个"读不到结论所以什么都没报"的体检，与一个"结论是一切正常"的体检，
        // 在退出码上是同一个东西——而前者会让一个已经坏掉的部署安静地通过门禁。
        // 其中两条把 `repairPlanFor()` 的**真产物**喂进本模块，钉住两处对
        // "计划形状"的理解一致（自己造一份计划喂给自己 = 没接上生产）。
        'product/launcher/doctor.test.mjs',
        // PRT-708 的**具名缺口**：「没有单实例保护（两个实例会各有一个图标，
        // 且 `observe()` 看到同一批进程，需要一把锁）」。
        //
        // 这把锁要同时满足三件互相拉扯的事，三条都有用例：
        //   ① 崩溃过的实例**不能**把产品永久锁死（锁文件还在磁盘上，进程没了）；
        //   ② 但"能不能回收"必须建立在**读得出来**的基础上——
        //      读不出持有者 / 问不到进程表时一律**拒绝**，并把该删哪个文件写在
        //      诊断里（拒绝必须**可解**，不是死胡同）；
        //   ③ 释放时必须**核对这把锁还是自己的**，否则会删掉别人的锁。
        //
        //   > 一个"不核对持有者就删锁"的释放，
        //   > 与一个"根本没有锁"的实现，
        //   > 在两次崩溃咬在一起的那一天是同一个东西。
        //
        // ★ 其中两条用**真子进程**：纯函数的"同一进程里开两次第二次失败"
        //   证明不了独占——*一个"在同一个进程里连开两次"的用例，与一个真的
        //   防住了两个进程的实现，在测试报告上是同一个东西。*
        'product/launcher/single-instance.test.mjs',
        // PRT-253 续批四：**Runtime Contract 的端点与凭证**怎么从 Launcher 交到
        // worker 手里（另外三个缺口）。
        //
        //   ① `runtime-contract-endpoint.test.mjs`：端口**发布**的读侧。
        //      三种失败模式各有具名码、**都不编 URL**——`ABSENT`（去看那一行挂没挂）、
        //      `STALE`（带 `publishedPid`：去看是不是有第二个进程在写同一个 DataDir）、
        //      `INVALID`/`UNREADABLE`。*一个"读不到就猜一个默认端口"的实现，
        //      与一个"具名拒绝"的实现，在端口恰好是默认值的机器上是同一个读数。*
        //      凭证侧钉的是"生成失败 ⇒ 不注入、不空串、不默认值、不关鉴权"。
        //   ② `runtime-contract-wiring.test.mjs`：Launcher 真的把两个名字与两个值
        //      交给那两个进程，且**只**交给那两个（hub / workbench / 白板拿不到）。
        //      ★ 这一套同时钉住一个既有缺口：`LEGION_DATA_DIR` 早已声明在
        //      `orchestrator.envNames` 里，但 Launcher 从不给它值 ⇒ worker 以
        //      `exitCode:8 / DATA_DIR_REQUIRED` 崩溃重启，而 Launcher 读数里
        //      **lastError 是 null**（崩溃循环不带一条错误信息）。
        'product/launcher/runtime-contract-endpoint.test.mjs',
        'product/launcher/runtime-contract-wiring.test.mjs',
        // PRT-214 续：把组合根要求的 Legion 身份**注入** Runtime 子进程。
        //
        // 覆盖层那一条解决了"补丁层交给了进程没有"，这一条解决"补丁层里的
        // root-row 拿得到配置没有"——两个都要有：只有前者时，root-row 会在
        // DSH 进程里以 CONFIG_MISSING 拒绝，而那条错误离"产品配置该写什么"很远。
        'product/launcher/enforcement-identity.test.mjs',
        // PRT-707（接线批）：六步向导接到**真实**的 init.mjs / launcher.mjs /
        // security/secrets 上。这一套盯的是"接线"而不是"状态机"（状态机在
        // `wizard.test.mjs`，40 条）。钉住的都是**读契约才发现**的东西：
        // 环境探测必须看存在的最近祖先、档案更新是 PATCH 不是 POST、
        // 绑定字段名是 employeeRole/primaryProfile、密钥引用要按约定算
        // （因为 hub 的单条档案读取**有意不含 secretRef**）。
        'product/launcher/first-run.test.mjs',
        // ★★ PRT-707 有**两份**实现，而它们对模型密钥的引用名说法不一致。
        //
        // 上面那一套（`first-run.test.mjs`）验的是**死的那份**
        // （`first-run.mjs`：636 行、零生产导入者）。**活的那份**是
        // `cli.mjs` 的 `--wizard` 分支里**内联**的一份，用的是另一个引用名。
        //
        // 这一套不替任何一方说话（那是一个产品决定），只做三件事：
        //   ① 把分歧钉住；
        //   ② ★ 用**真实读者** `planDshLookup()` 证明死的那份算出来的
        //      `legion/model/<id>`（**三段**）在 DSH 的两个键空间里都
        //      `addressable:false` —— 也就是**没有任何位置**；
        //   ③ 把"两份各自绿着"本身钉住。
        //
        // 为什么值得单列一组：把那份死的接上去是个**很自然**的动作
        // （它有 636 行、有一整套用例，而"零生产入口"看起来总是缺陷），
        // 而接上它不会报错——它会得到一个"向导说『模型已配置』、
        // 运行时拿不到钥匙"的产品。
        //
        //   > 一个"文件看起来完整、就是少了最要紧那一把钥匙"的读数，
        //   > 与一个"文件本来就只该有这么多"的读数，在 `cat` 的输出里长得一模一样。
        //
        // 本套件今天**全绿**：它是一份**读数**，不是待办。
        'product/launcher/wizard-wiring.test.mjs',
        // PRT-257 的最大一块空白：**DSH 运行时的安装**（PRT-011 裁决的路线 C）。
        //
        // 在此之前 `product/launcher/` 里**没有任何一行**在生产代码里解析过 DSH 版本、
        // 装进 DataDir、做过原子切换或回滚——`git grep` 零命中。
        //
        // ★ 本组最要紧的一条是**原子性**：指针**只在**新版本校验通过之后才动。
        //
        //   *一条"新版本装好了"的断言，
        //   与一条"指针只有在校验通过之后才动"的断言，
        //   在安装永远成功的那些运行里是同一片绿——
        //   只不过前者的绿，在一次装到一半的失败里会留下一个半装的 current。*
        //
        // 所以用例注入命令运行器与文件系统操作，**绝不联网、绝不跑真的 npm install**；
        // 并且断言"半装的目录**永远不可能**被选中"（靠一个只有装完才写的标记），
        // 以及回滚要断言**磁盘终态**（指针指向哪个目录、它的入口文件在不在）——
        // *一个只返回 `{ok:true}` 的回滚不是证据。*
        'product/launcher/runtime-install.test.mjs',
        // PRT-257 补齐轮：**「装得上」与「装完产品自己会用上它」是两件事。**
        //
        // `runtime-install.mjs` 把运行时装进 DataDir、写下 `current.json` —— 而
        // 在此之前，Launcher 从那份指针里**解析出 DSH 入口来拼 `--runtime-command`
        // 仍然是手工的**：装好的那份运行时因此没有任何人用它，一份装得完完整整
        // 却从不被启动的运行时，与一份没装的，在产品行为上是同一个东西。
        //
        // 本组钉的就是"下一跳"：没有显式配置时，命令**必须**来自 `current.json`；
        // 少了 profile 就**具名拒绝**而不是拼一条短命令——*一条"每个字都对、只是少
        // 了一段"的命令，与一条正确的命令，在它恰好也能启动的那些机器上是同一片绿。*
        'product/launcher/runtime-resolve.test.mjs',
        // 同一个缺口清单里的 ①：**产品没有随发任何 §9.1 安装清单**，
        // 于是用户得自己造一份、否则入口只给退出 3。
        //
        // 本组不伪造那份清单，而是把"缺什么、为什么推不出来"做成读数：
        // 八个字段里**三个**能从生产常量直接读出来（有权威来源），
        // 另外五个是发布决策——缺任一个就具名拒绝并逐个列出，
        // **绝不填默认值**。于是这个缺口从"沉默地退 3"变成"说得清缺哪五个值"。
        'product/launcher/runtime-manifest.test.mjs',
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
  /** 跳过了断言的套件（`{label, skipped, tests}`）。见下面汇总那一段。 */
  const skippedSuites = []
  /**
   * ★ 这一支的判据改用**共享解析器**（`scripts/lib/dsh-checkout.mjs`），
   *   不再手写 `process.env.DSH_CHECKOUT`。
   *
   *   为什么这一处也要改：它的注释写着目的是"**使该套件可从零复现**"，
   *   而手写判定做不到那件事——`DSH_CHECKOUT` 没导出的机器上，这一段整个不执行，
   *   于是 p13 / plugins / board-plugin 三套只有在**产物恰好已经躺在盘上**时才跑得起来。
   *   （实测：本机 `DSH_CHECKOUT` 未设，而这三套当轮都是绿的——
   *    绿的原因是产物残留，**不是**这段构建真的跑了。）
   *
   *   > 一个"可从零复现"的门禁，与一个"在产物恰好还在时能过"的门禁，
   *   > 在作者那台机器上是同一个东西——因为作者的产物恰好还在。
   *
   *   解析器自己会区分"没找到"与"找到了但没构建"，所以这一段现在
   *   在检出可达的任何机器上都真的会去构建。
   *
   *   ★ `need` 取 `packages`（与这一段原来的 `existsSync(join(dsh,'packages'))`
   *     同一个粒度）。**不收紧成 `cli`**：这一段做的是"构建外部包"，
   *     而缺 CLI 时那三套件会用自己的 `need: 'cli'` 各自具名跳过——
   *     在门禁侧顺手收紧判据，只会让"为什么没构建"变得看不见。
   */
  const dshFound = resolveDshCheckout({ need: 'packages' })
  const dsh = dshFound.checkout
  if (dsh !== null) {
    // p13-host-injection 需要 `@dsh-external/dsh-team-hub` 的**构建产物**：
    // team-hub/package.json 的 main 指向 ./lib/index.js，而 lib/ 是未跟踪产物。
    // 此前没有任何阶段构建它 → 该套件只能在本机恰好残留 lib/ 时通过，干净检出必失败
    // （真实表现：宿主 60s 未就绪，因为 loader 报 `Cannot find module .../team-hub/lib/index.js`）。
    // 这里显式构建，使该套件可从零复现；同时 p13 在没有可用 DSH 检出时仍按纪律 SKIP。
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
    // PRT-214：补丁层的**可加载性**——让真的 DSH 管线去读 legion-host.patch.yml。
    //
    // 为什么它必须用真 DSH 而不是本仓库的判据：这条线的每一个事实都是**别人的**——
    // 顶层要数组、schema 是 js-yaml 的 `entryListSchema`、`insert` 必须是
    // `EntryOptions[]`、`insert` 与 `id` 同时出现时语义变成"插进那一行的 config 数组"。
    // 实测（真 `applyEntryPatches`）确认：拿 Legion 自己的行 id 当 insert 靶子会得到
    // `patch insert: entry "..." not found` → **warn-and-skip，什么都不发生、也不抛**。
    //
    //   *一个"与自己的声明完全一致"的补丁层，
    //   与一个"能被 DSH 加载"的补丁层，在用例上是同一个东西——
    //   只不过前者的用例是绿的，而它从未被任何解析器读过。*
    //
    // 因此本套件跑真管线（真 js-yaml + 真 schema + 真 applyEntryPatches），
    // 而且 base 不是手编的：先应用 **DSH 自己的 base bundle 补丁**，再叠 Legion 这一层——
    // 那正是 profile 层在运行时的真实位置。
    //
    // 没有可用 DSH_CHECKOUT 时整组逐条 SKIP（摘要里留下 `skipped: N`），
    // 与 plugins/board-plugin 同一纪律：外部宿主测试不伪造通过。
    suites.push({
      label: 'patch-loadable（PRT-214：补丁层可加载性，真 DSH 管线）',
      files: ['runtime/dsh-composition/patch-loadable.test.mjs'],
      cwd: ROOT,
    })
    detail.push('  PASS patch-loadable（真 DSH 管线读 legion-host.patch.yml）')
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
    // ★ 单个**有条件**的文件（不是整个目录）：只有**真的**在 `if (dsh)` 分支里
    //   `suites.push` 进去的那几个才需要列在这里。
    //
    //   ⚠️ 本表此前列了 5 个，其中 4 个是**多余的**（2026-09-16 复核发现的）：
    //   `enforcement-plugin` / `approval-answerer` / `pre-execute` / `employee-preset`
    //   这四个是 `suites` **数组字面量**里的无条件元素（2468 / 2491 / 2512 / 2556 行），
    //   任何环境下都在 `listed` 里；它们**不跑**的原因不是"没登记"，而是没有
    //   DSH_CHECKOUT 时**用例自己逐条 SKIP**。
    //
    //   那份注释当时写的是"需要 DSH_CHECKOUT 才推得进 test 清单"——对这四个文件
    //   而言是**不成立**的。一条写错理由的豁免，比一条没有理由的豁免更接近事故：
    //   下一个读到这里的人会以为"进了这张表就可以不登记"。
    //
    //   > 一张"把本来就在清单里的文件也豁免掉"的表，
    //   > 与一张会顺手放过**真的**漏登记文件的表，区别只在它有没有列错。
    //
    //   条目形状要动整个目录吗？不要。`runtime/dsh-composition/` 下面还有一堆
    //   无条件套件，把整个目录列进来会顺手放过**真的**漏登记的新文件——
    //   而那个漏登记正是本检查存在的唯一理由。
    const conditionalFiles = new Set([
      // 唯一一个真的在 `if (dsh)` 分支里 `suites.push` 的（3249 行）。
      'runtime/dsh-composition/patch-loadable.test.mjs',
    ])
    const tracked = await exec('git', ['ls-files', '*.test.mjs'], { cwd: ROOT })
    const all = tracked.out.split('\n').map((x) => x.trim()).filter(Boolean)
    const missing = all
      .filter((f) => !listed.has(f))
      .filter((f) => !conditionalDirs.some((d) => f.startsWith(d)))
      .filter((f) => !conditionalFiles.has(f))
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
    if (!Number.isNaN(r.counts?.skipped) && r.counts.skipped > 0) {
      skippedSuites.push({ label: s.label, skipped: r.counts.skipped, tests: r.counts.tests })
    }
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
  // ★★ 跳过断言**单独汇总一行**。理由见 `runNodeTests` 里 `skipped` 那一段：
  //   不汇总时，"这批断言一条都没跑"只会散落在几十行 `skipped=N` 里，
  //   而摘要只有一行 `test PASS`。
  //
  //   ⚠️ 这一行**不判红**。跳过在本仓是**合法**的（干净检出上没有 DSH 检出、
  //   posix 上跑不了 win32 分支），把它判红会用一个大得多的故障
  //   （"在所有没装 DSH 的机器上 CI 全红"）去换一个小得多的故障。
  //   它做的是**把它变成读数**：`test PASS` 那一行旁边跟着
  //   `跳过 21 条（3 个套件）`，读的人自己判断这台机器该不该有这些跳过。
  const totalSkipped = skippedSuites.reduce((n, x) => n + x.skipped, 0)
  if (totalSkipped > 0) {
    detail.push(`  ⚠ 跳过 ${totalSkipped} 条断言（${skippedSuites.length} 个套件）：`
      // ★ 点名**套件**，不是只给 `1/33`。
      //
      //   第一版写的是 `${x.skipped}/${x.tests}`，于是汇总行长这样：
      //
      //     ⚠ 跳过 2 条断言（2 个套件）：1/33、1/52
      //
      //   那两个数字**告诉不了你任何事**：要知道"1/33"是哪个套件，
      //   得往上翻 200 多行去找哪个套件的细节行里有 `skipped=1 tests=33`。
      //   而这一行存在的**全部意义**就是省掉那次翻找。
      //
      //   > 一个要求读者自己去交叉引用的"汇总"，
      //   > 与没有这一行，在"我得翻多少行才能知道是哪两个套件"上是同一个东西。
      //
      //   标签取 `（` 之前那一段（后面的说明太长，汇总行放不下）。
      + skippedSuites.slice(0, 6).map((x) => `${String(x.label).split('（')[0]}(${x.skipped})`).join('、')
      + (skippedSuites.length > 6 ? ` …共 ${skippedSuites.length} 个` : ''))
    // 有检出、而且是**本机就在盘上**的那种时，把话说到底：机器明明有，
    // 而这些断言还是跳过了 —— 那是环境配置问题，不是环境缺失。
    if (totalSkipped > 0) detail.push('      环境里有 DSH 检出时请看上面每一行的 skipped=：' + SKIPPED_NOTE)
  }
  return { ok: allOk, detail: detail.join('\n'), counts: { skipped: totalSkipped, suites: skippedSuites.length } }
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
  // ★ spec 附录 A.7 的「任务进度总览」是**生成**的（`scripts/prt/spec-progress.mjs`）。
  //
  //   放在同一个阶段、且**默认执行**：进度数字是派生量（由台账 145 个状态标记算出），
  //   手写或忘记同步一定会漂——而 spec 是**被当成基准**的那份文档，
  //   它上面一个过期的百分比，比台账里一个错数字更容易被当真。
  //
  //     > 一份"要记得手动同步"的进度表，与一份"从来没同步过"的进度表，
  //     > 在读者眼里是同一个东西——只不过前者在第一次忘记之后开始说谎。
  const rp = await exec(process.execPath, [join(ROOT, 'scripts', 'prt', 'spec-progress.mjs'), '--check'], { cwd: ROOT })
  const ok = r.code === 0 && rp.code === 0
  // RC-3 修复（T-117 实测）：原实现只保留 PASS|FAIL 过滤行，check-docs 缺失/脚本语法错等模块级错误被吞
  // （ci.log 仅剩「doc: … exit=1」+「[doc] -> FAIL」，排障只能另跑 check-docs）。失败态改为带原始输出尾部。
  const raw = (r.out + '\n' + r.err).trim()
  const rawProgress = (rp.out + '\n' + rp.err).trim()
  let extra = ''
  if (ok) {
    const tail = [raw, rawProgress].join('\n').split('\n').filter(l => /PASS|FAIL/.test(l)).slice(-4).join(' | ')
    if (tail) extra = '\n  输出要点：' + tail
  } else {
    // 两个脚本各自的失败形态都要留下：只报其中一个会把"另一个也坏了"变成一次误诊。
    const part = (txt, tag) => {
      const lines = txt.split('\n').filter(Boolean)
      const fails = lines.filter(l => /^FAIL:/.test(l))
      const t = (fails.length > 0 ? fails.slice(-10) : lines.slice(-12)).join('\n  ')
      return t === '' ? '' : `【${tag}】\n  ${t}`
    }
    extra = '\n  失败明细：\n  ' + [
      r.code === 0 ? '' : part(raw, 'check-docs'),
      rp.code === 0 ? '' : part(rawProgress, 'spec-progress'),
    ].filter(Boolean).join('\n  ')
  }
  return {
    ok,
    detail: 'doc: 文档新鲜度校验（check-docs.mjs）exit=' + r.code +
      ' / 进度表自检（spec-progress.mjs --check）exit=' + rp.code + extra,
  }
}

// ---------- DSH 执行面边界（PRT-108 棘轮） ----------
// Product Runtime 的边界承诺在 Orchestrator/Adapter 建成前，唯一可执行的形式是
// **不让 DSH 执行面耦合继续增长**。dsh-boundary.mjs 用基线棘轮守住这一点：
// 迁移期既有调用点登记为「待迁移债务」，新代码一律不得新增。
// 放在 env 之后、其余阶段之前——它是纯静态检查（秒级），失败时应尽早失败，
// 而不是等四分钟的 test 阶段跑完才报。
async function stageBoundary() {
  const r = await exec(process.execPath, [join(ROOT, 'scripts', 'ci', 'dsh-boundary.mjs'), '--check'], { cwd: ROOT })
  // ★ DSH 出处锚点漂移（PRT-211 缺口收口）：`IMPLEMENTATION_FINDINGS` 里六条结论
  //   各自钉着"读哪个文件、哪一句"，而 DSH **不是冻结依赖**。这个核对让"出处"
  //   从一句话变成一件可核对的事。
  //
  //   三个读数分开：0 全部命中 / 1 漂移 / **3 未观察**。
  //   `DSH_CHECKOUT` 不可用时是 3 ⇒ 本阶段**仍然 PASS**，但 detail 里明写"未观察"，
  //   绝不写成"通过"——"没接"与"没做"是两个不同的问题。
  const rp = await exec(process.execPath, [join(ROOT, 'scripts', 'prt', 'dsh-pin-drift.mjs')], { cwd: ROOT })
  const pinRaw = (rp.out + '\n' + rp.err).trim()
  const pinUnobserved = rp.code === 3
  const ok = r.code === 0 && (rp.code === 0 || pinUnobserved)
  const raw = (r.out + '\n' + r.err).trim()
  let extra = ''
  if (ok) {
    const line = raw.split('\n').filter(l => /dsh-boundary: PASS/.test(l)).slice(-1)[0]
    if (line) extra = '\n  ' + line.trim()
    // 未观察时把那句"未观察"原样带进 CI 日志，别让它只存在于子进程的 stdout 里。
    const pinLine = pinRaw.split('\n').filter(l => /dsh-pin-drift:/.test(l)).slice(-1)[0]
    if (pinLine) extra += '\n  ' + pinLine.trim()
    if (pinUnobserved) extra += '\n  ⚠️ 出处锚点**这一批没有核对**（不是"核对通过"）：未找到 DSH 检出'
  } else {
    const lines = raw.split('\n').filter(Boolean)
    const fails = lines.filter(l => /^\s*FAIL \[/.test(l))
    const tail = (fails.length > 0 ? fails.slice(-10) : lines.slice(-12)).join('\n  ')
    extra = '\n  违规明细（优先移入 runtime/adapters/dsh/；确属迁移期债务才显式下移基线）：\n  ' + tail
    if (rp.code === 1) {
      const pinFails = pinRaw.split('\n').filter(l => /^\s*✖/.test(l)).slice(-8).join('\n  ')
      extra += '\n  \n  出处锚点对不上（PRT-211）：\n  ' + pinFails
    }
  }
  return {
    ok,
    detail: 'boundary: DSH 执行面边界棘轮（dsh-boundary.mjs）exit=' + r.code +
      ' / DSH 出处锚点漂移（dsh-pin-drift.mjs）exit=' + rp.code + extra,
  }
}

// ---------- 阶段：CI 脚本语法 ----------

/**
 * 全部 `scripts/**\/*.mjs` 必须能被 Node **解析**。
 *
 * ★ 这个阶段有一个**结构性**的局限，必须说清楚，否则它是一道假门禁：
 *
 *   它自己跑在 `run-ci.mjs` **里面**，所以它守得住别的脚本，
 *   却守不住 `run-ci.mjs` **自己**——那个文件坏掉时，本阶段根本不会被启动。
 *   而"没被启动"与"通过了"在日志里都是"没有 FAIL 行"。
 *
 *     > 一个"跑在它要守的那个程序里面"的门禁，
 *     > 与一个"根本没在守那个程序"的门禁，在被守对象坏掉的那一天是同一个东西。
 *
 *   所以 `scripts/ci/ci-syntax.mjs` 也必须被**单独**跑一次（六道门禁之外）。
 *   本阶段的独立价值是：它守住了其它 49 个脚本，
 *   以及"run-ci.mjs 改坏之后、别人下次跑 CI 时至少能看见它是坏的"。
 */
async function stageSyntax() {
  const script = join(ROOT, 'scripts', 'ci', 'ci-syntax.mjs')
  const r = await exec(process.execPath, [script], { cwd: ROOT })
  const ok = r.code === 0
  const lines = String(r.stdout ?? '').split('\n').filter(Boolean)
  const detail = 'syntax: CI 脚本可解析性（ci-syntax.mjs）exit=' + r.code +
    '\n  输出要点：' + (lines.slice(-2).join(' ') || String(r.stderr ?? '').trim().split('\n').slice(-2).join(' '))
  return { ok, detail }
}

// ---------- 主流程 ----------
const STAGES = [
  // ★ syntax 排在最前：它守的是"跑门禁的那些程序"。
  //   排在后面就等于"先跑了一堆可能根本没被解析成功的脚本"。
  { name: 'syntax', label: 'CI 脚本语法（ci-syntax.mjs）', fn: stageSyntax },
  { name: 'env', label: '环境自检', fn: stageEnv },
  { name: 'boundary', label: 'DSH 执行面边界（PRT-108 棘轮）+ DSH 出处锚点漂移（PRT-211）', fn: stageBoundary },
  { name: 'deps', label: '依赖就绪', fn: stageDeps },
  { name: 'build', label: '构建（whiteboard + workbench dist）', fn: stageBuild },
  { name: 'test', label: 'L0 契约/基线测试', fn: stageTest },
  { name: 'smoke', label: 'L1 真实服务冒烟', fn: stageSmoke },
  { name: 'stage', label: '发布物暂存', fn: stageStage },
  { name: 'doc', label: '文档新鲜度校验（check-docs.mjs）+ 进度表自检（spec-progress.mjs --check）', fn: stageDoc },
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
      stageResults.push({ name: s.name, status, ms: Date.now() - t0, skipped: res?.counts?.skipped ?? 0 })
      tee(res.detail)
      tee('[' + s.name + '] -> ' + status + ' (' + (Date.now() - t0) + 'ms)')
    } catch (e) {
      failed += 1
      stageResults.push({ name: s.name, status: 'FAIL', ms: Date.now() - t0, skipped: 0 })
      tee('[' + s.name + '] exception: ' + (e && e.message ? e.message : String(e)))
    }
  }
  tee('')
  tee('===== SUMMARY =====')
  // ★ 跳过数进 SUMMARY：这一行是**唯一**会被贴进对话/工单/提交信息的地方，
  //   而"跳过了多少条"此前只存在于 detail 的几十行里（而且 `skipped` 根本没被解析，
  //   见 `runNodeTests`）。一个不显示跳过的 SUMMARY 会让
  //   「38 条里跳过 20 条」与「38 条全跑」印出同一行 `test PASS`。
  for (const r of stageResults) {
    tee('  ' + r.name.padEnd(6) + ' ' + r.status + ' (' + r.ms + 'ms)'
      + (r.skipped > 0 ? '  ⚠ skipped=' + r.skipped : ''))
  }
  const skippedTotal = stageResults.reduce((n, r) => n + (r.skipped || 0), 0)
  if (skippedTotal > 0) {
    tee('')
    tee('  ⚠ 本次共跳过 ' + skippedTotal + ' 条断言。跳过可以是合法的（缺 DSH 检出 / 缺浏览器 / '
      + 'posix 上跑不了 win32 分支），也可以是环境没配上 —— SUMMARY 里这一行就是为了让这两者不再同形。')
  }

  // ★★★ 第 28 轮：把**树的状态**记进产物。见 `readTreeState` 上方的长注释。
  const tree = await readTreeState()
  if (tree.known && tree.dirty) {
    tee('')
    tee('  ⚠⚠ 本次 CI 跑在一棵**脏树**上：已改 ' + tree.modifiedCount
      + ' 个文件 + 未跟踪 ' + tree.untrackedCount + ' 个（指纹 ' + tree.fingerprint + '）。')
    tee('     ⇒ 这次读数证明的是「**这棵树**是绿的」，**不是**「提交 '
      + tree.head + ' 是绿的」。')
    tee('     引用它时请连树一起引用；`git head=` 回答的是"哪个提交"，不是"跑的哪棵树"。')
  } else if (!tree.known) {
    tee('')
    tee('  ⚠ 无法判断本次 CI 跑在哪棵树上（' + tree.reason + '）——'
      + '"读不出来"不等于"干净"。')
  }

  writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify({
    root: ROOT, outDir: OUT_DIR, finishedAt: new Date().toISOString(),
    stages: stageResults, failed, skippedTotal,
    tree,
  }, null, 2) + '\n', 'utf8')
  tee('summary.json -> ' + join(OUT_DIR, 'summary.json'))
  process.exit(failed === 0 ? 0 : 1)
}

main()
