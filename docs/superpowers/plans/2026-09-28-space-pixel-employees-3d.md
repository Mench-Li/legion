# Space Pixel Employees 3D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each Legion space a readable 3D pixel employee office whose actions follow actual task and roster events.

**Architecture:** Keep team-hub roster and board snapshots authoritative; the existing scoped SSE stream invalidates snapshots and supplies candidates for short cues. Pure scene state and layout modules feed a replaceable React Three Fiber renderer, while the existing agent and task dialogs remain the interaction path. Store a bounded scene preset on each space with an `office` default.

**Tech Stack:** TypeScript, React 19, React Three Fiber 9, drei 10, Three.js 0.185, Vite 7, Node 24 tests, team-hub SQLite.

**Spec:** `docs/superpowers/specs/2026-09-27-space-pixel-employees-3d-design.md`

## Global Constraints

- Work only in the isolated worktree; never copy uncommitted files from `D:/project/DSH/legion`.
- Preserve the existing `/api/events` protocol and task write paths. Scene events never write task state.
- Scope and role together identify an employee; `全部空间` remains a grouped overview.
- Roster mode priority is `blocked > review > busy > idle`; `in_review` is not `done`, and `blocked` is not an execution failure.
- `scenePreset` is one of `office | studio | lab | operations`; absent values read as `office`, and old clients must not erase a saved preset.
- The scene stays useful without WebGL or motion, and v1 mode shows a generic office without invented handoffs.
- Prefer new focused modules beside `Scene3D.tsx`; preserve existing modal and API shapes where possible.

## Review Focus

1. A delayed response from the previous scope must never appear after switching spaces: Task 4 controller test.
2. A replayed completion event must not make employees celebrate on page load: Task 3 cue test.
3. Old `POST /api/spaces` clients must preserve a chosen scene preset: Task 1 route test.
4. A dependency without both identifiable owners must never create a handoff: Task 3 cue test.
5. An external soldier whose task carries a different role must open the task shown in the scene: Task 2 ownership test.

## File Map

| File | Responsibility |
| --- | --- |
| `team-hub/server.mjs`, `team-hub/routes/{space-config,read-models}.mjs` | Persist and expose scene preset |
| `workbench/src/{types,api}.ts`, space modals | Typed preset transport and user selection |
| `workbench/src/scene/sceneState.ts` | Pure employee projection and truth-checked transient cues |
| `workbench/src/scene/sceneLayout.ts` | Pure deterministic workstations and camera bounds |
| `workbench/src/scene/sceneController.ts` | Scoped SSE, snapshot coordination, recovery and stale-result rejection |
| `workbench/src/components/{Scene3D,Employee3D,SceneAgentList}.tsx` | 3D office, reusable character, accessible 2D fallback |
| `workbench/src/App.tsx`, `workbench/src/index.css`, `CenterPanel.tsx`, `AgentTasksModal.tsx` | Data wiring, interactions and styling |
| `workbench/scripts/scene-*.test.mjs`, team-hub route tests | Behavioral evidence |

### Task 1: Persist Scene Presets in team-hub

**Files:**
- Modify: `team-hub/server.mjs` spaces schema and migration
- Modify: `team-hub/routes/space-config.mjs`, `team-hub/routes/read-models.mjs`
- Test: `team-hub/space-config-routes.test.mjs`, `team-hub/read-models-routes.test.mjs`

**Interfaces:** `POST /api/spaces` accepts optional `scenePreset`; response and `GET /api/spaces` always expose it. Existing rows and inferred scopes return `office`.

- [ ] Add failing route tests for all four values, invalid value 400, old-client update preservation, and inferred scope default.
- [ ] Run `node --test team-hub/space-config-routes.test.mjs team-hub/read-models-routes.test.mjs`; confirm the new assertions fail.
- [ ] Add `scene_preset TEXT DEFAULT 'office'` through `ensureColumn`; validate the enum; preserve stored value when input omits it; expose `scenePreset` in both response paths.
- [ ] Re-run the two route suites and confirm all pass; inspect the existing space response assertions for additive field expectations.
- [ ] Commit only Task 1 files.

### Task 2: Carry Presets Through Workbench and Align Task Ownership

**Files:**
- Modify: `workbench/src/types.ts`, `workbench/src/api.ts`
- Modify: `workbench/src/components/NewSpaceModal.tsx`, `workbench/src/components/SpaceSettingsModal.tsx`, `workbench/src/components/AgentTasksModal.tsx`, `workbench/src/index.css`
- Create: `workbench/src/scene/agentOwnership.ts`
- Test: `workbench/scripts/scene-ownership.test.mjs`

**Interfaces:** `SpaceInfo.scenePreset: ScenePreset`; `createSpace(..., scenePreset)` and `updateSpaceConfig({ scenePreset })`; `tasksForRosterAgent(agent, tasks): HubTask[]` matches the `/api/roster` attribution rule for roster and external agents.

- [ ] Add a failing ownership test for `(task.role ?? task.soldier)` on roster members and `soldier` on external members, including a different task role.
- [ ] Run `node --test workbench/scripts/scene-ownership.test.mjs`; confirm failure.
- [ ] Implement the pure ownership helper and use it in `AgentTasksModal`; wire a four-option preset selector into create and settings forms and API types.
- [ ] Run ownership test and `pnpm build` in `workbench`; confirm pass and no type errors.
- [ ] Commit only Task 2 files.

### Task 3: Project Employee State and Truth-Checked Cues

