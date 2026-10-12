import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // ★ `base: './'`（**相对**）是"一份产物、两个宿主"的前提：
  //   · `serve.mjs` 挂在 `/`（本地 / 桌面端）→ 资源解析成 `/assets/…`；
  //   · 中枢挂在 `/workbench/`（远程）→ 资源解析成 `/workbench/assets/…`。
  //
  //   刻意**不用**绝对 base（`'/workbench/'`）：那会把挂在根上的 `serve.mjs`
  //   一起弄坏 —— 而"为了新增一个宿主去改坏另一个宿主"不是一个好交易。
  //   用相对 base 就不用改任何一个宿主。
  //
  //   ⚠️ 只有在**没有客户端路由**时这条路才成立，而工作台确实没有
  //     （没有 react-router / `pushState` / `location.pathname`，逐个查过）。
  //     相对路径在深链接下会解析到错误的层级。将来若加了真路由，
  //     这里要换成绝对 base，并给 `routes/workbench.mjs` 补上
  //     「导航请求回 index.html / 资源请求如实 404」的回退。
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  build: {
    outDir: 'dist',
  },
})
