# Continue Agent Review Until Findings Are Fixed

> **For agentic workers:** execute this plan task-by-task with the current user-authorized inline implementation.

**Goal:** Keep implementation findings in the Agent workflow moving back to the implementation stage until review passes, without a configured round limit leaving unresolved work in review.

**Architecture:** Preserve `maxReworkRounds` in existing snapshots and API payloads for compatibility, but stop using it as a gate. The Hub always creates the next rework task for actionable findings. Remove the misleading limit control and present the workflow as continuing until review passes. Fix T-217's two mobile regressions in the implementation source and verify them with integration tests.

**Tech Stack:** Node.js, SQLite-backed team-hub, TypeScript/React Workbench, Node test runner.

**Spec:** User direction in this conversation: an unresolved problem should be fixed, not stopped after two rounds.

## Tasks

### Task 1: Regression tests for review continuation and the T-217 findings

**Files:** `team-hub/pipeline.test.mjs`, `workbench/mobile/app-integration.test.mjs`

- [ ] Assert a review with actionable findings after the legacy limit still creates the next implementation task.
- [ ] Assert scrolling during a pending board load survives tab switches and background refresh.
- [ ] Assert a second touch outside the board cancels the active swipe.
- [ ] Run the targeted tests and confirm the new assertions fail before implementation.

### Task 2: Continue review rework without a hard round cap

**Files:** `team-hub/server.mjs`, `plugins/src/index.ts`, `workbench/src/components/AgentWorkflowConfigurator.tsx`, `workbench/src/components/TaskDetailModal.tsx`

- [ ] Always create rework tasks for actionable review findings, including legacy snapshots with `maxReworkRounds: 2`.
- [ ] Remove user-facing settings and statuses that imply unresolved mandatory findings are abandoned at a fixed round count.
- [ ] Keep old snapshot fields accepted for compatibility; describe completion as review passing.
- [ ] Run pipeline and workflow tests.

### Task 3: Fix mobile integration regressions and verify

**Files:** `workbench/mobile/app.mjs`, `workbench/mobile/app-integration.test.mjs`

- [ ] Save the latest visible task scroll before leaving during a pending refresh.
- [ ] Prevent hidden board refreshes from changing the chat scroll or task restore point.
- [ ] Observe touch pointers outside the board and cancel the entire multi-touch round.
- [ ] Run the mobile integration suite, targeted mobile tests, and Workbench build.
