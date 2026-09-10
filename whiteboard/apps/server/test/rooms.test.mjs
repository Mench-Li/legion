// rooms.test.mjs — P3-1 房间注册表与房间级权限：ID 校验、每房间独立存储、隔离、惰性打开与空闲关闭。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RoomRegistry, isValidRoomId, parseRoomId, resolveRoomConfig, ROOM_DEFAULTS, DEFAULT_ROOM_ID,
} from '../src/rooms.mjs';
import { parseRoomConfig, authorizeRoom, extractRoomId, safeEqual } from '../src/security.mjs';
import { sampleElement } from '../../../packages/shared/src/index.mjs';

function addOp(id, client = 'A', v = 1) {
  const el = sampleElement('rect', { id, geom: { x: 0, y: 0, w: 50, h: 50 } });
  return { t: 'add', id, el, c: client, v };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rooms-'));
}

describe('房间 ID 规则', () => {
  it('合法 ID：小写字母/数字开头，允许 - 与 _，长度 1..64', () => {
    for (const id of ['default', 'a', 'room-1', 'room_2', '0abc', 'x'.repeat(64)]) {
      assert.equal(isValidRoomId(id), true, `${id} 应合法`);
    }
  });

  it('非法 ID：大写、点号、路径穿越、空格、超长、空串', () => {
    for (const id of ['Room', 'a.b', '../etc', 'a b', 'x'.repeat(65), '', '-lead', '_lead', 'a/b']) {
      assert.equal(isValidRoomId(id), false, `${id} 应非法`);
    }
  });

  it('parseRoomId：缺省 → default，非法 → 拒绝（不静默回退）', () => {
    assert.deepEqual(parseRoomId(undefined), { ok: true, roomId: DEFAULT_ROOM_ID });
    assert.deepEqual(parseRoomId(''), { ok: true, roomId: DEFAULT_ROOM_ID });
    assert.deepEqual(parseRoomId('abc'), { ok: true, roomId: 'abc' });
    assert.equal(parseRoomId('../x').ok, false);
    assert.equal(parseRoomId('../x').reason, 'bad_room');
  });

  it('extractRoomId 从请求 URL 取房间（缺省 default，非法 null）', () => {
    assert.equal(extractRoomId({ url: '/ws' }), 'default');
    assert.equal(extractRoomId({ url: '/ws?room=abc' }), 'abc');
    assert.equal(extractRoomId({ url: '/ws?token=t&room=abc' }), 'abc');
    assert.equal(extractRoomId({ url: '/ws?room=BAD' }), null);
  });
});

