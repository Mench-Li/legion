# 俄罗斯 / Ozon 硬门槛扫描（T-001 第一阶段第一步）

更新日期：2026-07-23（抓取日同）  
研究对象：中国大陆公司主体进入俄罗斯 Ozon（俄最大电商平台），选品→上架→运营全流程 Agent 化。  
适用约束：首轮验证损失上限 5,000–20,000 元人民币；本人不出镜；可做产品实拍与达人内容。

> 本文只回答「能否进入、要满足什么条件、还缺什么证据」，不做市场排名，也不推荐产品。  
> 证据等级：A = 政府/监管/平台官方；B = 权威机构/透明方法；C = 平台页面样本/店铺观察；D = 媒体/服务商/社区经验。  
> 每条关键结论标注等级 + 来源 URL + 日期；未知项一律写「待补证」并给补证计划。

---

## 0. 判定口径（对齐 market-hard-gates.md 风格）

- **初步通过**：至少存在一条已由官方资料确认、适合中国大陆企业的开店路径；核心税关规则可识别。
- **有条件通过**：路径存在，但主体、进口商、平台审核、本地退货或品类合规等条件尚需在具体模式下验证。
- **待补证**：准入或税关至少一个关键环节仍缺官方闭环证据；不得进入最终排名。
- **不通过**：当前约束下没有合法、可执行、且能在预算内验证的路径。

缩写：`FBP` = Ozon 跨境直发履约（Real FBS 类似，卖家跨境自发）；`FBS` = 卖家自有仓自发（多指俄罗斯本土仓）；`FBO` = Ozon 履约仓（平台仓，货物先入俄罗斯仓）；`EAC` = 欧亚经济联盟（EAEU/海关联盟）统一合格标志；`TR CU` = 海关联盟技术法规（即 CUTR 认证依据）。

---

## 1. 主体与平台准入 — **初步通过**

### 1.1 事实（Facts）

1. **中国大陆企业可注册 Ozon 跨境店（Ozon Global）。** Ozon 官方卖家文档存在简体中文版注册流程，URL 带 `country=CN` 定位，明确以中国卖家为目标市场。[A] https://docs.ozon.ru/global/zh-hans/launch/steps/step-1/ （2026-07 抓取）；镜像站 https://docs.ozon.kz/global/zh/launch/steps/step-1/ 同样提供中文注册激活步骤。
2. **跨境店 vs 本土店的本质区别是「发货主体/履约仓」而非「准入国家」。** Ozon 官方费用页按 FBO（Ozon 仓）/ FBS（卖家仓）/ FBP（跨境直发）分档：FBP 模式下佣金比自有仓低 1%，说明跨境直发是官方支持的常态化履约模式。[A] https://docs.ozon.ru/global/en/commissions/ozon-fees/fbp-rates/
3. **入驻材料（第三方一致口径，待官方复核）**：营业执照、法人/股东身份证明、收款账户；组织类型需在「公司 / 个体工商户 / 个体经营者」中选择，中国主体以营业执照对应类型为准。[D] https://www.cifnews.com/article/184226 、 https://erp.91miaoshou.com/blog/article_871.html

### 1.2 推断（Inference）

- 中国公司走「跨境店 + FBP/FBS」路径门槛较低，不需要俄罗斯本地公司、本地董事或本地仓即可启动（置信度：中高，来自官方 FBP 存在性 + 中文注册页）。
- 「本土店」（俄罗斯主体 + 俄罗斯仓 + FBO）路径需要先设立俄罗斯法人或个体户、开俄罗斯银行账户，属较高门槛路径，本阶段不作为首选。

### 1.3 结论：**初步通过**（维度级）

- 理由：Ozon 官方中文注册流程 + 跨境直发履约模式均存在，中国公司开跨境店路径可由官方资料确认。
- 未闭环项：①是否收取**保证金/押金**及金额；②是否**邀请制/招商审核制**；③中国「个体工商户」是否与「公司」同等准入；④商标（品牌）是否为必选项。均需以官方注册页或招商页最终为准 → 见「待补证清单」。

