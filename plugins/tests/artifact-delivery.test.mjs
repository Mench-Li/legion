// plugins/tests/artifact-delivery.test.mjs
// ============================================================================
// BUG-037：合入了源码，但用户看到的东西没变 —— 因为**没有人重建产物**。
//
// 现场（2026-10-14，G-mv7kzgnu-1「为外部执行者配头像」）：
// T-203..T-210 全绿、目标自动 done，将军看到的还是「没头像」。
// `git merge --no-ff w/T-207` 把源码合进了 main，而 `workbench/dist` 是 **gitignored** 的，
// 合并一个字节都带不过去 —— 运行中的指挥台读的正是主工作区的 dist。
//
// 这一组用例分两层，缺一层都不足以守住这件事：
//   ① **判据**（纯函数）：哪些改动要重建、哪些不用；构建失败必须回 ok:false 而不是"尽力而为"；
//   ② **接线**（读 `src/index.ts`）：`autoPromote` 真的调了它，而且产物重建失败时
//      **不推进 done**（照旧走 in_review）—— 底层对而没接上，与底层错是同一个结果。
//
//   > 一个「合入成功」的读数，与一个「用户看到的东西变了」的读数，
//   > 在没有人重建产物的时候长得完全一样。
// ============================================================================
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BUILT_APPS,
  appsToRebuild,
  artifactFailureComment,
  rebuildMergedArtifacts,
  touchesApp,
} from '../src/artifactDelivery.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER_SRC = readFileSync(resolve(HERE, '..', 'src', 'index.ts'), 'utf8')

/**
 * `autoPromote` + `deliverArtifacts` 这一段源码。
 *
 * ★ 不按固定字数截：首版写的是 `body.slice(0, 4000)`，而产物交付那几行在 4000 字**之外**
 *   （中间隔着整段注释与集成通道分支）—— 于是"没找到 rebuildMergedArtifacts"被报成
 *   "接线没接上"，读起来像代码错了，其实是**判据把观测点切掉了**。
 *   改成按**结束标记**取区间：多一段注释不会让判据失效，少一行代码才会。
 */
const PROMOTE_REGION = WORKER_SRC.slice(
  WORKER_SRC.indexOf('async function autoPromote'),
  WORKER_SRC.indexOf('流水线阶段交接'),
)

/** 造一个假仓库：只有 package.json（构建脚本的存在性判据读它）。 */
function fakeRepo(apps = [{ dir: 'workbench', script: 'build' }]) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-artifacts-'))
  for (const app of apps) {
    mkdirSync(join(dir, app.dir), { recursive: true })
    writeFileSync(join(dir, app.dir, 'package.json'), JSON.stringify({ scripts: { [app.script]: 'node noop.mjs' } }), 'utf8')
  }
  return dir
}

const workbench = BUILT_APPS.find((a) => a.id === 'workbench')
const whiteboard = BUILT_APPS.find((a) => a.id === 'whiteboard')

test('① 判据：碰了哪个 app 的源码才重建哪个', () => {
  assert.deepEqual(appsToRebuild(['workbench/src/App.tsx']).map((a) => a.id), ['workbench'])
  assert.deepEqual(appsToRebuild(['whiteboard/apps/server/src/index.js']).map((a) => a.id), ['whiteboard'])
  assert.deepEqual(
    appsToRebuild(['workbench/src/App.tsx', 'whiteboard/index.html']).map((a) => a.id).sort(),
    ['whiteboard', 'workbench'],
  )
})

test('① 判据：文档/后端改动不触发前端构建（否则每次合入都白跑一遍 vite）', () => {
  for (const paths of [
    ['docs/FEATURES.md'],
    ['team-hub/server.mjs'],
    ['README.md'],
    [],
  ]) {
    assert.deepEqual(appsToRebuild(paths), [], `这些路径不该触发构建：${paths.join(',')}`)
  }
})

