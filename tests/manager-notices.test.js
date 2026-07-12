const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectManagerSiteNoticeEvents,
  managerSourceForFund,
  parseHuaxiaArticlePdfUrl,
  parseHuaxiaNoticeList
} = require("../scripts/lib/manager-notices");

test("parses the official Huaxia notice list and article PDF", () => {
  const list = parseHuaxiaNoticeList(`
    <a href="#">直销申购</a><div class="item">2026-07-08</div>
    <div class="item"><a href="../c/2026-07-06/948826.shtml">关于在基金管理人直销电子交易平台调整测试基金申购业务上限的公告</a></div>
    <div class="item">2026-07-06</div>
    <div class="item"><a href="../c/2026-04-22/934907.shtml">测试基金季度报告</a></div>
    <div class="item">2026-04-22</div>
  `);
  assert.equal(list.length, 1);
  assert.equal(list[0].date, "2026-07-06");
  assert.equal(list[0].url, "https://fund.chinaamc.com/c/2026-07-06/948826.shtml");
  assert.equal(parseHuaxiaArticlePdfUrl('<a href="/upload/resources/file/2026/07/06/direct.pdf">公告</a>'), "https://fund.chinaamc.com/upload/resources/file/2026/07/06/direct.pdf");
});

test("collects Huaxia manager-site direct events and reports source coverage", async () => {
  const funds = [
    { code: "015299", name: "华夏纳斯达克100ETF发起式联接(QDII)A", index: "nasdaq100" },
    { code: "015300", name: "华夏纳斯达克100ETF发起式联接(QDII)C", index: "nasdaq100" },
    { code: "019441", name: "万家纳斯达克100指数发起式(QDII)A", index: "nasdaq100" }
  ];
  const listHtml = `
    <div class="item"><a href="../c/2026-07-06/948826.shtml">关于在基金管理人直销电子交易平台调整华夏纳斯达克100ETF发起式联接基金申购业务上限的公告</a></div>
    <div class="item">2026-07-06</div>`;
  const articleHtml = '<a href="/upload/resources/file/2026/07/06/direct.pdf">公告 PDF</a>';
  const result = await collectManagerSiteNoticeEvents(funds, {
    fetchText: async (url) => url.includes("publishGgList") ? listHtml : articleHtml,
    fetchBuffer: async () => Buffer.from("fake-pdf"),
    extractPdfText: async () => `
      关于在基金管理人直销电子交易平台调整申购业务上限的公告
      自2026年7月7日起，单个投资者通过本公司直销电子交易平台单日累计申购申请
      测试基金A（015299）或测试基金C（015300）的金额各类别均应不超过人民币300元。`,
    parseOfficialNoticeText: () => ({
      parsed: true, announcementDate: null, effectiveDate: "2026-07-07", scope: "specific-channel", channels: ["基金公司直销"],
      shareCodes: ["015299", "015300"], limits: [{ scope: "specific-channel", channels: ["基金公司直销"], perShareLimits: {
        "015299": { amount: 300, currency: "CNY" }, "015300": { amount: 300, currency: "CNY" }
      }}], parseWarnings: ["未可靠提取公告日期"]
    })
  });

  assert.equal(managerSourceForFund(funds[0]).id, "huaxia");
  assert.equal(managerSourceForFund(funds[2]), null);
  assert.equal(result.coverage.supported, 2);
  assert.equal(result.coverage.checked, 2);
  assert.equal(result.coverage.found, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(result.byCode["015299"][0].parsed.announcementDate, "2026-07-06");
  assert.equal(result.byCode["015300"][0].parsed.parsed, true);
});
