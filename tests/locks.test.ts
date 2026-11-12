/**
 * Regression tests for Telegram transport ownership helpers
 * Covers owners.json authority, stale-owner replacement, and owner-gated polling behavior
 * Zones: telegram ownership, filesystem, transport authority
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
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
import { TelegramFollowerRegistrationCancelledError, type TelegramFollowerRegistrationResult, type TelegramFollowerRegistrationOptions } from "../lib/polling.ts";
import { createTelegramConfigStore } from "../lib/config.ts";
import { createTelegramTopicTargetStore } from "../lib/threads.ts";
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
import { readTelegramSyncBlockTotals } from "../lib/loop-lag.ts";

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

test("Current transport capture owns startup context across fresh same-session callers and sticky loss", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-current-transport-"));
  const sessions = createTelegramSessionContextStore<{ cwd: string; sessionId: string }>({ getIdentity: ctx => ctx.sessionId });
  const startup = { cwd: "/fixture", sessionId: "a" };
  const lock = createTelegramLockRuntime<typeof startup>({ locksPath: join(dir, "owners.json"), instanceId: "current-transport" });
  const runtime = createTelegramLockedPollingRuntime({
    lock, hasBotToken: () => true, isContextCurrent: ctx => sessions.isCurrent(ctx), getSessionId: ctx => ctx.sessionId,
    startPolling: () => undefined, stopPolling: async () => undefined, updateStatus: () => undefined,
  });
  try {
    assert.equal(runtime.captureCurrentTransportAuthority(), undefined);
    sessions.set(startup);
    assert.equal((await runtime.start(startup)).ok, true);
    const caller = { ...startup };
    sessions.set(caller);
    assert.equal(runtime.captureTransportAuthority(caller), undefined, "Legacy API still requires the exact startup context");
    const captured = runtime.captureCurrentTransportAuthority();
    assert.ok(captured);
    assert.equal(captured(), true);
    sessions.set({ ...caller });
    assert.equal(captured(), true, "Fresh same-session SDK context does not replace transport");
    await runtime.suspend();
    assert.equal(captured(), false);
    assert.equal(runtime.captureCurrentTransportAuthority(), undefined);
    assert.equal((await runtime.start(caller)).ok, true);
    assert.equal(captured(), false, "Restart never revives a capture");
    const fresh = runtime.captureCurrentTransportAuthority();
    assert.ok(fresh);
    lock.release();
    assert.equal(fresh(), false);
    assert.equal(lock.acquire(caller).ok, true);
    assert.equal(fresh(), false, "Restored ownership cannot revive observed loss");
    assert.equal(runtime.captureCurrentTransportAuthority(), undefined, "Observed owner loss requires a real polling restart");
    await runtime.start(caller);
    const sessionCapture = runtime.captureCurrentTransportAuthority();
    assert.ok(sessionCapture);
    sessions.set({ cwd: startup.cwd, sessionId: "b" });
    assert.equal(sessionCapture(), false);
    sessions.set(caller);
    assert.equal(sessionCapture(), false, "Observed session loss is sticky");
    assert.equal(runtime.captureCurrentTransportAuthority(), undefined, "Restoring equal session metadata cannot mint a new grant on lost transport");
  } finally { await runtime.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("Current transport capture refuses a missing session-validity port without weakening legacy capture", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-current-no-session-")), ctx = { cwd: dir };
  const lock = createTelegramLockRuntime({ locksPath: join(dir, "owners.json"), instanceId: "no-session-port" });
  const runtime = createTelegramLockedPollingRuntime({ lock, hasBotToken: () => true, startPolling() {}, async stopPolling() {}, updateStatus() {} });
  try { await runtime.start(ctx); assert.equal(runtime.captureCurrentTransportAuthority(), undefined); assert.equal(runtime.captureTransportAuthority(ctx)?.(), true); }
  finally { await runtime.stop(); rmSync(dir, { recursive: true, force: true }); }
});

for (const loss of ["epoch", "throw", "conflict", "same-object-session"] as const)
test(`Current transport capture observes real ownership loss without restoration (${loss})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-current-loss-")), ctx = { cwd: dir, sessionId: "loss-session" };
  const lock = createTelegramLockRuntime({ locksPath: join(dir, "owners.json"), instanceId: "current-loss" });
  const sessions = createTelegramSessionContextStore<typeof ctx>(); sessions.set(ctx);
  const runtime = createTelegramLockedPollingRuntime({ lock, hasBotToken: () => true, isContextCurrent: sessions.isCurrent, getSessionId: ctx => ctx.sessionId, startPolling() {}, async stopPolling() {}, updateStatus() {} });
  try {
    await runtime.start(ctx); const grant = runtime.captureCurrentTransportAuthority()!; assert.ok(grant);
    if (loss === "epoch") { lock.release(); lock.acquire(ctx); }
    if (loss === "throw") {
      const owns = lock.owns; lock.owns = () => { throw new Error("Unverifiable owner"); };
      assert.equal(grant(), false); assert.equal(runtime.captureCurrentTransportAuthority(), undefined); lock.owns = owns;
    }
    if (loss === "conflict") await runtime.onPersistentConflict(ctx, 3);
    if (loss === "same-object-session") {
      ctx.sessionId = "replacement";
      assert.equal(grant(), false, "A mutable host context cannot hide session replacement");
      ctx.sessionId = "loss-session";
      assert.equal(runtime.captureCurrentTransportAuthority(), undefined);
    }
    assert.equal(grant(), false);
    await runtime.start(ctx); assert.ok(runtime.captureCurrentTransportAuthority()); assert.equal(grant(), false);
  } finally { await runtime.stop(); rmSync(dir, { recursive: true, force: true }); }
});

function createTempLockPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-owners-"));
  return { dir, path: join(dir, "owners.json") };
}

for (const artifact of ["source", "compiled"] as const)
test(`Runtime opened-file refusal retains its first finite condition (${artifact})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-state-read-condition-")), path = join(dir, "state.json");
  const moduleUrl = new URL(artifact === "source" ? "../lib/locks.ts" : "../dist/lib/locks.js", import.meta.url).href;
  try {
    const result = await runNodeEval(`
      import assert from "node:assert/strict";
      import * as fs from "node:fs";
      import { mock } from "node:test";
      const path = ${JSON.stringify(path)};
      let fault, lastFd, publishing = false, contentReads = 0;
      const { default: defaultFs, ...namedFs } = fs;
      mock.module("node:fs", { defaultExport: defaultFs, namedExports: { ...namedFs,
        lstatSync(...args) {
          const actual = fs.lstatSync(...args);
          if (args[0] === path && fault === "native-rename") {
            fault = undefined; publishing = true;
            try { Kernel.mutateTelegramRuntimeStateSection(path, "default", "runtime", () => ({ value: { boundary: "native-rename" }, result: true }), { isCurrent: () => true }); }
            finally { publishing = false; }
          }
          return actual;
        },
        fstatSync(...args) {
          lastFd = args[0];
          const actual = fs.fstatSync(...args), selected = fault;
          if (!selected) return actual;
          fault = undefined;
          return new Proxy(actual, { get(target, key) {
            if (selected === "first" && key !== "dev") throw new Error("Later checks ran after the first refusal");
            if ((selected === "device" || selected === "first") && key === "dev") return target.dev === 0 ? 1 : 0;
            if (selected === "inode" && key === "ino") return target.ino === 0 ? 1 : 0;
            if (selected === "links" && key === "nlink") return 0;
            if (selected === "type" && key === "isFile") return () => false;
            if (selected === "mode" && key === "mode") return target.mode | 0o040;
            return Reflect.get(target, key);
          } });
        },
        readFileSync(...args) {
          if (!publishing && typeof args[0] === "number") contentReads++;
          return fs.readFileSync(...args);
        },
      } });
      const Kernel = await import(${JSON.stringify(moduleUrl)});
      Kernel.mutateTelegramRuntimeStateSection(path, "default", "workspace", () => ({ value: { retained: true }, result: true }), { isCurrent: () => true });
      const cases = [
        ["device", "device-mismatch"], ["inode", "inode-mismatch"],
        ["links", "opened-links"], ["type", "opened-type"],
        ["mode", process.platform === "win32" ? undefined : "opened-mode"],
        ["first", "device-mismatch"], ["native-rename", "inode-mismatch"],
      ];
      for (const [selected, expected] of cases) {
        fault = selected; contentReads = 0; lastFd = undefined;
        let original;
        try { Kernel.readTelegramRuntimeState(path); } catch (error) { original = error; }
        if (expected === undefined) assert.equal(original, undefined, "Windows retains its existing private-mode policy");
        else {
          assert.ok(original instanceof Kernel.TelegramRuntimeStateError);
          assert.equal(original.name, "TelegramRuntimeStateError");
          assert.equal(original.code, "invalid");
          assert.equal(original.message, "Telegram runtime state identity changed before reading.");
          assert.equal(original.readCondition, expected);
          assert.equal(original.cause, undefined);
        }
        assert.equal(contentReads, expected === undefined ? 1 : 0, "The original reader never parses a rejected descriptor; publisher reads are separate");
        assert.throws(() => fs.fstatSync(lastFd), { code: "EBADF" }, "The original descriptor closes on success or refusal");
      }
      const current = Kernel.readTelegramRuntimeState(path);
      assert.deepEqual(current.profiles.default.workspace, { retained: true });
      assert.deepEqual(current.profiles.default.runtime, { boundary: "native-rename" }, "The actual guarded atomic publication remains committed");
      fs.writeFileSync(path, "{", { mode: 0o600 });
      assert.throws(() => Kernel.readTelegramRuntimeState(path), error => error instanceof Kernel.TelegramRuntimeStateError && error.readCondition === undefined);
      console.log(JSON.stringify({ descriptorPartitions: 6, nativeRename: true, malformedStillRefused: true }));
    `, { nodeArgs: ["--experimental-test-module-mocks"] });
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.signal, null);
    assert.deepEqual(JSON.parse(result.stdout), { descriptorPartitions: 6, nativeRename: true, malformedStillRefused: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const artifact of ["source", "compiled"] as const)
test(`Runtime post-read refusal retains its first finite condition (${artifact})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pt-state-post-read-")), path = join(dir, "state.json");
  const moduleUrl = new URL(artifact === "source" ? "../lib/locks.ts" : "../dist/lib/locks.js", import.meta.url).href;
  try {
    const result = await runNodeEval(`
      import assert from "node:assert/strict";
      import * as fs from "node:fs";
      import { mock } from "node:test";
      const path = ${JSON.stringify(path)};
      let fault, lastFd, publishing = false, contentReads = 0, observations = 0;
      const { default: defaultFs, ...namedFs } = fs;
      mock.module("node:fs", { defaultExport: defaultFs, namedExports: { ...namedFs,
        lstatSync(...args) {
          const actual = fs.lstatSync(...args);
          if (args[0] !== path || publishing || ++observations !== 2 || !fault) return actual;
          const selected = fault; fault = undefined;
          const fields = ["dev", "ino", "size", "mtimeMs", "ctimeMs"];
          const firstIndex = { device: 0, inode: 1, size: 2, mtime: 3, ctime: 4, first: 0 }[selected];
          return new Proxy(actual, { get(target, key) {
            if (fields.indexOf(key) > firstIndex) throw new Error("Later checks ran after the first refusal");
            if ((selected === "device" || selected === "first") && key === "dev") return target.dev === 0 ? 1 : 0;
            if (selected === "inode" && key === "ino") return target.ino === 0 ? 1 : 0;
            if (selected === "size" && key === "size") return target.size + 1;
            if (selected === "mtime" && key === "mtimeMs") return target.mtimeMs + 1;
            if (selected === "ctime" && key === "ctimeMs") return target.ctimeMs + 1;
            return Reflect.get(target, key);
          } });
        },
        readFileSync(...args) {
          if (!publishing && typeof args[0] === "number") { lastFd = args[0]; contentReads++; }
          return fs.readFileSync(...args);
        },
        closeSync(fd) {
          fs.closeSync(fd);
          if (!publishing && fd === lastFd && fault === "native-rename") {
            fault = undefined; publishing = true;
            try { Kernel.mutateTelegramRuntimeStateSection(path, "default", "runtime", () => ({ value: { boundary: "post-read-publication" }, result: true }), { isCurrent: () => true }); }
            finally { publishing = false; }
          }
        },
      } });
      const Kernel = await import(${JSON.stringify(moduleUrl)});
      Kernel.mutateTelegramRuntimeStateSection(path, "default", "workspace", () => ({ value: { retained: true }, result: true }), { isCurrent: () => true });
      const cases = [
        ["device", "post-read-device-mismatch"], ["inode", "post-read-inode-mismatch"],
        ["size", "post-read-size-mismatch"], ["mtime", "post-read-mtime-mismatch"],
        ["ctime", "post-read-ctime-mismatch"], ["first", "post-read-device-mismatch"],
        ["native-rename", "post-read-inode-mismatch"], [undefined, undefined],
      ];
      for (const [selected, expected] of cases) {
        fault = selected; lastFd = undefined; contentReads = 0; observations = 0;
        let original;
        try { Kernel.readTelegramRuntimeState(path); } catch (error) { original = error; }
        if (expected === undefined) assert.equal(original, undefined);
        else {
          assert.ok(original instanceof Kernel.TelegramRuntimeStateError);
          assert.equal(original.name, "TelegramRuntimeStateError");
          assert.equal(original.code, "invalid");
          assert.equal(original.message, "Telegram runtime state changed during observation.");
          assert.equal(original.readCondition, expected);
          assert.equal(original.cause, undefined);
        }
        assert.equal(contentReads, 1, "The original reader never retries; guarded publisher reads are separate");
        assert.equal(observations, 2, "Initial and final observations retain their original order and count");
        assert.throws(() => fs.fstatSync(lastFd), { code: "EBADF" }, "The original descriptor is closed before the final refusal");
      }
      const current = Kernel.readTelegramRuntimeState(path);
      assert.deepEqual(current.profiles.default.workspace, { retained: true });
      assert.deepEqual(current.profiles.default.runtime, { boundary: "post-read-publication" }, "The guarded publication remains committed despite the original reader refusal");
      console.log(JSON.stringify({ postReadPartitions: 6, nativePublication: true, healthyRead: true }));
    `, { nodeArgs: ["--experimental-test-module-mocks"] });
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.signal, null);
    assert.deepEqual(JSON.parse(result.stdout), { postReadPartitions: 6, nativePublication: true, healthyRead: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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

for (const phase of ["entry", "validation", "staged", "published"] as const)
test(`Explicit state recovery rechecks original authority around publication (${phase})`, () => {
  const temp = createTempLockPath(), path = join(temp.dir, "state.json"), runtimeDir = join(temp.dir, "runtime");
  const before = JSON.stringify({ version: 2, profiles: { default: { workspace: "invalid-fixture" } } });
  let active = true, checks = 0;
  const assertCurrent = () => {
    checks++;
    if (phase === "entry" || phase === "staged" && existsSync(runtimeDir) && readdirSync(runtimeDir).some(name => name.endsWith(".tmp")) ||
      phase === "published" && readFileSync(path, "utf8") !== before) active = false;
    if (!active) throw new Error("Original recovery authority ended");
  };
  try {
    writeFileSync(path, before, { mode: 0o600 });
    assert.throws(() => resetDamagedTelegramRuntimeState(path, () => {
      if (phase === "validation") active = false;
      throw new Error("Fixture invalid Workspace");
    }, assertCurrent), /Original recovery authority ended/u);
    assert.ok(checks > 0);
    if (phase === "published") assert.deepEqual(readTelegramRuntimeState(path), { version: 2, profiles: {} }, "Lost post-publication authority cannot roll back the committed reset");
    else assert.equal(readFileSync(path, "utf8"), before, "Lost authority before rename preserves the original state");
    if (existsSync(runtimeDir)) assert.deepEqual(readdirSync(runtimeDir), [], "Only fixture-owned temporary preparation is removed");
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

for (const loss of ["caller", "context", "session", "generation", "callout", "reentry"] as const)
test(`Connection preparation cannot revive an observed original loss (${loss})`, async () => {
  const temp = createTempLockPath(), ctx = { cwd: "/repo" };
  let caller = true, context = true, session = "original", resets = 0, stopped: Promise<void> | undefined;
  let readError = false, reentry = false, originalAssert: (() => void) | undefined;
  const isCurrent = () => {
    if (readError) throw new Error("Fixture currentness read failed");
    if (reentry) { try { originalAssert!(); } catch {} }
    return caller;
  };
  const runtime = createTelegramLockedPollingRuntime({
    lock: createTelegramLockRuntime({ statePath: join(temp.dir, "state.json") }),
    hasBotToken: () => true, isContextCurrent: () => context, getSessionId: () => session,
    startPolling: async () => assert.fail("Preparation cannot start a poller"), stopPolling: async () => {}, updateStatus() {},
    resetDamagedState(assertCurrent) {
      resets++;
      originalAssert = assertCurrent;
      if (loss === "callout") readError = true;
      if (loss === "reentry") reentry = true;
      if (loss === "caller") caller = false;
      if (loss === "context") context = false;
      if (loss === "session") session = "replacement";
      if (loss === "generation") stopped = runtime.suspend();
      assert.throws(assertCurrent, /cancelled or superseded|currentness read failed/u);
      caller = context = true; session = "original"; readError = reentry = false;
      assert.throws(assertCurrent, /cancelled or superseded/u, "Equal restored fields cannot revive the spent preparation");
      return false;
    },
  });
  try {
    assert.throws(() => runtime.prepareConnection(ctx, isCurrent), /cancelled or superseded/u);
    assert.equal(resets, 1);
    assert.equal(existsSync(join(temp.dir, "state.json")), false);
    await stopped;
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

for (const artifact of ["source", "compiled"] as const)
for (const succession of ["removed", "replacement", "logger"] as const)
test(`Transaction guard recensus distinguishes a released directory from invalid layout (${artifact}/${succession})`, { skip: process.platform === "win32" }, async () => {
  const moduleUrl = new URL(artifact === "source" ? "../lib/locks.ts" : "../dist/lib/locks.js", import.meta.url).href;
  const loggerUrl = new URL(artifact === "source" ? "../lib/logging.ts" : "../dist/lib/logging.js", import.meta.url).href;
  const result = await runNodeEval(String.raw`
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { spawn } from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { mock } from "node:test";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    const moduleUrl = ${JSON.stringify(moduleUrl)}, succession = ${JSON.stringify(succession)};
    const Model = await import(moduleUrl);
    let appendDone = false; const appendFailures = [];
    mock.module(moduleUrl, { namedExports: { ...Model, withTelegramFileTransaction(...args) {
      try { return Model.withTelegramFileTransaction(...args); }
      catch (error) { appendFailures.push({ name: error.name, code: error.code, reason: error.reason, phase: error.phase }); throw error; }
      finally { appendDone = true; }
    } } });
    const Logger = succession === "logger" ? await import(${JSON.stringify(loggerUrl)}) : undefined;
    const dir = fs.mkdtempSync(join(tmpdir(), "pt-guard-enumeration-")), logPath = join(dir, "logs.jsonl"), guard = logPath + ".transaction";
    const ready = join(dir, "ready"), release = join(dir, "release"), retired = join(dir, "retired");
    const replacementReady = join(dir, "replacement-ready"), replacementRelease = join(dir, "replacement-release");
    const source = [
      "import fs from 'node:fs'; import { withTelegramFileTransaction } from " + JSON.stringify(moduleUrl) + ";",
      "const guard = " + JSON.stringify(guard) + ";",
      "const wait = path => { const deadline = Date.now() + 5000; while (!fs.existsSync(path)) { if (Date.now() >= deadline) throw new Error('Owner fixture wait expired'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); } };",
      "withTelegramFileTransaction(guard, () => { fs.writeFileSync(" + JSON.stringify(ready) + ", String(process.pid)); wait(" + JSON.stringify(release) + "); });",
      "fs.writeFileSync(" + JSON.stringify(retired) + ", 'released');",
      ...(succession === "replacement" ? ["withTelegramFileTransaction(guard, () => { fs.writeFileSync(" + JSON.stringify(replacementReady) + ", 'ready'); wait(" + JSON.stringify(replacementRelease) + "); });"] : []),
    ].join("\n");
    const owner = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module"], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "", ownerResult;
    owner.stdout.resume(); owner.stderr.on("data", chunk => { stderr += chunk; });
    const complete = new Promise((resolve, reject) => { owner.once("error", reject); owner.once("close", (code, signal) => resolve({ code, signal })); });
    owner.stdin.end(source);
    const readdir = fs.readdirSync;
    let armed = true, observedEmpty = false, operations = 0;
    try {
      const startupDeadline = Date.now() + 5000;
      while (!fs.existsSync(ready) && Date.now() < startupDeadline) await delay(5);
      assert.equal(fs.readFileSync(ready, "utf8"), String(owner.pid));
      console.log("guard-enumeration-checkpoint ready");
      fs.readdirSync = function(path, ...args) {
        if (path !== guard || !armed) return Reflect.apply(readdir, fs, [path, ...args]);
        armed = false;
        const originalDirectory = fs.opendirSync(guard);
        try {
          fs.writeFileSync(release, "release original");
          const checkpoint = succession === "replacement" ? replacementReady : retired;
          const deadline = Date.now() + 5000;
          while (!fs.existsSync(checkpoint)) { if (Date.now() >= deadline) throw new Error("Original native owner did not release"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); }
          const entries = []; let entry;
          while ((entry = originalDirectory.readSync()) !== null) entries.push(entry.name);
          assert.deepEqual(entries, [], "The actual old directory descriptor enumerates no owner after native release");
          observedEmpty = true; return entries;
        } finally { originalDirectory.closeSync(); }
      };
      syncBuiltinESMExports();
      if (Logger) {
        const log = Logger.createTelegramRuntimeJsonlLog({ path: logPath, canReset: () => false });
        for (let index = 0; index < 25; index++) log.record({ at: index, category: "actual-native-batch", message: String(index) });
        const deadline = Date.now() + 2000;
        while (!appendDone && Date.now() < deadline) await delay(5);
        assert.equal(appendDone, true); assert.equal(observedEmpty, true);
        const records = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
        assert.equal(records.length, 25, JSON.stringify({ appendFailures, records: records.length }));
        assert.deepEqual(appendFailures, []);
        assert.deepEqual(records.map(row => row.message), Array.from({ length: 25 }, (_, index) => String(index)));
      } else {
        let failure;
        try { Model.withTelegramFileTransaction(guard, () => { operations++; }, { attempts: 3, retryDelayMs: 1 }); }
        catch (error) { failure = error; console.log(JSON.stringify({ name: error.name, code: error.code, reason: error.reason, phase: error.phase })); }
        assert.equal(observedEmpty, true);
        if (succession === "removed") { assert.equal(failure, undefined, "A consumed directory observation cannot become stable invalid-layout evidence"); assert.equal(operations, 1); }
        else {
          assert.equal(operations, 0, "A changed observation never grants entry past a live replacement");
          assert.match(failure?.message ?? "", /Timed out acquiring Telegram lock transaction/);
          const names = readdir(guard); assert.equal(names.length, 1);
          assert.equal(JSON.parse(fs.readFileSync(join(guard, names[0]), "utf8")).pid, owner.pid);
        }
      }
    } finally {
      fs.readdirSync = readdir; syncBuiltinESMExports();
      fs.writeFileSync(release, "release"); fs.writeFileSync(replacementRelease, "release");
      ownerResult = await complete;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(ownerResult, { code: 0, signal: null }, stderr);
    assert.equal(owner.killed, false);
  `, { nodeArgs: ["--experimental-test-module-mocks"], timeoutMs: 10000, readiness: { stdoutPrefix: "guard-enumeration-checkpoint ready", startupTimeoutMs: 10000 } });
  assert.equal(result.signal, null); assert.equal(result.code, 0, result.stdout + result.stderr);
});

for (const artifact of ["source", "compiled"] as const)
for (const format of ["directory", "legacy"] as const)
for (const fault of ["empty", "truncated", "null", "array", "zero-pid", "negative-pid", "fractional-pid", "unsafe-pid", "out-of-range-pid", "bad-clock", "empty-generation", "invalid-generation", "oversized", "unreadable"] as const)
test(`Unverifiable transaction owner refuses without contention sleeps (${artifact}/${format}/${fault})`, async t => {
  if (fault === "unreadable" && (process.platform === "win32" || process.getuid?.() === 0)) { t.skip("Requires POSIX file read denial"); return; }
  const locks = artifact === "source" ? await import("../lib/locks.ts") : await import("../dist/lib/locks.js");
  const lag = artifact === "source" ? { readTelegramSyncBlockTotals } : await import("../dist/lib/loop-lag.js");
  const temp = createTempLockPath(), path = `${temp.path}.transaction`;
  const owner = { pid: 2_147_483_647, acquiredAtMs: 1, generation: "fixture" };
  if (fault === "zero-pid") owner.pid = 0;
  if (fault === "negative-pid") owner.pid = -1;
  if (fault === "fractional-pid") owner.pid = 1.5;
  if (fault === "unsafe-pid") owner.pid = Number.MAX_SAFE_INTEGER + 1;
  if (fault === "out-of-range-pid") owner.pid = 2_147_483_648;
  if (fault === "bad-clock") owner.acquiredAtMs = -1;
  if (fault === "empty-generation") owner.generation = "";
  if (fault === "invalid-generation") owner.generation = "bad/generation";
  const body = fault === "empty" ? "" : fault === "truncated" ? "{" : fault === "null" ? "null" : fault === "array" ? "[]"
    : fault === "oversized" ? " ".repeat(8192) + JSON.stringify(owner) : JSON.stringify(owner);
  if (format === "directory") mkdirSync(path, { mode: 0o700 });
  const marker = format === "directory" ? join(path, "owner.fixture.json") : path;
  writeFileSync(marker, body, { mode: 0o600 });
  if (fault === "unreadable") chmodSync(marker, 0);
  const before = statSync(marker), waits = lag.readTelegramSyncBlockTotals()["transaction-lock-wait"]?.count ?? 0;
  let calls = 0;
  try {
    assert.throws(() => locks.withTelegramFileTransaction(path, () => { calls++; }, { attempts: 3, retryDelayMs: 1 }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "TelegramFileTransactionGuardError");
      const fields = Object.getOwnPropertyDescriptors(error);
      assert.equal(fields.resource?.value, path); assert.equal(fields.code?.value, "guard-unverifiable");
      assert.equal(fields.phase?.value, "acquire");
      assert.equal(fields.reason?.value, fault === "unreadable" ? "unavailable-owner" : "invalid-owner");
      if (fault === "unreadable") assert.equal((error.cause as NodeJS.ErrnoException)?.code, "EACCES");
      return true;
    });
    assert.equal(calls, 0); assert.equal(lag.readTelegramSyncBlockTotals()["transaction-lock-wait"]?.count ?? 0, waits);
    assert.equal(statSync(marker).ino, before.ino); assert.equal(statSync(marker).size, before.size);
    if (fault === "unreadable") { assert.equal(statSync(marker).mode, before.mode); chmodSync(marker, 0o600); }
    assert.equal(readFileSync(marker, "utf8"), body);
    if (format === "directory") assert.deepEqual(readdirSync(path), ["owner.fixture.json"]);
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

for (const artifact of ["source", "compiled"] as const)
for (const fault of ["extra-entry", "invalid-name", "wrong-generation", "owner-directory", "owner-symlink", "owner-hardlink", "zero-reclaim-pid", "padded-reclaim-pid", "empty-reclaim"] as const)
test(`Unsafe transaction layout cannot become dead-owner authority (${artifact}/${fault})`, async t => {
  if (fault === "owner-symlink" && process.platform === "win32") { t.skip("Requires POSIX symlink creation"); return; }
  const locks = artifact === "source" ? await import("../lib/locks.ts") : await import("../dist/lib/locks.js");
  const lag = artifact === "source" ? { readTelegramSyncBlockTotals } : await import("../dist/lib/loop-lag.js");
  const temp = createTempLockPath(), path = `${temp.path}.transaction`;
  mkdirSync(path, { mode: 0o700 });
  const body = fault === "empty-reclaim" ? "" : JSON.stringify({ pid: 2_147_483_647, acquiredAtMs: 1, generation: fault === "wrong-generation" ? "foreign" : "fixture" });
  const reclaimPid = fault === "zero-reclaim-pid" ? "0" : fault === "padded-reclaim-pid" ? "02147483647" : "2147483647";
  const marker = join(path, fault.includes("reclaim") ? `owner.reclaim.${reclaimPid}.00000000-0000-4000-8000-000000000000.json`
    : fault === "invalid-name" ? "unexpected.json" : "owner.fixture.json");
  const other = join(temp.dir, "private-original.json");
  writeFileSync(other, body, { mode: 0o600 });
  if (fault === "owner-directory") mkdirSync(marker, { mode: 0o700 });
  else if (fault === "owner-symlink") symlinkSync(other, marker);
  else if (fault === "owner-hardlink") linkSync(other, marker);
  else writeFileSync(marker, body, { mode: 0o600 });
  if (fault === "extra-entry") writeFileSync(join(path, "extra"), "keep", { mode: 0o600 });
  const names = readdirSync(path).sort(), waits = lag.readTelegramSyncBlockTotals()["transaction-lock-wait"]?.count ?? 0;
  let calls = 0;
  try {
    assert.throws(() => locks.withTelegramFileTransaction(path, () => { calls++; }, { attempts: 3, retryDelayMs: 1 }), error => {
      assert.ok(error instanceof Error); assert.equal(error.name, "TelegramFileTransactionGuardError");
      assert.equal(Object.getOwnPropertyDescriptor(error, "reason")?.value, fault === "wrong-generation" || fault.includes("reclaim") ? "invalid-owner" : "invalid-layout");
      return true;
    });
    assert.equal(calls, 0); assert.equal(lag.readTelegramSyncBlockTotals()["transaction-lock-wait"]?.count ?? 0, waits);
    assert.deepEqual(readdirSync(path).sort(), names); assert.equal(readFileSync(other, "utf8"), body);
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

for (const artifact of ["source", "compiled"] as const)
for (const phase of ["owner", "claim"] as const)
for (const bodyKind of ["live", "dead", "empty", "conflicting"] as const)
test(`Reserved transaction protocol assessment stays closed before activation (${artifact}/${phase}/${bodyKind})`, async () => {
  const locks = artifact === "source" ? await import("../lib/locks.ts") : await import("../dist/lib/locks.js");
  const lag = artifact === "source" ? { readTelegramSyncBlockTotals } : await import("../dist/lib/loop-lag.js");
  const temp = createTempLockPath(), path = `${temp.path}.transaction`, nonce = "00000000-0000-4000-8000-000000000000";
  const locatorPid = bodyKind === "dead" || bodyKind === "empty" ? 2_147_483_647 : process.pid;
  const generation = `v2-p${locatorPid}-${nonce}`;
  const markerName = phase === "owner" ? `owner.v2.${locatorPid}.${nonce}.json` : `owner.reclaim.v2.${locatorPid}.${nonce}.json`;
  const body = bodyKind === "empty" ? "" : JSON.stringify({ pid: bodyKind === "conflicting" ? 2_147_483_647 : locatorPid, acquiredAtMs: 1, generation });
  mkdirSync(path, { mode: 0o700 }); const marker = join(path, markerName);
  writeFileSync(marker, body, { mode: 0o600 }); const before = statSync(marker);
  const waits = lag.readTelegramSyncBlockTotals()["transaction-lock-wait"]?.count ?? 0;
  let calls = 0;
  try {
    // These are proposed protocol inputs, not a production v2 writer or metadata-loss recovery grant.
    assert.throws(() => locks.withTelegramFileTransaction(path, () => { calls++; }, { attempts: 2, retryDelayMs: 1 }), error => {
      assert.ok(error instanceof Error); assert.equal(error.name, "TelegramFileTransactionGuardError");
      assert.equal(Object.getOwnPropertyDescriptor(error, "reason")?.value, "invalid-layout"); return true;
    });
    assert.equal(calls, 0); assert.equal(lag.readTelegramSyncBlockTotals()["transaction-lock-wait"]?.count ?? 0, waits);
    assert.deepEqual(readdirSync(path), [markerName]); assert.equal(readFileSync(marker, "utf8"), body);
    assert.equal(statSync(marker).ino, before.ino);
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

function proposedGuardClaimName(original: { pid: number; nonce: string }, recoverer: { pid: number; nonce: string }): string {
  return `owner.reclaim.v2.${original.pid}.${original.nonce}.${recoverer.pid}.${recoverer.nonce}.json`;
}

function proposedGuardMarkerIdentity(marker: string) {
  const owner = /^owner\.v2\.(\d+)\.([0-9a-f-]{36})\.json$/u.exec(marker);
  if (owner) return { owner: { pid: Number(owner[1]), nonce: owner[2]! }, recoverer: undefined };
  const claim = /^owner\.reclaim\.v2\.(\d+)\.([0-9a-f-]{36})\.(\d+)\.([0-9a-f-]{36})\.json$/u.exec(marker);
  if (!claim) return undefined;
  return { owner: { pid: Number(claim[1]), nonce: claim[2]! }, recoverer: { pid: Number(claim[3]), nonce: claim[4]! } };
}

for (const artifact of ["source", "compiled"] as const)
for (const scenario of ["repeated", "contenders"] as const)
for (const metadata of ["complete", "empty"] as const)
test(`Proposed guard model retains evidence without granting raced rename authority (${artifact}/${scenario}/${metadata})`, async t => {
  const locks = artifact === "source" ? await import("../lib/locks.ts") : await import("../dist/lib/locks.js");
  const temp = createTempLockPath(), path = `${temp.path}.transaction`;
  try {
    // This is an executable filesystem model, not an activated v2 transaction implementation.
    const created = await runNodeEval(`
      import { mkdtempSync, writeFileSync, renameSync } from "node:fs";
      import { join } from "node:path";
      import { randomUUID } from "node:crypto";
      const path = ${JSON.stringify(path)}, original = { pid: process.pid, nonce: randomUUID(), acquiredAtMs: Date.now() };
      const staging = mkdtempSync(path + ".staged.");
      writeFileSync(join(staging, "owner.v2." + original.pid + "." + original.nonce + ".json"), JSON.stringify({ version: 2, owner: original }), { mode: 0o600 });
      renameSync(staging, path);
    `);
    assert.equal(created.code, 0, created.stdout + created.stderr);
    const initialMarker = readdirSync(path)[0]!;
    const original = (JSON.parse(readFileSync(join(path, initialMarker), "utf8")) as { owner: { pid: number; nonce: string } }).owner;
    if (metadata === "empty") writeFileSync(join(path, initialMarker), "");
    const bytes = readFileSync(join(path, initialMarker), "utf8");
    const assertClosed = () => {
      let calls = 0;
      assert.throws(() => locks.withTelegramFileTransaction(path, () => { calls++; }), /invalid-layout/);
      assert.equal(calls, 0); const names = readdirSync(path); assert.equal(names.length, 1);
      assert.equal(readFileSync(join(path, names[0]!), "utf8"), bytes);
    };
    const claim = async (expected: string) => {
      const result = await runNodeEval(`
        import assert from "node:assert/strict";
        import { readdirSync, renameSync } from "node:fs";
        import { join } from "node:path";
        import { randomUUID } from "node:crypto";
        const path = ${JSON.stringify(path)}, expected = ${JSON.stringify(expected)};
        const names = readdirSync(path); assert.equal(names.length, 1);
        if (names[0] !== expected) console.log("lost");
        else {
          const decode = ${proposedGuardMarkerIdentity.toString()}, observed = decode(names[0]); assert.ok(observed);
          for (const pid of [observed.owner.pid, observed.recoverer?.pid].filter(value => value !== undefined)) {
            assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH", "Only actual process absence supports this model step");
          }
          const claimName = ${proposedGuardClaimName.toString()};
          const next = claimName(observed.owner, { pid: process.pid, nonce: randomUUID() });
          try { renameSync(join(path, expected), join(path, next)); console.log("claimed"); }
          catch (error) { if (error.code !== "ENOENT") throw error; console.log("lost"); }
        }
      `);
      assert.equal(result.code, 0, result.stdout + result.stderr); return result.stdout.trim();
    };
    const readClaim = () => {
      const marker = readdirSync(path)[0]!;
      const fields = proposedGuardMarkerIdentity(marker);
      assert.ok(fields?.recoverer); assert.equal(fields.owner.pid, original.pid); assert.equal(fields.owner.nonce, original.nonce);
      assert.equal(readFileSync(join(path, marker), "utf8"), bytes);
      return { marker, recovererPid: fields.recoverer.pid, recovererNonce: fields.recoverer.nonce };
    };
    assertClosed();
    if (scenario === "contenders") {
      const reports = await Promise.all([claim(initialMarker), claim(initialMarker)]);
      assert.ok(reports.every(report => report === "claimed" || report === "lost"));
      readClaim(); assertClosed();
      // Windows can report success twice: a raced source rename is not a portable CAS or grant.
      t.diagnostic(`Observed rename reports: ${reports.join(", ")}; recovery authority remains unproved`);
      assert.equal(existsSync(join(temp.dir, "retired")), false);
      return;
    }
    assert.equal(await claim(initialMarker), "claimed");
    const first = readClaim(); assertClosed();
    if (scenario === "repeated") {
      assert.equal(await claim(first.marker), "claimed");
      assert.notEqual(readClaim().recovererNonce, first.recovererNonce); assertClosed();
    }
    const previous = readClaim();
    assert.throws(() => process.kill(previous.recovererPid, 0), error => (error as NodeJS.ErrnoException).code === "ESRCH");
    const parentClaim = proposedGuardClaimName(original, { pid: process.pid, nonce: randomUUID() });
    renameSync(join(path, previous.marker), join(path, parentClaim)); assertClosed();
    await assert.rejects(() => claim(parentClaim), /Only actual process absence supports this model step/);
    assert.deepEqual(readdirSync(path), [parentClaim]); assertClosed();
    const retired = join(temp.dir, "retired"); renameSync(path, retired);
    let freshCalls = 0;
    locks.withTelegramFileTransaction(path, () => {
      freshCalls++; const fresh = readdirSync(path)[0]!, body = readFileSync(join(path, fresh), "utf8");
      assert.throws(() => renameSync(join(path, parentClaim), join(path, "late-claim")), error => (error as NodeJS.ErrnoException).code === "ENOENT");
      assert.deepEqual(readdirSync(path), [fresh]); assert.equal(readFileSync(join(path, fresh), "utf8"), body);
    });
    assert.equal(freshCalls, 1); assert.equal(existsSync(path), false);
    assert.equal(readFileSync(join(retired, parentClaim), "utf8"), bytes);
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

for (const artifact of ["source", "compiled"] as const)
test(`Damaged recovery marker cannot bypass owner observation (${artifact})`, async () => {
  const locks = artifact === "source" ? await import("../lib/locks.ts") : await import("../dist/lib/locks.js");
  const temp = createTempLockPath(), path = `${temp.path}.transaction`, recovery = `${path}.recovery`;
  const body = JSON.stringify({ pid: 2_147_483_647, acquiredAtMs: 1, generation: "fixture" });
  writeFileSync(path, body, { mode: 0o600 }); mkdirSync(recovery, { mode: 0o700 });
  const marker = join(recovery, "owner.reclaim.2147483647.00000000-0000-4000-8000-000000000000.json");
  writeFileSync(marker, "", { mode: 0o600 }); let calls = 0;
  try {
    assert.throws(() => locks.withTelegramFileTransaction(path, () => { calls++; }, { attempts: 2, retryDelayMs: 0 }), error => {
      assert.ok(error instanceof Error); assert.equal(error.name, "TelegramFileTransactionGuardError");
      assert.equal(Object.getOwnPropertyDescriptor(error, "resource")?.value, recovery); return true;
    });
    assert.equal(calls, 0); assert.equal(readFileSync(path, "utf8"), body); assert.equal(readFileSync(marker, "utf8"), "");
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

for (const artifact of ["source", "compiled"] as const)
test(`Guard refusal distinguishes release after work from acquisition before work (${artifact})`, async () => {
  const locks = artifact === "source" ? await import("../lib/locks.ts") : await import("../dist/lib/locks.js");
  const temp = createTempLockPath(), path = `${temp.path}.transaction`;
  let calls = 0;
  try {
    assert.throws(() => locks.withTelegramFileTransaction(path, () => {
      calls++; writeFileSync(join(path, readdirSync(path)[0]!), "");
    }), error => {
      assert.ok(error instanceof Error); assert.equal(error.name, "TelegramFileTransactionGuardError");
      assert.equal(Object.getOwnPropertyDescriptor(error, "phase")?.value, "release"); return true;
    });
    assert.equal(calls, 1); const marker = readdirSync(path)[0]!;
    assert.equal(readFileSync(join(path, marker), "utf8"), "");
    assert.throws(() => locks.withTelegramFileTransaction(path, () => { calls++; }), error => {
      assert.ok(error instanceof Error); assert.equal(error.name, "TelegramFileTransactionGuardError");
      assert.equal(Object.getOwnPropertyDescriptor(error, "phase")?.value, "acquire"); return true;
    });
    assert.equal(calls, 1); assert.deepEqual(readdirSync(path), [marker]);
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

for (const artifact of ["source", "compiled"] as const)
test(`Valid live transaction ownership retains ordinary bounded contention (${artifact})`, async () => {
  const locks = artifact === "source" ? await import("../lib/locks.ts") : await import("../dist/lib/locks.js");
  const lag = artifact === "source" ? { readTelegramSyncBlockTotals } : await import("../dist/lib/loop-lag.js");
  const temp = createTempLockPath(), path = `${temp.path}.transaction`;
  let forbidden = 0;
  try {
    locks.withTelegramFileTransaction(path, () => {
      const marker = readdirSync(path)[0]!, body = readFileSync(join(path, marker), "utf8");
      const waits = lag.readTelegramSyncBlockTotals()["transaction-lock-wait"]?.count ?? 0;
      assert.throws(() => locks.withTelegramFileTransaction(path, () => { forbidden++; }, { attempts: 3, retryDelayMs: 1 }), /Timed out acquiring Telegram lock transaction/);
      assert.equal(lag.readTelegramSyncBlockTotals()["transaction-lock-wait"]!.count - waits, 2);
      assert.deepEqual(readdirSync(path), [marker]); assert.equal(readFileSync(join(path, marker), "utf8"), body);
    });
    assert.equal(forbidden, 0); assert.equal(existsSync(path), false);
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
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
      { mode: 0o600 },
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
    writeFileSync(`${temp.path}.transaction`, "", { mode: 0o600 });
    assert.throws(
      () =>
        withTelegramFileTransaction(
          `${temp.path}.transaction`,
          () => undefined,
          { attempts: 2, retryDelayMs: 0 },
        ),
      /Cannot verify Telegram lock transaction guard \(invalid-owner\)/,
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
      /Cannot verify Telegram lock transaction guard \(invalid-layout\)/,
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

for (const fault of ["none", "heartbeat", "profile", "epoch", "endpoint", "auth", "runtime", "missing", "caught-loss", "caller-object"] as const)
test(`Follower owner scope binds its original profile and immutable routing identity (${fault})`, () => {
  const temp = createTempLockPath();
  let profile = "default";
  const expected = { pid: 99, cwd: "/leader", instanceId: "leader", leaderEpoch: "epoch", runtimeGeneration: 1,
    busSocketPath: "original.sock", busSecret: "fixture-secret", heartbeatMs: 1 };
  const write = (owner: typeof expected) => writeFileSync(temp.path, JSON.stringify({ default: owner, work: { ...expected } }));
  const lock = createTelegramLockRuntime({ locksPath: temp.path, key: () => profile, pid: 10, isProcessAlive: pid => pid === 99 });
  try {
    write(expected);
    const current = lock.captureFollowerRegistrationScope(expected);
    assert.equal(current(), true);
    if (fault === "profile") profile = "work";
    if (fault === "epoch") write({ ...expected, leaderEpoch: "replacement" });
    if (fault === "endpoint") write({ ...expected, busSocketPath: "replacement.sock" });
    if (fault === "auth") write({ ...expected, busSecret: "replacement-secret" });
    if (fault === "runtime") write({ ...expected, runtimeGeneration: 2 });
    if (fault === "heartbeat") write({ ...expected, heartbeatMs: 2 });
    if (fault === "missing") writeFileSync(temp.path, "{}");
    if (fault === "caught-loss") { profile = "work"; assert.equal(current(), false); profile = "default"; }
    if (fault === "caller-object") expected.leaderEpoch = "caller-mutated";
    const before = readFileSync(temp.path, "utf8");
    const positive = fault === "none" || fault === "heartbeat" || fault === "caller-object";
    assert.equal(current(), positive);
    assert.equal(readFileSync(temp.path, "utf8"), before, "Scope observation cannot acquire, repair or publish state");
    if (!positive) { profile = "default"; write(expected); assert.equal(current(), false, "Equal owner restoration cannot renew the old scope"); }
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

test("Locked polling runtime registers as follower when another live owner blocks start", async () => {
  const temp = createTempLockPath();
  const recovery: boolean[] = [];
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
      registerFollowerWithOwner: async (ctx, owner, options) => {
        recovery.push(options?.recoverConnection === true);
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
    assert.deepEqual(recovery, [false]);
    assert.equal((await runtime.start({ cwd: "/repo" }, { forceFreshLeaderThread: true })).ok, true);
    assert.deepEqual(recovery, [false, true]);
  } finally {
    rmSync(temp.dir, { recursive: true, force: true });
  }
});

for (const mode of ["pending", "classic", "registered"] as const)
test(`Locked polling classifies original follower readiness without truthy grants (${mode})`, async () => {
  const temp = createTempLockPath(), before = JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/leader", instanceId: "leader", leaderEpoch: "original" } });
  let starts = 0, statuses = 0, proofs = 0;
  const phases: unknown[] = [];
  const runtime = createTelegramLockedPollingRuntime({
    lock: createTelegramLockRuntime({ locksPath: temp.path, pid: 10, isProcessAlive: pid => pid === 99 }),
    hasBotToken: () => true, registerFollowerWithOwner: async () => mode === "pending" ? "pending" : mode === "registered" ? true : undefined,
    proveOwnerUnresponsive: async () => { proofs++; return true; },
    startPolling: async () => { starts++; }, stopPolling: async () => {}, updateStatus: () => { statuses++; },
    recordRuntimeEvent(_category, _error, details) { phases.push(details?.phase); },
  });
  try {
    writeFileSync(temp.path, before);
    const result = await runtime.start({ cwd: "/recipient" });
    assert.equal(result.ok, mode === "registered");
    assert.equal(result.canTakeover, mode === "classic");
    assert.equal(statuses, mode === "registered" ? 1 : 0);
    assert.equal(starts, 0, "A follower readiness observation never starts a local poller");
    assert.equal(proofs, 0, "Pending capability is not a failed registration or unresponsiveness proof");
    assert.deepEqual(phases, mode === "pending" ? ["follower-readiness-pending"] : []);
    assert.equal(readFileSync(temp.path, "utf8"), before);
    if (mode === "pending") {
      assert.equal(await runtime.registerFollowerWithOwner!({ cwd: "/recipient" }, { pid: 99 }), "pending");
      assert.equal(statuses, 0, "The exposed adapter must not project pending as successful membership");
    }
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

test("Pending follower observation cannot cross a reused context's session identity", async () => {
  const temp = createTempLockPath(), ctx = { cwd: "/recipient" };
  let session = "original", statuses = 0, release!: (value: "pending") => void;
  const pending = new Promise<"pending">(resolve => { release = resolve; });
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const runtime = createTelegramLockedPollingRuntime({
    lock: createTelegramLockRuntime({ locksPath: temp.path, pid: 10, isProcessAlive: pid => pid === 99 }),
    hasBotToken: () => true, getSessionId: () => session, isContextCurrent: () => true,
    registerFollowerWithOwner: async () => { entered(); return pending; },
    startPolling: async () => assert.fail("A stale observation cannot poll"), stopPolling: async () => {}, updateStatus: () => { statuses++; },
    proveOwnerUnresponsive: async () => assert.fail("A stale observation cannot request takeover proof"),
  });
  try {
    writeFileSync(temp.path, JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/leader" } }));
    const start = runtime.start(ctx);
    await waiting;
    session = "replacement";
    release("pending");
    const result = await start;
    assert.equal(result.ok, false); assert.equal(result.canTakeover, false);
    assert.match(result.message!, /cancelled or superseded/u);
    assert.equal(statuses, 0);
  } finally { release("pending"); rmSync(temp.dir, { recursive: true, force: true }); }
});

for (const artifact of ["source", "compiled"] as const)
for (const fault of ["none", "config", "profile", "path", "owner", "endpoint", "intent", "caught-owner-restore"] as const)
test(`Follower startup binds original selected scope before registration awaits (${artifact}/${fault})`, async () => {
  const ConfigModel = artifact === "source" ? { createTelegramConfigStore } : await import("../dist/lib/config.js");
  const ThreadModel = artifact === "source" ? { createTelegramTopicTargetStore } : await import("../dist/lib/threads.js");
  const LockModel = artifact === "source" ? { createTelegramLockRuntime, createTelegramLockedPollingRuntime } : await import("../dist/lib/locks.js");
  const temp = createTempLockPath();
  const config = ConfigModel.createTelegramConfigStore({ initialConfig: { botToken: "123:scope", profiles: { work: { botToken: "123:scope" } } } });
  let path = join(temp.dir, "original.json"), caller = true, effects = 0, statuses = 0, proofs = 0, entered!: () => void, release!: () => void;
  let assertOriginal: (() => void) | undefined;
  const store = ThreadModel.createTelegramTopicTargetStore({ path: () => path, telegramProfile: config.getActiveProfileName });
  const owner = { pid: 99, cwd: "/leader", instanceId: "leader", leaderEpoch: "original", busSocketPath: "original.sock" };
  const write = (value: typeof owner) => writeFileSync(temp.path, JSON.stringify({ default: value, work: { ...owner } }));
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = LockModel.createTelegramLockedPollingRuntime({
    lock: LockModel.createTelegramLockRuntime({ locksPath: temp.path, key: () => config.getActiveProfileName() ?? "default", pid: 10, isProcessAlive: pid => pid === 99 }),
    captureConfigScope: config.captureConnectionScope, captureStorageScope: store.captureReadScope, hasBotToken: config.hasBotToken,
    async registerFollowerWithOwner(_ctx, selected, options) {
      assertOriginal = options?.assertAuthority; entered(); await gate;
      assert.deepEqual(JSON.parse(JSON.stringify(selected)), owner); assert.equal(Object.isFrozen(selected), true);
      assert.ok(assertOriginal); assertOriginal(); effects++; return true;
    },
    startPolling: async () => assert.fail("A foreign scope cannot poll"), stopPolling: async () => {}, updateStatus() { statuses++; },
    proveOwnerUnresponsive: async () => { proofs++; return true; },
  });
  let pending: ReturnType<typeof runtime.start> | undefined;
  try {
    write(owner);
    pending = runtime.start({ cwd: "/recipient" }, { assertAuthority() { if (!caller) throw new Error("Original command ended"); } });
    await waiting;
    if (fault === "config") config.set(config.get());
    if (fault === "profile") config.activateProfile("work");
    if (fault === "path") path = join(temp.dir, "replacement.json");
    if (fault === "owner") write({ ...owner, leaderEpoch: "replacement" });
    if (fault === "endpoint") write({ ...owner, busSocketPath: "replacement.sock" });
    if (fault === "intent") caller = false;
    if (fault === "caught-owner-restore") { write({ ...owner, leaderEpoch: "replacement" }); assert.throws(assertOriginal!); write(owner); }
    const before = readFileSync(temp.path, "utf8");
    release();
    const result = await pending;
    assert.equal(result.ok, fault === "none"); assert.equal(result.canTakeover, false);
    assert.equal(effects, fault === "none" ? 1 : 0); assert.equal(statuses, fault === "none" ? 1 : 0); assert.equal(proofs, 0);
    assert.equal(readFileSync(temp.path, "utf8"), before, "Selection checks cannot repair or rebind the canonical owner");
  } finally { release(); await pending; rmSync(temp.dir, { recursive: true, force: true }); }
});

for (const fault of ["deadline", "deadline-logging", "backwards", "nan", "throw", "reentry", "profile", "session", "locator", "registration-port", "birth-invalid", "constant-clock"] as const)
test(`Original readiness budget cannot renew its clock or selected scope (${fault})`, async () => {
  const temp = createTempLockPath(), statePath = join(temp.dir, "state.json");
  const config = createTelegramConfigStore({ initialConfig: { botToken: "123:scope", profiles: { work: { botToken: "123:scope" } } } });
  const store = createTelegramTopicTargetStore({ path: statePath, telegramProfile: config.getActiveProfileName });
  const owner = { pid: 99, cwd: "/leader", instanceId: "leader", leaderEpoch: "epoch", busSecret: "fixture", runtimeGeneration: 1 };
  let now = 100, session = "original", locator = "original.sock", throwing = false, reenter = false, remaining: (() => number) | undefined, statuses = 0, proofs = 0;
  if (fault === "birth-invalid") now = Number.MAX_VALUE;
  const deps = {
    lock: createTelegramLockRuntime({ statePath, pid: 10, isProcessAlive: (pid: number) => pid === 99 }),
    captureConfigScope: config.captureConnectionScope, captureStorageScope: store.captureReadScope, hasBotToken: config.hasBotToken,
    getSessionId: () => session, getLeaderEndpoint: () => locator, waitForReadiness: async () => {},
    readinessClock() { if (throwing) throw new Error("clock failed"); if (reenter) { reenter = false; try { remaining!(); } catch { /* A provider catches its reentry. */ } } return now; },
    async registerFollowerWithOwner(_ctx: { cwd: string }, _owner: TelegramLockEntry, options?: TelegramFollowerRegistrationOptions): Promise<TelegramFollowerRegistrationResult> {
      remaining = options?.readiness?.remainingMs; assert.ok(remaining);
      if (fault === "birth-invalid") { assert.equal(remaining(), 0); return "readiness-expired"; }
      assert.equal(remaining(), 8000);
      if (fault === "constant-clock") {
        let observations = 0;
        while (await options!.readiness!.wait()) observations++;
        assert.equal(observations, 54, "A frozen clock cannot grow the original bus-cadence observation count");
        assert.equal(remaining(), 0);
        return "readiness-expired";
      }
      if (fault === "deadline" || fault === "deadline-logging") { now = 8099; assert.equal(remaining(), 1); now = 8100; }
      if (fault === "backwards") now = 99;
      if (fault === "nan") now = NaN;
      if (fault === "throw") throwing = true;
      if (fault === "reentry") reenter = true;
      if (fault === "profile") config.activateProfile("work");
      if (fault === "session") session = "replacement";
      if (fault === "locator") locator = "replacement.sock";
      if (fault === "registration-port") deps.registerFollowerWithOwner = async () => true;
      if (["reentry", "profile", "session", "locator", "registration-port"].includes(fault)) assert.throws(remaining);
      else { assert.equal(remaining(), 0); now = 100; throwing = false; assert.equal(remaining(), 0, "Restored clock fields cannot renew the deadline"); }
      return "readiness-expired" as const;
    },
    startPolling: async () => assert.fail("Readiness cannot poll"), stopPolling: async () => {}, updateStatus() { statuses++; },
    proveOwnerUnresponsive: async () => { proofs++; return true; },
    recordRuntimeEvent() { if (fault === "deadline-logging") throw new Error("Fixture logging failure"); },
  };
  try {
    mutateTelegramRuntimeStateSection(statePath, "default", "transport", () => ({ value: owner, result: undefined }), { isCurrent: () => true });
    const before = readFileSync(statePath, "utf8");
    const result = await createTelegramLockedPollingRuntime(deps).start({ cwd: "/recipient" }, { assertAuthority() {} });
    assert.equal(result.ok, false); assert.equal(result.canTakeover, false); assert.equal(statuses, 0); assert.equal(proofs, 0);
    assert.equal(readFileSync(statePath, "utf8"), before);
    assert.match(result.message!, ["deadline", "deadline-logging", "backwards", "nan", "throw", "birth-invalid", "constant-clock"].includes(fault) ? /Timed out waiting/ : /cancelled or superseded/);
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

test("Original readiness deadline is born before an existing transport drain", async () => {
  const temp = createTempLockPath(), statePath = join(temp.dir, "state.json");
  const config = createTelegramConfigStore({ initialConfig: { botToken: "123:scope" } });
  const store = createTelegramTopicTargetStore({ path: statePath, telegramProfile: config.getActiveProfileName });
  let now = 100, hold = false, draining = false, release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = createTelegramLockedPollingRuntime({
    lock: createTelegramLockRuntime({ statePath, instanceId: "local", pid: 10, isProcessAlive: () => true }),
    hasBotToken: config.hasBotToken, captureConfigScope: config.captureConnectionScope, captureStorageScope: store.captureReadScope,
    getSessionId: () => "session", readinessClock: () => now, ownershipCheckMs: 1, ownershipRefreshMs: 1,
    startPolling: async () => {}, stopPolling: async () => { if (hold) { draining = true; await gate; } }, updateStatus() {},
    registerFollowerWithOwner: async (_ctx, _owner, options) => { calls++; assert.ok(options?.readiness); assert.equal(options.readiness.remainingMs(), 0); return "readiness-expired" as const; },
  });
  let pending: ReturnType<typeof runtime.start> | undefined;
  try {
    assert.equal((await runtime.start({ cwd: "/local" })).ok, true);
    hold = true;
    mutateTelegramRuntimeStateSection(statePath, "default", "transport", () => ({ value: {
      pid: 99, cwd: "/leader", instanceId: "leader", leaderEpoch: "epoch", busSecret: "fixture", busSocketPath: "original.sock", runtimeGeneration: 1,
    }, result: undefined }), { isCurrent: () => true });
    await waitForCondition(() => draining);
    pending = runtime.start({ cwd: "/recipient" }, { assertAuthority() {} });
    now = 8100; release();
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.canTakeover, false); assert.equal(calls, 1);
    assert.match(result.message!, /Timed out waiting/);
  } finally { release(); await pending; await runtime.stop(); rmSync(temp.dir, { recursive: true, force: true }); }
});