test('① 判据：**app 顶层**产物目录下的改动不算源码（它们本来就是构建出来的）', () => {
  // 少了这条，一次「只改了 dist 里的东西」也会触发重建 —— 不致命，但更致命的是反例：
  // 把产物目录当源码，会让人以为"改了 dist 就交付了"，而 dist 根本不进 git。
  assert.equal(touchesApp(workbench, 'workbench/dist/index.html'), false)
  assert.equal(touchesApp(workbench, 'workbench/node_modules/.vite/deps/x.js'), false)
  assert.equal(touchesApp(workbench, 'workbench/data/web-audit.jsonl'), false)
  // ★ 只排除**第一层**：嵌套的 dist 仍算源码。两种判错的代价不对称 ——
  //   多建一次只花 ~25s，漏建一次就是"用户看不到改动"（本 BUG）。
  assert.equal(touchesApp(workbench, 'workbench/src/dist/helper.ts'), true, '嵌套 dist 仍算源码')
  assert.equal(touchesApp(whiteboard, 'whiteboard/apps/server/dist/bundle.js'), true, '嵌套 dist 仍算源码')
})

test('① 判据：Windows 反斜杠路径与 `./` 前缀都要认得出来', () => {
  // 守护跑在 Windows 上，`git diff --name-only` 的输出风格会随配置变；
  // 这里判错一次的表现是"改了前端却不重建"，而那是静默的。
  assert.equal(touchesApp(workbench, 'workbench\\src\\App.tsx'), true)
  assert.equal(touchesApp(workbench, './workbench/src/App.tsx'), true)
  assert.deepEqual(appsToRebuild(['.\\workbench\\src\\App.tsx']).map((a) => a.id), ['workbench'])
})

test('① 判据：空/非字符串/无关路径不炸', () => {
  for (const v of ['', '   ', null, undefined, 'src/App.tsx', 'workbenchish/x.ts']) {
    assert.equal(touchesApp(workbench, v), false, `${JSON.stringify(v)} 不该被当成 workbench 的改动`)
  }
  assert.deepEqual(appsToRebuild(null), [])
  assert.deepEqual(appsToRebuild(undefined), [])
})

test('② 行为：没有任何产物要重建时**不执行构建**，并如实说"没有"', async () => {
  let called = 0
  const r = await rebuildMergedArtifacts({
    repoRoot: fakeRepo(),
    changedPaths: ['docs/FEATURES.md'],
    runScript: async () => { called += 1; return { code: 0, output: '', error: null } },
  })
  assert.equal(called, 0, '★ 没有目标却起了构建进程 = 每次合入白跑一遍')
  assert.equal(r.ok, true)
  assert.deepEqual(r.rebuilt, [])
  assert.match(r.summary, /未触及/)
})

test('② 行为：构建成功 ⇒ ok、rebuilt 列出实际重建的 app', async () => {
  const seen = []
  const r = await rebuildMergedArtifacts({
    repoRoot: fakeRepo(),
    changedPaths: ['workbench/src/App.tsx'],
    runScript: async (dir, script) => { seen.push({ dir, script }); return { code: 0, output: 'built in 8s', error: null } },
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.rebuilt, ['workbench'])
  assert.equal(seen.length, 1)
  assert.match(r.summary, /workbench/)
  assert.equal(r.detail, '')
})

test('② 行为：★ 构建失败 ⇒ ok:false（不是"尽力而为"），并带上输出尾部', async () => {
  const r = await rebuildMergedArtifacts({
    repoRoot: fakeRepo(),
    changedPaths: ['workbench/src/App.tsx'],
    runScript: async () => ({ code: 1, output: 'Error: spawn EPERM\n    at esbuild', error: null }),
  })
  assert.equal(r.ok, false, '★ 构建失败必须是"交付未完成"')
  assert.deepEqual(r.rebuilt, ['workbench'])
  assert.match(r.summary, /重建失败/)
  assert.match(r.detail, /spawn EPERM/, '失败原因要能看见（这一次就是它把部署阶段糊过去的）')
})

test('② 行为：超时/起不来同样算失败，不许当成"跳过"', async () => {
  const timeout = await rebuildMergedArtifacts({
    repoRoot: fakeRepo(),
    changedPaths: ['workbench/src/index.css'],
    runScript: async () => ({ code: -2, output: '', error: '构建超时（600s）' }),
  })
  assert.equal(timeout.ok, false)
  assert.match(timeout.summary, /超时/)

  const noSpawn = await rebuildMergedArtifacts({
    repoRoot: fakeRepo(),
    changedPaths: ['workbench/src/index.css'],
    runScript: async () => ({ code: -1, output: '', error: '构建进程起不来：spawn EPERM' }),
  })
  assert.equal(noSpawn.ok, false)
  assert.match(noSpawn.summary, /起不来/)
})

test('② 行为：package.json 里没有构建脚本 ⇒ 失败并点名（不当成功）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-artifacts-'))
  mkdirSync(join(dir, 'workbench'), { recursive: true })
  writeFileSync(join(dir, 'workbench', 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }), 'utf8')
  const r = await rebuildMergedArtifacts({ repoRoot: dir, changedPaths: ['workbench/src/App.tsx'] })
  assert.equal(r.ok, false)
  assert.match(r.detail, /scripts\.build/)
})

