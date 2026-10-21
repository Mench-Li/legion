// workbench/scripts/agent-avatar.test.mjs — S1 头像基座：渲染/位面唯一/确定性/回退/离线门禁。
// 运行：node workbench/scripts/agent-avatar.test.mjs（沙箱 spawn 受限时直跑等效；宿主可 node --test）
// 载入方式：ts.transpileModule 直跑等效（同 doc-render.test.mjs，零新增依赖）；
// 转译产物写到本目录下，保证 `react/jsx-runtime` 能从 workbench/node_modules 解析。
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { renderToString } from 'react-dom/server'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const react = require('react')
const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'src', 'avatar')
const tmpSlots = join(here, '.agent-avatar.slots.mjs')
const tmpPhotos = join(here, '.agent-avatar.photos.mjs')
const tmpComponent = join(here, '.agent-avatar.render.mjs')

const ROLES = [
  'requirement', 'researcher', 'breaker', 'test-designer', 'coder', 'reviewer', 'tester', 'devops',
  'market-analyst', 'content-planner', 'ad-optimizer', 'growth-hacker', 'brand-copy',
  'product-manager', 'ux-designer', 'ui-designer', 'user-researcher', 'data-analyst',
  'ops-specialist', 'campaign-planner', 'support-lead', 'data-ops',
  'assistant', 'research-assistant', 'writer',
]
const SPARES = Array.from({ length: 15 }, (_, i) => 's' + String(i + 1).padStart(2, '0'))
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u

let AgentAvatar
let mod
let photos

