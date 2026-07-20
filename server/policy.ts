import type { AgentPhase, AiPolicy, AiProvider, PromptHook } from "../src/domain/types.js";
import { resolveEffectiveAiPolicy } from "../src/domain/policy.js";
import { query } from "./db.js";

interface ProviderRow {
  id: string;
  name: string;
  baseUrl: string;
  encryptedApiKey: string | null;
  defaultModel: string;
  allowedModels: string[];
  inputCostPerMillion: string;
  outputCostPerMillion: string;
}

export async function resolvePolicy(input: {
  organizationId: string;
  teamId: string;
  userId: string;
  projectId: string;
  phase: AgentPhase;
}) {
  const [providerResult, policyResult, hookResult] = await Promise.all([
    query<ProviderRow>(
      `SELECT id, name, base_url AS "baseUrl", encrypted_api_key AS "encryptedApiKey",
              default_model AS "defaultModel", allowed_models AS "allowedModels",
              input_cost_per_million AS "inputCostPerMillion", output_cost_per_million AS "outputCostPerMillion"
         FROM ai_providers WHERE organization_id = $1 AND enabled = true`,
      [input.organizationId]
    ),
    query<{
      id: string; scopeType: AiPolicy["scope"]; scopeId: string; defaultProviderId: string;
      defaultModel: string; allowedProviderIds: string[]; allowedModels: string[];
      monthlyTokenLimit: string; monthlyCostLimitUsd: string; allowUserOverride: boolean;
      requireApprovalFor: AgentPhase[];
    }>(
      `SELECT id, scope_type AS "scopeType", scope_id AS "scopeId", default_provider_id AS "defaultProviderId",
              default_model AS "defaultModel", allowed_provider_ids AS "allowedProviderIds", allowed_models AS "allowedModels",
              monthly_token_limit AS "monthlyTokenLimit", monthly_cost_limit_usd AS "monthlyCostLimitUsd",
              allow_user_override AS "allowUserOverride", require_approval_for AS "requireApprovalFor"
         FROM ai_policies
        WHERE organization_id = $1 AND ((scope_type = 'global' AND scope_id = $1) OR
          (scope_type = 'team' AND scope_id = $2) OR (scope_type = 'user' AND scope_id = $3) OR
          (scope_type = 'project' AND scope_id = $4))`,
      [input.organizationId, input.teamId, input.userId, input.projectId]
    ),
    query<{
      id: string; scopeType: PromptHook["scope"]; scopeId: string; phase: AgentPhase; priority: number;
      enabled: boolean; mandatory: boolean; title: string; prompt: string;
    }>(
      `SELECT id, scope_type AS "scopeType", scope_id AS "scopeId", phase, priority, enabled, mandatory, title, prompt
         FROM prompt_hooks
        WHERE organization_id = $1 AND enabled = true AND phase = $5 AND ((scope_type = 'global' AND scope_id = $1) OR
          (scope_type = 'team' AND scope_id = $2) OR (scope_type = 'user' AND scope_id = $3) OR
          (scope_type = 'project' AND scope_id = $4))`,
      [input.organizationId, input.teamId, input.userId, input.projectId, input.phase]
    )
  ]);

  if (!providerResult.rows.length || !policyResult.rows.some((row) => row.scopeType === "global")) {
    throw Object.assign(new Error("No effective AI provider/policy is configured"), { statusCode: 409 });
  }

  const rawProviders = providerResult.rows;
  const providers: AiProvider[] = rawProviders.map((row) => ({
    id: row.id,
    name: row.name,
    type: "openai-compatible",
    baseUrl: row.baseUrl,
    apiKeySecretRef: row.id,
    defaultModel: row.defaultModel,
    allowedModels: row.allowedModels,
    supports: { streaming: true, tools: true, vision: false },
    scope: "global"
  }));
  const policies: AiPolicy[] = policyResult.rows.map((row) => ({
    id: row.id,
    scope: row.scopeType,
    scopeId: row.scopeId,
    defaultProviderId: row.defaultProviderId,
    defaultModel: row.defaultModel,
    allowedProviderIds: row.allowedProviderIds,
    allowedModels: row.allowedModels,
    monthlyTokenLimit: Number(row.monthlyTokenLimit),
    monthlyCostLimitUsd: Number(row.monthlyCostLimitUsd),
    allowUserOverride: row.allowUserOverride,
    requireApprovalFor: row.requireApprovalFor
  }));
  const promptHooks: PromptHook[] = hookResult.rows.map((row) => ({ ...row, scope: row.scopeType }));
  const effective = resolveEffectiveAiPolicy({
    orgId: input.organizationId,
    teamId: input.teamId,
    userId: input.userId,
    projectId: input.projectId,
    phase: input.phase,
    policies,
    providers,
    promptHooks
  });
  const rawProvider = rawProviders.find((provider) => provider.id === effective.provider.id)!;
  return {
    ...effective,
    boundaries: policies.map((policy) => ({
      scope: policy.scope,
      tokenLimit: policy.monthlyTokenLimit,
      costLimit: policy.monthlyCostLimitUsd
    })),
    encryptedApiKey: rawProvider.encryptedApiKey,
    inputCostPerMillion: Number(rawProvider.inputCostPerMillion),
    outputCostPerMillion: Number(rawProvider.outputCostPerMillion)
  };
}

export async function assertBudget(input: {
  organizationId: string;
  teamId: string;
  userId: string;
  projectId: string;
  boundaries: Array<{ scope: "global" | "team" | "user" | "project"; tokenLimit: number; costLimit: number }>;
  providerHasCost: boolean;
}) {
  const result = await query<{ scope: "global" | "team" | "user" | "project"; tokens: string; cost: string }>(
    `WITH current_usage AS (
       SELECT * FROM token_usage_events WHERE organization_id = $1 AND completed_at >= date_trunc('month', now())
     )
     SELECT 'global' AS scope, coalesce(sum(total_tokens),0)::text AS tokens, coalesce(sum(estimated_cost_usd),0)::text AS cost FROM current_usage
     UNION ALL SELECT 'team', coalesce(sum(total_tokens),0)::text, coalesce(sum(estimated_cost_usd),0)::text FROM current_usage WHERE team_id=$2
     UNION ALL SELECT 'user', coalesce(sum(total_tokens),0)::text, coalesce(sum(estimated_cost_usd),0)::text FROM current_usage WHERE user_id=$3
     UNION ALL SELECT 'project', coalesce(sum(total_tokens),0)::text, coalesce(sum(estimated_cost_usd),0)::text FROM current_usage WHERE project_id=$4`,
    [input.organizationId, input.teamId, input.userId, input.projectId]
  );
  for (const boundary of input.boundaries) {
    const usage = result.rows.find((row) => row.scope === boundary.scope) ?? { tokens: "0", cost: "0" };
    const tokenExhausted = Number(usage.tokens) >= boundary.tokenLimit;
    const costExhausted = boundary.costLimit === 0
      ? input.providerHasCost
      : Number(usage.cost) >= boundary.costLimit;
    if (tokenExhausted || costExhausted) {
      throw Object.assign(new Error(`Monthly AI budget exhausted at ${boundary.scope} scope`), { statusCode: 429 });
    }
  }
}
