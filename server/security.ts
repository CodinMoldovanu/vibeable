import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { config } from "./config.js";

const encryptionKey = createHash("sha256").update(config.MASTER_KEY).digest();
const specialUseIpv4Addresses = new BlockList();
const specialUseIpv6Addresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) specialUseIpv4Addresses.addSubnet(network, prefix, "ipv4");

for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]
] as const) specialUseIpv6Addresses.addSubnet(network, prefix, "ipv6");

export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function stripQueryForLog(value?: string) {
  return value?.split("?", 1)[0];
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
  return assertSafeExternalUrl(value, {
    allowPrivate: config.allowPrivateAiEndpoints,
    allowHttp: config.allowPrivateAiEndpoints,
    allowQuery: false,
    label: "AI provider"
  });
}

export function assertSafeExternalUrl(value: string, options: {
  allowPrivate: boolean;
  allowHttp: boolean;
  allowQuery?: boolean;
  label?: string;
}) {
  const label = options.label ?? "External";
  const url = new URL(value);
  if (url.username || url.password || (!options.allowQuery && url.search) || url.hash) {
    throw new Error(`${label} URLs cannot contain credentials${options.allowQuery ? " or fragments" : ", query parameters, or fragments"}`);
  }
  if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:")) {
    throw new Error(`${label} URLs must use HTTPS`);
  }

  if (isPrivateHost(url.hostname) && !options.allowPrivate) {
    throw new Error(`${label} URL uses a private or reserved address`);
  }

  return url.toString().replace(/\/$/, "");
}

export async function assertSafeProviderResolution(value: string) {
  return assertSafeExternalResolution(value, {
    allowPrivate: config.allowPrivateAiEndpoints,
    allowHttp: config.allowPrivateAiEndpoints,
    allowQuery: false,
    label: "AI provider"
  });
}

export async function assertSafeExternalResolution(value: string, options: {
  allowPrivate: boolean;
  allowHttp: boolean;
  allowQuery?: boolean;
  label?: string;
}) {
  const normalized = assertSafeExternalUrl(value, options);
  const url = new URL(normalized);
  let timer: NodeJS.Timeout | undefined;
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, verbatim: true }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${options.label ?? "External"} DNS lookup timed out`)), 5_000);
    })
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || (!options.allowPrivate && addresses.some((address) => isPrivateHost(address.address)))) {
    throw new Error(`${options.label ?? "External"} hostname resolves to a private or reserved address`);
  }
  const selected = [...addresses].sort((left, right) => left.family - right.family)[0]!;
  return { url: normalized, address: selected.address, family: selected.family };
}

function isPrivateHost(value: string) {
  const host = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "home.arpa" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  const family = isIP(host);
  if (family === 4) return specialUseIpv4Addresses.check(host, "ipv4");
  if (family === 6) return specialUseIpv6Addresses.check(host, "ipv6");
  return false;
}
