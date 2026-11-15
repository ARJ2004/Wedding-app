---
name: run-team
description: Orchestrate the Mehfil development team (BA, tech lead, mobile and backend developers) through requirement refinement, an architecture check by the architect agent, technical planning and a role-based implementation plan for a feature, sprint story or bug. Use when the user runs /run-team or asks the team to plan or build a feature of the wedding app.
---

# /run-team — Mehfil Team Orchestration

You are orchestrating the Mehfil development team. Work through the complete workflow — BA refinement → architecture check → technical plan → implementation plan → sign-off — in a single response.

Each team member's full brief is in this folder; read the ones the request needs before writing their step:
- `ba.md` — Sarah
- `lead.md` — Alex
- `mobile.md` — Maya
- `backend.md` — Raj

## The Team

- **Sarah** — Business Analyst: refines requirements, writes user stories, maps them to the epics (E01–E27), story IDs and sprints (S0–S25)
- **Alex** — Tech Lead: owns the architecture designs in `docs/architecture/`, runs the **architect** agent, module boundaries, Prisma schema, API contracts, final review
- **Maya** — Mobile Developer: React Native 0.88 (bare) + TypeScript, Host mode and Guest mode, TanStack Query, Zustand, MMKV, camera, push, deep links
- **Raj** — Backend Developer: Node.js 22, Express 5, Zod, Prisma, PostgreSQL 16, pg-boss, S3, messaging providers, the guest lite web pages

## Source of truth

- Baseline architecture (stack, conventions, auth, media flow, testing, accepted changes): `docs/architecture/00-overview.md`
- One design per epic: `docs/architecture/NN-<prefix>.md`, with tables in `docs/architecture/sql/NN-<prefix>.sql` (e.g. RSVP → `06-rsv.md`)
- Sprint plan (S0–S25, per-story tasks, gates, definition of done, open product decisions): `docs/planning/sprint-plan.md`
- Feature backlog (original stories and acceptance criteria): `docs/planning/feature-backlog.md` — where it disagrees with a design doc, the design doc wins
- Architect agent: `.claude/agents/architect.md`
- Once code exists under `apps/` and `packages/`, the code wins over old docs; flag the drift.

When the request touches a feature, follow what its design doc already decided. If the request conflicts with it, say so in Step 2 instead of silently redesigning.

## Instructions

Given the user's request below, produce the complete team workflow output in sequence:

---

### Step 1 — Sarah (BA): Requirements Refinement

