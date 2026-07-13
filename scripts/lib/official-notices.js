const http = require("node:http");
const https = require("node:https");
const { htmlToText, fetchText: fetchPublicText } = require("./sources");
const { extractPdfText, parseOfficialNoticeText } = require("./official-pdf");
const { collectManagerSiteNoticeEvents, managerSourceForFund } = require("./manager-notices");
const { collectAnnouncementIndexNoticeEvents } = require("./announcement-index");

const EID_BASE_URL = "http://eid.csrc.gov.cn";

function postForm(url, fields, options) {
  const settings = Object.assign({ timeoutMs: 20000 }, options);
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = new URLSearchParams(fields).toString();
    const request = http.request(target, {
      method: "POST",
      timeout: settings.timeoutMs,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "qdii-purchase-limits (+https://github.com/aiten2/qdii-purchase-limits)"
      }
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(responseBody);
        else reject(new Error(`官方披露平台 HTTP ${response.statusCode}`));
      });
    });
    request.on("timeout", () => request.destroy(new Error("官方披露平台请求超时")));
    request.on("error", reject);
    request.end(body);
  });
}

function getText(url, options) {
  const settings = Object.assign({ timeoutMs: 20000 }, options);
  return new Promise((resolve, reject) => {
    const request = http.get(new URL(url), {
      timeout: settings.timeoutMs,
      headers: { "User-Agent": "qdii-purchase-limits (+https://github.com/aiten2/qdii-purchase-limits)" }
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(body);
        else reject(new Error(`官方披露平台 HTTP ${response.statusCode}`));
      });
    });
    request.on("timeout", () => request.destroy(new Error("官方披露平台请求超时")));
    request.on("error", reject);
  });
}

