/**
 * host-diagnostics.test.mjs — P4-2（候选 #9）诊断层单测：**不需要 DSH 宿主**。
 *
 * 这些用例锁定的全部是**真实日志文本**的形状（样例取自 DSH `packages/boot/app-boot/src/index.ts`
 * 的失败路径）与**真实文件系统**的真值（fixture 里的 package.json / 入口文件）。
 * 目的：让「把 60s 未就绪翻译成插件导入失败」这件事本身可回归——
 * 如果诊断只会说「未就绪」，用例必须红。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  PACKAGE_DIRS, diagnoseHostLogs, entryFromPackageJson, formatDiagnosis, hostBootError,
  parseCompositionRows, parseHostFailures, preflightEntries, resolveRowEntry,
} from './host-diagnostics.mjs'

/** 造一个临时「仓库根」：每个包目录里放 package.json（可选放入口文件）。 */
function fakeRepo({ packages }) {
  const root = mkdtempSync(join(tmpdir(), 'p13-diag-'))
  for (const [rel, spec] of Object.entries(packages)) {
    const dir = join(root, rel)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(spec.pkg))
    if (spec.entry) {
      mkdirSync(join(dir, spec.pkg.main.split('/')[0]), { recursive: true })
      writeFileSync(join(dir, spec.pkg.main), spec.entry)
    }
  }
  return root
}

// ---------------------------------------------------------------- 失败日志解析

describe('parseHostFailures：解析真实 app-boot 失败文本', () => {
  it('实测形状：failed to import loader entry <id> (<specifier>) 给出 id 与 specifier（真实宿主原文）', () => {
    // 原文取自 P4-2 负向夹具在真实宿主上的输出（broken-plugin.mjs / 缺失 lib 两种场景一致）
    const log = [
      'file:///D:/project/DSH/dsh/deepseek-harness/packages/boot/app-boot/lib/index.js:1187',
      '\t\tthrow new Error(`${binName}: ${stage}: ${detail}${stack}`, { cause });',
      '',
      'Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry p13-broken-file (file:///D:/project/DSH/legion/tests/p13-fixture/broken-plugin.mjs): p13-broken-plugin: 故意在导入期抛错（P4-2 负向夹具）',
      'Error: p13-broken-plugin: 故意在导入期抛错（P4-2 负向夹具）',
      '    at file:///D:/project/DSH/legion/tests/p13-fixture/broken-plugin.mjs:7:7',
    ].join('\n')
    const p = parseHostFailures(log)
    assert.equal(p.stage, 'plugin tree failed to load')
    assert.equal(p.entryFailures.length, 1, '包装层 include (cordis:include) 不应被当成用户条目')
    assert.deepEqual(
      { action: p.entryFailures[0].action, id: p.entryFailures[0].id, specifier: p.entryFailures[0].specifier },
      { action: 'import', id: 'p13-broken-file', specifier: 'file:///D:/project/DSH/legion/tests/p13-fixture/broken-plugin.mjs' },
    )
    assert.match(p.entryFailures[0].message, /故意在导入期抛错/)
  })

  it('入口无法解析：plugin(s) failed to load 的名字被逐条取出', () => {
    const log = [
      "dsh: plugin(s) failed to load: @dsh-external/dsh-team-hub, p13-broken; Cordis startup failed because these plugin(s) could not be resolved (see the error(s) logged above)",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'D:\\project\\DSH\\legion\\team-hub\\lib\\index.js' imported from D:\\project\\DSH\\legion\\team-hub",
    ].join('\n')
    const p = parseHostFailures(log)
    assert.deepEqual(p.loaderFailedNames, ['@dsh-external/dsh-team-hub', 'p13-broken'])
    assert.match(p.moduleErrors[0], /ERR_MODULE_NOT_FOUND/)
  })

  it('条目激活失败与 pending 服务被分开解析（真实多行清单）', () => {
    const log = [
      'dsh: 2 entries did not activate',
      'p13-broken: Error: p13-broken-plugin: 故意在导入期抛错',
      '    at file:///D:/project/DSH/legion/tests/p13-fixture/broken-plugin.mjs:7:9',
      'p13-worker: pending (waiting for services: timer, subagents)',
      '',
      'dsh: plugin tree failed to load: 2 entries did not activate',
    ].join('\n')
    const p = parseHostFailures(log)
    assert.equal(p.activation.length, 1)
    assert.equal(p.activation[0].name, 'p13-broken')
    assert.match(p.activation[0].detail, /故意在导入期抛错/)
    assert.deepEqual(p.pending, [{ name: 'p13-worker', missing: ['timer', 'subagents'] }])
    assert.equal(p.stage, 'plugin tree failed to load')
  })

  it('未处理拒绝（fail-loud）被识别', () => {
    const log = 'dsh: fatal load failure: Error: boom\n    at somewhere'
    assert.match(parseHostFailures(log).fatal, /boom/)
  })

  it('健康日志：什么都不报（避免误报）', () => {
    const log = 'dsh: listening on http://127.0.0.1:1234\n[team-hub] v2 ready\n[config] plugins chatCtxBudgetChars=8000(default)'
    const p = parseHostFailures(log)
    assert.deepEqual(p.loaderFailedNames, [])
    assert.deepEqual(p.activation, [])
    assert.deepEqual(p.pending, [])
    assert.deepEqual(p.moduleErrors, [])
    assert.equal(p.stage, null)
  })
})

