#!/usr/bin/env node
/**
 * taskctl.mjs — board-plugin HTTP 契约测试的 taskctl 替身（fixture double）。
 *
 * 仅实现 HTTP 契约层所需的 CLI 面：create/transition/comment/reject/promote 的
 * 参数形状、乐观锁(if-version)冲突语义与 stdout JSON 输出。它故意不做完整状态机；
 * taskctl 真实语义由 scrum/taskctl.ttl.test.mjs 覆盖。数据落在同目录 tasks.json，
 * 与生产默认路径约定一致（board-plugin 以 scrumDir/taskctl.mjs 定位本脚本）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const FILE = join(DIR, 'tasks.json')

function load() {
  return JSON.parse(readFileSync(FILE, 'utf8'))
}
function save(db) {
  writeFileSync(FILE, JSON.stringify(db, null, 2))
}
function fail(msg) {
  process.stderr.write(msg + '\n')
  process.exit(1)
}
function out(task) {
  process.stdout.write(JSON.stringify(task) + '\n')
}
function argvValue(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
function bump(task, by) {
  task.version += 1
  task.updatedAt = new Date().toISOString()
  if (by) task.lastBy = by
  return task
}
function requireTask(db, id) {
  const t = db.tasks?.[id]
  if (!t) fail(`任务不存在：${id}`)
  return t
}
function checkIfVersion(t, argv) {
  if (!argv.includes('--if-version')) return
  const want = Number(argv[argv.indexOf('--if-version') + 1])
  if (t.version !== want) fail(`乐观锁冲突：任务 ${t.id} 当前版本 ${t.version}，请求版本 ${want}（请刷新后重试）`)
}

const argv = process.argv.slice(2)
const cmd = argv[0]
const db = load()

switch (cmd) {
  case 'create': {
    const title = argvValue(argv, '--title')
    if (!title) fail('缺少参数 title')
    const id = 'T-' + db.nextId
    const t = {
      id,
      title: title.trim(),
      description: argvValue(argv, '--description') ?? '',
      priority: argvValue(argv, '--priority') ?? 'medium',
      status: 'todo',
      version: 1,
      scope: 'software',
      artifacts: [],
      comments: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    db.tasks[id] = t
    db.nextId += 1
    save(db)
    out(t)
    break
  }
  case 'transition': {
    const id = argv[1]
    const t = requireTask(db, id)
    const to = argvValue(argv, '--to')
    if (!to) fail('缺少参数 to')
    checkIfVersion(t, argv)
    t.status = to
    out(bump(t, argvValue(argv, '--by')))
    save(db)
    break
  }
  case 'comment': {
    const id = argv[1]
    const t = requireTask(db, id)
    const by = argvValue(argv, '--by')
    const text = argvValue(argv, '--text')
    if (!by) fail('缺少参数 by')
    if (!text) fail('缺少参数 text')
    t.comments = t.comments ?? []
    t.comments.push({ by, text, at: new Date().toISOString() })
    out(bump(t))
    save(db)
    break
  }
  case 'reject': {
    const id = argv[1]
    const t = requireTask(db, id)
    const by = argvValue(argv, '--by')
    const reason = argvValue(argv, '--reason')
    if (!by) fail('缺少参数 by')
    if (!reason) fail('缺少参数 reason')
    checkIfVersion(t, argv)
    t.status = 'rejected'
    t.rejectReason = reason
    out(bump(t, by))
    save(db)
    break
  }
  case 'promote': {
    const id = argv[1]
    const t = requireTask(db, id)
    const by = argvValue(argv, '--by')
    if (!by) fail('缺少参数 by')
    checkIfVersion(t, argv)
    t.status = 'promoted'
    out(bump(t, by))
    save(db)
    break
  }
  default:
    fail(`未知命令：${cmd ?? '(空)'}`)
}
