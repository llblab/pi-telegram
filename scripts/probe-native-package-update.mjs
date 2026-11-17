/**
 * Observe real package publication while its native image stays mapped in an independent Node process.
 * Zones: native build artifacts, disposable process lifetime, publication diagnostics
 * Usage: node scripts/probe-native-package-update.mjs --out <new-evidence-directory>
 * Uses a byte-copy compiler stand-in, not a TypeScript/compiler qualification or runtime maintenance service.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url), repository = resolve(dirname(script), "..");
const args = process.argv.slice(2), child = ["--holder", "--contender"].includes(args[0]);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function admitRoot(path) {
  const root = realpathSync(path);
  assert.equal(dirname(root), realpathSync(tmpdir()));
  assert.ok(basename(root).startsWith("pt-native-update-"), "Refuse configured runtime paths");
  return root;
}
if (child) {
  assert.equal(args.length, 2);
  const root = admitRoot(args[1]);
  const Kernel = await import(pathToFileURL(join(root, "dist/lib/locks.js")).href);
  const backend = Kernel.loadTelegramFileTransactionKernelBackend(), anchor = join(root, "coord.lock");
  let lease = backend.tryAcquire(anchor);
  if (args[0] === "--contender") {
    if (lease) assert.equal(backend.release(lease), true);
    console.log(JSON.stringify({ pid: process.pid, acquired: lease !== undefined }));
  } else {
    assert.ok(process.send); assert.ok(lease, "Holder must acquire the actual opaque lease");
    const total = setTimeout(() => { throw new Error("Mapped-image holder exceeded its disposable bound"); }, 80000);
    const mapped = () => {
      const catalog = JSON.parse(readFileSync(join(root, "dist/native/catalog.json"))), hash = catalog.targets[`${process.platform}-x64`].binarySha256;
      const images = process.report.getReport().sharedObjects.filter(path => path.includes(hash + ".node"));
      assert.equal(images.length, 1, "Original native image must remain observably mapped");
      return { imageSha256: hash, mappedImages: images };
    };
    process.on("message", message => {
      if (message === "release") {
        assert.equal(backend.release(lease), true); lease = undefined;
        process.send({ phase: "released", pid: process.pid, ...mapped() });
      } else if (message === "exit") {
        assert.equal(lease, undefined); clearTimeout(total); process.disconnect();
      } else throw new Error("Unknown holder control");
    });
    process.send({ phase: "held", pid: process.pid, backendKind: backend.backendKind, napi: backend.napi, ...mapped() });
  }
} else {
  assert.equal(args.length, 2); assert.equal(args[0], "--out");
  const output = resolve(args[1]); mkdirSync(output, { mode: 0o700 });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pt-native-update-"))), children = new Set();
  const report = { version: 1, node: process.version, platform: process.platform, arch: process.arch, root,
    compiler: "byte-copy-stand-in", inputs: {}, builds: [], observations: [], cleanup: {} };
  let timedOut = false, failure, holder, holderClosed, holderMessages = [], holderError, holderStdout = "", holderStderr = "";
  const total = setTimeout(() => { timedOut = true; for (const process of children) process.kill("SIGKILL"); }, 90000);
  function launch(argv, options = {}) {
    assert.equal(timedOut, false, "Mapped-update total bound expired");
    const processChild = spawn(process.execPath, argv, { cwd: root, ...options });
    children.add(processChild);
    processChild.once("close", () => children.delete(processChild));
    return processChild;
  }
  async function run(name, argv, extraEnv = {}) {
    const processChild = launch(argv, { env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", error;
    const capture = (which, chunk) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 128 * 1024) {
        error ??= new Error("Mapped-update child output exceeds its bound"); processChild.kill("SIGKILL"); return;
      }
      if (which === "stdout") stdout += chunk; else stderr += chunk;
    };
    processChild.stdout.setEncoding("utf8"); processChild.stderr.setEncoding("utf8");
    processChild.stdout.on("data", chunk => capture("stdout", chunk)); processChild.stderr.on("data", chunk => capture("stderr", chunk));
    processChild.on("error", cause => { error ??= cause; });
    let expired = false;
    const timer = setTimeout(() => { expired = true; processChild.kill("SIGKILL"); }, 10000);
    const result = await new Promise(resolveExit => processChild.once("close", (code, signal) => resolveExit({ code, signal })));
    clearTimeout(timer);
    writeFileSync(join(output, `${name}.stdout`), stdout, { flag: "wx" });
    writeFileSync(join(output, `${name}.stderr`), stderr, { flag: "wx" });
    const evidence = { name, ...result, expired, error: error?.message ?? null };
    writeFileSync(join(output, `${name}.json`), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
    assert.equal(expired, false, `${name} exceeded its original child bound`); assert.ifError(error);
    return { ...evidence, stdout, stderr };
  }
  function assertHealthy(result) { assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null); }
  async function build(name, generation, check = false) {
    const result = await run(name, [join(root, "scripts/build-dist.mjs"), ...(check ? ["--check"] : [])], { NATIVE_UPDATE_GENERATION: generation });
    const active = join(root, "dist/index.js");
    const observation = { name, code: result.code, signal: result.signal, check,
      activeGeneration: existsSync(active) ? /native-update-generation:(\w+)/u.exec(readFileSync(active, "utf8"))?.[1] ?? "unknown" : "absent",
      retainedBackups: readdirSync(root).filter(name => name.startsWith(".dist-backup-")) };
    report.builds.push(observation);
    if (result.code === 0) assert.equal(observation.activeGeneration, generation, "Native build success must publish/verify the exact generation");
    return result;
  }
  async function contender(name, expected) {
    const result = await run(name, [script, "--contender", root]); assertHealthy(result);
    const value = JSON.parse(result.stdout); assert.notEqual(value.pid, process.pid); assert.equal(value.acquired, expected);
    report.observations.push({ name, ...value });
  }
  async function message(phase) {
    const deadline = performance.now() + 8000;
    while (!holderMessages.some(message => message.phase === phase)) {
      assert.ifError(holderError); assert.equal(holderClosed, undefined, "Holder exited before its original checkpoint");
      assert.ok(performance.now() < deadline, `Holder ${phase} checkpoint exceeded startup/control bound`);
      await new Promise(resolveWait => setTimeout(resolveWait, 10));
    }
    const value = holderMessages.find(message => message.phase === phase);
    assert.equal(value.pid, holder.pid); report.observations.push(value);
  }
  try {
    const inputs = ["scripts/probe-native-package-update.mjs", "scripts/build-dist.mjs", "scripts/package-native-lock.mjs", "native/catalog.json", "dist/lib/locks.js"];
    for (const path of inputs) report.inputs[path] = digest(readFileSync(join(repository, path)));
    for (const path of ["scripts", "lib", "compiler-input", "node_modules/typescript/bin"]) mkdirSync(join(root, path), { recursive: true });
    for (const path of ["scripts/build-dist.mjs", "scripts/package-native-lock.mjs", "package.json", "lib/generative-app-worker.mjs"])
      cpSync(join(repository, path), join(root, path));
    for (const path of ["native", "skills"]) cpSync(join(repository, path), join(root, path), { recursive: true, filter: () => true });
    cpSync(join(repository, "dist/lib"), join(root, "compiler-input/lib"), { recursive: true, filter: () => true });
    cpSync(join(repository, "dist/index.js"), join(root, "compiler-input/index.js"));
    writeFileSync(join(root, "node_modules/typescript/package.json"), '{"type":"commonjs"}\n');
    writeFileSync(join(root, "node_modules/typescript/bin/tsc"), `
      const { cpSync, writeFileSync, readFileSync } = require("node:fs"), { join } = require("node:path");
      const out = process.argv[process.argv.indexOf("--outDir") + 1];
      cpSync("compiler-input/lib", join(out, "lib"), { recursive: true, filter: () => true });
      writeFileSync(join(out, "index.js"), readFileSync("compiler-input/index.js", "utf8") + "\\n//native-update-generation:" + process.env.NATIVE_UPDATE_GENERATION + "\\n");
    `);
    const catalog = JSON.parse(readFileSync(join(root, "native/catalog.json"))), entry = catalog.targets[`${process.platform}-x64`];
    assert.ok(entry, "Only admitted x64 candidate platforms can run the witness");
    report.imageSha256 = entry.binarySha256;
    const imageRelative = join("native/prebuilds", `${process.platform}-x64`, `${entry.binarySha256}.node`);
    assert.equal(digest(readFileSync(join(root, imageRelative))), entry.binarySha256);
    assertHealthy(await build("initial-build", "original"));
    writeFileSync(join(root, "coord.lock"), "", { mode: 0o600 });
    holder = launch([script, "--holder", root], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    holder.stdout.setEncoding("utf8"); holder.stderr.setEncoding("utf8");
    const captureHolder = (which, chunk) => {
      if (Buffer.byteLength(holderStdout) + Buffer.byteLength(holderStderr) + Buffer.byteLength(chunk) > 128 * 1024) {
        holderError ??= new Error("Holder output exceeds its bound"); holder.kill("SIGKILL"); return;
      }
      if (which === "stdout") holderStdout += chunk; else holderStderr += chunk;
    };
    holder.stdout.on("data", chunk => captureHolder("stdout", chunk)); holder.stderr.on("data", chunk => captureHolder("stderr", chunk));
    holder.on("message", value => { holderMessages.push(value); }); holder.on("error", error => { holderError = error; });
    const completion = new Promise(resolveExit => holder.once("close", (code, signal) => { holderClosed = { code, signal }; resolveExit(holderClosed); }));
    await message("held");
    await contender("original-contender", false);
    assertHealthy(await build("mapped-check", "original", true));
    const mapped = await build("mapped-rebuild", "successor");
    try { assertHealthy(mapped); } catch (error) { failure ??= error; }
    await contender("after-mapped-rebuild-contender", false);
    holder.send("release"); await message("released");
    await contender("after-release-contender", true);
    const released = await build("released-but-mapped-rebuild", "released");
    try { assertHealthy(released); } catch (error) { failure ??= error; }
    holder.send("exit");
    const exitTimer = setTimeout(() => holder.kill("SIGKILL"), 5000);
    await completion; clearTimeout(exitTimer);
    report.holderExit = holderClosed; assert.deepEqual(holderClosed, { code: 0, signal: null });
    await contender("after-actual-exit-contender", true);
    assertHealthy(await build("after-actual-exit-rebuild", "exited"));
    assertHealthy(await build("after-actual-exit-check", "exited", true));
    assert.equal(digest(readFileSync(join(root, "dist", imageRelative))), entry.binarySha256);
    // Preserve an original mapped-build failure even when actual process exit permits a later build.
    assertHealthy(mapped); assertHealthy(released);
    assert.ok(report.builds.every(build => build.retainedBackups.length === 0), "Successful publication must not hide incomplete mapped-image cleanup");
    report.checks = ["original-image-mapped", "mapped-check-is-read-only", "lease-survives-publication", "release-is-not-unmap", "actual-process-exit", "post-exit-build-and-check"];
  } catch (error) { failure ??= error; }
  finally {
    if (holder && holderClosed === undefined) {
      try {
        if (!holderMessages.some(message => message.phase === "released")) { holder.send("release"); await message("released"); }
        holder.send("exit");
        await new Promise(resolveExit => { if (holderClosed !== undefined) resolveExit(); else { const timer = setTimeout(() => holder.kill("SIGKILL"), 5000); holder.once("close", () => { clearTimeout(timer); resolveExit(); }); } });
      } catch (error) { holder.kill("SIGKILL"); await new Promise(resolveExit => holderClosed !== undefined ? resolveExit() : holder.once("close", resolveExit)); report.cleanup.holderError = error.message; }
    }
    for (const processChild of children) processChild.kill("SIGKILL");
    clearTimeout(total);
    if (failure) report.failure = { name: failure.name, message: failure.message };
    report.cleanup.holderExit = holderClosed ?? null; report.cleanup.timedOut = timedOut;
    writeFileSync(join(output, "holder.stdout"), holderStdout, { flag: "wx" }); writeFileSync(join(output, "holder.stderr"), holderStderr, { flag: "wx" });
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    // Only this disposable owner, after actual holder exit, may remove its mapped-image fixture.
    rmSync(root, { recursive: true, force: true });
  }
  if (failure) throw failure;
  console.log(JSON.stringify(report, null, 2));
}
