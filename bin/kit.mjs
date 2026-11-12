#!/usr/bin/env node
// agent-kit: adopt, check and sync a repository against this kit version.
// Exit codes: 0 pass, 1 fail, 2 could not verify.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = readFileSync(join(KIT_ROOT, "VERSION"), "utf8").trim();
const MODULE_NAMES = readdirSync(join(KIT_ROOT, "modules")).filter((name) =>
  statSync(join(KIT_ROOT, "modules", name)).isDirectory());
const MODULE_DEPENDS = { triage: ["review"] };

const POLICY_PATH = ".agent/policy.yml";
const LOCK_PATH = ".agent/kit.lock";
const DEFAULT_SCAN = "node .agent/repository-scan.mjs";
const REQUIRED_DOCS = [
  "AGENTS.md", "CLAUDE.md", "README.md", "ARCHITECTURE.md",
  "docs/README.md", "docs/STATUS.md", "docs/TESTING.md",
];
const AGENTS_SECTIONS = [
  "Repository", "Start here", "Safety rules", "Engineering invariants", "Working standard",
  "Session budget",
];
const DOCS_ROOT_ALLOWED = new Set([
  "README.md", "STATUS.md", "TESTING.md", "SECURITY.md", "ROADMAP.md",
  "plans", "operations", "decisions", "history",
]);
const IGNORED_NAMES = new Set([".DS_Store"]);
const LIST_KEYS = ["modules", "human_only_paths", "design_triggers", "never_run", "allowed_extra_docs"];
const SCALAR_KEYS = ["base_branch", "ci_job", "scan_command"];
const TEMPLATE_FILES = [
  "AGENTS.md", "CLAUDE.md", "README.md", "ARCHITECTURE.md",
  "docs/README.md", "docs/STATUS.md", "docs/TESTING.md", ".agent/lessons.md",
  ".claude/settings.json",
];
const SETTINGS_PATH = ".claude/settings.json";
const FRESHNESS_SCRIPT = ".agent/freshness.mjs";
const DELEGATE_SECTION = "Delegation";
const SUBAGENT_MODEL = "CLAUDE_CODE_SUBAGENT_MODEL";
const SUBAGENT_FORCE = "CLAUDE_CODE_SUBAGENT_MODEL_FORCE";

class CouldNotVerify extends Error {}

// Returns why .claude/settings.json doesn't run the freshness hook at session start, or null.
function settingsProblem(repo) {
  const path = join(repo, SETTINGS_PATH);
  if (!existsSync(path)) return `${SETTINGS_PATH}: required file is missing`;
  let settings;
  try {
    settings = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return `${SETTINGS_PATH}: not valid JSON`;
  }
  const groups = settings?.hooks?.SessionStart;
  const registered = Array.isArray(groups) && groups.some((group) =>
    Array.isArray(group?.hooks) && group.hooks.some((hook) =>
      typeof hook?.command === "string" && hook.command.includes(FRESHNESS_SCRIPT)));
  return registered ? null : `${SETTINGS_PATH}: no SessionStart hook runs ${FRESHNESS_SCRIPT}`;
}

function settingsNote(problem) {
  const snippet = readFileSync(join(KIT_ROOT, "templates", SETTINGS_PATH), "utf8").trim();
  return `NOTE ${problem}; left unchanged. Add this hook:\n${snippet}`;
}

function delegateSnippet(name) {
  return readFileSync(join(KIT_ROOT, "modules/delegate/snippets", name), "utf8").trim();
}

function hasSection(text, section) {
  return new RegExp(`^## ${section}\\s*$`, "m").test(text);
}

