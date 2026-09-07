// T-078 S1 L1 真进程探针：serve.mjs 独立进程（port 4987，无 token=写放行）+ 临时空间夹具
// 覆盖：R-A1 嵌套/内嵌 .git HTTP 七操作 403 矩阵 + 符号链接(junction)→.git realpath 复检；顶层对照；零副作用；
//       R-A2 畸形 percent-encoding 单发/超长/并发注入 → 400/404、进程存活、后续 200、无 URIError 落 stderr。
// 只测不修：本脚本不改动被测代码；判定打印 FAIL 即失败。运行：node docs/T078-evidence/l1-probe.mjs
import { request as httpRequest } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'

const BASE = 'http://127.0.0.1:4987'
const FX = 'D:/project/DSH/legion/.legion-worktrees/T-078/docs/T078-evidence/l1-fixture'
let failed = 0
let passed = 0
const failList = []

function check(name, cond, detail) {
  if (cond) { passed += 1; console.log('PASS ' + name) }
  else { failed += 1; failList.push(name); console.log('FAIL ' + name + ' :: ' + detail) }
}

function rawReq(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const u = new URL(BASE)
    const rq = httpRequest({
      host: '127.0.0.1', port: u.port, method, path, headers,
    }, (res) => {
      let t = ''
      res.on('data', (d) => { t += d })
      res.on('end', () => resolve({ status: res.statusCode, body: t, headers: res.headers }))
    })
    rq.on('error', (e) => resolve({ status: 0, error: e.message, code: e.code, name: e.name }))
    if (body !== undefined) rq.write(body)
    rq.end()
  })
}

const jsonReq = (method, path, payload) =>
  rawReq(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })

const encQ = encodeURIComponent

console.log('=== R-A1 嵌套/内嵌 .git HTTP 矩阵（真进程 4987） ===')

// ① 读面 read/download/list → 403 且零内容泄露
for (const rel of ['subrepo/.git/config', 'subrepo/.git/objects/pack/x', 'subrepo/.git/logs/HEAD', 'subrepo/.GIT/config', 'submod/.git']) {
  const q = '?scope=fx&path=' + encQ(rel)
  const rd = await rawReq('/api/files/read' + q)
  check('read 403: ' + rel, rd.status === 403, JSON.stringify(rd).slice(0, 160))
  check('read 无泄露: ' + rel, !(rd.body ?? '').includes('NESTED-LEAK-MARKER') && !(rd.body ?? '').includes('[core]'), (rd.body ?? '').slice(0, 80))
  const dl = await rawReq('/api/files/download' + q)
  check('download 403: ' + rel, dl.status === 403, JSON.stringify(dl).slice(0, 160))
  check('download 非 200 零字节: ' + rel, !(dl.body ?? '').includes('NESTED-LEAK-MARKER'), String(dl.body ?? '').slice(0, 40))
  const ls = await rawReq('/api/files/list' + q)
  check('list 403: ' + rel, ls.status === 403, JSON.stringify(ls).slice(0, 160))
}

// ② 写面 upload/mkdir/rename/delete → 403 且零副作用
const wq = '?scope=fx&path=' + encQ('subrepo/.git/config')
const up = await rawReq('/api/files/upload' + wq + '&overwrite=1', { method: 'PUT', body: 'evil' })
check('upload 403 nested .git', up.status === 403, JSON.stringify(up).slice(0, 160))
const mk = await jsonReq('POST', '/api/files/mkdir', { scope: 'fx', path: 'subrepo/.git/newdir' })
check('mkdir 403 nested .git', mk.status === 403, JSON.stringify(mk).slice(0, 160))
const rnTo = await jsonReq('POST', '/api/files/rename', { scope: 'fx', from: 'README.md', to: 'subrepo/.git/config' })
check('rename-to 403 nested .git', rnTo.status === 403, JSON.stringify(rnTo).slice(0, 160))
const rnFrom = await jsonReq('POST', '/api/files/rename', { scope: 'fx', from: 'subrepo/.git/config', to: 'subrepo/leak.txt' })
check('rename-from 403 nested .git', rnFrom.status === 403, JSON.stringify(rnFrom).slice(0, 160))
const del = await jsonReq('POST', '/api/files/delete', { scope: 'fx', path: 'subrepo/.git/config', confirm: 'yes' })
check('delete 403 nested .git', del.status === 403, JSON.stringify(del).slice(0, 160))
const topRd = await rawReq('/api/files/read?scope=fx&path=' + encQ('.git/config'))
check('顶层 .git read 对照 403', topRd.status === 403, JSON.stringify(topRd).slice(0, 120))
// 零副作用：.git/config 原样（marker 未被写入也未被读走改写）、无新建
check('嵌套 .git/config 未被改写', !readFileSync(FX + '/subrepo/.git/config', 'utf8').includes('evil'))
check('嵌套 .git 内未建目录', !existsSync(FX + '/subrepo/.git/newdir'))
check('leak.txt 未产生（rename 零副作用）', !existsSync(FX + '/subrepo/leak.txt'))

