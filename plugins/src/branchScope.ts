/**
 * plugins/src/branchScope.ts — 「这条切片分支自己改了什么」的 refspec 判定（BUG-008）。
 *
 * 为什么单独抽出来：这个判定**只是一个字符串里两个点还是三个点**，但它决定闸门会不会误拦交付，
 * 而误拦的代价是整条交付停在 in_review 等人工 —— 一个"看不出区别"的字符错了，症状出现在很远的地方。
 * 抽成纯函数后，测试可以直接钉住它，并配一个真实 git 仓库的行为用例（见
 * plugins/tests/branch-scope.test.mjs）。
 *
 * 两个点的区别（git 语义）：
 *   · `A..B`  = 两棵树**当前**的差异。主分支在切片飞行期间新增/修改的文件，会被算成"切片改的"。
 *   · `A...B` = `merge-base(A,B)..B`，即**只算 B 自己**从共同祖先之后做的改动。
 *
 * 实测（2026-10-05）：
 *   · `w/T-178` 自己只改 11 个文件（全在声明的域内），两点法给出 13 个 —— 多出来的 2 个是别人
 *     在它飞行期间合进 main 的 `docs/bugs/BUG-006-*.md`；闸门据此判"越域"，把合规交付拦下。
 *   · `w/T-179` 一个提交都没有（HEAD 就是自己的基线），两点法却报出 14 个"越域文件"。
 *
 * 这个错误方向特别坏的地方在于：**它随主分支的活动量增加而更容易触发** ——
 * 越多人正常往 main 合东西，越容易有切片被误判越域；而正确方向（切片真改了域外文件）
 * 三点法一样抓得到，所以改掉它不会放过任何该拦的。
 */

/**
 * 取「分支自己改了什么」的 diff refspec。
 *
 * @param mainRef 主分支引用（通常是当前检出的分支名，如 `main`）
 * @param branch  切片分支（如 `w/T-178`）
 * @returns 供 `git diff --name-only <refspec>` 使用的 refspec —— **三点**形式
 */
export function branchOwnChangesRefspec(mainRef: string, branch: string): string {
  return `${mainRef}...${branch}`
}
