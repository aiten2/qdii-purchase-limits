const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildOfficialTimelineNotice,
  classifyNoticeTitle,
  collectLatestOfficialNotices,
  fetchLatestOfficialNotice,
  findLatestPurchaseNotice,
  mergeOfficialNoticeEvents,
  parseFundValidation,
  parseTemporaryNotices,
  selectManagerFallbackFunds
} = require("../scripts/lib/official-notices");
const { compareOfficialLimit } = require("../scripts/lib/official-pdf");

const detailHtml = `
<a name="section5"></a>
<div>临时公告
  <a href="../disclose/instance_show_pdf_id.do?instanceid=1521812">
    关于测试基金调整大额申购业务金额限制的公告
  </a><td>2026-07-09</td>
  <a href="../disclose/instance_show_pdf_id.do?instanceid=1520364">
    测试基金基金经理变更公告
  </a><td>2026-07-04</td>
  <a href="../disclose/instance_show_pdf_id.do?instanceid=1509642">
    关于测试基金暂停申购、赎回业务的公告
  </a><td>2026-06-23</td>
</div>
<a name="section7"></a>`;

test("parses official fund validation without leaking unrelated fields", () => {
  assert.equal(parseFundValidation('{"fundId":13137,"isSuccess":true}'), "13137");
  assert.throws(() => parseFundValidation('{"isSuccess":false}'), /未找到基金/);
});

test("extracts temporary notices and selects the latest purchase-related notice", () => {
  const notices = parseTemporaryNotices(detailHtml);
  assert.equal(notices.length, 3);
  assert.equal(notices[0].date, "2026-07-09");
  assert.match(notices[0].url, /1521812/);
  const latest = findLatestPurchaseNotice(notices);
  assert.equal(latest.date, "2026-07-09");
  assert.match(latest.title, /大额申购/);
});

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

test("merges manager-site direct events into a unified-disclosure timeline", () => {
  const base = buildOfficialTimelineNotice([{
    id: "old-suspend", date: "2025-11-22", title: "暂停申购公告", url: "https://eid.example/old.pdf", category: "full-suspend",
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
    id: "eid", date: "2026-07-06", title: "测试基金调整直销申购上限的公告", url: "http://eid.example/1.pdf", category: "limit", parsed
  }]);
  const merged = mergeOfficialNoticeEvents(base, [{
    id: "AN1", date: "2026-07-06", title: "测试基金调整直销申购上限的公告", url: "https://pdf.example/1.pdf", category: "limit", parsed
  }]);

  assert.equal(merged.events.length, 1);
  assert.equal(merged.events[0].url, "http://eid.example/1.pdf");
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

test("downloads and parses the selected official PDF without losing metadata", async () => {
  const notice = await fetchLatestOfficialNotice("019441", {
    postForm: async () => '{"fundId":13137,"isSuccess":true}',
    fetchText: async () => `
      <a name="section5"></a>
      <a href="instance_show_pdf_id.do?instanceid=1521812">关于测试基金调整大额申购业务金额限制的公告</a><td>2026-07-09</td>
      <a name="section7"></a>`,
    fetchBuffer: async () => Buffer.from("fake-pdf"),
    extractPdfText: async () => `
      公告送出日期：2026年7月9日
      下属分级基金的基金简称 测试基金(QDII)A 测试基金(QDII)C
      下属分级基金的交易代码 019441 019442
      自2026年7月9日起，A类份额和C类份额单日单个基金账户累计金额限制为10元，份额分别计算。
    `
  });

  assert.equal(notice.id, "1521812");
  assert.equal(notice.parsed.parsed, true);
  assert.equal(notice.parsed.perShareLimits["019442"].amount, 10);
});

test("uses the disclosure-list date when the PDF omits an announcement date", async () => {
  const notice = await fetchLatestOfficialNotice("019441", {
    postForm: async () => '{"fundId":13137,"isSuccess":true}',
    fetchText: async () => `
      <a name="section5"></a>
      <a href="instance_show_pdf_id.do?instanceid=1521812">关于测试基金调整大额申购业务金额限制的公告</a><td>2026-07-09</td>
      <a name="section7"></a>`,
    fetchBuffer: async () => Buffer.from("fake-pdf"),
    extractPdfText: async () => `
      关于在基金管理人直销电子交易平台调整测试基金申购业务上限的公告
      本公司决定自2026年7月10日起调整申购业务上限。
      单个投资者通过本公司直销电子交易平台单日累计申购申请测试基金A（019441）
      或测试基金C（019442）的金额各类别均应不超过人民币10元。
      特此公告 测试基金管理有限公司 二〇二六年七月九日
    `
  });

  assert.equal(notice.parsed.announcementDate, "2026-07-09");
  assert.equal(notice.parsed.parsed, true);
  assert.deepEqual(notice.parsed.parseWarnings, []);
});

test("keeps the official link but marks amount unknown when PDF parsing fails", async () => {
  const notice = await fetchLatestOfficialNotice("019441", {
    postForm: async () => '{"fundId":13137,"isSuccess":true}',
    fetchText: async () => detailHtml,
    fetchBuffer: async () => { throw new Error("download failed"); }
  });

  assert.equal(notice.id, "1521812");
  assert.equal(notice.parsed.parsed, false);
  assert.match(notice.parsed.parseWarnings[0], /PDF/);
});

test("uses a validated sibling product code and keeps searching for an unrecognized new share", async () => {
  const funds = [
    { code: "111111", name: "测试纳斯达克100基金A", index: "nasdaq100" },
    { code: "222222", name: "测试纳斯达克100基金D", index: "nasdaq100" }
  ];
  const html = `
    <a name="section5"></a>
    <a href="instance_show_pdf_id.do?instanceid=2">测试基金A类调整大额申购业务限额的公告</a><td>2026-07-10</td>
    <a href="instance_show_pdf_id.do?instanceid=1">测试基金D类调整大额申购业务限额的公告</a><td>2026-06-10</td>
    <a name="section7"></a>`;
  const result = await collectLatestOfficialNotices(funds, {
    postForm: async (_url, fields) => fields.cFundCode === "111111"
      ? '{"fundId":99,"isSuccess":true}'
      : '{"isSuccess":false}',
    fetchText: async () => html,
    fetchBuffer: async (url) => Buffer.from(url.includes("instanceid=2") ? "a" : "d"),
    announcementIndexFetcher: async () => ({ byCode: {}, errors: [], checkedCodes: [], coverage: { eligible: 2, checked: 0, found: 0, errors: 0 } }),
    managerNoticeFetcher: async () => ({ byCode: {}, errors: [], checkedCodes: [], coverage: { supported: 0, checked: 0, found: 0, errors: 0 } }),
    extractPdfText: async (buffer) => buffer.toString() === "a" ? `
      公告送出日期：2026年7月10日
      下属分级基金的基金简称 测试基金(QDII)A 测试基金(QDII)C
      下属分级基金的交易代码 111111 111112
      自2026年7月10日起，A类份额和C类份额单日单个基金账户累计金额限制为10元。
    ` : `
      公告送出日期：2026年6月10日
      下属分级基金的基金简称 测试基金(QDII)D 测试基金(QDII)E
      下属分级基金的交易代码 222222 222223
      自2026年6月10日起，D类份额和E类份额单日单个基金账户累计金额限制为20元。
    `
  });

  assert.equal(result.errors.length, 0);
  assert.ok(result.byCode["222222"]);
  assert.equal(result.byCode["222222"].parsed.perShareLimits["222222"].amount, 20);
  assert.equal(result.byCode["222222"].timeline.length, 2);
});
