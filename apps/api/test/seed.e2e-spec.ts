import { seed, DEMO_WEDDING_ID } from '../scripts/seed-dev';
import { closePrisma, testPrisma } from './helpers';

afterAll(closePrisma);

describe('dev seed (FND-15)', () => {
  it('creates the demo wedding and is safe to re-run', async () => {
    const prisma = testPrisma();
    await seed(prisma);
    await seed(prisma);
    expect(await prisma.weddings.count({ where: { id: DEMO_WEDDING_ID } })).toBe(1);
    expect(await prisma.events.count({ where: { wedding_id: DEMO_WEDDING_ID } })).toBe(6);
    expect(await prisma.parties.count({ where: { wedding_id: DEMO_WEDDING_ID } })).toBe(40);
    expect(await prisma.wedding_members.count({ where: { wedding_id: DEMO_WEDDING_ID } })).toBe(4);
    const haldi = await prisma.events.findFirstOrThrow({ where: { wedding_id: DEMO_WEDDING_ID, kind: 'haldi' } });
    expect(haldi.visibility).toBe('groups');
    expect(haldi.starts_at.toISOString()).toBe('2027-02-12T04:30:00.000Z'); // 10:00 IST
    const primaries = await prisma.guests.count({ where: { wedding_id: DEMO_WEDDING_ID, is_primary: true } });
    expect(primaries).toBe(40);
  });
});