---

## 2. 税务与关务 — **有条件通过**

### 2.1 事实（Facts）

1. **EAEU 个人用品免税进口门槛维持 200 欧元。** 欧亚经济联盟委员会（EEC）维持跨境个人用品 200 欧元免税门槛。[A/B] https://www.interfax.com/newsroom/top-stories/109960/ ；中国海关总署哈尔滨海关转发口径：[A] http://gdfs.customs.gov.cn/harbin_customs/zw18/xwdt87/zoyhgdt/6806830/index.html
2. **电商货物 5% 关税 + 200 欧元免税门槛，自 2026-07-01 起。** EEC 于 2026-01-12 批准：对通过电商平台进口（B2C）的货物设 200 欧元免税门槛，超门槛部分征 5% 关税。[A/B] https://interfax.com/newsroom/top-stories/115527/ （2026-01-12）；此前俄罗斯已同意该方案并维持 200 欧元门槛：[A/B] https://interfax.com/newsroom/top-stories/113736/ （2025-09-09）。
3. **VAT 逐步覆盖跨境电商。** 俄罗斯财政部提议对跨境电商逐步引入 VAT，到 2029 年实现全额征收（标准税率 20%）；国家杜马相关委员会 2026-02-16 已支持对平台上进口商品征 VAT。[B] https://interfax.com/newsroom/top-stories/116512/ （2026-03-06）、 https://interfax.com/newsroom/top-stories/116189/ （2026-02-16）。
4. **「2027 年全面取消跨境小包免税」的中文媒体说法存在，但未找到官方原文。** 仅见中文电商媒体转述，属待证命题，不单独采信。[D] http://100ec.cn/detail--6654362.html 、 https://www.amz123.com/t/MyyPrUJn

### 2.2 两种场景（中国→俄直发 与 FBO 入仓）拆分

| 场景 | 关税/免税 | VAT | 进口商责任 | 状态 |
|---|---|---|---|---|
| **中国→俄直发（FBP/realFBS）** | ≤200 欧/件免税（2026-07 前适用个人用品口径；2026-07 起电商口径 5% 关税） | 2026–2029 逐步引入，最终 20% | 低值包裹常由物流商/平台以简化清关申报；进口商是谁、平台是否代扣需逐线路确认 | **待补证** |
| **FBO 入仓（先运俄罗斯仓）** | 批量正式进口，无 200 欧/件免税口径，按 HS 编码计征关税 | 进口环节 VAT（可抵扣/代缴取决于主体） | 需俄罗斯进口商（本地主体或进口代理/报关行），责任主体必须写进合同 | **待补证（SKU+线路级）** |

### 2.3 结论：**有条件通过**

- 理由：税关框架可识别（200 欧门槛、5% 关税、20% VAT 方向明确），但正处于 2026–2029 政策变动期；「平台是否代扣、直发进口商是谁、FBO 的进口清关主体与 VAT 抵扣安排」均未闭环。
- 关键风险：**政策已确认要变（电商 5% 关税 2026-07-01、VAT 逐步至 20%），任何直发成本模型必须以 2026-07-01 后的规则为基准，而非沿用旧免税口径。**

---

## 3. 收款与资金 — **有条件通过**

### 3.1 事实（Facts）

