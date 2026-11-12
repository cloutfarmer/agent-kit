## Delegation

The main agent plans, delegates and reviews. The `worker` agent
(`.claude/agents/worker.md`) does the edits on the cheaper model set in
`.claude/settings.json`.

- A plan is a numbered list of briefs. Each brief has a goal, the task branch
  as its base branch, owned paths, steps, a done-check command, and a mark:
  parallel-safe or sequential.
- Two briefs are parallel-safe only when their owned paths don't overlap. Run
  at most three workers at once.
- After the plan is approved, send every brief to `worker` without asking.
  Never delegate a design decision, a `design_triggers` change or a
  `human_only_paths` file; report those to the user.
- A worker commits on its own worktree branch and never pushes. That commit
  is allowed by this guide. Merge the branch into the task branch, read the
  diff, and run the brief's done-check yourself before accepting it.
- Start a sequential brief only after the briefs it depends on are merged
  into the task branch. The worker merges the task branch before it edits.
- When a worker stops or its done-check fails, correct the brief and send it
  once more. After a second failure, stop and report to the user.
- Finish with one report: each brief, its done-check result, and anything
  not verified.