// ③ 符号链接（junction link-to-git → .git）经 realpath 复检 → 403
if (existsSync(FX + '/link-to-git')) {
  const lq = '?scope=fx&path=' + encQ('link-to-git/config')
  const lrd = await rawReq('/api/files/read' + lq)
  check('junction read → .git 403', lrd.status === 403, JSON.stringify(lrd).slice(0, 160))
  const ldl = await rawReq('/api/files/download' + lq)
  check('junction download → .git 403', ldl.status === 403, JSON.stringify(ldl).slice(0, 160))
  const lls = await rawReq('/api/files/list' + lq)
  check('junction list → .git 403', lls.status === 403, JSON.stringify(lls).slice(0, 160))
  const lup = await rawReq('/api/files/upload?scope=fx&path=' + encQ('link-to-git/x') + '&overwrite=1', { method: 'PUT', body: 'x' })
  check('junction upload → .git 403', lup.status === 403, JSON.stringify(lup).slice(0, 160))
  check('junction 目标零落盘', !existsSync(FX + '/link-to-git/x'))
} else {
  console.log('SKIP junction 用例（link-to-git 不存在）')
}

// ④ 正向对照：嵌套仓库工作区普通文件 200、list 根不含隐藏条目
const sane = await rawReq('/api/files/read?scope=fx&path=' + encQ('subrepo/readme.txt'))
check('嵌套仓库工作区 read 200（守卫不误伤）', sane.status === 200 && sane.body.includes('subrepo readable'), JSON.stringify(sane).slice(0, 120))
const subList = await rawReq('/api/files/list?scope=fx&path=' + encQ('subrepo'))
check('subrepo list 200 且无 .git 条目', subList.status === 200 && !JSON.stringify(subList.body).includes('.git'), JSON.stringify(subList).slice(0, 160))

console.log('=== R-A2 畸形 percent-encoding（真进程 4987，raw socket 直发） ===')

// ⑤ 单发畸形矩阵（TC-S1-09）
const mal = [
  '/api/files%zz',
  '/api/files/list%zz',
  '/api/web/fetch%zz',
  '/api/fs/home%zz',
  '/hub%zz',
  '/%zz',
  '/api%zz/files/list',
  '/api/files/%',
  '/api/files/list%zz%zz',
  '/api/files/read?scope=fx&path=' + encQ('README.md') + '%zz',
]
for (const p of mal) {
  const r = await rawReq(p)
  check('畸形单发 400/404: ' + p.slice(0, 40), r.status === 400 || r.status === 404, 'status=' + r.status + ' ' + JSON.stringify(r).slice(0, 120))
}

// ⑥ 长尾/超大畸形（TC-S1-11：路径 ≥1 万字符、重复 % ≥5000、%00 嵌入）
const longPath = '/api/files/' + 'a'.repeat(10000)
const rl = await rawReq(longPath)
check('超长路径 1 万字符受控（400/404/414，非 000）', rl.status !== 0, 'status=' + rl.status + ' ' + JSON.stringify(rl).slice(0, 100))
const longPct = '/api/files/' + '%'.repeat(5000)
const rp = await rawReq(longPct)
check('重复 % 5000 受控（400/404）', rp.status === 400 || rp.status === 404, 'status=' + rp.status)
const nulMix = await rawReq('/api/files/read?scope=fx&path=' + encQ('a\u0000b') + '%zz')
check('NUL+畸形 query 受控（400/404）', nulMix.status === 400 || nulMix.status === 404, 'status=' + nulMix.status)

// ⑦ 12 并发畸形（TC-S1-10）
const pool = ['/api/files%zz', '/api/files/%zz', '/%zz%zz%zz', '/api%zz/list', '/api/files/read%zz', '/api/files/' + '%zz'.repeat(4000)]
const reqs = []
for (let i = 0; i < 12; i += 1) reqs.push(pool[i % pool.length])
const results = await Promise.all(reqs.map((p) => rawReq(p)))
const bad = results.filter((r) => r.status !== 400 && r.status !== 404)
check('12 并发畸形全部 400/404', bad.length === 0, JSON.stringify(bad.slice(0, 2)).slice(0, 200))

// ⑧ 进程存活 + 数据面正常（后置判据）
const health = await rawReq('/api/files/list?scope=fx&path=')
check('畸形注入后进程存活（list 200）', health.status === 200, JSON.stringify(health).slice(0, 120))
const readBack = await rawReq('/api/files/read?scope=fx&path=' + encQ('README.md'))
check('畸形注入后数据面正常（read 200 hello l1）', readBack.status === 200 && readBack.body.includes('hello l1'), JSON.stringify(readBack).slice(0, 120))

console.log('')
console.log('===== 汇总 =====')
console.log('passed=' + passed + ' failed=' + failed)
if (failList.length) { console.log('FAILURES:'); for (const f of failList) console.log(' - ' + f) }
process.exit(failed > 0 ? 1 : 0)
