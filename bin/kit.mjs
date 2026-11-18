#!/usr/bin/env node
// agent-kit: adopt, check and sync a repository against this kit version.
// Exit codes: 0 pass, 1 fail, 2 could not verify.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
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
  "Skill vetting", "Session budget",
];
const DOCS_ROOT_ALLOWED = new Set([
  "README.md", "STATUS.md", "TESTING.md", "SECURITY.md", "ROADMAP.md",
  "plans", "operations", "decisions", "history",
]);
const IGNORED_NAMES = new Set([".DS_Store"]);
const LIST_KEYS = ["modules", "human_only_paths", "design_triggers", "never_run", "allowed_extra_docs"];
const SCALAR_KEYS = ["base_branch", "ci_job", "scan_command"];
const SETTINGS_PATH = ".claude/settings.json";
const REQUIRED_HOOKS = [
  { event: "SessionStart", script: ".agent/freshness.mjs" },
  { event: "UserPromptSubmit", script: ".agent/skill-gate.mjs" },
  { event: "PreToolUse", script: ".agent/guard.mjs" },
];
// Settings a policy may leave out. A policy written before they existed stays valid.
const OPTIONAL_SCALAR_KEYS = ["profile", "profile_reason", "setup_command", "review_trigger", "agents_md_words"];
// When the agent-brief workflow starts a review. It never starts one because commits were pushed.
export const REVIEW_TRIGGERS = ["manual", "label", "ready"];

// Each profile adds to the one before it. Exposure sets the security floor, stakes set
// the amount of process. A repo with no profile keeps the full requirements above.
const KIT_CHECK = ".github/workflows/kit-check.yml";
const SCAN = ".agent/repository-scan.mjs";
const FRESHNESS = ".agent/freshness.mjs";
const PROFILE_STEPS = {
  sandbox: {
    reviewTrigger: "manual",
    agentsMdWords: 300,
    docs: ["AGENTS.md", "CLAUDE.md", "README.md"],
    sections: ["Repository", "Safety rules", "Skill vetting"],
    ci: false,
    // Core files a profile doesn't need: not installed, not required, checked only if present.
    optional: [KIT_CHECK, SCAN, FRESHNESS],
    modules: ["core"],
    checklist: [],
  },
  personal: {
    reviewTrigger: "label",
    agentsMdWords: 600,
    docs: ["docs/README.md", "docs/STATUS.md", "docs/TESTING.md"],
    sections: ["Start here", "Working standard", "Session budget"],
    ci: true,
    optional: [KIT_CHECK],
    modules: ["core", "review"],
    checklist: [],
  },
  public: {
    reviewTrigger: "ready",
    agentsMdWords: 800,
    docs: ["ARCHITECTURE.md", "docs/operations/deploy.md"],
    sections: ["Engineering invariants"],
    ci: true,
    optional: [],
    modules: ["core", "review", "triage"],
    checklist: [
      "Protect the base branch on GitHub: require a pull request before merging.",
      "Make the ci and kit-check jobs required status checks.",
      "Block force pushes and deletion of the base branch.",
      "Turn on GitHub secret scanning and push protection.",
    ],
  },
  product: {
    reviewTrigger: "ready",
    agentsMdWords: 1000,
    docs: ["docs/SECURITY.md", "docs/PRIVACY.md", "docs/operations/rollback.md"],
    sections: [],
    ci: true,
    optional: [],
    modules: ["core", "review", "triage"],
    checklist: [
      "Run agents in a sandbox (container, VM or cloud session) that has no production access.",
      "Keep production credentials separate: agents and CI test jobs get only dev or test keys.",
      "Check dependencies on every PR, for example Dependabot alerts or npm audit in CI.",
      "Scan the whole git history for secrets once, for example gitleaks git, and rotate anything found.",
    ],
  },
};
export const PROFILES = Object.keys(PROFILE_STEPS);
const KIT_DOCS = new Set([...REQUIRED_DOCS, ...Object.values(PROFILE_STEPS).flatMap((step) => step.docs)]);