1. **结算币种可由卖家选择。** Ozon 官方说明「结算货币」：跨境卖家可选择卢布、美元或人民币等结算币种；此前在转账到卖家银行账户时才做转换，现行机制按所选结算币种处理。[A] https://docs.ozon.ru/global/zh-hans/accounting/receiving-payments/payment-currency/ 、 https://docs.ozon.ru/global/en/accounting/receiving-payments/payment-currency/
2. **存在 30 天级支付冻结/延迟。** 物流服务商 Deliver2 报道 Ozon 与 WB 对卖家设置了 30 天付款限制（结算延迟）。[D] https://deliver-2.com/news/marketplaces/wb-and-ozon-have-limited-payments-to-sellers-for-a-period-of-30-days/
3. **中国公司收款通道为第三方支付/结汇服务商。** 连连支付（LianLian Pay）、PingPong、万里汇等被广泛用于 Ozon 回款结汇至人民币；连连支付官方站有 Ozon 提款说明。[D] https://global.lianlianpay.com/article/MTQ0MTQxLDQ0ZA.html 、 https://global.lianlianpay.com/article/MTQ5NzA3LDRmYQ.html

### 3.2 推断（Inference）

- 结算币种官方可确认；但**结算周期（是否每月/每月两次）、最低提现门槛、准备金比例、新店风控冻结期限**的精确值仍以第三方口径为主，缺乏 Ozon 官方「结算时间表」页的闭环。（置信度：币种高，周期/准备金中）

### 3.3 结论：**有条件通过**

- 理由：币种与官方收款机制可识别，中国公司可用第三方结汇通道；但周期、准备金、冻结规则需官方闭环后才能算现金流。
- 对冷启动的直接影响：与 Amazon/Coupang 同类——**首轮现金流需额外预留至少一个结算周期（按 30 天口径压力测试）+ 退款准备金。**

---

## 4. 物流与退货 — **有条件通过**

### 4.1 事实（Facts）

1. **履约模式官方分档：FBO / FBS / FBP（realFBS）。** FBP 为跨境直发，佣金较自有仓低 1%。[A] https://docs.ozon.ru/global/en/commissions/ozon-fees/fbp-rates/
2. **FBO 仓储费结构近期大幅调整（2025-04）。** 大件商品（KGT）免费仓储期自 2025-04-17 起由 90 天缩短至 30 天，仓储费率由约 1.5 卢布/升/天降至 0.07 卢布/升/天；退货仓储费同月上调。[D] https://i.ifeng.com/c/8iWpc3QIKkv 、 https://www.chwang.com/news/190985435089
3. **退货逆向成本由卖家承担的情形存在。** 退货流程中退货运费/仓储/弃置的归属按原因划分（买家反悔 vs 质量问题 vs 平台判定），具体分摊需按平台规则与商品状态核验。[D] https://erp.91miaoshou.com/blog/article_647.html 、 https://www.chwang.com/guide/187103118002

### 4.2 结论：**有条件通过**

- 理由：FBO/FBS/FBP 三模式均可用，跨境直发路径存在；但 FBO 入仓的头程、补货周期、仓储费/退货逆向的**精确报价**尚未取得，禁限运品清单未锁定。
- 硬成本项：FBO 需承担俄罗斯境内头程 + 入仓 + 仓储 + 退货逆向；FBP 直发需承担跨境小包时效与末端妥投风险。二者必须取得**标准测试包裹（轻小件/普通件/体积件）报价**后才能算经济性。

---

## 5. 产品与营销合规 — **有条件通过**

### 5.1 事实（Facts）

1. **EAC/CUTR 认证按「技术法规清单」强制适用。** 主要 TR CU 法规：
   - TR CU 007/2011 儿童及青少年用品（童装、童鞋、儿童用品）→ 强制。[A/B] https://www.tuv.com/market-access-services/en/certification-filter/customs-union-(cu)-technical-regulation-tr-cu-007-2011-safety-of-products-intended-for-children-and-adolescents.html
   - TR CU 017/2011 轻工业品（纺织/服装/鞋帽）→ 强制。[B] https://www.cu-tr.com.cn/page8?article_id=9332
   - TR CU 008/2011 玩具 → 强制；TR CU 004/2011（LVD，低压电器）+ 020/2011（EMC，电磁兼容）→ 电子电器强制。[B] http://www.cu-tr.org.cn/page9?article_id=10693
