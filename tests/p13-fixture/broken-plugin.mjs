/**
 * broken-plugin.mjs — P4-2 **负向**夹具：一个在**导入期**就抛错的插件条目。
 *
 * 用途：验证「插件条目导入失败」在 p13 真实宿主里被翻成明确断言失败（而不是「60s 未就绪」）。
 * 它只在 `tests/p13-fixture/host-diagnostics...` 的负向用例里被挂载，任何生产 profile 都不引用它。
 */
throw new Error('p13-broken-plugin: 故意在导入期抛错（P4-2 负向夹具）')
