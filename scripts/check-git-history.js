#!/usr/bin/env node
const childProcess = require("node:child_process");

function git(args, options) {
  return childProcess.execFileSync("git", args, Object.assign({ encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }, options));
}

function credentialPatterns() {
  const githubClassic = ["gh", "p_"].join("");
  const githubFineGrained = ["github", "_pat_"].join("");
  const openAiKey = ["s", "k-"].join("");
  const privateKey = ["BEGIN ", "PRIVATE KEY"].join("");
  return [
    ["github-token", new RegExp(`${githubClassic}[A-Za-z0-9]{20,}`)],
    ["github-fine-grained-token", new RegExp(`${githubFineGrained}[A-Za-z0-9_]{20,}`)],
    ["api-secret", new RegExp(`${openAiKey}[A-Za-z0-9_-]{20,}`)],
    ["aws-access-key", /AKIA[A-Z0-9]{16}/],
    ["private-key", new RegExp(privateKey)],
    ["feishu-webhook", /open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{12,}/],
    ["generic-assigned-secret", /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']([^"'\s]{12,})["']/i]
  ];
}

function publicReleasePatterns() {
  const internalName = ["SP", "XWX"].join("");
  return [
    ["internal-project-name", new RegExp(internalName)],
    ["developer-home-path", /\/Users\/[^/]+\/Documents\/System\//],
    ["private-history-context", new RegExp([["小", "程序"].join(""), ["内", "部项目"].join("")].join("|"))]
  ];
}

function isPlaceholder(match) {
  return /(?:example|your|placeholder|\.\.\.|<|>|\$\{|\$[A-Z_])/i.test(match);
}

function findSensitiveKinds(text, options) {
  const settings = Object.assign({ publicRelease: false }, options);
  const source = String(text || "");
  const kinds = [];
  credentialPatterns().forEach(([kind, pattern]) => {
    const match = source.match(pattern);
    if (match && !isPlaceholder(match[0])) kinds.push(kind);
  });
  if (settings.publicRelease) {
    publicReleasePatterns().forEach(([kind, pattern]) => {
      if (pattern.test(source)) kinds.push(kind);
    });
  }
  return [...new Set(kinds)];
}

function scanHistory(root, options) {
  const settings = Object.assign({ publicRelease: false }, options);
  const commits = git(["rev-list", "--all"], { cwd: root }).trim().split("\n").filter(Boolean);
  const findings = [];
  const seen = new Set();

  commits.forEach((commit) => {
    const files = git(["ls-tree", "-r", "--name-only", commit], { cwd: root }).trim().split("\n").filter(Boolean);
    files.forEach((file) => {
      let content;
      try {
        content = git(["show", `${commit}:${file}`], { cwd: root });
      } catch {
        return;
      }
      if (content.includes("\u0000")) return;
      findSensitiveKinds(content, settings).forEach((kind) => {
        const key = `${commit}:${file}:${kind}`;
        if (seen.has(key)) return;
        seen.add(key);
        findings.push({ commit: commit.slice(0, 12), file, kind });
      });
    });
  });
  return findings;
}

function main() {
  const publicRelease = process.argv.includes("--public-release");
  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"]).trim();
  } catch {
    console.error("FAIL: 当前目录不是 Git 仓库。");
    process.exitCode = 1;
    return;
  }
  const findings = scanHistory(root, { publicRelease });
  if (findings.length) {
    findings.forEach((item) => console.error(`FAIL: ${item.commit} ${item.file} [${item.kind}]`));
    console.error(`FAIL: 完整提交历史发现 ${findings.length} 个风险位置；未输出匹配内容。`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`PASS: 完整提交历史未发现${publicRelease ? "凭据或非公开信息" : "疑似凭据"}。\n`);
}

if (require.main === module) main();

module.exports = { credentialPatterns, publicReleasePatterns, findSensitiveKinds, scanHistory, main };
