/**
 * Regression tests for project architecture invariants
 * Guards import graph shape, shared-bucket bans, and polling SDK boundary rules
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import test from "node:test";

const PROJECT_ROOT = process.cwd();

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

test("Package exports expose only stable public domains", () => {
  const packageJson = JSON.parse(
    readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"),
  ) as { exports?: Record<string, string> };

  assert.deepEqual(packageJson.exports, {
    ".": "./index.ts",
    "./inbound": "./api/inbound.ts",
    "./outbound": "./api/outbound.ts",
    "./updates": "./api/updates.ts",
    "./sections": "./api/sections.ts",
    "./status": "./api/status.ts",
    "./voice": "./api/voice.ts",
    "./keyboard": "./api/keyboard.ts",
  });
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

test("Entrypoint stays a composition root without local runtime adapters", () => {
  const source = stripSourceTextAndComments(
    readFileSync(join(PROJECT_ROOT, "index.ts"), "utf8"),
  );
  const localFunctionDeclarations = [
    ...source.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+\w+/g),
  ].map((match) => match[0].trim());
  assert.deepEqual(localFunctionDeclarations, []);
  assert.equal(source.includes("=>"), false);
  assert.equal(source.includes("process.env"), false);
  assert.equal(/\bpi\./.test(source), false);
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

test("Outbound attachment delivery stays decoupled from queue, inbound media, and API helpers", () => {
  const attachmentImports = getImportSpecifiers(
    join("lib", "outbound-attachments.ts"),
  );
  assert.equal(attachmentImports.includes("./queue.ts"), false);
  assert.equal(attachmentImports.includes("./media.ts"), false);
  assert.equal(attachmentImports.includes("./telegram-api.ts"), false);
});
