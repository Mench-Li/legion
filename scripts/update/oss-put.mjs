#!/usr/bin/env node
// scripts/update/oss-put.mjs —— 把发行产物上传到 S3 兼容对象存储（零安装）
// ============================================================================
// 设计 §9 把"上传"留给调用方（`publish.mjs` 只产出文件，并把两条上传命令打印
// 出来让人执行）。于是仓库里**一直没有上传工具**——而"多线路下载"（T-196）
// 必须有上传这一步，否则线路表里填不出地址。
//
// ## 为什么是零安装的 SigV4，而不是装 ossutil/aws-cli
//
// 运维机上装东西需要网络与权限，而且多一个版本面。这里只用 `node:crypto` 与
// 全局 `fetch` 做 **AWS SigV4** 签名——实测京东云 OSS 的
// `s3.<region>.jdcloud-oss.com` 端点返回**标准 S3 XML 错误**
// （`<Code>NoSuchBucket</Code>` + `RequestId`），所以它认 S3 的签名口径。
//
//   > 一个"要先在运维机上装一个 CLI 才能发布"的流程，
//   > 与一个"`node` 在就能发布"的流程，在第一次紧急发布那天不是同一个东西。
//
// ## 两个刻意的设计
//
// ① **凭据只从环境变量读**（`JD_OSS_ACCESS_KEY` / `JD_OSS_SECRET_KEY`），
//    不接受命令行参数。命令行参数会进 shell 历史，并且**`ps` 能看见**——
//    一个"图省事用 `--secret`"的接口，会让密钥出现在它最不该出现的地方。
// ② **`UNSIGNED-PAYLOAD`**：195MB 的包不该为了签名被读两遍（一遍算摘要、
//    一遍发出去）。TLS 保护传输，而包的完整性由**签名清单里的 sha256** 兜住
//    （`product/update/` 那条线会在安装前校验）。所以这里签"未签名的载荷"是
//    有意的，不是省事。
//
// ## 诚实边界
//
// · **没有在真实 OSS 上跑过**（写它的时候手上还没有凭据）。第一次使用请先用
//   `--probe` 验签名口径：它会对桶发一个 `HEAD`。
//   - 若返回 `SignatureDoesNotMatch`，说明这套签名与服务端口径不同，
//     此时改用厂商 CLI（`ossutil`），不要在这里猜。
// · 不支持分片上传（multipart）：195MB 单次 PUT 可行，但要留意
//   **网络中断就整体重来**。若经常中断，应改用 ossutil 的分片上传。
//
// 用法：
//   # 先验凭据与签名口径（不发数据）
//   JD_OSS_ACCESS_KEY=… JD_OSS_SECRET_KEY=… node scripts/update/oss-put.mjs \
//     --probe --bucket legion-releases --region cn-north-1
//   # 上传
//   JD_OSS_ACCESS_KEY=… JD_OSS_SECRET_KEY=… node scripts/update/oss-put.mjs \
//     --bucket legion-releases --region cn-north-1 \
//     --key releases/r-2026-10-07_0.1.0/Legion-Setup-win-x64.exe \
//     --file /var/lib/legion-hub/releases/releases/r-2026-10-07_0.1.0/Legion-Setup-win-x64.exe \
//     --public-read
// ============================================================================

import { createHash, createHmac } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { basename } from 'node:path'

/** 默认端点形状（实测：`s3.<region>.jdcloud-oss.com` 有 A 记录且返回 S3 XML）。 */
export const DEFAULT_ENDPOINT_TEMPLATE = 'https://s3.{region}.jdcloud-oss.com'

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')
/** S3 允许"载荷未签名"；见文件头 ②。 */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

const sha256Hex = (v) => createHash('sha256').update(v).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

/**
 * SigV4 的 URI 编码：**保留 `/`**（键里的目录分隔不能变成 `%2F`，否则会写成
 * 一个平铺的名字），其余按 RFC 3986 未保留字符之外一律编码。
 */
