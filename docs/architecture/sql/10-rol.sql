-- E10 Roles, permissions and audit (ROL). Design: docs/architecture/10-rol.md
-- Builds on 000-core.sql only. New table: team_invitations. Adds columns/indexes/guards to
-- wedding_members, organization_members, organizations and audit_log.

-- ── Exactly one owner per wedding; transfer is a two-row update in one transaction ──
CREATE UNIQUE INDEX wedding_members_one_owner_uq ON wedding_members (wedding_id) WHERE role = 'owner';

ALTER TABLE wedding_members
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- "My weddings" for an org admin (implicit access) and team-seat listing.
CREATE INDEX organization_members_user_idx ON organization_members (user_id);

ALTER TABLE organizations
  ADD COLUMN created_by uuid REFERENCES users(id),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- ── Team invitations (ROL-01, ROL-04) ─────────────────────────────────────────
-- An invitation targets a wedding role OR an organisation seat, never both.
-- Delivered as a link shared from the inviter's phone (share sheet → WhatsApp/email) and shown
-- in-app to any signed-in user whose verified Google email matches.
CREATE TABLE team_invitations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id       uuid REFERENCES weddings(id) ON DELETE CASCADE,
  organization_id  uuid REFERENCES organizations(id) ON DELETE CASCADE,
  email            citext NOT NULL,
  role             text CHECK (role IN ('co_host','planner_member','desk_staff')),      -- wedding invites; owner only by transfer
  org_role         text CHECK (org_role IN ('org_admin','org_member')),                  -- org invites
  token_hash       bytea NOT NULL UNIQUE,                 -- sha256 of 128-bit token; token never stored
  invited_by       uuid NOT NULL REFERENCES users(id),
  expires_at       timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at      timestamptz,
  accepted_by      uuid REFERENCES users(id),
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((wedding_id IS NULL) <> (organization_id IS NULL)),
  CHECK ((wedding_id IS NOT NULL) = (role IS NOT NULL)),
  CHECK ((organization_id IS NOT NULL) = (org_role IS NOT NULL)),
  CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL))
);
-- At most one open invite per email per wedding / per org (re-invite = revoke + create).
CREATE UNIQUE INDEX team_invitations_open_wedding_uq ON team_invitations (wedding_id, email)
  WHERE wedding_id IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX team_invitations_open_org_uq ON team_invitations (organization_id, email)
  WHERE organization_id IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL;
-- "Invitations waiting for me" on sign-in.
CREATE INDEX team_invitations_email_open_idx ON team_invitations (email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ── Audit log (ROL-03) ────────────────────────────────────────────────────────
ALTER TABLE audit_log
  ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- org-level actions (seats)
  ADD COLUMN actor_role      text,                         -- role at the time: owner, desk_staff, guest, system
  ADD COLUMN actor_label     text,                         -- name snapshot so the viewer survives user deletion
  ADD COLUMN request_id      text,                         -- correlates with Pino logs / Sentry
  ADD COLUMN redacted_at     timestamptz;                  -- set when PRV-02 scrubs before/after for a deleted guest

-- Viewer filters (all keyset-paginated on id DESC within a wedding).
CREATE INDEX audit_wedding_id_idx     ON audit_log (wedding_id, id DESC);
CREATE INDEX audit_wedding_entity_idx ON audit_log (wedding_id, entity_type, entity_id, id DESC);
CREATE INDEX audit_wedding_actor_idx  ON audit_log (wedding_id, actor_id, id DESC);
CREATE INDEX audit_wedding_action_idx ON audit_log (wedding_id, action, id DESC);
CREATE INDEX audit_org_idx            ON audit_log (organization_id, id DESC) WHERE organization_id IS NOT NULL;

-- Append-only guard. UPDATE is allowed only to redact (PRV-02) and DELETE only for retention purges,
-- and both only when the transaction sets `SET LOCAL mehfil.audit_maintenance = 'on'`.
-- ON DELETE CASCADE from weddings runs under the purge job, which sets the flag.
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('mehfil.audit_maintenance', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'audit_log is append-only (%)', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.action <> OLD.action OR NEW.created_at <> OLD.created_at
       OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.entity_id IS DISTINCT FROM OLD.entity_id THEN
      RAISE EXCEPTION 'audit_log redaction may only change before/after/actor_label/redacted_at';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
