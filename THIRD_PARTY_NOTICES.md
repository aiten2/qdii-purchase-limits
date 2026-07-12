# 第三方说明

## 运行时数据来源

本项目直接访问以下公开网页，提取基金名称、代码、申购状态、公开额度、查询时间和来源链接等必要信息：

| 来源 | 用途 | 说明 |
| --- | --- | --- |
| [天天基金基金目录](https://fund.eastmoney.com/js/fundcode_search.js) | 发现相关基金 | 东方财富旗下公开页面 |
| [天天基金基金页](https://fund.eastmoney.com/) | 查询所标注渠道的申购状态和额度 | 对应公开页面链接保存在结构化结果中 |
| [东方财富基金公告索引](https://fundf10.eastmoney.com/) | 按基金代码自动发现申购、暂停和直销相关公告 | 仅把公告标题、日期和公告 ID 用作检索索引；公告规则以 PDF 正文为准 |
| [东方财富公告 PDF 镜像](https://pdf.dfcfw.com/) | 获取公告索引对应的基金管理人公告 PDF | 只解析目标基金的份额、渠道、额度与生效日期，不保存或再分发公告全文 |
| [中国证监会资本市场统一信息披露平台](http://eid.csrc.gov.cn/fund) | 查询基金管理人报送的最近相关申购公告 | 解析 PDF 中必要的日期、份额、额度与渠道口径；不保存或再分发公告全文 |
| [华夏基金](https://fund.chinaamc.com/) | 补充查询只在基金管理人官网发布的直销电子交易平台公告 | 仅解析与目标基金申购状态、额度和生效日期有关的公开页面及 PDF |
| 用户提供的渠道记录 | 合并基金公司直销、银行或券商等其他渠道 | 需包含来源、核验时间和失效时间 |

上述访问应遵守[东方财富用户服务协议](https://about.eastmoney.com/home/protocol)、来源网站的访问规则和适用法律。标注来源不代表取得复制、再分发或商业使用授权。

本仓库不附带第三方历史数据库、公告全文或网页镜像。

## 软件与平台

| 项目 | 用途 | 许可证或说明 |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | 运行脚本 | 运行时依赖 |
| [Mozilla PDF.js / pdfjs-dist 4.8.69](https://github.com/mozilla/pdf.js) | 从官方公告 PDF 提取文本 | Apache-2.0；固定版本安装，省略可选图形渲染依赖 |
| [actions/checkout](https://github.com/actions/checkout) | GitHub Actions 检出仓库 | MIT；仅用于 CI |
| [actions/setup-node](https://github.com/actions/setup-node) | GitHub Actions 配置 Node.js | MIT；仅用于 CI |
| [Agent Skills](https://agentskills.io/) | Skill 目录与 `SKILL.md` 约定 | 开放格式 |
| 飞书群机器人或通用 webhook | 可选变化通知 | 不使用或打包第三方 SDK |
| macOS launchd 与 Keychain | 可选本机定时任务和凭据存储 | 操作系统能力 |

## 名称和商标

- Nasdaq、Nasdaq-100 及相关名称和商标归其权利人所有。
- S&P、S&P 500 及相关名称和商标归其权利人所有。
- 天天基金、东方财富及相关名称和商标归其权利人所有。
- 飞书及相关名称和商标归其权利人所有。
- 各基金名称和商标归对应基金管理人或其他权利人所有。

这些名称仅用于识别查询对象、数据来源或可选接口。本项目与上述机构不存在隶属、合作、授权或背书关系。最终申购状态和额度以基金公司公告及用户实际销售渠道为准。
