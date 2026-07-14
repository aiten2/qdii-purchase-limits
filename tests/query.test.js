const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { OFFICIAL_NOTICE_CACHE_VERSION, runQuery } = require("../scripts/lib/query");
const { HELP, parseArgs } = require("../scripts/query-purchase-limits");

const catalog = "var r = " + JSON.stringify([
  ["019441", "", "万家纳斯达克100指数发起式(QDII)A", "指数型-海外股票", ""],
  ["019174", "", "摩根纳斯达克100指数(QDII)美元现汇A", "指数型-海外股票", ""],
  ["513500", "", "标普500ETF博时", "指数型-海外股票", ""],
  ["017641", "", "摩根标普500指数(QDII)人民币A", "指数型-海外股票", ""]
]) + ";";

function fixtureFetch(amount) {
  return async (url) => {
    if (url.includes("fundcode_search")) return catalog;
    if (url.includes("019441")) return `<div>交易状态：限大额（单日累计购买上限${amount}元），开放赎回</div>`;
    if (url.includes("017641")) return "<div>交易状态：开放申购，开放赎回</div>";
    throw new Error("unexpected URL " + url);
  };
}

test("parses public CLI options", () => {
  const requestedOutputDir = path.join(os.tmpdir(), "qdii");
  const args = parseArgs(["--index", "sp500", "--include-usd", "--include-etf", "--output-dir", requestedOutputDir, "--json", "--no-save"]);
  assert.equal(args.index, "sp500");
  assert.equal(args.includeUsd, true);
  assert.equal(args.includeEtf, true);
  assert.equal(args.outputDir, path.resolve(requestedOutputDir));
  assert.equal(args.json, true);
  assert.equal(args.save, false);
  assert.equal(args.officialNotices, true);
  assert.equal(args.force, false);
  assert.equal(parseArgs([]).concurrency, 4);
  assert.throws(() => parseArgs(["--no-official-notices"]), /未知参数/);
  const forced = parseArgs(["--force"]);
  assert.equal(forced.force, true);
  assert.equal(forced.officialNoticeCacheHours, 0);
});

test("CLI help describes the active official-announcement query generically", () => {
  assert.doesNotMatch(HELP, /跳过官方公告查询/);
});

test("queries both indexes while excluding USD shares and exchange ETFs by default", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-query-"));
  const payload = await runQuery({
    index: "all", includeUsd: false, includeEtf: false, outputDir,
    queriedAt: "2026-07-12T01:10:00.000Z", fetchText: fixtureFetch(100), save: true
  });
  assert.deepEqual(payload.rows.map((row) => row.code).sort(), ["017641", "019441"]);
  assert.equal(payload.health.status, "ok");
  assert.equal(payload.previousSnapshotFound, false);
  assert.ok(fs.existsSync(path.join(outputDir, "latest.md")));
  assert.ok(fs.existsSync(path.join(outputDir, "state.json")));
});

test("detects a quota change on the next query", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-change-"));
  await runQuery({ index: "nasdaq100", includeUsd: false, includeEtf: false, outputDir, queriedAt: "2026-07-12T01:10:00.000Z", fetchText: fixtureFetch(100), save: true });
  const payload = await runQuery({ index: "nasdaq100", includeUsd: false, includeEtf: false, outputDir, queriedAt: "2026-07-12T06:30:00.000Z", fetchText: fixtureFetch(10), save: true });
  assert.equal(payload.previousSnapshotFound, true);
  assert.equal(payload.changes.length, 1);
  assert.equal(payload.changes[0].type, "amount-decreased");
});

