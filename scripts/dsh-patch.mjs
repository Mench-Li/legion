#!/usr/bin/env node
/**
 * patches/dsh 的补丁管家：**校验基线、应用、回退、重录证据**。
 *
 * ## 它存在的理由（一句话）
 *
 * Legion 是产品，DSH 是它面向的运行时。对运行时的兼容修复属于 Legion，
 * 但**必须以"可撤销、可校验、可升级"的形式持有** —— 而不是往依赖仓库的 master
 * 上叠一个本地提交（那份提交在你某天 `git pull` 时会变成冲突，且没人记得它为什么在那）。
 *
 * DSH 的 provider 实现是 `origin = deepseek-ai/deepseek-harness`（官方仓库），
 * 我们**推不上去**。所以补丁只能由 Legion 持有；相应地，Legion 也必须能回答
 * 三个问题：
 *
 *   1. 这份补丁**当初对着哪一版上游**做的？（基线）
 *   2. 现在这台机器上**装的那份**还是不是那个版本？（漂移检测）
 *   3. 修复**到底还在不在生效**？（部署证据，不只是"我记录过一个哈希"）
 *
 * 三个问题各有对应的判定，缺任一个，这个补丁就变成一个没人敢动的黑盒。
 *
 * ## 用法
 *
 *   node scripts/dsh-patch.mjs --list
 *   node scripts/dsh-patch.mjs --check [--source=<dsh 检出>] [--strict]
 *   node scripts/dsh-patch.mjs --apply --source=<dsh 检出> [--patch=<slug>]
 *   node scripts/dsh-patch.mjs --build --source=<dsh 检出> [--patch=<slug>]
 *   node scripts/dsh-patch.mjs --install --source=<dsh 检出> [--patch=<slug>]
 *   node scripts/dsh-patch.mjs --revert --source=<dsh 检出> [--patch=<slug>]
 *   node scripts/dsh-patch.mjs --record          # 从当前机器重录基线证据（写 base.json）
 *
 * ## `--build` / `--install`：为什么是"构建源码"，而不是"手改产物"
 *
 * 补丁打在**源码**（`.ts`）上，必须由 DSH 自己的构建链编出 `lib/`，再装进 profile。
 * 手改 `lib/index.js` 看似更快，但那是把债从"看得见的提交"换成"看不见的 JS 差异"：
 * 产物不可读、升级即丢，且与 `patches/dsh/*.patch` 形成两轨、迟早漂移。
 *
 * 构建只做**一个包**（整仓 200+ 包没必要）：
 *   1. `tsc -b <包目录> --force`：编译到 `lib/types/`
 *   2. `tsdown -c patches/dsh/single-package.tsdown.config.mts`（cwd=包目录）：
 *      按上游同款参数打包成 `lib/index.js`（依赖外置、`.js` 扩展名）
 * 安装只覆盖 profile 里那**一个产物** `lib/index.js`（先备份），
 * 不动 package.json、不动依赖解析 —— 于是不可能因为重装而破坏运行中的宿主。
 *
 * ## 判定语义（`--check`，退出码）
 *
 *   · 补丁文件哈希 ≠ 基线记录            → FAIL（补丁被人手改过，基线不再描述它）
 *   · 已装 app.asar 哈希 ≠ 基线记录      → FAIL（DSH 升级/重装过：补丁需重新生成与重录）
 *   · 部署产物里**找不到修复标记**       → FAIL（profile 被重装，修复已丢失）
 *   · 给了 `--source` 但 `git apply --check` 不过 → FAIL（补丁落不到这份检出上）
 *   · 找不到已装 DSH                     → SKIP（`--strict` 时算 FAIL）
 *
 * 零第三方依赖（只 node: 内置），与仓库其余 CI 脚本一致。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH_DIR = join(ROOT, 'patches', 'dsh')
const BASE_PATH = join(PATCH_DIR, 'base.json')

/** 补丁目标仓库（仅用于报告，不改任何东西）。 */
export const UPSTREAM_REPO = 'https://github.com/deepseek-ai/deepseek-harness.git'

