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
| `core` (required) | `kit-check` workflow and repository scan |
| `review` | `ponytail-review`, run on request |
| `triage` (needs `review`) | `pr-triage`, plus the `agent-brief` and `agent-tripwire` workflows |

## How repos stay matched

| Group | Examples | Rule |
|---|---|---|
| Managed | Files under `modules/*/files/` | Must match the kit exactly |
| Required structure | Required docs, `AGENTS.md` sections, `CLAUDE.md` | Must exist in the right shape |
| Project-owned | `.agent/policy.yml`, `.agent/lessons.md`, doc content, the repo's CI | Never overwritten |

`.agent/policy.yml` holds each repo's differences, and `.agent/kit.lock` records its kit
version and file hashes. Skills the kit doesn't provide are project-owned, and `check`
ignores them. To change a managed file, change the kit, release a version,
and run `sync` in the repo on a review branch.

## Setup for the `triage` module

Add `CLAUDE_CODE_OAUTH_TOKEN` to the repo's Actions secrets and install the Claude
GitHub App. Repos on GitHub Free can't enforce any of this on merge, so treat a failed
check as your signal not to merge.

See `PRINCIPLES.md` for how the kit applies its source principles.

## Licenses

The kit is MIT licensed. `ponytail-review` is a third-party skill under its own MIT
license; see the `LICENSE` and `SOURCE` files in its folder.

## Tests

```bash
node --test
```
