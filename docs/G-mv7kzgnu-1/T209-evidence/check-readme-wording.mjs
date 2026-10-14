// docs/G-mv7kzgnu-1/T209-evidence/check-readme-wording.mjs
// TC-S5-04/05 的机械判据（与 TEST_CASES.md §4.5 同口径）：
//   ① workbench/README.md 不得再把「零图片资源」当现状（该说法自 2026-10-13 起已过期）；
//   ② 不得把齿轮 emoji 当作「… · 执行中」外部条目的**现状**描述。
//   注意「不再是齿轮 emoji / 灰阶占位」是**新**口径的正确说法，不算旧口径。
import { readFileSync } from 'node:fs'
const s = readFileSync('workbench/README.md', 'utf8')
const bad1 = s.includes('零图片资源')
const bad2 = /\u2699\uFE0F[^。\n]{0,20}执行中/.test(s)
if (bad1 || bad2) {
  console.error('FAIL 旧口径仍在：零图片资源=' + bad1 + ' 齿轮emoji+执行中=' + bad2)
  process.exit(1)
}
console.log('PASS 文档口径已同步（零图片资源=0，⚙️…执行中=0）')
