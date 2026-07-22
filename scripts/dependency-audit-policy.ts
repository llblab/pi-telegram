/**
 * Fail-closed dependency audit policy
 * Zones: repository validation, dependency security
 * Validates the exact expiring Pi-shrinkwrap exception and installed package evidence
 */

const EXCEPTION_EXPIRES_AT = Date.parse("2026-08-22T00:00:00Z");

interface AuditAdvisory {
  source: number;
  name: string;
  url: string;
  severity: string;
}

interface AuditVulnerability {
  name: string;
  severity: string;
  via: Array<string | AuditAdvisory>;
  nodes: string[];
}

export interface AuditReport {
  error?: unknown;
  metadata?: {
    vulnerabilities?: {
      info?: number;
      low?: number;
      moderate?: number;
      high?: number;
      critical?: number;
      total?: number;
    };
  };
  vulnerabilities?: Record<string, AuditVulnerability>;
}

interface AllowedAdvisory {
  source: number;
  packageName: string;
  version: string;
  severity: string;
  url: string;
  nodes: readonly string[];
}

const ALLOWED_ADVISORIES = new Map<number, AllowedAdvisory>([
  [
    1123898,
    {
      source: 1123898,
      packageName: "brace-expansion",
      version: "5.0.6",
      severity: "high",
      url: "https://github.com/advisories/GHSA-3jxr-9vmj-r5cp",
      nodes: [
        "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
      ],
    },
  ],
  [
    1123964,
    {
      source: 1123964,
      packageName: "protobufjs",
      version: "7.6.4",
      severity: "moderate",
      url: "https://github.com/advisories/GHSA-j3f2-48v5-ccww",
      nodes: [
        "node_modules/@earendil-works/pi-coding-agent/node_modules/protobufjs",
      ],
    },
  ],
]);

const ALLOWED_GRAPH: Readonly<Record<string, readonly string[]>> = {
  "brace-expansion": [],
  protobufjs: [],
  "@google/genai": ["protobufjs"],
  "@earendil-works/pi-ai": ["@google/genai"],
  "@earendil-works/pi-agent-core": ["@earendil-works/pi-ai"],
  "@earendil-works/pi-coding-agent": [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
  ],
};

const ALLOWED_GRAPH_SEVERITIES: Readonly<Record<string, string>> = {
  "brace-expansion": "high",
  protobufjs: "moderate",
  "@google/genai": "moderate",
  "@earendil-works/pi-ai": "moderate",
  "@earendil-works/pi-agent-core": "moderate",
  "@earendil-works/pi-coding-agent": "moderate",
};

const ALLOWED_GRAPH_NODES: Readonly<Record<string, readonly string[]>> = {
  "brace-expansion": [
    "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion",
  ],
  protobufjs: [
    "node_modules/@earendil-works/pi-coding-agent/node_modules/protobufjs",
  ],
  "@google/genai": [
    "node_modules/@google/genai",
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@google/genai",
  ],
  "@earendil-works/pi-ai": [
    "node_modules/@earendil-works/pi-ai",
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai",
  ],
  "@earendil-works/pi-agent-core": [
    "node_modules/@earendil-works/pi-agent-core",
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core",
  ],
  "@earendil-works/pi-coding-agent": [
    "node_modules/@earendil-works/pi-coding-agent",
  ],
};

export interface AuditEvaluation {
  acceptedAdvisorySources: number[];
  vulnerabilityCount: number;
}

function hasExactMembers(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value))
  );
}

