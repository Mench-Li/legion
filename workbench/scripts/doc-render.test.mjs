// workbench/scripts/doc-render.test.mjs — R-3/S4 MarkdownDocView 结构/安全自动化测试。
// 运行：node workbench/scripts/doc-render.test.mjs（沙箱 spawn 受限时直跑等效；宿主可 node --test）
// 载入方式：vite ssrLoadModule 依赖 esbuild 子进程，宿主受限时降级 ts.transpileModule 直跑等效（零新增依赖）；
// react-dom/server renderToString + 断言见各 describe 用例。
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { renderToString } from 'react-dom/server'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const ts = require('typescript')
const react = require('react')
const componentPath = join(here, '..', 'src', 'components', 'MarkdownDocView.tsx')
const source = readFileSync(componentPath, 'utf8')
const tmpModule = join(here, '.markdown-doc-view.render.mjs')

let MarkdownDocView
let safeHref

before(() => {
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  })
  if (out.diagnostics && out.diagnostics.length > 0) throw new Error('transpile 诊断：' + JSON.stringify(out.diagnostics))
  writeFileSync(tmpModule, out.outputText, 'utf8')
})

after(() => { try { rmSync(tmpModule, { force: true }) } catch { /* 清理 */ } })

before(async () => {
  const mod = await import(pathToFileURL(tmpModule).href)
  MarkdownDocView = mod.default
  safeHref = mod.safeHref
})

function render(md, props = {}) {
  return renderToString(react.createElement(MarkdownDocView, { content: md, ...props }))
}

const STRUCTURE_MD = [
  '# 一级标题',
  '## 二级标题',
  '正文段落第一句，含 **粗体**、*斜体* 与 ~~删除线~~，以及 `inline code` 和 [外链](https://example.com/a)。',
  '---',
  '- 无序项甲',
  '- 无序项乙',
  '  - 嵌套子项乙1',
  '  - 嵌套子项乙2',
  '    - 三级嵌套',
  '1. 有序甲',
  '2. 有序乙',
  '   1. 有序嵌套',
  '> 引用一段',
  '```',
  'const x = 1',
  '```',
  '| 列A | 列B |',
  '| --- | --- |',
  '| a1 | b1 |',
  '| a2 | **b2粗** |',
  '<script>alert(1)</script> 与 <img src=x onerror=alert(1)> 应显示为纯文本。',
  '[危险链接](javascript:alert(1)) 应只显示文字。',
].join('\n')

describe('结构可读（AC-R3-4，D-5 可读等价）', () => {
  it('标题/段落/粗斜体/行内代码/围栏代码块/列表含嵌套/表格/引用/分割线/链接 各就各位且关键文本可见', () => {
    const html = render(STRUCTURE_MD)
    assert.ok(html.includes('<h1>') && html.includes('一级标题'), 'h1 标题')
    assert.ok(html.includes('<h2>') && html.includes('二级标题'), 'h2 标题')
    assert.ok(html.includes('<p>') && html.includes('正文段落第一句'), '段落')
    assert.ok(html.includes('<strong>粗体</strong>'), '粗体')
    assert.ok(html.includes('<em>斜体</em>'), '斜体')
    assert.ok(html.includes('<s>删除线</s>'), '删除线')
    assert.ok(html.includes('<code>inline code</code>'), '行内代码')
    assert.ok(html.includes('<pre>') && html.includes('const x = 1'), '围栏代码块内容可见')
    assert.ok(html.includes('<ul>') && html.includes('<ol>'), '有序无序列表')
    assert.ok(html.includes('无序项甲') && html.includes('无序项乙'), '列表项文本')
    assert.ok(html.includes('嵌套子项乙1'), '嵌套一级可见')
    assert.ok(html.includes('三级嵌套'), '三级嵌套可见')
    assert.ok(html.includes('有序甲') && html.includes('有序乙') && html.includes('有序嵌套'), '有序项文本')
    assert.ok(html.includes('<table>') && html.includes('<thead>') && html.includes('<tbody>'), '表格')
    assert.ok(html.includes('<th>列A</th>') && html.includes('<td>a1</td>'), '表格单元格')
    assert.ok(html.includes('<td><strong>b2粗</strong></td>'), '单元格内行内语法')
    assert.ok(html.includes('<blockquote>') && html.includes('引用一段'), '引用')
    assert.ok(html.includes('<hr') , '分割线')
    assert.ok(html.includes('<a href="https://example.com/a" target="_blank" rel="noreferrer noopener">外链</a>'), '白名单外链')
  })
})

