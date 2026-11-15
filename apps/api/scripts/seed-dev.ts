import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { normalisePhone } from '@mehfil/domain';

/**
 * Dev seed (FND-15): dev users for each role, one planner org, one demo wedding with venues,
 * six events, groups and 40 parties. Sign in with the dev bypass as `dev:<email>`.
 * Re-running replaces the demo wedding. Never runs against production.
 */
export const DEMO_WEDDING_ID = '00000000-0000-4000-8000-00000000d0e0';
const DEV_USERS = [
  { email: 'owner@mehfil.local', name: 'Asha (owner)', role: 'owner' },
  { email: 'cohost@mehfil.local', name: 'Vikram (co-host)', role: 'co_host' },
  { email: 'planner@mehfil.local', name: 'Meera (planner)', role: 'planner_member' },
  { email: 'desk@mehfil.local', name: 'Ravi (desk)', role: 'desk_staff' },
] as const;

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Ishaan', 'Anika', 'Rohan', 'Saanvi', 'Arjun', 'Meera', 'Vivaan', 'Nisha', 'Kiran'];
const LAST = ['Sharma', 'Iyer', 'Reddy', 'Patil', 'Gowda', 'Nair', 'Mehta', 'Kulkarni', 'Rao', 'Hegde'];

/** IST wall-clock → UTC Date. */
const ist = (isoLocal: string) => new Date(`${isoLocal}+05:30`);
const sha256 = (s: string) => createHash('sha256').update(s).digest();

export async function seed(prisma: PrismaClient, log: (line: string) => void = () => undefined) {
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to seed in production');

  const users: { id: string }[] = [];
  for (const u of DEV_USERS) {
    users.push(
      await prisma.users.upsert({
        where: { google_sub: `dev|${u.email}` },
        update: { name: u.name },
        create: { google_sub: `dev|${u.email}`, email: u.email, name: u.name },
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
      settings: { camera: { shotLimit: 24, reveal: 'instant' } },
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
  }

  const links: string[] = [];
  for (let p = 0; p < 40; p++) {
    const last = LAST[p % LAST.length]!;
    const token = randomBytes(16).toString('base64url');
    const party = await prisma.parties.create({
      data: {
        wedding_id: wedding.id,
        label: `${last} family`,
        link_token_hash: sha256(token),
        plus_ones_allowed: p % 5 === 0 ? 1 : 0,
        is_outstation: p % 3 !== 0,
        preferred_language: p % 7 === 0 ? 'hi' : p % 11 === 0 ? 'kn' : 'en',
      },
    });
    const size = 1 + (p % 4);
    for (let g = 0; g < size; g++) {
      await prisma.guests.create({
        data: {
          wedding_id: wedding.id,
          party_id: party.id,
          is_primary: g === 0,
          full_name: `${FIRST[(p + g * 3) % FIRST.length]} ${last}`,
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
    if (p < 5) links.push(`  ${party.label.padEnd(18)} /g/${token}`);
  }

  log(`Seeded wedding "${wedding.title}" (${wedding.id}) with 6 events and 40 parties.`);
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
