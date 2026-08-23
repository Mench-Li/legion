# ADR 索引

> 状态：7 份均为「草案」，由将军逐项签发后转正式。

| ADR | 主题 | 决策摘要 |
| --- | --- | --- |
| ADR-0001 | 同步引擎 | LWW 操作式 CRDT + 自研零依赖 ws relay（对齐 Yjs 语义） |
| ADR-0002 | 渲染 | Canvas 2D 单画布 + presence overlay + Renderer 接口 |
| ADR-0003 | v1 元素清单 | rect/ellipse/line(箭头)/freehand/单行文本 + 单选/移动/缩放/删除/改色/线宽 + pan/zoom |
| ADR-0004 | 持久化 | SQLite(WAL) 单文件（node:sqlite）+ StorageProvider 抽象 |
| ADR-0005 | 部署形态 | 单容器 Docker + compose + 静态前端 + 单进程 + /healthz，单实例 |
| ADR-0006 | 撤销语义 | 每用户局部撤销 + clear-on-remote（撤销后远端并发 op 清空 redo） |
| ADR-0007 | 状态分层 | 持久态（元素）与临态（presence）物理分离，presence 不入文档/undo/持久化 |
