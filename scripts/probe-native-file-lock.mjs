/**
 * Opt-in Node-addon lock qualification in fresh disposable storage, never configured Pi state.
 * Zones: filesystem compatibility, validation fixtures
 * Usage: node scripts/probe-native-file-lock.mjs --addon /isolated/node_modules/fs-native-extensions
 * Requires an independently installed candidate; does not install or activate a runtime dependency.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, toNamespacedPath } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const script = fileURLToPath(import.meta.url), require = createRequire(import.meta.url);
const args = process.argv.slice(2), childMode = args[0] === "--child";
assert.ok(childMode ? args.length === 4 : args.length === 2 && args[0] === "--addon",
  "Usage: probe-native-file-lock.mjs --addon <isolated fs-native-extensions directory>");
const addonPath = realpathSync(resolve(args[1]));
const manifest = JSON.parse(readFileSync(join(addonPath, "package.json"), "utf8"));
assert.equal(manifest.name, "fs-native-extensions");
assert.equal(manifest.version, "1.5.3", "Qualify one exact candidate, not a floating installed version");
const native = require(join(addonPath, "index.js"));
for (const name of ["tryLock", "unlock", "waitForLock"]) assert.equal(typeof native[name], "function", name);

function lockPath(root) {
  assert.equal(dirname(root), realpathSync(tmpdir()), "Disposable storage must be directly under the system temporary directory");
  assert.ok(basename(root).startsWith("pt-native-lock-"), "Refuse configured runtime paths");
  return join(root, "coord.lock");
}

function nativeWaitCase(root) {
  const fd = openSync(lockPath(root), "r+");
  let abandoned = false;
  const total = setTimeout(() => process.exit(97), 15_000);
  const pending = native.waitForLock(fd);
  void pending.then(() => {
    assert.equal(abandoned, true, "The original native wait must return only after logical abandonment in this witness");
    native.unlock(fd); closeSync(fd); clearTimeout(total);
    console.log("native-wait-returned-after-abandon");
  }).catch(error => { console.error(error); process.exit(1); });
  process.once("message", async command => {
    try {
      assert.equal(command, "abandon"); abandoned = true;
      const outcome = await Promise.race([pending.then(() => "acquired"), Promise.resolve("abandoned")]);
      assert.equal(outcome, "abandoned");
      clearTimeout(total);
      process.send({ phase: "abandoned", pid: process.pid }, () => process.disconnect());
    } catch (error) { console.error(error); process.exit(1); }
  });
  process.send({ phase: "prepared", pid: process.pid, waitIssued: true });
}

async function workerCase(root, mode) {
  const owner = mode === "worker-exclude" ? openSync(lockPath(root), "r+") : undefined;
  let worker, exited = false, closed, workerError;
  const total = setTimeout(() => process.exit(97), 8000);
  try {
    if (owner !== undefined) assert.equal(native.tryLock(owner), true);
    worker = new Worker(`
      const { parentPort, workerData, threadId } = require("node:worker_threads");
      const { openSync, closeSync } = require("node:fs");
      const native = require(workerData.addon);
      const fd = openSync(workerData.path, "r+"), locked = native.tryLock(fd);
      if (workerData.mode === "worker-exclude") closeSync(fd);
      else parentPort.on("message", message => { if (message === "exit") parentPort.close(); });
      parentPort.postMessage({ pid: process.pid, threadId, fd, locked });
      if (workerData.mode === "worker-exclude") parentPort.close();
    `, { eval: true, trackUnmanagedFds: mode !== "worker-untracked",
      workerData: { addon: join(addonPath, "index.js"), path: lockPath(root), mode } });
    worker.on("error", error => { workerError ??= error; });
    closed = new Promise(resolveExit => worker.once("exit", code => { exited = true; resolveExit(code); }));
    const ready = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("Native worker startup timeout")); }, 3000);
      const onMessage = value => { cleanup(); resolveReady(value); };
      const onError = error => { cleanup(); reject(error); };
      const onExit = code => { cleanup(); reject(new Error(`Worker exited before native report: ${code}`)); };
      function cleanup() { clearTimeout(timer); worker.off("message", onMessage); worker.off("error", onError); worker.off("exit", onExit); }
      worker.once("message", onMessage); worker.once("error", onError); worker.once("exit", onExit);
    });
    assert.equal(ready.pid, process.pid, "The original worker must share this actual OS process");
    assert.ok(Number.isSafeInteger(ready.threadId) && ready.threadId > 0);
    assert.equal(ready.locked, owner === undefined);
    if (mode === "worker-exclude") assert.equal(await closed, 0);
    const competing = openSync(lockPath(root), "r+");
    try { assert.equal(native.tryLock(competing), false, "Neither another thread nor its descriptor close can borrow/release the original lock"); }
    finally { closeSync(competing); }
    if (owner === undefined) {
      const terminated = mode === "worker-terminate" || mode === "worker-untracked";
      if (terminated) await worker.terminate(); else worker.postMessage("exit");
      assert.equal(await closed, terminated ? 1 : 0);
      const fresh = openSync(lockPath(root), "r+");
      try {
        if (mode === "worker-untracked") {
          assert.equal(native.tryLock(fresh), false, "Worker exit alone cannot retire a deliberately untracked process-owned descriptor");
          assert.equal(fstatSync(ready.fd).ino, statSync(lockPath(root)).ino);
          closeSync(ready.fd); // Exact leaked fixture descriptor, never a runtime recovery technique.
        }
        assert.equal(native.tryLock(fresh), true, "Actual descriptor closure precedes reacquisition");
      } finally { closeSync(fresh); }
    }
    assert.ifError(workerError);
    return { pid: process.pid, threadId: ready.threadId, mode };
  } finally {
    if (worker && !exited) await worker.terminate();
    if (closed) await closed;
    if (owner !== undefined) closeSync(owner);
    clearTimeout(total);
  }
}

if (childMode) {
  const root = realpathSync(args[2]), mode = args[3];
  assert.ok(["attempt", "hold", "race", "idle", "inherit", "closed-descriptor", "read-only", "async-wait", "worker-exclude", "worker-exit", "worker-terminate", "worker-untracked"].includes(mode));
  if (mode === "async-wait") nativeWaitCase(root);
  else if (mode === "closed-descriptor") {
    const fd = openSync(lockPath(root), "r+"); closeSync(fd);
    for (const name of ["tryLock", "unlock"]) assert.throws(() => native[name](fd), error => error.code === "EBADF", name);
    console.log(JSON.stringify({ pid: process.pid, mode }));
  } else if (mode === "read-only") {
    const fd = openSync(lockPath(root), "r");
    let outcome;
    try {
      if (native.tryLock(fd)) { outcome = { kind: "acquired" }; native.unlock(fd); }
      else outcome = { kind: "not-acquired" };
    } catch (error) { outcome = { kind: "rejected", code: error.code }; }
    finally { closeSync(fd); }
    console.log(JSON.stringify({ pid: process.pid, mode, outcome }));
  } else if (mode.startsWith("worker-")) console.log(JSON.stringify(await workerCase(root, mode)));
  else if (mode === "attempt") {
    const fd = openSync(lockPath(root), "r+"), locked = native.tryLock(fd);
    closeSync(fd);
    console.log(JSON.stringify({ pid: process.pid, locked }));
  } else {
    const fd = ["idle", "inherit"].includes(mode) ? undefined : openSync(lockPath(root), "r+");
    // Independent of parent observations or commands; never renew this fixture's total bound.
    const total = setTimeout(() => process.exit(97), 15_000);
    const locked = mode === "hold" ? native.tryLock(fd) : undefined;
    if (mode === "hold") assert.equal(locked, true);
    process.on("message", message => {
      if (message === "try") { assert.notEqual(fd, undefined); process.send({ phase: "attempted", pid: process.pid, locked: native.tryLock(fd) }); }
      else if (message === "ping") process.send({ phase: "alive", pid: process.pid });
      else if (message === "exit") process.exit(0); // Deliberately no unlock/close: test kernel release.
      else throw new Error("Unexpected fixture command");
    });
    process.on("disconnect", () => { clearTimeout(total); process.exit(98); });
    process.send({ phase: "prepared", pid: process.pid, ...(locked === undefined ? {} : { locked }),
      ...(mode === "inherit" ? { inheritedIno: fstatSync(4).ino } : {}) });
  }
} else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pt-native-lock-")));
  const path = lockPath(root), children = new Set(), checks = [], countermodels = [], observations = [];
  const binary = join(addonPath, "prebuilds", `${process.platform}-${process.arch}`, "fs-native-extensions.node");
  const report = { node: process.version, platform: process.platform, arch: process.arch,
    addon: `${manifest.name}@${manifest.version}`,
    packagedPrebuildSha256: createHash("sha256").update(readFileSync(binary)).digest("hex"), checks, countermodels, observations };
  const total = setTimeout(() => {
    for (const fixture of children) fixture.child.kill("SIGKILL");
    console.error("Native lock probe exceeded its 60-second total bound; disposable storage retained:", root);
    process.exit(1);
  }, 60_000);
  writeFileSync(path, "", { mode: 0o600 });

  function run(mode, timeout = 5000) {
    const result = spawnSync(process.execPath, [script, "--child", addonPath, root, mode],
      { encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.notEqual(value.pid, process.pid);
    return value;
  }

  function attempt() {
    const value = run("attempt");
    assert.equal(typeof value.locked, "boolean");
    return value.locked;
  }

  function launch(mode, inheritedFd) {
    const child = spawn(process.execPath, [script, "--child", addonPath, root, mode],
      { stdio: ["ignore", "pipe", "pipe", "ipc", ...(inheritedFd === undefined ? [] : [inheritedFd])] });
    let stdout = "", stderr = "", exit, spawnError;
    child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
    child.stdout.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-4096); });
    child.on("error", error => { spawnError = error; });
    const closed = new Promise(resolveClose => child.once("close", (code, signal) => { exit = { code, signal }; resolveClose(exit); }));
    function message(phase) {
      return new Promise((resolveMessage, reject) => {
        const timeout = setTimeout(() => {
          cleanup(); child.kill("SIGKILL"); reject(new Error(`Native ${mode} ${phase} timeout: ${stderr}`));
        }, 5000);
        const onMessage = value => {
          if (value?.phase !== phase || value.pid !== child.pid) return;
          cleanup(); resolveMessage(value);
        };
        const onClose = () => { cleanup(); reject(spawnError ?? new Error(`Native ${mode} closed before ${phase}: ${stderr}`)); };
        function cleanup() { clearTimeout(timeout); child.off("message", onMessage); child.off("close", onClose); }
        if (exit) { onClose(); return; }
        child.on("message", onMessage); child.once("close", onClose);
      });
    }
    const fixture = { child, closed, message, ready: message("prepared"), get exit() { return exit; }, get stdout() { return stdout; } };
    void fixture.ready.catch(() => undefined);
    children.add(fixture);
    return fixture;
  }

  async function assess(name, run) { await run(); checks.push(name); }
  try {
    await assess("loaded-node-binary-matches-packaged-image", () => {
      assert.equal(typeof process.report.excludeEnv, "boolean");
      const previous = process.report.excludeEnv;
      try {
        process.report.excludeEnv = true;
        const diagnostic = process.report.getReport();
        assert.equal(Object.hasOwn(diagnostic, "environmentVariables"), false, "Never collect inherited secrets for binary qualification");
        // Windows reports extended-length image paths; compare both real paths in the same public namespace.
        const mapped = [...new Set(diagnostic.sharedObjects.filter(file => basename(file) === "fs-native-extensions.node").map(file => toNamespacedPath(realpathSync(file))))];
        assert.deepEqual(mapped, [toNamespacedPath(realpathSync(binary))]);
        report.mappedPrebuild = `prebuilds/${process.platform}-${process.arch}/fs-native-extensions.node`;
        report.mappedPrebuildSha256 = createHash("sha256").update(readFileSync(mapped[0])).digest("hex");
        assert.equal(report.mappedPrebuildSha256, report.packagedPrebuildSha256);
      } finally { process.report.excludeEnv = previous; }
    });
    await assess("closed-descriptors-refuse-lock-and-unlock", () => {
      assert.equal(run("closed-descriptor").mode, "closed-descriptor");
    });
    observations.push({ name: "read-only-descriptor", outcome: run("read-only").outcome });
    await assess("independent-descriptors-exclude-within-one-process", () => {
      const first = openSync(path, "r+"), second = openSync(path, "r+");
      try { assert.equal(native.tryLock(first), true); assert.equal(native.tryLock(second), false); }
      finally { closeSync(second); closeSync(first); }
    });
    await assess("live-owner-excludes-real-process-despite-empty-metadata", () => {
      const fd = openSync(path, "r+");
      try {
        assert.equal(native.tryLock(fd), true);
        writeFileSync(join(root, "owner.json"), "", { mode: 0o600 });
        assert.equal(statSync(path).size, 0);
        assert.equal(attempt(), false);
      } finally { closeSync(fd); }
      assert.equal(attempt(), true, "Empty diagnostic metadata cannot retain a released kernel lock");
    });
    await assess("closing-an-unrelated-descriptor-does-not-release-owner", () => {
      const fd = openSync(path, "r+");
      try {
        assert.equal(native.tryLock(fd), true);
        closeSync(openSync(path, "r+"));
        assert.equal(attempt(), false);
      } finally { closeSync(fd); }
    });
    await assess("explicit-unlock-releases-with-owner-descriptor-still-open", () => {
      const fd = openSync(path, "r+");
      try { assert.equal(native.tryLock(fd), true); native.unlock(fd); assert.equal(attempt(), true); }
      finally { closeSync(fd); }
    });
    await assess("shared-readers-coexist-and-exclude-writer", () => {
      const first = openSync(path, "r+");
      let second = openSync(path, "r+");
      try {
        assert.equal(native.tryLock(first, { shared: true }), true);
        assert.equal(native.tryLock(second, { shared: true }), true);
        assert.equal(attempt(), false);
        closeSync(second); second = undefined;
        assert.equal(attempt(), false);
      } finally { if (second !== undefined) closeSync(second); closeSync(first); }
      assert.equal(attempt(), true);
    });
    for (const mode of ["natural-exit", "forceful-exit"]) {
      await assess(`${mode}-releases-after-actual-native-close`, async () => {
        const holder = launch("hold");
        assert.equal((await holder.ready).locked, true);
        assert.equal(attempt(), false);
        if (mode === "natural-exit") holder.child.send("exit"); else assert.equal(holder.child.kill("SIGKILL"), true);
        const exit = await holder.closed;
        if (mode === "natural-exit") assert.deepEqual(exit, { code: 0, signal: null });
        else assert.ok(exit.signal !== null || exit.code !== 0);
        assert.equal(attempt(), true, "Observed close, not a kill request or absent heartbeat, precedes reacquisition");
      });
    }
    await assess("two-prepared-native-contenders-have-exactly-one-held-winner", async () => {
      const first = launch("race"), second = launch("race");
      await Promise.all([first.ready, second.ready]);
      const attempts = [first.message("attempted"), second.message("attempted")];
      first.child.send("try"); second.child.send("try");
      const results = await Promise.all(attempts);
      assert.equal(results.filter(value => value.locked).length, 1);
      assert.equal(attempt(), false, "The original winner remains held after reporting");
      first.child.send("exit"); second.child.send("exit");
      for (const exit of await Promise.all([first.closed, second.closed])) assert.deepEqual(exit, { code: 0, signal: null });
      assert.equal(attempt(), true);
    });
    await assess("default-spawn-does-not-inherit-a-held-lock-descriptor", async () => {
      let owner = openSync(path, "r+");
      try {
        assert.equal(native.tryLock(owner), true);
        const descendant = launch("idle");
        await descendant.ready;
        closeSync(owner); owner = undefined;
        const alive = descendant.message("alive"); descendant.child.send("ping"); await alive;
        assert.equal(descendant.exit, undefined, "The original descendant remains alive during reacquisition");
        assert.equal(attempt(), true, "An unrelated descendant must not retain the parent's open-file-description lock");
        descendant.child.send("exit"); assert.deepEqual(await descendant.closed, { code: 0, signal: null });
      } finally { if (owner !== undefined) closeSync(owner); }
    });
    for (const mode of ["worker-exclude", "worker-exit", "worker-terminate"]) {
      await assess(`${mode}-preserves-native-descriptor-ownership`, () => {
        const result = run(mode, 10_000);
        assert.equal(result.mode, mode); assert.ok(result.threadId > 0);
      });
    }
    let waitingOwner = openSync(path, "r+");
    try {
      assert.equal(native.tryLock(waitingOwner), true);
      const waiter = launch("async-wait");
      const abandoned = waiter.message("abandoned"); void abandoned.catch(() => undefined);
      const disconnected = new Promise(resolveDisconnect => waiter.child.once("disconnect", resolveDisconnect));
      assert.equal((await waiter.ready).waitIssued, true);
      waiter.child.send("abandon"); await abandoned; await disconnected;
      // A controlled observation horizon, not a cancellation or completion certificate.
      await new Promise(resolveHorizon => setTimeout(resolveHorizon, 100));
      assert.equal(waiter.exit, undefined, "Abandonment and IPC disconnect do not retire the pending native wait");
      process.kill(waiter.child.pid, 0);
      closeSync(waitingOwner); waitingOwner = undefined;
      assert.deepEqual(await waiter.closed, { code: 0, signal: null });
      assert.match(waiter.stdout, /native-wait-returned-after-abandon/u);
      countermodels.push("abandoned-promise-keeps-native-wait-and-process-alive-until-owner-release");
    } finally { if (waitingOwner !== undefined) closeSync(waitingOwner); }
    const untracked = run("worker-untracked", 10_000);
    assert.equal(untracked.mode, "worker-untracked");
    countermodels.push("worker-exit-does-not-close-deliberately-untracked-descriptor");
    if (process.platform !== "win32") {
      let owner = openSync(path, "r+");
      try {
        assert.equal(native.tryLock(owner), true);
        const inode = fstatSync(owner).ino, descendant = launch("inherit", owner);
        assert.equal((await descendant.ready).inheritedIno, inode);
        closeSync(owner); owner = undefined;
        const alive = descendant.message("alive"); descendant.child.send("ping"); await alive;
        assert.equal(attempt(), false, "An explicitly inherited descriptor intentionally retains the original lock");
        descendant.child.send("exit"); assert.deepEqual(await descendant.closed, { code: 0, signal: null });
        assert.equal(attempt(), true);
        countermodels.push("explicitly-inherited-descriptor-retains-lock-after-parent-close");
      } finally { if (owner !== undefined) closeSync(owner); }
      const fd = openSync(path, "r+");
      try {
        assert.equal(native.tryLock(fd), true);
        const original = fstatSync(fd);
        renameSync(path, join(root, "retired.lock"));
        writeFileSync(path, "", { mode: 0o600 });
        assert.notEqual(statSync(path).ino, original.ino);
        assert.equal(attempt(), true, "Replacing the pathname splits the lock domain even while the old descriptor is locked");
        countermodels.push("replacing-coordination-inode-permits-a-second-lock-domain");
      } finally { closeSync(fd); }
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    for (const fixture of children) if (!fixture.exit) fixture.child.kill("SIGKILL");
    await Promise.all([...children].map(fixture => fixture.closed));
    clearTimeout(total);
    rmSync(root, { recursive: true, force: true });
  }
}
