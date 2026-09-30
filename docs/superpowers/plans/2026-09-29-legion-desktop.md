# Legion Desktop Implementation Plan

> Created: 2026-09-29. Revised: 2026-09-30 after inspecting the official Harness desktop at commit `639ed015397290b3745d163aafe02ffee4aa3f84`. Work in the existing isolated worktree on branch `codex/legion-desktop`; implement the tasks below sequentially and record evidence.

**Goal:** Ship a Windows x64, per-user Legion desktop application that starts and owns Product Launcher, initializes a bundled pinned DSH production payload on first use, presents Workbench in a secure window, and can be installed without a development environment or a first-launch npm download.

**Architecture:** Electron owns the window, tray, and one private credential. A bounded NDJSON child process bridges Electron to the existing Product Launcher; Launcher alone owns preparation, services and the DataDir lock. Product data remains outside the install tree. Workbench and team-hub enforce a desktop authentication boundary. Packaging binds pinned Node/npm, DSH, Legion and patch versions into one verified release. Core dependencies are prepared during the build, then imported locally at first launch. CLI/development can explicitly use the existing npm installer.

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
- Preserve the qualified `0.1.5-rc.2` DSH candidate until a separate compatibility check authorizes a new exact DSH/patch combination. Referencing official `0.2.0-rc.2` desktop code does not upgrade our runtime.
- Keep Node-based backend code, DSH modules, native addons and executable resources outside ASAR. No profile or dependency may resolve through the original developer checkout.
- Main-process credential injection must bind both the owned window/session and the verified Workbench origin. Local IPC accepts the owning window's main frame only.

## Progress and execution order

Task 1 is committed as `8e5e4f31`; the bridge/protocol and existing Launcher suites passed 114/114. Task 2 is committed as `f1ccd0e`; focused desktop tests passed 5/5, and real Windows Electron launches verified second-launch focus, close-to-tray, reopen and two graceful quit/relaunch cycles with no bridge remaining. These are source-mode checks; they do not establish complete product startup or installer readiness.

Task 4 is implemented: bridge credential handshake, scoped service credentials, protected hub/Workbench APIs and owned-session request injection. Desktop-focused tests passed 14/14, Launcher/static-service regression passed 122/122, and a real Electron session verified authorized owned-origin requests without sending credentials to an external origin. Source-mode graceful quit/relaunch also passed again. Tasks 3, 5, 6 and 7 are pending.

Updated order: **Task 4 → Task 1 follow-up → prepare Task 5 payload → Task 4 follow-up approval transport → Task 3 local initialization and wizard → complete Task 5 installer → Task 6 → Task 7**. The official-reference design update is committed before further implementation. Follow-up Task 1 changes are a separate commit; keep the original completed evidence intact.

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

- [x] Write protocol and bridge tests for partial lines, oversized input, invalid version/type, request correlation, duplicate start, stop/restart, and secret-free events. Identify the expected failure.
- [x] Run only these tests and see RED for missing behavior.
- [x] Implement parsing, bounded writes, lifecycle state, and Launcher adapter. Keep stdio wiring separate from the testable handler.
- [x] Run focused tests to GREEN, then existing Launcher tests.
- [x] Commit `feat(desktop): add bounded launcher control bridge`.

### Task 1 follow-up from the official reference

**Files:** `desktop/runtime.mjs`, `desktop/main.test.mjs`, `product/launcher/desktop-protocol.mjs`, `product/launcher/desktop-bridge.mjs` and focused tests.

- [x] Add control deadlines, a pending-request cap and tests for timeout cleanup, late replies and bridge death. Deduplicate desktop retries; preparation cancellation follows in Task 3.
- [x] Keep long initialization in an owned worker with explicit progress/cancellation; status and stop remain serviceable during preparation. Real-worker cancellation and stdio responsiveness tests pass.
- [x] Require both stop acknowledgement and observed bridge exit for desktop teardown. A sent kill signal no longer counts as process exit; failed process teardown retains Launcher ownership and evidence. Preparation cancellation follows in Task 3.
- [ ] Add `inspect-quit` and `begin-update` typed requests when Task 6 integrates task admission control. Do not expose generic commands or dump task details in status events.
- [x] Commit `feat(desktop): bound lifecycle requests and confirm shutdown` (`74513fd`).

2026-10-01 evidence: the new supervisor assertions first failed because a signalled process was treated as dead and forced termination was reported successful without exit. Desktop/bridge/supervisor/Launcher verification then passed **77/77**. A real Electron smoke completed two quit/reopen cycles with a fresh DataDir and an explicit missing-identity error. This confirms source-mode lifecycle behavior; it is not complete product or installer acceptance. Production payload preparation is now running separately with exact recursive DSH family overrides (including peer dependencies) and pinned Cordis/Schemastery versions.