/** 已装 DSH 的可能位置：环境变量优先，其次各平台默认路径。 */
export function dshCandidates(env = process.env) {
  const list = []
  if (typeof env.DSH_APP_ASAR === 'string' && env.DSH_APP_ASAR.trim() !== '') list.push(env.DSH_APP_ASAR.trim())
  if (typeof env.DSH_INSTALL_DIR === 'string' && env.DSH_INSTALL_DIR.trim() !== '') {
    list.push(join(env.DSH_INSTALL_DIR.trim(), 'resources', 'app.asar'))
  }
  list.push(
    'D:/software/dsh/resources/app.asar',
    'C:/Program Files/DSH/resources/app.asar',
    '/Applications/DSH.app/Contents/Resources/app.asar',
    '/opt/DSH/resources/app.asar',
  )
  return list
}

/** DSH profile 根目录（provider 插件装在这里，不在 app.asar 里）。 */
export function profileCandidates(env = process.env) {
  const list = []
  if (typeof env.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR.trim() !== '') list.push(env.DSH_PROFILE_DIR.trim())
  const home = env.USERPROFILE ?? env.HOME ?? ''
  if (home !== '') {
    list.push(join(home, '.dsh', 'profiles', 'desktop'))
    list.push(join(home, '.dsh', 'profiles', 'default'))
  }
  return list
}

