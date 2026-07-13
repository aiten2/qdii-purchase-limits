const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  parseFundCatalog,
  parsePurchasePage
} = require("../scripts/lib/sources");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

test("parses the public fund catalog and keeps exact target-index funds", () => {
  const rows = parseFundCatalog(fixture("fund-list.js"));
  assert.deepEqual(rows.map((row) => row.code), ["019441", "017641", "017642", "513500"]);
  assert.equal(rows.find((row) => row.code === "017091"), undefined);
});

test("parses a limited public sales-channel page with amount and source metadata", () => {
  const queriedAt = "2026-07-12T06:30:00.000Z";
  const row = parsePurchasePage(fixture("fund-page.html"), {
    code: "019441", name: "万家纳斯达克100指数发起式(QDII)A", index: "nasdaq100", currency: "CNY", route: "otc", variant: "standard"
  }, queriedAt);
  assert.equal(row.status, "limited");
  assert.equal(row.limitAmount, 10);
  assert.equal(row.channel, "天天基金公开销售页");
  assert.equal(row.queriedAt, queriedAt);
  assert.match(row.sourceUrl, /019441/);
  assert.equal(row.dataQuality, "live-public-page");
  assert.equal(row.statusText, "限额申购");
});

test("keeps source-page promotional copy out of structured status text", () => {
  const row = parsePurchasePage(
    "<div>交易状态：限大额 单日累计购买上限10元 立即购买 手机也可以买基金 扫码下载手机版</div>",
    { code: "019441", name: "万家纳斯达克100指数发起式(QDII)A", index: "nasdaq100", currency: "CNY", route: "otc", variant: "standard" },
    "2026-07-12T06:30:00.000Z"
  );
  assert.equal(row.statusText, "限额申购");
  assert.doesNotMatch(row.statusText, /购买|下载|扫码|手机/);
});

test("does not mistake a suspended fund with a historical amount for purchasable", () => {
  const row = parsePurchasePage("<div>交易状态：暂停申购（单日累计购买上限100元），开放赎回</div>", {
    code: "017641", name: "摩根标普500指数(QDII)人民币A", index: "sp500", currency: "CNY", route: "otc", variant: "standard"
  }, "2026-07-12T06:30:00.000Z");
  assert.equal(row.status, "suspended");
  assert.equal(row.limitAmount, null);
});

test("marks unrecognized pages as unknown instead of open", () => {
  const row = parsePurchasePage("<html><body>页面维护中</body></html>", {
    code: "017641", name: "摩根标普500指数(QDII)人民币A", index: "sp500", currency: "CNY", route: "otc", variant: "standard"
  }, "2026-07-12T06:30:00.000Z");
  assert.equal(row.status, "unknown");
  assert.equal(row.dataQuality, "unverified-page-shape");
});

test("treats an unavailable purchase message as unavailable even when the page also says limited", () => {
  const row = parsePurchasePage(
    "<div>交易状态：限大额 开放赎回 该基金暂不开放购买</div>",
    { code: "021000", name: "南方纳斯达克100指数发起(QDII)I", index: "nasdaq100", currency: "CNY", route: "otc", variant: "standard" },
    "2026-07-12T10:00:00.000Z"
  );
  assert.equal(row.status, "unavailable");
  assert.equal(row.limitAmount, null);
});

test("does not call a limited fund verified when no limit amount can be extracted", () => {
  const row = parsePurchasePage(
    "<div>交易状态：限大额 开放赎回</div>",
    { code: "000001", name: "测试纳斯达克100基金", index: "nasdaq100", currency: "CNY", route: "otc", variant: "standard" },
    "2026-07-12T10:00:00.000Z"
  );
  assert.equal(row.status, "unknown");
  assert.equal(row.dataQuality, "limit-amount-missing");
});
