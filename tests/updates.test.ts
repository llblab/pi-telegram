/**
 * Regression tests for the Telegram updates domain
 * Covers extraction, authorization, flow planning, runtime execution, public handlers, and durable worker ownership
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { TelegramBusForeignUpdateSettlement } from "../lib/bus.ts";
import {
  buildTelegramUpdateExecutionPlan,
  buildTelegramUpdateExecutionPlanFromUpdate,
  bindTelegramUpdateAdmissionSource,
  buildTelegramUpdateFlowAction,
  carryTelegramUpdateExecutionFence,
  collectTelegramReactionEmojis,
  coordinateTelegramQueueHandoff,
  createTelegramPairedUpdateRuntime,
  createTelegramQueueAdmissionSettlementMuxRuntime,
  createTelegramQueueAdmissionSettlementRuntime,
  createTelegramQueueHandoffRecipientRuntime,
  createTelegramQueueHandoffReconciler,
  createTelegramQueueHandoffReconciliationRuntimeAssembly,
  createTelegramUpdateAdmissionHandle,
  createTelegramUpdateAdmissionLifecycleRuntime,
  createTelegramUpdateAdmissionRuntimeAssembly,
  createTelegramUpdateAdmissionRuntimeBinding,
  createTelegramUpdateAdmissionWorkerRuntime,
  createTelegramUpdateHandle,
  createTelegramUpdateRuntime,
  createTelegramUpdateWorkerOwnerRuntime,
  createTelegramUpdateWorkerRuntime,
  executeTelegramUpdate,
  executeTelegramUpdatePlan,
  extractDeletedTelegramMessageIds,
  getAuthorizedTelegramCallbackQuery,
  getAuthorizedTelegramEditedMessage,
  getAuthorizedTelegramGuestMessage,
  getAuthorizedTelegramMessage,
  getTelegramMessageTarget,
  getTelegramUpdateExecutionFence,
  getTelegramTopicLifecycleUpdate,
  getTelegramUpdateHandlerRegistry,
  handleAuthorizedTelegramReactionUpdate,
  normalizeTelegramReactionEmoji,
  registerTelegramUpdateHandler,
  reportTelegramQueueAdmission,
  reportTelegramUpdateDeferred,
  TELEGRAM_INTERNAL_AGENT_MESSAGE,
  TELEGRAM_PRIORITY_REACTION_EMOJIS,
  TELEGRAM_PRIORITY_REACTIONS,
  TELEGRAM_REMOVAL_REACTION_EMOJIS,
  TELEGRAM_REMOVAL_REACTIONS,
  type TelegramUpdateAdmissionOutcome,
  type TelegramUpdateFlow,
  type TelegramUpdateHandler,
  type TelegramUpdateExecutionFence,
  type TelegramUpdateHandlerRegistry,
  type TelegramUpdateWorkerJournalPort,
  type TelegramUpdateWorkerJournalSnapshot,
} from "../lib/updates.ts";
import {
  createTelegramQueueHandoffStagingRuntime,
  createTelegramQueueStore,
} from "../lib/queue.ts";
import type {
  TelegramJournaledUpdate,
  TelegramUpdateJournalQueueOwner,
} from "../lib/journal.ts";

const TEST_CONTEXT = "ctx";
const REGISTRY_KEY = "__piTelegramUpdateHandlerRegistry__";

function acceptedForeignUpdateSettlement(sourceUpdateId = 1) {
  return {
    status: "accepted" as const,
    delivery: {
      deliveryId: `test-delivery-${sourceUpdateId}`,
      sourceUpdateId,
      recipientBindingKey: "test-recipient",
    },
  };
}

function clearGlobalRegistry(): void {
  delete (globalThis as Record<string, unknown>)[REGISTRY_KEY];
}

function createTestUpdateWorkerJournal(
  inputs: readonly (number | TelegramJournaledUpdate)[],
): {
  journal: TelegramUpdateWorkerJournalPort;
  getEntries: () => TelegramUpdateWorkerJournalSnapshot["entries"];
  getUpdateIds: () => number[];
  getReadCount: () => number;
  getRemovals: () => number[][];
  getQueueReceipts: () => Array<{
    queueKind: "prompt" | "control";
    receiptId: string;
    sourceUpdateIds: readonly number[];
  }>;
} {
  let entries: Array<
    TelegramUpdateWorkerJournalSnapshot["entries"][number]
  > = inputs.map((input, index) => {
    const update =
      typeof input === "number" ? { update_id: input } : structuredClone(input);
    return {
      updateId: update.update_id,
      update: update as TelegramJournaledUpdate,
      admittedAtMs: 100 + index,
      state: "pending" as const,
    };
  });
  let readCount = 0;
  const removals: number[][] = [];
  const queueReceipts: Array<{
    queueKind: "prompt" | "control";
    receiptId: string;
    sourceUpdateIds: readonly number[];
  }> = [];
  const journal: TelegramUpdateWorkerJournalPort = {
    read() {
      readCount += 1;
      return {
        version: 1,
        profile: "test",
        botIdentity: { tokenSha256: "a".repeat(64) },
        entries: structuredClone(entries),
        exists: true,
        serializedBytes: entries.length * 100,
      };
    },
    markQueued(receipt) {
      queueReceipts.push({
        queueKind: receipt.queueKind,
        receiptId: receipt.receiptId,
        sourceUpdateIds: [...receipt.sourceUpdateIds],
      });
      const requested = new Set(receipt.sourceUpdateIds);
      const queuedUpdateIds: number[] = [];
      const duplicateUpdateIds: number[] = [];
      const queueOwner: TelegramUpdateJournalQueueOwner =
        entries.find(
          (entry) => entry.queueReceiptId === receipt.receiptId,
        )?.queueOwner ?? {
          ...receipt.owner,
          acquisitionId: `acquisition-${receipt.receiptId}`,
          acquiredAtMs: 1_000,
        };
      entries = entries.map((entry) => {
        if (!requested.has(entry.updateId)) return entry;
        if (entry.state === "queued") {
          duplicateUpdateIds.push(entry.updateId);
          return entry;
        }
        queuedUpdateIds.push(entry.updateId);
        return {
          updateId: entry.updateId,
          update: entry.update,
          admittedAtMs: entry.admittedAtMs,
          state: "queued" as const,
          queueKind: receipt.queueKind,
          queueReceiptId: receipt.receiptId,
          queueOwner,
        };
      });
      return { queuedUpdateIds, duplicateUpdateIds, queueOwner };
    },
    completeQueued(receipts) {
      const requestedUpdateIds = receipts.flatMap((receipt) =>
        [...receipt.sourceUpdateIds],
      );
      const requested = new Set(requestedUpdateIds);
      const removedUpdateIds = entries
        .filter((entry) => requested.has(entry.updateId))
        .map((entry) => entry.updateId);
      removals.push(requestedUpdateIds);
      entries = entries.filter((entry) => !requested.has(entry.updateId));
      return { removedUpdateIds };
    },
    markExecutionFailure(input) {
      const index = entries.findIndex(
        (entry) => entry.updateId === input.updateId,
      );
      const entry = entries[index];
      if (!entry) throw new Error(`Missing update ${input.updateId}.`);
      const previousAttemptCount = entry.failure?.attemptCount ?? 0;
      if (previousAttemptCount !== input.expectedAttemptCount) {
        throw new Error(`Stale attempt for update ${input.updateId}.`);
      }
      const next = {
        updateId: entry.updateId,
        update: entry.update,
        admittedAtMs: entry.admittedAtMs,
        state: input.disposition,
        failure: {
          attemptCount: previousAttemptCount + 1,
          failedAtMs: input.failedAtMs,
          failureClass: input.failureClass,
          summary: input.summary,
        },
        ...(input.disposition === "retry-wait"
          ? { nextRetryAtMs: input.nextRetryAtMs }
          : {
              terminalAtMs: input.failedAtMs,
              terminalReason: input.terminalReason,
            }),
      } as TelegramUpdateWorkerJournalSnapshot["entries"][number];
      entries[index] = next;
      return { entry: structuredClone(next) };
    },
    removeCompleted(requestedUpdateIds) {
      const requested = new Set(requestedUpdateIds);
      const removedUpdateIds = entries
        .filter((entry) => requested.has(entry.updateId))
        .map((entry) => entry.updateId);
      removals.push([...requestedUpdateIds]);
      entries = entries.filter((entry) => !requested.has(entry.updateId));
      return {
        removedUpdateIds,
        entryCount: entries.length,
        serializedBytes: entries.length * 100,
      };
    },
  };
  return {
    journal,
    getEntries: () => structuredClone(entries),
    getUpdateIds: () => entries.map((entry) => entry.updateId),
    getReadCount: () => readCount,
    getRemovals: () => structuredClone(removals),
    getQueueReceipts: () => structuredClone(queueReceipts),
  };
}

async function waitForUpdateWorkerCondition(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

function getGlobalRegistry(): TelegramUpdateHandlerRegistry | undefined {
  return (globalThis as Record<string, unknown>)[REGISTRY_KEY] as
    | TelegramUpdateHandlerRegistry
    | undefined;
}

test("Update helpers normalize emoji reactions and collect emoji-only entries", () => {
  assert.equal(normalizeTelegramReactionEmoji("👍️"), "👍");
  const emojis = collectTelegramReactionEmojis([
    { type: "emoji", emoji: "👍️" },
    { type: "emoji", emoji: "👎" },
    { type: "custom_emoji" },
  ]);
  assert.deepEqual([...emojis], ["👍", "👎"]);
  assert.deepEqual(
    TELEGRAM_PRIORITY_REACTIONS.map((reaction) => [
      reaction.id,
      reaction.name,
      reaction.emoji,
    ]),
    [
      [10, "like", "👍"],
      [11, "lightning", "⚡"],
      [12, "heart", "❤"],
      [13, "dove", "🕊"],
      [14, "fire", "🔥"],
    ],
  );
  assert.deepEqual(
    TELEGRAM_REMOVAL_REACTIONS.map((reaction) => reaction.id),
    [20, 21, 22, 23, 24],
  );
  assert.deepEqual(TELEGRAM_PRIORITY_REACTION_EMOJIS, [
    "👍",
    "⚡",
    "❤",
    "🕊",
    "🔥",
  ]);
  assert.deepEqual(TELEGRAM_REMOVAL_REACTION_EMOJIS, [
    "👎",
    "👻",
    "💔",
    "💩",
    "🗑",
  ]);
});

test("Update helpers extract topic lifecycle service messages", () => {
  assert.deepEqual(
    getTelegramTopicLifecycleUpdate({
      chat: { id: 7, type: "private" },
      message_id: 1,
      message_thread_id: 42,
      forum_topic_closed: {},
    }),
    {
      kind: "closed",
      message: {
        chat: { id: 7, type: "private" },
        message_id: 1,
        message_thread_id: 42,
        forum_topic_closed: {},
      },
      target: { chatId: 7, threadId: 42 },
    },
  );
  assert.equal(
    getTelegramTopicLifecycleUpdate({
      chat: { id: 7, type: "private" },
      message_id: 1,
    }),
    undefined,
  );
});

test("Update helpers extract private and thread targets from messages", () => {
  assert.deepEqual(
    getTelegramMessageTarget({
      chat: { id: 7, type: "private" },
      message_id: 1,
    }),
    { chatId: 7 },
  );
  assert.deepEqual(
    getTelegramMessageTarget({
      chat: { id: -1007, type: "supergroup" },
      message_id: 1,
      message_thread_id: 42,
    }),
    { chatId: -1007, threadId: 42 },
  );
  assert.equal(
    getTelegramMessageTarget({ chat: { type: "private" }, message_id: 1 }),
    undefined,
  );
});

test("Update helpers extract deleted business-message ids only from Bot API shapes", () => {
  assert.deepEqual(
    extractDeletedTelegramMessageIds({
      deleted_business_messages: { message_ids: [1, 2] },
    }),
    [1, 2],
  );
  assert.deepEqual(
    extractDeletedTelegramMessageIds({
      deleted_business_messages: { message_ids: [3, "bad"] },
    }),
    [],
  );
  assert.deepEqual(extractDeletedTelegramMessageIds({}), []);
});

test("Paired update runtime binds pairing ports into update routing", async () => {
  const events: string[] = [];
  let allowedUserId: number | undefined;
  const runtime = createTelegramPairedUpdateRuntime({
    getAllowedUserId: () => allowedUserId,
    setAllowedUserId: (userId) => {
      allowedUserId = userId;
      events.push(`set:${userId}`);
    },
    persistConfig: async () => {
      events.push("persist");
    },
    updateStatus: (ctx: string) => {
      events.push(`status:${ctx}`);
    },
    removePendingMediaGroupMessages: () => {},
    removeQueuedTelegramTurnsByMessageIds: () => 0,
    applyQueuedTelegramTurnReactionByMessageId: () => false,
    answerCallbackQuery: async () => {},
    answerGuestQuery: async () => {},
    handleAuthorizedTelegramCallbackQuery: async () => {},
    sendTextReply: async () => undefined,
    handleAuthorizedTelegramMessage: async (message, ctx: string) => {
      events.push(`message:${ctx}:${message.message_id ?? "none"}`);
    },
    handleAuthorizedTelegramEditedMessage: () => {},
  });
  await runtime.handleUpdate(
    {
      message: {
        chat: { id: 1, type: "private" },
        from: { id: 42, is_bot: false },
        message_id: 10,
      },
    },
    "ctx",
  );
  assert.deepEqual(events, [
    "set:42",
    "persist",
    "status:ctx",
    "message:ctx:10",
  ]);
});

test("Paired update runtime preserves follower target ownership forwarding", async () => {
  const events: string[] = [];
  const runtime = createTelegramPairedUpdateRuntime({
    getAllowedUserId: () => 7,
    setAllowedUserId: () => {},
    persistConfig: async () => {},
    updateStatus: () => {},
    getCurrentInstanceId: () => "leader",
    getTargetOwnership: (target) =>
      target.chatId === 100 && target.threadId === 42
        ? { instanceId: "follower" }
        : undefined,
    foreignOwnedUpdateForwarder: {
      forwardMessage: async ({ ownership }) => {
        events.push(`forward:${ownership.instanceId}`);
        return acceptedForeignUpdateSettlement();
      },
    },
    removePendingMediaGroupMessages: () => {},
    removeQueuedTelegramTurnsByMessageIds: () => 0,
    applyQueuedTelegramTurnReactionByMessageId: () => false,
    answerCallbackQuery: async () => {},
    answerGuestQuery: async () => {},
    handleAuthorizedTelegramCallbackQuery: async () => {},
    sendTextReply: async () => undefined,
    handleAuthorizedTelegramMessage: async () => {
      events.push("message");
    },
    handleAuthorizedTelegramEditedMessage: () => {},
    handleUnboundTelegramTopicMessage: async () => {
      events.push("unbound-topic");
    },
  });

  await runtime.handleUpdate(
    {
      message: {
        chat: { id: 100, type: "private" },
        from: { id: 7, is_bot: false },
        message_id: 11,
        message_thread_id: 42,
      },
    },
    TEST_CONTEXT,
  );

  assert.deepEqual(events, ["forward:follower"]);
});

test("Paired update runtime preserves topic lifecycle handling", async () => {
  const events: string[] = [];
  const runtime = createTelegramPairedUpdateRuntime({
    getAllowedUserId: () => 7,
    setAllowedUserId: () => {},
    persistConfig: async () => {},
    updateStatus: () => {},
    removePendingMediaGroupMessages: () => {},
    removeQueuedTelegramTurnsByMessageIds: () => 0,
    applyQueuedTelegramTurnReactionByMessageId: () => false,
    answerCallbackQuery: async () => {},
    answerGuestQuery: async () => {},
    handleAuthorizedTelegramCallbackQuery: async () => {},
    sendTextReply: async () => undefined,
    handleAuthorizedTelegramMessage: async () => {
      events.push("message");
    },
    handleAuthorizedTelegramEditedMessage: () => {},
    handleTelegramTopicLifecycleUpdate: async (lifecycle) => {
      events.push(`lifecycle:${lifecycle.kind}:${lifecycle.target.threadId}`);
    },
  });

  await runtime.handleUpdate(
    {
      message: {
        chat: { id: 100, type: "private" },
        from: { id: 7, is_bot: false },
        message_id: 12,
        message_thread_id: 43,
        forum_topic_created: {},
      },
    },
    TEST_CONTEXT,
  );

  assert.deepEqual(events, ["lifecycle:created:43"]);
});

test("Update routing extracts private and authorized group human callback queries", () => {
  assert.equal(
    getAuthorizedTelegramCallbackQuery({
      callback_query: {
        from: { id: 1, is_bot: true },
        message: { chat: { type: "private" } },
      },
    }),
    undefined,
  );
  assert.equal(
    getAuthorizedTelegramCallbackQuery(
      {
        callback_query: {
          from: { id: 1, is_bot: false },
          message: { chat: { type: "supergroup" } },
        },
      },
      7,
    ),
    undefined,
  );
  const query = getAuthorizedTelegramCallbackQuery({
    callback_query: {
      from: { id: 1, is_bot: false },
      message: { chat: { type: "private" } },
    },
  });
  assert.ok(query);
  assert.ok(
    getAuthorizedTelegramCallbackQuery(
      {
        callback_query: {
          from: { id: 7, is_bot: false },
          message: { chat: { type: "supergroup" } },
        },
      },
      7,
    ),
  );
});

test("Update routing extracts private human messages and edited messages separately", () => {
  assert.equal(
    getAuthorizedTelegramMessage({
      message: {
        chat: { type: "group" },
        from: { id: 1, is_bot: false },
      },
    }),
    undefined,
  );
  assert.ok(
    getAuthorizedTelegramMessage(
      {
        message: {
          chat: { type: "supergroup" },
          from: { id: 7, is_bot: false },
        },
      },
      7,
    ),
  );
  assert.ok(
    getAuthorizedTelegramEditedMessage(
      {
        edited_message: {
          chat: { type: "supergroup" },
          from: { id: 7, is_bot: false },
        },
      },
      7,
    ),
  );
  const directMessage = getAuthorizedTelegramMessage({
    message: {
      chat: { type: "private" },
      from: { id: 1, is_bot: false },
    },
  });
  assert.ok(directMessage);
  const editedMessage = getAuthorizedTelegramEditedMessage({
    edited_message: {
      chat: { type: "private" },
      from: { id: 1, is_bot: false },
    },
  });
  assert.ok(editedMessage);
});

test("Update routing extracts guest messages without private chat filter", () => {
  assert.equal(
    getAuthorizedTelegramGuestMessage({
      guest_message: {
        guest_query_id: "gq-1",
        chat: { type: "supergroup" },
        from: { id: 1, is_bot: true },
      },
    }),
    undefined,
  );
  const guestMessage = getAuthorizedTelegramGuestMessage({
    guest_message: {
      guest_query_id: "gq-1",
      chat: { type: "supergroup" },
      from: { id: 1, is_bot: false },
    },
  });
  assert.ok(guestMessage);
  assert.equal(guestMessage.guest_query_id, "gq-1");
});

test("Update flow prioritizes deleted business-message handling over other update kinds", () => {
  const action = buildTelegramUpdateFlowAction(
    {
      deleted_business_messages: { message_ids: [1, 2] },
      message_reaction: {
        chat: { type: "private" },
        user: { id: 1, is_bot: false },
        message_id: 1,
        old_reaction: [],
        new_reaction: [],
      },
    },
    1,
  );
  assert.deepEqual(action, { kind: "deleted", messageIds: [1, 2] });
});

test("Update flow detects topic lifecycle before prompt routing", () => {
  const action = buildTelegramUpdateFlowAction(
    {
      message: {
        chat: { id: 7, type: "private" },
        message_id: 1,
        message_thread_id: 42,
        forum_topic_reopened: {},
      },
    },
    7,
  );
  assert.equal(action.kind, "topic-lifecycle");
  assert.equal(
    action.kind === "topic-lifecycle" ? action.lifecycle.kind : undefined,
    "reopened",
  );
  assert.deepEqual(
    action.kind === "topic-lifecycle" ? action.lifecycle.target : undefined,
    { chatId: 7, threadId: 42 },
  );
});

test("Update flow returns authorized callback, message, and edit actions", () => {
  const callbackAction = buildTelegramUpdateFlowAction(
    {
      callback_query: {
        from: { id: 7, is_bot: false },
        message: { chat: { type: "private" } },
      },
    },
    7,
  );
  assert.equal(callbackAction.kind, "callback");
  assert.deepEqual(
    callbackAction.kind === "callback"
      ? callbackAction.authorization
      : undefined,
    { kind: "allow" },
  );
  const messageAction = buildTelegramUpdateFlowAction({
    message: {
      chat: { type: "private" },
      from: { id: 9, is_bot: false },
    },
  });
  assert.equal(messageAction.kind, "message");
  assert.deepEqual(
    messageAction.kind === "message" ? messageAction.authorization : undefined,
    { kind: "pair", userId: 9 },
  );
  const editAction = buildTelegramUpdateFlowAction(
    {
      edited_message: {
        chat: { type: "private" },
        from: { id: 9, is_bot: false },
      },
    },
    9,
  );
  assert.equal(editAction.kind, "edited-message");
});

test("Update flow classifies guest messages with authorization", () => {
  const guestAction = buildTelegramUpdateFlowAction(
    {
      guest_message: {
        guest_query_id: "gq-1",
        chat: { type: "supergroup" },
        from: { id: 5, is_bot: false },
      },
    },
    5,
  );
  assert.equal(guestAction.kind, "guest");
  assert.deepEqual(
    guestAction.kind === "guest" ? guestAction.authorization : undefined,
    { kind: "allow" },
  );
  const guestDeny = buildTelegramUpdateFlowAction(
    {
      guest_message: {
        guest_query_id: "gq-2",
        chat: { type: "supergroup" },
        from: { id: 6, is_bot: false },
      },
    },
    5,
  );
  assert.equal(guestDeny.kind, "guest");
  assert.deepEqual(
    guestDeny.kind === "guest" ? guestDeny.authorization : undefined,
    { kind: "deny" },
  );
});

test("Update flow ignores unauthorized transport shapes and preserves reaction events", () => {
  const reactionAction = buildTelegramUpdateFlowAction({
    message_reaction: {
      chat: { type: "private" },
      user: { id: 1, is_bot: false },
      message_id: 1,
      old_reaction: [],
      new_reaction: [],
    },
  });
  assert.equal(reactionAction.kind, "reaction");
  const ignored = buildTelegramUpdateFlowAction({
    callback_query: {
      from: { id: 1, is_bot: true },
      message: { chat: { type: "private" } },
    },
  });
  assert.deepEqual(ignored, { kind: "ignore" });
});

test("Update execution plan maps callback and message authorization to side-effect flags", () => {
  const callbackPlan = buildTelegramUpdateExecutionPlan({
    kind: "callback",
    query: {
      from: { id: 1, is_bot: false },
      message: { chat: { type: "private" } },
    },
    authorization: { kind: "deny" },
  });
  assert.deepEqual(callbackPlan, {
    kind: "callback",
    query: {
      from: { id: 1, is_bot: false },
      message: { chat: { type: "private" } },
    },
    shouldPair: false,
    shouldDeny: true,
  });
  const messagePlan = buildTelegramUpdateExecutionPlan({
    kind: "message",
    message: {
      chat: { type: "private" },
      from: { id: 2, is_bot: false },
    },
    authorization: { kind: "pair", userId: 2 },
  });
  assert.equal(messagePlan.kind, "message");
  assert.equal(messagePlan.shouldPair, true);
  assert.equal(messagePlan.shouldNotifyPaired, true);
  assert.equal(messagePlan.shouldDeny, false);
});

test("Update execution plan preserves deleted and reaction actions", () => {
  assert.deepEqual(
    buildTelegramUpdateExecutionPlan({ kind: "deleted", messageIds: [1, 2] }),
    { kind: "deleted", messageIds: [1, 2] },
  );
  const reactionUpdate = {
    chat: { type: "private" },
    user: { id: 1, is_bot: false },
    message_id: 1,
    old_reaction: [],
    new_reaction: [],
  };
  assert.deepEqual(
    buildTelegramUpdateExecutionPlan({
      kind: "reaction",
      reactionUpdate,
    }),
    { kind: "reaction", reactionUpdate },
  );
});

test("Update execution plan maps guest authorization to deny flag", () => {
  const guestMessage = {
    guest_query_id: "gq-1",
    chat: { type: "supergroup" },
    from: { id: 1, is_bot: false },
  };
  const guestPlan = buildTelegramUpdateExecutionPlan({
    kind: "guest",
    guestMessage,
    authorization: { kind: "allow" },
  });
  assert.deepEqual(guestPlan, {
    kind: "guest",
    guestMessage,
    shouldDeny: false,
  });
  const unpairedGuestPlan = buildTelegramUpdateExecutionPlan({
    kind: "guest",
    guestMessage,
    authorization: { kind: "pair", userId: 1 },
  });
  assert.deepEqual(unpairedGuestPlan, {
    kind: "guest",
    guestMessage,
    shouldDeny: true,
  });
});

test("Update execution plan can be built directly from updates", () => {
  const plan = buildTelegramUpdateExecutionPlanFromUpdate(
    {
      callback_query: {
        from: { id: 4, is_bot: false },
        message: { chat: { type: "private" } },
      },
    },
    5,
  );
  assert.equal(plan.kind, "callback");
  assert.equal(plan.kind === "callback" ? plan.shouldDeny : false, true);
});

test("Update runtime controller binds update and reaction ports", async () => {
  const events: string[] = [];
  const runtime = createTelegramUpdateRuntime({
    getAllowedUserId: () => 42,
    removePendingMediaGroupMessages: (messageIds) => {
      events.push(`media:${messageIds.join(",")}`);
    },
    removeQueuedTelegramTurnsByMessageIds: (messageIds, ctx: string) => {
      events.push(`remove:${ctx}:${messageIds.join(",")}`);
      return messageIds.length;
    },
    applyQueuedTelegramTurnReactionByMessageId: (
      messageId,
      disposition,
      ctx: string,
    ) => {
      events.push(`reaction:${ctx}:${messageId}:${disposition.kind}`);
      return true;
    },
    pairTelegramUserIfNeeded: async (userId, ctx: string) => {
      events.push(`pair:${ctx}:${userId}`);
      return true;
    },
    answerCallbackQuery: async (id, text) => {
      events.push(`answer:${id}:${text ?? ""}`);
    },
    answerGuestQuery: async (id, text) => {
      events.push(`guest-answer:${id}:${text ?? ""}`);
    },
    handleAuthorizedTelegramCallbackQuery: async () => {
      events.push("callback");
    },
    sendTextReply: async (chatId, replyToMessageId, text) => {
      events.push(`reply:${chatId}:${replyToMessageId}:${text}`);
      return 1;
    },
    handleAuthorizedTelegramMessage: async (message, ctx: string) => {
      events.push(`message:${ctx}:${message.message_id ?? "none"}`);
    },
    handleAuthorizedTelegramEditedMessage: async (message, ctx: string) => {
      events.push(`edit:${ctx}:${message.message_id ?? "none"}`);
    },
  });
  await runtime.handleAuthorizedReactionUpdate(
    {
      chat: { type: "private" },
      message_id: 9,
      user: { id: 42, is_bot: false },
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👍" }],
    },
    "ctx",
  );
  await runtime.handleUpdate(
    {
      message: {
        chat: { id: 1, type: "private" },
        from: { id: 42, is_bot: false },
        message_id: 10,
      },
    },
    "ctx",
  );
  assert.deepEqual(events, [
    "reaction:ctx:9:reaction-transition",
    "message:ctx:10",
  ]);
});

test("Update runtime routes guest messages through guest handler", async () => {
  const events: string[] = [];
  const runtime = createTelegramUpdateRuntime<string>({
    getAllowedUserId: () => 42,
    removePendingMediaGroupMessages: () => {},
    removeQueuedTelegramTurnsByMessageIds: () => 0,
    applyQueuedTelegramTurnReactionByMessageId: () => true,
    pairTelegramUserIfNeeded: async () => false,
    answerCallbackQuery: async () => {},
    answerGuestQuery: async () => {},
    handleAuthorizedTelegramCallbackQuery: async () => {},
    sendTextReply: async () => 1,
    handleAuthorizedTelegramMessage: async () => {},
    handleAuthorizedTelegramEditedMessage: async () => {},
    handleAuthorizedTelegramGuestMessage: async (
      guestMessage,
      _ctx: string,
    ) => {
      events.push(`guest:${guestMessage.guest_query_id}`);
    },
  });
  await runtime.handleUpdate(
    {
      guest_message: {
        guest_query_id: "gq-1",
        chat: { type: "supergroup" },
        from: { id: 42, is_bot: false },
      },
    },
    "ctx",
  );
  assert.deepEqual(events, ["guest:gq-1"]);
});

test("Update runtime denies guest messages before pairing", async () => {
  const events: string[] = [];
  const runtime = createTelegramUpdateRuntime({
    getAllowedUserId: () => undefined,
    removePendingMediaGroupMessages: () => {},
    removeQueuedTelegramTurnsByMessageIds: () => 0,
    applyQueuedTelegramTurnReactionByMessageId: () => true,
    pairTelegramUserIfNeeded: async () => false,
    answerCallbackQuery: async () => {},
    answerGuestQuery: async (id, text, options) => {
      events.push(`guest-deny:${id}:${text ?? ""}:${options?.parseMode ?? ""}`);
    },
    handleAuthorizedTelegramCallbackQuery: async () => {},
    sendTextReply: async () => 1,
    handleAuthorizedTelegramMessage: async () => {},
    handleAuthorizedTelegramEditedMessage: async () => {},
    handleAuthorizedTelegramGuestMessage: async () => {
      events.push("guest-handled");
    },
  });
  await runtime.handleUpdate(
    {
      guest_message: {
        guest_query_id: "gq-unpaired",
        chat: { type: "supergroup" },
        from: { id: 42, is_bot: false },
      },
    },
    "ctx",
  );
  assert.deepEqual(events, [
    "guest-deny:gq-unpaired:<b>🚫 Access denied.</b>:HTML",
  ]);
});

test("Update runtime answers guest query with access denied for unauthorized users", async () => {
  const events: string[] = [];
  const runtime = createTelegramUpdateRuntime({
    getAllowedUserId: () => 42,
    removePendingMediaGroupMessages: () => {},
    removeQueuedTelegramTurnsByMessageIds: () => 0,
    applyQueuedTelegramTurnReactionByMessageId: () => true,
    pairTelegramUserIfNeeded: async () => false,
    answerCallbackQuery: async () => {},
    answerGuestQuery: async (id, text, options) => {
      events.push(`guest-deny:${id}:${text ?? ""}:${options?.parseMode ?? ""}`);
    },
    handleAuthorizedTelegramCallbackQuery: async () => {},
    sendTextReply: async () => 1,
    handleAuthorizedTelegramMessage: async () => {},
    handleAuthorizedTelegramEditedMessage: async () => {},
    handleAuthorizedTelegramGuestMessage: async () => {
      events.push("guest-handled");
    },
  });
  await runtime.handleUpdate(
    {
      guest_message: {
        guest_query_id: "gq-deny",
        chat: { type: "supergroup" },
        from: { id: 99, is_bot: false },
      },
    },
    "ctx",
  );
  assert.deepEqual(events, [
    "guest-deny:gq-deny:<b>🚫 Access denied.</b>:HTML",
  ]);
});

test("Update runtime preserves both flags from complete reaction sets with removal precedence", async () => {
  const events: string[] = [];
  const deps = {
    allowedUserId: 7,
    ctx: TEST_CONTEXT,
    applyQueuedTelegramTurnReactionByMessageId: (
      id: number,
      disposition: {
        kind: string;
        emoji?: string;
        priorityEmoji?: string | null;
        suppressionEmoji?: string | null;
      },
    ) => {
      const detail = disposition.kind === "reaction-transition"
        ? `p:${disposition.priorityEmoji === undefined ? "=" : disposition.priorityEmoji ?? "-"};s:${disposition.suppressionEmoji === undefined ? "=" : disposition.suppressionEmoji ?? "-"}`
        : disposition.kind === "priority-suppressed"
          ? `${disposition.priorityEmoji}+${disposition.suppressionEmoji}`
          : disposition.emoji ?? "";
      events.push(`apply:${id}:${disposition.kind}:${detail}`);
      return true;
    },
  };
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 10,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👍️" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 11,
      old_reaction: [{ type: "emoji", emoji: "👍" }],
      new_reaction: [],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 12,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👎" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 13,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "⚡" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 14,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "❤️" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 15,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "🕊️" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 16,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "🔥" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 17,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👻" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 18,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "💔" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 19,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "💩" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 20,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "🗑️" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 21,
      old_reaction: [],
      new_reaction: [
        { type: "emoji", emoji: "👍" },
        { type: "emoji", emoji: "💩" },
      ],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 22,
      old_reaction: [
        { type: "emoji", emoji: "👍" },
        { type: "emoji", emoji: "👎" },
      ],
      new_reaction: [{ type: "emoji", emoji: "👍" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 23,
      old_reaction: [{ type: "emoji", emoji: "👎" }],
      new_reaction: [],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 24,
      old_reaction: [{ type: "emoji", emoji: "👎" }],
      new_reaction: [{ type: "emoji", emoji: "👍" }],
    },
    deps,
  );
  assert.deepEqual(events, [
    "apply:10:reaction-transition:p:👍;s:=",
    "apply:11:reaction-transition:p:-;s:=",
    "apply:12:reaction-transition:p:=;s:👎",
    "apply:13:reaction-transition:p:⚡;s:=",
    "apply:14:reaction-transition:p:❤;s:=",
    "apply:15:reaction-transition:p:🕊;s:=",
    "apply:16:reaction-transition:p:🔥;s:=",
    "apply:17:reaction-transition:p:=;s:👻",
    "apply:18:reaction-transition:p:=;s:💔",
    "apply:19:reaction-transition:p:=;s:💩",
    "apply:20:reaction-transition:p:=;s:🗑",
    "apply:21:reaction-transition:p:👍;s:💩",
    "apply:22:reaction-transition:p:=;s:-",
    "apply:23:reaction-transition:p:=;s:-",
    "apply:24:reaction-transition:p:👍;s:-",
  ]);
});

test("Reaction reconciliation materializes pending groups before queue mutation", async () => {
  const events: string[] = [];
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { id: 1, type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 30,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👎" }],
    },
    {
      allowedUserId: 7,
      ctx: TEST_CONTEXT,
      flushPendingMediaGroupMessage: async (id) => {
        events.push(`media:${id}`);
        return true;
      },
      flushPendingTextGroupMessage: async (id) => {
        events.push(`text:${id}`);
        return true;
      },
      applyQueuedTelegramTurnReactionByMessageId: (id, disposition) => {
        events.push(`apply:${id}:${disposition.kind}`);
        return true;
      },
    },
  );
  assert.deepEqual(events, [
    "media:30",
    "text:30",
    "apply:30:reaction-transition",
  ]);
});

test("Reaction reconciliation rechecks execution authority after group flush", async () => {
  const events: string[] = [];
  let current = true;
  await assert.rejects(
    handleAuthorizedTelegramReactionUpdate(
      {
        chat: { id: 1, type: "private" },
        user: { id: 7, is_bot: false },
        message_id: 30,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👎" }],
      },
      {
        allowedUserId: 7,
        ctx: TEST_CONTEXT,
        assertExecutionCurrent: () => {
          if (!current) throw new Error("stale reaction generation");
        },
        flushPendingMediaGroupMessage: async () => {
          events.push("media");
          current = false;
          return true;
        },
        flushPendingTextGroupMessage: async () => {
          events.push("text");
          return true;
        },
        applyQueuedTelegramTurnReactionByMessageId: () => {
          events.push("apply");
          return true;
        },
      },
    ),
    /stale reaction generation/u,
  );
  assert.deepEqual(events, ["media"]);
});

test("Update runtime handles authorized group reactions and ignores other users", async () => {
  const events: string[] = [];
  const deps = {
    allowedUserId: 7,
    ctx: TEST_CONTEXT,
    applyQueuedTelegramTurnReactionByMessageId: (
      id: number,
      disposition: { kind: string },
      _ctx: string,
      scope?: { chatId?: number },
    ) => {
      events.push(`apply:${id}:${disposition.kind}:${scope?.chatId ?? "none"}`);
      return true;
    },
  };

  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { id: -1001, type: "supergroup" },
      user: { id: 1, is_bot: false },
      message_id: 30,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👎" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { id: -1001, type: "supergroup" },
      user: { id: 7, is_bot: false },
      message_id: 31,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👎" }],
    },
    deps,
  );

  assert.deepEqual(events, ["apply:31:reaction-transition:-1001"]);
});

test("Update runtime retains foreign reactions when forwarding is unavailable", async () => {
  const events: string[] = [];
  await assert.rejects(
    handleAuthorizedTelegramReactionUpdate(
      {
        chat: { id: 7, type: "private" },
        user: { id: 7, is_bot: false },
        message_id: 10,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
      {
        allowedUserId: 7,
        ctx: TEST_CONTEXT,
        getCurrentInstanceId: () => "instance-a",
        getMessageOwnership: () => ({ instanceId: "instance-b" }),
        applyQueuedTelegramTurnReactionByMessageId: () => {
          events.push("apply");
          return false;
        },
      },
    ),
    /forwarder-unavailable/u,
  );
  assert.deepEqual(events, []);
});

test("Update runtime forwards reactions owned by another instance", async () => {
  const events: string[] = [];
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { id: 7, type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 10,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👍" }],
    },
    {
      allowedUserId: 7,
      ctx: TEST_CONTEXT,
      getCurrentInstanceId: () => "instance-a",
      getMessageOwnership: () => ({ instanceId: "instance-b" }),
      foreignOwnedUpdateForwarder: {
        forwardReaction: ({ ownership, ctx }) => {
          events.push(`forward:${ownership.instanceId}:${ctx}`);
          return acceptedForeignUpdateSettlement();
        },
      },
      applyQueuedTelegramTurnReactionByMessageId: () => {
        events.push("apply");
        return false;
      },
    },
  );
  assert.deepEqual(events, ["forward:instance-b:ctx"]);
});

test("Update runtime records forwarded message ownership for later reactions", async () => {
  const events: string[] = [];
  const ownership = new Map<string, { instanceId: string }>();
  const runtime = createTelegramUpdateRuntime({
    getAllowedUserId: () => 7,
    getCurrentInstanceId: () => "leader",
    getMessageOwnership: (chatId, messageId) =>
      ownership.get(`${chatId}:${messageId}`),
    getTargetOwnership: (target) =>
      target.chatId === 7 && target.threadId === 44
        ? { instanceId: "follower" }
        : undefined,
    recordMessageOwnership: (record) => {
      events.push(
        `record:${record.chatId}:${record.messageId}:${record.target?.threadId}:${record.instanceId}`,
      );
      ownership.set(`${record.chatId}:${record.messageId}`, {
        instanceId: record.instanceId,
      });
    },
    foreignOwnedUpdateForwarder: {
      forwardMessage: ({ ownership }) => {
        events.push(`forward-message:${ownership.instanceId}`);
        return acceptedForeignUpdateSettlement();
      },
      forwardReaction: ({ ownership }) => {
        events.push(`forward-reaction:${ownership.instanceId}`);
        return acceptedForeignUpdateSettlement();
      },
    },
    removePendingMediaGroupMessages: () => {
      events.push("media");
    },
    removeQueuedTelegramTurnsByMessageIds: () => {
      events.push("remove");
      return 0;
    },
    applyQueuedTelegramTurnReactionByMessageId: () => false,
    pairTelegramUserIfNeeded: async () => false,
    answerCallbackQuery: async () => {},
    answerGuestQuery: async () => {},
    handleAuthorizedTelegramCallbackQuery: async () => {},
    sendTextReply: async () => undefined,
    handleAuthorizedTelegramMessage: async () => {},
    handleAuthorizedTelegramEditedMessage: async () => {},
  });

  await runtime.handleUpdate(
    {
      message: {
        chat: { id: 7, type: "private" },
        from: { id: 7, is_bot: false },
        message_id: 100,
        message_thread_id: 44,
      },
    },
    TEST_CONTEXT,
  );
  await runtime.handleUpdate(
    {
      message_reaction: {
        chat: { id: 7, type: "private" },
        user: { id: 7, is_bot: false },
        message_id: 100,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👎" }],
      },
    },
    TEST_CONTEXT,
  );

  assert.deepEqual(events, [
    "record:7:100:44:follower",
    "forward-message:follower",
    "forward-reaction:follower",
  ]);
});

test("Update runtime executes delete and reaction plans through the right side effects", async () => {
  const events: string[] = [];
  await executeTelegramUpdatePlan(
    { kind: "deleted", messageIds: [1, 2] },
    {
      ctx: TEST_CONTEXT,
      removePendingMediaGroupMessages: (ids) => {
        events.push(`media:${ids.join(",")}`);
      },
      removeQueuedTelegramTurnsByMessageIds: (ids) => {
        events.push(`queue:${ids.join(",")}`);
        return ids.length;
      },
      handleAuthorizedTelegramReactionUpdate: async () => {
        events.push("reaction");
      },
      pairTelegramUserIfNeeded: async () => false,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {},
      handleAuthorizedTelegramEditedMessage: async () => {},
    },
  );
  assert.deepEqual(events, ["media:1,2", "queue:1,2"]);
});

test("Update runtime can execute directly from raw updates", async () => {
  const events: string[] = [];
  await executeTelegramUpdate(
    {
      message: {
        chat: { id: 10, type: "private" },
        message_id: 20,
        message_thread_id: 77,
        from: { id: 7, is_bot: false },
      },
    },
    undefined,
    {
      ctx: TEST_CONTEXT,
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => {
        events.push("pair");
        return true;
      },
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async (_chatId, _replyToMessageId, text, options) => {
        events.push(
          `reply:${text}:${options?.target?.chatId}:${options?.target?.threadId}`,
        );
        return undefined;
      },
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
      handleAuthorizedTelegramEditedMessage: async () => {
        events.push("edited-message");
      },
    },
  );
  assert.deepEqual(events, [
    "pair",
    "reply:Telegram bridge paired with this account.:10:77",
    "message",
  ]);
});

test("Update runtime swallows only stale context execution errors", async () => {
  const baseDeps = {
    ctx: TEST_CONTEXT,
    removePendingMediaGroupMessages: () => {},
    removeQueuedTelegramTurnsByMessageIds: () => 0,
    handleAuthorizedTelegramReactionUpdate: async () => {},
    pairTelegramUserIfNeeded: async () => false,
    answerCallbackQuery: async () => {},
    answerGuestQuery: async () => {},
    handleAuthorizedTelegramCallbackQuery: async () => {},
    sendTextReply: async () => undefined,
    handleAuthorizedTelegramEditedMessage: async () => {},
  };
  const plan = {
    kind: "message" as const,
    message: {
      chat: { id: 10, type: "private" as const },
      message_id: 20,
      from: { id: 7, is_bot: false },
    },
    shouldPair: false,
    shouldNotifyPaired: false,
    shouldDeny: false,
  };
  await assert.doesNotReject(() =>
    executeTelegramUpdatePlan(plan, {
      ...baseDeps,
      handleAuthorizedTelegramMessage: async () => {
        throw new Error("ctx is stale after session reload");
      },
    }),
  );
  await assert.rejects(
    () =>
      executeTelegramUpdatePlan(plan, {
        ...baseDeps,
        handleAuthorizedTelegramMessage: async () => {
          throw new Error("message handler broke");
        },
      }),
    /message handler broke/,
  );
});

test("Update runtime routes edited messages without creating normal message turns", async () => {
  const events: string[] = [];
  await executeTelegramUpdate(
    {
      edited_message: {
        chat: { id: 10, type: "private" },
        message_id: 20,
        from: { id: 7, is_bot: false },
      },
    },
    7,
    {
      ctx: TEST_CONTEXT,
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => false,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
      handleAuthorizedTelegramEditedMessage: async () => {
        events.push("edited-message");
      },
    },
  );
  assert.deepEqual(events, ["edited-message"]);
});

test("Internal agent messages bypass outbound message ownership forwarding", async () => {
  const events: string[] = [];
  await executeTelegramUpdate(
    {
      [TELEGRAM_INTERNAL_AGENT_MESSAGE]: true,
      message: {
        message_id: 99,
        date: 1,
        chat: { id: 7, type: "private" },
        from: { id: 7, is_bot: false },
        message_thread_id: 42,
        text: "[agent|from-thread:Hazel]\n\nHello",
      },
    },
    7,
    {
      ctx: TEST_CONTEXT,
      getCurrentInstanceId: () => "leader",
      getMessageOwnership: () => ({ instanceId: "follower" }),
      getTargetOwnership: () => undefined,
      recordMessageOwnership: () => events.push("record"),
      foreignOwnedUpdateForwarder: {
        forwardMessage: async () => {
          events.push("forward");
          return acceptedForeignUpdateSettlement();
        },
      },
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => false,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
      handleAuthorizedTelegramEditedMessage: async () => {},
    },
  );
  assert.deepEqual(events, ["message"]);
});

test("Internal agent messages preserve target ownership forwarding", async () => {
  const events: string[] = [];
  await executeTelegramUpdate(
    {
      [TELEGRAM_INTERNAL_AGENT_MESSAGE]: true,
      message: {
        message_id: 100,
        date: 1,
        chat: { id: 7, type: "private" },
        from: { id: 7, is_bot: false },
        message_thread_id: 99,
        text: "[agent|from-thread:Aster]\n\nHello",
      },
    },
    7,
    {
      ctx: TEST_CONTEXT,
      getCurrentInstanceId: () => "leader",
      getMessageOwnership: () => ({ instanceId: "leader" }),
      getTargetOwnership: () => ({
        instanceId: "follower",
        ownerGeneration: "generation-2",
      }),
      recordMessageOwnership: (record) => {
        events.push(
          `record:${record.instanceId}:${record.messageId}:${record.target?.threadId}`,
        );
      },
      foreignOwnedUpdateForwarder: {
        forwardMessage: async ({ ownership }) => {
          events.push(
            `forward:${ownership.instanceId}:${ownership.ownerGeneration}`,
          );
          return acceptedForeignUpdateSettlement();
        },
      },
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => false,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
      handleAuthorizedTelegramEditedMessage: async () => {},
    },
  );
  assert.deepEqual(events, [
    "record:follower:100:99",
    "forward:follower:generation-2",
  ]);
});

test("Update runtime keeps callback authority after its error answer", async () => {
  const events: string[] = [];
  await assert.rejects(
    executeTelegramUpdatePlan(
      {
        kind: "callback",
        query: {
          id: "cb-foreign",
          from: { id: 7, is_bot: false },
          message: { chat: { id: 10, type: "private" }, message_id: 99 },
        },
        shouldPair: false,
        shouldDeny: false,
      },
      {
        ctx: TEST_CONTEXT,
        getCurrentInstanceId: () => "instance-a",
        getMessageOwnership: () => ({ instanceId: "instance-b" }),
        removePendingMediaGroupMessages: () => {},
        removeQueuedTelegramTurnsByMessageIds: () => 0,
        handleAuthorizedTelegramReactionUpdate: async () => {},
        pairTelegramUserIfNeeded: async () => false,
        answerCallbackQuery: async (id, text) => {
          events.push(`answer:${id}:${text}`);
        },
        answerGuestQuery: async () => {},
        handleAuthorizedTelegramCallbackQuery: async () => {
          events.push("callback");
        },
        sendTextReply: async () => undefined,
        handleAuthorizedTelegramMessage: async () => {},
        handleAuthorizedTelegramEditedMessage: async () => {},
      },
    ),
    /forwarder-unavailable/u,
  );
  assert.deepEqual(events, [
    "answer:cb-foreign:This Telegram message belongs to another Pi instance.",
  ]);
});

test("Update runtime forwards callbacks owned by another instance", async () => {
  const events: string[] = [];
  await executeTelegramUpdatePlan(
    {
      kind: "callback",
      query: {
        id: "cb-foreign",
        from: { id: 7, is_bot: false },
        message: { chat: { id: 10, type: "private" }, message_id: 99 },
      },
      shouldPair: false,
      shouldDeny: false,
    },
    {
      ctx: TEST_CONTEXT,
      getCurrentInstanceId: () => "instance-a",
      getMessageOwnership: () => ({ instanceId: "instance-b" }),
      foreignOwnedUpdateForwarder: {
        forwardCallback: ({ ownership, ctx }) => {
          events.push(`forward:${ownership.instanceId}:${ctx}`);
          return acceptedForeignUpdateSettlement();
        },
      },
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => false,
      answerCallbackQuery: async (id, text) => {
        events.push(`answer:${id}:${text}`);
      },
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {
        events.push("callback");
      },
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {},
      handleAuthorizedTelegramEditedMessage: async () => {},
    },
  );
  assert.deepEqual(events, ["forward:instance-b:ctx"]);
});

test("Update runtime forwards callbacks from threads owned by another target instance", async () => {
  const events: string[] = [];
  await executeTelegramUpdatePlan(
    {
      kind: "callback",
      query: {
        id: "cb-thread",
        from: { id: 7, is_bot: false },
        message: {
          chat: { id: 10, type: "private" },
          message_id: 99,
          message_thread_id: 42,
        },
      },
      shouldPair: false,
      shouldDeny: false,
    },
    {
      ctx: TEST_CONTEXT,
      getCurrentInstanceId: () => "leader",
      getMessageOwnership: () => undefined,
      getTargetOwnership: (target) =>
        target.chatId === 10 && target.threadId === 42
          ? { instanceId: "follower" }
          : undefined,
      foreignOwnedUpdateForwarder: {
        forwardCallback: ({ ownership, ctx }) => {
          events.push(`forward:${ownership.instanceId}:${ctx}`);
          return acceptedForeignUpdateSettlement();
        },
      },
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => false,
      answerCallbackQuery: async (id, text) => {
        events.push(`answer:${id}:${text}`);
      },
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {
        events.push("callback");
      },
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {},
      handleAuthorizedTelegramEditedMessage: async () => {},
    },
  );
  assert.deepEqual(events, ["forward:follower:ctx"]);
});

test("Update runtime forwards messages owned by another target instance", async () => {
  const events: string[] = [];
  await executeTelegramUpdate(
    {
      message: {
        chat: { id: -10010, type: "supergroup" },
        message_thread_id: 55,
        message_id: 20,
        from: { id: 7, is_bot: false },
      },
    },
    7,
    {
      ctx: TEST_CONTEXT,
      getCurrentInstanceId: () => "instance-a",
      getTargetOwnership: (target) => {
        events.push(`target:${target.chatId}:${target.threadId}`);
        return { instanceId: "instance-b" };
      },
      foreignOwnedUpdateForwarder: {
        forwardMessage: ({ message, ownership, ctx }) => {
          events.push(
            `forward:${ownership.instanceId}:${ctx}:${(message as { message_id?: number }).message_id}`,
          );
          return acceptedForeignUpdateSettlement();
        },
      },
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => false,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
      handleAuthorizedTelegramEditedMessage: async () => {},
    },
  );
  assert.deepEqual(events, ["target:-10010:55", "forward:instance-b:ctx:20"]);
});

test("Update runtime forwards edited messages owned by another message instance", async () => {
  const events: string[] = [];
  await executeTelegramUpdate(
    {
      edited_message: {
        chat: { id: 7, type: "private" },
        message_id: 21,
        from: { id: 7, is_bot: false },
      },
    },
    7,
    {
      ctx: TEST_CONTEXT,
      getCurrentInstanceId: () => "instance-a",
      getMessageOwnership: () => ({ instanceId: "instance-b" }),
      foreignOwnedUpdateForwarder: {
        forwardEditedMessage: ({ message, ownership, ctx }) => {
          events.push(
            `forward-edit:${ownership.instanceId}:${ctx}:${(message as { message_id?: number }).message_id}`,
          );
          return acceptedForeignUpdateSettlement();
        },
      },
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => false,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {},
      handleAuthorizedTelegramEditedMessage: async () => {
        events.push("edited-message");
      },
    },
  );
  assert.deepEqual(events, ["forward-edit:instance-b:ctx:21"]);
});

test("Update runtime forwards edited messages owned by another target instance", async () => {
  const events: string[] = [];
  await executeTelegramUpdate(
    {
      edited_message: {
        chat: { id: -10010, type: "supergroup" },
        message_thread_id: 55,
        message_id: 21,
        from: { id: 7, is_bot: false },
      },
    },
    7,
    {
      ctx: TEST_CONTEXT,
      getCurrentInstanceId: () => "instance-a",
      getTargetOwnership: () => ({ instanceId: "instance-b" }),
      foreignOwnedUpdateForwarder: {
        forwardEditedMessage: ({ message, ownership, ctx }) => {
          events.push(
            `forward-edit:${ownership.instanceId}:${ctx}:${(message as { message_id?: number }).message_id}`,
          );
          return acceptedForeignUpdateSettlement();
        },
      },
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => false,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {},
      handleAuthorizedTelegramEditedMessage: async () => {
        events.push("edited-message");
      },
    },
  );
  assert.deepEqual(events, ["forward-edit:instance-b:ctx:21"]);
});

test("Update runtime keeps unauthorized HTML denials in the source thread", async () => {
  const events: string[] = [];
  await executeTelegramUpdatePlan(
    {
      kind: "message",
      message: {
        chat: { id: 7, type: "private" },
        from: { id: 2, is_bot: false },
        message_id: 9,
        message_thread_id: 44,
      },
      shouldPair: false,
      shouldNotifyPaired: false,
      shouldDeny: true,
    },
    {
      ctx: TEST_CONTEXT,
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => false,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async (chatId, replyToMessageId, text, options) => {
        events.push(
          `reply:${chatId}:${replyToMessageId}:${text}:${options?.parseMode}:${options?.target?.chatId}:${options?.target?.threadId}`,
        );
        return undefined;
      },
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
      handleAuthorizedTelegramEditedMessage: async () => {
        events.push("edited-message");
      },
    },
  );

  assert.deepEqual(events, [
    "reply:7:9:<b>🚫 Access denied.</b>:HTML:7:44",
  ]);
});

test("Update runtime handles callback deny and message pair flows", async () => {
  const events: string[] = [];
  await executeTelegramUpdatePlan(
    {
      kind: "callback",
      query: {
        id: "cb",
        from: { id: 1, is_bot: false },
        message: { chat: { type: "private" } },
      },
      shouldPair: true,
      shouldDeny: true,
    },
    {
      ctx: TEST_CONTEXT,
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async (userId) => {
        events.push(`pair:${userId}`);
        return true;
      },
      answerCallbackQuery: async (id, text) => {
        events.push(`answer:${id}:${text}`);
      },
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {
        events.push("callback");
      },
      sendTextReply: async (chatId, replyToMessageId, text) => {
        events.push(`reply:${chatId}:${replyToMessageId}:${text}`);
        return undefined;
      },
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
      handleAuthorizedTelegramEditedMessage: async () => {
        events.push("edited-message");
      },
    },
  );
  await executeTelegramUpdatePlan(
    {
      kind: "message",
      message: {
        chat: { id: 7, type: "private" },
        from: { id: 2, is_bot: false },
        message_id: 9,
        message_thread_id: 44,
      },
      shouldPair: true,
      shouldNotifyPaired: true,
      shouldDeny: false,
    },
    {
      ctx: TEST_CONTEXT,
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => true,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async (chatId, replyToMessageId, text, options) => {
        events.push(
          `reply:${chatId}:${replyToMessageId}:${text}:${options?.target?.chatId}:${options?.target?.threadId}`,
        );
        return undefined;
      },
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
      handleAuthorizedTelegramEditedMessage: async () => {
        events.push("edited-message");
      },
    },
  );
  assert.deepEqual(events, [
    "pair:1",
    "answer:cb:🚫 Access denied.",
    "reply:7:9:Telegram bridge paired with this account.:7:44",
    "message",
  ]);
});

test("executeTelegramUpdatePlan with handleUnboundTelegramTopicMessage calls unbound handler for message with threadId", async () => {
  const events: string[] = [];
  await executeTelegramUpdatePlan(
    {
      kind: "message",
      message: {
        message_id: 42,
        chat: { id: 1, type: "private" },
        message_thread_id: 100,
        from: { id: 1, is_bot: false, first_name: "Test" },
        date: 1000,
        text: "hi",
      },
      shouldPair: false,
      shouldNotifyPaired: false,
      shouldDeny: false,
    },
    {
      ctx: TEST_CONTEXT,
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => true,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
      handleAuthorizedTelegramEditedMessage: async () => {},
      handleUnboundTelegramTopicMessage: async () => {
        events.push("unbound-topic");
      },
    },
  );
  assert.deepEqual(events, ["unbound-topic"]);
});

test("executeTelegramUpdatePlan with handleUnboundTelegramTopicMessage falls through for message without threadId", async () => {
  const events: string[] = [];
  await executeTelegramUpdatePlan(
    {
      kind: "message",
      message: {
        message_id: 43,
        chat: { id: 1, type: "private" },
        from: { id: 1, is_bot: false, first_name: "Test" },
        date: 1001,
        text: "hi",
      },
      shouldPair: false,
      shouldNotifyPaired: false,
      shouldDeny: false,
    },
    {
      ctx: TEST_CONTEXT,
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => true,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
      handleAuthorizedTelegramEditedMessage: async () => {},
      handleUnboundTelegramTopicMessage: async () => {
        events.push("unbound-topic");
      },
    },
  );
  assert.deepEqual(events, ["message"]);
});

test("executeTelegramUpdatePlan with foreign target ownership skips unbound handler", async () => {
  const events: string[] = [];
  await executeTelegramUpdatePlan(
    {
      kind: "message",
      message: {
        message_id: 44,
        chat: { id: 2, type: "private" },
        message_thread_id: 200,
        from: { id: 1, is_bot: false, first_name: "Test" },
        date: 1002,
        text: "hi",
      },
      shouldPair: false,
      shouldNotifyPaired: false,
      shouldDeny: false,
    },
    {
      ctx: TEST_CONTEXT,
      getCurrentInstanceId: () => "current",
      getTargetOwnership: () => ({ instanceId: "other" }),
      foreignOwnedUpdateForwarder: {
        forwardMessage: async () => {
          events.push("forwarded");
          return acceptedForeignUpdateSettlement();
        },
      },
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => true,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
      handleAuthorizedTelegramEditedMessage: async () => {},
      handleUnboundTelegramTopicMessage: async () => {
        events.push("unbound-topic");
      },
    },
  );
  assert.deepEqual(events, ["forwarded"]);
});

test("Admission handle binds source ids after public interception and returns queued receipts", async () => {
  const rawUpdate = {
    update_id: 71,
    message: {
      message_id: 9,
      chat: { id: 5, type: "private" },
      from: { id: 7, is_bot: false },
    },
  };
  const publicUpdates: unknown[] = [];
  const registry: TelegramUpdateHandlerRegistry = {
    version: 1,
    add: () => () => {},
    dispatch: async (update) => {
      publicUpdates.push(structuredClone(update));
      return "pass";
    },
  };
  const handle = createTelegramUpdateAdmissionHandle({
    registry,
    defaultHandle: async (update) => {
      assert.equal(
        (update.message as { pi_telegram_source_update_id?: number })
          .pi_telegram_source_update_id,
        71,
      );
      reportTelegramQueueAdmission([update.message], [
        {
          queueKind: "prompt",
          receiptId: "receipt-71",
          sourceUpdateIds: [71],
        },
      ]);
    },
  });

  const outcome = await handle(
    rawUpdate,
    "ctx",
    new AbortController().signal,
  );
  assert.deepEqual(outcome, {
    kind: "queued",
    queueKind: "prompt",
    receiptId: "receipt-71",
    sourceUpdateIds: [71],
  });
  assert.deepEqual(publicUpdates, [rawUpdate]);
  assert.equal(
    (rawUpdate.message as { pi_telegram_source_update_id?: number })
      .pi_telegram_source_update_id,
    undefined,
  );
});

test("Queue admission validates every grouped source before publishing reports", () => {
  const reports: unknown[] = [];
  const first = bindTelegramUpdateAdmissionSource(
    {
      update_id: 71,
      message: {
        message_id: 9,
        chat: { id: 5, type: "private" },
        from: { id: 7, is_bot: false },
      },
    },
    (outcome) => reports.push(outcome),
  );
  const second = bindTelegramUpdateAdmissionSource(
    {
      update_id: 72,
      message: {
        message_id: 10,
        chat: { id: 5, type: "private" },
        from: { id: 7, is_bot: false },
      },
    },
    (outcome) => reports.push(outcome),
  );

  assert.throws(
    () =>
      reportTelegramQueueAdmission([first.message, second.message], [
        {
          queueKind: "prompt",
          receiptId: "partial-receipt",
          sourceUpdateIds: [71],
        },
      ]),
    /update 72 requires one exact queue receipt/u,
  );
  assert.deepEqual(reports, []);
  assert.throws(
    () =>
      reportTelegramQueueAdmission([first.message, second.message], [
        {
          queueKind: "prompt",
          receiptId: "grouped-receipt",
          sourceUpdateIds: [71, 72],
        },
        {
          queueKind: "prompt",
          receiptId: "overlapping-receipt",
          sourceUpdateIds: [71],
        },
      ]),
    /update 71 requires one exact queue receipt/u,
  );
  assert.deepEqual(reports, []);
});

test("Admission handle exposes an abort-aware execution fence to public and built-in paths", async () => {
  const controller = new AbortController();
  const publicFences: unknown[] = [];
  const builtInFences: unknown[] = [];
  const handle = createTelegramUpdateAdmissionHandle({
    registry: {
      version: 1,
      add: () => () => {},
      async dispatch(_update, execution) {
        publicFences.push(execution);
        execution?.assertCurrent();
        return "pass";
      },
    },
    defaultHandle: async (update, _ctx, execution) => {
      builtInFences.push(execution);
      execution?.assertCurrent();
      const clone = carryTelegramUpdateExecutionFence(update, { ...update });
      assert.equal(getTelegramUpdateExecutionFence(clone), execution);
    },
  });
  assert.deepEqual(
    await handle(
      { update_id: 73 },
      "ctx",
      controller.signal,
    ),
    { kind: "complete" },
  );
  assert.equal(publicFences.length, 1);
  assert.equal(builtInFences[0], publicFences[0]);
  const fence = publicFences[0] as {
    generation: number;
    updateId: number;
    signal: AbortSignal;
    isCurrent(): boolean;
    assertCurrent(): void;
  };
  assert.equal(fence.generation, 1);
  assert.equal(fence.updateId, 73);
  assert.equal(fence.signal, controller.signal);
  assert.equal(fence.isCurrent(), true);
  controller.abort();
  assert.equal(fence.isCurrent(), false);
  assert.throws(() => fence.assertCurrent(), /Abort/u);
});

test("Admission handle rejects a public consume verdict after its generation is aborted", async () => {
  const controller = new AbortController();
  let publicEffectCount = 0;
  let defaultEffectCount = 0;
  const handle = createTelegramUpdateAdmissionHandle({
    registry: {
      version: 1,
      add: () => () => {},
      async dispatch(_update, execution) {
        controller.abort();
        if (execution?.isCurrent()) publicEffectCount += 1;
        return "consume";
      },
    },
    defaultHandle: async () => {
      defaultEffectCount += 1;
    },
  });

  await assert.rejects(
    handle({ update_id: 74 }, "ctx", controller.signal),
    /Abort/u,
  );
  assert.equal(publicEffectCount, 0);
  assert.equal(defaultEffectCount, 0);
});

test("Admission worker settles an exactly classified terminal delivery failure", async () => {
  const storage = createTestUpdateWorkerJournal([{ update_id: 75 }]);
  const failure = new Error("message thread not found");
  let settlementCalls = 0;
  const worker = createTelegramUpdateAdmissionWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    defaultHandle: async () => {
      throw failure;
    },
    async settleTerminalExecutionFailure(error) {
      settlementCalls += 1;
      assert.equal(error, failure);
      return true;
    },
  });

  worker.start("ctx");
  await worker.waitForDrain();
  assert.equal(settlementCalls, 1);
  assert.deepEqual(storage.getUpdateIds(), []);
  assert.equal(worker.getState().retryWaitCount, 0);
  await worker.stop();
});

test("Admission worker preserves retry authority when terminal settlement is rejected", async () => {
  const storage = createTestUpdateWorkerJournal([{ update_id: 76 }]);
  const worker = createTelegramUpdateAdmissionWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    defaultHandle: async () => {
      throw new Error("transient delivery failure");
    },
    settleTerminalExecutionFailure: async () => false,
  });

  worker.start("ctx");
  await worker.waitForDrain();
  assert.deepEqual(storage.getUpdateIds(), [76]);
  assert.equal(storage.getEntries()[0]?.state, "retry-wait");
  await worker.stop();
});

test("Admission worker delays replacement public effects until the superseded handler settles", async () => {
  const storage = createTestUpdateWorkerJournal([{ update_id: 75 }]);
  const effects: string[] = [];
  let publicCalls = 0;
  let firstExecution: TelegramUpdateExecutionFence | undefined;
  let releaseFirst: () => void = () => assert.fail("first handler missing");
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const worker = createTelegramUpdateAdmissionWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    registry: {
      version: 1,
      add: () => () => {},
      async dispatch(_update, execution) {
        publicCalls += 1;
        if (publicCalls === 1) {
          firstExecution = execution;
          await firstGate;
          if (execution?.isCurrent()) effects.push("generation-1");
          return "consume";
        }
        execution?.assertCurrent();
        effects.push("generation-2");
        return "consume";
      },
    },
    defaultHandle: async () => assert.fail("consume reached default routing"),
  });

  worker.start("generation-1");
  await waitForUpdateWorkerCondition(
    () => publicCalls === 1 && firstExecution !== undefined,
    "generation 1 did not enter the public handler",
  );
  await worker.stop();
  assert.equal(firstExecution?.signal.aborted, true);
  worker.start("generation-2");
  await waitForUpdateWorkerCondition(
    () => worker.getState().blockedReason === "prior-generation-executing",
    "replacement did not wait for the public handler",
  );
  assert.equal(publicCalls, 1);
  assert.deepEqual(effects, []);

  releaseFirst();
  await worker.waitForDrain();
  assert.equal(publicCalls, 2);
  assert.deepEqual(effects, ["generation-2"]);
  assert.deepEqual(storage.getUpdateIds(), []);
  await worker.stop();
});

test("Admission worker blocks replacement queue commit until the abort-ignoring path settles", async () => {
  const storage = createTestUpdateWorkerJournal([{
    update_id: 76,
    message: {
      message_id: 76,
      chat: { id: 1, type: "private" },
      from: { id: 1, is_bot: false },
    },
  }]);
  const queueEffects: string[] = [];
  let executionCount = 0;
  let firstExecution: TelegramUpdateExecutionFence | undefined;
  let releaseFirst: () => void = () => assert.fail("first execution missing");
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const worker = createTelegramUpdateAdmissionWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    registry: {
      version: 1,
      add: () => () => {},
      dispatch: async () => "pass",
    },
    defaultHandle: async (update, _ctx, execution) => {
      executionCount += 1;
      if (executionCount === 1) {
        firstExecution = execution;
        await firstGate;
        if (execution?.isCurrent()) queueEffects.push("generation-1");
        return;
      }
      execution?.assertCurrent();
      queueEffects.push("generation-2");
      reportTelegramQueueAdmission([update.message], [{
        queueKind: "prompt",
        receiptId: "queue-76",
        sourceUpdateIds: [76],
      }]);
    },
  });

  worker.start("generation-1");
  await waitForUpdateWorkerCondition(
    () => executionCount === 1 && firstExecution !== undefined,
    "generation 1 did not enter the built-in path",
  );
  await worker.stop();
  assert.equal(firstExecution?.signal.aborted, true);
  worker.start("generation-2");
  await waitForUpdateWorkerCondition(
    () => worker.getState().blockedReason === "prior-generation-executing",
    "replacement did not wait for the queue path",
  );
  assert.equal(executionCount, 1);
  assert.deepEqual(queueEffects, []);

  releaseFirst();
  await worker.waitForDrain();
  assert.equal(executionCount, 2);
  assert.deepEqual(queueEffects, ["generation-2"]);
  assert.equal(worker.getState().queuedClaimCount, 1);
  await worker.stop();
});

test("Admission handle binds its execution fence to every internal update carrier", async () => {
  const controller = new AbortController();
  const carriers: unknown[] = [];
  const handle = createTelegramUpdateAdmissionHandle({
    registry: {
      version: 1,
      add: () => () => {},
      dispatch: async () => "pass",
    },
    defaultHandle: async (update, _ctx, execution) => {
      carriers.push(
        update,
        update.message,
        update.edited_message,
        update.callback_query,
        update.callback_query?.message,
        update.guest_message,
        update.message_reaction,
      );
      for (const carrier of carriers) {
        assert.equal(getTelegramUpdateExecutionFence(carrier), execution);
      }
    },
  });

  assert.deepEqual(
    await handle(
      {
        update_id: 75,
        message: {
          message_id: 1,
          chat: { id: 1, type: "private" },
          from: { id: 1, is_bot: false },
        },
        edited_message: {
          message_id: 2,
          chat: { id: 1, type: "private" },
          from: { id: 1, is_bot: false },
        },
        callback_query: {
          id: "callback-75",
          from: { id: 1, is_bot: false },
          message: {
            message_id: 3,
            chat: { id: 1, type: "private" },
          },
        },
        guest_message: {
          guest_query_id: "guest-75",
          chat: { id: 1, type: "private" },
          from: { id: 1, is_bot: false },
        },
        message_reaction: {
          chat: { id: 1, type: "private" },
          user: { id: 1, is_bot: false },
          message_id: 4,
          old_reaction: [],
          new_reaction: [],
        },
      },
      "ctx",
      controller.signal,
    ),
    { kind: "complete" },
  );
});

test("Update execution plan fences pairing, forwarding, replies, and handlers", async () => {
  const effectCases: readonly {
    name: string;
    plan: Parameters<typeof executeTelegramUpdatePlan>[0];
    configure: (deps: Record<string, unknown>, effect: () => void) => void;
  }[] = [
    {
      name: "pairing persistence",
      plan: {
        kind: "message",
        message: {
          message_id: 1,
          chat: { id: 1, type: "private" },
          from: { id: 1, is_bot: false },
        },
        shouldPair: true,
        shouldNotifyPaired: false,
        shouldDeny: false,
      },
      configure(deps, effect) {
        deps.pairTelegramUserIfNeeded = async () => {
          effect();
          return true;
        };
      },
    },
    {
      name: "follower forwarding",
      plan: {
        kind: "message",
        message: {
          message_id: 2,
          chat: { id: 1, type: "private" },
          from: { id: 1, is_bot: false },
        },
        shouldPair: false,
        shouldNotifyPaired: false,
        shouldDeny: false,
      },
      configure(deps, effect) {
        deps.getCurrentInstanceId = () => "leader";
        deps.getMessageOwnership = () => ({ instanceId: "follower" });
        deps.foreignOwnedUpdateForwarder = {
          forwardMessage: async () => {
            effect();
            return acceptedForeignUpdateSettlement();
          },
        };
      },
    },
    {
      name: "Telegram reply",
      plan: {
        kind: "message",
        message: {
          message_id: 3,
          chat: { id: 1, type: "private" },
          from: { id: 2, is_bot: false },
        },
        shouldPair: false,
        shouldNotifyPaired: false,
        shouldDeny: true,
      },
      configure(deps, effect) {
        deps.sendTextReply = async () => {
          effect();
          return undefined;
        };
      },
    },
    {
      name: "built-in handler",
      plan: {
        kind: "message",
        message: {
          message_id: 4,
          chat: { id: 1, type: "private" },
          from: { id: 1, is_bot: false },
        },
        shouldPair: false,
        shouldNotifyPaired: false,
        shouldDeny: false,
      },
      configure(deps, effect) {
        deps.handleAuthorizedTelegramMessage = async () => effect();
      },
    },
  ];

  for (const effectCase of effectCases) {
    let effectCount = 0;
    const execution: TelegramUpdateExecutionFence = {
      generation: 1,
      updateId: 75,
      signal: AbortSignal.abort(),
      isCurrent: () => false,
      assertCurrent() {
        throw new DOMException("Aborted", "AbortError");
      },
    };
    const deps: Record<string, unknown> = {
      ctx: TEST_CONTEXT,
      execution,
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => false,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {},
      handleAuthorizedTelegramEditedMessage: async () => {},
    };
    effectCase.configure(deps, () => {
      effectCount += 1;
    });
    await assert.rejects(
      executeTelegramUpdatePlan(
        effectCase.plan,
        deps as unknown as Parameters<typeof executeTelegramUpdatePlan>[1],
      ),
      /Abort/u,
      effectCase.name,
    );
    assert.equal(effectCount, 0, effectCase.name);
  }
});

test("Admission handle returns deferred immediately and owns late queue settlement", async () => {
  let boundMessage: unknown;
  const lateOutcomes: unknown[] = [];
  const lateErrors: unknown[] = [];
  const controller = new AbortController();
  const handle = createTelegramUpdateAdmissionHandle({
    registry: {
      version: 1,
      add: () => () => {},
      dispatch: async () => "pass",
    },
    defaultHandle: async (update) => {
      boundMessage = update.message;
      assert.equal(reportTelegramUpdateDeferred(update.message), true);
    },
    onLateOutcome: (outcome, details) => {
      lateOutcomes.push({ outcome, updateId: details.updateId, ctx: details.ctx });
    },
    onLateOutcomeError: (error) => lateErrors.push(error),
  });

  const initial = await handle(
    {
      update_id: 72,
      message: {
        message_id: 10,
        chat: { id: 5, type: "private" },
        from: { id: 7, is_bot: false },
      },
    },
    "ctx",
    controller.signal,
  );
  assert.deepEqual(initial, { kind: "deferred" });
  reportTelegramQueueAdmission([boundMessage], [
    {
      queueKind: "prompt",
      receiptId: "receipt-72",
      sourceUpdateIds: [72],
    },
  ]);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(lateOutcomes, [
    {
      outcome: {
        kind: "queued",
        queueKind: "prompt",
        receiptId: "receipt-72",
        sourceUpdateIds: [72],
      },
      updateId: 72,
      ctx: "ctx",
    },
  ]);
  assert.deepEqual(lateErrors, []);
});

test("Registry is created lazily on first access and reused", () => {
  clearGlobalRegistry();
  assert.equal(getGlobalRegistry(), undefined);
  const first = getTelegramUpdateHandlerRegistry();
  assert.equal(first.version, 1);
  const second = getTelegramUpdateHandlerRegistry();
  assert.equal(first, second);
  assert.equal(getGlobalRegistry(), first);
  clearGlobalRegistry();
});

test("Registry is shared across import paths via globalThis", () => {
  clearGlobalRegistry();
  const fromHelper = getTelegramUpdateHandlerRegistry();
  const fromGlobal = getGlobalRegistry();
  assert.equal(fromHelper, fromGlobal);
  clearGlobalRegistry();
});

test("Dispatch returns 'pass' when no handlers are registered", async () => {
  clearGlobalRegistry();
  const registry = getTelegramUpdateHandlerRegistry();
  const verdict = await registry.dispatch({ update_id: 1 });
  assert.equal(verdict, "pass");
  clearGlobalRegistry();
});

test("registerTelegramUpdateHandler registers handlers and disposer removes them", async () => {
  clearGlobalRegistry();
  const seen: unknown[] = [];
  const handler: TelegramUpdateHandler = (update) => {
    seen.push(update);
    return "pass";
  };
  const off = registerTelegramUpdateHandler(handler);
  await getTelegramUpdateHandlerRegistry().dispatch({ update_id: 1 });
  assert.deepEqual(seen, [{ update_id: 1 }]);
  off();
  await getTelegramUpdateHandlerRegistry().dispatch({ update_id: 2 });
  assert.deepEqual(seen, [{ update_id: 1 }]);
  clearGlobalRegistry();
});

test("Consume short-circuits later handlers and bubbles up to dispatch", async () => {
  clearGlobalRegistry();
  const calls: string[] = [];
  const off1 = registerTelegramUpdateHandler((update) => {
    calls.push("first");
    const cb = (update as { callback_query?: { data?: string } })
      .callback_query;
    if (cb?.data === "myext:ok") return "consume";
    return "pass";
  });
  const off2 = registerTelegramUpdateHandler(() => {
    calls.push("second");
    return "pass";
  });
  const consumed = await getTelegramUpdateHandlerRegistry().dispatch({
    callback_query: { data: "myext:ok" },
  });
  assert.equal(consumed, "consume");
  assert.deepEqual(calls, ["first"]);

  calls.length = 0;
  const passed = await getTelegramUpdateHandlerRegistry().dispatch({
    callback_query: { data: "other" },
  });
  assert.equal(passed, "pass");
  assert.deepEqual(calls, ["first", "second"]);
  off1();
  off2();
  clearGlobalRegistry();
});

test("Handler errors do not break polling and do not consume the update", async () => {
  clearGlobalRegistry();
  const calls: string[] = [];
  const offThrow = registerTelegramUpdateHandler(() => {
    calls.push("thrower");
    throw new Error("boom");
  });
  const offAfter = registerTelegramUpdateHandler(() => {
    calls.push("after");
    return "pass";
  });
  const verdict = await getTelegramUpdateHandlerRegistry().dispatch({
    update_id: 1,
  });
  assert.equal(verdict, "pass");
  assert.deepEqual(calls, ["thrower", "after"]);
  offThrow();
  offAfter();
  clearGlobalRegistry();
});

test("Void/undefined return values are treated as 'pass'", async () => {
  clearGlobalRegistry();
  const off = registerTelegramUpdateHandler(() => undefined);
  const verdict = await getTelegramUpdateHandlerRegistry().dispatch({
    update_id: 1,
  });
  assert.equal(verdict, "pass");
  off();
  clearGlobalRegistry();
});

test("createTelegramUpdateHandle skips defaultHandle on consume", async () => {
  clearGlobalRegistry();
  const defaultCalls: number[] = [];
  const defaultHandle = async (update: { update_id: number }) => {
    defaultCalls.push(update.update_id);
  };
  const off = registerTelegramUpdateHandler((update) => {
    const id = (update as { update_id?: number }).update_id;
    return id === 99 ? "consume" : "pass";
  });
  const handler = createTelegramUpdateHandle({ defaultHandle });
  await handler({ update_id: 1 }, undefined);
  await handler({ update_id: 99 }, undefined);
  await handler({ update_id: 2 }, undefined);
  assert.deepEqual(defaultCalls, [1, 2]);
  off();
  clearGlobalRegistry();
});

test("createTelegramUpdateHandle calls defaultHandle when no handlers registered", async () => {
  clearGlobalRegistry();
  const defaultCalls: unknown[] = [];
  const defaultHandle = async (update: { update_id: number }, ctx: string) => {
    defaultCalls.push({ update, ctx });
  };
  const handler = createTelegramUpdateHandle({ defaultHandle });
  await handler({ update_id: 7 }, "ctx");
  assert.deepEqual(defaultCalls, [{ update: { update_id: 7 }, ctx: "ctx" }]);
  clearGlobalRegistry();
});

test("Pre-existing docs-style registry missing 'dispatch' is replaced with a valid one", async () => {
  clearGlobalRegistry();
  const docsHandlers = new Set<TelegramUpdateHandler>();
  const docsStyle = {
    version: 1,
    add(handler: TelegramUpdateHandler) {
      docsHandlers.add(handler);
      return () => docsHandlers.delete(handler);
    },
  };
  (globalThis as Record<string, unknown>)[REGISTRY_KEY] = docsStyle;

  const registry = getTelegramUpdateHandlerRegistry();
  assert.notEqual(registry, docsStyle as unknown);
  assert.equal(registry.version, 1);
  assert.equal(typeof registry.add, "function");
  assert.equal(typeof registry.dispatch, "function");
  const verdict = await registry.dispatch({ update_id: 1 });
  assert.equal(verdict, "pass");
  assert.equal(getGlobalRegistry(), registry);
  clearGlobalRegistry();
});

test("Pre-existing malformed registry (wrong types) is replaced", async () => {
  clearGlobalRegistry();
  const malformed = {
    version: 1,
    add: "not a function",
    dispatch: 42,
  };
  (globalThis as Record<string, unknown>)[REGISTRY_KEY] = malformed;

  const registry = getTelegramUpdateHandlerRegistry();
  assert.notEqual(registry, malformed as unknown);
  assert.equal(typeof registry.add, "function");
  assert.equal(typeof registry.dispatch, "function");
  const verdict = await registry.dispatch({ update_id: 1 });
  assert.equal(verdict, "pass");
  clearGlobalRegistry();
});

test("Pre-existing registry with future version is replaced (v1 runtime, v2 squatter)", () => {
  clearGlobalRegistry();
  const futureShape = {
    version: 2,
    add: () => () => {},
    dispatch: async () => "pass" as const,
  };
  (globalThis as Record<string, unknown>)[REGISTRY_KEY] = futureShape;

  const registry = getTelegramUpdateHandlerRegistry();
  assert.notEqual(registry, futureShape as unknown);
  assert.equal(registry.version, 1);
  clearGlobalRegistry();
});

test("Pre-existing fully-formed v1 registry from a layered extension is reused", async () => {
  clearGlobalRegistry();
  const handlers = new Set<TelegramUpdateHandler>();
  const layered: TelegramUpdateHandlerRegistry = {
    version: 1,
    add(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async dispatch(update) {
      for (const handler of handlers) {
        const result = await handler(update);
        if (result === "consume") return "consume";
      }
      return "pass";
    },
  };
  (globalThis as Record<string, unknown>)[REGISTRY_KEY] = layered;

  const registry = getTelegramUpdateHandlerRegistry();
  assert.equal(registry, layered);

  const seen: unknown[] = [];
  const off = registerTelegramUpdateHandler((update) => {
    seen.push(update);
    return "pass";
  });
  await registry.dispatch({ update_id: 1 });
  assert.deepEqual(seen, [{ update_id: 1 }]);
  off();
  clearGlobalRegistry();
});

test("Pre-existing non-object value at registry key is replaced", () => {
  clearGlobalRegistry();
  (globalThis as Record<string, unknown>)[REGISTRY_KEY] = "not an object";
  const registry = getTelegramUpdateHandlerRegistry();
  assert.equal(registry.version, 1);
  assert.equal(typeof registry.dispatch, "function");
  clearGlobalRegistry();
});

test("createTelegramUpdateHandle accepts an explicit registry override", async () => {
  clearGlobalRegistry();
  const seen: unknown[] = [];
  const customRegistry: TelegramUpdateHandlerRegistry = {
    version: 1,
    add: () => () => {},
    async dispatch(update) {
      seen.push(update);
      return "consume";
    },
  };
  const defaultCalls: unknown[] = [];
  const handler = createTelegramUpdateHandle({
    defaultHandle: async (update) => {
      defaultCalls.push(update);
    },
    registry: customRegistry,
  });
  await handler({ update_id: 1 }, undefined);
  assert.deepEqual(seen, [{ update_id: 1 }]);
  assert.deepEqual(defaultCalls, []);
  assert.equal(getGlobalRegistry(), undefined);
  clearGlobalRegistry();
});

type ForeignSettlementTestUpdate = TelegramJournaledUpdate & TelegramUpdateFlow;

async function runForeignSettlementWorker(
  update: ForeignSettlementTestUpdate,
  settlement: TelegramBusForeignUpdateSettlement,
): Promise<{
  entries: TelegramUpdateWorkerJournalSnapshot["entries"];
  updateIds: number[];
  removals: number[][];
  phase: string;
  callbackAnswers: number;
}> {
  const storage = createTestUpdateWorkerJournal([update]);
  let callbackAnswers = 0;
  const forward = () => settlement;
  const runtime = createTelegramUpdateRuntime<string, ForeignSettlementTestUpdate>({
    getAllowedUserId: () => 7,
    getCurrentInstanceId: () => "leader",
    getMessageOwnership: () => ({
      instanceId: "follower",
      ownerGeneration: "generation-b",
      recipientBindingKey: "manual:owner-b",
    }),
    getTargetOwnership: () => ({
      instanceId: "follower",
      ownerGeneration: "generation-b",
      recipientBindingKey: "manual:owner-b",
    }),
    foreignOwnedUpdateForwarder: {
      forwardCallback: forward,
      forwardReaction: forward,
      forwardMessage: forward,
      forwardEditedMessage: forward,
    },
    removePendingMediaGroupMessages: () => {},
    removeQueuedTelegramTurnsByMessageIds: () => 0,
    applyQueuedTelegramTurnReactionByMessageId: () => false,
    pairTelegramUserIfNeeded: async () => false,
    answerCallbackQuery: async () => {
      callbackAnswers += 1;
    },
    answerGuestQuery: async () => {},
    handleAuthorizedTelegramCallbackQuery: async () => {
      assert.fail("Foreign callback reached local handling.");
    },
    sendTextReply: async () => undefined,
    handleAuthorizedTelegramMessage: async () => {
      assert.fail("Foreign message reached local handling.");
    },
    handleAuthorizedTelegramEditedMessage: async () => {
      assert.fail("Foreign edit reached local handling.");
    },
  });
  const worker = createTelegramUpdateAdmissionWorkerRuntime<
    ForeignSettlementTestUpdate,
    string
  >({
    journal: storage.journal,
    defaultHandle: runtime.handleUpdate,
    registry: {
      version: 1,
      add: () => () => {},
      dispatch: async () => "pass",
    },
    hasAuthority: () => true,
  });
  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  const phase = worker.getState().phase;
  await worker.stop();
  return {
    entries: storage.getEntries(),
    updateIds: storage.getUpdateIds(),
    removals: storage.getRemovals(),
    phase,
    callbackAnswers,
  };
}

const foreignSettlementUpdateCases: readonly {
  name: string;
  create: (updateId: number) => ForeignSettlementTestUpdate;
}[] = [
  {
    name: "message",
    create: (updateId) => ({
      update_id: updateId,
      message: {
        chat: { id: 7, type: "private" },
        from: { id: 7, is_bot: false },
        message_id: updateId,
        message_thread_id: 42,
      },
    }),
  },
  {
    name: "edited message",
    create: (updateId) => ({
      update_id: updateId,
      edited_message: {
        chat: { id: 7, type: "private" },
        from: { id: 7, is_bot: false },
        message_id: updateId,
        message_thread_id: 42,
      },
    }),
  },
  {
    name: "reaction",
    create: (updateId) => ({
      update_id: updateId,
      message_reaction: {
        chat: { id: 7, type: "private" },
        user: { id: 7, is_bot: false },
        message_id: updateId,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    }),
  },
  {
    name: "callback",
    create: (updateId) => ({
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        from: { id: 7, is_bot: false },
        message: {
          chat: { id: 7, type: "private" },
          message_id: updateId,
          message_thread_id: 42,
        },
      },
    }),
  },
];

test("Admission worker retains every foreign update kind after non-acceptance", async () => {
  const failures = [
    {
      name: "negative ACK",
      status: "retryable" as const,
      failureClass: "acknowledgement-rejected" as const,
      message: "Follower rejected the update.",
    },
    {
      name: "missing ACK",
      status: "retryable" as const,
      failureClass: "acknowledgement-missing" as const,
      message: "Follower returned no acknowledgement.",
    },
    {
      name: "stale-generation ACK",
      status: "retryable" as const,
      failureClass: "acknowledgement-rejected" as const,
      message: "Stale Telegram bus follower registration generation.",
    },
    {
      name: "mismatched receipt ACK",
      status: "terminal-rejected" as const,
      failureClass: "durable-receipt-mismatched" as const,
      message: "Follower returned a mismatched durable receipt.",
    },
  ];
  let updateId = 700;
  for (const updateCase of foreignSettlementUpdateCases) {
    for (const failure of failures) {
      updateId += 1;
      const delivery = acceptedForeignUpdateSettlement(updateId).delivery;
      const result = await runForeignSettlementWorker(
        updateCase.create(updateId),
        { ...failure, delivery },
      );
      const label = `${updateCase.name} / ${failure.name}`;
      assert.deepEqual(result.updateIds, [updateId], label);
      assert.deepEqual(result.removals, [], label);
      assert.equal(result.phase, "idle", label);
      assert.equal(result.entries[0]?.state, "retry-wait", label);
      assert.equal(result.entries[0]?.failure?.attemptCount, 1, label);
      assert.equal(
        result.entries[0]?.failure?.failureClass,
        failure.failureClass,
        label,
      );
      assert.equal(
        result.callbackAnswers,
        updateCase.name === "callback" ? 1 : 0,
        label,
      );
    }
  }
});

test("Admission worker completes every foreign update kind only after exact acceptance", async () => {
  let updateId = 800;
  for (const updateCase of foreignSettlementUpdateCases) {
    updateId += 1;
    const result = await runForeignSettlementWorker(
      updateCase.create(updateId),
      acceptedForeignUpdateSettlement(updateId),
    );
    assert.deepEqual(result.updateIds, [], updateCase.name);
    assert.deepEqual(result.removals, [[updateId]], updateCase.name);
    assert.equal(result.phase, "idle", updateCase.name);
    assert.equal(result.callbackAnswers, 0, updateCase.name);
  }
});

test("Conflicting queued receipts expose exact ids without settling either source", async () => {
  const storage = createTestUpdateWorkerJournal([1, 2]);
  const events: Array<{ category: string; details?: Record<string, unknown> }> = [];
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal, hasAuthority: () => true,
    executeUpdate: (update) => ({
      kind: "queued", queueKind: "prompt", receiptId: "shared-receipt",
      sourceUpdateIds: [update.update_id],
    }),
    recordRuntimeEvent: (category, _error, details) => { events.push({ category, details }); },
  });
  try {
    worker.start(TEST_CONTEXT);
    await worker.waitForDrain();
    const event = events.find((entry) => entry.details?.phase === "queue-receipt-conflict");
    assert.ok(event);
    assert.equal(event.category, "inbound-worker");
    assert.equal(event.details?.receiptId, "shared-receipt");
    assert.deepEqual(event.details?.sourceUpdateIds, [2]);
    assert.deepEqual(storage.getUpdateIds(), [1, 2]);
    assert.deepEqual(storage.getRemovals(), []);
  } finally {
    await worker.stop();
  }
});

test("Update worker drains one validated snapshot per bounded batch", async () => {
  const storage = createTestUpdateWorkerJournal([1, 2, 3, 4, 5]);
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    batchSize: 2,
    yieldToEventLoop: async () => {},
    executeUpdate: () => ({ kind: "complete" }),
  });

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  assert.equal(storage.getReadCount(), 4);
  assert.deepEqual(storage.getRemovals(), [[1, 2], [3, 4], [5]]);
  await worker.stop();
});

test("Update worker yields between bounded execution batches", async () => {
  const storage = createTestUpdateWorkerJournal([1, 2, 3, 4, 5]);
  const events: string[] = [];
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    batchSize: 2,
    yieldToEventLoop: async () => {
      events.push("yield");
    },
    executeUpdate(update) {
      events.push(`execute:${update.update_id}`);
      return { kind: "complete" };
    },
  });

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  assert.deepEqual(events, [
    "execute:1",
    "execute:2",
    "yield",
    "execute:3",
    "execute:4",
    "yield",
    "execute:5",
  ]);
  assert.deepEqual(storage.getUpdateIds(), []);
  await worker.stop();
});

test("Update worker keeps heartbeat timers responsive while draining thousands", async () => {
  const entryCount = 2_048;
  const storage = createTestUpdateWorkerJournal(
    Array.from({ length: entryCount }, (_, index) => index + 1),
  );
  const heartbeatDelaysMs: number[] = [];
  let expectedHeartbeatAtMs = Date.now();
  const heartbeat = setInterval(() => {
    const nowMs = Date.now();
    heartbeatDelaysMs.push(nowMs - expectedHeartbeatAtMs);
    expectedHeartbeatAtMs = nowMs + 1;
  }, 1);
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    executeUpdate: () => ({ kind: "complete" }),
  });

  try {
    worker.start(TEST_CONTEXT);
    await worker.waitForDrain();
  } finally {
    clearInterval(heartbeat);
    await worker.stop();
  }
  assert.deepEqual(storage.getUpdateIds(), []);
  assert.equal(storage.getRemovals().length, entryCount / 64);
  assert.equal(storage.getReadCount(), entryCount / 64 + 1);
  assert.ok(
    heartbeatDelaysMs.length >= 8,
    `expected heartbeat progress, observed ${heartbeatDelaysMs.length} ticks`,
  );
  const maxHeartbeatDelayMs = Math.max(...heartbeatDelaysMs);
  assert.ok(
    maxHeartbeatDelayMs < 250,
    `maximum heartbeat delay was ${maxHeartbeatDelayMs}ms`,
  );
});

test("Update worker aborts safely while yielding between batches", async () => {
  const storage = createTestUpdateWorkerJournal([1, 2, 3]);
  const executed: number[] = [];
  let worker: ReturnType<typeof createTelegramUpdateWorkerRuntime<string>>;
  worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    batchSize: 1,
    yieldToEventLoop: async () => {
      void worker.stop();
    },
    executeUpdate(update) {
      executed.push(update.update_id);
      return { kind: "complete" };
    },
  });

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  assert.deepEqual(executed, [1]);
  assert.deepEqual(storage.getUpdateIds(), [2, 3]);
});

test("Update worker scans past deferred and queued claims while completing terminal outcomes", async () => {
  const storage = createTestUpdateWorkerJournal([1, 2, 3, 4]);
  const executed: number[] = [];
  const completed: number[] = [];
  const phases: string[] = [];
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    executeUpdate(update) {
      executed.push(update.update_id);
      if (update.update_id === 1) return { kind: "deferred" };
      if (update.update_id === 2) {
        return {
          kind: "queued",
          queueKind: "prompt",
          receiptId: "queue-1",
          sourceUpdateIds: [1, 2],
        };
      }
      return { kind: "complete" };
    },
    onStateChange(state) {
      phases.push(`${state.phase}:${state.currentUpdateId ?? "none"}`);
    },
    onUpdateCompleted(updateId) {
      completed.push(updateId);
    },
  });

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();

  assert.deepEqual(executed, [1, 2, 3, 4]);
  assert.deepEqual(completed, [3, 4]);
  assert.deepEqual(storage.getUpdateIds(), [1, 2]);
  assert.deepEqual(storage.getRemovals(), [[3, 4]]);
  assert.deepEqual(storage.getQueueReceipts(), [
    {
      queueKind: "prompt",
      receiptId: "queue-1",
      sourceUpdateIds: [1, 2],
    },
  ]);
  assert.ok(phases.includes("deferred:1"));
  assert.ok(phases.includes("queued:2"));
  assert.deepEqual(worker.getState(), {
    phase: "idle",
    generation: 1,
    phaseStartedAtMs: worker.getState().phaseStartedAtMs,
    currentUpdateId: undefined,
    blockedReason: undefined,
    journalEntryCount: 2,
    journalSerializedBytes: 200,
    oldestAdmittedAtMs: 100,
    deferredClaimCount: 0,
    queuedClaimCount: 2,
    foreignQueuedCount: 0,
    retryWaitCount: 0,
    failedCount: 0,
    nextRetryUpdateId: undefined,
    nextRetryAtMs: undefined,
    nextRetryAttemptCount: undefined,
    nextRetryFailureClass: undefined,
    failedUpdateId: undefined,
    failedFailureId: undefined,
    failedAttemptCount: undefined,
    failedClass: undefined,
    failedSummary: undefined,
    terminalFailureAtMs: undefined,
    unsettledExecutionCount: 0,
    lastCompletedUpdateId: 4,
    lastCompletedAtMs: worker.getState().lastCompletedAtMs,
    lastFailureAtMs: undefined,
    lastFailurePhase: undefined,
  });
  await worker.stop();
  assert.equal(worker.getState().phase, "stopped");
});

test("Update worker owner runtime owns process/session identity and completion hooks", () => {
  const calls: string[] = [];
  let current = true;
  const runtime = createTelegramUpdateWorkerOwnerRuntime<string>({
    instanceId: "instance-a",
    processId: 42,
    processBirthId: "42:start:1",
    getSessionGeneration: () => 7,
    isContextCurrent: () => current,
    dispatchNext: (ctx) => calls.push(`dispatch:${ctx}`),
    requestQueueHandoffReconciliation: (ctx) =>
      calls.push(`reconcile:${ctx}`),
  });
  assert.deepEqual(runtime.getQueueOwnerIdentity(), {
    instanceId: "instance-a",
    processId: 42,
    processBirthId: "42:start:1",
    sessionGeneration: 7,
  });
  runtime.onQueueReceiptCommitted(undefined, "ctx");
  runtime.onUpdateCompleted(1, "ctx");
  current = false;
  runtime.onQueueReceiptCommitted(undefined, "stale");
  assert.deepEqual(calls, ["dispatch:ctx", "reconcile:ctx", "dispatch:ctx"]);
});

test("Admission runtime binding owns late leader and follower selection", async () => {
  let followerRegistered = false;
  const binding = createTelegramUpdateAdmissionRuntimeBinding<string>({
    isFollowerRegistered: () => followerRegistered,
  });
  const calls: string[] = [];
  const createLifecycle = (name: string) =>
    ({
      ownsJournalBinding: (key: string) => key === name,
      hasPendingQueueMutationForItem: () => name === "leader",
      onSessionShutdown: async () => {
        calls.push(name);
      },
    }) as unknown as ReturnType<
      typeof createTelegramUpdateAdmissionLifecycleRuntime<string>
    >;
  const leader = createLifecycle("leader");
  const follower = createLifecycle("follower");
  binding.bind({ leader, follower });

  assert.equal(binding.getActive(), leader);
  followerRegistered = true;
  assert.equal(binding.getActive(), follower);
  assert.equal(binding.getLifecycleForJournalBinding("leader"), leader);
  assert.equal(binding.getLifecycleForJournalBinding("follower"), follower);
  assert.equal(
    binding.hasPendingQueueMutationForItem({
      chatId: 1,
      replyToMessageId: 2,
    }),
    true,
  );
  await binding.onSessionShutdown();
  assert.deepEqual(calls.sort(), ["follower", "leader"]);
});

test("Admission runtime assembly owns queue identity and leader/follower workers", async () => {
  const leaderStorage = createTestUpdateWorkerJournal([1]);
  const followerStorage = createTestUpdateWorkerJournal([2]);
  let followerRegistered = false;
  let followerGeneration: string | undefined = "generation-1";
  const runtimeBinding = createTelegramUpdateAdmissionRuntimeBinding<string>({
    isFollowerRegistered: () => followerRegistered,
  });
  const handled: Array<{ updateId: number; prepared: boolean }> = [];
  const assembly = createTelegramUpdateAdmissionRuntimeAssembly<
    TelegramJournaledUpdate & TelegramUpdateFlow & { prepared?: boolean },
    string
  >({
    runtimeBinding,
    owner: {
      instanceId: "instance-a",
      processId: 42,
      processBirthId: "42:start:1",
      getSessionGeneration: () => 7,
      isContextCurrent: () => true,
      dispatchNext: () => {},
      requestQueueHandoffReconciliation: () => {},
    },
    worker: {
      defaultHandle: async (update) => {
        handled.push({
          updateId: update.update_id,
          prepared: update.prepared === true,
        });
      },
    },
    leader: {
      resolveBinding: () => ({
        runtimeKey: "leader-runtime",
        recoveryKey: "leader-binding",
        journal: {
          ...leaderStorage.journal,
          appendBatch: () => undefined,
        },
      }),
      hasAuthority: () => true,
    },
    follower: {
      resolveBinding: () => ({
        runtimeKey: "follower-runtime",
        recoveryKey: "follower-binding",
        journal: {
          ...followerStorage.journal,
          appendBatch: () => undefined,
        },
      }),
      isRegistered: () => followerRegistered,
      getGeneration: () => followerGeneration,
      prepareUpdateForExecution: (update) => ({
        ...update,
        prepared: true,
      }),
    },
  });

  assert.deepEqual(assembly.owner.getQueueOwnerIdentity(), {
    instanceId: "instance-a",
    processId: 42,
    processBirthId: "42:start:1",
    sessionGeneration: 7,
  });
  await assembly.leader.onSessionStart("leader-context");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(assembly.leader.getJournalBindingKey(), "leader-binding");
  assert.equal(runtimeBinding.getActive(), assembly.leader);

  followerRegistered = true;
  await assembly.follower.onSessionStart("follower-context");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(assembly.follower.getJournalBindingKey(), "follower-binding");
  assert.equal(runtimeBinding.getActive(), assembly.follower);
  assert.deepEqual(handled, [
    { updateId: 1, prepared: false },
    { updateId: 2, prepared: true },
  ]);

  followerGeneration = "generation-2";
  await assembly.follower.onTransportChanged("follower-context");
  assert.equal(assembly.follower.getJournalBindingKey(), "follower-binding");
  await runtimeBinding.onSessionShutdown();
});

test("Admission lifecycle reuses only the active runtime identity without resetting queued authority", async () => {
  const storage = createTestUpdateWorkerJournal([]);
  let runtimeKey = "profile-a:token-1";
  let recoveryKey = "profile-a";
  let createCount = 0;
  const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<string>({
    resolveBinding: () => ({
      runtimeKey,
      recoveryKey,
      journal: {
        ...storage.journal,
        appendBatch: () => undefined,
      },
    }),
    createWorker(journal) {
      createCount += 1;
      return createTelegramUpdateWorkerRuntime({
        journal,
        hasAuthority: () => true,
        executeUpdate: () => ({ kind: "complete" }),
      });
    },
  });

  await lifecycle.onSessionStart("session-1");
  assert.equal(createCount, 1);
  await lifecycle.onSessionShutdown();
  await lifecycle.onSessionStart("session-2");
  assert.equal(createCount, 1);
  assert.equal(lifecycle.getJournalBindingKey(), "profile-a");
  assert.equal(lifecycle.ownsJournalBinding("profile-a"), true);
  assert.equal(lifecycle.ownsJournalBinding("profile-b"), false);

  runtimeKey = "profile-a:token-2";
  await lifecycle.onTransportChanged("session-2");
  assert.equal(createCount, 2);

  runtimeKey = "profile-b:token-1";
  recoveryKey = "profile-b";
  await lifecycle.onTransportChanged("session-2");
  assert.equal(createCount, 3);
  await lifecycle.onSessionShutdown();
});

test("Admission lifecycle resumes legacy terminal authority automatically", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  storage.journal.markExecutionFailure({
    updateId: 1,
    expectedAttemptCount: 0,
    failedAtMs: 100,
    failureClass: "legacy-terminal",
    summary: "Legacy terminal update.",
    disposition: "failed",
    terminalReason: "terminal:legacy-terminal",
  });
  let applied = 0;
  const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<string>({
    resolveBinding: () => ({
      runtimeKey: "legacy-terminal",
      recoveryKey: "legacy-terminal",
      journal: {
        ...storage.journal,
        appendBatch: () => undefined,
        read() {
          const snapshot = storage.journal.read();
          return {
            ...snapshot,
            entries: snapshot.entries.map((entry) => ({
              ...entry,
              terminalFailureId: "failure-legacy",
            })),
          };
        },
        applyOperatorDisposition(input) {
          applied += 1;
          const entry = storage.getEntries()[0]!;
          assert.equal(input.action, "retry");
          assert.equal(input.updateId, entry.updateId);
          return {
            disposition: {
              action: "retry",
              updateId: entry.updateId,
              failureId: input.failureId,
              committedAtMs: 100,
              attemptCount: entry.failure!.attemptCount,
              failureClass: entry.failure!.failureClass,
              terminalAtMs: entry.terminalAtMs!,
              terminalReason: entry.terminalReason!,
            },
            duplicate: false,
            entryCount: 1,
            serializedBytes: 100,
          };
        },
      },
    }),
    createWorker(journal) {
      return createTelegramUpdateWorkerRuntime({
        journal,
        hasAuthority: () => false,
        executeUpdate: () => ({ kind: "complete" }),
      });
    },
  });
  await lifecycle.onSessionStart("session");
  assert.equal(applied, 1);
  await lifecycle.onSessionShutdown();
});

test("Admission lifecycle scopes failed reaction dependencies to their queued target", async () => {
  const storage = createTestUpdateWorkerJournal([
    {
      update_id: 1,
      message_reaction: {
        chat: { id: 7, type: "private" },
        user: { id: 7, is_bot: false },
        message_id: 100,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    },
  ]);
  storage.journal.markExecutionFailure({
    updateId: 1,
    expectedAttemptCount: 0,
    failedAtMs: 100,
    failureClass: "reaction-failed",
    summary: "Reaction mutation failed.",
    disposition: "failed",
    terminalReason: "terminal:reaction-failed",
  });
  const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<string>({
    resolveBinding: () => ({
      runtimeKey: "reaction-target",
      recoveryKey: "reaction-target",
      journal: {
        ...storage.journal,
        appendBatch: () => undefined,
      },
    }),
    createWorker(journal) {
      return createTelegramUpdateWorkerRuntime({
        journal,
        hasAuthority: () => false,
        executeUpdate: () => ({ kind: "complete" }),
      });
    },
  });
  await lifecycle.onSessionStart("session");
  const governed = {
    chatId: 7,
    replyToMessageId: 100,
    sourceMessageIds: [100],
  };
  assert.equal(lifecycle.hasPendingQueueMutationForItem(governed), true);
  assert.equal(
    lifecycle.hasPendingQueueMutationForItem({
      chatId: 7,
      replyToMessageId: 200,
      sourceMessageIds: [200],
    }),
    false,
  );
  assert.equal(
    lifecycle.hasPendingQueueMutationForItem({
      chatId: 8,
      replyToMessageId: 100,
      sourceMessageIds: [100],
    }),
    false,
  );
  storage.journal.removeCompleted([1]);
  assert.equal(lifecycle.hasPendingQueueMutationForItem(governed), false);
  await lifecycle.onSessionShutdown();
});

test("Admission lifecycle recovers confirmed-dead queue authority before worker start", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  const deadOwnerIdentity = {
    instanceId: "dead-instance",
    processId: 101,
    processBirthId: "101:start:dead",
    sessionGeneration: 1,
  };
  storage.journal.markQueued({
    queueKind: "prompt",
    receiptId: "dead-receipt",
    sourceUpdateIds: [1],
    owner: deadOwnerIdentity,
  });
  const events: string[] = [];
  let recoveryCalls = 0;
  const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<string>({
    getQueueOwnerIdentity: () => ({
      instanceId: "replacement-instance",
      processId: 202,
      processBirthId: "202:start:replacement",
      sessionGeneration: 1,
    }),
    resolveBinding: () => ({
      runtimeKey: "dead-owner-profile",
      recoveryKey: "dead-owner-profile",
      journal: {
        ...storage.journal,
        appendBatch: () => undefined,
        recoverDeadQueueOwner(input) {
          recoveryCalls += 1;
          const entry = storage.getEntries()[0]!;
          assert.deepEqual(input.deadOwner, entry.queueOwner);
          storage.journal.removeCompleted([1]);
          return {
            status: "recovered" as const,
            previousOwner: input.deadOwner,
            recoveredUpdateIds: [1],
            entryCount: 0,
            serializedBytes: 0,
          };
        },
      },
    }),
    createWorker(journal) {
      return createTelegramUpdateWorkerRuntime({
        journal,
        hasAuthority: () => true,
        executeUpdate: () => ({ kind: "complete" }),
      });
    },
    recordRuntimeEvent(category, message, details) {
      events.push(`${category}:${String(message)}:${details?.phase}`);
    },
  });

  await lifecycle.onSessionStart("replacement-session");
  assert.equal(recoveryCalls, 1);
  assert.deepEqual(storage.getEntries(), []);
  assert.deepEqual(events, [
    "inbound-worker:Discarded session-owned queue authority from a confirmed-dead process.:dead-queue-owner-cleanup",
  ]);
  await lifecycle.onSessionShutdown();
});

test("Queue handoff coordinator orders exact acceptance before donor removal", async () => {
  const receipt = {
    queueKind: "prompt" as const,
    receiptId: "handoff-receipt",
    sourceUpdateIds: [1],
  };
  const item = {
    kind: "prompt" as const,
    chatId: 7,
    replyToMessageId: 10,
    queueOrder: 1,
    queueLane: "default" as const,
    laneOrder: 1,
    statusSummary: "handoff",
    admissionReceipts: [receipt],
    sourceMessageIds: [10],
    queuedAttachments: [],
    content: [{ type: "text" as const, text: "handoff" }],
    historyText: "handoff",
  };
  const expectedOwner = {
    instanceId: "donor",
    processId: 10,
    processBirthId: "10:start:donor",
    sessionGeneration: 1,
    acquisitionId: "donor-acquisition",
    acquiredAtMs: 100,
  };
  const recipientOwner = {
    instanceId: "recipient",
    processId: 20,
    processBirthId: "20:start:recipient",
    sessionGeneration: 2,
  };
  const acceptedOwner = {
    ...recipientOwner,
    acquisitionId: "recipient-acquisition",
    acquiredAtMs: 200,
    handoffId: "handoff-id",
  };
  const events: string[] = [];
  const result = await coordinateTelegramQueueHandoff({
    item,
    expectedOwner,
    recipientOwner,
    handoffToken: "x".repeat(32),
    lifecycle: {
      offerQueueReceiptHandoff: () => {
        events.push("offer");
        return {} as never;
      },
      acceptQueueReceiptHandoff: () =>
        assert.fail("recipient acknowledgement already carries acceptance"),
      cancelQueueReceiptHandoff: () => assert.fail("success must not cancel"),
    },
    async stageRemote() {
      events.push("stage");
      events.push("accept");
      return {
        status: "staged",
        receiptId: receipt.receiptId,
        sourceUpdateIds: [1],
        queueOwner: acceptedOwner,
      };
    },
    removeDonorItem: () => {
      events.push("remove");
      return true;
    },
  });
  assert.equal(result.status, "transferred");
  assert.deepEqual(events, ["offer", "stage", "accept", "remove"]);
});

test("Queue handoff coordinator cancels pre-acceptance failure and retains donor work", async () => {
  const receipt = {
    queueKind: "prompt" as const,
    receiptId: "handoff-receipt",
    sourceUpdateIds: [1],
  };
  const events: string[] = [];
  const result = await coordinateTelegramQueueHandoff({
    item: {
      kind: "prompt",
      chatId: 7,
      replyToMessageId: 10,
      queueOrder: 1,
      queueLane: "default",
      laneOrder: 1,
      statusSummary: "handoff",
      admissionReceipts: [receipt],
      sourceMessageIds: [10],
      queuedAttachments: [],
      content: [{ type: "text", text: "handoff" }],
      historyText: "handoff",
    },
    expectedOwner: {
      instanceId: "donor",
      processId: 10,
      processBirthId: "10:start:donor",
      sessionGeneration: 1,
      acquisitionId: "donor-acquisition",
      acquiredAtMs: 100,
    },
    recipientOwner: {
      instanceId: "recipient",
      processId: 20,
      processBirthId: "20:start:recipient",
      sessionGeneration: 2,
    },
    handoffToken: "x".repeat(32),
    lifecycle: {
      offerQueueReceiptHandoff: () => {
        events.push("offer");
        return {} as never;
      },
      acceptQueueReceiptHandoff: () => assert.fail("mismatch must not accept"),
      cancelQueueReceiptHandoff: () => {
        events.push("cancel");
        return {} as never;
      },
    },
    async stageRemote() {
      events.push("stage");
      return {
        status: "staged",
        receiptId: "wrong",
        sourceUpdateIds: [1],
        queueOwner: {
          instanceId: "recipient",
          processId: 20,
          processBirthId: "20:start:recipient",
          sessionGeneration: 2,
          acquisitionId: "recipient-acquisition",
          acquiredAtMs: 200,
        },
      };
    },
    removeDonorItem: () => assert.fail("failed handoff must retain donor item"),
  });
  assert.equal(result.status, "retained");
  if (result.status !== "retained") assert.fail("expected retained result");
  assert.equal(result.cancelled, true);
  assert.deepEqual(events, ["offer", "stage", "cancel"]);
});

test("Queue handoff coordinator surfaces post-acceptance donor removal failure", async () => {
  const receipt = {
    queueKind: "prompt" as const,
    receiptId: "handoff-receipt",
    sourceUpdateIds: [1],
  };
  await assert.rejects(
    coordinateTelegramQueueHandoff({
      item: {
        kind: "prompt",
        chatId: 7,
        replyToMessageId: 10,
        queueOrder: 1,
        queueLane: "default",
        laneOrder: 1,
        statusSummary: "handoff",
        admissionReceipts: [receipt],
        sourceMessageIds: [10],
        queuedAttachments: [],
        content: [{ type: "text", text: "handoff" }],
        historyText: "handoff",
      },
      expectedOwner: {
        instanceId: "donor",
        processId: 10,
        processBirthId: "10:start:donor",
        sessionGeneration: 1,
        acquisitionId: "donor-acquisition",
        acquiredAtMs: 100,
      },
      recipientOwner: {
        instanceId: "recipient",
        processId: 20,
        processBirthId: "20:start:recipient",
        sessionGeneration: 2,
      },
      handoffToken: "x".repeat(32),
      lifecycle: {
        offerQueueReceiptHandoff: () => ({} as never),
        acceptQueueReceiptHandoff: () =>
          assert.fail("recipient acknowledgement already carries acceptance"),
        cancelQueueReceiptHandoff: () =>
          assert.fail("accepted authority must not cancel"),
      },
      async stageRemote() {
        return {
          status: "staged",
          receiptId: receipt.receiptId,
          sourceUpdateIds: [1],
          queueOwner: {
            instanceId: "recipient",
            processId: 20,
            processBirthId: "20:start:recipient",
            sessionGeneration: 2,
            acquisitionId: "recipient-acquisition",
            acquiredAtMs: 200,
          },
        };
      },
      removeDonorItem: () => false,
    }),
    /donor item .* disappeared after acceptance/u,
  );
});

test("Queue handoff reconciler routes only exact target owners and removes accepted donor work", async () => {
  const receipt = {
    queueKind: "prompt" as const,
    receiptId: "handoff-receipt",
    sourceUpdateIds: [1],
    journalBindingKey: JSON.stringify({
      version: 1,
      path: "/donor-journal",
      receiptScope: "donor",
    }),
  };
  const expectedOwner = {
    instanceId: "donor",
    processId: 10,
    processBirthId: "10:start:donor",
    sessionGeneration: 1,
    acquisitionId: "donor-acquisition",
    acquiredAtMs: 100,
  };
  const events: string[] = [];
  const lifecycle = {
    getQueueReceiptOwner: () => expectedOwner,
    offerQueueReceiptHandoff: () => {
      events.push("offer");
      return {} as never;
    },
    acceptQueueReceiptHandoff: () =>
      assert.fail("recipient acknowledgement already carries acceptance"),
    cancelQueueReceiptHandoff: () => assert.fail("must not cancel"),
  };
  const reconcile = createTelegramQueueHandoffReconciler<string>({
    ownsDirect: () => true,
    isFollowerRegistered: () => false,
    isBusEnabled: () => true,
    listFollowers: () => [{
      instanceId: "recipient",
      profileKey: "manual:recipient",
      target: { chatId: 7, threadId: 20 },
      registrationGeneration: "recipient-generation",
      pid: 20,
      processBirthId: "20:start:recipient",
      sessionGeneration: 2,
      connectedAtMs: 1,
      lastHeartbeatMs: 1,
    }],
    createRecipientJournalBindingKey: () => "recipient-journal",
    getQueuedItems: () => [{
      kind: "prompt",
      chatId: 7,
      target: { chatId: 7, threadId: 20 },
      replyToMessageId: 10,
      queueOrder: 1,
      queueLane: "default",
      laneOrder: 1,
      statusSummary: "handoff",
      admissionReceipts: [receipt],
      sourceMessageIds: [10],
      queuedAttachments: [],
      content: [{ type: "text", text: "handoff" }],
      historyText: "handoff",
    }],
    getReceiptOwner: () => expectedOwner,
    getLifecycleForReceipt: () => lifecycle as never,
    createHandoffToken: () => "x".repeat(32),
    createRequestId: () => "handoff:1",
    donorInstanceId: "donor",
    stageThroughFollower: () => assert.fail("leader path expected"),
    async routeThroughLeader(input) {
      events.push(`route:${input.recipientInstanceId}`);
      assert.equal(
        input.payload.admissionReceipts[0]?.journalBindingKey,
        "recipient-journal",
      );
      return {
        kind: "bus.ack",
        requestId: input.requestId,
        ok: true,
        result: {
          status: "staged",
          receiptId: receipt.receiptId,
          sourceUpdateIds: [1],
          queueOwner: {
            instanceId: "recipient",
            processId: 20,
            processBirthId: "20:start:recipient",
            sessionGeneration: 2,
            acquisitionId: "recipient-acquisition",
            acquiredAtMs: 200,
          },
        },
      };
    },
    removeDonorItem: (_receipt, ctx) => {
      events.push(`remove:${ctx}`);
      return true;
    },
  });
  await reconcile("ctx");
  assert.deepEqual(events, ["offer", "route:recipient", "remove:ctx"]);
});

test("Queue handoff reconciliation assembly projects journals, admission, and follower IPC", async () => {
  const receipt = {
    queueKind: "prompt" as const,
    receiptId: "assembly-receipt",
    sourceUpdateIds: [1],
    journalBindingKey: JSON.stringify({
      version: 1,
      path: "/donor-journal",
      receiptScope: "donor",
    }),
  };
  const expectedOwner = {
    instanceId: "donor",
    processId: 10,
    processBirthId: "10:start:donor",
    sessionGeneration: 1,
    acquisitionId: "donor-acquisition",
    acquiredAtMs: 100,
  };
  const store = createTelegramQueueStore<string>([{
    kind: "prompt",
    chatId: 7,
    target: { chatId: 7, threadId: 20 },
    replyToMessageId: 10,
    queueOrder: 1,
    queueLane: "default",
    laneOrder: 1,
    statusSummary: "handoff",
    admissionReceipts: [receipt],
    sourceMessageIds: [10],
    queuedAttachments: [],
    content: [{ type: "text", text: "handoff" }],
    historyText: "handoff",
  }]);
  const events: string[] = [];
  const lifecycle = {
    offerQueueReceiptHandoff: () => {
      events.push("offer");
      return {} as never;
    },
    acceptQueueReceiptHandoff: () =>
      assert.fail("recipient acknowledgement already carries acceptance"),
    cancelQueueReceiptHandoff: () => assert.fail("must not cancel"),
  };
  const reconcile = createTelegramQueueHandoffReconciliationRuntimeAssembly({
    ownsDirect: () => false,
    isFollowerRegistered: () => true,
    isBusEnabled: () => true,
    listFollowers: () => [{
      instanceId: "recipient",
      profileKey: "manual:recipient",
      target: { chatId: 7, threadId: 20 },
      registrationGeneration: "recipient-generation",
      pid: 20,
      processBirthId: "20:start:recipient",
      sessionGeneration: 2,
      connectedAtMs: 1,
      lastHeartbeatMs: 1,
    }],
    createRecipientJournalResolver: (profileKey) => () => {
      events.push(`binding:${profileKey}`);
      return { recoveryKey: "recipient-journal" };
    },
    queueStore: store,
    admission: {
      getSettlement: () => ({
        getQueueReceiptOwner: () => expectedOwner,
      } as never),
      getLifecycleForJournalBinding: () => lifecycle as never,
    },
    createHandoffToken: () => "x".repeat(32),
    createRequestId: () => "handoff:1",
    donorInstanceId: "donor",
    stageThroughFollower: async (input) => {
      events.push(
        `stage:${input.recipientInstanceId}:${input.recipientRegistrationGeneration}`,
      );
      assert.equal(
        input.payload.admissionReceipts[0]?.journalBindingKey,
        "recipient-journal",
      );
      return {
        status: "staged",
        receiptId: receipt.receiptId,
        sourceUpdateIds: [1],
        queueOwner: {
          instanceId: "recipient",
          processId: 20,
          processBirthId: "20:start:recipient",
          sessionGeneration: 2,
          acquisitionId: "recipient-acquisition",
          acquiredAtMs: 200,
        },
      };
    },
    routeThroughLeader: async () => assert.fail("follower path expected"),
  });

  await reconcile("ctx");
  assert.deepEqual(events, [
    "binding:manual:recipient",
    "offer",
    "stage:recipient:recipient-generation",
  ]);
  assert.deepEqual(store.getQueuedItems(), []);
});

test("Queue handoff recipient selects the exact journal binding", async () => {
  const receipt = {
    queueKind: "prompt" as const,
    receiptId: "binding-receipt",
    sourceUpdateIds: [1],
    journalBindingKey: "journal-b",
  };
  const liveStore = createTelegramQueueStore<string>();
  const staging = createTelegramQueueHandoffStagingRuntime({
    liveStore,
    createControlExecution: () => async () => undefined,
  });
  const recipientOwner = {
    instanceId: "recipient",
    processId: 20,
    processBirthId: "20:start:recipient",
    sessionGeneration: 2,
  };
  const acceptedOwner = {
    ...recipientOwner,
    acquisitionId: "recipient-acquisition",
    acquiredAtMs: 200,
    handoffId: "handoff-id",
  };
  const selectedBindings: string[] = [];
  const accept = createTelegramQueueHandoffRecipientRuntime<string>({
    staging,
    getRecipientOwner: () => recipientOwner,
    getLifecycleForBinding(binding) {
      selectedBindings.push(binding);
      return binding === "journal-b"
        ? ({
            acceptQueueReceiptHandoff: () => ({ queueOwner: acceptedOwner }),
            publishAcceptedQueueReceipt: async () => undefined,
          } as never)
        : undefined;
    },
    isTransportStampActive: () => true,
    dispatchNext: () => undefined,
  });
  const result = await accept({
    kind: "leader.offerQueueHandoff",
    requestId: "binding:1",
    recipientInstanceId: "recipient",
    recipientRegistrationGeneration: "recipient-generation",
    donorInstanceId: "donor",
    donorProcessId: 10,
    donorProcessBirthId: "10:start:donor",
    donorSessionGeneration: 1,
    donorAcquisitionId: "donor-acquisition",
    donorAcquiredAtMs: 100,
    handoffToken: "x".repeat(32),
    payload: {
      kind: "prompt",
      chatId: 7,
      target: { chatId: 7, threadId: 20 },
      transportStamp: { profile: "default", generation: "1" },
      replyToMessageId: 10,
      queueOrder: 1,
      queueLane: "default",
      laneOrder: 1,
      statusSummary: "handoff",
      admissionReceipts: [receipt],
      sourceMessageIds: [10],
      queuedAttachments: [],
      content: [{ type: "text", text: "handoff" }],
      historyText: "handoff",
    },
    sentAtMs: 1,
  }, "ctx");
  assert.deepEqual(selectedBindings, ["journal-b"]);
  assert.deepEqual(result, {
    status: "staged",
    receiptId: receipt.receiptId,
    sourceUpdateIds: [1],
    queueOwner: acceptedOwner,
  });
  assert.equal(liveStore.getQueuedItems().length, 1);
});

test("Queue handoff recipient rejects receipts without journal identity", async () => {
  const liveStore = createTelegramQueueStore<string>();
  const staging = createTelegramQueueHandoffStagingRuntime({
    liveStore,
    createControlExecution: () => async () => undefined,
  });
  const accept = createTelegramQueueHandoffRecipientRuntime<string>({
    staging,
    getRecipientOwner: () => ({
      instanceId: "recipient",
      processId: 20,
      processBirthId: "20:start:recipient",
      sessionGeneration: 2,
    }),
    getLifecycleForBinding: () => assert.fail("missing binding must fail closed"),
    dispatchNext: () => undefined,
  });
  await assert.rejects(
    accept({
      kind: "leader.offerQueueHandoff",
      requestId: "binding:missing",
      recipientInstanceId: "recipient",
      recipientRegistrationGeneration: "recipient-generation",
      donorInstanceId: "donor",
      donorProcessId: 10,
      donorProcessBirthId: "10:start:donor",
      donorSessionGeneration: 1,
      donorAcquisitionId: "donor-acquisition",
      donorAcquiredAtMs: 100,
      handoffToken: "x".repeat(32),
      payload: {
        kind: "prompt",
        chatId: 7,
        replyToMessageId: 10,
        queueOrder: 1,
        queueLane: "default",
        laneOrder: 1,
        statusSummary: "handoff",
        admissionReceipts: [{
          queueKind: "prompt",
          receiptId: "legacy-receipt",
          sourceUpdateIds: [1],
        }],
        sourceMessageIds: [10],
        queuedAttachments: [],
        content: [{ type: "text", text: "handoff" }],
        historyText: "handoff",
      },
      sentAtMs: 1,
    }, "ctx"),
    /omitted its journal binding/u,
  );
  assert.deepEqual(liveStore.getQueuedItems(), []);
});

test("Admission lifecycle exposes exact live queue handoff operations", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  const donorIdentity = {
    instanceId: "donor-instance",
    processId: 101,
    processBirthId: "101:start:donor",
    sessionGeneration: 1,
  };
  storage.journal.markQueued({
    queueKind: "prompt",
    receiptId: "handoff-receipt",
    sourceUpdateIds: [1],
    owner: donorIdentity,
  });
  const donorOwner = storage.getEntries()[0]!.queueOwner!;
  const recipientIdentity = {
    instanceId: "recipient-instance",
    processId: 202,
    processBirthId: "202:start:recipient",
    sessionGeneration: 2,
  };
  const calls: string[] = [];
  const handoffInput = {
    queueKind: "prompt" as const,
    receiptId: "handoff-receipt",
    sourceUpdateIds: [1],
    expectedOwner: donorOwner,
    recipientOwner: recipientIdentity,
    handoffToken: "x".repeat(32),
  };
  const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<string>({
    resolveBinding: () => ({
      runtimeKey: "handoff-runtime",
      recoveryKey: "handoff-recovery",
      journal: {
        ...storage.journal,
        appendBatch: () => undefined,
        offerQueuedHandoff(input) {
          assert.deepEqual(input, handoffInput);
          calls.push("offer");
          return {
            handoff: {
              handoffId: "handoff-id",
              offeredAtMs: 1,
              recipientOwner: input.recipientOwner,
            },
            previousOwner: input.expectedOwner,
            offeredUpdateIds: [1],
            duplicate: false,
            entryCount: 1,
            serializedBytes: 100,
          };
        },
        acceptQueuedHandoff(input) {
          assert.deepEqual(input, handoffInput);
          calls.push("accept");
          return {
            handoffId: "handoff-id",
            previousOwner: input.expectedOwner,
            queueOwner: {
              ...input.recipientOwner,
              acquisitionId: "recipient-acquisition",
              acquiredAtMs: 2,
              handoffId: "handoff-id",
            },
            acceptedUpdateIds: [1],
            duplicate: false,
            entryCount: 1,
            serializedBytes: 100,
          };
        },
        cancelQueuedHandoff(input) {
          assert.deepEqual(input, handoffInput);
          calls.push("cancel");
          return {
            handoffId: "handoff-id",
            previousOwner: input.expectedOwner,
            cancelledUpdateIds: [1],
            entryCount: 1,
            serializedBytes: 100,
          };
        },
      },
    }),
    createWorker(journal) {
      return createTelegramUpdateWorkerRuntime({
        journal,
        hasAuthority: () => true,
        getQueueOwnerIdentity: () => donorIdentity,
        executeUpdate: () => ({ kind: "complete" }),
      });
    },
  });

  await lifecycle.onSessionStart("ctx");
  lifecycle.offerQueueReceiptHandoff(handoffInput);
  lifecycle.acceptQueueReceiptHandoff(handoffInput);
  lifecycle.cancelQueueReceiptHandoff(handoffInput);
  assert.deepEqual(calls, ["offer", "accept", "cancel"]);
  await lifecycle.onSessionShutdown();
});

test("Admission lifecycle preserves queue authority owned by another live process", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  const processA = {
    instanceId: "instance-a",
    processId: 101,
    processBirthId: "101:start:a",
    sessionGeneration: 1,
  };
  storage.journal.markQueued({
    queueKind: "prompt",
    receiptId: "receipt-a",
    sourceUpdateIds: [1],
    owner: processA,
  });
  let executions = 0;
  let recoveryCalls = 0;
  const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<string>({
    getQueueOwnerIdentity: () => ({
      instanceId: "instance-b",
      processId: 202,
      processBirthId: "202:start:b",
      sessionGeneration: 1,
    }),
    resolveBinding: () => ({
      runtimeKey: "profile-a:token",
      recoveryKey: "profile-a",
      journal: {
        ...storage.journal,
        appendBatch: () => undefined,
        recoverDeadQueueOwner(input) {
          recoveryCalls += 1;
          return {
            status: "owner-alive" as const,
            previousOwner: input.deadOwner,
            recoveredUpdateIds: [] as [],
            entryCount: 1,
            serializedBytes: 100,
          };
        },
      },
    }),
    createWorker(journal) {
      return createTelegramUpdateWorkerRuntime({
        journal,
        hasAuthority: () => true,
        getQueueOwnerIdentity: () => ({
          instanceId: "instance-b",
          processId: 202,
          processBirthId: "202:start:b",
          sessionGeneration: 1,
        }),
        executeUpdate: () => {
          executions += 1;
          return { kind: "complete" };
        },
      });
    },
  });
  const receiptItem = {
    admissionReceipts: [
      {
        queueKind: "prompt" as const,
        receiptId: "receipt-a",
        sourceUpdateIds: [1],
      },
    ],
  };

  await lifecycle.onSessionStart("session-b");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(executions, 0);
  assert.equal(recoveryCalls, 1);
  assert.equal(lifecycle.isItemReady(receiptItem), false);
  assert.equal(lifecycle.getState()?.queuedClaimCount, 0);
  assert.equal(lifecycle.getState()?.foreignQueuedCount, 1);
  assert.equal(storage.getEntries()[0]?.state, "queued");
  assert.deepEqual(storage.getEntries()[0]?.queueOwner, {
    ...processA,
    acquisitionId: "acquisition-receipt-a",
    acquiredAtMs: 1_000,
  });
  await lifecycle.onSessionShutdown();
});

test("Update worker fences an offered local receipt until handoff resolves", async () => {
  const receipt = {
    queueKind: "prompt" as const,
    receiptId: "offered-receipt",
    sourceUpdateIds: [1],
  };
  const processIdentity = {
    instanceId: "donor-instance",
    processId: 101,
    processBirthId: "101:start:donor",
    sessionGeneration: 1,
  };
  const storage = createTestUpdateWorkerJournal([1]);
  storage.journal.markQueued({ ...receipt, owner: processIdentity });
  const donorOwner = storage.getEntries()[0]!.queueOwner!;
  const journal: TelegramUpdateWorkerJournalPort = {
    ...storage.journal,
    read() {
      const snapshot = storage.journal.read();
      return {
        ...snapshot,
        entries: snapshot.entries.map((entry) => ({
          ...entry,
          queueHandoff: {
            handoffId: "handoff-id",
            offeredAtMs: 1,
            recipientOwner: {
              instanceId: "recipient-instance",
              processId: 202,
              processBirthId: "202:start:recipient",
              sessionGeneration: 1,
            },
          },
        })),
      };
    },
  };
  let executions = 0;
  const worker = createTelegramUpdateWorkerRuntime({
    journal,
    hasAuthority: () => true,
    getQueueOwnerIdentity: () => processIdentity,
    executeUpdate() {
      executions += 1;
      return { kind: "complete" };
    },
  });

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  assert.equal(executions, 0);
  assert.equal(worker.isQueueReceiptCommitted(receipt), false);
  assert.equal(worker.getState().queuedClaimCount, 0);
  assert.equal(worker.getState().foreignQueuedCount, 1);
  worker.completeQueueReceipts({
    receipts: [receipt],
    ctx: TEST_CONTEXT,
    reason: "prompt-handoff",
  });
  assert.deepEqual(storage.getUpdateIds(), [1]);
  await worker.stop();
  assert.deepEqual(storage.getEntries()[0]?.queueOwner, donorOwner);
});

test("Queue settlement mux resolves mixed receipts across owning journals", () => {
  const calls: string[] = [];
  const createRuntime = (name: string, receiptId: string) => ({
    isItemReady: (item: { admissionReceipts?: readonly { receiptId: string }[] }) =>
      (item.admissionReceipts ?? []).every(
        (receipt) => receipt.receiptId === receiptId,
      ),
    getQueueReceiptOwner: () => undefined,
    onPromptHandedOff: () => {
      calls.push(`${name}:prompt`);
    },
    onControlSettled: () => {},
    onItemsDiscarded: () => {},
  });
  const settlement = createTelegramQueueAdmissionSettlementMuxRuntime([
    createRuntime("leader", "leader-receipt"),
    createRuntime("follower", "follower-receipt"),
  ]);
  const item = {
    admissionReceipts: [
      {
        queueKind: "prompt" as const,
        receiptId: "leader-receipt",
        sourceUpdateIds: [1],
      },
      {
        queueKind: "prompt" as const,
        receiptId: "follower-receipt",
        sourceUpdateIds: [2],
      },
    ],
  };
  assert.equal(settlement.isItemReady(item), true);
  assert.equal(
    settlement.getQueueReceiptOwner(item.admissionReceipts[0]!),
    undefined,
  );
  settlement.onPromptHandedOff(item, "ctx");
  assert.deepEqual(calls, ["leader:prompt", "follower:prompt"]);
});

test("Queue settlement ignores receipts owned by another journal", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  const ownedReceipt = {
    queueKind: "prompt" as const,
    receiptId: "owned-receipt",
    sourceUpdateIds: [1],
  };
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    executeUpdate() {
      return { kind: "queued", ...ownedReceipt };
    },
  });
  const settlement = createTelegramQueueAdmissionSettlementRuntime(worker);

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  settlement.onPromptHandedOff(
    {
      admissionReceipts: [
        {
          queueKind: "prompt",
          receiptId: "other-journal-receipt",
          sourceUpdateIds: [2],
        },
      ],
    },
    TEST_CONTEXT,
  );
  assert.deepEqual(storage.getUpdateIds(), [1]);
  assert.notEqual(worker.getState().phase, "blocked");
  settlement.onPromptHandedOff(
    { admissionReceipts: [ownedReceipt] },
    TEST_CONTEXT,
  );
  await worker.waitForDrain();
  assert.deepEqual(storage.getUpdateIds(), []);
  await worker.stop();
});

test("Queue settlement accepts current session context rotation after transport authority loss", async () => {
  const storage = createTestUpdateWorkerJournal([1, 2, 3]);
  let hasAuthority = true;
  const receipts = [1, 2].map((updateId) => ({
    queueKind: "prompt" as const,
    receiptId: `prompt-${updateId}`,
    sourceUpdateIds: [updateId],
  }));
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => hasAuthority,
    isContextCurrent: (ctx) => ctx === "same-session-context",
    executeUpdate(update) {
      if (update.update_id === 3) return { kind: "complete" };
      return {
        kind: "queued",
        ...receipts[update.update_id - 1]!,
      };
    },
  });
  const settlement = createTelegramQueueAdmissionSettlementRuntime(worker);
  const foldedItem = { admissionReceipts: receipts };

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  assert.equal(settlement.isItemReady(foldedItem), true);
  settlement.onPromptHandedOff(foldedItem, "stale-context");
  assert.deepEqual(storage.getUpdateIds(), [1, 2]);
  assert.equal(worker.getState().lastCompletedUpdateId, 3);
  hasAuthority = false;
  settlement.onPromptHandedOff(foldedItem, "same-session-context");
  await worker.waitForDrain();
  assert.deepEqual(storage.getRemovals(), [[3], [1, 2]]);
  assert.deepEqual(storage.getUpdateIds(), []);
  assert.equal(settlement.isItemReady(foldedItem), false);
  assert.equal(worker.getState().queuedClaimCount, 0);
  assert.equal(worker.getState().lastCompletedUpdateId, 3);
  await worker.stop();
});

test("Explicit discard commits an exact grouped replay boundary", async () => {
  const storage = createTestUpdateWorkerJournal([1, 2]);
  const receipt = {
    queueKind: "prompt" as const,
    receiptId: "discard-group-1",
    sourceUpdateIds: [1, 2],
  };
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    executeUpdate(update) {
      return update.update_id === 1
        ? { kind: "deferred" }
        : { kind: "queued", ...receipt };
    },
  });
  const settlement = createTelegramQueueAdmissionSettlementRuntime(worker);
  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  assert.equal(settlement.isItemReady({ admissionReceipts: [receipt] }), true);
  settlement.onItemsDiscarded(
    [{ admissionReceipts: [receipt] }],
    TEST_CONTEXT,
  );
  assert.deepEqual(storage.getUpdateIds(), []);
  await worker.stop();

  let replayCalls = 0;
  const replacement = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    executeUpdate() {
      replayCalls += 1;
      return { kind: "complete" };
    },
  });
  replacement.start("replacement");
  await replacement.waitForDrain();
  assert.equal(replayCalls, 0);
  assert.deepEqual(storage.getRemovals(), [[1, 2]]);
  await replacement.stop();
});

test("Admission worker commits late grouped receipts once under the owner generation", async () => {
  const storage = createTestUpdateWorkerJournal([1, 2]);
  const boundMessages: unknown[] = [];
  const committedReceipts: string[] = [];
  const journal: TelegramUpdateWorkerJournalPort = {
    ...storage.journal,
    read() {
      const snapshot = storage.journal.read();
      return {
        ...snapshot,
        entries: snapshot.entries.map((entry) => ({
          ...entry,
          update: {
            ...entry.update,
            message: {
              message_id: entry.updateId,
              chat: { id: 5, type: "private" },
              from: { id: 7, is_bot: false },
            },
          },
        })),
      };
    },
  };
  const worker = createTelegramUpdateAdmissionWorkerRuntime({
    journal,
    registry: {
      version: 1,
      add: () => () => {},
      dispatch: async () => "pass",
    },
    hasAuthority: () => true,
    defaultHandle: async (update) => {
      boundMessages.push(update.message);
      reportTelegramUpdateDeferred(update.message);
    },
    onQueueReceiptCommitted(receipt) {
      committedReceipts.push(receipt.receiptId);
    },
  });
  const receipt = {
    queueKind: "prompt" as const,
    receiptId: "group-1",
    sourceUpdateIds: [1, 2],
  };

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  assert.equal(worker.isQueueReceiptCommitted(receipt), false);
  reportTelegramQueueAdmission(boundMessages, [receipt]);
  await waitForUpdateWorkerCondition(
    () => worker.isQueueReceiptCommitted(receipt),
    "late grouped receipt did not commit",
  );
  assert.deepEqual(storage.getQueueReceipts(), [receipt]);
  assert.deepEqual(committedReceipts, ["group-1"]);
  assert.equal(worker.getState().queuedClaimCount, 2);

  await worker.stop();
  assert.equal(worker.isQueueReceiptCommitted(receipt), false);
  reportTelegramQueueAdmission(boundMessages, [receipt]);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(storage.getQueueReceipts(), [receipt]);
});

test("Late queue settlement keeps dispatch gated when durable commit fails", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  let ownerSignal: AbortSignal | undefined;
  let commitFails = true;
  let executionCalls = 0;
  const committedReceipts: string[] = [];
  const receipt = {
    queueKind: "prompt" as const,
    receiptId: "late-failure",
    sourceUpdateIds: [1],
  };
  const worker = createTelegramUpdateWorkerRuntime({
    journal: {
      ...storage.journal,
      markQueued(nextReceipt) {
        if (commitFails) throw new Error("late queue receipt unavailable");
        return storage.journal.markQueued(nextReceipt);
      },
    },
    hasAuthority: () => true,
    executeUpdate(_update, _ctx, signal) {
      ownerSignal = signal;
      executionCalls += 1;
      return executionCalls === 1
        ? { kind: "deferred" }
        : { kind: "queued", ...receipt };
    },
    onQueueReceiptCommitted(receipt) {
      committedReceipts.push(receipt.receiptId);
    },
  });

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  assert.ok(ownerSignal);
  worker.settleDeferred({
    updateId: 1,
    outcome: { kind: "queued", ...receipt },
    signal: ownerSignal!,
  });
  assert.equal(worker.isQueueReceiptCommitted(receipt), false);
  assert.deepEqual(committedReceipts, []);
  assert.equal(worker.getState().lastFailurePhase, "queue-receipt-commit");
  assert.equal(worker.getState().deferredClaimCount, 0);

  commitFails = false;
  worker.signal();
  await worker.waitForDrain();
  assert.equal(executionCalls, 2);
  assert.equal(worker.isQueueReceiptCommitted(receipt), true);
  assert.deepEqual(committedReceipts, ["late-failure"]);
  assert.equal(worker.getState().phase, "idle");
  await worker.stop();
});

test("Update worker reconstructs durable queue claims after session replacement", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  const receipt = {
    queueKind: "prompt" as const,
    receiptId: "prompt-1",
    sourceUpdateIds: [1],
  };
  const processIdentity = {
    instanceId: "same-process-instance",
    processId: 303,
    processBirthId: "303:start:same",
  };
  const first = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    getQueueOwnerIdentity: () => ({
      ...processIdentity,
      sessionGeneration: 1,
    }),
    executeUpdate: () => ({ kind: "queued", ...receipt }),
  });
  first.start(TEST_CONTEXT);
  await first.waitForDrain();
  assert.equal(first.isQueueReceiptCommitted(receipt), true);
  assert.deepEqual(first.getQueueReceiptOwner(receipt), storage.getEntries()[0]?.queueOwner);
  assert.equal(
    first.getQueueReceiptOwner({ ...receipt, sourceUpdateIds: [2] }),
    undefined,
  );
  await first.stop();

  let replayCalls = 0;
  const restoredReceipts: string[] = [];
  const replacement = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    getQueueOwnerIdentity: () => ({
      ...processIdentity,
      sessionGeneration: 2,
    }),
    executeUpdate() {
      replayCalls += 1;
      return { kind: "complete" };
    },
    onQueueReceiptCommitted(nextReceipt) {
      restoredReceipts.push(nextReceipt.receiptId);
    },
  });
  replacement.start("replacement");
  await replacement.waitForDrain();
  assert.equal(replayCalls, 0);
  assert.equal(replacement.isQueueReceiptCommitted(receipt), true);
  assert.deepEqual(restoredReceipts, ["prompt-1"]);
  assert.equal(replacement.getState().queuedClaimCount, 1);
  replacement.completeQueueReceipts({
    receipts: [receipt],
    ctx: "replacement",
    reason: "prompt-handoff",
  });
  await replacement.waitForDrain();
  assert.deepEqual(storage.getUpdateIds(), []);
  await replacement.stop();
});

test("Update worker delays replacement replay until an abort-ignoring generation settles", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  const effects = new Array<string>();
  const runtimeEvents: Array<{
    error: unknown;
    details?: Record<string, unknown>;
  }> = [];
  let executionCalls = 0;
  let firstSignal: AbortSignal | undefined;
  let resolveFirstExecution: (outcome: TelegramUpdateAdmissionOutcome) => void =
    () => assert.fail("first execution was not created");
  const firstExecution = new Promise<TelegramUpdateAdmissionOutcome>(
    (resolve) => {
      resolveFirstExecution = resolve;
    },
  );
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    executeUpdate(_update, _ctx, signal) {
      executionCalls += 1;
      if (executionCalls === 1) {
        firstSignal = signal;
        return firstExecution;
      }
      effects.push("generation-2");
      return { kind: "complete" };
    },
    recordRuntimeEvent(_category, error, details) {
      runtimeEvents.push({ error, details });
    },
  });

  worker.start("generation-1");
  await waitForUpdateWorkerCondition(
    () => worker.getState().phase === "executing",
    "generation 1 did not begin execution",
  );
  await worker.stop();
  assert.equal(firstSignal?.aborted, true);

  worker.start("generation-2");
  await waitForUpdateWorkerCondition(
    () => worker.getState().blockedReason === "prior-generation-executing",
    "replacement did not wait for prior execution settlement",
  );
  assert.equal(executionCalls, 1);
  assert.deepEqual(storage.getUpdateIds(), [1]);
  assert.equal(effects.length, 0);

  effects.push("generation-1");
  resolveFirstExecution({ kind: "complete" });
  await worker.waitForDrain();
  assert.equal(executionCalls, 2);
  assert.deepEqual(effects, ["generation-1", "generation-2"]);
  assert.deepEqual(storage.getUpdateIds(), []);
  assert.deepEqual(storage.getRemovals(), [[1]]);
  assert.equal(runtimeEvents.length, 1);
  assert.equal(
    runtimeEvents[0]?.error,
    "Superseded Telegram update execution settled successfully.",
  );
  assert.deepEqual(runtimeEvents[0]?.details, {
    phase: "late-execution-success",
    generation: 1,
    updateId: 1,
  });
  await worker.stop();
});

test("Update worker stop settles its generation and sinks late execution failure", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  const runtimeEvents: Array<{
    error: unknown;
    details?: Record<string, unknown>;
  }> = [];
  let executionCalls = 0;
  let firstSignal: AbortSignal | undefined;
  let rejectFirstExecution: (error: Error) => void = () => {
    assert.fail("first execution was not created");
  };
  const firstExecution = new Promise<TelegramUpdateAdmissionOutcome>(
    (_resolve, reject) => {
      rejectFirstExecution = reject;
    },
  );
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    executeUpdate(_update, _ctx, signal) {
      executionCalls += 1;
      if (executionCalls === 1) {
        firstSignal = signal;
        return firstExecution;
      }
      return { kind: "complete" };
    },
    recordRuntimeEvent(_category, error, details) {
      runtimeEvents.push({ error, details });
    },
  });

  worker.start(TEST_CONTEXT);
  await waitForUpdateWorkerCondition(
    () => worker.getState().phase === "executing",
    "worker did not begin the first execution",
  );
  await worker.stop();
  assert.equal(firstSignal?.aborted, true);
  assert.equal(worker.getState().phase, "stopped");
  assert.equal(worker.getState().unsettledExecutionCount, 1);
  assert.deepEqual(storage.getUpdateIds(), [1]);

  worker.start(TEST_CONTEXT);
  await waitForUpdateWorkerCondition(
    () => worker.getState().blockedReason === "prior-generation-executing",
    "replacement did not wait for the failed prior execution",
  );
  assert.equal(worker.getState().generation, 2);
  assert.deepEqual(storage.getUpdateIds(), [1]);
  assert.deepEqual(storage.getRemovals(), []);

  rejectFirstExecution(new Error("late handler failure"));
  await worker.waitForDrain();
  assert.deepEqual(storage.getUpdateIds(), []);
  assert.deepEqual(storage.getRemovals(), [[1]]);
  await waitForUpdateWorkerCondition(
    () => worker.getState().unsettledExecutionCount === 0,
    "late execution did not settle into its sink",
  );
  assert.equal(runtimeEvents.length, 1);
  assert.match(String(runtimeEvents[0]?.error), /late handler failure/u);
  assert.deepEqual(runtimeEvents[0]?.details, {
    phase: "late-execution",
    generation: 1,
    updateId: 1,
  });
  assert.deepEqual(storage.getRemovals(), [[1]]);
  await worker.stop();
});

test("Update worker rechecks authority after execution before journal completion", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  let hasAuthority = true;
  let executionCalls = 0;
  let resolveFirstExecution: (outcome: TelegramUpdateAdmissionOutcome) => void =
    () => {
      assert.fail("first execution was not created");
    };
  const firstExecution = new Promise<TelegramUpdateAdmissionOutcome>(
    (resolve) => {
      resolveFirstExecution = resolve;
    },
  );
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => hasAuthority,
    executeUpdate() {
      executionCalls += 1;
      return executionCalls === 1
        ? firstExecution
        : ({ kind: "complete" } as const);
    },
  });

  worker.start(TEST_CONTEXT);
  await waitForUpdateWorkerCondition(
    () => worker.getState().phase === "executing",
    "worker did not begin authority-fenced execution",
  );
  worker.signal();
  worker.signal();
  hasAuthority = false;
  resolveFirstExecution({ kind: "complete" });
  await worker.waitForDrain();

  assert.equal(executionCalls, 1);
  assert.equal(worker.getState().phase, "blocked");
  assert.equal(worker.getState().blockedReason, "authority-lost");
  assert.deepEqual(storage.getUpdateIds(), [1]);
  assert.deepEqual(storage.getRemovals(), []);

  hasAuthority = true;
  worker.signal();
  await worker.waitForDrain();
  assert.equal(executionCalls, 2);
  assert.equal(worker.getState().phase, "idle");
  assert.deepEqual(storage.getUpdateIds(), []);
  await worker.stop();
});

test("Update worker blocks invalid receipts without claiming future updates", async () => {
  const storage = createTestUpdateWorkerJournal([1, 2]);
  const executed: number[] = [];
  const runtimeEvents: Array<{ details?: Record<string, unknown> }> = [];
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    executeUpdate(update) {
      executed.push(update.update_id);
      return {
        kind: "queued",
        queueKind: "prompt",
        receiptId: "invalid-future-receipt",
        sourceUpdateIds: [1, 2],
      };
    },
    recordRuntimeEvent(_category, _error, details) {
      runtimeEvents.push({ details });
    },
  });

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  assert.deepEqual(executed, [1]);
  assert.equal(worker.getState().phase, "blocked");
  assert.equal(worker.getState().blockedReason, "invalid-outcome");
  assert.deepEqual(storage.getUpdateIds(), [1, 2]);
  assert.equal(runtimeEvents[0]?.details?.phase, "invalid-outcome");
  await worker.stop();
});

test("Update worker claims queued sources only after durable receipt commit", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  const worker = createTelegramUpdateWorkerRuntime({
    journal: {
      ...storage.journal,
      markQueued() {
        throw new Error("queue receipt unavailable");
      },
    },
    hasAuthority: () => true,
    executeUpdate() {
      return {
        kind: "queued",
        queueKind: "control",
        receiptId: "control-1",
        sourceUpdateIds: [1],
      };
    },
  });

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  assert.equal(worker.getState().phase, "blocked");
  assert.equal(worker.getState().blockedReason, "journal-write");
  assert.equal(worker.getState().lastFailurePhase, "queue-receipt-commit");
  assert.equal(worker.getState().queuedClaimCount, 0);
  assert.deepEqual(storage.getUpdateIds(), [1]);
  await worker.stop();
});

test("Update worker persists retry state without hot retry on repeated signals", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  let executionCalls = 0;
  let scheduled:
    | { callback: () => void; delayMs: number; cancelled: boolean }
    | undefined;
  const runtimeEvents: Array<{ details?: Record<string, unknown> }> = [];
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    getNowMs: () => 1_000,
    scheduleRetry(callback, delayMs) {
      scheduled = { callback, delayMs, cancelled: false };
      return scheduled;
    },
    cancelRetry(handle) {
      (handle as { cancelled: boolean }).cancelled = true;
    },
    executeUpdate() {
      executionCalls += 1;
      throw new Error("handler failed");
    },
    recordRuntimeEvent(_category, _error, details) {
      runtimeEvents.push({ details });
    },
  });

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  assert.equal(executionCalls, 1);
  assert.equal(worker.getState().phase, "idle");
  assert.equal(worker.getState().blockedReason, undefined);
  assert.equal(worker.getState().retryWaitCount, 1);
  assert.equal(worker.getState().nextRetryUpdateId, 1);
  assert.equal(worker.getState().nextRetryAtMs, 2_000);
  assert.equal(worker.getState().nextRetryAttemptCount, 1);
  assert.equal(worker.getState().nextRetryFailureClass, "execution-Error");
  assert.equal(worker.getState().lastFailurePhase, "execute");
  assert.equal(runtimeEvents[0]?.details?.phase, "execute");
  assert.equal(runtimeEvents[0]?.details?.disposition, "retry-wait");
  assert.equal(scheduled?.delayMs, 1_000);
  assert.equal(storage.getEntries()[0]?.state, "retry-wait");
  for (let signal = 0; signal < 5; signal += 1) worker.signal();
  await worker.waitForDrain();
  assert.equal(executionCalls, 1);
  assert.equal(scheduled?.delayMs, 1_000);
  await worker.stop();
  assert.equal(scheduled?.cancelled, true);
  scheduled?.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(executionCalls, 1);
});

test("Update worker automatically retries a poison entry while completing its tail", async () => {
  const storage = createTestUpdateWorkerJournal([1, 2, 3]);
  const executed: number[] = [];
  let scheduled: { callback: () => void; delayMs: number } | undefined;
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    getNowMs: () => 5_000,
    classifyExecutionFailure: () => ({
      disposition: "terminal",
      failureClass: "invalid-update",
      summary: "Deterministic poison update.",
    }),
    scheduleRetry(callback, delayMs) {
      scheduled = { callback, delayMs };
      return scheduled;
    },
    cancelRetry: () => {},
    executeUpdate(update) {
      executed.push(update.update_id);
      if (update.update_id === 1) throw new Error("poison");
      return { kind: "complete" };
    },
  });

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  assert.deepEqual(executed, [1, 2, 3]);
  assert.deepEqual(storage.getUpdateIds(), [1]);
  assert.deepEqual(storage.getRemovals(), [[2, 3]]);
  assert.deepEqual(storage.getEntries()[0], {
    updateId: 1,
    update: { update_id: 1 },
    admittedAtMs: 100,
    state: "retry-wait",
    failure: {
      attemptCount: 1,
      failedAtMs: 5_000,
      failureClass: "invalid-update",
      summary: "Deterministic poison update.",
    },
    nextRetryAtMs: 6_000,
  });
  assert.equal(worker.getState().phase, "idle");
  assert.equal(worker.getState().retryWaitCount, 1);
  assert.equal(worker.getState().nextRetryUpdateId, 1);
  assert.equal(worker.getState().nextRetryAttemptCount, 1);
  assert.equal(worker.getState().nextRetryFailureClass, "invalid-update");
  assert.equal(worker.getState().failedCount, 0);
  assert.equal(scheduled?.delayMs, 1_000);
  await worker.stop();
});

test("Update worker retries indefinitely with delay capped at the maximum", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  let nowMs = 1_000;
  let executionCalls = 0;
  let scheduled: { callback: () => void; delayMs: number } | undefined;
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    getNowMs: () => nowMs,
    retryPolicy: { baseDelayMs: 100, maxDelayMs: 100 },
    scheduleRetry(callback, delayMs) {
      scheduled = { callback, delayMs };
      return scheduled;
    },
    cancelRetry: () => {},
    executeUpdate() {
      executionCalls += 1;
      throw new Error("transient");
    },
  });

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  assert.equal(executionCalls, 1);
  assert.equal(storage.getEntries()[0]?.state, "retry-wait");
  assert.equal(scheduled?.delayMs, 100);
  nowMs = 1_100;
  scheduled!.callback();
  await worker.waitForDrain();
  assert.equal(executionCalls, 2);
  assert.equal(storage.getEntries()[0]?.state, "retry-wait");
  assert.equal(storage.getEntries()[0]?.failure?.attemptCount, 2);
  assert.equal(storage.getEntries()[0]?.nextRetryAtMs, 1_200);
  assert.equal(scheduled?.delayMs, 100);
  assert.equal(worker.getState().retryWaitCount, 1);
  assert.equal(worker.getState().failedCount, 0);
  await worker.stop();
});

test("Update worker preserves retry wait across runtime restart", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  let nowMs = 1_000;
  let firstTimer: { callback: () => void; delayMs: number } | undefined;
  const first = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    getNowMs: () => nowMs,
    retryPolicy: { baseDelayMs: 100, maxDelayMs: 100 },
    scheduleRetry(callback, delayMs) {
      firstTimer = { callback, delayMs };
      return firstTimer;
    },
    cancelRetry: () => {},
    executeUpdate() {
      throw new Error("transient");
    },
  });
  first.start(TEST_CONTEXT);
  await first.waitForDrain();
  assert.equal(firstTimer?.delayMs, 100);
  await first.stop();

  nowMs = 1_050;
  let replacementCalls = 0;
  let replacementTimer: { callback: () => void; delayMs: number } | undefined;
  const replacement = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    getNowMs: () => nowMs,
    retryPolicy: { baseDelayMs: 100, maxDelayMs: 100 },
    scheduleRetry(callback, delayMs) {
      replacementTimer = { callback, delayMs };
      return replacementTimer;
    },
    cancelRetry: () => {},
    executeUpdate() {
      replacementCalls += 1;
      return { kind: "complete" };
    },
  });
  replacement.start("replacement");
  await replacement.waitForDrain();
  assert.equal(replacementCalls, 0);
  assert.equal(replacementTimer?.delayMs, 50);
  nowMs = 1_100;
  replacementTimer!.callback();
  await replacement.waitForDrain();
  assert.equal(replacementCalls, 1);
  assert.deepEqual(storage.getUpdateIds(), []);
  await replacement.stop();
});

test("Update worker exposes completion-write failure without hot retry", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  let executionCalls = 0;
  const worker = createTelegramUpdateWorkerRuntime({
    journal: {
      ...storage.journal,
      removeCompleted() {
        throw new Error("journal commit unavailable");
      },
    },
    hasAuthority: () => true,
    executeUpdate() {
      executionCalls += 1;
      return { kind: "complete" };
    },
  });

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  assert.equal(executionCalls, 1);
  assert.equal(worker.getState().phase, "blocked");
  assert.equal(worker.getState().blockedReason, "journal-write");
  assert.equal(worker.getState().lastFailurePhase, "completion-commit");
  assert.deepEqual(storage.getUpdateIds(), [1]);
  await worker.stop();
});

test("Update worker contains state-observer and diagnostic-sink failures", async () => {
  const storage = createTestUpdateWorkerJournal([]);
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    executeUpdate() {
      return { kind: "complete" };
    },
    onStateChange() {
      throw new Error("observer unavailable");
    },
    recordRuntimeEvent() {
      throw new Error("diagnostics unavailable");
    },
  });

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  assert.equal(worker.getState().phase, "idle");
  await worker.stop();
  assert.equal(worker.getState().phase, "stopped");
});
