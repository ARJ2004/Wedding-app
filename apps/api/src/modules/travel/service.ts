import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../common/errors';
import { writeAudit } from '../audit';

type Db = PrismaClient | Prisma.TransactionClient;
export type Direction = 'arrival' | 'departure';
export type Mode = 'flight' | 'train' | 'car' | 'bus' | 'other';

export interface LegInput {
  direction: Direction;
  mode: Mode;
  carrierCode?: string | null;
  serviceNumber?: string | null;
  originCity?: string | null;
  pointId?: string | null;
  scheduledAt: string;
  needsPickup: boolean;
  notes?: string | null;
  guestIds: string[];
}

export type Actor = { type: 'guest'; guestId: string } | { type: 'user'; userId: string; role: string };

const DAY = 86_400_000;

/** "6e 2134" → { carrier: "6E", number: "6E2134" }; trains keep digits. */
export function normaliseService(mode: Mode, carrier?: string | null, service?: string | null) {
  if (!service) return { carrier: carrier?.toUpperCase().trim() || null, number: null };
  const raw = service.toUpperCase().replace(/[\s-]/g, '');
  if (mode === 'flight') {
    if (!/^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(raw)) throw new AppError('TRV_FLIGHT_NUMBER_INVALID', 'Flight numbers look like 6E 2134', 400);
    return { carrier: (carrier?.toUpperCase().trim() || raw.slice(0, 2)) ?? null, number: raw };
  }
  return { carrier: carrier?.toUpperCase().trim() || null, number: raw.slice(0, 20) };
}

const legInclude = {
  travel_leg_guests: { include: { guests: { select: { id: true, full_name: true } } } },
  travel_points: { select: { id: true, name: true, kind: true } },
} satisfies Prisma.travel_legsInclude;
type LegRow = Prisma.travel_legsGetPayload<{ include: typeof legInclude }>;

export const legDto = (l: LegRow) => ({
  id: l.id,
  partyId: l.party_id,
  version: l.version,
  direction: l.direction as Direction,
  mode: l.mode as Mode,
  carrierCode: l.carrier_code,
  serviceNumber: l.service_number,
  originCity: l.origin_city,
  scheduledAt: l.scheduled_at.toISOString(),
  point: l.travel_points ? { id: l.travel_points.id, name: l.travel_points.name, kind: l.travel_points.kind } : null,
  needsPickup: l.needs_pickup,
  notes: l.notes,
  source: l.source,
  guests: l.travel_leg_guests.map((g) => ({ id: g.guests.id, fullName: g.guests.full_name })).sort((a, b) => a.fullName.localeCompare(b.fullName)),
  updatedAt: l.updated_at.toISOString(),
});

/**
 * Travel collection (TRV-01, 08-trv). One leg = one journey into or out of the wedding city,
 * shared by some or all party members; a guest has at most one arrival and one departure leg.
 * Guest and host edit the same rows; `version` + If-Match stops one silently undoing the other.
 */
export class TravelService {
  constructor(private readonly prisma: PrismaClient) {}

  private async validate(weddingId: string, partyId: string, input: Pick<LegInput, 'pointId' | 'scheduledAt' | 'guestIds'>, ignoreLegId?: string, direction?: Direction) {
    const w = await this.prisma.weddings.findUniqueOrThrow({ where: { id: weddingId }, select: { starts_on: true, ends_on: true } });
    const at = new Date(input.scheduledAt);
    if (Number.isNaN(at.getTime())) throw new AppError('VALIDATION_FAILED', 'Pick a date and time', 400);
    if (at.getTime() < w.starts_on.getTime() - 7 * DAY || at.getTime() > w.ends_on.getTime() + 8 * DAY) {
      throw new AppError('TRV_DATE_OUT_OF_RANGE', 'That date is far from the wedding dates. Please check it.', 400);
    }
    if (input.pointId) {
      const p = await this.prisma.travel_points.findFirst({ where: { id: input.pointId, wedding_id: weddingId } });
      if (!p || !p.is_active) throw new AppError('TRV_POINT_INACTIVE', 'Pick one of the listed arrival points', 400);
    }
    const members = await this.prisma.guests.findMany({ where: { party_id: partyId, deleted_at: null, id: { in: input.guestIds } }, select: { id: true } });
    if (members.length !== new Set(input.guestIds).size) throw new AppError('TRV_GUEST_NOT_IN_PARTY', 'That person is not on this invite', 404);
    if (direction) {
      const taken = await this.prisma.travel_leg_guests.findFirst({
        where: { guest_id: { in: input.guestIds }, direction, ...(ignoreLegId ? { leg_id: { not: ignoreLegId } } : {}) },
        include: { guests: { select: { full_name: true } } },
      });
      if (taken) throw new AppError('TRV_LEG_EXISTS_FOR_GUEST', `${taken.guests.full_name} already has ${direction === 'arrival' ? 'an arrival' : 'a departure'}`, 409);
    }
  }

