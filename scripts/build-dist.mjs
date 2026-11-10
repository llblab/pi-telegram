#!/usr/bin/env node

/**
 * Builds or verifies the distributive JavaScript, declarations, Pi entrypoint,
 * Skills, and runtime assets without exposing a partial tree.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  writeSync,
} from "node:fs";
import { join, relative } from "node:path";

const DIST_DIR = "dist";
const checkOnly = process.argv.includes("--check");
const ciBuild = process.env.GITHUB_ACTIONS === "true";
const buildId = ciBuild ? randomBytes(8).toString("hex") : null;
let buildRecordCount = 0;

// Closed build phases only: at most six parent and two compiler records, including framing below 4 KiB.
function reportBuild(phase, details = {}) {
  if (!ciBuild || buildRecordCount >= 6) return;
  buildRecordCount++;
  try {
    const record = { v: 1, build: buildId, phase, pid: process.pid, ppid: process.ppid, uptimeMs: Math.trunc(process.uptime() * 1000), ...details };
    const line = "::notice title=CI native build::" + JSON.stringify(record) + "\n";
    if (Buffer.byteLength(line) <= 384) writeSync(1, line);
  } catch { /* Diagnostics cannot replace the compiler or filesystem outcome. */ }
}

// A public Node preload observes this actual child; entry/exit events are not parent settlement or publication.
const compilerObserver = "data:text/javascript," + encodeURIComponent(`
  import { writeSync } from "node:fs";
  const ciBuild = true, buildId = ${JSON.stringify(buildId)};
  let buildRecordCount = 0;
  ${reportBuild.toString()}
  reportBuild("compiler-node-entered");
  process.once("exit", code => reportBuild("compiler-node-exiting", { code }));
`);

function run(command, args, phase) {
  if (phase === "compiler") {
    let detachedHead = null;
    if (ciBuild) {
      try { const head = readFileSync(".git/HEAD", "utf8").trim(); if (/^[a-f0-9]{40}$/.test(head)) detachedHead = head; } catch {}
    }
    reportBuild("compiler-invoking", { detachedHead });
  }
  const nodeArgs = phase === "compiler" && ciBuild ? ["--import", compilerObserver, ...args] : args;
  const result = spawnSync(command, nodeArgs, { stdio: "inherit" });
  if (phase === "compiler") reportBuild("compiler-returned", { childPid: result.pid || null, code: result.status, signal: result.signal, spawnError: !!result.error });
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

reportBuild("build-entered", { check: checkOnly });
const candidate = mkdtempSync(join(process.cwd(), ".dist-build-"));
try {
  run(process.execPath, [
    join("node_modules", "typescript", "bin", "tsc"),
    "-p",
    "tsconfig.build.json",
    "--outDir",
    candidate,
  ], "compiler");

  mkdirSync(join(candidate, "pi-telegram"), { recursive: true });
  writeFileSync(
    join(candidate, "pi-telegram", "index.js"),
    'export { default } from "../index.js";\n',
    "utf8",
  );
  normalizeTextFiles(candidate);
  cpSync("skills", join(candidate, "skills"), { recursive: true });
  cpSync("package.json", join(candidate, "package.json"));
  cpSync(
    join("lib", "generative-app-worker.mjs"),
    join(candidate, "lib", "generative-app-worker.mjs"),
  );
  reportBuild("assets-prepared");
  run(process.execPath, ["--check", join(candidate, "pi-telegram", "index.js")]);

  reportBuild("publication-invoking", { check: checkOnly });
  if (checkOnly) {
    assertTreesEqual(DIST_DIR, candidate);
    console.log("pi-telegram: dist is current");
  } else {
    replaceDist(candidate);
  }
  reportBuild("publication-complete", { check: checkOnly });
} finally {
  rmSync(candidate, { recursive: true, force: true });
}
