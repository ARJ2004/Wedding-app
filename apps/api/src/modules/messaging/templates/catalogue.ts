/**
 * WhatsApp template catalogue as code (MSG-02, 07-msg §2). One sender number serves every
 * wedding, so the wedding title is always a variable. Change a body → bump `name` (Meta does not
 * allow editing an approved template in place), run `pnpm msg:templates push`, wait for approval.
 * L10N adds `hi` / `kn` variants. Mehfil sends no marketing templates to guests.
 */
export interface CatalogueParam {
  name: string;
  max: number;
}
export interface CatalogueVariant {
  channel: 'whatsapp';
  language: 'en' | 'hi' | 'kn';
  /** Provider template name (lower snake case, versioned). */
  name: string;
  body: string;
  params: CatalogueParam[];
  examples: string[];
  buttons?: { type: 'quick_reply'; action: string; text: string }[];
  header?: 'none' | 'image';
}
export interface CatalogueTemplate {
  key: string;
  purpose: 'invite' | 'rsvp' | 'reminder' | 'announcement' | 'otp' | 'travel' | 'arrival' | 'confirmation' | 'system';
  category: 'utility' | 'authentication';
  hostSelectable: boolean;
  description: string;
  variants: CatalogueVariant[];
}

const wedding: CatalogueParam = { name: 'wedding', max: 60 };
const guest: CatalogueParam = { name: 'guest_name', max: 60 };
const link: CatalogueParam = { name: 'link', max: 200 };

export const CATALOGUE: CatalogueTemplate[] = [
  {
    key: 'invite',
    purpose: 'invite',
    category: 'utility',
    hostSelectable: false,
    description: 'Personal invite link to the wedding app',
    variants: [
      {
        channel: 'whatsapp',
        language: 'en',
        name: 'mehfil_invite_v1',
        body: 'Namaste {{1}}! You are invited to {{2}}. Your family’s schedule, RSVP and travel details are here: {{3}}',
        params: [guest, wedding, link],
        examples: ['Kiran', 'Ananya & Rohan', 'https://mehfil.app/g/abc'],
      },
    ],
  },
  {
    key: 'rsvp_request',
    purpose: 'rsvp',
    category: 'utility',
    hostSelectable: false,
    description: 'Ask a family to RSVP for an event, with one-tap buttons',
    variants: [
      {
        channel: 'whatsapp',
        language: 'en',
        name: 'mehfil_rsvp_request_v1',
        body: '{{1}}, will your family join the {{2}} for {{3}} on {{4}}?',
        params: [guest, { name: 'event', max: 40 }, wedding, { name: 'date', max: 40 }],
        examples: ['Kiran', 'Sangeet', 'Ananya & Rohan', 'Fri 12 Feb, 7:30 pm'],
        buttons: [
          { type: 'quick_reply', action: 'rsv.attend', text: 'Attending' },
          { type: 'quick_reply', action: 'rsv.decline', text: 'Can’t make it' },
          { type: 'quick_reply', action: 'rsv.maybe', text: 'Not sure yet' },
        ],
      },
    ],
  },
  {
    key: 'rsvp_reminder',
    purpose: 'reminder',
    category: 'utility',
    hostSelectable: true,
    description: 'Reminder to families who have not answered yet',
    variants: [
      {
        channel: 'whatsapp',
        language: 'en',
        name: 'mehfil_rsvp_reminder_v1',
        body: 'Gentle reminder from {{1}}: please tell us who is coming by {{2}}. It takes a minute: {{3}}',
        params: [wedding, { name: 'deadline', max: 40 }, link],
        examples: ['Ananya & Rohan', '20 Jan', 'https://mehfil.app/g/abc'],
      },
    ],
  },
  {
    key: 'announcement_text',
    purpose: 'announcement',
    category: 'utility',
    hostSelectable: true,
    description: 'Host announcement (text)',
    variants: [
      {
        channel: 'whatsapp',
        language: 'en',
        name: 'mehfil_announcement_text_v1',
        body: 'Update from {{1}}: {{2}}',
        params: [wedding, { name: 'text', max: 1024 }],
        examples: ['Ananya & Rohan', 'Buses leave the hotel lobby at 4:15 pm sharp.'],
      },
    ],
  },
  {
    key: 'announcement_image',
    purpose: 'announcement',
    category: 'utility',
    hostSelectable: true,
    description: 'Host announcement with a photo',
    variants: [
      {
        channel: 'whatsapp',
        language: 'en',
        name: 'mehfil_announcement_image_v1',
        body: 'Update from {{1}}: {{2}}',
        params: [wedding, { name: 'text', max: 1024 }],
        examples: ['Ananya & Rohan', 'Here is the route to the venue.'],
        header: 'image',
      },
    ],
  },
  {
    key: 'rsvp_confirmation',
    purpose: 'confirmation',
    category: 'utility',
    hostSelectable: false,
    description: 'Confirms what a family answered',
    variants: [
      {
        channel: 'whatsapp',
        language: 'en',
        name: 'mehfil_rsvp_confirmation_v1',
        body: 'Thank you! We have your answer for {{1}}: {{2}}. You can change it any time here: {{3}}',
        params: [wedding, { name: 'summary', max: 300 }, link],
        examples: ['Ananya & Rohan', 'Sangeet: 3 attending', 'https://mehfil.app/g/abc'],
      },
    ],
  },
  {
    key: 'rsvp_closed',
    purpose: 'rsvp',
    category: 'utility',
    hostSelectable: false,
    description: 'Tells a family the RSVP has closed',
    variants: [
      {
        channel: 'whatsapp',
        language: 'en',
        name: 'mehfil_rsvp_closed_v1',
        body: 'RSVPs for {{1}} have closed. If your plans changed, please call the family. Details: {{2}}',
        params: [wedding, link],
        examples: ['Ananya & Rohan', 'https://mehfil.app/g/abc'],
      },
    ],
  },
  {
    key: 'otp',
    purpose: 'otp',
    category: 'authentication',
    hostSelectable: false,
    description: 'Sign-in code for the wedding app',
    variants: [
      {
        channel: 'whatsapp',
        language: 'en',
        name: 'mehfil_otp_v1',
        body: '{{1}} is your verification code. For your security, do not share this code.',
        params: [{ name: 'code', max: 8 }],
        examples: ['482913'],
      },
    ],
  },
];

/** Placeholders must be {{1}}..{{n}} in order and match the params list. */
export function checkCatalogue(list: CatalogueTemplate[] = CATALOGUE): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const t of list) {
    for (const v of t.variants) {
      const where = `${t.key}/${v.language}`;
      if (!/^[a-z0-9_]{1,512}$/.test(v.name)) problems.push(`${where}: bad template name ${v.name}`);
      if (names.has(`${v.name}/${v.language}`)) problems.push(`${where}: duplicate name ${v.name}`);
      names.add(`${v.name}/${v.language}`);
      const used = [...v.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      const expected = v.params.map((_, i) => i + 1);
      if (used.join(',') !== expected.join(',')) problems.push(`${where}: placeholders ${used.join(',')} ≠ params 1..${v.params.length}`);
      if (v.examples.length !== v.params.length) problems.push(`${where}: needs one example per param`);
      if (v.body.length > 1024) problems.push(`${where}: body over 1024 chars`);
      if ((v.buttons?.length ?? 0) > 3) problems.push(`${where}: at most 3 quick replies`);
    }
  }
  return problems;
}
