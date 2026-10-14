// plugins/src/artifactDelivery.ts
// ============================================================================
// 「合入主分支」≠「用户看到的东西变了」：构建产物必须**在主工作区重建**，
// 而「重建失败」必须是一次**未完成的交付**，不能算成功。
//
// ## 现场（2026-10-14，G-mv7kzgnu-1「为外部执行者配头像」）
//
// 目标链 T-203..T-210 全绿、目标自动 settle 成 done，而将军看到的是「还是没头像」。
// 链条没错、代码也没错 —— 错在**没有任何一步把源码变成用户看得见的东西**：
//
//   · `autoPromote` 把 `w/T-207` 合进 main（`git merge --no-ff`）；
//   · 而 `workbench/dist` 是 **gitignored 的构建产物** ⇒ 合并一个字节都带不过去；
//   · 运行中的指挥台（`workbench/scripts/serve.mjs`，:5173）读的**正是主工作区的 dist**
//     ⇒ 它继续发 12:17 构建的旧包，而源码 12:51 才改。
//
// 于是界面上那三处（侧栏用户卡的 `⚙`、左轨的「管」、技能授权标签）仍是旧的，
// 而每一层的报错都是空的：合并成功、任务 done、目标 done、套件全绿。
//
//   > 一个「源码已合入主分支」的读数，与一个「用户看到的东西已经变了」的读数，
//   > 在**没有人重建产物**的时候长得完全一样 —— 而后者才是交付的定义。
//
// 这不是第一次：同一天上午，指挥台的「按目标筛选」也是**源码在、产物旧**，
// 将军先看见"没变化"，重建后才看见。两件事同一个形状。
//
// ## 为什么「重建失败」不能算成功
//
// 同一现场的部署阶段（T-210）其实**撞上了构建失败**：worker 沙箱里
// `vite build` 报 `esbuild spawn EPERM`。它如实写进了证据，然后用
// `run-ci --only syntax,boundary,deps,doc`（**把 build 阶段排除掉**）
// 加一个只打服务端 HTTP 的 deploy-smoke 收尾。构建失败没有拦住任何东西。
//
//   > 一个「我构建不了」的诚实读数，与一个「我不需要构建」的判据，
//   > 在**没有任何机器闸门要求构建通过**的时候，通向同一个 done。
//
// 所以本模块的判据是：合入之后必须重建受影响的产物；**重建不成功 = 交付未完成**，
// 由调用方把任务停在 in_review，并写清"源码在 main、界面还是旧的、怎么复现"。
//
// ## 为什么这件事不该由 worker 做
//
//   · worker 跑在**受限沙箱**里（上面的 `spawn EPERM` 就是那个沙箱），它构建不了；
//   · 就算构建成功，它是在自己的 worktree 里构建的，产物同样回不到主工作区。
//
// 该由**守护**做：它跑在宿主进程里、在主工作区里，而且它才是那个做 merge 的人
// —— 谁产生「主分支前进」这件事，谁就要负责让用户的界面跟上。
//
// ## 已知边界（不假装覆盖）
//
//   · 本模块只重建**静态前端产物**（`workbench/dist`、whiteboard 静态件）。
//     **服务端/守护进程内的代码要重启才生效**（BUG-036 是同一类），
//     这里不做、也不能做"重启宿主"这件事。
//   · 判据是**按路径**决定要不要重建，宁可多建一次：多建只花时间（~25s），
//     漏建就是本 BUG 本身。所以 `workbench/mobile/**` 这种其实不需要构建的改动
//     也会触发一次重建 —— 这是故意的偏向。
// ============================================================================

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

/** 需要"源码 → 产物"这一步的 app（与 `scripts/ci/run-ci.mjs` 的 build 阶段同一批）。 */
export interface BuiltApp {
  /** 日志与回执里的短名。 */
  id: string
  /** 仓库相对目录。 */
  dir: string
  /** 该目录 `package.json` 里要跑的 script 名。 */
  script: string
}

export const BUILT_APPS: readonly BuiltApp[] = Object.freeze([
  { id: 'workbench', dir: 'workbench', script: 'build' },
  { id: 'whiteboard', dir: 'whiteboard', script: 'build' },
])

