# Changelog

## 1.8.0

- `delegate`: the worker now merges the task branch before it reads `AGENTS.md` or
  `.agent/policy.yml`, so it follows that branch's rules. Before, it read the rules from
  the default branch its worktree started on.
- `.agent/policy.yml` accepts an optional `setup_command`, such as `npm ci`. The worker
  runs it after the merge and before editing, and stops if it fails. Policies without it
  stay valid. An empty value is "could not verify".
- New managed `.claude/agents/verifier.md` in `delegate`. It has only `Read`, `Grep`,
  `Glob` and `Bash`, so it can't edit files or start agents. It checks a diff against
  the briefs and owned paths, reruns the done-check, and reports in a fixed format with
  "could not verify" for checks that can't run.
- The guard blocks file edits and shell writes, commits, merges and branch switches
  when the calling agent is `verifier`.
- The `## Delegation` snippet tells the main agent to run the verifier once on the
  combined task diff, and on any risky or failed brief. With `delegate` on, `check`
  fails until that section names `verifier`. Update the section by hand in the 1.8.0
  sync PR; `sync` prints the new text.
- With `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` on, the verifier runs on the worker model.
  Claude Code has no per-agent override while the setting is on. The README documents
  this, and the setting stays required. The minimum Claude Code version is corrected to
  2.1.257, as in the current docs.

## 1.6.0

- `agent-brief` now separates reading from writing. The `review` job has read-only GitHub
  access and no edit, push, comment, web or issue tools. A `publish` job with no agent
  validates its structured result, then posts the brief, label and filed issues.
- Fixes run only when someone adds the `claude-fix` label.
- The workflow sets `--permission-mode default`, so its tool list is strict. The action's
  default auto mode can allow tools outside that list after a safety review.
- Managed workflows pin third-party actions to full commit SHAs.
- `pr-triage` has `review` and `fix` modes and treats repository text as evidence, not
  instructions.
- The guard blocks `/proc/*/environ`, `cmdline` and `mem`.

## 1.5.0

- New managed `.agent/guard.mjs` in `core`: a PreToolUse hook that enforces
  `human_only_paths` and `never_run`, and keeps agents out of `.env` files. It also
  protects itself, `.agent/policy.yml` and `.claude/settings*.json`. If it can't read the
  policy, it blocks edits and commands and still allows reads.
- `check` now requires a PreToolUse hook that runs `.agent/guard.mjs`. `adopt` adds it to
  new settings files. `adopt` and `sync` print the hooks when an existing file lacks them,
  so add the hook by hand in the 1.5.0 sync PR.
- The guard is a guardrail, not a sandbox. It can't see what a program started from Bash
  does. `KIT_GUARD=off` turns it off for a session you start yourself.

## 1.4.0

- New managed `.agent/skill-gate.mjs` in `core`: a UserPromptSubmit hook. When a prompt
  mentions a skill, plugin or MCP server, it reminds the agent to scan it with
  [SkillSpector](https://github.com/NVIDIA/SkillSpector) before adding it. It says
  "could not verify" when SkillSpector isn't installed. It never blocks a prompt.
- `AGENTS.md` now requires a `## Skill vetting` section: a static `--no-llm` scan first,
  a `claude_cli` LLM rescan on CAUTION, no install on DO_NOT_INSTALL or could-not-verify.
- `check` now requires a UserPromptSubmit hook that runs `.agent/skill-gate.mjs` in
  `.claude/settings.json`. `adopt` adds the section and the hook to files it creates.
  `adopt` and `sync` print both when an existing file lacks them, so add them in the
  1.4.0 sync PR.

## 1.3.0

- New optional `delegate` module: a managed `.claude/agents/worker.md`. The main
  agent plans, sends each brief to a worker, and reviews the result. Workers run
  in their own worktree, can't spawn agents, commit locally and never push.
- With `delegate` on, `check` requires a `## Delegation` section in `AGENTS.md`, and
  `CLAUDE_CODE_SUBAGENT_MODEL` plus `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` under `env`
  in `.claude/settings.json`, so every subagent runs on the model named there.
  `adopt` adds both to files it creates. `adopt` and `sync` print the snippets when
  an existing file lacks them.
- Repos that don't turn `delegate` on only need a `sync`. A repo with its own
  `.claude/agents/worker.md` must rename it or turn the module on.

## 1.2.0

- New managed `.agent/freshness.mjs` in `core`: a SessionStart hook that runs
  `git fetch origin` and warns when local `<base>` or the current branch is behind
  `origin/<base>`, telling the agent to read code from `origin/<base>`. It only updates
  remote-tracking refs and never changes files. If the fetch fails, it reports "could
  not verify".
- `check` now requires `.claude/settings.json` with a SessionStart hook that runs
  `.agent/freshness.mjs`. `adopt` creates the file when it's missing. `adopt` and `sync`
  print the snippet when an existing file lacks the hook, so add it in the 1.2.0 sync PR.
- The `AGENTS.md` template says to read code from `origin/<base>`, not the local
  checkout. New default `human_only_paths` entry: `.claude/settings.json`.

## 1.1.1

- `agent-brief` skips with a warning when `CLAUDE_CODE_OAUTH_TOKEN` is not set, instead
  of failing and adding `agent/could-not-verify` to every PR. A real agent failure is
  still reported as could-not-verify.

## 1.1.0

- `AGENTS.md` now requires a `## Session budget` section: one task per session ending
  with a `/clear` reminder, a 300k context cap, and unused plugins turned off. Repos
  must add the section before syncing to 1.1.0.
- The `agent-brief` review (pr-triage with ponytail) runs on Sonnet instead of Opus to
  cut cost per PR.

## 1.0.1

- `pr-triage` no longer treats tests left to CI as "could not verify", and doesn't try
  to run them.
- Only a breaking public API change is a design trigger by default, and a trigger needs
  a clear match. In testing, the same additive export got different labels on two runs.

## 1.0.0

First version: `adopt`, `check` and `sync`, the `core`, `review` and `triage`
modules, and the standard docs templates.
