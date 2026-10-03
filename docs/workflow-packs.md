# Legion 工作流包说明

工作流包是带版本号的声明式场景包。Legion 首次启动桌面服务时，会自动安装随软件附带的 `legion.software-collaboration` 包，并导入到 `software` 空间；仅当该空间尚不存在时才会导入。新空间会关联 Legion 当前选定的工作区。已有空间和用户修改过的包内容都会保留。

## 导入工作流包

1. 打开 Legion，在 Workbench 左侧选择“流程包”。
2. 选择本地 `.legionpack` 文件。Legion 会校验文件，并显示目标空间、版本、角色、流程阶段和附带资源。
3. 检查预览。新空间选择“确认安装”；只有当包管理的内容未被本地修改时，才可对新版选择“确认升级”。
4. 如果 Legion 提示冲突，请先处理已有空间或本地改动。导入器不会覆盖这些内容。

已安装包中的文档、技能和模板，可在包卡片中选择“查看包内内容”。安装工作流包不会开启自动执行任务；工作区访问仍受该空间现有的 Legion 权限约束。

## 制作工作流包

`.legionpack` 文件是使用 `legion/workflow-pack@1` 格式的 UTF-8 JSON 对象。可以从首发的软件协作包复制并修改：桌面构建会在安装器旁导出 `software-collaboration.legionpack`，安装后的原始文件位于 `resources/legion/workflow-packs/`。在源代码仓库中，该包会在桌面暂存时由 `roles.json` 和 `workflows/soldier-prompt.md` 生成。

顶层字段为 `format`、`id`、`version`、`name`、`description`、`scope`、`roles`、`stages` 和 `assets`：

- `id` 是稳定的包标识，例如 `example.ozon-operations`；`version` 使用 `MAJOR.MINOR.PATCH` 格式。
- `scope` 包含小写的空间 `id` 和用于显示的 `name`。不同场景应使用不同的空间 ID。
- 每个角色必须恰好对应一个同角色 ID 的流程阶段。阶段的 `next` 必须是另一个阶段的 ID，或 `null`。
- `assets` 内嵌文本资源，类型限于 `skill`、`document` 或 `template`，并提供显示标题和相对路径。
- 不得包含 API 密钥、访问令牌、密码、机器专属路径、私人任务数据或可执行代码。服务凭据应单独保存在 Legion 密钥库中。

v1 限制：单个包最大 2 MB；最多 32 个角色、32 个阶段、128 个资源；单个资源最大 256 KB。路径必须是包内相对路径，绝对路径和 `..` 越界路径会被拒绝。未知字段和可执行载荷也会被拒绝。预览阶段会计算规范化 JSON 的 SHA-256 摘要；包导入回执和已应用内容摘要保存在 Team Hub 数据库中。

Ozon 场景可使用同一格式定义岗位、订单处理阶段和操作指引。连接器设置及 Ozon 凭据需要另外配置，不会随工作流包导入。
