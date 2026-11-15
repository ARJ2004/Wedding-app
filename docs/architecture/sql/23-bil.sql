-- E23 Billing and plans (BIL). Design: docs/architecture/23-bil.md
-- References 000-core.sql and 14-prv.sql (platform_staff, read only in services). Owning module: apps/api/src/modules/billing.
-- Money is integer paise (bigint). GST rates are basis points (1800 = 18%).
-- Billing records outlive weddings (GST: keep 8 years), so FKs to weddings on money tables are
-- ON DELETE SET NULL; per-wedding state tables cascade.

-- Platform staff: reuses platform_staff from 14-prv.sql (staff_role = 'admin' may comp plans/credits,
-- override limits and refund). No billing-specific staff table.

-- ── Catalogue ─────────────────────────────────────────────────────────────────
-- Immutable once sold: a price or entitlement change is a new sku (…_v2) and the old one is
-- deactivated. Seeded by migration; entitlement keys are validated by Zod in packages/domain.
CREATE TABLE billing_products (
  sku               text PRIMARY KEY CHECK (sku ~ '^[a-z0-9_]+$'),   -- 'plan_essentials_v1'
  kind              text NOT NULL CHECK (kind IN ('plan','credit_pack','addon')),
  plan_code         text CHECK (plan_code IN ('free','essentials','complete','planner')),
  name              text NOT NULL,
  price_paise       bigint NOT NULL CHECK (price_paise >= 0),
  tax_inclusive     boolean NOT NULL DEFAULT true,  -- B2C list prices include GST
  gst_rate_bp       int NOT NULL DEFAULT 1800 CHECK (gst_rate_bp BETWEEN 0 AND 2800),
  sac_code          text NOT NULL DEFAULT '998439',  -- confirm with CA (open question)
  credits           int CHECK (credits > 0),          -- credit_pack: weddings in the pack
  credit_valid_days int CHECK (credit_valid_days > 0),-- credit_pack: null = never expires
  entitlements      jsonb NOT NULL DEFAULT '{}'::jsonb, -- plan: full set; addon: deltas
  addon_stackable   boolean NOT NULL DEFAULT true,
  active            boolean NOT NULL DEFAULT true,
  sort_order        int NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'addon') = (plan_code IS NULL)),          -- credit_pack: the plan one credit activates
  CHECK ((kind = 'credit_pack') = (credits IS NOT NULL)),
  CHECK (kind = 'credit_pack' OR credit_valid_days IS NULL)
);
-- One active plan sku per plan code.
CREATE UNIQUE INDEX billing_products_active_plan_uq ON billing_products (plan_code) WHERE kind = 'plan' AND active;

-- ── Billing profile (who the invoice is addressed to) ─────────────────────────
CREATE TABLE billing_profiles (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  legal_name      text NOT NULL,
  gstin           text CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  state_code      text NOT NULL CHECK (state_code ~ '^[0-9]{2}$'),   -- GST state code: place of supply
  address_line    text,
  postal_code     text CHECK (postal_code ~ '^[1-9][0-9]{5}$'),
  invoice_email   citext,
  updated_by      uuid REFERENCES users(id),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (gstin IS NULL OR substr(gstin, 1, 2) = state_code)
);

-- ── Orders and payments (Razorpay; provider column leaves room for manual/IAP) ─
CREATE TABLE billing_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  wedding_id         uuid REFERENCES weddings(id) ON DELETE SET NULL,   -- null for credit packs
  created_by         uuid NOT NULL REFERENCES users(id),
  status             text NOT NULL DEFAULT 'created'
                     CHECK (status IN ('created','paid','fulfilled','failed','expired','refunded','partially_refunded')),
  provider           text NOT NULL CHECK (provider IN ('razorpay','manual','fake')),
  provider_order_id  text,                                             -- 'order_Nx…'
  currency           text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  subtotal_paise     bigint NOT NULL CHECK (subtotal_paise >= 0),       -- taxable value
  tax_paise          bigint NOT NULL CHECK (tax_paise >= 0),
  total_paise        bigint NOT NULL CHECK (total_paise >= 0),
  supply_type        text NOT NULL CHECK (supply_type IN ('intra','inter')),
  billing_snapshot   jsonb NOT NULL,                                   -- legal_name, gstin, state_code at order time
  idempotency_key    text NOT NULL,
  expires_at         timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  paid_at            timestamptz,
  fulfilled_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (total_paise = subtotal_paise + tax_paise),
  CHECK (provider = 'manual' OR status IN ('created','expired','failed') OR provider_order_id IS NOT NULL),
  UNIQUE (created_by, idempotency_key)
);
CREATE UNIQUE INDEX billing_orders_provider_uq ON billing_orders (provider, provider_order_id) WHERE provider_order_id IS NOT NULL;
CREATE INDEX billing_orders_org_idx ON billing_orders (organization_id, created_at DESC);
CREATE INDEX billing_orders_wedding_idx ON billing_orders (wedding_id) WHERE wedding_id IS NOT NULL;
-- Reconciliation job: recent orders still waiting for payment.
CREATE INDEX billing_orders_open_idx ON billing_orders (created_at) WHERE status = 'created';

