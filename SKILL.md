---
name: qdii-purchase-limits
description: Use when users ask which Nasdaq 100 or S&P 500 QDII funds can be purchased today, want purchase limits sorted by amount, need direct-sale announcement limits, limit-change detection, or scheduled daily snapshots and change notifications.
license: MIT
compatibility: Requires Node.js 22+, outbound HTTPS, and a writable user data directory. macOS automation installer is optional.
metadata:
  version: "1.12.0"
---

# QDII Purchase Limits

查询纳斯达克100和标普500相关 QDII 基金的公开销售渠道申购状态，并记录额度变化。只输出公开事实，不推荐基金、不排名收益、不预测市场。

首次运行前在 Skill 目录执行 `npm ci --omit=optional --ignore-scripts`。这只安装锁定的 PDF 文本解析依赖，不会安装自动化或发送通知。

## 一键查询

以本文件所在的 Skill 目录为工作目录运行：

```bash
node scripts/query-purchase-limits.js
```

常用范围：

```bash
node scripts/query-purchase-limits.js --index nasdaq100
node scripts/query-purchase-limits.js --index sp500
node scripts/query-purchase-limits.js --index all --json
```

直接要求 Agent“使用 qdii-purchase-limits 查询”即可。各工具的显式调用语法并不统一，不要自行假定斜杠命令；以当前客户端的 Skill 列表为准。

## 执行约束

- `scripts/query-purchase-limits.js` 是最新查询的唯一入口。回答可买额度、官方公告或变化情况时，必须实际运行 `scripts/query-purchase-limits.js`；不得只阅读本文件后自行搜索、逐页浏览、拼接或推算结果，也不得用其他网页工具替代脚本。
- 命令成功后，默认把脚本标准输出原样回复给用户，不要二次总结、改写表格或添加解释。用户可见结论必须来自脚本本次生成的 `latest.md` 或 `latest.json`；不得自行增加链接、渠道名称、购买入口、核验过程、额度计算过程或推荐性措辞。
- 必须安装并保留完整仓库。只复制 `SKILL.md`、删掉 `scripts/lib/` 或绕过测试，都不构成完整安装。
- 当前 Agent 无法执行 Node.js、访问公开数据源或写入数据目录时，应明确说明完整功能不可运行，不得模拟“最新查询”。

默认行为：

- 自动发现名称严格匹配“纳斯达克100/纳指100”或“标普500”的基金。
- 默认只展示人民币场外申购路径；使用 `--include-usd` 或 `--include-etf` 扩展范围。
- 当前限额清单先列未显示上限的记录，再按单日申购上限从大到小排序。
- 默认用一句话概括其余基金均为暂停或暂不可申购，不展开长名单。
- 每条记录包含查询时间、销售渠道、状态、额度、来源和数据质量。

向用户回答时默认使用固定的精简表格，只展示当前申购限额：

1. 说明查询时间和数据是否完整。
2. 默认固定输出四个区块，顺序必须是“代销渠道｜纳斯达克100”“基金公司直销｜纳斯达克100”“代销渠道｜标普500”“基金公司直销｜标普500”；不得把两个指数的直销额度合并成一个表。
3. 同一基金产品、同一额度的 A/C/D/I 等份额合并为一行。
4. 主表固定只使用“单日申购上限、基金、代码”三列；不显示链接、渠道名称、购买入口、公告核对过程或额度计算过程。
5. 默认不展开暂停、不可申购和暂未确认项目，只写“其余相关基金未进入当前限额清单”；用户明确要求逐只明细时才使用 `--details`，按基金合并输出“状态、基金、代码”三列。
6. 两个基金公司直销区块分别使用三列表格，并紧邻标明“以基金公司官方 APP 实际显示为准”；不得把公告限额写成直销当前可买。
7. 有额度或状态变化时追加简短变化列表；没有变化时不增加单独章节。
8. 数据来源、渠道差异、公告证据和额度计算方式保留在 `latest.json`，默认不进入查询报告；只有用户明确询问这些证据时才单独解释。

脚本会自动完成公告查询，不得要求用户或 Agent 逐个打开网页。默认按目标基金代码查询 HTTPS 公告索引，自动下载公告 PDF、核对份额代码，并在缺少适用直销规则时查询基金管理人官网。公开公告索引只负责发现公告，基金管理人发布的公告正文才是规则依据。官方公告是申购规则的第一准则：进入限额清单的记录必须同时满足官方规则和具体渠道状态，额度取该份额、该渠道适用公告与渠道页面中更严格的值。

