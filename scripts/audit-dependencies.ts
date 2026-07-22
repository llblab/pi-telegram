/**
 * Dependency audit command adapter
 * Runs raw npm audit, prints its output, and applies the fail-closed repository policy
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  evaluateDependencyAudit,
  type AuditReport,
} from "./dependency-audit-policy.ts";

function readInstalledPackageVersion(root: string, nodePath: string): string {
  if (
    path.isAbsolute(nodePath) ||
    nodePath.includes("..") ||
    !nodePath.startsWith("node_modules/")
  ) {
    throw new Error(`unsafe installed package path: ${nodePath}`);
  }
  const packageJsonPath = path.join(root, nodePath, "package.json");
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string") {
    throw new Error(`installed package has no valid version: ${nodePath}`);
  }
  return parsed.version;
}

function run(): void {
  const result = spawnSync("npm", ["audit", "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.signal || (result.status !== 0 && result.status !== 1)) {
    throw new Error(
      `npm audit command failed: status=${String(result.status)} signal=${String(result.signal)}`,
    );
  }

  let report: AuditReport;
  try {
    report = JSON.parse(result.stdout) as AuditReport;
  } catch (error) {
    throw new Error(`could not parse npm audit JSON: ${String(error)}`);
  }
  const evaluation = evaluateDependencyAudit(
    report,
    (nodePath) => readInstalledPackageVersion(process.cwd(), nodePath),
  );
  const expectedStatus = evaluation.vulnerabilityCount === 0 ? 0 : 1;
  if (result.status !== expectedStatus) {
    throw new Error(
      `npm audit exit status mismatch: expected ${expectedStatus}, got ${String(result.status)}`,
    );
  }
  if (evaluation.vulnerabilityCount === 0) {
    console.log("Dependency audit passed with zero vulnerabilities.");
    return;
  }
  console.warn(
    `Accepted ${evaluation.vulnerabilityCount} audit graph entries rooted only in approved sources ${evaluation.acceptedAdvisorySources.join(", ")}; exception expires after 2026-08-21 UTC.`,
  );
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