## Task 2: Window, local startup page, and tray

**Files:** `desktop/package.json`, `desktop/main.mjs`, `desktop/preload.cjs`, `desktop/startup.html`, `desktop/startup.mjs`, `desktop/main.test.mjs`, `desktop/README.md`.

**Produces:** Electron single-instance window and physical tray; local page shows bridge status and retry/stop actions. Main process starts exactly one bridge with packaged Node, validates IPC sender, waits for verified Workbench URL, and handles bridge death as a visible error. Navigation is restricted to the startup page and verified local Workbench origin; external links use protocol allowlist. Closing hides to tray and “Exit” stops Launcher.

- [x] Test the pure lifecycle/window policy and bridge client with controlled child streams; see RED.
- [x] Implement minimal Electron shell and preload allowlist; see GREEN.
- [x] Perform manual double-launch, close-to-tray, reopen, and exit check on Windows; capture process tree.
- [x] Commit `feat(desktop): add Electron shell and tray`.

## Task 3: First-run installation and configuration

**Files:** `product/launcher/desktop-bridge.mjs`, `product/launcher/desktop-bridge.test.mjs`, new bundled-runtime importer and tests, `desktop/startup.mjs`, `desktop/startup.html`, `desktop/startup.test.mjs` plus existing runtime-install/wizard/ownership modules as required.

**Produces:** Bridge `prepare-runtime` validates the release descriptor and imports the bundled production tree through staging, verification, completion marker and atomic pointer switch. Initialization and running services share one Launcher-owned DataDir lock. UI exposes workspace selection, explicit enforcement identity/scope, model configuration and real verification with resume/retry. Model secret travels only via private stdio and protected secrets storage. Orchestrator admission remains paused until contracts and setup consent succeed.

- [ ] Write failing tests for offline local preparation, bad file hash/platform/version/patch, interrupted copy, cancellation, orphaned complete directory and wizard resume.
- [x] Extend product Launcher ownership to preparation without releasing the same lock before service startup. A real concurrent DataDir acquisition is rejected during preparation and service running.
- [x] Implement local importer with shared paths, write guard, symlink rejection, completion marker and atomic current-pointer semantics. Packaged preparation has no npm or network path.
- [ ] Connect wizard with real model-profile probe and Runtime Contract observation; failed verification cannot enable automatic work.
- [ ] Exercise a fresh temporary DataDir with network disabled, then separately verify model setup and a real task when credentials/network are available.
- [ ] Commit `feat(desktop): connect first-run setup`.

2026-10-01 follow-up: importer/profile/ownership/runtime resolution tests passed **30/30**; focused desktop controls and release validation passed **35/35**. The actual pinned web profile failed during live HMR mounting after printing its URL. The product now creates its own `legion-desktop` profile with startup patch loading, uses the verified bundled pointer even when an external Runtime command is configured, and passes the Node loader flag before the DSH entry. Three isolated backend services reached their readiness predicates and remained ready after 3 seconds, then shut down with observed bridge exit. Scope explicitly excluded task scheduling; no full-product or model/task PASS is inferred.

### Task 3 next integration sequence

1. [x] Add a main-frame-only native directory picker and typed setup commands to the startup page/preload. Main supplies the selected absolute workspace; the renderer cannot replace the path in its confirmation call. Persist only the workspace path in Legion's private data directory, reject redirects and altered saved paths, and clear inherited workspace overrides in packaged mode.
2. [x] Extend the product desktop owner so workspace initialization and operator settings use its DataDir lease. Preserve existing product configuration. Persist actor, scope, action, attended approval mode and read/write path fence in the highest-precedence Legion user-settings layer, so a project-local config cannot widen the selected workspace. No model key is written in JSON, command arguments, progress or logs.
3. [ ] Complete `createWizard` progression for environment/init/start/model/verify. Identity entry now uses the user's explicit actor/scope/action declarations, an explicit workspace read/write choice, and the attended `ask` preset. It does not invent an actor or let a saved API key count as a model probe. Full task dispatch remains gated on actual model/contract probes and scoped approval.
4. Create the selected model profile in the managed DSH configuration using the actual pinned provider/catalogue declaration and a protected key reference. Verify it through the existing model probe transport and independently observe Runtime Contract readiness. A connected socket or credential-store `has()` cannot pass this step.
5. After configuration, consent, scoped approval transport and both real probes pass, start the complete service scope and independently inspect the product again. Only then can the wizard return its existing completed/ready result. Keep the partial scope and admission unavailable on failure; a wizard result cannot merely substitute a fabricated ready observation for the partial Launcher state.
6. Exercise interruption after workspace selection, key save, partial startup and failed verification. Resume preserves user inputs/data but rechecks readiness. Validate the first-run page and saved-settings restart with the actual packaged application before updating delivery status.

