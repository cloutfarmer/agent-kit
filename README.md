# agent-kit

One standard setup for docs, CI and agent work across repositories. Agents prepare
the work, a person merges it, and a check keeps each repo matching the kit.

## Commands

Run these from a local copy of the kit. `init`, `adopt` and `sync` only preview changes
until you add `--write`.

```bash
node bin/kit.mjs init  --repo ../my-project
node bin/kit.mjs adopt --repo ../my-project --modules core,review,triage
node bin/kit.mjs check --repo ../my-project
node bin/kit.mjs sync  --repo ../my-project
```

| Exit code | Meaning |
|---|---|
| 0 | Pass |
| 1 | Fail: the repo differs from the kit |
| 2 | Could not verify: the check itself couldn't finish |

Without a profile, `adopt` installs `core`, `review` and `triage`. With one, it defaults to
`core` for `sandbox`, `core,review` for `personal`, and all three for `public` and
`product`. `--modules` overrides the default.

Other `adopt` options: `--base-branch`, `--ci-job`, `--scan-command`, and
`--replace-managed` to overwrite managed files that differ from the kit.

## Project profiles

A profile says what a repo is for, so the kit asks only for the process that purpose
needs. Exposure (who can see or reach it) sets the security floor. Stakes (what breaks,
and for whom) set the amount of process. Each profile includes everything in the ones
above it.

| Profile | For | Adds |
|---|---|---|
| `sandbox` | Learning and throwaway work | `README.md`, a short `AGENTS.md`. CI and `kit-check` are optional |
| `personal` | Something deployed, or real personal data, paid services or production credentials | `docs/STATUS.md`, `docs/TESTING.md`, `docs/README.md`, CI with tests and the secret scan, the freshness hook |
| `public` | A public repo or a live public site | `ARCHITECTURE.md`, `docs/operations/deploy.md`, `kit-check`, and a branch protection checklist |
| `product` | Other people's data, accounts or money | `docs/SECURITY.md`, `docs/PRIVACY.md`, `docs/operations/rollback.md`, and a checklist for sandboxing, separate production credentials, dependency checks and a secret-history scan |

Every profile keeps `CLAUDE.md`, `AGENTS.md` with its `Safety rules` and `Skill vetting`
sections, `.agent/policy.yml`, and the `guard` and `skill-gate` hooks. A managed file a
profile doesn't need is not installed or required. If a repo adds one anyway, such as
`kit-check` in a sandbox, `check` holds it to the kit like any other managed file.

A repo with no `profile` in its policy keeps the full requirements, so repos adopted
before 1.7.0 stay valid. An unknown profile is "could not verify".

### `kit init`

`init` asks seven questions and recommends a profile. Without a terminal, such as in a
script or an agent session, pass every answer as a flag:

```bash
node bin/kit.mjs init --repo ../my-project \
  --goal learning|personal-tool|showcase|product \
  --users only-me|invited|anyone \
  --public yes|no --deployed yes|no \
  --data none|personal|others \
  --services none|paid|credentials|payments \
  --recovery easy|moderate|hard
```

`--data personal` means your own personal or private data; `others` means anyone else's.
The riskiest answer wins: other people's data, payments or a product goal give `product`;
a public repo, a live site anyone can use, or a showcase give `public`; anything deployed,
real personal data, paid services, production credentials, invited users or a hard
recovery give `personal`; otherwise `sandbox`. The reason is saved as `profile_reason`.

To choose a lighter profile than recommended, add `--profile NAME --reason "why"`. A
stricter one needs only `--profile`. `init` refuses a repo that already has a policy.

`init --reassess` asks again for an adopted repo and shows the new profile, the files it
would create and the files it no longer requires. With `--write` it changes only the
`profile` and `profile_reason` lines in `.agent/policy.yml` and creates missing files. It
never deletes files and never edits `AGENTS.md`; it prints any section you need to add.

`check` prints the `public` and `product` checklist items as "not verified by kit check",
because it can't read GitHub settings or your machine.

## Modules

| Module | Adds |
|---|---|
| `core` (required) | `kit-check` workflow, repository scan, the `freshness` session-start hook, the `skill-gate` prompt hook, and the `guard` policy hook. A profile can leave out the first three |
| `review` | `ponytail-review`, run on request |
| `triage` (needs `review`) | `pr-triage`, plus the `agent-brief` and `agent-tripwire` workflows |
| `delegate` (optional, off by default) | The `worker` and `verifier` agents: the main agent plans and reviews, workers on a cheaper model do the edits, and a read-only verifier checks them |

## How repos stay matched

| Group | Examples | Rule |
|---|---|---|
| Managed | Files under `modules/*/files/` | Must match the kit exactly |
| Required structure | The docs and `AGENTS.md` sections the profile requires (always `Safety rules` and `Skill vetting`), `CLAUDE.md`, the freshness, skill-gate and guard hooks in `.claude/settings.json`, and the `delegate` section and settings when that module is on | Must exist in the right shape |
| Project-owned | `.agent/policy.yml`, `.agent/lessons.md`, doc content, the repo's CI | Never overwritten. `init --reassess --write` changes only the two profile lines |

