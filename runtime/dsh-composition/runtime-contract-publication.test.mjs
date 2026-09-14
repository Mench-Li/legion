// runtime/dsh-composition/runtime-contract-publication.test.mjs
// ============================================================================
// 端口发布的**写侧**判据（PRT-253 续批四）
//
// 本套件不启动任何监听器、不启动任何进程：它测的是"写到哪、写什么、
// 什么时候算写成功、失败时是哪一条码"。fs 全部可注入，所以每条失败路径
// 都是确定性的（不需要真的把盘写满）。
//
//   > 一条只在"盘满"那一天才会走到的分支，与一条不存在的分支，
//   > 在代码评审里是同一个东西——除非有人为它写了一条用例。
//
// 五组：
//   ① 写什么：内容恰好是那五个字段（**结构上没有 token 的位置**）
//   ② 怎么写：**原子**——先写临时文件再 rename 覆盖目标
//   ③ 输入不合法：四种各自可分辨的拒绝，且**一个字节都不写**
//   ④ 写失败：具名码 + 清理半截临时文件
//   ⑤ 清理：幂等（"本来就不在"算成功）
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  RUNTIME_CONTRACT_PUBLICATION_CODES,
  RUNTIME_CONTRACT_PUBLICATION_FIELDS,
  RUNTIME_CONTRACT_PUBLICATION_HOSTS,
  RUNTIME_CONTRACT_PUBLICATION_RELPATH,
  RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS,
  RUNTIME_CONTRACT_PUBLICATION_VERSION,
  clearRuntimeContractPublication,
  publishRuntimeContractEndpoint,
  runtimeContractPublicationPath,
} from './runtime-contract-publication.mjs'
import { RUNTIME_CONTRACT_WIRE_VERSION } from '../contracts/wire.mjs'

const DATA_DIR = join(tmpdir(), 'legion-pub-unit', 'data')

/** 一个只记账、不碰盘的 fs。 */
function recordingFs({ failOn = null } = {}) {
  const calls = []
  const err = (code) => Object.assign(new Error(`${code}: 注入的失败`), { code })
  return {
    calls,
    mkdirSync(p, o) { calls.push(['mkdirSync', p]); if (failOn === 'mkdirSync') throw err('EACCES') },
    writeFileSync(p, d, o) { calls.push(['writeFileSync', p, d]); if (failOn === 'writeFileSync') throw err('ENOSPC') },
    renameSync(a, b) { calls.push(['renameSync', a, b]); if (failOn === 'renameSync') throw err('EPERM') },
    rmSync(p, o) { calls.push(['rmSync', p, o]); if (failOn === 'rmSync') throw err('EPERM') },
  }
}

const GOOD = Object.freeze({ dataDir: DATA_DIR, host: '127.0.0.1', port: 51814, pid: 4242 })

// ─────────────────────────────────────────────────── ① 写什么

test('① 写下去的内容**恰好**是那五个字段，顺序即声明顺序（结构上没有 token 的位置）', () => {
  const fs = recordingFs()
  const r = publishRuntimeContractEndpoint({ ...GOOD, fs })
  assert.equal(r.ok, true, `${r.code} ${r.message}`)
  assert.deepEqual(Object.keys(r.record), [...RUNTIME_CONTRACT_PUBLICATION_FIELDS])
  const write = fs.calls.find((c) => c[0] === 'writeFileSync')
  const text = write[2]
  const parsed = JSON.parse(text)
  assert.deepEqual(Object.keys(parsed), [...RUNTIME_CONTRACT_PUBLICATION_FIELDS])
  assert.equal(parsed.version, RUNTIME_CONTRACT_PUBLICATION_VERSION)
  assert.equal(parsed.pid, 4242)
  assert.equal(parsed.host, '127.0.0.1')
  assert.equal(parsed.port, 51814)
  assert.equal(parsed.wireVersion, RUNTIME_CONTRACT_WIRE_VERSION)
  // ★ 反向锚：这份文件里**不可能**有凭证的位置——一个"顺手也写一下"的字段
  //   会让凭证落盘，而落盘的凭证是这条边界最不该有的东西。
  assert.equal(/token/i.test(text), false, `发布里出现了形如 token 的东西：${text}`)
  // 相对路径片段与字符串形式是同一份事实
  assert.equal(RUNTIME_CONTRACT_PUBLICATION_RELPATH, RUNTIME_CONTRACT_PUBLICATION_RELPATH_PARTS.join('/'))
})

