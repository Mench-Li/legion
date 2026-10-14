// docs/G-mv7kzgnu-1/T209-evidence/render-agentavatar-frozen.mjs
// TC-S3-11 / TC-S4-04 的桌面组件级补测：以 5 个冻结令牌 + 空串 + 非法令牌渲染 <AgentAvatar>，
// 断言「渲染成图形节点 / 文本节点为空 / 无 emoji 回退 / 5 个令牌两两不同」。
//
// 载入方式与 workbench/scripts/agent-avatar.test.mjs 完全一致（ts.transpileModule 零新增依赖）；
// 转译产物必须写进 workbench/scripts/ 才能让 `react/jsx-runtime` 裸标识符解析到 workbench/node_modules，
// 运行结束后在 finally 里逐一删除（不留未跟踪文件）。
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..', '..')
const SRC = join(ROOT, 'workbench', 'src', 'avatar')
const STAGE = join(ROOT, 'workbench', 'scripts')
const req = createRequire(join(ROOT, 'workbench', 'package.json'))
const ts = req('typescript')

const files = {
  slots: join(STAGE, '.t209-slots.mjs'),
  photos: join(STAGE, '.t209-photos.mjs'),
  ext: join(STAGE, '.t209-external-agents.mjs'),
  comp: join(STAGE, '.t209-agentavatar.mjs'),
}

function transpile(from, to, rewrite) {
  const out = ts.transpileModule(readFileSync(from, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  })
  let code = out.outputText
  if (rewrite) {
    code = code
      .replace(/['"]\.\/slots['"]/g, "'./.t209-slots.mjs'")
      .replace(/['"]\.\/photo-assets['"]/g, "'./.t209-photos.mjs'")
  }
  writeFileSync(to, code, 'utf8')
}

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u
const FROZEN = { general: 'human:s11', 'soldier-a': 'human:s12', 'soldier-b': 'human:s13', 'soldier-auto': 'human:s14', 'soldier-market': 'human:s15' }

let report = null
let code = 0
try {
  transpile(join(SRC, 'slots.ts'), files.slots, false)
  transpile(join(SRC, 'photo-assets.ts'), files.photos, false)
  transpile(join(SRC, 'external-agents.ts'), files.ext, true)
  transpile(join(SRC, 'AgentAvatar.tsx'), files.comp, true)

  const react = req('react')
  const { renderToString } = req('react-dom/server')
  const AgentAvatar = (await import(pathToFileURL(files.comp).href)).default
  const EXT = (await import(pathToFileURL(files.ext).href))
  const render = (token, extra) => renderToString(react.createElement(AgentAvatar, Object.assign({ token }, extra || {})))
  const isGraphic = (h) => h.includes('<svg') || h.includes('<img')
  const textOf = (h) => h.replace(/<[^>]*>/g, '').trim()
  const noDataUri = (h) => !/src="data:|src="http|src="\/\//.test(h)

  const rows = []
  for (const [name, token] of Object.entries(FROZEN)) {
    const html = render(token, { name: '析言' })
    rows.push({ name, token, graphic: isGraphic(html), svg: html.includes('<svg'), img: html.includes('<img'), text: textOf(html), emoji: EMOJI_RE.test(textOf(html)), src: (/src="([^"]+)"/.exec(html) || [])[1] ?? null, html })
  }
  const fallbackTokens = ['', 'human:general', '\u2699\uFE0F', 'human:UNKNOWN']
  const fb = fallbackTokens.map((t) => {
    const html = render(t, { name: '析言' })
    return { token: t, graphic: isGraphic(html), svg: html.includes('<svg'), img: html.includes('<img'), text: textOf(html), emoji: EMOJI_RE.test(textOf(html)), hasNameChar: html.includes('析') }
  })

  const checks = {
    'frozen 全部渲染图形': rows.every((r) => r.graphic),
    'frozen 全部无文本节点': rows.every((r) => r.text === ''),
    'frozen 全部无 emoji 文本': rows.every((r) => !r.emoji),
    'frozen 5 个渲染两两不同': new Set(rows.map((r) => r.html)).size === 5,
    'frozen 走矢量（s11..s15 无配图，无网络/破图面）': rows.every((r) => r.svg && !r.img),
    '空/非法令牌渲染占位图形': fb.every((r) => r.graphic),
    '空/非法令牌无文本 / 无 emoji / 不用 name 首字': fb.every((r) => r.text === '' && !r.emoji && !r.hasNameChar),
    '空/非法令牌落到同一占位人形': new Set(fb.map((r) => r.html)).size === 1,
    '无 data:/外链 src': rows.every((r) => noDataUri(r.html)) && fb.every((r) => noDataUri(r.html)),
    'externalAvatarToken 与冻结表一致': Object.entries(FROZEN).every(([n, t]) => EXT.externalAvatarToken(n) === t),
  }
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
  report = { checks, failed, rows: rows.map((r) => ({ name: r.name, token: r.token, svg: r.svg, img: r.img, text: r.text, src: r.src })), fallback: fb }
  console.log(JSON.stringify(report, null, 2))
  if (failed.length) code = 1
  console.log(failed.length === 0 ? 'render-agentavatar-frozen: PASS' : 'render-agentavatar-frozen: FAIL :: ' + failed.join(', '))
} finally {
  for (const f of Object.values(files)) { try { if (existsSync(f)) rmSync(f, { force: true }) } catch { /* 清理 */ } }
}
process.exit(code)
