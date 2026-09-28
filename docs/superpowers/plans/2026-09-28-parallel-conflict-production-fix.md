# Parallel task conflict control: production repair plan

Date: 2026-09-28
Source: `docs/superpowers/specs/2026-09-27-parallel-task-conflict-control-design.md`

## Objective

Make known overlapping writing tasks wait before execution, route completed code through one verified integration path, and show real scheduling and delivery state. Preserve existing work and avoid false `done` claims.

## Work and checks

1. **Authoritative repository binding.** Resolve Git common directory and checked-out target ref on the server, scope-check tasks, and reject client-selected repository identities and refs. Add HTTP tests for two spaces on one repository and spoofed IDs.
2. **Atomic claim and reservation.** Wire both task lifecycle claim and Run Store claim to the write-intent reservation transaction. Keep unplanned tasks in read-only discovery, return structured contention without incrementing failure counts, and freeze stale epochs. Add concurrent claim tests and rerun the existing reservation end-to-end repro.
3. **Execution guard.** Bind granted paths, Attempt ID, epoch and revision to the worker RunRequest. Check each write/edit command before execution; use the same server path rule and pause for expansion if outside the reservation. Add a real worker test.
4. **Integration path.** Make the delivery queue the only integration route in integration mode, start an actual job runner, make claim concurrency safe, fix verification configuration, and use a safe checked-out worktree fast forward. Add tests for conflict, failed verification, dirty workspace, successful integration and crash recovery.
5. **Completion and UI.** Gate `done` on integrated delivery in integration mode. Expose live contention and delivery details in task views and allow versioned conflict decisions. Verify build and UI tests.
6. **Final verification.** Run targeted suites, build, and repository end-to-end scenarios. Record any remaining migration limits honestly.

Implement each step test first, then production code, then its targeted checks. Do not change unrelated dirty files in the primary checkout.

## Implementation status (2026-09-29)

- Claim and reservation now share the task transaction; overlapping paths wait without a failed Attempt. An unplanned writer reserves the whole repository. Running reservations cannot be replaced or shrunk through the public reservation endpoint.
- Integration mode uses a local worker worktree, a tool pre-execute guard, a workspace-write sandbox bound to that worktree, server-derived source/target identity, one integration worker per repository, configured verification, and checked-out-worktree cleanliness checks. Interrupted workers keep a frozen reservation until stopped execution is confirmed.
- Task detail shows live contention and delivery state, allows scope edits, integrates before marking a human-reviewed task done, and offers explicit frozen-reservation release after stop confirmation.
- Remaining product work: a dedicated versioned semantic conflict decision UI and identity-backed human approval. The current shared bearer token trusts the request's `by` actor, so it must only be exposed to trusted local clients. The generic runtime/orchestrator path does not yet submit a source commit for integration; it fails closed rather than marking a task done in integration mode.
