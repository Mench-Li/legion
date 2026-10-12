// workbench/mobile/i18n.test.mjs
// ============================================================================
// 语言层：决策、插值、静态替换，以及**覆盖率差集**。
//
// 最后那一条是本族最重要的：它把源码里所有 `t('…')` 的字面量与英文表求差集。
// 没有它，"我加了一处 `t()` 却忘了写英文"不会以任何形式暴露 ——
// 界面在英文模式下那一句仍然是中文，而**没有任何东西会红**。
//
//   > 一个"漏翻一句"的界面，与一个"全部翻好"的界面，
//   > 在只看中文的用户那里是同一个东西。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  LOCALES, DEFAULT_LOCALE, EN, DYNAMIC_KEYS, LOCALE_LABEL,
  localeFromTag, resolveLocale, getLocale, setLocale, t, interpolate, applyStaticI18n,
} from './i18n.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (f) => readFileSync(join(HERE, f), 'utf8')
const HTML = read('index.html')
/** 参与覆盖率判据的源文件（用户可见文案住在这里）。 */
const SOURCES = ['app.mjs', 'board.mjs', 'popup.mjs', 'timeline.mjs', 'notice.mjs', 'notify-plan.mjs', 'screen-plan.mjs']

const CJK = /[\u4e00-\u9fff]/

// ── ① 语言解析 ──────────────────────────────────────────────────────────────

test('★ BCP-47 标签取语言；不认识的回 null（不是默认值）', () => {
  assert.equal(localeFromTag('zh-CN'), 'zh')
  assert.equal(localeFromTag('zh'), 'zh')
  assert.equal(localeFromTag('en-US'), 'en')
  assert.equal(localeFromTag('EN'), 'en')
  // ★ 回 `null` 而不是 `DEFAULT_LOCALE`：这样调用方分得开"不认识这个标签"
  //   与"明确定义了默认"，否则下一级回退永远不会被执行。
  for (const bad of ['fr', 'de-DE', '', null, undefined, 0, {}, 'x']) {
    assert.equal(localeFromTag(bad), null, `${JSON.stringify(bad)} 不该被认成某种语言`)
  }
})

test('★★★ 优先级：用户显式选择 > 浏览器语言 > 默认', () => {
  assert.equal(resolveLocale({ saved: 'en', navLang: 'zh-CN' }), 'en', '用户选过就必须压过浏览器')
  assert.equal(resolveLocale({ saved: 'zh', navLang: 'en-US' }), 'zh', '反过来也一样')
  assert.equal(resolveLocale({ saved: null, navLang: 'en-US' }), 'en', '没选过才看浏览器')
  assert.equal(resolveLocale({ saved: null, navLang: 'fr-FR' }), DEFAULT_LOCALE, '都不认识才用默认')
  assert.equal(resolveLocale({}), DEFAULT_LOCALE)
})

test('★★ 存坏了的值要能回退（不是把界面卡在不存在语言上）', () => {
  // `saved` 来自 localStorage，用户/脚本都可能写进任何东西。
  for (const junk of ['', '  ', 'fr', 'null', '0', 'EN-US']) {
    const got = resolveLocale({ saved: junk, navLang: 'zh-CN' })
    assert.ok(LOCALES.includes(got), `saved=${JSON.stringify(junk)} 得到了不受支持的语言 ${got}`)
  }
  // `'EN-US'` 是**合法的**（大小写不敏感），要认出来。
  assert.equal(resolveLocale({ saved: 'EN-US' }), 'en')
})

test('★ setLocale 只接受受支持的语言，当场抛', () => {
  const before = getLocale()
  for (const bad of ['fr', '', null, 'ZH', 0, {}]) {
    assert.throws(() => setLocale(bad), TypeError, `${JSON.stringify(bad)} 应当当场抛`)
  }
  setLocale('en')
  assert.equal(getLocale(), 'en')
  setLocale(before)
  assert.equal(getLocale(), before, '上面的用例不该把全局状态留成别的语言')
})

// ── ② 翻译与插值 ────────────────────────────────────────────────────────────

