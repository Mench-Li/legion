// ui-contract.test.mjs — 前端静态契约（零依赖，不引入 jsdom/浏览器自动化）。
//
// 为什么需要：本切片（P3-1）新增了房间/角色界面，但环境无浏览器自动化，DOM 行为无法自动断言。
// 而「main.mjs 里的 id 与 index.html 不一致」这类漂移会让功能**静默失效**（getElementById 返回 null，
// 后续代码被 null 守卫吞掉，页面看起来正常但按钮不работа）。因此把可静态校验的部分锁进测试：
//   ① main.mjs 引用的每个 DOM id 都必须存在于 index.html
//   ② P3-1 房间/角色界面元素必须齐备（防止后来者误删）
//   ③ 浏览器侧 import 的共享模块必须存在于 packages/shared/src（否则 build 拷不到 → 运行时 404）
//   ④ 被 import 的共享模块不得在 build.mjs 的排除名单里（node-only 模块不得被前端引用）
//   ⑤ 房间/只读态用到的 CSS 类必须有样式定义（否则徽标/提示条不可见）
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..') // apps/web/test → whiteboard/
const PUB = join(WB, 'apps', 'web', 'public')
const read = (p) => readFileSync(p, 'utf8')

const html = read(join(PUB, 'index.html'))
const css = read(join(PUB, 'styles.css'))
const jsDir = join(PUB, 'js')
const jsFiles = readdirSync(jsDir).filter((f) => f.endsWith('.mjs'))
const mainSrc = read(join(jsDir, 'main.mjs'))
const buildSrc = read(join(WB, 'scripts', 'build.mjs'))

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]))

describe('前端静态契约：DOM id 与共享模块接线', () => {
  it('main.mjs 引用的每个 DOM id 都存在于 index.html（防静默失效）', () => {
    const used = [...mainSrc.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1])
    assert.ok(used.length > 5, `应检出多个 id 引用，实际 ${used.length}`)
    const missing = [...new Set(used)].filter((id) => !htmlIds.has(id))
    assert.deepEqual(missing, [], `index.html 缺少这些 id（会导致对应功能静默失效）：${missing.join(', ')}`)
  })

  it('P3-1 房间/角色界面元素齐备（防止误删导致房间功能不可用）', () => {
    for (const id of ['room-input', 'room-go', 'room-copy', 'room-label', 'role', 'limit']) {
      assert.ok(htmlIds.has(id), `index.html 应包含 #${id}`)
    }
    // 这些 id 必须被 JS 真正接线（否则元素只是摆设）
    for (const id of ['room-input', 'room-go', 'room-copy']) {
      assert.match(mainSrc, new RegExp(`'${id}'`), `main.mjs 应引用 #${id}`)
    }
  })

  it('浏览器侧 import 的共享模块必须存在于 packages/shared/src（否则 build 拷不到）', () => {
    const imported = new Set()
    for (const f of jsFiles) {
      const src = read(join(jsDir, f))
      for (const m of src.matchAll(/from\s+'\.\.\/shared\/([\w.-]+\.mjs)'/g)) imported.add(m[1])
    }
    assert.ok(imported.size >= 2, `应检出共享模块 import，实际 ${imported.size}`)
    for (const name of imported) {
      assert.ok(existsSync(join(WB, 'packages', 'shared', 'src', name)),
        `packages/shared/src/${name} 不存在：浏览器侧会 404`)
    }
    // 关键：本切片新增的 room.mjs 必须在内
    assert.ok(imported.has('room.mjs'), '前端应引入共享房间模块 room.mjs')
  })

  it('被 import 的共享模块不得在 build.mjs 排除名单里（node-only 模块不得给前端用）', () => {
    const excluded = new Set([...buildSrc.matchAll(/'([\w.-]+\.mjs)'/g)].map((m) => m[1]))
    const imported = new Set()
    for (const f of jsFiles) {
      for (const m of read(join(jsDir, f)).matchAll(/from\s+'\.\.\/shared\/([\w.-]+\.mjs)'/g)) imported.add(m[1])
    }
    const bad = [...imported].filter((n) => excluded.has(n))
    assert.deepEqual(bad, [], `这些共享模块被 build 排除却仍被前端引用：${bad.join(', ')}`)
  })

  it('房间/只读态用到的 CSS 类都有样式定义（否则徽标与提示条不可见）', () => {
    for (const sel of ['.room-label', '.role', '.role.rw', '.role.ro', 'body.readonly', '.limit']) {
      assert.ok(css.includes(sel), `styles.css 缺少 ${sel} 的样式`)
    }
  })

  it('只读态在 HTML 与 JS 两侧的类名一致（JS 切 body.readonly，CSS 也按它写）', () => {
    assert.match(mainSrc, /classList\.(add|toggle)\('readonly'/, 'main.mjs 应切换 readonly 类')
    assert.ok(css.includes('body.readonly'), 'styles.css 应对 body.readonly 生效')
  })
})
