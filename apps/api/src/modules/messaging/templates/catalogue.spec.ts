import { CATALOGUE, checkCatalogue } from './catalogue';

describe('template catalogue (MSG-02)', () => {
  it('is valid', () => {
    expect(checkCatalogue()).toEqual([]);
  });

  it('catches placeholder and example mismatches', () => {
    const bad = structuredClone(CATALOGUE.slice(0, 1));
    bad[0]!.variants[0]!.body = 'Hi {{1}} and {{3}}';
    bad[0]!.variants[0]!.examples = ['x'];
    expect(checkCatalogue(bad)).toEqual([
      'invite/en: placeholders 1,3 ≠ params 1..3',
      'invite/en: needs one example per param',
    ]);
  });
});
