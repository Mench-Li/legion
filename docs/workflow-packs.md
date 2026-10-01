# Legion workflow packs

Workflow packs are versioned, declarative scene packages. The first-party `legion.software-collaboration` pack ships with Legion and is installed into the `software` space on first desktop startup when that space does not already exist. It binds the space to the workspace selected in Legion. Existing spaces and locally edited package content are preserved.

## Import a pack

1. Open Legion and choose **流程包** in Workbench.
2. Choose a local `.legionpack` file. Legion validates it and displays the target space, version, roles, stages and attached resources.
3. Review the preview. Choose **确认安装** for a new space or **确认升级** for an unchanged package with a newer version.
4. If Legion reports a conflict, resolve the existing space or local edits first. The importer does not overwrite them.

Installed documents, skills and templates are available under **查看包内内容** on the package card. A workflow pack does not turn on automatic task execution. Workspace access still follows the selected space's existing Legion permissions.

## Create a package

A `.legionpack` file is a UTF-8 JSON object using `legion/workflow-pack@1`. Start from the built-in software package as an example: the desktop build emits a copy named `software-collaboration.legionpack` beside the installer in `desktop/dist/`, and the installed source is under `resources/legion/workflow-packs/`. In a source checkout it is generated during desktop staging from `roles.json` and `workflows/soldier-prompt.md`.

The top-level fields are `format`, `id`, `version`, `name`, `description`, `scope`, `roles`, `stages` and `assets`:

- `id` is a stable package identifier such as `example.ozon-operations`; `version` uses `MAJOR.MINOR.PATCH`.
- `scope` contains a lowercase space `id` and display `name`. Give separate packs separate scope IDs.
- Every role must have exactly one workflow stage with the same role ID. A stage's `next` must name another stage or be `null`.
- Assets are inline text with type `skill`, `document` or `template`, a display title and a relative path.
- Never include API keys, access tokens, passwords, machine-specific paths, private task data or executable code. Put service credentials in Legion's credential store separately.

The v1 limits are 2 MB per complete package, 32 roles, 32 stages, 128 assets and 256 KB per asset. Paths must stay relative to the package; absolute paths and `..` traversal are rejected. Unknown fields and executable payloads are rejected. The package preview computes a canonical SHA-256 digest; package receipts and the applied-content digest are stored in the Team Hub database.

Ozon-specific workflows can use the same package format for roles, order stages and operator instructions. Connector setup and Ozon credentials remain separate configuration and are not imported with the workflow pack.
