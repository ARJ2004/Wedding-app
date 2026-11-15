import type { Prisma, PrismaClient, events, venues, weddings } from '@prisma/client';
import { isValidTimeZone, presetFor, zonedTimeToUtc, EVENT_PRESETS, type WeddingRole } from '@mehfil/domain';
import type { z } from 'zod';
import { AppError } from '../../common/errors';
import { diff, writeAudit } from '../audit';
import { parseMapsLink } from './maps';
import type {
  BulkPresetsSchema,
  CreateEventSchema,
  CreateVenueSchema,
  CreateWeddingSchema,
  UpdateEventSchema,
  UpdateVenueSchema,
  UpdateWeddingSchema,
} from './schemas';

export interface Actor {
  userId: string;
  role?: WeddingRole;
  requestId?: string;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

const BUILT_IN_GROUPS = [
  ['bride_side', 'Bride side'],
  ['groom_side', 'Groom side'],
  ['family', 'Family'],
  ['friends', 'Friends'],
  ['vip', 'VIP'],
] as const;

export function toWedding(w: weddings, myRole: WeddingRole) {
  return {
    id: w.id,
    organizationId: w.organization_id,
    title: w.title,
    partnerOneName: w.partner_one_name,
    partnerTwoName: w.partner_two_name,
    startsOn: isoDate(w.starts_on),
    endsOn: isoDate(w.ends_on),
    timezone: w.timezone,
    cities: w.cities,
    plan: w.plan,
    status: w.status,
    myRole,
  };
}

export function toEvent(e: events) {
  return {
    id: e.id,
    kind: e.kind as z.infer<typeof CreateEventSchema>['kind'],
    name: e.name,
    startsAt: e.starts_at.toISOString(),
    endsAt: e.ends_at?.toISOString() ?? null,
    venueId: e.venue_id,
    dressCode: e.dress_code,
    notes: e.notes,
    sortOrder: e.sort_order,
    visibility: e.visibility as 'all' | 'groups',
  };
}

export function toVenue(v: venues) {
  return {
    id: v.id,
    name: v.name,
    address: v.address,
    city: v.city,
    lat: v.lat,
    lng: v.lng,
    mapsUrl: v.maps_url,
    parkingNotes: v.parking_notes,
    notes: v.notes,
  };
}

function checkDates(startsOn: string, endsOn: string) {
  if (endsOn < startsOn) throw new AppError('SET_DATES_INVALID', 'The last day must be on or after the first day', 400);
}

export class WeddingsService {
  constructor(private readonly prisma: PrismaClient) {}

  async create(actor: Actor, input: z.infer<typeof CreateWeddingSchema>) {
    checkDates(input.startsOn, input.endsOn);
    if (!isValidTimeZone(input.timezone)) throw new AppError('SET_TIMEZONE_INVALID', 'Unknown timezone', 400);

    return this.prisma.$transaction(async (tx) => {
      let organizationId = input.organizationId;
      if (organizationId) {
        const seat = await tx.organization_members.findUnique({
          where: { organization_id_user_id: { organization_id: organizationId, user_id: actor.userId } },
        });
        if (!seat) throw new AppError('SET_ORG_FORBIDDEN', 'You are not a member of that organisation', 403);
      } else {
        const org = await tx.organizations.create({ data: { name: input.title, kind: 'family', created_by: actor.userId } });
        await tx.organization_members.create({ data: { organization_id: org.id, user_id: actor.userId, org_role: 'org_owner' } });
        organizationId = org.id;
      }
      const w = await tx.weddings.create({
        data: {
          organization_id: organizationId,
          title: input.title,
          partner_one_name: input.partnerOneName,
          partner_two_name: input.partnerTwoName,
          starts_on: new Date(input.startsOn),
          ends_on: new Date(input.endsOn),
          timezone: input.timezone,
          cities: input.cities,
          created_by: actor.userId,
          updated_by: actor.userId,
        },
      });
      await tx.wedding_members.create({ data: { wedding_id: w.id, user_id: actor.userId, role: 'owner' } });
      await tx.guest_groups.createMany({
        data: BUILT_IN_GROUPS.map(([key, name], i) => ({ wedding_id: w.id, name, system_key: key, sort_order: i })),
      });
      await writeAudit(tx, {
        weddingId: w.id,
        actor: { type: 'user', id: actor.userId, role: 'owner' },
        action: 'wedding.create',
        entityType: 'wedding',
        entityId: w.id,
        after: { title: w.title, startsOn: input.startsOn, endsOn: input.endsOn },
        requestId: actor.requestId,
      });
      return toWedding(w, 'owner');
    });
  }

