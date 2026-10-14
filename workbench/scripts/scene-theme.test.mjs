// workbench/scripts/scene-theme.test.mjs
// 场景配色的**明度契约** —— "办公室要亮"这句话在这里变成一个可断言的不等式。
//
// 将军 2026-10-14：「办公室场景还是需要明亮的背景色」。
// 在此之前地板 `#15283a`、墙 `#1e3446`：关着灯的仓库。
//
// ★ 为什么用"相对亮度"而不是"看着挺浅的"：明度是可以算的（W3C 那条 sRGB 公式），
//   而"亮"这件事一旦只靠眼睛，下一个人加一个新预设时就会带进来一块暗色 ——
//   那时没有任何东西会响。这条判据把它钉成不等式。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCENE_BACKGROUND, SCENE_GROUND_BOUNCE, SCENE_THEMES } from '../src/scene/sceneTheme.ts'

/** sRGB 相对亮度（0=黑，1=白）：W3C WCAG 的算法，用在这里只是"哪个更亮"的客观尺子。 */
function luminance(hex) {
  const value = hex.replace('#', '')
  assert.equal(value.length, 6, `${hex} 必须是 #rrggbb`)
  const [r, g, b] = [0, 2, 4].map(index => {
    const channel = parseInt(value.slice(index, index + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const PRESETS = ['office', 'studio', 'lab', 'operations']

test('① 背景与墙必须"亮"：亮度 ≥ 0.62（这就是"明亮的背景色"的客观尺子）', () => {
  assert.ok(luminance(SCENE_BACKGROUND) >= 0.62, `场景背景 ${SCENE_BACKGROUND} 太暗（${luminance(SCENE_BACKGROUND).toFixed(3)}）`)
  for (const preset of PRESETS) {
    const theme = SCENE_THEMES[preset]
    assert.ok(luminance(theme.wall) >= 0.75, `${preset} 的墙 ${theme.wall} 不够亮`)
    assert.ok(luminance(theme.floor) >= 0.62, `${preset} 的地板 ${theme.floor} 不够亮`)
    assert.ok(luminance(theme.rug) >= 0.4, `${preset} 的地毯 ${theme.rug} 太暗（会像地上破了个洞）`)
    assert.ok(luminance(theme.metal) >= 0.35, `${preset} 的金属件 ${theme.metal} 太暗`)
    assert.ok(luminance(theme.desk) >= 0.4, `${preset} 的桌子 ${theme.desk} 太暗`)
  }
})

test('② 明度关系：地板 < 背景 < 墙（房间才立得起来，而不是一片白）', () => {
  const background = luminance(SCENE_BACKGROUND)
  for (const preset of PRESETS) {
    const theme = SCENE_THEMES[preset]
    assert.ok(luminance(theme.floor) < background, `${preset}：地板必须比背景略暗，否则看不出"地面"在哪`)
    assert.ok(luminance(theme.wall) > background, `${preset}：墙必须比背景亮，否则房间没有围合感`)
  }
})

test('③ 家具压在中低明度：必须**明显暗于墙**（否则白底上糊成一片）', () => {
  for (const preset of PRESETS) {
    const theme = SCENE_THEMES[preset]
    const wall = luminance(theme.wall)
    // 至少要有这几样"看得见的实体"比墙暗出一档
    for (const part of ['desk', 'wood', 'metal', 'plant']) {
      assert.ok(luminance(theme[part]) < wall - 0.12,
        `${preset} 的 ${part}（${theme[part]}）与墙（${theme.wall}）太接近，会看不见`)
    }
  }
})

test('④ 半球光的地面反弹色也必须是亮的（暗反弹色会让家具底面发脏）', () => {
  assert.ok(luminance(SCENE_GROUND_BOUNCE) >= 0.4, `地面反弹色 ${SCENE_GROUND_BOUNCE} 太暗`)
  assert.ok(luminance(SCENE_GROUND_BOUNCE) < luminance(SCENE_THEMES.office.wall), '反弹色仍应比墙暗（它是"地面"的颜色）')
})

test('⑤ 每个预设的色号都是合法的 #rrggbb（缺一个键会渲染成黑）', () => {
  const required = ['floor', 'desk', 'accent', 'light', 'wall', 'wallTrim', 'rug', 'plant', 'wood', 'glass', 'metal']
  for (const preset of PRESETS) {
    const theme = SCENE_THEMES[preset]
    for (const key of required) {
      assert.match(theme[key], /^#[0-9a-f]{6}$/i, `${preset}.${key} 不是合法色号`)
    }
    assert.ok(theme.label.length > 0)
  }
})
