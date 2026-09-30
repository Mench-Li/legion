# Legion Desktop

Windows x64 desktop entry for the existing Legion Product Launcher. Electron owns the window and tray; `product/launcher/desktop-bridge.mjs` owns the Launcher connection and all services.

For a source checkout, install dependencies in `desktop/` and run `npm start`. A local Node executable must be on `PATH`, or set `LEGION_DESKTOP_NODE` to its absolute path. The production installer will stage its own pinned Node executable and Legion runtime tree.

This development entry is an internal integration build. First-run setup, desktop API authentication, and the independent installer are tracked in [the implementation plan](../docs/superpowers/plans/2026-09-29-legion-desktop.md).