2026-10-01 first-run setup checkpoint: the native picker and workspace confirmation run through main-owned IPC; actor/scope/action and explicit workspace read/write bounds are saved by the existing product owner in a precedence layer that project config cannot override. A saved selection resumes at identity or model according to actual config presence. The attended approval preset is explicit and out-of-scope actions remain fail-closed; the scoped Runtime approval channel remains unimplemented, so a full task is not enabled. Focused settings/control/ownership tests pass **30/30**. The real source Electron window passed workspace selection (native dialog return stubbed), identity submission, persistence, second-launch resume to model setup, rejection from a second window, and observed shutdown. The current installer does not include these source updates; real model/API-key probe, complete wizard, approval transport, full-product admission and updated-packaged UI acceptance remain open.

2026-10-01 implementation checkpoint: desktop preparation/descriptor/ownership/control tests passed **30/30**; the desktop-owned DSH profile and real authenticated hub/Workbench check passed **2/2**. The importer tests include changed bytes, cancellation and retry, complete orphan recovery, escaping destination junctions, a real preparation worker and its cancellation. Wizard UI/model setup and real scoped execution are still pending. Prepared production inputs include Node `24.19.0`, DSH `0.1.5-rc.2` (231 exact-version family packages; 517 installed production packages) and private MinGit `2.56.0.windows.1`. Workbench built from its committed pnpm lockfile. Staging and closure/installer verification are the next gate; no installer completion or clean-VM PASS is claimed.

## Task 4: Desktop local API authentication

**Files:** `product/local-auth.mjs`, `workbench/scripts/serve.mjs`, `workbench/scripts/desktop-auth.test.mjs`, `team-hub/server.mjs`, related config schemas, `product/process-manifest.mjs`, `product/launcher/launcher.mjs`, `product/launcher/desktop-security.test.mjs`, `product/launcher/desktop-bridge.mjs`, `desktop/main.mjs` and focused tests.

**Produces:** Non-empty per-launch Workbench token flows from main through bridge to Workbench; a separate private hub token reaches only team-hub, its proxy and authorized workers. Desktop API and `/hub` proxy enforce token, exact loopback `Host`, and expected `Origin`; hub reads are protected too. Main injects credentials only for the owned main frame/session and verified Workbench target. Readiness probes authenticate; browser/development compatibility remains tested.

- [x] Write tests that unauthenticated reads and writes, malicious Host/Origin, and direct proxy requests fail; valid trusted requests succeed. See RED.
- [x] Implement authentication and token propagation without logging credentials; see GREEN.
- [x] Verify developer mode compatibility and inspect logs/diagnostics for token leakage.
- [x] Commit `feat(desktop): enforce local API credentials`.

### Task 4 follow-up for Runtime approval transport

**Spec:** §7.1. `team-hub/approval-registrar-row.mjs` currently uses a generic hub client without hub credentials in Runtime; a token-protected hub therefore denies its check/inbox calls. The API boundary above is implemented, but full approved execution requires this additional connection.

**Files:** a Launcher-owned approval channel and tests, `team-hub/approval-registrar-row.mjs`, Runtime port configuration/allowlists, Run/attempt lease integration and related schemas.

- [ ] Test against a real authenticated hub: Runtime may submit a scoped request and see only its own request status; it cannot decide approvals, read the whole inbox or write other hub routes.
- [ ] Bind channel grants to active Run/attempt, actor/scope, normalized call hash and cwd; test revoked leases, expired credentials and cross-scope requests.
- [ ] Keep hub credentials in the control plane. Deliver only the narrow short-lived channel credential to Runtime, outside argv/model context/logs.
- [ ] Replace the registrar's direct generic hub transport with the scoped port in desktop mode; retain fail-closed behavior on channel errors.
- [ ] Verify one real request, explicit human approval and a single matching tool execution before marking the complete desktop execution path available.
- [ ] Commit `feat(desktop): add scoped runtime approval transport` after the above verification.

