# QDII 指数基金申购限额查询

一个用于查询纳斯达克100、标普500相关 QDII 基金申购状态的 Agent Skill。

它可以查询当前申购限额、整理基金公司直销公告限额、记录额度变化，并可选启用每日自动查询和变化通知。项目只提供公开信息查询，不提供基金推荐、收益排名、交易信号或投资建议。

## 支持的 Agent

| Agent / 工具 | 安装位置或方式 | 调用方式 |
| --- | --- | --- |
| [Codex](https://developers.openai.com/codex/skills) | `~/.codex/skills/` | 明确指定 `qdii-purchase-limits` |
| [Claude Code](https://code.claude.com/docs/en/skills) | `~/.claude/skills/` | `/qdii-purchase-limits` |
| [GitHub Copilot](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills) | `~/.copilot/skills/` | `/qdii-purchase-limits` |
| [Gemini CLI](https://geminicli.com/docs/cli/skills/) | `gemini skills install <仓库地址>` | 明确指定 `qdii-purchase-limits` |
| [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/) | `~/.qwen/skills/` | `/qdii-purchase-limits` |
| [TRAE / TRAE CN（条件支持）](https://forum.trae.cn/t/topic/19344) | `.agents/skills/` | 以当前客户端提示为准 |
| [Kimi Code CLI](https://www.kimi.com/code/docs/kimi-code-cli/customization/skills.html) | `~/.kimi-code/skills/` | `/skill:qdii-purchase-limits` |
| [CodeBuddy Code](https://www.codebuddy.cn/docs/cli/skills) | `~/.codebuddy/skills/` | 明确指定 `qdii-purchase-limits` |
| [腾讯 WorkBuddy（条件支持）](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market) | 在技能页面导入完整 Skill 包 | 需允许脚本和网络访问 |
| [Qoder IDE / CLI](https://docs.qoder.com/zh/extensions/skills) | `~/.qoder/skills/` | `/qdii-purchase-limits` |
| [华为云码道 CodeArts Doer](https://support.huaweicloud.com/usermanual-cli/codeartsagent_cli_0019.html) | `~/.codeartsdoer/skills/` | 明确指定 `qdii-purchase-limits` |

完整功能需要 Agent 能够读取本地 Skill、执行 Node.js 命令并访问公开网络。TRAE 不同版本的 Skill 目录可能不同，请以当前客户端提示为准。

## 功能

- 查询纳斯达克100和标普500相关人民币场外基金。
- 按单日申购上限从高到低输出基金和份额代码。
- 单独列出基金公司直销公告限额。
- 比较上次查询，提示额度或状态变化。
- 支持 macOS 每日三次自动查询和开机补跑。
- 支持飞书群机器人和通用 JSON webhook。

## 复制给 AI 安装

将下面这段话发送给支持 Agent Skills 和本地命令执行的 AI：

> 请从 https://github.com/aiten2/qdii-purchase-limits 安装 `qdii-purchase-limits` Skill。请使用你当前 Agent 的官方 Skill 目录并克隆完整仓库，确认 `SKILL.md` 和 `scripts/query-purchase-limits.js` 均存在，在 Skill 目录运行 `npm ci --omit=optional --ignore-scripts` 和 `npm test`，然后告诉我安装位置和验证结果。不要启用定时任务或配置通知。

### 手动安装

除 Gemini CLI 外，在上表对应的 Skill 目录执行：

```bash
git clone https://github.com/aiten2/qdii-purchase-limits.git \
  <你的 Agent Skill 目录>/qdii-purchase-limits
```

安装依赖并验证：

```bash
cd <Skill 安装目录>/qdii-purchase-limits
npm ci --omit=optional --ignore-scripts
npm test
```

## 查询

在 Skill 目录运行：

```bash
node scripts/query-purchase-limits.js
```

常用参数：

```bash
# 只查纳斯达克100
node scripts/query-purchase-limits.js --index nasdaq100

# 只查标普500
node scripts/query-purchase-limits.js --index sp500

# 查看暂停、不可申购和未知项目
node scripts/query-purchase-limits.js --details

# 输出 JSON
node scripts/query-purchase-limits.js --json

# 跳过公告缓存并重新查询
node scripts/query-purchase-limits.js --force
```

也可以直接对 Agent 说：

> 使用 `qdii-purchase-limits` 查询今天的纳斯达克100和标普500基金申购限额，只运行 Skill 自带脚本并原样返回结果。

## 输出

默认报告包含：

- 查询时间和数据完整度。
- 纳斯达克100申购限额表。
- 标普500申购限额表。
- 基金公司直销公告限额表。
- 相比上次查询发生的额度或状态变化。

主表固定为三列：

| 单日申购上限 | 基金 | 代码 |
| :---: | --- | :---: |
| 100元 | 示例基金 | 000001、000002 |

同一基金、同一限额的多个份额会合并显示。未列入主表的相关基金默认用一句话概括；使用 `--details` 可以查看逐只状态。

直销表来自基金公告中的适用限额，并以“基金公司官方 APP 实际显示为准”作为提示。公告限额不等同于当天一定能够提交申购。

## 查询范围

默认范围：

- 人民币份额。
- 场外申购。
- 名称匹配纳斯达克100、纳指100或标普500的基金。

可使用 `--include-usd` 加入美元份额，使用 `--include-etf` 加入场内 ETF。场内 ETF 会标明交易所路径。

## 数据来源

- 基金目录和默认销售状态：天天基金公开页面。
- 基金公告：中国证监会资本市场统一信息披露平台、东方财富基金公告索引及公告 PDF。
- 基金管理人官网：在其他公开来源缺少适用直销规则时补充查询。

默认销售页和基金公司直销属于不同申购路径，销售限制可能不同。详细来源、第三方名称和使用边界见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 变化记录

查询结果默认保存在：

```text
~/.qdii-purchase-limits/
```

| 文件 | 内容 |
| --- | --- |
| `latest.md` | 最新报告 |
| `latest.json` | 最新结构化结果 |
| `state.json` | 变化比较基线 |
| `history/` | 最近 90 次查询快照 |

第一次查询建立基线。从第二次开始，系统会提示额度提高、额度降低、状态变化以及记录新增或消失。数据不完整时不会覆盖上次有效基线。

## 每日自动查询

默认时点为北京时间：

| 时段 | 时间 |
| --- | --- |
| 盘前 | 09:10 |
| 盘中 | 14:30 |
| 盘后 | 20:30 |

macOS 管理命令：

```bash
node scripts/manage-macos-automation.js print
node scripts/manage-macos-automation.js install
node scripts/manage-macos-automation.js status
node scripts/manage-macos-automation.js uninstall
```

自动化默认关闭。安装后使用独立的 `io.github.qdii-purchase-limits.scheduler`，并在开机时补跑当天最近一个错过的时段。

Windows 和 Linux 可以通过系统计划任务运行：

```bash
node scripts/run-scheduled.js
```

## 变化通知

支持飞书群机器人和通用 JSON webhook。默认只在数据完整且发生变化时发送。

手动运行：

```bash
QDII_LIMIT_WEBHOOK_TYPE=feishu \
QDII_LIMIT_WEBHOOK_URL="https://..." \
node scripts/run-scheduled.js --force
```

macOS 后台任务可以从 Keychain 读取 webhook：

```bash
security add-generic-password -U \
  -a "$USER" \
  -s qdii-purchase-limits-webhook \
  -w
```

webhook 地址不应写入仓库、Skill 文件或 LaunchAgent plist。

## 环境与隐私

- Node.js 18 或更高版本。
- 可访问公开基金网页的网络环境。
- 可写的本地数据目录。
- 实时查询不需要 API key、登录账号或第三方数据库 token。
- 通知功能只有在主动启用时才需要用户自己的 webhook。

## 合规说明

- 项目只查询公开页面中的必要状态信息，不附带第三方历史数据库或公告全文。
- Nasdaq、S&P、天天基金及各基金公司的名称和商标归其权利人所有。
- 项目与上述机构不存在隶属、合作或背书关系。
- 查询结果仅用于信息整理，不构成投资建议。
- 最终申购状态和额度以实际销售渠道及基金公司公告为准。

## 许可证

代码使用 [MIT License](LICENSE)。

参与贡献请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。
