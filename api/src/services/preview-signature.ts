import { SignJWT, jwtVerify } from 'jose';

/**
 * A <video> element cannot send an Authorization header, so the preview route is
 * authenticated by a short-lived token in its query instead. The token is issued once
 * per viewing session by a query keyed by recording (like storage.signObject), so the
 * <video src> never changes while it plays. jose is already how this api handles JWTs.
 */
export const PREVIEW_TTL_S = 6 * 60 * 60;

const key = (secret: string) => new TextEncoder().encode(secret);

export function signPreview(ref: string, secret: string, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  return new SignJWT({ ref })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(iat)
    .setExpirationTime(iat + PREVIEW_TTL_S)
    .sign(key(secret));
}

export async function verifyPreview(token: string, ref: string, secret: string, nowMs: number): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'], currentDate: new Date(nowMs) });
    return payload.ref === ref;
  } catch {
    return false;
  }
}
