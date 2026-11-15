import { EVENT_KINDS } from '@mehfil/domain';
import { z } from '../../common/openapi';

const Uuid = z.string().uuid();
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const Role = z.enum(['owner', 'co_host', 'planner_member', 'desk_staff']);

export const WeddingParams = z.object({ weddingId: Uuid });
export const EventParams = z.object({ weddingId: Uuid, eventId: Uuid });
export const VenueParams = z.object({ weddingId: Uuid, venueId: Uuid });

export const WeddingSchema = z
  .object({
    id: Uuid,
    organizationId: Uuid,
    title: z.string(),
    partnerOneName: z.string().nullable(),
    partnerTwoName: z.string().nullable(),
    startsOn: IsoDate,
    endsOn: IsoDate,
    timezone: z.string(),
    cities: z.array(z.string()),
    plan: z.string(),
    status: z.string(),
    myRole: Role,
    /** Short-lived URL for the cover photo, or null. */
    coverUrl: z.string().nullable(),
  })
  .openapi('Wedding');

export const CreateWeddingSchema = z
  .object({
    title: z.string().trim().min(2).max(120),
    partnerOneName: z.string().trim().min(1).max(60).optional(),
    partnerTwoName: z.string().trim().min(1).max(60).optional(),
    startsOn: IsoDate,
    endsOn: IsoDate,
    timezone: z.string().default('Asia/Kolkata'),
    cities: z.array(z.string().trim().min(1).max(60)).max(5).default([]),
    /** A planner org the caller belongs to; omitted → a personal family org is created. */
    organizationId: Uuid.optional(),
  })
  .openapi('CreateWedding');

// Written out (not CreateWeddingSchema.partial()) so create-time defaults never overwrite stored
// values on PATCH: { title } must not reset timezone or cities.
export const UpdateWeddingSchema = z
  .object({
    title: z.string().trim().min(2).max(120).optional(),
    partnerOneName: z.string().trim().max(60).nullable().optional(),
    partnerTwoName: z.string().trim().max(60).nullable().optional(),
    startsOn: IsoDate.optional(),
    endsOn: IsoDate.optional(),
    timezone: z.string().optional(),
    cities: z.array(z.string().trim().min(1).max(60)).max(5).optional(),
    /** An uploaded media object of purpose "cover" in this wedding; null removes the cover. */
    coverMediaId: Uuid.nullable().optional(),
  })
  .openapi('UpdateWedding');

export const EventSchema = z
  .object({
    id: Uuid,
    kind: z.enum(EVENT_KINDS),
    name: z.string(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime().nullable(),
    venueId: Uuid.nullable(),
    dressCode: z.string().nullable(),
    notes: z.string().nullable(),
    sortOrder: z.number().int(),
    visibility: z.enum(['all', 'groups']),
  })
  .openapi('Event');

export const CreateEventSchema = z
  .object({
    kind: z.enum(EVENT_KINDS),
    name: z.string().trim().min(1).max(80).optional(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }).nullable().optional(),
    venueId: Uuid.nullable().optional(),
    dressCode: z.string().trim().max(120).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .openapi('CreateEvent');

export const UpdateEventSchema = CreateEventSchema.partial().openapi('UpdateEvent');

export const BulkPresetsSchema = z
  .object({
    items: z
      .array(z.object({ kind: z.enum(EVENT_KINDS).exclude(['custom']), date: IsoDate, time: z.string().regex(/^\d{2}:\d{2}$/).optional() }))
      .min(1)
      .max(12),
  })
  .openapi('BulkEventsFromPresets');

export const EventOrderSchema = z.object({ eventIds: z.array(Uuid).min(1).max(100) }).openapi('EventOrder');

export const VenueSchema = z
  .object({
    id: Uuid,
    name: z.string(),
    address: z.string().nullable(),
    city: z.string().nullable(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
    mapsUrl: z.string().nullable(),
    parkingNotes: z.string().nullable(),
    notes: z.string().nullable(),
  })
  .openapi('Venue');

export const CreateVenueSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    address: z.string().trim().max(300).nullable().optional(),
    city: z.string().trim().max(60).nullable().optional(),
    mapsUrl: z.string().trim().url().max(2000).nullable().optional(),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    parkingNotes: z.string().trim().max(500).nullable().optional(),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .openapi('CreateVenue');

export const UpdateVenueSchema = CreateVenueSchema.partial().openapi('UpdateVenue');

export const EventPresetSchema = z
  .object({
    kind: z.string(),
    defaultName: z.string(),
    defaultStart: z.string(),
    durationMinutes: z.number().int(),
    dressCodeHint: z.string(),
    icon: z.string(),
  })
  .openapi('EventPreset');
