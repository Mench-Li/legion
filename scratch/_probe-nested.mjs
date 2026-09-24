// scratch/_probe-nested.mjs —— 在 node --test 里 spawn node --test 会怎样（**不提交**）
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'

test('诊断嵌套调用', () => {
  console.log('父进程相关 env: ' + JSON.stringify(Object.keys(process.env).filter((k) => /NODE_|TEST/.test(k))))
  for (const variant of [
    ['默认', {}],
    ['清 NODE_TEST_CONTEXT', { strip: ['NODE_TEST_CONTEXT'] }],
    ['用 tap reporter', { args: ['--test-reporter=tap'] }],
  ]) {
    const [label, opt] = variant
    const env = { ...process.env }
    for (const k of opt.strip ?? []) delete env[k]
    const args = ['--test', ...(opt.args ?? []), 'team-hub/budget-alert.test.mjs']
    let out = ''
    try {
      out = execFileSync('node', args, { cwd: 'D:/project/DSH/legion', encoding: 'utf8', env, maxBuffer: 32e6 })
    } catch (e) { out = String(e.stdout ?? '') + String(e.stderr ?? '') }
    const spec = /ℹ tests (\d+)/.exec(out)
    const tap = /^1\.\.(\d+)/m.exec(out)
    console.log(`${label}: len=${out.length}  ℹtests=${spec ? spec[1] : '-'}  tapPlan=${tap ? tap[1] : '-'}`)
  }
})
