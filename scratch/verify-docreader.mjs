/**
 * verify-docreader.mjs — workbench「产出文档」放大阅读层端到端验证（真实 Chrome + 仓库自带零依赖 CDP 基座）。
 *
 * 前置：workbench 已 build 且本地服务在跑（`pnpm --dir workbench build` + `node workbench/scripts/serve.mjs --port 5173`）。
 * 运行：`node scratch/verify-docreader.mjs`（可用 WB_URL 覆盖地址）。
 * 输出：控制台 JSON 读数 + 截图落盘 scratch/docreader-shots/（截图不入库，与 .ci/e2e-shots 同一口径）。
 *
 * 读数口径：详情内嵌预览高度随视口且字号 > 13px；放大阅读层存在、正文单层滚动、字号随 A+/A− 变化；
 * Esc 关闭阅读层且任务详情仍在；控制台错误/页面异常为 0。
 */
import { launchBrowser, browserProbe } from '../scripts/e2e/cdp.mjs'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.WB_URL || 'http://127.0.0.1:5173/'
const SHOTS = join(HERE, 'docreader-shots')
mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const probe = browserProbe()
if (!probe.available) { console.log('NO BROWSER'); process.exit(1) }

const browser = await launchBrowser({ headless: true, width: 1920, height: 900 })
const page = await browser.newPage({ width: 1920, height: 900 })
const out = {}
try {
  await page.goto(BASE)
  await sleep(3000)
  await page.evaluate(() => {
    const nav = [...document.querySelectorAll('.nav-item')].find(n => (n.textContent || '').includes('任务中心'))
    nav?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await sleep(3500)

  // 候选任务：先 T-131（截图里的样品下单清单），失败再取任意 requirement/researcher/soldier-sourcing 卡
  const candidates = ['T-131', 'soldier-sourcing', 'requirement', 'researcher', 'tester']
  let opened = null
  for (const key of candidates) {
    const ok = await page.evaluate((k) => {
      const cards = [...document.querySelectorAll('.tc-card.clickable')]
      const card = cards.find(c => (c.textContent || '').includes(k))
      if (!card) return false
      card.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return true
    }, key)
    if (!ok) continue
    await sleep(2500)
    const hasDoc = await page.evaluate(() => [...document.querySelectorAll('.td-section-title')].some(t => (t.textContent || '').includes('产出文档')))
    if (hasDoc) { opened = key; break }
    await page.evaluate(() => document.querySelector('.modal-head .x')?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await sleep(1200)
  }
  out.openedBy = opened
  out.modalBox = await page.evaluate(() => {
    const m = document.querySelector('.modal.task-detail-modal')
    if (!m) return null
    const r = m.getBoundingClientRect()
    return { w: Math.round(r.width), h: Math.round(r.height), maxWidth: getComputedStyle(m).maxWidth }
  })
  out.docSection = await page.evaluate(() => {
    const sec = [...document.querySelectorAll('.td-section')].find(s => (s.textContent || '').includes('产出文档'))
    if (!sec) return null
    const items = [...sec.querySelectorAll('.doc-item')].map(it => (it.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 70))
    return { items, itemCount: items.length }
  })
  await page.screenshot(SHOTS + '/02-modal-doc-section.png')

  // 打开第一条的内嵌预览
  out.previewClicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.doc-item .btn.mini')].find(b => (b.textContent || '').includes('预览'))
    if (!btn) return false
    btn.click()
    return true
  })
  await sleep(2500)
  out.inline = await page.evaluate(() => {
    const pv = document.querySelector('.doc-preview')
    if (!pv) return null
    const md = pv.querySelector('[data-md-view], .doc-plain')
    const err = pv.querySelector('.doc-err')
    const r = pv.getBoundingClientRect()
    return {
      previewH: Math.round(r.height),
      mdFont: md ? getComputedStyle(md).fontSize : null,
      mdScrollH: md ? md.scrollHeight : null,
      mdClientH: md ? md.clientHeight : null,
      err: err ? (err.textContent || '').slice(0, 120) : null,
      headText: (md?.textContent || '').replace(/\s+/g, ' ').slice(0, 120),
      hasReaderBtn: [...document.querySelectorAll('.doc-item .btn.mini')].some(b => (b.textContent || '').includes('放大阅读')),
    }
  })
  await page.screenshot(SHOTS + '/03-inline-preview.png')

  // 点「⤢ 放大阅读」
  out.readerClicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.doc-item .btn.mini')].find(b => (b.textContent || '').includes('放大阅读'))
    if (!btn) return false
    btn.click()
    return true
  })
  await sleep(1200)
  out.reader = await page.evaluate(() => {
    const rd = document.querySelector('.doc-reader')
    if (!rd) return null
    const body = rd.querySelector('.doc-reader-body')
    const md = rd.querySelector('[data-md-view], .doc-reader-plain')
    const r = rd.getBoundingClientRect()
    const mdr = md?.getBoundingClientRect()
    return {
      readerW: Math.round(r.width), readerH: Math.round(r.height),
      bodyScrollH: body.scrollHeight, bodyClientH: body.clientHeight,
      mdFont: md ? getComputedStyle(md).fontSize : null,
      mdW: mdr ? Math.round(mdr.width) : null,
      zoomLabel: rd.querySelector('.doc-reader-zoom')?.textContent,
      head: (rd.querySelector('.doc-reader-title')?.textContent || '').slice(0, 60),
      tools: [...rd.querySelectorAll('.doc-reader-tools .btn')].map(b => b.textContent),
    }
  })
  await page.screenshot(SHOTS + '/04-reader.png')

  // A+ 两下 → 字号应随之增大
  await page.evaluate(() => {
    const plus = [...document.querySelectorAll('.doc-reader-tools .btn')].find(b => (b.textContent || '').trim() === 'A+')
    plus?.click(); plus?.click()
  })
  await sleep(600)
  out.afterZoom = await page.evaluate(() => {
    const rd = document.querySelector('.doc-reader')
    const md = rd?.querySelector('[data-md-view]')
    return { font: md ? getComputedStyle(md).fontSize : null, label: rd?.querySelector('.doc-reader-zoom')?.textContent }
  })
  await page.screenshot(SHOTS + '/05-reader-zoom.png')

  // Esc 关闭阅读层（任务详情应仍在）
  await page.press('Escape')
  await sleep(600)
  out.afterEsc = await page.evaluate(() => ({
    readerGone: document.querySelector('.doc-reader') === null,
    modalStillOpen: document.querySelector('.modal.task-detail-modal') !== null,
  }))
  await page.screenshot(SHOTS + '/06-after-esc.png')

  out.consoleErrors = page.consoleErrors
  out.pageErrors = page.pageErrors
  console.log(JSON.stringify(out, null, 2))
} finally {
  await page.close()
  await browser.close()
}
