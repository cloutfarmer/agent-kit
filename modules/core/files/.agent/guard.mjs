#!/usr/bin/env node
// PreToolUse hook. Blocks agent actions that .agent/policy.yml reserves for a person.
// Exit 0 allows the tool call. Exit 2 blocks it and shows the reason to the agent.
// This is a guardrail, not a sandbox: a program started from Bash can still do what
// this hook can't see. Set KIT_GUARD=off before starting Claude Code to turn it off.
// A read-only agent, such as the delegate module's verifier, also can't edit or write files.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const POLICY_PATH = ".agent/policy.yml";
const ALWAYS_PROTECTED = [".agent/guard.mjs", POLICY_PATH, ".claude/settings*.json"];
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_ONLY_COMMANDS = new Set([
  "cat", "echo", "file", "find", "grep", "head", "less", "ls", "rg", "stat", "tail", "wc",
]);
const READ_ONLY_GIT = new Set(["diff", "grep", "log", "show", "status"]);
const WRITING_COMMANDS = new Set([
  "chmod", "chown", "cp", "dd", "install", "ln", "mv", "rm", "rmdir", "tee", "touch", "truncate",
]);
const WRITING_GIT = new Set(["checkout", "mv", "restore", "rm"]);
// Agents that must never change the repo. Claude Code names the agent in agent_type.
const READ_ONLY_AGENTS = new Set(["verifier"]);
const READ_ONLY_AGENT_GIT = new Set([
  ...READ_ONLY_GIT, "blame", "cat-file", "describe", "ls-files", "merge-base", "rev-list", "rev-parse", "shortlog",
]);

class Blocked extends Error {}

function isSecretEnvFile(path) {
  const name = basename(path).toLowerCase();
  if ([".env.example", ".env.sample", ".env.template"].includes(name)) return false;
  return name === ".env" || name.startsWith(".env.");
}

// These files can expose a running process's secrets.
function isProcessSecret(path) {
  return /^\/proc\/[^/]+\/(cmdline|environ|mem)$/.test(path);
}

function parseList(text, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start < 0) return [];
  const clean = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2");
  const value = lines[start].slice(key.length + 1).replace(/\s+#.*$/, "").trim();
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) throw new Error(`${key} is not a closed list`);
    return value.slice(1, -1).split(",").map(clean).filter(Boolean);
  }
  if (value) throw new Error(`${key} must be a list`);
  const items = [];
  for (const line of lines.slice(start + 1)) {
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (!item) break;
    items.push(clean(item[1]));
  }
  return items;
}

// Turns a policy pattern into a regular expression: ** crosses folders, * does not.
function globToRegExp(glob) {
  const source = glob.replace(/^\.\//, "").replace(/[.+^${}()|[\]\\]|\*\*\/?|\*|\?/g, (part) => {
    if (part === "**/" || part === "**") return ".*";
    if (part === "*") return "[^/]*";
    if (part === "?") return "[^/]";
    return `\\${part}`;
  });
  return new RegExp(`^${source}$`);
}