2. **认证分两类：CoC（合格证书，强制认证）与 DoC（符合性声明，自我声明）。** 适用何种由法规清单决定。[B] https://gost-smk.com/info-4797.html 、 http://www.sftlab.cn/article-detail/NMwzwvAb
3. **标签/说明书需俄语，带 EAC 标志（适用时）。** 俄消费者保护法规要求商品信息以俄语呈现；EAC 标志按规定施加于产品或包装。[B] https://www.easygost.com/en/glossary/packaging-marking/ 、 https://www.shwanyun.com/newsinfo/11054742.html

### 5.2 家居/百货子类的 EAC 适用性（初步判定，需逐 SKU 复核）

| 子类 | 是否强制 EAC | 依据 |
|---|---|---|
| 纯塑胶/竹木/金属家居收纳、无电厨房五金 | 大概率**不强制**（无对应 TR CU 覆盖时） | TR CU 无专门「普通家居」法规 |
| 接触食品的餐具/厨具（塑料/金属/陶瓷） | **大概率需**（食品接触材料卫生/登记，TR CU 005/2011 等） | 待补证 |
| 电子类家居（插电小家电、灯具、充电产品） | **强制**（LVD + EMC） | TR CU 004/020 |
| 纺织品（毛巾/床品/窗帘/地毯） | **强制**（TR CU 017/2011） | 官方法规 |
| 儿童用品/玩具 | **强制**（TR CU 007/008） | 官方法规 |

### 5.3 结论：**有条件通过**

- 理由：EAC/CUTR 框架清晰、官方法规清单可查；但「家居/百货」是一个跨法规的杂类目，**每一具体 SKU 必须按 HS 编码 + 材质 + 用途判定是否落入强制认证清单**，无法笼统下结论。
- 知识产权/营销侧：俄罗斯存在**平行进口（parallel import）白名单**机制（部分品牌商品可在无权利人授权下进口），但这不等于商标/外观设计侵权风险为零；平台对品牌授权与假货的审核政策需另行核验。**待补证。**

---

## 6. 基础经济性 — **有条件通过（定性）**

> 按框架要求：本阶段不填虚构精确数字，只做定性区间判断；HS 编码、申报价值、重量、售价未锁定前不得给出利润率。

### 6.1 定性成本结构（跨境直发 FBP 情景）

- 售价 100% − 平台佣金（家居/百货类常见区间约 10%–20%，官方按类目分档）[A] https://docs.ozon.ru/global/en/commissions/ozon-fees/commissions/
- − 跨境头程物流（轻小件跨境小包 vs 体积件）— 待 SKU 报价
- − 关税/VAT（≤200 欧免税口径 2026-07 前；之后 5% 关税 + 逐步 VAT 至 20%）
- − 退货逆向成本（退货率 × 单件退运/弃置损失）
- − 获客成本（平台内广告/达人内容，视品类竞争）

### 6.2 定性判断

- **存在正贡献毛利区间的概率较高**，但成立条件严格：**客单 ≥ 某个门槛（覆盖固定合规 + 头程摊销）、退货率低、非强制 EAC 认证类目、非低值免税额以下的纯低价内卷品**。
- **高退货率品类（服装鞋帽/尺码类）+ 低价白牌 + 强制 EAC 认证** 的组合，在首轮 5,000–20,000 元预算下大概率无正毛利，应回避。
- 与印尼「100 美元最低价」不同，俄罗斯**没有单价下限**，低客单法律上可行，但 2026-07 起 5% 关税 + 逐步 VAT 会进一步压缩低客单毛利。

### 6.3 结论：**有条件通过**

- 理由：平台佣金结构透明、直发/仓配双路径可调，存在正毛利区间；但**必须先锁定 1–3 个具体 SKU 的 HS 编码、认证、重量、采购价、售价、退货率**，才能从「定性存在」进入「可测的贡献毛利」。

