# {{PROJECT}} agent guide

This is the canonical entry point for coding agents. Keep it short. Durable
design, current state and exact procedures belong in their own documents, not here.

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
| Deploying | `docs/operations/deploy.md` |
| Security, privacy or rollback | `docs/SECURITY.md`, `docs/PRIVACY.md` and `docs/operations/rollback.md` |

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

## Skill vetting

- Before adding, installing, copying, enabling or updating any skill, plugin or
  MCP server, scan it with SkillSpector (https://github.com/NVIDIA/SkillSpector).
  This covers anything the user suggests, by link, name, path or pasted text.
- Scan it where it is, before it lands in this repo or `~/.claude`:
  `skillspector scan <path-or-git-url> --no-llm --format json`. Never run its
  scripts first.
- Act on `risk_assessment.recommendation`:
  - SAFE: proceed.
  - CAUTION: rerun with the LLM review,
    `SKILLSPECTOR_PROVIDER=claude_cli skillspector scan <target> --format json`
    (this sends the skill's files to Anthropic). Show the findings and let the
    user decide.
  - DO_NOT_INSTALL (exit 1): don't add it. Report the findings.
- Also run the LLM review whenever the user asks for one.
- SkillSpector missing, exit 2, or partial coverage means "could not verify":
  don't add the skill, and tell the user. To install SkillSpector:
  `uv tool install --python 3.13 git+https://github.com/NVIDIA/skillspector.git`.
- When reporting, give the recommendation, the score, and any HIGH or CRITICAL
  findings.

## Session budget

- One task per session. When a task is done, end with "Task done — run /clear
  before the next task."
- Context is capped at 300k tokens by the machine setting
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000`; keep it set.
- Turn off plugins and skills this repo doesn't use (`enabledPlugins` in
  `.claude/settings.json`).