// ---------------------------------------------------------------- 入口解析与预检

describe('resolveRowEntry / preflightEntries：用组合行真值 + 文件系统判断入口', () => {
  it('@dsh-external 包：按 package.json 的 main 解析入口并检查存在性', () => {
    const repoRoot = fakeRepo({ packages: { 'team-hub': { pkg: { name: 'x', main: './lib/index.js' } } } })
    try {
      const r = resolveRowEntry({ id: 'p13-team-hub', name: '@dsh-external/dsh-team-hub' }, { repoRoot })
      assert.equal(r.kind, 'package')
      assert.equal(r.entry, join(repoRoot, 'team-hub', 'lib', 'index.js'))
      assert.equal(r.exists, false, '入口文件不存在 → exists=false')
      const pre = preflightEntries([{ id: 'p13-team-hub', name: '@dsh-external/dsh-team-hub' }], { repoRoot })
      assert.equal(pre.checked, 1)
      assert.equal(pre.problems.length, 1)
      assert.equal(pre.problems[0].kind, 'missing_entry')
      assert.match(pre.problems[0].plugin, /p13-team-hub/)
      assert.match(pre.problems[0].hint, /build-external-package\.mjs team-hub/, '提示必须指明构建命令')
    } finally { rmSync(repoRoot, { recursive: true, force: true }) }
  })

  it('入口存在时不报问题（避免假阳性）', () => {
    const repoRoot = fakeRepo({ packages: { plugins: { pkg: { name: 'y', main: 'lib/index.js' }, entry: 'export const name = "y"\n' } } })
    try {
      const pre = preflightEntries([{ id: 'p13-worker', name: '@dsh-external/dsh-scrum-worker' }], { repoRoot })
      assert.deepEqual(pre.problems, [])
    } finally { rmSync(repoRoot, { recursive: true, force: true }) }
  })

  it('package.json 不存在 / 未声明 main 都算缺失，并给出原因', () => {
    const repoRoot = fakeRepo({ packages: { 'board-plugin': { pkg: { name: 'z' } } } })
    try {
      const rows = [{ id: 'a', name: '@dsh-external/dsh-scrum-board' }, { id: 'b', name: '@dsh-external/dsh-team-hub' }]
      const pre = preflightEntries(rows, { repoRoot })
      assert.equal(pre.problems.length, 2)
      assert.match(pre.problems.map((p) => p.hint).join('\n'), /未声明 main|不存在/)
    } finally { rmSync(repoRoot, { recursive: true, force: true }) }
  })

  it('file:// 行：直接检查该文件是否存在，未知 name 不当作问题（不猜）', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'p13-diag-'))
    try {
      const good = join(repoRoot, 'ok.mjs')
      writeFileSync(good, 'export const name = "ok"\n')
      const url = 'file:///' + good.replace(/\\/g, '/')
      const okRow = resolveRowEntry({ id: 'g', name: url }, { repoRoot })
      assert.equal(okRow.kind, 'file')
      assert.equal(okRow.exists, true)
      const missing = resolveRowEntry({ id: 'm', name: 'file:///' + join(repoRoot, 'nope.mjs').replace(/\\/g, '/') }, { repoRoot })
      assert.equal(missing.exists, false)
      const unknown = resolveRowEntry({ id: 'u', name: '@deepseek-ai/dsh-host-webserver' }, { repoRoot })
      assert.equal(unknown.kind, 'unknown')
      assert.equal(preflightEntries([{ id: 'u', name: '@deepseek-ai/dsh-host-webserver' }], { repoRoot }).problems.length, 0)
    } finally { rmSync(repoRoot, { recursive: true, force: true }) }
  })

  it('entryFromPackageJson 也认 exports 的字符串/嵌套形式', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'p13-diag-'))
    try {
      const p1 = join(repoRoot, 'p1.json'); writeFileSync(p1, JSON.stringify({ exports: './lib/a.js' }))
      assert.equal(entryFromPackageJson(p1), './lib/a.js')
      const p2 = join(repoRoot, 'p2.json'); writeFileSync(p2, JSON.stringify({ exports: { '.': { import: './lib/b.js' } } }))
      assert.equal(entryFromPackageJson(p2), './lib/b.js')
      const p3 = join(repoRoot, 'p3.json'); writeFileSync(p3, '{ not json')
      assert.equal(entryFromPackageJson(p3), null)
    } finally { rmSync(repoRoot, { recursive: true, force: true }) }
  })

  it('parseCompositionRows：嵌套块里的 name（如 config.name）不得覆盖插件名', () => {
    // 真实踩点：scrum-worker 行的 config 块里有 `name: worker`，不判缩进就会把「worker」
    // 当成插件名去查入口 —— 诊断会给出一个不存在的入口路径（比不诊断更糟）。
    const yaml = [
      '- insert:',
      '    - id: p13-worker',
      "      name: '@dsh-external/dsh-scrum-worker'",
      '      config:',
      "        name: 'worker'",
      "        mode: 'worker'",
      '    - id: p13-no-name',
      '      config:',
      "        name: 'nested-only'",
    ].join('\n')
    assert.deepEqual(parseCompositionRows(yaml), [
      { id: 'p13-worker', name: '@dsh-external/dsh-scrum-worker' },
    ], 'config.name 不得覆盖插件名；没有插件名的行不返回（不猜）')
  })

  it('parseCompositionRows 能从 fixture 写的 YAML 里取出 id/name（诊断与真实挂载同一真值）', () => {
    const yaml = [
      '- insert:',
      '    - id: p13-webserver',
      "      name: '@deepseek-ai/dsh-host-webserver'",
      '      config:',
      '        port: 1234',
      '    - id: p13-team-hub',
      "      name: '@dsh-external/dsh-team-hub'",
    ].join('\n')
    assert.deepEqual(parseCompositionRows(yaml), [
      { id: 'p13-webserver', name: '@deepseek-ai/dsh-host-webserver' },
      { id: 'p13-team-hub', name: '@dsh-external/dsh-team-hub' },
    ])
  })
})

