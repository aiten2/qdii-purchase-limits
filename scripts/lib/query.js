const fs = require("node:fs");
const path = require("node:path");
const { buildSnapshot, compareSnapshots, snapshotKey } = require("./core");
const { collectLatestOfficialNotices } = require("./official-notices");
const { compareOfficialLimit } = require("./official-pdf");
const { managerSourceForFund } = require("./manager-notices");
const { collectFundStatuses, discoverFunds } = require("./sources");
const { renderMarkdown } = require("./report");

const OFFICIAL_NOTICE_CACHE_VERSION = 10;
const SUPPORTS_POSIX_PERMISSIONS = process.platform !== "win32";

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function writeAtomic(filePath, content) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, SUPPORTS_POSIX_PERMISSIONS ? { recursive: true, mode: 0o700 } : { recursive: true });
  if (SUPPORTS_POSIX_PERMISSIONS) fs.chmodSync(directory, 0o700);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const writeOptions = SUPPORTS_POSIX_PERMISSIONS ? { encoding: "utf8", mode: 0o600 } : { encoding: "utf8" };
  fs.writeFileSync(tempPath, content, writeOptions);
  fs.renameSync(tempPath, filePath);
  if (SUPPORTS_POSIX_PERMISSIONS) fs.chmodSync(filePath, 0o600);
}

function scopeKey(options) {
  return [options.index, options.includeUsd ? "usd" : "cny", options.includeEtf ? "with-etf" : "otc"].join("-");
}

function selectFunds(funds, options) {
  return funds.filter((fund) => {
    if (options.index !== "all" && fund.index !== options.index) return false;
    if (!options.includeUsd && fund.currency === "USD") return false;
    if (!options.includeEtf && fund.route === "exchange") return false;
    return true;
  });
}

function coveredShareCodes(notice) {
  if (!notice || !notice.parsed || !notice.parsed.parsed) return [];
  return [...new Set((notice.parsed.limits || []).flatMap((rule) => [
    ...Object.keys(rule.perShareLimits || {}),
    ...Object.keys(rule.perShareStatuses || {})
  ]))];
}

function buildOfficialChannelEvidence(rows, queriedAt, timezone) {
  const evidence = [];
  const seen = new Set();
  (rows || []).forEach((row) => {
    const notice = row.officialNotice;
    if (!notice || !notice.parsed || !notice.parsed.parsed) return;
    const current = compareOfficialLimit({
      code: row.code,
      channel: "基金公司直销",
      status: "limited",
      limitAmount: null
    }, notice.parsed, queriedAt, timezone);
    const accountBasis = current.accountBasis || "unknown";
    if (!Number.isFinite(current.amount)
      || !String(accountBasis).startsWith("single-fund-account-daily-cumulative")
      || ["not-comparable-channel", "official-suspended", "pending", "unknown", "share-not-covered"].includes(current.status)) return;
    const key = [row.code, current.currency, current.amount, current.noticeUrl || notice.url].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    evidence.push({
      index: row.index,
      code: row.code,
      name: row.name,
      channel: "基金公司直销",
      amount: current.amount,
      currency: current.currency,
      accountBasis,
      effectiveDate: current.effectiveDate,
      noticeDate: current.noticeDate || notice.date,
      noticeUrl: current.noticeUrl || notice.url,
      sourceStatus: row.status,
      sourceChannel: row.channel,
      currentAvailability: "unverified",
      queriedAt
    });
  });
  return evidence;
}