test("accepts only unexpired user-verified channel records", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-channel-"));
  const channelsFile = path.join(outputDir, "channels.json");
  fs.writeFileSync(channelsFile, JSON.stringify([
    { index: "nasdaq100", code: "019441", name: "万家纳斯达克100指数发起式(QDII)A", channel: "基金公司直销", channelBucket: "fund-manager-direct", status: "limited", limitAmount: 10000, sourceUrl: "https://example.com/current", verifiedAt: "2026-07-12T00:00:00.000Z", expiresAt: "2026-07-13T00:00:00.000Z" },
    { index: "nasdaq100", code: "019441", name: "万家纳斯达克100指数发起式(QDII)A", channel: "过期渠道", channelBucket: "sales-agency", status: "open", limitAmount: null, sourceUrl: "https://example.com/stale", verifiedAt: "2026-07-01T00:00:00.000Z", expiresAt: "2026-07-02T00:00:00.000Z" }
  ]));
  const payload = await runQuery({ index: "nasdaq100", includeUsd: false, includeEtf: false, outputDir, channelsFile, queriedAt: "2026-07-12T01:10:00.000Z", fetchText: fixtureFetch(100), save: false });
  assert.ok(payload.rows.some((row) => row.channel === "基金公司直销"));
  assert.ok(!payload.rows.some((row) => row.channel === "过期渠道"));
  assert.ok(payload.warnings.some((warning) => warning.includes("已过期")));
});

test("sanitizes custom source URLs and writes saved data with platform-appropriate permissions", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-private-output-"));
  const channelsFile = path.join(outputDir, "channels.json");
  fs.writeFileSync(channelsFile, JSON.stringify([
    { code: "019441", channel: "示例银行", channelBucket: "sales-agency", status: "limited", limitAmount: 100, sourceUrl: "https://example.com/path?token=secret&id=123#person", verifiedAt: "2026-07-12T00:00:00.000Z", expiresAt: "2026-07-13T00:00:00.000Z" },
    { code: "019441", channel: "认证链接", channelBucket: "sales-agency", status: "open", sourceUrl: "https://user:password@example.com/private", verifiedAt: "2026-07-12T00:00:00.000Z", expiresAt: "2026-07-13T00:00:00.000Z" }
  ]));
  const payload = await runQuery({ index: "nasdaq100", outputDir, channelsFile, queriedAt: "2026-07-12T01:10:00.000Z", fetchText: fixtureFetch(100), save: true });
  const custom = payload.rows.find((row) => row.channel === "示例银行");
  assert.equal(custom.sourceUrl, "https://example.com/path");
  assert.equal(payload.rows.some((row) => row.channel === "认证链接"), false);
  assert.ok(fs.existsSync(path.join(outputDir, "latest.json")));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(outputDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(outputDir, "latest.json")).mode & 0o777, 0o600);
  }
});

test("detects a direct-sale announcement amount change", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-direct-change-"));
  const noticeFetcher = (amount) => async () => ({
    byCode: { "019441": { id: String(amount), title: "直销限额", date: "2026-07-12", url: "https://example.com/direct.pdf", parsed: {
      parsed: true, effectiveDate: "2026-07-12", shareCodes: ["019441"],
      limits: [{ scope: "specific-channel", channels: ["基金公司直销"], accountBasis: "single-fund-account-daily-cumulative-per-share", effectiveDate: "2026-07-12", perShareLimits: { "019441": { amount, currency: "CNY" } } }], parseWarnings: []
    } } }, errors: []
  });
  await runQuery({ index: "nasdaq100", outputDir, queriedAt: "2026-07-12T01:10:00.000Z", fetchText: fixtureFetch(100), officialNotices: true, officialNoticeCacheHours: 0, officialNoticeFetcher: noticeFetcher(1000), save: true });
  const payload = await runQuery({ index: "nasdaq100", outputDir, queriedAt: "2026-07-12T06:30:00.000Z", fetchText: fixtureFetch(100), officialNotices: true, officialNoticeCacheHours: 0, officialNoticeFetcher: noticeFetcher(100), save: true });
  const directChange = payload.changes.find((change) => (change.after || change.before).channelBucket === "fund-manager-direct");
  assert.equal(directChange.type, "amount-decreased");
});

