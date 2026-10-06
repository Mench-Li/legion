import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// BUG-012 回归：**「按重启确定的孤儿回收」必须跑在「按超龄猜的租约回收」之前**。
//
// 现场（2026-10-06）：守护把两条回收的次序写反了，于是 T-189 的写入预约被冻结成 `reconciling`，
// 850 次认领失败（每 30 秒一次、持续 7 小时），它的整仓独占预约把 T-190 一起堵死，
// 整个 software 空间零进展 —— 而解开它需要的是一次人工 `confirm-stopped`。
// 详见 docs/bugs/BUG-012-boot-orphan-reclaim-order.md。
//
// **为什么这条只能按源码钉**：两条回收各自都是对的，问题**只在它们的先后**。
//   · `team-hub/claim-reservation.e2e.test.mjs` 的 ⑯①② 把两条路径各自钉死了（各绿）；
//   · ⑯③④ 补上了"同一个老孤儿 + 生产次序"这个组合（解释次序为什么不能反）；
//   · 但**没有任何一条行为用例能拦住"有人把这两行调换回去"** —— 调换之后，
//     e2e 那四条仍然全绿（它们测的是 Hub 侧，Hub 侧两条路径本身没变），
//     只有守护的**调用点**变了。所以要在这里按源码钉住那个调用点。
//
// 这与 `pipeline-resume-guidance.test.mjs` 是同一手法（把"顺序/接线"这类
// tsc 抓不到、行为测试也抓不到的东西，直接钉在源码文本上）。
//
// ★ 本文件有一条自己踩出来的纪律：**要钉「代码里必须这么做」的断言，必须在去掉注释的文本上做。**
//   ③ 的第一版就被注释满足了 —— 变异把 `byId` 改成深拷贝（真缺陷），用例照样绿，
//   因为上方那段注释里**原样引用了**那一行代码。见 `codeOnly` 的注释。

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INDEX_RAW = readFileSync(join(ROOT, 'plugins', 'src', 'index.ts'), 'utf8')
const RECLAIM_RAW = readFileSync(join(ROOT, 'plugins', 'src', 'reclamation.ts'), 'utf8')

/**
 * 去掉整行注释后的源码。
 *
 * 为什么必须这样：本文件要钉的那几行，**恰好被相邻的注释原样引用**（那是刻意的，
 * 注释在解释"为什么不能反过来"，自然要写出那行代码）。于是
 * `assert.match(SRC, /<那行代码>/)` 会被**注释**满足，而代码本身已经被改坏 ——
 * 一个"断言的目标在文件里不唯一"的判据，等于没有判据。
 * （这与 BUG-010 用例 ① 的"切片范围比断言对象大"是同一种错。）
 */
const codeOnly = (src) => src.split('\n').filter((line) => {
  const t = line.trim()
  return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
}).join('\n')

const INDEX = codeOnly(INDEX_RAW)
const RECLAIM = codeOnly(RECLAIM_RAW)

const BOOT_CALL = 'await reclamation.reclaimBootOrphans(tasks, byId)'
const STALE_CALL = 'await reclamation.reclaimStaleLeases(byId)'

test('① 调用点：孤儿回收（证明）必须排在租约回收（猜测）之前', () => {
  const bootAt = INDEX.indexOf(BOOT_CALL)
  const staleAt = INDEX.indexOf(STALE_CALL)
  assert.ok(bootAt > 0, `找不到 ${BOOT_CALL}（锚点失效说明它被改写或搬走了）`)
  assert.ok(staleAt > 0, `找不到 ${STALE_CALL}（锚点失效说明它被改写或搬走了）`)
  assert.equal(INDEX.split(BOOT_CALL).length - 1, 1, '调用点必须唯一（注释里引用它不算 —— 这里已去注释）')
  assert.equal(INDEX.split(STALE_CALL).length - 1, 1, '调用点必须唯一（注释里引用它不算 —— 这里已去注释）')
  assert.ok(bootAt < staleAt,
    '次序反了：超龄回收会先把任务改成 todo 并**冻结**写入资格，'
    + '随后的孤儿回收按 `status === \'in_progress\'` 再也看不到它 —— T-189 就是这样被冻结 7 小时的')
})

test('② 次序的理由必须写在调用点上（否则下一个人会「顺手」调换）', () => {
  // 这一条**故意**读注释：它要钉的就是"理由还在不在"。
  const from = INDEX_RAW.indexOf('// 0/0.5 认领租约回收')
  const to = INDEX_RAW.indexOf(STALE_CALL)
  assert.ok(from > 0 && to > from, '找不到调用点之前那段注释（结构变了，请重新对齐这段判据）')
  const comment = INDEX_RAW.slice(from, to)
  assert.match(comment, /BUG-012/, '注释必须留下案号 —— 否则它读起来只是一段多余的讲究')
  assert.match(comment, /证明/, '必须说清「孤儿回收手里是证明」')
  assert.match(comment, /猜测/, '必须说清「超龄回收手里只是猜测」')
  assert.match(comment, /in_progress/,
    '必须说清机制：猜测先跑会把任务改成 todo，于是证明那句 in_progress 过滤就看不到它了')
})

test('③ 次序之所以重要，是因为两条回收读的是**同一批对象**', () => {
  // 这条不是装饰：如果 `byId` 哪天变成一份拷贝，"谁先跑"就不再重要，
  // 那么①② 的论证前提就变了 —— 测试应当在这里说话，而不是让注释继续说一件不再成立的事。
  assert.match(INDEX, /const byId = new Map\(tasks\.map\(t => \[t\.id, t\]\)\)/,
    '找不到 byId 的构造：它必须仍是「Map 的值 = tasks 数组里的那些对象」——'
    + '两条回收正是靠这个共享才互相看不见/看得见，这是本缺陷成立的前提')
})

test('④ 机制的另一半：孤儿回收的入口是 `status === \'in_progress\'`', () => {
  const at = RECLAIM.indexOf('async function reclaimBootOrphans')
  assert.ok(at > 0, '找不到 reclaimBootOrphans（锚点失效）')
  const body = RECLAIM.slice(at, at + 1200)
  assert.match(body, /\.filter\(t => t\.status === 'in_progress'/,
    '孤儿回收必须仍按 in_progress 找候选 —— 这正是被"先跑的超龄回收改成 todo"打掉的那一步')
})

test('⑤ 反序的代价必须写进模块头（它解释了 bug 为什么能活一个版本期）', () => {
  // 与 ② 同样**故意**读注释。
  //
  // ★ 这里必须钉**小节标题本身**，不能只钉那句话：文件里有三处写着「次序是语义的一部分」
  //   —— 一处是文件头的小节标题，另外两处只是**引用它**（"理由见文件头「…」"）。
  //   只匹配那句话的话，把标题整段删掉、引用还留着，用例照样绿。
  //   （这是本文件第三次踩"锚不唯一"：前两次是 ③ 被注释满足、M5 只删了标题却没红。）
  assert.match(RECLAIM_RAW, /^\/\/ ## ★ 次序是语义的一部分/m,
    'reclamation.ts 的文件头必须留下这条**小节**（不只是别处引用它）—— 它正是本文件存在的理由')
  assert.match(RECLAIM_RAW, /BUG-012/, '文件头必须留案号')
})
