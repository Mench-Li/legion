// dir-lock.test.mjs — P4-6（候选 #5）：房间目录的**单实例守卫**。
//
// 回归来源：ADR-0008 决策 1 把白板限定为单实例、单进程，但此前那只是 rooms.mjs 里的一行注释。
// 实测（真起两个实例指向同一 WB_ROOMS_DIR）后果是**静默的数据分裂**：
//   实例1 画 red-1 → 实例1 视图 1 个元素，实例2 看不到；实例2 画 blue-1 → 两边各自 1 个；
//   继续画下去两边分别停在 2 与 3，而房间真值已经是 4——**两侧日志里都没有任何错误**。
// 本切片把「单实例」从注释升级为可执行守卫：目录独占锁，第二个实例在**打开第一个房间前**被拒绝。
//
// 本文件分两层：
//   · dirLock 纯函数层：占用/接管/释放/不误删，含陈旧锁与损坏锁；
//   · 真实进程层：两个真服务指向同一目录 → 第二个必须**启动即失败且说清怎么办**；
//     强杀持有者后 → 新进程必须能接管陈旧锁继续服务（否则一次崩溃就把服务锁死）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { acquireDirLock, readDirLock, isProcessAlive, describeHolder, lockPathFor, LOCK_FILE_NAME } from '../src/dirLock.mjs';
import { RoomRegistry } from '../src/rooms.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'src', 'index.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dirlock-'));
}

/** 一个**确定不存在**的 pid（远大于常见 pid 上限），用于构造陈旧锁 */
const DEAD_PID = 0x7ffffffe;

describe('P4-6 · 目录锁（纯函数）', () => {
  it('空目录可独占获取：锁文件含 pid/端口/起始时间（便于把「谁占着」告诉运维）', () => {
    const dir = tmpDir();
    const got = acquireDirLock(dir, { pid: process.pid, port: 8080, host: '127.0.0.1', now: () => 1700000000000 });
    assert.equal(got.ok, true);
    assert.equal(fs.existsSync(lockPathFor(dir)), true);
    const onDisk = readDirLock(dir);
    assert.equal(onDisk.pid, process.pid);
    assert.equal(onDisk.port, 8080);
    assert.equal(onDisk.app, 'whiteboard');
    assert.equal(onDisk.startedAt, new Date(1700000000000).toISOString());
    got.release();
    assert.equal(fs.existsSync(lockPathFor(dir)), false, '释放后锁文件应消失');
  });

  it('目录已被**活着**的进程占用 → 拒绝，并如实报出占用者（不覆盖别人的锁）', () => {
    const dir = tmpDir();
    const first = acquireDirLock(dir, { pid: process.pid, port: 1111 });
    assert.equal(first.ok, true);
    const second = acquireDirLock(dir, { pid: 4242, port: 2222 }); // 4242 是假的请求方，持有者仍是本进程
    assert.equal(second.ok, false);
    assert.equal(second.reason, 'held');
    assert.equal(second.holderAlive, true);
    assert.equal(second.holder.pid, process.pid, '应报出真正的占用者');
    assert.equal(readDirLock(dir).pid, process.pid, '不得覆盖占用者的锁');
    first.release();
  });

  it('**陈旧锁可接管**：持有者已不存在时必须能接管，否则一次崩溃就把服务永久锁死', () => {
    const dir = tmpDir();
    fs.writeFileSync(lockPathFor(dir), JSON.stringify({ pid: DEAD_PID, port: 1, startedAt: 'x' }));
    assert.equal(isProcessAlive(DEAD_PID), false, '前置：该 pid 必须确实不存在');
    const got = acquireDirLock(dir, { pid: process.pid, port: 3333 });
    assert.equal(got.ok, true, '陈旧锁必须被接管');
    assert.equal(got.staleTakeover, true);
    assert.equal(got.tookOverFrom.pid, DEAD_PID, '接管要留下「从谁手里接管」的痕迹');
    assert.equal(readDirLock(dir).pid, process.pid);
    assert.equal(readDirLock(dir).tookOverFrom.pid, DEAD_PID, '痕迹要落盘（事后能看出上一次没优雅退出）');
    got.release();
  });

  it('锁文件损坏（非法 JSON）也按陈旧处理，不把服务卡死', () => {
    const dir = tmpDir();
    fs.writeFileSync(lockPathFor(dir), '{ 这不是 JSON');
    const got = acquireDirLock(dir, { pid: process.pid });
    assert.equal(got.ok, true);
    assert.equal(got.staleTakeover, true);
    assert.equal(got.tookOverFrom, null, '解析不出来就别假装知道是谁');
    got.release();
  });

  it('release 只删**自己的**锁：不得删掉接管者的锁（否则守卫形同虚设）', () => {
    const dir = tmpDir();
    const mine = acquireDirLock(dir, { pid: process.pid, now: () => 111 });
    assert.equal(mine.ok, true);
    // 模拟「另一个进程接管了」（同 pid 不同起始时间，足以区分两个持有者）
    fs.writeFileSync(lockPathFor(dir), JSON.stringify({ pid: process.pid, port: 9, startedAt: new Date(222).toISOString() }));
    mine.release();
    assert.equal(fs.existsSync(lockPathFor(dir)), true, '旧持有者释放时不得删掉新持有者的锁');
    assert.equal(readDirLock(dir).port, 9);
  });

  it('release 幂等；目录不可写时报 unwritable（不伪装成「被占用」）', () => {
    const dir = tmpDir();
    const got = acquireDirLock(dir, { pid: process.pid });
    assert.equal(got.release(), true);
    assert.equal(got.release(), false, '重复释放是空操作');
    const blocked = acquireDirLock(path.join(dir, 'nope', 'deeper'), { pid: process.pid });
    // 父目录可建时会成功；这里只要求「要么成功，要么明确报 unwritable」，绝不报 held
    assert.ok(blocked.ok === true || blocked.reason === 'unwritable', JSON.stringify(blocked));
  });

  it('占用者描述是人话（pid/端口/起始时间）', () => {
    assert.equal(describeHolder({ pid: 7, port: 80, startedAt: '2026-01-01T00:00:00.000Z' }), 'pid 7（端口 80），自 2026-01-01T00:00:00.000Z 起');
    assert.equal(describeHolder({ pid: 7 }), 'pid 7');
    assert.equal(describeHolder(null), '未知进程');
    assert.equal(LOCK_FILE_NAME, '.whiteboard.lock');
  });
});

