import { z } from '../../common/openapi';

const Uuid = z.string().uuid();

export const PartyParams = z.object({ weddingId: Uuid, partyId: Uuid });
export const GuestParams = z.object({ weddingId: Uuid, guestId: Uuid });

export const GuestSchema = z
  .object({
    id: Uuid,
    fullName: z.string(),
    isPrimary: z.boolean(),
    isPlusOne: z.boolean(),
    ageBand: z.enum(['child', 'adult', 'senior']).nullable(),
    /** Present only for roles with guest.contact.read (never desk staff). */
    phone: z.string().nullable().optional(),
    phoneStatus: z.enum(['valid', 'invalid', 'missing', 'landline']).optional(),
    phoneRaw: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    relation: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .openapi('Guest');

export const PartySchema = z
  .object({
    id: Uuid,
    label: z.string(),
    plusOnesAllowed: z.number().int(),
    isOutstation: z.boolean(),
    preferredLanguage: z.string(),
    city: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    groupIds: z.array(Uuid),
    members: z.array(GuestSchema),
  })
  .openapi('Party');

const MemberInput = z.object({
  fullName: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  isPrimary: z.boolean().optional(),
  isPlusOne: z.boolean().optional(),
  ageBand: z.enum(['child', 'adult', 'senior']).nullable().optional(),
  relation: z.string().trim().max(80).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const CreatePartySchema = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    plusOnesAllowed: z.number().int().min(0).max(10).default(0),
    isOutstation: z.boolean().default(false),
    preferredLanguage: z.enum(['en', 'hi', 'kn']).default('en'),
    city: z.string().trim().max(60).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
    groupIds: z.array(Uuid).max(20).default([]),
    members: z.array(MemberInput).min(1).max(20),
  })
  .openapi('CreateParty');

export const UpdatePartySchema = CreatePartySchema.omit({ members: true })
  .partial()
  .extend({ label: z.string().trim().min(1).max(120).optional() })
  .openapi('UpdateParty');

export const AddGuestSchema = MemberInput.omit({ isPrimary: true }).openapi('AddGuest');
export const UpdateGuestSchema = MemberInput.partial().openapi('UpdateGuest');

export const ListPartiesQuery = z.object({
  q: z.string().trim().max(80).optional(),
  groupId: Uuid.optional(),
  phoneStatus: z.enum(['valid', 'invalid', 'missing', 'landline']).optional(),
  cursor: Uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const GroupSchema = z
  .object({ id: Uuid, name: z.string(), systemKey: z.string().nullable(), colour: z.string().nullable(), partyCount: z.number().int() })
  .openapi('GuestGroup');
