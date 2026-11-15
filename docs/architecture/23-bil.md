# E23 — Billing and plans (BIL)

## 1. Summary

Lets Mehfil charge the PRD prices: **Free** (25 guests, 10 shots per guest), **Essentials ₹6,999**, **Complete ₹14,999** per wedding, and **Planner credit packs** (one credit activates one wedding), plus **add-ons** (message packs, longer photo storage). Delivers:

- one **entitlements service** (`modules/billing` → `entitlements.get / require / checkLimit`) that every other module calls instead of reading `weddings.plan`;
- **Razorpay** orders, checkout signature verification, signed and idempotent webhooks, nightly reconciliation;
- **GST invoices** and credit notes with gapless numbering, 18% GST split CGST+SGST (intra-state) or IGST (inter-state);
- **credit lots + ledger** for planner packs (and "activate later" passes for families);
- a **server-rendered web checkout** at `/account/*`, served by the API. The app itself sells nothing (see §2 and §8).

| Stories | Phase / sprint |
| --- | --- |
| BIL-01, BIL-02 (split into 02a/02b), BIL-03, BIL-04; new BIL-05 (web account + checkout pages), BIL-06 (store-compliant plan UI + out-of-app upgrade nudges) | Season readiness. Backlog: all in S16. Recommended: BIL-01 in S15, the rest S16–S17 (§12). |

**Reinterpreted for the current stack:** the backlog assumed a web console where checkout simply lives. In the new baseline the host client is a React Native app distributed through the App Store and Play Store, so *where checkout happens* is a store-policy question. Checkout moves to API-served web pages (same no-framework approach as the guest lite web); Razorpay's React Native SDK is **not** used. Jobs run on pg-boss, not Celery; invoices go to S3 via the existing `ObjectStore`.

## 2. Key decisions