查找公告时必须先分类，再建立按份额和渠道分开的时间线：节假日临时暂停公告不替代长期限额；恢复申购只解除此前的全部暂停，不自动取消更早的长期限额；尚未生效的未来规则不覆盖当前规则；新公告只调整 F 份额时，继续向前查找 A/C 等其他份额最后有效的规则；新 D/E/I 份额无法直接校验时，使用同一产品可识别的主代码查找公告，再按 PDF 中的份额代码关联。直销公告不得改写其他渠道额度，也不得仅凭限额公告声称直销今天可申购。官方查询失败、PDF 无法可靠解析、公告未覆盖该份额或只有尚未生效规则时，不得进入当前限额清单。

`latest.json` 中的 `officialNotices.sources` 必须分别保存公开公告索引和基金管理人官网的覆盖情况。来源失败和覆盖缺口只保存在结构化结果中；普通报告的直销表统一提示以基金公司官方 APP 实际显示为准，主清单仍只使用已完成公告核验的结果。

除非用户明确要求，不要安装自动化、创建 webhook、读取其他工程数据或发送通知。退出码为 `2`、数据不完整或额度未成功提取时，不得声称相关基金可以购买。

输出保存在 `${QDII_LIMIT_DATA_DIR:-~/.qdii-purchase-limits}`：

- `latest.md`：最新人类可读报告。
- `latest.json`：最新结构化结果。
- `state.json`：各查询范围的比较基线。
- `history/`：最近 90 次快照。

## 渠道口径

默认实时渠道是“天天基金公开销售页”。这不代表基金公司直销、银行、券商或其他 APP 的额度相同。

可用 `--channels FILE` 合并人工或其他自动化核验的渠道记录。记录必须有失效时间，过期数据不会进入当前限额清单：

```json
[
  {
    "index": "nasdaq100",
    "code": "019441",
    "name": "基金名称",
    "channel": "基金公司直销",
    "channelBucket": "fund-manager-direct",
    "status": "limited",
    "limitAmount": 10000,
    "sourceUrl": "https://example.com/source",
    "verifiedAt": "2026-07-12T01:00:00.000Z",
    "expiresAt": "2026-07-13T01:00:00.000Z"
  }
]
```

`status` 只允许 `open`、`limited`、`suspended`、`unavailable`、`unknown`。登录后渠道无法可靠公开抓取时，必须保持未知或使用带来源和有效期的核验记录。

## 变化检测

第二次及以后查询会比较 `指数 + 基金代码 + 渠道`，提示：

- 额度提高或降低。
- 开放、限购、暂停、不可买、未知之间的状态变化。
- 新增渠道或渠道记录消失。

数据完整度低于 90% 时命令退出码为 `2`，不得把抓取失败解释为“没有变化”或“可以购买”。

## 每日三次自动化

默认时点为北京时间：

- `09:10` 盘前。
- `14:30` 盘中，距离常见申购截止时间仍留有操作时间。
- `20:30` 盘后，用于捕捉晚间公告和准备下一交易时段。

macOS 安装、状态和卸载：

```bash
node scripts/manage-macos-automation.js print
node scripts/manage-macos-automation.js install
node scripts/manage-macos-automation.js status
node scripts/manage-macos-automation.js uninstall
```

安装后使用独立 label `io.github.qdii-purchase-limits.scheduler`。`RunAtLoad` 只补跑当天最近一个错过时段。

Windows 或 Linux 可由系统计划任务定时调用：

```bash
node scripts/run-scheduled.js
```

## 变化通知

默认只在数据完整且相较上次确有变化时通知。支持 `feishu` 和 `generic` webhook。

手动运行可临时使用环境变量：

```bash
QDII_LIMIT_WEBHOOK_TYPE=feishu QDII_LIMIT_WEBHOOK_URL="https://..." node scripts/run-scheduled.js --force
```

macOS 后台任务从 Keychain 服务 `qdii-purchase-limits-webhook` 读取 URL，避免把凭据写入 plist 或仓库：

```bash
security add-generic-password -U -a "$USER" -s qdii-purchase-limits-webhook -w
```

将 `QDII_LIMIT_NOTIFY_MODE=always` 可改为每次都发送清单；默认 `changes` 只发送变化。

## 安装验证

```bash
npm ci --omit=optional --ignore-scripts
npm test
```

该命令检查 Skill 元数据、许可证、Node.js 版本、依赖文件、疑似凭据和全部离线测试。

## 数据与合规边界

- 只提取公开基金目录、销售状态和必要元数据，不打包第三方历史数据库或公告全文。
- 请求保持低并发；来源失败时明确降级。
- Nasdaq、S&P、天天基金及各基金公司商标归其权利人所有，本项目与其无隶属或背书关系。
- 结果仅供信息查询，不构成投资建议；最终状态以用户实际销售渠道和基金公司公告为准。