**Existing repository gate:** full configuration scan retains 97 pre-existing integration-related findings in team-hub/workbench/plugins, confirmed identical to committed source. Product configuration scan passes for the desktop changes. Resolve or separately qualify those baseline findings before release; no full-repository PASS is claimed here.

## Task 5: Production asset closure and installer

**Files:** `desktop/package.json`, `desktop/electron-builder.yml`, `desktop/scripts/stage.mjs`, `desktop/scripts/verify-closure.mjs`, payload build script and lock inputs, release-descriptor module/tests, `product/release/runtime-manifest.json`, `docs/superpowers/prt/PRT-011-dsh-distribution-decision.md`.

**Produces:** Version-pinned Electron/Node/npm, built Workbench, Legion production modules and a locked DSH production payload staged in a clean tree. A desktop release descriptor binds exact component versions, bridge generation, target and inventory hashes against the existing runtime manifest. Closure checks reject missing imports, developer-root references, escaping links and unavailable native resources. NSIS creates a current-user x64 installer and stable shortcuts. PRT-011 records the desktop payload decision separately from CLI route C.

- [ ] Write failing closure/descriptor tests for missing module/build/native asset, outside link, wrong target, file-hash or component-version mismatch.
- [ ] Build a locked production payload in an isolated build root; materialize dependency links, retain required licenses and target assets, measure actual payload and staging disk size.
- [ ] Verify payload using the bundled Node rather than host PATH; keep backend modules and resources outside ASAR. This payload is a prerequisite for Task 3 acceptance.
- [ ] Implement NSIS/install staging and pass unpacked and installed-app smoke checks with no developer paths available.
- [ ] Build installer; test installation path containing spaces under non-admin user, offline first preparation and an existing user DSH home remaining independent.
- [ ] Commit `build(desktop): stage and package Windows installer`.

2026-10-01 build checkpoint: production inputs and Workbench built from pinned lockfiles; physical staging contains approximately **28,275 files / 436 MB**. A 265-module static closure check and actual bundled-Node Koffi/Sharp/ConPTY/Windows-DPAPI probes pass. The NSIS resources download was recovered using the official release asset API with the upstream pinned SHA-256, and the unsigned internal installer was generated at approximately **225 MB**. Real packaged-window and offline runtime-import checks pass. Initial per-user installation smoke timed out at 240 seconds; the follow-up bounded 900-second smoke completed installation in 543,687 ms, then passed actual installed-window/exit and observed uninstall with isolated data retained. Clean VM and shortcut verification remain open. See [acceptance evidence](../../release/legion-desktop-acceptance.md).

## Task 6: Upgrade, recovery, and uninstall wiring

**Files:** `desktop/main.mjs`, `product/upgrade/*` targeted modules/tests, `desktop/scripts/*`, NSIS hooks.

**Produces:** Existing upgrade coordinator is sole update owner. Inspect quit impact, stop new admission and drain accepted requests before upgrade, verify the bound release, receive graceful teardown confirmation and observe process exit, switch pointers and run real probes. Forced termination or unknown work cannot authorize installer handoff. Independent recovery works while Host/Workbench are unavailable, and bounded redacted reports retain up to ten failures. Uninstall preserves product data and workspace by default.

- [ ] Write failing tests for active/unknown quit impact, inspection deadline, admission race, missing stop acknowledgement, locked files, bad signature/hash, migration/health failure and data-preserving uninstall.
- [ ] Add bounded crash reports and native/local recovery; verify secret redaction and report-write timeout, and back up optional plugin settings without disabling enforcement.
- [ ] Wire upgrade and UI events, then pass the focused and product upgrade suites.
- [ ] Rehearse upgrade and rollback on Windows VM with real installed app.
- [ ] Commit `feat(desktop): wire upgrade and recovery`.

## Task 7: Acceptance and release evidence

**Files:** `desktop/scripts/acceptance.ps1`, `docs/release/legion-desktop-acceptance.md`, license/SBOM outputs.

**Produces:** Repeatable Windows x64 standard-user acceptance evidence for install, offline core preparation, real model/task execution, second launch, crash/recovery, task-aware shutdown, upgrade, uninstall, data retention, license/SBOM, hashes and signing. Record every unmet gate as open; internal build is not stable merely because unit tests pass.

- [ ] Run full repository test gates and installed-app acceptance on a clean VM without developer tools.
- [ ] Capture exact installer hash, signed/unsigned status, process tree, readiness probes, task/audit evidence, and recovery results.
- [ ] Review the whole diff against this plan and spec; fix Critical/Important findings with RED → GREEN tests.
- [ ] Commit acceptance evidence and select release channel only after all gates pass.
