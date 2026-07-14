const test = require("node:test");
const assert = require("node:assert/strict");

const {
  assertRedirectAllowed,
  buildOfficialTimelineNotice,
  classifyNoticeTitle,
  collectLatestOfficialNotices,
  findLatestPurchaseNotice,
  getBuffer,
  mergeOfficialNoticeEvents,
  selectManagerFallbackFunds
} = require("../scripts/lib/official-notices");

test("retries a transient official PDF HTTP failure", async () => {
  let attempts = 0;
  const delays = [];
  const buffer = await getBuffer("https://example.com/notice.pdf", {
    retries: 4,
    retryBaseMs: 1000,
    retryJitterMs: 0,
    sleep: async (delay) => { delays.push(delay); },
    requestBuffer: async () => {
      attempts += 1;
      if (attempts < 5) throw new Error("官方公告 PDF HTTP 567");
      return Buffer.from("pdf");
    }
  });

  assert.equal(attempts, 5);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  assert.equal(buffer.toString(), "pdf");
});

test("rejects HTTPS-to-HTTP announcement redirects", () => {
  assert.doesNotThrow(() => assertRedirectAllowed("https://example.com/a.pdf", "https://cdn.example.com/a.pdf"));
  assert.throws(() => assertRedirectAllowed("https://example.com/a.pdf", "http://cdn.example.com/a.pdf"), /不安全重定向/);
});

test("official source coverage only exposes active announcement sources", async () => {
  const result = await collectLatestOfficialNotices([], {
    announcementIndexFetcher: async () => ({
      byCode: {}, errors: [], checkedCodes: [],
      coverage: { eligible: 0, checked: 0, found: 0, errors: 0 }
    })
  });
  assert.deepEqual(Object.keys(result.sourceCoverage).sort(), ["announcementIndex", "managerWebsites"]);
});

test("passes the configured concurrency to the announcement collector", async () => {
  let receivedConcurrency = null;
  let receivedPdfConcurrency = null;
  let receivedParserVersion = null;
  await collectLatestOfficialNotices([], {
    concurrency: 4,
    pdfConcurrency: 2,
    parserVersion: 11,
    announcementIndexFetcher: async (_funds, options) => {
      receivedConcurrency = options.concurrency;
      receivedPdfConcurrency = options.pdfConcurrency;
      receivedParserVersion = options.parserVersion;
      return { byCode: {}, errors: [], checkedCodes: [], coverage: { eligible: 0, checked: 0, found: 0, errors: 0 } };
    }
  });
  assert.equal(receivedConcurrency, 4);
  assert.equal(receivedPdfConcurrency, 2);
  assert.equal(receivedParserVersion, 11);
});
const { compareOfficialLimit } = require("../scripts/lib/official-pdf");

test("classifies limit, full suspension, resume, and holiday notices", () => {
  assert.equal(classifyNoticeTitle("F类基金份额调整大额申购业务限额的公告"), "limit");
  assert.equal(classifyNoticeTitle("关于在基金管理人直销电子交易平台调整人民币申购业务上限的公告"), "limit");
  assert.equal(classifyNoticeTitle("关于基金暂停申购、赎回业务的公告"), "full-suspend");
  assert.equal(classifyNoticeTitle("关于基金恢复申购业务的公告"), "resume");
  assert.equal(classifyNoticeTitle("2026年境外主要市场节假日暂停申购的公告"), "holiday-calendar");
  assert.equal(classifyNoticeTitle("关于基金2026年1月19日暂停申购、赎回业务的公告"), "holiday-calendar");
});

test("skips holiday calendars and sorts notices before selecting a limit rule", () => {
  const selected = findLatestPurchaseNotice([
    { id: "old", date: "2025-12-04", title: "暂停大额申购业务的公告" },
    { id: "holiday", date: "2026-01-14", title: "2026年境外主要市场节假日暂停申购的公告" }
  ]);
  assert.equal(selected.id, "old");
});

