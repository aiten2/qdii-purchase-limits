const https = require("node:https");
const { fetchText: fetchPublicText } = require("./sources");
const { extractPdfText, parseOfficialNoticeText } = require("./official-pdf");
const { collectManagerSiteNoticeEvents, managerSourceForFund } = require("./manager-notices");
const { collectAnnouncementIndexNoticeEvents } = require("./announcement-index");

function requestBuffer(url, settings, redirectCount) {
  const redirects = redirectCount || 0;
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (target.protocol !== "https:") {
      reject(new Error("官方公告 PDF 只允许 HTTPS 来源"));
      return;
    }
    const request = https.get(target, {
      timeout: settings.timeoutMs,
      headers: { "User-Agent": "qdii-purchase-limits (+https://github.com/aiten2/qdii-purchase-limits)" }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 3) {
          reject(new Error("官方公告 PDF 重定向次数过多"));
          return;
        }
        const redirectUrl = new URL(response.headers.location, target).toString();
        assertRedirectAllowed(target.toString(), redirectUrl);
        resolve(requestBuffer(redirectUrl, settings, redirects + 1));
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`官方公告 PDF HTTP ${response.statusCode}`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > settings.maxPdfBytes) request.destroy(new Error("官方公告 PDF 超过大小限制"));
        else chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
    });
    request.on("timeout", () => request.destroy(new Error("官方公告 PDF 请求超时")));
    request.on("error", reject);
  });
}

function isRetryablePdfError(error) {
  const message = String(error && error.message || "");
  return /HTTP (?:429|5\d\d)|请求超时|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up/i.test(message);
}

async function getBuffer(url, options) {
  const settings = Object.assign({
    timeoutMs: 20000,
    maxPdfBytes: 8 * 1024 * 1024,
    retries: 2,
    retryBaseMs: 500
  }, options);
  const request = settings.requestBuffer || requestBuffer;
  let lastError;
  for (let attempt = 0; attempt <= settings.retries; attempt += 1) {
    try {
      return await request(url, settings, 0);
    } catch (error) {
      lastError = error;
      if (attempt >= settings.retries || !isRetryablePdfError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, settings.retryBaseMs * (attempt + 1)));
    }
  }
  throw lastError;
}

function assertRedirectAllowed(fromUrl, toUrl) {
  const from = new URL(fromUrl);
  const to = new URL(toUrl);
  if (from.protocol === "https:" && to.protocol !== "https:") {
    throw new Error("官方公告 PDF 不安全重定向");
  }
}

function findLatestPurchaseNotice(notices) {
  const sorted = (notices || []).slice().sort((left, right) => {
    const byDate = String(right.date || "").localeCompare(String(left.date || ""));
    return byDate || String(right.id || "").localeCompare(String(left.id || ""));
  });
  return sorted.find((notice) => classifyNoticeTitle(notice.title) === "limit")
    || sorted.find((notice) => !["holiday-calendar", "other"].includes(classifyNoticeTitle(notice.title)))
    || null;
}

function classifyNoticeTitle(title) {
  const source = String(title || "").replace(/\s+/g, "");
  if (/节假日|境外主要(?:市场|交易市场|投资场所).*(?:暂停|休市)/.test(source)) return "holiday-calendar";
  if (/\d{4}年\d{1,2}月\d{1,2}日.*暂停(?:申购|赎回)/.test(source)) return "holiday-calendar";
  if (/恢复申购/.test(source) && /大额申购|限额|限制金额/.test(source)) return "limit";
  if (/恢复申购/.test(source)) return "resume";
  if (/暂停申购/.test(source) && !/暂停大额申购/.test(source)) return "full-suspend";
  if (/大额申购|暂停大额|恢复大额|限制金额|业务限额|申购.*(?:金额|限制|上限)/.test(source)) return "limit";
  return "other";
}

