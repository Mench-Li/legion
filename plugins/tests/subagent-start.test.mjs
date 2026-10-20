// plugins/tests/subagent-start.test.mjs —— 子代理启动的**两代 API** 契约
//
// 为什么要这个文件（真实故障，2026-10-20）：
//   和 Agent 对话报 `TypeError: ctx.subagents.start is not a function`。
//   编译用的 `@deepseek-ai/dsh-subagent` 是 0.2.1-alpha.1（服务上有 `start`），
//   而装在这台机器上、真正加载的是 0.2.1-rc.2（服务上只有 `startActivation`）。
//   **`tsc` 全绿，运行期缺方法。**
//
// 所以这里的判据不是"代码看起来对"，而是**用两种形状的假服务真的去调一遍**：
//   · 只给 `startActivation`（新）——必须走通，且 id/result/dispose 都归一正确；
//   · 只给 `start`（旧）——必须照样走通；
//   · 两个都没有 ——必须抛一条**说清有什么**的错误，而不是 `xxx is not a function`。
// 运行：node plugins/tests/subagent-start.test.mjs（需先构建 plugins/lib）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  callableMembers, startChildAgent, subagentStartApi,
} from '../lib/subagentStart.js'

/** 造一个只有新 API 的服务（rc 版本形状）。 */
function modernService(log = []) {
  return {
    async startActivation(spec) {
      log.push({ api: 'startActivation', spec })
      return {
        childId: 'child-1',
        messageId: 'msg-1',
        result: Promise.resolve({ stopReason: 'completed', structured: { ok: true } }),
        dispose: async () => { log.push({ api: 'disposed' }) },
      }
    },
  }
}

/** 造一个只有旧 API 的服务（alpha 版本形状）。 */
function legacyService(log = []) {
  return {
    async start(name, request) {
      log.push({ api: 'start', name, request })
      return {
        id: 'run-1',
        localAgent: { id: 'agent-1' },
        result: Promise.resolve({ stopReason: 'completed', structured: { ok: true } }),
        dispose: async () => { log.push({ api: 'disposed' }) },
      }
    },
  }
}

const REQUEST = {
  label: 'chat:test',
  prompt: [{ type: 'text', text: 'hi' }],
  parent: { id: 'parent-1' },
  signal: new AbortController().signal,
  outputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
}

test('① 新 API（只有 startActivation）：走通，且 childId→id、result/dispose 归一', async () => {
  const log = []
  const service = modernService(log)
  assert.equal(subagentStartApi(service), 'startActivation')

  const run = await startChildAgent(service, 'spawn', REQUEST)
  assert.equal(run.id, 'child-1', '新 API 的 childId 必须映射到 id')
  const result = await run.result
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.structured, { ok: true })
  await run.dispose()
  assert.deepEqual(log.map(entry => entry.api), ['startActivation', 'disposed'])

  const spec = log[0].spec
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.label, 'chat:test', 'label 提到 spec 顶层')
  assert.equal(spec.delivery, 'caller', '默认 caller：结果给调用方，不要父通知')
  assert.equal(spec.signal, REQUEST.signal, 'signal 提到 spec 顶层（同一个对象，不是拷贝）')
  assert.deepEqual(spec.request.prompt, REQUEST.prompt)
  assert.equal(spec.request.parent, REQUEST.parent)
  assert.deepEqual(spec.request.outputSchema, REQUEST.outputSchema)
  assert.equal('label' in spec.request, false, 'request 里不许再带 label（新类型是 Omit<…, "label" | "signal">）')
  assert.equal('signal' in spec.request, false, 'request 里不许再带 signal')
})

test('② 旧 API（只有 start）：同样走通（不能只为新版本写死）', async () => {
  const log = []
  const service = legacyService(log)
  assert.equal(subagentStartApi(service), 'start')

  const run = await startChildAgent(service, 'spawn', REQUEST)
  assert.equal(run.id, 'run-1')
  assert.deepEqual(run.localAgent, { id: 'agent-1' }, '旧 API 的 localAgent 要透传（集成模式靠它判拦截能力）')
  await run.dispose()

  const request = log[0].request
  assert.equal(log[0].name, 'spawn')
  assert.equal(request.label, 'chat:test', '旧 API 把 label 放在 request 里')
  assert.equal(request.signal, REQUEST.signal)
})

test('③ 两代都没有：错误必须说清"这里到底有什么"，不是 xxx is not a function', async () => {
  const service = { sendMessage: async () => 'x', listChildren: async () => [] }
  assert.equal(subagentStartApi(service), 'none')
  assert.deepEqual(callableMembers(service), ['listChildren', 'sendMessage'])
  await assert.rejects(
    () => startChildAgent(service, 'spawn', REQUEST),
    (error) => {
      assert.match(error.message, /^SUBAGENT_API_UNAVAILABLE:/, '稳定前缀便于分类器归类')
      assert.match(error.message, /startActivation/, '要点名新 API')
      assert.match(error.message, /start/, '要点名旧 API')
      assert.match(error.message, /listChildren, sendMessage/, '要列出实际可调用成员（下一个人才知道该查什么）')
      return true
    },
  )
})

test('④ 服务完全没挂载：错误也要说清，不许抛 TypeError', async () => {
  for (const empty of [undefined, null, 42]) {
    assert.equal(subagentStartApi(empty), 'none')
    await assert.rejects(() => startChildAgent(empty, 'spawn', REQUEST), /SUBAGENT_API_UNAVAILABLE: .*一个都没有/)
  }
})

test('⑤ dispose 恒不抛：清理失败不许盖住"子 Agent 已经跑完"这个事实', async () => {
  const service = {
    async startActivation() {
      return {
        childId: 'c',
        result: Promise.resolve({ stopReason: 'completed' }),
        dispose: async () => { throw new Error('cleanup exploded') },
      }
    },
  }
  const run = await startChildAgent(service, 'spawn', REQUEST)
  await run.dispose()  // 不抛
  // 没有 dispose 的句柄也不许抛
  const bare = await startChildAgent({ async startActivation() { return { childId: 'd', result: Promise.resolve({ stopReason: 'completed' }) } } }, 'spawn', REQUEST)
  await bare.dispose()
})

test('⑥ delivery 可显式覆盖（需要父通知时）', async () => {
  const log = []
  await startChildAgent(modernService(log), 'spawn', REQUEST, { delivery: 'parent' })
  assert.equal(log[0].spec.delivery, 'parent')
})

test('⑦ 插件源码不许再直接调 ctx.subagents.start（回归防线）', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
  const source = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  const hits = source.match(/ctx\.subagents\.start\s*\(/g) ?? []
  assert.equal(hits.length, 0, '必须统一走 startChildAgent（两代 API 的差异只在一处吸收）')
  const calls = source.match(/startChildAgent\(/g) ?? []
  assert.equal(calls.length, 4, '四处派工/改写/对话/单发都必须走兼容层（少一处就有一处会崩）')
})