// Returns what the delegate module still needs in AGENTS.md and .claude/settings.json.
// A missing or unreadable file is reported by the general checks, not here.
function delegateProblems(repo) {
  const problems = [];
  const agentsPath = join(repo, "AGENTS.md");
  if (existsSync(agentsPath) && !hasSection(readFileSync(agentsPath, "utf8"), DELEGATE_SECTION)) {
    problems.push({ path: "AGENTS.md", text: `AGENTS.md: module delegate needs section "## ${DELEGATE_SECTION}"` });
  }
  let settings = null;
  try {
    settings = JSON.parse(readFileSync(join(repo, SETTINGS_PATH), "utf8"));
  } catch {
    return problems;
  }
  const model = settings?.env?.[SUBAGENT_MODEL];
  if (typeof model !== "string" || !model.trim()) {
    problems.push({ path: SETTINGS_PATH, text: `${SETTINGS_PATH}: module delegate needs env.${SUBAGENT_MODEL}` });
  }
  if (settings?.env?.[SUBAGENT_FORCE] !== "1") {
    problems.push({ path: SETTINGS_PATH, text: `${SETTINGS_PATH}: module delegate needs env.${SUBAGENT_FORCE} set to "1"` });
  }
  return problems;
}

// Prints what to add by hand to project-owned files the kit won't edit.
function printDelegateNotes(problems) {
  const paths = new Set(problems.map((problem) => problem.path));
  for (const problem of problems) console.log(`NOTE ${problem.text}; left unchanged.`);
  if (paths.has("AGENTS.md")) console.log(`Add this section to AGENTS.md:\n${delegateSnippet("AGENTS.md")}`);
  if (paths.has(SETTINGS_PATH)) console.log(`Add these keys to ${SETTINGS_PATH}:\n${delegateSnippet("settings.json")}`);
}

// Adds the delegate module's parts to a project file the kit is creating.
function withDelegate(path, text) {
  if (path === "AGENTS.md") return `${text.trimEnd()}\n\n${delegateSnippet("AGENTS.md")}\n`;
  if (path === SETTINGS_PATH) {
    const settings = JSON.parse(text);
    settings.env = { ...settings.env, ...JSON.parse(delegateSnippet("settings.json")).env };
    return `${JSON.stringify(settings, null, 2)}\n`;
  }
  return text;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_NAMES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.isFile()) found.push(full);
    else throw new CouldNotVerify(`unsupported file type: ${full}`);
  }
  return found;
}

function toRepoPath(path) {
  return path.split(sep).join("/");
}

// Returns repo path -> absolute source path for the given modules.
function managedFiles(modules) {
  const files = new Map();
  for (const module of modules) {
    const root = join(KIT_ROOT, "modules", module, "files");
    for (const full of walk(root)) files.set(toRepoPath(relative(root, full)), full);
  }
  return files;
}

