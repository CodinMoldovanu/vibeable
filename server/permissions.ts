import type { Permission, Role } from "../src/domain/types.js";
import { rolePermissions } from "../src/domain/rbac.js";

export interface Principal {
  userId: string;
  organizationId: string;
  organizationName: string;
  role: Role;
  email: string;
  name: string;
}

export function requirePermission(principal: Principal, permission: Permission) {
  if (!(rolePermissions[principal.role] ?? []).includes(permission)) {
    const error = new Error(`Missing permission: ${permission}`) as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
}

export function canAccessTeam(role: Role, memberTeamIds: string[], teamId: string) {
  return role === "owner" || role === "admin" || memberTeamIds.includes(teamId);
}
