/**
 * Opt-in archived-reader assessment against temporary transaction guards.
 * Zones: filesystem compatibility, validation fixtures
 * Usage: node scripts/probe-transaction-guard-compat.mjs [local-git-ref ...]
 * Copies exact compiled dependency closures; never loads Pi or touches configured runtime storage.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const refs = process.argv.slice(2);
if (!refs.length) refs.push("v0.58.0", "v0.58.1", "v0.58.2", "v0.58.3");
const sha256 = data => createHash("sha256").update(data).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 4 * 1024 * 1024 });
const groups = new Map();

// Resolve and preflight every closure before executing any archived module.
for (const ref of refs) {
  const commit = git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).toString().trim();
  const modules = new Map();
  function capture(file) {
    if (modules.has(file)) return;
    assert.ok(file.startsWith("dist/lib/") && file.endsWith(".js"), `Unsupported archived dependency: ${file}`);
    const bytes = git("show", `${commit}:${file}`);
    const source = ts.createSourceFile(file, bytes.toString(), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(source.parseDiagnostics.length, 0, `Invalid archived module: ${file}`);
    modules.set(file, { file, bytes, sha256: sha256(bytes), blob: git("rev-parse", `${commit}:${file}`).toString().trim() });
    function dependency(specifier) {
      if (isBuiltin(specifier)) return;
      assert.ok(specifier.startsWith("./") || specifier.startsWith("../"), `Refusing non-native archived dependency: ${specifier}`);
      capture(posix.normalize(posix.join(posix.dirname(file), specifier)));
    }
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        assert.ok(ts.isStringLiteral(node.moduleSpecifier)); dependency(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        assert.ok(node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]), `Unresolved archived dependency: ${file}`);
        dependency(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  capture("dist/lib/locks.js");
  const ordered = [...modules.values()].sort((a, b) => a.file.localeCompare(b.file));
  const fingerprint = sha256(JSON.stringify(ordered.map(({ file, sha256: digest }) => [file, digest])));
  if (!groups.has(fingerprint)) groups.set(fingerprint, { fingerprint, refs: [], modules: ordered });
  groups.get(fingerprint).refs.push({ ref, commit });
}

const temp = mkdtempSync(join(tmpdir(), "pt-guard-compat-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(temp, "isolated-agent");
try {
  writeFileSync(join(temp, "package.json"), '{"type":"module"}', { mode: 0o600 });
  const exited = spawnSync(process.execPath, ["--input-type=module", "-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", timeout: 5000 });
  assert.equal(exited.status, 0, exited.stderr);
  const absentPid = Number(exited.stdout); assert.ok(Number.isSafeInteger(absentPid) && absentPid > 0);
  assert.throws(() => process.kill(absentPid, 0), error => error.code === "ESRCH", "Require an actually absent fixture process");
  const report = { node: process.version, platform: process.platform, refs: refs.length, closures: [] };
  let index = 0;
  for (const group of groups.values()) {
    const snapshot = join(temp, `snapshot-${index++}`);
    for (const module of group.modules) {
      const destination = join(snapshot, module.file); mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, module.bytes, { mode: 0o600 });
      assert.equal(sha256(readFileSync(destination)), module.sha256);
    }
    const kernel = await import(pathToFileURL(join(snapshot, "dist/lib/locks.js")).href);
    assert.equal(typeof kernel.withTelegramFileTransaction, "function");
    const results = [];
    function assess(name, fixture, expectedCalls) {
      const dir = join(snapshot, `case-${results.length}`); mkdirSync(dir, { mode: 0o700 });
      const path = join(dir, "guard"); fixture?.(path);
      const snapshotGuard = () => {
        if (!existsSync(path)) return undefined;
        const stat = lstatSync(path), names = stat.isDirectory() ? readdirSync(path).sort() : [];
        return { ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid, names,
          bytes: names.length ? names.map(entry => readFileSync(join(path, entry)).toString("base64")) : readFileSync(path).toString("base64") };
      };
      const before = snapshotGuard(), siblings = readdirSync(dir).sort();
      let calls = 0, error;
      try { kernel.withTelegramFileTransaction(path, () => { calls++; assert.ok(existsSync(path)); }, { attempts: 2, retryDelayMs: 0 }); }
      catch (caught) { error = caught; }
      assert.ok(calls === 0 || calls === 1, name);
      if (calls) {
        assert.equal(error, undefined, `${name}: release failure cannot be classified as no execution`);
        assert.equal(existsSync(path), false, name);
      } else {
        assert.ok(error instanceof Error, name); assert.deepEqual(snapshotGuard(), before, name);
        assert.deepEqual(readdirSync(dir).sort(), siblings, name);
      }
      if (expectedCalls !== undefined) assert.equal(calls, expectedCalls, `${name}: protected callback count`);
      results.push({ name, calls, outcome: calls ? "executed" : "refused", error: error?.name });
    }
    const nonce = randomUUID(), opaque = `v2-p${process.pid}-${nonce}`;
    const legacyBody = pid => JSON.stringify({ pid, acquiredAtMs: 1, generation: nonce });
    const directory = (marker, body) => path => { mkdirSync(path, { mode: 0o700 }); writeFileSync(join(path, marker), body, { mode: 0o600 }); };
    assess("fresh-native-control", undefined, 1);
    assess("dead-legacy-file-control", path => writeFileSync(path, legacyBody(absentPid), { mode: 0o600 }), 1);
    assess("live-legacy-file-control", path => writeFileSync(path, legacyBody(process.pid), { mode: 0o600 }), 0);
    for (const phase of ["owner", "claim"]) for (const bodyKind of ["v2-complete", "empty", "v1-conflicting"]) {
      const ownerPid = bodyKind === "v1-conflicting" ? process.pid : absentPid;
      const marker = phase === "owner" ? `owner.v2.${ownerPid}.${nonce}.json` : `owner.reclaim.v2.${ownerPid}.${nonce}.${absentPid}.${randomUUID()}.json`;
      const body = bodyKind === "empty" ? "" : bodyKind === "v2-complete"
        ? JSON.stringify({ version: 2, owner: { pid: ownerPid, nonce, acquiredAtMs: 1 } })
        : JSON.stringify({ pid: absentPid, acquiredAtMs: 1, generation: opaque });
      assess(`reserved-${phase}/${bodyKind}`, directory(marker, body), 0);
    }
    for (const phase of ["owner", "claim"]) for (const bodyKind of ["empty", "equal-old-body"]) {
      const dir = join(snapshot, `case-${results.length}`); mkdirSync(dir, { mode: 0o700 });
      const path = join(dir, "guard"), displaced = join(dir, "displaced");
      const originalNonce = randomUUID(), recovererNonce = randomUUID();
      const marker = phase === "owner" ? `owner.v2.${process.pid}.${originalNonce}.json`
        : `owner.reclaim.v2.${absentPid}.${originalNonce}.${process.pid}.${recovererNonce}.json`;
      let calls = 0, error, oldBytes, oldMarker, foreignBytes, rootInode, markerInode;
      try {
        kernel.withTelegramFileTransaction(path, () => {
          calls++; oldMarker = lstatSync(path).isDirectory() ? readdirSync(path)[0] : undefined;
          oldBytes = readFileSync(oldMarker ? join(path, oldMarker) : path);
          // Simulate replacement before a delayed old finally/release; never touch any real guard.
          renameSync(path, displaced); mkdirSync(path, { mode: 0o700 });
          foreignBytes = bodyKind === "empty" ? Buffer.alloc(0) : oldBytes;
          writeFileSync(join(path, marker), foreignBytes, { mode: 0o600 });
          rootInode = lstatSync(path).ino; markerInode = lstatSync(join(path, marker)).ino;
        }, { attempts: 2, retryDelayMs: 0 });
      } catch (caught) { error = caught; }
      const name = `delayed-release/${phase}/${bodyKind}`;
      assert.equal(calls, 1, name); assert.ok(existsSync(path), name);
      assert.deepEqual(readdirSync(path), [marker], name);
      assert.equal(lstatSync(path).ino, rootInode, name); assert.equal(lstatSync(join(path, marker)).ino, markerInode, name);
      assert.deepEqual(readFileSync(join(path, marker)), foreignBytes, name);
      assert.deepEqual(readFileSync(oldMarker ? join(displaced, oldMarker) : displaced), oldBytes, name);
      results.push({ name, calls, outcome: "replacement-preserved", error: error?.name });
    }
    // Counterexamples are classified, not assumed: older file-only kernels may refuse every directory.
    assess("opaque-owner-counterexample", directory(`owner.${opaque}.json`, JSON.stringify({ pid: absentPid, acquiredAtMs: 1, generation: opaque })));
    assess("legacy-claim-downgrade-counterexample", directory(`owner.reclaim.${process.pid}.${randomUUID()}.json`, legacyBody(absentPid)));
    report.closures.push({ fingerprint: group.fingerprint, refs: group.refs,
      modules: group.modules.map(({ file, blob, sha256: digest }) => ({ file, blob, sha256: digest })), results });
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(temp, { recursive: true, force: true });
}
