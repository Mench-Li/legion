import { readFileSync } from 'node:fs';
const files = ['README.md','docs/FEATURES.md'];
for (const f of files) {
  const t = readFileSync(f,'utf8');
  const links = [...t.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)].map(m => ({text: m[1], target: m[2]}));
  console.log('== ' + f + ' == total links=' + links.length);
  for (const l of links) {
    const isAnchor = l.target.startsWith('#');
    const isLocalMd = /^[^#\s]+\.md(#.*)?$/.test(l.target.split('#')[0]) || /^[\w./-]+\.md(#.*)?$/.test(l.target.split('?')[0].split('#')[0]);
    if (isAnchor || /.md#/.test(l.target) || isLocalMd) console.log('  [local/anchor] ' + l.text + ' -> ' + l.target);
  }
}