test("invalidates announcement caches created by an older parser version", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-old-notice-cache-"));
  fs.writeFileSync(path.join(outputDir, "official-notice-cache.json"), JSON.stringify({
    version: OFFICIAL_NOTICE_CACHE_VERSION - 1,
    byCode: {
      "019441": {
        fetchedAt: "2026-07-12T01:00:00.000Z",
        notice: { id: "stale", parsed: { parsed: true, limits: [] } }
      }
    }
  }));
  let fetchCount = 0;
  const freshNotice = {
    id: "fresh", title: "最新公告", date: "2026-07-12", url: "https://example.com/fresh.pdf",
    parsed: {
      parsed: true, effectiveDate: "2026-07-12", shareCodes: ["019441"],
      limits: [{ scope: "fund-manager-general", channels: [], accountBasis: "single-fund-account-daily-cumulative", effectiveDate: "2026-07-12", perShareLimits: { "019441": { amount: 10, currency: "CNY" } } }],
      parseWarnings: []
    }
  };
  const payload = await runQuery({
    index: "nasdaq100", outputDir, queriedAt: "2026-07-12T01:10:00.000Z",
    fetchText: fixtureFetch(10), officialNotices: true, officialNoticeCacheHours: 6,
    officialNoticeFetcher: async () => { fetchCount += 1; return { byCode: { "019441": freshNotice }, errors: [] }; },
    save: true
  });
  const cache = JSON.parse(fs.readFileSync(path.join(outputDir, "official-notice-cache.json"), "utf8"));
  assert.equal(fetchCount, 1);
  assert.equal(payload.rows[0].officialNotice.id, "fresh");
  assert.equal(cache.version, OFFICIAL_NOTICE_CACHE_VERSION);
});

test("keeps successful official notices in cache after a degraded query", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-degraded-notice-cache-"));
  const cachePath = path.join(outputDir, "official-notice-cache.json");
  const originalCache = `${JSON.stringify({
    version: OFFICIAL_NOTICE_CACHE_VERSION,
    byCode: {
      "019441": { fetchedAt: "2026-07-12T00:00:00.000Z", notice: { id: "known-good" } }
    }
  }, null, 2)}\n`;
  fs.writeFileSync(cachePath, originalCache);
  const notice = {
    id: "fresh", title: "最新公告", date: "2026-07-12", url: "https://example.com/fresh.pdf",
    parsed: {
      parsed: true, effectiveDate: "2026-07-12", shareCodes: ["019441"],
      limits: [{ scope: "fund-manager-general", channels: [], perShareLimits: { "019441": { amount: 10, currency: "CNY" } } }],
      parseWarnings: []
    }
  };
  const payload = await runQuery({
    index: "all", outputDir, queriedAt: "2026-07-12T06:30:00.000Z",
    fetchText: fixtureFetch(10), officialNotices: true, officialNoticeCacheHours: 0,
    officialNoticeFetcher: async () => ({
      byCode: { "019441": notice },
      errors: [{ code: "017641", source: "announcement-index", message: "官方公告 PDF HTTP 567" }]
    }),
    save: true
  });

  assert.equal(payload.health.status, "degraded");
  const updatedCache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(updatedCache.byCode["019441"].notice.id, "fresh");
  assert.equal(updatedCache.byCode["017641"], undefined);
  assert.equal(payload.changesEvaluated, false);
  assert.equal(payload.officialNotices.sourceFailureCount, 1);
  assert.equal(payload.officialNotices.unresolvedFundCount, 1);
  assert.equal(payload.officialNotices.errors, 1);
});

