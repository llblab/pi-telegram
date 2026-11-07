/**
 * Regression tests for the Telegram updates domain
 * Covers extraction, authorization, flow planning, runtime execution, public handlers, and durable worker ownership
 * Zones: telegram, durable admission
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TelegramBusForeignUpdateSettlement } from "../lib/bus.ts";
import * as Queue from "../lib/queue.ts";
import { TelegramApiFollowerNotAllowedError } from "../lib/telegram-api.ts";
import {
  abandonTelegramDeferredUpdate,
  acquireTelegramUpdateRouting,
  buildTelegramUpdateExecutionPlan,
  buildTelegramUpdateExecutionPlanFromUpdate,
  bindTelegramUpdateAdmissionSource,
  bindTelegramUpdateCompletionAcceptance,
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
  createTelegramUpdateRuntime,
  createTelegramUpdateWorkerOwnerRuntime,
  createTelegramUpdateWorkerRuntime,
  executeTelegramUpdate,
  executeTelegramUpdatePlan,
  getAuthorizedTelegramCallbackQuery,
  getAuthorizedTelegramEditedMessage,
  getAuthorizedTelegramGuestMessage,
  getAuthorizedTelegramMessage,
  getTelegramMessageTarget,
  getTelegramUpdateExecutionFence,
  getTelegramTopicLifecycleUpdate,
  getTelegramUpdateHandlerRegistry,
  handleAuthorizedTelegramReactionUpdate,
  inspectTelegramAbandoningUpdates,
  inspectTelegramDeferredSource,
  inspectTelegramDeferredSourceSnapshot,
  inspectTelegramDeferredSourceCompletion,
  subscribeTelegramDeferredSourceCompletion,
  prepareTelegramDeferredSourceCompletion,
  type TelegramDeferredSourceCompletionPreparation,
  inspectTelegramHistoricalInputs,
  isTelegramHistoricalInput,
  normalizeTelegramReactionEmoji,
  prepareTelegramLiveDeferredInput,
  registerTelegramUpdateHandler,
  reportTelegramQueueAdmission,
  reportTelegramUpdateCompleted,
  reportTelegramUpdateDeferred,
  reportTelegramHistoricalRoutingReview,
  supportsTelegramDeferredAbandonment,
  TELEGRAM_INTERNAL_AGENT_MESSAGE,
  TELEGRAM_PRIORITY_REACTION_EMOJIS,
  TELEGRAM_PRIORITY_REACTIONS,
  TELEGRAM_STEER_REACTIONS,
  TELEGRAM_REMOVAL_REACTION_EMOJIS,
  TELEGRAM_REMOVAL_REACTIONS,
  type TelegramQueueAdmissionItemLike,
  type TelegramQueueSourceCompletion,
  type TelegramHeldSourcePreparation,
  type TelegramUpdateAdmissionOutcome,
  type TelegramUpdateFlow,
  type TelegramUpdateHandler,
  type TelegramUpdateExecutionFence,
  type TelegramUpdateHandlerRegistry,
  type TelegramUpdateWorkerJournalPort,
  type TelegramUpdateWorkerJournalSnapshot,
} from "../lib/updates.ts";
import * as Locks from "../lib/locks.ts";
import * as Updates from "../lib/updates.ts";
import * as Polling from "../lib/polling.ts";
import {
  createTelegramQueueHandoffStagingRuntime,
  createTelegramQueueStore,
} from "../lib/queue.ts";
import { createTelegramJournalSourceSerialization,
  createTelegramUpdateJournalBindingKey,
  createTelegramUpdateJournalRuntimeBindingResolver,
  createTelegramUpdateJournalEntryDigest,
  createTelegramUpdateJournalBotIdentity,
  createTelegramUpdateJournalStore,
  type TelegramJournaledUpdate,
  type TelegramUpdateJournalQueueOwner,
  type TelegramUpdateJournalStore,
} from "../lib/journal.ts";
import { acceptedForeignUpdateSettlement } from "./fixtures/shared.ts";

for (const fault of ["normal", "refused", "authority", "context", "binding", "owner", "changed", "missing", "reported",
  "cold", "stop", "before-publication", "after-publication", "lost-before", "lost-after", "bad-ack", "no-exact", "observer-replaced"] as const) {
  test(`Live donor group settlement requires current originals and one exact ACK (${fault})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "telegram-live-donor-"));
    let authority = true, context = true, generation = 1, activeFault = false, removed = 0;
    const completed: number[] = [], executed: number[] = [], originals = new Map<number, unknown>();
    const journal = createTelegramUpdateJournalStore({ path: join(dir, "journal.json"), profileName: "default",
      botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "live-donor" }),
      onPublicationBoundary(boundary) {
        if (activeFault && fault === "before-publication" && boundary === "after-write-before-rename") authority = false;
      } });
    let binding = "source";
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal: { ...journal, removeCompletedExact: fault === "no-exact" ? undefined : (...args) => {
        removed++;
        if (fault === "lost-before") throw new Error("Removal not confirmed before effect");
        const result = journal.removeCompletedExact(...args);
        if (fault === "after-publication") authority = false;
        if (fault === "lost-after") throw new Error("Removal ACK lost after effect");
        return fault === "bad-ack" ? { ...result, removedUpdateIds: [10] } : result;
      } }, getJournalBindingKey: () => binding, hasAuthority: () => authority, isContextCurrent: () => context,
      getQueueOwnerIdentity: () => ({ instanceId: "leader", processId: process.pid, processBirthId: `${process.pid}:donor`, sessionGeneration: generation }),
      async defaultHandle(update) {
        executed.push(update.update_id);
        if (update.update_id === 10 || update.update_id === 11) {
          originals.set(update.update_id, update.message); reportTelegramUpdateDeferred(update.message);
        }
      }, onUpdateCompleted(id) { completed.push(id); if (fault === "observer-replaced") context = false; },
    });
    const updates = [10, 11].map(update_id => ({ update_id, message: { message_id: update_id, chat: { id: 7 }, text: "original" } }));
    try {
      if (fault === "cold") journal.appendBatch(updates);
      worker.start("ctx"); await worker.waitForDrain();
      if (fault !== "cold") { journal.appendBatch(updates); worker.signal(); await worker.waitForDrain(); }
      const messages = [10, 11].map(id => originals.get(id));
      const preparation = prepareTelegramLiveDeferredInput(messages, () => authority);
      if (fault === "cold") { assert.equal(preparation, undefined); return; }
      assert.ok(preparation); assert.equal(preparation.confirmSaved(), true);
      if (fault === "authority") authority = false;
      if (fault === "context") context = false;
      if (fault === "binding") binding = "replaced";
      if (fault === "owner") generation++;
      if (fault === "stop") await worker.stop();
      if (fault === "changed") { journal.routingInputs!.arm({ entries: journal.read().entries.slice(1), journalBindingKey: createTelegramUpdateJournalBindingKey({
        path: join(dir, "journal.json"), profileName: "default", botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "live-donor" }) }),
        operatorUserId: 7, publishedAtMs: Date.now(), isCurrent: () => true }); }
      if (fault === "missing") journal.removeCompleted([11]);
      if (fault === "reported") reportTelegramQueueAdmission(messages, [{ receiptId: "independent", queueKind: "prompt", sourceUpdateIds: [10, 11], journalBindingKey: binding }]);
      const before = journal.read(); activeFault = true;
      const result = preparation.settleTransferred(() => fault !== "refused");
      const issued = ["normal", "before-publication", "after-publication", "lost-before", "lost-after", "bad-ack", "observer-replaced"].includes(fault);
      assert.equal(result, fault === "normal" ? "settled" : issued ? "unknown" : "protected");
      assert.equal(removed, issued ? 1 : 0);
      assert.notEqual(preparation.settleTransferred(() => fault !== "refused"), "settled", "A warm retry cannot mint or replay removal authority");
      assert.equal(removed, issued ? 1 : 0);
      if (issued) {
        assert.equal(preparation.beginRelease(() => true), false); assert.equal(preparation.cancel(), false);
      }
      if (["normal", "lost-after", "bad-ack", "after-publication", "observer-replaced"].includes(fault)) assert.deepEqual(journal.read().entries, []);
      else assert.deepEqual(journal.read(), before, "Failed eligibility and pre-publication loss retain the exact group");
      assert.equal(journal.read().sourceCompletions, undefined, "Donor disposition does not mint legacy Restore ACKs");
      assert.deepEqual(completed, fault === "normal" ? [10, 11] : fault === "observer-replaced" ? [10] : [], "Only exact current removal ACKs publish ordinary completion hints");
      assert.deepEqual(executed, [10, 11], "Settlement never replays original handlers");
      if (["normal", "lost-before", "lost-after", "bad-ack"].includes(fault)) {
        journal.appendBatch([{ update_id: 12 }]); worker.signal(); await worker.waitForDrain();
        assert.deepEqual(executed, [10, 11, 12], "Unrelated ordinary execution remains runnable");
      }
    } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

const TEST_CONTEXT = "ctx";
const REGISTRY_KEY = "__piTelegramUpdateHandlerRegistry__";

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
    ],
  );
  assert.deepEqual(
    TELEGRAM_REMOVAL_REACTIONS.map((reaction) => reaction.id),
    [20],
  );
  assert.deepEqual(TELEGRAM_PRIORITY_REACTION_EMOJIS, ["👍"]);
  assert.deepEqual(TELEGRAM_STEER_REACTIONS, [{ id: 14, name: "fire", emoji: "🔥" }]);
  assert.deepEqual(TELEGRAM_REMOVAL_REACTION_EMOJIS, ["👎"]);
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

test("Paired update runtime binds pairing ports into update routing", async () => {
  const events: string[] = [];
  let allowedUserId: number | undefined;
  const runtime = createTelegramPairedUpdateRuntime({
    getAllowedUserId: () => allowedUserId,
    persistAllowedUserId: async (userId) => {
      events.push(`persist:${userId}`);
      allowedUserId = userId;
      return true;
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
    "persist:42",
    "status:ctx",
    "message:ctx:10",
  ]);
});

test("Unpaired messages, edits, and callbacks require successful pairing publication before execution", async () => {
  const message = { chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false },
    message_id: 10, message_thread_id: 42 };
  const updates: TelegramUpdateFlow[] = [
    { message }, { edited_message: message },
    { callback_query: { id: "callback", from: message.from, message } },
  ];
  for (const route of ["local", "unbound", "message-owner", "target-owner"]) for (const update of updates) {
    let outcome: "failure" | "denied" | "allowed" = "failure";
    let allowedUserId: number | undefined;
    let attempts = 0;
    let executions = 0;
    let ownershipEffects = 0;
    const runtime = createTelegramPairedUpdateRuntime({
      getAllowedUserId: () => allowedUserId,
      getCurrentInstanceId: () => "leader",
      getMessageOwnership: () => route === "message-owner" ? { instanceId: "follower" } : undefined,
      getTargetOwnership: () => route === "target-owner" ? { instanceId: "follower" } : undefined,
      recordMessageOwnership() { ownershipEffects++; },
      foreignOwnedUpdateForwarder: {
        async forwardMessage() { executions++; return acceptedForeignUpdateSettlement(); },
        async forwardEditedMessage() { executions++; return acceptedForeignUpdateSettlement(); },
        async forwardCallback() { executions++; return acceptedForeignUpdateSettlement(); },
      },
      ...(route === "unbound" ? { async handleUnboundTelegramTopicMessage() { executions++; } } : {}),
      async persistAllowedUserId(userId) {
        attempts++;
        if (outcome === "failure") throw new Error("publication failed");
        if (outcome === "denied") return false;
        allowedUserId = userId;
        return true;
      },
      updateStatus() {}, removePendingMediaGroupMessages() {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      applyQueuedTelegramTurnReactionByMessageId: () => false,
      async answerCallbackQuery() {}, async answerGuestQuery() {},
      async sendTextReply() { return undefined; },
      async handleAuthorizedTelegramCallbackQuery() { executions++; },
      async handleAuthorizedTelegramMessage() { executions++; },
      handleAuthorizedTelegramEditedMessage() { executions++; },
    });
    await assert.rejects(runtime.handleUpdate(update, {}), /publication failed/);
    assert.equal(executions, 0, route);
    assert.equal(ownershipEffects, 0, route);
    assert.equal(allowedUserId, undefined);
    outcome = "denied";
    await runtime.handleUpdate(update, {});
    assert.equal(executions, 0, route);
    assert.equal(ownershipEffects, 0, route);
    outcome = "allowed";
    await runtime.handleUpdate(update, {});
    assert.equal(executions, 1);
    assert.equal(attempts, 3);
    const admittedOwnershipEffects = ownershipEffects;
    allowedUserId = 8;
    await runtime.handleUpdate(update, {});
    assert.equal(executions, 1, "An existing different owner also blocks delegation");
    assert.equal(attempts, 3);
    assert.equal(ownershipEffects, admittedOwnershipEffects);
  }
});

test("Paired update runtime preserves follower target ownership forwarding", async () => {
  const events: string[] = [];
  const runtime = createTelegramPairedUpdateRuntime({
    getAllowedUserId: () => 7,
    persistAllowedUserId: async () => true,
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
    persistAllowedUserId: async () => true,
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

test("Default update flow refuses business deletion authority even in a mixed carrier", () => {
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
  assert.deepEqual(action, { kind: "ignore" });
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

for (const paired of [false, true]) for (const edited of [false, true]) for (const outcome of ["matched", "ordinary", "denied", "source-lost", "failed", "invalid-response"] as const) {
test(`Private Delivery interception precedes all ordinary input lanes (paired=${paired}, edit=${edited}, ${outcome})`, async () => {
  const events: string[] = [];
  let current = true;
  const deps = {
    getAllowedUserId: () => 42, getCurrentInstanceId: () => "local",
    persistAllowedUserId: async () => true, updateStatus() {},
    removePendingMediaGroupMessages() {}, removeQueuedTelegramTurnsByMessageIds: () => 0,
    applyQueuedTelegramTurnReactionByMessageId: () => true, pairTelegramUserIfNeeded: async () => false,
    answerCallbackQuery: async () => {}, answerGuestQuery: async () => {}, handleAuthorizedTelegramCallbackQuery: async () => {},
    sendTextReply: async () => { events.push("denied"); return 1; },
    getMessageOwnership() { events.push("ownership"); return undefined; },
    getTargetOwnership() { events.push("target"); return undefined; },
    handleUnboundTelegramTopicMessage: async () => { events.push("unbound"); },
    handleAuthorizedTelegramMessage: async () => { events.push("message"); },
    handleAuthorizedTelegramEditedMessage: async () => { events.push("edit"); },
    async handleAuthorizedTelegramDeliveryReply(_message: unknown, _ctx: string, isEdited: boolean) {
      events.push(`private:${isEdited}`);
      if (outcome === "failed") throw new Error("Private disposition unavailable");
      if (outcome === "source-lost") { current = false; return paired; }
      if (outcome === "invalid-response") return undefined as unknown as boolean;
      return outcome === "matched";
    },
  };
  const runtime = paired ? createTelegramPairedUpdateRuntime(deps) : createTelegramUpdateRuntime(deps);
  const message = { message_id: 201, chat: { id: 42, type: "private" }, message_thread_id: 7,
    from: { id: outcome === "denied" ? 43 : 42, is_bot: false }, text: "/quit",
    reply_to_message: { message_id: 101 } };
  const operation = runtime.handleUpdate(edited ? { edited_message: message } : { message }, "ctx", {
    generation: 1, updateId: 301, signal: new AbortController().signal,
    isCurrent: () => current, assertCurrent() { if (!current) throw new Error("Source ended"); },
  });
  if (outcome === "source-lost") await assert.rejects(operation, /Source ended/);
  else if (outcome === "failed") await assert.rejects(operation, /Private disposition unavailable/);
  else if (outcome === "invalid-response") await assert.rejects(operation, /Private Delivery reply disposition is unavailable/);
  else await operation;
  if (outcome === "denied") assert.deepEqual(events, ["denied"]);
  else if (outcome === "ordinary") assert.deepEqual(events, [`private:${edited}`, "ownership", "target", edited ? "edit" : "unbound"]);
  else assert.deepEqual(events, [`private:${edited}`]);
});
}

for (const edited of [false, true]) {
test(`Successful first-contact pairing precedes private interception (edit=${edited})`, async () => {
  const events: string[] = [];
  let allowed: number | undefined;
  const runtime = createTelegramPairedUpdateRuntime({
    getAllowedUserId: () => allowed,
    async persistAllowedUserId(id) { events.push("persist"); allowed = id; return true; },
    updateStatus() { events.push("status"); }, removePendingMediaGroupMessages() {},
    removeQueuedTelegramTurnsByMessageIds: () => 0, applyQueuedTelegramTurnReactionByMessageId: () => true,
    answerCallbackQuery: async () => {}, answerGuestQuery: async () => {}, handleAuthorizedTelegramCallbackQuery: async () => {},
    async sendTextReply() { events.push("notice"); return 1; },
    async handleAuthorizedTelegramDeliveryReply(_message, _ctx: string, isEdited) {
      assert.equal(allowed, 42); assert.equal(isEdited, edited); events.push("private"); return true;
    },
    getMessageOwnership() { assert.fail("A private answer cannot reach ordinary ownership after pairing"); },
    handleAuthorizedTelegramMessage: async () => assert.fail("No model dispatch"),
    handleAuthorizedTelegramEditedMessage: async () => assert.fail("No queued prompt edit"),
  });
  const message = { message_id: 201, chat: { id: 42, type: "private" }, from: { id: 42, is_bot: false }, text: "private" };
  await runtime.handleUpdate(edited ? { edited_message: message } : { message }, "ctx");
  assert.deepEqual(events, edited ? ["persist", "status", "private"] : ["persist", "status", "notice", "private"]);
});
}

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

test("Steer reactions use effective intent, fire dominance, and independent suppression", async () => {
  const store = Queue.createTelegramQueueStore<string>();
  store.setQueuedItems([{ kind: "prompt", chatId: 7, replyToMessageId: 10, queueOrder: 1, queueLane: "default", laneOrder: 1,
    sourceMessageIds: [10], queuedAttachments: [], content: [{ type: "text", text: "steer" }], historyText: "", statusSummary: "steer" }]);
  let order = 20, calls = 0;
  const mutation = Queue.createTelegramQueueMutationController({ ...store, allocateLaneOrder: () => ++order, updateStatus: () => {} });
  const react = (old: string[], next: string[], userId = 7) => handleAuthorizedTelegramReactionUpdate({
    chat: { id: 7, type: "private" }, user: { id: userId, is_bot: false }, message_id: 10,
    old_reaction: old.map(emoji => ({ type: "emoji", emoji })), new_reaction: next.map(emoji => ({ type: "emoji", emoji })),
  }, { allowedUserId: 7, ctx: TEST_CONTEXT, applyQueuedTelegramTurnReactionByMessageId: (id, disposition, ctx, scope) => {
    calls += 1; return mutation.applyReactionByMessageId(id, disposition, ctx, scope);
  } });
  await react([], ["👍"]); assert.equal(store.getQueuedItems()[0]!.queueLane, "priority");
  await react(["👍"], ["👍", "🔥️"]); assert.equal(store.getQueuedItems()[0]!.queueLane, "steer");
  const steer = store.getQueuedItems()[0]; const count = calls;
  await react(["👍", "🔥"], ["🔥"]); await react(["🔥"], ["🔥", "👍", "🎉"]);
  assert.equal(calls, count); assert.equal(store.getQueuedItems()[0], steer);
  await react(["🔥", "👍"], ["🔥", "👍", "👎"]);
  const skipped = store.getQueuedItems()[0] as Queue.PendingTelegramTurn;
  assert.equal(skipped.queueLane, "steer"); assert.equal(skipped.laneOrder, steer!.laneOrder);
  assert.equal(skipped.reactionSuppressionEmoji, "👎");
  await react(["🔥", "👍", "👎"], ["👍", "👎"]);
  assert.equal(store.getQueuedItems()[0]!.queueLane, "priority");
  await react(["👍", "👎"], ["👎"]); assert.equal(store.getQueuedItems()[0]!.queueLane, "default");
  await react(["👎"], []);
  const plain = store.getQueuedItems()[0]; const plainCalls = calls;
  await react([], ["⚡", "🎉"]); assert.equal(calls, plainCalls); assert.equal(store.getQueuedItems()[0], plain);
  await react([], ["🔥"], 8); assert.equal(calls, plainCalls);
  if (plain?.kind === "prompt") plain.steerAttempted = true;
  await react([], ["🔥"]); assert.equal(store.getQueuedItems()[0], plain, "Late fire never reissues protected work");
});

test("Unsupported reactions neither control the queue nor retain removed supported intent", async () => {
  for (const ignored of ["❤", "❤️", "🕊", "🕊️", "👻", "💔", "💩", "🗑", "🗑️", "⚡", "⚡️", "🎉"]) {
    const transitions: Queue.TelegramQueueReactionDisposition[] = [];
    let flushes = 0;
    const react = (old: string[], next: string[]) => handleAuthorizedTelegramReactionUpdate({
      chat: { id: 7, type: "private" }, user: { id: 7, is_bot: false }, message_id: 10,
      old_reaction: old.map(emoji => ({ type: "emoji", emoji })), new_reaction: next.map(emoji => ({ type: "emoji", emoji })),
    }, { allowedUserId: 7, ctx: TEST_CONTEXT,
      flushPendingMediaGroupMessage: async () => { flushes++; return true; },
      applyQueuedTelegramTurnReactionByMessageId: (_id, disposition) => { transitions.push(disposition); return true; },
    });
    await react([], [ignored]); await react([ignored], []);
    for (const supported of ["👍", "👎", "🔥"]) {
      await react([supported], [supported, ignored]);
      await react([supported, ignored], [supported]);
    }
    assert.deepEqual(transitions, [], `${ignored} is decorative, including beside supported intent`);
    assert.equal(flushes, 0, "An unsupported reaction must not flush a prompt or cancel a waiting continuation");
    await react(["👍", ignored], [ignored]);
    await react(["🔥", ignored], [ignored]);
    await react(["👎", ignored], [ignored]);
    await react([ignored], ["🔥", ignored]);
    assert.deepEqual(transitions, [
      { kind: "reaction-transition", priorityEmoji: null },
      { kind: "reaction-transition", priorityEmoji: null },
      { kind: "reaction-transition", suppressionEmoji: null },
      { kind: "reaction-transition", priorityEmoji: "🔥", promptLane: "steer" },
    ], `${ignored} cannot substitute for a removed supported reaction`);
  }
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
    "apply:16:reaction-transition:p:🔥;s:=",
    "apply:21:reaction-transition:p:👍;s:=",
    "apply:22:reaction-transition:p:=;s:-",
    "apply:23:reaction-transition:p:=;s:-",
    "apply:24:reaction-transition:p:👍;s:-",
  ]);
});

test("Reaction sender admission precedes private/group ownership lookup, forwarding, and queue effects", async () => {
  const cases = [
    { name: "owner", allowed: 7, user: { id: 7, is_bot: false }, permitted: true },
    { name: "unpaired", allowed: undefined, user: { id: 7, is_bot: false }, permitted: false },
    { name: "other-user", allowed: 7, user: { id: 8, is_bot: false }, permitted: false },
    { name: "bot", allowed: 7, user: { id: 7, is_bot: true }, permitted: false },
    { name: "missing-user", allowed: 7, user: undefined, permitted: false },
    { name: "invalid-owner", allowed: 0, user: { id: 0, is_bot: false }, permitted: false },
    { name: "actor-chat", allowed: 7, user: undefined, actor_chat: { id: -100 }, permitted: false },
    { name: "ambiguous-actor", allowed: 7, user: { id: 7, is_bot: false }, actor_chat: { id: -100 }, permitted: false },
  ];
  for (const chatType of ["private", "supergroup"]) {
    for (const foreign of [false, true]) {
      for (const scenario of cases) {
        const events: string[] = [];
        const reaction = {
          chat: { id: 7, type: chatType }, user: scenario.user,
          ...(scenario.actor_chat ? { actor_chat: scenario.actor_chat } : {}),
          message_id: 10, old_reaction: [], new_reaction: [{ type: "emoji" as const, emoji: "👎" }],
        };
        await handleAuthorizedTelegramReactionUpdate(reaction, {
          allowedUserId: scenario.allowed, ctx: TEST_CONTEXT,
          getCurrentInstanceId: () => { events.push("instance"); return "local"; },
          getMessageOwnership: () => { events.push("lookup"); return { instanceId: foreign ? "remote" : "local" }; },
          foreignOwnedUpdateForwarder: { forwardReaction: () => {
            events.push("forward"); return acceptedForeignUpdateSettlement();
          } },
          flushPendingMediaGroupMessage: async () => { events.push("media"); return true; },
          flushPendingTextGroupMessage: async () => { events.push("text"); return true; },
          applyQueuedTelegramTurnReactionByMessageId: () => { events.push("apply"); return true; },
        });
        const label = `${chatType}/${foreign ? "foreign" : "local"}/${scenario.name}`;
        if (!scenario.permitted) assert.deepEqual(events, [], label);
        else if (foreign) {
          assert.equal(events.filter((event) => event === "forward").length, 1, label);
          assert.equal(events.includes("apply"), false, label);
        } else {
          assert.deepEqual(events.slice(-3), ["media", "text", "apply"], label);
          assert.equal(events.includes("forward"), false, label);
        }
      }
    }
  }
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

test("Internal agent messages bypass outbound message ownership and private human reply interception", async () => {
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
      handleAuthorizedTelegramDeliveryReply: async () => { assert.fail("Agent messages are not human SDK answers"); },
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
      handleAuthorizedTelegramDeliveryReply: async () => { assert.fail("Private interception cannot steal agent routing"); },
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
    "answer:cb-foreign:This Telegram message belongs to another Pi instance",
  ]);
});

for (const outcome of ["accepted", "retryable"] as const)
test(`Update runtime releases a slow forwarded tap once, without a second toast (${outcome})`, async () => {
  const events: string[] = [];
  const run = executeTelegramUpdatePlan(
    {
      kind: "callback",
      query: { id: "cb-slow", from: { id: 7, is_bot: false }, message: { chat: { id: 10, type: "private" }, message_id: 99 } },
      shouldPair: false,
      shouldDeny: false,
    },
    {
      ctx: TEST_CONTEXT,
      foreignCallbackReleaseMs: 5,
      getCurrentInstanceId: () => "instance-a",
      getMessageOwnership: () => ({ instanceId: "instance-b" }),
      foreignOwnedUpdateForwarder: {
        forwardCallback: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          events.push("forward-settled");
          return outcome === "accepted"
            ? acceptedForeignUpdateSettlement()
            : { status: "retryable" as const, failureClass: "transport-failed" as const, message: "Telegram follower forwarding ownership changed." };
        },
      },
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => false,
      answerCallbackQuery: async (id, text) => { events.push(`answer:${id}:${text}`); },
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => { events.push("callback"); },
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {},
      handleAuthorizedTelegramEditedMessage: async () => {},
    },
  );
  if (outcome === "accepted") await run;
  else await assert.rejects(run, /forwarding did not settle/u);
  assert.deepEqual(events, ["answer:cb-slow:undefined", "forward-settled"],
    "The neutral answer precedes the slow settlement and is the only answer for this query");
});

test("Update runtime tells a retryable foreign callback settlement from a foreign-ownership verdict", async () => {
  const events: string[] = [];
  await assert.rejects(
    executeTelegramUpdatePlan(
      {
        kind: "callback",
        query: { id: "cb-busy", from: { id: 7, is_bot: false }, message: { chat: { id: 10, type: "private" }, message_id: 99 } },
        shouldPair: false,
        shouldDeny: false,
      },
      {
        ctx: TEST_CONTEXT,
        getCurrentInstanceId: () => "instance-a",
        getMessageOwnership: () => ({ instanceId: "instance-b" }),
        foreignOwnedUpdateForwarder: {
          forwardCallback: () => ({
            status: "retryable" as const,
            failureClass: "transport-failed" as const,
            message: "Telegram follower forwarding ownership changed.",
          }),
        },
        removePendingMediaGroupMessages: () => {},
        removeQueuedTelegramTurnsByMessageIds: () => 0,
        handleAuthorizedTelegramReactionUpdate: async () => {},
        pairTelegramUserIfNeeded: async () => false,
        answerCallbackQuery: async (id, text) => { events.push(`answer:${id}:${text}`); },
        answerGuestQuery: async () => {},
        handleAuthorizedTelegramCallbackQuery: async () => { events.push("callback"); },
        sendTextReply: async () => undefined,
        handleAuthorizedTelegramMessage: async () => {},
        handleAuthorizedTelegramEditedMessage: async () => {},
      },
    ),
    /forwarding did not settle: transport-failed/u,
  );
  assert.deepEqual(events, ["answer:cb-busy:Pi instance is busy, retrying"],
    "A transient forwarding failure keeps the journaled retry and never claims the message belongs to another instance");
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

test("Callback ownership rebinds a stable message binding to the current follower generation", async () => {
  const observed: Array<{
    instanceId: string;
    ownerGeneration?: string;
    recipientBindingKey?: string;
  }> = [];
  await executeTelegramUpdatePlan(
    {
      kind: "callback",
      query: {
        id: "cb-reconnected",
        from: { id: 7, is_bot: false },
        message: { chat: { id: 10, type: "private" }, message_id: 99,
          message_thread_id: 42 },
      },
      shouldPair: false,
      shouldDeny: false,
    },
    {
      ctx: TEST_CONTEXT,
      getCurrentInstanceId: () => "leader",
      getMessageOwnership: () => ({
        instanceId: "old-follower",
        ownerGeneration: "old-generation",
        recipientBindingKey: "workspace:b",
      }),
      getTargetOwnership: () => ({
        instanceId: "current-follower",
        ownerGeneration: "current-generation",
        recipientBindingKey: "workspace:b",
      }),
      foreignOwnedUpdateForwarder: {
        forwardCallback: ({ ownership }) => {
          observed.push(ownership);
          return acceptedForeignUpdateSettlement();
        },
      },
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => false,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {
        assert.fail("Reconnected follower callback reached local handling.");
      },
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {},
      handleAuthorizedTelegramEditedMessage: async () => {},
    },
  );
  assert.deepEqual(observed, [{
  instanceId: "current-follower",
  ownerGeneration: "current-generation",
  recipientBindingKey: "workspace:b",
  }]);
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
    "answer:cb:Access denied",
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

test("A refused recipient reply retains journal evidence without immediately replaying command effects", async () => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-refused-recipient-"));
  const original = {
    update_id: 77,
    message: {
      message_id: 5, message_thread_id: 99, chat: { id: 7 },
      reply_to_message: { message_id: 4 }, text: "/start",
    },
  };
  const journal = createTelegramUpdateJournalStore({
    path: join(directory, "journal.json"),
    botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "refused-recipient" }),
  });
  let committedEffects = 0;
  let terminalChecks = 0;
  // The former internal recovery port must not restore handler replay even in a retained caller configuration.
  const obsoleteRecovery = {
    recoverRejectedRecipientTarget: () => ({
      rejected: { chatId: 7, threadId: 99 }, current: { chatId: 7, threadId: 55 },
    }),
  };
  const worker = createTelegramUpdateAdmissionWorkerRuntime({
    ...obsoleteRecovery,
    journal,
    hasAuthority: () => true,
    getNowMs: () => 1_000,
    defaultHandle: async (update) => {
      committedEffects += 1;
      assert.deepEqual(update, original);
      throw new TelegramApiFollowerNotAllowedError(
        "Telegram bus API call is not allowed for this follower.",
        { chatId: 7, threadId: 99 },
      );
    },
    settleTerminalExecutionFailure: async () => {
      terminalChecks += 1;
      return false;
    },
  });
  try {
    journal.appendBatch([original]);
    worker.start("ctx");
    await worker.waitForDrain();
    assert.equal(committedEffects, 1, "A refused reply cannot authorize immediate handler re-entry");
    assert.equal(terminalChecks, 1);
    const entry = journal.read().entries[0]!;
    assert.deepEqual(entry.update, original, "The saved source is neither retargeted nor discarded");
    assert.equal(entry.state, "retry-wait");
    assert.equal(entry.failure?.attemptCount, 1);
    assert.ok(entry.nextRetryAtMs! > 1_000);
    worker.signal();
    await worker.waitForDrain();
    assert.equal(committedEffects, 1, "Signals before the durable retry deadline cannot replay effects");
    assert.equal(worker.getState().retryWaitCount, 1);
  } finally {
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
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

async function withAbandonmentJournal(run: (fixture: {
  journal: TelegramUpdateJournalStore; path: string; bindingKey: string;
}) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-deferred-abandonment-"));
  const path = join(dir, "inbox.json");
  const options = { path, botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "fixture:abandonment", botId: 7 }) };
  try {
    await run({ journal: createTelegramUpdateJournalStore(options), path,
      bindingKey: createTelegramUpdateJournalBindingKey(options) });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function stageInterruptedAbandonments(journal: TelegramUpdateJournalStore, path: string, bindingKey: string, ids: number[]): void {
  const before = journal.read();
  const interrupted = createTelegramUpdateJournalStore({ path, profileName: before.profile, botIdentity: before.botIdentity,
    onPublicationBoundary(boundary, target) {
      if (boundary === "before-write" && !target.startsWith(`${path}.retained`)) throw new Error("fixture interrupted discard");
    } });
  const entries = before.entries.filter(entry => ids.includes(entry.updateId));
  assert.equal(entries.length, ids.length);
  for (const entry of entries) assert.throws(() => interrupted.abandonPending({ entry, journalBindingKey: bindingKey,
    operatorAuthorityId: "owner:7", isCurrent: () => true }));
  assert.deepEqual(journal.read(), before, "Retention alone must not commit abandonment");
}

function recoveryQuery(updateId: number) {
  return { update_id: updateId, callback_query: { id: `recovery-${updateId}`, from: { id: 7, is_bot: false },
    data: "fixture:recover", message: { message_id: updateId + 100, chat: { id: 7, type: "private" } } } };
}

for (const corrupted of [false, true]) test(`Retained cancellation blocks restart execution until exact owner recovery (corrupted=${corrupted})`, async () => {
  await withAbandonmentJournal(async ({ journal, bindingKey, path }) => {
    journal.appendBatch([{ update_id: 1, message: { text: "retained original" } }, recoveryQuery(2)]);
    const initial = journal.read();
    const entry = initial.entries[0]!;
    const options = { path, profileName: initial.profile, botIdentity: initial.botIdentity };
    stageInterruptedAbandonments(journal, path, bindingKey, [1]);
    const [name] = await readdir(`${path}.retained`);
    const retainedPath = join(`${path}.retained`, name!);
    if (corrupted) await writeFile(retainedPath, "{invalid-retention-fixture");
    const retainedBytes = await readFile(retainedPath, "utf8");
    const restarted = createTelegramUpdateJournalStore(options);
    let carrier: unknown;
    const executed: number[] = [];
    const failures: unknown[] = [];
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal: restarted, getJournalBindingKey: () => bindingKey,
      hasAuthority: () => true,
      async defaultHandle(update) { executed.push(update.update_id); carrier = update.callback_query; },
      recordRuntimeEvent(_category, error) { failures.push(error); },
    });
    try {
      worker.start("successor");
      await worker.waitForDrain();
      assert.deepEqual(executed, [2], "A retained cancellation must not reach default routing after restart");
      assert.equal(worker.getState().abandoningClaimCount, 1);
      assert.equal(worker.getState().lastCompletedUpdateId, 2);
      assert.deepEqual(restarted.read().entries, [entry]);
      assert.equal(restarted.read().operatorDispositions, undefined);
      worker.signal();
      await worker.waitForDrain();
      assert.deepEqual(executed, [2]);
      const page = inspectTelegramAbandoningUpdates(carrier, { journalBindingKey: bindingKey, isCurrent: () => true });
      assert.equal(page?.sources.length, 1);
      assert.deepEqual(page.sources[0]!.original, entry);
      assert.equal(page.nextAfterUpdateId, undefined);
      const recover = () => page.sources[0]!.retry({ operatorAuthorityId: "owner:7", isCurrent: () => true });
      if (corrupted) {
        assert.ok(failures.length > 0);
        assert.throws(recover);
        assert.deepEqual(restarted.read().entries, [entry]);
        assert.equal(worker.getState().abandoningClaimCount, 1);
      } else {
        const result = recover();
        assert.ok(result);
        assert.equal(result.duplicate, false);
        assert.equal(recover()?.duplicate, true, "A failed UI acknowledgement may reuse the exact committed receipt");
        await worker.waitForDrain();
        assert.equal(worker.getState().abandoningClaimCount, undefined);
        assert.deepEqual(restarted.read().entries, []);
        assert.deepEqual(restarted.appendBatch([entry.update]).duplicateUpdateIds, [1]);
      }
      assert.equal(await readFile(retainedPath, "utf8"), retainedBytes, "Recovery must not overwrite retained evidence");
      assert.equal(worker.getState().lastCompletedUpdateId, 2, "Abandonment must not become task completion");
    } finally { await worker.stop(); }
  });
});

test("Protected recovery pages are bounded, read-only and cannot retarget or dispatch original inputs", async () => {
  await withAbandonmentJournal(async ({ journal, bindingKey, path }) => {
    const originals = Array.from({ length: 23 }, (_, index) => ({ update_id: index + 1,
      message: { message_id: index + 1, from: { id: 7, is_bot: false }, chat: { id: 7, type: "private" }, text: `source ${index + 1}` } }));
    journal.appendBatch([...originals, recoveryQuery(100)]);
    stageInterruptedAbandonments(journal, path, bindingKey, Array.from({ length: 21 }, (_, index) => index + 1));
    let carrier: unknown;
    let reads = 0;
    const executed: number[] = [];
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal: { ...journal, read() { reads++; return journal.read(); } },
      getJournalBindingKey: () => bindingKey, hasAuthority: () => true,
      async defaultHandle(update) {
        executed.push(update.update_id);
        if (update.update_id === 22) reportTelegramUpdateDeferred(update.message);
        else if (update.update_id === 23) reportTelegramQueueAdmission([update.message], [{ queueKind: "prompt",
          receiptId: "protected-queue", sourceUpdateIds: [23] }]);
        else carrier = update.callback_query;
      },
    });
    try {
      worker.start("owner");
      await worker.waitForDrain();
      assert.deepEqual(executed, [22, 23, 100]);
      const before = journal.read();
      reads = 0;
      const request = { journalBindingKey: bindingKey, isCurrent: () => true };
      const page = inspectTelegramAbandoningUpdates(carrier, request)!;
      assert.equal(page.sources.length, 20);
      assert.deepEqual(page.sources.map(source => source.original.updateId), Array.from({ length: 20 }, (_, index) => index + 1));
      assert.equal(page.nextAfterUpdateId, 20);
      const next = inspectTelegramAbandoningUpdates(carrier, { ...request, afterUpdateId: page.nextAfterUpdateId })!;
      assert.deepEqual(next.sources.map(source => source.original.updateId), [21]);
      assert.equal(next.nextAfterUpdateId, undefined);
      for (const afterUpdateId of [-1, 0.5, Infinity]) {
        assert.equal(inspectTelegramAbandoningUpdates(carrier, { ...request, afterUpdateId }), undefined);
      }
      assert.equal(inspectTelegramAbandoningUpdates(carrier, { ...request, journalBindingKey: "foreign" }), undefined);
      assert.equal(reads, 0, "Review must not scan, repair or republish the journal");
      assert.deepEqual(journal.read(), before);
      const source = page.sources[0]!;
      source.original.updateId = 23;
      source.original.update.update_id = 23;
      (source.original.update.message as { text: string }).text = "changed view";
      const result = source.retry({ operatorAuthorityId: "owner:7", isCurrent: () => true });
      assert.ok(result);
      assert.equal(result.disposition.updateId, 1, "Display metadata cannot retarget a source-bound capability");
      assert.deepEqual(JSON.parse(await readFile(result.retainedPath, "utf8")).entry.update, originals[0]);
      await worker.waitForDrain();
      assert.equal(journal.read().entries.find(entry => entry.updateId === 23)?.state, "queued");
      assert.equal(journal.read().entries.find(entry => entry.updateId === 22)?.state, "pending");
      assert.equal(worker.getState().lastCompletedUpdateId, 100);
      assert.deepEqual(executed, [22, 23, 100]);
      assert.deepEqual(inspectTelegramAbandoningUpdates(carrier, request)!.sources.map(item => item.original.updateId),
        Array.from({ length: 20 }, (_, index) => index + 2));
    } finally { await worker.stop(); }
  });
});

test("Protected recovery capabilities revoke on caller, binding, transport, context and worker generation changes", async () => {
  await withAbandonmentJournal(async ({ journal, bindingKey, path }) => {
    journal.appendBatch([{ update_id: 1, message: { text: "private original" } }, recoveryQuery(2)]);
    stageInterruptedAbandonments(journal, path, bindingKey, [1]);
    let carrier: unknown;
    let currentBinding = bindingKey;
    let transport = true;
    let context = true;
    let view = true;
    let forbiddenContextRead = false;
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal, getJournalBindingKey: () => currentBinding, hasAuthority: () => transport,
      isContextCurrent() { if (forbiddenContextRead) throw new Error("stale context getter"); return context; },
      async defaultHandle(update) { carrier = update.callback_query; },
    });
    try {
      worker.start("owner");
      await worker.waitForDrain();
      const request = { journalBindingKey: bindingKey, isCurrent: () => view };
      const page = inspectTelegramAbandoningUpdates(carrier, request)!;
      const retry = page.sources[0]!.retry;
      const authority = { operatorAuthorityId: "owner:7", isCurrent: () => true };
      const before = journal.read();
      const assertRevoked = () => {
        assert.equal(inspectTelegramAbandoningUpdates(carrier, request), undefined);
        assert.equal(retry(authority), undefined);
        assert.deepEqual(journal.read(), before);
      };
      currentBinding = "foreign"; assertRevoked(); currentBinding = bindingKey;
      transport = false; assertRevoked(); transport = true;
      context = false; assertRevoked(); context = true;
      view = false; forbiddenContextRead = true; assertRevoked(); forbiddenContextRead = false; view = true;
      forbiddenContextRead = true;
      assert.equal(retry({ ...authority, isCurrent: () => false }), undefined);
      forbiddenContextRead = false;
      assert.deepEqual(journal.read(), before);
      await worker.stop();
      forbiddenContextRead = true;
      assertRevoked();
      forbiddenContextRead = false;
      worker.start("successor");
      journal.appendBatch([recoveryQuery(3)]);
      worker.signal();
      await worker.waitForDrain();
      assert.equal(retry(authority), undefined, "A new worker generation cannot revive old controls");
      const fresh = inspectTelegramAbandoningUpdates(carrier, request)!;
      assert.equal(fresh.sources.length, 1);
      assert.ok(fresh.sources[0]!.retry(authority));
      await worker.waitForDrain();
      assert.deepEqual(journal.read().entries, []);
      assert.equal(worker.getState().lastCompletedUpdateId, 3);
      view = false;
      assert.equal(fresh.sources[0]!.retry(authority), undefined, "Even a cached commit needs current presentation authority");
    } finally { await worker.stop(); }
  });
});

for (const mode of ["early", "late", "before-copy", "after-copy", "committed-unknown"] as const) {
  test(`Historical holds stop routing and preserve exact retry across failures (${mode})`, async () => {
    await withAbandonmentJournal(async ({ journal, bindingKey, path }) => {
      const original = { update_id: 1, message: { message_id: 11, chat: { id: 7, type: "private" }, text: "historical original" } };
      journal.appendBatch([original, recoveryQuery(2)]);
      const entry = structuredClone(journal.read().entries[0]!);
      const executed: number[] = [];
      const registryInputs: number[] = [];
      let carrier: unknown;
      let originalCarrier: unknown;
      let fail = mode !== "early" && mode !== "late";
      let calls = 0;
      const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
        journal: { ...journal, abandonPending(request) {
          calls++;
          if (fail) {
            if (mode === "after-copy") stageInterruptedAbandonments(journal, path, bindingKey, [1]);
            if (mode === "committed-unknown") journal.abandonPending(request);
            throw new Error("fixture uncertain stop");
          }
          return journal.abandonPending(request);
        } },
        getJournalBindingKey: () => bindingKey, hasAuthority: () => true,
        shouldReviewHistoricalInput(candidate) {
          candidate.update = { update_id: 999 }; // Cannot rewrite retained evidence.
          return candidate.updateId === 1 && mode !== "late";
        },
        registry: { version: 1, add: () => () => {}, async dispatch(update) {
          registryInputs.push((update as TelegramJournaledUpdate).update_id); return "pass";
        } },
        async defaultHandle(update) {
          executed.push(update.update_id);
          if (update.update_id === 1) {
            originalCarrier = update.message;
            assert.equal(isTelegramHistoricalInput(originalCarrier), true);
            assert.equal(isTelegramHistoricalInput(originalCarrier, candidate => {
              assert.deepEqual(candidate, entry);
              candidate.update = { update_id: 999 };
              return false;
            }), false);
            assert.equal(isTelegramHistoricalInput(originalCarrier, candidate => {
              assert.deepEqual(candidate, entry, "Eligibility predicates receive detached original evidence");
              return true;
            }), true);
            assert.equal(reportTelegramHistoricalRoutingReview(originalCarrier), true);
            assert.equal(getTelegramUpdateExecutionFence(originalCarrier)?.isCurrent(), false);
            assert.equal(reportTelegramUpdateCompleted(originalCarrier), false);
            assert.equal(reportTelegramQueueAdmission([originalCarrier], [{ queueKind: "prompt", receiptId: "late", sourceUpdateIds: [1] }]), false);
          } else carrier = update.callback_query;
        },
      });
      try {
        worker.start("ctx");
        await worker.waitForDrain();
        assert.deepEqual(executed, mode === "late" ? [1, 2] : [2]);
        assert.deepEqual(registryInputs, executed, "Early holds precede companion handlers too");
        assert.deepEqual(journal.read().entries, [entry]);
        assert.equal(worker.getState().historicalClaimCount, 1);
        assert.equal(worker.getState().abandoningClaimCount, undefined);
        const request = { journalBindingKey: bindingKey, isCurrent: () => true };
        const view = inspectTelegramHistoricalInputs(carrier, request)!;
        assert.deepEqual(view.sources.map(source => source.original.updateId), [1]);
        assert.deepEqual(inspectTelegramAbandoningUpdates(carrier, request)!.sources, []);
        assert.equal(worker.abandonDeferred?.({ updateId: 1, signal: getTelegramUpdateExecutionFence(carrier)!.signal,
          operatorAuthorityId: "owner:7", isCurrent: () => true }), undefined, "Ordinary cancellation never grants historical authority");
        let source = view.sources[0]!;
        source.original.updateId = 999;
        source.original.update = { update_id: 999 };
        const authority = { operatorAuthorityId: "owner:7", isCurrent: () => true };
        if (fail) {
          assert.throws(() => source.retry(authority), /fixture uncertain stop/);
          assert.equal(worker.getState().historicalClaimCount, undefined);
          assert.equal(worker.getState().abandoningClaimCount, 1);
          worker.signal();
          await worker.waitForDrain();
          assert.deepEqual(executed, mode === "late" ? [1, 2] : [2]);
          fail = false;
          if (mode === "after-copy" || mode === "before-copy") {
            await worker.stop();
            assert.equal(source.retry(authority), undefined);
            journal.appendBatch([recoveryQuery(3)]);
            worker.start("successor");
            await worker.waitForDrain();
            const page = mode === "after-copy" ? inspectTelegramAbandoningUpdates(carrier, request) : inspectTelegramHistoricalInputs(carrier, request);
            assert.equal(page?.sources.length, 1);
            source = page!.sources[0]!;
          }
        }
        const result = source.retry(authority);
        assert.ok(result);
        assert.deepEqual(JSON.parse(await readFile(result.retainedPath, "utf8")).entry, entry);
        assert.deepEqual(journal.read().entries, []);
        assert.equal(source.retry(authority)?.duplicate, true);
        assert.equal(calls, mode === "early" || mode === "late" ? 1 : 2);
        assert.deepEqual(journal.appendBatch([original]).duplicateUpdateIds, [1]);
        assert.notEqual(worker.getState().lastCompletedUpdateId, 1, "Stopping retries never claims task completion");
      } finally { await worker.stop(); }
      assert.equal(worker.getState().historicalClaimCount, undefined);
      assert.equal(isTelegramHistoricalInput(originalCarrier, () => { assert.fail("Revoked carriers cannot evaluate source predicates"); }), false);
    });
  });
}

for (const historical of [true, false]) test(`Protected retry sources stay intact without suppressing independent retries (startup=${historical})`, async () => {
  await withAbandonmentJournal(async ({ journal, bindingKey }) => {
    const appendSources = () => {
      journal.appendBatch([1, 2, 3].map(update_id => ({ update_id, message: { text: `source-${update_id}` } })));
      for (const updateId of [1, 2, 3]) journal.markExecutionFailure({ updateId, expectedAttemptCount: 0,
        failedAtMs: 1, nextRetryAtMs: updateId === 3 ? 250 : 2, failureClass: "fixture", summary: "interrupted execution", disposition: "retry-wait" });
    };
    if (historical) appendSources();
    const handled: number[] = [], delays: number[] = [];
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal, getJournalBindingKey: () => bindingKey, hasAuthority: () => true, getNowMs: () => 100,
      shouldReviewHistoricalInput() { assert.fail("Retry state must use the protection predicate, not plain historical review."); },
      shouldHoldPendingInput(entry) { return entry.updateId === 1; },
      async defaultHandle(update) { handled.push(update.update_id); },
      scheduleRetry(_callback, delay) { delays.push(delay); return {}; }, cancelRetry() {},
    });
    try {
      worker.start("ctx");
      if (!historical) { await worker.waitForDrain(); appendSources(); worker.signal(); }
      const protectedSource = structuredClone(journal.read().entries.find(entry => entry.updateId === 1));
      await worker.waitForDrain();
      assert.deepEqual(handled, [2], "only the independent due retry executes");
      assert.deepEqual(journal.read().entries.find(entry => entry.updateId === 1), protectedSource, "hold preserves the source and failure metadata byte-for-value");
      assert.equal(journal.inspectAbandonedPending(1), undefined, "no implicit cancellation");
      assert.deepEqual(delays, [150], "the protected due source cannot create a hot retry timer; an independent future retry still wakes");
      worker.signal(); await worker.waitForDrain();
      assert.deepEqual(handled, [2]);
      assert.deepEqual(delays, [150]);
    } finally { await worker.stop(); }
  });
});

for (const entryState of ["pending", "retry-wait"] as const) for (const historical of [true, false]) for (const fault of ["throw", "generation", "context", "transport", "binding", "queued", "read", "invalid"] as const) {
  test(`Pending classification fails closed across ${fault} (startup=${historical}, state=${entryState})`, async () => {
    await withAbandonmentJournal(async ({ journal, bindingKey }) => {
      const appendOriginal = () => {
        journal.appendBatch([{ update_id: 1, message: { text: "original" } }]);
        if (entryState === "retry-wait") journal.markExecutionFailure({ updateId: 1, expectedAttemptCount: 0,
          failedAtMs: 1, nextRetryAtMs: 2, failureClass: "fixture", summary: "interrupted execution", disposition: "retry-wait" });
      };
      if (historical) appendOriginal();
      let expected = journal.read();
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      let context = true;
      let owned = true;
      let key = bindingKey;
      let staleContext = false;
      let failRead = false;
      let calls = 0;
      const classify = async () => {
        entered(); await wait;
        if (fault === "throw") throw new Error("fixture classifier");
        return fault === "invalid" ? undefined as never : false;
      };
      const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
        journal: { ...journal, read() { if (failRead) throw new Error("fixture recheck unavailable"); return journal.read(); } },
        getJournalBindingKey: () => key, hasAuthority: () => owned,
        isContextCurrent() { if (staleContext) throw new Error("stale context getter"); return context; },
        ...(historical && entryState === "pending" ? { shouldReviewHistoricalInput: classify } : { shouldHoldPendingInput: classify }),
        async defaultHandle() { calls++; },
      });
      try {
        worker.start("ctx");
        if (!historical) {
          await worker.waitForDrain();
          appendOriginal(); expected = journal.read(); worker.signal();
        }
        await ready;
        if (fault === "context") context = false;
        if (fault === "transport") owned = false;
        if (fault === "binding") key = "other-binding";
        if (fault === "queued") {
          journal.markQueued({ queueKind: "prompt", receiptId: "accepted-during-classification", sourceUpdateIds: [1],
            owner: { instanceId: "other", processId: process.pid, processBirthId: "foreign", sessionGeneration: 1 } });
          expected = journal.read();
        }
        staleContext = fault === "binding" || fault === "generation";
        failRead = fault === "read";
        const stopping = fault === "generation" ? worker.stop() : undefined;
        release();
        await stopping;
        await worker.waitForDrain();
        assert.equal(calls, 0);
        assert.deepEqual(journal.read(), expected);
      } finally { release(); await worker.stop(); }
    });
  });
}

for (const conflict of ["queued", "reserved"] as const) test(`Last-boundary historical review cannot steal ${conflict} work`, async () => {
  await withAbandonmentJournal(async ({ journal, bindingKey }) => {
    journal.appendBatch([{ update_id: 1, message: { text: "original" } }]);
    let source: unknown;
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal, getJournalBindingKey: () => bindingKey, hasAuthority: () => true,
      async defaultHandle(update) {
        source = update.message;
        const release = conflict === "reserved" ? acquireTelegramUpdateRouting(source) : () => {};
        if (conflict === "queued") reportTelegramQueueAdmission([source], [{ queueKind: "prompt", receiptId: "accepted", sourceUpdateIds: [1] }]);
        assert.throws(() => reportTelegramHistoricalRoutingReview(source), /cannot override accepted or selected work/);
        assert.equal(getTelegramUpdateExecutionFence(source)?.isCurrent(), true);
        release();
        if (conflict === "reserved") reportTelegramUpdateDeferred(source);
      },
    });
    try {
      worker.start("ctx");
      await worker.waitForDrain();
      assert.equal(worker.getState().historicalClaimCount, undefined);
      assert.equal(journal.read().entries[0]?.state, conflict === "queued" ? "queued" : "pending");
      if (conflict === "reserved") {
        assert.throws(() => reportTelegramHistoricalRoutingReview(source), /cannot override accepted or selected work/);
        assert.equal(getTelegramUpdateExecutionFence(source)?.isCurrent(), true, "A late request cannot suspend the carrier");
      }
    } finally { await worker.stop(); }
  });
});

for (const fault of ["generation", "context", "transport", "binding", "queued", "read"] as const) test(`Retain-only classification rechecks ${fault} after await`, async () => {
  await withAbandonmentJournal(async ({ journal, bindingKey }) => {
    journal.appendBatch([{ update_id: 1, message: { text: "/protected" } }]);
    let expected = journal.read(), owned = true, context = true, key = bindingKey, failRead = false;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const worker = createTelegramUpdateWorkerRuntime<string>({
      journal: { ...journal, read() { if (failRead) throw new Error("retained source unreadable"); return journal.read(); } },
      getJournalBindingKey: () => key, hasAuthority: () => owned, isContextCurrent: () => context, spendHistoricalInput: true,
      async shouldReviewHistoricalInput() { entered(); await gate; return "retain" as const; },
      executeUpdate() { assert.fail("A stale retention verdict grants neither spending nor execution"); },
    });
    try {
      worker.start("ctx"); await ready;
      if (fault === "context") context = false;
      if (fault === "transport") owned = false;
      if (fault === "binding") key = "other";
      if (fault === "read") failRead = true;
      if (fault === "queued") {
        journal.markQueued({ queueKind: "prompt", receiptId: "accepted", sourceUpdateIds: [1],
          owner: { instanceId: "other", processId: process.pid, processBirthId: "foreign", sessionGeneration: 1 } });
        expected = journal.read();
      }
      const stopping = fault === "generation" ? worker.stop() : undefined;
      release(); await stopping; await worker.waitForDrain();
      assert.deepEqual(journal.read(), expected);
      assert.equal(worker.getState().historicalClaimCount, undefined, "Stale classification cannot install retention over changed evidence");
    } finally { release(); await worker.stop(); }
  });
});

for (const grouped of [false, true]) test(`Retain-only historical claims refuse disposition and grouped settlement (grouped=${grouped})`, async () => {
  await withAbandonmentJournal(async ({ journal, bindingKey }) => {
    journal.appendBatch([{ update_id: 1, message: { text: "/protected" } }, { update_id: 2, message: { text: "independent" } }]);
    let signal!: AbortSignal;
    const executed: number[] = [];
    const original = structuredClone(journal.read().entries[0]!);
    const worker = createTelegramUpdateWorkerRuntime<string>({
      journal, getJournalBindingKey: () => bindingKey, hasAuthority: () => true, spendHistoricalInput: true,
      getNowMs: () => Date.now() + 2 * 60 * 60_000,
      expireRoutingInput() { assert.fail("A historical original without a saved chooser clock cannot invent expiry"); },
      shouldReviewHistoricalInput(entry, _ctx, captured) { signal = captured; return entry.updateId === 1 ? "retain" : false; },
      executeUpdate(update) {
        executed.push(update.update_id);
        return grouped ? { kind: "queued", queueKind: "prompt", receiptId: "unrelated", sourceUpdateIds: [1, 2] } : { kind: "deferred" };
      },
    });
    try {
      worker.start("ctx"); await worker.waitForDrain();
      assert.deepEqual(executed, [2]);
      const authority = { updateId: 1, signal, journalBindingKey: bindingKey, isCurrent: () => true, operatorUserId: 7, operatorAuthorityId: "fixture-retain", origin: "pending-chooser" as const };
      assert.equal(worker.abandonDeferred?.(authority), undefined);
      assert.equal(worker.supportsDeferredAbandonment?.(authority), false);
      assert.deepEqual(worker.inspectHistorical?.(authority)?.sources, []);
      assert.deepEqual(worker.inspectAbandoning?.(authority)?.sources, []);
      assert.equal(worker.armRoutingInput?.({ ...authority, sourceUpdateIds: [1] }), undefined);
      assert.equal(worker.selectRoutingInput?.({ ...authority, sourceUpdateIds: [1] }), false);
      await worker.settleDeferred({ updateId: 1, signal, outcome: { kind: "complete" } });
      await worker.settleDeferred({ updateId: 1, signal, outcome: { kind: "queued", queueKind: "prompt", receiptId: "forged", sourceUpdateIds: [1] } });
      if (!grouped) await worker.settleDeferred({ updateId: 2, signal, outcome: { kind: "queued", queueKind: "prompt", receiptId: "mixed", sourceUpdateIds: [1, 2] } });
      assert.deepEqual(journal.read().entries[0], original);
      assert.equal(journal.read().entries.some(entry => entry.state === "queued"), false);
      assert.equal(journal.read().operatorDispositions, undefined);
      assert.equal(worker.getState().historicalClaimCount, 1);
      assert.equal(worker.getState().phase, "blocked", "unrelated grouped membership fails closed");
    } finally { await worker.stop(); }
  });
});

for (const fault of ["none", "hold", "authority-before-commit", "classification-error"] as const) {
  test(`New-world restart preserves chooser clocks and spends only unclocked routing input (${fault})`, async () => {
    await withAbandonmentJournal(async ({ journal, bindingKey, path }) => {
      journal.appendBatch([1, 2, 3, 4, 5].map(id => ({ update_id: id, message: { text: `old-${id}` } })), 5);
      const route = (ids: number[]) => ({ journalBindingKey: bindingKey, operatorUserId: 7, isCurrent: () => true, publishedAtMs: Date.now(),
        entries: journal.read().entries.filter(entry => ids.includes(entry.updateId)) });
      journal.routingInputs!.arm(route([1]));
      const selected = journal.routingInputs!.arm(route([2])); journal.routingInputs!.select({ ...route([2]), entries: selected });
      stageInterruptedAbandonments(journal, path, bindingKey, [5]);
      const acceptedOwner = { instanceId: "recipient", processId: process.pid, processBirthId: "foreign", sessionGeneration: 1 };
      journal.markQueued({ queueKind: "prompt", receiptId: "accepted", sourceUpdateIds: [4], owner: acceptedOwner });
      let authority = true, authorityLost = false, failClassification = fault === "classification-error";
      const handled: number[] = [], completed: number[] = [];
      const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
        journal, getJournalBindingKey: () => bindingKey, hasAuthority: () => authority, spendHistoricalInput: fault !== "hold",
        shouldReviewHistoricalInput(entry) {
          if (failClassification) throw new Error("classifier unavailable");
          if (fault === "authority-before-commit" && entry.updateId === 3 && !authorityLost) { authorityLost = true; authority = false; }
          return entry.updateId === 3;
        },
        async defaultHandle(update) { handled.push(update.update_id); },
        onUpdateCompleted: id => completed.push(id) });
      try {
        worker.start("ctx"); await worker.waitForDrain();
        const ids = () => journal.read().entries.map(entry => entry.updateId);
        if (fault === "hold") {
          assert.deepEqual(ids(), [1, 2, 3, 4, 5], "without the new-world policy previous routing inputs stay held");
          assert.equal(worker.getState().historicalClaimCount, 3);
        } else if (fault === "classification-error") {
          assert.deepEqual(ids(), [1, 2, 3, 4, 5], "an unknown classification never spends or executes");
          failClassification = false; worker.signal(); await worker.waitForDrain();
          assert.deepEqual(ids(), [1, 2, 4, 5]);
        } else if (fault === "authority-before-commit") {
          assert.deepEqual(ids(), [1, 2, 3, 4, 5], "spending commits only under current transport authority");
          authority = true; await worker.stop(); worker.start("ctx"); await worker.waitForDrain();
          assert.deepEqual(ids(), [1, 2, 4, 5], JSON.stringify(worker.getState()));
        } else assert.deepEqual(ids(), [1, 2, 4, 5], "clock-bearing sources wait for their deadline; unclocked classified input is spent");
        assert.deepEqual(handled, [], "spending never delivers input");
        assert.deepEqual(completed, [], "spending is not task completion");
        if (fault !== "hold") {
          for (const id of [1, 2, 3]) assert.equal(journal.inspectAbandonedPending(id), undefined, "no private copy or tombstone is written");
          assert.ok(journal.inspectPendingRetention(journal.read().entries.find(entry => entry.updateId === 5)!), "interrupted private abandonment keeps its own recovery");
          assert.equal(journal.read().acceptedThroughUpdateId, 5, "anti-replay stays with the unchanged polling cursor, like ordinary completion");
          journal.appendBatch([{ update_id: 6, message: { text: "fresh" } }], 6); worker.signal(); await worker.waitForDrain();
          assert.deepEqual(handled, [6], "new-world input still runs normally");
        }
      } finally { await worker.stop(); }
    });
  });
}

test("Confirmed chooser expiry clears deferred custody before a stalled or failed observer", async () => {
  await withAbandonmentJournal(async ({ journal: initial, path, bindingKey }) => {
    let now = Date.now(), captured!: AbortSignal;
    const snapshot = initial.read();
    const journal = createTelegramUpdateJournalStore({ path, profileName: snapshot.profile, botIdentity: snapshot.botIdentity, getNowMs: () => now });
    journal.appendBatch([{ update_id: 1, message: { text: "terminal source must not become a cleanup retry body" } }]);
    const armed = journal.routingInputs!.arm({ journalBindingKey: bindingKey, entries: journal.read().entries,
      operatorUserId: 7, publishedAtMs: now, isCurrent: () => true });
    now = armed[0]!.routingInput!.expiresAtMs;
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), delays: number[] = [];
    const worker = createTelegramUpdateWorkerRuntime<string>({
      journal, getJournalBindingKey: () => bindingKey, getNowMs: () => now, hasAuthority: () => true,
      executeUpdate() { assert.fail("An expired chooser source never executes"); },
      scheduleRetry(_callback, delay) { delays.push(delay); return 0; }, cancelRetry() {},
      async expireRoutingInput(source, _ctx, signal) {
        captured = signal;
        assert.ok(source.expire());
        entered.resolve();
        await release.promise;
        throw new Error("fixture permanent post-expiry observer failure");
      },
    });
    try {
      worker.start("ctx"); await entered.promise;
      assert.equal(journal.read().entries.length, 0);
      assert.equal(worker.getState().deferredClaimCount, 0);
      assert.equal(worker.getState().abandoningClaimCount ?? 0, 0);
      assert.equal(worker.isRoutingInputCurrent?.({ updateId: 1, signal: captured }), false, "No source body stays in deferredSources while the observer is stalled");
      release.resolve(); await worker.waitForDrain();
      assert.deepEqual(delays, [], "Post-ACK failure never schedules a source retry");
      worker.signal(); await worker.waitForDrain();
      assert.equal(worker.getState().phase, "idle");
      assert.ok(journal.routingInputs!.inspectExpiry(1));
      assert.equal(journal.inspectAbandonedPending(1), undefined);
    } finally { release.resolve(); await worker.stop(); }
  });
});

test("Held preparation is once per quiescent owner and never joins worker drain or shutdown", async () => {
  await withAbandonmentJournal(async ({ journal, bindingKey }) => {
    journal.appendBatch([1, 2].map(id => ({ update_id: id, message: { text: `held-${id}` } })));
    const classification = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const callback = Promise.withResolvers<void>(), callbackEntered = Promise.withResolvers<void>(), callbackDone = Promise.withResolvers<void>();
    const requests: TelegramHeldSourcePreparation<string>[] = [];
    const worker: ReturnType<typeof createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>> = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal, getJournalBindingKey: () => bindingKey, hasAuthority: () => true,
      async shouldReviewHistoricalInput(entry) { if (entry.updateId === 2) { entered.resolve(); await classification.promise; } return true; },
      async defaultHandle() { assert.fail("Prepared notification grants no execution"); },
      async onHeldSourcesPrepared(input) {
        requests.push(input); assert.ok(input.isCurrent()); assert.equal(input.ctx, "ctx"); assert.equal(input.journalBindingKey, bindingKey);
        assert.equal(worker.getState().historicalClaimCount, 2, "the hint follows the complete startup classification");
        callbackEntered.resolve(); await callback.promise; callbackDone.resolve();
      } });
    try {
      const before = journal.read(); worker.start("ctx"); await entered.promise;
      assert.equal(requests.length, 0, "no partial startup projection is published");
      classification.resolve(); await worker.waitForDrain(); await callbackEntered.promise;
      worker.signal(); await worker.waitForDrain(); assert.equal(requests.length, 1);
      await worker.stop(); assert.equal(requests[0]!.signal.aborted, true); assert.equal(requests[0]!.isCurrent(), false);
      callback.resolve(); await callbackDone.promise;
      assert.deepEqual(journal.read(), before, "notification is neither custody nor disposition");
      worker.start("ctx"); await worker.waitForDrain();
      assert.equal(requests.length, 2); assert.notEqual(requests[0]!.signal, requests[1]!.signal);
      assert.equal(requests[0]!.isCurrent(), false); assert.equal(requests[1]!.isCurrent(), true);
    } finally { classification.resolve(); callback.resolve(); await worker.stop(); }
  });
});

for (const fault of ["unreadable", "authority", "key-drift", "context-drift", "getter-failure", "sync-failure", "async-failure"] as const) {
  test(`Prepared notification refuses incomplete startup and never retries callback uncertainty (${fault})`, async () => {
    await withAbandonmentJournal(async ({ journal, bindingKey }) => {
      journal.appendBatch([1, 2].map(id => ({ update_id: id, message: { text: `held-${id}` } })));
      let readsFail = fault === "unreadable", authority = fault !== "authority", context = true, key = bindingKey, armed = true, calls = 0, getterFails = false;
      const errors: string[] = [];
      const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
        journal: { ...journal, read() { if (readsFail) throw new Error("startup unreadable"); return journal.read(); } },
        getJournalBindingKey: () => key, isContextCurrent() { if (getterFails) throw new Error("prepared context getter failed"); return context; },
        hasAuthority: () => authority, shouldReviewHistoricalInput: () => true,
        async defaultHandle() { assert.fail("Prepared notification grants no execution"); },
        onStateChange(state) {
          if (armed && state.phase === "idle" && state.historicalClaimCount === 2) {
            if (fault === "key-drift") key = "foreign";
            if (fault === "context-drift") context = false;
            if (fault === "getter-failure") getterFails = true;
          }
        }, onHeldSourcesPrepared(input) {
          calls++; assert.ok(input.isCurrent());
          if (fault === "sync-failure") throw new Error("lost prepared controller");
          if (fault === "async-failure") return Promise.reject(new Error("lost prepared reply"));
        }, recordRuntimeEvent(_category, _error, details) { if (details?.phase === "held-source-preparation") errors.push(details.phase); } });
      try {
        const before = journal.read(); worker.start("ctx"); await worker.waitForDrain(); await new Promise<void>(resolve => setImmediate(resolve));
        const callbackFault = fault === "sync-failure" || fault === "async-failure";
        assert.equal(calls, callbackFault ? 1 : 0); assert.equal(errors.length, callbackFault || fault === "getter-failure" ? 1 : 0);
        armed = false; getterFails = false; readsFail = false; authority = true; context = true; key = bindingKey;
        worker.signal(); await worker.waitForDrain(); await new Promise<void>(resolve => setImmediate(resolve));
        worker.signal(); await worker.waitForDrain();
        assert.equal(calls, 1, "only a never-issued callback can receive its first prepared hint after recovery");
        assert.equal(worker.getState().phase, "idle"); assert.deepEqual(journal.read(), before);
      } finally { await worker.stop(); }
    });
  });
}

for (const fault of ["none", "suspend-during-cutover", "conflict-after-hint", "suspend-after-hint", "suspend-only"] as const) {
  test(`Host startup hints prepared held sources only after lock, cursor cutover and active-role preparation (${fault})`, async () => {
    await withAbandonmentJournal(async ({ journal, path, bindingKey }) => {
      journal.appendBatch([1, 2].map(id => ({ update_id: id, message: { text: `held-${id}` } })), 2);
      const ctx = { cwd: "/host-startup" }, events: string[] = [], hints: TelegramHeldSourcePreparation<typeof ctx>[] = [];
      const lock = Locks.createTelegramLockRuntime<typeof ctx>({ locksPath: `${path}.owners.json`, instanceId: "host" });
      const cutover = Promise.withResolvers<void>(), cutoverEntered = Promise.withResolvers<void>(), hinted = Promise.withResolvers<void>();
      let scope: { isCurrent(): boolean } | undefined, fenced: typeof scope, references = 0;
      let worker: ReturnType<typeof createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, typeof ctx>> | undefined;
      const binding = createTelegramUpdateAdmissionRuntimeBinding<typeof ctx>({ isFollowerRegistered: () => false });
      const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<typeof ctx>({
        resolveBinding: () => ({ runtimeKey: "host", recoveryKey: bindingKey, journal }),
        acquireSourceReference() { references++; return () => { references--; }; },
        createWorker(source) {
          worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, typeof ctx>({ journal: source,
            getJournalBindingKey: () => bindingKey, hasAuthority: value => lock.owns(value), isContextCurrent: value => value === ctx,
            shouldReviewHistoricalInput: () => true, async defaultHandle() { assert.fail("A startup hint grants no execution"); },
            onHeldSourcesPrepared(input) {
              events.push("hint"); hints.push(input);
              assert.ok(lock.owns(ctx), "leader transport authority precedes the hint");
              scope = { isCurrent: input.isCurrent };
              const transport = runtime.captureTransportAuthority(input.ctx);
              assert.ok(transport, "the hint observes the current owned polling generation");
              fenced = { isCurrent: () => input.isCurrent() && transport() };
              hinted.resolve();
            } });
          return worker;
        } });
      const follower = createTelegramUpdateAdmissionLifecycleRuntime<typeof ctx>({ resolveBinding: () => undefined,
        createWorker() { assert.fail("An unregistered follower role cannot prepare a worker"); } });
      binding.bind({ leader: lifecycle, follower });
      const controller = Polling.createTelegramPollingController<typeof ctx>({ hasBotToken: () => true, stopTypingLoop: () => {}, updateStatus: () => {},
        async runPollLoop(_ctx, signal) {
          events.push("poll");
          await new Promise<void>(resolve => signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true }));
        } });
      const admission = Polling.createTelegramPollingAdmissionRuntime({ polling: controller, canStart: value => lock.owns(value),
        async prepareStart() {
          events.push("cutover"); cutoverEntered.resolve();
          if (fault === "suspend-during-cutover") await cutover.promise;
        },
        validateStart() { events.push("validated"); },
        worker: { async onSessionStart(value) { events.push("worker"); await lifecycle.onSessionStart(value); } } });
      const runtime = Locks.createTelegramLockedPollingRuntime({ lock, hasBotToken: () => true, isContextCurrent: value => value === ctx,
        ownershipCheckMs: 1_000_000, ownershipRefreshMs: 1_000_000, startPolling: value => admission.start(value),
        stopPolling: admission.stop, updateStatus: () => {} });
      const before = journal.read();
      try {
        const started = runtime.start(ctx, { onAcquired() { events.push("acquired"); } });
        if (fault === "suspend-during-cutover") {
          await cutoverEntered.promise; await runtime.suspend(); cutover.resolve();
          assert.equal((await started).ok, false);
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.deepEqual(events, ["acquired", "cutover"], "a suspended startup never prepares a worker or hint");
          assert.equal(worker, undefined);
          return;
        }
        assert.equal((await started).ok, true); await hinted.promise;
        const prefix = events.slice(0, events.indexOf("hint"));
        assert.deepEqual(prefix.filter(event => event !== "poll"), ["acquired", "cutover", "validated", "worker"]);
        assert.equal(hints.length, 1); assert.equal(hints[0]!.ctx, ctx); assert.equal(hints[0]!.journalBindingKey, bindingKey);
        assert.ok(scope?.isCurrent(), "the hint sees the exact prepared leader worker"); assert.ok(fenced?.isCurrent());
        if (fault === "conflict-after-hint") await runtime.onPersistentConflict(ctx, 10);
        if (fault === "suspend-after-hint") { await runtime.suspend(); await lifecycle.onSessionShutdown(); }
        if (fault === "suspend-only") {
          await runtime.suspend();
          // Polling suspension keeps lock-owned worker authority; only the transport fence revokes the composed scope.
          assert.equal(lock.owns(ctx), true); assert.equal(scope!.isCurrent(), true);
          assert.equal(fenced!.isCurrent(), false);
          assert.equal(runtime.captureTransportAuthority(ctx), undefined, "a suspended generation cannot be recaptured");
          assert.equal((await runtime.start(ctx)).ok, true);
          assert.ok(runtime.captureTransportAuthority(ctx)); assert.equal(fenced!.isCurrent(), false, "restart cannot renew an older transport fence");
        } else if (fault !== "none") {
          await new Promise<void>(resolve => setImmediate(resolve));
          assert.equal(scope!.isCurrent(), false, "transport loss or lifecycle stop revokes the prepared scope");
          assert.equal(hints[0]!.isCurrent(), false); assert.equal(fenced!.isCurrent(), false);
        }
        worker!.signal(); await worker!.waitForDrain();
        assert.equal(hints.length, 1, "ordinary wakes never reissue the startup hint");
        assert.deepEqual(journal.read(), before, "ordering proof neither disposes nor executes custody");
      } finally {
        cutover.resolve(); await runtime.suspend(); await lifecycle.onSessionShutdown(); await binding.onSessionShutdown(); lock.release();
      }
      assert.equal(references, 0);
    });
  });
}

test("Historical recovery is bounded, source-bound and cannot erase accepted or grouped work", async () => {
  await withAbandonmentJournal(async ({ journal, bindingKey }) => {
    journal.appendBatch([...Array.from({ length: 26 }, (_, index) => ({ update_id: index + 1,
      message: { text: `original-${index + 1}` } })), recoveryQuery(100)]);
    const foreignOwner = { instanceId: "recipient", processId: process.pid, processBirthId: "foreign", sessionGeneration: 1 };
    journal.markQueued({ queueKind: "prompt", receiptId: "accepted", sourceUpdateIds: [26], owner: foreignOwner });
    const accepted = structuredClone(journal.read().entries.find(entry => entry.updateId === 26));
    let carrier: unknown;
    let fresh: unknown;
    let current = true;
    let reads = 0;
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal: { ...journal, read() { reads++; return journal.read(); } },
      getJournalBindingKey: () => bindingKey, hasAuthority: () => true,
      isContextCurrent() { if (!current) throw new Error("stale context getter"); return true; },
      shouldReviewHistoricalInput: entry => entry.updateId <= 26,
      async defaultHandle(update) {
        assert.ok(update.update_id >= 100, "Held and queued inputs must never reach routing");
        if (update.update_id === 100) carrier = update.callback_query;
        else { fresh = update.message; reportTelegramUpdateDeferred(fresh); }
      },
    });
    try {
      worker.start("ctx");
      await worker.waitForDrain();
      const request = { journalBindingKey: bindingKey, isCurrent: () => current };
      const before = journal.read();
      const readsBefore = reads;
      const page = inspectTelegramHistoricalInputs(carrier, request)!;
      assert.equal(page.sources.length, 20);
      assert.equal(page.nextAfterUpdateId, 20);
      assert.deepEqual(inspectTelegramHistoricalInputs(carrier, { ...request, afterUpdateId: 20 })!.sources.map(source => source.original.updateId), [21, 22, 23, 24, 25]);
      assert.equal(inspectTelegramHistoricalInputs(carrier, { ...request, afterUpdateId: -1 }), undefined);
      assert.equal(inspectTelegramHistoricalInputs(carrier, { ...request, journalBindingKey: "other" }), undefined);
      assert.equal(reads, readsBefore, "Inspection is a bounded claim projection, not a journal scan");
      assert.deepEqual(journal.read(), before);
      const authority = { operatorAuthorityId: "owner:7", isCurrent: () => current };
      page.sources[0]!.original.updateId = 26;
      assert.ok(page.sources[0]!.retry(authority));
      assert.deepEqual(journal.read().entries.find(entry => entry.updateId === 26), accepted);
      journal.markQueued({ queueKind: "prompt", receiptId: "newly-accepted", sourceUpdateIds: [2], owner: foreignOwner });
      assert.throws(() => page.sources[1]!.retry(authority), /changed before abandonment/);
      assert.equal(journal.read().entries.find(entry => entry.updateId === 2)?.state, "queued");
      const signal = getTelegramUpdateExecutionFence(carrier)!.signal;
      worker.settleDeferred({ updateId: 3, signal, outcome: { kind: "complete" } });
      worker.settleDeferred({ updateId: 3, signal, outcome: { kind: "queued", queueKind: "prompt", receiptId: "late", sourceUpdateIds: [3] } });
      journal.appendBatch([{ update_id: 101, message: { text: "fresh deferred" } }]);
      worker.signal();
      await worker.waitForDrain();
      assert.ok(fresh);
      worker.settleDeferred({ updateId: 101, signal, outcome: { kind: "queued", queueKind: "prompt", receiptId: "mixed", sourceUpdateIds: [3, 101] } });
      assert.equal(journal.read().entries.find(entry => entry.updateId === 3)?.state, "pending");
      assert.equal(journal.read().entries.find(entry => entry.updateId === 101)?.state, "pending");
      current = false;
      assert.equal(page.sources[2]!.retry(authority), undefined, "Revoked caller is checked before stale context access");
      current = true;
      await worker.stop();
      assert.equal(page.sources[0]!.retry(authority), undefined, "Even cached results revoke with the generation");
      assert.deepEqual(journal.read().entries.find(entry => entry.updateId === 26), accepted);
    } finally { current = true; await worker.stop(); }
  });
});

for (const initialReadFailure of [false, true]) test(`Startup replay cannot acquire fresh cancellation authority (read failure=${initialReadFailure})`, async () => {
  await withAbandonmentJournal(async ({ journal, bindingKey, path }) => {
    const input = (id: number) => ({ update_id: id, message: {
      message_id: id, chat: { id: 7, type: "private" }, text: "original",
    } });
    journal.appendBatch([input(1), input(2)]);
    let failRead = initialReadFailure;
    let publications = 0;
    const messages = new Map<number, unknown>();
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal: { ...journal,
        read() { if (failRead) throw new Error("fixture unavailable initial snapshot"); return journal.read(); },
        abandonPending(request) { publications++; return journal.abandonPending(request); },
      },
      batchSize: 1, getJournalBindingKey: () => bindingKey, hasAuthority: () => true,
      async defaultHandle(update) { messages.set(update.update_id, update.message); reportTelegramUpdateDeferred(update.message); },
    });
    const authority = { operatorAuthorityId: "owner:7", isCurrent: () => true };
    try {
      worker.start("ctx");
      await worker.waitForDrain();
      if (initialReadFailure) {
        assert.equal(worker.getState().phase, "blocked");
        journal.appendBatch([input(3)]);
        failRead = false;
        worker.signal();
        await worker.waitForDrain();
      }
      const before = journal.read();
      for (const id of initialReadFailure ? [1, 2, 3] : [1, 2]) {
        const source = messages.get(id);
        assert.ok(source);
        assert.equal(supportsTelegramDeferredAbandonment(source, bindingKey), false,
          "A new carrier/chooser cannot certify a historical input as never forwarded");
        assert.equal(abandonTelegramDeferredUpdate(source, authority), undefined);
        assert.equal(worker.abandonDeferred?.({ ...authority, updateId: id,
          signal: getTelegramUpdateExecutionFence(source)!.signal }), undefined);
        assert.equal(getTelegramUpdateExecutionFence(source)?.isCurrent(), true, "Refusal does not claim cancellation or suspend execution");
      }
      assert.equal(publications, 0);
      assert.deepEqual(journal.read(), before);
      assert.equal(existsSync(`${path}.retained`), false);
      journal.appendBatch([input(4), input(5)]);
      worker.signal();
      await worker.waitForDrain();
      assert.equal(supportsTelegramDeferredAbandonment(messages.get(4), bindingKey), true);
      assert.ok(abandonTelegramDeferredUpdate(messages.get(4), authority), "Fresh-generation input retains supported cancellation");
      await worker.waitForDrain();
      const oldCarrier = messages.get(5);
      assert.equal(supportsTelegramDeferredAbandonment(oldCarrier, bindingKey), true);
      await worker.stop();
      worker.start("successor");
      await worker.waitForDrain();
      assert.equal(supportsTelegramDeferredAbandonment(oldCarrier, bindingKey), false);
      assert.equal(supportsTelegramDeferredAbandonment(messages.get(5), bindingKey), false, "Each generation captures its own startup baseline");
      assert.equal(abandonTelegramDeferredUpdate(messages.get(5), authority), undefined);
      assert.equal(publications, 1);
      assert.equal(journal.read().entries.some(entry => entry.updateId === 5), true);
    } finally { await worker.stop(); }
  });
});

test("Deferred abandonment revokes source carriers without completion, preserves originals and vetoes restart replay", async () => {
  await withAbandonmentJournal(async ({ journal, bindingKey }) => {
    const original = { update_id: 1, message: { message_id: 11, chat: { id: 7, type: "private" },
      from: { id: 7, is_bot: false }, text: "retained original" } };
    const inputs = [original, { update_id: 2, message: { message_id: 12, chat: { id: 7, type: "private" } } }];
    const messages = new Map<number, unknown>();
    const executed: number[] = [];
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal, getJournalBindingKey: () => bindingKey, hasAuthority: () => true,
      registry: { version: 1, add: () => () => {}, async dispatch(value) {
        const input = value as typeof original;
        if (input.update_id === 1) input.message.text = "handler execution projection";
        return "pass";
      } },
      async defaultHandle(update) {
        executed.push(update.update_id);
        messages.set(update.update_id, update.message);
        reportTelegramUpdateDeferred(update.message);
      },
    });
    try {
      worker.start("ctx");
      await worker.waitForDrain();
      journal.appendBatch(inputs);
      worker.signal();
      await worker.waitForDrain();
      const source = messages.get(1);
      const clone = carryTelegramUpdateExecutionFence(source, { rerouted: true });
      const authority = { operatorAuthorityId: "owner:7", isCurrent: () => true };
      const releaseFirst = acquireTelegramUpdateRouting(source);
      const releaseSecond = acquireTelegramUpdateRouting(source);
      assert.equal(abandonTelegramDeferredUpdate(source, authority), undefined);
      releaseFirst();
      releaseFirst();
      assert.equal(abandonTelegramDeferredUpdate(source, authority), undefined, "One repeated release cannot release another selection");
      releaseSecond();
      const result = abandonTelegramDeferredUpdate(source, authority);
      assert.ok(result);
      await worker.waitForDrain();
      assert.deepEqual(journal.read().entries.map(entry => entry.updateId), [2]);
      assert.deepEqual(JSON.parse(await readFile(result.retainedPath, "utf8")).entry.update, original);
      assert.equal(worker.getState().lastCompletedUpdateId, undefined);
      assert.equal(worker.getState().deferredClaimCount, 1);
      assert.equal(getTelegramUpdateExecutionFence(source)?.isCurrent(), false);
      assert.throws(() => getTelegramUpdateExecutionFence(clone)?.assertCurrent(), /Aborted/);
      assert.equal(reportTelegramUpdateCompleted(source), false);
      assert.equal(reportTelegramUpdateDeferred(source), false);
      assert.equal(reportTelegramQueueAdmission([source], [{ queueKind: "prompt", receiptId: "late", sourceUpdateIds: [1] }]), false);
      assert.equal(abandonTelegramDeferredUpdate(source, authority)?.duplicate, true);
      await worker.stop();
      assert.equal(abandonTelegramDeferredUpdate(source, { ...authority, isCurrent() { throw new Error("stale getter"); } }), undefined);
      assert.deepEqual(journal.appendBatch([original]).duplicateUpdateIds, [1]);
      worker.start("successor");
      await worker.waitForDrain();
      assert.deepEqual(executed, [1, 2, 2]);
    } finally { await worker.stop(); }
  });
});

for (const settlement of ["queued", "complete"] as const) test(`Deferred abandonment loses to already reported ${settlement} before late settlement runs`, async () => {
  await withAbandonmentJournal(async ({ journal, bindingKey, path }) => {
    const input = { update_id: 1, message: { message_id: 11, chat: { id: 7, type: "private" } } };
    let source: unknown;
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal, getJournalBindingKey: () => bindingKey, hasAuthority: () => true,
      async defaultHandle(update) { source = update.message; reportTelegramUpdateDeferred(source); },
    });
    try {
      worker.start("ctx");
      await worker.waitForDrain();
      journal.appendBatch([input]);
      worker.signal();
      await worker.waitForDrain();
      assert.equal(supportsTelegramDeferredAbandonment(source, bindingKey), true);
      assert.equal(abandonTelegramDeferredUpdate(source, { operatorAuthorityId: "owner:7", isCurrent: () => false }), undefined);
      assert.equal(getTelegramUpdateExecutionFence(source)?.isCurrent(), true, "A refused selection/owner gate must not suspend dispatch");
      if (settlement === "queued") reportTelegramQueueAdmission([source], [{ queueKind: "prompt", receiptId: "selected", sourceUpdateIds: [1] }]);
      else reportTelegramUpdateCompleted(source);
      assert.equal(abandonTelegramDeferredUpdate(source, { operatorAuthorityId: "owner:7", isCurrent: () => true }), undefined);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(journal.read().entries[0]?.state, settlement === "queued" ? "queued" : undefined);
      assert.equal(existsSync(`${path}.retained`), false);
    } finally { await worker.stop(); }
  });
});

for (const committed of [false, true]) test(`Deferred abandonment freezes uncertain sources but permits exact retry and unrelated work (committed=${committed})`, async () => {
  await withAbandonmentJournal(async ({ journal, bindingKey }) => {
    const input = { update_id: 1, message: { message_id: 11, chat: { id: 7, type: "private" } } };
    let source: unknown;
    let fail = true;
    const executed: number[] = [];
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal: { ...journal, abandonPending(input) {
        if (!fail) return journal.abandonPending(input);
        if (committed) journal.abandonPending(input);
        throw new Error("fixture acknowledgement unavailable");
      } },
      getJournalBindingKey: () => bindingKey, hasAuthority: () => true,
      async defaultHandle(update) {
        executed.push(update.update_id);
        if (update.update_id === 1) { source = update.message; reportTelegramUpdateDeferred(source); }
      },
    });
    try {
      worker.start("ctx");
      await worker.waitForDrain();
      journal.appendBatch([input]);
      worker.signal();
      await worker.waitForDrain();
      const authority = { operatorAuthorityId: "owner:7", isCurrent: () => true };
      assert.throws(() => abandonTelegramDeferredUpdate(source, authority), /acknowledgement unavailable/);
      assert.equal(getTelegramUpdateExecutionFence(source)?.isCurrent(), false);
      assert.equal(reportTelegramUpdateCompleted(source), false);
      assert.equal(reportTelegramQueueAdmission([source], [{ queueKind: "prompt", receiptId: "obsolete", sourceUpdateIds: [1] }]), false);
      const signal = getTelegramUpdateExecutionFence(source)!.signal;
      worker.settleDeferred({ updateId: 1, signal, outcome: { kind: "complete" } });
      worker.settleDeferred({ updateId: 1, signal, outcome: { kind: "queued", queueKind: "prompt", receiptId: "obsolete", sourceUpdateIds: [1] } });
      journal.appendBatch([{ update_id: 2 }]);
      worker.signal();
      await worker.waitForDrain();
      assert.deepEqual(executed, [1, 2], "Neither wake nor late callbacks may replay an uncertain source");
      assert.equal(worker.getState().deferredClaimCount, 1);
      assert.equal(worker.getState().lastCompletedUpdateId, 2);
      assert.deepEqual(journal.read().entries.map(entry => entry.updateId), committed ? [] : [1]);
      fail = false;
      const result = abandonTelegramDeferredUpdate(source, authority);
      assert.ok(result);
      assert.equal(result.duplicate, committed);
      await worker.waitForDrain();
      assert.equal(worker.getState().deferredClaimCount, 0);
      assert.equal(worker.getState().lastCompletedUpdateId, 2);
      assert.deepEqual(journal.read().entries, []);
      assert.equal(getTelegramUpdateExecutionFence(source)?.isCurrent(), false);
    } finally { await worker.stop(); }
  });
});

for (const lost of ["transport", "context", "binding", "generation"] as const) test(`Deferred abandonment rejects stale ${lost} authority before journal publication`, async () => {
  await withAbandonmentJournal(async ({ journal, bindingKey, path }) => {
    const input = { update_id: 1, message: { message_id: 11, chat: { id: 7, type: "private" } } };
    let source: unknown;
    let owned = true;
    let current = true;
    let key = bindingKey;
    let publications = 0;
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal: { ...journal, abandonPending(input) { publications++; return journal.abandonPending(input); } },
      getJournalBindingKey: () => key, hasAuthority: () => owned, isContextCurrent: () => current,
      async defaultHandle(update) { source = update.message; reportTelegramUpdateDeferred(source); },
    });
    try {
      worker.start("ctx");
      await worker.waitForDrain();
      journal.appendBatch([input]);
      worker.signal();
      await worker.waitForDrain();
      assert.equal(supportsTelegramDeferredAbandonment(source, bindingKey), true);
      if (lost === "transport") owned = false;
      if (lost === "context") current = false;
      if (lost === "binding") key = "foreign-binding";
      if (lost === "generation") await worker.stop();
      assert.equal(abandonTelegramDeferredUpdate(source, { operatorAuthorityId: "owner:7", isCurrent: () => true }), undefined);
      assert.equal(publications, 0);
      assert.deepEqual(journal.read().entries.map(entry => entry.updateId), [1]);
      assert.equal(existsSync(`${path}.retained`), false);
    } finally { await worker.stop(); }
  });
});

test("Deferred abandonment cannot cancel an executing handler or erase queue authority acquired since deferral", async () => {
  await withAbandonmentJournal(async ({ journal, bindingKey, path }) => {
    const input = { update_id: 1, message: { message_id: 11, chat: { id: 7, type: "private" } } };
    let source: unknown;
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal, getJournalBindingKey: () => bindingKey, hasAuthority: () => true,
      async defaultHandle(update) { source = update.message; reportTelegramUpdateDeferred(source); entered(); await pending; },
    });
    try {
      worker.start("ctx");
      await worker.waitForDrain();
      journal.appendBatch([input]);
      worker.signal();
      await ready;
      assert.equal(supportsTelegramDeferredAbandonment(source, bindingKey), true);
      const authority = { operatorAuthorityId: "owner:7", isCurrent: () => true };
      assert.equal(abandonTelegramDeferredUpdate(source, authority), undefined);
      assert.equal(worker.abandonDeferred?.({ ...authority, updateId: 1, signal: getTelegramUpdateExecutionFence(source)!.signal }), undefined);
      assert.equal(getTelegramUpdateExecutionFence(source)?.isCurrent(), true);
      release();
      await worker.waitForDrain();
      journal.markQueued({ queueKind: "prompt", receiptId: "already-accepted", sourceUpdateIds: [1],
        owner: { instanceId: "foreign", processId: process.pid, processBirthId: "foreign-process", sessionGeneration: 1 } });
      assert.throws(() => abandonTelegramDeferredUpdate(source, authority), /changed before abandonment/);
      assert.equal(journal.read().entries[0]?.state, "queued");
      assert.equal(existsSync(`${path}.retained`), false);
    } finally { release(); await worker.stop(); }
  });
});

test("Source-bound expiry settles a deferred source but cannot erase a later queue receipt", async () => {
  const storage = createTestUpdateWorkerJournal([
    { update_id: 71, message: { message_id: 11, chat: { id: 5 } } },
    { update_id: 72, message: { message_id: 12, chat: { id: 5 } } },
  ]);
  const messages = new Map<number, unknown>();
  const worker = createTelegramUpdateAdmissionWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    registry: { version: 1, add: () => () => {}, dispatch: async () => "pass" },
    async defaultHandle(update) {
      messages.set(update.update_id, update.message);
      reportTelegramUpdateDeferred(update.message);
    },
  });
  try {
    worker.start(TEST_CONTEXT);
    await worker.waitForDrain();
    assert.equal(reportTelegramUpdateCompleted({}), false);
    assert.equal(reportTelegramUpdateCompleted(messages.get(71)), true);
    reportTelegramQueueAdmission([messages.get(72)], [{
      queueKind: "prompt", receiptId: "accepted-72", sourceUpdateIds: [72],
    }]);
    assert.equal(reportTelegramUpdateCompleted(messages.get(72)), true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(storage.getUpdateIds(), [72]);
    assert.deepEqual(storage.getRemovals(), [[71]]);
    assert.equal(worker.getState().queuedClaimCount, 1);
    await worker.stop();
    assert.equal(reportTelegramUpdateCompleted(messages.get(72)), false);
  } finally {
    await worker.stop();
  }
});

test("Admission rejects competing terminal and queue outcomes before initial settlement", async () => {
  const handle = createTelegramUpdateAdmissionHandle({
    registry: { version: 1, add: () => () => {}, dispatch: async () => "pass" },
    async defaultHandle(update) {
      reportTelegramUpdateDeferred(update.message);
      reportTelegramUpdateCompleted(update.message);
      reportTelegramQueueAdmission([update.message], [{
        queueKind: "prompt", receiptId: "conflicting", sourceUpdateIds: [71],
      }]);
    },
  });
  await assert.rejects(handle({ update_id: 71, message: { chat: { id: 5, type: "private" } } },
    TEST_CONTEXT, new AbortController().signal), /conflicting queue outcomes/);
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

test("Admission worker selects optional custody and bypasses legacy settlement", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  const owner = { instanceId: "one", processId: 1, processBirthId: "1:test",
    sessionGeneration: 1, acquisitionId: "custody", acquiredAtMs: 1 };
  const receipt = { journalBindingKey: "journal", tokenSha256: "a".repeat(64),
    updateId: 1, owner };
  const worker = createTelegramUpdateAdmissionWorkerRuntime({ journal: storage.journal,
    inputCustody: {
      acquireInput: () => ({ acquired: true, receipt }),
      startInput: () => ({ started: true as const, update: { update_id: 1 } }),
      completeInput: () => ({ removedUpdateIds: [
        ...storage.journal.removeCompleted([1]).removedUpdateIds],
        entryCount: storage.getUpdateIds().length, serializedBytes: storage.getUpdateIds().length * 100 }),
      queueInputs: () => { throw new Error("queue not expected"); },
    },
    getJournalBindingKey: () => "journal", getRecipientBindingKey: () => "workspace:owner",
    hasAuthority: () => true,
    async defaultHandle() {},
  });
  try {
    worker.start(TEST_CONTEXT);
    await worker.waitForDrain();
    assert.deepEqual(storage.getUpdateIds(), []);
    assert.deepEqual(storage.getRemovals(), [[1]]);
  } finally { await worker.stop(); }
});

type LiveInputWorkerFixture = {
  journal: ReturnType<typeof createTelegramUpdateJournalStore>;
  worker: ReturnType<typeof createTelegramUpdateWorkerRuntime<string>>;
  scope: { authority: boolean; context: boolean; binding: string; generation: number; badRead: boolean; changed: boolean; version?: 2 | 3 };
  executed: number[];
  setHandler(handler: Parameters<typeof createTelegramUpdateWorkerRuntime<string>>[0]["executeUpdate"]): void;
  setPublicationHook(hook: NonNullable<Parameters<typeof createTelegramUpdateJournalStore>[0]["onPublicationBoundary"]>): void;
  setBeforeRemove(hook: () => void): void;
  setAfterRemove(hook: () => void): void;
  getRemovalCount(): number;
};
async function withLiveInputWorker(version: 1, run: (f: LiveInputWorkerFixture) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "telegram-live-input-"));
  let publicationHook: Parameters<LiveInputWorkerFixture["setPublicationHook"]>[0] | undefined;
  let beforeRemove: (() => void) | undefined, afterRemove: (() => void) | undefined, removalCount = 0;
  const journal = createTelegramUpdateJournalStore({ path: join(dir, "journal.json"), profileName: "default",
    botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: `live-input-fixture-v${version}` }),
    onPublicationBoundary: (boundary, path) => publicationHook?.(boundary, path) });
  const scope: LiveInputWorkerFixture["scope"] = { authority: true, context: true, binding: "recipient-journal", generation: 1, badRead: false, changed: false };
  const executed: number[] = [];
  let handle: Parameters<typeof createTelegramUpdateWorkerRuntime<string>>[0]["executeUpdate"] = () => ({ kind: "complete" });
  const worker = createTelegramUpdateWorkerRuntime<string>({ journal: { ...journal,
    removeCompletedExact(...args) { removalCount++; beforeRemove?.(); const result = journal.removeCompletedExact(...args); afterRemove?.(); return result; }, read() {
    if (scope.badRead) throw new Error("Recipient journal unreadable");
    const value = journal.read();
    if (scope.changed) for (const entry of value.entries) entry.update.changed = true;
    return { ...value, ...(scope.version ? { version: scope.version } : {}) };
  } }, getJournalBindingKey: () => scope.binding, hasAuthority: () => scope.authority, isContextCurrent: () => scope.context,
    getQueueOwnerIdentity: () => ({ instanceId: "recipient", processId: process.pid, processBirthId: `${process.pid}:live-input`, sessionGeneration: scope.generation }),
    spendHistoricalInput: true, shouldReviewHistoricalInput: () => "retain",
    executeUpdate(update, ctx, signal) { executed.push(update.update_id); return handle(update, ctx, signal); } });
  worker.start(TEST_CONTEXT); await worker.waitForDrain();
  try { await run({ journal, worker, scope, executed, setHandler(handler) { handle = handler; },
    setPublicationHook(hook) { publicationHook = hook; }, setBeforeRemove(hook) { beforeRemove = hook; },
    setAfterRemove(hook) { afterRemove = hook; }, getRemovalCount: () => removalCount }); }
  finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
}

for (const version of [1] as const) {
  for (const ids of [[2], [2, 3]]) {
    test(`Live input preparation holds fresh IDs before append and releases only saved/current input (v${version}, ${ids.length})`, async () => {
      await withLiveInputWorker(version, async f => {
        const requested = [...ids];
        const held = f.worker.prepareLiveInput!(TEST_CONTEXT, requested)!;
        assert.ok(held); requested.push(900);
        assert.deepEqual(held.sourceUpdateIds, ids);
        assert.equal(f.worker.getState().preparedInputCount, ids.length);
        assert.equal(held.confirmSaved(), false);
        assert.equal(held.release(() => true), false);
        f.journal.appendBatch([...ids.map(update_id => ({ update_id })), { update_id: 99 }]);
        f.worker.signal(); await f.worker.waitForDrain();
        assert.deepEqual(f.executed, [99], "A wake never spends the prepared inputs");
        assert.deepEqual(f.journal.read().entries.map(entry => entry.updateId), ids);
        assert.equal(held.cancelEmpty(), false, "Saved input is not a failed empty append");
        assert.equal(held.confirmSaved(), true);
        assert.equal(held.release(() => false), false, "Binding/local apply must be confirmed by the caller");
        assert.equal(held.release(() => true), true);
        await f.worker.waitForDrain();
        assert.deepEqual(f.executed, [99, ...ids]);
        assert.deepEqual(f.journal.read().entries, []);
        assert.equal(f.worker.getState().preparedInputCount, undefined);
        assert.equal(held.release(() => true), false, "A consumed capability cannot replay input");
      });
    });
  }
  test(`Live input preparation protects arrivals while a worker is already executing (v${version})`, async () => {
    await withLiveInputWorker(version, async f => {
      const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
      f.setHandler(async update => { if (update.update_id === 1) { entered.resolve(); await finish.promise; } return { kind: "complete" }; });
      f.journal.appendBatch([{ update_id: 1 }]); f.worker.signal(); await entered.promise;
      const held = f.worker.prepareLiveInput!(TEST_CONTEXT, [2, 3])!;
      assert.ok(held);
      assert.equal(f.worker.prepareLiveInput!(TEST_CONTEXT, [1]), undefined, "Executing work cannot be captured");
      f.journal.appendBatch([{ update_id: 2 }, { update_id: 3 }, { update_id: 4 }]);
      assert.equal(held.confirmSaved(), true);
      f.worker.signal(); finish.resolve(); await f.worker.waitForDrain();
      assert.deepEqual(f.executed, [1, 4]);
      assert.equal(held.release(() => true), true); await f.worker.waitForDrain();
      assert.deepEqual(f.executed, [1, 4, 2, 3]);
    });
  });
}

for (const loss of ["authority", "context", "binding", "generation", "stop", "restart", "release-check"] as const) {
  test(`Live input preparation refuses stale release without replay (${loss})`, async () => {
    await withLiveInputWorker(1, async f => {
      const held = f.worker.prepareLiveInput!(TEST_CONTEXT, [2])!;
      f.journal.appendBatch([{ update_id: 2 }]); assert.equal(held.confirmSaved(), true);
      if (loss === "authority") f.scope.authority = false;
      if (loss === "context") f.scope.context = false;
      if (loss === "binding") f.scope.binding = "other-journal";
      if (loss === "generation") f.scope.generation++;
      if (loss === "stop" || loss === "restart") await f.worker.stop();
      if (loss === "restart") { f.worker.start(TEST_CONTEXT); await f.worker.waitForDrain(); }
      let calls = 0;
      assert.equal(held.release(() => loss !== "release-check" || ++calls === 1), false);
      assert.deepEqual(f.executed, []);
      assert.deepEqual(f.journal.read().entries.map(entry => entry.updateId), [2]);
      assert.equal(held.cancelEmpty(), false);
    });
  });
}

test("Live input preparation enters ordinary receipt readiness only after release", async () => {
  await withLiveInputWorker(1, async f => {
    const receipt = { queueKind: "prompt" as const, receiptId: "prepared-prompt", sourceUpdateIds: [2, 3], journalBindingKey: f.scope.binding };
    f.setHandler(update => update.update_id === 2 ? { kind: "deferred" } : { kind: "queued", ...receipt });
    const held = f.worker.prepareLiveInput!(TEST_CONTEXT, [2, 3])!;
    f.journal.appendBatch([{ update_id: 2 }, { update_id: 3 }]);
    assert.equal(held.confirmSaved(), true);
    f.worker.signal(); await f.worker.waitForDrain();
    assert.equal(f.worker.isQueueReceiptCommitted!(receipt), false);
    assert.equal(held.release(() => true), true); await f.worker.waitForDrain();
    assert.deepEqual(f.executed, [2, 3]);
    assert.equal(f.worker.isQueueReceiptCommitted!(receipt), true);
    assert.equal(f.worker.getState().queuedClaimCount, 2);
    assert.deepEqual(f.journal.read().entries.map(entry => entry.state), ["queued", "queued"]);
  });
});

test("Live input preparation refuses changed queued authority without publishing readiness or pausing unrelated input", async () => {
  await withLiveInputWorker(1, async f => {
    const receipt = { queueKind: "prompt" as const, receiptId: "changed-prompt", sourceUpdateIds: [2], journalBindingKey: f.scope.binding };
    const held = f.worker.prepareLiveInput!(TEST_CONTEXT, [2])!;
    f.journal.appendBatch([{ update_id: 2 }, { update_id: 4 }]);
    assert.equal(held.confirmSaved(), true);
    f.journal.markQueued({ ...receipt, owner: { instanceId: "recipient", processId: process.pid,
      processBirthId: `${process.pid}:live-input`, sessionGeneration: 1 } });
    f.worker.signal(); await f.worker.waitForDrain();
    assert.deepEqual(f.executed, [4]);
    assert.equal(f.worker.isQueueReceiptCommitted!(receipt), false);
    assert.equal(held.release(() => true), false);
    assert.equal(held.cancelEmpty(), false);
    assert.deepEqual(f.journal.read().entries.map(entry => entry.state), ["queued"]);
  });
});

test("Live input preparation cancels a failed empty append without changing the journal", async () => {
  await withLiveInputWorker(1, async f => {
    const held = f.worker.prepareLiveInput!(TEST_CONTEXT, [2])!;
    assert.equal(held.confirmSaved(), false);
    assert.equal(held.cancelEmpty(), true); await f.worker.waitForDrain();
    assert.equal(f.worker.getState().preparedInputCount, undefined);
    assert.equal(held.confirmSaved(), false);
    assert.ok(f.worker.prepareLiveInput!(TEST_CONTEXT, [3]));
    assert.deepEqual(f.journal.read().entries, []);
  });
});

test("Live input preparation retains partial/unreadable/changed save while unrelated input progresses", async () => {
  await withLiveInputWorker(1, async f => {
    const held = f.worker.prepareLiveInput!(TEST_CONTEXT, [2, 3])!;
    f.journal.appendBatch([{ update_id: 2 }, { update_id: 4 }]);
    assert.equal(held.confirmSaved(), false);
    assert.equal(held.cancelEmpty(), false);
    f.worker.signal(); await f.worker.waitForDrain();
    assert.deepEqual(f.executed, [4]);
    f.journal.appendBatch([{ update_id: 3 }]);
    f.scope.badRead = true;
    assert.equal(held.confirmSaved(), false); assert.equal(held.release(() => true), false);
    f.scope.badRead = false; assert.equal(held.confirmSaved(), true);
    f.scope.changed = true;
    assert.equal(held.confirmSaved(), false); assert.equal(held.release(() => true), false);
    f.scope.changed = false;
    assert.equal(held.release(() => true), true); await f.worker.waitForDrain();
    assert.deepEqual(f.executed, [4, 2, 3]);
  });
});

test("Live input preparation rejects invalid, already admitted and unsupported custody sources", async () => {
  await withLiveInputWorker(1, async f => {
    for (const ids of [[], [1, 1], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1]]) assert.equal(f.worker.prepareLiveInput!(TEST_CONTEXT, ids), undefined);
    for (const version of [2, 3] as const) {
      f.scope.version = version;
      assert.equal(f.worker.prepareLiveInput!(TEST_CONTEXT, [2]), undefined);
    }
    delete f.scope.version;
    f.journal.appendBatch([{ update_id: 2 }]);
    assert.equal(f.worker.prepareLiveInput!(TEST_CONTEXT, [2]), undefined, "Existing work must not be adopted as a fresh preparation");
    assert.equal(f.worker.prepareLiveInput!("other-context", [3]), undefined);
    assert.equal(f.worker.getState().preparedInputCount, undefined);
  });
});

for (const savedIds of [[2], [2, 3]]) {
  test(`Live input discard removes only its never-dispatched saved copy (${savedIds.length})`, async () => {
    await withLiveInputWorker(1, async f => {
      const held = f.worker.prepareLiveInput!(TEST_CONTEXT, [2, 3])!;
      f.journal.appendBatch([...savedIds.map(update_id => ({ update_id })), { update_id: 4 }]);
      assert.equal(held.confirmSaved(), savedIds.length === 2);
      assert.equal(held.discardSaved(() => false), "protected");
      assert.equal(f.getRemovalCount(), 0);
      assert.equal(held.discardSaved(() => true), "discarded");
      assert.equal(f.getRemovalCount(), 1);
      assert.equal(held.release(() => true), false);
      assert.equal(held.discardSaved(() => true), "protected");
      await f.worker.waitForDrain();
      assert.deepEqual(f.executed, [4]);
      assert.deepEqual(f.journal.read().entries, []);
      assert.equal(f.journal.read().sourceCompletions, undefined, "Discard is not execution or a Restore ACK");
      assert.ok(f.worker.prepareLiveInput!(TEST_CONTEXT, [5]), "Confirmed disposal permits the next attempt");
    });
  });
}

for (const loss of ["authority", "context", "binding", "generation", "unreadable", "changed", "queued"] as const) {
  test(`Live input discard protects stale or changed saved work (${loss})`, async () => {
    await withLiveInputWorker(1, async f => {
      const held = f.worker.prepareLiveInput!(TEST_CONTEXT, [2])!;
      f.journal.appendBatch([{ update_id: 2 }]); assert.equal(held.confirmSaved(), true);
      if (loss === "authority") f.scope.authority = false;
      if (loss === "context") f.scope.context = false;
      if (loss === "binding") f.scope.binding = "foreign";
      if (loss === "generation") f.scope.generation++;
      if (loss === "unreadable") f.scope.badRead = true;
      if (loss === "changed") f.scope.changed = true;
      if (loss === "queued") f.journal.markQueued({ queueKind: "prompt", receiptId: "protected-work", sourceUpdateIds: [2],
        owner: { instanceId: "foreign", processId: process.pid, processBirthId: `${process.pid}:foreign`, sessionGeneration: 1 } });
      assert.equal(held.discardSaved(() => true), "protected");
      assert.equal(f.getRemovalCount(), 0);
      assert.deepEqual(f.journal.read().entries.map(entry => entry.updateId), [2]);
      assert.deepEqual(f.executed, []);
    });
  });
}

for (const boundary of ["before-write", "after-write-before-rename", "after-publication"] as const) {
  for (const fault of ["lost-reply", "revoked"] as const) {
    test(`Live input discard fences publication and never retries unknown issuance (${boundary}, ${fault})`, async () => {
      await withLiveInputWorker(1, async f => {
        const held = f.worker.prepareLiveInput!(TEST_CONTEXT, [2])!;
        f.journal.appendBatch([{ update_id: 2 }]); assert.equal(held.confirmSaved(), true);
        let tripped = false;
        const trip = () => {
          tripped = true;
          if (fault === "revoked") f.scope.generation++;
          else throw new Error("Discard publication reply lost");
        };
        if (boundary === "after-publication") f.setAfterRemove(trip);
        else f.setPublicationHook(stage => { if (stage === boundary) trip(); });
        assert.equal(held.discardSaved(() => true), "unknown");
        assert.equal(tripped, true);
        assert.equal(f.getRemovalCount(), 1);
        assert.equal(held.release(() => true), false);
        assert.equal(held.cancelEmpty(), false);
        assert.equal(held.confirmSaved(), false);
        held.discardSaved(() => true);
        assert.equal(f.getRemovalCount(), 1, "Issued/unknown removal must never be reissued");
        assert.deepEqual(f.journal.read().entries.map(entry => entry.updateId), boundary === "after-publication" ? [] : [2]);
        assert.deepEqual(f.executed, []);
      });
    });
  }
}

test("Live input discard treats missing confirmed input as conflict, not disposition ACK", async () => {
  await withLiveInputWorker(1, async f => {
    const held = f.worker.prepareLiveInput!(TEST_CONTEXT, [2, 3])!;
    f.journal.appendBatch([{ update_id: 2 }, { update_id: 3 }]); assert.equal(held.confirmSaved(), true);
    f.journal.removeCompletedExact([2], [createTelegramUpdateJournalEntryDigest(f.journal.read().entries[0]!)]);
    assert.equal(held.discardSaved(() => true), "protected");
    assert.equal(f.getRemovalCount(), 0);
    assert.deepEqual(f.journal.read().entries.map(entry => entry.updateId), [3]);
  });
});

test("Live input preparation refuses a journal lacking exact fenced removal", async () => {
  const storage = createTestUpdateWorkerJournal([]);
  const worker = createTelegramUpdateWorkerRuntime({ journal: storage.journal, getJournalBindingKey: () => "legacy-port",
    hasAuthority: () => true, executeUpdate: () => ({ kind: "complete" }) });
  worker.start(TEST_CONTEXT); await worker.waitForDrain();
  try { assert.equal(worker.prepareLiveInput!(TEST_CONTEXT, [2]), undefined); }
  finally { await worker.stop(); }
});

test("Live input discard rechecks generation inside the exact writer", async () => {
  await withLiveInputWorker(1, async f => {
    const held = f.worker.prepareLiveInput!(TEST_CONTEXT, [2])!;
    f.journal.appendBatch([{ update_id: 2 }]); assert.equal(held.confirmSaved(), true);
    f.setBeforeRemove(() => { f.scope.generation++; });
    assert.equal(held.discardSaved(() => true), "unknown");
    assert.equal(f.getRemovalCount(), 1);
    assert.deepEqual(f.journal.read().entries.map(entry => entry.updateId), [2]);
    assert.deepEqual(f.executed, []);
  });
});

test("Live input discard rejects a queue acquisition between observation and exact removal", async () => {
  await withLiveInputWorker(1, async f => {
    const held = f.worker.prepareLiveInput!(TEST_CONTEXT, [2])!;
    f.journal.appendBatch([{ update_id: 2 }]); assert.equal(held.confirmSaved(), true);
    f.setBeforeRemove(() => f.journal.markQueued({ queueKind: "prompt", receiptId: "acquired-work", sourceUpdateIds: [2],
      owner: { instanceId: "recipient", processId: process.pid, processBirthId: `${process.pid}:live-input`, sessionGeneration: 1 } }));
    assert.equal(held.discardSaved(() => true), "unknown");
    assert.equal(f.getRemovalCount(), 1);
    assert.equal(held.discardSaved(() => true), "unknown");
    assert.equal(f.getRemovalCount(), 1);
    assert.equal(f.journal.read().entries[0]!.state, "queued");
    f.journal.appendBatch([{ update_id: 4 }]); f.worker.signal(); await f.worker.waitForDrain();
    assert.deepEqual(f.executed, [4]);
  });
});

test("Update worker consumes custodied completion without a second legacy settlement", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  const worker = createTelegramUpdateWorkerRuntime({ journal: storage.journal,
    hasAuthority: () => true,
    executeUpdate: () => { throw new Error("legacy execution must remain unused"); },
    async executeCustodiedUpdate(update) {
      storage.journal.removeCompleted([update.update_id]);
      return { status: "completed" };
    },
  });
  try {
    worker.start(TEST_CONTEXT);
    await worker.waitForDrain();
    assert.deepEqual(storage.getUpdateIds(), []);
    assert.deepEqual(storage.getRemovals(), [[1]]);
    assert.equal(worker.getState().phase, "idle");
  } finally { await worker.stop(); }
});

test("Update worker consumes already-durable late custodied completion", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  let signal!: AbortSignal;
  const worker = createTelegramUpdateWorkerRuntime({ journal: storage.journal,
    hasAuthority: () => true,
    executeUpdate: () => { throw new Error("legacy execution must remain unused"); },
    async executeCustodiedUpdate(_update, _ctx, currentSignal) {
      signal = currentSignal;
      return { status: "deferred", receipt: {
        journalBindingKey: "journal", tokenSha256: "a".repeat(64), updateId: 1,
        owner: { instanceId: "one", processId: 1, processBirthId: "1:test",
          sessionGeneration: 1, acquisitionId: "running", acquiredAtMs: 1 },
      } };
    },
  });
  try {
    worker.start(TEST_CONTEXT);
    await worker.waitForDrain();
    storage.journal.removeCompleted([1]);
    worker.settleCustodied({ updateId: 1, result: { status: "completed" }, signal });
    await worker.waitForDrain();
    assert.deepEqual(storage.getUpdateIds(), []);
    assert.deepEqual(storage.getRemovals(), [[1]]);
    assert.equal(worker.getState().deferredClaimCount, 0);
  } finally { await worker.stop(); }
});

test("Update worker blocks retained outcome-unknown custody without retry mutation", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  let calls = 0;
  const worker = createTelegramUpdateWorkerRuntime({ journal: storage.journal,
    hasAuthority: () => true,
    executeUpdate: () => { throw new Error("legacy execution must remain unused"); },
    async executeCustodiedUpdate() {
      calls += 1;
      return { status: "outcome-unknown", receipt: {
        journalBindingKey: "journal", tokenSha256: "a".repeat(64), updateId: 1,
        owner: { instanceId: "one", processId: 1, processBirthId: "1:test",
          sessionGeneration: 1, acquisitionId: "running", acquiredAtMs: 1 },
      } };
    },
  });
  try {
    worker.start(TEST_CONTEXT);
    await worker.waitForDrain();
    assert.equal(calls, 1);
    assert.deepEqual(storage.getUpdateIds(), [1]);
    assert.deepEqual(storage.getRemovals(), []);
    assert.equal(worker.getState().blockedReason, "execution");
  } finally { await worker.stop(); }
});

test("Update worker honors journal exclusion across an awaited snapshot, not payload flags or later approval", async () => {
  const storage = createTestUpdateWorkerJournal([
    { update_id: 1 },
    { update_id: 2, preApprovalExcluded: false },
    { update_id: 3, preApprovalExcluded: true },
  ]);
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  let waiting = false;
  let approved = false;
  const executed: Array<[number, boolean]> = [];
  const completed: number[] = [];
  const worker = createTelegramUpdateWorkerRuntime({
    journal: {
      ...storage.journal,
      read: () => {
        const snapshot = storage.journal.read();
        return { ...snapshot, version: 2, entries: snapshot.entries.map((entry) => ({
          ...entry, preApprovalExcluded: entry.updateId === 2,
        })) };
      },
    },
    hasAuthority: () => true,
    executeUpdate: async (update) => {
      executed.push([update.update_id, approved]);
      if (update.update_id === 1) { waiting = true; await gate; }
      return { kind: "complete" };
    },
    onUpdateCompleted: (updateId) => { completed.push(updateId); },
  });
  try {
    worker.start(TEST_CONTEXT);
    await waitForUpdateWorkerCondition(() => waiting, "The first handler did not enter its await boundary");
    assert.equal(storage.getReadCount(), 1, "The remaining entries are already in the held snapshot");
    approved = true;
    resume();
    await worker.waitForDrain();
    assert.deepEqual(executed, [[1, false], [3, true]]);
    assert.deepEqual(completed, [1, 2, 3]);
    assert.deepEqual(storage.getRemovals(), [[1, 2, 3]]);
    assert.deepEqual(storage.getQueueReceipts(), []);
  } finally {
    resume();
    await worker.stop();
  }
});

test("Admission worker exclusion precedes execution preparation, registered handlers, and default routing", async () => {
  const storage = createTestUpdateWorkerJournal([{ update_id: 1, message: { text: "excluded" } }]);
  const calls = { prepare: 0, registered: 0, routed: 0 };
  const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
    journal: { ...storage.journal, read: () => {
      const snapshot = storage.journal.read();
      return { ...snapshot, version: 2, entries: snapshot.entries.map((entry) => ({ ...entry, preApprovalExcluded: true })) };
    } },
    hasAuthority: () => true,
    prepareUpdateForExecution: (update) => { calls.prepare++; return update; },
    registry: { version: 1, add: () => () => {}, dispatch: async () => { calls.registered++; return "pass"; } },
    defaultHandle: async () => { calls.routed++; },
  });
  try {
    worker.start(TEST_CONTEXT);
    await worker.waitForDrain();
    assert.deepEqual(calls, { prepare: 0, registered: 0, routed: 0 });
    assert.deepEqual(storage.getRemovals(), [[1]]);
  } finally {
    await worker.stop();
  }
});

test("Update worker rejects invalid exclusion snapshots before execution or queue recovery", async () => {
  for (const scenario of ["missing", "malformed", "queued-excluded", "unknown-version", "missing-version"] as const) {
    const storage = createTestUpdateWorkerJournal([1, 2]);
    const queueOwner = { instanceId: "fixture", processId: process.pid,
      processBirthId: `${process.pid}:fixture`, sessionGeneration: 1 };
    storage.journal.markQueued({ queueKind: "prompt", receiptId: "prefix", sourceUpdateIds: [1], owner: queueOwner });
    let executed = 0;
    let recovered = 0;
    const worker = createTelegramUpdateWorkerRuntime({
      journal: {
        ...storage.journal,
        read: () => {
          const snapshot = storage.journal.read();
          return {
            ...snapshot, version: scenario === "unknown-version" ? 3 : scenario === "missing-version" ? undefined : 2,
            entries: snapshot.entries.map((entry) => ({
              ...entry,
              preApprovalExcluded: scenario === "missing-version" ? undefined : entry.updateId === 1 ? false : scenario === "missing" ? undefined : scenario === "malformed" ? "false" : true,
              ...(entry.updateId === 2 && scenario === "queued-excluded" ? { state: "queued" } : {}),
            })),
          } as TelegramUpdateWorkerJournalSnapshot;
        },
      },
      hasAuthority: () => true,
      getQueueOwnerIdentity: () => queueOwner,
      executeUpdate: () => { executed++; return { kind: "complete" }; },
      onQueueReceiptCommitted: () => { recovered++; },
    });
    try {
      worker.start(TEST_CONTEXT);
      await worker.waitForDrain();
      assert.equal(worker.getState().phase, "blocked", scenario);
      assert.equal(executed, 0, scenario);
      assert.equal(recovered, 0, scenario);
      assert.deepEqual(storage.getRemovals(), [], scenario);
      assert.deepEqual(storage.getUpdateIds(), [1, 2], scenario);
    } finally {
      await worker.stop();
    }
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

for (const loseAck of [false, true]) test(`Completion observer carries the source binding captured before journal commit (${loseAck})`, async () => {
  const storage = createTestUpdateWorkerJournal([{ update_id: 1 }]);
  let binding = "original-source";
  const observed: Array<[number, string | undefined]> = [];
  const worker = createTelegramUpdateWorkerRuntime({
    journal: { ...storage.journal, removeCompleted(ids) {
      const result = storage.journal.removeCompleted(ids);
      binding = "replacement-source";
      if (loseAck) throw new Error("Completion ACK lost");
      return result;
    } }, getJournalBindingKey: () => binding, hasAuthority: () => true,
    executeUpdate: async () => ({ kind: "complete" }),
    onUpdateCompleted: (id, _ctx, sourceBinding) => { observed.push([id, sourceBinding]); },
  });
  try {
    worker.start(TEST_CONTEXT);
    await worker.waitForDrain();
    assert.deepEqual(observed, loseAck ? [] : [[1, "original-source"]]);
    assert.deepEqual(storage.getUpdateIds(), [], "source absence alone does not emit an ACK");
  } finally { await worker.stop(); }
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
    afterQueueReceiptCommitted: (receipt, ctx) => calls.push(`queued:${ctx}:${receipt.journalBindingKey}:${receipt.sourceUpdateIds.join(",")}`),
    afterUpdateCompleted: (id, ctx, binding) => calls.push(`completed:${ctx}:${binding}:${id}`),
  });
  assert.deepEqual(runtime.getQueueOwnerIdentity(), {
    instanceId: "instance-a",
    processId: 42,
    processBirthId: "42:start:1",
    sessionGeneration: 7,
  });
  const receipt = { receiptId: "receipt", queueKind: "prompt" as const, sourceUpdateIds: [1, 2], journalBindingKey: "source" };
  runtime.onQueueReceiptCommitted(receipt, "ctx");
  runtime.onUpdateCompleted(1, "ctx", "source");
  current = false;
  runtime.onQueueReceiptCommitted(receipt, "stale");
  runtime.onUpdateCompleted(2, "stale", "other");
  assert.deepEqual(calls, ["queued:ctx:source:1,2", "dispatch:ctx", "reconcile:ctx", "dispatch:ctx", "completed:ctx:source:1"]);
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
  const classified: number[] = [];
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
      shouldReviewHistoricalInput(entry) { classified.push(entry.updateId); return false; },
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
          appendBatch: () => ({ nonExcludedUpdateIds: [] }),
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
          appendBatch: () => ({ nonExcludedUpdateIds: [] }),
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
  assert.deepEqual(classified, [1], "Recipient custody must never enter leader orphan classification");

  followerGeneration = "generation-2";
  await assembly.follower.onTransportChanged("follower-context");
  assert.equal(assembly.follower.getJournalBindingKey(), "follower-binding");
  await runtimeBinding.onSessionShutdown();
});

test("Admission live preparation uses a retained source reference without pausing ordinary work or adopting leader originals", async () => {
  await withLiveInputWorker(1, async f => {
    let references = 0;
    const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<string>({
      resolveBinding: () => ({ runtimeKey: "live-runtime", recoveryKey: f.scope.binding, journal: f.journal }),
      acquireSourceReference() { references++; return () => { references--; }; }, createWorker: () => f.worker,
    });
    await lifecycle.onSessionStart(TEST_CONTEXT); await f.worker.waitForDrain();
    assert.equal(references, 1);
    f.setHandler(update => ({ kind: update.update_id === 1 ? "deferred" : "complete" }));
    lifecycle.appendBatch([{ update_id: 1 }]); lifecycle.signal(); await f.worker.waitForDrain();
    assert.equal(lifecycle.prepareLiveInput!(TEST_CONTEXT, [1]), undefined, "Leader deferred original keeps its original carrier");
    const held = lifecycle.prepareLiveInput!(TEST_CONTEXT, [2, 3])!; assert.ok(held);
    lifecycle.appendBatch([{ update_id: 2 }, { update_id: 3 }, { update_id: 4 }]);
    assert.equal(held.confirmSaved(), true); lifecycle.signal(); await f.worker.waitForDrain();
    assert.deepEqual(f.executed, [1, 4]);
    assert.equal(held.release(() => true), true); await f.worker.waitForDrain();
    assert.deepEqual(f.executed, [1, 4, 2, 3]);
    assert.deepEqual(f.journal.read().entries.map(entry => entry.updateId), [1]);
    await lifecycle.onSessionShutdown(); assert.equal(references, 0);
    assert.equal(lifecycle.prepareLiveInput!(TEST_CONTEXT, [5]), undefined, "Stopped retained observations cannot grant preparation");
  });
});

for (const change of ["runtime", "missing", "authority", "renewal", "shutdown", "resume", "session"] as const) {
  test(`Admission live preparation refuses old carriers across binding/source lifetime changes (${change})`, async () => {
    await withLiveInputWorker(1, async f => {
      let runtimeKey = "live-runtime", present = true, authorized = true, references = 0;
      const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<string>({
        resolveBinding: () => present ? { runtimeKey, recoveryKey: f.scope.binding, journal: f.journal, hasAuthority: () => authorized } : undefined,
        acquireSourceReference() { references++; return () => { references--; }; }, createWorker: () => f.worker,
      });
      await lifecycle.onSessionStart(TEST_CONTEXT); await f.worker.waitForDrain();
      const held = lifecycle.prepareLiveInput!(TEST_CONTEXT, [2])!;
      lifecycle.appendBatch([{ update_id: 2 }]); assert.equal(held.confirmSaved(), true);
      if (change === "runtime") runtimeKey = "replacement";
      if (change === "missing") present = false;
      if (change === "authority") authorized = false;
      // Replace with the very same worker object: old source-reference identity still must not become a grant.
      if (change === "renewal") { await lifecycle.onTransportChanged(TEST_CONTEXT); await f.worker.waitForDrain(); }
      if (change === "shutdown") await lifecycle.onSessionShutdown();
      if (change === "resume") { await lifecycle.onSessionShutdown(); await lifecycle.onSessionStart(TEST_CONTEXT); await f.worker.waitForDrain(); }
      if (change === "session") { await lifecycle.onSessionStart("other-context"); await f.worker.waitForDrain(); }
      assert.equal(held.confirmSaved(), false);
      assert.equal(held.release(() => true), false);
      assert.equal(held.cancelEmpty(), false);
      assert.equal(held.discardSaved(() => true), "protected");
      assert.equal(f.getRemovalCount(), 0);
      assert.deepEqual(f.executed, []);
      assert.deepEqual(f.journal.read().entries.map(entry => entry.updateId), [2]);
      await lifecycle.onSessionShutdown(); assert.equal(references, 0);
    });
  });
}

test("Admission live preparation refuses startup readiness and fences parent binding changes during publication", async () => {
  await withLiveInputWorker(1, async f => {
    let runtimeKey = "live-runtime", startupProbe: unknown = "not-probed", workerProbe: unknown = "not-probed";
    await f.worker.stop();
    const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<string>({
      resolveBinding: () => ({ runtimeKey, recoveryKey: f.scope.binding, journal: f.journal }),
      createWorker: () => ({ ...f.worker, start(ctx) {
        f.worker.start(ctx);
        workerProbe = f.worker.prepareLiveInput!(ctx, [2]);
        startupProbe = lifecycle.prepareLiveInput!(ctx, [2]);
      } }),
    });
    assert.equal(lifecycle.prepareLiveInput!(TEST_CONTEXT, [2]), undefined);
    await lifecycle.onSessionStart(TEST_CONTEXT);
    assert.equal(workerProbe, undefined, "Initial drain must establish the ordinary startup baseline");
    assert.equal(startupProbe, undefined, "Starting source has not published execution context yet");
    await f.worker.waitForDrain();
    const held = lifecycle.prepareLiveInput!(TEST_CONTEXT, [2])!;
    lifecycle.appendBatch([{ update_id: 2 }]); assert.equal(held.confirmSaved(), true);
    f.setPublicationHook(stage => { if (stage === "after-write-before-rename") runtimeKey = "replacement"; });
    assert.equal(held.discardSaved(() => true), "unknown");
    assert.equal(f.getRemovalCount(), 1);
    assert.deepEqual(f.journal.read().entries.map(entry => entry.updateId), [2]);
    assert.equal(held.release(() => true), false);
    await lifecycle.onSessionShutdown();
  });
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
        appendBatch: () => ({ nonExcludedUpdateIds: [] }),
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

test("Admission replacement selects only a fresh descriptor with unchanged originating keys after stop", async (t) => {
  for (const entrypoint of ["startup", "transport"] as const) {
    for (const change of ["runtime", "recovery", "missing", "descriptor"] as const) {
      await t.test(`${entrypoint}: ${change}`, async () => {
        const storage = createTestUpdateWorkerJournal([]);
        const events: string[] = [];
        let runtimeKey = "old-runtime";
        let recoveryKey = "source";
        let present = true;
        let portVersion = 0;
        let hold = false;
        const stopped = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<string>({
          resolveBinding() {
            if (!present) return undefined;
            const capturedVersion = portVersion;
            const checkPort = (operation: string) => {
              events.push(`${operation}:${capturedVersion}`);
              assert.equal(capturedVersion, portVersion, "expired journal port");
            };
            return {
              runtimeKey, recoveryKey,
              journal: {
                ...storage.journal,
                read() { checkPort("read"); return storage.journal.read(); },
                appendBatch() { checkPort("append"); return { nonExcludedUpdateIds: [] }; },
                applyOperatorDisposition() { checkPort("retry"); assert.fail("empty journal has no failures"); },
                recoverDeadQueueOwner() { checkPort("cleanup"); assert.fail("empty journal has no receipts"); },
              },
            };
          },
          getQueueOwnerIdentity: () => ({ instanceId: "local", processId: 1, processBirthId: "birth", sessionGeneration: 1 }),
          createWorker(journal) {
            events.push(`create:${portVersion}`);
            const worker = createTelegramUpdateWorkerRuntime<string>({
              journal, hasAuthority: () => true, executeUpdate: () => ({ kind: "complete" }),
            });
            return { ...worker, async stop() {
              await worker.stop();
              if (hold) { stopped.resolve(); await release.promise; }
            } };
          },
        });
        await lifecycle.onSessionStart("old");
        hold = true;
        // Startup needs a replacement runtime; transport must force replacement even with stable keys.
        if (entrypoint === "startup") runtimeKey = "starting-runtime";
        const replacing = entrypoint === "startup"
          ? lifecycle.onSessionStart("next")
          : lifecycle.onTransportChanged("next");
        await stopped.promise;
        const before = [...events];
        portVersion += 1;
        if (change === "runtime") runtimeKey = "changed-runtime";
        if (change === "recovery") recoveryKey = "changed-source";
        if (change === "missing") present = false;
        release.resolve();
        if (change !== "descriptor") {
          await assert.rejects(replacing, /binding changed/);
          assert.deepEqual(events, before, "refusal must precede create/read/retry/cleanup");
          assert.equal(lifecycle.getState(), undefined);
          assert.equal(lifecycle.getJournalBindingKey(), undefined);
          assert.throws(() => lifecycle.appendBatch([]), /not active/);
          present = true;
          await lifecycle.onSessionStart("retry");
        } else {
          await replacing;
        }
        lifecycle.appendBatch([]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(lifecycle.getJournalBindingKey(), recoveryKey);
        assert.equal(events.filter((event) => event.startsWith("create:")).length, 2);
        assert.ok(events.slice(before.length).includes("read:1"));
        assert.ok(events.slice(before.length).includes("append:1"));
        assert.equal(lifecycle.getState()?.blockedReason, undefined);
        await lifecycle.onTransportChanged();
        assert.equal(lifecycle.getState(), undefined);
        assert.throws(() => lifecycle.appendBatch([]), /not active/);
      });
    }
  }
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
        appendBatch: () => ({ nonExcludedUpdateIds: [] }),
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
  let exclusion: boolean | undefined;
  const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<string>({
    resolveBinding: () => ({
      runtimeKey: "reaction-target",
      recoveryKey: "reaction-target",
      journal: {
        ...storage.journal,
        read() {
          const snapshot = storage.journal.read();
          return { ...snapshot, entries: snapshot.entries.map(entry => ({ ...entry, preApprovalExcluded: exclusion })) };
        },
        appendBatch: () => ({ nonExcludedUpdateIds: [] }),
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
  for (const value of [undefined, false, true, undefined]) {
    exclusion = value;
    assert.equal(lifecycle.hasPendingQueueMutationForItem(governed), value !== true,
      "Only explicit immutable exclusion removes a dependency; unknown legacy evidence remains protective");
  }
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
        appendBatch: () => ({ nonExcludedUpdateIds: [] }),
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

test("Steer handoff reconciler gates custody before offer and rechecks negotiation before staging", async () => {
  for (const mode of ["compatible", "legacy", "capability-lost", "frozen", "pending", "offered"] as const) {
    const receipt = Queue.createTelegramQueueAdmissionReceipt({ queueKind: "prompt", sourceUpdateIds: [1, 2],
      scope: JSON.stringify({ version: 1, path: "/donor-journal", receiptScope: "donor" }) })!;
    const owner = { instanceId: "donor", processId: 10, processBirthId: "10:start:donor", sessionGeneration: 1,
      acquisitionId: "acquired", acquiredAtMs: 100 };
    const item: Queue.PendingTelegramTurn = { kind: "prompt", chatId: 7, target: { chatId: 7, threadId: 20 },
      replyToMessageId: 10, queueOrder: 1, queueLane: "steer", laneOrder: 1, statusSummary: "steer",
      admissionReceipts: [receipt], sourceMessageIds: [10, 11], queuedAttachments: [], content: [{ type: "text", text: "whole" }],
      historyText: "whole", ...(mode === "frozen" ? { steerAttempted: true } : {}),
    };
    const recipient = { instanceId: "recipient", pid: 20, processBirthId: "20:start:recipient", sessionGeneration: 2,
      profileKey: "recipient", registrationGeneration: "registration", target: item.target, connectedAtMs: 1, lastHeartbeatMs: 1 };
    const events: string[] = []; let capReads = 0;
    const reconcile = createTelegramQueueHandoffReconciler<string>({
      ownsDirect: () => true, isFollowerRegistered: () => false, isBusEnabled: () => true,
      canHandoffSteerWithRecipient: () => { capReads += 1; return mode !== "legacy" && (mode !== "capability-lost" || capReads === 1); },
      hasPendingDispatch: () => mode === "pending", listFollowers: () => [recipient],
      getQueuedItems: () => [item], createRecipientJournalBindingKey: () => "recipient-journal",
      getReceiptOwner: () => {
        assert.ok(!["legacy", "frozen", "pending"].includes(mode), "Unsupported/protected items never inspect or mutate custody");
        return mode === "offered" ? undefined : owner;
      },
      getLifecycleForReceipt: () => ({ offerQueueReceiptHandoff: () => { events.push("offer"); },
        cancelQueueReceiptHandoff: () => { events.push("cancel"); } }) as never,
      createHandoffToken: () => "x".repeat(32), createRequestId: () => "handoff", donorInstanceId: "donor",
      stageThroughFollower: () => assert.fail("Direct donor uses leader routing"),
      routeThroughLeader: async input => {
        events.push("stage"); assert.equal(input.payload.queueLane, "steer");
        assert.deepEqual(input.payload.admissionReceipts[0]!.sourceUpdateIds, [1, 2]);
        return { kind: "bus.ack", requestId: input.requestId, ok: true, result: { status: "staged", receiptId: receipt.receiptId,
          sourceUpdateIds: [1, 2], queueOwner: { ...owner, instanceId: "recipient", processId: 20,
            processBirthId: "20:start:recipient", sessionGeneration: 2 } } };
      },
      removeDonorItem: exact => { assert.deepEqual(exact.sourceUpdateIds, [1, 2]); events.push("remove"); return true; },
    });
    await reconcile("ctx");
    assert.deepEqual(events, mode === "compatible" ? ["offer", "stage", "remove"] :
      mode === "capability-lost" ? ["offer", "cancel"] : []);
    assert.equal(item.queueLane, "steer"); assert.equal(item.queueOrder, 1);
  }
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

for (const sessionId of ["recipient-session", undefined]) test(`Queue handoff reconciliation assembly requires exact recipient session (${sessionId ?? "missing"})`, async () => {
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
      sessionId,
      target: { chatId: 7, threadId: 20 },
      registrationGeneration: "recipient-generation",
      pid: 20,
      processBirthId: "20:start:recipient",
      sessionGeneration: 2,
      connectedAtMs: 1,
      lastHeartbeatMs: 1,
    }],
    createRecipientJournalResolver: (profileKey, recipientSessionId) => () => {
      assert.equal(recipientSessionId, "recipient-session");
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
  assert.deepEqual(events, sessionId ? [
    "binding:manual:recipient",
    "offer",
    "stage:recipient:recipient-generation",
  ] : []);
  assert.equal(store.getQueuedItems().length, sessionId ? 0 : 1,
    "An unknown recipient session cannot offer, stage or remove donor custody");
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
        appendBatch: () => ({ nonExcludedUpdateIds: [] }),
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
        appendBatch: () => ({ nonExcludedUpdateIds: [] }),
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

for (const operation of ["prompt", "control", "discard"] as const) {
  test(`Queue settlement mux requires exact acknowledgements across owning journals (${operation})`, () => {
    type Item = TelegramQueueAdmissionItemLike;
    const calls: string[] = [];
    let acknowledged = true;
    const createRuntime = (receiptId: string) => {
      const complete = (item: Item) => {
        assert.deepEqual(item.admissionReceipts?.map(receipt => receipt.receiptId), [receiptId]);
        calls.push(receiptId);
        return receiptId === "leader" || acknowledged;
      };
      return {
        isItemReady: (item: Item) => (item.admissionReceipts ?? []).every(receipt => receipt.receiptId === receiptId),
        getQueueReceiptOwner: (): TelegramUpdateJournalQueueOwner | undefined => undefined,
        onPromptHandedOff: complete, onControlSettled: complete,
        onItemsDiscarded: (items: readonly Item[]) =>
          complete({ admissionReceipts: items.flatMap(item => item.admissionReceipts ?? []) }),
      };
    };
    const leader = createRuntime("leader");
    const follower = createRuntime("follower");
    const settlement = createTelegramQueueAdmissionSettlementMuxRuntime([leader, follower]);
    const complete = (item: Item) => operation === "discard" ? settlement.onItemsDiscarded([item], "ctx")
      : operation === "prompt" ? settlement.onPromptHandedOff(item, "ctx") : settlement.onControlSettled(item, "ctx");
    const item: Item = { admissionReceipts: ["leader", "follower"].map((receiptId, index) => ({
      queueKind: operation === "control" ? "control" : "prompt", receiptId, sourceUpdateIds: [index + 1],
    })) };
    assert.equal(settlement.isItemReady(item), true);
    assert.equal(complete(item), true);
    assert.deepEqual(calls, ["leader", "follower"]);
    calls.length = 0;
    acknowledged = false;
    assert.equal(complete(item), false, "A completed prefix does not acknowledge the whole request");
    assert.deepEqual(calls, ["leader", "follower"]);
    calls.length = 0;
    assert.equal(complete({ admissionReceipts: [...item.admissionReceipts!, {
      queueKind: "prompt", receiptId: "unknown", sourceUpdateIds: [3],
    }] }), false);
    assert.deepEqual(calls, [], "Refuse an unowned request before any partial completion");
    follower.isItemReady = () => true;
    assert.equal(complete(item), false, "Ambiguous projections need exact matching owner evidence");
    assert.deepEqual(calls, []);
    const owner: TelegramUpdateJournalQueueOwner = { instanceId: "same", processId: process.pid,
      processBirthId: "fixture-birth", sessionGeneration: 1, acquisitionId: "acquisition", acquiredAtMs: 1 };
    leader.getQueueReceiptOwner = follower.getQueueReceiptOwner = () => ({ ...owner });
    const duplicate = { admissionReceipts: [item.admissionReceipts![0]!] };
    assert.equal(complete(duplicate), true, "Identical projections settle once through one exact owner");
    assert.deepEqual(calls, ["leader"]);
    calls.length = 0;
    follower.getQueueReceiptOwner = () => ({ ...owner, acquisitionId: "competing" });
    assert.equal(complete(duplicate), false);
    assert.deepEqual(calls, []);
  });
}

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

for (const scenario of ["normal", "binding", "authority", "context", "identity", "post-read-authority", "post-read-identity", "queued", "removed", "unreadable", "stopped", "reported"] as const) {
  test(`Deferred source observation hashes only exact live journal authority (${scenario})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-deferred-source-proof-"));
    const options = { path: join(dir, "inbox.json"), botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "fixture" }) };
    const journal = createTelegramUpdateJournalStore(options);
    const binding = createTelegramUpdateJournalBindingKey(options);
    let liveBinding = binding, owned = true, contextCurrent = true, probing = false, reads = 0, sessionGeneration = 1;
    let carrier: unknown;
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal: { ...journal, read() {
        const snapshot = journal.read();
        if (probing) {
          reads += 1;
          if (scenario === "unreadable") throw new Error("Source inspection unavailable");
          if (scenario === "post-read-authority") owned = false;
          if (scenario === "post-read-identity") sessionGeneration += 1;
        }
        return snapshot;
      } }, getJournalBindingKey: () => liveBinding, hasAuthority: () => owned, isContextCurrent: () => contextCurrent,
      getQueueOwnerIdentity: () => ({ instanceId: "fixture", processId: process.pid,
        processBirthId: `${process.pid}:source`, sessionGeneration }),
      async defaultHandle(update) {
        carrier = update.message;
        assert.equal(inspectTelegramDeferredSource(carrier), undefined, "execution has not yielded a deferred claim yet");
        assert.equal(inspectTelegramDeferredSourceSnapshot(carrier), undefined);
        reportTelegramUpdateDeferred(carrier);
      },
    });
    journal.appendBatch([{ update_id: 1, message: { message_id: 2, message_thread_id: 10,
      chat: { id: 7, type: "private" }, text: "original" } }]);
    try {
      worker.start(TEST_CONTEXT); await worker.waitForDrain();
      const original = journal.read().entries[0]!;
      const expected = { journalBindingKey: binding, updateId: 1,
        sourceSha256: createHash("sha256").update(JSON.stringify(original)).digest("hex") };
      const projected = { ...(carrier as Record<string, unknown>), message_thread_id: 42, text: "routed projection" };
      carryTelegramUpdateExecutionFence(carrier, projected);
      if (scenario === "binding") liveBinding = "foreign";
      if (scenario === "authority") owned = false;
      if (scenario === "context") contextCurrent = false;
      if (scenario === "identity") sessionGeneration += 1;
      if (scenario === "queued") journal.markQueued({ queueKind: "prompt", receiptId: "independent", sourceUpdateIds: [1],
        owner: { instanceId: "other", processId: process.pid, processBirthId: `${process.pid}:source-inspection`, sessionGeneration: 1 } });
      if (scenario === "removed") journal.removeCompleted([1]);
      if (scenario === "stopped") await worker.stop();
      if (scenario === "reported") assert.equal(reportTelegramUpdateCompleted(carrier), true);
      const before = await readFile(options.path, "utf8");
      probing = true;
      if (scenario === "unreadable") {
        assert.throws(() => inspectTelegramDeferredSource(projected), /Source inspection unavailable/);
        assert.throws(() => inspectTelegramDeferredSourceSnapshot(projected), /Source inspection unavailable/);
      } else if (scenario === "normal") {
        assert.deepEqual(inspectTelegramDeferredSource(projected), expected);
        const detached = inspectTelegramDeferredSource(projected)!;
        detached.sourceSha256 = "changed";
        assert.deepEqual(inspectTelegramDeferredSource(carrier), expected, "no mutable evidence alias escapes the worker");
        assert.equal(inspectTelegramDeferredSource({ pi_telegram_source_update_id: 1 }), undefined, "an ID is not a source capability");
        const snapshot = inspectTelegramDeferredSourceSnapshot(projected)!;
        assert.deepEqual(snapshot, { source: expected, update: original.update });
        snapshot.source.sourceSha256 = "changed";
        (snapshot.update.message as Record<string, unknown>).text = "changed";
        assert.deepEqual(inspectTelegramDeferredSourceSnapshot(carrier), { source: expected, update: original.update },
          "Snapshot reads the original journal body and exposes no alias into retained authority");
        assert.equal(inspectTelegramDeferredSourceSnapshot({ pi_telegram_source_update_id: 1 }), undefined);
      } else {
        assert.equal(inspectTelegramDeferredSourceSnapshot(projected), undefined);
        assert.equal(inspectTelegramDeferredSource(projected), undefined);
      }
      if (["binding", "authority", "context", "identity", "stopped", "reported"].includes(scenario)) assert.equal(reads, 0,
        "ended source authority never even reads the journal");
      assert.equal(await readFile(options.path, "utf8"), before, "observation neither removes nor repairs source input");
    } finally {
      probing = false;
      await worker.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const scenario of ["current", "clock-only", "cold", "port-before", "read-before", "source-changed-before", "source-missing-before", "missing-owner", "missing-reader", "missing-commit", "source-before", "binding-before", "identity-before",
  "binding-after", "identity-after", "context-after", "stopped", "renewed", "held", "lost-before", "lost-after", "wrong-ack", "wrong-receipt",
  "wrong-kind", "wrong-group", "native-after", "owner-native-after", "foreign-ack", "post-read-loss", "read-failure", "settled", "port-replaced"] as const) {
  test(`Deferred queue admission preparation observes exact warm worker receipt (${scenario})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-selected-queue-proof-"));
    const options = { path: join(dir, "inbox.json"), botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "fixture" }) };
    const journal = createTelegramUpdateJournalStore(options), key = createTelegramUpdateJournalBindingKey(options);
    let carrier: unknown, liveKey = key, generation = 1, current = true, commits = 0, reads = 0, probing = false;
    const held = Promise.withResolvers<void>();
    const identity = () => ({ instanceId: "fixture", processId: process.pid, processBirthId: `${process.pid}:queue-proof`, sessionGeneration: generation });
    const port = { ...journal, read() {
      reads++; const snapshot = journal.read();
      if (probing && scenario === "post-read-loss") current = false;
      if (probing && scenario === "read-failure") throw new Error("Receipt observation unavailable");
      return snapshot;
    }, isQueueReceiptCurrent: scenario === "missing-reader" ? undefined : (receipt: Updates.TelegramQueueAdmissionReceiptLike, owner: TelegramUpdateJournalQueueOwner) => {
      const entries = journal.read().entries.filter(entry => entry.queueReceiptId === receipt.receiptId);
      return entries.length === receipt.sourceUpdateIds.length && entries.every((entry, index) =>
        entry.updateId === receipt.sourceUpdateIds[index] && entry.state === "queued" && entry.queueKind === receipt.queueKind &&
        !entry.queueHandoff && JSON.stringify(entry.queueOwner) === JSON.stringify(owner));
    },
      markQueued: scenario === "missing-commit" ? undefined! : (input: Parameters<typeof journal.markQueued>[0]) => {
        commits++; if (scenario === "lost-before") throw new Error("Queue publication unavailable");
        const result = journal.markQueued(input);
        if (scenario === "lost-after") throw new Error("Queue ACK lost");
        if (scenario === "foreign-ack") return { ...result, queueOwner: { ...result.queueOwner!, instanceId: "other" } };
        return scenario === "wrong-ack" ? { ...result, queuedUpdateIds: [], duplicateUpdateIds: [] } : result;
      } };
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal: port, getJournalBindingKey: () => liveKey, hasAuthority: () => current, isContextCurrent: () => current,
      getQueueOwnerIdentity: scenario === "missing-owner" ? undefined : identity,
      async defaultHandle(update) {
        carrier = update.message;
        assert.equal(Updates.prepareTelegramDeferredQueueAdmission(carrier), undefined, "Executing input is not a deferred preparation");
        reportTelegramUpdateDeferred(carrier);
      },
      beforeQueueReceiptPublished: scenario === "held" ? async () => { await held.promise; } : undefined,
      expireRoutingInput: scenario === "clock-only" ? async () => {} : undefined,
    });
    const receipt = { queueKind: "prompt" as const, receiptId: "prepared-normal", sourceUpdateIds: [1], journalBindingKey: key };
    try {
      if (scenario !== "cold") { worker.start(TEST_CONTEXT); await worker.waitForDrain(); }
      journal.appendBatch([{ update_id: 1, message: { message_id: 2, message_thread_id: 10,
        chat: { id: 7, type: "private" }, text: "/selected original" } }]);
      if (scenario === "cold") worker.start(TEST_CONTEXT);
      worker.signal(); await worker.waitForDrain();
      const original = journal.read().entries[0]!;
      if (scenario === "port-before") port.isQueueReceiptCurrent = () => true;
      if (scenario === "read-before") port.read = () => { assert.fail("A replaced source reader cannot lend preparation authority"); };
      if (scenario === "source-before") journal.markQueued({ ...receipt, owner: identity() });
      if (scenario === "source-changed-before") {
        const { exists: _exists, serializedBytes: _bytes, ...snapshot } = journal.read();
        (snapshot.entries[0]!.update.message as { text: string }).text = "changed before preparation";
        await writeFile(options.path, JSON.stringify(snapshot));
      }
      if (scenario === "source-missing-before") journal.removeCompleted([1]);
      if (scenario === "binding-before") liveKey = "foreign";
      if (scenario === "identity-before") generation++;
      const before = await readFile(options.path, "utf8");
      const prepared = Updates.prepareTelegramDeferredQueueAdmission(carrier);
      assert.equal(await readFile(options.path, "utf8"), before, "Preparation is read-only and holds no source/queue reservation");
      const refused = ["cold", "port-before", "read-before", "source-changed-before", "source-missing-before", "missing-owner", "missing-reader", "missing-commit", "source-before", "binding-before", "identity-before"].includes(scenario);
      assert.equal(!!prepared, !refused);
      if (!prepared) { assert.equal(commits, 0); return; }
      assert.equal(prepared.isCurrent(), true); assert.equal(prepared.inspectReceipt(receipt), undefined);
      if (scenario === "clock-only") {
        assert.ok(Updates.armTelegramRoutingInputs([carrier], 7));
        assert.deepEqual(inspectTelegramDeferredSource(carrier), { journalBindingKey: key,
          ...createTelegramUpdateJournalEntryDigest(journal.read().entries[0]!) }, "Arming keeps exact decoder-owned source authority");
        acquireTelegramUpdateRouting(carrier, true)();
        assert.deepEqual(inspectTelegramDeferredSource(carrier), { journalBindingKey: key,
          ...createTelegramUpdateJournalEntryDigest(journal.read().entries[0]!) }, "Selection keeps exact decoder-owned source authority");
      }
      assert.equal(reportTelegramQueueAdmission([carrier], [receipt]), true);
      assert.equal(prepared.inspectReceipt(receipt), undefined, "Reporting is not a worker ACK");
      for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve));
      if (scenario === "held") {
        assert.equal(prepared.inspectReceipt(receipt), undefined, "Durable queue bytes alone cannot borrow unfinished worker publication");
        held.resolve();
        for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.equal(Updates.prepareTelegramDeferredQueueAdmission(carrier), undefined, "Accepted reporting cannot recapture another preparation");
      if (scenario === "binding-after") liveKey = "foreign";
      if (scenario === "identity-after") generation++;
      if (scenario === "context-after") current = false;
      if (scenario === "stopped" || scenario === "renewed") await worker.stop();
      if (scenario === "renewed") { worker.start(TEST_CONTEXT); await worker.waitForDrain(); }
      if (scenario === "native-after" || scenario === "owner-native-after") {
        const { exists: _exists, serializedBytes: _bytes, ...snapshot } = journal.read();
        if (scenario === "owner-native-after") snapshot.entries[0]!.queueOwner!.acquisitionId = "foreign-acquisition";
        else (snapshot.entries[0]!.update.message as { text: string }).text = "changed exact original";
        await writeFile(options.path, JSON.stringify(snapshot));
      }
      if (scenario === "settled") worker.completeQueueReceipts({ receipts: [receipt], ctx: TEST_CONTEXT, reason: "prompt-handoff" });
      if (scenario === "port-replaced") port.isQueueReceiptCurrent = () => true;
      const query = { ...receipt, sourceUpdateIds: [...receipt.sourceUpdateIds] };
      if (scenario === "wrong-receipt") query.receiptId = "other";
      if (scenario === "wrong-kind") (query as { queueKind: string }).queueKind = "control";
      if (scenario === "wrong-group") query.sourceUpdateIds = [1, 2];
      const persisted = await readFile(options.path, "utf8"), previousReads = reads;
      probing = true;
      const proof = prepared.inspectReceipt(query);
      const confirmed = scenario === "current" || scenario === "clock-only" || scenario === "held";
      assert.equal(!!proof, confirmed);
      if (proof) {
        assert.deepEqual(proof.source, { journalBindingKey: key, ...createTelegramUpdateJournalEntryDigest(original) });
        assert.deepEqual(journal.read().entries[0]!.update, original.update, "Selection/queue metadata may change, not the original bytes");
        assert.deepEqual(proof.receipt, { queueKind: receipt.queueKind, receiptId: receipt.receiptId, sourceUpdateIds: [1],
          queueOwner: journal.read().entries[0]!.queueOwner });
        proof.source.sourceSha256 = "mutated"; proof.receipt.sourceUpdateIds.push(99); proof.receipt.queueOwner.instanceId = "other";
        assert.equal(prepared.inspectReceipt(receipt)!.source.sourceSha256, createTelegramUpdateJournalEntryDigest(original).sourceSha256);
      }
      if (["binding-after", "identity-after", "context-after", "stopped", "renewed", "port-replaced"].includes(scenario))
        assert.equal(reads, previousReads, "Ended authority refuses before source I/O");
      assert.equal(await readFile(options.path, "utf8"), persisted);
      assert.equal(commits, 1, "Observation never repeats queue admission after a lost/unknown receipt");
    } finally { probing = false; held.resolve(); await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const mode of ["current", "missing-native", "wrong-source", "no-readiness", "before-release", "refused-release", "discard", "port-change", "authority", "bind-refused", "consume-throw", "report-lost", "ack-lost", "changed", "neighbor", "bind-loss"] as const) {
  test(`Native held status consumption skips registry/handler and never falls back (${mode})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-native-status-consume-")), options = { path: join(dir, "journal.json"), botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "fixture" }) };
    const journal = createTelegramUpdateJournalStore(options), binding = createTelegramUpdateJournalBindingKey(options);
    let defaults = 0, registryCalls = 0, executions = 0, binds = 0, removals = 0, current = false;
    let completion: TelegramDeferredSourceCompletionPreparation | undefined;
    const records: unknown[] = [];
    const deps = { journal: { ...journal, removeCompletedExact(...args: Parameters<typeof journal.removeCompletedExact>) { removals++; const result = journal.removeCompletedExact(...args); if (mode === "ack-lost") throw new Error("ACK lost"); return result; } },
      getJournalBindingKey: () => binding, hasAuthority: () => true, isContextCurrent: () => true,
      getQueueOwnerIdentity: () => ({ instanceId: "recipient", processId: process.pid, processBirthId: `${process.pid}:status-consume`, sessionGeneration: 1 }),
      async defaultHandle() { defaults++; }, registry: { version: 1 as const, add: () => () => {}, async dispatch() { registryCalls++; return "pass" as const; } },
      recordRuntimeEvent(_category: string, error: unknown) { records.push(error); } };
    const worker = mode === "missing-native" ? createTelegramUpdateWorkerRuntime<string>({ ...deps, executeUpdate() { defaults++; return { kind: "complete" }; } })
      : createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>(deps);
    worker.start(TEST_CONTEXT); await worker.waitForDrain();
    const held = worker.prepareLiveInput!(TEST_CONTEXT, [100])!; assert.ok(held);
    const update = { update_id: 100, message: { message_id: 11, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "/status" } };
    journal.appendBatch([update]); worker.signal(); await worker.waitForDrain(); assert.equal(held.confirmSaved(), true);
    const readiness = mode === "no-readiness" ? undefined : held.prepareSourceCompletion?.();
    const consumer = { source: readiness?.snapshot.source ?? { updateId: 100, journalBindingKey: binding, sourceSha256: "f".repeat(64) },
      assertCurrent() { if (!current) throw new Error("Recipient not released/current"); },
      bindCarrier(value: unknown) { binds++; completion = readiness?.bindCarrier(value); assert.ok(completion); if (mode === "bind-loss") current = false; return mode !== "bind-refused"; },
      async execute() { executions++; assert.ok(completion); if (mode === "consume-throw") throw new Error("Lost consumption result");
        assert.equal(completion.reportCompleted(), true); if (mode === "report-lost") throw new Error("Report return lost"); return true; } };
    if (mode === "wrong-source") consumer.source = { ...consumer.source, sourceSha256: "f".repeat(64) };
    const before = await readFile(options.path, "utf8");
    try {
      const accepted = held.prepareStatusConsumption?.(consumer); assert.equal(accepted, !["missing-native", "wrong-source", "no-readiness"].includes(mode));
      assert.equal(defaults, 0); assert.equal(registryCalls, 0); assert.equal(executions, 0); assert.equal(removals, 0); assert.equal(await readFile(options.path, "utf8"), before);
      if (!accepted) return;
      assert.equal(held.prepareStatusConsumption?.(consumer), false, "No plan replacement or second preparation");
      if (mode === "before-release") return;
      if (mode === "refused-release") { assert.equal(held.release(() => false), false); return; }
      if (mode === "discard") { assert.equal(held.discardSaved(() => true), "discarded"); assert.equal(executions, 0); return; }
      if (mode === "port-change") { consumer.execute = async () => { throw new Error("Replacement must not execute"); }; assert.equal(held.release(() => true), false); return; }
      if (mode === "neighbor") journal.appendBatch([{ update_id: 101, message: { text: "neighbor" } }]);
      current = mode !== "authority";
      assert.equal(held.release(() => true), true);
      if (mode === "changed") journal.markExecutionFailure({ updateId: 100, expectedAttemptCount: 0, failedAtMs: 1, failureClass: "fixture", summary: "changed", disposition: "retry-wait", nextRetryAtMs: Date.now() + 60000 });
      await worker.waitForDrain(); await new Promise(resolve => setImmediate(resolve)); await worker.waitForDrain();
      const refused = ["authority", "changed"].includes(mode), noReport = refused || ["bind-refused", "bind-loss", "consume-throw"].includes(mode);
      assert.equal(binds, refused ? 0 : 1); assert.equal(executions, refused || mode === "bind-refused" || mode === "bind-loss" ? 0 : 1);
      assert.equal(defaults, mode === "neighbor" ? 1 : 0); assert.equal(registryCalls, defaults);
      assert.equal(removals, noReport ? 0 : 1);
      assert.deepEqual(completion?.inspectCompletion(), noReport || mode === "ack-lost" ? undefined : readiness!.snapshot.source);
      const executionCount = executions, bindCount = binds; worker.signal(); await worker.waitForDrain();
      assert.equal(executions, executionCount); assert.equal(binds, bindCount); assert.equal(defaults, mode === "neighbor" ? 1 : 0);
      if (noReport && mode !== "changed") assert.equal(await readFile(options.path, "utf8"), before);
      if (["authority", "bind-refused", "consume-throw", "report-lost"].includes(mode)) assert.ok(records.length);
    } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const scenario of ["current", "before-save", "group", "before-release", "refused-release", "discard", "wrong-carrier", "binding", "context", "identity", "stopped", "read-owner", "changed", "cold-restart", "lost-ack"] as const) {
  test(`Held singleton completion readiness bridges only its warm released source (${scenario})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-held-command-readiness-"));
    const options = { path: join(dir, "journal.json"), botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "fixture" }) };
    const journal = createTelegramUpdateJournalStore(options), binding = createTelegramUpdateJournalBindingKey(options);
    let carrier: unknown, calls = 0, removals = 0, generation = 1, liveBinding = binding, context = true;
    const native = { ...journal, removeCompletedExact(...args: Parameters<typeof journal.removeCompletedExact>) { removals++; const result = journal.removeCompletedExact(...args); if (scenario === "lost-ack") throw new Error("ACK lost"); return result; } };
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({ journal: native,
      getJournalBindingKey: () => liveBinding, hasAuthority: () => true, isContextCurrent: () => context,
      getQueueOwnerIdentity: () => ({ instanceId: "recipient", processId: process.pid, processBirthId: `${process.pid}:held-command`, sessionGeneration: generation }),
      async defaultHandle(update) { calls++; carrier = update.message; reportTelegramUpdateDeferred(carrier); } });
    worker.start(TEST_CONTEXT); await worker.waitForDrain();
    const held = worker.prepareLiveInput!(TEST_CONTEXT, scenario === "group" ? [100, 101] : [100])!; assert.ok(held);
    try {
      if (scenario === "before-save") { assert.equal(held.prepareSourceCompletion?.(), undefined); return; }
      const update = { update_id: 100, message: { message_id: 11, message_thread_id: 10, chat: { id: 7, type: "private" }, text: "/status" } };
      journal.appendBatch(scenario === "group" ? [update, { ...update, update_id: 101 }] : [update]); worker.signal(); await worker.waitForDrain();
      assert.equal(calls, 0); assert.equal(held.confirmSaved(), true);
      const before = await readFile(options.path, "utf8"), readiness = held.prepareSourceCompletion?.();
      if (scenario === "group") { assert.equal(readiness, undefined); return; }
      assert.ok(readiness); assert.equal(held.prepareSourceCompletion?.(), readiness, "Same hold keeps one preparation");
      assert.equal(calls, 0); assert.equal(removals, 0); assert.equal(await readFile(options.path, "utf8"), before);
      const expected = readiness.snapshot; assert.deepEqual(expected.update, update); expected.source.sourceSha256 = "f".repeat(64); (expected.update.message as Record<string, unknown>).text = "changed";
      assert.deepEqual(readiness.snapshot.update, update); assert.notEqual(readiness.snapshot.source.sourceSha256, expected.source.sourceSha256);
      assert.equal(readiness.bindCarrier({ pi_telegram_source_update_id: 100 }), undefined);
      if (scenario === "before-release") { assert.equal(readiness.bindCarrier(carrier), undefined); return; }
      if (scenario === "refused-release") { assert.equal(held.release(() => false), false); assert.equal(readiness.bindCarrier(carrier), undefined); assert.equal(calls, 0); return; }
      if (scenario === "discard") { assert.equal(held.discardSaved(() => true), "discarded"); assert.equal(readiness.bindCarrier(carrier), undefined); assert.equal(calls, 0); return; }
      if (scenario === "changed") journal.markExecutionFailure({ updateId: 100, expectedAttemptCount: 0, failedAtMs: 1, failureClass: "fixture", summary: "changed", disposition: "retry-wait", nextRetryAtMs: Date.now() + 60000 });
      if (scenario === "changed") { assert.equal(held.release(() => true), false); assert.equal(readiness.bindCarrier(carrier), undefined); return; }
      assert.equal(held.release(() => true), true); await worker.waitForDrain(); assert.equal(calls, 1);
      if (scenario === "binding") liveBinding = "other";
      if (scenario === "context") context = false;
      if (scenario === "identity") generation++;
      if (scenario === "stopped") await worker.stop();
      if (scenario === "read-owner") native.read = () => journal.read();
      if (scenario === "cold-restart") { await worker.stop(); worker.start(TEST_CONTEXT); await worker.waitForDrain(); }
      const prepared = readiness.bindCarrier(scenario === "wrong-carrier" ? {} : carrier);
      if (["wrong-carrier", "binding", "context", "identity", "stopped", "read-owner", "cold-restart"].includes(scenario)) { assert.equal(prepared, undefined); assert.equal(removals, 0); return; }
      assert.ok(prepared); assert.equal(readiness.bindCarrier(carrier), prepared, "Same warm bridge never re-prepares");
      assert.equal(readiness.bindCarrier({}), undefined); assert.equal(prepared.inspectCompletion(), undefined);
      assert.equal(prepared.reportCompleted(), true); assert.equal(prepared.reportCompleted(), false);
      await new Promise(resolve => setImmediate(resolve)); await worker.waitForDrain(); await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(prepared.inspectCompletion(), scenario === "lost-ack" ? undefined : readiness.snapshot.source);
      assert.equal(removals, 1); assert.equal(calls, 1);
    } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const scenario of ["current", "cold", "raw", "missing-cas", "prepare-change", "changed", "queued", "missing", "lost-ack", "wrong-ack", "lost-report", "binding", "context", "identity", "stopped", "read-owner", "cas-owner", "accepted-without-ack", "revived"] as const) {
  test(`Warm source completion preparation refuses reconstruction and observes its actual ACK (${scenario})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-prepared-source-"));
    const options = { path: join(dir, "journal.json"), botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "fixture" }) };
    const journal = createTelegramUpdateJournalStore(options), binding = createTelegramUpdateJournalBindingKey(options);
    let carrier: unknown, original: unknown, removals = 0, reads = 0, reports = 0, ctxCurrent = true, generation = 1, liveBinding = binding;
    const native = { ...journal, read() { reads++; return journal.read(); }, removeCompletedExact: scenario === "missing-cas" ? undefined : (...args: Parameters<typeof journal.removeCompletedExact>) => {
      removals++; const result = journal.removeCompletedExact(...args);
      if (scenario === "lost-ack") throw new Error("Removal ACK lost");
      return scenario === "wrong-ack" ? { ...result, removedUpdateIds: [] } : result;
    } };
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({ journal: native,
      getJournalBindingKey: () => liveBinding, hasAuthority: () => true, isContextCurrent: () => ctxCurrent,
      getQueueOwnerIdentity: () => ({ instanceId: "recipient", processId: process.pid, processBirthId: `${process.pid}:prepared`, sessionGeneration: generation }),
      async defaultHandle(update) {
        original = update.message; reportTelegramUpdateDeferred(original);
        carrier = bindTelegramUpdateCompletionAcceptance(original, () => { reports++; throw new Error("Wrong scoped proof cannot be borrowed"); });
        if (scenario !== "lost-report") carrier = original;
      } });
    const append = () => journal.appendBatch([{ update_id: 100, message: { message_id: 11, message_thread_id: 10, chat: { id: 7, type: "private" }, text: "/status" } }]);
    if (scenario === "cold") append();
    worker.start(TEST_CONTEXT); await worker.waitForDrain();
    if (scenario !== "cold") { append(); worker.signal(); await worker.waitForDrain(); }
    if (scenario === "raw") carrier = { message_id: 11, pi_telegram_source_update_id: 100 };
    if (scenario === "prepare-change") journal.markExecutionFailure({ updateId: 100, expectedAttemptCount: 0, failedAtMs: 1, failureClass: "fixture", summary: "changed", disposition: "retry-wait", nextRetryAtMs: Date.now() + 60000 });
    const before = await readFile(options.path, "utf8"), prepared = prepareTelegramDeferredSourceCompletion(carrier);
    try {
      const early = ["cold", "raw", "missing-cas", "prepare-change"].includes(scenario);
      if (early) { assert.equal(prepared, undefined); assert.equal(await readFile(options.path, "utf8"), before); assert.equal(removals, 0); return; }
      assert.ok(prepared); assert.equal(removals, 0); assert.equal(prepared.inspectCompletion(), undefined); assert.equal(await readFile(options.path, "utf8"), before);
      const expected = inspectTelegramDeferredSource(original)!; const copy = prepared.source; copy.sourceSha256 = "f".repeat(64); assert.deepEqual(prepared.source, expected);
      if (scenario === "changed") journal.markExecutionFailure({ updateId: 100, expectedAttemptCount: 0, failedAtMs: 1, failureClass: "fixture", summary: "changed", disposition: "retry-wait", nextRetryAtMs: Date.now() + 60000 });
      if (scenario === "queued") journal.markQueued({ queueKind: "prompt", receiptId: "receipt", sourceUpdateIds: [100], owner: { instanceId: "other", processId: process.pid, processBirthId: `${process.pid}:other`, sessionGeneration: 1 } });
      if (scenario === "missing") journal.removeCompleted([100]);
      if (scenario === "binding") liveBinding = "other";
      if (scenario === "context" || scenario === "revived") ctxCurrent = false;
      if (scenario === "identity") generation++;
      if (scenario === "stopped") await worker.stop();
      if (scenario === "read-owner") native.read = () => journal.read();
      if (scenario === "cas-owner") native.removeCompletedExact = () => assert.fail("Cannot borrow another CAS");
      if (scenario === "accepted-without-ack") reportTelegramUpdateCompleted(original);
      const rejected = ["changed", "queued", "missing", "binding", "context", "identity", "stopped", "read-owner", "cas-owner", "accepted-without-ack", "revived"].includes(scenario);
      if (scenario === "lost-report") assert.throws(prepared.reportCompleted, /Wrong scoped proof/);
      else assert.equal(prepared.reportCompleted(), !rejected);
      if (scenario === "revived") { ctxCurrent = true; assert.equal(prepared.isCurrent(), true); }
      assert.equal(prepared.reportCompleted(), false); assert.equal(prepared.inspectCompletion(), undefined);
      await new Promise(resolve => setImmediate(resolve)); await worker.waitForDrain(); await new Promise(resolve => setImmediate(resolve));
      const count = reads, calls = removals, bytes = await readFile(options.path, "utf8");
      assert.deepEqual(prepared.inspectCompletion(), scenario === "current" ? expected : undefined);
      assert.deepEqual(prepared.inspectCompletion(), scenario === "current" ? expected : undefined);
      assert.equal(reads, count); assert.equal(removals, calls); assert.equal(await readFile(options.path, "utf8"), bytes);
      assert.equal(removals, ["current", "lost-ack", "wrong-ack"].includes(scenario) ? 1 : 0);
      if (scenario === "current") { const observed = prepared.inspectCompletion()!; observed.sourceSha256 = "0".repeat(64); assert.deepEqual(prepared.inspectCompletion(), expected); await worker.stop(); assert.equal(prepared.inspectCompletion(), undefined); }
      assert.equal(reports, scenario === "lost-report" ? 1 : 0);
    } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const scenario of ["normal", "generic", "changed", "missing", "queued", "unavailable", "lost-ack", "wrong-ack",
  "publication-loss", "post-ack-loss", "observer-loss", "binding", "context", "identity", "stopped", "renewed", "mutated-report"] as const) {
  test(`Warm exact source disposition observes only the issuing worker removal ACK (${scenario})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-warm-source-disposition-"));
    const options = { path: join(dir, "inbox.json"), botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "fixture" }) };
    const journal = createTelegramUpdateJournalStore(options), binding = createTelegramUpdateJournalBindingKey(options);
    let carrier: unknown, exactCalls = 0, reads = 0, owned = true, contextCurrent = true, generation = 1, liveBinding = binding;
    const completions: number[] = [];
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal: { ...journal, read() { reads++; return journal.read(); },
        removeCompletedExact: scenario === "unavailable" ? undefined : (ids, guards, scoped, isCurrent) => {
          exactCalls++;
          assert.equal(typeof isCurrent, "function", "exact late completion reaches the actual journal publication fence");
          if (scenario === "publication-loss") owned = false;
          const ack = journal.removeCompletedExact(ids, guards, scoped, isCurrent);
          if (scenario === "lost-ack") throw new Error("Exact removal reply lost");
          if (scenario === "wrong-ack") return { ...ack, removedUpdateIds: [] };
          if (scenario === "post-ack-loss") owned = false;
          return ack;
        } },
      getJournalBindingKey: () => liveBinding, hasAuthority: () => owned, isContextCurrent: () => contextCurrent,
      getQueueOwnerIdentity: () => ({ instanceId: "fixture", processId: process.pid,
        processBirthId: `${process.pid}:warm-disposition`, sessionGeneration: generation }),
      async defaultHandle(update) { carrier = update.message; reportTelegramUpdateDeferred(carrier); },
      onUpdateCompleted(id) { completions.push(id); if (scenario === "observer-loss") owned = false; },
    });
    journal.appendBatch([{ update_id: 1, message: { message_id: 2, message_thread_id: 10,
      chat: { id: 7, type: "private" }, text: "/status" } }]);
    try {
      worker.start(TEST_CONTEXT); await worker.waitForDrain();
      const expected = inspectTelegramDeferredSource(carrier)!;
      assert.ok(expected);
      assert.equal(inspectTelegramDeferredSourceCompletion(carrier), undefined, "pending input has no disposal ACK");
      const notifications: unknown[] = [];
      const unsubscribe = subscribeTelegramDeferredSourceCompletion(carrier, () => {
        notifications.push(inspectTelegramDeferredSourceCompletion(carrier));
        throw new Error("An observer cannot invalidate a committed source ACK");
      });
      assert.ok(unsubscribe);
      const cancelled = subscribeTelegramDeferredSourceCompletion(carrier, () => assert.fail("Unsubscribed observer"));
      cancelled?.();
      if (scenario === "changed") journal.markExecutionFailure({ updateId: 1, expectedAttemptCount: 0, failedAtMs: 1000,
        failureClass: "fixture", summary: "changed", disposition: "retry-wait", nextRetryAtMs: Date.now() + 60_000 });
      if (scenario === "missing") journal.removeCompleted([1]);
      if (scenario === "queued") journal.markQueued({ queueKind: "prompt", receiptId: "independent", sourceUpdateIds: [1],
        owner: { instanceId: "other", processId: process.pid, processBirthId: `${process.pid}:other`, sessionGeneration: 1 } });
      const reported = { ...expected };
      assert.equal(reportTelegramUpdateCompleted(carrier, scenario === "generic" ? undefined : reported), true);
      assert.equal(inspectTelegramDeferredSource(carrier), undefined, "semantic reporting hides unsettled inspection, not proof of removal");
      assert.equal(inspectTelegramDeferredSourceCompletion(carrier), undefined, "a completion hint precedes its worker ACK");
      if (scenario === "mutated-report") reported.sourceSha256 = "f".repeat(64);
      await new Promise<void>(resolve => setImmediate(resolve));
      await worker.waitForDrain();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(notifications, ["normal", "mutated-report", "binding", "context", "identity", "stopped", "renewed"].includes(scenario) ? [expected] : [],
        "Notify only after the warm exact ACK is inspectable, never merely after journal removal");
      unsubscribe();
      if (scenario === "binding") liveBinding = "other";
      if (scenario === "context") contextCurrent = false;
      if (scenario === "identity") generation++;
      if (scenario === "stopped" || scenario === "renewed") await worker.stop();
      if (scenario === "renewed") { worker.start(TEST_CONTEXT); await worker.waitForDrain(); }
      const confirmed = scenario === "normal" || scenario === "mutated-report";
      const before = await readFile(options.path, "utf8"), beforeReads = reads, beforeCalls = exactCalls;
      assert.deepEqual(inspectTelegramDeferredSourceCompletion(carrier), confirmed ? expected : undefined);
      assert.equal(inspectTelegramDeferredSourceCompletion({ pi_telegram_source_update_id: 1 }), undefined);
      if (confirmed) {
        const observed = inspectTelegramDeferredSourceCompletion(carrier)!;
        observed.sourceSha256 = "f".repeat(64);
        assert.deepEqual(inspectTelegramDeferredSourceCompletion(carrier), expected, "no mutable evidence alias escapes");
        owned = false;
        assert.equal(inspectTelegramDeferredSourceCompletion(carrier), undefined, "an ACK cannot outlive recipient/source worker authority");
      }
      assert.equal(reads, beforeReads, "warm inspection never rereads source absence or reconstructs an operation");
      assert.equal(exactCalls, beforeCalls, "inspection never repeats removal, including after a lost ACK");
      assert.equal(await readFile(options.path, "utf8"), before);
      assert.equal(exactCalls, ["generic", "unavailable"].includes(scenario) ? 0 : 1);
      assert.deepEqual(completions, ["changed", "missing", "queued", "unavailable", "lost-ack", "wrong-ack", "publication-loss", "post-ack-loss"].includes(scenario) ? [] : [1]);
      assert.equal(journal.read().entries.length, ["changed", "queued", "unavailable", "publication-loss"].includes(scenario) ? 1 : 0);
    } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const scenario of ["current", "void", "mismatched", "mutated-adapter", "revoked", "aborted", "rejected"] as const) {
  test(`Warm source disposition never upgrades a held or void late-outcome adapter (${scenario})`, async () => {
    const expected = { updateId: 1, journalBindingKey: "fixture-source", sourceSha256: "a".repeat(64) };
    let carrier: unknown, current = true, calls = 0;
    type Ack = { source: typeof expected; isCurrent(): boolean };
    let release!: (ack: Ack | undefined) => void, reject!: (error: Error) => void;
    const held = new Promise<Ack | undefined>((resolve, fail) => { release = resolve; reject = fail; });
    const failures: unknown[] = [], controller = new AbortController();
    const handle = createTelegramUpdateAdmissionHandle<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      async defaultHandle(update) { carrier = update.message; reportTelegramUpdateDeferred(carrier); },
      async onLateOutcome(outcome) {
        calls++;
        if (scenario === "mutated-adapter" && outcome.kind === "complete" && outcome.expectedSource) outcome.expectedSource.sourceSha256 = "b".repeat(64);
        return await held;
      },
      onLateOutcomeError(error) { failures.push(error); },
    });
    const update = { update_id: 1, message: { message_id: 2, chat: { id: 7, type: "private" }, text: "/status" } };
    await handle(update, TEST_CONTEXT, controller.signal);
    assert.equal(reportTelegramUpdateCompleted(carrier, expected), true);
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(inspectTelegramDeferredSourceCompletion(carrier), undefined, "held work is not removal confirmation");
    if (scenario === "revoked") current = false;
    if (scenario === "aborted") controller.abort();
    if (scenario === "rejected") reject(new Error("Lost completion acknowledgement"));
    else release(scenario === "void" ? undefined : { source: scenario === "mismatched" || scenario === "mutated-adapter" ? { ...expected, sourceSha256: "b".repeat(64) } : expected,
      isCurrent: () => current });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(inspectTelegramDeferredSourceCompletion(carrier), scenario === "current" ? expected : undefined);
    assert.deepEqual(inspectTelegramDeferredSourceCompletion(carrier), scenario === "current" ? expected : undefined);
    assert.equal(calls, 1, "observation cannot replay a lost/unknown completion");
    assert.equal(failures.length, scenario === "rejected" ? 1 : 0);
  });
}

for (const scenario of ["immediate", "mixed", "late", "changed", "binding", "identity", "context", "stopped", "unavailable", "detached-report", "wrong-id", "bad-hash"] as const) {
  test(`Guarded source completion preserves its digest through worker admission (${scenario})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-completion-source-cas-"));
    const options = { path: join(dir, "inbox.json"), botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "fixture" }) };
    const journal = createTelegramUpdateJournalStore(options);
    const binding = createTelegramUpdateJournalBindingKey(options);
    journal.appendBatch((scenario === "mixed" ? [1, 2] : [1]).map(update_id => ({ update_id,
      message: { message_id: update_id, chat: { id: 7, type: "private" }, text: "fixture" } })));
    const expectedSource = { journalBindingKey: binding, ...createTelegramUpdateJournalEntryDigest(journal.read().entries[0]!) };
    const captured = { ...expectedSource };
    let liveBinding = binding, sessionGeneration = 1, contextCurrent = true;
    let carrier: unknown, exactCalls = 0, legacyCalls = 0;
    const completed: number[] = [];
    const errors: unknown[] = [];
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal: { ...journal, removeCompleted(ids) { legacyCalls++; return journal.removeCompleted(ids); },
        removeCompletedExact: scenario === "unavailable" ? undefined : (ids, expected) => {
          exactCalls++;
          assert.deepEqual(expected, [{ updateId: 1, sourceSha256: captured.sourceSha256 }]);
          assert.deepEqual(ids, scenario === "mixed" ? [1, 2] : [1]);
          return journal.removeCompletedExact(ids, expected);
        } },
      getJournalBindingKey: () => liveBinding, hasAuthority: () => true, isContextCurrent: () => contextCurrent,
      getQueueOwnerIdentity: () => ({ instanceId: "fixture", processId: process.pid, processBirthId: `${process.pid}:source-cas`, sessionGeneration }),
      async defaultHandle(update) {
        if (update.update_id !== 1) return;
        carrier = update.message;
        if (scenario === "immediate" || scenario === "mixed") {
          assert.equal(reportTelegramUpdateCompleted(carrier, expectedSource), true);
          assert.equal(reportTelegramUpdateCompleted(carrier), true, "a duplicate cannot downgrade an existing exact guard");
        } else reportTelegramUpdateDeferred(carrier);
      },
      onUpdateCompleted(updateId) { assert.equal(journal.read().entries.some(entry => entry.updateId === updateId), false); completed.push(updateId); },
      recordRuntimeEvent(_category, error) { errors.push(error); },
    });
    try {
      worker.start(TEST_CONTEXT); await worker.waitForDrain();
      if (scenario === "immediate" || scenario === "mixed") {
        assert.deepEqual(journal.read().entries, []);
        assert.deepEqual(completed, scenario === "mixed" ? [1, 2] : [1]);
      } else {
        if (scenario === "changed") journal.markExecutionFailure({ updateId: 1, expectedAttemptCount: 0, failedAtMs: 1000,
          failureClass: "fixture", summary: "changed", disposition: "retry-wait", nextRetryAtMs: Date.now() + 60_000 });
        if (scenario === "binding") liveBinding = "foreign";
        if (scenario === "identity") sessionGeneration++;
        if (scenario === "context") contextCurrent = false;
        if (scenario === "stopped") await worker.stop();
        const before = await readFile(options.path, "utf8");
        if (scenario === "wrong-id" || scenario === "bad-hash") {
          assert.throws(() => reportTelegramUpdateCompleted(carrier, scenario === "wrong-id" ? { ...expectedSource, updateId: 99 }
            : { ...expectedSource, sourceSha256: "invalid" }), /invalid completion source/);
        } else {
          assert.equal(reportTelegramUpdateCompleted(carrier, expectedSource), scenario !== "stopped");
          if (scenario === "detached-report") expectedSource.sourceSha256 = "f".repeat(64);
          await Promise.resolve(); await worker.waitForDrain();
        }
        if (scenario === "late" || scenario === "detached-report") {
          assert.deepEqual(journal.read().entries, []);
          assert.deepEqual(completed, [1]);
        } else {
          assert.equal(journal.read().entries.length, 1);
          assert.deepEqual(completed, [], "failed guards cannot emit source-disposition ACKs");
          assert.equal(await readFile(options.path, "utf8"), before);
          if (["changed", "binding", "identity", "context", "unavailable"].includes(scenario)) assert.ok(errors.length > 0);
        }
      }
      assert.equal(legacyCalls, 0, "an exact completion never falls back to ID-only removal");
      assert.equal(exactCalls, ["immediate", "mixed", "late", "changed", "detached-report"].includes(scenario) ? 1 : 0);
      if (["immediate", "mixed", "late", "detached-report"].includes(scenario)) assert.deepEqual(errors, []);
    } finally {
      await worker.stop(); await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const scenario of ["immediate", "mixed", "late", "lost-ack", "no-result", "foreign-result", "mutated-input", "missing-reader",
  "empty-read", "foreign-read", "post-commit-identity", "post-read-binding", "conflicting-report", "bad-scope", "capability-snapshot"] as const) {
  test(`Scoped worker completion requires a retained journal ACK before notification (${scenario})`,
    async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-scoped-worker-ack-"));
    const journalSerialization = createTelegramJournalSourceSerialization(() => join(dir, "journals.transaction"));
    const resolve = createTelegramUpdateJournalRuntimeBindingResolver({ getProfileName: () => undefined, getBotToken: () => "fixture",
      getBotId: () => undefined, getJournalPath: () => join(dir, "inbox.json"), withSourceSerialization: journalSerialization });
    const binding = resolve()!, journal = binding.journal;
    journal.appendBatch((scenario === "mixed" ? [1, 2] : [1]).map(update_id => ({ update_id,
      message: { message_id: update_id, chat: { id: 7, type: "private" }, text: "fixture" } })));
    const digest = createTelegramUpdateJournalEntryDigest(journal.read().entries[0]!);
    const expectedSource = { ...digest, journalBindingKey: binding.recoveryKey, completionSha256: "a".repeat(64) };
    const completion = { ...digest, completionSha256: expectedSource.completionSha256 };
    let liveBinding = binding.recoveryKey, generation = 1, carrier: unknown;
    let exactCalls = 0, inspections = 0, legacyCalls = 0;
    const completed: number[] = [], failures: unknown[] = [];
    const port = { ...journal, removeCompleted(ids: readonly number[]) { legacyCalls++; return journal.removeCompleted(ids); },
      removeCompletedExact: ((ids, guards, scopes) => {
        exactCalls++;
        assert.deepEqual(scopes, [completion]);
        if (scenario === "mutated-input") scopes![0]!.completionSha256 = "f".repeat(64);
        const removed = journal.removeCompletedExact(ids, guards, scopes);
        if (scenario === "lost-ack") throw new Error("Fixture scoped removal ACK lost");
        if (scenario === "no-result") delete removed.sourceCompletions;
        if (scenario === "foreign-result") removed.sourceCompletions![0]!.completionSha256 = "f".repeat(64);
        if (scenario === "post-commit-identity") generation++;
        return removed;
      }) as NonNullable<Parameters<typeof createTelegramUpdateWorkerRuntime>[0]["journal"]["removeCompletedExact"]>,
      inspectSourceCompletion: scenario === "missing-reader" ? undefined : ((scope) => {
        inspections++;
        const observed = journal.inspectSourceCompletion(scope);
        if (scenario === "empty-read") return undefined;
        if (scenario === "foreign-read") {
          scope.completionSha256 = "f".repeat(64);
          return { ...observed!, completionSha256: "f".repeat(64) };
        }
        if (scenario === "post-read-binding") liveBinding = "foreign";
        return observed;
      }) as NonNullable<Parameters<typeof createTelegramUpdateWorkerRuntime>[0]["journal"]["inspectSourceCompletion"]> };
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({ journal: port,
      getJournalBindingKey: () => liveBinding, hasAuthority: () => true,
      getQueueOwnerIdentity: () => ({ instanceId: "fixture", processId: process.pid, processBirthId: `${process.pid}:ack`, sessionGeneration: generation }),
      async defaultHandle(update) {
        if (update.update_id !== 1) return;
        carrier = update.message;
        if (["immediate", "mixed", "conflicting-report", "bad-scope"].includes(scenario)) {
          reportTelegramUpdateCompleted(carrier, scenario === "bad-scope" ? { ...expectedSource, completionSha256: "invalid" } : expectedSource);
          if (scenario === "conflicting-report") reportTelegramUpdateCompleted(carrier, { ...expectedSource, completionSha256: "f".repeat(64) });
          else { reportTelegramUpdateCompleted(carrier, { ...digest, journalBindingKey: binding.recoveryKey }); reportTelegramUpdateCompleted(carrier); }
        } else reportTelegramUpdateDeferred(carrier);
      },
      onUpdateCompleted(id) {
        if (id === 1) assert.deepEqual(resolve()!.journal.inspectSourceCompletion(completion), completion,
          "notification is after durable removal/ACK, not after a report alone");
        completed.push(id);
      }, recordRuntimeEvent(_category, error) { failures.push(error); },
    });
    try {
      worker.start(TEST_CONTEXT); await worker.waitForDrain();
      if (!["immediate", "mixed", "conflicting-report", "bad-scope"].includes(scenario)) {
        if (scenario === "capability-snapshot") {
          port.removeCompletedExact = () => { throw new Error("Replacement must not inherit a captured completion grant"); };
          port.inspectSourceCompletion = () => { throw new Error("Replacement must not lend its reader"); };
        }
        assert.equal(reportTelegramUpdateCompleted(carrier, expectedSource), true);
        await Promise.resolve(); await worker.waitForDrain();
      }
      const success = ["immediate", "mixed", "late", "capability-snapshot"].includes(scenario);
      assert.deepEqual(completed, success ? scenario === "mixed" ? [1, 2] : [1] : []);
      assert.equal(legacyCalls, 0, "scope requirements never downgrade into ordinary removal");
      const notIssued = ["missing-reader", "conflicting-report", "bad-scope"].includes(scenario);
      assert.equal(exactCalls, notIssued ? 0 : 1);
      assert.equal(journal.read().entries.length, notIssued ? 1 : 0);
      if (notIssued) assert.equal(resolve()!.journal.inspectSourceCompletion(completion), undefined);
      else if (scenario === "mutated-input") assert.throws(() => resolve()!.journal.inspectSourceCompletion(completion), /another exact scope/);
      else assert.deepEqual(resolve()!.journal.inspectSourceCompletion(completion), completion,
        "producer reply/read/authority faults preserve the actual ACK for later explicit recovery");
      assert.equal(inspections, ["immediate", "mixed", "late", "empty-read", "foreign-read", "post-read-binding", "capability-snapshot"].includes(scenario) ? 1 : 0);
      if (success) assert.deepEqual(failures, []); else assert.ok(failures.length > 0);
    } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

test("Ordinary queue receipts publish where strict journal source access is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-queued-nonstrict-binding-"));
  const journalSerialization = createTelegramJournalSourceSerialization(() => join(dir, "journals.transaction"));
  // Windows has no no-follow handles; readiness must still come from the ordinary journal instead of refusing every prompt.
  const resolve = createTelegramUpdateJournalRuntimeBindingResolver({ getProfileName: () => undefined, getBotToken: () => "fixture",
    getBotId: () => undefined, getJournalPath: () => join(dir, "inbox.json"), withSourceSerialization: journalSerialization,
    strictSourceAccess: false });
  const binding = resolve()!, journal = binding.journal;
  journal.appendBatch([{ update_id: 1, message: { message_id: 1, chat: { id: 7, type: "private" }, text: "original" } }]);
  const identity = { instanceId: "fixture-local", processId: 42, processBirthId: "fixture-birth", sessionGeneration: 1 };
  const receipt = { receiptId: "nonstrict", queueKind: "prompt" as const, sourceUpdateIds: [1], journalBindingKey: binding.recoveryKey };
  let carrier: unknown, published = 0;
  const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
    journal, getJournalBindingKey: () => binding.recoveryKey, getQueueOwnerIdentity: () => identity, hasAuthority: () => true,
    async defaultHandle(update) { carrier = update.message; reportTelegramUpdateDeferred(carrier); },
    async beforeQueueReceiptPublished(actual, owner) {
      assert.equal(journal.inspectQueuedReceipt!({ queueKind: actual.queueKind, receiptId: actual.receiptId,
        sourceUpdateIds: [...actual.sourceUpdateIds], queueOwner: owner })?.receipt.receiptId, "nonstrict");
    },
    onQueueReceiptCommitted() { published++; },
  });
  try {
    worker.start(TEST_CONTEXT); await worker.waitForDrain();
    reportTelegramQueueAdmission([carrier], [receipt]);
    await new Promise<void>(resolve => setImmediate(resolve)); await worker.waitForDrain();
    assert.equal(published, 1);
    assert.equal(worker.isQueueReceiptCommitted(receipt), true);
  } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
});

for (const scenario of ["exact", "foreign-binding", "read-only", "completed-after", "corrupt-after"] as const) {
  test(`Production journal binding composes strict queued observation with publication readiness (${scenario})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-queued-native-binding-"));
    const path = join(dir, "inbox.json");
    const journalSerialization = createTelegramJournalSourceSerialization(() => join(dir, "journals.transaction"));
    let writesAllowed = true;
    const resolve = createTelegramUpdateJournalRuntimeBindingResolver({ getProfileName: () => undefined, getBotToken: () => "fixture",
      getBotId: () => undefined, getJournalPath: () => path, withSourceSerialization: journalSerialization,
      withWriterAdmission(operation) { if (!writesAllowed) throw new Error("Read-only observation must not borrow writer authority"); return operation(); } });
    const binding = resolve()!, journal = binding.journal;
    journal.appendBatch([{ update_id: 1, message: { message_id: 1, chat: { id: 7, type: "private" }, text: "original" } }]);
    const identity = { instanceId: "fixture-local", processId: 42, processBirthId: "fixture-birth", sessionGeneration: 1 };
    const receipt = { receiptId: "native-fixture", queueKind: "prompt" as const, sourceUpdateIds: [1], journalBindingKey: binding.recoveryKey };
    let carrier: unknown, published = 0, prepared = 0, proof: ReturnType<typeof journal.inspectQueuedReceipt>;
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal, getJournalBindingKey: () => binding.recoveryKey, getQueueOwnerIdentity: () => identity, hasAuthority: () => true,
      async defaultHandle(update) { carrier = update.message; reportTelegramUpdateDeferred(carrier); },
      async beforeQueueReceiptPublished(actual, owner, _ctx, current): Promise<void> {
        prepared++;
        if (scenario === "read-only") writesAllowed = false;
        assert.equal(worker.isQueueReceiptCommitted(receipt), false);
        proof = journal.inspectQueuedReceipt({ queueKind: actual.queueKind, receiptId: actual.receiptId,
          sourceUpdateIds: [...actual.sourceUpdateIds], queueOwner: owner });
        assert.ok(proof); assert.equal(current(), true);
        assert.equal(journal.isQueueReceiptCurrent!({ ...actual, journalBindingKey: "foreign" }, owner), false);
        assert.equal(journal.isQueueReceiptCurrent!({ ...actual, sourceUpdateIds: [1, 2] }, owner), false);
        assert.equal(journal.isQueueReceiptCurrent!(actual, { ...owner, acquisitionId: "foreign" }), false);
        if (scenario === "completed-after") journal.completeQueued([proof!.receipt]);
        if (scenario === "corrupt-after") await writeFile(path, "{corrupt-original-snapshot");
        await Promise.resolve();
      },
      onQueueReceiptCommitted() { published++; },
    });
    try {
      worker.start(TEST_CONTEXT); await worker.waitForDrain();
      reportTelegramQueueAdmission([carrier], [receipt]);
      await new Promise<void>(resolve => setImmediate(resolve)); await worker.waitForDrain();
      assert.equal(prepared, 1);
      assert.equal(published, ["exact", "foreign-binding", "read-only"].includes(scenario) ? 1 : 0);
      if (scenario === "foreign-binding") assert.equal(worker.isQueueReceiptCommitted({ ...receipt, journalBindingKey: "foreign" }), false);
      else assert.equal(worker.isQueueReceiptCommitted(receipt), scenario === "exact" || scenario === "read-only");
      if (scenario === "exact") assert.deepEqual(resolve()!.journal.inspectQueuedReceipt(proof!.receipt), proof);
      if (scenario === "corrupt-after") assert.equal(await readFile(path, "utf8"), "{corrupt-original-snapshot", "observation cannot repair corruption into readiness");
    } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const scenario of ["normal", "transport-lost", "ordinary", "grouped", "batch", "batch-reordered", "scope-subset", "empty-scope", "duplicate-scope", "foreign-binding",
  "missing-disposer", "missing-reader", "missing-scope", "bad-hash", "identity-before", "binding-before", "source-changed", "before-write", "restart-held",
  "lost-ack", "lost-ack-restart", "no-result", "no-removed-result", "foreign-result", "reader-empty", "reader-throws", "reader-foreign",
  "post-commit-context", "post-read-binding", "post-read-identity", "detached", "capability-snapshot", "downgrade", "conflicting-retry"] as const) {
  test(`Scoped queued worker disposition acknowledges only retained full-source proof (${scenario})`,
    async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-queue-terminal-"));
    const identity = { instanceId: "queue-terminal", processId: process.pid, processBirthId: `${process.pid}:fixture`, sessionGeneration: 1 };
    const resolve = createTelegramUpdateJournalRuntimeBindingResolver({ getProfileName: () => undefined, getBotToken: () => "fixture",
      getBotId: () => undefined, getJournalPath: () => join(dir, "inbox.json"), getQueueRuntimeIdentity: () => identity,
      withSourceSerialization: createTelegramJournalSourceSerialization(() => join(dir, "journals.transaction")) });
    const binding = resolve()!, journal = binding.journal;
    const ids = scenario === "grouped" || scenario === "batch" || scenario === "batch-reordered" || scenario === "scope-subset" || scenario === "duplicate-scope" ? [1, 2] : [1];
    journal.appendBatch(ids.map(update_id => ({ update_id, message: { message_id: update_id, chat: { id: 7, type: "private" }, text: "accepted fixture" } })));
    const receipts = scenario === "batch" || scenario === "batch-reordered" ? ids.map(id => ({ queueKind: "prompt" as const, receiptId: `queued-${id}`, sourceUpdateIds: [id], journalBindingKey: binding.recoveryKey }))
      : [{ queueKind: "prompt" as const, receiptId: "queued", sourceUpdateIds: [...ids], journalBindingKey: binding.recoveryKey }];
    const carriers: unknown[] = [], events: string[] = [];
    let currentBinding = binding.recoveryKey, contextCurrent = true, transportCurrent = true, fault = true, disposals = 0, reads = 0, snapshots = 0, publications = 0;
    const port: TelegramUpdateWorkerJournalPort = { ...journal,
      read() { snapshots++; return journal.read(); },
      completeQueued(receipts) { events.push("ordinary-disposal"); return journal.completeQueued(receipts); },
      completeQueuedExact: scenario === "missing-disposer" ? undefined : function (this: TelegramUpdateWorkerJournalPort, receipts, markers) {
        assert.equal(this, port, "captured disposal retains its original receiver"); disposals++; events.push("scoped-disposal");
        if (scenario === "before-write" || scenario === "restart-held") throw new Error("Fixture queued disposal not published");
        const result = journal.completeQueuedExact(receipts, markers);
        if (scenario === "post-commit-context") contextCurrent = false;
        if (scenario === "detached") markers[0]!.completionSha256 = "f".repeat(64);
        if (scenario === "lost-ack" || scenario === "lost-ack-restart" || scenario === "batch-reordered" || scenario === "downgrade" || scenario === "conflicting-retry") throw new Error("Fixture scoped queued ACK lost");
        if (scenario === "no-result") return { removedUpdateIds: result.removedUpdateIds };
        if (scenario === "no-removed-result") return { ...result, removedUpdateIds: [] };
        if (scenario === "foreign-result") return { ...result, sourceCompletions: result.sourceCompletions!.map(marker => ({ ...marker, completionSha256: "f".repeat(64) })) };
        return result;
      },
      inspectSourceCompletion: scenario === "missing-reader" ? undefined : function (this: TelegramUpdateWorkerJournalPort, expected) {
        assert.equal(this, port, "captured reader retains its original receiver"); reads++; events.push("read");
        if (fault && scenario === "reader-throws") throw new Error("Fixture queued ACK read failed");
        const result = journal.inspectSourceCompletion({ ...expected });
        if (fault && scenario === "reader-empty") return undefined;
        if (fault && scenario === "reader-foreign") return result && { ...result, sourceSha256: "f".repeat(64) };
        if (fault && scenario === "post-read-binding") currentBinding = "foreign";
        if (fault && scenario === "post-read-identity") identity.sessionGeneration++;
        if (scenario === "detached") expected.completionSha256 = "f".repeat(64);
        return result;
      },
    };
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal: port, getJournalBindingKey: () => currentBinding, getQueueOwnerIdentity: () => identity,
      hasAuthority: () => transportCurrent, isContextCurrent: () => contextCurrent,
      onQueueReceiptCommitted() { publications++; },
      async defaultHandle(update) { carriers.push(update.message); reportTelegramUpdateDeferred(update.message); },
    });
    try {
      worker.start(TEST_CONTEXT); await worker.waitForDrain(); reportTelegramQueueAdmission(carriers, receipts);
      await Promise.resolve(); await worker.waitForDrain();
      assert.equal(carriers.length, ids.length); assert.ok(receipts.every(receipt => worker.isQueueReceiptCommitted(receipt)));
      assert.equal(publications, receipts.length, "each actual queued group publishes exactly once");
      const proof = journal.read().entries.map(entry => ({ ...createTelegramUpdateJournalEntryDigest(entry),
        journalBindingKey: binding.recoveryKey, completionSha256: (entry.updateId === 1 ? "a" : "b").repeat(64) }));
      const expected = structuredClone(proof);
      if (scenario === "scope-subset") proof.pop();
      if (scenario === "empty-scope") proof.length = 0;
      if (scenario === "duplicate-scope") proof[1]!.completionSha256 = proof[0]!.completionSha256;
      if (scenario === "missing-scope") proof[0]!.completionSha256 = undefined as never;
      if (scenario === "bad-hash") proof[0]!.sourceSha256 = "invalid";
      if (scenario === "source-changed") proof[0]!.sourceSha256 = "f".repeat(64);
      if (scenario === "identity-before") identity.sessionGeneration++;
      if (scenario === "binding-before") currentBinding = "foreign";
      if (scenario === "foreign-binding") proof[0]!.journalBindingKey = "foreign";
      if (scenario === "transport-lost") transportCurrent = false;
      if (scenario === "capability-snapshot") {
        port.completeQueuedExact = () => { assert.fail("replacement cannot inherit a captured disposal"); };
        port.inspectSourceCompletion = () => { assert.fail("replacement cannot lend its reader"); };
      }
      const input = { receipts, ctx: TEST_CONTEXT, reason: "prompt-handoff" as const,
        ...(scenario === "ordinary" ? {} : { sourceCompletions: proof }) };
      const result = worker.completeQueueReceipts(input);
      const positive = ["normal", "transport-lost", "ordinary", "grouped", "batch", "detached", "capability-snapshot"].includes(scenario);
      assert.equal(result, positive); assert.equal(carriers.length, ids.length, "terminal disposition never invokes the original handler");
      const neverIssued = ["scope-subset", "empty-scope", "duplicate-scope", "foreign-binding", "missing-disposer", "missing-reader",
        "missing-scope", "bad-hash", "identity-before", "binding-before"].includes(scenario);
      const uncommitted = ["before-write", "restart-held", "source-changed"].includes(scenario);
      assert.equal(disposals, scenario === "ordinary" || neverIssued ? 0 : 1);
      assert.equal(worker.getState().queuedClaimCount, positive ? 0 : ids.length, "memory cleanup follows only positive retained ACKs");
      assert.equal(journal.read().entries.length, neverIssued || uncommitted ? ids.length : 0);
      if (neverIssued) {
        assert.equal(worker.completeQueueReceipts({ receipts, ctx: TEST_CONTEXT, reason: "prompt-handoff" }), false,
          "failed guarded requests cannot turn into ordinary receipt disposal");
        assert.equal(events.includes("ordinary-disposal"), false); assert.equal(disposals, 0);
      }
      if (positive && scenario !== "ordinary") assert.equal(reads, ids.length);
      if (scenario === "ordinary") {
        assert.deepEqual(events, ["ordinary-disposal"]);
        const { journalBindingKey: _binding, ...scope } = expected[0]!;
        assert.equal(journal.inspectSourceCompletion(scope), undefined);
      }
      else if (!neverIssued && !uncommitted) for (const marker of expected) {
        const { journalBindingKey: _binding, ...scope } = marker;
        assert.deepEqual(journal.inspectSourceCompletion(scope), scope, "lost replies retain exact scoped evidence");
      }
      if (scenario === "restart-held" || scenario === "lost-ack-restart") {
        worker.signal(); await worker.waitForDrain();
        assert.equal(worker.getState().queuedClaimCount, ids.length);
        assert.equal(worker.isQueueReceiptCommitted(receipts[0]!), false);
        await worker.stop(); worker.start(TEST_CONTEXT); await worker.waitForDrain();
        assert.equal(worker.completeQueueReceipts(input), false, "a new worker owner cannot borrow the old issued batch");
        assert.equal(worker.completeQueueReceipts({ receipts, ctx: TEST_CONTEXT, reason: "prompt-handoff" }), false);
        assert.equal(worker.getQueueReceiptSettlementOwner!(receipts[0]!, TEST_CONTEXT, "prompt-handoff"), undefined);
        assert.equal(worker.getQueueReceiptOwner(receipts[0]!), undefined);
        assert.equal(disposals, 1); assert.equal(carriers.length, ids.length); assert.equal(journal.read().entries.length, scenario === "restart-held" ? ids.length : 0);
      } else if (!positive && !neverIssued) {
        contextCurrent = true; currentBinding = binding.recoveryKey; identity.sessionGeneration = 1;
        if (scenario === "downgrade") {
          assert.equal(worker.completeQueueReceipts({ receipts, ctx: TEST_CONTEXT, reason: "prompt-handoff" }), false);
          assert.equal(events.includes("ordinary-disposal"), false);
        }
        if (scenario === "conflicting-retry") {
          assert.equal(worker.completeQueueReceipts({ ...input, sourceCompletions: proof.map(marker => ({ ...marker, completionSha256: "f".repeat(64) })) }), false);
        }
        const beforeSnapshots = snapshots, beforePublications = publications;
        for (let refresh = 0; refresh < 2; refresh++) {
          worker.signal(); await worker.waitForDrain();
          assert.ok(snapshots > beforeSnapshots + refresh, "public drain reads and refreshes the native journal before retry");
          assert.equal(journal.read().entries.length, uncommitted ? ids.length : 0);
          assert.equal(worker.getState().queuedClaimCount, ids.length, "unknown ACK keeps frozen claims even when queued rows disappeared");
          assert.ok(receipts.every(receipt => !worker.isQueueReceiptCommitted(receipt) && !worker.getQueueReceiptOwner(receipt)),
            "issued attempts never regain execution readiness through refresh");
          assert.equal(publications, beforePublications, "refresh never republishes an issued receipt");
          assert.equal(worker.getQueueReceiptSettlementOwner!(receipts[0]!, TEST_CONTEXT, "discard"), undefined);
          assert.ok(worker.getQueueReceiptSettlementOwner!(receipts[0]!, TEST_CONTEXT, "prompt-handoff"),
            "only matching frozen settlement retains its owner");
        }
        if (["reader-empty", "reader-throws", "reader-foreign"].includes(scenario)) {
          assert.equal(worker.completeQueueReceipts(input), false, "missing/unreadable/conflicting proof stays frozen after refresh");
          assert.equal(worker.getState().queuedClaimCount, ids.length);
          assert.equal(disposals, 1);
        }
        fault = false;
        const beforeInvalidReads = reads;
        if (scenario === "lost-ack") {
          for (const replacement of ["binding", "session", "process"] as const) {
            const original = { ...identity };
            if (replacement === "binding") currentBinding = "foreign";
            if (replacement === "session") identity.sessionGeneration++;
            if (replacement === "process") identity.processBirthId = "replacement-birth";
            assert.equal(worker.getQueueReceiptSettlementOwner!(receipts[0]!, TEST_CONTEXT, "prompt-handoff"), undefined);
            assert.equal(worker.completeQueueReceipts(input), false, "replacement authority cannot borrow frozen settlement");
            worker.signal(); await worker.waitForDrain();
            assert.equal(worker.completeQueueReceipts(input), false, "refresh cannot authorize replacement authority");
            assert.equal(worker.isQueueReceiptCommitted(receipts[0]!), false);
            Object.assign(identity, original); currentBinding = binding.recoveryKey;
          }
        }
        assert.equal(worker.completeQueueReceipts({ receipts, ctx: TEST_CONTEXT, reason: "prompt-handoff" }), false,
          "refresh cannot downgrade an explicitly scoped attempt to ordinary disposal");
        assert.equal(events.includes("ordinary-disposal"), false);
        assert.equal(worker.completeQueueReceipts({ ...input, reason: "discard" }), false);
        assert.equal(worker.completeQueueReceipts({ ...input, sourceCompletions: proof.map(marker => ({ ...marker, completionSha256: "f".repeat(64) })) }), false);
        if (receipts.length > 1) assert.equal(worker.completeQueueReceipts({ ...input, receipts: receipts.slice(0, 1), sourceCompletions: proof.slice(0, 1) }), false);
        assert.equal(reads, beforeInvalidReads, "wrong reason/scope/subset cannot inspect or mutate the issued attempt");
        assert.equal(disposals, 1);
        const beforeReads = reads;
        const reconciled = worker.completeQueueReceipts(scenario === "batch-reordered" ? { ...input, receipts: [...receipts].reverse() } : input);
        assert.equal(reconciled, !uncommitted, "a retry reads only exact retained proof; missing proof stays held");
        assert.equal(disposals, 1, "an issued or uncertain disposal never replays");
        assert.ok(reads > beforeReads); assert.equal(worker.getState().queuedClaimCount, reconciled ? 0 : ids.length);
        assert.equal(carriers.length, ids.length, "refresh and reconciliation never re-enter the handler");
        assert.equal(publications, receipts.length, "reconciliation emits no new queue receipt");
      }
    } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const scenario of ["ready", "group", "control", "batch", "mixed", "mixed-lost", "mixed-batch-lost", "mixed-ordinary-fails", "mixed-context", "mixed-binding", "mixed-identity", "mixed-control", "mixed-discard", "subset", "override", "detached", "missing-reader", "missing-disposer", "observer", "cold"] as const) {
  test(`Prepared queue scopes reach lifecycle disposal without ordinary downgrade (${scenario})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-prepared-queue-scopes-"));
    const identity = { instanceId: "prepared", processId: process.pid, processBirthId: `${process.pid}:prepared`, sessionGeneration: 1 };
    const resolve = createTelegramUpdateJournalRuntimeBindingResolver({ getProfileName: () => undefined, getBotToken: () => "fixture", getBotId: () => undefined,
      getJournalPath: () => join(dir, "inbox.json"), getQueueRuntimeIdentity: () => identity,
      withSourceSerialization: createTelegramJournalSourceSerialization(() => join(dir, "journals.transaction")) });
    const binding = resolve()!, journal = binding.journal, grouped = scenario === "group" || scenario === "subset", mixed = scenario.startsWith("mixed"), batch = scenario === "batch" || mixed;
    const ids = scenario === "mixed-batch-lost" ? [1, 2, 3] : grouped || batch ? [1, 2] : [1], ordinaryId = ids.at(-1)!,
      queueKind = scenario === "control" || scenario === "mixed-control" ? "control" as const : "prompt" as const;
    journal.appendBatch(ids.map(update_id => ({ update_id, message: { message_id: update_id, chat: { id: 7, type: "private" }, text: "fixture accepted work" } })));
    const receipts = (batch ? ids.map(id => [id]) : [ids]).map(sourceUpdateIds => ({ sourceUpdateIds, queueKind, receiptId: `prepared-${sourceUpdateIds[0]}`, journalBindingKey: binding.recoveryKey }));
    const carriers: unknown[] = [], hints: string[] = [], failures: unknown[] = [], prepared: TelegramQueueSourceCompletion[] = [];
    let ordinary = 0, exact = 0, publications = 0, liveBinding = binding.recoveryKey, contextCurrent = true, fault = true;
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal: { ...journal, completeQueued(receipts) {
          ordinary++;
          if (fault && scenario === "mixed-ordinary-fails") throw new Error("Fixture ordinary sibling disposal not published");
          return journal.completeQueued(receipts);
        },
        completeQueuedExact: scenario === "missing-disposer" ? undefined : (receipts, scopes) => {
          exact++;
          const result = journal.completeQueuedExact(receipts, scopes);
          if (fault && (scenario === "mixed-lost" || scenario === "mixed-batch-lost")) throw new Error("Fixture mixed scoped disposal ACK lost");
          return result;
        },
        inspectSourceCompletion: scenario === "missing-reader" ? undefined : journal.inspectSourceCompletion },
      getJournalBindingKey: () => liveBinding, getQueueOwnerIdentity: () => identity, hasAuthority: () => true, isContextCurrent: () => contextCurrent,
      async defaultHandle(update) { carriers.push(update.message); reportTelegramUpdateDeferred(update.message); },
      async beforeQueueReceiptPublished(receipt) {
        publications++;
        if (mixed && receipt.sourceUpdateIds[0] === ordinaryId) return;
        const scopes = journal.read().entries.filter(entry => receipt.sourceUpdateIds.includes(entry.updateId)).map(entry => ({
          ...createTelegramUpdateJournalEntryDigest(entry), journalBindingKey: binding.recoveryKey,
          completionSha256: (entry.updateId === 1 ? "a" : "b").repeat(64) }));
        prepared.push(...scopes);
        return scenario === "subset" ? scopes.slice(0, 1) : scopes;
      },
      onQueueReceiptCompleted(receipt) {
        assert.equal(worker.getState().queuedClaimCount, mixed ? 1 : 0, "a scoped ACK does not clear an independently owned ordinary sibling");
        hints.push(receipt.receiptId);
        if (fault && scenario === "mixed-context") contextCurrent = false;
        if (fault && scenario === "mixed-binding") liveBinding = "foreign";
        if (fault && scenario === "mixed-identity") identity.sessionGeneration++;
        if (scenario === "observer") throw new Error("Fixture post-ACK observer failed");
        (receipt.sourceUpdateIds as number[]).length = 0;
      }, recordRuntimeEvent(_category, error) { failures.push(error); },
    });
    try {
      worker.start(TEST_CONTEXT); await worker.waitForDrain(); reportTelegramQueueAdmission(carriers, receipts);
      await Promise.resolve(); await worker.waitForDrain();
      const held = ["missing-reader", "missing-disposer"].includes(scenario);
      assert.equal(receipts.every(receipt => worker.isQueueReceiptCommitted(receipt)), !held);
      if (scenario === "detached") prepared[0]!.completionSha256 = "f".repeat(64);
      if (scenario === "cold") { await worker.stop(); worker.start(TEST_CONTEXT); await worker.waitForDrain(); assert.equal(publications, 2); }
      const settlement = createTelegramQueueAdmissionSettlementMuxRuntime([createTelegramQueueAdmissionSettlementRuntime(worker)]);
      const item = { admissionReceipts: receipts };
      const complete = () => scenario === "mixed-discard" ? settlement.onItemsDiscarded([item], TEST_CONTEXT)
        : queueKind === "control" ? settlement.onControlSettled(item, TEST_CONTEXT) : settlement.onPromptHandedOff(item, TEST_CONTEXT);
      if (scenario === "override") assert.equal(worker.completeQueueReceipts({ receipts, ctx: TEST_CONTEXT, reason: "prompt-handoff",
        sourceCompletions: prepared.map(scope => ({ ...scope, completionSha256: "f".repeat(64) })) }), false);
      const uncertain = mixed && !["mixed", "mixed-control", "mixed-discard"].includes(scenario), lost = scenario === "mixed-lost" || scenario === "mixed-batch-lost";
      assert.equal(complete(), !held && !uncertain);
      assert.equal(exact, held ? 0 : 1);
      assert.equal(ordinary, mixed && (!uncertain || scenario === "mixed-ordinary-fails") ? 1 : 0);
      assert.equal(worker.getState().queuedClaimCount, held || lost ? ids.length : uncertain ? 1 : 0);
      assert.equal(carriers.length, ids.length, "scope reconstruction and disposition never replay a handler");
      assert.equal(hints.length, held || lost ? 0 : mixed ? ids.length - 1 : receipts.length);
      assert.ok(receipts.every(receipt => receipt.sourceUpdateIds.length > 0), "observer metadata cannot mutate the original receipt");
      if (mixed) {
        if (uncertain) {
          assert.deepEqual(journal.read().entries.map(entry => entry.updateId), [ordinaryId], "independent ordinary work survives an uncertain scoped ACK or ended authority");
          assert.equal(settlement.isItemReady(item), false, "partial ACKs never restore execution readiness");
          if (scenario === "mixed-context" || scenario === "mixed-binding" || scenario === "mixed-identity") assert.equal(complete(), false);
          fault = false; contextCurrent = true; liveBinding = binding.recoveryKey; identity.sessionGeneration = 1;
          if (lost) {
            const beforePublications = publications;
            worker.signal(); await worker.waitForDrain();
            worker.signal(); await worker.waitForDrain();
            assert.equal(publications, beforePublications, "frozen prepared scopes survive refresh without republishing");
            assert.equal(worker.getState().queuedClaimCount, ids.length);
            assert.equal(settlement.isItemReady(item), false);
          }
          assert.equal(complete(), true, "retained exact ACKs resume source disposition, never semantic handoff");
        }
        assert.equal(exact, 1, "partition retry never repeats an issued scoped disposal");
        assert.equal(ordinary, scenario === "mixed-ordinary-fails" ? 2 : 1);
        assert.equal(worker.getState().queuedClaimCount, 0);
        assert.deepEqual(journal.read().entries, []);
        assert.equal(journal.inspectSourceCompletion({ updateId: ordinaryId, sourceSha256: prepared[0]!.sourceSha256, completionSha256: "f".repeat(64) }), undefined,
          "ordinary siblings gain no invented source marker");
        assert.equal(hints.length, ids.length - 1);
        assert.equal(complete(), true, "local cleanup can reuse acknowledged receipts without any disposal");
        assert.equal(exact, 1); assert.equal(ordinary, scenario === "mixed-ordinary-fails" ? 2 : 1);
        assert.equal(settlement.isItemReady(item), false);
        await worker.waitForDrain();
        assert.equal(worker.getState().queuedClaimCount, 0, "a wake cannot reconstruct already acknowledged siblings");
        assert.ok(failures.every(error => /Fixture mixed scoped disposal ACK lost|Fixture ordinary sibling disposal not published/.test(String(error))),
          "partition wake cannot reconstruct a stale mid-batch snapshot");
      }
      if (scenario === "subset") assert.equal(journal.inspectSourceCompletion({ updateId: 2, sourceSha256: prepared[1]!.sourceSha256,
        completionSha256: prepared[1]!.completionSha256 }), undefined, "an ordinary sibling obtains no scoped marker");
      if (scenario === "observer") assert.ok(failures.some(error => String(error).includes("post-ACK observer")));
    } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const scenario of ["positive", "batch", "before-write", "after-write", "partial-result", "context", "binding", "identity", "abort", "origin-binding", "observer-context", "observer-throws"] as const) {
  test(`Ordinary queued source hints require a whole ACK and fresh origin authority (${scenario})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-ordinary-queue-hint-"));
    const identity = { instanceId: "ordinary", processId: process.pid, processBirthId: `${process.pid}:ordinary`, sessionGeneration: 1 };
    const resolve = createTelegramUpdateJournalRuntimeBindingResolver({ getProfileName: () => undefined, getBotToken: () => "fixture", getBotId: () => undefined,
      getJournalPath: () => join(dir, "inbox.json"), getQueueRuntimeIdentity: () => identity,
      withSourceSerialization: createTelegramJournalSourceSerialization(() => join(dir, "journals.transaction")) });
    const binding = resolve()!, journal = binding.journal, ids = scenario === "positive" ? [1] : [1, 2];
    journal.appendBatch(ids.map(update_id => ({ update_id, message: { message_id: update_id, chat: { id: 7, type: "private" }, text: "ordinary queued input" } })));
    const receipts = ids.map(id => ({ queueKind: "prompt" as const, receiptId: `ordinary-${id}`, sourceUpdateIds: [id], journalBindingKey: binding.recoveryKey }));
    const carriers: unknown[] = [], hints: number[] = [], failures: unknown[] = [], controller = new AbortController();
    let liveBinding = binding.recoveryKey, contextCurrent = true, disposals = 0;
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal: { ...journal, completeQueued(receipts) {
        disposals++;
        if (scenario === "before-write") throw new Error("Fixture ordinary disposition not issued");
        const result = journal.completeQueued(receipts);
        if (scenario === "after-write") throw new Error("Fixture ordinary disposition ACK lost");
        if (scenario === "context") contextCurrent = false;
        if (scenario === "binding") liveBinding = "foreign";
        if (scenario === "identity") identity.sessionGeneration++;
        if (scenario === "abort") controller.abort();
        return scenario === "partial-result" ? { ...result, removedUpdateIds: ids.slice(0, 1) } : result;
      } },
      getJournalBindingKey: () => liveBinding, getQueueOwnerIdentity: () => identity,
      hasAuthority: () => true, isContextCurrent: () => contextCurrent, createAbortController: () => controller, getNowMs: () => 1,
      async defaultHandle(update) { carriers.push(update.message); reportTelegramUpdateDeferred(update.message); },
      onUpdateCompleted(updateId, _ctx, key) {
        assert.equal(key, binding.recoveryKey);
        assert.equal(worker.getState().queuedClaimCount, 0);
        assert.deepEqual(journal.read().entries, [], "hints follow positive whole-source disposition, never admission");
        hints.push(updateId);
        if (scenario === "observer-context") contextCurrent = false;
        if (scenario === "observer-throws") throw new Error("Fixture ordinary post-ACK observer failed");
      }, recordRuntimeEvent(_category, error) { failures.push(error); },
    });
    try {
      worker.start(TEST_CONTEXT); await worker.waitForDrain(); reportTelegramQueueAdmission(carriers, receipts);
      await Promise.resolve(); await worker.waitForDrain();
      assert.equal(receipts.every(receipt => worker.isQueueReceiptCommitted(receipt)), true);
      if (scenario === "origin-binding") liveBinding = "foreign";
      const uncertain = ["before-write", "after-write", "partial-result"].includes(scenario);
      assert.equal(worker.completeQueueReceipts({ receipts, ctx: TEST_CONTEXT, reason: "prompt-handoff" }), !uncertain);
      const expected = ["positive", "batch", "observer-throws"].includes(scenario) ? ids : scenario === "observer-context" ? [1] : [];
      assert.deepEqual(hints, expected);
      assert.equal(disposals, 1);
      assert.equal(carriers.length, ids.length, "completion observation never reexecutes accepted work");
      assert.equal(worker.getState().queuedClaimCount, uncertain ? ids.length : 0);
      assert.equal(journal.read().entries.length, scenario === "before-write" ? ids.length : 0);
      assert.equal(journal.inspectSourceCompletion({ updateId: 1, sourceSha256: "a".repeat(64), completionSha256: "b".repeat(64) }), undefined,
        "ordinary ACKs acquire no fabricated immutable Restore marker");
      if (!uncertain) {
        worker.completeQueueReceipts({ receipts, ctx: TEST_CONTEXT, reason: "prompt-handoff" });
        assert.equal(disposals, 1); assert.deepEqual(hints, expected, "reusing an acknowledged receipt cannot repeat source hints");
      }
      assert.equal(failures.length > 0, uncertain || scenario === "observer-throws", failures.map(String).join("; "));
    } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const scenario of ["positive", "lost", "before-write", "no-result", "readback", "batch", "mixed", "origin-missing", "origin-empty", "origin-owner",
  "origin-member", "origin-source", "origin-pending", "origin-context", "origin-binding", "origin-identity", "captured", "restart-held", "sticky-missing-witness"] as const) {
  test(`Prepared partial queue scopes acknowledge only immutable whole-receipt origin (${scenario})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-partial-queue-origin-"));
    const identity = { instanceId: "partial", processId: process.pid, processBirthId: `${process.pid}:partial`, sessionGeneration: 1 };
    const resolve = createTelegramUpdateJournalRuntimeBindingResolver({ getProfileName: () => undefined, getBotToken: () => "fixture", getBotId: () => undefined,
      getJournalPath: () => join(dir, "inbox.json"), getQueueRuntimeIdentity: () => identity,
      withSourceSerialization: createTelegramJournalSourceSerialization(() => join(dir, "journals.transaction")) });
    const binding = resolve()!, journal = binding.journal;
    const mixed = scenario === "mixed" || scenario === "sticky-missing-witness";
    const ids = scenario === "batch" ? [1, 2, 3, 4] : mixed ? [1, 2, 3] : [1, 2];
    journal.appendBatch(ids.map(update_id => ({ update_id, message: { message_id: update_id, chat: { id: 7, type: "private" }, text: "whole receipt fixture" } })));
    const pendingHash = createTelegramUpdateJournalEntryDigest(journal.read().entries[0]!).sourceSha256;
    const receipts = (scenario === "batch" ? [[1, 2], [3, 4]] : mixed ? [[1, 2], [3]] : [[1, 2]]).map(sourceUpdateIds => ({
      sourceUpdateIds, queueKind: "prompt" as const, receiptId: `partial-${sourceUpdateIds[0]}`, journalBindingKey: binding.recoveryKey }));
    const carriers: unknown[] = [], failures: unknown[] = [], witnesses: TelegramQueueSourceCompletion[] = [];
    let liveBinding = binding.recoveryKey, contextCurrent = true, fault = true, exact = 0, ordinary = 0, observations = 0, hints = 0, handlerCalls = 0;
    const port: TelegramUpdateWorkerJournalPort = { ...journal,
      completeQueued(receipts) { ordinary++; return journal.completeQueued(receipts); },
      completeQueuedExact(receipts, scopes) {
        exact++;
        if (scenario === "before-write" || scenario === "restart-held") throw new Error("Fixture partial disposal not published");
        const result = journal.completeQueuedExact(receipts, scopes);
        if (fault && scenario === "lost") throw new Error("Fixture partial disposal ACK lost");
        return fault && scenario === "no-result" ? { removedUpdateIds: result.removedUpdateIds } : result;
      },
      inspectSourceCompletion(scope) { return fault && exact > 0 && scenario === "readback" ? undefined : journal.inspectSourceCompletion(scope); },
      inspectQueuedReceipt: scenario === "origin-missing" ? undefined : function (this: TelegramUpdateWorkerJournalPort, expected) {
        assert.equal(this, port); observations++;
        const proof = journal.inspectQueuedReceipt(expected)!;
        if (scenario === "origin-empty") return undefined;
        if (scenario === "origin-owner") proof.receipt.queueOwner.acquisitionId = "foreign";
        if (scenario === "origin-member") (proof.receipt.sourceUpdateIds as number[]).pop();
        if (scenario === "origin-source") proof.sources.pop();
        if (scenario === "origin-context") contextCurrent = false;
        if (scenario === "origin-binding") liveBinding = "foreign";
        if (scenario === "origin-identity") identity.sessionGeneration++;
        (expected.sourceUpdateIds as number[]).length = 0;
        return proof;
      },
    };
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({ journal: port,
      getJournalBindingKey: () => liveBinding, getQueueOwnerIdentity: () => identity, hasAuthority: () => true, isContextCurrent: () => contextCurrent,
      async defaultHandle(update) { handlerCalls++; carriers.push(update.message); reportTelegramUpdateDeferred(update.message); },
      async beforeQueueReceiptPublished(receipt) {
        if (mixed && receipt.sourceUpdateIds[0] === 3) return;
        const source = journal.read().entries.find(entry => entry.updateId === receipt.sourceUpdateIds[0])!;
        const witness = { ...createTelegramUpdateJournalEntryDigest(source), journalBindingKey: binding.recoveryKey,
          completionSha256: (source.updateId === 1 ? "a" : "b").repeat(64) };
        witnesses.push({ ...witness });
        return [{ ...witness, ...(scenario === "origin-pending" ? { sourceSha256: pendingHash } : {}) }];
      },
      onQueueReceiptCompleted(receipt) {
        hints++;
        for (const id of receipt.sourceUpdateIds) assert.equal(journal.read().entries.some(entry => entry.updateId === id), false);
      }, recordRuntimeEvent(_category, error) { failures.push(error); },
    });
    try {
      worker.start(TEST_CONTEXT); await worker.waitForDrain(); reportTelegramQueueAdmission(carriers, receipts);
      await Promise.resolve(); await worker.waitForDrain();
      const held = scenario.startsWith("origin-") || scenario === "sticky-missing-witness";
      assert.equal(receipts.every(receipt => worker.isQueueReceiptCommitted(receipt)), !scenario.startsWith("origin-"));
      if (scenario === "sticky-missing-witness") assert.equal(worker.completeQueueReceipts({ receipts: [receipts[1]!], ctx: TEST_CONTEXT,
        reason: "prompt-handoff", sourceCompletions: [{ updateId: 3, journalBindingKey: binding.recoveryKey,
          sourceSha256: "invalid", completionSha256: "c".repeat(64) }] }), false);
      assert.equal(observations, scenario === "origin-missing" ? 0 : scenario === "batch" ? 2 : 1);
      if (scenario === "captured") {
        port.inspectQueuedReceipt = () => { assert.fail("replacement cannot lend a queued origin reader"); };
        await worker.stop(); worker.start(TEST_CONTEXT); await worker.waitForDrain();
        assert.equal(observations, 2, "reconstruction uses the captured strict origin reader");
      }
      const settlement = createTelegramQueueAdmissionSettlementMuxRuntime([createTelegramQueueAdmissionSettlementRuntime(worker)]), item = { admissionReceipts: receipts };
      const uncertain = ["lost", "before-write", "no-result", "readback", "restart-held"].includes(scenario);
      const complete = () => settlement.onPromptHandedOff(item, TEST_CONTEXT);
      assert.equal(complete(), !held && !uncertain);
      assert.equal(exact, held ? 0 : 1); assert.equal(ordinary, scenario === "mixed" ? 1 : 0);
      assert.equal(hints, held || uncertain ? 0 : receipts.length - (scenario === "mixed" ? 1 : 0));
      if (uncertain) {
        assert.equal(settlement.isItemReady(item), false, "an issued disposition, including pre-write uncertainty, never grants execution readiness");
        const originalBytes = await readFile(join(dir, "inbox.json"), "utf8");
        fault = false;
        if (scenario === "restart-held") { await worker.stop(); worker.start(TEST_CONTEXT); await worker.waitForDrain(); }
        assert.equal(complete(), scenario !== "before-write" && scenario !== "restart-held");
        assert.equal(exact, 1, "only exact retained witnesses reconcile an issued whole receipt; disposal is never retried");
        assert.equal(await readFile(join(dir, "inbox.json"), "utf8"), originalBytes);
      }
      const completed = !held && scenario !== "before-write" && scenario !== "restart-held";
      assert.equal(worker.getState().queuedClaimCount, completed ? 0 : ids.length);
      assert.equal(journal.read().entries.length, completed ? 0 : ids.length);
      assert.equal(handlerCalls, ids.length, "group observations and source reconciliation never replay Pi input");
      if (completed) {
        for (const witness of witnesses) {
          const { journalBindingKey: _binding, ...scope } = witness;
          assert.deepEqual(journal.inspectSourceCompletion(scope), scope);
        }
        for (const id of ids.filter(id => !witnesses.some(witness => witness.updateId === id))) {
          assert.equal(journal.inspectSourceCompletion({ updateId: id, sourceSha256: "f".repeat(64), completionSha256: "f".repeat(64) }), undefined);
        }
        assert.equal(settlement.isItemReady(item), false);
        assert.equal(complete(), true);
        assert.equal(exact, 1); assert.equal(ordinary, scenario === "mixed" ? 1 : 0);
        await worker.waitForDrain(); assert.equal(worker.getState().queuedClaimCount, 0);
      }
      if (held) assert.ok(failures.length > 0);
    } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const scenario of ["hold", "publisher-fails", "authority", "context", "binding", "identity", "receipt-after",
  "reader-missing", "reader-throws", "detached", "capability-snapshot", "cold", "grouped", "observer-fails"] as const) {
  test(`Queue readiness waits for prepared acceptance and exact post-await receipt authority (${scenario})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-queue-publication-"));
    const journal = createTelegramUpdateJournalStore({ path: join(dir, "inbox.json"), botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "fixture" }) });
    const ids = scenario === "grouped" ? [1, 2] : [1];
    journal.appendBatch(ids.map(id => ({ update_id: id, message: { message_id: id, chat: { id: 7, type: "private" }, text: "fixture" } })));
    const identity = { instanceId: "queue-fixture", processId: 42, processBirthId: "fixture-birth", sessionGeneration: 1 };
    let binding = "fixture-binding", authoritative = true, contextCurrent = true, receiptCurrent = true;
    const carriers: unknown[] = [], observations: unknown[] = [], events: string[] = [];
    let release!: () => void, entered!: () => void, publications = 0, inspections = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const receipt = { receiptId: "fixture-queue", queueKind: "prompt" as const, sourceUpdateIds: ids, journalBindingKey: "fixture-binding" };
    if (scenario === "cold") journal.markQueued({ ...receipt, owner: identity });
    const source = { ...journal, isQueueReceiptCurrent: scenario === "reader-missing" ? undefined :
      (expected: Parameters<NonNullable<TelegramUpdateWorkerJournalPort["isQueueReceiptCurrent"]>>[0],
        owner: TelegramUpdateJournalQueueOwner) => {
        inspections++;
        if (scenario === "reader-throws") throw new Error("Fixture receipt read refused");
        assert.equal(expected.receiptId, receipt.receiptId);
        const entries = journal.read().entries;
        return receiptCurrent && entries.length === ids.length && entries.every(entry => entry.state === "queued" &&
          entry.queueReceiptId === expected.receiptId && JSON.stringify(entry.queueOwner) === JSON.stringify(owner));
      } };
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal: source, getJournalBindingKey: () => binding, getQueueOwnerIdentity: () => identity,
      hasAuthority: () => authoritative, isContextCurrent: () => contextCurrent,
      async defaultHandle(update) { carriers.push(update.message); reportTelegramUpdateDeferred(update.message); },
      async beforeQueueReceiptPublished(expected, owner, ctx, isCurrent) {
        publications++; events.push("acceptance");
        assert.equal(ctx, TEST_CONTEXT); assert.equal(isCurrent(), true);
        assert.equal(journal.read().entries.every(entry => entry.state === "queued"), true, "admitted source is retained before dispatch readiness");
        assert.deepEqual(expected, receipt); assert.equal(owner.instanceId, identity.instanceId);
        if (scenario === "detached") { expected.sourceUpdateIds.length = 0; owner.acquisitionId = "mutated"; }
        entered(); await held;
        if (scenario === "publisher-fails") throw new Error("Fixture acceptance refused");
      },
      onQueueReceiptCommitted(expected) { events.push("ready"); observations.push(expected); if (scenario === "observer-fails") throw new Error("Fixture observer failed"); },
    });
    try {
      worker.start(TEST_CONTEXT);
      if (scenario !== "cold") { await worker.waitForDrain(); reportTelegramQueueAdmission(carriers, [receipt]); }
      if (scenario === "reader-missing" || scenario === "reader-throws") {
        await new Promise<void>(resolve => setImmediate(resolve)); await worker.waitForDrain();
        assert.equal(publications, 0);
      } else {
        await reached;
        assert.equal(worker.isQueueReceiptCommitted(receipt), false);
        assert.equal(worker.getQueueReceiptOwner(receipt), undefined);
        assert.deepEqual(observations, []);
        worker.signal();
        if (scenario === "authority") authoritative = false;
        if (scenario === "context") contextCurrent = false;
        if (scenario === "binding") binding = "another-binding";
        if (scenario === "identity") identity.sessionGeneration++;
        if (scenario === "receipt-after") receiptCurrent = false;
        if (scenario === "capability-snapshot") source.isQueueReceiptCurrent = () => { throw new Error("Replacement reader must not inherit publication"); };
        release(); await new Promise<void>(resolve => setImmediate(resolve)); await worker.waitForDrain();
        assert.equal(publications, 1, "grouped reports and snapshot refresh share one pending publication");
      }
      const positive = ["hold", "detached", "capability-snapshot", "cold", "grouped", "observer-fails"].includes(scenario);
      assert.deepEqual(events, positive ? ["acceptance", "ready"] : publications ? ["acceptance"] : []);
      assert.equal(observations.length, positive ? 1 : 0);
      assert.equal(worker.isQueueReceiptCommitted(receipt), positive);
      assert.equal(journal.read().entries.every(entry => entry.state === "queued"), true, "publication never disposes accepted queue work");
      assert.equal(carriers.length, scenario === "cold" ? 0 : ids.length, "queued originals are never semantically replayed");
      if (positive) assert.ok(inspections >= 2);
    } finally { release(); await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

for (const scenario of ["complete", "duplicate", "queued", "queued-complete", "queued-guarded", "queued-commit-fails", "publisher-fails", "missing-scope", "wrong-id", "conflicting-scope", "stopped", "detached"] as const) {
  test(`Completion acceptance carrier gates only its local report before journal disposition (${scenario})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-completion-publisher-"));
    const resolve = createTelegramUpdateJournalRuntimeBindingResolver({ getProfileName: () => undefined, getBotToken: () => "fixture",
      getBotId: () => undefined, getJournalPath: () => join(dir, "inbox.json"),
      withSourceSerialization: createTelegramJournalSourceSerialization(() => join(dir, "journals.transaction")) });
    const binding = resolve()!, journal = binding.journal;
    journal.appendBatch([{ update_id: 1, message: { message_id: 1, chat: { id: 7, type: "private" }, text: "fixture" } }]);
    const digest = createTelegramUpdateJournalEntryDigest(journal.read().entries[0]!);
    const evidence = { ...digest, journalBindingKey: binding.recoveryKey, completionSha256: "a".repeat(64) };
    let original: unknown, routed: unknown, publications = 0, removals = 0;
    const completed: number[] = [];
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({
      journal: { ...journal, markQueued(input) {
        if (scenario === "queued-commit-fails") throw new Error("Fixture queue commit failed before publication");
        return journal.markQueued(input);
      }, removeCompletedExact(ids, sources, scopes) {
        removals++; assert.equal(publications, 1, "positive caller publication precedes disposal");
        assert.deepEqual(scopes, [{ ...digest, completionSha256: "a".repeat(64) }]);
        return journal.removeCompletedExact(ids, sources, scopes);
      } }, getJournalBindingKey: () => binding.recoveryKey, hasAuthority: () => true,
      async defaultHandle(update) { original = update.message; reportTelegramUpdateDeferred(original); },
      onUpdateCompleted(id) { completed.push(id); },
    });
    try {
      worker.start(TEST_CONTEXT); await worker.waitForDrain();
      routed = bindTelegramUpdateCompletionAcceptance(original, () => {
        publications++;
        assert.equal(journal.read().entries[0]!.state, "pending");
        if (scenario === "publisher-fails") throw new Error("Fixture local publisher refused");
        return scenario === "missing-scope" ? { ...evidence, completionSha256: undefined } : scenario === "wrong-id" ? { ...evidence, updateId: 2 } : evidence;
      });
      assert.equal(getTelegramUpdateExecutionFence(routed), getTelegramUpdateExecutionFence(original));
      if (scenario === "stopped") {
        await worker.stop(); assert.equal(reportTelegramUpdateCompleted(routed), false); assert.equal(publications, 0);
      } else if (scenario === "queued" || scenario === "queued-complete" || scenario === "queued-guarded" || scenario === "queued-commit-fails") {
        reportTelegramQueueAdmission([routed], [{ receiptId: "fixture-queue", queueKind: "prompt", sourceUpdateIds: [1] }]);
        if (scenario === "queued-complete" || scenario === "queued-commit-fails") assert.equal(reportTelegramUpdateCompleted(routed), true);
        if (scenario === "queued-guarded") assert.throws(() => reportTelegramUpdateCompleted(routed, evidence), /queued source/);
        await Promise.resolve(); await worker.waitForDrain();
        if (scenario === "queued-complete") { reportTelegramUpdateCompleted(routed); reportTelegramUpdateCompleted(original); }
        assert.equal(journal.read().entries[0]!.state, scenario === "queued-commit-fails" ? "pending" : "queued"); assert.equal(publications, 0);
        if (scenario === "queued-commit-fails") assert.equal(worker.getState().phase, "blocked");
        assert.equal(removals, 0); assert.deepEqual(completed, []);
        assert.equal(journal.inspectSourceCompletion({ ...digest, completionSha256: evidence.completionSha256 }), undefined);
      } else if (["publisher-fails", "missing-scope", "wrong-id", "conflicting-scope"].includes(scenario)) {
        assert.throws(() => reportTelegramUpdateCompleted(routed, scenario === "conflicting-scope"
          ? { ...evidence, completionSha256: "f".repeat(64) } : undefined));
        assert.equal(journal.read().entries[0]!.state, "pending");
        assert.deepEqual(completed, []); assert.equal(removals, 0);
      } else {
        assert.equal(reportTelegramUpdateCompleted(routed), true);
        if (scenario === "duplicate") { reportTelegramUpdateCompleted(routed); reportTelegramUpdateCompleted(original); }
        if (scenario === "detached") evidence.completionSha256 = "f".repeat(64);
        await Promise.resolve(); await worker.waitForDrain();
        assert.deepEqual(completed, [1]); assert.equal(publications, 1); assert.equal(removals, 1);
        assert.equal(journal.read().entries.length, 0);
      }
      assert.equal(reportTelegramUpdateDeferred(original), scenario !== "stopped", "a route wrapper never mutates the shared original binding");
    } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

test("Deferred terminal settlement removes only the exact unqueued source and survives restart", async () => {
  const storage = createTestUpdateWorkerJournal([1, 2, 3]);
  let signal!: AbortSignal;
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    executeUpdate(update, _ctx, currentSignal) {
      signal = currentSignal;
      return update.update_id === 2
        ? { kind: "queued", queueKind: "prompt", receiptId: "accepted-2", sourceUpdateIds: [2] }
        : { kind: "deferred" };
    },
  });
  try {
    worker.start(TEST_CONTEXT);
    await worker.waitForDrain();
    worker.settleDeferred({ updateId: 1, signal, outcome: { kind: "complete" } });
    worker.settleDeferred({ updateId: 1, signal, outcome: { kind: "complete" } });
    worker.settleDeferred({ updateId: 2, signal, outcome: { kind: "complete" } });
    worker.settleDeferred({ updateId: 99, signal, outcome: { kind: "complete" } });
    assert.deepEqual(storage.getUpdateIds(), [2, 3]);
    assert.deepEqual(storage.getRemovals(), [[1]]);
    assert.equal(worker.getState().deferredClaimCount, 1);
    await worker.stop();
    worker.start(TEST_CONTEXT);
    await worker.waitForDrain();
    assert.deepEqual(storage.getUpdateIds(), [2, 3]);
  } finally {
    await worker.stop();
  }
});

test("Deferred terminal settlement cannot remove a source after authority loss", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  let signal!: AbortSignal;
  let owned = true;
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => owned,
    executeUpdate(_update, _ctx, currentSignal) {
      signal = currentSignal;
      return { kind: "deferred" };
    },
  });
  try {
    worker.start(TEST_CONTEXT);
    await worker.waitForDrain();
    owned = false;
    worker.settleDeferred({ updateId: 1, signal, outcome: { kind: "complete" } });
    assert.deepEqual(storage.getUpdateIds(), [1]);
    assert.deepEqual(storage.getRemovals(), []);
  } finally {
    await worker.stop();
  }
});

test("Deferred terminal settlement rejects stale generations and retains journal-write failures", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  let signal!: AbortSignal;
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal,
    hasAuthority: () => true,
    executeUpdate(_update, _ctx, currentSignal) {
      signal = currentSignal;
      return { kind: "deferred" };
    },
  });
  try {
    worker.start(TEST_CONTEXT);
    await worker.waitForDrain();
    const oldSignal = signal;
    await worker.stop();
    worker.start(TEST_CONTEXT);
    await worker.waitForDrain();
    worker.settleDeferred({ updateId: 1, signal: oldSignal, outcome: { kind: "complete" } });
    worker.settleDeferred({ updateId: 1, signal: new AbortController().signal, outcome: { kind: "complete" } });
    assert.deepEqual(storage.getUpdateIds(), [1]);
    const remove = storage.journal.removeCompleted;
    storage.journal.removeCompleted = () => { throw new Error("fixture journal write failed"); };
    worker.settleDeferred({ updateId: 1, signal, outcome: { kind: "complete" } });
    assert.deepEqual(storage.getUpdateIds(), [1]);
    assert.equal(worker.getState().deferredClaimCount, 1);
    storage.journal.removeCompleted = remove;
    worker.signal();
    await worker.waitForDrain();
    worker.settleDeferred({ updateId: 1, signal, outcome: { kind: "complete" } });
    assert.deepEqual(storage.getUpdateIds(), []);
  } finally {
    await worker.stop();
  }
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

test("Update worker retains a fresh signal across an older blocked drain result", async () => {
  const storage = createTestUpdateWorkerJournal([1]);
  let authority = false;
  const handled: number[] = [];
  const worker = createTelegramUpdateWorkerRuntime({
    journal: storage.journal, hasAuthority: () => authority,
    executeUpdate(update) { handled.push(update.update_id); return { kind: "complete" }; },
  });
  try {
    worker.start(TEST_CONTEXT);
    assert.equal(worker.getState().blockedReason, "authority-lost");
    authority = true;
    worker.signal();
    await new Promise<void>(done => setImmediate(done));
    await worker.waitForDrain();
    assert.deepEqual(handled, [1]);
    assert.deepEqual(storage.getUpdateIds(), []);
  } finally { await worker.stop(); }
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
      // This wake precedes the write failure and cannot clear its later failure latch.
      worker.signal();
      return { kind: "complete" };
    },
  });

  worker.start(TEST_CONTEXT);
  await worker.waitForDrain();
  await new Promise<void>(done => setImmediate(done));
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

for (const scenario of ["handoff", "discard", "unscoped", "unobserved", "lost-ack", "reconciled", "partial-ack", "changed-source", "changed-receipt", "changed-marker",
  "binding", "identity", "context", "stopped", "reader-before", "disposer-before", "reader-replaced", "reader-loss", "reader-throws"] as const) {
  test(`Held queue completion observes only an exact native scoped receipt ACK (${scenario})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-held-queue-completion-"));
    const identity = { instanceId: "held-queue", processId: process.pid, processBirthId: `${process.pid}:held-queue`, sessionGeneration: 1 };
    const resolve = createTelegramUpdateJournalRuntimeBindingResolver({ getProfileName: () => undefined, getBotToken: () => "fixture", getBotId: () => undefined,
      getJournalPath: () => join(dir, "inbox.json"), getQueueRuntimeIdentity: () => identity,
      withSourceSerialization: createTelegramJournalSourceSerialization(() => join(dir, "journals.transaction")) });
    const binding = resolve()!, journal = binding.journal;
    let current = true, liveBinding = binding.recoveryKey, handlers = 0, disposals = 0, probing = false, reads = 0;
    let carrier: unknown, prepared: Updates.TelegramDeferredQueueAdmissionPreparation | undefined;
    const port = { ...journal, completeQueuedExact(...args: Parameters<typeof journal.completeQueuedExact>) {
      disposals++; const result = journal.completeQueuedExact(...args);
      if (scenario === "lost-ack" || scenario === "reconciled") throw new Error("Native queue ACK lost after publication");
      return scenario === "partial-ack" ? { ...result, removedUpdateIds: [] } : result;
    }, inspectSourceCompletion(...args: Parameters<typeof journal.inspectSourceCompletion>) {
      reads++; const result = journal.inspectSourceCompletion(...args);
      if (probing && scenario === "reader-loss") current = false;
      if (probing && scenario === "reader-throws") throw new Error("Completion observation unavailable");
      return result;
    } };
    const receipt = { queueKind: "prompt" as const, receiptId: "held-queue-receipt", sourceUpdateIds: [100], journalBindingKey: binding.recoveryKey };
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate & TelegramUpdateFlow, string>({ journal: port,
      getJournalBindingKey: () => liveBinding, getQueueOwnerIdentity: () => identity, hasAuthority: () => current, isContextCurrent: () => current,
      async defaultHandle() { handlers++; assert.fail("Held commands must not replay the ordinary handler"); },
      beforeQueueReceiptPublished: scenario === "unscoped" ? undefined : () => journal.read().entries.map(entry => ({
        ...createTelegramUpdateJournalEntryDigest(entry), journalBindingKey: binding.recoveryKey, completionSha256: "a".repeat(64),
      })),
    });
    try {
      worker.start(TEST_CONTEXT); await worker.waitForDrain();
      const held = worker.prepareLiveInput!(TEST_CONTEXT, [100])!;
      journal.appendBatch([{ update_id: 100, message: { message_id: 11, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: "/continue" } }]);
      worker.signal(); await worker.waitForDrain(); assert.equal(held.confirmSaved(), true);
      const readiness = held.prepareSourceCompletion!()!;
      assert.ok(held.prepareStatusConsumption!({ source: readiness.snapshot.source, assertCurrent() {},
        bindCarrier(value) {
          carrier = value; prepared = Updates.prepareTelegramDeferredQueueAdmission(value);
          assert.ok(prepared); assert.deepEqual(inspectTelegramDeferredSource(value), readiness.snapshot.source); return true;
        }, async execute() { assert.equal(reportTelegramQueueAdmission([carrier], [receipt]), true); return true; } }));
      if (scenario === "reader-before") port.inspectSourceCompletion = () => { assert.fail("Pre-binding replacement cannot lend its reader"); };
      if (scenario === "disposer-before") port.completeQueuedExact = () => { assert.fail("Pre-binding replacement cannot lend its disposer"); };
      assert.equal(held.release(() => true), true); await worker.waitForDrain();
      for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve));
      assert.ok(prepared); assert.equal(worker.isQueueReceiptCommitted(receipt), true);
      if (scenario !== "unobserved") assert.ok(prepared.inspectReceipt(receipt));
      assert.equal(prepared.inspectCompletion(receipt), undefined, "Queue publication is not source removal");
      if (scenario === "changed-source") {
        const { exists: _exists, serializedBytes: _bytes, ...snapshot } = journal.read();
        (snapshot.entries[0]!.update.message as { text: string }).text = "/template changed";
        await writeFile(join(dir, "inbox.json"), JSON.stringify(snapshot));
      }
      const removed = worker.completeQueueReceipts({ receipts: [receipt], ctx: TEST_CONTEXT, reason: scenario === "discard" ? "discard" : "prompt-handoff" });
      assert.equal(removed, !["lost-ack", "reconciled", "partial-ack", "changed-source"].includes(scenario));
      if (scenario === "reconciled") {
        assert.equal(prepared.inspectCompletion(receipt), undefined, "Lost disposal ACK cannot be manufactured by observation");
        assert.equal(worker.completeQueueReceipts({ receipts: [receipt], ctx: TEST_CONTEXT, reason: "prompt-handoff" }), true,
          "Only the existing queued terminal owner can reconcile its issued scope without another removal");
      }
      if (scenario === "changed-receipt") receipt.sourceUpdateIds.push(101);
      if (scenario === "changed-marker") {
        const { exists: _exists, serializedBytes: _bytes, ...snapshot } = journal.read();
        snapshot.sourceCompletions![0]!.completionSha256 = "b".repeat(64);
        await writeFile(join(dir, "inbox.json"), JSON.stringify(snapshot));
      }
      if (scenario === "binding") liveBinding = "foreign";
      if (scenario === "identity") identity.sessionGeneration++;
      if (scenario === "context") current = false;
      if (scenario === "stopped") await worker.stop();
      if (scenario === "reader-replaced") port.inspectSourceCompletion = () => { assert.fail("Replacement cannot lend completion authority"); };
      const bytes = await readFile(join(dir, "inbox.json"), "utf8"), previousReads = reads;
      probing = true;
      const proof = prepared.inspectCompletion(receipt);
      assert.deepEqual(proof, ["handoff", "discard", "reconciled"].includes(scenario) ? readiness.snapshot.source : undefined);
      assert.equal(prepared.inspectCompletion({ ...receipt, sourceUpdateIds: [...receipt.sourceUpdateIds] }), undefined, "Reconstructed objects cannot borrow a native ACK");
      if (proof) { proof.sourceSha256 = "mutated"; assert.deepEqual(prepared.inspectCompletion(receipt), readiness.snapshot.source); }
      if (["binding", "identity", "context", "stopped", "reader-before", "disposer-before", "reader-replaced"].includes(scenario)) assert.equal(reads, previousReads, "Ended authority refuses before I/O");
      assert.equal(await readFile(join(dir, "inbox.json"), "utf8"), bytes, "Observation cannot write, dispose or repair the journal");
      assert.equal(disposals, scenario === "unscoped" ? 0 : 1); assert.equal(handlers, 0);
    } finally { await worker.stop(); await rm(dir, { recursive: true, force: true }); }
  });
}

test("Only an untouched, unexpired chooser clock with a recorded chooser is revivable after restart", () => {
  const chooser = { chatId: 7, threadId: 55, messageId: 501 };
  const waiting = { operatorUserId: 7, publishedAtMs: 1_000, expiresAtMs: 3_601_000, phase: "waiting" as const, chooser };
  assert.equal(Updates.isRevivableTelegramRoutingInput({ state: "pending", routingInput: waiting }, 2_000), true);
  assert.equal(Updates.isRevivableTelegramRoutingInput({ state: "pending", routingInput: { ...waiting, phase: "selected" } }, 2_000), false,
    "a saved selection may already have effects");
  assert.equal(Updates.isRevivableTelegramRoutingInput({ state: "pending", routingInput: waiting }, 3_601_000), false, "the deadline is final");
  const { chooser: _chooser, ...unlocated } = waiting;
  assert.equal(Updates.isRevivableTelegramRoutingInput({ state: "pending", routingInput: unlocated }, 2_000), false,
    "a clock without a recorded chooser has nothing to revive");
  assert.equal(Updates.isRevivableTelegramRoutingInput({ state: "queued", routingInput: waiting }, 2_000), false);
  assert.equal(Updates.isRevivableTelegramRoutingInput({ state: "pending" }, 2_000), false);
});
