import { resolve } from "node:path";
import { z } from "zod";

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
  REQUIRE_SEPARATE_APPROVER: z.enum(["true", "false"]).default("true"),
  EXECUTION_MODE: z.enum(["disabled", "local", "docker"]).default("disabled"),
  DEPLOYMENT_EXECUTION_MODE: z.enum(["disabled", "local"]).default("disabled"),
  ALLOW_PRIVATE_AI_ENDPOINTS: z.enum(["true", "false"]).default("false"),
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
});

const values = schema.parse(process.env);

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
  allowPrivateAiEndpoints: values.ALLOW_PRIVATE_AI_ENDPOINTS === "true",
  requireSeparateApprover: values.REQUIRE_SEPARATE_APPROVER === "true",
  cookieSecure,
  trustProxy: values.TRUST_PROXY === "true"
};
