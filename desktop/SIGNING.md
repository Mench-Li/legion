# 安装包签名（Authenticode）

本文回答：**怎么让 Windows 不把 Legion 的安装包拦下来**，以及那份证书从哪来。

现状：`desktop/scripts/build.mjs` 里写着 `signAndEditExecutable: true`，
但那只是允许 electron-builder 去改 exe 的签名区——**没有凭据时它什么也不签**。
当前产物叫 `Legion-0.1.0-internal-x64-setup.exe`，那个 `-internal-` 就是
**未签名**的标记（名字里的 `-internal-` 来自 `artifactName`，是刻意留的）。

---

## 一、不签名会怎样

用户从你的 Hub 下载安装包、双击，Windows 会拦：

```text
Windows 已保护你的电脑
  发布者：未知发布者
  [不运行]  [更多信息 → 仍要运行]
```

而且这个提示**不会**因为用户装过一次就消失。对一个"给到用户下载"的产品，
这一步的流失率比任何功能缺陷都高——用户会把"未知发布者"读成"这东西来路不明"。

> 一个能被点开但被系统警告的安装包，
> 与一个装不上的安装包，在用户那边的区别只是"多试了一次"。

签名还带来另外两件事：

- **完整性**：签名覆盖二进制，下载途中被换掉会在安装时被拒。
- **自动更新**：本项目的更新链路（见 [桌面自动更新设计](../docs/superpowers/specs/2026-10-02-legion-desktop-auto-update-design.md)）
  把 Authenticode 列为发布者身份那一层——HTTPS 保护传输、清单签名防伪造、
  **包摘要防篡改**、Authenticode **证明发布者是谁**。四层各管一段。

---

## 二、★ 先知道这条：2023-06 之后拿不到 .pfx 了

CA/Browser Forum 的代码签名基线要求自 **2023-06-01** 起规定：
**所有**公开信任的代码签名证书（OV 和 EV 都一样）的私钥必须存放在
**FIPS 140-2 Level 2 / Common Criteria EAL4+** 的硬件里——U 盾或云 HSM。

后果对你的构建流程是直接的：

| 拿到的东西 | 构建机怎么用 |
| --- | --- |
| U 盾（USB token） | **插在那台机器上**才能签。CI 里基本没法用（除非有 USB 直通） |
| 云 HSM（KeyLocker / eSigner 之类） | 通过厂商客户端/API 签，CI 可用 |
| 自签证书 | 随便用，但**只有你自己装的机器信它**，对外等于没签 |

> 网上那些"买个 .pfx 丢进 CI"的教程，2023-06 之后**全都过时了**。
> 照着做的结果是卡在"证书导不出私钥"那一步，而报错不会告诉你为什么。

---

## 三、四条路，按"省事"排序

价格与可用性**经常变**，下面是量级，具体以各家的当前页面为准。

### ① Azure Trusted Signing（**个人开发者首选**）

微软自家的托管签名服务。云 HSM，不用 U 盾，electron-builder 26 **原生支持**。

- 量级：~$10/月起（按签名次数分档）。
- 需要：Azure 订阅 + **身份验证**（个人或组织）。
- 优点：最便宜、CI 友好、不用管硬件。
- 代价：身份验证要走一遍流程（数天到两周），且**个人开发者的可验证条件较严**
  （通常要能证明身份与一定的历史记录）。

electron-builder 26 里的写法（`desktop/scripts/build.mjs` 的 `win` 段）：

```js
win: {
  // …其余不变
  azureSignOptions: {
    publisherName: '<证书里的发布者名，必须逐字一致>',
    endpoint: 'https://<region>.codesigning.azure.net',
    codeSigningAccountName: '<你的签名账户名>',
    certificateProfileName: '<证书配置文件>',
    fileDigest: 'SHA256',
    timestampRfc3161: 'http://timestamp.acs.microsoft.com',
  },
},
```

凭据走 Azure 的标准环境变量（`AZURE_TENANT_ID` / `AZURE_CLIENT_ID` /
`AZURE_CLIENT_SECRET`，或 `az login` 的登录态）。

### ② OV 证书（传统 CA）

DigiCert / Sectigo / GlobalSign / SSL.com 等。

- 量级：~$200–400/年。
- 需要：**组织**验证（营业执照等），部分 CA 提供个人验证。
- 交付形态：U 盾，或各家的云 HSM（DigiCert KeyLocker、SSL.com eSigner）。
- **SmartScreen 不是立刻就好**：OV 需要靠下载量**攒信誉**，
  新证书刚上的那段时间仍会弹警告（时间通常按周计）。

### ③ EV 证书

- 量级：~$400–700/年，验证更严。
- **唯一能立刻拿到 SmartScreen 信誉的**。如果你要"发出去就不弹警告"，只有这条。

### ④ 开源免费通道（值得先查一下）

| 服务 | 条件 |
| --- | --- |
| **SignPath.io** | 对开源项目免费，有 CI 集成 |
| **Certum Open Source Code Signing** | 便宜（量级 €100+/年），要求项目开源并公开源码 |

