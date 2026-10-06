// tests/e2e-acceptance/greet.test.mjs
// 任务 T-004「端到端验收：请写一个 greet 函数并跑一次测试」的用例。
// 运行：node --test tests/e2e-acceptance/greet.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

import { greet } from './greet.mjs'

test('greet 返回契约规定的精确文本', () => {
  assert.equal(greet('Ada'), 'Hello, Ada!')
})

test('greet 逐字保留名字（含空格与大小写）', () => {
  assert.equal(greet('Ada Lovelace'), 'Hello, Ada Lovelace!')
})

test('greet 支持非 ASCII（中文名）', () => {
  assert.equal(greet('小明'), 'Hello, 小明!')
})

test('greet 对空字符串仍返回契约形状', () => {
  assert.equal(greet(''), 'Hello, !')
})

test('greet 始终返回字符串', () => {
  assert.equal(typeof greet('Ada'), 'string')
})