// ---------------------------------------------------------------- 汇总诊断

describe('diagnoseHostLogs / formatDiagnosis：结论可读且指向正确插件', () => {
  const repoRoot = fakeRepo({
    packages: {
      'team-hub': { pkg: { name: 'th', main: './lib/index.js' } },   // 入口缺失（复现 CI 现场）
      plugins: { pkg: { name: 'w', main: 'lib/index.js' }, entry: 'export const name = "w"\n' },
    },
  })

  it('实测形状：装载器点名的条目按 **id** 精确反查组合行（file:// 导入期抛错）', () => {
    // 用**真实存在**的夹具文件：入口存在却在导入期抛错 → import_threw（不是 missing_entry）
    const realFile = fileURLToPath(new URL('./broken-plugin.mjs', import.meta.url))
    const specifier = pathToFileURL(realFile).href
    const log = `Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry p13-broken-file (${specifier}): p13-broken-plugin: 故意在导入期抛错`
    const diag = diagnoseHostLogs({
      logText: log,
      rows: [{ id: 'p13-broken-file', name: specifier }],
      repoRoot: tmpdir(),
    })
    assert.equal(diag.problems.length, 1)
    const p = diag.problems[0]
    assert.equal(p.kind, 'import_threw', '入口存在但在导入期抛错 → import_threw（不是 missing_entry）')
    assert.match(p.plugin, /^p13-broken-file（file:\/\/\//)
    assert.equal(p.entry, realFile, '应给出该行的真实入口文件')
    assert.match(p.detail, /故意在导入期抛错/)
    assert.match(p.hint, /导入期/)
    assert.match(formatDiagnosis(diag, { logText: log }), /处置：/)
  })

  it('实测形状：装载器点名的条目按 **id** 精确反查组合行（入口产物缺失）→ missing_entry + 构建建议', () => {
    const log = 'Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry p13-broken-missing (@dsh-external/dsh-p13-missing): Cannot find package \'C:\\tmp\\node_modules\\@dsh-external\\dsh-p13-missing\\lib\\index.js\' imported from C:\\tmp\\'
    const rows = [{ id: 'p13-broken-missing', name: '@dsh-external/dsh-p13-missing' }]
    const repoRoot2 = fakeRepo({ packages: { 'team-hub': { pkg: { name: 'th', main: './lib/index.js' } } } })
    try {
      const diag = diagnoseHostLogs({ logText: log, rows, repoRoot: repoRoot2 })
      assert.equal(diag.problems.length, 1)
      const p = diag.problems[0]
      assert.equal(p.kind, 'missing_entry')
      assert.match(p.plugin, /p13-broken-missing（@dsh-external\/dsh-p13-missing）/)
      assert.match(p.detail, /入口文件不存在/)
      assert.match(formatDiagnosis(diag, { logText: log }), /入口文件不存在|处置：/)
    } finally { rmSync(repoRoot2, { recursive: true, force: true }) }
  })

  it('「Cannot find module …/team-hub/lib/index.js」→ 点名插件、入口与构建建议', () => {
    const log = [
      "dsh: plugin(s) failed to load: @dsh-external/dsh-team-hub; Cordis startup failed because these plugin(s) could not be resolved (see the error(s) logged above)",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'D:\\x\\team-hub\\lib\\index.js' imported from D:\\x\\team-hub",
    ].join('\n')
    const diag = diagnoseHostLogs({ logText: log, rows: [{ id: 'p13-team-hub', name: '@dsh-external/dsh-team-hub' }], repoRoot })
    assert.equal(diag.problems.length, 1)
    const p = diag.problems[0]
    assert.equal(p.kind, 'missing_entry')
    assert.match(p.plugin, /p13-team-hub/)
    assert.match(p.entry, /team-hub[\\/]lib[\\/]index\.js$/)
    assert.match(p.hint, /build-external-package\.mjs team-hub/)

    const text = formatDiagnosis(diag, { logText: log })
    assert.match(text, /宿主插件加载失败（已定位 1 处）/)
    assert.match(text, /入口：/)
    assert.match(text, /处置：/)
    assert.match(text, /宿主日志尾部/, '必须保留原始日志尾部，便于人核对')
  })

  it('插件导入期抛错 → 归为 activation_failed，并带上插件自己的错误与栈', () => {
    const log = [
      'dsh: 1 entry did not activate',
      'p13-broken: Error: p13-broken-plugin: 故意在导入期抛错',
      '    at file:///D:/project/DSH/legion/tests/p13-fixture/broken-plugin.mjs:7:9',
      'dsh: plugin tree failed to load: 1 entry did not activate',
    ].join('\n')
    const diag = diagnoseHostLogs({ logText: log, rows: [{ id: 'p13-broken', name: 'file:///x/broken-plugin.mjs' }], repoRoot })
    assert.equal(diag.problems.length, 1)
    assert.equal(diag.problems[0].kind, 'activation_failed')
    assert.match(diag.problems[0].detail, /故意在导入期抛错/)
    assert.ok(diag.problems[0].raw.includes('broken-plugin.mjs'), '原始栈必须保留（含失败站点）')
    assert.ok(!/at file:\/\//.test(diag.problems[0].plugin), '栈的续行不得被当成新条目')
  })

  it('pending 服务 → 指出「谁在等哪些服务」（这类问题以前只能靠猜）', () => {
    const log = ['dsh: 1 entry did not activate', 'p13-worker: pending (waiting for services: timer, subagents)', 'dsh: plugin tree failed to load: 1 entry did not activate'].join('\n')
    const diag = diagnoseHostLogs({ logText: log, rows: [{ id: 'p13-worker', name: '@dsh-external/dsh-scrum-worker' }], repoRoot })
    assert.equal(diag.problems[0].kind, 'pending_services')
    assert.match(diag.problems[0].detail, /timer, subagents/)
    assert.match(diag.problems[0].hint, /inject/)
  })

  it('packageDirs 必须能穿透到入口解析：自造包也要给出入口路径（而不只是点名）', () => {
    // 真实踩点：夹具挂的自造包不在默认 PACKAGE_DIRS 里，诊断为「能点名、给不出入口路径」。
    // 只点名不给路径是半条结论 —— 定位还是要人去翻配置文件。
    const dir = mkdtempSync(join(tmpdir(), 'p13-diag-pkgs-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-p13-missing', main: './lib/index.js' }))
      const rows = [{ id: 'p13-broken-missing', name: '@dsh-external/dsh-p13-missing' }]
      const log = 'Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): '
        + "failed to import loader entry p13-broken-missing (@dsh-external/dsh-p13-missing): Cannot find package '" + join(dir, 'lib', 'index.js') + "' imported from " + dir
      const without = diagnoseHostLogs({ logText: log, rows, repoRoot: dir })
      assert.equal(without.problems[0].entry, null, '默认表里没有这个包 → 给不出入口（记录现状，便于理解为何要传 packageDirs）')
      const withDirs = diagnoseHostLogs({ logText: log, rows, repoRoot: dir, packageDirs: { '@dsh-external/dsh-p13-missing': dir } })
      const p = withDirs.problems[0]
      assert.equal(p.kind, 'missing_entry')
      assert.equal(p.entry, join(dir, 'lib', 'index.js'), '传了 packageDirs 就必须给出入口路径')
      assert.match(p.hint, /入口文件不存在|入口产物缺失/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('hostBootError 也转发 packageDirs（waitReady 走的就是这条路）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p13-diag-boot-'))
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-p13-missing', main: './lib/index.js' }))
      const err = hostBootError({
        logText: 'failed to import loader entry p13-x (@dsh-external/dsh-p13-missing): Cannot find package',
        rows: [{ id: 'p13-x', name: '@dsh-external/dsh-p13-missing' }],
        repoRoot: dir,
        packageDirs: { '@dsh-external/dsh-p13-missing': dir },
        exitCode: 1,
      })
      assert.equal(err.diagnosis.problems[0].entry, join(dir, 'lib', 'index.js'))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('只有底层模块错误、没有条目名 → 如实说「未能定位到具体插件条目」', () => {
    const log = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'cordis' imported from /tmp/x/lib/index.js"
    const diag = diagnoseHostLogs({ logText: log, rows: [], repoRoot })
    assert.equal(diag.problems.length, 1)
    assert.equal(diag.problems[0].kind, 'module_error')
    assert.match(diag.problems[0].plugin, /未能定位/)
    assert.match(formatDiagnosis(diag, { logText: log }), /未能定位到具体插件条目/)
  })

  it('健康日志 → 零问题，格式化为「未能识别出插件加载错误」而不编造结论', () => {
    const log = 'dsh: listening on http://127.0.0.1:1234\n[team-hub] v2 ready'
    const diag = diagnoseHostLogs({ logText: log, rows: [{ id: 'x', name: '@dsh-external/dsh-team-hub' }], repoRoot, timeoutMs: 45000 })
    assert.equal(diag.problems.length, 0)
    const text = formatDiagnosis(diag, { logText: log })
    assert.match(text, /未能从宿主日志识别出插件加载错误/)
    assert.match(text, /等待就绪上限：45000ms/)
  })

  it('hostBootError：抛出的错误同时带可读文本与结构化诊断', () => {
    const log = "dsh: plugin(s) failed to load: @dsh-external/dsh-team-hub; Cordis startup failed"
    const err = hostBootError({ logText: log, rows: [{ id: 'p13-team-hub', name: '@dsh-external/dsh-team-hub' }], repoRoot, exitCode: 1 })
    assert.equal(err.name, 'HostBootError')
    assert.match(err.message, /宿主插件加载失败/)
    assert.equal(err.diagnosis.problems[0].kind, 'missing_entry')
    assert.equal(err.diagnosis.exitCode, 1)
  })

  it('未就绪但日志是空/无关内容：仍给出可读错误（不把「不知道」说成「没问题」）', () => {
    const err = hostBootError({ logText: '', rows: [], repoRoot, timeoutMs: 60000 })
    assert.equal(err.diagnosis.problems.length, 0)
    assert.match(err.message, /宿主未就绪：/)
    assert.match(err.message, /未能从宿主日志识别出/)
  })

  it('PACKAGE_DIRS 与诊断提示里的构建命令键一致（防止提示指错脚本参数）', () => {
    assert.deepEqual(Object.keys(PACKAGE_DIRS).sort(), [
      '@dsh-external/dsh-scrum-board', '@dsh-external/dsh-scrum-worker', '@dsh-external/dsh-team-hub',
    ])
    assert.deepEqual(Object.values(PACKAGE_DIRS).sort(), ['board-plugin', 'plugins', 'team-hub'])
  })
})

// 报告未使用变量（node --test 不会，但显式保留意图）：PACKAGE_DIRS 已在上面用到。
