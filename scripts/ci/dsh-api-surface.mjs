#!/usr/bin/env node
/**
 * DSH **代际一致性**门禁：编译期类型与运行期实现必须存在同一套 API。
 *
 * ## 为什么需要它（真实故障，2026-10-20）
 *
 * Legion 的插件对着 `plugins/node_modules/@deepseek-ai/dsh-subagent` 的**类型**编译，
 * 而真正在桌面端加载的是安装产物里那份 DSH。两者一度不是同一代：
 *
 *   · 编译期（0.2.1-alpha.1）：服务上只有 `start(name, request)`
 *   · 运行期（0.2.1-rc.2）  ：服务上只有 `startActivation(spec)`
 *
 * 于是 `tsc` 全绿，运行期炸在 `TypeError: <服务>.start is not a function`。
 *
 * > 一个"编译期通过、运行期缺少方法"的调用，
 * > 在类型检查里与一个正确的调用逐字相同 ——
 * > 区别只在真的去调它的那一次。
 *
 * 类型检查器不可能发现这件事：它信任 `node_modules` 里的 `.d.ts`，而那份
 * `.d.ts` 描述的是**另一代**的运行时。
 *
 * ## 判据（只认一件事，且它能精确抓住上面那个故障）
 *
 * 对每个"替代组"（同一能力的不同代名字，例如 `startActivation` / `start`）：
 *
 *   编译期 ∩ 运行期 ≠ ∅
 *
 * 历史故障里那个交集**恰好是空集**：一侧只有 `start`、另一侧只有 `startActivation`。
 * 同时每个 `required` 成员必须在两侧都存在（Legion 无条件调用的那些）。
 *
 * ## 退出码（沿用 `scripts/prt/dsh-pin-drift.mjs` 的既有约定）
 *
 *   0  一致（或未观察到，见下）
 *   1  不一致 —— 编译期与运行期不是一代，改动会以"运行期缺方法"的形式炸掉
 *   2  脚本自身出错
 *   3  **未观察到**：找不到已装 DSH（没有可比对的运行期）
 *
 * ★ 3 与 0 的区别是刻意的：「没接」不等于「通过」。
 *   `--strict` 时 3 也按失败处理（用于"这台机器必须装着 DSH"的场合）。
 *
 * ## 用法
 *
 *   node scripts/ci/dsh-api-surface.mjs                 # 人读报告
 *   node scripts/ci/dsh-api-surface.mjs --json          # 机器读
 *   node scripts/ci/dsh-api-surface.mjs --strict        # 未观察到也算失败
 *   node scripts/ci/dsh-api-surface.mjs --asar=<path>   # 指定已装产物
 *
 * 零第三方依赖（只 node: 内置）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Legion 实际依赖的 DSH 执行面成员。
 *
 * ★ 这张表必须与**代码里真的调用**一致（`scripts/ci/dsh-api-surface.test.mjs`
 *   会核对 `runtime/adapters/dsh/subagent-client.mjs` 与
 *   `plugins/src/subagentStart.ts` 是否仍然只调用这些名字）：
 *   表比代码宽 → 无谓的红；表比代码窄 → 新调用的那个成员没人守。
 *
 * `alternatives`：同一能力的不同代名字，两侧**至少有交集**即可。
 * `required`    ：Legion 无条件调用，两侧都必须有。
 */
export const CONTRACTS = [
  {
    package: 'dsh-subagent',
    // 取服务的方式：服务上的 `list()` / `.getProvider(name)`
    required: ['list', 'getProvider'],
    // 启动子 Agent：旧代 start(name, req) / 新代 startActivation(spec)
    alternatives: [['startActivation', 'start']],
    serviceName: 'subagents',
    serviceMembers: ['list', 'getProvider'],
  },
]

/**
 * 本门禁**检查的**两个 API 名（两代跑的是同一批名字），拼进报告文案用。
 *
 * 这里不写 `ctx.` + 服务名前缀：那正好是边界棘轮（PRT-108）认的执行面记号，
 * 而本文件只是**读文本比对**，不是调服务。
 */
export const API_NAMES = [...new Set(CONTRACTS.flatMap((contract) => [
  ...(contract.required ?? []),
  ...(contract.alternatives ?? []).flat(),
]))]

/** 已装 DSH 产物的候选路径（环境变量优先，其次平台默认）。 */
export function asarCandidates(env = process.env) {
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

/** 去掉注释：避免"文里提过某个名字"被当成"实现了它"（本仓已踩过同类假阳性）。 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 某个方法名是否**以声明/方法形式**出现（`name (` 且前面不是 `.`）。 */
export function methodPresent(text, name) {
  return new RegExp(`(^|[^.\\w])${name}\\s*\\(`, 'm').test(stripComments(text))
}

/** 读 asar 目录表并返回切片读取器。 */
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
    find: (path) => files.find((entry) => entry.path === path),
    read: (entry) => bytes.subarray(base + entry.offset, base + entry.offset + entry.size),
  }
}

/** 找编译期的类型声明（`.d.ts`）：取本仓第一个装着的副本。 */
export function compileTypesPath(packageName, root = ROOT) {
  const candidates = ['plugins', 'workbench', 'services-plugin', 'board-plugin']
    .map((dir) => join(root, dir, 'node_modules', '@deepseek-ai', packageName, 'lib', 'types', 'index.d.ts'))
  return candidates.find((path) => existsSync(path)) ?? null
}

/**
 * 找运行期实现正文：优先已装 asar，其次 asar.unpacked 目录。
 * @returns `{ text, from }` 或 null（= 未观察到）
 */
