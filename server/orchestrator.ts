import type { AgentPhase } from "../src/domain/types.js";
import { generateEdits } from "./ai.js";
import { config } from "./config.js";
import { query, transaction } from "./db.js";
import { publishRunEvent } from "./events.js";
import { assertBudget, resolvePolicy } from "./policy.js";
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
}

export function enqueueRun(runId: string) {
  setImmediate(() => void executeRun(runId));
}

export async function executeRun(runId: string) {
  let runDirectory: string | undefined;
  try {
    const runResult = await query<RunRow>(
      `SELECT r.id, r.organization_id AS "organizationId", r.team_id AS "teamId", r.project_id AS "projectId",
              p.name AS "projectName", r.user_id AS "userId", r.phase, r.prompt
         FROM agent_runs r JOIN projects p ON p.id = r.project_id WHERE r.id = $1`,
      [runId]
    );
    const run = runResult.rows[0];
    if (!run) return;

    await setStatus(run.id, "planning");
    await recordRunEvent(run.id, "policy", "Resolving effective organization, team, user, and project policy");
    const policy = await resolvePolicy({
      organizationId: run.organizationId,
      teamId: run.teamId,
      userId: run.userId,
      projectId: run.projectId,
      phase: run.phase
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
    await recordRunEvent(run.id, "provider", `Using ${policy.provider.name} / ${policy.model}`, {
      hookCount: policy.hooks.length
    });

    const directory = await ensureWorkspace(run.projectId, run.projectName);
    runDirectory = directory;
    await prepareRunBranch(directory, run.id);
    const context = await workspaceContext(directory);
    await setStatus(run.id, "editing");
    await recordRunEvent(run.id, "agent", "Requesting a structured edit set from the AI gateway");
    const completion = await generateEdits({
      baseUrl: policy.provider.baseUrl,
      encryptedApiKey: policy.encryptedApiKey,
      model: policy.model,
      userPrompt: run.prompt,
      hooks: policy.hooks.map((hook) => hook.prompt),
      workspaceContext: context,
      skipEndpointResolutionForTests: config.NODE_ENV === "test"
    });
    const changedFiles = await applyEdits(directory, completion.result.files);
    await recordRunEvent(run.id, "files", `Applied ${changedFiles.length} generated file change(s)`, {
      files: changedFiles.map((file) => file.path)
    });

    await setStatus(run.id, "testing");
    await recordRunEvent(run.id, "verification", "Running workspace verification");
    const verification = await verifyWorkspace(directory);
    const estimatedCost =
      completion.usage.inputTokens / 1_000_000 * policy.inputCostPerMillion +
      completion.usage.outputTokens / 1_000_000 * policy.outputCostPerMillion;
    const commitSha = await commitRun(directory, {
      runId: run.id,
      userId: run.userId,
      providerId: policy.provider.id,
      model: policy.model,
      totalTokens: completion.usage.totalTokens
    });

    await transaction(async (client) => {
      await client.query(
        `UPDATE agent_runs SET input_tokens = $2, output_tokens = $3, total_tokens = $4,
           estimated_cost_usd = $5, commit_sha = $6 WHERE id = $1`,
        [run.id, completion.usage.inputTokens, completion.usage.outputTokens, completion.usage.totalTokens, estimatedCost, commitSha]
      );
      for (const file of changedFiles) {
        await client.query(
          `INSERT INTO agent_run_files (run_id, path, additions, deletions, summary)
           VALUES ($1, $2, $3, $4, $5)`,
          [run.id, file.path, file.additions, file.deletions, file.summary]
        );
      }
      await client.query(
        `INSERT INTO token_usage_events
          (organization_id, team_id, user_id, project_id, run_id, provider_id, model, phase,
           input_tokens, output_tokens, total_tokens, estimated_cost_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [run.organizationId, run.teamId, run.userId, run.projectId, run.id, policy.provider.id, policy.model,
          run.phase, completion.usage.inputTokens, completion.usage.outputTokens, completion.usage.totalTokens, estimatedCost]
      );
    });
    await finalizeRunBranch(directory, run.id);
    await transaction(async (client) => {
      await client.query("UPDATE agent_runs SET status = 'ready', finished_at = now() WHERE id = $1", [run.id]);
      await client.query("UPDATE projects SET status = 'ready', updated_at = now() WHERE id = $1", [run.projectId]);
    });
    await recordRunEvent(run.id, "complete", "Run completed and preview updated", {
      summary: completion.result.summary,
      commitSha,
      verification: verification.output.slice(0, 4000)
    });
  } catch (error) {
    if (runDirectory) await abortRunBranch(runDirectory, runId);
    const message = error instanceof Error ? error.message : "Unknown orchestration failure";
    await query(
      "UPDATE agent_runs SET status = 'failed', error_code = $2, finished_at = now() WHERE id = $1",
      [runId, classifyError(error)]
    ).catch(() => undefined);
    await recordRunEvent(runId, "error", redact(message)).catch(() => undefined);
  }
}

async function setStatus(runId: string, status: string) {
  await query("UPDATE agent_runs SET status = $2 WHERE id = $1", [runId, status]);
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
