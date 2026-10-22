// workbench/mobile/mobile-layout.test.mjs
// ============================================================================
// 移动端**界面契约**：那些"在手机上才看得出来"的规则，逐条钉在源码上。
//
// ⚠ 这不是像素级验证，也不能替代真机/设备仿真。它守的是另一类错：
//   **一条本来正确的规则被悄悄删掉**（改 CSS 时顺手覆盖、合并时丢了一段媒体查询）。
//   这类错在真机上表现为"某一种屏幕坏了"，而在 CI 里什么都不报。
//
//   设备级证据在 `scripts/qa/mobile-ui-check.mjs`（真 Chrome + 真触屏事件）；
//   本文件与它是两层，不是二选一：
//     · 这里问"规则还在不在"（毫秒级、无浏览器依赖）；
//     · 那里问"规则真的生效了吗"（需要本机有 Edge/Chrome）。
//
//   > 一批"读源码找规则"的判据，与一批"真的在设备上量"的判据，
//   > 在没人删规则的时候是同一个东西 ——
//   > 只不过前者在浏览器跑不起来的环境里仍然能保护你。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (f) => readFileSync(join(HERE, f), 'utf8')
const HTML = read('index.html')
const CSS = /<style>[\s\S]*?<\/style>/.exec(HTML)?.[0] ?? ''
const MANIFEST = JSON.parse(read('manifest.webmanifest'))
const SW = read('sw.js')

// ── 视口与缩放（R-03 / AC-03）──────────────────────────────────────────────

test('★★★ viewport 带 viewport-fit=cover，但**不锁缩放**', () => {
  const meta = /<meta name="viewport" content="([^"]+)"/.exec(HTML)?.[1] ?? ''
  assert.match(meta, /viewport-fit=cover/, '刘海屏两侧的安全区靠它')
  // ★ 锁缩放会让"看不清的人"永远看不清 —— 防 iOS 聚焦缩放要靠 16px 输入字号。
  assert.doesNotMatch(meta, /maximum-scale|user-scalable\s*=\s*no/)
  assert.match(meta, /interactive-widget=resizes-content/, '键盘弹出时布局视口要跟着缩（Android 那一半）')
})

test('★★★ 输入框字号 16px（iOS 聚焦不缩放的分界线）', () => {
  assert.match(CSS, /input, textarea, select \{[^}]*font-size: 16px/, '输入控件必须 16px 起')
})

// ── 安全区（R-02 / AC-02）──────────────────────────────────────────────────

test('★★★ 四边安全区都进了令牌：top / bottom / **left / right**', () => {
  for (const side of ['top', 'bottom', 'left', 'right']) {
    assert.match(CSS, new RegExp(`--safe-${side}: env\\(safe-area-inset-${side}`), `缺 --safe-${side}`)
  }
  // 顶部与底部真的被用上了（只是定义变量不算）。
  assert.match(CSS, /header \{[^}]*padding: calc\(var\(--safe-top\)/, '顶栏要吃掉刘海')
  assert.match(CSS, /footer \{[^}]*calc\(var\(--safe-bottom\)/, '底栏要让开 Home Indicator')
  // 横屏时左右不能被圆角裁切。
  assert.match(CSS, /--safe-left\) \+ \d+px\)/, '左右安全区要参与水平内边距')
})

test('★★ 动态视口：高度用 dvh/视觉视口变量，不是写死 100%', () => {
  assert.match(CSS, /height:\s*var\(--vvh, 100dvh\)/, 'body 高度要跟视觉视口走')
  assert.match(CSS, /--kb-h/, '软键盘高度要能驱动浮层上移')
})

// ── 触控目标（R-04 / AC-04）─────────────────────────────────────────────────

