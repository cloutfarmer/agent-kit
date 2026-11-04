#!/usr/bin/env node
// Fails if tracked or untracked-but-not-ignored files look like secrets or env files.
// Prints the file and reason, never the matched value. Exit: 0 pass, 1 fail, 2 could not verify.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 5 * 1024 * 1024;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bre_[A-Za-z0-9_-]{24,}\b/,
  /\bnpg_[A-Za-z0-9]{8,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
];
const DATABASE_URL = /postgres(?:ql)?:\/\/[^\s:/]+:([^\s@/]{8,})@/gi;

export function isEnvFile(name) {
  const base = basename(name).toLowerCase();
  if (base === ".env.example" || base === ".env.sample") return false;
  return base === ".env" || base.startsWith(".env.") || base.endsWith(".env");
}

export function hasSecret(text) {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return true;
  // USER:PASSWORD is the documented placeholder in example env files.
  return [...text.matchAll(DATABASE_URL)].some((match) => match[1].toUpperCase() !== "PASSWORD");
}

function scan(repo) {
  const listing = spawnSync(
    "git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (listing.status !== 0) throw new Error("git ls-files failed");
  const failures = [];
  for (const name of listing.stdout.split("\0").filter(Boolean)) {
    if (isEnvFile(name)) failures.push(`environment file is tracked: ${name}`);
    const path = join(repo, name);
    let stat;
    try {
      stat = statSync(path);
    } catch (error) {
      if (error.code === "ENOENT") continue; // Deleted but not yet staged.
      throw error;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_BYTES) {
      failures.push(`file exceeds 5 MiB: ${name}`);
      continue;
    }
    if (hasSecret(readFileSync(path).toString("latin1"))) failures.push(`secret-like content found: ${name}`);
  }
  return failures;
}

function main() {
  const repo = resolve(process.argv[2] ?? ".");
  let failures;
  try {
    failures = scan(repo);
  } catch (error) {
    console.log(`COULD NOT VERIFY repository scan: ${error.code ?? error.name}`);
    return 2;
  }
  for (const failure of failures) console.log(`FAIL ${failure}`);
  if (failures.length) return 1;
  console.log("PASS repository scan");
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
