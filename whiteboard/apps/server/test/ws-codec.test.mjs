// ws-codec.test.mjs — RFC6455 帧编解码单测（S3 / TC-S3-05/06 健壮性）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { encodeFrame, parseFrame, acceptKey, WS_OPCODE } from '../src/ws.mjs';

const { TEXT, BINARY, PING, PONG, CLOSE } = WS_OPCODE;

describe('ws 帧编解码', () => {
  it('编码文本帧 → 解析出相同 opcode 与 payload', () => {
    const buf = encodeFrame(TEXT, 'hello');
    const f = parseFrame(buf);
    assert.equal(f.opcode, TEXT);
    assert.equal(f.fin, true);
    assert.equal(f.payload.toString('utf8'), 'hello');
  });

  it('126/127 扩展长度正确编码', () => {
    const p126 = 'x'.repeat(200);
    assert.equal(parseFrame(encodeFrame(TEXT, p126)).payload.toString(), p126);
    const p127 = 'y'.repeat(70000);
    assert.equal(parseFrame(encodeFrame(TEXT, p127)).payload.length, 70000);
  });

  it('控制帧（ping/pong/close）', () => {
    assert.equal(parseFrame(encodeFrame(PING, Buffer.alloc(0))).opcode, PING);
    assert.equal(parseFrame(encodeFrame(PONG, Buffer.alloc(0))).opcode, PONG);
    assert.equal(parseFrame(encodeFrame(CLOSE, Buffer.alloc(0))).opcode, CLOSE);
  });

  it('解析掩码帧（客户端→服务端）并正确解掩码', () => {
    const payload = Buffer.from('masked payload');
    const maskKey = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ maskKey[i % 4];
    // 手工构造 masked 文本帧（FIN=1, opcode=1, MASK=1, len）
    const header = Buffer.from([0x81, 0x80 | payload.length]);
    const frame = Buffer.concat([header, maskKey, masked]);
    const f = parseFrame(frame);
    assert.equal(f.masked, true);
    assert.equal(f.payload.toString('utf8'), 'masked payload');
  });

  it('不完整缓冲区返回 null（等待更多字节）', () => {
    const buf = encodeFrame(TEXT, 'incomplete frame test');
    assert.equal(parseFrame(buf.slice(0, 5)), null);
  });

  it('超过 maxLen 返回 error', () => {
    const big = encodeFrame(TEXT, 'z'.repeat(100));
    const f = parseFrame(big, 50);
    assert.equal(f.error, 'payload too large');
  });

  it('Sec-WebSocket-Accept 与 RFC 已知值一致', () => {
    // RFC 6455 §1.3 示例：key dGhlIHNhbXBsZSBub25jZQ== → s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
    assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});
