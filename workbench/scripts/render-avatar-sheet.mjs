// workbench/scripts/render-avatar-sheet.mjs
// ============================================================================
// 把**全部 40 个位面 + 占位**渲成一张对照图（HTML），供人**用眼睛**定稿画风。
//
//   node workbench/scripts/render-avatar-sheet.mjs                 # → workbench/data/avatar-sheet.html
//   node workbench/scripts/render-avatar-sheet.mjs --out=x.html    # 指定输出
//
// ## 为什么需要它（不是"顺手做个预览页"）
//
// 画风是这个仓库里**唯一**无法靠判据定稿的东西：`TC-S1-02` 只能断言"25 个头像两两不同"，
// 它**说不出**"像不像豆包"。而改画风的人（包括 AI）往往看不到自己改出来的图 ——
// 于是"改完了"与"改对了"之间没有任何东西把关。
//
//   > 一组能证明"每个头像都不一样"的用例，
//   > 与一组能证明"这些头像好不好看"的用例，区别不在用例写得够不够细，
//   > 而在**判据里能不能放下一双眼睛**。
//
// 所以这个脚本的产出物是**给人看的**：一张排好序、带 role 标签、并排铺开的对照图。
//
// ## 为什么用移动端渲染器来画
//
// `workbench/mobile/avatar.mjs` 的 `renderAvatar()` 输出**纯 SVG 字符串**（不需要 React），
// 而它与桌面的位面表由 `avatar-parity.test.mjs` 的 `TC-S6-01b` **逐 key 锁死**。
// 于是：用它能渲，而渲出来的就是桌面会显示的那一个（不会"预览一套、上线另一套"）。
// ============================================================================
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { slotKeys, renderAvatar, resolveSlot } from '../mobile/avatar.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** 解析命令行：`--out=…`、`--size=<像素>`、`--only=<key,key,…>`（只画这几个位面）。 */
export function parseArgs(argv = []) {
  const pick = (name) => {
    const hit = argv.find((a) => a.startsWith('--' + name + '='))
    return hit ? hit.slice(name.length + 3).trim() : null
  }
  const sizeRaw = Number(pick('size'))
  const only = (pick('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return {
    out: pick('out') || join(ROOT, 'workbench', 'data', 'avatar-sheet.html'),
    size: Number.isFinite(sizeRaw) && sizeRaw >= 16 && sizeRaw <= 400 ? Math.round(sizeRaw) : 96,
    only: only.length > 0 ? only : null,
  }
}

/** 造对照图的 HTML（纯字符串；无脚本、无外链，断开网络也能看）。 */
export function buildSheetHtml({ size = 96, only = null } = {}) {
  const all = slotKeys()
  const keys = only === null ? all : all.filter((k) => only.includes(k))
  const missing = only === null ? [] : only.filter((k) => !all.includes(k))
  const cell = (key, label) => {
    const token = 'human:' + key
    return `<figure class="cell">${renderAvatar(token, size)}<figcaption>${label}</figcaption></figure>`
  }
  const cells = keys.map((k) => ({ key: k, html: cell(k, k) }))
  const bad = ['', 'not-a-token', '\u{1F916}', 'human:UNKNOWN']
    .map((t, i) => cell('placeholder', 'bad#' + (i + 1) + ' ' + JSON.stringify(t)))
  const placeholder = `<figure class="cell">${renderAvatar('nope', size)}<figcaption>placeholder（回退）</figcaption></figure>`
  // ★ 按 **cell** 筛、不是按 key 筛：筛 `keys`（字符串）会把一堆 key 名直接 join 进 HTML，
  //   页面看起来"有标题、没头像"，而那一版我第一次就是这么写错的（预览页当场成了空页）。
  const builtin = cells.filter((c) => !/^s\d\d$/.test(c.key)).map((c) => c.html)
  const spares = cells.filter((c) => /^s\d\d$/.test(c.key)).map((c) => c.html)
  const section = (title, list) => (list.length === 0 ? '' : `<h2>${title}</h2>\n<div class="grid">${list.join('')}</div>`)
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>Legion 头像对照图（${keys.length} 个位面）</title>
<style>
  body { margin: 0; padding: 28px 32px 56px; background: #f5f6f8; color: #1d2430;
         font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.note { color: #5d6b7d; margin: 0 0 22px; font-size: 13px; }
  h2 { font-size: 15px; margin: 30px 0 12px; color: #35414f; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(${Math.max(124, size + 28)}px, 1fr)); gap: 16px; }
  .cell { margin: 0; background: #fff; border: 1px solid #e3e7ec; border-radius: 12px;
          padding: 12px 8px 10px; text-align: center; }
  .cell svg { border-radius: 22%; display: block; margin: 0 auto; }
  figcaption { margin-top: 8px; font-size: 11px; color: #66748a; word-break: break-all; }
  .hint { margin-top: 26px; font-size: 12px; color: #66748a; }
</style></head><body>
<h1>Legion 头像对照图 · ${keys.length} 个位面${only === null ? '' : '（已筛选）'}</h1>
<p class="note">由 <code>workbench/scripts/render-avatar-sheet.mjs</code> 生成；渲染器 = 移动端
<code>renderAvatar()</code>，与桌面位面表由 parity 判据逐 key 锁死 ⇒ 这就是桌面会显示的那一个。</p>
${missing.length > 0 ? `<p class="note" style="color:#b4531f">⚠ 这些 key 不在位面表里，已跳过：${missing.join(', ')}</p>` : ''}
${section('内置岗位', builtin)}
${section('备用位面（自建 / 空间专属 role）', spares)}
${only === null ? `<h2>回退：非法 / 缺失 / 旧 emoji 令牌</h2>\n<div class="grid">${placeholder}${bad.join('')}</div>` : ''}
<p class="hint">判据能守住的部分：<code>TC-S1-02</code> 25 个两两不同 · <code>TC-S1-03</code> 位面表单射且确定性 ·
<code>TC-S6-01b</code> 两端位面字段逐 key 相同 · <code>TC-S1-09</code> 零外链资源。
它们都说不出"像不像豆包"——那一条只能由这张图定稿。</p>
</body></html>
`
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false
if (isMain) {
  const { out, size, only } = parseArgs(process.argv.slice(2))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, buildSheetHtml({ size, only }), 'utf8')
  const keys = only === null ? slotKeys() : slotKeys().filter((k) => only.includes(k))
  console.log(`render-avatar-sheet: 已写出 ${out}`)
  console.log(`  ${keys.length} 个位面（尺寸 ${size}px）；位面表自检：${resolveSlot('human:coder') ? 'ok' : 'FAIL'}`)
}
