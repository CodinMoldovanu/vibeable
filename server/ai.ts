import { z } from "zod";
import { assertSafeProviderResolution, decryptSecret } from "./security.js";

const editResponseSchema = z.object({
  summary: z.string().min(1).max(2000),
  files: z.array(z.object({
    path: z.string().min(1).max(500),
    content: z.string().max(1_000_000),
    summary: z.string().min(1).max(1000)
  })).min(1).max(30)
});

interface CompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;

export async function generateEdits(input: {
  baseUrl: string;
  encryptedApiKey: string | null;
  model: string;
  userPrompt: string;
  hooks: string[];
  workspaceContext: string;
  skipEndpointResolutionForTests?: boolean;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const baseUrl = input.skipEndpointResolutionForTests ? input.baseUrl.replace(/\/$/, "") : await assertSafeProviderResolution(input.baseUrl);
    const request = async (jsonMode: boolean) => fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(input.encryptedApiKey
            ? { authorization: `Bearer ${decryptSecret(input.encryptedApiKey)}` }
            : {})
        },
        body: JSON.stringify({
        model: input.model,
        temperature: 0.2,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        messages: [
          {
            role: "system",
            content: [
              "You are Vibeable's coding agent. Return one JSON object only.",
              "Schema: {summary:string,files:[{path:string,content:string,summary:string}]}",
              "Only emit complete text files with safe relative paths. Do not include secrets or binary files.",
              ...input.hooks.map((hook) => `Policy hook: ${hook}`)
            ].join("\n")
          },
          {
            role: "user",
            content: `${input.userPrompt}\n\nCurrent workspace:\n${input.workspaceContext}`
          }
        ]
      })
    });
    let response = await request(true);
    let payload = await readProviderResponse(response);
    if (!response.ok && [400, 404, 422].includes(response.status) && /response.?format|json.?mode|unsupported/i.test(payload.error?.message ?? "")) {
      response = await request(false);
      payload = await readProviderResponse(response);
    }
    if (!response.ok) throw new Error(payload.error?.message ?? `AI provider returned HTTP ${response.status}`);
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("AI provider returned no content");
    const normalized = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return {
      result: editResponseSchema.parse(JSON.parse(normalized)),
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
        totalTokens: payload.usage?.total_tokens ??
          (payload.usage?.prompt_tokens ?? 0) + (payload.usage?.completion_tokens ?? 0)
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readProviderResponse(response: Response): Promise<CompletionResponse> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("AI provider response exceeded the size limit");
  if (!response.body) throw new Error("AI provider returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("AI provider response exceeded the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as CompletionResponse;
  } catch {
    if (!response.ok) return { error: { message: text.slice(0, 1000) || `AI provider returned HTTP ${response.status}` } };
    throw new Error("AI provider returned malformed JSON");
  }
}
