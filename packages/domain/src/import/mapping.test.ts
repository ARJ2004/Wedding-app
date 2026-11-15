import { ImportMapping, normaliseRow, rowStatus, suggestMapping } from './mapping';

describe('suggestMapping', () => {
  it('understands English and Hinglish headers', () => {
    expect(suggestMapping(['S.No', 'Naam', 'Mobile No.', 'Family', 'Ladke wale / Ladki wale', 'Pax', 'City']).columns).toEqual({
      'S.No': 'ignore',
      Naam: 'fullName',
      'Mobile No.': 'phone',
      Family: 'partyLabel',
      'Ladke wale / Ladki wale': 'side',
      Pax: 'adults',
      City: 'city',
    });
  });

  it('groups by family column when there is no members column', () => {
    expect(suggestMapping(['Name', 'Phone', 'Family']).partyMode).toBe('group_by_column');
    expect(suggestMapping(['Name', 'Phone', 'Members']).partyMode).toBe('row_is_party');
  });
});

describe('normaliseRow', () => {
  const mapping = ImportMapping.parse({
    columns: { Name: 'fullName', Mobile: 'phone', With: 'members', Side: 'side', Kids: 'children', Outstation: 'isOutstation' },
    partyMode: 'row_is_party',
  });

  it('builds a party from one messy row', () => {
    const row = normaliseRow({ Name: 'Ravi Sharma', Mobile: '098450 12345', With: 'Anita & 2 kids', Side: 'Ladki wale', Kids: '', Outstation: 'Yes' }, mapping, 2);
    expect(row.primary).toMatchObject({ fullName: 'Ravi Sharma', phoneE164: '+919845012345', phoneStatus: 'valid' });
    expect(row.extraMembers.map((m) => [m.fullName, m.ageBand])).toEqual([['Anita', null], ['Child 1', 'child'], ['Child 2', 'child']]);
    expect(row.side).toBe('bride_side');
    expect(row.isOutstation).toBe(true);
    expect(rowStatus(row, false)).toBe('ok');
  });

  it('flags missing names as errors and bad phones as warnings', () => {
    const noName = normaliseRow({ Name: '', Mobile: '98450 12345' }, mapping, 3);
    expect(rowStatus(noName, false)).toBe('error');
    const badPhone = normaliseRow({ Name: 'Mausi', Mobile: '12345' }, mapping, 4);
    expect(badPhone.issues).toEqual([{ field: 'phone', code: 'PHONE_INVALID' }]);
    expect(rowStatus(badPhone, false)).toBe('warning');
    expect(rowStatus(badPhone, true)).toBe('duplicate');
  });

  it('uses the family column as the party key in group mode', () => {
    const m = ImportMapping.parse({ columns: { Name: 'fullName', Family: 'partyLabel' }, partyMode: 'group_by_column' });
    expect(normaliseRow({ Name: 'A', Family: 'Sharma Family' }, m, 2).partyKey).toBe('sharma family');
  });
});