test('① 默认的 wireVersion 取自 wire.mjs（不在这里写死第二个数字）', () => {
  const fs = recordingFs()
  const r = publishRuntimeContractEndpoint({ ...GOOD, fs })
  assert.equal(r.record.wireVersion, RUNTIME_CONTRACT_WIRE_VERSION)
  // 显式给一个别的值时必须原样写下去（读侧会按它判 INVALID —— 那是读侧的事）
  const fs2 = recordingFs()
  const r2 = publishRuntimeContractEndpoint({ ...GOOD, wireVersion: 99, fs: fs2 })
  assert.equal(r2.record.wireVersion, 99)
})

// ─────────────────────────────────────────────────── ② 怎么写

test('② ★ 原子：目标路径**只**由 rename 产生，从不被直接写', () => {
  const fs = recordingFs()
  const target = runtimeContractPublicationPath(DATA_DIR)
  const r = publishRuntimeContractEndpoint({ ...GOOD, fs })
  assert.equal(r.ok, true)
  assert.equal(r.path, target)
  const written = fs.calls.filter((c) => c[0] === 'writeFileSync').map((c) => c[1])
  assert.equal(written.includes(target), false,
    '发布被直接写进目标路径——消费方在写的中途读到它时，会看到一个**半截文件**，' +
    '而半截文件与"坏掉的发布"在 JSON.parse 之后同形')
  for (const p of written) {
    assert.match(p, /\.tmp-4242-\d+$/, `临时文件命名没有可辨认的形状：${p}`)
  }
  const renamed = fs.calls.find((c) => c[0] === 'renameSync')
  assert.equal(renamed[2], target, 'rename 的目标必须是发布文件本身')
  assert.equal(renamed[1], written[0], 'rename 的来源必须是刚才写的那个临时文件')
  // 目录必须先建出来（DataDir 下可能有多个进程的子目录）
  assert.deepEqual(fs.calls[0], ['mkdirSync', join(DATA_DIR, 'runtime')])
})

test('② 同一个进程里连续两次发布的临时文件名不同（不会互相覆盖）', () => {
  const a = recordingFs()
  const b = recordingFs()
  publishRuntimeContractEndpoint({ ...GOOD, fs: a })
  publishRuntimeContractEndpoint({ ...GOOD, fs: b })
  const pa = a.calls.find((c) => c[0] === 'writeFileSync')[1]
  const pb = b.calls.find((c) => c[0] === 'writeFileSync')[1]
  assert.notEqual(pa, pb)
})

// ─────────────────────────────────────────────────── ③ 输入不合法

test('③ 没有 DataDir → NO_DATA_DIR，且**一个字节都不写**', () => {
  for (const dataDir of [null, undefined, '', '   ']) {
    const fs = recordingFs()
    const r = publishRuntimeContractEndpoint({ ...GOOD, dataDir, fs })
    assert.equal(r.ok, false)
    assert.equal(r.code, RUNTIME_CONTRACT_PUBLICATION_CODES.NO_DATA_DIR)
    assert.equal(fs.calls.length, 0, '拒绝之前就已经动了盘')
  }
})

test('③ 非回环 host → INVALID_ADDRESS（**不发布一个局域网地址**）', () => {
  const fs = recordingFs()
  const r = publishRuntimeContractEndpoint({ ...GOOD, host: '0.0.0.0', fs })
  assert.equal(r.code, RUNTIME_CONTRACT_PUBLICATION_CODES.INVALID_ADDRESS)
  assert.match(r.message, /0\.0\.0\.0/)
  assert.equal(fs.calls.length, 0)
  // 三个回环形式都允许
  for (const host of RUNTIME_CONTRACT_PUBLICATION_HOSTS) {
    const f = recordingFs()
    assert.equal(publishRuntimeContractEndpoint({ ...GOOD, host, fs: f }).ok, true, `回环 ${host} 被拒了`)
  }
})

test('③ port: 0 → INVALID_ADDRESS（0 的含义是"让内核分配"，不是"端口是 0"）', () => {
  const fs = recordingFs()
  const r = publishRuntimeContractEndpoint({ ...GOOD, port: 0, fs })
  assert.equal(r.code, RUNTIME_CONTRACT_PUBLICATION_CODES.INVALID_ADDRESS)
  assert.equal(fs.calls.length, 0)
  for (const port of [-1, 65536, 1.5, '51814', null]) {
    const f = recordingFs()
    assert.equal(publishRuntimeContractEndpoint({ ...GOOD, port, fs: f }).code,
      RUNTIME_CONTRACT_PUBLICATION_CODES.INVALID_ADDRESS, `port=${String(port)} 竟然被接受了`)
  }
})

