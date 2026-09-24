// scripts/probes/_probe-t10-build-targets.mjs
// T10 变异验证：把"路径过期"与"少写一条"两种错各造一次，看判据咬不咬。
//   ① 把注册表包的路径写回**已不存在**的旧路径 ⇒ build-targets-exist 必须红，
//      且 `build-external-package.mjs plugins` 必须红（并打印 dependency target missing）；
//   ② 从构建配置里**删掉**一个 peer 依赖的条目 ⇒ build-targets-exist 必须红（方向②）。
// 每次改完都逐字还原，并复核判据回绿。
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const F = resolve(REPO, 'scripts/ci/build-external-package.mjs')
const PROBE = resolve(REPO, 'scripts/probes/build-targets-exist.mjs')

const run = (args) => spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8' })
const original = readFileSync(F, 'utf8')
let failures = 0

const apply = (label, from, to, expectProbeRed, expectNeedle) => {
  const n = original.split(from).length - 1
  if (n !== 1) { console.log(`  ✖ ${label}：锚点命中 ${n} 次`); failures += 1; return }
  writeFileSync(F, original.replace(from, to))
  const r = run([PROBE])
  const red = r.status !== 0
  const sawNeedle = `${r.stdout}\n${r.stderr}`.includes(expectNeedle)
  console.log(`  ${red === expectProbeRed && sawNeedle ? '✔' : '✖'} ${label}：判据 ${red ? `红(${r.status})` : '绿'}`
    + `（期望${expectProbeRed ? '红' : '绿'}），打印含"${expectNeedle}"=${sawNeedle}`)
  if (red !== expectProbeRed || !sawNeedle) failures += 1
  writeFileSync(F, original)
}

// ① 路径过期
apply('① 注册表包路径写回旧的不存在路径', "'@deepseek-ai/dsh-agent-preset-registry','packages/preset/agent-preset-registry'", "'@deepseek-ai/dsh-agent-preset-registry','packages/preset/agent-presets'", true, 'agent-presets')
{
  // 同一方向上，**构建**也必须红（否则"构建自己会拦住"这句话没有依据）
  writeFileSync(F, original.replace("'@deepseek-ai/dsh-agent-preset-registry','packages/preset/agent-preset-registry'", "'@deepseek-ai/dsh-agent-preset-registry','packages/preset/agent-presets'"))
  const b = run(['scripts/ci/build-external-package.mjs', 'plugins'])
  const saw = `${b.stdout}\n${b.stderr}`.includes('dependency target missing')
  console.log(`  ${b.status !== 0 && saw ? '✔' : '✖'} ①b 构建也红：exit=${b.status}，含"dependency target missing"=${saw}`)
  if (b.status === 0 || !saw) failures += 1
  writeFileSync(F, original)
}

// ② 少写一条（peer 依赖在配置里没有条目）
apply('② 删掉 dsh-session 的条目', "['@deepseek-ai/dsh-session','packages/core/session'],", '', true, 'dsh-session')

// 还原后必须回绿
const green = run([PROBE])
console.log(`  ${green.status === 0 ? '✔' : '✖'} 还原后判据回绿：exit=${green.status}`)
if (green.status !== 0) failures += 1
const identical = readFileSync(F, 'utf8') === original
console.log(`  ${identical ? '✔' : '✖'} 文件逐字还原：${identical}`)
if (!identical) failures += 1

console.log(failures === 0 ? '\n  ⇒ T10 变异验证全过（3 条方向 + 构建交叉）' : `\n  ⇒ 有 ${failures} 处不达预期`)
process.exit(failures === 0 ? 0 : 1)
