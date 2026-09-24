// scratch/_probe-record-wired.mjs —— 证明"声明一个第二可选字段"现在真的通（**不提交**）
//
// ★ 这是第 40 轮那处修复的**正向证据**：同一个动作（加一个字段到声明里），
//   修复前是**静默丢掉**，修复后是**带得过去**；而"忘了登记"则**具名上抛**。
import {
  RUN_RECORD_OPTIONAL_FIELDS,
  RUN_RECORD_CODES,
  buildRunRecord,
  recordWiring,
  validateRunRecord,
} from '../product/launcher/run-record.mjs'

console.log('=== ① 当下（未注入）：声明与实际接线对得上吗 ===')
console.log('  ', JSON.stringify(recordWiring()))

console.log('\n=== ② 注入一个"新读数 diskUsageBytes"（模拟下一个人照注释加一项）===')
const optionalFields = [...RUN_RECORD_OPTIONAL_FIELDS, 'diskUsageBytes']
const optionalReaders = {
  peakResource: (p) => (p?.peakResource ?? null),
  diskUsageBytes: (p) => (typeof p?.diskUsageBytes === 'number' ? p.diskUsageBytes : null),
}
const optionalValidators = {
  peakResource: () => {},
  diskUsageBytes: (v, where, problems) => {
    if (v !== null && !(typeof v === 'number' && v >= 0)) problems.push(`${where}.diskUsageBytes 坏`)
  },
}
const rec = buildRunRecord({
  runId: 'r', startedAt: 'T',
  processes: [{ key: 'hub', pid: 111, image: 'node', peakResource: null, diskUsageBytes: 512 }],
  optionalFields, optionalReaders,
})
console.log('   写出字段 =', JSON.stringify(Object.keys(rec.processes[0])))
console.log('   diskUsageBytes 带过去了吗 =',
  rec.processes[0].diskUsageBytes === 512 ? '★ 带过去了（修复生效）' : '✖ 还是丢的')
console.log('   校验（好值）=', JSON.stringify(validateRunRecord(rec, { optionalFields, optionalValidators }).problems))

const bad = buildRunRecord({
  runId: 'r', startedAt: 'T',
  processes: [{ key: 'hub', pid: 111, image: 'node', diskUsageBytes: -1 }],
  optionalFields, optionalReaders,
})
console.log('   校验（坏值）=', JSON.stringify(validateRunRecord(bad, { optionalFields, optionalValidators }).problems))

console.log('\n=== ③ 忘了登记取法 ⇒ 具名上抛，不是静默丢掉 ===')
try {
  buildRunRecord({
    runId: 'r', startedAt: 'T', processes: [{ key: 'hub', pid: 1, image: 'node' }],
    optionalFields: [...RUN_RECORD_OPTIONAL_FIELDS, 'neverRegistered'],
  })
  console.log('   ✖ 没有上抛（这就是修复前那种静默）')
} catch (e) {
  console.log('   ✓ 上抛 code =', e.code, '（等于 FIELD_NOT_WIRED ?',
    e.code === RUN_RECORD_CODES.FIELD_NOT_WIRED, '）')
  console.log('     fields =', JSON.stringify(e.fields))
}

console.log('\n=== ④ 反向控制：旧记录（只有三个字段）必须仍然算好记录 ===')
const legacy = { version: rec.version, runId: 'r', launcherPid: null, startedAt: 'T',
  processes: [{ key: 'hub', pid: 111, image: 'node' }] }
console.log('   旧记录 =', JSON.stringify(validateRunRecord(legacy)))

console.log('\n=== ⑤ 反向：登记了却没人声明 ⇒ 同样报出来（另一个方向的静默）===')
console.log('  ', JSON.stringify(recordWiring({ optionalReaders: { ...optionalReaders, obsoleteProbe: () => null } })))
