import { describe, expect, it } from "vitest";
import { resolveEffectiveAiPolicy } from "./policy.js";
import type { AiPolicy, AiProvider, PromptHook } from "./types.js";

const providers: AiProvider[] = [
  {
    id: "provider-a", name: "A", type: "openai-compatible", baseUrl: "https://a.example/v1",
    apiKeySecretRef: "secret", defaultModel: "model-a", allowedModels: ["model-a", "model-b"],
    supports: { streaming: true, tools: true, vision: false }, scope: "global"
  }
];

const globalPolicy: AiPolicy = {
  id: "global", scope: "global", scopeId: "org", defaultProviderId: "provider-a", defaultModel: "model-a",
  allowedProviderIds: ["provider-a"], allowedModels: ["model-a", "model-b"], monthlyTokenLimit: 1000,
  monthlyCostLimitUsd: 100, allowUserOverride: true
};

describe("resolveEffectiveAiPolicy", () => {
  it("intersects boundaries and orders matching hooks", () => {
    const policies: AiPolicy[] = [globalPolicy, {
      ...globalPolicy, id: "team-policy", scope: "team", scopeId: "team", defaultModel: "model-b",
      allowedModels: ["model-b"], monthlyTokenLimit: 500, monthlyCostLimitUsd: 20
    }];
    const hooks: PromptHook[] = [
      { id: "low", scope: "global", scopeId: "org", phase: "agent:before_edit", priority: 1, enabled: true, mandatory: false, title: "low", prompt: "low" },
      { id: "high", scope: "team", scopeId: "team", phase: "agent:before_edit", priority: 10, enabled: true, mandatory: true, title: "high", prompt: "high" }
    ];
    const result = resolveEffectiveAiPolicy({ orgId: "org", teamId: "team", userId: "user", projectId: "project", phase: "agent:before_edit", policies, providers, promptHooks: hooks });
    expect(result.model).toBe("model-b");
    expect(result.monthlyTokenLimit).toBe(500);
    expect(result.monthlyCostLimitUsd).toBe(20);
    expect(result.hooks.map((hook) => hook.id)).toEqual(["high", "low"]);
  });

  it("fails closed without a global policy", () => {
    expect(() => resolveEffectiveAiPolicy({ orgId: "org", teamId: "team", userId: "user", projectId: "project", phase: "agent:before_edit", policies: [], providers, promptHooks: [] })).toThrow("global AI policy");
  });

  it("honors global user-override controls without dropping user budget limits", () => {
    const policies: AiPolicy[] = [{ ...globalPolicy, allowUserOverride: false }, {
      ...globalPolicy,
      id: "user-policy",
      scope: "user",
      scopeId: "user",
      defaultModel: "model-b",
      monthlyTokenLimit: 100,
      monthlyCostLimitUsd: 10
    }];
    const result = resolveEffectiveAiPolicy({
      orgId: "org", teamId: "team", userId: "user", projectId: "project",
      phase: "agent:before_edit", policies, providers, promptHooks: []
    });
    expect(result.model).toBe("model-a");
    expect(result.monthlyTokenLimit).toBe(100);
    expect(result.monthlyCostLimitUsd).toBe(10);
  });
});
