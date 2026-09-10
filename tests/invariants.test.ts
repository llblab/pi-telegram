/**
 * Regression tests for project architecture invariants
 * Guards import graph shape, shared-bucket bans, and polling SDK boundary rules
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import test from "node:test";

const PROJECT_ROOT = process.cwd();
const releaseWorkflowSource = readFileSync(
  join(PROJECT_ROOT, ".github", "workflows", "release.yml"),
  "utf8",
);
const validateWorkflowSource = readFileSync(
  join(PROJECT_ROOT, ".github", "workflows", "validate.yml"),
  "utf8",
);
const changelogSource = readFileSync(
  join(PROJECT_ROOT, "CHANGELOG.md"),
  "utf8",
);

function getProjectTypeScriptFiles(): string[] {
  return [
    "index.ts",
    ...readdirSync(join(PROJECT_ROOT, "api"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join("api", name)),
    ...readdirSync(join(PROJECT_ROOT, "lib"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join("lib", name)),
    ...readdirSync(join(PROJECT_ROOT, "tests"))
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => join("tests", name)),
  ].sort();
}

test("Unreleased changelog respects the project release-entry budget", () => {
  const unreleased = changelogSource.match(
    /^## Unreleased\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/mu,
  )?.[1];
  assert.ok(unreleased, "CHANGELOG.md must retain an Unreleased section");
  const entries = unreleased
    .split("\n")
    .filter((line) => line.startsWith("- "));
  assert.ok(entries.length <= 8, "Unreleased must contain at most 8 entries");
  assert.deepEqual(
    entries.filter((entry) => entry.length > 512),
    [],
    "Unreleased entries must contain at most 512 characters",
  );
});

test("Release CI validates exact tags and publishes through npm Trusted Publisher", () => {
  assert.match(validateWorkflowSource, /^  workflow_call:$/m);
  assert.match(
    releaseWorkflowSource,
    /uses: \.\/\.github\/workflows\/validate\.yml/,
  );
  assert.match(releaseWorkflowSource, /needs: validate/);
  assert.match(
    releaseWorkflowSource,
    /group: release-\$\{\{ github\.ref_name \}\}/,
  );
  assert.match(releaseWorkflowSource, /HEAD\^\{commit\}/);
  assert.match(
    releaseWorkflowSource,
    /refs\/tags\/\$\{tagName\}\^\{commit\}/,
  );
  assert.match(releaseWorkflowSource, /packageLock\.version !== version/);
  assert.match(releaseWorkflowSource, /require npm >= 11\.5\.1/);
  assert.match(
    releaseWorkflowSource,
    /npm view "\$PACKAGE_NAME@\$VERSION" --json version gitHead/,
  );
  assert.match(
    releaseWorkflowSource,
    /npm publish --access public --provenance/,
  );
  assert.match(
    releaseWorkflowSource,
    /npm pack "\$PACKAGE_NAME@\$VERSION" --dry-run --json/,
  );
  assert.match(releaseWorkflowSource, /\.\/index\.ts/);
  assert.match(releaseWorkflowSource, /skills\/telegram-bridge\/SKILL\.md/);
  assert.match(
    releaseWorkflowSource,
    /gh release view[\s\S]*gh release edit[\s\S]*gh release create/,
  );
  assert.doesNotMatch(releaseWorkflowSource, /NPM_TOKEN|NODE_AUTH_TOKEN/);
});

function getProjectSourceFiles(): string[] {
  return [
    "index.ts",
    ...readdirSync(join(PROJECT_ROOT, "api"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join("api", name)),
    ...readdirSync(join(PROJECT_ROOT, "lib"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join("lib", name)),
  ].sort();
}

function getImportSpecifiersFromSource(source: string): string[] {
  const specifiers = new Set<string>();
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    specifiers.add(match[1] ?? "");
  }
  for (const match of source.matchAll(/import\s+["']([^"']+)["']/g)) {
    specifiers.add(match[1] ?? "");
  }
  for (const match of source.matchAll(/import\s*\(\s*["']([^"']+)["']/g)) {
    specifiers.add(match[1] ?? "");
  }
  return [...specifiers];
}

function getImportSpecifiers(file: string): string[] {
  return getImportSpecifiersFromSource(
    readFileSync(join(PROJECT_ROOT, file), "utf8"),
  );
}

function resolveProjectImport(
  fromFile: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const resolved = normalize(join(PROJECT_ROOT, fromFile, "..", specifier));
  const relativePath = relative(PROJECT_ROOT, resolved);
  return relativePath.startsWith("..") ? undefined : relativePath;
}

function buildProjectImportGraph(files: string[]): Map<string, string[]> {
  const fileSet = new Set(files.map((file) => normalize(file)));
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const deps: string[] = [];
    for (const specifier of getImportSpecifiers(file)) {
      const resolved = resolveProjectImport(file, specifier);
      if (resolved && fileSet.has(normalize(resolved))) {
        deps.push(normalize(resolved));
      }
    }
    graph.set(normalize(file), deps.sort());
  }
  return graph;
}

function findImportCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const activeStack: string[] = [];
  const visit = (file: string): void => {
    const activeIndex = activeStack.indexOf(file);
    if (activeIndex !== -1) {
      cycles.push([...activeStack.slice(activeIndex), file]);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    activeStack.push(file);
    for (const dep of graph.get(file) ?? []) visit(dep);
    activeStack.pop();
  };
  for (const file of graph.keys()) visit(file);
  return cycles;
}

function stripSourceTextAndComments(source: string): string {
  const withoutStrings = source.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, "");
  return withoutStrings
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

test("Import parser includes side-effect imports for cycle checks", () => {
  assert.deepEqual(
    getImportSpecifiersFromSource(
      [
        "import type { A } from './a.ts';",
        "import { b } from './b.ts';",
        "import './side-effect.ts';",
        "export { c } from './c.ts';",
        "const module = await import('./dynamic.ts');",
      ].join("\n"),
    ).sort(),
    ["./a.ts", "./b.ts", "./c.ts", "./dynamic.ts", "./side-effect.ts"],
  );
});

test("Source-only invariant scans ignore strings and comments", () => {
  assert.equal(
    stripSourceTextAndComments(
      [
        "const text = '=> process.env pi.';",
        "// interface Example extends Other {}",
        "/* function helper() { return process.env; } */",
        "const value = 1;",
      ].join("\n"),
    ).trim(),
    "const text = ;\n\n\nconst value = 1;",
  );
});

