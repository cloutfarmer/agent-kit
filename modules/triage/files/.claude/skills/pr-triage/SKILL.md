---
name: pr-triage
description: >
  Review a pull request with ponytail-review, sort every finding into tier 1
  (critical bug), tier 2 (minor bug) or tier 3 (unreachable), fix what the tier
  rules and .agent/policy.yml allow, file the rest as GitHub issues, and leave
  one brief and one label for the human who merges. Use for "triage this PR",
  "review PR #N before merge", /pr-triage.
---

Finding problems is easy; a reviewer that looks will always find some.
Sorting them is the job. Fix what matters, park the rest, never pad the list.
You prepare the decision. You never merge.

## 1. Read the project's rules

Read `AGENTS.md`, `.agent/policy.yml` and `.agent/lessons.md`. A change that
breaks an `AGENTS.md` safety rule or invariant is a bug, and so is a change
that repeats a failure recorded in the lessons.

From the policy:

- `human_only_paths`: never edit these, even to fix a tier 1.
- `design_triggers`: changes that need a design decision from the human. A trigger
  applies only when the diff clearly matches it. Adding a helper or export that changes
  nothing existing is not a breaking public API change.
- `never_run`: tests or commands you must not run. Also never run anything that
  opens a real database or reaches a production service.

CI runs the project's tests, so don't try to run them here. That isn't a gap to
report: judge the code by reading it, and let CI confirm it.

## 2. Review

Run the `ponytail-review` skill on the pull request named in the prompt, or the
current branch against the policy's `base_branch` when none is named.

Keep ponytail's evidence bar: every finding needs a concrete input or situation
that leads to a wrong result. No case, no finding. Reproduce each finding against
the actual diff before acting on it, whoever or whatever reported it.

## 3. Tier every finding

Judge reachability against how the project runs today (`ARCHITECTURE.md`,
`docs/STATUS.md`), not against hypothetical future callers.

- **Tier 1, critical bug.** Reachable now, and it causes a wrong result, a crash,
  data loss, a security or privacy hole, a leaked secret, or breaks an `AGENTS.md`
  invariant.
- **Tier 2, minor bug.** Reachable now, but the impact is small or recoverable: a
  confusing error, a cosmetic UI fault, risky new logic with no test that would
  catch it breaking.
- **Tier 3, unreachable.** Needs an input, state or load that cannot happen today,
  or it is not a bug at all (lean, speed, structure suggestions).

When unsure between two tiers, pick the lower one and say why in one line.

## 4. Act on the tier

- **Tier 1: always fix,** unless the fix touches a human-only path or needs a
  design decision. Report those in the brief instead.
- **Tier 2: fix only if** the fix is trivial (a few lines, one file, no new
  dependency, no migration) **or** the case is a likely edge case (empty input,
  last item, retry, time zone). Otherwise file it.
- **Tier 3: never fix.** File it.

Fix rules:

- Smallest fix that works; prefer fixes that delete code.
- Put all fixes in one commit on the PR branch, message
  `review: fix tier 1/2 findings from pr-triage`, with a body listing finding
  numbers. Push with exactly `git push origin HEAD`. Don't open a new branch or PR.

Filing rules:

- One GitHub issue per filed finding, labelled `tier-2` or `tier-3`. Title: the
  finding's bold title. Body: the four ponytail parts (what this is, problem, fix,
  if we skip it), the file and line, and `Found in #<PR number>`.
- Before creating, search open issues for the same file and problem. If one exists,
  comment the PR link on it instead of opening a duplicate.

## 5. Write the brief

Create or update one PR comment with
`gh pr comment <PR> --edit-last --create-if-none --body-file <file>`. Keep the
first line and the `Reviewed SHA` line exactly as shown, using the SHA from the
prompt:

```
<!-- agent-brief -->
## Agent brief

Reviewed SHA: <full reviewed SHA>
Fix commit: <short sha, or none>

What this change does: <two or three sentences>

| # | Tier | Finding | Action |
|---|------|---------|--------|
| 1 | T1 | <title> (`path:line`) | fixed in <short sha> |
| 2 | T2 | <title> | filed #<issue> |

Recommendation: <Ship. | Ship after CI passes on the fix commit. | Needs human: <why>.>
Not checked: <one line, only if something mattered and could not be checked>
```

Nothing found: use the same header lines, then the "What this change does" line,
`Recommendation: Ship.` and one line on what was checked.

## 6. Apply exactly one label

Use `gh pr edit <PR> --add-label <label>`. Pick the first that applies:

1. `human/sensitive`: the diff touches a `human_only_paths` file, or a tier 1 fix
   would need one.
2. `human/design`: the diff hits a `design_triggers` item.
3. `agent/could-not-verify`: you couldn't complete the review itself, such as an
   unreadable diff or policy. Tests left to CI don't count. Never report a check that
   failed to run as "nothing found".
4. `agent/ready`: reviewed, with no unresolved tier 1. This includes a recommendation
   of "Ship after CI passes on the fix commit."

Never use `gh pr merge`, and never push to any other branch.
