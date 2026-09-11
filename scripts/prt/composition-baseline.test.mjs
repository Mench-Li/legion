// scripts/prt/composition-baseline.test.mjs — PRT-010 组合基线单测
//
// 重点：
//   ① patch 解析器能正确认出 insert 行 / config 键 / 空值键 / disabled；
//   ② 解析不出行时**抛错**而不是产出空基线；
//   ③ 快照不含 config 值与绝对路径（这是它能进版本库的前提）；
//   ④ 与当前 DSH_HOME 一致（漂移可发现）——DSH_HOME 不可用时跳过并说明。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LEGION_PACKAGES,
  buildCompositionBaseline,
  diffBaselines,
  legionRows,
  parsePatch,
  readProfilePackage,
  resolvePaths,
} from './composition-baseline.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const BASELINE = join(ROOT, 'docs', 'superpowers', 'prt', 'prt-010-composition-baseline.json')

const SAMPLE = `# a comment line
- insert:
    # nested comment
    - id: legion-team-hub
      name: '@dsh-external/dsh-team-hub'
      config:
        scrumDir: '/somewhere'
        routePrefix: '/team-hub'
        teamToken: ''
        members: []
        scopes: {}

    - id: legion-scrum-worker
      name: '@dsh-external/dsh-scrum-worker'
      config:
        role: 'soldier-auto'
        hubToken: ''
        denyTools: []

- id: system-prompt
  config:
    personaPrefix: >-
      hello
    personaSuffix: 'x'
`

// ---------------------------------------------------------------- ① 解析

test('① 解析出 insert 行及其 config 键', () => {
  const entries = parsePatch(SAMPLE)
  const insert = entries.find((e) => e.kind === 'insert')
  assert.ok(insert, '未解析出 insert 条目')
  assert.equal(insert.rows.length, 2)
  const hub = insert.rows.find((r) => r.id === 'legion-team-hub')
  assert.equal(hub.name, '@dsh-external/dsh-team-hub')
  assert.deepEqual(hub.configKeys, ['members', 'routePrefix', 'scopes', 'scrumDir', 'teamToken'])
})

test('① 空值键被单独标出（凭证/清单为空是真实风险信号）', () => {
  const entries = parsePatch(SAMPLE)
  const hub = entries.find((e) => e.kind === 'insert').rows.find((r) => r.id === 'legion-team-hub')
  assert.deepEqual(hub.emptyConfigKeys, ['members', 'scopes', 'teamToken'])
})

test('① 顶层 override 条目（非 insert）也被解析', () => {
  const entries = parsePatch(SAMPLE)
  const ov = entries.find((e) => e.kind === 'override')
  assert.ok(ov, '未解析出顶层 override')
  assert.equal(ov.id, 'system-prompt')
  assert.deepEqual(ov.configKeys, ['personaPrefix', 'personaSuffix'])
})

test('① config 只收一级键（嵌套结构的子键不混入）', () => {
  const entries = parsePatch(`
- insert:
    - id: x
      name: '@dsh-external/x'
      config:
        outer:
          inner: 1
        flat: 2
`)
  const row = entries[0].rows[0]
  assert.ok(row.configKeys.includes('outer'))
  assert.ok(row.configKeys.includes('flat'))
  assert.ok(!row.configKeys.includes('inner'), '嵌套子键不应进入一级键集合')
})

test('① disabled 标志可被读出', () => {
  const entries = parsePatch(`
- insert:
    - id: hmr
      name: '@deepseek-ai/cordis-plugin-hmr'
      disabled: true
`)
  assert.equal(entries[0].rows[0].disabled, true)
})

test('① 行尾注释不影响键解析', () => {
  const entries = parsePatch(`
- insert:
    - id: a
      name: '@dsh-external/a'
      config:
        key: 'v' # trailing note
`)
  assert.deepEqual(entries[0].rows[0].configKeys, ['key'])
})

test('① 只挑出 Legion 行，DSH 基础行不混入', () => {
  const entries = parsePatch(SAMPLE)
  const rows = legionRows(entries)
  assert.deepEqual(rows.map((r) => r.id).sort(), ['legion-scrum-worker', 'legion-team-hub'])
})

test('① Legion 行带上仓库内目录归属（排障要知道它对应哪个目录）', () => {
  const rows = legionRows(parsePatch(SAMPLE))
  const hub = rows.find((r) => r.id === 'legion-team-hub')
  assert.equal(hub.repoDir, 'team-hub')
  assert.equal(LEGION_PACKAGES['@dsh-external/dsh-team-hub'], 'team-hub')
})

// ---------------------------------------------------------------- ② 失败要响

test('② 空文件与纯注释文件解析出 0 条目（调用方据此判定采集失败）', () => {
  assert.deepEqual(parsePatch(''), [])
  assert.deepEqual(parsePatch('# only comments\n'), [])
  // 真实组合里若一条也解析不出，buildCompositionBaseline 会抛错（见下一个用例）
})

test('② profile 的 package.json 缺失时返回可读原因而非抛错', () => {
  const res = readProfilePackage(join(ROOT, 'definitely-not-here.json'))
  assert.equal(res.ok, false)
  assert.match(res.reason, /找不到/)
})

test('② package.json 非法 JSON 时返回可读原因', () => {
  const res = readProfilePackage(join(ROOT, 'package.json.nonexistent'))
  assert.equal(res.ok, false)
})

test('② DSH_HOME 下没有该 profile 时抛错（不静默产出空基线）', () => {
  assert.throws(
    () => buildCompositionBaseline({ dshHome: join(ROOT, '__no_such_dsh_home__'), profile: 'web' }),
    /找不到用户层组合/,
  )
})