function buildOfficialTimelineNotice(events) {
  const sorted = (events || []).slice().sort((left, right) => {
    const leftDate = left.parsed && left.parsed.effectiveDate || left.date || "";
    const rightDate = right.parsed && right.parsed.effectiveDate || right.date || "";
    const byDate = String(rightDate).localeCompare(String(leftDate));
    return byDate || String(right.id || "").localeCompare(String(left.id || ""));
  });
  const limits = [];
  sorted.forEach((event) => {
    if (!event.parsed) return;
    if (["full-suspend", "resume"].includes(event.category)) {
      const status = event.category === "full-suspend" ? "suspended" : "open";
      const rule = { scope: event.parsed.scope || "fund-manager-general", channels: event.parsed.channels || [] };
      const perShareStatuses = {};
      (event.parsed.shareCodes || []).forEach((code) => {
        perShareStatuses[code] = status;
      });
      if (Object.keys(perShareStatuses).length) {
        limits.push(Object.assign(rule, {
          status,
          perShareStatuses,
          perShareLimits: {},
          effectiveDate: event.parsed.effectiveDate || event.date,
          noticeId: event.id,
          noticeDate: event.date,
          noticeTitle: event.title,
          noticeUrl: event.url
        }));
      }
      return;
    }
    if (!event.parsed.parsed) return;
    (event.parsed.limits || []).forEach((rule) => {
      const perShareLimits = Object.assign({}, rule.perShareLimits || {});
      if (!Object.keys(perShareLimits).length) return;
      limits.push(Object.assign({}, rule, {
        perShareLimits,
        accountBasis: event.parsed.accountBasis || "unknown",
        effectiveDate: event.parsed.effectiveDate,
        noticeId: event.id,
        noticeDate: event.date,
        noticeTitle: event.title,
        noticeUrl: event.url
      }));
    });
  });
  const top = sorted[0] || null;
  if (!top) return null;
  const perShareLimits = {};
  limits.forEach((rule) => {
    Object.entries(rule.perShareLimits).forEach(([code, amount]) => {
      if (!perShareLimits[code]) perShareLimits[code] = amount;
    });
  });
  const scopes = [...new Set(limits.map((rule) => rule.scope))];
  const parseWarnings = sorted.flatMap((event) => event.parsed && event.parsed.parseWarnings || []);
  return Object.assign({}, top, {
    title: top.title,
    timeline: sorted.map((event) => ({
      id: event.id,
      date: event.date,
      title: event.title,
      url: event.url,
      category: event.category,
      parsed: Boolean(event.parsed && event.parsed.parsed)
    })),
    events: sorted,
    parsed: {
      parsed: limits.length > 0,
      announcementDate: top.parsed && top.parsed.announcementDate || top.date,
      effectiveDate: top.parsed && top.parsed.effectiveDate || top.date,
      scope: scopes.length > 1 ? "multi-event" : (scopes[0] || "unknown"),
      channels: [],
      shareCodes: [...new Set(limits.flatMap((rule) => [
        ...Object.keys(rule.perShareLimits || {}),
        ...Object.keys(rule.perShareStatuses || {})
      ]))],
      perShareLimits,
      limits,
      accountBasis: "timeline",
      confidence: limits.length ? "high" : "low",
      parseWarnings: limits.length ? [] : (parseWarnings.length ? parseWarnings : ["公告时间线中未找到可确认的限购额度"])
    }
  });
}

function mergeOfficialNoticeEvents(baseNotice, supplementalEvents) {
  const baseEvents = baseNotice && Array.isArray(baseNotice.events) ? baseNotice.events : [];
  const combined = [...baseEvents, ...(supplementalEvents || [])];
  const uniqueEvents = new Map();
  combined.forEach((event) => {
    const normalizedTitle = String(event.title || "").replace(/[\s（）()]/g, "");
    const key = normalizedTitle ? `${event.date || ""}|${normalizedTitle}` : (event.url || String(event.id || ""));
    if (!uniqueEvents.has(key)) uniqueEvents.set(key, event);
  });
  return buildOfficialTimelineNotice([...uniqueEvents.values()]);
}

function hasDirectRuleForCode(notice, code) {
  return Boolean(notice && notice.parsed && (notice.parsed.limits || []).some((rule) => (
    rule.scope === "specific-channel"
    && (rule.channels || []).some((channel) => /直销/.test(channel))
    && (rule.perShareLimits && rule.perShareLimits[code]
      || rule.perShareStatuses && rule.perShareStatuses[code])
  )));
}