test('★★★ 缺译时回落到**原文**，不是空白、也不是内部键名', () => {
  // 这是"用原文当 key"这个设计的主要理由。
  const unknown = '这句故意没有英文'
  assert.equal(t(unknown, null, 'en'), unknown, '英文模式下没翻的句子应当仍然是原文')
  assert.equal(t(unknown, null, 'zh'), unknown)
  // 不许出现 undefined / [object Object] / 空串。
  for (const loc of LOCALES) {
    const out = t(unknown, null, loc)
    assert.equal(typeof out, 'string')
    assert.ok(out.length > 0, `${loc} 下得到了空串`)
    assert.doesNotMatch(out, /undefined|\[object/)
  }
})

test('★★ 中文模式下**原样返回**（不做任何查表）', () => {
  assert.equal(t('登录', null, 'zh'), '登录')
  // 中文表就是原文，所以这句话恒真；它守的是"别把 zh 也拿去查 EN"。
  assert.equal(t('登录', null, 'zh'), EN['登录'] === undefined ? '登录' : '登录')
})

test('★ 认识的原文字符串翻成英文', () => {
  assert.equal(t('登录', null, 'en'), 'Sign in')
  assert.equal(t('Hub 不可达', null, 'en'), 'Hub unreachable')
  assert.equal(t('待你验收', null, 'en'), 'Waiting for your review')
})

test('★★ 插值：缺变量时**原样留占位符**，不写 undefined', () => {
  assert.equal(interpolate('共 {n} 条', { n: 3 }), '共 3 条')
  assert.equal(interpolate('共 {n} 条', {}), '共 {n} 条', '缺变量时留占位符')
  assert.equal(interpolate('共 {n} 条', null), '共 {n} 条')
  assert.equal(interpolate('{a}-{b}', { a: 'x', b: 'y' }), 'x-y')
  // 不许把 undefined 印到用户脸上。
  assert.doesNotMatch(interpolate('共 {missing} 条', { n: 1 }), /undefined/)
})

test('★★ 显式键（`@`）用于动态文案，两种语言都在', () => {
  assert.equal(t('@attemptState', { state: 'Running' }, 'zh'), 'Attempt 状态：Running')
  assert.equal(t('@attemptState', { state: 'Running' }, 'en'), 'Attempt state: Running')
  for (const [key, entry] of Object.entries(DYNAMIC_KEYS)) {
    assert.ok(key.startsWith('@'), `${key} 应当是显式键`)
    for (const loc of LOCALES) {
      assert.equal(typeof entry[loc], 'string', `${key} 缺 ${loc}`)
      assert.ok(entry[loc].length > 0, `${key} 的 ${loc} 是空的`)
    }
  }
  // 不认识的键原样返回（而不是抛），免得一句没登记的文案把界面弄崩。
  assert.equal(t('@no-such-key', null, 'en'), '@no-such-key')
})

// ── ③ 静态 HTML 替换 ────────────────────────────────────────────────────────

test('★★★ 语言能来回切（zh → en → zh 必须回到中文）', () => {
  // ★ 这一条守的是一个很容易犯的错：把**当前显示的文字**当成原文。
  //   那样 `zh → en → zh` 会把英文当原文再"翻译"一次 —— 而英文在表里查不到，
  //   于是**切不回中文**，而且没有任何报错。
  const fake = makeFakeTree([{ tag: 'BUTTON', text: '登录' }])
  applyStaticI18n(fake, 'en')
  assert.equal(fake.nodes[0].textContent, 'Sign in')
  applyStaticI18n(fake, 'zh')
  assert.equal(fake.nodes[0].textContent, '登录', '切回中文失败 —— 原文没有被记住')
  applyStaticI18n(fake, 'en')
  assert.equal(fake.nodes[0].textContent, 'Sign in', '第二次切英文也应当正确')
})

test('★ 属性能被翻译，且同样能来回切', () => {
  const fake = makeFakeTree([{
    tag: 'INPUT', attrs: { placeholder: '给 Agent 发消息…' }, i18nAttr: 'placeholder',
  }])
  applyStaticI18n(fake, 'en')
  assert.equal(fake.nodes[0].attrs.placeholder, 'Message the agent…')
  applyStaticI18n(fake, 'zh')
  assert.equal(fake.nodes[0].attrs.placeholder, '给 Agent 发消息…')
  applyStaticI18n(fake, 'en')
  assert.equal(fake.nodes[0].attrs.placeholder, 'Message the agent…')
})

test('★ 反例守卫：替身必须真的带 `dataset.i18nAttr`，否则上面那条是空转', () => {
  // 第一版替身漏了它，`applyStaticI18n` 返回 `touched = 0` —— 库什么都没做，
  // 而那条断言"失败得莫名其妙"。这条判据钉住替身本身。
  const without = makeFakeTree([{ tag: 'INPUT', attrs: { placeholder: '给 Agent 发消息…' } }])
  assert.equal(applyStaticI18n(without, 'en'), 0,
    '没有 data-i18n-attr 的节点不该被碰 —— 这同时说明了上面那条为什么需要它')
  const with_ = makeFakeTree([{
    tag: 'INPUT', attrs: { placeholder: '给 Agent 发消息…' }, i18nAttr: 'placeholder',
  }])
  assert.equal(applyStaticI18n(with_, 'en'), 1, '带了就该恰好处理一个属性')
})

test('★ 传入 null/无 querySelectorAll 的宿主不炸', () => {
  assert.equal(applyStaticI18n(null), 0)
  assert.equal(applyStaticI18n(undefined), 0)
  assert.equal(applyStaticI18n({}), 0)
})

/** 一个最小的 DOM 替身：只需要 `querySelectorAll` 与节点上的 textContent/属性。
 *
 * ⚠️ 第一版这里**漏了 `dataset.i18nAttr`** —— 而真实 DOM 上它由
 * `data-i18n-attr="placeholder"` 提供，是库用来知道"要翻哪几个属性"的输入。
 * 漏了它的结果是 `touched = 0`：库对空属性表什么都不做，测试于是"失败得莫名其妙"。
 * 这与 `functionBody` 那次是同一类错 —— **替身少了真实输入，测的就不是那件事**。 */
function makeFakeTree(nodes) {
  const built = nodes.map((n) => ({
    tag: n.tag,
    textContent: n.text ?? '',
    dataset: n.i18nAttr === undefined ? {} : { i18nAttr: n.i18nAttr },
    attrs: { ...(n.attrs ?? {}) },
    getAttribute(attr) { return Object.prototype.hasOwnProperty.call(this.attrs, attr) ? this.attrs[attr] : null },
    setAttribute(attr, value) { this.attrs[attr] = value },
  }))
  return {
    nodes: built,
    querySelectorAll(sel) {
      if (sel === '[data-i18n]') return built.filter((b) => b.textContent.length > 0)
      if (sel === '[data-i18n-attr]') return built.filter((b) => b.dataset.i18nAttr !== undefined)
      return []
    },
  }
}

// ── ④ 英文表本身的质量 ──────────────────────────────────────────────────────

test('★★★ 英文表里不许残留中文（"加了一条却粘了原文"）', () => {
  const offenders = Object.entries(EN).filter(([, v]) => CJK.test(v))
  assert.deepEqual(offenders, [],
    `这些英文条目里还有中文：${offenders.map(([k]) => k).join('、')}`)
})

test('★★★ 显式键（`@`）的英文里也不许残留中文', () => {
  // ★ 破坏性验证抓出来的洞：我只查了 `EN`，于是把 `@spaceLabel` 的英文写成中文
  //   （`en: '空间：{id}（{role}）'`）**35 条判据全绿** —— 而那正是最典型的漏翻形状：
  //   复制了 zh 那份、忘了改。两张表都要查。
  const offenders = Object.entries(DYNAMIC_KEYS)
    .filter(([, v]) => CJK.test(v.en))
    .map(([k, v]) => `${k} → ${JSON.stringify(v.en)}`)
  assert.deepEqual(offenders, [], '这些显式键的英文里还有中文：\n  ' + offenders.join('\n  '))
})

test('★ 英文表的值都非空', () => {
  for (const [k, v] of Object.entries(EN)) {
    assert.equal(typeof v, 'string', `${k} 的值应当是字符串`)
    assert.ok(v.trim().length > 0, `${k} 的英文是空的（用户会看到一个空按钮）`)
  }
})

test('★ 语言切换器用各语言自己的说法（不是把"中文"翻成 Chinese 给中文用户看）', () => {
  assert.equal(LOCALE_LABEL.zh, '中文')
  assert.equal(LOCALE_LABEL.en, 'English')
})

// ── ⑤ 覆盖率差集（本族最重要的一条）─────────────────────────────────────────

/**
 * 从源码里抽出所有 `t(...)` 调用**参数区间内**的中文字面量。
 *
 * ★ 第一版只抓 `t('…')` 这种"字面量恰好是第一个 token"的形状 ——
 *   于是 `t(registering ? '注册 Legion' : '登录 Legion')`、`t(cond ? 'A' : 'B')`
 *   这类**一个都没抓到**，而覆盖率判据看起来还是全绿的。
 *
 *   > 一支"只认它见过的那种写法"的提取器，与一支"什么也没提取"的提取器，
 *   > 在差集为空的时候是同一个东西。
 *
 * 现在从 `t(` 出发**按圆括号配平**走到调用结束，把区间里所有引号字符串收集起来。
 */
function translationLiterals(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const out = new Set()
  const re = /\bt\(/g
  let m
  while ((m = re.exec(code)) !== null) {
    // 配平圆括号，拿到这次调用的参数区间。
    let depth = 0
    let i = m.index + 1 // 指向 `(`
    let end = -1
    for (; i < code.length; i += 1) {
      const ch = code[i]
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    if (end < 0) continue
    const args = code.slice(m.index + 2, end)
    // 区间内的所有引号字符串（单/双/反引号）。
    for (const sm of args.matchAll(/(['"`])([\s\S]*?)\1/g)) {
      const text = sm[2]
      if (CJK.test(text) && !text.startsWith('@')) out.add(text)
    }
  }
  return out
}

test('★★★ app.mjs 里每一处 `t(...)` 的中文都有英文', () => {
  const missing = [...translationLiterals(read('app.mjs'))].filter((s) => EN[s] === undefined)
  assert.deepEqual(missing, [],
    '这些文案被 t() 包了但没有英文 —— 英文模式下它们仍然显示中文，而不会有任何东西变红：\n  '
    + missing.map((s) => JSON.stringify(s)).join('\n  '))
})

test('★★★ 反例守卫：提取器必须能看见"非字面量开头"的 t() 调用', () => {
  // 第一版只认 `t('…')`，于是三元的两个分支一个都抓不到 —— 判据全绿而洞在那儿。
  const sample = "x = t(cond ? '甲' : '乙')\ny = t('丙')\nz = t('@key', { v: '丁' })"
  const got = [...translationLiterals(sample)].sort()
  assert.deepEqual(got, ['丙', '乙', '甲', '丁'].sort(),
    '提取器漏了非字面量开头的分支 —— 那样这一族会静默失去大半覆盖')
  // 字符串拼接会把两个片段都收进来。这是**对的**：两个片段都是候选 key，
  // 而多收一个只会让覆盖率判据更严（要求它有英文），不会放过漏译。
  // （第一版我把这里写成 `=== 1`，那是错的期望，不是错的实现。）
  const concat = [...translationLiterals("t('甲' + '乙')")].sort()
  assert.deepEqual(concat, ['乙', '甲'].sort(), '拼接的两个片段都应当被收进来')
})

/** HTML **去注释**后的正文。
 *
 * ★ 必须去注释：注释里写了 `data-i18n` 这几个字（解释用法的那些），
 *   而正则分不清"标记"与"提到这个标记的散文" —— 我的一段注释就被当成了一个
 *   带 `data-i18n` 的元素，于是覆盖率判据报出一句散文"缺英文"。
 *   这类假阳性最坏的地方是它会**训练人忽略这条判据**。 */
const HTML_NO_COMMENTS = HTML.replace(/<!--[\s\S]*?-->/g, '')

/** 匹配 `data-i18n` **本身**，不匹配 `data-i18n-attr`。
 *  `(?![\w-])` 是必须的：不然 `data-i18n-attr="title"` 也会被当成 `data-i18n`，
 *  于是那个只有属性标记的元素会被要求"它的文字有英文"。 */
const DATA_I18N_TEXT = /data-i18n(?![\w-])(?:[^>]*)>([^<]+)</g

test('★★★ index.html 里每一个 `data-i18n` 元素的中文都有英文', () => {
  const missing = new Set()
  for (const m of HTML_NO_COMMENTS.matchAll(DATA_I18N_TEXT)) {
    const text = m[1].trim()
    if (CJK.test(text) && EN[text] === undefined) missing.add(text)
  }
  assert.deepEqual([...missing], [],
    '这些静态文案标了 data-i18n 但没有英文：\n  ' + [...missing].map((s) => JSON.stringify(s)).join('\n  '))
})

test('★ 反例守卫：`data-i18n-attr` 不该被当成 `data-i18n`（前缀重叠）', () => {
  // 证明上面那条的负向断言不是白写的。
  const attrOnly = '<input placeholder="给 Agent 发消息…" data-i18n-attr="placeholder" />'
  assert.equal([...attrOnly.matchAll(DATA_I18N_TEXT)].length, 0,
    '只有 data-i18n-attr 的元素不该被 data-i18n 的判据盯上')
  const both = '<button title="刷新" data-i18n-attr="title" data-i18n>刷新</button>'
  assert.equal([...both.matchAll(DATA_I18N_TEXT)].length, 1)
  // 注释里的散文也要被剔掉。
  assert.equal([...'<!-- 用 data-i18n 标记 -->'.replace(/<!--[\s\S]*?-->/g, '').matchAll(DATA_I18N_TEXT)].length, 0)
})

test('★★ index.html 里 `data-i18n-attr` 标到的属性值都有英文', () => {
  const missing = new Set()
  // 形如 <input id="x" placeholder="中文" data-i18n-attr="placeholder" />
  for (const m of HTML_NO_COMMENTS.matchAll(/<[^>]*data-i18n-attr="([^"]+)"[^>]*>/g)) {
    const tagText = m[0]
    for (const attr of m[1].split(',').map((s) => s.trim())) {
      const am = new RegExp(`(?:^|\\s)${attr}="([^"]*)"`).exec(tagText)
      if (am === null) continue
      const v = am[1]
      if (CJK.test(v) && EN[v] === undefined) missing.add(v)
    }
  }
  assert.deepEqual([...missing], [],
    '这些属性文案标了 data-i18n-attr 但没有英文：\n  ' + [...missing].map((s) => JSON.stringify(s)).join('\n  '))
})

/** 一个极小的 HTML 扫描器：返回"含中文的文本节点"与"含中文的可翻属性"，
 *  并标出它们所属元素是否**真的被标记**了。
 *
 * ★ 为什么需要它：上面那两条覆盖率判据只问"**被标记的**有没有英文"，
 *   它们**不问**"该标记的有没有被标记"。破坏性验证证明了这一点 ——
 *   把登录按钮的 `data-i18n` 删掉（于是英文模式下它仍然是中文），
 *   25 条判据**全绿**。
 *
 *   > 一支"检查已标记项"的判据，与一支"检查该标记项"的判据，
 *   > 在没人漏标记的时候是同一个东西。
 *
 * 这是一个**结构**判据，不是白名单：它不认识"登录按钮"这个说法，
 * 它只问"这段中文属于的那个元素，有没有声明自己要翻译"。 */
const VOID_TAGS = new Set(['input', 'br', 'img', 'meta', 'link', 'hr', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr'])
const TRANSLATABLE_ATTRS = ['title', 'placeholder', 'aria-label']

function scanMarked(html) {
  // ★ 先把 `<style>` / `<script>` **整块**剥掉，再剥注释。
  //   只按"当前栈顶是 style 就跳过文本"是不够的：本文件的一段 CSS 注释里
  //   写了字面的 `<option>`（在解释"原生 option 只能渲染纯文本"），
  //   分词器把它当成了一个真元素推入栈 —— 从此栈就错位了，
  //   后面所有文本都被算到那个不存在的 `option` 名下。
  //   （实测踩到：反向判据报出的 parent 是 `option`，而模板里根本没有它。）
  const src = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  const unmarkedText = []
  const unmarkedAttr = []
  const stack = []
  const re = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g
  let m
  while ((m = re.exec(src)) !== null) {
    const [whole, tagName, attrText, textRun] = m
    if (whole.startsWith('</')) { stack.pop(); continue }
    if (tagName !== undefined) {
      const attrs = {}
      const attrSrc = attrText ?? ''
      // 有值的属性。
      for (const am of attrSrc.matchAll(/([a-zA-Z][\w-]*)\s*=\s*"([^"]*)"/g)) attrs[am[1]] = am[2]
      // ★ **布尔属性**（没有 `="…"`）。`data-i18n` 就是这一种 ——
      //   第一版只认有值形态，于是 `<h2 data-i18n>` 被判成"没标记"，
      //   而那会让反向判据对**所有**正确标记的文本误报。
      for (const am of attrSrc.matchAll(/(?:^|\s)([a-zA-Z][\w-]*)(?=\s|$)/g)) {
        if (!Object.prototype.hasOwnProperty.call(attrs, am[1])) attrs[am[1]] = ''
      }
      // 显式豁免：`data-i18n-ignore`（用它必须写清理由，见 index.html 里语言按钮那段）。
      const ignored = Object.prototype.hasOwnProperty.call(attrs, 'data-i18n-ignore')
      const markedText = Object.prototype.hasOwnProperty.call(attrs, 'data-i18n') || ignored
      const markedAttrs = String(attrs['data-i18n-attr'] ?? '').split(',').map((s) => s.trim())
      if (!ignored) {
        for (const a of TRANSLATABLE_ATTRS) {
          if (attrs[a] !== undefined && CJK.test(attrs[a]) && !markedAttrs.includes(a)) {
            unmarkedAttr.push({ tag: tagName, attr: a, value: attrs[a] })
          }
        }
      }
      if (!whole.endsWith('/>') && !VOID_TAGS.has(tagName)) {
        stack.push({ tag: tagName, markedText })
      }
      continue
    }
    const text = (textRun ?? '').trim()
    if (!CJK.test(text)) continue
    const top = stack[stack.length - 1]
    if (top === undefined || top.markedText !== true) {
      unmarkedText.push({ text, parent: top?.tag ?? '(root)' })
    }
  }
  return { unmarkedText, unmarkedAttr }
}

test('★★★ index.html 里**含中文的文本节点**必须被 `data-i18n` 标记', () => {
  const { unmarkedText } = scanMarked(HTML)
  assert.deepEqual(unmarkedText, [],
    '这些中文没有被标记 —— 英文模式下它们会**仍然是中文**，而不会有任何东西变红：\n  '
    + unmarkedText.map((u) => `<${u.parent}> ${JSON.stringify(u.text)}`).join('\n  '))
})

test('★★★ index.html 里**含中文的可翻属性**必须被 `data-i18n-attr` 标记', () => {
  const { unmarkedAttr } = scanMarked(HTML)
  assert.deepEqual(unmarkedAttr, [],
    '这些属性文案没有被标记：\n  '
    + unmarkedAttr.map((u) => `<${u.tag} ${u.attr}="${u.value}">`).join('\n  '))
})

test('★★★ 反例守卫：反向判据必须能抓住"忘了标记"', () => {
  // 证明上面两条不是恒真 —— 它们必须能区分"标了"与"没标"。
  const bad = '<section><h2>登录 Legion</h2><input placeholder="用户名" /></section>'
  const r = scanMarked(bad)
  assert.equal(r.unmarkedText.length, 1, '没标的中文文本应当被抓住')
  assert.equal(r.unmarkedAttr.length, 1, '没标的中文属性应当被抓住')

  const good = '<section><h2 data-i18n>登录 Legion</h2>'
    + '<input placeholder="用户名" data-i18n-attr="placeholder" /></section>'
  const g = scanMarked(good)
  assert.deepEqual(g.unmarkedText, [], '标了就不该被报')
  assert.deepEqual(g.unmarkedAttr, [])
})

test('★★ 英文表里"用不上"的条目要能被看见（它们不是错误）', () => {
  // 这里刻意**不**断言"EN 无孤儿"：`timeline.mjs` / `board.mjs` / `popup.mjs`
  // 的标签是**渲染时**才被 `t()` 包上的（投影层继续产出中文），
  // 而它们的字面量在那些文件里、不在 `t('…')` 调用里。
  // 所以孤儿是**预期存在**的。这条用例把数量印出来，让人看得见它有多大 ——
  // 一个"看起来没用上"的条目，与一个"下一版本才用上"的条目，在这里没法区分。
  const used = new Set()
  for (const f of SOURCES) for (const s of translationLiterals(read(f))) used.add(s)
  const orphans = Object.keys(EN).filter((k) => !used.has(k))
  assert.ok(orphans.length >= 0)
  console.log(`  [note] 英文表 ${Object.keys(EN).length} 条；直接在 t() 里出现的 ${used.size} 条；`
    + `其余 ${orphans.length} 条由渲染边界按原文查表（预期）`)
})

// ── ⑥ 接线：语言可切换、且被真的应用 ────────────────────────────────────────

/** 取一个函数的函数体（先配平参数表的圆括号，再配平花括号，最后去掉注释）。
 *  `showError(message, { retry } = {})` 里第一个 `{` 是**参数解构** ——
 *  直接当函数体起点会截出一个 `{ retry }`，于是判据问错对象。 */
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `app.mjs 里找不到 function ${name}(`)
  const paren = src.indexOf('(', start)
  let pd = 0
  let i = paren
  for (; i < src.length; i += 1) {
    if (src[i] === '(') pd += 1
    else if (src[i] === ')') { pd -= 1; if (pd === 0) break }
  }
  const open = src.indexOf('{', i)
  assert.notEqual(open, -1, `${name} 没有函数体`)
  let depth = 0
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1
    else if (src[j] === '}') {
      depth -= 1
      if (depth === 0) {
        return src.slice(open, j + 1)
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      }
    }
  }
  throw new Error(`${name} 的花括号没配平`)
}

/**
 * 一次遍历，同时产出**字符串字面量的区间**与 **`t(...)` 调用的区间**。
 *
 * ★ 为什么不能用正则 —— 这是本族最贵的一课：
 *
 *   `/\`([^\`]*CJK[^\`]*)\`/g` 这样的写法是**不可靠**的。它在某个起始位置匹配失败后
 *   会继续前移，于是**一个闭合的反引号会被当成开引号**，一直吃到下一个开引号 ——
 *   报出一段跨几百行、以 `\n  el.querySelector('.label')…` 开头的"中文字符串"。
 *   更糟的是，它这样做的时候**看起来是在正常工作**（确实产出了东西）。
 *
 *   同理，注释里满是反引号（`` `data-screen` ``、`` `t()` ``），只要某段个数是奇数，
 *   任何"按反引号配对"的正则就整体错位。实测踩到过。
 *
 *   > 一个"偶尔把闭合引号当开引号"的扫描器，与一个"随机报错"的扫描器，
 *   > 在没人核对它输出的时候是同一个东西。
 *
 * 所以：**按字符走状态机**，谁开谁闭由状态决定，正则只用来判断内容。
 */
function scanJs(src) {
  const len = src.length
  const literals = [] // { start, end, text }
  const tSpans = [] // { start, end } —— `t(` 到配平的 `)`
  const tStack = []
  let state = 'code' // code | line | block
  let i = 0
  while (i < len) {
    const c = src[i]
    const d = src[i + 1]
    if (state === 'line') { if (c === '\n') state = 'code'; i += 1; continue }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; i += 2; continue }
      i += 1; continue
    }
    if (c === '/' && d === '/') { state = 'line'; i += 2; continue }
    if (c === '/' && d === '*') { state = 'block'; i += 2; continue }
    // 单/双引号字符串（不跨行）。
    if (c === "'" || c === '"') {
      const start = i
      const q = c
      i += 1
      while (i < len) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === q) { i += 1; break }
        if (src[i] === '\n') break
        i += 1
      }
      literals.push({ start, end: i, text: src.slice(start + 1, Math.max(start + 1, i - 1)) })
      continue
    }
    // 模板字面量：`${…}` 里的花括号按深度配对，避免把插值里的 `}` 当结束。
    if (c === '`') {
      const start = i
      i += 1
      let depth = 0
      while (i < len) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '$' && src[i + 1] === '{') { depth += 1; i += 2; continue }
        if (src[i] === '}' && depth > 0) { depth -= 1; i += 1; continue }
        if (src[i] === '`' && depth === 0) { i += 1; break }
        i += 1
      }
      literals.push({ start, end: i, text: src.slice(start + 1, Math.max(start + 1, i - 1)) })
      continue
    }
    // `t(` 调用：标识符边界要认（别把 `toast(` / `format(` 里的 t 算进来）。
    if (c === 't' && d === '(' && !/[A-Za-z0-9_$]/.test(src[i - 1] ?? '')) {
      tStack.push({ open: i + 1, depth: 0 })
      i += 2
      continue
    }
    if (c === '(') {
      if (tStack.length > 0) tStack[tStack.length - 1].depth += 1
      i += 1
      continue
    }
    if (c === ')') {
      if (tStack.length > 0) {
        const top = tStack[tStack.length - 1]
        if (top.depth === 0) { tSpans.push({ start: top.open, end: i }); tStack.pop() } else top.depth -= 1
      }
      i += 1
      continue
    }
    i += 1
  }
  return { literals, tSpans }
}

