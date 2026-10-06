/**
 * greet —— 端到端验收（任务 T-004）演示实现。
 *
 * 任务（手机下发）：「端到端验收：请写一个 greet 函数并跑一次测试」。
 *
 * 契约与仓库自带的 greet 验收夹具保持一致（见 tests/p13-fixture/*.mjs）：
 *     greet(name) === `Hello, ${name}!`
 *
 * 纯函数：无 I/O、无副作用、零第三方依赖。
 */

/**
 * 按统一契约问候指定名字。
 *
 * @param {string} name 被问候者的名字（调用方保证为字符串）。
 * @returns {string} 形如 `Hello, Ada!` 的问候语。
 */
export function greet(name) {
  return `Hello, ${name}!`
}