// What a profile requires. No profile means today's full requirements.
export function requirements(profile) {
  if (!profile) {
    return {
      docs: REQUIRED_DOCS, sections: AGENTS_SECTIONS, ci: true, optional: new Set(),
      modules: ["core", "review", "triage"], checklist: [], reviewTrigger: "ready", agentsMdWords: null,
    };
  }
  const steps = PROFILES.slice(0, PROFILES.indexOf(profile) + 1).map((name) => PROFILE_STEPS[name]);
  const sections = new Set(steps.flatMap((step) => step.sections));
  return {
    docs: steps.flatMap((step) => step.docs),
    sections: AGENTS_SECTIONS.filter((name) => sections.has(name)),
    ci: steps.at(-1).ci,
    optional: new Set(steps.at(-1).optional),
    modules: steps.at(-1).modules,
    checklist: steps.flatMap((step) => step.checklist),
    reviewTrigger: steps.at(-1).reviewTrigger,
    agentsMdWords: steps.at(-1).agentsMdWords,
  };
}

// The review trigger and AGENTS.md word budget that apply, and whether the policy set them.
export function costSettings(policy) {
  const needs = requirements(policy.profile);
  return {
    trigger: policy.review_trigger ?? needs.reviewTrigger,
    triggerSet: "review_trigger" in policy,
    defaultTrigger: needs.reviewTrigger,
    budget: "agents_md_words" in policy ? Number(policy.agents_md_words) : needs.agentsMdWords,
    budgetSet: "agents_md_words" in policy,
    defaultBudget: needs.agentsMdWords,
  };
}

export function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

const DELEGATE_SECTION = "Delegation";
const SUBAGENT_MODEL = "CLAUDE_CODE_SUBAGENT_MODEL";
const SUBAGENT_FORCE = "CLAUDE_CODE_SUBAGENT_MODEL_FORCE";

class CouldNotVerify extends Error {}

// The hooks whose scripts this repo installs. A profile that skips a script skips its hook.
function requiredHooks(managed) {
  return REQUIRED_HOOKS.filter(({ script }) => managed.has(script));
}

// Returns why .claude/settings.json doesn't register each required hook. Empty when it does.
function settingsProblems(repo, hooks = REQUIRED_HOOKS) {
  const path = join(repo, SETTINGS_PATH);
  if (!existsSync(path)) return [`${SETTINGS_PATH}: required file is missing`];
  let settings;
  try {
    settings = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [`${SETTINGS_PATH}: not valid JSON`];
  }
  return hooks.filter(({ event, script }) => {
    const groups = settings?.hooks?.[event];
    return !(Array.isArray(groups) && groups.some((group) =>
      Array.isArray(group?.hooks) && group.hooks.some((hook) =>
        typeof hook?.command === "string" && hook.command.includes(script))));
  }).map(({ event, script }) => `${SETTINGS_PATH}: no ${event} hook runs ${script}`);
}