/**
 * 源码里**没有被 `t(...)` 包住**的中文字面量。
 *
 * ★ 为什么必须有这一条 —— 它是本族唯一能抓住下面这两类真 bug 的判据：
 *
 *  ① **改坏的多行三元**。行替换助手只替换了多行锚点的**第一行**，
 *     原来的续行留了下来，于是变成 `x = t(cond ? 'A' : 'B')` 后面跟着
 *     残留的 `? 'A' : 'B'`。**语法合法、`node --check` 通过**，
 *     而语义是"`t(...)` 为真就赋那句原始中文" —— 英文模式下永远是中文。
 *     只有浏览器活体检查抓到了它。
 *
 *  ② **投影层返回的 key 没进英文表**。`timelineMetaFor()` 返回 `'我'` / `'我说'` /
 *     `'进展'` 等，调用处用 `t(variable)` 翻 —— 「`t('…')` 里的字面量」那支差集
 *     **一个字都看不见**，因为它们根本不在 `t()` 里。第一版就漏了这五条。
 */
function unwrappedLiterals(src) {
  const code = src.replace(/\r\n/g, '\n')
  const { literals, tSpans } = scanJs(code)
  const out = new Set()
  for (const lit of literals) {
    if (!/[\u4e00-\u9fff]/.test(lit.text)) continue
    // 在某个 `t(...)` 的区间里 → 已经被翻了。
    if (tSpans.some((s) => lit.start > s.start && lit.start < s.end)) continue
    // 开发者日志不是界面文案（用户看不到 console）。
    const line = code.slice(code.lastIndexOf('\n', lit.start) + 1, code.indexOf('\n', lit.start))
    if (/\bconsole\.(warn|error|log|info|debug)\(/.test(line.trim())) continue
    out.add(lit.text)
  }
  return out
}

/**
 * 允许"不被 `t()` 包住"、但**必须有英文**的中文原文。必须逐条写明理由。
 *
 * 三分之二不是白名单而是**分类**：
 *  · 投影层的 key：由调用方 `t(variable)` 翻，所以它们出现在这里、而不在 `t('…')` 里；
 *  · 咽喉函数的实参：`showError` / `showPopupText` 内部已经 `t(message)`，
 *    在这里再包一层是多余且会双重翻译。
 *
 * 两类**都需要英文**，所以下面有一条判据把它们与 `EN` 求差集。
 */
const UNWRAPPED_NEEDS_EN = new Map([
  ['我', 'timelineMetaFor 返回 who，渲染处 t(who)'],
  ['系统', 'timelineMetaFor 返回 who/tagText，渲染处 t(…)'],
  ['派任务', 'timelineMetaFor 返回 tagText，渲染处 t(…)'],
  ['我说', 'timelineMetaFor 返回 tagText，渲染处 t(…)'],
  ['进展', 'timelineMetaFor 返回 tagText，渲染处 t(…)'],
  ['回复', 'timelineMetaFor 返回 tagText，渲染处 t(…)'],
  ['还没有选中 Agent', '实参交给 showLoginError → showError，里面 t(message)'],
  ['请填写用户名与口令', '实参交给 showLoginError → showError，里面 t(message)'],
  ['🔔 提醒已就绪：有任务等你处理时会弹在这里', '实参交给 showPopupText，里面 t(text)'],
])

/**
 * 允许"不被 `t()` 包住"、且**刻意不给英文**的中文 —— 只有语言按钮的提示。
 *
 * 它在英文界面里说"切换到中文"，在中文界面里说 "Switch to English"：
 * 用**目标语言**自称才看得懂，翻成单语反而失去了作用。
 * （这个字符串是 `renderLangButton` 里那个三元的一支，另一支是 `'Switch to English'`。）
 */
const UNWRAPPED_NO_EN = new Map([
  ['切换到中文', '语言按钮的双语提示（英文界面下显示"切换到中文"），刻意不翻'],
  ['setScreen 收到未知的屏：${JSON.stringify(screen)}',
    '开发者错误：传了非法屏名是**编程错误**，不是用户文案（与 console.* 同类）'],
])

test('★★★ app.mjs 里不许有"没被 t() 包住"的中文（除两张登记表）', () => {
  const found = unwrappedLiterals(read('app.mjs'))
  const allowed = new Set([...UNWRAPPED_NEEDS_EN.keys(), ...UNWRAPPED_NO_EN.keys()])
  const unexpected = [...found].filter((s) => !allowed.has(s))
  assert.deepEqual(unexpected, [],
    '这些中文没有被 t() 包住，也没有登记 ——\n'
    + '英文模式下它们会原样显示中文，而不会有任何东西变红：\n  '
    + unexpected.map((s) => JSON.stringify(s)).join('\n  '))
  // 两张表都不许陈旧：每一项都必须真的还以"未包 t()"的形态存在。
  const stale = [...allowed].filter((s) => !found.has(s))
  assert.deepEqual(stale, [],
    '登记表里这些条目已经不再出现（被包进 t() 或删掉了）—— 请把它们移出登记表：\n  '
    + stale.map((s) => JSON.stringify(s)).join('\n  '))
})

test('★★★ 登记表里"需要英文"的那些必须真的有英文（否则时间线作者名仍是中文）', () => {
  // ★ 这一条是上面那份清单的**闭环**。第一版漏了 `我`/`系统`/`我说`/`进展`/`回复` ——
  //   英文模式下时间线显示中文作者名，而"`t('…')` 里的字面量"那支差集完全看不见它们。
  const missing = [...UNWRAPPED_NEEDS_EN.keys()].filter((s) => EN[s] === undefined)
  assert.deepEqual(missing, [],
    '这些登记为"需要英文"的中文没有英文：\n  ' + missing.map((s) => JSON.stringify(s)).join('\n  '))
  // 而"刻意不翻"的那些**不该**在英文表里 —— 放了说明有人误以为要翻。
  const wrongly = [...UNWRAPPED_NO_EN.keys()].filter((s) => EN[s] !== undefined)
  assert.deepEqual(wrongly, [],
    '这些登记为"刻意不翻"的中文却进了英文表 —— 两者应当二选一：\n  '
    + wrongly.map((s) => JSON.stringify(s)).join('\n  '))
})

test('★★★ 英文表里不许有**重复键**（JS 对象里后者静默覆盖前者）', () => {
  // ★ 实测踩到：我给 `派任务` 与 `Legion 指挥台` 各加了第二次，
  //   第一个值被**静默**丢掉 —— 而两处的语义可能不同（"派任务"既是意图标签
  //   又是时间线来源标签）。对象字面量不会报重复键，
  //   任何运行期断言也看不见被覆盖的那一个。
  const src = read('i18n.mjs')
  const body = src.slice(src.indexOf('export const EN'), src.indexOf('// ── 语言状态'))
  const seen = new Map()
  const dups = []
  for (const m of body.matchAll(/^  '([^']+)':/gm)) {
    const lineNo = body.slice(0, m.index).split('\n').length
    if (seen.has(m[1])) dups.push(`${JSON.stringify(m[1])}（行 ${seen.get(m[1])} 与 ${lineNo}）`)
    else seen.set(m[1], lineNo)
  }
  assert.deepEqual(dups, [], '英文表里有重复键，后一个会静默覆盖前一个：\n  ' + dups.join('\n  '))
  assert.ok(seen.size > 50, `只解析出 ${seen.size} 个键 —— 判据可能没真正扫到表`)
})