describe('P4-6 · RoomRegistry 与目录锁的联动', () => {
  it('文件存储：构造即独占目录；closeAll 释放（重启注册表的既有用法不受影响）', async () => {
    const dir = tmpDir();
    const reg1 = new RoomRegistry({ dir, config: { TTL_MS: 1000 } });
    assert.equal(reg1.lockStatus().mode, 'exclusive');
    assert.equal(fs.existsSync(lockPathFor(dir)), true);
    const r = await reg1.open('alpha');
    assert.equal(r.ok, true);
    await reg1.closeAll();
    assert.equal(fs.existsSync(lockPathFor(dir)), false, '关闭后应释放，否则重启注册表（既有用例）会失败');

    // 既有用法：重启注册表后按房间恢复
    const reg2 = new RoomRegistry({ dir, config: { TTL_MS: 1000 } });
    assert.equal(reg2.lockStatus().mode, 'exclusive', '上一个注册表释放后应能重新独占');
    assert.equal((await reg2.open('alpha')).ok, true);
    await reg2.closeAll();
  });

  it('内存存储不加锁（不落盘，多注册表共存无害；测试与 bench 依赖这一点）', async () => {
    const dir = tmpDir();
    const a = new RoomRegistry({ dir, inMemory: true });
    const b = new RoomRegistry({ dir, inMemory: true });
    assert.equal(a.lockStatus().mode, 'in-memory');
    assert.equal(b.lockStatus().mode, 'in-memory');
    assert.equal(fs.existsSync(lockPathFor(dir)), false, '内存模式不得创建锁文件');
    assert.equal((await a.open('x')).ok, true);
    assert.equal((await b.open('x')).ok, true);
  });

  it('目录被占用时 open 拒绝：reason=storage_busy + 可行动错误（而不是先开着再说）', async () => {
    const dir = tmpDir();
    const holder = acquireDirLock(dir, { pid: process.pid, port: 7777 });
    assert.equal(holder.ok, true);
    const reg = new RoomRegistry({ dir, config: { TTL_MS: 1000 } });
    assert.equal(reg.lockStatus().mode, 'denied');
    assert.equal(reg.lockStatus().holderAlive, true);
    const r = await reg.open('alpha');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'storage_busy');
    assert.match(r.error, /已被另一个白板实例占用/);
    assert.match(r.error, /WB_ROOMS_DIR/, '错误里要给出可行动的处置');
    assert.match(r.error, new RegExp(String(process.pid)), '要点名占用者 pid');
    assert.equal(reg.isOpen('alpha'), false, '被拒绝时不得建房间');
    assert.equal(fs.existsSync(path.join(dir, 'alpha.db')), false, '被拒绝时不得碰存储文件');
    holder.release();
  });

  it('lockDir:false 可显式关掉守卫（逃生阀，文档需说明后果）', async () => {
    const dir = tmpDir();
    const holder = acquireDirLock(dir, { pid: process.pid });
    assert.equal(holder.ok, true);
    const reg = new RoomRegistry({ dir, lockDir: false, config: { TTL_MS: 1000 } });
    assert.equal((await reg.open('alpha')).ok, true, '显式关掉守卫后仍可打开（用于明确的单进程测试场景）');
    await reg.closeAll();
    holder.release();
  });
});

