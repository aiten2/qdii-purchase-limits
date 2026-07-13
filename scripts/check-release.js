#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function filesUnder(root) {
  const files = [];
  function walk(directory) {
    fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      if (entry.isDirectory() && [".git", "node_modules", "outputs", "coverage"].includes(entry.name)) return;
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else files.push(filePath);
    });
  }
  walk(root);
  return files;
}

function checkRelease(root, options) {
  const settings = Object.assign({ runTests: true }, options);
  const errors = [];
  const required = [
    "SKILL.md", "README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "THIRD_PARTY_NOTICES.md",
    "package.json", "package-lock.json", "agents/openai.yaml", ".github/workflows/test.yml", ".github/dependabot.yml",
    "scripts/query-purchase-limits.js", "scripts/run-scheduled.js", "scripts/lib/official-notices.js",
    "scripts/lib/official-pdf.js", "scripts/lib/announcement-index.js", "scripts/lib/query.js", "scripts/lib/report.js",
    "scripts/check-git-history.js", "scripts/check-github-releases.js"
  ];
  required.forEach((name) => {
    if (!fs.existsSync(path.join(root, name))) errors.push(`缺少文件：${name}`);
  });
  const skillPath = path.join(root, "SKILL.md");
  if (fs.existsSync(skillPath)) {
    const skill = fs.readFileSync(skillPath, "utf8");
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) errors.push("SKILL.md 缺少 YAML frontmatter");
    else {
      const keys = frontmatter[1].split("\n")
        .filter((line) => /^[A-Za-z][A-Za-z0-9-]*:/.test(line))
        .map((line) => line.split(":", 1)[0]);
      const allowedKeys = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
      keys.filter((key) => !allowedKeys.has(key)).forEach((key) => errors.push(`SKILL.md 含非标准 frontmatter 字段：${key}`));
      if (!/^name:\s*qdii-purchase-limits\s*$/m.test(frontmatter[1])) errors.push("Skill name 不正确");
      if (!/^description:\s*Use when /m.test(frontmatter[1])) errors.push("description 必须以 Use when 开头");
      if (!/^license:\s*MIT\s*$/m.test(frontmatter[1])) errors.push("frontmatter 未声明 MIT");
    }
    if (skill.split("\n").length > 500) errors.push("SKILL.md 超过 500 行");
    if (!/必须实际运行 `scripts\/query-purchase-limits\.js`/.test(skill)) errors.push("SKILL.md 缺少强制脚本执行约束");
    if (!/唯一入口[\s\S]*标准输出原样回复/.test(skill)) errors.push("SKILL.md 缺少确定性查询入口或原样输出约束");
    if (!/不得用其他网页工具替代脚本/.test(skill)) errors.push("SKILL.md 缺少禁止模型自行浏览替代脚本的约束");
    if (!/无法执行 Node\.js[\s\S]*不得模拟/.test(skill)) errors.push("SKILL.md 缺少不可执行时的降级约束");
    if (!/默认固定输出四个区块[\s\S]*代销渠道｜纳斯达克100[\s\S]*基金公司直销｜纳斯达克100[\s\S]*代销渠道｜标普500[\s\S]*基金公司直销｜标普500/.test(skill)) errors.push("SKILL.md 缺少四区块固定输出顺序");
  }
  const licensePath = path.join(root, "LICENSE");
  if (fs.existsSync(licensePath) && !/MIT License/.test(fs.readFileSync(licensePath, "utf8"))) errors.push("LICENSE 不是 MIT");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) errors.push("需要 Node.js 22+");
  const packagePath = path.join(root, "package.json");
  if (fs.existsSync(packagePath)) {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    const lockPath = path.join(root, "package-lock.json");
    const lockJson = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, "utf8")) : null;
    const skill = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, "utf8") : "";
    const skillVersion = skill.match(/^\s+version:\s*["']?([^"'\s]+)["']?\s*$/m);
    if (!lockJson || lockJson.version !== packageJson.version || !lockJson.packages || lockJson.packages[""].version !== packageJson.version) {
      errors.push("package.json 与 package-lock.json 版本不一致");
    }
    if (!skillVersion || skillVersion[1] !== packageJson.version) errors.push("SKILL.md 与 package.json 版本不一致");
    if (!packageJson.dependencies || packageJson.dependencies["pdfjs-dist"] !== "4.8.69") errors.push("pdfjs-dist 必须锁定为已验证版本 4.8.69");
    if (!packageJson.engines || packageJson.engines.node !== ">=22") errors.push("package.json 必须要求 Node.js 22+");
  }
  const readmePath = path.join(root, "README.md");
  if (fs.existsSync(readmePath)) {
    const readme = fs.readFileSync(readmePath, "utf8");
    ["Qwen Code", "Kimi Code CLI", "CodeBuddy Code", "Qoder IDE / CLI", "CodeArts Doer", "WorkBuddy", "TRAE / TRAE CN"].forEach((name) => {
      if (!readme.includes(name)) errors.push(`README 缺少国产 Agent 适配说明：${name}`);
    });
    ["~/.qwen/skills/", "~/.kimi-code/skills/", "~/.codebuddy/skills/", "~/.qoder/skills/", "~/.codeartsdoer/skills/"].forEach((directory) => {
      if (!readme.includes(directory)) errors.push(`README 缺少国产 Agent 安装目录：${directory}`);
    });
  }
  const workflowPath = path.join(root, ".github", "workflows", "test.yml");
  if (fs.existsSync(workflowPath)) {
    const workflow = fs.readFileSync(workflowPath, "utf8");
    if (!/node-version: \[22, 24\]/.test(workflow)) errors.push("GitHub Actions 必须测试 Node.js 22 和 24");
    if (!/actions\/checkout@[0-9a-f]{40} # v7\.0\.0/.test(workflow)) errors.push("actions/checkout 必须固定到已审核的 v7.0.0 提交");
    if (!/actions\/setup-node@[0-9a-f]{40} # v6\.4\.0/.test(workflow)) errors.push("actions/setup-node 必须固定到已审核的 v6.4.0 提交");
    if (!/check-git-history\.js --public-release/.test(workflow)) errors.push("GitHub Actions 必须执行公开发布模式的完整历史扫描");
    if (!/check-github-releases\.js/.test(workflow)) errors.push("GitHub Actions 必须审计 GitHub Release 元数据和附件");
  }
  const dependabotPath = path.join(root, ".github", "dependabot.yml");
  if (fs.existsSync(dependabotPath)) {
    const dependabot = fs.readFileSync(dependabotPath, "utf8");
    if (!/package-ecosystem:\s*npm/.test(dependabot)) errors.push("Dependabot 必须检查 npm 依赖");
  }

  const files = filesUnder(root);
  files.filter((file) => {
    const relative = path.relative(root, file);
    return !relative.startsWith(`tests${path.sep}`) && relative !== path.join("scripts", "check-release.js");
  }).forEach((file) => {
    const text = fs.readFileSync(file, "utf8");
    const relative = path.relative(root, file);
    const unixHomePattern = new RegExp(["", "Users", ""].join("\\/"));
    if (unixHomePattern.test(text) || /[A-Za-z]:\\|(?:require|path\.join|cwd)[^\n]{0,80}["'`]old(?:\/|["'`])/m.test(text)) errors.push(`${relative} 含本机绝对路径或非公开工程依赖`);
    if (/(?:ghp_|sk-[A-Za-z0-9]{20,}|BEGIN (?:RSA |EC )?PRIVATE KEY)/.test(text)) errors.push(`${relative} 疑似包含凭据`);
  });

  if (settings.runTests && !errors.length) {
    const testFiles = files.filter((file) => file.endsWith(".test.js"));
    const result = childProcess.spawnSync(process.execPath, ["--test", ...testFiles], { cwd: root, encoding: "utf8" });
    if (result.status !== 0) errors.push(`离线测试失败\n${result.stdout}${result.stderr}`);
  }
  return { errors, checkedFiles: files.length };
}

function main() {
  const root = path.resolve(__dirname, "..");
  const result = checkRelease(root, { runTests: true });
  if (result.errors.length) {
    result.errors.forEach((error) => console.error(`FAIL: ${error}`));
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS: ${result.checkedFiles} files checked; static files and offline tests passed.\n`);
  }
}

if (require.main === module) main();

module.exports = { checkRelease, filesUnder, main };
