# Documentation index

| Document | Purpose | Volatility |
|---|---|---|
| `../ARCHITECTURE.md` | Durable design and invariants | Low |
| `STATUS.md` | Latest verified state, blockers and next gates | High |
| `TESTING.md` | Safe and destructive test procedures | Medium |

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