/**
 * app 目录下**第一层**叫这些名字 ⇒ 是产物/依赖/运行态，不是源码。
 *
 * ⚠ 只看**第一层**，不看嵌套：`workbench/dist/**` 是产物，而
 * `workbench/apps/x/dist/y.js` 这种嵌套的 dist 仍然算源码。
 * 理由是两种判错的**代价不对称**：
 *   · 多判成源码 → 多跑一次构建（~25s），没有任何别的后果；
 *   · 少判成源码 → 改了前端却不重建 ⇒ 用户看不到改动，而这正是本 BUG 的形态。
 *
 * ⚠ 其实 `git diff --name-only` 只列**被跟踪**的文件，而 `dist/` 早已 gitignore
 *   ⇒ 产物路径正常情况下压根不会出现在这里。这一层是**兜底**（万一哪天有产物被跟踪了），
 *   所以宁可窄、不可宽。
 */
const NON_SOURCE_SEGMENTS = new Set(['dist', 'build', '.vite', 'node_modules', 'data', 'coverage'])

function normPath(value: unknown): string {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

/** 这次改动是否碰了该 app 的**源码**（第一层产物目录下的改动不算）。 */
export function touchesApp(app: BuiltApp, path: string): boolean {
  const rel = normPath(path)
  if (rel === '' || !rel.startsWith(app.dir + '/')) return false
  const inside = rel.slice(app.dir.length + 1)
  if (inside === '') return false
  return !NON_SOURCE_SEGMENTS.has(inside.split('/')[0])
}

/**
 * 本次合入**需要重建哪些 app**（纯函数）。
 *
 * 一个都没碰到就返回空 —— 大多数任务只改文档或后端，不该每次合入都跑一遍前端构建。
 */
export function appsToRebuild(
  changedPaths: readonly string[] | null | undefined,
  apps: readonly BuiltApp[] = BUILT_APPS,
): BuiltApp[] {
  const paths = [...(changedPaths ?? [])]
  return apps.filter(app => paths.some(p => touchesApp(app, p)))
}

/** 重建回执：`ok=false` 时 `detail` 必须能让人复现，而不只是"失败了"。 */
export interface ArtifactBuildReceipt {
  ok: boolean
  /** 实际尝试重建的 app id（空 = 本次没有任何产物需要重建，也算 ok）。 */
  rebuilt: string[]
  /** 一行结论（进日志/评论）。 */
  summary: string
  /** 失败原因（含子进程输出的尾部）。 */
  detail: string
}

/** 单个 app 的构建超时。给足余量：本仓 workbench 全量构建实测 8~25s。 */
export const BUILD_TIMEOUT_MS = 10 * 60 * 1000
const OUTPUT_TAIL = 1200

/** Windows 上 `npm` 是 .cmd 垫片，无 shell 起不来 —— 与 `workflowTestRunner.ts` 同一处置。 */
function resolveNpm(): { file: string; args: string[] } {
  if (process.platform !== 'win32') return { file: 'npm', args: [] }
  const searchDirs = [...new Set([dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)])]
  const npmCli = searchDirs.map(d => join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js')).find(existsSync)
  if (npmCli === undefined) return { file: 'npm.cmd', args: [] }
  return { file: process.execPath, args: [npmCli] }
}

interface ScriptRun { code: number; output: string; error: string | null }

/** 构建执行器签名：可注入（测试要能造"构建失败/超时/起不来"这三种现场，而不真跑一次 vite）。 */
export type PackageScriptRunner = (dir: string, script: string, timeoutMs: number) => Promise<ScriptRun>

function runPackageScript(dir: string, script: string, timeoutMs: number): Promise<ScriptRun> {
  return new Promise(resolve => {
    let child
    try {
      const npm = resolveNpm()
      child = spawn(npm.file, [...npm.args, 'run', script], {
        cwd: dir,
        windowsHide: true,
        // 无 shell：script 名来自本模块的冻结表，不来自任何输入
        shell: false,
        env: { ...process.env, CI: '1' },
      })
    } catch (e) {
      resolve({ code: -1, output: '', error: `构建进程起不来：${String(e)}` })
      return
    }
    let out = ''
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && Number.isInteger(child.pid)) {
          spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } else if (Number.isInteger(child.pid)) {
          process.kill(-child.pid!, 'SIGKILL')
        }
      } catch { /* 已退出 */ }
      resolve({ code: -2, output: out, error: `构建超时（${Math.round(timeoutMs / 1000)}s）` })
    }, timeoutMs)
    child.stdout?.on('data', d => { out += d })
    child.stderr?.on('data', d => { out += d })
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, output: out, error: `构建进程错误：${e.message}` }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, output: out, error: null }) })
  })
}

