import { createHash, createHmac } from 'node:crypto';

/**
 * Guest link tokens (05-acc §2): derived, 128-bit, never stored. Only sha256(token) lives in
 * parties.link_token_hash, so a DB dump cannot open any invite, yet the server can rebuild a
 * party's link for reminders. Rotating = link_version + 1.
 */
export function deriveLinkToken(key: string, partyId: string, version: number): string {
  return createHmac('sha256', key).update(`link:v1:${partyId}:${version}`).digest().subarray(0, 16).toString('base64url');
}

export const linkTokenHash = (token: string) => createHash('sha256').update(token).digest();

export function linkHashFor(key: string, partyId: string, version = 1) {
  return linkTokenHash(deriveLinkToken(key, partyId, version));
}

export const LINK_TOKEN_SHAPE = /^[A-Za-z0-9_-]{22}$/;