CREATE TABLE billing_order_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES billing_orders(id) ON DELETE CASCADE,
  sku                text NOT NULL REFERENCES billing_products(sku),
  item_kind          text NOT NULL CHECK (item_kind IN ('plan','upgrade','credit_pack','addon')),
  from_plan_code     text,                                             -- upgrade: plan already paid for
  quantity           int NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  unit_price_paise   bigint NOT NULL CHECK (unit_price_paise >= 0),    -- list price (upgrade: difference)
  taxable_paise      bigint NOT NULL CHECK (taxable_paise >= 0),
  tax_paise          bigint NOT NULL CHECK (tax_paise >= 0),
  line_total_paise   bigint NOT NULL CHECK (line_total_paise = taxable_paise + tax_paise),
  CHECK ((item_kind = 'upgrade') = (from_plan_code IS NOT NULL))
);
CREATE INDEX billing_order_items_order_idx ON billing_order_items (order_id);

CREATE TABLE payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             uuid NOT NULL REFERENCES billing_orders(id),
  provider             text NOT NULL CHECK (provider IN ('razorpay','manual','fake')),
  provider_payment_id  text NOT NULL,                                  -- 'pay_…' or manual reference
  status               text NOT NULL CHECK (status IN ('authorized','captured','failed','refunded','partially_refunded')),
  method               text,                                           -- upi, card, netbanking, wallet
  amount_paise         bigint NOT NULL CHECK (amount_paise >= 0),
  refunded_paise       bigint NOT NULL DEFAULT 0 CHECK (refunded_paise >= 0),
  error_code           text,
  captured_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id),
  CHECK (refunded_paise <= amount_paise)
);
CREATE INDEX payments_order_idx ON payments (order_id);

-- Raw webhook log: insert-once on the provider's event id, processed by a pg-boss job.
-- Payload kept 180 days (job bil.purge-webhooks), long enough for disputes.
CREATE TABLE payment_webhook_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        text NOT NULL CHECK (provider IN ('razorpay','fake')),
  event_id        text NOT NULL,                                       -- X-Razorpay-Event-Id
  event_type      text NOT NULL,                                       -- payment.captured, order.paid, refund.processed …
  provider_order_id text,
  payload         jsonb NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  UNIQUE (provider, event_id)
);
CREATE INDEX payment_webhook_unprocessed_idx ON payment_webhook_events (received_at) WHERE processed_at IS NULL;

-- ── GST invoices and credit notes ─────────────────────────────────────────────
-- Gapless numbering per (series, financial year): the counter row is locked and incremented in
-- the same transaction that inserts the invoice, so a rollback also rolls back the number.
CREATE TABLE invoice_counters (
  series        text NOT NULL CHECK (series IN ('INV','CRN')),
  fiscal_year   text NOT NULL CHECK (fiscal_year ~ '^[0-9]{4}$'),     -- '2728' = FY 2027-28
  next_number   int NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  PRIMARY KEY (series, fiscal_year)
);

CREATE TABLE invoices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL CHECK (kind IN ('invoice','credit_note')),
  invoice_number        text NOT NULL UNIQUE CHECK (length(invoice_number) <= 16),  -- 'MF/2728/000123' (CGST rule 46)
  series                text NOT NULL,
  fiscal_year           text NOT NULL,
  serial                int NOT NULL,
  order_id              uuid NOT NULL REFERENCES billing_orders(id),
  original_invoice_id   uuid REFERENCES invoices(id),                 -- credit notes only
  organization_id       uuid NOT NULL REFERENCES organizations(id),
  wedding_id            uuid REFERENCES weddings(id) ON DELETE SET NULL,
  issued_at             timestamptz NOT NULL DEFAULT now(),
  supplier_gstin        text NOT NULL,
  supplier_state_code   text NOT NULL,
  recipient_name        text NOT NULL,
  recipient_gstin       text,
  recipient_address     text,
  place_of_supply_code  text NOT NULL CHECK (place_of_supply_code ~ '^[0-9]{2}$'),
  taxable_paise         bigint NOT NULL,
  cgst_paise            bigint NOT NULL DEFAULT 0,
  sgst_paise            bigint NOT NULL DEFAULT 0,
  igst_paise            bigint NOT NULL DEFAULT 0,
  total_paise           bigint NOT NULL,
  pdf_s3_key            text,                                          -- billing bucket; filled by bil.invoice.render
  pdf_rendered_at       timestamptz,
  emailed_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (series, fiscal_year, serial),
  CHECK (total_paise = taxable_paise + cgst_paise + sgst_paise + igst_paise),
  CHECK (igst_paise = 0 OR (cgst_paise = 0 AND sgst_paise = 0)),
  CHECK ((kind = 'credit_note') = (original_invoice_id IS NOT NULL)),
  CHECK (taxable_paise >= 0 AND cgst_paise >= 0 AND sgst_paise >= 0 AND igst_paise >= 0)
);
-- One tax invoice per order.
CREATE UNIQUE INDEX invoices_one_per_order_uq ON invoices (order_id) WHERE kind = 'invoice';
CREATE INDEX invoices_org_idx ON invoices (organization_id, issued_at DESC);
CREATE INDEX invoices_unrendered_idx ON invoices (created_at) WHERE pdf_s3_key IS NULL;

