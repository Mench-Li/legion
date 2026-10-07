#!/usr/bin/env node
// scripts/update/keygen.mjs —— 发布签名密钥
// ============================================================================
// 设计 §5 line 128：
//
//   「换密钥需先通过旧信任根签名的客户端更新预置新公钥，再切换发布签名。
//     首期不提供远程任意替换信任根的入口；签名私钥泄漏后的紧急恢复保留
//     人工下载可信安装包路径。」
//
// 所以这个脚本做三件事，各自对应一次部署动作：
//
//   1. `new`     —— 生成一对发布密钥（私钥只在发布机/CI 密钥存储里）
//   2. `trust`   —— 把公钥加进信任表文件（打包时写进客户端）
//   3. `rotate`  —— 用**旧私钥**签一份信任表增量（预置新公钥）
//
// 它**不**碰网络、不碰托管。上传是另一条路径的事（见 `publish.mjs`），
// 而"生成密钥"与"上传密钥"混在一起是签名私钥泄漏最常见的原因。
//
// 用法：
//   node scripts/update/keygen.mjs new --key-id release-2026-a --out ./keys
//   node scripts/update/keygen.mjs trust --install-root . --key-id release-2026-a \
//        --public-key ./keys/release-2026-a.pub.pem
//   node scripts/update/keygen.mjs rotate --key-id release-2026-a \
//        --private-key ./keys/release-2026-a.key.pem \
//        --add-key-id release-2026-b --add-public-key ./keys/release-2026-b.pub.pem \
//        --sequence 2 --issued-at 2026-10-04T00:00:00Z --expires-at 2026-11-04T00:00:00Z \
//        --out ./keys/trust-update.json
// ============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { keyFingerprint, generateReleaseKeyPair, signTrustUpdate, serializeEnvelope } from '../../product/update/envelope.mjs'
import {
  applyTrustUpdateToTable, buildTrustTable, readTrustTable, updateTrustPath, writeTrustTable,
} from './trust-file.mjs'

function parseArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    args.set(key, next !== undefined && !String(next).startsWith('--') ? next : 'true')
  }
  return args
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 2
  return null
}

function commandNew(args) {
  const keyId = args.get('key-id')
  if (typeof keyId !== 'string' || keyId === '') return fail('new 需要 --key-id')
  const out = args.get('out') ?? '.'
  const pair = generateReleaseKeyPair({ keyId, comment: args.get('comment') ?? null })
  mkdirSync(out, { recursive: true })
  const privatePath = join(out, `${keyId}.key.pem`)
  const publicPath = join(out, `${keyId}.pub.pem`)
  // ★ 私钥文件**只在显式要求时**才写出来。默认不写是为了让"密钥留在
  //   CI 密钥存储里"成为默认路径，而不是要人记得别把它落盘。
  if (args.get('write-private') === 'true') {
    writeFileSync(privatePath, pair.privateKeyPem, { encoding: 'utf8', mode: 0o600 })
  }
  writeFileSync(publicPath, pair.publicKeyPem, 'utf8')
  process.stdout.write(`${JSON.stringify({
    keyId,
    publicKeyPath: publicPath,
    privateKeyPath: args.get('write-private') === 'true' ? privatePath : null,
    fingerprint: keyFingerprint(pair.publicKeyPem),
    note: '公钥进信任表（keygen trust），私钥留在发布机或 CI 密钥存储里',
  }, null, 2)}\n`)
  return 0
}