| Decision | Chosen | Rejected alternative | Why |
| --- | --- | --- | --- |
| **Where checkout happens** | **Web checkout served by the API** (`/account/checkout`, Razorpay Standard Checkout JS). The RN app shows plan, usage, credits and invoices but has **no buy button, price or link to buy** on either platform. Upgrade prompts go out-of-app (email to the owner). | (a) Razorpay RN SDK in the app; (b) Apple/Google IAP | (a) Plans unlock in-app digital features (guest limits, messages, face search, quiz). Apple 3.1.1 / Google Play Payments policy treat that as digital content; the "physical goods/services consumed outside the app" exemption (Apple 3.1.3(e)) is unlikely to be accepted because what we sell is software capability, not the event itself. Rejection risk **high on iOS, medium-high on Play**, and it would land on the S18 store submission — the critical path to Aug sales. (b) IAP costs 15–30%, makes Apple/Google the seller of record so planners get no GST invoice with their GSTIN (no input tax credit), and doesn't fit credit packs. The web route relies on Apple 3.1.3(f) ("free stand-alone companion to a paid web-based tool… no purchasing inside the app, or calls to action for purchase outside of the app") and the equivalent Play allowance for apps that don't sell in-app. Conversion cost accepted; legal review before S18 (§13). `billing_orders.provider` leaves room for IAP if ever forced. |
| One service for limits | `wedding_entitlements` row per wedding (plan + add-ons + overrides) recomputed **in the same transaction** as any billing change; read by PK | Each module reads `weddings.plan` and has its own limit table; or an in-memory cache | One place to change limits; PK read is ~0.1 ms so the 300 uploads/min camera path needs no cache; no cache invalidation across API and worker processes. Missing row = Free defaults (lazy), so wedding creation doesn't depend on BIL. |
| Catalogue | `billing_products` table, immutable SKUs (`plan_complete_v1`), seeded by migration; entitlement keys typed in `packages/domain/src/entitlements.ts` | Hard-coded in code; or prices in Razorpay | Orders and invoices reference a stable SKU; price change = new SKU, history intact; marketing site and app read `/v1/billing/catalog` so prices never drift. |
| Families buying before the wedding exists | Sell a **pass** (a 1-credit `credit_pack` for Essentials/Complete) that the wizard or plan screen activates | Require a wedding id at checkout | Families arrive from the marketing site before installing the app (§GTM). Planner packs and family passes then share one credit model. |
| Upgrade pricing | Pay the list-price difference (Essentials→Complete = ₹8,000) | Pro-rata by days | Weddings are one-off events, not subscriptions; simple to explain and to invoice. |
| Payments are one-off | Razorpay **Orders** + auto-capture | Razorpay Subscriptions | No recurring plan exists; planners buy packs. |
| Fulfilment trigger | Whichever arrives first: client `verify` call (HMAC of `order_id|payment_id`) or `payment.captured`/`order.paid` webhook; both call one idempotent `fulfil(orderId)` that locks the order row and exits if `fulfilled_at` is set | Webhook only | Webhook-only leaves the buyer staring at a spinner when the webhook is slow; client-only loses payments if the tab closes. Nightly reconciliation catches both missing. |
| Webhook handling | Verify signature on the raw body, insert into `payment_webhook_events` (unique `(provider, event_id)`), 200 immediately, process in pg-boss job | Process inline | Razorpay retries on slow responses and delivers duplicates/out of order; the unique row is the dedupe point. |
| Invoice numbers | Counter row per (series, FY) locked and incremented in the fulfilment transaction → gapless, ≤ 16 chars (`MF/2728/000123`) | Postgres `SEQUENCE` | Sequences leave gaps on rollback; CGST Rule 46 expects consecutive serials per FY. Throughput is tiny, so a row lock is fine. |
| Invoice PDF | `pdfkit` in the `default` worker, private S3 billing prefix, 8-year lifecycle | Headless Chrome; Razorpay Invoices | Chrome is heavy for a 2 GB worker; Razorpay invoices don't support our credit-note and B2B/B2C rules cleanly. |
| Credits | `credit_lots` (per purchase, `credits_remaining`, `expires_at`) + append-only `credit_ledger`; consume from the lot expiring first, `FOR UPDATE` | Single balance column | Packs can expire and be refunded per purchase; the ledger is the statement the planner sees (PLN-03). Unique partial index = one consume per wedding. |
| Email | New `EmailProvider` interface, Amazon SES (ap-south-1) adapter, `LogSinkEmailProvider` for dev | WhatsApp for invoices/nudges | Invoices need an attachment and a durable channel; billing nudges would be marketing-category WhatsApp templates. **Deviation** (new external service). |
| Web auth for `/account` | Google Identity Services button → `POST /account/session` verifies the ID token with the same Web client ID → opaque cookie session (`web_sessions`, 12 h) | Reuse JWT in localStorage; magic link | HttpOnly cookie keeps tokens out of JS on a page that loads third-party checkout JS. Dev bypass: `dev:<email>` form when `DEV_AUTH_ENABLED=true`. **Deviation** (host web surface). |
| Money | `bigint` paise everywhere, GST in basis points, integer rounding rules in one pure function in `packages/domain/src/gst.ts` | `numeric` rupees | Baseline rule; avoids float drift; same function used by API, PDF and tests. |

## 3. Data model

DDL: [`sql/23-bil.sql`](./sql/23-bil.sql). References `000-core.sql` (and reuses `platform_staff` from `14-prv.sql` in code; no FK). **Schema check passed**: `scripts/check-schema.sh arch_bil 000-core.sql 14-prv.sql 18-pln.sql 23-bil.sql 24-gtm.sql` → `OK: 51 tables`; the full chain (000 → 27) → `OK: 136 tables`. EXPLAIN on 300 orgs × 5 lots: "pick lot to consume" uses `credit_lots_available_idx` (0.05 ms).