test('② 行为：目录整个不在 ⇒ 失败并点名，不当成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-artifacts-'))
  const r = await rebuildMergedArtifacts({ repoRoot: dir, changedPaths: ['whiteboard/index.html'] })
  assert.equal(r.ok, false)
  assert.match(r.detail, /whiteboard/)
})

test('③ 失败评论必须说清四件事：源码在 main / 界面还是旧的 / 怎么复现 / 别推进 done', () => {
  const comment = artifactFailureComment(
    { ok: false, rebuilt: ['workbench'], summary: 'workbench 产物重建失败（exit=1）', detail: 'Error: spawn EPERM' },
    '/repo',
  )
  assert.match(comment, /源码已合入主分支/)
  assert.match(comment, /产物重建失败/)
  assert.match(comment, /用户界面仍是旧的/, '要明说"用户看不到"，不是只说"构建失败"')
  assert.match(comment, /npm run build/, '要给可复现的命令')
  assert.match(comment, /推进 done/, '要说清怎么恢复')
  assert.match(comment, /spawn EPERM/, '要带上原始失败原因')
})

test('④ 接线：autoPromote 合入之后**真的**重建产物（不是只写在文档里）', () => {
  assert.match(WORKER_SRC, /from '\.\/artifactDelivery\.js'/, 'index.ts 要引这个模块')
  assert.ok(PROMOTE_REGION.length > 0, '找不到 autoPromote —— 它改名了，这条接线判据就失效了')
  assert.match(PROMOTE_REGION, /await deliverArtifacts\(taskId/, '★ 合入成功后必须走产物交付这一步')
  assert.match(PROMOTE_REGION, /rebuildMergedArtifacts\(/, '产物交付要真的调重建')
})

test('④ 接线：★ 产物重建失败**不许推进 done**（否则又是"目标 done 而界面没变"）', () => {
  // 两个调用点（流水线中间阶段 / devops 收官）都必须按 kind 分流到 in_review。
  const sites = WORKER_SRC.split('await autoPromote(').slice(1)
  assert.equal(sites.length, 2, `autoPromote 的调用点应当是 2 个，实际 ${sites.length} 个（形状变了请复核本判据）`)
  for (const [i, site] of sites.entries()) {
    const tail = site.slice(0, 1800)
    assert.match(tail, /if \(!promoted/, `调用点 ${i + 1} 要判断结果`)
    assert.match(tail, /kind === 'artifact'/, `调用点 ${i + 1} 要把"产物重建失败"单独说出来`)
    assert.match(tail, /artifactFailureComment\(/, `调用点 ${i + 1} 要给出可复现的失败评论`)
    assert.match(tail, /transitionTo\(t\.id, 'in_review'\)/, `调用点 ${i + 1} 必须停在 in_review`)
  }
  // 建成一个 false 之后仍然 advanceTo(done) 的写法，就是本 BUG 的形态
  assert.doesNotMatch(WORKER_SRC, /const merged = worktreeDir !== null \? await autoPromote/, '旧的 boolean 契约不该还在')
})

test('④ 接线：交付前要记下 HEAD（不然算不出"这次到底带来了哪些路径"）', () => {
  assert.match(PROMOTE_REGION, /rev-parse', 'HEAD'\]/, '交付前先记住 HEAD')
  assert.match(PROMOTE_REGION, /'diff', '--name-only', beforeHead, 'HEAD'\]/, '交付后用两点 diff 算改动清单')
})
