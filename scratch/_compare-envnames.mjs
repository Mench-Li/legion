// scratch/_compare-envnames.mjs —— 直接比较 HEAD 版与工作树版的 specFor().envNames（**不提交**）
//
// 做法：把 HEAD 版的 process-manifest.mjs 写到临时目录，用**真模块** import 它，
// 而不是用正则去猜文件结构（第一版正则没匹配上，于是打印出空的数组，
// 而"空数组"看起来就像"这个进程没有 envNames"——又一个看起来像发现的坏读数）。
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = 'D:/project/DSH/legion'
const headSrc = execFileSync('git', ['show', 'HEAD:product/process-manifest.mjs'],
  { cwd: ROOT, encoding: 'utf8' })

const dir = mkdtempSync(join(tmpdir(), 'pm-'))
const tmpFile = join(dir, 'process-manifest.mjs')
writeFileSync(tmpFile, headSrc, 'utf8')

const headMod = await import(pathToFileURL(tmpFile).href)
const treeMod = await import(pathToFileURL(join(ROOT, 'product/process-manifest.mjs')).href)

for (const proc of ['runtime', 'orchestrator']) {
  const a = headMod.specFor(proc).envNames.slice().sort()
  const b = treeMod.specFor(proc).envNames.slice().sort()
  const same = JSON.stringify(a) === JSON.stringify(b)
  console.log(`${proc}: HEAD ${a.length} 个 / 工作树 ${b.length} 个 —— ${same ? '★ 完全一致' : '✖ 不同'}`)
  if (!same) {
    console.log('   HEAD 独有: ' + a.filter((k) => !b.includes(k)).join(', '))
    console.log('   工作树独有: ' + b.filter((k) => !a.includes(k)).join(', '))
  }
  console.log('   ' + b.join(', '))
  console.log('')
}
