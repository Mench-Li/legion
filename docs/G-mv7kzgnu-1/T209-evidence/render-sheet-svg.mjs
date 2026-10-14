// docs/G-mv7kzgnu-1/T209-evidence/render-sheet-svg.mjs
// E2E-8：把 s11..s15 五个位面（+ 回退样本）用移动端渲染器导出为 SVG / JSON / 拼版 SVG。
// 移动端 renderAvatar 与桌面 slots.ts 由 avatar-parity.test.mjs 逐 key 锁死 ⇒ 渲的就是桌面会显示的那一个。
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderAvatar, resolveSlot, slotKeys } from '../../../workbench/mobile/avatar.mjs'

const ROOT = process.cwd()
const outDir = resolve(ROOT, 'docs/G-mv7kzgnu-1/T209-evidence')
const KEYS = ['s11', 's12', 's13', 's14', 's15']
const FALLBACK_TOKENS = ['', 'human:general', 'human:UNKNOWN', '\u2699\uFE0F']
const size = 120
const cellW = size + 24
const labelH = 26

const cells = KEYS.map((k) => ({ key: k, svg: renderAvatar('human:' + k, size), resolved: resolveSlot('human:' + k) }))
const fallback = FALLBACK_TOKENS.map((t) => ({ token: t, svg: renderAvatar(t, size) }))

// 机器判据：两两不同（渲染字符串 / 位面字段）
const report = {
  keys: KEYS,
  slotKeysHas: KEYS.map((k) => slotKeys().includes(k)),
  distinctSvg: new Set(cells.map((c) => c.svg)).size,
  distinctFields: new Set(cells.map((c) => JSON.stringify(c.resolved))).size,
  resolved: cells.map((c) => ({ key: c.resolved && c.resolved.key, skin: c.resolved && c.resolved.skin, hair: c.resolved && c.resolved.hair, top: c.resolved && c.resolved.top, background: c.resolved && c.resolved.background })),
  fallbackDistinctSvg: new Set(fallback.map((f) => f.svg)).size,
  fallbackTokens: FALLBACK_TOKENS,
}
writeFileSync(resolve(outDir, 'avatar-svgs.json'), JSON.stringify({ cells, fallback, report }, null, 2), 'utf8')
console.log(JSON.stringify(report, null, 2))

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const W = 16 * 2 + KEYS.length * cellW
const H = 40 + size + labelH + 44 + size + 70
let out = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">'
out += '<rect width="100%" height="100%" fill="#f5f6f8"/>'
out += '<text x="16" y="24" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="15" fill="#1d2430">T-209 / E2E-8 外部执行者头像对照图（s11..s15）</text>'
cells.forEach((c, i) => {
  const x = 16 + i * cellW, y = 40
  out += '<g transform="translate(' + x + ',' + y + ')">' + c.svg + '</g>'
  out += '<text x="' + (x + size / 2) + '" y="' + (y + size + 20) + '" text-anchor="middle" font-family="Consolas, monospace" font-size="13" fill="#35414f">' + c.key + '</text>'
})
const y2 = 40 + size + labelH + 44
out += '<text x="16" y="' + (y2 - 16) + '" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="14" fill="#b4531f">回退样本（非法/缺失/旧 emoji 令牌 ⇒ 占位人形）</text>'
fallback.forEach((c, i) => {
  const x = 16 + i * cellW, y = y2
  out += '<g transform="translate(' + x + ',' + y + ')">' + c.svg + '</g>'
  out += '<text x="' + (x + size / 2) + '" y="' + (y + size + 18) + '" text-anchor="middle" font-family="Consolas, monospace" font-size="11" fill="#66748a">' + esc(JSON.stringify(c.token)) + '</text>'
})
out += '</svg>'
writeFileSync(resolve(outDir, 'avatar-sheet-s11-s15.svg'), out, 'utf8')
