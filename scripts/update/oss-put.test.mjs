// scripts/update/oss-put.test.mjs
// ============================================================================
// SigV4 上传器（T-196）的判据。
//
// 这份文件的能力全押在"签名算法实现对了"这一件事上，而签名错了的唯一外部
// 表现是服务端返回 `SignatureDoesNotMatch` —— 它和"凭据不对""桶不存在"
// "时钟偏差"在**第一次使用**时几乎分不出来。
//
//   > 一个只能对着真服务端才知道自己算得对不对的签名器，
//   > 与一个"签名算法抄错了一行"的签名器，在没凭据的那几天里是同一个东西。
//
// 所以核心是**已知向量**（AWS SigV4 测试套件的 get-vanilla，别人给的答案），
// 外加一条"按捕获到的请求头重算签名，必须与发出去的那一个相同"的往返校验。
// ============================================================================
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FIXED_VECTOR, OSS_PUT_CHECKED, UNSIGNED_PAYLOAD, amzDates, argString, buildUrl,
  describeS3Error, judgeProbe, ossRequest, selfCheckOssPut, signRequest, uriEncode, verifyPublicRead,
} from './oss-put.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))

/** `20261009T120000Z` → Date。 */
function dateFromAmz(amzDate) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate)
  assert.ok(m, `amzDate 形状不对：${amzDate}`)
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
}

