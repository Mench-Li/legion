// T-011 测试证据：对 greet 交付物做边界/输入契约探针（不改产品代码，只读）。
import { greet } from '../../tests/e2e-acceptance/greet.mjs'

const cases = [
  ['契约样例', 'Ada'],
  ['含空格（多词）', 'Ada Lovelace'],
  ['中文名', '小明'],
  ['空字符串', ''],
  ['undefined', undefined],
  ['null', null],
  ['数字 123', 123],
  ['含换行', 'A\nB'],
  ['前后空白', '  Ada  '],
  ['较长文本', 'A'.repeat(2000)],
]
for (const [label, input] of cases) {
  let out
  try { out = { ok: true, value: greet(input) } }
  catch (e) { out = { ok: false, error: (e && e.constructor && e.constructor.name) + ': ' + (e && e.message) } }
  console.log(label.padEnd(10) + ' ' + JSON.stringify(out).slice(0, 120))
}
console.log('typeof(greet(undefined)) =', typeof greet(undefined))
