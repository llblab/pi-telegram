/**
 * Regression tests for Telegram thread lifecycle reconciliation planning
 * Covers pure proof-before-delete decisions before runtime side effects are wired
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyThreadReconciliationPlan,
  createThreadReconciliationRuntime,
  planDisconnectedInstanceThreadCleanup,
  planThreadReconciliation,
} from "../lib/thread-reconciler.ts";
import type {
  TelegramThreadReservation,
  TelegramTopicSyncObservation,
  TelegramTopicTargetRecord,
} from "../lib/threads.ts";

const nowMs = 10_000;

function record(
  threadId: number,
  status: TelegramTopicTargetRecord["status"] = "active",
): TelegramTopicTargetRecord {
  return {
    profileKey: `profile:${threadId}`,
    target: { chatId: 7, threadId },
    status,
    createdAtMs: nowMs - 1_000,
    updatedAtMs: nowMs - 1_000,
    instanceId: `inst:${threadId}`,
    slot: "A",
  };
}

function reservation(threadId: number): TelegramThreadReservation {
  return {
    target: { chatId: 7, threadId },
    slot: "B",
    reason: "test",
    createdAtMs: nowMs - 1_000,
    updatedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60_000,
  };
}

function observation(
  threadId: number,
  syncStatus: TelegramTopicSyncObservation["syncStatus"],
  observedAtMs = nowMs,
): TelegramTopicSyncObservation {
  return {
    target: { chatId: 7, threadId },
    syncStatus,
    observedAtMs,
  };
}

test("Thread reconciler treats unknown created topics as observations, not cleanup proof", () => {
  const plan = planThreadReconciliation({
    nowMs,
    records: [],
    observations: [observation(42, "open")],
  });

  assert.deepEqual(plan.actions, []);
});

test("Thread reconciler marks current bindings active or stale from lifecycle observations", () => {
  const plan = planThreadReconciliation({
    nowMs,
    records: [record(10), record(11)],
    observations: [observation(10, "open"), observation(11, "closed")],
  });

  assert.deepEqual(plan.actions, [
    {
      kind: "mark-topic-active",
      target: { chatId: 7, threadId: 10 },
      reason: "observed-open",
    },
    {
      kind: "mark-topic-stale",
      target: { chatId: 7, threadId: 11 },
      syncStatus: "closed",
      reason: "observed-closed",
    },
  ]);
});

test("Thread reconciler requires unbound user-message proof before destructive cleanup", () => {
  const plan = planThreadReconciliation({
    nowMs,
    records: [],
    unboundMessages: [
      {
        target: { chatId: 7, threadId: 77 },
        observedAtMs: nowMs,
        messageId: 100,
      },
    ],
  });

  assert.deepEqual(plan.actions, [
    {
      kind: "close-delete-unbound-topic",
      target: { chatId: 7, threadId: 77 },
      observedAtMs: nowMs,
      messageId: 100,
      reason: "unbound-user-message",
    },
  ]);
});

test("Thread reconciler protects current, reserved, pending, and freshly-created targets from cleanup", () => {
  const plan = planThreadReconciliation({
    nowMs,
    currentLeaderEpoch: 3,
    records: [record(20)],
    reservations: [reservation(21)],
    pendingProvisions: [
      {
        id: "pending-22",
        owner: "manual-follower",
        instanceId: "inst-22",
        target: { chatId: 7, threadId: 22 },
        startedAtMs: nowMs - 1_000,
        expiresAtMs: nowMs + 30_000,
        leaderEpoch: 3,
      },
    ],
    observations: [observation(23, "open", nowMs - 5_000)],
    unboundMessages: [20, 21, 22, 23].map((threadId) => ({
      target: { chatId: 7, threadId },
      observedAtMs: nowMs,
    })),
  });

  assert.deepEqual(plan.actions, []);
});

test("Thread reconciler runtime records state transitions and schedules snapshots", () => {
  const events: unknown[] = [];
  let snapshots = 0;
  const runtime = createThreadReconciliationRuntime({
    recordRuntimeEvent: (_category, _message, details) => events.push(details),
    scheduleSnapshotPersist: () => {
      snapshots += 1;
    },
  });

  runtime.recordPlan({
    actions: [],
    state: {
      phase: "stable",
      event: "settled",
      atMs: nowMs,
      pendingProvisionCount: 0,
      syncActionCount: 0,
      cleanupActionCount: 0,
    },
  });
  assert.equal(runtime.getState()?.phase, "stable");
  assert.equal(snapshots, 1);

  runtime.plan({
    nowMs,
    records: [],
    pendingProvisions: [
      {
        id: "pending-1",
        owner: "leader",
        instanceId: "leader",
        startedAtMs: nowMs,
      },
    ],
  });
  assert.equal(runtime.getState()?.phase, "provisioning");
  assert.equal(snapshots, 2);
  assert.deepEqual(events.at(-1), {
    phase: "thread-reconciliation-transition",
    from: "stable",
    to: "provisioning",
    event: "pending-provision",
  });
});

test("Thread reconciler exposes explicit reconciliation state transitions", () => {
  const provisioning = planThreadReconciliation({
    nowMs,
    currentLeaderEpoch: 11,
    records: [],
    pendingProvisions: [
      {
        id: "pending-live",
        owner: "leader",
        instanceId: "leader-a",
        startedAtMs: nowMs - 100,
        expiresAtMs: nowMs + 60_000,
        leaderEpoch: 11,
      },
    ],
  });

  assert.deepEqual(provisioning.state, {
    phase: "provisioning",
    event: "pending-provision",
    atMs: nowMs,
    leaderEpoch: 11,
    pendingProvisionCount: 1,
    syncActionCount: 0,
    cleanupActionCount: 0,
  });

  const cleanup = planThreadReconciliation({
    nowMs: nowMs + 70_000,
    currentLeaderEpoch: 11,
    previousState: provisioning.state,
    records: [],
    pendingProvisions: [
      {
        id: "pending-live",
        owner: "leader",
        instanceId: "leader-a",
        target: { chatId: 7, threadId: 55 },
        startedAtMs: nowMs - 100,
        expiresAtMs: nowMs + 60_000,
        leaderEpoch: 11,
      },
    ],
  });

  assert.equal(cleanup.state?.phase, "cleanup-required");
  assert.deepEqual(cleanup.transition, {
    from: "provisioning",
    to: "cleanup-required",
    event: "cleanup-required",
    atMs: nowMs + 70_000,
  });
});

test("Thread reconciler plans pruned follower cleanup from current instance records", () => {
  const plan = planThreadReconciliation({
    nowMs,
    records: [
      { ...record(50), instanceId: "follower-a" },
      { ...record(51, "offline"), instanceId: "follower-a" },
      { ...record(52), instanceId: "follower-b" },
    ],
    prunedFollowerInstanceIds: ["follower-a"],
  });

  assert.deepEqual(plan.actions, [
    {
      kind: "close-delete-pruned-follower-topic",
      target: { chatId: 7, threadId: 50 },
      reason: "pruned-follower",
      instanceId: "follower-a",
    },
  ]);
});

test("Thread reconciler plans replaced binding cleanup for same-instance old targets", () => {
  const plan = planThreadReconciliation({
    nowMs,
    records: [
      { ...record(60), instanceId: "inst-a" },
      { ...record(61), instanceId: "inst-a" },
      { ...record(62), instanceId: "inst-b" },
    ],
    replacedBindings: [
      {
        instanceId: "inst-a",
        replacementTarget: { chatId: 7, threadId: 61 },
      },
    ],
  });

  assert.deepEqual(plan.actions, [
    {
      kind: "close-stale-replaced-topic",
      target: { chatId: 7, threadId: 60 },
      reason: "replaced-instance-binding",
      instanceId: "inst-a",
    },
  ]);
});

test("Thread reconciler plans previous leader cleanup from owner/profile evidence", () => {
  const plan = planThreadReconciliation({
    nowMs,
    records: [
      {
        ...record(70),
        instanceId: "old-leader",
        ownerKind: "leader",
        profileKey: "cwd:/repo",
      },
      {
        ...record(71),
        instanceId: "legacy-leader",
        profileKey: "leader:old",
      },
      {
        ...record(72),
        instanceId: "follower",
        ownerKind: "manual-follower",
        profileKey: "manual:follower",
      },
      {
        ...record(73),
        instanceId: "current-leader",
        ownerKind: "leader",
        profileKey: "cwd:/repo",
      },
    ],
    previousLeaderCleanup: { currentInstanceId: "current-leader" },
  });

  assert.deepEqual(plan.actions, [
    {
      kind: "close-delete-previous-leader-topic",
      target: { chatId: 7, threadId: 70 },
      reason: "previous-leader",
      instanceId: "current-leader",
    },
    {
      kind: "close-delete-previous-leader-topic",
      target: { chatId: 7, threadId: 71 },
      reason: "previous-leader",
      instanceId: "current-leader",
    },
  ]);
});

test("Thread reconciler plans proactive reservation cleanup and removal after stale probe", () => {
  const cleanup = planThreadReconciliation({
    nowMs,
    records: [],
    reservations: [reservation(86)],
    proactiveReservationCleanup: true,
  });
  assert.deepEqual(cleanup.actions, [
    {
      kind: "close-delete-reserved-topic",
      target: { chatId: 7, threadId: 86 },
      observedAtMs: nowMs,
      reason: "startup-reservation",
    },
  ]);

  const removal = planThreadReconciliation({
    nowMs,
    records: [],
    reservations: [reservation(86)],
    reservationProbeResults: [
      { target: { chatId: 7, threadId: 86 }, stale: true },
      { target: { chatId: 7, threadId: 87 }, stale: true },
    ],
  });
  assert.deepEqual(removal.actions, [
    {
      kind: "remove-reservation",
      target: { chatId: 7, threadId: 86 },
      reason: "reservation-probe-stale",
    },
  ]);
});

test("Thread reconciler plans reserved topic cleanup only with reservation proof", () => {
  const plan = planThreadReconciliation({
    nowMs,
    records: [],
    reservations: [reservation(88)],
    reservedMessages: [
      {
        target: { chatId: 7, threadId: 88 },
        observedAtMs: nowMs,
        messageId: 120,
      },
      {
        target: { chatId: 7, threadId: 89 },
        observedAtMs: nowMs,
        messageId: 121,
      },
    ],
  });

  assert.deepEqual(plan.actions, [
    {
      kind: "close-delete-reserved-topic",
      target: { chatId: 7, threadId: 88 },
      observedAtMs: nowMs,
      messageId: 120,
      reason: "reserved-user-message",
    },
  ]);
});

test("Thread reconciler plans expired targeted pending provision cleanup", () => {
  const plan = planThreadReconciliation({
    nowMs,
    currentLeaderEpoch: 7,
    records: [record(94)],
    pendingProvisions: [
      {
        id: "pending-expired",
        owner: "leader",
        instanceId: "leader-a",
        target: { chatId: 7, threadId: 93 },
        startedAtMs: nowMs - 60_000,
        expiresAtMs: nowMs - 1,
        leaderEpoch: 6,
      },
      {
        id: "pending-untargeted",
        owner: "leader",
        instanceId: "leader-a",
        startedAtMs: nowMs - 60_000,
        expiresAtMs: nowMs - 1,
      },
      {
        id: "pending-current",
        owner: "leader",
        instanceId: "leader-a",
        target: { chatId: 7, threadId: 94 },
        startedAtMs: nowMs - 60_000,
        expiresAtMs: nowMs - 1,
      },
    ],
  });

  assert.deepEqual(plan.actions, [
    {
      kind: "close-delete-expired-pending-provision-topic",
      target: { chatId: 7, threadId: 93 },
      reason: "expired-pending-provision",
      pendingProvisionId: "pending-expired",
      instanceId: "leader-a",
      leaderEpoch: 7,
    },
  ]);
});

test("Thread reconciler ignores stale-epoch cleanup observations", () => {
  const plan = planThreadReconciliation({
    nowMs,
    currentLeaderEpoch: 4,
    records: [],
    unboundMessages: [
      {
        target: { chatId: 7, threadId: 80 },
        observedAtMs: nowMs,
        leaderEpoch: 3,
      },
    ],
  });

  assert.deepEqual(plan.actions, []);
});

test("Thread reconciler apply removes confirmed stale reservations", async () => {
  const removedTargets: unknown[] = [];
  let persisted = false;
  await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "remove-reservation",
          target: { chatId: 7, threadId: 88 },
          reason: "reservation-probe-stale",
        },
      ],
    },
    {
      removeReservationByTarget(target) {
        removedTargets.push(target);
        return true;
      },
      async persist() {
        persisted = true;
      },
    },
  );

  assert.deepEqual(removedTargets, [{ chatId: 7, threadId: 88 }]);
  assert.equal(persisted, true);
});

test("Thread reconciler apply closes replaced instance topics and marks them stale", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const staleTargets: unknown[] = [];
  let persisted = false;
  await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "close-stale-replaced-topic",
          target: { chatId: 7, threadId: 89 },
          reason: "replaced-instance-binding",
          instanceId: "inst-a",
        },
      ],
    },
    {
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return {} as TResponse;
      },
      markStaleByTarget(target, syncStatus) {
        staleTargets.push({ target, syncStatus });
        return true;
      },
      async persist() {
        persisted = true;
      },
    },
  );

  assert.deepEqual(calls, [
    {
      method: "closeForumTopic",
      body: { chat_id: 7, message_thread_id: 89 },
    },
  ]);
  assert.deepEqual(staleTargets, [
    { target: { chatId: 7, threadId: 89 }, syncStatus: "closed" },
  ]);
  assert.equal(persisted, true);
});

test("Thread reconciler reports failed replaced-topic closure as incomplete", async () => {
  const result = await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "close-stale-replaced-topic",
          target: { chatId: 7, threadId: 89 },
          reason: "replaced-instance-binding",
          instanceId: "inst-a",
        },
      ],
    },
    {
      async callApi() {
        throw new Error("temporary Bot API failure");
      },
    },
  );

  assert.equal(result.incompleteActions?.length, 1);
  assert.equal(result.changed, false);
});

test("Thread reconciler reports unfenced replaced-topic closure as incomplete", async () => {
  const result = await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "close-stale-replaced-topic",
          target: { chatId: 7, threadId: 89 },
          reason: "replaced-instance-binding",
          instanceId: "inst-a",
        },
      ],
    },
    {
      getCurrentLeaderEpoch: () => 2,
      async callApi<TResponse>() {
        return {} as TResponse;
      },
    },
  );

  assert.equal(result.incompleteActions?.length, 1);
  assert.equal(result.changed, false);
});

test("Thread reconciler apply skips destructive actions from stale leader epochs", async () => {
  const calls: unknown[] = [];
  const runtimeEvents: unknown[] = [];
  await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "close-delete-unbound-topic",
          target: { chatId: 7, threadId: 92 },
          observedAtMs: nowMs,
          reason: "unbound-user-message",
          leaderEpoch: 1,
        },
      ],
    },
    {
      getCurrentLeaderEpoch: () => 2,
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return {} as TResponse;
      },
      recordRuntimeEvent(category, error, details) {
        runtimeEvents.push({ category, error, details });
      },
    },
  );

  assert.deepEqual(calls, []);
  assert.deepEqual(runtimeEvents, [
    {
      category: "telegram",
      error: "Skipped stale-epoch thread reconciliation action",
      details: {
        phase: "thread-reconciler-stale-epoch-skip",
        action: "close-delete-unbound-topic",
        actionLeaderEpoch: 1,
        currentLeaderEpoch: 2,
        chatId: 7,
        threadId: 92,
      },
    },
  ]);
});

test("Thread reconciler rechecks leader epoch between close and delete", async () => {
  const calls: string[] = [];
  const staleTargets: unknown[] = [];
  let currentEpoch = 1;
  let persisted = false;
  await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "close-delete-unbound-topic",
          target: { chatId: 7, threadId: 92 },
          observedAtMs: nowMs,
          reason: "unbound-user-message",
          leaderEpoch: 1,
        },
      ],
    },
    {
      getCurrentLeaderEpoch: () => currentEpoch,
      async callApi<TResponse>(method: string) {
        calls.push(method);
        currentEpoch = 2;
        return {} as TResponse;
      },
      markStaleByTarget(target, syncStatus) {
        staleTargets.push({ target, syncStatus });
        return true;
      },
      async persist() {
        persisted = true;
      },
      recordRuntimeEvent() {},
    },
  );

  assert.deepEqual(calls, ["closeForumTopic"]);
  assert.deepEqual(staleTargets, []);
  assert.equal(persisted, false);
});

test("Thread reconciler rechecks leader epoch before cleanup persistence", async () => {
  let currentEpoch = 1;
  let persisted = false;
  const staleTargets: unknown[] = [];
  await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "close-delete-unbound-topic",
          target: { chatId: 7, threadId: 92 },
          observedAtMs: nowMs,
          reason: "unbound-user-message",
          leaderEpoch: 1,
        },
      ],
    },
    {
      getCurrentLeaderEpoch: () => currentEpoch,
      async callApi<TResponse>() {
        return {} as TResponse;
      },
      markStaleByTarget(target, syncStatus) {
        staleTargets.push({ target, syncStatus });
        currentEpoch = 2;
        return true;
      },
      async persist() {
        persisted = true;
      },
      recordRuntimeEvent() {},
    },
  );

  assert.deepEqual(staleTargets, [
    { target: { chatId: 7, threadId: 92 }, syncStatus: "deleted" },
  ]);
  assert.equal(persisted, false);
});

test("Thread reconciler rechecks leader epoch before expired-pending mutation", async () => {
  let currentEpoch = 1;
  let removed = false;
  await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "close-delete-expired-pending-provision-topic",
          target: { chatId: 7, threadId: 93 },
          reason: "expired-pending-provision",
          pendingProvisionId: "pending-expired",
          leaderEpoch: 1,
        },
      ],
    },
    {
      getCurrentLeaderEpoch: () => currentEpoch,
      async callApi<TResponse>(method: string) {
        if (method === "deleteForumTopic") currentEpoch = 2;
        return {} as TResponse;
      },
      removePendingProvisionById() {
        removed = true;
        return true;
      },
      recordRuntimeEvent() {},
    },
  );

  assert.equal(removed, false);
});

test("Thread reconciler apply deletes expired pending topics and removes pending state", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const removedIds: string[] = [];
  let persisted = false;
  await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "close-delete-expired-pending-provision-topic",
          target: { chatId: 7, threadId: 93 },
          reason: "expired-pending-provision",
          pendingProvisionId: "pending-expired",
          instanceId: "leader-a",
        },
      ],
    },
    {
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return {} as TResponse;
      },
      removePendingProvisionById(id) {
        removedIds.push(id);
        return true;
      },
      async persist() {
        persisted = true;
      },
    },
  );

  assert.deepEqual(calls, [
    {
      method: "closeForumTopic",
      body: { chat_id: 7, message_thread_id: 93 },
    },
    {
      method: "deleteForumTopic",
      body: { chat_id: 7, message_thread_id: 93 },
    },
  ]);
  assert.deepEqual(removedIds, ["pending-expired"]);
  assert.equal(persisted, true);
});

test("Thread reconciler apply keeps expired pending state when cleanup API fails", async () => {
  const removedIds: string[] = [];
  let persisted = false;
  await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "close-delete-expired-pending-provision-topic",
          target: { chatId: 7, threadId: 93 },
          reason: "expired-pending-provision",
          pendingProvisionId: "pending-expired",
          instanceId: "leader-a",
        },
      ],
    },
    {
      async callApi() {
        throw new Error("temporary Bot API failure");
      },
      removePendingProvisionById(id) {
        removedIds.push(id);
        return true;
      },
      async persist() {
        persisted = true;
      },
      recordRuntimeEvent() {},
    },
  );

  assert.deepEqual(removedIds, []);
  assert.equal(persisted, false);
});

test("Thread reconciler apply reports incomplete cleanup API failures", async () => {
  const staleTargets: unknown[] = [];
  const runtimeEvents: Array<{
    category: string;
    error: string;
    details?: Record<string, unknown>;
  }> = [];
  let persisted = false;
  const result = await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "close-delete-unbound-topic",
          target: { chatId: 7, threadId: 90 },
          observedAtMs: nowMs,
          messageId: 123,
          reason: "unbound-user-message",
        },
      ],
    },
    {
      async callApi() {
        throw new Error("temporary Bot API failure");
      },
      markStaleByTarget(target, syncStatus) {
        staleTargets.push({ target, syncStatus });
        return true;
      },
      async persist() {
        persisted = true;
      },
      recordRuntimeEvent(category, error, details) {
        runtimeEvents.push({ category, error: String(error), details });
      },
    },
  );

  assert.deepEqual(staleTargets, []);
  assert.equal(persisted, false);
  assert.equal(result.incompleteActions?.length, 1);
  assert.equal(
    runtimeEvents.some(
      (event) =>
        event.error === "Unbound Telegram topic deleted" ||
        event.details?.phase === "thread-reconciler-unbound-topic-delete",
    ),
    false,
  );
  assert.equal(
    runtimeEvents.some(
      (event) =>
        event.details?.phase === "thread-reconciler-cleanup-incomplete",
    ),
    true,
  );
});

test("Thread reconciler apply treats stale delete errors as confirmed cleanup", async () => {
  const staleTargets: unknown[] = [];
  let persisted = false;
  await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "close-delete-unbound-topic",
          target: { chatId: 7, threadId: 90 },
          observedAtMs: nowMs,
          messageId: 123,
          reason: "unbound-user-message",
        },
      ],
    },
    {
      async callApi() {
        throw new Error("Bad Request: message thread not found");
      },
      markStaleByTarget(target, syncStatus) {
        staleTargets.push({ target, syncStatus });
        return true;
      },
      async persist() {
        persisted = true;
      },
    },
  );

  assert.deepEqual(staleTargets, [
    { target: { chatId: 7, threadId: 90 }, syncStatus: "deleted" },
  ]);
  assert.equal(persisted, true);
});

test("Thread reconciler does not treat a closed-only topic as deleted", async () => {
  const staleTargets: unknown[] = [];
  let persisted = false;
  const result = await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "close-delete-unbound-topic",
          target: { chatId: 7, threadId: 90 },
          observedAtMs: nowMs,
          messageId: 123,
          reason: "unbound-user-message",
        },
      ],
    },
    {
      async callApi<TResponse>(method: string) {
        if (method === "deleteForumTopic") {
          throw new Error("Bad Request: topic closed");
        }
        return {} as TResponse;
      },
      markStaleByTarget(target, syncStatus) {
        staleTargets.push({ target, syncStatus });
        return true;
      },
      async persist() {
        persisted = true;
      },
    },
  );

  assert.equal(result.incompleteActions?.length, 1);
  assert.deepEqual(staleTargets, []);
  assert.equal(persisted, false);
});

test("Thread reconciler fails closed when destructive action lacks leader epoch", async () => {
  let calls = 0;
  const runtimeEvents: Array<{
    category: string;
    error: unknown;
    details?: Record<string, unknown>;
  }> = [];
  await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "close-delete-unbound-topic",
          target: { chatId: 7, threadId: 90 },
          observedAtMs: nowMs,
          reason: "unbound-user-message",
        },
      ],
    },
    {
      getCurrentLeaderEpoch: () => 5,
      async callApi<TResponse>() {
        calls += 1;
        return {} as TResponse;
      },
      recordRuntimeEvent(category, error, details) {
        runtimeEvents.push({ category, error, details });
      },
    },
  );

  assert.equal(calls, 0);
  assert.deepEqual(runtimeEvents.at(0), {
    category: "telegram",
    error: "Thread reconciliation destructive action has no leader epoch",
    details: {
      phase: "thread-reconciler-missing-leader-epoch",
      action: "close-delete-unbound-topic",
      currentLeaderEpoch: 5,
      chatId: 7,
      threadId: 90,
    },
  });
});

test("Thread reconciler fails closed when ownership probe returns undefined", async () => {
  const calls: string[] = [];
  await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "close-delete-unbound-topic",
          target: { chatId: 7, threadId: 90 },
          observedAtMs: nowMs,
          reason: "unbound-user-message",
        },
      ],
    },
    {
      getCurrentLeaderEpoch: () => undefined,
      async callApi<TResponse>(method: string) {
        calls.push(method);
        return {} as TResponse;
      },
      recordRuntimeEvent() {},
    },
  );

  assert.deepEqual(calls, []);
});

test("Thread reconciler plans manual disconnect cleanup as a domain action", () => {
  assert.deepEqual(
    planDisconnectedInstanceThreadCleanup({
      target: { chatId: 7, threadId: 42 },
      instanceId: "inst:1",
    }),
    {
      actions: [
        {
          kind: "close-delete-disconnected-instance-topic",
          target: { chatId: 7, threadId: 42 },
          reason: "manual-disconnect",
          instanceId: "inst:1",
        },
      ],
    },
  );
});

test("Thread reconciler apply closes and deletes manual disconnect topics without marking stale", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let staleCalled = false;
  await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "close-delete-disconnected-instance-topic",
          target: { chatId: 7, threadId: 91 },
          reason: "manual-disconnect",
          instanceId: "inst-a",
        },
      ],
    },
    {
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return {} as TResponse;
      },
      markStaleByTarget() {
        staleCalled = true;
        return true;
      },
    },
  );

  assert.deepEqual(calls, [
    {
      method: "closeForumTopic",
      body: { chat_id: 7, message_thread_id: 91 },
    },
    {
      method: "deleteForumTopic",
      body: { chat_id: 7, message_thread_id: 91 },
    },
  ]);
  assert.equal(staleCalled, false);
});

test("Thread reconciler apply is the close/delete path for unbound cleanup actions", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const staleTargets: unknown[] = [];
  let persisted = false;
  await applyThreadReconciliationPlan(
    {
      actions: [
        {
          kind: "close-delete-unbound-topic",
          target: { chatId: 7, threadId: 90 },
          observedAtMs: nowMs,
          messageId: 123,
          reason: "unbound-user-message",
        },
      ],
    },
    {
      async callApi<TResponse>(method: string, body: Record<string, unknown>) {
        calls.push({ method, body });
        return {} as TResponse;
      },
      markStaleByTarget(target, syncStatus) {
        staleTargets.push({ target, syncStatus });
        return true;
      },
      async persist() {
        persisted = true;
      },
    },
  );

  assert.deepEqual(calls, [
    {
      method: "closeForumTopic",
      body: { chat_id: 7, message_thread_id: 90 },
    },
    {
      method: "deleteForumTopic",
      body: { chat_id: 7, message_thread_id: 90 },
    },
  ]);
  assert.deepEqual(staleTargets, [
    { target: { chatId: 7, threadId: 90 }, syncStatus: "deleted" },
  ]);
  assert.equal(persisted, true);
});
