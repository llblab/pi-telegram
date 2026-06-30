/**
 * Regression tests for Telegram synchronization helpers
 * Covers demand-driven reconciliation triggers and pure sync-slice state transitions
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  TELEGRAM_SYNC_SLICES,
  createTelegramLeaderHealthRuntime,
  createTelegramTopicLifecycleSyncHandler,
  createUnknownTelegramSyncState,
  ensureTelegramLeaderThreadBinding,
  markTelegramSyncSliceFresh,
  markTelegramSyncSliceSuspect,
  recoverStaleTelegramTopicApiError,
  shouldReconcileTelegramSync,
} from "../lib/sync.ts";
import { createTelegramTopicTargetStore } from "../lib/threads.ts";

test("Telegram sync reconciliation is demand-driven, not per ordinary action", () => {
  for (const trigger of [
    "startup",
    "reload",
    "topic-lifecycle",
    "stale-api-error",
    "setup-change",
    "pairing-change",
    "follower-register",
    "follower-prune",
    "status-request",
    "leader-health-tick",
  ] as const) {
    assert.equal(shouldReconcileTelegramSync(trigger), true);
  }

  assert.equal(shouldReconcileTelegramSync("ordinary-message"), false);
  assert.equal(shouldReconcileTelegramSync("ordinary-send"), false);
});

function createTopicStore(
  records: Array<{
    profileKey?: string;
    target: { chatId: number; threadId: number };
    status?: "active" | "offline" | "stale" | "pending" | "starting" | "failed";
    createdAtMs?: number;
    updatedAtMs?: number;
  }> = [],
) {
  const normalizedRecords = records.map((record, index) => ({
    profileKey: record.profileKey ?? `topic:${index}`,
    target: record.target,
    status: record.status ?? "active",
    createdAtMs: record.createdAtMs ?? 1000,
    updatedAtMs: record.updatedAtMs ?? 1000,
  }));
  return {
    persisted: false,
    records: normalizedRecords,
    async load() {},
    list() {
      return this.records;
    },
    listReservations() {
      return [];
    },
    listPendingProvisions() {
      return [];
    },
    markStaleByTarget(target: { chatId: number; threadId?: number }) {
      const record = this.records.find(
        (item) =>
          item.target.chatId === target.chatId &&
          item.target.threadId === target.threadId,
      );
      if (!record) return false;
      record.status = "stale";
      return true;
    },
    removePendingProvision() {
      return false;
    },
    markActiveByTarget(target: { chatId: number; threadId?: number }) {
      const record = this.records.find(
        (item) =>
          item.target.chatId === target.chatId &&
          item.target.threadId === target.threadId,
      );
      if (!record) return false;
      record.status = "active";
      return true;
    },
    async persist() {
      this.persisted = true;
    },
  };
}

test("Telegram sync recovers stale topic API errors outside the entrypoint", async () => {
  const store = createTopicStore([
    { target: { chatId: 7, threadId: 42 }, status: "active" },
  ]);
  let state = createUnknownTelegramSyncState();
  const events: Array<{
    category: string;
    phase?: unknown;
    threadId?: unknown;
  }> = [];

  const recovered = await recoverStaleTelegramTopicApiError(
    { chat_id: 7, message_thread_id: 42 },
    new Error("Telegram API sendMessage failed: TOPIC_ID_INVALID"),
    {
      topicTargetStore: store,
      getNowMs: () => 1234,
      getSyncState: () => state,
      setSyncState: (nextState) => {
        state = nextState;
      },
      recordEvent: (category, _message, details) => {
        events.push({
          category,
          phase: details?.phase,
          threadId: details?.threadId,
        });
      },
    },
  );

  assert.equal(recovered, true);
  assert.equal(store.records[0]?.status, "stale");
  assert.equal(store.persisted, true);
  assert.equal(state["topic-state"]?.status, "suspect");
  assert.equal(
    state["transport-health"]?.lastReconcileAction,
    "topic-target-stale",
  );
  assert.deepEqual(events, [
    { category: "bus", phase: "topic-target-stale", threadId: 42 },
  ]);
});

test("Telegram sync ignores non-stale topic API errors", async () => {
  const store = createTopicStore([
    { target: { chatId: 7, threadId: 42 }, status: "active" },
  ]);
  let state = createUnknownTelegramSyncState();

  const recovered = await recoverStaleTelegramTopicApiError(
    { chat_id: 7, message_thread_id: 42 },
    new Error("network down"),
    {
      topicTargetStore: store,
      getSyncState: () => state,
      setSyncState: (nextState) => {
        state = nextState;
      },
      recordEvent: () => undefined,
    },
  );

  assert.equal(recovered, false);
  assert.equal(store.records[0]?.status, "active");
  assert.equal(store.persisted, false);
});

test("Telegram leader health runtime refreshes sync slices outside the entrypoint", async () => {
  let state = createUnknownTelegramSyncState();
  let calls = 0;
  const runtime = createTelegramLeaderHealthRuntime({
    intervalMs: 1,
    getNowMs: () => 1234,
    callGetMe: async () => {
      calls += 1;
    },
    getSyncState: () => state,
    setSyncState: (nextState) => {
      state = nextState;
    },
    recordEvent: () => undefined,
  });
  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  runtime.stop();

  assert.equal(calls > 0, true);
  assert.equal(state["transport-health"]?.status, "fresh");
  assert.equal(state["bot-identity"]?.status, "fresh");
  assert.equal(
    state["transport-health"]?.lastReconcileAction,
    "leader-health-tick",
  );
});

test("Telegram leader health runtime marks transport suspect on probe failure", async () => {
  let state = createUnknownTelegramSyncState();
  const events: Array<{ category: string; phase?: unknown }> = [];
  const runtime = createTelegramLeaderHealthRuntime({
    intervalMs: 1,
    getNowMs: () => 1234,
    callGetMe: async () => {
      throw new Error("boom");
    },
    getSyncState: () => state,
    setSyncState: (nextState) => {
      state = nextState;
    },
    recordEvent: (category, _message, details) => {
      events.push({ category, phase: details?.phase });
    },
  });
  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  runtime.stop();

  assert.equal(state["transport-health"]?.status, "suspect");
  assert.equal(
    state["transport-health"]?.lastReconcileAction,
    "leader-health-tick",
  );
  assert.deepEqual(events.at(-1), {
    category: "telegram",
    phase: "leader-health-tick",
  });
});

test("Telegram sync model includes every local assumption slice", () => {
  assert.deepEqual(TELEGRAM_SYNC_SLICES, [
    "bot-identity",
    "bot-capabilities",
    "pairing",
    "allowed-user",
    "topic-capability",
    "topic-state",
    "target-bindings",
    "reservations",
    "transport-health",
  ]);
  assert.deepEqual(createUnknownTelegramSyncState()["reservations"], {
    status: "unknown",
  });
});

test("Telegram sync slice state records suspect and fresh transitions", () => {
  const suspect = markTelegramSyncSliceSuspect({}, "topic-state", {
    nowMs: 1000,
    reason: "topic closed",
    action: "lifecycle-closed",
  });
  assert.deepEqual(suspect["topic-state"], {
    status: "suspect",
    suspectAtMs: 1000,
    reason: "topic closed",
    lastReconcileAction: "lifecycle-closed",
  });

  const fresh = markTelegramSyncSliceFresh(suspect, "topic-state", {
    nowMs: 2000,
    action: "startup-probe",
  });
  assert.deepEqual(fresh["topic-state"], {
    status: "fresh",
    updatedAtMs: 2000,
    lastReconcileAction: "startup-probe",
  });
});

test("Leader thread sync creates a visible leader thread when no binding exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-leader-sync-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "telegram-targets.json"),
    getNowMs: () => 2000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  try {
    const result = await ensureTelegramLeaderThreadBinding({
      getAllowedUserId: () => 7,
      instanceId: "leader-a",
      cwd: "/repo",
      topicTargetStore: store,
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
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Leader thread sync reuses same-profile topic across reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-leader-sync-prev-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "telegram-targets.json"),
    getNowMs: () => 2000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const events: Array<Record<string, unknown>> = [];
  try {
    store.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 7, threadId: 10 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      threadName: "🧭 Axial",
      instanceId: "previous-instance",
      slot: "A",
    });
    await store.persist();

    const result = await ensureTelegramLeaderThreadBinding({
      getAllowedUserId: () => 7,
      instanceId: "leader-a",
      cwd: "/repo",
      topicTargetStore: store,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return { message_thread_id: 11 } as TResponse;
      },
      recordEvent(_category, _message, details) {
        if (details) events.push(details);
      },
    });

    assert.deepEqual(result, {
      target: { chatId: 7, threadId: 10 },
      slot: "A",
      threadName: "🧭 Axial",
      reused: true,
    });
    assert.deepEqual(calls, []);
    const record = store.getByProfileKey("cwd:/repo");
    assert.equal(record?.target.threadId, 10);
    assert.equal(record?.instanceId, "leader-a");
    assert.equal(record?.threadName, "🧭 Axial");
    assert.equal(store.listReservations().length, 0);
    assert.equal(
      events.some(
        (event) => event.phase === "leader-topic-same-profile-preserve",
      ),
      true,
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Leader thread sync reuses same-process legacy leader topic across reload", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "pi-telegram-leader-sync-same-pid-"),
  );
  const store = createTelegramTopicTargetStore({
    path: join(dir, "telegram-targets.json"),
    getNowMs: () => 2000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const events: Array<Record<string, unknown>> = [];
  try {
    store.upsert({
      profileKey: "leader:3824869:1782087343414",
      target: { chatId: 7, threadId: 10 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      threadName: "Nexus",
      instanceId: "3824869:1782087343414",
      slot: "N",
    });
    await store.persist();

    const result = await ensureTelegramLeaderThreadBinding({
      getAllowedUserId: () => 7,
      instanceId: "3824869:1782088512458",
      cwd: "/repo",
      topicTargetStore: store,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return { message_thread_id: 11 } as TResponse;
      },
      recordEvent(_category, _message, details) {
        if (details) events.push(details);
      },
    });

    assert.deepEqual(result, {
      target: { chatId: 7, threadId: 10 },
      slot: "N",
      threadName: "Nexus",
      reused: true,
    });
    assert.deepEqual(calls, []);
    const record = store.getByProfileKey("cwd:/repo");
    assert.equal(record?.target.threadId, 10);
    assert.equal(record?.instanceId, "3824869:1782088512458");
    assert.equal(record?.threadName, "Nexus");
    assert.equal(
      store.getByProfileKey("leader:3824869:1782087343414"),
      undefined,
    );
    assert.equal(store.listReservations().length, 0);
    assert.equal(
      events.some(
        (event) => event.phase === "leader-topic-same-process-preserve",
      ),
      true,
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Leader thread sync does not visibly probe same-profile topic during reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-leader-sync-defer-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "telegram-targets.json"),
    getNowMs: () => 2000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  try {
    store.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 7, threadId: 10 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "previous-instance",
      slot: "A",
    });
    await store.persist();

    const result = await ensureTelegramLeaderThreadBinding({
      getAllowedUserId: () => 7,
      instanceId: "leader-a",
      cwd: "/repo",
      topicTargetStore: store,
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
    assert.equal(store.getByProfileKey("cwd:/repo")?.target.threadId, 10);
    assert.equal(store.listReservations().length, 0);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Leader thread sync proactively deletes known reservations on startup", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "pi-telegram-leader-reservation-cleanup-"),
  );
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 2000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  try {
    store.reserveThread({
      target: { chatId: 7, threadId: 9 },
      slot: "A",
      reason: "previous-process-still-probes-alive",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      expiresAtMs: 10_000,
    });
    await store.persist();

    await ensureTelegramLeaderThreadBinding({
      getAllowedUserId: () => 7,
      instanceId: "leader-a",
      cwd: "/repo",
      topicTargetStore: store,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        if (method === "sendChatAction" && body.message_thread_id === 9) {
          throw new Error(
            "Telegram API sendChatAction failed: HTTP 400: Bad Request: message thread not found",
          );
        }
        return { message_thread_id: 10 } as TResponse;
      },
      recordEvent() {},
    });

    assert.deepEqual(
      calls.slice(0, 3).map((call) => call.method),
      ["closeForumTopic", "deleteForumTopic", "createForumTopic"],
    );
    assert.deepEqual(
      store.listReservations().map((reservation) => reservation.target),
      [{ chatId: 7, threadId: 9 }],
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Leader thread sync preserves follower records from previous instances", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "pi-telegram-leader-preserve-followers-"),
  );
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 2000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  try {
    store.upsert({
      profileKey: "manual:follower-a",
      owner: { kind: "manual-follower", instanceId: "follower-a" },
      target: { chatId: 7, threadId: 10 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "follower-a",
      slot: "T",
    });
    await store.persist();

    await ensureTelegramLeaderThreadBinding({
      getAllowedUserId: () => 7,
      instanceId: "leader-a",
      cwd: "/repo",
      topicTargetStore: store,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return { message_thread_id: 11 } as TResponse;
      },
      recordEvent() {},
    });

    assert.deepEqual(store.getByProfileKey("manual:follower-a")?.target, {
      chatId: 7,
      threadId: 10,
    });
    assert.equal(store.getByProfileKey("manual:follower-a")?.status, "active");
    assert.equal(
      calls.some(
        (call) =>
          (call.method === "closeForumTopic" ||
            call.method === "deleteForumTopic") &&
          call.body.message_thread_id === 10,
      ),
      false,
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Leader thread sync cleans previous leader records regardless of profile key", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "pi-telegram-leader-cross-profile-"),
  );
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 2000,
  });
  try {
    store.upsert({
      profileKey: "leader:previous-id",
      target: { chatId: 7, threadId: 10 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "previous-instance",
      slot: "B",
    });
    await store.persist();

    await ensureTelegramLeaderThreadBinding({
      getAllowedUserId: () => 7,
      instanceId: "leader-a",
      cwd: "/repo",
      topicTargetStore: store,
      async callApi<TResponse>() {
        return { message_thread_id: 11 } as TResponse;
      },
      recordEvent() {},
    });

    assert.equal(store.getByProfileKey("leader:previous-id"), undefined);
    const [reservation] = store.listReservations();
    assert.deepEqual(reservation?.target, { chatId: 7, threadId: 10 });
    assert.equal(reservation?.slot, "B");
    assert.equal(
      reservation?.reason,
      "previous-process-cleaned-without-visible-probe",
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Leader thread sync gets next monotonic slot after D on reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-leader-sync-d-to-e-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 2000,
  });
  try {
    store.upsert({
      profileKey: "leader:old-a",
      target: { chatId: 7, threadId: 10 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "previous-instance",
      slot: "D",
    });
    await store.persist();

    await ensureTelegramLeaderThreadBinding({
      getAllowedUserId: () => 7,
      instanceId: "leader-a",
      cwd: "/repo",
      topicTargetStore: store,
      async callApi<TResponse>() {
        return { message_thread_id: 11 } as TResponse;
      },
      recordEvent() {},
    });

    const [reservation] = store.listReservations();
    assert.equal(reservation?.slot, "D");
    assert.equal(
      reservation?.reason,
      "previous-process-cleaned-without-visible-probe",
    );
    const newRecord = store.getByProfileKey("cwd:/repo");
    assert.equal(newRecord?.slot, "E");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Leader thread sync can force-refresh unnamed stale-prone leader bindings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-leader-sync-refresh-"));
  const store = createTelegramTopicTargetStore({
    path: join(dir, "telegram-targets.json"),
    getNowMs: () => 2000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  try {
    store.upsert({
      profileKey: "cwd:/repo",
      target: { chatId: 7, threadId: 10 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "leader-a",
      slot: "A",
    });
    await store.persist();

    const result = await ensureTelegramLeaderThreadBinding({
      getAllowedUserId: () => 7,
      instanceId: "leader-a",
      cwd: "/repo",
      forceFreshUnnamed: true,
      topicTargetStore: store,
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
      {
        method: "closeForumTopic",
        body: { chat_id: 7, message_thread_id: 10 },
      },
    ]);
    assert.equal(store.getByProfileKey("cwd:/repo")?.target.threadId, 11);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Leader thread sync force-refresh preserves promoted follower bindings", async () => {
  const dir = await mkdtemp(
    join(tmpdir(), "pi-telegram-promoted-follower-refresh-"),
  );
  const store = createTelegramTopicTargetStore({
    path: join(dir, "state.json"),
    getNowMs: () => 2000,
  });
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  try {
    store.upsert({
      profileKey: "manual:follower-b",
      owner: { kind: "manual-follower", instanceId: "follower-b" },
      target: { chatId: 7, threadId: 12 },
      status: "active",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      instanceId: "follower-b",
      slot: "B",
    });
    await store.persist();

    const result = await ensureTelegramLeaderThreadBinding({
      getAllowedUserId: () => 7,
      instanceId: "follower-b",
      cwd: "/repo",
      forceFreshUnnamed: true,
      topicTargetStore: store,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return { message_thread_id: 99 } as TResponse;
      },
      recordEvent() {},
    });

    assert.deepEqual(result, {
      target: { chatId: 7, threadId: 12 },
      slot: "B",
      reused: true,
    });
    assert.deepEqual(calls, []);
    assert.equal(
      store.getActiveByInstanceId("follower-b")?.target.threadId,
      12,
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("Topic lifecycle sync marks known topics stale or active", async () => {
  const store = createTopicStore([
    { target: { chatId: 7, threadId: 42 }, status: "active" },
  ]);
  const events: Array<Record<string, unknown>> = [];
  const handler = createTelegramTopicLifecycleSyncHandler({
    topicTargetStore: store,
    isBusEnabled: () => true,
    async callApi() {
      throw new Error("unexpected API call");
    },
    recordEvent(_category, _message, details) {
      events.push(details ?? {});
    },
  });

  await handler({
    kind: "closed",
    target: { chatId: 7, threadId: 42 },
    message: {},
  });
  assert.equal(store.records[0]?.status, "stale");
  assert.equal(store.persisted, true);
  assert.equal(events[0]?.phase, "topic-lifecycle");
  assert.equal(events[0]?.changed, true);

  store.persisted = false;
  await handler({
    kind: "reopened",
    target: { chatId: 7, threadId: 42 },
    message: {},
  });
  assert.equal(store.records[0]?.status, "active");
  assert.equal(store.persisted, true);
});

test("Topic lifecycle sync loads persisted bindings before deleting created topics", async () => {
  const calls: Array<{ method: string; body: unknown }> = [];
  let loaded = false;
  const store = {
    persisted: false,
    records: [] as Array<{
      profileKey: string;
      target: { chatId: number; threadId: number };
      status: "active";
      createdAtMs: number;
      updatedAtMs: number;
    }>,
    async load() {
      loaded = true;
      this.records = [
        {
          profileKey: "manual:follower",
          target: { chatId: 7, threadId: 42 },
          status: "active",
          createdAtMs: 1000,
          updatedAtMs: 1000,
        },
      ];
    },
    list() {
      return this.records;
    },
    listReservations() {
      return [];
    },
    listPendingProvisions() {
      return [];
    },
    markStaleByTarget() {
      return false;
    },
    markActiveByTarget() {
      return false;
    },
    removePendingProvision() {
      return false;
    },
    async persist() {
      this.persisted = true;
    },
  };
  const handler = createTelegramTopicLifecycleSyncHandler({
    topicTargetStore: store,
    isBusEnabled: () => true,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return {} as TResponse;
    },
  });

  await handler({
    kind: "created",
    target: { chatId: 7, threadId: 42 },
    message: {},
  });

  assert.equal(loaded, true);
  assert.deepEqual(calls, []);
  assert.equal(store.persisted, false);
});

test("Topic lifecycle sync observes unknown created topics without deleting them", async () => {
  const store = createTopicStore();
  const calls: Array<{ method: string; body: unknown }> = [];
  const events: Array<Record<string, unknown>> = [];
  const handler = createTelegramTopicLifecycleSyncHandler({
    topicTargetStore: store,
    isBusEnabled: () => true,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return {} as TResponse;
    },
    recordEvent(_category, _message, details) {
      events.push(details ?? {});
    },
  });

  await handler({
    kind: "created",
    target: { chatId: 7, threadId: 42 },
    message: {},
  });
  assert.deepEqual(calls, []);
  assert.equal(store.persisted, false);
  assert.equal(events[0]?.phase, "topic-lifecycle-unknown-created-observed");

  const classicCalls: Array<{ method: string; body: unknown }> = [];
  store.persisted = false;
  const classicHandler = createTelegramTopicLifecycleSyncHandler({
    topicTargetStore: store,
    isBusEnabled: () => false,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      classicCalls.push({ method, body });
      return {} as TResponse;
    },
  });
  await classicHandler({
    kind: "created",
    target: { chatId: 7, threadId: 43 },
    message: {},
  });
  assert.deepEqual(classicCalls, []);
  assert.equal(store.persisted, false);
});

test("Topic lifecycle sync does not delete unknown created topics during provisioning", async () => {
  const store = createTopicStore();
  const calls: Array<{ method: string; body: unknown }> = [];
  const events: Array<Record<string, unknown>> = [];
  const handler = createTelegramTopicLifecycleSyncHandler({
    topicTargetStore: store,
    isBusEnabled: () => true,
    isTopicProvisioningActive: () => true,
    async callApi<TResponse>(method: string, body: Record<string, unknown>) {
      calls.push({ method, body });
      return {} as TResponse;
    },
    recordEvent(_category, _message, details) {
      events.push(details ?? {});
    },
  });

  await handler({
    kind: "created",
    target: { chatId: 7, threadId: 44 },
    message: {},
  });

  assert.deepEqual(calls, []);
  assert.equal(store.persisted, false);
  assert.equal(events[0]?.phase, "topic-lifecycle-provisioning-skip");
});