test("builds per-share timeline rules by continuing past a newer F-only notice", () => {
  const timeline = buildOfficialTimelineNotice([
    {
      id: "ac", date: "2025-10-30", title: "人民币份额调整大额申购业务限额的公告", url: "https://example.com/ac.pdf",
      category: "limit",
      parsed: {
        parsed: true, effectiveDate: "2025-10-31",
        limits: [{ scope: "fund-manager-general", channels: [], perShareLimits: {
          "270042": { amount: 10, currency: "CNY" }, "006479": { amount: 10, currency: "CNY" }
        } }]
      }
    },
    {
      id: "f", date: "2026-07-10", title: "F类基金份额调整大额申购业务限额的公告", url: "https://example.com/f.pdf",
      category: "limit",
      parsed: {
        parsed: true, effectiveDate: "2026-07-13",
        limits: [{ scope: "fund-manager-general", channels: [], perShareLimits: {
          "021778": { amount: 100, currency: "CNY" }
        } }]
      }
    }
  ]);

  const rules = timeline.parsed.limits;
  const byCode = Object.fromEntries(rules.flatMap((rule) => Object.entries(rule.perShareLimits)));
  assert.equal(byCode["270042"].amount, 10);
  assert.equal(byCode["006479"].amount, 10);
  assert.equal(byCode["021778"].amount, 100);
  assert.equal(rules.find((rule) => rule.perShareLimits["270042"]).noticeId, "ac");
  assert.equal(rules.find((rule) => rule.perShareLimits["021778"]).noticeId, "f");
});

test("keeps newer direct rules alongside older general rules for the same shares", () => {
  const timeline = buildOfficialTimelineNotice([
    {
      id: "general", date: "2026-02-26", title: "基金暂停大额申购公告", url: "https://example.com/general.pdf", category: "limit",
      parsed: { parsed: true, effectiveDate: "2026-02-27", limits: [{ scope: "fund-manager-general", channels: [], perShareLimits: {
        "539001": { amount: 100, currency: "CNY" }, "012752": { amount: 100, currency: "CNY" }, "023422": { amount: 100, currency: "CNY" }
      } }] }
    },
    {
      id: "direct", date: "2026-07-09", title: "在直销渠道暂停大额申购公告", url: "https://example.com/direct.pdf", category: "limit",
      parsed: { parsed: true, effectiveDate: "2026-07-10", limits: [{ scope: "specific-channel", channels: ["基金公司直销"], perShareLimits: {
        "539001": { amount: 100000, currency: "CNY" }, "012752": { amount: 100000, currency: "CNY" }
      } }] }
    }
  ]);

  const rules = timeline.parsed.limits;
  assert.equal(rules.find((rule) => rule.scope === "specific-channel").perShareLimits["539001"].amount, 100000);
  assert.equal(rules.find((rule) => rule.scope === "fund-manager-general").perShareLimits["539001"].amount, 100);
  assert.equal(rules.find((rule) => rule.scope === "fund-manager-general").perShareLimits["023422"].amount, 100);
});

test("merges manager-site direct events into an existing announcement timeline", () => {
  const base = buildOfficialTimelineNotice([{
    id: "old-suspend", date: "2025-11-22", title: "暂停申购公告", url: "https://announcement.example/old.pdf", category: "full-suspend",
    parsed: { parsed: false, effectiveDate: "2025-11-24", scope: "fund-manager-general", channels: [], shareCodes: ["015299", "015300"], limits: [], parseWarnings: [] }
  }]);
  const merged = mergeOfficialNoticeEvents(base, [{
    id: "manager-direct", date: "2026-07-06", title: "直销电子交易平台调整申购上限公告", url: "https://fund.example/direct.pdf", category: "limit",
    parsed: { parsed: true, announcementDate: "2026-07-06", effectiveDate: "2026-07-07", scope: "specific-channel", channels: ["基金公司直销"], shareCodes: ["015299", "015300"], limits: [{
      scope: "specific-channel", channels: ["基金公司直销"], perShareLimits: {
        "015299": { amount: 300, currency: "CNY" }, "015300": { amount: 300, currency: "CNY" }
      }
    }], parseWarnings: [] }
  }]);

  assert.equal(compareOfficialLimit({ code: "015299", channel: "基金公司直销", status: "limited", limitAmount: 300 }, merged.parsed, "2026-07-13T00:00:00+08:00").status, "match");
  assert.equal(compareOfficialLimit({ code: "015299", channel: "天天基金公开销售页", status: "suspended", limitAmount: null }, merged.parsed, "2026-07-13T00:00:00+08:00").status, "official-suspended");
  assert.ok(merged.timeline.some((event) => event.url === "https://fund.example/direct.pdf"));
});

