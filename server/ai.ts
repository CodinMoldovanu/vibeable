import { z } from "zod";
import { decryptSecret } from "./security.js";

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

export async function generateEdits(input: {
  baseUrl: string;
  encryptedApiKey: string | null;
  model: string;
  userPrompt: string;
  hooks: string[];
  workspaceContext: string;
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
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
        response_format: { type: "json_object" },
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
    const payload = (await response.json()) as CompletionResponse;
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