| Table | Purpose | Notes |
| --- | --- | --- |
| `billing_products` | Catalogue: `plan`, `credit_pack`, `addon`; price (paise), `tax_inclusive`, `gst_rate_bp`, `sac_code`, `credits`, `credit_valid_days`, `entitlements` jsonb | Immutable SKUs; one active SKU per plan code. Seed values are **placeholders** (§13). |
| `billing_profiles` | Per org: legal name, optional GSTIN (regex + state prefix check), GST state code, address, invoice email | Required before the first order; snapshotted into the order. |
| `billing_orders` | One checkout: org, optional wedding, status, provider + `provider_order_id`, subtotal/tax/total, `supply_type` intra/inter, billing snapshot, `(created_by, idempotency_key)` unique, `expires_at` 30 min | `wedding_id ON DELETE SET NULL` — money records outlive weddings. |
| `billing_order_items` | SKU, kind (`plan`/`upgrade`/`credit_pack`/`addon`), `from_plan_code` for upgrades, unit price, taxable, tax, line total | Totals checked by constraints. |
| `payments` | Provider payment id (unique), status, method, amount, refunded amount | Multiple attempts per order possible. |
| `payment_webhook_events` | Raw webhook, unique `(provider, event_id)`, processed flag, attempts | Payload purged after 180 days. |
| `invoice_counters` | `(series INV/CRN, fiscal_year '2728') → next_number` | Locked in the fulfilment transaction. |
| `invoices`, `invoice_lines` | Tax invoices and credit notes: supplier/recipient GSTIN, place of supply, taxable, CGST/SGST/IGST, PDF key | Checks: total = taxable + taxes; IGST xor CGST/SGST; one invoice per order. Kept 8 years. |
| `credit_lots` | One per pack purchase / comp grant: plan code, total, remaining, expiry | `credits_remaining BETWEEN 0 AND credits_total`. |
| `credit_ledger` | Append-only: purchase, comp, consume, release, expire, refund; wedding id + title snapshot | Sign checked per reason; one consume and one release per wedding. |
| `wedding_plans` | Current plan of a wedding: code, SKU, source (`free`/`order`/`credit`/`comp`), order or lot | Billing is the **only writer** of core `weddings.plan`, updated alongside. |
| `wedding_addons` | Purchased add-ons per wedding | Stackable. |
| `wedding_entitlements` | Materialised effective `limits` jsonb + `features[]` + admin `overrides` + `version` | The single row other modules read. |
| `organization_entitlements` | Org limits (team `seats_max`) and features (`planner_branding`, `templates`) | Derived from the org's live planner lots or overrides. |
| `web_sessions` | Cookie sessions for `/account` pages; hashed token, CSRF secret, 12 h | Purged nightly. |

**Entitlement keys** (`packages/domain/src/entitlements.ts`, Zod): limits `guests_max`, `camera_shots_per_guest`, `messages_included`, `photo_retention_months`, `co_hosts_max`, `desk_staff_max`; features `sms_fallback`, `travel`, `arrivals`, `gallery_download`, `pickups`, `rooms`, `id_vault`, `face_search`, `quiz`, `feed`, `languages`, `planner_branding`. Add-ons carry `limits_add` deltas.

**Who enforces what** (callers of `entitlements`):

