// 本地验证：VACUUM INTO 会把 WAL 里的内容并进快照吗？
// 造一个"主库很小、WAL 很大"的库，再备份，比较行数。
import { DatabaseSync } from 'node:sqlite'
import { existsSync, rmSync, statSync } from 'node:fs'

const f = process.argv[2] ?? '/tmp/bktest/live.db'
for (const p of [f, `${f}-wal`, `${f}-shm`]) if (existsSync(p)) rmSync(p)

const db = new DatabaseSync(f)
db.exec('PRAGMA journal_mode=WAL')
for (const ddl of [
  'CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT)',
  'CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT)',
  'CREATE TABLE conversations(id INTEGER PRIMARY KEY)',
  'CREATE TABLE audit(seq INTEGER PRIMARY KEY)',
  'CREATE TABLE run_attempts(id TEXT PRIMARY KEY)',
  'CREATE TABLE run_events(attempt_id TEXT, event_seq INTEGER)',
  'CREATE TABLE run_context_snapshots(attempt_id TEXT PRIMARY KEY)',
  'CREATE TABLE agent_registry(agent_id TEXT PRIMARY KEY)',
  'CREATE TABLE agent_conversation_bindings(conv_id INTEGER PRIMARY KEY)',
  'CREATE TABLE hub_users(id TEXT PRIMARY KEY)',
  'CREATE TABLE hub_user_sessions(id TEXT PRIMARY KEY)',
  'CREATE TABLE hub_devices(node_id TEXT PRIMARY KEY)',
]) db.exec(ddl)

const ins = db.prepare('INSERT INTO tasks VALUES (?,?)')
for (let i = 0; i < 2000; i += 1) ins.run(`T-${i}`, `title ${i}`)
db.prepare('INSERT INTO conversations VALUES (1)').run()
db.prepare('INSERT INTO messages VALUES (1,?)').run('hi')
db.prepare('INSERT INTO agent_conversation_bindings VALUES (1)').run()

console.log(`源库主文件 ${statSync(f).size} B，WAL ${existsSync(`${f}-wal`) ? statSync(`${f}-wal`).size : 0} B，行数 ${db.prepare('SELECT COUNT(*) n FROM tasks').get().n}`)
db.close()
