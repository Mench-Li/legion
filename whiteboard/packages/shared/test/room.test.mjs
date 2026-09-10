// room.test.mjs — P3-1 前端房间/角色纯逻辑：URL 解析、切换 URL 构造、token 存取键、能力与错误文案。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isValidRoomId, parseRoomFromSearch, buildSwitchUrl, tokenStorageKey, canWrite, errorText,
  roomShareUrl, ROOM_ID_RE, DEFAULT_ROOM_ID,
} from '../src/room.mjs';

describe('房间 ID 规则（与服务端一致）', () => {
  it('合法与非法边界', () => {
    assert.equal(isValidRoomId('default'), true);
    assert.equal(isValidRoomId('room-1_2'), true);
    assert.equal(isValidRoomId('x'.repeat(64)), true);
    for (const bad of ['Room', 'a.b', '../x', 'a b', '', '-a', '_a', 'x'.repeat(65), null, 42]) {
      assert.equal(isValidRoomId(bad), false, `${JSON.stringify(bad)} 应非法`);
    }
    assert.equal(DEFAULT_ROOM_ID, 'default');
    assert.ok(ROOM_ID_RE.test('default'));
  });
});

describe('parseRoomFromSearch', () => {
  it('无 room 参数 → 默认房间，无提示', () => {
    assert.deepEqual(parseRoomFromSearch(''), { roomId: 'default', token: '', remembered: false, notice: undefined });
    assert.equal(parseRoomFromSearch('?token=abc').token, 'abc');
    assert.equal(parseRoomFromSearch('?token=abc').roomId, 'default');
  });

  it('合法 room → 采用；token 缺省回落到已记住的 token', () => {
    const r = parseRoomFromSearch('?room=alpha', { storedToken: 'saved-tok' });
    assert.equal(r.roomId, 'alpha');
    assert.equal(r.token, 'saved-tok');
  });

  it('URL 里的 token 优先于已记住的 token（分享链接场景）', () => {
    const r = parseRoomFromSearch('?room=alpha&token=url-tok', { storedToken: 'saved-tok' });
    assert.equal(r.token, 'url-tok');
  });

  it('非法 room → 回落默认房间并给出可见提示（不静默改房间）', () => {
    const r = parseRoomFromSearch('?room=BAD');
    assert.equal(r.roomId, 'default');
    assert.match(r.notice, /非法/);
    assert.match(r.notice, /BAD/);
    const r2 = parseRoomFromSearch('?room=..%2Fetc');
    assert.equal(r2.roomId, 'default');
    assert.ok(r2.notice, '路径穿越式房间名必须有提示');
  });
});

describe('切换房间的 URL 构造', () => {
  it('设置 room 且剔除 token（不把 token 留在浏览器历史里）', () => {
    const next = buildSwitchUrl('http://127.0.0.1:8080/?room=alpha&token=secret', 'beta');
    assert.equal(next, '/?room=beta');
    assert.ok(!next.includes('secret'));
    assert.ok(!next.includes('token'));
  });

  it('保留其他查询参数（如后续新增的调试开关）', () => {
    const next = buildSwitchUrl('http://x:1/?room=a&debug=1', 'b');
    assert.match(next, /room=b/);
    assert.match(next, /debug=1/);
  });

  it('分享链接：带 token 时包含 token，不带时不残留旧 token', () => {
    assert.match(roomShareUrl('http://x:1/?room=a', 'a', 'tok'), /token=tok/);
    assert.ok(!roomShareUrl('http://x:1/?room=a&token=old', 'a').includes('token'));
  });

  it('token 存取键按房间隔离', () => {
    assert.equal(tokenStorageKey('alpha'), 'wb.token.alpha');
    assert.notEqual(tokenStorageKey('alpha'), tokenStorageKey('beta'));
  });
});

describe('角色能力与错误文案', () => {
  it('rw 可写、ro 不可写（只读 ≠ 隐身，presence 仍可用）', () => {
    assert.equal(canWrite('rw'), true);
    assert.equal(canWrite('ro'), false);
    assert.equal(canWrite(undefined), true, '未知角色按可写处理（服务端才是权威）');
  });

  it('各错误码都有可行动的中文说明', () => {
    assert.match(errorText('op_denied'), /只读/);
    assert.match(errorText('rate_limited', { retryAfterMs: 250 }), /250/);
    assert.match(errorText('rate_limited'), /频率/);
    assert.match(errorText('message_too_large'), /过大/);
    assert.match(errorText('too_many_ops', { max: 200 }), /200/);
    assert.match(errorText('malformed_message'), /格式/);
    assert.match(errorText('max_rooms'), /房间数/);
    assert.match(errorText('storage_open_failed'), /存储/);
    assert.match(errorText('storage_load_failed'), /存储/);
  });

  it('未知错误码：带服务端 message 时透出，否则明说未知（不假装成功）', () => {
    assert.equal(errorText('weird', { message: '服务端说明' }), '服务端说明');
    assert.match(errorText('weird'), /未知错误/);
  });
});