Legion 如果是公开仓库，这两条值得先问——能省掉第二、三节的全部麻烦。

### 自签证书（仅内部）

`desktop/` 里没有任何自签逻辑，也不建议加：自签对**用户**没有任何价值
（他们的机器不信任你的根），只适合内部测试机预装根证书的场景。

---

## 四、拿到之后怎么接进构建

### 4.1 走 `CSC_LINK`（U 盾以外的托管证书 / 云 HSM 导出的签名服务）

electron-builder 认这两个环境变量（Windows 上还认 `WIN_CSC_LINK` 覆盖）：

```bash
export CSC_LINK='<base64 的 pfx，或一个 https/文件路径>'   # 也支持 file:// 与 base64:
export CSC_KEY_PASSWORD='<pfx 口令>'
npm run dist
```

再补两个开关避免本地/CI 的意外：

```bash
export CSC_IDENTITY_AUTO_DISCOVERY=false   # 别去翻构建机的证书store
export CSC_FOR_PULL_REQUEST=true           # 若在 CI 里对 PR 也签
```

**不要把 `CSC_KEY_PASSWORD` 写进仓库或 `desktop/package.json`。**
走 CI secret。

### 4.2 走 Azure

见第三节 ①。用 `azureSignOptions` 时**不要**同时设 `CSC_LINK`——
两套凭据同时在场的行为没有明确约定，而"用哪一套"出问题时很难查。

### 4.3 产物名要跟着改

`build.mjs` 现在的 `artifactName` 里带着 `-internal-`：

```js
artifactName: 'Legion-${version}-internal-${arch}-setup.${ext}',
```

那是**未签名内部构建**的标记，也是发布目录里那份文件的来源。
做签名发布版时应当改掉（例如去掉 `-internal-`），并让发布流程产出
设计文档 §4 约定的两个产物：

```text
releases/<releaseId>/Legion-Setup-win-x64.exe      ← 首次安装 / 人工修复（已签名）
releases/<releaseId>/legion-win-x64.zip            ← 已安装客户端升级（已签名）
```

> 名字里的 `-internal-` 是一个**给未来的自己**写的信号：
> 看到它就说明这一份没签名。签了名还留着它，会让"这份能不能发出去"
> 重新变成一个要打开属性面板才知道的问题。

---

## 五、签完怎么验（不要靠"应该签上了"）

```bash
# ① 有没有签名、发布者是谁、时间戳在不在
#   （下面的文件名按你当前产物的实际名字替换；现在它是带 -internal- 的那个）
powershell -Command "Get-AuthenticodeSignature 'dist\Legion-0.1.0-internal-x64-setup.exe' | Format-List Status,SignerCertificate,TimeStamperCertificate"
#   期望 Status = Valid；SignerCertificate 的 Subject 里有你的名字；
#   TimeStamperCertificate 非空（没有时间戳的签名会在证书过期后失效）
```

```bash
# ② 签名覆盖到的到底是哪几个文件（在 desktop/ 目录下跑）
#   electron-builder 会签 Legion.exe、安装器、卸载器；漏掉卸载器会让
#   "卸载时"再弹一次未知发布者。
powershell -Command "Get-ChildItem 'dist\win-unpacked','dist' -Filter *.exe -Recurse | ForEach-Object { \$s = Get-AuthenticodeSignature \$_.FullName; '{0,-12} {1}' -f \$s.Status, \$_.Name }"
```

```bash
# ③ 真机装一次
#   在一台**没装过 Legion** 的 Windows 上双击安装包：
#   应当没有「Windows 已保护你的电脑」，安装过程中发布者显示你的名字。
#   这一条是唯一能证明 SmartScreen 真的放行的证据——前两条只证明"签了"。
```

**没有时间戳的签名**会在证书到期那天**追溯失效**：已经发出去的安装包
会突然变成"签名无效"。所以 `timestampRfc3161` 不是可选项。

---

## 六、与发布流程的关系

签名是**发布流程**的一环，而发布流程本身（按设计文档 §5）还没实现——
它要做的是把已签名的产物摆成 `releases/<releaseId>/`，再签一份
**Ed25519 信封**的通道清单，让客户端能验证"这份清单确实是我发的"。

两者的信任根**不是一回事**，不能互相替代：

| | 证明什么 | 谁验 |
| --- | --- | --- |
| Authenticode | 这个 exe 是谁发布的 | **Windows** |
| Ed25519 清单签名 | 这份更新清单是谁发的 | **Legion 客户端** |

所以签了 Authenticode **不等于**发布流程可以不做——后者防的是
"托管被改写时客户端信任伪造清单"，前者管不到那一层。

---

## 七、一句话总结

- **个人开发者**：先查 SignPath / Certum 的开源通道；不行就上 **Azure Trusted Signing**。
- **要"发出去立刻不弹警告"**：只有 **EV**。
- **任何情况下**：U 盾不能进 CI；云 HSM 或 Azure 才行；别去导 .pfx，导不出来。
- 签完**必须**在干净机器上真装一次——那是唯一能证明 SmartScreen 放行的证据。
