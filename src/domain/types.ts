export type ScopeType = "global" | "team" | "user" | "project";

export type AgentPhase =
  | "project:create"
  | "agent:before_plan"
  | "agent:before_edit"
  | "agent:after_edit"
  | "agent:after_error"
  | "agent:before_test"
  | "agent:after_test_failure"
  | "deploy:prepare"
  | "deploy:preflight"
  | "deploy:post_success"
  | "deploy:post_failure"
  | "summarize_logs"
  | "classify_error"
  | "generate_commit_message"
  | "database_migration"
  | "production_deploy_prepare";

export type Role = "owner" | "admin" | "developer" | "reviewer" | "viewer";

export type Permission =
  | "org:manage"
  | "team:update"
  | "project:create"
  | "project:read"
  | "project:update"
  | "agent:run"
  | "agent:approve_changes"
  | "deployment:create"
  | "deployment:approve"
  | "secret:update"
  | "ai_policy:update"
  | "metrics:read_global"
  | "metrics:read_team"
  | "metrics:read_project"
  | "metrics:read_user"
  | "audit:read";

export interface Organization {
  id: string;
  name: string;
}

export interface Team {
  id: string;
  orgId: string;
  name: string;
  tokenLimit: number;
}

export interface User {
  id: string;
  orgId: string;
  teamId: string;
  name: string;
  email: string;
  role: Role;
}

export interface Project {
  id: string;
  orgId: string;
  teamId: string;
  ownerId: string;
  name: string;
  templateId: string;
  environment: "development" | "staging" | "production";
  status: "draft" | "building" | "ready" | "deployed";
  previewUrl: string;
  lastRunId: string;
}

export interface AiProvider {
  id: string;
  name: string;
  type: "openai-compatible" | "openrouter" | "local";
  baseUrl: string;
  apiKeySecretRef: string;
  defaultModel: string;
  allowedModels: string[];
  supports: {
    streaming: boolean;
    tools: boolean;
    vision: boolean;
  };
  scope: ScopeType;
}

export interface AiPolicy {
  id: string;
  scope: ScopeType;
  scopeId: string;
  defaultProviderId: string;
  defaultModel: string;
  allowedProviderIds: string[];
  allowedModels: string[];
  monthlyTokenLimit: number;
  monthlyCostLimitUsd: number;
  allowUserOverride?: boolean;
  enforceAllowedModels?: boolean;
  requireApprovalFor?: AgentPhase[];
}

export interface PromptHook {
  id: string;
  scope: ScopeType;
  scopeId: string;
  phase: AgentPhase;
  priority: number;
  enabled: boolean;
  mandatory: boolean;
  title: string;
  prompt: string;
}

export interface EffectiveAiPolicy {
  provider: AiProvider;
  model: string;
  allowedProviderIds: string[];
  allowedModels: string[];
  monthlyTokenLimit: number;
  monthlyCostLimitUsd: number;
  requireApproval: boolean;
  hooks: PromptHook[];
}

export interface TokenUsageEvent {
  id: string;
  orgId: string;
  teamId: string;
  userId: string;
  projectId: string;
  runId: string;
  phase: AgentPhase;
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  requestCompletedAt: string;
}

export interface AgentRun {
  id: string;
  projectId: string;
  userId: string;
  phase: AgentPhase;
  prompt: string;
  status: "waiting_approval" | "queued" | "planning" | "editing" | "testing" | "ready" | "failed";
  providerId: string;
  model: string;
  totalTokens: number;
  estimatedCostUsd: number;
  appliedHookIds: string[];
  events: string[];
  changedFiles: ChangedFile[];
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  summary: string;
}

export interface Deployment {
  id: string;
  projectId: string;
  environment: Project["environment"];
  status: "not_started" | "preflight" | "waiting_approval" | "deployed";
  checks: DeploymentCheck[];
}

export interface DeploymentCheck {
  id: string;
  label: string;
  status: "pending" | "running" | "passed" | "failed";
}

export interface UsageSummary {
  label: string;
  totalTokens: number;
  estimatedCostUsd: number;
  runs: number;
}