CREATE TABLE invoice_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no         int NOT NULL,
  description     text NOT NULL,                  -- "Mehfil Complete — Ananya & Rohan (12–14 Dec 2027)"
  sac_code        text NOT NULL,
  quantity        int NOT NULL CHECK (quantity >= 1),
  taxable_paise   bigint NOT NULL,
  gst_rate_bp     int NOT NULL,
  cgst_paise      bigint NOT NULL DEFAULT 0,
  sgst_paise      bigint NOT NULL DEFAULT 0,
  igst_paise      bigint NOT NULL DEFAULT 0,
  UNIQUE (invoice_id, line_no)
);

-- ── Credits (planner packs; also a family's pre-paid plan bought before the wedding exists) ──
-- A lot is one purchase. Consumption takes from the lot that expires first (FOR UPDATE).
CREATE TABLE credit_lots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id),
  plan_code          text NOT NULL CHECK (plan_code IN ('essentials','complete','planner')),
  order_id           uuid REFERENCES billing_orders(id),               -- null for comp grants
  source             text NOT NULL CHECK (source IN ('purchase','comp','refund_return')),
  credits_total      int NOT NULL CHECK (credits_total > 0),
  credits_remaining  int NOT NULL,
  expires_at         timestamptz,                                       -- null = never
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (credits_remaining BETWEEN 0 AND credits_total)
);
CREATE INDEX credit_lots_available_idx ON credit_lots (organization_id, plan_code, expires_at NULLS LAST)
  WHERE credits_remaining > 0;

-- Append-only ledger; balance = SUM(credits_remaining) of live lots, ledger explains it.
CREATE TABLE credit_ledger (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  lot_id          uuid NOT NULL REFERENCES credit_lots(id),
  delta           int NOT NULL CHECK (delta <> 0),
  reason          text NOT NULL CHECK (reason IN ('purchase','comp','consume','release','expire','refund')),
  wedding_id      uuid REFERENCES weddings(id) ON DELETE SET NULL,
  wedding_title   text,                                                 -- snapshot for the statement
  order_id        uuid REFERENCES billing_orders(id),
  actor_user_id   uuid REFERENCES users(id),
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (reason NOT IN ('consume','release') OR wedding_title IS NOT NULL),
  CHECK ((reason IN ('purchase','comp','release') AND delta > 0) OR (reason IN ('consume','expire','refund') AND delta < 0))
);
CREATE INDEX credit_ledger_org_idx ON credit_ledger (organization_id, id DESC);
-- A wedding consumes at most one credit, and can be released at most once.
CREATE UNIQUE INDEX credit_ledger_one_consume_uq ON credit_ledger (wedding_id) WHERE reason = 'consume';
CREATE UNIQUE INDEX credit_ledger_one_release_uq ON credit_ledger (wedding_id) WHERE reason = 'release';

-- ── Per-wedding plan state ────────────────────────────────────────────────────
-- The billing module is the only writer of weddings.plan (core column kept as a denormalised copy).
CREATE TABLE wedding_plans (
  wedding_id       uuid PRIMARY KEY REFERENCES weddings(id) ON DELETE CASCADE,
  plan_code        text NOT NULL CHECK (plan_code IN ('free','essentials','complete','planner')),
  plan_sku         text NOT NULL REFERENCES billing_products(sku),
  source           text NOT NULL CHECK (source IN ('free','order','credit','comp')),
  order_id         uuid REFERENCES billing_orders(id),
  credit_lot_id    uuid REFERENCES credit_lots(id),
  activated_at     timestamptz NOT NULL DEFAULT now(),
  activated_by     uuid REFERENCES users(id),
  CHECK (source <> 'order'  OR order_id IS NOT NULL),
  CHECK (source <> 'credit' OR credit_lot_id IS NOT NULL)
);

