/**
 * Opt-in Linux-only resource-ownership probe for an independently compiled fixture addon.
 * Zones: native resource lifetime, disposable validation
 * Usage (repository checkout): node scripts/probe-owned-native-lease.mjs --addon /tmp/build/owned-lease.node
 * No Pi import, configured storage lookup, runtime dependency or backend activation.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, threadId, Worker, workerData } from "node:worker_threads";

const require = createRequire(import.meta.url), script = fileURLToPath(import.meta.url);
const args = process.argv.slice(2), child = isMainThread && args[0] === "--child";
assert.equal(process.platform, "linux", "This fixture has no Darwin/Windows qualification yet");
if (isMainThread) assert.ok(child ? args.length === 3 : args.length === 2 && args[0] === "--addon");
else assert.equal(workerData.kind, "owned-lease-worker");
const addonPath = realpathSync(resolve(isMainThread ? args[1] : workerData.addonPath));
const native = require(addonPath);
assert.equal(native.fixtureKind, "linux-owned-lease-prototype-v1");
for (const name of ["tryAcquire", "release"]) assert.equal(typeof native[name], "function");
function anchor(root) {
  assert.equal(dirname(root), realpathSync(tmpdir()));
  assert.ok(basename(root).startsWith("pt-owned-lease-"), "Refuse configured runtime paths");
  return join(root, "coord.lock");
}

if (!isMainThread) {
  const root = realpathSync(workerData.root);
  // A real global root, not an optimizer-dead local. Never release explicitly in these witnesses.
  globalThis.ownedPrototypeLease = native.tryAcquire(anchor(root));
  assert.ok(globalThis.ownedPrototypeLease);
  const total = setTimeout(() => process.exit(97), 15_000);
  parentPort.on("message", command => {
    assert.equal(command, "exit");
    assert.ok(globalThis.ownedPrototypeLease);
    clearTimeout(total); parentPort.close();
  });
  parentPort.postMessage({ pid: process.pid, threadId, held: true });
} else if (child) {
  const lease = native.tryAcquire(anchor(realpathSync(args[2])));
  if (lease !== undefined) assert.equal(native.release(lease), true);
  console.log(JSON.stringify({ pid: process.pid, acquired: lease !== undefined }));
} else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pt-owned-lease-")));
  const path = anchor(root), active = new Set(), workers = new Set(), checks = [];
  const report = { node: process.version, platform: process.platform, arch: process.arch,
    fixture: native.fixtureKind, binarySha256: createHash("sha256").update(readFileSync(addonPath)).digest("hex"), checks };
  const total = setTimeout(() => {
    console.error("Owned-lease probe exceeded its 60-second total bound; disposable storage retained:", root);
    process.exit(1);
  }, 60_000);
  writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  function acquire() { const lease = native.tryAcquire(path); if (lease) active.add(lease); return lease; }
  function release(lease) { const result = native.release(lease); if (result) active.delete(lease); return result; }
  function attempt() {
    const result = spawnSync(process.execPath, [script, "--child", addonPath, root],
      { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.notEqual(value.pid, process.pid); assert.equal(typeof value.acquired, "boolean");
    return value.acquired;
  }
  function launchWorker() {
    const worker = new Worker(new URL(import.meta.url), { trackUnmanagedFds: false,
      workerData: { kind: "owned-lease-worker", root, addonPath } });
    let exited = false, error;
    worker.on("error", value => { error ??= value; });
    const closed = new Promise(resolveExit => worker.once("exit", code => { exited = true; resolveExit(code); }));
    const ready = new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("Owned-lease Worker startup timeout")); }, 5000);
      const onMessage = value => { cleanup(); resolveReady(value); };
      const onError = value => { cleanup(); reject(value); };
      const onExit = code => { cleanup(); reject(new Error(`Owned-lease Worker exited before readiness: ${code}`)); };
      function cleanup() { clearTimeout(timer); worker.off("message", onMessage); worker.off("error", onError); worker.off("exit", onExit); }
      worker.once("message", onMessage); worker.once("error", onError); worker.once("exit", onExit);
    });
    void ready.catch(() => undefined);
    const fixture = { worker, closed, ready, get exited() { return exited; }, get error() { return error; } };
    workers.add(fixture); return fixture;
  }
  async function assess(name, operation) { await operation(); checks.push(name); }
  let failure;
  try {
    await assess("synchronous-opaque-acquisition-excludes-independent-descriptors-and-processes", () => {
      const lease = acquire(); assert.ok(lease);
      assert.deepEqual(Reflect.ownKeys(lease), [], "Never expose a raw descriptor or mutable authority fields");
      assert.equal(acquire(), undefined); assert.equal(attempt(), false);
      assert.equal(release(lease), true); assert.equal(attempt(), true);
    });
    await assess("forged-cloned-and-foreign-instance-leases-cannot-release-the-owner", () => {
      const lease = acquire(); assert.ok(lease);
      for (const fake of [{}, { fd: 0 }, 17, undefined, null])
        assert.throws(() => native.release(fake), { code: "ERR_INVALID_LEASE" });
      let copy;
      try { copy = structuredClone(lease); } catch (error) { assert.equal(error.name, "DataCloneError"); }
      if (copy !== undefined) assert.throws(() => native.release(copy), { code: "ERR_INVALID_LEASE" });
      const otherPath = join(root, "foreign.node"); copyFileSync(addonPath, otherPath);
      const foreign = require(otherPath);
      assert.throws(() => foreign.release(lease), { code: "ERR_INVALID_LEASE" });
      assert.equal(attempt(), false); assert.equal(release(lease), true);
    });
    await assess("spent-lease-cannot-close-or-unlock-a-successor", () => {
      const old = acquire(); assert.ok(old); assert.equal(release(old), true);
      const successor = acquire(); assert.ok(successor);
      assert.equal(release(old), false); assert.equal(attempt(), false);
      assert.equal(release(successor), true); assert.equal(attempt(), true);
    });
    await assess("anchor-validation-refuses-links-public-mode-and-relative-paths", () => {
      assert.throws(() => native.tryAcquire("relative.lock"), { code: "ERR_LEASE_PATH" });
      assert.throws(() => native.tryAcquire(path + "\0suffix"), { code: "ERR_LEASE_PATH" });
      const publicPath = join(root, "public.lock"); writeFileSync(publicPath, ""); chmodSync(publicPath, 0o644);
      assert.throws(() => native.tryAcquire(publicPath), { code: "ERR_LEASE_ANCHOR" });
      const alias = join(root, "alias.lock"); symlinkSync(path, alias);
      assert.throws(() => native.tryAcquire(alias), error => error.syscall === "open");
      const linked = join(root, "hard.lock"); linkSync(path, linked);
      try { assert.throws(() => native.tryAcquire(path), { code: "ERR_LEASE_ANCHOR" }); }
      finally { rmSync(linked); }
      assert.equal(attempt(), true);
    });
    for (const mode of ["natural-exit", "forced-termination"]) {
      await assess(`${mode}-retires-environment-owned-lease-with-unmanaged-tracking-disabled`, async () => {
        const holder = launchWorker(), ready = await holder.ready;
        assert.equal(ready.pid, process.pid); assert.ok(ready.threadId > 0); assert.equal(ready.held, true);
        assert.equal(attempt(), false, "Original Worker remains the real kernel owner before termination");
        if (mode === "natural-exit") holder.worker.postMessage("exit"); else await holder.worker.terminate();
        assert.equal(await holder.closed, mode === "natural-exit" ? 0 : 1);
        assert.ifError(holder.error);
        assert.equal(attempt(), true, "Actual Worker exit, not a stop request or JS finally, precedes reacquisition");
        const successor = acquire(); assert.ok(successor); assert.equal(attempt(), false);
        assert.equal(release(successor), true);
      });
    }
    // Many retained spent wrappers survive to environment cleanup; none may close a later FD.
    await assess("retained-spent-wrappers-remain-harmless", () => {
      const retained = [];
      for (let index = 0; index < 128; index++) { const lease = acquire(); assert.ok(lease); retained.push(lease); assert.equal(release(lease), true); }
      const current = acquire(); assert.ok(current);
      for (const spent of retained) assert.equal(release(spent), false);
      assert.equal(attempt(), false); assert.equal(release(current), true);
    });
  } catch (error) { failure = error; }
  finally {
    const cleanupErrors = [];
    for (const fixture of workers) {
      try { if (!fixture.exited) await fixture.worker.terminate(); await fixture.closed; }
      catch (error) { cleanupErrors.push(error); }
    }
    for (const lease of active) { try { native.release(lease); } catch (error) { cleanupErrors.push(error); } }
    clearTimeout(total);
    try { rmSync(root, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    if (!failure && cleanupErrors.length) failure = new AggregateError(cleanupErrors, "Owned-lease fixture cleanup failed");
  }
  if (failure) throw failure;
  console.log(JSON.stringify(report, null, 2));
}
