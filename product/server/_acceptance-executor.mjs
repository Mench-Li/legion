// 验收用的执行器：读 stdin 的任务，发两条进展，再报一条结果。
//
// 它**故意**包含一段私钥形态的文本，用来在真实链路上验证"出境策略在发送前生效"：
// 那条进展到达 Hub 时应当已经被替换成「已拦下：包含私钥块」。
let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', () => {
  let input = {}
  try { input = JSON.parse(raw) } catch { /* 读不到就按空处理 */ }
  const taskId = input?.task?.id ?? '(未知)'
  const printed = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKC', '-----END RSA PRIVATE KEY-----'].join('\n')
  console.log(JSON.stringify({ type: 'progress', kind: 'step', summary: `开始处理 ${taskId}` }))
  console.log(JSON.stringify({ type: 'progress', kind: 'note', summary: `环境里 PATH=/usr/bin 且 HOME=/root 且 TOKEN=secret` }))
  console.log(JSON.stringify({ type: 'progress', kind: 'note', summary: `发现一段内容：\n${printed}` }))
  console.log(JSON.stringify({ type: 'progress', kind: 'step', summary: '在工作区里写了一个文件' }))
  console.log(JSON.stringify({
    type: 'result',
    outcome: 'completed',
    summary: `已完成 ${taskId}：写了 reports/acceptance.md，测试通过`,
    artifacts: [{ path: 'reports/acceptance.md', hash: 'sha256:demo', size: 128 }],
  }))
})
