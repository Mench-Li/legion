// scripts/prt/topology-inventory.test.mjs — PRT-001/003 清单单测
//
// 重点：
//   ① 清单与当前仓库一致（拓扑/配置漂移会被发现）；
//   ② 复用既有扫描器而不是自带一份 env 正则——否则两份实现会漂移；
//   ③ 「默认路径落在安装目录内」这条判定真的会触发（不是永远返回空）；
//   ④ 明文凭证扫描只报路径、不读内容；
//   ⑤ diff 能定位到具体进程与字段。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROCESSES } from '../config/scan.mjs'
import { SCHEMA_FILES } from '../config/check.mjs'
import {
  DIR_CLASSES,
  buildInventory,
  diffInventories,
  findPlaintextCredentials,
} from './topology-inventory.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const INVENTORY = join(ROOT, 'docs', 'superpowers', 'prt', 'prt-001-003-inventory.json')

const load = () => JSON.parse(readFileSync(INVENTORY, 'utf8'))

// ---------------------------------------------------------------- ① 与现状对账

test('① 清单存在，且与当前拓扑/配置一致（无未记录漂移）', async () => {
  assert.ok(existsSync(INVENTORY), '缺少 prt-001-003-inventory.json，请先 --record')
  const current = await buildInventory()
  const lines = diffInventories(load(), current)
  assert.deepEqual(lines, [], `拓扑/配置已漂移但清单未刷新：\n${lines.join('\n')}`)
})

test('① 清单覆盖全部已登记进程', () => {
  const inv = load()
  const names = inv.processes.map((p) => p.name).sort()
  assert.deepEqual(names, Object.keys(PROCESSES).sort())
})

test('① 每个进程都有入口与就绪判据（不留空字段）', () => {
  const inv = load()
  for (const p of inv.processes) {
    assert.ok(p.label?.length > 0, `${p.name} 缺 label`)
    assert.ok(Array.isArray(p.entryPoints) && p.entryPoints.length > 0, `${p.name} 缺入口`)
    assert.ok(typeof p.readyProbe === 'string' && p.readyProbe.length > 0, `${p.name} 缺就绪判据`)
    assert.ok(typeof p.managedBy === 'string' && p.managedBy.length > 0, `${p.name} 缺托管关系`)
    assert.ok(p.dirs.length > 0, `${p.name} 缺扫描目录`)
  }
})

test('① 进程内插件不得被登记为监听端口的守护进程', () => {
  const inv = load()
  const byName = Object.fromEntries(inv.processes.map((p) => [p.name, p]))
  for (const name of ['plugins', 'board-plugin']) {
    assert.deepEqual(byName[name].ports, [], `${name} 是进程内插件，不应有端口`)
    assert.match(byName[name].readyProbe, /不适用/)
  }
})

test('① services-plugin 只托管 team-hub 与 workbench（whiteboard 不在内）', () => {
  const inv = load()
  const byName = Object.fromEntries(inv.processes.map((p) => [p.name, p]))
  assert.match(byName['services-plugin'].managedBy, /team-hub/)
  assert.match(byName['services-plugin'].managedBy, /workbench/)
  assert.match(byName['whiteboard'].managedBy, /不.*托管/)
})

// ---------------------------------------------------------------- ② 复用既有扫描器

test('② 配置面复用 scripts/config 的 Schema（单一权威实现）', () => {
  const inv = load()
  const byName = Object.fromEntries(inv.processes.map((p) => [p.name, p]))
  for (const [name, file] of Object.entries(SCHEMA_FILES)) {
    assert.equal(byName[name].schemaFile, file, `${name} 的 schemaFile 与 SCHEMA_FILES 不一致`)
    assert.equal(byName[name].schemaOk, true, `${name} 的 schema 未成功加载：${byName[name].schemaReason}`)
  }
})

