# 俄罗斯 / Ozon「百货」品类 discovery 查询包（每日批次）

phase_status: done
market: ru
category: 百货（家庭日用/小件百货）
channel_families_planned: marketplace / search / social / community
captured_date: 2026-08-23

## 语言与查询说明

- 基准研究语言：ru-RU（俄语）。
- 全部查询使用俄语本地词（товары для дома / хозтовары / кухонные принадлежности / бытовая мелочь / уборка / органайзер / контейнер / вешалка / присоски 等）。
- 查询经 web_search 执行；随后用公开直接打开（curl）核验具体页面原文。Ozon 前台（ozon.ru）对本机返回 403，Yandex 搜索前端返回 SmartCaptcha，Otzovik 返回 507，VK/YouTube/TikTok/Dzen 需 JS/登录无法直接打开——这些受限入口在下方与 raw-evidence 中如实标注为不可访问/营销内容，未纳入有效证据。
- 意图家族沿用工作区既有 taxonomy（how_to_solve / why_keeps_happening / better_alternative / bought_but_dissatisfied / returned_because / breaks_easily / hard_to_clean / takes_too_much_space 等），并结合百货子域。

## 查询表（实际执行）

| domain_id | intent_family | local_query | literal_zh | intended_user_intent | likely_source_channel | note |
|---|---|---|---|---|---|---|
| home_cleaning_storage | how_to_solve | как организовать хранение бытовой мелочи дома | 如何在家里收纳日用零碎物品 | 寻找用户主动解决收纳障碍的办法与步骤 | search, community | 命中收纳类内容农场标题，见 raw ru-daily-0010 |
| home_cleaning_storage | how_to_solve | куда деть бытовую мелочь хранение маленькая квартира | 小公寓里的日用小物件往哪儿放 | 识别小户型收纳冲突与方案 | search, community | 命中 progorodnn 内容，见 raw ru-daily-0012 |
| home_cleaning_storage | how_to_solve | как решить проблему хранения на кухне органайзеры | 如何解决厨房收纳问题（收纳架） | 寻找厨房收纳反复问题的解决办法 | search, community | 命中 Ozon 挂钩内容，见 raw ru-daily-0011 |
| home_cleaning_storage | breaks_easily | швабра сломалась через неделю что делать | 拖把一周就坏了怎么办 | 寻找清洁工具耐用性失败与修理/更换行为 | search, marketplace | 命中"修晾衣架"类内容，见 raw ru-daily-0013 |
| home_cleaning_storage | breaks_easily | почему присоски отваливаются от плитки что делать | 吸盘为什么从瓷砖上掉下来、怎么办 | 寻找吸盘固定失效与替代方案 | search, community | SERP 结果主要为通用/IKEA 类，未形成可核验俄语用户原文 |
| kitchen_utensils | breaks_easily | почему ломаются кухонные принадлежности силиконовые | 为什么硅胶厨具会坏 | 寻找厨具耐用性失败与材质比较 | search, community | 命中英文 ABC 科普，非俄语用户证据，未采 |
| kitchen_utensils | bought_but_dissatisfied | кухонные принадлежности ozon отзывы недостатки | Ozon 厨具评价 缺点 | 寻找已购买后不满意的失望证据 | marketplace, community | 经 Yandex Market 评价页核验（刀具/拖把），见 raw |
| home_cleaning_storage | bought_but_dissatisfied | товары для дома хозтовары ozon отзывы покупателей | 家居用品 日杂 Ozon 买家评价 | 寻找买家对日杂商品的真实评价与问题 | marketplace, community | 命中 Ozon 关联内容标题，见 raw ru-daily-0011 |
| home_cleaning_storage | returned_because | irecommend.ru полка для ванной на присосках отзыв падает | iRecommend 浴室吸盘置物架 评价 掉落 | 寻找吸盘置物架掉落/退货证据 | community | iRecommend 后续 521 限流，未取到该条原文 |
| home_cleaning_storage | breaks_easily | irecommend.ru крючки на присосках отзыв отваливаются | iRecommend 吸盘挂钩 评价 脱落 | 寻找吸盘挂钩脱落证据 | community | iRecommend 521，未取到原文 |
| home_cleaning_storage | breaks_easily | irecommend.ru сушилка для белья отзыв сломалась | iRecommend 晾衣架 评价 坏了 | 寻找晾衣架损坏证据 | community | iRecommend 521，未取到原文 |
| kitchen_utensils | bought_but_dissatisfied | irecommend кухонные принадлежности отзывы разочарована | iRecommend 厨具 评价 失望 | 寻找厨具失望评价 | community | 命中亚马逊噪声为主，未采 |
| home_cleaning_storage | better_alternative | irecommend.ru контейнер для хранения отзыв трещина | iRecommend 收纳盒 评价 开裂 | 寻找收纳盒开裂与玻璃替代偏好 | community | 取到 Fimako 收纳盒正面评价+玻璃偏好评论，见 raw ru-daily-0008 |
| home_cleaning_storage | why_keeps_happening | как организовать хранение | 如何做收纳 | 识别收纳需求的持续内容供给 | search | 命中 gazeta45 标题，见 raw ru-daily-0014 |
| home_cleaning_storage | not_suitable_for_segment_or_context | хозтовары отзывы покупателей проблемы | 日杂 买家评价 问题 | 识别特定人群/场景不适用边界 | community, marketplace | Otzovik 507 不可访问，见 raw 说明 |
| marketplace_ozon_global | returned_because | ozon global возврат отказ контрафакт | Ozon Global 退货 拒绝 假货 | 寻找 Ozon Global 跨境退货/假货摩擦证据 | community, marketplace | 取到 vc.ru 用户投诉，见 raw ru-daily-0009 |

## 渠道可达性小结（本批次）

- marketplace：Ozon 前台 403；改用 Yandex Market 公开评价页（reviews.yandex.ru）直接打开，取到逐字评价原文。✓
- search：web_search 执行俄语查询，记录查询词与逐字结果标题作为需求信号；Yandex SERP 前端被 SmartCaptcha 阻断。✓（低置信）
- community：iRecommend 直接打开可取到 2 条完整原文后进入 521 限流；Otzovik 507 不可访问；vc.ru「Приёмная」可取到 1 条 Ozon 用户投诉。部分 ✓
- social：VK / YouTube / TikTok / Dzen 均需 JS 或登录，无法直接打开用户评论；Telegram 命中的频道为卖家/营销频道；仅取到 1 条 Pikabu 公开帖（编辑性质，非用户痛点）。严重不足，本批次 social 覆盖率低。
