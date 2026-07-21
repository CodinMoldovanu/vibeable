import type { AgentPhase } from "../src/domain/types.js";
import { generateEdits } from "./ai.js";
import { config } from "./config.js";
import { query, transaction } from "./db.js";
import { publishRunEvent } from "./events.js";
import { assertBudget, resolvePolicy } from "./policy.js";
import { getProjectGitSettings, pushRunBranches } from "./project-git.js";
import { projectCapabilityContext, projectRuntimeEnvironment, recordProjectLog } from "./resources.js";
import { resolveStackProfile, stackProfilePrompt, validateStackProfile } from "./stacks.js";
import { abortRunBranch, applyEdits, commitRun, ensureWorkspace, finalizeRunBranch, prepareRunBranch, verifyWorkspace, workspaceContext } from "./workspace.js";

interface RunRow {
  id: string;
  organizationId: string;
  teamId: string;
  projectId: string;
  projectName: string;
  userId: string;
  phase: AgentPhase;
  prompt: string;
  requestedProviderId: string | null;
  requestedModel: string | null;
  targetBranch: string;
  workerId: string | null;
}

export function enqueueRun(runId: string) {
  setImmediate(() => void executeRun(runId));
}

export async function executeRun(runId: string) {
  let runDirectory: string | undefined;
  let runBranch: string | undefined;
  let targetBranch = "main";
  try {
    const runResult = await query<RunRow>(
      `SELECT r.id, r.organization_id AS "organizationId", r.team_id AS "teamId", r.project_id AS "projectId",
              p.name AS "projectName", r.user_id AS "userId", r.phase, r.prompt,
              r.provider_id AS "requestedProviderId", r.model AS "requestedModel",
              r.target_branch AS "targetBranch", r.worker_id AS "workerId"
         FROM agent_runs r JOIN projects p ON p.id = r.project_id WHERE r.id = $1`,
      [runId]
    );
    const run = runResult.rows[0];
    if (!run) return;
    targetBranch = run.targetBranch;

    await setStatus(run.id, "planning", 8, "Preparing project context");
    await recordRunEvent(run.id, "policy", "Preparing policy, resources, logs, and workspace context");
    const policy = await resolvePolicy({
      organizationId: run.organizationId,
      teamId: run.teamId,
      userId: run.userId,
      projectId: run.projectId,
      phase: run.phase,
      providerId: run.requestedProviderId ?? undefined,
      model: run.requestedModel ?? undefined
    });
    await assertBudget({
      organizationId: run.organizationId,
      teamId: run.teamId,
      userId: run.userId,
      projectId: run.projectId,
      boundaries: policy.boundaries,
      providerHasCost: policy.inputCostPerMillion > 0 || policy.outputCostPerMillion > 0
    });
    await query("UPDATE agent_runs SET provider_id = $2, model = $3 WHERE id = $1", [run.id, policy.provider.id, policy.model]);
    await recordRunEvent(run.id, "provider", `Selected ${policy.provider.name} / ${policy.model}`, {
      hookCount: policy.hooks.length
    });

    const directory = await ensureWorkspace(run.projectId, run.projectName);
    runDirectory = directory;
    const gitSettings = await getProjectGitSettings(run.organizationId, run.projectId);
    runBranch = await prepareRunBranch(directory, run.id, run.targetBranch, gitSettings?.branchPrefix ?? "");
    const stackProfile = await resolveStackProfile({ organizationId: run.organizationId, teamId: run.teamId, projectId: run.projectId });
    await recordRunEvent(run.id, "workspace", `Working on ${run.targetBranch}${stackProfile ? ` with stack profile ${stackProfile.name}` : ""}`, {
      targetBranch: run.targetBranch, runBranch, stackProfileId: stackProfile?.id
    });
    const runtimeEnvironment = await projectRuntimeEnvironment(run.organizationId, run.projectId);
    const changedFiles = new Map<string, { path: string; additions: number; deletions: number; summary: string }>();
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let estimatedCost = 0;
    let verification = { ok: false, output: "Verification did not run." };
    let finalSummary = "Run completed";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const capabilities = await projectCapabilityContext(run.organizationId, run.projectId);
      const context = await workspaceContext(directory);
      const repairPrompt = attempt === 0
        ? run.prompt
        : `Repair the implementation produced for this request: ${run.prompt}\n\nVerification failed with:\n${verification.output}`;
      await setStatus(run.id, "editing", attempt === 0 ? 22 : 68,
        attempt === 0 ? `Waiting for ${policy.provider.name}` : `Repairing with ${policy.provider.name}`);
      await recordRunEvent(run.id, attempt === 0 ? "agent" : "repair",
        attempt === 0
          ? `Building with ${policy.provider.name} / ${policy.model}`
          : `Sending verification logs back to ${policy.model} for repair`,
        { attempt: attempt + 1 });
      const completion = await generateEdits({
        baseUrl: policy.provider.baseUrl,
        encryptedApiKey: policy.encryptedApiKey,
        model: policy.model,
        userPrompt: repairPrompt,
        hooks: policy.hooks.map((hook) => hook.prompt),
        workspaceContext: context,
        capabilityContext: `${capabilities.prompt}\n\n${stackProfilePrompt(stackProfile)}`,
        skipEndpointResolutionForTests: config.NODE_ENV === "test"
      });
      finalSummary = completion.result.summary;
      const attemptCost =
        completion.usage.inputTokens / 1_000_000 * policy.inputCostPerMillion +
        completion.usage.outputTokens / 1_000_000 * policy.outputCostPerMillion;
      usage.inputTokens += completion.usage.inputTokens;
      usage.outputTokens += completion.usage.outputTokens;
      usage.totalTokens += completion.usage.totalTokens;
      estimatedCost += attemptCost;
      await transaction(async (client) => {
        await client.query(
          `UPDATE agent_runs SET input_tokens=$2, output_tokens=$3, total_tokens=$4, estimated_cost_usd=$5 WHERE id=$1`,
          [run.id, usage.inputTokens, usage.outputTokens, usage.totalTokens, estimatedCost]
        );
        await client.query(
          `INSERT INTO token_usage_events
            (organization_id, team_id, user_id, project_id, run_id, provider_id, model, phase,
             input_tokens, output_tokens, total_tokens, estimated_cost_usd)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [run.organizationId, run.teamId, run.userId, run.projectId, run.id, policy.provider.id, policy.model,
            run.phase, completion.usage.inputTokens, completion.usage.outputTokens, completion.usage.totalTokens, attemptCost]
        );
      });

      for (const [index, file] of completion.result.files.entries()) {
        const [change] = await applyEdits(directory, [file]);
        if (!change) continue;
        changedFiles.set(change.path, change);
        const progress = Math.min(attempt === 0 ? 58 : 82, (attempt === 0 ? 38 : 72) + Math.round((index + 1) / completion.result.files.length * 20));
        await setStatus(run.id, "editing", progress, `Updating ${change.path}`);
        await recordRunEvent(run.id, "file", `Updated ${change.path}`, {
          path: change.path, summary: change.summary, index: index + 1, total: completion.result.files.length
        });
      }

      await setStatus(run.id, "testing", attempt === 0 ? 62 : 86, "Validating stack and workspace");
      await recordRunEvent(run.id, "verification", attempt === 0 ? "Running workspace verification" : "Re-running verification after repair");
      const stackValidation = await validateStackProfile(directory, stackProfile);
      const buildVerification = stackValidation.ok
        ? await verifyWorkspace(directory, runtimeEnvironment)
        : { ok: false, output: "Build verification skipped because stack validation failed." };
      verification = {
        ok: stackValidation.ok && buildVerification.ok,
        output: [stackValidation.output, buildVerification.output].filter(Boolean).join("\n")
      };
      verification.output = redactSecrets(verification.output, Object.values(runtimeEnvironment));
      await recordProjectLog({
        organizationId: run.organizationId, projectId: run.projectId, runId: run.id,
        source: "build", level: verification.ok ? "info" : "error", message: verification.output || "Verification completed."
      });
      await recordRunEvent(run.id, verification.ok ? "verification_passed" : "verification_failed",
        verification.ok ? "Workspace verification passed" : "Workspace verification failed", {
          output: verification.output.slice(0, 4000), attempt: attempt + 1
        });
      if (verification.ok) break;
      if (attempt === 0) await query("UPDATE agent_runs SET repair_attempts=repair_attempts+1 WHERE id=$1", [run.id]);
    }
    if (!verification.ok) throw new Error(`Workspace verification failed after repair: ${verification.output.slice(0, 1000)}`);

    const commitSha = await commitRun(directory, {
      runId: run.id,
      userId: run.userId,
      providerId: policy.provider.id,
      model: policy.model,
      totalTokens: usage.totalTokens
    });

    await transaction(async (client) => {
      await client.query("UPDATE agent_runs SET commit_sha = $2 WHERE id = $1", [run.id, commitSha]);
      for (const file of changedFiles.values()) {
        await client.query(
          `INSERT INTO agent_run_files (run_id, path, additions, deletions, summary)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (run_id, path) DO UPDATE SET additions=$3, deletions=$4, summary=$5`,
          [run.id, file.path, file.additions, file.deletions, file.summary]
        );
      }
    });
    await finalizeRunBranch(directory, runBranch, run.targetBranch);
    if (gitSettings && (!run.workerId || await workerAutoPush(run.workerId))) {
      try {
        await setStatus(run.id, "testing", 96, "Pushing Git branches");
        await pushRunBranches(gitSettings, directory, run.targetBranch, runBranch);
        await recordRunEvent(run.id, "git_push", `Pushed ${run.targetBranch} and ${runBranch}`);
      } catch (error) {
        await recordRunEvent(run.id, "git_push_failed", `Local build completed but Git push failed: ${redact(error instanceof Error ? error.message : "Unknown Git error")}`);
      }
    }
    await transaction(async (client) => {
      await client.query("UPDATE agent_runs SET status = 'ready', progress=100, stage_message='Ready', finished_at = now() WHERE id = $1", [run.id]);
      await client.query("UPDATE projects SET status = 'ready', active_branch=$2, updated_at = now() WHERE id = $1", [run.projectId, run.targetBranch]);
      if (run.workerId) await client.query("UPDATE project_workers SET last_run_id=$2, updated_at=now() WHERE id=$1", [run.workerId, run.id]);
    });
    await recordRunEvent(run.id, "complete", "Run completed and preview updated", {
      summary: finalSummary,
      commitSha,
      verification: verification.output.slice(0, 4000)
    });
  } catch (error) {
    if (runDirectory && runBranch) await abortRunBranch(runDirectory, runBranch, targetBranch);
    const message = error instanceof Error ? error.message : "Unknown orchestration failure";
    await query(
      "UPDATE agent_runs SET status = 'failed', progress=100, stage_message='Failed', error_code = $2, finished_at = now() WHERE id = $1",
      [runId, classifyError(error)]
    ).catch(() => undefined);
    await query("UPDATE projects SET status='ready', updated_at=now() WHERE id=(SELECT project_id FROM agent_runs WHERE id=$1)", [runId]).catch(() => undefined);
    await recordRunEvent(runId, "error", redact(message)).catch(() => undefined);
  }
}

async function workerAutoPush(workerId: string) {
  const result = await query<{ autoPush: boolean }>("SELECT auto_push AS \"autoPush\" FROM project_workers WHERE id=$1 AND status='active'", [workerId]);
  return result.rows[0]?.autoPush ?? false;
}

async function setStatus(runId: string, status: string, progress: number, message: string) {
  await query("UPDATE agent_runs SET status=$2, progress=$3, stage_message=$4 WHERE id=$1", [runId, status, progress, message]);
}

export async function recordRunEvent(runId: string, type: string, message: string, metadata: Record<string, unknown> = {}) {
  const result = await query<{
    id: string; runId: string; sequence: number; type: string; message: string;
    metadata: Record<string, unknown>; createdAt: string;
  }>(
    `INSERT INTO agent_run_events (run_id, sequence, type, message, metadata)
     VALUES ($1, coalesce((SELECT max(sequence) + 1 FROM agent_run_events WHERE run_id = $1), 1), $2, $3, $4)
     RETURNING id::text, run_id AS "runId", sequence, type, message, metadata, created_at AS "createdAt"`,
    [runId, type, message, metadata]
  );
  const event = result.rows[0];
  if (event) publishRunEvent({ ...event, id: Number(event.id) });
}

function classifyError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return "provider_timeout";
  const message = error instanceof Error ? error.message : "";
  if (message.includes("budget")) return "budget_exhausted";
  if (message.includes("provider")) return "provider_error";
  return "run_failed";
}

function redact(value: string) {
  return value.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]").slice(0, 4000);
}

function redactSecrets(value: string, secrets: string[]) {
  return secrets.reduce((output, secret) => secret ? output.replaceAll(secret, "[redacted]") : output, redact(value));
}
