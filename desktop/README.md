# Legion Desktop

Windows x64 desktop entry for the existing Legion Product Launcher. Electron owns the window and tray; `product/launcher/desktop-bridge.mjs` owns the Launcher connection and all services.

For a source checkout, install dependencies in `desktop/` and run `npm start`. A local Node executable must be on `PATH`, or set `LEGION_DESKTOP_NODE` to its absolute path. The production installer will stage its own pinned Node executable and Legion runtime tree.

This development entry is an internal integration build. Desktop mode requires private per-launch Workbench and hub credentials; Electron injects the Workbench credential only into the owned window's verified local origin. Browser development mode remains separate. First-run setup and the independent installer are tracked in [the implementation plan](../docs/superpowers/plans/2026-09-29-legion-desktop.md).

The desktop payload builder and cancellable local importer are implemented. Runtime preparation and service supervision share one Launcher-owned DataDir lease. The x64 installer includes pinned Node/npm, MinGit, the locked DSH production dependency tree and Legion runtime modules; first launch verifies and imports DSH from the installed resources without npm or network access. The desktop runtime uses its own DSH home and does not load or require an operator's DSH web/desktop application or profile.

The startup page provides workspace selection plus actor/scope/action and explicit read/write bounds. Only the owned main frame can invoke the native directory picker; confirmation uses the path held by main. Initialization and non-secret settings persistence share the product owner's DataDir lease. Operator policy is saved in the highest-precedence Legion settings layer, above project config. The model step accepts a password-style API key, verifies the pinned DeepSeek profile against `/v1/models`, and saves the key only in Windows DPAPI protected storage. A verified model receipt is checked again before startup. Automatic task dispatch remains gated on Runtime Contract readiness and scoped approval transport.

## Internal Windows build

Use a Windows x64 builder. From `desktop/`, run `npm ci`, `npm run prepare:node`, `npm run prepare:payload`, and `npm run prepare:git`. Node/Git archives have pinned SHA-256 inputs; DSH has a production lockfile and exact family overrides. Build Workbench using its committed pnpm lockfile, then run `npm run stage`, `npm run verify:closure`, and `npm run pack` or `npm run dist`.

The generated `desktop-release.json` inventories physical Node/npm, Git, DSH and Legion resources. Electron's window code alone is placed inside ASAR. Windows x64 staging removes node-pty's unused ARM64-only binaries before inventory generation, matching the target architecture and NSIS output. Installed first-launch DSH import and Legion service startup have passed on this host; scoped Runtime approval transport, Runtime Contract readiness, task execution, upgrade/recovery and clean-VM release acceptance remain open. A passing internal installer is not yet a signed stable release. See [the implementation plan](../docs/superpowers/plans/2026-09-29-legion-desktop.md) and [the updated design](../docs/superpowers/specs/2026-09-27-legion-desktop-design.md).

`dist` also prepares a hash-pinned NSIS resources archive from the official release asset API. The build scripts are not shipped as installer-time downloads. The installer is per-user and retains product data on uninstall. Current internal artifacts are unsigned and use Electron's default application icon; see [the acceptance record](../docs/release/legion-desktop-acceptance.md) for actual test results and open gates.

The packaged backend uses a managed `legion-desktop` DSH profile with startup patch loading. It does not depend on a separately opened Harness web or desktop application. Node and Git are private to Legion; Windows PowerShell, provided by Windows, supplies current-user DPAPI. Arbitrary project language toolchains are not supplied by the core application bundle.
