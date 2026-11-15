import { checkCatalogs, getIntl, isLocale, t } from './index';

describe('i18n', () => {
  it('formats ICU plurals and arguments', () => {
    expect(t('en', 'guest.home.eventsCount', { count: 1 })).toBe('1 event for you');
    expect(t('en', 'guest.home.eventsCount', { count: 4 })).toBe('4 events for you');
    expect(t('en', 'guest.travel.runningLate', { minutes: 25 })).toBe('Running late by 25 minutes');
  });

  it('falls back to English when a translation is missing', () => {
    expect(t('hi', 'guest.travel.landed')).toBe("I've landed");
  });

  it('formats times in the wedding timezone', () => {
    const intl = getIntl('en', 'Asia/Kolkata');
    expect(intl.formatTime(new Date('2027-02-14T13:00:00Z'), { hour: 'numeric', minute: '2-digit' })).toMatch(/6:30\s?pm/i);
  });

  it('knows its locales', () => {
    expect(isLocale('kn')).toBe(true);
    expect(isLocale('fr')).toBe(false);
  });

  it('the shipped catalogues pass the CI check', () => {
    expect(checkCatalogs()).toEqual([]);
  });

  it('catches unknown ids, broken ICU and mismatched placeholders', () => {
    const problems = checkCatalogs({
      en: { a: 'Hello {name}', b: 'ok' },
      hi: { a: 'नमस्ते {naam}', c: 'extra', b: 'broken {' },
    });
    expect(problems).toEqual([
      'hi:a placeholders {naam} differ from English {name}',
      'hi:c is not in the English catalogue',
      expect.stringMatching(/^hi:b does not parse/),
    ]);
  });
});
