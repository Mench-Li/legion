// 破验（第 113 轮）：那条"强制面表也要透传"的判据必须能变红。
//
// 纪律：**"全绿"不是证据**。对被测模块做具名变体，每个都必须让套件变红；
// 某个变体下仍全绿 ⇒ 那一族判据是空的（**同样是失败**）。
//
// 用法：node scratch/_mutate-r113-passthrough.mjs
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MODULE = fileURLToPath(new URL('../product/launcher/enforcement-identity.mjs', import.meta.url))
const SUITE = fileURLToPath(new URL('../product/launcher/enforcement-identity.test.mjs', import.meta.url))
const BACKUP = `${MODULE}.mutbak`

/**
 * 锚点匹配：**对行尾不敏感**。
 *
 * ★ 第一版把锚点写成含 `\n` 的字面量，而**这个文件是 CRLF**
 *   ⇒ 三个变体全部报 `ANCHOR-MISSING`，于是它们"没测到"而不是"通过"。
 *
 *   > 一条因为**行尾**而匹配不上的锚点，
 *   > 与一条因为"那段代码真的不在"而匹配不上的锚点，报的是同一句话——
 *   > 而前者会让整个破验静默地什么都不验。
 *
 *   所以这里把锚点与原文都按 `\r?\n` 归一后再比，回写时用**原文的行尾**。
 */
function replaceAnchor(source, from, to) {
  const norm = (s) => s.replace(/\r\n/g, '\n')
  const crlf = source.includes('\r\n')
  const hay = norm(source)
  const needle = norm(from)
  if (!hay.includes(needle)) return null
  const patched = hay.replace(needle, norm(to))
  return crlf ? patched.replace(/\n/g, '\r\n') : patched
}

const MUTATIONS = [
  {
    id: 'M1-把表那一轮透传整段删掉（回到本批之前：静默丢掉）',
    from: '  for (const env of ENFORCEMENT_TABLE_ENV_KEYS) {\n    const v = configuredFrom(env)\n    if (v !== null) values[env] = v\n  }',
    to: '  // (mutated: 表透传被删)',
    expectRed: ['强制面'],
  },
  {
    id: 'M2-岗位许可没被列进表清单（只接四道范围表）',
    from: "  'LEGION_EMPLOYEE_PERMIT',\n])",
    to: '])',
    expectRed: ['强制面', '闭集'],
  },
  {
    id: 'M3-透传变成"补默认值"（没配也给一个空表）',
    from: '  for (const env of ENFORCEMENT_TABLE_ENV_KEYS) {\n    const v = configuredFrom(env)\n    if (v !== null) values[env] = v\n  }',
    to: '  for (const env of ENFORCEMENT_TABLE_ENV_KEYS) {\n    values[env] = configuredFrom(env) ?? \'{}\'\n  }',
    expectRed: ['强制面'],
  },
  {
    // ★ 这个变体原本想问的是"只数个数的闭集判据是不是瞎的"。**结论：它不瞎，
    //   但理由不是我预想的那个** —— 诊断（`scratch/_diag-m4.mjs`）量出：
    //   就算把闭集与表清单两处都换成"只数个数"、并挖掉反向断言，
    //   行为判据（"配了就要到 values"）**仍然独立抓住它**。
    //
    //   > 我原以为"那份名单由一条结构断言守着"，
    //   > 而实测是"由结构断言**与**一条行为断言两条独立的路守着"——
    //   > 所以拆掉其中一条，读数**不会**变绿，而我差一点把"没变绿"读成"变体没生效"。
    //
    //   ⇒ 这一格的交付是**这条订正**：判据不瞎，而且守它的不止一条路。
    //     模块变体在这里是**空操作**（判据变瞎才是本例的输入）。
    id: 'M4-把两处结构断言挖成"只数个数"（预期：**仍红** ⇒ 有第二条独立的路）',
    from: 'export const ENFORCEMENT_TABLE_ENV_KEYS = Object.freeze([',
    to: 'export const ENFORCEMENT_TABLE_ENV_KEYS = Object.freeze([',
    alsoBlind: [
      {
        from: '    assert.deepEqual([...ENFORCEMENT_IDENTITY_PASSTHROUGH].sort(), [\n      ...Object.values(ENFORCEMENT_IDENTITY_ENV),\n      ...ENFORCEMENT_DECIDE_ENV_KEYS,\n      ...ENFORCEMENT_TABLE_ENV_KEYS,\n    ].sort())',
        to: '    assert.equal(ENFORCEMENT_IDENTITY_PASSTHROUGH.length, new Set([...Object.values(ENFORCEMENT_IDENTITY_ENV), ...ENFORCEMENT_DECIDE_ENV_KEYS, ...ENFORCEMENT_TABLE_ENV_KEYS]).size)',
      },
      {
        from: '    assert.equal(ENFORCEMENT_TABLE_ENV_KEYS.length, 5)\n    assert.deepEqual([...ENFORCEMENT_TABLE_ENV_KEYS].sort(), [\n      \'LEGION_CONNECTOR_DECLARATIONS\', \'LEGION_EMPLOYEE_PERMIT\', \'LEGION_EXECUTION_SCOPE\',\n      \'LEGION_EXTERNAL_API_SCOPE\', \'LEGION_PATH_SCOPE\',\n    ])',
        to: '    assert.equal(ENFORCEMENT_TABLE_ENV_KEYS.length, ENFORCEMENT_TABLE_ENV_KEYS.length)',
      },
    ],
    expectRed: [],
    expectGreenAfterOtherMutation: true,
  },
  {
    // ★★★ 这一格才是真正的定向缺陷：**表清单里拿掉岗位许可**，
    //   同时把判据的夹具也一起拿掉（否则判据会因为"夹具里配了一个它不认的键"
    //   而在另一个方向红——那红是对的，但不是本条要问的那件事）。
    //
    //   拿掉之后：闭集 deepEqual 与表清单 deepEqual 都该红——
    //   这正是"**列出成员**"那一半在做的事。
    id: 'M5-表清单与判据夹具同时拿掉岗位许可（定向缺陷：只列四道）',
    from: "  'LEGION_EMPLOYEE_PERMIT',\n])",
    to: '])',
    alsoBlind: [
      {
        from: "      LEGION_EMPLOYEE_PERMIT: '{\"employeeId\":\"e1\"}',\n",
        to: '',
      },
    ],
    expectRed: ['闭集'],
    expectGreenAfterOtherMutation: false,
  },
]

