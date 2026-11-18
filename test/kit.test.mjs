import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KIT = join(KIT_ROOT, "bin/kit.mjs");
const SCAN = join(KIT_ROOT, "modules/core/files/.agent/repository-scan.mjs");
const SKILL = ".claude/skills/ponytail-review/SKILL.md";
const temps = [];

after(() => temps.forEach((path) => rmSync(path, { recursive: true, force: true })));

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "agent-kit-test-"));
  temps.push(dir);
  return dir;
}

function kit(repo, ...args) {
  const result = spawnSync("node", [KIT, ...args, "--repo", repo], { encoding: "utf8" });
  return { status: result.status, out: result.stdout + result.stderr };
}

function git(repo, ...args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function adopted(modules = "core,review,triage") {
  const repo = tempDir();
  git(repo, "init", "-q", "-b", "main");
  const result = kit(repo, "adopt", "--modules", modules, "--write");
  assert.equal(result.status, 0, result.out);
  return repo;
}

function setPolicy(repo, key, value) {
  const path = join(repo, ".agent/policy.yml");
  const text = readFileSync(path, "utf8");
  writeFileSync(path, text.replace(new RegExp(`^${key}:.*$`, "m"), `${key}: ${value}`));
}

test("dry-run adopt writes nothing", () => {
  const repo = tempDir();
  const result = kit(repo, "adopt");
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /DRY RUN/);
  assert.match(result.out, /CREATE managed \.claude\/skills\/pr-triage\/SKILL\.md/);
  assert.equal(existsSync(join(repo, "AGENTS.md")), false);
  assert.equal(existsSync(join(repo, ".agent")), false);
});

test("fresh adopt passes, and warns about placeholders", () => {
  const repo = adopted();
  const result = kit(repo, "check");
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /PASS repository matches kit/);
  assert.match(result.out, /WARN AGENTS\.md: still has TODO\(adopt\)/);
});

test("the generated CI matches the repo's stack", () => {
  const repo = tempDir();
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { lint: "x", build: "y" } }));
  assert.equal(kit(repo, "adopt", "--write").status, 0);
  const ci = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /npm run lint/);
  assert.match(ci, /npm run build/);
  assert.doesNotMatch(ci, /npm run test/);
  assert.equal(kit(repo, "check").status, 0);
});

test("adopt leaves existing project files alone", () => {
  const repo = tempDir();
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "mine\n");
  assert.equal(kit(repo, "adopt", "--write").status, 0);
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "mine\n");
});

test("adopt refuses to replace a differing managed file without permission", () => {
  const repo = tempDir();
  mkdirSync(join(repo, ".claude/skills/pr-triage"), { recursive: true });
  const path = join(repo, ".claude/skills/pr-triage/SKILL.md");
  writeFileSync(path, "local version\n");
  const refused = kit(repo, "adopt", "--write");
  assert.equal(refused.status, 1, refused.out);
  assert.equal(readFileSync(path, "utf8"), "local version\n");
  assert.equal(existsSync(join(repo, "AGENTS.md")), false);
  assert.equal(kit(repo, "adopt", "--write", "--replace-managed").status, 0);
  assert.notEqual(readFileSync(path, "utf8"), "local version\n");
});

test("adopt warns when a managed file is gitignored", () => {
  const repo = tempDir();
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), ".claude/*\n");
  const result = kit(repo, "adopt");
  assert.match(result.out, /WARN \.claude\/skills\/pr-triage\/SKILL\.md is gitignored/);
});

test("editing a managed skill fails and names the file", () => {
  const repo = adopted();
  appendFileSync(join(repo, SKILL), "\nlocal edit\n");
  const result = kit(repo, "check");
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /FAIL \.claude\/skills\/ponytail-review\/SKILL\.md: differs from kit/);
});

test("editing a managed file and its lock hash together still fails", () => {
  const repo = adopted();
  appendFileSync(join(repo, SKILL), "\nlocal edit\n");
  const lockPath = join(repo, ".agent/kit.lock");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.files[SKILL] = "0".repeat(64);
  writeFileSync(lockPath, JSON.stringify(lock));
  assert.equal(kit(repo, "check").status, 1);
});

test("an extra file inside a managed skill fails", () => {
  const repo = adopted();
  writeFileSync(join(repo, ".claude/skills/ponytail-review/extra.md"), "x\n");
  const result = kit(repo, "check");
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /extra\.md: extra file inside a managed skill/);
});

test("a missing required doc fails", () => {
  const repo = adopted();
  rmSync(join(repo, "docs/STATUS.md"));
  const result = kit(repo, "check");
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /FAIL docs\/STATUS\.md: required file is missing/);
});

test("a missing AGENTS.md section fails", () => {
  const repo = adopted();
  const path = join(repo, "AGENTS.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("## Safety rules", "## Safety"));
  const result = kit(repo, "check");
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /missing section "## Safety rules"/);
});

test("a missing Session budget section fails", () => {
  const repo = adopted();
  const path = join(repo, "AGENTS.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("## Session budget", "## Budget"));
  const result = kit(repo, "check");
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /missing section "## Session budget"/);
});

const BRIEF_WORKFLOW = join(KIT_ROOT, "modules/triage/files/.github/workflows/agent-brief.yml");

