function normalizeText(value) {
  let text = String(value || "").replace(/\u00a0/g, " ");
  for (let pass = 0; pass < 4; pass += 1) {
    text = text.replace(/([\u3400-\u9fff）)])\s+([\u3400-\u9fff（(])/g, "$1$2");
  }
  return text
    .replace(/\s*([：:，,。；;、（）()])\s*/g, "$1")
    .replace(/(\d)\s*(\d)\s*(\d)\s*(\d)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g, "$1$2$3$4年$5月$6日")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function compactText(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function firstChineseDate(text, prefixes) {
  const source = compactText(text);
  for (const prefix of prefixes) {
    const pattern = new RegExp(`${prefix}[:：]?(\\d{4})年(\\d{1,2})月(\\d{1,2})日`);
    const match = source.match(pattern);
    if (match) return isoDate(match[1], match[2], match[3]);
  }
  return null;
}

function parseAmount(numberText, unitText) {
  const value = Number(String(numberText).replace(/,/g, ""));
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = String(unitText || "");
  return {
    amount: unit.includes("万") ? value * 10000 : value,
    currency: unit.includes("美元") ? "USD" : "CNY"
  };
}

function unique(values) {
  return [...new Set(values)];
}

function extractCodes(text) {
  return unique(normalizeText(text).match(/(?<!\d)\d{6}(?!\d)/g) || []);
}

function extractTransactionCodes(text) {
  const source = normalizeText(text);
  const block = source.match(/下属(?:分级基金|基金份额)的(?:交易)?代码([\s\S]{0,500}?)(?:该(?:分级基金|基金份额)是否|该基金份额的限制金额|下属(?:分级基金|基金份额)的限制申购)/);
  if (block) {
    const digits = block[1].replace(/\D/g, "");
    if (digits.length >= 6 && digits.length % 6 === 0) return unique(digits.match(/.{6}/g));
    return extractCodes(block[1]);
  }
  const splitLabelBlock = source.match(/下属基金份\s+((?:\d{6}\s+){1,20}\d{6})\s*额的交易代码/);
  return splitLabelBlock ? extractCodes(splitLabelBlock[1]) : [];
}

function classifyCodeShares(text, codes) {
  const source = compactText(text);
  const result = Object.fromEntries(codes.map((code) => [code, { currency: "CNY", shareClass: null }]));
  const namesBlock = source.match(/下属(?:分级基金|基金份额)的(?:基金)?简称(.*?)(?:下属(?:分级基金|基金份额)的(?:交易)?代码|下属基金份(?:\d{6}){2,20}额的交易代码)/);
  if (!namesBlock) return result;
  const currency = "美元现钞|美元现汇|人民币|美元|美钞|美汇";
  const labels = namesBlock[1].match(new RegExp(`(?:[A-Z](?:[（(])?(?:${currency})(?:[）)])?|(?:${currency})(?:[（(])?[A-Z](?:[）)])?|美元现钞|美元现汇|美钞|美汇)`, "g")) || [];
  if (labels.length === codes.length) {
    labels.forEach((label, index) => {
      result[codes[index]] = {
        currency: /美元|美钞|美汇/.test(label) ? "USD" : "CNY",
        shareClass: (label.match(/[A-Z]/) || [null])[0]
      };
    });
    return result;
  }
  const classes = [...namesBlock[1].matchAll(/QDII[）)]?([A-Z])/g)].map((match) => match[1]);
  if (classes.length === codes.length) {
    classes.forEach((shareClass, index) => { result[codes[index]].shareClass = shareClass; });
  }
  return result;
}

function targetClasses(text, currency) {
  const source = compactText(text);
  const patterns = currency === "USD"
    ? [/(?:美元现钞|美元现汇|美钞|美汇)([A-Z])/g, /([A-Z])(?:美元现钞|美元现汇|美钞|美汇)/g]
    : [/人民币([A-Z])/g, /([A-Z])人民币/g, /([A-Z])类/g, /([A-Z](?:、[A-Z])+)(?:类)?份额/g];
  const classes = [];
  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(source))) classes.push(...match[1].split("、"));
  });
  return unique(classes);
}

