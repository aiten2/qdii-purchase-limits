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

  assert.equal(indexRequests, 2);
  assert.deepEqual(result.coverage, { eligible: 2, checked: 2, found: 2, errors: 0 });
  assert.equal(result.byCode["015299"][0].parsed.limits[0].perShareLimits["015299"].amount, 300);
  assert.equal(result.byCode["015299"][0].parsed.announcementDate, "2026-07-06");
  assert.equal(result.byCode["015299"][0].parsed.parsed, true);
  assert.equal(result.byCode["015300"][0].source, "公开公告索引");
});

test("limits announcement group work to the configured concurrency", async () => {
  const funds = [
    { code: "100001", name: "测试纳斯达克100基金甲A", index: "nasdaq100" },
    { code: "100002", name: "测试纳斯达克100基金乙A", index: "nasdaq100" },
    { code: "100003", name: "测试纳斯达克100基金丙A", index: "nasdaq100" }
  ];
  let active = 0;
  let maxActive = 0;
  const result = await collectAnnouncementIndexNoticeEvents(funds, {
    concurrency: 2,
    indexRetries: 0,
    fetchText: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return JSON.stringify({ ErrCode: 0, Data: [] });
    },
    fetchBuffer: async () => Buffer.alloc(0),
    extractPdfText: async () => "",
    parseOfficialNoticeText: () => null
  });

  assert.equal(maxActive, 2);
  assert.equal(result.coverage.checked, 3);
});

test("retries a transient announcement index failure", async () => {
  let attempts = 0;
  const result = await collectAnnouncementIndexNoticeEvents([
    { code: "100001", name: "测试纳斯达克100基金A", index: "nasdaq100" }
  ], {
    concurrency: 1,
    indexRetries: 2,
    indexRetryBaseMs: 0,
    fetchText: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("公开公告索引 HTTP 503");
      return JSON.stringify({ ErrCode: 0, Data: [] });
    },
    fetchBuffer: async () => Buffer.alloc(0),
    extractPdfText: async () => "",
    parseOfficialNoticeText: () => null
  });

  assert.equal(attempts, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(result.coverage.checked, 1);
});

