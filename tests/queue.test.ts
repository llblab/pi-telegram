/**
 * Regression tests for Telegram queue and runtime decision helpers
 * Exercises queue ordering, mutation, dispatch planning, lifecycle plans, and model-switch guard behavior
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramButtonActionStore,
  createTelegramOutboundReplyPlanner,
} from "../lib/outbound.ts";
import {
  appendTelegramPromptTurnOnce,
  appendTelegramQueueItem,
  applyTelegramQueuePromptReactionDisposition,
  applyTelegramQueuePromptReactionDispositionRuntime,
  assertTelegramQueueItemAdmissionValid,
  buildPendingTelegramControlItem,
  buildTelegramAgentEndPlan,
  buildTelegramAgentStartPlan,
  buildTelegramSessionShutdownState,
  buildTelegramSessionStartState,
  canDispatchTelegramTurnState,
  clearTelegramQueueItemsRuntime,
  compareTelegramQueueItems,
  createTelegramActiveTurnStore,
  createTelegramAgentEndHook,
  createTelegramAgentLifecycleHooks,
  createTelegramAgentStartHook,
  createTelegramControlItemBuilder,
  createTelegramControlQueueController,
  createTelegramDeferredQueueDispatchRuntime,
  createTelegramDispatchReadinessChecker,
  createTelegramPromptEnqueueController,
  createTelegramQueueAdmissionReceipt,
  createTelegramQueueDispatchController,
  createTelegramQueueDispatchRuntime,
  createTelegramQueueDispatchWatchdogRuntime,
  createTelegramQueueHandoff,
  createTelegramQueueHandoffPayload,
  createTelegramQueueHandoffStagingRuntime,
  createTelegramQueueItemCountGetter,
  createTelegramQueueMutationController,
  createTelegramQueueStore,
  createTelegramSessionLifecycleHooks,
  createTelegramSessionLifecycleRuntime,
  createTelegramSessionStateApplier,
  createTelegramToolExecutionHooks,
  createTelegramTransportStampedQueueStore,
  createTelegramTransportStampRuntime,
  enqueueTelegramPromptTurnRuntime,
  executeTelegramControlItemRuntime,
  executeTelegramQueueDispatchPlan,
  formatQueuedTelegramItemsStatus,
  getNextTelegramToolExecutionCount,
  getTelegramQueueItemAdmissionMode,
  getTelegramQueueLaneContract,
  handleTelegramAgentEndRuntime,
  handleTelegramAgentStartRuntime,
  handleTelegramToolExecutionEndRuntime,
  handleTelegramToolExecutionStartRuntime,
  isTelegramQueueItemAdmissionValid,
  isTelegramQueueItemDurablyAdmitted,
  partitionTelegramQueueItemsForHistory,
  planNextTelegramQueueAction,
  planTelegramPromptEnqueue,
  removeTelegramQueueItemByReceipt,
  removeTelegramQueueItemsByMessageIds,
  removeTelegramQueueItemsByMessageIdsRuntime,
  restoreTelegramQueueHandoffPayload,
  shouldDispatchAfterTelegramAgentEnd,
  shutdownTelegramSessionRuntime,
  stageTelegramQueueHandoffPayload,
  startTelegramSessionRuntime,
  TELEGRAM_QUEUE_LANE_CONTRACTS,
  type PendingTelegramControlItem,
  type PendingTelegramTurn,
  type TelegramDispatchRuntimeDeps,
  TELEGRAM_QUEUE_HANDOFF_PAYLOAD_MAX_BYTES,
  type TelegramQueueItem,
} from "../lib/queue.ts";

function createQueueTestModel() {
  return { provider: "openai", id: "gpt-5" };
}

function createQueueTestPromptTurn(
  overrides: Partial<PendingTelegramTurn> = {},
): PendingTelegramTurn {
  return {
    kind: "prompt",
    chatId: 1,
    replyToMessageId: 2,
    sourceMessageIds: [2],
    queueOrder: 1,
    queueLane: "default",
    laneOrder: 1,
    queuedAttachments: [],
    content: [{ type: "text", text: "prompt" }],
    historyText: "prompt",
    statusSummary: "prompt",
    ...overrides,
  };
}

function createQueueTestControlItem<TContext = unknown>(
  overrides: Partial<PendingTelegramControlItem<TContext>> = {},
): PendingTelegramControlItem<TContext> {
  return {
    kind: "control",
    controlType: "status",
    chatId: 1,
    replyToMessageId: 2,
    queueOrder: 2,
    queueLane: "control",
    laneOrder: 0,
    statusSummary: "control",
    execute: async () => {},
    ...overrides,
  };
}

test("Queue store owns queued item state helpers", () => {
  const item: PendingTelegramTurn = createQueueTestPromptTurn({
    queueOrder: 3,
    laneOrder: 3,
    statusSummary: "hello",
    content: [{ type: "text", text: "hello" }],
    historyText: "",
  });
  const store = createTelegramQueueStore([item]);
  assert.deepEqual(store.getQueuedItems(), [item]);
  assert.equal(store.hasQueuedItems(), true);
  store.setQueuedItems([]);
  assert.deepEqual(store.getQueuedItems(), []);
  assert.equal(store.hasQueuedItems(), false);
});

test("Transport stamp runtime owns profile and token generations", () => {
  let profile: string | undefined;
  let botToken: string | undefined = "token-a";
  const runtime = createTelegramTransportStampRuntime({
    getProfileName: () => profile,
    getBotToken: () => botToken,
  });

  const initial = runtime.getStamp();
  assert.deepEqual(initial, { profile: "default", generation: "1" });
  assert.equal(runtime.isActive(initial), true);
  assert.equal(runtime.isActive(undefined), false);

  profile = "work";
  const afterProfileChange = runtime.getStamp();
  assert.deepEqual(afterProfileChange, { profile: "work", generation: "2" });
  assert.equal(runtime.isActive(initial), false);

  botToken = "token-b";
  const afterTokenChange = runtime.getStamp();
  assert.deepEqual(afterTokenChange, { profile: "work", generation: "3" });
  assert.equal(runtime.isActive(afterProfileChange), false);
  assert.equal(runtime.isActive(afterTokenChange), true);
});

test("Transport-stamped queue store preserves admitted generations", () => {
  const runtime = createTelegramTransportStampRuntime({
    getProfileName: () => "work",
    getBotToken: () => "token",
  });
  const rawStore = createTelegramQueueStore<string>();
  const store = createTelegramTransportStampedQueueStore(
    rawStore,
    runtime.getStamp,
  );
  const unstamped = createQueueTestPromptTurn({ queueOrder: 1, laneOrder: 1 });
  const preserved = createQueueTestPromptTurn({
    queueOrder: 2,
    laneOrder: 2,
    transportStamp: { profile: "old", generation: "9" },
  });

  store.setQueuedItems([unstamped, preserved]);

  assert.deepEqual(store.getQueuedItems()[0]?.transportStamp, {
    profile: "work",
    generation: "1",
  });
  assert.deepEqual(store.getQueuedItems()[1]?.transportStamp, {
    profile: "old",
    generation: "9",
  });
});

test("Active turn store owns active turn state helpers", () => {
  const store = createTelegramActiveTurnStore();
  const turn: PendingTelegramTurn = createQueueTestPromptTurn({
    chatId: 7,
    target: { chatId: 7, threadId: 70 },
    replyToMessageId: 8,
    statusSummary: "hello",
    sourceMessageIds: [8, 9],
    content: [{ type: "text", text: "hello" }],
    historyText: "",
  });
  assert.equal(store.has(), false);
  assert.equal(store.get(), undefined);
  store.set(turn);
  turn.chatId = 99;
  assert.equal(store.has(), true);
  assert.equal(store.get()?.chatId, 7);
  assert.equal(store.getChatId(), 7);
  assert.deepEqual(store.getTarget(), { chatId: 7, threadId: 70 });
  const target = store.getTarget();
  if (target) target.threadId = 99;
  assert.deepEqual(store.getTarget(), { chatId: 7, threadId: 70 });
  assert.equal(store.getReplyToMessageId(), 8);
  assert.deepEqual(store.getSourceMessageIds(), [8, 9]);
  store.clear();
  assert.equal(store.has(), false);
  assert.equal(store.getChatId(), undefined);
  assert.equal(store.getTarget(), undefined);
});

test("Control item builder creates control-lane queue items", () => {
  const execute = async (): Promise<void> => {};
  const createControlItem = createTelegramControlItemBuilder({
    allocateItemOrder: () => 7,
    allocateControlOrder: () => 8,
  });
  assert.deepEqual(
    createControlItem({
      chatId: 1,
      replyToMessageId: 2,
      controlType: "status",
      statusSummary: "status",
      execute,
    }),
    {
      kind: "control",
      controlType: "status",
      chatId: 1,
      replyToMessageId: 2,
      queueOrder: 7,
      queueLane: "control",
      laneOrder: 8,
      statusSummary: "status",
      execute,
    },
  );
  assert.deepEqual(
    buildPendingTelegramControlItem({
      chatId: 1,
      replyToMessageId: 2,
      controlType: "status",
      queueOrder: 3,
      laneOrder: 4,
      statusSummary: "⚡ status",
      execute,
    }),
    {
      kind: "control",
      chatId: 1,
      replyToMessageId: 2,
      controlType: "status",
      queueOrder: 3,
      queueLane: "control",
      laneOrder: 4,
      statusSummary: "⚡ status",
      execute,
    },
  );
});

test("Queue lane contracts define admission modes and dispatch order", () => {
  assert.deepEqual(
    TELEGRAM_QUEUE_LANE_CONTRACTS.map((contract) => ({
      lane: contract.lane,
      admissionMode: contract.admissionMode,
      dispatchRank: contract.dispatchRank,
      allowedKinds: [...contract.allowedKinds],
    })),
    [
      {
        lane: "control",
        admissionMode: "control-queue",
        dispatchRank: 0,
        allowedKinds: ["control", "prompt"],
      },
      {
        lane: "priority",
        admissionMode: "priority-queue",
        dispatchRank: 1,
        allowedKinds: ["prompt"],
      },
      {
        lane: "default",
        admissionMode: "default-queue",
        dispatchRank: 2,
        allowedKinds: ["prompt"],
      },
    ],
  );
  assert.equal(getTelegramQueueLaneContract("priority").dispatchRank, 1);
  assert.equal(
    getTelegramQueueItemAdmissionMode({ queueLane: "control" }),
    "control-queue",
  );
  assert.equal(
    isTelegramQueueItemAdmissionValid({ kind: "prompt", queueLane: "control" }),
    true,
  );
  assert.equal(
    isTelegramQueueItemAdmissionValid({
      kind: "control",
      queueLane: "default",
    }),
    false,
  );
  assert.throws(
    () =>
      assertTelegramQueueItemAdmissionValid({
        kind: "control",
        queueLane: "default",
      }),
    {
      message:
        "Invalid Telegram queue admission: control item cannot use default lane",
    },
  );
});

test("Queue planning rejects invalid queue admission", () => {
  assert.throws(
    () =>
      planNextTelegramQueueAction(
        [
          {
            kind: "control",
            controlType: "status",
            chatId: 1,
            replyToMessageId: 1,
            queueOrder: 1,
            queueLane: "default",
            laneOrder: 1,
            statusSummary: "invalid",
            execute: async () => {},
          },
        ],
        true,
      ),
    {
      message:
        "Invalid Telegram queue admission: control item cannot use default lane",
    },
  );
});

test("Queue prompt append-once prioritizes callbacks and deduplicates repeats", () => {
  const defaultTurn = createQueueTestPromptTurn({
    queueOrder: 1,
    laneOrder: 1,
    content: [{ type: "text", text: "queued first" }],
    historyText: "queued first",
  });
  const callbackTurn = createQueueTestPromptTurn({
    queueOrder: 2,
    queueLane: "priority",
    laneOrder: 2,
    content: [{ type: "text", text: "[callback] approve" }],
    historyText: "approve",
  });
  const first = appendTelegramPromptTurnOnce([defaultTurn], callbackTurn);
  assert.equal(first.appended, true);
  assert.deepEqual(first.items, [callbackTurn, defaultTurn]);

  const duplicate = appendTelegramPromptTurnOnce(first.items, {
    ...callbackTurn,
    queueOrder: 99,
    laneOrder: 99,
  });
  assert.equal(duplicate.appended, false);
  assert.equal(duplicate.items.length, 2);

  const distinct = appendTelegramPromptTurnOnce(first.items, {
    ...callbackTurn,
    content: [{ type: "text", text: "[callback] reject" }],
    historyText: "reject",
  });
  assert.equal(distinct.appended, true);
  assert.equal(distinct.items.length, 3);
});

test("Queue receipts are deterministic, canonical, and scope-bound", () => {
  const first = createTelegramQueueAdmissionReceipt({
    queueKind: "prompt",
    scope: "profile-a:bot-a",
    sourceUpdateIds: [9, 7, 9],
  });
  const reordered = createTelegramQueueAdmissionReceipt({
    queueKind: "prompt",
    scope: "profile-a:bot-a",
    sourceUpdateIds: [7, 9],
  });
  assert.deepEqual(first, reordered);
  assert.deepEqual(first?.sourceUpdateIds, [7, 9]);
  assert.equal(first?.journalBindingKey, "profile-a:bot-a");
  assert.match(first?.receiptId ?? "", /^telegram-prompt-v1-[a-f0-9]{64}$/u);
  assert.notEqual(
    first?.receiptId,
    createTelegramQueueAdmissionReceipt({
      queueKind: "control",
      scope: "profile-a:bot-a",
      sourceUpdateIds: [7, 9],
    })?.receiptId,
  );
  assert.notEqual(
    first?.receiptId,
    createTelegramQueueAdmissionReceipt({
      queueKind: "prompt",
      scope: "profile-b:bot-a",
      sourceUpdateIds: [7, 9],
    })?.receiptId,
  );
  assert.equal(
    createTelegramQueueAdmissionReceipt({
      queueKind: "prompt",
      scope: "profile-a:bot-a",
      sourceUpdateIds: [],
    }),
    undefined,
  );
  assert.throws(
    () =>
      createTelegramQueueAdmissionReceipt({
        queueKind: "prompt",
        scope: "",
        sourceUpdateIds: [7],
      }),
    /scope is required/u,
  );
});

test("Queue receipts retain structured journal bindings", () => {
  const binding = JSON.stringify({ version: 1, path: "/journal-a" });
  assert.equal(
    createTelegramQueueAdmissionReceipt({
      queueKind: "prompt",
      scope: binding,
      sourceUpdateIds: [7],
    })?.journalBindingKey,
    binding,
  );
});

test("Queue admission keeps identical receipt ids isolated by journal binding", () => {
  const first = {
    queueKind: "prompt" as const,
    receiptId: "shared-receipt",
    sourceUpdateIds: [7],
    journalBindingKey: "journal-a",
  };
  const second = { ...first, journalBindingKey: "journal-b" };
  const items = appendTelegramQueueItem([], createQueueTestPromptTurn({
    admissionReceipts: [first],
  }));
  const combined = appendTelegramQueueItem(items, createQueueTestPromptTurn({
    admissionReceipts: [second],
    queueOrder: 2,
    laneOrder: 2,
  }));
  assert.equal(combined.length, 2);
  const store = createTelegramQueueStore(combined);
  assert.equal(removeTelegramQueueItemByReceipt({ receipt: second, store }), true);
  assert.equal(
    store.getQueuedItems()[0]?.admissionReceipts?.[0]?.journalBindingKey,
    "journal-a",
  );
});

test("Queue admission deduplicates exact receipts and rejects conflicts", () => {
  const receipt = createTelegramQueueAdmissionReceipt({
    queueKind: "prompt",
    scope: "profile-a:bot-a",
    sourceUpdateIds: [7],
  })!;
  const firstTurn = createQueueTestPromptTurn({
    admissionReceipts: [receipt],
    content: [{ type: "text", text: "first delivery" }],
  });
  const firstItems = appendTelegramQueueItem([], firstTurn);
  assert.equal(firstItems.length, 1);
  assert.equal(
    appendTelegramQueueItem(firstItems, {
      ...firstTurn,
      content: [{ type: "text", text: "redelivered text" }],
    }),
    firstItems,
  );

  const distinctReceipt = createTelegramQueueAdmissionReceipt({
    queueKind: "prompt",
    scope: "profile-a:bot-a",
    sourceUpdateIds: [8],
  })!;
  const sameTextDifferentSource = appendTelegramPromptTurnOnce(firstItems, {
    ...firstTurn,
    admissionReceipts: [distinctReceipt],
  });
  assert.equal(sameTextDifferentSource.appended, true);
  assert.equal(sameTextDifferentSource.items.length, 2);

  assert.throws(
    () =>
      appendTelegramQueueItem(firstItems, {
        ...firstTurn,
        admissionReceipts: [
          {
            ...receipt,
            sourceUpdateIds: [99],
          },
        ],
      }),
    /Conflicting Telegram queue receipt/u,
  );
  assert.throws(
    () =>
      appendTelegramQueueItem(firstItems, {
        ...firstTurn,
        admissionReceipts: [receipt, distinctReceipt],
      }),
    /overlaps an existing receipt/u,
  );
});

test("Queue handoff payload preserves prompts and reconstructs controls without serializing closures", async () => {
  const receipt = createTelegramQueueAdmissionReceipt({
    queueKind: "prompt",
    scope: "handoff",
    sourceUpdateIds: [1],
  })!;
  const prompt = createQueueTestPromptTurn({
    admissionReceipts: [receipt],
    target: { chatId: 1, threadId: 9 },
    reactionSuppressionEmoji: "👎",
    content: [
      { type: "text", text: "handoff prompt" },
      { type: "image", data: "image-data", mimeType: "image/png" },
    ],
  });
  const promptPayload = createTelegramQueueHandoffPayload(prompt);
  assert.deepEqual(
    restoreTelegramQueueHandoffPayload(promptPayload, () =>
      assert.fail("prompt restore must not request a control execution"),
    ),
    prompt,
  );

  const controlReceipt = {
    ...receipt,
    queueKind: "control" as const,
    receiptId: "control-receipt",
  };
  const control = createQueueTestControlItem<string>({
    admissionReceipts: [controlReceipt],
    execute: async () => assert.fail("donor closure must not transfer"),
  });
  const controlPayload = createTelegramQueueHandoffPayload(control);
  assert.equal("execute" in controlPayload, false);
  assert.doesNotMatch(JSON.stringify(controlPayload), /donor closure/u);
  const calls: string[] = [];
  const restored = restoreTelegramQueueHandoffPayload<string>(
    controlPayload,
    (payload) => async (ctx) => {
      calls.push(`${payload.controlType}:${ctx}`);
    },
  );
  assert.equal(restored.kind, "control");
  if (restored.kind !== "control") assert.fail("expected restored control");
  await restored.execute("recipient");
  assert.deepEqual(calls, ["status:recipient"]);
});

test("Queue handoff staging is idempotent and requires one complete receipt", () => {
  const receipt = createTelegramQueueAdmissionReceipt({
    queueKind: "prompt",
    scope: "handoff",
    sourceUpdateIds: [1],
  })!;
  const payload = createTelegramQueueHandoffPayload(
    createQueueTestPromptTurn({ admissionReceipts: [receipt] }),
  );
  const store = createTelegramQueueStore();
  const stage = () =>
    stageTelegramQueueHandoffPayload({
      payload,
      store,
      createControlExecution: () => async () => undefined,
    });
  assert.deepEqual(stage(), {
    status: "staged",
    receiptId: receipt.receiptId,
    sourceUpdateIds: [1],
  });
  assert.deepEqual(stage(), {
    status: "staged",
    receiptId: receipt.receiptId,
    sourceUpdateIds: [1],
  });
  assert.equal(store.getQueuedItems().length, 1);
  assert.throws(
    () =>
      stageTelegramQueueHandoffPayload({
        payload: {
          ...payload,
          admissionReceipts: [
            ...payload.admissionReceipts,
            { ...receipt, receiptId: "second" },
          ],
        },
        store,
        createControlExecution: () => async () => undefined,
      }),
    /requires exactly one complete receipt/u,
  );
});

test("Queue handoff staging keeps work non-dispatchable until journal acceptance", async () => {
  const receipt = createTelegramQueueAdmissionReceipt({
    queueKind: "control",
    scope: "handoff",
    sourceUpdateIds: [1],
  })!;
  const payload = createTelegramQueueHandoffPayload(
    createQueueTestControlItem<string>({
      admissionReceipts: [receipt],
      execute: async () => assert.fail("donor closure must not transfer"),
    }),
  );
  const liveStore = createTelegramQueueStore<string>();
  const calls: string[] = [];
  const staging = createTelegramQueueHandoffStagingRuntime({
    liveStore,
    createControlExecution: (control) => async (ctx) => {
      calls.push(`${control.controlType}:${ctx}`);
    },
  });

  assert.deepEqual(staging.stage(payload), {
    status: "staged",
    receiptId: receipt.receiptId,
    sourceUpdateIds: [1],
  });
  assert.equal(staging.hasStaged(receipt), true);
  assert.deepEqual(liveStore.getQueuedItems(), []);
  assert.equal(staging.accept(receipt), true);
  assert.equal(staging.hasStaged(receipt), false);
  assert.equal(liveStore.getQueuedItems().length, 1);
  assert.equal(staging.accept(receipt), true);
  const [accepted] = liveStore.getQueuedItems();
  assert.equal(accepted?.kind, "control");
  if (accepted?.kind !== "control") assert.fail("expected accepted control");
  await accepted.execute("recipient");
  assert.deepEqual(calls, ["status:recipient"]);
});

test("Queue receipt removal deletes only one exact donor item", () => {
  const receipt = createTelegramQueueAdmissionReceipt({
    queueKind: "prompt",
    scope: "handoff",
    sourceUpdateIds: [1],
  })!;
  const otherReceipt = createTelegramQueueAdmissionReceipt({
    queueKind: "prompt",
    scope: "handoff",
    sourceUpdateIds: [2],
  })!;
  const store = createTelegramQueueStore([
    createQueueTestPromptTurn({ admissionReceipts: [receipt] }),
    createQueueTestPromptTurn({ admissionReceipts: [otherReceipt] }),
  ]);
  assert.equal(removeTelegramQueueItemByReceipt({ receipt, store }), true);
  assert.equal(removeTelegramQueueItemByReceipt({ receipt, store }), false);
  assert.equal(
    store.getQueuedItems()[0]?.admissionReceipts?.[0]?.receiptId,
    otherReceipt.receiptId,
  );
});

test("Queue handoff staging rejects replay after recipient work is live", () => {
  const receipt = createTelegramQueueAdmissionReceipt({
    queueKind: "prompt",
    scope: "handoff",
    sourceUpdateIds: [1],
  })!;
  const payload = createTelegramQueueHandoffPayload(
    createQueueTestPromptTurn({ admissionReceipts: [receipt] }),
  );
  const liveStore = createTelegramQueueStore();
  const staging = createTelegramQueueHandoffStagingRuntime({
    liveStore,
    createControlExecution: () => async () => undefined,
  });
  staging.stage(payload);
  assert.equal(staging.accept(receipt), true);
  assert.throws(() => staging.stage(payload), /is already live/u);
});

test("Queue handoff staging cancellation retains no dispatchable work", () => {
  const receipt = createTelegramQueueAdmissionReceipt({
    queueKind: "prompt",
    scope: "handoff",
    sourceUpdateIds: [1],
  })!;
  const payload = createTelegramQueueHandoffPayload(
    createQueueTestPromptTurn({ admissionReceipts: [receipt] }),
  );
  const liveStore = createTelegramQueueStore();
  const staging = createTelegramQueueHandoffStagingRuntime({
    liveStore,
    createControlExecution: () => async () => undefined,
  });
  staging.stage(payload);
  assert.equal(staging.cancel(receipt), true);
  assert.equal(staging.cancel(receipt), false);
  assert.equal(staging.accept(receipt), false);
  assert.deepEqual(liveStore.getQueuedItems(), []);
});

test("Queue handoff rejects authority-free and oversized payloads", () => {
  assert.throws(
    () => createTelegramQueueHandoffPayload(createQueueTestPromptTurn()),
    /requires durable admission receipts/u,
  );
  const receipt = createTelegramQueueAdmissionReceipt({
    queueKind: "prompt",
    scope: "handoff",
    sourceUpdateIds: [1],
  })!;
  assert.throws(
    () =>
      createTelegramQueueHandoff({
        handoffToken: "token",
        item: createQueueTestPromptTurn({
          admissionReceipts: [receipt],
          content: [
            {
              type: "text",
              text: "x".repeat(TELEGRAM_QUEUE_HANDOFF_PAYLOAD_MAX_BYTES),
            },
          ],
        }),
      }),
    /exceeds its byte limit/u,
  );
});

test("Control-lane items sort before priority and default prompt items", () => {
  const defaultPrompt: TelegramQueueItem = createQueueTestPromptTurn({
    replyToMessageId: 1,
    sourceMessageIds: [1],
    queueOrder: 10,
    laneOrder: 10,
    content: [{ type: "text", text: "default" }],
    historyText: "default",
    statusSummary: "default",
  });
  const priorityPrompt: TelegramQueueItem = createQueueTestPromptTurn({
    queueOrder: 11,
    queueLane: "priority",
    laneOrder: 0,
    content: [{ type: "text", text: "priority" }],
    historyText: "priority",
    statusSummary: "priority",
  });
  const controlItem: TelegramQueueItem = createQueueTestControlItem({
    replyToMessageId: 3,
    queueOrder: 12,
  });
  const items = [defaultPrompt, controlItem, priorityPrompt].sort(
    compareTelegramQueueItems,
  );
  assert.deepEqual(
    items.map((item) => item?.statusSummary),
    ["control", "priority", "default"],
  );
});

test("Queue mutation helpers remove prompt items by Telegram message id", () => {
  const promptItem: TelegramQueueItem = createQueueTestPromptTurn({
    replyToMessageId: 1,
    sourceMessageIds: [11, 12],
    historyText: "prompt history",
  });
  const controlItem: TelegramQueueItem = createQueueTestControlItem();
  const result = removeTelegramQueueItemsByMessageIds(
    [promptItem, controlItem],
    [12],
  );
  assert.equal(result.removedCount, 1);
  assert.deepEqual(
    result.items.map((item) => item.statusSummary),
    ["control"],
  );
});

test("Queue mutation controller binds queue accessors to runtime mutations", () => {
  const events: string[] = [];
  const promptItem: PendingTelegramTurn = createQueueTestPromptTurn({
    replyToMessageId: 1,
    sourceMessageIds: [11],
    queueOrder: 2,
    laneOrder: 2,
    historyText: "prompt history",
  });
  const controlItem = buildPendingTelegramControlItem<string>({
    chatId: 1,
    replyToMessageId: 3,
    controlType: "status",
    queueOrder: 1,
    laneOrder: 0,
    statusSummary: "control",
    execute: async () => {},
  });
  let queuedItems: TelegramQueueItem<string>[] = [promptItem, controlItem];
  let nextLaneOrder = 7;
  const controller = createTelegramQueueMutationController<string>({
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
    },
    allocateLaneOrder: () => nextLaneOrder++,
    onItemsDiscarded: (items, ctx) => {
      events.push(
        `discard:${ctx}:${items.map((item) => item.statusSummary).join(",")}`,
      );
    },
    updateStatus: (ctx) => {
      events.push(ctx);
    },
  });
  controller.reorder("a");
  assert.deepEqual(
    queuedItems.map((item) => item.statusSummary),
    ["control", "prompt"],
  );
  controller.append(
    {
      ...promptItem,
      replyToMessageId: 12,
      sourceMessageIds: [12],
      queueOrder: 2,
      laneOrder: 2,
      statusSummary: "appended",
    },
    "append",
  );
  assert.deepEqual(
    queuedItems.map((item) => item.statusSummary),
    ["control", "prompt", "appended"],
  );
  assert.equal(
    controller.applyReactionByMessageId(
      11,
      { kind: "priority", emoji: "❤" },
      "b",
    ),
    true,
  );
  assert.equal(nextLaneOrder, 8);
  const reprioritized = queuedItems.find((item) => item.replyToMessageId === 1);
  assert.equal(
    reprioritized?.kind === "prompt" ? reprioritized.priorityEmoji : undefined,
    "❤",
  );
  assert.equal(
    controller.applyReactionByMessageId(11, { kind: "default" }, "c"),
    true,
  );
  assert.equal(nextLaneOrder, 9);
  assert.equal(controller.removeByMessageIds([11], "d"), 1);
  assert.equal(controller.clear("e"), 2);
  assert.deepEqual(queuedItems, []);
  assert.deepEqual(events, [
    "a",
    "append",
    "b",
    "c",
    "discard:d:prompt",
    "d",
    "discard:e:control,appended",
    "e",
  ]);
});

test("Queue clear retains live items when durable discard fails", () => {
  const item = createQueueTestPromptTurn();
  let queuedItems: TelegramQueueItem<string>[] = [item];
  assert.throws(
    () =>
      clearTelegramQueueItemsRuntime({
        ctx: "ctx",
        getQueuedItems: () => queuedItems,
        setQueuedItems: (items) => {
          queuedItems = items;
        },
        onItemsDiscarded: () => {
          throw new Error("journal publication failed");
        },
        updateStatus: () => {},
      }),
    /journal publication failed/,
  );
  assert.deepEqual(queuedItems, [item]);
});

test("Queue Skip preserves durable receipts while the item is waiting", () => {
  const receipt = createTelegramQueueAdmissionReceipt({
    queueKind: "prompt",
    scope: "profile-a:bot-a",
    sourceUpdateIds: [7],
  })!;
  const item = createQueueTestPromptTurn({
    sourceMessageIds: [7],
    admissionReceipts: [receipt],
  });
  let queuedItems: TelegramQueueItem<string>[] = [item];
  const discarded: TelegramQueueItem<string>[][] = [];
  const controller = createTelegramQueueMutationController<string>({
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
    },
    onItemsDiscarded: (items) => discarded.push([...items]),
    updateStatus: () => {},
  });

  assert.equal(
    controller.applyReactionByMessageId(
      7,
      { kind: "suppressed", emoji: "👎" },
      "ctx",
    ),
    true,
  );
  assert.equal(discarded.length, 0);
  assert.deepEqual(queuedItems[0]?.admissionReceipts, [receipt]);
  assert.equal(
    queuedItems[0]?.kind === "prompt"
      ? queuedItems[0].reactionSuppressionEmoji
      : undefined,
    "👎",
  );
});

test("Queue mutation controller does not publish exact receipt replays", () => {
  const receipt = createTelegramQueueAdmissionReceipt({
    queueKind: "prompt",
    scope: "profile-a:bot-a",
    sourceUpdateIds: [7],
  })!;
  const item = createQueueTestPromptTurn({ admissionReceipts: [receipt] });
  let queuedItems: TelegramQueueItem<string>[] = [item];
  const events: string[] = [];
  const controller = createTelegramQueueMutationController<string>({
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push("set");
    },
    updateStatus: () => events.push("status"),
  });

  controller.append({ ...item }, "ctx");

  assert.deepEqual(queuedItems, [item]);
  assert.deepEqual(events, []);
});

test("Queue mutation runtime removes, sorts, and reprioritizes prompts", () => {
  const events: string[] = [];
  const promptItem: PendingTelegramTurn = createQueueTestPromptTurn({
    replyToMessageId: 1,
    sourceMessageIds: [11],
  });
  const priorityPrompt: PendingTelegramTurn = {
    ...promptItem,
    replyToMessageId: 2,
    sourceMessageIds: [22],
    queueOrder: 2,
    queueLane: "priority",
    laneOrder: 0,
    statusSummary: "priority",
  };
  const controlItem = buildPendingTelegramControlItem<string>({
    chatId: 1,
    replyToMessageId: 3,
    controlType: "status",
    queueOrder: 3,
    laneOrder: 0,
    statusSummary: "control",
    execute: async () => {},
  });
  let queuedItems: TelegramQueueItem<string>[] = [
    promptItem,
    controlItem,
    priorityPrompt,
  ];
  let nextLaneOrder = 5;
  const deps = {
    ctx: "ctx",
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items: TelegramQueueItem<string>[]) => {
      queuedItems = items;
      events.push(`items:${items.map((item) => item.statusSummary).join(",")}`);
    },
    allocateLaneOrder: () => {
      const order = nextLaneOrder++;
      events.push(`order:${order}`);
      return order;
    },
    updateStatus: (ctx: string) => {
      events.push(`status:${ctx}`);
    },
  };
  assert.equal(
    applyTelegramQueuePromptReactionDispositionRuntime<string>(
      22,
      { kind: "default" },
      deps,
    ),
    true,
  );
  assert.deepEqual(
    queuedItems.map((item) => item.statusSummary),
    ["control", "prompt", "priority"],
  );
  assert.equal(
    applyTelegramQueuePromptReactionDispositionRuntime<string>(
      11,
      { kind: "priority", emoji: "⚡" },
      deps,
    ),
    true,
  );
  assert.equal(nextLaneOrder, 7);
  assert.deepEqual(
    queuedItems.map((item) => item.statusSummary),
    ["control", "prompt", "priority"],
  );
  assert.equal(
    removeTelegramQueueItemsByMessageIdsRuntime<string>([11], deps),
    1,
  );
  assert.deepEqual(
    queuedItems.map((item) => item.statusSummary),
    ["control", "priority"],
  );
  assert.equal(clearTelegramQueueItemsRuntime<string>(deps), 2);
  assert.deepEqual(queuedItems, []);
  assert.equal(clearTelegramQueueItemsRuntime<string>(deps), 0);
  assert.deepEqual(events, [
    "order:5",
    "items:control,prompt,priority",
    "status:ctx",
    "order:6",
    "items:control,prompt,priority",
    "status:ctx",
    "items:control,priority",
    "status:ctx",
    "items:",
    "status:ctx",
  ]);
});

test("Queue mutation runtime swallows only stale context status errors", () => {
  let queuedItems: TelegramQueueItem<string>[] = [createQueueTestPromptTurn()];
  const baseDeps = {
    ctx: "ctx",
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items: TelegramQueueItem<string>[]) => {
      queuedItems = items;
    },
  };
  assert.doesNotThrow(() =>
    clearTelegramQueueItemsRuntime<string>({
      ...baseDeps,
      updateStatus: () => {
        throw new Error("ctx is stale after session reload");
      },
    }),
  );
  queuedItems = [createQueueTestPromptTurn()];
  assert.throws(
    () =>
      clearTelegramQueueItemsRuntime<string>({
        ...baseDeps,
        updateStatus: () => {
          throw new Error("status broke");
        },
      }),
    /status broke/,
  );
});

test("Queue mutation helpers scope message-id mutations by chat and thread", () => {
  const privateTurn = createQueueTestPromptTurn({
    chatId: 1,
    sourceMessageIds: [10],
    statusSummary: "private",
  });
  const threadTurn = createQueueTestPromptTurn({
    chatId: 1,
    target: { chatId: 1, threadId: 2 },
    sourceMessageIds: [10],
    statusSummary: "thread",
  });
  const otherChatTurn = createQueueTestPromptTurn({
    chatId: 2,
    sourceMessageIds: [10],
    statusSummary: "other",
  });

  assert.deepEqual(
    removeTelegramQueueItemsByMessageIds(
      [privateTurn, threadTurn, otherChatTurn],
      [10],
      { chatId: 1, threadId: 2 },
    ).items.map((item) => item.statusSummary),
    ["private", "other"],
  );

  const prioritized = applyTelegramQueuePromptReactionDisposition(
    [privateTurn, otherChatTurn],
    10,
    { kind: "priority", emoji: "⚡" },
    5,
    { chatId: 2 },
  ).items;
  assert.equal(
    prioritized[0]?.kind === "prompt" ? prioritized[0].queueLane : undefined,
    "default",
  );
  assert.equal(
    prioritized[1]?.kind === "prompt" ? prioritized[1].queueLane : undefined,
    "priority",
  );

  const cleared = applyTelegramQueuePromptReactionDisposition(
    prioritized,
    10,
    { kind: "default" },
    6,
    { chatId: 2 },
  ).items;
  assert.equal(
    cleared[1]?.kind === "prompt" ? cleared[1].queueLane : undefined,
    "default",
  );
});

test("Queue reaction disposition reversibly suppresses and restores prompts", () => {
  const prompt = createQueueTestPromptTurn({
    sourceMessageIds: [11],
    queueOrder: 4,
    laneOrder: 4,
  });
  const control = createQueueTestControlItem({ queueOrder: 5 });
  const suppressed = applyTelegramQueuePromptReactionDisposition(
    [prompt, control],
    11,
    { kind: "suppressed", emoji: "👎" },
  );
  assert.equal(suppressed.changed, true);
  assert.equal(suppressed.items[0]?.queueLane, "default");
  assert.equal(suppressed.items[1]?.queueLane, "control");
  assert.equal(
    suppressed.items[0]?.kind === "prompt"
      ? suppressed.items[0].reactionSuppressionEmoji
      : undefined,
    "👎",
  );
  const unchanged = applyTelegramQueuePromptReactionDisposition(
    suppressed.items,
    11,
    { kind: "suppressed", emoji: "👎" },
  );
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.items, suppressed.items);

  const prioritized = applyTelegramQueuePromptReactionDisposition(
    suppressed.items,
    11,
    { kind: "priority", emoji: "👍" },
    1,
  );
  assert.equal(prioritized.items[0]?.queueLane, "priority");
  assert.equal(
    prioritized.items[0]?.kind === "prompt"
      ? prioritized.items[0].reactionSuppressionEmoji
      : "unexpected",
    undefined,
  );
  assert.equal(
    prioritized.items[0]?.kind === "prompt"
      ? prioritized.items[0].priorityEmoji
      : undefined,
    "👍",
  );

  const restored = applyTelegramQueuePromptReactionDisposition(
    prioritized.items,
    11,
    { kind: "default" },
    2,
  );
  assert.equal(restored.items[0]?.queueLane, "default");
  assert.equal(
    restored.items[0]?.kind === "prompt"
      ? restored.items[0].priorityEmoji
      : "unexpected",
    undefined,
  );
});

test("Queue reaction disposition preserves independent priority and skip flags", () => {
  const prompt = createQueueTestPromptTurn({
    queueLane: "priority",
    laneOrder: 3,
    priorityEmoji: "👍",
  });
  const combined = applyTelegramQueuePromptReactionDisposition(
    [prompt],
    prompt.sourceMessageIds[0]!,
    {
      kind: "reaction-transition",
      suppressionEmoji: "💩",
    },
    99,
  );
  const skipped = combined.items[0];
  assert.equal(skipped?.queueLane, "priority");
  assert.equal(skipped?.laneOrder, 3);
  assert.equal(
    skipped?.kind === "prompt" ? skipped.priorityEmoji : undefined,
    "👍",
  );
  assert.equal(
    skipped?.kind === "prompt"
      ? skipped.reactionSuppressionEmoji
      : undefined,
    "💩",
  );

  const kept = applyTelegramQueuePromptReactionDisposition(
    combined.items,
    prompt.sourceMessageIds[0]!,
    { kind: "reaction-transition", suppressionEmoji: null },
    99,
  ).items[0];
  assert.equal(kept?.queueLane, "priority");
  assert.equal(kept?.laneOrder, 3);
  assert.equal(
    kept?.kind === "prompt" ? kept.reactionSuppressionEmoji : "unexpected",
    undefined,
  );
});

test("Queue Keep and Skip preserve exact order while lane changes alone reposition prompts", () => {
  let queuedItems: TelegramQueueItem<string>[] = [
    createQueueTestPromptTurn({
      sourceMessageIds: [1],
      queueOrder: 40,
      queueLane: "priority",
      laneOrder: 1,
      statusSummary: "priority",
    }),
    createQueueTestPromptTurn({
      sourceMessageIds: [10],
      queueOrder: 10,
      laneOrder: 10,
      statusSummary: "before",
    }),
    createQueueTestPromptTurn({
      sourceMessageIds: [20],
      queueOrder: 20,
      laneOrder: 20,
      statusSummary: "target",
    }),
    createQueueTestPromptTurn({
      sourceMessageIds: [30],
      queueOrder: 30,
      laneOrder: 30,
      statusSummary: "after",
    }),
  ];
  const deps = {
    ctx: "ctx",
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items: TelegramQueueItem<string>[]) => {
      queuedItems = items;
    },
    allocateLaneOrder: (() => {
      let nextLaneOrder = 100;
      return () => nextLaneOrder++;
    })(),
    updateStatus: () => {},
  };
  const order = () => queuedItems.map((item) => item.statusSummary);

  assert.equal(applyTelegramQueuePromptReactionDispositionRuntime(
    20,
    { kind: "suppressed", emoji: "💩" },
    deps,
  ), true);
  assert.deepEqual(order(), ["priority", "before", "target", "after"]);
  assert.equal(applyTelegramQueuePromptReactionDispositionRuntime(
    20,
    { kind: "default" },
    deps,
  ), true);
  assert.deepEqual(order(), ["priority", "before", "target", "after"]);

  assert.equal(applyTelegramQueuePromptReactionDispositionRuntime(
    20,
    { kind: "priority", emoji: "👍" },
    deps,
  ), true);
  assert.deepEqual(order(), ["priority", "target", "before", "after"]);
  assert.equal(applyTelegramQueuePromptReactionDispositionRuntime(
    20,
    {
      kind: "priority-suppressed",
      priorityEmoji: "👍",
      suppressionEmoji: "💩",
    },
    deps,
  ), true);
  assert.deepEqual(order(), ["priority", "target", "before", "after"]);
  assert.equal(applyTelegramQueuePromptReactionDispositionRuntime(
    20,
    { kind: "priority", emoji: "👍" },
    deps,
  ), true);
  assert.deepEqual(order(), ["priority", "target", "before", "after"]);

  assert.equal(applyTelegramQueuePromptReactionDispositionRuntime(
    20,
    { kind: "default" },
    deps,
  ), true);
  assert.deepEqual(order(), ["priority", "before", "after", "target"]);
});

test("Queue priority reactions apply to attachment-only prompt turns", () => {
  const attachmentPrompt: TelegramQueueItem = createQueueTestPromptTurn({
    sourceMessageIds: [21],
    queuedAttachments: [{ path: "/tmp/voice.ogg", fileName: "voice.ogg" }],
    content: [{ type: "text", text: "[telegram] voice transcript" }],
    historyText: "voice transcript",
    statusSummary: "📎 voice.ogg",
  });
  const prioritized = applyTelegramQueuePromptReactionDisposition(
    [attachmentPrompt],
    21,
    { kind: "priority", emoji: "⚡" },
    0,
  );
  assert.equal(prioritized.changed, true);
  assert.equal(prioritized.items[0]?.queueLane, "priority");
  assert.equal(prioritized.items[0]?.statusSummary, "📎 voice.ogg");
});

test("Queued status formatting keeps the terminal status bar compact", () => {
  const priorityPrompt: TelegramQueueItem = createQueueTestPromptTurn({
    replyToMessageId: 1,
    sourceMessageIds: [11],
    queueOrder: 4,
    queueLane: "priority",
    laneOrder: 0,
    priorityEmoji: "❤",
    historyText: "prompt history",
  });
  const defaultPrompt: TelegramQueueItem = createQueueTestPromptTurn({
    sourceMessageIds: [12],
    queueOrder: 5,
    laneOrder: 5,
    content: [{ type: "text", text: "default" }],
    historyText: "default history",
    statusSummary: "default",
  });
  const skippedPrompt: TelegramQueueItem = createQueueTestPromptTurn({
    replyToMessageId: 2,
    sourceMessageIds: [13],
    queueOrder: 6,
    laneOrder: 6,
    reactionSuppressionEmoji: "👎",
    historyText: "skipped history",
  });
  const controlItem: TelegramQueueItem = createQueueTestControlItem({
    replyToMessageId: 3,
    queueOrder: 7,
    statusSummary: "⚡ status",
  });
  const items = [controlItem, priorityPrompt, skippedPrompt, defaultPrompt];
  assert.equal(formatQueuedTelegramItemsStatus(items), " +3");
  assert.equal(
    createTelegramQueueItemCountGetter({ getQueuedItems: () => items })(),
    3,
  );
  assert.equal(formatQueuedTelegramItemsStatus([skippedPrompt]), "");
});

test("Queue enqueue planning folds queued prompts into history when requested", () => {
  const promptItem: TelegramQueueItem = createQueueTestPromptTurn({
    replyToMessageId: 1,
    sourceMessageIds: [11],
    historyText: "prompt history",
  });
  const controlItem: TelegramQueueItem = createQueueTestControlItem({
    controlType: "model",
  });
  assert.deepEqual(planTelegramPromptEnqueue([promptItem], false), {
    historyTurns: [],
    remainingItems: [promptItem],
  });
  const plan = planTelegramPromptEnqueue([promptItem, controlItem], true);
  assert.deepEqual(plan.historyTurns, [promptItem]);
  assert.deepEqual(plan.remainingItems, [controlItem]);
  assert.deepEqual(appendTelegramQueueItem(plan.remainingItems, promptItem), [
    controlItem,
    promptItem,
  ]);
  assert.throws(
    () =>
      appendTelegramQueueItem(plan.remainingItems, {
        ...controlItem,
        queueLane: "default",
      }),
    {
      message:
        "Invalid Telegram queue admission: control item cannot use default lane",
    },
  );
});

test("History partition keeps control items queued and extracts prompt items", () => {
  const promptItem: TelegramQueueItem = createQueueTestPromptTurn({
    replyToMessageId: 1,
    sourceMessageIds: [1],
    historyText: "prompt history",
  });
  const controlItem: TelegramQueueItem = createQueueTestControlItem();
  const result = partitionTelegramQueueItemsForHistory([
    promptItem,
    controlItem,
  ]);
  assert.deepEqual(
    result.historyTurns.map((item) => item.statusSummary),
    ["prompt"],
  );
  assert.deepEqual(
    result.remainingItems.map((item) => item.statusSummary),
    ["control"],
  );
});

test("Dispatch planning returns the prompt item when dispatch is allowed", () => {
  const controlItem: TelegramQueueItem = createQueueTestControlItem({
    replyToMessageId: 1,
    queueOrder: 1,
  });
  const promptItem: TelegramQueueItem = createQueueTestPromptTurn({
    queueOrder: 2,
    laneOrder: 2,
    historyText: "prompt history",
  });
  const result = planNextTelegramQueueAction([promptItem, controlItem], true);
  assert.equal(result.kind, "prompt");
  assert.equal(
    result.kind === "prompt" ? result.item.statusSummary : "",
    "prompt",
  );
  assert.deepEqual(
    result.remainingItems.map((item) => item.statusSummary),
    ["prompt", "control"],
  );
});

test("Dispatch planning runs control items before normal prompts", () => {
  const controlItem: TelegramQueueItem = createQueueTestControlItem({
    replyToMessageId: 1,
    queueOrder: 1,
  });
  const promptItem: TelegramQueueItem = createQueueTestPromptTurn({
    queueOrder: 2,
    laneOrder: 2,
    historyText: "prompt history",
  });
  const result = planNextTelegramQueueAction([controlItem, promptItem], true);
  assert.equal(result.kind, "control");
  assert.equal(
    result.kind === "control" ? result.item.statusSummary : "",
    "control",
  );
  assert.deepEqual(
    result.remainingItems.map((item) => item.statusSummary),
    ["prompt"],
  );
});

test("Dispatch planning returns none when dispatch is blocked", () => {
  const promptItem: TelegramQueueItem = createQueueTestPromptTurn({
    queueOrder: 2,
    laneOrder: 2,
    historyText: "prompt history",
  });
  const result = planNextTelegramQueueAction([promptItem], false);
  assert.equal(result.kind, "none");
  assert.deepEqual(
    result.remainingItems.map((item) => item.statusSummary),
    ["prompt"],
  );
});

test("Control-item dispatch sequencing hands off to the next prompt", () => {
  const controlItem: TelegramQueueItem = createQueueTestControlItem({
    replyToMessageId: 1,
    queueOrder: 1,
  });
  const promptItem: TelegramQueueItem = createQueueTestPromptTurn({
    queueOrder: 2,
    laneOrder: 2,
    historyText: "prompt history",
  });
  const firstStep = planNextTelegramQueueAction(
    [controlItem, promptItem],
    true,
  );
  assert.equal(firstStep.kind, "control");
  const secondStep = planNextTelegramQueueAction(
    firstStep.remainingItems,
    true,
  );
  assert.equal(secondStep.kind, "prompt");
  assert.equal(
    secondStep.kind === "prompt" ? secondStep.item.statusSummary : "",
    "prompt",
  );
});

test("Abort-history leaves queued prompts waiting for explicit continuation", () => {
  assert.equal(
    shouldDispatchAfterTelegramAgentEnd({
      hasTurn: true,
      stopReason: "aborted",
      foldQueuedPromptsIntoHistory: true,
    }),
    false,
  );
  const promptItem: TelegramQueueItem = createQueueTestPromptTurn({
    queueOrder: 2,
    laneOrder: 2,
    historyText: "prompt history",
  });
  const blockedDispatch = planNextTelegramQueueAction(
    [promptItem],
    shouldDispatchAfterTelegramAgentEnd({
      hasTurn: true,
      stopReason: "aborted",
      foldQueuedPromptsIntoHistory: true,
    }),
  );
  assert.equal(blockedDispatch.kind, "none");
  assert.deepEqual(
    blockedDispatch.remainingItems.map((item) => item.statusSummary),
    ["prompt"],
  );
});

test("Agent end dispatch policy resumes after success and error, but not abort-history", () => {
  assert.equal(
    shouldDispatchAfterTelegramAgentEnd({
      hasTurn: false,
      foldQueuedPromptsIntoHistory: false,
    }),
    true,
  );
  assert.equal(
    shouldDispatchAfterTelegramAgentEnd({
      hasTurn: true,
      stopReason: "error",
      foldQueuedPromptsIntoHistory: false,
    }),
    true,
  );
  assert.equal(
    shouldDispatchAfterTelegramAgentEnd({
      hasTurn: true,
      stopReason: "aborted",
      foldQueuedPromptsIntoHistory: false,
    }),
    true,
  );
  assert.equal(
    shouldDispatchAfterTelegramAgentEnd({
      hasTurn: true,
      stopReason: "aborted",
      foldQueuedPromptsIntoHistory: true,
    }),
    false,
  );
});

test("Agent end runtime resets state, finalizes replies, sends attachments, and dispatches", async () => {
  const events: string[] = [];
  const turn: PendingTelegramTurn = createQueueTestPromptTurn({
    queuedAttachments: [{ path: "/tmp/demo.txt", fileName: "demo.txt" }],
  });
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "final" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {
      events.push("reset");
    },
    waitForTypingIdle: async () => {
      events.push("typing-idle");
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    clearPreview: async (chatId) => {
      events.push(`clear:${chatId}`);
    },
    setPreviewPendingText: (text) => {
      events.push(`preview:${text}`);
    },
    finalizeMarkdownPreview: async (_chatId, markdown) => {
      events.push(`finalize:${markdown}`);
      return false;
    },
    sendMarkdownReply: async (_chatId, _replyToMessageId, markdown) => {
      events.push(`markdown:${markdown}`);
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      events.push(`text:${text}`);
    },
    sendQueuedAttachments: async (nextTurn) => {
      events.push(`attachments:${nextTurn.queuedAttachments.length}`);
    },
  });
  assert.deepEqual(events, [
    "reset",
    "typing-idle",
    "status",
    "preview:final",
    "finalize:final",
    "clear:1",
    "markdown:final",
    "preview:",
    "attachments:1",
    "dispatch",
  ]);
});

test("Agent end runtime delivers one Rich attachment result without duplicate text or upload", async () => {
  const events: string[] = [];
  const turn = createQueueTestPromptTurn({
    queuedAttachments: [{ path: "/tmp/demo.png", fileName: "demo.png" }],
  });
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "final" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => events.push("reset"),
    updateStatus: () => events.push("status"),
    dispatchNextQueuedTelegramTurn: () => events.push("dispatch"),
    clearPreview: async () => {
      events.push("clear");
    },
    setPreviewPendingText: () => events.push("preview"),
    finalizeMarkdownPreview: async () => {
      events.push("unexpected:finalize");
      return false;
    },
    sendMarkdownReply: async () => {
      events.push("unexpected:markdown");
    },
    sendTextReply: async () => {
      events.push("unexpected:text");
    },
    sendQueuedAttachments: async () => {
      events.push("unexpected:attachment");
    },
    sendRichAttachmentReply: async (_nextTurn, markdown) => {
      events.push(`rich:${markdown}`);
      return true;
    },
  });
  assert.deepEqual(events, [
    "reset",
    "status",
    "preview",
    "rich:final",
    "clear",
    "preview",
    "dispatch",
  ]);
});

test("Agent end runtime never falls back after ambiguous Rich attachment delivery", async () => {
  const events: string[] = [];
  await handleTelegramAgentEndRuntime({
    turn: createQueueTestPromptTurn({
      queuedAttachments: [{ path: "/tmp/demo.png", fileName: "demo.png" }],
    }),
    assistant: { text: "final" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {},
    updateStatus: () => {},
    dispatchNextQueuedTelegramTurn: () => events.push("dispatch"),
    clearPreview: async () => {
      events.push("unexpected:clear");
    },
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => {
      events.push("unexpected:finalize");
      return false;
    },
    sendMarkdownReply: async () => {
      events.push("unexpected:markdown");
    },
    sendTextReply: async () => {
      events.push("unexpected:text");
    },
    sendQueuedAttachments: async () => {
      events.push("unexpected:attachment");
    },
    sendRichAttachmentReply: async () => {
      throw new Error("commit unknown");
    },
    recordRuntimeEvent: (_category, _error, details) =>
      events.push(`record:${details?.phase}`),
  });
  assert.deepEqual(events, [
    "record:rich-attachment-commit-unknown",
    "dispatch",
  ]);
});

test("Agent end runtime delivers one Guest Mode attachment instead of a text article", async () => {
  const events: unknown[] = [];
  const turn: PendingTelegramTurn = createQueueTestPromptTurn({
    chatId: 0,
    replyToMessageId: 0,
    guestQueryId: "guest-1",
    queuedAttachments: [{ path: "/tmp/demo.txt", fileName: "demo.txt" }],
  });
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "final caption" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => events.push("reset"),
    updateStatus: () => events.push("status"),
    dispatchNextQueuedTelegramTurn: () => events.push("dispatch"),
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => false,
    sendMarkdownReply: async () => {},
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {
      events.push("unexpected:ordinary");
    },
    sendGuestReply: async () => {
      events.push("unexpected:text");
    },
    sendGuestAttachment: async (nextTurn, attachment, caption) => {
      events.push([
        "guest-attachment",
        nextTurn.guestQueryId,
        attachment.path,
        caption,
      ]);
    },
  });
  assert.deepEqual(events, [
    "reset",
    "status",
    ["guest-attachment", "guest-1", "/tmp/demo.txt", "final caption"],
    "dispatch",
  ]);
});

test("Agent end runtime routes Guest Mode voice markup through one media result", async () => {
  const events: unknown[] = [];
  const turn: PendingTelegramTurn = createQueueTestPromptTurn({
    chatId: 0,
    replyToMessageId: 0,
    guestQueryId: "guest-1",
  });
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "voice markup" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {},
    updateStatus: () => {},
    dispatchNextQueuedTelegramTurn: () => events.push("dispatch"),
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => false,
    sendMarkdownReply: async () => {},
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {
      events.push("unexpected:attachment");
    },
    sendGuestReply: async () => {
      events.push("unexpected:text");
    },
    planOutboundReply: () => ({
      markdown: "visible caption",
      voiceText: "spoken result",
    }),
    sendGuestVoiceReply: async (nextTurn, plan, caption) => {
      events.push([
        "guest-voice",
        nextTurn.guestQueryId,
        plan.voiceText,
        caption,
      ]);
    },
  });
  assert.deepEqual(events, [
    ["guest-voice", "guest-1", "spoken result", "visible caption"],
    "dispatch",
  ]);
});

test("Agent end runtime records Guest Mode attachment failure without a second answer", async () => {
  const events: string[] = [];
  const turn: PendingTelegramTurn = createQueueTestPromptTurn({
    chatId: 0,
    replyToMessageId: 0,
    guestQueryId: "guest-1",
    queuedAttachments: [{ path: "/tmp/demo.txt", fileName: "demo.txt" }],
  });
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "final caption" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {},
    updateStatus: () => {},
    dispatchNextQueuedTelegramTurn: () => events.push("dispatch"),
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => false,
    sendMarkdownReply: async () => {},
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {},
    answerGuestQuery: async () => {
      events.push("unexpected:fallback");
    },
    sendGuestReply: async () => {
      events.push("unexpected:text");
    },
    sendGuestAttachment: async () => {
      events.push("attachment");
      throw new Error("ambiguous answer failure");
    },
    recordRuntimeEvent: (_category, _error, details) => {
      events.push(`record:${details?.phase}`);
    },
  });
  assert.deepEqual(events, [
    "attachment",
    "record:guest-attachment",
    "dispatch",
  ]);
});

test("Agent end runtime can schedule active-turn final delivery without blocking", async () => {
  const events: string[] = [];
  let scheduledTask: (() => Promise<void>) | undefined;
  const turn: PendingTelegramTurn = createQueueTestPromptTurn({
    queuedAttachments: [{ path: "/tmp/demo.txt", fileName: "demo.txt" }],
  });
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "final" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {
      events.push("reset");
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    scheduleActiveTurnDelivery: (task) => {
      events.push("scheduled");
      scheduledTask = task;
    },
    waitForActivityIdle: async () => {
      events.push("activity-idle");
    },
    clearPreview: async (chatId) => {
      events.push(`clear:${chatId}`);
    },
    setPreviewPendingText: (text) => {
      events.push(`preview:${text}`);
    },
    finalizeMarkdownPreview: async (_chatId, markdown) => {
      events.push(`finalize:${markdown}`);
      return true;
    },
    sendMarkdownReply: async () => {
      events.push("unexpected:markdown");
    },
    sendTextReply: async () => {
      events.push("unexpected:text");
    },
    sendQueuedAttachments: async (nextTurn) => {
      events.push(`attachments:${nextTurn.queuedAttachments.length}`);
    },
  });
  assert.deepEqual(events, ["reset", "status", "scheduled"]);
  assert.ok(scheduledTask);
  await scheduledTask();
  assert.deepEqual(events, [
    "reset",
    "status",
    "scheduled",
    "activity-idle",
    "preview:final",
    "finalize:final",
    "preview:",
    "attachments:1",
    "dispatch",
  ]);
});

test("Final delivery never clears a replacement preview after an awaited completion", async () => {
  for (const mode of ["finalized", "fallback", "rich"] as const) {
    for (const authority of ["session", "transport"] as const) {
      let active = true;
      let pending = "old";
      const replace = async () => {
        await Promise.resolve();
        active = false;
        pending = "replacement preview";
      };
      await handleTelegramAgentEndRuntime({
        turn: createQueueTestPromptTurn(), assistant: { text: "old final" },
        foldQueuedPromptsIntoHistory: false,
        isSessionActive: () => authority !== "session" || active,
        isTurnTransportActive: () => authority !== "transport" || active,
        resetRuntimeState: () => {}, updateStatus: () => {},
        dispatchNextQueuedTelegramTurn: () => assert.fail("Stale completion dispatched next work"),
        setPreviewPendingText: (text) => { pending = text; },
        clearPreview: async () => { if (mode === "rich") await replace(); },
        sendRichAttachmentReply: async () => mode === "rich",
        finalizeMarkdownPreview: async () => {
          if (mode === "finalized") await replace();
          return mode === "finalized";
        },
        sendMarkdownReply: async () => { await replace(); },
        sendTextReply: async () => assert.fail("Unexpected error reply"),
        sendQueuedAttachments: async () => assert.fail("Stale completion sent attachments"),
      });
      assert.equal(pending, "replacement preview", `${mode}/${authority}`);
    }
  }
});

test("Successful final delivery clears pending text across consecutive turns on every text path", async () => {
  for (const mode of ["finalized", "fallback", "rich"] as const) {
    let pending = "";
    const delivered: string[] = [];
    for (const text of ["first answer", "second answer"]) {
      assert.equal(pending, "", "The next turn must not inherit a completed answer");
      await handleTelegramAgentEndRuntime({
        turn: createQueueTestPromptTurn(), assistant: { text },
        foldQueuedPromptsIntoHistory: false,
        resetRuntimeState: () => {}, updateStatus: () => {},
        dispatchNextQueuedTelegramTurn: () => {},
        setPreviewPendingText: (value) => { pending = value; },
        clearPreview: async () => {},
        sendRichAttachmentReply: async (_turn, value) => {
          if (mode === "rich") delivered.push(value);
          return mode === "rich";
        },
        finalizeMarkdownPreview: async (_chat, value) => {
          if (mode === "finalized") delivered.push(value);
          return mode === "finalized";
        },
        sendMarkdownReply: async (_chat, _reply, value) => { delivered.push(value); },
        sendTextReply: async () => {}, sendQueuedAttachments: async () => {},
      });
      assert.equal(pending, "", mode);
    }
    assert.deepEqual(delivered, ["first answer", "second answer"], mode);
  }
});

test("Agent end scheduled delivery stops after session generation loss", async () => {
  const events: string[] = [];
  let active = true;
  let scheduledTask: (() => Promise<void>) | undefined;
  await handleTelegramAgentEndRuntime({
    turn: createQueueTestPromptTurn(),
    assistant: { text: "stale final" },
    foldQueuedPromptsIntoHistory: false,
    isSessionActive: () => active,
    resetRuntimeState: () => events.push("reset"),
    updateStatus: () => events.push("status"),
    dispatchNextQueuedTelegramTurn: () => events.push("dispatch"),
    scheduleActiveTurnDelivery: (task) => {
      scheduledTask = task;
    },
    clearPreview: async () => {
      events.push("clear");
    },
    setPreviewPendingText: () => events.push("preview"),
    finalizeMarkdownPreview: async () => {
      events.push("finalize");
      return true;
    },
    sendMarkdownReply: async () => events.push("send"),
    sendTextReply: async () => events.push("text"),
    sendQueuedAttachments: async () => {
      events.push("attachments");
    },
  });
  active = false;
  await scheduledTask?.();

  assert.deepEqual(events, ["reset", "status"]);
});

test("Agent end Rich attachment delivery never starts through a replacement session", async () => {
  const events: string[] = [];
  let active = true;
  let scheduledTask: (() => Promise<void>) | undefined;
  await handleTelegramAgentEndRuntime({
    turn: createQueueTestPromptTurn({
      queuedAttachments: [{ path: "/tmp/demo.png", fileName: "demo.png" }],
    }),
    assistant: { text: "stale rich final" },
    foldQueuedPromptsIntoHistory: false,
    isSessionActive: () => active,
    resetRuntimeState: () => events.push("reset"),
    updateStatus: () => events.push("status"),
    dispatchNextQueuedTelegramTurn: () => events.push("dispatch"),
    scheduleActiveTurnDelivery: (task) => {
      scheduledTask = task;
    },
    clearPreview: async () => {
      events.push("clear");
    },
    setPreviewPendingText: () => events.push("preview"),
    sendRichAttachmentReply: async () => {
      events.push("rich");
      return true;
    },
    finalizeMarkdownPreview: async () => {
      events.push("finalize");
      return true;
    },
    sendMarkdownReply: async () => {
      events.push("markdown");
    },
    sendTextReply: async () => {
      events.push("text");
    },
    sendQueuedAttachments: async () => {
      events.push("attachments");
    },
  });
  active = false;
  await scheduledTask?.();

  assert.deepEqual(events, ["reset", "status"]);
});

test("Agent end Rich attachment delivery stops stale continuation after replacement", async () => {
  const events: string[] = [];
  let active = true;
  await handleTelegramAgentEndRuntime({
    turn: createQueueTestPromptTurn({
      queuedAttachments: [{ path: "/tmp/demo.png", fileName: "demo.png" }],
    }),
    assistant: { text: "in-flight rich final" },
    foldQueuedPromptsIntoHistory: false,
    isSessionActive: () => active,
    resetRuntimeState: () => events.push("reset"),
    updateStatus: () => events.push("status"),
    dispatchNextQueuedTelegramTurn: () => events.push("dispatch"),
    clearPreview: async () => {
      events.push("clear");
    },
    setPreviewPendingText: () => events.push("preview"),
    sendRichAttachmentReply: async () => {
      events.push("rich");
      active = false;
      return true;
    },
    finalizeMarkdownPreview: async () => {
      events.push("finalize");
      return true;
    },
    sendMarkdownReply: async () => {
      events.push("markdown");
    },
    sendTextReply: async () => {
      events.push("text");
    },
    sendQueuedAttachments: async () => {
      events.push("attachments");
    },
  });

  assert.deepEqual(events, ["reset", "status", "preview", "rich"]);
});

test("Agent end stops old-profile delivery after preview finalization yields", async () => {
  const events: string[] = [];
  let transportActive = true;
  const turn = createQueueTestPromptTurn();
  turn.transportStamp = { profile: "a", generation: "epoch-a" };
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "old profile final" },
    foldQueuedPromptsIntoHistory: false,
    isTurnTransportActive: () => transportActive,
    resetRuntimeState: () => events.push("reset"),
    updateStatus: () => events.push("status"),
    dispatchNextQueuedTelegramTurn: () => events.push("dispatch"),
    clearPreview: async () => {
      events.push("clear");
    },
    setPreviewPendingText: () => events.push("preview"),
    finalizeMarkdownPreview: async () => {
      events.push("finalize");
      transportActive = false;
      return false;
    },
    sendMarkdownReply: async () => events.push("send"),
    sendTextReply: async () => events.push("text"),
    sendQueuedAttachments: async () => {
      events.push("attachments");
    },
  });

  assert.deepEqual(events, ["reset", "status", "preview", "finalize"]);
});

test("Agent end runtime keeps plain notices in the active turn target", async () => {
  const replies: Array<{ text: string; target?: unknown }> = [];
  const target = { chatId: 1, threadId: 42 };
  const baseDeps = {
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {},
    updateStatus: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => false,
    sendMarkdownReply: async () => {},
    sendTextReply: async (
      _chatId: number,
      _replyToMessageId: number,
      text: string,
      options?: { target?: unknown },
    ) => {
      replies.push({ text, target: options?.target });
    },
    sendQueuedAttachments: async () => {},
  };
  await handleTelegramAgentEndRuntime({
    ...baseDeps,
    turn: createQueueTestPromptTurn({ target }),
    assistant: { stopReason: "error", errorMessage: "boom" },
  });
  await handleTelegramAgentEndRuntime({
    ...baseDeps,
    turn: createQueueTestPromptTurn({
      target,
      queuedAttachments: [{ path: "/tmp/demo.txt", fileName: "demo.txt" }],
    }),
    assistant: {},
  });
  assert.deepEqual(replies, [
    { text: "boom", target },
    { text: "Attached requested file(s).", target },
  ]);
});

test("Agent end runtime records final delivery failures and dispatches", async () => {
  const events: string[] = [];
  const turn: PendingTelegramTurn = createQueueTestPromptTurn();
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "final" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {
      events.push("reset");
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    clearPreview: async () => {
      events.push("clear");
    },
    setPreviewPendingText: (text) => {
      events.push(`preview:${text}`);
    },
    finalizeMarkdownPreview: async () => {
      throw new Error("fetch failed");
    },
    sendMarkdownReply: async () => {
      events.push("unexpected:markdown");
    },
    sendTextReply: async () => {
      events.push("unexpected:text");
    },
    sendQueuedAttachments: async () => {
      events.push("attachments");
    },
    recordRuntimeEvent: (category, _error, details) => {
      events.push(`${category}:${details?.phase}`);
    },
  });
  assert.deepEqual(events, [
    "reset",
    "status",
    "preview:final",
    "delivery:final-text",
    "attachments",
    "dispatch",
  ]);
});

test("Agent end runtime leaves proactive local output to Activity projection", async () => {
  const events: string[] = [];
  await handleTelegramAgentEndRuntime({
    turn: undefined,
    assistant: { text: "done" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => events.push("reset"),
    updateStatus: () => events.push("status"),
    dispatchNextQueuedTelegramTurn: () => events.push("dispatch"),
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => false,
    sendMarkdownReply: async () => {
      events.push("unexpected:markdown");
    },
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {},
  });
  assert.deepEqual(events, ["reset", "status", "dispatch"]);
});

test("Agent end runtime keeps queued Telegram turn delivery independent from polling ownership", async () => {
  const events: string[] = [];
  const turn: PendingTelegramTurn = createQueueTestPromptTurn({
    queuedAttachments: [{ path: "/tmp/demo.txt", fileName: "demo.txt" }],
  });
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "final" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {
      events.push("reset");
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    clearPreview: async (chatId) => {
      events.push(`clear:${chatId}`);
    },
    setPreviewPendingText: (text) => {
      events.push(`preview:${text}`);
    },
    finalizeMarkdownPreview: async (chatId, markdown) => {
      events.push(`finalize:${chatId}:${markdown}`);
      return true;
    },
    sendMarkdownReply: async () => {
      events.push("unexpected:markdown");
    },
    sendTextReply: async () => {
      events.push("unexpected:text");
    },
    sendQueuedAttachments: async () => {
      events.push("attachments");
    },
    sendOutboundReplyArtifacts: async () => {
      events.push("unexpected:voice");
    },
  });
  assert.deepEqual(events, [
    "reset",
    "status",
    "preview:final",
    "finalize:1:final",
    "preview:",
    "attachments",
    "dispatch",
  ]);
});

test("Agent end runtime plans assistant button comments for active Telegram replies", async () => {
  const events: unknown[] = [];
  const turn: PendingTelegramTurn = createQueueTestPromptTurn({
    target: { chatId: 1, threadId: 42 },
  });
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: {
      text: 'Choose one:\n\n<!-- telegram_button label="Continue" prompt="Continue with context." -->',
    },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {
      events.push("reset");
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    clearPreview: async (chatId) => {
      events.push(`clear:${chatId}`);
    },
    setPreviewPendingText: (text) => {
      events.push(`preview:${text}`);
    },
    finalizeMarkdownPreview: async (_chatId, markdown, _replyTo, options) => {
      events.push({
        finalize: markdown,
        replyMarkup: options?.replyMarkup,
        target: options?.target,
      });
      return true;
    },
    sendMarkdownReply: async () => {
      events.push("unexpected:markdown");
    },
    sendTextReply: async () => {
      events.push("unexpected:text");
    },
    sendQueuedAttachments: async () => {
      events.push("attachments");
    },
    planOutboundReply: createTelegramOutboundReplyPlanner(
      createTelegramButtonActionStore(),
    ),
  });
  assert.equal(events[0], "reset");
  assert.equal(events[1], "status");
  assert.equal(events[2], "preview:Choose one:");
  assert.equal(events[4], "preview:");
  assert.equal(events[5], "attachments");
  assert.equal(events[6], "dispatch");
  const finalDelivery = events[3] as {
    finalize: string;
    target?: { chatId: number; threadId?: number };
    replyMarkup?: {
      inline_keyboard?: Array<Array<{ text: string; callback_data: string }>>;
    };
  };
  assert.equal(finalDelivery.finalize, "Choose one:");
  assert.deepEqual(finalDelivery.target, { chatId: 1, threadId: 42 });
  assert.equal(
    finalDelivery.replyMarkup?.inline_keyboard?.[0]?.[0]?.text,
    "Continue",
  );
  assert.match(
    finalDelivery.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data ?? "",
    /^tgbtn:/,
  );
});

test("Agent end runtime passes assistant button markup to final text delivery", async () => {
  const events: unknown[] = [];
  const replyMarkup = {
    inline_keyboard: [[{ text: "Continue", callback_data: "btn:1" }]],
  };
  const turn: PendingTelegramTurn = createQueueTestPromptTurn();
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: {
      text: 'Answer\n\n<!-- telegram_button value="Continue" -->',
    },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {
      events.push("reset");
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    clearPreview: async (chatId) => {
      events.push(`clear:${chatId}`);
    },
    setPreviewPendingText: (text) => {
      events.push(`preview:${text}`);
    },
    finalizeMarkdownPreview: async (_chatId, markdown, _replyTo, options) => {
      events.push({ finalize: markdown, replyMarkup: options?.replyMarkup });
      return true;
    },
    sendMarkdownReply: async () => {
      events.push("unexpected:markdown");
    },
    sendTextReply: async () => {
      events.push("unexpected:text");
    },
    sendQueuedAttachments: async () => {
      events.push("attachments");
    },
    planOutboundReply: () => ({ markdown: "Answer", replyMarkup }),
  });
  assert.deepEqual(events, [
    "reset",
    "status",
    "preview:Answer",
    { finalize: "Answer", replyMarkup },
    "preview:",
    "attachments",
    "dispatch",
  ]);
});

test("Agent end runtime splits assistant voice markup into text and voice delivery", async () => {
  const events: string[] = [];
  const turn: PendingTelegramTurn = createQueueTestPromptTurn();
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: {
      text: [
        "Full technical text.",
        "",
        '<!-- telegram_voice text="Short voice summary." lang="ru" rate="+20%" -->',
      ].join("\n"),
    },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {
      events.push("reset");
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    clearPreview: async (chatId) => {
      events.push(`clear:${chatId}`);
    },
    setPreviewPendingText: (text) => {
      events.push(`preview:${text}`);
    },
    finalizeMarkdownPreview: async (_chatId, markdown) => {
      events.push(`finalize:${markdown}`);
      return true;
    },
    sendMarkdownReply: async () => {
      events.push("unexpected:markdown");
    },
    sendTextReply: async () => {
      events.push("unexpected:text");
    },
    sendQueuedAttachments: async () => {
      events.push("attachments");
    },
    planOutboundReply: (markdown) => ({
      markdown: "Full technical text.",
      voiceText: markdown.includes("telegram_voice")
        ? "Short voice summary."
        : undefined,
      lang: "ru",
      rate: "+20%",
    }),
    sendOutboundReplyArtifacts: async (_turn, plan, options) => {
      events.push(
        `voice:${plan.voiceText}:${plan.lang}:${plan.rate}:${options?.replyToPrompt}`,
      );
    },
  });
  assert.deepEqual(events, [
    "reset",
    "status",
    "preview:Full technical text.",
    "finalize:Full technical text.",
    "preview:",
    "voice:Short voice summary.:ru:+20%:false",
    "attachments",
    "dispatch",
  ]);
});

test("Agent end transparently intercepts text reply for voice-preferred turn", async () => {
  const events: unknown[] = [];
  const turn: PendingTelegramTurn = {
    ...createQueueTestPromptTurn(),
    voiceReplyPreferred: true,
  };
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "Hello from voice reply" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {
      events.push("reset");
    },
    updateStatus: () => {
      events.push("status");
    },
    clearPreview: async () => {
      events.push("clear");
    },
    setPreviewPendingText: () => {
      events.push("preview");
    },
    finalizeMarkdownPreview: async () => {
      events.push("finalize");
      return true;
    },
    sendMarkdownReply: async () => {
      events.push("text");
    },
    sendTextReply: async () => {
      events.push("fallback");
    },
    sendQueuedAttachments: async () => {
      events.push("attachments");
    },
    planOutboundReply: (markdown) => ({
      markdown,
    }),
    sendOutboundReplyArtifacts: async (_turn, plan, options) => {
      events.push(`voice:${plan.voiceText}:${options?.replyToPrompt}`);
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
  });
  assert.deepEqual(events, [
    "reset",
    "status",
    "clear",
    "voice:Hello from voice reply:true",
    "attachments",
    "dispatch",
  ]);
});

test("Agent end falls back to text when voice handler throws in always mode", async () => {
  const events: unknown[] = [];
  const turn: PendingTelegramTurn = {
    ...createQueueTestPromptTurn(),
    voiceReplyRequired: true,
  };
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "Fallback text reply" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {
      events.push("reset");
    },
    updateStatus: () => {
      events.push("status");
    },
    clearPreview: async () => {
      events.push("clear");
    },
    setPreviewPendingText: () => {
      events.push("preview");
    },
    finalizeMarkdownPreview: async () => {
      events.push("finalize");
      return true;
    },
    sendMarkdownReply: async (_chatId, _replyToMessageId, markdown) => {
      events.push(`text:${markdown}`);
    },
    sendTextReply: async () => {
      events.push("fallback");
    },
    sendQueuedAttachments: async () => {
      events.push("attachments");
    },
    planOutboundReply: (markdown) => ({ markdown }),
    sendOutboundReplyArtifacts: async () => {
      throw new Error("TTS service unavailable");
    },
    recordRuntimeEvent: (category, error, _details) => {
      events.push(`error:${category}:${(error as Error).message}`);
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
  });
  assert.deepEqual(events, [
    "reset",
    "status",
    "clear",
    "error:delivery:TTS service unavailable",
    "text:Fallback text reply",
    "attachments",
    "dispatch",
  ]);
});

test("Agent end falls back to text when voice handler throws in voice-received mode", async () => {
  const events: unknown[] = [];
  const turn: PendingTelegramTurn = {
    ...createQueueTestPromptTurn(),
    voiceReplyPreferred: true,
  };
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "Fallback text reply" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {
      events.push("reset");
    },
    updateStatus: () => {
      events.push("status");
    },
    clearPreview: async () => {
      events.push("clear");
    },
    setPreviewPendingText: () => {
      events.push("preview");
    },
    finalizeMarkdownPreview: async () => {
      events.push("finalize");
      return true;
    },
    sendMarkdownReply: async (_chatId, _replyToMessageId, markdown) => {
      events.push(`text:${markdown}`);
    },
    sendTextReply: async () => {
      events.push("fallback");
    },
    sendQueuedAttachments: async () => {
      events.push("attachments");
    },
    planOutboundReply: (markdown) => ({ markdown }),
    sendOutboundReplyArtifacts: async () => {
      throw new Error("TTS service unavailable");
    },
    recordRuntimeEvent: (category, error, _details) => {
      events.push(`error:${category}:${(error as Error).message}`);
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
  });
  assert.deepEqual(events, [
    "reset",
    "status",
    "clear",
    "error:delivery:TTS service unavailable",
    "text:Fallback text reply",
    "attachments",
    "dispatch",
  ]);
});

test("Agent end does not intercept when explicit voice markup exists", async () => {
  const events: unknown[] = [];
  const turn: PendingTelegramTurn = {
    ...createQueueTestPromptTurn(),
    voiceReplyRequired: true,
  };
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "Hello with explicit voice" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {
      events.push("reset");
    },
    updateStatus: () => {
      events.push("status");
    },
    clearPreview: async () => {
      events.push("clear");
    },
    setPreviewPendingText: () => {
      events.push("preview");
    },
    finalizeMarkdownPreview: async () => {
      events.push("finalize");
      return true;
    },
    sendMarkdownReply: async () => {
      events.push("text");
    },
    sendTextReply: async () => {
      events.push("fallback");
    },
    sendQueuedAttachments: async () => {
      events.push("attachments");
    },
    planOutboundReply: () => ({
      markdown: "",
      voiceText: "Explicit voice text",
    }),
    sendOutboundReplyArtifacts: async (_turn, plan, options) => {
      events.push(`voice:${plan.voiceText}:${options?.replyToPrompt}`);
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
  });
  assert.deepEqual(events, [
    "reset",
    "status",
    "clear",
    "voice:Explicit voice text:true",
    "attachments",
    "dispatch",
  ]);
});

test("Agent end does not intercept without planOutboundReply", async () => {
  let voiceArtifactsCalled = false;
  const turn: PendingTelegramTurn = {
    ...createQueueTestPromptTurn(),
    voiceReplyRequired: true,
  };
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "Hello with raw markup" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {},
    updateStatus: () => {},
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => true,
    sendMarkdownReply: async () => {},
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {},
    sendOutboundReplyArtifacts: async () => {
      voiceArtifactsCalled = true;
    },
    recordRuntimeEvent: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
  });
  assert.equal(voiceArtifactsCalled, false);
});

test("Agent end sends text as reply and voice without reply when both exist", async () => {
  const events: string[] = [];
  const turn: PendingTelegramTurn = {
    ...createQueueTestPromptTurn(),
    voiceReplyRequired: true,
  };
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "Hello world" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {},
    updateStatus: () => {},
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async (_chatId, _text, replyToMessageId) => {
      events.push(`finalize:${replyToMessageId}`);
      return true;
    },
    planOutboundReply: (text) => ({
      markdown: text,
      voiceText: text,
    }),
    sendMarkdownReply: async () => {},
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {},
    sendOutboundReplyArtifacts: async (_turn, _reply, options) => {
      events.push(`voice:replyToPrompt=${options?.replyToPrompt}`);
    },
    recordRuntimeEvent: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
  });
  assert.ok(events.some((e) => e.startsWith("finalize:")));
  assert.ok(events.some((e) => e === "voice:replyToPrompt=false"));
});

test("Agent end does not intercept when planOutboundReply returns voiceReplies", async () => {
  const events: string[] = [];
  const turn: PendingTelegramTurn = {
    ...createQueueTestPromptTurn(),
    voiceReplyPreferred: true,
  };
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "Hello world" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {},
    updateStatus: () => {},
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => true,
    sendMarkdownReply: async () => {},
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {},
    planOutboundReply: (text) => ({
      markdown: text,
      voiceReplies: [{ text, lang: "en" }],
    }),
    sendOutboundReplyArtifacts: async (_turn, reply, options) => {
      events.push(
        `voiceReplies:${reply.voiceReplies?.length}:replyToPrompt=${options?.replyToPrompt}`,
      );
    },
    recordRuntimeEvent: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
  });
  assert.ok(events.some((e) => e.startsWith("voiceReplies:1")));
  assert.ok(events.some((e) => e.includes("replyToPrompt=false")));
});

test("Agent end records event when voice fallback text delivery also fails", async () => {
  const events: string[] = [];
  const turn: PendingTelegramTurn = {
    ...createQueueTestPromptTurn(),
    voiceReplyRequired: true,
  };
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "Fallback text reply" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {},
    updateStatus: () => {},
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => true,
    sendMarkdownReply: async () => {
      throw new Error("Text delivery also failed");
    },
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {},
    planOutboundReply: (markdown) => ({ markdown }),
    sendOutboundReplyArtifacts: async () => {
      throw new Error("TTS service unavailable");
    },
    recordRuntimeEvent: (category, error, details) => {
      events.push(
        `error:${category}:${(error as Error).message}:${details?.phase ?? "none"}`,
      );
    },
    dispatchNextQueuedTelegramTurn: () => {},
  });
  assert.ok(events.some((e) => e.includes("voice-artifacts")));
  assert.ok(events.some((e) => e.includes("voice-fallback-text")));
});

test("Agent end does not intercept when rawFinalText is whitespace only", async () => {
  let voiceArtifactsCalled = false;
  const turn: PendingTelegramTurn = {
    ...createQueueTestPromptTurn(),
    voiceReplyPreferred: true,
  };
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "   \n\t  " },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {},
    updateStatus: () => {},
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => true,
    sendMarkdownReply: async () => {},
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {},
    sendOutboundReplyArtifacts: async () => {
      voiceArtifactsCalled = true;
    },
    recordRuntimeEvent: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
  });
  assert.equal(voiceArtifactsCalled, false);
});

test("Agent end uses rawFinalText when plannedReply is undefined", async () => {
  const events: string[] = [];
  const turn: PendingTelegramTurn = {
    ...createQueueTestPromptTurn(),
    voiceReplyPreferred: true,
  };
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "Raw text fallback" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {},
    updateStatus: () => {},
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => true,
    sendMarkdownReply: async () => {},
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {},
    planOutboundReply: () => undefined as any,
    sendOutboundReplyArtifacts: async (_turn, reply, options) => {
      events.push(
        `voice:${reply.voiceText}:replyToPrompt=${options?.replyToPrompt}`,
      );
    },
    recordRuntimeEvent: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
  });
  assert.ok(events.some((e) => e.includes("voice:Raw text fallback")));
  assert.ok(events.some((e) => e.includes("replyToPrompt=true")));
});

test("Agent end runtime ignores stale status after typing cleanup", async () => {
  const events: string[] = [];
  await handleTelegramAgentEndRuntime({
    turn: undefined,
    assistant: {},
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {
      events.push("reset");
    },
    waitForTypingIdle: async () => {
      events.push("typing-idle");
    },
    updateStatus: () => {
      throw new Error("This extension ctx is stale after session replacement");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => true,
    sendMarkdownReply: async () => {},
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {},
  });

  assert.deepEqual(events, ["reset", "typing-idle", "dispatch"]);
});

test("Agent end runtime ignores stale status when session deactivates during typing cleanup", async () => {
  const events: string[] = [];
  let sessionActive = true;
  await handleTelegramAgentEndRuntime({
    turn: undefined,
    assistant: {},
    foldQueuedPromptsIntoHistory: false,
    isSessionActive: () => sessionActive,
    resetRuntimeState: () => {
      events.push("reset");
    },
    waitForTypingIdle: async () => {
      events.push("typing-idle");
      sessionActive = false;
    },
    updateStatus: () => {
      events.push("status");
      throw new Error("This extension ctx is stale after session replacement");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    clearPreview: async () => {},
    setPreviewPendingText: () => {},
    finalizeMarkdownPreview: async () => true,
    sendMarkdownReply: async () => {},
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {},
  });

  assert.deepEqual(events, ["reset", "typing-idle", "status", "dispatch"]);
});

test("Agent end runtime rejects non-stale status after typing cleanup", async () => {
  await assert.rejects(
    handleTelegramAgentEndRuntime({
      turn: undefined,
      assistant: {},
      foldQueuedPromptsIntoHistory: false,
      resetRuntimeState: () => {},
      waitForTypingIdle: async () => {},
      updateStatus: () => {
        throw new Error("status update broke");
      },
      dispatchNextQueuedTelegramTurn: () => {},
      clearPreview: async () => {},
      setPreviewPendingText: () => {},
      finalizeMarkdownPreview: async () => true,
      sendMarkdownReply: async () => {},
      sendTextReply: async () => {},
      sendQueuedAttachments: async () => {},
    }),
    /status update broke/,
  );
});

test("Agent end hook binds assistant extraction and runtime ports", async () => {
  const events: string[] = [];
  const turn: PendingTelegramTurn = createQueueTestPromptTurn();
  const hook = createTelegramAgentEndHook<
    PendingTelegramTurn,
    { id: string },
    string
  >({
    getActiveTurn: () => turn,
    extractAssistant: (messages) => {
      events.push(`extract:${messages.join(",")}`);
      return { text: "final" };
    },
    getFoldQueuedPromptsIntoHistory: () => false,
    resetRuntimeState: () => {
      events.push("reset");
    },
    updateStatus: (ctx) => {
      events.push(`status:${ctx.id}`);
    },
    dispatchNextQueuedTelegramTurn: (ctx) => {
      events.push(`dispatch:${ctx.id}`);
    },
    requestDeferredDispatchNextQueuedTelegramTurn: (dispatch) => {
      setTimeout(() => dispatch({ id: "ctx" }), 0);
    },
    clearPreview: async (chatId) => {
      events.push(`clear:${chatId}`);
    },
    setPreviewPendingText: (text) => {
      events.push(`preview:${text}`);
    },
    finalizeMarkdownPreview: async (_chatId, markdown) => {
      events.push(`finalize:${markdown}`);
      return true;
    },
    sendMarkdownReply: async () => {
      events.push("unexpected:markdown");
    },
    sendTextReply: async () => {
      events.push("unexpected:text");
    },
    sendQueuedAttachments: async () => {
      events.push("attachments");
    },
  });
  await hook({ messages: ["a", "b"] }, { id: "ctx" });
  assert.deepEqual(events, [
    "extract:a,b",
    "reset",
    "status:ctx",
    "preview:final",
    "finalize:final",
    "preview:",
    "attachments",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, [
    "extract:a,b",
    "reset",
    "status:ctx",
    "preview:final",
    "finalize:final",
    "preview:",
    "attachments",
    "dispatch:ctx",
  ]);
});

test("Agent end runtime reports errors and dispatches next turn", async () => {
  const events: string[] = [];
  await handleTelegramAgentEndRuntime({
    turn: {
      kind: "prompt",
      chatId: 1,
      replyToMessageId: 2,
      sourceMessageIds: [2],
      queueOrder: 1,
      queueLane: "default",
      laneOrder: 1,
      queuedAttachments: [],
      content: [{ type: "text", text: "prompt" }],
      historyText: "prompt",
      statusSummary: "prompt",
    },
    assistant: { stopReason: "error", errorMessage: "boom" },
    foldQueuedPromptsIntoHistory: false,
    resetRuntimeState: () => {
      events.push("reset");
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    clearPreview: async (chatId) => {
      events.push(`clear:${chatId}`);
    },
    setPreviewPendingText: () => {
      events.push("unexpected:preview");
    },
    finalizeMarkdownPreview: async () => true,
    sendMarkdownReply: async () => {
      events.push("unexpected:markdown");
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      events.push(`text:${text}`);
    },
    sendQueuedAttachments: async () => {
      events.push("unexpected:attachments");
    },
  });
  assert.deepEqual(events, [
    "reset",
    "status",
    "clear:1",
    "text:boom",
    "dispatch",
  ]);
});

test("Agent end plan classifies turn outcomes correctly", () => {
  const noTurnPlan = buildTelegramAgentEndPlan({
    hasTurn: false,
    foldQueuedPromptsIntoHistory: false,
    hasFinalText: false,
    hasQueuedAttachments: false,
  });
  assert.equal(noTurnPlan.kind, "no-turn");
  assert.equal(noTurnPlan.shouldDispatchNext, true);
  const abortedPlan = buildTelegramAgentEndPlan({
    hasTurn: true,
    stopReason: "aborted",
    foldQueuedPromptsIntoHistory: true,
    hasFinalText: false,
    hasQueuedAttachments: true,
  });
  assert.equal(abortedPlan.kind, "aborted");
  assert.equal(abortedPlan.shouldClearPreview, true);
  assert.equal(abortedPlan.shouldDispatchNext, false);
  const errorPlan = buildTelegramAgentEndPlan({
    hasTurn: true,
    stopReason: "error",
    foldQueuedPromptsIntoHistory: false,
    hasFinalText: false,
    hasQueuedAttachments: false,
  });
  assert.equal(errorPlan.kind, "error");
  assert.equal(errorPlan.shouldSendErrorMessage, true);
  const attachmentPlan = buildTelegramAgentEndPlan({
    hasTurn: true,
    foldQueuedPromptsIntoHistory: false,
    hasFinalText: false,
    hasQueuedAttachments: true,
  });
  assert.equal(attachmentPlan.kind, "attachments-only");
  assert.equal(attachmentPlan.shouldSendAttachmentNotice, true);
  const textPlan = buildTelegramAgentEndPlan({
    hasTurn: true,
    foldQueuedPromptsIntoHistory: false,
    hasFinalText: true,
    hasQueuedAttachments: false,
  });
  assert.equal(textPlan.kind, "text");
  assert.equal(textPlan.shouldClearPreview, false);
});

test("Agent start runtime consumes dispatched prompts and initializes active preview", () => {
  const events: string[] = [];
  const prompt: PendingTelegramTurn = createQueueTestPromptTurn();
  let queuedItems: TelegramQueueItem[] = [prompt];
  let activeTurn: PendingTelegramTurn | undefined;
  let dispatchPending = true;
  handleTelegramAgentStartRuntime({
    queuedItems,
    hasPendingDispatch: dispatchPending,
    hasActiveTurn: false,
    resetToolExecutions: () => {
      events.push("tools");
    },
    resetPendingModelSwitch: () => {
      events.push("switch");
    },
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push(`items:${items.length}`);
    },
    clearDispatchPending: () => {
      dispatchPending = false;
      events.push("dispatch:false");
    },
    setFoldQueuedPromptsIntoHistory: (fold) => {
      events.push(`fold:${fold}`);
    },
    setActiveTurn: (turn) => {
      activeTurn = turn;
      events.push(`turn:${turn.replyToMessageId}`);
    },
    onPromptHandedOff: (turn) => {
      events.push(`handoff:${turn.replyToMessageId}`);
      throw new Error("journal unavailable");
    },
    recordRuntimeEvent: (category, _error, details) => {
      events.push(`${category}:${details?.phase}`);
    },
    createPreviewState: () => {
      events.push("preview");
    },
    startTypingLoop: () => {
      events.push("typing");
    },
    updateStatus: () => {
      events.push("status");
    },
  });
  assert.equal(dispatchPending, false);
  assert.deepEqual(queuedItems, []);
  assert.equal(activeTurn?.replyToMessageId, 2);
  assert.deepEqual(events, [
    "tools",
    "switch",
    "items:0",
    "dispatch:false",
    "turn:2",
    "handoff:2",
    "queue:prompt-handoff-receipt-settlement",
    "preview",
    "typing",
    "status",
  ]);
});

test("Agent lifecycle hooks bind start, end, and tool lifecycle ports", async () => {
  const events: string[] = [];
  let activeToolExecutions = 0;
  const turn: PendingTelegramTurn = createQueueTestPromptTurn({
    chatId: 7,
    replyToMessageId: 8,
    sourceMessageIds: [8],
    content: [],
    historyText: "turn",
    statusSummary: "turn",
  });
  let activeTurn: PendingTelegramTurn | undefined;
  const hooks = createTelegramAgentLifecycleHooks<
    PendingTelegramTurn,
    string,
    { role: string; content?: unknown[] }
  >({
    setAbortHandler: (ctx) => {
      events.push(`abort:set:${ctx}`);
    },
    getQueuedItems: () => [turn],
    hasPendingDispatch: () => true,
    hasActiveTurn: () => !!activeTurn,
    resetToolExecutions: () => {
      activeToolExecutions = 0;
      events.push("tools:reset");
    },
    resetPendingModelSwitch: () => {
      events.push("switch:reset");
    },
    setQueuedItems: (items) => {
      events.push(`queued:${items.length}`);
    },
    clearDispatchPending: () => {
      events.push("dispatch:clear");
    },
    setFoldQueuedPromptsIntoHistory: (fold) => {
      events.push(`fold:${fold}`);
    },
    setActiveTurn: (nextTurn) => {
      activeTurn = nextTurn;
      events.push(`active:${nextTurn.chatId}`);
    },
    createPreviewState: () => {
      events.push("preview:create");
    },
    startTypingLoop: (ctx) => {
      events.push(`typing:${ctx}`);
    },
    updateStatus: (ctx) => {
      events.push(`status:${ctx}`);
    },
    getActiveTurn: () => activeTurn,
    extractAssistant: () => ({ text: "done" }),
    getFoldQueuedPromptsIntoHistory: () => false,
    resetRuntimeState: () => {
      activeTurn = undefined;
      events.push("runtime:reset");
    },
    dispatchNextQueuedTelegramTurn: (ctx) => {
      events.push(`dispatch:${ctx}`);
    },
    requestDeferredDispatchNextQueuedTelegramTurn: (dispatch) => {
      setTimeout(() => dispatch("ctx"), 0);
    },
    clearPreview: async () => {
      events.push("preview:clear");
    },
    setPreviewPendingText: (text) => {
      events.push(`pending:${text}`);
    },
    finalizeMarkdownPreview: async () => false,
    sendMarkdownReply: async (_chatId, _replyToMessageId, text) => {
      events.push(`markdown:${text}`);
    },
    sendTextReply: async () => {},
    sendQueuedAttachments: async () => {},
    getActiveToolExecutions: () => activeToolExecutions,
    setActiveToolExecutions: (count) => {
      activeToolExecutions = count;
      events.push(`tools:${count}`);
    },
    triggerPendingModelSwitchAbort: (ctx) => {
      events.push(`switch:abort:${ctx}`);
    },
  });
  await hooks.onAgentStart(undefined, "ctx");
  hooks.onToolExecutionStart();
  hooks.onToolExecutionEnd(undefined, "ctx");
  await hooks.onAgentEnd({ messages: [] }, "ctx");
  assert.deepEqual(events, [
    "abort:set:ctx",
    "tools:reset",
    "switch:reset",
    "queued:0",
    "dispatch:clear",
    "active:7",
    "preview:create",
    "typing:ctx",
    "status:ctx",
    "tools:1",
    "tools:0",
    "switch:abort:ctx",
    "runtime:reset",
    "status:ctx",
    "pending:done",
    "preview:clear",
    "markdown:done",
    "pending:",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, [
    "abort:set:ctx",
    "tools:reset",
    "switch:reset",
    "queued:0",
    "dispatch:clear",
    "active:7",
    "preview:create",
    "typing:ctx",
    "status:ctx",
    "tools:1",
    "tools:0",
    "switch:abort:ctx",
    "runtime:reset",
    "status:ctx",
    "pending:done",
    "preview:clear",
    "markdown:done",
    "pending:",
    "dispatch:ctx",
  ]);
});

test("Agent lifecycle retains retryable errors until recovery or settlement", async () => {
  const events: string[] = [];
  const turn = createQueueTestPromptTurn({ chatId: 7, replyToMessageId: 8 });
  let activeTurn: PendingTelegramTurn | undefined = turn;
  const hooks = createTelegramAgentLifecycleHooks<
    PendingTelegramTurn,
    string,
    { result: "error" | "success" }
  >({
    setAbortHandler: () => {},
    getQueuedItems: () => [],
    hasPendingDispatch: () => false,
    hasActiveTurn: () => !!activeTurn,
    resetToolExecutions: () => {},
    resetPendingModelSwitch: () => {},
    setQueuedItems: () => {},
    clearDispatchPending: () => {},
    setFoldQueuedPromptsIntoHistory: () => {},
    setActiveTurn: (nextTurn) => {
      activeTurn = nextTurn;
    },
    createPreviewState: () => {},
    startTypingLoop: () => {},
    updateStatus: () => {},
    getActiveTurn: () => activeTurn,
    extractAssistant: ([message]) =>
      message?.result === "success"
        ? { text: "Recovered answer" }
        : { stopReason: "error", errorMessage: "WebSocket error" },
    getFoldQueuedPromptsIntoHistory: () => false,
    resetRuntimeState: () => {
      activeTurn = undefined;
      events.push("reset");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    requestDeferredDispatchNextQueuedTelegramTurn: (dispatch) => {
      dispatch("ctx");
    },
    clearPreview: async () => {
      events.push("clear");
    },
    setPreviewPendingText: (text) => {
      events.push(`preview:${text}`);
    },
    finalizeMarkdownPreview: async (_chatId, text) => {
      events.push(`final:${text}`);
      return true;
    },
    sendMarkdownReply: async () => {},
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      events.push(`error:${text}`);
    },
    sendQueuedAttachments: async () => {},
    getActiveToolExecutions: () => 0,
    setActiveToolExecutions: () => {},
    triggerPendingModelSwitchAbort: () => {},
    recordRuntimeEvent: (category, _error, details) => {
      events.push(`${category}:${details?.phase}`);
    },
  });

  await hooks.onAgentEnd({ messages: [{ result: "error" }] }, "ctx");
  assert.equal(activeTurn?.replyToMessageId, 8);
  assert.deepEqual(events, ["provider-retry:retained"]);

  await hooks.onAgentEnd({ messages: [{ result: "success" }] }, "ctx");
  assert.equal(activeTurn, undefined);
  assert.deepEqual(events, [
    "provider-retry:retained",
    "provider-retry:recovered",
    "reset",
    "preview:Recovered answer",
    "final:Recovered answer",
    "preview:",
    "dispatch",
  ]);

  activeTurn = turn;
  events.length = 0;
  await hooks.onAgentEnd({ messages: [{ result: "error" }] }, "ctx");
  await hooks.onAgentSettled({}, "ctx");
  assert.equal(activeTurn, undefined);
  assert.deepEqual(events, [
    "provider-retry:retained",
    "provider-retry:settled-failure",
    "reset",
    "clear",
    "error:WebSocket error",
    "dispatch",
  ]);
});

test("Agent start hook binds abort handler and runtime ports", async () => {
  const events: string[] = [];
  const prompt: PendingTelegramTurn = createQueueTestPromptTurn();
  let queuedItems: TelegramQueueItem<{ abort: () => void }>[] = [prompt];
  const hook = createTelegramAgentStartHook<
    PendingTelegramTurn,
    { abort: () => void }
  >({
    setAbortHandler: (ctx) => {
      ctx.abort();
      events.push("abort-handler");
    },
    getQueuedItems: () => queuedItems,
    hasPendingDispatch: () => true,
    hasActiveTurn: () => false,
    resetToolExecutions: () => {
      events.push("tools");
    },
    resetPendingModelSwitch: () => {
      events.push("switch");
    },
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push(`items:${items.length}`);
    },
    clearDispatchPending: () => {
      events.push("dispatch:false");
    },
    setFoldQueuedPromptsIntoHistory: (fold) => {
      events.push(`fold:${fold}`);
    },
    setActiveTurn: (turn) => {
      events.push(`turn:${turn.replyToMessageId}`);
    },
    onPromptHandedOff: (turn) => {
      events.push(`handoff:${turn.replyToMessageId}`);
    },
    createPreviewState: () => {
      events.push("preview");
    },
    startTypingLoop: () => {
      events.push("typing");
    },
    updateStatus: () => {
      events.push("status");
    },
  });
  await hook({}, { abort: () => events.push("abort") });
  assert.deepEqual(events, [
    "abort",
    "abort-handler",
    "tools",
    "switch",
    "items:0",
    "dispatch:false",
    "turn:2",
    "handoff:2",
    "preview",
    "typing",
    "status",
  ]);
});

test("Agent start plan consumes a dispatched prompt and resets transient flags", () => {
  const promptItem: TelegramQueueItem = createQueueTestPromptTurn({
    queueOrder: 2,
    laneOrder: 2,
    historyText: "prompt history",
  });
  const plan = buildTelegramAgentStartPlan({
    queuedItems: [promptItem],
    hasPendingDispatch: true,
    hasActiveTurn: false,
  });
  assert.equal(plan.activeTurn?.statusSummary, "prompt");
  assert.equal(plan.shouldClearDispatchPending, true);
  assert.equal(plan.shouldClearAbortHistory, false);
  assert.equal(plan.shouldResetPendingModelSwitch, true);
  assert.equal(plan.shouldResetToolExecutions, true);
  assert.deepEqual(plan.remainingItems, []);
});

test("Agent start plan clears stale abort-history mode for local prompts", () => {
  const promptItem: TelegramQueueItem = createQueueTestPromptTurn({
    queueOrder: 2,
    laneOrder: 2,
    historyText: "prompt history",
  });
  const plan = buildTelegramAgentStartPlan({
    queuedItems: [promptItem],
    hasPendingDispatch: false,
    hasActiveTurn: false,
  });
  assert.equal(plan.activeTurn, undefined);
  assert.equal(plan.shouldClearDispatchPending, false);
  assert.equal(plan.shouldClearAbortHistory, true);
  assert.deepEqual(plan.remainingItems, [promptItem]);
});

test("Tool execution runtimes update counts and trigger delayed aborts", () => {
  const events: string[] = [];
  let count = 0;
  handleTelegramToolExecutionStartRuntime({
    hasActiveTurn: () => true,
    getActiveToolExecutions: () => count,
    setActiveToolExecutions: (nextCount) => {
      count = nextCount;
      events.push(`count:${nextCount}`);
    },
  });
  handleTelegramToolExecutionEndRuntime({
    hasActiveTurn: () => true,
    getActiveToolExecutions: () => count,
    setActiveToolExecutions: (nextCount) => {
      count = nextCount;
      events.push(`count:${nextCount}`);
    },
    triggerPendingModelSwitchAbort: () => {
      events.push("abort");
    },
  });
  assert.equal(count, 0);
  assert.deepEqual(events, ["count:1", "count:0", "abort"]);
});

test("Tool execution hooks bind counter and pending model-switch abort ports", () => {
  let count = 0;
  const events: string[] = [];
  const hooks = createTelegramToolExecutionHooks<{ id: string }>({
    hasActiveTurn: () => true,
    getActiveToolExecutions: () => count,
    setActiveToolExecutions: (nextCount) => {
      count = nextCount;
      events.push(`count:${nextCount}`);
    },
    triggerPendingModelSwitchAbort: (ctx) => {
      events.push(`abort:${ctx.id}`);
    },
  });
  hooks.onToolExecutionStart();
  hooks.onToolExecutionEnd({}, { id: "ctx" });
  assert.equal(count, 0);
  assert.deepEqual(events, ["count:1", "count:0", "abort:ctx"]);
});

test("Tool execution count helper respects active-turn presence", () => {
  assert.equal(
    getNextTelegramToolExecutionCount({
      hasActiveTurn: true,
      currentCount: 0,
      event: "start",
    }),
    1,
  );
  assert.equal(
    getNextTelegramToolExecutionCount({
      hasActiveTurn: true,
      currentCount: 1,
      event: "end",
    }),
    0,
  );
  assert.equal(
    getNextTelegramToolExecutionCount({
      hasActiveTurn: false,
      currentCount: 3,
      event: "end",
    }),
    3,
  );
});

test("Dispatch readiness checker binds live guard ports", () => {
  let compactionInProgress = false;
  let activeTurn = false;
  let dispatchPending = false;
  const canDispatch = createTelegramDispatchReadinessChecker<{
    idle: boolean;
    pending: boolean;
  }>({
    isCompactionInProgress: () => compactionInProgress,
    hasActiveTurn: () => activeTurn,
    hasDispatchPending: () => dispatchPending,
    isIdle: (ctx) => ctx.idle,
    hasPendingMessages: (ctx) => ctx.pending,
  });
  assert.equal(canDispatch({ idle: true, pending: false }), true);
  dispatchPending = true;
  assert.equal(canDispatch({ idle: true, pending: false }), false);
  dispatchPending = false;
  compactionInProgress = true;
  assert.equal(canDispatch({ idle: true, pending: false }), false);
  compactionInProgress = false;
  activeTurn = true;
  assert.equal(canDispatch({ idle: true, pending: false }), false);
});

test("Dispatch is allowed only when every guard is clear", () => {
  assert.equal(
    canDispatchTelegramTurnState({
      compactionInProgress: false,
      hasActiveTelegramTurn: false,
      hasPendingTelegramDispatch: false,
      isIdle: true,
      hasPendingMessages: false,
    }),
    true,
  );
});

test("Dispatch is blocked during compaction", () => {
  assert.equal(
    canDispatchTelegramTurnState({
      compactionInProgress: true,
      hasActiveTelegramTurn: false,
      hasPendingTelegramDispatch: false,
      isIdle: true,
      hasPendingMessages: false,
    }),
    false,
  );
});

test("Dispatch is blocked while a Telegram turn is active or pending", () => {
  assert.equal(
    canDispatchTelegramTurnState({
      compactionInProgress: false,
      hasActiveTelegramTurn: true,
      hasPendingTelegramDispatch: false,
      isIdle: true,
      hasPendingMessages: false,
    }),
    false,
  );
  assert.equal(
    canDispatchTelegramTurnState({
      compactionInProgress: false,
      hasActiveTelegramTurn: false,
      hasPendingTelegramDispatch: true,
      isIdle: true,
      hasPendingMessages: false,
    }),
    false,
  );
});

test("Dispatch is blocked when pi is busy or has pending messages", () => {
  assert.equal(
    canDispatchTelegramTurnState({
      compactionInProgress: false,
      hasActiveTelegramTurn: false,
      hasPendingTelegramDispatch: false,
      isIdle: false,
      hasPendingMessages: false,
    }),
    false,
  );
  assert.equal(
    canDispatchTelegramTurnState({
      compactionInProgress: false,
      hasActiveTelegramTurn: false,
      hasPendingTelegramDispatch: false,
      isIdle: true,
      hasPendingMessages: true,
    }),
    false,
  );
});

test("Session state applier syncs start and shutdown state through live stores", () => {
  const events: string[] = [];
  const applier = createTelegramSessionStateApplier<string, { id: string }>({
    setQueuedItems: (items) => {
      events.push(`items:${items.join(",")}`);
    },
    setCurrentModel: (model) => {
      events.push(`model:${model?.id ?? "none"}`);
    },
    setPendingModelSwitch: (selection) => {
      events.push(`pending:${selection ?? "none"}`);
    },
    syncCounters: (state) => {
      events.push(`counters:${state.nextQueuedTelegramItemOrder ?? "none"}`);
    },
    syncFlags: (state) => {
      events.push(`flags:${state.telegramTurnDispatchPending}`);
    },
  });
  applier.applyStartState({
    currentTelegramModel: { id: "model" },
    activeTelegramToolExecutions: 0,
    pendingTelegramModelSwitch: undefined,
    nextQueuedTelegramItemOrder: 3,
    nextQueuedTelegramControlOrder: 4,
    telegramTurnDispatchPending: false,
    compactionInProgress: false,
  });
  applier.applyShutdownState({
    queuedTelegramItems: ["a", "b"],
    nextQueuedTelegramItemOrder: 5,
    nextQueuedTelegramControlOrder: 6,
    currentTelegramModel: undefined,
    activeTelegramToolExecutions: 0,
    pendingTelegramModelSwitch: undefined,
    telegramTurnDispatchPending: true,
    compactionInProgress: false,
    foldQueuedPromptsIntoHistory: false,
  });
  assert.deepEqual(events, [
    "model:model",
    "pending:none",
    "counters:3",
    "flags:false",
    "items:a,b",
    "counters:5",
    "flags:true",
    "model:none",
    "pending:none",
  ]);
});

test("Session runtime helper runs shutdown side effects in order", async () => {
  const events: string[] = [];
  await shutdownTelegramSessionRuntime<string>({
    unbindDeferredDispatchContext: () => {
      events.push("unbind");
    },
    discardQueuedItems: () => {
      events.push("discard");
    },
    applyState: (state) => {
      events.push(`state:${state.queuedTelegramItems.length}`);
    },
    clearPendingMediaGroups: () => {
      events.push("media");
    },
    clearModelMenuState: () => {
      events.push("menus");
    },
    getActiveTurnChatId: () => 42,
    clearPreview: async (chatId) => {
      events.push(`preview:${chatId}`);
    },
    clearActiveTurn: () => {
      events.push("turn");
    },
    clearAbort: () => {
      events.push("abort");
    },
    stopPolling: async () => {
      events.push("polling");
    },
  });
  assert.deepEqual(events, [
    "unbind",
    "polling",
    "discard",
    "state:0",
    "media",
    "menus",
    "preview:42",
    "turn",
    "abort",
  ]);
});

test("Session shutdown does not clear replacement state after polling await", async () => {
  const events: string[] = [];
  let active = true;
  await shutdownTelegramSessionRuntime<string>({
    isSessionActive: () => active,
    unbindDeferredDispatchContext: () => events.push("unbind"),
    applyState: () => events.push("state"),
    clearPendingMediaGroups: () => events.push("media"),
    clearModelMenuState: () => events.push("menus"),
    getActiveTurnChatId: () => 42,
    clearPreview: async () => {
      events.push("preview");
    },
    clearActiveTurn: () => events.push("turn"),
    clearAbort: () => events.push("abort"),
    stopPolling: async () => {
      events.push("polling");
      active = false;
    },
  });

  assert.deepEqual(events, ["unbind", "polling"]);
});

test("Session shutdown bounds a stuck preview clear", async () => {
  const events: string[] = [];
  await shutdownTelegramSessionRuntime<string>({
    applyState: () => events.push("state"),
    clearPendingMediaGroups: () => events.push("media"),
    clearModelMenuState: () => events.push("menus"),
    getActiveTurnChatId: () => 42,
    clearPreview: () => new Promise<void>(() => {}),
    previewShutdownTimeoutMs: 5,
    clearActiveTurn: () => events.push("turn"),
    clearAbort: () => events.push("abort"),
    stopPolling: async () => {
      events.push("polling");
    },
  });

  assert.deepEqual(events, [
    "polling",
    "state",
    "media",
    "menus",
    "turn",
    "abort",
  ]);
});

test("Control queue controller appends and dispatches control items", () => {
  const events: string[] = [];
  const execute = async (): Promise<void> => {};
  const item = buildPendingTelegramControlItem({
    chatId: 1,
    replyToMessageId: 2,
    queueOrder: 3,
    laneOrder: 4,
    controlType: "status",
    statusSummary: "status",
    execute,
  });
  const controller = createTelegramControlQueueController<string>({
    appendControlItem: (nextItem, ctx) => {
      events.push(`append:${nextItem.controlType}:${ctx}`);
    },
    dispatchNextQueuedTelegramTurn: (ctx) => {
      events.push(`dispatch:${ctx}`);
    },
  });
  controller.enqueue(item, "ctx", () => {
    events.push("queued");
  });
  assert.deepEqual(events, ["append:status:ctx", "queued", "dispatch:ctx"]);
});

test("Prompt enqueue controller binds runtime ports to context", async () => {
  const events: string[] = [];
  let items: TelegramQueueItem<string>[] = [];
  const controller = createTelegramPromptEnqueueController<number, string>({
    getQueuedItems: () => items,
    setQueuedItems: (nextItems) => {
      items = nextItems;
      events.push(`items:${nextItems.length}`);
    },
    getFoldQueuedPromptsIntoHistory: () => false,
    setFoldQueuedPromptsIntoHistory: (fold) => {
      events.push(`fold:${fold}`);
    },
    createTurn: async ([message]) => ({
      kind: "prompt",
      chatId: 1,
      replyToMessageId: 2,
      queueOrder: message ?? 0,
      queueLane: "default",
      laneOrder: message ?? 0,
      statusSummary: `message ${message}`,
      sourceMessageIds: [message ?? 0],
      queuedAttachments: [],
      content: [{ type: "text", text: String(message) }],
      historyText: "",
    }),
    updateStatus: (ctx) => {
      events.push(`status:${ctx}`);
    },
    dispatchNextQueuedTelegramTurn: (ctx) => {
      events.push(`dispatch:${ctx}`);
    },
  });
  await controller.enqueue([7], "ctx", () => {
    events.push("queued:ctx");
  });
  assert.deepEqual(events, [
    "fold:false",
    "items:1",
    "queued:ctx",
    "status:ctx",
    "dispatch:ctx",
  ]);
});

test("Prompt enqueue runtime folds queued prompts into history", async () => {
  const events: string[] = [];
  const historyPrompt: PendingTelegramTurn = createQueueTestPromptTurn({
    replyToMessageId: 1,
    sourceMessageIds: [1],
    queueLane: "default" as const,
    content: [{ type: "text" as const, text: "history" }],
    historyText: "history",
    statusSummary: "history",
  });
  const controlItem = buildPendingTelegramControlItem({
    chatId: 1,
    replyToMessageId: 2,
    controlType: "status",
    queueOrder: 2,
    laneOrder: 0,
    statusSummary: "control",
    execute: async () => {},
  });
  const newPrompt = {
    ...historyPrompt,
    replyToMessageId: 3,
    sourceMessageIds: [3],
    queueOrder: 3,
    laneOrder: 3,
    historyText: "new",
    statusSummary: "new",
  };
  let queuedItems: TelegramQueueItem[] = [historyPrompt, controlItem];
  let foldHistory = true;
  await enqueueTelegramPromptTurnRuntime(["message"], {
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push(`items:${items.map((item) => item.statusSummary).join(",")}`);
    },
    getFoldQueuedPromptsIntoHistory: () => foldHistory,
    setFoldQueuedPromptsIntoHistory: (fold) => {
      foldHistory = fold;
      events.push(`fold:${fold}`);
    },
    createTurn: async (_messages, historyTurns) => {
      events.push(
        `history:${historyTurns.map((turn) => turn.historyText).join(",")}`,
      );
      return newPrompt;
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    onQueued: () => {
      events.push("queued");
    },
  });
  assert.equal(foldHistory, false);
  assert.deepEqual(
    queuedItems.map((item) => item.statusSummary),
    ["control", "new"],
  );
  assert.deepEqual(events, [
    "fold:false",
    "history:history",
    "items:control,new",
    "queued",
    "status",
    "dispatch",
  ]);
});

test("Prompt enqueue rechecks execution authority after asynchronous turn building", async () => {
  const queuedItems: TelegramQueueItem[] = [];
  let committedItems = 0;
  let current = true;
  await assert.rejects(
    enqueueTelegramPromptTurnRuntime(["message"], {
      getQueuedItems: () => queuedItems,
      setQueuedItems: () => {
        committedItems += 1;
      },
      getFoldQueuedPromptsIntoHistory: () => false,
      setFoldQueuedPromptsIntoHistory: () => {},
      createTurn: async () => {
        current = false;
        return createQueueTestPromptTurn({
          replyToMessageId: 1,
          sourceMessageIds: [1],
          content: [{ type: "text", text: "stale" }],
          historyText: "stale",
          statusSummary: "stale",
        });
      },
      assertExecutionCurrent() {
        if (!current) throw new DOMException("Aborted", "AbortError");
      },
      updateStatus: () => {},
      dispatchNextQueuedTelegramTurn: () => {},
    }),
    /Abort/u,
  );
  assert.equal(committedItems, 0);
  assert.deepEqual(queuedItems, []);
});

test("Local agent start prevents stale abort-history mode from absorbing old queue", async () => {
  const events: string[] = [];
  const oldPrompt: PendingTelegramTurn = createQueueTestPromptTurn({
    replyToMessageId: 1,
    sourceMessageIds: [1],
    queueOrder: 1,
    laneOrder: 1,
    content: [{ type: "text", text: "old" }],
    historyText: "old",
    statusSummary: "old",
  });
  const newPrompt: PendingTelegramTurn = createQueueTestPromptTurn({
    replyToMessageId: 2,
    sourceMessageIds: [2],
    queueOrder: 2,
    laneOrder: 2,
    content: [{ type: "text", text: "new" }],
    historyText: "new",
    statusSummary: "new",
  });
  let queuedItems: TelegramQueueItem[] = [oldPrompt];
  let foldHistory = true;
  handleTelegramAgentStartRuntime({
    queuedItems,
    hasPendingDispatch: false,
    hasActiveTurn: false,
    resetToolExecutions: () => {},
    resetPendingModelSwitch: () => {},
    setQueuedItems: (items) => {
      queuedItems = items;
    },
    clearDispatchPending: () => {},
    setFoldQueuedPromptsIntoHistory: (fold) => {
      foldHistory = fold;
      events.push(`fold:${fold}`);
    },
    setActiveTurn: () => {},
    createPreviewState: () => {},
    startTypingLoop: () => {},
    updateStatus: () => {},
  });
  await enqueueTelegramPromptTurnRuntime(["message"], {
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push(`items:${items.map((item) => item.statusSummary).join(",")}`);
    },
    getFoldQueuedPromptsIntoHistory: () => foldHistory,
    setFoldQueuedPromptsIntoHistory: (fold) => {
      foldHistory = fold;
      events.push(`fold:${fold}`);
    },
    createTurn: async (_messages, historyTurns) => {
      events.push(`history:${historyTurns.length}`);
      return newPrompt;
    },
    updateStatus: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
  });
  assert.equal(foldHistory, false);
  assert.deepEqual(
    queuedItems.map((item) => item.statusSummary),
    ["old", "new"],
  );
  assert.deepEqual(events, [
    "fold:false",
    "fold:false",
    "history:0",
    "items:old,new",
  ]);
});

test("Control runtime runs the control item and always settles", async () => {
  const events: string[] = [];
  await executeTelegramControlItemRuntime(
    {
      kind: "control",
      controlType: "status",
      chatId: 1,
      replyToMessageId: 2,
      queueOrder: 1,
      queueLane: "control",
      laneOrder: 0,
      statusSummary: "status",
      execute: async () => {
        events.push("execute");
      },
    },
    {
      ctx: {},
      sendTextReply: async () => {
        events.push("reply");
        return undefined;
      },
      onSettled: (item) => {
        events.push(`settled:${item.controlType}`);
      },
    },
  );
  assert.deepEqual(events, ["execute", "settled:status"]);
});

test("Control runtime reports failures before settling", async () => {
  const events: string[] = [];
  await executeTelegramControlItemRuntime(
    {
      kind: "control",
      controlType: "model",
      chatId: 3,
      replyToMessageId: 4,
      queueOrder: 2,
      queueLane: "control",
      laneOrder: 1,
      statusSummary: "model",
      execute: async () => {
        throw new Error("boom");
      },
    },
    {
      ctx: {},
      sendTextReply: async (_chatId, _replyToMessageId, text) => {
        events.push(text);
        return undefined;
      },
      recordRuntimeEvent: (category, error, details) => {
        const message = error instanceof Error ? error.message : String(error);
        events.push(`${category}:${message}:${details?.controlType}`);
      },
      onSettled: (item) => {
        events.push(`settled:${item.controlType}`);
      },
    },
  );
  assert.deepEqual(events, [
    "control:boom:model",
    "Telegram control action failed: boom",
    "settled:model",
  ]);
});

test("Deferred queue dispatch uses only the bound session context", () => {
  const events: string[] = [];
  const callbacks: Array<() => void> = [];
  const clearedTimers: number[] = [];
  const runtime = createTelegramDeferredQueueDispatchRuntime<{ id: string }>({
    setTimer: (callback) => {
      callbacks.push(callback);
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      clearedTimers.push(timer as unknown as number);
    },
  });
  runtime.request((ctx) => {
    events.push(`dispatch:${ctx.id}`);
  });
  assert.equal(callbacks.length, 0);
  runtime.bind({ id: "old" });
  runtime.request((ctx) => {
    events.push(`dispatch:${ctx.id}`);
  });
  runtime.unbind();
  callbacks[0]?.();
  runtime.bind({ id: "new" });
  runtime.request((ctx) => {
    events.push(`dispatch:${ctx.id}`);
  });
  callbacks[1]?.();
  assert.deepEqual(clearedTimers, [1]);
  assert.deepEqual(events, ["dispatch:new"]);
});

test("Deferred dispatch and watchdog contain callback and diagnostic failure", () => {
  let deferredCallback: (() => void) | undefined;
  const deferred = createTelegramDeferredQueueDispatchRuntime<string>({
    setTimer(callback) {
      deferredCallback = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    recordRuntimeEvent() {
      throw new Error("diagnostic failed");
    },
  });
  deferred.bind("ctx");
  deferred.request(() => {
    throw new Error("dispatch failed");
  });
  assert.doesNotThrow(() => deferredCallback?.());

  const watchdog = createTelegramQueueDispatchWatchdogRuntime<string>({
    hasQueuedItems: () => true,
    dispatchNextQueuedTelegramTurn() {
      throw new Error("watchdog dispatch failed");
    },
    recordRuntimeEvent() {
      throw new Error("watchdog diagnostic failed");
    },
  });
  assert.doesNotThrow(() => watchdog.poke());
  watchdog.stop();
});

test("Queue dispatch watchdog retries dispatch for queued work", () => {
  const events: string[] = [];
  let hasQueuedItems = false;
  let intervalCallback: (() => void) | undefined;
  const watchdog = createTelegramQueueDispatchWatchdogRuntime<{ id: string }>({
    hasQueuedItems: () => hasQueuedItems,
    dispatchNextQueuedTelegramTurn: (ctx) => {
      events.push(`dispatch:${ctx.id}`);
    },
    setInterval: (callback) => {
      intervalCallback = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {
      events.push("clear");
    },
  });
  watchdog.start({ id: "ctx" });
  assert.deepEqual(events, []);
  hasQueuedItems = true;
  watchdog.poke();
  intervalCallback?.();
  assert.deepEqual(events, ["dispatch:ctx", "dispatch:ctx"]);
  watchdog.stop();
  assert.deepEqual(events, ["dispatch:ctx", "dispatch:ctx", "clear"]);
});

test("Dispatch controller skips inactive stale contexts before readiness checks", () => {
  const events: string[] = [];
  const controller = createTelegramQueueDispatchController<string>({
    getQueuedItems: () => {
      events.push("unexpected:items");
      return [];
    },
    setQueuedItems: () => {
      events.push("unexpected:set");
    },
    canDispatch: () => {
      events.push("unexpected:can-dispatch");
      return true;
    },
    hasDispatchContext: () => false,
    updateStatus: () => {
      events.push("unexpected:status");
    },
    sendTextReply: async () => undefined,
    onPromptDispatchStart: () => {},
    sendUserMessage: () => {},
    onPromptDispatchFailure: () => {},
  });
  controller.dispatchNext("stale");
  assert.deepEqual(events, []);
});

test("Dispatch controller drops stale transport work before sending the next prompt", () => {
  const stale = createQueueTestPromptTurn({ chatId: 1, replyToMessageId: 11 });
  stale.transportStamp = { profile: "a", generation: "epoch-a" };
  const current = createQueueTestPromptTurn({
    chatId: 2,
    replyToMessageId: 22,
  });
  current.transportStamp = { profile: "b", generation: "epoch-b" };
  let items: TelegramQueueItem<string>[] = [stale, current];
  const sent: number[] = [];
  const controller = createTelegramQueueDispatchController<string>({
    getQueuedItems: () => items,
    setQueuedItems: (next) => {
      items = next;
    },
    canDispatch: () => true,
    isQueueItemTransportActive: (item) =>
      item.transportStamp?.profile === "b" &&
      item.transportStamp.generation === "epoch-b",
    updateStatus: () => {},
    sendTextReply: async () => undefined,
    onPromptDispatchStart: (_ctx, chatId) => sent.push(chatId),
    sendUserMessage: () => {},
    onPromptDispatchFailure: () => {},
  });

  controller.dispatchNext("ctx");

  assert.deepEqual(sent, [2]);
  assert.deepEqual(items, [current]);
});

test("Dispatch preserves inactive durable work while sending current transport work", () => {
  const stale = createQueueTestPromptTurn({
    chatId: 1,
    replyToMessageId: 11,
    admissionReceipts: [
      {
        queueKind: "prompt",
        receiptId: "stale-receipt",
        sourceUpdateIds: [101],
      },
    ],
  });
  stale.transportStamp = { profile: "a", generation: "epoch-a" };
  const current = createQueueTestPromptTurn({
    chatId: 2,
    replyToMessageId: 22,
  });
  current.transportStamp = { profile: "b", generation: "epoch-b" };
  let items: TelegramQueueItem<string>[] = [stale, current];
  const sent: number[] = [];
  const controller = createTelegramQueueDispatchController<string>({
    getQueuedItems: () => items,
    setQueuedItems: (next) => {
      items = next;
    },
    canDispatch: () => true,
    isQueueItemTransportActive: (item) =>
      item.transportStamp?.profile === "b" &&
      item.transportStamp.generation === "epoch-b",
    isQueueItemAdmissionReady: () => true,
    updateStatus: () => {},
    sendTextReply: async () => undefined,
    onPromptDispatchStart: (_ctx, chatId) => sent.push(chatId),
    sendUserMessage: () => {},
    onPromptDispatchFailure: () => {},
  });

  controller.dispatchNext("ctx");

  assert.deepEqual(sent, [2]);
  assert.deepEqual(items, [current, stale]);
});

test("Dispatch runtime idles on none and executes control items directly", () => {
  const events: string[] = [];
  executeTelegramQueueDispatchPlan(
    { kind: "none", remainingItems: [] },
    {
      executeControlItem: () => {
        events.push("control");
      },
      onPromptDispatchStart: () => {
        events.push("prompt-start");
      },
      sendUserMessage: () => {
        events.push("prompt");
      },
      onPromptDispatchFailure: (message) => {
        events.push(`error:${message}`);
      },
      onIdle: () => {
        events.push("idle");
      },
    },
  );
  executeTelegramQueueDispatchPlan(
    {
      kind: "control",
      item: {
        kind: "control",
        controlType: "status",
        chatId: 1,
        replyToMessageId: 1,
        queueOrder: 1,
        queueLane: "control",
        laneOrder: 0,
        statusSummary: "status",
        execute: async () => {},
      },
      remainingItems: [],
    },
    {
      executeControlItem: () => {
        events.push("control");
      },
      onPromptDispatchStart: () => {
        events.push("prompt-start");
      },
      sendUserMessage: () => {
        events.push("prompt");
      },
      onPromptDispatchFailure: (message) => {
        events.push(`error:${message}`);
      },
      onIdle: () => {
        events.push("idle");
      },
    },
  );
  assert.deepEqual(events, ["idle", "control"]);
});

test("Dispatch runtime sends prompt turns as normal user messages", () => {
  const events: string[] = [];
  executeTelegramQueueDispatchPlan(
    {
      kind: "prompt",
      item: {
        kind: "prompt",
        chatId: 2,
        replyToMessageId: 3,
        sourceMessageIds: [3],
        queueOrder: 2,
        queueLane: "default",
        laneOrder: 2,
        queuedAttachments: [],
        content: [{ type: "text", text: "prompt" }],
        historyText: "prompt",
        statusSummary: "prompt",
      },
      remainingItems: [],
    },
    {
      executeControlItem: () => {
        events.push("control");
      },
      onPromptDispatchStart: (chatId) => {
        events.push(`start:${chatId}`);
      },
      sendUserMessage: (_content, options) => {
        events.push(`send:${options?.deliverAs ?? "default"}`);
      },
      onPromptDispatchFailure: (message) => {
        events.push(`error:${message}`);
      },
      onIdle: () => {
        events.push("idle");
      },
    },
  );
  assert.deepEqual(events, ["start:2", "send:default"]);
});

test("Dispatch runtime commits durable prompt authority before model dispatch", () => {
  const events: string[] = [];
  executeTelegramQueueDispatchPlan(
    {
      kind: "prompt",
      item: {
        kind: "prompt",
        chatId: 2,
        replyToMessageId: 3,
        sourceMessageIds: [3],
        queueOrder: 2,
        queueLane: "default",
        laneOrder: 2,
        queuedAttachments: [],
        content: [{ type: "text", text: "prompt" }],
        historyText: "prompt",
        statusSummary: "prompt",
      },
      remainingItems: [],
    },
    {
      executeControlItem: () => {},
      onPromptDispatchStart: () => events.push("start"),
      commitPromptDispatch: () => {
        events.push("commit");
        return false;
      },
      sendUserMessage: () => events.push("send"),
      onPromptDispatchFailure: (message) => events.push(`error:${message}`),
      onIdle: () => {},
    },
  );
  assert.deepEqual(events, [
    "start",
    "commit",
    "error:Telegram prompt dispatch could not be committed durably.",
  ]);
});

test("Dispatch runtime reports send failures after durable commitment", () => {
  const events: string[] = [];
  executeTelegramQueueDispatchPlan(
    {
      kind: "prompt",
      item: {
        kind: "prompt",
        chatId: 2,
        replyToMessageId: 3,
        sourceMessageIds: [3],
        queueOrder: 2,
        queueLane: "default",
        laneOrder: 2,
        queuedAttachments: [],
        content: [{ type: "text", text: "prompt" }],
        historyText: "prompt",
        statusSummary: "prompt",
      },
      remainingItems: [],
    },
    {
      executeControlItem: () => {
        events.push("control");
      },
      onPromptDispatchStart: (chatId) => {
        events.push(`start:${chatId}`);
      },
      commitPromptDispatch: () => {
        events.push("commit");
        return true;
      },
      sendUserMessage: () => {
        throw new Error("boom");
      },
      onPromptDispatchFailure: (message) => {
        events.push(`error:${message}`);
      },
      onIdle: () => {
        events.push("idle");
      },
    },
  );
  assert.deepEqual(events, ["start:2", "commit", "error:boom"]);
});

test("Queue dispatch controller plans prompts and reports dispatch failures", () => {
  const events: string[] = [];
  let queuedItems: TelegramQueueItem<string>[] = [
    {
      kind: "prompt",
      chatId: 2,
      replyToMessageId: 3,
      sourceMessageIds: [3],
      queueOrder: 2,
      queueLane: "default",
      laneOrder: 2,
      queuedAttachments: [],
      content: [{ type: "text", text: "prompt" }],
      historyText: "prompt",
      statusSummary: "prompt",
    },
  ];
  const controller = createTelegramQueueDispatchController<string>({
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push(`items:${items.length}`);
    },
    canDispatch: () => true,
    updateStatus: (_ctx, error) => {
      events.push(`status:${error ?? "ok"}`);
    },
    sendTextReply: async () => undefined,
    onPromptDispatchStart: (_ctx, chatId) => {
      events.push(`start:${chatId}`);
    },
    sendUserMessage: () => {
      throw new Error("boom");
    },
    onPromptDispatchFailure: (_ctx, message) => {
      events.push(`failure:${message}`);
    },
  });
  controller.dispatchNext("ctx");
  assert.deepEqual(events, ["items:1", "start:2", "failure:boom"]);
  assert.equal(queuedItems.length, 1);
});

test("Queue dispatch waits for durable admission without dropping the head item", () => {
  const events: string[] = [];
  let ready = false;
  let queuedItems: TelegramQueueItem<string>[] = [
    createQueueTestPromptTurn({
      admissionReceipts: [
        {
          queueKind: "prompt",
          receiptId: "receipt-1",
          sourceUpdateIds: [1],
        },
      ],
    }),
  ];
  const controller = createTelegramQueueDispatchController<string>({
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push(`items:${items.length}`);
    },
    canDispatch: () => true,
    isQueueItemAdmissionReady: (item) =>
      isTelegramQueueItemDurablyAdmitted(item, () => ready),
    updateStatus: () => events.push("status"),
    sendTextReply: async () => undefined,
    onPromptDispatchStart: () => events.push("start"),
    sendUserMessage: () => events.push("send"),
    onPromptDispatchFailure: () => events.push("failure"),
  });

  controller.dispatchNext("ctx");
  assert.equal(queuedItems.length, 1);
  assert.deepEqual(events, ["status"]);
  ready = true;
  controller.dispatchNext("ctx");
  assert.deepEqual(events, ["status", "items:1", "start", "send"]);
});

test("Queue dispatch retains reaction-suppressed prompts until their turn, then drops them", () => {
  const events: string[] = [];
  let canDispatch = false;
  let queuedItems: TelegramQueueItem<string>[] = [
    createQueueTestPromptTurn({
      sourceMessageIds: [10],
      queueOrder: 1,
      laneOrder: 1,
      statusSummary: "priority-suppressed",
      queueLane: "priority",
      priorityEmoji: "👍",
      reactionSuppressionEmoji: "💩",
    }),
    createQueueTestPromptTurn({
      sourceMessageIds: [20],
      queueOrder: 2,
      laneOrder: 2,
      statusSummary: "ready",
    }),
  ];
  const controller = createTelegramQueueDispatchController<string>({
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
    },
    canDispatch: () => canDispatch,
    onPromptSkipped: (item) => {
      events.push(`skip:${item.statusSummary}`);
      return true;
    },
    updateStatus: () => events.push("status"),
    sendTextReply: async () => undefined,
    onPromptDispatchStart: () => events.push("start"),
    sendUserMessage: (content) => {
      canDispatch = false;
      events.push(`send:${content[0]?.type}`);
    },
    onPromptDispatchFailure: () => events.push("failure"),
  });

  controller.dispatchNext("ctx");
  assert.deepEqual(events, ["status"]);
  assert.deepEqual(
    queuedItems.map((item) => item.statusSummary),
    ["priority-suppressed", "ready"],
  );

  canDispatch = true;
  controller.dispatchNext("ctx");
  assert.deepEqual(events, [
    "status",
    "skip:priority-suppressed",
    "start",
    "send:text",
  ]);
  assert.deepEqual(
    queuedItems.map((item) => item.statusSummary),
    ["ready"],
  );
  controller.dispatchNext("ctx");
  assert.deepEqual(events, [
    "status",
    "skip:priority-suppressed",
    "start",
    "send:text",
    "status",
  ]);
});

test("Queue dispatch retains a skipped head when durable settlement fails", () => {
  const events: string[] = [];
  let queuedItems: TelegramQueueItem<string>[] = [
    createQueueTestPromptTurn({ reactionSuppressionEmoji: "👎" }),
  ];
  const controller = createTelegramQueueDispatchController<string>({
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push(`items:${items.length}`);
    },
    canDispatch: () => true,
    onPromptSkipped: () => false,
    updateStatus: (_ctx, error) => events.push(error ?? "status"),
    sendTextReply: async () => undefined,
    onPromptDispatchStart: () => events.push("start"),
    sendUserMessage: () => events.push("send"),
    onPromptDispatchFailure: () => events.push("failure"),
  });

  controller.dispatchNext("ctx");
  assert.equal(queuedItems.length, 1);
  assert.deepEqual(events, [
    "Telegram skipped prompt could not be settled durably.",
  ]);
});

test("Queue dispatch removes each settled Skip before a later Skip fails", () => {
  const first = createQueueTestPromptTurn({
    replyToMessageId: 1,
    statusSummary: "first",
    reactionSuppressionEmoji: "👎",
  });
  const second = createQueueTestPromptTurn({
    replyToMessageId: 2,
    statusSummary: "second",
    reactionSuppressionEmoji: "👎",
  });
  let queuedItems: TelegramQueueItem<string>[] = [first, second];
  const controller = createTelegramQueueDispatchController<string>({
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
    },
    canDispatch: () => true,
    onPromptSkipped: (item) => item.statusSummary === "first",
    updateStatus: () => {},
    sendTextReply: async () => undefined,
    onPromptDispatchStart: () => {},
    sendUserMessage: () => {},
    onPromptDispatchFailure: () => {},
  });

  controller.dispatchNext("ctx");
  assert.deepEqual(queuedItems, [second]);
});

test("Queue dispatch contains thrown Skip settlement failures", () => {
  const item = createQueueTestPromptTurn({ reactionSuppressionEmoji: "👎" });
  let queuedItems: TelegramQueueItem<string>[] = [item];
  const events: string[] = [];
  const controller = createTelegramQueueDispatchController<string>({
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
    },
    canDispatch: () => true,
    onPromptSkipped: () => {
      throw new Error("journal publication failed");
    },
    updateStatus: (_ctx, error) => events.push(error ?? "status"),
    sendTextReply: async () => undefined,
    onPromptDispatchStart: () => {},
    sendUserMessage: () => {},
    onPromptDispatchFailure: () => {},
    recordRuntimeEvent: (_category, error) => {
      events.push(error instanceof Error ? error.message : String(error));
    },
  });

  assert.doesNotThrow(() => controller.dispatchNext("ctx"));
  assert.deepEqual(queuedItems, [item]);
  assert.deepEqual(events, [
    "journal publication failed",
    "Telegram skipped prompt could not be settled durably.",
  ]);
});

test("Queue dispatch clears a suppressed final item without a model turn", () => {
  const events: string[] = [];
  let queuedItems: TelegramQueueItem<string>[] = [
    createQueueTestPromptTurn({ reactionSuppressionEmoji: "👎" }),
  ];
  const controller = createTelegramQueueDispatchController<string>({
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push(`items:${items.length}`);
    },
    canDispatch: () => true,
    updateStatus: () => events.push("status"),
    sendTextReply: async () => undefined,
    onPromptDispatchStart: () => events.push("start"),
    sendUserMessage: () => events.push("send"),
    onPromptDispatchFailure: () => events.push("failure"),
  });

  controller.dispatchNext("ctx");
  assert.deepEqual(events, ["items:0", "status"]);
  assert.equal(formatQueuedTelegramItemsStatus(queuedItems), "");
});

test("Queue dispatch waits for earlier pending inbound queue mutations", () => {
  const events: string[] = [];
  let pending = true;
  let queuedItems: TelegramQueueItem<string>[] = [createQueueTestPromptTurn()];
  const controller = createTelegramQueueDispatchController<string>({
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push(`items:${items.length}`);
    },
    canDispatch: () => true,
    hasPendingInboundQueueMutationForItem: () => pending,
    updateStatus: () => events.push("status"),
    sendTextReply: async () => undefined,
    onPromptDispatchStart: () => events.push("start"),
    sendUserMessage: () => events.push("send"),
    onPromptDispatchFailure: () => events.push("failure"),
  });

  controller.dispatchNext("ctx");
  assert.deepEqual(events, ["status"]);
  pending = false;
  controller.dispatchNext("ctx");
  assert.deepEqual(events, ["status", "items:1", "start", "send"]);
});

test("Queue dispatch scopes unresolved reaction dependencies to the governed item", () => {
  const events: string[] = [];
  let dependencyPending = true;
  let queuedItems: TelegramQueueItem<string>[] = [
    createQueueTestPromptTurn({
      replyToMessageId: 20,
      sourceMessageIds: [20],
      queueOrder: 1,
      laneOrder: 1,
      statusSummary: "independent",
    }),
    createQueueTestPromptTurn({
      replyToMessageId: 10,
      sourceMessageIds: [10],
      queueOrder: 2,
      laneOrder: 2,
      statusSummary: "governed",
    }),
  ];
  const controller = createTelegramQueueDispatchController<string>({
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push(`items:${items.length}`);
    },
    canDispatch: () => true,
    hasPendingInboundQueueMutationForItem: (item) =>
      dependencyPending &&
      item.kind === "prompt" &&
      item.sourceMessageIds.includes(10),
    updateStatus: () => events.push("status"),
    sendTextReply: async () => undefined,
    onPromptDispatchStart: (_ctx, chatId) =>
      events.push(`start:${chatId}`),
    sendUserMessage: () => events.push("send"),
    onPromptDispatchFailure: () => events.push("failure"),
  });

  controller.dispatchNext("ctx");
  assert.deepEqual(events, ["items:2", "start:1", "send"]);
  queuedItems = queuedItems.slice(1);
  controller.dispatchNext("ctx");
  assert.deepEqual(events, ["items:2", "start:1", "send", "status"]);
  dependencyPending = false;
  controller.dispatchNext("ctx");
  assert.deepEqual(events, [
    "items:2",
    "start:1",
    "send",
    "status",
    "items:1",
    "start:1",
    "send",
  ]);
});

test("Queue dispatch runtime binds readiness guards to dispatch controller", () => {
  const events: string[] = [];
  let active = true;
  let queuedItems: TelegramQueueItem<string>[] = [
    {
      kind: "prompt",
      chatId: 2,
      replyToMessageId: 3,
      sourceMessageIds: [3],
      queueOrder: 2,
      queueLane: "default",
      laneOrder: 2,
      queuedAttachments: [],
      content: [{ type: "text", text: "prompt" }],
      historyText: "prompt",
      statusSummary: "prompt",
    },
  ];
  const controller = createTelegramQueueDispatchRuntime<string>({
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push(`items:${items.length}`);
    },
    isCompactionInProgress: () => false,
    hasActiveTurn: () => active,
    hasDispatchPending: () => false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    updateStatus: (_ctx, error) => {
      events.push(`status:${error ?? "ok"}`);
    },
    sendTextReply: async () => undefined,
    onPromptDispatchStart: (_ctx, chatId) => {
      events.push(`start:${chatId}`);
    },
    sendUserMessage: () => {
      events.push("send");
    },
    onPromptDispatchFailure: () => {
      events.push("unexpected:failure");
    },
  });
  controller.dispatchNext("ctx");
  active = false;
  controller.dispatchNext("ctx");
  assert.deepEqual(events, ["status:ok", "items:1", "start:2", "send"]);
});

test("Queue dispatch controller executes control items and continues", async () => {
  const events: string[] = [];
  let queuedItems: TelegramQueueItem<string>[] = [
    {
      kind: "control",
      controlType: "status",
      chatId: 1,
      replyToMessageId: 2,
      queueOrder: 1,
      queueLane: "control",
      laneOrder: 1,
      statusSummary: "control",
      execute: async (ctx) => {
        events.push(`control:${ctx}`);
      },
    },
    {
      kind: "prompt",
      chatId: 3,
      replyToMessageId: 4,
      sourceMessageIds: [4],
      queueOrder: 2,
      queueLane: "default",
      laneOrder: 2,
      queuedAttachments: [],
      content: [{ type: "text", text: "prompt" }],
      historyText: "prompt",
      statusSummary: "prompt",
    },
  ];
  const controller = createTelegramQueueDispatchController<string>({
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push(`items:${items.length}`);
    },
    canDispatch: () => true,
    updateStatus: (_ctx, error) => {
      events.push(`status:${error ?? "ok"}`);
    },
    sendTextReply: async () => undefined,
    onPromptDispatchStart: (_ctx, chatId) => {
      events.push(`start:${chatId}`);
    },
    onControlSettled: (item, ctx) => {
      events.push(`settled:${item.controlType}:${ctx}`);
    },
    sendUserMessage: () => {
      events.push("send");
    },
    onPromptDispatchFailure: () => {
      events.push("unexpected:failure");
    },
  });
  controller.dispatchNext("ctx");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    "items:1",
    "status:ok",
    "control:ctx",
    "settled:status:ctx",
    "status:ok",
    "items:1",
    "start:3",
    "send",
  ]);
});

test("Queue dispatch controller blocks reentrant prompt dispatch while control is pending", async () => {
  const events: string[] = [];
  let releaseControl: () => void = () => {};
  const controlSettled = new Promise<void>((resolve) => {
    releaseControl = resolve;
  });
  let queuedItems: TelegramQueueItem<string>[] = [
    createQueueTestControlItem<string>({
      queueOrder: 1,
      laneOrder: 1,
      execute: async (ctx) => {
        events.push(`control:start:${ctx}`);
        await controlSettled;
        events.push("control:end");
      },
    }),
  ];
  const prompt = createQueueTestPromptTurn({
    chatId: 3,
    replyToMessageId: 4,
    sourceMessageIds: [4],
    queueOrder: 2,
    laneOrder: 2,
  });
  const controller = createTelegramQueueDispatchController<string>({
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push(`items:${items.length}`);
    },
    canDispatch: () => true,
    updateStatus: (_ctx, error) => {
      events.push(`status:${error ?? "ok"}`);
    },
    sendTextReply: async () => undefined,
    onPromptDispatchStart: (_ctx, chatId) => {
      events.push(`start:${chatId}`);
    },
    sendUserMessage: () => {
      events.push("send");
    },
    onPromptDispatchFailure: () => {
      events.push("unexpected:failure");
    },
  });
  controller.dispatchNext("ctx");
  queuedItems = [prompt];
  controller.dispatchNext("ctx");
  assert.equal(events.includes("send"), false);
  releaseControl();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    "items:0",
    "status:ok",
    "control:start:ctx",
    "status:ok",
    "control:end",
    "status:ok",
    "items:1",
    "start:3",
    "send",
  ]);
});

test("Queue dispatch controller does not resume prompts after shutdown clears context during control", async () => {
  const events: string[] = [];
  let dispatchContextActive = true;
  let releaseControl: () => void = () => {};
  const controlSettled = new Promise<void>((resolve) => {
    releaseControl = resolve;
  });
  let queuedItems: TelegramQueueItem<string>[] = [
    createQueueTestControlItem<string>({
      queueOrder: 1,
      laneOrder: 1,
      execute: async () => {
        events.push("control:start");
        await controlSettled;
        events.push("control:end");
      },
    }),
    createQueueTestPromptTurn({
      chatId: 3,
      replyToMessageId: 4,
      sourceMessageIds: [4],
      queueOrder: 2,
      laneOrder: 2,
    }),
  ];
  const controller = createTelegramQueueDispatchController<string>({
    hasDispatchContext: () => dispatchContextActive,
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push(`items:${items.length}`);
    },
    canDispatch: () => true,
    updateStatus: (_ctx, error) => {
      events.push(`status:${error ?? "ok"}`);
    },
    sendTextReply: async () => undefined,
    onPromptDispatchStart: (_ctx, chatId) => {
      events.push(`start:${chatId}`);
    },
    sendUserMessage: () => {
      events.push("send");
    },
    onPromptDispatchFailure: () => {
      events.push("unexpected:failure");
    },
  });
  controller.dispatchNext("ctx");
  dispatchContextActive = false;
  queuedItems = [];
  releaseControl();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    "items:1",
    "status:ok",
    "control:start",
    "control:end",
  ]);
});

test("Queue dispatch controller fences old control settlement after session replacement", async () => {
  const events: string[] = [];
  let releaseControl: () => void = () => {};
  const controlSettled = new Promise<void>((resolve) => {
    releaseControl = resolve;
  });
  let queuedItems: TelegramQueueItem<string>[] = [
    createQueueTestControlItem<string>({
      execute: async (ctx) => {
        events.push(`control:start:${ctx}`);
        await controlSettled;
        events.push("control:end");
      },
    }),
  ];
  const deferredDispatch = createTelegramDeferredQueueDispatchRuntime<string>();
  deferredDispatch.bind("old");
  const controller = createTelegramQueueDispatchController<string>({
    hasDispatchContext: deferredDispatch.isBound,
    getDispatchGeneration: deferredDispatch.getGeneration,
    isDispatchGenerationActive: deferredDispatch.isGenerationActive,
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push(`items:${items.length}`);
    },
    canDispatch: () => true,
    updateStatus: (ctx) => {
      events.push(`status:${ctx}`);
    },
    sendTextReply: async () => undefined,
    onPromptDispatchStart: (ctx, chatId) => {
      events.push(`start:${ctx}:${chatId}`);
    },
    sendUserMessage: () => {
      events.push("send");
    },
    onPromptDispatchFailure: () => {
      events.push("unexpected:failure");
    },
  });

  controller.dispatchNext("old");
  deferredDispatch.unbind();
  deferredDispatch.bind("new");
  queuedItems = [createQueueTestPromptTurn({ chatId: 3 })];
  releaseControl();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [
    "items:0",
    "status:old",
    "control:start:old",
    "control:end",
  ]);

  controller.dispatchNext("new");
  assert.deepEqual(events.slice(-3), ["items:1", "start:new:3", "send"]);
});

test("Session runtime helper resets session start state", () => {
  const currentModel = createQueueTestModel();
  const state = buildTelegramSessionStartState(currentModel);
  assert.equal(state.currentTelegramModel, currentModel);
  assert.equal(state.activeTelegramToolExecutions, 0);
  assert.equal(state.nextQueuedTelegramItemOrder, 0);
  assert.equal(state.nextQueuedTelegramControlOrder, 0);
  assert.equal(state.telegramTurnDispatchPending, false);
  assert.equal(state.compactionInProgress, false);
});

test("Session runtime helper runs start side effects in order", async () => {
  const events: string[] = [];
  const currentModel = createQueueTestModel();
  await startTelegramSessionRuntime({
    ctx: "ctx",
    currentModel,
    loadConfig: async () => {
      events.push("load");
    },
    applyState: (state) => {
      events.push(`state:${state.currentTelegramModel?.id}`);
    },
    bindDeferredDispatchContext: (ctx) => {
      events.push(`bind:${ctx}`);
    },
    prepareTempDir: async () => {
      events.push("temp");
    },
    updateStatus: () => {
      events.push("status");
    },
  });
  assert.deepEqual(events, [
    "load",
    "state:gpt-5",
    "temp",
    "bind:ctx",
    "status",
  ]);
});

test("Session runtime start swallows only stale deferred-dispatch context binding", async () => {
  const currentModel = createQueueTestModel();
  const baseDeps = {
    ctx: "ctx",
    currentModel,
    loadConfig: async () => {},
    applyState: () => {},
    prepareTempDir: async () => {},
    updateStatus: () => {},
  };
  await assert.doesNotReject(() =>
    startTelegramSessionRuntime({
      ...baseDeps,
      bindDeferredDispatchContext: () => {
        throw new Error("ctx is stale after session replacement");
      },
    }),
  );
  await assert.rejects(
    () =>
      startTelegramSessionRuntime({
        ...baseDeps,
        bindDeferredDispatchContext: () => {
          throw new Error("bind broke");
        },
      }),
    /bind broke/,
  );
});

test("Session runtime helper clears shutdown state", () => {
  const state = buildTelegramSessionShutdownState<string>();
  assert.deepEqual(state.queuedTelegramItems, []);
  assert.equal(state.nextQueuedTelegramItemOrder, 0);
  assert.equal(state.nextQueuedTelegramControlOrder, 0);
  assert.equal(state.currentTelegramModel, undefined);
  assert.equal(state.activeTelegramToolExecutions, 0);
  assert.equal(state.telegramTurnDispatchPending, false);
  assert.equal(state.compactionInProgress, false);
  assert.equal(state.foldQueuedPromptsIntoHistory, false);
});

test("Session lifecycle runtime binds state applier into lifecycle hooks", async () => {
  const events: string[] = [];
  const hooks = createTelegramSessionLifecycleRuntime<
    string,
    TelegramQueueItem<string>,
    { provider: string; id: string }
  >({
    getCurrentModel: () => createQueueTestModel(),
    loadConfig: async () => {
      events.push("load");
    },
    setQueuedItems: (items) => {
      events.push(`queued:${items.length}`);
    },
    setCurrentModel: (model) => {
      events.push(`model:${model?.id ?? "none"}`);
    },
    setPendingModelSwitch: () => {
      events.push("pending:clear");
    },
    syncCounters: () => {
      events.push("counters");
    },
    syncFlags: () => {
      events.push("flags");
    },
    bindDeferredDispatchContext: (ctx) => {
      events.push(`bind:${ctx}`);
    },
    prepareTempDir: async () => {
      events.push("temp");
    },
    updateStatus: (ctx) => {
      events.push(`status:${ctx}`);
    },
    unbindDeferredDispatchContext: () => {
      events.push("unbind");
    },
    clearPendingMediaGroups: () => {
      events.push("media:clear");
    },
    clearModelMenuState: () => {
      events.push("menu:clear");
    },
    getActiveTurnChatId: () => undefined,
    clearPreview: async () => {
      events.push("preview:clear");
    },
    clearActiveTurn: () => {
      events.push("turn:clear");
    },
    clearAbort: () => {
      events.push("abort:clear");
    },
    stopPolling: async () => {
      events.push("polling:stop");
    },
  });
  await hooks.onSessionStart(undefined, "ctx");
  await hooks.onSessionShutdown();
  assert.deepEqual(events, [
    "load",
    "model:gpt-5",
    "pending:clear",
    "counters",
    "flags",
    "temp",
    "bind:ctx",
    "status:ctx",
    "unbind",
    "polling:stop",
    "queued:0",
    "counters",
    "flags",
    "model:none",
    "pending:clear",
    "media:clear",
    "menu:clear",
    "turn:clear",
    "abort:clear",
  ]);
});

test("Session lifecycle hooks bind start and shutdown runtime ports", async () => {
  const events: string[] = [];
  const hooks = createTelegramSessionLifecycleHooks<
    { model?: { id: string } },
    string,
    { id: string }
  >({
    getCurrentModel: (ctx) => ctx.model,
    loadConfig: async () => {
      events.push("load");
    },
    applySessionStartState: (state) => {
      events.push(`start:${state.currentTelegramModel?.id}`);
    },
    bindDeferredDispatchContext: (ctx) => {
      events.push(`bind:${ctx.model?.id ?? "none"}`);
    },
    prepareTempDir: async () => {
      events.push("temp");
    },
    updateStatus: (ctx) => {
      events.push(`status:${ctx.model?.id ?? "none"}`);
    },
    applySessionShutdownState: (state) => {
      events.push(`shutdown:${state.queuedTelegramItems.length}`);
    },
    unbindDeferredDispatchContext: () => {
      events.push("unbind");
    },
    clearPendingMediaGroups: () => {
      events.push("media");
    },
    clearModelMenuState: () => {
      events.push("menu");
    },
    getActiveTurnChatId: () => 7,
    getActiveTurnTarget: () => ({ chatId: 7, threadId: 77 }),
    clearPreview: async (chatId, options) => {
      events.push(`preview:${chatId}:${options?.target?.threadId ?? "none"}`);
    },
    clearActiveTurn: () => {
      events.push("turn");
    },
    clearAbort: () => {
      events.push("abort");
    },
    stopPolling: async () => {
      events.push("poll");
    },
  });
  await hooks.onSessionStart({}, { model: { id: "gpt-5" } });
  await hooks.onSessionShutdown();
  assert.deepEqual(events, [
    "load",
    "start:gpt-5",
    "temp",
    "bind:gpt-5",
    "status:gpt-5",
    "unbind",
    "poll",
    "shutdown:0",
    "media",
    "menu",
    "preview:7:77",
    "turn",
    "abort",
  ]);
});

// --- Dispatch ready-item contract ---
// When executeTelegramQueueDispatchPlan dispatches a prompt, it must call
// sendUserMessage as a normal turn (no followUp delivery option) because
// the caller already confirmed the agent is ready via canDispatch.
// Regression: followUp can queue idle prompts on some Pi-compatible runtimes.

await test("executeTelegramQueueDispatchPlan sends ready prompts as normal user turns", async (t) => {
  await t.test(
    "sendUserMessage is called without followUp delivery option for prompt plan",
    () => {
      let sendUserMessageArgs:
        { content: unknown; options: unknown } | undefined;
      let onPromptDispatchChatId: number | undefined;

      const deps: TelegramDispatchRuntimeDeps = {
        executeControlItem: () => {},
        onPromptDispatchStart: (chatId) => {
          onPromptDispatchChatId = chatId;
        },
        sendUserMessage: (content, options) => {
          sendUserMessageArgs = { content, options };
        },
        onPromptDispatchFailure: () => {},
        onIdle: () => {},
      };

      const item: PendingTelegramTurn = {
        kind: "prompt",
        chatId: 123456,
        sourceMessageIds: [1],
        replyToMessageId: 0,
        queueOrder: 0,
        queueLane: "default",
        laneOrder: 0,
        statusSummary: "test",
        content: [{ type: "text", text: "hello" }],
        historyText: "hello",
        queuedAttachments: [],
      };

      const plan = {
        kind: "prompt" as const,
        item,
        remainingItems: [] as TelegramQueueItem[],
      };

      executeTelegramQueueDispatchPlan(plan, deps);

      assert.equal(onPromptDispatchChatId, 123456);
      assert.ok(sendUserMessageArgs, "sendUserMessage was called");
      assert.deepStrictEqual(sendUserMessageArgs.content, item.content);
      assert.equal(
        sendUserMessageArgs.options,
        undefined,
        "sendUserMessage must be called WITHOUT followUp delivery option",
      );
    },
  );

  await t.test(
    "sendUserMessage receives no second argument (no followUp)",
    () => {
      let sendUserMessageArgCount = 0;

      const deps: TelegramDispatchRuntimeDeps = {
        executeControlItem: () => {},
        onPromptDispatchStart: () => {},
        sendUserMessage: (...args: unknown[]) => {
          sendUserMessageArgCount = args.length;
        },
        onPromptDispatchFailure: () => {},
        onIdle: () => {},
      };

      const item: PendingTelegramTurn = {
        kind: "prompt",
        chatId: 789,
        sourceMessageIds: [2],
        replyToMessageId: 0,
        queueOrder: 1,
        queueLane: "default",
        laneOrder: 1,
        statusSummary: "test",
        content: [{ type: "text", text: "arg count test" }],
        historyText: "arg count test",
        queuedAttachments: [],
      };

      executeTelegramQueueDispatchPlan(
        { kind: "prompt", item, remainingItems: [] },
        deps,
      );

      assert.equal(
        sendUserMessageArgCount,
        1,
        "sendUserMessage must receive exactly 1 argument (content only)",
      );
    },
  );
});