/**
 * 在**主工作区**重建受本次合入影响的产物。
 *
 * @param repoRoot 主工作区根（必须是 git merge 落地的那个目录，否则重建的产物没人读）
 * @param changedPaths 本次合入相对**合入前 HEAD** 改动的路径（`git diff --name-only`）
 */
export async function rebuildMergedArtifacts({
  repoRoot,
  changedPaths,
  apps = BUILT_APPS,
  timeoutMs = BUILD_TIMEOUT_MS,
  log = () => {},
  runScript = runPackageScript,
}: {
  repoRoot: string
  changedPaths: readonly string[] | null | undefined
  apps?: readonly BuiltApp[]
  timeoutMs?: number
  log?: (message: string) => void
  /** 构建执行器（缺省 = 真起 `npm run <script>`）。 */
  runScript?: PackageScriptRunner
}): Promise<ArtifactBuildReceipt> {
  const targets = appsToRebuild(changedPaths, apps)
  if (targets.length === 0) {
    return { ok: true, rebuilt: [], summary: '本次合入未触及任何需要构建的产物', detail: '' }
  }
  const rebuilt: string[] = []
  const details: string[] = []
  for (const app of targets) {
    const dir = join(repoRoot, app.dir)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) {
      // 目录都不在 ⇒ 不是"构建失败"，是"这个 app 不在本仓库"。如实说，不当成功。
      return {
        ok: false, rebuilt, summary: `合入了 ${app.dir}/ 的改动，但主工作区里没有 ${app.dir}/package.json`,
        detail: `找不到 ${pkgFile}：无法重建 ${app.id} 的产物。用户看到的仍是旧产物。`,
      }
    }
    let script = app.script
    try {
      const scripts = JSON.parse(readFileSync(pkgFile, 'utf8'))?.scripts ?? {}
      if (typeof scripts[app.script] !== 'string' || scripts[app.script].trim() === '') {
        return {
          ok: false, rebuilt, summary: `${app.dir}/package.json 里没有 ${app.script} 脚本`,
          detail: `${pkgFile} 的 scripts.${app.script} 缺失或为空：无法重建 ${app.id} 的产物。`,
        }
      }
      script = app.script
    } catch (e) {
      return {
        ok: false, rebuilt, summary: `${app.dir}/package.json 读不出来`,
        detail: `解析 ${pkgFile} 失败：${String(e)}`,
      }
    }
    log(`重建 ${app.id} 产物（${app.dir}: npm run ${script}）…`)
    const r = await runScript(dir, script, timeoutMs)
    rebuilt.push(app.id)
    if (r.code !== 0 || r.error !== null) {
      const tail = r.output.trim().split('\n').slice(-OUTPUT_TAIL).join('\n')
      return {
        ok: false,
        rebuilt,
        summary: `${app.id} 产物重建失败（exit=${r.code}${r.error ? `，${r.error}` : ''}）`,
        detail: `${app.id} 的 npm run ${script} 在 ${dir} 失败（exit=${r.code}）：\n${tail}`,
      }
    }
    log(`${app.id} 产物已重建`)
  }
  return { ok: true, rebuilt, summary: `产物已重建：${rebuilt.join('、')}`, detail: '' }
}

/** 重建失败时给任务的评论：**说清源码已在 main、界面还是旧的、怎么复现**。 */
export function artifactFailureComment(receipt: ArtifactBuildReceipt, repoRoot: string): string {
  const apps = receipt.rebuilt.length > 0 ? receipt.rebuilt.join('、') : '（无）'
  return [
    `⛔ 源码已合入主分支，但**产物重建失败** —— 用户界面仍是旧的，本次交付**未完成**。`,
    `失败环节：${receipt.summary}`,
    `已尝试重建：${apps}`,
    '复现与修复（在**主工作区**、不是 worktree）：',
    `  1) 看失败原因：上面的输出；`,
    `  2) 手动重建：\`cd ${join(repoRoot, 'workbench')} && npm run build\`（whiteboard 同理）；`,
    '  3) 重建成功后再把本任务推进 done；在此之前下游不会流转（停在 in_review）。',
    '为什么这一步不能省：`dist/` 是 gitignored 的构建产物，`git merge` 带不过去，',
    '而运行中的指挥台读的正是主工作区的 dist —— 源码在、产物旧，用户看到的就是"没生效"。',
    receipt.detail ? `\n构建输出（尾部）：\n${receipt.detail}` : '',
  ].filter(Boolean).join('\n')
}