test("Domain test filenames mirror their owning lib domain", () => {
  const libDomains = new Set(
    readdirSync(join(PROJECT_ROOT, "lib"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => name.replace(/\.ts$/, "")),
  );
  const nonLibTestDomains = new Set([
    "dependency-audit",
    "index",
    "integration",
    "invariants",
    "journal-downgrade",
    "process-shutdown",
    "public-api",
  ]);
  const unmirrored = readdirSync(join(PROJECT_ROOT, "tests"))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => name.replace(/\.test\.ts$/, ""))
    .filter(
      (domain) => !libDomains.has(domain) && !nonLibTestDomains.has(domain),
    );

  assert.deepEqual(unmirrored, []);
});

test("Project source imports stay acyclic", () => {
  const graph = buildProjectImportGraph(getProjectSourceFiles());
  const cycles = findImportCycles(graph);

  assert.deepEqual(
    cycles,
    [],
    "Import cycles found:\n" + cycles.map((c) => c.join(" -> ")).join("\n"),
  );
});

test("Project no longer has shared constants or transport-type domains", () => {
  assert.equal(existsSync(join(PROJECT_ROOT, "lib", "constants.ts")), false);
  assert.equal(existsSync(join(PROJECT_ROOT, "lib", "types.ts")), false);
});

test("Preview domain stays independent from UI/compat rendering", () => {
  assert.equal(
    getImportSpecifiers(join("lib", "preview.ts")).includes("./rendering.ts"),
    false,
  );
});

test("Package exports expose only stable public domains", () => {
  const packageJson = JSON.parse(
    readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"),
  ) as { exports?: Record<string, string> };

  assert.deepEqual(packageJson.exports, {
    ".": "./index.ts",
    "./inbound": "./api/inbound.ts",
    "./outbound": "./api/outbound.ts",
    "./delivery": "./api/delivery.ts",
    "./activity": "./api/activity.ts",
    "./updates": "./api/updates.ts",
    "./commands": "./api/commands.ts",
    "./sections": "./api/sections.ts",
    "./status": "./api/status.ts",
    "./voice": "./api/voice.ts",
    "./keyboard": "./api/keyboard.ts",
  });
});

test("Supported package boundaries do not expose journal mutation factories", () => {
  const packageJson = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")) as {
    exports?: Record<string, string>;
  };
  assert.equal(Object.keys(packageJson.exports ?? {}).some(key => /journal/u.test(key)), false);
  const publicSources = ["index.ts", ...readdirSync(join(PROJECT_ROOT, "api"))
    .filter(file => file.endsWith(".ts")).map(file => join("api", file))]
    .map(file => readFileSync(join(PROJECT_ROOT, file), "utf8")).join("\n");
  assert.doesNotMatch(publicSources,
    /createTelegram(?:Input|Update)JournalStore|Telegram(?:Input|Update)JournalStore/u);
});

