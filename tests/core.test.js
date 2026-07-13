const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSnapshot,
  classifyFund,
  compareSnapshots,
  sortPurchasableRows
} = require("../scripts/lib/core");

test("classifies exact Nasdaq 100 and S&P 500 funds without mixing related themes", () => {
  assert.equal(classifyFund(["019441", "", "万家纳斯达克100指数发起式(QDII)A", "指数型-海外股票"]).index, "nasdaq100");
  assert.equal(classifyFund(["017091", "", "景顺长城纳斯达克科技ETF联接(QDII)A人民币", "指数型-海外股票"]), null);
  assert.equal(classifyFund(["017641", "", "摩根标普500指数(QDII)人民币A", "指数型-海外股票"]).index, "sp500");
});

test("separates RMB OTC funds, USD shares, and exchange-traded ETFs", () => {
  assert.deepEqual(classifyFund(["019441", "", "万家纳斯达克100指数发起式(QDII)A", "指数型-海外股票"]), {
    code: "019441", name: "万家纳斯达克100指数发起式(QDII)A", index: "nasdaq100", currency: "CNY", route: "otc", variant: "standard"
  });
  assert.equal(classifyFund(["019174", "", "摩根纳斯达克100指数(QDII)美元现汇A", "指数型-海外股票"]).currency, "USD");
  assert.equal(classifyFund(["513500", "", "标普500ETF博时", "指数型-海外股票"]).route, "exchange");
  assert.equal(classifyFund(["008401", "", "大成标普500等权重指数(QDII)C人民币", "指数型-海外股票"]).variant, "equal-weight");
});

test("sorts purchasable funds by unlimited first then limit amount descending", () => {
  const rows = sortPurchasableRows([
    { code: "a", status: "limited", limitAmount: 100 },
    { code: "b", status: "open", limitAmount: null },
    { code: "c", status: "limited", limitAmount: 10000 },
    { code: "d", status: "suspended", limitAmount: 999999 }
  ]);
  assert.deepEqual(rows.map((row) => row.code), ["b", "c", "a"]);
});

test("compares status, amount, and channel changes using stable snapshot keys", () => {
  const before = buildSnapshot("2026-07-12T01:10:00.000Z", [
    { index: "nasdaq100", code: "019441", channel: "天天基金", status: "limited", limitAmount: 100 }
  ]);
  const after = buildSnapshot("2026-07-12T06:30:00.000Z", [
    { index: "nasdaq100", code: "019441", channel: "天天基金", status: "limited", limitAmount: 10 },
    { index: "nasdaq100", code: "019441", channel: "基金公司直销", status: "open", limitAmount: null }
  ]);
  const changes = compareSnapshots(before, after);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].type, "amount-decreased");
  assert.equal(changes[1].type, "channel-added");
});

test("snapshot keys keep currency, channel bucket, and account basis separate", () => {
  const snapshot = buildSnapshot("2026-07-12T01:10:00.000Z", [
    { index: "nasdaq100", code: "019441", channel: "基金公司直销", channelBucket: "fund-manager-direct", currency: "CNY", accountBasis: "daily", status: "limited", limitAmount: 100 },
    { index: "nasdaq100", code: "019441", channel: "基金公司直销", channelBucket: "fund-manager-direct", currency: "USD", accountBasis: "daily", status: "limited", limitAmount: 10 }
  ]);
  assert.equal(snapshot.version, 2);
  assert.equal(Object.keys(snapshot.byKey).length, 2);
});
