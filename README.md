# Mehfil (working name)

One private space per Indian wedding: guest logistics for hosts and planners, and the schedule, updates, photos and games for guests with no app install.

## Planning

- [Feature backlog](docs/planning/feature-backlog.md): every epic and story with ID, priority, estimate, acceptance criteria and dependencies.
- [Sprint plan](docs/planning/sprint-plan.md): 2-week sprints from validation (Nov 2026) to launch for the Nov 2027 season, with per-story tasks, phase gates and open product decisions.

## Architecture

- [Baseline](docs/architecture/00-overview.md): Express 5 + Prisma + PostgreSQL 16 + pg-boss + S3, React Native app (host + guest modes), Google SSO for hosts with a dev bypass.
- One design per epic in `docs/architecture/NN-<prefix>.md`, with tables in `docs/architecture/sql/`.
- Check every design's schema on a local Postgres: `scripts/check-schema.sh`.
- New features go through the `architect` agent (`.claude/agents/architect.md`) before they enter a sprint.

## Local development

Requires Node 22 and pnpm 10.

```bash
pnpm install
scripts/dev-db.sh                      # self-hosted Postgres 16: mehfil_dev + mehfil_test (or: docker compose -f infra/docker-compose.dev.yml up -d)
cp apps/api/.env.example apps/api/.env # dev bypass on: sign in with "dev:<email>", guest OTP 000000
pnpm dev                               # API on http://localhost:4000 — Swagger UI at /v1/docs
pnpm test && pnpm test:e2e             # unit tests, then API e2e against mehfil_test
pnpm api-client:generate               # after changing any route; CI fails if the client is stale
```

The API refuses to start with `NODE_ENV=production` if any dev shortcut is on (`DEV_AUTH_ENABLED`, `OBJECT_STORE=fake`, `MESSAGING_PROVIDER=log`, `OPENAPI_DOCS`) or a production secret is missing.

## Building with the Ralph loop

The sprint plan is built story by story by the Ralph loop (`ralph-loop@claude-plugins-official`, enabled in `.claude/settings.json`). Progress lives in `docs/planning/progress.md`; the loop prompt is `.claude/ralph/PROMPT.md` and each story goes through the `/run-team` skill. Start it in Claude Code with:

```
/ralph-loop:ralph-loop "$(cat .claude/ralph/PROMPT.md)" --completion-promise "SPRINT RANGE COMPLETE" --max-iterations 30
```
