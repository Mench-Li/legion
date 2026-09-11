#!/usr/bin/env node
// scripts/prt/topology-inventory.mjs
// ============================================================================
// PRT-001 进程/组件/数据拓扑清单 + PRT-003 配置/密钥来源清单
//
// 一份可 diff 的机器清单，覆盖：
//   ① 进程拓扑：进程、入口、端口、配置 Schema、就绪判据、托管关系
//   ② 配置面：每个进程**已声明**的 env 字段（含默认值、是否敏感、对应 CLI 参数）
//   ③ 声明缺口：真实读取但未在 Schema 中声明的 env 键（spec §6.10 的差距清单）
//   ④ 密钥来源：敏感字段的拥有者与是否已有明文落盘
//   ⑤ 数据拓扑：数据库/附件/临时产物落在哪里，哪些越出了产品数据目录
//
// **刻意复用 scripts/config 的既有扫描器**（scanProcess / undeclaredReads /
// SCHEMA_FILES / loadSchemas）而不是重写一遍 env 读取正则：
//   「哪些 env 被真实读取」只应有一个权威实现。第二份实现会与第一份漂移，
//   而漂移的表现是「本清单说没有缺口、scan --check 说有缺口」——两份都不可信。
//
// 输出不含时间戳：清单要能逐字节 diff，时间戳会让每次都「有变化」。
//
// 用法：
//   node scripts/prt/topology-inventory.mjs --record   # 写入/刷新清单
//   node scripts/prt/topology-inventory.mjs --diff     # 与清单比较（默认）
//   node scripts/prt/topology-inventory.mjs --json
//   node scripts/prt/topology-inventory.mjs --help
// ============================================================================
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { PROCESSES, scanProcess, undeclaredReads } from '../config/scan.mjs'
import { SCHEMA_FILES } from '../config/check.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT_PATH = join(ROOT, 'docs', 'superpowers', 'prt', 'prt-001-003-inventory.json')
const rel = (p) => relative(ROOT, p).split(sep).join('/')

/**
 * 进程拓扑的**人工维护**部分：入口、就绪判据、托管关系。
 *
 * 这些无法从源码可靠推断（一个进程可能被多个入口以不同方式拉起），因此显式登记。
 * 显式登记的好处是「拓扑变了但清单没变」这件事本身可被发现——只要有人 diff 清单。
 */
const PROCESS_TOPOLOGY = Object.freeze({
  'team-hub': {
    entryPoints: ['team-hub/server.mjs'],
    readyProbe: 'tcp-connect',
    managedBy: 'services-plugin（Desktop）或手动；端口已占用则跳过启动',
    protocol: 'HTTP + SSE',
  },
  workbench: {
    entryPoints: ['workbench/scripts/serve.mjs'],
    readyProbe: 'tcp-connect',
    managedBy: 'services-plugin（Desktop）或手动',
    protocol: 'HTTP（静态资源 + 调用 hub 读接口）',
  },
  whiteboard: {
    entryPoints: ['whiteboard/apps/server/src/index.js'],
    readyProbe: 'tcp-connect',
    managedBy: '手动 / 独立子项目（services-plugin **不**托管）',
    protocol: 'HTTP + WebSocket',
  },
  plugins: {
    entryPoints: ['plugins/src/index.ts（宿主 composition 挂载）'],
    readyProbe: '不适用（进程内插件）',
    managedBy: 'DSH 宿主（cordis composition 行）',
    protocol: '进程内（无监听端口）',
  },
  'board-plugin': {
    entryPoints: ['board-plugin/src/index.ts（宿主 iframe 面板）'],
    readyProbe: '不适用（进程内插件）',
    managedBy: 'DSH 宿主（作为 iframe 面板挂载）',
    protocol: '进程内（无监听端口）',
  },
  'services-plugin': {
    entryPoints: ['services-plugin/index.js'],
    readyProbe: '不适用（自身即监管者）',
    managedBy: 'DSH 宿主；它再托管 team-hub 与 workbench',
    protocol: '进程内 + spawn 子进程',
  },
})

