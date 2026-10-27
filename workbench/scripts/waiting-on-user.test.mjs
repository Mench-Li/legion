// workbench/scripts/waiting-on-user.test.mjs
// ---------------------------------------------------------------------------
// `waitingOnUser.ts` 的判据（T2.3）。
//
// 这一组要钉住的不是"❓ 开头算待确认"这种显然的事，而是**边界**：
//   · 只看最后一条（否则早答完的老任务会永远挂着）；
//   · 前导空白仍算（守护偶尔会带缩进）；
//   · 空评论、空数组、null 都不误判；
//   · 详情与看板必须用**同一个函数**（否则同一张卡两处说法不同）。
//
// 运行：node workbench/scripts/waiting-on-user.test.mjs
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  askPointCount, isAskMarker, isWaitingOnUser, pendingAskComment,
} from '../src/waitingOnUser.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src')

test('① 只看最后一条：答复之后的旧 ❓ 不得让任务继续"待确认"', () => {
  const asked = { comments: [{ text: '开工' }, { text: '❓ 用 A 还是 B？' }] }
  assert.equal(isWaitingOnUser(asked), true)
  const answered = { comments: [{ text: '开工' }, { text: '❓ 用 A 还是 B？' }, { text: '用 A' }] }
  assert.equal(isWaitingOnUser(answered), false, '★★ 答案在末尾 ⇒ 不再待确认')
  // ★★ 反例：若判据写成"任意一条 ❓"，answered 会判 true —— 这条就是防它的。
  assert.equal(isWaitingOnUser({ comments: [{ text: '❓ 老问题' }, { text: '已答' }] }), false)
})

test('② 前导空白仍算作标记（trimStart），但正文中间的不算', () => {
  assert.equal(isAskMarker('  ❓ 缩进的提问'), true)
  assert.equal(isAskMarker('❓提问'), true)
  assert.equal(isAskMarker('这条不是提问，里面提到 ❓'), false, '★ 不是开头就不算')
  assert.equal(isAskMarker(''), false)
  assert.equal(isAskMarker(null), false)
  assert.equal(isAskMarker(undefined), false)
})

test('③ 空数据不误判：没有评论 / null / 空对象', () => {
  assert.equal(isWaitingOnUser({ comments: [] }), false)
  assert.equal(isWaitingOnUser({ comments: null }), false)
  assert.equal(isWaitingOnUser({}), false)
  assert.equal(isWaitingOnUser(null), false)
  assert.equal(isWaitingOnUser(undefined), false)
  // ★ 评论对象里 text 缺失：不能抛，也不能判成"在问"
  assert.equal(isWaitingOnUser({ comments: [{}] }), false)
})

test('④ `pendingAskComment` 与 `isWaitingOnUser` 结论必须一致', () => {
  const cases = [
    { comments: [{ text: '❓ 问' }] },
    { comments: [{ text: '❓ 问' }, { text: '答' }] },
    { comments: [] },
    {},
  ]
  for (const task of cases) {
    assert.equal(
      pendingAskComment(task) !== null,
      isWaitingOnUser(task),
      `★ 两条判据对同一任务给出了不同结论：${JSON.stringify(task)}`,
    )
  }
})

test('⑤ 点数：只数以 ❓ 开头的行，不数正文里的符号', () => {
  assert.equal(askPointCount('❓ A\n❓ B\n说明文字'), 2)
  assert.equal(askPointCount('  ❓ 缩进的一行'), 1)
  assert.equal(askPointCount('一句提到 ❓ 但不以它开头'), 0)
  assert.equal(askPointCount(''), 0)
  assert.equal(askPointCount(null), 0)
})

test('⑥ ★★★ 详情与看板必须用**同一个**判据（不许再各写一遍）', () => {
  // 这条是本次抽函数的全部理由：此前两处各有一份实现，改一处就会分叉。
  const files = ['components/TaskDetailModal.tsx', 'components/TaskCenterView.tsx']
  for (const file of files) {
    const source = readFileSync(join(SRC, file), 'utf8')
    assert.match(source, /from '\.\.\/waitingOnUser'/, `★★ ${file} 必须从 waitingOnUser 引入判据`)
    // 反例守卫：文件里若又出现内联的 `startsWith('❓')` 判定，说明有人写了第三份。
    const inline = source.match(/startsWith\('❓'\)/g) ?? []
    assert.equal(inline.length, 0,
      `★★★ ${file} 里还有 ${inline.length} 处内联 ❓ 判据：判据只能有一处`)
  }
})
