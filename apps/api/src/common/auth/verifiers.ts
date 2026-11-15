import { OAuth2Client } from 'google-auth-library';
import { AppError } from '../errors';

export interface VerifiedIdentity {
  sub: string; // stored in users.google_sub ("dev|<email>" for the dev bypass)
  email: string;
  name: string | null;
  picture: string | null;
}

/** One sign-in provider (Google today; Apple pending decision #2). Chosen by `accepts()`. */
export interface IdTokenVerifier {
  readonly name: string;
  accepts(idToken: string): boolean;
  verify(idToken: string): Promise<VerifiedIdentity>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Development stand-in for Google: accepts "dev:<email>". Only constructed when
 * DEV_AUTH_ENABLED=true, which config validation refuses in production.
 */
export class DevIdTokenVerifier implements IdTokenVerifier {
  readonly name = 'dev';
  constructor(private readonly enabled: boolean) {}

  accepts(idToken: string) {
    return this.enabled && idToken.startsWith('dev:');
  }

  async verify(idToken: string): Promise<VerifiedIdentity> {
    const email = idToken.slice(4).trim().toLowerCase();
    if (!EMAIL.test(email)) {
      throw new AppError('AUTH_INVALID_GOOGLE_TOKEN', 'Dev token must be dev:<email>', 401);
    }
    return { sub: `dev|${email}`, email, name: email.split('@')[0] ?? null, picture: null };
  }
}

/** Verifies a Google ID token; audience is the Web OAuth client ID the app requests tokens for. */
export class GoogleIdTokenVerifier implements IdTokenVerifier {
  readonly name = 'google';
  private readonly client = new OAuth2Client();
  constructor(private readonly webClientId: string | undefined) {}

  accepts(idToken: string) {
    return !idToken.startsWith('dev:');
  }

  async verify(idToken: string): Promise<VerifiedIdentity> {
    if (!this.webClientId) throw new AppError('AUTH_GOOGLE_NOT_CONFIGURED', 'Google sign-in is not configured', 503);
    let payload;
    try {
      const ticket = await this.client.verifyIdToken({ idToken, audience: this.webClientId });
      payload = ticket.getPayload();
    } catch {
      throw new AppError('AUTH_INVALID_GOOGLE_TOKEN', 'Google sign-in failed, try again', 401);
    }
    if (!payload?.sub || !payload.email || payload.email_verified !== true) {
      throw new AppError('AUTH_INVALID_GOOGLE_TOKEN', 'Google account email is not verified', 401);
    }
    return { sub: payload.sub, email: payload.email.toLowerCase(), name: payload.name ?? null, picture: payload.picture ?? null };
  }
}

export function createVerifiers(config: { DEV_AUTH_ENABLED: boolean; GOOGLE_WEB_CLIENT_ID?: string }): IdTokenVerifier[] {
  return [new DevIdTokenVerifier(config.DEV_AUTH_ENABLED), new GoogleIdTokenVerifier(config.GOOGLE_WEB_CLIENT_ID)];
}