function applyOfficialDecision(row, officialLimit) {
  const result = Object.assign({}, row, {
    decisionStatus: row.status,
    decisionLimitAmount: Number.isFinite(row.limitAmount) ? row.limitAmount : null,
    decisionBasis: "channel-only"
  });
  const blockUnverifiedPurchase = (basis) => {
    if (["open", "limited"].includes(row.status)) {
      result.decisionStatus = "unknown";
      result.decisionLimitAmount = null;
      result.decisionBasis = basis;
    }
    return result;
  };
  if (row.officialNoticeError) return blockUnverifiedPurchase("official-query-failed");
  if (officialLimit && officialLimit.status === "official-suspended") {
    result.decisionStatus = "suspended";
    result.decisionLimitAmount = null;
    result.decisionBasis = "official-suspended";
    return result;
  }
  if (!row.officialNotice) return blockUnverifiedPurchase("official-not-found");
  if (!officialLimit) return blockUnverifiedPurchase("official-unverified");
  if (["unknown", "share-not-covered", "pending"].includes(officialLimit.status)) {
    return blockUnverifiedPurchase(`official-${officialLimit.status}`);
  }
  if (officialLimit.status === "official-open") {
    result.decisionBasis = "official-open-channel-current";
    return result;
  }
  if (!Number.isFinite(officialLimit.amount)) return result;
  if (officialLimit.status === "not-comparable-channel") return result;
  if (["unavailable", "suspended", "unknown"].includes(row.status)) return result;
  const channelAmount = Number.isFinite(row.limitAmount) ? row.limitAmount : null;
  result.decisionStatus = "limited";
  result.decisionLimitAmount = channelAmount === null ? officialLimit.amount : Math.min(channelAmount, officialLimit.amount);
  if (channelAmount === null || officialLimit.amount < channelAmount) result.decisionBasis = "official-more-restrictive";
  else if (channelAmount < officialLimit.amount) result.decisionBasis = "channel-more-restrictive";
  else result.decisionBasis = "official-and-channel-match";
  return result;
}

function loadChannelRows(filePath, selectedFunds, queriedAt, warnings) {
  if (!filePath) return [];
  const raw = readJson(filePath, null);
  if (!Array.isArray(raw)) throw new Error(`渠道文件必须是 JSON 数组：${path.basename(filePath)}`);
  const selected = new Map(selectedFunds.map((fund) => [fund.code, fund]));
  const now = new Date(queriedAt).getTime();
  return raw.flatMap((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      warnings.push(`忽略渠道记录 #${index + 1}：记录必须是对象`);
      return [];
    }
    const fund = selected.get(String(row.code || ""));
    if (!fund) return [];
    if (!row.channel || !row.channelBucket || !row.sourceUrl || !row.verifiedAt || !row.expiresAt) {
      warnings.push(`忽略渠道记录 #${index + 1}：缺少 channel/channelBucket/sourceUrl/verifiedAt/expiresAt`);
      return [];
    }
    if (!["sales-agency", "fund-manager-direct"].includes(row.channelBucket)) {
      warnings.push(`忽略渠道记录 #${index + 1}：channelBucket 无效`);
      return [];
    }
    let sourceUrl;
    try {
      sourceUrl = new URL(row.sourceUrl);
    } catch {
      warnings.push(`忽略渠道记录 #${index + 1}：sourceUrl 无效`);
      return [];
    }
    if (sourceUrl.protocol !== "https:" || sourceUrl.username || sourceUrl.password) {
      warnings.push(`忽略渠道记录 #${index + 1}：sourceUrl 必须是无认证信息的 HTTPS 地址`);
      return [];
    }
    sourceUrl.search = "";
    sourceUrl.hash = "";
    const verifiedAt = new Date(row.verifiedAt).getTime();
    const expiresAt = new Date(row.expiresAt).getTime();
    if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) || verifiedAt > now || expiresAt <= verifiedAt) {
      warnings.push(`忽略渠道记录 #${index + 1}：核验时间或失效时间无效`);
      return [];
    }
    if (expiresAt <= now) {
      warnings.push(`忽略已过期渠道记录 #${index + 1}`);
      return [];
    }
    if (!["open", "limited", "suspended", "unavailable", "unknown"].includes(row.status)) {
      warnings.push(`忽略渠道记录 #${index + 1}：status 无效`);
      return [];
    }
    if (row.status === "limited" && (!Number.isFinite(row.limitAmount) || row.limitAmount <= 0)) {
      warnings.push(`忽略渠道记录 #${index + 1}：限购额度必须是正数`);
      return [];
    }
    return [Object.assign({}, fund, {
      channel: String(row.channel).trim(),
      channelType: "user-verified-channel",
      channelBucket: row.channelBucket,
      status: row.status,
      limitAmount: row.status === "limited" ? row.limitAmount : null,
      sourceUrl: sourceUrl.toString(),
      verifiedAt: new Date(verifiedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      queriedAt,
      dataQuality: "user-verified-channel"
    })];
  });
}

