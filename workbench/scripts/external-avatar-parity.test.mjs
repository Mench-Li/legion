// workbench/scripts/external-avatar-parity.test.mjs
// S2 外部执行者「名字 → 头像令牌」客户端镜像 + 两端 parity。
// 运行：node workbench/scripts/external-avatar-parity.test.mjs（ts.transpileModule 直跑，零新增依赖）
//
// 这一套件存在的理由：外部执行者不进 /api/agents 目录，客户端需要一张与
// team-hub/agent-avatars.mjs 的 EXTERNAL_AVATAR_TOKENS **逐项相同**的表。
// 两端各写一份字面量而没人比对时，"只改了一端"与"两端口径一致"在提交里长得一样。
import { describe, test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SRC = resolve(ROOT, 'workbench', 'src', 'avatar')
const TMP_CLIENT = join(HERE, '.external-agents.mjs')
const TMP_SLOTS = join(HERE, '.external-slots.mjs')

function transpile(from, to, rewrite) {
  const out = ts.transpileModule(readFileSync(from, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  })
  let code = out.outputText
  if (rewrite) code = code.replace(/['"]\.\/slots['"]/g, "'./.external-slots.mjs'")
  writeFileSync(to, code, 'utf8')
}

transpile(join(SRC, 'slots.ts'), TMP_SLOTS, false)
transpile(join(SRC, 'external-agents.ts'), TMP_CLIENT, true)
const SLOTS = await import(pathToFileURL(TMP_SLOTS).href)
const CLIENT = await import(pathToFileURL(TMP_CLIENT).href)
const SERVER = await import(pathToFileURL(resolve(ROOT, 'team-hub', 'agent-avatars.mjs')).href)

after(() => {
  try { rmSync(TMP_CLIENT, { force: true }) } catch { /* 清理 */ }
  try { rmSync(TMP_SLOTS, { force: true }) } catch { /* 清理 */ }
})

const SOFTWARE_BUILTIN = ['requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops']

describe('S2 外部执行者「名字→令牌」客户端镜像 + 两端 parity', () => {
  test('TC-S2-01 两端表逐项相等（AC-R6-2 / AC-R5-1）', () => {
    assert.deepEqual(CLIENT.EXTERNAL_AGENT_AVATARS, SERVER.EXTERNAL_AVATAR_TOKENS)
  })

  test('TC-S2-02/05 令牌合法 + 命中位面 + 假绿防线（AC-R1-1 / AC-R1-3 / RK-A3）', () => {
    for (const [name, token] of Object.entries(CLIENT.EXTERNAL_AGENT_AVATARS)) {
      assert.match(token, /^human:[a-z0-9][a-z0-9-]*$/, name)
      const slot = SLOTS.resolveSlot(token)
      assert.ok(slot && slot.key !== 'placeholder', name + ' 必须命中位面表：' + token)
    }
    assert.equal(SLOTS.resolveSlot('human:general'), null, '格式合法但无位面 = 假绿，必须为 null')
    assert.notEqual(SLOTS.resolveSlot('human:s11'), null, '已登记空闲位面必须真的换脸')
  })

  test('TC-S2-03 5 个 key 两两不同且不与内编撞（AC-R4-1 / AC-R4-2）', () => {
    const keys = Object.values(CLIENT.EXTERNAL_AGENT_AVATARS).map((t) => t.slice('human:'.length))
    assert.equal(new Set(keys).size, keys.length)
    for (const k of keys) {
      assert.ok(!SLOTS.BUILTIN_ROLE_KEYS.includes(k), k + ' 不得占用内编岗位 key')
      assert.ok(!SOFTWARE_BUILTIN.includes(k), k + ' 不得占用 software 内编 key')
    }
  })

  test('TC-S2-07 位面表两端仍 40 key 且逐项相同（I-2 / AC-R6-2）', async () => {
    const MOBILE = await import(pathToFileURL(resolve(ROOT, 'workbench', 'mobile', 'avatar.mjs')).href)
    const a = [...SLOTS.slotKeys()].sort()
    const b = [...MOBILE.slotKeys()].sort()
    assert.deepEqual(a, b)
    assert.equal(a.length, 40)
  })

  test('TC-S2-04/13 纯函数与边界（AC-R5-3 / AC-R7-2）', () => {
    for (const [name, token] of Object.entries(CLIENT.EXTERNAL_AGENT_AVATARS)) {
      assert.equal(CLIENT.externalAvatarToken(name), token)
      assert.equal(CLIENT.externalAvatarToken(name), token)
    }
    for (const bad of ['', 'solo-new', null, undefined, '\u2699\uFE0F']) {
      const got = CLIENT.externalAvatarToken(bad)
      assert.ok(got === '' || /^human:/.test(String(got)), '只可能是合法令牌或空串：' + String(got))
    }
    const src = readFileSync(join(SRC, 'external-agents.ts'), 'utf8')
    for (const banned of ['Math.random', 'Date.now', 'performance.now', 'new Date', 'fetch(', 'http://', 'https://']) {
      assert.ok(!src.includes(banned), '不得出现 ' + banned)
    }
  })
})
