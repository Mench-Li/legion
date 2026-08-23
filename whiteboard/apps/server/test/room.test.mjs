// room.test.mjs — 房间逻辑：同步收敛、presence 隔离、TTL、持久化恢复（S3/S4/S10/S11）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Room, sanitizeOps } from '../src/room.mjs';
import { MemoryProvider, SqliteProvider } from '../src/storage.mjs';
import { stateHash, sampleElement } from '../../../packages/shared/src/index.mjs';

function addOp(id, client = 'A', v = 1) {
  const el = sampleElement('rect', { id, geom: { x: 0, y: 0, w: 50, h: 50 } });
  return { t: 'add', id, el, c: client, v };
}

describe('Room', () => {
  it('空库初始化 → 空白板', async () => {
    const room = new Room({ storage: new MemoryProvider() });
    const n = await room.init();
    assert.equal(n, 0);
    assert.equal(room.state().length, 0);
  });

  it('两客户端 op 经房间中继 → 状态收敛（TC-S3-01）', async () => {
    const room = new Room({ storage: new MemoryProvider() });
    await room.init();
    await room.applyOpsFrom('A', [addOp('e1', 'A', 1), addOp('e2', 'A', 2)]);
    await room.applyOpsFrom('B', [addOp('e3', 'B', 1)]);
    assert.equal(room.state().length, 3);
    const ids = room.state().map((e) => e.id).sort();
    assert.deepEqual(ids, ['e1', 'e2', 'e3']);
  });

  it('畸形 op 被拒绝，不污染状态（TC-S3-05）', async () => {
    const room = new Room({ storage: new MemoryProvider() });
    await room.init();
    const accepted = await room.applyOpsFrom('A', [
      addOp('good', 'A', 1),
      { t: 'add', id: 'bad', el: { id: 'bad', type: 'circle', geom: {}, stroke: '#000', strokeWidth: 1 }, c: 'A', v: 2 },
      { t: 'patch', id: 'good', path: 'bogus', value: 1, c: 'A', v: 3 },
      null,
      'not-an-op',
      { t: 'add', id: 'noel', c: 'A', v: 4 },
    ]);
    assert.equal(accepted.length, 1);
    assert.equal(room.state().length, 1);
    assert.equal(room.state()[0].id, 'good');
  });

  it('presence 隔离：写 presence 不改文档/存储（I1 / TC-S4-06）', async () => {
    const storage = new MemoryProvider();
    const room = new Room({ storage });
    await room.init();
    await room.applyOpsFrom('A', [addOp('e1', 'A', 1)]);
    const before = stateHash(room.state());
    const beforeOps = (await storage.load()).ops.length;
    for (let i = 0; i < 100; i++) {
      room.setPresence('A', { name: 'alice', color: '#ff0000', x: i, y: i });
    }
    assert.equal(stateHash(room.state()), before);
    assert.equal((await storage.load()).ops.length, beforeOps);
    assert.equal(room.peers().length, 1);
  });

  it('presence TTL：非正常断开超时移除；正常 leave 立即移除（TC-S4-04/05）', async () => {
    const room = new Room({ storage: new MemoryProvider(), ttlMs: 10000 });
    await room.init();
    room.setPresence('A', { name: 'a', color: '#000', x: 0, y: 0 });
    room.setPresence('B', { name: 'b', color: '#000', x: 0, y: 0 });
    assert.equal(room.peers().length, 2);
    assert.equal(room.removePresence('B'), true);
    assert.equal(room.peers().length, 1);
    const t0 = Date.now();
    assert.deepEqual(room.tick(t0 + 10000), []);
    assert.deepEqual(room.tick(t0 + 10001), ['A']);
    assert.equal(room.peers().length, 0);
  });

  it('SQLite 持久化：重启房间后元素完整恢复（TC-S10-01）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-room-'));
    const dbFile = path.join(dir, 'room.db');

    const r1 = new Room({ storage: new SqliteProvider(dbFile), snapshotEveryMs: 100000 });
    await r1.init();
    await r1.applyOpsFrom('A', [addOp('e1', 'A', 1), addOp('e2', 'A', 2)]);
    await r1.close();

    const r2 = new Room({ storage: new SqliteProvider(dbFile) });
    await r2.init();
    assert.equal(r2.state().length, 2);
    await r2.close();
  });
});

describe('sanitizeOps', () => {
  it('非数组 / 混合非法项过滤', () => {
    assert.deepEqual(sanitizeOps(null), []);
    assert.deepEqual(sanitizeOps('x'), []);
    assert.equal(sanitizeOps([addOp('ok'), { t: 'bogus' }]).length, 1);
  });
});
