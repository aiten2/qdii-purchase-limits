const { htmlToText } = require("./sources");

const HUAXIA_BASE_URL = "https://fund.chinaamc.com";

function managerSourceForFund(fund) {
  const name = String(fund && fund.name || "").replace(/\s+/g, "");
  if (name.startsWith("华夏")) {
    return {
      id: "huaxia",
      name: "华夏基金官网",
      listUrl: `${HUAXIA_BASE_URL}/product/publishGgList.do?fundcode=${encodeURIComponent(fund.code)}`
    };
  }
  return null;
}

function parseHuaxiaNoticeList(html) {
  const source = String(html || "");
  const notices = [];
  const pattern = /<a[^>]+href=["']((?:\.\.\/|\/)?c\/\d{4}-\d{2}-\d{2}\/\d+\.shtml)["'][^>]*>([\s\S]*?)<\/a>[\s\S]{0,300}?(\d{4}-\d{2}-\d{2})/gi;
  let match;
  while ((match = pattern.exec(source))) {
    const title = htmlToText(match[2]);
    if (!/申购/.test(title) || !/直销/.test(title)) continue;
    notices.push({
      id: `huaxia-${match[3]}-${(match[1].match(/(\d+)\.shtml/) || [null, "unknown"])[1]}`,
      title,
      date: match[3],
      articleUrl: new URL(match[1], `${HUAXIA_BASE_URL}/product/`).toString(),
      url: new URL(match[1], `${HUAXIA_BASE_URL}/product/`).toString(),
      source: "华夏基金官网"
    });
  }
  return notices.sort((left, right) => String(right.date).localeCompare(String(left.date)));
}

function parseHuaxiaArticlePdfUrl(html) {
  const match = String(html || "").match(/href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/i);
  return match ? new URL(match[1], HUAXIA_BASE_URL).toString() : null;
}

function productKey(fund) {
  return String(fund && fund.name || "")
    .replace(/(?:人民币)?[A-Z](?:类)?(?:人民币|\(人民币\))?$/i, "")
    .replace(/\s+/g, "")
    .trim();
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

async function collectHuaxiaGroupEvents(groupFunds, options) {
  const representative = groupFunds[0];
  const source = managerSourceForFund(representative);
  const listHtml = await options.fetchText(source.listUrl);
  const notices = parseHuaxiaNoticeList(listHtml).slice(0, options.maxManagerNotices || 8);
  const requestedCodes = new Set(groupFunds.map((fund) => fund.code));
  const coveredCodes = new Set();
  const events = [];
  for (const notice of notices) {
    const articleHtml = await options.fetchText(notice.articleUrl);
    const pdfUrl = parseHuaxiaArticlePdfUrl(articleHtml);
    if (!pdfUrl) continue;
    const text = await options.extractPdfText(await options.fetchBuffer(pdfUrl));
    const parsed = repairAnnouncementDate(options.parseOfficialNoticeText(text), notice.date);
    if (!parsed || !parsed.parsed) continue;
    const directRules = (parsed.limits || []).filter((rule) => rule.scope === "specific-channel");
    if (!directRules.length) continue;
    const event = Object.assign({}, notice, { url: pdfUrl, category: "limit", parsed, source: source.name });
    events.push(event);
    directRules.forEach((rule) => Object.keys(rule.perShareLimits || {}).forEach((code) => {
      if (requestedCodes.has(code)) coveredCodes.add(code);
    }));
    if ([...requestedCodes].every((code) => coveredCodes.has(code))) break;
  }
  return events;
}

async function collectManagerSiteNoticeEvents(funds, options) {
  const settings = Object.assign({ maxManagerNotices: 8 }, options);
  const supportedFunds = (funds || []).filter((fund) => managerSourceForFund(fund));
  const groups = new Map();
  supportedFunds.forEach((fund) => {
    const key = `${managerSourceForFund(fund).id}|${productKey(fund)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fund);
  });
  const byCode = {};
  const errors = [];
  const checkedCodes = new Set();
  for (const groupFunds of groups.values()) {
    try {
      const events = await collectHuaxiaGroupEvents(groupFunds, settings);
      groupFunds.forEach((fund) => {
        checkedCodes.add(fund.code);
        const matching = events.filter((event) => (event.parsed.shareCodes || []).includes(fund.code));
        if (matching.length) byCode[fund.code] = matching;
      });
    } catch (error) {
      groupFunds.forEach((fund) => errors.push({ code: fund.code, source: "manager-website", message: error.message }));
    }
  }
  return {
    byCode,
    errors,
    checkedCodes: [...checkedCodes],
    coverage: {
      supported: supportedFunds.length,
      checked: checkedCodes.size,
      found: Object.keys(byCode).length,
      errors: errors.length
    }
  };
}

module.exports = {
  collectManagerSiteNoticeEvents,
  managerSourceForFund,
  parseHuaxiaArticlePdfUrl,
  parseHuaxiaNoticeList,
  repairAnnouncementDate
};