function runSuite() {
  const r = spawnSync(process.execPath, ['--test', SUITE], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const failed = [...out.matchAll(/^✖ ([^\n(]*)/gm)].map((m) => m[1].trim())
  return { code: r.status, failed }
}

copyFileSync(MODULE, BACKUP)
const original = readFileSync(MODULE, 'utf8')
const results = []
try {
  const base = runSuite()
  console.log(`基准（未变体）：exit=${base.code}`)
  if (base.code !== 0) { console.log('⚠ 基准不绿，变体实验没意义'); process.exitCode = 1 }

  for (const m of MUTATIONS) {
    // ── 统一路径：① 模块按 `from`/`to` 变体；② `alsoBlind` 里的是**判据文件**的变体。
    //
    //   ★ 第一版把"判据变瞎"单独写成一条分支，于是 `alsoBlind` 在普通路径上
    //     被静默忽略——M4 因此报 `UNEXPECTED-RED`，而那个红**是我自己的脚本
    //     没把变体应用全**造成的，不是判据的性质。
    //     *一个"没把变体应用全"的量具，与一个"判据抓住了它"的读数，
    //     都表现为变红——只不过前者的红什么都证明不了。*
    const mutated = replaceAnchor(original, m.from, m.to)
    if (mutated === null) {
      results.push({ id: m.id, verdict: 'ANCHOR-MISSING' })
      console.log(`\n### ${m.id}\n  ✖ 模块锚点没命中 —— 这一格测不了（不是通过）`)
      continue
    }
    let suiteMutation = null
    if (m.alsoBlind !== undefined) {
      let suiteSrc = readFileSync(SUITE, 'utf8')
      let ok = true
      for (const extra of m.alsoBlind) {
        const next = replaceAnchor(suiteSrc, extra.from, extra.to)
        if (next === null) { ok = false; break }
        suiteSrc = next
      }
      if (!ok) {
        results.push({ id: m.id, verdict: 'ANCHOR-MISSING' })
        console.log(`\n### ${m.id}\n  ✖ 判据侧的锚点没命中 —— 这一格测不了（不是通过）`)
        continue
      }
      suiteMutation = suiteSrc
    }
    writeFileSync(MODULE, mutated)
    if (suiteMutation !== null) {
      copyFileSync(SUITE, `${SUITE}.mutbak`)
      writeFileSync(SUITE, suiteMutation)
    }
    const r = runSuite()
    writeFileSync(MODULE, original)
    if (suiteMutation !== null) {
      copyFileSync(`${SUITE}.mutbak`, SUITE)
      try { unlinkSync(`${SUITE}.mutbak`) } catch {}
    }
    const red = r.code !== 0
    const hit = m.expectRed.filter((n) => r.failed.some((f) => f.includes(n)))
    let verdict
    if (m.expectGreenAfterOtherMutation === true) {
      verdict = red ? 'UNEXPECTED-RED' : 'PROVES-BLINDNESS'
    } else {
      verdict = red ? (hit.length > 0 ? 'RED-AS-EXPECTED' : 'RED-ELSEWHERE') : 'STILL-GREEN'
    }
    results.push({ id: m.id, verdict })
    console.log(`\n### ${m.id}`)
    if (verdict === 'PROVES-BLINDNESS') console.log('  ✔ 证明了那一族判据是瞎的（仍全绿）')
    else if (red) console.log(`  ✔ 变红了  ${verdict}`)
    else console.log('  ✖ 仍然全绿 —— 这一族判据是空的')
    console.log(`  期望命中：${JSON.stringify(m.expectRed)}  实际：${JSON.stringify(hit)}`)
    console.log(`  红的判据：${JSON.stringify(r.failed.slice(0, 3))}`)
  }
} finally {
  writeFileSync(MODULE, original)
  try { unlinkSync(BACKUP) } catch {}
}

console.log('\n================ 汇总 ================')
for (const r of results) console.log(`${r.verdict.padEnd(20)} ${r.id}`)
const bad = results.filter((r) => !['RED-AS-EXPECTED', 'PROVES-BLINDNESS'].includes(r.verdict))
console.log(`\n变体 ${results.length} 个；达标 ${results.length - bad.length} 个；不达标 ${bad.length} 个`)
if (bad.length > 0) process.exitCode = 1
