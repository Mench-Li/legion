// scripts/qa/update-e2e-live.mjs
// ============================================================================
// **活体**更新闭环验证：让一个**真的装在磁盘上的 Legion** 去真实托管上取更新。
//
// 与 `tests/e2e-unified/update.e2e.test.mjs` 的分工：
//
//   · 那一个是**离线**的（内存替身托管、合成清单）——它守协议的每一条分支，
//     可以在 CI 里跑一千遍；
//   · 这一个是**活的**：真网络、真签名、真安装树、真 helper。
//     它只在有人真的想确认"这条链现在通不通"时跑。
//
//   > 一个"对着自己写的静态替身验证通过的更新链路"，
//   > 与一个"真的能从生产托管取到更新"的链路，在测试报告上是同一个东西——
//   > 只不过前者在缓存头写错时照样是绿的。
//   > （这一条是实测踩出来的：Hub 发 `max-age=86400` 而客户端要 `immutable`，
//   >   替身发的却是客户端想要的那个值，于是谁也看不见。）
//
// ## 用法
//
//   node scripts/qa/update-e2e-live.mjs --install-root <安装树的 resources/legion>
//                                      [--cache-dir <目录>] [--data-dir <目录>]
//                                      [--node <node.exe>] [--helper <helper-entry.mjs>]
//
// `--install-root` 是**安装树**里的 `resources/legion`：
//   由 `desktop/main.mjs` 的 `installRoot = join(process.resourcesPath, 'legion')` 定出。
// 其余参数默认从它的兄弟目录推出来（`../node/node.exe`、`../update/helper-entry.mjs`）。
//
// ## 它验证到哪一步 —— 以及**为什么停在 install**
//
// 实测（2026-10-10，装 0.1.3、托管上是 0.1.4）能走完：
//
//   idle → checking → available → downloading → verifying → ready → waiting-for-tasks
//
//   · `check`  —— 真网络取签名通道清单，报 `feed-newer-available`「发现 0.1.4（本机 0.1.3）」
//   · `download` —— 真的下 6,735,582 字节，逐文件摘要 + 闭包校验通过 → `ready`
//   · `install` —— **被设计上的守卫拦下**（见下）
//
// 拦下它的两条日志：

