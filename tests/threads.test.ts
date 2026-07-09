/**
 * Telegram thread binding tests
 * Zones: multi-instance bus, Telegram UI threads, extension state
 * Covers current owner-key thread target reuse and Bot API topic provisioning seams
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseTelegramThreadName,
  createTelegramTopicTargetProvisioner,
  createTelegramThreadName,
  createTelegramTopicTargetRenamer,
  createTelegramTopicTargetStore,
  findCurrentTelegramInstanceThreadRecord,
  getTelegramThreadOwnerFromProfileKey,
  getTelegramThreadOwnerKey,
  getTelegramStatePath,
  getTelegramTopicTargetsPath,
  provisionOwnBusTopic,
  reconcileTelegramFreshAllocationCursor,
  resolveTelegramInstanceThreadTarget,
  listTelegramThreadStatusFollowers,
  listTelegramThreadStatusTargets,
  listTelegramThreadStatusReservations,
  listTelegramThreadStatusObservations,
  getTelegramTopicIdentityName,
  getTelegramTopicName,
  getTelegramTargetFromApiBody,
  isTelegramTopicThreadNameValidForSlot,
  isTelegramTopicModeUnavailableError,
  isTelegramTopicTargetStaleError,
} from "../lib/threads.ts";

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

    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600);

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
      ?.threadName,
    "Blue Unit",
  );
  assert.equal(store.getByProfileKey("cwd:/repo")?.threadName, "Blue Unit");
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

test("Thread renamer edits the Telegram topic and persisted thread name", async () => {
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

  assert.equal(record?.threadName, "BlueUnit");
  assert.equal(record?.updatedAtMs, 3000);
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
});

test("Thread renamer rejects bare slot and generic role labels", async () => {
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
  assert.equal(
    await rename({
      target: { chatId: -1001, threadId: 42 },
      threadName: "Follower",
      slot: "F",
    }),
    undefined,
  );
  assert.deepEqual(calls, []);
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

test("Thread provisioner does not reuse active manual follower profile across runtime replacement", async () => {
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

  assert.equal(result.reused, false);
  assert.deepEqual(result.target, { chatId: -1001, threadId: 99 });
  assert.equal(result.record.instanceId, "1234:new");
  assert.equal(result.record.slot, "D");
  assert.deepEqual(calls, [
    { method: "createForumTopic", body: { chat_id: -1001, name: "Delta" } },
  ]);
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

test("Thread provisioner replaces stale active manual follower runtime with a fresh topic", async () => {
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

  assert.equal(result.reused, false);
  assert.deepEqual(result.target, { chatId: -1001, threadId: 99 });
  assert.equal(result.record.slot, "U");
  assert.notEqual(result.record.threadName, "Talon");
  assert.equal(store.getByProfileKey("manual:1234")?.target.threadId, 99);
  assert.deepEqual(calls, [
    { method: "createForumTopic", body: { chat_id: -1001, name: "Umber" } },
  ]);
});

test("Thread provisioner replaces same-runtime active manual follower with a fresh topic", async () => {
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

  assert.equal(result.reused, false);
  assert.deepEqual(result.target, { chatId: -1001, threadId: 99 });
  assert.equal(result.record.slot, "U");
  assert.notEqual(result.record.threadName, "Talon");
  assert.deepEqual(calls, [
    { method: "createForumTopic", body: { chat_id: -1001, name: "Umber" } },
  ]);
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
            slot: "A",
            startedAtMs: 2000,
            expiresAtMs: 902000,
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

test("Thread provisioner keeps targeted pending provision after post-create binding failure", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "pi-telegram-provision-post-create-fail-"),
  );
  const path = join(dir, "state.json");
  try {
    const store = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 2000,
    });
    const failingStore = {
      ...store,
      upsert(record: Parameters<typeof store.upsert>[0]) {
        if (record.status === "starting") {
          throw new Error("binding persist failed");
        }
        return store.upsert(record);
      },
    };
    const provision = createTelegramTopicTargetProvisioner({
      topicChatId: -1001,
      store: failingStore,
      getNowMs: () => 2000,
      async callApi<TResponse>() {
        return { message_thread_id: 88 } as TResponse;
      },
    });

    await assert.rejects(
      () =>
        provision({
          instanceId: "inst-a",
          profileKey: "manual:inst-a",
        }),
      /binding persist failed/,
    );

    assert.deepEqual(store.listPendingProvisions(), [
      {
        id: "provision:inst-a:A:2000",
        owner: "manual-follower",
        instanceId: "inst-a",
        slot: "A",
        target: { chatId: -1001, threadId: 88 },
        startedAtMs: 2000,
        expiresAtMs: 902000,
      },
    ]);
    const file = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(file.pendingProvisions?.[0]?.target, {
      chatId: -1001,
      threadId: 88,
    });
    assert.deepEqual(file.threads, []);
  } finally {
    await rm(dir, { force: true, recursive: true });
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

  assert.equal(store.getByProfileKey("cwd:/leader")?.slot, "D");
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

test("Thread identity helpers require compact capitalized Latin names", () => {
  assert.equal(getTelegramTopicIdentityName("Jname"), "Jname");
  assert.equal(getTelegramTopicIdentityName("  Jname  "), "Jname");
  assert.equal(isTelegramTopicThreadNameValidForSlot("Jname", "J"), true);
  assert.equal(isTelegramTopicThreadNameValidForSlot("Aname", "J"), true);
  assert.equal(isTelegramTopicThreadNameValidForSlot("J", "J"), false);
  assert.equal(isTelegramTopicThreadNameValidForSlot("name", "N"), false);
  assert.equal(isTelegramTopicThreadNameValidForSlot("Follower", "F"), false);
  assert.equal(isTelegramTopicThreadNameValidForSlot("J identity", "J"), false);
  assert.equal(isTelegramTopicThreadNameValidForSlot("J-identity", "J"), false);
  assert.equal(isTelegramTopicThreadNameValidForSlot("Word Word", "W"), false);
  assert.equal(
    isTelegramTopicThreadNameValidForSlot("🌙 J-identity", "J"),
    false,
  );
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
