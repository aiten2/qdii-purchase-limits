const test = require("node:test");
const assert = require("node:assert/strict");

const { renderMarkdown } = require("../scripts/lib/report");

function assertNoInternalEvidence(markdown) {
  assert.doesNotMatch(markdown, /https?:\/\//);
  assert.doesNotMatch(markdown, /天天基金|在哪里买|官方公告核对|额度怎么算/);
  assert.doesNotMatch(markdown, /当前确认可买|现在可以买|推荐购买/);
}

test("compact report only shows fund, code, current daily limit, and changes", () => {
  const markdown = renderMarkdown({
    queriedAt: "2026-07-12T06:30:00.000Z", timezone: "Asia/Shanghai",
    selection: { index: "all", includeUsd: false, includeEtf: false },
    rows: [
      { index: "nasdaq100", code: "n1", name: "纳指一百A", channel: "天天基金公开销售页", status: "limited", limitAmount: 100, decisionStatus: "limited", decisionLimitAmount: 100, sourceUrl: "https://example.com/n1", officialNotice: { url: "http://example.com/a.pdf" }, officialLimit: { status: "match", amount: 100 } },
      { index: "nasdaq100", code: "n2", name: "纳指一万A", channel: "公开代销渠道", status: "limited", limitAmount: 10000, decisionStatus: "limited", decisionLimitAmount: 10000, sourceUrl: "https://example.com/n2" },
      { index: "sp500", code: "s1", name: "标普暂停A", channel: "天天基金公开销售页", status: "suspended", limitAmount: null, sourceUrl: "https://example.com/s1" },
      { index: "sp500", code: "s2", name: "标普限额A", channel: "天天基金公开销售页", status: "limited", limitAmount: 10, decisionStatus: "limited", decisionLimitAmount: 10, sourceUrl: "https://example.com/s2" }
    ],
    previousSnapshotFound: true,
    changes: [{ type: "amount-increased", after: { code: "n2", name: "纳指一万A", channel: "公开代销渠道", limitAmount: 10000 }, before: { limitAmount: 1000 } }],
    health: { status: "ok", checked: 4, expected: 4, coverage: 1 },
    officialNotices: { enabled: true },
    officialChannelEvidence: [
      { index: "nasdaq100", code: "n1", name: "纳指一百A", channel: "基金公司直销", amount: 100000, currency: "CNY", noticeUrl: "http://example.com/direct.pdf" },
      { index: "sp500", code: "s2", name: "标普限额A", channel: "基金公司直销", amount: 300, currency: "CNY", noticeUrl: "http://example.com/sp.pdf" }
    ]
  });

  assert.match(markdown, /^# 当前申购限额/m);
  assert.match(markdown, /\| 单日申购上限 \| 基金 \| 代码 \|/);
  assert.match(markdown, /\| :---: \| --- \| :---: \|/);
  assert.doesNotMatch(markdown, /\| ---: \| --- \| --- \|/);
  assert.ok(markdown.indexOf("纳指一万") < markdown.indexOf("纳指一百"));
  assert.match(markdown, /\| 1万元 \| 纳指一万 \| n2 \|/);
  assert.match(markdown, /额度提高：1000元 -> 1万元｜n2 纳指一万A/);
  assert.match(markdown, /其余标普500相关基金当前均暂停或暂不可申购/);
  assert.doesNotMatch(markdown, /标普暂停/);
  const sectionHeadings = [
    "## 代销渠道｜纳斯达克100",
    "## 基金公司直销｜纳斯达克100",
    "## 代销渠道｜标普500",
    "## 基金公司直销｜标普500"
  ];
  sectionHeadings.forEach((heading) => assert.match(markdown, new RegExp(heading)));
  sectionHeadings.slice(1).forEach((heading, index) => {
    assert.ok(markdown.indexOf(sectionHeadings[index]) < markdown.indexOf(heading));
  });
  assert.equal((markdown.match(/\| 单日申购上限 \| 基金 \| 代码 \|/g) || []).length, 4);
  const nasdaqDirect = markdown.slice(markdown.indexOf(sectionHeadings[1]), markdown.indexOf(sectionHeadings[2]));
  const sp500Direct = markdown.slice(markdown.indexOf(sectionHeadings[3]));
  assert.match(nasdaqDirect, /纳指一百/);
  assert.doesNotMatch(nasdaqDirect, /标普限额/);
  assert.match(sp500Direct, /标普限额/);
  assert.doesNotMatch(sp500Direct, /纳指一百/);
  assert.doesNotMatch(markdown, /## 基金公司直销公告限额/);
  assert.match(markdown, /\| 10万元 \| 纳指一百 \| n1 \|/);
  assert.match(markdown, /\| 300元 \| 标普限额 \| s2 \|/);
  assert.match(markdown, /以基金公司官方 APP 实际显示为准/);
  assertNoInternalEvidence(markdown);
});

test("detailed report groups unavailable funds without links or channel names", () => {
  const markdown = renderMarkdown({
    queriedAt: "2026-07-12T06:30:00.000Z", timezone: "Asia/Shanghai",
    selection: { index: "nasdaq100", includeUsd: false, includeEtf: false },
    rows: [
      { index: "nasdaq100", code: "a1", name: "暂停基金A", channel: "天天基金公开销售页", status: "limited", limitAmount: 100, decisionStatus: "suspended", decisionLimitAmount: null, decisionBasis: "official-suspended", sourceUrl: "https://example.com/a1", officialLimit: { noticeUrl: "http://example.com/notice.pdf" } },
      { index: "nasdaq100", code: "a2", name: "暂停基金C", channel: "天天基金公开销售页", status: "unavailable", limitAmount: null, decisionStatus: "suspended", decisionLimitAmount: null, decisionBasis: "official-suspended", sourceUrl: "https://example.com/a2" },
      { index: "nasdaq100", code: "b1", name: "未确认基金A", channel: "天天基金公开销售页", status: "limited", limitAmount: 100, decisionStatus: "unknown", decisionLimitAmount: null, sourceUrl: "https://example.com/b1" }
    ],
    previousSnapshotFound: true, changes: [], health: { status: "partial", checked: 0, expected: 3, coverage: 0 },
    officialNotices: { enabled: true }, display: { details: true }
  });

  assert.match(markdown, /## 暂停或暂不可申购/);
  assert.match(markdown, /## 代销渠道｜纳斯达克100/);
  assert.match(markdown, /## 基金公司直销｜纳斯达克100/);
  assert.match(markdown, /\| 状态 \| 基金 \| 代码 \|/);
  assert.match(markdown, /\| 暂停申购 \| 暂停基金 \| a1、a2 \|/);
  assert.match(markdown, /\| 暂未确认 \| 未确认基金 \| b1 \|/);
  assertNoInternalEvidence(markdown);
});

test("detailed report uses the final official-first amount without exposing the comparison", () => {
  const markdown = renderMarkdown({
    queriedAt: "2026-07-12T06:30:00.000Z", timezone: "Asia/Shanghai",
    selection: { index: "nasdaq100", includeUsd: false, includeEtf: false },
    rows: [{
      index: "nasdaq100", code: "n1", name: "测试基金A", channel: "天天基金公开销售页",
      status: "limited", limitAmount: 100, decisionStatus: "limited", decisionLimitAmount: 10,
      decisionBasis: "official-more-restrictive", sourceUrl: "https://example.com/n1",
      officialNotice: { url: "http://example.com/rule.pdf" }, officialLimit: { amount: 10, status: "channel-higher" }
    }],
    previousSnapshotFound: true, changes: [], health: { status: "ok", checked: 1, expected: 1, coverage: 1 },
    officialNotices: { enabled: true }, display: { details: true }
  });

  assert.match(markdown, /\| 10元 \| 测试基金 \| n1 \|/);
  assert.doesNotMatch(markdown, /100元/);
  assertNoInternalEvidence(markdown);
});

test("degraded compact report never lists an unverified fund as purchasable", () => {
  const markdown = renderMarkdown({
    queriedAt: "2026-07-12T06:30:00.000Z", timezone: "Asia/Shanghai",
    selection: { index: "nasdaq100", includeUsd: false, includeEtf: false },
    rows: [{ index: "nasdaq100", code: "n1", name: "失败基金A", channel: "天天基金公开销售页", status: "unknown", limitAmount: null, sourceUrl: "https://example.com/n1" }],
    changes: [], health: { status: "degraded", checked: 0, expected: 1, coverage: 0 }, officialNotices: { enabled: true }
  });
  assert.match(markdown, /数据不完整/);
  assert.doesNotMatch(markdown, /失败基金/);
  assertNoInternalEvidence(markdown);
});

test("first detailed query explains that it created a comparison baseline", () => {
  const markdown = renderMarkdown({
    queriedAt: "2026-07-12T06:30:00.000Z", timezone: "Asia/Shanghai",
    selection: { index: "sp500", includeUsd: false, includeEtf: false },
    rows: [], previousSnapshotFound: false, changes: [],
    health: { status: "ok", checked: 0, expected: 0, coverage: 1 }, display: { details: true }
  });
  assert.match(markdown, /这是第一次查询：已经保存本次结果，供下次比较/);
  assertNoInternalEvidence(markdown);
});

test("direct-sale announcement rows are grouped without links or purchase claims", () => {
  const markdown = renderMarkdown({
    queriedAt: "2026-07-12T06:30:00.000Z", timezone: "Asia/Shanghai",
    selection: { index: "all", includeUsd: false, includeEtf: false }, rows: [], changes: [],
    health: { status: "ok", checked: 0, expected: 0, coverage: 1 },
    officialChannelEvidence: [
      { index: "nasdaq100", code: "a1", name: "测试纳指基金A", channel: "基金公司直销", amount: 100, currency: "CNY", noticeUrl: "http://example.com/a.pdf" },
      { index: "nasdaq100", code: "a2", name: "测试纳指基金C", channel: "基金公司直销", amount: 100, currency: "CNY", noticeUrl: "http://example.com/a.pdf" }
    ]
  });
  assert.match(markdown, /## 基金公司直销｜纳斯达克100/);
  assert.match(markdown, /\| 100元 \| 测试纳指基金 \| a1、a2 \|/);
  assert.match(markdown, /以基金公司官方 APP 实际显示为准/);
  assert.doesNotMatch(markdown, /当前可申购|确认可申购/);
  assertNoInternalEvidence(markdown);
});

test("direct-sale table discloses a manager-website fetch gap without exposing diagnostics", () => {
  const markdown = renderMarkdown({
    queriedAt: "2026-07-13T01:00:00.000Z", timezone: "Asia/Shanghai",
    selection: { index: "nasdaq100", includeUsd: false, includeEtf: false },
    rows: [], changes: [], health: { status: "ok", checked: 1, expected: 1, coverage: 1 },
    officialNotices: { sources: { managerWebsites: { supported: 2, checked: 0, found: 0, errors: 2 } } },
    officialChannelEvidence: [{ index: "nasdaq100", code: "a1", name: "测试基金A", channel: "基金公司直销", amount: 100, currency: "CNY" }]
  });
  assert.match(markdown, /部分直销数据暂未获取，以基金公司官方 APP 实际显示为准/);
  assert.doesNotMatch(markdown, /HTTP|抓取|解析|错误/);
});

test("direct-sale table stays partial until the announcement index covers every eligible share", () => {
  const markdown = renderMarkdown({
    queriedAt: "2026-07-13T01:00:00.000Z", timezone: "Asia/Shanghai",
    selection: { index: "nasdaq100", includeUsd: false, includeEtf: false },
    rows: [], changes: [], health: { status: "ok", checked: 10, expected: 10, coverage: 1 },
    officialNotices: { sources: { announcementIndex: { eligible: 10, checked: 2, found: 2, errors: 0 } } },
    officialChannelEvidence: [{ index: "nasdaq100", code: "a1", name: "测试基金A", channel: "基金公司直销", amount: 100, currency: "CNY" }]
  });
  assert.match(markdown, /部分直销数据尚未覆盖，以基金公司官方 APP 实际显示为准/);
});
