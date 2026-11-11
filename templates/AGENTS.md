# {{PROJECT}} agent guide

This is the canonical entry point for coding agents. Keep it short. Durable
design belongs in `ARCHITECTURE.md`; volatile state and exact procedures belong
under `docs/`.

## Repository

- TODO(adopt): canonical checkout path, environments, and anything an agent must not confuse with this repo.
- Preserve unrelated and uncommitted work. Do not commit, push, deploy, or
  mutate external services unless the user explicitly requests it.

## Start here

Read only the documents needed for the task:

| Task | Required reading |
|---|---|
| System design or module boundaries | `ARCHITECTURE.md` |
| Current readiness or open questions | `docs/STATUS.md` |
| Tests or verification | `docs/TESTING.md` and `docs/STATUS.md` |
| Agent limits for this repo | `.agent/policy.yml` and `.agent/lessons.md` |

`docs/README.md` is the complete index. Files in `docs/history/` are immutable
evidence, not current instructions.

## Safety rules

1. Never print, store, commit, or paste secrets.
2. Commands must use known paths and values. If a value is unknown, run a
   discovery command first; never leave a placeholder that can run literally.
3. TODO(adopt): each real hazard in this repo, naming the exact command, test, or resource.

## Engineering invariants

- TODO(adopt): one-line, testable rules that are expensive to break. Not style preferences.

## Working standard

- Treat code, migrations, and tests as evidence when documentation disagrees.
- Label facts as validated, unvalidated, historical, or inferred.
- Update the canonical document in the same change as behavior; link to facts
  instead of repeating them.
- Before planning, run `git fetch origin` and read code from `origin/<base>`
  (`git show origin/<base>:<path>` or a fresh worktree), not the local checkout.
  Merge `origin/<base>` into a work branch before its PR.
- Run the smallest safe relevant tests first.
- A check that can't run reports "could not verify", never "nothing found".

## Session budget

- One task per session. When a task is done, end with "Task done — run /clear
  before the next task."
- Context is capped at 300k tokens by the machine setting
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000`; keep it set.
- Turn off plugins and skills this repo doesn't use (`enabledPlugins` in
  `.claude/settings.json`).
