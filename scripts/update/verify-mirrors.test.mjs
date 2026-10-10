// scripts/update/verify-mirrors.test.mjs
// ============================================================================
// 多线路校验脚本（T-196）的判据。
//
// 这组用例守的是一条**发布时**才该发现的错误：镜像上的字节与原站不同。
//
//   > 一个"能下完、但下到的是另一份二进制"的镜像，
//   > 与一个"下不动的镜像"，在"这次下载有没有让用户中毒"这件事上不是一个东西——
//   > 只不过前者在**下载进度条**上看起来完全成功。
//
// 客户端有签名清单兜底，所以坏镜像不会变成坏安装；但它会变成一次
// **100% 失败率的下载**，而那时用户已经等了十分钟。
//
// 用注入的 `probe` / `digest` 假网络：判据本身与网络无关，
// 而真网络会让"哪一条断言红"取决于今天网速。
// ============================================================================
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { VERIFY_MIRRORS_FORMAT, verifyMirrors } from './verify-mirrors.mjs'

const SIZE = 204641180
const SHA = 'b8be07da8fcb0dc6dff3561328ce8385a9193256b8d42ef883d60dce7b0ffee3'

const LINES = Object.freeze([
  Object.freeze({ id: 'cn', label: '国内线路', labelEn: 'China', url: 'https://cn.example/x.exe', countries: Object.freeze(['CN']) }),
  Object.freeze({ id: 'global', label: '国际线路', labelEn: 'Global', url: 'https://global.example/x.exe', countries: Object.freeze([]) }),
])

/** 一个"一切正常"的假网络。 */
const okProbe = (over = {}) => async () => ({
  ok: true, status: 206, rangeSupported: true, totalBytes: SIZE,
  sampleBytes: 1024, sampleSha256: 'a'.repeat(64), elapsedMs: 100, bytesPerSecond: 1048576, ...over,
})
const okDigest = (over = {}) => async () => ({
  ok: true, bytes: SIZE, sha256: SHA, elapsedMs: 1000, bytesPerSecond: 1000, ...over,
})

describe('多线路校验', () => {
  test('① 全绿：两条线路可达、支持 Range、总长度一致、摘要一致', async () => {
    const r = await verifyMirrors({
      lines: LINES, expected: { sizeBytes: SIZE, sha256: SHA }, full: true,
      probe: okProbe(), digest: okDigest(),
    })
    assert.equal(r.ok, true, JSON.stringify(r.failures))
    assert.equal(r.rows.length, 2)
    assert.equal(r.totalBytes, SIZE)
  })

  test('② 不支持 Range 必须失败（设计 §4 要求断点续传）', async () => {
    const r = await verifyMirrors({
      lines: LINES,
      probe: async (url) => (url.includes('cn.example')
        ? { ok: true, status: 200, rangeSupported: false, totalBytes: SIZE, sampleBytes: 1024 }
        : { ok: true, status: 206, rangeSupported: true, totalBytes: SIZE, sampleBytes: 1024 }),
    })
    assert.equal(r.ok, false)
    assert.ok(r.failures.some((f) => f.includes('cn') && f.includes('Range')), r.failures.join(' | '))
  })

  test('③ 各线路总长度不一致 = 至少一条不是同一份文件', async () => {
    const r = await verifyMirrors({
      lines: LINES,
      probe: async (url) => ({
        ok: true, status: 206, rangeSupported: true, sampleBytes: 1024,
        totalBytes: url.includes('cn.example') ? SIZE : SIZE + 1,
      }),
    })
    assert.equal(r.ok, false)
    assert.ok(r.failures.some((f) => f.includes('总长度不一致')), r.failures.join(' | '))
  })

  test('④ 与清单的总长度不符', async () => {
    const r = await verifyMirrors({
      lines: LINES, expected: { sizeBytes: SIZE + 7, sha256: SHA }, probe: okProbe(),
    })
    assert.equal(r.ok, false)
    assert.ok(r.failures.some((f) => f.includes('与清单不符')))
  })

  test('⑤ 完整摘要与清单不符（--full）', async () => {
    const bad = 'c'.repeat(64)
    const r = await verifyMirrors({
      lines: LINES, expected: { sizeBytes: SIZE, sha256: SHA }, full: true,
      probe: okProbe(), digest: async (url) => ({ ok: true, bytes: SIZE, sha256: url.includes('cn.example') ? bad : SHA }),
    })
    assert.equal(r.ok, false)
    assert.ok(r.failures.some((f) => f.includes('cn') && f.includes('摘要与清单不符')), r.failures.join(' | '))
  })

  test('⑥ 各线路之间摘要不一致（没给清单时也要能发现）', async () => {
    const r = await verifyMirrors({
      lines: LINES, full: true,
      probe: okProbe(), digest: async (url) => ({ ok: true, bytes: SIZE, sha256: url.includes('cn.example') ? 'd'.repeat(64) : SHA }),
    })
    assert.equal(r.ok, false)
    assert.ok(r.failures.some((f) => f.includes('完整摘要不一致')), r.failures.join(' | '))
  })

  test('⑦ 不可达的线路要带出**它自己说的理由**', async () => {
    const r = await verifyMirrors({
      lines: LINES,
      probe: async (url) => (url.includes('cn.example')
        ? { ok: false, code: 'request-failed', reason: 'TimeoutError: aborted' }
        : { ok: true, status: 206, rangeSupported: true, totalBytes: SIZE, sampleBytes: 1024 }),
    })
    assert.equal(r.ok, false)
    assert.ok(r.failures.some((f) => f.includes('TimeoutError')), '不可达时必须带出底层理由，而不是只说"不可达"')
  })

  test('⑧ 没有可用的总长度也要失败（不能拿 Content-Length 冒充）', async () => {
    const r = await verifyMirrors({
      lines: LINES,
      probe: async () => ({ ok: true, status: 206, rangeSupported: true, totalBytes: null, sampleBytes: 1024 }),
    })
    assert.equal(r.ok, false)
    assert.ok(r.failures.every((f) => f.includes('总长度')), r.failures.join(' | '))
  })

  test('⑨ 抽样模式**不**声称验过字节（full:false 时不做摘要断言）', async () => {
    const r = await verifyMirrors({ lines: LINES, probe: okProbe() })
    assert.equal(r.ok, true, JSON.stringify(r.failures))
    assert.equal(r.full, false)
    // 抽样模式下完整摘要从未被调用过——所以"摘要一致"这件事**没有**被证明。
    assert.equal(r.rows.every((row) => row.full === null), true)
  })

  test('⑩ --full 时下载失败的线路要失败（不能静默当成通过）', async () => {
    const r = await verifyMirrors({
      lines: LINES, full: true,
      probe: okProbe(), digest: async (url) => (url.includes('cn.example')
        ? { ok: false, code: 'read-failed', reason: 'socket hang up' }
        : { ok: true, bytes: SIZE, sha256: SHA }),
    })
    assert.equal(r.ok, false)
    assert.ok(r.failures.some((f) => f.includes('完整下载失败') && f.includes('socket hang up')))
  })

  test('⑪ 格式名带版本（协议的一部分）', () => {
    assert.equal(VERIFY_MIRRORS_FORMAT, 'legion/verify-mirrors@1')
  })
})
