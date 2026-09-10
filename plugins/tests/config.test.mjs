/**
 * config.test.mjs — P3-4 插件配置面统一：plugins/ 的运行时配置解析回归。
 *
 * 覆盖四块：
 *   A. **默认值漂移**（非循环）：schema 声明的默认值必须等于编译产物（plugins/lib/**）里真实生效的值。
 *      做法是把 schema 逐字段与 lib 的解析结果比对，而不是读引擎自己的输出（否则是自我印证）。
 *   B. **env 覆盖与「值从哪来」**：CHAT_CTX_* / NORMS_* 经环境变量注入到真实模块（spaceDigest /
 *      norms / chatContext），并带 sources。
 *   C. **非法值大声降级**：非法值回退默认 + 给出错误行，**绝不 throw / 不退出宿主**（插件在宿主进程内）。
 *   D. **双语义收口**：CHAT_CTX_BUDGET_CHARS 只表示总预算；摘要子预算有独立变量
 *      CHAT_CTX_DIGEST_BUDGET_CHARS（旧的「一个变量两种默认值」不再存在），chatContext 不再硬编码 4000。
 *
 * 运行：node --test plugins/tests/config.test.mjs
 *      （import 编译产物 plugins/lib/*.js —— lib 由 `npm run build` / run-ci 的 plugins build 产出，
 *        与同目录其它 plugins 测试一致，不需要 strip-types。）
 */
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LIB = join(ROOT, 'plugins', 'lib')
const libUrl = (name) => pathToFileURL(join(LIB, name)).href

let SCHEMA
before(async () => {
  SCHEMA = (await import('../../plugins/config-schema.mjs')).SCHEMA
})

/**
 * 在**干净环境**里跑一段 import 编译产物的脚本并取回结果。
 * 必须用子进程：配置在模块加载期解析一次，同进程内无法换 env 重解析（这正是既有语义）。
 * env 只透传 PATH/SystemRoot（Windows 下缺少 SystemRoot 会起不来），其余由用例显式给出。
 */
function runChild(code, env = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, '子进程加载失败：' + (r.stderr || '') + (r.stdout || ''))
  return r.stdout
}

/** 解析一次插件配置，并带上四个消费模块的真实读数。 */
function loadFresh(env = {}) {
  const out = runChild(`
    const cfg = await import(${JSON.stringify(libUrl('config.js'))})
    const sd = await import(${JSON.stringify(libUrl('spaceDigest.js'))})
    const nr = await import(${JSON.stringify(libUrl('norms.js'))})
    process.stdout.write(JSON.stringify({
      values: cfg.pluginConfig,
      sources: cfg.pluginConfigSources(),
      diagnostics: cfg.pluginConfigDiagnostics(),
      lines: cfg.pluginConfigLogLines(),
      json: cfg.pluginConfigJson(),
      spaceDigest: { fileCap: sd.defaultFileCap(), digestBudget: sd.defaultDigestBudget() },
      norms: { g: nr.NORMS_GLOBAL_MAX, s: nr.NORMS_SPACE_MAX, t: nr.NORMS_TOTAL_MAX },
    }))
  `, env)
  return JSON.parse(out)
}

describe('P3-4 插件配置：默认值与 schema 一致（非循环漂移检查）', () => {
  it('schema 默认值 == 编译产物里真实生效的值 == 决策口径 8000/4000/4000/3000/4000/7000', () => {
    const r = loadFresh()
    const field = (k) => SCHEMA.field(k).default
    const expect = {
      chatCtxBudgetChars: field('chatCtxBudgetChars'),
      chatCtxDigestBudgetChars: field('chatCtxDigestBudgetChars'),
      chatCtxFileCapChars: field('chatCtxFileCapChars'),
      normsGlobalMax: field('normsGlobalMax'),
      normsSpaceMax: field('normsSpaceMax'),
      normsTotalMax: field('normsTotalMax'),
    }
    assert.deepEqual(r.values, expect, 'schema 默认值与插件代码不一致：' + JSON.stringify({ schema: expect, code: r.values }))
    // 语义口径（P3-4 决策）：总预算 8000、摘要子预算 4000、单块 4000、规范 3000/4000/7000
    assert.equal(expect.chatCtxBudgetChars, 8000)
    assert.equal(expect.chatCtxDigestBudgetChars, 4000)
    assert.equal(expect.chatCtxFileCapChars, 4000)
    assert.deepEqual([expect.normsGlobalMax, expect.normsSpaceMax, expect.normsTotalMax], [3000, 4000, 7000])
    // 消费模块拿到的就是同一份值（不是各自再读一次 env）
    assert.deepEqual(r.spaceDigest, { fileCap: 4000, digestBudget: 4000 })
    assert.deepEqual(r.norms, { g: 3000, s: 4000, t: 7000 })
    for (const v of Object.values(r.sources)) assert.equal(v, 'default')
  })
})

