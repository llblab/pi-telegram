#!/usr/bin/env node

/**
 * Builds or verifies the distributive JavaScript, declarations, Pi entrypoint,
 * Skills, and runtime assets without exposing a partial tree.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

const DIST_DIR = "dist";
const checkOnly = process.argv.includes("--check");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
  }
}

function listFiles(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    return entry.isDirectory() ? listFiles(root, path) : [relative(root, path)];
  }).sort();
}

function normalizeTextFiles(root) {
  const textSuffixes = [".js", ".ts", ".mjs", ".json", ".md"];
  for (const path of listFiles(root)) {
    if (!textSuffixes.some((suffix) => path.endsWith(suffix))) continue;
    const absolutePath = join(root, path);
    const source = readFileSync(absolutePath, "utf8");
    const normalized = source.replace(/\r\n?/g, "\n");
    if (normalized !== source) writeFileSync(absolutePath, normalized, "utf8");
  }
}

function assertTreesEqual(expectedRoot, actualRoot) {
  if (!existsSync(expectedRoot)) {
    throw new Error(`${expectedRoot} is missing; run npm run build.`);
  }
  const expectedFiles = listFiles(expectedRoot);
  const actualFiles = listFiles(actualRoot);
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error("dist file inventory is stale; run npm run build.");
  }
  for (const path of expectedFiles) {
    if (!readFileSync(join(expectedRoot, path)).equals(readFileSync(join(actualRoot, path)))) {
      throw new Error(`dist/${path} is stale; run npm run build.`);
    }
  }
}

function replaceDist(candidate) {
  const backup = `.dist-backup-${process.pid}-${Date.now()}`;
  const hadDist = existsSync(DIST_DIR);
  if (hadDist) renameSync(DIST_DIR, backup);
  try {
    renameSync(candidate, DIST_DIR);
    if (hadDist) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (hadDist && existsSync(backup) && !existsSync(DIST_DIR)) {
      renameSync(backup, DIST_DIR);
    }
    throw error;
  }
}

const candidate = mkdtempSync(join(process.cwd(), ".dist-build-"));
try {
  run(process.execPath, [
    join("node_modules", "typescript", "bin", "tsc"),
    "-p",
    "tsconfig.build.json",
    "--outDir",
    candidate,
  ]);

  mkdirSync(join(candidate, "pi-telegram"), { recursive: true });
  writeFileSync(
    join(candidate, "pi-telegram", "index.js"),
    'export { default } from "../index.js";\n',
    "utf8",
  );
  cpSync("skills", join(candidate, "skills"), { recursive: true });
  cpSync("package.json", join(candidate, "package.json"));
  cpSync(
    join("lib", "generative-app-worker.mjs"),
    join(candidate, "lib", "generative-app-worker.mjs"),
  );
  normalizeTextFiles(candidate);
  run(process.execPath, ["--check", join(candidate, "pi-telegram", "index.js")]);

  if (checkOnly) {
    assertTreesEqual(DIST_DIR, candidate);
    console.log("pi-telegram: dist is current");
  } else {
    replaceDist(candidate);
  }
} finally {
  rmSync(candidate, { recursive: true, force: true });
}
