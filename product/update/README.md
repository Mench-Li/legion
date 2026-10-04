# product/update

Legion 桌面端自动更新的协议与客户端。
设计文档：[`docs/superpowers/specs/2026-10-02-legion-desktop-auto-update-design.md`](../../docs/superpowers/specs/2026-10-02-legion-desktop-auto-update-design.md)

实施记录与**未完成清单**：[`docs/superpowers/plans/2026-10-04-auto-update-implementation.md`](../../docs/superpowers/plans/2026-10-04-auto-update-implementation.md)

## 分四层，各自回答一个问题

```
信任层    canonical → envelope
          "这份清单是不是发布方签的，且没被改写？"

协议层    host → release → feed → semver
          "发行的形状对不对，我能不能升上去？"

传输层    transport → schedule → cache
          "什么时候取、取到哪儿、失败怎么办？"

事务层    state → client → journal → barrier → credential → install → helper
          "谁在什么时候动程序，崩了之后回到哪里？"
```

`index.mjs` 是唯一的入口；`selfCheckAll()` 汇总各层的装载期自检。

## 三条容易被违反的纪律

**① 没有"跳过验签"的开关。** `index.mjs` 刻意不导出任何 `allowUnsigned`
之类的东西。那类参数会在第一次部署出问题时被用上，然后再也没人拿掉。

**② 读不出来的状态按"最坏"处理。** 维护屏障损坏 → 按"维护中"处理；
事务日志中间有坏行 → `recovery-required`；活动指针读不出来 → `recovery-required`。
代价不对称：多等一会儿 vs 在数据上写入。

**③ 每个模块装载时把自己跑一遍。** `*_CHECKED` 上的 `problems` 非空即
该模块自己的判据不自洽。`modules.test.mjs` 逐个读它们并要求全绿——
一条永远返回 ok 的自检比没有自检更糟，所以它还检查自检**报出了真读数**。

## 发布端工具

```bash
node scripts/update/keygen.mjs new   --key-id release-2026-a --out ./keys
node scripts/update/keygen.mjs trust --install-root . --key-id release-2026-a \
     --public-key ./keys/release-2026-a.pub.pem
node scripts/update/publish.mjs --payload-root ... --key-id ... --private-key ... --out ./dist
node scripts/update/verify-host.mjs --origin https://... --channel stable --trust ./product/release/update-trust.json
```

`publish.mjs` **不**上传。设计 §9 line 202 要求"先传全部不可变文件、最后才
替换通道清单"，所以它只产出文件与一份把顺序写死的上传计划
（`upload-plan.txt`）。把两个动作绑在一起的脚本，任何一次部分失败都会留下
"通道指向一个不存在的 releaseId"。

## 测试

```bash
node --test product/update/*.test.mjs
```

- `client.test.mjs` —— 真签名、真摘要、真文件的端到端（26 条）。
  它守的是**接线**：协议件各自的单测都过，而"验签之后的摘要有没有比对"、
  "被拒的清单有没有抬高 sequence 水位"只在把件装起来之后才存在。
- `install.test.mjs` —— 逐个驱动设计 §8 的失败表（40 条）。
- `modules.test.mjs` —— 装载期自检汇总（4 条）。
