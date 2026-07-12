const childProcess = require("node:child_process");
const http = require("node:http");
const https = require("node:https");
const { changeLine, formatTime } = require("./report");

function shouldNotify(payload, mode) {
  if (!payload || !payload.health || payload.health.status !== "ok") return false;
  if (mode === "always") return true;
  return Boolean(payload.previousSnapshotFound && payload.changes && payload.changes.length);
}

function buildNotificationText(payload) {
  const lines = ["QDII基金额度更新", `查询时间：${formatTime(payload.queriedAt, payload.timezone)}`];
  if (payload.changes && payload.changes.length) {
    lines.push(`变化：${payload.changes.length} 条`);
    payload.changes.slice(0, 20).forEach((change) => lines.push(changeLine(change).replace(/^- /, "")));
    if (payload.changes.length > 20) lines.push(`另有 ${payload.changes.length - 20} 条，请查看完整报告。`);
  } else {
    const purchasable = (payload.rows || []).filter((row) => ["open", "limited"].includes(row.status)).length;
    lines.push(`当前确认可买渠道记录：${purchasable} 条`, "额度与渠道无变化。");
  }
  return lines.join("\n");
}

function buildNotificationPayload(type, text) {
  if (type === "feishu") return { msg_type: "text", content: { text } };
  return { title: "QDII基金额度变化", text };
}

function resolveWebhookUrl(options) {
  if (options && options.webhookUrl) return options.webhookUrl;
  if (process.env.QDII_LIMIT_WEBHOOK_URL) return process.env.QDII_LIMIT_WEBHOOK_URL;
  if (process.platform !== "darwin") return "";
  const service = process.env.QDII_LIMIT_WEBHOOK_KEYCHAIN_SERVICE || "qdii-purchase-limits-webhook";
  try {
    return childProcess.execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch (error) {
    return "";
  }
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const localHttp = target.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(target.hostname);
    if (target.protocol !== "https:" && !localHttp) return reject(new Error("webhook 必须使用 https；本机 localhost 可使用 http"));
    const body = JSON.stringify(payload);
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(target, {
      method: "POST",
      timeout: 15000,
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) }
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve({ statusCode: response.statusCode, body: responseBody });
        else reject(new Error(`webhook HTTP ${response.statusCode}`));
      });
    });
    request.on("timeout", () => request.destroy(new Error("webhook 请求超时")));
    request.on("error", reject);
    request.end(body);
  });
}

function assertNotificationAccepted(type, result) {
  if (type !== "feishu") return;
  let response;
  try {
    response = JSON.parse(result.body);
  } catch {
    throw new Error("飞书 webhook 返回失败：响应格式无法识别");
  }
  const code = Object.prototype.hasOwnProperty.call(response, "StatusCode") ? response.StatusCode : response.code;
  if (Number(code) !== 0) throw new Error(`飞书 webhook 返回失败：业务错误码 ${String(code == null ? "unknown" : code)}`);
}

async function sendNotification(payload, options) {
  const settings = Object.assign({ type: "feishu", mode: "changes" }, options);
  if (!["feishu", "generic"].includes(settings.type)) throw new Error("通知类型只支持 feishu 或 generic");
  if (!shouldNotify(payload, settings.mode)) return { sent: false, reason: "not-needed" };
  const webhookUrl = resolveWebhookUrl(settings);
  if (!webhookUrl) return { sent: false, reason: "missing-webhook" };
  const text = buildNotificationText(payload);
  const result = await (settings.postJson || postJson)(webhookUrl, buildNotificationPayload(settings.type, text));
  assertNotificationAccepted(settings.type, result);
  return { sent: true, statusCode: result.statusCode };
}

module.exports = {
  buildNotificationPayload,
  buildNotificationText,
  assertNotificationAccepted,
  postJson,
  resolveWebhookUrl,
  sendNotification,
  shouldNotify
};
