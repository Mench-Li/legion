import { readFileSync } from 'node:fs';
// 轻量自检脚本（与权威校验 node scripts/ci/check-docs.mjs 逻辑一致；此处按 S1/S2 断言逐条输出 PASS/FAIL）。
const FEAT = 'docs/FEATURES.md';
const README = 'README.md';
const feats = readFileSync(FEAT, 'utf8');
const readme = readFileSync(README, 'utf8');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  [FAIL] ' + msg); } };

// GitHub 风格 slug（与 check-docs.mjs 一致，处理中文与符号）。
const slugify = s => s.toLowerCase()
  .replace(/[。，、：；！？“”‘’（）《》【】·…—±××]/g, '')
  .replace(/[^\w\u4e00-\u9faf\s-]/g, '')
  .trim()
  .replace(/\s+/g, '-');

const headLines = [...feats.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => ({ text: m[1].trim(), line: m.index }));
const headText = new Set(headLines.map(h => h.text));
const headSlug = new Set(headLines.map(h => slugify(h.text)));

console.log('== S1（docs/FEATURES.md 功能手册）==');
ok(feats.length > 0, 'S1-01 存在且为 Markdown');
ok(/功能使用介绍|使用手册/.test(feats), 'S1-02 标题含功能使用介绍/使用手册');
const cats = ['一句话定位', '面向读者', '快速开始', '模块章节', '功能索引', '故障排查与术语附录'];
for (const c of cats) ok(headLines.some(h => h.text.includes(c)), 'S1-03 类别章节: ' + c);
const rows = feats.split('\n').filter(l => /^F-[0-9]{2}/.test(l));
ok(rows.length >= 18, 'S1-04 索引行数=' + rows.length + ' (>=18)');
const badCols = rows.filter(r => r.split(String.fromCharCode(124)).map(s => s.trim()).filter(Boolean).length !== 5);
ok(badCols.length === 0, 'S1-04 0坏列 (badCols=' + badCols.length + ')');
const badAnchor = rows.filter(r => { const c = r.split(String.fromCharCode(124)).map(s => s.trim()); return !headText.has(c[2] || ''); });
ok(badAnchor.length === 0, 'S1-05 索引锚点0失效 (bad=' + badAnchor.length + ')');
let emptySections = 0, noKeyword = 0;
for (const row of rows) {
  const c = row.split(String.fromCharCode(124)).map(s => s.trim());
  const idx = headLines.findIndex(h => h.text === c[2]);
  if (idx < 0) { emptySections++; continue; }
  const startLine = headLines[idx].line;
  const nextIdx = headLines.slice(idx + 1).find(h => h.line > startLine);
  const endLine = nextIdx ? nextIdx.line : feats.length;
  const body = feats.slice(startLine, endLine).split('\n').map(s => s.trim()).filter(Boolean).filter(l => !/^#{1,6}\s/.test(l));
  if (body.length < 5) { emptySections++; console.log('  [warn] section short: ' + c[2] + ' body=' + body.length); }
  if (!/入口|操作/.test(body.join(' '))) { noKeyword++; console.log('  [warn] no 入口/操作: ' + c[2]); }
}
ok(emptySections === 0, 'S1-06 每域小节>=5行 (empty=' + emptySections + ')');
ok(noKeyword === 0, 'S1-06 每域含入口/操作 (miss=' + noKeyword + ')');
const badStatus = rows.filter(r => !/已上线|迭代中|遗留/.test(r.split(String.fromCharCode(124)).pop()));
ok(badStatus.length === 0, 'S1-07 状态枚举合法 (bad=' + badStatus.length + ')');
ok(!/P1\/P2\/P3.*已交付|切片 S[0-9]+.*已交付/.test(feats), 'S1-07 手册无过程叙事');
ok(!/docs\/G-[^/]+\/FEATURES\.md/.test(feats), 'S1-15 手册无目标级路径书写');

console.log('== S2（README.md 收敛 + 互链去重）==');
ok(readme.length > 0, 'S2-01 README非空');
const links = [...readme.matchAll(/docs\/FEATURES\.md#([^\s)\]]+)/g)].map(m => m[1]);
ok(links.length >= 8, 'S2-02 互链数=' + links.length + ' (>=8)');
const badLinks = [...new Set(links)].filter(a => !headSlug.has(a));
ok(badLinks.length === 0, 'S2-03 互链锚点0失效 (bad=' + JSON.stringify(badLinks) + ')');
const rn = readme.split('\n').map(s => s.trim());
const fn = feats.split('\n').map(s => s.trim());
let dup = 0;
for (let i = 0; i < rn.length; i++) { if (!rn[i]) continue; for (let j = 0; j < fn.length; j++) { if (rn[i] === fn[j]) { let len = 0; while (i + len < rn.length && j + len < fn.length && rn[i + len] === fn[j + len] && rn[i + len]) len++; if (len >= 3) { dup++; j += len - 1; } } } }
ok(dup === 0, 'S2-04 去重0块 (dup=' + dup + ')');
const both = readme + '\n' + feats;
for (const k of ['三件套', 'DSH Desktop', '三分钟体验循环']) ok(both.includes(k), 'S2-05 关键项: ' + k);
ok(!/P1\/P2\/P3.*已交付/.test(readme), 'S2-06 README无过程叙事(正文)');

console.log('== S3（check-docs.mjs 权威校验入口）==');
ok(true, 'S3 由 node scripts/ci/check-docs.mjs 权威校验（本脚本为 S1/S2 补充）');

console.log('RESULT: pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
