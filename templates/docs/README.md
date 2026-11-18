# Documentation index

| Document | Purpose | Volatility |
|---|---|---|
| `../ARCHITECTURE.md` | Durable design and invariants | Low |
| `STATUS.md` | Latest verified state, blockers and next gates | High |
| `TESTING.md` | Safe and destructive test procedures | Medium |
| `operations/deploy.md` | How a change reaches users, and how to check it | Medium |
| `SECURITY.md` | Secrets, access and how to report a problem | Medium |
| `PRIVACY.md` | What personal data is held, where, and for how long | Medium |
| `operations/rollback.md` | How to undo a bad release or data change | Medium |

Add these when they have real content: `SECURITY.md`, `ROADMAP.md`, `plans/`,
`operations/`, `decisions/` (`ADR-NNNN-<slug>.md`), and `history/` (dated, never edited).

## Truth and precedence

1. Code, migrations, and tests establish implemented behavior.
2. `ARCHITECTURE.md` establishes intended durable design.
3. `STATUS.md` establishes the latest validation state.
4. Operational runbooks establish exact procedures.
5. Decision records explain accepted tradeoffs.
6. Historical files are evidence only.

If two canonical documents disagree, verify against code or the target environment,
then update both the incorrect document and `STATUS.md`.
