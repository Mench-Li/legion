#!/usr/bin/env node
// desktop/helper-entry.mjs —— 升级 helper 的进程入口（设计 §3 / §8 第 7–9 步）
//
// 这个文件是**打包进安装包**、由随包 Node 直接运行的那一段。它必须满足
// 设计 §3 line 57 的三条：
//
//   ① 位于本次事务的**独立受控目录**（打包时放到 `resources/update/`，
//      而程序目录是 `resources/legion/`——两者不互相包含）。
//   ② 由**随包 Node** 运行（`resources/node/node.exe`），不依赖用户机器上
//      有没有 Node，也不依赖 PATH。
//   ③ 启动前核对程序摘要。
//
// ## 为什么入口只有这么几行
//
// 全部判据都在 `product/update/helper.mjs` 里（可测、可 review）。这个文件
// 只做三件在这个进程里才能做的事：
//
//   · 读环境变量里的事务号与目录（**不是**命令行参数：命令行可以被同一
//     用户下的任何进程构造，而环境变量由启动它的那个进程给出）；
//   · 构造 `record` 之类的真实副作用实现；
//   · 把结论写到 stdout 并以进程码表达结果。
//
// 它**不接受**任何"包路径"参数——包路径从固定事务文件里读（设计 §7 line 162：
// 「不信任网页输入的包路径」）。
// ============================================================================

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 从环境变量读调用面。任何一个缺失都直接以"需要人工"退出。 */
function readInvocation() {
  const dataDir = process.env.LEGION_UPDATE_DATA_DIR
  const installDir = process.env.LEGION_UPDATE_INSTALL_DIR
  const txnId = process.env.LEGION_UPDATE_TXN
  const missing = []
  if (typeof dataDir !== 'string' || dataDir === '') missing.push('LEGION_UPDATE_DATA_DIR')
  if (typeof installDir !== 'string' || installDir === '') missing.push('LEGION_UPDATE_INSTALL_DIR')
  if (typeof txnId !== 'string' || txnId === '') missing.push('LEGION_UPDATE_TXN')
  return { dataDir, installDir, txnId, missing }
}

async function main() {
  const invocation = readInvocation()
  if (invocation.missing.length > 0) {
    process.stderr.write(`[update-helper] 缺少环境变量：${invocation.missing.join(', ')}\n`)
    return 2
  }

  // ★ 在这里才 import 产品代码：真正的判据都在 `product/update/helper.mjs`，
  //   而这个入口要保证"即使产品代码装载失败，进程也留下一个可读的结论"。
  let helperModule
  try {
    helperModule = await import(new URL('../product/update/helper.mjs', import.meta.url))
  } catch (error) {
    process.stderr.write(`[update-helper] 无法装载 helper 实现：${error?.message ?? error}\n`)
    // 装载失败时**不**去动任何东西：程序目录、指针、数据库都不碰。
    return 3
  }

  const transactionFile = join(invocation.dataDir, 'update', 'transaction.json')
  if (!existsSync(transactionFile)) {
    process.stderr.write(`[update-helper] 事务文件不存在：${transactionFile}\n`)
    return 2
  }

  try {
    const report = await helperModule.runHelperProcess({
      dataDir: invocation.dataDir,
      installDir: invocation.installDir,
      // helper 自己所在的目录就是"独立受控目录"。
      helperDir: here,
      // 真实部署里这些摘要由打包流程写进 `update-helper-digests.json`；
      // 缺失时 `runHelper` 会在步骤读数里注明"调用方负责提供"，
      // 而不会把它当成"已经核对过"。
      expectedProgramDigests: readExpectedDigests(),
      programFiles: { entry: fileURLToPath(import.meta.url) },
      // 第 7 步的真实实现（解压包到版本目录）由打包侧注入；
      // 没有它时 helper 会明确报"解压失败"，而不是假装完成。
      effects: buildEffects(),
      stdout: process.stdout,
    })
    // 进程码表达结论：0 提交、10 回退、20 需要人工。桌面端/Launcher 下次
    // 启动时读 helper 报告，而进程码用于当场的运维读数。
    if (report.verdict === 'committed') return 0
    if (report.verdict === 'rolled-back') return 10
    return 20
  } catch (error) {
    process.stderr.write(`[update-helper] 未捕获的失败：${error?.stack ?? error}\n`)
    return 20
  }
}

/** `update-helper-digests.json` 由打包流程写入（与 helper 同目录）。 */
function readExpectedDigests() {
  try {
    const file = join(here, 'update-helper-digests.json')
    if (!existsSync(file)) return {}
    // 这里用 JSON.parse 而不是严格扫描器：它是**自述文件**，不是待验签的
    // 网络输入；真正的拒绝判据在 `credential.mjs` 的 `verifyProgramDigest`。
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 真实副作用。
 *
 * 目前只装了"能安全通用"的那部分；`unpack`（解压 ZIP 到版本目录）需要
 * 与桌面打包闭包对齐，由打包侧注入——在此之前 helper 会明确报
 * `helper-unpack-failed`，也就是"没有假装完成"。这是刻意的：一次
 * "以为解压了其实没有"的升级会去切换一个不完整的版本目录。
 */
function buildEffects() {
  return {
    // 迁移存储由 helper 在**本进程内**构造（活的数据库句柄跨不过 JSON 事务文件）。
    createMigrationStore: null,
    unpack: null,
  }
}

// `readExpectedDigests` 用 `readFileSync`（在顶部已导入）。
process.exitCode = await main()
