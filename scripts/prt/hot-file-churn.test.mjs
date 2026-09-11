// scripts/prt/hot-file-churn.test.mjs — 阶段 3 评审闸门探针单测
//
// 只测能纯函数化的部分（窗口切分），以及**测量方法本身**：
// 本工具存在的理由是「随手写的那句 git log 是错的」，所以有一条用例
// 直接锁定正确写法与错误写法的差异——否则下一个人很容易「简化」回去。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HOT_FILES, collectChurn, windowRanges } from './hot-file-churn.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()

// ---------------------------------------------------------------- 窗口切分

test('① 窗口覆盖且不重叠', () => {
  const w = windowRanges(100, 40, 6)
  assert.equal(w.length, 3, '100 个提交 / 窗口 40 应有 3 个窗口')
  assert.deepEqual(w.map((x) => [x.from, x.to]), [[0, 40], [40, 80], [80, 100]])
  // 不重叠：相邻窗口首尾相接
  for (let i = 1; i < w.length; i++) assert.equal(w[i].from, w[i - 1].to)
})

test('① 不足一个窗口时只返回一个不完整窗口，且标记 complete=false', () => {
  const w = windowRanges(17, 40, 6)
  assert.equal(w.length, 1)
  assert.equal(w[0].complete, false)
  assert.deepEqual([w[0].from, w[0].to], [0, 17])
})

test('① 恰好整除时最后一个窗口是完整的（off-by-one 高发处）', () => {
  const w = windowRanges(80, 40, 6)
  assert.equal(w.length, 2)
  assert.equal(w[1].complete, true)
  assert.deepEqual([w[1].from, w[1].to], [40, 80])
})

test('① 空仓库不产生窗口', () => {
  assert.deepEqual(windowRanges(0, 40, 6), [])
})

test('① 非法参数抛错而不是静默返回空', () => {
  assert.throws(() => windowRanges(100, 0, 6), /window 必须是正整数/)
  assert.throws(() => windowRanges(100, -1, 6), /window 必须是正整数/)
  assert.throws(() => windowRanges(100, 40, 0), /windows 必须是正整数/)
})

// ---------------------------------------------------------------- 测量方法

test('② 正确写法：区间内路径过滤，得到「这 N 个提交里有几个碰了该文件」', () => {
  const all = git(['rev-list', 'HEAD']).split('\n').filter(Boolean)
  const f = HOT_FILES[0]
  const n = Math.min(40, all.length)
  const oldest = all[n - 1]
  const correct = git(['log', '--format=%h', `${oldest}^..${all[0]}`, '--', f]).split('\n').filter(Boolean).length
  // 必须 ≤ 窗口大小——这正是错误写法唯一不可能满足的性质
  assert.ok(correct <= n, `区间内计数 ${correct} 不应超过窗口 ${n}`)
})

test('② 错误写法会返回窗口大小的假象（本工具存在的原因）', () => {
  const all = git(['rev-list', 'HEAD']).split('\n').filter(Boolean)
  const f = HOT_FILES[0]
  const n = Math.min(40, all.length)
  const lifetime = git(['log', '--format=%h', '--', f]).split('\n').filter(Boolean).length
  if (lifetime < n) {
    // 累计次数不足窗口时，错误写法退化为累计次数，暴露不出问题
    assert.ok(true)
    return
  }
  const wrong = git(['log', '-n', String(n), '--format=%h', '--', f]).split('\n').filter(Boolean).length
  assert.equal(wrong, n, '错误写法应返回窗口大小（先按路径过滤再截断）')
  const oldest = all[n - 1]
  const correct = git(['log', '--format=%h', `${oldest}^..${all[0]}`, '--', f]).split('\n').filter(Boolean).length
  assert.notEqual(wrong, correct, '两种写法必须给出不同结果，否则这条用例失去意义')
})

// ---------------------------------------------------------------- collectChurn

const churn = collectChurn({ size: 40, windows: 3 })

test('③ collectChurn 报告 HEAD、总数与两个热点文件', () => {
  assert.equal(churn.ok, true)
  assert.ok(churn.totalCommits > 50, `提交数 ${churn.totalCommits} 偏少，探针可能读错仓库`)
  assert.deepEqual(Object.keys(churn.files).sort(), [...HOT_FILES].sort())
})

test('③ 每个文件的窗口计数都不超过窗口大小（防错误写法回归）', () => {
  for (const v of Object.values(churn.files)) {
    assert.ok(v.windows.length > 0, `${v.path} 无窗口`)
    for (const w of v.windows) {
      assert.ok(w.count <= churn.windowSize, `${v.path} 第 ${w.rank} 窗口计数 ${w.count} > ${churn.windowSize}：可能又改成错误写法了`)
    }
  }
})

test('③ 累计次数与最近窗口计数是两个不同的量（不能互相替代）', () => {
  for (const v of Object.values(churn.files)) {
    assert.ok(v.lifetimeCommits >= v.recent, `${v.path} 累计 ${v.lifetimeCommits} 应 ≥ 最近窗口 ${v.recent}`)
  }
})

test('③ 记录了最近一次触及的日期与提交（评审要能追到具体那次改动）', () => {
  for (const v of Object.values(churn.files)) {
    assert.match(v.lastChangeDate, /^\d{4}-\d{2}-\d{2}$/, `${v.path} 缺最近改动日期`)
    assert.match(v.lastChangeCommit, /^[0-9a-f]{7,}$/, `${v.path} 缺最近改动提交`)
    assert.ok(typeof v.lastChangeDistance === 'number' && v.lastChangeDistance >= 0)
    assert.ok(typeof v.lastChangeSubject === 'string' && v.lastChangeSubject.length > 0)
  }
})

test('④ 判定给出理由与阈值，而不是一个孤立的布尔', () => {
  const v = churn.verdict
  assert.equal(typeof v.cooled, 'boolean')
  assert.equal(typeof v.recentMax, 'number')
  assert.equal(typeof v.historicalPeak, 'number')
  assert.equal(typeof v.absoluteBar, 'number')
  assert.ok(typeof v.reason === 'string' && v.reason.length > 0, '判定必须带理由')
  assert.ok(v.recentMax <= churn.windowSize)
})

test('④ 非 git 目录返回可读原因而非抛错（不向 stderr 漏 fatal）', () => {
  // 用新建的临时目录：确定不是任何仓库的一部分（往仓库上层走可能仍是别的仓库）
  const outside = mkdtempSync(join(tmpdir(), 'prt-churn-nogit-'))
  try {
    const res = collectChurn({ cwd: outside })
    assert.equal(res.ok, false)
    assert.match(res.reason, /不是 git 仓库/)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})
