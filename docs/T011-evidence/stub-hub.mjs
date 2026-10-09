// T-011 测试证据：本地 Hub 替身，用来捕获 _phone-act.mjs 实际发出的 body。
// 只做证据采集，不修改任何产品代码。
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const out = process.argv[2]
const port = Number(process.argv[3] ?? 8791)
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    const send = (o) => res.end(JSON.stringify(o))
    if (req.method === 'POST' && req.url === '/api/identity/login') return send({ accessToken: 't' })
    if (req.method === 'GET' && req.url.startsWith('/api/agents')) return send({ agents: [{ agentId: 'a1', role: 'coder', name: 'coder' }] })
    if (req.method === 'POST' && req.url === '/api/agent-conversations') return send({ convId: 'c1' })
    if (req.method === 'POST' && req.url === '/api/agent-messages') {
      writeFileSync(out, body)
      return send({ ok: true, msgId: 'm1' })
    }
    return send({ ok: true })
  })
})
server.listen(port, '127.0.0.1', () => console.log('LISTENING ' + port))
