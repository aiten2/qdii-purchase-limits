const https = require("node:https");

const ANNOUNCEMENT_API_URL = "https://api.fund.eastmoney.com/f10/JJGG";
const ANNOUNCEMENT_PDF_BASE_URL = "https://pdf.dfcfw.com/pdf";

function buildAnnouncementApiUrl(code) {
  const url = new URL(ANNOUNCEMENT_API_URL);
  url.searchParams.set("fundcode", String(code || ""));
  url.searchParams.set("pageIndex", "1");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("type", "5");
  return url.toString();
}

function buildAnnouncementPdfUrl(id) {
  const value = String(id || "");
  if (!/^AN\d{18}$/.test(value)) throw new Error("公告 ID 无效");
  return `${ANNOUNCEMENT_PDF_BASE_URL}/H2_${value}_1.pdf`;
}

function classifyPurchaseTitle(title) {
  const source = String(title || "").replace(/\s+/g, "");
  if (/节假日|境外主要(?:市场|交易市场|投资场所).*(?:暂停|休市)/.test(source)) return "holiday-calendar";
  if (/恢复申购/.test(source) && !/大额申购|限额|限制金额/.test(source)) return "resume";
  if (/暂停申购/.test(source) && !/暂停大额申购/.test(source)) return "full-suspend";
  if (/大额申购|暂停大额|恢复大额|限制金额|业务限额|申购.*(?:金额|限制|上限)/.test(source)) return "limit";
  return "other";
}

function parseAnnouncementIndex(source, options) {
  let payload;
  try {
    payload = JSON.parse(String(source || ""));
  } catch {
    throw new Error("公开公告索引响应无法识别");
  }
  if (payload.ErrCode !== 0 || !Array.isArray(payload.Data)) throw new Error("公开公告索引查询失败");
  const classify = options && options.classifyNoticeTitle || classifyPurchaseTitle;
  return payload.Data.flatMap((row) => {
    if (String(row.NEWCATEGORY || "") !== "5") return [];
    const category = classify(row.TITLE);
    if (!["limit", "full-suspend", "resume"].includes(category)) return [];
    try {
      return [{
        id: String(row.ID || ""),
        title: String(row.TITLE || "").trim(),
        date: String(row.PUBLISHDATEDesc || row.PUBLISHDATE || "").slice(0, 10),
        url: buildAnnouncementPdfUrl(row.ID),
        category,
        source: "公开公告索引"
      }];
    } catch {
      return [];
    }
  }).sort((left, right) => String(right.date).localeCompare(String(left.date)) || String(right.id).localeCompare(String(left.id)));
}

function fetchAnnouncementText(url, options) {
  const settings = Object.assign({ timeoutMs: 20000 }, options);
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      timeout: settings.timeoutMs,
      headers: {
        Referer: "https://fundf10.eastmoney.com/",
        "User-Agent": "qdii-purchase-limits (+https://github.com/aiten2/qdii-purchase-limits)"
      }
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(body);
        else reject(new Error(`公开公告索引 HTTP ${response.statusCode}`));
      });
    });
    request.on("timeout", () => request.destroy(new Error("公开公告索引请求超时")));
    request.on("error", reject);
  });
}

function productKey(fund) {
  return `${fund && fund.index || ""}|${String(fund && fund.name || "")
    .replace(/(?:人民币)?[A-Z](?:类)?(?:人民币|\(人民币\))?$/i, "")
    .replace(/\s+/g, "")
    .trim()}`;
}

function coveredCodes(parsed) {
  return new Set((parsed && parsed.limits || []).flatMap((rule) => [
    ...Object.keys(rule.perShareLimits || {}),
    ...Object.keys(rule.perShareStatuses || {})
  ]));
}

function eventCoveredCodes(event) {
  const codes = coveredCodes(event && event.parsed);
  if (["full-suspend", "resume"].includes(event && event.category)) {
    (event.parsed && event.parsed.shareCodes || []).forEach((code) => codes.add(code));
  }
  return codes;
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

async function collectAnnouncementIndexNoticeEvents(funds, options) {
  const settings = Object.assign({ maxNotices: 30 }, options);
  const unique = [...new Map((funds || []).map((fund) => [fund.code, fund])).values()];
  const groups = new Map();
  unique.forEach((fund) => {
    const key = productKey(fund);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fund);
  });
  const byCode = {};
  const errors = [];
  const checkedCodes = new Set();
  for (const groupFunds of groups.values()) {
    try {
      const representative = groupFunds[0];
      const source = await (settings.fetchText || fetchAnnouncementText)(buildAnnouncementApiUrl(representative.code), settings);
      groupFunds.forEach((fund) => checkedCodes.add(fund.code));
      const notices = parseAnnouncementIndex(source, settings).slice(0, settings.maxNotices);
      const directNotices = notices.filter((notice) => /直销|电子交易平台|网上交易/.test(notice.title));
      const generalNotices = notices.filter((notice) => !directNotices.includes(notice));
      const orderedNotices = directNotices.concat(generalNotices);
      const requestedCodes = new Set(groupFunds.map((fund) => fund.code));
      const foundCodes = new Set();
      const events = [];
      for (const notice of orderedNotices) {
        try {
          const buffer = await settings.fetchBuffer(notice.url, settings);
          const text = await settings.extractPdfText(buffer);
          const parsed = repairAnnouncementDate(settings.parseOfficialNoticeText(text), notice.date);
          const statusOnlyEvent = ["full-suspend", "resume"].includes(notice.category)
            && (parsed && parsed.shareCodes || []).length > 0;
          if (!parsed || (!parsed.parsed && !statusOnlyEvent)) continue;
          const event = Object.assign({}, notice, { parsed });
          events.push(event);
          eventCoveredCodes(event).forEach((code) => {
            if (requestedCodes.has(code)) foundCodes.add(code);
          });
          const isDirectCandidate = directNotices.includes(notice);
          if (!isDirectCandidate && [...requestedCodes].every((code) => foundCodes.has(code))) break;
        } catch {
          // A bad mirror entry must not prevent searching older applicable notices.
        }
      }
      groupFunds.forEach((fund) => {
        const matching = events.filter((event) => eventCoveredCodes(event).has(fund.code));
        if (matching.length) byCode[fund.code] = matching;
      });
    } catch (error) {
      groupFunds.forEach((fund) => errors.push({ code: fund.code, source: "announcement-index", message: error.message }));
    }
  }
  return {
    byCode,
    errors,
    checkedCodes: [...checkedCodes],
    coverage: {
      eligible: unique.length,
      checked: checkedCodes.size,
      found: Object.keys(byCode).length,
      errors: errors.length
    }
  };
}

module.exports = {
  ANNOUNCEMENT_API_URL,
  buildAnnouncementApiUrl,
  buildAnnouncementPdfUrl,
  collectAnnouncementIndexNoticeEvents,
  fetchAnnouncementText,
  eventCoveredCodes,
  parseAnnouncementIndex,
  productKey,
  repairAnnouncementDate
};
