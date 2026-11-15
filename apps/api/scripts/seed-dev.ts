import { PrismaClient } from '@prisma/client';
import { normalisePhone } from '@mehfil/domain';
import { deriveLinkToken, linkTokenHash } from '../src/common/auth/link-token';
import { loadConfig } from '../src/config/env';
import { createWhatsAppProvider, TemplateService } from '../src/modules/messaging';
import pino from 'pino';

const LINK_KEY = process.env.LINK_TOKEN_KEY ?? 'dev-only-link-token-key-change-me-0123456789';

/**
 * Dev seed (FND-15): dev users for each role, one planner org, one demo wedding with venues,
 * six events, groups and 40 parties. Sign in with the dev bypass as `dev:<email>`.
 * Re-running replaces the demo wedding. Never runs against production.
 */
export const DEMO_WEDDING_ID = '00000000-0000-4000-8000-00000000d0e0';
const DEV_USERS = [
  { email: 'owner@mehfil.local', name: 'Asha (owner)', role: 'owner', phone: '+919000099001' },
  { email: 'cohost@mehfil.local', name: 'Vikram (co-host)', role: 'co_host' },
  { email: 'planner@mehfil.local', name: 'Meera (planner)', role: 'planner_member' },
  { email: 'desk@mehfil.local', name: 'Ravi (desk)', role: 'desk_staff' },
] as const satisfies readonly { email: string; name: string; role: string; phone?: string }[];

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Ishaan', 'Anika', 'Rohan', 'Saanvi', 'Arjun', 'Meera', 'Vivaan', 'Nisha', 'Kiran'];
const LAST = ['Sharma', 'Iyer', 'Reddy', 'Patil', 'Gowda', 'Nair', 'Mehta', 'Kulkarni', 'Rao', 'Hegde'];

/** IST wall-clock → UTC Date. */
const ist = (isoLocal: string) => new Date(`${isoLocal}+05:30`);

