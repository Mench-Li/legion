#!/usr/bin/env node
/**
 * render.mjs — board-plugin HTTP 契约测试的 render 替身（fixture double）。
 *
 * 将同目录 tasks.json 映射为 board.json（看板列 + 卡片），写回同目录 board.json。
 * 真实 render.mjs 的 UI 产物语义由 scrum/artifact-detail.test.mjs 覆盖。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const TASKS_FILE = join(DIR, 'tasks.json')
const BOARD_FILE = join(DIR, 'board.json')

let db
try {
  db = JSON.parse(readFileSync(TASKS_FILE, 'utf8'))
} catch {
  db = { tasks: {} }
}
const cards = Object.values(db.tasks ?? {}).map((t) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  version: t.version,
}))
const board = {
  fixture: 'board',
  generatedAt: new Date().toISOString(),
  columns: [{ id: 'all', title: '全部', cards }],
}
writeFileSync(BOARD_FILE, JSON.stringify(board))
