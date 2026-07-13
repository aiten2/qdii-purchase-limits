const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { checkRelease, filesUnder } = require("../scripts/check-release");
const childProcess = require("node:child_process");
const { findSensitiveKinds, scanHistory } = require("../scripts/check-git-history");
const { checkReleaseMetadata } = require("../scripts/check-github-releases");

test("public skill package passes release gates", () => {
  const root = path.resolve(__dirname, "..");
  const result = checkRelease(root, { runTests: false });
  assert.deepEqual(result.errors, []);
  assert.ok(result.checkedFiles >= 8);
});

test("public README keeps the Agent table focused on installation and use", () => {
  const readme = fs.readFileSync(path.resolve(__dirname, "..", "README.md"), "utf8");
  assert.match(readme, /\| Agent \/ 工具 \| 安装位置或方式 \| 使用方式 \|/);
  assert.doesNotMatch(readme, /\| Agent \/ 工具 \| 安装位置或方式 \| 使用方式 \| 状态 \|/);
});

test("copy-to-AI install prompt contains only the installation request", () => {
  const readme = fs.readFileSync(path.resolve(__dirname, "..", "README.md"), "utf8");
  const section = readme.match(/## 复制给 AI 安装([\s\S]*?)### 手动安装/);
  assert.ok(section);
  const prompts = [...section[1].matchAll(/```text\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  assert.deepEqual(prompts, [
    "请从 https://github.com/aiten2/qdii-purchase-limits 安装这个 Skill。",
    "请从 https://gitee.com/aiten2/qdii-purchase-limits 安装这个 Skill。",
  ]);
  assert.doesNotMatch(section[1], /^> /m);
});

test("CLI help uses the same neutral product title as the README", () => {
  const { HELP } = require("../scripts/query-purchase-limits");
  assert.match(HELP, /^QDII 指数基金申购限额查询/);
  assert.doesNotMatch(HELP, /可买额度查询/);
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
  const privatePath = path.posix.join("/", "Users", "developer", "private");
  assert.deepEqual(findSensitiveKinds(privatePath), []);
  assert.deepEqual(findSensitiveKinds(privatePath, { publicRelease: true }), ["developer-home-path"]);
});

test("public release history scan checks commit metadata without exposing the email", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qdii-history-metadata-"));
  const run = (args, env) => childProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", env: Object.assign({}, process.env, env) });
  run(["init", "-q"]);
  fs.writeFileSync(path.join(root, "README.md"), "clean\n");
  run(["add", "README.md"]);
  const email = ["private-person", "example.com"].join("@");
  run(["commit", "-q", "-m", "clean commit"], {
    GIT_AUTHOR_NAME: "Developer", GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: "Developer", GIT_COMMITTER_EMAIL: email
  });
  const findings = scanHistory(root, { publicRelease: true });
  assert.ok(findings.some((item) => item.kind === "developer-email"));
  assert.equal(JSON.stringify(findings).includes(email), false);
});

test("GitHub Release audit blocks unreviewed assets and private metadata", () => {
  const privatePath = path.posix.join("/", "Users", "developer", "private");
  const errors = checkReleaseMetadata([{ tag_name: "v1", body: privatePath, assets: [{ name: "bundle.zip" }] }]);
  assert.equal(errors.length, 2);
  assert.equal(errors.join("\n").includes(privatePath), false);
  assert.deepEqual(checkReleaseMetadata([{ tag_name: "v1", body: "公开变更说明", assets: [] }]), []);
});
