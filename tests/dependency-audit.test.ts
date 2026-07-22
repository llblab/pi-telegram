/**
 * Regression tests for the dependency audit exception policy
 * Covers exact advisories, graph/path/version drift, clean resolution, and expiry
 */

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDependencyAudit } from "../scripts/dependency-audit-policy.ts";

const bracePath =
  "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";
const protobufPaths = [
  "node_modules/@earendil-works/pi-coding-agent/node_modules/protobufjs",
];

function currentAuditReport() {
  return {
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 5,
        high: 1,
        critical: 0,
        total: 6,
      },
    },
    vulnerabilities: {
      "brace-expansion": {
        name: "brace-expansion",
        severity: "high",
        via: [
          {
            source: 1123898,
            name: "brace-expansion",
            url: "https://github.com/advisories/GHSA-3jxr-9vmj-r5cp",
            severity: "high",
          },
        ],
        nodes: [bracePath],
      },
      protobufjs: {
        name: "protobufjs",
        severity: "moderate",
        via: [
          {
            source: 1123964,
            name: "protobufjs",
            url: "https://github.com/advisories/GHSA-j3f2-48v5-ccww",
            severity: "moderate",
          },
        ],
        nodes: [...protobufPaths],
      },
      "@google/genai": {
        name: "@google/genai",
        severity: "moderate",
        via: ["protobufjs"],
        nodes: [
          "node_modules/@google/genai",
          "node_modules/@earendil-works/pi-coding-agent/node_modules/@google/genai",
        ],
      },
      "@earendil-works/pi-ai": {
        name: "@earendil-works/pi-ai",
        severity: "moderate",
        via: ["@google/genai"],
        nodes: [
          "node_modules/@earendil-works/pi-ai",
          "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai",
        ],
      },
      "@earendil-works/pi-agent-core": {
        name: "@earendil-works/pi-agent-core",
        severity: "moderate",
        via: ["@earendil-works/pi-ai"],
        nodes: [
          "node_modules/@earendil-works/pi-agent-core",
          "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core",
        ],
      },
      "@earendil-works/pi-coding-agent": {
        name: "@earendil-works/pi-coding-agent",
        severity: "moderate",
        via: ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai"],
        nodes: ["node_modules/@earendil-works/pi-coding-agent"],
      },
    },
  };
}

function installedVersion(nodePath: string): string {
  if (nodePath === bracePath) return "5.0.6";
  if (protobufPaths.includes(nodePath)) return "7.6.4";
  throw new Error(`unexpected version lookup: ${nodePath}`);
}

test("dependency audit accepts only the approved current Pi shrinkwrap leaves", () => {
  const report = currentAuditReport();
  report.vulnerabilities = {
    "brace-expansion": report.vulnerabilities["brace-expansion"],
    protobufjs: report.vulnerabilities.protobufjs,
  } as typeof report.vulnerabilities;
  report.metadata.vulnerabilities.moderate = 1;
  report.metadata.vulnerabilities.total = 2;

  assert.deepEqual(
    evaluateDependencyAudit(
      report,
      installedVersion,
      Date.parse("2026-08-21T23:59:59Z"),
    ),
    {
      acceptedAdvisorySources: [1123898, 1123964],
      vulnerabilityCount: 2,
    },
  );
});

test("dependency audit accepts only approved parent findings resolving to those leaves", () => {
  assert.deepEqual(
    evaluateDependencyAudit(
      currentAuditReport(),
      installedVersion,
      Date.parse("2026-08-21T23:59:59Z"),
    ),
    {
      acceptedAdvisorySources: [1123898, 1123964],
      vulnerabilityCount: 6,
    },
  );
});

test("dependency audit accepts a clean report after the exception expiry", () => {
  assert.deepEqual(
    evaluateDependencyAudit(
      {
        metadata: {
          vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: 0,
            critical: 0,
            total: 0,
          },
        },
        vulnerabilities: {},
      },
      installedVersion,
      Date.parse("2027-01-01T00:00:00Z"),
    ),
    { acceptedAdvisorySources: [], vulnerabilityCount: 0 },
  );
});

test("dependency audit rejects approved advisories at the expiry boundary", () => {
  assert.throws(
    () =>
      evaluateDependencyAudit(
        currentAuditReport(),
        installedVersion,
        Date.parse("2026-08-22T00:00:00Z"),
      ),
    /exception expired/,
  );
});

test("dependency audit rejects an unknown advisory source", () => {
  const report = currentAuditReport();
  report.vulnerabilities.protobufjs.via[0] = {
    source: 9999999,
    name: "protobufjs",
    url: "https://github.com/advisories/GHSA-unknown",
    severity: "moderate",
  };
  assert.throws(
    () => evaluateDependencyAudit(report, installedVersion),
    /unapproved advisory/,
  );
});

test("dependency audit rejects an unexpected parent graph edge", () => {
  const report = currentAuditReport();
  report.vulnerabilities["@google/genai"].via = ["brace-expansion"];
  assert.throws(
    () => evaluateDependencyAudit(report, installedVersion),
    /audit graph edges differ/,
  );
});

test("dependency audit rejects an unexpected vulnerable install path", () => {
  const report = currentAuditReport();
  report.vulnerabilities.protobufjs.nodes.push(
    "node_modules/unapproved/node_modules/protobufjs",
  );
  assert.throws(
    () => evaluateDependencyAudit(report, installedVersion),
    /audit graph paths differ/,
  );
});

test("dependency audit rejects a changed installed vulnerable version", () => {
  assert.throws(
    () =>
      evaluateDependencyAudit(currentAuditReport(), (nodePath) =>
        nodePath === bracePath ? "5.0.5" : installedVersion(nodePath),
      ),
    /expected 5\.0\.6, got 5\.0\.5/,
  );
});

test("dependency audit rejects changed graph severity", () => {
  const report = currentAuditReport();
  report.vulnerabilities["@google/genai"].severity = "low";
  assert.throws(
    () => evaluateDependencyAudit(report, installedVersion),
    /unapproved severity/,
  );
});

test("dependency audit rejects omitted approved graph paths", () => {
  const report = currentAuditReport();
  report.vulnerabilities["@google/genai"].nodes.pop();
  assert.throws(
    () => evaluateDependencyAudit(report, installedVersion),
    /audit graph paths differ/,
  );
});

test("dependency audit rejects omitted approved graph edges", () => {
  const report = currentAuditReport();
  report.vulnerabilities["@earendil-works/pi-coding-agent"].via.pop();
  assert.throws(
    () => evaluateDependencyAudit(report, installedVersion),
    /audit graph edges differ/,
  );
});

test("dependency audit rejects missing vulnerability metadata", () => {
  assert.throws(
    () => evaluateDependencyAudit({ vulnerabilities: {} }, installedVersion),
    /missing vulnerability metadata/,
  );
});

test("dependency audit rejects malformed vulnerability totals", () => {
  const report = currentAuditReport();
  report.metadata.vulnerabilities.total = 5;
  assert.throws(
    () => evaluateDependencyAudit(report, installedVersion),
    /vulnerability total mismatch/,
  );
});

test("dependency audit rejects npm error payloads", () => {
  assert.throws(
    () =>
      evaluateDependencyAudit(
        { error: { code: "EAUDIT" }, vulnerabilities: {} },
        installedVersion,
      ),
    /error payload/,
  );
});
