// 诊断：把 M4 的三处"变瞎"真正应用后，看套件红在哪一条。
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const MODULE = 'product/launcher/enforcement-identity.mjs'
const SUITE = 'product/launcher/enforcement-identity.test.mjs'
const norm = (s) => s.replace(/\r\n/g, '\n')
const repl = (src, from, to) => {
  const crlf = src.includes('\r\n')
  const hay = norm(src)
  if (!hay.includes(norm(from))) return null
  const out = hay.replace(norm(from), norm(to))
  return crlf ? out.replace(/\n/g, '\r\n') : out
}

const origModule = readFileSync(MODULE, 'utf8')
const origSuite = readFileSync(SUITE, 'utf8')
copyFileSync(SUITE, `${SUITE}.diagbak`)
copyFileSync(MODULE, `${MODULE}.diagbak`)

// ① 模块：表清单里拿掉岗位许可
let mod = repl(origModule, "  'LEGION_EMPLOYEE_PERMIT',\n])", '])')
console.log('① 模块变体应用 =', mod !== null)

// ② 判据：三处全部换成"只数个数"
let suite = origSuite
const steps = [
  ['闭集 deepEqual → 只数个数',
    '    assert.deepEqual([...ENFORCEMENT_IDENTITY_PASSTHROUGH].sort(), [\n      ...Object.values(ENFORCEMENT_IDENTITY_ENV),\n      ...ENFORCEMENT_DECIDE_ENV_KEYS,\n      ...ENFORCEMENT_TABLE_ENV_KEYS,\n    ].sort())',
    '    assert.equal(ENFORCEMENT_IDENTITY_PASSTHROUGH.length, new Set([...Object.values(ENFORCEMENT_IDENTITY_ENV), ...ENFORCEMENT_DECIDE_ENV_KEYS, ...ENFORCEMENT_TABLE_ENV_KEYS]).size)'],
  ['表清单 deepEqual → 只数个数',
    "    assert.equal(ENFORCEMENT_TABLE_ENV_KEYS.length, 5)\n    assert.deepEqual([...ENFORCEMENT_TABLE_ENV_KEYS].sort(), [\n      'LEGION_CONNECTOR_DECLARATIONS', 'LEGION_EMPLOYEE_PERMIT', 'LEGION_EXECUTION_SCOPE',\n      'LEGION_EXTERNAL_API_SCOPE', 'LEGION_PATH_SCOPE',\n    ])",
    '    assert.equal(ENFORCEMENT_TABLE_ENV_KEYS.length, ENFORCEMENT_TABLE_ENV_KEYS.length)'],
  ['用例③ 没配却进 values 的反向断言',
    '    for (const key of Object.keys(tables)) {\n      assert.equal(key in bare.values, false,\n        `${key} 没配却进了 values —— 透传名单变成了默认值来源`)\n    }',
    '    // (诊断：这一段被挖掉)'],
]
for (const [label, from, to] of steps) {
  const next = repl(suite, from, to)
  console.log(`② ${label} = ${next !== null}`)
  if (next !== null) suite = next
}

writeFileSync(MODULE, mod)
writeFileSync(SUITE, suite)
const r = spawnSync(process.execPath, ['--test', SUITE], { encoding: 'utf8' })
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
console.log('\nexit =', r.status)
for (const m of out.matchAll(/AssertionError[^\n]*\n([^\n]*)/g)) console.log('  ASSERT:', m[0].split('\n').slice(0, 2).join(' | ').slice(0, 220))
for (const m of out.matchAll(/^✖ ([^\n(]*)/gm)) console.log('  RED:', m[1].trim().slice(0, 120))

copyFileSync(`${SUITE}.diagbak`, SUITE)
copyFileSync(`${MODULE}.diagbak`, MODULE)
try { unlinkSync(`${SUITE}.diagbak`); unlinkSync(`${MODULE}.diagbak`) } catch {}
