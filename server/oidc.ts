import { createHash, randomBytes } from "node:crypto";
import type { LookupFunction } from "node:net";
import type { FastifyInstance, FastifyReply } from "fastify";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { Agent, fetch as pinnedFetch, type Dispatcher, type Response as UndiciResponse } from "undici";
import { z } from "zod";
import type { Role } from "../src/domain/types.js";
import { createSession } from "./auth.js";
import { config } from "./config.js";
import { query, transaction } from "./db.js";
import { assertSafeExternalResolution, assertSafeExternalUrl, decryptSecret, encryptSecret, hashToken } from "./security.js";

const metadataSchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  userinfo_endpoint: z.string().url().optional(),
  response_types_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional()
});

const tokenSchema = z.object({
  id_token: z.string().min(1),
  access_token: z.string().min(1).optional(),
  token_type: z.string().optional()
});

const claimsSchema = z.object({
  sub: z.string().min(1).max(1000),
  email: z.string().email().max(254),
  email_verified: z.boolean().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  preferred_username: z.string().trim().min(1).max(100).optional()
}).passthrough();

type Metadata = z.infer<typeof metadataSchema>;
type Claims = z.infer<typeof claimsSchema> & JWTPayload;
type OidcRole = Exclude<Role, "owner">;

const roleRank: Record<OidcRole, number> = { viewer: 0, reviewer: 1, developer: 2, admin: 3 };
const MAX_OIDC_RESPONSE_BYTES = 1024 * 1024;
const metadataCache = new Map<string, { value: Metadata; expiresAt: number }>();
const jwksCache = new Map<string, { value: JSONWebKeySet; expiresAt: number }>();

export function oidcPublicConfig() {
  return config.oidc.enabled && config.oidc.issuer && config.oidc.clientId
    ? { enabled: true, displayName: config.oidc.displayName }
    : { enabled: false, displayName: config.oidc.displayName };
}

export function resolveOidcRole(groups: string[], mapping: Record<string, string>, fallback: OidcRole): OidcRole {
  const mapped: OidcRole[] = [];
  for (const group of groups) {
    const role = mapping[group];
    if (role && role in roleRank) mapped.push(role as OidcRole);
  }
  return mapped.reduce((highest, role) => roleRank[role] > roleRank[highest] ? role : highest, fallback);
}

export function mappedTeamSlugs(groups: string[], mapping: Record<string, string>) {
  return [...new Set(groups.map((group) => mapping[group]).filter(Boolean))];
}

