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

test("agent-brief skips every review step when the token is missing", () => {
  const text = readFileSync(join(KIT_ROOT, "modules/triage/files/.github/workflows/agent-brief.yml"), "utf8");
  const steps = text.split(/^      - /m).slice(1);
  const tokenStep = steps.findIndex((step) => step.includes("id: token"));
  assert.ok(tokenStep >= 0, "the token check step is missing");
  assert.match(steps[tokenStep], /HAS_TOKEN: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN != '' \}\}/);
  const later = steps.slice(tokenStep + 1);
  assert.ok(later.length >= 3);
  for (const step of later) {
    assert.match(step, /^\s+if: .*steps\.token\.outputs\.present == 'true'/m, step.split("\n")[0]);
  }
  const verify = later.find((step) => step.startsWith("name: Verify the brief"));
  assert.match(verify, /if: always\(\) && steps\.token\.outputs\.present == 'true'/);
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
