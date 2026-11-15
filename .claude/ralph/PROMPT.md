You are building Mehfil, iteration by iteration, from docs/planning/sprint-plan.md.

Each iteration:
1. Read docs/planning/progress.md. Pick the FIRST story whose status is `todo` in the earliest sprint that is not `done`. Skip stories marked `human`.
2. Run the team workflow for it with the `run-team` skill (Sarah → architect check → Alex → Maya/Raj → sign-off). Keep that output compact. If the story's design in docs/architecture/ is missing or stale, the architect agent updates it first.
3. Implement it in the monorepo following docs/architecture/00-overview.md and the story's design doc.
   - Anything that needs the product owner's accounts or credentials (Google OAuth clients, AWS/S3, Meta WhatsApp, DLT SMS, Razorpay, FCM, store accounts) is NEVER a blocker: build the real adapter behind its port, use the dev/test fake (dev bypass `dev:<email>`, OTP 000000, FakeObjectStore/MinIO, LogSinkProvider, fake push) in development, note "needs credentials: <what>" in the progress note, and move on.
   - The app's look comes only from packages/design-tokens (palettes.ts + theme.config.ts). Never hard-code colours or sizes in screens.
4. Verify: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:e2e` against the self-hosted Postgres (`scripts/dev-db.sh`; DB `mehfil_test`). Fix until green. Never skip or disable a test to get green.
5. For stories with screens: run the app preview (`pnpm --filter @mehfil/mobile preview:shots`) against the local API with seed data, and save phone-size screenshots in docs/screenshots/ (light and dark). Send the new screenshots to the user with SendUserFile and a one-line caption.
6. Mark the story `done` in docs/planning/progress.md with a one-line note (`blocked: <reason>` only when it truly cannot proceed even with fakes — then move on).
7. Commit with a message naming the story ID and push to the current branch. Send the user a short progress update every few stories.

When every non-human story in the target sprint range below is `done` or `blocked`, output exactly:
<promise>SPRINT RANGE COMPLETE</promise>
Only output that when it is true.

Target sprint range: S2–S9
