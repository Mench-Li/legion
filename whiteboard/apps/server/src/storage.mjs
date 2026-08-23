// storage.mjs — StorageProvider 抽象（S10 / ADR-0004 / TC-S10）。
// 接口：load() -> { snapshot, ops }；append(ops)；snapshot(state)；close()。
// 实现：MemoryProvider（测试/默认）+ SqliteProvider（node:sqlite WAL 单文件，零原生依赖）。

const isSqliteAvailable = (() => {
  try { return !!process.getBuiltinModule('node:sqlite').DatabaseSync; } catch { return false; }
})();

/** 内存实现（测试与单机快速起步） */
export class MemoryProvider {
  constructor() {
    this.snap = null;
    this.ops = [];
  }
  async load() { return { snapshot: this.snap, ops: this.ops.slice() }; }
  async append(ops) { this.ops.push(...ops); }
  async snapshot(state) { this.snap = state; this.ops = []; }
  async close() {}
  isHealthy() { return true; }
}

/** SQLite(WAL) 单文件实现（node:sqlite，Node ≥22.5） */
export class SqliteProvider {
  constructor(file) {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.db.exec('CREATE TABLE IF NOT EXISTS ops (seq INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  }

  async load() {
    let snapshot = null;
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('snapshot');
    if (row) {
      try { snapshot = JSON.parse(row.value); } catch { snapshot = null; }
    }
    const ops = this.db.prepare('SELECT payload FROM ops ORDER BY seq ASC').all()
      .map((r) => { try { return JSON.parse(r.payload); } catch { return null; } })
      .filter(Boolean);
    return { snapshot, ops };
  }

  async append(ops) {
    const ins = this.db.prepare('INSERT INTO ops (payload) VALUES (?)');
    this.db.exec('BEGIN');
    try {
      for (const op of ops) ins.run(JSON.stringify(op));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async snapshot(state) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('snapshot', JSON.stringify(state));
      this.db.exec('DELETE FROM ops');
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  async close() { try { this.db.close(); } catch { /* ignore */ } }

  isHealthy() {
    try {
      const r = this.db.prepare('SELECT count(*) AS n FROM ops').get();
      return typeof r.n === 'number';
    } catch { return false; }
  }
}

/** 工厂：file 为 null/':memory:' 用内存，否则 SQLite */
export function createStorage(file) {
  if (!file || file === ':memory:' || !isSqliteAvailable) return new MemoryProvider();
  return new SqliteProvider(file);
}
