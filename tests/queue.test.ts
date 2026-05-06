/**
 * Regression tests for Telegram queue and runtime decision helpers
 * Exercises queue ordering, mutation, dispatch planning, lifecycle plans, and model-switch guard behavior
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  appendTelegramQueueItem,
  assertTelegramQueueItemAdmissionValid,
  buildPendingTelegramControlItem,
  buildTelegramAgentEndPlan,
  buildTelegramAgentStartPlan,
  buildTelegramSessionShutdownState,
  buildTelegramSessionStartState,
  canDispatchTelegramTurnState,
  clearTelegramQueueItemsRuntime,
  clearTelegramQueuePromptPriority,
  clearTelegramQueuePromptPriorityRuntime,
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
  createTelegramQueueDispatchController,
  createTelegramQueueDispatchRuntime,
  createTelegramQueueMutationController,
  createTelegramQueueStore,
  createTelegramSessionLifecycleHooks,
  createTelegramSessionLifecycleRuntime,
  createTelegramSessionStateApplier,
  createTelegramToolExecutionHooks,
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
  partitionTelegramQueueItemsForHistory,
  planNextTelegramQueueAction,
  planTelegramPromptEnqueue,
  prioritizeTelegramQueuePrompt,
  prioritizeTelegramQueuePromptRuntime,
  removeTelegramQueueItemsByMessageIds,
  removeTelegramQueueItemsByMessageIdsRuntime,
  shouldDispatchAfterTelegramAgentEnd,
  shutdownTelegramSessionRuntime,
  startTelegramSessionRuntime,
  TELEGRAM_QUEUE_LANE_CONTRACTS,
  type PendingTelegramControlItem,
  type PendingTelegramTurn,
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

test("Active turn store owns active turn state helpers", () => {
  const store = createTelegramActiveTurnStore();
  const turn: PendingTelegramTurn = createQueueTestPromptTurn({
    chatId: 7,
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
  assert.equal(store.getReplyToMessageId(), 8);
  assert.deepEqual(store.getSourceMessageIds(), [8, 9]);
  store.clear();
  assert.equal(store.has(), false);
  assert.equal(store.getChatId(), undefined);
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
  let nextPriorityOrder = 7;
  const controller = createTelegramQueueMutationController<string>({
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
    },
    getNextPriorityReactionOrder: () => nextPriorityOrder,
    incrementNextPriorityReactionOrder: () => {
      nextPriorityOrder += 1;
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
  assert.equal(controller.prioritizeByMessageId(11, "b", "❤"), true);
  assert.equal(nextPriorityOrder, 8);
  const reprioritized = queuedItems.find((item) => item.replyToMessageId === 1);
  assert.equal(
    reprioritized?.kind === "prompt" ? reprioritized.priorityEmoji : undefined,
    "❤",
  );
  assert.equal(controller.clearPriorityByMessageId(11, "c"), true);
  assert.equal(controller.removeByMessageIds([11], "d"), 1);
  assert.equal(controller.clear("e"), 2);
  assert.deepEqual(queuedItems, []);
  assert.deepEqual(events, ["a", "append", "b", "c", "d", "e"]);
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
  let nextPriorityOrder = 5;
  const deps = {
    ctx: "ctx",
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items: TelegramQueueItem<string>[]) => {
      queuedItems = items;
      events.push(`items:${items.map((item) => item.statusSummary).join(",")}`);
    },
    getNextPriorityReactionOrder: () => nextPriorityOrder,
    incrementNextPriorityReactionOrder: () => {
      nextPriorityOrder += 1;
      events.push(`order:${nextPriorityOrder}`);
    },
    updateStatus: (ctx: string) => {
      events.push(`status:${ctx}`);
    },
  };
  assert.equal(clearTelegramQueuePromptPriorityRuntime<string>(22, deps), true);
  assert.deepEqual(
    queuedItems.map((item) => item.statusSummary),
    ["control", "prompt", "priority"],
  );
  assert.equal(prioritizeTelegramQueuePromptRuntime<string>(11, deps), true);
  assert.equal(nextPriorityOrder, 6);
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
    "items:prompt,control,priority",
    "items:control,prompt,priority",
    "status:ctx",
    "items:control,prompt,priority",
    "order:6",
    "items:control,prompt,priority",
    "status:ctx",
    "items:control,priority",
    "status:ctx",
    "items:",
    "status:ctx",
  ]);
});

test("Queue mutation helpers apply and clear prompt priority without touching control items", () => {
  const promptItem: TelegramQueueItem = createQueueTestPromptTurn({
    replyToMessageId: 1,
    sourceMessageIds: [11],
    queueOrder: 4,
    laneOrder: 4,
    historyText: "prompt history",
  });
  const controlItem: TelegramQueueItem = createQueueTestControlItem({
    queueOrder: 5,
  });
  const prioritized = prioritizeTelegramQueuePrompt(
    [promptItem, controlItem],
    11,
    0,
    "🕊",
  );
  assert.equal(prioritized.changed, true);
  assert.equal(prioritized.items[0]?.queueLane, "priority");
  assert.equal(
    prioritized.items[0]?.kind === "prompt"
      ? prioritized.items[0].priorityEmoji
      : undefined,
    "🕊",
  );
  const cleared = clearTelegramQueuePromptPriority(prioritized.items, 11);
  assert.equal(cleared.changed, true);
  assert.equal(cleared.items[0]?.queueLane, "default");
  assert.equal(
    cleared.items[0]?.kind === "prompt"
      ? cleared.items[0].priorityEmoji
      : "unexpected",
    undefined,
  );
  assert.equal(cleared.items[1]?.queueLane, "control");
});

test("Queue priority reactions apply to attachment-only prompt turns", () => {
  const attachmentPrompt: TelegramQueueItem = createQueueTestPromptTurn({
    sourceMessageIds: [21],
    queuedAttachments: [{ path: "/tmp/voice.ogg", fileName: "voice.ogg" }],
    content: [{ type: "text", text: "[telegram] voice transcript" }],
    historyText: "voice transcript",
    statusSummary: "📎 voice.ogg",
  });
  const prioritized = prioritizeTelegramQueuePrompt([attachmentPrompt], 21, 0);
  assert.equal(prioritized.changed, true);
  assert.equal(prioritized.items[0]?.queueLane, "priority");
  assert.equal(prioritized.items[0]?.statusSummary, "📎 voice.ogg");
});

test("Queued status formatting marks priority prompts in the pi status bar", () => {
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
  const controlItem: TelegramQueueItem = createQueueTestControlItem({
    replyToMessageId: 3,
    queueOrder: 6,
    statusSummary: "⚡ status",
  });
  assert.equal(
    formatQueuedTelegramItemsStatus([
      controlItem,
      priorityPrompt,
      defaultPrompt,
    ]),
    " +3: [⚡ status, ❤ prompt, default]",
  );
});

test("Queue enqueue planning preserves queued prompts as history when requested", () => {
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

test("Preserved abort leaves queued prompts waiting for explicit continuation", () => {
  assert.equal(
    shouldDispatchAfterTelegramAgentEnd({
      hasTurn: true,
      stopReason: "aborted",
      preserveQueuedTurnsAsHistory: true,
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
      preserveQueuedTurnsAsHistory: true,
    }),
  );
  assert.equal(blockedDispatch.kind, "none");
  assert.deepEqual(
    blockedDispatch.remainingItems.map((item) => item.statusSummary),
    ["prompt"],
  );
});

test("Agent end dispatch policy resumes after success and error, but not preserved aborts", () => {
  assert.equal(
    shouldDispatchAfterTelegramAgentEnd({
      hasTurn: false,
      preserveQueuedTurnsAsHistory: false,
    }),
    true,
  );
  assert.equal(
    shouldDispatchAfterTelegramAgentEnd({
      hasTurn: true,
      stopReason: "error",
      preserveQueuedTurnsAsHistory: false,
    }),
    true,
  );
  assert.equal(
    shouldDispatchAfterTelegramAgentEnd({
      hasTurn: true,
      stopReason: "aborted",
      preserveQueuedTurnsAsHistory: false,
    }),
    true,
  );
  assert.equal(
    shouldDispatchAfterTelegramAgentEnd({
      hasTurn: true,
      stopReason: "aborted",
      preserveQueuedTurnsAsHistory: true,
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
    preserveQueuedTurnsAsHistory: false,
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
    "status",
    "preview:final",
    "finalize:final",
    "clear:1",
    "markdown:final",
    "attachments:1",
    "dispatch",
  ]);
});

test("Agent end runtime stays silent when Telegram lock moved away", async () => {
  const events: string[] = [];
  const turn: PendingTelegramTurn = createQueueTestPromptTurn({
    queuedAttachments: [{ path: "/tmp/demo.txt", fileName: "demo.txt" }],
  });
  await handleTelegramAgentEndRuntime({
    turn,
    assistant: { text: "final" },
    preserveQueuedTurnsAsHistory: false,
    resetRuntimeState: () => {
      events.push("reset");
    },
    updateStatus: () => {
      events.push("status");
    },
    isCurrentOwner: () => false,
    dispatchNextQueuedTelegramTurn: () => {
      events.push("unexpected:dispatch");
    },
    clearPreview: async (chatId) => {
      events.push(`clear:${chatId}`);
    },
    setPreviewPendingText: () => {
      events.push("unexpected:preview");
    },
    finalizeMarkdownPreview: async () => {
      events.push("unexpected:finalize");
      return true;
    },
    sendMarkdownReply: async () => {
      events.push("unexpected:markdown");
    },
    sendTextReply: async () => {
      events.push("unexpected:text");
    },
    sendQueuedAttachments: async () => {
      events.push("unexpected:attachments");
    },
    sendOutboundReplyArtifacts: async () => {
      events.push("unexpected:voice");
    },
  });
  assert.deepEqual(events, ["reset", "status", "clear:1"]);
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
      text: 'Answer\n\n<!-- telegram_button label="Continue"\nContinue\n-->',
    },
    preserveQueuedTurnsAsHistory: false,
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
        "<!-- telegram_voice lang=ru rate=+20%",
        "Short voice summary.",
        "-->",
      ].join("\n"),
    },
    preserveQueuedTurnsAsHistory: false,
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
    "voice:Short voice summary.:ru:+20%:false",
    "attachments",
    "dispatch",
  ]);
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
    getPreserveQueuedTurnsAsHistory: () => false,
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
    "attachments",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, [
    "extract:a,b",
    "reset",
    "status:ctx",
    "preview:final",
    "finalize:final",
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
    preserveQueuedTurnsAsHistory: false,
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
    preserveQueuedTurnsAsHistory: false,
    hasFinalText: false,
    hasQueuedAttachments: false,
  });
  assert.equal(noTurnPlan.kind, "no-turn");
  assert.equal(noTurnPlan.shouldDispatchNext, true);
  const abortedPlan = buildTelegramAgentEndPlan({
    hasTurn: true,
    stopReason: "aborted",
    preserveQueuedTurnsAsHistory: true,
    hasFinalText: false,
    hasQueuedAttachments: true,
  });
  assert.equal(abortedPlan.kind, "aborted");
  assert.equal(abortedPlan.shouldClearPreview, true);
  assert.equal(abortedPlan.shouldDispatchNext, false);
  const errorPlan = buildTelegramAgentEndPlan({
    hasTurn: true,
    stopReason: "error",
    preserveQueuedTurnsAsHistory: false,
    hasFinalText: false,
    hasQueuedAttachments: false,
  });
  assert.equal(errorPlan.kind, "error");
  assert.equal(errorPlan.shouldSendErrorMessage, true);
  const attachmentPlan = buildTelegramAgentEndPlan({
    hasTurn: true,
    preserveQueuedTurnsAsHistory: false,
    hasFinalText: false,
    hasQueuedAttachments: true,
  });
  assert.equal(attachmentPlan.kind, "attachments-only");
  assert.equal(attachmentPlan.shouldSendAttachmentNotice, true);
  const textPlan = buildTelegramAgentEndPlan({
    hasTurn: true,
    preserveQueuedTurnsAsHistory: false,
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
    setActiveTurn: (turn) => {
      activeTurn = turn;
      events.push(`turn:${turn.replyToMessageId}`);
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
    getPreserveQueuedTurnsAsHistory: () => false,
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
    "dispatch:ctx",
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
    setActiveTurn: (turn) => {
      events.push(`turn:${turn.replyToMessageId}`);
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
  assert.equal(plan.shouldResetPendingModelSwitch, true);
  assert.equal(plan.shouldResetToolExecutions, true);
  assert.deepEqual(plan.remainingItems, []);
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
    nextPriorityReactionOrder: 7,
    currentTelegramModel: undefined,
    activeTelegramToolExecutions: 0,
    pendingTelegramModelSwitch: undefined,
    telegramTurnDispatchPending: true,
    compactionInProgress: false,
    preserveQueuedTurnsAsHistory: false,
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
    "state:0",
    "media",
    "menus",
    "preview:42",
    "turn",
    "abort",
    "polling",
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
  controller.enqueue(item, "ctx");
  assert.deepEqual(events, ["append:status:ctx", "dispatch:ctx"]);
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
    getPreserveQueuedTurnsAsHistory: () => false,
    setPreserveQueuedTurnsAsHistory: (preserve) => {
      events.push(`preserve:${preserve}`);
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
  await controller.enqueue([7], "ctx");
  assert.deepEqual(events, [
    "preserve:false",
    "items:1",
    "status:ctx",
    "dispatch:ctx",
  ]);
});

test("Prompt enqueue runtime preserves queued prompts as history", async () => {
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
  let preserveHistory = true;
  await enqueueTelegramPromptTurnRuntime(["message"], {
    getQueuedItems: () => queuedItems,
    setQueuedItems: (items) => {
      queuedItems = items;
      events.push(`items:${items.map((item) => item.statusSummary).join(",")}`);
    },
    getPreserveQueuedTurnsAsHistory: () => preserveHistory,
    setPreserveQueuedTurnsAsHistory: (preserve) => {
      preserveHistory = preserve;
      events.push(`preserve:${preserve}`);
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
  });
  assert.equal(preserveHistory, false);
  assert.deepEqual(
    queuedItems.map((item) => item.statusSummary),
    ["control", "new"],
  );
  assert.deepEqual(events, [
    "preserve:false",
    "history:history",
    "items:control,new",
    "status",
    "dispatch",
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
      onSettled: () => {
        events.push("settled");
      },
    },
  );
  assert.deepEqual(events, ["execute", "settled"]);
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
      onSettled: () => {
        events.push("settled");
      },
    },
  );
  assert.deepEqual(events, [
    "control:boom:model",
    "Telegram control action failed: boom",
    "settled",
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

test("Dispatch runtime reports prompt dispatch failures after starting", () => {
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
  assert.deepEqual(events, ["start:2", "error:boom"]);
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

test("Session runtime helper clears shutdown state", () => {
  const state = buildTelegramSessionShutdownState<string>();
  assert.deepEqual(state.queuedTelegramItems, []);
  assert.equal(state.nextQueuedTelegramItemOrder, 0);
  assert.equal(state.nextQueuedTelegramControlOrder, 0);
  assert.equal(state.nextPriorityReactionOrder, 0);
  assert.equal(state.currentTelegramModel, undefined);
  assert.equal(state.activeTelegramToolExecutions, 0);
  assert.equal(state.telegramTurnDispatchPending, false);
  assert.equal(state.compactionInProgress, false);
  assert.equal(state.preserveQueuedTurnsAsHistory, false);
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
    "queued:0",
    "counters",
    "flags",
    "model:none",
    "pending:clear",
    "media:clear",
    "menu:clear",
    "turn:clear",
    "abort:clear",
    "polling:stop",
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
    "shutdown:0",
    "media",
    "menu",
    "preview:7",
    "turn",
    "abort",
    "poll",
  ]);
});
