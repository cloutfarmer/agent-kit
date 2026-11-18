# Principles

Adapted from [Agentic Maintenance](https://santifer.io/ai-agent-fleet) for one developer
working across several repositories. That article describes a large public project, so
this kit keeps its core ideas and leaves out what exists to manage a community.

| Principle | In this kit |
|---|---|
| Rules files and tests are ground truth | `AGENTS.md` and each repo's CI |
| Agents propose, a person decides | One brief and one label per PR, and no merge tool for the agent |
| Files are tiered by blast radius | `human_only_paths` in `.agent/policy.yml`, enforced by the `guard` hook |
| Reproduce a claim before acting on it | A finding needs a concrete failing case, checked against the diff |
| A failed check says "could not verify" | `kit check` exit code 2, and the `agent/could-not-verify` label. A module that isn't set up yet, such as `agent-brief` without its secret, is skipped with a warning, not failed |
| Public actions depend on real success | The review job can't write to GitHub. A separate job validates and publishes its result |
| Lessons compound | `.agent/lessons.md`, read on every review, one rule per real failure |
| Work is isolated | Separate worktrees and branches. Agents read code from `origin/<base>`, and a session-start hook warns when the checkout is behind |

Left out on purpose: Discord and community agents, first-timer gates, contributor
dossiers, and a persistent fleet of sessions.

Added beyond the source: the optional `delegate` module. The main agent plans and
reviews on the strongest model, and `worker` agents do the edits on the cheaper model
forced in `.claude/settings.json`. A worker lasts for one brief, so this is not a
persistent fleet.

Also added: skill vetting in `core`. Third-party skills, plugins and MCP servers are
scanned with SkillSpector before an agent adds them. A missing scanner or partial
scan is "could not verify", not a pass.

Also added: project profiles. The source article describes one large public project, where
every safeguard is worth its cost. Across many small repos, a learning sandbox and a product
with other people's data need different amounts of process, so each repo declares its
purpose and the kit applies only what that purpose justifies. The safety floor (guard,
skill vetting, secret rules) is the same for all of them.
