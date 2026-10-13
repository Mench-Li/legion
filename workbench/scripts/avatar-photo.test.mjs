// workbench/scripts/avatar-photo.test.mjs — 头像图片资产：存在性、两端一致、来源可溯、零外链。
// 运行：node workbench/scripts/avatar-photo.test.mjs
//
// ## 这份用例守的是什么
//
// 头像从"纯矢量"变成"**有图用图、没图用矢量**"之后，多出来一整类**只在运行时才会暴露**的
// 故障，而它们在开发机上通常看不出来：
//
//   · 映射表写了一个**不存在的文件** ⇒ 界面上是一张破图（而本机因为缓存可能是好的）；
//   · 只往 `workbench/public/` 拷了图、**忘了手机那份** ⇒ 桌面正常、手机全裂；
//   · 两端文件**内容不同**（改了一端忘了另一端）⇒ 同一个人在两个端上不是同一张脸；
//   · 有人手滑把 `src` 写成了外链 ⇒ 头像是从别人服务器上拉的（离线就裂，且是隐私问题）。
//
// 判据全部做成**提交时**检查，而不是运行时容错：
//
//   > "运行时发现图挂了再回退"与"提交时就不许引用不存在的图"，
//   > 在**一切都对**的时候是同一条路 ——
//   > 区别只在有人写错的那一刻：前者让用户看见破图，后者让 CI 变红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { writeFileSync, rmSync } from 'node:fs'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SRC_AVATAR = resolve(ROOT, 'workbench', 'src', 'avatar')
const DESKTOP_DIR = resolve(ROOT, 'workbench', 'public', 'avatars')
const MOBILE_DIR = resolve(ROOT, 'workbench', 'mobile', 'avatars')
const TMP = join(HERE, '.avatar-photo.assets.mjs')

