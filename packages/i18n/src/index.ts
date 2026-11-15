/** Supported guest-facing locales. Catalogues and the ICU formatter land with FND-09. */
export const LOCALES = ['en', 'hi', 'kn'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
