/**
 * Regression tests for Telegram multi-instance bus leader helpers
 * Covers leader activation, envelope handling, authorization, and polling runtime behavior
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTelegramBusFollowerRegistry,
  sendTelegramBusLocalEnvelope,
} from "../lib/bus.ts";
import {
  createTelegramBusFollowerBindingRealityReconciler,
  createTelegramBusFollowerDisconnectedAnnouncement,
  createTelegramBusFollowerDisconnectHandler,
  createTelegramBusFollowerPruneHandler,
  createTelegramBusFollowerTargetProvisioner,
  createTelegramBusInstanceLifecycleAnnouncement,
  createTelegramBusLeaderActivationScheduler,
  createTelegramBusLeaderApiProxy,
  createTelegramBusLeaderEnvelopeHandler,
  createTelegramBusLeaderRuntime,
  createTelegramBusLeaderRuntimeAssembly,
  createTelegramBusLeaderTargetProvisioner,
} from "../lib/bus-leader.ts";
import { createTelegramTopicTargetStore } from "../lib/threads.ts";
import { TelegramApiCommitUnknownError } from "../lib/telegram-api.ts";

test("Bus leader binding reality preserves absent followers for thread restoration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-reality-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
  });
  const followerRegistry = createTelegramBusFollowerRegistry();
  const events: unknown[] = [];
  try {
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
    store.upsert({
      profileKey: "manual:live-owner",
      owner: { kind: "manual-follower", instanceId: "live-owner" },
      target: { chatId: 7, threadId: 41 },
      status: "active",
      createdAtMs: 2,
      updatedAtMs: 2,
      instanceId: "live-runtime",
      slot: "E",
    });
    store.upsert({
      profileKey: "manual:dead-owner",
      owner: { kind: "manual-follower", instanceId: "dead-owner" },
      target: { chatId: 7, threadId: 42 },
      status: "active",
      createdAtMs: 3,
      updatedAtMs: 3,
      instanceId: "dead-runtime",
      slot: "F",
    });
    followerRegistry.register({
      instanceId: "live-runtime",
      connectedAtMs: 10,
      target: { chatId: 7, threadId: 41 },
    });
    const reconcile = createTelegramBusFollowerBindingRealityReconciler({
      topicTargetStore: store,
      followerRegistry,
      recordRuntimeEvent: (...args) => events.push(args),
    });

    assert.equal(await reconcile(), 0);
    assert.deepEqual(
      store
        .list()
        .map((record) => record.instanceId)
        .sort(),
      ["dead-runtime", "leader", "live-runtime"],
    );
    assert.equal(events.length, 0);
    assert.equal(store.getBotState().lastSlot, "F");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader compaction preserves a recent binding through follower reload handoff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-gap-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  store.upsert({
    profileKey: "manual:owner-a",
    owner: { kind: "manual-follower", instanceId: "owner-a" },
    target: { chatId: 7, threadId: 42 },
    status: "active",
    createdAtMs: 900,
    updatedAtMs: 950,
    instanceId: "follower-old",
    slot: "C",
    threadName: "Cedar",
  });
  const followerRegistry = createTelegramBusFollowerRegistry();
  const reconcile = createTelegramBusFollowerBindingRealityReconciler({
    topicTargetStore: store,
    followerRegistry,
    getNowMs: () => 1000,
    recentBindingGraceMs: 100,
    recordRuntimeEvent: () => undefined,
  });
  const calls: unknown[] = [];
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { ok: true } as TResponse;
    },
    getNowMs: () => 1001,
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
  });
  try {
    assert.equal(await reconcile(), 0);
    assert.deepEqual(
      await provision({
        instanceId: "follower-new",
        profileKey: "manual:owner-a",
        target: { chatId: 7, threadId: 42 },
        connectedAtMs: 1001,
      }),
      { chatId: 7, threadId: 42, slot: "C", threadName: "Cedar" },
    );
    assert.deepEqual(calls, [
      {
        method: "sendMessage",
        body: {
          chat_id: 7,
          message_thread_id: 42,
          text: "📡 Instance <b>Cedar</b> connected.",
          parse_mode: "HTML",
        },
      },
    ]);
    assert.equal(store.list()[0]?.instanceId, "follower-new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader API proxy forwards supported methods and recovers stale targets", async () => {
  const calls: unknown[] = [];
  const recovered: unknown[] = [];
  const proxy = createTelegramBusLeaderApiProxy({
    async call(method, body, options) {
      calls.push({ kind: "call", method, body, options });
      if (method === "sendMessage") throw new Error("stale topic");
      return { ok: true };
    },
    async callMultipart(
      method,
      fields,
      fieldName,
      filePath,
      fileName,
      options,
    ) {
      calls.push({
        kind: "multipart",
        method,
        fields,
        fieldName,
        filePath,
        fileName,
        options,
      });
      return { ok: true };
    },
    async downloadFile(fileId, destinationDir) {
      calls.push({ kind: "download", fileId, destinationDir });
      return "/tmp/file";
    },
    recoverStaleTargetError(apiBody, error) {
      recovered.push({ apiBody, message: (error as Error).message });
    },
  });
  await assert.rejects(
    () => proxy("call", ["sendMessage", { chat_id: 1 }, { maxAttempts: 1 }]),
    /stale topic/,
  );
  assert.deepEqual(
    await proxy("callMultipart", [
      "sendDocument",
      { chat_id: "1" },
      "document",
      "/tmp/a.txt",
      "a.txt",
      undefined,
    ]),
    { ok: true },
  );
  assert.equal(await proxy("downloadFile", ["file-id", "/tmp"]), "/tmp/file");
  assert.deepEqual(recovered, [
    { apiBody: { chat_id: 1 }, message: "stale topic" },
  ]);
  assert.deepEqual(calls, [
    {
      kind: "call",
      method: "sendMessage",
      body: { chat_id: 1 },
      options: { maxAttempts: 1 },
    },
    {
      kind: "multipart",
      method: "sendDocument",
      fields: { chat_id: "1" },
      fieldName: "document",
      filePath: "/tmp/a.txt",
      fileName: "a.txt",
      options: undefined,
    },
    { kind: "download", fileId: "file-id", destinationDir: "/tmp" },
  ]);
  await assert.rejects(() => proxy("unknown", []), /Unsupported/);
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
  assert.fail("Timed out waiting for condition");
}

test("Bus leader follower prune handler preserves thread binding silently", async () => {
  const calls: unknown[] = [];
  const staleTargets: unknown[] = [];
  const removedPending: string[] = [];
  const events: unknown[] = [];
  let persisted = 0;
  let syncState = {};
  let offline = false;
  const handler = createTelegramBusFollowerPruneHandler({
    topicTargetStore: {
      load: async () => undefined,
      getActiveByInstanceId: () => ({
        profileKey: "manual:follower-a",
        owner: { kind: "manual-follower", instanceId: "follower-a" },
        instanceId: "follower-a",
        target: { chatId: 7, threadId: 11 },
        status: "active",
        createdAtMs: 1000,
        updatedAtMs: 1000,
        slot: "E",
        threadName: "Ember",
      }),
      list: () => [],
      listPendingProvisions: () => [],
      markStaleByTarget: (target) => {
        staleTargets.push(target);
        return true;
      },
      markOfflineByInstanceId: () => {
        offline = true;
        return 1;
      },
      persist: async () => {
        persisted += 1;
      },
      removePendingProvision: (id) => {
        removedPending.push(id);
        return true;
      },
    },
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { ok: true } as TResponse;
    },
    getCurrentLeaderEpoch: () => "epoch-1",
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    getNowMs: () => 2000,
    recordRuntimeEvent: (category, message, details) => {
      events.push({ category, message, details });
    },
  });
  await handler({
    instanceId: "follower-a",
    connectedAtMs: 1000,
    lastHeartbeatMs: 1500,
    target: { chatId: 7, threadId: 11 },
  });
  assert.equal(offline, false);
  assert.equal(persisted, 0);
  assert.deepEqual(staleTargets, []);
  assert.deepEqual(removedPending, []);
  assert.deepEqual(calls, []);
  assert.deepEqual(syncState, {});
  assert.deepEqual(events, [
    {
      category: "bus",
      message:
        "Telegram bus follower heartbeat stale; preserving thread binding",
      details: {
        phase: "follower-pruned",
        instanceId: "follower-a",
      },
    },
  ]);
});

test("Bus leader follower disconnect preserves binding when deletion is unconfirmed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-disconnect-fail-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  store.upsert({
    profileKey: "manual:owner-a",
    owner: { kind: "manual-follower", instanceId: "owner-a" },
    target: { chatId: 7, threadId: 42 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "follower-a",
  });
  const disconnect = createTelegramBusFollowerDisconnectHandler({
    topicTargetStore: store,
    async callApi<TResponse>(method: string) {
      if (method === "deleteForumTopic") {
        throw new Error("temporary Bot API failure");
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => ({}),
    setSyncState: () => undefined,
    recordRuntimeEvent: () => undefined,
  });
  try {
    await assert.rejects(
      disconnect({
        instanceId: "follower-a",
        connectedAtMs: 500,
        lastHeartbeatMs: 1000,
        target: { chatId: 7, threadId: 42 },
      }),
      /deletion was not confirmed/,
    );
    assert.equal(
      store.getByProfileKey("manual:owner-a")?.status,
      "active",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader follower target provisioner creates thread and announces connection", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-provision-"),
  );
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let syncState = {};
  let provisioning = 0;
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "createForumTopic") {
        return { message_thread_id: 12 } as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    onProvisioningStart: () => {
      provisioning += 1;
    },
    onProvisioningEnd: () => {
      provisioning -= 1;
    },
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    assert.deepEqual(
      await provision({ instanceId: "follower-a", connectedAtMs: 0 }),
      { chatId: 7, threadId: 12, slot: "A", threadName: "Atlas" },
    );
    assert.equal(provisioning, 0);
    assert.deepEqual(calls, [
      { method: "createForumTopic", body: { chat_id: 7, name: "Atlas" } },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, [
      { method: "createForumTopic", body: { chat_id: 7, name: "Atlas" } },
      {
        method: "sendMessage",
        body: {
          chat_id: 7,
          message_thread_id: 12,
          text: "📡 Instance <b>Atlas</b> connected.",
          parse_mode: "HTML",
        },
      },
    ]);
    assert.deepEqual(syncState, {
      "target-bindings": {
        status: "fresh",
        updatedAtMs: 2000,
        lastReconcileAction: "follower-register",
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader follower target provisioner transfers a live session-reload target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-reload-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const calls: unknown[] = [];
  let syncState = {};
  store.upsert({
    profileKey: "manual:owner-a",
    owner: { kind: "manual-follower", instanceId: "owner-a" },
    target: { chatId: 7, threadId: 12 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "follower-a",
    slot: "E",
    threadName: "Ember",
  });
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
  });
  try {
    assert.deepEqual(
      await provision({
        instanceId: "follower-reloaded",
        profileKey: "manual:owner-a",
        target: { chatId: 7, threadId: 12 },
        connectedAtMs: 1000,
      }),
      { chatId: 7, threadId: 12, slot: "E", threadName: "Ember" },
    );
    assert.deepEqual(calls, [
      {
        method: "sendMessage",
        body: {
          chat_id: 7,
          message_thread_id: 12,
          text: "📡 Instance <b>Ember</b> connected.",
          parse_mode: "HTML",
        },
      },
    ]);
    assert.equal(store.list()[0]?.instanceId, "follower-reloaded");
    assert.equal(
      store.list()[0]?.lastReconcileAction,
      "follower-session-handoff",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader replaces a cross-session follower target proven stale by the visibility probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-stale-tab-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let syncState = {};
  store.upsert({
    profileKey: "manual:owner-a",
    owner: { kind: "manual-follower", instanceId: "owner-a" },
    target: { chatId: 7, threadId: 12 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "follower-a",
    slot: "E",
    threadName: "Ember",
  });
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "sendMessage" && body.message_thread_id === 12) {
        throw new Error("Bad Request: TOPIC_ID_INVALID");
      }
      if (method === "createForumTopic") {
        return { message_thread_id: 13 } as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
    getNowMs: () => 1000,
  });
  try {
    assert.deepEqual(
      await provision({
        instanceId: "follower-reloaded",
        profileKey: "manual:owner-a",
        target: { chatId: 7, threadId: 12 },
        connectedAtMs: 1000,
      }),
      { chatId: 7, threadId: 13, slot: "F", threadName: "Ember" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      calls.map((call) => call.method),
      ["sendMessage", "createForumTopic", "sendMessage"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader rejects cross-session registration when visibility remains ambiguous", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-ambiguous-tab-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  store.upsert({
    profileKey: "manual:owner-a",
    owner: { kind: "manual-follower", instanceId: "owner-a" },
    target: { chatId: 7, threadId: 12 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "follower-a",
    slot: "E",
    threadName: "Ember",
  });
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (calls.length === 1) {
        throw new Error("Telegram send acknowledgement was lost");
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => ({}),
    setSyncState: () => undefined,
    recordRuntimeEvent() {},
    getNowMs: () => 1000,
  });
  try {
    await assert.rejects(
      provision({
        instanceId: "follower-reloaded",
        profileKey: "manual:owner-a",
        target: { chatId: 7, threadId: 12 },
        connectedAtMs: 1000,
      }),
      /acknowledgement was lost/,
    );
    assert.deepEqual(calls.map((call) => call.method), ["sendMessage"]);
    const preserved = store.getByProfileKey("manual:owner-a");
    assert.equal(preserved?.status, "active");
    assert.equal(preserved?.instanceId, "follower-a");

    assert.deepEqual(
      await provision({
        instanceId: "follower-reloaded",
        profileKey: "manual:owner-a",
        connectedAtMs: 1100,
      }),
      { chatId: 7, threadId: 12, slot: "E", threadName: "Ember" },
    );
    assert.deepEqual(calls.map((call) => call.method), [
      "sendMessage",
      "sendMessage",
    ]);
    assert.equal(
      store.getByProfileKey("manual:owner-a")?.instanceId,
      "follower-reloaded",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Reloaded bus leader reuses a surviving follower's persisted target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-leader-reload-follower-"));
  const path = join(dir, "state.json");
  const previousStore = createTelegramTopicTargetStore({ path });
  previousStore.upsert({
    profileKey: "manual:owner-a",
    owner: { kind: "manual-follower", instanceId: "owner-a" },
    target: { chatId: 7, threadId: 12 },
    status: "active",
    createdAtMs: 500,
    updatedAtMs: 500,
    instanceId: "follower-a",
    slot: "E",
    threadName: "Ember",
  });
  await previousStore.persist();
  const reloadedStore = createTelegramTopicTargetStore({ path });
  const calls: unknown[] = [];
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: reloadedStore,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
  });
  try {
    assert.deepEqual(
      await provision({
        instanceId: "follower-a",
        profileKey: "manual:owner-a",
        target: { chatId: 7, threadId: 12 },
        connectedAtMs: 1000,
      }),
      { chatId: 7, threadId: 12, slot: "E", threadName: "Ember" },
    );
    assert.deepEqual(calls, []);
    assert.equal(reloadedStore.list().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader recovers a live follower target missing from persisted state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-live-target-recovery-"));
  const path = join(dir, "state.json");
  const store = createTelegramTopicTargetStore({
    path,
    getNowMs: () => 2000,
  });
  store.upsert({
    profileKey: "cwd:/leader",
    owner: { kind: "leader", cwd: "/leader" },
    target: { chatId: 7, threadId: 11 },
    status: "active",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    instanceId: "leader-a",
    slot: "E",
    threadName: "Atlas",
  });
  store.setStatusSnapshot({
    liveRoster: {
      busFollowers: [
        {
          instanceId: "follower-e",
          target: {
            chatId: 7,
            threadId: 12,
            slot: "E",
            threadName: "Eagle",
          },
        },
      ],
    },
  });
  await store.persist();
  const reloadedStore = createTelegramTopicTargetStore({
    path,
    getNowMs: () => 2000,
  });
  const calls: unknown[] = [];
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: reloadedStore,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    assert.deepEqual(
      await provision({
        instanceId: "follower-e",
        profileKey: "manual:owner-e",
        target: { chatId: 7, threadId: 12 },
        threadName: "extensions",
        connectedAtMs: 1500,
      }),
      { chatId: 7, threadId: 12, slot: undefined, threadName: "Eagle" },
    );
    assert.deepEqual(
      calls.map((call) =>
        (call as { method: string; body: Record<string, unknown> }).method,
      ),
      ["sendMessage"],
    );
    const recovered = reloadedStore.getByProfileKey("manual:owner-e");
    assert.deepEqual(recovered?.target, { chatId: 7, threadId: 12 });
    assert.equal(recovered?.instanceId, "follower-e");
    assert.equal(recovered?.threadName, "Eagle");
    assert.equal(recovered?.slot, undefined);
    assert.equal(recovered?.lastReconcileAction, "follower-live-target-recovery");
    assert.equal(reloadedStore.getBotState().lastSlot, "E");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader reprobes an unresolved absent carried target on targetless retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-carried-probe-retry-"));
  const path = join(dir, "state.json");
  const store = createTelegramTopicTargetStore({
    path,
    getNowMs: () => 2000,
  });
  let attempts = 0;
  const callApi = async <TResponse>() => {
    attempts += 1;
    if (attempts === 1) throw new Error("acknowledgement lost");
    return { ok: true } as TResponse;
  };
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    callApi,
    getSyncState: () => ({}),
    setSyncState: () => undefined,
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    await assert.rejects(
      provision({
        instanceId: "follower-recovered",
        profileKey: "manual:owner-a",
        target: { chatId: 7, threadId: 12 },
        connectedAtMs: 2000,
      }),
      /acknowledgement lost/,
    );
    assert.equal(store.list()[0]?.status, "probe-required");

    const reloadedStore = createTelegramTopicTargetStore({
      path,
      getNowMs: () => 2100,
    });
    const retryProvision = createTelegramBusFollowerTargetProvisioner({
      getAllowedUserId: () => 7,
      topicTargetStore: reloadedStore,
      callApi,
      getSyncState: () => ({}),
      setSyncState: () => undefined,
      recordRuntimeEvent() {},
      getNowMs: () => 2100,
    });
    assert.deepEqual(
      await retryProvision({
        instanceId: "follower-recovered",
        profileKey: "manual:owner-a",
        connectedAtMs: 2100,
      }),
      {
        chatId: 7,
        threadId: 12,
        slot: undefined,
        threadName: undefined,
      },
    );
    assert.equal(attempts, 2);
    assert.equal(reloadedStore.list()[0]?.status, "active");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader keeps an absent carried target provisional until visibility succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-carried-probe-pending-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 2000,
  });
  let resolveProbe: (() => void) | undefined;
  let probeStarted = false;
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>() {
      probeStarted = true;
      await new Promise<void>((resolve) => {
        resolveProbe = resolve;
      });
      return { ok: true } as TResponse;
    },
    getSyncState: () => ({}),
    setSyncState: () => undefined,
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    const pending = provision({
      instanceId: "follower-recovered",
      profileKey: "manual:owner-a",
      target: { chatId: 7, threadId: 12 },
      connectedAtMs: 2000,
    });
    await waitForCondition(() => probeStarted);
    assert.equal(store.list().length, 0);
    resolveProbe?.();
    assert.deepEqual(await pending, {
      chatId: 7,
      threadId: 12,
      slot: undefined,
      threadName: undefined,
    });
    assert.equal(store.list()[0]?.status, "active");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader replaces a carried target proven deleted after disconnect acknowledgement loss", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-disconnect-ack-loss-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 2000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "sendMessage" && body.message_thread_id === 12) {
        throw new Error("Bad Request: TOPIC_ID_INVALID");
      }
      if (method === "createForumTopic") {
        return { message_thread_id: 13 } as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => ({}),
    setSyncState: () => undefined,
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    assert.deepEqual(
      await provision({
        instanceId: "follower-recovered",
        profileKey: "manual:owner-a",
        target: { chatId: 7, threadId: 12 },
        connectedAtMs: 2000,
      }),
      { chatId: 7, threadId: 13, slot: "A", threadName: "Atlas" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      calls.map((call) => call.method),
      ["sendMessage", "createForumTopic", "sendMessage"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader follower target provisioner restores an existing manual follower thread", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-stale-provision-"),
  );
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  store.upsert({
    profileKey: "manual:follower-a",
    owner: { kind: "manual-follower", instanceId: "follower-a" },
    target: { chatId: 7, threadId: 8 },
    status: "active",
    createdAtMs: 1000,
    updatedAtMs: 1000,
    instanceId: "follower-a",
    slot: "A",
    threadName: "Amber",
  });
  await store.persist();
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const events: Array<{ category: string; details?: Record<string, unknown> }> =
    [];
  let syncState = {};
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "createForumTopic") {
        return { message_thread_id: 13 } as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    recordRuntimeEvent(category, _error, details) {
      events.push({ category, details });
    },
    getNowMs: () => 2000,
  });
  try {
    assert.deepEqual(
      await provision({ instanceId: "follower-a", connectedAtMs: 0 }),
      { chatId: 7, threadId: 8, slot: "A", threadName: "Amber" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, []);
    assert.deepEqual(store.getByProfileKey("manual:follower-a")?.target, {
      chatId: 7,
      threadId: 8,
    });
    assert.equal(events.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader follower target provisioner coalesces concurrent follower registrations", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-concurrent-provision-"),
  );
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let createTopicResolve:
    ((value: { message_thread_id: number }) => void) | undefined;
  const provision = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "createForumTopic") {
        return (await new Promise<{ message_thread_id: number }>((resolve) => {
          createTopicResolve = resolve;
        })) as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => ({}),
    setSyncState: () => undefined,
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    const first = provision({ instanceId: "follower-a", connectedAtMs: 0 });
    const second = provision({ instanceId: "follower-a", connectedAtMs: 1 });
    await waitForCondition(() => createTopicResolve !== undefined);
    assert.equal(
      calls.filter((call) => call.method === "createForumTopic").length,
      1,
    );
    createTopicResolve?.({ message_thread_id: 13 });
    assert.deepEqual(await first, {
      chatId: 7,
      threadId: 13,
      slot: "A",
      threadName: "Atlas",
    });
    assert.deepEqual(await second, {
      chatId: 7,
      threadId: 13,
      slot: "A",
      threadName: "Atlas",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader target provisioner creates thread and announces connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-leader-provision-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 1000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let syncState = {};
  let leaderTarget: unknown;
  let provisioning = 0;
  const provision = createTelegramBusLeaderTargetProvisioner({
    getAllowedUserId: () => 7,
    instanceId: "leader-a",
    getCwd: (ctx: { cwd: string }) => ctx.cwd,
    topicTargetStore: store,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      if (method === "createForumTopic") {
        return { message_thread_id: 11 } as TResponse;
      }
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    setLeaderTarget: (input) => {
      leaderTarget = input;
    },
    onProvisioningStart: () => {
      provisioning += 1;
    },
    onProvisioningEnd: () => {
      provisioning -= 1;
    },
    recordRuntimeEvent() {},
    getNowMs: () => 2000,
  });
  try {
    await provision({ cwd: "/repo" });
    assert.equal(provisioning, 0);
    assert.deepEqual(leaderTarget, {
      target: { chatId: 7, threadId: 11 },
      slot: "A",
      threadName: "Atlas",
    });
    assert.deepEqual(calls, [
      { method: "createForumTopic", body: { chat_id: 7, name: "Atlas" } },
      {
        method: "sendMessage",
        body: {
          chat_id: 7,
          message_thread_id: 11,
          text: "📡 Instance <b>Atlas</b> connected.",
          parse_mode: "HTML",
        },
      },
    ]);
    assert.deepEqual(syncState, {
      "target-bindings": {
        status: "fresh",
        updatedAtMs: 2000,
        lastReconcileAction: "leader-startup",
      },
      reservations: {
        status: "fresh",
        updatedAtMs: 2000,
        lastReconcileAction: "leader-startup",
      },
      "topic-capability": {
        status: "fresh",
        updatedAtMs: 2000,
        lastReconcileAction: "leader-startup",
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader builds lifecycle announcements with thread name before slot", () => {
  assert.deepEqual(
    createTelegramBusInstanceLifecycleAnnouncement({
      target: { chatId: 123, threadId: 45 },
      threadName: "Cedar",
      slot: "C",
      state: "connected",
    }),
    {
      target: { chatId: 123, threadId: 45 },
      text: "📡 Instance <b>Cedar</b> connected.",
      parseMode: "HTML",
    },
  );
  assert.deepEqual(
    createTelegramBusFollowerDisconnectedAnnouncement({
      follower: {
        instanceId: "inst-c",
        target: { chatId: 123, threadId: 45 },
        connectedAtMs: 1000,
        lastHeartbeatMs: 1200,
      },
      threadName: "Cedar",
      slot: "C",
    }),
    {
      target: { chatId: 123, threadId: 45 },
      text: "📡 Instance <b>Cedar</b> disconnected.",
      parseMode: "HTML",
    },
  );
});

test("Bus leader lifecycle announcements fall back to slot identity", () => {
  assert.deepEqual(
    createTelegramBusFollowerDisconnectedAnnouncement({
      follower: {
        instanceId: "inst-c",
        target: { chatId: 123, threadId: 45 },
        connectedAtMs: 1000,
        lastHeartbeatMs: 1200,
      },
      slot: "C",
    }),
    {
      target: { chatId: 123, threadId: 45 },
      text: "📡 Instance <b>C</b> disconnected.",
      parseMode: "HTML",
    },
  );
});

test("Bus leader skips follower disconnected announcements without a target thread", () => {
  assert.equal(
    createTelegramBusFollowerDisconnectedAnnouncement({
      follower: {
        instanceId: "inst-c",
        target: { chatId: 123 },
        connectedAtMs: 1000,
        lastHeartbeatMs: 1200,
      },
      slot: "C",
    }),
    undefined,
  );
});

test("Bus leader activation scheduler hot-switches an owning classic poller", async () => {
  const events: string[] = [];
  let busStarted = false;
  const schedule = createTelegramBusLeaderActivationScheduler<{ cwd: string }>({
    isBusEnabled: () => true,
    ownsPolling: () => true,
    isBusPollingStarted: () => busStarted,
    setBusPollingStarted: (started) => {
      busStarted = started;
      events.push(`bus:${started}`);
    },
    stopClassicPolling: async () => {
      events.push("classic:stop");
    },
    startClassicPolling: async () => {
      events.push("classic:start");
    },
    startBusLeaderPolling: async (ctx) => {
      events.push(`leader:start:${ctx.cwd}`);
    },
    updateStatus: () => {
      events.push("status");
    },
    recordRuntimeEvent: (category, error, details) => {
      events.push(`${category}:${details?.phase}:${String(error)}`);
    },
  });

  schedule({ cwd: "/repo" });
  await waitForCondition(() => busStarted);

  assert.deepEqual(events, [
    "classic:stop",
    "leader:start:/repo",
    "bus:true",
    "status",
    "bus:leader-hot-switch:Telegram bus leader mode activated",
  ]);
});

test("Bus leader envelope handler registers and heartbeats followers", async () => {
  const registry = createTelegramBusFollowerRegistry();
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    getNowMs: () => 2000,
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.register",
      requestId: "inst-a:1",
      registration: {
        instanceId: "inst-a",
        cwd: "/repo",
        connectedAtMs: 1000,
        registrationGeneration: "inst-a:1",
        slot: "C",
      },
    }),
    { kind: "bus.ack", requestId: "inst-a:1", ok: true },
  );
  assert.deepEqual(registry.get("inst-a"), {
    instanceId: "inst-a",
    cwd: "/repo",
    connectedAtMs: 2000,
    lastHeartbeatMs: 2000,
    registrationGeneration: "inst-a:1",
    target: undefined,
    slot: "C",
  });
  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.heartbeat",
      requestId: "inst-a:2",
      instanceId: "inst-a",
      registrationGeneration: "inst-a:1",
      sentAtMs: 1500,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:2",
      ok: true,
      result: { eligibleElectionSlots: ["C"] },
    },
  );
  assert.equal(registry.get("inst-a")?.lastHeartbeatMs, 2000);
});

test("Bus leader rejects generationless registration and disconnect envelopes", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "inst-a",
    connectedAtMs: 1000,
    registrationGeneration: "inst-a:1",
  });
  let disconnects = 0;
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    onFollowerDisconnected() {
      disconnects += 1;
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.register",
      requestId: "inst-b:1",
      registration: { instanceId: "inst-b", connectedAtMs: 1000 },
    }),
    {
      kind: "bus.ack",
      requestId: "inst-b:1",
      ok: false,
      message: "Telegram follower registration requires an exact generation.",
    },
  );
  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.disconnect",
      requestId: "inst-a:2",
      instanceId: "inst-a",
      sentAtMs: 2000,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:2",
      ok: false,
      message: "Stale Telegram bus follower registration generation.",
    },
  );
  assert.equal(disconnects, 0);
  assert.equal(registry.get("inst-a")?.registrationGeneration, "inst-a:1");
});

test("Bus leader serializes disconnect cleanup before cross-session registration", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "inst-a",
    profileKey: "manual:owner-a",
    connectedAtMs: 1000,
    registrationGeneration: "inst-a:A",
    target: { chatId: 7, threadId: 42 },
  });
  let releaseCleanup: (() => void) | undefined;
  let markCleanupStarted: (() => void) | undefined;
  const cleanupStarted = new Promise<void>((resolve) => {
    markCleanupStarted = resolve;
  });
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    async onFollowerDisconnected() {
      markCleanupStarted?.();
      await new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
    },
  });

  const disconnect = handleEnvelope({
    kind: "follower.disconnect",
    requestId: "inst-a:disconnect",
    instanceId: "inst-a",
    registrationGeneration: "inst-a:A",
    sentAtMs: 2000,
  });
  await cleanupStarted;
  let replacementSettled = false;
  const replacement = Promise.resolve(
    handleEnvelope({
      kind: "follower.register",
      requestId: "inst-b:B",
      registration: {
        instanceId: "inst-b",
        profileKey: "manual:owner-a",
        connectedAtMs: 2100,
        registrationGeneration: "inst-b:B",
        target: { chatId: 7, threadId: 43 },
      },
    }),
  ).then((result) => {
    replacementSettled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(replacementSettled, false);
  releaseCleanup?.();

  assert.deepEqual(await disconnect, {
    kind: "bus.ack",
    requestId: "inst-a:disconnect",
    ok: true,
  });
  assert.deepEqual(await replacement, {
    kind: "bus.ack",
    requestId: "inst-b:B",
    ok: true,
    result: { chatId: 7, threadId: 43 },
  });
  assert.equal(registry.get("inst-a"), undefined);
  assert.equal(registry.get("inst-b")?.registrationGeneration, "inst-b:B");
  assert.deepEqual(registry.get("inst-b")?.target, {
    chatId: 7,
    threadId: 43,
  });
});

test("Bus leader stamps follower liveness after slow target provisioning", async () => {
  const registry = createTelegramBusFollowerRegistry();
  let nowMs = 1000;
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    getNowMs: () => nowMs,
    provisionFollowerTarget() {
      nowMs = 21000;
      return { chatId: -1007, threadId: 42 };
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.register",
      requestId: "inst-a:1",
      registration: {
        instanceId: "inst-a",
        cwd: "/repo",
        connectedAtMs: 1000,
        registrationGeneration: "inst-a:1",
      },
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:1",
      ok: true,
      result: { chatId: -1007, threadId: 42 },
    },
  );

  assert.equal(registry.get("inst-a")?.lastHeartbeatMs, 21000);
  assert.deepEqual(registry.pruneStale(21001, 15000), []);
});

test("Bus leader envelope handler rejects unknown follower heartbeats", async () => {
  const registry = createTelegramBusFollowerRegistry();
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.heartbeat",
      requestId: "missing:1",
      instanceId: "missing",
      sentAtMs: 1000,
    }),
    {
      kind: "bus.ack",
      requestId: "missing:1",
      ok: false,
      message: "Unknown Telegram bus follower instance.",
    },
  );
});

test("Bus leader provisions targets before registering followers", async () => {
  const registry = createTelegramBusFollowerRegistry();
  const provisioned: unknown[] = [];
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    provisionFollowerTarget(registration) {
      provisioned.push(registration);
      return { chatId: -1007, threadId: 42 };
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.register",
      requestId: "inst-a:1",
      registration: {
        instanceId: "inst-a",
        profileKey: "cwd:/repo",
        threadName: "repo",
        connectedAtMs: 1000,
        registrationGeneration: "inst-a:1",
      },
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:1",
      ok: true,
      result: { chatId: -1007, threadId: 42 },
    },
  );
  assert.deepEqual(registry.get("inst-a")?.target, {
    chatId: -1007,
    threadId: 42,
  });
  assert.deepEqual(provisioned, [
    {
      instanceId: "inst-a",
      profileKey: "cwd:/repo",
      threadName: "repo",
      connectedAtMs: 1000,
      registrationGeneration: "inst-a:1",
    },
  ]);
});

test("Bus leader does not acknowledge registration after ambiguous visibility failure", async () => {
  const registry = createTelegramBusFollowerRegistry();
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    async provisionFollowerTarget() {
      throw new Error("Telegram send acknowledgement was lost");
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.register",
      requestId: "inst-a:1",
      registration: {
        instanceId: "inst-a",
        connectedAtMs: 1000,
        registrationGeneration: "inst-a:1",
        target: { chatId: 7, threadId: 42 },
      },
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:1",
      ok: false,
      message: "Telegram send acknowledgement was lost",
    },
  );
  assert.equal(registry.get("inst-a"), undefined);
});

test("Bus leader rejects follower registration after provisioning loses epoch", async () => {
  const registry = createTelegramBusFollowerRegistry();
  let leaderEpoch: number | undefined = 1;
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    getCurrentLeaderEpoch: () => leaderEpoch,
    async provisionFollowerTarget() {
      leaderEpoch = undefined;
      return { chatId: -1007, threadId: 42 };
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.register",
      requestId: "inst-a:lost",
      registration: {
        instanceId: "inst-a",
        connectedAtMs: 1000,
        registrationGeneration: "inst-a:lost",
      },
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:lost",
      ok: false,
      message: "Telegram follower registration lost leader ownership.",
    },
  );
  assert.equal(registry.get("inst-a"), undefined);
});

test("Bus leader records ownership for follower-sent messages", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "inst-a",
    connectedAtMs: 1000,
    target: { chatId: 1, threadId: 42 },
  });
  const ownership: unknown[] = [];
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    getNowMs: () => 4000,
    callApi() {
      return { message_id: 44 };
    },
    recordFollowerMessageOwnership(record) {
      ownership.push({
        instanceId: record.follower.instanceId,
        chatId: record.chatId,
        messageId: record.messageId,
        target: record.target,
      });
    },
  });

  await handleEnvelope({
    kind: "follower.callApi",
    requestId: "inst-a:4",
    instanceId: "inst-a",
    method: "call",
    args: ["sendMessage", { chat_id: 1, text: "Menu" }],
    sentAtMs: 4000,
  });

  assert.deepEqual(ownership, [
    {
      instanceId: "inst-a",
      chatId: 1,
      messageId: 44,
      target: { chatId: 1, threadId: 42 },
    },
  ]);
});

test("Bus leader handles follower API call envelopes for registered followers", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({ instanceId: "inst-a", connectedAtMs: 1000 });
  const calls: unknown[] = [];
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    getNowMs: () => 4000,
    callApi(method, args) {
      calls.push({ method, args });
      return { message_id: 44 };
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.callApi",
      requestId: "inst-a:4",
      instanceId: "inst-a",
      method: "sendRichMessage",
      args: [{ chat_id: 1 }],
      sentAtMs: 4000,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:4",
      ok: true,
      result: { message_id: 44 },
    },
  );
  assert.deepEqual(calls, [
    { method: "sendRichMessage", args: [{ chat_id: 1 }] },
  ]);
  assert.equal(registry.get("inst-a")?.lastHeartbeatMs, 4000);
  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.callApi",
      requestId: "missing:1",
      instanceId: "missing",
      method: "sendRichMessage",
      args: [],
      sentAtMs: 5000,
    }),
    {
      kind: "bus.ack",
      requestId: "missing:1",
      ok: false,
      message: "Unknown Telegram bus follower instance.",
    },
  );
});

test("Bus leader rejects delayed API calls from a replaced follower generation", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "inst-a",
    connectedAtMs: 2000,
    registrationGeneration: "generation-new",
  });
  let apiCalls = 0;
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    callApi() {
      apiCalls += 1;
      return { ok: true };
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.callApi",
      requestId: "inst-a:old:1",
      instanceId: "inst-a",
      registrationGeneration: "generation-old",
      method: "call",
      args: ["sendMessage", { chat_id: 1 }],
      sentAtMs: 3000,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:old:1",
      ok: false,
      message: "Stale Telegram bus follower registration generation.",
    },
  );
  assert.equal(apiCalls, 0);
});

test("Bus leader encodes commit-unknown API failures structurally", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({ instanceId: "inst-a", connectedAtMs: 1000 });
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    async callApi() {
      throw new TelegramApiCommitUnknownError(
        "sendMessage",
        new Error("response lost"),
      );
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.callApi",
      requestId: "inst-a:ambiguous:1",
      instanceId: "inst-a",
      method: "call",
      args: ["sendMessage", { chat_id: 1 }],
      sentAtMs: 4000,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:ambiguous:1",
      ok: false,
      message:
        "Telegram API sendMessage may have committed before transport failed.",
      error: { code: "commit-unknown", method: "sendMessage" },
    },
  );
});

test("Bus leader rejects unauthenticated envelopes when a secret is configured", async () => {
  const registry = createTelegramBusFollowerRegistry();
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    authSecret: "secret",
  });

  for (const envelope of [
    {
      kind: "follower.register" as const,
      requestId: "inst-a:1",
      registration: {
        instanceId: "inst-a",
        connectedAtMs: 1000,
        registrationGeneration: "inst-a:1",
      },
    },
    {
      kind: "follower.heartbeat" as const,
      requestId: "inst-a:2",
      instanceId: "inst-a",
      sentAtMs: 2000,
    },
    {
      kind: "follower.callApi" as const,
      requestId: "inst-a:3",
      instanceId: "inst-a",
      method: "call",
      args: ["sendMessage", {}],
      sentAtMs: 3000,
    },
    {
      kind: "leader.forwardMessage" as const,
      requestId: "leader:4",
      recipientInstanceId: "inst-a",
      message: { message_id: 1 },
      sentAtMs: 4000,
    },
  ]) {
    assert.deepEqual(await handleEnvelope(envelope), {
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message: "Unauthorized Telegram bus envelope.",
    });
  }
});

test("Bus leader authorizes scoped follower API calls", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "inst-a",
    connectedAtMs: 1000,
    target: { chatId: 100, threadId: 42 },
  });
  const calls: unknown[] = [];
  const handleEnvelope = createTelegramBusLeaderEnvelopeHandler({
    followerRegistry: registry,
    authorizeFollowerApiCall({ follower, method, args }) {
      const body = args[1] as Record<string, unknown> | undefined;
      return (
        follower.target?.chatId === 100 &&
        method === "call" &&
        args[0] === "sendMessage" &&
        body?.chat_id === 100 &&
        body?.message_thread_id === 42
      );
    },
    callApi(method, args) {
      calls.push({ method, args });
      return { ok: true };
    },
  });

  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.callApi",
      requestId: "inst-a:allowed",
      instanceId: "inst-a",
      method: "call",
      args: ["sendMessage", { chat_id: 100, message_thread_id: 42 }],
      sentAtMs: 2000,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:allowed",
      ok: true,
      result: { ok: true },
    },
  );
  assert.deepEqual(
    await handleEnvelope({
      kind: "follower.callApi",
      requestId: "inst-a:denied",
      instanceId: "inst-a",
      method: "call",
      args: ["deleteMessage", { chat_id: 999 }],
      sentAtMs: 3000,
    }),
    {
      kind: "bus.ack",
      requestId: "inst-a:denied",
      ok: false,
      message: "Telegram bus API call is not allowed for this follower.",
    },
  );
  assert.deepEqual(calls, [
    {
      method: "call",
      args: ["sendMessage", { chat_id: 100, message_thread_id: 42 }],
    },
  ]);
});

test("Bus leader assembly wires provisioners, reconciliation, API, and runtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-leader-assembly-"));
  const socketPath = join(dir, "bus.sock");
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const events: string[] = [];
  let syncState = {};
  const runtime = createTelegramBusLeaderRuntimeAssembly({
    runtime: {
      socketPath,
      followerRegistry: createTelegramBusFollowerRegistry(),
      startPolling: () => {
        events.push("poll-start");
      },
      stopPolling: () => {
        events.push("poll-stop");
      },
    },
    getAllowedUserId: () => undefined,
    instanceId: "leader-a",
    topicTargetStore: store,
    callApi: async <TResponse>() => ({ ok: true }) as TResponse,
    callMultipart: async () => ({ ok: true }),
    downloadFile: async () => undefined,
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    setLeaderTarget: () => undefined,
    recordRuntimeEvent: () => undefined,
  });
  try {
    await runtime.startPolling("ctx");
    await runtime.stopPolling();
    assert.deepEqual(events, ["poll-start", "poll-stop"]);
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader runtime provisions leader target before polling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-leader-target-"));
  const socketPath = join(dir, "bus.sock");
  const events: string[] = [];
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: createTelegramBusFollowerRegistry(),
    provisionLeaderTarget: (ctx) => {
      events.push(`leader:${ctx}`);
    },
    startPolling: () => {
      events.push("poll:start");
    },
    stopPolling: () => {
      events.push("poll:stop");
    },
  });
  try {
    await runtime.startPolling("ctx");
    await runtime.stopPolling();
    assert.deepEqual(events, ["leader:ctx", "poll:start", "poll:stop"]);
  } finally {
    await runtime.stopPolling().catch(() => undefined);
  }
});

test("Bus leader runtime starts the local server around polling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-leader-"));
  const socketPath = join(dir, "bus.sock");
  const events: string[] = [];
  const registry = createTelegramBusFollowerRegistry();
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: registry,
    followerPruneIntervalMs: 10,
    startPolling: () => {
      events.push("poll:start");
    },
    stopPolling: () => {
      events.push("poll:stop");
    },
  });
  try {
    await runtime.startPolling("ctx");
    assert.equal(
      (
        await sendTelegramBusLocalEnvelope({
          socketPath,
          envelope: {
            kind: "follower.register",
            requestId: "inst-a:1",
            registration: {
              instanceId: "inst-a",
              connectedAtMs: 1000,
              registrationGeneration: "inst-a:1",
            },
          },
        })
      )?.kind,
      "bus.ack",
    );
    assert.equal(registry.get("inst-a")?.instanceId, "inst-a");
    unlinkSync(socketPath);
    await waitForCondition(() => existsSync(socketPath));
    assert.deepEqual(events, ["poll:start"]);
    await runtime.stopPolling();
    assert.deepEqual(events, ["poll:start", "poll:stop"]);
    await assert.rejects(
      sendTelegramBusLocalEnvelope({
        socketPath,
        envelope: {
          kind: "follower.heartbeat",
          requestId: "inst-a:2",
          instanceId: "inst-a",
          sentAtMs: 2000,
        },
        timeoutMs: 50,
      }),
    );
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader runtime reconciles follower bindings after reload grace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-reality-grace-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const observedRosters: string[][] = [];
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: registry,
    followerRecoveryGraceMs: 15,
    reconcileFollowerBindings: () => {
      observedRosters.push(
        registry.list().map((follower) => follower.instanceId),
      );
    },
    startPolling: () => undefined,
    stopPolling: () => undefined,
  });
  try {
    await runtime.startPolling("ctx");
    registry.register({ instanceId: "reconnected", connectedAtMs: 1 });
    assert.deepEqual(observedRosters, []);
    await waitForCondition(() => observedRosters.length === 1);
    assert.deepEqual(observedRosters, [["reconnected"]]);
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader runtime prunes stale followers while polling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-prune-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const runtimeEvents: string[] = [];
  let nowMs = 1000;
  registry.register({ instanceId: "fresh", connectedAtMs: 950 });
  registry.register({ instanceId: "stale", connectedAtMs: 0 });
  registry.heartbeat("fresh", 950);
  registry.heartbeat("stale", 0);
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: registry,
    getNowMs: () => nowMs,
    followerPruneIntervalMs: 5,
    followerStaleAfterMs: 100,
    startPolling: () => undefined,
    stopPolling: () => undefined,
    recordRuntimeEvent: (category, error, details) => {
      runtimeEvents.push(
        `${category}:${details?.phase}:${details?.instanceId}:${String(error)}`,
      );
    },
  });
  try {
    await runtime.startPolling("ctx");
    await waitForCondition(() => registry.get("stale") === undefined);
    assert.equal(registry.get("fresh")?.instanceId, "fresh");
    assert.equal(
      runtimeEvents.includes(
        "bus:follower-prune:stale:Telegram bus follower timed out",
      ),
      true,
    );
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader runtime reports pruned followers to offline hook", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-prune-offline-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const offline: unknown[] = [];
  registry.register({
    instanceId: "stale",
    profileKey: "cwd:/repo",
    target: { chatId: -1001, threadId: 42 },
    connectedAtMs: 0,
  });
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: registry,
    getNowMs: () => 1000,
    followerPruneIntervalMs: 5,
    followerStaleAfterMs: 100,
    startPolling: () => undefined,
    stopPolling: () => undefined,
    onFollowerPruned(follower) {
      offline.push(follower);
    },
  });
  try {
    await runtime.startPolling("ctx");
    await waitForCondition(() => offline.length === 1);
    assert.deepEqual(offline, [
      {
        instanceId: "stale",
        profileKey: "cwd:/repo",
        target: { chatId: -1001, threadId: 42 },
        connectedAtMs: 0,
        lastHeartbeatMs: 0,
      },
    ]);
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader runtime stops stale follower pruning and clears registry on stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-prune-stop-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  let nowMs = 1000;
  registry.register({ instanceId: "stale", connectedAtMs: 0 });
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: registry,
    getNowMs: () => nowMs,
    followerPruneIntervalMs: 50,
    followerStaleAfterMs: 100,
    startPolling: () => undefined,
    stopPolling: () => undefined,
  });
  try {
    await runtime.startPolling("ctx");
    await runtime.stopPolling();
    nowMs = 2000;
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.deepEqual(registry.list(), []);
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus leader runtime stops the local server if polling startup fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-leader-fail-"));
  const socketPath = join(dir, "bus.sock");
  const runtime = createTelegramBusLeaderRuntime({
    socketPath,
    followerRegistry: createTelegramBusFollowerRegistry(),
    startPolling: () => {
      throw new Error("poll failed");
    },
    stopPolling: () => undefined,
  });
  try {
    await assert.rejects(runtime.startPolling("ctx"), /poll failed/);
    await assert.rejects(
      sendTelegramBusLocalEnvelope({
        socketPath,
        envelope: {
          kind: "follower.heartbeat",
          requestId: "inst-a:1",
          instanceId: "inst-a",
          sentAtMs: 1000,
        },
        timeoutMs: 50,
      }),
    );
  } finally {
    await runtime.stopPolling();
    rmSync(dir, { recursive: true, force: true });
  }
});