describe('P3-4 插件配置：env 覆盖作用于真实模块且可追溯来源', () => {
  it('CHAT_CTX_* / NORMS_* 注入后，spaceDigest / norms 都随之变化', () => {
    const r = loadFresh({
      CHAT_CTX_BUDGET_CHARS: '9000',
      CHAT_CTX_DIGEST_BUDGET_CHARS: '5000',
      CHAT_CTX_FILE_CAP_CHARS: '2500',
      NORMS_GLOBAL_MAX: '100',
      NORMS_SPACE_MAX: '200',
      NORMS_TOTAL_MAX: '300',
    })
    assert.equal(r.values.chatCtxBudgetChars, 9000)
    assert.equal(r.values.chatCtxDigestBudgetChars, 5000)
    assert.deepEqual(r.spaceDigest, { fileCap: 2500, digestBudget: 5000 })
    assert.deepEqual(r.norms, { g: 100, s: 200, t: 300 })
    // 来源可回答「这个值从哪来」（未覆盖的字段仍是 default）
    assert.equal(r.sources.chatCtxBudgetChars, 'env')
    assert.equal(r.sources.normsGlobalMax, 'env')
    assert.match(r.lines[0], /CHAT_CTX_BUDGET_CHARS=9000/)
    assert.match(r.lines[0], /覆盖：CHAT_CTX_BUDGET_CHARS=9000/)
    assert.deepEqual(r.diagnostics.errors, [])
  })

  it('摘要子预算是独立变量：只改总预算不会顺带放大摘要预算（旧行为正是「一个变量管两处」）', () => {
    const r = loadFresh({ CHAT_CTX_BUDGET_CHARS: '20000' })
    assert.equal(r.values.chatCtxBudgetChars, 20000)
    assert.equal(r.values.chatCtxDigestBudgetChars, 4000, '摘要子预算必须保持默认，不再跟随总预算')
    assert.equal(r.spaceDigest.digestBudget, 4000)
    assert.equal(r.sources.chatCtxDigestBudgetChars, 'default')
  })

  it('chatContext 不再硬编码 4000：摘要子预算真的作用到摘要长度（实测截断）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p34-digest-'))
    try {
      writeFileSync(join(dir, 'README.md'), 'x'.repeat(5000))
      const run = (env) => {
        const out = runChild(`
          const { gatherChatContext } = await import(${JSON.stringify(libUrl('chatContext.js'))})
          const bundle = await gatherChatContext({ hubUrl: '', scope: 's', convId: 1, by: 'a', bindingDir: ${JSON.stringify(dir)} })
          process.stdout.write(JSON.stringify({ len: bundle.spaceDigest?.text?.length ?? -1 }))
        `, env)
        return JSON.parse(out).len
      }
      const withSmallBudget = run({ CHAT_CTX_DIGEST_BUDGET_CHARS: '200' })
      assert.ok(withSmallBudget > 0 && withSmallBudget < 400, '小预算下摘要应被截断到 200 附近，实际 ' + withSmallBudget)
      const withDefault = run({})
      assert.ok(withDefault > 3000, '默认预算（4000）下摘要应接近上限，实际 ' + withDefault)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('P3-4 插件配置：非法值大声降级（不 throw、不退出宿主）', () => {
  it('非整数 → 回退默认 + 错误行 + 来源仍是 default', () => {
    const r = loadFresh({ NORMS_GLOBAL_MAX: 'abc' })
    assert.equal(r.values.normsGlobalMax, 3000)
    assert.equal(r.sources.normsGlobalMax, 'default')
    assert.equal(r.diagnostics.errors.length, 1)
    assert.match(r.diagnostics.errors[0], /NORMS_GLOBAL_MAX 必须是整数/)
    assert.ok(r.lines.some((l) => l.includes('配置非法（已回退默认值）')), JSON.stringify(r.lines))
  })

  it('越界（0）与未知前缀变量都会被告知', () => {
    const r = loadFresh({ CHAT_CTX_FILE_CAP_CHARS: '0', CHAT_CTX_TYPO: '1' })
    assert.equal(r.values.chatCtxFileCapChars, 4000, '0 不合法（min=1）→ 回退默认')
    assert.match(r.diagnostics.errors[0], /不得小于 1/)
    assert.equal(r.diagnostics.warnings.length, 1)
    assert.match(r.diagnostics.warnings[0], /CHAT_CTX_TYPO/)
  })

  it('schema 规则：摘要子预算大于总预算 / 各层之和大于合计 → 规则告警但不改值', () => {
    const r = loadFresh({ CHAT_CTX_BUDGET_CHARS: '1000', CHAT_CTX_DIGEST_BUDGET_CHARS: '4000', NORMS_TOTAL_MAX: '100' })
    const codes = r.diagnostics.ruleViolations.map((v) => v.code).sort()
    // 总预算 1000 同时压到摘要子预算与单块上限，三条规则都应报出
    assert.deepEqual(codes, ['ctx_digest_over_total', 'ctx_file_cap_over_total', 'norms_layers_over_total'])
    assert.equal(r.values.chatCtxDigestBudgetChars, 4000, '规则只提示，不改写取值')
    assert.ok(r.lines.some((l) => l.includes('[warning/ctx_digest_over_total]')))
    assert.ok(r.json.ruleViolations.some((v) => v.code === 'ctx_digest_over_total'))
  })
})

describe('P3-4 插件配置：对外形态（诊断与脱敏）', () => {
  it('pluginConfigJson 与摘要同源、含 sources/错误/规则，且不含明文 secret', () => {
    const r = loadFresh()
    assert.equal(r.json.process, 'plugins')
    assert.equal(r.json.values.chatCtxBudgetChars, 8000)
    assert.equal(r.json.sources.normsTotalMax, 'default')
    assert.deepEqual(r.json.errors, [])
    assert.deepEqual(r.json.warnings, [])
    // 该 process 目前没有 secret 字段（提示词预算是纯数值），这里锁定「不会突然长出一个明文项」
    assert.deepEqual(SCHEMA.secretKeys(), [])
    assert.equal(r.lines.length, 1, '干净配置只输出一行摘要，不刷屏：' + JSON.stringify(r.lines))
  })
})
