#!/usr/bin/env node
// SessionStart hook: fetches origin and warns when this checkout is behind the base branch.
// Only updates remote-tracking refs; never changes files, branches or the index.
// Always exits 0 so a session is never blocked. A failed fetch reports "could not verify".

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FETCH_TIMEOUT_MS = 20_000;

function git(repo, args, timeout = 10_000) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const ok = result.status === 0 && !result.error;
  const reason = result.error?.code === "ETIMEDOUT"
    ? "timed out"
    : (result.stderr || "").trim().split("\n")[0] || `exit ${result.status}`;
  return { ok, out: (result.stdout || "").trim(), reason };
}

function baseBranch(repo) {
  const path = join(repo, ".agent/policy.yml");
  if (!existsSync(path)) return "main";
  const match = readFileSync(path, "utf8").match(/^base_branch:\s*["']?([^"'\s#]+)/m);
  return match ? match[1] : "main";
}

function plural(count) {
  return `${count} commit${count === 1 ? "" : "s"}`;
}

export function freshness(repo) {
  const base = baseBranch(repo);
  const remote = `origin/${base}`;
  if (!git(repo, ["remote", "get-url", "origin"]).ok) {
    return { level: "unverified", text: "Freshness: could not verify (no origin remote)." };
  }
  const fetch = git(repo, ["fetch", "origin", "--quiet"], FETCH_TIMEOUT_MS);
  if (!fetch.ok) {
    return { level: "unverified", text: `Freshness: could not verify (git fetch origin failed: ${fetch.reason}).` };
  }
  if (!git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}`]).ok) {
    return { level: "unverified", text: `Freshness: could not verify (${remote} does not exist).` };
  }

  const behind = [];
  if (git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${base}`]).ok) {
    const count = Number(git(repo, ["rev-list", "--count", `${base}..${remote}`]).out);
    if (count > 0) behind.push(`local ${base} is ${plural(count)} behind ${remote}`);
  }
  const branch = git(repo, ["branch", "--show-current"]).out;
  if (branch !== base) {
    const count = Number(git(repo, ["rev-list", "--count", `HEAD..${remote}`]).out);
    if (count > 0) behind.push(`${branch || "HEAD"} is missing ${plural(count)} from ${remote}`);
  }

  if (!behind.length) {
    return { level: "current", text: `Freshness: this checkout has everything on ${remote}.` };
  }
  return {
    level: "behind",
    text: `Freshness: ${behind.join("; ")}. Read code from ${remote} `
      + `(git show ${remote}:<path>, or a new worktree from ${remote}), not this checkout. `
      + `Merge ${remote} into a work branch before its PR. `
      + `To update the ${base} checkout, the user runs git pull --ff-only.`,
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  let result;
  try {
    result = freshness(repo);
  } catch (error) {
    result = { level: "unverified", text: `Freshness: could not verify (${error.message}).` };
  }
  process.stdout.write(`${JSON.stringify({
    systemMessage: result.text,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: result.text },
  })}\n`);
}