test('★★★ 显式键（`@`）也不许重复 —— 我在这上面栽过两次', () => {
  // 实测：`@taskDispatched` 在 DYNAMIC_KEYS 里定义了两次（一次是建表时，
  // 一次是接线时又"补"了一个）。同样的静默覆盖，同样的没有报错。
  // 所以**两张表都要查**，而不是只查 `EN`。
  const src = read('i18n.mjs')
  const body = src.slice(src.indexOf('export const DYNAMIC_KEYS'), src.indexOf('export const EN'))
  const seen = new Map()
  const dups = []
  for (const m of body.matchAll(/^  '(@[A-Za-z][\w]*)':/gm)) {
    const lineNo = body.slice(0, m.index).split('\n').length
    if (seen.has(m[1])) dups.push(`${m[1]}（行 ${seen.get(m[1])} 与 ${lineNo}）`)
    else seen.set(m[1], lineNo)
  }
  assert.deepEqual(dups, [], 'DYNAMIC_KEYS 里有重复键：\n  ' + dups.join('\n  '))
  assert.ok(seen.size > 10, `只解析出 ${seen.size} 个显式键 —— 判据可能没真正扫到表`)
})

test('★ 反例守卫：未包 t() 的扫描器必须能抓住真漏翻', () => {
  const sample = "a.textContent = '未翻的句子'\nb.textContent = t('翻好的')\n"
    + "c.textContent = t(cond ? '甲' : '乙')\n"
    + "d.textContent = t('丙')\n  ? '甲'\n  : '乙'   // 残留续行（我踩过的那个坑）"
  // ★ `'丙'` **不该**出现在结果里 —— 它确实被 `t()` 包住了；
  //   被抓住的是残留的 `'甲'` / `'乙'`（它们落在了 `t(...)` 的括号之外）。
  //   第一版我把 `'丙'` 也写进了期望，那是错的期望。
  assert.deepEqual([...unwrappedLiterals(sample)].sort(), ['未翻的句子', '甲', '乙'].sort(),
    '扫描器必须抓住"完全没包"与"包了但续行残留"两种')
  // 注释与 console 不算。
  assert.equal(unwrappedLiterals("// 注释里的中文\nconsole.warn('日志中文')").size, 0)
  // ★ 闭合的反引号**不许**被当成开引号（正则版本就在这里报出过跨几百行的假字符串）。
  const bt = "x.className = `dot ${a}`\nconst y = 1\nconst z = '中'\nconst w = `t ${b}`"
  assert.deepEqual([...unwrappedLiterals(bt)], ['中'],
    '只有那个单引号里的中文该被报 —— 反引号必须由状态机配对，不能靠正则猜')
  // 模板字面量里的单引号不许把扫描带偏（`?? ''` 那个坑）。
  const tpl = "label: `手机 ${navigator.platform ?? ''}`"
  assert.deepEqual([...unwrappedLiterals(tpl)], ["手机 ${navigator.platform ?? ''}"],
    '模板字面量应当被当作一个整体，而不是从里面的单引号起头乱吃')
  // `toast(` / `format(` 里的 t 不算 `t(` 调用。
  assert.deepEqual([...unwrappedLiterals("fmt('中文A')\nblog('中文B')")].sort(), ['中文A', '中文B'].sort(),
    '标识符边界要认 —— 否则 `blog(` 会被当成 `t(` 而漏报')
})

