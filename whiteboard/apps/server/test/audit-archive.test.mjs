// audit-archive.test.mjs — P4-5（候选 #7）：审计归档**可读**。
//
// 回归来源：候选 #7 记录「指标与审计为进程内：重启归零、无长期归档；/api/rooms/<id>/audit
// 只返回当前进程事件」。前半句（JSONL 落盘 + 按大小轮转）P3-1 就做了，真正的问题是
// **归档只写不读**：`query()` 只看内存环形缓冲，于是
//   ① 进程一重启，API 就再也查不到任何历史（环形缓冲空了，磁盘上却躺着完整归档）；
//   ② 「能回溯多久」无法回答（只有 fileBytes，不知道最早一条是什么时候、也不知道历史是否被轮转掉）。
//
// 本文件分两层：
//   · 纯函数层（AuditLog 直用）：重启读取、序号跨重启单调、轮转留痕、坏行容错、三种 source 语义；
//   · 真实进程层（真起服务 + 真落盘 + **真重启**）：这才是「重启后还能查」的硬证据。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuditLog, AUDIT_SOURCES, AUDIT_DEFAULTS } from '../src/audit.mjs';
import { startServer, json, connect } from './helpers.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-audit-archive-'));
}

describe('P4-5 · 审计归档可读（纯函数）', () => {
  it('**重启后仍可查**：新实例环形缓冲为空，但归档查询能拿到上一个进程写下的事件', () => {
    const dir = tmpDir();
    const a = new AuditLog({ dir });
    a.record({ type: 'connect', room: 'alpha', clientId: 'c1' });
    a.record({ type: 'ops', room: 'alpha', clientId: 'c1', count: 3 });
    a.record({ type: 'connect', room: 'beta', clientId: 'c2' });

    const b = new AuditLog({ dir }); // 模拟重启：全新实例，ring 空
    assert.equal(b.ring.length, 0, '新实例不该凭空有内存事件');
    assert.equal(b.query({ room: 'alpha' }).total, 0, '默认（process）在重启后确实查不到——这就是旧行为的症状');

    const arch = b.query({ room: 'alpha', source: 'archive' });
    assert.equal(arch.total, 2, '归档应能读回上个进程的事件');
    assert.deepEqual(arch.items.map((e) => e.type), ['connect', 'ops'], '按时间顺序返回');
    assert.ok(arch.items.every((e) => e.room === 'alpha'), '房间过滤在归档查询上同样生效');
    assert.equal(arch.source, 'archive');

    // source=all 同样可用，且不与归档重复计数
    const all = b.query({ room: 'alpha', source: 'all' });
    assert.equal(all.total, 2, 'all 不得把同一事件算两遍');
  });

  it('auditSeq **跨重启单调递增**（序号不回绕，「查 seq > N」才有确定含义）', () => {
    const dir = tmpDir();
    const a = new AuditLog({ dir });
    a.record({ type: 'connect', room: 'r' });
    a.record({ type: 'disconnect', room: 'r' });
    const before = a.ring.map((e) => e.auditSeq);
    assert.deepEqual(before, [1, 2], '首进程从 1 开始');

    const b = new AuditLog({ dir }); // 重启，从归档尾部播种
    b.record({ type: 'connect', room: 'r' });
    assert.equal(b.ring[0].auditSeq, 3, '重启后应接着上一个进程的序号，而不是从 1 重来');

    // 全档（含两次进程的记录）序号严格递增且唯一
    const all = b.query({ source: 'archive' });
    const seqs = all.items.map((e) => e.auditSeq);
    assert.deepEqual(seqs, [1, 2, 3], '归档里三条记录的序号连续且唯一');
    assert.equal(new Set(seqs).size, seqs.length, '序号不得重复（重复会让 all 去重失效）');
  });

  it('序号是服务端不变量：调用方传 auditSeq 也覆盖不了', () => {
    const a = new AuditLog({ dir: null });
    const item = a.record({ type: 'connect', room: 'r', auditSeq: 999 });
    assert.equal(item.auditSeq, 1, '外部传入的 auditSeq 必须被服务端序号覆盖');
  });

  it('retention()：如实报告留存跨度与「历史已被轮转」事实', () => {
    const dir = tmpDir();
    let clock = 1_000_000;
    const a = new AuditLog({ dir, now: () => clock, config: { FILE_MAX_BYTES: 200, KEEP_FILES: 2 } });
    for (let i = 0; i < 40; i++) { a.record({ type: 'ops', room: 'r', seq: i, pad: 'x'.repeat(40) }); clock += 1000; }

    const r = a.retention({ force: true });
    assert.equal(r.enabled, true);
    assert.ok(r.fileCount >= 1, '应有归档文件');
    assert.ok(r.bytes > 0);
    assert.ok(r.oldestTs !== null && r.newestTs !== null, '应给出最早/最新时间');
    assert.ok(r.newestTs >= r.oldestTs);
    assert.equal(r.spanMs, r.newestTs - r.oldestTs, '跨度 = 最新 − 最早（即「能回溯多久」）');
    assert.ok(r.rotationsThisProcess > 0, '这份数据必然轮转过');
    assert.equal(r.historyTruncated, true, '轮转过就必须标出「更早的历史已被滚出保留窗口」');

    // 未轮转过的小档：不谎报截断
    const dir2 = tmpDir();
    const b = new AuditLog({ dir: dir2 });
    b.record({ type: 'connect', room: 'r' });
    const r2 = b.retention({ force: true });
    assert.equal(r2.historyTruncated, false, '没轮转过就不该说历史被截断');
    assert.equal(r2.rotationsThisProcess, 0);
  });

  it('坏行/半行不炸查询：跳过并计数，其余记录照常可读', () => {
    const dir = tmpDir();
    const a = new AuditLog({ dir });
    a.record({ type: 'connect', room: 'r', clientId: 'c1' });
    a.record({ type: 'ops', room: 'r', clientId: 'c1', count: 1 });
    // 模拟「进程被强杀，最后一行只写了一半」——半行必然是**最后一行**（append-only 文件里不会有
    // 半行后面又接上完整行的情况：那样两行会被拼成一行，见下一条用例登记的边界）。
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), '{"type":"ops","room":"r","trunca');

    const b = new AuditLog({ dir });
    const arch = b.query({ room: 'r', source: 'archive' });
    assert.equal(arch.total, 2, '半行被跳过，完整的两条仍可读');
    assert.deepEqual(arch.items.map((e) => e.type), ['connect', 'ops']);
    assert.equal(arch.archive.malformed, 1, '坏行要如实计数，而不是静默忽略');

    // 半行还会影响**尾部播种**：readTailItem 从后往前找第一个可解析行，不能因半行就放弃整个归档
    assert.equal(b.auditSeq, 2, '播种应成功（取到倒数第二个完整行），而不是退化成 0');
  });

  it('边界：半行后面又追加了完整行 → 两行被拼成一行，该条并入 malformed 并如实计数', () => {
    // 这是 append-only JSONL 的固有性质（没有分隔符就无法恢复拼接点），不是本实现的疏漏：
    // 真实场景里半行只可能出现在**文件末尾**（进程在写中途被杀）。此处把行为钉成断言，
    // 避免将来有人误以为「任何坏行都能被完美恢复」。
    const dir = tmpDir();
    const a = new AuditLog({ dir });
    a.record({ type: 'connect', room: 'r', clientId: 'c1' });
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), '{"type":"ops","room":"r","trunca');
    a.record({ type: 'disconnect', room: 'r', clientId: 'c1' }); // 会紧贴半行写入 → 拼成一行

    const b = new AuditLog({ dir });
    const arch = b.query({ room: 'r', source: 'archive' });
    assert.equal(arch.total, 1, '只有第一条完整记录可恢复');
    assert.deepEqual(arch.items.map((e) => e.type), ['connect']);
    assert.equal(arch.archive.malformed, 1, '被拼接的那一行计入 malformed（不静默吞掉）');
    assert.ok(b.dropped === 0, '这不是写入失败，不该记成 dropped');
  });

  it('limit 语义：返回**最近的** N 条并标 truncated，不假装这就是全部', () => {
    const dir = tmpDir();
    const a = new AuditLog({ dir });
    for (let i = 1; i <= 10; i++) a.record({ type: 'ops', room: 'r', seq: i });
    const b = new AuditLog({ dir });
    const r = b.query({ room: 'r', source: 'archive', limit: 3 });
    assert.deepEqual(r.items.map((e) => e.seq), [8, 9, 10], '取最近 3 条');
    assert.equal(r.truncated, true, '被 limit 截断时必须标出来');
    const all = b.query({ room: 'r', source: 'archive', limit: 100 });
    assert.equal(all.truncated, false, '都取到了就不该标截断');
    assert.equal(all.total, 10);
  });

  it('跨文件查询：轮转后的历史仍能读回（不只看当前文件）', () => {
    const dir = tmpDir();
    const a = new AuditLog({ dir, config: { FILE_MAX_BYTES: 200, KEEP_FILES: 3 } });
    for (let i = 0; i < 40; i++) a.record({ type: 'ops', room: 'r', seq: i, pad: 'x'.repeat(40) });
    assert.ok(fs.readdirSync(dir).length > 1, '应当已经轮转过（有多个文件）');
    const b = new AuditLog({ dir });
    const r = b.query({ room: 'r', source: 'archive', limit: 1000 });
    assert.ok(r.archive.filesRead > 1, '需要跨文件读取才能凑够历史：filesRead=' + r.archive.filesRead);
    const seqs = r.items.map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), '跨文件拼接后仍按时间正序');
    assert.equal(new Set(seqs).size, seqs.length, '不得重复返回同一条（跨文件边界最易出错）');
  });

  it('无目录（内存模式）：所有查询都不抛错，retention 如实说明未启用', () => {
    const a = new AuditLog();
    a.record({ type: 'connect', room: 'r' });
    assert.equal(a.query({ room: 'r', source: 'archive' }).total, 0);
    assert.equal(a.query({ room: 'r', source: 'all' }).total, 1, 'all 仍能拿到进程内那一条');
    const r = a.retention();
    assert.equal(r.enabled, false);
    assert.equal(r.fileCount, 0);
    assert.equal(r.oldestTs, null);
  });

  it('source 取值表与实际支持一致（防文档/实现漂移）', () => {
    assert.deepEqual([...AUDIT_SOURCES], ['process', 'archive', 'all']);
    const a = new AuditLog();
    for (const s of AUDIT_SOURCES) assert.doesNotThrow(() => a.query({ source: s }));
    assert.ok(AUDIT_DEFAULTS.ARCHIVE_MAX_LIMIT >= 1);
    assert.ok(AUDIT_DEFAULTS.ARCHIVE_MAX_BYTES >= 1024);
  });
});