---

## 7. 状态分布小结

| 维度 | 状态 | 一句话理由 |
|---|---|---|
| 主体与平台准入 | **初步通过** | Ozon 官方中文注册流程 + 跨境直发模式可确认中国公司开店路径 |
| 税务与关务 | **有条件通过** | 200 欧门槛/5% 关税/20% VAT 方向明确，但 2026–2029 政策变动期 + 进口商/平台代扣未闭环 |
| 收款与资金 | **有条件通过** | 结算币种官方可确认，周期/准备金/冻结需官方闭环 |
| 物流与退货 | **有条件通过** | FBO/FBS/FBP 三模式可用，费率与禁限运需 SKU/线路级报价 |
| 产品与营销合规 | **有条件通过** | EAC/CUTR 框架清晰，家居/百货需逐 SKU 判定强制认证 |
| 基础经济性 | **有条件通过** | 存在正毛利区间，但需 SKU 级数据才能从定性转入可测 |

**维度级汇总：初步通过 1 / 有条件通过 5 / 待补证 0 / 不通过 0。**
**市场级状态：有条件通过。** 与 24 市场矩阵一致——「已找到合法入口与基本税关框架，但运营链路未闭环」，不进入最终排名，也不判定不通过。

---

## 8. 待补证清单（按是否阻断进入下一轮排序）

| # | 待补证项 | 补证计划（查什么 / 哪个官方入口） | 优先级 |
|---|---|---|---|
| 1 | **平台代扣/进口商责任**：直发低值包裹由谁申报、平台是否代扣关税与 VAT；FBO 进口清关主体 | Ozon 官方卖家文档「税务/进口」章节；联系 Ozon Global 中国招商/客服索取进口责任书面说明；咨询中俄跨境物流商的 DDP 线路报关口径 | 高 |
| 2 | **结算闭环**：Ozon 结算周期（每月/双月）、最低提现门槛、准备金比例、新店风控冻结时长 | Ozon 官方「收款/结算时间表」页（docs.ozon.ru/global 的 accounting 部分）；第三方支付商（连连/PingPong）官方 Ozon 收款说明页 | 高 |
| 3 | **保证金/邀请制/主体类型**：是否收押金、是否招商邀请制、个体工商户与公司是否同等准入、品牌/商标是否必选 | Ozon Global 中文注册页与招商页逐字段截图存档；AMZ123/官方招商活动页复核 | 高 |
| 4 | **禁限运品清单**：家居/百货中哪些子类被 Ozon 禁售或限售（含食品接触、电子、电池、儿童类） | Ozon 官方「禁售商品目录 / 受限类目」页（docs.ozon.ru）逐类核对目标 SKU | 高 |
| 5 | **SKU 级 EAC 判定**：目标家居/百货 SKU 是否落入 TR CU 强制清单（食品接触、电子、纺织、儿童优先） | 按 HS 编码查 EAEU 技术法规清单；咨询 EAC 认证机构（TUV/上海经合/CERTPI）出 CoC/DoC 选型结论 | 中 |
| 6 | **FBO 报价与退货逆向**：入仓头程、仓储费/升/天、补货周期、退货仓储/退运/弃置费用 | Ozon 官方 FBO 费率页 + 中俄跨境物流商对 3 个标准测试包裹（轻小/普通/体积件）报价 | 中 |
| 7 | **2027「取消小包免税」与 2029 VAT 的官方原文** | EEC 官网决议原文、俄罗斯联邦税务局（FNS）/联邦海关局（FCS）官方公告；以官方原文替换当前媒体转述 | 中 |
| 8 | **平行进口与 IP 审核**：平行进口白名单对目标品牌的覆盖、Ozon 对品牌授权/假货的审核与处罚 | 俄罗斯工贸部（Minpromtorg）平行进口清单、Ozon 官方知识产权/品牌政策页 | 低 |

