#!/usr/bin/env node
/**
 * Domain DAG project validator
 * Domains: source graph, architecture validation, command-line diagnostics
 * Validates local import acyclicity, composition-root boundaries, shared-bucket drift, headers, and optional configured rules
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const DEFAULT_CONFIG = {
  sourceRoots: ["src", "lib"],
  entrypoints: [
    "index.ts",
    "index.tsx",
    "index.js",
    "index.mjs",
    "src/index.ts",
    "src/index.tsx",
    "src/main.ts",
    "src/main.tsx",
    "lib/index.ts",
  ],
  sourceExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".svelte"],
  ignoreDirs: [
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".nuxt",
    "target",
    "vendor",
  ],
  excludePatterns: [
    "**/*.d.ts",
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.test.js",
    "**/*.spec.ts",
    "**/*.spec.tsx",
    "**/*.spec.js",
    "**/__tests__/**",
  ],
  importAliases: {},
  requireHeaders: true,
  headerPattern: "\\b(?:Domain|Domains|Zone|Zones|Owns)" + ":\\s*\\S",
  headerSeverity: "warn",
  headerRequiredClauses: [],
  headerRequiredClausesSeverity: "warn",
  flatRoots: false,
  flatRootSeverity: "warn",
  sharedBucketNames: [
    "types",
    "constants",
    "utils",
    "helpers",
    "shared",
    "common",
  ],
  allowedSharedBuckets: [],
  sharedBucketSeverity: "warn",
  forbiddenEdges: [],
  layers: [],
  surfaceRules: [],
};
const DEFAULT_CONFIG_NAMES = ["domain-dag.json", ".domain-dag.json"];
const MAX_LISTED_ITEMS = 30;

function toPosixPath(path) {
  return path.split(sep).join("/");
}

