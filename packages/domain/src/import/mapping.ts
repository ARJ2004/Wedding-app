import { z } from 'zod';
import { normalisePhone, type PhoneStatus } from '../phone';

/** GST-02 import mapping (04-gst §3). */
export const ImportField = z.enum([
  'fullName', 'firstName', 'lastName', 'phone', 'altPhone', 'email', 'partyLabel', 'partyKey',
  'members', 'plusOnes', 'adults', 'children', 'groups', 'side', 'city', 'isOutstation', 'language',
  'relation', 'ageBand', 'notes', 'ignore',
]);
export type ImportField = z.infer<typeof ImportField>;

export const ImportMapping = z.object({
  sheetName: z.string().optional(),
  headerRow: z.number().int().min(1).max(20).default(1),
  columns: z.record(z.string(), ImportField),
  partyMode: z.enum(['row_is_party', 'group_by_column']),
  defaultRegion: z.string().length(2).default('IN'),
  createMissingGroups: z.boolean().default(true),
});
export type ImportMapping = z.infer<typeof ImportMapping>;

/** Header synonyms, English + Hinglish, lower-cased with punctuation stripped. */
const SYNONYMS: [ImportField, string[]][] = [
  ['fullName', ['name', 'full name', 'guest', 'guest name', 'naam', 'invitee']],
  ['firstName', ['first name', 'first']],
  ['lastName', ['last name', 'surname', 'last']],
  ['phone', ['phone', 'mobile', 'mob', 'mobile no', 'mobile number', 'contact', 'contact no', 'whatsapp', 'whatsapp no', 'number', 'cell']],
  ['altPhone', ['alt phone', 'alternate', 'alternate number', 'phone 2', 'mobile 2']],
  ['email', ['email', 'e mail', 'mail']],
  ['partyLabel', ['family', 'family name', 'household', 'party', 'group name', 'invite']],
  ['partyKey', ['family id', 'party id', 'household id']],
  ['members', ['members', 'family members', 'with']],
  ['plusOnes', ['plus ones', 'plus one', '+1', 'pax extra']],
  ['adults', ['adults', 'pax', 'count', 'no of guests', 'guests']],
  ['children', ['children', 'kids', 'bacche']],
  ['groups', ['groups', 'tags', 'category']],
  ['side', ['side', 'bride groom', 'bride or groom', 'from', 'ladke wale ladki wale', 'relation side']],
  ['city', ['city', 'from city', 'town', 'place']],
  ['isOutstation', ['outstation', 'travelling', 'out of town']],
  ['language', ['language', 'bhasha']],
  ['relation', ['relation', 'relationship', 'rishta']],
  ['notes', ['notes', 'remarks', 'comments']],
  ['ignore', ['s no', 'sno', 'sr no', 'serial', '#']],
];

const clean = (h: string) => h.toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();

export function suggestMapping(headers: string[]): Pick<ImportMapping, 'columns' | 'partyMode'> {
  const columns: Record<string, ImportField> = {};
  const used = new Set<ImportField>();
  for (const h of headers) {
    const c = clean(h);
    const hit = SYNONYMS.find(([field, words]) => (!used.has(field) || field === 'ignore') && words.includes(c));
    const field = hit?.[0] ?? 'ignore';
    columns[h] = field;
    if (field !== 'ignore') used.add(field);
  }
  const groupBy = Object.values(columns).some((f) => f === 'partyKey') || (Object.values(columns).includes('partyLabel') && !Object.values(columns).includes('members'));
  return { columns, partyMode: groupBy ? 'group_by_column' : 'row_is_party' };
}

export interface ImportIssue {
  field: string;
  code: 'NAME_MISSING' | 'PHONE_INVALID' | 'PHONE_MISSING' | 'DUPLICATE_IN_FILE' | 'SIDE_UNKNOWN';
}

export interface NormalisedMember {
  fullName: string;
  phoneE164: string | null;
  phoneStatus: PhoneStatus;
  phoneRaw: string | null;
  email: string | null;
  ageBand: 'child' | 'adult' | 'senior' | null;
  relation: string | null;
}

export interface NormalisedRow {
  partyKey: string;
  partyLabel: string | null;
  primary: NormalisedMember;
  extraMembers: NormalisedMember[];
  plusOnes: number;
  groups: string[];
  side: 'bride_side' | 'groom_side' | null;
  city: string | null;
  isOutstation: boolean | null;
  language: 'en' | 'hi' | 'kn' | null;
  notes: string | null;
  issues: ImportIssue[];
}

