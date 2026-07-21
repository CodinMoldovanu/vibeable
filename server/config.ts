import { resolve } from "node:path";
import { z } from "zod";

const optionalUrl = z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional());
const optionalText = (schema: z.ZodString) => z.preprocess((value) => value === "" ? undefined : value, schema.optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_URL: z.string().min(1).default("postgres://vibeable:vibeable@127.0.0.1:5432/vibeable"),
  DATABASE_SSL: z.enum(["disable", "require", "verify-full"]).default("disable"),
  PUBLIC_URL: z.string().url().default("http://127.0.0.1:8787"),
  DATA_DIR: z.string().default(".vibeable"),
  MASTER_KEY: z.string().min(32).default("development-only-master-key-change-me"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  LOCAL_LOGIN_ENABLED: z.enum(["true", "false"]).default("true"),
  OIDC_ENABLED: z.enum(["true", "false"]).default("false"),
  OIDC_ISSUER: optionalUrl,
  OIDC_CLIENT_ID: optionalText(z.string().min(1).max(500)),
  OIDC_CLIENT_SECRET: optionalText(z.string().max(2000)),
  OIDC_CLIENT_AUTH_METHOD: z.enum(["client_secret_basic", "client_secret_post", "none"]).default("client_secret_basic"),
  OIDC_DISPLAY_NAME: z.string().trim().min(1).max(80).default("Company SSO"),
  OIDC_SCOPES: z.string().trim().min(6).default("openid profile email groups"),
  OIDC_ORGANIZATION_SLUG: optionalText(z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/)),
  OIDC_AUTO_PROVISION: z.enum(["true", "false"]).default("false"),
  OIDC_ALLOW_EMAIL_LINKING: z.enum(["true", "false"]).default("false"),
  OIDC_DEFAULT_ROLE: z.enum(["admin", "developer", "reviewer", "viewer"]).default("viewer"),
  OIDC_SIGNING_ALGORITHMS: z.string().trim().min(1).default("RS256,ES256"),
  OIDC_GROUPS_CLAIM: z.string().trim().min(1).max(200).default("groups"),
  OIDC_ROLE_MAPPING: z.string().default("{}"),
  OIDC_TEAM_MAPPING: z.string().default("{}"),
  OIDC_SYNC_TEAM_MEMBERSHIPS: z.enum(["true", "false"]).default("true"),
  OIDC_ALLOWED_EMAIL_DOMAINS: z.string().default(""),
  OIDC_REQUIRE_VERIFIED_EMAIL: z.enum(["true", "false"]).default("true"),
  OIDC_ALLOW_PRIVATE_ENDPOINTS: z.enum(["true", "false"]).default("false"),
  OIDC_ALLOW_INSECURE_HTTP: z.enum(["true", "false"]).default("false"),
  REQUIRE_SEPARATE_APPROVER: z.enum(["true", "false"]).default("true"),
  EXECUTION_MODE: z.enum(["disabled", "local", "docker"]).default("disabled"),
  DEPLOYMENT_EXECUTION_MODE: z.enum(["disabled", "local"]).default("disabled"),
  ALLOW_PRIVATE_AI_ENDPOINTS: z.enum(["true", "false"]).default("false"),
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
});

const values = schema.parse(process.env);

if (values.OIDC_ENABLED === "true" && (!values.OIDC_ISSUER || !values.OIDC_CLIENT_ID)) {
  throw new Error("OIDC_ISSUER and OIDC_CLIENT_ID are required when OIDC_ENABLED=true");
}
if (values.OIDC_CLIENT_AUTH_METHOD !== "none" && values.OIDC_ENABLED === "true" && !values.OIDC_CLIENT_SECRET) {
  throw new Error("OIDC_CLIENT_SECRET is required for the configured OIDC client authentication method");
}
if (values.OIDC_ENABLED === "true" && !values.OIDC_SCOPES.split(/\s+/).includes("openid")) {
  throw new Error("OIDC_SCOPES must include openid");
}

