#!/usr/bin/env node
const os = require("node:os");
const path = require("node:path");
const { renderMarkdown } = require("./lib/report");
const { runQuery } = require("./lib/query");

const HELP = `QDII 指数基金申购限额查询

用法：
  node scripts/query-purchase-limits.js [选项]

选项：
  --index all|nasdaq100|sp500  查询范围，默认 all
  --include-usd                 包含美元份额
  --include-etf                 包含场内 ETF（单独标注交易路径）
  --channels FILE               合并未过期的人工核验渠道 JSON
  --output-dir DIR              输出目录
  --concurrency N               并发数，默认 2
  --min-coverage N              最低完整率，默认 0.9
  --history-limit N             保留历史快照数，默认 90
  --details                     输出暂停、不可买和未知项目的完整明细
  --force                       跳过官方公告缓存并重新查询
  --json                        终端输出 JSON
  --no-save                     不保存快照与报告
  --help                        显示帮助

默认输出目录：~/.qdii-purchase-limits
`;

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少参数`);
  return value;
}

function parseArgs(argv) {
  const args = {
    index: "all",
    includeUsd: false,
    includeEtf: false,
    outputDir: process.env.QDII_LIMIT_DATA_DIR || path.join(os.homedir(), ".qdii-purchase-limits"),
    concurrency: 2,
    minCoverage: 0.9,
    historyLimit: 90,
    details: false,
    force: false,
    officialNotices: true,
    json: false,
    save: true,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--index") args.index = requiredValue(argv, index++, item);
    else if (item === "--include-usd") args.includeUsd = true;
    else if (item === "--include-etf") args.includeEtf = true;
    else if (item === "--channels") args.channelsFile = path.resolve(requiredValue(argv, index++, item));
    else if (item === "--output-dir") args.outputDir = path.resolve(requiredValue(argv, index++, item));
    else if (item === "--concurrency") args.concurrency = Number(requiredValue(argv, index++, item));
    else if (item === "--min-coverage") args.minCoverage = Number(requiredValue(argv, index++, item));
    else if (item === "--history-limit") args.historyLimit = Number(requiredValue(argv, index++, item));
    else if (item === "--details") args.details = true;
    else if (item === "--force") args.force = true;
    else if (item === "--json") args.json = true;
    else if (item === "--no-save") args.save = false;
    else if (item === "--help" || item === "-h") args.help = true;
    else throw new Error(`未知参数：${item}`);
  }
  if (!["all", "nasdaq100", "sp500"].includes(args.index)) throw new Error("--index 只支持 all、nasdaq100 或 sp500");
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 12) throw new Error("--concurrency 必须是 1-12 的整数");
  if (!(args.minCoverage > 0 && args.minCoverage <= 1)) throw new Error("--min-coverage 必须大于 0 且不超过 1");
  if (!Number.isInteger(args.historyLimit) || args.historyLimit < 1 || args.historyLimit > 1000) throw new Error("--history-limit 必须是 1-1000 的整数");
  if (args.force) args.officialNoticeCacheHours = 0;
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const payload = await runQuery(args);
  process.stdout.write(args.json ? `${JSON.stringify(payload, null, 2)}\n` : `${renderMarkdown(payload)}\n`);
  return payload.exitCode;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(`查询失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { HELP, main, parseArgs };