test("discovers share-specific notices from every share-code index", async () => {
  const funds = [
    { code: "006479", name: "测试纳斯达克100基金C", index: "nasdaq100" },
    { code: "270042", name: "测试纳斯达克100基金A", index: "nasdaq100" },
    { code: "021778", name: "测试纳斯达克100基金F", index: "nasdaq100" }
  ];
  let indexRequests = 0;
  const result = await collectAnnouncementIndexNoticeEvents(funds, {
    fetchText: async (url) => {
      indexRequests += 1;
      const isFShare = url.includes("fundcode=021778");
      return JSON.stringify({ ErrCode: 0, Data: [isFShare
        ? { FUNDCODE: "021778", TITLE: "F类基金份额调整大额申购业务限额的公告", NEWCATEGORY: "5", PUBLISHDATEDesc: "2026-07-10", ID: "AN202607100000000001" }
        : { FUNDCODE: "006479", TITLE: "人民币份额调整大额申购业务限额的公告", NEWCATEGORY: "5", PUBLISHDATEDesc: "2025-10-30", ID: "AN202510300000000001" }
      ] });
    },
    fetchBuffer: async (url) => Buffer.from(url.includes("20260710") ? "f" : "ac"),
    extractPdfText: async (buffer) => buffer.toString(),
    parseOfficialNoticeText: (text) => ({
      parsed: true,
      announcementDate: text === "f" ? "2026-07-10" : "2025-10-30",
      effectiveDate: text === "f" ? "2026-07-13" : "2025-10-31",
      shareCodes: text === "f" ? ["021778"] : ["006479", "270042"],
      limits: [{
        scope: "fund-manager-general",
        channels: [],
        perShareLimits: text === "f"
          ? { "021778": { amount: 100, currency: "CNY" } }
          : { "006479": { amount: 10, currency: "CNY" }, "270042": { amount: 10, currency: "CNY" } }
      }],
      parseWarnings: []
    })
  });

  assert.equal(indexRequests, 3);
  assert.deepEqual(result.coverage, { eligible: 3, checked: 3, found: 3, errors: 0 });
  assert.equal(result.byCode["006479"].length, 1);
  assert.equal(result.byCode["270042"].length, 1);
  assert.equal(result.byCode["021778"][0].parsed.limits[0].perShareLimits["021778"].amount, 100);
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

test("blocks an older rule when a newer candidate announcement cannot be parsed", async () => {
  const funds = [{ code: "111111", name: "测试纳斯达克100基金A", index: "nasdaq100" }];
  const result = await collectAnnouncementIndexNoticeEvents(funds, {
    fetchText: async () => JSON.stringify({ ErrCode: 0, Data: [
      { FUNDCODE: "111111", TITLE: "测试基金调整大额申购业务限额的公告", NEWCATEGORY: "5", PUBLISHDATEDesc: "2026-07-13", ID: "AN202607130000000001" },
      { FUNDCODE: "111111", TITLE: "测试基金调整大额申购业务限额的公告", NEWCATEGORY: "5", PUBLISHDATEDesc: "2026-07-01", ID: "AN202607010000000002" }
    ] }),
    fetchBuffer: async (url) => {
      if (url.includes("07130000000001")) throw new Error("HTTP 403");
      return Buffer.from("older");
    },
    extractPdfText: async (buffer) => buffer.toString(),
    parseOfficialNoticeText: () => ({
      parsed: true, announcementDate: "2026-07-01", effectiveDate: "2026-07-01", shareCodes: ["111111"],
      limits: [{ scope: "fund-manager-general", channels: [], perShareLimits: { "111111": { amount: 100, currency: "CNY" } } }],
      parseWarnings: []
    })
  });

  assert.equal(result.byCode["111111"], undefined);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, "111111");
  assert.equal(result.errors[0].noticeId, "AN202607130000000001");
});

test("keeps a newer verified rule when only an older announcement fails to parse", async () => {
  const funds = [{ code: "111111", name: "测试纳斯达克100基金A", index: "nasdaq100" }];
  const result = await collectAnnouncementIndexNoticeEvents(funds, {
    fetchText: async () => JSON.stringify({ ErrCode: 0, Data: [
      { FUNDCODE: "111111", TITLE: "测试基金调整大额申购业务限额的公告", NEWCATEGORY: "5", PUBLISHDATEDesc: "2026-07-13", ID: "AN202607130000000001" },
      { FUNDCODE: "111111", TITLE: "测试基金调整大额申购业务限额的公告", NEWCATEGORY: "5", PUBLISHDATEDesc: "2026-07-01", ID: "AN202607010000000002" }
    ] }),
    fetchBuffer: async (url) => {
      if (url.includes("07010000000002")) throw new Error("old PDF unavailable");
      return Buffer.from("newer");
    },
    extractPdfText: async (buffer) => buffer.toString(),
    parseOfficialNoticeText: () => ({
      parsed: true, announcementDate: "2026-07-13", effectiveDate: "2026-07-13", shareCodes: ["111111"],
      limits: [{ scope: "fund-manager-general", channels: [], perShareLimits: { "111111": { amount: 10, currency: "CNY" } } }],
      parseWarnings: []
    })
  });

  assert.equal(result.errors.length, 0);
  assert.equal(result.byCode["111111"][0].date, "2026-07-13");
});

test("continues before a resume event to retain an older long-term limit", async () => {
  const funds = [{ code: "111111", name: "测试纳斯达克100基金A", index: "nasdaq100" }];
  const result = await collectAnnouncementIndexNoticeEvents(funds, {
    fetchText: async () => JSON.stringify({ ErrCode: 0, Data: [
      { FUNDCODE: "111111", TITLE: "测试基金恢复申购业务的公告", NEWCATEGORY: "5", PUBLISHDATEDesc: "2026-07-13", ID: "AN202607130000000001" },
      { FUNDCODE: "111111", TITLE: "测试基金调整大额申购业务限额的公告", NEWCATEGORY: "5", PUBLISHDATEDesc: "2026-06-01", ID: "AN202606010000000002" }
    ] }),
    fetchBuffer: async (url) => Buffer.from(url.includes("07130000000001") ? "resume" : "limit"),
    extractPdfText: async (buffer) => buffer.toString(),
    parseOfficialNoticeText: (text) => text === "resume"
      ? { parsed: false, announcementDate: "2026-07-13", effectiveDate: "2026-07-13", shareCodes: ["111111"], limits: [], parseWarnings: [] }
      : { parsed: true, announcementDate: "2026-06-01", effectiveDate: "2026-06-01", shareCodes: ["111111"], limits: [{ scope: "fund-manager-general", channels: [], perShareLimits: { "111111": { amount: 100, currency: "CNY" } } }], parseWarnings: [] }
  });

  assert.deepEqual(result.byCode["111111"].map((event) => event.category), ["resume", "limit"]);
});
