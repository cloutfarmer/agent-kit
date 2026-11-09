# Changelog

## 1.1.0

- `AGENTS.md` now requires a `## Session budget` section: one task per session ending
  with a `/clear` reminder, a 300k context cap, and unused plugins turned off. Repos
  must add the section before syncing to 1.1.0.
- The `agent-brief` review (pr-triage with ponytail) runs on Sonnet instead of Opus to
  cut cost per PR.

## 1.0.1

- `pr-triage` no longer treats tests left to CI as "could not verify", and doesn't try
  to run them.
- Only a breaking public API change is a design trigger by default, and a trigger needs
  a clear match. In testing, the same additive export got different labels on two runs.

## 1.0.0

First version: `adopt`, `check` and `sync`, the `core`, `review` and `triage`
modules, and the standard docs templates.
