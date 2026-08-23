// storage.test.mjs — StorageProvider 内存/SQLite 互换 + 重启恢复（S10 / TC-S10-01/05/06）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MemoryProvider, SqliteProvider } from '../src/storage.mjs';

const OPS = [
  { t: 'add', id: 'e1', el: { id: 'e1', type: 'rect', geom: { x: 0, y: 0, w: 10, h: 10 }, stroke: '#000000', strokeWidth: 2 }, c: 'A', v: 1 },
  { t: 'patch', id: 'e1', path: 'stroke', value: '#ff0000', prev: '#000000', c: 'A', v: 2 },
];

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-store-'));
  return path.join(dir, 'test.db');
}

async function testProvider(make) {
  const p = make();
  await p.append(OPS);
  const { snapshot, ops } = await p.load();
  assert.equal(snapshot, null);
  assert.equal(ops.length, 2);
  assert.equal(ops[1].value, '#ff0000');

  await p.snapshot({ clock: 2, elements: [] });
  const r2 = await p.load();
  assert.equal(r2.ops.length, 0);
  assert.deepEqual(r2.snapshot, { clock: 2, elements: [] });
  await p.close();
}

describe('StorageProvider', () => {
  it('MemoryProvider append/load/snapshot', async () => {
    await testProvider(() => new MemoryProvider());
  });

  it('SqliteProvider append/load/snapshot', async () => {
    const file = tmpFile();
    await testProvider(() => new SqliteProvider(file));
  });

  it('SqliteProvider 重启（重开同文件）后数据完整恢复', async () => {
    const file = tmpFile();
    const p1 = new SqliteProvider(file);
    await p1.append(OPS);
    await p1.close();

    const p2 = new SqliteProvider(file);
    const { ops } = await p2.load();
    assert.equal(ops.length, 2);
    assert.equal(ops[0].id, 'e1');
    await p2.close();
  });

  it('SqliteProvider 快照后重启恢复快照态', async () => {
    const file = tmpFile();
    const p1 = new SqliteProvider(file);
    await p1.append(OPS);
    const snap = { clock: 2, elements: [{ id: 'x' }] };
    await p1.snapshot(snap);
    await p1.close();

    const p2 = new SqliteProvider(file);
    const r = await p2.load();
    assert.deepEqual(r.snapshot, snap);
    assert.equal(r.ops.length, 0);
    await p2.close();
  });

  it('空库首次启动不报错', async () => {
    const file = tmpFile();
    const p = new SqliteProvider(file);
    const r = await p.load();
    assert.equal(r.snapshot, null);
    assert.equal(r.ops.length, 0);
    assert.equal(p.isHealthy(), true);
    await p.close();
  });

  it('内存/SQLite 接口互换：同批 op 加载结果一致', async () => {
    const mem = new MemoryProvider();
    await mem.append(OPS);
    const file = tmpFile();
    const sql = new SqliteProvider(file);
    await sql.append(OPS);
    const a = await mem.load();
    const b = await sql.load();
    assert.deepEqual(a.ops, b.ops);
    await mem.close();
    await sql.close();
  });
});
