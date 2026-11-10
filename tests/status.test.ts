/**
 * Regression tests for Telegram status helpers
 * Covers runtime diagnostics lines and recent-event redaction/ring-buffer behavior
 * Zones: telegram ui, pi agent diagnostics, tui
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as Queue from "../lib/queue.ts";
import { createTelegramLockRuntime, mutateTelegramRuntimeStateSection, readTelegramRuntimeState } from "../lib/locks.ts";

import {
  buildTelegramBridgeStatusLines,
  buildTelegramRuntimeEventLines,
  buildTelegramStatusBarText,
  clearTelegramStatusLineProviders,
  createTelegramBridgeStatusRuntime,
  createTelegramRuntimeDiagnosticsSnapshotScheduler,
  createTelegramRuntimeProjectionStore,
  type TelegramRuntimeProjectionStoreOptions,
  type TelegramRuntimeProjectionStorage,
  type TelegramStatusSnapshot,
  type TelegramStatusBarState,
  createTelegramRuntimeEventRecorder,
  createTelegramRuntimeLogScope,
  createTelegramStatusHtmlBuilder,
  createTelegramStatusSnapshot,
  createTelegramStatusRuntime,
  formatTelegramConnectionFailure,
  getTelegramStatusBarProcessingStatus,
  recordStructuredTelegramRuntimeEvent,
  registerTelegramStatusLineProvider,
  type TelegramRuntimeEvent,
} from "../lib/status.ts";

function createProjectionFixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-runtime-projection-")), path = join(dir, "state.json");
  const scope = { path, profile: "default", generation: 1, now: 1000, onNow: undefined as (() => void) | undefined,
    onPublish: undefined as ((boundary: "before-write" | "after-write-before-rename" | "after-rename") => void) | undefined };
  const owner = createTelegramLockRuntime({ statePath: path, key: () => scope.profile, pid: 10,
    instanceId: "owner", runtimeGeneration: 1, isProcessAlive: () => true });
  const snapshot: TelegramStatusSnapshot = { runtime: { pollingActive: true }, liveRoster: { busFollowers: [] },
    diagnostics: { pendingDispatch: false, recentRuntimeEvents: [{ at: 1, category: "bus", message: "already logged" }] } };
  const publishIfOwned = owner.publishStateSectionIfOwned!;
  const storage: TelegramRuntimeProjectionStorage = {
    read({ path, profile }) {
      const file = readTelegramRuntimeState(path);
      return Object.hasOwn(file.profiles, profile) ? file.profiles[profile]?.runtime : undefined;
    },
    publish(expectedScope, mutate, isCurrent) {
      const outcome = publishIfOwned("runtime", current => {
        const projection = mutate(current);
        return { value: projection.value, result: projection.changed };
      }, { isCurrent, expectedScope, onPublicationBoundary(at) { scope.onPublish?.(at); } });
      return outcome.committed && outcome.result;
    },
  };
  const createStore = (overrides: Partial<TelegramRuntimeProjectionStoreOptions> = {}) => createTelegramRuntimeProjectionStore({
    getPath: () => scope.path, getProfile: () => scope.profile,
    captureAuthority() {
      const epoch = owner.getOwnedLeaderEpoch(), generation = scope.generation;
      if (epoch === undefined) return undefined;
      return () => scope.generation === generation && owner.owns() && owner.getOwnedLeaderEpoch() === epoch;
    },
    storage,
    getNowMs() { scope.onNow?.(); return scope.now; },
    ...overrides,
  });
  return { dir, path, scope, owner, snapshot, createStore, storage };
}

test("Consolidated runtime projection reads and missing authority never create state", async () => {
  const f = createProjectionFixture();
  try {
    const store = f.createStore();
    assert.equal(store.read(), undefined);
    assert.equal(await store.persist(f.snapshot), false);
    assert.deepEqual(readdirSync(f.dir), []);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("Consolidated runtime projection compares fresh content, excludes event history and preserves every sibling", async () => {
  const f = createProjectionFixture();
  try {
    f.owner.acquire({ cwd: "/repo" });
    mutateTelegramRuntimeStateSection(f.path, "default", "workspace", () => ({ value: { binding: 55, forwardIssued: true }, result: true }), { isCurrent: () => true });
    mutateTelegramRuntimeStateSection(f.path, "default", "admission", () => ({ value: { leases: ["busy"], deletionIssued: true }, result: true }), { isCurrent: () => true });
    mutateTelegramRuntimeStateSection(f.path, "other", "workspace", () => ({ value: { binding: 66 }, result: true }), { isCurrent: () => true });
    const before = readTelegramRuntimeState(f.path), store = f.createStore();
    assert.equal(await store.persist(f.snapshot), true);
    assert.equal(store.read()?.runtime.pollingActive, true);
    assert.equal(store.read()?.diagnostics.recentRuntimeEvents, undefined);
    assert.equal(f.snapshot.diagnostics.recentRuntimeEvents instanceof Array, true, "Live debug/ring-buffer input is not mutated");
    const stable = readFileSync(f.path, "utf8"), inode = statSync(f.path).ino;
    f.scope.now = 9000;
    assert.equal(await store.persist(f.snapshot), false);
    assert.equal(readFileSync(f.path, "utf8"), stable);
    assert.equal(statSync(f.path).ino, inode);
    const after = readTelegramRuntimeState(f.path);
    for (const section of ["transport", "workspace", "admission"] as const) assert.deepEqual(after.profiles.default?.[section], before.profiles.default?.[section]);
    assert.deepEqual(after.profiles.other, before.profiles.other);
    mutateTelegramRuntimeStateSection(f.path, "default", "runtime", current => {
      const changed = structuredClone(current) as { diagnostics: { pendingDispatch: boolean } };
      changed.diagnostics.pendingDispatch = true;
      return { value: changed, result: true };
    }, { isCurrent: () => true });
    assert.equal(await store.persist(f.snapshot), true, "A remembered no-op cannot skip changed current disk content");
    assert.equal(store.read()?.diagnostics.pendingDispatch, false);
    assert.deepEqual(readdirSync(f.dir).sort(), ["runtime", "state.json"], "No status sidecar is created");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("Consolidated runtime projection skips the transaction when published content already matches", async () => {
  const f = createProjectionFixture();
  try {
    f.owner.acquire({ cwd: "/repo" });
    let publications = 0;
    const store = f.createStore({ storage: { read: f.storage.read, publish(...args) {
      publications += 1;
      return f.storage.publish(...args);
    } } });
    assert.equal(await store.persist(f.snapshot), true);
    assert.equal(publications, 1);
    f.scope.now = 9000;
    assert.equal(await store.persist(f.snapshot), false);
    assert.equal(publications, 1, "An unchanged idle snapshot creates no transaction guard");
    assert.equal(await store.persist({ ...f.snapshot, runtime: { pollingActive: false } }), true);
    assert.equal(publications, 2);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("Consolidated runtime projection never persists poll-cycle timestamps", async () => {
  const f = createProjectionFixture();
  try {
    f.owner.acquire({ cwd: "/repo" });
    let publications = 0;
    const store = f.createStore({ storage: { read: f.storage.read, publish(...args) {
      publications += 1;
      return f.storage.publish(...args);
    } } });
    const polled = (atMs: number): TelegramStatusSnapshot => ({ ...f.snapshot, runtime: { ...f.snapshot.runtime,
      polling: { phase: "long-poll", phaseStartedAtMs: atMs, lastSuccessfulResponseAtMs: atMs, lastSuccessfulResponseUpdateCount: 0, startedAtMs: 1 } } });
    assert.equal(await store.persist(polled(100)), true);
    assert.deepEqual(store.read()?.runtime.polling, { phase: "long-poll", startedAtMs: 1 });
    assert.equal(await store.persist(polled(30_100)), false);
    assert.equal(publications, 1, "Another idle poll response writes nothing");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const drift of ["generation", "profile", "path", "owner"] as const) {
  test(`Consolidated runtime projection refuses queued source drift (${drift})`, async () => {
    const f = createProjectionFixture();
    try {
      const acquired = f.owner.acquire({ cwd: "/repo" }), store = f.createStore();
      const pending = store.persist(f.snapshot);
      if (drift === "generation") f.scope.generation++;
      if (drift === "profile") f.scope.profile = "other";
      if (drift === "path") f.scope.path = join(f.dir, "other-state.json");
      if (drift === "owner") createTelegramLockRuntime({ statePath: f.path, pid: 20, instanceId: "replacement", runtimeGeneration: 2,
        isProcessAlive: () => true }).acquire({ cwd: "/other" }, { force: true, expectedOwner: acquired.ok ? acquired.lock : undefined });
      const stable = readFileSync(f.path, "utf8");
      assert.equal(await pending, false);
      assert.equal(readFileSync(f.path, "utf8"), stable);
      assert.equal(readTelegramRuntimeState(f.path).profiles.default?.runtime, undefined);
      assert.equal(existsSync(join(f.dir, "other-state.json")), false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
}

for (const mismatch of ["profile", "path"] as const) {
  test(`Consolidated runtime projection cannot borrow a publisher for a mismatched identity (${mismatch})`, async () => {
    const f = createProjectionFixture();
    try {
      f.owner.acquire({ cwd: "/repo" });
      const store = f.createStore({ ...(mismatch === "profile" ? { getProfile: () => "other" } : { getPath: () => join(f.dir, "other-state.json") }) });
      const before = readFileSync(f.path, "utf8");
      assert.equal(await store.persist(f.snapshot), false);
      assert.equal(readFileSync(f.path, "utf8"), before);
      assert.equal(existsSync(join(f.dir, "other-state.json")), false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
}

test("Consolidated runtime projection freezes queued content and callable capabilities at submission/construction", async () => {
  const f = createProjectionFixture();
  try {
    f.owner.acquire({ cwd: "/repo" });
    const options = { getPath: () => f.path, getProfile: () => "default", captureAuthority: () => () => true,
      storage: f.storage };
    const store = createTelegramRuntimeProjectionStore(options);
    const pending = store.persist(f.snapshot);
    f.snapshot.runtime.pollingActive = false;
    options.storage.publish = () => { throw new Error("Replacement capability must not be borrowed"); };
    assert.equal(await pending, true);
    assert.equal(store.read()?.runtime.pollingActive, true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("Consolidated runtime projection rejects lost authority during reduction and keeps the queue usable", async () => {
  const f = createProjectionFixture();
  try {
    f.owner.acquire({ cwd: "/repo" });
    const store = f.createStore(), before = readFileSync(f.path, "utf8");
    f.scope.onNow = () => { f.scope.generation++; };
    await assert.rejects(store.persist(f.snapshot), /authority changed/);
    assert.equal(readFileSync(f.path, "utf8"), before);
    f.scope.onNow = undefined;
    assert.equal(await store.persist(f.snapshot), true, "A failed observation cannot poison later freshly authorized diagnostics");
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("Consolidated runtime projection retains a published observation after lost ACK without replaying publication", async () => {
  const f = createProjectionFixture();
  try {
    f.owner.acquire({ cwd: "/repo" });
    let writes = 0;
    f.scope.onPublish = at => {
      if (at === "after-rename") { writes++; throw new Error("Lost observational publication ACK"); }
    };
    const store = f.createStore();
    await assert.rejects(store.persist(f.snapshot), /outcome is unknown/);
    assert.equal(store.read()?.runtime.pollingActive, true);
    assert.equal(await store.persist(f.snapshot), false, "Fresh comparison acknowledges no semantic change, not another publication attempt");
    assert.equal(writes, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

for (const damage of ["projection", "envelope"] as const) {
  test(`Consolidated runtime projection inspection never repairs damaged state (${damage})`, async () => {
    const f = createProjectionFixture();
    try {
      f.owner.acquire({ cwd: "/repo" });
      mutateTelegramRuntimeStateSection(f.path, "default", "workspace", () => ({ value: { binding: 55 }, result: true }), { isCurrent: () => true });
      if (damage === "projection") mutateTelegramRuntimeStateSection(f.path, "default", "runtime", () => ({ value: ["bad"], result: true }), { isCurrent: () => true });
      else writeFileSync(f.path, "{", { mode: 0o600 });
      const store = f.createStore(), before = readFileSync(f.path, "utf8");
      assert.equal(store.read(), undefined);
      assert.equal(readFileSync(f.path, "utf8"), before);
      if (damage === "envelope") {
        assert.equal(await store.persist(f.snapshot), false, "Damaged envelope fails closed without repair");
        assert.equal(readFileSync(f.path, "utf8"), before);
      } else {
        assert.equal(await store.persist(f.snapshot), true, "Only a known non-authoritative section may be replaced under current owner authority");
        assert.deepEqual(readTelegramRuntimeState(f.path).profiles.default?.workspace, { binding: 55 });
      }
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
}

test("Connection notices name known causes and one recovery action without raw detail", () => {
  const cases: Array<[unknown, string]> = [
    [Object.assign(new Error("raw token secret"), { status: 401 }), "Telegram token rejected. Run /telegram-setup."],
    [Object.assign(new Error("raw denied"), { status: 403 }), "Telegram access denied. Check /telegram-status --debug."],
    [Object.assign(new Error("raw host"), { code: "ENOTFOUND" }), "Telegram network unavailable. Retry /telegram-connect."],
    ["Telegram Workspace slot reservation is unavailable.", "No Telegram slot available. Check /telegram-status --debug."],
    [{ code: "incompatible-protocol" }, "Telegram instances are incompatible. Update them together."],
    ["Unsupported journal version 42", "Telegram state version unsupported. Use a compatible runtime."],
    ["Telegram bridge is active in another Pi instance (private path); follower registration failed: secret", "Telegram leader is active but unavailable. Check /telegram-status --debug."],
    ["Telegram unfinished Thread creation does not match this session binding.", "Telegram Thread creation is unresolved. Check /telegram-status --debug."],
    [new Error("stale ctx: use withSession; raw token secret"), "Telegram connection failed. Check /telegram-status --debug."],
    [null, "Telegram connection failed. Check /telegram-status --debug."],
    ["Timed out waiting for Telegram leader readiness.", "Timed out waiting for Telegram leader readiness. Check /telegram-status --debug."],
    [new Error("Timed out waiting for Telegram leader readiness."), "Timed out waiting for Telegram leader readiness. Check /telegram-status --debug."],
    ["private Timed out waiting for Telegram leader readiness. secret", "Telegram connection failed. Check /telegram-status --debug."],
  ];
  for (const [error, expected] of cases) {
    assert.equal(formatTelegramConnectionFailure(error), expected);
    assert.ok(expected.length < 100);
    assert.ok(!expected.includes("secret"));
  }
});

for (const [reason, cause] of [
  ["missing-snapshot", "history is missing"],
  ["profile-changed", "profile changed"],
  ["token-changed", "bot identity changed"],
  ["revision-regressed", "revision moved backwards"],
  ["same-revision-conflict", "history changed without a revision"],
] as const)
for (const carrier of ["error", "message", "registration"] as const)
test(`Connection Restore notice names the finite cause without copying private context (${reason}/${carrier})`, () => {
  const message = `Workspace Restore evidence moved backwards or changed without revision (${reason}).`;
  const value = carrier === "error" ? Object.assign(new Error(message), { code: "workspace-restore-evidence-conflict", reason }) :
    carrier === "registration" ? `Telegram bridge is active in another Pi instance (pid 42, cwd /private/secret); follower registration failed: ${message}` : message;
  const notice = formatTelegramConnectionFailure(value);
  assert.equal(notice, `Telegram Workspace Restore ${cause}. Connection blocked to protect prior work. Check /telegram-status --debug.`);
  assert.doesNotMatch(notice, /secret|private|pid 42|unavailable|Retry|takeover|reset/iu);
});

test("Connection Restore notices support legacy and unknown reasons without inventing recovery", () => {
  const generic = "Telegram Workspace Restore history conflicts with current state. Connection blocked to protect prior work. Check /telegram-status --debug.";
  for (const value of [
    "Workspace Restore evidence moved backwards or changed without revision.",
    "Follower registration failed: Workspace Restore evidence moved backwards or changed without revision (unknown-secret).",
    { code: "workspace-restore-evidence-conflict", reason: "secret" },
  ]) assert.equal(formatTelegramConnectionFailure(value), generic);
  assert.equal(formatTelegramConnectionFailure("Workspace Restore evidence disappeared."),
    "Telegram Workspace Restore history is missing. Connection blocked to protect prior work. Check /telegram-status --debug.");
  for (const value of ["Workspace Restore unrecognised secret", "Workspace Restore evidence disappearedly secret",
    "Workspace Restore evidence moved backwards or changed without revisionless secret"])
    assert.equal(formatTelegramConnectionFailure(value), "Telegram connection failed. Check /telegram-status --debug.",
      "Unrecognised prose is not a classified Restore conflict");
});

test("Connection Restore causes survive incidental context while explicit transport causes stay separate", () => {
  const detail = "Workspace Restore evidence moved backwards or changed without revision (missing-snapshot).";
  const expected = "Telegram Workspace Restore history is missing. Connection blocked to protect prior work. Check /telegram-status --debug.";
  for (const prefix of ["fetch failed", "Workspace slots exhausted", "Unsupported journal version", "protocol mismatch"])
    assert.equal(formatTelegramConnectionFailure(`Telegram bridge is active in another Pi instance (cwd /private/${prefix}); follower registration failed: ${detail}`), expected);
  for (const [metadata, notice] of [
    [{ status: 401 }, "Telegram token rejected. Run /telegram-setup."],
    [{ status: 403 }, "Telegram access denied. Check /telegram-status --debug."],
    [{ code: "ECONNREFUSED" }, "Telegram network unavailable. Retry /telegram-connect."],
    [{ code: "incompatible-protocol" }, "Telegram instances are incompatible. Update them together."],
  ] as const) assert.equal(formatTelegramConnectionFailure(Object.assign(new Error(detail), metadata)), notice);
});

test("Recovery event evidence stays finite and cannot be downgraded by caller details", () => {
  const recorder = createTelegramRuntimeEventRecorder({ getBotToken: () => "123:secret" });
  recorder.record("connection", Object.assign(new Error("unavailable"), { name: "TelegramApiAuthorityError", requestIssued: true }),
    { phase: "connect", requestIssued: false });
  assert.deepEqual(recorder.getEvents()[0]!.details, { phase: "connect", requestIssued: true });
  recorder.record("connection", { code: "guard-unverifiable", reason: "123:secret", phase: "123:secret", cause: { body: "123:secret" } });
  assert.deepEqual(recorder.getEvents()[1]!.details, { errorCode: "guard-unverifiable" });
  for (const error of [
    Object.assign(new Error("opaque"), { name: "OtherError", requestIssued: true, kind: "unknown-secret", code: "unknown-secret" }),
    Object.assign(new Error("opaque"), { name: "TelegramApiAuthorityError", requestIssued: "true" }),
    { name: "TelegramBusLocalAuthorityError", requestIssued: true },
  ]) {
    recorder.record("connection", error);
    assert.equal(recorder.getEvents().at(-1)!.details, undefined, "Unknown fields and wire-shaped copies are not native issuance evidence");
    assert.equal(formatTelegramConnectionFailure(error), "Telegram connection failed. Check /telegram-status --debug.");
  }
});

test("Status helpers build runtime log scope and persisted snapshot projections", () => {
  const state = {
    busRole: "leader" as const,
    botThreadMode: "enabled" as const,
    botThreadModeUpdatedAtMs: 10,
    botThreadModeAction: "probe",
    instanceSlot: "A",
    instanceThreadName: "Axial",
    pollingActive: true,
    polling: {
      phase: "persisting-journal",
      phaseStartedAtMs: 8,
      currentUpdateId: 12,
      startedAtMs: 7,
      lastSuccessfulResponseAtMs: 8,
      lastSuccessfulResponseUpdateCount: 1,
    },
    lockState: "active-here",
    pendingDispatch: true,
    compactionInProgress: false,
    activeToolExecutions: 1,
    pendingModelSwitch: false,
    queuedItems: [],
    busFollowers: [{ instanceId: "follower", lastHeartbeatMs: 5 }],
    topicTargets: [{ instanceId: "leader", status: "active" }],
    threadReservations: [{ slot: "B", reason: "startup" }],
    topicSyncObservations: [{ syncStatus: "open", observedAtMs: 9 }],
    syncState: { pairing: { status: "fresh" } },
    recentRuntimeEvents: [],
  };

  assert.deepEqual(
    createTelegramRuntimeLogScope({ state, instanceId: "instance-1" }),
    {
      instanceId: "instance-1",
      role: "leader",
      slot: "A",
      threadName: "Axial",
      lockState: "active-here",
    },
  );
  assert.deepEqual(createTelegramStatusSnapshot(state), {
    runtime: {
      busRole: "leader",
      botThreadMode: "enabled",
      botThreadModeUpdatedAtMs: 10,
      botThreadModeAction: "probe",
      instanceSlot: "A",
      instanceThreadName: "Axial",
      pollingActive: true,
      polling: {
        phase: "persisting-journal",
        phaseStartedAtMs: 8,
        currentUpdateId: 12,
        startedAtMs: 7,
        lastSuccessfulResponseAtMs: 8,
        lastSuccessfulResponseUpdateCount: 1,
      },
      lockState: "active-here",
    },
    liveRoster: {
      busFollowers: [{ instanceId: "follower", lastHeartbeatMs: 5 }],
      topicTargets: [{ instanceId: "leader", status: "active" }],
      reservations: [{ slot: "B", reason: "startup" }],
    },
    diagnostics: {
      pendingDispatch: true,
      compactionInProgress: false,
      activeToolExecutions: 1,
      pendingModelSwitch: false,
      syncState: { pairing: { status: "fresh" } },
      threadReconciliation: undefined,
      recentRuntimeEvents: [],
    },
  });
});

test("Status runtime diagnostics scheduler coalesces snapshot persists", async () => {
  let scheduled: (() => void) | undefined;
  let scheduledDelayMs: number | undefined;
  let persistCount = 0;
  const errors: unknown[] = [];
  const schedule = createTelegramRuntimeDiagnosticsSnapshotScheduler({
    persistSnapshot: async () => {
      persistCount += 1;
    },
    recordError: (error) => errors.push(error),
    setTimer(callback, ms) {
      scheduled = callback as () => void;
      scheduledDelayMs = ms;
      return { unref() {} } as ReturnType<typeof setTimeout>;
    },
  });

  schedule();
  schedule();
  scheduled?.();
  await Promise.resolve();

  assert.equal(scheduledDelayMs, 100);
  assert.equal(persistCount, 1);
  assert.deepEqual(errors, []);
});

test("Status snapshot scheduler serializes in-flight publication and retains one rerun", async () => {
  const callbacks: Array<() => void> = [];
  const releases: Array<() => void> = [];
  let persistCount = 0;
  const schedule = createTelegramRuntimeDiagnosticsSnapshotScheduler({
    persistSnapshot: () =>
      new Promise<void>((resolve) => {
        persistCount += 1;
        releases.push(resolve);
      }),
    recordError: () => undefined,
    setTimer(callback) {
      callbacks.push(callback);
      return { unref() {} } as ReturnType<typeof setTimeout>;
    },
  });

  schedule();
  callbacks.shift()?.();
  await Promise.resolve();
  assert.equal(persistCount, 1);
  schedule();
  schedule();
  assert.equal(callbacks.length, 0);
  releases.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callbacks.length, 1);
  callbacks.shift()?.();
  await Promise.resolve();
  assert.equal(persistCount, 2);
  releases.shift()?.();
  await Promise.resolve();
});

test("Status snapshot shutdown cancels timers and fences already-dequeued callbacks", async () => {
  const callbacks: Array<() => void> = [];
  const cleared: unknown[] = [];
  let reads = 0;
  const schedule = createTelegramRuntimeDiagnosticsSnapshotScheduler({
    persistSnapshot: async () => { reads += 1; },
    recordError: error => assert.fail(String(error)),
    setTimer(callback) { callbacks.push(callback); return { unref() {} }; },
    clearTimer: handle => { cleared.push(handle); },
  });
  schedule();
  const retired = callbacks.shift()!;
  await schedule.suspend();
  assert.equal(cleared.length, 1);
  schedule();
  retired();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0);
  assert.equal(callbacks.length, 0);
  schedule.resume();
  schedule();
  retired();
  callbacks.shift()!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  await schedule.suspend();
});

test("Status snapshot shutdown drains publication and discards predecessor reruns", async () => {
  const callbacks: Array<() => void> = [];
  let release: (() => void) | undefined;
  let writes = 0, stopped = false;
  const schedule = createTelegramRuntimeDiagnosticsSnapshotScheduler({
    persistSnapshot: () => new Promise<void>(resolve => { writes += 1; release = resolve; }),
    recordError: error => assert.fail(String(error)),
    setTimer(callback) { callbacks.push(callback); return { unref() {} }; },
    clearTimer() {},
  });
  schedule();
  callbacks.shift()!();
  await Promise.resolve();
  schedule();
  const stop = schedule.suspend().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release!();
  await stop;
  assert.equal(callbacks.length, 0);
  assert.equal(writes, 1);
  schedule.resume();
  schedule();
  callbacks.shift()!();
  await Promise.resolve();
  assert.equal(writes, 2);
  release!();
  await schedule.suspend();
});

test("Status snapshot queued microtasks cannot renew a revoked session scope", async () => {
  const callbacks: Array<() => void> = [];
  let session = 1, writes = 0;
  const schedule = createTelegramRuntimeDiagnosticsSnapshotScheduler({
    captureScope() { const captured = session; return () => session === captured; },
    persistSnapshot: async () => { writes += 1; },
    recordError: error => assert.fail(String(error)),
    setTimer(callback) { callbacks.push(callback); return { unref() {} }; },
    clearTimer() {},
  });
  schedule();
  callbacks.shift()!();
  session += 1;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 0);
  schedule();
  callbacks.shift()!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, 1);
  await schedule.suspend();
});

for (const name of ["Telegram", "TeLeGrAm", "LeAdEr", "FoLlOwEr", "CuStOm"] as const) {
  test(`Explicit Thread status labels preserve acknowledged title casing in every connection state (${name})`, () => {
    const theme = { fg: (token: string, text: string) => `<${token}>${text}</${token}>` };
    const base: TelegramStatusBarState = { hasBotToken: true, pollingActive: true, paired: true, busRole: "leader",
      compactionInProgress: false, processing: false, queuedStatus: " +2", instanceThreadName: name };
    const cases: { state: Partial<TelegramStatusBarState>; suffix: string }[] = [
      { state: {}, suffix: "<success>leader</success><warning> +2</warning>" },
      { state: { busRole: "follower", pollingActive: false }, suffix: "<success>follower</success><warning> +2</warning>" },
      { state: { busRole: undefined }, suffix: "<success>connected</success><warning> +2</warning>" },
      { state: { pollingActive: false }, suffix: "<dim>disconnected</dim><warning> +2</warning>" },
      { state: { busLifecyclePhase: "electing" }, suffix: "<warning>electing</warning><warning> +2</warning>" },
      { state: { busRole: "follower", followerRegistered: false }, suffix: "<warning>reconnecting</warning><warning> +2</warning>" },
      { state: { error: "transport failure" }, suffix: "<error>error</error><warning> +2</warning>" },
      { state: { pollingStopReason: "persistent-conflict" }, suffix: "<error>error</error>" },
      { state: { paired: false }, suffix: "<warning>awaiting pairing</warning><warning> +2</warning>" },
      { state: { hasBotToken: false }, suffix: "<muted>not configured</muted><warning> +2</warning>" },
    ];
    for (const { state, suffix } of cases) assert.equal(buildTelegramStatusBarText(theme, { ...base, ...state }), `<accent>${name}</accent> ${suffix}`);
  });
}

test("Thread status uses the generic bridge label only when its title is absent", () => {
  const theme = { fg: (_token: string, text: string) => text };
  for (const instanceThreadName of [undefined, "", "  "]) assert.equal(buildTelegramStatusBarText(theme,
    { hasBotToken: true, pollingActive: true, paired: true, compactionInProgress: false, processing: false, queuedStatus: "", instanceThreadName }), "telegram connected");
});

test("Status bar text renders bridge connection and queue states", () => {
  const theme = {
    fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
  };
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: false,
      pollingActive: false,
      paired: false,
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
    }),
    "<accent>telegram</accent> <muted>not configured</muted>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: false,
      processing: true,
      queuedStatus: " +1",
    }),
    "<accent>telegram</accent> <success>connected</success><warning> +1</warning>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: false,
      processing: true,
      processingStatus: "dispatching",
      queuedStatus: " +1",
    }),
    "<accent>telegram</accent> <success>connected</success><warning> +1</warning>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: false,
      processing: true,
      processingStatus: "active",
      queuedStatus: "",
    }),
    "<accent>telegram</accent> <success>connected</success>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: true,
      processing: false,
      queuedStatus: "",
    }),
    "<accent>telegram</accent> <success>connected</success>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: true,
      processing: true,
      processingStatus: "active",
      queuedStatus: "",
    }),
    "<accent>telegram</accent> <success>connected</success>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: false,
      paired: true,
      instanceThreadName: "Aurora",
      compactionInProgress: false,
      processing: true,
      processingStatus: "queued",
      queuedStatus: " +2",
    }),
    "<accent>Aurora</accent> <dim>disconnected</dim><warning> +2</warning>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: false,
      paired: true,
      compactionInProgress: false,
      processing: true,
      queuedStatus: " +2",
      error: "Telegram bus follower is not registered.",
    }),
    "<accent>telegram</accent> <dim>disconnected</dim><warning> +2</warning>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: false,
      paired: true,
      busRole: "follower",
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
    }),
    "<accent>telegram</accent> <success>follower</success>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: false,
      paired: true,
      busRole: "follower",
      followerRegistered: false,
      instanceThreadName: "Haven",
      compactionInProgress: false,
      processing: false,
      queuedStatus: " +1",
    }),
    "<accent>Haven</accent> <warning>reconnecting</warning><warning> +1</warning>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: false,
      paired: true,
      busRole: "follower",
      instanceThreadName: "Amber",
      compactionInProgress: false,
      processing: true,
      processingStatus: "active",
      queuedStatus: "",
    }),
    "<accent>Amber</accent> <success>follower</success>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: false,
      paired: true,
      busRole: "follower",
      busLifecyclePhase: "electing",
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
    }),
    "<accent>telegram</accent> <warning>electing</warning>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: false,
      paired: true,
      busLifecyclePhase: "electing",
      instanceThreadName: "Cinder",
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
    }),
    "<accent>Cinder</accent> <warning>electing</warning>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: false,
      paired: true,
      busRole: "follower",
      instanceThreadName: "Follower",
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
    }),
    "<accent>Follower</accent> <success>follower</success>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: false,
      paired: true,
      busRole: "follower",
      instanceThreadName: "Lname",
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
    }),
    "<accent>Lname</accent> <success>follower</success>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: false,
      paired: true,
      busRole: "follower",
      instanceSlot: "O",
      instanceThreadName: "extensions Follower",
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
    }),
    "<accent>extensions Follower</accent> <success>follower</success>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: false,
      paired: true,
      busRole: "follower",
      instanceSlot: "O",
      instanceThreadName: "Oname",
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
    }),
    "<accent>Oname</accent> <success>follower</success>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      busRole: "leader",
      compactionInProgress: false,
      processing: true,
      queuedStatus: " +1",
    }),
    "<accent>telegram</accent> <success>leader</success><warning> +1</warning>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      busRole: "leader",
      instanceThreadName: "🌙 A-identity",
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
    }),
    "<accent>🌙 A-identity</accent> <success>leader</success>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: false,
      compactionInProgress: false,
      processing: true,
      processingStatus: "queued",
      queuedStatus: " +1",
    }),
    "<accent>telegram</accent> <warning>awaiting pairing</warning><warning> +1</warning>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
      error: "typing failed",
    }),
    "<accent>telegram</accent> <error>error</error>",
  );
});

test("Status runtime updates the status bar and exposes bridge lines", () => {
  const events: string[] = [];
  const ctx = {
    ui: {
      theme: {
        fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
      },
      setStatus: (key: string, text: string) => {
        events.push(`${key}:${text}`);
      },
    },
  };
  const runtime = createTelegramStatusRuntime({
    getStatusBarState: (_ctx, error) => ({
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
      error,
    }),
    getBridgeStatusLineState: () => ({
      botUsername: "demo_bot",
      allowedUserId: 7,
      lockState: "active here",
      pollingActive: true,
      lastUpdateId: 10,
      pendingDispatch: false,
      compactionInProgress: false,
      activeToolExecutions: 0,
      pendingModelSwitch: false,
      queuedItems: [],
      recentRuntimeEvents: [],
    }),
  });
  runtime.updateStatus(ctx, "demo error");
  assert.equal(
    events[0],
    "telegram:<accent>telegram</accent> <error>error</error>",
  );
  assert.deepEqual(runtime.getStatusLines().slice(0, 3), [
    "connection:",
    "- bot: @demo_bot",
    "- user: 7",
  ]);
});

test("Status lines expose polling and inbound-worker progress separately", () => {
  const state = {
    botUsername: "demo_bot",
    allowedUserId: 7,
    pollingActive: true,
    polling: {
      phase: "persisting-journal",
      phaseStartedAtMs: 2_000,
      currentUpdateId: 11,
      startedAtMs: 1_000,
      lastSuccessfulResponseAtMs: 1_500,
      lastSuccessfulResponseUpdateCount: 2,
    },
    inboundWorker: {
      phase: "blocked",
      generation: 3,
      currentUpdateId: 9,
      blockedReason: "execution",
      blockedInputCustody: { updateId: 9, kind: "running-outcome-unknown" },
      journalEntryCount: 4,
      journalSerializedBytes: 2048,
      oldestAdmittedAtMs: 500,
      deferredClaimCount: 1,
      queuedClaimCount: 2,
      foreignQueuedCount: 1,
      foreignQueuedOwnerLiveness: "unverifiable" as const,
      foreignQueuedOwner: {
        instanceId: "foreign-instance",
        processId: 44,
        processBirthId: "44:start:foreign",
        sessionGeneration: 2,
        acquisitionId: "foreign-acquisition",
        acquiredAtMs: 1_000,
      },
      retryWaitCount: 1,
      failedCount: 1,
      nextRetryUpdateId: 10,
      nextRetryAtMs: 2_500,
      nextRetryAttemptCount: 2,
      nextRetryFailureClass: "transport-failed",
      failedUpdateId: 9,
      failedFailureId: "failure-deadbeef",
      failedAttemptCount: 5,
      failedClass: "invalid-update",
      failedSummary: "Deterministic poison update.",
      terminalFailureAtMs: 1_900,
      unsettledExecutionCount: 1,
      lastCompletedUpdateId: 8,
      lastCompletedAtMs: 1_800,
      lastFailureAtMs: 1_900,
      lastFailurePhase: "execution",
    },
    lastUpdateId: 10,
    pendingDispatch: false,
    compactionInProgress: false,
    activeToolExecutions: 0,
    pendingModelSwitch: false,
    queuedItems: [],
    recentRuntimeEvents: [],
  };

  const compact = buildTelegramBridgeStatusLines(state);
  assert.ok(compact.includes("- polling: running (persisting-journal)"));
  assert.ok(
    compact.includes(
      "- inbound worker: blocked (depth=4, queued=2, foreign=1, deferred=1, retry=1, failed=1)",
    ),
  );

  const diagnostic = buildTelegramBridgeStatusLines(state, { verbose: true });
  assert.ok(diagnostic.includes("- phase: persisting-journal"));
  assert.ok(diagnostic.includes("- current update id: 11"));
  assert.ok(diagnostic.includes("inbound worker:"));
  assert.ok(diagnostic.includes("- journal: entries=4, bytes=2048"));
  assert.ok(
    diagnostic.includes(
      "- claims: queued=2, foreign-queued=1, deferred=1, unsettled=1",
    ),
  );
  assert.ok(
    diagnostic.includes(
      "- queued semantic owner: instance=foreign-instance, pid=44, birth=44:start:foreign, session=2, acquisition=foreign-acquisition, liveness=unverifiable",
    ),
  );
  assert.ok(
    diagnostic.includes(
      "- next retry: update=10, attempt=2, class=transport-failed at 1970-01-01T00:00:02.500Z",
    ),
  );
  assert.ok(
    diagnostic.includes(
      "- terminal update: id=9, failure=failure-deadbeef, attempts=5, class=invalid-update at 1970-01-01T00:00:01.900Z",
    ),
  );
  assert.ok(
    diagnostic.includes("- terminal summary: Deterministic poison update."),
  );
  assert.equal(diagnostic.includes("- operator action:"), false);
  assert.ok(diagnostic.includes("- blocked reason: execution"));
  assert.ok(diagnostic.includes(
    "- blocked input custody: update=9, kind=running-outcome-unknown"));
  assert.ok(
    diagnostic.includes(
      "- last successful response: 1970-01-01T00:00:01.500Z (updates=2)",
    ),
  );
});

test("Status lines expose thread reconciliation state", () => {
  const lines = buildTelegramBridgeStatusLines({
    botUsername: "demo_bot",
    allowedUserId: 7,
    pollingActive: true,
    lastUpdateId: 10,
    pendingDispatch: false,
    compactionInProgress: false,
    activeToolExecutions: 0,
    pendingModelSwitch: false,
    queuedItems: [],
    threadReconciliation: {
      phase: "cleanup-required",
      event: "cleanup-required",
      atMs: 1000,
      leaderEpoch: 3,
      pendingProvisionCount: 1,
      syncActionCount: 2,
      cleanupActionCount: 1,
    },
    recentRuntimeEvents: [],
  });

  assert.ok(lines.includes("reconciliation:"));
  assert.ok(
    lines.includes("- phase: cleanup-required event=cleanup-required epoch=3"),
  );
  assert.ok(lines.includes("- counts: pending=1, sync=2, cleanup=1"));
});

test("Status runtime propagates status update failures to safety wrappers", () => {
  const runtime = createTelegramStatusRuntime({
    getStatusBarState: () => ({
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
    }),
    getBridgeStatusLineState: () => ({
      botUsername: undefined,
      allowedUserId: undefined,
      pollingActive: false,
      lastUpdateId: undefined,
      pendingDispatch: false,
      compactionInProgress: false,
      activeToolExecutions: 0,
      pendingModelSwitch: false,
      queuedItems: [],
      recentRuntimeEvents: [],
    }),
  });
  assert.throws(
    () =>
      runtime.updateStatus({
        ui: {
          theme: { fg: (_token: string, text: string) => text },
          setStatus: () => {
            throw new Error("ctx is stale after session reload");
          },
        },
      }),
    /stale after session/,
  );
});

test("Status bar processing labels prefer the most specific live state", () => {
  assert.equal(
    getTelegramStatusBarProcessingStatus({
      hasActiveTurn: true,
      hasPendingDispatch: true,
      hasPendingModelSwitch: true,
      activeToolExecutions: 1,
      queuedItems: 1,
    }),
    "model",
  );
  assert.equal(
    getTelegramStatusBarProcessingStatus({
      hasActiveTurn: true,
      hasPendingDispatch: false,
      hasPendingModelSwitch: false,
      activeToolExecutions: 1,
      queuedItems: 1,
    }),
    "active",
  );
  assert.equal(
    getTelegramStatusBarProcessingStatus({
      hasActiveTurn: false,
      hasPendingDispatch: false,
      hasPendingModelSwitch: false,
      activeToolExecutions: 1,
      queuedItems: 1,
    }),
    "active",
  );
  assert.equal(
    getTelegramStatusBarProcessingStatus({
      hasActiveTurn: false,
      hasPendingDispatch: true,
      hasPendingModelSwitch: false,
      activeToolExecutions: 0,
      queuedItems: 1,
    }),
    "dispatching",
  );
  assert.equal(
    getTelegramStatusBarProcessingStatus({
      hasActiveTurn: false,
      hasPendingDispatch: false,
      hasPendingModelSwitch: false,
      activeToolExecutions: 0,
      queuedItems: 1,
    }),
    "queued",
  );
});

test("Bridge status runtime excludes active work from the waiting count", () => {
  const events: string[] = [];
  const runtime = createTelegramBridgeStatusRuntime({
    getConfig: () => ({
      botToken: "token",
      botUsername: "demo_bot",
      allowedUserId: 7,
    }),
    isPollingActive: () => true,
    getActiveSourceMessageIds: () => undefined,
    hasActiveTurn: () => false,
    hasDispatchPending: () => false,
    isCompactionInProgress: () => false,
    getActiveToolExecutions: () => 1,
    hasPendingModelSwitch: () => false,
    getQueuedItems: () => [{ queueLane: "default" as const }],
    getRecentRuntimeEvents: () => [],
  });
  runtime.updateStatus({
    ui: {
      theme: {
        fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
      },
      setStatus: (key: string, text: string) => {
        events.push(`${key}:${text}`);
      },
    },
  });
  assert.equal(
    events[0],
    "telegram:<accent>telegram</accent> <success>connected</success><warning> +1</warning>",
  );
});

test("Bridge status totals all waiting lanes in one yellow counter using Queue executability", () => {
  const prompt = (queueLane: Queue.TelegramQueueLane, extra: Partial<Queue.PendingTelegramTurn> = {}): Queue.PendingTelegramTurn => ({
    kind: "prompt", chatId: 1, replyToMessageId: 10, queueOrder: 1, laneOrder: 1, queueLane,
    statusSummary: "prompt", sourceMessageIds: [10], queuedAttachments: [],
    content: [{ type: "text", text: "prompt" }], historyText: "prompt", ...extra,
  });
  const normal = prompt("default"), priority = prompt("priority"), steer = prompt("steer");
  const frozen = prompt("steer", { steerAttempted: true });
  const pendingPacket = prompt("steer", { steerAttempted: true, steerPacketTail: [frozen] });
  const control: Queue.PendingTelegramControlItem = {
    kind: "control", queueLane: "control", queueOrder: 0, laneOrder: 0, chatId: 1,
    replyToMessageId: 9, statusSummary: "status", controlType: "status", execute: async () => {},
  };
  const cases: { items: Queue.TelegramQueueItem[]; pending?: boolean; suffix: string }[] = [
    { items: [], suffix: "" },
    { items: [normal, priority], suffix: "<warning> +2</warning>" },
    { items: [steer], suffix: "<warning> +1</warning>" },
    { items: [steer, priority, normal], suffix: "<warning> +3</warning>" },
    { items: [control, normal, steer], suffix: "<warning> +3</warning>" },
    { items: [normal, priority, steer], pending: true, suffix: "<warning> +2</warning>" },
    { items: [pendingPacket, frozen, normal, steer], pending: true, suffix: "<warning> +2</warning>" },
    { items: [prompt("default", { reactionSuppressionEmoji: "👎" }),
      prompt("priority", { reactionSuppressionEmoji: "👎" }),
      prompt("steer", { reactionSuppressionEmoji: "👎" }), frozen], suffix: "" },
  ];
  for (const { items, pending = false, suffix } of cases) {
    const before = JSON.stringify(items);
    let rendered = "";
    const runtime = createTelegramBridgeStatusRuntime({
      getConfig: () => ({ botToken: "token", allowedUserId: 7 }), isPollingActive: () => true,
      getActiveSourceMessageIds: () => [99], hasActiveTurn: () => true,
      hasDispatchPending: () => pending, isCompactionInProgress: () => true,
      getActiveToolExecutions: () => 1, hasPendingModelSwitch: () => false,
      getQueuedItems: () => items, getQueuedItemCount: Queue.countExecutableTelegramQueueItems,
      getRecentRuntimeEvents: () => [],
    });
    runtime.updateStatus({ ui: {
      theme: { fg: (token: string, text: string) => `<${token}>${text}</${token}>` },
      setStatus: (_key: string, text: string) => { rendered = text; },
    } });
    assert.equal(rendered, `<accent>telegram</accent> <success>connected</success>${suffix}`);
    assert.equal(JSON.stringify(items), before, "Status projection never mutates queued work");
  }
});

test("Persistent polling conflict remains visible across ordinary refreshes until transport recovers", () => {
  let stopReason: string | undefined = "persistent-conflict";
  let busRole: "follower" | undefined;
  let followerRegistered = false;
  const rendered: string[] = [];
  const runtime = createTelegramBridgeStatusRuntime({
    getConfig: () => ({ botToken: "token", allowedUserId: 7 }),
    isPollingActive: () => stopReason === undefined,
    getPollingState: () => ({ phase: stopReason ? "stopped" : "starting", stopReason }),
    getBusRole: () => busRole,
    getLocalBus: () => (busRole ? { followerRegistered } : undefined),
    getActiveSourceMessageIds: () => undefined, hasActiveTurn: () => false,
    hasDispatchPending: () => false, isCompactionInProgress: () => false,
    getActiveToolExecutions: () => 0, hasPendingModelSwitch: () => false,
    getQueuedItems: () => [], getRecentRuntimeEvents: () => [],
  });
  const ctx = { ui: {
    theme: { fg: (_token: string, text: string) => text },
    setStatus: (_key: string, text: string) => { rendered.push(text); },
  } };
  runtime.updateStatus(ctx);
  runtime.updateStatus(ctx);
  assert.deepEqual(rendered, ["telegram error", "telegram error"]);
  assert.ok(runtime.getStatusLines().some((line) => line.includes("persistent-conflict")));
  busRole = "follower";
  runtime.updateStatus(ctx);
  assert.equal(rendered.at(-1), "telegram reconnecting");
  followerRegistered = true;
  runtime.updateStatus(ctx);
  assert.equal(rendered.at(-1), "telegram follower");
  busRole = undefined;
  stopReason = undefined;
  runtime.updateStatus(ctx);
  assert.equal(rendered.at(-1), "telegram connected");
});

test("Bridge status runtime excludes skipped items from queued processing", () => {
  const events: string[] = [];
  const runtime = createTelegramBridgeStatusRuntime({
    getConfig: () => ({ botToken: "token", allowedUserId: 7 }),
    isPollingActive: () => true,
    getActiveSourceMessageIds: () => undefined,
    hasActiveTurn: () => false,
    hasDispatchPending: () => false,
    isCompactionInProgress: () => false,
    getActiveToolExecutions: () => 0,
    hasPendingModelSwitch: () => false,
    getQueuedItems: () => [{ queueLane: "default" as const }],
    getQueuedItemCount: () => 0,
    getRecentRuntimeEvents: () => [],
  });
  runtime.updateStatus({
    ui: {
      theme: {
        fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
      },
      setStatus: (key: string, text: string) => events.push(`${key}:${text}`),
    },
  });
  assert.equal(
    events[0],
    "telegram:<accent>telegram</accent> <success>connected</success>",
  );
});

test("Bridge status runtime builds status state from live ports", () => {
  const events: string[] = [];
  const runtime = createTelegramBridgeStatusRuntime({
    getConfig: () => ({
      botToken: "token",
      botUsername: "demo_bot",
      allowedUserId: 7,
      lastUpdateId: 99,
    }),
    getActiveProfileName: () => undefined,
    isPollingActive: () => true,
    getActiveSourceMessageIds: () => [1, 2],
    hasActiveTurn: () => false,
    hasDispatchPending: () => true,
    isCompactionInProgress: () => false,
    getActiveToolExecutions: () => 3,
    hasPendingModelSwitch: () => true,
    getQueuedItems: () => [{ queueLane: "control" as const }],
    getRecentRuntimeEvents: () => [
      { at: 1000, category: "api", message: "ok" },
    ],
    getRuntimeLockState: () => "active here",
  });
  runtime.updateStatus({
    ui: {
      theme: {
        fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
      },
      setStatus: (key: string, text: string) => {
        events.push(`${key}:${text}`);
      },
    },
  });
  assert.equal(
    events[0],
    "telegram:<accent>telegram</accent> <success>connected</success>",
  );
  assert.deepEqual(runtime.getStatusLines(), [
    "connection:",
    "- bot: @demo_bot",
    "- profile: default",
    "- user: 7",
    "- owner: active here",
    "",
    "health:",
    "- polling: running",
    "- state: pending dispatch",
    "- queued turns: 1 (control=1, priority=0, default=0)",
    "- active tools: 3",
    "- pending model switch: yes",
    "",
    "diagnostics:",
    "- state: ~/.pi/agent/tmp/pi-telegram/state.json",
    "- logs: ~/.pi/agent/tmp/pi-telegram/logs.jsonl",
    "- full dump: /telegram-status --debug",
  ]);
});

test("Bridge status lines retain the named profile with shared diagnostic paths", () => {
  const lines = buildTelegramBridgeStatusLines({
    activeProfileName: "work",
    botUsername: "work_bot",
    pollingActive: false,
    pendingDispatch: false,
    compactionInProgress: false,
    activeToolExecutions: 0,
    pendingModelSwitch: false,
    queuedItems: [],
    recentRuntimeEvents: [],
  });
  assert.ok(lines.includes("- profile: work"));
  assert.ok(lines.includes("- state: ~/.pi/agent/tmp/pi-telegram/state.json"));
  assert.ok(lines.includes("- logs: ~/.pi/agent/tmp/pi-telegram/logs.jsonl"));
});

test("Bridge status lines distinguish unknown bot identity from missing config", () => {
  const base = {
    allowedUserId: 42,
    pollingActive: true,
    lastUpdateId: 100,
    pendingDispatch: false,
    compactionInProgress: false,
    activeToolExecutions: 0,
    pendingModelSwitch: false,
    queuedItems: [],
    recentRuntimeEvents: [],
  };
  assert.equal(
    buildTelegramBridgeStatusLines({ ...base, hasBotToken: true })[1],
    "- bot: unknown",
  );
  assert.equal(
    buildTelegramBridgeStatusLines({ ...base, hasBotToken: false })[1],
    "- bot: not configured",
  );
  assert.equal(
    buildTelegramBridgeStatusLines({
      ...base,
      hasBotToken: false,
      botTokenDiagnostic:
        "Telegram bot token environment variable WORK_BOT_TOKEN is not set.",
    })[1],
    "- bot: Telegram bot token environment variable WORK_BOT_TOKEN is not set.",
  );
});

test("Bridge status honors caller-resolved token availability and diagnostics", () => {
  const rendered: string[] = [];
  const runtime = createTelegramBridgeStatusRuntime({
    getConfig: () => ({
      botToken: "$PI_TELEGRAM_TEST_MISSING_TOKEN",
      botHasToken: false,
      botTokenDiagnostic:
        "Telegram bot token environment variable PI_TELEGRAM_TEST_MISSING_TOKEN is not set.",
    }),
    isPollingActive: () => false,
    getActiveSourceMessageIds: () => undefined,
    hasActiveTurn: () => false,
    hasDispatchPending: () => false,
    isCompactionInProgress: () => false,
    getActiveToolExecutions: () => 0,
    hasPendingModelSwitch: () => false,
    getQueuedItems: () => [],
    getRecentRuntimeEvents: () => [],
  });
  runtime.updateStatus({
    ui: {
      theme: { fg: (_token: string, text: string) => text },
      setStatus: (_key: string, text: string) => {
        rendered.push(text);
      },
    },
  });
  assert.equal(rendered[0], "telegram not configured");
  assert.ok(
    runtime
      .getStatusLines()
      .includes(
        "- bot: Telegram bot token environment variable PI_TELEGRAM_TEST_MISSING_TOKEN is not set.",
      ),
  );
});

test("Bridge status falls back to raw token presence without a resolved flag", () => {
  const rendered: string[] = [];
  const runtime = createTelegramBridgeStatusRuntime({
    getConfig: () => ({ botToken: "123:abc" }),
    isPollingActive: () => true,
    getActiveSourceMessageIds: () => undefined,
    hasActiveTurn: () => false,
    hasDispatchPending: () => false,
    isCompactionInProgress: () => false,
    getActiveToolExecutions: () => 0,
    hasPendingModelSwitch: () => false,
    getQueuedItems: () => [],
    getRecentRuntimeEvents: () => [],
  });
  runtime.updateStatus({
    ui: {
      theme: { fg: (_token: string, text: string) => text },
      setStatus: (_key: string, text: string) => {
        rendered.push(text);
      },
    },
  });
  assert.equal(rendered[0], "telegram awaiting pairing");
});

test("Bridge status lines include role, instance, and protocol identity", () => {
  const state = {
    botUsername: "demo_bot",
    allowedUserId: 42,
    busRole: "leader" as const,
    busProtocol: {
      protocolVersion: 1,
      runtimeBuild: "0.28.0",
      capabilities: [],
    },
    instanceSlot: "A",
    instanceThreadName: "A-identity",
    pollingActive: true,
    lastUpdateId: 100,
    pendingDispatch: false,
    compactionInProgress: false,
    activeToolExecutions: 0,
    pendingModelSwitch: false,
    queuedItems: [],
    recentRuntimeEvents: [],
  };
  const lines = buildTelegramBridgeStatusLines(state);

  assert.deepEqual(lines.slice(0, 5), [
    "connection:",
    "- bot: @demo_bot",
    "- user: 42",
    "- role: leader",
    "- instance: A-identity",
  ]);
  assert.ok(
    buildTelegramBridgeStatusLines(state, { verbose: true }).includes(
      "- bus protocol=v1 build=0.28.0 capabilities=none",
    ),
  );
});

test("Bridge status lines include sync slice diagnostics", () => {
  const lines = buildTelegramBridgeStatusLines(
    {
      botUsername: "demo_bot",
      allowedUserId: 42,
      pollingActive: true,
      lastUpdateId: 100,
      pendingDispatch: false,
      compactionInProgress: false,
      activeToolExecutions: 0,
      pendingModelSwitch: false,
      queuedItems: [],
      syncState: {
        "topic-state": {
          status: "fresh",
          updatedAtMs: 2000,
          lastReconcileAction: "topic-lifecycle",
        },
        "transport-health": {
          status: "suspect",
          suspectAtMs: 3000,
          reason: "rate limited",
        },
      },
      recentRuntimeEvents: [],
    },
    { verbose: true },
  );
  assert.ok(lines.includes("sync:"));
  assert.ok(lines.includes("- topic-state: fresh reconcile=topic-lifecycle"));
  assert.ok(lines.includes("- transport-health: suspect reason=rate limited"));
});

test("Bridge status lines include bot thread capability diagnostics", () => {
  const lines = buildTelegramBridgeStatusLines(
    {
      botUsername: "demo_bot",
      allowedUserId: 42,
      botThreadMode: "disabled",
      botThreadModeAction: "thread-mode-unavailable",
      pollingActive: true,
      lastUpdateId: 100,
      pendingDispatch: false,
      compactionInProgress: false,
      activeToolExecutions: 0,
      pendingModelSwitch: false,
      queuedItems: [],
      recentRuntimeEvents: [],
    },
    { verbose: true },
  );
  assert.ok(
    lines.includes("- thread mode: disabled reconcile=thread-mode-unavailable"),
  );
});

test("Bridge status lines include topic binding diagnostics", () => {
  const lines = buildTelegramBridgeStatusLines(
    {
      botUsername: "demo_bot",
      allowedUserId: 42,
      pollingActive: true,
      lastUpdateId: 100,
      pendingDispatch: false,
      compactionInProgress: false,
      activeToolExecutions: 0,
      pendingModelSwitch: false,
      queuedItems: [],
      topicTargets: [
        {
          instanceId: "inst-a",
          status: "active",
          target: { chatId: 42, threadId: 10 },
          slot: "B",
          threadName: "Beacon",
          syncStatus: "open",
          lastSyncObservedAtMs: 1000,
          lastSyncProbeAtMs: 2000,
          lastReconcileAction: "leader-startup-probe",
        },
        {
          instanceId: "inst-a",
          status: "starting",
          target: { chatId: 42, threadId: 11 },
          slot: "C",
          threadName: "Cedar",
        },
        { instanceId: "inst-b", status: "offline", slot: "D" },
      ],
      threadReservations: [
        {
          instanceId: "old-leader",
          target: { chatId: 42, threadId: 9 },
          slot: "A",
          reason: "previous-process-still-probes-alive",
          lastReconcileAction: "leader-topic-previous-instance-still-live",
        },
      ],
      topicSyncObservations: [
        {
          instanceId: "closed-inst",
          target: { chatId: 42, threadId: 8 },
          slot: "D",
          syncStatus: "closed",
          observedAtMs: 3000,
          lastReconcileAction: "mark-stale",
        },
      ],
      recentRuntimeEvents: [],
    },
    { verbose: true },
  );
  assert.deepEqual(lines.slice(18, 21), [
    "topics:",
    "- active bindings: instances=1, targets=2",
    "- duplicate inst-a: 2 active threads Beacon target 42:10, Cedar target 42:11",
  ]);
  assert.ok(
    lines.includes(
      "- Beacon target 42:10 sync=open observed=1970-01-01T00:00:01.000Z probed=1970-01-01T00:00:02.000Z reconcile=leader-startup-probe",
    ),
  );
  assert.ok(lines.includes("- Cedar target 42:11"));
  assert.ok(
    lines.includes(
      "- reservation [A] target 42:9 reason=previous-process-still-probes-alive instance=old-leader reconcile=leader-topic-previous-instance-still-live",
    ),
  );
  assert.ok(
    lines.includes(
      "- sync [D] target 42:8 sync=closed observed=1970-01-01T00:00:03.000Z instance=closed-inst reconcile=mark-stale",
    ),
  );
});

test("Bridge status lines include bus follower diagnostics when present", () => {
  const lines = buildTelegramBridgeStatusLines(
    {
      botUsername: "demo_bot",
      allowedUserId: 42,
      pollingActive: true,
      lastUpdateId: 100,
      pendingDispatch: false,
      compactionInProgress: false,
      activeToolExecutions: 0,
      pendingModelSwitch: false,
      queuedItems: [],
      busNowMs: 20_000,
      busFollowers: [
        {
          instanceId: "inst-a",
          cwd: "/repo/a",
          lastHeartbeatMs: 18_600,
          target: { chatId: -1007, threadId: 42 },
          protocol: {
            protocolVersion: 1,
            runtimeBuild: "0.28.1",
            capabilities: [],
          },
          threadName: "Ember",
        },
        { instanceId: "inst-b", lastHeartbeatMs: 12_000 },
      ],
      recentRuntimeEvents: [],
    },
    { verbose: true },
  );
  assert.deepEqual(lines.slice(19, 24), [
    "bus:",
    "- followers: 2",
    "- inst-a: Ember heartbeat 1s ago target -1007:42 /repo/a protocol=v1 build=0.28.1 capabilities=none",
    "- inst-b: heartbeat 8s ago",
    "",
  ]);
});

test("Bridge status lines include local bus diagnostics", () => {
  const lines = buildTelegramBridgeStatusLines(
    {
      botUsername: "demo_bot",
      allowedUserId: 42,
      pollingActive: false,
      pendingDispatch: false,
      compactionInProgress: false,
      activeToolExecutions: 0,
      pendingModelSwitch: false,
      queuedItems: [],
      localBus: {
        leaderSocketPath: "\\\\.\\pipe\\pi-telegram-demo-bus",
        leaderTransport: "pipe",
        followerSocketPath: "\\\\.\\pipe\\pi-telegram-demo-follower",
        followerTransport: "pipe",
        followerRegistered: true,
        followerTarget: { chatId: 42, threadId: 9 },
        followerThreadName: "Boreal",
        leaderProtocol: {
          protocolVersion: 1,
          runtimeBuild: "0.28.0",
          capabilities: ["durable-follower-admission-v1"],
        },
      },
      recentRuntimeEvents: [],
    },
    { verbose: true },
  );
  assert.ok(lines.includes("local bus:"));
  assert.ok(
    lines.includes(
      "- follower registered: yes Boreal target 42:9 protocol=v1 build=0.28.0 capabilities=durable-follower-admission-v1",
    ),
  );
  assert.ok(
    lines.includes(
      "- leader endpoint [pipe]: \\\\.\\pipe\\pi-telegram-demo-bus",
    ),
  );
  assert.ok(
    lines.includes(
      "- follower endpoint [pipe]: \\\\.\\pipe\\pi-telegram-demo-follower",
    ),
  );
});

test("Bridge status counts Steer without changing legacy empty-lane copy", () => {
  const state = {
    pollingActive: false, pendingDispatch: false, compactionInProgress: false,
    activeToolExecutions: 0, pendingModelSwitch: false,
    queuedItems: [{ queueLane: "steer" as const }, { queueLane: "priority" as const }],
    recentRuntimeEvents: [],
  };
  assert.ok(buildTelegramBridgeStatusLines(state).includes(
    "- queued turns: 2 (control=0, steer=1, priority=1, default=0)"));
  assert.ok(buildTelegramBridgeStatusLines(state, { verbose: true }).includes(
    "- lanes: control=0, steer=1, priority=1, default=0"));
  assert.ok(!buildTelegramBridgeStatusLines({ ...state, queuedItems: [] }).join("\n").includes("steer="));
});

test("Bridge status lines include queue lanes and recent runtime events", () => {
  const lines = buildTelegramBridgeStatusLines(
    {
      botUsername: "demo_bot",
      allowedUserId: 42,
      pollingActive: true,
      lastUpdateId: 100,
      activeSourceMessageIds: [7, 8],
      pendingDispatch: true,
      compactionInProgress: false,
      activeToolExecutions: 2,
      pendingModelSwitch: true,
      queuedItems: [
        { queueLane: "control" },
        { queueLane: "priority" },
        { queueLane: "default" },
        { queueLane: "default" },
      ],
      recentRuntimeEvents: [
        { at: 1, category: "api:sendMessage", message: "rate limited" },
      ],
    },
    { verbose: true },
  );
  assert.deepEqual(lines, [
    "connection:",
    "- bot: @demo_bot",
    "- allowed user: 42",
    "",
    "polling:",
    "- state: running",
    "- last update id: 100",
    "",
    "execution:",
    "- active turn: 7,8",
    "- pending dispatch: yes",
    "- compaction: idle",
    "- active tools: 2",
    "- pending model switch: yes",
    "",
    "queue:",
    "- queued turns: 4",
    "- lanes: control=1, priority=1, default=2",
    "",
    "recent runtime events:",
    "- summary: api:sendMessage=1",
    "- 1970-01-01T00:00:00.001Z api:sendMessage: rate limited",
  ]);
});

test("Status HTML builder binds active model lookup", () => {
  const model = { provider: "openai", id: "gpt-5", contextWindow: 1000 };
  const buildStatusHtml = createTelegramStatusHtmlBuilder({
    getActiveModel: () => model,
  });
  const html = buildStatusHtml({
    sessionManager: { getEntries: () => [] },
    getContextUsage: () => ({ percent: 0, contextWindow: undefined }),
    isIdle: () => true,
    modelRegistry: { isUsingOAuth: () => false },
  });
  assert.match(html, /Status.*idle/s);
  assert.match(html, /Context.*0\.0%\/1\.0k/s);
  assert.doesNotMatch(html, /<b>Tokens:<\/b>/s);
});

test("Status HTML separates token and cache telemetry", () => {
  const buildStatusHtml = createTelegramStatusHtmlBuilder({
    getActiveModel: () => ({ contextWindow: 1000 }),
  });
  const html = buildStatusHtml({
    sessionManager: {
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: {
              input: 100,
              output: 20,
              cacheRead: 900,
              cacheWrite: 0,
              cost: { total: 0 },
            },
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            usage: {
              input: 150,
              output: 30,
              cacheRead: 800,
              cacheWrite: 50,
              cost: { total: 0 },
            },
          },
        },
      ],
    },
    getContextUsage: () => ({ percent: 10, contextWindow: 1000 }),
    isIdle: () => true,
    modelRegistry: { isUsingOAuth: () => false },
  });

  assert.match(
    html,
    /<b>Tokens:<\/b> <code>↑250 ↓50<\/code>\n<b>Cache:<\/b> <code>R1\.7k W50 CH80\.0%<\/code>\n<b>Context:<\/b>/s,
  );
});

test("Status HTML builder appends Threaded Mode bus role to status row", () => {
  const buildStatusHtml = createTelegramStatusHtmlBuilder({
    getActiveModel: () => undefined,
    getBridgeStatusLineState: () => ({
      hasBotToken: true,
      botThreadMode: "enabled",
      busRole: "leader",
      instanceThreadName: "Dune",
      pollingActive: true,
      pendingDispatch: false,
      compactionInProgress: false,
      activeToolExecutions: 0,
      pendingModelSwitch: false,
      queuedItems: [],
      recentRuntimeEvents: [],
    }),
  });
  const html = buildStatusHtml({
    sessionManager: { getEntries: () => [] },
    getContextUsage: () => ({ percent: 0, contextWindow: 1000 }),
    isIdle: () => true,
    modelRegistry: { isUsingOAuth: () => false },
  });
  assert.match(html, /<b>Status:<\/b> <code>idle @leader<\/code>/);
  assert.doesNotMatch(html, /<b>Thread:<\/b>/);
  assert.doesNotMatch(html, /Telegram/s);
});

test("Status HTML builder includes extension-provided status lines", () => {
  clearTelegramStatusLineProviders();
  const unregisterCodex = registerTelegramStatusLineProvider(
    ({ activeModel }) =>
      activeModel?.contextWindow === 1000
        ? { label: "codex", value: "████ 23.7h" }
        : undefined,
    { id: "@scope/codex" },
  );
  const unregisterBroken = registerTelegramStatusLineProvider(
    () => {
      throw new Error("optional provider failed");
    },
    { id: "@scope/broken" },
  );
  try {
    const buildStatusHtml = createTelegramStatusHtmlBuilder({
      getActiveModel: () => ({ contextWindow: 1000 }),
    });
    const html = buildStatusHtml({
      sessionManager: { getEntries: () => [] },
      getContextUsage: () => ({ percent: 0, contextWindow: undefined }),
      isIdle: () => true,
      modelRegistry: { isUsingOAuth: () => false },
    });
    assert.match(html, /Context.*0\.0%\/1\.0k/s);
    assert.match(html, /Codex.*████ 23\.7h/s);
  } finally {
    unregisterCodex();
    unregisterBroken();
    clearTelegramStatusLineProviders();
  }
});

test("Status HTML reports compaction before generic active state", () => {
  const buildStatusHtml = createTelegramStatusHtmlBuilder({
    getActiveModel: () => undefined,
    isCompactionInProgress: () => true,
  });
  const html = buildStatusHtml({
    sessionManager: { getEntries: () => [] },
    getContextUsage: () => ({ percent: 0, contextWindow: 1000 }),
    isIdle: () => false,
    hasPendingMessages: () => true,
    modelRegistry: { isUsingOAuth: () => false },
  });
  assert.match(html, /<b>Status:<\/b> <code>compacting<\/code>/u);
});

test("Runtime event lines render the recent-event ring newest first", () => {
  assert.deepEqual(buildTelegramRuntimeEventLines([]), [
    "recent runtime events: none",
  ]);
  assert.deepEqual(
    buildTelegramRuntimeEventLines([
      { at: 0, category: "poll", message: "started" },
      { at: 1000, category: "api:sendMessage", message: "rate limited" },
    ]),
    [
      "recent runtime events:",
      "- summary: api:sendMessage=1, poll=1",
      "- 1970-01-01T00:00:01.000Z api:sendMessage: rate limited",
      "- 1970-01-01T00:00:00.000Z poll: started",
    ],
  );
});

test("Structured runtime event recording redacts messages and details", () => {
  const events: TelegramRuntimeEvent[] = [];
  recordStructuredTelegramRuntimeEvent(
    events,
    {
      category: "api",
      error: new Error("token 123:abc failed"),
      details: { method: "sendMessage", token: "123:abc", retryable: true },
    },
    { botToken: "123:abc", maxEvents: 3, now: 1000 },
  );
  assert.deepEqual(events, [
    {
      at: 1000,
      category: "api",
      message: "token <redacted-token> failed",
      details: {
        method: "sendMessage",
        token: "<redacted-token>",
        retryable: true,
      },
    },
  ]);
  assert.deepEqual(buildTelegramRuntimeEventLines(events), [
    "recent runtime events:",
    "- summary: api:sendMessage=1",
    '- 1970-01-01T00:00:01.000Z api:sendMessage: token <redacted-token> failed (token="<redacted-token>", retryable=true)',
  ]);
});

test("Runtime event recording bounds messages and string details", () => {
  const events: TelegramRuntimeEvent[] = [];
  recordStructuredTelegramRuntimeEvent(
    events,
    {
      category: "handler",
      error: new Error("x".repeat(1200)),
      details: { output: "y".repeat(1200) },
    },
    { maxEvents: 3, now: 1000 },
  );

  assert.equal(events[0]?.message.length, 1023);
  assert.match(events[0]?.message ?? "", /truncated 200 chars/);
  assert.equal(String(events[0]?.details?.output).length, 1023);
  assert.match(String(events[0]?.details?.output), /truncated 200 chars/);
});

test("Runtime event recorder owns redacted bounded event state", () => {
  const recorder = createTelegramRuntimeEventRecorder({
    getBotToken: () => "123:abc",
    maxEvents: 1,
    now: () => 1000,
  });
  recorder.record("api", new Error("token 123:abc failed"), {
    method: "sendMessage",
  });
  recorder.record("poll", "ok");
  assert.deepEqual(recorder.getEvents(), [
    { at: 1000, category: "poll", message: "ok" },
  ]);
  recorder.clear();
  assert.deepEqual(recorder.getEvents(), []);
});

test("Runtime event recording redacts bot tokens and keeps a bounded ring", () => {
  const events: TelegramRuntimeEvent[] = [];
  recordStructuredTelegramRuntimeEvent(
    events,
    { category: "one", error: new Error("token 123:abc failed") },
    {
      botToken: "123:abc",
      maxEvents: 3,
      now: 1,
    },
  );
  assert.deepEqual(events, [
    { at: 1, category: "one", message: "token <redacted-token> failed" },
  ]);
  recordStructuredTelegramRuntimeEvent(
    events,
    { category: "two", error: "plain" },
    { botToken: "123:abc", maxEvents: 3, now: 2 },
  );
  recordStructuredTelegramRuntimeEvent(
    events,
    { category: "three", error: "last" },
    { botToken: "123:abc", maxEvents: 2, now: 3 },
  );
  assert.deepEqual(events, [
    { at: 2, category: "two", message: "plain" },
    { at: 3, category: "three", message: "last" },
  ]);
});

test("Status runtime skips the status bar when the host theme is uninitialized", () => {
  const events: string[] = [];
  const ctx = {
    ui: {
      get theme(): never {
        throw new Error("Theme not initialized. Call initTheme() first.");
      },
      setStatus: (key: string, text: string) => {
        events.push(`${key}:${text}`);
      },
    },
  };
  const runtime = createTelegramStatusRuntime({
    getStatusBarState: () => ({
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
    }),
    getBridgeStatusLineState: () => ({
      botUsername: undefined,
      allowedUserId: undefined,
      lockState: "active here",
      pollingActive: false,
      lastUpdateId: undefined,
      pendingDispatch: false,
      compactionInProgress: false,
      activeToolExecutions: 0,
      pendingModelSwitch: false,
      queuedItems: [],
      recentRuntimeEvents: [],
    }),
  });

  assert.doesNotThrow(() => runtime.updateStatus(ctx as never));
  assert.deepEqual(events, []);
});
