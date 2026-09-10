# F-01 Reliable Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing v2 audit SSE stream with scope-aware replay, explicit `sinceSeq` recovery, and a shared persistent workbench cursor while preserving current `Last-Event-ID`, heartbeat, and dedupe behavior.

**Architecture:** Keep `team-hub`'s existing `audit` table as the single durable event log. Add strict query parsing and `{res, scope}` subscriptions on the server. Add a dependency-free workbench event-stream module that validates envelopes, persists a monotonic cursor per hub/scope, builds URLs with `URLSearchParams`, and is used by all v2 hub consumers.

**Tech Stack:** Node.js ESM, `node:test`, TypeScript, React 19, SQLite through the existing team-hub database layer, browser `EventSource` and `localStorage`.

**Spec:** `docs/superpowers/specs/2026-09-10-f01-reliable-events-design.md`

## Global Constraints

- Preserve existing v2 event fields and behavior, including `id: <seq>`, `retry: 2000`, 15-second `:hb`, recent-30 replay, and `Last-Event-ID` compatibility.
- `audit` remains the only durable event source; do not add an `event_log` table.
- `seq` is global, so scope-filtered streams must not require consecutive sequence numbers.
- Invalid explicit `sinceSeq` query values return HTTP 400; invalid `Last-Event-ID` keeps the existing fallback behavior.
- v1 `/api/board/events` and `/api/activity/events` remain unchanged.
- All production behavior is introduced only after a test demonstrates the missing behavior.

---

### Task 1: Scope-aware and sinceSeq-aware team-hub SSE

**Files:**
- Modify: `team-hub/server.mjs:2010-2035` (subscription storage and broadcast)
- Modify: `team-hub/server.mjs:3292-3308` (SSE request parsing and replay)
- Test: `tests/contract/v1v2-contract.test.mjs` (v2 SSE contract cases)

**Interfaces:**
- Consumes: existing `auditEvent()`, `writeEventFrame()`, `audit` table, and `req.headers['last-event-id']`.
- Produces: `GET /api/events?scope=<scope>&sinceSeq=<n>` where Last-Event-ID wins over sinceSeq; scoped replay and scoped live broadcast.

- [ ] **Step 1: Write failing server contract tests**

Add tests to the existing v2 SSE describe block:

```js
it('sinceSeq 回放只返回更大的序号，且 Last-Event-ID 优先', async () => {
  const seed = await req(v2Base, 'POST', '/api/create', { title: 'cursor-seed', by: 'general' })
  assert.equal(seed.status, 200)
  const cursor = Number(seed.data.task.auditSeq ?? seed.data.auditSeq ?? 0)
  const newer = await req(v2Base, 'POST', '/api/comment', { id: seed.data.task.id, text: 'cursor-new', by: 'general' })
  assert.equal(newer.status, 200)
  const c = await sseCollect(v2Base, `/api/events?sinceSeq=${Math.max(0, cursor)}`, {
    timeoutMs: 4000,
    resolveOn: (fs) => fs.some((f) => f.includes('data:')),
  })
  const ids = c.frames.filter((f) => f.includes('data:')).map((f) => Number((f.match(/^id: (\d+)/m) ?? [])[1]))
  assert.ok(ids.every((id) => id > cursor))
})

it('scope 过滤同时作用于回放和实时广播', async () => {
  const a = await req(v2Base, 'POST', '/api/create', { title: 'scope-a', by: 'general', scope: 'scope-a' })
  const b = await req(v2Base, 'POST', '/api/create', { title: 'scope-b', by: 'general', scope: 'scope-b' })
  assert.equal(a.status, 200); assert.equal(b.status, 200)
  const c = await sseCollect(v2Base, '/api/events?scope=scope-a', {
    timeoutMs: 4000,
    resolveOn: (fs) => fs.some((f) => f.includes('data:')),
  })
  const events = c.frames.filter((f) => f.includes('data:')).map((f) => JSON.parse(f.split('\n').find((l) => l.startsWith('data: ')).slice(6)))
  assert.ok(events.length > 0)
  assert.ok(events.every((e) => e.scope === 'scope-a'))
})

it('显式非法 sinceSeq 返回 400', async () => {
  const bad = await req(v2Base, 'GET', '/api/events?sinceSeq=-1', {})
  assert.equal(bad.status, 400)
})
```

- [ ] **Step 2: Run the focused tests and verify the expected failure**

Run:

```powershell
node --test --experimental-strip-types tests/contract/v1v2-contract.test.mjs
```

Expected: existing SSE cases pass, while the new `sinceSeq`/scope/invalid-query cases fail because the endpoint currently ignores these query parameters.

- [ ] **Step 3: Implement strict cursor and scope parsing**

Add small local helpers near the SSE section:

