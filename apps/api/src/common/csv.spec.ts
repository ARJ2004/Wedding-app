import { csvCell } from './csv';

describe('csvCell', () => {
  it.each([
    ['+919845012345', '+919845012345'],
    ['-12', '-12'],
    ['=1+1', "'=1+1"],
    ['+cmd|calc', "'+cmd|calc"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['=HYPERLINK("x")', `"'=HYPERLINK(""x"")"`],
    ['Sharma, Ravi', '"Sharma, Ravi"'],
    [null, ''],
  ])('%s → %s', (input, out) => {
    expect(csvCell(input)).toBe(out);
  });
});