test("persists successful immutable PDF event cache entries during a degraded query", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-pdf-event-cache-"));
  const noticeId = "AN202606231823757896";
  const payload = await runQuery({
    index: "all", outputDir, queriedAt: "2026-07-12T06:30:00.000Z",
    fetchText: fixtureFetch(10), officialNotices: true, officialNoticeCacheHours: 0,
    officialNoticeFetcher: async (_funds, options) => {
      options.pdfEventCache.entries[`${options.parserVersion}:${noticeId}`] = {
        noticeId, parserVersion: options.parserVersion, url: `https://example.com/${noticeId}.pdf`, parsedAt: "2026-07-12T06:30:00.000Z",
        parsed: { parsed: true, shareCodes: ["019441"], limits: [] }
      };
      return {
        byCode: {},
        errors: [{ code: "019441", source: "announcement-index", message: "官方公告 PDF HTTP 567" }],
        diagnostics: { sourceFailureCount: 1, resolvedBySharedNoticeOrCache: 0 }
      };
    },
    save: true
  });

  const cache = JSON.parse(fs.readFileSync(path.join(outputDir, "official-pdf-event-cache.json"), "utf8"));
  assert.ok(cache.entries[`${OFFICIAL_NOTICE_CACHE_VERSION}:${noticeId}`]);
  assert.equal(payload.changesEvaluated, false);
  assert.equal(payload.officialNotices.sourceFailureCount, 1);
  assert.equal(payload.officialNotices.unresolvedFundCount, 1);
});

test("does not turn a transient fetch failure into a status change or overwrite the last valid baseline", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-transient-"));
  await runQuery({ index: "all", includeUsd: false, includeEtf: false, outputDir, queriedAt: "2026-07-12T01:10:00.000Z", fetchText: fixtureFetch(100), save: true });
  const failingFetch = async (url) => {
    if (url.includes("fundcode_search")) return catalog;
    if (url.includes("019441")) throw new Error("HTTP 514");
    if (url.includes("017641")) return "<div>交易状态：开放申购，开放赎回</div>";
    throw new Error("unexpected URL " + url);
  };
  const partial = await runQuery({ index: "all", includeUsd: false, includeEtf: false, outputDir, queriedAt: "2026-07-12T06:30:00.000Z", fetchText: failingFetch, minCoverage: 0.5, save: true });
  const failedRow = partial.rows.find((row) => row.code === "019441");
  assert.equal(partial.health.status, "partial");
  assert.equal(partial.changes.length, 0);
  assert.equal(failedRow.status, "unknown");
  assert.equal(failedRow.lastKnownStatus, "limited");
  assert.equal(failedRow.lastKnownLimitAmount, 100);

  const recovered = await runQuery({ index: "all", includeUsd: false, includeEtf: false, outputDir, queriedAt: "2026-07-12T09:30:00.000Z", fetchText: fixtureFetch(100), save: true });
  assert.equal(recovered.changes.length, 0);
});

test("does not save any comparison baseline from a degraded query", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-degraded-baseline-"));
  await runQuery({ index: "all", outputDir, queriedAt: "2026-07-12T01:10:00.000Z", fetchText: fixtureFetch(100), save: true });
  const degradedFetch = async (url) => {
    if (url.includes("fundcode_search")) return catalog;
    if (url.includes("019441")) return "<div>交易状态：限大额（单日累计购买上限10元），开放赎回</div>";
    if (url.includes("017641")) throw new Error("temporary source failure");
    throw new Error("unexpected URL " + url);
  };
  const degraded = await runQuery({ index: "all", outputDir, queriedAt: "2026-07-12T06:30:00.000Z", fetchText: degradedFetch, save: true });
  assert.equal(degraded.health.status, "degraded");
  assert.equal(degraded.changes.length, 0);
  assert.ok(degraded.warnings.some((warning) => warning.includes("不更新变化基线")));

  const recovered = await runQuery({ index: "all", outputDir, queriedAt: "2026-07-12T09:30:00.000Z", fetchText: fixtureFetch(10), save: true });
  assert.equal(recovered.changes.length, 1);
  assert.equal(recovered.changes[0].type, "amount-decreased");
});