function effectiveDateFromText(text, announcementDate) {
  const source = compactText(text);
  const dates = [];
  const pattern = /(?:自)?(\d{4})年(\d{1,2})月(\d{1,2})日起/g;
  let match;
  while ((match = pattern.exec(source))) dates.push(isoDate(match[1], match[2], match[3]));
  const current = dates.filter((date) => !announcementDate || date >= announcementDate).sort();
  return current[0]
    || firstChineseDate(text, ["暂停大额申购起始日", "暂停相关业务的起始日"])
    || announcementDate;
}

function amountCandidates(text, currency) {
  const source = compactText(text);
  const candidates = [];
  const pattern = /(?:(?:不应|应不)超过|累计(?:金额)?限制(?:调整)?为|(?:累计|业务)?限额(?:为)?|高于|超过)(?:人民币|美元)?([\d,.]+)(万元|人民币元|元人民币|元|美元)/g;
  let match;
  while ((match = pattern.exec(source))) {
    const amount = parseAmount(match[1], match[2]);
    if (amount && (!currency || amount.currency === currency)) candidates.push(amount);
  }
  return candidates;
}

function scopeForRuleText(ruleText, fallbackScope, allowFallback) {
  if (/直销电子交易平台|直销机构|直销渠道/.test(ruleText)) {
    return { scope: "specific-channel", channels: ["基金公司直销"] };
  }
  if (/代销机构/.test(ruleText)) return { scope: "sales-agency", channels: ["代销机构"] };
  const namedSalesChannel = ruleText.match(/通过([^，。；]{2,50}?基金销售有限公司)(?:申购|办理)/);
  if (namedSalesChannel) return { scope: "specific-channel", channels: [namedSalesChannel[1]] };
  if (allowFallback && fallbackScope.scope === "specific-channel") return fallbackScope;
  return { scope: "fund-manager-general", channels: [] };
}

function sentenceRules(text, codes, codeShares, fallbackScope) {
  const source = compactText(text);
  const sentences = source.split(/[。；;]/).filter(Boolean);
  const hasExplicitChannelRule = sentences.some((sentence) =>
    /直销电子交易平台|直销机构|直销渠道|代销机构/.test(sentence) && amountCandidates(sentence).length
  );
  const rules = [];
  sentences.forEach((sentence) => {
    const datedRules = [...sentence.matchAll(/(?:自)?\d{4}年\d{1,2}月\d{1,2}日起/g)];
    const ruleText = datedRules.length ? sentence.slice(datedRules[datedRules.length - 1].index) : sentence;
    const amounts = amountCandidates(ruleText.replace(/元人民币/g, "人民币元"));
    const signatures = unique(amounts.map((item) => `${item.currency}:${item.amount}`));
    if (signatures.length !== 1) return;
    const amount = amounts[0];
    const explicitCodes = extractCodes(ruleText).filter((code) => codes.includes(code));
    const classes = targetClasses(ruleText, amount.currency);
    const selectedCodes = explicitCodes.length ? explicitCodes : codes.filter((code) =>
      codeShares[code].currency === amount.currency
      && (!classes.length || classes.includes(codeShares[code].shareClass))
    );
    if (!selectedCodes.length) return;
    const { scope, channels } = scopeForRuleText(ruleText, fallbackScope, !hasExplicitChannelRule);
    rules.push({
      scope,
      channels,
      perShareLimits: Object.fromEntries(selectedCodes.map((code) => [code, amount]))
    });
  });
  const uniqueRules = new Map();
  rules.forEach((rule) => {
    const limits = Object.entries(rule.perShareLimits).map(([code, amount]) => `${code}:${amount.currency}:${amount.amount}`).sort().join("|");
    uniqueRules.set(`${rule.scope}|${rule.channels.join("、")}|${limits}`, rule);
  });
  return [...uniqueRules.values()];
}

