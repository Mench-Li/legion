// dirLock.mjs — 房间目录的**单实例守卫**（P4-6 / 候选 #5）。
//
// 为什么需要：ADR-0008 决策 1 把白板限定为**单实例、单进程**，但此前那只是一个代码注释
// （rooms.mjs 第 7 行）。实测（真起两个实例指向同一 WB_ROOMS_DIR）后果是**静默的数据分裂**：
//   实例1 画 red-1 → 实例1 视图 1 个元素，实例2 看不到；实例2 画 blue-1 → 两边各自 1 个；
//   继续画下去两边分别停在 2 与 3，而房间真值已经是 4——**两个实例的日志里都没有任何错误**。
// 根因不是 SQLite 的并发能力（它没问题），而是应用层设计：每个实例各持一份内存 doc，
// 且 `snapshot()` 会 `DELETE FROM ops`——实例 A 落快照可能删掉实例 B 还没读到的 op（永久丢）。
//
// 因此本模块把「单实例」从注释升级为**可执行的守卫**：在房间目录里放一个独占锁文件，
// 第二个实例在**第一个房间打开前**就被明确拒绝，而不是安静地把数据搞坏。
//
// 设计取舍（对齐 PostgreSQL 的 postmaster.pid 思路）：
//   · 锁文件含 pid/port/startedAt，便于直接把「谁占着」告诉运维；
//   · **陈旧锁可接管**：进程被 SIGKILL 后锁文件还在，若持有者进程已不存在则自动接管并告警——
//     否则一次崩溃就会让服务再也起不来（那比原缺陷更糟）；
//   · **同进程也算占用**：语义是「一个目录同一时刻只有一个持有者」。既有用例
//     `rooms.test.mjs`「重启注册表后按房间恢复」是先 `closeAll()` 再建第二个注册表，因此不受影响；
//   · 不引入任何依赖，只用 `fs` 的 `wx`（原子独占创建）。

import fs from 'node:fs';
import path from 'node:path';

export const LOCK_FILE_NAME = '.whiteboard.lock';

/** 进程是否还活着：`kill(pid, 0)` 不发信号只做存在性检查。EPERM = 存在但无权限（仍算活着）。*/
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

export function lockPathFor(dir) {
  return path.join(dir, LOCK_FILE_NAME);
}

/**
 * 尝试独占一个目录。
 * @returns {{ok:true, path:string, release:()=>void} | {ok:false, holder:object|null, holderAlive:boolean, reason:'held'}}
 */
export function acquireDirLock(dir, { pid = process.pid, port = null, host = null, now = () => Date.now() } = {}) {
  const file = lockPathFor(dir);
  const payload = { pid, port, host, startedAt: new Date(now()).toISOString(), app: 'whiteboard' };
  let staleTakeover = false;
  let tookOverFrom = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 'wx' = 独占创建，目录被别的实例锁住时直接 EEXIST（原子，无需先检查再写）
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { flag: 'wx' });
  } catch (e) {
    if (!e || e.code !== 'EEXIST') {
      // 目录不可写等：交给上层按「存储不可用」处理，不在这里伪装成「被别人占用」
      return { ok: false, holder: null, holderAlive: false, reason: 'unwritable', error: String(e && e.message) };
    }
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { holder = null; }
    const holderAlive = holder !== null && isProcessAlive(holder.pid);
    if (holderAlive) return { ok: false, holder, holderAlive: true, reason: 'held' };
    // 陈旧锁（持有者已死 / 文件损坏）：接管，但**必须留下痕迹**——静默接管会掩盖上一次崩溃
    try {
      fs.writeFileSync(file, JSON.stringify({ ...payload, tookOverFrom: holder }, null, 2));
      staleTakeover = true;
      tookOverFrom = holder;
    } catch {
      return { ok: false, holder, holderAlive: false, reason: 'unwritable', error: '陈旧锁接管失败' };
    }
  }
  let released = false;
  return {
    ok: true,
    path: file,
    holder: payload,
    staleTakeover,
    tookOverFrom,
    release() {
      if (released) return false;
      released = true;
      try {
        // 只删「还是我们的」那个锁：避免把接管者的锁删掉
        const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (cur && cur.pid === pid && cur.startedAt === payload.startedAt) fs.rmSync(file, { force: true });
      } catch { /* 已被删或不可读：无需处理 */ }
      return true;
    },
  };
}

/** 读锁文件（诊断/测试用，不加锁） */
export function readDirLock(dir) {
  try { return JSON.parse(fs.readFileSync(lockPathFor(dir), 'utf8')); } catch { return null; }
}

/** 人话描述占用者，用于启动错误与审计 */
export function describeHolder(holder) {
  if (!holder || typeof holder !== 'object') return '未知进程';
  const who = `pid ${holder.pid}${holder.port ? `（端口 ${holder.port}）` : ''}`;
  const when = holder.startedAt ? `，自 ${holder.startedAt} 起` : '';
  return `${who}${when}`;
}