function briefJob(name) {
  const text = readFileSync(BRIEF_WORKFLOW, "utf8");
  const match = text.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  (?:#|[a-z]+:)|(?![\\s\\S]))`, "m"));
  assert.ok(match, `job ${name} is missing`);
  return match[1];
}

test("agent-brief skips the review when the token is missing", () => {
  assert.match(briefJob("prepare"), /HAS_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN != '' \}\}/);
  assert.match(briefJob("review"), /if: needs\.prepare\.outputs\.present == 'true'/);
  assert.match(briefJob("publish"), /if: always\(\) && needs\.prepare\.outputs\.present == 'true'/);
  assert.match(briefJob("fix"), /uses: anthropics[\s\S]*/);
  assert.match(briefJob("fix"), /- id: claude\n\s+if: steps\.token\.outputs\.present == 'true'/);
});

test("the agent-brief review job can read but can't change anything", () => {
  const job = briefJob("review");
  assert.match(job, /permissions:\n\s+contents: read\n\s+pull-requests: read\n\s+outputs:/);
  assert.doesNotMatch(job, /: write/);
  assert.match(job, /persist-credentials: false/);
  assert.match(job, /--permission-mode default/);
  const allowed = job.match(/--allowedTools "([^"]+)"/)[1];
  assert.doesNotMatch(allowed, /\b(Edit|Write|WebFetch|WebSearch)\b|gh |git (add|commit|push)/);
  assert.match(job, /--disallowedTools "[^"]*Edit,Write[^"]*Read\(\/\/proc\/\*\*\)"/);
});

