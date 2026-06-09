/**
 * Mint Bearer tokens for the Identity Backend's `verifyJwt` middleware.
 *
 * Mirrors `apps/identity-backend/src/middleware/verify-jwt.ts` in
 * paritytech/identity-backend: HS256 over a shared secret, payload
 * with `iss: 'polkadot-app'` and a non-empty `sub` (the address the
 * call is acting on, so IB audit logs link request → principal).
 *
 * The secret comes from `IB_JWT_SECRET`. When unset we send no header,
 * which keeps the suite green against IB instances where
 * `JWT_AUTH_ENFORCED=false`. Once IB enforces JWT cluster-wide, leave
 * the env var unset locally → tests 401 loudly; set it in CI → tests
 * authenticate. No silent fallback to a stub secret.
 */

import { createHmac } from "node:crypto";

const ISSUER = "polkadot-app";
const TOKEN_TTL_SECONDS = 60 * 60 * 24; // 24h, matches IB JWTAuthServiceDefaults

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64url");
}

export function mintIbJwt(secret: string, sub: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({ iss: ISSUER, sub, iat: now, exp: now + TOKEN_TTL_SECONDS }),
  );
  const signingInput = `${header}.${payload}`;
  const sig = createHmac("sha256", secret).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

export function ibAuthHeader(sub: string): Record<string, string> {
  const secret = process.env.IB_JWT_SECRET;
  if (!secret) return {};
  return { Authorization: `Bearer ${mintIbJwt(secret, sub)}` };
}