test('② 每个已登记进程都在 SCHEMA_FILES 里（否则「缺口」是映射漏登记，不是真缺口）', () => {
  // 这条断言来自一次**真实事故**（PRT-251）：新增 `product` 进程时，
  // `scan.mjs` 与 `check.mjs` 各自有一份手写映射，只更新了其中一份。
  // 结果是 `scan --check` 说「全部已处理」，而本清单报出
  // 「product 的 8 个 LEGION_* 键未声明」——两份结论互相矛盾，两份都不可信。
  // 现在映射只有一份（`check.mjs` 的 SCHEMA_FILES，`scan.mjs` 委托它），
  // 这条断言负责保证**新增进程时必须同时给出 schema**。
  for (const name of Object.keys(PROCESSES)) {
    assert.ok(SCHEMA_FILES[name] !== undefined,
      `进程 ${name} 未在 SCHEMA_FILES 登记：要么它不该出现在 PROCESSES，要么它缺 config-schema`)
  }
})

test('② 声明缺口口径与 scan --check 一致（当前为 0）', () => {
  const inv = load()
  // P3-2 统一配置系统已收口：真实读取的 env 键全部在 Schema 中声明。
  // 若未来出现缺口，本断言会红——那时应先把缺口写入 spec §6.10 差距清单，而不是放宽断言。
  assert.deepEqual(inv.declarationGaps, [], '出现未声明 env 读取点，spec §6.10 差距清单需更新')
  for (const p of inv.processes) assert.deepEqual(p.undeclaredEnvKeys, [], `${p.name} 有未声明键`)
})

test('② env 读取点数量非零（防止扫描静默失效）', () => {
  const inv = load()
  const total = inv.processes.reduce((n, p) => n + p.envReadCount, 0)
  // 下限取 20 而不是贴近实测值：这条断言要防的是「扫描整体失效」（结果为 0 或个位数），
  // 不是「读取点少了一个」。贴着实测值设阈值会让每次正常清理都误报。
  assert.ok(total > 20, `env 读取点总数仅 ${total}，扫描可能已失效`)
  for (const p of inv.processes) {
    assert.equal(p.envReadKeys.length, p.envReadCount, `${p.name} 读取点计数与明细不符`)
  }
})

// ---------------------------------------------------------------- ③ 越界写入判定

test('③ 越界写入判定真的会触发（team-hub 默认库落在仓库内）', () => {
  const inv = load()
  const hub = inv.defaultPaths.find((d) => d.field === 'TEAM_HUB_DB')
  assert.ok(hub, '未登记 TEAM_HUB_DB 的默认路径')
  assert.equal(hub.resolvesInsideInstallDir, true)
  assert.match(hub.defaultValue, /team\.db$/)
})

test('③ 非 path 类型的字段不进入默认路径判定（避免误报）', () => {
  const inv = load()
  const fields = new Set(inv.defaultPaths.map((d) => d.field))
  // 端口/布尔/整数默认值不是写入目标
  for (const noise of ['TEAM_HUB_PORT', 'TEAM_HUB_HOST', 'CHAT_ATTACH_MAX_BYTES']) {
    assert.ok(!fields.has(noise), `${noise} 不是路径，不应出现在默认路径清单`)
  }
})

test('③ 越界项都带可执行的说明（不是只有布尔）', () => {
  const inv = load()
  for (const d of inv.defaultPaths) {
    assert.ok(d.process && d.field, '默认路径项缺进程或字段')
    assert.ok(typeof d.note === 'string' && d.note.length > 0, `${d.field} 缺说明`)
    assert.equal(typeof d.resolvesInsideInstallDir, 'boolean')
  }
})

// ---------------------------------------------------------------- ④ 密钥清单

test('④ 敏感字段按「拥有者」聚合，且不含任何值', () => {
  const inv = load()
  const owners = inv.secrets.owners
  assert.ok(Object.keys(owners).length > 0, '未登记任何敏感字段')
  assert.ok(owners.TEAM_HUB_TOKEN, 'TEAM_HUB_TOKEN 未登记')
  // 多个进程共享同一 token 是已知事实（workbench/board-plugin/services-plugin 都用它调 hub）
  assert.ok(owners.TEAM_HUB_TOKEN.length >= 2, 'TEAM_HUB_TOKEN 应有多个持有者')
  // 清单进版本库，绝不能带值
  const flat = JSON.stringify(inv.secrets)
  assert.doesNotMatch(flat, /"value"|"secret"\s*:/, '密钥清单不得包含值字段')
})