```js
function parseSinceSeq(raw) {
  if (raw === null || raw === undefined || raw === '') return null
  if (!/^\d+$/.test(String(raw))) throw new Error('sinceSeq 必须是非负整数')
  return Number(raw)
}

function parseEventScope(raw) {
  if (raw === null || raw === undefined) return undefined
  const scope = String(raw).trim()
  if (!scope) throw new Error('scope 不能为空')
  return scope
}
```

Use `eventClients` entries shaped as `{ res, scope }`. Update `broadcastAudit(entry)` to send to all entries with no scope or matching `entry.scope`.

- [ ] **Step 4: Implement replay precedence and scoped SQL**

Inside the `/api/events` route:

```js
const scope = parseEventScope(url.searchParams.get('scope'))
const sinceSeq = parseSinceSeq(url.searchParams.get('sinceSeq'))
const headerSeq = Number.parseInt(String(req.headers['last-event-id'] ?? ''), 10)
const cursor = Number.isFinite(headerSeq) ? headerSeq : sinceSeq
const where = []
const params = []
if (scope !== undefined) { where.push('scope = ?'); params.push(scope) }
if (cursor !== null && cursor !== undefined) { where.push('seq > ?'); params.push(cursor) }
let replay
if (cursor !== null && cursor !== undefined) {
  replay = db.prepare(`SELECT * FROM audit${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq ASC`).all(...params)
} else {
  replay = db.prepare(`SELECT * FROM audit${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT 30`).all(...params).reverse()
}
```

Register `{ res, scope }`, write replay frames, then retain the existing heartbeat and close cleanup semantics. Convert parsing errors to the existing JSON error response with status 400 before headers are sent.

- [ ] **Step 5: Run the focused tests and verify green**

Run:

```powershell
node --test --experimental-strip-types tests/contract/v1v2-contract.test.mjs
```

Expected: all existing and new v2 SSE cases pass, including the previous Last-Event-ID, heartbeat, and ordering assertions.

- [ ] **Step 6: Commit the server slice**

```powershell
git add team-hub/server.mjs tests/contract/v1v2-contract.test.mjs
git commit -m "feat: add scoped resumable hub events"
```

### Task 2: Shared persistent workbench event stream

**Files:**
- Create: `workbench/src/hubEventStream.ts`
- Create: `workbench/scripts/hub-event-stream.test.mjs`
- Modify: `workbench/src/types.ts:445-454`
- Modify: `workbench/src/api.ts:76-80,629-640`

**Interfaces:**
- Consumes: `HubAuditEvent`, `hubBase()`, `getToken()`, browser `EventSource`, and optional storage.
- Produces: `buildHubEventSourceUrl(path, options)`, `readHubCursor(storage, key)`, `writeHubCursor(storage, key, seq)`, `isHubAuditEvent(value)`, and `subscribeHubAudit(onEvent, options?)`.

- [ ] **Step 1: Write failing pure-function tests**

Create `workbench/scripts/hub-event-stream.test.mjs` with tests for the required API:

```js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildHubEventSourceUrl, readHubCursor, writeHubCursor, isHubAuditEvent } from '../src/hubEventStream.ts'

describe('hub event cursor', () => {
  it('按 hub 与 scope 隔离并只允许单调递增', () => {
    const store = new Map()
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
    const key = 'hub-events:https://hub.test/:scope-a'
    assert.equal(readHubCursor(storage, key), null)
    writeHubCursor(storage, key, 8)
    writeHubCursor(storage, key, 3)
    assert.equal(readHubCursor(storage, key), 8)
    assert.equal(readHubCursor(storage, key + '-other'), null)
  })

  it('损坏游标按无游标处理，URL 正确编码 scope/cursor/token', () => {
    const storage = { getItem: () => 'bad', setItem: () => {} }
    assert.equal(readHubCursor(storage, 'k'), null)
    const url = buildHubEventSourceUrl('https://hub.test/api/events', { scope: 'a b', sinceSeq: 8, token: 'x/y' })
    assert.equal(url, 'https://hub.test/api/events?scope=a+b&sinceSeq=8&token=x%2Fy')
  })
})

describe('hub envelope validation', () => {
  it('接受统一信封并拒绝 id/seq 不一致或 payload 缺失', () => {
    const good = { id: 2, event: 'task:create', scope: 'a', seq: 2, ts: '2026-01-01', payload: {}, action: 'task:create', member: 'general', taskId: null, goalId: null, detail: {} }
    assert.equal(isHubAuditEvent(good), true)
    assert.equal(isHubAuditEvent({ ...good, id: 3 }), false)
    assert.equal(isHubAuditEvent({ ...good, payload: undefined }), false)
  })
})
```

- [ ] **Step 2: Run the tests and verify the expected failure**

Run:

```powershell
node --test --experimental-strip-types workbench/scripts/hub-event-stream.test.mjs
```

Expected: FAIL with module-not-found because `hubEventStream.ts` does not exist.

- [ ] **Step 3: Implement the dependency-free cursor and envelope module**

Implement:

```ts
export function hubCursorKey(hub: string, scope?: string): string
export function readHubCursor(storage: Pick<Storage, 'getItem'> | undefined, key: string): number | null
export function writeHubCursor(storage: Pick<Storage, 'setItem'> | undefined, key: string, seq: number): void
export function buildHubEventSourceUrl(base: string, options: { scope?: string; sinceSeq?: number | null; token?: string }): string
export function isHubAuditEvent(value: unknown): value is HubAuditEvent
```

Storage calls must be individually guarded with `try/catch`. `writeHubCursor` must not lower an existing cursor. URL creation must use `URL`/`URLSearchParams`, preserving existing parameters.

- [ ] **Step 4: Update the shared type and subscribeHubAudit**

Extend `HubAuditEvent` with `id`, `event`, `seq`, `payload`, and `goalId`. Move `subscribeHubAudit` to the new module-backed implementation:

```ts
export function subscribeHubAudit(
  onEvent: (event: HubAuditEvent) => void,
  options: { scope?: string; storage?: Storage } = {},
): () => void
```

Use `globalThis.localStorage` only when available. Read the cursor before constructing `EventSource`; validate scope and envelope; discard `seq <= lastSeq`; persist the accepted sequence before invoking the callback; catch callback errors so the EventSource remains alive. Keep token query support.

- [ ] **Step 5: Run pure tests and TypeScript build**

Run:

```powershell
node --test --experimental-strip-types workbench/scripts/hub-event-stream.test.mjs workbench/scripts/dedupe.test.mjs
npm --prefix workbench run build
```

Expected: all event-stream and dedupe tests pass, and the workbench build exits 0.

- [ ] **Step 6: Commit the client stream slice**

```powershell
git add workbench/src/hubEventStream.ts workbench/src/api.ts workbench/src/types.ts workbench/scripts/hub-event-stream.test.mjs
git commit -m "feat: persist hub event cursors in workbench"
```

### Task 3: Scope-aware consumers and regression gate

**Files:**
- Modify: `workbench/src/components/ChatView.tsx` (subscription call)
- Modify: `workbench/src/components/NotifyView.tsx` (subscription call)
- Modify: `workbench/src/components/TaskCenterView.tsx` (subscription call)
- Modify: `workbench/scripts/hub-event-stream.test.mjs` (consumer-facing sequence cases if needed)
- Modify: `scripts/ci/run-ci.mjs` (event-stream test group)

**Interfaces:**
- Consumes: Task 2 `subscribeHubAudit(onEvent, { scope })` and existing component scope state.
- Produces: all v2 consumers receive only their current scope and resume from the scope-specific cursor.

- [ ] **Step 1: Add a failing integration-level assertion for scope arguments**

Add a focused test helper or static contract assertion that the three components call `subscribeHubAudit` with an options object containing the current space/scope value. The assertion must fail against the current no-options calls.

- [ ] **Step 2: Run the focused assertion and verify red**

Run:

```powershell
node --test --experimental-strip-types workbench/scripts/hub-event-stream.test.mjs
```

Expected: the new consumer-scope assertion fails before the component call sites are updated.

- [ ] **Step 3: Pass scope from each consumer**

Update each subscription to use the component's already-selected scope value, retaining existing action filters and array-level dedupe:

```ts
const off = subscribeHubAudit(onEvent, { scope: currentScope })
```

When the component has no selected scope, omit the option to preserve global behavior.

- [ ] **Step 4: Run all relevant tests**

Run:

```powershell
node --test --experimental-strip-types tests/contract/v1v2-contract.test.mjs
node --test --experimental-strip-types workbench/scripts/hub-event-stream.test.mjs workbench/scripts/dedupe.test.mjs
npm --prefix workbench run build
```

Expected: all commands exit 0 with no failing tests or TypeScript errors.

- [ ] **Step 5: Add the test group to CI and run it**

Register `hub-event-stream` beside the existing `dedupe` group in `scripts/ci/run-ci.mjs`, then run the relevant CI command used by the repository. Confirm the output reports the new suite and zero failures.

- [ ] **Step 6: Review the final diff and commit**

Run:

```powershell
git diff --check
git status --short
git diff HEAD~2..HEAD --stat
```

Confirm only F-01 files are present in the feature branch, then commit the consumer/CI slice:

```powershell
git add workbench/src/components/ChatView.tsx workbench/src/components/NotifyView.tsx workbench/src/components/TaskCenterView.tsx scripts/ci/run-ci.mjs workbench/scripts/hub-event-stream.test.mjs
git commit -m "test: gate scoped hub event recovery"
```

