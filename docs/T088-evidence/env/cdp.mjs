// T-088 L2 CDP harness：spawn headless Chrome（stdio ignore，沙箱允许）→ CDP Runtime.evaluate 驱动真实浏览器
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = process.env.CDP_PORT || '9223'

export async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 't088-chrome-'))
  const child = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: 'ignore' })
  // 等待调试端点就绪
  let ok = false
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) { ok = true; break } } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 300))
  }
  if (!ok) { try { child.kill() } catch {} ; throw new Error('chrome CDP endpoint not ready') }
  return child
}

export async function newPage(url) {
  const r = await fetch('http://127.0.0.1:' + PORT + '/json/new?url=' + encodeURIComponent(url), { method: 'PUT' })
  if (!r.ok) throw new Error('new page failed ' + r.status)
  return r.json()
}

export async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result) }
  }
  return {
    send(method, params = {}) { return new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })) }) },
    close() { try { ws.close() } catch {} },
  }
}

/** 等待页面条件（js 表达式为真） */
export async function waitFor(c, expr, timeoutMs = 15000, label = '') {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      last = r.result && r.result.value
      if (last === true) return true
    } catch { /* page mid-load */ }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('waitFor timeout: ' + (label || expr.slice(0, 120)) + ' (last=' + JSON.stringify(last) + ')')
}

/** Runtime.evaluate → value */
export async function evalJS(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 400))
  return r.result && r.result.value
}