describe('P4-6 · 真实进程：第二个实例必须启动即失败，强杀后必须能接管', () => {
  let roomsDir = '';
  let auditDir = '';
  const ROOM = 'lock-room';

  /** 起一个真服务；返回它是否起来了（不抛错——「拒绝启动」正是被测行为） */
  async function startRaw(port, { waitMs = 8000 } = {}) {
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(port), HOST: '127.0.0.1',
        WB_ROOMS_DIR: roomsDir, WB_AUDIT_DIR: auditDir,
        WHITEBOARD_ROOMS: `${ROOM}:tok:rw`, TTL_MS: '600000', WB_ROOM_IDLE_MS: '600000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = [];
    child.stdout.on('data', (d) => log.push(String(d)));
    child.stderr.on('data', (d) => log.push(String(d)));
    let up = false;
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      if (child.exitCode !== null) break;
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) { up = true; break } } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    return { port, child, log: () => log.join(''), up };
  }

  before(() => {
    roomsDir = tmpDir();
    auditDir = tmpDir();
  });
  after(() => {
    for (const d of [roomsDir, auditDir]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* */ } }
  });

  it('两个真实实例共享同一 WB_ROOMS_DIR：第二个**启动即失败**并说清处置（旧行为是两边都起来、静默分裂数据）', async () => {
    const a = await startRaw(24501);
    assert.equal(a.up, true, '第一个实例应正常启动：' + a.log());
    let b = null;
    try {
      b = await startRaw(24502);
      assert.equal(b.up, false, '第二个实例**不得**起来（旧行为会起来并造成静默数据分裂）');
      const out = b.log();
      assert.match(out, /已被另一个白板实例占用/, '要明确说「被占用」：' + out);
      assert.match(out, /WB_ROOMS_DIR/, '要给出可行动的处置');
      assert.match(out, /单实例设计/, '要说清这是设计约束而不是偶发错误');
      assert.ok(b.child.exitCode !== null, '应以非零码退出，而不是挂着当僵尸');

      // 第一个实例必须完全不受影响（守卫不能误伤正在服务的那个）
      const h = await fetch(`http://127.0.0.1:${a.port}/healthz`);
      assert.equal(h.status, 200, '被拒绝的那个实例不得影响已在服务的实例');
    } finally {
      try { if (b) b.child.kill('SIGKILL') } catch { /* */ }
      try { a.child.kill('SIGKILL') } catch { /* */ }
      await new Promise((r) => setTimeout(r, 300));
    }

    // 强杀后锁必然残留：新实例必须能接管（这是「不能把服务锁死」的硬要求）
    assert.equal(fs.existsSync(lockPathFor(roomsDir)), true, 'SIGKILL 不走关闭路径，锁应残留');
    const c = await startRaw(24503);
    try {
      assert.equal(c.up, true, '必须能接管陈旧锁并启动，否则一次崩溃就永久锁死：' + c.log());
      assert.match(c.log(), /接管了陈旧目录锁/, '接管必须留痕（否则会掩盖上一次崩溃）');
      const r = await fetch(`http://127.0.0.1:${c.port}/api/rooms/${ROOM}`);
      assert.equal(r.status, 404, '房间尚未打开（占位检查：服务已可用）');
    } finally {
      try { c.child.kill('SIGKILL') } catch { /* */ }
      await new Promise((r) => setTimeout(r, 300));
    }
  });
});
