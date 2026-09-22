import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { env } from '../env';

/**
 * The one place a Zitadel access token is checked.
 *
 * It used to be two: requireAuth for the REST routes, and a private copy inside
 * the tRPC context factory. The copy caught every error and returned null, so
 * it had no clock tolerance, logged nothing, and turned a failed key-set fetch
 * into 401 — which the UI answers by dropping the session and bouncing to
 * Zitadel. Every page load opens tRPC queries, so that copy drove a sign-in
 * loop that left no trace in the api log at all.
 */

// The authenticated identity, attached to every request that clears auth.
export type AuthUser = { sub: string; name: string };

export type VerifyResult =
  | { ok: true; user: AuthUser }
  // 401: the token is the problem, signing in again can fix it.
  // 403: a valid token, but this account is not a member.
  // 503: nothing is known about the token — the key set could not be fetched.
  //      Answering 401 here is what makes an outage look like a dead session.
  | { ok: false; status: 401 | 403 | 503; code: string };

// Project roles that grant access. Zitadel keeps one grant per user per
// project, so an admin can't also be handed `member` as a second grant.
const ACCESS_ROLES = ['member', 'admin'];

const JWKS = createRemoteJWKSet(new URL(`https://${env.ZITADEL_DOMAIN}/oauth/v2/keys`));

function nameFromClaims(claims: Record<string, unknown>): string | null {
  for (const key of ['name', 'preferred_username', 'email']) {
    const value = claims[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

// Zitadel's JWT access tokens usually carry no profile claims: the name lives in
// the ID token, which never reaches the api. Without this, the presence roster
// and claim badges show a bare user id. The userinfo endpoint answers for the
// token's own user (the UI requests the profile and email scopes), and names
// barely change, so one lookup per user per hour is plenty. A failed lookup
// never fails the request (it falls back to the id) and is remembered for a few
// minutes, so a Zitadel hiccup can't add a slow call to every request.
const USERINFO_TTL_MS = 60 * 60 * 1000;
const USERINFO_FAILURE_TTL_MS = 5 * 60 * 1000;
const userinfoNames = new Map<string, { name: string | null; until: number }>();

export async function nameFromUserinfo(token: string, sub: string): Promise<string | null> {
  const cached = userinfoNames.get(sub);
  if (cached && Date.now() < cached.until) return cached.name;

  let name: string | null = null;
  try {
    const res = await fetch(`https://${env.ZITADEL_DOMAIN}/oidc/v1/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) name = nameFromClaims((await res.json()) as Record<string, unknown>);
    else console.warn(`Auth: userinfo ${res.status} for ${sub}`);
  } catch (err) {
    console.warn(`Auth: userinfo lookup failed for ${sub}:`, err instanceof Error ? err.message : err);
  }
  userinfoNames.set(sub, { name, until: Date.now() + (name ? USERINFO_TTL_MS : USERINFO_FAILURE_TTL_MS) });
  return name;
}

/** Whether a failure says something about the token, or only about our backend. */
export function classifyAuthError(err: unknown): { status: 401 | 503; code: string } {
  const code = (err as { code?: string })?.code ?? 'ERR_UNKNOWN';
  const infra =
    code === 'ERR_JWKS_TIMEOUT' ||
    code === 'ERR_JWKS_MULTIPLE_MATCHING_KEYS' ||
    code === 'ERR_JOSE_GENERIC' ||
    // jose surfaces a failed key fetch as a bare fetch/network error.
    (code === 'ERR_UNKNOWN' && err instanceof TypeError);
  return { status: infra ? 503 : 401, code };
}

// Enough of the token to tell the common misconfigurations apart without
// putting a credential in the logs: an opaque Zitadel token (no JWT header at
// all), or one signed by a key the JWKS doesn't carry.
export function tokenShape(token: string): string {
  try {
    const { alg, kid } = decodeProtectedHeader(token);
    return `alg=${alg ?? '?'} kid=${kid ?? '?'}`;
  } catch {
    return "not-a-jwt (opaque token — check the app's Auth Token Type in Zitadel)";
  }
}

/**
 * Verify a bearer token and its member (or admin) role. `where` names the caller (a method
 * and path, a tRPC procedure) and appears in the log line — a rejection has to
 * be attributable, or a loop stays invisible the way this one did.
 */
export async function verifyToken(token: string, where: string): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://${env.ZITADEL_DOMAIN}`,
      audience: env.ZITADEL_CLIENT_ID,
      // Zitadel and this host keep their own clocks; without a tolerance a
      // second of drift rejects a token that was just issued.
      clockTolerance: '30s',
    });

    const roles = payload['urn:zitadel:iam:org:project:roles'] as Record<string, unknown> | undefined;
    if (!roles || !ACCESS_ROLES.some((role) => role in roles)) {
      console.warn(`Auth: no member/admin role for ${String(payload.sub)} (${where})`);
      return { ok: false, status: 403, code: 'ERR_NOT_MEMBER' };
    }

    const name = nameFromClaims(payload) ?? (await nameFromUserinfo(token, payload.sub!)) ?? payload.sub!;
    return { ok: true, user: { sub: payload.sub!, name } };
  } catch (err) {
    const { status, code } = classifyAuthError(err);
    console.warn(
      `Auth: rejected token (${code}) on ${where} — ${tokenShape(token)}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return { ok: false, status, code };
  }
}