  async get(weddingId: string, role: WeddingRole) {
    const w = await this.prisma.weddings.findFirst({ where: { id: weddingId, deleted_at: null } });
    if (!w) throw new AppError('WEDDING_NOT_FOUND', 'Wedding not found', 404);
    return toWedding(w, role);
  }

  async update(actor: Actor, weddingId: string, input: z.infer<typeof UpdateWeddingSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const w = await tx.weddings.findFirstOrThrow({ where: { id: weddingId, deleted_at: null } });
      const startsOn = input.startsOn ?? isoDate(w.starts_on);
      const endsOn = input.endsOn ?? isoDate(w.ends_on);
      checkDates(startsOn, endsOn);
      if (input.timezone && !isValidTimeZone(input.timezone)) throw new AppError('SET_TIMEZONE_INVALID', 'Unknown timezone', 400);
      const before = toWedding(w, actor.role!);
      const updated = await tx.weddings.update({
        where: { id: weddingId },
        data: {
          title: input.title,
          partner_one_name: input.partnerOneName,
          partner_two_name: input.partnerTwoName,
          starts_on: input.startsOn ? new Date(input.startsOn) : undefined,
          ends_on: input.endsOn ? new Date(input.endsOn) : undefined,
          timezone: input.timezone,
          cities: input.cities,
          updated_by: actor.userId,
          updated_at: new Date(),
        },
      });
      const after = toWedding(updated, actor.role!);
      const d = diff(before, after);
      if (d.changed) {
        await writeAudit(tx, {
          weddingId,
          actor: { type: 'user', id: actor.userId, role: actor.role },
          action: 'wedding.update',
          entityType: 'wedding',
          entityId: weddingId,
          before: d.before,
          after: d.after,
          requestId: actor.requestId,
        });
      }
      return after;
    });
  }

  // ── events ────────────────────────────────────────────────────────────────
  listEvents(weddingId: string) {
    return this.prisma.events
      .findMany({ where: { wedding_id: weddingId, deleted_at: null }, orderBy: [{ sort_order: 'asc' }, { starts_at: 'asc' }] })
      .then((rows) => rows.map(toEvent));
  }

  private async checkVenue(db: Prisma.TransactionClient, weddingId: string, venueId: string | null | undefined) {
    if (!venueId) return;
    const v = await db.venues.findFirst({ where: { id: venueId, wedding_id: weddingId } });
    if (!v) throw new AppError('SET_VENUE_NOT_FOUND', 'Venue not found in this wedding', 400);
  }

  private checkTimes(startsAt: Date, endsAt: Date | null | undefined) {
    if (endsAt && endsAt <= startsAt) throw new AppError('SET_EVENT_TIME_INVALID', 'The event must end after it starts', 400);
  }

  async createEvent(actor: Actor, weddingId: string, input: z.infer<typeof CreateEventSchema>) {
    const startsAt = new Date(input.startsAt);
    const endsAt = input.endsAt ? new Date(input.endsAt) : null;
    this.checkTimes(startsAt, endsAt);
    const name = input.name ?? presetFor(input.kind)?.defaultName;
    if (!name) throw new AppError('SET_EVENT_NAME_REQUIRED', 'A custom event needs a name', 400);
    return this.prisma.$transaction(async (tx) => {
      await this.checkVenue(tx, weddingId, input.venueId);
      const max = await tx.events.aggregate({ where: { wedding_id: weddingId, deleted_at: null }, _max: { sort_order: true } });
      const e = await tx.events.create({
        data: {
          wedding_id: weddingId,
          kind: input.kind,
          name,
          starts_at: startsAt,
          ends_at: endsAt,
          venue_id: input.venueId ?? null,
          dress_code: input.dressCode ?? presetFor(input.kind)?.dressCodeHint ?? null,
          notes: input.notes ?? null,
          sort_order: (max._max.sort_order ?? -1) + 1,
          updated_by: actor.userId,
        },
      });
      await writeAudit(tx, {
        weddingId,
        actor: { type: 'user', id: actor.userId, role: actor.role },
        action: 'event.create',
        entityType: 'event',
        entityId: e.id,
        after: toEvent(e),
        requestId: actor.requestId,
      });
      return toEvent(e);
    });
  }

  async bulkFromPresets(actor: Actor, weddingId: string, input: z.infer<typeof BulkPresetsSchema>) {
    const w = await this.prisma.weddings.findUniqueOrThrow({ where: { id: weddingId } });
    const created = [];
    for (const item of input.items) {
      const preset = EVENT_PRESETS.find((p) => p.kind === item.kind)!;
      const startsAt = zonedTimeToUtc(item.date, item.time ?? preset.defaultStart, w.timezone);
      const endsAt = new Date(startsAt.getTime() + preset.durationMinutes * 60_000);
      created.push(
        await this.createEvent(actor, weddingId, {
          kind: item.kind,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        }),
      );
    }
    return created.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  }

  async updateEvent(actor: Actor, weddingId: string, eventId: string, input: z.infer<typeof UpdateEventSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const e = await tx.events.findFirst({ where: { id: eventId, wedding_id: weddingId, deleted_at: null } });
      if (!e) throw new AppError('SET_EVENT_NOT_FOUND', 'Event not found', 404);
      await this.checkVenue(tx, weddingId, input.venueId);
      const startsAt = input.startsAt ? new Date(input.startsAt) : e.starts_at;
      const endsAt = input.endsAt === undefined ? e.ends_at : input.endsAt ? new Date(input.endsAt) : null;
      this.checkTimes(startsAt, endsAt);
      const updated = await tx.events.update({
        where: { id: eventId },
        data: {
          kind: input.kind,
          name: input.name,
          starts_at: startsAt,
          ends_at: endsAt,
          venue_id: input.venueId === undefined ? undefined : input.venueId,
          dress_code: input.dressCode === undefined ? undefined : input.dressCode,
          notes: input.notes === undefined ? undefined : input.notes,
          updated_by: actor.userId,
          updated_at: new Date(),
        },
      });
      const d = diff(toEvent(e), toEvent(updated));
      if (d.changed) {
        await writeAudit(tx, {
          weddingId,
          actor: { type: 'user', id: actor.userId, role: actor.role },
          action: 'event.update',
          entityType: 'event',
          entityId: eventId,
          before: d.before,
          after: d.after,
          requestId: actor.requestId,
        });
      }
      return toEvent(updated);
    });
  }

  async deleteEvent(actor: Actor, weddingId: string, eventId: string, restore = false) {
    return this.prisma.$transaction(async (tx) => {
      const e = await tx.events.findFirst({
        where: { id: eventId, wedding_id: weddingId, deleted_at: restore ? { not: null } : null },
      });
      if (!e) throw new AppError('SET_EVENT_NOT_FOUND', 'Event not found', 404);
      const updated = await tx.events.update({ where: { id: eventId }, data: { deleted_at: restore ? null : new Date(), updated_by: actor.userId } });
      await writeAudit(tx, {
        weddingId,
        actor: { type: 'user', id: actor.userId, role: actor.role },
        action: restore ? 'event.restore' : 'event.delete',
        entityType: 'event',
        entityId: eventId,
        requestId: actor.requestId,
      });
      return toEvent(updated);
    });
  }

  async reorderEvents(actor: Actor, weddingId: string, eventIds: string[]) {
    return this.prisma.$transaction(async (tx) => {
      const live = await tx.events.findMany({ where: { wedding_id: weddingId, deleted_at: null }, select: { id: true } });
      const liveIds = new Set(live.map((e) => e.id));
      if (eventIds.length !== liveIds.size || new Set(eventIds).size !== eventIds.length || !eventIds.every((id) => liveIds.has(id))) {
        throw new AppError('SET_ORDER_MISMATCH', 'Send every live event exactly once', 400);
      }
      for (const [i, id] of eventIds.entries()) {
        await tx.events.update({ where: { id }, data: { sort_order: i } });
      }
      await writeAudit(tx, {
        weddingId,
        actor: { type: 'user', id: actor.userId, role: actor.role },
        action: 'event.reorder',
        entityType: 'wedding',
        entityId: weddingId,
        after: { eventIds },
        requestId: actor.requestId,
      });
      const rows = await tx.events.findMany({ where: { wedding_id: weddingId, deleted_at: null }, orderBy: { sort_order: 'asc' } });
      return rows.map(toEvent);
    });
  }

  // ── venues ────────────────────────────────────────────────────────────────
  listVenues(weddingId: string) {
    return this.prisma.venues.findMany({ where: { wedding_id: weddingId }, orderBy: { name: 'asc' } }).then((r) => r.map(toVenue));
  }

  private pin(input: { mapsUrl?: string | null; lat?: number | null; lng?: number | null }) {
    if ((input.lat == null) !== (input.lng == null)) {
      throw new AppError('SET_PIN_INCOMPLETE', 'Send both latitude and longitude', 400);
    }
    if (input.lat != null) return { lat: input.lat, lng: input.lng!, placeId: undefined };
    if (input.mapsUrl) {
      const parsed = parseMapsLink(input.mapsUrl);
      if (parsed === 'host_not_allowed') throw new AppError('SET_MAPS_LINK_HOST_NOT_ALLOWED', 'Use a Google Maps or Apple Maps link', 400);
      return parsed ?? { lat: null, lng: null, placeId: undefined };
    }
    return null;
  }

  async createVenue(actor: Actor, weddingId: string, input: z.infer<typeof CreateVenueSchema>) {
    const pin = this.pin(input);
    return this.prisma.$transaction(async (tx) => {
      const v = await tx.venues.create({
        data: {
          wedding_id: weddingId,
          name: input.name,
          address: input.address ?? null,
          city: input.city ?? null,
          maps_url: input.mapsUrl ?? null,
          lat: pin?.lat ?? null,
          lng: pin?.lng ?? null,
          google_place_id: pin?.placeId ?? null,
          parking_notes: input.parkingNotes ?? null,
          notes: input.notes ?? null,
        },
      });
      await writeAudit(tx, {
        weddingId,
        actor: { type: 'user', id: actor.userId, role: actor.role },
        action: 'venue.create',
        entityType: 'venue',
        entityId: v.id,
        after: toVenue(v),
        requestId: actor.requestId,
      });
      return toVenue(v);
    });
  }

  async updateVenue(actor: Actor, weddingId: string, venueId: string, input: z.infer<typeof UpdateVenueSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const v = await tx.venues.findFirst({ where: { id: venueId, wedding_id: weddingId } });
      if (!v) throw new AppError('SET_VENUE_NOT_FOUND', 'Venue not found', 404);
      const pin = input.mapsUrl !== undefined || input.lat !== undefined ? this.pin(input) : undefined;
      const updated = await tx.venues.update({
        where: { id: venueId },
        data: {
          name: input.name,
          address: input.address,
          city: input.city,
          maps_url: input.mapsUrl,
          lat: pin === undefined ? undefined : (pin?.lat ?? null),
          lng: pin === undefined ? undefined : (pin?.lng ?? null),
          google_place_id: pin === undefined ? undefined : (pin?.placeId ?? null),
          parking_notes: input.parkingNotes,
          notes: input.notes,
          updated_at: new Date(),
        },
      });
      const d = diff(toVenue(v), toVenue(updated));
      if (d.changed) {
        await writeAudit(tx, {
          weddingId,
          actor: { type: 'user', id: actor.userId, role: actor.role },
          action: 'venue.update',
          entityType: 'venue',
          entityId: venueId,
          before: d.before,
          after: d.after,
          requestId: actor.requestId,
        });
      }
      return toVenue(updated);
    });
  }

  async deleteVenue(actor: Actor, weddingId: string, venueId: string) {
    await this.prisma.$transaction(async (tx) => {
      const v = await tx.venues.findFirst({ where: { id: venueId, wedding_id: weddingId } });
      if (!v) throw new AppError('SET_VENUE_NOT_FOUND', 'Venue not found', 404);
      await tx.venues.delete({ where: { id: venueId } }); // events.venue_id → NULL (FK)
      await writeAudit(tx, {
        weddingId,
        actor: { type: 'user', id: actor.userId, role: actor.role },
        action: 'venue.delete',
        entityType: 'venue',
        entityId: venueId,
        before: toVenue(v),
        requestId: actor.requestId,
      });
    });
  }
}
