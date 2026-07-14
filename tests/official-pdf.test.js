const test = require("node:test");
const assert = require("node:assert/strict");

const {
  compareOfficialLimit,
  extractPdfText,
  parseOfficialNoticeText
} = require("../scripts/lib/official-pdf");

function minimalTextPdf(text) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${text.length + 27} >>\nstream\nBT /F1 12 Tf 20 50 Td (${text}) Tj ET\nendstream`
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

test("extracts text through the real locked PDF.js parser", async () => {
  const text = await extractPdfText(minimalTextPdf("QDII PDF parser fixture"));
  assert.match(text, /QDII PDF parser fixture/);
});

test("parses a fund-wide per-share RMB limit", () => {
  const parsed = parseOfficialNoticeText(`
    公告送出日期：2026年7月9日
    基金主代码 019441
    下属分级基金的基金简称 测试基金(QDII)A 测试基金(QDII)C
    下属分级基金的交易代码 019441 019442
    下属分级基金的限制申购金额（单位：人民币元）10 10
    自2026年7月9日起，A类份额和C类份额单日单个基金账户累计金额限制为10元，分别计算。
  `);

  assert.equal(parsed.parsed, true);
  assert.equal(parsed.effectiveDate, "2026-07-09");
  assert.equal(parsed.scope, "fund-manager-general");
  assert.deepEqual(parsed.perShareLimits, {
    "019441": { amount: 10, currency: "CNY" },
    "019442": { amount: 10, currency: "CNY" }
  });
  assert.equal(parsed.accountBasis, "single-fund-account-daily-cumulative-per-share");
});

test("keeps a fund-company direct-channel limit separate from other sales channels", () => {
  const parsed = parseOfficialNoticeText(`
    建信纳斯达克100指数型证券投资基金（QDII）在直销渠道暂停大额申购公告
    公告送出日期：2026年7月9日
    下属分级基金的基金简称 A美元现汇 A人民币 C美元现汇 C人民币 D人民币
    下属分级基金的交易代码 012751 539001 012753 012752 023422
    自2026年7月10日起，人民币份额（基金代码：539001（A类）、012752（C类））
    在建信基金直销渠道单日单个基金账户累计高于10万元的申购业务进行限制，不同份额分别计算。
    本限制仅针对在建信基金直销渠道投资的情况。
  `);

  assert.equal(parsed.parsed, true);
  assert.equal(parsed.scope, "specific-channel");
  assert.deepEqual(parsed.channels, ["基金公司直销"]);
  assert.deepEqual(parsed.perShareLimits, {
    "539001": { amount: 100000, currency: "CNY" },
    "012752": { amount: 100000, currency: "CNY" }
  });
  assert.equal(compareOfficialLimit({
    code: "539001",
    channel: "天天基金公开销售页",
    limitAmount: 100
  }, parsed, "2026-07-12T10:00:00+08:00").status, "not-comparable-channel");
});

test("parses separate RMB and USD direct-channel limits", () => {
  const parsed = parseOfficialNoticeText(`
    公告送出日期：2026年7月10日
    下属分级基金的基金简称 人民币A 美钞 人民币C 美汇
    下属分级基金的交易代码 017641 017642 019305 017643
    自2026年7月10日起，人民币份额类别的单日累计限额为300.00元（含300.00元）。
    美元份额类别的单日累计限额为30.00美元（含30.00美元）。
    本公司决定对在直销渠道的本基金申购业务进行限制。
  `);

  assert.equal(parsed.scope, "specific-channel");
  assert.deepEqual(parsed.perShareLimits, {
    "017641": { amount: 300, currency: "CNY" },
    "017642": { amount: 30, currency: "USD" },
    "019305": { amount: 300, currency: "CNY" },
    "017643": { amount: 30, currency: "USD" }
  });
});

test("does not apply a one-share future limit to other shares", () => {
  const parsed = parseOfficialNoticeText(`
    公告送出日期：2026年7月11日
    下属分级基金的基金简称 人民币A 人民币C 人民币F 美元A 美元C
    下属分级基金的交易代码 270042 006479 021778 000055 006480
    自2026年7月13日起，F类基金份额（交易代码021778）的单日单个基金账户申购限额为100.00元。
    投资者通过多家销售渠道的申请累计计算，不同份额单独计算限额。
  `);

  assert.deepEqual(parsed.perShareLimits, {
    "021778": { amount: 100, currency: "CNY" }
  });
  assert.equal(compareOfficialLimit({
    code: "021778",
    channel: "天天基金公开销售页",
    limitAmount: 100
  }, parsed, "2026-07-12T10:00:00+08:00").status, "pending");
  assert.equal(compareOfficialLimit({
    code: "270042",
    channel: "天天基金公开销售页",
    limitAmount: 10
  }, parsed, "2026-07-14T10:00:00+08:00").status, "share-not-covered");
});

test("resume clears an older suspension but preserves the earlier long-term limit", () => {
  const parsed = {
    parsed: true,
    limits: [
      { scope: "fund-manager-general", channels: [], effectiveDate: "2026-07-10", noticeId: "resume", perShareLimits: {}, perShareStatuses: { "111111": "open" } },
      { scope: "fund-manager-general", channels: [], effectiveDate: "2026-07-01", noticeId: "suspend", perShareLimits: {}, perShareStatuses: { "111111": "suspended" } },
      { scope: "fund-manager-general", channels: [], effectiveDate: "2026-06-01", noticeId: "limit", noticeUrl: "https://example.com/limit.pdf", accountBasis: "single-fund-account-daily-cumulative", perShareLimits: { "111111": { amount: 10, currency: "CNY" } } }
    ]
  };
  const compared = compareOfficialLimit({
    code: "111111", channel: "天天基金公开销售页", status: "limited", limitAmount: 100
  }, parsed, "2026-07-12T10:00:00+08:00");
  assert.equal(compared.status, "channel-higher");
  assert.equal(compared.amount, 10);
  assert.equal(compared.noticeId, "limit");
  assert.equal(compared.accountBasis, "single-fund-account-daily-cumulative");
});

test("a future suspension does not replace the currently effective limit", () => {
  const parsed = {
    parsed: true,
    limits: [
      { scope: "fund-manager-general", channels: [], effectiveDate: "2026-07-20", noticeId: "future", perShareLimits: {}, perShareStatuses: { "111111": "suspended" } },
      { scope: "fund-manager-general", channels: [], effectiveDate: "2026-06-01", noticeId: "limit", perShareLimits: { "111111": { amount: 10, currency: "CNY" } } }
    ]
  };
  const compared = compareOfficialLimit({
    code: "111111", channel: "天天基金公开销售页", status: "limited", limitAmount: 100
  }, parsed, "2026-07-12T10:00:00+08:00");
  assert.equal(compared.status, "channel-higher");
  assert.equal(compared.amount, 10);
});

test("returns unknown instead of guessing when codes and amounts are ambiguous", () => {
  const parsed = parseOfficialNoticeText(`
    公告送出日期：2026年7月9日
    交易代码 111111 222222 333333
    限制申购金额 10 20
  `);

  assert.equal(parsed.parsed, false);
  assert.deepEqual(parsed.perShareLimits, {});
  assert.ok(parsed.parseWarnings.length > 0);
});

test("parses different direct and sales-agency limits from one official notice", () => {
  const parsed = parseOfficialNoticeText(`
    公告送出日期：2026年6月3日
    下属基金份额的基金简称 测试基金(QDII)A 测试基金(QDII)C
    下属基金份额的交易代码 000834 008971
    2026年6月4日起，投资人通过本公司直销渠道申购本基金A类或C类份额，单日累计金额应不超过100元人民币。
    2026年6月4日起，投资人通过各代销机构申购本基金A类或C类份额，单日累计金额应不超过10元人民币。
  `);

  assert.equal(parsed.parsed, true);
  assert.equal(parsed.scope, "multi-channel");
  assert.equal(parsed.limits.length, 2);
  assert.equal(compareOfficialLimit({
    code: "000834", channel: "天天基金公开销售页", limitAmount: 10
  }, parsed, "2026-07-12T10:00:00+08:00").status, "match");
  assert.equal(compareOfficialLimit({
    code: "000834", channel: "基金公司直销", limitAmount: 100
  }, parsed, "2026-07-12T10:00:00+08:00").status, "match");
  assert.equal(compareOfficialLimit({
    code: "000834", channel: "未分类销售渠道", limitAmount: 10
  }, parsed, "2026-07-12T10:00:00+08:00").status, "not-comparable-channel");
  assert.equal(compareOfficialLimit({
    code: "000834", channel: "天天基金公开销售页", status: "unavailable", limitAmount: null
  }, parsed, "2026-07-12T10:00:00+08:00").status, "channel-unavailable");
});

test("extracts a direct-institution exception appended after a general limit", () => {
  const parsed = parseOfficialNoticeText(`
    公告送出日期：2025年12月4日
    下属分级基金的基金简称 华安纳斯达克100ETF联接(QDII)A 华安纳斯达克100ETF联接(QDII)C
    下属分级基金的交易代码 040046 014978
    自2025年12月5日起，本基金A类、C类人民币基金份额单日每个基金账户累计申购金额应不超过10元。
    自2025年12月5日起，投资者通过本公司直销机构申购本基金，本基金每一类基金份额单日每个基金账户累计申购金额应不超过1000元。
  `);

  const general = parsed.limits.find((rule) => rule.scope === "fund-manager-general");
  const direct = parsed.limits.find((rule) => rule.scope === "specific-channel");
  assert.equal(parsed.parsed, true);
  assert.equal(general.perShareLimits["040046"].amount, 10);
  assert.equal(general.perShareLimits["014978"].amount, 10);
  assert.equal(direct.perShareLimits["040046"].amount, 1000);
  assert.equal(direct.perShareLimits["014978"].amount, 1000);
});

test("extracts a direct electronic-platform limit from narrative share codes", () => {
  const parsed = parseOfficialNoticeText(`
    公告送出日期：2026年7月6日
    关于在基金管理人直销电子交易平台调整华夏纳斯达克100ETF发起式联接基金人民币申购业务上限的公告
    自2026年7月7日起，单个投资者通过本公司直销电子交易平台单日累计申购申请
    华夏纳斯达克100ETF发起式联接(QDII)A（人民币）（015299）或
    华夏纳斯达克100ETF发起式联接(QDII)C（015300）的金额各类别均应不超过人民币300元。
    本基金各销售币种在本公司直销柜台及代销机构仍暂停办理申购业务。
  `);

  assert.equal(parsed.parsed, true);
  assert.equal(parsed.scope, "specific-channel");
  assert.equal(parsed.limits[0].perShareLimits["015299"].amount, 300);
  assert.equal(parsed.limits[0].perShareLimits["015300"].amount, 300);
});

test("extracts an unchanged share limit explicitly preserved by a newer notice", () => {
  const parsed = parseOfficialNoticeText(`
    公告送出日期：2026年7月8日
    下属基金份额的简称 测试基金(QDII)A 测试基金(QDII)C 测试基金(QDII)I
    下属基金份额的代码 016452 016453 021000
    自2026年7月9日起，A类、C类基金份额限额10元。
    本次调整不涉及I类基金份额，I类基金份额仍保持1000元限额不变。
  `);
  assert.equal(parsed.perShareLimits["016452"].amount, 10);
  assert.equal(parsed.perShareLimits["016453"].amount, 10);
  assert.equal(parsed.perShareLimits["021000"].amount, 1000);
});

test("parses parenthesized RMB share classes and keeps named sales channels separate", () => {
  const parsed = parseOfficialNoticeText(`
    公告送出日期：2026年6月23日
    下属分级基金的基金简称 博时标普500ETF联接E（人民币）
    下属分级基金的交易代码 018738
    2026年6月24日起，投资人通过各代销机构（博时财富基金销售有限公司除外）申购本基金E类人民币份额，单日每个基金账户累计金额应不超过100元。
    2026年6月24日起，投资人通过博时财富基金销售有限公司申购本基金E类人民币份额，单日每个基金账户累计金额应不超过500元。
    2026年6月24日起，投资人通过本公司直销渠道申购本基金E类人民币份额，单日每个基金账户累计金额应不超过500元。
  `);

  assert.equal(parsed.parsed, true);
  assert.equal(parsed.limits.find((rule) => rule.scope === "sales-agency").perShareLimits["018738"].amount, 100);
  assert.equal(parsed.limits.find((rule) => rule.channels.includes("博时财富基金销售有限公司")).perShareLimits["018738"].amount, 500);
  assert.equal(parsed.limits.find((rule) => rule.channels.includes("基金公司直销")).perShareLimits["018738"].amount, 500);
  assert.equal(parsed.accountBasis, "single-fund-account-daily-cumulative");
});

test("parses different limits for RMB share classes in one narrative paragraph", () => {
  const parsed = parseOfficialNoticeText(`
    公告送出日期：2026年4月9日
    下属分级基金的基金简称 博时标普500ETF联接A（人民币） 博时标普500ETF联接A（美元现汇） 博时标普500ETF联接C（美元现汇） 博时标普500ETF联接C（人民币） 博时标普500ETF联接E（人民币）
    下属分级基金的交易代码 050025 013425 013499 006075 018738
    自2026年4月10日起，投资人申购本基金A类人民币份额单日累计金额应不超过100元人民币，申购本基金C类人民币份额单日累计金额应不超过100元人民币，申购本基金E类人民币份额单日累计金额应不超过2000元人民币。
  `);

  assert.equal(parsed.parsed, true);
  assert.equal(parsed.perShareLimits["050025"].amount, 100);
  assert.equal(parsed.perShareLimits["006075"].amount, 100);
  assert.equal(parsed.perShareLimits["018738"].amount, 2000);
});