test('③ pid 非法 → INVALID_ADDRESS（它是消费侧唯一的陈旧判据，不能省）', () => {
  for (const pid of [0, -1, 1.5, '4242', null, undefined]) {
    const fs = recordingFs()
    const r = publishRuntimeContractEndpoint({ ...GOOD, pid, fs })
    assert.equal(r.code, RUNTIME_CONTRACT_PUBLICATION_CODES.INVALID_ADDRESS, `pid=${String(pid)}`)
    assert.equal(fs.calls.length, 0)
  }
})

test('③ wireVersion 非法 → INVALID_ADDRESS', () => {
  for (const wireVersion of [0, -1, 1.5, null]) {
    const fs = recordingFs()
    assert.equal(publishRuntimeContractEndpoint({ ...GOOD, wireVersion, fs }).code,
      RUNTIME_CONTRACT_PUBLICATION_CODES.INVALID_ADDRESS, `wireVersion=${String(wireVersion)}`)
  }
})

// ─────────────────────────────────────────────────── ④ 写失败

test('④ 写盘失败 → WRITE_FAILED，并把半截临时文件**清掉**（不留假信号）', () => {
  for (const at of ['mkdirSync', 'writeFileSync', 'renameSync']) {
    const fs = recordingFs({ failOn: at })
    const r = publishRuntimeContractEndpoint({ ...GOOD, fs })
    assert.equal(r.ok, false, `${at} 失败竟然报成功`)
    assert.equal(r.code, RUNTIME_CONTRACT_PUBLICATION_CODES.WRITE_FAILED)
    const tmp = fs.calls.find((c) => c[0] === 'writeFileSync')?.[1]
      ?? fs.calls.find((c) => c[0] === 'renameSync')?.[1]
    if (at !== 'mkdirSync') {
      const removed = fs.calls.filter((c) => c[0] === 'rmSync').map((c) => c[1])
      assert.ok(removed.includes(tmp), `半截文件没被清掉：${tmp}（清了 ${removed.join(',')}）`)
    }
    assert.match(r.message, new RegExp(fs.calls.find((c) => c[0] === at)[0] === 'mkdirSync' ? 'EACCES' : 'EPERM|ENOSPC'))
  }
})

// ─────────────────────────────────────────────────── ⑤ 清理

test('⑤ 清理：存在就删；**本来就不在也算成功**（新装机器不该每次启动都收假告警）', () => {
  const gone = recordingFs()
  const r1 = clearRuntimeContractPublication({ dataDir: DATA_DIR, fs: gone })
  assert.equal(r1.ok, true)
  assert.equal(gone.calls[0][0], 'rmSync')
  assert.equal(gone.calls[0][2].force, true, '必须 force：ENOENT 要当成功')

  const enoent = {
    rmSync() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
  }
  const r2 = clearRuntimeContractPublication({ dataDir: DATA_DIR, fs: enoent })
  assert.equal(r2.ok, true, '文件不在被报成了失败')

  const denied = {
    rmSync() { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) },
  }
  const r3 = clearRuntimeContractPublication({ dataDir: DATA_DIR, fs: denied })
  assert.equal(r3.ok, false)
  assert.equal(r3.code, RUNTIME_CONTRACT_PUBLICATION_CODES.CLEAR_FAILED)

  const none = clearRuntimeContractPublication({ dataDir: null, fs: recordingFs() })
  assert.equal(none.code, RUNTIME_CONTRACT_PUBLICATION_CODES.NO_DATA_DIR)
})

// ─────────────────────────────────────────────────── 真盘往返

test('真盘往返：publish 之后文件里的 pid/host/port 与参数逐字一致；clear 之后文件消失', () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-pub-'))
  try {
    const dataDir = join(root, 'data')
    const r = publishRuntimeContractEndpoint({ dataDir, host: '127.0.0.1', port: 51999, pid: 12345 })
    assert.equal(r.ok, true, `${r.code} ${r.message}`)
    assert.equal(existsSync(r.path), true)
    const parsed = JSON.parse(readFileSync(r.path, 'utf8'))
    assert.deepEqual(parsed, {
      version: RUNTIME_CONTRACT_PUBLICATION_VERSION,
      pid: 12345,
      host: '127.0.0.1',
      port: 51999,
      wireVersion: RUNTIME_CONTRACT_WIRE_VERSION,
    })
    // 覆盖写：第二次发布把第一次的顶掉（同一个进程重启后换了端口也是一样）
    const r2 = publishRuntimeContractEndpoint({ dataDir, host: '127.0.0.1', port: 52000, pid: 12345 })
    assert.equal(JSON.parse(readFileSync(r2.path, 'utf8')).port, 52000)
    assert.equal(existsSync(r.path), true)
    const c = clearRuntimeContractPublication({ dataDir })
    assert.equal(c.ok, true)
    assert.equal(existsSync(r.path), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
