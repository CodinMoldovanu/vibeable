import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "./config.js";

const encryptionKey = createHash("sha256").update(config.MASTER_KEY).digest();

export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

export function decryptSecret(value: string) {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export function assertSafeProviderUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(config.allowPrivateAiEndpoints && url.protocol === "http:")) {
    throw new Error("AI provider URLs must use HTTPS");
  }

  const privateHost = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[?::1\]?)/.test(url.hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname);
  if (privateHost && !config.allowPrivateAiEndpoints) {
    throw new Error("Private AI endpoints require ALLOW_PRIVATE_AI_ENDPOINTS=true");
  }

  return url.toString().replace(/\/$/, "");
}