export function uriEncode(value, encodeSlash = true) {
  return String(value).split('').map((ch) => {
    if (/[A-Za-z0-9\-._~]/.test(ch)) return ch
    if (ch === '/' && !encodeSlash) return ch
    // ★ 必须用 `Array.from(buf, fn)`，**不能**写 `Buffer.from(ch,'utf8').map(fn).join('')`。
    //
    //   后者返回的仍是一个 Buffer：`.map()` 的回调返回值被强转成**数字**，
    //   于是 `'%20'` 变成 `0`，`'a b'` 被编码成 `'a0b'`。
    //   本仓的键恰好都是 ASCII（没空格），所以这个错误**在真实使用中看不出来**——
    //   是自检里那两条 uriEncode 断言把它抓出来的。
    //
    //   > 一个"对我今天用到的键恰好正确"的编码器，
    //   > 与一个正确的编码器，在只用 ASCII 键的那段时间里是同一个东西。
    return Array.from(Buffer.from(ch, 'utf8'), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('')
  }).join('')
}

/** `20261009T120000Z` 与 `20261009`。 */
export function amzDates(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

/**
 * 造一个 SigV4 的 `Authorization` 头。
 *
 * ★ 本函数**不**自行注入 `x-amz-date` / `x-amz-content-sha256`：参与签名的头
 *   完全由调用方给出。这样它才是"照着给定输入算签名"的纯函数，因而能吃
 *   **公开的已知向量**（见 `selfCheckOssPut`）——一个顺手替你补两个头的实现，
 *   会让"签名对不对"变成一件只能对着真服务端才知道的事。
 *
 * @param {object} args
 * @param {string} args.method       GET / HEAD / PUT
 * @param {string} args.canonicalUri 已编码的路径（`/bucket/key`）
 * @param {Record<string,string>} args.headers 参与签名的头（键必须**小写**）
 * @param {string} args.payloadSha256 载荷摘要，或 `UNSIGNED-PAYLOAD`
 * @param {string} args.region
 * @param {string} args.accessKey
 * @param {string} args.secretKey
 * @param {string} [args.query]     规范化查询串（本工具用不到，留作签名器完整性）
 * @param {string} [args.service]   默认 `s3`
 * @param {Date}   [args.date]
 * @returns {{authorization: string, signedHeaders: string, amzDate: string, canonicalRequest: string, stringToSign: string}}
 */
export function signRequest({
  method, canonicalUri, headers, payloadSha256, region, accessKey, secretKey,
  query = '', service = 's3', date = new Date(),
}) {
  const { amzDate } = amzDates(date)
  // 规范化头：键小写、值去首尾空白、按**键**排序、冒号后必须有空格。
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort()
  const canonicalHeaders = names.map((k) => `${k}:${String(headers[k]).trim()}\n`).join('')
  const signedHeaders = names.join(';')

  const canonicalRequest = [
    method,
    canonicalUri,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadSha256,
  ].join('\n')

  const { dateStamp } = amzDates(date)
  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')

  const kDate = hmac(`AWS4${secretKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signedHeaders,
    amzDate,
    signature,
    canonicalRequest,
    stringToSign,
  }
}

/** 拼出端点与路径式 URL。 */
export function buildUrl(endpoint, bucket, key = '') {
  const base = endpoint.replace(/\/+$/, '')
  const path = key === '' ? `/${uriEncode(bucket, false)}` : `/${uriEncode(bucket, false)}/${uriEncode(key, false)}`
  return { url: base + path, canonicalUri: path }
}

/**
 * 发一次请求（`--probe` 与真正的上传共用）。
 * `body` 给了就流式发（并附 `content-length`），否则是空体。
 */
export async function ossRequest({
  method, endpoint, bucket, key = '', region, accessKey, secretKey,
  body = null, contentLength = null, contentType = null, publicRead = false, timeoutMs = 30_000,
  date = null,
}) {
  const { url, canonicalUri } = buildUrl(endpoint, bucket, key)
  const { host } = new URL(url)
  // ★ 时刻只取**一次**，并把它同时用于 `x-amz-date` 头与签名计算。
  //
  //   `signRequest` 的 `date` 默认是"它被调用时的 `new Date()`"。如果这里头写
  //   `amzDates()` 的结果、却让 `signRequest` 自己再取一次当前时间，那么当两次
  //   取时间**跨过一个整秒**时，头里是 T、签的是 T+1s → 服务端报
  //   `SignatureDoesNotMatch`，而它是**偶发**的。
  //
  //   > 一个"两次各自取当前时间"的签名，与一个正确的签名，
  //   > 在绝大多数请求上是同一个东西——只不过前者会以小概率变成
  //   > "凭据好像有问题"，而那种报告最难查。
  //
  //   `date` 是**注入点**：不注入就取当前时间。
  //   ★ 没有这个注入点，"只取一次"这件事只能靠"跨秒时才偶发失败"来观察——
  //     那等于**没有判据**：破坏性验证的 O3 一开始就是这样，它把实现改成
  //     "各取一次"之后测试**照样全绿**。
  const now = date ?? new Date()
  const { amzDate } = amzDates(now)
  // ★ 参与签名的头**显式**列全（`signRequest` 不再替我们补）。
  const headers = {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': UNSIGNED_PAYLOAD,
  }
  if (contentLength !== null) headers['content-length'] = String(contentLength)
  if (contentType !== null) headers['content-type'] = contentType
  // `x-amz-acl` 必须**参与签名**，否则服务端会拒（它是要执行的动作，不是元数据）。
  if (publicRead) headers['x-amz-acl'] = 'public-read'

  const signed = signRequest({
    method, canonicalUri, headers,
    payloadSha256: UNSIGNED_PAYLOAD,
    region, accessKey, secretKey, date: now,
  })
  const res = await fetch(url, {
    method,
    headers: { ...headers, authorization: signed.authorization },
    body: body ?? undefined,
    // 流式请求体必须显式声明 half duplex（Node 的 fetch 要求）。
    ...(body !== null ? { duplex: 'half' } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text().catch(() => '')
  return { status: res.status, ok: res.ok, text, url, signedHeaders: signed.signedHeaders }
}

/** 把 S3 的 XML 错误摘成一行可读的理由（`<Code>`/`<Message>`）。 */
export function describeS3Error(text) {
  const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? null
  const message = /<Message>([^<]*)<\/Message>/.exec(text)?.[1] ?? null
  if (code === null && message === null) return (text || '').trim().slice(0, 200) || '(空响应)'
  return `${code ?? '?'}: ${message ?? ''}`
}

function parseArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const next = argv[i + 1]
    args.set(token.slice(2), next !== undefined && !String(next).startsWith('--') ? next : 'true')
  }
  return args
}

// ---------------------------------------------------------------------------
// 自检：用**公开的已知向量**验签名器
// ---------------------------------------------------------------------------
//
// ★ 为什么必须有它：这份文件的能力全押在"签名算法实现对了"这一件事上，
//   而签名错了的唯一外部表现是服务端返回 `SignatureDoesNotMatch` ——
//   那与"凭据不对""桶不存在""时钟偏差"在**第一次使用**时很难区分。
//
//   > 一个只能对着真服务端才知道自己算得对不对的签名器，
//   > 与一个"签名算法抄错了一行"的签名器，在没凭据的那几天里是同一个东西。
//
//   所以这里放一条**别人给的**答案：AWS SigV4 测试套件的 `get-vanilla` 用例
//   （凭证 `AKIDEXAMPLE`、区域 `us-east-1`、服务 `service`、日期 `20150830T123600Z`）。
//   它验的是同一条 HMAC 链与同一套规范化规则——S3 兼容端点吃的就是这套。
export const FIXED_VECTOR = Object.freeze({
  name: 'AWS SigV4 test suite / get-vanilla',
  method: 'GET',
  canonicalUri: '/',
  headers: Object.freeze({ host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' }),
  payloadSha256: EMPTY_SHA256,
  region: 'us-east-1',
  service: 'service',
  accessKey: 'AKIDEXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  date: new Date(Date.UTC(2015, 7, 30, 12, 36, 0)),
  expectedSignature: '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
  expectedSignedHeaders: 'host;x-amz-date',
})

export function selfCheckOssPut() {
  const problems = []
  const v = FIXED_VECTOR
  const got = signRequest({
    method: v.method, canonicalUri: v.canonicalUri, headers: v.headers,
    payloadSha256: v.payloadSha256, region: v.region, service: v.service,
    accessKey: v.accessKey, secretKey: v.secretKey, date: v.date,
  })
  if (got.signature !== v.expectedSignature) {
    problems.push(`已知向量签名不符：期望 ${v.expectedSignature}，实际 ${got.signature}`
      + '（HMAC 链或规范化规则实现有误；不要再猜，改用厂商 CLI）')
  }
  if (got.signedHeaders !== v.expectedSignedHeaders) {
    problems.push(`已知向量的 SignedHeaders 不符：期望 ${v.expectedSignedHeaders}，实际 ${got.signedHeaders}`)
  }
  // URI 编码：`/` 必须保留，其余不可保留字符必须编码。
  if (uriEncode('releases/r-1/x.exe', false) !== 'releases/r-1/x.exe') problems.push('uriEncode 把 / 编码了')
  if (uriEncode('a b', false) !== 'a%20b') problems.push('uriEncode 没有编码空格')
  if (uriEncode('中文', false) !== '%E4%B8%AD%E6%96%87') problems.push('uriEncode 没有正确编码非 ASCII')
  // XML 错误解析。
  const parsed = describeS3Error('<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist.</Message></Error>')
  if (parsed !== 'NoSuchBucket: The specified bucket does not exist.') problems.push(`describeS3Error 解析不符：${parsed}`)
  if (describeS3Error('') !== '(空响应)') problems.push('空响应没有兜底文案')
  // 路径式 URL。
  const u = buildUrl('https://s3.cn-north-1.jdcloud-oss.com/', 'b', 'releases/r/x.exe')
  if (u.url !== 'https://s3.cn-north-1.jdcloud-oss.com/b/releases/r/x.exe') problems.push(`buildUrl 不符：${u.url}`)
  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) })
}

export const OSS_PUT_CHECKED = selfCheckOssPut()

const isMain = process.argv[1] !== undefined
  && basename(process.argv[1]) === 'oss-put.mjs'

if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const accessKey = process.env.JD_OSS_ACCESS_KEY ?? ''
  const secretKey = process.env.JD_OSS_SECRET_KEY ?? ''
  if (accessKey === '' || secretKey === '') {
    process.stderr.write('oss-put 需要 JD_OSS_ACCESS_KEY / JD_OSS_SECRET_KEY 环境变量'
      + '（**刻意**不支持命令行参数：那会让密钥进 shell 历史并且 `ps` 可见）\n')
    process.exit(2)
  }
  const bucket = typeof args.get('bucket') === 'string' ? args.get('bucket') : null
  const region = typeof args.get('region') === 'string' ? args.get('region') : 'cn-north-1'
  if (bucket === null) { process.stderr.write('oss-put 需要 --bucket\n'); process.exit(2) }
  const endpoint = typeof args.get('endpoint') === 'string'
    ? args.get('endpoint')
    : DEFAULT_ENDPOINT_TEMPLATE.replace('{region}', region)

  const common = { endpoint, bucket, region, accessKey, secretKey }

  if (args.get('probe') === 'true') {
    // 对桶发 HEAD：不发数据，只验"这套签名口径服务端认不认"。
    const r = await ossRequest({ ...common, method: 'HEAD', timeoutMs: 20_000 })
    if (r.ok) {
      process.stdout.write(`✔ 凭据与签名口径可用（HEAD ${r.url} → ${r.status}）\n`)
      process.exit(0)
    }
    // 404 = 签名过了但桶不存在（这是**好消息**：口径对，只是桶还没建）。
    const why = describeS3Error(r.text)
    if (r.status === 404 || /NoSuchBucket/i.test(r.text)) {
      process.stdout.write(`✔ 签名口径可用，但桶不存在（HTTP ${r.status}，${why}）\n`)
      process.exit(0)
    }
    process.stderr.write(`✖ HEAD ${r.url} → HTTP ${r.status}：${why}\n`
      + '  若为 SignatureDoesNotMatch，说明本工具的签名口径与服务端不同，'
      + '  请改用厂商 CLI（ossutil），不要在这里猜。\n')
    process.exit(1)
  }

  const file = typeof args.get('file') === 'string' ? args.get('file') : null
  const key = typeof args.get('key') === 'string' ? args.get('key') : null
  if (file === null || key === null) { process.stderr.write('oss-put 需要 --file 与 --key\n'); process.exit(2) }
  const stat = statSync(file)
  const publicRead = args.get('public-read') === 'true'
  process.stdout.write(`上传 ${file}（${stat.size} 字节）→ ${endpoint}/${bucket}/${key}`
    + `${publicRead ? '（公开读）' : ''}\n`)

  const started = Date.now()
  const r = await ossRequest({
    ...common, method: 'PUT', key,
    body: createReadStream(file),
    contentLength: stat.size,
    contentType: 'application/vnd.microsoft.portable-executable',
    publicRead,
    // 195MB 的 PUT 给足时间；中断会整体失败（见文件头"诚实边界"）。
    timeoutMs: 30 * 60_000,
  })
  const sec = (Date.now() - started) / 1000
  if (r.ok) {
    process.stdout.write(`✔ HTTP ${r.status}，用时 ${sec.toFixed(1)}s`
      + `（${(stat.size / sec / 1048576).toFixed(2)} MB/s）\n`)
    process.exit(0)
  }
  process.stderr.write(`✖ HTTP ${r.status}：${describeS3Error(r.text)}\n`)
  process.exit(1)
}