/** 产品目录分类（PRT-003 要求的五类归属）。 */
export const DIR_CLASSES = Object.freeze({
  InstallDir: '安装/源码目录：只读或可被升级覆盖，**不得**写入运行期数据',
  DataDir: '产品数据目录：数据库、附件等持久数据',
  Workspace: '工作区：被执行的仓库与 worktree',
  CacheDir: '缓存：可安全删除、可重建',
  LogDir: '日志：可轮转、可清理',
})

/** 数据产物分类规则（按路径判定，用于 §⑤ 数据拓扑）。 */
function classifyPath(p) {
  if (/^scratch\//.test(p)) return { class: 'InstallDir', note: '测试证据/临时产物，随仓库分发' }
  if (/^\.tmp-/.test(p)) return { class: 'InstallDir', note: '未清理的临时目录，落在仓库根' }
  if (/^docs\//.test(p)) return { class: 'InstallDir', note: '文档证据' }
  return { class: 'InstallDir', note: '未分类' }
}

/** 用 git 列出被跟踪的数据类产物（db/shm/wal/uploads）。 */
function trackedDataArtifacts() {
  let files = []
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    files = out.split('\0').filter(Boolean)
  } catch (err) {
    return { ok: false, reason: `git ls-files 失败：${err.message}`, files: [] }
  }
  const dataRe = /(\.db(-shm|-wal)?$)|(\/uploads\/)/
  const hits = files.filter((f) => dataRe.test(f))
  return {
    ok: true,
    files: hits.map((f) => ({ path: f, ...classifyPath(f) })).sort((a, b) => a.path.localeCompare(b.path)),
  }
}

/** 从各进程 Schema 取已声明字段与敏感字段。 */
async function readSchemas() {
  const out = {}
  for (const name of Object.keys(PROCESSES)) {
    const file = SCHEMA_FILES[name]
    if (!file) {
      out[name] = { ok: false, reason: '未在 SCHEMA_FILES 中登记' }
      continue
    }
    const abs = join(ROOT, file)
    if (!existsSync(abs)) {
      out[name] = { ok: false, reason: `schema 文件不存在：${file}` }
      continue
    }
    try {
      const mod = await import(pathToFileURL(abs).href)
      const S = mod.SCHEMA
      const fields = (S.fields ?? []).map((f) => ({
        key: f.key,
        env: f.env ?? null,
        cli: f.cli ?? null,
        type: f.type ?? null,
        default: f.default === undefined ? null : f.default,
        sensitive: f.sensitive === true,
        doc: f.doc ?? '',
      }))
      out[name] = {
        ok: true,
        file,
        process: S.process,
        title: S.title,
        prefixes: S.prefixes ?? [],
        fields,
        fieldCount: fields.length,
        envNames: typeof S.envNames === 'function' ? S.envNames() : [],
        secretKeys: typeof S.secretKeys === 'function' ? S.secretKeys() : [],
        foreignEnv: (S.foreignEnv ?? []).map((x) => (typeof x === 'string' ? x : x.name)),
        dynamicEnvReads: (S.dynamicEnvReads ?? []).map((x) => (typeof x === 'string' ? x : x.name)),
      }
    } catch (err) {
      out[name] = { ok: false, reason: `导入失败：${err.message}` }
    }
  }
  return out
}

/**
 * 默认写入目标是否落在安装/源码目录内。
 *
 * 这是 PRT-003 点名要找的「越界写入」：安装目录会被升级覆盖，
 * 数据写进去要么丢失、要么阻止升级。因此只判定**默认值**，
 * 显式配置的绝对路径由部署方保证。
 */
function analyzeDefaultPaths(process, schema) {
  const findings = []
  if (!schema?.ok) return findings
  for (const f of schema.fields) {
    if (f.type !== 'path') continue
    const def = f.default
    if (typeof def !== 'string' || def === '') continue
    const insideRepo = !isAbsolute(def) && !def.startsWith('~') && !def.startsWith('$')
    findings.push({
      process,
      field: f.env ?? f.key,
      defaultValue: def,
      resolvesInsideInstallDir: insideRepo,
      note: insideRepo
        ? '默认落在仓库/安装目录内 → 属 installDir 写入，应由 DataDir 承接'
        : '默认不在安装目录内',
    })
  }
  return findings
}

/** 生成清单。 */
export async function buildInventory() {
  const schemas = await readSchemas()
  const processes = []
  const declarationGaps = []
  const defaultPathFindings = []

  for (const [name, spec] of Object.entries(PROCESSES)) {
    const schema = schemas[name]
    const scan = scanProcess(name, { onlyTracked: true })
    // schema.envNames 已在 readSchemas 中求值为数组（SCHEMA.envNames() 是函数）
    const declaredEnv = schema?.ok ? schema.envNames : []
    const undeclared = schema?.ok ? undeclaredReads(scan, declaredEnv) : [...scan.reads.keys()].sort()

    const topo = PROCESS_TOPOLOGY[name] ?? {}
    const ports = schema?.ok
      ? schema.fields.filter((f) => /port/i.test(f.env ?? f.key)).map((f) => ({ env: f.env, default: f.default }))
      : []
    const sensitive = schema?.ok ? schema.fields.filter((f) => f.sensitive).map((f) => f.env ?? f.key) : []

    processes.push({
      name,
      label: spec.label,
      dirs: spec.dirs,
      schemaFile: schema?.ok ? schema.file : null,
      schemaOk: schema?.ok === true,
      schemaReason: schema?.ok ? null : schema?.reason ?? 'unknown',
      entryPoints: topo.entryPoints ?? [],
      readyProbe: topo.readyProbe ?? null,
      managedBy: topo.managedBy ?? null,
      protocol: topo.protocol ?? null,
      ports,
      sensitiveEnv: sensitive,
      declaredFieldCount: schema?.ok ? schema.fieldCount : 0,
      envReadKeys: [...scan.reads.keys()].sort(),
      envReadCount: scan.reads.size,
      undeclaredEnvKeys: undeclared,
      filesScanned: scan.filesScanned,
    })

    if (undeclared.length > 0) {
      declarationGaps.push({ process: name, keys: undeclared })
    }
    defaultPathFindings.push(...analyzeDefaultPaths(name, schema))
  }

  // 密钥来源：按「一个 secret 被哪些进程持有」聚合，并标注是否已有明文落盘
  const secretOwners = {}
  for (const p of processes) {
    for (const key of p.sensitiveEnv) {
      secretOwners[key] = secretOwners[key] ?? []
      secretOwners[key].push(p.name)
    }
  }
  const plaintextFindings = findPlaintextCredentials()

  return {
    $comment:
      'PRT-001/003 拓扑与配置清单。由 scripts/prt/topology-inventory.mjs 生成；' +
      '不含时间戳以便逐字节 diff。env 读取点复用 scripts/config/scan.mjs（唯一权威实现）。',
    version: 1,
    dirClasses: DIR_CLASSES,
    processes,
    declarationGaps,
    secrets: {
      $comment: '敏感配置字段的拥有者。明文不落盘：只登记键名与拥有者，不登记值。',
      owners: secretOwners,
      plaintextOnDisk: plaintextFindings,
    },
    defaultPaths: defaultPathFindings,
    dataTopology: trackedDataArtifacts(),
  }
}

/**
 * 扫描仓库内是否有明文凭证文件。
 *
 * 只报告**路径**，永不读取或输出文件内容——本工具的清单会进版本库，
 * 把疑似密钥的值写进清单等于把问题放大一次。
 */
export function findPlaintextCredentials() {
  let files = []
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    files = out.split('\0').filter(Boolean)
  } catch {
    return { ok: false, reason: 'git ls-files 失败', paths: [] }
  }
  const suspect = /(^|\/)(\.credentials[^/]*|\.env|\.env\.[^/]+|credentials\.(json|ya?ml)|secrets?\.(json|ya?ml))$/i
  // 排除测试夹具：它们是故意构造的样例，不是真实凭证
  const isFixture = (p) => /(^|\/)(fixtures?|__fixtures__)\//.test(p) || /\.(example|sample|template)$/i.test(p)
  const paths = files.filter((f) => suspect.test(f) && !isFixture(f)).sort()
  const fixturePaths = files.filter((f) => suspect.test(f) && isFixture(f)).sort()
  return { ok: true, paths, fixturePaths }
}

