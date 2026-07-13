function clean(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function classifyFund(row) {
  const code = clean(row && row[0]);
  const name = clean(row && row[2]);
  if (!/^\d{6}$/.test(code) || !name) return null;

  let index = "";
  if (/(?:纳斯达克|纳指)\s*100/i.test(name)) index = "nasdaq100";
  if (/标普\s*500/i.test(name)) index = "sp500";
  if (!index) return null;

  const currency = /(美元|美汇|美钞)/.test(name) ? "USD" : "CNY";
  const exchangeCode = /^(?:15|51)/.test(code);
  const linkedFund = /(?:联接|連接)/.test(name);
  const route = exchangeCode && !linkedFund ? "exchange" : "otc";
  const variant = /等权/.test(name) ? "equal-weight" : (/FOF/i.test(name) ? "fof" : "standard");

  return { code, name, index, currency, route, variant };
}

function sortPurchasableRows(rows) {
  return (rows || [])
    .filter((row) => row && (["open", "limited"].includes(row.decisionStatus || row.status)))
    .slice()
    .sort((left, right) => {
      const leftStatus = left.decisionStatus || left.status;
      const rightStatus = right.decisionStatus || right.status;
      if (leftStatus === "open" && rightStatus !== "open") return -1;
      if (rightStatus === "open" && leftStatus !== "open") return 1;
      const leftAmount = Number.isFinite(left.decisionLimitAmount) ? left.decisionLimitAmount : (Number.isFinite(left.limitAmount) ? left.limitAmount : -1);
      const rightAmount = Number.isFinite(right.decisionLimitAmount) ? right.decisionLimitAmount : (Number.isFinite(right.limitAmount) ? right.limitAmount : -1);
      if (leftAmount !== rightAmount) return rightAmount - leftAmount;
      return clean(left.code).localeCompare(clean(right.code), "zh-CN");
    });
}

function snapshotKey(row) {
  return [
    clean(row.index),
    clean(row.code),
    clean(row.channel),
    clean(row.channelBucket),
    clean(row.currency),
    clean(row.accountBasis)
  ].join("|");
}

function buildSnapshot(queriedAt, rows) {
  const normalizedRows = (rows || []).map((row) => Object.assign({}, row, { key: snapshotKey(row) }));
  return {
    version: 2,
    queriedAt,
    rows: normalizedRows,
    byKey: Object.fromEntries(normalizedRows.map((row) => [row.key, row]))
  };
}

function compareSnapshots(before, after) {
  if (!before || !before.byKey) return [];
  const previous = before.byKey;
  const current = after && after.byKey ? after.byKey : {};
  const changes = [];

  Object.keys(current).sort().forEach((key) => {
    const next = current[key];
    const prior = previous[key];
    if (!prior) return;
    if (clean(prior.status) !== clean(next.status)) {
      changes.push({ type: "status-changed", key, before: prior, after: next });
      return;
    }
    const priorAmount = Number.isFinite(prior.limitAmount) ? prior.limitAmount : null;
    const nextAmount = Number.isFinite(next.limitAmount) ? next.limitAmount : null;
    if (priorAmount !== nextAmount) {
      let type = "amount-changed";
      if (priorAmount !== null && nextAmount !== null) type = nextAmount < priorAmount ? "amount-decreased" : "amount-increased";
      changes.push({ type, key, before: prior, after: next });
    }
  });

  Object.keys(current).sort().forEach((key) => {
    if (!previous[key]) changes.push({ type: "channel-added", key, before: null, after: current[key] });
  });
  Object.keys(previous).sort().forEach((key) => {
    if (!current[key]) changes.push({ type: "channel-removed", key, before: previous[key], after: null });
  });
  return changes;
}

module.exports = {
  buildSnapshot,
  classifyFund,
  clean,
  compareSnapshots,
  snapshotKey,
  sortPurchasableRows
};
