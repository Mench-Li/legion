import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../../', import.meta.url))
const version = '24.19.0'
const filename = `node-v${version}-win-x64.zip`
const origin = `https://nodejs.org/dist/v${version}/`
const input = join(root, 'desktop', 'payload', 'node.json')
const build = join(root, '.desktop-build')

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) })
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 builder required')
  await mkdir(build, { recursive: true })
  if (process.argv.includes('--resolve-checksum')) {
    const sums = (await download(`${origin}SHASUMS256.txt`)).toString('utf8')
    const sha256 = sums.split(/\r?\n/).find(line => line.endsWith(`  ${filename}`))?.split(' ')[0]
    if (!/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw new Error('Node archive checksum missing')
    await writeFile(input, `${JSON.stringify({ version, platform: 'win32', arch: 'x64', filename, sha256, url: origin + filename }, null, 2)}\n`)
  }
  const spec = JSON.parse(await readFile(input, 'utf8'))
  if (spec.version !== version || spec.filename !== filename || spec.url !== origin + filename) throw new Error('Node input mismatch')
  const zip = join(build, filename)
  let bytes
  try { bytes = await readFile(zip) } catch { bytes = await download(spec.url) }
  if (createHash('sha256').update(bytes).digest('hex') !== spec.sha256) throw new Error('Node archive checksum mismatch')
  await writeFile(zip, bytes)
  // 解压：**内联命令 + 环境变量传路径**，不写 .ps1 文件。
  //
  // 原来这里写一个 `expand-node.ps1` 再用 `-File` 执行。那条路会撞上机器的
  // PowerShell 执行策略：策略管的是**脚本文件**，于是 ExecutionPolicy 为
  // Restricted/AllSigned 的机器上，构建会在这一步失败，而报错是
  // 「无法加载文件…因为在此系统上禁止运行脚本」——**一句话也没提构建**，
  // 看的人会去查签名策略，而真正的原因是这个构建步骤不该依赖它。
  //
  //   > 一个"因为构建脚本是 .ps1 而被策略拦下"的失败，
  //   > 与一个"解压真的坏了"的失败，在日志里是同一句话。
  //
  // 内联 `-Command` 不经过脚本文件，因此与执行策略无关。命令串是**常量**，
  // 两个路径走环境变量——原注释要的「命令里没有插值进来的源码」这条性质原样保留。
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:LEGION_EXPAND_ARCHIVE -DestinationPath $env:LEGION_EXPAND_DEST -Force',
    ], {
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, LEGION_EXPAND_ARCHIVE: zip, LEGION_EXPAND_DEST: build },
    })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Archive extraction failed (${code})`)))
  })
  await copyFile(input, join(build, `node-v${version}-win-x64`, 'legion-node.json'))
  console.log(`Verified bundled Node ${version} prepared`)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
