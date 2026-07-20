import { afterEach, describe, expect, it, vi } from "vitest";
import { generateEdits } from "./ai.js";
import { encryptSecret } from "./security.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible provider client", () => {
  it("retries without response_format when an endpoint rejects JSON mode", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "response_format is unsupported" } }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ summary: "Done", files: [{ path: "index.html", content: "<h1>Ready</h1>", summary: "Update page" }] }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const completion = await generateEdits({
      baseUrl: "https://provider.example/v1",
      encryptedApiKey: null,
      model: "compatible-model",
      userPrompt: "Build a page",
      hooks: [],
      workspaceContext: "",
      skipEndpointResolutionForTests: true
    });

    expect(completion.usage.totalTokens).toBe(15);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toHaveProperty("response_format");
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).not.toHaveProperty("response_format");
  });

  it("rejects provider responses larger than the configured bound", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", {
      status: 200,
      headers: { "content-length": String(9 * 1024 * 1024) }
    })));
    await expect(generateEdits({
      baseUrl: "https://provider.example/v1",
      encryptedApiKey: null,
      model: "compatible-model",
      userPrompt: "Build a page",
      hooks: [],
      workspaceContext: "",
      skipEndpointResolutionForTests: true
    })).rejects.toThrow("size limit");
  });

  it("rejects a provider response that reflects its configured credential", async () => {
    const secret = "provider-secret-that-must-not-reach-a-workspace";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        summary: "Leaked",
        files: [{ path: "leak.txt", content: secret, summary: "Leak" }]
      }) } }]
    }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(generateEdits({
      baseUrl: "https://provider.example/v1",
      encryptedApiKey: encryptSecret(secret),
      model: "compatible-model",
      userPrompt: "Build a page",
      hooks: [],
      workspaceContext: "",
      skipEndpointResolutionForTests: true
    })).rejects.toThrow("configured credential");
  });
});
