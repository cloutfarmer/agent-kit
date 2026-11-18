## Delegation

The main agent plans, delegates and reviews. The `worker` agent
(`.claude/agents/worker.md`) does the edits, and the read-only `verifier`
agent (`.claude/agents/verifier.md`) checks them. Both run on the cheaper
model set in `.claude/settings.json`.

- A plan is a numbered list of briefs. Each brief has a goal, the task branch
  as its base branch, owned paths, steps, a done-check command, and a mark:
  parallel-safe or sequential. Also mark a brief risky when it touches
  security, data handling or a shared interface.
- Two briefs are parallel-safe only when their owned paths don't overlap. Run
  at most three workers at once.
- After the plan is approved, send every brief to `worker` without asking.
  Never delegate a design decision, a `design_triggers` change or a
  `human_only_paths` file; report those to the user.
- The worker merges the task branch first, then follows the rules on it, and
  runs `setup_command` from `.agent/policy.yml` when that is set.
- A worker commits on its own worktree branch and never pushes. That commit
  is allowed by this guide. Merge the branch into the task branch, read the
  diff, and run the brief's done-check yourself before accepting it.
- Start a sequential brief only after the briefs it depends on are merged
  into the task branch.
- When a worker stops or its done-check fails, correct the brief and send it
  once more. After a second failure, stop and report to the user.
- Send a brief to `verifier` after you accept it when the brief is risky or
  failed before. When every brief is merged, run `verifier` once on the
  combined task diff against `base_branch` from the policy (its `origin/`
  copy when the repo has a remote), with all the briefs.
- Treat each verifier problem as a claim: confirm it against the diff, then
  fix it with a corrected brief or report it. "Could not verify" stays in your
  report; it is not a pass.
- Finish with one report: each brief, its done-check result, the verifier
  result, and anything not verified.