// Finds the checkout that holds a path, so a worktree is judged by its own relative paths.
function checkoutOf(path) {
  let dir = dirname(path);
  for (;;) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadPolicy(root, projectDir) {
  const path = [root, projectDir].filter(Boolean).map((dir) => resolve(dir, POLICY_PATH)).find(existsSync);
  if (!path) throw new Error(`${POLICY_PATH} is missing`);
  const text = readFileSync(path, "utf8");
  return {
    humanOnly: [...ALWAYS_PROTECTED, ...parseList(text, "human_only_paths")].map(globToRegExp),
    neverRun: parseList(text, "never_run"),
  };
}

function checkEdit(path, cwd, projectDir) {
  const full = resolve(cwd, path);
  if (isSecretEnvFile(full)) throw new Blocked(`${path} is an environment file`);
  const root = checkoutOf(full);
  if (!root) return;
  const repoPath = relative(root, full).split(sep).join("/");
  const policy = loadPolicy(root, projectDir);
  if (policy.humanOnly.some((pattern) => pattern.test(repoPath))) {
    throw new Blocked(`${repoPath} is a human-only path`);
  }
}

function checkRead(path, cwd) {
  if (!path) return;
  const full = resolve(cwd, path);
  if (isSecretEnvFile(full)) throw new Blocked(`${path} is an environment file`);
  if (isProcessSecret(full)) throw new Blocked(`${path} can expose process secrets`);
}

function words(segment) {
  return segment.replace(/[()`"']/g, " ").split(/[\s=]+/).filter(Boolean);
}

function commandWords(segment) {
  const all = segment.replace(/[()`"']/g, " ").trim().split(/\s+/).filter(Boolean);
  while (all.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(all[0]) || ["sudo", "command"].includes(all[0]))) all.shift();
  return all;
}

function isReadOnly([command, sub]) {
  return READ_ONLY_COMMANDS.has(command) || (command === "git" && READ_ONLY_GIT.has(sub));
}

function writesFiles(list) {
  const [command, sub] = list;
  if (WRITING_COMMANDS.has(command)) return true;
  if (command === "git") return WRITING_GIT.has(sub);
  return ["sed", "perl"].includes(command) && list.some((word) => /^-[A-Za-z]*i/.test(word));
}

function neverRunMatch(segment, entry) {
  const escaped = entry.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w-])`).test(segment);
}

// Words that name files. A commit message or a search pattern is text, not a file.
function fileWords(segment, list) {
  if (list[0] === "git" && list[1] === "commit") return [];
  const all = words(segment.replace(/[<>]/g, " "));
  if (!["grep", "rg"].includes(list[0])) return all;
  const pattern = all.slice(1).find((word) => !word.startsWith("-"));
  return all.filter((word) => word !== pattern);
}

function checkBash(command, startDir, projectDir) {
  const policy = loadPolicy(checkoutOf(resolve(startDir, "x")), projectDir);
  let cwd = startDir;
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const list = commandWords(segment.replace(/\d?>>?\s*\S+|<\s*\S+/g, " "));
    if (list[0] === "cd" && list[1]) cwd = resolve(cwd, list[1]);
    for (const word of fileWords(segment, list)) {
      if (isSecretEnvFile(word)) throw new Blocked(`the command touches ${word}, an environment file`);
      if (isProcessSecret(word)) throw new Blocked(`the command touches ${word}, which can expose process secrets`);
    }
    if (!isReadOnly(list)) {
      const entry = policy.neverRun.find((item) => neverRunMatch(segment, item));
      if (entry) throw new Blocked(`"${entry}" is listed under never_run`);
    }
    const targets = [...segment.matchAll(/\d?>>?\s*([^\s;|&]+)/g)].map((match) => match[1]);
    if (writesFiles(list)) targets.push(...list.slice(1).filter((word) => !word.startsWith("-")));
    for (const target of targets) {
      if (!target.startsWith("/dev/")) checkEdit(target, cwd, projectDir);
    }
  }
}

// The git subcommand, after options such as -C <dir> or --no-pager.
function gitSubcommand(list) {
  for (let i = 1; i < list.length; i += 1) {
    if (["-C", "-c"].includes(list[i])) i += 1;
    else if (!list[i].startsWith("-")) return list[i];
  }
  return "";
}

// A read-only agent may run checks, but no command that writes files or changes git state.
function checkReadOnlyAgent(tool, args, agent) {
  if (EDIT_TOOLS.has(tool)) throw new Blocked(`the ${agent} agent is read-only and can't use ${tool}`);
  if (tool !== "Bash") return;
  for (const segment of String(args.command ?? "").split(/&&|\|\||[;|\n]/)) {
    const list = commandWords(segment.replace(/\d?>>?\s*\S+|<\s*\S+/g, " "));
    const target = [...segment.matchAll(/\d?>>?\s*([^\s;|&]+)/g)].map((match) => match[1])
      .find((path) => !path.startsWith("/dev/"));
    if (target) throw new Blocked(`the ${agent} agent is read-only and can't write to ${target}`);
    const [command] = list;
    const findWrites = command === "find"
      && list.some((word) => ["-delete", "-exec", "-execdir", "-ok", "-fprint"].includes(word));
    if (writesFiles(list) || command === "xargs" || findWrites
      || (command === "git" && !READ_ONLY_AGENT_GIT.has(gitSubcommand(list)))) {
      throw new Blocked(`the ${agent} agent is read-only and can't run "${segment.trim()}"`);
    }
  }
}

export function evaluate(input, projectDir) {
  const tool = input.tool_name;
  const args = input.tool_input ?? {};
  const cwd = input.cwd || projectDir;
  if (READ_ONLY_AGENTS.has(input.agent_type)) checkReadOnlyAgent(tool, args, input.agent_type);
  if (EDIT_TOOLS.has(tool)) checkEdit(args.file_path ?? args.notebook_path, cwd, projectDir);
  else if (tool === "Read") checkRead(args.file_path, cwd);
  else if (tool === "Grep") checkRead(args.path, cwd);
  else if (tool === "Bash") checkBash(String(args.command ?? ""), cwd, projectDir);
}

function main() {
  if (process.env.KIT_GUARD === "off") return 0;
  const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
    if (!isAbsolute(input.cwd || projectDir)) throw new Error("cwd is not absolute");
    evaluate(input, projectDir);
    return 0;
  } catch (error) {
    if (error instanceof Blocked) {
      console.error(`agent-kit guard blocked this: ${error.message}. Stop and ask the user to do it.`);
      return 2;
    }
    // A read can't change anything, so an unreadable policy only stops writes and commands.
    if (["Read", "Grep"].includes(input.tool_name)) return 0;
    console.error(`agent-kit guard could not verify this action: ${error.message}. Stop and tell the user.`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
