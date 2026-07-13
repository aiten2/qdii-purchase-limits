const https = require("node:https");
const { classifyFund, clean } = require("./core");

const CATALOG_URL = "https://fund.eastmoney.com/js/fundcode_search.js";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function validateSourceTarget(url) {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("公开数据源只允许 HTTPS");
  if (target.username || target.password) throw new Error("公开数据源地址不得包含认证信息");
  if (target.hostname !== "eastmoney.com" && !target.hostname.endsWith(".eastmoney.com")) {
    throw new Error("公开数据源域名不在允许范围");
  }
  return target;
}

function parseFundCatalog(source) {
  const match = String(source || "").match(/(?:var\s+r\s*=|window\.r\s*=)\s*(\[[\s\S]*\])\s*;?\s*$/);
  if (!match) throw new Error("基金目录格式无法识别");
  const rawRows = JSON.parse(match[1]);
  return rawRows.map(classifyFund).filter(Boolean);
}

function htmlToText(html) {
  return clean(String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">"));
}

function parseAmount(text) {
  const match = clean(text).match(/(?:单日累计(?:购买|申购)上限|申购上限|限额|限制金额)[^\d]{0,20}([\d,]+(?:\.\d+)?)\s*(万|元)/);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  return match[2] === "万" ? value * 10000 : value;
}

function inferShareClass(name) {
  const normalized = clean(name).replace(/\([^)]*\)/g, "");
  const match = normalized.match(/(?:人民币|美元现汇|美元现钞|美汇|美钞)?([A-Z])(?:类|$)/i);
  return match ? match[1].toUpperCase() : "";
}

function purchaseStatusText(status) {
  return {
    open: "开放申购",
    limited: "限额申购",
    suspended: "暂停申购",
    unavailable: "暂不开放申购",
    unknown: "状态未知"
  }[status] || "状态未知";
}

function parsePurchasePage(html, fund, queriedAt) {
  const text = htmlToText(html);
  const statusIndex = text.indexOf("交易状态");
  const segment = statusIndex >= 0 ? text.slice(statusIndex, statusIndex + 260) : text.slice(0, 500);
  let status = "unknown";
  if (/(暂不开放购买|不可购买|不支持购买)/.test(segment)) status = "unavailable";
  else if (/(暂停申购|暂停购买)/.test(segment)) status = "suspended";
  else if (/(限大额|限购|限制申购)/.test(segment)) status = "limited";
  else if (/(开放申购|开放购买)/.test(segment)) status = "open";

  let amount = status === "limited" ? parseAmount(segment) : null;
  let dataQuality = status === "unknown" ? "unverified-page-shape" : "live-public-page";
  if (status === "limited" && !Number.isFinite(amount)) {
    status = "unknown";
    amount = null;
    dataQuality = "limit-amount-missing";
  }
  return Object.assign({}, fund, {
    shareClass: inferShareClass(fund.name),
    channel: "天天基金公开销售页",
    channelType: "third-party-public-sales",
    channelBucket: "sales-agency",
    status,
    limitAmount: amount,
    statusText: purchaseStatusText(status),
    queriedAt,
    sourceUrl: `https://fund.eastmoney.com/${fund.code}.html`,
    dataQuality
  });
}

function requestText(url, options, redirects) {
  const settings = Object.assign({ timeoutMs: 20000, retries: 3, maxResponseBytes: MAX_RESPONSE_BYTES }, options);
  const redirectCount = redirects || 0;
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = validateSourceTarget(url);
    } catch (error) {
      reject(error);
      return;
    }
    const request = https.get(target, {
      timeout: settings.timeoutMs,
      headers: {
        "User-Agent": "qdii-purchase-limits (+https://github.com/aiten2/qdii-purchase-limits)",
        Referer: "https://fund.eastmoney.com/"
      }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectCount >= 5) return reject(new Error("重定向次数过多"));
        return resolve(requestText(new URL(response.headers.location, target).toString(), settings, redirectCount + 1));
      }
      let body = "";
      let receivedBytes = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        receivedBytes += Buffer.byteLength(chunk, "utf8");
        if (receivedBytes > settings.maxResponseBytes) {
          request.destroy(new Error("响应内容超过大小限制"));
          return;
        }
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) reject(new Error(`HTTP ${response.statusCode}`));
        else resolve(body);
      });
    });
    request.on("timeout", () => request.destroy(new Error("请求超时")));
    request.on("error", reject);
  });
}

async function fetchText(url, options) {
  const retries = options && Number.isInteger(options.retries) ? options.retries : 3;
  const retryBaseMs = options && Number.isFinite(options.retryBaseMs) ? options.retryBaseMs : 1000;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await requestText(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const backoff = retryBaseMs * (2 ** attempt) + Math.floor(Math.random() * 250);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }
  throw lastError;
}

async function discoverFunds(options) {
  const text = await (options && options.fetchText ? options.fetchText(CATALOG_URL) : fetchText(CATALOG_URL, options));
  return parseFundCatalog(text);
}

async function mapLimit(items, concurrency, iterator) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await iterator(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function collectFundStatuses(funds, options) {
  const queriedAt = options.queriedAt;
  const errors = [];
  const rows = await mapLimit(funds, options.concurrency || 2, async (fund) => {
    const sourceUrl = `https://fund.eastmoney.com/${fund.code}.html`;
    try {
      const html = await (options.fetchText ? options.fetchText(sourceUrl) : fetchText(sourceUrl, options));
      return parsePurchasePage(html, fund, queriedAt);
    } catch (error) {
      errors.push({ code: fund.code, sourceUrl, message: error.message });
      return Object.assign({}, fund, {
        shareClass: inferShareClass(fund.name),
        channel: "天天基金公开销售页",
        channelType: "third-party-public-sales",
        channelBucket: "sales-agency",
        status: "unknown",
        limitAmount: null,
        statusText: "数据源访问失败",
        queriedAt,
        sourceUrl,
        dataQuality: "fetch-failed"
      });
    }
  });
  return { rows, errors };
}

module.exports = {
  CATALOG_URL,
  collectFundStatuses,
  discoverFunds,
  fetchText,
  htmlToText,
  inferShareClass,
  parseAmount,
  parseFundCatalog,
  parsePurchasePage,
  purchaseStatusText,
  validateSourceTarget
};
