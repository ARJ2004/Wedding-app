import { createIntl, createIntlCache, type IntlShape } from '@formatjs/intl';
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import en from './catalogs/en.json';
import hi from './catalogs/hi.json';
import kn from './catalogs/kn.json';

/** Guest-facing locales. English ships at MVP; Hindi and Kannada fill in during P1 (L10N-01/02). */
export const LOCALES = ['en', 'hi', 'kn'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export type MessageId = keyof typeof en;
export type Catalog = Partial<Record<MessageId, string>>;

export const catalogs: Record<Locale, Catalog> = { en, hi, kn };

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

const cache = createIntlCache();
const intls = new Map<string, IntlShape<string>>();

/**
 * ICU formatter used by the server (lite web, push, message copy) and the app.
 * Missing translations fall back to English, never to the message id.
 */
export function getIntl(locale: Locale, timeZone = 'Asia/Kolkata'): IntlShape<string> {
  const cacheKey = `${locale}|${timeZone}`;
  let intl = intls.get(cacheKey);
  if (!intl) {
    intl = createIntl(
      {
        locale: locale === 'en' ? 'en-IN' : `${locale}-IN`,
        defaultLocale: 'en-IN',
        timeZone,
        messages: { ...catalogs.en, ...catalogs[locale] } as Record<string, string>,
        onError: () => undefined,
      },
      cache,
    );
    intls.set(cacheKey, intl);
  }
  return intl;
}

export function t(locale: Locale, id: MessageId, values?: Record<string, string | number | Date>): string {
  return getIntl(locale).formatMessage({ id }, values);
}

function argumentNames(elements: MessageFormatElement[], into = new Set<string>()): Set<string> {
  for (const el of elements) {
    if (el.type === TYPE.argument || el.type === TYPE.number || el.type === TYPE.date || el.type === TYPE.time) {
      into.add(el.value);
    } else if (el.type === TYPE.plural || el.type === TYPE.select) {
      into.add(el.value);
      for (const opt of Object.values(el.options)) argumentNames(opt.value, into);
    } else if (el.type === TYPE.tag) {
      argumentNames(el.children, into);
    }
  }
  return into;
}

/**
 * Catalogue check run in CI (FND-09): every message parses as ICU, translations only use ids
 * that exist in English, and each translation uses exactly the English placeholders.
 */
export function checkCatalogs(all: Record<string, Record<string, string>> = catalogs as never): string[] {
  const problems: string[] = [];
  const base = all.en ?? {};
  const baseArgs = new Map<string, Set<string>>();
  for (const [id, msg] of Object.entries(base)) {
    try {
      baseArgs.set(id, argumentNames(parse(msg)));
    } catch (e) {
      problems.push(`en:${id} does not parse: ${(e as Error).message}`);
    }
  }
  for (const [locale, catalog] of Object.entries(all)) {
    if (locale === 'en') continue;
    for (const [id, msg] of Object.entries(catalog)) {
      const expected = baseArgs.get(id);
      if (!expected) {
        problems.push(`${locale}:${id} is not in the English catalogue`);
        continue;
      }
      try {
        const got = argumentNames(parse(msg));
        const same = got.size === expected.size && [...got].every((a) => expected.has(a));
        if (!same) problems.push(`${locale}:${id} placeholders {${[...got]}} differ from English {${[...expected]}}`);
      } catch (e) {
        problems.push(`${locale}:${id} does not parse: ${(e as Error).message}`);
      }
    }
  }
  return problems;
}