describe('P4-5 · 真实进程重启后仍能查到审计（端到端）', () => {
  let dir = '';
  let portBefore = 0;

  before(() => { dir = tmpDir(); });
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('进程 A 产生事件 → 进程 B（新进程、空内存）通过 source=archive 查回同一段历史', async () => {
    const env = { WB_AUDIT_DIR: dir, WHITEBOARD_ROOMS: 'restart-r:tok:rw' };

    // ── 进程 A：真实连接 + 真实写 op（审计类型 connect / ops 都由服务端自己产生）──
    // 必须 try/finally：断言失败时若不收掉子进程，node --test 会一直等它退出（整轮挂死）。
    const a = await startServer(env);
    portBefore = a.port;
    let before = null;
    try {
      const ws = await connect(a.port, { room: 'restart-r', token: 'tok' });
      await ws.waitFor((s) => s.welcome);
      ws.send({ type: 'op', ops: [{ t: 'add', id: 'ar-1', el: { id: 'ar-1', type: 'rect', geom: { x: 0, y: 0, w: 3, h: 3 }, stroke: '#000', strokeWidth: 1 }, c: ws.welcome.clientId, v: 1 }] });
      await new Promise((r) => setTimeout(r, 250));
      before = await json(a.port, '/api/rooms/restart-r/audit');
      const typesBefore = before.body.items.map((e) => e.type);
      assert.ok(before.body.items.length > 0, '进程 A 内存里应有事件');
      assert.ok(typesBefore.includes('connect'), '应含 connect：' + typesBefore.join(','));
      assert.ok(typesBefore.includes('ops'), '应含 ops：' + typesBefore.join(','));
      const seqBefore = before.body.items.map((e) => e.auditSeq);
      assert.ok(seqBefore.every((n) => Number.isInteger(n) && n > 0), '每条应带服务端序号');
      ws.close();
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      await a.stop();
    }

    // ── 进程 B：新进程、新内存。旧行为在这里返回 0 条且**什么都不说** ──
    const b = await startServer(env);
    try {
      const proc = await json(b.port, '/api/rooms/restart-r/audit');
      assert.equal(proc.body.source, 'process');
      assert.equal(proc.body.items.length, 0, '内存环形缓冲在重启后必然为空（这正是旧行为的症状）');
      // 但响应必须**如实告知历史还在、怎么取**，而不是让人以为「从来没有过」
      assert.ok(proc.body.hint, '进程内为空而磁盘有归档时，应给出可行动的 hint');
      assert.match(proc.body.hint, /source=archive/, 'hint 要指向具体取法：' + proc.body.hint);
      assert.ok(proc.body.retention.fileCount > 0, 'retention 应报告磁盘上确有归档文件');
      assert.ok(proc.body.retention.bytes > 0);
      assert.ok(proc.body.retention.oldestTs !== null, '应能回答「能回溯到什么时候」');

      // 归档查询：拿回进程 A 写下的事件（跨重启的硬证据）
      const arch = await json(b.port, '/api/rooms/restart-r/audit?source=archive');
      assert.equal(arch.body.source, 'archive');
      const typesAfter = arch.body.items.map((e) => e.type);
      assert.ok(typesAfter.includes('connect'), '重启后应能从归档查回 connect：' + typesAfter.join(','));
      assert.ok(typesAfter.includes('ops'), '重启后应能从归档查回 ops：' + typesAfter.join(','));
      assert.ok(arch.body.items.every((e) => e.room === 'restart-r'), '归档查询也按房间隔离');

      // 序号跨重启继续递增：新进程写下的事件序号必须大于归档里的最大序号
      const maxBefore = Math.max(...arch.body.items.map((e) => e.auditSeq ?? 0));
      const c = await connect(b.port, { room: 'restart-r', token: 'tok' });
      await c.waitFor((s) => s.welcome);
      await new Promise((r) => setTimeout(r, 250));
      c.close();
      const after = await json(b.port, '/api/rooms/restart-r/audit?source=all');
      const newSeqs = after.body.items.map((e) => e.auditSeq ?? 0).filter((n) => n > maxBefore);
      assert.ok(newSeqs.length > 0, '新进程应写下序号更大的事件（序号不得回绕）');
      const allSeq = after.body.items.map((e) => e.auditSeq ?? 0);
      assert.equal(new Set(allSeq.filter(Boolean)).size, allSeq.filter(Boolean).length, 'all 合并后序号仍唯一（去重生效）');

      // 拼错的 source 显式 400，不静默当成默认值
      const bad = await json(b.port, '/api/rooms/restart-r/audit?source=nope');
      assert.equal(bad.status, 400, '非法 source 应 400');
      assert.equal(bad.body.error, 'bad_source');
      assert.deepEqual(bad.body.allowed, ['process', 'archive', 'all']);
    } finally {
      await b.stop();
    }
  });

  it('/metrics 暴露审计留存事实（重启后仍能说明「历史有多少、回溯多久」）', async () => {
    const b = await startServer({ WB_AUDIT_DIR: dir, WHITEBOARD_ROOMS: 'restart-r:tok:rw' });
    try {
      const m = await json(b.port, '/metrics');
      assert.equal(m.status, 200);
      const audit = m.body.audit;
      assert.ok(audit, '指标应含 audit 段');
      assert.ok(Number.isInteger(audit.rotations), '应暴露本进程轮转次数');
      assert.ok(audit.retention, '应暴露留存事实');
      assert.equal(audit.retention.enabled, true);
      assert.ok(audit.retention.bytes > 0, '磁盘归档字节数应为正');
      assert.ok(audit.retention.oldestTs !== null, '应给出可回溯的最早时间');
    } finally {
      await b.stop();
    }
  });
});

