// notice.test.mjs — 提示条优先级规则的语义单测（P4-3）。
//
// 规则本身很简单，但它对应一条**真实的用户可见回归**：给「连接未就绪时的暂存」加提示后，
// 队列提示把「操作过于频繁」顶掉了（被既有 e2e 限流用例抓到）。所以这里把规则逐条锁死。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNotice, NOTICE_POLICY, NOTICE_CONN } from '../src/notice.mjs';

describe('P4-3 · 提示条优先级（纯函数）', () => {
  it('空状态下任何提示都能写入，并记录自己的优先级', () => {
    const a = resolveNotice({ text: '', priority: 0 }, '操作过于频繁', NOTICE_POLICY);
    assert.deepEqual(a, { text: '操作过于频繁', priority: NOTICE_POLICY, applied: true });
    const b = resolveNotice({ text: '', priority: 0 }, '连接未就绪：已暂存 1 个操作', NOTICE_CONN);
    assert.deepEqual(b, { text: '连接未就绪：已暂存 1 个操作', priority: NOTICE_CONN, applied: true });
  });

  it('**连接状态提示不得顶掉治理提示**（这就是被 e2e 抓到的回归）', () => {
    const r = resolveNotice({ text: '操作过于频繁', priority: NOTICE_POLICY }, '连接未就绪：已暂存 2 个操作', NOTICE_CONN);
    assert.equal(r.applied, false, '低优先级应被挡住');
    assert.equal(r.text, '操作过于频繁', '保留下来的必须是治理提示');
    assert.equal(r.priority, NOTICE_POLICY);
  });

  it('同类提示可互相覆盖（同为连接状态：暂存中 → 已补发）', () => {
    const r = resolveNotice({ text: '连接未就绪：已暂存 1 个操作', priority: NOTICE_CONN }, '已补发连接中断期间的 1 个操作', NOTICE_CONN);
    assert.deepEqual(r, { text: '已补发连接中断期间的 1 个操作', priority: NOTICE_CONN, applied: true });
  });

  it('治理提示可以覆盖连接状态提示（升级方向总是允许）', () => {
    const r = resolveNotice({ text: '连接未就绪：已暂存 1 个操作', priority: NOTICE_CONN }, '操作过于频繁', NOTICE_POLICY);
    assert.equal(r.applied, true);
    assert.equal(r.text, '操作过于频繁');
  });

  it('同等优先级的治理提示可互相覆盖（限流 → 只读被拒，后来的更相关）', () => {
    const r = resolveNotice({ text: '操作过于频繁', priority: NOTICE_POLICY }, '你没有该房间的写入权限', NOTICE_POLICY);
    assert.equal(r.applied, true);
    assert.equal(r.text, '你没有该房间的写入权限');
  });

  it('**空文本 = 显式清空，总是生效**（否则提示条会永远摘不掉）', () => {
    const r = resolveNotice({ text: '操作过于频繁', priority: NOTICE_POLICY }, '', NOTICE_CONN);
    assert.deepEqual(r, { text: '', priority: 0, applied: true });
    const r2 = resolveNotice({ text: '随便什么', priority: NOTICE_POLICY }, undefined);
    assert.deepEqual(r2, { text: '', priority: 0, applied: true });
  });

  it('当前状态为空但优先级字段残留时，视作「无提示」（不会被幽灵优先级挡住）', () => {
    const r = resolveNotice({ text: '', priority: NOTICE_POLICY }, '连接未就绪：已暂存 1 个操作', NOTICE_CONN);
    assert.equal(r.applied, true, '没有实际提示时不应有优先级');
    assert.equal(r.text, '连接未就绪：已暂存 1 个操作');
  });

  it('缺省参数与缺失 current 都退化为「可写入」（调用方少传参数不会让提示消失）', () => {
    assert.equal(resolveNotice(undefined, 'x').applied, true);
    assert.equal(resolveNotice(null, 'x').text, 'x');
    assert.equal(resolveNotice({}, 'x').text, 'x');
    assert.equal(resolveNotice({ text: 'p', priority: NOTICE_POLICY }, 'x').applied, false, '默认按连接状态优先级处理');
  });
});