function parseScalar(raw) {
  const value = raw.trim();
  const quoted = value.match(/^(["'])(.*)\1$/);
  return quoted ? quoted[2] : value;
}

// Parses the small YAML subset policy.yml uses. Anything else is an error,
// so a policy this tool can't fully read never passes by accident.
export function parsePolicy(text) {
  const policy = {};
  let openList = null;
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(#.*)?$/.test(line)) return;
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (item && openList) {
      policy[openList].push(parseScalar(item[1]));
      return;
    }
    const pair = line.match(/^([a-z_]+):\s*(.*?)\s*$/);
    if (!pair) throw new CouldNotVerify(`${POLICY_PATH} line ${index + 1} is not understood`);
    const [, key, rawValue] = pair;
    const value = rawValue.replace(/\s+#.*$/, "");
    openList = null;
    if (!LIST_KEYS.includes(key) && !SCALAR_KEYS.includes(key)) {
      throw new CouldNotVerify(`${POLICY_PATH} has an unknown setting: ${key}`);
    }
    if (LIST_KEYS.includes(key)) {
      if (value === "") {
        policy[key] = [];
        openList = key;
      } else if (/^\[.*\]$/.test(value)) {
        const inner = value.slice(1, -1).trim();
        policy[key] = inner ? inner.split(",").map(parseScalar) : [];
      } else {
        throw new CouldNotVerify(`${POLICY_PATH} setting ${key} must be a list`);
      }
    } else {
      policy[key] = parseScalar(value);
    }
  });
  return policy;
}

function validatePolicy(policy) {
  for (const key of SCALAR_KEYS) {
    if (!policy[key]) throw new CouldNotVerify(`${POLICY_PATH} is missing ${key}`);
  }
  if (!Array.isArray(policy.modules)) throw new CouldNotVerify(`${POLICY_PATH} is missing modules`);
  if (!policy.modules.includes("core")) throw new CouldNotVerify(`${POLICY_PATH} modules must include core`);
  for (const module of policy.modules) {
    if (!MODULE_NAMES.includes(module)) throw new CouldNotVerify(`${POLICY_PATH} has an unknown module: ${module}`);
    for (const needed of MODULE_DEPENDS[module] ?? []) {
      if (!policy.modules.includes(needed)) {
        throw new CouldNotVerify(`module ${module} needs module ${needed}`);
      }
    }
  }
  return policy;
}

function readPolicy(repo) {
  const path = join(repo, POLICY_PATH);
  if (!existsSync(path)) throw new CouldNotVerify(`${POLICY_PATH} is missing`);
  return validatePolicy(parsePolicy(readFileSync(path, "utf8")));
}

function readLock(repo) {
  const path = join(repo, LOCK_PATH);
  if (!existsSync(path)) throw new CouldNotVerify(`${LOCK_PATH} is missing`);
  let lock;
  try {
    lock = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CouldNotVerify(`${LOCK_PATH} can't be parsed`);
  }
  if (typeof lock?.version !== "string" || !Array.isArray(lock.modules)
    || typeof lock.files !== "object" || lock.files === null) {
    throw new CouldNotVerify(`${LOCK_PATH} has the wrong shape`);
  }
  return lock;
}

function buildLock(modules) {
  const files = {};
  for (const [path, source] of [...managedFiles(modules)].sort(([a], [b]) => (a < b ? -1 : 1))) {
    files[path] = sha256(readFileSync(source));
  }
  return { version: VERSION, modules: [...modules].sort(), files };
}

function workflowFiles(repo, managed) {
  const dir = join(repo, ".github/workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => `.github/workflows/${name}`)
    .filter((path) => !managed.has(path));
}

function hasJob(text, job) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (start < 0) return false;
  return lines.slice(start + 1).some((line) => line === `  ${job}:` || line.startsWith(`  ${job}: `));
}

function moduleOfPath(path) {
  for (const module of MODULE_NAMES) {
    if (managedFiles([module]).has(path)) return module;
  }
  return null;
}

// Runs every check. Throws CouldNotVerify when a check itself can't run.
export function runCheck(repo, { latestVersion } = {}) {
  const failures = [];
  const warnings = [];
  const policy = readPolicy(repo);
  const lock = readLock(repo);
  if (lock.version !== VERSION) {
    throw new CouldNotVerify(`${LOCK_PATH} is on ${lock.version}, but this tool is ${VERSION}`);
  }

  for (const doc of REQUIRED_DOCS) {
    if (!existsSync(join(repo, doc))) failures.push(`${doc}: required file is missing`);
  }
  if (existsSync(join(repo, "CLAUDE.md"))
    && readFileSync(join(repo, "CLAUDE.md"), "utf8").trim() !== "@AGENTS.md") {
    failures.push("CLAUDE.md: must contain only @AGENTS.md");
  }
  if (existsSync(join(repo, "AGENTS.md"))) {
    const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
    for (const section of AGENTS_SECTIONS) {
      if (!hasSection(agents, section)) failures.push(`AGENTS.md: missing section "## ${section}"`);
    }
  }
  const settings = settingsProblem(repo);
  if (settings) failures.push(settings);
  if (policy.modules.includes("delegate")) {
    failures.push(...delegateProblems(repo).map((problem) => problem.text));
  }

  const extras = new Set((policy.allowed_extra_docs ?? []).map((path) => path.replace(/\/$/, "")));
  if (existsSync(join(repo, "docs"))) {
    for (const name of readdirSync(join(repo, "docs"))) {
      if (IGNORED_NAMES.has(name)) continue;
      const path = `docs/${name}`;
      if (/\d{4}-\d{2}-\d{2}/.test(name)) {
        failures.push(`${path}: dated reports belong in docs/history/`);
      } else if (!DOCS_ROOT_ALLOWED.has(name) && !extras.has(path)) {
        failures.push(`${path}: not part of the standard layout; declare it in allowed_extra_docs`);
      }
    }
  }

  const expected = managedFiles(policy.modules);
  const lockModules = [...lock.modules].sort().join(",");
  if (lockModules !== [...policy.modules].sort().join(",")) {
    failures.push(`${LOCK_PATH}: modules differ from ${POLICY_PATH}; run kit sync`);
  }

  for (const [path, source] of expected) {
    const repoFile = join(repo, path);
    if (!existsSync(repoFile)) {
      failures.push(`${path}: managed file is missing`);
      continue;
    }
    const hash = sha256(readFileSync(source));
    if (sha256(readFileSync(repoFile)) !== hash) failures.push(`${path}: differs from kit ${VERSION}`);
    if (lock.files[path] !== hash) failures.push(`${LOCK_PATH}: wrong or missing hash for ${path}`);
  }
  for (const path of Object.keys(lock.files)) {
    if (!expected.has(path)) failures.push(`${LOCK_PATH}: lists ${path}, which no enabled module provides`);
  }

  // Files from switched-off modules, and extra files inside managed skill folders.
  for (const module of MODULE_NAMES.filter((name) => !policy.modules.includes(name))) {
    for (const path of managedFiles([module]).keys()) {
      if (existsSync(join(repo, path))) failures.push(`${path}: belongs to module ${module}, which is off`);
    }
  }
  const managedSkillDirs = new Set(
    [...expected.keys()]
      .map((path) => path.match(/^\.claude\/skills\/[^/]+/)?.[0])
      .filter(Boolean),
  );
  for (const dir of managedSkillDirs) {
    if (!existsSync(join(repo, dir))) continue;
    for (const full of walk(join(repo, dir))) {
      const path = toRepoPath(relative(repo, full));
      if (!expected.has(path)) failures.push(`${path}: extra file inside a managed skill`);
    }
  }

  const ciFiles = workflowFiles(repo, expected);
  const ciTexts = ciFiles.map((path) => readFileSync(join(repo, path), "utf8"));
  if (!ciTexts.some((text) => hasJob(text, policy.ci_job))) {
    failures.push(`.github/workflows: no project workflow has the job "${policy.ci_job}"`);
  }
  if (!ciTexts.some((text) => text.includes(policy.scan_command))) {
    failures.push(`.github/workflows: no project workflow runs "${policy.scan_command}"`);
  }

  for (const doc of REQUIRED_DOCS) {
    const path = join(repo, doc);
    if (existsSync(path) && readFileSync(path, "utf8").includes("TODO(adopt)")) {
      warnings.push(`${doc}: still has TODO(adopt) placeholders`);
    }
  }
  if (latestVersion && latestVersion !== lock.version) {
    warnings.push(`kit ${latestVersion} is available; this repo is on ${lock.version}`);
  }
  return { failures, warnings, version: lock.version };
}

function git(repo, ...args) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8" });
}

function ignoredPaths(repo, paths) {
  return paths.filter((path) => git(repo, "check-ignore", "-q", path).status === 0);
}

function renderTemplate(text, project) {
  return text.replaceAll("{{PROJECT}}", project);
}

function ciStep(name, run) {
  return `      - name: ${name}\n        run: ${run}\n`;
}

// Writes a starting CI file from what the repo actually contains. The project owns it afterward.
export function renderCi(repo, job, scanCommand, baseBranch) {
  let steps = "";
  const packagePath = join(repo, "package.json");
  if (existsSync(packagePath)) {
    const scripts = JSON.parse(readFileSync(packagePath, "utf8")).scripts ?? {};
    steps += "      - uses: actions/setup-node@v4\n        with:\n          node-version: \"22\"\n";
    steps += ciStep("Install", existsSync(join(repo, "package-lock.json")) ? "npm ci" : "npm install");
    for (const script of ["typecheck", "lint", "test", "build"]) {
      if (scripts[script]) steps += ciStep(script, `npm run ${script}`);
    }
  } else if (existsSync(join(repo, "pyproject.toml")) || existsSync(join(repo, "requirements.txt"))) {
    steps += "      - uses: actions/setup-python@v5\n        with:\n          python-version: \"3.12\"\n";
    if (existsSync(join(repo, "requirements.txt"))) {
      steps += ciStep("Install", "python -m pip install -r requirements.txt");
    }
    steps += ciStep("Test", "python -m unittest discover");
  }
  steps += ciStep("Diff check", "git diff --check");
  steps += ciStep("Repository scan", scanCommand);
  return `name: ci

# Owned by this project. Run only checks that are safe and need no production credentials.

on:
  pull_request:
  push:
    branches: [${baseBranch}]

permissions:
  contents: read

jobs:
  ${job}:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
${steps}`;
}

function renderPolicy({ modules, baseBranch, ciJob, scanCommand }) {
  const template = readFileSync(join(KIT_ROOT, "templates/.agent/policy.yml"), "utf8");
  return template
    .replace("{{MODULES}}", modules.join(", "))
    .replace("{{BASE_BRANCH}}", baseBranch)
    .replace("{{CI_JOB}}", ciJob)
    .replace("{{SCAN_COMMAND}}", scanCommand);
}

function writeRepoFile(repo, path, data) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, data);
}

