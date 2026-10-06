// workbench/scripts/sw-shell.test.mjs
// ============================================================================
// Service Worker 的预缓存清单**必须覆盖整个模块图**。
//
// 实测踩过：`refresh-loop.mjs` 是后加的一个模块，而 `sw.js` 的 `SHELL`
// 没跟着更新。静态资源走网络优先，所以第一次成功加载之后它自己会进缓存——
// **平时完全看不出来**。只有"装好 Service Worker 之后立刻离线"会露馅，
// 而那恰好是 PWA 最想守住的那一种情形。
//
//   > 一份"少了几个模块"的预缓存清单，与一份完整的清单，
//   > 在联网时是同一个东西——所以它只会坏在你最需要它的时候。
//
// 所以这条用例**从 index.html 顺着 import 走一遍**，而不是维护第二份手抄清单。
// ============================================================================
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MOBILE = resolve(ROOT, 'workbench', 'mobile')
const read = (rel) => readFileSync(resolve(MOBILE, rel), 'utf8')

/** 入口页引到的脚本 + 顺着静态 import 走出来的整张图。 */
function moduleGraph() {
  const entry = [...read('index.html').matchAll(/<script[^>]*src="\.\/([^"]+)"/g)].map((m) => m[1])
  assert.ok(entry.length > 0, 'index.html 里找不到入口脚本')
  const seen = new Set()
  const queue = [...entry]
  while (queue.length > 0) {
    const file = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)
    const src = read(file)
    // 只看**静态** import：`import('...')` 那种按需加载的模块不必预缓存
    // （它的失败面是"某个不常用的功能不可用"，而不是"壳打不开"）。
    for (const m of src.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?'\.\/([^']+)'/gm)) queue.push(m[1])
  }
  return { entry, all: seen }
}

/** 从 `sw.js` 里取 SHELL 清单。 */
function shellList() {
  const src = read('sw.js')
  const start = src.indexOf('const SHELL = [')
  assert.ok(start >= 0, 'sw.js 里找不到 SHELL')
  const end = src.indexOf(']', start)
  const body = src.slice(start, end)
  return [...body.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter((x) => x.length > 0)
}

describe('Service Worker 预缓存清单', () => {
  test('★ 清单覆盖整张模块图（少一个，离线时那个模块就 404）', () => {
    const { all } = moduleGraph()
    const shell = new Set(shellList())
    const missing = [...all].filter((f) => !shell.has(f))
    assert.deepEqual(missing, [],
      `这些模块在 index.html 的 import 图里，但没进 SHELL：${missing.join('、')}\n` +
      '缺了它们，装好 SW 之后立刻离线会打不开页面——而那正是 PWA 要守的场景。')
  })

  test('清单里的每一项都真的存在（写错名字等于没预缓存）', () => {
    for (const file of shellList()) {
      assert.ok(existsSync(resolve(MOBILE, file)), `SHELL 里的 ./${file} 不存在`)
    }
  })

  test('入口页自己也在清单里', () => {
    assert.ok(shellList().includes('index.html'))
  })

  test('反向锚：清单不是靠"多写几个"蒙对的', () => {
    // 如果哪天有人把 SHELL 写成"整个目录"，这条会提醒他——预缓存一份
    // 测试文件或图标构建脚本没有意义，而且会随目录增长而失控。
    const { all } = moduleGraph()
    const shell = shellList()
    assert.ok(shell.length <= all.size + 3,
      `SHELL 有 ${shell.length} 项而模块图只有 ${all.size} 个——它不该包含测试与构建脚本`)
    assert.ok(shell.every((f) => !/\.test\.mjs$|make-icons/.test(f)), 'SHELL 里不该有测试或构建脚本')
  })

  test('代码走网络优先、图标走缓存优先（否则发新版手机永远拿不到新代码）', () => {
    const src = read('sw.js')
    assert.match(src, /CODE_EXT\.test\(url\.pathname\) \? networkFirst\(event\) : cacheFirst\(event\)/)
  })

  test('API 与 Node 升级一律不拦（缓存住的 API 会让"离线"与"旧响应"分不开）', () => {
    const src = read('sw.js')
    assert.match(src, /url\.pathname\.startsWith\('\/api\/'\) \|\| url\.pathname === '\/node'/)
  })
})
