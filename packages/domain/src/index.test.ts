import { ACTIONS, can, canAssign, MATRIX, normalisePhone, zonedTimeToUtc, isValidTimeZone, EVENT_PRESETS } from './index';

describe('permission matrix (ROL-02a)', () => {
  it('owner can do every host action; co-host cannot delete the wedding or view IDs', () => {
    expect(can('owner', 'wedding.delete')).toBe(true);
    expect(can('co_host', 'wedding.delete')).toBe(false);
    expect(can('co_host', 'idv.view')).toBe(false);
    expect(can('planner_member', 'billing.manage')).toBe(true);
    expect(can('planner_member', 'privacy.delete_guest')).toBe(false);
  });

  it('desk staff never get contact details, messages or ID copies', () => {
    for (const a of ['guest.contact.read', 'message.read', 'message.send', 'idv.view', 'guest.write'] as const) {
      expect(can('desk_staff', a)).toBe(false);
    }
    expect(can('desk_staff', 'arrival.checkin')).toBe(true);
  });

  it('guests only get self actions plus upload and gallery', () => {
    for (const a of MATRIX.guest) expect(a.endsWith('.self') || a === 'media.upload' || a === 'gallery.read').toBe(true);
  });

  it('no host role holds a .self action', () => {
    for (const role of ['owner', 'co_host', 'planner_member', 'desk_staff'] as const) {
      for (const a of ACTIONS.filter((x) => x.endsWith('.self'))) expect(can(role, a)).toBe(false);
    }
  });

  it('roles can only grant roles below them', () => {
    expect(canAssign('owner', 'co_host')).toBe(true);
    expect(canAssign('co_host', 'co_host')).toBe(false);
    expect(canAssign('planner_member', 'desk_staff')).toBe(true);
    expect(canAssign('desk_staff', 'desk_staff')).toBe(false);
  });
});

describe('normalisePhone (GST-04)', () => {
  it.each([
    ['98450 12345', '+919845012345'],
    ['09845012345', '+919845012345'],
    ['919845012345', '+919845012345'],
    ['+91-98450-12345', '+919845012345'],
    ['0091 98450 12345', '+919845012345'],
    ['+1 (415) 555-2671', '+14155552671'],
  ])('%s → %s', (raw, e164) => {
    expect(normalisePhone(raw)).toEqual({ status: 'valid', e164, raw: raw.trim() });
  });

  it('marks landlines, invalid and missing numbers', () => {
    expect(normalisePhone('080 2222 3333').status).toBe('landline');
    expect(normalisePhone('12345')).toEqual({ status: 'invalid', e164: null, raw: '12345' });
    expect(normalisePhone('  ')).toEqual({ status: 'missing', e164: null, raw: null });
  });
});

describe('time helpers', () => {
  it('converts IST wall-clock to UTC', () => {
    expect(zonedTimeToUtc('2027-02-12', '10:00', 'Asia/Kolkata').toISOString()).toBe('2027-02-12T04:30:00.000Z');
  });

  it('handles a DST zone', () => {
    expect(zonedTimeToUtc('2027-07-01', '18:00', 'Europe/London').toISOString()).toBe('2027-07-01T17:00:00.000Z');
  });

  it('validates IANA zones', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });

  it('has the six classic presets', () => {
    expect(EVENT_PRESETS.map((p) => p.kind)).toEqual(['haldi', 'mehendi', 'sangeet', 'baraat', 'pheras', 'reception']);
  });
});
