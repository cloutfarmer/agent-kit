#!/usr/bin/env node
// UserPromptSubmit hook: when a prompt mentions a skill, plugin or MCP server, reminds the
// agent to scan it with SkillSpector before adding it (AGENTS.md › Skill vetting).
// Never blocks a prompt and always exits 0. Unreadable input still gets the reminder.

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MENTIONS = /\b(skills?|plugins?|mcp)\b|SKILL\.md/i;
const INSTALL = "uv tool install --python 3.13 git+https://github.com/NVIDIA/skillspector.git";

export function skillGate(prompt, { hasScanner }) {
  if (typeof prompt === "string" && !MENTIONS.test(prompt)) return null;
  let text = "Skill vetting: if this prompt suggests adding, installing, copying, enabling or "
    + "updating a skill, plugin or MCP server, follow AGENTS.md › Skill vetting. Scan it with "
    + "`skillspector scan <path-or-git-url> --no-llm --format json` before it touches this repo "
    + "or ~/.claude, and act on the recommendation.";
  if (!hasScanner) {
    text += ` SkillSpector is not installed (install: ${INSTALL}). Until it is, the scan is `
      + "could not verify and the skill must not be added.";
  }
  return text;
}

function scannerInstalled() {
  const result = spawnSync("skillspector", ["--version"], { stdio: "ignore", timeout: 5_000 });
  return result.status === 0 && !result.error;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let prompt = null;
  try {
    prompt = JSON.parse(readFileSync(0, "utf8")).prompt ?? null;
  } catch {
    prompt = null;
  }
  const mentioned = typeof prompt !== "string" || MENTIONS.test(prompt);
  const text = mentioned ? skillGate(prompt, { hasScanner: scannerInstalled() }) : null;
  if (text) {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text },
    })}\n`);
  }
}