for (const mismatch of ["none", "profile", "path"] as const)
test(`Consolidated follower admission cross-binds config and Workspace to native transport coordinates (${mismatch})`, async () => {
  const temp = createTempLockPath(), statePath = join(temp.dir, "state.json");
  const config = createTelegramConfigStore({ initialConfig: { botToken: "123:scope", profiles: { work: { botToken: "123:scope" } } } });
  const store = createTelegramTopicTargetStore({ path: mismatch === "path" ? join(temp.dir, "other.json") : statePath,
    telegramProfile: config.getActiveProfileName });
  const owner = { pid: 99, cwd: "/leader", instanceId: "leader", leaderEpoch: "epoch" };
  let registrations = 0;
  const lock = createTelegramLockRuntime({ statePath, key: () => mismatch === "profile" ? "work" : "default", pid: 10, isProcessAlive: pid => pid === 99 });
  const runtime = createTelegramLockedPollingRuntime({ lock, hasBotToken: config.hasBotToken,
    captureConfigScope: config.captureConnectionScope, captureStorageScope: store.captureReadScope,
    registerFollowerWithOwner: async () => { registrations++; return true; },
    startPolling: async () => assert.fail("A foreign binding cannot poll"), stopPolling: async () => {}, updateStatus() {},
  });
  try {
    for (const profile of ["default", "work"]) mutateTelegramRuntimeStateSection(statePath, profile, "transport", () => ({ value: owner, result: undefined }), { isCurrent: () => true });
    const before = readFileSync(statePath, "utf8");
    const result = await runtime.start({ cwd: "/recipient" });
    assert.equal(result.ok, mismatch === "none"); assert.equal(result.canTakeover, false);
    assert.equal(registrations, mismatch === "none" ? 1 : 0, "Individually current but mismatched scopes cannot certify one original selection");
    assert.equal(readFileSync(statePath, "utf8"), before);
  } finally { rmSync(temp.dir, { recursive: true, force: true }); }
});

