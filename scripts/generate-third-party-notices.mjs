import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint) throw new Error("Run this script through pnpm");

const raw = execFileSync(process.execPath, [pnpmEntrypoint, "licenses", "list", "--prod", "--json"], {
  encoding: "utf8",
  maxBuffer: 20_000_000
});
const report = JSON.parse(raw);
const packages = new Map();

for (const entries of Object.values(report)) {
  for (const entry of entries) {
    for (const packagePath of entry.paths) {
      const metadata = JSON.parse(readFileSync(join(packagePath, "package.json"), "utf8"));
      packages.set(`${metadata.name}@${metadata.version}`, {
        name: metadata.name,
        version: metadata.version,
        license: metadata.license ?? entry.license,
        homepage: metadata.homepage ?? entry.homepage ?? "",
        licenseText: readLicense(packagePath)
      });
    }
  }
}

const sections = [...packages.values()]
  .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`))
  .map((item) => [
    `## ${item.name}@${item.version}`,
    `License: ${item.license}`,
    item.homepage ? `Homepage: ${item.homepage}` : "",
    "",
    item.licenseText || "The package declares the license above; its package distribution contains the controlling notice.",
    ""
  ].filter(Boolean).join("\n"));

const output = [
  "# Third-Party Notices",
  "",
  "This file is generated from the production dependency graph by `pnpm licenses:generate`.",
  "Vibeable's license does not replace or restrict the licenses of these third-party components.",
  "",
  ...sections
].join("\n").trimEnd() + "\n";

const destination = "THIRD_PARTY_NOTICES.md";
if (process.argv.includes("--check")) {
  const existing = readFileSync(destination, "utf8");
  if (existing !== output) {
    process.stderr.write(`${destination} is stale; run pnpm licenses:generate\n`);
    process.exitCode = 1;
  }
} else {
  writeFileSync(destination, output);
  process.stdout.write(`Updated ${destination} for ${packages.size} production packages.\n`);
}

function readLicense(packagePath) {
  const file = readdirSync(packagePath).find((name) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name));
  return file ? readFileSync(join(packagePath, file), "utf8").trim() : "";
}