export function runtimeImplText(packageName, options = {}) {
  const env = options.env ?? process.env
  const candidates = options.asarPath === undefined ? asarCandidates(env) : [options.asarPath]
  for (const candidate of candidates) {
    const asarPath = resolve(candidate)
    if (!existsSync(asarPath)) continue
    try {
      const asar = openAsar(asarPath)
      const entry = asar.find(`/dsh/node_modules/@deepseek-ai/${packageName}/lib/index.js`)
      if (entry === undefined) continue
      return { text: asar.read(entry).toString('utf8'), from: asarPath }
    } catch {
      // 坏 asar 与"没有"同样不可用：继续找，最后按未观察处理（不抛）。
    }
    const unpacked = join(dirname(asarPath), 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', packageName, 'lib', 'index.js')
    if (existsSync(unpacked)) return { text: readFileSync(unpacked, 'utf8'), from: unpacked }
  }
  return null
}

/**
 * 比较一代的 API 面（**纯函数**，单测靠它）。
 *
 * @param contract - `{ required, alternatives }`
 * @param compileText - 编译期 `.d.ts` 正文
 * @param runtimeText - 运行期实现正文
 * @returns `{ ok, findings }`；findings 每项 `{ id, ok, text }`
 */
export function compareSurface(contract, compileText, runtimeText) {
  const findings = []
  for (const name of contract.required ?? []) {
    const inCompile = methodPresent(compileText, name)
    const inRuntime = methodPresent(runtimeText, name)
    findings.push({
      id: `required:${name}`,
      ok: inCompile && inRuntime,
      text: `${name}()：编译期 ${inCompile ? '有' : '无'} / 运行期 ${inRuntime ? '有' : '无'}`
        + (inCompile && inRuntime ? '' : ' —— Legion 无条件调用它，缺一侧就是运行期崩'),
    })
  }
  for (const group of contract.alternatives ?? []) {
    const inCompile = group.filter((name) => methodPresent(compileText, name))
    const inRuntime = group.filter((name) => methodPresent(runtimeText, name))
    const shared = inCompile.filter((name) => inRuntime.includes(name))
    findings.push({
      id: `alternatives:${group.join('|')}`,
      ok: shared.length > 0,
      text: shared.length > 0
        ? `两代替身 ${group.join(' / ')}：共同可用 ${shared.join(', ')}`
        : `两代替身 ${group.join(' / ')}：编译期 {${inCompile.join(', ') || '无'}} ∩ 运行期 {${inRuntime.join(', ') || '无'}} = ∅`
          + ` —— 这就是 2026-10-20 那次 \`<服务>.start is not a function\`：`
          + '编译期只认旧名、运行期只有新名',
    })
  }
  return { ok: findings.every((finding) => finding.ok), findings }
}

/** 跑一份合约，返回结果与"是否观察到运行期"。 */
export function scan(contract, options = {}) {
  const compilePath = compileTypesPath(contract.package, options.root ?? ROOT)
  if (compilePath === null) {
    return { contract, observed: false, reason: `本仓没有装着 @deepseek-ai/${contract.package} 的类型（编译期一侧缺失）`, findings: [] }
  }
  const runtime = runtimeImplText(contract.package, options)
  if (runtime === null) {
    return { contract, observed: false, reason: '找不到已装 DSH 产物（设 DSH_APP_ASAR / DSH_INSTALL_DIR）', findings: [] }
  }
  const compileText = readFileSync(compilePath, 'utf8')
  const compared = compareSurface(contract, compileText, runtime.text)
  return {
    contract,
    observed: true,
    compilePath,
    runtimeFrom: runtime.from,
    findings: compared.findings,
    ok: compared.ok,
  }
}

function main() {
  const argv = process.argv.slice(2)
  const strict = argv.includes('--strict')
  const json = argv.includes('--json')
  const asarArg = argv.find((raw) => raw.startsWith('--asar='))
  const options = asarArg === undefined ? {} : { asarPath: asarArg.slice('--asar='.length) }

  const results = CONTRACTS.map((contract) => scan(contract, options))
  const unobserved = results.filter((result) => result.observed === false)
  const mismatched = results.filter((result) => result.observed === true && result.ok !== true)

  if (json) {
    console.log(JSON.stringify({ results, unobserved: unobserved.length, mismatched: mismatched.length, strict }, null, 2))
  } else {
    for (const result of results) {
      if (result.observed === false) {
        console.log(`  － @deepseek-ai/${result.contract.package}：未观察 —— ${result.reason}`)
        continue
      }
      const mark = result.ok ? '✔' : '✘'
      console.log(`  ${mark} @deepseek-ai/${result.contract.package}`)
      console.log(`      编译期：${result.compilePath}`)
      console.log(`      运行期：${result.runtimeFrom}`)
      for (const finding of result.findings) console.log(`      ${finding.ok ? '✔' : '✘'} ${finding.text}`)
    }
  }

  if (mismatched.length > 0) {
    if (!json) {
      console.log('')
      console.log('  dsh-api-surface: FAIL（编译期与运行期不是一代）')
      console.log(`  涉及的 API 名：${API_NAMES.join(', ')}`)
      console.log('  修法：把依赖装成与已装 DSH 同一代（或对着已装那份的 d.ts 编译），')
      console.log('        并用适配层吸收两代差异（runtime/adapters/dsh/subagent-start.mjs 就是这么做的）。')
    }
    return 1
  }
  if (unobserved.length > 0) {
    if (!json) {
      console.log('')
      console.log(`  dsh-api-surface: SKIP（未观察：${unobserved.length}/${results.length} 份合约没有可比的运行期）`)
      if (strict) console.log('  ✘ --strict：未观察到也算失败')
    }
    return strict ? 1 : 3
  }
  if (!json) console.log('\n  dsh-api-surface: PASS（编译期与运行期同一套 API）')
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`  dsh-api-surface: ERROR ${String(error?.message ?? error)}`)
    process.exitCode = 2
  }
}