//     [update] 读不到在途任务读数，本次安装会被预检拦下（查不到 ≠ 没有）
//     [update] 拿不到 Launcher 的实际端口读数：健康检查的身份断言需要它，本次升级不会提交
//
// 这两条**不是缺陷，是守卫**：
//   · 第一个读的 `readPendingTasks()` —— 有任务在途时换程序目录会把它们打断；
//     "读不到"与"没有"必须分开，否则一个连不上 Launcher 的时刻会被当成"很安全"。
//   · 第二个读的 `readLauncherPorts()` —— 健康检查要断言"应答的确实是我这个实例"
//     （`expectJson: { port }`）。拿默认端口去问会**看似通过**。
//
// 两者都通过 `bridge` 问 Launcher，而 `bridge` 由 `runtime.mjs` 建（要 Launcher 在跑）。
// 所以**这一步要求应用真的在运行** —— 本脚本刻意**不**塞一个假的 bridge：
// 那恰好会把上面两条判据变成"永远说没问题"，而它们存在的理由就是不要说谎。
//
//   ⚠️ 因此：跑到 `ready` 之后，剩下的"点一下装"必须由**真实的运行中的应用**完成
//      （托盘/更新面板）。本脚本把这个边界如实报出来，而不是假装走完了。
//
// ## 退出码
//
//   0  走到 `ready`（检查 + 下载 + 校验都通过）
//   3  走到 `ready` 但 install 被守卫拦下（**预期结果**，见上）
//   2  没有候选（托管上没有比本机新的版本）
//   1  硬失败（配置不可用、取清单失败、校验失败…）
// ============================================================================
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function parseArgs(argv) {
  const out = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const next = argv[i + 1]
    out.set(token.slice(2), next !== undefined && !String(next).startsWith('--') ? next : 'true')
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const installRoot = args.get('install-root')
if (typeof installRoot !== 'string') {
  process.stderr.write('update-e2e-live 需要 --install-root <安装树的 resources/legion>\n')
  process.exit(2)
}
const absInstall = resolve(installRoot)
const resourcesDir = dirname(absInstall)
const nodePath = args.get('node') ?? join(resourcesDir, 'node', 'node.exe')
const helperEntry = args.get('helper') ?? join(resourcesDir, 'update', 'helper-entry.mjs')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const cacheDir = args.get('cache-dir') ?? join(tmpdir(), `legion-e2e-cache-${stamp}`)
const dataDir = args.get('data-dir') ?? join(tmpdir(), `legion-e2e-data-${stamp}`)

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
function installedVersion(root) {
  return readJson(join(root, 'product', 'release', 'runtime-manifest.json'))?.productVersion ?? null
}

/** 与 `resolveUpdateRuntime` 同源（`update-wiring.mjs` 就是要打进安装包的那份代码）。 */
const wiring = await import(pathToFileURL(join(REPO_ROOT, 'desktop', 'update-wiring.mjs')).href)

console.log('=== 起始状态 ===')
console.log('  installRoot        =', absInstall)
console.log('  已装 productVersion =', installedVersion(absInstall))
const cfg = readJson(join(absInstall, 'product', 'release', 'update-config.json'))
if (cfg === null) { console.log('  ✖ 读不到 update-config.json —— 安装树不完整'); process.exit(1) }
const channel = cfg.defaultChannel ?? 'stable'
console.log('  通道               =', channel, '→', `${cfg.channels?.[channel]?.origin ?? '?'}${cfg.channels?.[channel]?.prefix ?? ''}`)
const trust = readJson(join(absInstall, 'product', 'release', 'update-trust.json'))
console.log('  信任表             =', (trust?.keys ?? []).map((k) => k.keyId).join(', ') || '(空 —— 验不了签)')
console.log('  nodePath           =', nodePath, existsSync(nodePath) ? '' : '（缺！）')
console.log('  helperEntry        =', helperEntry, existsSync(helperEntry) ? '' : '（缺！）')
console.log('  cacheDir           =', cacheDir)
console.log('  dataDir            =', dataDir)

mkdirSync(cacheDir, { recursive: true })
mkdirSync(dataDir, { recursive: true })

console.log('\n=== 建运行时（产品代码 + 安装树的配置）===')
const runtime = await wiring.resolveUpdateRuntime({
  installRoot: absInstall,
  cacheDir,
  dataDir,
  nodePath,
  helperEntry,
  registerIpc: false,
  log: (m) => console.log('    [log]', m),
})
if (runtime.ok !== true) {
  console.log('  ✖ 运行时不可用：', runtime.reason)
  process.exit(1)
}
const { client } = runtime
console.log('  config usable =', runtime.config?.usable, '| channel =', runtime.config?.channel)

const trail = []
client.subscribe((s) => { trail.push(String(s.state)) })

console.log('\n=== ① check —— 真实网络上的签名通道清单 ===')
const checkResult = await client.check({ trigger: 'manual' })
console.log('  outcome =', checkResult?.outcome, '| code =', checkResult?.code)
console.log('  reason  =', checkResult?.reason)
const candidate = client.candidate()
if (!candidate) {
  console.log('\n没有候选（托管上没有比本机新的版本）。')
  runtime.close?.()
  process.exit(2)
}
console.log('  candidate =', candidate.releaseId, 'v' + candidate.productVersion, 'seq=' + (candidate.sequence ?? '?'))

console.log('\n=== ② download —— 真下升级包并逐文件校验 ===')
let lastPct = -1
await client.download(candidate.releaseId, candidate.manifestSha256, {
  onProgress: (p) => {
    const pct = p.total > 0 ? Math.floor((p.bytes / p.total) * 100) : -1
    if (pct >= 0 && Math.floor(pct / 25) !== Math.floor(lastPct / 25)) {
      console.log(`    ${p.phase} ${pct}% (${p.bytes}/${p.total})`)
      lastPct = pct
    }
  },
})
const ready = client.ready()
console.log('  ready =', ready === null ? '(无)' : `${ready.releaseId} v${ready.productVersion}`)
if (ready === null) {
  console.log('  ✖ 没有拿到 ready 身份 —— 下载或校验失败')
  console.log('  状态轨迹:', trail.join(' → '))
  runtime.close?.()
  process.exit(1)
}

console.log('\n=== ③ install —— 真实切换（起 helper 换程序目录）===')
console.log('  ⚠ 这一步需要**应用正在运行**（Launcher 在，bridge 才答得上话）。')
console.log('    拿不到就会 fail-closed —— 那是设计，不是故障。')
try {
  await client.install(ready.releaseId, ready.manifestSha256, {
    onProgress: (p) => console.log(`    ${p.phase} ${p.bytes ?? ''}/${p.total ?? ''}`),
  })
} catch (error) {
  console.log('  install 抛错：', error?.message ?? error)
}

console.log('\n=== 结果 ===')
const uniqueTrail = [...new Set(trail)]
console.log('  状态轨迹:', uniqueTrail.join(' → '))
const after = installedVersion(absInstall)
console.log('  安装树 productVersion =', after, after === ready.productVersion ? '（已切换）' : '（未切换）')
const versionsDir = join(absInstall, 'versions')
if (existsSync(versionsDir)) {
  const { readdirSync } = await import('node:fs')
  console.log('  versions/ =', readdirSync(versionsDir).join(', '))
}
runtime.close?.()

const switched = after === ready.productVersion
if (switched) { console.log('\n✔ 更新闭环走完（含切换）'); process.exit(0) }
console.log('\n⛔ 走到 ready 但未切换 —— 若日志里是上面那两条守卫，说明这是**预期**结果：')
console.log('   校验与下载都通，切换需要真实的运行中的应用（用户点一下）。')
process.exit(3)
