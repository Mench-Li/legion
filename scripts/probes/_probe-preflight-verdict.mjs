// scripts/probes/_probe-preflight-verdict.mjs —— 往裁决词表里加第四个词，看汇总会说什么
//
// ★ 第 42 轮的形状（"声明表 + 手写复述"）在 `product/upgrade/preflight.mjs` 里的样子：
//
//     export const PREFLIGHT_VERDICTS = Object.freeze(['ok', 'blocked', 'unknown'])
//     ...
//     const blockedChecks = checks.filter((c) => c.verdict === 'blocked')   ← 手写
//     const unknownChecks = checks.filter((c) => c.verdict === 'unknown')   ← 手写
//     return { ok: blockedChecks.length === 0 && fatalUnknown.length === 0, ... }
//
//   > 一条"不是 ok、也不是 blocked"的裁决，与一条 ok 的裁决，
//   > 在"这次升级该不该放行"这个读数上是同一个东西：都说可以走。
//
// 本探针把真文件复制一份、只改声明的词表（与可选的一处分支），然后叫真的 `runPreflight`。
// 修之前：`ok = true`。修之后：要么**一进模块就抛**，要么被正确地算进 blocking。
import { readFileSync, writeFileSync, rmSync } from 'node:fs'

const SRC = 'D:/project/DSH/legion/product/upgrade/preflight.mjs'
const TMP = 'D:/project/DSH/legion/product/upgrade/_preflight-4th.mjs'
const src = readFileSync(SRC, 'utf8')

const VERDICTS_LINE = "export const PREFLIGHT_VERDICTS = Object.freeze(['ok', 'blocked', 'unknown'])"
// ★★ 锚点必须**换行无关**：这个文件是 CRLF，第一版我写的是
//    `"  unknown: 'unknown',\n})"` ⇒ 匹配不上 ⇒ 归类补丁**没打上**，
//    于是"声明 + 归类成 blocking"那一格报的是"声明了却没归类"。
//    而"补丁没打上"与"判据不认那个形状"，在只看那一行输出时是同一个东西。
//    （第 40 轮在变异 harness 里踩过同一个坑，这里换了个地方又踩了一次。）
const KINDS_LINE = / {2}unknown: 'unknown',\r?\n\}\)/

/** 打补丁并动态加载；返回 `{ ok: true, mod }` 或 `{ ok: false, error }`。 */
async function load({ addVerdict, addKind, useVerdict }) {
  let text = src
  if (addVerdict) {
    text = text.replace(VERDICTS_LINE, VERDICTS_LINE.replace("'unknown'])", `'unknown', '${addVerdict}'])`))
  }
  if (addKind) {
    text = text.replace(KINDS_LINE, `  unknown: 'unknown',\r\n  ${addVerdict}: '${addKind}',\r\n})`)
  }
  if (useVerdict) {
    // 磁盘不足那一支改成返回新裁决（语义：不是不能升，是余量很紧）
    text = text.replace(
      "check: 'disk', verdict: 'blocked', code: PREFLIGHT_CODES.DISK_INSUFFICIENT,",
      `check: 'disk', verdict: '${useVerdict}', code: PREFLIGHT_CODES.DISK_INSUFFICIENT,`,
    )
  }
  if (text === src) throw new Error('补丁没打上——锚点变了？')
  writeFileSync(TMP, text)
  try {
    const mod = await import(`file:///${TMP.replace(/\\/g, '/')}?t=${Date.now()}_${Math.random()}`)
    return { ok: true, mod }
  } catch (e) {
    return { ok: false, error: e }
  } finally {
    rmSync(TMP)
  }
}

// ★★ 夹具必须让**另外两项都真的 ok**，否则 `ok` 为假是**别的原因**造成的，
//    探针就什么都没证明。第一版我就是这么错的：`target.productVersion` 没给，
//    于是 compatibility 自己 blocked 了 ⇒ `ok=false`，我还以为"没复现"。
//    > 一个"结论为假"的读数，与一个"别的地方先坏了"的读数，
//    > 在只看那个布尔时是同一个东西。
const manifest = (version) => ({
  version,
  productVersion: version,
  schemaVersion: 1,
  dshVersion: '1.0.0',
  dshCompositionPatchVersion: '1.0.0',
})
const runIt = (mod) => mod.runPreflight({
  stage: 'pre-switch',
  current: manifest('1.0.0'),
  target: manifest('1.0.1'),
  platform: 'win32',
  patchPair: 'match', // 只有 'match' 才 ok
  freeBytes: 10, // 磁盘明显不够
  packageBytes: 1000,
  backupBytes: 0,
  dataDirBytes: 0,
  tasks: [],
  nowMs: 1_000_000,
})

const brief = (r) => `ok=${r.ok} blocked=${JSON.stringify(r.blocked)} unknown=${JSON.stringify(r.unknown)} `
  + `checks=${r.checks.map((c) => `${c.check}:${c.verdict}`).join(',')}`

// ───────────── ① 声明第四个裁决、但**不归类**（修之前就是这一种） ─────────────
console.log('=== ① 声明 `degraded` 但不归类，并让磁盘返回它 ===')
{
  const res = await load({ addVerdict: 'degraded', useVerdict: 'degraded' })
  if (!res.ok) {
    console.log('✔ 一进模块就抛（正是想要的）：')
    console.log(`    ${String(res.error.message).split('\n')[0].slice(0, 150)}`)
  } else {
    const r = runIt(res.mod)
    console.log(`★ 没有抛 —— 汇总结果是：${brief(r)}`)
    console.log(`    remedies.disk = ${JSON.stringify(r.remedies.disk)}`)
    if (r.ok === true) {
      console.log('    ⇒ ★ 一项**不是 ok** 的裁决被报成了"可以升级"，而同一份返回值里还在给处置建议。')
    }
  }
}

// ───────────── ② 声明 + 归类成 blocking ⇒ 必须被算进 blocked ─────────────
console.log('\n=== ② 声明 `degraded` 并归类成 `blocking` ===')
{
  const res = await load({ addVerdict: 'degraded', addKind: 'blocking', useVerdict: 'degraded' })
  if (!res.ok) {
    console.log(`★ 不该抛，却抛了：${String(res.error.message).split('\n')[0].slice(0, 140)}`)
  } else {
    const r = runIt(res.mod)
    console.log(`    ${brief(r)}`)
    console.log(`    磁盘在 blocked 里吗：${r.blocked.includes('disk')}`)
    console.log(`    reasons 非空吗：${r.reasons.length > 0}`)
    console.log(r.ok === false && r.blocked.includes('disk')
      ? '✔ 新的非 ok 裁决被正确地拦住了'
      : '★ 归类成 blocking 却没被拦住')
  }
}

// ───────────── ③ 用了一个**没声明**的裁决 ⇒ 运行期当场抛 ─────────────
console.log('\n=== ③ 直接用 `half-broken`（词表里没有它） ===')
{
  const res = await load({ useVerdict: 'half-broken' })
  if (!res.ok) {
    console.log(`✔ 一进模块就抛：${String(res.error.message).split('\n')[0].slice(0, 120)}`)
  } else {
    try {
      const r = runIt(res.mod)
      console.log(`★ 没抛 —— ${brief(r)}`)
    } catch (e) {
      console.log(`✔ 运行期当场抛：${String(e.message).split('\n')[0].slice(0, 140)}`)
    }
  }
}

console.log(`\n临时文件残留: ${readFileSync ? '' : ''}${(() => { try { readFileSync(TMP); return true } catch { return false } })()}`)
