import pino, { type Logger } from 'pino';

/** Paths that must never reach the logs: tokens, OTPs, phone numbers, cookies. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.token',
  '*.idToken',
  '*.accessToken',
  '*.refreshToken',
  '*.otp',
  '*.code',
  '*.phone',
  '*.phoneE164',
  '*.password',
];

export function createLogger(level: string): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } });
}