// ---------------------------------------------------------------- diff

export function diffInventories(before, after) {
  const lines = []
  const beforeNames = new Set((before.processes ?? []).map((p) => p.name))
  const afterNames = new Set((after.processes ?? []).map((p) => p.name))
  for (const n of afterNames) if (!beforeNames.has(n)) lines.push(`  + 进程: ${n}`)
  for (const n of beforeNames) if (!afterNames.has(n)) lines.push(`  - 进程: ${n}`)

  const byName = (inv) => Object.fromEntries((inv.processes ?? []).map((p) => [p.name, p]))
  const b = byName(before)
  const a = byName(after)
  for (const n of [...afterNames].filter((x) => beforeNames.has(x)).sort()) {
    const bp = b[n]
    const ap = a[n]
    const cmp = (field, label) => {
      const bv = JSON.stringify(bp[field] ?? null)
      const av = JSON.stringify(ap[field] ?? null)
      if (bv !== av) lines.push(`  ~ ${n}.${label}: ${bv} -> ${av}`)
    }
    cmp('ports', '端口')
    cmp('sensitiveEnv', '敏感字段')
    for (const field of ['envReadKeys', 'undeclaredEnvKeys']) {
      const bv = bp[field] ?? []
      const av = ap[field] ?? []
      for (const k of av) if (!bv.includes(k)) lines.push(`  + ${n}.${field}: ${k}`)
      for (const k of bv) if (!av.includes(k)) lines.push(`  - ${n}.${field}: ${k}`)
    }
    cmp('entryPoints', '入口')
  }

  const bd = new Set((before.dataTopology?.files ?? []).map((f) => f.path))
  const ad = new Set((after.dataTopology?.files ?? []).map((f) => f.path))
  for (const p of ad) if (!bd.has(p)) lines.push(`  + 数据产物: ${p}`)
  for (const p of bd) if (!ad.has(p)) lines.push(`  - 数据产物: ${p}`)

  const bp2 = new Set((before.secrets?.plaintextOnDisk?.paths ?? []))
  const ap2 = new Set((after.secrets?.plaintextOnDisk?.paths ?? []))
  for (const p of ap2) if (!bp2.has(p)) lines.push(`  + 明文凭证文件: ${p}`)
  for (const p of bp2) if (!ap2.has(p)) lines.push(`  - 明文凭证文件: ${p}`)
  return lines
}

