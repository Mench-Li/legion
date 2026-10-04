/**
 * sandbox-pipe-shim.cjs — **会话沙箱适配层，非产品代码**（T-173 devops 证据用）。
 *
 * 背景：本会话的 DSH Windows 沙箱禁止进程创建 named pipe，因此 Node 的
 * child_process.spawn / spawnSync 一旦使用 stdio:'pipe' 就抛 EPERM。仓库既有 CI
 * （scripts/ci/run-ci.mjs）、node --test 运行器与多处 spawnSync('git', …) 都依赖 pipe
 * 捕获子进程输出，直接跑必红（详见 docs/G-mujfc9vi-1/DEPLOY.md §6）。
 *
 * 本 shim 把 stdio:'pipe' 改写为**临时文件 fd**（不经 pipe），并在子进程结束后把
 * 落盘内容回放/读回。语义等价于「把子进程输出写到文件再读回来」，
 * 不改动任何被测代码，也不改 run-ci.mjs 本身。
 *
 * 用法（普通终端不需要它；只在被同一沙箱限制的会话里复现 CI 用）：
 *   NODE_OPTIONS="--require <abs path>/sandbox-pipe-shim.cjs --test-isolation=none"
 *   node scripts/ci/run-ci.mjs --out <dir>
 *
 * 注：--test-isolation=none 让 node --test 在**同进程**内跑测试文件，
 * 避免运行器自己 spawn 子进程（那条路径读的是内部绑定，preload 改不到）。
 */
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');

const realSpawn = cp.spawn;
const realSpawnSync = cp.spawnSync;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-pipe-'));
let seq = 0;

function pipeToFiles(stdio) {
  const arr = stdio === undefined ? ['pipe', 'pipe', 'pipe']
    : (stdio === 'pipe' ? ['pipe', 'pipe', 'pipe'] : (Array.isArray(stdio) ? stdio.slice() : null));
  if (!arr) return null;
  let changed = false;
  const fds = [];
  const files = {};
  arr.forEach((s, i) => {
    if (s === 'pipe') {
      changed = true;
      const p = path.join(tmpRoot, 'c' + (++seq) + '-' + i + '.log');
      files[i] = p;
      fds.push(fs.openSync(p, 'w'));
    } else {
      fds.push(s);
    }
  });
  return changed ? { fds, files } : null;
}

function closeFds(fds) {
  fds.forEach(function (fd) { if (typeof fd === 'number' && fd > 2) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } } });
}

cp.spawn = function spawn(cmd, args, opts) {
  opts = opts || {};
  const conv = pipeToFiles(opts.stdio);
  if (!conv) return realSpawn.call(this, cmd, args, opts);
  const child = realSpawn.call(this, cmd, args, Object.assign({}, opts, { stdio: conv.fds }));
  closeFds(conv.fds);
  const wrapper = new EventEmitter();
  wrapper.pid = child.pid;
  wrapper.spawnfile = child.spawnfile;
  wrapper.kill = function () { return child.kill.apply(child, arguments); };
  wrapper.ref = function () { if (child.ref) child.ref(); return wrapper; };
  wrapper.unref = function () { if (child.unref) child.unref(); return wrapper; };
  const outs = {};
  for (const pair of [[1, 'stdout'], [2, 'stderr']]) {
    const i = pair[0], name = pair[1];
    if (conv.files[i] !== undefined) {
      const ps = new PassThrough();
      ps.resume();
      outs[name] = ps;
      wrapper[name] = ps;
    } else {
      wrapper[name] = null;
    }
  }
  let emitted = false;
  function replay(code, signal) {
    if (emitted) return; emitted = true;
    for (const pair of [[1, 'stdout'], [2, 'stderr']]) {
      const i = pair[0], name = pair[1];
      const ps = outs[name];
      if (!ps) continue;
      try { const buf = fs.readFileSync(conv.files[i]); if (buf.length) ps.write(buf); } catch (e) { /* ignore */ }
      try { ps.end(); } catch (e) { /* ignore */ }
      try { fs.unlinkSync(conv.files[i]); } catch (e) { /* ignore */ }
    }
    wrapper.emit('close', code, signal);
  }
  child.on('error', function (e) { wrapper.emit('error', e); replay(-1, null); });
  child.on('close', function (code, signal) { replay(code, signal); });
  return wrapper;
};

cp.spawnSync = function spawnSync(cmd, args, opts) {
  opts = opts || {};
  const conv = pipeToFiles(opts.stdio);
  if (!conv) return realSpawnSync.call(this, cmd, args, opts);
  const res = realSpawnSync.call(this, cmd, args, Object.assign({}, opts, { stdio: conv.fds }));
  closeFds(conv.fds);
  function read(i) {
    let buf = Buffer.alloc(0);
    try { buf = fs.readFileSync(conv.files[i]); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(conv.files[i]); } catch (e) { /* ignore */ }
    return opts.encoding ? buf.toString(opts.encoding) : buf;
  }
  const stdout = conv.files[1] !== undefined ? read(1) : (res.stdout === undefined ? null : res.stdout);
  const stderr = conv.files[2] !== undefined ? read(2) : (res.stderr === undefined ? null : res.stderr);
  return Object.assign({}, res, { stdout: stdout, stderr: stderr });
};
function synthError(message, res) {
  const e = new Error(message);
  e.status = res.status;
  e.signal = res.signal;
  e.stdout = res.stdout;
  e.stderr = res.stderr;
  e.pid = res.pid;
  e.output = res.output;
  return e;
}

// execFileSync / execSync 走的是 Node 内部的 spawnSync 绑定，改 exports.spawnSync 覆盖不到，
// 因此单独代理：仍旧只把 pipe 换成文件 fd，语义（返回值 / 非零退出抛错）保持一致。
cp.execFileSync = function execFileSync(file, args, opts) {
  opts = opts || {};
  const res = cp.spawnSync(file, args || [], opts);
  if (res.error) throw res.error;
  if (res.status !== 0) throw synthError('Command failed: ' + file + ' ' + (args || []).join(' '), res);
  return res.stdout;
};

cp.execSync = function execSync(command, opts) {
  opts = opts || {};
  const res = cp.spawnSync(command, [], Object.assign({}, opts, { shell: true }));
  if (res.error) throw res.error;
  if (res.status !== 0) throw synthError('Command failed: ' + command, res);
  return res.stdout;
};

