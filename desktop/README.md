# Legion Desktop

Windows x64 desktop entry for the existing Legion Product Launcher. Electron owns the window and tray; `product/launcher/desktop-bridge.mjs` owns the Launcher connection and all services.

For a source checkout, install dependencies in `desktop/` and run `npm start`. A local Node executable must be on `PATH`, or set `LEGION_DESKTOP_NODE` to its absolute path. The production installer will stage its own pinned Node executable and Legion runtime tree.

This development entry is an internal integration build. Desktop mode requires private per-launch Workbench and hub credentials; Electron injects the Workbench credential only into the owned window's verified local origin. Browser development mode remains separate. First-run setup and the independent installer are tracked in [the implementation plan](../docs/superpowers/plans/2026-09-29-legion-desktop.md).

The desktop payload builder and cancellable local importer now exist. Runtime preparation and service supervision share one Launcher-owned DataDir lease. Core dependencies are resolved at build time and imported from the installed files without npm or network access. The desktop runtime uses its own DSH home and does not load an operator's DSH profile.

## Internal Windows build

Use a Windows x64 builder. From `desktop/`, run `npm ci`, `npm run prepare:node`, `npm run prepare:payload`, and `npm run prepare:git`. Node/Git archives have pinned SHA-256 inputs; DSH has a production lockfile and exact family overrides. Build Workbench using its committed pnpm lockfile, then run `npm run stage`, `npm run verify:closure`, and `npm run pack` or `npm run dist`.

The generated `desktop-release.json` inventories physical Node/npm, Git, DSH and Legion resources. Electron's window code alone is placed inside ASAR. First-run wizard, scoped Runtime approval transport, upgrade/recovery and installed-app acceptance remain open; a built internal installer is not a completed or releasable product. See [the implementation plan](../docs/superpowers/plans/2026-09-29-legion-desktop.md) and [the updated design](../docs/superpowers/specs/2026-09-27-legion-desktop-design.md).