const BRIDE = /\b(bride|ladki|ladkiwale|ladki wale|girl)\b/i;
const GROOM = /\b(groom|ladka|ladke|ladkewale|ladke wale|boy)\b/i;
const YES = /^(y|yes|true|1|haan|ha)$/i;

const intOf = (v: string | undefined) => {
  const n = parseInt((v ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? Math.min(n, 20) : 0;
};

function member(name: string, phone: string | undefined, extra: Partial<NormalisedMember> = {}): NormalisedMember {
  const p = normalisePhone(phone ?? null);
  return { fullName: name, phoneE164: p.e164, phoneStatus: p.status, phoneRaw: p.raw, email: null, ageBand: null, relation: null, ...extra };
}

/**
 * Applies a mapping to one raw row. Pure: no I/O, so it is unit-tested with real messy sheets.
 * "members" cells like "Anita, Rohan & 2 kids" become extra members; a children count becomes
 * "Child n" placeholders the host can rename.
 */
export function normaliseRow(raw: Record<string, string>, mapping: ImportMapping, rowNumber: number): NormalisedRow {
  const by: Partial<Record<ImportField, string>> = {};
  for (const [header, field] of Object.entries(mapping.columns)) {
    if (field === 'ignore') continue;
    const v = (raw[header] ?? '').toString().trim();
    if (v && by[field] === undefined) by[field] = v;
  }
  const issues: ImportIssue[] = [];
  const name = by.fullName ?? [by.firstName, by.lastName].filter(Boolean).join(' ');
  if (!name) issues.push({ field: 'fullName', code: 'NAME_MISSING' });
  const primary = member(name || `Row ${rowNumber}`, by.phone ?? by.altPhone, {
    email: by.email ?? null,
    relation: by.relation ?? null,
  });
  if (primary.phoneStatus === 'invalid') issues.push({ field: 'phone', code: 'PHONE_INVALID' });
  if (primary.phoneStatus === 'missing') issues.push({ field: 'phone', code: 'PHONE_MISSING' });

  const extraMembers: NormalisedMember[] = [];
  let children = intOf(by.children);
  if (by.members) {
    for (const part of by.members.split(/,|&|\band\b|\+/i).map((s) => s.trim()).filter(Boolean)) {
      const kids = /^(\d+)\s*(kids?|children|child|bacche)$/i.exec(part);
      if (kids) children += Number(kids[1]);
      else if (part.toLowerCase() !== name.toLowerCase()) extraMembers.push(member(part, undefined));
    }
  }
  const adults = intOf(by.adults);
  for (let i = extraMembers.length + 1; i < adults; i++) extraMembers.push(member(`Guest ${i + 1} of ${name || 'party'}`, undefined));
  for (let i = 0; i < children; i++) extraMembers.push(member(`Child ${i + 1}`, undefined, { ageBand: 'child' }));

  let side: NormalisedRow['side'] = null;
  if (by.side) {
    if (BRIDE.test(by.side)) side = 'bride_side';
    else if (GROOM.test(by.side)) side = 'groom_side';
    else issues.push({ field: 'side', code: 'SIDE_UNKNOWN' });
  }
  const language = by.language ? (/hin/i.test(by.language) ? 'hi' : /kan/i.test(by.language) ? 'kn' : /eng/i.test(by.language) ? 'en' : null) : null;
  const partyKey =
    mapping.partyMode === 'group_by_column'
      ? (by.partyKey ?? by.partyLabel ?? `row-${rowNumber}`).toLowerCase()
      : `row-${rowNumber}`;

  return {
    partyKey,
    partyLabel: by.partyLabel ?? null,
    primary,
    extraMembers,
    plusOnes: intOf(by.plusOnes),
    groups: (by.groups ?? '').split(/[,;/]/).map((g) => g.trim()).filter(Boolean),
    side,
    city: by.city ?? null,
    isOutstation: by.isOutstation ? YES.test(by.isOutstation) : null,
    language,
    notes: by.notes ?? null,
    issues,
  };
}

export type RowStatus = 'ok' | 'warning' | 'error' | 'duplicate';

export function rowStatus(row: NormalisedRow, duplicate: boolean): RowStatus {
  if (row.issues.some((i) => i.code === 'NAME_MISSING')) return 'error';
  if (duplicate) return 'duplicate';
  return row.issues.length > 0 ? 'warning' : 'ok';
}
