/**
 * Real Windows failed-close countermodel for the private owned-lease fixture.
 * Zones: native resource lifetime, disposable validation
 * Usage: node scripts/probe-owned-native-close-failure.mjs --addon <protected-close.node>
 * Retains the protected handle until actual subprocess exit; never unprotects or retries it.
 * No Pi import, configured storage lookup or production fault-injection surface.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, threadId, Worker, workerData } from "node:worker_threads";

assert.equal(process.platform, "win32", "Close-protection witness requires actual Windows execution");
const args = process.argv.slice(2), child = isMainThread && args[0] === "--child";
if (isMainThread) assert.ok(child ? args.length === 4 : args.length === 2 && args[0] === "--addon");
else assert.equal(workerData.kind, "owned-lease-close-failure");
const addonPath = realpathSync(resolve(isMainThread ? args[1] : workerData.addonPath));
const native = createRequire(import.meta.url)(addonPath), script = fileURLToPath(import.meta.url);
assert.equal(native.fixtureKind, "win32-owned-lease-prototype-v1");
assert.equal(typeof native.protectClose, "function", "Fault API exists only in the witness build");
function anchor(root) {
  assert.equal(dirname(root), realpathSync(tmpdir()));
  assert.ok(basename(root).startsWith("pt-owned-close-"), "Refuse configured runtime paths");
  return join(root, "coord.lock");
}
if (!isMainThread) {
  globalThis.protectedPrototypeLease = native.tryAcquire(anchor(realpathSync(workerData.root)));
  assert.ok(globalThis.protectedPrototypeLease);
  native.protectClose(globalThis.protectedPrototypeLease);
  let original;
  assert.throws(() => native.release(globalThis.protectedPrototypeLease), error => {
    original = error;
    return error.syscall === "CloseHandle" && Number.isInteger(error.win32Code) && error.win32Code > 0 && error.retirement === "unconfirmed";
  }, "Protected fixture handle must produce a real unconfirmed CloseHandle failure");
  for (let index = 0; index < 3; index++)
    assert.throws(() => native.release(globalThis.protectedPrototypeLease), {
      syscall: "CloseHandle", win32Code: original.win32Code, retirement: "unconfirmed",
    }, "Repeated release preserves unconfirmed native retirement");
  const total = setTimeout(() => process.exit(97), 15_000);
  parentPort.on("message", command => {
    assert.equal(command, "exit");
    assert.ok(globalThis.protectedPrototypeLease);
    clearTimeout(total); parentPort.close();
  });
  parentPort.postMessage({ pid: process.pid, threadId, syscall: original.syscall,
    win32Code: original.win32Code, retirement: original.retirement });
} else if (child) {
  const root = realpathSync(args[2]), mode = args[3], path = anchor(root);
  assert.ok(["natural-exit", "forced-termination"].includes(mode));
  const worker = new Worker(new URL(import.meta.url), { trackUnmanagedFds: false,
    workerData: { kind: "owned-lease-close-failure", addonPath, root } });
  let workerError, exited = false;
  worker.on("error", error => { workerError ??= error; });
  const closed = new Promise(resolveExit => worker.once("exit", code => { exited = true; resolveExit(code); }));
  try {
    const ready = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("Failed-close Worker startup timeout")); }, 5000);
      const onMessage = value => { cleanup(); resolveReady(value); };
      const onError = error => { cleanup(); reject(error); };
      const onExit = code => { cleanup(); reject(new Error(`Failed-close Worker exited before readiness: ${code}`)); };
      function cleanup() { clearTimeout(timer); worker.off("message", onMessage); worker.off("error", onError); worker.off("exit", onExit); }
      worker.once("message", onMessage); worker.once("error", onError); worker.once("exit", onExit);
    });
    assert.equal(ready.pid, process.pid); assert.ok(ready.threadId > 0);
    assert.equal(native.tryAcquire(path), undefined, "Failed close retains actual kernel exclusion");
    if (mode === "natural-exit") worker.postMessage("exit"); else await worker.terminate();
    assert.equal(await closed, mode === "natural-exit" ? 0 : 1);
    assert.ifError(workerError);
    assert.equal(native.tryAcquire(path), undefined,
      "Actual Worker exit cannot certify physical retirement after a failed close");
    console.log(JSON.stringify({ mode, ...ready, workerExit: "observed", kernelAfterWorkerExit: "still-held" }));
  } finally {
    if (!exited) await worker.terminate();
    await closed;
  }
} else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pt-owned-close-"))), path = anchor(root), checks = [];
  writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  try {
    for (const mode of ["natural-exit", "forced-termination"]) {
      const result = spawnSync(process.execPath, [script, "--child", addonPath, root, mode], {
        encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
      });
      assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
      const observation = JSON.parse(result.stdout);
      assert.notEqual(observation.pid, process.pid);
      assert.equal(observation.retirement, "unconfirmed");
      assert.equal(observation.kernelAfterWorkerExit, "still-held");
      const successor = native.tryAcquire(path);
      assert.ok(successor, "Actual process exit, not failed close or Worker exit, permits reacquisition");
      assert.equal(native.release(successor), true);
      checks.push({ ...observation, processExit: result.status, reacquiredAfterProcessExit: true });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    binarySha256: createHash("sha256").update(readFileSync(addonPath)).digest("hex"), checks }, null, 2));
}
