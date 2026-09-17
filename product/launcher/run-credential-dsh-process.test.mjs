// product/launcher/run-credential-dsh-process.test.mjs
// ============================================================================
// PRT-509 缺口 ③ 的**真进程**那一半：一个真被启动起来的 DSH 进程，
// 在启动期从 Legion 材料化的那份 `.credentials.yaml` 里把值读了出来。
//
// ## 为什么"提供方读得到"不算数
//
// `run-credential-materialization.test.mjs` 里那条 ★★★★★ 是**进程内**判据：
// 手工 `new Context()`，再把 DSH 的 `LocalCredentialProvider` 类实例化出来问它。
// 它排除了"我们自己再解析一遍 YAML"这个假绿，但没有回答另一半：
//
//   > 一条"DSH 的那个类读得到"的断言，与一条"DSH 真的读到了"的断言，
//   > 在一个根本没起起来的部署里给出同一片绿——只不过前者的绿说明的是
//   > 那个类的行为，而"覆盖层有没有真的被这棵树吃进去"没有任何读数。
//
// 具体到这条线，进程内那半**绕过了**两样真东西：
//   ① DSH 的 profile 装载——`--patch` 覆盖层必须在 base bundle 层与 profile 层
//      **之后**按 id 命中 `credentials` 那一行，否则它按 DSH 的规矩 warn-and-skip，
//      而"文件写好了、覆盖层也写好了"在那种情况下**逐字成立**；
//   ② `$DSH_HOME` 与启动顺序（提供方是在树挂载期装载并首次读文件的）。
// 这两样恰好就是"我们指过去了"与"它读到了"之间的那一截——
// 也就是 PRT-509 反复出现的那种"线中间是空的"。
//
// ## 这一条起的是真进程
//
// 真 `apps/cli` 入口、真 profile、真 `--patch` 覆盖层、真 `dsh-credentials-local`；
// 读数是挂进那棵树里的探针插件写的（`fixtures/prt509-credentials-probe.mjs`），
// 而判据里有 **`source === 'file'`**：它把"值其实来自继承来的环境变量"这条
// 假绿也堵掉——那种情况下提供方照样答得出来，而文件根本没被读过。
//
// ## 纪律
//
//   · 没有 `DSH_CHECKOUT`（或没有构建好的 CLI）时**整条 skip**，不伪造通过；
//   · `$DSH_HOME` 与 operator home 都在 `mkdtempSync` 出来的临时目录下（并断言），
//     绝不碰真实的 `$DSH_HOME`；
//   · 子进程环境里**清掉**本用例要查的那个名字，并覆盖掉任何继承来的模型 key，
//     这样 `source === 'file'` 才有意义，也不会用到真实凭证；
//   · 值不入断言，只比 sha256。
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { materializeRunCredentials } from '../../security/secrets/credential-materializer.mjs'
import { resolveLayout } from '../paths.mjs'
import {
  RUNTIME_MODEL_KEY_REF,
  runCredentialOverlayDocument,
  runCredentialPaths,
} from './run-credential-materialization.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PROBE_PLUGIN = join(HERE, 'fixtures', 'prt509-credentials-probe.mjs')

/** DSH 侧的寻址名。与进程内那条用例取同一个名字，两条可以直接对照。 */
const DSH_NAME = 'PROBE_API_KEY'
/** 材料化时写进去的那把值（假值；本文件只比它的 sha256）。 */
const PROBE_VALUE = 'probe-value-0'
const PROFILE = 'prt509probe'
const HOST_TIMEOUT_MS = 120000

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const yamlPath = (p) => p.replace(/\\/g, '/')

/**
 * 一个手写的冻结句柄：形状与 `openRunCredentials()` 的产物一致。
 * 与 `run-credential-materialization.test.mjs` 里那个同形——两条用例的
 * 差别应当**只有**"谁来读那份文件"，别的变量越少，读数越好读。
 */
