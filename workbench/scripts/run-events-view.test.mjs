// workbench/scripts/run-events-view.test.mjs
// ---------------------------------------------------------------------------
// `runEventsView.ts` 的判据。
//
// 这一组问的不是"13 类事件的中文对不对"，而是三件**看起来都正常**的坏事：
//   ① 上游产生了一种我们不认识的事件 —— 它会不会被悄悄丢掉；
//   ② 读取失败 —— 会不会被渲染成"这次运行很干净"；
//   ③ 摘要 —— 会不会把工具失败淹在几百条增量消息里。
//
// 运行：node workbench/scripts/run-events-view.test.mjs
// ---------------------------------------------------------------------------
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  RUN_EVENT_LABELS, runEventsHeadline, runEventsSection,
} from '../src/runEventsView.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')

test('① ★★★ `known === false` 必须显式露出来，不许被过滤', () => {
  const section = runEventsSection([
    { seq: 1, type: 'run.started', known: true },
    { seq: 2, type: 'brand.new.event', known: false, event: { whatever: 1 } },
  ])
  assert.equal(section.state, 'ok')
  assert.equal(section.events.length, 2, '★ 未知事件不许被丢掉')
  const unknown = section.events[1]
  assert.equal(unknown.known, false)
  assert.equal(unknown.label, '未识别事件（brand.new.event）')
  assert.equal(unknown.summary, '', '★ 未识别类型的正文不进摘要')
  assert.equal(section.unknownCount, 1)
  assert.match(runEventsHeadline(section), /1 条本版本不认识/, '★ 摘要要主动提示')
})

test('② ★★★ 读取失败 ≠ 没有事件：三态必须分得开', () => {
  const unreadable = runEventsSection(null, '中枢不可达')
  assert.equal(unreadable.state, 'unreadable')
  assert.match(runEventsHeadline(unreadable), /读取失败：中枢不可达/)

  const empty = runEventsSection([])
  assert.equal(empty.state, 'empty')
  assert.equal(runEventsHeadline(empty), '这次运行没有记录到事件')

  // ★ 两条 headline 必须不同。相同的话，"问不到"会被读成"没有"。
  assert.notEqual(runEventsHeadline(unreadable), runEventsHeadline(empty))

  // 没给 reason 也必须说点什么，不能显示 "undefined"
  assert.match(runEventsHeadline(runEventsSection(null)), /未提供原因/)
})

test('③ 计数按重要性排序，且工具失败排在工具完成前面', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, type: 'tool.requested', known: true })),
    { seq: 6, type: 'tool.completed', known: true },
    { seq: 7, type: 'tool.failed', known: true },
    { seq: 8, type: 'run.completed', known: true },
  ]
  const section = runEventsSection(rows)
  const order = section.counts.map((item) => item.type)
  assert.ok(order.indexOf('tool.failed') < order.indexOf('tool.completed'),
    '★ 失败必须排在完成前面：摘要里第一个看到的应该是它')
  assert.ok(order.indexOf('run.failed') < order.indexOf('run.completed') || !order.includes('run.failed'))
  const headline = runEventsHeadline(section)
  assert.match(headline, /工具 5 次/)
  assert.match(headline, /失败 1 次/)
})

test('④ 标签与 `RUN_EVENT_TYPES` 逐字对齐（防止两处各写一份）', () => {
  const source = readFileSync(join(REPO, 'runtime', 'contracts', 'run.mjs'), 'utf8')
  const block = source.slice(source.indexOf('RUN_EVENT_TYPES'), source.indexOf('])', source.indexOf('RUN_EVENT_TYPES')))
  const declared = [...block.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1])
  assert.ok(declared.length >= 13, `★ 读到的类型太少：${declared.length}`)
  assert.deepEqual(Object.keys(RUN_EVENT_LABELS).sort(), [...declared].sort(),
    '★★ 展示标签必须与契约的 13 类事件一一对应：少一个会让它显示成"未识别"，多一个会误导')
})

test('⑤ 不把对象/数组拼进标题：只取标量摘要', () => {
  const section = runEventsSection([
    { seq: 1, type: 'tool.requested', known: true, event: { tool: 'read', args: { path: 'a' } } },
    { seq: 2, type: 'artifact.produced', known: true, event: { files: ['a', 'b'] } },
    { seq: 3, type: 'message.delta', known: true, event: { text: 'x'.repeat(500) } },
  ])
  assert.equal(section.events[0].summary, 'read')
  assert.equal(section.events[1].summary, '', '★ 没有标量字段就不编一句话出来')
  assert.ok(section.events[2].summary.length <= 121, '★ 长正文要截断')
  assert.ok(section.events[2].summary.endsWith('…'))
})

test('⑥ 老数据没有 `known` 字段：按已知处理，不当成未知', () => {
  const section = runEventsSection([{ seq: 1, type: 'run.started' }])
  assert.equal(section.events[0].known, true)
  assert.equal(section.unknownCount, 0)
})

test('⑦ 缺 seq 不伪造序号：null 而不是 0', () => {
  const section = runEventsSection([{ type: 'run.started', known: true }])
  assert.equal(section.events[0].seq, null, '★ 0 会被读成"第一条"，而 null 说的是"没提供"')
})
