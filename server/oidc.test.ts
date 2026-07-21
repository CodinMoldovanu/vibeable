import { describe, expect, it } from "vitest";
import { mappedTeamSlugs, resolveOidcRole } from "./oidc.js";

describe("OIDC claim mapping", () => {
  it("selects the highest mapped non-owner role", () => {
    expect(resolveOidcRole(["employees", "reviewers"], {
      employees: "developer",
      reviewers: "reviewer",
      superusers: "owner"
    }, "viewer")).toBe("developer");
    expect(resolveOidcRole(["superusers"], { superusers: "owner" }, "viewer")).toBe("viewer");
  });

  it("deduplicates mapped team slugs and ignores unmapped groups", () => {
    expect(mappedTeamSlugs(["platform", "developers", "unknown"], {
      platform: "engineering",
      developers: "engineering"
    })).toEqual(["engineering"]);
  });
});
