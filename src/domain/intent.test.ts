import { describe, expect, it } from "vitest";
import { inferAgentPhase } from "./intent.js";

describe("inferAgentPhase", () => {
  it("routes infrastructure and repair requests automatically", () => {
    expect(inferAgentPhase("Add a PostgreSQL schema for invoices", true)).toBe("database_migration");
    expect(inferAgentPhase("Prepare this for production deployment", true)).toBe("production_deploy_prepare");
    expect(inferAgentPhase("Fix the failing test in checkout", true)).toBe("agent:after_test_failure");
    expect(inferAgentPhase("Debug the browser error logs", true)).toBe("agent:after_error");
  });

  it("distinguishes first builds from later edits", () => {
    expect(inferAgentPhase("Make a useful dashboard", false)).toBe("project:create");
    expect(inferAgentPhase("Change the button color", true)).toBe("agent:before_edit");
  });
});