test("does not report removals or update the baseline when the discovered catalog shrinks", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-catalog-shrink-"));
  await runQuery({ index: "all", outputDir, queriedAt: "2026-07-12T01:10:00.000Z", fetchText: fixtureFetch(100), save: true });
  const baseline = fs.readFileSync(path.join(outputDir, "state.json"), "utf8");
  const catalogOnlyOneFund = async (url) => {
    if (url.includes("fundcode_search")) return 'var r = [["000001","拼音","测试纳斯达克100(QDII)A","类型","拼音"]];';
    return '<div>交易状态 限大额 单日累计申购上限100元</div>';
  };
  const payload = await runQuery({ index: "all", outputDir, queriedAt: "2026-07-12T06:30:00.000Z", fetchText: catalogOnlyOneFund, save: true });
  assert.equal(payload.exitCode, 2);
  assert.equal(payload.health.status, "degraded");
  assert.equal(payload.changesEvaluated, false);
  assert.deepEqual(payload.changes, []);
  assert.equal(fs.readFileSync(path.join(outputDir, "state.json"), "utf8"), baseline);
});

test("records a completed time after the query started", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-completed-at-"));
  const payload = await runQuery({
    index: "nasdaq100",
    outputDir,
    queriedAt: "2026-07-12T01:10:00.000Z",
    completedAt: "2026-07-12T01:10:05.000Z",
    fetchText: fixtureFetch(100),
    save: false
  });
  assert.equal(payload.startedAt, "2026-07-12T01:10:00.000Z");
  assert.equal(payload.completedAt, "2026-07-12T01:10:05.000Z");
});

test("rejects invalid dates, unsafe links, and non-positive amounts in channel records", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-invalid-channel-"));
  const channelsFile = path.join(outputDir, "channels.json");
  fs.writeFileSync(channelsFile, JSON.stringify([
    { code: "019441", channel: "无效时间", status: "open", sourceUrl: "https://example.com", verifiedAt: "bad", expiresAt: "bad" },
    { code: "019441", channel: "危险链接", status: "open", sourceUrl: "javascript:alert(1)", verifiedAt: "2026-07-12T00:00:00.000Z", expiresAt: "2026-07-13T00:00:00.000Z" },
    { code: "019441", channel: "负额度", status: "limited", limitAmount: -1, sourceUrl: "https://example.com", verifiedAt: "2026-07-12T00:00:00.000Z", expiresAt: "2026-07-13T00:00:00.000Z" }
  ]));
  const payload = await runQuery({ index: "nasdaq100", outputDir, channelsFile, queriedAt: "2026-07-12T01:10:00.000Z", fetchText: fixtureFetch(100), save: false });
  assert.equal(payload.rows.filter((row) => ["无效时间", "危险链接", "负额度"].includes(row.channel)).length, 0);
  assert.equal(payload.warnings.length, 3);
});

test("ignores malformed non-object channel rows instead of crashing", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-malformed-channel-"));
  const channelsFile = path.join(outputDir, "channels.json");
  fs.writeFileSync(channelsFile, JSON.stringify([null, "bad-row"]));
  const payload = await runQuery({ index: "nasdaq100", outputDir, channelsFile, queriedAt: "2026-07-12T01:10:00.000Z", fetchText: fixtureFetch(100), save: false });
  assert.equal(payload.warnings.length, 2);
  assert.ok(payload.warnings.every((warning) => warning.includes("必须是对象")));
});

