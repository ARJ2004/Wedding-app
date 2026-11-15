import { can, type WeddingRole } from '@mehfil/domain';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { defineRoute, type RouteContext } from '../../common/define-route';
import { AppError } from '../../common/errors';
import { WeddingParams } from '../weddings/schemas';

const Num = z.number().int();
const StatusCounts = z.object({ attending: Num, declined: Num, maybe: Num, pending: Num });
const EventHeadcount = z
  .object({
    eventId: z.string(),
    name: z.string(),
    startsAt: z.string(),
    rsvpEnabled: z.boolean(),
    invited: Num,
    counts: StatusCounts,
    /** Full roles only; desk staff get totals (06-rsv §8). */
    bySide: z.record(z.string(), StatusCounts).optional(),
    diet: z.record(z.string(), Num).optional(),
    allergies: z.record(z.string(), Num).optional(),
    ageBand: z.record(z.string(), Num).optional(),
  })
  .openapi('EventHeadcount');
export const HeadcountSchema = z.object({ rtCursor: z.string(), generatedAt: z.string(), detail: z.boolean(), events: z.array(EventHeadcount) }).openapi('Headcount');

type Row = { event_id: string; status: string; side: string | null; diet: string; age_band: string | null; n: number };
const zero = () => ({ attending: 0, declined: 0, maybe: 0, pending: 0 });

/**
 * Headcount per event (RSV-03, 06-rsv §3): aggregate SQL on read, run in one REPEATABLE READ
 * snapshot with the latest headcount realtime id, so a client can tell which live events are newer.
 * Diet, allergy and age counts cover people attending or maybe.
 */
export async function headcount(prisma: PrismaClient, weddingId: string, detail: boolean) {
  const [rows, allergyRows, cursor, events] = await prisma.$transaction(
    [
      prisma.$queryRaw<Row[]>`
        WITH inv AS (SELECT pie.event_id, g.party_id, g.id AS guest_id, g.age_band
                     FROM party_invited_events pie
                     JOIN guests g ON g.party_id = pie.party_id AND g.deleted_at IS NULL
                     WHERE pie.wedding_id = ${weddingId}::uuid AND g.wedding_id = ${weddingId}::uuid),
             r AS (SELECT event_id, guest_id, status FROM rsvps WHERE wedding_id = ${weddingId}::uuid),
             side AS (SELECT pg.party_id, min(gg.system_key) AS key FROM guest_groups gg
                      JOIN party_groups pg ON pg.group_id = gg.id
                      WHERE gg.wedding_id = ${weddingId}::uuid AND gg.system_key IN ('bride_side','groom_side') GROUP BY pg.party_id),
             d AS (SELECT guest_id, diet FROM guest_dietary WHERE wedding_id = ${weddingId}::uuid)
        SELECT inv.event_id::text, coalesce(r.status,'pending') AS status, side.key AS side,
               coalesce(d.diet,'unknown') AS diet, inv.age_band, count(*)::int AS n
        FROM inv LEFT JOIN r USING (event_id, guest_id) LEFT JOIN side USING (party_id) LEFT JOIN d USING (guest_id)
        GROUP BY 1,2,3,4,5`,
      prisma.$queryRaw<{ event_id: string; allergy: string; n: number }[]>`
        SELECT r.event_id::text, a.allergy, count(*)::int AS n
        FROM rsvps r JOIN guest_dietary d ON d.guest_id = r.guest_id
        CROSS JOIN LATERAL unnest(d.allergies) AS a(allergy)
        WHERE r.wedding_id = ${weddingId}::uuid AND r.status IN ('attending','maybe')
        GROUP BY 1,2`,
      prisma.$queryRaw<{ id: bigint | null }[]>`
        SELECT max(id) AS id FROM realtime_events WHERE wedding_id = ${weddingId}::uuid AND channel = 'headcount'`,
      prisma.events.findMany({ where: { wedding_id: weddingId, deleted_at: null }, orderBy: [{ starts_at: 'asc' }, { sort_order: 'asc' }], select: { id: true, name: true, starts_at: true, rsvp_enabled: true } }),
    ],
    { isolationLevel: 'RepeatableRead' },
  );
  const out = events.map((e) => {
    const mine = rows.filter((r) => r.event_id === e.id);
    const counts = zero();
    const bySide: Record<string, ReturnType<typeof zero>> = {};
    const diet: Record<string, number> = {};
    const ageBand: Record<string, number> = {};
    for (const r of mine) {
      const st = r.status as keyof ReturnType<typeof zero>;
      counts[st] += r.n;
      const sk = r.side ?? 'none';
      (bySide[sk] ??= zero())[st] += r.n;
      if (st === 'attending' || st === 'maybe') {
        diet[r.diet] = (diet[r.diet] ?? 0) + r.n;
        const ab = r.age_band ?? 'adult';
        ageBand[ab] = (ageBand[ab] ?? 0) + r.n;
      }
    }
    const allergies = Object.fromEntries(allergyRows.filter((a) => a.event_id === e.id).map((a) => [a.allergy, a.n]));
    const invited = counts.attending + counts.declined + counts.maybe + counts.pending;
    return {
      eventId: e.id,
      name: e.name,
      startsAt: e.starts_at.toISOString(),
      rsvpEnabled: e.rsvp_enabled,
      invited,
      counts,
      ...(detail ? { bySide, diet, allergies, ageBand } : {}),
    };
  });
  return { rtCursor: String(cursor[0]?.id ?? 0), generatedAt: new Date().toISOString(), detail, events: out };
}

export function headcountRoutes(ctx: RouteContext, prisma: PrismaClient) {
  defineRoute(ctx, {
    method: 'get',
    path: '/v1/weddings/:weddingId/rsvp/headcount',
    summary: 'Who is coming, per event (live via the headcount stream)',
    tags: ['rsvp'],
    auth: 'host',
    permission: 'event.read',
    request: { params: WeddingParams },
    response: { status: 200, schema: HeadcountSchema },
    handler: async ({ params, req }) => {
      const role = req.membership!.role as WeddingRole;
      const detail = can(role, 'rsvp.read');
      if (!detail && !can(role, 'rsvp.headcount')) throw new AppError('ROL_FORBIDDEN', 'Not allowed', 403);
      return headcount(prisma, params.weddingId, detail);
    },
  });
}
