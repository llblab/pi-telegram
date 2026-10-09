/**
 * Regression tests for Telegram transport ownership helpers
 * Covers owners.json authority, stale-owner replacement, and owner-gated polling behavior
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { runNodeEval } from "./fixtures/node-eval.ts";
import { createTelegramJournalSourceSerialization, createTelegramUpdateJournalBindingRuntime } from "../lib/journal.ts";
import {
  resolveTelegramOwnersPath,
  resolveTelegramSessionsDir,
  resolveTelegramTempDir,
} from "../lib/paths.ts";
import { createTelegramSessionFolderSweeper } from "../lib/recovery.ts";
import {
  createTelegramLockedPollingRuntime,
  createTelegramLockKeyResolver,
  createTelegramLockRuntime,
  readLocks,
  readTelegramRuntimeState,
  resetDamagedTelegramRuntimeState,
  mutateTelegramRuntimeStateSection,
  type TelegramRuntimeStateSection,
  resolveTelegramLockKey,
  TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
  TELEGRAM_LOCK_KEY,
  TELEGRAM_OWNERSHIP_CHECK_MS,
  TELEGRAM_OWNERSHIP_CHECK_FAILURE_TOLERANCE,
  TELEGRAM_OWNERSHIP_REFRESH_MS,
  withTelegramFileTransaction,
  publishTelegramPrivateFile,
  readTelegramPrivateFile,
  TelegramPrivateFileError,
  writeLocks,
  type TelegramLockEntry,
  createTelegramLeaderJournalPathResolver,
  createTelegramOwnedStateAuthorityCapture,
} from "../lib/locks.ts";
import { createTelegramSessionContextStore } from "../lib/lifecycle.ts";

for (const change of ["replace-session", "same-context-restart", "clear", "release", "re-elect"] as const) {
  test(`Shared-state grant binds exact session generation and leader epoch (${change})`, () => {
    const dir = mkdtempSync(join(tmpdir(), "pt-state-grant-")), path = join(dir, "state.json");
    try {
      const lock = createTelegramLockRuntime<{ cwd: string }>({ statePath: path, instanceId: "grant-fixture", isProcessAlive: () => true });
      const sessions = createTelegramSessionContextStore<{ cwd: string }>(), capture = createTelegramOwnedStateAuthorityCapture(lock, sessions);
      assert.equal(capture(), undefined, "No session context means no shared-state grant");
      const ctx = { cwd: "/fixture" };
      sessions.set(ctx);
      assert.equal(capture(), undefined, "A session without exact ownership receives no grant");
      assert.equal(lock.acquire(ctx).ok, true);
      const epoch = lock.getOwnedLeaderEpoch(), grant = capture();
      assert.ok(grant);
      assert.equal(grant(), true);
      if (change === "replace-session") sessions.set({ cwd: "/fixture" });
      else if (change === "same-context-restart") { sessions.clear(ctx); sessions.set(ctx); }
      else if (change === "clear") sessions.clear(ctx);
      else if (change === "release") lock.release();
      else { lock.release(); assert.equal(lock.acquire(ctx).ok, true); }
      if (change !== "release" && change !== "re-elect") assert.equal(lock.getOwnedLeaderEpoch(), epoch, "Counterexample keeps the same leader epoch");
      assert.equal(grant(), false, "A captured grant never survives session, ownership or epoch replacement");
      const successor = capture();
      if (change === "clear" || change === "release") assert.equal(successor, undefined);
      else { assert.ok(successor); assert.equal(successor(), true, "The current session receives its own fresh grant"); assert.equal(grant(), false); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

function createTempLockPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-owners-"));
  return { dir, path: join(dir, "owners.json") };
}

test("Consolidated runtime state publishes only the selected section and profile", () => {
  const temp = createTempLockPath(), path = join(temp.dir, "state.json");
  const publish = (profile: string, section: TelegramRuntimeStateSection, value: unknown) =>
    mutateTelegramRuntimeStateSection(path, profile, section, () => ({ value, result: "published" }), { isCurrent: () => true });
  try {
    assert.deepEqual(readTelegramRuntimeState(path), { version: 2, profiles: {} });
    assert.equal(existsSync(path), false, "An observational read never creates state");
    publish("default", "transport", { leaderEpoch: "a", journalPath: "/sessions/owner/inbox.json" });
    publish("default", "workspace", { binding: { sessionId: "s", threadId: 55 }, restoreIssued: true });
    publish("other", "admission", { leases: [{ operationId: "busy" }], fence: "deletion-issued" });
    const before = readTelegramRuntimeState(path);
    mutateTelegramRuntimeStateSection(path, "default", "runtime", (_, observed) => {
      (observed.transport as { leaderEpoch: string }).leaderEpoch = "forged";
      return { value: { polling: true }, result: 42 };
    }, { isCurrent: () => true });
    const after = readTelegramRuntimeState(path);
    assert.deepEqual(after.profiles.default?.transport, before.profiles.default?.transport, "Sibling mutation of an observed copy is not authority");
    assert.deepEqual(after.profiles.default?.workspace, before.profiles.default?.workspace);
    assert.deepEqual(after.profiles.other, before.profiles.other);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o077, 0);
    const stableBytes = readFileSync(path, "utf8"), stableIdentity = statSync(path);
    assert.equal(publish("default", "runtime", { polling: true }), "published");
    assert.equal(readFileSync(path, "utf8"), stableBytes);
    assert.equal(statSync(path).ino, stableIdentity.ino, "No-op does not replace the shared file");
    publish("default", "runtime", undefined);
    assert.deepEqual(readTelegramRuntimeState(path), before, "Removing diagnostics leaves every durable fact untouched");
    publish("__proto__", "runtime", { polling: false });
    assert.equal(Object.hasOwn(readTelegramRuntimeState(path).profiles, "__proto__"), true, "Profile names cannot mutate object prototypes");
    assert.deepEqual(readdirSync(temp.dir).sort(), ["runtime", "state.json"], "Staging and guards stay below runtime");
    assert.deepEqual(readdirSync(join(temp.dir, "runtime")), []);
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

for (const boundary of ["before-mutation", "after-mutation", "before-write", "after-write-before-rename", "after-rename"] as const) {
  test(`Consolidated runtime state fences lost authority without undoing published facts (${boundary})`, () => {
    const temp = createTempLockPath(), path = join(temp.dir, "state.json");
    try {
      mutateTelegramRuntimeStateSection(path, "default", "workspace", () => ({ value: { binding: 55 }, result: true }), { isCurrent: () => true });
      const before = readFileSync(path, "utf8");
      let current = boundary !== "before-mutation", ran = false;
      assert.throws(() => mutateTelegramRuntimeStateSection(path, "default", "workspace", () => {
        ran = true;
        if (boundary === "after-mutation") current = false;
        return { value: { binding: 66, forwardIssued: true }, result: true };
      }, { isCurrent: () => current, onPublicationBoundary(at) { if (at === boundary) current = false; } }), /authority changed|outcome is unknown/);
      assert.equal(ran, boundary !== "before-mutation");
      if (boundary === "after-rename") assert.deepEqual(readTelegramRuntimeState(path).profiles.default?.workspace, { binding: 66, forwardIssued: true });
      else assert.equal(readFileSync(path, "utf8"), before);
      assert.deepEqual(readdirSync(join(temp.dir, "runtime")), [], "Fault cleanup never leaves an authoritative guard or temporary snapshot");
    } finally { rmSync(temp.dir, { recursive: true, force: true }); }
  });
}

for (const code of ["EPERM", "EACCES", "EBUSY"] as const) for (const revoked of [false, true]) {
  test(`Runtime publication sharing retry respects its grant (${code}, revoked=${revoked})`, () => {
    const temp = createTempLockPath(), path = join(temp.dir, "state.json");
    try {
      mutateTelegramRuntimeStateSection(path, "default", "workspace", () => ({ value: { binding: 55 }, result: true }), { isCurrent: () => true });
      const before = readFileSync(path, "utf8");
      let current = true, attempts = 0, stagedPath: unknown;
      const publish = () => mutateTelegramRuntimeStateSection(path, "default", "workspace", () => ({ value: { binding: 66 }, result: true }), {
        isCurrent: () => current,
        publishRename(from, to) {
          attempts++;
          if (attempts === 1) {
            stagedPath = from;
            current = !revoked;
            throw Object.assign(new Error("Temporary publication sharing conflict"), { code });
          }
          assert.equal(from, stagedPath, "A sharing retry reuses the same complete candidate");
          renameSync(from, to);
        },
      });
      if (revoked) {
        assert.throws(publish, /outcome is unknown|authority changed/);
        assert.equal(readFileSync(path, "utf8"), before, "Revoked publication cannot overwrite retained state");
      } else {
        assert.equal(publish(), true);
        assert.deepEqual(readTelegramRuntimeState(path).profiles.default?.workspace, { binding: 66 });
      }
      assert.equal(attempts, revoked ? 1 : 2, "A sharing retry must revalidate authority before another rename");
      assert.deepEqual(readdirSync(join(temp.dir, "runtime")), [], "The guard and staged candidate are released");
    } finally { rmSync(temp.dir, { recursive: true, force: true }); }
  });
}

for (const malformed of ["{", "null", "[]", '{"version":1,"threads":[]}', '{"version":3,"profiles":{}}',
  '{"version":2,"profiles":[]}', '{"version":2,"profiles":{"default":[]}}', '{"version":2,"profiles":{"default":{"unknown":1}}}']) {
  test(`Consolidated runtime state never repairs or silently adopts a rejected envelope (${malformed})`, () => {
    const temp = createTempLockPath(), path = join(temp.dir, "state.json");
    try {
      writeFileSync(path, malformed, { mode: 0o600 });
      assert.throws(() => readTelegramRuntimeState(path));
      assert.throws(() => mutateTelegramRuntimeStateSection(path, "default", "runtime", () => ({ value: {}, result: true }), { isCurrent: () => true }));
      assert.equal(readFileSync(path, "utf8"), malformed);
      assert.deepEqual(readdirSync(temp.dir).sort(), ["runtime", "state.json"]);
    } finally { rmSync(temp.dir, { recursive: true, force: true }); }
  });
}

for (const damaged of ["{", "null", '{"version":3,"profiles":{}}', '{"version":2,"profiles":{"default":{"unknown":1}}}',
  '{"version":2,"profiles":{"default":{"transport":{"pid":"wrong"}}}}', "invalid-workspace"]) {
  test(`Damaged runtime state is reset to an empty envelope before leadership (${damaged})`, async () => {
    const temp = createTempLockPath(), path = join(temp.dir, "state.json");
    const events: string[] = [];
    try {
      const validator = (_profile: string, sections: { workspace?: unknown }) => {
        if (sections.workspace === "broken") throw new Error("fixture invalid workspace");
      };
      writeFileSync(path, damaged === "invalid-workspace"
        ? JSON.stringify({ version: 2, profiles: { work: { workspace: "broken" } } }) : damaged, { mode: 0o600 });
      const runtime = createTelegramLockedPollingRuntime({
        lock: createTelegramLockRuntime({ statePath: path, pid: process.pid, instanceId: "reset" }),
        resetDamagedState: () => resetDamagedTelegramRuntimeState(path, validator),
        hasBotToken: () => true, startPolling: async () => undefined, stopPolling: async () => undefined, updateStatus: () => undefined,
        recordRuntimeEvent: (_category, _error, details) => { events.push(String(details?.phase)); },
      });
      assert.equal((await runtime.start({ cwd: "/repo" })).ok, true, "connect proceeds after an optimistic reset");
      assert.deepEqual(events, ["state-reset"]);
      const state = readTelegramRuntimeState(path);
      assert.deepEqual(Object.keys(state.profiles), [TELEGRAM_LOCK_KEY], "only the new owner is published");
      if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(temp.dir).sort(), ["runtime", "state.json"]);
      await runtime.stop();
      assert.equal(resetDamagedTelegramRuntimeState(path, validator), false, "healthy state is never reset");
    } finally { rmSync(temp.dir, { recursive: true, force: true }); }
  });
}

test("Healthy runtime state is never reset and elections never reset", async () => {
  const temp = createTempLockPath(), path = join(temp.dir, "state.json");
  try {
    mutateTelegramRuntimeStateSection(path, "work", "runtime", () => ({ value: { kept: true }, result: true }), { isCurrent: () => true });
    const before = readFileSync(path, "utf8");
    assert.equal(resetDamagedTelegramRuntimeState(path), false);
    assert.equal(readFileSync(path, "utf8"), before);
    writeFileSync(path, "{", { mode: 0o600 });
    let resets = 0;
    const runtime = createTelegramLockedPollingRuntime({
      lock: createTelegramLockRuntime({ statePath: path, pid: process.pid, instanceId: "election" }),
      resetDamagedState: () => { resets++; return resetDamagedTelegramRuntimeState(path); },
      hasBotToken: () => true, startPolling: async () => undefined, stopPolling: async () => undefined, updateStatus: () => undefined,
    });
    await assert.rejects(runtime.start({ cwd: "/repo" }, { election: {} }));
    assert.equal(resets, 0, "a follower election never resets shared state");
    assert.equal(readFileSync(path, "utf8"), "{");
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

test("Consolidated runtime state refuses nested publication and retains a rename with a lost acknowledgement", () => {
  const temp = createTempLockPath(), path = join(temp.dir, "state.json");
  const mutate = () => ({ value: { issued: true }, result: true });
  try {
    assert.throws(() => mutateTelegramRuntimeStateSection(path, "default", "workspace", () => {
      mutateTelegramRuntimeStateSection(path, "default", "admission", mutate, { isCurrent: () => true });
      return mutate();
    }, { isCurrent: () => true }), /Nested/);
    assert.equal(existsSync(path), false);
    assert.throws(() => mutateTelegramRuntimeStateSection(path, "default", "workspace", mutate, {
      isCurrent: () => true, publishRename(from, to) { renameSync(from, to); throw new Error("Lost publication ACK"); },
    }), /outcome is unknown/);
    assert.deepEqual(readTelegramRuntimeState(path).profiles.default?.workspace, { issued: true }, "Uncertain publication is not rollback or replay authority");
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

test("Consolidated runtime state serializes competing processes without losing sibling facts", async () => {
  const temp = createTempLockPath(), path = join(temp.dir, "state.json");
  try {
    mutateTelegramRuntimeStateSection(path, "other", "admission", () => ({ value: { leases: ["keep"] }, result: true }), { isCurrent: () => true });
    const moduleUrl = new URL("../lib/locks.ts", import.meta.url).href;
    const source = `
      import { mutateTelegramRuntimeStateSection } from ${JSON.stringify(moduleUrl)};
      for (let n = 0; n < 40; n++) mutateTelegramRuntimeStateSection(process.env.STATE_PATH, "default", process.env.SECTION,
        current => ({ value: { count: (current?.count ?? 0) + 1 }, result: true }), { isCurrent: () => true });
    `;
    const children = await Promise.all(["workspace", "runtime"].map(section => runNodeEval(source, { env: { STATE_PATH: path, SECTION: section } })));
    for (const child of children) assert.equal(child.code, 0, child.stderr);
    const file = readTelegramRuntimeState(path);
    assert.deepEqual(file.profiles.default, { workspace: { count: 40 }, runtime: { count: 40 } });
    assert.deepEqual(file.profiles.other?.admission, { leases: ["keep"] });
    assert.deepEqual(readdirSync(join(temp.dir, "runtime")), []);
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

test("Consolidated transport lifecycle preserves custody, other sections and other profiles", () => {
  const temp = createTempLockPath(), path = join(temp.dir, "state.json");
  let now = 1000, journalCreations = 0;
  const owner = createTelegramLockRuntime({ statePath: path, instanceId: "one", pid: 10, runtimeGeneration: 1,
    getNowMs: () => now, mintLeaderEpoch: () => "epoch-one", isProcessAlive: () => true,
    createJournalPath: () => `/sessions/owner/inbox.json#${++journalCreations}` });
  try {
    mutateTelegramRuntimeStateSection(path, "default", "workspace", () => ({ value: { binding: 55, restoreIssued: true }, result: true }), { isCurrent: () => true });
    mutateTelegramRuntimeStateSection(path, "other", "admission", () => ({ value: { leases: ["keep"], deletionIssued: true }, result: true }), { isCurrent: () => true });
    const before = readTelegramRuntimeState(path);
    assert.equal(owner.acquire({ cwd: "/repo" }).ok, true);
    assert.equal(owner.owns({ cwd: "/repo" }), true);
    assert.equal(owner.getOwnedLeaderEpoch(), "epoch-one");
    now += 2000;
    assert.equal(owner.refresh({ cwd: "/repo" }), true);
    let committed = 0;
    assert.equal(owner.commitIfOwned(() => { committed++; }), true);
    assert.equal(committed, 1);
    assert.equal(owner.publishStateSectionIfOwned!("runtime", () => ({ value: { polling: true }, result: "saved" }), { isCurrent: () => true }).committed, true);
    owner.release();
    assert.equal(owner.owns(), false);
    assert.equal(owner.getState().kind, "inactive");
    assert.deepEqual(readTelegramRuntimeState(path).profiles.default?.transport, { journalPath: "/sessions/owner/inbox.json#1" });
    assert.deepEqual(readTelegramRuntimeState(path).profiles.default?.workspace, before.profiles.default?.workspace);
    assert.deepEqual(readTelegramRuntimeState(path).profiles.other, before.profiles.other);
    const successor = createTelegramLockRuntime({ statePath: path, instanceId: "two", pid: 20, runtimeGeneration: 2,
      isProcessAlive: () => true, createJournalPath: () => { journalCreations++; return "/sessions/new/inbox.json"; } });
    assert.equal(successor.acquire({ cwd: "/new" }).ok, true);
    assert.equal(successor.getJournalPath(), "/sessions/owner/inbox.json#1");
    assert.equal(journalCreations, 1, "Ownership transfer never creates a second polling journal");
    assert.deepEqual(readdirSync(temp.dir).sort(), ["runtime", "state.json"]);
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

test("Consolidated transport profile drift refuses publication and never redirects the selected section", () => {
  const temp = createTempLockPath(), path = join(temp.dir, "state.json");
  let profile = "default";
  const owner = createTelegramLockRuntime({ statePath: path, key: () => profile, instanceId: "owner", pid: 10,
    statePublication: { onPublicationBoundary(at) { if (at === "after-write-before-rename") profile = "other"; } } });
  try {
    mutateTelegramRuntimeStateSection(path, "default", "workspace", () => ({ value: { binding: 55 }, result: true }), { isCurrent: () => true });
    mutateTelegramRuntimeStateSection(path, "other", "transport", () => ({ value: { pid: 20, instanceId: "other" }, result: true }), { isCurrent: () => true });
    const before = readFileSync(path, "utf8");
    assert.throws(() => owner.acquire({ cwd: "/repo" }), /authority changed/);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(owner.owns(), false);
    profile = "default";
    assert.equal(owner.owns(), false, "Restoring the profile cannot invent a missing published owner");
    assert.equal(owner.getState().kind, "inactive");
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

test("Consolidated transport same-PID replacement fences old refresh, commit and section publication", () => {
  const temp = createTempLockPath(), path = join(temp.dir, "state.json");
  const first = createTelegramLockRuntime({ statePath: path, instanceId: "old", pid: 10, runtimeGeneration: 1 });
  const next = createTelegramLockRuntime({ statePath: path, instanceId: "new", pid: 10, runtimeGeneration: 2 });
  try {
    const acquired = first.acquire({ cwd: "/repo" });
    assert.equal(acquired.ok, true);
    assert.equal(next.acquire({ cwd: "/repo" }).ok, false, "Same PID does not grant force takeover");
    assert.equal(next.acquire({ cwd: "/repo" }, { force: true, expectedOwner: acquired.ok ? acquired.lock : undefined }).ok, true);
    const before = readFileSync(path, "utf8");
    let callbacks = 0;
    assert.equal(first.commitIfOwned(() => { callbacks++; }), false);
    assert.deepEqual(first.publishStateSectionIfOwned!("workspace", () => { callbacks++; return { value: {}, result: true }; }, { isCurrent: () => true }), { committed: false });
    assert.equal(first.refresh(), false);
    first.release();
    assert.equal(callbacks, 0);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(next.owns(), true);
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

for (const boundary of ["after-write-before-rename", "after-rename"] as const) {
  test(`Consolidated transport refuses stale section ACK after source-generation loss (${boundary})`, () => {
    const temp = createTempLockPath(), path = join(temp.dir, "state.json");
    const owner = createTelegramLockRuntime({ statePath: path, instanceId: "owner", pid: 10 });
    try {
      owner.acquire({ cwd: "/repo" });
      let current = true;
      const before = readFileSync(path, "utf8");
      assert.throws(() => owner.publishStateSectionIfOwned!("workspace", () => ({ value: { forwardIssued: true }, result: true }), {
        isCurrent: () => current, onPublicationBoundary(at) { if (at === boundary) current = false; },
      }), /authority changed|outcome is unknown/);
      if (boundary === "after-rename") assert.deepEqual(readTelegramRuntimeState(path).profiles.default?.workspace, { forwardIssued: true });
      else assert.equal(readFileSync(path, "utf8"), before);
    } finally { rmSync(temp.dir, { recursive: true, force: true }); }
  });
}

for (const boundary of ["after-write-before-rename", "after-rename"] as const) {
  test(`Consolidated transport preserves replacement-owner facts at the section publication boundary (${boundary})`, () => {
    const temp = createTempLockPath(), path = join(temp.dir, "state.json");
    const owner = createTelegramLockRuntime({ statePath: path, instanceId: "owner", pid: 10 });
    try {
      owner.acquire({ cwd: "/repo" });
      assert.throws(() => owner.publishStateSectionIfOwned!("workspace", () => ({ value: { forwardIssued: true }, result: true }), {
        isCurrent: () => true, onPublicationBoundary(at) {
          if (at !== boundary) return;
          const file = readTelegramRuntimeState(path);
          file.profiles.default!.transport = { pid: 20, instanceId: "replacement", leaderEpoch: "new", runtimeGeneration: 2 };
          writeFileSync(path, JSON.stringify(file), { mode: 0o600 });
        },
      }), /authority changed|outcome is unknown/);
      const file = readTelegramRuntimeState(path);
      assert.equal((file.profiles.default?.transport as { pid: number }).pid, 20);
      assert.equal(owner.owns(), false);
      assert.deepEqual(file.profiles.default?.workspace, boundary === "after-rename" ? { forwardIssued: true } : undefined);
    } finally { rmSync(temp.dir, { recursive: true, force: true }); }
  });
}

test("Consolidated transport external-file commit retains its effect without a stale positive ACK", () => {
  const temp = createTempLockPath(), path = join(temp.dir, "state.json");
  const owner = createTelegramLockRuntime({ statePath: path, instanceId: "owner", pid: 10 });
  try {
    owner.acquire({ cwd: "/repo" });
    let effect = 0;
    assert.equal(owner.commitIfOwned(() => {
      effect++;
      const file = readTelegramRuntimeState(path);
      file.profiles.default!.transport = { pid: 20, instanceId: "replacement" };
      writeFileSync(path, JSON.stringify(file), { mode: 0o600 });
    }), false);
    assert.equal(effect, 1, "Committed external effect is not rolled back or replayed");
    assert.equal((readTelegramRuntimeState(path).profiles.default?.transport as { pid: number }).pid, 20);
    assert.equal(owner.commitIfOwned(() => { effect++; }), false);
    assert.equal(effect, 1);
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

test("Consolidated transport rejects nested root publication rather than borrowing owner authority", () => {
  const temp = createTempLockPath(), path = join(temp.dir, "state.json");
  const owner = createTelegramLockRuntime({ statePath: path, instanceId: "owner", pid: 10 });
  try {
    owner.acquire({ cwd: "/repo" });
    const before = readFileSync(path, "utf8");
    assert.throws(() => owner.publishStateSectionIfOwned!("transport" as "workspace", () => ({ value: { pid: 99 }, result: true }),
      { isCurrent: () => true }), /restricted/);
    assert.throws(() => owner.commitIfOwned(() => owner.publishStateSectionIfOwned!("workspace",
      () => ({ value: { binding: 55 }, result: true }), { isCurrent: () => true })), /Nested/);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(owner.publishStateSectionIfOwned!("workspace", () => ({ value: { binding: 55 }, result: true }),
      { isCurrent: () => true }).committed, true, "The direct owner-gated section publisher needs only one transaction");
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

for (const malformed of [null, [], {}, { pid: "wrong" }, { pid: 10, unexpected: true }, { pid: 10, heartbeatMs: -1 },
  { pid: 10, journalPath: "" }, { pid: 10, leaderEpoch: "" }]) {
  test(`Consolidated transport never replaces malformed ownership (${JSON.stringify(malformed)})`, () => {
    const temp = createTempLockPath(), path = join(temp.dir, "state.json");
    try {
      mutateTelegramRuntimeStateSection(path, "default", "transport", () => ({ value: malformed, result: true }), { isCurrent: () => true });
      const before = readFileSync(path, "utf8");
      const owner = createTelegramLockRuntime({ statePath: path, instanceId: "owner", pid: 10 });
      assert.equal(owner.owns(), false, "Read-only queries fail closed instead of throwing into Pi hooks");
      assert.equal(owner.getState().kind, "inactive");
      assert.throws(() => owner.acquire({ cwd: "/repo" }), /transport is malformed/);
      assert.equal(readFileSync(path, "utf8"), before);
    } finally { rmSync(temp.dir, { recursive: true, force: true }); }
  });
}

for (const predecessor of ["live", "malformed", "foreign-envelope", "malformed-record"] as const) {
  test(`Consolidated transport reads legacy ownership protectively without adopting it (${predecessor})`, () => {
    const temp = createTempLockPath(), path = join(temp.dir, "state.json");
    try {
      const source = predecessor === "live" ? JSON.stringify({ default: { pid: 77, instanceId: "old", heartbeatMs: 1000, busSecret: "never-adopt" } }) :
        predecessor === "foreign-envelope" ? JSON.stringify({ version: 2, profiles: {} }) :
        predecessor === "malformed-record" ? JSON.stringify({ unrelated: { pid: "unknown" } }) : "{";
      writeFileSync(temp.path, source, { mode: 0o600 });
      const before = readFileSync(temp.path, "utf8");
      const owner = createTelegramLockRuntime({ statePath: path, legacyLocksPath: temp.path, instanceId: "owner", pid: 10,
        getNowMs: () => 1000, staleHeartbeatMs: 8000, isProcessAlive: () => true });
      if (predecessor === "live") {
        const result = owner.acquire({ cwd: "/repo" });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.lock.busSecret, undefined);
      } else assert.throws(() => owner.acquire({ cwd: "/repo" }));
      assert.equal(existsSync(path), false);
      assert.equal(readFileSync(temp.path, "utf8"), before, "The older release file is never modified or adopted");
    } finally { rmSync(temp.dir, { recursive: true, force: true }); }
  });
}

test("Consolidated transport acquisition has one cross-process winner in the shared state", async () => {
  const temp = createTempLockPath(), path = join(temp.dir, "state.json");
  try {
    mutateTelegramRuntimeStateSection(path, "default", "workspace", () => ({ value: { binding: 55 }, result: true }), { isCurrent: () => true });
    const startPath = join(temp.dir, "start"), children = [0, 1].map(index => {
      const readyPath = join(temp.dir, `ready-${index}`);
      return { readyPath, child: spawnLockRaceChild({ locksPath: temp.path, statePath: path, key: "default", readyPath, startPath }) };
    });
    await waitForCondition(() => children.every(child => existsSync(child.readyPath)), 2000);
    writeFileSync(startPath, "start");
    const results = await Promise.all(children.map(child => child.child.result));
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.deepEqual(readTelegramRuntimeState(path).profiles.default?.workspace, { binding: 55 });
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (predicate()) return;
  assert.fail("Timed out waiting for condition");
}

interface LockRaceChild {
  result: Promise<{ ok: boolean; pid?: number }>;
}

function spawnLockRaceChild(input: {
  locksPath: string;
  statePath?: string;
  key: string;
  readyPath: string;
  startPath: string;
}): LockRaceChild {
  const moduleUrl = new URL("../lib/locks.ts", import.meta.url).href;
  const source = `
    import { existsSync, writeFileSync } from "node:fs";
    import { createTelegramLockRuntime } from ${JSON.stringify(moduleUrl)};
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    writeFileSync(process.env.READY_PATH, "ready");
    while (!existsSync(process.env.START_PATH)) sleep(2);
    const lock = createTelegramLockRuntime({
      ...(process.env.STATE_PATH ? { statePath: process.env.STATE_PATH } : { locksPath: process.env.LOCKS_PATH }),
      key: process.env.LOCK_KEY,
    });
    const acquired = lock.acquire({ cwd: "/race" });
    process.stdout.write(JSON.stringify({ ok: acquired.ok, pid: acquired.ok ? acquired.lock.pid : undefined }));
    if (acquired.ok) sleep(300);
  `;
  const result = runNodeEval(source, {
    env: {
      LOCKS_PATH: input.locksPath,
      STATE_PATH: input.statePath ?? "",
      LOCK_KEY: input.key,
      READY_PATH: input.readyPath,
      START_PATH: input.startPath,
    },
  }).then(({ code, stdout, stderr }) => {
    if (code !== 0) throw new Error(`Lock race child exited ${code}: ${stderr}`);
    return JSON.parse(stdout) as { ok: boolean; pid?: number };
  });
  return { result };
}

test("Polling journal pointer survives release and is inherited by every successor", () => {
  const temp = createTempLockPath();
  try {
    let created = 0;
    const create = (name: string) => createTelegramLockRuntime({ locksPath: temp.path, instanceId: name,
      pid: name === "first" ? 101 : 202, isProcessAlive: () => true,
      createJournalPath: () => `/runtime/sessions/${name}/inbox.json#${++created}` });
    const first = create("first");
    assert.equal(first.getJournalPath(), undefined);
    const acquired = first.acquire({ cwd: "/a" });
    assert.equal(acquired.ok && acquired.lock.journalPath, "/runtime/sessions/first/inbox.json#1");
    assert.equal(first.refresh({ cwd: "/a" }), true);
    assert.equal(first.getJournalPath(), "/runtime/sessions/first/inbox.json#1", "Refresh keeps custody");
    first.release();
    const released = JSON.parse(readFileSync(temp.path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.values(released), [{ journalPath: "/runtime/sessions/first/inbox.json#1" }],
      "Release keeps only the pointer");
    const successor = create("successor");
    assert.equal(successor.getState().kind, "inactive", "A pointer is not an owner");
    const next = successor.acquire({ cwd: "/b" });
    assert.equal(next.ok && next.lock.journalPath, "/runtime/sessions/first/inbox.json#1", "Successor continues the named journal");
    assert.equal(created, 1, "No new journal is created while one is named");
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Leader journal resolver prefers the owners pointer, then an existing root, then the hosting session", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-telegram-leader-path-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    let named: string | undefined, sessionId: string | undefined = "host";
    const resolver = createTelegramLeaderJournalPathResolver({ getNamedJournalPath: () => named,
      getSessionId: () => sessionId, getProfileName: () => "work" });
    const runtime = join(agentDir, "tmp", "pi-telegram");
    const own = join(runtime, "sessions", "host", "inbox.work.json");
    assert.equal(resolver.createJournalPath(), own);
    assert.equal(resolver.resolve("work"), own);
    named = join(runtime, "sessions", "former", "inbox.work.json");
    assert.equal(resolver.resolve("work"), named, "The owners pointer wins");
    named = join(agentDir, "elsewhere", "inbox.work.json");
    assert.equal(resolver.resolve("work"), own, "A pointer outside this runtime is ignored");
    named = undefined;
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, "inbox.work.json"), "{}");
    assert.equal(resolver.createJournalPath(), join(runtime, "inbox.work.json"), "Existing root custody is kept");
    rmSync(join(runtime, "inbox.work.json"));
    sessionId = undefined;
    assert.equal(resolver.resolve("work"), join(runtime, "inbox.work.json"), "Without a session, the flat fallback");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Leader succession continues the owners-named polling journal, cursor and pending custody", () => {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-telegram-leader-succession-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const journalSerialization = createTelegramJournalSourceSerialization(() => join(agentDir, "journals.transaction"));
    const createLeader = (sessionId: string, pid: number) => {
      let lock!: ReturnType<typeof createTelegramLockRuntime>;
      const path = createTelegramLeaderJournalPathResolver({ getNamedJournalPath: () => lock.getJournalPath(),
        getSessionId: () => sessionId, getProfileName: () => undefined });
      lock = createTelegramLockRuntime({ locksPath: resolveTelegramOwnersPath(), instanceId: `leader-${sessionId}`,
        pid, isProcessAlive: () => true, createJournalPath: path.createJournalPath });
      const journals = createTelegramUpdateJournalBindingRuntime({
        base: { getProfileName: () => undefined, getBotToken: () => "123:succession", getBotId: () => 123,
          withSourceSerialization: journalSerialization },
        getLeaderJournalPath: path.resolve, getRuntimeDir: () => resolveTelegramTempDir(agentDir),
        getFollowerJournalPath: () => { throw new Error("leader-only fixture"); },
        getActiveFollowerBindingKey: () => "unused", isFollowerRegistered: () => false,
      });
      return { lock, journals };
    };
    const a = createLeader("session-a", 101);
    assert.equal(a.lock.acquire({ cwd: "/a" }).ok, true);
    const hosted = a.journals.resolveLeader()!;
    hosted.journal.appendBatch([{ update_id: 41, message: { text: "unprocessed" } }], 41);
    assert.match(JSON.parse(hosted.runtimeKey).path, /sessions[\\/]session-a[\\/]inbox\.json$/u);
    a.lock.release();
    const swept = createTelegramSessionFolderSweeper({ getSessionsDir: () => resolveTelegramSessionsDir(agentDir),
      getProfileName: () => undefined, getKeptSessionIds: () => [] }).sweep();
    assert.deepEqual(swept, [], "The sweeper never deletes the polling journal or its hosting folder");
    const b = createLeader("session-b", 202);
    assert.equal(b.lock.acquire({ cwd: "/b" }).ok, true);
    const continued = b.journals.resolveLeader()!;
    assert.equal(continued.recoveryKey, hosted.recoveryKey, "Successor continues the same polling journal");
    const snapshot = continued.journal.read();
    assert.equal(snapshot.acceptedThroughUpdateId, 41, "Bot cursor continues");
    assert.deepEqual(snapshot.entries.map(entry => entry.updateId), [41], "Unprocessed custody continues");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("Lock runtime commits side effects only under its exact transaction owner", () => {
  const temp = createTempLockPath();
  try {
    const first = createTelegramLockRuntime({
      locksPath: temp.path,
      instanceId: "runtime:first",
    });
    const acquired = first.acquire({ cwd: "/repo" });
    assert.equal(acquired.ok, true);
    let commits = 0;
    assert.equal(
      first.commitIfOwned(() => {
        commits += 1;
      }),
      true,
    );

    const replacement = createTelegramLockRuntime({
      locksPath: temp.path,
      instanceId: "runtime:replacement",
    });
    const replaced = replacement.acquire(
      { cwd: "/repo" },
      {
        force: true,
        expectedOwner: acquired.ok ? acquired.lock : undefined,
      },
    );
    assert.equal(replaced.ok, true);
    assert.equal(
      first.commitIfOwned(() => {
        commits += 1;
      }),
      false,
    );
    assert.equal(
      replacement.commitIfOwned(() => {
        commits += 1;
      }),
      true,
    );
    assert.equal(commits, 2);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime acquires, refreshes, and releases its own key", () => {
  const temp = createTempLockPath();
  try {
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const acquired = lock.acquire({ cwd: "/repo" });
    assert.deepEqual(acquired, {
      ok: true,
      lock: { pid: 10, cwd: "/repo" },
      replacedStale: false,
    });
    assert.equal(lock.getStatusLabel(), "active here");
    assert.equal(lock.owns(), true);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
    });
    assert.equal(lock.release().kind, "active-here");
    assert.deepEqual(readLocks(temp.path), {});
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

for (const scenario of ["live", "dead", "stale-heartbeat", "other-key", "missing", "malformed", "same-path"] as const) {
  test(`A live fresh older-release owner blocks acquisition without exposing its bus (${scenario})`, () => {
    const current = createTempLockPath(), legacy = createTempLockPath();
    try {
      const entry = { pid: 77, cwd: "/older", instanceId: "77:1", heartbeatMs: scenario === "stale-heartbeat" ? 1_000 : 99_000,
        leaderEpoch: "epoch", busSocketPath: "/older/bus.sock", busSecret: "secret" };
      if (scenario === "malformed") writeFileSync(legacy.path, "{ not json");
      else if (scenario !== "missing") writeFileSync(legacy.path, JSON.stringify({ [scenario === "other-key" ? "work" : TELEGRAM_LOCK_KEY]: entry }));
      const legacyBytes = existsSync(legacy.path) ? readFileSync(legacy.path, "utf8") : undefined;
      const lock = createTelegramLockRuntime({ locksPath: current.path, legacyLocksPath: scenario === "same-path" ? current.path : legacy.path,
        pid: 10, getNowMs: () => 100_000, staleHeartbeatMs: 8_000, isProcessAlive: pid => scenario !== "dead" && pid === 77 });
      const acquired = lock.acquire({ cwd: "/repo" });
      if (scenario === "live") {
        assert.deepEqual(acquired, { ok: false, lock: { pid: 77, cwd: "/older", instanceId: "77:1", heartbeatMs: 99_000 } },
          "only identity is exposed: no socket, secret or epoch of another protocol");
        assert.deepEqual(readLocks(current.path), {}, "refusal publishes nothing in the new directory");
        assert.equal(lock.owns(), false);
        return;
      }
      assert.equal(acquired.ok, true);
      if (scenario !== "same-path") assert.equal(existsSync(legacy.path) ? readFileSync(legacy.path, "utf8") : undefined, legacyBytes,
        "the older file is only read, never modified");
    } finally {
      rmSync(current.dir, { recursive: true, force: true }); rmSync(legacy.dir, { recursive: true, force: true });
    }
  });
}

test("Owner slot resolver uses local default and named profile keys", () => {
  let activeProfileName: string | undefined;
  const resolveKey = createTelegramLockKeyResolver({
    getActiveProfileName: () => activeProfileName,
  });

  assert.equal(resolveTelegramLockKey(), "default");
  assert.equal(resolveKey(), "default");
  activeProfileName = "omp";
  assert.equal(resolveKey(), "omp");
});

test("Lock runtime releases only the active profile key", () => {
  const temp = createTempLockPath();
  try {
    let activeProfileName: string | undefined = "work";
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      key: createTelegramLockKeyResolver({
        getActiveProfileName: () => activeProfileName,
      }),
    });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    activeProfileName = "omp";
    const other = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      key: createTelegramLockKeyResolver({
        getActiveProfileName: () => activeProfileName,
      }),
    });
    assert.equal(other.acquire({ cwd: "/repo" }).ok, true);

    assert.equal(other.release().kind, "active-here");
    assert.deepEqual(readLocks(temp.path).work, {
      pid: 10,
      cwd: "/repo",
    });
    assert.equal(readLocks(temp.path).omp, undefined);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("writeLocks writes private lock files", () => {
  const temp = createTempLockPath();
  try {
    writeLocks(temp.path, { [TELEGRAM_LOCK_KEY]: { pid: 10 } });
    if (process.platform !== "win32") {
      assert.equal(statSync(temp.path).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("File transaction publishes a private directory guard with owner metadata", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  try {
    withTelegramFileTransaction(transactionPath, () => {
      assert.equal(statSync(transactionPath).isDirectory(), true);
      if (process.platform !== "win32") {
        assert.equal(statSync(transactionPath).mode & 0o777, 0o700);
      }
      const ownerPath = join(transactionPath, readdirSync(transactionPath)[0]);
      if (process.platform !== "win32") {
        assert.equal(statSync(ownerPath).mode & 0o777, 0o600);
      }
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as {
        pid: number;
        acquiredAtMs: number;
        generation: string;
      };
      assert.equal(owner.pid, process.pid);
      assert.equal(typeof owner.acquiredAtMs, "number");
      assert.match(owner.generation, /^[0-9a-f-]{36}$/u);
    });
    assert.equal(existsSync(transactionPath), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("File transaction retries transient guard publication errors after contention disappears", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  let publishAttempts = 0;
  let operations = 0;
  try {
    withTelegramFileTransaction(
      transactionPath,
      () => {
        operations += 1;
      },
      {
        attempts: 2,
        retryDelayMs: 0,
        publishRename(fromPath, toPath) {
          publishAttempts += 1;
          if (publishAttempts === 1) {
            throw Object.assign(new Error("transient publication contention"), {
              code: "EPERM",
            });
          }
          renameSync(fromPath, toPath);
        },
      },
    );
    assert.equal(publishAttempts, 2);
    assert.equal(operations, 1);
    assert.equal(existsSync(transactionPath), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction recovers a directory guard left by a dead process", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  try {
    mkdirSync(transactionPath, { mode: 0o700 });
    writeFileSync(
      join(transactionPath, "owner.dead-directory-guard.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "dead-directory-guard",
      }),
      { mode: 0o600 },
    );
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    assert.equal(existsSync(transactionPath), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction recovers dead directory main and recovery guards", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  const recoveryPath = `${transactionPath}.recovery`;
  try {
    for (const [path, generation] of [
      [transactionPath, "dead-main-directory"],
      [recoveryPath, "dead-recovery-directory"],
    ] as const) {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(
        join(path, `owner.${generation}.json`),
        JSON.stringify({
          pid: 2_147_483_647,
          acquiredAtMs: Date.now(),
          generation,
        }),
        { mode: 0o600 },
      );
    }
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    assert.equal(existsSync(transactionPath), false);
    assert.equal(existsSync(recoveryPath), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction releases recovered ownership when recovery cleanup fails", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  const recoveryPath = `${transactionPath}.recovery`;
  try {
    for (const [path, generation] of [
      [transactionPath, "dead-main-before-cleanup-failure"],
      [recoveryPath, "dead-recovery-before-cleanup-failure"],
    ] as const) {
      mkdirSync(path, { mode: 0o700 });
      writeFileSync(
        join(path, `owner.${generation}.json`),
        JSON.stringify({
          pid: 2_147_483_647,
          acquiredAtMs: Date.now(),
          generation,
        }),
        { mode: 0o600 },
      );
    }
    assert.throws(
      () =>
        withTelegramFileTransaction(transactionPath, () => undefined, {
          recoveryRename(fromPath, toPath) {
            if (fromPath === recoveryPath) {
              throw Object.assign(new Error("injected recovery cleanup busy"), {
                code: "EBUSY",
              });
            }
            renameSync(fromPath, toPath);
          },
        }),
      /injected recovery cleanup busy/,
    );
    assert.equal(existsSync(transactionPath), false);
    withTelegramFileTransaction(transactionPath, () => undefined);
    assert.equal(existsSync(transactionPath), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction rollback retry restores peer-process recovery", async () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  const readyPath = join(temp.dir, "ready-peer");
  const startPath = join(temp.dir, "start-peer");
  let rollbackFailed = false;
  try {
    mkdirSync(transactionPath, { mode: 0o700 });
    writeFileSync(
      join(transactionPath, "owner.dead-main-before-rename-failure.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "dead-main-before-rename-failure",
      }),
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        withTelegramFileTransaction(transactionPath, () => undefined, {
          recoveryRename(fromPath, toPath) {
            const isRollback = basename(String(fromPath)).startsWith(
              "owner.reclaim.",
            );
            if (
              fromPath === transactionPath ||
              (isRollback && !rollbackFailed)
            ) {
              if (isRollback) rollbackFailed = true;
              throw Object.assign(new Error("injected transient busy"), {
                code: "EBUSY",
              });
            }
            renameSync(fromPath, toPath);
          },
        }),
      /injected transient busy/,
    );
    assert.deepEqual(readdirSync(transactionPath), [
      "owner.dead-main-before-rename-failure.json",
    ]);
    const child = spawnLockRaceChild({
      locksPath: temp.path,
      key: TELEGRAM_LOCK_KEY,
      readyPath,
      startPath,
    });
    await waitForCondition(() => existsSync(readyPath), 2_000);
    writeFileSync(startPath, "start");
    assert.equal((await child.result).ok, true);
    assert.equal(existsSync(transactionPath), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction reclaims an inactive same-process marker after rollback failure", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  try {
    mkdirSync(transactionPath, { mode: 0o700 });
    writeFileSync(
      join(transactionPath, "owner.dead-main-before-rollback-failure.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "dead-main-before-rollback-failure",
      }),
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        withTelegramFileTransaction(transactionPath, () => undefined, {
          recoveryRename(fromPath, toPath) {
            if (
              fromPath === transactionPath ||
              basename(String(fromPath)).startsWith("owner.reclaim.")
            ) {
              throw Object.assign(new Error("injected rollback busy"), {
                code: "EBUSY",
              });
            }
            renameSync(fromPath, toPath);
          },
        }),
      AggregateError,
    );
    assert.match(readdirSync(transactionPath)[0], /^owner\.reclaim\./u);
    withTelegramFileTransaction(transactionPath, () => undefined);
    assert.equal(existsSync(transactionPath), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction recovery preserves a live recovery guard", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  const recoveryPath = `${transactionPath}.recovery`;
  const liveRecoveryOwner = {
    pid: process.pid,
    acquiredAtMs: Date.now(),
    generation: "live-recovery-owner",
  };
  try {
    mkdirSync(transactionPath, { mode: 0o700 });
    writeFileSync(
      join(transactionPath, "owner.dead-main-with-live-recovery.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "dead-main-with-live-recovery",
      }),
      { mode: 0o600 },
    );
    mkdirSync(recoveryPath, { mode: 0o700 });
    writeFileSync(
      join(recoveryPath, "owner.live-recovery-owner.json"),
      JSON.stringify(liveRecoveryOwner),
      { mode: 0o600 },
    );
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(recoveryPath, "owner.live-recovery-owner.json"),
          "utf8",
        ),
      ),
      liveRecoveryOwner,
    );
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction recovers dead legacy main and recovery guards", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  const recoveryPath = `${transactionPath}.recovery`;
  try {
    for (const [path, generation] of [
      [transactionPath, "dead-main-legacy"],
      [recoveryPath, "dead-recovery-legacy"],
    ] as const) {
      writeFileSync(
        path,
        JSON.stringify({
          pid: 2_147_483_647,
          acquiredAtMs: Date.now(),
          generation,
        }),
        { mode: 0o600 },
      );
    }
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    assert.equal(existsSync(transactionPath), false);
    assert.equal(existsSync(recoveryPath), false);
    assert.equal(existsSync(`${recoveryPath}.migration`), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction resumes a reclaim marker left by a dead recoverer", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  try {
    mkdirSync(transactionPath, { mode: 0o700 });
    writeFileSync(
      join(
        transactionPath,
        "owner.reclaim.2147483647.00000000-0000-4000-8000-000000000000.json",
      ),
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "dead-original-owner",
      }),
      { mode: 0o600 },
    );
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    assert.equal(existsSync(transactionPath), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("File transaction refuses to release a replacement directory owner", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  try {
    assert.throws(
      () =>
        withTelegramFileTransaction(transactionPath, () => {
          rmSync(transactionPath, { recursive: true, force: true });
          mkdirSync(transactionPath, { mode: 0o700 });
          writeFileSync(
            join(transactionPath, "owner.replacement-owner.json"),
            JSON.stringify({
              pid: process.pid,
              acquiredAtMs: Date.now(),
              generation: "replacement-owner",
            }),
            { mode: 0o600 },
          );
        }),
      /changed ownership/,
    );
    assert.equal(existsSync(transactionPath), true);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Delayed stale recovery cannot claim a replacement generation", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  const replacementOwner = {
    pid: process.pid,
    acquiredAtMs: Date.now(),
    generation: "replacement-generation",
  };
  let replaced = false;
  try {
    mkdirSync(transactionPath, { mode: 0o700 });
    writeFileSync(
      join(transactionPath, "owner.stale-generation.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "stale-generation",
      }),
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        withTelegramFileTransaction(transactionPath, () => undefined, {
          attempts: 2,
          retryDelayMs: 0,
          recoveryRename(fromPath, toPath) {
            if (
              !replaced &&
              basename(String(fromPath)) === "owner.stale-generation.json"
            ) {
              replaced = true;
              rmSync(transactionPath, { recursive: true, force: true });
              mkdirSync(transactionPath, { mode: 0o700 });
              writeFileSync(
                join(transactionPath, "owner.replacement-generation.json"),
                JSON.stringify(replacementOwner),
                { mode: 0o600 },
              );
              throw Object.assign(
                new Error("injected macOS concurrent rename contention"),
                { code: "EINVAL" },
              );
            }
            renameSync(fromPath, toPath);
          },
        }),
      /Timed out acquiring Telegram lock transaction/,
    );
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(transactionPath, "owner.replacement-generation.json"),
          "utf8",
        ),
      ),
      replacementOwner,
    );
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction recovers a guard left by a dead process", () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      `${temp.path}.transaction`,
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "dead-guard",
      }),
    );
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    assert.equal(existsSync(`${temp.path}.transaction`), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction fails closed on an unverified guard", () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(`${temp.path}.transaction`, "");
    assert.throws(
      () =>
        withTelegramFileTransaction(
          `${temp.path}.transaction`,
          () => undefined,
          { attempts: 2, retryDelayMs: 0 },
        ),
      /Timed out acquiring Telegram lock transaction/,
    );
    assert.equal(readFileSync(`${temp.path}.transaction`, "utf8"), "");
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction fails closed on an unverified directory guard", () => {
  const temp = createTempLockPath();
  const transactionPath = `${temp.path}.transaction`;
  try {
    mkdirSync(transactionPath, { mode: 0o700 });
    assert.throws(
      () =>
        withTelegramFileTransaction(transactionPath, () => undefined, {
          attempts: 2,
          retryDelayMs: 0,
        }),
      /Timed out acquiring Telegram lock transaction/,
    );
    assert.equal(statSync(transactionPath).isDirectory(), true);
    assert.deepEqual(readdirSync(transactionPath), []);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction fails closed on malformed registry content", () => {
  const temp = createTempLockPath();
  try {
    const malformed = "{not-json";
    writeFileSync(temp.path, malformed);
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    assert.throws(() => lock.acquire({ cwd: "/repo" }), SyntaxError);
    assert.equal(readFileSync(temp.path, "utf8"), malformed);
    assert.equal(existsSync(`${temp.path}.transaction`), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction elects exactly one concurrent child process", async () => {
  const temp = createTempLockPath();
  const startPath = join(temp.dir, "start");
  const readyPaths = [join(temp.dir, "ready-a"), join(temp.dir, "ready-b")];
  try {
    const children = readyPaths.map((readyPath) =>
      spawnLockRaceChild({
        locksPath: temp.path,
        key: TELEGRAM_LOCK_KEY,
        readyPath,
        startPath,
      }),
    );
    await waitForCondition(
      () => readyPaths.every((readyPath) => existsSync(readyPath)),
      2_000,
    );
    writeFileSync(startPath, "start");
    const results = await Promise.all(children.map((child) => child.result));
    assert.equal(results.filter((result) => result.ok).length, 1);
    const persisted = readLocks(temp.path)[TELEGRAM_LOCK_KEY] as {
      pid: number;
    };
    assert.equal(persisted.pid, results.find((result) => result.ok)?.pid);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Concurrent stale-guard recovery elects exactly one child process", async () => {
  const temp = createTempLockPath();
  const startPath = join(temp.dir, "start");
  const readyPaths = [join(temp.dir, "ready-a"), join(temp.dir, "ready-b")];
  try {
    const transactionPath = `${temp.path}.transaction`;
    mkdirSync(transactionPath, { mode: 0o700 });
    writeFileSync(
      join(transactionPath, "owner.dead-race-guard.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        acquiredAtMs: Date.now(),
        generation: "dead-race-guard",
      }),
      { mode: 0o600 },
    );
    const children = readyPaths.map((readyPath) =>
      spawnLockRaceChild({
        locksPath: temp.path,
        key: TELEGRAM_LOCK_KEY,
        readyPath,
        startPath,
      }),
    );
    await waitForCondition(
      () => readyPaths.every((readyPath) => existsSync(readyPath)),
      2_000,
    );
    writeFileSync(startPath, "start");
    const results = await Promise.all(children.map((child) => child.result));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(existsSync(`${temp.path}.transaction`), false);
    assert.equal(existsSync(`${temp.path}.transaction.recovery`), false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock transaction preserves keys acquired by concurrent profiles", async () => {
  const temp = createTempLockPath();
  const startPath = join(temp.dir, "start");
  const readyPaths = [join(temp.dir, "ready-a"), join(temp.dir, "ready-b")];
  const keys = [TELEGRAM_LOCK_KEY, "work"];
  try {
    const children = keys.map((key, index) =>
      spawnLockRaceChild({
        locksPath: temp.path,
        key,
        readyPath: readyPaths[index]!,
        startPath,
      }),
    );
    await waitForCondition(
      () => readyPaths.every((readyPath) => existsSync(readyPath)),
      2_000,
    );
    writeFileSync(startPath, "start");
    const results = await Promise.all(children.map((child) => child.result));
    assert.equal(
      results.every((result) => result.ok),
      true,
    );
    const persisted = readLocks(temp.path);
    assert.deepEqual(Object.keys(persisted).sort(), [...keys].sort());
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime preserves other profile owners and refuses a live default owner", () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      temp.path,
      JSON.stringify(
        {
          work: { pid: 123 },
          [TELEGRAM_LOCK_KEY]: { pid: 99 },
        },
        null,
        2,
      ),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: (pid) => pid === 99,
    });
    const acquired = lock.acquire({ cwd: "/repo" });
    assert.equal(acquired.ok, false);
    assert.equal(lock.getStatusLabel(), "active elsewhere (pid 99)");
    assert.deepEqual(readLocks(temp.path).work, { pid: 123 });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime records bus leader metadata without a heartbeat and refresh writes nothing", () => {
  const temp = createTempLockPath();
  try {
    let nowMs = 1000;
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "inst-a",
      getNowMs: () => nowMs,
      mintLeaderEpoch: () => 1000,
      runtimeGeneration: 1,
    });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    assert.equal(lock.getOwnedLeaderEpoch(), 1000);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
      instanceId: "inst-a",
      leaderEpoch: 1000,
      runtimeGeneration: 1,
    });
    const published = statSync(temp.path);
    nowMs = 1500;
    assert.equal(lock.refresh({ cwd: "/repo" }), true);
    const refreshed = statSync(temp.path);
    assert.equal(refreshed.ino, published.ino, "An exact owner refresh publishes nothing");
    assert.equal(refreshed.mtimeMs, published.mtimeMs);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime fences refresh and release to the acquired owner epoch", () => {
  const temp = createTempLockPath();
  try {
    const first = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "inst-a",
      getNowMs: () => 1000,
      mintLeaderEpoch: () => "epoch-a",
      runtimeGeneration: 1,
    });
    const second = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 11,
      instanceId: "inst-b",
      getNowMs: () => 2000,
      mintLeaderEpoch: () => "epoch-b",
      runtimeGeneration: 2,
      isProcessAlive: () => true,
    });
    const acquiredFirst = first.acquire({ cwd: "/repo" });
    assert.equal(acquiredFirst.ok, true);
    assert.equal(second.acquire({ cwd: "/repo" }).ok, false);
    assert.equal(
      second.acquire(
        { cwd: "/repo" },
        {
          force: true,
          expectedOwner: {
            pid: 10,
            cwd: "/repo",
            instanceId: "wrong-owner",
            leaderEpoch: "epoch-a",
          },
        },
      ).ok,
      false,
    );
    assert.equal(
      second.acquire(
        { cwd: "/repo" },
        {
          force: true,
          expectedOwner: acquiredFirst.ok ? acquiredFirst.lock : undefined,
        },
      ).ok,
      true,
    );

    assert.equal(first.getOwnedLeaderEpoch(), undefined);
    assert.equal(second.getOwnedLeaderEpoch(), "epoch-b");
    assert.equal(first.refresh({ cwd: "/repo" }), false);
    first.release();
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 11,
      cwd: "/repo",
      instanceId: "inst-b",
      leaderEpoch: "epoch-b",
      runtimeGeneration: 2,
    });
    assert.equal(second.owns({ cwd: "/repo" }), true);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock election cannot replace a proven-unresponsive owner after it was re-acquired", () => {
  const temp = createTempLockPath();
  try {
    let epoch = 0;
    const leader = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "leader",
      runtimeGeneration: 1,
      mintLeaderEpoch: () => `leader-epoch-${++epoch}`,
    });
    assert.equal(leader.acquire({ cwd: "/repo" }).ok, true);
    const follower = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 11,
      instanceId: "follower",
      runtimeGeneration: 2,
      isProcessAlive: () => true,
    });
    const observed = follower.getState();
    assert.equal(observed.kind, "active-elsewhere");
    const proven = observed.kind === "active-elsewhere" ? observed.lock : undefined;
    leader.release();
    assert.equal(leader.acquire({ cwd: "/repo" }).ok, true);
    const result = follower.acquire(
      { cwd: "/repo" },
      { election: true, expectedOwner: proven, unresponsiveOwner: proven },
    );
    assert.equal(result.ok, false, "Proof binds the exact owner epoch, never its successor");
    assert.equal(leader.owns({ cwd: "/repo" }), true);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime keeps the eight-second stale threshold for older-release heartbeat entries", () => {
  const temp = createTempLockPath();
  try {
    let nowMs = 1000;
    writeFileSync(
      temp.path,
      JSON.stringify({
        [TELEGRAM_LOCK_KEY]: { pid: 10, cwd: "/leader", instanceId: "older", heartbeatMs: 1000 },
      }),
    );
    const follower = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 11,
      instanceId: "follower",
      getNowMs: () => nowMs,
      staleHeartbeatMs: TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
      isProcessAlive: () => true,
    });
    nowMs = 8999;
    assert.equal(follower.getState().kind, "active-elsewhere");
    nowMs = 9001;
    assert.equal(follower.getState().kind, "stale");
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime never ages a current owner without bus proof", () => {
  const temp = createTempLockPath();
  try {
    let nowMs = 1000;
    const leader = createTelegramLockRuntime({ locksPath: temp.path, pid: 10, instanceId: "leader", getNowMs: () => nowMs });
    assert.equal(leader.acquire({ cwd: "/leader" }).ok, true);
    const follower = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 11,
      instanceId: "follower",
      getNowMs: () => nowMs,
      staleHeartbeatMs: TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
      isProcessAlive: () => true,
    });
    nowMs = 1_000_000;
    assert.equal(follower.getState().kind, "active-elsewhere", "Elapsed time alone is never takeover authority");
    assert.equal(follower.acquire({ cwd: "/follower" }).ok, false);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock election cannot replace an owner that appeared after inactive observation", () => {
  const temp = createTempLockPath();
  try {
    const leader = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "leader",
      runtimeGeneration: 1,
    });
    const follower = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 11,
      instanceId: "follower",
      runtimeGeneration: 2,
      isProcessAlive: () => true,
    });
    assert.equal(follower.getState().kind, "inactive");
    assert.equal(leader.acquire({ cwd: "/repo" }).ok, true);
    assert.equal(
      follower.acquire(
        { cwd: "/repo" },
        { election: true, expectedOwner: undefined },
      ).ok,
      false,
    );
    assert.equal(leader.owns({ cwd: "/repo" }), true);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime mints collision-resistant epochs independently of heartbeat time", () => {
  const temp = createTempLockPath();
  try {
    const first = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "inst-a",
      getNowMs: () => 1000,
    });
    const firstResult = first.acquire({ cwd: "/repo" });
    assert.equal(firstResult.ok, true);
    first.release();
    const second = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 11,
      instanceId: "inst-b",
      getNowMs: () => 1000,
    });
    const secondResult = second.acquire({ cwd: "/repo" });
    assert.equal(secondResult.ok, true);
    assert.equal(
      typeof (firstResult.ok && firstResult.lock.leaderEpoch),
      "string",
    );
    assert.notEqual(
      firstResult.ok ? firstResult.lock.leaderEpoch : undefined,
      secondResult.ok ? secondResult.lock.leaderEpoch : undefined,
    );
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime upgrades adopted legacy ownership during refresh", () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      temp.path,
      JSON.stringify({
        [TELEGRAM_LOCK_KEY]: { pid: 10, cwd: "/repo" },
      }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "leader",
      runtimeGeneration: 7,
      getNowMs: () => 2000,
      mintLeaderEpoch: () => "epoch",
    });
    assert.equal(lock.owns({ cwd: "/repo" }), true);
    assert.equal(lock.refresh({ cwd: "/repo" }), true);
    assert.equal(lock.owns({ cwd: "/repo" }), true);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
      instanceId: "leader",
      leaderEpoch: "epoch",
      runtimeGeneration: 7,
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime prunes legacy bus socket path and heartbeat on refresh", () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      temp.path,
      JSON.stringify({
        [TELEGRAM_LOCK_KEY]: {
          pid: 10,
          cwd: "/repo",
          instanceId: "inst-a",
          heartbeatMs: 1000,
          leaderEpoch: 1000,
          runtimeGeneration: 1,
          busSocketPath: join(temp.dir, "bus.sock"),
        },
      }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "inst-a",
      runtimeGeneration: 1,
      getNowMs: () => 1500,
    });
    assert.equal(lock.refresh({ cwd: "/repo" }), true);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
      instanceId: "inst-a",
      leaderEpoch: 1000,
      runtimeGeneration: 1,
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime treats stale bus heartbeats as replaceable even when pid is alive", () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      temp.path,
      JSON.stringify({
        [TELEGRAM_LOCK_KEY]: {
          pid: 99,
          cwd: "/old",
          instanceId: "old-inst",
          heartbeatMs: 1000,
        },
      }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "inst-a",
      getNowMs: () => 3000,
      mintLeaderEpoch: () => 3000,
      runtimeGeneration: 1,
      staleHeartbeatMs: 500,
      isProcessAlive: (pid) => pid === 99,
    });
    assert.equal(lock.getState().kind, "stale");
    const acquired = lock.acquire({ cwd: "/repo" });
    assert.equal(acquired.ok, true);
    assert.equal(acquired.ok && acquired.replacedStale, true);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
      instanceId: "inst-a",
      leaderEpoch: 3000,
      runtimeGeneration: 1,
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Unresponsive leader election admits one proven-owner candidate and fences the old leader", () => {
  const temp = createTempLockPath();
  try {
    const leader = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "leader",
      runtimeGeneration: 1,
      mintLeaderEpoch: () => "leader-epoch",
      staleHeartbeatMs: TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
    });
    assert.equal(leader.acquire({ cwd: "/leader" }).ok, true);
    const createCandidate = (pid: number, instanceId: string) =>
      createTelegramLockRuntime({
        locksPath: temp.path,
        pid,
        instanceId,
        runtimeGeneration: pid,
        mintLeaderEpoch: () => `${instanceId}-epoch`,
        staleHeartbeatMs: TELEGRAM_BUS_LEADER_STALE_HEARTBEAT_MS,
        isProcessAlive: () => true,
      });
    const first = createCandidate(11, "candidate-a");
    const second = createCandidate(12, "candidate-b");
    const firstObservation = first.getState();
    const secondObservation = second.getState();
    assert.equal(firstObservation.kind, "active-elsewhere");
    assert.equal(secondObservation.kind, "active-elsewhere");
    const proof = (state: typeof firstObservation) =>
      state.kind === "active-elsewhere" ? state.lock : undefined;
    assert.equal(
      first.acquire({ cwd: "/candidate-a" }, { election: true }).ok,
      false,
      "A live owner without bus proof is never replaced",
    );
    assert.equal(
      first.acquire(
        { cwd: "/candidate-a" },
        { election: true, expectedOwner: proof(firstObservation), unresponsiveOwner: proof(firstObservation) },
      ).ok,
      true,
    );
    assert.equal(
      second.acquire(
        { cwd: "/candidate-b" },
        { election: true, expectedOwner: proof(secondObservation), unresponsiveOwner: proof(secondObservation) },
      ).ok,
      false,
    );
    assert.equal(first.owns({ cwd: "/candidate-a" }), true);
    assert.equal(second.owns({ cwd: "/candidate-b" }), false);
    assert.equal(leader.refresh({ cwd: "/leader" }), false);
    assert.equal(first.getOwnedLeaderEpoch(), "candidate-a-epoch");
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Lock runtime replaces stale owners", () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99 } }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: () => false,
    });
    const acquired = lock.acquire({ cwd: "/repo" });
    assert.equal(acquired.ok, true);
    assert.equal(acquired.ok && acquired.replacedStale, true);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime prevents inherited child sessions from polling the same agent dir", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    const parentLock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
    });
    const childLock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 11,
      isProcessAlive: (pid) => pid === 10,
    });
    const parentRuntime = createTelegramLockedPollingRuntime({
      lock: parentLock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("parent:start");
      },
      stopPolling: async () => {
        events.push("parent:stop");
      },
      updateStatus: () => {
        events.push("parent:status");
      },
    });
    const childRuntime = createTelegramLockedPollingRuntime({
      lock: childLock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("child:start");
      },
      stopPolling: async () => {
        events.push("child:stop");
      },
      updateStatus: () => {
        events.push("child:status");
      },
    });
    assert.equal((await parentRuntime.start({ cwd: "/repo" })).ok, true);
    await childRuntime.onSessionStart({}, { cwd: "/repo" });
    const blocked = await childRuntime.start({ cwd: "/repo" });
    assert.deepEqual(blocked, {
      ok: false,
      canTakeover: true,
      owner: "pid 10, cwd /repo",
      message:
        "Telegram bridge is active in another Pi instance (pid 10, cwd /repo).",
    });
    assert.deepEqual(events, ["parent:start", "parent:status"]);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
    });
    assert.equal(await parentRuntime.stop(), "Telegram bridge disconnected.");
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime registers as follower when another live owner blocks start", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    writeFileSync(
      temp.path,
      JSON.stringify({
        [TELEGRAM_LOCK_KEY]: {
          pid: 99,
          cwd: "/old",
          instanceId: "owner-inst",
          busSocketPath: join(temp.dir, "bus.sock"),
        },
      }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: (pid) => pid === 99,
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      registerFollowerWithOwner: async (ctx, owner) => {
        events.push(
          `register:${ctx.cwd}:${owner.instanceId}:${owner.busSocketPath}`,
        );
        return true;
      },
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    const result = await runtime.start({ cwd: "/repo" });
    assert.equal(result.ok, true);
    assert.equal(result.canTakeover, false);
    assert.equal(result.message, undefined);
    assert.deepEqual(events, [
      `register:/repo:owner-inst:${join(temp.dir, "bus.sock")}`,
      "status",
    ]);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime falls back to takeover when follower registration is not applicable", async () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/old" } }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: (pid) => pid === 99,
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      registerFollowerWithOwner: async () => undefined,
      startPolling: async () => undefined,
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
    });

    const blocked = await runtime.start({ cwd: "/repo" });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.canTakeover, true);
    assert.match(blocked.message, /active in another Pi instance/);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime records follower registration failures without blocking takeover prompt", async () => {
  const temp = createTempLockPath();
  try {
    const runtimeEvents: string[] = [];
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/old" } }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: (pid) => pid === 99,
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      registerFollowerWithOwner: async () => {
        throw new Error("register failed");
      },
      startPolling: async () => undefined,
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
      recordRuntimeEvent: (category, error, details) => {
        runtimeEvents.push(
          `${category}:${details?.phase}:${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });
    const blocked = await runtime.start({ cwd: "/repo" });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.canTakeover, false);
    assert.match(
      blocked.message,
      /follower registration failed: register failed/,
    );
    assert.deepEqual(runtimeEvents, ["bus:follower-register:register failed"]);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

for (const proven of [false, true]) test(`Locked polling runtime takes over an unregisterable live owner only with bus proof (${proven ? "proven" : "unproven"})`, async () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/old", instanceId: "old", leaderEpoch: "old-epoch" } }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "new",
      mintLeaderEpoch: () => "new-epoch",
      isProcessAlive: (pid) => pid === 99 || pid === 10,
    });
    const proofs: unknown[] = [];
    let starts = 0;
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      registerFollowerWithOwner: async () => {
        throw new Error("registration timed out");
      },
      proveOwnerUnresponsive: async (owner) => {
        proofs.push(owner);
        return proven;
      },
      startPolling: async () => {
        starts += 1;
      },
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
    });
    const result = await runtime.start({ cwd: "/repo" });
    assert.equal(proofs.length, 1);
    assert.equal((proofs[0] as { leaderEpoch?: string }).leaderEpoch, "old-epoch");
    assert.equal(result.ok, proven);
    assert.equal(starts, proven ? 1 : 0);
    assert.equal(lock.owns({ cwd: "/repo" }), proven);
    if (!proven) assert.equal(result.ok === false && result.canTakeover, false);
    await runtime.stop();
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime diagnoses a live owner with unreachable bus endpoint", async () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/old" } }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: (pid) => pid === 99,
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      registerFollowerWithOwner: async () => {
        throw new Error("connect ENOENT /agent/tmp/telegram/bus.sock");
      },
      startPolling: async () => undefined,
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
    });

    const blocked = await runtime.start({ cwd: "/repo" });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.canTakeover, false);
    assert.match(
      blocked.message,
      /live owner \/ unreachable bus endpoint after bounded retries/,
    );
    assert.match(blocked.message, /retry \/telegram-connect/);
    assert.match(blocked.message, /Do not force takeover/);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime stops follower heartbeat on stop", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      stopFollowerRegistration: () => {
        events.push("follower:stop");
      },
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("poll:stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    assert.equal((await runtime.start({ cwd: "/repo" })).ok, true);
    assert.equal(await runtime.stop(), "Telegram bridge disconnected.");
    assert.deepEqual(events, ["start", "status", "follower:stop", "poll:stop"]);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime can force takeover of live polling owners", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/old" } }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: (pid) => pid === 99,
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    const blocked = await runtime.start({ cwd: "/new" });
    assert.deepEqual(blocked, {
      ok: false,
      canTakeover: true,
      owner: "pid 99, cwd /old",
      message:
        "Telegram bridge is active in another Pi instance (pid 99, cwd /old).",
    });
    const moved = await runtime.start({ cwd: "/new" }, { force: true });
    assert.deepEqual(moved, {
      ok: true,
      message: "Telegram bridge connected.",
    });
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/new",
    });
    assert.deepEqual(events, ["start", "status"]);
    assert.equal(await runtime.stop(), "Telegram bridge disconnected.");
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime hands same-process ownership to a replacement instance", async () => {
  const temp = createTempLockPath();
  try {
    const previousLock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "old-instance",
      mintLeaderEpoch: () => "old-epoch",
    });
    assert.equal(previousLock.acquire({ cwd: "/repo" }).ok, true);
    const replacementLock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "new-instance",
      mintLeaderEpoch: () => "new-epoch",
    });
    const events: string[] = [];
    const runtime = createTelegramLockedPollingRuntime({
      lock: replacementLock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });

    assert.deepEqual(await runtime.start({ cwd: "/repo" }), {
      ok: true,
      message: "Telegram bridge connected.",
    });
    assert.equal(previousLock.refresh({ cwd: "/repo" }), false);
    previousLock.release();
    const persisted = readLocks(temp.path)[TELEGRAM_LOCK_KEY] as Record<
      string,
      unknown
    >;
    assert.equal(persisted.pid, 10);
    assert.equal(persisted.cwd, "/repo");
    assert.equal(persisted.instanceId, "new-instance");
    assert.equal(persisted.heartbeatMs, undefined);
    assert.equal(persisted.leaderEpoch, "new-epoch");
    assert.deepEqual(events, ["start", "status"]);
    await runtime.stop();
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Default runtime generation supersedes a pre-reload same-process counter", () => {
  const temp = createTempLockPath();
  try {
    writeLocks(temp.path, {
      [TELEGRAM_LOCK_KEY]: {
        pid: 10,
        cwd: "/repo",
        instanceId: "10:old-reload",
        heartbeatMs: Date.now(),
        leaderEpoch: "old-epoch",
        runtimeGeneration: 2,
      },
    });
    const replacement = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "10:new-reload",
      mintLeaderEpoch: () => "new-epoch",
    });

    const expectedOwner = readLocks(temp.path)[
      TELEGRAM_LOCK_KEY
    ] as TelegramLockEntry;
    const acquired = replacement.acquire(
      { cwd: "/repo" },
      { force: true, expectedOwner },
    );

    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    assert.equal(acquired.lock.instanceId, "10:new-reload");
    assert.ok((acquired.lock.runtimeGeneration ?? 0) > 2);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Older same-process runtime cannot reverse a replacement handoff", async () => {
  const temp = createTempLockPath();
  try {
    const oldLock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "old-instance",
      runtimeGeneration: 1,
      mintLeaderEpoch: () => "old-epoch",
    });
    const newLock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "new-instance",
      runtimeGeneration: 2,
      mintLeaderEpoch: () => "new-epoch",
    });
    assert.equal(oldLock.acquire({ cwd: "/repo" }).ok, true);
    const newRuntime = createTelegramLockedPollingRuntime({
      lock: newLock,
      hasBotToken: () => true,
      startPolling: async () => undefined,
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
    });
    assert.equal((await newRuntime.start({ cwd: "/repo" })).ok, true);
    const oldRuntime = createTelegramLockedPollingRuntime({
      lock: oldLock,
      hasBotToken: () => true,
      startPolling: async () => assert.fail("Old runtime must not restart"),
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
    });

    assert.equal((await oldRuntime.start({ cwd: "/repo" })).ok, false);
    await oldRuntime.onSessionStart({}, { cwd: "/repo" });
    const persisted = readLocks(temp.path)[TELEGRAM_LOCK_KEY] as Record<
      string,
      unknown
    >;
    assert.equal(persisted.pid, 10);
    assert.equal(persisted.cwd, "/repo");
    assert.equal(persisted.instanceId, "new-instance");
    assert.equal(persisted.heartbeatMs, undefined);
    assert.equal(persisted.leaderEpoch, "new-epoch");
    assert.equal(persisted.runtimeGeneration, 2);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Same instance id cannot bypass same-process generation handoff", () => {
  const temp = createTempLockPath();
  try {
    const first = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "10:1000",
      runtimeGeneration: 1,
      mintLeaderEpoch: () => "first-epoch",
    });
    const second = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "10:1000",
      runtimeGeneration: 2,
      mintLeaderEpoch: () => "second-epoch",
    });
    const acquiredFirst = first.acquire({ cwd: "/repo" });
    assert.equal(acquiredFirst.ok, true);
    assert.equal(second.owns({ cwd: "/repo" }), false);
    assert.equal(
      second.acquire(
        { cwd: "/repo" },
        {
          force: true,
          expectedOwner: acquiredFirst.ok ? acquiredFirst.lock : undefined,
        },
      ).ok,
      true,
    );
    assert.equal(first.owns({ cwd: "/repo" }), false);
    assert.equal(second.owns({ cwd: "/repo" }), true);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Retained lock ownership cannot cross a dynamic profile key", () => {
  const temp = createTempLockPath();
  try {
    let activeProfileName: string | undefined;
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      key: () => resolveTelegramLockKey(activeProfileName),
    });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    const locks = readLocks(temp.path);
    locks.work = { pid: 10, cwd: "/repo" };
    writeLocks(temp.path, locks);

    activeProfileName = "work";
    assert.equal(lock.owns({ cwd: "/repo" }), false);
    assert.equal(lock.refresh({ cwd: "/repo" }), false);
    lock.release();
    assert.deepEqual(readLocks(temp.path), {
      default: { pid: 10, cwd: "/repo" },
      work: { pid: 10, cwd: "/repo" },
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime releases ownership when setup is missing", async () => {
  const temp = createTempLockPath();
  try {
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => false,
      startPolling: async () => undefined,
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
    });
    const started = await runtime.start({ cwd: "/repo" });
    assert.deepEqual(started, {
      ok: false,
      message: "Telegram bot is not configured.",
    });
    assert.deepEqual(readLocks(temp.path), {});
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime reports an unresolved token reference", async () => {
  const temp = createTempLockPath();
  try {
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => false,
      getBotTokenDiagnostic: () =>
        "Telegram bot token environment variable WORK_BOT_TOKEN is not set.",
      startPolling: async () => undefined,
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
    });
    const started = await runtime.start({ cwd: "/repo" });
    assert.deepEqual(started, {
      ok: false,
      message: "Telegram bot token environment variable WORK_BOT_TOKEN is not set.",
    });
    assert.deepEqual(readLocks(temp.path), {});
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime refuses start when run mode disallows polling", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      canStartPolling: (ctx: { cwd: string; mode?: string }) =>
        ctx.mode !== "print",
      formatStartBlockedMessage: (ctx) =>
        `Telegram polling is unavailable in Pi ${ctx.mode} mode.`,
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    const started = await runtime.start({ cwd: "/repo", mode: "print" });
    assert.deepEqual(started, {
      ok: false,
      message: "Telegram polling is unavailable in Pi print mode.",
    });
    assert.deepEqual(events, []);
    assert.deepEqual(readLocks(temp.path), {});
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime watches ownership during slow startup", async () => {
  const temp = createTempLockPath();
  try {
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    let stopped = 0;
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "leader",
      mintLeaderEpoch: () => "epoch",
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        await startGate;
      },
      stopPolling: async () => {
        stopped += 1;
      },
      updateStatus: () => undefined,
      ownershipCheckMs: 5,
      ownershipRefreshMs: 5,
    });

    const started = runtime.start({ cwd: "/repo" });
    await waitForCondition(() => lock.owns({ cwd: "/repo" }), 2_000);
    const owned = statSync(temp.path);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(statSync(temp.path).mtimeMs, owned.mtimeMs, "Refresh ticks publish nothing for an exact owner");
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/other", instanceId: "other", leaderEpoch: "other" } }),
    );
    await waitForCondition(() => stopped > 0, 2_000);
    releaseStart?.();
    await started;
    await runtime.stop();
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime checks ownership more often than it refreshes the lease", () => {
  assert.ok(TELEGRAM_OWNERSHIP_CHECK_MS < TELEGRAM_OWNERSHIP_REFRESH_MS);
  assert.equal(
    TELEGRAM_OWNERSHIP_REFRESH_MS,
    TELEGRAM_OWNERSHIP_CHECK_MS * 2,
  );
});

test("Locked polling runtime fails startup closed after ownership loss", async () => {
  const temp = createTempLockPath();
  try {
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const events: string[] = [];
    let pollingActive = false;
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "leader",
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start");
        await startGate;
        pollingActive = true;
      },
      stopPolling: async () => {
        events.push("stop");
        pollingActive = false;
      },
      updateStatus: () => undefined,
      ownershipCheckMs: 5,
    });

    const started = runtime.start({ cwd: "/repo" });
    await waitForCondition(() => events.includes("start"));
    writeLocks(temp.path, {
      [TELEGRAM_LOCK_KEY]: {
        pid: 99,
        cwd: "/other",
        instanceId: "replacement",
        leaderEpoch: "replacement-epoch",
      },
    });
    await waitForCondition(() => events.includes("stop"));
    releaseStart?.();
    const result = await started;
    assert.equal(result.ok, false);
    assert.equal(pollingActive, false);
    assert.deepEqual(events, ["start", "stop", "stop"]);
    assert.equal(
      (readLocks(temp.path)[TELEGRAM_LOCK_KEY] as { instanceId?: string })
        .instanceId,
      "replacement",
    );
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime rolls back ownership when startup fails", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    let availabilityChanges = 0;
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        throw new Error("startup failed");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      onTransportAvailabilityChanged: () => {
        availabilityChanges += 1;
      },
      updateStatus: () => undefined,
    });

    await assert.rejects(runtime.start({ cwd: "/repo" }), /startup failed/);
    assert.deepEqual(readLocks(temp.path), {});
    assert.deepEqual(events, ["stop"]);
    assert.equal(availabilityChanges, 1);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime resumes a retained owner before auto-start without rewriting it", async () => {
  const temp = createTempLockPath();
  try {
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "leader",
      mintLeaderEpoch: () => "epoch",
    });
    assert.equal(lock.acquire({ cwd: "/repo" }).ok, true);
    const retained = statSync(temp.path);
    let starts = 0;
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        starts += 1;
      },
      stopPolling: async () => undefined,
      updateStatus: () => undefined,
    });

    await runtime.onSessionStart({}, { cwd: "/repo" });
    await waitForCondition(() => starts === 1);
    const resumed = statSync(temp.path);
    assert.equal(resumed.ino, retained.ino);
    assert.equal(resumed.mtimeMs, retained.mtimeMs);
    assert.equal((readLocks(temp.path)[TELEGRAM_LOCK_KEY] as { heartbeatMs?: number }).heartbeatMs, undefined);
    await runtime.stop();
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime auto-starts only from an existing owned lock", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 10, cwd: "/repo" } }),
    );
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    await runtime.onSessionStart({}, { cwd: "/repo" });
    await waitForCondition(() => events.includes("status"));
    assert.deepEqual(events, ["start", "status"]);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
    });
    assert.equal(await runtime.stop(), "Telegram bridge disconnected.");
    assert.deepEqual(events, ["start", "status", "stop"]);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime auto-connects a remembered follower under a live leader", async () => {
  const temp = createTempLockPath();
  try {
    const owner = {
      pid: 20,
      cwd: "/leader",
      instanceId: "leader",
      heartbeatMs: Date.now(),
      leaderEpoch: "leader-epoch",
    };
    writeFileSync(temp.path, JSON.stringify({ [TELEGRAM_LOCK_KEY]: owner }));
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      instanceId: "follower",
      isProcessAlive: (pid) => pid === 20,
    });
    const events: string[] = [];
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("leader-start");
      },
      stopPolling: async () => undefined,
      restoreFollowerWithOwner: async (_ctx, observedOwner) => {
        assert.equal(observedOwner.pid, owner.pid);
        assert.equal(observedOwner.instanceId, owner.instanceId);
        assert.equal(observedOwner.leaderEpoch, owner.leaderEpoch);
        events.push("follower-restore");
        return true;
      },
      onTransportAvailabilityChanged: () => {
        events.push("availability");
      },
      updateStatus: () => {
        events.push("status");
      },
    });

    await runtime.onSessionStart({}, { cwd: "/repo" });
    await waitForCondition(() => events.includes("status"));
    assert.deepEqual(events, ["follower-restore", "availability", "status"]);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], owner);
    await runtime.suspend();
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime reports a refused follower restore without claiming transport", async () => {
  const temp = createTempLockPath();
  try {
    writeFileSync(temp.path, JSON.stringify({ [TELEGRAM_LOCK_KEY]: {
      pid: 20, cwd: "/leader", instanceId: "leader", heartbeatMs: Date.now(),
      leaderEpoch: "leader-epoch",
    } }));
    const events: string[] = [];
    const runtime = createTelegramLockedPollingRuntime({
      lock: createTelegramLockRuntime({ locksPath: temp.path, pid: 10,
        instanceId: "follower", isProcessAlive: (pid) => pid === 20 }),
      hasBotToken: () => true,
      startPolling: async () => { throw new Error("must not poll"); },
      stopPolling: async () => undefined,
      restoreFollowerWithOwner: async () => false,
      onTransportAvailabilityChanged: () => { events.push("availability"); },
      updateStatus: () => { events.push("status"); },
      recordRuntimeEvent(_category, _message, details) {
        if (details?.phase === "follower-auto-connect-unavailable") events.push("refused");
      },
    });
    await runtime.onSessionStart({}, { cwd: "/repo" });
    await waitForCondition(() => events.includes("refused"));
    assert.deepEqual(events, ["refused"]);
    await runtime.suspend();
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime session auto-start does not block session initialization", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    let releaseStart: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 10, cwd: "/repo" } }),
    );
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start:begin");
        await started;
        events.push("start:end");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });

    await runtime.onSessionStart({}, { cwd: "/repo" });
    assert.equal(events.length, 0);
    await waitForCondition(() => events.includes("start:begin"));
    assert.deepEqual(events, ["start:begin"]);
    releaseStart?.();
    await waitForCondition(() => events.includes("status"));
    assert.deepEqual(events, ["start:begin", "start:end", "status"]);
    assert.equal(await runtime.stop(), "Telegram bridge disconnected.");
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime suspend waits for pending session auto-start before stopping", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    let releaseStart: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 10, cwd: "/repo" } }),
    );
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start:begin");
        await started;
        events.push("start:end");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });

    await runtime.onSessionStart({}, { cwd: "/repo" });
    await waitForCondition(() => events.includes("start:begin"));
    const suspend = runtime.suspend();
    releaseStart?.();
    await suspend;
    assert.deepEqual(events, ["start:begin", "start:end", "stop"]);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime does not auto-start when run mode disallows polling", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 10, cwd: "/repo" } }),
    );
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      canStartPolling: (ctx: { cwd: string; mode?: string }) =>
        ctx.mode !== "print",
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    await runtime.onSessionStart({}, { cwd: "/repo", mode: "print" });
    assert.deepEqual(events, []);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Suspension proof requires completion in the current polling generation", async () => {
  for (const race of ["none", "failure", "restart", "newer-suspend"] as const) {
    const temp = createTempLockPath();
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    let hold = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createTelegramLockedPollingRuntime({
      lock, hasBotToken: () => true, startPolling() {}, updateStatus() {},
      async stopPolling() {
        if (!hold) return;
        await gate;
        if (race === "failure") throw new Error("stop failed");
      },
    });
    try {
      assert.equal(runtime.isSuspended(), false);
      await runtime.start({ cwd: "/repo" });
      const stopping = runtime.suspend();
      assert.equal(runtime.isSuspended(), false, "an issued stop is not completion");
      if (race === "restart") await runtime.start({ cwd: "/repo" });
      if (race === "newer-suspend") {
        hold = false;
        await runtime.suspend();
        assert.equal(runtime.isSuspended(), false, "the older stop is still unsettled");
      }
      release();
      if (race === "failure") await assert.rejects(stopping, /stop failed/);
      else await stopping;
      assert.equal(runtime.isSuspended(), race === "none", race);
      assert.equal(lock.owns({ cwd: "/repo" }), true, "suspension retains restart ownership");
    } finally {
      hold = false;
      release();
      await runtime.suspend();
      lock.release();
      rmSync(temp.dir, { recursive: true, force: true });
    }
  }
});

test("An unfinished explicit startup cannot certify quiescence even after its stale completion", async () => {
  const temp = createTempLockPath();
  const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runtime = createTelegramLockedPollingRuntime({
    lock, hasBotToken: () => true, startPolling: async () => { await gate; },
    async stopPolling() {}, updateStatus() {},
  });
  let starting: ReturnType<typeof runtime.start> | undefined;
  try {
    starting = runtime.start({ cwd: "/repo" });
    await Promise.resolve();
    await runtime.suspend();
    assert.equal(runtime.isSuspended(), false);
    release();
    await starting;
    assert.equal(runtime.isSuspended(), false, "a stale startup cannot revive an unproven stop");
    await runtime.suspend();
    assert.equal(runtime.isSuspended(), true);
  } finally {
    release();
    await starting;
    await runtime.suspend();
    lock.release();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime suspends session replacement without releasing ownership", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    assert.equal((await runtime.start({ cwd: "/repo" })).ok, true);
    await runtime.suspend();
    assert.deepEqual(events, ["start", "status", "stop"]);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Persistent conflicts stop watchers and monitoring, revoke sends, and release only exact ownership", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  for (const scenario of ["owned", "lost", "release-failure"] as const) {
    const temp = createTempLockPath();
    const ctx = { cwd: "/repo" };
    const lock = createTelegramLockRuntime({
      locksPath: temp.path, pid: 10, instanceId: "local", isProcessAlive: () => true,
    });
    let refreshes = 0;
    let checks = 0;
    const refresh = lock.refresh;
    const owns = lock.owns;
    lock.refresh = (owner) => { refreshes++; return refresh(owner); };
    lock.owns = (owner) => { checks++; return owns(owner); };
    let stops = 0;
    let monitoring = false;
    const availability: boolean[] = [];
    const diagnostics: Array<Record<string, unknown> | undefined> = [];
    const runtime = createTelegramLockedPollingRuntime({
      lock, hasBotToken: () => true, ownershipCheckMs: 1, ownershipRefreshMs: 2,
      startPolling: async () => {}, stopPolling: async () => { stops++; },
      transportMonitor: { start: () => { monitoring = true; }, stop: () => { monitoring = false; } },
      onTransportAvailabilityChanged: () => { availability.push(lock.owns(ctx)); },
      updateStatus: () => {},
      recordRuntimeEvent: (_category, _error, details) => { diagnostics.push(details); },
    });
    try {
      assert.equal((await runtime.start(ctx)).ok, true);
      t.mock.timers.tick(4);
      assert.ok(refreshes > 1);
      let replacement: unknown;
      if (scenario === "lost") {
        const other = createTelegramLockRuntime({
          locksPath: temp.path, pid: 20, instanceId: "other", isProcessAlive: () => true,
        });
        const expectedOwner = readLocks(temp.path)[TELEGRAM_LOCK_KEY] as TelegramLockEntry;
        assert.equal(other.acquire(ctx, { force: true, expectedOwner }).ok, true);
        replacement = readLocks(temp.path)[TELEGRAM_LOCK_KEY];
      } else if (scenario === "release-failure") {
        writeFileSync(temp.path, "{");
      }
      await runtime.onPersistentConflict(ctx, 10);
      const stoppedCounts = [checks, refreshes];
      t.mock.timers.tick(100);
      await runtime.onPersistentConflict(ctx, 10);
      assert.deepEqual([checks, refreshes], stoppedCounts, "Watchers must stay stopped");
      assert.equal(stops, 1);
      assert.equal(monitoring, false);
      assert.deepEqual(availability, [true, false]);
      assert.equal(lock.owns(ctx), false);
      assert.equal(lock.getOwnedLeaderEpoch(), undefined);
      assert.equal(lock.commitIfOwned(() => assert.fail("Revoked direct effect")), false);
      assert.equal(lock.refresh(ctx), false);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0]?.phase, "persistent-conflict");
      assert.equal(diagnostics[0]?.ownership, scenario === "release-failure" ? "unverifiable" : scenario);
      if (scenario === "release-failure") {
        assert.equal(readFileSync(temp.path, "utf8"), "{");
        assert.ok(Array.isArray(diagnostics[0]?.cleanupErrors));
      } else {
        assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], replacement);
      }
    } finally {
      await runtime.suspend();
      rmSync(temp.dir, { recursive: true, force: true });
    }
  }
});

test("Captured disconnect cannot stop or release a replacement connection", async () => {
  for (const replacementAt of ["before-stop", "during-stop"] as const) {
    const temp = createTempLockPath();
    const ctx = { cwd: "/repo" };
    const lock = createTelegramLockRuntime({
      locksPath: temp.path, pid: 10, instanceId: "local", isProcessAlive: () => true,
    });
    let stops = 0;
    let releaseStop!: () => void;
    const heldStop = new Promise<void>((resolve) => { releaseStop = resolve; });
    const runtime = createTelegramLockedPollingRuntime({
      lock, hasBotToken: () => true, startPolling: async () => {}, updateStatus: () => {},
      stopPolling: async () => {
        stops++;
        if (replacementAt === "during-stop" && stops === 1) await heldStop;
      },
    });
    try {
      assert.equal((await runtime.start(ctx)).ok, true);
      const captured = runtime.captureStop();
      assert.equal(captured.isCurrent(), true);
      const stopping = replacementAt === "during-stop" ? captured.stop() : undefined;
      assert.equal((await runtime.start(ctx)).ok, true);
      const replacement = readFileSync(temp.path, "utf8");
      const epoch = lock.getOwnedLeaderEpoch();
      assert.equal(captured.isCurrent(), false);
      releaseStop();
      const [settlement] = await Promise.allSettled([stopping ?? captured.stop()]);
      assert.equal(stops, replacementAt === "during-stop" ? 1 : 0);
      assert.equal(readFileSync(temp.path, "utf8"), replacement);
      assert.equal(lock.getOwnedLeaderEpoch(), epoch);
      assert.equal(lock.owns(ctx), true);
      assert.equal(lock.commitIfOwned(() => true), true);
      assert.equal(runtime.captureTransportAuthority(ctx)?.(), true);
      assert.equal(settlement.status, "rejected");
      if (settlement.status === "rejected") assert.match(String(settlement.reason), /superseded by a new connection/);
    } finally {
      releaseStop();
      await runtime.suspend();
      rmSync(temp.dir, { recursive: true, force: true });
    }
  }
});

test("A failed durable release stays locally revoked until explicit acquisition mints a new epoch", () => {
  const temp = createTempLockPath();
  const ctx = { cwd: "/repo" };
  const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10, instanceId: "local" });
  try {
    lock.acquire(ctx);
    const epoch = lock.getOwnedLeaderEpoch();
    const original = readFileSync(temp.path, "utf8");
    writeFileSync(temp.path, "{");
    assert.throws(() => lock.release());
    writeFileSync(temp.path, original);
    assert.equal(lock.owns(ctx), false, "Repair must not resurrect revoked authority");
    assert.equal(lock.commitIfOwned(() => assert.fail("Revoked publication")), false);
    assert.equal(lock.refresh(ctx), false);
    assert.equal(lock.acquire(ctx).ok, true);
    assert.equal(lock.owns(ctx), true);
    assert.notEqual(lock.getOwnedLeaderEpoch(), epoch);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Conflict fencing accepts same-session context rotation but rejects a replaced session", async () => {
  const temp = createTempLockPath();
  const pollContext = { cwd: "/repo", generation: 1 };
  let generation = 1;
  let stops = 0;
  const lock = createTelegramLockRuntime<typeof pollContext>({ locksPath: temp.path, pid: 10 });
  const runtime = createTelegramLockedPollingRuntime({
    lock, hasBotToken: () => true,
    isContextCurrent: (ctx) => ctx.generation === generation,
    startPolling: async () => {}, stopPolling: async () => { stops++; }, updateStatus: () => {},
  });
  try {
    await runtime.start(pollContext);
    await runtime.start({ ...pollContext });
    await runtime.onPersistentConflict(pollContext, 10);
    assert.equal(stops, 1, "An existing poller may retain the preceding command context");
    assert.equal(lock.owns(pollContext), false);
    generation++;
    const replacement = { cwd: "/repo", generation };
    await runtime.start(replacement);
    await runtime.onPersistentConflict(pollContext, 10);
    assert.equal(stops, 1);
    assert.equal(lock.owns(replacement), true);
  } finally {
    await runtime.stop();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("A later suspend, disconnect, or session replacement cancels a reconnect waiting for conflict teardown", async () => {
  for (const cancellation of ["suspend", "disconnect", "replacement"] as const) {
    const temp = createTempLockPath();
    const ctx = { cwd: "/repo" };
    let current = ctx;
    let finishStop!: () => void;
    const gate = new Promise<void>((resolve) => { finishStop = resolve; });
    let polling = false;
    let monitoring = false;
    let acquisitions = 0;
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const acquire = lock.acquire;
    lock.acquire = (...args) => { acquisitions++; return acquire(...args); };
    const runtime = createTelegramLockedPollingRuntime({
      lock, hasBotToken: () => true, isContextCurrent: (context) => context === current,
      startPolling: async (context) => { if (context === current) polling = true; },
      stopPolling: async () => { await gate; polling = false; },
      transportMonitor: {
        start: () => { monitoring = true; }, stop: () => { monitoring = false; },
      },
      updateStatus: () => {},
    });
    try {
      assert.equal((await runtime.start(ctx)).ok, true);
      polling = false; // The controller detaches before notifying the locked lifecycle.
      const conflict = runtime.onPersistentConflict(ctx, 10);
      const reconnect = runtime.start(ctx);
      const halted = cancellation === "disconnect" ? runtime.stop() : runtime.suspend();
      if (cancellation === "replacement") current = { cwd: "/repo" };
      finishStop();
      await Promise.all([conflict, halted]);
      assert.equal((await reconnect).ok, false, cancellation);
      assert.equal(acquisitions, 1, "Cancelled reconnect must never reacquire the lock");
      assert.equal(polling, false);
      assert.equal(monitoring, false);
      assert.equal(lock.owns(current), false);
      assert.equal((await runtime.start(current)).ok, true, "A fresh explicit connect remains valid");
      assert.equal(polling, true);
    } finally {
      finishStop();
      await runtime.stop();
      rmSync(temp.dir, { recursive: true, force: true });
    }
  }
});

test("Cancelled startup continuations cannot start transport or tear down a replacement", async () => {
  for (const boundary of ["acquired", "polling"] as const) {
    for (const outcome of ["resolve", "reject"] as const) {
      const temp = createTempLockPath();
      const old = { cwd: "/repo" };
      const replacement = { cwd: "/repo" };
      let finish!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { finish = resolve; });
      const pause = async () => {
        entered();
        await gate;
        if (outcome === "reject") throw new Error("Obsolete startup failed");
      };
      const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
      const starts: typeof old[] = [];
      let stops = 0;
      const runtime = createTelegramLockedPollingRuntime({
        lock, hasBotToken: () => true,
        startPolling: async (ctx) => {
          starts.push(ctx);
          if (ctx === old && boundary === "polling") await pause();
        },
        stopPolling: async () => { stops++; }, updateStatus: () => {},
      });
      try {
        const staleStart = runtime.start(old, boundary === "acquired" ? { onAcquired: pause } : {});
        await started;
        await runtime.suspend();
        assert.equal((await runtime.start(replacement)).ok, true);
        finish();
        assert.equal((await staleStart).ok, false);
        assert.deepEqual(starts, boundary === "acquired" ? [replacement] : [old, replacement]);
        assert.equal(stops, 1, "A stale rejection must not roll back the replacement");
        assert.equal(lock.owns(replacement), true);
      } finally {
        finish();
        await runtime.stop();
        rmSync(temp.dir, { recursive: true, force: true });
      }
    }
  }
});

test("Conflict teardown serializes reconnect and ignores an obsolete session signal", async () => {
  const temp = createTempLockPath();
  const oldContext = { cwd: "/repo" };
  const newContext = { cwd: "/repo" };
  const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
  let finishStop!: () => void;
  let stops = 0;
  const pending = new Promise<void>((resolve) => { finishStop = resolve; });
  const runtime = createTelegramLockedPollingRuntime({
    lock, hasBotToken: () => true, startPolling: async () => {},
    stopPolling: async () => { stops++; await pending; }, updateStatus: () => {},
  });
  try {
    await runtime.start(oldContext);
    const stopped = runtime.onPersistentConflict(oldContext, 10);
    const restarted = runtime.start(newContext);
    assert.equal(lock.owns(oldContext), false);
    finishStop();
    await stopped;
    assert.equal((await restarted).ok, true);
    await runtime.onPersistentConflict(oldContext, 10);
    assert.equal(stops, 1);
    assert.equal(lock.owns(newContext), true);
  } finally {
    finishStop();
    await runtime.stop();
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime stops after ownership loss without live context", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    const runtimeEvents: {
      category: string;
      phase: unknown;
      message: string;
    }[] = [];
    let availabilityChanges = 0;
    const ctx = { cwd: "/repo" };
    const lock = createTelegramLockRuntime({ locksPath: temp.path, pid: 10 });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      ownershipCheckMs: 1,
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
      onTransportAvailabilityChanged: () => {
        availabilityChanges += 1;
      },
      recordRuntimeEvent: (category, error, details) => {
        runtimeEvents.push({
          category,
          phase: details?.phase,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });
    assert.equal((await runtime.start(ctx)).ok, true);
    writeFileSync(temp.path, JSON.stringify({}));
    await waitForCondition(() => events.includes("stop"));
    assert.deepEqual(events, ["start", "status", "stop"]);
    assert.equal(availabilityChanges, 2);
    assert.deepEqual(
      runtimeEvents.map((event) => event.phase),
      ["ownership-lost"],
      "A serialized not-owner answer is definitive: record it and stand down without tolerance",
    );
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime tolerates a transient unverified ownership check", async () => {
  const events: string[] = [];
  const failureDetails: Record<string, unknown>[] = [];
  let unverifiedNextCheck = false;
  const lock = {
    acquire: () => ({
      ok: true,
      lock: { pid: 10, cwd: "/repo" },
      replacedStale: false as const,
    }),
    release: () => ({ kind: "inactive" as const }),
    getState: () => ({
      kind: "active-here" as const,
      lock: { pid: 10, cwd: "/repo" },
    }),
    getStatusLabel: () => "active here",
    getOwnedLeaderEpoch: () => undefined,
    getJournalPath: () => undefined,
    owns: () => !unverifiedNextCheck,
    commitIfOwned: (commit: () => void) => {
      commit();
      return true;
    },
    // The serialized confirmation is also unavailable for exactly one tick.
    refresh: () => {
      if (!unverifiedNextCheck) return true;
      unverifiedNextCheck = false;
      throw new Error("Telegram runtime state identity changed before reading.");
    },
  };
  const runtime = createTelegramLockedPollingRuntime({
    lock,
    hasBotToken: () => true,
    ownershipCheckMs: 1,
    ownershipRefreshMs: 1,
    startPolling: async () => {
      events.push("start");
    },
    stopPolling: async () => {
      events.push("stop");
    },
    updateStatus: () => {
      events.push("status");
    },
    recordRuntimeEvent: (_category, _error, details) => {
      if (details?.phase === "ownership-check-failed") {
        failureDetails.push(details);
      }
    },
  });
  assert.equal((await runtime.start({ cwd: "/repo" })).ok, true);
  unverifiedNextCheck = true;
  await waitForCondition(() => failureDetails.length > 0);
  assert.equal(failureDetails[0]?.consecutiveFailures, 1);
  assert.equal(
    failureDetails[0]?.tolerance,
    TELEGRAM_OWNERSHIP_CHECK_FAILURE_TOLERANCE,
  );
  // The next verified check resets the streak: polling must stay up.
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(events, ["start", "status"]);
  await runtime.stop();
  assert.deepEqual(events, ["start", "status", "stop"]);
});

for (const ownsReadable of [true, false]) test(`Locked polling runtime records refresh write failures instead of throwing from watcher (${ownsReadable ? "ownership verified" : "unverifiable"})`, async () => {
  const events: string[] = [];
  const runtimeEvents: {
    category: string;
    phase: unknown;
    message: string;
  }[] = [];
  let refreshCalls = 0;
  const lock = {
    acquire: () => ({
      ok: true,
      lock: { pid: 10, cwd: "/repo" },
      replacedStale: false as const,
    }),
    release: () => ({ kind: "inactive" as const }),
    getState: () => ({
      kind: "active-here" as const,
      lock: { pid: 10, cwd: "/repo" },
    }),
    getStatusLabel: () => "active here",
    getOwnedLeaderEpoch: () => undefined,
    getJournalPath: () => undefined,
    owns: () => ownsReadable || refreshCalls < 2,
    commitIfOwned: (commit: () => void) => {
      commit();
      return true;
    },
    refresh: () => {
      refreshCalls += 1;
      if (refreshCalls === 1) return true;
      throw new Error("EPERM: operation not permitted, rename locks tmp");
    },
  };
  const runtime = createTelegramLockedPollingRuntime({
    lock,
    hasBotToken: () => true,
    ownershipCheckMs: 1,
    ownershipRefreshMs: 1,
    startPolling: async () => {
      events.push("start");
    },
    stopPolling: async () => {
      events.push("stop");
    },
    updateStatus: () => {
      events.push("status");
    },
    recordRuntimeEvent: (category, error, details) => {
      runtimeEvents.push({
        category,
        phase: details?.phase,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
  assert.equal((await runtime.start({ cwd: "/repo" })).ok, true);
  if (ownsReadable) {
    // A failing write is not evidence of lost ownership while every check still verifies it.
    await waitForCondition(() => runtimeEvents.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(events, ["start", "status"]);
    await runtime.stop();
  } else {
    await waitForCondition(() => events.includes("stop"));
    assert.deepEqual(events, ["start", "status", "stop"]);
    assert.equal(runtimeEvents.length, TELEGRAM_OWNERSHIP_CHECK_FAILURE_TOLERANCE + 1);
  }
  assert.equal(runtimeEvents[0]?.category, "lock");
  assert.equal(runtimeEvents[0]?.phase, "ownership-check-failed");
  assert.match(runtimeEvents[0]?.message ?? "", /EPERM/);
});

test("Locked polling runtime resumes stale same-cwd ownership after process restart", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/repo" } }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: () => false,
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    await runtime.onSessionStart({}, { cwd: "/repo" });
    await waitForCondition(() => events.includes("status"));
    assert.deepEqual(events, ["start", "status"]);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 10,
      cwd: "/repo",
    });
    assert.equal(await runtime.stop(), "Telegram bridge disconnected.");
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Locked polling runtime does not claim stale ownership from another cwd during session initialization", async () => {
  const temp = createTempLockPath();
  try {
    const events: string[] = [];
    writeFileSync(
      temp.path,
      JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/other" } }),
    );
    const lock = createTelegramLockRuntime({
      locksPath: temp.path,
      pid: 10,
      isProcessAlive: () => false,
    });
    const runtime = createTelegramLockedPollingRuntime({
      lock,
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("start");
      },
      stopPolling: async () => {
        events.push("stop");
      },
      updateStatus: () => {
        events.push("status");
      },
    });
    await runtime.onSessionStart({}, { cwd: "/repo" });
    assert.deepEqual(events, []);
    assert.deepEqual(readLocks(temp.path)[TELEGRAM_LOCK_KEY], {
      pid: 99,
      cwd: "/other",
    });
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

test("Private file helpers publish owner-only contents and refuse unsafe or oversized reads", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-private-file-")), path = join(dir, "nested", "store.json");
  try {
    assert.equal(readTelegramPrivateFile(path, 64), undefined, "Absence is not a failure");
    const boundaries: string[] = [];
    publishTelegramPrivateFile(path, join(dir, "staging", "store.json"), "{\"ok\":true}\n", "Fixture", value => boundaries.push(value));
    assert.deepEqual(boundaries, ["after-write-before-rename", "after-rename"]);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(dir, "staging")), [], "Rename consumes the staging file");
    assert.equal(readTelegramPrivateFile(path, 64), "{\"ok\":true}\n");
    const failure = (fn: () => unknown, expected: string) => assert.throws(fn, error => error instanceof TelegramPrivateFileError && error.failure === expected);
    failure(() => readTelegramPrivateFile(path, 4), "capacity");
    rmSync(path); writeFileSync(path, "{}", { mode: 0o644 });
    failure(() => readTelegramPrivateFile(path, 64), "unsafe");
    rmSync(path); symlinkSync(join(dir, "elsewhere"), path);
    failure(() => readTelegramPrivateFile(path, 64), "unsafe");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
