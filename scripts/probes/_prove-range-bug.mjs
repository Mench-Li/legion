// scripts/probes/_prove-range-bug.mjs —— 证明 boundary-facts 的范围终点读到的是 undefined（**不提交**）
//
// `LINE_CITATION_RE` 有 **3** 个捕获组：
//     1 = path   2 = from   3 = to
// 而 `scanLineCitations` 里读的是 **`m[4]`**：
//     const key = `${m[1]}...:${m[2]}${m[4] ? `-${m[4]}` : ''}`
//     to: m[4] ? Number(m[4]) : Number(m[2])
// ⇒ `m[4]` 恒为 `undefined` ⇒ **范围终点永远等于起点**。
//
// 后果（都能实测）：`file.mjs:600-9999` 这个**明确越界**的范围，
// 被判成"只引了第 600 行"（600 <= 614）⇒ **静默放过**。
// 台账里 `run-floor.mjs:544-559` / `executor-binding.mjs:254-261`
// 两个范围引用因此**从来没有被当成范围查过**。
import { scanLineCitations } from '../scripts/prt/boundary-facts.mjs'

const BT = String.fromCharCode(96) // 反引号：避免在源码里写出来
const cite = (s) => BT + s + BT

const rangeOutOfBounds = scanLineCitations(cite('runtime/dsh-composition/run-floor.mjs:600-9999'))
console.log('① 范围越界 run-floor.mjs:600-9999（文件 614 行）')
console.log('   total=' + rangeOutOfBounds.total + '  checked=' + rangeOutOfBounds.checked
  + '  broken=' + JSON.stringify(rangeOutOfBounds.broken))
console.log('   ⇒ ' + (rangeOutOfBounds.broken.length === 0
  ? '★ **没报出来** —— off-by-one 证实'
  : '报出来了（则我的判断错了）'))
console.log('   ★ 而它的 total 是 ' + rangeOutOfBounds.total
  + '：范围被当成**单行**，所以"解析到几条"这个计数也是错的')

const single = scanLineCitations(cite('runtime/dsh-composition/run-floor.mjs:9999'))
console.log('\n② 对照：单行越界 :9999')
console.log('   broken=' + JSON.stringify(single.broken))
console.log('   ⇒ ' + (single.broken.length > 0 ? '报出来了（单行这条路是好的）' : '★ 也没报'))
