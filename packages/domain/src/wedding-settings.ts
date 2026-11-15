import { z } from 'zod';

export const LANGUAGES = ['en', 'hi', 'kn', 'ta', 'te', 'mr', 'gu', 'bn', 'pa', 'ml'] as const;

/**
 * SET-06 wedding settings, stored in weddings.settings (jsonb) and validated on every write
 * (03-set §3). Deviation from the design: branding picks one of the contrast-tested palettes in
 * packages/design-tokens instead of a free accent colour, so contrast can never fail.
 */
export const WeddingSettingsV1 = z
  .object({
    camera: z
      .object({
        shotLimit: z.number().int().min(0).max(200).default(24),
        limitScope: z.enum(['wedding', 'event']).default('wedding'),
        revealMode: z.enum(['instant', 'next_morning', 'after_wedding', 'scheduled']).default('next_morning'),
        revealAt: z.string().datetime({ offset: true }).nullable().default(null),
      })
      .strict()
      .prefault({}),
    language: z.object({ default: z.enum(LANGUAGES).default('en') }).strict().prefault({}),
    branding: z
      .object({
        /** A PaletteName from packages/design-tokens; null = the app default (theme.config.ts). */
        palette: z.string().nullable().default(null),
      })
      .strict()
      .prefault({}),
    guests: z.object({ phoneDefaultRegion: z.string().length(2).default('IN') }).strict().prefault({}),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.camera.revealMode === 'scheduled' && !s.camera.revealAt) {
      ctx.addIssue({ code: 'custom', path: ['camera', 'revealAt'], message: 'Pick when photos are revealed' });
    }
  });

export type WeddingSettings = z.infer<typeof WeddingSettingsV1>;

/** Reads stored settings, filling defaults; tolerates legacy keys from the seed (never throws). */
export function readSettings(stored: unknown): WeddingSettings {
  const parsed = WeddingSettingsV1.safeParse(stored);
  if (parsed.success) return parsed.data;
  const base = WeddingSettingsV1.parse({});
  const s = (stored ?? {}) as Record<string, Record<string, unknown>>;
  const pick = <K extends keyof WeddingSettings>(k: K) => {
    const r = WeddingSettingsV1.shape[k].safeParse(s[k] ?? {});
    return r.success ? r.data : base[k];
  };
  return { camera: pick('camera'), language: pick('language'), branding: pick('branding'), guests: pick('guests') } as WeddingSettings;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge for PATCH: objects merge, everything else (incl. null) replaces. */
export function mergeSettings(current: unknown, patch: unknown): unknown {
  if (!isObj(current) || !isObj(patch)) return patch;
  const out: Json = { ...current };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(current[k]) ? mergeSettings(current[k], v) : v;
  return out;
}