test("adds a scope-aware official limit comparison to each sales-channel row", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-official-layer-"));
  const payload = await runQuery({
    index: "nasdaq100",
    outputDir,
    queriedAt: "2026-07-12T01:10:00.000Z",
    fetchText: fixtureFetch(100),
    save: false,
    officialNotices: true,
    officialNoticeFetcher: async () => ({
      byCode: {
        "019441": {
          id: "1",
          title: "测试公告",
          date: "2026-07-09",
          url: "https://example.com/fund/disclose/instance_show_pdf_id.do?instanceid=1",
          parsed: {
            parsed: true,
            effectiveDate: "2026-07-10",
            scope: "specific-channel",
            channels: ["基金公司直销"],
            perShareLimits: { "019441": { amount: 100000, currency: "CNY" } },
            parseWarnings: []
          }
        }
      },
      errors: []
    })
  });

  assert.equal(payload.rows[0].limitAmount, 100);
  assert.equal(payload.rows[0].officialLimit.amount, 100000);
  assert.equal(payload.rows[0].officialLimit.status, "not-comparable-channel");
  assert.equal(payload.officialNotices.parsed, 1);
});

test("keeps official lookup failure distinct from no matching notice", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-official-error-"));
  const payload = await runQuery({
    index: "nasdaq100", outputDir, queriedAt: "2026-07-12T01:10:00.000Z",
    fetchText: fixtureFetch(100), save: false, officialNotices: true,
    officialNoticeFetcher: async () => ({
      byCode: {}, errors: [{ code: "019441", message: "官方披露平台请求超时" }]
    })
  });

  assert.equal(payload.rows[0].officialNotice, null);
  assert.equal(payload.rows[0].officialNoticeError, "官方披露平台请求超时");
  assert.equal(payload.rows[0].decisionStatus, "unknown");
  assert.equal(payload.rows[0].decisionLimitAmount, null);
  assert.equal(payload.rows[0].decisionBasis, "official-query-failed");
  assert.equal(payload.health.status, "degraded");
  assert.ok(payload.health.checked < payload.health.expected);
});

test("does not confirm a channel purchase when the official notice does not cover that share", () => {
  const { applyOfficialDecision } = require("../scripts/lib/query");
  const row = applyOfficialDecision({
    code: "x", status: "limited", limitAmount: 100, channel: "天天基金公开销售页",
    officialNotice: { id: "notice" }
  }, { status: "share-not-covered" });
  assert.equal(row.decisionStatus, "unknown");
  assert.equal(row.decisionLimitAmount, null);
  assert.equal(row.decisionBasis, "official-share-not-covered");
});

test("keeps direct-sale announcement evidence separate when the public sales channel is unavailable", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-direct-evidence-"));
  const productCatalog = "var r = " + JSON.stringify([
    ["111111", "", "测试纳斯达克100基金A", "指数型-海外股票", ""],
    ["222222", "", "测试纳斯达克100基金F", "指数型-海外股票", ""]
  ]) + ";";
  const fetchText = async (url) => {
    if (url.includes("fundcode_search")) return productCatalog;
    if (url.includes("111111")) return "<div>交易状态：限大额（单日累计购买上限10元）</div>";
    if (url.includes("222222")) return "<div>交易状态：暂不开放购买</div>";
    throw new Error(`unexpected URL ${url}`);
  };
  let requestedCodes = [];
  const payload = await runQuery({
    index: "nasdaq100", outputDir, queriedAt: "2026-07-12T01:10:00.000Z",
    fetchText, save: false, officialNotices: true,
    officialNoticeFetcher: async (funds) => {
      requestedCodes = funds.map((fund) => fund.code);
      return {
        byCode: {
          "111111": {
            id: "9", title: "直销限额公告", date: "2026-07-10", url: "https://example.com/example.pdf",
            parsed: {
              parsed: true, effectiveDate: "2026-07-11", scope: "specific-channel", channels: ["基金公司直销"], accountBasis: "single-fund-account-daily-cumulative-per-share",
              perShareLimits: { "222222": { amount: 100, currency: "CNY" } },
              limits: [{ scope: "specific-channel", channels: ["基金公司直销"], perShareLimits: { "222222": { amount: 100, currency: "CNY" } } }],
              parseWarnings: []
            }
          }
        },
        errors: [{ code: "222222", message: "官方披露平台未找到基金" }]
      };
    }
  });

  assert.deepEqual(requestedCodes.sort(), ["111111", "222222"]);
  const unavailable = payload.rows.find((row) => row.code === "222222");
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.channel, "天天基金公开销售页");
  assert.ok(!payload.rows.some((row) => row.code === "222222" && /直销/.test(row.channel)));
  assert.equal(payload.officialChannelEvidence[0].code, "222222");
  assert.equal(payload.officialChannelEvidence[0].channel, "基金公司直销");
  assert.equal(payload.officialChannelEvidence[0].currentAvailability, "unverified");
});

