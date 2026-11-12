# agent-kit

One standard setup for docs, CI and agent work across repositories. Agents prepare
the work, a person merges it, and a check keeps each repo matching the kit.

## Commands

Run these from a local copy of the kit. `adopt` and `sync` only preview changes until
you add `--write`.

```bash
node bin/kit.mjs adopt --repo ../my-project --modules core,review,triage
node bin/kit.mjs check --repo ../my-project
node bin/kit.mjs sync  --repo ../my-project
```

| Exit code | Meaning |
|---|---|
| 0 | Pass |
| 1 | Fail: the repo differs from the kit |
| 2 | Could not verify: the check itself couldn't finish |

Other `adopt` options: `--base-branch`, `--ci-job`, `--scan-command`, and
`--replace-managed` to overwrite managed files that differ from the kit.

## Modules

| Module | Adds |
|---|---|
| `core` (required) | `kit-check` workflow, repository scan, and the `freshness` session-start hook |
| `review` | `ponytail-review`, run on request |
| `triage` (needs `review`) | `pr-triage`, plus the `agent-brief` and `agent-tripwire` workflows |
| `delegate` (optional, off by default) | The `worker` agent: the main agent plans and reviews, workers on a cheaper model do the edits |

## How repos stay matched

| Group | Examples | Rule |
|---|---|---|
| Managed | Files under `modules/*/files/` | Must match the kit exactly |
| Required structure | Required docs, `AGENTS.md` sections, `CLAUDE.md`, the freshness hook in `.claude/settings.json`, and the `delegate` section and settings when that module is on | Must exist in the right shape |
| Project-owned | `.agent/policy.yml`, `.agent/lessons.md`, doc content, the repo's CI | Never overwritten |

`.agent/policy.yml` holds each repo's differences, and `.agent/kit.lock` records its kit
version and file hashes. Skills the kit doesn't provide are project-owned, and `check`
ignores them. To change a managed file, change the kit, release a version,
and run `sync` in the repo on a review branch.

## Setup for the `triage` module

Add `CLAUDE_CODE_OAUTH_TOKEN` to the repo's Actions secrets and install the Claude
GitHub App. Without the secret, `agent-brief` skips with a warning instead of failing,
and no review runs. Repos on GitHub Free can't enforce any of this on merge, so treat a
failed check as your signal not to merge.

## Setup for the `delegate` module

Add `delegate` to `modules` in `.agent/policy.yml`, then run `sync` on a review branch.
`sync` installs `.claude/agents/worker.md` and prints two things to add by hand, because
the kit never edits project-owned files:

- A `## Delegation` section in `AGENTS.md`. It tells the main agent to write its plan
  as briefs and send them to workers.
- Two keys under `env` in `.claude/settings.json`:
  `CLAUDE_CODE_SUBAGENT_MODEL` (the worker model, `sonnet` by default) and
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` set to `"1"`. Together they put every subagent on
  that model, whatever the main session runs on. This needs Claude Code 2.1.251 or
  later. `worker.md` has no `model` line, so the settings file is the only place the
  model is set.

Run the main session on your strongest model. To cut permission prompts, allow the
repo's own test, lint and build commands under `permissions.allow` in
`.claude/settings.json`. Workers already accept their own edits inside their worktree.

See `PRINCIPLES.md` for how the kit applies its source principles.

## Licenses

The kit is MIT licensed. `ponytail-review` is a third-party skill under its own MIT
license; see the `LICENSE` and `SOURCE` files in its folder.

## Tests

```bash
node --test
```