test("only the claude-fix label starts the job that can push", () => {
  const job = briefJob("fix");
  assert.match(job, /github\.event\.action == 'labeled' &&\n\s+github\.event\.label\.name == 'claude-fix'/);
  assert.match(job, /Bash\(git push origin HEAD\)/);
  assert.doesNotMatch(job, /Bash\(gh /);
  for (const name of ["prepare", "review", "publish"]) assert.doesNotMatch(briefJob(name), /git push/);
});

test("managed workflows pin every action and keep PR text out of shell code", () => {
  for (const path of ["core/files/.github/workflows/kit-check.yml",
    "triage/files/.github/workflows/agent-brief.yml", "triage/files/.github/workflows/agent-tripwire.yml"]) {
    const text = readFileSync(join(KIT_ROOT, "modules", path), "utf8");
    for (const [, action] of text.matchAll(/uses: (\S+)/g)) assert.match(action, /@[0-9a-f]{40}$/, action);
    for (const [, script] of text.matchAll(/^ +run: \|\n((?:(?: {10,}.*)?\n)+)/gm)) {
      assert.doesNotMatch(script, /\$\{\{/);
    }
  }
});

function publish(brief, { result = "success", existing = "0" } = {}) {
  const lines = readFileSync(BRIEF_WORKFLOW, "utf8").split("\n");
  const start = lines.findIndex((line) => line.includes("name: Publish the brief"));
  const run = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
  const script = [];
  for (const line of lines.slice(run + 1)) {
    if (line && !line.startsWith("          ")) break;
    script.push(line.slice(10));
  }
  const dir = tempDir();
  const log = join(dir, "gh.log");
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bash
echo "gh $*" >> "${log}"
if [[ "$1 $2" == "issue list" ]]; then echo "${existing}"; fi
if [[ "$1 $2" == "issue create" ]]; then echo "https://example.test/issues/9"; fi
if [[ "$1 $2" == "pr comment" ]]; then cp brief.md "${join(dir, "posted.md")}"; fi
if [[ "$1 $2" == "issue create" ]]; then cp issue.md "${join(dir, "issue-posted.md")}"; fi
`, { mode: 0o755 });
  const run_ = spawnSync("bash", ["-c", script.join("\n")], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env, PATH: `${dir}:${process.env.PATH}`, PR: "7", HEAD_SHA: "abc123", REVIEW_RESULT: result,
      BRIEF: typeof brief === "string" ? brief : JSON.stringify(brief),
    },
  });
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
  return { status: run_.status, out: run_.stdout + run_.stderr, gh: read("gh.log"), posted: read("posted.md"), issue: read("issue-posted.md") };
}

const hasJq = spawnSync("jq", ["--version"]).status === 0;
const goodBrief = {
  summary: "Adds login.", label: "agent/ready", recommendation: "Ship.", not_checked: "",
  findings: [{ tier: 2, title: "Empty name", location: "src/a.ts:3", details: "Problem.", action: "file" }],
};

test("publish posts a checked brief, files a finding and sets one label", { skip: !hasJq }, () => {
  const result = publish(goodBrief);
  assert.equal(result.status, 0, result.out);
  assert.match(result.posted, /<!-- agent-brief -->[\s\S]*Reviewed SHA: abc123/);
  assert.match(result.posted, /filed https:\/\/example\.test\/issues\/9/);
  assert.match(result.issue, /Finding ID: agent-finding-[0-9a-f]{12}/);
  assert.match(result.gh, /gh pr edit 7 --add-label agent\/ready/);
  assert.doesNotMatch(publish(goodBrief, { existing: "1" }).gh, /issue create/);
});

test("publish neutralizes markup in the agent's text", { skip: !hasJq }, () => {
  const result = publish({ ...goodBrief, summary: "<!-- agent-brief --> @alex ![x](https://evil.test/a)" });
  assert.equal(result.status, 0, result.out);
  assert.match(result.posted, /&lt;!-- agent-brief -->/);
  assert.doesNotMatch(result.posted, /@alex|!\[x\]/);
});

test("publish refuses a failed, malformed or credential-bearing result", { skip: !hasJq }, () => {
  for (const [brief, options] of [[goodBrief, { result: "failure" }], ["", {}], ["{}", {}],
    [{ ...goodBrief, label: "ship-it" }, {}], [{ ...goodBrief, summary: "sk-ant-secret" }, {}]]) {
    const result = publish(brief, options);
    assert.equal(result.status, 1, result.out);
    assert.match(result.gh, /--add-label agent\/could-not-verify/);
    assert.equal(result.posted, "");
  }
});

test("CLAUDE.md with extra rules fails", () => {
  const repo = adopted();
  writeFileSync(join(repo, "CLAUDE.md"), "@AGENTS.md\nAnother rule.\n");
  assert.match(kit(repo, "check").out, /CLAUDE\.md: must contain only @AGENTS\.md/);
});

test("a dated report in the docs root fails, even if declared", () => {
  const repo = adopted();
  writeFileSync(join(repo, "docs/audit-2026-09-22.md"), "x\n");
  setPolicy(repo, "allowed_extra_docs", "[docs/audit-2026-09-22.md]");
  const result = kit(repo, "check");
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /dated reports belong in docs\/history/);
});

test("an extra doc fails until it is declared", () => {
  const repo = adopted();
  writeFileSync(join(repo, "docs/EXTRA.md"), "x\n");
  assert.equal(kit(repo, "check").status, 1);
  setPolicy(repo, "allowed_extra_docs", "[docs/EXTRA.md]");
  const result = kit(repo, "check");
  assert.equal(result.status, 0, result.out);
});

test("editing project-owned content passes", () => {
  const repo = adopted();
  appendFileSync(join(repo, ".agent/lessons.md"), "\n- A real lesson.\n");
  appendFileSync(join(repo, "docs/STATUS.md"), "\nVerified something.\n");
  assert.equal(kit(repo, "check").status, 0);
});

test("a corrupt lock is could-not-verify", () => {
  const repo = adopted();
  writeFileSync(join(repo, ".agent/kit.lock"), "{not json");
  const result = kit(repo, "check");
  assert.equal(result.status, 2, result.out);
  assert.match(result.out, /COULD NOT VERIFY/);
  assert.doesNotMatch(result.out, /PASS/);
});

test("a missing policy or lock is could-not-verify", () => {
  const repo = adopted();
  rmSync(join(repo, ".agent/kit.lock"));
  assert.equal(kit(repo, "check").status, 2);
  const other = adopted();
  rmSync(join(other, ".agent/policy.yml"));
  assert.equal(kit(other, "check").status, 2);
});

test("policy this tool can't fully read is could-not-verify", () => {
  const repo = adopted();
  appendFileSync(join(repo, ".agent/policy.yml"), "human_only_pathz: [a]\n");
  assert.equal(kit(repo, "check").status, 2);
  const nested = adopted();
  appendFileSync(join(nested, ".agent/policy.yml"), "  weird: nested: thing\n");
  assert.equal(kit(nested, "check").status, 2);
});

test("an unreadable managed path is could-not-verify, not a pass", () => {
  const repo = adopted();
  rmSync(join(repo, SKILL));
  mkdirSync(join(repo, SKILL));
  const result = kit(repo, "check");
  assert.equal(result.status, 2, result.out);
});

test("a lock from another kit version is could-not-verify", () => {
  const repo = adopted();
  const path = join(repo, ".agent/kit.lock");
  const lock = JSON.parse(readFileSync(path, "utf8"));
  lock.version = "0.0.1";
  writeFileSync(path, JSON.stringify(lock));
  assert.equal(kit(repo, "check").status, 2);
});

test("an older kit version is only a warning", () => {
  const repo = adopted();
  const result = kit(repo, "check", "--latest-version", "9.9.9");
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /WARN kit 9\.9\.9 is available/);
});

test("a missing CI job or scan step fails", () => {
  const repo = adopted();
  setPolicy(repo, "ci_job", "something-else");
  assert.match(kit(repo, "check").out, /no project workflow has the job "something-else"/);
  const other = adopted();
  setPolicy(other, "scan_command", "node tools/other-scan.mjs");
  assert.match(kit(other, "check").out, /no project workflow runs "node tools\/other-scan\.mjs"/);
});

test("with a module off, its files are not installed or required", () => {
  const repo = adopted("core");
  assert.equal(existsSync(join(repo, SKILL)), false);
  assert.equal(kit(repo, "check").status, 0);
});

test("a project-owned skill the kit doesn't provide passes", () => {
  const repo = adopted();
  mkdirSync(join(repo, ".claude/skills/my-skill"), { recursive: true });
  writeFileSync(join(repo, ".claude/skills/my-skill/SKILL.md"), "x\n");
  assert.equal(kit(repo, "check").status, 0);
});

test("files from a switched-off module fail", () => {
  const repo = adopted("core");
  const source = join(KIT_ROOT, "modules/review/files/.claude/skills/ponytail-review");
  cpSync(source, join(repo, ".claude/skills/ponytail-review"), { recursive: true });
  const result = kit(repo, "check");
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /belongs to module review, which is off/);
});

test("triage without review is could-not-verify", () => {
  const repo = adopted();
  setPolicy(repo, "modules", "[core, triage]");
  assert.equal(kit(repo, "check").status, 2);
});

test("sync refuses the base branch and only changes managed files", () => {
  const repo = adopted("core,review");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  appendFileSync(join(repo, SKILL), "\ndrift\n");
  appendFileSync(join(repo, "docs/STATUS.md"), "\nproject note\n");

  assert.equal(kit(repo, "sync", "--write").status, 1);
  assert.match(readFileSync(join(repo, SKILL), "utf8"), /drift/);

  git(repo, "checkout", "-q", "-b", "kit-sync");
  const dry = kit(repo, "sync");
  assert.match(dry.out, /UPDATE \.claude\/skills\/ponytail-review\/SKILL\.md/);
  assert.match(readFileSync(join(repo, SKILL), "utf8"), /drift/);

  assert.equal(kit(repo, "sync", "--write").status, 0);
  assert.doesNotMatch(readFileSync(join(repo, SKILL), "utf8"), /drift/);
  assert.match(readFileSync(join(repo, "docs/STATUS.md"), "utf8"), /project note/);
  assert.equal(kit(repo, "check").status, 0);
  const changed = git(repo, "status", "--porcelain").split("\n").filter(Boolean).map((line) => line.slice(3));
  assert.deepEqual(changed, ["docs/STATUS.md"]);
});

test("turning a module off, then syncing, removes its files and only those", () => {
  const repo = adopted("core,review");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  git(repo, "checkout", "-q", "-b", "kit-sync");
  setPolicy(repo, "modules", "[core]");
  assert.equal(kit(repo, "check").status, 1);
  assert.equal(kit(repo, "sync", "--write").status, 0);
  assert.equal(existsSync(join(repo, SKILL)), false);
  assert.equal(existsSync(join(repo, ".agent/repository-scan.mjs")), true);
  assert.equal(kit(repo, "check").status, 0);
});

test("the script runs through a symlinked path", () => {
  const dir = realpathSync(tempDir());
  const link = join(dir, "kit-link.mjs");
  spawnSync("ln", ["-s", KIT, link]);
  const result = spawnSync("node", [link], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Usage/);
});

function scanRepo(files) {
  const repo = tempDir();
  git(repo, "init", "-q", "-b", "main");
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, name), content);
  const result = spawnSync("node", [SCAN, repo], { encoding: "utf8" });
  return { status: result.status, out: result.stdout };
}

test("the scan flags secrets and env files without printing values", () => {
  const secret = ["npg", "abcdefgh12345678"].join("_");
  const result = scanRepo({ "app.js": `const key = "${secret}";\n`, ".env.local": "A=1\n" });
  assert.equal(result.status, 1);
  assert.match(result.out, /secret-like content found: app\.js/);
  assert.match(result.out, /environment file is tracked: \.env\.local/);
  assert.equal(result.out.includes(secret), false);
});

test("the scan allows the example env file and its placeholder", () => {
  const url = ["postgresql://USER", "PASSWORD@host/db"].join(":");
  const result = scanRepo({ ".env.example": `DATABASE_URL=${url}\n` });
  assert.equal(result.status, 0, result.out);
});

test("the scan flags a real-looking database password", () => {
  const url = ["postgresql://user", "hunter2hunter2@host/db"].join(":");
  assert.equal(scanRepo({ "config.txt": `${url}\n` }).status, 1);
});

test("the scan reports could-not-verify outside a git repo", () => {
  const result = spawnSync("node", [SCAN, tempDir()], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /COULD NOT VERIFY/);
});

test("a fresh adopt registers the freshness hook, and removing it fails", () => {
  const repo = adopted();
  const path = join(repo, ".claude/settings.json");
  assert.match(readFileSync(path, "utf8"), /\.agent\/freshness\.mjs/);
  assert.equal(kit(repo, "check").status, 0);
  writeFileSync(path, JSON.stringify({ enabledPlugins: {} }));
  const result = kit(repo, "check");
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /FAIL \.claude\/settings\.json: no SessionStart hook runs \.agent\/freshness\.mjs/);
  writeFileSync(path, "{not json");
  assert.match(kit(repo, "check").out, /FAIL \.claude\/settings\.json: not valid JSON/);
  rmSync(path);
  assert.match(kit(repo, "check").out, /FAIL \.claude\/settings\.json: required file is missing/);
});

test("adopt leaves an existing settings file alone and prints the hook", () => {
  const repo = tempDir();
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, ".claude"));
  const original = `${JSON.stringify({ enabledPlugins: { x: false } })}\n`;
  writeFileSync(join(repo, ".claude/settings.json"), original);
  const result = kit(repo, "adopt", "--write");
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /NOTE \.claude\/settings\.json: no SessionStart hook runs/);
  assert.match(result.out, /"SessionStart"/);
  assert.equal(readFileSync(join(repo, ".claude/settings.json"), "utf8"), original);
  assert.equal(kit(repo, "check").status, 1);
});

const COMMIT = ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m"];

function freshness(repo) {
  const script = join(repo, ".agent/freshness.mjs");
  const result = spawnSync("node", [script], {
    encoding: "utf8", cwd: tempDir(), env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(output.systemMessage, output.hookSpecificOutput.additionalContext);
  return output.systemMessage;
}

// A clone of a bare origin with the kit adopted and pushed, plus a second clone to push from.
function clonedRepo() {
  const root = tempDir();
  const origin = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(root, "seed");
  git(root, "clone", "-q", origin, seed);
  assert.equal(kit(seed, "adopt", "--write").status, 0);
  git(seed, "add", "-A");
  git(seed, ...COMMIT, "init");
  git(seed, "push", "-q", "origin", "main");
  const repo = join(root, "work");
  git(root, "clone", "-q", origin, repo);
  return { repo, seed };
}

test("freshness reports a checkout that is behind, without changing it", () => {
  const { repo, seed } = clonedRepo();
  assert.match(freshness(repo), /has everything on origin\/main/);

  git(seed, ...COMMIT, "new work");
  git(seed, "push", "-q", "origin", "main");
  const head = git(repo, "rev-parse", "HEAD");
  const message = freshness(repo);
  assert.match(message, /local main is 1 commit behind origin\/main/);
  assert.match(message, /Read code from origin\/main/);
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.equal(git(repo, "status", "--porcelain"), "");

  git(repo, "checkout", "-q", "-b", "work/x", head.trim());
  assert.match(freshness(repo), /work\/x is missing 1 commit from origin\/main/);
});

test("freshness reads the base branch from policy", () => {
  const { repo } = clonedRepo();
  setPolicy(repo, "base_branch", "trunk");
  assert.match(freshness(repo), /could not verify \(origin\/trunk does not exist\)/);
});

test("freshness without a remote is could-not-verify", () => {
  const repo = adopted("core");
  assert.match(freshness(repo), /Freshness: could not verify \(no origin remote\)/);
});

test("freshness with an unreachable origin is could-not-verify", () => {
  const repo = adopted("core");
  git(repo, "remote", "add", "origin", join(tempDir(), "missing.git"));
  assert.match(freshness(repo), /could not verify \(git fetch origin failed/);
});

const WORKER = ".claude/agents/worker.md";
const VERIFIER = ".claude/agents/verifier.md";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("adopt with delegate installs the worker, the section and the forced model", () => {
  const repo = adopted("core,delegate");
  assert.equal(existsSync(join(repo, WORKER)), true);
  assert.equal(existsSync(join(repo, VERIFIER)), true);
  assert.deepEqual(Object.keys(readJson(join(repo, ".agent/kit.lock")).files)
    .filter((path) => path.startsWith(".claude/agents/")), [VERIFIER, WORKER]);
  assert.match(readFileSync(join(repo, "AGENTS.md"), "utf8"), /^## Delegation$/m);
  const settings = readJson(join(repo, ".claude/settings.json"));
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, "1");
  assert.match(JSON.stringify(settings.hooks), /freshness\.mjs/);
  const result = kit(repo, "check");
  assert.equal(result.status, 0, result.out);
});

test("without delegate, nothing of it is installed or required", () => {
  const repo = adopted();
  assert.equal(existsSync(join(repo, WORKER)), false);
  assert.equal(existsSync(join(repo, VERIFIER)), false);
  assert.doesNotMatch(readFileSync(join(repo, "AGENTS.md"), "utf8"), /## Delegation/);
  assert.equal(readJson(join(repo, ".claude/settings.json")).env, undefined);
  assert.equal(kit(repo, "check").status, 0);
});

test("with delegate on, a missing Delegation section fails", () => {
  const repo = adopted("core,delegate");
  const path = join(repo, "AGENTS.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("## Delegation", "## Helpers"));
  const result = kit(repo, "check");
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /FAIL AGENTS\.md: module delegate needs section "## Delegation"/);
});

test("with delegate on, the subagent model must be set and forced", () => {
  const repo = adopted("core,delegate");
  const path = join(repo, ".claude/settings.json");
  const original = readJson(path);

  const unforced = structuredClone(original);
  unforced.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = "0";
  writeFileSync(path, JSON.stringify(unforced));
  const first = kit(repo, "check");
  assert.equal(first.status, 1, first.out);
  assert.match(first.out, /needs env\.CLAUDE_CODE_SUBAGENT_MODEL_FORCE set to "1"/);

  const unset = structuredClone(original);
  unset.env.CLAUDE_CODE_SUBAGENT_MODEL = " ";
  writeFileSync(path, JSON.stringify(unset));
  assert.match(kit(repo, "check").out, /FAIL \.claude\/settings\.json: module delegate needs env\.CLAUDE_CODE_SUBAGENT_MODEL\n/);

  const { env: _env, ...noEnv } = original;
  writeFileSync(path, JSON.stringify(noEnv));
  const last = kit(repo, "check");
  assert.equal(last.status, 1, last.out);
  assert.match(last.out, /needs env\.CLAUDE_CODE_SUBAGENT_MODEL\n/);
  assert.match(last.out, /needs env\.CLAUDE_CODE_SUBAGENT_MODEL_FORCE/);
});

test("editing the managed worker fails", () => {
  const repo = adopted("core,delegate");
  appendFileSync(join(repo, WORKER), "\nmodel: opus\n");
  const result = kit(repo, "check");
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /FAIL \.claude\/agents\/worker\.md: differs from kit/);
});

test("turning delegate on in an adopted repo: sync installs the worker and prints the rest", () => {
  const repo = adopted("core");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  git(repo, "checkout", "-q", "-b", "kit-sync");
  setPolicy(repo, "modules", "[core, delegate]");
  assert.equal(kit(repo, "check").status, 1);

  const agentsBefore = readFileSync(join(repo, "AGENTS.md"), "utf8");
  const settingsBefore = readFileSync(join(repo, ".claude/settings.json"), "utf8");
  const synced = kit(repo, "sync", "--write");
  assert.equal(synced.status, 0, synced.out);
  assert.match(synced.out, /UPDATE \.claude\/agents\/worker\.md/);
  assert.match(synced.out, /UPDATE \.claude\/agents\/verifier\.md/);
  assert.match(synced.out, /Add this section to AGENTS\.md:\n## Delegation/);
  assert.match(synced.out, /Add these keys to \.claude\/settings\.json:/);
  assert.equal(readFileSync(join(repo, "AGENTS.md"), "utf8"), agentsBefore);
  assert.equal(readFileSync(join(repo, ".claude/settings.json"), "utf8"), settingsBefore);
  assert.equal(kit(repo, "check").status, 1);

  const snippets = join(KIT_ROOT, "modules/delegate/snippets");
  appendFileSync(join(repo, "AGENTS.md"), `\n${readFileSync(join(snippets, "AGENTS.md"), "utf8")}`);
  const settings = JSON.parse(settingsBefore);
  settings.env = readJson(join(snippets, "settings.json")).env;
  writeFileSync(join(repo, ".claude/settings.json"), JSON.stringify(settings, null, 2));
  const result = kit(repo, "check");
  assert.equal(result.status, 0, result.out);
});

test("a project-owned worker.md fails while delegate is off", () => {
  const repo = adopted("core");
  mkdirSync(join(repo, ".claude/agents"), { recursive: true });
  writeFileSync(join(repo, WORKER), "mine\n");
  assert.match(kit(repo, "check").out, /worker\.md: belongs to module delegate, which is off/);
});

test("the worker is isolated, can't spawn agents, and leaves the model to settings", () => {
  const text = readFileSync(join(KIT_ROOT, "modules/delegate/files", WORKER), "utf8");
  const frontmatter = text.split("---")[1];
  assert.match(frontmatter, /^name: worker$/m);
  assert.match(frontmatter, /^isolation: worktree$/m);
  assert.match(frontmatter, /^disallowedTools: Agent$/m);
  assert.doesNotMatch(frontmatter, /^model:/m);
  assert.match(text, /Never push/);
});

test("with delegate on, a Delegation section that never names the verifier fails", () => {
  const repo = adopted("core,delegate");
  const path = join(repo, "AGENTS.md");
  writeFileSync(path, readFileSync(path, "utf8").replaceAll("`verifier`", "the checker"));
  const result = kit(repo, "check");
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /section "## Delegation" must tell the main agent when to run `verifier`/);
  // A mention in another section doesn't count.
  appendFileSync(path, "\n## Notes\n\nWe also have a `verifier`.\n");
  assert.equal(kit(repo, "check").status, 1);
});

test("editing the managed verifier fails", () => {
  const repo = adopted("core,delegate");
  appendFileSync(join(repo, VERIFIER), "\ntools: Read, Edit\n");
  assert.match(kit(repo, "check").out, /FAIL \.claude\/agents\/verifier\.md: differs from kit/);
});

test("the worker merges the task branch before it reads the rules or edits", () => {
  const text = readFileSync(join(KIT_ROOT, "modules/delegate/files", WORKER), "utf8");
  const at = (pattern) => {
    const index = text.search(pattern);
    assert.notEqual(index, -1, String(pattern));
    return index;
  };
  const merge = at(/git merge --no-edit <base branch>/);
  const rules = at(/read `AGENTS\.md` and\s+`\.agent\/policy\.yml`/);
  const brief = at(/^## \d\. Check the brief$/m);
  const setup = at(/^## \d\. Set up$/m);
  const work = at(/^## \d\. Do the work$/m);
  assert.ok(merge < rules && rules < brief && brief < setup && setup < work);
  assert.match(text.slice(setup, work), /If it fails, stop and report/);
  assert.match(text.slice(setup, work), /Don't retry with other commands/);
  assert.match(text, /^Setup: <command> -> <passed \| failed \| not set>$/m);
});

test("setup_command is optional, and an empty one is could-not-verify", () => {
  const repo = adopted("core,delegate");
  assert.doesNotMatch(readFileSync(join(repo, ".agent/policy.yml"), "utf8"), /^setup_command:/m);
  assert.equal(kit(repo, "check").status, 0);
  appendFileSync(join(repo, ".agent/policy.yml"), "setup_command: npm ci  # install exact deps\n");
  const result = kit(repo, "check");
  assert.equal(result.status, 0, result.out);
  for (const empty of ["", "\"\""]) {
    setPolicy(repo, "setup_command", empty);
    const bad = kit(repo, "check");
    assert.equal(bad.status, 2, bad.out);
    assert.match(bad.out, /setup_command is empty/);
  }
});

test("the verifier can't edit, spawn agents or pick its own model", () => {
  const text = readFileSync(join(KIT_ROOT, "modules/delegate/files", VERIFIER), "utf8");
  const frontmatter = text.split("---")[1];
  assert.match(frontmatter, /^name: verifier$/m);
  const tools = frontmatter.match(/^tools: (.+)$/m)[1].split(",").map((tool) => tool.trim());
  assert.deepEqual(tools.sort(), ["Bash", "Glob", "Grep", "Read"]);
  assert.doesNotMatch(frontmatter, /^(model|permissionMode|isolation|disallowedTools|mcpServers):/m);
  assert.match(text, /could not verify/);
  assert.match(text, /^Result: <pass \| fail \| could not verify>$/m);
});

function guard(repo, input, env = {}) {
  const result = spawnSync("node", [join(repo, ".agent/guard.mjs")], {
    input: JSON.stringify({ cwd: repo, ...input }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, KIT_GUARD: "", ...env },
  });
  return { status: result.status, err: result.stderr };
}

const edit = (file_path) => ({ tool_name: "Edit", tool_input: { file_path } });
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

function guardedRepo() {
  const repo = adopted("core");
  setPolicy(repo, "human_only_paths", "[.github/workflows/**, db/migrations/**, vercel.json]");
  setPolicy(repo, "never_run", "[npm run deploy:prod, tests/storage.spec.ts]");
  return repo;
}

test("a fresh adopt registers the guard, and removing it fails", () => {
  const repo = adopted("core");
  const path = join(repo, ".claude/settings.json");
  const settings = JSON.parse(readFileSync(path, "utf8"));
  assert.match(JSON.stringify(settings.hooks.PreToolUse), /\.agent\/guard\.mjs/);
  delete settings.hooks.PreToolUse;
  writeFileSync(path, JSON.stringify(settings));
  const result = kit(repo, "check");
  assert.equal(result.status, 1);
  assert.match(result.out, /no PreToolUse hook runs \.agent\/guard\.mjs/);
});

test("the guard blocks human-only paths and always protects its own rules", () => {
  const repo = guardedRepo();
  for (const path of [".github/workflows/ci.yml", "db/migrations/001.sql", "vercel.json",
    ".agent/policy.yml", ".agent/guard.mjs", ".claude/settings.json", ".claude/settings.local.json"]) {
    const result = guard(repo, edit(join(repo, path)));
    assert.equal(result.status, 2, path);
    assert.match(result.err, /guard blocked/);
  }
  assert.equal(guard(repo, edit(join(repo, "src/app.ts"))).status, 0);
  assert.equal(guard(repo, edit(join(repo, "docs/vercel.json"))).status, 0);
});

test("the guard judges a worktree by its own paths", () => {
  const repo = guardedRepo();
  setPolicy(repo, "human_only_paths", "[.claude/**, db/**]");
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-qm", "kit");
  const tree = join(repo, ".claude/worktrees/w1");
  git(repo, "worktree", "add", "-q", tree, "-b", "w1");
  const input = (path) => ({ cwd: tree, ...edit(join(tree, path)) });
  assert.equal(guard(repo, input("src/new/file.ts")).status, 0);
  assert.equal(guard(repo, input("db/schema.sql")).status, 2);
  assert.equal(guard(repo, input(".claude/settings.json")).status, 2);
});

test("the guard keeps agents out of env files but allows the examples", () => {
  const repo = guardedRepo();
  assert.equal(guard(repo, { tool_name: "Read", tool_input: { file_path: join(repo, ".env.local") } }).status, 2);
  assert.equal(guard(repo, { tool_name: "Grep", tool_input: { path: ".env" } }).status, 2);
  assert.equal(guard(repo, edit(join(repo, "app/.env"))).status, 2);
  for (const command of ["cat .env", "source ./.env.local", "node --env-file=.env x.js", "cat < .env"]) {
    assert.equal(guard(repo, bash(command)).status, 2, command);
  }
  assert.equal(guard(repo, { tool_name: "Read", tool_input: { file_path: join(repo, ".env.example") } }).status, 0);
  assert.equal(guard(repo, bash("cat .env.example")).status, 0);
  assert.equal(guard(repo, bash("node -p process.env.HOME")).status, 0);
  assert.equal(guard(repo, bash("git commit -m 'document .env setup'")).status, 0);
  assert.equal(guard(repo, bash("rg .env src")).status, 0);
  assert.equal(guard(repo, bash("grep KEY .env")).status, 2);
});

test("the guard blocks never_run commands and shell writes to protected paths", () => {
  const repo = guardedRepo();
  for (const command of ["npm test && npm  run deploy:prod", "npx playwright test tests/storage.spec.ts",
    "rm -f vercel.json", "echo x > .github/workflows/ci.yml", "sed -i s/a/b/ db/migrations/1.sql",
    "git checkout -- vercel.json", "echo x | tee .agent/policy.yml", "cd .github/workflows && rm ci.yml"]) {
    assert.equal(guard(repo, bash(command)).status, 2, command);
  }
  for (const command of ["npm test", "cat tests/storage.spec.ts", "rg deploy:prod package.json",
    "git diff vercel.json", "echo ok > /dev/null", "cp a.txt b.txt"]) {
    assert.equal(guard(repo, bash(command)).status, 0, command);
  }
});

test("the guard blocks process files that can expose secrets", () => {
  const repo = guardedRepo();
  assert.equal(guard(repo, { tool_name: "Read", tool_input: { file_path: "/proc/self/environ" } }).status, 2);
  assert.equal(guard(repo, bash("cat /proc/self/environ")).status, 2);
  assert.equal(guard(repo, bash("cat /proc/cpuinfo")).status, 0);
});

test("without a readable policy the guard stops writes but not reads", () => {
  const repo = guardedRepo();
  rmSync(join(repo, ".agent/policy.yml"));
  const result = guard(repo, edit(join(repo, "src/app.ts")));
  assert.equal(result.status, 2);
  assert.match(result.err, /could not verify/);
  assert.equal(guard(repo, bash("npm test")).status, 2);
  assert.equal(guard(repo, { tool_name: "Read", tool_input: { file_path: join(repo, "README.md") } }).status, 0);
});

test("the guard keeps the verifier read-only and leaves other agents alone", () => {
  const repo = guardedRepo();
  appendFileSync(join(repo, ".agent/policy.yml"), "setup_command: npm ci\n");
  const as = (agent_type, input) => guard(repo, { agent_type, ...input });
  for (const input of [edit(join(repo, "src/app.ts")),
    { tool_name: "Write", tool_input: { file_path: join(repo, "notes.md") } }]) {
    const result = as("verifier", input);
    assert.equal(result.status, 2);
    assert.match(result.err, /verifier agent is read-only/);
  }
  for (const command of ["echo x > notes.md", "npm test >> out.log", "rm -rf src", "sed -i s/a/b/ src/a.ts",
    "git commit -am x", "git -C . merge feature", "git checkout main", "git stash", "git reset --hard",
    "ls | xargs rm", "find . -name '*.log' -delete", "touch x"]) {
    assert.equal(as("verifier", bash(command)).status, 2, command);
  }
  for (const command of ["git diff main...HEAD", "git --no-pager log --oneline", "git status --porcelain",
    "git diff --name-only main...HEAD", "git merge-base main HEAD", "npm test 2>&1", "node --test > /dev/null"]) {
    assert.equal(as("verifier", bash(command)).status, 0, command);
  }
  assert.equal(as("verifier", { tool_name: "Read", tool_input: { file_path: join(repo, "README.md") } }).status, 0);
  assert.equal(as("verifier", bash("npm run deploy:prod")).status, 2);
  assert.equal(as("worker", edit(join(repo, "src/app.ts"))).status, 0);
  assert.equal(as("worker", bash("git commit -am x")).status, 0);
  assert.equal(guard(repo, edit(join(repo, "src/app.ts"))).status, 0);
});

test("KIT_GUARD=off lets a person override the guard", () => {
  const repo = guardedRepo();
  assert.equal(guard(repo, edit(join(repo, "vercel.json")), { KIT_GUARD: "off" }).status, 0);
});

const GATE = join(KIT_ROOT, "modules/core/files/.agent/skill-gate.mjs");

function skillGate(input, env = process.env) {
  const result = spawnSync(process.execPath, [GATE], { input, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  if (!result.stdout.trim()) return null;
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  return output.hookSpecificOutput.additionalContext;
}

test("a fresh adopt registers the skill-gate hook, and removing it fails", () => {
  const repo = adopted();
  const path = join(repo, ".claude/settings.json");
  const settings = readJson(path);
  assert.match(JSON.stringify(settings.hooks.UserPromptSubmit), /\.agent\/skill-gate\.mjs/);
  assert.equal(existsSync(join(repo, ".agent/skill-gate.mjs")), true);
  assert.equal(kit(repo, "check").status, 0);
  delete settings.hooks.UserPromptSubmit;
  writeFileSync(path, JSON.stringify(settings));
  const result = kit(repo, "check");
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /FAIL \.claude\/settings\.json: no UserPromptSubmit hook runs \.agent\/skill-gate\.mjs/);
  assert.doesNotMatch(result.out, /no SessionStart hook/);
});

test("a missing Skill vetting section fails", () => {
  const repo = adopted();
  const path = join(repo, "AGENTS.md");
  assert.match(readFileSync(path, "utf8"), /skillspector scan <path-or-git-url> --no-llm --format json/);
  writeFileSync(path, readFileSync(path, "utf8").replace("## Skill vetting", "## Skills"));
  const result = kit(repo, "check");
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /FAIL AGENTS\.md: missing section "## Skill vetting"/);
});

test("sync prints the Skill vetting section and hook, and leaves both files alone", () => {
  const repo = adopted("core");
  const agentsPath = join(repo, "AGENTS.md");
  const settingsPath = join(repo, ".claude/settings.json");
  const agents = readFileSync(agentsPath, "utf8").replace(/## Skill vetting[\s\S]*?(?=## )/, "");
  writeFileSync(agentsPath, agents);
  const settings = readJson(settingsPath);
  delete settings.hooks.UserPromptSubmit;
  const settingsText = JSON.stringify(settings, null, 2);
  writeFileSync(settingsPath, settingsText);
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  git(repo, "checkout", "-q", "-b", "kit-sync");

  const synced = kit(repo, "sync", "--write");
  assert.equal(synced.status, 0, synced.out);
  assert.match(synced.out, /NOTE AGENTS\.md: missing section "## Skill vetting"; left unchanged\. Add this section:\n## Skill vetting\n/);
  assert.doesNotMatch(synced.out, /Add this section:\n## Skill vetting[\s\S]*## Session budget/);
  assert.match(synced.out, /NOTE \.claude\/settings\.json: no UserPromptSubmit hook runs \.agent\/skill-gate\.mjs/);
  assert.match(synced.out, /Add these hooks:\n[\s\S]*"UserPromptSubmit"/);
  assert.equal(readFileSync(agentsPath, "utf8"), agents);
  assert.equal(readFileSync(settingsPath, "utf8"), settingsText);
  assert.equal(kit(repo, "check").status, 1);
});

test("the skill gate reminds on skill prompts only, and on unreadable input", () => {
  const reminder = skillGate(JSON.stringify({ prompt: "please install this skill from github" }));
  assert.match(reminder, /AGENTS\.md › Skill vetting/);
  assert.match(reminder, /skillspector scan <path-or-git-url> --no-llm --format json/);
  assert.match(skillGate(JSON.stringify({ prompt: "add the MCP server" })), /Skill vetting/);
  assert.match(skillGate(JSON.stringify({ prompt: "look at this SKILL.md" })), /Skill vetting/);
  assert.equal(skillGate(JSON.stringify({ prompt: "fix the login bug" })), null);
  assert.match(skillGate("{not json"), /Skill vetting/);
});

test("the skill gate says a missing scanner means could not verify", () => {
  const reminder = skillGate(JSON.stringify({ prompt: "add a plugin" }), { ...process.env, PATH: "" });
  assert.match(reminder, /SkillSpector is not installed/);
  assert.match(reminder, /uv tool install --python 3\.13 git\+https:\/\/github\.com\/NVIDIA\/skillspector\.git/);
  assert.match(reminder, /could not verify/);
});
