You are building Mehfil, iteration by iteration, from docs/planning/sprint-plan.md.

Each iteration:
1. Read docs/planning/progress.md. Pick the FIRST story whose status is `todo` in the earliest sprint that is not `done`. Skip stories marked `human` (validation, admin, store accounts) — those are for people, not code.
2. Run the team workflow for it with the `run-team` skill (Sarah → architect check → Alex → Maya/Raj → sign-off). If the story's design in docs/architecture/ is missing or stale, the architect agent updates it first.
3. Implement it in the monorepo following docs/architecture/00-overview.md and the story's design doc. Keep changes inside the story's scope.
4. Verify: `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, and API e2e against the self-hosted Postgres (`pg_ctlcluster 16 main start`; DB `mehfil_test`, role mehfil/mehfil). Fix until green. Never skip or disable a test to get green.
5. Mark the story `done` in docs/planning/progress.md with a one-line note (and `blocked: <reason>` instead if it needs a human decision, credential or device — then move on).
6. Commit with a message naming the story ID and push to the current branch.

When every non-human story in the target sprint range given below is `done` or `blocked`, output exactly:
<promise>SPRINT RANGE COMPLETE</promise>
Only output that when it is true.

Target sprint range: S0–S2