// The settings template with only the hooks whose scripts this repo installs.
function renderSettings(text, managed) {
  const settings = JSON.parse(text);
  for (const { event, script } of REQUIRED_HOOKS) {
    if (!managed.has(script)) delete settings.hooks[event];
  }
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function printSettingsNotes(problems, managed) {
  if (!problems.length) return;
  for (const problem of problems) console.log(`NOTE ${problem}; left unchanged.`);
  const snippet = renderSettings(readFileSync(join(KIT_ROOT, "templates", SETTINGS_PATH), "utf8"), managed).trim();
  console.log(`Add these hooks:\n${snippet}`);
}

// Returns the "## <name>" section of the AGENTS.md template, up to the next section.
function templateSection(name) {
  const text = readFileSync(join(KIT_ROOT, "templates/AGENTS.md"), "utf8");
  const start = text.search(new RegExp(`^## ${name}\\s*$`, "m"));
  const rest = text.slice(start + 3);
  const next = rest.search(/^## /m);
  return text.slice(start, next < 0 ? undefined : start + 3 + next).trim();
}

// Prints required AGENTS.md sections an existing file lacks. The kit never edits that file.
function printSectionNotes(repo, needs) {
  const path = join(repo, "AGENTS.md");
  if (!existsSync(path)) return;
  const agents = readFileSync(path, "utf8");
  for (const section of needs.sections.filter((name) => !hasSection(agents, name))) {
    console.log(`NOTE AGENTS.md: missing section "## ${section}"; left unchanged. Add this section:\n`
      + dropMissingDocRows("AGENTS.md", templateSection(section), needs.docs));
  }
}

// Keeps the AGENTS.md template sections a profile requires, plus any the kit doesn't know.
function keepSections(text, sections) {
  const [head, ...parts] = text.split(/^(?=## )/m);
  const kept = parts.filter((part) => {
    const name = part.match(/^## (.+?)\s*$/m)[1];
    return !AGENTS_SECTIONS.includes(name) || sections.includes(name);
  });
  return `${(head + kept.join("")).trimEnd()}\n`;
}

// Drops template table rows that point at kit docs this profile doesn't create.
function dropMissingDocRows(path, text, docs) {
  const dir = posix.dirname(path);
  return text.split("\n").filter((line) => {
    if (!line.startsWith("|")) return true;
    const refs = [...line.matchAll(/`([^`]+\.md)`/g)].map(([, ref]) => posix.normalize(posix.join(dir, ref)));
    return refs.every((ref) => !KIT_DOCS.has(ref) || docs.includes(ref));
  }).join("\n");
}

function delegateSnippet(name) {
  return readFileSync(join(KIT_ROOT, "modules/delegate/snippets", name), "utf8").trim();
}

function hasSection(text, section) {
  return new RegExp(`^## ${section}\\s*$`, "m").test(text);
}

// Returns the body of "## <section>" up to the next "## " heading.
function sectionText(text, section) {
  const start = text.search(new RegExp(`^## ${section}\\s*$`, "m"));
  const rest = text.slice(start).split("\n").slice(1).join("\n");
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

// Returns what the delegate module still needs in AGENTS.md and .claude/settings.json.
// A missing or unreadable file is reported by the general checks, not here.
function delegateProblems(repo) {
  const problems = [];
  const agentsPath = join(repo, "AGENTS.md");
  if (existsSync(agentsPath)) {
    const agents = readFileSync(agentsPath, "utf8");
    if (!hasSection(agents, DELEGATE_SECTION)) {
      problems.push({ path: "AGENTS.md", text: `AGENTS.md: module delegate needs section "## ${DELEGATE_SECTION}"` });
    } else if (!/`verifier`/.test(sectionText(agents, DELEGATE_SECTION))) {
      problems.push({ path: "AGENTS.md", text: `AGENTS.md: section "## ${DELEGATE_SECTION}" must tell the main agent when to run \`verifier\`` });
    }
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
    // A quoted value may contain "#"; only a comment after the closing quote is dropped.
    const quoted = rawValue.match(/^("[^"]*"|'[^']*')(\s+#.*)?$/);
    const value = quoted ? quoted[1] : rawValue.replace(/\s+#.*$/, "");
    openList = null;
    if (key === "setup_command" && !parseScalar(value)) {
      throw new CouldNotVerify(`${POLICY_PATH} setting ${key} is empty; give a command or remove the line`);
    }
    if (!LIST_KEYS.includes(key) && !SCALAR_KEYS.includes(key) && !OPTIONAL_SCALAR_KEYS.includes(key)) {
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
  if ("profile" in policy && !PROFILES.includes(policy.profile)) {
    throw new CouldNotVerify(`${POLICY_PATH} has an unknown profile: "${policy.profile}" (use ${PROFILES.join(", ")})`);
  }
  if ("review_trigger" in policy && !REVIEW_TRIGGERS.includes(policy.review_trigger)) {
    throw new CouldNotVerify(`${POLICY_PATH} has an invalid review_trigger: "${policy.review_trigger}" (use ${REVIEW_TRIGGERS.join(", ")})`);
  }
  if ("agents_md_words" in policy && !/^[1-9]\d{0,5}$/.test(policy.agents_md_words)) {
    throw new CouldNotVerify(`${POLICY_PATH} setting agents_md_words must be a whole number of words, such as 600`);
  }
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

// The managed files this repo must carry: its modules' files, minus the ones its profile
// doesn't need. A file the profile doesn't need is still checked when the repo has it.
function expectedManaged(repo, policy) {
  const files = managedFiles(policy.modules);
  for (const path of requirements(policy.profile).optional) {
    if (!existsSync(join(repo, path))) files.delete(path);
  }
  return files;
}

function buildLock(modules, managed) {
  const files = {};
  for (const [path, source] of [...managed].sort(([a], [b]) => (a < b ? -1 : 1))) {
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

  const needs = requirements(policy.profile);
  const expected = expectedManaged(repo, policy);
  for (const doc of needs.docs) {
    if (!existsSync(join(repo, doc))) failures.push(`${doc}: required file is missing`);
  }
  if (existsSync(join(repo, "CLAUDE.md"))
    && readFileSync(join(repo, "CLAUDE.md"), "utf8").trim() !== "@AGENTS.md") {
    failures.push("CLAUDE.md: must contain only @AGENTS.md");
  }
  if (existsSync(join(repo, "AGENTS.md"))) {
    const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
    for (const section of needs.sections) {
      if (!hasSection(agents, section)) failures.push(`AGENTS.md: missing section "## ${section}"`);
    }
    // Agents load AGENTS.md at the start of every session, so its length is paid on every task.
    const { budget, budgetSet } = costSettings(policy);
    const words = countWords(agents);
    if (budget && words > budget) {
      const from = budgetSet ? "agents_md_words" : `the ${policy.profile} profile`;
      warnings.push(`AGENTS.md: ${words} words, over the budget of ${budget} from ${from}. `
        + "Every agent session loads it; move detail into docs/ and link to it");
    }
  }
  failures.push(...settingsProblems(repo, requiredHooks(expected)));
  if (policy.modules.includes("delegate")) {
    failures.push(...delegateProblems(repo).map((problem) => problem.text));
  }

  const extras = new Set((policy.allowed_extra_docs ?? []).map((path) => path.replace(/\/$/, "")));
  // A doc the profile requires is part of its layout, such as docs/PRIVACY.md for product.
  for (const doc of needs.docs) {
    if (doc.startsWith("docs/")) extras.add(doc.split("/").slice(0, 2).join("/"));
  }
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

  const ciFiles = workflowFiles(repo, managedFiles(policy.modules));
  const ciTexts = ciFiles.map((path) => readFileSync(join(repo, path), "utf8"));
  if (needs.ci && !ciTexts.some((text) => hasJob(text, policy.ci_job))) {
    failures.push(`.github/workflows: no project workflow has the job "${policy.ci_job}"`);
  }
  if (needs.ci && !ciTexts.some((text) => text.includes(policy.scan_command))) {
    failures.push(`.github/workflows: no project workflow runs "${policy.scan_command}"`);
  }

  for (const doc of needs.docs) {
    const path = join(repo, doc);
    if (existsSync(path) && readFileSync(path, "utf8").includes("TODO(adopt)")) {
      warnings.push(`${doc}: still has TODO(adopt) placeholders`);
    }
  }
  if (latestVersion && latestVersion !== lock.version) {
    warnings.push(`kit ${latestVersion} is available; this repo is on ${lock.version}`);
  }
  return { failures, warnings, version: lock.version, unverified: needs.checklist };
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

// Renders one starting project file for this repo's profile and modules.
function renderProjectFile(path, { project, needs, managed, delegate }) {
  let text = renderTemplate(readFileSync(join(KIT_ROOT, "templates", path), "utf8"), project);
  if (path === "AGENTS.md") text = keepSections(text, needs.sections);
  if (path.endsWith(".md")) text = dropMissingDocRows(path, text, needs.docs);
  if (path === SETTINGS_PATH) text = renderSettings(text, managed);
  return delegate ? withDelegate(path, text) : text;
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

// Sets the profile lines in policy text, after its opening comments. Nothing else changes.
function withProfile(text, profile, reason) {
  const lines = text.split("\n").filter((line) => !/^profile(_reason)?:/.test(line));
  const at = lines.findIndex((line) => !line.startsWith("#"));
  lines.splice(at, 0, `profile: ${profile}`, `profile_reason: "${reason}"`);
  return lines.join("\n");
}

function writeRepoFile(repo, path, data) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, data);
}

function differs(repo, path, source) {
  return sha256(readFileSync(join(repo, path))) !== sha256(readFileSync(source));
}

// Shows when agent-brief reviews and the AGENTS.md word budget, so their cost is visible.
function printCostSettings(policy) {
  const cost = costSettings(policy);
  const name = policy.profile ?? "no profile";
  const trigger = cost.triggerSet
    ? `${cost.trigger} (set in ${POLICY_PATH}; the ${name} default is ${cost.defaultTrigger})`
    : `${cost.trigger} (default for ${name}; set review_trigger in ${POLICY_PATH} to change it)`;
  console.log(`TRIGGER agent-brief review_trigger: ${trigger}. Used only when the triage module is on.`);
  const fallback = cost.defaultBudget ? `${cost.defaultBudget} words` : "none";
  const budget = cost.budgetSet
    ? `${cost.budget} words (set in ${POLICY_PATH}; the ${name} default is ${fallback})`
    : cost.budget
      ? `${cost.budget} words (default for ${name}; set agents_md_words in ${POLICY_PATH} to change it)`
      : `none (no profile; set agents_md_words in ${POLICY_PATH} to add one)`;
  console.log(`BUDGET AGENTS.md: ${budget}. kit check warns above it.`);
}

function printChecklist(needs) {
  if (!needs.checklist.length) return;
  console.log("CHECKLIST kit check can't verify these settings. Do them by hand:");
  for (const item of needs.checklist) console.log(`  [ ] ${item}`);
}

// policyText, when given, comes from kit init and replaces whatever policy the repo has.
function adopt(repo, options, policyText = null) {
  const policyExists = existsSync(join(repo, POLICY_PATH));
  let policy;
  if (policyText !== null) {
    policy = validatePolicy(parsePolicy(policyText));
  } else {
    const existing = policyExists ? readPolicy(repo) : null;
    const modules = options.modules ?? existing?.modules ?? requirements().modules;
    const baseBranch = options["base-branch"] ?? existing?.base_branch ?? "main";
    const ciJob = options["ci-job"] ?? existing?.ci_job ?? "ci";
    const scanCommand = options["scan-command"] ?? existing?.scan_command ?? DEFAULT_SCAN;
    const text = renderPolicy({ modules, baseBranch, ciJob, scanCommand });
    policy = existing ?? validatePolicy(parsePolicy(text));
    if (!policyExists) policyText = text;
  }
  const needs = requirements(policy.profile);
  const project = resolve(repo).split(sep).pop();

  const managed = expectedManaged(repo, policy);
  const delegate = policy.modules.includes("delegate");
  const creates = [];
  const conflicts = [];
  for (const [path, source] of managed) {
    if (!existsSync(join(repo, path))) creates.push(path);
    else if (differs(repo, path, source)) conflicts.push(path);
  }
  const projectFiles = new Map();
  if (policyText !== null) projectFiles.set(POLICY_PATH, policyText);
  for (const path of [...needs.docs, ".agent/lessons.md", SETTINGS_PATH]) {
    if (!existsSync(join(repo, path))) {
      projectFiles.set(path, renderProjectFile(path, { project, needs, managed, delegate }));
    }
  }
  const ciPresent = workflowFiles(repo, managedFiles(policy.modules))
    .some((path) => hasJob(readFileSync(join(repo, path), "utf8"), policy.ci_job));
  if (needs.ci && !ciPresent) {
    const ciPath = ".github/workflows/ci.yml";
    if (existsSync(join(repo, ciPath))) {
      console.log(`NOTE ${ciPath} exists without job "${policy.ci_job}"; left unchanged`);
    } else {
      projectFiles.set(ciPath, renderCi(repo, policy.ci_job, policy.scan_command, policy.base_branch));
    }
  }
  if (!projectFiles.has(SETTINGS_PATH)) printSettingsNotes(settingsProblems(repo, requiredHooks(managed)), managed);
  if (!projectFiles.has("AGENTS.md")) printSectionNotes(repo, needs);
  if (delegate) printDelegateNotes(delegateProblems(repo).filter((problem) => !projectFiles.has(problem.path)));

  for (const path of creates) console.log(`CREATE managed ${path}`);
  for (const path of projectFiles.keys()) {
    console.log(`${existsSync(join(repo, path)) ? "UPDATE" : "CREATE"} project ${path}`);
  }
  for (const path of conflicts) console.log(`REPLACE managed ${path} (differs from the kit)`);
  for (const path of ignoredPaths(repo, [...managed.keys()])) {
    console.log(`WARN ${path} is gitignored; add a .gitignore exception so CI can see it`);
  }
  printChecklist(needs);

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
  writeRepoFile(repo, LOCK_PATH, `${JSON.stringify(buildLock(policy.modules, managed), null, 2)}\n`);
  console.log(`DONE adopted kit ${VERSION}. Review the changes, then run kit check.`);
  return 0;
}

export const QUESTIONS = [
  { key: "goal", text: "What is this repo for?", choices: ["learning", "personal-tool", "showcase", "product"] },
  { key: "users", text: "Who uses it?", choices: ["only-me", "invited", "anyone"] },
  { key: "public", text: "Is the repository public?", choices: ["yes", "no"] },
  { key: "deployed", text: "Is anything from it deployed or running for real?", choices: ["yes", "no"] },
  {
    key: "data",
    text: "What data does it hold? (personal = your own personal or private data, others = other people's)",
    choices: ["none", "personal", "others"],
  },
  {
    key: "services",
    text: "Does it use paid services, production credentials or payments?",
    choices: ["none", "paid", "credentials", "payments"],
  },
  { key: "recovery", text: "If it broke, how hard would recovery be?", choices: ["easy", "moderate", "hard"] },
];

// The riskiest answer wins. Returns the profile and the answers that decided it.
export function recommend(answers) {
  const rules = [
    ["product", answers.data === "others", "it holds other people's data"],
    ["product", answers.services === "payments", "it takes payments"],
    ["product", answers.goal === "product", "it is a product with other people's accounts"],
    ["public", answers.public === "yes", "the repository is public"],
    ["public", answers.deployed === "yes" && answers.users === "anyone", "it is a live site anyone can use"],
    ["public", answers.goal === "showcase", "it is meant to be shown publicly"],
    ["personal", answers.deployed === "yes", "something is deployed"],
    ["personal", answers.data === "personal", "it holds real personal data"],
    ["personal", answers.services === "paid", "it uses paid services"],
    ["personal", answers.services === "credentials", "it uses production credentials"],
    ["personal", answers.users === "invited", "invited people use it"],
    ["personal", answers.recovery === "hard", "recovery would be hard"],
  ].filter(([, hit]) => hit);
  const profile = rules.reduce((best, [name]) =>
    (PROFILES.indexOf(name) > PROFILES.indexOf(best) ? name : best), "sandbox");
  const reasons = rules.filter(([name]) => name === profile).map(([, , reason]) => reason);
  return { profile, reasons: reasons.length ? reasons : ["nothing is public, deployed, or holds real data or money"] };
}

// Answers come from flags. Missing ones are asked only when a person is at a terminal.
async function collectAnswers(options) {
  const answers = {};
  const missing = [];
  for (const question of QUESTIONS) {
    const value = options[question.key];
    if (value === undefined) missing.push(question);
    else if (question.choices.includes(value)) answers[question.key] = value;
    else throw new CouldNotVerify(`--${question.key} must be one of ${question.choices.join(", ")}, not "${value}"`);
  }
  if (!missing.length) return answers;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CouldNotVerify(`no terminal to ask, so pass every answer as a flag. Missing: ${
      missing.map((question) => `--${question.key} ${question.choices.join("|")}`).join(", ")}`);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const question of missing) {
      let value;
      while (!question.choices.includes(value)) {
        value = (await prompt.question(`${question.text} [${question.choices.join("/")}] `)).trim();
      }
      answers[question.key] = value;
    }
  } finally {
    prompt.close();
  }
  return answers;
}

// Applies --profile and --reason. A lighter profile than recommended needs a reason.
function chooseProfile(recommended, options) {
  const reason = options.reason?.trim();
  if (reason !== undefined && (!reason || /["\n\r]/.test(reason))) {
    throw new CouldNotVerify("--reason must be one line of text without double quotes");
  }
  if (!options.profile) {
    if (reason) throw new CouldNotVerify("--reason goes with --profile");
    return { profile: recommended.profile, reason: `recommended: ${recommended.reasons.join("; ")}` };
  }
  if (!PROFILES.includes(options.profile)) {
    throw new CouldNotVerify(`unknown profile "${options.profile}" (use ${PROFILES.join(", ")})`);
  }
  const lighter = PROFILES.indexOf(options.profile) < PROFILES.indexOf(recommended.profile);
  if (lighter && !reason) return null;
  if (options.profile === recommended.profile) {
    return { profile: options.profile, reason: reason ?? `recommended: ${recommended.reasons.join("; ")}` };
  }
  const how = lighter ? "lighter" : "stricter";
  return { profile: options.profile, reason: `${how} than recommended ${recommended.profile}: ${reason ?? "chosen by hand"}` };
}

// Required paths for a profile that the repo has now, used to show what a change drops.
function requiredPaths(repo, policy) {
  return [...requirements(policy.profile).docs, ...expectedManaged(repo, policy).keys()];
}

async function init(repo, options) {
  const policyExists = existsSync(join(repo, POLICY_PATH));
  if (options.reassess && !policyExists) {
    throw new CouldNotVerify(`${POLICY_PATH} is missing; run kit init without --reassess first`);
  }
  if (!options.reassess && policyExists) {
    console.log(`FAIL ${POLICY_PATH} already exists. Run kit init --reassess to review its profile.`);
    return 1;
  }
  const current = options.reassess ? readPolicy(repo) : null;
  const answers = await collectAnswers(options);
  console.log(`ANSWERS ${QUESTIONS.map(({ key }) => `${key}=${answers[key]}`).join(" ")}`);
  const recommended = recommend(answers);
  console.log(`RECOMMEND ${recommended.profile}, because ${recommended.reasons.join("; ")}`);
  const choice = chooseProfile(recommended, options);
  if (!choice) {
    console.log(`FAIL --profile ${options.profile} is lighter than the recommended ${recommended.profile}. `
      + "Add --reason to record why.");
    return 1;
  }
  console.log(`PROFILE ${choice.profile} (${choice.reason})`);

  if (!current) {
    const modules = options.modules ?? requirements(choice.profile).modules;
    const text = renderPolicy({
      modules,
      baseBranch: options["base-branch"] ?? "main",
      ciJob: options["ci-job"] ?? "ci",
      scanCommand: options["scan-command"] ?? DEFAULT_SCAN,
    });
    printCostSettings({ profile: choice.profile });
    return adopt(repo, options, withProfile(text, choice.profile, choice.reason));
  }

  console.log(`CHANGE profile ${current.profile ?? "none (full requirements)"} -> ${choice.profile}`);
  const next = { ...current, profile: choice.profile };
  printCostSettings(next);
  const kept = new Set(requiredPaths(repo, next));
  for (const path of requiredPaths(repo, current)) {
    if (!kept.has(path) && existsSync(join(repo, path))) {
      console.log(`NOTE ${path}: no longer required by ${choice.profile}; left in place`);
    }
  }
  const policyText = withProfile(readFileSync(join(repo, POLICY_PATH), "utf8"), choice.profile, choice.reason);
  return adopt(repo, options, policyText);
}

function sync(repo, options) {
  const policy = readPolicy(repo);
  const lock = readLock(repo);
  const needs = requirements(policy.profile);
  const managed = expectedManaged(repo, policy);
  const updates = [];
  for (const [path, source] of managed) {
    if (!existsSync(join(repo, path)) || differs(repo, path, source)) updates.push(path);
  }
  const removals = Object.keys(lock.files)
    .filter((path) => !managed.has(path) && existsSync(join(repo, path)));
  for (const path of updates) console.log(`UPDATE ${path}`);
  for (const path of removals) console.log(`REMOVE ${path}`);
  printSettingsNotes(settingsProblems(repo, requiredHooks(managed)), managed);
  printSectionNotes(repo, needs);
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
  writeRepoFile(repo, LOCK_PATH, `${JSON.stringify(buildLock(policy.modules, managed), null, 2)}\n`);
  console.log(`DONE synced to kit ${VERSION}. Review the branch, then open a PR.`);
  return 0;
}

function check(repo, options) {
  const { failures, warnings, version, unverified } = runCheck(repo, { latestVersion: options["latest-version"] });
  for (const warning of warnings) console.log(`WARN ${warning}`);
  for (const item of unverified) console.log(`NOTE not verified by kit check: ${item}`);
  for (const failure of failures) console.log(`FAIL ${failure}`);
  if (failures.length) return 1;
  console.log(`PASS repository matches kit ${version}`);
  return 0;
}

function parseArgs(argv) {
  const flags = new Set(["write", "replace-managed", "reassess"]);
  const values = new Set([
    "repo", "modules", "ci-job", "scan-command", "base-branch", "latest-version", "profile", "reason",
    ...QUESTIONS.map(({ key }) => key),
  ]);
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

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const commands = { adopt, check, init, sync };
  if (!commands[command]) {
    console.log("Usage: kit.mjs <init|adopt|check|sync> [--repo PATH] [--write] [options]");
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
    return await commands[command](repo, options);
  } catch (error) {
    // Any failure inside a check means the result is unknown, not clean.
    const reason = error instanceof CouldNotVerify ? error.message : `${error.code ?? error.name}: ${error.message}`;
    console.log(`COULD NOT VERIFY ${reason}`);
    return 2;
  }
}

// realpath: on macOS, temp and home paths can be symlinks, and a plain compare would silently skip main().
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