test('④ 明文凭证扫描只报路径、不读内容', () => {
  const res = findPlaintextCredentials()
  assert.equal(res.ok, true)
  assert.ok(Array.isArray(res.paths))
  // 测试夹具（good.env / bad.env）应被排除，不算真实凭证
  assert.ok(Array.isArray(res.fixturePaths))
  for (const p of res.paths) {
    assert.ok(!/fixtures?\//.test(p), `夹具 ${p} 被误判为真实凭证`)
  }
})

test('④ 当前仓库无明文凭证落盘（有则须登记为 PRT-505 迁移输入）', () => {
  const inv = load()
  assert.deepEqual(inv.secrets.plaintextOnDisk.paths, [], '发现明文凭证文件，需登记为 PRT-505 输入')
})

// ---------------------------------------------------------------- ⑤ 数据拓扑

test('⑤ 数据产物分类到五类目录之一', () => {
  const inv = load()
  const classes = new Set(Object.keys(DIR_CLASSES))
  assert.deepEqual(inv.dataTopology.files.length > 0, true, '未发现任何数据产物')
  for (const f of inv.dataTopology.files) {
    assert.ok(classes.has(f.class), `${f.path} 的分类 ${f.class} 不在五类目录中`)
    assert.ok(typeof f.note === 'string' && f.note.length > 0, `${f.path} 缺归属说明`)
  }
})

test('⑤ 被跟踪的数据产物都是 installDir 写入（这正是待迁移项）', () => {
  const inv = load()
  const inInstall = inv.dataTopology.files.filter((f) => f.class === 'InstallDir')
  assert.equal(inInstall.length, inv.dataTopology.files.length,
    '存在非 installDir 的已跟踪数据产物，需要新增分类规则')
  // 至少覆盖已知的两类来源
  assert.ok(inv.dataTopology.files.some((f) => f.path.startsWith('scratch/')), '缺 scratch/ 来源')
})

// ---------------------------------------------------------------- ⑥ diff

const MIN = (over = {}) => ({
  version: 1,
  processes: [
    { name: 'a', ports: [], sensitiveEnv: [], envReadKeys: ['X'], undeclaredEnvKeys: [], entryPoints: ['a.mjs'] },
  ],
  secrets: { owners: { T: ['a'] }, plaintextOnDisk: { paths: [] } },
  dataTopology: { files: [{ path: 'x.db', class: 'InstallDir', note: 'n' }] },
  ...over,
})

test('⑥ 无差异时返回空', () => {
  assert.deepEqual(diffInventories(MIN(), MIN()), [])
})

test('⑥ 新增进程与新增 env 读取点被列出', () => {
  const lines = diffInventories(MIN(), MIN({
    processes: [
      { name: 'a', ports: [], sensitiveEnv: [], envReadKeys: ['X', 'Y'], undeclaredEnvKeys: [], entryPoints: ['a.mjs'] },
      { name: 'b', ports: [], sensitiveEnv: [], envReadKeys: [], undeclaredEnvKeys: [], entryPoints: ['b.mjs'] },
    ],
  }))
  assert.ok(lines.some((l) => /\+ 进程: b/.test(l)), '未列出新增进程')
  assert.ok(lines.some((l) => /\+ a\.envReadKeys: Y/.test(l)), '未列出新增读取点')
})

test('⑥ 端口与敏感字段变化被列出', () => {
  const lines = diffInventories(MIN(), MIN({
    processes: [
      { name: 'a', ports: [{ env: 'P', default: 1 }], sensitiveEnv: ['S'], envReadKeys: ['X'], undeclaredEnvKeys: [], entryPoints: ['a.mjs'] },
    ],
  }))
  assert.ok(lines.some((l) => /a\.端口/.test(l)))
  assert.ok(lines.some((l) => /a\.敏感字段/.test(l)))
})

test('⑥ 数据产物与明文凭证的出现被列出', () => {
  const lines = diffInventories(MIN(), MIN({
    dataTopology: { files: [{ path: 'x.db', class: 'InstallDir', note: 'n' }, { path: 'y.db', class: 'InstallDir', note: 'n' }] },
    secrets: { owners: { T: ['a'] }, plaintextOnDisk: { paths: ['.env'] } },
  }))
  assert.ok(lines.some((l) => /\+ 数据产物: y\.db/.test(l)))
  assert.ok(lines.some((l) => /\+ 明文凭证文件: \.env/.test(l)))
})
