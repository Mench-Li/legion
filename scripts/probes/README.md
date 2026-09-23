# scripts/probes —— 量具（第 118 轮第十二轮）

这些脚本**不是产品代码**，是历轮用来**量**仓库的探针：把某个读数变成可复跑的东西。

## 为什么它们在这里（而不是在 `scratch/`）

原来它们在 `scratch/`（未跟踪、也不在 `.gitignore` 里）。而**文档与脚本引用了上百个
`scratch/…` 路径当"可复跑的量具"** —— 那些引用指向的是**只存在于当时那个工作区**的文件：

> 一个"证据可复跑"的读数，与一个"证据在别人的检出里根本不存在"的读数，
> 在**本机**是同一个东西。

业主第 118 轮第十二轮确认：收进这里并跟踪。于是"可复跑"对**任何检出**都成立。

## 约定

- 引用一律写 `scripts/probes/<名字>`（第十一轮改写前是 `scratch/<名字>`）。
- 这些脚本按**当时的仓库状态**写成，**不保证今天还能跑通**；它们是"当时怎么量的"的存档。
- ★ 其中 `census-generated-status.mjs` 是 `scripts/prt/boundary-facts.mjs` 那条
  "生成物不许断言任务状态"判据的**量具**——因此 `probes` 也在那条判据的跳过目录里
  （量具不是产物；见 `boundary-facts.mjs` 的 `SCAN_SKIP` 注释）。

## 已丢弃的量具（引用仍在，文件没了）

- `scratch/.mutant-in-progress.json`
- `scratch/_mutate-r55-s5index.mjs`
- `scratch/probe-lease-wiring.mjs`
- `scratch/t110-build/build-deps.mjs`

这四处引用在原文里已标注"**已随批次丢弃**"——不留一个指向空处的坐标。