/**
 * **投影层的生产者**：它们返回中文（同时就是 key），由渲染处 `t(...)` 翻。
 *
 * ★ 为什么需要单独一条判据 —— `unwrappedLiterals` 只看得见**字面量**。
 *   `m.textContent = taskMeta(t)` 这种**函数调用**它一个字也看不见，
 *   而 `taskMeta` 返回的正是"等电脑领取""尚无执行记录""高优先级"这些中文标签。
 *   实测：破坏性验证把 `btn.title = t(plan.message)` 改回 `btn.title = plan.message`，
 *   **35 条判据全绿**。
 *
 * 规则：**凡是把生产者写进 DOM 的那一行，必须同时出现 `t(`。**
 * 这条规则盯的是"消费者有没有翻"，与上面那条盯"生产者有没有英文"互补。
 */
const PRODUCERS = [
  ['taskLine', 'board.mjs 的任务行文案'],
  ['taskMeta', 'board.mjs 的任务元信息标签'],
  ['plan.message', 'notify-plan.mjs 的提醒按钮提示'],
  ['viewOf(', 'board.mjs 的视角标签'],
  ['col.title', 'board.mjs 的列标题'],
  ['state.conn.label', 'timeline.mjs 的状态条标签'],
  ['state.conn.detail', 'timeline.mjs 的状态条详情'],
  ['v.label', 'board.mjs 的视角标签'],
  ['o.label', 'board.mjs 的意图标签'],
  ['cur.hint', 'board.mjs 的意图提示'],
]

