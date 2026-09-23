// 决定性实测：把 LEGION_PATH_SCOPE / LEGION_CONNECTOR_DECLARATIONS 放进 runtime 进程的
// env 值里，`buildChildEnv()` 会抛、还是会放行？
import { buildChildEnv } from '../product/launcher/allowlist.mjs'
import { PROCESS_SPECS } from '../product/process-manifest.mjs'

const rt = PROCESS_SPECS.find((s) => s.key === 'runtime')
console.log('runtime envNames 里有这两个键吗：')
for (const k of ['LEGION_PATH_SCOPE', 'LEGION_CONNECTOR_DECLARATIONS', 'TEAM_HUB_TOKEN']) {
  console.log('  ' + k.padEnd(32) + (rt.envNames.includes(k) ? '✔ 有' : '✖ 没有'))
}
console.log('')
for (const k of ['LEGION_PATH_SCOPE', 'LEGION_CONNECTOR_DECLARATIONS', 'TEAM_HUB_TOKEN', 'LEGION_ACTOR']) {
  try {
    const r = buildChildEnv({ spec: rt, baseEnv: {}, values: { [k]: 'x' } })
    console.log('  values 里给 ' + k.padEnd(32) + '⇒ 不抛，env 里' + (r.env[k] !== undefined ? '★ 出现了' : '没有出现'))
  } catch (e) {
    console.log('  values 里给 ' + k.padEnd(32) + '⇒ ★★ **抛**：' + String(e.message).slice(0, 90))
  }
}
console.log('')
for (const k of ['LEGION_PATH_SCOPE', 'LEGION_CONNECTOR_DECLARATIONS']) {
  const r = buildChildEnv({ spec: rt, baseEnv: { [k]: 'from-host' }, values: {} })
  console.log('  baseEnv 里带 ' + k.padEnd(30) + '⇒' + (r.env[k] !== undefined ? ' 被放行' : '★ 被丢掉') + '，dropped=' + JSON.stringify(r.dropped ?? null))
}