  /** pending → partial (some travelling members have an arrival) → submitted; not_travelling sticks until a leg is added. */
  private async recompute(db: Db, weddingId: string, partyId: string) {
    const members = await db.guests.count({ where: { party_id: partyId, deleted_at: null } });
    const arriving = await db.travel_leg_guests.count({ where: { direction: 'arrival', guests: { party_id: partyId, deleted_at: null } } });
    const status = arriving === 0 ? 'pending' : arriving >= members ? 'submitted' : 'partial';
    const cur = await db.travel_party_state.findUnique({ where: { party_id: partyId } });
    if (cur?.status === 'not_travelling' && arriving === 0) return cur.status;
    await db.travel_party_state.upsert({
      where: { party_id: partyId },
      create: { party_id: partyId, wedding_id: weddingId, status, submitted_at: status === 'submitted' ? new Date() : null },
      update: { status, submitted_at: status === 'submitted' ? (cur?.submitted_at ?? new Date()) : null, updated_at: new Date() },
    });
    return status;
  }

  private audit(db: Db, weddingId: string, actor: Actor, action: string, entityId: string, after?: unknown) {
    return writeAudit(db, {
      weddingId,
      actor: actor.type === 'guest' ? { type: 'guest', id: actor.guestId } : { type: 'user', id: actor.userId, role: actor.role },
      action,
      entityType: 'travel_leg',
      entityId,
      after,
    });
  }

  async partyInWedding(weddingId: string, partyId: string) {
    return (await this.prisma.parties.count({ where: { id: partyId, wedding_id: weddingId, deleted_at: null } })) > 0;
  }

  notFoundParty(): never {
    throw new AppError('GST_PARTY_NOT_FOUND', 'Party not found', 404);
  }

  async partyView(weddingId: string, partyId: string) {
    const [legs, state, members, points] = await Promise.all([
      this.prisma.travel_legs.findMany({ where: { party_id: partyId }, include: legInclude, orderBy: [{ direction: 'asc' }, { scheduled_at: 'asc' }] }),
      this.prisma.travel_party_state.findUnique({ where: { party_id: partyId } }),
      this.prisma.guests.findMany({ where: { party_id: partyId, deleted_at: null }, select: { id: true, full_name: true }, orderBy: [{ is_primary: 'desc' }, { created_at: 'asc' }] }),
      this.listPoints(weddingId, true),
    ]);
    return {
      status: (state?.status ?? 'pending') as 'pending' | 'partial' | 'submitted' | 'not_travelling',
      members: members.map((m) => ({ id: m.id, fullName: m.full_name })),
      legs: legs.map(legDto),
      points,
    };
  }

  async create(weddingId: string, partyId: string, input: LegInput, actor: Actor) {
    const n = normaliseService(input.mode, input.carrierCode, input.serviceNumber);
    await this.validate(weddingId, partyId, input, undefined, input.direction);
    const leg = await this.prisma.$transaction(async (tx) => {
      const l = await tx.travel_legs.create({
        data: {
          wedding_id: weddingId,
          party_id: partyId,
          direction: input.direction,
          mode: input.mode,
          carrier_code: input.mode === 'flight' ? n.carrier : null,
          service_number: n.number,
          origin_city: input.originCity?.trim() || null,
          point_id: input.pointId ?? null,
          scheduled_at: new Date(input.scheduledAt),
          needs_pickup: input.needsPickup,
          notes: input.notes?.trim() || null,
          source: actor.type === 'guest' ? 'guest' : 'host',
          created_by_guest_id: actor.type === 'guest' ? actor.guestId : null,
          created_by_user_id: actor.type === 'user' ? actor.userId : null,
        },
      });
      await tx.travel_leg_guests.createMany({ data: input.guestIds.map((g) => ({ leg_id: l.id, wedding_id: weddingId, direction: input.direction, guest_id: g })) });
      await this.recompute(tx, weddingId, partyId);
      await this.audit(tx, weddingId, actor, 'travel.leg_create', l.id, { direction: input.direction, mode: input.mode, guests: input.guestIds.length });
      return tx.travel_legs.findUniqueOrThrow({ where: { id: l.id }, include: legInclude });
    });
    return legDto(leg);
  }