// ---------------------------------------------------------------- ③ 快照卫生

test('③ 路径解析：DSH_HOME 可被显式覆盖', () => {
  const p = resolvePaths({ dshHome: 'C:/tmp/dsh', profile: 'web' })
  assert.equal(p.profileName ?? p.profile, 'web')
  assert.ok(p.patchFile.replace(/\\/g, '/').endsWith('C:/tmp/dsh/profiles/web/cordis.patch.yml'))
})

test('③ 已记录基线不含 config 值、绝对路径或时间戳', () => {
  const raw = readFileSync(BASELINE, 'utf8')
  const j = JSON.parse(raw)
  assert.doesNotMatch(raw, /D:\//, '基线泄漏了绝对路径')
  assert.doesNotMatch(raw, /file:D:/, '基线泄漏了 file: 依赖的绝对路径')
  assert.doesNotMatch(raw, /\d{4}-\d{2}-\d{2}T/, '基线含时间戳，会让每次 diff 假红')
  // 只应有键名与布尔，不应有 config 的取值
  for (const row of j.legionRows) {
    assert.ok(Array.isArray(row.configKeys), `${row.id} 缺 configKeys`)
    assert.ok(Array.isArray(row.emptyConfigKeys), `${row.id} 缺 emptyConfigKeys`)
    assert.equal(row.config, undefined, `${row.id} 不应带 config 值`)
  }
})

// ---------------------------------------------------------------- ④ 与现状对账

const haveProfile = existsSync(resolvePaths({ profile: 'web' }).patchFile)

test('④ 已记录基线存在且结构完整', () => {
  assert.ok(existsSync(BASELINE), '缺少 prt-010-composition-baseline.json，请先 --record')
  const j = JSON.parse(readFileSync(BASELINE, 'utf8'))
  assert.ok(Array.isArray(j.bundles) && j.bundles.length >= 2, 'bundles 至少含 base + 一个模式 bundle')
  assert.equal(j.bundles[0], '@deepseek-ai/dsh-base', '第一层必须是 dsh-base')
  assert.ok(j.legionRows.length >= 5, 'Legion 行少于 5 个，采集可能不完整')
  assert.ok(j.legionDeps.length >= 4, 'file: 依赖少于 4 个')
  assert.equal(j.profileRootIsEmptyList, true, 'profile 根应为空列表（整树由 patch 链合成）')
})

test('④ Legion 的每个包都指向本仓库对应目录', () => {
  const j = JSON.parse(readFileSync(BASELINE, 'utf8'))
  for (const d of j.legionDeps) {
    assert.equal(d.isFileDependency, true, `${d.name} 不是 file: 依赖，挂载形态变了`)
    assert.equal(d.pointsAtRepoDir, true, `${d.name} 未指向仓库内 ${d.repoDir} 目录`)
  }
})

test('④ 组合层顺序包含 dsh-base 与用户层', () => {
  const j = JSON.parse(readFileSync(BASELINE, 'utf8'))
  const layers = j.layers.map((l) => l.layer)
  assert.equal(layers[0], 'dsh-base')
  assert.ok(layers.includes('用户 profile 层'), '缺用户层')
  assert.equal(j.patchReload, 'live', 'patchReload 应为 live（组合改动热生效）')
})

test('④ 与当前 DSH_HOME 一致（不可用时跳过并说明原因）', { skip: haveProfile ? false : '本机无 DSH_HOME/profiles/web，跳过核对' }, () => {
  const current = buildCompositionBaseline({ profile: 'web' })
  const lines = diffBaselines(JSON.parse(readFileSync(BASELINE, 'utf8')), current)
  assert.deepEqual(lines, [], `组合已漂移但基线未刷新：\n${lines.join('\n')}`)
})

// ---------------------------------------------------------------- ⑤ diff

const MIN = (over = {}) => ({
  version: 1,
  bundles: ['@deepseek-ai/dsh-base'],
  legionRows: [{ id: 'r1', package: 'p', configKeys: ['a'], emptyConfigKeys: [] }],
  legionDeps: [{ name: 'n', isFileDependency: true, repoDir: 'd', pointsAtRepoDir: true }],
  ...over,
})

test('⑤ 无差异时返回空', () => {
  assert.deepEqual(diffBaselines(MIN(), MIN()), [])
})

test('⑤ 新增组合行被列出', () => {
  const lines = diffBaselines(MIN(), MIN({
    legionRows: [
      { id: 'r1', package: 'p', configKeys: ['a'], emptyConfigKeys: [] },
      { id: 'r2', package: 'q', configKeys: [], emptyConfigKeys: [] },
    ],
  }))
  assert.ok(lines.some((l) => /\+ 组合行: r2/.test(l)))
})

test('⑤ 同一行的 config 键增删被定位到该行', () => {
  const lines = diffBaselines(MIN(), MIN({
    legionRows: [{ id: 'r1', package: 'p', configKeys: ['a', 'b'], emptyConfigKeys: ['b'] }],
  }))
  assert.ok(lines.some((l) => /\+ r1\.config: b/.test(l)), '未定位到新增 config 键')
  assert.ok(lines.some((l) => /\+ r1\.空值键: b/.test(l)), '未定位到新增空值键')
})

test('⑤ bundle 层与依赖变化被列出', () => {
  const lines = diffBaselines(MIN(), MIN({ bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] }))
  assert.ok(lines.some((l) => /\+ bundle 层/.test(l)))
})