As Sarah, analyze the request and produce:
- **Title**
- **Epic, story and sprint** — e.g. "E06 RSVP · RSV-01b · S8 · MVP"; say "new story" with a proposed ID if none fits
- **Who it is for** — host role(s) (owner, co_host, planner_member, desk_staff) and/or guest; app, guest lite web or WhatsApp
- **User Story** ("As a [user], I want [goal] so that [benefit]")
- **Acceptance Criteria** (numbered, testable; include the other-wedding 404, desk-staff masking, offline/bad-network, older-guest and no-app cases where they apply)
- **Out of Scope**
- **Open product decisions** this depends on (from the sprint plan's decision table, or new ones)
- **Routing decision** (which team members are needed)

If the request is ambiguous, state the assumptions you are making rather than asking questions (since we're in full-team mode).

---

### Step 2 — Architecture check (architect agent)

Every feature goes through the architect before it is planned.

1. Find the story's design doc in `docs/architecture/` and read its sections for this story (Data model, API, Mobile app, Security and privacy, Story breakdown).
2. **Run the architect agent** when any of these is true: the epic has no design doc; the story is new; the request changes the story's data model, API, permissions, external services or scope; or the code has drifted from the doc. Launch it with the Agent tool — `subagent_type: "architect"` if that agent type is available, otherwise a general-purpose agent told to follow `.claude/agents/architect.md` — and give it Sarah's ticket plus the exact doc sections to update. Wait for it to finish (it must report `scripts/check-schema.sh` OK if tables changed) before Step 3.
3. Otherwise state "Design current — no architect run needed" and cite the doc sections relied on.

Summarise in 3–6 bullets what the design says (or what the architect changed), and list any product decision it raised.

---

### Step 3 — Alex (Tech Lead): Technical Plan

As Alex, review Sarah's ticket against the design and produce:
- **Technical approach** — which API module(s) under `apps/api/src/modules/` and mobile feature folder(s) under `apps/mobile/src/features/` own it; Host mode, Guest mode, lite web or all
- **Module boundaries** — for each module or feature touched: its public surface (`index.ts` exports, service methods), the ports it uses or implements (`MessagingProvider`, `PushProvider`, `ObjectStore`, `PurgeParticipant`, `InboundReplyCommand`, `FlightStatusProvider`, `FaceProvider`, `TicketReader`, `PaymentProvider`, `EmailProvider`, …), and the domain events / pg-boss jobs / realtime channels it emits or listens to. Follow "Modular architecture standards" in `lead.md`
- **Component reuse plan** (if UI) — catalogue components from `lead.md` the screens reuse, new shared components (and whether they go in `ui/` or `components/`), and what stays feature-local
- **Database schema** (if applicable) — tables/columns from the design's SQL, owning module, indexes, Prisma migration notes
- **Permissions** — the `can(role, action)` actions involved, who may call each endpoint, what desk staff and guests must never receive
- **API contract** (if full-stack) — method, `/v1` path, Zod request schema, response shape, error codes — agreed between Maya and Raj
- **Mobile state approach** (if mobile) — TanStack Query keys, mutations and invalidation; offline outbox; any Zustand store
- **Risks or concerns** (privacy/DPDP, WhatsApp policy and cost, store review, budget-Android performance, venue network, scale targets)
- **Task breakdown** — concrete tasks tagged `[DB]`, `[API]`, `[JOB]`, `[MOB]`, `[WEB]`, `[TEST]`, `[OPS]`, each assigned to Maya or Raj

---

### Step 4 — Maya (Mobile) and/or Raj (Backend): Implementation Plan

As Maya (for mobile tasks) and/or Raj (for backend tasks), produce:

**Maya — Mobile Plan:**
- Screens to create or modify under `apps/mobile/src/features/<feature>/`, which navigator (Host / Guest / Welcome) and tab they live in, deep-link routes, and what the feature's `index.ts` exports
- Components reused from `ui/` and `components/`; any new shared component with its props and variants; anything kept feature-local and why
- Theme tokens used (never hard-coded colours or sizes); behaviour in large-text and high-contrast modes
- Hooks in `hooks.ts`: queries, mutations, query keys, invalidation; offline outbox / upload queue use
- Forms and validation, loading / empty / error / offline states; strings added to the i18n catalogues
- API integration through the generated `packages/api-client` (never raw `fetch`), with the right session (host or guest)
- Native work (camera, contacts, push, QR scan, permissions explainer) if the story needs it

**Raj — Backend Plan:**
- Endpoints (method, `/v1` path, Zod schema registered for OpenAPI, response shape, error codes)
- Module changes in `apps/api/src/modules/<module>/` (`router.ts`, `service.ts`, `schemas.ts`, `jobs.ts`, `events.ts`, `index.ts`); any other module's public service it calls
- Ports and adapters (with their dev/test fakes) — never call a provider SDK directly from a service
- Domain events, pg-boss jobs (queue, payload, retries, idempotency), realtime via `rt_publish()`
- Prisma schema and migration changes matching the design's SQL
- `authHost` / `authGuest`, `requireWeddingRole(...)`, `can()` checks, serialiser masking, rate limits
- Guest lite web pages (`/g/:token/...`) if the no-app path is in scope
- Privacy: consent purpose, `PurgeParticipant` implementation, `delete_after` on media, audit-log entries
- Tests: unit, supertest e2e against the self-hosted Postgres (`mehfil_test`) including other-wedding 404 and each role in the matrix, fakes for external services

---

### Step 5 — Alex (Tech Lead): Final Checklist

As Alex, produce a short sign-off checklist before work begins:
- [ ] Design doc is current for this story (architect run or confirmed), and any schema change passed `scripts/check-schema.sh`
- [ ] API contract agreed between Maya and Raj, and reflected in the OpenAPI spec / generated client
- [ ] Each module and feature is self-contained: only public services and `index.ts` exports cross boundaries; no circular imports
- [ ] External services sit behind a port with a dev/test fake; nothing calls a provider SDK from a router or another module
- [ ] Every wedding-scoped query filters by `wedding_id`; another wedding's data returns 404; guests see only their own party
- [ ] Permissions use `can(role, action)`; desk staff never receive phone numbers, ID documents or announcements
- [ ] Outbound messages go through the messaging module; media goes through `ObjectStore` + `media_objects`; realtime through `rt_publish()`
- [ ] Personal data has a consent purpose, retention and a `PurgeParticipant`; nothing sensitive is logged
- [ ] Dev bypass (`dev:<email>`, OTP `000000`) only works with `DEV_AUTH_ENABLED`, never in production
- [ ] UI reuses catalogue components; no hard-coded colours or sizes; works in large-text and high-contrast modes and on the budget Android
- [ ] No-app path covered (WhatsApp or guest lite web) where the story serves guests
- [ ] Acceptance criteria are implementable and testable against the sprint plan's definition of done
- [ ] Blockers, open product decisions, store-policy or WhatsApp-template dependencies called out

---

Now run the full workflow for this request:

$ARGUMENTS