  private async loadLeg(weddingId: string, legId: string, partyId?: string) {
    const l = await this.prisma.travel_legs.findFirst({ where: { id: legId, wedding_id: weddingId, ...(partyId ? { party_id: partyId } : {}) } });
    if (!l) throw new AppError('TRV_LEG_NOT_FOUND', 'Journey not found', 404);
    return l;
  }

  async update(weddingId: string, legId: string, version: number | null, patch: Partial<Omit<LegInput, 'direction'>>, actor: Actor, partyId?: string) {
    const cur = await this.loadLeg(weddingId, legId, partyId);
    if (version === null) throw new AppError('TRV_IF_MATCH_REQUIRED', 'Send If-Match with the version you edited', 428);
    const mode = (patch.mode ?? cur.mode) as Mode;
    const n = patch.serviceNumber !== undefined || patch.mode ? normaliseService(mode, patch.carrierCode ?? cur.carrier_code, patch.serviceNumber ?? cur.service_number) : null;
    const guestIds = patch.guestIds;
    await this.validate(
      weddingId,
      cur.party_id,
      { pointId: patch.pointId === undefined ? cur.point_id : patch.pointId, scheduledAt: patch.scheduledAt ?? cur.scheduled_at.toISOString(), guestIds: guestIds ?? [] },
      legId,
      guestIds ? (cur.direction as Direction) : undefined,
    );
    const leg = await this.prisma.$transaction(async (tx) => {
      const r = await tx.travel_legs.updateMany({
        where: { id: legId, version },
        data: {
          ...(patch.mode ? { mode } : {}),
          ...(n ? { carrier_code: mode === 'flight' ? n.carrier : null, service_number: n.number } : {}),
          ...(patch.originCity !== undefined ? { origin_city: patch.originCity?.trim() || null } : {}),
          ...(patch.pointId !== undefined ? { point_id: patch.pointId } : {}),
          ...(patch.scheduledAt ? { scheduled_at: new Date(patch.scheduledAt), estimated_at: null, flight_status: null } : {}),
          ...(patch.needsPickup !== undefined ? { needs_pickup: patch.needsPickup } : {}),
          ...(patch.notes !== undefined ? { notes: patch.notes?.trim() || null } : {}),
          ...(actor.type === 'user' ? { source: 'host' } : {}),
          version: { increment: 1 },
          updated_at: new Date(),
        },
      });
      if (r.count === 0) throw new AppError('TRV_VERSION_CONFLICT', 'Someone else changed this journey. Reload to see their changes.', 409);
      if (guestIds) {
        await tx.travel_leg_guests.deleteMany({ where: { leg_id: legId } });
        await tx.travel_leg_guests.createMany({ data: guestIds.map((g) => ({ leg_id: legId, wedding_id: weddingId, direction: cur.direction, guest_id: g })) });
      }
      await this.recompute(tx, weddingId, cur.party_id);
      await this.audit(tx, weddingId, actor, 'travel.leg_update', legId, { fields: Object.keys(patch) });
      return tx.travel_legs.findUniqueOrThrow({ where: { id: legId }, include: legInclude });
    });
    return legDto(leg);
  }

  async remove(weddingId: string, legId: string, actor: Actor, partyId?: string) {
    const cur = await this.loadLeg(weddingId, legId, partyId);
    await this.prisma.$transaction(async (tx) => {
      await tx.travel_legs.delete({ where: { id: legId } });
      await this.recompute(tx, weddingId, cur.party_id);
      await this.audit(tx, weddingId, actor, 'travel.leg_delete', legId, { direction: cur.direction });
    });
  }