describe('渲染安全（AC-R3-5）', () => {
  it('script 注入 / img onerror 原始 HTML 一律按文本转义输出', () => {
    const html = render(STRUCTURE_MD)
    assert.ok(!html.includes('<script'), '不得输出 script 标签')
    assert.ok(!/<(script|img|svg|iframe|a|div)[^>]*(onerror|onclick|onload)[^>]*>/i.test(html), '不得输出事件属性（转义文本含字样属正常显示）')
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), '内容按文本原样出现')
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'img 注入按文本显示')
  })
  it('javascript: 链接 → 无 href、无协议泄漏、文字保留', () => {
    const html = render(STRUCTURE_MD)
    assert.ok(!html.includes('javascript:'), '不得出现 javascript: 协议')
    assert.ok(html.includes('危险链接'), '链接文字保留')
    assert.ok(html.includes('<span>危险链接</span>'), '危险链接退化为纯文本')
  })
  it('大小写变体与 data: 协议同样拒绝', () => {
    const html = render('[x](JaVaScRiPt:alert(1)) 与 [y](data:text/html,hi)')
    assert.ok(!/javascript:/i.test(html), '不区分大小写拒绝')
    assert.ok(!html.includes('data:text/html'), 'data: 拒绝')
  })
  it('白名单协议与相对路径/# 锚点放行', () => {
    const html = render('[m](mailto:a@b.com) [rel](../docs/x.md) [锚](#sec1) [h](https://ok.example)')
    assert.ok(html.includes('href="mailto:a@b.com"'))
    assert.ok(html.includes('href="../docs/x.md"'))
    assert.ok(html.includes('href="#sec1"'))
    assert.ok(html.includes('href="https://ok.example"'))
  })
  it('代码审查面：源码零 dangerouslySetInnerHTML、协议白名单集中一处', () => {
    assert.ok(!source.includes('dangerouslySetInnerHTML'), '组件不得使用 dangerouslySetInnerHTML')
    assert.ok(source.includes('SAFE_PROTOCOLS') && source.includes('http:') && source.includes('https:') && source.includes('mailto:'), '白名单常量集中可审计')
  })
})

describe('子集契约与文本回退（K6-A）', () => {
  it('未闭合/不支持语法按文本回退不崩溃不吞内容', () => {
    const md = '未闭合 **abc 与 ~~def 与 *ghi 与 [链接(未闭合语法混排普通行'
    const html = render(md)
    assert.ok(html.includes('**abc') && html.includes('~~def') && html.includes('*ghi') && html.includes('[链接(未闭合语法混排') && html.includes('普通行'), '内容不丢')
    assert.ok(!html.includes('</strong>') && !html.includes('</em>') && !html.includes('</s>'), '未闭合语法不得产生半截标签')
  })
  it('空内容不崩溃', () => {
    const html = render('')
    assert.ok(html.includes('data-md-view=""'), '空渲染')
  })
  it('图片语法（子集外）按文本回退', () => {
    const html = render('![alt](https://x/img.png)')
    assert.ok(html.includes('![alt](https://x/img.png)'), '图片按文本显示')
    assert.ok(!html.includes('<img'), '不得渲染 img 标签')
  })
  it('safeHref 单元矩阵', () => {
    assert.equal(safeHref('https://a.b'), 'https://a.b')
    assert.equal(safeHref('#frag'), '#frag')
    assert.equal(safeHref('../x.md'), '../x.md')
    assert.equal(safeHref('javascript:alert(1)'), null)
    assert.equal(safeHref('data:text/html,1'), null)
    assert.equal(safeHref('vbscript:x'), null)
  })
})

describe('真实文档冒烟（R-6 缓解，宿主可用时）', () => {
  it('docs/REQUIREMENTS.md 与 docs/RESEARCH.md 节选渲染不崩溃且关键文本可见', () => {
    for (const name of ['REQUIREMENTS.md', 'RESEARCH.md']) {
      const p = join(here, '..', '..', 'docs', name)
      let text = ''
      try { text = readFileSync(p, 'utf8').slice(0, 6000) } catch { continue }
      const html = render(text)
      assert.ok(html.length > 100, name + ' 渲染输出过短')
      assert.ok(!html.includes('<script'), name + ' 无 script 标签')
    }
  })
})
