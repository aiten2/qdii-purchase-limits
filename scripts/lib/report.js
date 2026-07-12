const { sortPurchasableRows } = require("./core");

const INDEX_LABELS = {
  nasdaq100: "纳斯达克100",
  sp500: "标普500"
};

const STATUS_LABELS = {
  open: "未显示申购上限",
  limited: "限额申购",
  suspended: "暂停申购",
  unavailable: "暂不可申购",
  unknown: "暂未确认"
};

function formatAmount(value) {
  if (!Number.isFinite(value)) return "未显示上限";
  if (value >= 10000 && value % 10000 === 0) return `${value / 10000}万元`;
  return `${value}元`;
}

function formatCurrencyAmount(value, currency) {
  if (currency === "USD") return Number.isFinite(value) ? `${value}美元` : "未显示上限";
  return formatAmount(value);
}

function formatTime(iso, timezone) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone || "Asia/Shanghai",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23"
    }).format(new Date(iso)).replace(/\//g, "-");
  } catch {
    return iso;
  }
}

function baseFundName(name) {
  return String(name || "").replace(/(?:人民币)?[A-Z](?:类)?(?:人民币|\(人民币\))?$/i, "").trim();
}

function changeLine(change) {
  const row = change.after || change.before || {};
  const prefix = `${row.code || ""} ${row.name || ""}`.trim();
  if (change.type === "amount-increased") return `- 额度提高：${formatAmount(change.before.limitAmount)} -> ${formatAmount(change.after.limitAmount)}｜${prefix}`;
  if (change.type === "amount-decreased") return `- 额度降低：${formatAmount(change.before.limitAmount)} -> ${formatAmount(change.after.limitAmount)}｜${prefix}`;
  if (change.type === "amount-changed") return `- 额度变化：${formatAmount(change.before.limitAmount)} -> ${formatAmount(change.after.limitAmount)}｜${prefix}`;
  if (change.type === "status-changed") return `- 状态变化：${STATUS_LABELS[change.before.status] || change.before.status} -> ${STATUS_LABELS[change.after.status] || change.after.status}｜${prefix}`;
  if (change.type === "channel-added") return `- 新增记录：${prefix}`;
  if (change.type === "channel-removed") return `- 记录消失：${prefix}`;
  return `- ${change.type}：${prefix}`;
}

function groupLimitRows(rows) {
  const groups = new Map();
  sortPurchasableRows(rows).forEach((row) => {
    const status = row.decisionStatus || row.status;
    const amount = Number.isFinite(row.decisionLimitAmount) ? row.decisionLimitAmount : row.limitAmount;
    const amountKey = status === "open" ? "open" : String(amount);
    const baseName = baseFundName(row.name);
    const key = [row.index, amountKey, baseName].join("|");
    if (!groups.has(key)) groups.set(key, { amountKey, baseName, codes: [] });
    if (!groups.get(key).codes.includes(row.code)) groups.get(key).codes.push(row.code);
  });
  return [...groups.values()];
}

function groupUnavailableRows(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const status = row.decisionStatus || row.status;
    const baseName = baseFundName(row.name);
    const key = [row.index, status, baseName].join("|");
    if (!groups.has(key)) groups.set(key, { status, baseName, codes: [] });
    if (!groups.get(key).codes.includes(row.code)) groups.get(key).codes.push(row.code);
  });
  return [...groups.values()];
}

function renderLimitTable(lines, rows) {
  lines.push("| 单日申购上限 | 基金 | 代码 |", "| ---: | --- | --- |");
  groupLimitRows(rows).forEach((group) => {
    const amount = group.amountKey === "open" ? "未显示上限" : formatAmount(Number(group.amountKey));
    lines.push(`| ${amount} | ${group.baseName} | ${group.codes.join("、")} |`);
  });
}

function renderUnavailableTable(lines, rows) {
  lines.push("| 状态 | 基金 | 代码 |", "| --- | --- | --- |");
  groupUnavailableRows(rows).forEach((group) => {
    lines.push(`| ${STATUS_LABELS[group.status] || group.status} | ${group.baseName} | ${group.codes.join("、")} |`);
  });
}

function renderDirectSaleTable(lines, evidence, officialNotices) {
  if (!(evidence || []).length) return;
  const groups = new Map();
  evidence.forEach((row) => {
    const baseName = baseFundName(row.name);
    const key = [row.index, row.amount, row.currency, baseName].join("|");
    if (!groups.has(key)) groups.set(key, { baseName, amount: row.amount, currency: row.currency, codes: [] });
    if (!groups.get(key).codes.includes(row.code)) groups.get(key).codes.push(row.code);
  });
  lines.push("## 基金公司直销公告限额", "");
  const managerCoverage = officialNotices && officialNotices.sources && officialNotices.sources.managerWebsites;
  const announcementCoverage = officialNotices && officialNotices.sources && officialNotices.sources.announcementIndex;
  const announcementPartial = announcementCoverage
    && (announcementCoverage.errors > 0 || announcementCoverage.checked < announcementCoverage.eligible);
  const managerPartial = !announcementCoverage && managerCoverage
    && (managerCoverage.errors > 0 || managerCoverage.checked < managerCoverage.supported);
  let note = "以基金公司官方 APP 实际显示为准。";
  if (announcementPartial && announcementCoverage.errors === 0) note = "部分直销数据尚未覆盖，以基金公司官方 APP 实际显示为准。";
  else if (announcementPartial || managerPartial) note = "部分直销数据暂未获取，以基金公司官方 APP 实际显示为准。";
  lines.push(note, "");
  lines.push("| 单日申购上限 | 基金 | 代码 |", "| ---: | --- | --- |");
  [...groups.values()]
    .sort((left, right) => right.amount - left.amount || left.baseName.localeCompare(right.baseName, "zh-CN"))
    .forEach((group) => lines.push(`| ${formatCurrencyAmount(group.amount, group.currency)} | ${group.baseName} | ${group.codes.join("、")} |`));
  lines.push("");
}