describe('P4-5 · 审计写入量必须与「消息数」同阶，不能与「更新次数/载荷大小」同阶', () => {
  // 回归来源：本切片最初把 `presence` 审计写成**逐条**（每收到一条 presence 就 record 一次）。
  // 而 presence 是前端在 mousemove 上发的高频临态，且审计写文件是**同步** appendFileSync——
  // 治理用例「频率超限」发 260 条 presence，于是多出 249 次同步落盘，把限流告警的出现时间
  // 从 ~12ms 拉到 ~80ms，并让本该被丢弃的消息少丢了 8 条（令牌桶 120/s 趁机回填：
  // 实测 drops 从 19 掉到 11）。在并行门禁负载下处置更慢，drops 可归零、告警永不出现，
  // 该用例即以 waitFor timeout 失败——**这是真实缺陷被既有用例抓到，不是用例太紧**。
  //
  // 因此把「审计量级」本身钉成断言：presence 按**连接**计（上界 = 连接数），
  // ops 按**消息**计（一条消息带 200 个 op 也只记一条，摘要里体现条数）。
  let dir2 = '';
  before(() => { dir2 = tmpDir(); });
  after(() => { try { fs.rmSync(dir2, { recursive: true, force: true }) } catch { /* ignore */ } });

  it('presence 审计按连接计数：200 条 presence 只留 1 条（不逐条落盘）', async () => {
    const srv = await startServer({ WB_AUDIT_DIR: dir2, WHITEBOARD_ROOMS: 'vol-r:tok:rw' });
    try {
      const w = await connect(srv.port, { room: 'vol-r', token: 'tok' });
      await w.waitFor((s) => s.welcome);
      for (let i = 0; i < 200; i++) w.send({ type: 'presence', state: { name: 'n', color: '#000', x: i, y: 0 } });
      await new Promise((r) => setTimeout(r, 400));

      const audit = await json(srv.port, '/api/rooms/vol-r/audit?limit=500');
      const presence = audit.body.items.filter((e) => e.type === 'presence');
      assert.equal(presence.length, 1, `200 条 presence 只应留 1 条审计（实际 ${presence.length}）——逐条写会拖慢消息热路径并撑爆归档`);
      assert.equal(presence[0].first, true, '记的是「首次活跃」这一跃迁事实');
      assert.equal(audit.body.items.filter((e) => e.type === 'presence').some((e) => 'x' in e || 'y' in e), false, '不得记录光标坐标（审计是治理工具，不是行为画像）');
      w.close();
    } finally {
      await srv.stop();
    }
  });

  it('ops 审计按消息计数：一条消息带 200 个 op 只记 1 条（摘要里体现条数与类型）', async () => {
    const srv = await startServer({ WB_AUDIT_DIR: dir2, WHITEBOARD_ROOMS: 'vol-r2:tok:rw' });
    try {
      const w = await connect(srv.port, { room: 'vol-r2', token: 'tok' });
      await w.waitFor((s) => s.welcome);
      const ops = [];
      for (let i = 0; i < 200; i++) ops.push({ t: 'add', id: `v-${i}`, el: { id: `v-${i}`, type: 'rect', geom: { x: i, y: 0, w: 1, h: 1 }, stroke: '#000', strokeWidth: 1 }, c: w.welcome.clientId, v: 1 });
      w.send({ type: 'op', ops });
      await new Promise((r) => setTimeout(r, 500));

      const audit = await json(srv.port, '/api/rooms/vol-r2/audit?limit=500');
      const opsEntries = audit.body.items.filter((e) => e.type === 'ops');
      assert.equal(opsEntries.length, 1, `一条消息应只留 1 条 ops 审计（实际 ${opsEntries.length}）`);
      assert.equal(opsEntries[0].count, 200, '摘要应体现本次的 op 条数');
      assert.deepEqual(opsEntries[0].kinds, { add: 200 }, '摘要应体现类型分布');
      assert.equal('el' in opsEntries[0] || 'ops' in opsEntries[0], false, '不得把元素内容写进审计');
      w.close();
    } finally {
      await srv.stop();
    }
  });
});
