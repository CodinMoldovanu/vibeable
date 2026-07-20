import { describe, expect, it } from "vitest";
import { can } from "./rbac.js";

describe("RBAC", () => {
  it("keeps global metrics owner-only", () => {
    expect(can("owner", "metrics:read_global")).toBe(true);
    expect(can("admin", "metrics:read_global")).toBe(false);
    expect(can("developer", "metrics:read_global")).toBe(false);
  });

  it("separates deploy creation from approval", () => {
    expect(can("developer", "deployment:create")).toBe(true);
    expect(can("developer", "deployment:approve")).toBe(false);
    expect(can("reviewer", "deployment:approve")).toBe(true);
  });

  it("separates agent execution from approval", () => {
    expect(can("developer", "agent:run")).toBe(true);
    expect(can("developer", "agent:approve_changes")).toBe(false);
    expect(can("reviewer", "agent:run")).toBe(false);
    expect(can("reviewer", "agent:approve_changes")).toBe(true);
  });

  it("allows project metrics without exposing global metrics", () => {
    expect(can("developer", "metrics:read_project")).toBe(true);
    expect(can("developer", "metrics:read_team")).toBe(false);
    expect(can("reviewer", "metrics:read_project")).toBe(true);
  });
});
