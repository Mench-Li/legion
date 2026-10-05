import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as services from './index.js'

// Cordis 由**宿主提供**，不在本仓里。本检出能拿到它，只是因为 `plugins/node_modules/cordis`
// 是一条指向 DSH 安装目录的符号链接，而 `node_modules/` 是被 gitignore 的本地状态。
//
// 所以这条断言按**集成**用例对待：拿不到 Cordis 就**跳过并说明原因**，而不是变红。
// 原因不是"宽容"——原版把路径写死成 `../../dsh/deepseek-harness/vendor/cordis/lib/index.js`，
// 那条路径在**这台机器之外**（以及 clone 出来的任何地方）都不存在：一条会因"这台机器没装宿主"
// 而红的用例，与一条假红的用例是同一件事，都会让人开始忽略红色。
const here = dirname(fileURLToPath(import.meta.url))
const CANDIDATES = [
  join(here, '..', 'plugins', 'node_modules', 'cordis', 'lib', 'index.js'),
  join(here, '..', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
  join(here, '..', 'node_modules', 'cordis', 'lib', 'index.js'),
]

/** 取一份可用的 Cordis；一个都拿不到时返回 null（由用例自己 skip）。 */
async function loadCordis() {
  for (const path of CANDIDATES) {
    if (!existsSync(path)) continue
    try {
      return await import(pathToFileURL(path).href)
    } catch {
      // 这个位置存在但加载失败（版本不兼容等）→ 继续试下一个，全部失败才 skip。
    }
  }
  return null
}

test('Cordis 允许服务插件读到桌面宿主端口（inject: webServer）', async (t) => {
  const cordis = await loadCordis()
  if (cordis === null || typeof cordis.Context !== 'function') {
    t.skip('本机没有可用的 Cordis（宿主提供、未入库）——这条集成断言只在装了 DSH 宿主的机器上有意义')
    return
  }
  const { Context } = cordis

  // 场景：composition 挂起 webServer（桌面宿主就是这样把端口给出来的），
  // 而服务插件声明了 `inject = ['webServer']` ⇒ 它必须真的读得到 pluginCtx.webServer.port。
  // 这条守的是"声明缺失/写错时，注入侧会静默读到一个 undefined"这个失败形状。
  const ctx = new Context()
  const provider = await ctx.plugin({
    apply(providerCtx) { providerCtx.provide('webServer', { port: 19387 }) },
  })
  let address
  const fiber = await ctx.plugin({
    ...services,
    apply(pluginCtx) {
      address = services.deriveDshModelsBaseUrl({ webServerPort: pluginCtx.webServer.port })
    },
  })
  try {
    assert.equal(address, 'http://127.0.0.1:19387')
    assert.deepEqual(services.inject, ['webServer'], '插件必须声明它依赖 webServer，否则 Cordis 不会把端口交给它')
  } finally {
    await fiber.dispose()
    await provider.dispose()
  }
})
