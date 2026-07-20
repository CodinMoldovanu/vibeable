import type { Permission, Role } from "./types.js";

export const rolePermissions: Record<Role, Permission[]> = {
  owner: [
    "org:manage",
    "team:update",
    "project:create",
    "project:read",
    "project:update",
    "agent:run",
    "agent:approve_changes",
    "deployment:create",
    "deployment:approve",
    "secret:update",
    "ai_policy:update",
    "metrics:read_global",
    "metrics:read_team",
    "metrics:read_user",
    "audit:read"
  ],
  admin: [
    "team:update",
    "project:create",
    "project:read",
    "project:update",
    "agent:run",
    "agent:approve_changes",
    "deployment:create",
    "deployment:approve",
    "secret:update",
    "ai_policy:update",
    "metrics:read_team",
    "metrics:read_user",
    "audit:read"
  ],
  developer: [
    "project:create",
    "project:read",
    "project:update",
    "agent:run",
    "agent:approve_changes",
    "deployment:create",
    "metrics:read_user"
  ],
  reviewer: ["project:read", "deployment:approve", "metrics:read_team"],
  viewer: ["project:read"]
};

export function can(role: Role, permission: Permission) {
  return (rolePermissions[role] ?? []).includes(permission);
}