function classAmountRules(text, codes, codeShares, fallbackScope) {
  const sentences = compactText(text).split(/[。；;]/).filter(Boolean);
  const rules = [];
  const amountPattern = /([A-Z])类(人民币|美元现钞|美元现汇|美元|美钞|美汇)?份额[^，。；]{0,160}?(?:不应|应不)超过([\d,.]+)(万元|人民币元|元人民币|元|美元)/g;
  sentences.forEach((sentence) => {
    const perScope = new Map();
    let match;
    while ((match = amountPattern.exec(sentence))) {
      const amount = parseAmount(match[3], match[4]);
      if (!amount) continue;
      const declaredCurrency = /美元|美钞|美汇/.test(match[2] || "") ? "USD" : "CNY";
      if (amount.currency !== declaredCurrency) continue;
      const selectedCodes = codes.filter((code) => codeShares[code].shareClass === match[1]
        && codeShares[code].currency === amount.currency);
      if (!selectedCodes.length) continue;
      const channel = scopeForRuleText(sentence, fallbackScope, true);
      const key = `${channel.scope}|${channel.channels.join("、")}`;
      if (!perScope.has(key)) perScope.set(key, Object.assign({}, channel, { perShareLimits: {} }));
      selectedCodes.forEach((code) => { perScope.get(key).perShareLimits[code] = amount; });
    }
    rules.push(...perScope.values());
  });
  return rules;
}

function dedupeRules(rules) {
  const uniqueRules = new Map();
  rules.forEach((rule) => {
    const limits = Object.entries(rule.perShareLimits || {}).map(([code, amount]) => `${code}:${amount.currency}:${amount.amount}`).sort().join("|");
    uniqueRules.set(`${rule.scope}|${(rule.channels || []).join("、")}|${limits}`, rule);
  });
  return [...uniqueRules.values()];
}

function parseChannelRules(text, codes, codeShares) {
  const source = compactText(text);
  const rules = [];
  const pattern = /((?:对于(?:人民币|美元)份额，?)?(?:自)?\d{4}年\d{1,2}月\d{1,2}日起[^。]{0,100}?通过(?:本公司直销渠道|各代销机构)[^。]{0,350}?(?:不应|应不)超过[\d,.]+(?:万元|人民币元|元人民币|元|美元))/g;
  let match;
  while ((match = pattern.exec(source))) {
    const segment = match[1];
    const amounts = amountCandidates(segment.replace(/元人民币/g, "人民币元"));
    const signatures = unique(amounts.map((item) => `${item.currency}:${item.amount}`));
    if (signatures.length !== 1) continue;
    const amount = amounts[0];
    const classes = targetClasses(segment, amount.currency);
    const selectedCodes = codes.filter((code) => codeShares[code].currency === amount.currency
      && (!classes.length || classes.includes(codeShares[code].shareClass)));
    if (!selectedCodes.length) continue;
    const direct = segment.includes("本公司直销渠道");
    rules.push({
      scope: direct ? "specific-channel" : "sales-agency",
      channels: [direct ? "基金公司直销" : "代销机构"],
      perShareLimits: Object.fromEntries(selectedCodes.map((code) => [code, amount]))
    });
  }
  return rules;
}

function dateSegments(text, effectiveDate) {
  if (!effectiveDate) return [];
  const source = compactText(text);
  const target = effectiveDate.replace(/-(0?)(\d+)-(0?)(\d+)/, "年$2月$4日");
  return source
    .split(/(?=(?:自)?\d{4}年\d{1,2}月\d{1,2}日起)/)
    .filter((segment) => segment.startsWith(`自${target}起`) || segment.startsWith(`${target}起`));
}

function detectScope(text) {
  const source = compactText(text);
  if (/(?:仅针对|决定对在|在)[^。；]{0,80}(?:直销渠道|直销柜台)/.test(source) || /直销渠道/.test(source)) {
    return { scope: "specific-channel", channels: ["基金公司直销"] };
  }
  return { scope: "fund-manager-general", channels: [] };
}