test("direct-sale evidence keeps only the currently effective rule per share", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-current-direct-rule-"));
  const payload = await runQuery({
    index: "nasdaq100", outputDir, queriedAt: "2026-07-13T01:10:00.000Z",
    fetchText: fixtureFetch(10), save: false, officialNotices: true,
    officialNoticeFetcher: async () => ({
      byCode: {
        "019441": {
          id: "timeline", title: "直销额度时间线", date: "2026-07-10", url: "https://example.com/current.pdf",
          parsed: {
            parsed: true, effectiveDate: "2026-07-10", shareCodes: ["019441"],
            limits: [
              { scope: "specific-channel", channels: ["基金公司直销"], accountBasis: "single-fund-account-daily-cumulative-per-share", effectiveDate: "2026-07-10", noticeUrl: "https://example.com/current.pdf", perShareLimits: { "019441": { amount: 300, currency: "CNY" } } },
              { scope: "specific-channel", channels: ["基金公司直销"], accountBasis: "single-fund-account-daily-cumulative-per-share", effectiveDate: "2026-06-01", noticeUrl: "https://example.com/old.pdf", perShareLimits: { "019441": { amount: 100, currency: "CNY" } } }
            ], parseWarnings: []
          }
        }
      }, errors: []
    })
  });

  assert.equal(payload.officialChannelEvidence.length, 1);
  assert.equal(payload.officialChannelEvidence[0].amount, 300);
  assert.equal(payload.officialChannelEvidence[0].noticeUrl, "https://example.com/current.pdf");
});

test("excludes direct-sale amounts whose daily account basis is unknown", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-direct-basis-"));
  const payload = await runQuery({
    index: "nasdaq100", outputDir, queriedAt: "2026-07-13T01:10:00.000Z",
    fetchText: fixtureFetch(10), save: false, officialNotices: true,
    officialNoticeFetcher: async () => ({
      byCode: {
        "019441": {
          id: "basis", title: "直销额度公告", date: "2026-07-10", url: "https://example.com/basis.pdf",
          parsed: {
            parsed: true, effectiveDate: "2026-07-10", shareCodes: ["019441"],
            limits: [{ scope: "specific-channel", channels: ["基金公司直销"], accountBasis: "unknown", effectiveDate: "2026-07-10", perShareLimits: { "019441": { amount: 300, currency: "CNY" } } }],
            parseWarnings: []
          }
        }
      }, errors: []
    })
  });

  assert.deepEqual(payload.officialChannelEvidence, []);
});

