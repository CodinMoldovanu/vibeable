import { describe, expect, it } from "vitest";
import { assertSafeProviderUrl, decryptSecret, encryptSecret, hashToken } from "./security.js";

describe("security helpers", () => {
  it("encrypts provider secrets with authenticated encryption", () => {
    const ciphertext = encryptSecret("provider-secret");
    expect(ciphertext).not.toContain("provider-secret");
    expect(decryptSecret(ciphertext)).toBe("provider-secret");
  });

  it("hashes session tokens before persistence", () => {
    expect(hashToken("session-token")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken("session-token")).not.toBe("session-token");
  });

  it("rejects insecure and private provider endpoints by default", () => {
    expect(assertSafeProviderUrl("https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api/v1");
    expect(() => assertSafeProviderUrl("http://127.0.0.1:8000/v1")).toThrow();
    expect(() => assertSafeProviderUrl("https://100.64.0.1/v1")).toThrow();
    expect(() => assertSafeProviderUrl("https://192.0.2.1/v1")).toThrow();
    expect(() => assertSafeProviderUrl("https://198.51.100.1/v1")).toThrow();
    expect(() => assertSafeProviderUrl("https://203.0.113.1/v1")).toThrow();
    expect(() => assertSafeProviderUrl("https://service.home.arpa/v1")).toThrow();
    expect(() => assertSafeProviderUrl("https://[fd00::1]/v1")).toThrow();
    expect(() => assertSafeProviderUrl("https://[2001:db8::1]/v1")).toThrow();
    expect(() => assertSafeProviderUrl("https://[fec0::1]/v1")).toThrow();
    expect(() => assertSafeProviderUrl("https://[ff02::1]/v1")).toThrow();
    expect(() => assertSafeProviderUrl("https://[::ffff:127.0.0.1]/v1")).toThrow();
    expect(() => assertSafeProviderUrl("https://[::ffff:169.254.1.1]/v1")).toThrow();
    expect(() => assertSafeProviderUrl("https://[::ffff:172.16.1.1]/v1")).toThrow();
    expect(() => assertSafeProviderUrl("https://token@example.com/v1")).toThrow("credentials");
  });
});