---

## 9. 官方证据索引（A/B 级为主）

### 平台官方（Ozon / EAEU）

- [Ozon Global 官方：注册激活账户（中文，Step 1）](https://docs.ozon.ru/global/zh-hans/launch/steps/step-1/)
- [Ozon Global 官方：销售佣金按类目分档](https://docs.ozon.ru/global/en/commissions/ozon-fees/commissions/)
- [Ozon Global 官方：FBP 跨境直发费率（佣金低 1%）](https://docs.ozon.ru/global/en/commissions/ozon-fees/fbp-rates/)
- [Ozon Global 官方：卖家结算货币（中文）](https://docs.ozon.ru/global/zh-hans/accounting/receiving-payments/payment-currency/)
- [Ozon 官方：国外卖家协议更改列表（中文）](https://docs.ozon.by/global/zh-hans/contracts-for-sellers/spisok-izmenenii-v-dogovore/)
- [Ozon 官方镜像：注册激活（中文）](https://docs.ozon.kz/global/zh/launch/steps/step-1/)

### 税关与监管

- [EEC：维持 200 欧元免税门槛（Interfax 转述）](https://www.interfax.com/newsroom/top-stories/109960/)
- [俄罗斯同意 5% 关税 + 维持 200 欧元门槛（Interfax，2025-09-09）](https://interfax.com/newsroom/top-stories/113736/)
- [EEC 批准 200 欧元门槛 + 5% 关税，自 2026-07-01（Interfax，2026-01-12）](https://interfax.com/newsroom/top-stories/115527/)
- [国家杜马委员会支持对平台进口商品征 VAT（Interfax，2026-02-16）](https://interfax.com/newsroom/top-stories/116189/)
- [俄财政部提议 2029 年实现跨境电商全额 VAT（Interfax，2026-03-06）](https://interfax.com/newsroom/top-stories/116512/)
- [中国海关总署哈尔滨海关：EAEU 200 欧元免税进口门槛](http://gdfs.customs.gov.cn/harbin_customs/zw18/xwdt87/zoyhgdt/6806830/index.html)

### 认证合规（EAC/CUTR）

- [TUV：TR CU 007/2011 儿童用品强制认证](https://www.tuv.com/market-access-services/en/certification-filter/customs-union-(cu)-technical-regulation-tr-cu-007-2011-safety-of-products-intended-for-children-and-adolescents.html)
- [上海经合工业：TR CU 007/2011 及 EAC 认证要点](https://www.cu-tr.com.cn/page8?article_id=9332)
- [CERTPI：海关联盟 EAC/CU-TR 中国企业必读指南](https://www.certpi.com/1155.html)
- [EasyGOST：包装/标签强制信息与 EAC 标记](https://www.easygost.com/en/glossary/packaging-marking/)

### 资金与物流（服务商/媒体，D 级，仅作风险提示）

- [连连支付：Ozon 提款要求说明](https://global.lianlianpay.com/article/MTQ0MTQxLDQ0ZA.html)
- [Deliver2：Ozon/WB 对卖家设置 30 天付款限制](https://deliver-2.com/news/marketplaces/wb-and-ozon-have-limited-payments-to-sellers-for-a-period-of-30-days/)
- [凤凰网：Ozon FBO 大件免费仓储期 90 天→30 天、费率下调](https://i.ifeng.com/c/8iWpc3QIKkv)

---

## 10. 事实 / 推断 / 决策分离备注

- **事实**：上列 1–5 节「事实」条目，均标注来源与日期。
- **推断**：各节「推断」条目已标置信度；FBO 仓储费、结算周期、退货归属等第三方数字均标 D，不单独用于决策。
- **决策**：本文件不产生「是否进入」的最终决策；俄罗斯/Ozon 当前为**有条件通过**，须待 §8 高优先级补证项关闭后，才能进入市场机会评分与短名单比较。