for (const replace of [false, true])
test(`Follower owner selection precedes an existing ownership-drain await (${replace})`, async () => {
  const temp = createTempLockPath();
  let release!: () => void, registrations = 0, draining = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let hold = false;
  const runtime = createTelegramLockedPollingRuntime({
    lock: createTelegramLockRuntime({ locksPath: temp.path, pid: 10, isProcessAlive: () => true }),
    hasBotToken: () => true, ownershipCheckMs: 1, ownershipRefreshMs: 1,
    startPolling: async () => {}, stopPolling: async () => { if (hold) { draining = true; await gate; } }, updateStatus() {},
    registerFollowerWithOwner: async (_ctx, _owner, options) => { options?.assertAuthority?.(); registrations++; return true; },
  });
  let starting: ReturnType<typeof runtime.start> | undefined;
  try {
    assert.equal((await runtime.start({ cwd: "/original" })).ok, true);
    const owner = { pid: 99, cwd: "/leader", instanceId: "leader", leaderEpoch: "original" };
    writeFileSync(temp.path, JSON.stringify({ default: owner }));
    hold = true; await waitForCondition(() => draining);
    starting = runtime.start({ cwd: "/recipient" });
    if (replace) writeFileSync(temp.path, JSON.stringify({ default: { ...owner, leaderEpoch: "replacement" } }));
    release();
    const result = await starting;
    assert.equal(result.ok, !replace); assert.equal(result.canTakeover, false);
    assert.equal(registrations, replace ? 0 : 1, "A drain cannot authorize adopting the leader that replaced the selected original");
  } finally { release(); await starting; await runtime.stop(); rmSync(temp.dir, { recursive: true, force: true }); }
});

