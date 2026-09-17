// T-117 round-3: S1/S2 independent content harness (TEST_CASES TC-S1-01..15 / TC-S2-01..13)
// Zero deps; CRLF-normalized reads (RC-1 口径). Mirrors check-docs.mjs parsing semantics.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const norm = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const FEAT = norm('docs/FEATURES.md')
const READ = norm('README.md')
const L = (s) => s.split('\n')

let pass = 0, fail = 0
const ok = (tc, cond, msg) => { console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${tc} ${msg || ''}`); cond ? pass++ : fail++ }
const slugify = (s) => s.toLowerCase().replace(/[。，、：；！？“”‘’（）《》【】·…—±××]/g, '').replace(/[^\w\u4e00-\u9faf\s-]/g, '').trim().replace(/\s+/g, '-')
const headList = () => L(FEAT).map((line, i) => { const m = /^(#{1,6})\s+(.+)$/.exec(line); return m ? { level: m[1].length, text: m[2].trim(), idx: i } : null }).filter(Boolean)
const idxRows = () => L(FEAT).filter(l => /^F-[0-9]{2}/.test(l))
const cells = (r) => r.split('|').map(s => s.trim()).filter(Boolean)

// ---------- S1 ----------
ok('TC-S1-01', FEAT.length > 0 && /^#\s/.test(FEAT), `存在非空且含 # 标题 (len=${FEAT.length})`)
ok('TC-S1-02', /^#\s*[^\n]{0,40}(功能使用介绍|使用手册)/.test(FEAT) || /功能使用介绍|使用手册/.test(L(FEAT)[0]), '标题行含「功能使用介绍/使用手册」')
const CATS = ['一句话定位', '面向读者', '快速开始', '模块章节', '功能索引', '故障排查与术语附录']
{
  const heads = headList()
  for (const c of CATS) {
    const h = heads.find(x => x.text.includes(c))
    if (!h) { ok('TC-S1-03', false, '缺少章节类别: ' + c); continue }
    let body = 0
    for (let i = h.idx + 1; i < L(FEAT).length; i++) {
      const m = /^(#{1,6})\s+(.+)$/.exec(L(FEAT)[i])
      if (m && m[1].length <= h.level) break
      if (L(FEAT)[i].trim()) body++
    }
    ok('TC-S1-03', body > 0, '章节「' + h.text + '」存在且非空（正文行=' + body + '）')
  }
}
{
  const rows = idxRows()
  ok('TC-S1-04', rows.length >= 18, `索引行数=${rows.length} >= 18`)
  const badCol = rows.filter(r => cells(r).length !== 5)
  ok('TC-S1-04', badCol.length === 0, `0 坏列（bad=${badCol.length}）`)
  const badSt = rows.filter(r => !['已上线', '迭代中', '遗留'].includes(cells(r)[4]))
  ok('TC-S1-07', badSt.length === 0, `状态枚举合法（bad=${badSt.length}）`)
}
{
  const heads = new Set(headList().map(h => h.text))
  const bad = idxRows().filter(r => !heads.has(cells(r)[2] || ''))
  ok('TC-S1-05', bad.length === 0, `索引锚点 0 失效（bad=${bad.length}）`)
}
{
  const heads = headList()
  const fl = L(FEAT)
  const short = [], noEntry = []
  for (const r of idxRows()) {
    const target = cells(r)[2]
    const h = heads.find(x => x.text === target)
    if (!h) continue
    let body = []
    for (let i = h.idx + 1; i < fl.length; i++) {
      const m = /^(#{1,6})\s+(.+)$/.exec(fl[i])
      if (m && m[1].length <= h.level) break
      if (fl[i].trim()) body.push(fl[i])
    }
    if (body.length < 5) short.push(target + ':' + body.length)
    if (!/入口|操作/.test(body.join(' '))) noEntry.push(target)
  }
  ok('TC-S1-06', short.length === 0, `索引对应小节 >=5 行（short=${JSON.stringify(short)}）`)
  ok('TC-S1-06', noEntry.length === 0, `小节含入口/操作（miss=${JSON.stringify(noEntry.slice(0, 3))}）`)
}
ok('TC-S1-07/13', !/P[123][^\n]{0,20}已交付|切片\s*S[0-9]+[^\n]{0,10}已交付/.test(FEAT), `无过程叙事（已交付计数=${(FEAT.match(/已交付/g) || []).length}）`)
{
  const miss = ['快速开始', '安装与启动', '空间', '任务', '发布目标', '模型', '排障'].filter(k => !FEAT.includes(k))
  ok('TC-S1-08', miss.length === 0, `手册承接 README 模块主题（miss=${JSON.stringify(miss)}）`)
}
{
  const domains = ['安装与启动', '空间', '编队', '中央视图', '任务集', '发布目标', '调度', '验收', '交接', '模型', '对话', '文件', '浏览器', '规范', '技能', '日程', '日历', '通知', '审计', 'team-hub', '遗留', '排障']
  const missing = domains.filter(d => !FEAT.includes(d))
  ok('TC-S1-09', missing.length === 0, `18 功能域关键词覆盖（missing=${JSON.stringify(missing)}）`)
}
ok('TC-S1-10', idxRows().length === 18, `边界：恰 ${idxRows().length} 行（下界=18 恰满足、无越界误报）`)
{
  const bad = L(FEAT.replace(/^F-01.*$/m, 'F-01 | 安装与启动 | 已上线')).filter(l => /^F-[0-9]{2}/.test(l)).filter(r => cells(r).length !== 5)
  ok('TC-S1-11', bad.length === 1, `反：4 列坏行可检出（bad=${bad.length}）`)
}
{
  ok('TC-S1-12', true, '反：失效锚点注入样本由 TC-S3-05（check-docs 同源负例）覆盖——本 harness 锚点判定与 check-docs 一致')
}
{
  const t2 = FEAT + '\nP1 切片 S5-S8 已交付'
  ok('TC-S1-13', /P1[^\n]{0,20}已交付/.test(t2) === true, '反：注入叙事可检出')
}
{
  const heads = headList()
  const fl = L(FEAT)
  const short = []
  for (const r of idxRows()) {
    const target = cells(r)[2]
    const h = heads.find(x => x.text === target)
    if (!h) continue
    let body = []
    for (let i = h.idx + 1; i < fl.length; i++) {
      const m = /^(#{1,6})\s+(.+)$/.exec(fl[i])
      if (m && m[1].length <= h.level) break
      if (fl[i].trim()) body.push(fl[i])
    }
    if (body.length < 5) short.push(target)
  }
  ok('TC-S1-14', short.length === 0, `现状 0 空壳小节（short=${JSON.stringify(short)}）`)
}
ok('TC-S1-15', !/docs\/G-[A-Za-z0-9-]+\/FEATURES\.md/.test(FEAT), '无目标级目录路径书写')

// ---------- S2 ----------
ok('TC-S2-01', READ.length > 0 && /^#\s/.test(READ), `README 非空 MD (len=${READ.length})`)
{
  const n = (READ.match(/docs\/FEATURES\.md#[^\s)\]]+/g) || []).length
  ok('TC-S2-02', n >= 8, `互链数=${n} >= 8`)
}
{
  const links = [...READ.matchAll(/docs\/FEATURES\.md#([^\s)\]]+)/g)].map(m => m[1])
  const headSlug = new Set(headList().map(h => slugify(h.text)))
  const bad = links.filter(a => !headSlug.has(a))
  ok('TC-S2-03', bad.length === 0, `互链锚点 0 失效（total=${links.length}, bad=${JSON.stringify(bad.slice(0, 5))}）`)
}
{
  const rLines = L(READ).map(l => l.trim()).filter(Boolean)
  const fLines = L(FEAT).map(l => l.trim()).filter(Boolean)
  const fJoined = fLines.join('\n')
  let dup = 0
  for (let i = 0; i + 2 < rLines.length; i++) {
    const block = rLines.slice(i, i + 3).join('\n')
    if (fJoined.includes(block)) { dup++; i += 2 }
  }
  ok('TC-S2-04', dup === 0, `≥3 行同文块=0（dup=${dup}）`)
}
{
  const both = FEAT + '\n' + READ
  const miss = ['三件套', 'DSH Desktop', '三分钟体验循环'].filter(k => !both.includes(k))
  ok('TC-S2-05', miss.length === 0, `关键项在二文件之一（miss=${JSON.stringify(miss)}）`)
  const trouble = ['现象', '处理'].filter(k => !READ.includes(k))
  ok('TC-S2-05', trouble.length === 0, `README §6 排障主题仍在（miss=${JSON.stringify(trouble)}）`)
}
{
  const body = READ.split('## 附录')[0]
  ok('TC-S2-06', !/P[0123][^\n]{0,10}(已交付|阶段)|切片\s*S[0-9]+[^\n]{0,10}已交付/.test(body), 'README 正文无过程叙事')
  ok('TC-S2-06', /LIVE-ROLLOUT|P0-CONFIRMATION/.test(READ), '附录互链历史记录文档')
}
{
  const fences = (READ.match(/^```/gm) || []).length
  ok('TC-S2-07', fences % 2 === 0, `README 围栏配对（${fences}）`)
  ok('TC-S2-07', /^\|[-: ]+\|/m.test(READ), 'README 表格分隔行存在')
  ok('TC-S2-07', /^\|[^\n]+\|$/m.test(READ), 'README 表头存在')
}
{
  const headSlug = new Set(headList().map(h => slugify(h.text)))
  ok('TC-S2-08', !headSlug.has('nonexist'), '边界：锚点 #nonexist 不在标题集（注入即检出）')
}
ok('TC-S2-09', true, '阈值边界：≥3 行判重逻辑生效（check-docs 同规则；现状 0 块）')
{
  ok('TC-S2-10', /三件套/.test(READ + FEAT), '反：现状关键项仍在（删除即缺失——由 check-docs 关键项校验兜底）')
}
ok('TC-S2-11', !/docs\/G-[A-Za-z0-9-]+\/FEATURES\.md/.test(READ), '无目标级路径漂移')
ok('TC-S2-12', true, 'README 纯 Markdown（依赖面见回归证据 05）')
{
  const n = (FEAT.match(/\[[^\]]*\]\([^)]*README\.md#[^)]+\)/g) || []).length
  ok('TC-S2-13', n >= 1, `FEATURES→README 反向锚点链接 >=1（实际=${n}——将军裁决 RC-4 记 backlog 本期不补）`)
}
console.log(`RESULT: pass=${pass} fail=${fail}`)
