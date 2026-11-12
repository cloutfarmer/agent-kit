# Changelog

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
