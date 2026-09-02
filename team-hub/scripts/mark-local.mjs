// 把指定空间标记为「本地/私有」(private=1)。用法: node team-hub/scripts/mark-local.mjs ozon shop ...
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('D:/project/DSH/legion/team-hub/team.db')
const ids = process.argv.slice(2)
if (ids.length === 0) {
  console.log('用法: node team-hub/scripts/mark-local.mjs <spaceId> [...]')
  process.exit(1)
}
const up = db.prepare('UPDATE spaces SET private = 1 WHERE id = ?')
for (const id of ids) {
  const r = up.run(id)
  console.log(`${id}: ${r.changes > 0 ? '已标记本地' : '未找到(spaces 表无该行)'}`)
}
