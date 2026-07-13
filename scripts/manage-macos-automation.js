#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEFAULT_SCHEDULE } = require("./lib/schedule");

const DEFAULT_LABEL = "io.github.qdii-purchase-limits.scheduler";

function xml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildMacPlist(options) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(options.label)}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(options.nodePath)}</string><string>${xml(options.runnerPath)}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>QDII_LIMIT_DATA_DIR</key><string>${xml(options.outputDir)}</string>
    <key>QDII_LIMIT_TIMEZONE</key><string>Asia/Shanghai</string>
    <key>QDII_LIMIT_NOTIFY_MODE</key><string>changes</string>
    <key>QDII_LIMIT_WEBHOOK_TYPE</key><string>feishu</string>
  </dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(options.outputDir, "automation.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(options.outputDir, "automation.err.log"))}</string>
</dict>
</plist>
`;
}

function runLaunchctl(args, allowFailure) {
  const result = childProcess.spawnSync("launchctl", args, { encoding: "utf8" });
  if (!allowFailure && result.status !== 0) throw new Error((result.stderr || result.stdout || "launchctl 失败").trim());
  return result;
}

function settings() {
  const outputDir = process.env.QDII_LIMIT_DATA_DIR || path.join(os.homedir(), ".qdii-purchase-limits");
  return {
    label: DEFAULT_LABEL,
    nodePath: process.execPath,
    runnerPath: path.join(__dirname, "run-scheduled.js"),
    outputDir,
    schedule: DEFAULT_SCHEDULE,
    plistPath: path.join(os.homedir(), "Library", "LaunchAgents", `${DEFAULT_LABEL}.plist`)
  };
}

function main(argv) {
  if (process.platform !== "darwin") throw new Error("此管理器仅支持 macOS；其他系统可定时调用 run-scheduled.js");
  const action = argv[0] || "status";
  const config = settings();
  const uidTarget = `gui/${process.getuid()}`;
  if (action === "print") {
    process.stdout.write(buildMacPlist(config));
    return;
  }
  if (action === "install") {
    fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
    fs.mkdirSync(config.outputDir, { recursive: true });
    fs.writeFileSync(config.plistPath, buildMacPlist(config), "utf8");
    runLaunchctl(["bootout", uidTarget, config.plistPath], true);
    runLaunchctl(["bootstrap", uidTarget, config.plistPath], false);
    runLaunchctl(["enable", `${uidTarget}/${config.label}`], false);
    process.stdout.write(`已安装并启用：${config.label}\n${config.plistPath}\n`);
    return;
  }
  if (action === "uninstall") {
    runLaunchctl(["bootout", uidTarget, config.plistPath], true);
    if (fs.existsSync(config.plistPath)) fs.unlinkSync(config.plistPath);
    process.stdout.write(`已卸载：${config.label}\n`);
    return;
  }
  if (action === "status") {
    const result = runLaunchctl(["print", `${uidTarget}/${config.label}`], true);
    process.stdout.write(result.status === 0 ? result.stdout : `未启用：${config.label}\n`);
    return;
  }
  throw new Error("用法：manage-macos-automation.js install|uninstall|status|print");
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { DEFAULT_LABEL, buildMacPlist, main, settings };