  async notTravelling(weddingId: string, partyId: string, actor: Actor) {
    const legs = await this.prisma.travel_legs.count({ where: { party_id: partyId, direction: 'arrival' } });
    if (legs > 0) throw new AppError('TRV_HAS_LEGS', 'Remove the journeys first', 409);
    await this.prisma.$transaction(async (tx) => {
      await tx.travel_party_state.upsert({
        where: { party_id: partyId },
        create: { party_id: partyId, wedding_id: weddingId, status: 'not_travelling' },
        update: { status: 'not_travelling', updated_at: new Date() },
      });
      await writeAudit(tx, {
        weddingId,
        actor: actor.type === 'guest' ? { type: 'guest', id: actor.guestId } : { type: 'user', id: actor.userId, role: actor.role },
        action: 'travel.not_travelling',
        entityType: 'party',
        entityId: partyId,
      });
    });
  }

  // ── Travel points (host-managed; guests pick one) ──
  async listPoints(weddingId: string, activeOnly = false) {
    const rows = await this.prisma.travel_points.findMany({ where: { wedding_id: weddingId, ...(activeOnly ? { is_active: true } : {}) }, orderBy: [{ sort_order: 'asc' }, { name: 'asc' }] });
    return rows.map((p) => ({ id: p.id, kind: p.kind as 'airport' | 'station' | 'bus_stand' | 'other', name: p.name, code: p.code, isActive: p.is_active, pickupBufferMinutes: p.pickup_buffer_minutes, transferMinutes: p.transfer_minutes }));
  }

  async createPoint(weddingId: string, input: { kind: 'airport' | 'station' | 'bus_stand' | 'other'; name: string; code?: string | null; pickupBufferMinutes?: number; transferMinutes?: number }) {
    try {
      const count = await this.prisma.travel_points.count({ where: { wedding_id: weddingId } });
      await this.prisma.travel_points.create({
        data: { wedding_id: weddingId, kind: input.kind, name: input.name.trim(), code: input.code?.toUpperCase().trim() || null, pickup_buffer_minutes: input.pickupBufferMinutes ?? 30, transfer_minutes: input.transferMinutes ?? 45, sort_order: count },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new AppError('TRV_POINT_NAME_TAKEN', 'A point with that name exists', 409);
      throw e;
    }
    return this.listPoints(weddingId);
  }

  async updatePoint(weddingId: string, id: string, patch: { name?: string; code?: string | null; isActive?: boolean; pickupBufferMinutes?: number; transferMinutes?: number }) {
    const n = await this.prisma.travel_points.updateMany({
      where: { id, wedding_id: weddingId },
      data: {
        ...(patch.name ? { name: patch.name.trim() } : {}),
        ...(patch.code !== undefined ? { code: patch.code?.toUpperCase().trim() || null } : {}),
        ...(patch.isActive !== undefined ? { is_active: patch.isActive } : {}),
        ...(patch.pickupBufferMinutes !== undefined ? { pickup_buffer_minutes: patch.pickupBufferMinutes } : {}),
        ...(patch.transferMinutes !== undefined ? { transfer_minutes: patch.transferMinutes } : {}),
      },
    });
    if (!n.count) throw new AppError('TRV_POINT_NOT_FOUND', 'Point not found', 404);
    return this.listPoints(weddingId);
  }

  /** Referenced points are hidden, not deleted, so existing journeys keep their label. */
  async deletePoint(weddingId: string, id: string) {
    const used = await this.prisma.travel_legs.count({ where: { point_id: id } });
    const n = used
      ? await this.prisma.travel_points.updateMany({ where: { id, wedding_id: weddingId }, data: { is_active: false } })
      : await this.prisma.travel_points.deleteMany({ where: { id, wedding_id: weddingId } });
    if (!n.count) throw new AppError('TRV_POINT_NOT_FOUND', 'Point not found', 404);
  }

  /** Host list (TRV-03 builds the full view): legs by direction and day. */
  async hostLegs(weddingId: string, q: { direction?: Direction; partyId?: string }) {
    const rows = await this.prisma.travel_legs.findMany({
      where: { wedding_id: weddingId, ...(q.direction ? { direction: q.direction } : {}), ...(q.partyId ? { party_id: q.partyId } : {}) },
      include: legInclude,
      orderBy: [{ scheduled_at: 'asc' }, { id: 'asc' }],
      take: 2000,
    });
    return rows.map(legDto);
  }
}