describe('RoomRegistry 存储与隔离', () => {
  it('惰性打开：未连接时不开房间，open 后创建独立 DB 文件', async () => {
    const dir = tmpDir();
    const reg = new RoomRegistry({ dir, config: { TTL_MS: 1000 } });
    assert.equal(reg.size(), 0);
    assert.equal(reg.list().length, 0);

    const a = await reg.open('alpha');
    const b = await reg.open('beta');
    assert.equal(a.ok, true);
    assert.equal(a.created, true);
    assert.equal(b.created, true);
    assert.equal(reg.size(), 2);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
    assert.deepEqual(files, ['alpha.db', 'beta.db'], `实际文件: ${files.join(',')}`);
    await reg.closeAll();
  });

  it('重复 open 不重建（created=false）且刷新活动时间', async () => {
    const reg = new RoomRegistry({ dir: tmpDir(), inMemory: false, config: { TTL_MS: 1000 } });
    const first = await reg.open('r1');
    const second = await reg.open('r1');
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(reg.size(), 1);
    await reg.closeAll();
  });

  it('房间隔离：一个房间的 op 不出现在另一个房间', async () => {
    const reg = new RoomRegistry({ dir: tmpDir() });
    const a = (await reg.open('alpha')).room;
    const b = (await reg.open('beta')).room;
    await a.applyOpsFrom('c1', [addOp('e1'), addOp('e2')]);
    assert.equal(a.state().length, 2);
    assert.equal(b.state().length, 0, '文档必须完全隔离');
    assert.equal(a.roomId, 'alpha');
    assert.equal(b.roomId, 'beta');
    await reg.closeAll();
  });

  it('房间持久化到各自文件：重启注册表后按房间恢复', async () => {
    const dir = tmpDir();
    const reg1 = new RoomRegistry({ dir, config: { TTL_MS: 1000 } });
    const alpha = (await reg1.open('alpha')).room;
    const beta = (await reg1.open('beta')).room;
    await alpha.applyOpsFrom('c1', [addOp('a1')]);
    await beta.applyOpsFrom('c2', [addOp('b1'), addOp('b2')]);
    await reg1.closeAll();

    const reg2 = new RoomRegistry({ dir, config: { TTL_MS: 1000 } });
    assert.equal((await reg2.open('alpha')).room.state().length, 1);
    assert.equal((await reg2.open('beta')).room.state().length, 2);
    await reg2.closeAll();
  });

  it('房间数上限：超限拒绝新房间，但不驱逐已有房间', async () => {
    const reg = new RoomRegistry({ dir: tmpDir(), config: { MAX_ROOMS: 2, TTL_MS: 1000 } });
    assert.equal((await reg.open('a')).ok, true);
    assert.equal((await reg.open('b')).ok, true);
    const denied = await reg.open('c');
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'max_rooms');
    assert.equal(reg.isOpen('a'), true, '已有房间不得被淘汰');
    assert.equal(reg.isOpen('b'), true);
    await reg.closeAll();
  });

  it('非法房间 ID 在注册表层再拦一次（不依赖上层）', async () => {
    const reg = new RoomRegistry({ dir: tmpDir() });
    const r = await reg.open('../evil');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_room');
    await reg.closeAll();
  });

  it('空闲关闭：无在线用户超过 IDLE_MS 后关闭存储（关闭后再次 open 会重建）', async () => {
    const dir = tmpDir();
    let now = 1000;
    const reg = new RoomRegistry({ dir, config: { IDLE_MS: 500, TTL_MS: 100000 }, now: () => now });
    const room = (await reg.open('idle')); 
    await room.room.applyOpsFrom('c1', [addOp('e1')]);
    reg.touch('idle');

    now += 400;
    let res = await reg.tick(now);
    assert.deepEqual(res.closedRooms, [], '未到空闲阈值不应关闭');

    now += 200; // 累计 600 > 500
    res = await reg.tick(now);
    assert.deepEqual(res.closedRooms, ['idle']);
    assert.equal(reg.isOpen('idle'), false);
    assert.equal(reg.closedCount, 1);

    // 重新打开：数据从文件恢复（close 前落过快照）
    const again = await reg.open('idle');
    assert.equal(again.created, true);
    assert.equal(again.room.state().length, 1, '空闲关闭后数据仍应完整');
    await reg.closeAll();
  });

  it('有在线用户时即使空闲也不关闭（不能把正在看画的人踢掉）', async () => {
    let now = 1000;
    const reg = new RoomRegistry({ dir: tmpDir(), config: { IDLE_MS: 100, TTL_MS: 100000 }, now: () => now });
    const { room } = await reg.open('busy');
    room.setPresence('c1', { name: 'a', color: '#000', x: 0, y: 0 }, now);
    reg.touch('busy');
    now += 10_000;
    const res = await reg.tick(now);
    assert.deepEqual(res.closedRooms, [], '有 presence 的房间不空闲关闭');
    // presence 过期后（TTL 100s）才可能关闭
    now += 100_000;
    const res2 = await reg.tick(now);
    assert.equal(res2.expired.length, 1);
    assert.deepEqual(res2.expired[0].clientIds, ['c1']);
    await reg.closeAll();
  });

  it('list() 提供房间概况（在线数/元素数/只读数/db 路径）', async () => {
    const dir = tmpDir();
    const reg = new RoomRegistry({ dir, config: { TTL_MS: 1000 } });
    const { room } = await reg.open('probe');
    await room.applyOpsFrom('c1', [addOp('e1')]);
    room.setPresence('c1', { name: 'a', color: '#000', x: 0, y: 0 });
    room.setRole('ro1', 'ro');
    const [info] = reg.list();
    assert.equal(info.id, 'probe');
    assert.equal(info.peers, 1);
    assert.equal(info.elements, 1);
    assert.ok(info.db.endsWith('probe.db'));
    assert.equal(room.summary().readonly, 1);
    await reg.closeAll();
  });

  it('内存模式（bench/测试路径）：不落盘', async () => {
    const dir = tmpDir();
    const reg = new RoomRegistry({ dir, inMemory: true });
    const { room } = await reg.open('mem');
    await room.applyOpsFrom('c1', [addOp('e1')]);
    assert.equal(fs.readdirSync(dir).length, 0, '内存模式不应创建文件');
    assert.equal(room.state().length, 1);
    await reg.closeAll();
  });

  it('resolveRoomConfig：环境变量覆盖，非法值回落默认', () => {
    const r = resolveRoomConfig({ WB_ROOM_IDLE_MS: '1234', WB_MAX_ROOMS: 'oops', TTL_MS: '2500' });
    assert.equal(r.IDLE_MS, 1234);
    assert.equal(r.MAX_ROOMS, ROOM_DEFAULTS.MAX_ROOMS);
    assert.equal(r.TTL_MS, 2500);
  });
});