test('★★★ 命中区令牌 = 44px，且控件基线用它', () => {
  assert.match(CSS, /--tap:\s*44px/)
  for (const sel of ['button', 'input, textarea, select']) {
    const re = new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*min-height: var\\(--tap\\)`)
    assert.match(CSS, re, `${sel} 的 min-height 应当是 var(--tap)`)
  }
})

test('★★ 头部图标按钮与页签也至少 44px 高（此前是 32/38）', () => {
  assert.match(CSS, /header \.icon-btn \{[^}]*min-height: var\(--tap\)/)
  assert.match(CSS, /#tabs button \{[^}]*min-height: var\(--tap\)/)
})

test('★★★ 相邻可点目标之间的最小间距 ≥ 8px（R-04 / AC-04）', () => {
  const gap = Number(/--gap-1:\s*(\d+)px/.exec(CSS)?.[1] ?? 0)
  assert.ok(gap >= 8, `--gap-1=${gap}px，相邻命中区会挨得太近`)
  // 页签此前是 2px：两个整宽的段几乎贴在一起，误触相邻页签的代价是"换了一整页"。
  assert.match(CSS, /#tabs \{[^}]*gap: var\(--gap-1\)/)
  // 头部一排图标按钮、意图条、视角 chip、成员药丸条都用同一档间距。
  for (const sel of ['header \.row', '#intents', '#board-views', '\.agent-chips', '\.board-nav']) {
    assert.match(CSS, new RegExp(`${sel} \\{[^}]*gap: var\\(--gap-1\\)`), `${sel} 应当用 --gap-1`)
  }
})

// ── 看板分页与手势（R-05 / AC-05）──────────────────────────────────────────

test('★★★ 轨道用 transform 平移，且横向不产生滚动容器（否则 sticky 失效）', () => {
  assert.match(CSS, /#task-groups \{[^}]*overflow-x:\s*clip/, 'overflow-x 必须是 clip，不是 hidden')
  assert.match(CSS, /\.board-track \{[^}]*transform:\s*translate3d\(calc\(var\(--page/, '轨道按页平移')
  assert.match(CSS, /\.board-page \{[^}]*flex:\s*0 0 100%/, '一屏一列')
  assert.match(CSS, /\.col-head \{[^}]*position:\s*sticky/, '列头要粘住')
})

test('★★★ 纵向滚动优先：`touch-action: pan-y`（不抢纵向手势）', () => {
  assert.match(CSS, /#task-groups \{[^}]*touch-action:\s*pan-y/)
})

test('★★ 状态色是"颜色 + 文字"：tone 落到左边条，任务行照旧显示状态句', () => {
  assert.match(CSS, /\.task \{[^}]*border-left:\s*3px solid var\(--tone/)
  for (const tone of ['warn', 'busy', 'muted', 'ok']) {
    assert.match(CSS, new RegExp(`\\.task\\[data-tone="${tone}"\\]`), `缺 tone=${tone} 的映射`)
  }
})

test('★ 标题最多两行（320px 下不许把按钮挤走）', () => {
  assert.match(CSS, /\.task \.t \{[^}]*-webkit-line-clamp:\s*2/)
})

// ── 详情层（R-07 / AC-07）─────────────────────────────────────────────────

test('★★ 详情层是底部抽屉，且高度受视口约束（长内容内部滚动）', () => {
  assert.match(CSS, /#task-sheet \{[^}]*position:\s*fixed/)
  assert.match(CSS, /#task-sheet \.sheet \{[^}]*max-height:/)
  assert.match(CSS, /#sheet-body \{[^}]*overflow-y:\s*auto/)
})

// ── 动效与减少动态（R-10 / AC-10）──────────────────────────────────────────

test('★★★ 切页/抽屉时长落在 180–250ms，且 reduce 下**没有位移**', () => {
  assert.match(CSS, /--anim-ms:\s*220ms/)
  // 文件里有**多个** reduce 块（骨架一处、切页/抽屉一处）——全部收进来再断言，
  // 只取第一个会变成"检查了骨架却以为检查了切页"。
  const reduce = [...CSS.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)]
    .map((m) => m[1]).join('\n')
  assert.match(reduce, /\.board-track[^}]*transition:\s*none/, 'reduce 下切页不许有过渡')
  assert.match(reduce, /#task-sheet \.sheet \{[^}]*animation:\s*none/, 'reduce 下抽屉不许有动画')
})

// ── 可读宽度与平板（R-01/R-14 / AC-01/AC-14）──────────────────────────────

test('★★★ 底部输入区是**纵向**排列（否则意图条/下拉/输入行会并排成一行）', () => {
  // `body[data-screen="app"] #composer { display:flex }` 只给 display，
  // 方向默认为 row —— 不在 footer 上显式写 column，四行控件会挤在一行里。
  assert.match(CSS, /footer \{[^}]*flex-direction:\s*column/)
})

test('★★★ 768px 以上内容有**可读最大宽度**（不把手机布局放大到整屏）', () => {
  assert.match(CSS, /--content-max:\s*720px/)
  assert.match(CSS, /@media \(min-width: 768px\)/)
  assert.match(CSS, /main \{[^}]*max-width:\s*var\(--content-max\)/)
})

// ── 无障碍（R-11 / AC-11）──────────────────────────────────────────────────

test('★★ 焦点可见（不靠 outline:none 抹掉），且图标按钮有可访问名', () => {
  assert.match(CSS, /:focus-visible \{[^}]*outline:\s*2px solid var\(--accent\)/)
  for (const id of ['board-prev', 'board-next', 'sheet-close', 'btn-notify', 'btn-refresh', 'btn-logout']) {
    const tag = new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(HTML)?.[0] ?? ''
    assert.ok(tag.length > 0, `找不到 #${id}`)
    const text = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(HTML)?.[1]?.trim() ?? ''
    const hasName = /aria-label=/.test(tag) || text.length > 0
    assert.ok(hasName, `#${id} 既没有可访问名也没有可见文字`)
  }
  // 页码播报：读屏要能知道"现在在第几页"。
  assert.match(HTML, /id="page-indicator"[^>]*aria-live="polite"/)
})

// ── 设计令牌一致性（R-09 / AC-09）──────────────────────────────────────────

test('★★★ manifest 的 theme/background 与页面 meta、--bg **同一个颜色**', () => {
  const meta = /<meta name="theme-color" content="([^"]+)"/.exec(HTML)?.[1]
  const bg = /--bg:\s*(#[0-9a-fA-F]{6})/.exec(CSS)?.[1]
  assert.equal(MANIFEST.theme_color, meta, 'manifest.theme_color 与 meta theme-color 必须一致')
  assert.equal(MANIFEST.background_color, bg, 'manifest.background_color 与 --bg 必须一致')
  assert.equal(MANIFEST.theme_color, bg, '安装启动图不该闪另一种底色')
})

