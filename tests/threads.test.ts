/**
 * Telegram thread binding tests
 * Zones: multi-instance bus, Telegram UI threads, extension state
 * Covers current owner-key thread target reuse and Bot API topic provisioning seams
 */

import fsPromises, { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseTelegramThreadName,
  commitTelegramWorkspaceProvisionBinding,
  createTelegramCurrentInstanceThreadRuntime,
  createTelegramCurrentThreadAssembly,
  createTelegramLeaderThreadStateRuntime,
  createTelegramThreadStatusProjectionRuntime,
  createTelegramTopicTargetProvisioner,
  createTelegramThreadName,
  createTelegramTopicTargetRenamer,
  createTelegramWorkspaceBindingIdentity,
  createTelegramWorkspaceDirectoryKey,
  createTelegramTopicTargetStore,
  findCurrentTelegramInstanceThreadRecord,
  getTelegramThreadOwnerFromProfileKey,
  getTelegramThreadOwnerKey,
  getTelegramStatePath,
  getTelegramTopicTargetsPath,
  getTelegramLeaderSessionHandoff,
  setTelegramLeaderSessionHandoff,
  provisionOwnBusTopic,
  reconcileTelegramFreshAllocationCursor,
  resolveTelegramInstanceThreadIdentity,
  resolveTelegramInstanceThreadTarget,
  listTelegramThreadStatusFollowers,
  listTelegramThreadStatusTargets,
  listTelegramThreadStatusReservations,
  listTelegramThreadStatusObservations,
  getTelegramManualThreadDisplayNameValidationError,
  getTelegramTopicIdentityName,
  getTelegramTopicName,
  getTelegramTargetFromApiBody,
  isTelegramTopicThreadNameValidForSlot,
  isTelegramTopicModeUnavailableError,
  isTelegramTopicTargetStaleError,
  normalizeTelegramWorkspacePath,
} from "../lib/threads.ts";
import { createTelegramLockRuntime } from "../lib/locks.ts";
import { createTelegramWorkspaceAdmissionLedger } from "../lib/workspace-admission.ts";
import {
  isTelegramApiCommitUnknownError,
  TelegramApiCommitUnknownError,
} from "../lib/telegram-api.ts";

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
      commitPersist: (commit) => {
        atCommit?.();
        if (!owns) return false;
        commit();
        return true;
      },
    });
    try {
      store.upsert(record);
      await store.persist();
      atCommit = () => {
        assert.equal(store.list()[0]?.instanceId, "a", "invalidation must not publish before commit");
        if (race === "generation") generation++;
        if (race === "binding") store.upsert({ ...record, instanceId: "b", owner: { ...record.owner, instanceId: "b" }, updatedAtMs: 2 });
        if (race === "ownership") owns = false;
      };
      const applied = await store.invalidateTarget(target, () => generation === 1 && store.list()[0]?.instanceId === "a", "confirmed stale target");
      assert.equal(applied, race === "none");
      const disk = JSON.parse(await readFile(path, "utf8"));
      assert.equal(disk.threads.length, race === "none" ? 0 : 1);
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

test("Workspace identities use readable cwd keys and deterministic concurrent suffixes", () => {
  const cwd = "/home/llb/.pi/agent/extensions/";
  const normalized = normalizeTelegramWorkspacePath(cwd);
  assert.equal(normalized, "/home/llb/.pi/agent/extensions");
  assert.equal(
    createTelegramWorkspaceDirectoryKey(cwd),
    "--home-llb-.pi-agent-extensions--",
  );
  assert.deepEqual(createTelegramWorkspaceBindingIdentity(cwd), {
    cwd: "/home/llb/.pi/agent/extensions",
    workspaceKey: "--home-llb-.pi-agent-extensions--",
    instanceSlot: "a",
    bindingKey: "--home-llb-.pi-agent-extensions--",
  });
  assert.equal(
    createTelegramWorkspaceBindingIdentity(cwd, 1)?.bindingKey,
    "--home-llb-.pi-agent-extensions--b",
  );
  assert.equal(
    createTelegramWorkspaceBindingIdentity(cwd, 26)?.instanceSlot,
    "aa",
  );
  assert.equal(createTelegramWorkspaceBindingIdentity("", 0), undefined);
  assert.equal(createTelegramWorkspaceBindingIdentity(cwd, -1), undefined);
});

test("Workspace directory keys stay bounded and collision-verifiable by exact cwd", () => {
  const cwd = `/workspace/${"segment/".repeat(80)}project`;
  const first = createTelegramWorkspaceBindingIdentity(cwd);
  const second = createTelegramWorkspaceBindingIdentity(cwd);
  assert.ok(first);
  assert.deepEqual(first, second);
  assert.ok(first.workspaceKey.length <= 180);
  assert.equal(first.cwd, normalizeTelegramWorkspacePath(cwd));
  assert.match(first.workspaceKey, /-[a-f0-9]{12}--$/u);
});

test("Thread names are deterministic for the same seed", () => {
  const input = {
    seed: "123",
    cwd: "/repo/pi-telegram",
    role: "leader" as const,
  };
  assert.equal(
    createTelegramThreadName(input),
    createTelegramThreadName(input),
  );
});

test("Baked thread names stay compact for narrow Telegram tabs", () => {
  for (const slot of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    const seen = new Set<string>();
    for (let index = 0; index < 5; index += 1) {
      const name = chooseTelegramThreadName({
        slot,
        getRandom: () => index / 5,
      });
      assert.ok(name, `Expected baked name for slot ${slot}`);
      assert.equal(name.startsWith(slot), true);
      assert.ok(
        name.length >= 4 && name.length <= 6,
        `${name} should be 4-6 letters`,
      );
      seen.add(name);
    }
    assert.equal(seen.size, 5, `Expected five names for slot ${slot}`);
  }
});

test("Baked thread names skip identities reserved by Workspace bindings", () => {
  assert.equal(
    chooseTelegramThreadName({
      slot: "C",
      getRandom: () => 0,
      occupied: ["Cedar", "Comet", "Cipher", "Coral"],
    }),
    "Cinder",
  );
});

test("Baked thread names can be selected from timestamp entropy", () => {
  const first = chooseTelegramThreadName({
    slot: "C",
    entropy: 1_720_000_000_001,
  });
  const second = chooseTelegramThreadName({
    slot: "C",
    entropy: 1_720_000_000_001,
  });
  const nearby = chooseTelegramThreadName({
    slot: "C",
    entropy: 1_720_000_000_002,
  });

  assert.equal(first, second);
  assert.ok(first?.startsWith("C"));
  assert.ok(nearby?.startsWith("C"));
});

test("Thread names include workspace and role hints", () => {
  const name = createTelegramThreadName({
    seed: "123",
    cwd: "/repo/pi-telegram",
    role: "leader",
  });
  assert.match(name, /pi-telegram/);
  assert.match(name, /Leader/);
});

test("Thread names can include the assigned slot", () => {
  const name = createTelegramThreadName({
    seed: "123",
    cwd: "/repo/pi-telegram",
    role: "follower",
    slot: "B",
  });
  assert.match(name, /Thread B/);
  assert.match(name, /Follower/);
});

test("Thread state path is transient and profile-aware", () => {
  assert.equal(
    getTelegramTopicTargetsPath("/agent"),
    join("/agent", "tmp", "telegram", "state.json"),
  );
  assert.equal(
    getTelegramStatePath("/agent"),
    getTelegramTopicTargetsPath("/agent"),
  );
  assert.equal(
    getTelegramTopicTargetsPath("/agent", "omp"),
    join("/agent", "tmp", "telegram", "state.omp.json"),
  );
  assert.equal(
    getTelegramStatePath("/agent", "omp"),
    getTelegramTopicTargetsPath("/agent", "omp"),
  );
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
    const binding = { ...createTelegramWorkspaceBindingIdentity("/repo")!,
      target: { chatId: 7, threadId: 41 }, slot: "A", threadName: "Anchor",
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
    assert.equal(restored.claimWorkspaceIdentity("/repo", "returning"), undefined);
    assert.equal(restored.setWorkspaceDisplayTitle(binding, "Changed"), false);
    assert.equal(restored.markWorkspaceBindingActiveByTarget(binding.target), false);
    assert.equal(restored.getWorkspaceBinding("/repo")?.inactiveSinceMs, 100);
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
    const current = restored.getWorkspaceBinding("/repo")!;
    const changed = { ...current, threadName: "Navigator", updatedAtMs: 400 };
    assert.equal(restored.upsertWorkspaceBinding(changed), undefined);
    assert.equal(restored.getWorkspaceBinding("/repo")?.threadName, "Anchor");
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

    const file = JSON.parse(await readFile(path, "utf8"));
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
    await statusOnly.persist();

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
    const file = JSON.parse(await readFile(path, "utf8"));
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
    await staleStatusWriter.persist();

    const reloaded = createTelegramTopicTargetStore({ path });
    await reloaded.load();
    assert.equal(
      reloaded.getByProfileKey("manual:follower-b")?.target.threadId,
      43,
    );
    const file = JSON.parse(await readFile(path, "utf8"));
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
    const diagnostic = await readFile(path, "utf8");
    assert.notEqual(diagnostic, initial);
    assert.equal(JSON.parse(diagnostic).writtenAtMs, 2000);
    nowMs = 3000;
    store.setStatusSnapshot({ diagnostics: { recentEvents: 1 } });
    await store.persist();
    assert.equal(await readFile(path, "utf8"), diagnostic);
    assert.equal(mkdirSpy.mock.callCount(), 2);
  } finally {
    mkdirSpy.mock.restore();
    syncBuiltinESMExports();
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
    store.setStatusSnapshot({ diagnostics: { payload: { first: 1, last: 2 }, list: ["a", "b"] } });
    await store.persist();
    const baseline = await readFile(path, "utf8");
    nowMs++;
    store.setStatusSnapshot({ diagnostics: { list: ["a", "b"], payload: { last: 2, first: 1, omitted: undefined } } });
    await store.persist();
    assert.equal(await readFile(path, "utf8"), baseline, "Nested JSON object order and omitted undefined are equivalent");
    for (const diagnostics of [
      { list: ["b", "a"], payload: { first: 1, last: 2 } },
      { list: ["b", "a"], payload: { first: "1", last: 2 } },
      { list: ["b", "a"], payload: { first: "1", last: 2, added: null } },
    ]) {
      const before = await readFile(path, "utf8");
      nowMs++;
      store.setStatusSnapshot({ diagnostics });
      await store.persist();
      const after = await readFile(path, "utf8");
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

test("Thread cursor reconciliation preserves a live cursor and collision guards", () => {
  const store = createTelegramTopicTargetStore({
    path: "/tmp/unused-telegram-cursor-reconcile.json",
    getNowMs: () => 1000,
  });
  store.upsert({
    profileKey: "leader:/repo",
    owner: { kind: "leader", cwd: "/repo", instanceId: "leader" },
    target: { chatId: 7, threadId: 40 },
    status: "active",
    createdAtMs: 1,
    updatedAtMs: 1,
    instanceId: "leader",
    slot: "D",
  });
  store.reserveThread({
    target: { chatId: 7, threadId: 41 },
    slot: "E",
    reason: "leader-reload",
    createdAtMs: 1,
    updatedAtMs: 1,
    expiresAtMs: 2000,
  });
  store.setBotState({ lastSlot: "D" });

  assert.equal(reconcileTelegramFreshAllocationCursor(store, 1000), false);
  assert.equal(store.getBotState().lastSlot, "D");
  assert.equal(store.allocateSlot("manual:new"), "F");
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
        profileKey: "manual:inst-a", threadName: "Atlas", displayTitle: "extensions",
        slot: "A", target: { chatId: -1001, threadId: 88 }, startedAtMs: 2000,
      }]);
      const recover = createTelegramTopicTargetProvisioner({
        topicChatId: -1001, store: restored, getNowMs: () => 3000,
        resolveInitialWorkspaceDisplayTitle() { throw new Error("must not reproject an acknowledged title"); },
        async callApi() { throw new Error("must not recreate the acknowledged target"); },
      });
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

test("Thread helpers prefer follower and current store targets when resolving an instance thread target", () => {
  const currentRecord = {
    profileKey: "cwd:/repo",
    target: { chatId: 7, threadId: 12 },
    status: "active" as const,
    createdAtMs: 1,
    updatedAtMs: 1,
    instanceId: "current",
  };

  assert.deepEqual(
    resolveTelegramInstanceThreadTarget({
      followerTarget: { chatId: 7, threadId: 11 },
      leaderTarget: { chatId: 7, threadId: 10 },
      currentRecord,
    }),
    { chatId: 7, threadId: 11 },
  );
  assert.deepEqual(
    resolveTelegramInstanceThreadTarget({
      leaderTarget: { chatId: 7, threadId: 10 },
      currentRecord,
    }),
    { chatId: 7, threadId: 12 },
  );
  assert.deepEqual(
    resolveTelegramInstanceThreadTarget({
      leaderTarget: { chatId: 7, threadId: 10 },
    }),
    { chatId: 7, threadId: 10 },
  );
  assert.equal(resolveTelegramInstanceThreadTarget({}), undefined);
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
    ],
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
  assert.equal(assembly.getDisplayTitle({ chatId: 7, threadId: 55 }), "other");
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

test("Thread recovery identities remain compact capitalized Latin names", () => {
  assert.equal(getTelegramTopicIdentityName("Jname"), "Jname");
  assert.equal(getTelegramTopicIdentityName("  Jname  "), "Jname");
  assert.equal(isTelegramTopicThreadNameValidForSlot("Jname", "J"), true);
  for (const name of [
    "J", "name", "Follower", "J identity", "J-identity", "Word Word",
    "wasd_123!?+$@", "🌙 J-identity",
  ]) {
    assert.equal(isTelegramTopicThreadNameValidForSlot(name, "J"), false, name);
  }
});

test("Manual Thread display names accept bounded printable ASCII", () => {
  for (const name of [
    "Jname", "name", "Follower", "J identity", "J-identity", "Word Word",
    "wasd_123!?+$@",
  ]) {
    assert.equal(getTelegramManualThreadDisplayNameValidationError(name), undefined, name);
  }
  assert.match(getTelegramManualThreadDisplayNameValidationError("A") ?? "", /reset/);
  assert.match(getTelegramManualThreadDisplayNameValidationError("   ") ?? "", /empty/);
  assert.match(getTelegramManualThreadDisplayNameValidationError("🌙") ?? "", /printable ASCII/);
  assert.match(getTelegramManualThreadDisplayNameValidationError("line\nbreak") ?? "", /printable ASCII/);
  assert.match(getTelegramManualThreadDisplayNameValidationError("x".repeat(97)) ?? "", /96/);
});

test("Thread titles are trimmed and capped to Telegram's 128 character limit", () => {
  const name = getTelegramTopicName(
    {
      instanceId: "inst-a",
      profileKey: "cwd:/repo",
      threadName: `repo ${"x".repeat(200)}`,
    },
    "  Pi   {threadName}  ",
  );
  assert.equal(name.length, 128);
  assert.match(name, /^Pi repo x+/);
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
