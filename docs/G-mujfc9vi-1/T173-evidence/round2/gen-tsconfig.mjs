// 生成 workbench tsc 的替代 tsconfig：把裸模块映射到主 checkout 的 pnpm 链接目录。
// 仅证据用，不改动被测源码，也不写入 .ci-main 以外的位置。
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = process.argv[2]
const NM = process.argv[3]
const OUT = process.argv[4]

const files = []
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(ts|tsx|mts)$/.test(e.name)) files.push(p)
  }
}
walk(SRC)

const bare = new Set()
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  const re = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(src))) {
    const spec = m[1]
    if (spec.startsWith('.') || spec.startsWith('/')) continue
    const seg = spec.split('/')
    const pkg = spec.startsWith('@') ? seg.slice(0, 2).join('/') : seg[0]
    bare.add(pkg)
  }
}

const paths = {}
const missing = []
for (const pkg of [...bare].sort()) {
  if (pkg === 'vite/client') { paths['vite/client'] = [NM + '/vite/client.d.ts']; continue }
  // 优先 @types/<pkg>（运行时包常无声明）；scoped 包名 @s/n → @types/s__n
  const typesName = pkg.startsWith('@') ? pkg.slice(1).replace('/', '__') : pkg
  const candidates = [NM + '/@types/' + typesName, NM + '/' + pkg]
  let dir = null
  for (const c of candidates) {
    try { if (statSync(c).isDirectory()) { dir = c; break } } catch { /* next */ }
  }
  if (dir === null) { missing.push(pkg); continue }
  paths[pkg] = [dir]
  paths[pkg + '/*'] = [dir + '/*']
}

// vite.config.ts 的裸导入也须映射（walk 只覆盖 src）
for (const extra of ['vite', '@vitejs/plugin-react']) {
  if (paths[extra] === undefined) {
    const dir = NM + '/' + extra
    try {
      if (statSync(dir).isDirectory()) {
        // package.json 只有 exports 条件导出，paths 直连目录时 bundler 解析不到声明，直接指向 d.ts
        const dts = dir + '/dist/index.d.ts'
        let target = dir
        try { if (statSync(dts).isFile()) target = dts } catch { /* keep dir */ }
        paths[extra] = [target]
        if (target === dir) paths[extra + '/*'] = [dir + '/*']
      }
    } catch { missing.push(extra) }
  }
}

const cfg = {
  _comment: 'T-173 round2 证据：workbench tsc --noEmit 的替代 tsconfig（本会话无 node_modules、沙箱禁 junction）。裸模块 paths 指向主 checkout 的 pnpm 链接目录；编译器选项与 workbench/tsconfig.json 等价。',
  compilerOptions: {
    target: 'ES2022', useDefineForClassFields: true,
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    module: 'ESNext', moduleResolution: 'bundler',
    allowImportingTsExtensions: true, resolveJsonModule: true, isolatedModules: true,
    noEmit: true, jsx: 'react-jsx', strict: true,
    noUnusedLocals: true, noUnusedParameters: true, noFallthroughCasesInSwitch: true,
    skipLibCheck: true, types: [], paths,
  },
  include: [
    SRC.replace(/\\/g, '/'),
    (SRC.replace(/\\/g, '/') + '/../vite.config.ts').replace('/src/..', ''),
    NM + '/vite/client.d.ts',
  ],
}
writeFileSync(OUT, JSON.stringify(cfg, null, 2))
console.log('files=' + files.length + ' bare=' + bare.size + ' mapped=' + Object.keys(paths).length + ' missing=' + JSON.stringify(missing))
