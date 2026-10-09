/**
 * Telegram thread binding tests
 * Zones: multi-instance bus, Telegram UI threads, extension state
 * Covers current owner-key thread target reuse and Bot API topic provisioning seams
 */

import fsPromises, { chmod, link, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { withTelegramFileTransaction, readTelegramRuntimeState, mutateTelegramRuntimeStateSection,
  createTelegramLockRuntime as createSessionGrantLock, createTelegramOwnedStateAuthorityCapture } from "../lib/locks.ts";
import { createTelegramSessionContextStore } from "../lib/lifecycle.ts";

import {
  commitTelegramWorkspaceProvisionBinding,
  createTelegramCleanupTargetProtection,
  createTelegramCurrentInstanceThreadRuntime,
  createTelegramCurrentThreadAssembly,
  createTelegramLeaderThreadStateRuntime,
  createTelegramThreadStatusProjectionRuntime,
  createTelegramTopicTargetProvisioner,
  createTelegramTopicTargetRenamer,
  createTelegramWorkspaceBindingIdentity,
  createTelegramWorkspaceRestoreResolver,
  createTelegramWorkspaceThreadRenameRecipient,
  createTelegramWorkspaceThreadResetRecipient,
  type TelegramWorkspaceThreadRenameAuthority,
  createTelegramTopicTargetStore,
  createTelegramConsolidatedWorkspaceStorage,
  parseTelegramWorkspaceStateSection,
  resolveTelegramWorkspaceProvisionRecoveryPath,
  isTelegramTemporaryThreadFullyResolved,
  getTelegramWorkspaceRestoreSourceCompletionSha256,
  getTelegramTemporaryThreadInputs,
  findCurrentTelegramInstanceThreadRecord,
  getTelegramThreadOwnerFromProfileKey,
  getTelegramThreadOwnerKey,
  getTelegramLeaderSessionHandoff,
  setTelegramLeaderSessionHandoff,
  provisionOwnBusTopic,
  resolveTelegramInstanceThreadIdentity,
  listTelegramThreadStatusFollowers,
  listTelegramThreadStatusTargets,
  listTelegramThreadStatusReservations,
  listTelegramThreadStatusObservations,
  getTelegramTargetFromApiBody,
  isTelegramTopicModeUnavailableError,
  isTelegramTopicTargetStaleError,
  type TelegramWorkspaceRestoreIntent,
  type TelegramWorkspaceLiveRebindIntent,
  type TelegramWorkspaceRestoreSourceAcceptance,
} from "../lib/threads.ts";
import { createTelegramLockRuntime } from "../lib/locks.ts";
import { createTelegramWorkspaceAdmissionLedger } from "../lib/workspace-admission.ts";
import {
  isTelegramApiCommitUnknownError,
  TelegramApiCommitUnknownError,
  createTelegramApiClient,
  createTelegramBridgeApiRuntime,
  type TelegramApiCallOptions,
} from "../lib/telegram-api.ts";

import { withWorkspaceRelocationFixture, withWorkspaceRestoreFixture as fixture, restoreFixtureRecipient as recipient } from "./fixtures/workspace.ts";
import { createTelegramUpdateJournalStore, createTelegramUpdateJournalBotIdentity, createTelegramUpdateJournalBindingKey, createTelegramUpdateJournalEntryDigest } from "../lib/journal.ts";
import { createTelegramUpdateWorkerRuntime } from "../lib/updates.ts";
import { createTelegramBusFollowerDeliveryIdentity } from "../lib/bus.ts";

async function withConsolidatedWorkspaceFixture(run: (f: {
  rootPath: string;
  dir: string;
  scope: { path: string; profile: string; generation: number };
  owner: ReturnType<typeof createTelegramLockRuntime>;
  workspace: Record<string, unknown>;
  storage: ReturnType<typeof createTelegramConsolidatedWorkspaceStorage>;
  consolidated: NonNullable<Parameters<typeof createTelegramTopicTargetStore>[0]["consolidated"]>;
}) => Promise<void>, role: "leader" | "follower" = "leader"): Promise<void> {
  await fixture(async f => {
    const committed = await f.store.commit(f.request, f.auth);
    assert.ok(committed);
    const issued = f.store.issueRecipient(committed, recipient(role), f.auth);
    assert.ok(issued);
    const workspace = JSON.parse(await readFile(f.path, "utf8")) as Record<string, unknown>;
    const rootPath = join(dirname(f.path), "consolidated.json");
    const scope = { path: rootPath, profile: "default", generation: 1 };
    const owner = createTelegramLockRuntime({ statePath: rootPath, key: () => scope.profile, pid: 10,
      instanceId: "owner", runtimeGeneration: 1, isProcessAlive: () => true });
    const consolidated = {
      captureAuthority() {
        const epoch = owner.getOwnedLeaderEpoch(), generation = scope.generation;
        return epoch === undefined ? undefined : () => scope.generation === generation && owner.owns() && owner.getOwnedLeaderEpoch() === epoch;
      },
      publishIfOwned: owner.publishStateSectionIfOwned!,
    };
    const storage = createTelegramConsolidatedWorkspaceStorage({ getPath: () => scope.path, getProfile: () => scope.profile, ...consolidated });
    await run({ rootPath, dir: dirname(rootPath), scope, owner, workspace, storage, consolidated });
  }, role);
}

test("Provision recovery owner selector keeps exact legacy/consolidated layout and raw profile hashes", () => {
  const path = join("/agent", "state.json");
  assert.equal(resolveTelegramWorkspaceProvisionRecoveryPath(path, "work"), `${path}.provision-recovery.json`);
  const hash = createHash("sha256").update("work").digest("hex").slice(0, 16);
  assert.equal(resolveTelegramWorkspaceProvisionRecoveryPath(path, "work", "consolidated"), join("/agent", "runtime", `state.json.provision-recovery.${hash}.json`));
  assert.notEqual(resolveTelegramWorkspaceProvisionRecoveryPath(path, "work", "consolidated"), resolveTelegramWorkspaceProvisionRecoveryPath(path, "Work", "consolidated"));
  assert.throws(() => resolveTelegramWorkspaceProvisionRecoveryPath(path, "work", "legacy" as any), /Invalid Workspace provisioning recovery layout/u);
});

test("Consolidated Workspace decoder preserves native relocation and issued recipient facts without creating state", async () => {
  await withConsolidatedWorkspaceFixture(async f => {
    const parsed = parseTelegramWorkspaceStateSection(f.workspace, "default")!;
    assert.equal(parsed.workspaceRestore?.operations[0]?.phase, "recipient-issued");
    assert.equal(parsed.workspaceBindings?.[0]?.target.threadId, 42);
    assert.equal(f.storage.read(), undefined);
    assert.equal(f.storage.capturePublication(), undefined);
    assert.equal(existsSync(f.rootPath), false);
    f.owner.acquire({ cwd: "/repo" });
    const publish = f.storage.capturePublication()!;
    assert.deepEqual(publish(() => ({ value: f.workspace, result: "written" })), { committed: true, result: "written" });
    assert.deepEqual(f.storage.read(), parsed);
    const bytes = await readFile(f.rootPath, "utf8"), inode = (await stat(f.rootPath)).ino;
    assert.deepEqual(publish(current => ({ value: current, result: "noop" })), { committed: true, result: "noop" });
    assert.equal(await readFile(f.rootPath, "utf8"), bytes);
    assert.equal((await stat(f.rootPath)).ino, inode);
  });
});

for (const damage of ["primitive", "version", "clock", "unknown-top", "unknown-thread", "invalid-binding", "foreign-restore", "missing-owner", "section-removal"] as const) {
  test(`Consolidated Workspace rejects lossy or foreign publication (${damage})`, async () => {
    await withConsolidatedWorkspaceFixture(async f => {
      f.owner.acquire({ cwd: "/repo" });
      const publish = f.storage.capturePublication()!;
      publish(() => ({ value: f.workspace, result: true }));
      const before = await readFile(f.rootPath, "utf8");
      const proposed = structuredClone(f.workspace) as Record<string, any>;
      if (damage === "version") proposed.version = 999;
      if (damage === "clock") proposed.writtenAtMs = -1;
      if (damage === "unknown-top") proposed.unknownIssuedEffect = true;
      if (damage === "unknown-thread") proposed.threads[0].unknownIssuedEffect = true;
      if (damage === "invalid-binding") proposed.workspaceBindings[0].slot = "invalid";
      if (damage === "foreign-restore") proposed.workspaceRestore.profileName = "other";
      if (damage === "missing-owner") delete proposed.threads[0].owner;
      assert.throws(() => publish(() => ({ value: damage === "primitive" ? null : damage === "section-removal" ? undefined : proposed, result: true })));
      assert.equal(await readFile(f.rootPath, "utf8"), before);
    });
  });
}

for (const drift of ["generation", "profile", "path", "owner"] as const) {
  test(`Consolidated Workspace refuses a pre-await grant after source drift (${drift})`, async () => {
    await withConsolidatedWorkspaceFixture(async f => {
      f.owner.acquire({ cwd: "/repo" });
      const publish = f.storage.capturePublication()!;
      if (drift === "generation") f.scope.generation++;
      if (drift === "profile") f.scope.profile = "other";
      if (drift === "path") f.scope.path = join(f.dir, "wrong.json");
      if (drift === "owner") f.owner.release();
      const before = await readFile(f.rootPath, "utf8");
      let called = false;
      assert.deepEqual(publish(() => { called = true; return { value: f.workspace, result: true }; }), { committed: false });
      assert.equal(called, false);
      assert.equal(await readFile(f.rootPath, "utf8"), before);
      assert.equal(existsSync(join(f.dir, "wrong.json")), false);
    });
  });
}

test("Consolidated Workspace updates compare the current section and preserve transport, admission, runtime and other profiles", async () => {
  await withConsolidatedWorkspaceFixture(async f => {
    f.owner.acquire({ cwd: "/repo" });
    const publish = f.storage.capturePublication()!;
    publish(() => ({ value: f.workspace, result: true }));
    for (const [profile, section, value] of [["default", "admission", { leases: ["busy"], deletionIssued: true }],
      ["default", "runtime", { snapshot: true }], ["other", "workspace", f.workspace]] as const)
      mutateTelegramRuntimeStateSection(f.rootPath, profile, section, () => ({ value, result: true }), { isCurrent: () => true });
    const before = readTelegramRuntimeState(f.rootPath);
    const changed = structuredClone(f.workspace) as Record<string, any>;
    changed.bot.threadMode = "future-mode";
    assert.throws(() => publish(() => ({ value: changed, result: true })), "Unknown normalized enum cannot clear existing facts");
    changed.bot.threadMode = "enabled";
    publish(current => {
      assert.deepEqual(current, f.workspace);
      return { value: changed, result: true };
    });
    const after = readTelegramRuntimeState(f.rootPath);
    for (const section of ["transport", "admission", "runtime"] as const) assert.deepEqual(after.profiles.default?.[section], before.profiles.default?.[section]);
    assert.deepEqual(after.profiles.other, before.profiles.other);
    assert.equal(f.storage.read()?.bot.threadMode, "enabled");
  });
});

test("Consolidated Workspace inspection rejects corrupt canonical state without repair or a renewed grant", async () => {
  await withConsolidatedWorkspaceFixture(async f => {
    f.owner.acquire({ cwd: "/repo" });
    f.storage.capturePublication()!(() => ({ value: f.workspace, result: true }));
    mutateTelegramRuntimeStateSection(f.rootPath, "default", "workspace", current => {
      const corrupted = current as Record<string, unknown>;
      corrupted.futureIssuedEffect = true;
      return { value: corrupted, result: true };
    }, { isCurrent: () => true });
    const before = await readFile(f.rootPath, "utf8");
    assert.throws(() => f.storage.read());
    const publish = f.storage.capturePublication()!;
    let called = false;
    assert.throws(() => publish(() => { called = true; return { value: f.workspace, result: true }; }));
    assert.equal(called, false, "Malformed current evidence cannot be replaced with an old valid body");
    assert.equal(await readFile(f.rootPath, "utf8"), before);
  });
});

test("Consolidated Workspace refuses a publisher bound to another profile and authority lost inside the reducer", async () => {
  await withConsolidatedWorkspaceFixture(async f => {
    f.owner.acquire({ cwd: "/repo" });
    const wrong = createTelegramConsolidatedWorkspaceStorage({ getPath: () => f.rootPath, getProfile: () => "other",
      captureAuthority: () => () => true, publishIfOwned: f.owner.publishStateSectionIfOwned! });
    const before = await readFile(f.rootPath, "utf8");
    let called = false;
    assert.deepEqual(wrong.capturePublication()!(() => { called = true; return { value: f.workspace, result: true }; }), { committed: false });
    assert.equal(called, false);
    const publish = f.storage.capturePublication()!;
    assert.throws(() => publish(() => { f.scope.generation++; return { value: f.workspace, result: true }; }), /authority changed/);
    assert.equal(await readFile(f.rootPath, "utf8"), before);
    assert.equal(readTelegramRuntimeState(f.rootPath).profiles.other, undefined);
  });
});

for (const boundary of ["after-write-before-rename", "after-rename"] as const) {
  test(`Consolidated Workspace retains exact facts across publication faults (${boundary})`, async () => {
    await withConsolidatedWorkspaceFixture(async f => {
      f.owner.acquire({ cwd: "/repo" });
      const publish = f.storage.capturePublication()!;
      const before = await readFile(f.rootPath, "utf8");
      assert.throws(() => publish(() => ({ value: f.workspace, result: true }), { onPublicationBoundary(at) {
        if (at === boundary) throw new Error("lost publication reply");
      } }));
      if (boundary === "after-rename") {
        assert.deepEqual(f.storage.read()?.workspaceRestore, parseTelegramWorkspaceStateSection(f.workspace, "default")?.workspaceRestore);
        assert.deepEqual(publish(current => ({ value: current, result: "observed" })), { committed: true, result: "observed" });
      } else assert.equal(await readFile(f.rootPath, "utf8"), before);
    });
  });
}

for (const role of ["leader", "follower"] as const) {
  test(`Workspace Restore ${role} owners without a display name round-trip recipient issuance without synthetic undefined fields`, async () => {
    await fixture(async f => {
      f.threads.upsert({ ...f.threads.list()[0]!, threadName: undefined });
      await f.threads.persist();
      await f.threads.load();
      f.request.owner = f.threads.list()[0]!;
      assert.equal(Object.hasOwn(f.request.owner, "threadName"), false);
      const committed = (await f.store.commit(f.request, f.auth))!;
      assert.ok(committed);
      const issued = f.store.issueRecipient(committed, recipient(role), f.auth)!.intent;
      const bytes = await readFile(f.path, "utf8"), wire = JSON.parse(bytes);
      assert.equal(Object.hasOwn(wire.workspaceRestore.operations[0].request.owner, "threadName"), false);
      assert.deepEqual(f.open().list(), [issued]);
      assert.doesNotThrow(() => parseTelegramWorkspaceStateSection(wire, "default"), "Unnamed source owner stays a lossless current-format fact");
      assert.equal(f.open().issueRecipient(issued, recipient(role), f.auth), undefined);
      assert.equal(await readFile(f.path, "utf8"), bytes);
    }, role);
  });
}

type WorkspaceRestoreFixture = Parameters<Parameters<typeof fixture>[0]>[0];
async function withLiveRebindSnapshot(role: "leader" | "follower", run: (f: WorkspaceRestoreFixture,
  live: TelegramWorkspaceLiveRebindIntent, wire: Record<string, unknown>) => Promise<void>) {
  await fixture(async f => {
    const committed = (await f.store.commit(f.request, f.auth))!;
    assert.ok(committed);
    const live: TelegramWorkspaceLiveRebindIntent = { kind: "live-rebind", request: structuredClone(committed.request),
      operatorUserId: committed.operatorUserId, executor: structuredClone(committed.executor), recipient: recipient(role),
      revision: 0, createdAtMs: 1000, updatedAtMs: 1000, phase: "rebound" };
    const wire: Record<string, unknown> = JSON.parse(await readFile(f.path, "utf8"));
    const section = wire.workspaceRestore as Record<string, unknown>;
    section.revision = Number(section.revision) + 1;
    section.operations = [];
    section.liveRebindings = [live];
    await writeFile(f.path, JSON.stringify(wire));
    await run(f, live, wire);
  }, role);
}

for (const role of ["leader", "follower"] as const) {
  for (const progress of [
    { phase: "rebound" }, { phase: "released" }, { phase: "released", cleanup: "issued" },
    ...(["confirmed", "failed", "unknown", "not-issued"] as const).map(cleanup => ({ phase: "finished", cleanup })),
  ]) {
    test(`Live rebinding snapshot round-trips separate metadata (${role}, ${progress.phase}, ${progress.cleanup ?? "none"})`, async () => {
      await withLiveRebindSnapshot(role, async (f, live, wire) => {
        const value = { ...live, ...progress };
        (wire.workspaceRestore as Record<string, unknown>).liveRebindings = [value];
        const bytes = JSON.stringify(wire); await writeFile(f.path, bytes);
        const decoded = parseTelegramWorkspaceStateSection(wire, "default")!;
        assert.deepEqual(decoded.workspaceRestore?.liveRebindings, [value]);
        assert.deepEqual(decoded.workspaceRestore?.operations, []);
        const cold = createTelegramTopicTargetStore({ path: f.path });
        await cold.load();
        const store = cold.workspaceRestore({ profileName: "default", tokenSha256: "a".repeat(64) });
        assert.deepEqual(store.list(), [], "Live metadata never becomes a legacy Restore grant");
        assert.equal(store.issueCleanup(value as unknown as TelegramWorkspaceRestoreIntent, f.auth), undefined);
        cold.renameByTarget(f.request.target, "Still same session"); await cold.persist();
        const after = JSON.parse(await readFile(f.path, "utf8"));
        assert.deepEqual(after.workspaceRestore.liveRebindings, [value], "Ordinary publication preserves the new metadata");
        assert.equal(after.workspaceBindings[0].sessionId, f.request.binding.sessionId);
        assert.equal(after.workspaceBindings[0].slot, f.request.binding.slot);
      });
    });
  }
}

const invalidLiveRebinding: Record<string, (value: Record<string, any>) => void> = {
  "legacy-record": value => { delete value.kind; value.phase = "relocated"; value.committedAtMs = 1000; },
  "legacy-proof": value => { value.routing = { settlements: [] }; },
  "future-key": value => { value.future = true; },
  "foreign-operator": value => { value.operatorUserId = 8; },
  "foreign-session": value => { value.recipient.sessionId = "other"; },
  "foreign-instance": value => { value.recipient.instanceId = "other"; },
  "foreign-role": value => { value.recipient.kind = "follower"; },
  "empty-generation": value => { value.recipient.generation = ""; },
  "wrong-clock": value => { value.updatedAtMs = 999; },
  "invalid-revision": value => { value.revision = -1; },
  "early-cleanup": value => { value.cleanup = "issued"; },
  "early-terminal": value => { value.phase = "released"; value.cleanup = "confirmed"; },
  "unfinished-terminal": value => { value.phase = "finished"; },
  "unknown-phase": value => { value.phase = "ready"; },
  "unknown-outcome": value => { value.phase = "finished"; value.cleanup = "deleted-probably"; },
  "duplicate-source": value => { value.request.source.updateIds = [100, 100]; },
};
for (const [damage, mutate] of Object.entries(invalidLiveRebinding)) {
  test(`Live rebinding snapshot refuses malformed or borrowed authority (${damage})`, async () => {
    await withLiveRebindSnapshot("leader", async (f, live, wire) => {
      const value = structuredClone(live); mutate(value);
      (wire.workspaceRestore as Record<string, unknown>).liveRebindings = [value];
      const bytes = JSON.stringify(wire); await writeFile(f.path, bytes);
      assert.throws(() => parseTelegramWorkspaceStateSection(wire, "default"), /Invalid Workspace Restore evidence/);
      await assert.rejects(() => createTelegramTopicTargetStore({ path: f.path }).load(), /Invalid Workspace Restore evidence/);
      assert.equal(await readFile(f.path, "utf8"), bytes, "Invalid metadata is not repaired or erased");
    });
  });
}

for (const conflict of ["empty", "capacity", "clock", "live-id", "live-binding", "legacy-id", "legacy-binding", "live-in-legacy"] as const) {
  test(`Live rebinding snapshot enforces bounded and disjoint operation namespaces (${conflict})`, async () => {
    await withLiveRebindSnapshot("leader", async (f, live, wire) => {
      const section = wire.workspaceRestore as Record<string, unknown>;
      const other = structuredClone(live); other.request.operationId = "other";
      if (conflict === "empty") section.liveRebindings = [];
      if (conflict === "capacity") section.liveRebindings = Array(27).fill(live);
      if (conflict === "clock") section.revision = 0;
      if (conflict === "live-id") section.liveRebindings = [live, live];
      if (conflict === "live-binding") section.liveRebindings = [live, other];
      if (conflict === "live-in-legacy") { section.operations = [live]; delete section.liveRebindings; }
      if (conflict.startsWith("legacy-")) section.operations = [{ request: conflict === "legacy-id" ? live.request : other.request,
        operatorUserId: live.operatorUserId, executor: live.executor, revision: 0, createdAtMs: 1000,
        updatedAtMs: 1000, committedAtMs: 1000, phase: "relocated" }];
      const bytes = JSON.stringify(wire); await writeFile(f.path, bytes);
      assert.throws(() => parseTelegramWorkspaceStateSection(wire, "default"), /Workspace (?:Restore|live rebinding) evidence/);
      assert.equal(await readFile(f.path, "utf8"), bytes);
    });
  });
}

test("Live rebinding terminal metadata does not conflict with another live attempt or rewrite legacy facts", async () => {
  await withLiveRebindSnapshot("leader", async (f, live, wire) => {
    const finished = { ...structuredClone(live), phase: "finished", cleanup: "unknown" };
    finished.request.operationId = "finished";
    const section = wire.workspaceRestore as Record<string, unknown>;
    section.liveRebindings = [live, finished];
    assert.doesNotThrow(() => parseTelegramWorkspaceStateSection(wire, "default"));
    section.liveRebindings = [finished];
    const legacy = { request: live.request, operatorUserId: live.operatorUserId, executor: live.executor,
      revision: 0, createdAtMs: 1000, updatedAtMs: 1000, committedAtMs: 1000, phase: "relocated" };
    section.operations = [legacy];
    const bytes = JSON.stringify(wire); await writeFile(f.path, bytes);
    assert.deepEqual(f.open().list(), [legacy], "A separate terminal row neither replaces nor loosens legacy evidence");
    assert.deepEqual(parseTelegramWorkspaceStateSection(wire, "default")?.workspaceRestore?.liveRebindings, [finished]);
    assert.equal(await readFile(f.path, "utf8"), bytes);
  });
});

async function withLiveRebindStoreFixture(role: "leader" | "follower", layout: "standalone" | "consolidated",
  run: (f: WorkspaceRestoreFixture) => Promise<void>) {
  await fixture(async f => {
    if (layout === "standalone") return run(f);
    const path = join(dirname(f.path), "live-consolidated.json");
    const owner = createTelegramLockRuntime({ statePath: path, key: () => "default", pid: 10,
      instanceId: "leader", runtimeGeneration: 1, isProcessAlive: () => true });
    owner.acquire({ cwd: "/repo" });
    const consolidated = { captureAuthority() {
      const epoch = owner.getOwnedLeaderEpoch();
      return epoch === undefined ? undefined : () => owner.owns() && owner.getOwnedLeaderEpoch() === epoch;
    }, publishIfOwned: owner.publishStateSectionIfOwned! };
    const storage = createTelegramConsolidatedWorkspaceStorage({ getPath: () => path, getProfile: () => "default", ...consolidated });
    const initial = JSON.parse(await readFile(f.path, "utf8"));
    storage.capturePublication()!(() => ({ value: initial, result: true }));
    const threads = createTelegramTopicTargetStore({ path, telegramProfile: "default", consolidated, getNowMs: () => 1000 });
    await threads.load();
    const open: WorkspaceRestoreFixture["open"] = (overrides = {}) => {
      const { threadStore = threads, ...options } = overrides;
      return threadStore.workspaceRestore({ profileName: "default", tokenSha256: "a".repeat(64), getNowMs: () => 1000, ...options });
    };
    const auth = { ...f.auth, executor: { instanceId: "leader", leaderEpoch: String(owner.getOwnedLeaderEpoch()!) }, isCurrent: () => owner.owns() };
    try { await run({ ...f, path, threads, open, store: open(), auth,
      request: { ...f.request, binding: threads.listWorkspaceBindings()[0]!, owner: threads.list()[0]! } }); }
    finally { owner.release(); }
  }, role);
}

for (const role of ["leader", "follower"] as const) {
for (const layout of ["standalone", "consolidated"] as const) {
for (const fault of ["clear", "unreleased", "issued", "wrong-target", "dirty-binding", "binding", "live-record", "stale-record", "reservation", "provision", "untargeted-provision", "unrelated-provision", "cleanup", "recipient-claim", "foreign-claim", "orphan-claim", "unrelated-claim", "canonical-only"] as const) {
  test(`Live cleanup protection observes canonical and warm ownership without legacy exemptions (${role}, ${layout}, ${fault})`, async () => {
    await withLiveRebindStoreFixture(role, layout, async f => {
      const committed = (await f.store.commitLiveRebind(f.request, recipient(role), f.auth))!;
      const released = f.store.advanceLiveRebind(committed, "release", f.auth)!;
      let expected = structuredClone(released);
      if (fault === "unreleased") expected = committed;
      if (fault === "issued") expected = f.store.advanceLiveRebind(released, "issue-cleanup", f.auth)!;
      if (fault === "wrong-target") expected.request.binding.target.threadId = 99;
      const old = f.request.binding.target;
      // Native corruption injection represents refused/unknown ownership, not a new publication permission.
      const injectCanonical = (mutate: (file: { workspaceBindings: unknown[]; threads: unknown[]; reservations?: unknown[]; pendingProvisions?: unknown[] }) => void) => {
        withTelegramFileTransaction(`${f.path}.transaction`, () => {
          const root = JSON.parse(readFileSync(f.path, "utf8"));
          mutate(layout === "consolidated" ? root.profiles.default.workspace : root);
          writeFileSync(f.path, JSON.stringify(root), { mode: 0o600 });
        });
      };
      if (fault === "dirty-binding") f.threads.upsertWorkspaceBinding({ ...f.threads.listWorkspaceBindings()[0]!, target: old });
      if (fault === "binding" || fault === "canonical-only") {
        const identity = createTelegramWorkspaceBindingIdentity("/other", 0, "other-session")!;
        injectCanonical(file => file.workspaceBindings.push({ ...f.request.binding, ...identity, slot: "B", target: old }));
        if (fault === "canonical-only") {
          const cold = createTelegramTopicTargetStore({ path: f.path, telegramProfile: "default", getNowMs: () => 1000 });
          assert.equal(cold.isWorkspaceLiveRebindCleanupTargetProtected(expected), true, "An uninitialized local claim projection cannot certify absence");
        }
      }
      if (fault === "live-record" || fault === "stale-record") {
        const record = { profileKey: "other", target: old, instanceId: "other", slot: "B", status: fault === "live-record" ? "active" as const : "stale" as const,
          createdAtMs: 1000, updatedAtMs: 1000 };
        if (fault === "live-record") injectCanonical(file => file.threads.push(record));
        else f.threads.upsert(record);
      }
      if (fault === "reservation") injectCanonical(file => (file.reservations ??= []).push({ target: old, slot: "B", reason: "pending ownership", createdAtMs: 800, updatedAtMs: 800, expiresAtMs: 900 }));
      if (fault === "provision") injectCanonical(file => (file.pendingProvisions ??= []).push({ id: "other-provision", owner: "leader", instanceId: "other", slot: "B", target: old, startedAtMs: 900, expiresAtMs: 950 }));
      if (fault === "untargeted-provision" || fault === "unrelated-provision") {
        f.threads.upsertPendingProvision({ id: "other-provision", owner: "leader", instanceId: "other", slot: "B", startedAtMs: 900,
          ...(fault === "unrelated-provision" ? { target: { chatId: old.chatId, threadId: 77 } } : {}) }); await f.threads.persist();
      }
      if (fault === "cleanup") { f.threads.upsertPendingCleanup({ id: "other-cleanup", owner: "leader", instanceId: "other", runtimeGeneration: "other", target: old, requestedAtMs: 1000 }); await f.threads.persist(); }
      if (fault === "recipient-claim" || fault === "foreign-claim") {
        const claim = f.threads.claimWorkspaceIdentity(f.request.binding.cwd, fault === "recipient-claim" ? f.request.owner.instanceId! : "contender",
          fault === "foreign-claim" ? f.request.owner.instanceId : undefined, { existingBindingOnly: true, sessionId: f.request.binding.sessionId });
        assert.ok(claim);
      }
      if (fault === "orphan-claim" || fault === "unrelated-claim") {
        const claim = f.threads.claimWorkspaceIdentity("/other", "other", undefined, { sessionId: "other-session" }); assert.ok(claim);
        if (fault === "unrelated-claim") { f.threads.upsertWorkspaceBinding({ ...f.request.binding, ...claim, target: { chatId: old.chatId, threadId: 77 } }, "other"); await f.threads.persist(); }
      }
      const corrupted = ["binding", "canonical-only", "live-record", "reservation", "provision"].includes(fault);
      const bytes = await readFile(f.path, "utf8"), bindings = f.threads.listWorkspaceBindings(), records = f.threads.list();
      const operations = corrupted ? undefined : f.store.listLiveRebindings();
      const protectedNow = !["clear", "stale-record", "recipient-claim", "unrelated-claim", "unrelated-provision"].includes(fault);
      assert.equal(f.threads.isWorkspaceLiveRebindCleanupTargetProtected(expected), protectedNow);
      assert.equal(f.threads.isWorkspaceLiveRebindCleanupTargetProtected(expected), protectedNow, "A read grants no issued or retained cleanup action");
      assert.equal(await readFile(f.path, "utf8"), bytes); assert.deepEqual(f.threads.listWorkspaceBindings(), bindings); assert.deepEqual(f.threads.list(), records);
      if (!corrupted) { assert.deepEqual(f.store.listLiveRebindings(), operations); assert.deepEqual(f.store.list(), []); }
      if (fault === "clear") {
        assert.ok(f.threads.claimWorkspaceIdentity(f.request.binding.cwd, "late-contender", f.request.owner.instanceId,
          { existingBindingOnly: true, sessionId: f.request.binding.sessionId }));
        assert.equal(f.threads.isWorkspaceLiveRebindCleanupTargetProtected(expected), true, "An earlier clear sample does not hide a new current claim");
        f.threads.releaseWorkspaceClaim("late-contender");
        assert.equal(f.threads.isWorkspaceLiveRebindCleanupTargetProtected(expected), false);
        assert.equal(await readFile(f.path, "utf8"), bytes);
      }
    });
  });
}
}
}

for (const operation of ["rename", "reset"] as const) {
for (const fault of ["current", "wrong-intent", "observer-refusal", "observer-change"] as const) {
  test(`Live name ${operation} publication observes its exact owned Workspace frame (${fault})`, async () => {
    await withLiveRebindStoreFixture("leader", "consolidated", async f => {
      const committed = (await f.store.commitLiveRebind(f.request, recipient("leader"), f.auth))!;
      const intent = f.store.advanceLiveRebind(committed, "release", f.auth)!;
      if (operation === "reset") { f.threads.renameByTarget(f.request.target, "Azure"); await f.threads.persist(); }
      const before = await readFile(f.path, "utf8"), observations: unknown[] = [];
      const expected = structuredClone(intent);
      if (fault === "wrong-intent") expected.request.operationId = "other-operation";
      if (fault === "observer-change") {
        assert.throws(() => f.threads.withWorkspaceLiveRebindSnapshot(expected, () => {
          f.store.advanceLiveRebind(intent, "not-issued", f.auth);
        }), /observation changed/, "An observation callback cannot change canonical evidence behind the final grant");
        assert.equal(f.store.listLiveRebindings()[0]?.phase, "finished", "A current observation change is not rolled back");
        return;
      }
      const guard = () => {
        f.threads.withWorkspaceLiveRebindSnapshot(expected, snapshot => {
          observations.push(structuredClone(snapshot));
          assert.deepEqual(snapshot.workspaceBindings?.[0]?.target, f.request.target);
          if (fault === "observer-refusal") throw new Error("Observer refused current authority");
        });
        return true;
      };
      const result = operation === "rename" ? f.threads.renameByTargetAndPersist(f.request.target, "Azure", { updateDisplayTitle: true }, guard)
        : f.threads.clearManualNameByTargetAndPersist(f.request.target, "A", guard);
      if (fault === "current") {
        await result;
        assert.ok(observations.length > 2, "Same exact guard must observe inside native publication as well as entry/result");
        assert.equal(f.threads.getWorkspaceBindingByTarget(f.request.target, f.request.binding.sessionId)?.manualThreadName,
          operation === "rename" ? "Azure" : undefined);
        assert.deepEqual(f.store.listLiveRebindings(), [intent], "Name observation/publication cannot transition the live operation");
      } else { await assert.rejects(result, /observation changed|Observer refused/); assert.equal(await readFile(f.path, "utf8"), before); }
      assert.deepEqual(f.store.list(), []); assert.deepEqual(f.threads.listPendingCleanups(), []);
    });
  });
}
}

for (const role of ["leader", "follower"] as const) {
  for (const layout of ["standalone", "consolidated"] as const) {
    test(`Live rebinding store commits one binding and operation, then finishes without proof or rollback (${role}, ${layout})`, async () => {
      await withLiveRebindStoreFixture(role, layout, async f => {
        const beforeRoot = layout === "consolidated" ? readTelegramRuntimeState(f.path) : undefined;
        const intent = (await f.store.commitLiveRebind(f.request, recipient(role), f.auth))!;
        assert.ok(intent); assert.equal(intent.phase, "rebound");
        assert.deepEqual(f.store.list(), [], "New operations do not enter legacy proof issuance");
        assert.deepEqual(f.open().listLiveRebindings(), [intent]);
        assert.equal(f.threads.listWorkspaceBindings()[0]?.sessionId, f.request.binding.sessionId);
        assert.equal(f.threads.listWorkspaceBindings()[0]?.slot, f.request.binding.slot);
        assert.deepEqual(f.threads.listWorkspaceBindings()[0]?.target, f.request.target);
        assert.deepEqual(f.threads.list()[0]?.target, f.request.target);
        const bytes = await readFile(f.path, "utf8");
        assert.deepEqual(await f.store.commitLiveRebind(f.request, recipient(role), f.auth), intent);
        assert.equal(await readFile(f.path, "utf8"), bytes, "A duplicate commit is a read, not another relocation");
        assert.equal(f.store.advanceLiveRebind(intent, "issue-cleanup", f.auth), undefined);
        assert.equal(f.store.advanceLiveRebind(intent, "confirmed", f.auth), undefined);
        const released = f.store.advanceLiveRebind(intent, "release", f.auth)!;
        assert.ok(released);
        assert.equal(f.store.advanceLiveRebind(intent, "release", f.auth), undefined, "Stale revision cannot release again");
        const issued = f.store.advanceLiveRebind(released, "issue-cleanup", f.auth)!;
        assert.ok(issued);
        assert.equal(f.store.advanceLiveRebind(issued, "issue-cleanup", f.auth), undefined, "Issued deletion never grants another attempt");
        assert.equal(f.store.advanceLiveRebind(issued, "not-issued", f.auth), undefined);
        const finished = f.store.advanceLiveRebind(issued, "unknown", f.auth)!;
        assert.equal(finished.phase, "finished"); assert.equal(finished.cleanup, "unknown");
        assert.deepEqual(f.threads.listWorkspaceBindings()[0]?.target, f.request.target, "Unknown cleanup cannot roll back the binding");
        assert.equal(f.store.advanceLiveRebind(finished, "release", f.auth), undefined);
        const nextRequest = { ...f.request, operationId: "next-live", source: { journalBindingKey: "next-source", updateIds: [102] },
          binding: f.threads.listWorkspaceBindings()[0]!, owner: f.threads.list()[0]!, target: { chatId: 7, threadId: 43 } };
        const next = (await f.store.commitLiveRebind(nextRequest, recipient(role), f.auth))!;
        assert.ok(next, "Terminal failure is not a permanent rebinding blocker");
        assert.deepEqual(f.store.listLiveRebindings(), [next], "Only terminal live metadata is pruned on the next attempt");
        if (beforeRoot) {
          const afterRoot = readTelegramRuntimeState(f.path);
          assert.deepEqual(afterRoot.profiles.default?.transport, beforeRoot.profiles.default?.transport);
        }
      });
    });
    for (const boundary of ["after-write-before-rename", "after-rename"] as const) {
      test(`Live rebinding store publication is atomic and reads its lost reply (${role}, ${layout}, ${boundary})`, async () => {
        await withLiveRebindStoreFixture(role, layout, async f => {
          const before = await readFile(f.path, "utf8");
          const store = f.open({ onPublicationBoundary(at) { if (at === boundary) throw new Error("lost live publication reply"); } });
          if (boundary === "after-write-before-rename") {
            await assert.rejects(() => store.commitLiveRebind(f.request, recipient(role), f.auth), /lost live publication reply/);
            assert.equal(await readFile(f.path, "utf8"), before);
            assert.deepEqual(f.open().listLiveRebindings(), []);
            assert.deepEqual(f.threads.listWorkspaceBindings()[0]?.target, f.request.binding.target);
          } else {
            const intent = await store.commitLiveRebind(f.request, recipient(role), f.auth);
            assert.ok(intent, "An exact retained operation reconciles publication, not target equality");
            assert.deepEqual(f.open().listLiveRebindings(), [intent]);
            let target;
            f.threads.withWorkspaceRestoreSnapshot(intent, snapshot => {
              target = snapshot.workspaceBindings?.[0]?.target;
              return undefined;
            });
            assert.deepEqual(target, f.request.target, "Read the canonical transaction, not a potentially stale warm projection");
          }
        });
      });
    }
    test(`Live rebinding store rechecks authority at the actual rename boundary (${role}, ${layout})`, async () => {
      await withLiveRebindStoreFixture(role, layout, async f => {
        let current = true;
        const auth = { ...f.auth, isCurrent: () => current && f.auth.isCurrent() };
        const before = await readFile(f.path, "utf8");
        const store = f.open({ onPublicationBoundary(at) { if (at === "after-write-before-rename") current = false; } });
        assert.equal(await store.commitLiveRebind(f.request, recipient(role), auth), undefined);
        assert.equal(await readFile(f.path, "utf8"), before, "A staged candidate cannot spend a revoked grant");
        assert.deepEqual(f.open().listLiveRebindings(), []);
      });
    });
    test(`Live rebinding store current-grant loss refuses commit and state transitions (${role}, ${layout})`, async () => {
      await withLiveRebindStoreFixture(role, layout, async f => {
        const before = await readFile(f.path, "utf8");
        const stale = { ...f.auth, isCurrent: () => false };
        assert.equal(await f.store.commitLiveRebind(f.request, recipient(role), stale), undefined);
        assert.equal(await readFile(f.path, "utf8"), before);
        const intent = (await f.store.commitLiveRebind(f.request, recipient(role), f.auth))!;
        const rebound = await readFile(f.path, "utf8");
        assert.equal(f.store.advanceLiveRebind(intent, "release", stale), undefined);
        assert.equal(await readFile(f.path, "utf8"), rebound);
        const replacement = { ...f.auth, executor: { ...f.auth.executor, leaderEpoch: "replacement-epoch" } };
        assert.equal(f.store.advanceLiveRebind(intent, "release", replacement), undefined);
        const ended = f.store.advanceLiveRebind(intent, "not-issued", replacement)!;
        assert.ok(ended, "Current authority may end metadata without borrowing the old dispatch/delete grant");
        assert.deepEqual(ended.executor, intent.executor);
      });
    });
    for (const outcome of ["confirmed", "failed", "unknown", "not-issued"] as const) {
      test(`Live rebinding store records terminal cleanup without journal proof (${role}, ${layout}, ${outcome})`, async () => {
        await withLiveRebindStoreFixture(role, layout, async f => {
          let value = (await f.store.commitLiveRebind(f.request, recipient(role), f.auth))!;
          if (outcome !== "not-issued") value = f.store.advanceLiveRebind(value, "release", f.auth)!;
          if (outcome === "confirmed" || outcome === "unknown") value = f.store.advanceLiveRebind(value, "issue-cleanup", f.auth)!;
          const finished = f.store.advanceLiveRebind(value, outcome, f.auth)!;
          assert.equal(finished.phase, "finished"); assert.equal(finished.cleanup, outcome);
          assert.deepEqual(f.open().listLiveRebindings(), [finished]);
          assert.deepEqual(f.threads.listWorkspaceBindings()[0]?.target, f.request.target);
          assert.deepEqual(f.store.list(), []);
        });
      });
    }
  }
}

for (const layout of ["standalone", "consolidated"] as const) {
  test(`Finished live cleanup leaves the strict temporary-tab cleanup gate unchanged (${layout})`, async () => {
    await withLiveRebindStoreFixture("leader", layout, async f => {
      let live = (await f.store.commitLiveRebind(f.request, recipient("leader"), f.auth))!;
      live = f.store.advanceLiveRebind(live, "release", f.auth)!;
      live = f.store.advanceLiveRebind(live, "issue-cleanup", f.auth)!;
      assert.equal(f.store.advanceLiveRebind(live, "confirmed", f.auth)?.cleanup, "confirmed");
      const input = { journalBindingKey: "temp-source", updateIds: [800] };
      let entry = f.store.registerImplicitTemporaryThread(input, { chatId: 7, threadId: 55 }, "b".repeat(32), f.auth)!;
      assert.ok(entry);
      assert.equal(f.store.issueTemporaryThreadCleanup(entry, f.auth), undefined,
        "A confirmed live cleanup cannot stand in for the temporary tab's own exact cancellation evidence");
      assert.equal(f.store.recordTemporaryThreadInputCancellation(entry, input, f.auth, id => ({ journalBindingKey: input.journalBindingKey,
        updateId: id, operatorAuthorityId: "telegram-owner:8" })), undefined, "Foreign operator evidence still refuses");
      entry = f.store.recordTemporaryThreadInputCancellation(entry, input, f.auth, id => ({ journalBindingKey: input.journalBindingKey,
        updateId: id, operatorAuthorityId: "telegram-owner:7" }))!;
      const issued = f.store.issueTemporaryThreadCleanup(entry, f.auth)!;
      assert.equal(issued.issued, true);
      assert.equal(f.store.issueTemporaryThreadCleanup(issued.entry, f.auth), undefined, "The strict grant stays one-shot");
      assert.deepEqual(f.store.listLiveRebindings().map(value => value.cleanup), ["confirmed"]);
      assert.deepEqual(f.threads.listWorkspaceBindings()[0]?.target, f.request.target);
    });
  });
}

test("Live rebinding store consumes only target chooser metadata and preserves every saved input", async () => {
  await fixture(async f => {
    const path = join(dirname(f.path), "saved-input.json");
    const botIdentity = createTelegramUpdateJournalBotIdentity({ botToken: "live-store-fixture" });
    const journal = createTelegramUpdateJournalStore({ path, profileName: "default", botIdentity });
    journal.appendBatch([{ update_id: 100 }, { update_id: 101 }, { update_id: 102 }]);
    const journalBindingKey = createTelegramUpdateJournalBindingKey({ path, profileName: "default", botIdentity });
    const request = { ...f.request, source: { journalBindingKey, updateIds: [100] } };
    let entry = f.store.registerImplicitTemporaryThread(request.source, request.target, "a".repeat(32), f.auth)!;
    assert.ok(entry);
    entry = f.store.recordTemporaryThreadInput(entry, { journalBindingKey, updateIds: [101, 102] }, f.auth)!;
    assert.ok(entry);
    const before = await readFile(path, "utf8");
    const live = await f.store.commitLiveRebind(request, recipient("leader"), f.auth);
    assert.ok(live);
    assert.deepEqual(f.store.listTemporaryThreads(), [], "The new bound target is no longer a temporary chooser");
    assert.equal(await readFile(path, "utf8"), before, "Chooser retirement cannot dispose of selected or sibling inputs");
    assert.deepEqual(journal.read().entries.map(value => value.updateId), [100, 101, 102]);
  });
});

for (const kind of ["reservation", "provision", "binding", "owner", "legacy", "forget"] as const) {
  test(`Live rebinding store fences shared Workspace mutation and previous-runtime metadata (${kind})`, async () => {
    await fixture(async f => {
      const intent = (await f.store.commitLiveRebind(f.request, recipient("leader"), f.auth))!;
      assert.ok(intent);
      const before = await readFile(f.path, "utf8");
      if (kind === "reservation") assert.throws(() => f.threads.reserveThread({ target: f.request.binding.target,
        slot: "B", reason: "new-instance", createdAtMs: 1, updatedAtMs: 1 }), /Protected Workspace Restore/);
      if (kind === "provision") assert.throws(() => f.threads.upsertPendingProvision({ id: "other", instanceId: "other",
        owner: "manual-follower", target: f.request.target, startedAtMs: 1, expiresAtMs: 2 }), /Protected Workspace Restore/);
      if (kind === "legacy") {
        const legacyRequest = { ...f.request, operationId: "legacy", binding: f.threads.listWorkspaceBindings()[0]!,
          owner: f.threads.list()[0]!, target: { chatId: 7, threadId: 43 } };
        assert.equal(await f.store.commit(legacyRequest, f.auth), undefined);
      }
      if (kind === "binding") {
        f.threads.upsertWorkspaceBinding({ ...f.threads.listWorkspaceBindings()[0]!, target: { chatId: 7, threadId: 99 } });
        await assert.rejects(() => f.threads.persist(), /Protected Workspace Restore binding/);
      }
      if (kind === "owner") {
        f.threads.upsert({ ...f.threads.list()[0]!, instanceId: "changed" });
        await assert.rejects(() => f.threads.persist(), /Protected Workspace Restore owner/);
      }
      if (kind === "forget") {
        const auth = { ...f.auth, executor: { ...f.auth.executor, instanceId: "new-runtime" } };
        const forgotten = f.store.forgetPreviousWorld(auth)!;
        assert.deepEqual(forgotten.liveRebindings, [intent]);
        assert.deepEqual(f.store.listLiveRebindings(), []);
        assert.deepEqual(f.threads.listWorkspaceBindings()[0]?.target, f.request.target);
        return;
      }
      assert.equal(await readFile(f.path, "utf8"), before);
    });
  });
}

for (const layout of ["standalone", "consolidated"] as const) {
  for (const boundary of ["current", "queued", "before-publication", "after-publication"] as const) {
    test(`Guarded Workspace persistence fences caller authority (${layout}, ${boundary})`, async () => {
      await withConsolidatedWorkspaceFixture(async f => {
        f.owner.acquire({ cwd: "/repo" });
        let current = true;
        let armed = false;
        const path = layout === "consolidated" ? f.rootPath : join(f.dir, "guarded-state.json");
        const store = createTelegramTopicTargetStore({ path, telegramProfile: "default",
          ...(layout === "consolidated" ? { consolidated: {
            captureAuthority: f.consolidated.captureAuthority,
            publishIfOwned: <T>(...args: Parameters<typeof f.consolidated.publishIfOwned<T>>) => {
              if (armed && boundary === "before-publication") current = false;
              const result = f.consolidated.publishIfOwned(...args);
              if (armed && boundary === "after-publication") current = false;
              return result;
            },
          } } : { commitPersist(commit) {
            if (armed && boundary === "before-publication") current = false;
            commit();
            if (armed && boundary === "after-publication") current = false;
            return true;
          } }),
        });
        await store.load();
        store.setBotState({ threadMode: "enabled" });
        await store.persist();
        const before = await readFile(path, "utf8");
        store.setBotState({ threadMode: "disabled" });
        armed = true;
        const pending = store.persist(() => current);
        if (boundary === "queued") current = false;
        if (boundary === "current") await pending;
        else await assert.rejects(pending, /authority|frame/);
        const after = await readFile(path, "utf8");
        if (boundary === "queued" || boundary === "before-publication") assert.equal(after, before);
        else assert.notEqual(after, before);
        // A lost post-publication result is not permission to roll back or reissue.
        const reopened = createTelegramTopicTargetStore({ path, telegramProfile: "default",
          ...(layout === "consolidated" ? { consolidated: f.consolidated } : {}),
        });
        await reopened.load();
        assert.equal(reopened.getBotState()?.threadMode,
          boundary === "queued" || boundary === "before-publication" ? "enabled" : "disabled");
      });
    });
  }
}

for (const action of ["rename", "reset"] as const) for (const layout of ["standalone", "consolidated"] as const) {
  for (const boundary of ["current", "no-display", "queued", "before-publication", "after-publication", "lost-before", "lost-after", "newer-local", "canonical-name", "newer-after-publication", "newer-title-after-publication"] as const) {
    if ((action === "reset" && boundary === "no-display") || (action === "rename" && boundary === "newer-title-after-publication")) continue;
    test(`Staged ${action === "reset" ? "reset " : ""}manual-name publication never leaves a refused dirty candidate (${layout}, ${boundary})`, async () => {
      await withConsolidatedWorkspaceFixture(async f => {
        f.owner.acquire({ cwd: "/repo" });
        let current = true, armed = false, publications = 0;
        const path = layout === "consolidated" ? f.rootPath : join(f.dir, "manual-name.json");
        const beforePublication = () => {
          if (!armed) return;
          if (boundary === "before-publication") current = false;
          if (boundary === "lost-before") throw new Error("Manual-name publication reply lost before issuance");
          if (boundary === "canonical-name") {
            const change = (value: Record<string, unknown>) => {
              const record = (value.threads as Array<Record<string, unknown>>)[0]!;
              record.manualThreadName = "Canonical";
              const binding = (value.workspaceBindings as Array<Record<string, unknown>>)[0]!;
              binding.manualThreadName = "Canonical"; binding.displayTitle = "Canonical";
              return value;
            };
            if (layout === "consolidated") f.storage.capturePublication()!(value =>
              ({ value: change(structuredClone(value) as Record<string, unknown>), result: true }));
            else writeFileSync(path, `${JSON.stringify(change(JSON.parse(readFileSync(path, "utf8"))))}\n`);
          }
        };
        const afterPublication = () => {
          if (!armed) return;
          publications++;
          if (boundary === "after-publication") current = false;
          if (boundary === "lost-after") throw new Error("Manual-name publication reply lost after issuance");
          if (boundary === "newer-after-publication" || boundary === "newer-title-after-publication") {
            if (boundary === "newer-after-publication") store.renameByTarget({ chatId: 7, threadId: 41 }, "Newer");
            else store.setWorkspaceDisplayTitle(store.getWorkspaceBindingByTarget({ chatId: 7, threadId: 41 }, "first")!, "New title");
            store.setBotState({ threadMode: "enabled" });
          }
        };
        const store = createTelegramTopicTargetStore({ path, telegramProfile: "default", getNowMs: () => 3,
          ...(layout === "consolidated" ? { consolidated: {
            captureAuthority: f.consolidated.captureAuthority,
            publishIfOwned: <T>(...args: Parameters<typeof f.consolidated.publishIfOwned<T>>) => {
              beforePublication();
              const result = f.consolidated.publishIfOwned(...args);
              if (result.committed && result.result) afterPublication();
              return result;
            },
          } } : { commitPersist(commit) {
            beforePublication();
            const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
            commit();
            if (readFileSync(path, "utf8") !== before) afterPublication();
            return true;
          } }),
        });
        await store.load();
        const target = { chatId: 7, threadId: 41 };
        for (const [sessionId, threadId, slot, name] of [["first", 41, "A", "Anchor"], ["second", 42, "B", "Beacon"]] as const) {
          if (sessionId === "first") store.upsert({ owner: { kind: "leader", cwd: "/repo", instanceId: sessionId }, profileKey: sessionId,
            instanceId: sessionId, target: { chatId: 7, threadId }, slot, threadName: name,
            status: "active", createdAtMs: 1, updatedAtMs: 1 });
          store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/repo", slot === "A" ? 0 : 1, sessionId)!,
            target: { chatId: 7, threadId }, slot, threadName: name, displayTitle: name, updatedAtMs: 1 });
        }
        if (action === "reset") store.renameByTarget(target, "Retained");
        await store.persist();
        const before = await readFile(path, "utf8");
        const neighbor = store.getWorkspaceBindingByTarget({ chatId: 7, threadId: 42 }, "second");
        const options = { updateDisplayTitle: boundary !== "no-display" };
        armed = true;
        const pending = action === "rename" ? store.renameByTargetAndPersist(target, "Navigator", options, () => current)
          : store.clearManualNameByTargetAndPersist(target, "A", () => current);
        target.threadId = 99; options.updateDisplayTitle = !options.updateDisplayTitle;
        if (boundary === "queued") current = false;
        if (boundary === "newer-local") {
          store.renameByTarget({ chatId: 7, threadId: 41 }, "Newer");
          store.setBotState({ threadMode: "enabled" });
        }
        if (boundary === "current" || boundary === "no-display") assert.equal((await pending)?.manualThreadName, action === "rename" ? "Navigator" : undefined);
        else await assert.rejects(pending, /authority|frame|reply lost|changed|canonical/);
        armed = false;
        const committed = ["current", "no-display", "after-publication", "lost-after", "newer-after-publication", "newer-title-after-publication"].includes(boundary);
        const committedName = action === "rename" ? "Navigator" : undefined;
        const canonicalName = committed ? committedName : boundary === "canonical-name" ? "Canonical"
          : action === "reset" ? "Retained" : undefined;
        if (!committed && boundary !== "canonical-name") assert.equal(await readFile(path, "utf8"), before);
        const reopen = () => createTelegramTopicTargetStore({ path, telegramProfile: "default",
          ...(layout === "consolidated" ? { consolidated: f.consolidated } : {}) });
        const canonical = reopen(); await canonical.load();
        assert.equal(canonical.getWorkspaceBindingByTarget({ chatId: 7, threadId: 41 }, "first")?.manualThreadName,
          canonicalName);
        assert.deepEqual(canonical.getWorkspaceBindingByTarget({ chatId: 7, threadId: 42 }, "second"), neighbor);
        assert.equal(publications, committed ? 1 : 0, "Unknown publication never issues another candidate");
        if ((boundary === "newer-after-publication" || boundary === "newer-title-after-publication") && layout === "consolidated") {
          await assert.rejects(store.persist(), /canonical snapshot changed/);
          const newer = store.getWorkspaceBindingByTarget({ chatId: 7, threadId: 41 }, "first");
          assert.equal(boundary === "newer-after-publication" ? newer?.manualThreadName : newer?.displayTitle,
            boundary === "newer-after-publication" ? "Newer" : "New title",
            "A stale base refuses publication without erasing newer local work or refreshing it away");
          assert.equal(store.getBotState()?.threadMode, "enabled");
          return;
        }
        // A clean ordinary read may observe an issued unknown fact; no selected effect is reconstructed.
        await store.persist();
        store.setBotState({ threadMode: "disabled" });
        await store.persist();
        const later = reopen(); await later.load();
        const selected = later.getWorkspaceBindingByTarget({ chatId: 7, threadId: 41 }, "first");
        assert.equal(selected?.manualThreadName, boundary === "newer-local" || boundary === "newer-after-publication" ? "Newer"
          : canonicalName);
        assert.equal(later.getActiveByInstanceId("first")?.manualThreadName, selected?.manualThreadName);
        assert.equal(selected?.displayTitle, boundary === "newer-title-after-publication" ? "New title"
          : boundary === "no-display" ? "Anchor" : selected?.manualThreadName ?? (action === "reset" && committed ? "A" : "Anchor"));
        assert.deepEqual(later.getWorkspaceBindingByTarget({ chatId: 7, threadId: 42 }, "second"), neighbor);
        assert.equal(later.getBotState()?.threadMode, "disabled", "Refused metadata does not freeze unrelated work");
      });
    });
  }
}


for (const layout of ["standalone", "consolidated"] as const) {
  test(`Staged reset refuses invalid or unavailable entry evidence without effects (${layout})`, async () => {
    await withConsolidatedWorkspaceFixture(async f => {
      f.owner.acquire({ cwd: "/repo" });
      const path = layout === "consolidated" ? f.rootPath : join(f.dir, "reset-entry.json");
      const store = createTelegramTopicTargetStore({ path, telegramProfile: "default",
        ...(layout === "consolidated" ? { consolidated: f.consolidated } : {}) });
      await store.load();
      const target = { chatId: 7, threadId: 41 };
      store.upsert({ owner: { kind: "leader", cwd: "/repo", instanceId: "first" }, profileKey: "first",
        instanceId: "first", target, slot: "A", threadName: "Anchor", status: "active", createdAtMs: 1, updatedAtMs: 1 });
      store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/repo", 0, "first")!,
        target, slot: "A", threadName: "Anchor", updatedAtMs: 1 });
      store.renameByTarget(target, "Retained");
      await store.persist();
      const before = await readFile(path, "utf8"), inode = (await stat(path)).ino;
      for (const [address, title, current] of [[target, "", true], [target, "A", false],
        [{ chatId: 7, threadId: 99 }, "A", true]] as const) {
        assert.equal(await store.clearManualNameByTargetAndPersist(address, title, () => current), undefined);
      }
      const binding = store.listWorkspaceBindings()[0]!;
      store.upsertWorkspaceBinding({ ...binding, target: { chatId: 7, threadId: 99 } });
      assert.equal(await store.clearManualNameByTargetAndPersist(target, "A", () => true), undefined);
      assert.equal(store.getActiveByInstanceId("first")?.manualThreadName, "Retained");
      assert.equal(await readFile(path, "utf8"), before);
      assert.equal((await stat(path)).ino, inode, "Entry refusal publishes no read or candidate");
      await store.refresh!();
      assert.equal(store.getWorkspaceBindingByTarget(target, "first")?.manualThreadName, "Retained");
    });
  });
}

for (const action of ["rename", "reset"] as const) {
for (const layout of ["standalone", "consolidated"] as const) {
  for (const boundary of ["current", "scope", "local", "canonical", "unavailable", "retirement", "publication-frame", ...(action === "reset" ? ["result"] as const : [])] as const) {
    test(`Read-only ${action} observation captures exact local/canonical identity (${layout}, ${boundary})`, async () => {
      await withConsolidatedWorkspaceFixture(async f => {
        f.owner.acquire({ cwd: "/repo" });
        const scope = { path: layout === "consolidated" ? f.rootPath : join(f.dir, `${action}-observation.json`), profile: "default" };
        const store = createTelegramTopicTargetStore({ path: () => scope.path, telegramProfile: () => scope.profile,
          ...(layout === "consolidated" ? { consolidated: f.consolidated } : {}), getNowMs: () => 3 });
        await store.load();
        const target = { chatId: 7, threadId: 41 };
        store.upsert({ owner: { kind: "leader", cwd: "/repo", instanceId: "first", telegramProfile: "default" }, profileKey: "first", instanceId: "first",
          target, slot: "A", threadName: "Anchor", status: "active", createdAtMs: 1, updatedAtMs: 1 });
        store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/repo", 0, "session-first")!,
          target, slot: "A", threadName: "Anchor", updatedAtMs: 1 });
        store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/repo", 1, "session-other")!,
          target: { chatId: 7, threadId: 42 }, slot: "B", threadName: "Beacon", updatedAtMs: 1 });
        if (action === "reset") store.renameByTarget(target, "Retained");
        await store.persist();
        const binding = store.listWorkspaceBindings()[0]!, owner = store.list()[0]!;
        const capture = (binding: Parameters<typeof store.captureWorkspaceThreadRenameObservation>[0],
          owner: Parameters<typeof store.captureWorkspaceThreadRenameObservation>[1]) => {
          if (action === "rename") return store.captureWorkspaceThreadRenameObservation(binding, owner);
          const observed = store.captureWorkspaceThreadResetObservation(binding, owner);
          return (title?: string) => title === undefined ? observed.isCurrent() : observed.isResultCurrent(title);
        };
        const current = capture(binding, owner);
        const bytes = await readFile(scope.path, "utf8"), inode = (await stat(scope.path)).ino;
        const local = { records: store.list(), bindings: store.listWorkspaceBindings() };
        assert.equal(current(), true);
        assert.equal(await readFile(scope.path, "utf8"), bytes);
        assert.equal((await stat(scope.path)).ino, inode, "Observation never publishes a read");
        assert.deepEqual({ records: store.list(), bindings: store.listWorkspaceBindings() }, local);
        const neighbor = store.listWorkspaceBindings()[1]!;
        const writeCanonical = async (mutate: (file: Record<string, any>) => void) => {
          const raw = JSON.parse(bytes);
          mutate(layout === "consolidated" ? raw.profiles.default.workspace : raw);
          await writeFile(scope.path, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
        };
        if (boundary === "current") {
          assert.equal(capture({ ...binding, sessionId: undefined }, owner)(), false);
          assert.equal(capture(binding, { ...owner, profileKey: "foreign" })(), false);
          assert.equal(capture(binding, { ...owner, status: "offline" })(), false);
          binding.target.threadId = 99; binding.sessionId = "mutated"; owner.owner = { kind: "legacy", key: "mutated" };
          assert.equal(current(), true, "Caller objects cannot redirect captured identity");
          if (action === "reset") {
            assert.equal(current("Retained"), false, "Present manual names are not reset-result authority");
            store.clearManualNameByTarget(target, "A"); store.setBotState({ threadMode: "enabled" });
            assert.equal(current(), true, "Intended metadata is not binding replacement");
            assert.equal(current("A"), false, "Local reset cannot certify unpublished canonical absence/title");
            await store.persist();
            assert.equal(current("A"), true);
            assert.equal(current("Older"), false);
            const observed = store.captureWorkspaceThreadResetObservation(local.bindings[0]!, local.records[0]!);
            for (const title of [undefined, "", " A ", "A\n", 1] as const)
              assert.equal(observed.isResultCurrent(title as string), false, "Missing/invalid title is not identity-only authority");
            store.setBotState({ threadMode: "disabled" });
            assert.equal(current("A"), true, "Unrelated dirty work does not freeze observation");
            store.upsert({ ...store.list()[0]!, threadName: "Generated" });
            assert.equal(current("A"), true, "Generated identity is independent of the acknowledged automatic title");
            assert.deepEqual(store.listWorkspaceBindings()[1], neighbor);
            await writeCanonical(file => { file.workspaceBindings[0].manualThreadName = "Canonical";
              file.threads[0].manualThreadName = "Canonical"; });
            const changed = await readFile(scope.path, "utf8");
            assert.equal(current(), true, "Name-only drift retains identity, not reset-result authority");
            assert.equal(current("A"), false);
            assert.equal(await readFile(scope.path, "utf8"), changed, "No canonical repair or publication");
            assert.equal(store.getActiveByInstanceId("first")?.manualThreadName, undefined, "No local refresh");
            return;
          }
          store.renameByTarget(target, "Newer"); store.setBotState({ threadMode: "enabled" });
          assert.equal(current(), true, "Intended name metadata is not binding replacement");
          assert.equal(current("Newer"), false, "Local name cannot certify unpublished canonical metadata");
          await store.persist();
          assert.equal(current(), true);
          assert.equal(current("Newer"), true, "Optional result fence requires exact local and canonical names");
          assert.equal(current("Older"), false);
          assert.equal(store.getActiveByInstanceId("first")?.manualThreadName, "Newer");
          assert.deepEqual(store.listWorkspaceBindings()[1], neighbor);
          await writeCanonical(file => { file.workspaceBindings[0].manualThreadName = "Canonical";
            file.threads[0].manualThreadName = "Canonical"; });
          const changed = await readFile(scope.path, "utf8");
          assert.equal(current(), true, "Name-only canonical drift retains identity, not result authority");
          assert.equal(current("Newer"), false);
          assert.equal(await readFile(scope.path, "utf8"), changed, "Result observation never repairs or publishes");
          assert.equal(store.getActiveByInstanceId("first")?.manualThreadName, "Newer", "No projection refresh");
        } else if (boundary === "scope") {
          scope.profile = "other"; assert.equal(current(), false);
          scope.profile = "default"; scope.path = join(f.dir, "absent.json"); assert.equal(current(), false);
          assert.equal(existsSync(scope.path), false, "Missing scope is never created");
        } else if (boundary === "local" || boundary === "canonical") {
          for (const field of ["session", "slot", "target", "inactive", "owner", "status", "duplicate"] as const) {
            if (boundary === "local") {
              const originalBinding = local.bindings[0]!, originalOwner = local.records[0]!;
              store.upsertWorkspaceBinding({ ...originalBinding,
                ...(field === "session" ? createTelegramWorkspaceBindingIdentity("/repo", 0, "replacement")! : {}),
                ...(field === "slot" ? { slot: "C" } : {}),
                ...(field === "target" ? { target: { chatId: 7, threadId: 99 } } : {}),
                ...(field === "inactive" ? { inactiveSinceMs: 2 } : {}) });
              store.upsert({ ...originalOwner, ...(field === "owner" ? { instanceId: "replacement" } : {}),
                ...(field === "status" ? { status: "offline" as const } : {}) });
              if (field === "duplicate") store.upsertWorkspaceBinding({ ...neighbor, target });
            } else await writeCanonical(file => {
              const b = file.workspaceBindings[0], r = file.threads[0];
              if (field === "session") Object.assign(b, createTelegramWorkspaceBindingIdentity("/repo", 0, "replacement")!);
              if (field === "slot") b.slot = "C";
              if (field === "target") b.target.threadId = 99;
              if (field === "inactive") b.inactiveSinceMs = 2;
              if (field === "owner") r.instanceId = "replacement";
              if (field === "status") r.status = "offline";
              if (field === "duplicate") file.workspaceBindings.push({ ...file.workspaceBindings[1], target });
            });
            assert.equal(current(), false, `${boundary} ${field} drift cannot borrow the address`);
            if (boundary === "local") { await store.refresh!(); }
          }
        } else if (boundary === "unavailable") {
          for (const field of ["missing-owner", "dropped-owner", "missing-binding", "dropped-retirement", "unsupported"] as const) {
            await writeCanonical(file => {
              if (field === "missing-owner") file.threads = [];
              if (field === "dropped-owner") file.threads.push({ target });
              if (field === "missing-binding") file.workspaceBindings = [];
              if (field === "dropped-retirement") file.workspaceRetirements = [{}];
              if (field === "unsupported") file.version = 9;
            });
            const damaged = await readFile(scope.path, "utf8");
            assert.equal(current(), false, `Unavailable ${field} evidence refuses`);
            assert.equal(await readFile(scope.path, "utf8"), damaged, "No reset or repair");
            assert.deepEqual({ records: store.list(), bindings: store.listWorkspaceBindings() }, local, "No projection refresh");
          }
          await writeFile(scope.path, "broken", { mode: 0o600 }); assert.equal(current(), false);
        } else if (boundary === "retirement") {
          await writeCanonical(file => { file.workspaceRetirements = [{ id: "retire:rename", reason: "pressure",
            profileKey: "default", binding: { ...file.workspaceBindings[0], inactiveSinceMs: 2 },
            leaderEpoch: "leader:1", requestedAtMs: 3 }]; });
          assert.equal(current(), false);
        } else if (boundary === "result") {
          assert.ok(await store.clearManualNameByTargetAndPersist(target, "A", () => current()));
          const resetBytes = await readFile(scope.path, "utf8");
          const resetInode = (await stat(scope.path)).ino;
          const resetBinding = store.listWorkspaceBindings()[0]!, resetOwner = store.list()[0]!;
          assert.equal(current("A"), true);
          for (const side of ["local", "canonical"] as const) {
            for (const field of ["owner-name", "binding-name", "title",
              ...(side === "canonical" ? ["missing-title", "empty-owner-name", "null-binding-name", "space-title"] as const : [])] as const) {
              if (side === "local") {
                store.upsert({ ...resetOwner, ...(field === "owner-name" ? { manualThreadName: "Newer" } : {}) });
                store.upsertWorkspaceBinding({ ...resetBinding,
                  ...(field === "binding-name" ? { manualThreadName: "Newer" } : {}) });
                if (field === "title") assert.equal(store.setWorkspaceDisplayTitle(resetBinding, "Newer title"), true);
              } else {
                const raw = JSON.parse(resetBytes), file = layout === "consolidated" ? raw.profiles.default.workspace : raw;
                if (field === "owner-name") file.threads[0].manualThreadName = "Newer";
                if (field === "binding-name") file.workspaceBindings[0].manualThreadName = "Newer";
                if (field === "title") file.workspaceBindings[0].displayTitle = "Newer title";
                if (field === "missing-title") delete file.workspaceBindings[0].displayTitle;
                if (field === "empty-owner-name") file.threads[0].manualThreadName = "";
                if (field === "null-binding-name") file.workspaceBindings[0].manualThreadName = null;
                if (field === "space-title") file.workspaceBindings[0].displayTitle = " A ";
                await writeFile(scope.path, `${JSON.stringify(raw)}\n`, { mode: 0o600 });
              }
              const retained = { records: store.list(), bindings: store.listWorkspaceBindings() };
              const changedBytes = await readFile(scope.path, "utf8"), changedInode = (await stat(scope.path)).ino;
              const lossless = field !== "empty-owner-name" && field !== "null-binding-name";
              assert.equal(current(), lossless, `${side} ${field}: valid metadata retains identity; normalization cannot invent absence/title evidence`);
              assert.equal(current("A"), false, `${side} ${field} drift refuses exact reset result`);
              assert.equal(await readFile(scope.path, "utf8"), changedBytes);
              assert.equal((await stat(scope.path)).ino, changedInode, "Observation writes no frame");
              assert.deepEqual({ records: store.list(), bindings: store.listWorkspaceBindings() }, retained, "No refresh/dirty loss");
              assert.deepEqual(store.listWorkspaceBindings()[1], neighbor);
              if (side === "canonical") await writeFile(scope.path, resetBytes, { mode: 0o600 });
              await store.refresh!();
              assert.equal(current("A"), true, "Result observation is current, not a sticky failure or success");
            }
          }
          assert.equal(await readFile(scope.path, "utf8"), resetBytes);
          assert.equal((await stat(scope.path)).ino, resetInode);
        } else {
          let checks = 0;
          const guard = () => { checks++; return current(); };
          const renamed = action === "rename" ? await store.renameByTargetAndPersist(target, "Navigator", { updateDisplayTitle: true }, guard)
            : await store.clearManualNameByTargetAndPersist(target, "A", guard);
          assert.ok(renamed);
          assert.equal(renamed.manualThreadName, action === "rename" ? "Navigator" : undefined);
          assert.equal(current(action === "rename" ? "Navigator" : "A"), true);
          assert.ok(checks > 1, "Observation remains callable inside native staged publication without another transaction");
          assert.equal(current(), true);
          assert.deepEqual(store.listWorkspaceBindings()[1], neighbor);
        }
      });
    });
  }
}

}

for (const operation of ["rename", "reset"] as const) {
  for (const boundary of ["capture-observation", "authority-observation", "result-observation", "authority-getter"] as const) {
    for (const loss of ["caller", "session", ...(boundary === "result-observation" ? ["local", "canonical"] as const : [])] as const) {
      test(`Thread name recipient refuses post-observation loss (${operation}, ${boundary}, ${loss})`, async () => {
        await withWorkspaceRelocationFixture("leader", async (store, path) => {
          const target = { chatId: 7, threadId: 10 }, context = {};
          const authority: TelegramWorkspaceThreadRenameAuthority = {
            context, sessionId: "session", sessionGeneration: 1, cwd: "/repo", profileName: "default",
            botToken: "123:fixture", operatorUserId: 7, leaderEpoch: "epoch", ownsDirectDelivery: true,
            followerRegistered: false, localTarget: target, localSlot: "A",
          };
          let armed = false, current = true, observations = 0;
          let retained: { bytes: string; records: ReturnType<typeof store.list>; bindings: ReturnType<typeof store.listWorkspaceBindings> } | undefined;
          const drift = () => {
            if (!armed) return;
            armed = false;
            if (loss === "caller") current = false;
            if (loss === "session") authority.sessionGeneration++;
            if (loss === "local") store.upsert({ ...store.list()[0]!, status: "offline" });
            if (loss === "canonical") {
              const file = JSON.parse(readFileSync(path, "utf8"));
              file.workspaceBindings[0].target.threadId = 99;
              writeFileSync(path, JSON.stringify(file), { mode: 0o600 });
            }
            retained = { bytes: readFileSync(path, "utf8"), records: store.list(), bindings: store.listWorkspaceBindings() };
          };
          const observe = (read: () => boolean, result: boolean) => {
            const value = read();
            observations++;
            if ((boundary === "result-observation") === result && boundary !== "authority-getter") drift();
            return value;
          };
          const renameObservation = store.captureWorkspaceThreadRenameObservation;
          store.captureWorkspaceThreadRenameObservation = (...args) => {
            const read = renameObservation(...args);
            return name => observe(() => read(name), name !== undefined);
          };
          const resetObservation = store.captureWorkspaceThreadResetObservation;
          store.captureWorkspaceThreadResetObservation = (...args) => {
            const read = resetObservation(...args);
            return { isCurrent: () => observe(read.isCurrent, false),
              isResultCurrent: title => observe(() => read.isResultCurrent(title), true) };
          };
          const deps = { store, instanceId: "old", target,
            assertAuthority() { if (!current) throw new Error("Caller recipient revoked"); },
            getAuthority() {
              const value = { ...authority };
              if (boundary === "authority-getter") drift();
              return value;
            } };
          const prepare = () => operation === "rename"
            ? createTelegramWorkspaceThreadRenameRecipient(deps) : createTelegramWorkspaceThreadResetRecipient(deps);
          const originalBytes = await readFile(path, "utf8");
          if (boundary === "capture-observation") {
            armed = true;
            assert.throws(prepare, /recipient|authority/u);
          } else {
            const recipient = prepare();
            const result = operation === "rename"
              ? await store.renameByTargetAndPersist(target, "Navigator", { updateDisplayTitle: true }, () => true)
              : await store.clearManualNameByTargetAndPersist(target, "A", () => true);
            assert.ok(result);
            armed = true;
            assert.throws(() => boundary === "result-observation"
              ? (recipient.assertResult as (value: unknown) => void)(operation === "rename" ? result : "A")
              : recipient.assertAuthority(), /recipient|authority/u);
            assert.ok(retained, "Loss was observed at the intended boundary");
            assert.equal(await readFile(path, "utf8"), retained.bytes, "Refusal never writes or rolls back published name metadata");
            assert.deepEqual({ records: store.list(), bindings: store.listWorkspaceBindings() },
              { records: retained.records, bindings: retained.bindings }, "Observation preserves newer dirty projections");
          }
          if (boundary === "capture-observation") assert.equal(await readFile(path, "utf8"), originalBytes);
          assert.ok(observations > 0);
          assert.equal(armed, false, "The intended synchronous boundary actually ran");
        });
      });
    }
  }
}

function openConsolidatedTopicStore(f: Parameters<Parameters<typeof withConsolidatedWorkspaceFixture>[0]>[0]) {
  return createTelegramTopicTargetStore({ path: () => f.scope.path, telegramProfile: () => f.scope.profile,
    consolidated: f.consolidated, getNowMs: () => 1000, canPersist: () => f.owner.owns() });
}

test("Consolidated Thread store loads and publishes real Workspace data without replacing sibling sections", async () => {
  await withConsolidatedWorkspaceFixture(async f => {
    f.owner.acquire({ cwd: "/repo" });
    f.storage.capturePublication()!(() => ({ value: f.workspace, result: true }));
    const store = openConsolidatedTopicStore(f);
    await store.load();
    assert.equal(store.listWorkspaceBindings()[0]?.target.threadId, 42);
    assert.equal(store.workspaceRestore({ profileName: "default", tokenSha256: "a".repeat(64) }).list()[0]?.phase, "recipient-issued");
    const before = readTelegramRuntimeState(f.rootPath);
    store.setBotState({ threadMode: "enabled" });
    await store.persist();
    assert.deepEqual(readTelegramRuntimeState(f.rootPath).profiles.default?.transport, before.profiles.default?.transport);
    assert.equal(f.storage.read()?.bot.threadMode, "enabled");
    const bytes = await readFile(f.rootPath, "utf8"), inode = (await stat(f.rootPath)).ino;
    await store.persist();
    assert.equal(await readFile(f.rootPath, "utf8"), bytes);
    assert.equal((await stat(f.rootPath)).ino, inode);
    store.setStatusSnapshot({ runtime: { pollingActive: true }, liveRoster: { busFollowers: [] }, diagnostics: { recentRuntimeEvents: [{ event: "logged" }] } });
    await store.persistStatus();
    assert.equal(existsSync(join(f.dir, "consolidated.json.status")), false);
    assert.equal((readTelegramRuntimeState(f.rootPath).profiles.default?.runtime as any).diagnostics.recentRuntimeEvents, undefined);
  });
});

for (const replacement of ["new-session", "same-context-restart"] as const) {
  test(`Production session-bound Workspace grant cannot publish after ${replacement}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pt-session-grant-")), path = join(dir, "state.json");
    try {
      const lock = createSessionGrantLock<{ cwd: string }>({ statePath: path, instanceId: "session-grant", isProcessAlive: () => true });
      const sessions = createTelegramSessionContextStore<{ cwd: string }>(), ctx = { cwd: "/repo" };
      sessions.set(ctx);
      assert.equal(lock.acquire(ctx).ok, true);
      const epoch = lock.getOwnedLeaderEpoch();
      const store = createTelegramTopicTargetStore({ path, canPersist: lock.owns, consolidated: {
        captureAuthority: createTelegramOwnedStateAuthorityCapture(lock, sessions), publishIfOwned: lock.publishStateSectionIfOwned! } });
      await store.load();
      store.setBotState({ threadMode: "enabled" });
      await store.persist();
      const before = await readFile(path, "utf8");
      store.setBotState({ threadMode: "disabled" });
      const stale = store.persist();
      // The grant is captured synchronously; the successor appears before the queued publication runs.
      if (replacement === "new-session") sessions.set({ cwd: "/repo" }); else { sessions.clear(ctx); sessions.set(ctx); }
      assert.equal(lock.getOwnedLeaderEpoch(), epoch, "Ownership and epoch alone would still look current");
      await assert.rejects(stale, /lost captured publication authority/u);
      assert.equal(await readFile(path, "utf8"), before, "The predecessor capture publishes nothing");
      await store.refresh!();
      assert.equal(store.getBotState().threadMode, "enabled");
      store.setBotState({ threadMode: "disabled" });
      await store.persist();
      assert.equal(readTelegramRuntimeState(path).profiles.default?.workspace !== undefined, true);
      await store.refresh!();
      assert.equal(store.getBotState().threadMode, "disabled", "The successor session publishes with its own fresh grant");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("Consolidated Thread store rejects stale whole-Workspace overwrite and refreshes before a new mutation", async () => {
  await withConsolidatedWorkspaceFixture(async f => {
    f.owner.acquire({ cwd: "/repo" });
    f.storage.capturePublication()!(() => ({ value: f.workspace, result: true }));
    const store = openConsolidatedTopicStore(f);
    await store.load();
    store.setBotState({ threadMode: "enabled" });
    f.storage.capturePublication()!(current => {
      const changed = current as Record<string, any>;
      changed.bot.lastReconcileAction = "concurrent-change";
      return { value: changed, result: true };
    });
    const bytes = await readFile(f.rootPath, "utf8");
    await assert.rejects(store.persist(), /canonical snapshot changed/);
    assert.equal(await readFile(f.rootPath, "utf8"), bytes);
    await store.refresh!();
    store.setBotState({ threadMode: "enabled" });
    await store.persist();
    assert.equal(f.storage.read()?.bot.lastReconcileAction, "concurrent-change");
  });
});

for (const drift of ["generation", "profile", "path", "owner"] as const) {
  test(`Consolidated Thread store fences a queued publisher (${drift})`, async () => {
    await withConsolidatedWorkspaceFixture(async f => {
      f.owner.acquire({ cwd: "/repo" });
      f.storage.capturePublication()!(() => ({ value: f.workspace, result: true }));
      const store = openConsolidatedTopicStore(f);
      await store.load();
      store.setBotState({ threadMode: "enabled" });
      const pending = assert.rejects(store.persist(), /captured publication authority/);
      if (drift === "generation") f.scope.generation++;
      if (drift === "profile") f.scope.profile = "other";
      if (drift === "path") f.scope.path = join(f.dir, "other-state.json");
      if (drift === "owner") f.owner.release();
      const before = await readFile(f.rootPath, "utf8");
      await pending;
      assert.equal(await readFile(f.rootPath, "utf8"), before);
      assert.equal(existsSync(join(f.dir, "other-state.json")), false);
    });
  });
}

test("Consolidated Thread store isolates in-memory projections across profiles sharing one physical path", async () => {
  await withConsolidatedWorkspaceFixture(async f => {
    f.owner.acquire({ cwd: "/repo" });
    f.storage.capturePublication()!(() => ({ value: f.workspace, result: true }));
    const store = openConsolidatedTopicStore(f);
    await store.load();
    f.owner.release(); f.scope.profile = "other";
    f.owner.acquire({ cwd: "/other" });
    await store.refresh!();
    assert.deepEqual(store.listWorkspaceBindings(), []);
    assert.deepEqual(store.list(), []);
    store.setBotState({ threadMode: "disabled" });
    await store.persist();
    assert.equal(f.storage.read()?.bot.threadMode, "disabled");
    f.owner.release(); f.scope.profile = "default";
    f.owner.acquire({ cwd: "/repo" });
    await store.refresh!();
    assert.equal(store.listWorkspaceBindings()[0]?.target.threadId, 42);
  });
});

for (const prefix of ["after-write-before-rename", "after-rename"] as const) {
  test(`Consolidated Restore one-shot publication retains unknown outcome (${prefix})`, async () => {
    await withConsolidatedWorkspaceFixture(async f => {
      f.owner.acquire({ cwd: "/repo" });
      const initial = structuredClone(f.workspace) as Record<string, any>;
      delete initial.workspaceRestore;
      initial.threads[0].target.threadId = 10;
      initial.workspaceBindings[0].target.threadId = 10;
      f.storage.capturePublication()!(() => ({ value: initial, result: true }));
      const store = openConsolidatedTopicStore(f);
      await store.load();
      let fail = false;
      const view = store.workspaceRestore({ profileName: "default", tokenSha256: "a".repeat(64), getNowMs: () => 1000,
        onPublicationBoundary(at) { if (fail && at === prefix) throw new Error("lost issued reply"); } });
      const auth = { executor: { instanceId: "leader", leaderEpoch: "epoch" }, operatorUserId: 7, isCurrent: () => true };
      const restored = await view.commit({ operationId: "restore-new", binding: store.listWorkspaceBindings()[0]!, owner: store.list()[0]!,
        target: { chatId: 7, threadId: 99 }, source: { journalBindingKey: "source", updateIds: [500] } }, auth);
      assert.ok(restored);
      fail = true;
      assert.throws(() => view.issueRecipient(restored, recipient("leader"), auth));
      const reopened = openConsolidatedTopicStore(f);
      await reopened.load();
      const fresh = reopened.workspaceRestore({ profileName: "default", tokenSha256: "a".repeat(64) }), retained = fresh.list()[0]!;
      assert.equal(retained.phase, prefix === "after-rename" ? "recipient-issued" : "relocated");
      if (prefix === "after-rename") assert.equal(fresh.issueRecipient(retained, recipient("leader"), auth), undefined);
    });
  });
}

test("Consolidated temporary cleanup preserves exact cancellation and one-shot issuance across reconstruction", async () => {
  await withConsolidatedWorkspaceFixture(async f => {
    f.owner.acquire({ cwd: "/repo" });
    f.storage.capturePublication()!(() => ({ value: f.workspace, result: true }));
    const threads = openConsolidatedTopicStore(f);
    await threads.load();
    const view = threads.workspaceRestore({ profileName: "default", tokenSha256: "a".repeat(64), getNowMs: () => 1000 });
    const auth = { executor: { instanceId: "leader", leaderEpoch: "epoch" }, operatorUserId: 7, isCurrent: () => true };
    const input = { journalBindingKey: "temp-source", updateIds: [800] };
    let entry = view.registerImplicitTemporaryThread(input, { chatId: 7, threadId: 55 }, "b".repeat(32), auth)!;
    assert.ok(entry);
    assert.deepEqual(threads.listTemporaryThreadTargets(), [{ chatId: 7, threadId: 55 }]);
    entry = view.recordTemporaryThreadInputCancellation(entry, input, auth, id => ({ journalBindingKey: input.journalBindingKey,
      updateId: id, operatorAuthorityId: "telegram-owner:7" }))!;
    const issued = view.issueTemporaryThreadCleanup(entry, auth)!;
    assert.equal(issued.issued, true);
    const freshThreads = openConsolidatedTopicStore(f);
    await freshThreads.load();
    const fresh = freshThreads.workspaceRestore({ profileName: "default", tokenSha256: "a".repeat(64) });
    const retained = fresh.listTemporaryThreads()[0]!;
    const before = await readFile(f.rootPath, "utf8");
    assert.equal(retained.cleanupIssued, true);
    assert.equal(fresh.isTemporaryThreadCleanupCurrent(retained, auth), true);
    assert.equal(fresh.inspectTemporaryThreadTarget(retained, auth)?.kind, "unknown");
    assert.equal(fresh.issueTemporaryThreadCleanup(retained, auth), undefined);
    assert.equal(await readFile(f.rootPath, "utf8"), before);
  });
});

test("Consolidated Thread store refuses mixed publication backends", () => {
  assert.throws(() => createTelegramTopicTargetStore({ path: "/unused/state.json", commitPersist: () => true,
    consolidated: { captureAuthority: () => () => true, publishIfOwned: () => ({ committed: false }) } }), /one publication backend/);
});

test("Consolidated Restore relocates, publishes exact one-shot grants and observes registration in the same Workspace section", async () => {
  await withConsolidatedWorkspaceFixture(async f => {
    f.owner.acquire({ cwd: "/repo" });
    const initial = structuredClone(f.workspace) as Record<string, any>;
    delete initial.workspaceRestore;
    initial.threads[0].target.threadId = 10;
    initial.workspaceBindings[0].target.threadId = 10;
    f.storage.capturePublication()!(() => ({ value: initial, result: true }));
    const store = openConsolidatedTopicStore(f);
    await store.load();
    const view = store.workspaceRestore({ profileName: "default", tokenSha256: "a".repeat(64), getNowMs: () => 1000 });
    const auth = { executor: { instanceId: "leader", leaderEpoch: "epoch" }, operatorUserId: 7, isCurrent: () => true };
    const request = { operationId: "new-restore", binding: store.listWorkspaceBindings()[0]!, owner: store.list()[0]!,
      target: { chatId: 7, threadId: 99 }, source: { journalBindingKey: "source", updateIds: [500] } };
    const relocated = await view.commit(request, auth);
    assert.ok(relocated);
    assert.equal(store.listWorkspaceBindings()[0]?.target.threadId, 99);
    const issued = view.issueRecipient(relocated, recipient("leader"), auth)!;
    assert.equal(issued.issued, true);
    const reopened = openConsolidatedTopicStore(f);
    await reopened.load();
    const reopenedView = reopened.workspaceRestore({ profileName: "default", tokenSha256: "a".repeat(64) });
    assert.equal(reopenedView.issueRecipient(issued.intent, recipient("leader"), auth), undefined);
    let published = 0;
    reopened.commitWorkspaceRestoreRegistration({ target: request.target, bindingKey: request.binding.bindingKey, slot: "A" }, () => { published++; });
    assert.equal(published, 1);
    reopened.withWorkspaceRestoreSnapshot(issued.intent, snapshot => { assert.equal(snapshot.workspaceBindings?.[0]?.target.threadId, 99); return undefined; });
    await reopened.persist();
    assert.equal(reopenedView.list()[0]?.phase, "recipient-issued");
  });
});

const restoreStorage = (store: ReturnType<typeof createTelegramTopicTargetStore>) =>
  store.workspaceRestore({ profileName: "default", tokenSha256: "a".repeat(64), getNowMs: () => 1000 });
const restorations = (store: ReturnType<typeof createTelegramTopicTargetStore>) => restoreStorage(store).list();
function relocate(store: ReturnType<typeof createTelegramTopicTargetStore>, operationId: string,
  binding: TelegramWorkspaceRestoreIntent["request"]["binding"], owner: TelegramWorkspaceRestoreIntent["request"]["owner"],
  target: TelegramWorkspaceRestoreIntent["request"]["target"], isCurrent: () => boolean) {
  if (!isCurrent()) return Promise.resolve(false);
  return restoreStorage(store).commit({ operationId, binding, owner, target,
    source: { journalBindingKey: "fixture-journal", updateIds: [100] } }, {
    executor: { instanceId: "leader", leaderEpoch: "epoch" }, operatorUserId: 7, isCurrent }).then(Boolean);
}
/** Unit evidence for legitimate terminal transitions; native journal ACKs have separate integration coverage. */
function settleStoredRestore(store: ReturnType<typeof createTelegramTopicTargetStore>) {
  const view = restoreStorage(store), operation = view.list()[0]!;
  const authority = { executor: { instanceId: "leader", leaderEpoch: "epoch" }, operatorUserId: 7, isCurrent: () => true };
  const recipient = { kind: operation.request.owner.owner?.kind === "leader" ? "leader" as const : "follower" as const,
    instanceId: operation.request.owner.instanceId!, sessionId: operation.request.binding.sessionId!, generation: "fixture" };
  const issued = view.issueRecipient(operation, recipient, authority)!.intent;
  const ready = view.confirmReady(issued, recipient, authority)!;
  const routing = view.issueRouting(ready, authority)!.intent;
  const settled = view.recordSourceSettlement(routing, { ...operation.request.source, kind: "completed" }, authority)!;
  return view.recordCleanup(settled, { target: operation.request.binding.target, kind: "not-issued" }, authority)!;
}
function removeStoredRestore(store: ReturnType<typeof createTelegramTopicTargetStore>, expected: TelegramWorkspaceRestoreIntent, isCurrent: () => boolean) {
  if (!isCurrent()) return false;
  return !!restoreStorage(store).retire(expected, { executor: { instanceId: "leader", leaderEpoch: "epoch" }, operatorUserId: 7, isCurrent });
}

for (const role of ["leader", "follower"] as const) {
  test(`Workspace relocation preserves the exact session and slot at full capacity (${role})`, async () => {
    await withWorkspaceRelocationFixture(role, async (store, path) => {
      for (const [index, slot] of Array.from("BCDEFGHIJKLMNOPQRSTUVWXYZ").entries()) {
        store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity(`/other/${index}`, 0, "other")!,
          target: { chatId: 7, threadId: 100 + index }, slot, updatedAtMs: 1 });
      }
      await store.persist();
      const binding = store.getWorkspaceBinding("/repo", "a", "session")!;
      const owner = store.list()[0]!;
      const otherBindings = store.listWorkspaceBindings().filter(value => value.bindingKey !== binding.bindingKey);
      const stale = new Proxy(binding, { get() { throw new Error("stale source read"); } });
      assert.equal(await relocate(store, "restore", stale, owner, { chatId: 7, threadId: 42 }, () => false), false);
      const target = { chatId: 7, threadId: 42 };
      const moving = relocate(store, "restore", binding, owner, target, () => true);
      target.threadId = 999;
      binding.journalBindingKeys!.push("caller-mutation");
      owner.target.threadId = 999;
      assert.equal(await moving, true);
      const cold = createTelegramTopicTargetStore({ path });
      await cold.load();
      const relocated = cold.getWorkspaceBinding("/repo", "a", "session")!;
      const { displayTitle: _oldTitle, ...expectedBinding } = binding;
      assert.deepEqual(relocated, { ...expectedBinding, journalBindingKeys: ["manual:old"],
        target: { chatId: 7, threadId: 42 }, updatedAtMs: 1000 });
      assert.deepEqual(store.listWorkspaceBindings(), cold.listWorkspaceBindings());
      assert.deepEqual(store.list(), cold.list());
      const [operation] = restorations(cold);
      assert.equal(operation?.request.operationId, "restore");
      assert.equal(operation?.request.binding.target.threadId, 10);
      assert.equal(operation?.request.owner.target.threadId, 10);
      assert.equal(operation?.request.target.threadId, 42);
      assert.equal(operation?.committedAtMs, 1000);
      assert.deepEqual(operation?.request.source, { journalBindingKey: "fixture-journal", updateIds: [100] });
      assert.deepEqual(operation?.request.binding.journalBindingKeys, ["manual:old"]);
      assert.deepEqual(cold.listWorkspaceBindings().filter(value => value.bindingKey !== binding.bindingKey), otherBindings);
      assert.equal(cold.list()[0]?.slot, "A");
      assert.equal(cold.list()[0]?.instanceId, "old");
      assert.equal(cold.list()[0]?.lastSyncError, undefined);
      assert.equal(cold.list()[0]?.lastSyncObservedAtMs, undefined);
      assert.equal(cold.list()[0]?.syncStatus, "unknown");
      assert.deepEqual(cold.listSyncObservations(), [], "moving is not proof that Telegram deleted either target");
      assert.equal(await relocate(cold, "restore", binding, owner, { chatId: 7, threadId: 42 }, () => true), false);
    });
  });
}

for (const race of ["none", "authority", "owner", "binding", "ownership", "publication", "ack", "guard-mutation", "external-fence", "claim"] as const) {
  test(`Workspace relocation publishes both records at the fenced commit (${race})`, async () => {
    let current = true;
    let owns = true;
    let slots: string[] = [];
    let atCommit: (() => void) | undefined;
    let inCommit = false;
    await withWorkspaceRelocationFixture("leader", async (store, path) => {
      const binding = store.listWorkspaceBindings()[0]!;
      const owner = store.list()[0]!;
      const originalDisk = await readFile(path, "utf8");
      atCommit = () => {
        assert.deepEqual(store.listWorkspaceBindings(), [binding]);
        assert.deepEqual(store.list(), [owner]);
        assert.deepEqual(restorations(store), [], "neither intent nor binding may precede the atomic commit");
        if (race === "authority") current = false;
        if (race === "owner") store.upsert({ ...owner, instanceId: "replacement",
          owner: { kind: "leader", cwd: "/repo", instanceId: "replacement" } });
        if (race === "binding") store.upsertWorkspaceBinding({ ...binding, manualThreadName: "Changed" });
        if (race === "ownership") owns = false;
        if (race === "external-fence") slots = ["A"];
        if (race === "claim") assert.ok(store.claimWorkspaceIdentity("/repo", "old", undefined, { sessionId: "session" }));
        if (race === "publication") throw new Error("publication failed");
      };
      const move = () => relocate(store, "restore", binding, owner, { chatId: 7, threadId: 42 }, () => {
        if (inCommit && race === "guard-mutation") store.upsertWorkspaceBinding({ ...binding, manualThreadName: "Changed" });
        return current;
      });
      if (race === "publication") await assert.rejects(move(), /publication/);
      else assert.equal(await move(), race === "none" || race === "ack");
      const committed = race === "none" || race === "ack";
      const disk = JSON.parse(await readFile(path, "utf8"));
      assert.equal(disk.threads[0].target.threadId, committed ? 42 : 10);
      assert.equal(disk.workspaceBindings[0].target.threadId, committed ? 42 : 10);
      assert.equal(store.list()[0]?.target.threadId, committed ? 42 : 10);
      assert.equal(store.listWorkspaceBindings()[0]?.target.threadId, committed ? 42 : 10);
      assert.equal(disk.workspaceRestore?.operations.length ?? 0, committed ? 1 : 0);
      assert.equal(restorations(store).length, committed ? 1 : 0);
      if (!committed) assert.equal(await readFile(path, "utf8"), originalDisk);
      atCommit = undefined;
      inCommit = false;
      if (race === "publication") assert.equal(await move(), true);
      if (committed) {
        const retained = await readFile(path, "utf8");
        assert.equal(await move(), true, "an exact retry acknowledges the retained commit");
        assert.equal(await readFile(path, "utf8"), retained, "the retry cannot move or publish again");
      }
    }, { getExternalReservedSlots: () => slots, canPersist: () => owns,
      commitPersist(commit) {
        atCommit?.();
        if (!owns) return false;
        inCommit = !!atCommit;
        commit();
        if (atCommit && race === "ack") throw new Error("publication acknowledgement lost");
        return true;
      } });
  });
}

for (const conflict of ["legacy", "inactive", "binding-drift", "owner-drift", "destination-binding", "destination-owner", "slot-conflict", "claim", "reservation", "provision", "untargeted-provision", "cleanup", "session-replacement", "closed", "same-target", "foreign-chat", "fractional-target", "missing-snapshot", "corrupt-snapshot"] as const) {
  test(`Workspace relocation refuses conflicting or unverifiable state (${conflict})`, async () => {
    await withWorkspaceRelocationFixture("leader", async (store, path) => {
      let binding = store.listWorkspaceBindings()[0]!;
      const owner = store.list()[0]!;
      const target = { chatId: 7, threadId: 42 };
      if (conflict === "legacy") {
        store.upsertWorkspaceBinding({ ...binding, ...createTelegramWorkspaceBindingIdentity("/repo")!,
          sessionId: undefined, sessionKey: undefined });
        binding = store.listWorkspaceBindings()[0]!;
      }
      if (conflict === "inactive") {
        store.upsertWorkspaceBinding({ ...binding, inactiveSinceMs: 10 });
        binding = store.listWorkspaceBindings()[0]!;
      }
      if (conflict === "binding-drift") store.upsertWorkspaceBinding({ ...binding, manualThreadName: "Changed" });
      if (conflict === "owner-drift") store.upsert({ ...owner, updatedAtMs: 2 });
      if (conflict === "destination-binding") store.upsertWorkspaceBinding({
        ...createTelegramWorkspaceBindingIdentity("/other", 0, "other")!, target, slot: "B", updatedAtMs: 1 });
      if (conflict === "destination-owner" || conflict === "slot-conflict") store.upsert({
        ...owner, profileKey: "manual:other", owner: { kind: "manual-follower", instanceId: "other" },
        instanceId: "other", target: conflict === "slot-conflict" ? { chatId: 7, threadId: 77 } : target,
        slot: conflict === "slot-conflict" ? "A" : "B" });
      if (conflict === "claim") assert.ok(store.claimWorkspaceIdentity("/repo", "old", undefined, { sessionId: "session" }));
      if (conflict === "reservation") store.reserveThread({ target, slot: "B", reason: "reserved", createdAtMs: 1, updatedAtMs: 1 });
      if (conflict === "provision") store.upsertPendingProvision({ id: "pending", target, slot: "B", owner: "leader", instanceId: "other", startedAtMs: 1 });
      if (conflict === "untargeted-provision") store.upsertPendingProvision({ id: "unknown", status: "ambiguous", owner: "leader", instanceId: "old", startedAtMs: 1 });
      if (conflict === "cleanup") store.upsertPendingCleanup({ id: "cleanup", owner: "leader", instanceId: "old", runtimeGeneration: "generation", target, requestedAtMs: 1 });
      if (conflict === "session-replacement") assert.equal(await store.commitSessionReplacementIntent({
        continuity: "classic-chat", cwd: "/repo", profileName: "default", sourceSessionId: "session",
        sourceUpdateId: 1, target: { chatId: 7 }, messageId: 11, createdAtMs: 1, expiresAtMs: 2000,
      }, () => true), true);
      if (conflict === "closed") {
        store.upsert({ ...owner, profileKey: "manual:temporary", owner: { kind: "manual-follower", instanceId: "temporary" },
          instanceId: "temporary", target, slot: "B" });
        store.markStaleByTarget(target, "closed");
      }
      if (conflict === "same-target") target.threadId = 10;
      if (conflict === "foreign-chat") target.chatId = 8;
      if (conflict === "fractional-target") target.threadId = 42.5;
      await store.persist();
      if (conflict === "missing-snapshot") await rm(path);
      if (conflict === "corrupt-snapshot") await writeFile(path, "invalid-json");
      const before = await readFile(path, "utf8").catch(() => undefined);
      if (conflict === "corrupt-snapshot") {
        await assert.rejects(relocate(store, "restore", binding, owner, target, () => true), SyntaxError);
      } else {
        assert.equal(await relocate(store, "restore", binding, owner, target, () => true), false);
      }
      assert.equal(await readFile(path, "utf8").catch(() => undefined), before);
    });
  });
}

test("Atomic Restore records are detached and retire only through exact terminal CAS", async () => {
  await withWorkspaceRelocationFixture("leader", async (store, path) => {
    const binding = store.listWorkspaceBindings()[0]!;
    const owner = store.list()[0]!;
    assert.equal(await relocate(store, "restore", binding, owner, { chatId: 7, threadId: 42 }, () => true), true);
    const cold = createTelegramTopicTargetStore({ path });
    await cold.load();
    assert.equal(removeStoredRestore(cold, restorations(cold)[0]!, () => true), false, "raw removal is not an exposed operation");
    const receipt = structuredClone(settleStoredRestore(cold));
    const detached = restorations(cold)[0]!;
    detached.request.binding.journalBindingKeys!.push("forged");
    detached.request.owner.target.threadId = 99;
    assert.deepEqual(restorations(cold), [receipt]);
    const stale = new Proxy(receipt, { get() { throw new Error("stale receipt read"); } });
    assert.equal(removeStoredRestore(cold, stale, () => false), false);
    for (const forged of [detached, { ...receipt, request: { ...receipt.request, operationId: "other" } },
      { ...receipt, committedAtMs: receipt.committedAtMs + 1 }]) {
      assert.equal(removeStoredRestore(cold, forged, () => true), false);
    }
    const nextBinding = cold.listWorkspaceBindings()[0]!;
    const nextOwner = cold.list()[0]!;
    assert.equal(await relocate(cold, "next", nextBinding, nextOwner, { chatId: 7, threadId: 43 }, () => true), false);
    // Ordinary publication may refresh derived identity timestamps, but must retain the full operation.
    await cold.persist();
    assert.deepEqual(restorations(cold), [receipt]);
    const before = JSON.parse(await readFile(path, "utf8"));
    assert.equal(removeStoredRestore(cold, receipt, () => true), true);
    const after = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(after, { ...before, workspaceRestore: { ...before.workspaceRestore, operations: [],
      revision: before.workspaceRestore.revision + 1 } });
    assert.deepEqual(cold.list(), [nextOwner]);
    assert.deepEqual(cold.listWorkspaceBindings(), [nextBinding]);
    assert.equal(removeStoredRestore(cold, receipt, () => true), false);
    assert.equal(await relocate(cold, "next", nextBinding, nextOwner, { chatId: 7, threadId: 43 }, () => true), true);
    assert.equal(removeStoredRestore(cold, receipt, () => true), false, "old CAS cannot clear the next operation");
    assert.equal(restorations(cold)[0]?.request.operationId, "next");
  });
});

for (const fault of ["none", "authority", "ownership", "publication", "ack", "changed-operation"] as const) {
  test(`Workspace Restore retirement CAS is fenced (${fault})`, async () => {
    let atCommit: (() => void) | undefined;
    let current = true, owns = true;
    await withWorkspaceRelocationFixture("leader", async (store, path) => {
      assert.equal(await relocate(store, "restore", store.listWorkspaceBindings()[0]!, store.list()[0]!, { chatId: 7, threadId: 42 }, () => true), true);
      const operation = settleStoredRestore(store);
      const before = JSON.parse(await readFile(path, "utf8"));
      atCommit = () => {
        assert.deepEqual(restorations(store), [operation]);
        if (fault === "authority") current = false;
        if (fault === "ownership") owns = false;
        if (fault === "publication") throw new Error("publication failed");
        if (fault === "changed-operation") {
          const changed = structuredClone(before);
          changed.workspaceRestore.operations[0].request.operationId = "another-operation";
          writeFileSync(path, JSON.stringify(changed));
        }
      };
      const remove = () => removeStoredRestore(store, operation, () => current);
      if (["publication", "ack", "changed-operation"].includes(fault)) assert.throws(remove, /publication|evidence/);
      else assert.equal(remove(), fault === "none");
      const disk = JSON.parse(await readFile(path, "utf8"));
      assert.equal(disk.workspaceRestore.operations.length, ["none", "ack"].includes(fault) ? 0 : 1);
      assert.deepEqual(disk.workspaceBindings, before.workspaceBindings);
      assert.deepEqual(disk.threads, before.threads);
      const cold = createTelegramTopicTargetStore({ path });
      await cold.load();
      assert.deepEqual(restorations(cold), disk.workspaceRestore.operations);
    }, { commitPersist(commit) {
      atCommit?.();
      if (!owns) return false;
      commit();
      if (atCommit && fault === "ack") throw new Error("publication acknowledgement lost");
      return true;
    } });
  });
}

for (const fault of ["malformed", "duplicate", "slot-mismatch", "unknown-field", "unknown-version", "invalid-revision", "missing-revision", "invalid-json", "missing", "removed"] as const) {
  test(`Workspace relocation evidence cannot be silently overwritten (${fault})`, async () => {
    await withWorkspaceRelocationFixture("leader", async (store, path) => {
      assert.equal(await relocate(store, "restore", store.listWorkspaceBindings()[0]!,
        store.list()[0]!, { chatId: 7, threadId: 42 }, () => true), true);
      const file = JSON.parse(await readFile(path, "utf8"));
      if (fault === "malformed") file.workspaceRestore.operations = {};
      if (fault === "duplicate") file.workspaceRestore.operations.push(file.workspaceRestore.operations[0]);
      if (fault === "slot-mismatch") file.workspaceRestore.operations[0].request.owner.slot = "B";
      if (fault === "unknown-field") file.workspaceRestore.operations[0].futureAuthority = true;
      if (fault === "unknown-version") file.version = 2;
      if (fault === "invalid-revision") file.workspaceRestore.revision = -1;
      if (fault === "missing-revision") delete file.workspaceRestore.revision;
      if (fault === "removed") delete file.workspaceRestore;
      if (fault === "missing") await rm(path);
      else await writeFile(path, fault === "invalid-json" ? "invalid-json" : JSON.stringify(file));
      const bytes = await readFile(path, "utf8").catch(() => undefined);
      store.upsert({ ...store.list()[0]!, updatedAtMs: 2000 });
      await assert.rejects(store.persist());
      assert.equal(await readFile(path, "utf8").catch(() => undefined), bytes);
      if (fault !== "missing" && fault !== "removed") {
        const cold = createTelegramTopicTargetStore({ path });
        await assert.rejects(cold.load());
      }
    });
  });
}

for (const observed of [false, true]) {
  test(`Stale snapshot writers cannot erase atomic Restore even after reading its view (${observed})`, async () => {
    await withWorkspaceRelocationFixture("leader", async (publisher, path) => {
      const stale = createTelegramTopicTargetStore({ path });
      await stale.load();
      stale.upsert({ ...stale.list()[0]!, updatedAtMs: 2000 });
      assert.equal(await relocate(publisher, "restore", publisher.listWorkspaceBindings()[0]!, publisher.list()[0]!, { chatId: 7, threadId: 42 }, () => true), true);
      if (observed) assert.equal(restorations(stale).length, 1, "observation cannot bless the stale canonical projection");
      const before = await readFile(path, "utf8");
      await assert.rejects(stale.persist(), /Restore evidence changed/);
      assert.equal(await readFile(path, "utf8"), before);
    });
  });
}

test("Removing the final Restore record cannot reopen the empty-operation ABA window", async () => {
  await withWorkspaceRelocationFixture("leader", async (publisher, path) => {
    const stale = createTelegramTopicTargetStore({ path });
    await stale.load();
    stale.upsert({ ...stale.list()[0]!, updatedAtMs: 2000 });
    assert.equal(await relocate(publisher, "restore", publisher.listWorkspaceBindings()[0]!,
      publisher.list()[0]!, { chatId: 7, threadId: 42 }, () => true), true);
    assert.equal(removeStoredRestore(publisher, settleStoredRestore(publisher), () => true), true);
    assert.deepEqual(restorations(publisher), []);
    const before = await readFile(path, "utf8");
    assert.equal(JSON.parse(before).workspaceRestore.revision, 7);
    await assert.rejects(stale.persist(), /Restore evidence changed/);
    assert.equal(await readFile(path, "utf8"), before);
  });
});

for (const fault of ["missing", "rollback", "same-revision"] as const) {
  test(`Warm relocation evidence cannot be forgotten by reload or ordinary publication (${fault})`, async () => {
    await withWorkspaceRelocationFixture("leader", async (store, path) => {
      const original = await readFile(path, "utf8");
      assert.equal(await relocate(store, "restore", store.listWorkspaceBindings()[0]!,
        store.list()[0]!, { chatId: 7, threadId: 42 }, () => true), true);
      if (fault === "missing") await rm(path);
      if (fault === "rollback") await writeFile(path, original);
      if (fault === "same-revision") {
        const file = JSON.parse(await readFile(path, "utf8"));
        file.workspaceRestore.operations = [];
        await writeFile(path, JSON.stringify(file));
      }
      const before = await readFile(path, "utf8").catch(() => undefined);
      await assert.rejects(store.load(), /Restore evidence/);
      await assert.rejects(store.refresh!(), /Restore evidence/);
      await assert.rejects(store.persist(), /Restore evidence/);
      assert.throws(() => restorations(store), /Restore evidence/);
      assert.equal(await readFile(path, "utf8").catch(() => undefined), before);
    });
  });
}

test("Restore revision exhaustion retains the exact operation without wrapping", async () => {
  await withWorkspaceRelocationFixture("leader", async (store, path) => {
    assert.equal(await relocate(store, "restore", store.listWorkspaceBindings()[0]!,
      store.list()[0]!, { chatId: 7, threadId: 42 }, () => true), true);
    settleStoredRestore(store);
    const file = JSON.parse(await readFile(path, "utf8"));
    file.workspaceRestore.revision = Number.MAX_SAFE_INTEGER;
    await writeFile(path, JSON.stringify(file));
    const cold = createTelegramTopicTargetStore({ path });
    await cold.load();
    const before = await readFile(path, "utf8");
    assert.throws(() => removeStoredRestore(cold, restorations(cold)[0]!, () => true), /revision exhausted/);
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal(restorations(cold).length, 1);
  });
});

for (const collision of ["id", "destination", "source"] as const) {
  test(`Pending atomic Restore rejects conflicting relocation requests (${collision})`, async () => {
    await withWorkspaceRelocationFixture("leader", async (store, path) => {
      assert.equal(await relocate(store, "restore", store.listWorkspaceBindings()[0]!,
        store.list()[0]!, { chatId: 7, threadId: 42 }, () => true), true);
      const before = await readFile(path, "utf8");
      const source = { chatId: 7, threadId: collision === "source" ? 10 : 99 };
      store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/other", 0, "other")!,
        target: source, slot: "B", updatedAtMs: 1 });
      store.upsert({ profileKey: "manual:other", owner: { kind: "manual-follower", instanceId: "other" },
        instanceId: "other", target: source, slot: "B", status: "active", createdAtMs: 1, updatedAtMs: 1 });
      if (collision === "source") {
        await assert.rejects(() => store.persist(), /Protected Workspace Restore/);
        assert.equal(await readFile(path, "utf8"), before);
        return;
      }
      await store.persist();
      assert.equal(await relocate(store, collision === "id" ? "restore" : "other-operation",
        store.getWorkspaceBinding("/other", "a", "other")!, store.getByProfileKey("manual:other")!,
        { chatId: 7, threadId: collision === "destination" ? 10 : 43 }, () => true), false);
      assert.equal(restorations(store).length, 1);
    });
  });
}

for (const mutation of ["binding-target", "owner-target", "slot-reuse", "old-target-reuse", "new-target-reuse"] as const) {
  test(`Snapshot publication protects retained Restore identity (${mutation})`, async () => {
    await fixture(async ({ store, threads, request, auth, path }) => {
      await store.commit(request, auth);
      const before = await readFile(path, "utf8");
      const binding = threads.listWorkspaceBindings()[0]!;
      const owner = threads.list()[0]!;
      if (mutation === "binding-target") threads.upsertWorkspaceBinding({ ...binding, target: request.binding.target });
      else if (mutation === "owner-target") threads.upsert({ ...owner, target: request.binding.target });
      else if (mutation === "slot-reuse") threads.upsert({ ...owner, profileKey: "manual:other",
        owner: { kind: "manual-follower", instanceId: "other" }, instanceId: "other", target: { chatId: 7, threadId: 99 } });
      else threads.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/other", 0, "other")!,
        target: mutation === "old-target-reuse" ? request.binding.target : request.target, slot: "B", updatedAtMs: 1000 });
      await assert.rejects(() => threads.persist(), /Protected Workspace Restore/);
      assert.equal(await readFile(path, "utf8"), before, "refused publication leaves the canonical bytes intact");
      const cold = createTelegramTopicTargetStore({ path }); await cold.load();
      assert.deepEqual(cold.listWorkspaceBindings()[0], binding);
      assert.deepEqual(store.list()[0]?.request, request);
    });
  });
}

test("Exact session-address metadata CAS preserves retained Restore snapshot references", async () => {
  await fixture(async ({ store, threads, request, auth, path }) => {
    const oldSource = { sessionId: "session-a", recipientBindingKey: "manual:same" };
    const newSource = { sessionId: "session-b", recipientBindingKey: "manual:same" };
    request.binding = threads.upsertWorkspaceBinding({ ...request.binding, journalSources: [oldSource, newSource] })!;
    const intent = (await store.commit(request, auth))!;
    const current = threads.listWorkspaceBindings()[0]!;
    assert.ok(threads.commitWorkspaceJournalEvidence(current, [], true, [newSource]));
    await threads.persist();
    const cold = createTelegramTopicTargetStore({ path }); await cold.load();
    assert.deepEqual(cold.listWorkspaceBindings()[0]!.journalSources, [newSource]);
    assert.deepEqual(restorations(cold)[0]!.request.binding.journalSources, [oldSource, newSource]);
    assert.deepEqual(store.list()[0], intent, "Metadata CAS cannot erase a separate consumer's retained snapshot");
    assert.equal(threads.commitWorkspaceJournalEvidence(current, [], true, []), undefined, "Stale snapshots refuse removal");
    const observed = threads.listWorkspaceBindings()[0]!;
    const keys = ["manual:same"];
    const foreign = { sessionId: "session-c", recipientBindingKey: "manual:same" };
    for (const sources of [[foreign], [{ ...newSource, unknown: true }], [{ ...newSource, sessionId: "" }], Array(257).fill(newSource)])
      assert.equal(threads.commitWorkspaceJournalEvidence(observed, keys, false, sources), undefined);
    assert.deepEqual(threads.listWorkspaceBindings()[0], observed, "Refused metadata does not apply legacy keys/completeness either");
    const retained = [{ ...newSource }];
    const unchanged = threads.commitWorkspaceJournalEvidence(observed, [], true, retained)!;
    retained[0]!.sessionId = "caller-forgery";
    unchanged.journalSources![0]!.sessionId = "returned-forgery";
    assert.deepEqual(threads.listWorkspaceBindings()[0], observed);
  });
});

test("Restore publication permits metadata, same-session successor and non-destructive detachment", async () => {
  await fixture(async ({ store, threads, request, auth, path }) => {
    const committed = (await store.commit(request, auth))!;
    const issued = store.issueRecipient(committed, recipient("leader"), auth)!.intent;
    const ready = store.confirmReady(issued, recipient("leader"), auth)!;
    threads.renameByTarget(request.target, "Delta", { updateDisplayTitle: true });
    threads.commitWorkspaceJournalEvidence(threads.listWorkspaceBindings()[0]!, ["manual:old", "manual:successor"], true);
    threads.upsert({ ...threads.list()[0]!, instanceId: "successor", owner: { kind: "leader", cwd: "/repo", instanceId: "successor" } });
    await threads.persist();
    auth.executor = { instanceId: "successor", leaderEpoch: "next" };
    const adopted = store.adopt(ready, auth)!;
    const observed = { ...recipient("leader"), instanceId: "successor", generation: "next" };
    assert.deepEqual(store.confirmInspectedReady(adopted, observed, auth)?.readyRecipient, observed);
    assert.equal(await threads.detachTargetOwner(threads.list()[0]!, () => true), true);
    const cold = createTelegramTopicTargetStore({ path }); await cold.load();
    assert.deepEqual(cold.listWorkspaceBindings()[0]?.target, request.target);
    assert.equal(cold.listWorkspaceBindings()[0]?.slot, "A");
    assert.equal(cold.listWorkspaceBindings()[0]?.threadName, "Atlas");
    assert.equal(cold.listWorkspaceBindings()[0]?.manualThreadName, "Delta");
    assert.deepEqual(cold.listWorkspaceBindings()[0]?.journalBindingKeys, ["manual:old", "manual:successor"]);
    assert.ok(cold.listWorkspaceBindings()[0]?.inactiveSinceMs);
    assert.deepEqual(cold.list(), []);
    assert.deepEqual(store.list()[0]?.recipient, recipient("leader"), "successor readiness does not rewrite issuance");
  });
});

for (const terminal of [false, true]) test(`Restore transitions cannot publish over regressed canonical state (${terminal})`, async () => {
  await fixture(async ({ store, threads, request, auth, path }) => {
    const committed = (await store.commit(request, auth))!;
    const expected = terminal ? settleStoredRestore(threads) : committed;
    const file = JSON.parse(await readFile(path, "utf8"));
    file.workspaceBindings[0].target = request.binding.target;
    const corrupted = JSON.stringify(file);
    await writeFile(path, corrupted);
    assert.throws(() => terminal ? store.retire(expected, auth) : store.issueRecipient(expected, recipient("leader"), auth),
      /Protected Workspace Restore binding/);
    assert.equal(await readFile(path, "utf8"), corrupted);
    threads.renameByTarget(request.target, "Updated name", { updateDisplayTitle: true });
    await assert.rejects(() => threads.persist(), /Protected Workspace Restore binding/);
    assert.equal(await readFile(path, "utf8"), corrupted, "a valid warm projection cannot silently repair corrupt canonical state");
    assert.deepEqual(store.list(), [expected], "evidence remains readable for source protection; no repair or retirement");
  });
});

for (const mutation of ["missing", "target"] as const) test(`Registration publication rechecks ordinary Workspace bindings (${mutation})`, async () => {
  await fixture(async ({ threads, request, path }) => {
    const candidate = { target: request.binding.target, bindingKey: request.binding.bindingKey, slot: request.binding.slot };
    let publications = 0;
    threads.commitWorkspaceRestoreRegistration(candidate, () => { publications += 1; });
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    if (mutation === "missing") snapshot.workspaceBindings = [];
    else snapshot.workspaceBindings[0].target = request.target;
    const changed = JSON.stringify(snapshot);
    await writeFile(path, changed);
    assert.throws(() => threads.commitWorkspaceRestoreRegistration(candidate, () => { publications += 1; }), /Workspace registration binding changed/);
    assert.equal(publications, 1);
    assert.equal(await readFile(path, "utf8"), changed);
  });
});

test("Live registration publication holds the canonical transaction through the synchronous effect", async () => {
  await fixture(async ({ store, threads, request, auth, path }) => {
    let publications = 0;
    const publish = () => {
      assert.throws(() => withTelegramFileTransaction(`${path}.transaction`, () => assert.fail("competing publication entered"),
        { attempts: 1, retryDelayMs: 0 }), /Timed out acquiring Telegram lock transaction/);
      publications += 1;
    };
    threads.commitWorkspaceRestoreRegistration({ target: request.binding.target }, publish);
    await store.commit(request, auth);
    const candidate = { target: request.target, bindingKey: request.binding.bindingKey, slot: request.binding.slot };
    threads.commitWorkspaceRestoreRegistration(candidate, publish);
    assert.equal(publications, 2);
    assert.throws(() => threads.commitWorkspaceRestoreRegistration({ ...candidate, target: request.binding.target }, publish), /Protected Workspace Restore registration/);
    assert.equal(publications, 2);
    assert.throws(() => threads.commitWorkspaceRestoreRegistration(candidate, () => { throw new Error("publication stopped"); }), /publication stopped/);
    withTelegramFileTransaction(`${path}.transaction`, () => {}, { attempts: 1, retryDelayMs: 0 });
  });
});

for (const conflict of ["binding", "slot", "old-target", "new-target", "legacy-profile", "legacy-instance", "none"] as const) {
  test(`Restore blocks conflicting provisioning before staging (${conflict})`, async () => {
    await fixture(async ({ store, threads, request, auth, path }) => {
      await store.commit(request, auth);
      const before = await readFile(path, "utf8");
      const provision = { id: "other-provision", owner: "manual-follower" as const,
        instanceId: conflict === "legacy-instance" || conflict === "none" ? request.owner.instanceId! : "other",
        profileKey: conflict === "legacy-profile" || conflict === "none" ? request.owner.profileKey : "manual:other", startedAtMs: 1000,
        workspaceBindingKey: conflict.startsWith("legacy-") ? undefined : conflict === "binding" ? request.binding.bindingKey : "other-binding",
        slot: conflict === "slot" ? "A" : "B",
        target: conflict === "old-target" ? request.binding.target : conflict === "new-target" ? request.target : { chatId: 7, threadId: 99 } };
      if (conflict === "none") {
        threads.upsertPendingProvision(provision); await threads.persist();
        assert.equal(threads.listPendingProvisions().length, 1);
        assert.deepEqual(store.list()[0]?.request, request);
      } else {
        assert.throws(() => threads.upsertPendingProvision(provision), /Protected Workspace Restore provisioning/);
        assert.deepEqual(threads.listPendingProvisions(), [], "refusal leaves no phantom in-flight creation");
        if (conflict === "slot" || conflict === "old-target" || conflict === "new-target") {
          assert.throws(() => threads.reserveThread({ target: provision.target, slot: provision.slot,
            reason: "new-instance", createdAtMs: 1000, updatedAtMs: 1000 }), /Protected Workspace Restore provisioning/);
          assert.deepEqual(threads.listReservations(), []);
        }
        assert.equal(await readFile(path, "utf8"), before);
      }
    });
  });
}

for (const kind of ["provision", "reservation"] as const) test(`Late conflicting ${kind} blocks Restore grants and warm publication`, async () => {
  await fixture(async ({ store, threads, request, auth, path }) => {
    const committed = (await store.commit(request, auth))!;
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    if (kind === "provision") snapshot.pendingProvisions = [{ id: "late-creation", owner: "manual-follower", instanceId: "other",
      profileKey: "manual:other", slot: "B", startedAtMs: 1000, status: "ambiguous", target: request.target }];
    else snapshot.reservations = [{ slot: "B", target: request.target, reason: "new-instance", createdAtMs: 1000, updatedAtMs: 1000 }];
    const conflicting = JSON.stringify(snapshot);
    await writeFile(path, conflicting);
    assert.throws(() => store.issueRecipient(committed, recipient("leader"), auth), /Protected Workspace Restore provisioning/);
    assert.equal(await readFile(path, "utf8"), conflicting);
    assert.deepEqual(store.list(), [committed]);
    threads.renameByTarget(request.target, "Delta");
    await assert.rejects(threads.persist(), /Protected Workspace Restore provisioning/);
    assert.equal(await readFile(path, "utf8"), conflicting, "warm cache cannot erase conflicting evidence");
  });
});

for (const role of ["leader", "follower"] as const) {
  for (const evidence of ["missing", "foreign-instance", "foreign-profile", "foreign-epoch", "recovered", "canonical", "contradiction", "expired", "expired-recovered"] as const) {
    test(`Restore requires known creation targets before relocation (${role}, ${evidence})`, async () => {
      let now = 1000;
      await fixture(async ({ store, threads, request, auth, path }) => {
        const pending = { id: "unfinished", owner: "manual-follower" as const, instanceId: "creator", profileKey: "manual:creator",
          leaderEpoch: "original", workspaceBindingKey: "other-binding", slot: "B", startedAtMs: 1000,
          ...(evidence.startsWith("expired") ? { expiresAtMs: 1500 } : {}),
          ...(evidence === "canonical" || evidence === "contradiction" ? { target: { chatId: 7, threadId: 98 } } : {}) };
        threads.upsertPendingProvision(pending); await threads.persist();
        if (evidence !== "missing" && evidence !== "expired" && evidence !== "canonical") {
          await threads.recordPendingProvisionTargetRecovery({ ...pending,
            instanceId: evidence === "foreign-instance" ? "foreign" : pending.instanceId,
            profileKey: evidence === "foreign-profile" ? "manual:foreign" : pending.profileKey,
            leaderEpoch: evidence === "foreign-epoch" ? "foreign" : pending.leaderEpoch }, { chatId: 7, threadId: 99 });
        }
        const before = await readFile(path, "utf8");
        if (evidence.startsWith("expired")) now = 2000;
        if (evidence === "recovered" || evidence === "canonical" || evidence === "expired-recovered") {
          assert.ok(await store.commit(request, auth));
          assert.deepEqual(threads.listWorkspaceBindings()[0]?.target, request.target);
          assert.equal(threads.listWorkspaceBindings()[0]?.slot, "A");
          assert.deepEqual(threads.listPendingProvisions()[0]?.target, { chatId: 7, threadId: evidence === "canonical" ? 98 : 99 });
        } else {
          await assert.rejects(store.commit(request, auth), evidence === "contradiction"
            ? /Conflicting Workspace provisioning target evidence/ : /target availability is unknown/);
          assert.equal(await readFile(path, "utf8"), before, "neither relocation nor expiry erases unresolved creation");
          assert.deepEqual(threads.listWorkspaceBindings()[0]?.target, request.binding.target);
          assert.equal(threads.listWorkspaceBindings()[0]?.slot, "A");
          assert.deepEqual(store.list(), []);
        }
      }, role, {}, { getNowMs: () => now });
    });
  }
}

for (const targetKind of ["old", "new", "other"] as const) for (const cold of [false, true]) {
  test(`Late recovery file fences Restore grants and publication (${targetKind}, reload: ${cold})`, async () => {
    await fixture(async ({ store, threads, request, auth, path }) => {
      const committed = (await store.commit(request, auth))!;
      const pending = { id: "late", owner: "manual-follower" as const, instanceId: "creator", profileKey: "manual:creator",
        workspaceBindingKey: "other-binding", slot: "B", startedAtMs: 1000, leaderEpoch: "original" };
      threads.upsertPendingProvision(pending); await threads.persist();
      const before = await readFile(path, "utf8");
      const target = targetKind === "old" ? request.binding.target : targetKind === "new" ? request.target : { chatId: 7, threadId: 99 };
      await threads.recordPendingProvisionTargetRecovery(pending, target);
      const recoveryPath = `${path}.provision-recovery.json`;
      const recovery = await readFile(recoveryPath, "utf8");
      if (cold) {
        if (targetKind === "other") await threads.load();
        else await assert.rejects(threads.load(), /Protected Workspace Restore provisioning/);
      }
      if (targetKind === "other") {
        assert.ok(store.issueRecipient(committed, recipient("leader"), auth));
        threads.renameByTarget(request.target, "Delta"); await threads.persist();
        assert.equal(store.list()[0]?.phase, "recipient-issued");
      } else {
        assert.throws(() => store.issueRecipient(committed, recipient("leader"), auth), /Protected Workspace Restore provisioning/);
        threads.renameByTarget(request.target, "Delta");
        await assert.rejects(threads.persist(), /Protected Workspace Restore provisioning/);
        assert.equal(await readFile(path, "utf8"), before);
        assert.deepEqual(store.list(), [committed]);
      }
      assert.equal(await readFile(recoveryPath, "utf8"), recovery);
    });
  });
}

for (const evidence of ["old", "new", "contradictory", "invalid", "foreign", "valid"] as const) for (const cold of [false, true]) {
  test(`Restore recovery consumption validates before replacing the projection (${evidence}, cold: ${cold})`, async () => {
    await fixture(async ({ store, threads, request, auth, path, open }) => {
      const committed = (await store.commit(request, auth))!;
      const pending = { id: "consume", owner: "manual-follower" as const, instanceId: "creator", profileKey: "manual:creator",
        workspaceBindingKey: "other-binding", slot: "B", startedAtMs: 1000,
        ...(evidence === "contradictory" ? { target: { chatId: 7, threadId: 99 } } : {}) };
      threads.upsertPendingProvision(pending); await threads.persist();
      const reader = cold ? createTelegramTopicTargetStore({ path, getNowMs: () => 1000 }) : threads;
      const before = { bindings: reader.listWorkspaceBindings(), records: reader.list(), pending: reader.listPendingProvisions() };
      const snapshot = JSON.parse(await readFile(path, "utf8"));
      snapshot.workspaceBindings[0].manualThreadName = "Disk-only metadata";
      const canonical = JSON.stringify(snapshot);
      await writeFile(path, canonical);
      const target = evidence === "old" || evidence === "foreign" ? request.binding.target
        : evidence === "new" ? request.target : { chatId: 7, threadId: evidence === "invalid" ? "invalid" : 98 };
      const recovery = JSON.stringify({ consume: { instanceId: pending.instanceId,
        profileKey: evidence === "foreign" ? "foreign" : pending.profileKey, target } });
      await writeFile(`${path}.provision-recovery.json`, recovery, { mode: 0o600 });
      if (evidence === "valid" || evidence === "foreign") {
        await reader.load();
        assert.deepEqual(reader.listPendingProvisions()[0]?.target, evidence === "valid" ? target : undefined);
        assert.equal(reader.listWorkspaceBindings()[0]?.manualThreadName, "Disk-only metadata");
      } else {
        await assert.rejects(reader.load(), /provisioning recovery conflict|Conflicting Workspace provisioning target evidence|Invalid Workspace provisioning recovery evidence/);
        assert.deepEqual({ bindings: reader.listWorkspaceBindings(), records: reader.list(), pending: reader.listPendingProvisions() }, before);
      }
      assert.deepEqual(open({ threadStore: reader }).list(), [committed], "failed loading does not hide retained source protection");
      assert.equal(await readFile(path, "utf8"), canonical);
      assert.equal(await readFile(`${path}.provision-recovery.json`, "utf8"), recovery);
    });
  });
}

for (const phase of ["relocate", "grant"] as const) {
  test(`Recovery evidence arriving at publication cannot be missed (${phase})`, async () => {
    let publish: (() => void) | undefined;
    await fixture(async ({ store, threads, request, auth, path }) => {
      const committed = phase === "grant" ? (await store.commit(request, auth))! : undefined;
      const pending = { id: "late", owner: "manual-follower" as const, instanceId: "creator", profileKey: "manual:creator",
        workspaceBindingKey: "other-binding", slot: "B", startedAtMs: 1000 };
      threads.upsertPendingProvision(pending); await threads.persist();
      const before = await readFile(path, "utf8");
      publish = () => writeFileSync(`${path}.provision-recovery.json`, JSON.stringify({ late: {
        instanceId: pending.instanceId, profileKey: pending.profileKey, target: request.target } }), { mode: 0o600 });
      if (committed) assert.throws(() => store.issueRecipient(committed, recipient("leader"), auth), /provisioning recovery conflict/);
      else await assert.rejects(store.commit(request, auth), /provisioning recovery conflict/);
      assert.equal(await readFile(path, "utf8"), before);
      assert.deepEqual(store.list(), committed ? [committed] : []);
    }, "leader", { onPublicationBoundary(at) { if (at === "after-write-before-rename") publish?.(); } });
  });
}

for (const corrupt of ["{broken", "[]"] as const) test(`Unreadable recovery evidence is not empty or repairable (${corrupt})`, async () => {
  await fixture(async ({ store, threads, request, auth, path }) => {
    const committed = (await store.commit(request, auth))!;
    const pending = { id: "late", owner: "manual-follower" as const, instanceId: "creator", profileKey: "manual:creator",
      workspaceBindingKey: "other-binding", slot: "B", startedAtMs: 1000 };
    threads.upsertPendingProvision(pending); await threads.persist();
    const before = await readFile(path, "utf8");
    const recoveryPath = `${path}.provision-recovery.json`;
    await writeFile(recoveryPath, corrupt, { mode: 0o600 });
    assert.throws(() => store.issueRecipient(committed, recipient("leader"), auth));
    await assert.rejects(threads.recordPendingProvisionTargetRecovery(pending, request.target));
    await assert.rejects(threads.load());
    assert.equal(await readFile(recoveryPath, "utf8"), corrupt);
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual(store.list(), [committed]);
  });
});

test("Known recovery receipts are immutable and exact duplicates are read-only", async () => {
  await fixture(async ({ threads, request, path }) => {
    const pending = { id: "late", owner: "manual-follower" as const, instanceId: "creator", slot: "B", startedAtMs: 1000 };
    await threads.recordPendingProvisionTargetRecovery(pending, request.target);
    const recoveryPath = `${path}.provision-recovery.json`;
    const before = await readFile(recoveryPath, "utf8");
    const identity = await stat(recoveryPath);
    await threads.recordPendingProvisionTargetRecovery(pending, request.target);
    assert.equal((await stat(recoveryPath)).ino, identity.ino);
    await assert.rejects(threads.recordPendingProvisionTargetRecovery(pending, { chatId: 7, threadId: 99 }), /Conflicting Workspace provisioning recovery/);
    assert.equal(await readFile(recoveryPath, "utf8"), before);
  });
});

for (const role of ["leader", "follower"] as const) for (const mode of ["reuse", "create", "legacy-create"] as const) {
  test(`Native provisioner preserves unfinished Restore without another topic (${role}, ${mode})`, async () => {
    await fixture(async ({ store, threads, request, auth, path }) => {
      await store.commit(request, auth);
      if (mode !== "reuse") {
        threads.markOfflineByInstanceId(request.owner.instanceId!);
        await threads.persist();
      }
      const before = await readFile(path, "utf8");
      const calls: string[] = [];
      const provision = createTelegramTopicTargetProvisioner({ store: threads, topicChatId: 7,
        claimPendingTargets: false, getNowMs: () => 1000,
        async callApi<TResponse>(method: string) { calls.push(method); return { message_thread_id: 999 } as TResponse; } });
      if (mode !== "legacy-create") assert.ok(threads.claimWorkspaceIdentity(request.binding.cwd, "successor", request.owner.instanceId,
        { sessionId: request.binding.sessionId, existingBindingOnly: true }));
      const action = () => provision({ instanceId: "successor", owner: request.owner.owner,
        profileKey: request.owner.profileKey, preferredSlot: mode === "legacy-create" ? undefined : "A",
        workspaceBindingKey: mode === "legacy-create" ? undefined : request.binding.bindingKey, workspaceCwd: request.binding.cwd });
      if (mode !== "reuse") {
        await assert.rejects(action, /Protected Workspace Restore provisioning/);
        assert.equal(await readFile(path, "utf8"), before);
      } else {
        const result = await action();
        assert.equal(result.reused, true);
        assert.equal(result.record.slot, "A");
        assert.deepEqual(result.target, request.target);
      }
      assert.deepEqual(calls, [], "no createForumTopic or other API effect");
      assert.deepEqual(threads.listPendingProvisions(), []);
      assert.deepEqual(threads.listWorkspaceBindings()[0]?.target, request.target);
      assert.equal(threads.listWorkspaceBindings()[0]?.sessionId, request.binding.sessionId);
      assert.equal(store.list().length, 1);
    }, role);
  });
}

test("Matching Workspace targets alone cannot acknowledge an unknown relocation", async () => {
  await withWorkspaceRelocationFixture("leader", async (store) => {
    const binding = store.listWorkspaceBindings()[0]!;
    const owner = store.list()[0]!;
    const target = { chatId: 7, threadId: 42 };
    store.upsertWorkspaceBinding({ ...binding, target, updatedAtMs: 1000 });
    store.upsert({ ...owner, target, updatedAtMs: 1000 });
    await store.persist();
    assert.deepEqual(restorations(store), []);
    assert.equal(await relocate(store, "unknown", binding, owner, target, () => true), false);
    assert.deepEqual(restorations(store), [], "matching targets never manufacture source authority");
  });
});

test("Stale-target invalidation fences the durable commit and preserves a replacement binding", async () => {
  for (const race of ["none", "generation", "binding", "ownership"] as const) {
    const root = await mkdtemp(join(tmpdir(), "telegram-invalidation-"));
    const path = join(root, "state.json");
    let generation = 1;
    let atCommit: (() => void) | undefined;
    let owns = true;
    const target = { chatId: 100, threadId: 42 };
    const record = { profileKey: "cwd:/repo", owner: { kind: "leader" as const, cwd: "/repo", instanceId: "a" }, instanceId: "a", target, status: "active" as const, createdAtMs: 1, updatedAtMs: 1 };
    const store = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 1000,
      commitPersist: (commit) => {
        atCommit?.();
        if (!owns) return false;
        commit();
        return true;
      },
    });
    try {
      store.upsert(record);
      store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/repo")!,
        target, slot: "A", updatedAtMs: 1 });
      await store.persist();
      atCommit = () => {
        assert.equal(store.list()[0]?.instanceId, "a", "invalidation must not publish before commit");
        assert.equal(store.getWorkspaceBinding("/repo")?.inactiveSinceMs, undefined);
        if (race === "generation") generation++;
        if (race === "binding") store.upsert({ ...record, instanceId: "b", owner: { ...record.owner, instanceId: "b" }, updatedAtMs: 2 });
        if (race === "ownership") owns = false;
      };
      const applied = await store.invalidateTarget(target, () => generation === 1 && store.list()[0]?.instanceId === "a", "confirmed stale target");
      assert.equal(applied, race === "none");
      const disk = JSON.parse(await readFile(path, "utf8"));
      assert.equal(disk.threads.length, race === "none" ? 0 : 1);
      assert.equal(disk.workspaceBindings[0]?.inactiveSinceMs, race === "none" ? 1000 : undefined);
      assert.equal(store.getWorkspaceBinding("/repo")?.inactiveSinceMs, race === "none" ? 1000 : undefined);
      assert.equal(store.list().length, race === "none" ? 0 : 1);
      assert.equal(store.listSyncObservations().some((entry) => entry.syncStatus === "deleted"), race === "none");
      if (race === "binding") {
        assert.equal(store.list()[0]?.instanceId, "b");
        atCommit = undefined;
        await store.persist();
        assert.equal(JSON.parse(await readFile(path, "utf8")).threads[0]?.instanceId, "b");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Owner detachment publishes inactivity only with an exact fenced durable commit", async () => {
  for (const race of ["none", "generation", "replacement", "ownership", "publication", "ack"] as const) {
    const root = await mkdtemp(join(tmpdir(), "telegram-owner-detachment-"));
    const path = join(root, "state.json");
    let current = true;
    let atCommit: (() => void) | undefined;
    let owns = true;
    let nowMs = 1000;
    const target = { chatId: 7, threadId: 42 };
    const store = createTelegramTopicTargetStore({ path, getNowMs: () => nowMs,
      commitPersist(commit) {
        atCommit?.();
        if (!owns) return false;
        commit();
        if (atCommit && race === "ack") throw new Error("snapshot publication acknowledgement lost");
        return true;
      } });
    try {
      store.upsert({ profileKey: "manual:old", instanceId: "old", target,
        status: "active", slot: "A", createdAtMs: 1, updatedAtMs: 1 });
      store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/repo", 0, "session")!,
        target, slot: "A", displayTitle: "Retained", journalBindingKeys: ["manual:old"],
        journalBindingsComplete: true, updatedAtMs: 1 });
      await store.persist();
      await store.load();
      const expected = store.list()[0]!;
      const binding = store.listWorkspaceBindings()[0]!;
      atCommit = () => {
        assert.deepEqual(store.list(), [expected]);
        assert.deepEqual(store.listWorkspaceBindings(), [binding]);
        if (race === "generation") current = false;
        if (race === "replacement") store.upsert({ ...expected, instanceId: "new", updatedAtMs: 2 });
        if (race === "ownership") owns = false;
        if (race === "publication") throw new Error("snapshot publication failed");
      };
      if (race === "publication" || race === "ack") {
        await assert.rejects(store.detachTargetOwner(expected, () => current), /snapshot publication/);
      } else {
        assert.equal(await store.detachTargetOwner(expected, () => current), race === "none");
      }
      const committed = race === "none" || race === "ack";
      assert.deepEqual(store.listWorkspaceBindings(), [{ ...binding,
        ...(committed ? { inactiveSinceMs: 1000 } : {}) }]);
      assert.deepEqual(store.listSyncObservations(), [], "detachment is not Thread absence");
      const disk = JSON.parse(await readFile(path, "utf8"));
      assert.equal(disk.threads.length, committed ? 0 : 1);
      assert.equal(disk.workspaceBindings[0].inactiveSinceMs, committed ? 1000 : undefined);
      atCommit = undefined;
      if (committed) {
        nowMs = 2000;
        assert.equal(await store.detachTargetOwner(expected, () => true), false);
        assert.equal(store.listWorkspaceBindings()[0]?.inactiveSinceMs, 1000);
      }
      if (race === "replacement") {
        assert.equal(await store.detachTargetOwner(expected, () => true), false);
        assert.equal(store.list()[0]?.instanceId, "new");
        assert.equal(store.listWorkspaceBindings()[0]?.inactiveSinceMs, undefined);
      }
      if (race === "publication") {
        assert.equal(await store.detachTargetOwner(expected, () => true), true);
        assert.equal(store.listWorkspaceBindings()[0]?.inactiveSinceMs, 1000);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Owner detachment never frees a slot without an unambiguous retained Workspace binding", async () => {
  for (const bindingState of ["missing", "slot-conflict", "duplicate", "duplicate-owner"] as const) {
    const root = await mkdtemp(join(tmpdir(), "telegram-detachment-binding-"));
    const path = join(root, "state.json");
    const target = { chatId: 7, threadId: 42 };
    const store = createTelegramTopicTargetStore({ path });
    try {
      store.upsert({ profileKey: "manual:old", instanceId: "old", target,
        status: "active", slot: "A", createdAtMs: 1, updatedAtMs: 1 });
      if (bindingState !== "missing") store.upsertWorkspaceBinding({
        ...createTelegramWorkspaceBindingIdentity("/one")!, target,
        slot: bindingState === "slot-conflict" ? "B" : "A", updatedAtMs: 1,
      });
      await store.persist();
      if (bindingState === "duplicate" || bindingState === "duplicate-owner") {
        const file = JSON.parse(await readFile(path, "utf8"));
        if (bindingState === "duplicate") {
          file.workspaceBindings.push({ ...createTelegramWorkspaceBindingIdentity("/two")!,
            target, slot: "A", updatedAtMs: 1 });
        } else {
          file.threads.push({ ...file.threads[0], instanceId: "another-runtime",
            owner: { kind: "manual-follower", instanceId: "another-owner" } });
        }
        await writeFile(path, JSON.stringify(file));
        await store.refresh!();
        assert.equal(bindingState === "duplicate" ? store.listWorkspaceBindings().length : store.list().length, 2);
      }
      const before = await readFile(path, "utf8");
      assert.equal(await store.detachTargetOwner(store.list()[0]!, () => true), false, bindingState);
      assert.equal(store.list()[0]?.instanceId, "old");
      assert.ok(store.listWorkspaceBindings().every((binding) => binding.inactiveSinceMs === undefined));
      assert.equal(await readFile(path, "utf8"), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Owner detachment reconciles memory even when the desired snapshot is already on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-detachment-equality-"));
  const path = join(root, "state.json");
  const target = { chatId: 7, threadId: 42 };
  const store = createTelegramTopicTargetStore({ path, getNowMs: () => 1000 });
  try {
    store.upsert({ profileKey: "manual:old", instanceId: "old", target,
      status: "active", slot: "A", createdAtMs: 1, updatedAtMs: 1 });
    store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/repo")!,
      target, slot: "A", updatedAtMs: 1 });
    await store.persist();
    await store.load();
    const expected = store.list()[0]!;
    const publisher = createTelegramTopicTargetStore({ path, getNowMs: () => 1000 });
    await publisher.load();
    assert.equal(await publisher.detachTargetOwner(expected, () => true), true);
    store.upsert(expected);
    assert.equal(await store.detachTargetOwner(expected, () => true), true);
    assert.deepEqual(store.list(), []);
    assert.equal(store.getWorkspaceBinding("/repo")?.inactiveSinceMs, 1000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("An in-flight snapshot load cannot erase a newly admitted cleanup intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-load-race-"));
  const store = createTelegramTopicTargetStore({ path: join(root, "state.json") });
  try {
    await store.persist();
    const loading = store.load();
    const intent = { id: "cleanup", owner: "leader" as const, instanceId: "owner", runtimeGeneration: "generation", target: { chatId: 77, threadId: 42 }, requestedAtMs: 1 };
    store.upsertPendingCleanup(intent);
    await loading;
    assert.deepEqual(store.listPendingCleanups(), [intent]);
    await store.persist();
    await store.refresh?.();
    assert.deepEqual(store.listPendingCleanups(), [intent]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Thread owner keys isolate named Telegram profiles without changing default keys", () => {
  assert.equal(
    getTelegramThreadOwnerKey({
      kind: "leader",
      cwd: "/repo",
      instanceId: "a",
    }),
    "cwd:/repo",
  );
  assert.equal(
    getTelegramThreadOwnerKey({
      kind: "leader",
      cwd: "/repo",
      instanceId: "a",
      telegramProfile: "omp",
    }),
    "profile:omp:cwd:/repo",
  );
  assert.deepEqual(
    getTelegramThreadOwnerFromProfileKey("profile:omp:manual:worker-a"),
    { kind: "manual-follower", instanceId: "worker-a", telegramProfile: "omp" },
  );
});

test("Thread store restores named-profile owner scope across persistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-profile-owner-"));
  const path = join(dir, "state.omp.json");
  try {
    const legacyStore = createTelegramTopicTargetStore({ path });
    legacyStore.upsert({
      profileKey: "cwd:/repo",
      owner: {
        kind: "leader",
        cwd: "/repo",
        instanceId: "leader-a",
      },
      target: { chatId: 7, threadId: 42 },
      status: "active",
      createdAtMs: 1,
      updatedAtMs: 1,
      instanceId: "leader-a",
      threadName: "Atlas",
      slot: "A",
    });
    await legacyStore.persist();

    const restored = createTelegramTopicTargetStore({
      path,
      telegramProfile: "omp",
    });
    await restored.load();
    assert.deepEqual(
      restored.getByProfileKey("profile:omp:cwd:/repo")?.owner,
      {
        kind: "leader",
        cwd: "/repo",
        instanceId: "leader-a",
        telegramProfile: "omp",
      },
    );
    assert.equal(restored.getByProfileKey("cwd:/repo"), undefined);
    assert.deepEqual(
      restored.getIdentityByProfileKey("profile:omp:cwd:/repo"),
      {
        profileKey: "profile:omp:cwd:/repo",
        threadName: "Atlas",
        slot: "A",
        updatedAtMs: 1,
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread store persists dormant workspace bindings with exact cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-workspaces-"));
  const path = join(dir, "state.json");
  const identity = createTelegramWorkspaceBindingIdentity(
    "/home/llb/.pi/agent/extensions",
    1,
  );
  assert.ok(identity);
  try {
    const store = createTelegramTopicTargetStore({ path });
    assert.deepEqual(
      store.upsertWorkspaceBinding({
        ...identity,
        target: { chatId: 7, threadId: 42 },
        threadName: "Ember",
        slot: "B",
        updatedAtMs: 1000,
      }),
      {
        ...identity,
        target: { chatId: 7, threadId: 42 },
        threadName: "Ember",
        slot: "B",
        updatedAtMs: 1000,
      },
    );
    await store.persist();
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(persisted.workspaceBindings, [
      {
        ...identity,
        target: { chatId: 7, threadId: 42 },
        threadName: "Ember",
        slot: "B",
        updatedAtMs: 1000,
      },
    ]);

    const restored = createTelegramTopicTargetStore({ path });
    await restored.load();
    assert.deepEqual(
      restored.getWorkspaceBinding("/home/llb/.pi/agent/extensions/", "b"),
      persisted.workspaceBindings[0],
    );
    const listed = restored.listWorkspaceBindings();
    listed[0]!.target.threadId = 99;
    assert.equal(
      restored.getWorkspaceBinding(identity.cwd, "b")?.target.threadId,
      42,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread store persists distinct same-cwd session bindings without legacy aliasing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-session-workspaces-"));
  const path = join(dir, "state.json");
  const first = createTelegramWorkspaceBindingIdentity("/repo", 0, "session-a")!;
  const second = createTelegramWorkspaceBindingIdentity("/repo", 0, "session-b")!;
  try {
    const store = createTelegramTopicTargetStore({ path });
    assert.ok(store.upsertWorkspaceBinding({ ...first,
      target: { chatId: 7, threadId: 41 }, slot: "A", updatedAtMs: 1 }));
    assert.equal(store.hasWorkspaceBinding("/repo"), false);
    assert.ok(store.upsertWorkspaceBinding({ ...second,
      target: { chatId: 7, threadId: 42 }, slot: "B", updatedAtMs: 2 }));
    assert.equal(store.hasWorkspaceBinding("/repo", "session-a"), true);
    assert.equal(store.hasWorkspaceBinding("/repo", "session-b"), true);
    assert.equal(store.hasWorkspaceBinding("/repo", "session-c"), false);
    await store.persist();
    const restored = createTelegramTopicTargetStore({ path });
    await restored.load();
    assert.equal(restored.getWorkspaceBinding("/repo", "a"), undefined);
    assert.equal(
      restored.getWorkspaceBinding("/repo", "a", "session-a")?.target.threadId,
      41,
    );
    assert.equal(
      restored.getWorkspaceBinding("/repo", "a", "session-b")?.target.threadId,
      42,
    );
    const malformed = JSON.parse(await readFile(path, "utf8"));
    malformed.workspaceBindings[0].sessionKey = "f".repeat(64);
    await writeFile(path, JSON.stringify(malformed));
    const rejected = createTelegramTopicTargetStore({ path });
    await rejected.load();
    assert.equal(
      rejected.getWorkspaceBinding("/repo", "a", "session-a"),
      undefined,
    );
    assert.equal(
      rejected.getWorkspaceBinding("/repo", "a", "session-b")?.target.threadId,
      42,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Acknowledged display titles persist separately and cannot cross target replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-workspace-title-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    const identity = createTelegramWorkspaceBindingIdentity("/repo")!;
    const binding = { ...identity, target: { chatId: 7, threadId: 41 },
      slot: "A", threadName: "Anchor", updatedAtMs: 1 };
    store.upsertWorkspaceBinding(binding);
    assert.equal(store.setWorkspaceDisplayTitle(binding, "repo_a"), true);
    store.upsertWorkspaceBinding(binding);
    await store.persist();
    const reopened = createTelegramTopicTargetStore({ path });
    await reopened.load();
    const retained = reopened.getWorkspaceBinding("/repo")!;
    assert.equal(retained.displayTitle, "repo_a");
    assert.equal(retained.threadName, "Anchor");
    reopened.upsertWorkspaceBinding({ ...retained, target: { chatId: 7, threadId: 42 } });
    assert.equal(reopened.getWorkspaceBinding("/repo")?.displayTitle, undefined);
    assert.equal(reopened.setWorkspaceDisplayTitle(retained, "stale"), false);
    assert.equal(reopened.getWorkspaceBinding("/repo")?.threadName, "Anchor");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Workspace inactivity persists its first proof, survives stale upserts, and clears only on active ownership or replacement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-workspace-inactivity-"));
  const path = join(dir, "state.json");
  let nowMs = 1000;
  try {
    const store = createTelegramTopicTargetStore({ path, getNowMs: () => nowMs });
    const identity = createTelegramWorkspaceBindingIdentity("/repo")!;
    const binding = { ...identity, target: { chatId: 7, threadId: 41 },
      slot: "A", threadName: "Anchor", updatedAtMs: 1 };
    store.upsertWorkspaceBinding(binding);
    assert.equal(store.markWorkspaceBindingInactiveByTarget(binding.target), true);
    nowMs = 2000;
    assert.equal(store.markWorkspaceBindingInactiveByTarget(binding.target), false);
    store.upsertWorkspaceBinding(binding);
    assert.equal(store.getWorkspaceBinding("/repo")?.inactiveSinceMs, 1000);
    await store.persist();
    const reopened = createTelegramTopicTargetStore({ path });
    await reopened.load();
    assert.equal(reopened.getWorkspaceBinding("/repo")?.inactiveSinceMs, 1000);
    const malformedSnapshot = JSON.parse(await readFile(path, "utf8"));
    malformedSnapshot.workspaceBindings[0].inactiveSinceMs = "legacy-unknown";
    await writeFile(path, JSON.stringify(malformedSnapshot));
    const conservative = createTelegramTopicTargetStore({ path });
    await conservative.load();
    assert.equal(conservative.getWorkspaceBinding("/repo")?.threadName, "Anchor");
    assert.equal(conservative.getWorkspaceBinding("/repo")?.inactiveSinceMs, undefined);
    assert.equal(reopened.markWorkspaceBindingInactiveByTarget(binding.target, -1), false);
    assert.equal(reopened.markWorkspaceBindingActiveByTarget(binding.target), true);
    assert.equal(reopened.getWorkspaceBinding("/repo")?.inactiveSinceMs, undefined);
    assert.equal(reopened.markWorkspaceBindingActiveByTarget(binding.target), false);
    assert.equal(reopened.markWorkspaceBindingInactiveByTarget(binding.target, 3000), true);
    reopened.upsertWorkspaceBinding({ ...reopened.getWorkspaceBinding("/repo")!,
      target: { chatId: 7, threadId: 42 }, updatedAtMs: 4 });
    assert.equal(reopened.getWorkspaceBinding("/repo")?.inactiveSinceMs, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Only exact confirmed absence starts Workspace inactivity, including binding-only recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-workspace-absence-"));
  const path = join(dir, "state.json");
  let nowMs = 1000;
  try {
    const store = createTelegramTopicTargetStore({ path, getNowMs: () => nowMs });
    const target = { chatId: 7, threadId: 41 };
    store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/repo")!,
      target, slot: "A", updatedAtMs: 1 });
    store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/other")!,
      target: { chatId: 8, threadId: 41 }, slot: "B", updatedAtMs: 1 });
    store.upsert({ profileKey: "cwd:/repo", instanceId: "leader", target,
      status: "active", createdAtMs: 1, updatedAtMs: 1 });
    assert.equal(store.markStaleByTarget(target, "unknown"), true);
    assert.equal(store.markStaleByTarget(target, "closed"), false);
    assert.equal(store.getWorkspaceBinding("/repo")?.inactiveSinceMs, undefined);
    assert.equal(store.markStaleByTarget(target, "deleted"), true);
    assert.equal(store.getWorkspaceBinding("/repo")?.inactiveSinceMs, 1000);
    assert.equal(store.getWorkspaceBinding("/other")?.inactiveSinceMs, undefined);
    nowMs = 2000;
    assert.equal(store.markStaleByTarget(target, "deleted"), false);
    await store.persist();
    const restored = createTelegramTopicTargetStore({ path });
    await restored.load();
    assert.equal(restored.getWorkspaceBinding("/repo")?.inactiveSinceMs, 1000);
    assert.equal(restored.getWorkspaceBinding("/other")?.inactiveSinceMs, undefined);
    assert.equal(restored.listWorkspaceBindings().length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Inactive Workspace cleanup commit removes only one exact unprotected binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-workspace-cleanup-commit-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    const binding = { ...createTelegramWorkspaceBindingIdentity("/cleanup")!,
      target: { chatId: 7, threadId: 41 }, slot: "A", threadName: "Anchor",
      inactiveSinceMs: 10, updatedAtMs: 20 };
    store.upsertWorkspaceBinding(binding);
    await store.persist();
    const cleanupSnapshot = { cwd: binding.cwd, workspaceKey: binding.workspaceKey,
      instanceSlot: binding.instanceSlot, slot: binding.slot, bindingKey: binding.bindingKey,
      target: binding.target, inactiveSinceMs: binding.inactiveSinceMs,
      bindingUpdatedAtMs: binding.updatedAtMs };
    assert.equal(await store.commitInactiveWorkspaceCleanup({ ...cleanupSnapshot,
      bindingUpdatedAtMs: 21 }, () => true), false);
    assert.equal(await store.commitInactiveWorkspaceCleanup(cleanupSnapshot, () => true), true);
    assert.equal(await store.commitInactiveWorkspaceCleanup(cleanupSnapshot, () => true), true);
    const reopened = createTelegramTopicTargetStore({ path });
    await reopened.load();
    assert.equal(reopened.getWorkspaceBinding("/cleanup"), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Inactive Workspace cleanup cannot cross same-cwd session identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-session-cleanup-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    const first = { ...createTelegramWorkspaceBindingIdentity("/cleanup", 0, "session-a")!,
      target: { chatId: 7, threadId: 41 }, slot: "A", inactiveSinceMs: 10, updatedAtMs: 20 };
    const second = { ...createTelegramWorkspaceBindingIdentity("/cleanup", 0, "session-b")!,
      target: { chatId: 7, threadId: 42 }, slot: "B", inactiveSinceMs: 11, updatedAtMs: 21 };
    store.upsertWorkspaceBinding(first);
    store.upsertWorkspaceBinding(second);
    await store.persist();
    const snapshot = { cwd: first.cwd, workspaceKey: first.workspaceKey,
      sessionId: first.sessionId, sessionKey: first.sessionKey,
      instanceSlot: first.instanceSlot, slot: first.slot, bindingKey: first.bindingKey,
      target: first.target, inactiveSinceMs: first.inactiveSinceMs,
      bindingUpdatedAtMs: first.updatedAtMs };
    assert.equal(await store.commitInactiveWorkspaceCleanup({ ...snapshot,
      sessionId: "session-b" }, () => true), false);
    assert.equal(await store.commitInactiveWorkspaceCleanup(snapshot, () => true), true);
    assert.equal(store.getWorkspaceBinding("/cleanup", "a", "session-a"), undefined);
    assert.equal(store.getWorkspaceBinding("/cleanup", "a", "session-b")?.target.threadId, 42);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Inactive Workspace cleanup recovers binding publication before and after rename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-workspace-cleanup-prefix-"));
  try {
    const makeBinding = () => ({ ...createTelegramWorkspaceBindingIdentity("/cleanup-prefix")!,
      target: { chatId: 7, threadId: 41 }, slot: "A", threadName: "Anchor",
      inactiveSinceMs: 10, updatedAtMs: 20 });
    const snapshot = (binding: ReturnType<typeof makeBinding>) => ({ cwd: binding.cwd,
      workspaceKey: binding.workspaceKey, instanceSlot: binding.instanceSlot, slot: binding.slot,
      bindingKey: binding.bindingKey, target: binding.target, inactiveSinceMs: binding.inactiveSinceMs,
      bindingUpdatedAtMs: binding.updatedAtMs });

    let boundary: "normal" | "before" | "after" = "normal";
    const path = join(dir, "before.json");
    const store = createTelegramTopicTargetStore({ path, commitPersist(commit) {
      if (boundary === "before") return false;
      commit();
      if (boundary === "after") throw new Error("lost binding commit acknowledgement");
      return true;
    } });
    const binding = makeBinding();
    store.upsertWorkspaceBinding(binding);
    await store.persist();
    boundary = "before";
    await assert.rejects(store.commitInactiveWorkspaceCleanup(snapshot(binding), () => true));
    assert.ok(store.getWorkspaceBinding("/cleanup-prefix"));
    boundary = "normal";
    assert.equal(await store.commitInactiveWorkspaceCleanup(snapshot(binding), () => true), true);

    const afterPath = join(dir, "after.json");
    boundary = "normal";
    const after = createTelegramTopicTargetStore({ path: afterPath, commitPersist(commit) {
      commit();
      if (boundary === "after") throw new Error("lost binding commit acknowledgement");
      return true;
    } });
    const afterBinding = makeBinding();
    after.upsertWorkspaceBinding(afterBinding);
    await after.persist();
    boundary = "after";
    assert.equal(await after.commitInactiveWorkspaceCleanup(snapshot(afterBinding), () => true), true);
    assert.equal(after.getWorkspaceBinding("/cleanup-prefix"), undefined);
    const reopened = createTelegramTopicTargetStore({ path: afterPath });
    await reopened.load();
    assert.equal(reopened.getWorkspaceBinding("/cleanup-prefix"), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Workspace journal keys accumulate while legacy completeness cannot be invented by registration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-workspace-journal-keys-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    const current = { ...createTelegramWorkspaceBindingIdentity("/current")!,
      target: { chatId: 7, threadId: 41 }, slot: "A", threadName: "Anchor",
      journalBindingKeys: [] as string[], journalBindingsComplete: true as const, updatedAtMs: 1 };
    store.upsertWorkspaceBinding(current);
    store.upsertWorkspaceBinding({ ...current, journalBindingKeys: ["manual:first"], updatedAtMs: 2 });
    store.upsertWorkspaceBinding({ ...current, journalBindingKeys: ["manual:second", "manual:first"],
      journalBindingsComplete: undefined, updatedAtMs: 3 });
    const legacy = { ...createTelegramWorkspaceBindingIdentity("/legacy")!,
      target: { chatId: 7, threadId: 42 }, slot: "B", threadName: "Briar", updatedAtMs: 1 };
    store.upsertWorkspaceBinding(legacy);
    store.upsertWorkspaceBinding({ ...legacy, journalBindingKeys: ["manual:current"],
      journalBindingsComplete: true, updatedAtMs: 2 });
    await store.persist();
    const restored = createTelegramTopicTargetStore({ path });
    await restored.load();
    assert.deepEqual(restored.getWorkspaceBinding("/current")?.journalBindingKeys,
      ["manual:first", "manual:second"]);
    assert.equal(restored.getWorkspaceBinding("/current")?.journalBindingsComplete, true);
    assert.deepEqual(restored.getWorkspaceBinding("/legacy")?.journalBindingKeys,
      ["manual:current"]);
    assert.equal(restored.getWorkspaceBinding("/legacy")?.journalBindingsComplete, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Workspace session journal evidence accumulates exact tuples and survives detached reads and cold load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-workspace-journal-sources-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    const binding = { ...createTelegramWorkspaceBindingIdentity("/repo", 0, "session-b")!,
      target: { chatId: 7, threadId: 42 }, slot: "A", updatedAtMs: 1 };
    const oldSource = { sessionId: "session-a", recipientBindingKey: "manual:same-process" };
    const newSource = { sessionId: "session-b", recipientBindingKey: "manual:same-process" };
    store.upsertWorkspaceBinding({ ...binding, journalSources: [oldSource] });
    store.upsertWorkspaceBinding({ ...binding, journalSources: [newSource, oldSource] });
    const detached = store.listWorkspaceBindings()[0]!;
    assert.deepEqual(detached.journalSources, [oldSource, newSource]);
    detached.journalSources![0]!.sessionId = "caller-forgery";
    const current = store.listWorkspaceBindings()[0]!;
    assert.deepEqual(current.journalSources, [oldSource, newSource]);
    assert.ok(store.commitWorkspaceJournalEvidence(current, [], false));
    await store.persist();
    const cold = createTelegramTopicTargetStore({ path });
    await cold.load();
    assert.deepEqual(cold.listWorkspaceBindings()[0]?.journalSources, [oldSource, newSource],
      "Legacy-key pruning cannot erase exact session addresses");
    const successor = cold.upsertWorkspaceBinding({ ...binding,
      ...createTelegramWorkspaceBindingIdentity("/repo", 0, "session-c")!,
      journalSources: [{ sessionId: "session-c", recipientBindingKey: "manual:same-process" }] });
    assert.deepEqual(successor?.journalSources, [oldSource, newSource,
      { sessionId: "session-c", recipientBindingKey: "manual:same-process" }],
      "Replacing the same target's binding also retains every predecessor address");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Malformed or over-capacity session journal evidence cannot erase a retained Workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-workspace-journal-invalid-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    const binding = { ...createTelegramWorkspaceBindingIdentity("/repo", 0, "session")!,
      target: { chatId: 7, threadId: 42 }, slot: "A", updatedAtMs: 1 };
    const sources = Array.from({ length: 256 }, (_, index) => ({ sessionId: `session-${index}`, recipientBindingKey: "manual:recipient" }));
    const retained = store.upsertWorkspaceBinding({ ...binding, journalSources: sources })!;
    assert.ok(retained);
    assert.equal(store.upsertWorkspaceBinding({ ...binding, journalSources: [{ sessionId: "extra", recipientBindingKey: "manual:recipient" }] }), undefined);
    assert.deepEqual(store.listWorkspaceBindings()[0], retained);
    await store.persist();
    const original = await readFile(path, "utf8");
    for (const evidence of [null, [{ sessionId: "", recipientBindingKey: "manual:recipient" }],
      [{ sessionId: " session", recipientBindingKey: "manual:recipient" }],
      [{ sessionId: "session", recipientBindingKey: "" }],
      [{ sessionId: "session", recipientBindingKey: "manual:recipient", path: "forged" }], [...sources, sources[0]]]) {
      assert.equal(store.upsertWorkspaceBinding({ ...binding, journalSources: evidence as never }), undefined);
      assert.deepEqual(store.listWorkspaceBindings()[0], retained);
      const corrupt = JSON.parse(original);
      corrupt.workspaceBindings[0].journalSources = evidence;
      await writeFile(path, JSON.stringify(corrupt));
      const cold = createTelegramTopicTargetStore({ path });
      await assert.rejects(cold.load(), /Invalid Workspace session journal evidence/);
      assert.equal(JSON.parse(await readFile(path, "utf8")).workspaceBindings.length, 1,
        "Cold refusal does not rewrite malformed evidence into an empty Workspace");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Workspace occupancy snapshot fails closed across local operations and external work authority", () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json", getNowMs: () => 1000 });
  for (const [cwd, slot, threadId, inactiveSinceMs] of [
    ["/eligible", "A", 41, 100], ["/live", "B", 42, 100],
    ["/claimed", "C", 43, 100], ["/provisioning", "D", 44, 100],
    ["/cleanup", "E", 45, 100], ["/unproven", "F", 46, undefined],
    ["/unknown-work", "G", 47, 100], ["/accepted-work", "H", 48, 100],
    ["/reserved", "I", 49, 100], ["/future-proof", "J", 50, 1100],
    ["/external-live", "K", 51, 100],
  ] as const) {
    store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity(cwd)!,
      target: { chatId: 7, threadId }, slot, threadName: "Anchor",
      ...(inactiveSinceMs !== undefined ? { inactiveSinceMs } : {}), updatedAtMs: 1 });
  }
  store.upsert({ profileKey: "manual:live", instanceId: "live",
    owner: { kind: "manual-follower", instanceId: "live" },
    target: { chatId: 7, threadId: 42 }, slot: "B", status: "active",
    createdAtMs: 1, updatedAtMs: 1 });
  assert.equal(store.claimWorkspaceIdentity("/claimed", "claim")?.slot, "C");
  store.upsertPendingProvision({ id: "provision", owner: "manual-follower",
    instanceId: "provision", slot: "D", target: { chatId: 7, threadId: 44 },
    startedAtMs: 1, expiresAtMs: 2000 });
  store.upsertPendingCleanup({ id: "cleanup", owner: "manual-follower",
    instanceId: "cleanup", runtimeGeneration: "cleanup:1",
    target: { chatId: 7, threadId: 45 }, requestedAtMs: 1 });
  store.reserveThread({ target: { chatId: 7, threadId: 49 }, slot: "I",
    reason: "leader-reload", createdAtMs: 1, updatedAtMs: 1, expiresAtMs: 2000 });
  const snapshot = store.captureWorkspaceSlotOccupancy((binding) => ({
    liveOwner: binding.cwd === "/external-live" ? "protected" : "clear",
    acceptedWork: binding.cwd === "/accepted-work" ? "protected" : "clear",
    deliveryAuthority: binding.cwd === "/unknown-work" ? "unknown" : "clear",
  }));
  assert.deepEqual(Object.fromEntries(snapshot.bindings.map((entry) => [entry.slot, entry.protection])), {
    a: "eligible", b: "protected", c: "protected", d: "protected", e: "protected",
    f: "unknown", g: "unknown", h: "protected", i: "protected", j: "unknown",
    k: "protected",
  });
  assert.equal(snapshot.bindings.find((entry) => entry.slot === "a")?.inactiveSinceMs, 100);
  assert.deepEqual(new Set(snapshot.reservedSlots), new Set(["b", "c", "d", "i"]));
});

test("Workspace claims report only proven global slot exhaustion as capacity failure", () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  for (const [index, slot] of Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ").entries()) {
    store.upsertWorkspaceBinding({
      ...createTelegramWorkspaceBindingIdentity(`/repo/${index}`)!,
      target: { chatId: 7, threadId: 100 + index }, slot,
      inactiveSinceMs: index + 1, updatedAtMs: index + 1,
    });
  }
  let capacityFailures = 0;
  assert.equal(store.claimWorkspaceIdentity("/fresh", "fresh", undefined, {
    onCapacityUnavailable() { capacityFailures++; },
  }), undefined);
  assert.equal(capacityFailures, 1);
  assert.equal(store.claimWorkspaceIdentity("/repo/0", "existing", undefined, {
    onCapacityUnavailable() { capacityFailures++; },
  })?.slot, "A");
  assert.equal(capacityFailures, 1);
  assert.equal(store.claimWorkspaceIdentity("/other", "existing", undefined, {
    onCapacityUnavailable() { capacityFailures++; },
  }), undefined);
  assert.equal(capacityFailures, 1);
});

test("Workspace retirement intents persist an exact binding and protect it until exact removal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-workspace-retirement-intent-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    const binding = { ...createTelegramWorkspaceBindingIdentity(
      "/repo", 0, "session-a",
    )!, target: { chatId: 7, threadId: 41 }, slot: "A", threadName: "Anchor",
      inactiveSinceMs: 100, updatedAtMs: 200 };
    store.upsertWorkspaceBinding(binding);
    const intent = { id: "retire:repo:a:100", reason: "pressure" as const,
      profileKey: "default", binding, leaderEpoch: "leader:1", requestedAtMs: 300 };
    assert.equal(store.upsertWorkspaceRetirementIntent(intent), true);
    assert.equal(store.upsertWorkspaceRetirementIntent(structuredClone(intent)), true);
    assert.equal(store.upsertWorkspaceRetirementIntent({ ...intent, id: "retire:other" }), false);
    await store.persist();
    const restored = createTelegramTopicTargetStore({ path });
    await restored.load();
    assert.deepEqual(restored.listWorkspaceRetirementIntents(), [intent]);
    assert.equal(restored.claimWorkspaceIdentity("/repo", "returning", undefined,
      { sessionId: "session-a" }), undefined);
    assert.equal(restored.setWorkspaceDisplayTitle(binding, "Changed"), false);
    assert.equal(restored.markWorkspaceBindingActiveByTarget(binding.target), false);
    assert.equal(restored.getWorkspaceBinding("/repo", "a", "session-a")?.inactiveSinceMs, 100);
    const clearExternal = () => ({ liveOwner: "clear" as const,
      acceptedWork: "clear" as const, deliveryAuthority: "clear" as const });
    assert.equal(restored.captureWorkspaceSlotOccupancy(clearExternal).bindings[0]?.protection, "protected");
    assert.equal(restored.captureWorkspaceSlotOccupancy(clearExternal,
      { expectedRetirement: intent }).bindings[0]?.protection, "eligible");
    assert.equal(restored.captureWorkspaceSlotOccupancy(clearExternal,
      { expectedRetirement: { ...intent, leaderEpoch: "stale" } }).bindings[0]?.protection, "protected");
    const listed = restored.listWorkspaceRetirementIntents()[0]!;
    listed.binding.target.threadId = 99;
    assert.equal(restored.listWorkspaceRetirementIntents()[0]?.binding.target.threadId, 41);
    const current = restored.getWorkspaceBinding("/repo", "a", "session-a")!;
    const changed = { ...current, threadName: "Navigator", updatedAtMs: 400 };
    assert.equal(restored.upsertWorkspaceBinding(changed), undefined);
    assert.equal(restored.getWorkspaceBinding("/repo", "a", "session-a")?.threadName, "Anchor");
    const replacement = { ...intent, binding: changed, requestedAtMs: 500 };
    assert.equal(restored.upsertWorkspaceRetirementIntent(replacement), false);
    assert.equal(restored.removeWorkspaceRetirementIntent(replacement), false);
    assert.equal(restored.removeWorkspaceRetirementIntent(intent), true);
    const committed = restored.upsertWorkspaceBinding(changed)!;
    assert.equal(committed.threadName, "Navigator");
    assert.equal(restored.upsertWorkspaceRetirementIntent({
      ...replacement, binding: committed,
    }), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Workspace suffix exposure persists after multiplicity, stale upserts, and sibling retirement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-workspace-display-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    const first = createTelegramWorkspaceBindingIdentity("/repo");
    const second = createTelegramWorkspaceBindingIdentity("/repo", 1);
    assert.ok(first);
    assert.ok(second);
    const firstBinding = { ...first, target: { chatId: 7, threadId: 41 },
      slot: "A", threadName: "Anchor", updatedAtMs: 1 };
    store.upsertWorkspaceBinding(firstBinding);
    assert.equal(store.getWorkspaceBinding("/repo")?.showSlotSuffix, undefined);
    store.upsertWorkspaceBinding({ ...second, target: { chatId: 7, threadId: 42 },
      slot: "C", threadName: "Cedar", updatedAtMs: 2 });
    assert.ok(store.listWorkspaceBindings().every((binding) => binding.showSlotSuffix));
    store.upsertWorkspaceBinding(firstBinding);
    assert.equal(store.getWorkspaceBinding("/repo")?.showSlotSuffix, true);
    await store.persist();
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    snapshot.workspaceBindings = snapshot.workspaceBindings.filter(
      (binding: { bindingKey: string }) => binding.bindingKey === first.bindingKey,
    );
    await writeFile(path, JSON.stringify(snapshot));
    const reopened = createTelegramTopicTargetStore({ path });
    await reopened.load();
    assert.equal(reopened.listWorkspaceBindings().length, 1);
    assert.equal(reopened.getWorkspaceBinding("/repo")?.showSlotSuffix, true);
    assert.equal(reopened.getWorkspaceBinding("/repo")?.threadName, "Anchor");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread store rejects readable-key collisions across exact cwd values", () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  const first = createTelegramWorkspaceBindingIdentity("/repo/a-b");
  const colliding = createTelegramWorkspaceBindingIdentity("/repo/a/b");
  assert.ok(first);
  assert.ok(colliding);
  assert.equal(first.workspaceKey, colliding.workspaceKey);
  assert.ok(
    store.upsertWorkspaceBinding({
      ...first,
      target: { chatId: 7, threadId: 42 },
      updatedAtMs: 1,
    }),
  );
  assert.equal(
    store.upsertWorkspaceBinding({
      ...colliding,
      target: { chatId: 7, threadId: 43 },
      updatedAtMs: 2,
    }),
    undefined,
  );
});

test("Workspace claims allocate deterministic concurrent slots and release them", () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  const cwd = "/home/llb/.pi/agent/extensions";
  assert.equal(store.claimWorkspaceIdentity(cwd, "instance-a")?.bindingKey,
    "--home-llb-.pi-agent-extensions--");
  assert.equal(store.claimWorkspaceIdentity(cwd, "instance-a")?.instanceSlot,
    "a");
  assert.equal(store.claimWorkspaceIdentity(cwd, "instance-b")?.bindingKey,
    "--home-llb-.pi-agent-extensions--b");
  assert.equal(store.releaseWorkspaceClaim("instance-a"), true);
  assert.equal(store.releaseWorkspaceClaim("instance-a"), false);
  assert.equal(store.claimWorkspaceIdentity(cwd, "instance-c")?.instanceSlot,
    "a");
  assert.equal(
    store.claimWorkspaceIdentity("/another/workspace", "instance-c"),
    undefined,
  );
});

test("Workspace claims transfer an exact previous runtime claim during reload", () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  const previous = store.claimWorkspaceIdentity("/repo", "instance-old");
  assert.ok(previous);
  assert.deepEqual(
    store.claimWorkspaceIdentity("/repo", "instance-new", "instance-old"),
    previous,
  );
  assert.equal(
    store.upsertWorkspaceBinding({
      ...previous,
      target: { chatId: 7, threadId: 41 },
      updatedAtMs: 1,
    }, "instance-old"),
    undefined,
  );
  assert.ok(store.upsertWorkspaceBinding({
    ...previous,
    target: { chatId: 7, threadId: 41 },
    updatedAtMs: 1,
  }, "instance-new"));
});

test("Workspace claims keep same-cwd sessions stable and independently slotted", () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  const first = store.claimWorkspaceIdentity("/repo", "instance-a", undefined,
    { sessionId: "session-a" });
  const repeated = store.claimWorkspaceIdentity("/repo", "instance-a", undefined,
    { sessionId: " session-a " });
  const second = store.claimWorkspaceIdentity("/repo", "instance-b", undefined,
    { sessionId: "session-b" });
  assert.ok(first);
  assert.deepEqual(repeated, first);
  assert.ok(second);
  assert.equal(first.instanceSlot, "a");
  assert.equal(second.instanceSlot, "a");
  assert.equal(first.slot, "A");
  assert.equal(second.slot, "B");
  assert.notEqual(first.bindingKey, second.bindingKey);
  assert.equal(store.claimWorkspaceIdentity("/repo", "instance-a", undefined,
    { sessionId: "session-b" }), undefined);
  assert.equal(store.claimWorkspaceIdentity("/repo", "invalid", undefined,
    { sessionId: "" }), undefined);
  assert.ok(store.upsertWorkspaceBinding({ ...first,
    target: { chatId: 7, threadId: 41 }, updatedAtMs: 1 }, "instance-a"));
  assert.ok(store.upsertWorkspaceBinding({ ...second,
    target: { chatId: 7, threadId: 42 }, updatedAtMs: 2 }, "instance-b"));
  assert.equal(store.getWorkspaceBinding("/repo", "a", "session-a")?.slot, "A");
  assert.equal(store.getWorkspaceBinding("/repo", "a", "session-b")?.slot, "B");
  assert.equal(store.getWorkspaceBinding("/repo"), undefined);
});

test("Session replacement intent persists exactly once and clears only by exact CAS", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-session-replacement-"));
  const path = join(dir, "state.json");
  const intent = {
    continuity: "workspace-thread" as const,
    cwd: "/repo", profileName: "default", sourceSessionId: "session-old",
    sourceUpdateId: 41, target: { chatId: 7, threadId: 42 }, messageId: 99,
    slot: "A", threadName: "Anchor", createdAtMs: 1000, expiresAtMs: 31_000,
  };
  try {
    const store = createTelegramTopicTargetStore({ path, getNowMs: () => 1000 });
    assert.equal(await store.commitSessionReplacementIntent(intent, () => true), true);
    assert.equal(await store.commitSessionReplacementIntent(
      { ...intent, sourceUpdateId: 42 }, () => true,
    ), false);
    const reopened = createTelegramTopicTargetStore({ path, getNowMs: () => 2000 });
    await reopened.load();
    assert.deepEqual(reopened.getSessionReplacementIntent(), intent);
    assert.equal(await reopened.removeSessionReplacementIntent(
      { ...intent, messageId: 100 }, () => true,
    ), false);
    assert.equal(await reopened.removeSessionReplacementIntent(intent, () => true), true);
    const cleared = createTelegramTopicTargetStore({ path });
    await cleared.load();
    assert.equal(cleared.getSessionReplacementIntent(), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Classic session replacement intent persists without mutating Workspace bindings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-classic-session-replacement-"));
  const path = join(dir, "state.json");
  const intent = { continuity: "classic-chat" as const, cwd: "/repo",
    profileName: "default", sourceSessionId: "session-old", sourceUpdateId: 41,
    target: { chatId: 7 }, messageId: 99, createdAtMs: 1000, expiresAtMs: 31_000 };
  try {
    const store = createTelegramTopicTargetStore({ path, getNowMs: () => 1000 });
    assert.equal(await store.commitSessionReplacementIntent(intent, () => true), true);
    const reopened = createTelegramTopicTargetStore({ path, getNowMs: () => 2000 });
    await reopened.load();
    assert.deepEqual(reopened.getSessionReplacementIntent(), intent);
    assert.equal(reopened.claimWorkspaceIdentity("/repo", "new", undefined,
      { sessionId: "session-new", existingBindingOnly: true }), undefined);
    assert.deepEqual(reopened.listWorkspaceBindings(), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Session replacement intent re-keys the exact Workspace binding for a successor process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-session-rekey-"));
  const path = join(dir, "state.json");
  try {
    const seed = createTelegramTopicTargetStore({ path, getNowMs: () => 1000 });
    const oldIdentity = createTelegramWorkspaceBindingIdentity("/repo", 0, "session-old")!;
    const target = { chatId: 7, threadId: 42 };
    seed.upsertWorkspaceBinding({ ...oldIdentity, target, slot: "C", threadName: "Cedar",
      journalSources: [{ sessionId: "session-old", recipientBindingKey: "manual:same-process" }], updatedAtMs: 1 });
    seed.upsert({ profileKey: "profile:default:cwd:/repo", owner: { kind: "leader", cwd: "/repo", instanceId: "old", telegramProfile: "default" }, instanceId: "old", target, status: "active", createdAtMs: 1, updatedAtMs: 1, slot: "C", threadName: "Cedar" });
    await seed.persist();
    const intent = { continuity: "workspace-thread" as const, cwd: "/repo", profileName: "default", sourceSessionId: "session-old", sourceUpdateId: 41, target, messageId: 99, slot: "C", threadName: "Cedar", createdAtMs: 1000, expiresAtMs: 31_000 };
    assert.equal(await seed.commitSessionReplacementIntent(intent, () => true), true);

    const successor = createTelegramTopicTargetStore({ path, getNowMs: () => 2000 });
    await successor.load();
    const claimed = successor.claimWorkspaceIdentity("/repo", "new", undefined, { sessionId: "session-new", existingBindingOnly: true });
    assert.equal(claimed?.slot, "C");
    assert.equal(successor.getWorkspaceBinding("/repo", "a", "session-old"), undefined);
    assert.deepEqual(successor.getWorkspaceBinding("/repo", "a", "session-new")?.target, target);
    await successor.persist();
    const reopened = createTelegramTopicTargetStore({ path });
    await reopened.load();
    assert.deepEqual(reopened.getWorkspaceBinding("/repo", "a", "session-new")?.target, target);
    assert.deepEqual(reopened.getWorkspaceBinding("/repo", "a", "session-new")?.journalSources,
      [{ sessionId: "session-old", recipientBindingKey: "manual:same-process" }],
      "Re-key retains the old folder's exact custody address, not the new binding's session ID");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Follower-published replacement intent re-keys only for its exact source instance lineage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-follower-session-rekey-"));
  const path = join(dir, "state.json");
  try {
    const seed = createTelegramTopicTargetStore({ path, getNowMs: () => 1000 });
    const oldIdentity = createTelegramWorkspaceBindingIdentity("/repo", 0, "session-old")!;
    const target = { chatId: 7, threadId: 42 };
    seed.upsertWorkspaceBinding({ ...oldIdentity, target, slot: "C", threadName: "Cedar", updatedAtMs: 1 });
    await seed.persist();
    const intent = { continuity: "workspace-thread" as const, cwd: "/repo",
      profileName: "default", sourceSessionId: "session-old", sourceUpdateId: 41,
      target, messageId: 99, slot: "C", threadName: "Cedar", createdAtMs: 1000,
      expiresAtMs: 31_000, sourceInstanceId: "follower-old" };
    assert.equal(await seed.commitSessionReplacementIntent(
      { ...intent, sourceInstanceId: "" }, () => true), false);
    assert.equal(await seed.commitSessionReplacementIntent(intent, () => true), true);

    const successor = createTelegramTopicTargetStore({ path, getNowMs: () => 2000 });
    await successor.load();
    assert.deepEqual(successor.getSessionReplacementIntent(), intent);
    assert.equal(successor.claimWorkspaceIdentity("/repo", "intruder", undefined,
      { sessionId: "session-intruder", existingBindingOnly: true }), undefined);
    assert.equal(successor.claimWorkspaceIdentity("/repo", "intruder", "other-old",
      { sessionId: "session-intruder", existingBindingOnly: true }), undefined);
    assert.deepEqual(successor.getWorkspaceBinding("/repo", "a", "session-old")?.target, target);
    const claimed = successor.claimWorkspaceIdentity("/repo", "follower-new", "follower-old",
      { sessionId: "session-new", existingBindingOnly: true });
    assert.equal(claimed?.slot, "C");
    assert.equal(successor.getWorkspaceBinding("/repo", "a", "session-old"), undefined);
    assert.deepEqual(successor.getWorkspaceBinding("/repo", "a", "session-new")?.target, target);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Workspace binding moves an existing Thread and slot to a replacement session", () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  const previous = store.claimWorkspaceIdentity("/repo", "instance-old", undefined, {
    sessionId: "session-old",
  });
  assert.ok(previous);
  const target = { chatId: 7, threadId: 41 };
  assert.ok(store.upsertWorkspaceBinding({
    ...previous,
    target,
    threadName: "Pulse",
    updatedAtMs: 1,
  }, "instance-old"));
  store.releaseWorkspaceClaim("instance-old");

  const replacement = store.claimWorkspaceIdentity(
    "/repo",
    "instance-new",
    undefined,
    { sessionId: "session-new" },
  );
  assert.ok(replacement);
  assert.ok(store.upsertWorkspaceBinding({
    ...replacement,
    target,
    slot: previous.slot,
    updatedAtMs: 2,
  }, "instance-new"));
  assert.equal(store.getWorkspaceBinding("/repo", previous.instanceSlot, "session-old"), undefined);
  const rebound = store.getWorkspaceBinding(
    "/repo",
    replacement.instanceSlot,
    "session-new",
  );
  assert.equal(rebound?.slot, previous.slot);
  assert.equal(rebound?.threadName, "Pulse");
});

test("Workspace claims reserve global letters across directories and fence slot commits", () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  const first = store.claimWorkspaceIdentity("/one", "first");
  const second = store.claimWorkspaceIdentity("/two", "second");
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.instanceSlot, "a");
  assert.equal(second.instanceSlot, "a");
  assert.deepEqual([first.slot, second.slot], ["A", "B"]);
  assert.equal(store.upsertWorkspaceBinding({
    ...second, slot: "A", target: { chatId: 7, threadId: 42 }, updatedAtMs: 1,
  }, "second"), undefined);
  assert.ok(store.upsertWorkspaceBinding({
    ...second, target: { chatId: 7, threadId: 42 }, updatedAtMs: 1,
  }, "second"));
  assert.equal(store.releaseWorkspaceClaim("first"), true);
  assert.equal(store.claimWorkspaceIdentity("/three", "third")?.slot, "A");
  assert.equal(store.claimWorkspaceIdentity("/four", "fourth")?.slot, "C");
  assert.equal(store.claimWorkspaceIdentity("/two", "reopened")?.slot, "B");
});

test("Global Workspace slots survive reload without rekeying legacy directory identities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-global-workspace-slots-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    for (const [cwd, slot, threadId] of [["/one", "A", 41], ["/two", "C", 42]] as const) {
      const identity = createTelegramWorkspaceBindingIdentity(cwd);
      assert.ok(identity);
      store.upsertWorkspaceBinding({
        ...identity, slot, target: { chatId: 7, threadId }, updatedAtMs: 1,
      });
    }
    await store.persist();
    const restored = createTelegramTopicTargetStore({ path });
    await restored.load();
    const before = restored.listWorkspaceBindings();
    assert.equal(restored.claimWorkspaceIdentity("/fresh", "fresh")?.slot, "B");
    assert.equal(restored.claimWorkspaceIdentity("/two", "returning")?.slot, "C");
    assert.deepEqual(restored.listWorkspaceBindings(), before);
    assert.equal(restored.getWorkspaceBinding("/two")?.bindingKey,
      createTelegramWorkspaceBindingIdentity("/two")?.bindingKey);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Legacy missing global slots migrate only through an exact claim commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-legacy-missing-slot-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    const occupied = createTelegramWorkspaceBindingIdentity("/occupied")!;
    const missing = createTelegramWorkspaceBindingIdentity("/missing")!;
    store.upsertWorkspaceBinding({ ...occupied, target: { chatId: 7, threadId: 41 },
      slot: "A", threadName: "Anchor", updatedAtMs: 1 });
    store.upsertWorkspaceBinding({ ...missing, target: { chatId: 7, threadId: 42 },
      threadName: "Briar", updatedAtMs: 1 });
    await store.persist();
    const restored = createTelegramTopicTargetStore({ path });
    await restored.load();
    const firstClaim = restored.claimWorkspaceIdentity("/missing/", "first", undefined,
      { existingBindingOnly: true });
    assert.equal(firstClaim?.slot, "B");
    assert.equal(firstClaim?.bindingKey, missing.bindingKey);
    assert.equal(restored.getWorkspaceBinding("/missing")?.slot, undefined);
    assert.equal(restored.releaseWorkspaceClaim("first"), true);
    const retry = restored.claimWorkspaceIdentity("/missing", "retry", undefined,
      { existingBindingOnly: true });
    assert.equal(retry?.slot, "B");
    assert.ok(retry && restored.upsertWorkspaceBinding({ ...retry,
      target: { chatId: 7, threadId: 42 }, threadName: "Briar", updatedAtMs: 2,
    }, "retry"));
    await restored.persist();
    const committed = createTelegramTopicTargetStore({ path });
    await committed.load();
    assert.equal(committed.getWorkspaceBinding("/missing")?.slot, "B");
    assert.equal(committed.getWorkspaceBinding("/missing")?.instanceSlot, "a");
    assert.equal(committed.getWorkspaceBinding("/missing")?.bindingKey, missing.bindingKey);
    assert.equal(committed.getWorkspaceBinding("/missing")?.inactiveSinceMs, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Legacy duplicate global slots migrate only the exact claimed binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-legacy-duplicate-slot-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/one")!,
      target: { chatId: 7, threadId: 41 }, slot: "A", threadName: "Anchor", updatedAtMs: 1 });
    assert.equal(store.upsertWorkspaceBinding({
      ...createTelegramWorkspaceBindingIdentity("/two")!,
      target: { chatId: 7, threadId: 42 }, slot: "A", threadName: "Briar", updatedAtMs: 1,
    }), undefined);
    await store.persist();
    const legacySnapshot = JSON.parse(await readFile(path, "utf8"));
    legacySnapshot.workspaceBindings.push({
      ...createTelegramWorkspaceBindingIdentity("/two")!,
      target: { chatId: 7, threadId: 42 }, slot: "A", threadName: "Briar", updatedAtMs: 1,
    });
    await writeFile(path, JSON.stringify(legacySnapshot));
    const restored = createTelegramTopicTargetStore({ path });
    await restored.load();
    const before = restored.listWorkspaceBindings();
    assert.equal(restored.claimWorkspaceIdentity("/fresh", "fresh"), undefined);
    const first = restored.claimWorkspaceIdentity("/one", "one", undefined,
      { existingBindingOnly: true });
    assert.equal(first?.slot, "B");
    assert.deepEqual(restored.listWorkspaceBindings(), before);
    assert.equal(restored.releaseWorkspaceClaim("one"), true);
    const retry = restored.claimWorkspaceIdentity("/one", "retry", undefined,
      { existingBindingOnly: true });
    assert.equal(retry?.slot, "B");
    assert.ok(retry && restored.upsertWorkspaceBinding({ ...retry,
      target: { chatId: 7, threadId: 41 }, threadName: "Anchor", updatedAtMs: 2,
    }, "retry"));
    assert.equal(restored.getWorkspaceBinding("/one")?.slot, "B");
    assert.equal(restored.getWorkspaceBinding("/two")?.slot, "A");
    assert.equal(restored.claimWorkspaceIdentity("/fresh", "fresh")?.slot, "C");
    assert.equal(restored.getWorkspaceBinding("/one")?.inactiveSinceMs, undefined);
    assert.equal(restored.getWorkspaceBinding("/two")?.inactiveSinceMs, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Workspace capacity protects all 26 live claims instead of extending or evicting", () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  for (let index = 0; index < 26; index++) {
    assert.equal(store.claimWorkspaceIdentity(`/repo/${index}`, `instance-${index}`)?.slot,
      String.fromCharCode(65 + index));
  }
  assert.equal(store.claimWorkspaceIdentity("/overflow", "overflow"), undefined);
  assert.equal(store.listWorkspaceBindings().length, 0);
  assert.equal(store.releaseWorkspaceClaim("instance-12"), true);
  assert.equal(store.claimWorkspaceIdentity("/overflow", "overflow")?.slot, "M");
});

test("Workspace restore-only claims reuse bindings without allocating new identities", () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });

  assert.equal(
    store.claimWorkspaceIdentity("/fresh", "fresh", undefined, {
      existingBindingOnly: true,
    }),
    undefined,
  );
  assert.equal(store.hasWorkspaceBinding("/fresh"), false);

  const identity = store.claimWorkspaceIdentity("/repo/", "seed");
  assert.ok(identity);
  assert.ok(store.upsertWorkspaceBinding({
    ...identity,
    target: { chatId: 7, threadId: 42 },
    threadName: "Atlas",
    updatedAtMs: 1,
  }, "seed"));
  assert.equal(store.releaseWorkspaceClaim("seed"), false);
  assert.equal(store.hasWorkspaceBinding("/repo"), true);

  assert.equal(
    store.claimWorkspaceIdentity("/repo", "restore", undefined, {
      existingBindingOnly: true,
    })?.bindingKey,
    identity.bindingKey,
  );
  assert.equal(
    store.claimWorkspaceIdentity("/repo", "other", undefined, {
      existingBindingOnly: true,
    }),
    undefined,
  );
  assert.equal(store.listWorkspaceBindings().length, 1);

  const legacyStore = createTelegramTopicTargetStore({
    path: "/unused/legacy-state.json",
  });
  legacyStore.upsert({
    profileKey: "cwd:/legacy",
    owner: {
      kind: "leader",
      instanceId: "legacy",
      cwd: "/legacy",
    },
    target: { chatId: 7, threadId: 43 },
    status: "active",
    createdAtMs: 1,
    updatedAtMs: 1,
    instanceId: "legacy",
    threadName: "Beacon",
  });
  assert.ok(
    legacyStore.claimWorkspaceIdentity("/legacy", "restore", undefined, {
      existingBindingOnly: true,
    }),
  );
  assert.deepEqual(
    legacyStore.getWorkspaceBinding("/legacy")?.target,
    { chatId: 7, threadId: 43 },
  );
});

test("Session claim treats the legacy cwd-only binding as a distinct identity", () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  const legacy = { ...createTelegramWorkspaceBindingIdentity("/repo")!,
    target: { chatId: 7, threadId: 41 }, slot: "C", threadName: "Cedar",
    updatedAtMs: 1 };
  store.upsertWorkspaceBinding(legacy);
  assert.equal(store.hasWorkspaceBinding("/repo"), true);
  assert.equal(store.hasWorkspaceBinding("/repo", "session-a"), false);
  assert.equal(store.hasWorkspaceBinding("/repo", " bad-session "), false);
  assert.equal(store.claimWorkspaceIdentity("/repo", "resume", undefined, {
    existingBindingOnly: true, sessionId: "session-a",
  }), undefined);
  const session = store.claimWorkspaceIdentity("/repo", "resume", undefined, {
    sessionId: "session-a",
  });
  assert.ok(session);
  assert.notEqual(session.slot, "C");
  assert.notEqual(session.bindingKey, legacy.bindingKey);
  assert.equal(store.getWorkspaceBinding("/repo")?.target.threadId, 41);
});

test("Legacy and session bindings coexist across reload and stale snapshot persistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-session-adoption-reload-"));
  const path = join(dir, "state.json");
  try {
    const seed = createTelegramTopicTargetStore({ path });
    const legacy = { ...createTelegramWorkspaceBindingIdentity("/repo")!,
      target: { chatId: 7, threadId: 41 }, slot: "C", threadName: "Cedar",
      updatedAtMs: 1 };
    seed.upsertWorkspaceBinding(legacy);
    await seed.persist();

    const stale = createTelegramTopicTargetStore({ path });
    const adopter = createTelegramTopicTargetStore({ path });
    await stale.load();
    await adopter.load();
    const identity = adopter.claimWorkspaceIdentity("/repo", "resume", undefined,
      { sessionId: "session-a" })!;
    assert.ok(adopter.upsertWorkspaceBinding({ ...identity,
      target: { chatId: 7, threadId: 42 }, updatedAtMs: 2 }, "resume"));
    await adopter.persist();

    stale.setStatusSnapshot({ runtime: { busRole: "follower" } });
    await stale.persist();
    const reopened = createTelegramTopicTargetStore({ path });
    await reopened.load();
    assert.equal(reopened.listWorkspaceBindings().length, 2);
    assert.equal(reopened.getWorkspaceBinding("/repo")?.slot, "C");
    assert.equal(reopened.getWorkspaceBinding(
      "/repo", identity.instanceSlot, "session-a")?.target.threadId, 42);
    assert.equal(reopened.claimWorkspaceIdentity("/repo", "same", undefined, {
      existingBindingOnly: true, sessionId: "session-a",
    })?.slot, identity.slot);
    assert.equal(reopened.claimWorkspaceIdentity("/repo", "other", undefined, {
      existingBindingOnly: true, sessionId: "session-b",
    }), undefined);
    const fresh = reopened.claimWorkspaceIdentity("/repo", "other", undefined,
      { sessionId: "session-b" });
    assert.ok(fresh);
    assert.notEqual(fresh.slot, "C");
    assert.notEqual(fresh.bindingKey, identity.bindingKey);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Explicit same-cwd claims skip a live leader binding without migrating its target", () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  const leaderIdentity = store.claimWorkspaceIdentity("/repo", "leader");
  assert.ok(leaderIdentity);
  store.upsertWorkspaceBinding({
    ...leaderIdentity,
    target: { chatId: 7, threadId: 41 },
    threadName: "Atlas",
    slot: "A",
    updatedAtMs: 1,
  }, "leader");
  store.upsert({
    profileKey: "cwd:/repo",
    owner: { kind: "leader", cwd: "/repo", instanceId: "leader" },
    instanceId: "leader",
    target: { chatId: 7, threadId: 41 },
    status: "active",
    createdAtMs: 1,
    updatedAtMs: 1,
    threadName: "Atlas",
    slot: "A",
  });
  assert.equal(store.claimWorkspaceIdentity("/repo", "startup", undefined, {
    existingBindingOnly: true,
  }), undefined);
  const follower = store.claimWorkspaceIdentity("/repo/", "follower");
  assert.equal(follower?.instanceSlot, "b");
  assert.equal(store.getWorkspaceBinding("/repo", "b"), undefined);
  assert.equal(store.claimWorkspaceIdentity("/repo", "another")?.instanceSlot, "c");
  assert.equal(store.listWorkspaceBindings().length, 1);
  assert.equal(store.getByProfileKey("cwd:/repo")?.instanceId, "leader");
  assert.equal(store.getWorkspaceBinding("/repo")?.target.threadId, 41);
});

test("Retained Workspace admission fences reserve slots across allocation paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-fence-slots-"));
  try {
    const admission = createTelegramWorkspaceAdmissionLedger({
      path: join(dir, "admission.json"),
      profileKey: "default",
      owner: {
        processId: process.pid,
        processBirthId: `${process.pid}:slot-fence-test`,
      },
      getProcessLiveness: () => "alive",
    });
    const fence = admission.acquireRetirementFence({
      operationId: "slot-fence",
      retirementIntentId: "slot-intent",
      bindingKey: "slot-binding",
      slot: "A",
      target: { chatId: 7, threadId: 42 },
      leaderEpoch: 1,
      retirementRequestedAtMs: 1,
    });
    assert.equal(fence.kind, "acquired");
    const store = createTelegramTopicTargetStore({
      path: join(dir, "state.json"),
      getExternalReservedSlots: admission.listReservedSlots,
    });
    assert.equal(store.allocateSlot("manual:new"), "B");
    assert.equal(store.claimWorkspaceIdentity("/repo", "claim")?.slot, "B");
    const occupancy = store.captureWorkspaceSlotOccupancy(() => ({
      liveOwner: "clear",
      acceptedWork: "clear",
      deliveryAuthority: "clear",
    }));
    assert.equal(occupancy.reservedSlots.includes("a"), true);
    store.releaseWorkspaceClaim("claim");
    if (fence.kind === "acquired") {
      assert.equal(admission.releaseUnissuedRetirementFence(fence.fence), true);
    }
    assert.equal(store.allocateSlot("manual:new"), "A");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Unverifiable external slot reservations fail allocation closed", () => {
  for (const getExternalReservedSlots of [
    () => ["a"],
    () => {
      throw new Error("admission ledger unavailable");
    },
  ]) {
    let capacityUnavailable = false;
    const store = createTelegramTopicTargetStore({
      path: "/unused/state.json",
      getExternalReservedSlots,
    });
    assert.equal(store.allocateSlot("manual:new"), undefined);
    assert.equal(store.claimWorkspaceIdentity("/repo", "claim", undefined, {
      onCapacityUnavailable() {
        capacityUnavailable = true;
      },
    }), undefined);
    assert.equal(capacityUnavailable, true);
    assert.equal(
      store.captureWorkspaceSlotOccupancy(() => ({
        liveOwner: "clear",
        acceptedWork: "clear",
        deliveryAuthority: "clear",
      })).reservedSlots.includes("invalid"),
      true,
    );
  }
});

test("Generic allocation cannot reuse a transient Workspace claim slot", () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  assert.equal(store.claimWorkspaceIdentity("/claimed", "claim-owner")?.slot, "A");
  assert.equal(store.allocateSlot("manual:other"), "B");
  store.releaseWorkspaceClaim("claim-owner");
  assert.equal(store.allocateSlot("manual:other"), "A");
});

test("Workspace claims preserve live bindings and disambiguate readable-key collisions", () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  const first = store.claimWorkspaceIdentity("/repo/a-b", "instance-a");
  const colliding = store.claimWorkspaceIdentity("/repo/a/b", "instance-b");
  assert.ok(first);
  assert.ok(colliding);
  assert.notEqual(colliding.workspaceKey, first.workspaceKey);
  assert.match(colliding.workspaceKey, /-[a-f0-9]{12}--$/u);
  assert.ok(
    store.upsertWorkspaceBinding({
      ...first,
      target: { chatId: 7, threadId: 42 },
      threadName: "Ember",
      updatedAtMs: 1,
    }, "instance-a"),
  );
  store.upsert({
    profileKey: "manual:instance-a",
    owner: { kind: "manual-follower", instanceId: "instance-a" },
    target: { chatId: 7, threadId: 42 },
    status: "active",
    createdAtMs: 1,
    updatedAtMs: 1,
    instanceId: "instance-a",
  });
  assert.equal(
    store.claimWorkspaceIdentity("/repo/a-b", "instance-c")?.instanceSlot,
    "b",
  );
});

test("Workspace claims migrate legacy cwd and concurrent manual bindings", () => {
  const store = createTelegramTopicTargetStore({
    path: "/unused/state.json",
    getNowMs: () => 2000,
  });
  store.upsert({
    profileKey: "cwd:/repo",
    owner: { kind: "leader", cwd: "/repo", instanceId: "leader-old" },
    target: { chatId: 7, threadId: 41 },
    status: "active",
    createdAtMs: 1,
    updatedAtMs: 1000,
    instanceId: "leader-old",
    threadName: "Atlas",
    slot: "A",
  });
  const leaderIdentity = store.claimWorkspaceIdentity(
    "/repo/",
    "leader-new",
    "leader-old",
  );
  assert.equal(leaderIdentity?.instanceSlot, "a");
  assert.deepEqual(store.getWorkspaceBinding("/repo"), {
    ...leaderIdentity,
    target: { chatId: 7, threadId: 41 },
    threadName: "Atlas",
    slot: "A",
    updatedAtMs: 2000,
  });
  assert.ok(
    leaderIdentity &&
      store.upsertWorkspaceBinding(
        {
          ...leaderIdentity,
          target: { chatId: 7, threadId: 41 },
          threadName: "Atlas",
          slot: "A",
          updatedAtMs: 2001,
        },
        "leader-new",
      ),
  );

  store.upsert({
    profileKey: "manual:worker-old",
    owner: { kind: "manual-follower", instanceId: "worker-profile" },
    target: { chatId: 7, threadId: 42 },
    status: "active",
    createdAtMs: 1,
    updatedAtMs: 1001,
    instanceId: "worker-old",
    threadName: "Cedar",
    slot: "C",
  });
  const followerIdentity = store.claimWorkspaceIdentity(
    "/repo",
    "worker-new",
    "worker-old",
  );
  assert.equal(followerIdentity?.instanceSlot, "b");
  assert.deepEqual(store.getWorkspaceBinding("/repo", "b"), {
    ...followerIdentity,
    showSlotSuffix: true,
    target: { chatId: 7, threadId: 42 },
    threadName: "Cedar",
    slot: "C",
    updatedAtMs: 2000,
  });
});

test("Workspace binding commit is fenced by its exact transient claim", () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  const identity = store.claimWorkspaceIdentity("/repo", "instance-a");
  assert.ok(identity);
  const binding = {
    ...identity,
    target: { chatId: 7, threadId: 42 },
    updatedAtMs: 1,
  };
  assert.equal(
    store.upsertWorkspaceBinding(binding, "instance-b"),
    undefined,
  );
  assert.equal(store.releaseWorkspaceClaim("instance-a"), true);
  assert.equal(
    store.upsertWorkspaceBinding(binding, "instance-a"),
    undefined,
  );
  assert.deepEqual(
    store.claimWorkspaceIdentity("/repo", "instance-a"),
    identity,
  );
  assert.ok(store.upsertWorkspaceBinding(binding, "instance-a"));
  assert.equal(store.releaseWorkspaceClaim("instance-a"), false);
});

test("Thread store persists explicit owner target mappings privately", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-threads-"));
  const path = join(dir, "telegram-targets.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    store.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: -1001, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      threadName: "repo",
      instanceId: "inst-a",
      rerouteConfirmedAtMs: 1500,
    });
    await store.persist();

    if (process.platform !== "win32") {
      const mode = (await stat(path)).mode & 0o777;
      assert.equal(mode, 0o600);
    }

    const reloaded = createTelegramTopicTargetStore({ path });
    await reloaded.load();
    const file = JSON.parse(await readFile(path, "utf8")) as {
      source?: string;
      writtenAtMs?: number;
      bot: Record<string, unknown>;
      threads: Array<Record<string, unknown>>;
      records?: Array<Record<string, unknown>>;
    };
    assert.equal(file.source, "snapshot");
    assert.equal(typeof file.writtenAtMs, "number");
    assert.deepEqual(file.bot, { threadMode: "unknown" });
    assert.equal(file.records, undefined);
    assert.equal(file.threads[0]?.profileKey, undefined);
    assert.deepEqual(file.threads[0]?.owner, { kind: "leader", cwd: "/repo" });
    assert.deepEqual(reloaded.getByProfileKey("cwd:/repo"), {
      profileKey: "cwd:/repo",
      owner: { kind: "leader", cwd: "/repo", instanceId: undefined },
      target: { chatId: -1001, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      threadName: "repo",
      instanceId: "inst-a",
      slot: undefined,
      rerouteConfirmedAtMs: 1500,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread store persists status snapshot sections separately from threads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-state-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    store.setStatusSnapshot({
      runtime: { busRole: "leader", instanceSlot: "B" },
      liveRoster: { busFollowers: [], reservations: [{ slot: "A" }] },
      diagnostics: {
        pendingDispatch: false,
        threadReconciliation: {
          phase: "provisioning",
          event: "pending-provision",
          atMs: 1000,
          pendingProvisionCount: 1,
          syncActionCount: 0,
          cleanupActionCount: 0,
        },
      },
    });
    await store.persist();
    await store.persistStatus();

    const canonical = JSON.parse(await readFile(path, "utf8"));
    assert.equal("runtime" in canonical || "liveRoster" in canonical || "diagnostics" in canonical, false,
      "projections never enter canonical state");
    const file = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
    assert.deepEqual(file.runtime, {
      busRole: "leader",
      instanceSlot: "B",
    });
    assert.deepEqual(file.liveRoster, {
      busFollowers: [],
      reservations: [{ slot: "A" }],
    });
    assert.deepEqual(file.diagnostics, {
      pendingDispatch: false,
      threadReconciliation: {
        phase: "provisioning",
        event: "pending-provision",
        atMs: 1000,
        pendingProvisionCount: 1,
        syncActionCount: 0,
        cleanupActionCount: 0,
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread store status snapshot persist preserves unloaded thread records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-state-"));
  const path = join(dir, "state.json");
  try {
    const seeded = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 1000,
    });
    seeded.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 7, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
    });
    seeded.reserveThread({
      target: { chatId: 7, threadId: 41 },
      slot: "B",
      reason: "previous-process-still-probes-alive",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      expiresAtMs: 10_000,
    });
    await seeded.persist();

    const statusOnly = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 2000,
    });
    statusOnly.setStatusSnapshot({
      runtime: { busRole: "leader", instanceSlot: "C" },
    });
    const canonicalBytes = await readFile(path, "utf8");
    await statusOnly.persistStatus();
    assert.equal(await readFile(path, "utf8"), canonicalBytes, "a status write never rewrites canonical state");

    const reloaded = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 2000,
    });
    await reloaded.load();
    assert.equal(reloaded.getByProfileKey("cwd:/repo")?.target.threadId, 42);
    assert.deepEqual(
      reloaded.listReservations().map((reservation) => reservation.slot),
      ["B"],
    );
    const file = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
    assert.deepEqual(file.runtime, { busRole: "leader", instanceSlot: "C" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread store stale status writer refreshes current bindings before persist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-state-"));
  const path = join(dir, "state.json");
  try {
    const leader = createTelegramTopicTargetStore({ path });
    leader.upsert({
      profileKey: "cwd:/leader",
      target: { chatId: 7, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
    });
    await leader.persist();

    const staleStatusWriter = createTelegramTopicTargetStore({ path });
    await staleStatusWriter.load();
    leader.upsert({
      profileKey: "manual:follower-b",
      owner: { kind: "manual-follower", instanceId: "follower-b" },
      target: { chatId: 7, threadId: 43 },
      status: "active",
      createdAtMs: 1100,
      updatedAtMs: 1100,
      instanceId: "follower-b",
      slot: "B",
    });
    await leader.persist();

    staleStatusWriter.setStatusSnapshot({
      runtime: { busRole: "follower", instanceSlot: "A" },
    });
    await staleStatusWriter.persistStatus();

    const reloaded = createTelegramTopicTargetStore({ path });
    await reloaded.load();
    assert.equal(
      reloaded.getByProfileKey("manual:follower-b")?.target.threadId,
      43,
    );
    const file = JSON.parse(await readFile(join(dir, "status.json"), "utf8"));
    assert.deepEqual(file.runtime, {
      busRole: "follower",
      instanceSlot: "A",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread store denies follower writes until transport ownership promotes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-state-"));
  const path = join(dir, "state.json");
  try {
    const leader = createTelegramTopicTargetStore({ path });
    leader.upsert({
      profileKey: "cwd:/leader",
      target: { chatId: 7, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
    });
    await leader.persist();

    let ownsTransport = false;
    const follower = createTelegramTopicTargetStore({
      path,
      canPersist: () => ownsTransport,
    });
    await follower.load();
    follower.upsert({
      profileKey: "manual:follower-e",
      owner: { kind: "manual-follower", instanceId: "follower-e" },
      target: { chatId: 7, threadId: 45 },
      status: "active",
      createdAtMs: 1100,
      updatedAtMs: 1100,
      instanceId: "follower-e",
      slot: "E",
    });
    await follower.persist();

    let reloaded = createTelegramTopicTargetStore({ path });
    await reloaded.load();
    assert.equal(reloaded.getByProfileKey("manual:follower-e"), undefined);
    assert.equal(follower.getByProfileKey("manual:follower-e"), undefined);

    ownsTransport = true;
    follower.upsert({
      profileKey: "manual:follower-c",
      owner: { kind: "manual-follower", instanceId: "follower-c" },
      target: { chatId: 7, threadId: 44 },
      status: "active",
      createdAtMs: 1200,
      updatedAtMs: 1200,
      instanceId: "follower-c",
      slot: "C",
    });
    await follower.persist();

    reloaded = createTelegramTopicTargetStore({ path });
    await reloaded.load();
    assert.equal(
      reloaded.getByProfileKey("manual:follower-c")?.target.threadId,
      44,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread store snapshot commit is fenced by exact transport ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-state-fence-"));
  const path = join(dir, "state.json");
  const ownersPath = join(dir, "owners.json");
  try {
    const owner = createTelegramLockRuntime({
      locksPath: ownersPath,
      instanceId: "leader:first",
    });
    const acquired = owner.acquire({ cwd: "/repo" });
    assert.equal(acquired.ok, true);
    const store = createTelegramTopicTargetStore({
      path,
      canPersist: () => true,
      commitPersist: (commit) => owner.commitIfOwned(commit),
    });
    store.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 7, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader:first",
      slot: "A",
    });
    await store.persist();

    store.upsert({
      profileKey: "manual:follower-b",
      target: { chatId: 7, threadId: 43 },
      status: "active",
      createdAtMs: 1100,
      updatedAtMs: 1100,
      instanceId: "follower-b",
      slot: "B",
    });
    const replacement = createTelegramLockRuntime({
      locksPath: ownersPath,
      instanceId: "leader:replacement",
    });
    const replaced = replacement.acquire(
      { cwd: "/repo" },
      {
        force: true,
        expectedOwner: acquired.ok ? acquired.lock : undefined,
      },
    );
    assert.equal(replaced.ok, true);
    await assert.rejects(
      store.persist(),
      /lost exact transport ownership before commit/,
    );

    const reloaded = createTelegramTopicTargetStore({ path });
    await reloaded.load();
    assert.equal(reloaded.getByProfileKey("cwd:/repo")?.target.threadId, 42);
    assert.equal(reloaded.getByProfileKey("manual:follower-b"), undefined);
    assert.equal(store.getByProfileKey("manual:follower-b"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread store skips semantically unchanged state snapshots", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-state-semantic-"));
  const path = join(dir, "state.json");
  const mkdirSpy = t.mock.method(fsPromises, "mkdir");
  syncBuiltinESMExports();
  try {
    let nowMs = 1000;
    const store = createTelegramTopicTargetStore({
      path,
      getNowMs: () => nowMs,
    });
    store.setBotState({ threadMode: "enabled" });
    await store.persist();
    const initial = await readFile(path, "utf8");
    assert.equal(mkdirSpy.mock.callCount(), 1);
    nowMs = 2000;
    await store.persist();
    assert.equal(mkdirSpy.mock.callCount(), 1);
    assert.equal(await readFile(path, "utf8"), initial);
    store.setStatusSnapshot({ diagnostics: { recentEvents: 1 } });
    await store.persist();
    assert.equal(await readFile(path, "utf8"), initial, "diagnostics never rewrite canonical state");
    await store.persistStatus();
    const diagnostic = await readFile(join(dir, "status.json"), "utf8");
    assert.equal(JSON.parse(diagnostic).writtenAtMs, 2000);
    assert.equal(await readFile(path, "utf8"), initial);
    nowMs = 3000;
    store.setStatusSnapshot({ diagnostics: { recentEvents: 1 } });
    await store.persistStatus();
    assert.equal(await readFile(join(dir, "status.json"), "utf8"), diagnostic);
    assert.equal(mkdirSpy.mock.callCount(), 2);
  } finally {
    mkdirSpy.mock.restore();
    syncBuiltinESMExports();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Status projection writes follow transport ownership and a corrupt projection never blocks loading", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-status-owner-"));
  const path = join(dir, "state.json");
  try {
    let owns = false;
    const store = createTelegramTopicTargetStore({ path, canPersist: () => owns });
    store.setStatusSnapshot({ runtime: { busRole: "follower" } });
    await store.persistStatus();
    await assert.rejects(readFile(join(dir, "status.json"), "utf8"), /ENOENT/, "a store without transport ownership writes no projection");
    owns = true;
    await store.persistStatus();
    if (process.platform !== "win32") assert.equal((await stat(join(dir, "status.json"))).mode & 0o777, 0o600);
    await writeFile(join(dir, "status.json"), "{ not json");
    const reloaded = createTelegramTopicTargetStore({ path });
    await reloaded.load();
    assert.deepEqual(reloaded.list(), [], "recovery hints are optional and never canonical");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Snapshot equality ignores object key order but preserves array order and JSON values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-state-order-"));
  const path = join(dir, "state.json");
  try {
    let nowMs = 1000;
    const store = createTelegramTopicTargetStore({ path, getNowMs: () => nowMs });
    const identity = store.claimWorkspaceIdentity("/repo", "instance-a")!;
    const target = { chatId: 7, threadId: 42 };
    store.upsertWorkspaceBinding({ ...identity, target, updatedAtMs: 1000 }, "instance-a");
    store.upsert({ profileKey: "manual:instance-a", instanceId: "instance-a", slot: "A",
      target, status: "active", createdAtMs: 1000, updatedAtMs: 1000 });
    await store.persist();
    const initial = await readFile(path, "utf8");
    nowMs++;
    await store.persist();
    assert.equal(await readFile(path, "utf8"), initial, "Reload-only key ordering must not rewrite the file");
    const statusPath = join(dir, "status.json");
    store.setStatusSnapshot({ diagnostics: { payload: { first: 1, last: 2 }, list: ["a", "b"] } });
    await store.persistStatus();
    const baseline = await readFile(statusPath, "utf8");
    nowMs++;
    store.setStatusSnapshot({ diagnostics: { list: ["a", "b"], payload: { last: 2, first: 1, omitted: undefined } } });
    await store.persistStatus();
    assert.equal(await readFile(statusPath, "utf8"), baseline, "Nested JSON object order and omitted undefined are equivalent");
    for (const diagnostics of [
      { list: ["b", "a"], payload: { first: 1, last: 2 } },
      { list: ["b", "a"], payload: { first: "1", last: 2 } },
      { list: ["b", "a"], payload: { first: "1", last: 2, added: null } },
    ]) {
      const before = await readFile(statusPath, "utf8");
      nowMs++;
      store.setStatusSnapshot({ diagnostics });
      await store.persistStatus();
      const after = await readFile(statusPath, "utf8");
      assert.notEqual(after, before, "Array order, value type, and explicit null remain meaningful");
      assert.deepEqual(JSON.parse(after).diagnostics, diagnostics);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread store load does not clobber unpersisted thread mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-state-"));
  const path = join(dir, "state.json");
  try {
    const seeded = createTelegramTopicTargetStore({ path });
    seeded.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 7, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
    });
    await seeded.persist();
    const store = createTelegramTopicTargetStore({ path });
    await store.load();
    store.upsert({
      profileKey: "manual:follower-b",
      owner: { kind: "manual-follower", instanceId: "follower-b" },
      target: { chatId: 7, threadId: 43 },
      status: "active",
      createdAtMs: 1100,
      updatedAtMs: 1100,
      instanceId: "follower-b",
      slot: "B",
    });
    await store.load();
    await store.persist();
    const reloaded = createTelegramTopicTargetStore({ path });
    await reloaded.load();
    assert.equal(reloaded.getByProfileKey("cwd:/repo")?.target.threadId, 42);
    assert.equal(
      reloaded.getByProfileKey("manual:follower-b")?.target.threadId,
      43,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread store refresh discards stale local projections for owner-published capability", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-state-"));
  const path = join(dir, "state.json");
  try {
    const owner = createTelegramTopicTargetStore({ path });
    owner.setBotState({ threadMode: "disabled", updatedAtMs: 1000 });
    await owner.persist();
    const observer = createTelegramTopicTargetStore({ path });
    await observer.load();
    observer.setStatusSnapshot({ diagnostics: { local: "stale" } });
    owner.setBotState({ threadMode: "enabled", updatedAtMs: 2000 });
    await owner.persist();

    assert.equal(observer.getBotState().threadMode, "disabled");
    assert.ok(observer.refresh);
    await observer.refresh();
    assert.equal(observer.getBotState().threadMode, "enabled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread store concurrent persists use unique temp files", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "pi-telegram-state-concurrent-persist-"),
  );
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    store.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: -1001, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      slot: "A",
    });
    await Promise.all([store.persist(), store.persist(), store.persist()]);
    const file = JSON.parse(await readFile(path, "utf8"));
    assert.equal(file.threads.length, 1);
    assert.equal(file.threads[0].target.threadId, 42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread store retains mutations that arrive during snapshot commit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-state-revision-"));
  const path = join(dir, "state.json");
  try {
    let injectMutation = true;
    let store: ReturnType<typeof createTelegramTopicTargetStore>;
    store = createTelegramTopicTargetStore({
      path,
      commitPersist(commit) {
        if (injectMutation) {
          injectMutation = false;
          store.upsert({
            profileKey: "manual:follower-b",
            target: { chatId: -1001, threadId: 43 },
            status: "active",
            createdAtMs: 1100,
            updatedAtMs: 1100,
            slot: "B",
          });
        }
        commit();
        return true;
      },
    });
    store.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: -1001, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      slot: "A",
    });
    await store.persist();
    let file = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(
      file.threads.map(
        (record: { target: { threadId: number } }) => record.target.threadId,
      ),
      [42],
    );
    assert.equal(
      store.getByProfileKey("manual:follower-b")?.target.threadId,
      43,
    );

    await store.persist();
    file = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(
      file.threads
        .map(
          (record: { target: { threadId: number } }) => record.target.threadId,
        )
        .sort(),
      [42, 43],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread store persists bot-wide capability state separately from threads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-state-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    store.setBotState({
      threadMode: "disabled",
      updatedAtMs: 1234,
      lastReconcileAction: "thread-mode-unavailable",
    });
    await store.persist();
    const reloaded = createTelegramTopicTargetStore({ path });
    await reloaded.load();
    assert.deepEqual(reloaded.getBotState(), {
      threadMode: "disabled",
      updatedAtMs: 1234,
      lastReconcileAction: "thread-mode-unavailable",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread store migrates legacy displayName fields to threadName on load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-state-"));
  const path = join(dir, "state.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        writtenAtMs: 1000,
        bot: { threadMode: "enabled" },
        threads: [
          {
            profileKey: "cwd:/repo",
            owner: { kind: "leader", cwd: "/repo", instanceId: "inst-a" },
            target: { chatId: 7, threadId: 11 },
            status: "active",
            createdAtMs: 1000,
            updatedAtMs: 1000,
            displayName: "Cedar",
            slot: "C",
            instanceId: "inst-a",
          },
        ],
        identities: [
          {
            profileKey: "cwd:/repo",
            displayName: "Cedar",
            slot: "C",
            updatedAtMs: 1000,
          },
        ],
      }),
    );

    const store = createTelegramTopicTargetStore({ path });
    await store.load();
    assert.equal(store.getByProfileKey("cwd:/repo")?.threadName, "Cedar");
    assert.equal(
      store.getIdentityByProfileKey("cwd:/repo")?.threadName,
      "Cedar",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread store returns defensive copies and prunes offline/stale observations", () => {
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 2000,
  });
  const record = store.upsert({
    profileKey: "cwd:/repo",
    target: { chatId: -1001, threadId: 42 },
    status: "active",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    instanceId: "inst-a",
  });
  record.target.threadId = 99;
  assert.deepEqual(store.getByProfileKey("cwd:/repo")?.target, {
    chatId: -1001,
    threadId: 42,
  });
  assert.equal(
    store.renameByTarget({ chatId: -1001, threadId: 42 }, "  Blue   Unit  ")
      ?.manualThreadName,
    "Blue Unit",
  );
  assert.equal(store.getByProfileKey("cwd:/repo")?.manualThreadName, "Blue Unit");
  assert.equal(store.markOfflineByInstanceId("inst-a"), 1);
  assert.equal(store.getByProfileKey("cwd:/repo"), undefined);
  store.upsert({
    profileKey: "cwd:/repo",
    target: { chatId: -1001, threadId: 42 },
    status: "active",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    instanceId: "inst-a",
  });
  assert.equal(
    store.markStaleByTarget({ chatId: -1001, threadId: 42 }, "closed"),
    true,
  );
  assert.equal(store.getByProfileKey("cwd:/repo"), undefined);
  assert.deepEqual(store.listSyncObservations(), [
    {
      target: { chatId: -1001, threadId: 42 },
      syncStatus: "closed",
      observedAtMs: 2000,
      instanceId: "inst-a",
      lastReconcileAction: "mark-stale",
    },
  ]);
  assert.equal(
    store.markActiveByTarget({ chatId: -1001, threadId: 42 }),
    false,
  );
});

test("Thread slot allocator preserves existing slots on reuse", () => {
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
  });
  store.upsert({
    profileKey: "cwd:/a",
    target: { chatId: -1001, threadId: 1 },
    status: "active",
    createdAtMs: 1,
    updatedAtMs: 1,
    threadName: "a",
    slot: "C",
  });
  assert.equal(store.allocateSlot("cwd:/a"), "C");
  assert.equal(store.allocateSlot("cwd:/new"), "D");
  store.upsert({
    profileKey: "cwd:/b",
    target: { chatId: -1001, threadId: 2 },
    status: "active",
    createdAtMs: 1,
    updatedAtMs: 1,
    threadName: "b",
    slot: "A",
  });
  assert.equal(store.allocateSlot("cwd:/new"), "B");
  store.markStaleByTarget({ chatId: -1001, threadId: 1 });
  assert.equal(store.allocateSlot("cwd:/existing-stale"), "B");
});

test("Thread slot allocator follows the latest fresh slot around the ring", () => {
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
  });
  store.upsert({
    profileKey: "cwd:/old",
    target: { chatId: -1001, threadId: 1 },
    status: "active",
    createdAtMs: 1,
    updatedAtMs: 1,
    slot: "W",
  });
  store.markStaleByTarget({ chatId: -1001, threadId: 1 });
  store.upsert({
    profileKey: "cwd:/other",
    target: { chatId: -1001, threadId: 2 },
    status: "active",
    createdAtMs: 1,
    updatedAtMs: 1,
    slot: "U",
  });
  assert.equal(store.allocateSlot("cwd:/new"), "V");
});

test("Thread slot allocator starts from the cursor instead of higher live slots", () => {
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
  });
  store.setBotState({ lastSlot: "D" });
  store.upsert({
    profileKey: "manual:historical-i",
    target: { chatId: -1001, threadId: 9 },
    status: "active",
    createdAtMs: 1,
    updatedAtMs: 1,
    slot: "I",
  });
  store.setBotState({ lastSlot: "D" });
  assert.equal(store.allocateSlot("manual:new"), "E");
});

test("Thread slot allocator treats unexpired reservations as occupied", () => {
  const store = createTelegramTopicTargetStore({
    path: join(tmpdir(), "unused-state.json"),
    getNowMs: () => 1000,
  });
  store.reserveThread({
    target: { chatId: 1, threadId: 2 },
    slot: "A",
    reason: "test",
    createdAtMs: 900,
    updatedAtMs: 900,
    expiresAtMs: 2000,
  });
  assert.equal(store.allocateSlot("cwd:/repo"), "B");
});

test("Thread slot allocator treats live pending provisions as occupied", () => {
  const store = createTelegramTopicTargetStore({
    path: join(tmpdir(), "unused-state.json"),
    getNowMs: () => 1000,
  });
  store.upsertPendingProvision({
    id: "pending-a",
    owner: "manual-follower",
    instanceId: "inst-a",
    slot: "A",
    startedAtMs: 900,
    expiresAtMs: 2000,
  });
  assert.equal(store.allocateSlot("cwd:/repo"), "B");
});

test("Thread store persists and prunes pending provisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-pending-provisions-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 1000,
    });
    store.upsertPendingProvision({
      id: "pending-a",
      owner: "leader",
      instanceId: "leader-a",
      slot: "A",
      target: { chatId: 7, threadId: 42 },
      startedAtMs: 900,
      expiresAtMs: 2000,
      leaderEpoch: 1000,
    });
    await store.persist();

    const reloaded = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 1500,
    });
    await reloaded.load();
    assert.deepEqual(reloaded.listPendingProvisions(), [
      {
        id: "pending-a",
        owner: "leader",
        instanceId: "leader-a",
        slot: "A",
        target: { chatId: 7, threadId: 42 },
        startedAtMs: 900,
        expiresAtMs: 2000,
        leaderEpoch: 1000,
      },
    ]);
    assert.equal(reloaded.removePendingProvision("pending-a"), true);
    assert.deepEqual(reloaded.listPendingProvisions(), []);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Thread store persists exact graceful cleanup intents until confirmation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-pending-cleanups-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({ path, getNowMs: () => 1000 });
    store.upsertPendingCleanup({
      id: "cleanup:leader-a:runtime-1:7:42",
      owner: "leader",
      instanceId: "leader-a",
      runtimeGeneration: "runtime-1",
      profileKey: "leader:leader-a",
      target: { chatId: 7, threadId: 42 },
      requestedAtMs: 900,
    });
    await store.persist();

    const reloaded = createTelegramTopicTargetStore({ path });
    await reloaded.load();
    assert.deepEqual(reloaded.listPendingCleanups(), [
      {
        id: "cleanup:leader-a:runtime-1:7:42",
        owner: "leader",
        instanceId: "leader-a",
        runtimeGeneration: "runtime-1",
        profileKey: "leader:leader-a",
        target: { chatId: 7, threadId: 42 },
        requestedAtMs: 900,
      },
    ]);
    assert.equal(
      reloaded.removePendingCleanup("cleanup:leader-a:runtime-1:7:42"),
      true,
    );
    await reloaded.persist();

    const confirmed = createTelegramTopicTargetStore({ path });
    await confirmed.load();
    assert.deepEqual(confirmed.listPendingCleanups(), []);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Thread store retains expired targeted pending provisions for reconciler cleanup", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "pi-telegram-expired-pending-provisions-"),
  );
  const path = join(dir, "state.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        source: "snapshot",
        writtenAtMs: 1000,
        bot: { threadMode: "enabled" },
        threads: [],
        pendingProvisions: [
          {
            id: "expired-targeted",
            owner: "leader",
            instanceId: "leader-a",
            slot: "A",
            target: { chatId: 7, threadId: 42 },
            startedAtMs: 1000,
            expiresAtMs: 1500,
          },
          {
            id: "expired-untargeted",
            owner: "leader",
            instanceId: "leader-a",
            slot: "B",
            startedAtMs: 1000,
            expiresAtMs: 1500,
          },
        ],
      }),
    );
    const store = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 2000,
    });
    await store.load();
    assert.deepEqual(store.listPendingProvisions(), [
      {
        id: "expired-targeted",
        owner: "leader",
        instanceId: "leader-a",
        slot: "A",
        target: { chatId: 7, threadId: 42 },
        startedAtMs: 1000,
        expiresAtMs: 1500,
      },
    ]);
    assert.equal(store.allocateSlot("manual:new"), "A");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Thread slot allocator continues after persisted last slot when no threads remain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-thread-slot-cursor-"));
  const path = join(dir, "telegram-targets.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        source: "snapshot",
        writtenAtMs: 1000,
        bot: { threadMode: "enabled", lastSlot: "H" },
        threads: [],
      }),
    );
    const store = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 2000,
    });
    await store.load();
    assert.equal(store.allocateSlot("manual:new"), "I");
    store.upsert({
      profileKey: "manual:new",
      target: { chatId: 7, threadId: 9 },
      status: "active",
      createdAtMs: 2000,
      updatedAtMs: 2000,
      slot: "I",
    });
    store.markStaleByTarget({ chatId: 7, threadId: 9 });
    store.upsert({
      profileKey: "manual:wrap-z",
      target: { chatId: 7, threadId: 26 },
      status: "active",
      createdAtMs: 2100,
      updatedAtMs: 2100,
      slot: "Z",
    });
    store.markStaleByTarget({ chatId: 7, threadId: 26 });
    assert.equal(store.allocateSlot("manual:wrap-a"), "A");
    store.upsert({
      profileKey: "manual:wrap-a",
      target: { chatId: 7, threadId: 27 },
      status: "active",
      createdAtMs: 2200,
      updatedAtMs: 2200,
      slot: "A",
    });
    store.markStaleByTarget({ chatId: 7, threadId: 27 });
    assert.equal(store.allocateSlot("manual:wrap-b"), "B");
    await store.persist();
    const file = JSON.parse(await readFile(path, "utf8"));
    assert.equal(file.bot.lastSlot, "A");
    assert.deepEqual(file.threads, []);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Thread slot allocator ignores expired reservations", () => {
  const store = createTelegramTopicTargetStore({
    path: join(tmpdir(), "unused-state.json"),
    getNowMs: () => 3000,
  });
  store.reserveThread({
    target: { chatId: 1, threadId: 2 },
    slot: "A",
    reason: "test",
    createdAtMs: 900,
    updatedAtMs: 900,
    expiresAtMs: 2000,
  });

  assert.equal(store.allocateSlot("cwd:/repo"), "A");
  assert.deepEqual(store.listReservations(), []);
});

test("Thread store prunes expired reservations on load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-reservations-"));
  const path = join(dir, "state.json");
  try {
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        source: "snapshot",
        writtenAtMs: 1000,
        bot: { threadMode: "enabled" },
        threads: [],
        reservations: [
          {
            target: { chatId: 1, threadId: 2 },
            slot: "A",
            reason: "expired",
            createdAtMs: 1000,
            updatedAtMs: 1000,
            expiresAtMs: 2000,
          },
          {
            target: { chatId: 1, threadId: 3 },
            slot: "B",
            reason: "live",
            createdAtMs: 1000,
            updatedAtMs: 1000,
            expiresAtMs: 4000,
          },
        ],
      })}\n`,
    );
    const store = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 3000,
    });
    await store.load();
    assert.deepEqual(
      store.listReservations().map((reservation) => reservation.slot),
      ["B"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread slot allocator returns undefined when all slots are occupied", () => {
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
  });
  for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
    const slot = String.fromCharCode(code);
    store.upsert({
      profileKey: `cwd:${slot}`,
      target: { chatId: -1001, threadId: code },
      status: "active",
      createdAtMs: 1,
      updatedAtMs: 1,
      threadName: slot,
      slot,
    });
  }
  assert.equal(store.allocateSlot("cwd:/new"), undefined);
});

test("Thread store enforces one active target per live instance", () => {
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 3000,
  });
  store.upsert({
    profileKey: "topic:1:10",
    target: { chatId: 1, threadId: 10 },
    status: "active",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    instanceId: "inst-a",
    slot: "A",
  });
  store.upsert({
    profileKey: "topic:1:11",
    target: { chatId: 1, threadId: 11 },
    status: "active",
    createdAtMs: 2000,
    updatedAtMs: 2000,
    instanceId: "inst-a",
    slot: "B",
  });

  assert.equal(store.getByProfileKey("topic:1:10"), undefined);
  assert.equal(store.getByProfileKey("topic:1:11")?.status, "active");
  assert.equal(store.getByProfileKey("topic:1:11")?.instanceId, "inst-a");
});

function createGuardedThreadRenameFixture() {
  const store = createTelegramTopicTargetStore({ path: "/unused/rename-state.json", getNowMs: () => 3 });
  const target = { chatId: 7, threadId: 41 };
  for (const [sessionId, threadId, slot, threadName] of [["first", 41, "A", "Anchor"], ["second", 42, "B", "Beacon"]] as const) {
    store.upsert({ profileKey: sessionId, target: { chatId: 7, threadId }, instanceId: sessionId, slot,
      threadName, status: "active", createdAtMs: 1, updatedAtMs: 1 });
    store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/repo", 0, sessionId)!,
      target: { chatId: 7, threadId }, slot, threadName, displayTitle: threadName, updatedAtMs: 1 });
  }
  return { store, target, request: { target, threadName: "Navigator", slot: "A" },
    snapshot: () => ({ records: store.list(), bindings: store.listWorkspaceBindings(), provisions: store.listPendingProvisions() }) };
}

for (const boundary of ["entry", "response", "local-publication", "no-display"] as const) {
  test(`Guarded Thread rename refuses lost authority at ${boundary}`, async () => {
    const f = createGuardedThreadRenameFixture(), before = f.snapshot();
    let current = boundary !== "entry", edits = 0, publications = 0;
    const renameByTarget = f.store.renameByTarget;
    f.store.renameByTarget = (...args) => {
      publications++; const result = renameByTarget(...args);
      if (boundary === "local-publication") current = false;
      return result;
    };
    const rename = createTelegramTopicTargetRenamer({ store: f.store,
      assertAuthority() { if (!current) throw new Error("Rename recipient revoked"); },
      shouldRenameDisplayedTitle() { if (boundary === "no-display") current = false; return boundary !== "no-display"; },
      async callApi<TResponse>() { edits++; if (boundary === "response") current = false; return true as TResponse; },
    });
    await assert.rejects(rename(f.request), /Rename recipient revoked/);
    assert.equal(edits, boundary === "entry" || boundary === "no-display" ? 0 : 1);
    assert.equal(publications, boundary === "local-publication" ? 1 : 0);
    if (boundary !== "local-publication") assert.deepEqual(f.snapshot(), before);
    else assert.equal(f.store.getByProfileKey("first")?.manualThreadName, "Navigator", "Issued local publication is not rolled back after result loss");
    assert.deepEqual(f.store.getByProfileKey("second"), before.records.find(record => record.instanceId === "second"));
  });
}

test("Guarded Thread rename captures target, adapters and title policy across held API", async () => {
  const f = createGuardedThreadRenameFixture(), held = Promise.withResolvers<void>();
  const second = f.store.getWorkspaceBinding("/repo", "b", "second"), calls: unknown[] = [];
  let checks = 0;
  const guard = () => { checks++; };
  const deps = { store: f.store, assertAuthority: guard, topicNameTemplate: "Pi {threadName}",
    shouldRenameDisplayedTitle: () => true,
    async callApi<TResponse>(method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions) {
      calls.push({ method, body }); assert.equal(options?.assertAuthority, guard); await held.promise; return true as TResponse;
    },
  };
  const rename = createTelegramTopicTargetRenamer(deps), run = rename(f.request);
  f.request.target.threadId = 42; f.request.threadName = "Wrong"; f.request.slot = "B";
  deps.store = createTelegramTopicTargetStore({ path: "/unused/replacement.json" });
  deps.callApi = async () => assert.fail("Cannot replace captured API");
  deps.assertAuthority = () => assert.fail("Cannot replace captured authority");
  deps.shouldRenameDisplayedTitle = () => false; deps.topicNameTemplate = "Wrong";
  f.store.renameByTarget = () => assert.fail("Cannot replace captured local publication port");
  held.resolve();
  assert.equal((await run)?.manualThreadName, "Navigator");
  assert.deepEqual(calls, [{ method: "editForumTopic", body: { chat_id: 7, message_thread_id: 41, name: "Pi Navigator" } }]);
  assert.equal(f.store.getByProfileKey("first")?.manualThreadName, "Navigator");
  assert.deepEqual(f.store.getWorkspaceBinding("/repo", "b", "second"), second);
  assert.ok(checks >= 3);
});

for (const boundary of ["current", "entry", "response", "parsing", "retry-wait"] as const) {
  test(`Guarded Thread rename composes store/direct/client at ${boundary}`, async () => {
    const f = createGuardedThreadRenameFixture(), before = f.snapshot();
    const originalFetch = globalThis.fetch, family = process.env.PI_TELEGRAM_NETWORK_FAMILY;
    delete process.env.PI_TELEGRAM_NETWORK_FAMILY;
    const requests: unknown[] = [], diagnostics: unknown[] = [];
    let current = boundary !== "entry", sleeps = 0;
    const guard = () => { if (!current) throw new Error("Rename recipient revoked"); };
    globalThis.fetch = async (input, init) => {
      assert.ok(String(input).endsWith("/editForumTopic")); requests.push(JSON.parse(String(init?.body)));
      if (boundary === "response") current = false;
      if (boundary === "retry-wait") return new Response(JSON.stringify({ ok: false, description: "Too Many Requests" }), { status: 429 });
      const response = new Response(JSON.stringify({ ok: true, result: true }));
      if (boundary === "parsing") response.text = async () => { current = false; return JSON.stringify({ ok: true, result: true }); };
      return response;
    };
    const client = createTelegramApiClient(() => "123:fixture");
    const direct = createTelegramBridgeApiRuntime({ client: { ...client,
      call(method, body, options) {
        assert.equal(options?.assertAuthority, guard);
        return client.call(method, body, { ...options, sleep: async () => { sleeps++; current = false; } });
      } }, tempDir: "/unused", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1,
      recordRuntimeEvent(_category, error) { diagnostics.push(error); },
    });
    try {
      const run = createTelegramTopicTargetRenamer({ store: f.store, assertAuthority: guard, callApi: direct.call })(f.request);
      if (boundary === "current") assert.equal((await run)?.manualThreadName, "Navigator");
      else if (boundary === "entry") await assert.rejects(run, /Rename recipient revoked/);
      else await assert.rejects(run, { name: "TelegramApiAuthorityError", requestIssued: true });
      assert.deepEqual(requests, boundary === "entry" ? [] : [{ chat_id: 7, message_thread_id: 41, name: "Navigator" }]);
      if (boundary !== "current") assert.deepEqual(f.snapshot(), before);
      assert.equal(sleeps, boundary === "retry-wait" ? 1 : 0);
      assert.equal(diagnostics.length, boundary === "current" || boundary === "entry" ? 0 : 1);
      assert.deepEqual(f.store.getByProfileKey("second"), before.records.find(record => record.instanceId === "second"));
    } finally {
      globalThis.fetch = originalFetch;
      if (family === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY; else process.env.PI_TELEGRAM_NETWORK_FAMILY = family;
    }
  });
}

test("Thread renamer edits the Telegram topic and persists a manual override", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 3000,
  });
  store.upsert({
    profileKey: "cwd:/repo",
    target: { chatId: -1001, threadId: 42 },
    status: "active",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    threadName: "OldName",
  });
  const workspaceIdentity = createTelegramWorkspaceBindingIdentity("/repo");
  assert.ok(workspaceIdentity);
  store.upsertWorkspaceBinding({
    ...workspaceIdentity,
    target: { chatId: -1001, threadId: 42 },
    threadName: "OldName",
    updatedAtMs: 1000,
  });
  const rename = createTelegramTopicTargetRenamer({
    store,
    topicNameTemplate: "Pi {threadName}",
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return {} as TResponse;
    },
  });

  const record = await rename({
    target: { chatId: -1001, threadId: 42 },
    threadName: "  BlueUnit  ",
  });

  assert.equal(record?.threadName, "OldName");
  assert.equal(record?.manualThreadName, "BlueUnit");
  assert.equal(record?.updatedAtMs, 3000);
  assert.equal(store.getWorkspaceBinding("/repo")?.threadName, "OldName");
  assert.equal(store.getWorkspaceBinding("/repo")?.manualThreadName, "BlueUnit");
  assert.deepEqual(calls, [
    {
      method: "editForumTopic",
      body: {
        chat_id: -1001,
        message_thread_id: 42,
        name: "Pi BlueUnit",
      },
    },
  ]);
  const reset = store.clearManualNameByTarget(
    { chatId: -1001, threadId: 42 },
    "A",
  );
  assert.equal(reset?.manualThreadName, undefined);
  assert.equal(reset?.threadName, "OldName");
  assert.equal(store.getWorkspaceBinding("/repo")?.manualThreadName, undefined);
  assert.equal(store.getWorkspaceBinding("/repo")?.displayTitle, "A");
});

test("Workspace rename preserves non-named display titles and fences a concurrent mode switch", async () => {
  for (const mode of ["letters", "directories", "names", "switching"]) {
    const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
    const identity = createTelegramWorkspaceBindingIdentity("/repo")!;
    const target = { chatId: 7, threadId: 42 };
    store.upsert({ profileKey: "cwd:/repo", target, instanceId: "leader", slot: "A",
      threadName: "Anchor", status: "active", createdAtMs: 1, updatedAtMs: 1 });
    store.upsertWorkspaceBinding({ ...identity, target, slot: "A", threadName: "Anchor",
      displayTitle: mode === "letters" ? "A" : mode === "directories" ? "repo_a" : "Anchor", updatedAtMs: 1 });
    const previousTitle = store.getWorkspaceBinding("/repo")?.displayTitle;
    let displayName = mode === "names" || mode === "switching";
    let edits = 0;
    const rename = createTelegramTopicTargetRenamer({
      store, shouldRenameDisplayedTitle: () => displayName,
      async callApi<TResponse>() { edits++; if (mode === "switching") displayName = false; return true as TResponse; },
    });
    const run = rename({ target, threadName: "Navigator", slot: "A" });
    if (mode === "switching") {
      await assert.rejects(run, /display mode changed/);
      assert.equal(store.getWorkspaceBinding("/repo")?.threadName, "Anchor");
    } else {
      assert.equal((await run)?.manualThreadName, "Navigator");
      assert.equal(store.getWorkspaceBinding("/repo")?.displayTitle,
        mode === "names" ? "Navigator" : previousTitle);
      assert.equal(edits, mode === "names" ? 1 : 0);
    }
  }
});

test("Workspace rename cannot cross same-cwd session identity", async () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  const first = createTelegramWorkspaceBindingIdentity("/repo", 0, "session-a")!;
  const second = createTelegramWorkspaceBindingIdentity("/repo", 0, "session-b")!;
  const firstTarget = { chatId: 7, threadId: 41 };
  store.upsert({ profileKey: "session-a", target: firstTarget,
    instanceId: "leader", slot: "A", threadName: "Atlas", status: "active",
    createdAtMs: 1, updatedAtMs: 1 });
  store.upsertWorkspaceBinding({ ...first, target: firstTarget, slot: "A",
    threadName: "Atlas", updatedAtMs: 1 });
  store.upsertWorkspaceBinding({ ...second, target: { chatId: 7, threadId: 42 },
    slot: "B", threadName: "Beacon", updatedAtMs: 1 });
  const rename = createTelegramTopicTargetRenamer({
    store,
    shouldRenameDisplayedTitle: () => true,
    async callApi<TResponse>() { return true as TResponse; },
  });
  assert.equal((await rename({ target: firstTarget,
    threadName: "Arrow", slot: "A" }))?.manualThreadName, "Arrow");
  assert.equal(store.getWorkspaceBinding(
    "/repo", "a", "session-a")?.manualThreadName, "Arrow");
  assert.equal(store.getWorkspaceBinding(
    "/repo", "a", "session-b")?.manualThreadName, undefined);
  assert.equal(store.getWorkspaceBinding(
    "/repo", "a", "session-b")?.threadName, "Beacon");
});

test("Workspace target replacement preserves its manual Thread display name", () => {
  const store = createTelegramTopicTargetStore({ path: "/unused/state.json" });
  const identity = createTelegramWorkspaceBindingIdentity("/repo")!;
  store.upsertWorkspaceBinding({
    ...identity,
    target: { chatId: 7, threadId: 41 },
    slot: "A",
    threadName: "Anchor",
    manualThreadName: "wasd_123!?+$@",
    displayTitle: "wasd_123!?+$@",
    updatedAtMs: 1,
  });
  store.upsertWorkspaceBinding({
    ...identity,
    target: { chatId: 7, threadId: 42 },
    slot: "A",
    threadName: "Anchor",
    updatedAtMs: 2,
  });
  const replaced = store.getWorkspaceBinding("/repo");
  assert.deepEqual(replaced?.target, { chatId: 7, threadId: 42 });
  assert.equal(replaced?.manualThreadName, "wasd_123!?+$@");
  assert.equal(replaced?.displayTitle, undefined);
});

test("Thread renamer rejects a name reserved by another Workspace", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
  });
  store.upsert({
    profileKey: "cwd:/repo-a",
    target: { chatId: 7, threadId: 42 },
    status: "active",
    createdAtMs: 1,
    updatedAtMs: 1,
    threadName: "Atlas",
  });
  const workspaceIdentity = createTelegramWorkspaceBindingIdentity("/repo-b");
  assert.ok(workspaceIdentity);
  store.upsertWorkspaceBinding({
    ...workspaceIdentity,
    target: { chatId: 7, threadId: 43 },
    threadName: "Cedar",
    updatedAtMs: 1,
  });
  const rename = createTelegramTopicTargetRenamer({
    store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return {} as TResponse;
    },
  });

  assert.equal(
    await rename({
      target: { chatId: 7, threadId: 42 },
      threadName: "Cedar",
    }),
    undefined,
  );
  assert.deepEqual(calls, []);
  assert.equal(store.getByProfileKey("cwd:/repo-a")?.threadName, "Atlas");
});

test("Thread renamer reserves bare slot letters for automatic reset", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 3000,
  });
  store.upsert({
    profileKey: "cwd:/repo",
    target: { chatId: -1001, threadId: 42 },
    status: "active",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    threadName: "OldName",
    slot: "D",
  });
  const rename = createTelegramTopicTargetRenamer({
    store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return {} as TResponse;
    },
  });

  assert.equal(
    await rename({
      target: { chatId: -1001, threadId: 42 },
      threadName: "D",
      slot: "D",
    }),
    undefined,
  );
  assert.equal(calls.length, 0);
  const renamed = await rename({
    target: { chatId: -1001, threadId: 42 },
    threadName: "Follower",
    slot: "F",
  });
  assert.equal(renamed?.manualThreadName, "Follower");
  assert.equal(calls.length, 1);
  assert.equal(store.getByProfileKey("cwd:/repo")?.threadName, "OldName");
});

test("Thread store preserves thread identity after stale target pruning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-identity-"));
  const path = join(dir, "state.json");
  const calls: unknown[] = [];
  try {
    const store = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 3000,
    });
    store.upsert({
      profileKey: "cwd:/repo",
      owner: { kind: "leader", cwd: "/repo", instanceId: "leader-a" },
      target: { chatId: -1001, threadId: 42 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      threadName: "Axial",
      instanceId: "leader-a",
      slot: "A",
    });
    store.markStaleByTarget(
      { chatId: -1001, threadId: 42 },
      "deleted",
      "manual close",
    );
    await store.persist();

    const reloaded = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 4000,
    });
    await reloaded.load();
    assert.equal(reloaded.getByProfileKey("cwd:/repo"), undefined);
    assert.deepEqual(reloaded.getIdentityByProfileKey("cwd:/repo"), {
      profileKey: "cwd:/repo",
      threadName: "Axial",
      slot: "A",
      updatedAtMs: 1000,
    });
    const provision = createTelegramTopicTargetProvisioner({
      topicChatId: -1001,
      store: reloaded,
      getNowMs: () => 4000,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return { message_thread_id: 77 } as TResponse;
      },
    });

    const result = await provision({
      instanceId: "leader-b",
      owner: { kind: "leader", cwd: "/repo", instanceId: "leader-b" },
      profileKey: "cwd:/repo",
    });
    assert.equal(result.record.threadName, "Axial");
    assert.equal(result.record.slot, "A");
    assert.deepEqual(calls, [
      {
        method: "createForumTopic",
        body: { chat_id: -1001, name: "Axial" },
      },
    ]);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Thread provisioner does not reuse offline target history by profile key", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 1000,
  });
  store.upsert({
    profileKey: "cwd:/repo",
    target: { chatId: -1001, threadId: 42 },
    status: "offline",
    createdAtMs: 500,
    updatedAtMs: 500,
    threadName: "old",
  });

  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: -1001,
    store,
    getNowMs: () => 2000,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { message_thread_id: 99 } as TResponse;
    },
  });

  const result = await provision({
    instanceId: "inst-b",
    profileKey: "cwd:/repo",
    threadName: "repo",
  });

  assert.equal(result.reused, false);
  assert.deepEqual(result.target, { chatId: -1001, threadId: 99 });
  assert.deepEqual(calls, [
    {
      method: "createForumTopic",
      body: { chat_id: -1001, name: "Atlas" },
    },
  ]);
  assert.equal(store.getByProfileKey("cwd:/repo")?.status, "active");
  assert.equal(store.getByProfileKey("cwd:/repo")?.instanceId, "inst-b");
  assert.equal(store.getByProfileKey("cwd:/repo")?.threadName, "Atlas");
});

test("Thread provisioner restores an active manual follower profile across runtime replacement", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 1000,
  });
  store.upsert({
    profileKey: "manual:1234",
    owner: { kind: "manual-follower", instanceId: "1234" },
    target: { chatId: -1001, threadId: 42 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "1234:old",
    slot: "C",
  });

  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: -1001,
    store,
    getNowMs: () => 2000,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { message_thread_id: 99 } as TResponse;
    },
  });

  const result = await provision({
    instanceId: "1234:new",
    owner: { kind: "manual-follower", instanceId: "1234" },
    profileKey: "manual:1234",
  });

  assert.equal(result.reused, true);
  assert.deepEqual(result.target, { chatId: -1001, threadId: 42 });
  assert.equal(result.record.instanceId, "1234:new");
  assert.equal(result.record.slot, "C");
  assert.deepEqual(calls, []);
});

test("Thread provisioner allocates a fresh follower slot after stale identity is forgotten", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 1000,
  });
  store.upsert({
    profileKey: "manual:1234",
    owner: { kind: "manual-follower", instanceId: "1234" },
    target: { chatId: -1001, threadId: 42 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "1234:old",
    slot: "T",
    threadName: "Talon",
  });
  store.markStaleByTarget({ chatId: -1001, threadId: 42 });
  store.forgetIdentityByProfileKey("manual:1234");

  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: -1001,
    store,
    getNowMs: () => 2000,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { message_thread_id: 99 } as TResponse;
    },
  });

  const result = await provision({
    instanceId: "1234:new",
    owner: { kind: "manual-follower", instanceId: "1234" },
    profileKey: "manual:1234",
  });

  assert.equal(result.reused, false);
  assert.deepEqual(result.target, { chatId: -1001, threadId: 99 });
  assert.equal(result.record.slot, "U");
  assert.notEqual(result.record.threadName, "Talon");
  assert.deepEqual(calls, [
    { method: "createForumTopic", body: { chat_id: -1001, name: "Umber" } },
  ]);
});

test("Thread provisioner restores a named manual follower across runtime replacement", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 1000,
  });
  store.upsert({
    profileKey: "manual:1234",
    owner: { kind: "manual-follower", instanceId: "1234" },
    target: { chatId: -1001, threadId: 42 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "1234:old",
    slot: "T",
    threadName: "Talon",
  });

  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: -1001,
    store,
    getNowMs: () => 2000,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { message_thread_id: 99 } as TResponse;
    },
  });

  const result = await provision({
    instanceId: "1234:new",
    owner: { kind: "manual-follower", instanceId: "1234" },
    profileKey: "manual:1234",
  });

  assert.equal(result.reused, true);
  assert.deepEqual(result.target, { chatId: -1001, threadId: 42 });
  assert.equal(result.record.slot, "T");
  assert.equal(result.record.threadName, "Talon");
  assert.equal(store.getByProfileKey("manual:1234")?.target.threadId, 42);
  assert.deepEqual(calls, []);
});

test("Thread provisioner reuses the same-runtime active manual follower target", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 1000,
  });
  store.upsert({
    profileKey: "manual:1234",
    owner: { kind: "manual-follower", instanceId: "1234" },
    target: { chatId: -1001, threadId: 42 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "1234:same",
    slot: "T",
    threadName: "Talon",
  });

  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: -1001,
    store,
    getNowMs: () => 2000,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { message_thread_id: 99 } as TResponse;
    },
  });

  const result = await provision({
    instanceId: "1234:same",
    owner: { kind: "manual-follower", instanceId: "1234" },
    profileKey: "manual:1234",
  });

  assert.equal(result.reused, true);
  assert.deepEqual(result.target, { chatId: -1001, threadId: 42 });
  assert.equal(result.record.slot, "T");
  assert.equal(result.record.threadName, "Talon");
  assert.deepEqual(calls, []);
});

test("Thread provisioner persists pending provision while creating a fresh topic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-provision-pending-"));
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 2000,
    });
    const provision = createTelegramTopicTargetProvisioner({
      topicChatId: -1001,
      store,
      getNowMs: () => 2000,
      getCurrentLeaderEpoch: () => 2000,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        assert.equal(method, "createForumTopic");
        assert.deepEqual(body, { chat_id: -1001, name: "Atlas" });
        assert.deepEqual(store.listPendingProvisions(), [
          {
            id: "provision:inst-a:A:2000",
            owner: "manual-follower",
            instanceId: "inst-a",
            profileKey: "manual:inst-a",
            threadName: "Atlas",
            slot: "A",
            startedAtMs: 2000,
            leaderEpoch: 2000,
          },
        ]);
        const file = JSON.parse(await readFile(path, "utf8"));
        assert.equal(file.pendingProvisions?.[0]?.slot, "A");
        return { message_thread_id: 77 } as TResponse;
      },
    });

    const result = await provision({
      instanceId: "inst-a",
      profileKey: "manual:inst-a",
    });
    assert.equal(result.reused, false);
    assert.equal(result.record.status, "active");
    assert.deepEqual(store.listPendingProvisions(), []);
    const file = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(file.pendingProvisions, []);
    assert.equal(file.threads?.[0]?.target.threadId, 77);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Thread provisioner preserves ambiguous creation intent and blocks successor duplication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-provision-ambiguous-"));
  const path = join(dir, "state.json");
  let nowMs = 2000;
  try {
    const store = createTelegramTopicTargetStore({
      path,
      getNowMs: () => nowMs,
    });
    let apiCalls = 0;
    const provision = createTelegramTopicTargetProvisioner({
      topicChatId: -1001,
      store,
      getNowMs: () => nowMs,
      async callApi() {
        apiCalls += 1;
        throw new TelegramApiCommitUnknownError(
          "createForumTopic",
          new Error("response lost"),
        );
      },
    });

    await assert.rejects(
      () => provision({ instanceId: "inst-a", profileKey: "manual:inst-a" }),
      isTelegramApiCommitUnknownError,
    );
    assert.deepEqual(store.listPendingProvisions(), [
      {
        id: "provision:inst-a:A:2000",
        owner: "manual-follower",
        instanceId: "inst-a",
        profileKey: "manual:inst-a",
        status: "ambiguous",
        threadName: "Atlas",
        slot: "A",
        startedAtMs: 2000,
      },
    ]);

    nowMs = 902001;
    const successor = createTelegramTopicTargetProvisioner({
      topicChatId: -1001,
      store,
      getNowMs: () => nowMs,
      async callApi<TResponse>() {
        apiCalls += 1;
        return { message_thread_id: 99 } as TResponse;
      },
    });
    await assert.rejects(
      () =>
        successor({
          instanceId: "replacement-inst",
          profileKey: "manual:inst-a",
        }),
      /remains ambiguous/,
    );
    assert.equal(apiCalls, 1);
    const file = JSON.parse(await readFile(path, "utf8"));
    assert.equal(file.pendingProvisions?.[0]?.status, "ambiguous");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Thread provisioner treats a malformed successful create as commit-unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-provision-malformed-"));
  try {
    const store = createTelegramTopicTargetStore({
      path: join(dir, "state.json"),
      getNowMs: () => 2000,
    });
    const provision = createTelegramTopicTargetProvisioner({
      topicChatId: -1001,
      store,
      getNowMs: () => 2000,
      async callApi<TResponse>() {
        return {} as TResponse;
      },
    });

    await assert.rejects(
      () => provision({ instanceId: "inst-a", profileKey: "manual:inst-a" }),
      isTelegramApiCommitUnknownError,
    );
    assert.equal(store.listPendingProvisions()[0]?.status, "ambiguous");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Thread provisioner fails closed before mutation without leader ownership", async () => {
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets-no-owner.json",
    getNowMs: () => 2000,
  });
  let apiCalls = 0;
  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: -1001,
    store,
    getCurrentLeaderEpoch: () => undefined,
    async callApi<TResponse>() {
      apiCalls += 1;
      return { message_thread_id: 77 } as TResponse;
    },
  });

  await assert.rejects(
    provision({ instanceId: "inst-a", profileKey: "manual:inst-a" }),
    /lost leader ownership \(start\)/,
  );
  assert.equal(apiCalls, 0);
  assert.deepEqual(store.listPendingProvisions(), []);
});

test("Thread provisioner preserves its intent and stops binding after create loses ownership", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "pi-telegram-provision-epoch-loss-"),
  );
  const path = join(dir, "state.json");
  let currentEpoch: number | undefined = 1;
  try {
    const store = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 2000,
    });
    const provision = createTelegramTopicTargetProvisioner({
      topicChatId: -1001,
      store,
      getNowMs: () => 2000,
      getCurrentLeaderEpoch: () => currentEpoch,
      async callApi<TResponse>() {
        currentEpoch = undefined;
        return { message_thread_id: 77 } as TResponse;
      },
    });

    await assert.rejects(
      provision({ instanceId: "inst-a", profileKey: "manual:inst-a" }),
      /lost leader ownership/,
    );
    assert.deepEqual(store.list(), []);
    assert.deepEqual(store.listPendingProvisions(), [
      {
        id: "provision:inst-a:A:2000",
        owner: "manual-follower",
        instanceId: "inst-a",
        profileKey: "manual:inst-a",
        status: "ambiguous",
        threadName: "Atlas",
        slot: "A",
        target: { chatId: -1001, threadId: 77 },
        startedAtMs: 2000,
        leaderEpoch: 1,
      },
    ]);
    const file = JSON.parse(await readFile(path, "utf8"));
    assert.equal(file.pendingProvisions?.[0]?.leaderEpoch, 1);
    assert.deepEqual(file.threads, []);

    currentEpoch = 2;
    const successorStore = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 3000,
    });
    await successorStore.load();
    let successorApiCalls = 0;
    const successor = createTelegramTopicTargetProvisioner({
      topicChatId: -1001,
      store: successorStore,
      getNowMs: () => 3000,
      getCurrentLeaderEpoch: () => currentEpoch,
      async callApi<TResponse>() {
        successorApiCalls += 1;
        return { message_thread_id: 99 } as TResponse;
      },
    });
    const recovered = await successor({
      instanceId: "replacement-inst",
      profileKey: "manual:inst-a",
    });
    assert.equal(recovered.reused, true);
    assert.deepEqual(recovered.target, { chatId: -1001, threadId: 77 });
    assert.equal(successorApiCalls, 0);
    assert.deepEqual(successorStore.listPendingProvisions(), []);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Post-create recovery preserves the acknowledged title with or without a starting record", async () => {
  for (const failStatus of ["starting", "active"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "pi-telegram-provision-post-create-fail-"));
    const path = join(dir, "state.json");
    try {
      const store = createTelegramTopicTargetStore({ path, getNowMs: () => 2000 });
      const identity = store.claimWorkspaceIdentity("/repo/extensions", "inst-a")!;
      const request = { instanceId: "inst-a", profileKey: "manual:inst-a",
        workspaceBindingKey: identity.bindingKey, workspaceCwd: identity.cwd };
      let creations = 0;
      const provision = createTelegramTopicTargetProvisioner({
        topicChatId: -1001, getNowMs: () => 2000,
        store: { ...store, upsert(record) {
          if (record.status === failStatus) throw new Error("binding persist failed");
          return store.upsert(record);
        } },
        resolveInitialWorkspaceDisplayTitle: () => "extensions",
        async callApi<TResponse>(method: string, body: Record<string, unknown>) {
          assert.equal(method, "createForumTopic");
          assert.equal(body.name, "extensions");
          creations++;
          return { message_thread_id: 88 } as TResponse;
        },
      });
      await assert.rejects(provision(request), /binding persist failed/);
      const restored = createTelegramTopicTargetStore({ path, getNowMs: () => 3000 });
      await restored.load();
      assert.deepEqual(restored.listPendingProvisions(), [{
        id: "provision:inst-a:A:2000", owner: "manual-follower", instanceId: "inst-a",
        profileKey: "manual:inst-a", workspaceBindingKey: identity.bindingKey,
        threadName: "Atlas", displayTitle: "extensions",
        slot: "A", target: { chatId: -1001, threadId: 88 }, startedAtMs: 2000,
      }]);
      const recover = createTelegramTopicTargetProvisioner({
        topicChatId: -1001, store: restored, getNowMs: () => 3000,
        resolveInitialWorkspaceDisplayTitle() { throw new Error("must not reproject an acknowledged title"); },
        async callApi() { throw new Error("must not recreate the acknowledged target"); },
      });
      await assert.rejects(recover({ ...request, instanceId: "successor",
        workspaceBindingKey: createTelegramWorkspaceBindingIdentity(identity.cwd, 0, "other-session")!.bindingKey,
      }), /unfinished Thread creation does not match this session/);
      assert.equal(restored.listPendingProvisions().length, 1, "Foreign resume never consumes creation evidence");
      const recovered = await recover(request);
      assert.equal(recovered.reused, true);
      assert.equal(recovered.displayTitle, "extensions", failStatus);
      assert.equal(recovered.record.threadName, "Atlas");
      assert.deepEqual(recovered.target, { chatId: -1001, threadId: 88 });
      assert.equal(restored.listPendingProvisions().length, 1,
        "Creation evidence remains until the exact Workspace commit");
      await store.load();
      const committed = commitTelegramWorkspaceProvisionBinding({
        store, instanceId: request.instanceId, profileKey: request.profileKey,
        binding: { ...identity, target: recovered.target, slot: recovered.record.slot,
          threadName: recovered.record.threadName, updatedAtMs: 3000 },
      });
      assert.equal(committed.displayTitle, "extensions");
      assert.deepEqual(store.listPendingProvisions(), []);
      assert.equal(JSON.parse(await readFile(path, "utf8")).pendingProvisions.length, 1,
        "The caller still owns durable settlement");
      await store.persist();
      const settled = createTelegramTopicTargetStore({ path });
      await settled.load();
      assert.equal(settled.getWorkspaceBinding(identity.cwd)?.displayTitle, "extensions");
      assert.deepEqual(settled.listPendingProvisions(), []);
      assert.equal(creations, 1);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }
});

test("Deleted creation evidence cannot resurrect a pending target, while closed and cleanup targets stay protected", async () => {
  for (const scenario of ["active-deleted", "pending-deleted", "legacy-deleted", "closed", "cleanup"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "pi-telegram-pending-invalidation-"));
    try {
      const store = createTelegramTopicTargetStore({ path: join(dir, "state.json"), getNowMs: () => 2000 });
      const identity = store.claimWorkspaceIdentity("/repo/extensions", "inst-a")!;
      const request = { instanceId: "inst-a", profileKey: "manual:inst-a",
        workspaceBindingKey: identity.bindingKey, workspaceCwd: identity.cwd };
      let creations = 0;
      const provision = createTelegramTopicTargetProvisioner({
        topicChatId: 7, store: { ...store, upsert(record) {
          if (scenario === "pending-deleted" && creations === 1) throw new Error("post-create failure");
          return store.upsert(record);
        } },
        getNowMs: () => 2000, resolveInitialWorkspaceDisplayTitle: () => "extensions",
        async callApi<TResponse>() { return { message_thread_id: 41 + ++creations } as TResponse; },
      });
      if (scenario === "pending-deleted") await assert.rejects(provision(request), /post-create failure/);
      else await provision(request);
      const retained = store.listPendingProvisions()[0]!;
      assert.equal(store.markStaleByTarget({ chatId: 8, threadId: 42 }, "deleted"), false);
      assert.equal(store.listPendingProvisions().length, 1);
      if (scenario === "cleanup") {
        store.upsertPendingCleanup({ id: "cleanup", owner: "manual-follower", instanceId: "inst-a",
          profileKey: request.profileKey, target: { chatId: 7, threadId: 42 },
          runtimeGeneration: "inst-a:1", requestedAtMs: 2000 });
      } else {
        assert.equal(store.markStaleByTarget({ chatId: 7, threadId: 42 },
          scenario === "closed" ? "closed" : "deleted"), true);
        if (scenario === "legacy-deleted") store.upsertPendingProvision(retained);
      }
      await store.persist();
      if (scenario === "closed" || scenario === "cleanup") {
        assert.throws(() => commitTelegramWorkspaceProvisionBinding({
          store, instanceId: request.instanceId, profileKey: request.profileKey,
          binding: { ...identity, target: { chatId: 7, threadId: 42 }, updatedAtMs: 2000 },
          displayTitle: "extensions",
        }), /requires reconciliation/);
        assert.equal(store.getWorkspaceBinding(identity.cwd), undefined);
        assert.deepEqual(store.listPendingProvisions(), [retained]);
        await assert.rejects(provision(request), /requires reconciliation/);
        assert.deepEqual(store.listPendingProvisions(), [retained]);
        assert.equal(creations, 1);
      } else {
        const replacement = await provision(request);
        assert.equal(replacement.reused, false);
        assert.deepEqual(replacement.target, { chatId: 7, threadId: 43 });
        assert.equal(replacement.displayTitle, "extensions");
        assert.equal(creations, 2);
        assert.equal(store.listPendingProvisions().some((entry) => entry.target?.threadId === 42), false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("Thread provisioner creates forum topics without retrying non-idempotent requests", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 1000,
  });
  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: -1001,
    store,
    getNowMs: () => 2000,
    async callApi<TResponse>(
      method: string,
      body: Record<string, unknown>,
      options?: unknown,
    ) {
      calls.push({ method, body, options });
      return { message_thread_id: 77 } as TResponse;
    },
  });

  await provision({
    instanceId: "instance-a",
    profileKey: "manual:instance-a",
  });

  assert.deepEqual(calls, [
    {
      method: "createForumTopic",
      body: { chat_id: -1001, name: "Atlas" },
      options: { maxAttempts: 1 },
    },
  ]);
});

test("Thread provisioner rejects slotless fresh targets at global capacity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-provision-capacity-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  for (const [index, slot] of Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ").entries()) {
    const identity = createTelegramWorkspaceBindingIdentity(`/retained/${index}`);
    assert.ok(identity);
    store.upsertWorkspaceBinding({
      ...identity,
      target: { chatId: 7, threadId: 100 + index },
      slot,
      updatedAtMs: index + 1,
    });
  }
  let apiCalls = 0;
  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: 7,
    store,
    async callApi<TResponse>() {
      apiCalls += 1;
      return { message_thread_id: 900 } as TResponse;
    },
  });
  try {
    await assert.rejects(provision({
      instanceId: "legacy-follower",
      owner: { kind: "manual-follower", instanceId: "legacy-follower" },
      profileKey: "manual:legacy-follower",
    }), /Telegram Workspace slot reservation is unavailable/u);
    assert.equal(apiCalls, 0);
    assert.equal(store.list().length, 0);
    assert.equal(store.listPendingProvisions().length, 0);
    assert.equal(store.listWorkspaceBindings().length, 26);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread provisioner skips names reserved by dormant Workspaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-workspace-name-"));
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const workspaceIdentity = createTelegramWorkspaceBindingIdentity("/repo/old");
  assert.ok(workspaceIdentity);
  store.upsertWorkspaceBinding({
    ...workspaceIdentity,
    target: { chatId: 7, threadId: 41 },
    threadName: "Cedar",
    slot: "C",
    updatedAtMs: 1,
  });
  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: 7,
    store,
    getNowMs: () => 2000,
    getRandom: () => 0,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { message_thread_id: 42 } as TResponse;
    },
  });
  try {
    const result = await provision({
      instanceId: "new",
      owner: { kind: "manual-follower", instanceId: "new" },
      profileKey: "manual:new",
      preferredSlot: "C",
    });
    assert.equal(result.record.slot, "A");
    assert.equal(result.record.threadName, "Atlas");
    assert.deepEqual(calls, [
      {
        method: "createForumTopic",
        body: { chat_id: 7, name: "Atlas" },
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Thread provisioner creates a new topic for new or stale profiles", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
  });
  store.upsert({
    profileKey: "cwd:/repo",
    target: { chatId: -1001, threadId: 42 },
    status: "stale",
    createdAtMs: 500,
    updatedAtMs: 1000,
  });

  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: -1001,
    store,
    getNowMs: () => 2000,
    topicNameTemplate: "Pi {threadName} {instanceId}",
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { message_thread_id: 77 } as TResponse;
    },
  });

  const result = await provision({
    instanceId: "inst-c",
    profileKey: "cwd:/repo",
    threadName: "repo",
  });

  assert.equal(result.reused, false);
  assert.deepEqual(result.target, { chatId: -1001, threadId: 77 });
  assert.deepEqual(calls, [
    {
      method: "createForumTopic",
      body: { chat_id: -1001, name: "Pi Atlas inst-c" },
    },
  ]);
  assert.deepEqual(store.getByProfileKey("cwd:/repo"), {
    profileKey: "cwd:/repo",
    owner: { kind: "leader", cwd: "/repo" },
    target: { chatId: -1001, threadId: 77 },
    status: "active",
    createdAtMs: 2000,
    updatedAtMs: 2000,
    threadName: "Atlas",
    instanceId: "inst-c",
    slot: "A",
  });
});

test("Thread provisioner reuses current instance target before claiming another topic", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 2000,
  });
  store.upsert({
    profileKey: "topic:1:41",
    target: { chatId: 1, threadId: 41 },
    status: "active",
    createdAtMs: 900,
    updatedAtMs: 900,
    instanceId: "inst-c",
    slot: "B",
  });
  store.upsert({
    profileKey: "topic:1:42",
    target: { chatId: 1, threadId: 42 },
    status: "pending",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    slot: "C",
  });
  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: 1,
    store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { message_thread_id: 77 } as TResponse;
    },
  });

  const result = await provision({
    instanceId: "inst-c",
    profileKey: "manual:inst-c",
  });

  assert.equal(result.reused, true);
  assert.deepEqual(result.target, { chatId: 1, threadId: 41 });
  assert.deepEqual(calls, []);
  assert.equal(store.getByProfileKey("topic:1:42")?.status, "pending");
});

test("Thread provisioner claims pending topic before creating a new one", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 2000,
  });
  store.upsert({
    profileKey: "topic:1:42",
    target: { chatId: 1, threadId: 42 },
    status: "pending",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    slot: "C",
  });
  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: 1,
    store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { message_thread_id: 77 } as TResponse;
    },
  });

  const result = await provision({
    instanceId: "inst-c",
    profileKey: "manual:inst-c",
  });

  assert.equal(result.reused, true);
  assert.deepEqual(result.target, { chatId: 1, threadId: 42 });
  assert.deepEqual(calls, []);
  assert.equal(store.getByProfileKey("topic:1:42")?.status, "active");
  assert.equal(store.getByProfileKey("topic:1:42")?.instanceId, "inst-c");
});

test("Thread provisioner ignores inactive history before creating a new one", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 2000,
  });
  store.upsert({
    profileKey: "cwd:/leader",
    target: { chatId: 1, threadId: 1 },
    status: "offline",
    createdAtMs: 500,
    updatedAtMs: 500,
    slot: "A",
  });
  store.upsert({
    profileKey: "topic:1:42",
    target: { chatId: 1, threadId: 42 },
    status: "offline",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    slot: "B",
  });
  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: 1,
    store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { message_thread_id: 77 } as TResponse;
    },
  });

  const result = await provision({
    instanceId: "inst-b",
    profileKey: "manual:inst-b",
    threadName: "Blue Beacon",
  });

  assert.equal(result.reused, false);
  assert.deepEqual(result.target, { chatId: 1, threadId: 77 });
  assert.deepEqual(calls, [
    { method: "createForumTopic", body: { chat_id: 1, name: "Atlas" } },
  ]);
  assert.equal(store.getByProfileKey("manual:inst-b")?.status, "active");
  assert.equal(store.getByProfileKey("manual:inst-b")?.instanceId, "inst-b");
  assert.equal(store.getByProfileKey("manual:inst-b")?.threadName, "Atlas");
  assert.equal(store.getByProfileKey("cwd:/leader"), undefined);
});

test("Thread provisioner does not claim inactive slot with a live owner", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 2000,
  });
  store.upsert({
    profileKey: "topic:1:42",
    target: { chatId: 1, threadId: 42 },
    status: "offline",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    slot: "B",
  });
  store.upsert({
    profileKey: "manual:live-b",
    target: { chatId: 1, threadId: 43 },
    status: "active",
    createdAtMs: 1100,
    updatedAtMs: 1100,
    instanceId: "live-b",
    slot: "B",
  });
  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: 1,
    store,
    getNowMs: () => 2000,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { message_thread_id: 77 } as TResponse;
    },
  });

  const result = await provision({
    instanceId: "inst-c",
    profileKey: "manual:inst-c",
  });

  assert.equal(result.reused, false);
  assert.deepEqual(result.target, { chatId: 1, threadId: 77 });
  assert.equal(store.getByProfileKey("topic:1:42"), undefined);
});

test("Thread provisioner assigns follower slot after active leader slot", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 1000,
  });
  store.upsert({
    profileKey: "cwd:/leader",
    owner: { kind: "leader", cwd: "/leader" },
    target: { chatId: -1001, threadId: 1 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "leader-a",
    slot: "A",
  });

  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: -1001,
    store,
    getNowMs: () => 2000,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { message_thread_id: 99 } as TResponse;
    },
  });

  const result = await provision({
    instanceId: "follower-b",
    owner: { kind: "manual-follower", instanceId: "follower-b" },
    profileKey: "manual:follower-b",
    threadName: "Follower",
  });

  assert.equal(result.record.slot, "B");
  assert.deepEqual(calls, [
    { method: "createForumTopic", body: { chat_id: -1001, name: "Beacon" } },
  ]);
});

test("Thread provisioner assigns monotonic slots to new topics", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 1000,
  });
  store.upsert({
    profileKey: "cwd:/a",
    target: { chatId: -1001, threadId: 1 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    threadName: "first",
    slot: "A",
  });

  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: -1001,
    store,
    getNowMs: () => 2000,
    topicNameTemplate: "{slot} {threadName}",
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { message_thread_id: 99 } as TResponse;
    },
  });

  const result = await provision({
    instanceId: "inst-b",
    profileKey: "cwd:/b",
    threadName: "second",
  });

  assert.equal(result.record.slot, "B");
  assert.deepEqual(calls, [
    {
      method: "createForumTopic",
      body: { chat_id: -1001, name: "B Beacon" },
    },
  ]);
  assert.equal(store.getByProfileKey("cwd:/b")?.slot, "B");
});

test("Thread provisioner assigns fresh baked names from visible thread-name sequence", async () => {
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-targets.json",
    getNowMs: () => 1000,
  });
  store.upsert({
    profileKey: "cwd:/leader",
    target: { chatId: -1001, threadId: 42 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    threadName: "Dune",
    slot: "E",
  });

  const provision = createTelegramTopicTargetProvisioner({
    topicChatId: -1001,
    store,
    getNowMs: () => 2000,
    getRandom: () => 0,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { message_thread_id: 99 } as TResponse;
    },
  });

  const result = await provision({
    instanceId: "follower",
    owner: { kind: "manual-follower", instanceId: "follower" },
    profileKey: "manual:follower",
  });

  assert.equal(store.getByProfileKey("cwd:/leader")?.slot, "E");
  assert.equal(result.record.slot, "F");
  assert.equal(result.record.threadName, "Falcon");
  assert.deepEqual(calls, [
    { method: "createForumTopic", body: { chat_id: -1001, name: "Falcon" } },
  ]);
});

test("Thread helpers resolve the current instance record from preferred target or active instance", () => {
  const records = [
    {
      profileKey: "leader:old",
      target: { chatId: 7, threadId: 10 },
      status: "active" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
      instanceId: "old",
    },
    {
      profileKey: "manual:follower",
      target: { chatId: 7, threadId: 11 },
      status: "active" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
      instanceId: "current",
    },
  ];

  assert.equal(
    findCurrentTelegramInstanceThreadRecord({
      records,
      instanceId: "current",
      preferredTarget: { chatId: 7, threadId: 10 },
    })?.profileKey,
    "leader:old",
  );
  assert.equal(
    findCurrentTelegramInstanceThreadRecord({
      records,
      instanceId: "current",
      preferredTarget: { chatId: 7, threadId: 99 },
    })?.profileKey,
    "manual:follower",
  );
  assert.equal(
    findCurrentTelegramInstanceThreadRecord({ records, instanceId: "current" })
      ?.profileKey,
    "manual:follower",
  );
});

test("Thread identity resolver keeps status and prompt on registered local metadata", () => {
  const staleRecord = {
    profileKey: "cwd:/repo",
    target: { chatId: 100, threadId: 42 },
    status: "active" as const,
    createdAtMs: 1000,
    updatedAtMs: 1000,
    instanceId: "old-leader",
    slot: "D",
    threadName: "Dune",
  };
  const follower = {
    target: { chatId: 100, threadId: 42 },
    slot: "J",
    threadName: "Juno",
  };

  assert.deepEqual(
    resolveTelegramInstanceThreadIdentity({ follower, record: staleRecord }),
    {
      target: { chatId: 100, threadId: 42 },
      slot: "J",
      threadName: "Juno",
    },
  );
  assert.deepEqual(
    resolveTelegramInstanceThreadIdentity({
      target: { chatId: 100, threadId: 42 },
      follower,
      record: staleRecord,
    }),
    {
      target: { chatId: 100, threadId: 42 },
      slot: "J",
      threadName: "Juno",
    },
  );
});

test("Leader thread state runtime owns target identity transitions", () => {
  const state = createTelegramLeaderThreadStateRuntime();
  assert.equal(state.getTarget(), undefined);
  state.set({
    target: { chatId: 7, threadId: 11 },
    slot: "C",
    threadName: "Cedar",
  });
  assert.deepEqual(state.getIdentity(), {
    target: { chatId: 7, threadId: 11 },
    slot: "C",
    threadName: "Cedar",
  });
  state.clear();
  assert.equal(state.getIdentity(), undefined);
});

test("Current-thread assembly owns preferred-target order and status identity", () => {
  let followerDisplayTitle: string | undefined;
  let activeTarget: { chatId: number; threadId: number } | undefined = {
    chatId: 7,
    threadId: 12,
  };
  const records = [
    {
      profileKey: "active",
      target: activeTarget,
      status: "active" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
      instanceId: "current",
      slot: "A",
      threadName: "Aspen",
    },
  ];
  const assembly = createTelegramCurrentThreadAssembly({
    instanceId: "current",
    listRecords: () => records,
    getActiveTurnTarget: () => activeTarget,
    getFollowerTarget: () => ({ chatId: 7, threadId: 11 }),
    isFollowerRegistered: () => true,
    getFollowerSlot: () => "C",
    getFollowerThreadName: () => "Cedar",
    getFollowerDisplayTitle: () => followerDisplayTitle,
    listWorkspaceBindings: () => [
      { ...createTelegramWorkspaceBindingIdentity("/repo")!, target: { chatId: 7, threadId: 11 },
        threadName: "Cedar", slot: "C", displayTitle: "stale-disk-title", updatedAtMs: 1 },
      { ...createTelegramWorkspaceBindingIdentity("/other")!, target: { chatId: 7, threadId: 55 },
        threadName: "Oak", slot: "O", displayTitle: "other", updatedAtMs: 1 },
      { ...createTelegramWorkspaceBindingIdentity("/moved")!, target: { chatId: 7, threadId: 66 },
        threadName: "Pine", slot: "P", updatedAtMs: 1 },
    ],
    resolveAutomaticDisplayTitle: (binding) => `auto:${binding.threadName}`,
    getLeaderIdentity: () => ({
      target: { chatId: 7, threadId: 10 },
      slot: "L",
      threadName: "Lumen",
    }),
    getLeaderTarget: () => ({ chatId: 7, threadId: 10 }),
    status: {
      getThreadMode: () => "enabled",
      isBusPollingStarted: () => false,
      listFollowers: () => [],
      listReservations: () => [],
      listSyncObservations: () => [],
      getLeaderSocketPath: () => "/tmp/leader.sock",
      getFollowerSocketPath: () => "/tmp/follower.sock",
      getTransportKind: () => "socket",
    },
  });

  assert.equal(assembly.current.findRecord()?.threadName, "Aspen");
  activeTarget = undefined;
  assert.deepEqual(assembly.current.getIdentity(), {
    target: { chatId: 7, threadId: 11 },
    slot: "C",
    threadName: "Cedar",
  });
  assert.equal(assembly.status.getBusRole(), "follower");
  assert.equal(assembly.status.getInstanceThreadName(), "Cedar");
  assert.equal(assembly.getDisplayTitle({ chatId: 7, threadId: 11 }), undefined);
  assert.equal(assembly.getDisplayTitle({ chatId: 7, threadId: 55 }), "other", "An acknowledged title wins");
  assert.equal(assembly.getDisplayTitle({ chatId: 7, threadId: 66 }), "auto:Pine",
    "A binding whose tab has no acknowledged title shows its display-mode title, not its generated name");
  assert.equal(assembly.getDisplayTitle({ chatId: 8, threadId: 55 }), undefined);
  followerDisplayTitle = "repo_c";
  assert.equal(assembly.getDisplayTitle({ chatId: 7, threadId: 11 }), "repo_c");
  assert.equal(assembly.current.getIdentity().threadName, "repo_c");
  assert.equal(assembly.status.getInstanceThreadName(), "repo_c");
  assert.equal(assembly.status.getLocalBus().followerThreadName, "repo_c");
  assert.equal(assembly.current.getRestorationIdentity().threadName, "Cedar");
});

test("Current-instance thread runtime owns record and live identity selection", () => {
  const records = [
    {
      profileKey: "manual:follower",
      owner: { kind: "manual-follower" as const, instanceId: "current" },
      target: { chatId: 7, threadId: 11 },
      status: "active" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
      instanceId: "current",
      slot: "B",
      threadName: "Beacon",
    },
  ];
  let registered = false;
  const runtime = createTelegramCurrentInstanceThreadRuntime({
    instanceId: "current",
    listRecords: () => records,
    getPreferredTarget: () => ({ chatId: 7, threadId: 11 }),
    getFollower: () => ({
      registered,
      target: { chatId: 7, threadId: 11 },
      slot: "C",
      threadName: "Cedar",
    }),
    getLeader: () => undefined,
  });

  assert.equal(runtime.findRecord()?.threadName, "Beacon");
  assert.equal(runtime.getRecord(), undefined);
  assert.deepEqual(runtime.getRestorationIdentity(), {
    target: { chatId: 7, threadId: 11 },
    slot: "B",
    threadName: "Beacon",
  });
  registered = true;
  assert.equal(runtime.getRecord()?.threadName, "Beacon");
  assert.deepEqual(runtime.getIdentity(), {
    target: { chatId: 7, threadId: 11 },
    slot: "C",
    threadName: "Cedar",
  });
});

test("Thread status runtime owns bus and identity projections", () => {
  const runtime = createTelegramThreadStatusProjectionRuntime({
    getThreadMode: () => "enabled",
    isBusPollingStarted: () => false,
    isFollowerRegistered: () => true,
    listFollowers: () => [],
    listRecords: () => [],
    listReservations: () => [],
    listSyncObservations: () => [],
    getLeaderSocketPath: () => "/tmp/leader.sock",
    getFollowerSocketPath: () => "/tmp/follower.sock",
    getTransportKind: () => "socket",
    getFollowerTarget: () => ({ chatId: 7, threadId: 11 }),
    getFollowerSlot: () => "C",
    getFollowerThreadName: () => "Cedar",
    getCurrentIdentity: () => ({ slot: "C", threadName: "Cedar" }),
  });

  assert.equal(runtime.getBusRole(), "follower");
  assert.equal(runtime.getInstanceSlot(), "C");
  assert.equal(runtime.getInstanceThreadName(), "Cedar");
  assert.deepEqual(runtime.getLocalBus(), {
    leaderSocketPath: "/tmp/leader.sock",
    leaderTransport: "socket",
    followerSocketPath: "/tmp/follower.sock",
    followerTransport: "socket",
    followerRegistered: true,
    followerTarget: { chatId: 7, threadId: 11 },
    followerSlot: "C",
    followerThreadName: "Cedar",
  });
});

test("Thread helpers project thread state for status without entrypoint mapping", () => {
  const records = [
    {
      profileKey: "manual:follower",
      target: { chatId: 7, threadId: 11 },
      status: "active" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
      instanceId: "current",
      slot: "B",
      threadName: "Beacon",
      syncStatus: "open" as const,
      lastReconcileAction: "probe",
    },
    {
      profileKey: "manual:legacy",
      target: { chatId: 7, threadId: 13 },
      status: "active" as const,
      createdAtMs: 1,
      updatedAtMs: 1,
      instanceId: "legacy",
      slot: "O",
      threadName: "Follower",
    },
  ];

  assert.deepEqual(
    listTelegramThreadStatusFollowers({
      followers: [
        {
          instanceId: "current",
          cwd: "/repo",
          lastHeartbeatMs: 5,
          target: { chatId: 7, threadId: 11 },
        },
        {
          instanceId: "legacy",
          lastHeartbeatMs: 6,
          target: { chatId: 7, threadId: 13 },
        },
      ],
      records,
    }),
    [
      {
        instanceId: "current",
        cwd: "/repo",
        lastHeartbeatMs: 5,
        target: { chatId: 7, threadId: 11 },
        slot: "B",
        threadName: "Beacon",
        status: "active",
      },
      {
        instanceId: "legacy",
        cwd: undefined,
        lastHeartbeatMs: 6,
        target: { chatId: 7, threadId: 13 },
        slot: "O",
        threadName: "Orbit",
        status: "active",
      },
    ],
  );
  assert.deepEqual(listTelegramThreadStatusTargets(records), [
    {
      instanceId: "current",
      status: "active",
      target: { chatId: 7, threadId: 11 },
      slot: "B",
      threadName: "Beacon",
      syncStatus: "open",
      lastSyncObservedAtMs: undefined,
      lastSyncProbeAtMs: undefined,
      lastSyncError: undefined,
      lastReconcileAction: "probe",
    },
    {
      instanceId: "legacy",
      status: "active",
      target: { chatId: 7, threadId: 13 },
      slot: "O",
      threadName: "Orbit",
      syncStatus: undefined,
      lastSyncObservedAtMs: undefined,
      lastSyncProbeAtMs: undefined,
      lastSyncError: undefined,
      lastReconcileAction: undefined,
    },
  ]);
  assert.deepEqual(
    listTelegramThreadStatusReservations([
      {
        target: { chatId: 7, threadId: 12 },
        slot: "C",
        reason: "startup",
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    ]),
    [
      {
        target: { chatId: 7, threadId: 12 },
        slot: "C",
        reason: "startup",
        instanceId: undefined,
        expiresAtMs: undefined,
        lastReconcileAction: undefined,
      },
    ],
  );
  assert.deepEqual(
    listTelegramThreadStatusObservations([
      {
        target: { chatId: 7, threadId: 13 },
        syncStatus: "closed",
        observedAtMs: 9,
      },
    ]),
    [
      {
        target: { chatId: 7, threadId: 13 },
        syncStatus: "closed",
        observedAtMs: 9,
        instanceId: undefined,
        slot: undefined,
        lastSyncError: undefined,
        lastReconcileAction: undefined,
      },
    ],
  );
});

test("Thread helpers extract thread targets from Bot API bodies", () => {
  assert.deepEqual(
    getTelegramTargetFromApiBody({ chat_id: "-1001", message_thread_id: "42" }),
    { chatId: -1001, threadId: 42 },
  );
  assert.equal(getTelegramTargetFromApiBody({ chat_id: -1001 }), undefined);
  assert.equal(
    getTelegramTargetFromApiBody({ chat_id: -1001, message_thread_id: "x" }),
    undefined,
  );
});

test("Bot API Threaded Mode unavailable helper detects disabled thread support", () => {
  assert.equal(
    isTelegramTopicModeUnavailableError(
      new Error(
        "Telegram API createForumTopic failed: HTTP 400: Bad Request: not a forum",
      ),
    ),
    true,
  );
  assert.equal(
    isTelegramTopicModeUnavailableError(
      new Error(
        "Telegram API createForumTopic failed: HTTP 400: Bad Request: topics are disabled",
      ),
    ),
    true,
  );
  assert.equal(
    isTelegramTopicModeUnavailableError(new Error("network failed")),
    false,
  );
});

test("Thread stale error helper detects deleted or missing topics", () => {
  assert.equal(
    isTelegramTopicTargetStaleError(
      new Error(
        "Telegram API sendMessage failed: HTTP 400: Bad Request: message thread not found",
      ),
    ),
    true,
  );
  assert.equal(
    isTelegramTopicTargetStaleError(
      new Error(
        "Telegram API editForumTopic failed: HTTP 400: Bad Request: TOPIC_ID_INVALID",
      ),
    ),
    true,
  );
  assert.equal(
    isTelegramTopicTargetStaleError(new Error("network failed")),
    false,
  );
});

test("Own bus topic provisioner assigns a leader topic through the common provisioner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-own-topic-"));
  const calls: unknown[] = [];
  const events: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: join(dir, "telegram-targets.json"),
    getNowMs: () => 2000,
  });
  try {
    const result = await provisionOwnBusTopic({
      getAllowedUserId: () => 7,
      instanceId: "leader-a",
      cwd: "/repo",
      store,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return { message_thread_id: 11 } as TResponse;
      },
      recordEvent(category, message, details) {
        events.push({ category, message, details });
      },
    });
    assert.deepEqual(result, {
      target: { chatId: 7, threadId: 11 },
      slot: "A",
      threadName: "Atlas",
      reused: false,
    });
    assert.deepEqual(calls, [
      { method: "createForumTopic", body: { chat_id: 7, name: "Atlas" } },
    ]);
    assert.equal(store.getByProfileKey("cwd:/repo")?.status, "active");
    assert.equal(
      events.some(
        (event) =>
          (event as { details?: { phase?: string } }).details?.phase ===
          "leader-topic",
      ),
      true,
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Previous-leader cleanup cannot invalidate or reserve a target rebound during close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-rebound-leader-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const old = { profileKey: "leader:old", owner: { kind: "leader" as const, instanceId: "old" }, target: { chatId: 7, threadId: 10 }, instanceId: "old", status: "active" as const, createdAtMs: 1, updatedAtMs: 1, slot: "A" };
  const calls: string[] = [];
  try {
    store.upsert(old);
    store.upsert({ profileKey: "manual:new", owner: { kind: "manual-follower", instanceId: "new" }, target: { chatId: 7, threadId: 12 }, instanceId: "new", status: "active", createdAtMs: 1, updatedAtMs: 1, slot: "C" });
    await store.persist();
    await provisionOwnBusTopic({
      getAllowedUserId: () => 7, instanceId: "new", cwd: "/repo", store,
      callApi: async <T>(method: string) => {
        calls.push(method);
        if (method === "closeForumTopic") store.upsert({ ...old, instanceId: "replacement", updatedAtMs: 2 });
        return { message_thread_id: 99 } as T;
      },
      recordEvent: () => {},
    });
    assert.deepEqual(calls, ["closeForumTopic"]);
    assert.equal(store.list().find((record) => record.target.threadId === 10)?.instanceId, "replacement");
    assert.equal(store.listReservations().some((record) => record.target.threadId === 10), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Own bus topic provisioner cleans previous leader before reusing promoted follower topic", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "pi-telegram-own-topic-promoted-cleanup-"),
  );
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const store = createTelegramTopicTargetStore({
    path: join(dir, "telegram-targets.json"),
    getNowMs: () => 2000,
  });
  try {
    store.upsert({
      profileKey: "leader:old",
      owner: { kind: "leader", instanceId: "old" },
      target: { chatId: 7, threadId: 10 },
      status: "active",
      createdAtMs: 900,
      updatedAtMs: 900,
      instanceId: "old",
      slot: "A",
    });
    store.upsert({
      profileKey: "manual:follower-c",
      owner: { kind: "manual-follower", instanceId: "follower-c" },
      target: { chatId: 7, threadId: 12 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "follower-c",
      slot: "C",
      threadName: "Compas",
    });
    await store.persist();
    const result = await provisionOwnBusTopic({
      getAllowedUserId: () => 7,
      instanceId: "follower-c",
      cwd: "/repo",
      store,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return { message_thread_id: 99 } as TResponse;
      },
      recordEvent() {},
    });
    assert.deepEqual(result, {
      target: { chatId: 7, threadId: 12 },
      slot: "C",
      threadName: "Compas",
      reused: true,
    });
    assert.deepEqual(
      calls.map((call) => call.method),
      ["closeForumTopic", "deleteForumTopic"],
    );
    assert.equal(store.getByProfileKey("leader:old"), undefined);
    assert.equal(store.listReservations()[0]?.slot, "A");
    assert.equal(
      store.listReservations()[0]?.reason,
      "previous-process-cleaned-without-visible-probe",
    );
    assert.equal(
      store.getActiveByInstanceId("follower-c")?.threadName,
      "Compas",
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Own bus topic provisioner reuses promoted follower topic", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "pi-telegram-own-topic-promoted-follower-"),
  );
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: join(dir, "telegram-targets.json"),
    getNowMs: () => 2000,
  });
  try {
    store.upsert({
      profileKey: "manual:follower-c",
      owner: { kind: "manual-follower", instanceId: "follower-c" },
      target: { chatId: 7, threadId: 12 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "follower-c",
      slot: "C",
      threadName: "Compas",
    });
    await store.persist();
    const result = await provisionOwnBusTopic({
      getAllowedUserId: () => 7,
      instanceId: "follower-c",
      cwd: "/repo",
      store,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return { message_thread_id: 99 } as TResponse;
      },
      recordEvent() {},
    });
    assert.deepEqual(result, {
      target: { chatId: 7, threadId: 12 },
      slot: "C",
      threadName: "Compas",
      reused: true,
    });
    assert.deepEqual(calls, []);
    assert.equal(
      store.getActiveByInstanceId("follower-c")?.threadName,
      "Compas",
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Own bus topic provisioner restores a promoted leader session handoff", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "pi-telegram-own-topic-promoted-reload-"),
  );
  const path = join(dir, "telegram-targets.json");
  const store = createTelegramTopicTargetStore({ path });
  const calls: unknown[] = [];
  try {
    store.upsert({
      profileKey: "manual:stable-follower",
      owner: { kind: "manual-follower", instanceId: "stable-follower" },
      target: { chatId: 7, threadId: 12 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: `${process.pid}:old-session`,
      slot: "C",
      threadName: "Cinder",
    });
    await store.persist();
    setTelegramLeaderSessionHandoff({
      pid: process.pid,
      instanceId: `${process.pid}:old-session`,
      createdAtMs: Date.now(),
      profileKey: "cwd:/repo",
      target: { chatId: 7, threadId: 12 },
      slot: "C",
      threadName: "Cinder",
    });

    const result = await provisionOwnBusTopic({
      getAllowedUserId: () => 7,
      instanceId: `${process.pid}:replacement-session`,
      cwd: "/repo",
      store,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return { message_thread_id: 99 } as TResponse;
      },
      recordEvent() {},
    });
    assert.deepEqual(result, {
      target: { chatId: 7, threadId: 12 },
      slot: "C",
      threadName: "Cinder",
      reused: true,
    });
    assert.deepEqual(calls, []);
    assert.equal(getTelegramLeaderSessionHandoff(), undefined);
    const restored = createTelegramTopicTargetStore({ path });
    await restored.load();
    assert.equal(restored.list().length, 1);
    assert.deepEqual(restored.list()[0]?.owner, {
      kind: "leader",
      cwd: "/repo",
      instanceId: `${process.pid}:replacement-session`,
    });
    assert.equal(restored.list()[0]?.threadName, "Cinder");
  } finally {
    setTelegramLeaderSessionHandoff(undefined);
    await rm(dir, { force: true, recursive: true });
  }
});

test("Own bus topic provisioner does not claim pending follower topics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-own-topic-pending-"));
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: join(dir, "telegram-targets.json"),
    getNowMs: () => 2000,
  });
  try {
    store.upsert({
      profileKey: "topic:7:10",
      target: { chatId: 7, threadId: 10 },
      status: "pending",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      slot: "B",
    });
    await store.persist();
    const result = await provisionOwnBusTopic({
      getAllowedUserId: () => 7,
      instanceId: "leader-a",
      cwd: "/repo",
      store,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return { message_thread_id: 11 } as TResponse;
      },
      recordEvent() {},
    });
    assert.deepEqual(result, {
      target: { chatId: 7, threadId: 11 },
      slot: "C",
      threadName: "Cedar",
      reused: false,
    });
    assert.deepEqual(calls, [
      { method: "createForumTopic", body: { chat_id: 7, name: "Cedar" } },
    ]);
    assert.equal(store.getByProfileKey("topic:7:10")?.status, "pending");
    assert.deepEqual(store.getByProfileKey("cwd:/repo")?.target, {
      chatId: 7,
      threadId: 11,
    });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Own bus topic provisioner ignores non-current offline history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-own-topic-stale-"));
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: join(dir, "telegram-targets.json"),
    getNowMs: () => 2000,
  });
  try {
    store.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 7, threadId: 10 },
      status: "offline",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      slot: "A",
    });
    await store.persist();
    const result = await provisionOwnBusTopic({
      getAllowedUserId: () => 7,
      instanceId: "leader-a",
      cwd: "/repo",
      store,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return { message_thread_id: 11 } as TResponse;
      },
      recordEvent() {},
    });
    assert.deepEqual(result, {
      target: { chatId: 7, threadId: 11 },
      slot: "A",
      threadName: "Atlas",
      reused: false,
    });
    assert.deepEqual(calls, [
      { method: "createForumTopic", body: { chat_id: 7, name: "Atlas" } },
    ]);
    assert.deepEqual(store.getByProfileKey("cwd:/repo")?.target, {
      chatId: 7,
      threadId: 11,
    });
    assert.equal(store.getByProfileKey("cwd:/repo")?.status, "active");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Own bus topic provisioner reuses a current topic without visible startup probes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-own-topic-no-probe-"));
  const calls: unknown[] = [];
  const store = createTelegramTopicTargetStore({
    path: join(dir, "telegram-targets.json"),
    getNowMs: () => 2000,
  });
  try {
    store.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 7, threadId: 10 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      slot: "A",
      threadName: "Atlas",
    });
    await store.persist();
    const result = await provisionOwnBusTopic({
      getAllowedUserId: () => 7,
      instanceId: "leader-a",
      cwd: "/repo",
      store,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return { message_thread_id: 11 } as TResponse;
      },
      recordEvent() {},
    });
    assert.deepEqual(result, {
      target: { chatId: 7, threadId: 10 },
      slot: "A",
      threadName: "Atlas",
      reused: true,
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(store.getByProfileKey("cwd:/repo")?.target, {
      chatId: 7,
      threadId: 10,
    });
    assert.equal(store.getByProfileKey("cwd:/repo")?.syncStatus, "open");
    assert.equal(
      store.getByProfileKey("cwd:/repo")?.lastReconcileAction,
      "leader-startup-skip-probe",
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Thread store persists only current state statuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-threads-"));
  const path = join(dir, "telegram-targets.json");
  try {
    const store = createTelegramTopicTargetStore({ path });
    store.upsert({
      profileKey: "topic:1:42",
      target: { chatId: 1, threadId: 42 },
      status: "pending",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      slot: "C",
      syncStatus: "unknown",
      lastSyncObservedAtMs: 1300,
      lastSyncProbeAtMs: 1400,
      lastSyncError: "probe skipped",
      lastReconcileAction: "startup-skip",
    });
    store.upsert({
      profileKey: "topic:1:43",
      target: { chatId: 1, threadId: 43 },
      status: "starting",
      createdAtMs: 1000,
      updatedAtMs: 1100,
      slot: "D",
    });
    store.upsert({
      profileKey: "topic:1:44",
      target: { chatId: 1, threadId: 44 },
      status: "failed",
      createdAtMs: 1000,
      updatedAtMs: 1200,
      slot: "E",
      lastError: "spawn failed",
    });
    await store.persist();

    const loaded = createTelegramTopicTargetStore({ path });
    await loaded.load();
    const record = loaded.getByProfileKey("topic:1:42");
    assert.ok(record);
    assert.equal(record.status, "pending");
    assert.equal(record.slot, "C");
    assert.equal(record.target.chatId, 1);
    assert.equal(record.target.threadId, 42);
    assert.equal(record.syncStatus, "unknown");
    assert.equal(record.lastSyncObservedAtMs, 1300);
    assert.equal(record.lastSyncProbeAtMs, 1400);
    assert.equal(record.lastSyncError, "probe skipped");
    assert.equal(record.lastReconcileAction, "startup-skip");
    assert.equal(loaded.getByProfileKey("topic:1:43")?.status, "starting");
    assert.equal(loaded.getByProfileKey("topic:1:44"), undefined);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});


test("Production Restore storage resolver separates profiles and refuses foreign token evidence", async () => {
  await fixture(async ({ request, auth, path }) => {
    let profile: string | undefined;
    let token: string | undefined = "fixture:token";
    let beforePublish = () => {};
    const threadStore = createTelegramTopicTargetStore({ path: () => profile ? `${path}.${profile}` : path,
      commitPersist(commit) { beforePublish(); commit(); return true; } });
    const resolve = createTelegramWorkspaceRestoreResolver({ getProfileName: () => profile, getBotToken: () => token,
      agentDir: dirname(path), threadStore });
    const first = resolve()!;
    assert.equal(resolve(), first);
    assert.deepEqual(first.list(), []);
    await first.commit(request, auth);
    profile = "other";
    const other = resolve()!;
    assert.notEqual(other, first);
    assert.deepEqual(other.list(), []);
    assert.equal(first.list()[0]?.request.operationId, request.operationId);
    const original = first.list()[0]!;
    const successor = { ...auth, executor: { instanceId: "successor", leaderEpoch: "next" } };
    assert.equal(first.adopt(original, successor), undefined, "a retained handle cannot publish under another active profile");
    profile = undefined;
    assert.deepEqual(resolve()!.list(), first.list());
    beforePublish = () => { token = "fixture:switched"; };
    assert.equal(first.adopt(original, successor), undefined, "token scope is checked inside owner-fenced publication");
    assert.deepEqual(first.list(), [original]);
    token = "fixture:replacement";
    assert.throws(() => resolve()!.list(), /foreign Workspace Restore evidence/);
    token = undefined;
    assert.equal(resolve(), undefined);
  });
});

for (const role of ["leader", "follower"] as const) {
  test(`Restore atomically relocates before one recipient issuance (${role})`, async () => {
    await fixture(async ({ store, open, threads, request, path, auth }) => {
      assert.deepEqual(store.list(), []);
      assert.equal(threads.listWorkspaceBindings()[0]?.target.threadId, 10);
      const relocated = (await store.commit(request, auth))!;
      assert.equal(relocated.phase, "relocated");
      assert.equal(relocated.committedAtMs, 1000);
      assert.equal(threads.listWorkspaceBindings()[0]?.target.threadId, 42);
      assert.deepEqual(open().list(), [relocated]);
      assert.equal(existsSync(join(dirname(path), "restore.json")), false);
      const current = open();
      assert.equal(current.issueRecipient(relocated, { ...recipient(role), sessionId: "wrong" }, auth), undefined);
      const issued = current.issueRecipient(relocated, recipient(role), auth)!;
      assert.equal(issued.issued, true);
      let rpcCalls = 0;
      if (issued.issued) {
        assert.equal(open().list()[0]?.phase, "recipient-issued", "issuance precedes the external effect");
        rpcCalls += 1; // Simulate an executed target switch with a lost RPC acknowledgement.
      }
      assert.equal(current.issueRecipient(relocated, recipient(role), auth), undefined);
      const cold = open();
      assert.equal(cold.issueRecipient(cold.list()[0]!, recipient(role), auth), undefined, "restart never reissues an unknown RPC");
      assert.equal(rpcCalls, 1);
      assert.equal(cold.confirmReady(issued.intent, { ...recipient(role), generation: "stale" }, auth), undefined);
      const ready = cold.confirmReady(issued.intent, recipient(role), auth)!;
      assert.equal(ready.phase, "ready");
      assert.deepEqual(open().list(), [ready]);
      assert.equal(await cold.commit(request, auth), undefined, "duplicate commit grants no issuance");
      assert.equal(cold.confirmReady(issued.intent, recipient(role), auth), undefined);
      if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    }, role);
  });
}

for (const role of ["leader", "follower"] as const) {
  test(`Restore with all 26 slots occupied preserves the slot and every other binding (${role})`, async () => {
    await fixture(async ({ store, open, threads, request, auth }) => {
      for (let index = 1; index < 26; index++) {
        threads.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity(`/repo/${index}`, index, `session-${index}`)!,
          target: { chatId: 7, threadId: 100 + index }, slot: String.fromCharCode(65 + index), threadName: `Thread ${index}`,
          journalBindingKeys: [`manual:${index}`], journalBindingsComplete: true, updatedAtMs: 1 });
      }
      const others = threads.listWorkspaceBindings().filter(value => value.slot !== "A");
      assert.equal(threads.listWorkspaceBindings().length, 26);
      const relocated = (await store.commit(request, auth))!;
      assert.equal(relocated.phase, "relocated");
      const after = open().list();
      assert.deepEqual(after, [relocated]);
      const bindings = threads.listWorkspaceBindings();
      assert.equal(bindings.length, 26, "relocation neither allocates nor evicts a slot");
      assert.deepEqual(bindings.find(value => value.slot === "A")?.target, { chatId: 7, threadId: 42 });
      assert.deepEqual(bindings.filter(value => value.slot !== "A"), others, "unrelated bindings are untouched");
      assert.deepEqual(await open().commit(request, auth), relocated, "a duplicate commit reconciles read-only");
      assert.equal(threads.listWorkspaceBindings().length, 26);
    }, role);
  });
}

for (const role of ["leader", "follower"] as const) {
  test(`Restore uses one publication and explicit executor adoption (${role})`, async () => {
    let publications = 0;
    await fixture(async ({ store, open, threads, request, auth }) => {
      const result = await store.commit(request, auth);
      assert.equal(result?.phase, "relocated");
      assert.equal(threads.listWorkspaceBindings()[0]?.target.threadId, 42);
      assert.equal(threads.listWorkspaceBindings()[0]?.slot, "A");
      assert.deepEqual(await open().commit(request, auth), result);
      assert.equal(publications, 1);
      const next = { ...auth, executor: { instanceId: "successor", leaderEpoch: "successor-epoch" } };
      assert.equal(await store.commit(request, next), undefined, "no implicit adoption");
      const adopted = store.adopt(result!, next)!;
      assert.deepEqual(await store.commit(request, next), adopted);
      assert.equal(publications, 2, "only explicit adoption adds a second publication");
      assert.equal(store.issueRecipient(adopted, recipient(role), next)?.issued, true);
      assert.equal(await store.commit(request, next), undefined, "commit retry never restarts issued work");
    }, role, { onPublicationBoundary(at) { if (at === "after-rename") publications += 1; } });
  });
}

for (const role of ["leader", "follower"] as const) {
  for (const boundary of ["after-write-before-rename", "after-rename"] as const) {
    test(`Atomic Restore has no half-commit across restart (${role}, ${boundary})`, async () => {
      let armed = true, publications = 0;
      await fixture(async ({ store, open, threads, request, auth, path }) => {
        const before = await readFile(path, "utf8");
        if (boundary === "after-write-before-rename") await assert.rejects(store.commit(request, auth), /publication/);
        else assert.equal((await store.commit(request, auth))?.phase, "relocated");
        const committed = boundary === "after-rename";
        const cold = createTelegramTopicTargetStore({ path });
        await cold.load();
        assert.equal(cold.listWorkspaceBindings()[0]?.target.threadId, committed ? 42 : 10);
        assert.equal(open().list().length, committed ? 1 : 0);
        if (!committed) assert.equal(await readFile(path, "utf8"), before);
        armed = false;
        assert.equal((await open({ threadStore: cold }).commit(request, auth))?.phase, "relocated");
        assert.equal(publications, 1, "only one complete publication, even after a lost reply");
        await threads.load();
        assert.equal(threads.listWorkspaceBindings()[0]?.target.threadId, 42);
      }, role, { onPublicationBoundary(at) {
        if (at === "after-rename") publications += 1;
        if (armed && at === boundary) throw new Error("publication failed or ACK lost");
      } });
    });
  }
}

test("Restore fences reused authority after awaited loading", async () => {
  await fixture(async ({ store, threads, request, auth, path }) => {
    const before = await readFile(path, "utf8");
    auth.isCurrent = () => false;
    assert.equal(await store.commit(new Proxy(request, { get() { throw new Error("stale source read"); } }), auth), undefined);
    auth.isCurrent = () => true;
    const committing = store.commit(request, auth);
    auth.executor.leaderEpoch = "changed";
    assert.equal(await committing, undefined);
    assert.deepEqual(store.list(), []);
    assert.equal(threads.listWorkspaceBindings()[0]?.target.threadId, 10);
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("Restore does not return authority after committed publication loses ownership", async () => {
  await fixture(async ({ store, open, threads, request, auth }) => {
    let current = true;
    auth.isCurrent = () => current;
    const changing = open({ onPublicationBoundary(at) { if (at === "after-rename") current = false; } });
    assert.equal(await changing.commit(request, auth), undefined);
    assert.equal(store.list()[0]?.phase, "relocated");
    assert.equal(threads.listWorkspaceBindings()[0]?.target.threadId, 42);
  });
});

test("Workspace exposes Restore transitions, not raw snapshot mutation", async () => {
  await fixture(async ({ store }) => {
    for (const removed of ["read", "update", "relocate"]) assert.equal(removed in store, false);
  });
});

test("Restore never fabricates a missing operation from matching canonical targets", async () => {
  await fixture(async ({ store, threads, request, auth }) => {
    threads.upsertWorkspaceBinding({ ...request.binding, target: request.target });
    threads.upsert({ ...request.owner, target: request.target });
    await threads.persist();
    assert.equal(await store.commit(request, auth), undefined);
    assert.deepEqual(store.list(), []);
  });
});

for (const fault of ["none", "routing-lost-ack", "source-before-write", "source-lost-ack", "cleanup-unknown", "cleanup-completed"] as const) {
  test(`Restore retirement requires positive source and cleanup evidence (${fault})`, async () => {
    await fixture(async ({ store, open, request, auth, path }) => {
      const identity = { instanceId: "old", processId: process.pid, processBirthId: `${process.pid}:restore`, sessionGeneration: 1 };
      const options = { path: join(dirname(path), "source.json"), queueRuntimeIdentity: identity,
        botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "fixture:restore", botId: 7 }) };
      const journal = createTelegramUpdateJournalStore(options);
      request.source.journalBindingKey = createTelegramUpdateJournalBindingKey(options);
      journal.appendBatch(request.source.updateIds.map(update_id => ({ update_id,
        message: { message_id: update_id, from: { id: 7, is_bot: false }, chat: { id: 7, type: "private" }, text: "fixture" } })));
      const relocated = await store.commit(request, auth);
      const issued = store.issueRecipient(relocated!, recipient("leader"), auth)!.intent;
      const ready = store.confirmReady(issued, recipient("leader"), auth)!;
      assert.equal(store.retire(ready, auth), undefined);
      assert.equal(store.recordSourceSettlement(ready, { ...request.source, kind: "completed" }, auth), undefined);
      if (fault === "routing-lost-ack") {
        const interrupted = open({ onPublicationBoundary(boundary) {
          if (boundary === "after-rename") throw new Error("Routing grant ACK lost");
        } });
        assert.throws(() => interrupted.issueRouting(ready, auth), /Routing grant ACK lost/);
        const retained = open().list()[0]!;
        assert.equal(store.issueRouting(retained, auth), undefined);
        assert.equal(store.retire(retained, auth), undefined);
        assert.equal(journal.read().entries.every(entry => entry.state === "pending"), true);
        return;
      }
      const routing = store.issueRouting(ready, auth)!.intent;
      assert.equal(open().issueRouting(routing, auth), undefined);
      assert.equal(store.issueCleanup(routing, auth), undefined);
      assert.equal(store.recordSourceSettlement(routing, { ...request.source, updateIds: [999], kind: "completed" }, auth), undefined);
      const events: unknown[] = [], ctx = {};
      const recipientJournal = createTelegramUpdateJournalStore({ ...options, path: `${options.path}.recipient` });
      recipientJournal.appendBatch([{ update_id: 99, message: { message_id: 99, chat: { id: 7, type: "private" }, text: "Independent accepted recipient work" } }]);
      recipientJournal.markQueued({ receiptId: "recipient-work", queueKind: "prompt", sourceUpdateIds: [99], owner: identity });
      const recipientBefore = recipientJournal.read();
      let queuedReceipt: { receiptId: string; queueKind: "prompt" | "control"; sourceUpdateIds: number[]; journalBindingKey?: string } | undefined;
      const worker = createTelegramUpdateWorkerRuntime({ journal: { ...journal, removeCompleted(ids) {
          if (fault === "source-before-write") throw new Error("No completion commit");
          const result = journal.removeCompleted(ids);
          if (fault === "source-lost-ack") throw new Error("Completion ACK lost");
          return result;
        } }, hasAuthority: () => true, getJournalBindingKey: () => request.source.journalBindingKey,
        getQueueOwnerIdentity: () => identity,
        executeUpdate(update) { return update.update_id === 100
          ? { kind: "queued", queueKind: "prompt", receiptId: "accepted-work", sourceUpdateIds: [100] }
          : { kind: "complete" }; },
        onQueueReceiptCommitted(receipt) {
          queuedReceipt = { ...receipt, sourceUpdateIds: [...receipt.sourceUpdateIds] };
          const entry = journal.read().entries.find(value => value.updateId === 100)!;
          assert.ok(store.recordSourceAcceptance(store.list()[0]!, { ...createTelegramUpdateJournalEntryDigest(entry),
            journalBindingKey: request.source.journalBindingKey, recipient: recipient("leader"), kind: "queued",
            receiptId: receipt.receiptId, queueKind: receipt.queueKind,
            queueOwnerSha256: createHash("sha256").update(JSON.stringify(entry.queueOwner)).digest("hex") }, auth));
          assert.ok(store.recordSourceSettlement(store.list()[0]!, { journalBindingKey: request.source.journalBindingKey,
            updateIds: [...receipt.sourceUpdateIds], kind: "queued", receiptId: receipt.receiptId, queueKind: receipt.queueKind }, auth));
        }, onUpdateCompleted(updateId) {
          assert.ok(store.recordSourceSettlement(store.list()[0]!, { journalBindingKey: request.source.journalBindingKey,
            updateIds: [updateId], kind: "completed" }, auth));
        }, recordRuntimeEvent(_category, event) { events.push(event); } });
      try {
        worker.start(ctx);
        await worker.waitForDrain();
        let observed = open().list()[0]!;
        assert.equal(observed.routing?.settlements.length, fault.startsWith("source-") ? 1 : 2);
        const accepted = journal.read().entries.find(entry => entry.updateId === 100)!;
        assert.equal(accepted.state, "queued");
        if (fault.startsWith("source-")) {
          assert.ok(events.length > 0);
          assert.equal(store.issueCleanup(observed, auth), undefined);
          assert.equal(store.retire(observed, auth), undefined);
          assert.equal(journal.read().entries.some(entry => entry.updateId === 101), fault === "source-before-write");
          return;
        }
        assert.deepEqual(events, []);
        assert.equal(store.issueCleanup(observed, auth), undefined, "queue admission cannot grant terminal cleanup");
        assert.equal(store.recordCleanup(observed, { target: request.binding.target, kind: "not-issued" }, auth), undefined);
        assert.ok(queuedReceipt);
        assert.equal(worker.completeQueueReceipts({ receipts: [queuedReceipt], ctx, reason: "prompt-handoff" }), true);
        observed = store.recordSourceSettlement(observed, { journalBindingKey: request.source.journalBindingKey, updateIds: [100],
          kind: "queue-completed", receiptId: queuedReceipt.receiptId, queueKind: queuedReceipt.queueKind }, auth)!;
        let terminal;
        if (fault === "none") terminal = store.recordCleanup(observed, { target: request.binding.target, kind: "not-issued" }, auth);
        else {
          const cleanup = store.issueCleanup(observed, auth)!.intent;
          assert.equal(open().issueCleanup(cleanup, auth), undefined);
          assert.equal(store.recordCleanup(cleanup, { target: request.binding.target, kind: "not-issued" }, auth), undefined);
          assert.equal(store.recordCleanup(cleanup, { target: request.target, kind: "completed" }, auth), undefined);
          if (fault === "cleanup-unknown") {
            assert.equal(store.retire(cleanup, auth), undefined);
            assert.equal(store.issueRouting(cleanup, auth), undefined);
            return;
          }
          terminal = store.recordCleanup(cleanup, { target: request.binding.target, kind: "completed" }, auth);
        }
        assert.ok(terminal);
        assert.equal(store.retire(observed, auth), undefined, "old snapshots cannot release protection");
        assert.deepEqual(store.retire(terminal, auth), terminal);
        assert.deepEqual(open().list(), []);
        assert.equal(store.retire(terminal, auth), undefined, "absence is not another retirement acknowledgement");
        assert.equal(journal.read().entries.find(entry => entry.updateId === 100), undefined, "source receipt has a positive owner disposal ACK");
        assert.deepEqual(recipientJournal.read(), recipientBefore, "retiring routing authority cannot complete or cancel independent recipient work");
      } finally { await worker.stop(); }
    });
  });
}

for (const kind of ["completed", "queued", "forwarded"] as const) {
  for (const boundary of ["normal", "before-rename", "after-rename"] as const) {
    test(`Restore retains acceptance separately from source disposition (${kind}, ${boundary})`, async () => {
      const role = kind === "forwarded" ? "follower" : "leader";
      await fixture(async ({ store, open, request, auth, path }) => {
        const options = { path: join(dirname(path), "acceptance-source.json"),
          botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "fixture:restore", botId: 7 }) };
        const journal = createTelegramUpdateJournalStore(options);
        request.source.journalBindingKey = createTelegramUpdateJournalBindingKey(options);
        journal.appendBatch(request.source.updateIds.map(update_id => ({ update_id,
          message: { message_id: update_id, from: { id: 7, is_bot: false }, chat: { id: 7, type: "private" }, text: "fixture" } })));
        const queued = kind === "queued" ? journal.markQueued({ sourceUpdateIds: request.source.updateIds,
          receiptId: "accepted", queueKind: "prompt", owner: { instanceId: "old", processId: process.pid,
            processBirthId: `${process.pid}:acceptance`, sessionGeneration: 1 } }) : undefined;
        const sourceBefore = await readFile(options.path, "utf8");
        const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
        const makeEvidence = (updateId: number): TelegramWorkspaceRestoreSourceAcceptance => ({
          journalBindingKey: request.source.journalBindingKey, updateId,
          sourceSha256: hash(journal.read().entries.find(entry => entry.updateId === updateId)), recipient: recipient(role),
          ...(kind === "completed" ? { kind } : kind === "queued"
            ? { kind, receiptId: "accepted", queueKind: "prompt", queueOwnerSha256: hash(queued!.queueOwner) }
            : { kind, recipientBindingKey: "manual:old", deliveryId: createTelegramBusFollowerDeliveryIdentity({
              kind: "leader.forwardMessage", recipientBindingKey: "manual:old", sourceUpdateId: updateId }).deliveryId }),
        });
        const evidence = makeEvidence(100);
        const relocated = (await store.commit(request, auth))!;
        const issued = store.issueRecipient(relocated, recipient(role), auth)!.intent;
        const ready = store.confirmReady(issued, recipient(role), auth)!;
        assert.equal(store.recordSourceAcceptance(ready, evidence, auth), undefined, "readiness is not a dispatch grant");
        let routing = store.issueRouting(ready, auth)!.intent;
        const before = await readFile(path, "utf8");
        if (boundary !== "normal") {
          const interrupted = open({ onPublicationBoundary(point) {
            if (point === (boundary === "before-rename" ? "after-write-before-rename" : "after-rename")) {
              throw new Error("Acceptance publication interrupted");
            }
          } });
          assert.throws(() => interrupted.recordSourceAcceptance(routing, evidence, auth), /Acceptance publication interrupted/);
          const cold = createTelegramTopicTargetStore({ path }); await cold.load();
          const recovered = restoreStorage(cold);
          routing = recovered.list()[0]!;
          assert.deepEqual(routing.routing?.acceptances, boundary === "before-rename" ? undefined : [evidence]);
          assert.deepEqual(routing.routing?.settlements, []);
          assert.equal(recovered.issueCleanup(routing, auth), undefined);
          assert.equal(recovered.retire(routing, auth), undefined);
          assert.equal(recovered.issueRouting(routing, auth), undefined, "lost publication cannot grant another dispatch");
          if (boundary === "before-rename") assert.equal(await readFile(path, "utf8"), before);
          else {
            const published = await readFile(path, "utf8");
            assert.deepEqual(recovered.recordSourceAcceptance(routing, evidence, auth), routing);
            assert.equal(await readFile(path, "utf8"), published, "exact lost-reply recovery is read-only");
          }
        } else {
          for (const invalid of [
            { ...evidence, updateId: 999 }, { ...evidence, journalBindingKey: "foreign" },
            { ...evidence, sourceSha256: "not-a-hash" },
            { ...evidence, recipient: { ...evidence.recipient, generation: "foreign" } },
            { ...evidence, recipient: { ...evidence.recipient, sessionId: "foreign" } },
          ]) assert.equal(store.recordSourceAcceptance(routing, invalid, auth), undefined);
          assert.equal(store.recordSourceAcceptance(routing, evidence, { ...auth, operatorUserId: 8 }), undefined);
          assert.equal(store.recordSourceAcceptance(routing, evidence, { ...auth, isCurrent: () => false }), undefined);
          assert.equal(await readFile(path, "utf8"), before);
          routing = store.recordSourceAcceptance(routing, evidence, auth)!;
          assert.ok(routing);
          const completionSha256 = getTelegramWorkspaceRestoreSourceCompletionSha256(routing, evidence);
          assert.match(completionSha256, /^[a-f0-9]{64}$/u);
          const reordered = JSON.parse(JSON.stringify(routing, function (_key, value) {
            return value && typeof value === "object" && !Array.isArray(value)
              ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, value[key]])) : value;
          }));
          assert.equal(getTelegramWorkspaceRestoreSourceCompletionSha256(reordered, evidence), completionSha256,
            "object order is representation, not a different completion authority");
          assert.notEqual(getTelegramWorkspaceRestoreSourceCompletionSha256({ ...routing,
            request: { ...routing.request, operationId: `${routing.request.operationId}:other` } }, evidence), completionSha256);
          assert.notEqual(getTelegramWorkspaceRestoreSourceCompletionSha256({ ...routing,
            request: { ...routing.request, target: { ...routing.request.target, threadId: 43 } } }, evidence), completionSha256);
          assert.throws(() => getTelegramWorkspaceRestoreSourceCompletionSha256(routing, { ...evidence, sourceSha256: "f".repeat(64) }), /retained acceptance scope/);
          assert.throws(() => getTelegramWorkspaceRestoreSourceCompletionSha256({ ...routing, operatorUserId: 8 }, evidence), /retained acceptance scope/);
          assert.deepEqual(routing.routing?.settlements, [], "acceptance alone never becomes source disposition");
          assert.equal(store.issueCleanup(routing, auth), undefined);
          assert.equal(store.retire(routing, auth), undefined);
          assert.equal(store.issueRouting(routing, auth), undefined);
          const published = await readFile(path, "utf8");
          assert.deepEqual(store.recordSourceAcceptance(routing, structuredClone(evidence), auth), routing);
          assert.equal(await readFile(path, "utf8"), published, "duplicates change no revision, timestamp or bytes");
          assert.equal(store.recordSourceAcceptance(routing, { ...evidence, sourceSha256: "f".repeat(64) }, auth), undefined);
          if (evidence.kind === "queued") {
            assert.equal(store.recordSourceSettlement(routing, { ...request.source, updateIds: [100], kind: "completed" }, auth), undefined);
            assert.equal(store.recordSourceSettlement(routing, { ...request.source, updateIds: [100],
              kind: "queued", receiptId: "foreign", queueKind: "prompt" }, auth), undefined);
            assert.equal(store.recordSourceAcceptance(routing, { ...makeEvidence(101), kind: "queued",
              receiptId: evidence.receiptId, queueKind: "control", queueOwnerSha256: evidence.queueOwnerSha256 }, auth), undefined);
          } else {
            assert.equal(store.recordSourceSettlement(routing, { ...request.source, updateIds: [100],
              kind: "queued", receiptId: "foreign", queueKind: "prompt" }, auth), undefined);
            if (evidence.kind === "forwarded") assert.equal(store.recordSourceAcceptance(routing,
              { ...evidence, updateId: 101 }, auth), undefined, "one delivery identity cannot prove two source IDs");
          }
          assert.equal(await readFile(path, "utf8"), published);
          const accepted = store.recordSourceAcceptance(routing, makeEvidence(101), auth)!;
          assert.deepEqual(accepted.routing?.acceptances, [evidence, makeEvidence(101)]);
          const cold = createTelegramTopicTargetStore({ path, canPersist: () => false }); await cold.load();
          assert.deepEqual(restoreStorage(cold).list(), [accepted]);
          const coldBefore = await readFile(path, "utf8");
          assert.equal(getTelegramWorkspaceRestoreSourceCompletionSha256(restoreStorage(cold).list()[0]!, evidence), completionSha256,
            "cold loading and another source's progress retain the same immutable acceptance scope");
          assert.deepEqual(restoreStorage(cold).recordSourceAcceptance(accepted, evidence, auth), accepted,
            "an exact duplicate observes retained proof without canonical publication");
          assert.equal(restoreStorage(cold).recordSourceSettlement(accepted, { ...request.source,
            ...(kind === "queued" ? { kind: "queued", receiptId: "accepted", queueKind: "prompt" } : { kind: "completed" }) }, auth), undefined,
            "a follower read view cannot publish source disposition");
          assert.equal(await readFile(path, "utf8"), coldBefore, "observation leaves the canonical snapshot intact");
          const successor = { ...auth, executor: { instanceId: "successor", leaderEpoch: "next" } };
          const adopted = store.adopt(accepted, successor)!;
          assert.deepEqual(adopted.routing, accepted.routing, "executor succession preserves acceptance and unissued disposition");
          assert.equal(getTelegramWorkspaceRestoreSourceCompletionSha256(adopted, evidence), completionSha256,
            "executor, revision and timestamp changes cannot invalidate an issued source ACK");
          assert.equal(store.recordSourceAcceptance(accepted, evidence, auth), undefined);
          // Storage validates the supplied ACK shape; the composed journal owner must prove its truth.
          const settled = store.recordSourceSettlement(adopted, { ...request.source,
            ...(kind === "queued" ? { kind: "queue-completed", receiptId: "accepted", queueKind: "prompt" } : { kind: "completed" }) }, successor)!;
          assert.ok(settled);
          assert.deepEqual(settled.routing?.acceptances, adopted.routing?.acceptances);
          assert.equal(store.issueCleanup(settled, successor)?.intent.routing?.cleanup, "issued",
            "positive source disposition, not acceptance alone, satisfies the storage cleanup precondition");
        }
        assert.equal(await readFile(options.path, "utf8"), sourceBefore, "storing acceptance never disposes of journal or queued input");
      }, role);
    });
  }
}

for (const scenario of ["prompt", "control", "partial", "no-admission", "legacy", "wrong-receipt", "wrong-kind", "foreign-source", "stale", "authority", "cold-admission-cleanup", "cold-terminal-without-acceptance"] as const) {
  test(`Restore queued admission upgrades only to exact terminal receipt evidence (${scenario})`, async () => {
    await fixture(async ({ store, request, auth, path }) => {
      const ready = store.confirmReady(store.issueRecipient((await store.commit(request, auth))!, recipient("leader"), auth)!.intent,
        recipient("leader"), auth)!;
      let intent = store.issueRouting(ready, auth)!.intent;
      const queueKind = scenario === "control" ? "control" as const : "prompt" as const;
      if (scenario !== "legacy") for (const updateId of request.source.updateIds) intent = store.recordSourceAcceptance(intent, {
        updateId, journalBindingKey: request.source.journalBindingKey, sourceSha256: "a".repeat(64), recipient: recipient("leader"),
        kind: "queued", receiptId: "owned-receipt", queueKind, queueOwnerSha256: "b".repeat(64) }, auth)!;
      const accepted = intent;
      const admission = { ...request.source, kind: "queued" as const, receiptId: "owned-receipt", queueKind };
      if (scenario !== "no-admission") intent = store.recordSourceSettlement(intent, admission, auth)!;
      assert.equal(store.issueCleanup(intent, auth), undefined);
      assert.equal(store.recordCleanup(intent, { kind: "not-issued", target: request.binding.target }, auth), undefined);
      assert.equal(store.retire(intent, auth), undefined);
      const before = await readFile(path, "utf8");
      const terminal = { ...admission, kind: "queue-completed" as const };
      if (scenario.startsWith("cold-")) {
        const snapshot = JSON.parse(before), retained = snapshot.workspaceRestore.operations[0];
        if (scenario === "cold-admission-cleanup") retained.routing.cleanup = "issued";
        else { delete retained.routing.acceptances; retained.routing.settlements[0].kind = "queue-completed"; }
        const forged = JSON.stringify(snapshot); writeFileSync(path, forged, { mode: 0o600 });
        const cold = createTelegramTopicTargetStore({ path });
        await assert.rejects(() => cold.load(), /Invalid Workspace Restore evidence/);
        assert.throws(() => restoreStorage(cold).list(), /Invalid Workspace Restore evidence/);
        assert.equal(await readFile(path, "utf8"), forged, "invalid cold evidence is retained, never repaired");
        return;
      }
      const invalid = scenario === "wrong-receipt" ? { ...terminal, receiptId: "foreign" }
        : scenario === "wrong-kind" ? { ...terminal, queueKind: "control" as const }
        : scenario === "foreign-source" ? { ...terminal, updateIds: [999] } : terminal;
      if (["legacy", "wrong-receipt", "wrong-kind", "foreign-source", "stale", "authority"].includes(scenario)) {
        assert.equal(store.recordSourceSettlement(scenario === "stale" ? accepted : intent, invalid,
          scenario === "authority" ? { ...auth, isCurrent: () => false } : auth), undefined);
        assert.equal(await readFile(path, "utf8"), before, "rejected upgrades preserve all source facts and bytes");
        return;
      }
      if (scenario === "partial") {
        const first = store.recordSourceSettlement(intent, { ...terminal, updateIds: [100] }, auth)!;
        assert.deepEqual(first.routing?.settlements, [{ ...admission, updateIds: [101] }, { ...terminal, updateIds: [100] }]);
        assert.equal(store.issueCleanup(first, auth), undefined, "one terminal member cannot complete another source");
        assert.equal(store.recordSourceSettlement(intent, terminal, auth), undefined, "partial progress invalidates the old CAS");
        intent = store.recordSourceSettlement(first, { ...terminal, updateIds: [101] }, auth)!;
      } else intent = store.recordSourceSettlement(intent, terminal, auth)!;
      assert.ok(intent);
      assert.deepEqual(intent.routing?.acceptances, accepted.routing?.acceptances);
      assert.equal(store.recordSourceSettlement(intent, terminal, auth), undefined, "terminal proof cannot downgrade or duplicate");
      assert.equal(store.recordSourceSettlement(intent, admission, auth), undefined);
      const cold = createTelegramTopicTargetStore({ path, canPersist: () => false }); await cold.load();
      assert.deepEqual(restoreStorage(cold).list(), [intent]);
      assert.equal(store.issueCleanup(intent, auth)?.intent.routing?.cleanup, "issued");
    });
  });
}

for (const tamper of ["empty", "duplicate", "hash", "recipient", "receipt", "settlement", "cleanup"] as const) {
  test(`Cold Restore acceptance rejects malformed or contradictory evidence (${tamper})`, async () => {
    await fixture(async ({ store, request, auth, path }) => {
      const ready = store.confirmReady(store.issueRecipient((await store.commit(request, auth))!, recipient("leader"), auth)!.intent,
        recipient("leader"), auth)!;
      const routing = store.issueRouting(ready, auth)!.intent;
      const evidence: TelegramWorkspaceRestoreSourceAcceptance = { kind: "queued", journalBindingKey: request.source.journalBindingKey,
        updateId: 100, sourceSha256: "a".repeat(64), recipient: recipient("leader"), receiptId: "receipt", queueKind: "prompt",
        queueOwnerSha256: "b".repeat(64) };
      store.recordSourceAcceptance(routing, evidence, auth);
      const snapshot = JSON.parse(await readFile(path, "utf8"));
      const recorded = snapshot.workspaceRestore.operations[0].routing;
      if (tamper === "empty") recorded.acceptances = [];
      if (tamper === "duplicate") recorded.acceptances.push(recorded.acceptances[0]);
      if (tamper === "hash") recorded.acceptances[0].sourceSha256 = "invalid";
      if (tamper === "recipient") recorded.acceptances[0].recipient.sessionId = "foreign";
      if (tamper === "receipt") recorded.acceptances.push({ ...recorded.acceptances[0], updateId: 101, queueOwnerSha256: "c".repeat(64) });
      if (tamper === "settlement") recorded.settlements.push({ kind: "completed", journalBindingKey: request.source.journalBindingKey, updateIds: [100] });
      if (tamper === "cleanup") recorded.cleanup = "issued";
      await writeFile(path, JSON.stringify(snapshot));
      const before = await readFile(path, "utf8");
      const cold = createTelegramTopicTargetStore({ path });
      await assert.rejects(() => cold.load(), /Workspace Restore evidence/);
      assert.throws(() => restoreStorage(cold).list(), /Workspace Restore evidence/);
      assert.equal(await readFile(path, "utf8"), before, "malformed proof is retained without repair");
    });
  });
}

test("Restore snapshots are detached and stale generation is checked before reading source", async () => {
  await fixture(async ({ store, request, auth, path }) => {
    auth.isCurrent = () => false;
    const stale = new Proxy(request, { get() { throw new Error("stale source read"); } });
    const before = await readFile(path, "utf8");
    assert.equal(await store.commit(stale, auth), undefined);
    assert.equal(await readFile(path, "utf8"), before);
    auth.isCurrent = () => true;
    const original = structuredClone(request);
    const prepared = (await store.commit(request, auth))!;
    request.source.updateIds.push(102);
    request.binding.journalBindingKeys!.push("mutated");
    prepared.request.owner.target.threadId = 99;
    assert.deepEqual(store.list()[0]?.request, original);
    assert.equal(await store.commit(request, auth), undefined);
  });
});

test("Restore adoption changes only executor authority and cannot replay an issued recipient", async () => {
  await fixture(async ({ store, open, request, auth }) => {
    const relocated = (await store.commit(request, auth))!;
    const issued = store.issueRecipient(relocated, recipient("follower"), auth)!.intent;
    const next = { ...auth, executor: { instanceId: "next", leaderEpoch: "next-epoch" } };
    assert.equal(await store.commit(request, next), undefined);
    const adopted = open().adopt(issued, next)!;
    assert.deepEqual(adopted, { ...issued, executor: next.executor, revision: issued.revision + 1 });
    assert.equal(store.confirmReady(adopted, recipient("follower"), auth), undefined);
    assert.equal(store.issueRecipient(adopted, recipient("follower"), next), undefined);
    assert.equal(store.adopt(issued, next), undefined);
    assert.equal(store.adopt(adopted, next), undefined);
    assert.equal(store.confirmReady(adopted, recipient("follower"), next)?.phase, "ready");
  });
});

const temporarySource = { journalBindingKey: "all-journal", updateId: 300 };
const temporaryToken = "a".repeat(32);

test("Temporary Thread reservation is durable, single-attempt and slot-free", async () => {
  await fixture(async ({ store, threads, auth, path }) => {
    const slots = structuredClone(threads.listWorkspaceBindings().map(value => value.slot));
    const reserved = store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!;
    assert.equal(reserved.reserved, true);
    assert.equal(reserved.entry.phase, "creating");
    assert.equal(reserved.entry.target, undefined);
    const cold = createTelegramTopicTargetStore({ path }); await cold.load();
    assert.deepEqual(cold.listWorkspaceBindings().map(value => value.slot), slots, "a temporary tab consumes no slot");
    const before = await readFile(path, "utf8");
    const again = store.reserveTemporaryThread(temporarySource, "b".repeat(32), { ...auth, executor: { instanceId: "next", leaderEpoch: "next" } })!;
    assert.deepEqual(again, { reserved: false, entry: reserved.entry }, "an existing source entry never licenses another creation");
    assert.equal(store.reserveTemporaryThread(temporarySource, temporaryToken, { ...auth, operatorUserId: 8 }), undefined);
    assert.equal(store.reserveTemporaryThread({ ...temporarySource, updateId: 301 }, temporaryToken, auth), undefined, "tokens stay unique");
    assert.equal(store.reserveTemporaryThread(temporarySource, "not-a-token", auth)?.reserved, false);
    assert.equal(await readFile(path, "utf8"), before, "refusals and duplicates never write");
    assert.equal(store.acknowledgeTemporaryThread(reserved.entry, { chatId: 8, threadId: 55 }, auth), undefined, "a tab belongs to the operator chat");
    assert.throws(() => store.acknowledgeTemporaryThread(reserved.entry, { chatId: 7, threadId: 10 }, auth),
      /Protected temporary Thread target conflict/, "a bound Workspace target cannot become a temporary tab");
    assert.equal(await readFile(path, "utf8"), before);
    const created = store.acknowledgeTemporaryThread(reserved.entry, { chatId: 7, threadId: 55 }, auth)!;
    assert.equal(created.phase, "created");
    assert.deepEqual(created.target, { chatId: 7, threadId: 55 });
    assert.equal(store.acknowledgeTemporaryThread(created, { chatId: 7, threadId: 56 }, auth), undefined, "a created entry never reopens");
    assert.equal(store.acknowledgeTemporaryThread(reserved.entry, { chatId: 7, threadId: 56 }, auth), undefined, "stale evidence cannot acknowledge");
    const restarted = createTelegramTopicTargetStore({ path }); await restarted.load();
    const reopened = restarted.workspaceRestore({ profileName: "default", tokenSha256: "a".repeat(64), getNowMs: () => 1000 });
    assert.deepEqual(reopened.listTemporaryThreads(), [created]);
    assert.deepEqual(reopened.reserveTemporaryThread(temporarySource, temporaryToken, auth), { reserved: false, entry: created });
  });
});

for (const protection of ["none", "binding", "record", "reservation", "provision", "authority-before-rename"] as const) {
  test(`Implicit temporary registration checks canonical ownership before publication (${protection})`, async () => {
    await fixture(async ({ store, open, threads, auth, path }) => {
      const target = { chatId: 7, threadId: 55 }, input = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [300] };
      if (protection === "binding") threads.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/other", 0, "other")!,
        target, slot: "B", updatedAtMs: 1000 });
      if (protection === "record") threads.upsert({ profileKey: "manual:other", instanceId: "other", target, slot: "B",
        status: "active", createdAtMs: 1, updatedAtMs: 1 });
      if (protection === "reservation") threads.reserveThread({ target, slot: "B", reason: "replacement", createdAtMs: 1, updatedAtMs: 1 });
      if (protection === "provision") threads.upsertPendingProvision({ id: "p", instanceId: "other", owner: "manual-follower", target,
        startedAtMs: 1, expiresAtMs: 2 });
      await threads.persist();
      const before = await readFile(path, "utf8"), bindings = threads.listWorkspaceBindings();
      let current = true;
      const registration = protection === "authority-before-rename" ? open({ onPublicationBoundary(boundary) {
        if (boundary === "after-write-before-rename") current = false;
      } }) : store;
      const entry = registration.registerImplicitTemporaryThread(input, target, temporaryToken, { ...auth, isCurrent: () => current });
      if (protection === "none") {
        assert.equal(entry?.phase, "created"); assert.deepEqual(entry?.target, target); assert.deepEqual(entry?.inputs, [input]);
        assert.equal(entry?.cleanupIssued, undefined, "Observation does not issue deletion");
        assert.deepEqual(open().listTemporaryThreads(), [entry]);
        const recorded = await readFile(path, "utf8");
        assert.equal(store.registerImplicitTemporaryThread(input, target, "b".repeat(32), auth), undefined, "Target/source reuse is not another grant");
        assert.equal(await readFile(path, "utf8"), recorded);
      } else {
        assert.equal(entry, undefined); assert.equal(await readFile(path, "utf8"), before);
      }
      assert.deepEqual(threads.listWorkspaceBindings(), bindings, "Registration never changes Workspace ownership or slots");
    });
  });
}

test("Temporary Thread input membership is grouped, exact, append-only and cold-readable", async () => {
  await fixture(async ({ store, open, threads, auth, request, path }) => {
    const created = store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry,
      request.target, auth)!;
    const input = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [301, 302] };
    const recorded = store.recordTemporaryThreadInput(created, input, auth)!;
    assert.deepEqual(recorded.inputs, [
      { journalBindingKey: temporarySource.journalBindingKey, updateIds: [300] }, input,
    ]);
    assert.equal(recorded.revision, created.revision + 1);
    const before = await readFile(path, "utf8");
    assert.deepEqual(store.recordTemporaryThreadInput(recorded, input, auth), recorded);
    assert.equal(store.recordTemporaryThreadInput(created, input, auth), undefined, "stale CAS cannot lend current authority");
    for (const invalid of [
      { journalBindingKey: "foreign-journal", updateIds: [303] },
      { journalBindingKey: temporarySource.journalBindingKey, updateIds: [] },
      { journalBindingKey: temporarySource.journalBindingKey, updateIds: [303, 303] },
      { journalBindingKey: temporarySource.journalBindingKey, updateIds: [304, 303] },
      { journalBindingKey: temporarySource.journalBindingKey, updateIds: [302, 303] },
    ]) assert.equal(store.recordTemporaryThreadInput(recorded, invalid, auth), undefined);
    assert.equal(store.recordTemporaryThreadInput(recorded, { ...input, updateIds: [303] }, { ...auth, operatorUserId: 8 }), undefined);
    assert.equal(store.recordTemporaryThreadInput(recorded, { ...input, updateIds: [303] }, { ...auth, isCurrent: () => false }), undefined);
    assert.equal(store.retireTemporaryThread(recorded, auth), undefined, "membership is not terminal sibling disposition proof");
    assert.equal(await readFile(path, "utf8"), before, "duplicates and refusals do not write");
    input.updateIds.push(999);
    const detached = getTelegramTemporaryThreadInputs(recorded); detached[1]!.updateIds.push(998);
    const cold = createTelegramTopicTargetStore({ path }); await cold.load();
    const reopened = open({ threadStore: cold });
    assert.deepEqual(reopened.listTemporaryThreads(), [recorded]);
    assert.deepEqual(reopened.listTemporaryThreads()[0]?.inputs?.[1]?.updateIds, [301, 302], "caller mutations cannot alter membership");
    for (const updateIds of [[301], [301, 303]]) {
      assert.equal(await reopened.commit({ ...request, source: { journalBindingKey: temporarySource.journalBindingKey, updateIds } }, auth).catch(() => undefined), undefined,
        "partial or changed group membership cannot authorize Restore");
      assert.equal(await readFile(path, "utf8"), before);
    }
    const memberRestore = await reopened.commit({ ...request, source: { journalBindingKey: temporarySource.journalBindingKey, updateIds: [301, 302] } }, auth);
    assert.ok(memberRestore, "an exact recorded sibling group may Restore into this tab");
    assert.equal(reopened.recordTemporaryThreadInput(recorded, { ...input, updateIds: [303] }, auth), undefined,
      "an already-restored tab cannot acquire more temporary membership");
    assert.equal(threads.listWorkspaceBindings()[0]?.slot, "A");
  });
});

for (const scenario of ["exact", "missing", "partial", "foreign-binding", "foreign-owner", "foreign-id", "throws",
  "authority-after-read", "operator-after-read", "executor-after-read", "proof-before-rename", "proof-after-rename", "lost-publication-reply"] as const) {
  test(`Temporary input cancellation requires fresh whole-group journal proof (${scenario})`, async () => {
    await fixture(async ({ store, open, auth, path }) => {
      let entry = store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry,
        { chatId: 7, threadId: 55 }, auth)!;
      const input = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [301, 302] };
      entry = store.recordTemporaryThreadInput(entry, input, auth)!;
      const before = await readFile(path, "utf8");
      let proofAvailable = true, reads = 0;
      const inspect = (updateId: number) => {
        reads++;
        if (!proofAvailable || scenario === "missing" || (scenario === "partial" && updateId === 302)) return undefined;
        if (scenario === "throws") throw new Error("Fixture retained evidence unreadable");
        const evidence = { journalBindingKey: input.journalBindingKey, updateId, operatorAuthorityId: "telegram-owner:7" };
        if (scenario === "foreign-binding") evidence.journalBindingKey = "foreign";
        if (scenario === "foreign-owner") evidence.operatorAuthorityId = "telegram-owner:8";
        if (scenario === "foreign-id") evidence.updateId = 999;
        if (scenario === "authority-after-read") auth.isCurrent = () => false;
        if (scenario === "operator-after-read") auth.operatorUserId = 8;
        if (scenario === "executor-after-read") auth.executor = { instanceId: "foreign", leaderEpoch: "foreign" };
        return evidence;
      };
      const observedStore = open({ onPublicationBoundary(point) {
        if (scenario === "proof-before-rename" && point === "after-write-before-rename") proofAvailable = false;
        if (scenario === "proof-after-rename" && point === "after-rename") proofAvailable = false;
        if (scenario === "lost-publication-reply" && point === "after-rename") throw new Error("Fixture cancellation publication reply lost");
      } });
      let recorded;
      if (scenario === "throws" || scenario === "lost-publication-reply") {
        assert.throws(() => observedStore.recordTemporaryThreadInputCancellation(entry, input, auth, inspect), /Fixture/);
      } else recorded = observedStore.recordTemporaryThreadInputCancellation(entry, input, auth, inspect);
      const published = scenario === "exact" || scenario === "proof-after-rename" || scenario === "lost-publication-reply";
      assert.equal(store.listTemporaryThreads()[0]?.cancelledInputs?.length ?? 0, published ? 1 : 0);
      assert.equal(!!recorded, scenario === "exact", "publication cannot acknowledge ended ownership or missing readback proof");
      if (!published) assert.equal(await readFile(path, "utf8"), before);
      assert.ok(reads > 0);
      if (scenario === "exact" || scenario === "lost-publication-reply") {
        const current = store.listTemporaryThreads()[0]!;
        const bytes = await readFile(path, "utf8");
        assert.deepEqual(store.recordTemporaryThreadInputCancellation(current, input, auth, inspect), current);
        assert.equal(await readFile(path, "utf8"), bytes, "exact duplicate reconciliation is read-only");
        assert.equal(store.retireTemporaryThread(current, auth), undefined, "cancelled membership alone is not deletion authority");
        const cold = createTelegramTopicTargetStore({ path }); await cold.load();
        assert.deepEqual(open({ threadStore: cold }).listTemporaryThreads(), [current]);
      }
    });
  });
}

test("Forward-completed groups resolve a multi-input tab alongside cancelled groups", async () => {
  await fixture(async ({ store, open, request, auth, path }) => {
    let entry = store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry, request.target, auth)!;
    const first = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [temporarySource.updateId] };
    const second = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [301, 302] };
    entry = store.recordTemporaryThreadInput(entry, second, auth)!;
    const proof = (updateId: number) => ({ journalBindingKey: temporarySource.journalBindingKey, updateId, operatorAuthorityId: "telegram-owner:7" });
    assert.equal(store.recordTemporaryThreadInputCompletion(entry, { ...first, updateIds: [999] }, auth), undefined, "the group must be known");
    entry = store.recordTemporaryThreadInputCompletion(entry, first, auth)!;
    assert.deepEqual(entry.completedInputs, [first]);
    const bytes = await readFile(path, "utf8");
    assert.deepEqual(store.recordTemporaryThreadInputCompletion(entry, first, auth), entry);
    assert.equal(await readFile(path, "utf8"), bytes, "an exact duplicate is read-only");
    assert.equal(isTelegramTemporaryThreadFullyResolved(entry), false);
    assert.equal(store.retireTemporaryThread(entry, auth), undefined, "an unresolved group keeps the tab");
    assert.equal(store.recordTemporaryThreadInputCancellation(entry, first, auth, proof), undefined, "a completed group cannot be cancelled");
    const cold = createTelegramTopicTargetStore({ path }); await cold.load();
    assert.deepEqual(open({ threadStore: cold }).listTemporaryThreads()[0]?.completedInputs, [first]);
    entry = store.recordTemporaryThreadInputCancellation(entry, second, auth, proof)!;
    assert.equal(isTelegramTemporaryThreadFullyResolved(entry), true);
    assert.equal(store.recordTemporaryThreadInputCompletion(entry, second, auth), undefined, "a cancelled group cannot be completed");
    assert.deepEqual(store.retireTemporaryThread(entry, auth), entry, "completed plus cancelled groups release the tab");
    assert.deepEqual(store.listTemporaryThreads(), []);
  });
});

for (const scenario of ["independent", "restore-owned", "foreign-target", "partial-overlap"] as const) {
  test(`Forward facts during Restore belong only to independent input groups (${scenario})`, async () => {
    await fixture(async ({ store, open, request, auth, path }) => {
      let entry = store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry, request.target, auth)!;
      const origin = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [temporarySource.updateId] };
      request.source.journalBindingKey = temporarySource.journalBindingKey;
      entry = store.recordTemporaryThreadInput(entry, request.source, auth)!;
      assert.ok(entry);
      if (scenario === "foreign-target") request.target = { chatId: 7, threadId: 56 };
      assert.ok(await store.commit(request, auth));
      if (scenario === "partial-overlap") {
        const disk = JSON.parse(await readFile(path, "utf8"));
        disk.workspaceRestore.operations[0].request.source.updateIds = [request.source.updateIds[0]];
        await writeFile(path, JSON.stringify(disk));
        const before = await readFile(path, "utf8");
        assert.throws(() => store.recordTemporaryThreadInputCompletion(entry, request.source, auth), /Conflicting Workspace Restore evidence/);
        assert.throws(() => store.recordTemporaryThreadInputCancellation(entry, request.source, auth, updateId => ({
          journalBindingKey: request.source.journalBindingKey, updateId, operatorAuthorityId: "telegram-owner:7" })), /Conflicting Workspace Restore evidence/);
        assert.equal(await readFile(path, "utf8"), before, "partial source evidence stays protective and is never repaired into a grant");
        return;
      }
      const before = await readFile(path, "utf8"), intents = store.list();
      const input = scenario === "independent" ? origin : request.source;
      const recorded = store.recordTemporaryThreadInputCompletion(entry, input, auth);
      if (scenario === "independent") {
        assert.ok(recorded);
        assert.deepEqual(recorded.completedInputs, [origin]);
        assert.equal(store.retireTemporaryThread(recorded, auth), undefined, "the Restore group is not Forward-completed");
        const cold = createTelegramTopicTargetStore({ path }); await cold.load();
        assert.deepEqual(open({ threadStore: cold }).listTemporaryThreads(), [recorded]);
      } else {
        assert.equal(recorded, undefined, "even partial selected-source overlap cannot borrow Forward completion");
        assert.equal(store.recordTemporaryThreadInputCancellation(entry, input, auth, updateId => ({
          journalBindingKey: input.journalBindingKey, updateId, operatorAuthorityId: "telegram-owner:7" })), undefined,
          "retention alone cannot cancel any selected Restore source");
        assert.equal(await readFile(path, "utf8"), before);
      }
      assert.deepEqual(store.list(), intents, "Forward metadata cannot mutate the Restore grant");
    });
  });
}

test("A durable Forward issuance fact is one-time and blocks cancellation and Restore of its group", async () => {
  await fixture(async ({ store, open, request, auth, path }) => {
    let entry = store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry, request.target, auth)!;
    const first = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [temporarySource.updateId] };
    const second = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [301] };
    entry = store.recordTemporaryThreadInput(entry, second, auth)!;
    const proof = (updateId: number) => ({ journalBindingKey: temporarySource.journalBindingKey, updateId, operatorAuthorityId: "telegram-owner:7" });
    assert.equal(store.recordTemporaryThreadForwardIssued(entry, { ...first, updateIds: [999] }, auth), undefined, "the group must be known");
    const issued = store.recordTemporaryThreadForwardIssued(entry, first, auth)!;
    assert.deepEqual(issued.forwardedInputs, [first]);
    const bytes = await readFile(path, "utf8");
    assert.equal(store.recordTemporaryThreadForwardIssued(issued, first, auth), undefined, "a second issuance is refused, never replayed");
    assert.equal(await readFile(path, "utf8"), bytes);
    const cold = createTelegramTopicTargetStore({ path }); await cold.load();
    assert.deepEqual(open({ threadStore: cold }).listTemporaryThreads()[0]?.forwardedInputs, [first], "issuance survives restart");
    assert.equal(open({ threadStore: cold }).recordTemporaryThreadForwardIssued(open({ threadStore: cold }).listTemporaryThreads()[0]!, first, auth), undefined);
    assert.equal(store.recordTemporaryThreadInputCancellation(issued, first, auth, proof), undefined, "issued unknown work cannot be cancelled");
    assert.equal(isTelegramTemporaryThreadFullyResolved(issued), false, "issuance is not resolution");
    assert.equal(store.retireTemporaryThread(issued, auth), undefined);
    const sibling = store.recordTemporaryThreadInputCancellation(issued, second, auth, proof)!;
    assert.equal(isTelegramTemporaryThreadFullyResolved(sibling), false, "an independently cancelled sibling does not resolve issued Forward");
    const done = store.recordTemporaryThreadInputCompletion(sibling, first, auth)!;
    assert.equal(isTelegramTemporaryThreadFullyResolved(done), true, "positive completion resolves the issued group");
    assert.deepEqual(done.forwardedInputs, [first]);
    assert.equal(store.retireTemporaryThread(done, auth)?.token, temporaryToken);
  });
});

for (const fault of ["restore-overlap", "cancelled", "legacy-fields", "invalid-subset", "creating"] as const) {
  test(`Forward issuance refuses unsafe groups and validates cold evidence (${fault})`, async () => {
    await fixture(async ({ store, open, request, auth, path }) => {
      let entry = store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry, request.target, auth)!;
      const first = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [temporarySource.updateId] };
      const proof = (updateId: number) => ({ journalBindingKey: temporarySource.journalBindingKey, updateId, operatorAuthorityId: "telegram-owner:7" });
      if (fault === "restore-overlap") {
        request.source = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [temporarySource.updateId] };
        request.target = entry.target!;
        assert.ok(await store.commit(request, auth));
        assert.equal(store.recordTemporaryThreadForwardIssued(entry, first, auth), undefined, "a Restore-owned group cannot be Forwarded");
      } else if (fault === "cancelled") {
        entry = store.recordTemporaryThreadInputCancellation(entry, first, auth, proof)!;
        assert.equal(store.recordTemporaryThreadForwardIssued(entry, first, auth), undefined);
      } else if (fault === "creating") {
        const reserved = store.reserveTemporaryThread({ ...temporarySource, updateId: 777 }, "d".repeat(32), auth)!.entry;
        assert.equal(store.recordTemporaryThreadForwardIssued(reserved, { ...first, updateIds: [777] }, auth), undefined, "unknown creation cannot Forward");
        const disk = JSON.parse(await readFile(path, "utf8"));
        disk.workspaceRestore.temporaryThreads.find((value: { token: string }) => value.token === "d".repeat(32)).forwardedInputs = [{ ...first, updateIds: [777] }];
        await writeFile(path, JSON.stringify(disk));
        assert.throws(() => open().listTemporaryThreads(), /Invalid Workspace Restore evidence/);
      } else {
        assert.ok(store.recordTemporaryThreadForwardIssued(entry, first, auth));
        const disk = JSON.parse(await readFile(path, "utf8"));
        const stored = disk.workspaceRestore.temporaryThreads[0];
        if (fault === "invalid-subset") stored.forwardedInputs = [{ ...first, updateIds: [999] }];
        else stored.forwardedInputs = [...stored.forwardedInputs, ...stored.forwardedInputs];
        await writeFile(path, JSON.stringify(disk));
        assert.throws(() => open().listTemporaryThreads(), /Invalid Workspace Restore evidence/);
      }
    });
  });
}

test("A multi-input temporary tab is released only by one completed group with every other group cancelled", async () => {
  await fixture(async ({ store, request, auth }) => {
    let entry = store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry, request.target, auth)!;
    const first = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [temporarySource.updateId] };
    const second = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [301] };
    const third = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [302] };
    for (const input of [second, third]) entry = store.recordTemporaryThreadInput(entry, input, auth)!;
    const proof = (updateId: number) => ({ journalBindingKey: temporarySource.journalBindingKey, updateId, operatorAuthorityId: "telegram-owner:7" });
    assert.equal(store.retireTemporaryThread(entry, auth), undefined, "ordinary retirement still needs one known group");
    assert.equal(store.retireTemporaryThread(entry, auth, first), undefined, "uncancelled siblings protect the tab");
    entry = store.recordTemporaryThreadInputCancellation(entry, second, auth, proof)!;
    assert.equal(store.retireTemporaryThread(entry, auth, first), undefined, "every other group must be cancelled");
    entry = store.recordTemporaryThreadInputCancellation(entry, third, auth, proof)!;
    assert.equal(store.retireTemporaryThread(entry, auth, { ...first, updateIds: [999] }), undefined, "the completed group must be known");
    assert.equal(store.retireTemporaryThread(entry, auth, second), undefined, "a cancelled group is not a completion");
    assert.deepEqual(store.listTemporaryThreads(), [entry]);
    assert.deepEqual(store.retireTemporaryThread(entry, auth, first), entry);
    assert.deepEqual(store.listTemporaryThreads(), []);
  });
});

test("Cancelled temporary inputs cannot Restore but do not cancel an independent source", async () => {
  await fixture(async ({ store, request, auth, path }) => {
    let entry = store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry, request.target, auth)!;
    const input = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [301, 302] };
    entry = store.recordTemporaryThreadInput(entry, input, auth)!;
    entry = store.recordTemporaryThreadInputCancellation(entry, input, auth,
      updateId => ({ journalBindingKey: input.journalBindingKey, updateId, operatorAuthorityId: "telegram-owner:7" }))!;
    const before = await readFile(path, "utf8");
    for (const updateIds of [[301, 302], [301], [300, 301]]) {
      assert.equal(await store.commit({ ...request, source: { journalBindingKey: input.journalBindingKey, updateIds } }, auth).catch(() => undefined), undefined);
      assert.equal(await readFile(path, "utf8"), before);
    }
    assert.ok(await store.commit({ ...request, source: { journalBindingKey: input.journalBindingKey, updateIds: [300] } }, auth));
    assert.equal(store.recordTemporaryThreadInputCancellation(store.listTemporaryThreads()[0]!,
      { journalBindingKey: input.journalBindingKey, updateIds: [300] }, auth,
      updateId => ({ journalBindingKey: input.journalBindingKey, updateId, operatorAuthorityId: "telegram-owner:7" })), undefined,
      "an issued/retained Restore source cannot become an ordinary cancellation fact");
  });
});

test("Temporary Thread membership rejects overlapping ownership and malformed cold evidence", async () => {
  await fixture(async ({ store, auth, path }) => {
    let entry = store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry,
      { chatId: 7, threadId: 55 }, auth)!;
    entry = store.recordTemporaryThreadInput(entry, { journalBindingKey: temporarySource.journalBindingKey, updateIds: [301, 302] }, auth)!;
    const other = store.acknowledgeTemporaryThread(store.reserveTemporaryThread({ ...temporarySource, updateId: 400 }, "b".repeat(32), auth)!.entry,
      { chatId: 7, threadId: 56 }, auth)!;
    const valid = await readFile(path, "utf8");
    assert.equal(store.recordTemporaryThreadInput(other, { journalBindingKey: temporarySource.journalBindingKey, updateIds: [302, 401] }, auth), undefined);
    assert.equal(store.reserveTemporaryThread({ ...temporarySource, updateId: 301 }, "c".repeat(32), auth), undefined);
    for (const mutation of ["empty", "missing-origin", "duplicate", "foreign", "extra", "too-many", "overlap",
      "cancelled-empty", "cancelled-unknown", "cancelled-partial", "cancelled-duplicate"] as const) {
      const file = JSON.parse(valid), entries = file.workspaceRestore.temporaryThreads;
      if (mutation === "empty") entries[0].inputs = [];
      if (mutation === "missing-origin") entries[0].inputs.shift();
      if (mutation === "duplicate") entries[0].inputs[1].updateIds = [301, 301];
      if (mutation === "foreign") entries[0].inputs[1].journalBindingKey = "foreign";
      if (mutation === "extra") entries[0].inputs[1].ready = true;
      if (mutation === "too-many") entries[0].inputs[1].updateIds = Array.from({ length: 101 }, (_, i) => 500 + i);
      if (mutation === "overlap") entries[1].inputs.push(entries[0].inputs[1]);
      if (mutation === "cancelled-empty") entries[0].cancelledInputs = [];
      if (mutation === "cancelled-unknown") entries[0].cancelledInputs = [{ journalBindingKey: "all-journal", updateIds: [999] }];
      if (mutation === "cancelled-partial") entries[0].cancelledInputs = [{ journalBindingKey: "all-journal", updateIds: [301] }];
      if (mutation === "cancelled-duplicate") entries[0].cancelledInputs = [entries[0].inputs[1], entries[0].inputs[1]];
      const bytes = JSON.stringify(file); await writeFile(path, bytes);
      assert.throws(() => store.listTemporaryThreads(), /Invalid|Conflicting Workspace Restore evidence/);
      assert.equal(await readFile(path, "utf8"), bytes, "invalid membership is never repaired into empty authority");
    }
    await writeFile(path, valid);
  });
});

for (const conflict of ["provision", "reservation", "binding", "record"] as const) {
  test(`Temporary Thread targets stay protected from Workspace claims (${conflict})`, async () => {
    await fixture(async ({ store, threads, auth, path }) => {
      const target = { chatId: 7, threadId: 55 };
      store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry, target, auth);
      await threads.load();
      const before = await readFile(path, "utf8");
      if (conflict === "provision") {
        assert.throws(() => threads.upsertPendingProvision({ id: "p", instanceId: "other", owner: "manual-follower", target,
          startedAtMs: 1, expiresAtMs: 2 }), /Protected Workspace Restore provisioning conflict/);
        return;
      }
      if (conflict === "reservation") {
        assert.throws(() => threads.reserveThread({ target, slot: "B", reason: "replacement", createdAtMs: 1, updatedAtMs: 1 }),
          /Protected Workspace Restore provisioning conflict/);
        return;
      }
      if (conflict === "binding") threads.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/other", 0, "other")!,
        target, slot: "B", updatedAtMs: 1000 });
      else threads.upsert({ profileKey: "manual:other", owner: { kind: "manual-follower", instanceId: "other" }, instanceId: "other",
        target, slot: "B", status: "active", createdAtMs: 1, updatedAtMs: 1 });
      await assert.rejects(() => threads.persist(), /Protected temporary Thread target conflict/);
      assert.equal(await readFile(path, "utf8"), before, "a refused claim leaves canonical bytes intact");
    });
  });
}

for (const source of ["same", "foreign"] as const) {
  test(`Only the same source may Restore into its temporary Thread (${source})`, async () => {
    await fixture(async ({ store, threads, request, auth }) => {
      const entry = store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry,
        request.target, auth)!;
      const restore = { ...request, source: source === "same"
        ? { journalBindingKey: temporarySource.journalBindingKey, updateIds: [temporarySource.updateId] } : request.source };
      const committed = await store.commit(restore, auth).catch(() => undefined);
      if (source === "foreign") {
        assert.equal(committed, undefined);
        assert.deepEqual(store.list(), []);
        assert.notDeepEqual(threads.listWorkspaceBindings()[0]?.target, request.target);
        return;
      }
      assert.equal(committed?.phase, "relocated");
      await threads.load();
      assert.deepEqual(threads.listWorkspaceBindings()[0]?.target, request.target, "Restore rebinds the existing slot to the tab");
      assert.equal(threads.listWorkspaceBindings()[0]?.slot, "A");
      assert.deepEqual(store.listTemporaryThreads(), [entry], "the tab stays protected until its entry is explicitly retired");
    });
  });
}

for (const fault of ["none", "unissued", "ended-authority", "foreign-executor", "foreign-operator", "bound", "unknown-provision", "malformed"] as const) {
  test(`Issued temporary cleanup inspection is an exact read-only veto, never a new grant (${fault})`, async () => {
    await fixture(async ({ store, auth, path }) => {
      let entry = store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry,
        { chatId: 7, threadId: 55 }, auth)!;
      const group = getTelegramTemporaryThreadInputs(entry)[0];
      entry = store.recordTemporaryThreadInputCancellation(entry, group, auth, id => ({ journalBindingKey: group.journalBindingKey,
        updateId: id, operatorAuthorityId: "telegram-owner:7" }))!;
      const unissued = entry;
      entry = store.issueTemporaryThreadCleanup(entry, auth)!.entry;
      if (["bound", "unknown-provision", "malformed"].includes(fault)) {
        const file = JSON.parse(await readFile(path, "utf8"));
        if (fault === "bound") file.workspaceBindings[0].target = entry.target;
        if (fault === "unknown-provision") file.pendingProvisions = [{ id: "unknown", owner: "leader", instanceId: "other", startedAtMs: 1 }];
        if (fault === "malformed") file.threads.push({ owner: "unknown" });
        await writeFile(path, JSON.stringify(file));
      }
      const bytes = await readFile(path, "utf8");
      const authority = fault === "ended-authority" ? { ...auth, isCurrent: () => false } : fault === "foreign-executor"
        ? { ...auth, executor: { instanceId: "other", leaderEpoch: "other" } } : fault === "foreign-operator" ? { ...auth, operatorUserId: 8 } : auth;
      if (fault === "bound" || fault === "malformed") assert.throws(() => store.isTemporaryThreadCleanupCurrent(entry, authority),
        /Protected temporary Thread target conflict|Invalid temporary Thread target evidence/);
      else assert.equal(store.isTemporaryThreadCleanupCurrent(fault === "unissued" ? unissued : entry, authority), fault === "none");
      assert.equal(await readFile(path, "utf8"), bytes, "inspection never repairs, adopts, mutates or consumes the issuance marker");
      if (fault === "none") {
        assert.equal(store.inspectTemporaryThreadTarget(entry, auth)?.kind, "unknown", "an issued target never becomes optimistically disposable");
        assert.equal(store.issueTemporaryThreadCleanup(entry, auth), undefined, "a positive guard observation licenses no second attempt");
      }
    });
  });
}

for (const fault of ["none", "unresolved", "stale-frame", "ended-authority", "unknown-provision", "before-rename", "after-rename", "canonical-drift"] as const) {
  test(`Temporary cleanup issuance is durable, exact and non-replayable (${fault})`, async () => {
    await fixture(async ({ store, open, threads, auth, path }) => {
      let entry = store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry,
        { chatId: 7, threadId: 55 }, auth)!;
      const first = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [300] };
      const second = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [301] };
      const proof = (updateId: number) => ({ journalBindingKey: temporarySource.journalBindingKey, updateId, operatorAuthorityId: "telegram-owner:7" });
      entry = store.recordTemporaryThreadInput(entry, second, auth)!;
      entry = store.recordTemporaryThreadInputCancellation(entry, first, auth, proof)!;
      const incomplete = entry;
      if (fault !== "unresolved") entry = store.recordTemporaryThreadInputCancellation(entry, second, auth, proof)!;
      const ownerImages = threads.listWorkspaceBindings();
      const before = await readFile(path, "utf8");
      if (fault === "unknown-provision") {
        const disk = JSON.parse(before);
        disk.pendingProvisions = [{ id: "unknown", owner: "leader", instanceId: "other", startedAtMs: 1 }];
        await writeFile(path, JSON.stringify(disk));
      }
      const retained = await readFile(path, "utf8");
      const contender = open();
      const active = fault === "ended-authority" ? { ...auth, isCurrent: () => false } : auth;
      const candidate = fault === "stale-frame" ? incomplete : entry;
      const publication = open({ onPublicationBoundary: boundary => {
        if (fault === "before-rename" && boundary === "after-write-before-rename") throw new Error("issuance fault before rename");
        if (fault === "after-rename" && boundary === "after-rename") throw new Error("issuance fault after rename");
        if (fault === "canonical-drift" && boundary === "after-write-before-rename") {
          const disk = JSON.parse(retained);
          disk.pendingProvisions = [{ id: "late-unknown", owner: "leader", instanceId: "other", startedAtMs: 1 }];
          writeFileSync(path, JSON.stringify(disk));
        }
      } });
      if (["before-rename", "after-rename", "canonical-drift"].includes(fault)) {
        assert.throws(() => publication.issueTemporaryThreadCleanup(candidate, active), /issuance fault|evidence changed before publication/);
      } else {
        const result = publication.issueTemporaryThreadCleanup(candidate, active);
        assert.equal(result?.issued, fault === "none" ? true : undefined);
      }
      const cold = createTelegramTopicTargetStore({ path }); await cold.load();
      const successor = open({ threadStore: cold });
      const observed = successor.listTemporaryThreads()[0]!;
      assert.equal(observed.cleanupIssued, fault === "none" || fault === "after-rename" ? true : undefined);
      assert.deepEqual(cold.listWorkspaceBindings(), ownerImages, "issuance never changes any Workspace or slot");
      assert.deepEqual(observed.inputs, entry.inputs);
      assert.deepEqual(observed.cancelledInputs, entry.cancelledInputs, "no source settlement is fabricated by issuance");
      if (observed.cleanupIssued) {
        const bytes = await readFile(path, "utf8");
        assert.equal(contender.issueTemporaryThreadCleanup(entry, auth), undefined, "a separately captured contender cannot acquire another attempt");
        assert.equal(successor.issueTemporaryThreadCleanup(observed, auth), undefined, "cold issued state is never a retry grant");
        assert.equal(successor.inspectTemporaryThreadTarget(observed, auth)?.kind, "unknown", "unknown deletion cannot be classified as disposable");
        assert.equal(successor.recordTemporaryThreadInput(observed, { ...first, updateIds: [302] }, auth), undefined);
        assert.equal(await readFile(path, "utf8"), bytes, "duplicate issuance, inspection and refused membership never rewrite the marker");
        const next = { ...auth, executor: { instanceId: "next", leaderEpoch: "next" } };
        const adopted = successor.adoptTemporaryThread(observed, next)!;
        assert.equal(adopted.cleanupIssued, true, "adoption never resets issuance");
        assert.equal(successor.issueTemporaryThreadCleanup(adopted, next), undefined);
        assert.equal(successor.reserveTemporaryThread(temporarySource, temporaryToken, next)?.reserved, false, "retained custody cannot create a replacement tab");
      } else if (fault !== "canonical-drift") {
        assert.equal(await readFile(path, "utf8"), retained, "refusal/pre-publication loss changes no canonical bytes");
        if (fault === "before-rename") assert.equal(successor.issueTemporaryThreadCleanup(observed, auth)?.issued, true,
          "a positively unpublished attempt may receive its first grant; no transport was issued");
      }
    });
  });
}

test("Temporary cleanup marker rejects malformed and nonterminal cold evidence", async () => {
  await fixture(async ({ store, auth, path }) => {
    store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry,
      { chatId: 7, threadId: 55 }, auth);
    const valid = await readFile(path, "utf8");
    for (const marker of [false, "issued", true]) {
      const disk = JSON.parse(valid); disk.workspaceRestore.temporaryThreads[0].cleanupIssued = marker;
      const bytes = JSON.stringify(disk); await writeFile(path, bytes);
      assert.throws(() => store.listTemporaryThreads(), /Invalid Workspace Restore evidence/);
      assert.equal(await readFile(path, "utf8"), bytes, "invalid issuance is never repaired away");
    }
  });
});

for (const kind of ["legacy", "unknown-protocol", "missing-membership"] as const) {
  test(`Temporary Forward coverage is creation-only and strict (${kind})`, async () => {
    await fixture(async ({ store, open, auth, path }) => {
      const reserved = store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry;
      assert.equal(reserved.forwardProtocol, "one-shot-v1");
      store.acknowledgeTemporaryThread(reserved, { chatId: 7, threadId: 55 }, auth);
      const disk = JSON.parse(await readFile(path, "utf8")), entry = disk.workspaceRestore.temporaryThreads[0];
      if (kind === "legacy") delete entry.forwardProtocol;
      if (kind === "unknown-protocol") entry.forwardProtocol = "one-shot-v2";
      if (kind === "missing-membership") delete entry.inputs;
      await writeFile(path, JSON.stringify(disk));
      const cold = createTelegramTopicTargetStore({ path, getNowMs: () => 1000 });
      const retained = open({ threadStore: cold });
      if (kind !== "legacy") {
        assert.throws(() => retained.listTemporaryThreads(), /Invalid Workspace Restore evidence/);
        return;
      }
      const legacy = retained.listTemporaryThreads()[0]!;
      assert.equal(legacy.forwardProtocol, undefined, "an absent legacy field cannot establish unissued coverage");
      const next = { ...auth, executor: { instanceId: "next", leaderEpoch: "next" } };
      let adopted = retained.adoptTemporaryThread(legacy, next)!;
      assert.equal(adopted.forwardProtocol, undefined, "adoption is never a protocol upgrade");
      assert.equal(retained.reserveTemporaryThread(temporarySource, temporaryToken, next)?.entry.forwardProtocol, undefined,
        "reuse is never another creation or coverage publication");
      const group = { journalBindingKey: temporarySource.journalBindingKey, updateIds: [301] };
      adopted = retained.recordTemporaryThreadInput(adopted, group, next)!;
      const issued = retained.recordTemporaryThreadForwardIssued(adopted, group, next)!;
      assert.equal(issued.forwardProtocol, undefined, "one new group grant cannot certify that legacy groups never ran");
      assert.deepEqual(issued.forwardedInputs, [group]);
    });
  });
}

test("Temporary Thread retirement is exact, executor-fenced and monotonic", async () => {
  await fixture(async ({ store, auth, path }) => {
    const created = store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry,
      { chatId: 7, threadId: 55 }, auth)!;
    const revision = JSON.parse(await readFile(path, "utf8")).workspaceRestore.revision;
    const next = { ...auth, executor: { instanceId: "next", leaderEpoch: "next" } };
    assert.equal(store.retireTemporaryThread(created, next), undefined, "an unadopted executor cannot retire");
    const adopted = store.adoptTemporaryThread(created, next)!;
    assert.deepEqual(adopted.executor, next.executor);
    assert.equal(store.retireTemporaryThread(created, next), undefined, "stale evidence cannot retire");
    assert.equal(store.retireTemporaryThread(adopted, auth), undefined, "the predecessor is fenced after adoption");
    assert.deepEqual(store.retireTemporaryThread(adopted, next), adopted);
    const file = JSON.parse(await readFile(path, "utf8")).workspaceRestore;
    assert.equal(file.temporaryThreads, undefined);
    assert.ok(file.revision > revision, "retirement keeps the revision monotonic");
    assert.equal(store.retireTemporaryThread(adopted, next), undefined);
    const reused = store.reserveTemporaryThread(temporarySource, temporaryToken, next)!;
    assert.equal(reused.reserved, true, "only explicit retirement frees the source for a later attempt");
  });
});

test("Temporary Thread evidence is strict and bounded", async () => {
  await fixture(async ({ store, auth, path }) => {
    for (let index = 0; index < 26; index += 1) {
      store.reserveTemporaryThread({ ...temporarySource, updateId: 400 + index }, index.toString(16).padStart(32, "0"), auth);
    }
    assert.throws(() => store.reserveTemporaryThread(temporarySource, temporaryToken, auth), /Temporary Thread capacity reached/);
    const valid = await readFile(path, "utf8");
    for (const tamper of ["token", "duplicate-source", "empty", "target-chat"] as const) {
      const file = JSON.parse(valid);
      const entries = file.workspaceRestore.temporaryThreads;
      if (tamper === "token") entries[0].token = "short";
      if (tamper === "duplicate-source") entries[1].source = entries[0].source;
      if (tamper === "empty") file.workspaceRestore.temporaryThreads = [];
      if (tamper === "target-chat") Object.assign(entries[0], { phase: "created", target: { chatId: 8, threadId: 5 } });
      await writeFile(path, JSON.stringify(file), { mode: 0o600 });
      const cold = createTelegramTopicTargetStore({ path });
      await assert.rejects(() => cold.load(), /Workspace Restore evidence/, tamper);
    }
  });
});

test("Generic cleanup protection covers temporary tabs and fails closed on unreadable evidence", async () => {
  await fixture(async ({ store, threads, auth, path }) => {
    const target = { chatId: 7, threadId: 55 };
    const protection = createTelegramCleanupTargetProtection(threads);
    const action = { kind: "close-delete-unbound-topic", target } as Parameters<typeof protection>[1];
    assert.equal(protection(target, action), false);
    store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry, target, auth);
    assert.equal(protection(target, action), true, "a fresh disk read sees the tab without reloading the warm store");
    assert.equal(protection({ chatId: 7, threadId: 56 }, action), false);
    await writeFile(path, "{broken", { mode: 0o600 });
    assert.equal(protection({ chatId: 7, threadId: 56 }, action), true, "unreadable evidence protects");
  });
});

for (const scenario of ["temporary", "bound", "creating", "stale-frame", "owner-loss", "scope-loss",
  "malformed-row", "malformed-array", "target-owner", "unknown-provision", "corrupt"] as const) {
  test(`Cold temporary target inspection is exact, strict and read-only (${scenario})`, async () => {
    await fixture(async ({ store, open, threads, auth, path, request }) => {
      const target = { chatId: 7, threadId: 55 };
      const reserved = store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry;
      const expected = scenario === "creating" ? reserved : store.acknowledgeTemporaryThread(reserved, target, auth)!;
      const next = { ...auth, executor: { instanceId: "successor", leaderEpoch: "successor-epoch" } };
      const cold = createTelegramTopicTargetStore({ path }); await cold.load();
      const reopened = open({ threadStore: cold });
      if (scenario === "bound") {
        assert.ok(await store.commit({ ...request, target, source: { journalBindingKey: temporarySource.journalBindingKey,
          updateIds: [temporarySource.updateId] } }, auth));
      }
      if (scenario === "stale-frame") store.recordTemporaryThreadInput(expected,
        { journalBindingKey: temporarySource.journalBindingKey, updateIds: [301] }, auth);
      if (scenario === "target-owner") {
        const file = JSON.parse(await readFile(path, "utf8"));
        file.threads.push({ ...file.threads[0], target, instanceId: "foreign", slot: "B" });
        await writeFile(path, JSON.stringify(file), { mode: 0o600 });
      }
      if (scenario === "unknown-provision") {
        threads.upsertPendingProvision({ id: "unknown", owner: "manual-follower", instanceId: "foreign", startedAtMs: 1000 });
        await threads.persist();
      }
      if (scenario === "malformed-row" || scenario === "malformed-array") {
        const file = JSON.parse(await readFile(path, "utf8"));
        file.workspaceBindings = scenario === "malformed-row" ? [null] : {};
        await writeFile(path, JSON.stringify(file), { mode: 0o600 });
      }
      if (scenario === "corrupt") await writeFile(path, "{broken", { mode: 0o600 });
      if (scenario === "owner-loss") {
        let checks = 0;
        next.isCurrent = () => ++checks < 3;
      }
      const before = await readFile(path, "utf8");
      const inspect = () => (scenario === "scope-loss" ? open({ threadStore: cold, isCurrentScope: () => false }) : reopened)
        .inspectTemporaryThreadTarget(expected, next);
      if (scenario === "malformed-row" || scenario === "malformed-array") assert.throws(inspect, /Invalid temporary Thread target evidence/);
      else if (scenario === "corrupt") assert.throws(inspect);
      else if (scenario === "target-owner") assert.throws(inspect, /Protected temporary Thread target conflict/);
      else {
        const observed = inspect();
        if (scenario === "stale-frame" || scenario === "owner-loss" || scenario === "scope-loss") assert.equal(observed, undefined);
        else if (scenario === "bound") {
          assert.equal(observed?.kind, "bound");
          if (observed?.kind !== "bound") assert.fail("Exact canonical binding required");
          assert.deepEqual(observed.binding.target, target);
          assert.equal(observed.binding.sessionId, "session");
          assert.equal(cold.listWorkspaceBindings()[0]?.target.threadId, 10, "fresh inspection never trusts the cached predecessor projection");
          observed.binding.target.threadId = 999;
          assert.equal(reopened.inspectTemporaryThreadTarget(expected, next)?.kind, "bound");
        } else assert.deepEqual(observed, { kind: scenario === "temporary" ? "temporary" : "unknown" });
      }
      assert.equal(await readFile(path, "utf8"), before, "no observation adopts, consumes, resets or publishes facts");
      if (!["malformed-row", "malformed-array", "corrupt"].includes(scenario)) {
        assert.deepEqual(reopened.listTemporaryThreads()[0]?.executor, auth.executor, "the successor never adopts the predecessor executor");
      }
    });
  });
}

test("New-world forgetting removes only this operator's previous-instance state atomically", async () => {
  await fixture(async ({ store, request, auth }) => {
    const successor = { executor: { instanceId: "successor", leaderEpoch: "new" }, operatorUserId: 7, isCurrent: () => true };
    const foreign = { executor: { instanceId: "leader", leaderEpoch: "epoch" }, operatorUserId: 8, isCurrent: () => true };
    const intent = (await store.commit(request, auth))!;
    const previous = store.reserveTemporaryThread({ journalBindingKey: "cold", updateId: 1 }, "a".repeat(32), auth)!.entry;
    const own = store.reserveTemporaryThread({ journalBindingKey: "cold", updateId: 2 }, "b".repeat(32), successor)!.entry;
    const other = store.reserveTemporaryThread({ journalBindingKey: "cold", updateId: 3 }, "c".repeat(32), foreign)!.entry;
    const before = store.listTemporaryThreads();
    assert.equal(store.forgetPreviousWorld({ ...successor, isCurrent: () => false }), undefined);
    assert.deepEqual(store.listTemporaryThreads(), before); assert.deepEqual(store.list(), [intent]);
    assert.deepEqual(store.forgetPreviousWorld(successor), { operations: [intent], temporaryThreads: [previous] });
    assert.deepEqual(store.list(), []);
    assert.deepEqual(store.listTemporaryThreads(), [own, other], "current-instance and other-operator state stay");
    assert.deepEqual(store.forgetPreviousWorld(successor), { operations: [], temporaryThreads: [] });
  });
});

test("A follower cannot publish temporary Thread evidence", async () => {
  await fixture(async ({ store, auth, path, open }) => {
    const follower = createTelegramTopicTargetStore({ path, canPersist: () => false }); await follower.load();
    const before = await readFile(path, "utf8");
    assert.equal(open({ threadStore: follower }).reserveTemporaryThread(temporarySource, temporaryToken, auth), undefined);
    assert.equal(await readFile(path, "utf8"), before);
    const created = store.acknowledgeTemporaryThread(store.reserveTemporaryThread(temporarySource, temporaryToken, auth)!.entry,
      { chatId: 7, threadId: 55 }, auth)!;
    const published = await readFile(path, "utf8");
    assert.equal(open({ threadStore: follower }).recordTemporaryThreadInput(created,
      { journalBindingKey: temporarySource.journalBindingKey, updateIds: [301] }, auth), undefined);
    assert.equal(await readFile(path, "utf8"), published, "membership publication never borrows leader persistence");
    assert.equal(open({ threadStore: follower }).recordTemporaryThreadInputCancellation(created,
      { journalBindingKey: temporarySource.journalBindingKey, updateIds: [300] }, auth,
      updateId => ({ journalBindingKey: temporarySource.journalBindingKey, updateId, operatorAuthorityId: "telegram-owner:7" })), undefined);
    assert.equal(await readFile(path, "utf8"), published, "cancellation facts cannot borrow leader persistence either");
  });
});

for (const mode of ["exact", "unordered", "partial", "extra", "routed", "issued", "executor", "operator", "stale"] as const) {
  test(`Abandoned Restore retirement requires every original before dispatch (${mode})`, async () => {
    await fixture(async ({ store, threads, request, auth, path }) => {
      let intent = store.issueRecipient((await store.commit(request, auth))!, recipient("leader"), auth)!.intent;
      if (mode !== "issued") intent = store.confirmReady(intent, recipient("leader"), auth)!;
      if (mode === "routed") intent = store.issueRouting(intent, auth)!.intent;
      const expected = mode === "stale" ? { ...intent, revision: intent.revision - 1 } : intent;
      const authority = mode === "executor" ? { ...auth, executor: { instanceId: "other", leaderEpoch: "epoch" } }
        : mode === "operator" ? { ...auth, operatorUserId: 8 } : auth;
      const ids = mode === "unordered" ? [101, 100, 101] : mode === "partial" ? [100] : mode === "extra" ? [100, 101, 102] : [100, 101];
      const bindings = structuredClone(threads.listWorkspaceBindings());
      const before = await readFile(path, "utf8");
      const retired = store.retireAbandoned(expected, ids, authority);
      if (mode === "exact" || mode === "unordered") {
        assert.deepEqual(retired, intent);
        assert.deepEqual(store.list(), []);
        const cold = createTelegramTopicTargetStore({ path }); await cold.load();
        assert.deepEqual(cold.listWorkspaceBindings(), bindings, "retirement keeps the relocated binding and slot");
        assert.equal(store.retireAbandoned(intent, ids, authority), undefined, "retirement is not replayable");
      } else {
        assert.equal(retired, undefined);
        assert.equal(await readFile(path, "utf8"), before, "refusal leaves canonical evidence intact");
        assert.deepEqual(store.list(), [intent]);
      }
    });
  });
}

for (const phase of ["issue", "ready"] as const) {
  for (const boundary of ["after-write-before-rename", "after-rename"] as const) {
    test(`Restore ${phase} remains recoverable at ${boundary}`, async () => {
      let armed = false;
      await fixture(async ({ store, open, request, auth }) => {
        let expected = (await store.commit(request, auth))!;
        if (phase === "ready") expected = store.issueRecipient(expected, recipient("follower"), auth)!.intent;
        armed = true;
        const attempt = () => phase === "issue" ? store.issueRecipient(expected, recipient("follower"), auth)
          : store.confirmReady(expected, recipient("follower"), auth);
        assert.throws(attempt, /lost publication/);
        armed = false;
        const cold = open();
        const retained = cold.list()[0];
        const committed = boundary === "after-rename";
        assert.equal(retained?.phase, committed ? { issue: "recipient-issued", ready: "ready" }[phase] : expected.phase);
        if (phase === "issue" && committed) assert.equal(cold.issueRecipient(retained!, recipient("follower"), auth), undefined);
      }, "leader", { onPublicationBoundary(at) { if (armed && at === boundary) throw new Error("lost publication response"); } });
    });
  }
}

for (const fault of ["authority", "operator", "epoch", "owner", "no-commit"] as const) {
  test(`Restore relocation rechecks authority at publication (${fault})`, async () => {
    let owns = true;
    let change: (() => void) | undefined;
    await fixture(async ({ store, request, auth, path }) => {
      change = () => {
        if (fault === "authority") auth.isCurrent = () => false;
        if (fault === "operator") auth.operatorUserId = 8;
        if (fault === "epoch") auth.executor.leaderEpoch = "changed";
        if (fault === "owner") owns = false;
      };
      const before = await readFile(path, "utf8");
      assert.equal(await store.commit(request, auth), undefined);
      assert.equal(await readFile(path, "utf8"), before);
    }, "leader", { onPublicationBoundary(at) { if (at === "after-write-before-rename") change?.(); } },
      { commitPersist(commit) { if (!owns) return false; if (!change || fault !== "no-commit") commit(); return true; } });
  });
}

for (const fault of ["profile", "token", "schema", "duplicate", "phase", "ready-phase", "ready-session", "routing-phase", "routing-overlap", "routing-source", "routing-cleanup", "revision", "missing", "permissions", "bytes", "json", "hardlink"] as const) {
  test(`Restore refuses unverifiable evidence without repair (${fault})`, async () => {
    if (fault === "permissions" && process.platform === "win32") return;
    await fixture(async ({ store, open, threads, request, auth, path }) => {
      const prepared = (await store.commit(request, auth))!;
      const snapshot = JSON.parse(await readFile(path, "utf8"));
      const file = snapshot.workspaceRestore;
      if (fault === "profile") file.profileName = "other";
      if (fault === "token") file.tokenSha256 = "b".repeat(64);
      if (fault === "schema") file.futureAuthority = true;
      if (fault === "duplicate") file.operations.push(file.operations[0]);
      if (fault === "phase") file.operations[0].phase = "ready";
      if (fault === "ready-phase") file.operations[0].readyRecipient = recipient("leader");
      if (fault === "ready-session") Object.assign(file.operations[0], { phase: "ready", committedAtMs: 1000,
        recipient: recipient("leader"), readyRecipient: { ...recipient("leader"), sessionId: "foreign" } });
      if (fault === "routing-phase") file.operations[0].routing = { settlements: [] };
      if (["routing-overlap", "routing-source", "routing-cleanup"].includes(fault)) {
        const evidence = { journalBindingKey: request.source.journalBindingKey, updateIds: [100], kind: "completed" };
        Object.assign(file.operations[0], { phase: "ready", committedAtMs: 1000, recipient: recipient("leader"),
          routing: fault === "routing-cleanup" ? { settlements: [], cleanup: "issued" } :
            { settlements: fault === "routing-overlap" ? [evidence, evidence] : [{ ...evidence, journalBindingKey: "foreign" }] } });
      }
      if (fault === "revision") file.revision = 0;
      if (fault === "missing") await rm(path);
      else await writeFile(path, fault === "json" ? "invalid-json" : JSON.stringify(snapshot));
      if (fault === "hardlink") await link(path, `${path}.alias`);
      if (fault === "permissions") await chmod(path, 0o644);
      const before = await readFile(path, "utf8").catch(() => undefined);
      const reader = fault === "bytes" ? open({ maxBytes: 1 }) : store;
      assert.throws(() => reader.list());
      assert.throws(() => reader.issueRecipient(prepared, recipient("leader"), auth));
      if (fault !== "bytes") {
        await assert.rejects(threads.load());
        await assert.rejects(threads.persist());
      }
      assert.equal(await readFile(path, "utf8").catch(() => undefined), before);
    });
  });
}

for (const collision of ["none", "slot", "binding", "source-target", "destination", "source-input"] as const) {
  test(`Restore commit refuses overlapping source or target authority (${collision})`, async () => {
    await fixture(async ({ store, threads, request, auth, path }) => {
      await store.commit(request, auth);
      const before = await readFile(path, "utf8");
      const other = structuredClone(request);
      other.operationId = "other";
      other.binding = { ...request.binding, ...createTelegramWorkspaceBindingIdentity("/other", 0, "other")!,
        target: { chatId: 7, threadId: 99 }, slot: "B" };
      other.owner = { ...request.owner, profileKey: "cwd:/other", instanceId: "other",
        owner: { kind: "leader", cwd: "/other", instanceId: "other" }, target: { chatId: 7, threadId: 99 }, slot: "B" };
      other.target = { chatId: 7, threadId: 100 };
      other.source.updateIds = [200];
      if (collision === "slot") other.binding.slot = other.owner.slot = "A";
      if (collision === "binding") {
        other.binding = { ...other.binding, ...createTelegramWorkspaceBindingIdentity("/repo", 0, "session")! };
        other.owner.owner = { kind: "leader", cwd: "/repo", instanceId: "other" };
        other.owner.profileKey = "cwd:/repo";
      }
      if (collision === "source-target") other.binding.target.threadId = other.owner.target.threadId = 10;
      if (collision === "destination") other.target.threadId = 42;
      if (collision === "source-input") other.source.updateIds = [101];
      threads.upsertWorkspaceBinding(other.binding);
      threads.upsert(other.owner);
      if (["slot", "binding", "source-target"].includes(collision)) {
        await assert.rejects(() => threads.persist(), /Protected Workspace Restore/);
        assert.equal(await readFile(path, "utf8"), before);
        return;
      }
      await threads.persist();
      other.binding = threads.listWorkspaceBindings().find(binding => binding.bindingKey === other.binding.bindingKey)!;
      other.owner = threads.getByProfileKey(other.owner.profileKey)!;
      assert.equal(!!await store.commit(other, auth), collision === "none");
      assert.equal(store.list().length, collision === "none" ? 2 : 1);
    });
  });
}

for (const fault of ["identity", "commit-port"] as const) {
  test(`Restore captures its storage identity and prepared ports (${fault})`, async () => {
    await fixture(async ({ request, auth, path }) => {
      const nativeOptions = { path, commitPersist(commit: () => void) { if (fault === "commit-port") return false; commit(); return true; } };
      const options = { profileName: "default", tokenSha256: "a".repeat(64) };
      const store = createTelegramTopicTargetStore(nativeOptions).workspaceRestore(options);
      options.profileName = "other";
      options.tokenSha256 = "b".repeat(64);
      nativeOptions.commitPersist = commit => { commit(); return true; };
      assert.equal(!!await store.commit(request, auth), fault === "identity");
      const file = JSON.parse(await readFile(path, "utf8"));
      if (fault === "identity") assert.equal(file.workspaceRestore.profileName, "default");
      else assert.equal(file.workspaceRestore, undefined);
    });
  });
}

for (const fault of ["permissions", "hardlink", "symlink", "snapshot-bytes", "legacy-file", "legacy-receipt", "legacy-revision"] as const) {
  test(`First atomic Restore refuses unsafe storage without migration or repair (${fault})`, async () => {
    if (process.platform === "win32" && ["permissions", "symlink"].includes(fault)) return;
    await fixture(async ({ open, threads, request, auth, path }) => {
      const legacyPath = join(dirname(path), "workspace-restore.json");
      if (fault === "permissions") await chmod(path, 0o644);
      if (fault === "hardlink") await link(path, `${path}.alias`);
      if (fault === "symlink") { await rename(path, `${path}.original`); await symlink(`${path}.original`, path); }
      if (fault === "snapshot-bytes") await writeFile(path, " ".repeat(8 * 1024 * 1024 + 1));
      if (fault === "legacy-file") await writeFile(legacyPath, '{"version":1,"operations":[{"phase":"prepared"}]}');
      if (fault === "legacy-receipt" || fault === "legacy-revision") {
        const file = JSON.parse(await readFile(path, "utf8"));
        file.workspaceRelocations = fault === "legacy-receipt" ? [{ operationId: "unmigrated" }] : [];
        file.workspaceRelocationRevision = 2;
        await writeFile(path, JSON.stringify(file));
      }
      const before = await readFile(path, "utf8");
      await assert.rejects(open({ legacyPath }).commit(request, auth), /private regular file|Unmigrated Workspace/);
      if (["hardlink", "symlink", "snapshot-bytes", "legacy-receipt", "legacy-revision"].includes(fault)) await assert.rejects(threads.load());
      assert.equal(await readFile(path, "utf8"), before);
      if (fault === "legacy-file") assert.equal(await readFile(legacyPath, "utf8"), '{"version":1,"operations":[{"phase":"prepared"}]}');
    });
  });
}

test("Restore capacity failure publishes neither an operation nor relocation", async () => {
  await fixture(async ({ store, open, request, auth, path }) => {
    const before = await readFile(path, "utf8");
    await assert.rejects(open({ maxBytes: 1 }).commit(request, auth), /byte capacity/);
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual(store.list(), []);
    assert.equal((await store.commit(request, auth))?.phase, "relocated");
  });
});