function parseOfficialNoticeText(text) {
  const normalized = normalizeText(text);
  const compact = compactText(normalized);
  const announcementDate = firstChineseDate(normalized, ["公告送出日期"]);
  const effectiveDate = effectiveDateFromText(normalized, announcementDate);
  const codes = extractTransactionCodes(normalized).length ? extractTransactionCodes(normalized) : extractCodes(normalized);
  const codeShares = classifyCodeShares(normalized, codes);
  let scope = detectScope(normalized);
  const parsedSentenceRules = sentenceRules(normalized, codes, codeShares, scope);
  const parsedClassRules = classAmountRules(normalized, codes, codeShares, scope);
  const narrativeRules = dedupeRules([...parsedSentenceRules, ...parsedClassRules]);
  const channelRules = parseChannelRules(normalized, codes, codeShares);
  const perShareLimits = {};
  const warnings = [];
  const relevantSegments = dateSegments(normalized, effectiveDate);

  relevantSegments.forEach((segment) => {
    const segmentCodes = extractCodes(segment).filter((code) => codes.includes(code));
    const amounts = amountCandidates(segment);
    const uniqueAmounts = unique(amounts.map((item) => `${item.currency}:${item.amount}`));
    if (segmentCodes.length && uniqueAmounts.length === 1) {
      segmentCodes.forEach((code) => { perShareLimits[code] = amounts[0]; });
    }
  });

  if (!Object.keys(perShareLimits).length) {
    const segmentText = relevantSegments.length ? relevantSegments.join("") : compact;
    const cnyCandidates = amountCandidates(segmentText, "CNY");
    const usdCandidates = amountCandidates(segmentText, "USD");
    const uniqueCny = unique(cnyCandidates.map((item) => item.amount));
    const uniqueUsd = unique(usdCandidates.map((item) => item.amount));
    const cnyClasses = targetClasses(segmentText, "CNY");
    const usdClasses = targetClasses(segmentText, "USD");
    if (uniqueCny.length === 1) {
      codes.filter((code) => codeShares[code].currency === "CNY"
        && (!cnyClasses.length || cnyClasses.includes(codeShares[code].shareClass)))
        .forEach((code) => { perShareLimits[code] = { amount: uniqueCny[0], currency: "CNY" }; });
    }
    if (uniqueUsd.length === 1) {
      codes.filter((code) => codeShares[code].currency === "USD"
        && (!usdClasses.length || usdClasses.includes(codeShares[code].shareClass)))
        .forEach((code) => { perShareLimits[code] = { amount: uniqueUsd[0], currency: "USD" }; });
    }
    const allCandidates = amountCandidates(segmentText);
    const uniqueAmounts = unique(allCandidates.map((item) => `${item.currency}:${item.amount}`));
    if (!Object.keys(perShareLimits).length && !cnyClasses.length && !usdClasses.length && codes.length && uniqueAmounts.length === 1) {
      const amount = allCandidates[0];
      codes.filter((code) => codeShares[code].currency === amount.currency)
        .forEach((code) => { perShareLimits[code] = amount; });
    }
  }

  const unchangedPattern = /([A-Z])类基金份额仍保持([\d,.]+)(万元|人民币元|元|美元)限额不变/g;
  let unchangedMatch;
  while ((unchangedMatch = unchangedPattern.exec(compact))) {
    const amount = parseAmount(unchangedMatch[2], unchangedMatch[3]);
    if (!amount) continue;
    codes.filter((code) => codeShares[code].shareClass === unchangedMatch[1] && codeShares[code].currency === amount.currency)
      .forEach((code) => { perShareLimits[code] = amount; });
  }

  if (!announcementDate) warnings.push("未可靠提取公告日期");
  if (!effectiveDate) warnings.push("未可靠提取生效日期");
  if (!codes.length) warnings.push("未可靠提取基金份额代码");
  if (!Object.keys(perShareLimits).length && !channelRules.length && !narrativeRules.length) warnings.push("未可靠建立份额代码与限购额度的对应关系");

  const limits = narrativeRules.length
    ? narrativeRules
    : channelRules.length
      ? channelRules
    : Object.keys(perShareLimits).length
      ? [{ scope: scope.scope, channels: scope.channels, perShareLimits }]
      : [];
  Object.entries(perShareLimits).forEach(([code, amount]) => {
    if (limits.some((rule) => rule.perShareLimits && rule.perShareLimits[code])) return;
    let general = limits.find((rule) => rule.scope === "fund-manager-general");
    if (!general) {
      general = { scope: "fund-manager-general", channels: [], perShareLimits: {} };
      limits.push(general);
    }
    general.perShareLimits[code] = amount;
  });
  const limitScopes = unique(limits.map((rule) => `${rule.scope}|${(rule.channels || []).join("、")}`));
  if (limitScopes.length > 1) scope = { scope: "multi-channel", channels: [] };
  else if (limits.length) scope = { scope: limits[0].scope, channels: limits[0].channels || [] };
  const flattenedLimits = {};
  limits.forEach((rule) => {
    Object.entries(rule.perShareLimits || {}).forEach(([code, amount]) => {
      if (!flattenedLimits[code]) flattenedLimits[code] = amount;
    });
  });

  return {
    parsed: warnings.length === 0,
    announcementDate,
    effectiveDate,
    scope: scope.scope,
    channels: scope.channels,
    shareCodes: codes,
    perShareLimits: Object.keys(flattenedLimits).length ? flattenedLimits : perShareLimits,
    limits,
    accountBasis: /单日(?:单个|每个)基金账户/.test(compact)
      ? (/分别计算|不同份额单独计算/.test(compact)
        ? "single-fund-account-daily-cumulative-per-share"
        : "single-fund-account-daily-cumulative")
      : "unknown",
    confidence: warnings.length ? "low" : "high",
    parseWarnings: warnings
  };
}