function getBuffer(url, options, redirectCount) {
  const settings = Object.assign({ timeoutMs: 20000, maxPdfBytes: 8 * 1024 * 1024 }, options);
  const redirects = redirectCount || 0;
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;
    const request = client.get(target, {
      timeout: settings.timeoutMs,
      headers: { "User-Agent": "qdii-purchase-limits (+https://github.com/aiten2/qdii-purchase-limits)" }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 3) {
          reject(new Error("官方公告 PDF 重定向次数过多"));
          return;
        }
        resolve(getBuffer(new URL(response.headers.location, target).toString(), settings, redirects + 1));
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

function failedPdfParse(message) {
  return {
    parsed: false,
    announcementDate: null,
    effectiveDate: null,
    scope: "unknown",
    channels: [],
    perShareLimits: {},
    accountBasis: "unknown",
    confidence: "low",
    parseWarnings: [`官方公告 PDF 未能可靠解析：${message}`]
  };
}

function repairAnnouncementDate(parsed, date) {
  if (!parsed || parsed.announcementDate || !date) return parsed;
  const warnings = (parsed.parseWarnings || []).filter((warning) => warning !== "未可靠提取公告日期");
  return Object.assign({}, parsed, {
    announcementDate: date,
    parsed: warnings.length === 0 && (parsed.limits || []).length > 0,
    confidence: warnings.length ? "low" : "high",
    parseWarnings: warnings
  });
}

function parseFundValidation(source) {
  let data;
  try {
    data = JSON.parse(String(source || ""));
  } catch {
    throw new Error("官方披露平台基金校验响应无法识别");
  }
  if (!data.isSuccess || data.fundId == null) throw new Error("官方披露平台未找到基金");
  return String(data.fundId);
}

function parseTemporaryNotices(html) {
  const source = String(html || "");
  const start = source.search(/<a\s+name=["']section5["']/i);
  if (start < 0) return [];
  const remainder = source.slice(start);
  const end = remainder.search(/<a\s+name=["']section7["']/i);
  const section = end >= 0 ? remainder.slice(0, end) : remainder;
  const notices = [];
  const pattern = /href=["'][^"']*instance_show_pdf_id\.do\?instanceid=(\d+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<td[^>]*>\s*(\d{4}-\d{2}-\d{2})\s*<\/td>/gi;
  let match;
  while ((match = pattern.exec(section))) {
    notices.push({
      id: match[1],
      title: htmlToText(match[2]),
      date: match[3],
      url: `${EID_BASE_URL}/fund/disclose/instance_show_pdf_id.do?instanceid=${match[1]}`,
      source: "中国证监会资本市场统一信息披露平台"
    });
  }
  return notices;
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

async function parseNoticePdf(notice, settings) {
  try {
    const pdfCache = settings.pdfCache;
    let parsePromise = pdfCache && pdfCache.get(notice.url);
    if (!parsePromise) {
      parsePromise = (async () => {
        const buffer = await (settings.fetchBuffer || getBuffer)(notice.url, settings);
        const text = await (settings.extractPdfText || extractPdfText)(buffer);
        return parseOfficialNoticeText(text);
      })();
      if (pdfCache) pdfCache.set(notice.url, parsePromise);
    }
    return Object.assign({}, notice, {
      category: classifyNoticeTitle(notice.title),
      parsed: repairAnnouncementDate(await parsePromise, notice.date)
    });
  } catch (error) {
    return Object.assign({}, notice, { category: classifyNoticeTitle(notice.title), parsed: failedPdfParse(error.message) });
  }
}

function hasNonDirectRule(timeline, code) {
  if (!timeline || !timeline.parsed) return false;
  const rules = (timeline.parsed.limits || [])
    .filter((rule) => rule.scope !== "specific-channel" && (
      rule.perShareLimits && rule.perShareLimits[code]
      || rule.perShareStatuses && rule.perShareStatuses[code]
    ));
  let resumed = false;
  for (const rule of rules) {
    const status = rule.perShareStatuses && rule.perShareStatuses[code];
    if (status === "open") {
      resumed = true;
      continue;
    }
    if (status === "suspended") {
      if (resumed) continue;
      return true;
    }
    if (rule.perShareLimits && rule.perShareLimits[code]) return true;
  }
  return false;
}

async function fetchOfficialTimelineForFundId(fundId, requestedCodes, options) {
  const settings = Object.assign({}, options);
  const detailUrl = `${EID_BASE_URL}/fund/disclose/fund_detail_search.do?cFundCode=${encodeURIComponent(fundId)}`;
  const html = await (settings.fetchText || getText)(detailUrl, settings);
  const candidates = parseTemporaryNotices(html)
    .map((notice) => Object.assign({}, notice, { category: classifyNoticeTitle(notice.title) }))
    .filter((notice) => ["limit", "full-suspend", "resume"].includes(notice.category))
    .sort((left, right) => String(right.date).localeCompare(String(left.date)) || String(right.id).localeCompare(String(left.id)));
  const events = [];
  const timelineCandidates = Number.isInteger(settings.maxTimelineNotices)
    ? candidates.slice(0, settings.maxTimelineNotices)
    : candidates;
  for (const notice of timelineCandidates) {
    events.push(await parseNoticePdf(notice, settings));
    const timeline = buildOfficialTimelineNotice(events);
    if ((requestedCodes || []).length && requestedCodes.every((code) => hasNonDirectRule(timeline, code))) break;
  }
  return buildOfficialTimelineNotice(events);
}

function productKey(fund) {
  const name = String(fund && fund.name || "")
    .replace(/(?:人民币)?[A-Z](?:类)?(?:人民币|\(人民币\))?$/i, "")
    .replace(/\s+/g, "")
    .trim();
  return `${fund && fund.index || ""}|${name}`;
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

async function fetchLatestOfficialNotice(code, options) {
  const settings = options || {};
  const validationText = await (settings.postForm || postForm)(
    `${EID_BASE_URL}/fund/disclose/validate_fund.do`,
    { cFundCode: code },
    settings
  );
  const fundId = parseFundValidation(validationText);
  return fetchOfficialTimelineForFundId(fundId, [code], settings);
}

async function collectLatestOfficialNotices(funds, options) {
  const settings = Object.assign({ concurrency: 2 }, options);
  settings.pdfCache = settings.pdfCache || new Map();
  const unique = [...new Map((funds || []).map((fund) => [fund.code, fund])).values()];
  const byCode = {};
  const errors = [];
  const validationFailures = [];
  const validated = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(settings.concurrency, unique.length)) }, async () => {
    while (nextIndex < unique.length) {
      const fund = unique[nextIndex];
      nextIndex += 1;
      try {
        const validationText = await (settings.postForm || postForm)(
          `${EID_BASE_URL}/fund/disclose/validate_fund.do`,
          { cFundCode: fund.code },
          settings
        );
        validated.push({ fund, fundId: parseFundValidation(validationText) });
      } catch (error) {
        validationFailures.push({ fund, message: error.message });
      }
    }
  });
  await Promise.all(workers);
  const groups = new Map();
  validated.forEach((item) => {
    if (!groups.has(item.fundId)) groups.set(item.fundId, []);
    groups.get(item.fundId).push(item.fund);
  });
  const groupByProduct = new Map();
  groups.forEach((groupFunds, fundId) => {
    groupFunds.forEach((fund) => {
      const key = productKey(fund);
      if (!groupByProduct.has(key)) groupByProduct.set(key, fundId);
    });
  });
  const aliasesByFundId = new Map();
  validationFailures.forEach((failure) => {
    const fundId = groupByProduct.get(productKey(failure.fund));
    if (!fundId) return;
    if (!aliasesByFundId.has(fundId)) aliasesByFundId.set(fundId, []);
    aliasesByFundId.get(fundId).push(failure.fund);
  });
  const grouped = [...groups.entries()];
  nextIndex = 0;
  const timelineWorkers = Array.from({ length: Math.max(1, Math.min(settings.concurrency, grouped.length)) }, async () => {
    while (nextIndex < grouped.length) {
      const [fundId, groupFunds] = grouped[nextIndex];
      nextIndex += 1;
      try {
        const aliasFunds = aliasesByFundId.get(fundId) || [];
        const requestedFunds = groupFunds.concat(aliasFunds);
        const notice = await fetchOfficialTimelineForFundId(fundId, requestedFunds.map((fund) => fund.code), settings);
        groupFunds.forEach((fund) => { byCode[fund.code] = notice; });
        const coveredCodes = new Set(notice && notice.parsed && notice.parsed.shareCodes || []);
        aliasFunds.filter((fund) => coveredCodes.has(fund.code)).forEach((fund) => { byCode[fund.code] = notice; });
      } catch (error) {
        groupFunds.forEach((fund) => errors.push({ code: fund.code, message: error.message }));
      }
    }
  });
  await Promise.all(timelineWorkers);
  validationFailures.forEach((failure) => {
    if (!byCode[failure.fund.code]) errors.push({ code: failure.fund.code, message: failure.message });
  });
  const announcementFetcher = settings.announcementIndexFetcher || collectAnnouncementIndexNoticeEvents;
  const announcementResult = await announcementFetcher(unique, {
    fetchText: settings.fetchAnnouncementText,
    fetchBuffer: settings.fetchBuffer || getBuffer,
    extractPdfText: settings.extractPdfText || extractPdfText,
    parseOfficialNoticeText,
    classifyNoticeTitle,
    maxNotices: settings.maxAnnouncementNotices
  });
  const withAnnouncementByCode = {};
  unique.forEach((fund) => {
    const baseNotice = byCode[fund.code] || null;
    const announcementEvents = announcementResult.byCode && announcementResult.byCode[fund.code] || [];
    withAnnouncementByCode[fund.code] = announcementEvents.length
      ? mergeOfficialNoticeEvents(baseNotice, announcementEvents)
      : baseNotice;
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
    const baseNotice = byCode[fund.code] || null;
    const announcementEvents = announcementResult.byCode && announcementResult.byCode[fund.code] || [];
    const managerEvents = managerResult.byCode && managerResult.byCode[fund.code] || [];
    const withAnnouncement = withAnnouncementByCode[fund.code] || null;
    const merged = managerEvents.length ? mergeOfficialNoticeEvents(withAnnouncement, managerEvents) : withAnnouncement;
    if (!merged) return;
    byCode[fund.code] = Object.assign({}, merged, {
      sourceChecks: {
        unifiedDisclosure: { checked: true, found: Boolean(baseNotice) },
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
    errors: errors.concat(announcementResult.errors || [], managerResult.errors || []),
    sourceCoverage: {
      unifiedDisclosure: {
        checked: unique.length,
        found: unique.filter((fund) => byCode[fund.code] && byCode[fund.code].sourceChecks && byCode[fund.code].sourceChecks.unifiedDisclosure.found).length,
        errors: errors.length
      },
      announcementIndex: announcementResult.coverage || { eligible: unique.length, checked: 0, found: 0, errors: 0 },
      managerWebsites: managerCoverage
    }
  };
}

module.exports = {
  EID_BASE_URL,
  buildOfficialTimelineNotice,
  classifyNoticeTitle,
  collectLatestOfficialNotices,
  fetchLatestOfficialNotice,
  findLatestPurchaseNotice,
  getText,
  getBuffer,
  mergeOfficialNoticeEvents,
  fetchOfficialTimelineForFundId,
  parseFundValidation,
  parseTemporaryNotices,
  productKey,
  repairAnnouncementDate,
  selectManagerFallbackFunds,
  postForm
};