test("Project TypeScript files start with responsibility headers", () => {
  const filesWithoutHeaders = getProjectTypeScriptFiles().filter((file) => {
    return !readFileSync(join(PROJECT_ROOT, file), "utf8").startsWith("/**");
  });
  assert.deepEqual(filesWithoutHeaders, []);
});

test("Project source module headers include Domain DAG zone tags", () => {
  const sourceFilesWithoutZoneTags = getProjectSourceFiles().filter((file) => {
    const source = readFileSync(join(PROJECT_ROOT, file), "utf8");
    const header = source.match(/^\/\*\*[\s\S]*?\*\//)?.[0] ?? "";
    return !/^ \* Zones: .+/m.test(header);
  });
  assert.deepEqual(sourceFilesWithoutZoneTags, []);
});

test("Project source avoids empty interface-extension shells", () => {
  const emptyInterfacePattern =
    /export\s+interface\s+\w+(?:<[^>{}]+>)?\s+extends[^{]+\{\s*\}/g;
  const emptyInterfaceExtensions = getProjectSourceFiles().flatMap((file) => {
    const source = stripSourceTextAndComments(
      readFileSync(join(PROJECT_ROOT, file), "utf8"),
    );
    return [...source.matchAll(emptyInterfacePattern)].map(
      (match) => `${file}: ${match[0].replace(/\s+/g, " ")}`,
    );
  });
  assert.deepEqual(emptyInterfaceExtensions, []);
});

test("Pi SDK imports stay centralized in the pi adapter", () => {
  const directSdkImportFiles = getProjectSourceFiles().filter((file) => {
    if (file === normalize(join("lib", "pi.ts"))) return false;
    const source = readFileSync(join(PROJECT_ROOT, file), "utf8");
    const piSdkPackages = [
      "@mariozechner/pi-coding-agent",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
    ];
    return piSdkPackages.some((packageName) => source.includes(packageName));
  });
  assert.deepEqual(directSdkImportFiles, []);
});

test("Entrypoint stays free of direct Node runtime imports", () => {
  const nodeImportSpecifiers = getImportSpecifiers("index.ts").filter(
    (specifier) => specifier.startsWith("node:"),
  );
  assert.deepEqual(nodeImportSpecifiers, []);
});

test("Production journal writers remain scoped or lifecycle-owned", () => {
  const source = readFileSync(join(PROJECT_ROOT, "lib/extension.ts"), "utf8");
  assert.equal((source.match(/binding\.journal\.appendBatch\(/gu) ?? []).length, 1);
  assert.match(source, /withTelegramResolvedUpdateJournalReference\(\{[\s\S]*?publishJournalCursor[\s\S]*?binding\.journal\.appendBatch/u);
  assert.match(source, /followerAdmissionLifecycleRuntime\.appendBatch\(updates\)/u);
  assert.doesNotMatch(source, /createTelegram(?:Input|Update)JournalStore\(/u);
});

test("Production keeps custody cutover and operator authority disconnected", () => {
  const source = readFileSync(join(PROJECT_ROOT, "lib/extension.ts"), "utf8");
  for (const forbidden of [
    "acquireJournalWriterClosure",
    "installJournalWriterProtocolMode",
    "executeTelegramInputCustodyWriterCutover",
    "executeTelegramInputCustodyMigrationCompletion",
    "authorizeLegacyCustodyDisposition",
    "authorizeJournalWriterProtocolClosure",
    "createTelegramInputCustodyLegacyDispositionRuntime",
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});

test("Production journal resolver reads remain scoped or lifecycle-owned", () => {
  const source = readFileSync(join(PROJECT_ROOT, "lib/extension.ts"), "utf8");
  assert.doesNotMatch(source,
    /resolveTelegram\w*JournalBinding\(\)\?\.journal\.read/u);
  assert.ok((source.match(/withTelegramResolvedUpdateJournalReference\(/gu) ?? []).length >= 4);
  assert.match(source, /withJournalReference\(binding, operation\)/u);
  assert.match(source, /acquireSourceReference\(role, binding\)/u);
});

test("Extension composition stays free of local runtime adapters", () => {
  const source = stripSourceTextAndComments(
    readFileSync(join(PROJECT_ROOT, "lib/extension.ts"), "utf8"),
  );
  const localFunctionDeclarations = [
    ...source.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+\w+/g),
  ].map((match) => match[0].trim());
  assert.deepEqual(localFunctionDeclarations, []);
  assert.equal(source.includes("=>"), false);
  assert.equal(source.includes("process.env"), false);
  assert.equal(source.includes("process.pid"), false);
  assert.equal(/\blet\s+\w+/.test(source), false);
  assert.equal(source.includes("new Map"), false);
  assert.equal(source.includes("new Set"), false);
  assert.equal(source.includes("!."), false);
  assert.equal(/\bpi\./.test(source), false);
  assert.equal(source.includes("Threads.createTelegramTopicTargetRenamer"), false);
  assert.match(source, /telegramBusLeaderRuntime\.renameLeaderThreadAdmitted\s*\(/u);
  assert.deepEqual(
    [
      "Queue.createTelegramQueueMutationController",
      "Queue.createTelegramQueueDispatchRuntime",
      "Queue.createTelegramQueueDispatchWatchdogRuntime",
      "Threads.createTelegramCurrentInstanceThreadRuntime",
      "Threads.createTelegramThreadStatusProjectionRuntime",
      "Sync.createTelegramManualThreadDisconnectHandler",
      "Sync.createTelegramSessionRestartThreadCleanupHandler",
      "Updates.createTelegramQueueHandoffReconciler",
      "Updates.createTelegramUpdateWorkerOwnerRuntime",
      "Updates.createTelegramUpdateAdmissionLifecycleAssembly",
    ].filter((factory) => source.includes(factory)),
    [],
  );
});

test("Visible thread identity never falls back directly to bare slot labels", () => {
  const forbiddenPatterns: Array<[RegExp, string]> = [
    [/\bthreadName\s*\?\?\s*slot\b/g, "threadName ?? slot"],
    [
      /\brecord\.threadName\s*\?\?\s*record\.slot\b/g,
      "record.threadName ?? record.slot",
    ],
    [/\?\s*[\w.]+\.threadName\s*:\s*[\w.]+\.slot\b/g, "ternary slot fallback"],
  ];
  const violations = getProjectSourceFiles().flatMap((file) => {
    const source = stripSourceTextAndComments(
      readFileSync(join(PROJECT_ROOT, file), "utf8"),
    );
    return forbiddenPatterns.flatMap(([pattern, label]) =>
      [...source.matchAll(pattern)].map(
        (match) => `${file}: ${label}: ${match[0].replace(/\s+/g, " ")}`,
      ),
    );
  });

  assert.deepEqual(violations, []);
});

test("Automatic Workspace retirement stays disconnected from production composition", () => {
  const compositionSource = stripSourceTextAndComments(
    readFileSync(join(PROJECT_ROOT, "lib/extension.ts"), "utf8"),
  );
  assert.match(
    compositionSource,
    /createTelegramWorkspaceAdmissionRuntimeBinding\s*\(/u,
  );
  assert.match(
    compositionSource,
    /getWorkspaceAdmission:\s*workspaceAdmissionRuntime\.resolve/u,
  );
  assert.match(
    compositionSource,
    /createTelegramBusFollowerPromotionHandler[\s\S]*?getWorkspaceAdmission:\s*workspaceAdmissionRuntime\.resolve[\s\S]*?startLeader/u,
  );
  assert.match(
    compositionSource,
    /targetReplacement:\s*\{[\s\S]*?getWorkspaceAdmission:\s*workspaceAdmissionRuntime\.resolve[\s\S]*?getSyncState/u,
  );
  assert.match(
    compositionSource,
    /staleTopicApiErrorRecoveryDeps\s*=\s*\{[\s\S]*?getWorkspaceAdmission:\s*workspaceAdmissionRuntime\.resolve/u,
  );
  assert.match(
    compositionSource,
    /workspaceAdmission:\s*workspaceAdmissionRuntime\.resolve/u,
  );
  assert.match(
    compositionSource,
    /createTelegramWorkspaceOperationRuntime[\s\S]*?getWorkspaceAdmission:\s*workspaceAdmissionRuntime\.resolve/u,
  );
  for (const factory of [
    "createTelegramObservedTopicLifecycleSyncHandler",
    "createTelegramInboundRouteRuntime",
    "createTelegramBusLeaderRuntimeAssembly",
    "createTelegramThreadDisconnectAssembly",
  ]) {
    assert.match(
      compositionSource,
      new RegExp(
        `${factory}[\\s\\S]*?runWorkspaceOperation:\\s*telegramWorkspaceOperationRuntime\\.run`,
        "u",
      ),
    );
  }
  assert.match(
    compositionSource,
    /getExternalReservedSlots:\s*function\s*\(\)/u,
  );
  const busLeaderSource = readFileSync(
    join(PROJECT_ROOT, "lib", "bus-leader.ts"),
    "utf8",
  );
  assert.match(
    busLeaderSource,
    /const provisionerPorts\s*=\s*\{[\s\S]*?runWorkspaceOperation,[\s\S]*?recordRuntimeEvent/u,
  );
  assert.match(
    busLeaderSource,
    /operationKind:\s*"workspace\.reconcile-follower-provision"/u,
  );
  const retirementSource = readFileSync(
    join(PROJECT_ROOT, "lib", "workspace-retirement.ts"),
    "utf8",
  );
  assert.match(retirementSource, /issueDeletionPermit\s*\(/u);
  assert.match(retirementSource, /input\.deleteForumTopic\s*\(/u);
  assert.match(
    retirementSource,
    /pruneTelegramWorkspaceJournalEvidence[\s\S]*?admission:\s*Pick<[\s\S]*?operationKind:\s*"workspace\.prune-journal-evidence"/u,
  );
  const productionRetirementEntrypoints = [
    "runTelegramWorkspaceRetirementLifecycle",
    "executeTelegramWorkspaceRetirement",
  ];
  const productionConsumers = getProjectSourceFiles().filter((file) => {
    if (file === join("lib", "workspace-retirement.ts")) return false;
    const source = stripSourceTextAndComments(
      readFileSync(join(PROJECT_ROOT, file), "utf8"),
    );
    return productionRetirementEntrypoints.some((entrypoint) =>
      new RegExp(`\\b${entrypoint}\\b`, "u").test(source),
    );
  });
  assert.deepEqual(productionConsumers, []);
});

test("Runtime state domain stays free of local domain imports", () => {
  const localImportSpecifiers = getImportSpecifiers(
    join("lib", "runtime.ts"),
  ).filter((specifier) => specifier.startsWith("."));
  assert.deepEqual(localImportSpecifiers, []);
});

test("Structural leaf domains stay free of local nominal imports", () => {
  const leafFiles = ["polling.ts", "setup.ts", "status.ts"];
  const localImportsByFile = Object.fromEntries(
    leafFiles.map((file) => [
      join("lib", file),
      getImportSpecifiers(join("lib", file)).filter((specifier) =>
        specifier.startsWith("."),
      ),
    ]),
  );

  assert.deepEqual(localImportsByFile, {
    [join("lib", "polling.ts")]: [],
    [join("lib", "setup.ts")]: [],
    [join("lib", "status.ts")]: [],
  });
});

test("Menu domain stays on structural ports and does not re-export model", () => {
  const menuImports = getImportSpecifiers(join("lib", "menu.ts"));
  assert.equal(menuImports.includes("./pi.ts"), false);
  const menuSource = readFileSync(join(PROJECT_ROOT, "lib", "menu.ts"), "utf8");
  assert.equal(
    /export\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s+["']\.\/model\.ts["']/.test(
      menuSource,
    ),
    false,
  );
});

test("Telegram API transport stays decoupled from persisted config defaults", () => {
  const apiImports = getImportSpecifiers(join("lib", "telegram-api.ts"));
  assert.equal(apiImports.includes("./config.ts"), false);
});

test("Structural update and media domains stay decoupled from concrete API transport shapes", () => {
  const structuralFiles = ["updates.ts", "media.ts"];
  const apiImportsByFile = Object.fromEntries(
    structuralFiles.map((file) => [
      join("lib", file),
      getImportSpecifiers(join("lib", file)).includes("./telegram-api.ts"),
    ]),
  );
  assert.deepEqual(apiImportsByFile, {
    [join("lib", "updates.ts")]: false,
    [join("lib", "media.ts")]: false,
  });
});

test("Core assistant output never constructs Telegram Thinking blocks", () => {
  for (const file of [
    "replies.ts",
    "preview.ts",
    "outbound-attachments.ts",
    "queue.ts",
  ]) {
    const source = readFileSync(join(PROJECT_ROOT, "lib", file), "utf8");
    assert.doesNotMatch(
      source,
      /tg-thinking|InputRichBlockThinking|type\s*:\s*["']thinking["']/,
      `${file} must not project hidden reasoning into Telegram Thinking blocks`,
    );
  }
});

test("Outbound attachment delivery stays decoupled from queue, inbound media, and API helpers", () => {
  const attachmentImports = getImportSpecifiers(
    join("lib", "outbound-attachments.ts"),
  );
  assert.equal(attachmentImports.includes("./queue.ts"), false);
  assert.equal(attachmentImports.includes("./media.ts"), false);
  assert.equal(attachmentImports.includes("./telegram-api.ts"), false);
});
