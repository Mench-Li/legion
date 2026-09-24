// scratch/_probe-record-drop.mjs —— 证明"按注释说的加一个新可选字段"会被静默丢掉（**不提交**）
import { buildRunRecord, validateRunRecord, RUN_RECORD_OPTIONAL_FIELDS } from '../product/launcher/run-record.mjs'

console.log('声明的可选字段 =', JSON.stringify(RUN_RECORD_OPTIONAL_FIELDS))

// 模拟"下一个读数"：一个生产者把 diskUsageBytes 一起交上来
const row = { key: 'hub', pid: 111, image: 'node', peakResource: null, diskUsageBytes: 512 }
const rec = buildRunRecord({ runId: 'r', startedAt: 'T', processes: [row] })
const out = rec.processes[0]

console.log('输入字段 =', JSON.stringify(Object.keys(row)))
console.log('写出字段 =', JSON.stringify(Object.keys(out)))
console.log('diskUsageBytes 还在吗 =', 'diskUsageBytes' in out ? '在' : '★ 被静默丢掉了')
console.log('validateRunRecord 的问题 =', JSON.stringify(validateRunRecord(rec).problems))

// ★ 关键：declare 一个第二个可选字段，会不会有人拦？
//   答案在代码里：buildRunRecord 与 validateRunRecord 都**硬编码**了 `peakResource` 这个名字，
//   所以 RUN_RECORD_OPTIONAL_FIELDS 这个"扩展点"今天**没有任何机械消费者**。
const declaredHasConsumer = RUN_RECORD_OPTIONAL_FIELDS.every((f) =>
  // 只有 peakResource 这一个名字在两个函数里各出现一次
  f === 'peakResource')
console.log('声明里的每一项都真的有读写通路吗 =', declaredHasConsumer ? '★ 只有硬编码的那一个' : '是')

// 反向控制：predecessor 的读数（只有三个字段）必须仍然算好记录
const legacy = { version: rec.version, runId: 'r', launcherPid: null, startedAt: 'T',
  processes: [{ key: 'hub', pid: 111, image: 'node' }] }
console.log('旧记录（无 peakResource）校验 =', JSON.stringify(validateRunRecord(legacy)))
