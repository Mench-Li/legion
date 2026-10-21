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
 *   node scripts/dsh-patch.mjs --revert --source=<dsh 检出> [--patch=<slug>]
 *   node scripts/dsh-patch.mjs --record          # 从当前机器重录基线证据（写 base.json）
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
  const out = { mode: null, source: null, patch: null, strict: false, json: false }
  for (const raw of argv) {
    if (raw === '--check' || raw === '--apply' || raw === '--revert' || raw === '--record' || raw === '--list') {
      out.mode = raw.slice(2)
    } else if (raw === '--strict') out.strict = true
    else if (raw === '--json') out.json = true
    else if (raw.startsWith('--source=')) out.source = raw.slice('--source='.length)
    else if (raw.startsWith('--patch=')) out.patch = raw.slice('--patch='.length)
    else throw new Error(`不认识的参数：${raw}`)
  }
  return out
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

  if (args.mode === 'apply' || args.mode === 'revert') {
    if (args.source === null) {
      console.log('  ✘ 需要 --source=<DSH 检出>')
      return 1
    }
    const source = resolve(args.source)
    const branch = patchEntry.branch
    if (typeof branch !== 'string' || !branch.startsWith('legion/')) {
      console.log(`  ✘ 基线里的分支名 "${branch}" 不合规：补丁分支必须以 legion/ 开头（绝不允许落在 master/main 上）`)
      return 1
    }
    const dirty = execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
    if (dirty !== '') {
      console.log('  ✘ 检出有未提交改动，先提交或清理再操作（避免把别人的东西卷进补丁分支）')
      return 1
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

  console.log('用法：--list | --check [--source=…] [--strict] | --apply --source=… | --revert --source=… | --record')
  return 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