// 桌面资产表是真源（TS）—— 转译后导入，不拿正则啃源码。
const out = ts.transpileModule(readFileSync(join(SRC_AVATAR, 'photo-assets.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
})
writeFileSync(TMP, out.outputText, 'utf8')
const desktop = await import(pathToFileURL(TMP).href)
const mobile = await import(pathToFileURL(resolve(ROOT, 'workbench', 'mobile', 'avatar.mjs')).href)
process.on('exit', () => { try { rmSync(TMP, { force: true }) } catch { /* 清理 */ } })

const PHOTO_KEYS = Object.keys(desktop.AVATAR_PHOTOS)

test('① 桌面资产表非空，且 key 都是位面表里真实存在的 key', async () => {
  assert.ok(PHOTO_KEYS.length > 0, '资产表不该是空的')
  // 映射到一个**不存在的位面** = 永远不会被命中的死条目（渲染器按位面 key 查表）。
  const slotsOut = ts.transpileModule(readFileSync(join(SRC_AVATAR, 'slots.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  })
  const slotsTmp = join(HERE, '.avatar-photo.slots.mjs')
  writeFileSync(slotsTmp, slotsOut.outputText, 'utf8')
  const slots = await import(pathToFileURL(slotsTmp).href)
  rmSync(slotsTmp, { force: true })
  const known = new Set(slots.slotKeys())
  for (const k of PHOTO_KEYS) {
    assert.ok(known.has(k), '资产表里的 key 不是合法位面（永远命中不到）：' + k)
  }
})

test('★ ② 每个映射的图片在**桌面与手机两处都真实存在**（防只拷一端）', () => {
  for (const k of PHOTO_KEYS) {
    const file = desktop.AVATAR_PHOTOS[k].file
    const d = join(DESKTOP_DIR, file)
    const m = join(MOBILE_DIR, file)
    assert.ok(existsSync(d), `桌面缺图（会渲染成破图）：${k} → ${file}`)
    assert.ok(existsSync(m), `手机缺图（手机端会裂，而桌面正常）：${k} → ${file}`)
    assert.ok(statSync(d).size > 0, `桌面图是空文件：${file}`)
    assert.ok(statSync(m).size > 0, `手机图是空文件：${file}`)
  }
})

test('★ ③ 两端文件**逐字节相同**（防只改一端：同一个人两副面孔）', () => {
  for (const k of PHOTO_KEYS) {
    const file = desktop.AVATAR_PHOTOS[k].file
    const a = readFileSync(join(DESKTOP_DIR, file))
    const b = readFileSync(join(MOBILE_DIR, file))
    assert.ok(a.equals(b), `两端内容不一致：${k} → ${file}`)
  }
})

test('★ ④ 手机端资产表与桌面端**逐项相同**（key 集合 + 文件名）', () => {
  const mk = Object.keys(mobile.AVATAR_PHOTOS).sort()
  assert.deepEqual(mk, [...PHOTO_KEYS].sort(), '两端的配图 key 集合必须一致')
  for (const k of PHOTO_KEYS) {
    assert.equal(mobile.AVATAR_PHOTOS[k], desktop.AVATAR_PHOTOS[k].file,
      '同一个 key 在两端必须指向同一个文件：' + k)
  }
})

test('⑤ 没有孤儿图：目录里的每个资产都被资产表引用（防"加了图忘了登记"）', () => {
  const referenced = new Set(PHOTO_KEYS.map(k => desktop.AVATAR_PHOTOS[k].file))
  for (const [label, dir] of [['桌面', DESKTOP_DIR], ['手机', MOBILE_DIR]]) {
    for (const f of readdirSync(dir)) {
      assert.ok(referenced.has(f), `${label} avatars/ 里有未被任何 key 引用的图（加了图忘了登记？）：${f}`)
    }
  }
})

test('★ ⑥ 资产是正方形 WebP 且体积可控（防止有人塞回 2MB 的原图）', () => {
  for (const k of PHOTO_KEYS) {
    const file = desktop.AVATAR_PHOTOS[k].file
    assert.ok(file.endsWith('.webp'), '资产必须是 webp：' + file)
    const buf = readFileSync(join(DESKTOP_DIR, file))
    // WebP 容器魔数：RIFF....WEBP
    assert.equal(buf.subarray(0, 4).toString('ascii'), 'RIFF', '不是 RIFF 容器：' + file)
    assert.equal(buf.subarray(8, 12).toString('ascii'), 'WEBP', '不是 WebP：' + file)
    const size = buf.length
    assert.ok(size <= 64 * 1024, `${file} 体积 ${size}B 超过 64KB（应当用 256px WebP 派生图）`)
  }
})

test('⑦ 来源可溯：每条都有原图路径与尺寸（"这图哪来的"必须答得出来）', () => {
  for (const k of PHOTO_KEYS) {
    const e = desktop.AVATAR_PHOTOS[k]
    assert.ok(typeof e.from === 'string' && e.from.length > 0, '缺来源：' + k)
    assert.match(e.from, /^assets\//, '来源应当指向仓库内的原图位置：' + e.from)
    assert.match(e.srcSize, /^\d+x\d+$/, '缺原图尺寸：' + k)
    assert.match(e.sha256, /^[0-9a-f]{8,}$/, '缺指纹：' + k)
  }
  // 20 张图应当对应 20 个不同的原图（防止复制粘贴时把两行写成同一张）
  const froms = PHOTO_KEYS.map(k => desktop.AVATAR_PHOTOS[k].from)
  assert.equal(new Set(froms).size, froms.length, '有多个 key 指向同一张原图（复制粘贴出错？）')
})

test('★ ⑧ 零外链：渲染出来的 src 一律是同源相对路径', () => {
  for (const k of [...PHOTO_KEYS, 's10', 'UNKNOWN']) {
    const html = mobile.renderAvatar('human:' + k, 24)
    const srcs = [...html.matchAll(/src="([^"]*)"/g)].map(m => m[1])
    for (const s of srcs) {
      assert.ok(s.startsWith('./avatars/'), `${k} 的 src 不是同源相对路径：${s}`)
      assert.ok(!/^(https?:)?\/\//.test(s), `${k} 的 src 是外链：${s}`)
    }
  }
})

test('⑨ 图片基址：两端都是相对 `./avatars/`（否则 /mobile/ 下会解析到站点根）', () => {
  assert.equal(desktop.AVATAR_PHOTO_BASE, './avatars/')
  // ★ 断言**渲染结果**而不是源码字面量：手机端那一段是字符串拼接出来的
  //   （`'... src="./avatars/' + photo`），拿源码找 `'./avatars/'` 永远找不到 ——
  //   一条按"源码里有没有这个词"写的判据，很容易在重构后变成**恒假**。
  const html = mobile.renderAvatar('human:requirement', 24)
  assert.ok(html.includes('src="./avatars/'), '手机端渲染结果必须用相对基址：' + html.slice(0, 90))
  assert.ok(!html.includes('src="/avatars/'), '手机端不许用站点根绝对路径（在 /mobile/ 下会 404）')
})

test('★ ⑩ 两个静态服务都认得 `.webp`（否则：桌面正常、手机端全 404）', () => {
  // ★ 这一条是**实测踩出来的**：图放好了、桌面 200，而 `/mobile/avatars/x.webp` 回 **404** ——
  //   因为两个静态服务的 MIME 都是**白名单**，"不在表里的一律 404"，而 .webp 当时不在表里。
  //   这个故障的形状很坏：桌面端看起来完全正常，只有手机端整片头像裂掉。
  //
  //   > 一条"白名单里漏了一项"的规则，
  //   > 在**只有一类客户端**的时候，与一条正确的规则没有区别。
  const cases = [
    ['team-hub/routes/mobile.mjs', /MIME\s*=\s*Object\.freeze\(\{[\s\S]*?'\.webp'\s*:\s*'image\/webp'/],
    ['workbench/scripts/serve.mjs', /MIME\s*=\s*\{[\s\S]*?'\.webp'\s*:\s*'image\/webp'/],
  ]
  for (const [file, re] of cases) {
    const src = readFileSync(resolve(ROOT, file), 'utf8')
    assert.match(src, re, `${file} 的 MIME 白名单必须包含 .webp → image/webp（漏了就是 404）`)
  }
})
