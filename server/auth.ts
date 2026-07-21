import { compare } from "bcryptjs";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { query } from "./db.js";
import type { Principal } from "./permissions.js";
import { createSessionToken, hashToken } from "./security.js";

const COOKIE_NAME = "vibeable_session";

interface SessionRow extends Principal {
  expiresAt: Date;
}

export async function authenticate(email: string, password: string) {
  const result = await query<{ id: string; password_hash: string | null }>(
    "SELECT id, password_hash FROM users WHERE lower(email) = lower($1) AND disabled_at IS NULL",
    [email]
  );
  const user = result.rows[0];
  return user?.password_hash && (await compare(password, user.password_hash)) ? user.id : null;
}

export async function createSession(userId: string, reply: FastifyReply) {
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_DAYS * 86_400_000);
  await query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)", [
    userId,
    hashToken(token),
    expiresAt
  ]);
  reply.setCookie(COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: config.cookieSecure,
    expires: expiresAt
  });
}

export async function destroySession(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[COOKIE_NAME];
  if (token) await query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
  reply.clearCookie(COOKIE_NAME, { path: "/" });
}

export async function getPrincipal(request: FastifyRequest): Promise<Principal | null> {
  const token = request.cookies[COOKIE_NAME];
  if (!token) return null;
  const result = await query<SessionRow>(
    `SELECT u.id AS "userId", u.email, u.name, o.id AS "organizationId", o.name AS "organizationName",
            m.role, s.expires_at AS "expiresAt"
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN memberships m ON m.user_id = u.id AND m.team_id IS NULL
       JOIN organizations o ON o.id = m.organization_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [hashToken(token)]
  );
  const principal = result.rows[0];
  if (!principal) return null;
  void query("UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1", [hashToken(token)]).catch(() => undefined);
  return principal;
}

export async function requirePrincipal(request: FastifyRequest) {
  const principal = await getPrincipal(request);
  if (!principal) {
    const error = new Error("Authentication required") as Error & { statusCode: number };
    error.statusCode = 401;
    throw error;
  }
  return principal;
}