function usage() {
  console.log('topology-inventory.mjs — PRT-001 拓扑 / PRT-003 配置与密钥清单')
  console.log('')
  console.log('  --record   写入/刷新清单')
  console.log('  --diff     与清单比较（默认）')
  console.log('  --json     打印当前清单')
  console.log('  --help     本说明')
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) return usage()

  const inv = await buildInventory()

  if (argv.includes('--json')) {
    console.log(JSON.stringify(inv, null, 2))
    return
  }
  if (argv.includes('--record')) {
    writeFileSync(OUT_PATH, JSON.stringify(inv, null, 2) + '\n', 'utf8')
    console.log(`清单已写入 ${rel(OUT_PATH)}`)
    console.log(`  进程 ${inv.processes.length} 个；声明缺口 ${inv.declarationGaps.length} 个；` +
      `敏感字段 ${Object.keys(inv.secrets.owners).length} 个；数据产物 ${inv.dataTopology.files.length} 个`)
    return
  }
  if (!existsSync(OUT_PATH)) {
    console.error(`未找到清单 ${rel(OUT_PATH)}。先运行 --record。`)
    process.exit(2)
  }
  const before = JSON.parse(readFileSync(OUT_PATH, 'utf8'))
  const lines = diffInventories(before, inv)
  if (lines.length === 0) {
    console.log('topology-inventory: 与清单一致（无漂移）')
    return
  }
  console.log('topology-inventory: 检测到拓扑/配置漂移')
  console.log(lines.join('\n'))
  console.log('')
  console.log('  若确为有意变更，运行 --record 刷新清单并在提交信息中说明。')
  process.exit(1)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`FAIL ${err.message}`)
    process.exit(2)
  })
}