| Module | Check | Where |
| --- | --- | --- |
| GST | `guests_max` | create guest, import commit (count + new rows, with the entitlements row locked `FOR UPDATE` in the import transaction). **Alternative pending PO** (24-gtm.md §13 #1): allow import, enforce at invite send (MSG) instead. |
| CAM | `camera_shots_per_guest` | presign upload |
| MSG | `messages_included` | BIL calls `messaging.setQuotaLimit(weddingId, units)` on every recompute; MSG keeps metering in its own `message_quotas` |
| PRV | `photo_retention_months` | retention job computes `delete_after` |
| PCK, ROM, IDV, FACE, QZ, FEED, L10N | `require(feature)` | router middleware `requireFeature('face_search')` |
| ROL / PLN | `co_hosts_max`, `desk_staff_max`, org `seats_max`, `planner_branding` | invite create, branding PUT |

Limits never delete data: lowering a limit (e.g. refund) blocks *new* additions only.

## 4. API

Host endpoints use the host JWT; `/account/*` pages use the cookie session; webhooks are public with signatures.

| Method | Path | Caller | Purpose | Notable errors |
| --- | --- | --- | --- | --- |
| GET | `/v1/billing/catalog` | public (cached 5 min) | Active SKUs with prices incl./excl. GST, entitlements | — |
| GET | `/v1/weddings/:wid/entitlements` | any wedding member (desk staff: features only) | Plan, limits, usage (from GST/CAM/MSG), features, version | 404 |
| POST | `/v1/weddings/:wid/plan/activate` | owner; org_owner/org_admin of the wedding's org | Consume a credit/pass for `planCode` | `BIL_NO_CREDITS`, `BIL_ALREADY_ON_PLAN`, `BIL_DOWNGRADE_NOT_ALLOWED` |
| GET | `/v1/orgs/:oid/billing/credits` | org_owner, org_admin (org_member read-only) | Balance per plan, lots, expiring in 30 days | 404 |
| GET | `/v1/orgs/:oid/billing/credits/ledger?cursor=` | same | Statement (consumption per wedding) | — |
| GET / PUT | `/v1/orgs/:oid/billing/profile` | org_owner, org_admin | Billing details (GSTIN validated + checksum) | `BIL_GSTIN_INVALID` |
| GET | `/v1/orgs/:oid/billing/invoices?cursor=` | org_owner, org_admin; wedding owner for their wedding | Invoices and credit notes | — |
| GET | `/v1/billing/invoices/:id/pdf` | same | 302 to 5-min presigned S3 GET | `BIL_INVOICE_NOT_RENDERED` (retry) |
| POST | `/v1/billing/orders` (`Idempotency-Key` required) | signed-in host (called by `/account` pages; not exposed in app UI) | Create order + Razorpay order | `BIL_SKU_INACTIVE`, `BIL_UPGRADE_INVALID`, `BIL_PROFILE_REQUIRED`, `BIL_WEDDING_NOT_OWNED` |
| POST | `/v1/billing/orders/:id/verify` | order creator | Verify checkout signature, fulfil | `BIL_SIGNATURE_INVALID`, `BIL_PAYMENT_NOT_CAPTURED` |
| GET | `/v1/billing/orders/:id` | order creator, org admins | Status polling | — |
| POST | `/v1/billing/webhooks/razorpay` | Razorpay | Raw-body HMAC verify → store → enqueue | 400 on bad signature (logged, alerted on spikes) |
| POST | `/v1/admin/billing/comp` | platform staff (`admin`) | Comp a plan to a wedding or credits to an org (pilots) | — |
| PUT | `/v1/admin/weddings/:wid/entitlement-overrides` | platform staff (`admin`) | Override limits (audited) | — |
| POST | `/v1/admin/billing/orders/:id/refund` | platform staff (`admin`) | Razorpay refund + credit note + optional entitlement/credit reversal | `BIL_CREDIT_ALREADY_USED` |

**Server-rendered pages** (`/account`, HTML, CSP-locked): `GET /account` (sign in with Google) · `POST /account/session` · `POST /account/logout` · `GET /account/checkout?sku=&wedding=` (choose wedding or "activate later", billing details) · `POST /account/checkout` (creates order via the same service, renders Razorpay Checkout) · `POST /account/checkout/:orderId/complete` (verify) · `GET /account/orders/:id` (receipt + invoice link) · `GET /account/billing` (credits, invoices). Pages are English-only in v1, large-text friendly, < 30 KB HTML+CSS, no SPA.

### Examples

`POST /v1/billing/orders` · `Idempotency-Key: 7c1e…`

```json
{ "organizationId": "0b5…", "weddingId": "a71…",
  "items": [{ "sku": "plan_complete_v1", "quantity": 1 }] }
```
→ `201`
```json
{ "orderId": "e42…", "status": "created", "provider": "razorpay",
  "providerOrderId": "order_PZx…", "keyId": "rzp_live_…",
  "lines": [{ "sku": "plan_complete_v1", "kind": "upgrade", "fromPlan": "essentials",
              "taxablePaise": 677966, "taxPaise": 122034, "totalPaise": 800000 }],
  "subtotalPaise": 677966, "taxPaise": 122034, "totalPaise": 800000,
  "supplyType": "intra", "expiresAt": "2027-08-12T10:40:00Z" }
```

`POST /v1/billing/orders/e42…/verify`
```json
{ "razorpayPaymentId": "pay_Q1…", "razorpaySignature": "9f2c…" }
```
→ `200 { "status": "fulfilled", "invoiceNumber": "MF/2728/000123", "wedding": { "plan": "complete", "entitlementsVersion": 4 } }`

`GET /v1/weddings/:wid/entitlements` → `200`
```json
{ "plan": "free", "source": "free", "version": 1,
  "limits": { "guests_max": 25, "camera_shots_per_guest": 10, "messages_included": 75 },
  "usage": { "guests": 25, "messages": 12 },
  "features": [], "atLimit": ["guests_max"] }
```
Limit errors from other modules: `402 { "error": { "code": "BIL_LIMIT_REACHED", "message": "...", "details": { "key": "guests_max", "limit": 25, "current": 25 } } }`; feature gates: `402 BIL_FEATURE_NOT_IN_PLAN`.

### Fulfilment and GST rules

`fulfil(orderId)` in one transaction: lock order → exit if fulfilled → mark paid/fulfilled → per item: `plan`/`upgrade` → upsert `wedding_plans` + `weddings.plan`; `credit_pack` → insert `credit_lots` + ledger `purchase`; `addon` → insert `wedding_addons` → recompute `wedding_entitlements` (version+1) → allocate invoice number → insert `invoices` + lines → `audit_log` (`billing.order.fulfilled`, organization_id set) → `rt_publish` `plan.changed` → enqueue `bil.invoice.render`. A payment captured on an **expired** order is still fulfilled (money was taken) and alerts.

GST (pure function, `packages/domain/src/gst.ts`):
- Supplier GSTIN/state from config (Karnataka `29` assumed). Place of supply = recipient GSTIN state if present, else billing-profile state. Same state → CGST 9% + SGST 9%; different → IGST 18%.
- Tax-inclusive line: `taxable = round_half_up(total × 10000 / (10000 + rate_bp))`, `tax = total − taxable`; intra: `cgst = floor(tax/2)`, `sgst = tax − cgst`. Tax-exclusive line: `tax = round_half_up(taxable × rate_bp / 10000)`.
- Example: Essentials ₹6,999 incl. → taxable 593136, tax 106764 → CGST 53382 + SGST 53382 paise.
- Number `MF/<FY>/<6-digit serial>`, FY by IST date (Apr–Mar). Credit notes `MC/<FY>/…` reference the original invoice. E-invoicing (IRN) not required below ₹5 Cr turnover — monitor.

## 5. Jobs, events and realtime

| Queue / job | Trigger | Idempotency / retries |
| --- | --- | --- |
| `default` · `bil.webhook.process` `{webhookEventId}` | webhook insert | `fulfil` is idempotent; 5 retries, exp. backoff; dead-letter alert |
| `default` · `bil.invoice.render` `{invoiceId}` | after fulfil | skips if `pdf_s3_key` set; then `bil.invoice.email` |
| `default` · `bil.invoice.email` `{invoiceId}` | after render | skips if `emailed_at` set |
| cron `bil.reconcile` 02:40 IST | orders `created` in last 72 h | fetch Razorpay order payments; fulfil captured ones; expire stale |
| cron `bil.credits.expire` 03:10 IST | lots past `expires_at` with remaining > 0 | ledger `expire`; 30-day warning email to org admins |
| cron `bil.purge` 03:30 IST | webhook payloads > 180 d, expired `web_sessions` | — |
| cron `bil.limit-nudge` hourly | weddings that hit a limit in the last hour (from `BIL_LIMIT_REACHED` counters) | one email per wedding per limit per 7 days to the owner, with a link to `/account/checkout` |

Domain events: `billing.entitlements.changed {weddingId, version}` → MSG `setQuotaLimit`, PRV recompute `delete_after`, PLN snapshot recompute; `billing.credit.consumed {orgId, weddingId}` → PLN. SSE: `rt_publish(wedding, 'host', 'plan.changed', {version})` so open host apps refetch entitlements.

## 6. Mobile app

Host mode only; guests never see billing.

| Screen | Content | Store rule |
| --- | --- | --- |
| Wedding → Settings → **Plan & usage** | Plan badge, usage bars (guests, messages, shots), included features, add-ons, "Activate with a credit/pass" when the org has credits | No prices, no buy/upgrade buttons, no URLs to buy, on both platforms. Neutral copy: "Plan changes are made from your Mehfil account." |
| Org → **Credits** (PLN-03) | Balance per plan, expiring lots, ledger | same |
| Org/Wedding → **Invoices** | List + open PDF (presigned URL in the system viewer) | Receipts for purchases made elsewhere are allowed |
| Limit banners (guest list, camera host view, composer) | "Guest limit reached (25 of 25 on Free)" with icon + label | neutral; the email nudge carries the link |
| Activate sheet | Choose plan from available credits; confirm | consuming a credit bought on the web is allowed (multiplatform access) |

Query keys: `['wedding', wid, 'entitlements']` (staleTime 60 s; invalidated by SSE `plan.changed` and on app focus), `['org', oid, 'credits']`, `['org', oid, 'invoices']`. Offline: last entitlements persisted in MMKV so limit banners render offline; the **server** is the only enforcer. A lint rule bans `Linking.openURL` to `/account` paths in `apps/mobile`; an RNTL test asserts the plan screen renders no purchase CTA.

## 7. Guest lite web

Not applicable for guests (they never pay). The new **host-facing** `/account/*` pages reuse the lite-web rendering stack (server templates + `packages/design-tokens` CSS variables). See Deviations.

## 8. Security and privacy

| Area | Measure |
| --- | --- |
| Secrets | `RAZORPAY_KEY_ID/KEY_SECRET/WEBHOOK_SECRET`, SES creds in `.env` (chmod 600); config refuses `PAYMENT_PROVIDER=fake` in production |
| Webhooks | HMAC-SHA256 over the **raw** body (`express.raw` mounted on that route before the JSON parser), `crypto.timingSafeEqual`; dedupe on `x-razorpay-event-id`; amounts and order ids re-checked against our order, never trusted from the payload alone |
| Checkout verify | HMAC of `order_id|payment_id` with key secret, then fetch payment from Razorpay to confirm `captured` and amount |
| PCI | Card data only in Razorpay Checkout (SAQ-A scope); we store payment id, method and status only |
| `/account` pages | `__Host-` cookie, HttpOnly, Secure, SameSite=Lax; CSRF token per form (HMAC with `csrf_secret`); CSP allowing only `checkout.razorpay.com`, `api.razorpay.com`, `accounts.google.com/gsi`; `frame-ancestors 'none'` |
| Permissions | Org billing: org_owner/org_admin; wedding upgrade: wedding owner or org admins; co-hosts/desk staff/planner members can view plan but never invoices or billing profile; 404 for other orgs/weddings |
| Rate limits | `/account/session` 10/min/IP; orders 20/h/user; webhook endpoint unlimited but signature-gated |
| Audit | `billing.order.fulfilled`, `billing.credit.consume/release/expire`, `billing.comp.grant`, `billing.override.set`, `billing.refund` in `audit_log` with `organization_id` |
| DPDP | Data: billing name, GSTIN, state, address, email — needed for the contract and GST law. Retention: invoices, orders, payments 8 years (CGST s.36); billing profile deleted with the org unless needed for an open dispute (invoices keep snapshots); webhook payloads 180 days; web sessions purged after expiry. Wedding deletion (PRV-02) keeps billing rows with `wedding_id = NULL` and title snapshot only. |
| Logs | Never log signatures, key secret, full webhook payloads, GSTIN or email at info level |
| Store compliance | §2 decision; release checklist item "no purchase CTA in app" for every build |

## 9. Scale and performance

Billing volume is tiny (hundreds of orders per month in season). The stressed path is **entitlement reads** on hot endpoints (camera presign at 300/min, guest import, message send): one PK lookup per request, no joins. Guest import takes `FOR UPDATE` on the wedding's entitlements row only for the commit transaction (seconds), serialising concurrent imports of the same wedding — acceptable. Invoice numbering serialises fulfilments per FY — fine at < 1/s. Sales-launch spike (S19 marketing) is static-site traffic; `/v1/billing/catalog` is cached 5 min in-process and by Nginx.

## 10. Testing plan

| Level | Cases |
| --- | --- |
| Unit (`packages/domain`) | GST split property tests (taxable + taxes = total for 1..10⁷ paise, inclusive/exclusive, intra/inter); GSTIN regex + checksum; FY derivation at 31 Mar 23:59 IST; entitlements merge (plan + stacked add-ons + overrides) |
| API e2e (supertest, local Postgres, `FakePaymentProvider`) | order → verify → fulfilled, invoice numbered; webhook-first then verify (one fulfilment); duplicate webhook; bad signature 400; expired order paid late; 20 parallel fulfilments → gapless serials; upgrade price; credit consume twice → one ledger row; consume with no credits; comp grant; limit enforcement in GST/CAM/MSG returns 402; tenant isolation (other org → 404); desk staff can't see invoices |
| Webhook fixtures | Razorpay sample payloads with known signatures from test-mode keys |
| `/account` pages | supertest HTML: CSRF required, cookie flags, CSP header, dev sign-in form only with `DEV_AUTH_ENABLED` |
| Mobile | RNTL: plan screen has no purchase CTA on `ios`/`android`; limit banners; activate sheet |
| Staging | Razorpay **test mode** end to end incl. webhooks via Nginx; then one real ₹1 product in production before Gate 4 ("billing tested with real payments"), refunded with a credit note |

## 11. Story breakdown

| Story | Tasks | Backlog → revised | Why |
| --- | --- | --- | --- |
| **BIL-01** Plans and entitlements | [DB] catalogue, wedding_plans, addons, entitlements tables + seed · [API] `entitlements` service (`get/require/checkLimit/forOrg`), lazy Free default, `requireFeature` middleware, GET entitlements · [API] wire GST/CAM checks, MSG `setQuotaLimit`, PRV retention hook, feature gates on PCK/ROM/IDV/FACE/QZ/FEED/L10N · [API] admin overrides + comp · [MOB] Plan & usage screen, limit banners · [TEST] per-limit e2e | 5 → **8** | Enforcement wiring touches ~10 modules; admin comp needed for pilots moving onto real plans. |
| **BIL-02a** Checkout + webhooks (split) | [DB] orders, items, payments, webhook events · [API] `PaymentProvider` (Razorpay + fake), create order, verify, webhook route (raw body), fulfil, upgrade pricing · [JOB] webhook process, reconcile · [TEST] idempotency/race suite · [OPS] Razorpay dashboard webhook + auto-capture, secrets | 5 → **5** | — |
| **BIL-02b** GST invoices (split) | [DB] counters, invoices, lines · [API] gst.ts, numbering, credit notes, invoice list/PDF · [JOB] render (pdfkit) + email · [OPS] SES domain verification (DKIM/SPF), billing S3 prefix + 8-year lifecycle · [TEST] tax math + gapless numbering | (in BIL-02) → **5** | GST compliance is its own piece of work; CA review of the template. |
| **BIL-05** Web account + checkout pages (new) | [WEB] `/account` sign-in (GIS + dev form), session cookies, CSRF, checkout, receipt, billing pages · [DB] web_sessions · [TEST] HTML e2e · [OPS] CSP, Nginx routes | new → **3** | Needed because the app can't sell (store rules). |
| **BIL-03** Planner credit packs | [DB] lots + ledger · [API] consume/release/activate, credits endpoints, pass SKUs for families · [JOB] expiry + warning · [MOB] activate sheet · [TEST] concurrency (two activations, one credit) | 3 → **5** | Adds expiry, releases and the family "activate later" pass that GTM depends on. |
| **BIL-04** Add-ons | [API] add-on SKUs in checkout, stacking in recompute · [WEB] add-on choice on checkout page · [TEST] | 2 → **2** | unchanged |
| **BIL-06** Store-compliant plan UI + upgrade nudges (new) | [MOB] neutral copy, lint rule, RNTL test · [JOB] limit-nudge emails · [OPS] legal review of Apple 3.1.3(f) / Play payments policy, App Review notes explaining the model | new → **2** | Makes the store decision real and testable. |
| **Total** | | **15 → 30** | |

## 12. Dependencies and sequencing

- **Before:** FND (auth, idempotency_keys, ObjectStore, pg-boss), MSG-09 (`message_quotas` + a `setQuotaLimit` export), ROL-04 (org model, `audit_log.organization_id`), VAL-11 Razorpay KYC (live keys), **GST registration + CA sign-off on SAC code and invoice template** (new admin item, start by S12), SES domain verification.
- **After / consumers:** PLN-03 (credits, read-only via `billing` index exports), PLN-04 (`planner_branding` feature), GTM-01 (pass activation in wizard), GTM-02 (catalog endpoint, links to `/account/checkout`), PRV-03 (retention months).
- **Recommended sprinting** (backlog puts 15 pts + PLN-03 + GTM-02 in S16; revised BIL is 30):
  - **S15:** BIL-01 (8) — pilots need comp plans and MSG/CAM limits before season anyway.
  - **S16:** BIL-02a (5), BIL-05 (3), BIL-03 (5), PLN-03 (2), BIL-06 (2) = 17 + pilot backlog.
  - **S17:** BIL-02b (5), BIL-04 (2) alongside GTM-01 and APP-01 (move OPS-05/06 to S18).
  - Must be live before **S19 sales start**; Gate 4 real-payment test in S21.

## 13. Risks and open questions

| # | Item | Owner |
| --- | --- | --- |
| 1 | **Store policy.** Web-only checkout with no in-app CTA is the lowest-risk reading of Apple 3.1.3(f) and Play's policy, but not risk-free (Apple may still ask for IAP if reviewers see "upgrade" language). Get a legal/App-Review opinion before APP-03 (S18). Fallback: Essentials/Complete as non-renewing IAP on iOS only, priced higher. | PO + counsel |
| 2 | **Conversion cost**: families hitting the 25-guest Free limit inside the app get no in-app path to pay. Mitigation: marketing site sells passes first; limit emails. Measure with GTM funnel. | PO |
| 3 | **Plan matrix**: seed limits (guests 25/400/2,000; messages 75/2,000/8,000; shots 10/25/50; retention 3/12/12 months; feature lists) and pack sizes/prices (5 = ₹49,999, 10 = ₹89,999 excl. GST, 365-day validity) are placeholders. | PO (VAL-03/04 data) |
| 4 | Prices GST-**inclusive** for families (₹6,999 total) and **exclusive** for planner packs — confirm. | PO + CA |
| 5 | SAC code (998439 placeholder), supplier state/GSTIN, NRI buyers paying from abroad (export of services / place of supply) — v1 requires an Indian billing state. | CA |
| 6 | Refund policy (window, whether consumed credits/limits are reversed). | PO |
| 7 | Credit release rule (wedding deleted before first invite within 7 days returns the credit?). | PO |
| 8 | Razorpay webhook delivery delays during sales spikes → reconciliation covers; alert if `created` orders > 1 h with captured payments. | Eng |

## 14. Deviations from the baseline

1. **Host-facing server-rendered web pages** at `/account/*` (billing, checkout) with **Google Identity Services** sign-in and **cookie sessions** (`web_sessions`). Baseline only has the guest lite web at `/g/:token` and JWTs. Needed because checkout cannot live in the app.
2. **New external service: transactional email** (Amazon SES ap-south-1) behind `EmailProvider`, with a log-sink fake. Used for invoices, credit-expiry warnings, upgrade nudges, lead notifications (GTM).
3. **`weddings.plan` is written only by the billing module**; everyone else reads `entitlements`.
4. Staff operations (comp, overrides, refunds) reuse **`platform_staff`** from PRV (`14-prv.sql`, `staff_role = 'admin'`); no billing-specific staff table.
5. Baseline API conventions don't name a status for plan limits: this design uses **402** with `BIL_LIMIT_REACHED` / `BIL_FEATURE_NOT_IN_PLAN`.
6. Overview "Decisions that change the PRD" should record: *no in-app purchases; checkout on the web*.
