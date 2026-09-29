# Legion Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Windows x64, per-user Legion desktop application that starts and owns Product Launcher, installs the pinned DSH runtime on first use, presents Workbench in a secure window, and can be installed without a development environment.

**Architecture:** Electron owns the window, tray, and one private credential. A bounded NDJSON child process bridges Electron to the existing Product Launcher; Launcher alone owns services and their DataDir lock. Product data remains outside the install tree. Workbench and the local proxy enforce a desktop-only authentication boundary. Packaging uses a pinned Node/npm and a verified production file closure.

**Tech Stack:** Electron, Node.js ESM, Node test runner, existing Vite/React Workbench, electron-builder/NSIS, PowerShell Windows acceptance scripts.

**Spec:** [Legion desktop design](../specs/2026-09-27-legion-desktop-design.md). The spec is authoritative for runtime behavior; this plan is an execution map.

## Global Constraints

- Work only in the isolated worktree; leave the original checkout and its local changes alone.
- Preserve the existing Launcher CLI and DSH Desktop services-plugin path. Desktop mode uses Launcher API and never starts a second tray or independently spawns product services.
- Follow RED → GREEN for behavior changes; record the failing assertion and passing command. Commit each task separately.
- Do not report product readiness from an open window, spawned PID, or occupied port. Use Launcher's identity and runtime-contract checks.
- Do not claim a releasable installer until a clean Windows x64 standard-user VM with no Node, DSH, or source checkout passes the acceptance matrix.
- Keep secrets out of argv, URL, events, diagnostics, renderer state, and logs. The desktop token passes only through private stdio and trusted request headers.
- Baseline on 2026-09-29: `node --test product/launcher/cli.test.mjs product/launcher/launcher.test.mjs product/launcher/supervisor.test.mjs` passed 106/106 in the isolated worktree.

## Review Focus

1. Unknown process on a planned port, stale PID, second desktop launch, or crashed bridge must never be silently adopted or duplicated.
2. Missing DSH, failed download, invalid manifest, and failed wizard verification must not become `ready` or enable automatic work.
3. A hostile browser page, `Host`/`Origin` spoof, navigation, or renderer compromise must not reach local APIs or receive credentials.
4. Install/upgrade/uninstall must not delete DataDir, secrets, logs, or a user-selected workspace; a failed upgrade must have a defined recovery state.
5. Packaged runtime must not resolve Node modules, assets, symlinks, or executables from the developer checkout.

---

## Task 1: Desktop control protocol and Launcher bridge

**Files:** `product/launcher/desktop-protocol.mjs`, `product/launcher/desktop-protocol.test.mjs`, `product/launcher/desktop-bridge.mjs`, `product/launcher/desktop-bridge.test.mjs`.

**Produces:** A version-1, 64 KiB maximum line protocol. `start`, `status`, `stop`, `restart` each have an ID and one final response. Bridge invokes `launcherOptionsFrom` and `createLauncher`, serializes lifecycle mutations, sends only allowlisted status fields, and stops owned services on clean stdin close. Unknown commands and malformed lines receive named errors without exiting.

- [ ] Write protocol and bridge tests for partial lines, oversized input, invalid version/type, request correlation, duplicate start, stop/restart, and secret-free events. Identify the expected failure.
- [ ] Run only these tests and see RED for missing behavior.
- [ ] Implement parsing, bounded writes, lifecycle state, and Launcher adapter. Keep stdio wiring separate from the testable handler.
- [ ] Run focused tests to GREEN, then existing Launcher tests.
- [ ] Commit `feat(desktop): add bounded launcher control bridge`.

## Task 2: Window, local startup page, and tray

**Files:** `desktop/package.json`, `desktop/main.mjs`, `desktop/preload.mjs`, `desktop/startup.html`, `desktop/startup.mjs`, `desktop/main.test.mjs`, `desktop/README.md`.

**Produces:** Electron single-instance window and physical tray; local page shows bridge status and retry/stop actions. Main process starts exactly one bridge with packaged Node, validates IPC sender, waits for verified Workbench URL, and handles bridge death as a visible error. Navigation is restricted to the startup page and verified local Workbench origin; external links use protocol allowlist. Closing hides to tray and “Exit” stops Launcher.

- [ ] Test the pure lifecycle/window policy and bridge client with controlled child streams; see RED.
- [ ] Implement minimal Electron shell and preload allowlist; see GREEN.
- [ ] Perform manual double-launch, close-to-tray, reopen, and exit check on Windows; capture process tree.
- [ ] Commit `feat(desktop): add Electron shell and tray`.