function selectManagerFallbackFunds(funds, timelinesByCode) {
  return (funds || []).filter((fund) => managerSourceForFund(fund)
    && !hasDirectRuleForCode(timelinesByCode && timelinesByCode[fund.code], fund.code));
}

async function collectLatestOfficialNotices(funds, options) {
  const settings = Object.assign({}, options);
  const unique = [...new Map((funds || []).map((fund) => [fund.code, fund])).values()];
  const byCode = {};
  const announcementFetcher = settings.announcementIndexFetcher || collectAnnouncementIndexNoticeEvents;
  const announcementResult = await announcementFetcher(unique, {
    fetchText: settings.fetchAnnouncementText,
    fetchBuffer: settings.fetchBuffer || getBuffer,
    extractPdfText: settings.extractPdfText || extractPdfText,
    parseOfficialNoticeText,
    classifyNoticeTitle,
    concurrency: settings.concurrency,
    maxNotices: settings.maxAnnouncementNotices
  });
  const withAnnouncementByCode = {};
  unique.forEach((fund) => {
    const announcementEvents = announcementResult.byCode && announcementResult.byCode[fund.code] || [];
    withAnnouncementByCode[fund.code] = announcementEvents.length
      ? mergeOfficialNoticeEvents(null, announcementEvents)
      : null;
  });
  const managerSupportedFunds = unique.filter((fund) => managerSourceForFund(fund));
  const managerFallbackFunds = selectManagerFallbackFunds(managerSupportedFunds, withAnnouncementByCode);
  const managerFetcher = settings.managerNoticeFetcher || collectManagerSiteNoticeEvents;
  const managerResult = managerFallbackFunds.length
    ? await managerFetcher(managerFallbackFunds, {
      fetchText: settings.fetchManagerText || fetchPublicText,
      fetchBuffer: settings.fetchBuffer || getBuffer,
      extractPdfText: settings.extractPdfText || extractPdfText,
      parseOfficialNoticeText,
      maxManagerNotices: settings.maxManagerNotices
    })
    : { byCode: {}, errors: [], checkedCodes: [], coverage: { supported: 0, checked: 0, found: 0, errors: 0 } };
  const managerCoverage = Object.assign({}, managerResult.coverage, { supported: managerSupportedFunds.length });
  const checkedManagerCodes = new Set(managerResult.checkedCodes || []);
  const checkedAnnouncementCodes = new Set(announcementResult.checkedCodes || []);
  unique.forEach((fund) => {
    const announcementEvents = announcementResult.byCode && announcementResult.byCode[fund.code] || [];
    const managerEvents = managerResult.byCode && managerResult.byCode[fund.code] || [];
    const withAnnouncement = withAnnouncementByCode[fund.code] || null;
    const merged = managerEvents.length ? mergeOfficialNoticeEvents(withAnnouncement, managerEvents) : withAnnouncement;
    if (!merged) return;
    byCode[fund.code] = Object.assign({}, merged, {
      sourceChecks: {
        announcementIndex: {
          checked: checkedAnnouncementCodes.has(fund.code),
          found: announcementEvents.length > 0
        },
        managerWebsite: {
          supported: Boolean(managerSourceForFund(fund)),
          checked: checkedManagerCodes.has(fund.code),
          found: managerEvents.length > 0
        }
      }
    });
  });
  return {
    byCode,
    errors: [...(announcementResult.errors || []), ...(managerResult.errors || [])],
    sourceCoverage: {
      announcementIndex: announcementResult.coverage || { eligible: unique.length, checked: 0, found: 0, errors: 0 },
      managerWebsites: managerCoverage
    }
  };
}

module.exports = {
  assertRedirectAllowed,
  buildOfficialTimelineNotice,
  classifyNoticeTitle,
  collectLatestOfficialNotices,
  findLatestPurchaseNotice,
  getBuffer,
  mergeOfficialNoticeEvents,
  selectManagerFallbackFunds
};
