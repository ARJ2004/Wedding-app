import type { PrismaClient } from '@prisma/client';
import { PALETTE_NAMES } from '@mehfil/design-tokens';
import { mergeSettings, readSettings, WeddingSettingsV1 } from '@mehfil/domain';
import type { Request } from 'express';
import { defineRoute, type RouteContext } from '../../common/define-route';
import { AppError } from '../../common/errors';
import { z } from '../../common/openapi';
import { diff, writeAudit } from '../audit';
import { WeddingParams } from './schemas';

export const SettingsSchema = z
  .object({
    camera: z.object({
      shotLimit: z.number().int(),
      limitScope: z.enum(['wedding', 'event']),
      revealMode: z.enum(['instant', 'next_morning', 'after_wedding', 'scheduled']),
      revealAt: z.string().nullable(),
    }),
    language: z.object({ default: z.string() }),
    branding: z.object({ palette: z.string().nullable() }),
    guests: z.object({ phoneDefaultRegion: z.string() }),
  })
  .openapi('WeddingSettings');

/** SET-06: GET/PATCH /weddings/:id/settings. PATCH deep-merges then validates the whole object. */
export function settingsRoutes(ctx: RouteContext, deps: { prisma: PrismaClient }) {
  const { prisma } = deps;

  defineRoute(ctx, {
    method: 'get',
    path: '/v1/weddings/:weddingId/settings',
    summary: 'Wedding settings with defaults filled',
    tags: ['weddings'],
    auth: 'host',
    permission: 'wedding.read',
    request: { params: WeddingParams },
    response: { status: 200, schema: SettingsSchema },
    handler: async ({ params }) => {
      const w = await prisma.weddings.findUniqueOrThrow({ where: { id: params.weddingId }, select: { settings: true } });
      return readSettings(w.settings);
    },
  });

  defineRoute(ctx, {
    method: 'patch',
    path: '/v1/weddings/:weddingId/settings',
    summary: 'Change settings (deep merge; unknown keys rejected)',
    tags: ['weddings'],
    auth: 'host',
    permission: 'wedding.settings.update',
    request: { params: WeddingParams, body: z.record(z.string(), z.unknown()) },
    response: { status: 200, schema: SettingsSchema },
    handler: async ({ req, params, body }) =>
      prisma.$transaction(async (tx) => {
        const w = await tx.weddings.findUniqueOrThrow({ where: { id: params.weddingId }, select: { settings: true } });
        const current = readSettings(w.settings);
        const parsed = WeddingSettingsV1.safeParse(mergeSettings(current, body));
        if (!parsed.success) {
          throw new AppError(
            'SET_SETTINGS_INVALID',
            'Some settings are invalid',
            400,
            parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          );
        }
        const palette = parsed.data.branding.palette;
        if (palette !== null && !(PALETTE_NAMES as string[]).includes(palette)) {
          throw new AppError('SET_PALETTE_UNKNOWN', 'Pick one of the app palettes', 400);
        }
        await tx.weddings.update({
          where: { id: params.weddingId },
          data: { settings: parsed.data, settings_version: 1, updated_by: (req as Request).principal!.userId, updated_at: new Date() },
        });
        const d = diff(current as unknown as Record<string, unknown>, parsed.data as unknown as Record<string, unknown>);
        if (d.changed) {
          await writeAudit(tx, {
            weddingId: params.weddingId,
            actor: { type: 'user', id: req.principal!.userId, role: req.membership!.role },
            action: 'wedding.settings.update',
            entityType: 'wedding',
            entityId: params.weddingId,
            before: d.before,
            after: d.after,
            requestId: String(req.id),
          });
        }
        return parsed.data;
      }),
  });
}