function probeHandle(refs = [RUNTIME_MODEL_KEY_REF]) {
  const held = new Map(refs.map((r, i) => [r, `probe-value-${i}`]))
  return {
    version: 1,
    runId: 'run-prt509-dsh-process',
    resolvedAt: '2026-09-16T00:00:00.000Z',
    refs: Object.freeze([...refs]),
    held: (ref) => held.has(ref),
    get: (ref) => {
      if (!held.has(ref)) throw new Error('not-held')
      return held.get(ref)
    },
  }
}

/** 起一个真 DSH 进程，等它自己退出（探针里调 `appExit`）；超时则杀掉。 */
function runHost({ cliBin, cwd, env, args, timeoutMs }) {
  const child = spawn(process.execPath, [cliBin, ...args], {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d.toString('utf8') })
  child.stderr.on('data', (d) => { err += d.toString('utf8') })
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      resolve('TIMEOUT')
    }, timeoutMs)
    child.once('close', (code) => { clearTimeout(timer); resolve(code) })
    child.once('error', (e) => { clearTimeout(timer); resolve(`SPAWN-ERROR:${e?.code ?? e?.name}`) })
  })
  return done.then((code) => ({ code, out, err }))
}

test('★★★★★ 缺口 ③（真进程）：一个真 DSH 进程在启动期从 Legion 那份文件里读到了值', async (t) => {
  const checkout = (process.env.DSH_CHECKOUT ?? '').trim()
  if (checkout === '') {
    t.skip('未配置 DSH_CHECKOUT：这一条要一个真的 DSH 检出才能起进程')
    return
  }
  const cliBin = join(checkout, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(cliBin)) {
    // 检出在但没有构建产物：**skip 并说明**，不伪造通过。
    t.skip(`DSH 检出里没有构建好的 CLI（${cliBin}）——先构建 DSH 再跑这一条`)
    return
  }

  const root = mkdtempSync(join(tmpdir(), 'legion-prt509-dshproc-'))
  // 安全断言：整套东西必须落在临时目录里，绝不碰真实的 `$DSH_HOME`。
  assert.ok(root.startsWith(tmpdir()), `临时根不在 tmpdir 下：${root}`)
  const home = join(root, 'dsh-home')
  const operatorHome = join(root, 'operator-home')
  const outFile = join(root, 'probe-reading.json')
  const profileDir = join(home, 'profiles', PROFILE)
  let result = null
  try {
    // `resolveLayout()` 返回 `{layout, diagnostics}`——取 `.layout`，
    // 而不是把外壳当成布局（那样 `productHome` 是 undefined，
    // 于是"没有产品家目录"这条诊断会把真正的原因盖住）。
    const { layout } = resolveLayout({
      installDir: new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
      dataDir: join(root, 'data'),
      workspaceDir: join(root, 'ws'),
      homeDir: root,
      env: {},
    })
    const paths = runCredentialPaths(layout)
    assert.equal(paths.ok, true, paths.message ?? '')

    // ── Legion 侧：用**真的**材料化器把值写进 Legion 自有的那份 DSH 文档。
    mkdirSync(paths.allowedRoot, { recursive: true })
    mkdirSync(operatorHome, { recursive: true })
    materializeRunCredentials({
      handle: probeHandle([RUNTIME_MODEL_KEY_REF]),
      targetFile: paths.targetFile,
      mapping: { [RUNTIME_MODEL_KEY_REF]: DSH_NAME },
      allowedRoot: paths.allowedRoot,
      operatorHomes: [operatorHome],
    })
    // 用**真的**覆盖层渲染器把"把 DSH 的凭证提供方指过去"写成补丁。
    writeFileSync(paths.overlayFile, runCredentialOverlayDocument({ targetFile: paths.targetFile }), 'utf8')

    // ── DSH 侧：一个最小 profile，只多插一行探针。
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      name: `dsh-profile-${PROFILE}`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, undefined, 2)}\n`)
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'),
      'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    writeFileSync(join(profileDir, 'cordis.patch.yml'),
      '# PRT-509 缺口 ③ fixture profile（临时 home，绝不碰真实的 $DSH_HOME）。\n'
      + '- insert:\n'
      + '    - id: prt509-probe\n'
      + `      name: 'file:///${yamlPath(PROBE_PLUGIN)}'\n`
      // 引线走**组合行的 config**（`apply(ctx, config)`），不走进程环境：
      // 把"今天这个夹具要几个旋钮"登记进产品的 env schema，会让那份 schema
      // 从此多出几个只有用例才会设的名字。
      + '      config:\n'
      + `        ref: ${JSON.stringify(DSH_NAME)}\n`
      + `        otherRef: ${JSON.stringify(RUNTIME_MODEL_KEY_REF)}\n`
      + `        outFile: ${JSON.stringify(yamlPath(outFile))}\n`)

    // ── 起真进程。
    const env = { ...process.env }
    // 清掉子进程环境里**本用例要查的那个名字**：不清的话提供方会从继承的环境
    // 里答出一个值，而那与"文件被读了"是两件事——`source === 'file'` 这条断言
    // 就是为了把这种情况挡在外面，环境本身也要跟着干净。
    // 顺带清掉 DSH 的会话相关变量，避免子进程误以为自己在某个会话里。
    for (const leaked of ['DSH_SNAPSHOT', 'DSH_SESSION_ID', 'DSH_WEB_URL', DSH_NAME]) {
      delete env[leaked]
    }
    env.DSH_HOME = home
    env.DSH_AGENTS_HOME = join(home, 'agents')
    env.DSH_TELEMETRY_DISABLED = '1'
    // 覆盖掉任何**继承来的**真实模型 key：既不使用真凭证，也不让它从环境里
    // 答出一个值（本用例的引用名与它不同，但这里保持环境干净）。
    env.DEEPSEEK_API_KEY = 'keyless-prt509-no-model-call'

    result = await runHost({
      cliBin,
      cwd: home,
      env,
      args: ['--profile', PROFILE, '--patch', paths.overlayFile],
      timeoutMs: HOST_TIMEOUT_MS,
    })

    const tail = `${result.out}\n${result.err}`.slice(-1500)
    assert.ok(existsSync(outFile),
      `真 DSH 进程没有留下探针读数（退出码 ${result.code}）——那棵树没把探针挂起来。日志尾部：\n${tail}`)
    const reading = JSON.parse(readFileSync(outFile, 'utf8').replace(/^\uFEFF/, ''))

    // ① 真进程、真启动期：读数里带着那个进程的 pid。
    assert.equal(typeof reading.pid, 'number', '读数里应带探针进程的 pid')
    assert.equal(reading.probe, 'prt509-credentials-probe')
    // ② 读到了。
    assert.equal(reading.configured, true,
      `DSH 的提供方从 Legion 那份文件里**一条都取不到**：${JSON.stringify(reading)}`)
    // ③ 而且是从**文件**里读到的，不是环境变量。
    assert.equal(reading.source, 'file',
      `值不是从文件来的（source=${reading.source}）——覆盖层没被这棵树吃进去，`
      + '而文件此时是在环境变量里被找到的')
    // ④ 是材料化时那一把（只比 sha256，值不入断言）。
    assert.equal(reading.valueSha256, sha256(PROBE_VALUE),
      '取到的值不是材料化时写进去的那一把')
    assert.equal(reading.valueLength, PROBE_VALUE.length)
    // ⑤ 反向对照：Legion 的引用名不是 DSH 的寻址名。
    //    少了这条，上面几条可能只是"提供方对任何名字都返回同一把钥匙"。
    assert.equal(reading.otherResolved, false,
      `DSH 竟然能用 Legion 的引用名（${RUNTIME_MODEL_KEY_REF}）取到值——`
      + '那说明写进文档的键不是 DSH 的可寻址名，而是我们的内部引用名')
    assert.equal(result.code, 0, `真 DSH 进程应以 0 退出（实际 ${result.code}）：\n${tail}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
