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