test("reports announcement-index and manager-website coverage separately", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-source-coverage-"));
  const productCatalog = "var r = " + JSON.stringify([
    ["015299", "", "华夏纳斯达克100ETF发起式联接(QDII)A", "指数型-海外股票", ""],
    ["015300", "", "华夏纳斯达克100ETF发起式联接(QDII)C", "指数型-海外股票", ""]
  ]) + ";";
  const fetchText = async (url) => url.includes("fundcode_search")
    ? productCatalog
    : "<div>交易状态：暂停申购</div>";
  const notice = {
    id: "merged", title: "合并公告", date: "2026-07-06", url: "https://fund.example/direct.pdf",
    sourceChecks: {
      announcementIndex: { checked: true, found: true },
      managerWebsite: { supported: true, checked: true, found: true }
    },
    parsed: {
      parsed: true, effectiveDate: "2026-07-07", scope: "multi-event", channels: [],
      limits: [{ scope: "specific-channel", channels: ["基金公司直销"], accountBasis: "single-fund-account-daily-cumulative-per-share", effectiveDate: "2026-07-07", perShareLimits: {
        "015299": { amount: 300, currency: "CNY" }, "015300": { amount: 300, currency: "CNY" }
      }}], parseWarnings: []
    }
  };
  const payload = await runQuery({
    index: "nasdaq100", outputDir, queriedAt: "2026-07-13T01:10:00.000Z",
    fetchText, save: false, officialNotices: true,
    officialNoticeFetcher: async () => ({
      byCode: { "015299": notice, "015300": notice },
      errors: [{ code: "015299", source: "manager-website", message: "官网回退失败" }]
    })
  });

  assert.deepEqual(payload.officialNotices.sources.announcementIndex, { eligible: 2, checked: 2, found: 2, errors: 0 });
  assert.deepEqual(payload.officialNotices.sources.managerWebsites, { supported: 2, checked: 2, found: 2, errors: 1 });
  assert.equal(payload.officialNotices.errors, 0);
  assert.equal(payload.officialNotices.sourceFailureCount, 1);
  assert.equal(payload.officialNotices.unresolvedFundCount, 0);
  assert.equal(payload.officialChannelEvidence.length, 2);
});

test("preserves source-reported announcement-index coverage", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-source-disabled-"));
  const payload = await runQuery({
    index: "nasdaq100", outputDir, queriedAt: "2026-07-13T01:10:00.000Z",
    fetchText: fixtureFetch(100), save: false, officialNotices: true,
    officialNoticeFetcher: async () => ({
      byCode: {}, errors: [],
      sourceCoverage: {
        announcementIndex: { eligible: 1, checked: 1, found: 0, errors: 0 },
        managerWebsites: { supported: 0, checked: 0, found: 0, errors: 0 }
      }
    })
  });
  assert.deepEqual(payload.officialNotices.sources.announcementIndex, { eligible: 1, checked: 1, found: 0, errors: 0 });
});

test("uses the stricter applicable official or channel limit as the confirmed amount", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-authority-order-"));
  const payload = await runQuery({
    index: "nasdaq100", outputDir, queriedAt: "2026-07-12T01:10:00.000Z",
    fetchText: fixtureFetch(100), save: false, officialNotices: true,
    officialNoticeFetcher: async () => ({
      byCode: {
        "019441": {
          id: "rule", title: "代销限额公告", date: "2026-07-10", url: "https://example.com/rule.pdf",
          parsed: {
            parsed: true, effectiveDate: "2026-07-11", scope: "sales-agency", channels: ["代销机构"],
            perShareLimits: { "019441": { amount: 10, currency: "CNY" } },
            limits: [{
              scope: "sales-agency", channels: ["代销机构"], effectiveDate: "2026-07-11",
              noticeUrl: "https://example.com/rule.pdf",
              perShareLimits: { "019441": { amount: 10, currency: "CNY" } }
            }], parseWarnings: []
          }
        }
      }, errors: []
    })
  });
  const row = payload.rows.find((item) => item.code === "019441");
  assert.equal(row.status, "limited");
  assert.equal(row.limitAmount, 100);
  assert.equal(row.decisionStatus, "limited");
  assert.equal(row.decisionLimitAmount, 10);
  assert.equal(row.decisionBasis, "official-more-restrictive");
});

test("official full suspension overrides a channel page that still appears purchasable", () => {
  const { applyOfficialDecision } = require("../scripts/lib/query");
  const row = applyOfficialDecision({
    code: "x", status: "limited", limitAmount: 100, channel: "天天基金公开销售页"
  }, { status: "official-suspended", scope: "fund-manager-general", scopeLabel: "基金管理人公告" });
  assert.equal(row.decisionStatus, "suspended");
  assert.equal(row.decisionLimitAmount, null);
  assert.equal(row.decisionBasis, "official-suspended");
});
