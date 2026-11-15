import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

export type PhoneStatus = 'valid' | 'invalid' | 'missing' | 'landline';

export interface NormalisedPhone {
  status: PhoneStatus;
  /** E.164 when status is valid or landline; null otherwise. */
  e164: string | null;
  /** What the host typed, trimmed; kept so an invalid number can be fixed later. */
  raw: string | null;
}

/**
 * GST-04 phone normalisation. Handles Indian habits: 10-digit mobiles, a leading 0,
 * `91…` without the plus, `0091…`, spaces/dashes/brackets, and international numbers.
 */
export function normalisePhone(input: string | null | undefined, defaultCountry: CountryCode = 'IN'): NormalisedPhone {
  const raw = input?.trim() ? input.trim() : null;
  if (!raw) return { status: 'missing', e164: null, raw: null };

  let candidate = raw.replace(/[\s().-]/g, '');
  if (candidate.startsWith('00')) candidate = `+${candidate.slice(2)}`;
  if (/^91\d{10}$/.test(candidate)) candidate = `+${candidate}`;
  if (/^0\d{10}$/.test(candidate) && defaultCountry === 'IN') candidate = candidate.slice(1);

  const parsed = parsePhoneNumberFromString(candidate, defaultCountry);
  if (!parsed || !parsed.isValid()) return { status: 'invalid', e164: null, raw };
  const type = parsed.getType();
  const status: PhoneStatus = type === 'FIXED_LINE' ? 'landline' : 'valid';
  return { status, e164: parsed.number, raw };
}

/** "+91 98450 12345" style for display; host screens only (desk staff never get phones). */
export function formatPhone(e164: string): string {
  return parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;
}
