#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sendNotification } = require("./lib/notify");
const { readJson, runQuery, writeAtomic } = require("./lib/query");
const { DEFAULT_SCHEDULE, findDueSlot, slotKey, zonedParts } = require("./lib/schedule");

async function runScheduled(options) {
  const settings = Object.assign({
    now: new Date(),
    outputDir: process.env.QDII_LIMIT_DATA_DIR || path.join(os.homedir(), ".qdii-purchase-limits"),
    timezone: process.env.QDII_LIMIT_TIMEZONE || "Asia/Shanghai",
    schedule: DEFAULT_SCHEDULE,
    runQuery,
    sendNotification,
    notifyMode: process.env.QDII_LIMIT_NOTIFY_MODE || "changes",
    webhookType: process.env.QDII_LIMIT_WEBHOOK_TYPE || "feishu",
    force: false
  }, options);
  const statePath = path.join(settings.outputDir, "automation-state.json");
  const state = readJson(statePath, { version: 1, completedSlots: [] });
  const local = zonedParts(settings.now, settings.timezone);
  const slot = settings.force
    ? { name: "手动", time: "manual", date: local.date, key: slotKey(local.date, `manual-${settings.now.getTime()}`) }
    : findDueSlot(settings.now, settings.schedule, state.completedSlots, settings.timezone);
  if (!slot) return { skipped: true, reason: "no-due-slot" };

  const channelsFile = process.env.QDII_LIMIT_CHANNELS_FILE || undefined;
  const payload = await settings.runQuery({
    index: "all",
    includeUsd: false,
    includeEtf: false,
    outputDir: settings.outputDir,
    channelsFile,
    timezone: settings.timezone,
    officialNotices: true,
    queriedAt: settings.now.toISOString(),
    save: true
  });
  if (payload.exitCode !== 0 || !payload.health || payload.health.status !== "ok") {
    throw new Error(`数据完整度不足，自动化时段 ${slot.name} 未标记成功`);
  }
  const notification = await settings.sendNotification(payload, { type: settings.webhookType, mode: settings.notifyMode });
  state.completedSlots = (state.completedSlots || []).filter((key) => key.startsWith(local.date + "@"));
  state.completedSlots.push(slot.key);
  state.lastSuccessAt = settings.now.toISOString();
  state.lastSlot = slot;
  state.lastNotification = notification;
  writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { skipped: false, slot, payload, notification };
}

async function main(argv) {
  const result = await runScheduled({ force: argv.includes("--force") });
  if (result.skipped) process.stdout.write("当前没有待执行时段。\n");
  else process.stdout.write(`已完成 ${result.slot.name}（${result.slot.time}）查询；通知：${result.notification.sent ? "已发送" : result.notification.reason}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`自动化失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, runScheduled };
