#!/usr/bin/env node
/**
 * run-ci.mjs — Legion 目标级发布前本地 CI 门禁（零第三方依赖，Node >= 22.5）。
 *
 * 本脚本是 T-093（部署与 CI/CD，devops 收尾）交付的统一发布流水线，整合自
 * w/T-043 / w/T-063 / w/T-064 各切片 devops 草案（均未合入 main），按最终 main HEAD
 * （06480ba，三中心 + 日程/通知 + 平台切片全部 promote 后）重新对齐并收口。
 *
 * 用法：
 *   node scripts/ci/run-ci.mjs                            # 全量门禁（env,deps,build,test,smoke,stage）
 *   node scripts/ci/run-ci.mjs --only build,test          # 只跑某阶段
 *   node scripts/ci/run-ci.mjs --skip smoke               # 跳过某阶段
 *   node scripts/ci/run-ci.mjs --out docs/T093-evidence/ci-run   # 证据输出目录（ci.log + summary.json）
 *
 * 阶段：
 *   env    环境自检（node 版本 / 仓库根 / git head）
 *   deps   workbench 依赖就绪（node_modules 缺失时尝试 junction 指向主 checkout；失败即 FAIL 并给指引）
 *   build  whiteboard build（静态前端装配）+ workbench build（tsc --noEmit && vite build，产物 dist/）
 *   test   L0 契约/基线（node --test）：chat 13 + skills 12 + calendar 13 + files-api 40 + web 24
 *          + contracts 56 + whiteboard 67（7 文件，含真实服务 e2e）
 *   smoke  L1 真实服务冒烟（仓库既有冒烟脚本直跑 + 白板真实进程探活 + v1 看板启停）
 *   stage  发布物暂存：releases/legion-<gitHead>-<date>/（dist 快照 + MANIFEST.json + SHA256SUMS.txt）
 *
 * 通过标准：全部阶段 PASS，exit code 0；输出落 --out 目录（默认 .ci/<时间戳>/）。
 * 沙箱说明：本仓库既有边界 = pwsh/受限 shell 拦截子进程 pipe 捕获（spawn EPERM）；
 * 在普通终端或 run_code 宿主进程执行本脚本即可全量直跑（T-043 先例，命令与产物与普通终端一致）。
 */
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, statSync, rmSync, symlinkSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
    child.stdout.on('data', d => { out += d.toString() })
    child.stderr.on('data', d => { err += d.toString() })
    const timer = opts.timeoutMs ? setTimeout(() => { try { child.kill() } catch { /* */ } }, opts.timeoutMs) : null
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolvePromise({ code, out, err }) })
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolvePromise({ code: -2, out, err: e.message }) })
  })
}

async function runNodeTests(label, files, cwd) {
  const r = await exec(process.execPath, ['--test', ...files], { cwd })
  const all = r.out + '\n' + r.err
  const num = (re) => { const m = re.exec(all); return m ? Number(m[1]) : NaN }
  const counts = { tests: num(/\btests\s+(\d+)/), pass: num(/\bpass\s+(\d+)/), fail: num(/\bfail\s+(\d+)/) }
  const ok = r.code === 0 && (Number.isNaN(counts.fail) || counts.fail === 0)
  const failLines = all.split('\n').filter(l => /^not ok|# fail|^✖/.test(l)).slice(0, 8).join(' | ')
  const detail = label + ': exit=' + r.code + ' tests=' + counts.tests + ' pass=' + counts.pass + ' fail=' + counts.fail
  return { ok, code: r.code, detail: ok ? detail : detail + ' FAIL: ' + (failLines || '(see ci.log)'), raw: all }
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
  const ok = Number(process.versions.node.split('.')[0]) >= 22 && gitR.code === 0
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
    { label: 'calendar（日程日历契约）', files: ['team-hub/calendar.test.mjs'], cwd: ROOT },
    { label: 'files-api（文件中心契约）', files: ['workbench/scripts/files-api.test.mjs'], cwd: ROOT },
    { label: 'web（浏览器助手契约）', files: ['workbench/scripts/web.test.mjs'], cwd: ROOT },
    { label: 'contracts（平台契约基线）', files: ['tests/contract/contracts.test.mjs'], cwd: ROOT },
  ]
  const wbDir = WHITEBOARD
  const wbPkg = JSON.parse(readFileSync(join(wbDir, 'package.json'), 'utf8'))
  const wbTests = ((wbPkg.scripts && wbPkg.scripts.test) || '').split(/\s+/).filter(t => t.endsWith('.mjs'))
  suites.push({ label: 'whiteboard（7 文件含真实服务 e2e）', files: wbTests, cwd: wbDir })
  const detail = []
  let allOk = true
  for (const s of suites) {
    const cwd = s.cwd || ROOT
    const r = await runNodeTests(s.label, s.files.map(f => join(cwd, f)), cwd)
    allOk = allOk && r.ok
    detail.push('  ' + (r.ok ? 'PASS' : 'FAIL') + ' ' + r.detail)
    if (!r.ok) detail.push('  ' + (r.raw.split('\n').filter(l => /^not ok|^✖/.test(l)).slice(0, 6).join('\n  ')))
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

// ---------- 主流程 ----------
const STAGES = [
  { name: 'env', label: '环境自检', fn: stageEnv },
  { name: 'deps', label: '依赖就绪', fn: stageDeps },
  { name: 'build', label: '构建（whiteboard + workbench dist）', fn: stageBuild },
  { name: 'test', label: 'L0 契约/基线测试', fn: stageTest },
  { name: 'smoke', label: 'L1 真实服务冒烟', fn: stageSmoke },
  { name: 'stage', label: '发布物暂存', fn: stageStage },
]

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  try { appendFileSync(LOG_FILE, '') } catch { /* ignore */ }
  const wanted = STAGES.filter(s => (ONLY.length === 0 || ONLY.includes(s.name)) && !SKIP.includes(s.name))
  if (wanted.length === 0) { tee('no stages selected'); process.exit(2) }
  tee('Legion CI run: root=' + ROOT + ' node=' + process.versions.node)
  tee('stages: ' + wanted.map(s => s.name).join(' -> ') + ' | out=' + OUT_DIR)
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