describe('房间级 token 与角色', () => {
  it('解析 WHITEBOARD_ROOMS：roomId:token:role；缺省角色 rw', () => {
    const { rooms, errors } = parseRoomConfig('main:tokA:rw, standup:tokB:ro, open-room::rw, norole:tokC');
    assert.deepEqual(errors, []);
    assert.deepEqual(rooms.get('main'), { token: 'tokA', role: 'rw' });
    assert.deepEqual(rooms.get('standup'), { token: 'tokB', role: 'ro' });
    assert.deepEqual(rooms.get('open-room'), { token: '', role: 'rw' });
    assert.deepEqual(rooms.get('norole'), { token: 'tokC', role: 'rw' });
  });

  it('非法配置项被报错而不是静默丢弃', () => {
    const { rooms, errors } = parseRoomConfig('ok:tok:rw, BAD:tok:rw, x:tok:admin, y, dup:t:rw, dup:t2:rw');
    assert.deepEqual([...rooms.keys()].sort(), ['dup', 'ok'], '合法项保留（dup 取首次声明）');
    assert.equal(rooms.get('dup').token, 't', '重复声明时保留首次');
    assert.equal(errors.length, 4, `实际错误: ${errors.join(' | ')}`);
    assert.match(errors.join(' '), /房间 ID 非法/);
    assert.match(errors.join(' '), /角色非法/);
    assert.match(errors.join(' '), /无法解析/);
    assert.match(errors.join(' '), /重复声明/);
  });

  it('未声明房间：沿用全局语义（有全局 token 需匹配，无则开放）', () => {
    const roomConfig = new Map();
    assert.deepEqual(authorizeRoom({ roomId: 'x', globalToken: '', roomConfig }), { ok: true, role: 'rw' });
    assert.deepEqual(authorizeRoom({ roomId: 'x', suppliedToken: 'g', globalToken: 'g', roomConfig }), { ok: true, role: 'rw' });
    assert.deepEqual(authorizeRoom({ roomId: 'x', suppliedToken: 'bad', globalToken: 'g', roomConfig }), { ok: false, reason: 'unauthorized' });
  });

  it('已声明房间：按房间 token 与角色裁决（全局 token 不能越权进私有房间）', () => {
    const { rooms } = parseRoomConfig('main:tokA:rw, standup:tokB:ro, open-room::rw');
    assert.deepEqual(authorizeRoom({ roomId: 'main', suppliedToken: 'tokA', globalToken: 'global', roomConfig: rooms }), { ok: true, role: 'rw' });
    assert.deepEqual(authorizeRoom({ roomId: 'standup', suppliedToken: 'tokB', roomConfig: rooms }), { ok: true, role: 'ro' });
    assert.deepEqual(authorizeRoom({ roomId: 'main', suppliedToken: 'global', globalToken: 'global', roomConfig: rooms }), { ok: false, reason: 'unauthorized' });
    assert.deepEqual(authorizeRoom({ roomId: 'open-room', suppliedToken: '', roomConfig: rooms }), { ok: true, role: 'rw' });
  });

  it('safeEqual：长度不同直接失败，空串视为匹配', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), true);
    assert.equal(safeEqual('', 'x'), false);
    assert.equal(safeEqual(undefined, ''), true);
  });
});
