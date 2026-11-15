import type { PrismaClient, wedding_contacts } from '@prisma/client';
import { normalisePhone } from '@mehfil/domain';
import type { Request } from 'express';
import { defineRoute, type RouteContext } from '../../common/define-route';
import { AppError } from '../../common/errors';
import { z } from '../../common/openapi';
import { writeAudit } from '../audit';
import { WeddingParams } from './schemas';

const MAX_CONTACTS = 10;
const ContactParams = z.object({ weddingId: z.string().uuid(), contactId: z.string().uuid() });
const ContactSchema = z
  .object({
    id: z.string().uuid(),
    side: z.enum(['bride', 'groom', 'both']),
    label: z.string(),
    name: z.string(),
    phone: z.string(),
    hasWhatsapp: z.boolean(),
    sortOrder: z.number().int(),
  })
  .openapi('KeyContact');
const ContactInput = z.object({
  side: z.enum(['bride', 'groom', 'both']).default('both'),
  label: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(5).max(40),
  hasWhatsapp: z.boolean().default(true),
});

const toContact = (c: wedding_contacts) => ({
  id: c.id,
  side: c.side as 'bride' | 'groom' | 'both',
  label: c.label,
  name: c.name,
  phone: c.phone_e164,
  hasWhatsapp: c.has_whatsapp,
  sortOrder: c.sort_order,
});

/** Masked for audit: contact phones are guest-visible but never copied into logs in full. */
const mask = (e164: string) => `${e164.slice(0, 3)}••••${e164.slice(-2)}`;

/**
 * SET-05 key contacts: per-side helplines guests can call or WhatsApp. Deliberately guest-visible
 * (the host enters them for that purpose); desk staff can read them like any member.
 */
export function contactRoutes(ctx: RouteContext, deps: { prisma: PrismaClient }) {
  const { prisma } = deps;
  const W = '/v1/weddings/:weddingId/contacts';
  const actor = (req: Request) => ({ type: 'user' as const, id: req.principal!.userId, role: req.membership!.role });
  const phoneOf = (raw: string) => {
    const n = normalisePhone(raw);
    if (n.status !== 'valid' && n.status !== 'landline') throw new AppError('GST_PHONE_INVALID', 'Enter a working phone number', 400);
    return n.e164!;
  };
  const list = (weddingId: string) =>
    prisma.wedding_contacts.findMany({ where: { wedding_id: weddingId }, orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }] }).then((r) => r.map(toContact));

  defineRoute(ctx, {
    method: 'get',
    path: W,
    summary: 'Key contacts in display order',
    tags: ['weddings'],
    auth: 'host',
    permission: 'wedding.read',
    request: { params: WeddingParams },
    response: { status: 200, schema: z.object({ items: z.array(ContactSchema) }) },
    handler: async ({ params }) => ({ items: await list(params.weddingId) }),
  });

  defineRoute(ctx, {
    method: 'post',
    path: W,
    summary: 'Add a key contact (max 10)',
    tags: ['weddings'],
    auth: 'host',
    permission: 'contact.write',
    errors: [409],
    request: { params: WeddingParams, body: ContactInput },
    response: { status: 201, schema: ContactSchema },
    handler: async ({ req, params, body }) =>
      prisma.$transaction(async (tx) => {
        const n = await tx.wedding_contacts.count({ where: { wedding_id: params.weddingId } });
        if (n >= MAX_CONTACTS) throw new AppError('SET_CONTACTS_LIMIT', `Up to ${MAX_CONTACTS} key contacts`, 409);
        const c = await tx.wedding_contacts.create({
          data: { wedding_id: params.weddingId, side: body.side, label: body.label, name: body.name, phone_e164: phoneOf(body.phone), has_whatsapp: body.hasWhatsapp, sort_order: n },
        });
        await writeAudit(tx, { weddingId: params.weddingId, actor: actor(req), action: 'contact.create', entityType: 'contact', entityId: c.id, after: { label: c.label, name: c.name, phone: mask(c.phone_e164) }, requestId: String(req.id) });
        return toContact(c);
      }),
  });

  defineRoute(ctx, {
    method: 'put',
    path: `${W}/order`,
    summary: 'Reorder contacts (full list of ids)',
    tags: ['weddings'],
    auth: 'host',
    permission: 'contact.write',
    request: { params: WeddingParams, body: z.object({ contactIds: z.array(z.string().uuid()).max(MAX_CONTACTS) }) },
    response: { status: 200, schema: z.object({ items: z.array(ContactSchema) }) },
    handler: async ({ params, body }) => {
      const current = await list(params.weddingId);
      if (current.length !== body.contactIds.length || !current.every((c) => body.contactIds.includes(c.id))) {
        throw new AppError('SET_ORDER_MISMATCH', 'Send every contact exactly once', 400);
      }
      await prisma.$transaction(body.contactIds.map((id, i) => prisma.wedding_contacts.update({ where: { id }, data: { sort_order: i } })));
      return { items: await list(params.weddingId) };
    },
  });

  defineRoute(ctx, {
    method: 'patch',
    path: `${W}/:contactId`,
    summary: 'Edit a key contact',
    tags: ['weddings'],
    auth: 'host',
    permission: 'contact.write',
    errors: [404],
    request: { params: ContactParams, body: ContactInput.partial() },
    response: { status: 200, schema: ContactSchema },
    handler: async ({ req, params, body }) => {
      const c = await prisma.wedding_contacts.findFirst({ where: { id: params.contactId, wedding_id: params.weddingId } });
      if (!c) throw new AppError('SET_CONTACT_NOT_FOUND', 'Contact not found', 404);
      const updated = await prisma.wedding_contacts.update({
        where: { id: c.id },
        data: { side: body.side, label: body.label, name: body.name, phone_e164: body.phone ? phoneOf(body.phone) : undefined, has_whatsapp: body.hasWhatsapp, updated_at: new Date() },
      });
      await writeAudit(prisma, { weddingId: params.weddingId, actor: actor(req), action: 'contact.update', entityType: 'contact', entityId: c.id, after: { label: updated.label, phone: mask(updated.phone_e164) }, requestId: String(req.id) });
      return toContact(updated);
    },
  });

  defineRoute(ctx, {
    method: 'delete',
    path: `${W}/:contactId`,
    summary: 'Remove a key contact',
    tags: ['weddings'],
    auth: 'host',
    permission: 'contact.write',
    errors: [404],
    request: { params: ContactParams },
    response: { status: 204 },
    handler: async ({ req, params }) => {
      const c = await prisma.wedding_contacts.findFirst({ where: { id: params.contactId, wedding_id: params.weddingId } });
      if (!c) throw new AppError('SET_CONTACT_NOT_FOUND', 'Contact not found', 404);
      await prisma.wedding_contacts.delete({ where: { id: c.id } });
      await writeAudit(prisma, { weddingId: params.weddingId, actor: actor(req), action: 'contact.delete', entityType: 'contact', entityId: c.id, before: { label: c.label }, requestId: String(req.id) });
    },
  });
}
