const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAnnouncementApiUrl,
  buildAnnouncementPdfUrl,
  collectAnnouncementIndexNoticeEvents,
  parseAnnouncementIndex
} = require("../scripts/lib/announcement-index");

test("parses purchase notices from the public announcement index", () => {
  const notices = parseAnnouncementIndex(JSON.stringify({
    ErrCode: 0,
    Data: [
      {
        FUNDCODE: "015299",
        TITLE: "关于在基金管理人直销电子交易平台调整测试基金申购业务上限的公告",
        NEWCATEGORY: "5",
        PUBLISHDATEDesc: "2026-07-06",
        ID: "AN202607061826735870"
      },
      {
        FUNDCODE: "015299",
        TITLE: "测试基金2026年第2季度报告",
        NEWCATEGORY: "3",
        PUBLISHDATEDesc: "2026-07-01",
        ID: "AN202607010000000001"
      }
    ]
  }));

  assert.equal(notices.length, 1);
  assert.equal(notices[0].date, "2026-07-06");
  assert.equal(notices[0].category, "limit");
  assert.equal(notices[0].url, "https://pdf.dfcfw.com/pdf/H2_AN202607061826735870_1.pdf");
  assert.match(buildAnnouncementApiUrl("015299"), /fundcode=015299/);
  assert.match(buildAnnouncementApiUrl("015299"), /type=5/);
  assert.throws(() => buildAnnouncementPdfUrl("../../secret"), /公告 ID/);
});

test("collects and parses announcement events without manual web browsing", async () => {
  const funds = [
    { code: "015299", name: "华夏纳斯达克100ETF发起式联接(QDII)A", index: "nasdaq100" },
    { code: "015300", name: "华夏纳斯达克100ETF发起式联接(QDII)C", index: "nasdaq100" }
  ];
  let indexRequests = 0;
  const result = await collectAnnouncementIndexNoticeEvents(funds, {
    fetchText: async () => {
      indexRequests += 1;
      return JSON.stringify({ ErrCode: 0, Data: [{
        FUNDCODE: "015299",
        TITLE: "关于在基金管理人直销电子交易平台调整华夏纳斯达克100基金申购业务上限的公告",
        NEWCATEGORY: "5",
        PUBLISHDATEDesc: "2026-07-06",
        ID: "AN202607061826735870"
      }] });
    },
    fetchBuffer: async () => Buffer.from("fake-pdf"),
    extractPdfText: async () => "official notice text",
    parseOfficialNoticeText: () => ({
      parsed: true,
      announcementDate: null,
      effectiveDate: "2026-07-07",
      shareCodes: ["015299", "015300"],
      limits: [{
        scope: "specific-channel",
        channels: ["基金公司直销"],
        perShareLimits: {
          "015299": { amount: 300, currency: "CNY" },
          "015300": { amount: 300, currency: "CNY" }
        }
      }],
      parseWarnings: ["未可靠提取公告日期"]
    })
  });

  assert.equal(indexRequests, 1);
  assert.deepEqual(result.coverage, { eligible: 2, checked: 2, found: 2, errors: 0 });
  assert.equal(result.byCode["015299"][0].parsed.limits[0].perShareLimits["015299"].amount, 300);
  assert.equal(result.byCode["015299"][0].parsed.announcementDate, "2026-07-06");
  assert.equal(result.byCode["015299"][0].parsed.parsed, true);
  assert.equal(result.byCode["015300"][0].source, "公开公告索引");
});

test("keeps full-suspension events that have share codes but no amount", async () => {
  const funds = [
    { code: "161130", name: "易方达纳斯达克100ETF联接(QDII-LOF)A(人民币)", index: "nasdaq100" },
    { code: "012870", name: "易方达纳斯达克100ETF联接(QDII-LOF)C(人民币)", index: "nasdaq100" }
  ];
  const result = await collectAnnouncementIndexNoticeEvents(funds, {
    fetchText: async () => JSON.stringify({ ErrCode: 0, Data: [{
      FUNDCODE: "161130",
      TITLE: "易方达纳斯达克100ETF联接基金暂停申购及定期定额投资业务的公告",
      NEWCATEGORY: "5",
      PUBLISHDATEDesc: "2026-03-19",
      ID: "AN202603181820618456"
    }] }),
    fetchBuffer: async () => Buffer.from("fake-pdf"),
    extractPdfText: async () => "suspension notice",
    parseOfficialNoticeText: () => ({
      parsed: false,
      announcementDate: "2026-03-19",
      effectiveDate: "2026-03-19",
      shareCodes: ["161130", "012870"],
      limits: [],
      parseWarnings: ["未可靠建立份额代码与限购额度的对应关系"]
    })
  });

  assert.deepEqual(result.coverage, { eligible: 2, checked: 2, found: 2, errors: 0 });
  assert.equal(result.byCode["161130"][0].category, "full-suspend");
  assert.equal(result.byCode["012870"][0].parsed.shareCodes.length, 2);
});

test("keeps tracing direct-sale notices after a newer general rule covers every share", async () => {
  const funds = [
    { code: "111111", name: "测试纳斯达克100基金A", index: "nasdaq100" },
    { code: "111112", name: "测试纳斯达克100基金C", index: "nasdaq100" }
  ];
  const result = await collectAnnouncementIndexNoticeEvents(funds, {
    fetchText: async () => JSON.stringify({ ErrCode: 0, Data: [
      { FUNDCODE: "111111", TITLE: "测试基金调整大额申购业务限额的公告", NEWCATEGORY: "5", PUBLISHDATEDesc: "2026-07-10", ID: "AN202607100000000001" },
      { FUNDCODE: "111111", TITLE: "测试基金调整在基金管理人直销机构申购业务上限的公告", NEWCATEGORY: "5", PUBLISHDATEDesc: "2026-07-01", ID: "AN202607010000000002" }
    ] }),
    fetchBuffer: async (url) => Buffer.from(url.includes("07100000000001") ? "general" : "direct"),
    extractPdfText: async (buffer) => buffer.toString(),
    parseOfficialNoticeText: (text) => ({
      parsed: true, announcementDate: "2026-07-01", effectiveDate: "2026-07-01", shareCodes: ["111111", "111112"],
      limits: [{
        scope: text === "direct" ? "specific-channel" : "fund-manager-general",
        channels: text === "direct" ? ["基金公司直销"] : [],
        perShareLimits: {
          "111111": { amount: text === "direct" ? 1000 : 10, currency: "CNY" },
          "111112": { amount: text === "direct" ? 1000 : 10, currency: "CNY" }
        }
      }], parseWarnings: []
    })
  });

  const events = result.byCode["111111"];
  assert.equal(events.length, 2);
  assert.ok(events.some((event) => event.parsed.limits[0].scope === "specific-channel"));
  assert.ok(events.some((event) => event.parsed.limits[0].scope === "fund-manager-general"));
});