function localDate(iso, timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "Asia/Shanghai",
      year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date(iso));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return String(iso || "").slice(0, 10);
  }
}

function channelMatches(rowChannel, officialChannels) {
  if (!(officialChannels || []).length) return true;
  const channel = String(rowChannel || "");
  return officialChannels.some((official) => official === "基金公司直销" ? /直销/.test(channel) : channel.includes(official));
}

function ruleMatchesChannel(rule, rowChannel) {
  if (rule.scope === "fund-manager-general") return true;
  if (rule.scope === "sales-agency") return /天天基金|代销|银行|券商|支付宝|蚂蚁|理财通/.test(String(rowChannel || ""));
  return channelMatches(rowChannel, rule.channels);
}

function compareOfficialLimit(row, parsed, queriedAt, timezone) {
  if (!parsed || !parsed.parsed) return { status: "unknown" };
  const rules = parsed.limits && parsed.limits.length
    ? parsed.limits
    : [{ scope: parsed.scope, channels: parsed.channels || [], perShareLimits: parsed.perShareLimits || {} }];
  const coveringRules = rules.filter((rule) => rule.perShareLimits && rule.perShareLimits[row.code]
    || rule.perShareStatuses && rule.perShareStatuses[row.code]);
  if (!coveringRules.length) return { status: "share-not-covered" };
  const matchingRules = coveringRules.filter((rule) => ruleMatchesChannel(rule, row.channel));
  const ruleCommon = (rule) => {
    const limit = rule.perShareLimits && rule.perShareLimits[row.code] || null;
    const scopeLabel = rule.scope === "specific-channel"
      ? (rule.channels || []).join("、")
      : rule.scope === "sales-agency" ? "代销机构" : "基金管理人公告";
    return {
      amount: limit && limit.amount || null,
      currency: limit && limit.currency || null,
      effectiveDate: rule.effectiveDate || parsed.effectiveDate,
      scope: rule.scope,
      scopeLabel,
      accountBasis: rule.accountBasis || parsed.accountBasis || "unknown",
      noticeId: rule.noticeId || null,
      noticeDate: rule.noticeDate || null,
      noticeUrl: rule.noticeUrl || null
    };
  };
  if (!matchingRules.length) return Object.assign(ruleCommon(coveringRules[0]), { status: "not-comparable-channel" });
  const today = localDate(queriedAt, timezone);
  const ordered = matchingRules.slice().sort((left, right) => {
    const leftDate = left.effectiveDate || left.noticeDate || "";
    const rightDate = right.effectiveDate || right.noticeDate || "";
    return String(rightDate).localeCompare(String(leftDate)) || String(right.noticeId || "").localeCompare(String(left.noticeId || ""));
  });
  const active = ordered.filter((rule) => !(rule.effectiveDate || parsed.effectiveDate) || (rule.effectiveDate || parsed.effectiveDate) <= today);
  if (!active.length) {
    const pending = ordered.slice().sort((left, right) => String(left.effectiveDate || "").localeCompare(String(right.effectiveDate || "")))[0];
    return Object.assign(ruleCommon(pending), { status: "pending" });
  }
  let decisionRules = active;
  const specificRules = active.filter((rule) => rule.scope !== "fund-manager-general");
  const generalRules = active.filter((rule) => rule.scope === "fund-manager-general");
  if (specificRules.length && generalRules.length) {
    const latestDate = (rulesToCheck) => rulesToCheck.reduce((latest, rule) => {
      const date = rule.effectiveDate || rule.noticeDate || parsed.effectiveDate || "";
      return String(date) > String(latest) ? date : latest;
    }, "");
    decisionRules = String(latestDate(specificRules)) >= String(latestDate(generalRules))
      ? specificRules
      : generalRules;
  }
  const currentByScope = [];
  const resolvedScopes = new Set();
  const resumedScopes = new Set();
  decisionRules.forEach((rule) => {
    const scopeKey = [rule.scope || "unknown", (rule.channels || []).slice().sort().join("、")].join("|");
    if (resolvedScopes.has(scopeKey)) return;
    const status = rule.perShareStatuses && rule.perShareStatuses[row.code];
    if (status === "open") {
      resumedScopes.add(scopeKey);
      return;
    }
    if (status === "suspended") {
      if (resumedScopes.has(scopeKey)) return;
      currentByScope.push({ rule, status: "suspended" });
      resolvedScopes.add(scopeKey);
      return;
    }
    if (rule.perShareLimits && rule.perShareLimits[row.code]) {
      currentByScope.push({ rule, status: "limited" });
      resolvedScopes.add(scopeKey);
    }
  });
  const suspended = currentByScope.find((item) => item.status === "suspended");
  if (suspended) return Object.assign(ruleCommon(suspended.rule), { status: "official-suspended" });
  const limited = currentByScope
    .filter((item) => item.status === "limited")
    .sort((left, right) => left.rule.perShareLimits[row.code].amount - right.rule.perShareLimits[row.code].amount)[0];
  if (!limited) {
    const resumed = active.find((item) => item.perShareStatuses && item.perShareStatuses[row.code] === "open");
    return resumed ? Object.assign(ruleCommon(resumed), { status: "official-open" }) : { status: "unknown" };
  }
  const rule = limited.rule;
  const limit = rule.perShareLimits[row.code];
  const scopeLabel = rule.scope === "specific-channel"
    ? (rule.channels || []).join("、")
    : rule.scope === "sales-agency" ? "代销机构" : "基金管理人公告";
  const common = Object.assign(ruleCommon(rule), { amount: limit.amount, currency: limit.currency, scopeLabel });
  if (["unavailable", "suspended"].includes(row.status)) return Object.assign(common, { status: "channel-unavailable" });
  if (!Number.isFinite(row.limitAmount)) return Object.assign(common, { status: "channel-no-limit-shown" });
  if (row.limitAmount === limit.amount) return Object.assign(common, { status: "match" });
  return Object.assign(common, { status: row.limitAmount < limit.amount ? "channel-lower" : "channel-higher" });
}

async function extractPdfText(buffer) {
  const { getDocument } = await import("pdfjs-dist/build/pdf.mjs");
  const document = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, verbosity: 0 }).promise;
  try {
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => `${item.str}${item.hasEOL ? "\n" : " "}`).join(""));
    }
    return pages.join("\n");
  } finally {
    await document.destroy();
  }
}

module.exports = {
  compareOfficialLimit,
  extractPdfText,
  normalizeText,
  parseOfficialNoticeText
};