export async function seed(prisma: PrismaClient, log: (line: string) => void = () => undefined) {
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to seed in production');

  const users: { id: string }[] = [];
  for (const u of DEV_USERS) {
    users.push(
      await prisma.users.upsert({
        where: { google_sub: `dev|${u.email}` },
        update: { name: u.name, phone_e164: 'phone' in u ? u.phone : null },
        create: { google_sub: `dev|${u.email}`, email: u.email, name: u.name, phone_e164: 'phone' in u ? u.phone : null },
      }),
    );
  }
  const owner = users[0]!;

  await prisma.weddings.deleteMany({ where: { id: DEMO_WEDDING_ID } });
  await prisma.organizations.deleteMany({ where: { name: 'Mehfil Demo Planners' } });
  const org = await prisma.organizations.create({ data: { name: 'Mehfil Demo Planners', kind: 'planner' } });
  await prisma.organization_members.createMany({
    data: [
      { organization_id: org.id, user_id: owner.id, org_role: 'org_owner' },
      { organization_id: org.id, user_id: users[2]!.id, org_role: 'org_member' },
    ],
  });

  const wedding = await prisma.weddings.create({
    data: {
      id: DEMO_WEDDING_ID,
      organization_id: org.id,
      title: 'Ananya & Rohan',
      starts_on: new Date('2027-02-12'),
      ends_on: new Date('2027-02-14'),
      status: 'live',
      plan: 'complete',
      created_by: owner.id,
      settings: { camera: { shotLimit: 24, revealMode: 'instant' }, branding: { palette: null } },
    },
  });
  await prisma.wedding_members.createMany({
    data: DEV_USERS.map((u, i) => ({ wedding_id: wedding.id, user_id: users[i]!.id, role: u.role, invited_by: owner.id })),
  });

  const [palace, lawn] = await Promise.all([
    prisma.venues.create({
      data: { wedding_id: wedding.id, name: 'Lake Palace Ballroom', address: 'Lake Palace Rd, Udaipur', lat: 24.5754, lng: 73.68 },
    }),
    prisma.venues.create({
      data: { wedding_id: wedding.id, name: 'Garden Lawn', address: 'Lake Palace Rd, Udaipur', lat: 24.5761, lng: 73.6812 },
    }),
  ]);

  const groups = Object.fromEntries(
    await Promise.all(
      (
        [
          ['bride_side', 'Bride side'],
          ['groom_side', 'Groom side'],
          ['family', 'Family'],
          ['friends', 'Friends'],
          ['vip', 'VIP'],
        ] as const
      ).map(async ([key, name]) => [
        key,
        await prisma.guest_groups.create({ data: { wedding_id: wedding.id, name, system_key: key } }),
      ]),
    ),
  ) as Record<'bride_side' | 'groom_side' | 'family' | 'friends' | 'vip', { id: string }>;

  const events = [
    { kind: 'haldi', name: 'Haldi', at: '2027-02-12T10:00', venue: lawn, dress: 'Yellow', familyOnly: true },
    { kind: 'mehendi', name: 'Mehendi', at: '2027-02-12T16:00', venue: lawn, dress: 'Green or pastel', familyOnly: false },
    { kind: 'sangeet', name: 'Sangeet', at: '2027-02-12T19:30', venue: palace, dress: 'Indo-western', familyOnly: false },
    { kind: 'baraat', name: 'Baraat', at: '2027-02-13T17:00', venue: lawn, dress: 'Safa provided', familyOnly: false },
    { kind: 'pheras', name: 'Pheras', at: '2027-02-13T20:30', venue: palace, dress: 'Traditional', familyOnly: false },
    { kind: 'reception', name: 'Reception', at: '2027-02-14T19:00', venue: palace, dress: 'Formal', familyOnly: false },
  ] as const;
  const created: { id: string; familyOnly: boolean }[] = [];
  for (const [i, e] of events.entries()) {
    const ev = await prisma.events.create({
      data: {
        wedding_id: wedding.id,
        venue_id: e.venue.id,
        kind: e.kind,
        name: e.name,
        starts_at: ist(e.at),
        dress_code: e.dress,
        sort_order: i,
        visibility: e.familyOnly ? 'groups' : 'all',
      },
    });
    if (e.familyOnly) await prisma.event_groups.create({ data: { event_id: ev.id, group_id: groups.family.id } });
    created.push({ id: ev.id, familyOnly: e.familyOnly });
  }

  const links: string[] = [];
  for (let p = 0; p < 40; p++) {
    const last = LAST[p % LAST.length]!;
    const size = 1 + (p % 4);
    const primaryName = `${FIRST[p % FIRST.length]} ${last}`;
    const party = await prisma.parties.create({
      data: {
        wedding_id: wedding.id,
        label: size > 1 ? `${primaryName} & family` : primaryName,
        plus_ones_allowed: p % 5 === 0 ? 1 : 0,
        is_outstation: p % 3 !== 0,
        preferred_language: p % 7 === 0 ? 'hi' : p % 11 === 0 ? 'kn' : 'en',
      },
    });
    // Derived invite link (ACC-01): the same key + party id + version always rebuilds it.
    const token = deriveLinkToken(LINK_KEY, party.id, 1);
    await prisma.parties.update({ where: { id: party.id }, data: { link_token_hash: linkTokenHash(token) } });
    for (let g = 0; g < size; g++) {
      await prisma.guests.create({
        data: {
          wedding_id: wedding.id,
          party_id: party.id,
          is_primary: g === 0,
          full_name: g === 0 ? primaryName : `${FIRST[(p + g * 5 + 1) % FIRST.length]} ${last}`,
          // Fictional demo numbers, normalised exactly like a host entry (GST-04).
          ...(() => {
            const n = normalisePhone(g < 2 ? `+91 90000 ${String(p * 10 + g).padStart(5, '0')}` : null);
            return { phone_e164: n.e164, phone_status: n.status, phone_raw: n.status === 'valid' ? null : n.raw };
          })(),
          age_band: g === 3 ? 'child' : p % 6 === 0 && g === 1 ? 'senior' : 'adult',
        },
      });
    }
    const side = p % 2 === 0 ? groups.bride_side : groups.groom_side;
    const kind = p < 12 ? groups.family : groups.friends;
    await prisma.party_groups.createMany({ data: [{ party_id: party.id, group_id: side.id }, { party_id: party.id, group_id: kind.id }] });
    if (p < 3) await prisma.party_groups.create({ data: { party_id: party.id, group_id: groups.vip.id } });
    // Demo answers (RSV-03): about 60% of families have replied for the open events.
    if (p % 5 < 3) {
      const members = await prisma.guests.findMany({ where: { party_id: party.id }, select: { id: true } });
      const status = p % 7 === 0 ? 'declined' : p % 4 === 0 ? 'maybe' : 'attending';
      for (const ev of created.filter((x) => !x.familyOnly)) {
        await prisma.rsvps.createMany({ data: members.map((m) => ({ wedding_id: wedding.id, event_id: ev.id, party_id: party.id, guest_id: m.id, status, source: 'app', responded_by_guest_id: members[0]!.id })) });
      }
      const diets = ['veg', 'jain', 'non_veg', 'veg', 'eggetarian'] as const;
      await prisma.guest_dietary.createMany({ data: members.map((m, i) => ({ guest_id: m.id, wedding_id: wedding.id, diet: diets[(p + i) % diets.length]!, allergies: (p + i) % 6 === 0 ? ['nuts'] : [] })) });
    }
    if (p < 5) links.push(`  ${party.label.padEnd(18)} /g/${token}`);
  }

  // One family with a dead number, so failed deliveries show up in dev (log sink fails *99999).
  const oldParty = await prisma.parties.create({ data: { wedding_id: wedding.id, label: 'Suresh Old-number', is_outstation: false } });
  await prisma.parties.update({ where: { id: oldParty.id }, data: { link_token_hash: linkTokenHash(deriveLinkToken(LINK_KEY, oldParty.id, 1)) } });
  const dead = normalisePhone('+91 90000 99999');
  await prisma.guests.create({ data: { wedding_id: wedding.id, party_id: oldParty.id, is_primary: true, full_name: 'Suresh Menon', phone_e164: dead.e164, phone_status: dead.status } });
  await prisma.party_groups.create({ data: { party_id: oldParty.id, group_id: groups.friends.id } });

  // Message templates (MSG-02); the dev log sink approves them straight away.
  await new TemplateService(prisma, createWhatsAppProvider(loadConfig(), prisma), pino({ level: 'silent' })).syncCatalogue();

  log(`Seeded wedding "${wedding.title}" (${wedding.id}) with 6 events and 41 parties.`);
  log('Dev sign-in (DEV_AUTH_ENABLED=true): ' + DEV_USERS.map((u) => `dev:${u.email}`).join(', '));
  log('Sample guest links (OTP 000000 in dev):');
  for (const l of links) log(l);
  return { weddingId: wedding.id };
}

if (require.main === module) {
  const prisma = new PrismaClient();
  seed(prisma, (line) => process.stdout.write(`${line}\n`))
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
}
