const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { checkRelease, filesUnder } = require("../scripts/check-release");
const { findSensitiveKinds } = require("../scripts/check-git-history");

test("public skill package passes release gates", () => {
  const root = path.resolve(__dirname, "..");
  const result = checkRelease(root, { runTests: false });
  assert.deepEqual(result.errors, []);
  assert.ok(result.checkedFiles >= 8);
});

test("public README keeps the Agent table focused on installation and invocation", () => {
  const readme = fs.readFileSync(path.resolve(__dirname, "..", "README.md"), "utf8");
  assert.match(readme, /\| Agent \/ 工具 \| 安装位置或方式 \| 调用方式 \|/);
  assert.doesNotMatch(readme, /\| Agent \/ 工具 \| 安装位置或方式 \| 调用方式 \| 状态 \|/);
});

test("public README centers amount and code columns in the sample report", () => {
  const readme = fs.readFileSync(path.resolve(__dirname, "..", "README.md"), "utf8");
  assert.match(readme, /\| 单日申购上限 \| 基金 \| 代码 \|\n\| :---: \| --- \| :---: \|/);
  assert.doesNotMatch(readme, /\| ---: \| --- \| --- \|/);
});

test("public README uses the current Codex user skill directory", () => {
  const readme = fs.readFileSync(path.resolve(__dirname, "..", "README.md"), "utf8");
  assert.match(readme, /\[Codex\][^\n]+`~\/\.agents\/skills\/`/);
  assert.doesNotMatch(readme, /\[Codex\][^\n]+`~\/\.codex\/skills\/`/);
});

test("release scanners contain no project-specific identity terms", () => {
  const root = path.resolve(__dirname, "..");
  const scannerText = ["scripts/check-release.js", "scripts/check-git-history.js"]
    .map((name) => fs.readFileSync(path.join(root, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(scannerText, /\/Users\/[A-Za-z0-9._-]+\/Documents\/System\//);
});

test("release file discovery ignores git metadata and runtime output folders", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-release-files-"));
  fs.mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, "outputs"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "hooks", "sample"), "ignored");
  fs.writeFileSync(path.join(root, "outputs", "latest.json"), "ignored");
  fs.writeFileSync(path.join(root, "scripts", "real.js"), "included");
  assert.deepEqual(filesUnder(root).map((file) => path.relative(root, file)), [path.join("scripts", "real.js")]);
});

test("git history scan classifies credentials without returning their values", () => {
  const classicToken = ["gh", "p_", "A".repeat(36)].join("");
  const findings = findSensitiveKinds(`token=${classicToken}`);
  assert.deepEqual(findings, ["github-token"]);
  assert.equal(findings.join(" ").includes(classicToken), false);
});

test("public release history scan detects private paths separately", () => {
  const privatePath = path.posix.join("/", "Users", "developer", "Documents", "System", "private");
  assert.deepEqual(findSensitiveKinds(privatePath), []);
  assert.deepEqual(findSensitiveKinds(privatePath, { publicRelease: true }), ["developer-home-path"]);
});
