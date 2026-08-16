import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

export interface AccessTokenClaims {
  sub: string; // userId
  deviceId: string;
  sessionId: string;
}

function secretKey(): Uint8Array {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret || secret.length < 32) {
    // Fails loudly at startup-adjacent code paths rather than silently signing with a
    // weak/missing secret — see docs/66-secret-management.md.
    throw new Error('JWT_ACCESS_SECRET is not set (or too short). See .env.example.');
  }
  return new TextEncoder().encode(secret);
}

/**
 * Short-lived access token (default 15m, docs/07-auth-architecture.md). Deliberately
 * does NOT carry the username/display name — those can change, and stuffing mutable
 * profile data into a signed token invites "trust the token" bugs where a handler
 * reads stale data instead of re-querying. The token proves *identity* only; anything
 * else is looked up fresh.
 */
export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  const ttl = process.env.JWT_ACCESS_TTL ?? '15m';
  return new SignJWT({ deviceId: claims.deviceId, sessionId: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secretKey());
}

export type AccessTokenVerifyResult =
  | { valid: true; claims: AccessTokenClaims }
  | { valid: false; reason: 'expired' | 'invalid' };

export async function verifyAccessToken(token: string): Promise<AccessTokenVerifyResult> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (typeof payload.sub !== 'string' || typeof payload.deviceId !== 'string' || typeof payload.sessionId !== 'string') {
      return { valid: false, reason: 'invalid' };
    }
    return {
      valid: true,
      claims: { sub: payload.sub, deviceId: payload.deviceId as string, sessionId: payload.sessionId as string },
    };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return { valid: false, reason: 'expired' };
    }
    return { valid: false, reason: 'invalid' };
  }
}
