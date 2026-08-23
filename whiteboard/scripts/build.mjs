// build.mjs — 零依赖构建：把 packages/shared 的浏览器安全模块拷贝到 apps/web/public/shared/。
// 排除依赖 node:crypto 的 hash.mjs 与聚合出口 index.mjs（前端不需要、也不可加载）。
// 运行：node scripts/build.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'packages', 'shared', 'src');
const dst = path.join(root, 'apps', 'web', 'public', 'shared');

const EXCLUDE = new Set(['hash.mjs', 'index.mjs']);

fs.mkdirSync(dst, { recursive: true });
const files = fs.readdirSync(src).filter((f) => f.endsWith('.mjs') && !EXCLUDE.has(f));
for (const f of files) fs.copyFileSync(path.join(src, f), path.join(dst, f));

console.log(`[build] copied ${files.length} shared modules -> apps/web/public/shared/`);
console.log(`[build] excluded (node-only): ${[...EXCLUDE].join(', ')}`);
