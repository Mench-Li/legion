# Legion Desktop

Windows x64 desktop entry for the existing Legion Product Launcher. Electron owns the window and tray; `product/launcher/desktop-bridge.mjs` owns the Launcher connection and all services.

For a source checkout, install dependencies in `desktop/` and run `npm start`. A local Node executable must be on `PATH`, or set `LEGION_DESKTOP_NODE` to its absolute path. The production installer will stage its own pinned Node executable and Legion runtime tree.

This development entry is an internal integration build. Desktop mode requires private per-launch Workbench and hub credentials; Electron injects the Workbench credential only into the owned window's verified local origin. Browser development mode remains separate. First-run setup and the independent installer are tracked in [the implementation plan](../docs/superpowers/plans/2026-09-29-legion-desktop.md).

The production design carries a pinned DSH production payload and initializes it locally. The existing npm-based runtime installer remains available for CLI/development; the desktop payload builder and local importer are pending. See [the updated design and official Harness comparison](../docs/superpowers/specs/2026-09-27-legion-desktop-design.md).
