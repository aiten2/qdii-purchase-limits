const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { checkRelease, filesUnder, findPrivacyLeaks, publicReadmeForbiddenPhrases } = require("../scripts/check-release");
const { findSensitiveKinds } = require("../scripts/check-git-history");

test("public skill package passes release gates", () => {
  const root = path.resolve(__dirname, "..");
  const result = checkRelease(root, { runTests: false });
  assert.deepEqual(result.errors, []);
  assert.ok(result.checkedFiles >= 8);
});

test("public README excludes maintainer-only assurance wording", () => {
  const readme = fs.readFileSync(path.resolve(__dirname, "..", "README.md"), "utf8");
  publicReadmeForbiddenPhrases().forEach((phrase) => {
    assert.equal(readme.includes(phrase), false, phrase);
  });
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

test("privacy scan rejects internal project names, user paths, and migration wording", () => {
  const internalName = ["SP", "XWX"].join("");
  const userName = ["lao", "chen"].join("");
  const text = [
    internalName,
    ["", "Users", userName, "Documents", "System", "private"].join("/"),
    ["旧", "项目"].join(""),
    ["迁", "移"].join(""),
    ["原", "小", "程序自动化"].join("")
  ].join(" ");
  const leaks = findPrivacyLeaks(text);
  assert.ok(leaks.includes("internal-project-name"));
  assert.ok(leaks.includes("user-home-path"));
  assert.ok(leaks.includes("internal-history-wording"));
});

test("git history scan classifies credentials without returning their values", () => {
  const classicToken = ["gh", "p_", "A".repeat(36)].join("");
  const findings = findSensitiveKinds(`token=${classicToken}`);
  assert.deepEqual(findings, ["github-token"]);
  assert.equal(findings.join(" ").includes(classicToken), false);
});

test("public release history scan detects internal context separately", () => {
  const internalName = ["SP", "XWX"].join("");
  assert.deepEqual(findSensitiveKinds(internalName), []);
  assert.deepEqual(findSensitiveKinds(internalName, { publicRelease: true }), ["internal-project-name"]);
});
