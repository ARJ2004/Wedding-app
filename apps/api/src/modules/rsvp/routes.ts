import { defineRoute, type RouteContext } from '../../common/define-route';
import { z } from '../../common/openapi';
import type { RsvpService } from './service';

const Status = z.enum(['attending', 'declined', 'maybe']);
const Diet = z.enum(['veg', 'jain', 'vegan', 'eggetarian', 'non_veg']);
const Allergy = z.enum(['nuts', 'gluten', 'dairy', 'shellfish', 'egg', 'soy', 'other']);

export const PartyRsvpSchema = z
  .object({
    members: z.array(z.object({ guestId: z.string().uuid(), fullName: z.string(), ageBand: z.enum(['child', 'adult', 'senior']).nullable(), diet: Diet.nullable(), allergies: z.array(Allergy) })),
    events: z.array(
      z.object({
        eventId: z.string().uuid(),
        name: z.string(),
        startsAt: z.string(),
        rsvpEnabled: z.boolean(),
        closed: z.boolean(),
        answers: z.array(z.object({ guestId: z.string().uuid(), status: Status.nullable() })),
      }),
    ),
  })
  .openapi('PartyRsvp');

export function rsvpRoutes(ctx: RouteContext, svc: RsvpService) {
  defineRoute(ctx, {
    method: 'get',
    path: '/v1/guest/rsvp',
    summary: 'My party: invited events × members with their answers and diets',
    tags: ['guest'],
    auth: 'guest',
    response: { status: 200, schema: PartyRsvpSchema },
    handler: ({ req }) => svc.partyState(req.guest!.partyId),
  });

  defineRoute(ctx, {
    method: 'put',
    path: '/v1/guest/rsvp',
    summary: 'Answer for any members of my party (batch) and set diets',
    tags: ['guest'],
    auth: 'guest',
    errors: [404, 409],
    request: {
      body: z.object({
        answers: z.array(z.object({ eventId: z.string().uuid(), guestId: z.string().uuid(), status: Status })).max(200),
        diets: z.array(z.object({ guestId: z.string().uuid(), diet: Diet.nullable(), allergies: z.array(Allergy).max(7).default([]) })).max(20).optional(),
      }),
    },
    response: { status: 200, schema: PartyRsvpSchema },
    handler: ({ req, body }) => svc.answer(req.guest!, body),
  });
}
