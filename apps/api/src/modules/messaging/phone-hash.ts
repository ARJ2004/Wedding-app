import { createHmac } from 'node:crypto';

/** HMAC-SHA256(PII_HASH_KEY, e164): the only form a phone takes in messaging tables (07-msg §8). */
export const phoneHash = (key: string, e164: string) => createHmac('sha256', key).update(e164).digest();