**Files:**
- Create: `workbench/src/scene/sceneState.ts`
- Test: `workbench/scripts/scene-state.test.mjs`

**Interfaces:** `projectSceneAgents(scope, roster, tasks): SceneAgent[]`; `deriveSceneCues(previous, current, events, nowMs, visible): SceneCue[]`; `SceneAgent` and `SceneCue` follow spec §5.1. Events are only candidates; snapshot changes decide cues.

- [ ] Add failing tests for mode priority, stable scope-qualified keys and appearance seeds, external employees, done-only celebration, stale/replayed event suppression, and dependency/goal/owner handoff guards.
- [ ] Run `node --test workbench/scripts/scene-state.test.mjs`; confirm failure.
- [ ] Implement pure projection and cue derivation; choose focus task by mode priority then task id, without mutating inputs.
- [ ] Re-run the test and confirm all cases pass.
- [ ] Commit only Task 3 files.

### Task 4: Coordinate Scoped Snapshots and Events

**Files:**
- Create: `workbench/src/scene/sceneController.ts`
- Modify: `workbench/src/App.tsx`
- Test: `workbench/scripts/scene-controller.test.mjs`

**Interfaces:** `createSceneController({ scope, subscribe, fetchRoster, fetchTasks, onSnapshot, onError, now, timers }): { start, refresh, stop }`. App mounts it only for hub home plus a concrete scope; existing all-space roster loading remains. App passes snapshot and cues into `CenterPanel`.

- [ ] Add failing tests with injected fake subscribers/fetchers/timers for scoped subscription, burst coalescing, on-open/reconnect refresh, 20-second fallback, manual refresh, failed fetch retaining prior data, and stale scope/request rejection.
- [ ] Run `node --test workbench/scripts/scene-controller.test.mjs`; confirm failure.
- [ ] Implement controller around existing `subscribeHubAudit` and `fetchRoster/fetchHubTasks`; connect it in App, keep a visible `sceneError` and current snapshot, and cancel old scope work on cleanup.
- [ ] Run controller test, existing hub stream test, and `pnpm build`; confirm pass.
- [ ] Commit only Task 4 files.

### Task 5: Calculate Stable Space Layouts

**Files:**
- Create: `workbench/src/scene/sceneLayout.ts`
- Test: `workbench/scripts/scene-layout.test.mjs`

**Interfaces:** `layoutScene(agentKeys: readonly string[], preset: ScenePreset): SceneLayout` returns stable stations, review/help locations, floor bounds and orthographic camera framing for 0, 1, 8, 12 and 24 agents.

- [ ] Add failing tests for floor containment, unique stations, state-only refresh position stability, double rows through 12 and expanded rows above 12.
- [ ] Run `node --test workbench/scripts/scene-layout.test.mjs`; confirm failure.
- [ ] Implement deterministic grid and bounds with central route and target device; do not use task status for placement.
- [ ] Re-run the layout test and confirm pass.
- [ ] Commit only Task 5 files.

### Task 6: Build the Pixel Employee Office

**Files:**
- Create: `workbench/src/components/Employee3D.tsx`, `workbench/src/components/SceneAgentList.tsx`
- Rewrite: `workbench/src/components/Scene3D.tsx`
- Modify: `workbench/src/components/CenterPanel.tsx`, `workbench/src/index.css`
- Test: `workbench/scripts/scene-state.test.mjs`, `workbench/scripts/scene-layout.test.mjs`; visual scenario checks in Task 7

**Interfaces:** `Scene3D({ agents, cues, preset, goalPercent, motionEnabled, onAgentClick })`; `SceneAgentList({ agents, onAgentClick })`. Existing modal click path stays intact.

- [ ] Change only the `CenterPanel` call to pass the new `SceneAgent[]`/cue/preset props and run `pnpm build`; expect a TypeScript prop mismatch until `Scene3D` is updated.
- [ ] Build a shared 10–18-cuboid employee with nearest-neighbor low-resolution face/clothing textures, role-derived palette/prop, and state ring; render workstations and four preset palettes/furniture around a bounded orthographic camera.
- [ ] Animate walking, working, review, blocked and short cues from scene state; stop motion under `prefers-reduced-motion`, manual motion-off, or hidden page; dispose 3D resources on unmount.
- [ ] Make labels compact by default and expanded on hover/focus; add keyboard-selectable list and WebGL fallback with the same employee click path.
- [ ] Run `pnpm build` and targeted scene tests; confirm pass.
- [ ] Commit only Task 6 files.

### Task 7: Integrate and Verify User Flows

**Files:**
- Modify: `workbench/README.md` or the user-facing scene section already describing the old geometric figures
- Modify: relevant scene modules only when Task 7 verification exposes a real defect
- Test: focused hub, space, scene and Workbench build commands

**Interfaces:** No new public interface. One concrete space has a 3D office; all-space and v1 stay useful.

- [ ] Run focused hub and Workbench tests, plus `pnpm build`; record the actual counts and failures.
- [ ] Exercise 0, 1, 8, 12 and 24 employee layouts, narrow central pane, hover/click, modal layering, WebGL fallback, motion-off, scope switch, SSE disconnect/reconnect and external soldier attribution in a browser or reproducible visual harness.
- [ ] Fix only demonstrated integration defects; repeat the relevant check until clean.
- [ ] Update Workbench documentation to match the delivered appearance and behavior.
- [ ] Review the branch diff against spec §§1–9, run `git diff --check`, and commit only integration/documentation files.