test('★ 对比度：12px 小字用局部可访问色（不动桌面令牌）', () => {
  assert.match(CSS, /--muted-2-a:\s*#[0-9a-fA-F]{6}/)
  // 原来那套 --muted-2 的值必须原样保留（桌面端也用它）。
  assert.match(CSS, /--muted-2:\s*#6b7a94/)
})

/** 取一个 CSS 变量的十六进制值。 */
const token = (name) => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(CSS)
  assert.ok(m !== null, `找不到令牌 --${name}`)
  return m[1]
}
/** WCAG 相对亮度与对比度（正文门槛 4.5:1）。 */
const luminance = (hex) => {
  const [r, g, b] = hex.replace('#', '').match(/../g).map((h) => parseInt(h, 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

test('★★★ 正文与次要文字的对比度真的达标（算出来，不是"看起来还行"）', () => {
  const bg = token('bg')
  const panel = token('panel')
  const panel2 = token('panel-2')
  for (const surface of [bg, panel, panel2]) {
    assert.ok(contrast(token('text'), surface) >= 4.5, `--text 对 ${surface} 不足 4.5:1`)
    assert.ok(contrast(token('muted'), surface) >= 4.5, `--muted 对 ${surface} 不足 4.5:1`)
  }
  // ★ 这就是引入 --muted-2-a 的理由：原来那支在 panel-2 上只有 4.0:1。
  for (const surface of [bg, panel, panel2]) {
    assert.ok(contrast(token('muted-2-a'), surface) >= 4.5,
      `--muted-2-a 对 ${surface} 不足 4.5:1（12px 小字会看不清）`)
  }
  // 反向锚：旧令牌**确实**不达标 —— 否则上面那条是多余的复杂度。
  assert.ok(contrast(token('muted-2'), panel2) < 4.5,
    '--muted-2 在 panel-2 上若已达标，就不该再引入一支移动端专色')
})

// ── PWA 壳（R-12 / AC-12）──────────────────────────────────────────────────

test('★★★ 新增模块进了 SW 预缓存清单，且缓存版本已提升', () => {
  assert.match(SW, /'\.\/interaction\.mjs'/, 'interaction.mjs 不在 SHELL 里 ⇒ 装好 SW 后断网打开会白屏')
  assert.match(SW, /const CACHE = 'legion-mobile-v5'/, '代码变了但版本没变 ⇒ 旧壳不会更新')
})

test('★ 入口页仍只有一个 module script，且没有引入任何第三方依赖', () => {
  const scripts = [...HTML.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(scripts, ['./app.mjs'], '不该引入第二个脚本/第三方库')
  assert.doesNotMatch(HTML, /<script[^>]*src="https?:/)
})
