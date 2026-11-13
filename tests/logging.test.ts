/**
 * Regression tests for Telegram runtime JSONL diagnostics log
 * Covers session-local reset, scope changes, append-only event evidence, and collapsed failure runs
 * Zones: telegram diagnostics, test infrastructure
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runNodeEval } from "./fixtures/node-eval.ts";
import { resolveTelegramRuntimeLogPath, resolveTelegramPreviousSharedRuntimeLogPath, resolveTelegramRuntimeDir, resolveTelegramRuntimeLogsDir } from "../lib/paths.ts";
import {
  createTelegramFailureRunLog,
  createTelegramRuntimeJsonlLog,
  createTelegramRuntimeDiagnosticsRuntime,
  getTelegramFailureSignature,
  getTelegramPreviousRuntimeLogPath,
  getTelegramRuntimeLogPath,
} from "../lib/logging.ts";

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function createScopedDiagnosticsFixture() {
  const callbacks: Array<() => void> = [], cleared: unknown[] = [];
  const scope: { ctx: { id: string } | undefined; generation: number } = { ctx: { id: "old" }, generation: 1 };
  const counts = { projections: 0, publications: 0, statusUpdates: 0 };
  const diagnostics = createTelegramRuntimeDiagnosticsRuntime<{ id: string }>({
    snapshotTimer: {
      setTimer(callback) { callbacks.push(callback); return { unref() {} }; },
      clearTimer(handle) { cleared.push(handle); },
    },
  });
  diagnostics.bindStatus({
    instanceId: "fixture",
    session: {
      get: () => scope.ctx, getGeneration: () => scope.generation,
      isCurrent: (ctx, generation = scope.generation) => ctx === scope.ctx && generation === scope.generation,
    },
    updateStatus() { counts.statusUpdates += 1; },
    getStatusState() {
      counts.projections += 1;
      return { pollingActive: false, pendingDispatch: false, compactionInProgress: false,
        activeToolExecutions: 0, pendingModelSwitch: false, queuedItems: [], recentRuntimeEvents: [] };
    },
    async persistSnapshot() { counts.publications += 1; },
  });
  return { callbacks, cleared, scope, counts, diagnostics };
}

for (const succession of ["replace", "same-context-generation", "clear"] as const) {
  test(`Diagnostics captures exact session before reading a deferred projection (${succession})`, async () => {
    const f = createScopedDiagnosticsFixture();
    f.diagnostics.onSessionStart();
    f.diagnostics.scheduleSnapshotPersist();
    if (succession === "replace") f.scope.ctx = { id: "new" };
    else if (succession === "same-context-generation") f.scope.generation += 1;
    else f.scope.ctx = undefined;
    f.callbacks.shift()!();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.counts, { projections: 0, publications: 0, statusUpdates: 0 });
    if (succession !== "clear") {
      f.diagnostics.scheduleSnapshotPersist();
      f.callbacks.shift()!();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.counts.publications, 1, "A successor requires its own fresh request");
    }
    await f.diagnostics.onSessionShutdown();
  });
}

test("Status-menu persistence cannot bypass diagnostics shutdown ownership", async () => {
  const f = createScopedDiagnosticsFixture();
  f.diagnostics.onSessionStart();
  assert.ok(f.diagnostics.getStatusLines().length > 0);
  assert.equal(f.counts.projections, 1, "Immediate menu rendering stays available");
  const late = f.callbacks.shift()!;
  await f.diagnostics.onSessionShutdown();
  assert.equal(f.cleared.length, 1);
  late();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.counts.projections, 1, "No deferred re-read after shutdown");
  assert.equal(f.counts.publications, 0);
  const retired = f.scope.ctx!;
  f.scope.ctx = { id: "new" };
  f.diagnostics.updateStatus(retired);
  assert.equal(f.counts.statusUpdates, 0);
  await f.diagnostics.onSessionShutdown();
});

test("Shared log paths put only the active log in root and keep legacy resolvers unchanged", () => {
  assert.equal(resolveTelegramRuntimeLogPath("/agent"), join("/agent", "tmp", "pi-telegram", "logs.jsonl"));
  assert.equal(resolveTelegramPreviousSharedRuntimeLogPath("/agent"), join("/agent", "tmp", "pi-telegram", "logs", "logs._prev.jsonl"));
  assert.equal(resolveTelegramRuntimeDir("/agent"), join("/agent", "tmp", "pi-telegram", "runtime"));
  assert.equal(resolveTelegramRuntimeLogsDir("/agent"), join("/agent", "tmp", "pi-telegram", "logs"));
});

test("Shared JSONL scope reset appends profile markers without erasing another profile or resetting its dedupe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-shared-log-reset-")), path = join(dir, "logs.jsonl");
  let profile = "alpha";
  try {
    const log = createTelegramRuntimeJsonlLog({ path, getNowMs: () => 1000,
      sharedProfiles: { getProfileName: () => profile, captureAuthority: () => () => true } });
    log.resetIfScopeChanged("same-scope", "connect");
    profile = "beta";
    log.resetIfScopeChanged("same-scope", "connect");
    profile = "alpha";
    log.resetIfScopeChanged("same-scope", "connect");
    const rows = await readJsonl(path) as Array<{ profile: string; kind: string }>;
    assert.deepEqual(rows.map(row => [row.kind, row.profile]), [["reset", "alpha"], ["reset", "beta"]]);
    assert.equal(existsSync(join(dir, "logs", "logs._prev.jsonl")), false);
    assert.deepEqual((await readdir(dir)).sort(), ["logs.jsonl", "runtime"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Shared JSONL captures profile at submission and preserves interleaved append order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-shared-log-order-")), path = join(dir, "logs.jsonl");
  let profile = "alpha";
  try {
    const log = createTelegramRuntimeJsonlLog({ path, canReset: () => false,
      sharedProfiles: { getProfileName: () => profile, captureAuthority: () => undefined } });
    log.record({ at: 1, category: "test", message: "a-first" });
    profile = "beta";
    log.record({ at: 2, category: "test", message: "b" });
    profile = "alpha";
    log.record({ at: 3, category: "test", message: "a-last" });
    await new Promise(resolve => setTimeout(resolve, 20));
    const rows = await readJsonl(path) as Array<{ profile: string; message: string }>;
    assert.deepEqual(rows.map(row => [row.profile, row.message]), [["alpha", "a-first"], ["beta", "b"], ["alpha", "a-last"]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Shared JSONL rotation preserves the whole mixed-profile segment below logs and later reset never erases it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-shared-log-rotate-")), path = join(dir, "logs.jsonl"), previous = join(dir, "logs", "logs._prev.jsonl");
  let profile = "alpha";
  try {
    const stateText = JSON.stringify({ version: 2, profiles: { alpha: { runtime: { source: "snapshot" } } } });
    await writeFile(join(dir, "state.json"), stateText);
    const seeds = [{ kind: "event", profile: "alpha", message: "a-seed" }, { kind: "event", profile: "beta", message: "b-seed" }];
    const seedText = seeds.map(row => JSON.stringify(row) + "\n").join("");
    await writeFile(path, seedText);
    const first = { at: 1, category: "test", message: "a".repeat(600) };
    const firstLine = JSON.stringify({ kind: "event", ...first, profile: "alpha" }) + "\n";
    const log = createTelegramRuntimeJsonlLog({ path, maxBytes: Buffer.byteLength(seedText) + Buffer.byteLength(firstLine),
      sharedProfiles: { getProfileName: () => profile, captureAuthority: () => () => true } });
    log.record(first);
    profile = "beta";
    log.record({ at: 2, category: "test", message: "b".repeat(100) });
    await new Promise(resolve => setTimeout(resolve, 20));
    const archived = await readJsonl(previous) as Array<{ profile: string; message: string }>;
    assert.deepEqual(archived.map(row => row.profile), ["alpha", "beta", "alpha"]);
    const current = await readJsonl(path) as Array<{ kind: string; profile: string }>;
    assert.deepEqual(current.map(row => [row.kind, row.profile]), [["reset", "beta"], ["event", "beta"]]);
    profile = "alpha";
    log.reset("restart");
    assert.deepEqual(await readJsonl(previous), archived);
    assert.equal((await readJsonl(path)).length, 3);
    assert.deepEqual((await readdir(dir)).sort(), ["logs", "logs.jsonl", "runtime", "state.json"]);
    assert.equal(await readFile(join(dir, "state.json"), "utf8"), stateText);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const drift of ["generation", "profile", "path", "missing-grant", "serialization"] as const) {
  test(`Shared JSONL queued rotation never borrows fresh authority (${drift})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-shared-log-drift-")), originalPath = join(dir, "logs.jsonl");
    let path = originalPath, profile = "alpha", generation = 1;
    try {
      const seed = JSON.stringify({ kind: "event", profile: "beta", message: "protected-old-evidence" }) + "\n";
      await writeFile(path, seed);
      const log = createTelegramRuntimeJsonlLog({ path: () => path, maxBytes: Buffer.byteLength(seed),
        sharedProfiles: { getProfileName: () => profile, captureAuthority() {
          if (drift === "missing-grant") return undefined;
          const captured = generation;
          return () => captured === generation;
        } } });
      log.record({ at: 1, category: "test", message: "captured-alpha",
        ...(drift === "serialization" ? { details: { toJSON() { generation++; return { observed: true }; } } } : {}) });
      if (drift === "generation") generation++;
      if (drift === "profile") profile = "beta";
      if (drift === "path") path = join(dir, "replacement.jsonl");
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(existsSync(join(dir, "logs", "logs._prev.jsonl")), false);
      assert.equal(existsSync(join(dir, "replacement.jsonl")), false);
      const rows = await readJsonl(originalPath) as Array<{ profile: string; message: string }>;
      assert.deepEqual(rows.map(row => row.profile), ["beta", "alpha"]);
      assert.equal(rows[1]?.message, "captured-alpha");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("Shared JSONL captures callable capabilities instead of adopting caller replacements", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-shared-log-capabilities-")), path = join(dir, "logs.jsonl");
  try {
    const options = { path: () => path, canReset: () => false,
      sharedProfiles: { getProfileName: () => "alpha", captureAuthority: () => () => false } };
    const log = createTelegramRuntimeJsonlLog(options);
    options.path = () => join(dir, "replacement.jsonl");
    options.canReset = () => true;
    options.sharedProfiles.getProfileName = () => "replacement";
    options.sharedProfiles.captureAuthority = () => () => true;
    log.reset("refused");
    log.record({ at: 1, category: "test", message: "retained" });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(existsSync(join(dir, "replacement.jsonl")), false);
    const rows = await readJsonl(path) as Array<{ profile: string; kind: string }>;
    assert.deepEqual(rows.map(row => [row.kind, row.profile]), [["event", "alpha"]]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const boundary of ["commit", "serialization"] as const) {
  test(`Shared JSONL reset and rotation refuse authority lost at ${boundary}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-shared-log-boundary-")), path = join(dir, "logs.jsonl");
    let generation = 1;
    try {
      const seed = JSON.stringify({ kind: "event", profile: "beta", message: "protected" }) + "\n";
      await writeFile(path, seed);
      const log = createTelegramRuntimeJsonlLog({ path, maxBytes: 1,
        getNowMs: () => { if (boundary === "serialization") generation++; return 1000; },
        commitReset: commit => { if (boundary === "commit") generation++; commit(); return true; },
        sharedProfiles: { getProfileName: () => "alpha", captureAuthority: () => { const captured = generation; return () => captured === generation; } } });
      log.reset("refused");
      assert.equal(await readFile(path, "utf8"), seed);
      log.record({ at: 1, category: "test", message: "observed" });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(existsSync(join(dir, "logs", "logs._prev.jsonl")), false);
      assert.equal((await readJsonl(path)).length, 2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("Shared JSONL reset-only streams use the same whole-segment bounded rotation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-shared-log-reset-rotation-")), path = join(dir, "logs.jsonl");
  try {
    const log = createTelegramRuntimeJsonlLog({ path, maxBytes: 150, getNowMs: () => 1000,
      sharedProfiles: { getProfileName: () => "alpha", captureAuthority: () => () => true } });
    log.reset("first"); log.reset("second"); log.reset("third");
    assert.equal(existsSync(join(dir, "logs", "logs._prev.jsonl")), true);
    const rows = await readJsonl(path) as Array<{ reason: string }>;
    assert.equal(rows[0]?.reason, "max-bytes");
    assert.equal(rows.at(-1)?.reason, "third");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Shared JSONL profile-tagged appends serialize across actual processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-shared-log-processes-")), path = join(dir, "logs.jsonl"), start = join(dir, "start");
  try {
    const moduleUrl = new URL("../lib/logging.ts", import.meta.url).href;
    const children = ["alpha", "beta"].map(profile => {
      const ready = join(dir, `ready-${profile}`);
      const source = `
        import { existsSync, writeFileSync } from "node:fs";
        import { createTelegramRuntimeJsonlLog } from ${JSON.stringify(moduleUrl)};
        const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        const log = createTelegramRuntimeJsonlLog({ path: process.env.LOG_PATH, canReset: () => false,
          sharedProfiles: { getProfileName: () => process.env.PROFILE, captureAuthority: () => undefined } });
        writeFileSync(process.env.READY, "ready");
        while (!existsSync(process.env.START)) sleep(2);
        for (let index = 0; index < 25; index++) log.record({ at: index, category: "test", message: String(index) });
        await new Promise(resolve => setTimeout(resolve, 50));
      `;
      return { ready, done: runNodeEval(source, { env: { LOG_PATH: path, PROFILE: profile, READY: ready, START: start } }) };
    });
    const deadline = Date.now() + 3000;
    while (!children.every(child => existsSync(child.ready)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(children.every(child => existsSync(child.ready)), true);
    await writeFile(start, "start");
    for (const child of children) { const result = await child.done; assert.equal(result.code, 0, result.stderr); }
    const rows = await readJsonl(path) as Array<{ profile: string; message: string }>;
    assert.equal(rows.length, 50);
    for (const profile of ["alpha", "beta"]) assert.equal(new Set(rows.filter(row => row.profile === profile).map(row => row.message)).size, 25);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Runtime log paths preserve default compatibility and isolate named profiles", async () => {
  assert.equal(
    getTelegramRuntimeLogPath("/agent"),
    join("/agent", "tmp", "pi-telegram", "logs.jsonl"),
  );
  assert.equal(
    getTelegramPreviousRuntimeLogPath("/agent"),
    join("/agent", "tmp", "pi-telegram", "logs._prev.jsonl"),
  );
  assert.equal(
    getTelegramRuntimeLogPath("/agent", "omp"),
    join("/agent", "tmp", "pi-telegram", "logs.omp.jsonl"),
  );
  assert.equal(
    getTelegramPreviousRuntimeLogPath("/agent", "omp"),
    join("/agent", "tmp", "pi-telegram", "logs.omp._prev.jsonl"),
  );
});

test("Runtime JSONL paths do not collide across profile lifecycle names", () => {
  const profiles = [
    "prev",
    "previous",
    "current",
    "work",
    "workone",
    "worktwo",
  ];
  const paths = new Set([
    getTelegramRuntimeLogPath("/agent"),
    getTelegramPreviousRuntimeLogPath("/agent"),
  ]);
  for (const profile of profiles) {
    paths.add(getTelegramRuntimeLogPath("/agent", profile));
    paths.add(getTelegramPreviousRuntimeLogPath("/agent", profile));
  }
  assert.equal(paths.size, 2 + profiles.length * 2);
  assert.equal(
    getTelegramRuntimeLogPath("/agent", "previous"),
    join("/agent", "tmp", "pi-telegram", "logs.previous.jsonl"),
  );
  assert.equal(
    getTelegramPreviousRuntimeLogPath("/agent", "previous"),
    join("/agent", "tmp", "pi-telegram", "logs.previous._prev.jsonl"),
  );
});

test("Runtime JSONL log resets and appends session events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-log-"));
  try {
    let nowMs = 1000;
    const path = join(dir, "logs.jsonl");
    const previousPath = join(dir, "logs._prev.jsonl");
    const log = createTelegramRuntimeJsonlLog({
      path,
      previousPath,
      getNowMs: () => nowMs,
    });

    log.reset("extension-start", { role: "leader" });
    log.record({
      at: 1001,
      category: "bus",
      message: "started",
      details: { phase: "leader-start" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(await readJsonl(path), [
      {
        at: 1000,
        kind: "reset",
        reason: "extension-start",
        scope: { role: "leader" },
        previousPath,
      },
      {
        at: 1001,
        kind: "event",
        category: "bus",
        message: "started",
        details: { phase: "leader-start" },
      },
    ]);

    nowMs = 2000;
    log.resetIfScopeChanged("follower", "status-scope-change", {
      role: "follower",
    });
    assert.deepEqual(await readJsonl(path), [
      {
        at: 2000,
        kind: "reset",
        reason: "status-scope-change",
        scope: { role: "follower" },
        previousPath,
      },
    ]);
    assert.deepEqual(await readJsonl(previousPath), [
      {
        at: 1000,
        kind: "reset",
        reason: "extension-start",
        scope: { role: "leader" },
        previousPath,
      },
      {
        at: 1001,
        kind: "event",
        category: "bus",
        message: "started",
        details: { phase: "leader-start" },
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Runtime JSONL batching rotates between records that cross maxBytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-log-batch-rotate-"));
  const path = join(dir, "logs.jsonl");
  const previousPath = join(dir, "logs._prev.jsonl");
  try {
    const seedLine = `${JSON.stringify({ kind: "event", message: "seed" })}\n`;
    const firstLine = `${JSON.stringify({
      kind: "event",
      at: 1,
      category: "batch",
      message: "first",
    })}\n`;
    await writeFile(path, seedLine);
    const log = createTelegramRuntimeJsonlLog({
      path,
      previousPath,
      maxBytes: Buffer.byteLength(seedLine) + Buffer.byteLength(firstLine),
    });

    log.record({ at: 1, category: "batch", message: "first" });
    log.record({ at: 2, category: "batch", message: "second" });
    const deadline = Date.now() + 1000;
    while (!existsSync(previousPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.deepEqual(
      (await readJsonl(previousPath)).map(
        (entry) => (entry as { message?: string }).message,
      ),
      ["seed", "first"],
    );
    const current = await readJsonl(path);
    assert.equal((current[0] as { reason?: string }).reason, "max-bytes");
    assert.equal((current[1] as { message?: string }).message, "second");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Runtime JSONL destructive reset commits only under exact ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-log-reset-fence-"));
  const path = join(dir, "logs.jsonl");
  let owned = false;
  try {
    await writeFile(path, '{"kind":"event","message":"replacement"}\n');
    const log = createTelegramRuntimeJsonlLog({
      path,
      canReset: () => true,
      commitReset(commit) {
        if (!owned) return false;
        commit();
        return true;
      },
    });

    log.resetIfScopeChanged("leader", "status-scope-change", {
      role: "leader",
    });
    assert.deepEqual(await readJsonl(path), [
      { kind: "event", message: "replacement" },
    ]);

    owned = true;
    log.resetIfScopeChanged("leader", "status-scope-change", {
      role: "leader",
    });
    assert.equal(
      ((await readJsonl(path))[0] as { kind?: string } | undefined)?.kind,
      "reset",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Runtime JSONL append failures stay contained and do not poison later records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-log-failure-"));
  const blockerPath = join(dir, "not-a-directory");
  const validPath = join(dir, "logs.jsonl");
  let path = join(blockerPath, "logs.jsonl");
  try {
    await writeFile(blockerPath, "block mkdir");
    const log = createTelegramRuntimeJsonlLog({ path: () => path });
    log.record({ at: 1, category: "failure", message: "contained" });
    path = validPath;
    log.record({ at: 2, category: "recovery", message: "persisted" });

    const deadline = Date.now() + 1_000;
    while (!existsSync(validPath) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(await readJsonl(validPath), [
      {
        at: 2,
        kind: "event",
        category: "recovery",
        message: "persisted",
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Runtime JSONL contains one failed record under strict unhandled rejection mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-log-strict-failure-"));
  const blockerPath = join(dir, "not-a-directory");
  const moduleUrl = new URL("../lib/logging.ts", import.meta.url).href;
  try {
    await writeFile(blockerPath, "block mkdir");
    const source = `
      import { createTelegramRuntimeJsonlLog } from ${JSON.stringify(moduleUrl)};
      const log = createTelegramRuntimeJsonlLog({ path: process.env.LOG_PATH });
      log.record({ at: 1, category: "failure", message: "contained" });
      await new Promise((resolve) => setTimeout(resolve, 50));
    `;
    const result = await runNodeEval(source, {
      env: { LOG_PATH: join(blockerPath, "logs.jsonl") },
      nodeArgs: ["--unhandled-rejections=strict"],
    });
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Runtime JSONL appends serialize across processes without lost lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-log-race-"));
  const path = join(dir, "logs.jsonl");
  const startPath = join(dir, "start");
  const moduleUrl = new URL("../lib/logging.ts", import.meta.url).href;
  const transactionUrl = new URL("../lib/locks.ts", import.meta.url).href;
  const children = ["a", "b"].map((worker) => {
    const readyPath = join(dir, `ready-${worker}`), errorPath = join(dir, `errors-${worker}.jsonl`);
    const source = `
      import { appendFileSync, existsSync, writeFileSync } from "node:fs";
      import { mock } from "node:test";
      const Transactions = await import(${JSON.stringify(transactionUrl)});
      mock.module(${JSON.stringify(transactionUrl)}, { namedExports: { ...Transactions, withTelegramFileTransaction(...args) {
        try { return Transactions.withTelegramFileTransaction(...args); }
        catch (error) {
          try { appendFileSync(process.env.ERROR_PATH, JSON.stringify({ name: error?.name, code: error?.code, reason: error?.reason, phase: error?.phase, message: String(error) }) + "\\n", { mode: 0o600 }); } catch { /* Preserve the original failure. */ }
          throw error;
        }
      } } });
      const { createTelegramRuntimeJsonlLog } = await import(${JSON.stringify(moduleUrl)});
      const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      const log = createTelegramRuntimeJsonlLog({ path: process.env.LOG_PATH, canReset: () => false });
      writeFileSync(process.env.READY_PATH, String(process.pid));
      while (!existsSync(process.env.START_PATH)) sleep(2);
      for (let index = 0; index < 25; index += 1) {
        log.record({ at: index, category: process.env.WORKER, message: String(index) });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    `;
    const done = runNodeEval(source, {
      env: {
        LOG_PATH: path,
        READY_PATH: readyPath,
        ERROR_PATH: errorPath,
        START_PATH: startPath,
        WORKER: worker,
      },
      nodeArgs: ["--experimental-test-module-mocks"],
    }).then(async ({ code, signal, stderr }) => {
      const failures = existsSync(errorPath) ? await readJsonl(errorPath) : [];
      assert.equal(code, 0, JSON.stringify({ worker, signal, stderr, failures }));
      assert.equal(signal, null);
      return { worker, pid: Number(await readFile(readyPath, "utf8")), failures };
    });
    return { readyPath, done };
  });
  try {
    const deadline = Date.now() + 3000;
    while (
      !children.every((child) => existsSync(child.readyPath)) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(children.every((child) => existsSync(child.readyPath)), true);
    await writeFile(startPath, "start");
    const evidence = await Promise.all(children.map((child) => child.done));
    const lines = (await readJsonl(path)) as {
      category?: string;
      message?: string;
    }[];
    assert.equal(lines.length, 50, JSON.stringify({ workers: evidence, counts: Object.fromEntries(["a", "b"].map(worker => [worker, lines.filter(line => line.category === worker).length])) }));
    assert.deepEqual(evidence.flatMap(child => child.failures), [], JSON.stringify(evidence));
    for (const worker of ["a", "b"]) {
      assert.deepEqual(
        lines
          .filter((line) => line.category === worker)
          .map((line) => line.message),
        Array.from({ length: 25 }, (_, index) => String(index)),
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Runtime JSONL append captures its profile path before queued execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-log-path-capture-"));
  try {
    let profileName = "alpha";
    const log = createTelegramRuntimeJsonlLog({
      path: () => getTelegramRuntimeLogPath(dir, profileName),
      previousPath: () => getTelegramPreviousRuntimeLogPath(dir, profileName),
    });

    log.record({ at: 1000, category: "queue", message: "alpha event" });
    profileName = "beta";
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
      await readJsonl(getTelegramRuntimeLogPath(dir, "alpha")),
      [{ at: 1000, kind: "event", category: "queue", message: "alpha event" }],
    );
    await assert.rejects(() => readJsonl(getTelegramRuntimeLogPath(dir, "beta")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Runtime JSONL log keeps previous logs per active profile path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-profile-log-"));
  try {
    let profileName: string | undefined;
    let nowMs = 1000;
    const log = createTelegramRuntimeJsonlLog({
      path: () => getTelegramRuntimeLogPath(dir, profileName),
      previousPath: () => getTelegramPreviousRuntimeLogPath(dir, profileName),
      getNowMs: () => nowMs,
    });

    log.reset("default-start", { profile: "default" });
    profileName = "omp";
    nowMs = 2000;
    log.reset("profile-start", { profile: "omp" });
    log.record({ at: 2001, category: "bus", message: "profile event" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(await readJsonl(getTelegramRuntimeLogPath(dir)), [
      {
        at: 1000,
        kind: "reset",
        reason: "default-start",
        scope: { profile: "default" },
        previousPath: getTelegramPreviousRuntimeLogPath(dir),
      },
    ]);
    assert.deepEqual(await readJsonl(getTelegramRuntimeLogPath(dir, "omp")), [
      {
        at: 2000,
        kind: "reset",
        reason: "profile-start",
        scope: { profile: "omp" },
        previousPath: getTelegramPreviousRuntimeLogPath(dir, "omp"),
      },
      { at: 2001, kind: "event", category: "bus", message: "profile event" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function createFailureRunFixture(options: { nowMs?: () => number } = {}) {
  const events: Array<{
    category: string;
    messageOrError: unknown;
    details: Record<string, unknown>;
  }> = [];
  const log = createTelegramFailureRunLog({
    category: "bus",
    failurePhase: "fixture-phase",
    outcomePhase: "fixture-phase-recovered",
    label: "fixture probe",
    context: () => ({ profile: "default" }),
    ...(options.nowMs ? { getNowMs: options.nowMs } : {}),
    record: (category, messageOrError, details) =>
      events.push({ category, messageOrError, details }),
  });
  return { log, events, phases: () => events.map((event) => event.details.phase) };
}

test("Repeated identical failures collapse into one record and one outcome", () => {
  let nowMs = 1000;
  const fixture = createFailureRunFixture({ nowMs: () => nowMs });
  const error = Object.assign(new Error("connect ENOENT /run/bus.sock"), {
    code: "ENOENT",
  });

  assert.equal(fixture.log.record(error, { chatId: 7 }), true);
  nowMs += 1000;
  assert.equal(fixture.log.record(error, { chatId: 7 }), false);
  nowMs += 1000;
  assert.equal(fixture.log.record(error, { chatId: 7 }), false);
  assert.deepEqual(fixture.phases(), ["fixture-phase"]);
  assert.deepEqual(fixture.events[0]?.details, {
    profile: "default",
    chatId: 7,
    phase: "fixture-phase",
    failureSignature: "ENOENT",
  });
  assert.equal(fixture.events[0]?.category, "bus");
  assert.equal(fixture.events[0]?.messageOrError, error);

  nowMs += 3000;
  assert.deepEqual(fixture.log.settled(), {
    signature: "ENOENT",
    failedAttempts: 3,
    suppressedFailures: 2,
    failedForMs: 5000,
  });
  assert.deepEqual(fixture.phases(), ["fixture-phase", "fixture-phase-recovered"]);
  assert.deepEqual(fixture.events[1]?.details, {
    profile: "default",
    chatId: 7,
    phase: "fixture-phase-recovered",
    failureSignature: "ENOENT",
    failedAttempts: 3,
    suppressedFailures: 2,
    failedForMs: 5000,
  });
  assert.match(String(fixture.events[1]?.messageOrError), /recovered after 3 failed attempts/u);
  // A closed run cannot report a second outcome.
  assert.equal(fixture.log.settled(), undefined);
  assert.equal(fixture.phases().length, 2);
});

test("A changed failure kind opens a new run that names the one it superseded", () => {
  let nowMs = 1000;
  const fixture = createFailureRunFixture({ nowMs: () => nowMs });
  const connectionError = Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
  const timeoutError = new Error("Telegram bus transport timed out.");

  fixture.log.record(connectionError);
  nowMs += 500;
  fixture.log.record(connectionError);
  assert.equal(fixture.log.record(timeoutError), true);
  assert.deepEqual(fixture.phases(), ["fixture-phase", "fixture-phase"]);
  assert.equal(getTelegramFailureSignature(connectionError), "ENOENT");
  assert.equal(getTelegramFailureSignature(timeoutError), "Telegram bus transport timed out.");
  assert.deepEqual(fixture.events[1]?.details, {
    profile: "default",
    phase: "fixture-phase",
    failureSignature: "Telegram bus transport timed out.",
    previousFailureSignature: "ENOENT",
    previousFailedAttempts: 2,
    previousFailedForMs: 500,
  });
  // The superseded run still closes with its own outcome.
  assert.equal(fixture.log.settled()?.failedAttempts, 1);
});

test("Reset ends a run without an outcome record and a later failure logs again", () => {
  const fixture = createFailureRunFixture();
  const error = Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });

  fixture.log.record(error);
  fixture.log.record(error);
  fixture.log.reset();
  assert.equal(fixture.log.settled(), undefined);
  fixture.log.record(error);
  assert.deepEqual(fixture.phases(), ["fixture-phase", "fixture-phase"]);
});

test("A failed diagnostic sink never converts a failure into another failure", () => {
  const log = createTelegramFailureRunLog({
    category: "bus",
    failurePhase: "fixture-phase",
    outcomePhase: "fixture-phase-recovered",
    label: "fixture probe",
    record: () => {
      throw new Error("diagnostic sink failed");
    },
  });
  const error = new Error("connect ENOENT");
  assert.equal(log.record(error), true);
  assert.equal(log.record(error), false);
  assert.equal(log.settled()?.failedAttempts, 2);
  assert.equal(log.settled(), undefined);
});