CREATE TABLE wedding_addons (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id   uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  sku          text NOT NULL REFERENCES billing_products(sku),
  quantity     int NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  order_id     uuid REFERENCES billing_orders(id),
  source       text NOT NULL CHECK (source IN ('order','comp')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wedding_addons_wedding_idx ON wedding_addons (wedding_id);

-- Materialised effective entitlements: plan + add-ons + overrides, recomputed in the same
-- transaction as any change above. Every module reads this one row by primary key.
CREATE TABLE wedding_entitlements (
  wedding_id    uuid PRIMARY KEY REFERENCES weddings(id) ON DELETE CASCADE,
  plan_code     text NOT NULL,
  limits        jsonb NOT NULL,       -- {"guests_max":25,"camera_shots_per_guest":10,"messages_included":100,…}
  features      text[] NOT NULL,      -- {'face_search','quiz','id_vault',…}
  overrides     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- platform-admin overrides (pilots), audited
  version       int NOT NULL DEFAULT 1,
  computed_at   timestamptz NOT NULL DEFAULT now()
);

-- Org-level limits (team seats, branding) derived from the org's live credit lots / admin overrides.
CREATE TABLE organization_entitlements (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  limits          jsonb NOT NULL,      -- {"seats_max":10}
  features        text[] NOT NULL,     -- {'planner_branding','templates'}
  overrides       jsonb NOT NULL DEFAULT '{}'::jsonb,
  version         int NOT NULL DEFAULT 1,
  computed_at     timestamptz NOT NULL DEFAULT now()
);

-- ── Web billing sessions (server-rendered /account pages; cookie, not JWT) ────
CREATE TABLE web_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  csrf_secret   bytea NOT NULL,
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '12 hours',
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX web_sessions_expires_idx ON web_sessions (expires_at);

-- ── Seed catalogue (PLACEHOLDER limits and pack prices: product owner decision, see 23-bil.md §13) ──
INSERT INTO billing_products (sku, kind, plan_code, name, price_paise, tax_inclusive, credits, credit_valid_days, entitlements, sort_order) VALUES
 ('plan_free_v1',       'plan', 'free',       'Free',       0,       true, NULL, NULL,
  '{"limits":{"guests_max":25,"camera_shots_per_guest":10,"messages_included":75,"photo_retention_months":3,"co_hosts_max":1,"desk_staff_max":0},"features":[]}', 0),
 ('plan_essentials_v1', 'plan', 'essentials', 'Essentials', 699900,  true, NULL, NULL,
  '{"limits":{"guests_max":400,"camera_shots_per_guest":25,"messages_included":2000,"photo_retention_months":12,"co_hosts_max":3,"desk_staff_max":3},"features":["sms_fallback","travel","arrivals","gallery_download"]}', 10),
 ('plan_complete_v1',   'plan', 'complete',   'Complete',   1499900, true, NULL, NULL,
  '{"limits":{"guests_max":2000,"camera_shots_per_guest":50,"messages_included":8000,"photo_retention_months":12,"co_hosts_max":5,"desk_staff_max":10},"features":["sms_fallback","travel","arrivals","gallery_download","pickups","rooms","id_vault","face_search","quiz","feed","languages"]}', 20),
 ('plan_planner_v1',    'plan', 'planner',    'Planner',    0,       false, NULL, NULL,
  '{"limits":{"guests_max":2000,"camera_shots_per_guest":50,"messages_included":8000,"photo_retention_months":12,"co_hosts_max":5,"desk_staff_max":20},"features":["sms_fallback","travel","arrivals","gallery_download","pickups","rooms","id_vault","face_search","quiz","feed","languages","planner_branding"]}', 30),
 ('pack_planner_5_v1',  'credit_pack', 'planner', 'Planner pack — 5 weddings',  4999900, false, 5,  365, '{}', 40),
 ('pack_planner_10_v1', 'credit_pack', 'planner', 'Planner pack — 10 weddings', 8999900, false, 10, 365, '{}', 41),
 ('pass_essentials_v1', 'credit_pack', 'essentials', 'Essentials (activate later)', 699900, true, 1, 365, '{}', 11),
 ('pass_complete_v1',   'credit_pack', 'complete',   'Complete (activate later)',   1499900, true, 1, 365, '{}', 21);
INSERT INTO billing_products (sku, kind, name, price_paise, tax_inclusive, entitlements, sort_order) VALUES
 ('addon_messages_1000_v1', 'addon', 'Extra 1,000 messages',     99900, true, '{"limits_add":{"messages_included":1000}}', 50),
 ('addon_storage_12m_v1',   'addon', 'Keep photos 12 more months', 149900, true, '{"limits_add":{"photo_retention_months":12}}', 51);
