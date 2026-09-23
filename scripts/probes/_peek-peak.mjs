// scripts/probes/_peek-peak.mjs —— peakResource 那句 + run-peak-resource 实测
//
// ★ 第 83 轮修：原来这一行写「（**不提交**）」，而它**早就提交了** ——
//   一句自称的意图与它的实际状态不一致（无害，但正是本批一直在修的那类）。
// ★ 第 83 轮修（更要紧的）：原来对**不存在的文件**只打 `= ? (exit≠0)`。
//   那个读数看起来像"那个套件是红的"，而真因是"**我在指一个不在那儿的文件**"。
//   ⇒ 现在先判文件在不在，不在就**点名说出来**。
//   > 一个读不到的文件与一个跑红了的套件，在输出里长得一样 ——
//   > 而它们的修法完全不同（一个要改路径，一个要改代码）。
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = 'D:/project/DSH/legion'
const doc = readFileSync(`${ROOT}/docs/MULTI-AGENT-FEATURE-STATUS.md`, 'utf8')
const needle = 'peakResource'
const idx = [...doc.matchAll(new RegExp(needle, 'g'))].map((m) => m.index)
for (const i of idx.slice(0, 6)) {
  const line = doc.slice(0, i).split('\n').length
  console.log(`@${i} (第 ${line} 行): ...${doc.slice(Math.max(0, i - 130), i + 110).replace(/\n/g, ' ')}...`)
  console.log('')
}

let missing = 0
for (const f of ['orchestrator/worker/run-peak-resource.test.mjs', 'product/launcher/peak-resource.test.mjs']) {
  if (!existsSync(`${ROOT}/${f}`)) {
    missing += 1
    console.log(`${f} = ★ **文件不存在**（不是"套件是红的"）—— 本条读数作废，先改路径`)
    continue
  }
  let s = ''
  let exitBad = false
  try {
    s = execFileSync('node', ['--test', f], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32e6 })
  } catch (e) {
    s = String(e.stdout ?? '') + String(e.stderr ?? '')
    exitBad = true
  }
  const m = /ℹ tests (\d+)/.exec(s)
  console.log(`${f} = ${m ? m[1] : '（没解析出用例数）'}${exitBad ? ' (exit≠0)' : ''}`)
}
if (missing > 0) console.log(`\n  ⇒ ${missing} 个路径不在那儿 —— 那些读数**不能**当"套件红"用`)
