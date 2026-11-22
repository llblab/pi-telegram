/**
 * Opt-in archived-reader assessment against temporary transaction guards.
 * Zones: filesystem compatibility, validation fixtures
 * Usage: node scripts/probe-transaction-guard-compat.mjs [local-git-ref ...]
 * Copies exact compiled dependency closures; never loads Pi or touches configured runtime storage.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const { installTelegramLegacyTransactionBarrier } = await import("../dist/lib/locks.js");
const prepare = fileURLToPath(new URL("./prepare-cold-cutover.mjs", import.meta.url));
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
      const path = join(dir, "guard.transaction"); fixture?.(path);
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
    assess("cold-cutover-barrier", path => assert.equal(installTelegramLegacyTransactionBarrier(path, () => true), "installed"), 0);
    if (typeof kernel.mutateTelegramRuntimeStateSection === "function") for (const damaged of [false, true]) {
      const dir = join(snapshot, damaged ? "cold-cutover-damaged-section" : "cold-cutover-section"), path = join(dir, "state.json");
      const guard = join(dir, "runtime", "state.json.transaction"), initial = '{"version":2,"profiles":{"default":{"runtime":{"marker":"after cutover"}}}}\n';
      const retainedOwner = join(guard, `owner.${randomUUID()}.json`);
      if (damaged) {
        mkdirSync(guard, { recursive: true, mode: 0o700 });
        writeFileSync(retainedOwner, "", { mode: 0o600 });
      }
      const markerPath = damaged ? join(guard, "kernel-cutover-v1") : guard;
      assert.equal(installTelegramLegacyTransactionBarrier(guard, () => true, damaged ? { allowDamagedDirectory: true } : {}), "installed");
      const marker = readFileSync(markerPath), before = lstatSync(guard, { bigint: true });
      writeFileSync(path, initial, { mode: 0o600 });
      let calls = 0;
      assert.throws(() => kernel.mutateTelegramRuntimeStateSection(path, "default", "runtime", () => {
        calls++;
        return { value: { marker: "stale legacy write" }, result: true };
      }, { isCurrent: () => true }), typeof kernel.TelegramFileTransactionGuardError === "function"
        ? { code: "guard-unverifiable", phase: "acquire" }
        : /Timed out acquiring Telegram lock transaction/u);
      assert.equal(calls, 0);
      assert.equal(readFileSync(path, "utf8"), initial);
      assert.deepEqual(readFileSync(markerPath), marker);
      assert.equal(lstatSync(guard, { bigint: true }).ino, before.ino);
      if (damaged) assert.equal(readFileSync(retainedOwner).length, 0);
      results.push({ name: damaged ? "cold-cutover-damaged-runtime-section" : "cold-cutover-runtime-section", calls, outcome: "refused" });
    }
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
    if (typeof kernel.mutateTelegramRuntimeStateSection === "function" && process.arch === "x64") for (const damaged of [false, true]) {
      const layout = damaged ? "damaged" : "vacant";
      const dir = join(snapshot, `cold-polling-agent-${layout}`); mkdirSync(dir, { mode: 0o700 });
      const agent = realpathSync(dir), statePath = join(agent, "tmp", "pi-telegram", "state.json");
      const guard = join(dirname(statePath), "runtime", "state.json.transaction");
      const mode = join(agent, "telegram-kernel-cutover", "state.mode");
      mkdirSync(dirname(guard), { recursive: true, mode: 0o700 });
      const prepareArgs = [prepare, "--agent-dir", agent, "--confirm-all-writers-stopped"];
      const child = (args, input) => {
        const result = spawnSync(process.execPath, args, { input, timeout: 8000, encoding: "utf8" });
        assert.ifError(result.error); assert.equal(result.signal, null, result.stderr);
        return result;
      };
      const omitted = child(prepareArgs.slice(0, -1));
      assert.equal(omitted.status, 2, omitted.stderr);
      assert.equal(existsSync(dirname(mode)), false);
      function predecessor(phase) {
        const run = child(["--input-type=module"], `
          import assert from 'node:assert/strict';
          import { spawnSync } from 'node:child_process';
          import { existsSync } from 'node:fs';
          import * as old from ${JSON.stringify(pathToFileURL(join(snapshot, "dist/lib/locks.js")).href)};
          const statePath = ${JSON.stringify(statePath)}, phase = ${JSON.stringify(phase)};
          const lock = old.createTelegramLockRuntime({ statePath, key: 'default', instanceId: 'archived-fixture' });
          let polls = 0, result, refusal;
          const runtime = old.createTelegramLockedPollingRuntime({ lock, hasBotToken: () => true,
            async startPolling() { polls++; }, async stopPolling() {}, updateStatus() {},
            resetDamagedState(assertCurrent) { return old.resetDamagedTelegramRuntimeState(statePath, undefined, assertCurrent); } });
          try { result = await runtime.start({ cwd: ${JSON.stringify(agent)} }); }
          catch (error) { refusal = { code: error.code, message: error.message }; }
          if (phase === 'before') {
            assert.equal(result?.ok, true); assert.equal(polls, 1);
            const denied = spawnSync(process.execPath, ${JSON.stringify(prepareArgs)}, { encoding: 'utf8', timeout: 5000 });
            assert.ifError(denied.error); assert.equal(denied.status, 1, denied.stdout + denied.stderr);
            assert.match(denied.stderr, /live process is still recorded/u);
            assert.equal(existsSync(${JSON.stringify(dirname(mode))}), false);
            await runtime.stop();
          } else {
            assert.equal(result, undefined); assert.equal(polls, 0);
            assert.ok(refusal?.code === 'guard-unverifiable' || /Timed out acquiring Telegram lock transaction/u.test(refusal?.message));
          }
          console.log(JSON.stringify({ pid: process.pid, polls, refusal: refusal?.code ?? refusal?.message }));
        `);
        assert.equal(run.status, 0, run.stdout + run.stderr);
        const observed = JSON.parse(run.stdout);
        assert.throws(() => process.kill(observed.pid, 0), error => error.code === "ESRCH", "Require natural predecessor process exit");
        return observed;
      }
      const before = predecessor("before");
      // Older releases may remove an empty envelope on clean disconnect; seed one healthy sibling to check its exact survival.
      const healthy = '{"version":2,"profiles":{"work":{"runtime":{"marker":"keep healthy state"}}}}\n';
      writeFileSync(statePath, healthy, { mode: 0o600 });
      const owner = join(guard, "owner.fixture.json");
      if (damaged) {
        mkdirSync(guard, { mode: 0o700 });
        writeFileSync(owner, "", { mode: 0o600 });
      }
      const originalGuard = damaged ? lstatSync(guard, { bigint: true }) : undefined;
      const prepared = child(prepareArgs), marker = damaged ? join(guard, "kernel-cutover-v1") : guard;
      assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
      assert.match(prepared.stdout, /No connection was started/u);
      const installed = readFileSync(mode), barrier = readFileSync(marker);
      const after = predecessor("after");
      assert.equal(readFileSync(statePath, "utf8"), healthy);
      assert.deepEqual(readFileSync(mode), installed); assert.deepEqual(readFileSync(marker), barrier);
      if (originalGuard) {
        assert.equal(readFileSync(owner).length, 0); assert.equal(lstatSync(guard, { bigint: true }).ino, originalGuard.ino);
      }
      assert.equal(child(prepareArgs).status, 0, "The same admitted mode can be re-observed");
      renameSync(marker, join(agent, "displaced-barrier"));
      const lost = child(prepareArgs); assert.equal(lost.status, 1, lost.stdout + lost.stderr);
      assert.equal(existsSync(marker), false, "A missing installed barrier is not silently reinstalled");
      assert.deepEqual(readFileSync(mode), installed); assert.equal(readFileSync(statePath, "utf8"), healthy);
      results.push({ name: `cold-cutover-archived-polling-entry/${layout}`, before, after, outcome: "refused" });
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