/** 文件哈希（不存在返回 null）。 */
export function sha256File(path) {
  if (!existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 读 Electron asar 的头部目录表。
 * @param asarPath - app.asar 路径。
 * @returns 目录项列表与切片读取器。
 */
export function openAsar(asarPath) {
  const bytes = readFileSync(asarPath)
  const headerSize = bytes.readUInt32LE(4)
  const raw = bytes.subarray(8, 8 + headerSize).toString('utf8')
  const header = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
  const base = 8 + headerSize
  const files = []
  const walk = (node, prefix) => {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const path = `${prefix}/${name}`
      if (value.files !== undefined) walk(value, path)
      else files.push({ path, size: Number(value.size), offset: Number(value.offset) })
    }
  }
  walk(header, '')
  return {
    bytes,
    files,
    find: (path) => files.find((entry) => entry.path === path),
    read: (entry) => bytes.subarray(base + entry.offset, base + entry.offset + entry.size),
  }
}

/** 在 asar 里读一个包的 package.json 版本。 */
export function asarPackageVersion(asar, packageName) {
  const entry = asar.find(`/dsh/node_modules/@deepseek-ai/${packageName}/package.json`)
  if (entry === undefined) return null
  return JSON.parse(asar.read(entry).toString('utf8')).version ?? null
}

/** 在 asar 里读应用自身的版本。 */
export function asarAppVersion(asar) {
  const entry = asar.find('/package.json')
  if (entry === undefined) return null
  return JSON.parse(asar.read(entry).toString('utf8')).version ?? null
}

/** 已装 DSH 的事实：路径、版本、哈希；找不到就是 null。 */
export function installedDsh(env = process.env) {
  for (const candidate of dshCandidates(env)) {
    const path = resolve(candidate)
    if (!existsSync(path)) continue
    try {
      const asar = openAsar(path)
      return {
        asarPath: path,
        asarSha256: sha256File(path),
        appVersion: asarAppVersion(asar),
        packages: {
          subagent: asarPackageVersion(asar, 'dsh-subagent'),
          spawnInProcess: asarPackageVersion(asar, 'dsh-subagent-spawn-in-process'),
        },
      }
    } catch {
      // 损坏的 asar 与"没有"同样不可用：继续找下一个候选，最后报 SKIP 而不是崩。
    }
  }
  return null
}

/** profile 里某个 provider 包的部署事实（版本 + lib 哈希 + 内容）。 */
export function deployedPackage(packageName, env = process.env) {
  for (const profileRoot of profileCandidates(env)) {
    const dir = join(profileRoot, 'node_modules', '@deepseek-ai', packageName)
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const libPath = join(dir, 'lib', 'index.js')
    return {
      profileRoot,
      dir,
      version: JSON.parse(readFileSync(manifest, 'utf8')).version ?? null,
      libPath,
      libSha256: sha256File(libPath),
      libText: existsSync(libPath) ? readFileSync(libPath, 'utf8') : null,
    }
  }
  return null
}

/** 读基线（不存在返回 null）。 */
export function loadBase(path = BASE_PATH) {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 按 slug 选补丁（不指定则要求恰好一个）。 */
export function selectPatch(base, slug) {
  const patches = base?.patches ?? []
  if (slug !== undefined && slug !== null && slug !== '') {
    const found = patches.find((entry) => entry.slug === slug)
    return found ?? null
  }
  return patches.length === 1 ? patches[0] : null
}

/**
 * 判定基线是否仍描述现状（**纯函数**，便于单测）。
 *
 * @param base - 基线对象
 * @param now - 当前事实 `{ installed, deployed }`
 * @param options.patchDir - 补丁目录（默认本仓的 `patches/dsh`；单测可注入临时目录）
 * @returns 逐项判定结果与总体结论
 */
export function evaluateBase(base, now, options = {}) {
  const patchDir = options.patchDir ?? PATCH_DIR
  const checks = []
  const patch = selectPatch(base)
  if (patch === null) {
    checks.push({ id: 'patch', ok: false, text: '基线里没有可唯一确定的补丁（用 --patch=<slug> 指定）' })
    return { ok: false, checks, drifts: [] }
  }

  const patchPath = join(patchDir, patch.file)
  const actualPatchSha = sha256File(patchPath)
  checks.push({
    id: 'patch-hash',
    ok: actualPatchSha === patch.sha256,
    text: actualPatchSha === null
      ? `补丁文件不存在：${patch.file}`
      : actualPatchSha === patch.sha256
        ? `补丁未被人手改动（sha256 ${patch.sha256.slice(0, 12)}…）`
        : `补丁被改动过：记录 ${patch.sha256.slice(0, 12)}… 实际 ${actualPatchSha.slice(0, 12)}… —— 基线不再描述它，请重录`,
  })

  if (now.installed === null) {
    checks.push({ id: 'installed', skipped: true, text: '找不到已装 DSH（设 DSH_APP_ASAR 或 DSH_INSTALL_DIR 后重试）' })
  } else {
    checks.push({
      id: 'installed-asar',
      ok: now.installed.asarSha256 === base.installed?.asarSha256,
      text: now.installed.asarSha256 === base.installed?.asarSha256
        ? `已装 DSH 就是基线那份（${now.installed.appVersion}，asar ${String(now.installed.asarSha256).slice(0, 12)}…）`
        : `已装 DSH 与基线不同：记录 ${now.installed.appVersion}/${String(base.installed?.asarSha256).slice(0, 12)}… `
          + `实际 ${now.installed.appVersion}/${String(now.installed.asarSha256).slice(0, 12)}… —— DSH 升级或重装过，补丁需重新生成并重录基线`,
    })
    if (patch.upstream?.baseVersion !== undefined && now.installed.appVersion !== patch.upstream.baseVersion) {
      checks.push({
        id: 'installed-version',
        ok: false,
        text: `补丁是为 DSH ${patch.upstream.baseVersion} 写的，现在装的是 ${now.installed.appVersion}：先确认补丁仍适用再重录`,
      })
    }
  }

  if (now.deployed === null) {
    checks.push({
      id: 'deployed',
      ok: false,
      text: `profile 里找不到 ${patch.deployed?.package ?? '(未知包)'} —— 修复没有部署，或 profile 被重装过`,
    })
  } else {
    const markers = patch.deployed?.markers ?? []
    const missing = markers.filter((marker) => now.deployed.libText === null || !now.deployed.libText.includes(marker))
    checks.push({
      id: 'deployed-fix',
      ok: missing.length === 0,
      text: missing.length === 0
        ? `部署产物确实带修复（标记齐全：${markers.join(', ')}；lib sha256 ${String(now.deployed.libSha256).slice(0, 12)}…）`
        : `部署产物不含修复标记：${missing.join(', ')} —— profile 被重装或降级了，修复已丢失，需要重新安装`,
    })
  }

  const failed = checks.filter((entry) => entry.ok === false)
  return { ok: failed.length === 0, checks, drifts: failed.map((entry) => entry.id) }
}

/** 在给定 DSH 检出上试应用补丁（不落盘）。 */
export function patchAppliesCleanly(sourceDir, patchPath, reverse = false) {
  try {
    execFileSync('git', ['-C', sourceDir, 'apply', ...(reverse ? ['-R'] : []), '--check', patchPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, message: '可干净应用' }
  } catch (error) {
    const detail = String(error.stderr ?? error.stdout ?? error.message ?? '').trim().split('\n').slice(0, 4).join(' / ')
    return { ok: false, message: detail === '' ? 'git apply --check 失败' : detail }
  }
}

/** 从补丁正文里取出它改到的文件（`+++ b/...`）。 */
export function patchTargets(patchText) {
  const targets = []
  for (const line of patchText.split('\n')) {
    const match = /^\+\+\+ b\/(.+)$/.exec(line.trim())
    if (match !== null) targets.push(match[1])
  }
  return [...new Set(targets)]
}

/** 打印人读报告。 */
function printReport(result) {
  for (const check of result.checks) {
    const mark = check.skipped === true ? '－' : check.ok === false ? '✘' : '✔'
    console.log(`  ${mark} ${check.text}`)
  }
}

/** 解析命令行参数（`--k=v` 与 `--flag` 两种）。 */
export function parseArgs(argv) {
  const MODES = ['check', 'apply', 'build', 'install', 'revert', 'record', 'list']
  const out = { mode: null, source: null, patch: null, strict: false, json: false }
  for (const raw of argv) {
    if (raw.startsWith('--') && MODES.includes(raw.slice(2))) {
      out.mode = raw.slice(2)
    } else if (raw === '--strict') out.strict = true
    else if (raw === '--json') out.json = true
    else if (raw.startsWith('--source=')) out.source = raw.slice('--source='.length)
    else if (raw.startsWith('--patch=')) out.patch = raw.slice('--patch='.length)
    else throw new Error(`不认识的参数：${raw}`)
  }
  return out
}

/**
 * 该补丁要构建哪个包（构建与安装共用这一条事实）。
 *
 * 从补丁正文的 `+++ b/...` 目标里取 `packages/<area>/<name>/…` 那一段：
 * 补丁改的是哪个包，就该构建哪个包 —— 写死一个包名会在有第二条补丁时悄悄编错东西。
 */
export function packageDirOf(patchEntry) {
  const targets = patchEntry.targets ?? []
  const found = new Set()
  for (const target of targets) {
    const match = /^packages\/([^/]+)\/([^/]+)\//.exec(target)
    if (match !== null) found.add(`packages/${match[1]}/${match[2]}`)
  }
  return found.size === 1 ? [...found][0] : null
}

/**
 * 在目标目录里跑一个命令，返回退出码与输出（失败不抛，交给调用方判定）。
 *
 * ★ Windows 上 `.cmd` / `.bat` **不能**被 `execFileSync` 直接执行：它既不报错也不执行，
 *   得到的是空输出 + 非零码 —— 于是"命令跑了但什么都没发生"会被误读成"构建工具本身失败"。
 *   所以这里对 `.cmd`/`.bat` 统一走 `cmd /c`。
 */
function runIn(cwd, command, args) {
  const isWindowsScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
  const file = isWindowsScript ? process.env.COMSPEC ?? 'cmd.exe' : command
  const argv = isWindowsScript ? ['/c', command, ...args] : args
  try {
    const out = execFileSync(file, argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (error) {
    return {
      code: typeof error.status === 'number' ? error.status : 1,
      out: String(error.stdout ?? '') + String(error.stderr ?? ''),
    }
  }
}

/**
 * 从**源码**构建补丁目标的 `lib/index.js`。
 *
 * 两步，缺一不可（顺序也是实测出来的）：
 *   1. `tsc -b <包目录> --force`：TypeScript 项目引用编译到 `lib/types/`
 *      —— 注意 `--force`：不做它的话，源码 mtime 变化有时不被判定为需要重建，
 *      于是你拿到的仍是上一次的产物（这种失败**不会报错**，只会让"构建过了"变成假话）。
 *   2. `tsdown -c patches/dsh/single-package.tsdown.config.mts`（cwd = 包目录）：
 *      按上游同款参数打包，依赖外置、产出 `lib/index.js`。
 */
export function buildProvider(source, patchEntry, patchPath) {
  const packageRel = packageDirOf(patchEntry)
  if (packageRel === null) {
    return { ok: false, message: `补丁目标里找不到唯一的 packages/<area>/<name>/（targets=${(patchEntry.targets ?? []).join(', ')}）` }
  }
  const packageDir = join(source, packageRel)
  if (!existsSync(join(packageDir, 'package.json'))) {
    return { ok: false, message: `目标包不存在：${packageRel}` }
  }
  // 构建前先确认这份检出**真的带着补丁**：否则编出来的是原版，
  // 而"装上去之后标记不见了"会被误读成部署失败。
  if (!patchAppliesCleanly(source, patchPath, true).ok) {
    return { ok: false, message: `该检出不是"已打补丁"的状态（反向应用不成立）：先 --apply --source=<检出>` }
  }
  const tscBin = join(source, 'node_modules', 'typescript', 'bin', 'tsc')
  if (!existsSync(tscBin)) return { ok: false, message: `找不到 ${tscBin}（该检出还没装依赖）` }
  const tsc = runIn(source, process.execPath, [tscBin, '-b', packageRel, '--pretty', 'false', '--force'])
  if (tsc.code !== 0) return { ok: false, message: `tsc 失败：${tsc.out.trim().split('\n').slice(-6).join(' / ')}` }

  const tsdown = join(source, 'node_modules', '.bin', process.platform === 'win32' ? 'tsdown.cmd' : 'tsdown')
  if (!existsSync(tsdown)) return { ok: false, message: `找不到 ${tsdown}（该检出还没装依赖）` }
  const bundle = runIn(packageDir, tsdown, [
    '-c', join(PATCH_DIR, 'single-package.tsdown.config.mts'), '--config-loader', 'native',
  ])
  if (bundle.code !== 0) return { ok: false, message: `tsdown 失败：${bundle.out.trim().split('\n').slice(-6).join(' / ')}` }

  const libPath = join(packageDir, 'lib', 'index.js')
  if (!existsSync(libPath)) return { ok: false, message: `构建完成但没有 ${packageRel}/lib/index.js` }
  const text = readFileSync(libPath, 'utf8')
  const markers = patchEntry.deployed?.markers ?? []
  const missing = markers.filter((marker) => !text.includes(marker))
  return {
    ok: true,
    packageDir: packageRel,
    libPath,
    bytes: Buffer.byteLength(text),
    sha256: sha256File(libPath),
    tscCode: tsc.code,
    tsdownCode: bundle.code,
    markersOk: missing.length === 0,
    missingMarkers: missing,
  }
}

/**
 * 把构建产物装进 profile。
 *
 * ★ 只覆盖 `lib/index.js`，并先备份：
 *   profile 里的 package.json 与依赖解析保持原样 —— 这样这次安装**不可能**
 *   因为重新解析依赖而破坏运行中的宿主，也使它本身可一键回退（把 .bak 拷回去）。
 */
export function installProvider(source, patchEntry, patchPath) {
  const packageRel = packageDirOf(patchEntry)
  if (packageRel === null) return { ok: false, message: '补丁目标里找不到唯一的包目录' }
  const packageName = patchEntry.deployed?.package
  if (typeof packageName !== 'string') return { ok: false, message: '基线里没有 deployed.package' }
  const built = buildProvider(source, patchEntry, patchPath)
  if (!built.ok) return { ok: false, message: `构建未通过，拒绝安装：${built.message}` }
  if (!built.markersOk) return { ok: false, message: `构建产物缺少补丁标记（${built.missingMarkers.join(', ')}），拒绝安装` }

  const deployed = deployedPackage(packageName)
  if (deployed === null) return { ok: false, message: `profile 里找不到 ${packageName}` }
  const target = join(deployed.dir, 'lib', 'index.js')
  if (!existsSync(target)) return { ok: false, message: `目标产物不存在：${target}` }
  const backup = `${target}.bak-legion-${new Date().toISOString().replace(/[:.]/g, '-')}`
  writeFileSync(backup, readFileSync(target))
  writeFileSync(target, readFileSync(built.libPath))
  const text = readFileSync(target, 'utf8')
  const markers = patchEntry.deployed?.markers ?? []
  const missing = markers.filter((marker) => !text.includes(marker))
  return {
    ok: true,
    profileRoot: deployed.profileRoot,
    libPath: target,
    backup,
    bytes: Buffer.byteLength(text),
    sha256: sha256File(target),
    markersOk: missing.length === 0,
    missingMarkers: missing,
  }
}

/** `--record`：把当前机器的事实写回基线（作者字段保留，只重录证据）。 */
function record(base) {
  const patchEntry = selectPatch(base)
  if (patchEntry === null) throw new Error('基线里没有可唯一确定的补丁')
  const patchRel = patchEntry.file
  const patchPath = join(PATCH_DIR, patchRel)
  if (!existsSync(patchPath)) throw new Error(`补丁文件不存在：${patchRel}`)
  const patchText = readFileSync(patchPath, 'utf8')
  const installed = installedDsh()
  const deployed = deployedPackage(patchEntry.deployed?.package ?? 'dsh-subagent-claude-code')

  const next = {
    ...base,
    recordedAt: new Date().toISOString(),
    patches: base.patches.map((entry) => entry.slug !== patchEntry.slug ? entry : {
      ...entry,
      sha256: sha256File(patchPath),
      bytes: readFileSync(patchPath).length,
      targets: patchTargets(patchText),
    }),
    installed: installed === null ? null : {
      asarPath: installed.asarPath,
      appVersion: installed.appVersion,
      asarSha256: installed.asarSha256,
    },
    deployed: deployed === null ? null : {
      ...base.deployed,
      profileRoot: deployed.profileRoot,
      version: deployed.version,
      libPath: deployed.libPath,
      libSha256: deployed.libSha256,
      markersPresent: (patchEntry.deployed?.markers ?? []).filter(
        (marker) => deployed.libText !== null && deployed.libText.includes(marker),
      ),
    },
  }
  writeFileSync(BASE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const base = loadBase()

  if (args.mode === 'list') {
    if (base === null) { console.log('  （还没有基线）'); return 0 }
    console.log(`  基线上游：${base.patches[0]?.upstream?.repo ?? UPSTREAM_REPO}`)
    for (const entry of base.patches) {
      console.log(`  · ${entry.slug}`)
      console.log(`      补丁 ${entry.file}`)
      console.log(`      对着 DSH ${entry.upstream?.baseVersion ?? '?'}（${String(entry.upstream?.baseCommit ?? '').slice(0, 12)}…）`)
      console.log(`      目标 ${(entry.targets ?? []).join(', ')}`)
    }
    return 0
  }

  if (args.mode === 'record') {
    if (base === null) { console.log('  ✘ 没有基线可重录'); return 1 }
    const next = record(base)
    console.log('  ✔ 已重录基线')
    console.log(`      已装 DSH：${next.installed?.appVersion ?? '(未找到)'}`)
    console.log(`      部署产物：${next.deployed?.version ?? '(未找到)'}  sha256 ${String(next.deployed?.libSha256 ?? '').slice(0, 12)}…`)
    console.log(`      标记齐全：${(next.deployed?.markersPresent ?? []).join(', ') || '(无)'}`)
    return 0
  }

  if (base === null) {
    console.log('  ✘ 没有 patches/dsh/base.json，先 --record 建立基线')
    return 1
  }

  const patchEntry = selectPatch(base, args.patch)
  if (patchEntry === null) {
    console.log('  ✘ 补丁无法唯一确定（用 --patch=<slug> 指定）')
    return 1
  }
  const patchPath = join(PATCH_DIR, patchEntry.file)

  if (args.mode === 'check') {
    const now = { installed: installedDsh(), deployed: deployedPackage(patchEntry.deployed?.package ?? 'dsh-subagent-claude-code') }
    const result = evaluateBase(base, now)
    printReport(result)
    if (args.source !== null) {
      const applied = patchAppliesCleanly(resolve(args.source), patchPath)
      console.log(`  ${applied.ok ? '✔' : '✘'} 补丁能落到该检出上：${applied.message}`)
      if (!applied.ok) result.ok = false
      const reversed = patchAppliesCleanly(resolve(args.source), patchPath, true)
      console.log(`  ${reversed.ok ? '✔' : '－'} 反向应用（说明该检出已是打过补丁的状态时会成立）：${reversed.message}`)
    } else {
      console.log('  － 未给 --source：跳过"补丁能否落到检出上"的检查')
    }
    if (args.strict && now.installed === null) {
      console.log('  ✘ --strict：找不到已装 DSH 也算失败')
      return 1
    }
    if (args.json) console.log(JSON.stringify(result, null, 2))
    return result.ok ? 0 : 1
  }

  if (args.mode === 'apply' || args.mode === 'revert' || args.mode === 'build' || args.mode === 'install') {
    if (args.source === null) {
      console.log('  ✘ 需要 --source=<DSH 检出>')
      return 1
    }
    const source = resolve(args.source)
    const branch = patchEntry.branch
    // 分支命名规则只约束 `--apply`（它会新建/切换分支）。
    // `--build` / `--install` 只是读该检出里的源码与产物，不改分支 ——
    // 但它们必须能确认"这份检出确实带着补丁"，否则构建出来的还是原版。
    if ((args.mode === 'apply' || args.mode === 'revert')
      && (typeof branch !== 'string' || !branch.startsWith('legion/'))) {
      console.log(`  ✘ 基线里的分支名 "${branch}" 不合规：补丁分支必须以 legion/ 开头（绝不允许落在 master/main 上）`)
      return 1
    }
    if (args.mode === 'apply' || args.mode === 'revert') {
      const dirty = execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
      if (dirty !== '') {
        console.log('  ✘ 检出有未提交改动，先提交或清理再操作（避免把别人的东西卷进补丁分支）')
        return 1
      }
    }

    if (args.mode === 'build') {
      const built = buildProvider(source, patchEntry, patchPath)
      if (!built.ok) {
        console.log(`  ✘ 构建失败：${built.message}`)
        return 1
      }
      console.log(`  ✔ 已构建 ${built.packageDir}`)
      console.log(`      lib/index.js = ${built.bytes}B  sha256 ${built.sha256.slice(0, 12)}…`)
      console.log(`      tsc ${built.tscCode === 0 ? 'ok' : 'FAIL'} / tsdown ${built.tsdownCode === 0 ? 'ok' : 'FAIL'}`)
      console.log(`      补丁标记齐全：${built.markersOk ? '是' : '否 —— 产物里找不到补丁痕迹，构建没有真正生效'}`)
      console.log('      下一步：node scripts/dsh-patch.mjs --install --source=<检出>')
      return built.markersOk ? 0 : 1
    }

    if (args.mode === 'install') {
      const installed = installProvider(source, patchEntry, patchPath)
      if (!installed.ok) {
        console.log(`  ✘ 安装失败：${installed.message}`)
        return 1
      }
      console.log(`  ✔ 已安装到 ${installed.profileRoot}`)
      console.log(`      lib/index.js = ${installed.bytes}B  sha256 ${installed.sha256.slice(0, 12)}…`)
      console.log(`      备份：${installed.backup}`)
      console.log(`      补丁标记齐全：${installed.markersOk ? '是' : '否'}`)
      console.log('      ⚠ 需要重启 DSH 宿主才会加载新产物；重启后跑 --record 重录部署证据')
      return installed.markersOk ? 0 : 1
    }

    if (args.mode === 'apply') {
      const dry = patchAppliesCleanly(source, patchPath)
      if (!dry.ok) {
        console.log(`  ✘ 补丁落不到这份检出上：${dry.message}`)
        console.log('     （基线与上游不一致时，应重新生成补丁并 --record，而不是硬套）')
        return 1
      }
      // 从不直接改 master/main：先建/切到补丁分支。
      const has = execFileSync('git', ['-C', source, 'branch', '--list', branch], { encoding: 'utf8' }).trim() !== ''
      execFileSync('git', ['-C', source, 'checkout', ...(has ? [] : ['-b']), branch], { stdio: 'inherit' })
      execFileSync('git', ['-C', source, 'apply', patchPath], { stdio: 'inherit' })
      console.log(`  ✔ 已应用到分支 ${branch}`)
      console.log('      下一步：在该检出里构建并安装到 profile（DSH 的构建链），然后 --record 更新部署证据')
      return 0
    }

    execFileSync('git', ['-C', source, 'checkout', branch], { stdio: 'inherit' })
    execFileSync('git', ['-C', source, 'apply', '-R', patchPath], { stdio: 'inherit' })
    console.log(`  ✔ 已从分支 ${branch} 反向应用（补丁已撤下，分支保留以便追溯）`)
    return 0
  }

  console.log('用法：--list | --check [--source=…] [--strict] | --apply --source=… | --build --source=… | --install --source=… | --revert --source=… | --record')
  return 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