`.agent/policy.yml` holds each repo's differences, and `.agent/kit.lock` records its kit
version and file hashes. Skills the kit doesn't provide are project-owned, and `check`
ignores them. To change a managed file, change the kit, release a version,
and run `sync` in the repo on a review branch.

## What the guard enforces

`.agent/guard.mjs` runs before Claude Code uses a file tool or Bash. It blocks:

- edits to `human_only_paths`, `.agent/guard.mjs`, `.agent/policy.yml` and
  `.claude/settings*.json`
- reads, edits and shell commands that touch `.env` files, except `.env.example`,
  `.env.sample` and `.env.template`
- commands listed in `never_run`, unless the command only reads, such as `cat` or `rg`
- common shell writes to protected paths, such as `rm`, `mv`, `cp`, `tee`, `sed -i` and
  output redirects
- process files that can expose secrets, such as `/proc/self/environ`

When the delegate module's `verifier` agent is running, the guard also blocks every
file edit tool and any shell command that writes files, commits, merges or switches
branches. Claude Code tells the hook which agent is calling through `agent_type`.

It is a guardrail, not a sandbox. A script or interpreter started from Bash can still do
things the hook can't see. To change a protected file through an agent, start that session
with `KIT_GUARD=off claude`.

## Skill vetting (core)

Every repo must vet a skill, plugin or MCP server with
[SkillSpector](https://github.com/NVIDIA/SkillSpector) before an agent adds it. The
rule lives in the `## Skill vetting` section of `AGENTS.md`. The managed
`.agent/skill-gate.mjs` hook adds a reminder to any prompt that mentions a skill,
plugin or MCP server. It never blocks a prompt.

- The agent runs a static scan first: `skillspector scan <target> --no-llm --format json`.
  Nothing leaves the machine except dependency names, which go to OSV.dev.
- SAFE: the agent proceeds. CAUTION: it reruns with
  `SKILLSPECTOR_PROVIDER=claude_cli`, which sends the skill's files to Anthropic, and
  lets you decide. DO_NOT_INSTALL: it doesn't add the skill.
- If SkillSpector is missing, errors, or reports partial coverage, the result is
  "could not verify" and the skill is not added.

Each machine needs `uv` and Python 3.13:

```bash
uv tool install --python 3.13 git+https://github.com/NVIDIA/skillspector.git
```

## Setup for the `triage` module

Add `CLAUDE_CODE_OAUTH_TOKEN` to the repo's Actions secrets and install the Claude
GitHub App. Without the secret, `agent-brief` skips with a warning instead of failing,
and no review runs.

`agent-brief` reviews with read-only access, then a separate job with no agent checks and
publishes the result. Add the `claude-fix` label to a PR when you want the agent to push
its allowed fixes. Add `claude-review` to review it again.

Repos on GitHub Free can't enforce any of this on merge, so treat a
failed check as your signal not to merge.

## Setup for the `delegate` module

Add `delegate` to `modules` in `.agent/policy.yml`, then run `sync` on a review branch.
`sync` installs `.claude/agents/worker.md` and `.claude/agents/verifier.md`, and prints
two things to add by hand, because the kit never edits project-owned files:

- A `## Delegation` section in `AGENTS.md`. It tells the main agent to write its plan
  as briefs, send them to workers, and run the verifier. `check` fails until the section
  names `verifier`.
- Two keys under `env` in `.claude/settings.json`:
  `CLAUDE_CODE_SUBAGENT_MODEL` (the worker model, `sonnet` by default) and
  `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` set to `"1"`. Together they put every subagent on
  that model, whatever the main session runs on. This needs Claude Code 2.1.257 or
  later. The agent files have no `model` line, so the settings file is the only place
  the model is set.

| Agent | What it does | Limits |
|---|---|---|
| `worker` | Carries out one brief in its own git worktree, then commits there | Can't start other agents. The guard still applies |
| `verifier` | Checks a diff against its briefs and owned paths, reruns the done-check, and reports only problems it can back with evidence | Only `Read`, `Grep`, `Glob` and `Bash`. The guard blocks shell writes while it runs |

The worker merges the task branch first, then reads `AGENTS.md` and `.agent/policy.yml`,
so it follows the rules on that branch. If the policy sets `setup_command`, such as
`npm ci`, the worker runs it in its worktree before editing, and stops if it fails.
The setting is optional.

The verifier runs on the same forced model as the workers. With
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` on, Claude Code ignores the `model` line in every
agent file, so no single agent can use a stronger model. The kit keeps the setting on,
so the verifier is a second check on the cheaper model, not a stronger reviewer. The
main agent still reads every diff itself.

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
