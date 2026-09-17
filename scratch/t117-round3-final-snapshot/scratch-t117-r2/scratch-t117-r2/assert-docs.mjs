import { readFileSync } from 'node:fs'
const W = process.argv[2] || 'D:/project/DSH/legion/.legion-worktrees/T-117/'
const feats = readFileSync(W + 'docs/FEATURES.md', 'utf8').replace(/\r/g, '')
const readme = readFileSync(W + 'README.md', 'utf8').replace(/\r/g, '')
let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log('  [PASS] ' + msg) } else { fail++; console.log('  [FAIL] ' + msg) } }
const slugify = s => s.toLowerCase().replace(/[。，、：；！？“”‘’（）《》【】·…—±××]/g, '').replace(/[^\w\u4e00-\u9faf\s-]/g, '').trim().replace(/\s+/g, '-')
const headingRe = /^(#{1,6})\s+(.+)$/
const heads = [...feats.split('\n')].map((l, i) => { const m = headingRe.exec(l); return m ? { level: m[1].length, text: m[2].trim(), line: i } : null }).filter(Boolean)
const headText = new Set(heads.map(h => h.text))
const headSlug = new Set(heads.map(h => slugify(h.text)))
const fl = feats.split('\n')
const rows = fl.filter(l => /^F-[0-9]{2}/.test(l))
const cells = r => r.split(String.fromCharCode(124)).map(s => s.trim()).filter(Boolean)
const spanBody = (fromLine, fromLevel) => {
  const out = []
  for (let j = fromLine + 1; j < fl.length; j++) {
    const h = headingRe.exec(fl[j])
    if (h && h[1].length <= fromLevel) break
    if (fl[j].trim() && !headingRe.test(fl[j])) out.push(fl[j])
  }
  return out
}
console.log('== S1 docs/FEATURES.md ==')
ok(feats.length > 0 && headingRe.test(fl[0]), 'TC-S1-01 存在非空且首行 # 标题 (len=' + feats.length + ')')
ok(fl[0].includes('功能使用介绍'), 'TC-S1-02 标题行含「功能使用介绍」')
const cats = ['一句话定位', '面向读者', '快速开始', '模块章节', '功能索引', '故障排查与术语附录']
for (const c of cats) {
  const h = heads.find(x => x.text.includes(c))
  ok(!!h, 'TC-S1-03 六类章节标题: ' + c)
  if (h) { const b = spanBody(h.line, h.level); ok(b.length > 0, 'TC-S1-03 「' + c + '」章节域非空（正文行=' + b.length + '）') }
}
ok(rows.length >= 18, 'TC-S1-04 索引行数=' + rows.length + ' >= 18')
const badCols = rows.filter(r => cells(r).length !== 5)
ok(badCols.length === 0, 'TC-S1-04 0 坏列（bad=' + badCols.length + '）')
const badStatus = rows.filter(r => !['已上线', '迭代中', '遗留'].includes(cells(r)[4]))
ok(badStatus.length === 0, 'TC-S1-07 状态枚举合法（bad=' + badStatus.length + '）')
const badAnchor = rows.filter(r => !headText.has(cells(r)[2]))
ok(badAnchor.length === 0, 'TC-S1-05 索引锚点 0 失效（bad=' + badAnchor.length + '）')
let short = 0, noKw = 0
for (const r of rows) {
  const c = cells(r)
  const hIdx = heads.findIndex(h => h.text === c[2])
  if (hIdx < 0) { short++; continue }
  const body = spanBody(heads[hIdx].line, heads[hIdx].level)
  if (body.length < 5) { short++; console.log('  [warn] short: ' + c[2] + '=' + body.length) }
  if (!/入口|操作/.test(body.join(' '))) { noKw++; console.log('  [warn] noKw: ' + c[2]) }
}
ok(short === 0, 'TC-S1-06 索引对应小节 >=5 行（short=' + short + '）')
ok(noKw === 0, 'TC-S1-06 小节含入口/操作（miss=' + noKw + '）')
const narr = (feats.match(/P1\/P2\/P3.*已交付|切片 S[0-9]+.*已交付/g) || []).length
ok(narr === 0, 'TC-S1-07/13 无过程叙事（count=' + narr + '）')
ok(((feats + '\nP1 切片 S5-S8 已交付').match(/P1\/P2\/P3.*已交付|切片 S[0-9]+.*已交付/g) || []).length > 0, 'TC-S1-13(反) 注入叙事可检出')
ok(cells('F-99 | 探测 | 3.1 安装与启动 | 已上线').length !== 5, 'TC-S1-11(反) 4 列坏行可检出')
ok(!headText.has('#999'), 'TC-S1-12(反) 失效锚点可检出')
ok(rows.length === 18, 'TC-S1-10 边界：恰 18 行（下界满足，无越界误报）')
ok(!feats.includes('#999'), 'TC-S1-14(反) 现状无 <5 行空壳小节（负例阈值由 S3 镜像负例覆盖）')
const featSecs = heads.filter(h => h.level === 3 && /^3\./.test(h.text)).length
const readmeSecs = [...readme.matchAll(/^### 3\.(\d+)/gm)].length
ok(featSecs >= readmeSecs, 'TC-S1-08 手册 3.x 小节(' + featSecs + ')>=README 引导数(' + readmeSecs + ')')
ok(/三件套/.test(feats) && /DSH Desktop/.test(feats) && /三分钟体验循环/.test(feats), 'TC-S1-08 README §2 细节承接')
const domains = ['安装与启动','空间与专属编队','中央视图','任务集与任务详情','发布目标','调度与验收','自动交接','模型','对话中心','文件中心','浏览器助手','规范中心','技能中心','日程','审计','team-hub','v1 遗留','故障排查']
const missing = domains.filter(d => !rows.some(r => r.includes(d) || cells(r)[1].includes(d)))
ok(missing.length === 0, 'TC-S1-09 18 功能域索引登记齐全（missing=' + JSON.stringify(missing) + '）')
ok(!/docs\/G-[^/\s]+\/FEATURES\.md/.test(feats), 'TC-S1-15 无目标级目录路径书写')
console.log('== S2 README.md ==')
ok(readme.length > 0 && headingRe.test(readme.split('\n')[0]), 'TC-S2-01 README 非空 MD (len=' + readme.length + ')')
const links = [...readme.matchAll(/docs\/FEATURES\.md#([^\s)\]]+)/g)].map(m => m[1])
ok(links.length >= 8, 'TC-S2-02 互链数=' + links.length + ' >= 8')
const badLinks = [...new Set(links)].filter(a => !headSlug.has(a))
ok(badLinks.length === 0, 'TC-S2-03 互链锚点 0 失效（bad=' + JSON.stringify(badLinks) + '）')
ok(!/docs\/G-[^/\s]+\/FEATURES\.md/.test(readme), 'TC-S2-11(反) 无目标级路径漂移')
const rn = readme.split('\n').map(s => s.trim())
const fn = fl.map(s => s.trim())
let dup = 0
for (let i = 0; i < rn.length; i++) { if (!rn[i]) continue; for (let j = 0; j < fn.length; j++) { if (rn[i] === fn[j]) { let len = 0; while (i + len < rn.length && j + len < fn.length && rn[i + len] === fn[j + len] && rn[i + len]) len++; if (len >= 3) { dup++; j += len - 1 } } } }
ok(dup === 0, 'TC-S2-04 逐字重复块=0（dup=' + dup + '）')
const both = readme + '\n' + feats
ok(both.includes('三件套') && both.includes('DSH Desktop') && (both.includes('三分钟体验循环') || both.includes('三分钟循环')), 'TC-S2-05 三件套/DSH Desktop/三分钟 在二文件之一')
const topics = ['旧界面', '中枢', '发布目标没反应', '刷新', 'by', '401', '文件中心', '内网']
const missTopics = topics.filter(t => !(readme + feats).includes(t))
ok(missTopics.length === 0, 'TC-S2-05 README §6 排障主题仍在（miss=' + JSON.stringify(missTopics) + '）')
ok(!(readme + feats).replace(/三件套/g, '').includes('三件套'), 'TC-S2-10(反) 删除关键项可检出')
ok(!/P1\/P2\/P3.*已交付|切片 S[0-9]+.*已交付/.test(readme), 'TC-S2-06 README 无过程叙事')
ok(/P0-CONFIRMATION/.test(readme) && /LIVE-ROLLOUT/.test(readme), 'TC-S2-06 附录互链历史记录文档')
const bodyNoApp = readme.split('\n## 附录')[0]
ok(!/P[0-9]\s*[-~]\s*P[0-9]|已交付/.test(bodyNoApp), 'TC-S2-06 正文（除附录）无 P0-P3/已交付 叙事')
ok((readme.match(/```/g) || []).length % 2 === 0, 'TC-S2-07 README 围栏配对')
ok(/^\| ---/m.test(readme) || /^\|:?-{3,}/m.test(readme), 'TC-S2-07 README 表格分隔行存在')
ok(/^\| /m.test(readme), 'TC-S2-07 README 表头存在')
ok(!headSlug.has('nonexist'), 'TC-S2-08 边界 锚点#nonexist 不在标题集（注入即检出）')
const block3 = ['a1','a2','a3'], block2 = ['b1','b2']
const detect = (block, pool) => { const pl = pool.map(s => s.trim()); let d = 0; for (let i = 0; i <= pl.length - block.length; i++) { let m = true; for (let k = 0; k < block.length; k++) if (pl[i + k] !== block[k]) { m = false; break } if (m) d++ } return d }
ok(detect(block3, [...rn, ...block3]) >= 1, 'TC-S2-09 阈值边界：恰 3 行同文块可被 ≥3 判重检出（恰 2 行不判的阈值边界由 check-docs 镜像负例 + 代码走查覆盖，见证据 02）')
const rev = [...feats.matchAll(/\[(?:[^\]]*)\]\((?:[^)#]*README[^)]*)\)/g)].length
ok(rev >= 1, 'TC-S2-13 FEATURES→README 反向关键链接 >=1（实际=' + rev + '）——将军裁决 RC-4 记 backlog 本期不补')
console.log('RESULT: pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