function transpile(from, to, rewrite) {
  const out = ts.transpileModule(readFileSync(from, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  })
  if (out.diagnostics && out.diagnostics.length) throw new Error('transpile 诊断：' + JSON.stringify(out.diagnostics))
  let code = out.outputText
  // AgentAvatar 现在有两个相对 import（slots 与 photo-assets），两个都要指到临时产物上；
  // 少改一个的表现是 ERR_MODULE_NOT_FOUND —— 而 node:test 会把 10 条用例全报红，
  // 看起来像"头像全坏了"，其实是**测试脚手架**没跟上。
  if (rewrite) {
    code = code
      .replace(/['"]\.\/slots['"]/g, "'./.agent-avatar.slots.mjs'")
      .replace(/['"]\.\/photo-assets['"]/g, "'./.agent-avatar.photos.mjs'")
  }
  writeFileSync(to, code, 'utf8')
}

before(() => {
  transpile(join(SRC, 'slots.ts'), tmpSlots, false)
  transpile(join(SRC, 'photo-assets.ts'), tmpPhotos, false)
  transpile(join(SRC, 'AgentAvatar.tsx'), tmpComponent, true)
})
before(async () => {
  mod = await import(pathToFileURL(tmpSlots).href)
  photos = await import(pathToFileURL(tmpPhotos).href)
  AgentAvatar = (await import(pathToFileURL(tmpComponent).href)).default
})
after(() => {
  try { rmSync(tmpSlots, { force: true }) } catch { /* 清理 */ }
  try { rmSync(tmpPhotos, { force: true }) } catch { /* 清理 */ }
  try { rmSync(tmpComponent, { force: true }) } catch { /* 清理 */ }
})

const render = (token, extra) => renderToString(react.createElement(AgentAvatar, Object.assign({ token }, extra || {})))

/**
 * 去掉**整行注释**之后再断言（与 `no-classic-board.test.mjs` 的 `codeOnly` 同一手法）。
 *
 * ★ 2026-10-13：这一层是**补上**的，起因是一次真实的假红。
 *   `AgentAvatar.tsx` 的文件头要解释"为什么不能用 SVG 渐变"，于是正文里写出了判据
 *   禁掉的那个词（`url` 加左括号）—— 而本函数读的是**原始文本**，注释也算，
 *   于是**一条解释判据为什么存在的注释，把那条判据本身弄红了**。
 *
 *   本仓的 `no-classic-board.test.mjs` 早记过同一个坑并给了同一条解法：
 *
 *     > 注释里引用旧代码会让"源码里还有这个字符串"的判据**永远为假**。
 *
 *   只剥整行注释（`// …`、块注释续行 `* …`、`/* …`）：行尾注释里可能还有真代码，
 *   宁可少剥，不要剥错。扫描**代码**的两个用例（TC-S1-04/09）改用 `avatarCode()`；
 *   其余用例照旧读原始源码。
 */
function codeOnly(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
    })
    .join('\n')
}

const avatarSources = () => ['slots.ts', 'AgentAvatar.tsx', 'photo-assets.ts', 'index.ts', 'assets'].map(f => { try { return readFileSync(join(SRC, f), 'utf8') } catch { return '' } }).join('\n')
/** 剥掉注释后的源码 —— 「源码里不许出现某字符串」这类判据必须用它（见 `codeOnly`）。 */
const avatarCode = () => codeOnly(avatarSources())

describe('S1 头像基座', () => {
  // 头像有**两条来源**（配图 → `<img>`，没配图 → 内联 `<svg>`），所以"必须渲染什么"
  // 的断言要先分路。写死 `<svg` 会在配图那天全红 —— 而那并不是故障。
  const isGraphic = (html) => html.includes('<svg') || html.includes('<img')
  /** 本仓资产表里配了图的 key —— 直接读**转译后的真模块**，不拿正则去啃 TS 源。 */
  const photoKeys = () => Object.keys(photos.AVATAR_PHOTOS)

  test('TC-S1-01 两条来源都渲染成"图形"且都没有文本节点（AC-R3-1）', () => {
    // ① 配了图的 key → `<img>`（用户提供的写真头像）
    const withPhoto = render('human:coder')
    assert.ok(withPhoto.includes('<img'), '配了图的位面必须走 <img>')
    assert.equal(withPhoto.replace(/<[^>]*>/g, '').trim(), '', '不得有文本节点（emoji/首字）')
    // ② 没配图的 key → 内联 `<svg>`（矢量人形）
    //
    // ★ 这一格原来是**写死 `s10`** 的（"`s10` 就是这种"）。2026-10-14 将军补图时
    //   s10（ozon 寻源参谋）配上了照片，这条断言随即变红 —— 而它不是故障，
    //   正是本 describe 开头那句警告说的那件事：「写死会在配图那天全红」。
    //   所以改成**从资产表里现找**一个没配图的位面：只要还有没配图的 key 就照常测这条回退，
    //   一个都不剩时明说"没有可测的 key"，而不是留一条**恒假**的断言在那里。
    const withoutPhotoKey = [...ROLES, ...SPARES].find(k => !photoKeys().includes(k))
    if (withoutPhotoKey === undefined) {
      // 全部位面都配了图 ⇒ 这条回退路径在**资产表**上已经没有入口了。
      // 但代码里那条回退仍在（非法令牌会走到它），下一格 ③ 仍然守着它。
      console.log('  注：资产表已覆盖全部位面，② 的"没配图"分支改用 ③ 的非法令牌来守')
    } else {
      const withoutPhoto = render('human:' + withoutPhotoKey)
      assert.ok(withoutPhoto.includes('<svg'), `没配图的位面（${withoutPhotoKey}）必须回落内联 SVG`)
      assert.ok(!withoutPhoto.includes('<img'), '没配图时不许出现 <img（那会是一张破图）')
      assert.equal(withoutPhoto.replace(/<[^>]*>/g, '').trim(), '', '不得有文本节点（emoji/首字）')
    }
    // ③ 非法/缺失令牌 → 占位矢量（不是图片）
    const placeholder = render('human:UNKNOWN')
    assert.ok(placeholder.includes('<svg'), '未知令牌必须回落占位矢量人形')
  })

  test('TC-S1-02 25 个岗位头像两两不同（AC-R3-3）', () => {
    const marks = ROLES.map(r => render('human:' + r))
    for (const [i, m] of marks.entries()) assert.ok(isGraphic(m), ROLES[i] + ' 必须渲染成图形')
    assert.equal(new Set(marks).size, ROLES.length, '25 个岗位头像必须两两不同')
  })

  test('★ TC-S1-02b 配了图的 key 一定渲染 <img> 且 src 是同源相对路径（不是外链）', () => {
    const keys = photoKeys()
    assert.ok(keys.length > 0, '资产表不该是空的')
    for (const k of keys) {
      const html = render('human:' + k)
      assert.ok(html.includes('<img'), k + ' 配了图却没走 <img>')
      const src = (/src="([^"]+)"/.exec(html) || [])[1] ?? ''
      assert.ok(src.startsWith('./avatars/'), k + ' 的 src 必须是同源相对路径：' + src)
      assert.ok(!/^https?:|^\/\//.test(src), k + ' 的 src 不许是外链：' + src)
      assert.ok(src.endsWith('.webp'), k + ' 的资产必须是 webp：' + src)
    }
  })

  test('TC-S1-03 位面表 = 25 岗位 ∪ s01..s15，>=40 且单射、确定性（AC-R3-3）', () => {
    const keys = mod.slotKeys()
    assert.equal(keys.length, ROLES.length + SPARES.length)
    assert.ok(keys.length >= 40)
    assert.equal(new Set(keys).size, keys.length, 'key 必须两两不同')
    for (const r of ROLES) assert.ok(keys.includes(r), '缺岗位位面：' + r)
    for (const s of SPARES) assert.ok(keys.includes(s), '缺备用位面：' + s)
    for (const r of ROLES) {
      const a = mod.resolveSlot('human:' + r)
      const b = mod.resolveSlot('human:' + r)
      assert.ok(a && b)
      assert.deepEqual(a, b, '同一 role 两次解析必须同值')
    }
    const slots = ROLES.map(r => JSON.stringify(mod.resolveSlot('human:' + r)))
    assert.equal(new Set(slots).size, ROLES.length, '25 个岗位各有且仅有一个位面（单射）')
  })

  test('TC-S1-04 同 token 幂等，且源码无随机/时钟/网络（AC-R3-4、AC-R8-1）', () => {
    assert.equal(render('human:coder'), render('human:coder'))
    const src = avatarCode()
    for (const banned of ['Math.random', 'Date.now', 'performance.now', 'new Date', 'fetch(', 'XMLHttpRequest', 'http://', 'https://']) {
      assert.ok(!src.includes(banned), '禁止出现 ' + banned)
    }
  })

  test('TC-S1-05/06/07/17 缺失/emoji/非法令牌 → 确定性占位人形，不显示名称首字（AC-R9-1/9-2、AC-R4-1）', () => {
    // ★ 2026-10-13：`'human:requirement '`（**带尾空格**）从这个名单里移走了。
    //   它不是非法令牌 —— `resolveSlot()` 会 trim，于是它**正常解析**成 requirement。
    //   从前它混在这里也能过，是因为**所有**头像都渲染 `<svg`，断言分不出真假；
    //   配图之后 requirement 走 `<img>`，它就被"揭发"成了一个假阳性用例。
    //   现在拆成两条：真非法的走占位，可解析的单独断言（见下面 TC-S1-05b）。
    const values = [undefined, null, '', '   ', '\u{1F916}', '\u{1F9ED}', '\u{2699}\u{FE0F}', 'human:', 'human:UNKNOWN', 'HUMAN:requirement', 'human:a/../b', 'not-a-token', '<img src=x>']
    const marks = values.map(v => render(v, { name: '析言' }))
    for (let i = 0; i < values.length; i += 1) {
      const html = marks[i]
      assert.ok(html.includes('<svg'), '必须渲染占位人形：' + String(values[i]))
      assert.ok(!html.includes('<img'), '非法令牌不许落到图片：' + String(values[i]))
      assert.ok(!EMOJI_RE.test(html.replace(/<[^>]*>/g, '')), '不得渲染 emoji 文本：' + String(values[i]))
      assert.ok(!html.includes('析'), '回退不得用 name 首字：' + String(values[i]))
    }
    assert.equal(new Set(marks.slice(0, 4).map(h => h)).size, 1, '空/缺失令牌必须落到同一占位人形')
  })

  test('TC-S1-05b 可解析但形态特殊：尾空格被 trim 后照常解析（不是回退）', () => {
    // `human:<key>` 前后空白由 `resolveSlot()` trim 掉 ⇒ 这是**合法**输入。
    assert.equal(render('human:coder '), render('human:coder'), '尾空格必须被 trim 后正常解析')
    assert.equal(render('  human:coder'), render('human:coder'), '前空格同理')
  })

  test('TC-S1-08 组件契约：默认导出 + props + size/className 生效', () => {
    assert.equal(typeof AgentAvatar, 'function')
    const html = render('human:requirement', { size: 48, className: 'x-y' })
    assert.ok(html.includes('48'), 'size 必须反映到渲染尺寸')
    assert.ok(html.includes('x-y'), 'className 必须透传到根节点')
    const boundary = [0, -1, 1024, NaN].map(s => render('human:requirement', { size: s }))
    for (const h of boundary) assert.ok(isGraphic(h), '非法 size 仍必须渲染图形')
  })

  /**
   * 头像**外链**资源的黑名单 —— 只禁"要走出去拿东西"的写法。
   *
   * ★★ 2026-10-13 改判据：这条规矩原本是 `!src.includes('url(')`，**连内部渐变引用
   *    （`url(#face)`）一起禁了**。而它的本意从头到尾是「头像不得依赖外链资源」——
   *   于是它拦下的是**同文档里的一个 `#` 片段**，那不是外链。
   *
   *   代价是实测出来的：为了让头像"柔和/有明暗"（用户要的是豆包那种插画感），
   *   渐变是标准做法，却被这条误伤，只能拿分层半透明去凑——
   *   而 36px 下量颜色数，凑出来的是 114–203，参考图是 528–731（差 3–5 倍）。
   *
   *     > 一条"禁外链"的规矩，与一条"禁 `url(`"的规矩，
   *     > 在**没人需要用到 `url(#…)`** 的时候是同一个东西——
   *     > 直到有人要画渐变，而他得先猜出那条规矩到底在防什么。
   *
   *   现在按**本意**收口：外链形式全部继续禁（下面的 `EXTERNAL`），
   *   `url(#…)` 放行。`TC-S1-09b` 用两侧对照把这条边界钉住。
   *
   * ★★ 2026-10-13 再改一次（同一本意，第三次收口）：头像现在**允许 `<img>`** ——
   *    因为用户提供了真实头像资产，走 `<img src="./avatars/x.webp">`。于是原来
   *    禁 `'<img'` 与 `'src='` 的两条又变成了误伤：它们拦的是**"用图片"**本身，
   *    而不是"用**外部**图片"。规矩收成一句话：
   *
   *      > 头像可以引用**随包发布的本机资源**（相对路径），
   *      > 引用任何要"走出去拿"的东西一律不许。
   *
   *    所以现在禁的是**带协议/协议相对的写法**（`http:` / `https:` / `//` / `data:`），
   *    放行相对路径与内部片段；并且禁止 `onerror` 之类的内联事件（那能让外部地址
   *    绕过静态检查）。`TC-S1-09b` 用两侧对照把这三条边界一起钉住。
   */
  const EXTERNAL = ['url(http', 'url(https', 'url(//', 'url(data:', 'src="http', "src='http", 'src="//', "src='//", 'src="data:', 'xlink:href="http', ' onerror=', 'onerror=']
  test('TC-S1-09 离线自足：无外链资源、无网络调用（AC-R8-1）', () => {
    const src = avatarCode()
    for (const banned of EXTERNAL) {
      assert.ok(!src.includes(banned), '头像不得依赖外链资源：' + banned)
    }
    // 内部渐变引用是**允许**的（它不出文档）——这一条是防"改判据时顺手把渐变也删了"
    assert.ok(src.includes('url(#'), '本版头像用内部渐变做明暗；没有它说明画法被回退了')
    // ★ 反向锚：允许的写法必须真的在用（否则"零命中"可能只是因为头像根本没有图）
    assert.ok(src.includes("AVATAR_PHOTO_BASE + file") || src.includes('AVATAR_PHOTO_BASE'),
      '配了图的位面必须真的走图片路径')
  })

  test('★ TC-S1-09b 边界对照：内部渐变与同源图片放行、外链写法必红、剥注释没架空门禁', () => {
    const isExternal = (code) => EXTERNAL.some((b) => code.includes(b))
    // ① 内部渐变引用：不许判红（否则画不了明暗）
    assert.equal(isExternal(codeOnly("const f = 'url(#face-grad)'\n")), false,
      '★ url(#…) 是同文档引用，不是外链')
    // ①b 同源相对图片：不许判红（这正是这一版要用的写法）
    for (const ok of ["const u = './avatars/agent-avatar-01.webp'", "const u = '/avatars/x.webp'", '<img src="./avatars/a.webp" />']) {
      assert.equal(isExternal(codeOnly(ok + '\n')), false, '★ 同源相对路径是允许的：' + ok)
    }
    // ② 外链形式：一条都不许漏
    //
    // ★ 夹具用**模板串**直插，不用 `JSON.stringify`：后者会把 `"` 转义成 `\"`，
    //   于是 `src="http` 这种**字面判据**在夹具里永远匹配不到 —— 一条本该红的用例
    //   会静静地绿着。实测就是这么发现的：`<img src="https://x/a.png">` 报了 false。
    //   真实源码里的引号是**不转义**的，夹具必须长得跟它一样。
    for (const bad of [
      "url(http://x/a.svg)", "url(https://x/a.png)", "url(//cdn/a.svg)", "url(data:image/svg+xml;base64,AA)",
      '<img src="https://x/a.png">', "<img src='http://x/a.png'>", '<img src="//cdn/a.png">',
      '<img src="data:image/png;base64,AA">', '<img src="a.png" onerror="alert(1)">',
    ]) {
      assert.equal(isExternal(codeOnly(`const f = ${bad}\n`)), true,
        '★ 外链写法必须被判红：' + bad)
    }
    // ③ 剥注释没有把门禁剥空（代码行里的违规仍可见）
    assert.ok(codeOnly("const a=1\nconst b='url(http://x)' // 真违规\n").includes('url(http'),
      '★ 代码行里的外链必须仍然可见')
    assert.ok(!codeOnly("// 解释为什么不能用外链（如 url(http…）\nconst a=1\n").includes('url(http'),
      '整行注释里的同类字符串不该误伤')
    // ④ 反向锚：源码确实读到了东西
    assert.ok(avatarCode().includes('AgentAvatar') || avatarCode().includes('SLOT_KEYS'),
      'avatarCode() 必须真的读到源码')
  })

  test('TC-S1-10 依赖零新增（AC-R8-2）', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@react-three/drei', '@react-three/fiber', 'react', 'react-dom', 'three'])
  })

  test('TC-S1-12 身份红线：avatar/name 不进 key/唯一约束（AC-R2-3）', () => {
    const src = readFileSync(join(SRC, 'AgentAvatar.tsx'), 'utf8')
    assert.ok(!/key=\{[^}]*\b(avatar|name)\b/.test(src), 'avatar/name 不得作为 React key')
    assert.ok(!/PRIMARY KEY|UNIQUE/.test(src))
  })
})
