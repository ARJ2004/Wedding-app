import type { Prisma, PrismaClient, guests, parties } from '@prisma/client';
import { can, normalisePhone, type WeddingRole } from '@mehfil/domain';
import type { z } from 'zod';
import { csvRow } from '../../common/csv';
import { AppError } from '../../common/errors';
import { diff, writeAudit } from '../audit';
import type { AddGuestSchema, CreatePartySchema, ListPartiesQuery, UpdateGuestSchema, UpdatePartySchema } from './schemas';

export interface Actor {
  userId: string;
  role: WeddingRole;
  requestId?: string;
}

type PartyRow = parties & { guests: guests[]; party_groups: { group_id: string }[] };

/** Field-level masking (10-rol §4.2): roles without guest.contact.read get names only. */
export function toGuest(g: guests, role: WeddingRole) {
  const base = {
    id: g.id,
    fullName: g.full_name,
    isPrimary: g.is_primary,
    isPlusOne: g.is_plus_one,
    ageBand: g.age_band as 'child' | 'adult' | 'senior' | null,
  };
  if (!can(role, 'guest.contact.read')) return base;
  return {
    ...base,
    phone: g.phone_e164,
    phoneStatus: g.phone_status as 'valid' | 'invalid' | 'missing' | 'landline',
    phoneRaw: g.phone_raw,
    email: g.email,
    relation: g.relation,
    notes: g.notes,
  };
}

export function toParty(p: PartyRow, role: WeddingRole) {
  const contact = can(role, 'guest.contact.read');
  const members = p.guests
    .filter((g) => !g.deleted_at)
    // Primary first, then adults, then children; creation order within each.
    .sort(
      (a, b) =>
        Number(b.is_primary) - Number(a.is_primary) ||
        Number(a.age_band === 'child') - Number(b.age_band === 'child') ||
        a.created_at.getTime() - b.created_at.getTime(),
    )
    .map((g) => toGuest(g, role));
  return {
    id: p.id,
    label: p.label,
    plusOnesAllowed: p.plus_ones_allowed,
    isOutstation: p.is_outstation,
    preferredLanguage: p.preferred_language,
    ...(contact ? { city: p.city, notes: p.notes } : {}),
    groupIds: p.party_groups.map((g) => g.group_id),
    members,
  };
}

function phoneFields(phone: string | null | undefined) {
  if (phone === undefined) return {};
  const n = normalisePhone(phone);
  return { phone_e164: n.e164, phone_status: n.status, phone_raw: n.status === 'valid' ? null : n.raw };
}

const PARTY_INCLUDE = { guests: true, party_groups: { select: { group_id: true } } } as const;

export class GuestsService {
  constructor(
    private readonly prisma: PrismaClient,
    /** Builds parties.link_token_hash for a new party (ACC-01). */
    private readonly linkHash: (partyId: string) => Buffer,
  ) {}

  private async checkGroups(db: Prisma.TransactionClient, weddingId: string, groupIds: string[]) {
    if (groupIds.length === 0) return;
    const n = await db.guest_groups.count({ where: { wedding_id: weddingId, id: { in: groupIds } } });
    if (n !== new Set(groupIds).size) throw new AppError('GST_GROUP_NOT_FOUND', 'Group not found in this wedding', 400);
  }

  private async loadParty(db: Prisma.TransactionClient | PrismaClient, weddingId: string, partyId: string) {
    const p = await db.parties.findFirst({ where: { id: partyId, wedding_id: weddingId, deleted_at: null }, include: PARTY_INCLUDE });
    if (!p) throw new AppError('GST_PARTY_NOT_FOUND', 'Party not found', 404);
    return p;
  }