## Task 3: First-run installation and configuration

**Files:** `product/launcher/desktop-bridge.mjs`, `product/launcher/desktop-bridge.test.mjs`, `desktop/startup.mjs`, `desktop/startup.html`, `desktop/startup.test.mjs` plus existing runtime-install/wizard modules only as required.

**Produces:** Bridge `prepare-runtime` uses the shipped signed/validated manifest and existing atomic runtime installer, then exposes wizard steps as structured requests. UI shows real download/start/configure/verify states and retry. Model secret travels only via stdio, never URL/argv/event. Configuration must be verified before claiming first-run complete.

- [ ] Write failing offline/retry/manifest rejection and wizard-resume tests.
- [ ] Connect existing runtime installer and wizard APIs; make tests pass.
- [ ] Exercise first run using a fresh temporary DataDir, with network-failure injection.
- [ ] Commit `feat(desktop): connect first-run setup`.

## Task 4: Desktop local API authentication

**Files:** `workbench/scripts/serve.mjs`, `workbench/scripts/serve.test.mjs`, `product/launcher/launcher.mjs`, `product/launcher/launcher.test.mjs`, `desktop/main.mjs`.

**Produces:** Non-empty per-launch Workbench token flows from main process through bridge to Workbench. Desktop-mode API and `/hub` proxy enforce token, exact loopback `Host`, and expected `Origin`. Main process injects token only into trusted Workbench requests; renderer cannot read it. Existing browser/dev mode remains explicitly configured and tested.

- [ ] Write tests that unauthenticated reads and writes, malicious Host/Origin, and direct proxy requests fail; valid trusted requests succeed. See RED.
- [ ] Implement authentication and token propagation without logging credentials; see GREEN.
- [ ] Verify developer mode compatibility and inspect logs/diagnostics for token leakage.
- [ ] Commit `feat(desktop): enforce local API credentials`.

## Task 5: Production asset closure and installer

**Files:** `desktop/package.json`, `desktop/electron-builder.yml`, `desktop/scripts/stage.mjs`, `desktop/scripts/verify-closure.mjs`, tests, `product/release/runtime-manifest.json`, `docs/prt/PRT-011-dsh-distribution-decision.md`.

**Produces:** Version-pinned Electron/Node/npm, built Workbench, production Legion modules and dependencies staged in a clean tree. Closure check rejects missing imports, development-root references, escaping symlinks/junctions, and missing executable assets. NSIS creates per-user Windows x64 installer and stable shortcuts. Product manifest binds desktop, Node, Legion, DSH, patch versions and hashes. Update PRT-011 to record bundled Node decision.

- [ ] Write failing closure tests for missing module, outside link, and absent Workbench build.
- [ ] Implement staging and installer config, then pass closure tests and unpacked-app smoke test.
- [ ] Build installer; test installation path containing spaces under non-admin user.
- [ ] Commit `build(desktop): stage and package Windows installer`.

## Task 6: Upgrade, recovery, and uninstall wiring

**Files:** `desktop/main.mjs`, `product/upgrade/*` targeted modules/tests, `desktop/scripts/*`, NSIS hooks.

**Produces:** Existing upgrade coordinator is sole update owner. Stop accepting work, verify artifact, wait for owned processes to exit, switch version pointer, run real health probes, and expose rollback/forward-repair status. Uninstall preserves product data and workspace by default.

- [ ] Write failing tests for locked files, bad signature/hash, migration failure, health failure, and data-preserving uninstall.
- [ ] Wire upgrade and UI events, then pass the focused and product upgrade suites.
- [ ] Rehearse upgrade and rollback on Windows VM with real installed app.
- [ ] Commit `feat(desktop): wire upgrade and recovery`.

## Task 7: Acceptance and release evidence

**Files:** `desktop/scripts/acceptance.ps1`, `docs/release/legion-desktop-acceptance.md`, license/SBOM outputs.

**Produces:** Repeatable Windows x64 standard-user acceptance evidence for install, first run, task execution, second launch, crash/recovery, shutdown, upgrade, uninstall, data retention, license/SBOM, hashes and signing. Record every unmet gate as open; internal build is not stable merely because unit tests pass.

- [ ] Run full repository test gates and installed-app acceptance on a clean VM without developer tools.
- [ ] Capture exact installer hash, signed/unsigned status, process tree, readiness probes, task/audit evidence, and recovery results.
- [ ] Review the whole diff against this plan and spec; fix Critical/Important findings with RED → GREEN tests.
- [ ] Commit acceptance evidence and select release channel only after all gates pass.