export function registerOidcRoutes(app: FastifyInstance) {
  app.get("/api/auth/oidc/start", { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } }, async (request, reply) => {
    requireOidc();
    const { returnTo } = z.object({ returnTo: z.string().max(1000).optional() }).parse(request.query);
    const safeReturnTo = normalizeReturnTo(returnTo);
    const metadata = await discover();
    if (metadata.response_types_supported && !metadata.response_types_supported.includes("code")) {
      throw oidcError("The identity provider does not support authorization code flow", 502);
    }
    if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes("S256")) {
      throw oidcError("The identity provider does not support PKCE S256", 502);
    }

    const state = randomValue();
    const nonce = randomValue();
    const codeVerifier = randomValue();
    const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
    await transaction(async (client) => {
      await client.query("DELETE FROM oidc_login_attempts WHERE expires_at <= now()");
      await client.query(
        `INSERT INTO oidc_login_attempts (state_hash, nonce, encrypted_code_verifier, return_to, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
        [hashToken(state), nonce, encryptSecret(codeVerifier), safeReturnTo]
      );
    });

    const authorizationUrl = new URL(metadata.authorization_endpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", config.oidc.clientId!);
    authorizationUrl.searchParams.set("redirect_uri", callbackUrl());
    authorizationUrl.searchParams.set("scope", config.oidc.scopes.join(" "));
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    return reply.redirect(authorizationUrl.toString());
  });

  app.get("/api/auth/oidc/callback", { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } }, async (request, reply) => {
    try {
      requireOidc();
      const input = z.object({
        code: z.string().min(1).max(5000).optional(),
        state: z.string().min(20).max(500).optional(),
        error: z.string().max(200).optional()
      }).parse(request.query);
      if (input.error || !input.code || !input.state) throw oidcError("The identity provider did not authorize this login", 401);
      const attempt = await consumeAttempt(input.state);
      const metadata = await discover();
      const claims = await exchangeAndVerify(metadata, input.code, attempt.codeVerifier, attempt.nonce);
      const identity = await provisionIdentity(claims);
      await query(
        `INSERT INTO audit_events (organization_id, actor_user_id, action, resource_type, resource_id, metadata, ip_address)
         VALUES ($1, $2, 'auth.oidc.login', 'user', $3, $4, $5)`,
        [identity.organizationId, identity.userId, identity.userId, { issuer: config.oidc.issuer }, request.ip]
      );
      await createSession(identity.userId, reply);
      return reply.redirect(new URL(attempt.returnTo, config.PUBLIC_URL).toString());
    } catch (error) {
      request.log.warn({ err: error }, "OIDC login failed");
      return redirectAuthError(reply, error instanceof Error && error.message.includes("provision") ? "provisioning_denied" : "oidc_failed");
    }
  });
}

async function consumeAttempt(state: string) {
  const result = await query<{ nonce: string; encrypted_code_verifier: string; return_to: string }>(
    `DELETE FROM oidc_login_attempts WHERE state_hash = $1 AND expires_at > now()
     RETURNING nonce, encrypted_code_verifier, return_to`,
    [hashToken(state)]
  );
  const attempt = result.rows[0];
  if (!attempt) throw oidcError("OIDC login state is invalid or expired", 401);
  return { nonce: attempt.nonce, codeVerifier: decryptSecret(attempt.encrypted_code_verifier), returnTo: attempt.return_to };
}

async function exchangeAndVerify(metadata: Metadata, code: string, codeVerifier: string, nonce: string): Promise<Claims> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl(),
    code_verifier: codeVerifier
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (config.oidc.clientAuthMethod === "client_secret_basic") {
    headers.authorization = `Basic ${Buffer.from(`${formEncode(config.oidc.clientId!)}:${formEncode(config.oidc.clientSecret!)}`).toString("base64")}`;
  } else {
    body.set("client_id", config.oidc.clientId!);
    if (config.oidc.clientAuthMethod === "client_secret_post") body.set("client_secret", config.oidc.clientSecret!);
  }
  const token = tokenSchema.parse(await fetchJson(metadata.token_endpoint, { method: "POST", headers, body: body.toString() }));
  const verified = await verifyIdToken(metadata, token.id_token, nonce);
  let merged: Record<string, unknown> = { ...verified };
  if (metadata.userinfo_endpoint && token.access_token) {
    const userinfo = await fetchJson(metadata.userinfo_endpoint, { headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" } });
    if (!userinfo || typeof userinfo !== "object" || (userinfo as Record<string, unknown>).sub !== verified.sub) {
      throw oidcError("OIDC userinfo subject did not match the ID token", 401);
    }
    merged = { ...verified, ...(userinfo as Record<string, unknown>), sub: verified.sub };
  }
  return claimsSchema.parse(merged) as Claims;
}

async function verifyIdToken(metadata: Metadata, idToken: string, nonce: string) {
  const verify = async (forceRefresh: boolean) => {
    const jwks = await getJwks(metadata.jwks_uri, forceRefresh);
    return jwtVerify(idToken, createLocalJWKSet(jwks), {
      issuer: config.oidc.issuer,
      audience: config.oidc.clientId,
      algorithms: config.oidc.signingAlgorithms,
      clockTolerance: 5
    });
  };
  let result;
  try { result = await verify(false); }
  catch { result = await verify(true); }
  if (result.payload.nonce !== nonce) throw oidcError("OIDC nonce did not match", 401);
  if (Array.isArray(result.payload.aud) && result.payload.aud.length > 1 && result.payload.azp !== config.oidc.clientId) {
    throw oidcError("OIDC authorized party did not match this client", 401);
  }
  return result.payload;
}

async function provisionIdentity(rawClaims: Claims) {
  const email = rawClaims.email.toLowerCase();
  const emailDomain = email.split("@")[1] ?? "";
  const verified = rawClaims.email_verified === true;
  if (config.oidc.requireVerifiedEmail && !verified) throw oidcError("OIDC email must be verified", 403);
  if (config.oidc.allowedEmailDomains.length && !config.oidc.allowedEmailDomains.includes(emailDomain)) {
    throw oidcError("OIDC email domain is not allowed", 403);
  }
  const groups = claimStrings(rawClaims, config.oidc.groupsClaim);
  const desiredRole = resolveOidcRole(groups, config.oidc.roleMapping, config.oidc.defaultRole);
  const desiredSlugs = mappedTeamSlugs(groups, config.oidc.teamMapping);
  const name = (rawClaims.name || rawClaims.preferred_username || email.split("@")[0] || "OIDC user").slice(0, 100);

  return transaction(async (client) => {
    const organizationResult = config.oidc.organizationSlug
      ? await client.query<{ id: string }>("SELECT id FROM organizations WHERE slug = $1", [config.oidc.organizationSlug])
      : await client.query<{ id: string }>("SELECT id FROM organizations ORDER BY created_at LIMIT 2");
    if (organizationResult.rows.length !== 1) throw oidcError("OIDC provisioning requires one target organization", 403);
    const organizationId = organizationResult.rows[0]!.id;

    const identityResult = await client.query<{ user_id: string; disabled_at: Date | null }>(
      `SELECT i.user_id, u.disabled_at FROM user_identities i JOIN users u ON u.id = i.user_id
        WHERE i.issuer = $1 AND i.subject = $2 FOR UPDATE`,
      [config.oidc.issuer, rawClaims.sub]
    );
    let userId = identityResult.rows[0]?.user_id;
    if (identityResult.rows[0]?.disabled_at) throw oidcError("OIDC user is disabled", 403);

    if (!userId) {
      const existing = await client.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = lower($1) AND disabled_at IS NULL FOR UPDATE", [email]);
      userId = existing.rows[0]?.id;
      if (userId && !verified) throw oidcError("A verified OIDC email is required to link an existing account", 403);
      if (userId && !config.oidc.allowEmailLinking) throw oidcError("OIDC email linking is not enabled", 403);
      if (!userId) {
        if (!config.oidc.autoProvision) throw oidcError("OIDC user provisioning is not enabled", 403);
        userId = (await client.query<{ id: string }>(
          "INSERT INTO users (email, name, password_hash) VALUES ($1, $2, NULL) RETURNING id",
          [email, name]
        )).rows[0]!.id;
      }
      await client.query(
        `INSERT INTO user_identities (user_id, provider, issuer, subject, email)
         VALUES ($1, 'oidc', $2, $3, $4)`,
        [userId, config.oidc.issuer, rawClaims.sub, email]
      );
    } else {
      await client.query("UPDATE user_identities SET email = $2, last_login_at = now() WHERE issuer = $1 AND subject = $3", [config.oidc.issuer, email, rawClaims.sub]);
      await client.query("UPDATE users SET name = $2 WHERE id = $1", [userId, name]);
    }

    const orgMembership = await client.query<{ organization_id: string; role: Role; source: string }>(
      "SELECT organization_id, role, source FROM memberships WHERE user_id = $1 AND team_id IS NULL FOR UPDATE",
      [userId]
    );
    if (orgMembership.rows[0] && orgMembership.rows[0].organization_id !== organizationId) {
      throw oidcError("OIDC identity belongs to a different organization", 403);
    }
    if (!orgMembership.rows[0]) {
      await client.query(
        "INSERT INTO memberships (organization_id, team_id, user_id, role, source) VALUES ($1, NULL, $2, $3, 'oidc')",
        [organizationId, userId, desiredRole]
      );
    } else if (orgMembership.rows[0].source === "oidc") {
      await client.query("UPDATE memberships SET role = $2 WHERE user_id = $1 AND team_id IS NULL", [userId, desiredRole]);
    }

    const teams = desiredSlugs.length
      ? await client.query<{ id: string; slug: string }>("SELECT id, slug FROM teams WHERE organization_id = $1 AND slug = ANY($2::text[])", [organizationId, desiredSlugs])
      : { rows: [] as Array<{ id: string; slug: string }> };
    if (teams.rows.length !== desiredSlugs.length) throw oidcError("OIDC team mapping references a team that does not exist", 403);
    const desiredTeamIds = teams.rows.map((team) => team.id);
    if (config.oidc.syncTeamMemberships) {
      await client.query(
        "DELETE FROM memberships WHERE user_id = $1 AND organization_id = $2 AND team_id IS NOT NULL AND source = 'oidc' AND NOT (team_id = ANY($3::uuid[]))",
        [userId, organizationId, desiredTeamIds]
      );
    }
    for (const team of teams.rows) {
      await client.query(
        `INSERT INTO memberships (organization_id, team_id, user_id, role, source)
         VALUES ($1, $2, $3, $4, 'oidc')
         ON CONFLICT (organization_id, user_id, team_id) DO UPDATE SET
           role = CASE WHEN memberships.source = 'oidc' THEN excluded.role ELSE memberships.role END,
           source = memberships.source`,
        [organizationId, team.id, userId, desiredRole]
      );
    }
    await client.query("UPDATE user_identities SET last_login_at = now() WHERE issuer = $1 AND subject = $2", [config.oidc.issuer, rawClaims.sub]);
    return { userId, organizationId };
  });
}

async function discover(forceRefresh = false) {
  requireOidc();
  const issuer = config.oidc.issuer!;
  const cached = metadataCache.get(issuer);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.value;
  assertOidcUrl(issuer);
  const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
  const metadata = metadataSchema.parse(await fetchJson(discoveryUrl));
  if (metadata.issuer !== issuer) throw oidcError("OIDC discovery issuer mismatch", 502);
  const endpoints = [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri, metadata.userinfo_endpoint].filter(Boolean) as string[];
  for (const endpoint of endpoints) assertOidcUrl(endpoint, true);
  if (config.NODE_ENV !== "test") await Promise.all(endpoints.map((endpoint) => assertSafeExternalResolution(endpoint, oidcUrlOptions(true))));
  if (metadata.token_endpoint_auth_methods_supported && !metadata.token_endpoint_auth_methods_supported.includes(config.oidc.clientAuthMethod)) {
    throw oidcError("The identity provider does not support the configured client authentication method", 502);
  }
  metadataCache.set(issuer, { value: metadata, expiresAt: Date.now() + 5 * 60_000 });
  return metadata;
}

async function getJwks(url: string, forceRefresh: boolean) {
  const cached = jwksCache.get(url);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.value;
  const value = z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1).max(100) }).parse(await fetchJson(url)) as JSONWebKeySet;
  jwksCache.set(url, { value, expiresAt: Date.now() + 5 * 60_000 });
  return value;
}

async function fetchJson(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let dispatcher: Dispatcher | undefined;
  try {
    let response: Response | UndiciResponse;
    if (config.NODE_ENV === "test") {
      response = await globalThis.fetch(url, { ...init, redirect: "error", signal: controller.signal });
    } else {
      const endpoint = await assertSafeExternalResolution(url, oidcUrlOptions(true));
      const lookup: LookupFunction = (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: endpoint.address, family: endpoint.family }]);
        else callback(null, endpoint.address, endpoint.family);
      };
      dispatcher = new Agent({ connect: { lookup } });
      response = await pinnedFetch(endpoint.url, { ...init, redirect: "error", signal: controller.signal, dispatcher });
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_OIDC_RESPONSE_BYTES) throw oidcError("OIDC response exceeded the size limit", 502);
    const text = await readBoundedText(response);
    if (!response.ok) throw oidcError(`OIDC endpoint returned HTTP ${response.status}`, 502);
    try { return JSON.parse(text) as unknown; }
    catch { throw oidcError("OIDC endpoint returned malformed JSON", 502); }
  } finally {
    clearTimeout(timeout);
    if (dispatcher instanceof Agent) await dispatcher.close();
  }
}

async function readBoundedText(response: Response | UndiciResponse) {
  if (!response.body) throw oidcError("OIDC endpoint returned an empty response", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_OIDC_RESPONSE_BYTES) {
      await reader.cancel();
      throw oidcError("OIDC response exceeded the size limit", 502);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function claimStrings(claims: Record<string, unknown>, path: string) {
  const value = path.split(".").reduce<unknown>((current, part) => current && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined, claims);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

function assertOidcUrl(value: string, allowQuery = false) {
  return assertSafeExternalUrl(value, oidcUrlOptions(allowQuery));
}

function oidcUrlOptions(allowQuery: boolean) {
  return {
    allowPrivate: config.oidc.allowPrivateEndpoints,
    allowHttp: config.oidc.allowInsecureHttp,
    allowQuery,
    label: "OIDC"
  };
}

function requireOidc() {
  if (!config.oidc.enabled || !config.oidc.issuer || !config.oidc.clientId) throw oidcError("OIDC is not configured", 404);
}

function normalizeReturnTo(value?: string) {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) throw oidcError("Invalid OIDC return path", 400);
  const url = new URL(value, config.PUBLIC_URL);
  if (url.origin !== new URL(config.PUBLIC_URL).origin) throw oidcError("Invalid OIDC return path", 400);
  return `${url.pathname}${url.search}${url.hash}`;
}

function callbackUrl() {
  return new URL("/api/auth/oidc/callback", config.PUBLIC_URL).toString();
}

function redirectAuthError(reply: FastifyReply, code: string) {
  const url = new URL("/", config.PUBLIC_URL);
  url.searchParams.set("auth_error", code);
  return reply.redirect(url.toString());
}

function randomValue() {
  return randomBytes(32).toString("base64url");
}

function formEncode(value: string) {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function oidcError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}