function escapeRegExp(text) {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(glob) {
  const pattern = toPosixPath(glob);
  let output = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (
      char === "*" &&
      pattern[index + 1] === "*" &&
      pattern[index + 2] === "/"
    ) {
      output += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (char === "*" && pattern[index + 1] === "*") {
      output += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      output += "[^/]*";
      continue;
    }
    if (char === "?") {
      output += "[^/]";
      continue;
    }
    output += escapeRegExp(char);
  }
  return new RegExp(`${output}$`);
}

function matchesAnyGlob(path, patterns) {
  const normalized = toPosixPath(path);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

function parseArgs(argv) {
  const args = {
    json: false,
    strict: false,
    root: undefined,
    config: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--strict") {
      args.strict = true;
      continue;
    }
    if (arg === "--root") {
      args.root = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--config") {
      args.config = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (!arg.startsWith("-") && !args.root) {
      args.root = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(
    [
      "Domain DAG validator",
      "",
      "Usage:",
      "  validate-domain-dag.sh [--root <path>] [--config <path>] [--strict] [--json]",
      "",
      "Checks local source import cycles, composition-root reach-through, shared buckets, headers, and configured layer/edge rules.",
    ].join("\n"),
  );
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function findConfigPath(root, explicitConfig) {
  if (explicitConfig) return resolve(root, explicitConfig);
  for (const name of DEFAULT_CONFIG_NAMES) {
    const candidate = join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function loadConfig(root, explicitConfig) {
  const configPath = findConfigPath(root, explicitConfig);
  if (!configPath)
    return {
      config: { ...DEFAULT_CONFIG },
      configPath: undefined,
    };
  const loadedConfig = readJsonFile(configPath);
  return { config: { ...DEFAULT_CONFIG, ...loadedConfig }, configPath };
}

function createReporter({ json, strict }) {
  const state = {
    errors: 0,
    warnings: 0,
    items: [],
  };
  const color = (code, text) =>
    json || process.env.NO_COLOR || !process.stdout.isTTY
      ? text
      : `\x1b[${code}m${text}\x1b[0m`;
  const emit = (level, message, details = {}) => {
    const effectiveLevel = strict && level === "warn" ? "error" : level;
    if (effectiveLevel === "error") state.errors += 1;
    if (effectiveLevel === "warn") state.warnings += 1;
    state.items.push({ level: effectiveLevel, message, details });
    if (json) return;
    const label =
      effectiveLevel === "error"
        ? color("0;31", "[FAIL]")
        : effectiveLevel === "warn"
          ? color("1;33", "[WARN]")
          : effectiveLevel === "pass"
            ? color("0;32", "[PASS]")
            : color("0;36", "[INFO]");
    console.log(`${label} ${message}`);
  };
  return {
    state,
    info: (message, details) => emit("info", message, details),
    pass: (message, details) => emit("pass", message, details),
    warn: (message, details) => emit("warn", message, details),
    error: (message, details) => emit("error", message, details),
    bySeverity: (severity, message, details) => {
      if (severity === "off") return;
      if (severity === "error") emit("error", message, details);
      else emit("warn", message, details);
    },
  };
}

function isIgnoredDirectory(name, config) {
  return config.ignoreDirs.includes(name);
}

function isSourceFile(path, root, config) {
  const relativePath = toPosixPath(relative(root, path));
  const extension = extname(path);
  if (!config.sourceExtensions.includes(extension)) return false;
  if (relativePath.endsWith(".d.ts")) return false;
  return !matchesAnyGlob(relativePath, config.excludePatterns);
}

function walkSourceFiles(directory, root, config, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!isIgnoredDirectory(entry.name, config))
        walkSourceFiles(absolutePath, root, config, files);
      continue;
    }
    if (entry.isFile() && isSourceFile(absolutePath, root, config))
      files.add(resolve(absolutePath));
  }
}

function collectSourceFiles(root, config) {
  const files = new Set();
  for (const sourceRoot of config.sourceRoots) {
    const absoluteRoot = resolve(root, sourceRoot);
    if (!existsSync(absoluteRoot)) continue;
    const stats = statSync(absoluteRoot);
    if (stats.isFile() && isSourceFile(absoluteRoot, root, config))
      files.add(resolve(absoluteRoot));
    if (stats.isDirectory()) walkSourceFiles(absoluteRoot, root, config, files);
  }
  for (const entrypoint of config.entrypoints) {
    const absolutePath = resolve(root, entrypoint);
    if (
      existsSync(absolutePath) &&
      statSync(absolutePath).isFile() &&
      isSourceFile(absolutePath, root, config)
    )
      files.add(resolve(absolutePath));
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

function stripSourceComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n\r]*/gm, "$1");
}

function getImportSpecifiers(source) {
  const cleaned = stripSourceComments(source);
  const specifiers = new Set();
  const patterns = [
    /(import|export)\s+(type\s+)?[^"']*?\s+from\s*["']([^"']+)["']/g,
    /import\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      specifiers.add(match[match.length - 1]);
    }
  }
  return [...specifiers].filter(Boolean);
}

function getImportResolutionCandidates(basePath, config) {
  const candidates = [basePath];
  for (const extension of config.sourceExtensions)
    candidates.push(`${basePath}${extension}`);
  for (const extension of config.sourceExtensions)
    candidates.push(join(basePath, `index${extension}`));
  return candidates;
}

function getImportAliasBase(root, specifier, config) {
  const aliases = config.importAliases ?? {};
  for (const [aliasPattern, targetPattern] of Object.entries(aliases)) {
    if (aliasPattern.endsWith("/*") && targetPattern.endsWith("/*")) {
      const aliasPrefix = aliasPattern.slice(0, -1);
      if (specifier.startsWith(aliasPrefix)) {
        const suffix = specifier.slice(aliasPrefix.length);
        return resolve(root, targetPattern.slice(0, -1), suffix);
      }
      continue;
    }
    if (specifier === aliasPattern) return resolve(root, targetPattern);
  }
  return undefined;
}

function resolveLocalImport(fromFile, specifier, fileSet, config, root) {
  const basePath = specifier.startsWith(".")
    ? resolve(dirname(fromFile), specifier)
    : getImportAliasBase(root, specifier, config);
  if (!basePath) return undefined;
  for (const candidate of getImportResolutionCandidates(basePath, config)) {
    const normalized = resolve(candidate);
    if (fileSet.has(normalized)) return normalized;
  }
  return undefined;
}

function buildImportGraph(root, files, config) {
  const fileSet = new Set(files.map((file) => resolve(file)));
  const graph = new Map();
  for (const file of files) {
    const deps = [];
    const source = readFileSync(file, "utf8");
    for (const specifier of getImportSpecifiers(source)) {
      const resolved = resolveLocalImport(
        file,
        specifier,
        fileSet,
        config,
        root,
      );
      if (resolved) deps.push(toPosixPath(relative(root, resolved)));
    }
    graph.set(toPosixPath(relative(root, file)), [...new Set(deps)].sort());
  }
  return graph;
}

function findCycles(graph) {
  const cycles = [];
  const visited = new Set();
  const active = [];
  const visit = (file) => {
    const activeIndex = active.indexOf(file);
    if (activeIndex !== -1) {
      cycles.push([...active.slice(activeIndex), file]);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    active.push(file);
    for (const dep of graph.get(file) ?? []) visit(dep);
    active.pop();
  };
  for (const file of graph.keys()) visit(file);
  return cycles;
}

function getEntrypointSet(root, files, config) {
  const fileSet = new Set(files.map((file) => resolve(file)));
  const entrypoints = new Set();
  for (const entrypoint of config.entrypoints) {
    const absolutePath = resolve(root, entrypoint);
    if (fileSet.has(absolutePath))
      entrypoints.add(toPosixPath(relative(root, absolutePath)));
  }
  return entrypoints;
}

function validateEntrypointReachThrough(graph, entrypoints, reporter) {
  const violations = [];
  for (const [file, deps] of graph.entries()) {
    if (entrypoints.has(file)) continue;
    for (const dep of deps)
      if (entrypoints.has(dep)) violations.push(`${file} -> ${dep}`);
  }
  if (violations.length === 0) {
    reporter.pass("Domain modules do not import configured entrypoints");
    return;
  }
  for (const violation of violations.slice(0, MAX_LISTED_ITEMS))
    reporter.error(`Domain module imports composition root: ${violation}`);
  if (violations.length > MAX_LISTED_ITEMS)
    reporter.error(
      `Additional entrypoint reach-through violations: ${violations.length - MAX_LISTED_ITEMS}`,
    );
}

function validateHeaders(root, files, config, reporter) {
  if (!config.requireHeaders) return;
  const pattern = new RegExp(config.headerPattern, "im");
  const missing = [];
  const missingClauses = [];
  const requiredClauses = Array.isArray(config.headerRequiredClauses)
    ? config.headerRequiredClauses
    : [];
  for (const file of files) {
    const relativePath = toPosixPath(relative(root, file));
    const sourceHead = readFileSync(file, "utf8").slice(0, 1600);
    const hasHeader = pattern.test(sourceHead);
    if (!hasHeader) {
      missing.push(relativePath);
      continue;
    }
    for (const clause of requiredClauses) {
      if (clause && !sourceHead.includes(clause))
        missingClauses.push(`${relativePath} missing '${clause}'`);
    }
  }
  if (missing.length === 0) reporter.pass("Domain headers are present");
  else {
    for (const file of missing.slice(0, MAX_LISTED_ITEMS))
      reporter.bySeverity(
        config.headerSeverity,
        `Missing domain header: ${file}`,
      );
    if (missing.length > MAX_LISTED_ITEMS)
      reporter.bySeverity(
        config.headerSeverity,
        `Additional files without domain headers: ${missing.length - MAX_LISTED_ITEMS}`,
      );
  }
  if (requiredClauses.length === 0) return;
  if (missingClauses.length === 0) {
    reporter.pass("Required domain-header clauses are present");
    return;
  }
  for (const item of missingClauses.slice(0, MAX_LISTED_ITEMS))
    reporter.bySeverity(
      config.headerRequiredClausesSeverity,
      `Domain header clause missing: ${item}`,
    );
  if (missingClauses.length > MAX_LISTED_ITEMS)
    reporter.bySeverity(
      config.headerRequiredClausesSeverity,
      `Additional missing domain-header clauses: ${missingClauses.length - MAX_LISTED_ITEMS}`,
    );
}

function validateSharedBuckets(root, files, config, reporter) {
  const violations = [];
  const names = new Set(config.sharedBucketNames);
  for (const file of files) {
    const relativePath = toPosixPath(relative(root, file));
    if (matchesAnyGlob(relativePath, config.allowedSharedBuckets)) continue;
    const parts = relativePath.split("/");
    const baseName = basename(relativePath, extname(relativePath));
    if (names.has(baseName)) violations.push(`file ${relativePath}`);
    for (const part of parts.slice(0, -1))
      if (names.has(part)) violations.push(`folder ${part} in ${relativePath}`);
  }
  if (violations.length === 0) {
    reporter.pass("No shared-bucket candidates found");
    return;
  }
  for (const violation of violations.slice(0, MAX_LISTED_ITEMS))
    reporter.bySeverity(
      config.sharedBucketSeverity,
      `Shared-bucket candidate: ${violation}`,
    );
  if (violations.length > MAX_LISTED_ITEMS)
    reporter.bySeverity(
      config.sharedBucketSeverity,
      `Additional shared-bucket candidates: ${violations.length - MAX_LISTED_ITEMS}`,
    );
}

function validateFlatRoots(root, files, config, reporter) {
  if (!config.flatRoots) return;
  const violations = [];
  const sourceRoots = config.sourceRoots
    .map((sourceRoot) => resolve(root, sourceRoot))
    .filter(
      (sourceRoot) =>
        existsSync(sourceRoot) && statSync(sourceRoot).isDirectory(),
    );
  for (const file of files) {
    for (const sourceRoot of sourceRoots) {
      const inside = relative(sourceRoot, file);
      if (
        inside.startsWith("..") ||
        resolve(sourceRoot, inside) !== resolve(file)
      )
        continue;
      if (toPosixPath(inside).includes("/"))
        violations.push(toPosixPath(relative(root, file)));
    }
  }
  if (violations.length === 0) {
    reporter.pass("Configured flat roots have no nested source files");
    return;
  }
  for (const violation of violations.slice(0, MAX_LISTED_ITEMS))
    reporter.bySeverity(
      config.flatRootSeverity,
      `Nested source file in flat root: ${violation}`,
    );
  if (violations.length > MAX_LISTED_ITEMS)
    reporter.bySeverity(
      config.flatRootSeverity,
      `Additional nested flat-root files: ${violations.length - MAX_LISTED_ITEMS}`,
    );
}

function getLayerForFile(file, layers) {
  for (let index = 0; index < layers.length; index += 1) {
    const layer = layers[index];
    const rank = Number.isFinite(layer.rank) ? layer.rank : index;
    if (matchesAnyGlob(file, layer.files ?? []))
      return { name: layer.name ?? `layer-${index}`, rank };
  }
  return undefined;
}

function validateLayers(graph, config, reporter) {
  if (!Array.isArray(config.layers) || config.layers.length === 0) return;
  const violations = [];
  for (const [file, deps] of graph.entries()) {
    const fromLayer = getLayerForFile(file, config.layers);
    if (!fromLayer) continue;
    for (const dep of deps) {
      const toLayer = getLayerForFile(dep, config.layers);
      if (toLayer && fromLayer.rank < toLayer.rank)
        violations.push(
          `${file} (${fromLayer.name}) -> ${dep} (${toLayer.name})`,
        );
    }
  }
  if (violations.length === 0) {
    reporter.pass("Configured layer direction holds");
    return;
  }
  for (const violation of violations.slice(0, MAX_LISTED_ITEMS))
    reporter.error(`Layer direction violation: ${violation}`);
  if (violations.length > MAX_LISTED_ITEMS)
    reporter.error(
      `Additional layer violations: ${violations.length - MAX_LISTED_ITEMS}`,
    );
}

function collectConfiguredGlobs(config) {
  const globs = [];
  const add = (owner, value) => {
    if (!value) return;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (typeof item === "string") globs.push({ owner, value: item });
    }
  };
  add("sourceRoots", config.sourceRoots);
  add("entrypoints", config.entrypoints);
  add("allowedSharedBuckets", config.allowedSharedBuckets);
  for (const edge of config.forbiddenEdges ?? []) {
    add("forbiddenEdges.from", edge.from);
    add("forbiddenEdges.to", edge.to);
  }
  for (const layer of config.layers ?? [])
    add(`layers.${layer.name ?? "unnamed"}`, layer.files);
  for (const rule of config.surfaceRules ?? [])
    add(`surfaceRules.${rule.name ?? "unnamed"}`, rule.files);
  return globs;
}

function validateConfigSyntax(config, reporter) {
  const unsupportedBraceGlobs = collectConfiguredGlobs(config).filter(
    ({ value }) => /[{}]/.test(value),
  );
  for (const glob of unsupportedBraceGlobs.slice(0, MAX_LISTED_ITEMS)) {
    reporter.warn(
      `Unsupported brace glob syntax in ${glob.owner}: ${glob.value}; expand it into separate glob entries`,
    );
  }
  if (unsupportedBraceGlobs.length > MAX_LISTED_ITEMS)
    reporter.warn(
      `Additional unsupported brace globs: ${unsupportedBraceGlobs.length - MAX_LISTED_ITEMS}`,
    );
}

function validateSurfaceRules(root, files, config, reporter) {
  if (!Array.isArray(config.surfaceRules) || config.surfaceRules.length === 0)
    return;
  for (const rule of config.surfaceRules) {
    const max = Number.isFinite(rule.max) ? rule.max : undefined;
    if (max === undefined) continue;
    const filesGlob = Array.isArray(rule.files)
      ? rule.files
      : rule.files
        ? [rule.files]
        : ["**/*"];
    const violations = [];
    for (const file of files) {
      const relativePath = toPosixPath(relative(root, file));
      if (!matchesAnyGlob(relativePath, filesGlob)) continue;
      const source = readFileSync(file, "utf8");
      let count = 0;
      if (rule.metric === "lines") {
        count = source.split(/\r?\n/).length;
      } else {
        if (!rule.pattern) continue;
        const pattern = new RegExp(rule.pattern, rule.flags ?? "g");
        const matches = new Set();
        for (const match of source.matchAll(pattern)) {
          matches.add(match[1] ?? match[0]);
        }
        count = matches.size;
      }
      if (count > max)
        violations.push(`${relativePath} measured ${count}/${max}`);
    }
    if (violations.length === 0) {
      reporter.pass(
        rule.passMessage ??
          `Surface rule holds: ${rule.name ?? rule.pattern ?? rule.metric}`,
      );
      continue;
    }
    for (const violation of violations.slice(0, MAX_LISTED_ITEMS))
      reporter.bySeverity(
        rule.severity ?? "warn",
        `${rule.message ?? "Wide interface surface"}: ${violation}`,
      );
    if (violations.length > MAX_LISTED_ITEMS)
      reporter.bySeverity(
        rule.severity ?? "warn",
        `Additional surface-rule violations: ${violations.length - MAX_LISTED_ITEMS}`,
      );
  }
}

function validateForbiddenEdges(graph, config, reporter) {
  if (
    !Array.isArray(config.forbiddenEdges) ||
    config.forbiddenEdges.length === 0
  )
    return;
  const violations = [];
  for (const [file, deps] of graph.entries()) {
    for (const dep of deps) {
      for (const rule of config.forbiddenEdges) {
        const fromMatches =
          !rule.from ||
          matchesAnyGlob(
            file,
            Array.isArray(rule.from) ? rule.from : [rule.from],
          );
        const toMatches =
          !rule.to ||
          matchesAnyGlob(dep, Array.isArray(rule.to) ? rule.to : [rule.to]);
        if (fromMatches && toMatches)
          violations.push({
            severity: rule.severity ?? "error",
            message: rule.message ?? "Forbidden edge",
            edge: `${file} -> ${dep}`,
          });
      }
    }
  }
  if (violations.length === 0) {
    reporter.pass("Configured forbidden edges are absent");
    return;
  }
  for (const violation of violations.slice(0, MAX_LISTED_ITEMS))
    reporter.bySeverity(
      violation.severity,
      `${violation.message}: ${violation.edge}`,
    );
  if (violations.length > MAX_LISTED_ITEMS)
    reporter.error(
      `Additional forbidden-edge violations: ${violations.length - MAX_LISTED_ITEMS}`,
    );
}

function countEdges(graph) {
  let count = 0;
  for (const deps of graph.values()) count += deps.length;
  return count;
}

function runValidation(args) {
  const root = resolve(
    args.root ?? process.env.DOMAIN_DAG_ROOT ?? process.cwd(),
  );
  const { config, configPath } = loadConfig(root, args.config);
  const reporter = createReporter(args);
  const files = collectSourceFiles(root, config);
  const graph = buildImportGraph(root, files, config);
  const cycles = findCycles(graph);
  if (!args.json) console.log("--- DOMAIN DAG VALIDATOR ---\n");
  reporter.info(`Root: ${root}`);
  if (configPath) reporter.info(`Config: ${configPath}`);
  validateConfigSyntax(config, reporter);
  reporter.info(
    `Source files ${files.length}, local edges ${countEdges(graph)}`,
  );
  if (files.length === 0)
    reporter.warn("No source files found in configured roots");
  if (cycles.length === 0)
    reporter.pass("Local source import graph is acyclic");
  for (const cycle of cycles.slice(0, MAX_LISTED_ITEMS))
    reporter.error(`Import cycle: ${cycle.join(" -> ")}`);
  if (cycles.length > MAX_LISTED_ITEMS)
    reporter.error(
      `Additional import cycles: ${cycles.length - MAX_LISTED_ITEMS}`,
    );
  validateEntrypointReachThrough(
    graph,
    getEntrypointSet(root, files, config),
    reporter,
  );
  validateHeaders(root, files, config, reporter);
  validateSharedBuckets(root, files, config, reporter);
  validateFlatRoots(root, files, config, reporter);
  validateLayers(graph, config, reporter);
  validateSurfaceRules(root, files, config, reporter);
  validateForbiddenEdges(graph, config, reporter);
  if (args.json) console.log(JSON.stringify(reporter.state, null, 2));
  else
    console.log(
      `\nResult: ${reporter.state.errors} error(s), ${reporter.state.warnings} warning(s)`,
    );
  return reporter.state.errors === 0 ? 0 : 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  return runValidation(args);
}

try {
  process.exitCode = main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`RUNTIME ERROR: ${message}`);
  process.exitCode = 1;
}
