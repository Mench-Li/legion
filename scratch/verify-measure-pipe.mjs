/**
 * 验证 `MEASURE ` 约定**端到端**可用：用 `run-ci.mjs` 起套件的**同一种方式**
 * （`spawn(node, ['--test', file])` + 管道）起那个套件，确认 `MEASURE` 行
 * 真的出现在被捕获的 stdout 里。
 *
 * ## 为什么这一步不能省
 *
 * `console.log` 在测试里到底会不会进到"被捕获的 stdout"，取决于
 * node 测试运行器与 reporter；而 run-ci 是**按管道**捕获的。
 * 我改的两半（套件打印、run-ci 提取）之间，**只有这一半是我没验过的**：
 * 提取那三行过滤逻辑一眼能看，但"行到底有没有出现在 all 里"必须实测。
 *
 *   > 一个"我打印了"与一个"它到达了消费者"，
 *   > 中间隔着 reporter、管道与缓冲——三者都不在我的代码里。
 */
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = 'product/launcher/run-credential-dsh-process.test.mjs'

const child = spawn(process.execPath, ['--test', FILE], {
  cwd: ROOT, windowsHide: true, env: { ...process.env, CI: 'true' },
})
let out = '', err = ''
child.stdout.on('data', (d) => { out += d.toString() })
child.stderr.on('data', (d) => { err += d.toString() })
child.on('exit', (code) => {
  const all = out + '\n' + err
  // run-ci 的三行过滤逻辑，原样复制
  const measureLines = all.split('\n').map((l) => l.trim())
    .filter((l) => l.startsWith('MEASURE ')).slice(0, 4)
  console.log(`退出码: ${code}`)
  console.log(`捕获 stdout ${out.length} 字节 / stderr ${err.length} 字节`)
  console.log(`run-ci 的过滤命中 ${measureLines.length} 行：`)
  for (const l of measureLines) console.log('  → ' + l)
  const ok = code === 0 && measureLines.length > 0
  console.log('')
  console.log(ok
    ? '⇒ PASS：读数行能到达消费者，摘要里会带上它'
    : '⇒ FAIL：读数行没能到达（打印了 ≠ 到达了）')
  process.exit(ok ? 0 : 1)
})
