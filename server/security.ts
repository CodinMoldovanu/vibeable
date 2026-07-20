import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("AI provider URLs cannot contain credentials, query parameters, or fragments");
  }
  if (url.protocol !== "https:" && !(config.allowPrivateAiEndpoints && url.protocol === "http:")) {
    throw new Error("AI provider URLs must use HTTPS");
  }

  if (isPrivateHost(url.hostname) && !config.allowPrivateAiEndpoints) {
    throw new Error("Private AI endpoints require ALLOW_PRIVATE_AI_ENDPOINTS=true");
  }

  return url.toString().replace(/\/$/, "");
}

export async function assertSafeProviderResolution(value: string) {
  const normalized = assertSafeProviderUrl(value);
  if (config.allowPrivateAiEndpoints) return normalized;
  const url = new URL(normalized);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((address) => isPrivateHost(address.address))) {
    throw new Error("AI provider hostname resolves to a private or reserved address");
  }
  return normalized;
}

function isPrivateHost(value: string) {
  const host = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const family = isIP(host);
  if (family === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a! >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (family === 6) {
    return host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") ||
      /^fe[89ab]/.test(host) || host.startsWith("::ffff:127.") || host.startsWith("::ffff:10.") ||
      host.startsWith("::ffff:192.168.");
  }
  return false;
}