test('★★★ 凡是把投影层的输出写进 DOM 的那一行，必须包 t()', () => {
  const app = read('app.mjs')
  const lines = app.replace(/\r\n/g, '\n').split('\n')
  const offenders = []
  for (const [producer, what] of PRODUCERS) {
    let seen = 0
    for (const line of lines) {
      if (!line.includes(producer)) continue
      // 只看**写 DOM 文本**的那些行。
      if (!/\.(textContent|title|placeholder|innerHTML)\s*=/.test(line)) continue
      seen += 1
      if (!/\bt\(/.test(line)) offenders.push(`${producer}（${what}）→ ${line.trim().slice(0, 90)}`)
    }
    // 生产者不许"消失"：一个都没匹配到说明判据已经跟不上代码（改名了）。
    assert.ok(seen > 0, `找不到任何把 ${producer} 写进 DOM 的行 —— 它改名了？这条判据要跟着改`)
  }
  assert.deepEqual(offenders, [],
    '这些行把投影层的中文直接写进了 DOM，没有经过 t() ——\n'
    + '英文模式下它们会原样显示中文，而"未包 t() 的字面量"那支判据看不见函数调用：\n  '
    + offenders.join('\n  '))
})

test('★ 反例守卫：生产者判据不是恒真', () => {
  const bad = '  m.textContent = taskMeta(t)'
  const good = '  m.textContent = t(taskMeta(t))'
  const isDomWrite = (l) => /\.(textContent|title|placeholder|innerHTML)\s*=/.test(l)
  assert.ok(isDomWrite(bad) && !/\bt\(/.test(bad), '未包 t() 的写法必须被判为不合格')
  assert.ok(isDomWrite(good) && /\bt\(/.test(good), '包了 t() 的写法必须合格')
})

test('★★★ app.mjs 里那几个**咽喉函数**必须真的包了 t()', () => {
  // ★ 破坏性验证抓出来的洞：把 `$('toast-text').textContent = t(message)` 改回
  //   `= message`（于是**登录之后所有错误**在英文模式下仍然是中文），
  //   25 条判据**全绿**。上面那些覆盖率判据只问"`t('…')` 里的中文有没有英文"，
  //   它们**不问**"那条消息到底有没有被 `t()` 包上"。
  //
  //   > 一支"检查已标记项"的判据，与一支"检查该标记项"的判据，
  //   > 在没人漏标记的时候是同一个东西。
  //
  //   这几个函数是**唯一**把消息写进 DOM 的地方 —— 它们翻不翻，决定了
  //   "英文模式下的错误提示是英文还是中文"。
  const app = read('app.mjs')
  const chokePoints = [
    ['toast', /= t\(message\)/],
    ['showError', /= t\(message\)/],
    ['showNotice', /= t\(message\)/],
    ['showPopupText', /= t\(text\)/],
  ]
  for (const [fn, re] of chokePoints) {
    const body = functionBody(app, fn)
    assert.match(body, re,
      `${fn}() 没有把消息交给 t() —— 英文模式下它输出的仍是中文，而不会有任何东西变红`)
  }
})

test('★ 反例守卫：咽喉判据不是恒真（不包 t() 的版本必须被抓住）', () => {
  // ⚠️ 别用 `includes('t(message)')` —— `toas**t(message)**` 里就有这个子串，
  //    于是"没包 t()"的版本也会被判为已翻。判据自己踩过一次这个坑。
  const naive = 'function toast(message) { $("toast-text").textContent = message }'
  assert.doesNotMatch(naive, /=\s*t\(message\)/, '未包 t() 的版本不该被判为已翻')
  const fixed = 'function toast(message) { $("toast-text").textContent = t(message) }'
  assert.match(fixed, /=\s*t\(message\)/)
})

test('★★★ app.mjs 必须真的应用语言（把原文写进 DOM 的那一处）', () => {
  const app = read('app.mjs')
  assert.match(app, /from '\.\/i18n\.mjs'/, 'app.mjs 必须 import i18n')
  assert.match(app, /applyStaticI18n\(/, '静态文案要被替换（否则切语言只影响 JS 生成的部分）')
  assert.match(app, /setLocale\(/, '必须真的设定当前语言')
})

test('★★★ index.html 必须有语言切换入口，且进入主界面后才出现', () => {
  assert.match(HTML, /id="btn-lang"/, '要有语言切换按钮')
  // 与页签/刷新/退出同一类"头部动作"：登录页上画着它就是"看得见、点不动"。
  assert.match(HTML, /body:not\(\[data-screen="app"\]\)[^{]*#btn-lang/,
    '语言按钮应当只在主界面出现（与其余头部动作一致）')
})

test('★ html[lang] 必须跟着语言走（读屏与字体选择都靠它）', () => {
  const app = read('app.mjs')
  assert.match(app, /documentElement\.lang/, '切换语言时要同步 <html lang>')
})