test("deduplicates the same announcement discovered from more than one index", () => {
  const parsed = {
    parsed: true, announcementDate: "2026-07-06", effectiveDate: "2026-07-07", shareCodes: ["015299"],
    limits: [{ scope: "specific-channel", channels: ["基金公司直销"], perShareLimits: {
      "015299": { amount: 300, currency: "CNY" }
    }}], parseWarnings: []
  };
  const base = buildOfficialTimelineNotice([{
    id: "official", date: "2026-07-06", title: "测试基金调整直销申购上限的公告", url: "https://official.example/1.pdf", category: "limit", parsed
  }]);
  const merged = mergeOfficialNoticeEvents(base, [{
    id: "AN1", date: "2026-07-06", title: "测试基金调整直销申购上限的公告", url: "https://pdf.example/1.pdf", category: "limit", parsed
  }]);

  assert.equal(merged.events.length, 1);
  assert.equal(merged.events[0].url, "https://official.example/1.pdf");
});

test("only falls back to a manager website when official timelines lack a direct-sale rule", () => {
  const funds = [
    { code: "015299", name: "华夏纳斯达克100ETF发起式联接(QDII)A", index: "nasdaq100" },
    { code: "015300", name: "华夏纳斯达克100ETF发起式联接(QDII)C", index: "nasdaq100" }
  ];
  const directTimeline = buildOfficialTimelineNotice([{
    id: "direct", date: "2026-07-06", title: "调整直销申购上限公告", url: "https://example.com/direct.pdf", category: "limit",
    parsed: { parsed: true, effectiveDate: "2026-07-07", shareCodes: ["015299"], limits: [{
      scope: "specific-channel", channels: ["基金公司直销"], perShareLimits: { "015299": { amount: 300, currency: "CNY" } }
    }], parseWarnings: [] }
  }]);

  const fallback = selectManagerFallbackFunds(funds, { "015299": directTimeline, "015300": null });
  assert.deepEqual(fallback.map((fund) => fund.code), ["015300"]);
});

test("a newer full suspension overrides an older general limit for the same shares", () => {
  const timeline = buildOfficialTimelineNotice([
    {
      id: "limit", date: "2025-11-11", title: "调整大额申购业务的公告", url: "https://example.com/limit.pdf", category: "limit",
      parsed: { parsed: true, effectiveDate: "2025-11-12", shareCodes: ["016532", "016533", "021838"], limits: [{
        scope: "fund-manager-general", channels: [], perShareLimits: {
          "016532": { amount: 10, currency: "CNY" }, "016533": { amount: 10, currency: "CNY" }, "021838": { amount: 10, currency: "CNY" }
        }
      }] }
    },
    {
      id: "suspend", date: "2026-02-03", title: "暂停申购业务的公告", url: "https://example.com/suspend.pdf", category: "full-suspend",
      parsed: { parsed: false, effectiveDate: "2026-02-03", scope: "fund-manager-general", channels: [], shareCodes: ["016532", "016533", "021838"], limits: [], parseWarnings: [] }
    }
  ]);
  const rule = timeline.parsed.limits.find((item) => item.perShareStatuses && item.perShareStatuses["021838"]);
  assert.equal(rule.perShareStatuses["021838"], "suspended");
  assert.ok(timeline.parsed.limits.some((item) => item.perShareLimits && item.perShareLimits["021838"]));
  assert.equal(compareOfficialLimit({
    code: "021838", channel: "天天基金公开销售页", status: "limited", limitAmount: 10
  }, timeline.parsed, "2026-07-12T10:00:00+08:00").status, "official-suspended");
});