function differs(repo, path, source) {
  return sha256(readFileSync(join(repo, path))) !== sha256(readFileSync(source));
}

function adopt(repo, options) {
  const policyExists = existsSync(join(repo, POLICY_PATH));
  const existing = policyExists ? readPolicy(repo) : null;
  const modules = options.modules ?? existing?.modules ?? ["core", "review", "triage"];
  const baseBranch = options["base-branch"] ?? existing?.base_branch ?? "main";
  const ciJob = options["ci-job"] ?? existing?.ci_job ?? "ci";
  const scanCommand = options["scan-command"] ?? existing?.scan_command ?? DEFAULT_SCAN;
  const policyText = renderPolicy({ modules, baseBranch, ciJob, scanCommand });
  const policy = existing ?? validatePolicy(parsePolicy(policyText));
  const project = resolve(repo).split(sep).pop();

  const managed = managedFiles(policy.modules);
  const delegate = policy.modules.includes("delegate");
  const creates = [];
  const conflicts = [];
  for (const [path, source] of managed) {
    if (!existsSync(join(repo, path))) creates.push(path);
    else if (differs(repo, path, source)) conflicts.push(path);
  }
  const projectFiles = new Map();
  if (!policyExists) projectFiles.set(POLICY_PATH, policyText);
  for (const path of TEMPLATE_FILES) {
    if (!existsSync(join(repo, path))) {
      const text = renderTemplate(readFileSync(join(KIT_ROOT, "templates", path), "utf8"), project);
      projectFiles.set(path, delegate ? withDelegate(path, text) : text);
    }
  }
  const ciPresent = workflowFiles(repo, managed)
    .some((path) => hasJob(readFileSync(join(repo, path), "utf8"), policy.ci_job));
  if (!ciPresent) {
    const ciPath = ".github/workflows/ci.yml";
    if (existsSync(join(repo, ciPath))) {
      console.log(`NOTE ${ciPath} exists without job "${policy.ci_job}"; left unchanged`);
    } else {
      projectFiles.set(ciPath, renderCi(repo, policy.ci_job, policy.scan_command, policy.base_branch));
    }
  }
  if (!projectFiles.has(SETTINGS_PATH)) {
    const problem = settingsProblem(repo);
    if (problem) console.log(settingsNote(problem));
  }
  if (delegate) printDelegateNotes(delegateProblems(repo).filter((problem) => !projectFiles.has(problem.path)));

  for (const path of creates) console.log(`CREATE managed ${path}`);
  for (const path of projectFiles.keys()) console.log(`CREATE project ${path}`);
  for (const path of conflicts) console.log(`REPLACE managed ${path} (differs from the kit)`);
  for (const path of ignoredPaths(repo, [...managed.keys()])) {
    console.log(`WARN ${path} is gitignored; add a .gitignore exception so CI can see it`);
  }

  if (!options.write) {
    console.log("DRY RUN: nothing written. Add --write to apply.");
    return 0;
  }
  if (conflicts.length && !options["replace-managed"]) {
    console.log("FAIL managed files differ. Review them, then add --replace-managed.");
    return 1;
  }
  for (const [path, source] of managed) {
    if (creates.includes(path) || conflicts.includes(path)) writeRepoFile(repo, path, readFileSync(source));
  }
  for (const [path, text] of projectFiles) writeRepoFile(repo, path, text);
  writeRepoFile(repo, LOCK_PATH, `${JSON.stringify(buildLock(policy.modules), null, 2)}\n`);
  console.log(`DONE adopted kit ${VERSION}. Review the changes, then run kit check.`);
  return 0;
}