  async list(weddingId: string, role: WeddingRole, query: z.infer<typeof ListPartiesQuery>) {
    const where: Prisma.partiesWhereInput = { wedding_id: weddingId, deleted_at: null };
    if (query.groupId) where.party_groups = { some: { group_id: query.groupId } };
    if (query.phoneStatus) {
      if (!can(role, 'guest.contact.read')) throw new AppError('ROL_FORBIDDEN', 'Your role cannot filter by phone', 403);
      where.guests = { some: { deleted_at: null, phone_status: query.phoneStatus } };
    }
    if (query.q) {
      const digits = query.q.replace(/\D/g, '');
      const or: Prisma.partiesWhereInput[] = [
        { label: { contains: query.q, mode: 'insensitive' } },
        { guests: { some: { deleted_at: null, full_name: { contains: query.q, mode: 'insensitive' } } } },
      ];
      if (digits.length >= 4 && can(role, 'guest.contact.read')) {
        or.push({ guests: { some: { deleted_at: null, phone_e164: { endsWith: digits } } } });
      }
      where.OR = or;
    }
    const rows = await this.prisma.parties.findMany({
      where,
      include: PARTY_INCLUDE,
      orderBy: [{ label: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, query.limit);
    return { items: page.map((p) => toParty(p, role)), nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null };
  }

  get(weddingId: string, role: WeddingRole, partyId: string) {
    return this.loadParty(this.prisma, weddingId, partyId).then((p) => toParty(p, role));
  }

  async create(actor: Actor, weddingId: string, input: z.infer<typeof CreatePartySchema>) {
    const primaries = input.members.filter((m) => m.isPrimary).length;
    if (primaries > 1) throw new AppError('GST_PRIMARY_REQUIRED', 'A party has exactly one primary guest', 400);
    const members = input.members.map((m, i) => ({ ...m, isPrimary: primaries === 0 ? i === 0 : Boolean(m.isPrimary) }));
    const primary = members.find((m) => m.isPrimary)!;
    return this.prisma.$transaction(async (tx) => {
      await this.checkGroups(tx, weddingId, input.groupIds);
      const party = await tx.parties.create({
        data: {
          wedding_id: weddingId,
          label: input.label ?? primary.fullName,
          plus_ones_allowed: input.plusOnesAllowed,
          is_outstation: input.isOutstation,
          preferred_language: input.preferredLanguage,
          city: input.city ?? null,
          notes: input.notes ?? null,
          source: 'manual',
          updated_by: actor.userId,
        },
      });
      await tx.parties.update({ where: { id: party.id }, data: { link_token_hash: this.linkHash(party.id) } });
      for (const m of members) {
        await tx.guests.create({
          data: {
            wedding_id: weddingId,
            party_id: party.id,
            full_name: m.fullName,
            is_primary: m.isPrimary,
            is_plus_one: Boolean(m.isPlusOne),
            age_band: m.ageBand ?? null,
            email: m.email ?? null,
            relation: m.relation ?? null,
            notes: m.notes ?? null,
            updated_by: actor.userId,
            ...phoneFields(m.phone ?? null),
          },
        });
      }
      if (input.groupIds.length) {
        await tx.party_groups.createMany({ data: input.groupIds.map((group_id) => ({ party_id: party.id, group_id })) });
      }
      await writeAudit(tx, {
        weddingId,
        actor: { type: 'user', id: actor.userId, role: actor.role },
        action: 'party.create',
        entityType: 'party',
        entityId: party.id,
        after: { label: party.label, members: members.length },
        requestId: actor.requestId,
      });
      return toParty(await this.loadParty(tx, weddingId, party.id), actor.role);
    });
  }

  async update(actor: Actor, weddingId: string, partyId: string, input: z.infer<typeof UpdatePartySchema>) {
    return this.prisma.$transaction(async (tx) => {
      const p = await this.loadParty(tx, weddingId, partyId);
      if (input.groupIds) {
        await this.checkGroups(tx, weddingId, input.groupIds);
        await tx.party_groups.deleteMany({ where: { party_id: partyId } });
        await tx.party_groups.createMany({ data: input.groupIds.map((group_id) => ({ party_id: partyId, group_id })) });
      }
      await tx.parties.update({
        where: { id: partyId },
        data: {
          label: input.label,
          plus_ones_allowed: input.plusOnesAllowed,
          is_outstation: input.isOutstation,
          preferred_language: input.preferredLanguage,
          city: input.city,
          notes: input.notes,
          updated_by: actor.userId,
          updated_at: new Date(),
        },
      });
      const after = await this.loadParty(tx, weddingId, partyId);
      const d = diff(toParty(p, 'owner'), toParty(after, 'owner'));
      if (d.changed) {
        await writeAudit(tx, {
          weddingId,
          actor: { type: 'user', id: actor.userId, role: actor.role },
          action: 'party.update',
          entityType: 'party',
          entityId: partyId,
          before: { ...d.before, members: undefined },
          after: { ...d.after, members: undefined },
          requestId: actor.requestId,
        });
      }
      return toParty(after, actor.role);
    });
  }

  async remove(actor: Actor, weddingId: string, partyId: string) {
    await this.prisma.$transaction(async (tx) => {
      const p = await this.loadParty(tx, weddingId, partyId);
      const now = new Date();
      await tx.guests.updateMany({ where: { party_id: partyId, deleted_at: null }, data: { deleted_at: now } });
      await tx.parties.update({ where: { id: partyId }, data: { deleted_at: now, link_token_hash: null, updated_by: actor.userId } });
      await writeAudit(tx, {
        weddingId,
        actor: { type: 'user', id: actor.userId, role: actor.role },
        action: 'party.delete',
        entityType: 'party',
        entityId: partyId,
        before: { label: p.label },
        requestId: actor.requestId,
      });
    });
  }

  async addGuest(actor: Actor, weddingId: string, partyId: string, input: z.infer<typeof AddGuestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await this.loadParty(tx, weddingId, partyId);
      const g = await tx.guests.create({
        data: {
          wedding_id: weddingId,
          party_id: partyId,
          full_name: input.fullName,
          is_primary: false,
          is_plus_one: Boolean(input.isPlusOne),
          age_band: input.ageBand ?? null,
          email: input.email ?? null,
          relation: input.relation ?? null,
          notes: input.notes ?? null,
          updated_by: actor.userId,
          ...phoneFields(input.phone ?? null),
        },
      });
      await writeAudit(tx, {
        weddingId,
        actor: { type: 'user', id: actor.userId, role: actor.role },
        action: 'guest.create',
        entityType: 'guest',
        entityId: g.id,
        after: { partyId, fullName: g.full_name },
        requestId: actor.requestId,
      });
      return toParty(await this.loadParty(tx, weddingId, partyId), actor.role);
    });
  }

  private async loadGuest(db: Prisma.TransactionClient, weddingId: string, guestId: string) {
    const g = await db.guests.findFirst({ where: { id: guestId, wedding_id: weddingId, deleted_at: null } });
    if (!g) throw new AppError('GST_GUEST_NOT_FOUND', 'Guest not found', 404);
    return g;
  }

  async updateGuest(actor: Actor, weddingId: string, guestId: string, input: z.infer<typeof UpdateGuestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const g = await this.loadGuest(tx, weddingId, guestId);
      if (input.isPrimary === false && g.is_primary) {
        throw new AppError('GST_PRIMARY_REQUIRED', 'Make another member primary instead', 400);
      }
      if (input.isPrimary && !g.is_primary) {
        await tx.guests.updateMany({ where: { party_id: g.party_id, is_primary: true }, data: { is_primary: false } });
      }
      const updated = await tx.guests.update({
        where: { id: guestId },
        data: {
          full_name: input.fullName,
          is_primary: input.isPrimary,
          is_plus_one: input.isPlusOne,
          age_band: input.ageBand,
          email: input.email,
          relation: input.relation,
          notes: input.notes,
          updated_by: actor.userId,
          updated_at: new Date(),
          ...phoneFields(input.phone),
        },
      });
      const d = diff(toGuest(g, 'owner'), toGuest(updated, 'owner'));
      if (d.changed) {
        await writeAudit(tx, {
          weddingId,
          actor: { type: 'user', id: actor.userId, role: actor.role },
          action: 'guest.update',
          entityType: 'guest',
          entityId: guestId,
          before: d.before,
          after: d.after,
          requestId: actor.requestId,
        });
      }
      return toParty(await this.loadParty(tx, weddingId, g.party_id), actor.role);
    });
  }

  async removeGuest(actor: Actor, weddingId: string, guestId: string) {
    return this.prisma.$transaction(async (tx) => {
      const g = await this.loadGuest(tx, weddingId, guestId);
      if (g.is_primary) throw new AppError('GST_PRIMARY_REQUIRED', 'Make another member primary before removing this one', 400);
      await tx.guests.update({ where: { id: guestId }, data: { deleted_at: new Date(), updated_by: actor.userId } });
      await writeAudit(tx, {
        weddingId,
        actor: { type: 'user', id: actor.userId, role: actor.role },
        action: 'guest.delete',
        entityType: 'guest',
        entityId: guestId,
        before: { fullName: g.full_name },
        requestId: actor.requestId,
      });
      return toParty(await this.loadParty(tx, weddingId, g.party_id), actor.role);
    });
  }

  /**
   * GST-07a export: one row per guest. Roles without guest.contact.read never reach this route
   * (guest.export). Cells are guarded against CSV/formula injection.
   */
  async exportCsv(weddingId: string): Promise<string> {
    const parties = await this.prisma.parties.findMany({
      where: { wedding_id: weddingId, deleted_at: null },
      include: { guests: { where: { deleted_at: null } }, party_groups: { include: { guest_groups: { select: { name: true } } } } },
      orderBy: [{ label: 'asc' }],
    });
    const header = ['Party', 'Name', 'Primary', 'Phone', 'Phone status', 'Email', 'Age', 'Relation', 'Groups', 'City', 'Travelling', 'Language', 'Plus-ones'];
    const lines = [csvRow(header)];
    for (const p of parties) {
      const groups = p.party_groups.map((g) => g.guest_groups.name).join('; ');
      const members = [...p.guests].sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.created_at.getTime() - b.created_at.getTime());
      for (const g of members) {
        lines.push(
          csvRow([p.label, g.full_name, g.is_primary ? 'yes' : '', g.phone_e164 ?? g.phone_raw, g.phone_status, g.email, g.age_band, g.relation, groups, p.city, p.is_outstation ? 'yes' : '', p.preferred_language, g.is_primary ? p.plus_ones_allowed : '']),
        );
      }
    }
    return `\uFEFF${lines.join('\n')}\n`; // BOM so Excel opens Hindi/Kannada names correctly
  }

  async groups(weddingId: string) {
    const rows = await this.prisma.$queryRaw<
      { id: string; name: string; system_key: string | null; colour: string | null; party_count: bigint }[]
    >`SELECT g.id, g.name, g.system_key, g.colour,
             count(p.id) FILTER (WHERE p.deleted_at IS NULL) AS party_count
      FROM guest_groups g
      LEFT JOIN party_groups pg ON pg.group_id = g.id
      LEFT JOIN parties p ON p.id = pg.party_id
      WHERE g.wedding_id = ${weddingId}::uuid
      GROUP BY g.id ORDER BY g.sort_order, g.name`;
    return rows.map((r) => ({ id: r.id, name: r.name, systemKey: r.system_key, colour: r.colour, partyCount: Number(r.party_count) }));
  }
}
