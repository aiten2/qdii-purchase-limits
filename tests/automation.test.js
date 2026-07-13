const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_SCHEDULE,
  findDueSlot,
  slotKey
} = require("../scripts/lib/schedule");
const {
  buildNotificationText,
  buildNotificationPayload,
  sendNotification,
  shouldNotify
} = require("../scripts/lib/notify");
const { buildMacPlist } = require("../scripts/manage-macos-automation");
const { runScheduled } = require("../scripts/run-scheduled");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("finds the latest missed intraday slot and deduplicates completed slots", () => {
  const morning = findDueSlot(new Date("2026-07-12T04:00:00.000Z"), DEFAULT_SCHEDULE, [], "Asia/Shanghai");
  assert.equal(morning.time, "09:10");
  const afternoon = findDueSlot(new Date("2026-07-12T06:40:00.000Z"), DEFAULT_SCHEDULE, [slotKey("2026-07-12", "09:10")], "Asia/Shanghai");
  assert.equal(afternoon.time, "14:30");
  const evening = findDueSlot(new Date("2026-07-12T13:00:00.000Z"), DEFAULT_SCHEDULE, [slotKey("2026-07-12", "09:10"), slotKey("2026-07-12", "14:30")], "Asia/Shanghai");
  assert.equal(evening.time, "20:30");
  const none = findDueSlot(new Date("2026-07-12T13:00:00.000Z"), DEFAULT_SCHEDULE, DEFAULT_SCHEDULE.map((item) => slotKey("2026-07-12", item.time)), "Asia/Shanghai");
  assert.equal(none, null);
});

test("sends change notifications only for healthy non-baseline comparisons by default", () => {
  const base = { previousSnapshotFound: true, health: { status: "ok" }, changes: [{ type: "amount-decreased" }] };
  assert.equal(shouldNotify(base, "changes"), true);
  assert.equal(shouldNotify(Object.assign({}, base, { changes: [] }), "changes"), false);
  assert.equal(shouldNotify(Object.assign({}, base, { previousSnapshotFound: false }), "changes"), false);
  assert.equal(shouldNotify(Object.assign({}, base, { health: { status: "degraded" } }), "changes"), false);
  assert.equal(shouldNotify(Object.assign({}, base, { changes: [] }), "always"), true);
});

test("builds Feishu and generic webhook payloads without embedding the webhook URL", () => {
  const text = "纳指 019441 额度由100元降至10元";
  assert.deepEqual(buildNotificationPayload("feishu", text), { msg_type: "text", content: { text } });
  assert.deepEqual(buildNotificationPayload("generic", text), { title: "QDII基金额度变化", text });
});

test("does not report a Feishu business error as a sent notification", async () => {
  const payload = {
    queriedAt: "2026-07-12T06:30:00.000Z",
    timezone: "Asia/Shanghai",
    health: { status: "ok" },
    previousSnapshotFound: true,
    changes: [{ type: "status-changed", before: { code: "1", name: "测试", channel: "测试", status: "open" }, after: { code: "1", name: "测试", channel: "测试", status: "limited" } }]
  };
  await assert.rejects(
    sendNotification(payload, {
      type: "feishu",
      webhookUrl: "https://example.com/hook",
      postJson: async () => ({ statusCode: 200, body: JSON.stringify({ StatusCode: 19001, StatusMessage: "failed" }) })
    }),
    /飞书 webhook 返回失败/
  );
});

test("accepts successful Feishu response formats and rejects unknown notification types", async () => {
  const payload = {
    queriedAt: "2026-07-12T06:30:00.000Z",
    timezone: "Asia/Shanghai",
    health: { status: "ok" },
    previousSnapshotFound: true,
    changes: [{ type: "status-changed", before: { code: "1", name: "测试", channel: "测试", status: "open" }, after: { code: "1", name: "测试", channel: "测试", status: "limited" } }]
  };
  const sent = await sendNotification(payload, {
    type: "feishu",
    webhookUrl: "https://example.com/hook",
    postJson: async () => ({ statusCode: 200, body: JSON.stringify({ code: 0, msg: "ok" }) })
  });
  assert.equal(sent.sent, true);
  await assert.rejects(sendNotification(payload, { type: "typo", webhookUrl: "https://example.com/hook" }), /通知类型只支持/);
});

test("builds a launchd plist that polls while Node applies the Beijing schedule", () => {
  const plist = buildMacPlist({
    label: "com.example.qdii-limits",
    nodePath: "/usr/local/bin/node",
    runnerPath: "/tmp/skill/scripts/run-scheduled.js",
    outputDir: "/tmp/qdii-purchase-limits-test",
    schedule: DEFAULT_SCHEDULE
  });
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.doesNotMatch(plist, /StartCalendarInterval/);
  assert.match(plist, /run-scheduled\.js/);
  assert.match(plist, /io\.github\.qdii-purchase-limits\.scheduler|com\.example\.qdii-limits/);
});

test("runs one due slot, records success, and skips the same slot next time", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-schedule-"));
  let queryCount = 0;
  let notifyCount = 0;
  const options = {
    now: new Date("2026-07-12T06:40:00.000Z"),
    outputDir,
    timezone: "Asia/Shanghai",
    runQuery: async () => { queryCount += 1; return { exitCode: 0, health: { status: "ok" }, previousSnapshotFound: true, changes: [] }; },
    sendNotification: async () => { notifyCount += 1; return { sent: false, reason: "not-needed" }; }
  };
  const first = await runScheduled(options);
  const second = await runScheduled(options);
  assert.equal(first.slot.time, "14:30");
  assert.equal(second.skipped, true);
  assert.equal(queryCount, 1);
  assert.equal(notifyCount, 1);
});

test("scheduled runs always refresh the current official announcement timeline", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-schedule-refresh-"));
  let queryOptions;
  await runScheduled({
    now: new Date("2026-07-12T06:40:00.000Z"),
    outputDir,
    timezone: "Asia/Shanghai",
    runQuery: async (options) => {
      queryOptions = options;
      return { exitCode: 0, health: { status: "ok" }, previousSnapshotFound: true, changes: [] };
    },
    sendNotification: async () => ({ sent: false, reason: "not-needed" })
  });
  assert.equal(queryOptions.officialNoticeCacheHours, 0);
});

test("does not mark a partial query as a completed automation slot", async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-schedule-partial-"));
  await assert.rejects(runScheduled({
    now: new Date("2026-07-12T06:40:00.000Z"),
    outputDir,
    timezone: "Asia/Shanghai",
    runQuery: async () => ({ exitCode: 0, health: { status: "partial" }, previousSnapshotFound: true, changes: [] }),
    sendNotification: async () => ({ sent: false, reason: "not-needed" })
  }), /数据完整度不足/);
  assert.equal(fs.existsSync(path.join(outputDir, "automation-state.json")), false);
});

test("notification summaries use final decisions and preserve USD currency", () => {
  const text = buildNotificationText({
    queriedAt: "2026-07-12T06:30:00.000Z",
    timezone: "Asia/Shanghai",
    health: { status: "ok" },
    changes: [],
    rows: [
      { status: "limited", decisionStatus: "unknown", currency: "CNY" },
      { status: "limited", decisionStatus: "limited", currency: "USD" }
    ]
  });
  assert.match(text, /当前确认可申购记录：1 条/);
  assert.doesNotMatch(text, /当前确认可买/);
});