export function evaluateDependencyAudit(
  report: AuditReport,
  readInstalledVersion: (nodePath: string) => string,
  nowMs = Date.now(),
): AuditEvaluation {
  if (report.error !== undefined) {
    throw new Error("npm audit returned an error payload");
  }
  const vulnerabilities = report.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== "object") {
    throw new Error("npm audit output is missing vulnerabilities");
  }

  const entries = Object.entries(vulnerabilities);
  const counts = report.metadata?.vulnerabilities;
  if (!counts) {
    throw new Error("npm audit output is missing vulnerability metadata");
  }
  const countKeys = [
    "info",
    "low",
    "moderate",
    "high",
    "critical",
    "total",
  ] as const;
  for (const key of countKeys) {
    if (!Number.isInteger(counts[key]) || (counts[key] ?? -1) < 0) {
      throw new Error(`npm audit metadata has invalid ${key} count`);
    }
  }
  const severityTotal =
    (counts.info ?? 0) +
    (counts.low ?? 0) +
    (counts.moderate ?? 0) +
    (counts.high ?? 0) +
    (counts.critical ?? 0);
  if (severityTotal !== counts.total || counts.total !== entries.length) {
    throw new Error(
      `npm audit vulnerability total mismatch: metadata=${String(counts.total)}, severities=${severityTotal}, graph=${entries.length}`,
    );
  }
  if (entries.length === 0) {
    return { acceptedAdvisorySources: [], vulnerabilityCount: 0 };
  }
  if (nowMs >= EXCEPTION_EXPIRES_AT) {
    throw new Error(
      "approved dependency audit exception expired at 2026-08-22T00:00:00Z",
    );
  }

  const acceptedSources = new Set<number>();
  for (const [name, vulnerability] of entries) {
    if (vulnerability.name !== name) {
      throw new Error(`npm audit graph key/name mismatch for ${name}`);
    }
    const allowedParents = ALLOWED_GRAPH[name];
    const allowedNodes = ALLOWED_GRAPH_NODES[name];
    const allowedSeverity = ALLOWED_GRAPH_SEVERITIES[name];
    if (!allowedParents || !allowedNodes || !allowedSeverity) {
      throw new Error(`unapproved vulnerable package: ${name}`);
    }
    if (vulnerability.severity !== allowedSeverity) {
      throw new Error(
        `unapproved severity for ${name}: expected ${allowedSeverity}, got ${vulnerability.severity}`,
      );
    }
    if (!Array.isArray(vulnerability.via) || !Array.isArray(vulnerability.nodes)) {
      throw new Error(`malformed npm audit graph entry for ${name}`);
    }
    if (!hasExactMembers(vulnerability.nodes, allowedNodes)) {
      throw new Error(
        `audit graph paths differ for ${name}: expected ${allowedNodes.join(",")}, got ${vulnerability.nodes.join(",")}`,
      );
    }

    const parentEdges = vulnerability.via.filter(
      (via): via is string => typeof via === "string",
    );
    const advisories = vulnerability.via.filter(
      (via): via is AuditAdvisory => typeof via !== "string",
    );
    if (allowedParents.length > 0) {
      if (advisories.length > 0 || !hasExactMembers(parentEdges, allowedParents)) {
        throw new Error(
          `audit graph edges differ for ${name}: expected ${allowedParents.join(",")}, got ${parentEdges.join(",")}`,
        );
      }
      for (const parent of parentEdges) {
        if (!vulnerabilities[parent]) {
          throw new Error(`missing npm audit graph node: ${parent}`);
        }
      }
      continue;
    }
    if (parentEdges.length > 0 || advisories.length !== 1) {
      throw new Error(`audit leaf shape differs for ${name}`);
    }
    const advisory = advisories[0];
    const allowed = ALLOWED_ADVISORIES.get(advisory.source);
    if (
      !allowed ||
      advisory.name !== allowed.packageName ||
      advisory.url !== allowed.url ||
      advisory.severity !== allowed.severity ||
      name !== allowed.packageName ||
      vulnerability.severity !== allowed.severity
    ) {
      throw new Error(
        `unapproved advisory for ${name}: source=${String(advisory.source)} url=${advisory.url}`,
      );
    }
    acceptedSources.add(advisory.source);
  }

  const rootsByPackage = new Map<string, Set<number>>();
  const resolveRoots = (name: string, stack: Set<string>): Set<number> => {
    const cached = rootsByPackage.get(name);
    if (cached) return cached;
    if (stack.has(name)) throw new Error(`cycle in npm audit graph at ${name}`);
    const vulnerability = vulnerabilities[name];
    if (!vulnerability) throw new Error(`missing npm audit graph node: ${name}`);
    const nextStack = new Set(stack).add(name);
    const roots = new Set<number>();
    for (const via of vulnerability.via) {
      if (typeof via === "string") {
        for (const source of resolveRoots(via, nextStack)) roots.add(source);
      } else {
        roots.add(via.source);
      }
    }
    if (roots.size === 0) {
      throw new Error(`npm audit graph node has no approved advisory root: ${name}`);
    }
    rootsByPackage.set(name, roots);
    return roots;
  };

  for (const name of Object.keys(vulnerabilities)) resolveRoots(name, new Set());

  for (const source of acceptedSources) {
    const allowed = ALLOWED_ADVISORIES.get(source);
    if (!allowed) throw new Error(`missing policy for advisory source ${source}`);
    const vulnerability = vulnerabilities[allowed.packageName];
    if (!vulnerability) {
      throw new Error(`missing leaf package for advisory source ${source}`);
    }
    for (const nodePath of vulnerability.nodes) {
      if (!allowed.nodes.includes(nodePath)) {
        throw new Error(
          `unapproved installed path for advisory source ${source}: ${nodePath}`,
        );
      }
      const version = readInstalledVersion(nodePath);
      if (version !== allowed.version) {
        throw new Error(
          `unapproved installed version at ${nodePath}: expected ${allowed.version}, got ${version}`,
        );
      }
    }
  }

  return {
    acceptedAdvisorySources: [...acceptedSources].sort((a, b) => a - b),
    vulnerabilityCount: entries.length,
  };
}