describe('SigV4 上传器', () => {
  test('① 已知向量：与 AWS 官方期望值逐字一致', () => {
    const v = FIXED_VECTOR
    const got = signRequest({
      method: v.method, canonicalUri: v.canonicalUri, headers: v.headers,
      payloadSha256: v.payloadSha256, region: v.region, service: v.service,
      accessKey: v.accessKey, secretKey: v.secretKey, date: v.date,
    })
    assert.equal(got.signature, v.expectedSignature)
    assert.equal(got.signedHeaders, v.expectedSignedHeaders)
    assert.match(got.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request, /)
  })

  test('② 确定性：同一输入两次得到同一签名', () => {
    const args = {
      method: 'GET', canonicalUri: '/', headers: { host: 'h.example', 'x-amz-date': '20150830T123600Z' },
      payloadSha256: FIXED_VECTOR.payloadSha256, region: 'us-east-1', service: 'service',
      accessKey: 'AK', secretKey: 'SK', date: FIXED_VECTOR.date,
    }
    assert.equal(signRequest(args).signature, signRequest(args).signature)
  })

  test('③ 敏感性：改方法 / 路径 / 载荷 / 头 / 日期，签名都必须变', () => {
    const base = {
      method: 'GET', canonicalUri: '/', headers: { host: 'h.example', 'x-amz-date': '20150830T123600Z' },
      payloadSha256: FIXED_VECTOR.payloadSha256, region: 'us-east-1', service: 'service',
      accessKey: 'AK', secretKey: 'SK', date: FIXED_VECTOR.date,
    }
    const s0 = signRequest(base).signature
    assert.notEqual(signRequest({ ...base, method: 'PUT' }).signature, s0)
    assert.notEqual(signRequest({ ...base, canonicalUri: '/b' }).signature, s0)
    assert.notEqual(signRequest({ ...base, payloadSha256: UNSIGNED_PAYLOAD }).signature, s0)
    assert.notEqual(signRequest({ ...base, headers: { ...base.headers, 'x-amz-acl': 'public-read' } }).signature, s0)
    assert.notEqual(signRequest({ ...base, date: new Date(Date.UTC(2015, 7, 30, 12, 36, 1)) }).signature, s0)
    assert.notEqual(signRequest({ ...base, secretKey: 'SK2' }).signature, s0)
  })

  test('④ uriEncode：保留 `/`，编码空格与非 ASCII', () => {
    // ★ 这三条断言抓出过一个真 bug：`Buffer.from(...).map(fn).join('')`
    //   返回 Buffer，回调的字符串被强转成数字 → `'a b'` 变成 `'a0b'`。
    //   本仓的键都是 ASCII，所以那个错误在真实使用里**看不出来**。
    assert.equal(uriEncode('a b', false), 'a%20b')
    assert.equal(uriEncode('中文', false), '%E4%B8%AD%E6%96%87')
    assert.equal(uriEncode('releases/r-1/x.exe', false), 'releases/r-1/x.exe')
    assert.equal(uriEncode('a/b', true), 'a%2Fb')
    assert.equal(uriEncode("a'b", false), 'a%27b')
  })

  test('⑤ buildUrl：路径式，去掉端点尾斜杠', () => {
    assert.equal(buildUrl('https://s3.cn-north-1.jdcloud-oss.com/', 'b', 'releases/r/x.exe').url,
      'https://s3.cn-north-1.jdcloud-oss.com/b/releases/r/x.exe')
    assert.equal(buildUrl('https://e', 'b').url, 'https://e/b')
  })

  test('⑤b 没有 bucket 时走无桶路径，**不许**拼出字面量 undefined', () => {
    // ★ 这条来自真实的一次列桶尝试：`bucket === undefined` 被 `String(undefined)`
    //   变成 `"undefined"`，请求打到 `/undefined/`，服务端如实回
    //   `404 NoSuchBucket` + `<Resource>/undefined/</Resource>`。
    //   它**看起来像一个正常的 404** —— 而真相是我们在问一个名叫 undefined 的桶。
    for (const missing of [undefined, null, '', '   ']) {
      const u = buildUrl('https://s3.cn-north-1.jdcloud-oss.com', missing)
      assert.equal(u.canonicalUri, '/', `bucket=${JSON.stringify(missing)} 应走无桶路径`)
      assert.equal(u.url, 'https://s3.cn-north-1.jdcloud-oss.com/')
      assert.doesNotMatch(u.url, /undefined|null/, '不许把缺失参数拼成字面量')
    }
    // 但"给了 key 却没给 bucket"没有合法含义 → 拒绝，而不是猜。
    assert.throws(() => buildUrl('https://e', '', 'releases/x'), TypeError)
    assert.throws(() => buildUrl('https://e', undefined, 'k'), TypeError)
  })

  test('⑥ describeS3Error：摘出 Code/Message，认不出时兜底', () => {
    assert.equal(describeS3Error('<Error><Code>NoSuchBucket</Code><Message>x</Message></Error>'), 'NoSuchBucket: x')
    assert.equal(describeS3Error(''), '(空响应)')
    assert.equal(describeS3Error('plain text'), 'plain text')
  })

  test('⑦ 装载期自检为绿（含已知向量）', () => {
    assert.equal(OSS_PUT_CHECKED.ok, true, OSS_PUT_CHECKED.problems.join(' | '))
    assert.equal(selfCheckOssPut().ok, true)
  })

  test('⑧ 时钟只取一次：注入固定时刻后，头与签名必须来自同一个时刻', async () => {
    // ★ 这条守的是一个**偶发**缺陷：`x-amz-date` 头与签名各取一次
    //   `new Date()`，跨秒时两者不一致 → 服务端偶发 `SignatureDoesNotMatch`。
    //
    //   ★★ 第一版没有注入时钟，只是"按捕获到的头重算签名再比"——那样
    //      **只有在两次取时间恰好跨秒时才会红**，于是把实现改成"各取一次"
    //      之后它照样全绿（破坏性验证的 O3 实测就是这样）。
    //      那等于没有判据：*一个只在偶发条件下才变红的断言，
    //      与一个从不变红的断言，在日常跑的那一次里是同一个东西。*
    //
    //   注入固定时刻之后，判据变成确定的：头必须是那个时刻，
    //   且用那个时刻重算的签名必须与发出去的一致。
    const FIXED = new Date(Date.UTC(2026, 9, 9, 12, 0, 0))
    const realFetch = globalThis.fetch
    let captured = null
    globalThis.fetch = async (url, init) => {
      captured = { url, init }
      return new Response('', { status: 200 })
    }
    try {
      await ossRequest({
        method: 'HEAD', endpoint: 'https://s3.cn-north-1.jdcloud-oss.com', bucket: 'b',
        region: 'cn-north-1', accessKey: 'AKID', secretKey: 'SECRET', date: FIXED,
      })
    } finally { globalThis.fetch = realFetch }

    assert.ok(captured, 'fetch 应被调用')
    const headers = captured.init.headers
    // ① 头必须就是被注入的那个时刻（否则说明实现自己另取了一次时间）。
    assert.equal(headers['x-amz-date'], '20261009T120000Z',
      'x-amz-date 必须来自注入的时刻——说明实现又自己取了一次当前时间')
    // ② 按该时刻重算签名，必须与发出去的逐字一致。
    const recomputed = signRequest({
      method: 'HEAD',
      canonicalUri: '/b',
      headers: {
        host: headers.host,
        'x-amz-date': headers['x-amz-date'],
        'x-amz-content-sha256': headers['x-amz-content-sha256'],
      },
      payloadSha256: headers['x-amz-content-sha256'],
      region: 'cn-north-1', accessKey: 'AKID', secretKey: 'SECRET',
      date: dateFromAmz(headers['x-amz-date']),
    })
    assert.equal(headers.authorization, recomputed.authorization,
      'x-amz-date 头与参与签名的时刻不是同一个 —— 跨秒时会偶发 SignatureDoesNotMatch')
  })

  test('⑨ public-read 必须参与签名（否则服务端会拒）', async () => {
    const realFetch = globalThis.fetch
    let captured = null
    globalThis.fetch = async (url, init) => { captured = { url, init }; return new Response('', { status: 200 }) }
    try {
      await ossRequest({
        method: 'PUT', endpoint: 'https://s3.cn-north-1.jdcloud-oss.com', bucket: 'b', key: 'k',
        region: 'cn-north-1', accessKey: 'AKID', secretKey: 'SECRET', publicRead: true,
      })
    } finally { globalThis.fetch = realFetch }
    const headers = captured.init.headers
    assert.equal(headers['x-amz-acl'], 'public-read')
    assert.match(headers.authorization, /SignedHeaders=[^,]*x-amz-acl/, 'x-amz-acl 必须在 SignedHeaders 里')
  })

  test('⑩ 凭据只从环境变量读：不给就具名拒绝（不信命令行参数）', () => {
    // 这条守的是一条纪律而不是功能：`--secret` 会进 shell 历史、并且 `ps` 看得见。
    const env = { ...process.env }
    delete env.JD_OSS_ACCESS_KEY
    delete env.JD_OSS_SECRET_KEY
    const r = spawnSync(process.execPath, ['scripts/update/oss-put.mjs', '--probe', '--bucket', 'x'],
      { cwd: ROOT, encoding: 'utf8', env, timeout: 30_000 })
    assert.equal(r.status, 2)
    assert.match(`${r.stderr}${r.stdout}`, /JD_OSS_ACCESS_KEY/)
  })

  test('⑪ 缺 --bucket 时具名拒绝', () => {
    const env = { ...process.env, JD_OSS_ACCESS_KEY: 'AK', JD_OSS_SECRET_KEY: 'SK' }
    const r = spawnSync(process.execPath, ['scripts/update/oss-put.mjs', '--probe'],
      { cwd: ROOT, encoding: 'utf8', env, timeout: 30_000 })
    assert.equal(r.status, 2)
    assert.match(`${r.stderr}${r.stdout}`, /--bucket/)
  })

  test('⑫ amzDates 形状正确', () => {
    const d = amzDates(new Date(Date.UTC(2026, 9, 9, 12, 0, 0)))
    assert.equal(d.amzDate, '20261009T120000Z')
    assert.equal(d.dateStamp, '20261009')
  })

  // ── 探测判定：三条分支都是第一次真实接入时踩过的 ──────────────────────────
  //
  // ★ 这几条来自**真实排障**：第一次接入时探针用的是 HEAD，而 HEAD 没有响应体，
  //   于是未开通 OSS 服务的账户级错误只能报成「HTTP 403：(空响应)」——
  //   那会让人去查签名，而真正的原因是账号没开通服务。
  //   现在判定是纯函数，三条分支各有判据。

  test('⑬ 桶不存在 = 好消息（签名口径是对的，只是还没建桶）', () => {
    const v = judgeProbe({
      status: 404,
      text: '<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist.</Message></Error>',
    })
    assert.equal(v.ok, true, 'NoSuchBucket 不该被判成失败：它证明签名已经过了')
    assert.match(v.message, /NoSuchBucket/)
    assert.equal(v.hint, null)
  })

  test('⑭ AccountProblem = 账号级问题，提示去开通服务（不是签名问题）', () => {
    const v = judgeProbe({
      status: 403,
      text: '<Error><Code>AccountProblem</Code><Message>User does not open OSS storage service on OSS console</Message></Error>',
    })
    assert.equal(v.ok, false)
    assert.match(v.hint ?? '', /开通/, '必须指向"去开通服务"，否则人会去查签名')
    assert.match(v.hint ?? '', /账号级/)
    assert.doesNotMatch(v.hint ?? '', /ossutil/, '账号没开通服务时不该建议改用 CLI')
  })

  test('⑮ SignatureDoesNotMatch = 口径不一致，明确要求改用厂商 CLI', () => {
    const v = judgeProbe({
      status: 403,
      text: '<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match</Message></Error>',
    })
    assert.equal(v.ok, false)
    assert.match(v.hint ?? '', /ossutil/, '口径不一致时必须让人改用厂商 CLI，而不是在这里猜')
  })

  test('⑯ 200 与 204 都算通过；其它未知错误不编提示', () => {
    assert.equal(judgeProbe({ status: 200, text: '<ListBucketResult/>' }).ok, true)
    assert.equal(judgeProbe({ status: 204, text: '' }).ok, true)
    const unknown = judgeProbe({ status: 500, text: '<Error><Code>InternalError</Code><Message>oops</Message></Error>' })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.hint, null, '认不出的错误不该编一条提示——那会把人引到错的方向')
    assert.match(unknown.message, /InternalError/)
  })

  // ── 参数清洗：CRLF 行尾会静默改掉签名 ────────────────────────────────────
  //
  // ★ 真实踩到：从 Windows 上用 here-string 管道喂远端 bash 时行尾是 CRLF，
  //   于是 `--region cn-north-1` 实际成了 `cn-north-1\r`。CR 进了签名作用域，
  //   undici 抛 `Headers.append: … is an invalid header value`。
  //   更坏的是它**不总是报错**：CR 落在别的位置时服务端只会回
  //   `SignatureDoesNotMatch` —— 与"密钥不对"长得一模一样。

  test('⑰ argString 去掉 CR/LF/Tab/控制字符与首尾空白', () => {
    assert.equal(argString('cn-north-1\r'), 'cn-north-1')
    assert.equal(argString('  legion-releases \n'), 'legion-releases')
    assert.equal(argString('a\tb'), 'ab')
    assert.equal(argString('a\u0000b'), 'ab')
    assert.equal(argString('\r\n'), null, '只剩空白时返回 null（调用方据此报"缺参数"）')
    assert.equal(argString(''), null)
    assert.equal(argString(null), null)
    assert.equal(argString('正常值'), '正常值')
  })

  test('⑱ 带 CR 的 region 不再产出非法 Authorization 头', () => {
    // 这一条直接断言"清洗之后签名头是合法的"——因为脏参数的**表现**
    // 是 fetch 抛 TypeError 或服务端回 SignatureDoesNotMatch，两者都不指向参数。
    const region = argString('cn-north-1\r')
    const headers = { host: 's3.cn-north-1.jdcloud-oss.com', 'x-amz-date': '20261009T120000Z', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' }
    const s = signRequest({
      method: 'GET', canonicalUri: '/b', headers, payloadSha256: 'UNSIGNED-PAYLOAD',
      region, accessKey: 'AK', secretKey: 'SK', date: new Date(Date.UTC(2026, 9, 9, 12, 0, 0)),
    })
    const illegal = [...s.authorization].filter((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) > 126)
    assert.equal(illegal.length, 0, `Authorization 里不该有控制字符：${JSON.stringify(illegal)}`)
    assert.match(s.authorization, /\/cn-north-1\/s3\/aws4_request/)
  })

  // ── 公开读必须**真的验** ────────────────────────────────────────────────
  //
  // ★ 真实踩到（2026-10-10 京东云 OSS）：上传时带 `x-amz-acl: public-read`、
  //   服务端返回 **200**，而匿名读该对象仍是 **403 AccessDenied** ——
  //   京东云**忽略对象级 ACL**，公开读只能在**建桶时**设定。
  //   上传器当时只报"HTTP 200"就结束了，于是"没生效"要等用户点开链接才发现。
  //
  //   > 一个"发了个看起来对的头就认为设置成功"的工具，
  //   > 与一个"真的验过匿名能不能读"的工具，差别在**用户点开链接的那一刻**——
  //   > 而不是在上传返回 200 的那一刻。

  test('⑲ verifyPublicRead：2xx 算生效，403 不算', async () => {
    const at = (status) => async () => new Response('x', { status })
    assert.equal((await verifyPublicRead('https://x/o', { fetchImpl: at(200) })).ok, true)
    assert.equal((await verifyPublicRead('https://x/o', { fetchImpl: at(206) })).ok, true)

    const denied = async () => new Response(
      '<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', { status: 403 })
    const v = await verifyPublicRead('https://x/o', { fetchImpl: denied })
    assert.equal(v.ok, false, '403 必须判为"公开读没生效"')
    assert.equal(v.status, 403)
    assert.match(v.detail, /AccessDenied/, '要把服务端的原话带出来')
  })

  test('⑳ verifyPublicRead：网络异常也算失败（不能静默当成通过）', async () => {
    const boom = async () => { throw new TypeError('fetch failed') }
    const v = await verifyPublicRead('https://x/o', { fetchImpl: boom })
    assert.equal(v.ok, false)
    assert.equal(v.status, null)
    assert.match(v.detail, /fetch failed/)
  })

  test('㉑ verifyPublicRead 用 GET（HEAD 没有响应体，读不到错误原话）', async () => {
    let seen = null
    const spy = async (url, init) => { seen = init; return new Response('', { status: 200 }) }
    await verifyPublicRead('https://x/o', { fetchImpl: spy })
    assert.equal(seen.method, 'GET', '必须用 GET：HEAD 出错时拿不到服务端原话')
  })
})