function savePayload(outputDir, scope, payload, snapshot, previousState, historyLimit, updateBaseline) {
  const state = previousState && previousState.scopes ? previousState : { version: 1, scopes: {} };
  if (updateBaseline) state.scopes[scope] = snapshot;
  const historyName = payload.queriedAt.replace(/[:.]/g, "-") + ".json";
  const historyDir = path.join(outputDir, "history", scope);
  writeAtomic(path.join(outputDir, "latest.json"), `${JSON.stringify(payload, null, 2)}\n`);
  writeAtomic(path.join(outputDir, "latest.md"), `${renderMarkdown(payload)}\n`);
  if (updateBaseline) writeAtomic(path.join(outputDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  writeAtomic(path.join(historyDir, historyName), `${JSON.stringify({ queriedAt: payload.queriedAt, scope, rows: payload.rows, health: payload.health, changes: payload.changes }, null, 2)}\n`);

  const historyFiles = fs.readdirSync(historyDir).filter((name) => name.endsWith(".json")).sort().reverse();
  historyFiles.slice(historyLimit || 90).forEach((name) => fs.unlinkSync(path.join(historyDir, name)));
}

async function runQuery(options) {
  const settings = Object.assign({
    index: "all",
    includeUsd: false,
    includeEtf: false,
    concurrency: 2,
    minCoverage: 0.9,
    timezone: "Asia/Shanghai",
    save: true,
    historyLimit: 90,
    details: false,
    officialNotices: false,
    officialNoticeCacheHours: 6
  }, options);
  if (!["all", "nasdaq100", "sp500"].includes(settings.index)) throw new Error("--index 只支持 all、nasdaq100 或 sp500");
  if (!settings.outputDir) throw new Error("缺少 outputDir");
  const queriedAt = settings.queriedAt || new Date().toISOString();
  const warnings = [];
  const catalog = await discoverFunds({ fetchText: settings.fetchText, retries: settings.retries });
  const selectedFunds = selectFunds(catalog, settings);
  if (!selectedFunds.length) throw new Error("当前筛选范围没有发现目标基金");
  const collected = await collectFundStatuses(selectedFunds, {
    queriedAt,
    concurrency: settings.concurrency,
    fetchText: settings.fetchText,
    retries: settings.retries
  });
  const channelRows = loadChannelRows(settings.channelsFile, selectedFunds, queriedAt, warnings);
  const scope = scopeKey(settings);
  const statePath = path.join(settings.outputDir, "state.json");
  const previousState = readJson(statePath, { version: 1, scopes: {} });
  const storedSnapshot = previousState.scopes && previousState.scopes[scope];
  const previousSnapshot = storedSnapshot && storedSnapshot.version === 2 ? storedSnapshot : null;
  const rawRows = collected.rows.concat(channelRows);
  let rows = rawRows.map((row) => {
    if (row.status !== "unknown" || !previousSnapshot || !previousSnapshot.byKey) return row;
    const previous = previousSnapshot.byKey[snapshotKey(row)];
    if (!previous || previous.status === "unknown") return row;
    return Object.assign({}, row, {
      lastKnownStatus: previous.status,
      lastKnownLimitAmount: Number.isFinite(previous.limitAmount) ? previous.limitAmount : null,
      lastVerifiedAt: previous.queriedAt || previousSnapshot.queriedAt
    });
  });
  let officialNotices = { enabled: settings.officialNotices, checked: 0, found: 0, errors: 0 };
  let officialChannelEvidence = [];
  let pendingOfficialCache = null;
  let pendingOfficialCachePath = null;
  if (settings.officialNotices) {
    const targets = rows;
    const cachePath = path.join(settings.outputDir, "official-notice-cache.json");
    const cache = readJson(cachePath, { version: OFFICIAL_NOTICE_CACHE_VERSION, byCode: {} });
    const nowMs = new Date(queriedAt).getTime();
    const maxAgeMs = settings.officialNoticeCacheHours * 60 * 60 * 1000;
    const byCode = {};
    const missing = [];
    [...new Map(targets.map((row) => [row.code, row])).values()].forEach((fund) => {
      const cached = cache.byCode && cache.byCode[fund.code];
      const fetchedAt = cached ? new Date(cached.fetchedAt).getTime() : NaN;
      if (cache.version === OFFICIAL_NOTICE_CACHE_VERSION && Number.isFinite(fetchedAt) && nowMs - fetchedAt < maxAgeMs) byCode[fund.code] = cached.notice || null;
      else missing.push(fund);
    });
    const fetched = missing.length
      ? await (settings.officialNoticeFetcher || collectLatestOfficialNotices)(missing, { concurrency: settings.concurrency })
      : { byCode: {}, errors: [] };
    Object.assign(byCode, fetched.byCode || {});
    const noticesByShareCode = {};
    Object.values(byCode).filter(Boolean).forEach((notice) => {
      coveredShareCodes(notice).forEach((code) => {
        if (!noticesByShareCode[code]) noticesByShareCode[code] = notice;
      });
    });
    targets.forEach((fund) => {
      if (!byCode[fund.code] && noticesByShareCode[fund.code]) byCode[fund.code] = noticesByShareCode[fund.code];
    });
    const unresolvedErrors = (fetched.errors || []).filter((error) => !byCode[error.code]);
    const officialErrorsByCode = Object.fromEntries(unresolvedErrors.map((error) => [error.code, error.message]));
    missing.forEach((fund) => {
      if (Object.prototype.hasOwnProperty.call(byCode, fund.code)) {
        cache.version = OFFICIAL_NOTICE_CACHE_VERSION;
        cache.byCode[fund.code] = { fetchedAt: queriedAt, notice: byCode[fund.code] || null };
      }
    });
    if (missing.length) {
      pendingOfficialCache = cache;
      pendingOfficialCachePath = cachePath;
    }
    rows = rows.map((row) => {
      const officialNotice = byCode[row.code] || null;
      const withOfficial = Object.assign({}, row, {
        officialNotice,
        officialNoticeError: officialErrorsByCode[row.code] || null,
        officialLimit: officialNotice
          ? compareOfficialLimit(row, officialNotice.parsed, queriedAt, settings.timezone)
          : null
      });
      return applyOfficialDecision(withOfficial, withOfficial.officialLimit);
    });
    officialChannelEvidence = buildOfficialChannelEvidence(rows, queriedAt, settings.timezone);
    const notices = Object.values(byCode).filter(Boolean);
    const uniqueTargets = [...new Map(targets.map((row) => [row.code, row])).values()];
    const managerSupported = uniqueTargets.filter((fund) => managerSourceForFund(fund));
    const announcementChecked = uniqueTargets.filter((fund) => byCode[fund.code]
      && byCode[fund.code].sourceChecks
      && byCode[fund.code].sourceChecks.announcementIndex.checked);
    const announcementFound = uniqueTargets.filter((fund) => byCode[fund.code]
      && byCode[fund.code].sourceChecks
      && byCode[fund.code].sourceChecks.announcementIndex.found);
    const managerChecked = managerSupported.filter((fund) => byCode[fund.code]
      && byCode[fund.code].sourceChecks
      && byCode[fund.code].sourceChecks.managerWebsite.checked);
    const managerFound = managerSupported.filter((fund) => byCode[fund.code]
      && byCode[fund.code].sourceChecks
      && byCode[fund.code].sourceChecks.managerWebsite.found);
    officialNotices = {
      enabled: true,
      checked: Object.keys(byCode).length,
      found: notices.length,
      parsed: notices.filter((notice) => notice.parsed && notice.parsed.parsed).length,
      unparsed: notices.filter((notice) => !notice.parsed || !notice.parsed.parsed).length,
      errors: (fetched.errors || []).length,
      sources: {
        announcementIndex: fetched.sourceCoverage && fetched.sourceCoverage.announcementIndex || {
          eligible: uniqueTargets.length,
          checked: announcementChecked.length,
          found: announcementFound.length,
          errors: (fetched.errors || []).filter((error) => error.source === "announcement-index").length
        },
        managerWebsites: {
          supported: managerSupported.length,
          checked: managerChecked.length,
          found: managerFound.length,
          errors: (fetched.errors || []).filter((error) => error.source === "manager-website").length
        }
      }
    };
    if (officialNotices.errors) warnings.push(`官方公告来源出现 ${officialNotices.errors} 条失败记录；未被其他来源核验的项目保持未知。`);
    if (officialNotices.unparsed) warnings.push(`有 ${officialNotices.unparsed} 份官方公告未能可靠提取额度；对应项目明确标记为未知。`);
  }
  const officialBlockedCodes = new Set(settings.officialNotices
    ? rows.filter((row) => ["open", "limited"].includes(row.status)
      && row.decisionStatus === "unknown"
      && String(row.decisionBasis || "").startsWith("official-"))
      .map((row) => row.code)
    : []);
  const checked = collected.rows.filter((row) => row.status !== "unknown" && !officialBlockedCodes.has(row.code)).length;
  const coverage = selectedFunds.length ? checked / selectedFunds.length : 0;
  const previousSalesCodes = new Set(previousSnapshot && previousSnapshot.byKey
    ? Object.values(previousSnapshot.byKey)
      .filter((row) => row.channelBucket !== "fund-manager-direct")
      .map((row) => row.code)
    : []);
  const catalogShrunk = previousSalesCodes.size > 0 && selectedFunds.length < previousSalesCodes.size;
  let healthStatus = "degraded";
  if (!catalogShrunk && checked === selectedFunds.length && !collected.errors.length) healthStatus = "ok";
  else if (!catalogShrunk && coverage >= settings.minCoverage) healthStatus = "partial";
  const health = {
    status: healthStatus,
    checked,
    expected: selectedFunds.length,
    coverage
  };
  if (officialBlockedCodes.size) warnings.push(`有 ${officialBlockedCodes.size} 只基金因官方公告未完成核验，本次不视为数据完整。`);
  if (catalogShrunk) warnings.push(`基金目录数量由 ${previousSalesCodes.size} 减少到 ${selectedFunds.length}；本次不判断移除变化，也不更新基线。`);
  const effectiveRows = rows.map((row) => {
    let effective = row;
    if (row.status === "unknown" && previousSnapshot && previousSnapshot.byKey) {
      const previous = previousSnapshot.byKey[snapshotKey(row)];
      if (previous && previous.status !== "unknown") {
        effective = Object.assign({}, previous, { queriedAt: previous.queriedAt || previousSnapshot.queriedAt });
      }
    }
    return Object.assign({}, effective, {
      status: effective.decisionStatus || effective.status,
      limitAmount: Number.isFinite(effective.decisionLimitAmount) ? effective.decisionLimitAmount : effective.limitAmount
    });
  });
  const directSnapshotRows = officialChannelEvidence.map((row) => ({
    index: row.index,
    code: row.code,
    name: row.name,
    channel: row.channel,
    channelType: "official-direct-sale",
    channelBucket: "fund-manager-direct",
    currency: row.currency,
    accountBasis: row.accountBasis,
    status: "limited",
    limitAmount: row.amount,
    queriedAt: row.queriedAt
  }));
  const snapshot = buildSnapshot(queriedAt, effectiveRows.concat(directSnapshotRows));
  if (health.status !== "ok") warnings.push("数据不完整：本次不更新变化基线，待来源恢复后再比较。");
  const changes = health.status === "ok" ? compareSnapshots(previousSnapshot, snapshot) : [];
  const payload = {
    schemaVersion: 1,
    startedAt: queriedAt,
    completedAt: settings.completedAt || new Date().toISOString(),
    queriedAt,
    timezone: settings.timezone,
    selection: { index: settings.index, includeUsd: settings.includeUsd, includeEtf: settings.includeEtf },
    catalog: { discovered: catalog.length, selected: selectedFunds.length },
    rows,
    previousSnapshotFound: Boolean(previousSnapshot),
    changesEvaluated: health.status === "ok",
    changes,
    errors: collected.errors,
    warnings,
    officialNotices,
    officialChannelEvidence,
    display: { details: Boolean(settings.details) },
    health,
    exitCode: health.status === "ok" ? 0 : 2
  };
  if (settings.save && health.status === "ok" && pendingOfficialCache && pendingOfficialCachePath) {
    writeAtomic(pendingOfficialCachePath, `${JSON.stringify(pendingOfficialCache, null, 2)}\n`);
  }
  if (settings.save) savePayload(settings.outputDir, scope, payload, snapshot, previousState, settings.historyLimit, health.status === "ok");
  return payload;
}

module.exports = {
  OFFICIAL_NOTICE_CACHE_VERSION,
  applyOfficialDecision,
  loadChannelRows,
  readJson,
  runQuery,
  scopeKey,
  selectFunds,
  writeAtomic
};
