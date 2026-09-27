// packages/shared/test/path-domain.test.mjs —— S1（R-1 / D-P1 / D-P2）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeRepoPath, classifyEntry, pathsIntersect, intersectingPaths, expandRename, normalizePathSet,
} from '../src/path-domain.mjs'

const ci = { caseInsensitive: true }
const cs = { caseInsensitive: false }
const dir = (path) => ({ path, type: 'dir' })
const file = (path) => ({ path, type: 'file' })

test('TC-S1-01/02 目录按段边界：src/a 覆盖 src/a/b.mjs 但不覆盖 src/ab', () => {
  assert.equal(pathsIntersect(dir('src/a'), file('src/a/b.mjs'), cs), true)
  assert.equal(pathsIntersect(dir('src/a'), file('src/ab'), cs), false)
  assert.equal(pathsIntersect(dir('src/a'), dir('src/a/sub'), cs), true)
  assert.equal(pathsIntersect(dir('src/ab'), file('src/a/b.mjs'), cs), false)
})

test('TC-S1-03/04 文件精确相等、跨文件不误判', () => {
  assert.equal(pathsIntersect(file('src/a.mjs'), file('src/a.mjs'), cs), true)
  assert.equal(pathsIntersect(file('src/a.mjs'), file('src/b.mjs'), cs), false)
  assert.equal(pathsIntersect(dir('src/a'), dir('src/b'), cs), false)
  assert.equal(pathsIntersect(file('src/a.mjs'), dir('src'), cs), true)
})

test('TC-S1-05 五类拒绝面逐条结构化拒绝（不静默通过）', () => {
  const bad = ['C:/x/a.mjs', 'C:\\\\x\\\\a.mjs', '/etc/passwd', '\\\\server\\share\\a', '../secret', 'docs/../secret', '', '   ', '.git/config', 'docs/.git/config']
  for (const raw of bad) {
    const r = normalizeRepoPath(raw, cs)
    assert.equal(r.ok, false, 'should reject: ' + JSON.stringify(raw))
    assert.equal(typeof r.reason, 'string')
    assert.equal(typeof r.code, 'string')
  }
})

test('TC-S1-05b 非法条目类型与形状也被拒绝', () => {
  assert.equal(classifyEntry({ path: 'src/a', type: 'glob' }, cs).ok, false)
  assert.equal(classifyEntry(null, cs).ok, false)
  assert.equal(classifyEntry({ path: 'src/../a', type: 'file' }, cs).ok, false)
})

test('TC-S1-06/07 大小写按仓库配置归一，两向结论不同', () => {
  assert.equal(pathsIntersect(file('Src/A.mjs'), file('src/a.mjs'), ci), true)
  assert.equal(pathsIntersect(file('Src/A.mjs'), file('src/a.mjs'), cs), false)
  assert.equal(normalizeRepoPath('Src/A.mjs', ci).path, 'src/a.mjs')
  assert.equal(normalizeRepoPath('Src/A.mjs', cs).path, 'Src/A.mjs')
})

test('TC-S1-08/09 重命名同时占用旧路径与新路径', () => {
  const renamed = expandRename({ from: 'src/old.mjs', to: 'src/new.mjs' })
  assert.equal(renamed.length, 2)
  assert.equal(pathsIntersect(renamed, file('src/old.mjs'), cs), true)
  assert.equal(pathsIntersect(renamed, file('src/new.mjs'), cs), true)
  assert.equal(pathsIntersect(renamed, file('src/other.mjs'), cs), false)
  assert.equal(pathsIntersect(renamed, dir('src'), cs), true)
})

test('TC-S1-10 边界：空集合不抛、自身相交为真', () => {
  assert.equal(pathsIntersect([], file('src/a.mjs'), cs), false)
  assert.equal(pathsIntersect(dir('src/a'), dir('src/a'), cs), true)
  assert.equal(pathsIntersect(null, undefined, cs), false)
  assert.equal(intersectingPaths(dir('src/a'), file('src/a/b.mjs'), cs).length, 1)
})

test('TC-S1-11 纯函数同输入同输出', () => {
  const once = JSON.stringify(pathsIntersect(dir('src/a'), file('src/a/b.mjs'), cs))
  const twice = JSON.stringify(pathsIntersect(dir('src/a'), file('src/a/b.mjs'), cs))
  assert.equal(once, twice)
  assert.equal(Object.isFrozen(normalizeRepoPath('src/a', cs)), true)
})

test('TC-S1-14 路径集合逐条拒绝且不静默丢失', () => {
  const set = normalizePathSet(['src/a.mjs', '../escape'], cs)
  assert.equal(set.ok, false)
  assert.equal(set.entries.length, 1)
  assert.equal(set.rejected.length, 1)
  assert.equal(set.rejected[0].code, 'path-traversal')
})
