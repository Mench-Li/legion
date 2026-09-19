// scratch/_peek-peak.mjs —— peakResource 那句 + run-peak-resource 实测（**不提交**）
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const doc = readFileSync('D:/project/DSH/legion/docs/MULTI-AGENT-FEATURE-STATUS.md', 'utf8')
const needle = 'peakResource'
const idx = [...doc.matchAll(new RegExp(needle, 'g'))].map((m) => m.index)
for (const i of idx.slice(0, 6)) {
  const line = doc.slice(0, i).split('\n').length
  console.log(`@${i} (第 ${line} 行): ...${doc.slice(Math.max(0, i - 130), i + 110).replace(/\n/g, ' ')}...`)
  console.log('')
}
for (const f of ['orchestrator/worker/run-peak-resource.test.mjs', 'product/launcher/peak-resource.test.mjs']) {
  try {
    const r = execFileSync('node', ['--test', f], { cwd: 'D:/project/DSH/legion', encoding: 'utf8', maxBuffer: 32e6 })
    const m = /ℹ tests (\d+)/.exec(r)
    console.log(`${f} = ${m ? m[1] : '?'}`)
  } catch (e) {
    const s = String(e.stdout ?? '') + String(e.stderr ?? '')
    const m = /ℹ tests (\d+)/.exec(s)
    console.log(`${f} = ${m ? m[1] : '?'} (exit≠0)`)
  }
}