function reportFooter(lines) {
  lines.push("仅整理公开申购限制信息，不构成基金推荐或投资建议。", "");
}

function renderCompactMarkdown(payload) {
  const health = payload.health || {};
  const lines = ["# 当前申购限额", ""];
  lines.push(`更新时间：${formatTime(payload.queriedAt, payload.timezone)}｜数据：${health.checked || 0}/${health.expected || 0}`, "");
  if (health.status !== "ok") lines.push("**数据不完整：暂未确认的项目不进入限额清单。**", "");
  const indexes = payload.selection.index === "all" ? ["nasdaq100", "sp500"] : [payload.selection.index];
  indexes.forEach((indexName) => {
    const rows = (payload.rows || []).filter((row) => row.index === indexName);
    const limited = sortPurchasableRows(rows);
    const unavailable = rows.filter((row) => !["open", "limited"].includes(row.decisionStatus || row.status));
    lines.push(`## ${INDEX_LABELS[indexName] || indexName}`, "");
    if (!limited.length) lines.push("没有确认到限额申购记录。", "");
    else {
      renderLimitTable(lines, limited);
      lines.push("");
    }
    if (unavailable.length) lines.push(`其余${INDEX_LABELS[indexName] || indexName}相关基金当前均暂停或暂不可申购。`, "");
  });
  renderDirectSaleTable(lines, payload.officialChannelEvidence, payload.officialNotices);
  if ((payload.changes || []).length) {
    lines.push("## 本次变化", "");
    payload.changes.forEach((change) => lines.push(changeLine(change)));
    lines.push("");
  }
  reportFooter(lines);
  return lines.join("\n");
}

function renderDetailedMarkdown(payload) {
  const lines = ["# 当前申购限额", ""];
  lines.push(`更新时间：${formatTime(payload.queriedAt, payload.timezone)}`);
  lines.push(`范围：${payload.selection.index === "all" ? "纳斯达克100 + 标普500" : INDEX_LABELS[payload.selection.index] || payload.selection.index}；${payload.selection.includeUsd ? "包含美元份额" : "人民币份额"}；${payload.selection.includeEtf ? "包含场内ETF" : "场外申购"}`);
  const health = payload.health || {};
  lines.push(`数据：${health.status === "ok" ? "完整" : "不完整"}，${health.checked || 0}/${health.expected || 0}`, "");

  const indexes = payload.selection.index === "all" ? ["nasdaq100", "sp500"] : [payload.selection.index];
  indexes.forEach((indexName) => {
    const rows = (payload.rows || []).filter((row) => row.index === indexName);
    const limited = sortPurchasableRows(rows);
    const unavailable = rows.filter((row) => !["open", "limited"].includes(row.decisionStatus || row.status));
    lines.push(`## ${INDEX_LABELS[indexName] || indexName}`, "", "### 当前限额", "");
    if (!limited.length) lines.push("没有确认到限额申购记录。", "");
    else {
      renderLimitTable(lines, limited);
      lines.push("");
    }
    lines.push("### 暂停或暂不可申购", "");
    if (!unavailable.length) lines.push("无。", "");
    else {
      renderUnavailableTable(lines, unavailable);
      lines.push("");
    }
  });

  renderDirectSaleTable(lines, payload.officialChannelEvidence, payload.officialNotices);

  lines.push("## 本次变化", "");
  if (!payload.previousSnapshotFound) lines.push("这是第一次查询：已经保存本次结果，供下次比较。", "");
  else if (!(payload.changes || []).length) lines.push("与上次相比，没有发现额度或状态变化。", "");
  else {
    payload.changes.forEach((change) => lines.push(changeLine(change)));
    lines.push("");
  }
  reportFooter(lines);
  return lines.join("\n");
}

function renderMarkdown(payload) {
  return payload.display && payload.display.details ? renderDetailedMarkdown(payload) : renderCompactMarkdown(payload);
}

module.exports = {
  INDEX_LABELS,
  STATUS_LABELS,
  baseFundName,
  changeLine,
  formatAmount,
  formatTime,
  renderCompactMarkdown,
  renderDetailedMarkdown,
  renderMarkdown
};
