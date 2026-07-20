import type {
  AgentPhase,
  AiPolicy,
  AiProvider,
  EffectiveAiPolicy,
  PromptHook
} from "./types.js";

interface ResolvePolicyArgs {
  orgId: string;
  teamId: string;
  userId: string;
  projectId: string;
  phase: AgentPhase;
  policies: AiPolicy[];
  providers: AiProvider[];
  promptHooks: PromptHook[];
}

export function resolveEffectiveAiPolicy({
  orgId,
  teamId,
  userId,
  projectId,
  phase,
  policies,
  providers,
  promptHooks
}: ResolvePolicyArgs): EffectiveAiPolicy {
  const byScope = {
    global: policies.find((policy) => policy.scope === "global" && policy.scopeId === orgId),
    team: policies.find((policy) => policy.scope === "team" && policy.scopeId === teamId),
    user: policies.find((policy) => policy.scope === "user" && policy.scopeId === userId),
    project: policies.find((policy) => policy.scope === "project" && policy.scopeId === projectId)
  };

  const global = byScope.global;
  if (!global) {
    throw new Error("A global AI policy is required");
  }
  const chain = [global, byScope.team, byScope.user, byScope.project].filter(Boolean) as AiPolicy[];
  const userOverrideAllowed = global.allowUserOverride && (byScope.team?.allowUserOverride ?? true);
  const defaults = chain.reduce(
    (acc, policy) => {
      const canOverrideDefaults = policy.scope !== "user" || userOverrideAllowed;

      return {
        providerId: canOverrideDefaults ? policy.defaultProviderId || acc.providerId : acc.providerId,
        model: canOverrideDefaults ? policy.defaultModel || acc.model : acc.model,
        tokenLimit: Math.min(acc.tokenLimit, policy.monthlyTokenLimit),
        costLimit: Math.min(acc.costLimit, policy.monthlyCostLimitUsd),
        requireApproval:
          acc.requireApproval || Boolean(policy.requireApprovalFor?.includes(phase))
      };
    },
    {
      providerId: global.defaultProviderId,
      model: global.defaultModel,
      tokenLimit: global.monthlyTokenLimit,
      costLimit: global.monthlyCostLimitUsd,
      requireApproval: false
    }
  );

  const constrainedProviders = intersectAll(chain.map((policy) => policy.allowedProviderIds));
  const constrainedModels = intersectAll(chain.map((policy) => policy.allowedModels));
  const providerId = constrainedProviders.includes(defaults.providerId)
    ? defaults.providerId
    : constrainedProviders[0];
  const model = constrainedModels.includes(defaults.model) ? defaults.model : constrainedModels[0];
  if (!providerId || !model) {
    throw new Error("AI policy scopes have no allowed provider/model intersection");
  }
  const provider = providers.find((item) => item.id === providerId);
  if (!provider) {
    throw new Error(`Configured AI provider is unavailable: ${providerId}`);
  }
  const hooks = promptHooks
    .filter((hook) => {
      const matchingScope =
        (hook.scope === "global" && hook.scopeId === orgId) ||
        (hook.scope === "team" && hook.scopeId === teamId) ||
        (hook.scope === "user" && hook.scopeId === userId) ||
        (hook.scope === "project" && hook.scopeId === projectId);

      return hook.enabled && hook.phase === phase && matchingScope;
    })
    .sort((left, right) => right.priority - left.priority);

  return {
    provider,
    model,
    allowedProviderIds: constrainedProviders,
    allowedModels: constrainedModels,
    monthlyTokenLimit: defaults.tokenLimit,
    monthlyCostLimitUsd: defaults.costLimit,
    requireApproval: defaults.requireApproval,
    hooks
  };
}

function intersectAll(values: string[][]) {
  if (values.length === 0) {
    return [];
  }

  return values.reduce((acc, current) => acc.filter((value) => current.includes(value)));
}