function sync(repo, options) {
  const policy = readPolicy(repo);
  const lock = readLock(repo);
  const managed = managedFiles(policy.modules);
  const updates = [];
  for (const [path, source] of managed) {
    if (!existsSync(join(repo, path)) || differs(repo, path, source)) updates.push(path);
  }
  const removals = Object.keys(lock.files)
    .filter((path) => !managed.has(path) && existsSync(join(repo, path)));
  for (const path of updates) console.log(`UPDATE ${path}`);
  for (const path of removals) console.log(`REMOVE ${path}`);
  const settings = settingsProblem(repo);
  if (settings) console.log(settingsNote(settings));
  if (policy.modules.includes("delegate")) printDelegateNotes(delegateProblems(repo));
  console.log(`Kit ${lock.version} -> ${VERSION}`);

  if (!options.write) {
    console.log("DRY RUN: nothing written. Add --write to apply.");
    return 0;
  }
  const branch = git(repo, "branch", "--show-current");
  if (branch.status !== 0) throw new CouldNotVerify("can't read the current git branch");
  const name = branch.stdout.trim();
  const defaultBranch = git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").stdout?.trim()
    .replace(/^origin\//, "");
  if (!name || name === policy.base_branch || name === defaultBranch) {
    console.log(`FAIL run sync on a review branch, not "${name || "detached HEAD"}"`);
    return 1;
  }
  for (const path of updates) writeRepoFile(repo, path, readFileSync(managed.get(path)));
  for (const path of removals) rmSync(join(repo, path));
  writeRepoFile(repo, LOCK_PATH, `${JSON.stringify(buildLock(policy.modules), null, 2)}\n`);
  console.log(`DONE synced to kit ${VERSION}. Review the branch, then open a PR.`);
  return 0;
}

function check(repo, options) {
  const { failures, warnings, version } = runCheck(repo, { latestVersion: options["latest-version"] });
  for (const warning of warnings) console.log(`WARN ${warning}`);
  for (const failure of failures) console.log(`FAIL ${failure}`);
  if (failures.length) return 1;
  console.log(`PASS repository matches kit ${version}`);
  return 0;
}

function parseArgs(argv) {
  const flags = new Set(["write", "replace-managed"]);
  const values = new Set(["repo", "modules", "ci-job", "scan-command", "base-branch", "latest-version"]);
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i].replace(/^--/, "");
    if (flags.has(name)) options[name] = true;
    else if (values.has(name) && argv[i + 1] !== undefined) options[name] = argv[(i += 1)];
    else throw new Error(`unknown or incomplete option: ${argv[i]}`);
  }
  if (options.modules) options.modules = options.modules.split(",").map((name) => name.trim());
  return options;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const commands = { adopt, check, sync };
  if (!commands[command]) {
    console.log("Usage: kit.mjs <adopt|check|sync> [--repo PATH] [--write] [options]");
    return 2;
  }
  let options;
  try {
    options = parseArgs(rest);
  } catch (error) {
    console.log(error.message);
    return 2;
  }
  const repo = resolve(options.repo ?? ".");
  try {
    return commands[command](repo, options);
  } catch (error) {
    // Any failure inside a check means the result is unknown, not clean.
    const reason = error instanceof CouldNotVerify ? error.message : `${error.code ?? error.name}: ${error.message}`;
    console.log(`COULD NOT VERIFY ${reason}`);
    return 2;
  }
}

// realpath: on macOS, temp and home paths can be symlinks, and a plain compare would silently skip main().
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
