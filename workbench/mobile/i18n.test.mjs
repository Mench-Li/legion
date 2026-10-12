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
