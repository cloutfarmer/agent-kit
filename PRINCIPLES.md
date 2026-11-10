# Principles

Adapted from [Agentic Maintenance](https://santifer.io/ai-agent-fleet) for one developer
working across several repositories. That article describes a large public project, so
this kit keeps its core ideas and leaves out what exists to manage a community.

| Principle | In this kit |
|---|---|
| Rules files and tests are ground truth | `AGENTS.md` and each repo's CI |
| Agents propose, a person decides | One brief and one label per PR, and no merge tool for the agent |
| Files are tiered by blast radius | `human_only_paths` in `.agent/policy.yml` |
| Reproduce a claim before acting on it | A finding needs a concrete failing case, checked against the diff |
| A failed check says "could not verify" | `kit check` exit code 2, and the `agent/could-not-verify` label. A module that isn't set up yet, such as `agent-brief` without its secret, is skipped with a warning, not failed |
| Public actions depend on real success | The brief is verified by a separate step after the agent runs |
| Lessons compound | `.agent/lessons.md`, read on every review, one rule per real failure |
| Work is isolated | Separate worktrees and branches |

Left out on purpose: Discord and community agents, first-timer gates, contributor
dossiers, and a persistent fleet of sessions.