function parseStringMap(value: string, name: string): Record<string, string> {
  if (!value.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`${name} must be a JSON object`); }
  const result = z.record(z.string(), z.string()).parse(parsed);
  const normalized: Record<string, string> = {};
  for (const [key, item] of Object.entries(result)) {
    if (key.trim() && item.trim()) normalized[key.trim()] = item.trim();
  }
  return normalized;
}

const oidcRoleMapping = parseStringMap(values.OIDC_ROLE_MAPPING, "OIDC_ROLE_MAPPING");
for (const role of Object.values(oidcRoleMapping)) {
  if (!["admin", "developer", "reviewer", "viewer"].includes(role)) {
    throw new Error("OIDC_ROLE_MAPPING values must be admin, developer, reviewer, or viewer");
  }
}
const oidcTeamMapping = parseStringMap(values.OIDC_TEAM_MAPPING, "OIDC_TEAM_MAPPING");
for (const slug of Object.values(oidcTeamMapping)) {
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) throw new Error("OIDC_TEAM_MAPPING values must be valid team slugs");
}
const oidcSigningAlgorithms = values.OIDC_SIGNING_ALGORITHMS.split(",").map((value) => value.trim()).filter(Boolean);
for (const algorithm of oidcSigningAlgorithms) {
  if (!/^(?:RS|PS|ES)(?:256|384|512)$|^EdDSA$/.test(algorithm)) throw new Error("OIDC_SIGNING_ALGORITHMS must contain asymmetric signing algorithms");
}

if (values.NODE_ENV === "production" && values.MASTER_KEY === "development-only-master-key-change-me") {
  throw new Error("MASTER_KEY must be changed in production");
}

const publicUrl = new URL(values.PUBLIC_URL);
const cookieSecure = values.COOKIE_SECURE ? values.COOKIE_SECURE === "true" : values.NODE_ENV === "production";
const loopbackPublicUrl = ["localhost", "127.0.0.1", "::1"].includes(publicUrl.hostname);
if (values.NODE_ENV === "production" && publicUrl.protocol !== "https:" && !loopbackPublicUrl) {
  throw new Error("PUBLIC_URL must use HTTPS in production");
}
if (values.NODE_ENV === "production" && !cookieSecure && !loopbackPublicUrl) {
  throw new Error("COOKIE_SECURE cannot be disabled in production");
}

export const config = {
  ...values,
  DATA_DIR: resolve(values.DATA_DIR),
  localLoginEnabled: values.LOCAL_LOGIN_ENABLED === "true",
  oidc: {
    enabled: values.OIDC_ENABLED === "true",
    issuer: values.OIDC_ISSUER,
    clientId: values.OIDC_CLIENT_ID,
    clientSecret: values.OIDC_CLIENT_SECRET,
    clientAuthMethod: values.OIDC_CLIENT_AUTH_METHOD,
    displayName: values.OIDC_DISPLAY_NAME,
    scopes: values.OIDC_SCOPES.split(/\s+/).filter(Boolean),
    organizationSlug: values.OIDC_ORGANIZATION_SLUG,
    autoProvision: values.OIDC_AUTO_PROVISION === "true",
    allowEmailLinking: values.OIDC_ALLOW_EMAIL_LINKING === "true",
    defaultRole: values.OIDC_DEFAULT_ROLE,
    signingAlgorithms: oidcSigningAlgorithms,
    groupsClaim: values.OIDC_GROUPS_CLAIM,
    roleMapping: oidcRoleMapping,
    teamMapping: oidcTeamMapping,
    syncTeamMemberships: values.OIDC_SYNC_TEAM_MEMBERSHIPS === "true",
    allowedEmailDomains: values.OIDC_ALLOWED_EMAIL_DOMAINS.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
    requireVerifiedEmail: values.OIDC_REQUIRE_VERIFIED_EMAIL === "true",
    allowPrivateEndpoints: values.OIDC_ALLOW_PRIVATE_ENDPOINTS === "true",
    allowInsecureHttp: values.OIDC_ALLOW_INSECURE_HTTP === "true"
  },
  allowPrivateAiEndpoints: values.ALLOW_PRIVATE_AI_ENDPOINTS === "true",
  requireSeparateApprover: values.REQUIRE_SEPARATE_APPROVER === "true",
  cookieSecure,
  trustProxy: values.TRUST_PROXY === "true"
};
