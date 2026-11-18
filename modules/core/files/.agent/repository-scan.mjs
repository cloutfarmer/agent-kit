#!/usr/bin/env node
// Fails if tracked or untracked-but-not-ignored files look like secrets or env files.
// Prints the file, line and kind of secret, never the matched value.
// A line containing "kit-scan: allow" is skipped and listed, so the exception shows in review.
// Exit: 0 pass, 1 fail, 2 could not verify.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOW_MARKER = "kit-scan: allow";

// Each rule is specific to one provider's token format. `prefix` is the length of the fixed
// start of the token, or a named group `r` marks the random part. That part must look random,
// so placeholders such as sk_live_XXXX are not reported. `ignore` skips documented examples.
const SECRET_RULES = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, prefix: 4, ignore: /EXAMPLE$/ },
  { name: "Resend API key", pattern: /\bre_[A-Za-z0-9_-]{24,}\b/g, prefix: 3 },
  { name: "Neon database password", pattern: /\bnpg_[A-Za-z0-9]{8,}\b/g, prefix: 4 },
  { name: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, prefix: 4 },
  { name: "GitHub token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, prefix: 11 },
  { name: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, prefix: 7 },
  // OpenAI keys carry "T3BlbkFJ" (base64 for "OpenAI") in the middle.
  {
    name: "OpenAI API key",
    pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{58,74}T3BlbkFJ[A-Za-z0-9_-]{58,74}(?![A-Za-z0-9_-])/g,
    prefix: 8,
  },
  { name: "OpenAI API key", pattern: /\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/g, prefix: 3 },
  // Live secret and restricted keys. Test keys and publishable pk_ keys are left alone.
  { name: "Stripe live key", pattern: /\b[sr]k_live_[A-Za-z0-9]{20,247}\b/g, prefix: 8 },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, prefix: 4 },
  { name: "Slack bot token", pattern: /\bxoxb-\d{10,13}-\d{10,13}-[A-Za-z0-9]{20,}\b/g, prefix: 5 },
  { name: "Slack user token", pattern: /\bxox[pe](?:-\d{10,13}){3}-[A-Za-z0-9]{28,34}\b/g, prefix: 5 },
  { name: "Slack app token", pattern: /\bxapp-\d-[A-Z0-9]{8,}-\d{10,}-[A-Za-z0-9]{32,}\b/g, prefix: 5 },
  {
    name: "Slack webhook URL",
    pattern: /\bhooks\.slack\.com\/(?:services|workflows|triggers)\/T[A-Z0-9]{8,}\/[AB][A-Z0-9]{8,}\/(?<r>[A-Za-z0-9]{24,})\b/g,
  },
  { name: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, prefix: 4 },
];
const DATABASE_URL = /postgres(?:ql)?:\/\/[^\s:/]+:([^\s@/]{8,})@/gi;

export function isEnvFile(name) {
  const base = basename(name).toLowerCase();
  if (base === ".env.example" || base === ".env.sample") return false;
  return base === ".env" || base.startsWith(".env.") || base.endsWith(".env");
}

// A real token's random part uses many different characters. "XXXX" or "0000" does not.
function looksRandom(value) {
  return new Set(value.replace(/[^A-Za-z0-9]/g, "")).size >= 6;
}

// Returns { line, rule } for each secret-like line, and the lines skipped by the marker.
export function findSecrets(text) {
  const found = [];
  const allowed = [];
  text.split("\n").forEach((line, index) => {
    const rules = [];
    for (const { name, pattern, prefix, ignore } of SECRET_RULES) {
      for (const match of line.matchAll(pattern)) {
        if (ignore?.test(match[0])) continue;
        const random = match.groups?.r ?? (prefix === undefined ? null : match[0].slice(prefix));
        if (random === null || looksRandom(random)) rules.push(name);
      }
    }
    // USER:PASSWORD is the documented placeholder in example env files.
    for (const match of line.matchAll(DATABASE_URL)) {
      if (match[1].toUpperCase() !== "PASSWORD") rules.push("database URL with a password");
    }
    if (!rules.length) return;
    if (line.includes(ALLOW_MARKER)) allowed.push(index + 1);
    else found.push(...[...new Set(rules)].map((rule) => ({ line: index + 1, rule })));
  });
  return { found, allowed };
}

export function hasSecret(text) {
  return findSecrets(text).found.length > 0;
}

function scan(repo) {
  const listing = spawnSync(
    "git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (listing.status !== 0) throw new Error("git ls-files failed");
  const failures = [];
  const notes = [];
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
    const { found, allowed } = findSecrets(readFileSync(path).toString("latin1"));
    for (const { line, rule } of found) failures.push(`secret-like content found: ${name}:${line} (${rule})`);
    for (const line of allowed) notes.push(`secret-like line allowed by "${ALLOW_MARKER}": ${name}:${line}`);
  }
  return { failures, notes };
}

function main() {
  const repo = resolve(process.argv[2] ?? ".");
  let result;
  try {
    result = scan(repo);
  } catch (error) {
    console.log(`COULD NOT VERIFY repository scan: ${error.code ?? error.name}`);
    return 2;
  }
  for (const note of result.notes) console.log(`NOTE ${note}`);
  for (const failure of result.failures) console.log(`FAIL ${failure}`);
  if (result.failures.length) return 1;
  console.log("PASS repository scan");
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
