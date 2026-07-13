#!/usr/bin/env node
const https = require("node:https");
const { findSensitiveKinds } = require("./check-git-history");

function requestJson(url, token) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "qdii-purchase-limits-release-audit",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GitHub API HTTP ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch { reject(new Error("GitHub Release 返回了无效 JSON")); }
      });
    });
    request.on("error", reject);
  });
}

function checkReleaseMetadata(releases) {
  const errors = [];
  (releases || []).forEach((release) => {
    const label = release.tag_name || "untagged-release";
    const metadata = [release.name, release.tag_name, release.target_commitish, release.body]
      .filter(Boolean).join("\n");
    const kinds = findSensitiveKinds(metadata, { publicRelease: true });
    if (kinds.length) errors.push(`${label} 的 Release 元数据含风险类型：${kinds.join(", ")}`);
    if ((release.assets || []).length) errors.push(`${label} 含 Release Assets；本项目不发布附件，需人工删除或独立审计`);
  });
  return errors;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!repository || !token) throw new Error("缺少 GITHUB_REPOSITORY 或 GitHub token，无法审计 Release");
  const releases = await requestJson(`https://api.github.com/repos/${repository}/releases?per_page=100`, token);
  const errors = checkReleaseMetadata(releases);
  if (errors.length) {
    errors.forEach((error) => console.error(`FAIL: ${error}`));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`PASS: ${releases.length} 个 GitHub Release 已检查；无附件或敏感元数据。\n`);
}

if (require.main === module) {
  main().catch((error) => { console.error(`FAIL: ${error.message}`); process.exitCode = 1; });
}

module.exports = { checkReleaseMetadata, main, requestJson };