function commandTrust(args) {
  const installRoot = args.get('install-root')
  const keyId = args.get('key-id')
  const publicKeyPath = args.get('public-key')
  if (typeof installRoot !== 'string') return fail('trust 需要 --install-root')
  if (typeof keyId !== 'string' || keyId === '') return fail('trust 需要 --key-id')
  if (typeof publicKeyPath !== 'string' || !existsSync(publicKeyPath)) return fail(`trust 需要存在的 --public-key：${publicKeyPath}`)
  const publicKeyPem = readFileSync(publicKeyPath, 'utf8')
  const path = updateTrustPath(installRoot)
  let existing = { format: 'legion/update-trust@1', sequence: 0, keys: [] }
  if (existsSync(path)) {
    try { existing = JSON.parse(readFileSync(path, 'utf8')) } catch { /* 坏了就重建，下面会报出来 */ }
  }
  const table = buildTrustTable({
    sequence: Number(args.get('sequence') ?? existing.sequence ?? 0) || (existing.sequence ?? 0),
    keys: [
      ...(Array.isArray(existing.keys) ? existing.keys.filter((key) => key?.keyId !== keyId) : []),
      {
        keyId,
        publicKeyPem,
        ...(args.get('not-before') === 'true' ? { notBeforeMs: Date.parse(args.get('not-before')) } : {}),
        ...(typeof args.get('not-after') === 'string' && args.get('not-after') !== 'true' ? { notAfterMs: Date.parse(args.get('not-after')) } : {}),
      },
    ],
  })
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(table, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({
    trustPath: path,
    keyIds: table.keys.map((key) => key.keyId),
    fingerprint: keyFingerprint(publicKeyPem),
  }, null, 2)}\n`)
  return 0
}

function commandRotate(args) {
  const keyId = args.get('key-id')
  const privateKeyPath = args.get('private-key')
  const addKeyId = args.get('add-key-id')
  const addPublicKeyPath = args.get('add-public-key')
  for (const [flag, value] of [['--key-id', keyId], ['--private-key', privateKeyPath], ['--add-key-id', addKeyId], ['--add-public-key', addPublicKeyPath]]) {
    if (typeof value !== 'string' || value === '') return fail(`rotate 需要 ${flag}`)
  }
  if (!existsSync(privateKeyPath)) return fail(`rotate 需要存在的 --private-key：${privateKeyPath}`)
  if (!existsSync(addPublicKeyPath)) return fail(`rotate 需要存在的 --add-public-key：${addPublicKeyPath}`)
  const sequence = Number(args.get('sequence'))
  if (!Number.isSafeInteger(sequence) || sequence < 1) return fail('rotate 需要正整数 --sequence')
  const issuedAt = args.get('issued-at')
  const expiresAt = args.get('expires-at')
  if (typeof issuedAt !== 'string' || typeof expiresAt !== 'string') return fail('rotate 需要 --issued-at 与 --expires-at（ISO + Z）')

  const envelope = signTrustUpdate({
    privateKeyPem: readFileSync(privateKeyPath, 'utf8'),
    keyId,
    sequence,
    issuedAt,
    expiresAt,
    add: [{ keyId: addKeyId, publicKeyPem: readFileSync(addPublicKeyPath, 'utf8') }],
  })
  const bytes = serializeEnvelope(envelope)
  const out = args.get('out')
  if (typeof out === 'string' && out !== 'true') {
    writeFileSync(out, bytes, 'utf8')
    process.stdout.write(`${JSON.stringify({ out, keyId, added: addKeyId, sequence }, null, 2)}\n`)
  } else {
    process.stdout.write(bytes)
  }
  return 0
}

/**
 * `apply` —— 把 `rotate` 签出来的增量应用到随包信任表上。
 *
 * 设计 §5 line 128 的顺序是「先通过旧信任根签名的**客户端更新**预置新公钥，
 * 再切换发布签名」。`rotate` 只做了前半句的签名；本条命令做的是"预置"——
 * 产出一份新的 `update-trust.json`，它随下一版客户端一起打包。
 *
 * ★ 没有这条命令，`rotate` 的输出就没有任何消费者，而
 *   `envelope.applyTrustUpdate()` 会变成一个"生产里调用方数为 0"的函数。
 */
function commandApply(args) {
  const trustPath = args.get('trust')
  const updatePath = args.get('update')
  for (const [flag, value] of [['--trust', trustPath], ['--update', updatePath]]) {
    if (typeof value !== 'string' || value === '') return fail(`apply 需要 ${flag}`)
  }
  const current = readTrustTable(trustPath)
  if (current.ok !== true) return fail(current.reason)

  const applied = applyTrustUpdateToTable({
    table: current.table,
    updateBytes: readFileSync(updatePath),
    nowMs: Date.now(),
  })
  if (applied.ok !== true) {
    return fail(`增量没有被接受（${applied.code}）：${applied.reason}\n`
      + `  当前信任表 sequence=${current.table.sequence}，钥匙 ${current.table.keys.map((k) => k.keyId).join(', ') || '（空）'}`)
  }

  const out = args.get('out')
  const reading = {
    keyIds: applied.table.keys.map((key) => key.keyId),
    added: applied.added,
    revoked: applied.revoked,
    previousSequence: applied.previousSequence,
    sequence: applied.table.sequence,
  }
  if (typeof out === 'string' && out !== 'true') {
    writeTrustTable(out, applied.table)
    process.stdout.write(`${JSON.stringify({ ...reading, out }, null, 2)}\n`)
  } else {
    process.stdout.write(`${JSON.stringify(applied.table, null, 2)}\n`)
  }
  return 0
}

const COMMANDS = Object.freeze({
  new: commandNew, trust: commandTrust, rotate: commandRotate, apply: commandApply,
})

export function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv
  const run = COMMANDS[command]
  if (run === undefined) {
    process.stderr.write(`用法：node scripts/update/keygen.mjs <${Object.keys(COMMANDS).join('|')}> [选项]\n`)
    return 2
  }
  return run(parseArgs(rest))
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (invokedDirectly) main()
