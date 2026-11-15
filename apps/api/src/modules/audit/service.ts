import type { Prisma, PrismaClient } from '@prisma/client';

type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditEntry {
  weddingId?: string | null;
  organizationId?: string | null;
  actor: { type: 'user' | 'guest' | 'system'; id?: string | null; role?: string | null; label?: string | null };
  /** `<entity>.<verb>`, e.g. `wedding.create`, `guest.update`, `rsvp.override`. */
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
}

/**
 * ROL-03a audit writer. Call inside the same transaction as the change so the log and the
 * data never disagree. The table is append-only (trigger in 10-rol.sql); PRV redacts only.
 */
export async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  await db.audit_log.create({
    data: {
      wedding_id: e.weddingId ?? null,
      organization_id: e.organizationId ?? null,
      actor_type: e.actor.type,
      actor_id: e.actor.id ?? null,
      actor_role: e.actor.role ?? null,
      actor_label: e.actor.label ?? null,
      action: e.action,
      entity_type: e.entityType,
      entity_id: e.entityId ?? null,
      before: (e.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (e.after ?? undefined) as Prisma.InputJsonValue | undefined,
      request_id: e.requestId ?? null,
    },
  });
}

/** Only the fields that changed, for compact before/after pairs. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(after)) {
    if (v !== undefined && JSON.stringify(before[k]) !== JSON.stringify(v)) {
      b[k] = before[k];
      a[k] = v;
    }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}
