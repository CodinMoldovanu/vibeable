import { query } from "./db.js";
import type { Principal } from "./permissions.js";

export interface ProjectRow {
  id: string;
  organizationId: string;
  teamId: string;
  ownerId: string;
  name: string;
  slug: string;
  status: "draft" | "building" | "ready" | "deployed";
  environment: "development" | "staging" | "production";
  updatedAt: string;
}

export async function listMemberTeamIds(principal: Principal) {
  const result = await query<{ team_id: string }>(
    "SELECT team_id FROM memberships WHERE organization_id = $1 AND user_id = $2 AND team_id IS NOT NULL",
    [principal.organizationId, principal.userId]
  );
  return result.rows.map((row) => row.team_id);
}

export async function getAccessibleProject(principal: Principal, projectId: string) {
  const result = await query<ProjectRow>(
    `SELECT p.id, p.organization_id AS "organizationId", p.team_id AS "teamId", p.owner_id AS "ownerId",
            p.name, p.slug, p.status, p.environment, p.updated_at AS "updatedAt"
       FROM projects p
      WHERE p.id = $1 AND p.organization_id = $2
        AND ($3::boolean OR EXISTS (
          SELECT 1 FROM memberships m WHERE m.user_id = $4 AND m.team_id = p.team_id
        ))`,
    [projectId, principal.organizationId, ["owner", "admin"].includes(principal.role), principal.userId]
  );
  const project = result.rows[0];
  if (!project) {
    const error = new Error("Project not found") as Error & { statusCode: number };
    error.statusCode = 404;
    throw error;
  }
  return project;
}

export async function writeAudit(
  principal: Principal,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown> = {},
  ipAddress?: string
) {
  await query(
    `INSERT INTO audit_events
       (organization_id, actor_user_id, action, resource_type, resource_id, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [principal.organizationId, principal.userId, action, resourceType, resourceId, metadata, ipAddress ?? null]
  );
}