for (const fault of ["session", "context", "stop", "caught-loss", "producer"] as const)
test(`Locked polling passes original cancellation through registration without takeover proof (${fault})`, async () => {
  const temp = createTempLockPath(), ctx = { cwd: "/recipient" };
  let session = "original", active = true, statuses = 0, proofs = 0, entered!: () => void, release!: () => void;
  let assertOriginal: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = createTelegramLockedPollingRuntime({
    lock: createTelegramLockRuntime({ locksPath: temp.path, pid: 10, isProcessAlive: pid => pid === 99 }),
    hasBotToken: () => true, getSessionId: () => session, isContextCurrent: () => active,
    registerFollowerWithOwner: async (_ctx, _owner, options) => {
      assertOriginal = options?.assertAuthority;
      entered(); await gate;
      assert.ok(assertOriginal);
      if (fault === "producer") throw new TelegramFollowerRegistrationCancelledError();
      assertOriginal(); return true;
    },
    startPolling: async () => assert.fail("A cancelled registration cannot poll"), stopPolling: async () => {}, updateStatus: () => { statuses++; },
    proveOwnerUnresponsive: async () => { proofs++; return true; },
  });
  let pending: ReturnType<typeof runtime.start> | undefined;
  try {
    const original = JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/leader" } });
    writeFileSync(temp.path, original);
    pending = runtime.start(ctx);
    await waiting;
    if (fault === "session") session = "replacement";
    if (fault === "context") active = false;
    if (fault === "stop") await runtime.stop();
    if (fault === "caught-loss") { active = false; assert.throws(assertOriginal!); active = true; }
    release();
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.canTakeover, false);
    assert.match(result.message!, /cancelled or superseded/u);
    assert.equal(statuses, 0); assert.equal(proofs, 0, "Cancellation is not evidence of an unavailable leader");
    assert.equal(readFileSync(temp.path, "utf8"), original);
  } finally { release(); await pending; rmSync(temp.dir, { recursive: true, force: true }); }
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
    captureFollowerRegistrationScope: () => () => false,
    getStorageScope: () => undefined,
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
    captureFollowerRegistrationScope: () => () => false,
    getStorageScope: () => undefined,
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

test("Automatic startup cannot carry a reused context across awaited session eligibility", async () => {
  const temp = createTempLockPath(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const ctx = { cwd: "/repo", sessionId: "A" };
  let starts = 0;
  writeFileSync(temp.path, JSON.stringify({ [TELEGRAM_LOCK_KEY]: { pid: 99, cwd: "/repo" } }));
  const before = readFileSync(temp.path, "utf8");
  const lock = createTelegramLockRuntime<typeof ctx>({ locksPath: temp.path, pid: 10, isProcessAlive: () => false });
  const runtime = createTelegramLockedPollingRuntime({ lock, hasBotToken: () => true, isContextCurrent: () => true,
    getSessionId: context => context.sessionId,
    async canAutoStartSession() { entered.resolve(); await release.promise; return true; },
    startPolling() { starts++; }, async stopPolling() {}, updateStatus() {},
  });
  try {
    await runtime.onSessionStart({}, ctx); await entered.promise;
    ctx.sessionId = "B"; release.resolve();
    await new Promise(resolve => setImmediate(resolve)); await runtime.suspend();
    assert.equal(starts, 0); assert.equal(readFileSync(temp.path, "utf8"), before);
  } finally { release.resolve(); await runtime.stop(); rmSync(temp.dir, { recursive: true, force: true }); }
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

test("File transactions report their held time and contended lock waits as synchronous blocking", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-lock-block-"));
  try {
    const path = join(dir, "transaction.lock");
    const before = readTelegramSyncBlockTotals();
    withTelegramFileTransaction(path, () => "done");
    const after = readTelegramSyncBlockTotals();
    assert.equal(
      (after["transaction-held"]?.count ?? 0) - (before["transaction-held"]?.count ?? 0),
      1,
      "Every transaction reports how long it held the event loop",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
