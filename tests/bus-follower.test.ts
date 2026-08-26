/**
 * Regression tests for Telegram multi-instance bus follower helpers
 * Covers follower registration, forwarded update receiving, and follower-routed API calls
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTelegramBusFollowerApiCaller,
  createTelegramBusFollowerClientRuntime,
  createTelegramBusFollowerControlState,
  createTelegramBusFollowerDurableAdmissionRuntime,
  createTelegramBusFollowerHeartbeatRecoveryHandler,
  createTelegramBusFollowerRegistrationRuntime as createRawTelegramBusFollowerRegistrationRuntime,
  createTelegramBusFollowerPromotionHandler,
  createTelegramBusFollowerQueueHandoffClient,
  createTelegramBusFollowerRegistrationState,
  createTelegramBusFollowerRuntimeAssembly,
  createTelegramBusFollowerSessionRefreshHook,
  createTelegramBusFollowerSessionReplacementSuspender,
  createTelegramBusFollowerTargetReplacementHandler,
  createTelegramBusForwardedUpdateReceiverRuntime,
  createTelegramManualFollowerProfileKeyResolver,
  getTelegramFollowerSessionHandoff,
  prepareTelegramBusFollowerJournaledUpdateForExecution,
  setTelegramFollowerSessionHandoff,
} from "../lib/bus-follower.ts";
import {
  createTelegramBusFollowerDeliveryIdentity,
  createTelegramBusFollowerRegistry,
  createTelegramBusFollowerTargetController,
  createTelegramBusProtocolIdentity,
  createTelegramBusLocalServer as createRawTelegramBusLocalServer,
  resolveTelegramBusSocketPath,
  sendTelegramBusLocalEnvelope,
  TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
  TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
} from "../lib/bus.ts";
import { getTelegramBusTransportKind } from "../lib/bus-transport.ts";
import {
  createTelegramBusLeaderEnvelopeHandler as createRawTelegramBusLeaderEnvelopeHandler,
} from "../lib/bus-leader.ts";
import {
  createTelegramTopicTargetStore,
  getTelegramLeaderSessionHandoff,
  setTelegramLeaderSessionHandoff,
} from "../lib/threads.ts";
import {
  getTelegramApiErrorRequestTarget,
  isTelegramApiCommitUnknownError,
} from "../lib/telegram-api.ts";

const TEST_BUS_PROTOCOL_IDENTITY = createTelegramBusProtocolIdentity({
  runtimeBuild: "test",
  capabilities: [
    TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
    TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
  ],
});

function createTelegramBusFollowerRegistrationRuntime<TContext extends {
  cwd?: string;
}>(
  deps: Omit<
    Parameters<typeof createRawTelegramBusFollowerRegistrationRuntime<TContext>>[0],
    "protocolIdentity"
  > & {
    protocolIdentity?: Parameters<
      typeof createRawTelegramBusFollowerRegistrationRuntime<TContext>
    >[0]["protocolIdentity"];
  },
) {
  const { protocolIdentity = TEST_BUS_PROTOCOL_IDENTITY, ...ports } = deps;
  return createRawTelegramBusFollowerRegistrationRuntime({
    ...ports,
    protocolIdentity,
  });
}

function createTelegramBusLocalServer(
  deps: Parameters<typeof createRawTelegramBusLocalServer>[0],
) {
  const handleEnvelope = deps.handleEnvelope;
  return createRawTelegramBusLocalServer({
    ...deps,
    async handleEnvelope(envelope) {
      const response = await handleEnvelope(envelope);
      if (
        envelope.kind === "follower.register" &&
        response?.kind === "bus.ack" &&
        !response.protocol
      ) {
        return { ...response, protocol: TEST_BUS_PROTOCOL_IDENTITY };
      }
      return response;
    },
  });
}

function createTelegramBusLeaderEnvelopeHandler(
  deps: Omit<
    Parameters<typeof createRawTelegramBusLeaderEnvelopeHandler>[0],
    "protocolIdentity"
  > & {
    protocolIdentity?: Parameters<
      typeof createRawTelegramBusLeaderEnvelopeHandler
    >[0]["protocolIdentity"];
  },
) {
  const { protocolIdentity = TEST_BUS_PROTOCOL_IDENTITY, ...ports } = deps;
  const handle = createRawTelegramBusLeaderEnvelopeHandler({
    ...ports,
    protocolIdentity,
  });
  return (envelope: Parameters<typeof handle>[0]) =>
    handle(
      envelope.kind === "follower.register" &&
        !envelope.registration.protocol
        ? {
            ...envelope,
            registration: {
              ...envelope.registration,
              protocol: protocolIdentity,
            },
          }
        : envelope,
    );
}

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

test("Follower control state owns active auth and transient lifecycle projection", () => {
  const state = createTelegramBusFollowerControlState();
  assert.equal(state.getActiveAuthSecret(), undefined);
  assert.equal(state.getLifecyclePhase(), undefined);

  state.setActiveAuthSecret("secret");
  state.setLifecyclePhase("electing");
  assert.equal(state.getActiveAuthSecret(), "secret");
  assert.equal(state.getLifecyclePhase(), "electing");

  state.setActiveAuthSecret(undefined);
  state.setLifecyclePhase(undefined);
  assert.equal(state.getActiveAuthSecret(), undefined);
  assert.equal(state.getLifecyclePhase(), undefined);
});

test("Bus follower profile key resolver follows the active profile", () => {
  let profileName: string | undefined;
  const resolveProfileKey = createTelegramManualFollowerProfileKeyResolver({
    getActiveProfileName: () => profileName,
    manualFollowerOwnerId: "7",
  });
  assert.equal(resolveProfileKey(), "manual:7");
  profileName = "work";
  assert.equal(resolveProfileKey(), "profile:work:manual:7");
});

test("Bus follower promotion handler transfers binding only after leadership acquisition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-promotion-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const events: unknown[] = [];
  const promote = createTelegramBusFollowerPromotionHandler({
    topicTargetStore: store,
    instanceId: "inst-a",
    getActiveProfileName: () => "work",
    startLeader: async (ctx: { cwd: string }, _election, onAcquired) => {
      events.push(`acquired:${ctx.cwd}`);
      await onAcquired();
      return true;
    },
    recordRuntimeEvent: (category, message, details) => {
      events.push({ category, message, details });
    },
    getPid: () => 10,
    getNowMs: () => 500,
  });
  try {
    await promote(
      { cwd: "/repo" },
      {
        target: { chatId: 42, threadId: 11 },
        slot: "E",
        threadName: "Ember",
      },
      {},
    );
    assert.equal(store.list()[0]?.profileKey, "profile:work:cwd:/repo");
    assert.equal(store.list()[0]?.owner?.kind, "leader");
    assert.equal(events[0], "acquired:/repo");
    assert.deepEqual(events[1], {
      category: "bus",
      message: "Follower thread binding promoted to leader",
      details: {
        phase: "follower-promoted-binding",
        chatId: 42,
        threadId: 11,
        slot: "E",
        threadName: "Ember",
      },
    });
    assert.deepEqual(events[2], {
      category: "bus",
      message: "Promoted leader binding retained for session replacement",
      details: {
        phase: "follower-promoted-session-handoff",
        chatId: 42,
        threadId: 11,
        slot: "E",
        threadName: "Ember",
      },
    });
    assert.deepEqual(getTelegramLeaderSessionHandoff(), {
      pid: 10,
      instanceId: "inst-a",
      createdAtMs: 500,
      profileKey: "profile:work:cwd:/repo",
      target: { chatId: 42, threadId: 11 },
      slot: "E",
      threadName: "Ember",
    });
  } finally {
    setTelegramLeaderSessionHandoff(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower promotion leaves binding unchanged when election is lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-election-lost-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  const promote = createTelegramBusFollowerPromotionHandler({
    topicTargetStore: store,
    instanceId: "inst-a",
    getActiveProfileName: () => "work",
    startLeader: async () => false,
    recordRuntimeEvent: () => undefined,
  });
  try {
    assert.equal(
      await promote(
        { cwd: "/repo" },
        {
          target: { chatId: 42, threadId: 11 },
          slot: "E",
          threadName: "Ember",
        },
        { expectedOwner: { pid: 99 } },
      ),
      false,
    );
    assert.deepEqual(store.list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower receiver stages authenticated queue handoff payloads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-queue-handoff-receiver-"));
  const socketPath = join(dir, "follower.sock");
  const staged: unknown[] = [];
  const receiver = createTelegramBusForwardedUpdateReceiverRuntime({
    socketPath,
    instanceId: "inst-b",
    getAuthSecret: () => "secret",
    getRegistrationGeneration: () => "generation-b",
    getRecipientBindingKey: () => "manual:owner-b",
    getContext: () => "ctx",
    durableAdmission: {
      admit: async () => assert.fail("queue handoff must not enter update admission"),
    },
    handleQueueHandoff(envelope, ctx) {
      staged.push({ envelope, ctx });
      return {
      status: "staged",
      receiptId: "receipt-1",
      sourceUpdateIds: [1],
      queueOwner: {
        instanceId: "inst-b",
        processId: 20,
        processBirthId: "20:start:inst-b",
        sessionGeneration: 1,
        acquisitionId: "recipient-acquisition",
        acquiredAtMs: 1,
      },
    };
    },
  });
  const payload = {
    kind: "prompt" as const,
    chatId: 7,
    replyToMessageId: 10,
    queueOrder: 1,
    queueLane: "default" as const,
    laneOrder: 1,
    statusSummary: "handoff",
    admissionReceipts: [
      {
        queueKind: "prompt" as const,
        receiptId: "receipt-1",
        sourceUpdateIds: [1],
      },
    ],
    sourceMessageIds: [10],
    queuedAttachments: [],
    content: [{ type: "text" as const, text: "handoff prompt" }],
    historyText: "handoff",
  };
  const envelope = {
    kind: "leader.offerQueueHandoff" as const,
    requestId: "handoff:1",
    auth: "secret",
    recipientInstanceId: "inst-b",
    recipientRegistrationGeneration: "generation-b",
    donorInstanceId: "inst-a",
    donorProcessId: 101,
    donorProcessBirthId: "101:start:a",
    donorSessionGeneration: 1,
    donorAcquisitionId: "acquisition-a",
    donorAcquiredAtMs: 1000,
    handoffToken: "x".repeat(32),
    payload,
    sentAtMs: 2000,
  };
  try {
    await receiver.start();
    assert.deepEqual(
      await sendTelegramBusLocalEnvelope({ socketPath, envelope }),
      {
        kind: "bus.ack",
        requestId: "handoff:1",
        ok: true,
        message: undefined,
        result: {
          status: "staged",
          receiptId: "receipt-1",
          sourceUpdateIds: [1],
          queueOwner: {
            instanceId: "inst-b",
            processId: 20,
            processBirthId: "20:start:inst-b",
            sessionGeneration: 1,
            acquisitionId: "recipient-acquisition",
            acquiredAtMs: 1,
          },
        },
      },
    );
    assert.deepEqual(staged, [{ envelope, ctx: "ctx" }]);
    assert.deepEqual(
      await sendTelegramBusLocalEnvelope({
        socketPath,
        envelope: { ...envelope, requestId: "handoff:2", auth: "tamper" },
      }),
      {
        kind: "bus.ack",
        requestId: "handoff:2",
        ok: false,
        message: "Unauthorized Telegram bus envelope.",
      },
    );
    assert.deepEqual(
      await sendTelegramBusLocalEnvelope({
        socketPath,
        envelope: {
          ...envelope,
          requestId: "handoff:3",
          recipientRegistrationGeneration: "stale",
        },
      }),
      {
        kind: "bus.ack",
        requestId: "handoff:3",
        ok: false,
        message: "Stale Telegram bus follower registration generation.",
      },
    );
    assert.equal(staged.length, 1);
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower receiver handles leader-forwarded updates and target replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-forward-"));
  const leaderSocketPath = join(dir, "leader.sock");
  const followerSocketPath = join(dir, "follower.sock");
  const registry = createTelegramBusFollowerRegistry();
  const received: unknown[] = [];
  let nowMs = 2000;
  const delivery = (
    kind:
      | "leader.forwardCallback"
      | "leader.forwardReaction"
      | "leader.forwardMessage"
      | "leader.forwardEditedMessage",
    sourceUpdateId: number,
  ) =>
    createTelegramBusFollowerDeliveryIdentity({
      kind,
      recipientBindingKey: "manual:owner-b",
      sourceUpdateId,
    });
  const receiver = createTelegramBusForwardedUpdateReceiverRuntime({
    socketPath: followerSocketPath,
    instanceId: "inst-b",
    getRegistrationGeneration: () => "generation-b",
    getRecipientBindingKey: () => "manual:owner-b",
    getContext() {
      return "ctx";
    },
    durableAdmission: {
      async admit(envelope, ctx) {
        if (envelope.kind === "leader.forwardCallback") {
          received.push({ kind: "callback", query: envelope.query, ctx });
        } else if (envelope.kind === "leader.forwardReaction") {
          received.push({
            kind: "reaction",
            reactionUpdate: envelope.reactionUpdate,
            ctx,
          });
        } else if (envelope.kind === "leader.forwardMessage") {
          received.push({ kind: "message", message: envelope.message, ctx });
        } else {
          received.push({
            kind: "edited-message",
            message: envelope.message,
            ctx,
          });
        }
        return {
          deliveryId: envelope.delivery!.deliveryId,
          sourceUpdateId: envelope.delivery!.sourceUpdateId,
        };
      },
    },
    handleReplaceTarget(input, ctx) {
      received.push({ kind: "replace-target", input, ctx });
    },
  });
  const leader = createTelegramBusLocalServer({
    socketPath: leaderSocketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      getNowMs: () => nowMs,
    }),
  });
  try {
    await receiver.start();
    await leader.start();
    registry.register({
      instanceId: "inst-b",
      busSocketPath: followerSocketPath,
      registrationGeneration: "generation-b",
      connectedAtMs: 1000,
    });
    const callbackResponse = await sendTelegramBusLocalEnvelope({
      socketPath: leaderSocketPath,
      envelope: {
        kind: "leader.forwardCallback",
        requestId: "leader:1",
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "generation-b",
        delivery: delivery("leader.forwardCallback", 1),
        query: { id: "cb-1", data: "queue:pause" },
        sentAtMs: 2000,
      },
    });
    assert.equal(registry.get("inst-b")?.lastHeartbeatMs, 2000);
    nowMs = 3000;
    const reactionResponse = await sendTelegramBusLocalEnvelope({
      socketPath: leaderSocketPath,
      envelope: {
        kind: "leader.forwardReaction",
        requestId: "leader:2",
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "generation-b",
        delivery: delivery("leader.forwardReaction", 2),
        reactionUpdate: { message_id: 9, new_reaction: [] },
        sentAtMs: 3000,
      },
    });
    assert.equal(registry.get("inst-b")?.lastHeartbeatMs, 3000);
    nowMs = 4000;
    const messageResponse = await sendTelegramBusLocalEnvelope({
      socketPath: leaderSocketPath,
      envelope: {
        kind: "leader.forwardMessage",
        requestId: "leader:3",
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "generation-b",
        delivery: delivery("leader.forwardMessage", 3),
        message: { message_id: 10, text: "hi" },
        sentAtMs: 4000,
      },
    });
    assert.equal(registry.get("inst-b")?.lastHeartbeatMs, 4000);
    nowMs = 5000;
    const editedMessageResponse = await sendTelegramBusLocalEnvelope({
      socketPath: leaderSocketPath,
      envelope: {
        kind: "leader.forwardEditedMessage",
        requestId: "leader:4",
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "generation-b",
        delivery: delivery("leader.forwardEditedMessage", 4),
        message: { message_id: 10, text: "edited" },
        sentAtMs: 5000,
      },
    });
    const targetController = createTelegramBusFollowerTargetController({
      socketPath: followerSocketPath,
      createRequestId: () => "leader:5",
      getNowMs: () => 6000,
    });
    const replaceTargetResponse = await targetController.replaceTarget({
      follower: registry.get("inst-b")!,
      target: { chatId: 7, threadId: 42 },
      oldTarget: { chatId: 7, threadId: 10 },
      reason: "thread-restore",
    });
    assert.deepEqual(callbackResponse, {
      kind: "bus.ack",
      requestId: "leader:1",
      ok: true,
      message: undefined,
      result: {
        deliveryId: delivery("leader.forwardCallback", 1).deliveryId,
        sourceUpdateId: 1,
      },
    });
    assert.deepEqual(reactionResponse, {
      kind: "bus.ack",
      requestId: "leader:2",
      ok: true,
      message: undefined,
      result: {
        deliveryId: delivery("leader.forwardReaction", 2).deliveryId,
        sourceUpdateId: 2,
      },
    });
    assert.deepEqual(messageResponse, {
      kind: "bus.ack",
      requestId: "leader:3",
      ok: true,
      message: undefined,
      result: {
        deliveryId: delivery("leader.forwardMessage", 3).deliveryId,
        sourceUpdateId: 3,
      },
    });
    assert.deepEqual(editedMessageResponse, {
      kind: "bus.ack",
      requestId: "leader:4",
      ok: true,
      message: undefined,
      result: {
        deliveryId: delivery("leader.forwardEditedMessage", 4).deliveryId,
        sourceUpdateId: 4,
      },
    });
    assert.equal(replaceTargetResponse, true);
    assert.equal(registry.get("inst-b")?.lastHeartbeatMs, 5000);
    assert.deepEqual(received, [
      {
        kind: "callback",
        query: { id: "cb-1", data: "queue:pause" },
        ctx: "ctx",
      },
      {
        kind: "reaction",
        reactionUpdate: { message_id: 9, new_reaction: [] },
        ctx: "ctx",
      },
      { kind: "message", message: { message_id: 10, text: "hi" }, ctx: "ctx" },
      {
        kind: "edited-message",
        message: { message_id: 10, text: "edited" },
        ctx: "ctx",
      },
      {
        kind: "replace-target",
        input: {
          target: { chatId: 7, threadId: 42 },
          oldTarget: { chatId: 7, threadId: 10 },
          reason: "thread-restore",
        },
        ctx: "ctx",
      },
    ]);
  } finally {
    await leader.stop();
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower receiver rejects delayed work from a replaced registration generation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-forward-generation-"));
  const socketPath = join(dir, "follower.sock");
  let handled = 0;
  const receiver = createTelegramBusForwardedUpdateReceiverRuntime({
    socketPath,
    instanceId: "inst-b",
    getRegistrationGeneration: () => "generation-new",
    getRecipientBindingKey: () => "manual:owner-b",
    getContext: () => "ctx",
    durableAdmission: {
      async admit(envelope) {
        handled += 1;
        return {
          deliveryId: envelope.delivery!.deliveryId,
          sourceUpdateId: envelope.delivery!.sourceUpdateId,
        };
      },
    },
  });
  try {
    await receiver.start();
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "leader.forwardCallback",
        requestId: "leader:old:1",
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "generation-old",
        delivery: createTelegramBusFollowerDeliveryIdentity({
          kind: "leader.forwardCallback",
          recipientBindingKey: "manual:owner-b",
          sourceUpdateId: 1,
        }),
        query: { id: "old", pi_telegram_source_update_id: 1 },
        sentAtMs: 2000,
      },
    });
    assert.equal(handled, 0);
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "leader:old:1",
      ok: false,
      message: "Stale Telegram bus follower registration generation.",
    });
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower receiver ACKs durable append before downstream execution and deduplicates replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-durable-admission-"));
  const socketPath = join(dir, "follower.sock");
  const admitted = new Set<number>();
  const journaled: unknown[] = [];
  let signals = 0;
  const durableAdmission = createTelegramBusFollowerDurableAdmissionRuntime({
    journal: {
      appendBatch(updates) {
        const updateId = updates[0]!.update_id;
        if (!admitted.has(updateId)) journaled.push(...updates);
        admitted.add(updateId);
      },
    },
    signalWorker() {
      signals += 1;
    },
  });
  const receiver = createTelegramBusForwardedUpdateReceiverRuntime({
    socketPath,
    instanceId: "inst-b",
    getRegistrationGeneration: () => "generation-b",
    getRecipientBindingKey: () => "manual:owner-b",
    durableAdmission,
    getContext: () => "ctx",
  });
  const delivery = createTelegramBusFollowerDeliveryIdentity({
    kind: "leader.forwardCallback",
    recipientBindingKey: "manual:owner-b",
    sourceUpdateId: 44,
  });
  const send = (requestId: string) =>
    sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "leader.forwardCallback",
        requestId,
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "generation-b",
        delivery,
        query: { id: "callback", pi_telegram_source_update_id: 44 },
        sentAtMs: 2000,
      },
    });
  try {
    await receiver.start();
    assert.deepEqual(await send("leader:1"), {
      kind: "bus.ack",
      requestId: "leader:1",
      ok: true,
      message: undefined,
      result: {
        deliveryId: delivery.deliveryId,
        sourceUpdateId: 44,
      },
    });
    assert.deepEqual(await send("leader:2"), {
      kind: "bus.ack",
      requestId: "leader:2",
      ok: true,
      message: undefined,
      result: {
        deliveryId: delivery.deliveryId,
        sourceUpdateId: 44,
      },
    });
    assert.deepEqual(journaled, [
      {
        update_id: 44,
        callback_query: {
          id: "callback",
          pi_telegram_source_update_id: 44,
        },
      },
    ]);
    assert.equal(signals, 2);
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Follower replay restores persisted forward grouping metadata without exposing it", () => {
  const prepared: unknown[] = [];
  const journaled = {
    update_id: 45,
    pi_telegram_forward_comment_batch_position: "forward",
    message: { message_id: 9 },
  };
  const update = prepareTelegramBusFollowerJournaledUpdateForExecution(
    journaled,
    (message, position) => prepared.push({ message, position }),
  );
  assert.deepEqual(prepared, [
    { message: { message_id: 9 }, position: "forward" },
  ]);
  assert.deepEqual(update, {
    update_id: 45,
    message: { message_id: 9 },
  });
  assert.equal(
    "pi_telegram_forward_comment_batch_position" in journaled,
    true,
  );
});

test("Bus follower receiver rejects a mismatched durable delivery binding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-delivery-binding-"));
  const socketPath = join(dir, "follower.sock");
  let handled = 0;
  const receiver = createTelegramBusForwardedUpdateReceiverRuntime({
    socketPath,
    instanceId: "inst-b",
    getRegistrationGeneration: () => "generation-b",
    getRecipientBindingKey: () => "manual:owner-b",
    getContext: () => "ctx",
    durableAdmission: {
      async admit(envelope) {
        handled += 1;
        return {
          deliveryId: envelope.delivery!.deliveryId,
          sourceUpdateId: envelope.delivery!.sourceUpdateId,
        };
      },
    },
  });
  try {
    await receiver.start();
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "leader.forwardCallback",
        requestId: "leader:1",
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "generation-b",
        delivery: createTelegramBusFollowerDeliveryIdentity({
          kind: "leader.forwardCallback",
          recipientBindingKey: "manual:other-owner",
          sourceUpdateId: 44,
        }),
        query: { id: "callback" },
        sentAtMs: 2000,
      },
    });
    assert.equal(handled, 0);
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "leader:1",
      ok: false,
      message: "Mismatched Telegram follower delivery identity.",
    });
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower receiver rejects journal admission failure without a receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-admission-failure-"));
  const socketPath = join(dir, "follower.sock");
  const receiver = createTelegramBusForwardedUpdateReceiverRuntime({
    socketPath,
    instanceId: "inst-b",
    getRegistrationGeneration: () => "generation-b",
    getRecipientBindingKey: () => "manual:owner-b",
    getContext: () => "ctx",
    durableAdmission: {
      async admit() {
        throw new Error("Telegram inbound journal capacity exceeded.");
      },
    },
  });
  try {
    await receiver.start();
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "leader.forwardCallback",
        requestId: "leader:1",
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "generation-b",
        delivery: createTelegramBusFollowerDeliveryIdentity({
          kind: "leader.forwardCallback",
          recipientBindingKey: "manual:owner-b",
          sourceUpdateId: 44,
        }),
        query: {
          id: "callback",
          pi_telegram_source_update_id: 44,
        },
        sentAtMs: 2000,
      },
    });
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "leader:1",
      ok: false,
      message: "Telegram inbound journal capacity exceeded.",
    });
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower heartbeat recovery passes current binding into promotion", async () => {
  const promoted: unknown[] = [];
  let leaderStateCalls = 0;
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(
    true,
    { chatId: 42, threadId: 10 },
    {
      slot: "F",
      threadName: "Fjord",
    },
  );
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async () => false,
      setContext: () => undefined,
      stop: () => undefined,
    }),
    getLeaderState: () => {
      leaderStateCalls += 1;
      return leaderStateCalls === 1
        ? { kind: "active-elsewhere", lock: { pid: 99 } }
        : { kind: "inactive" };
    },
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async (_ctx, binding) => {
      promoted.push(binding);
      return true;
    },
    sleep: async () => undefined,
    promotionGraceMs: 0,
    recordRuntimeEvent: () => undefined,
  });

  await handler(new Error("heartbeat failed"), "ctx");

  assert.deepEqual(promoted, [
    { target: { chatId: 42, threadId: 10 }, slot: "F", threadName: "Fjord" },
  ]);
});

test("Bus follower election defers a higher slot to the lowest live candidate", async () => {
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(
    true,
    { chatId: 42, threadId: 10 },
    { slot: "D", threadName: "Dawn" },
  );
  registrationState.setEligibleElectionSlots(["D", "C"]);
  let state: "inactive" | "winner" = "inactive";
  let promoted = 0;
  let registered = 0;
  const events: Array<Record<string, unknown> | undefined> = [];
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async () => {
        registered += 1;
        return true;
      },
      setContext: () => undefined,
      stop: () => registrationState.setRegistered(false),
    }),
    getLeaderState: () =>
      state === "inactive"
        ? { kind: "inactive" }
        : {
            kind: "active-elsewhere",
            lock: { pid: 99, instanceId: "slot-c", leaderEpoch: "epoch-c" },
          },
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async () => {
      promoted += 1;
      return true;
    },
    sleep: async () => {
      state = "winner";
    },
    promotionGraceMs: 2500,
    recordRuntimeEvent: (_category, _message, details) => {
      events.push(details);
    },
  });

  await handler(new Error("leader disconnected"), "ctx");

  assert.equal(promoted, 0);
  assert.equal(registered, 1);
  assert.equal(
    events.some(
      (details) =>
        details?.phase === "follower-promotion-slot-priority" &&
        details.lowerEligibleSlot === "C",
    ),
    true,
  );
});

test("Bus follower heartbeat recovery never promotes over a live leader lease", async () => {
  const promoted: unknown[] = [];
  const phases: Array<string | undefined> = [];
  const events: Array<{ message: unknown; phase?: unknown }> = [];
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 });
  const liveLeader = {
    kind: "active-elsewhere" as const,
    lock: {
      pid: 99,
      instanceId: "leader-a",
      leaderEpoch: "epoch-a",
    },
  };
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async () => false,
      setContext: () => undefined,
      stop: () => undefined,
    }),
    getLeaderState: () => liveLeader,
    setLifecyclePhase: (phase) => {
      phases.push(phase);
    },
    updateStatus: () => undefined,
    promoteToLeader: async (_ctx, binding) => {
      promoted.push(binding);
      return true;
    },
    sleep: async () => undefined,
    promotionGraceMs: 0,
    recordRuntimeEvent: (_category, message, details) => {
      events.push({ message, phase: details?.phase });
    },
  });

  await handler(new Error("heartbeat failed"), "ctx");

  assert.deepEqual(promoted, []);
  assert.equal(phases.at(-1), undefined);
  assert.equal(
    events.some(
      (event) => event.phase === "follower-promotion-live-owner",
    ),
    true,
  );
});

test("Bus follower heartbeat recovery retries until a live lease becomes stale", async () => {
  let stateReadCount = 0;
  let scheduledRetry: (() => void) | undefined;
  let resolvePromoted: (() => void) | undefined;
  const promoted = new Promise<void>((resolve) => {
    resolvePromoted = resolve;
  });
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(
    true,
    { chatId: 42, threadId: 10 },
    { slot: "F", threadName: "Fjord" },
  );
  const liveLock = {
    pid: 99,
    instanceId: "leader-a",
    leaderEpoch: "epoch-a",
  };
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async () => false,
      setContext: () => undefined,
      stop: () => undefined,
    }),
    getLeaderState: () => {
      stateReadCount += 1;
      return stateReadCount <= 2
        ? { kind: "active-elsewhere", lock: liveLock }
        : { kind: "stale", lock: liveLock };
    },
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async (_ctx, binding, election) => {
      assert.deepEqual(binding, {
        target: { chatId: 42, threadId: 10 },
        slot: "F",
        threadName: "Fjord",
      });
      assert.deepEqual(election, { expectedOwner: liveLock });
      resolvePromoted?.();
      return true;
    },
    sleep: async () => undefined,
    scheduleRetry: (retry) => {
      scheduledRetry = retry;
    },
    getActiveContext: () => "ctx",
    promotionGraceMs: 0,
    recordRuntimeEvent: () => undefined,
  });

  await handler(new Error("heartbeat failed"), "ctx");
  assert.ok(scheduledRetry);
  scheduledRetry();
  await promoted;
});

test("Bus follower election loser schedules re-registration with the winner", async () => {
  const scheduled: Array<() => void> = [];
  let registrationCalls = 0;
  let promotionCalls = 0;
  let registrationTarget: unknown;
  let resolveRegistered: (() => void) | undefined;
  const registered = new Promise<void>((resolve) => {
    resolveRegistered = resolve;
  });
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 });
  const staleLock = { pid: 99, leaderEpoch: "old-epoch" };
  const winnerLock = { pid: 100, leaderEpoch: "winner-epoch" };
  let state: "stale" | "winner" = "stale";
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async (_ctx, _leader, options) => {
        registrationCalls += 1;
        registrationTarget = options?.target;
        resolveRegistered?.();
        return true;
      },
      setContext: () => undefined,
      stop: () => {
        registrationState.setRegistered(false);
      },
    }),
    getLeaderState: () =>
      state === "stale"
        ? { kind: "stale", lock: staleLock }
        : { kind: "active-elsewhere", lock: winnerLock },
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async () => {
      promotionCalls += 1;
      state = "winner";
      return false;
    },
    sleep: async () => undefined,
    scheduleRetry: (retry) => {
      scheduled.push(retry);
    },
    getActiveContext: () => "ctx",
    promotionGraceMs: 0,
    recordRuntimeEvent: () => undefined,
  });

  await handler(new Error("heartbeat failed"), "ctx");
  assert.equal(promotionCalls, 1);
  assert.equal(scheduled.length, 1);
  scheduled.shift()?.();
  await registered;
  assert.equal(registrationCalls, 1);
  assert.deepEqual(registrationTarget, { chatId: 42, threadId: 10 });
});

test("Bus follower scheduled recovery transfers across session context replacement", async () => {
  const scheduled: Array<() => void> = [];
  let activeContext: string | undefined = "old-ctx";
  let stateReads = 0;
  let promotedContext: string | undefined;
  let resolvePromoted: (() => void) | undefined;
  const promoted = new Promise<void>((resolve) => {
    resolvePromoted = resolve;
  });
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 });
  const lock = { pid: 99, leaderEpoch: "epoch-a" };
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async () => false,
      setContext: () => undefined,
      stop: () => undefined,
    }),
    getLeaderState: () => {
      stateReads += 1;
      return stateReads <= 2
        ? { kind: "active-elsewhere", lock }
        : { kind: "stale", lock };
    },
    setLifecyclePhase: () => undefined,
    updateStatus: () => undefined,
    promoteToLeader: async (ctx) => {
      promotedContext = ctx;
      resolvePromoted?.();
      return true;
    },
    sleep: async () => undefined,
    scheduleRetry: (retry) => {
      scheduled.push(retry);
    },
    getActiveContext: () => activeContext,
    promotionGraceMs: 0,
    recordRuntimeEvent: () => undefined,
  });

  await handler(new Error("heartbeat failed"), "old-ctx");
  activeContext = undefined;
  scheduled.shift()?.();
  assert.equal(scheduled.length, 1);
  activeContext = "new-ctx";
  scheduled.shift()?.();
  await promoted;
  assert.equal(promotedContext, "new-ctx");
});

test("Bus follower heartbeat recovery swallows stale-context status updates", async () => {
  const events: unknown[] = [];
  let leaderStateCalls = 0;
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 });
  const handler = createTelegramBusFollowerHeartbeatRecoveryHandler({
    registrationState,
    getRegistrationRuntime: () => ({
      registerWithLeader: async () => false,
      setContext: () => undefined,
      stop: () => undefined,
    }),
    getLeaderState: () => {
      leaderStateCalls += 1;
      return leaderStateCalls === 1
        ? { kind: "active-elsewhere", lock: { pid: 99 } }
        : { kind: "inactive" };
    },
    setLifecyclePhase: () => undefined,
    updateStatus: () => {
      throw new Error("This extension ctx is stale after session replacement");
    },
    promoteToLeader: async () => true,
    sleep: async () => undefined,
    promotionGraceMs: 0,
    recordRuntimeEvent: (category, error, details) => {
      events.push({ category, error, details });
    },
  });

  await handler(new Error("heartbeat failed"), "stale-ctx");

  assert.equal(registrationState.getTarget(), undefined);
  assert.equal(
    events.some(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as { details?: { phase?: string } }).details?.phase ===
          "follower-stale-context-status",
    ),
    true,
  );
});

test("Bus follower target replacement handler persists restored target", async () => {
  const staleTargets: unknown[] = [];
  const upserts: unknown[] = [];
  let persisted = false;
  let updated = false;
  let syncState = {};
  const events: unknown[] = [];
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 });
  const handler = createTelegramBusFollowerTargetReplacementHandler({
    topicTargetStore: {
      load: async () => undefined,
      list: () => [
        {
          profileKey: "manual:old",
          owner: { kind: "manual-follower", instanceId: "old" },
          instanceId: "inst-a",
          target: { chatId: 42, threadId: 10 },
          status: "active",
          createdAtMs: 1000,
          updatedAtMs: 1000,
          slot: "E",
          threadName: "Ember",
        },
      ],
      markStaleByTarget: (target) => {
        staleTargets.push(target);
        return true;
      },
      upsert: (record) => {
        upserts.push(record);
        return record;
      },
      persist: async () => {
        persisted = true;
      },
    },
    registrationState,
    instanceId: "inst-a",
    getManualFollowerProfileKey: () => "manual:new",
    manualFollowerOwnerId: "new",
    getSyncState: () => syncState,
    setSyncState: (state) => {
      syncState = state;
    },
    getNowMs: () => 2000,
    updateStatus: () => {
      updated = true;
    },
    recordRuntimeEvent: (_category, message, details) => {
      events.push({ message, details });
    },
  });
  await handler(
    {
      target: { chatId: 42, threadId: 11 },
      oldTarget: { chatId: 42, threadId: 10 },
      reason: "thread-restore",
    },
    "ctx",
  );
  assert.deepEqual(staleTargets, [{ chatId: 42, threadId: 10 }]);
  assert.equal(registrationState.getTarget()?.threadId, 11);
  assert.equal(persisted, true);
  assert.equal(updated, true);
  assert.deepEqual(syncState, {
    "target-bindings": {
      status: "fresh",
      updatedAtMs: 2000,
      lastReconcileAction: "follower-thread-restore",
    },
  });
  assert.deepEqual(upserts, [
    {
      profileKey: "manual:old",
      owner: { kind: "manual-follower", instanceId: "new" },
      target: { chatId: 42, threadId: 11 },
      status: "active",
      syncStatus: "open",
      createdAtMs: 1000,
      updatedAtMs: 2000,
      lastSyncObservedAtMs: 2000,
      lastReconcileAction: "follower-thread-restore",
      instanceId: "inst-a",
      slot: "E",
      threadName: "Ember",
      rerouteConfirmedAtMs: 2000,
    },
  ]);
  assert.deepEqual(events, [
    {
      message: "Telegram follower thread target replaced",
      details: {
        phase: "follower-thread-restore",
        chatId: 42,
        threadId: 11,
        oldThreadId: 10,
        slot: "E",
      },
    },
  ]);
});

test("Bus follower target replacement resolves named-profile fallback at call time", async () => {
  let activeProfileKey = "manual:default";
  const upserts: Array<{ profileKey: string }> = [];
  const registrationState = createTelegramBusFollowerRegistrationState();
  const handler = createTelegramBusFollowerTargetReplacementHandler({
    topicTargetStore: {
      load: async () => undefined,
      list: () => [],
      markStaleByTarget: () => false,
      upsert: (record) => {
        upserts.push(record);
        return record;
      },
      persist: async () => undefined,
    },
    registrationState,
    instanceId: "inst-a",
    getManualFollowerProfileKey: () => activeProfileKey,
    manualFollowerOwnerId: "owner-a",
    getSyncState: () => ({}),
    setSyncState: () => undefined,
    getNowMs: () => 2000,
    updateStatus: () => undefined,
  });
  activeProfileKey = "profile:work:manual-follower:owner-a";
  await handler(
    {
      target: { chatId: 42, threadId: 11 },
      reason: "thread-restore",
    },
    "ctx",
  );
  assert.equal(upserts[0]?.profileKey, "profile:work:manual-follower:owner-a");
});

test("Bus follower assembly wires receiver, recovery, and registration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-assembly-"));
  const leaderSocketPath = join(dir, "leader.sock");
  const followerSocketPath = join(dir, "follower.sock");
  const registrationState = createTelegramBusFollowerRegistrationState();
  let requestSequence = 0;
  const leader = createTelegramBusLocalServer({
    socketPath: leaderSocketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: createTelegramBusFollowerRegistry(),
      protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
      provisionFollowerTarget: () => ({ chatId: 7, threadId: 42 }),
    }),
  });
  const assembly = createTelegramBusFollowerRuntimeAssembly<{
    cwd: string;
  }>({
    instanceId: "inst-a",
    registrationState,
    recordRuntimeEvent: () => undefined,
    receiver: {
      socketPath: followerSocketPath,
      getContext: () => ({ cwd: "/repo" }),
      getRecipientBindingKey: () => "manual:inst-a",
      durableAdmission: {
        async admit(envelope) {
          return {
            deliveryId: envelope.delivery!.deliveryId,
            sourceUpdateId: envelope.delivery!.sourceUpdateId,
          };
        },
      },
    },
    targetReplacement: {
      topicTargetStore: {
        load: async () => undefined,
        list: () => [],
        markStaleByTarget: () => false,
        upsert: (record) => record,
        persist: async () => undefined,
      },
      getManualFollowerProfileKey: () => "manual:a",
      manualFollowerOwnerId: "a",
      getSyncState: () => ({}),
      setSyncState: () => undefined,
      updateStatus: () => undefined,
    },
    recovery: {
      getLeaderState: () => ({ kind: "inactive" }),
      setLifecyclePhase: () => undefined,
      updateStatus: () => undefined,
      promoteToLeader: async () => true,
      sleep: async () => undefined,
      promotionGraceMs: 1,
    },
    registration: {
      protocolIdentity: TEST_BUS_PROTOCOL_IDENTITY,
      getFollowerBusSocketPath: () => followerSocketPath,
      getLeaderSocketPath: () => leaderSocketPath,
      createRequestId: () => `inst-a:${++requestSequence}`,
    },
  });
  try {
    await leader.start();
    assert.equal(
      await assembly.registration.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: leaderSocketPath },
      ),
      true,
    );
    if (process.platform === "win32") {
      assert.equal(
        getTelegramBusTransportKind(
          resolveTelegramBusSocketPath(followerSocketPath),
        ),
        "pipe",
      );
    } else {
      assert.equal(
        existsSync(resolveTelegramBusSocketPath(followerSocketPath)),
        true,
      );
    }
    assert.deepEqual(registrationState.getTarget(), {
      chatId: 7,
      threadId: 42,
    });
  } finally {
    assembly.registration.stop();
    await assembly.receiver.stop();
    await leader.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration state tracks successful registration and stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-state-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const availability: boolean[] = [];
  let state: ReturnType<typeof createTelegramBusFollowerRegistrationState>;
  state = createTelegramBusFollowerRegistrationState({
    onAvailabilityChanged: () => availability.push(state.isRegistered()),
  });
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      provisionFollowerTarget() {
        return {
          chatId: -1007,
          threadId: 42,
          slot: "E",
          threadName: "Ember",
        };
      },
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    getNowMs: () => 1000,
    registrationState: state,
  });
  try {
    await server.start();
    assert.equal(state.isRegistered(), false);
    assert.equal(state.getTarget(), undefined);
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    assert.equal(state.isRegistered(), true);
    assert.deepEqual(state.getTarget(), { chatId: -1007, threadId: 42 });
    assert.equal(state.getSlot(), "E");
    assert.equal(state.getThreadName(), "Ember");
    follower.stop();
    assert.equal(state.isRegistered(), false);
    assert.equal(state.getTarget(), undefined);
    assert.equal(state.getSlot(), undefined);
    assert.equal(state.getThreadName(), undefined);
    assert.deepEqual(availability, [true, false]);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower re-registration carries its last known target", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-follower-reload-target-"),
  );
  const socketPath = join(dir, "bus.sock");
  const state = createTelegramBusFollowerRegistrationState();
  const registrations: Array<{
    target?: unknown;
    slot?: string;
    threadName?: string;
  }> = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: createTelegramBusFollowerRegistry(),
      provisionFollowerTarget(registration) {
        registrations.push({
          target: registration.target,
          slot: registration.slot,
          threadName: registration.threadName,
        });
        return {
          chatId: 7,
          threadId: 42,
          slot: "E",
          threadName: "Ember",
        };
      },
    }),
  });
  let requestSequence = 0;
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => `inst-a:reload:${++requestSequence}`,
    registrationState: state,
  });
  try {
    await server.start();
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    state.setRegistered(false);
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    assert.deepEqual(registrations, [
      { target: undefined, slot: undefined, threadName: "repo" },
      {
        target: { chatId: 7, threadId: 42 },
        slot: "E",
        threadName: "Ember",
      },
    ]);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime retries while leader endpoint is starting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-retry-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const state = createTelegramBusFollowerRegistrationState();
  const events: Array<Record<string, unknown> | undefined> = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      provisionFollowerTarget() {
        return { chatId: -1007, threadId: 42 };
      },
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    getNowMs: () => 1000,
    registrationState: state,
    registrationTimeoutMs: 50,
    registrationRetryAttempts: 10,
    registrationRetryDelayMs: 10,
    recordRuntimeEvent(_category, _error, details) {
      events.push(details);
    },
  });
  try {
    setTimeout(() => {
      void server.start();
    }, 25);
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    assert.equal(state.isRegistered(), true);
    assert.deepEqual(state.getTarget(), { chatId: -1007, threadId: 42 });
    assert.equal(
      events.some((event) => event?.phase === "follower-register-client-retry"),
      true,
    );
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime waits for slow target provisioning", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-slow-register-"),
  );
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const state = createTelegramBusFollowerRegistrationState();
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      async provisionFollowerTarget() {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { chatId: -1007, threadId: 42 };
      },
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    getNowMs: () => 1000,
    registrationState: state,
    timeoutMs: 20,
    registrationTimeoutMs: 250,
  });
  try {
    await server.start();
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    assert.equal(state.isRegistered(), true);
    assert.deepEqual(state.getTarget(), { chatId: -1007, threadId: 42 });
    assert.deepEqual(registry.get("inst-a")?.target, {
      chatId: -1007,
      threadId: 42,
    });
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime registers and explicitly disconnects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const leaderProtocol = createTelegramBusProtocolIdentity({
    runtimeBuild: "0.28.0",
  });
  const followerProtocol = createTelegramBusProtocolIdentity({
    runtimeBuild: "0.28.1",
  });
  const registrationState = createTelegramBusFollowerRegistrationState();
  let disconnects = 0;
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      protocolIdentity: leaderProtocol,
      getNowMs: () => 1000,
      onFollowerDisconnected() {
        disconnects += 1;
      },
    }),
  });
  let sequence = 0;
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => `inst-a:${++sequence}`,
    protocolIdentity: followerProtocol,
    registrationState,
    getNowMs: () => 1000,
    getPid: () => 123,
    getProcessBirthId: () => "123:start:abc",
    getSessionGeneration: () => 4,
  });
  try {
    await server.start();
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    assert.deepEqual(registry.get("inst-a"), {
      instanceId: "inst-a",
      profileKey: "cwd:/repo",
      threadName: "repo",
      cwd: "/repo",
      pid: 123,
      processBirthId: "123:start:abc",
      sessionGeneration: 4,
      registrationGeneration: "inst-a:1",
      protocol: followerProtocol,
      connectedAtMs: 1000,
      lastHeartbeatMs: 1000,
      target: undefined,
    });
    assert.deepEqual(registrationState.getLeaderProtocol(), leaderProtocol);
    assert.equal(await follower.disconnectFromLeader?.(), true);
    assert.equal(disconnects, 1);
    assert.equal(registry.get("inst-a"), undefined);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower rejects an acknowledgement without protocol identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-protocol-"));
  const socketPath = join(dir, "bus.sock");
  const server = createRawTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
    }),
  });
  const state = createTelegramBusFollowerRegistrationState();
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    protocolIdentity: createTelegramBusProtocolIdentity({
      runtimeBuild: "0.28.0",
    }),
    registrationState: state,
    getNowMs: () => 1000,
  });
  try {
    await server.start();
    await assert.rejects(
      follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      /missing-identity/u,
    );
    assert.equal(state.isRegistered(), false);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower rejects a leader without its required durable capability", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-capability-"));
  const socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
      protocol: createTelegramBusProtocolIdentity({ runtimeBuild: "0.28.0" }),
    }),
  });
  const state = createTelegramBusFollowerRegistrationState();
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    protocolIdentity: createTelegramBusProtocolIdentity({
      runtimeBuild: "0.28.0",
      capabilities: [TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION],
    }),
    registrationState: state,
  });
  try {
    await server.start();
    await assert.rejects(
      follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      /missing-capability/u,
    );
    assert.equal(state.isRegistered(), false);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime accepts explicit manual profile keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-profile-"));
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    getNowMs: () => 1000,
    getProfileKey: () => "manual:inst-a",
  });
  try {
    await server.start();
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    assert.equal(registry.get("inst-a")?.profileKey, "manual:inst-a");
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime reports heartbeat failure with active context", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-heartbeat-fail-"),
  );
  const socketPath = join(dir, "bus.sock");
  const failures: unknown[] = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    registrationState: createTelegramBusFollowerRegistrationState(),
    heartbeatMs: 10,
    timeoutMs: 50,
    onHeartbeatFailure(error, ctx) {
      failures.push({ error: String(error), ctx });
    },
  });
  try {
    await server.start();
    await follower.registerWithLeader(
      { cwd: "/repo" },
      { busSocketPath: socketPath },
    );
    await server.stop();
    await waitForCondition(() => failures.length > 0, 200);
    assert.deepEqual((failures[0] as { ctx: unknown }).ctx, { cwd: "/repo" });
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime reports rejected heartbeat with active context", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-heartbeat-reject-"),
  );
  const socketPath = join(dir, "bus.sock");
  const failures: unknown[] = [];
  let requestSequence = 0;
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: envelope.kind === "follower.register",
      message:
        envelope.kind === "follower.register"
          ? undefined
          : "Unknown Telegram bus follower instance.",
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => `inst-a:${++requestSequence}`,
    registrationState: createTelegramBusFollowerRegistrationState(),
    heartbeatMs: 10,
    timeoutMs: 50,
    onHeartbeatFailure(error, ctx) {
      failures.push({ error: String(error), ctx });
    },
  });
  try {
    await server.start();
    await follower.registerWithLeader(
      { cwd: "/repo" },
      { busSocketPath: socketPath },
    );
    await waitForCondition(() => failures.length > 0, 200);
    assert.deepEqual(failures[0], {
      error: "Error: Unknown Telegram bus follower instance.",
      ctx: { cwd: "/repo" },
    });
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime owns one in-flight heartbeat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-heartbeat-gate-"));
  const socketPath = join(dir, "bus.sock");
  let heartbeatCalls = 0;
  let releaseBlockedHeartbeat: (() => void) | undefined;
  const blockedHeartbeat = new Promise<void>((resolve) => {
    releaseBlockedHeartbeat = resolve;
  });
  const server = createTelegramBusLocalServer({
    socketPath,
    async handleEnvelope(envelope) {
      if (envelope.kind === "follower.register") {
        return { kind: "bus.ack", requestId: envelope.requestId, ok: true };
      }
      heartbeatCalls += 1;
      if (heartbeatCalls > 1) await blockedHeartbeat;
      return { kind: "bus.ack", requestId: envelope.requestId, ok: true };
    },
  });
  let requestSequence = 0;
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => `inst-a:${++requestSequence}`,
    registrationState: createTelegramBusFollowerRegistrationState(),
    heartbeatMs: 5,
  });
  try {
    await server.start();
    await follower.registerWithLeader(
      { cwd: "/repo" },
      { busSocketPath: socketPath },
    );
    await waitForCondition(() => heartbeatCalls === 2, 100);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(heartbeatCalls, 2);
    follower.stop();
    releaseBlockedHeartbeat?.();
  } finally {
    follower.stop();
    releaseBlockedHeartbeat?.();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime heartbeats until stopped", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-heartbeat-"),
  );
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  let nowMs = 1000;
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      getNowMs: () => nowMs,
    }),
  });
  let requestSequence = 0;
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => `inst-a:${++requestSequence}`,
    getNowMs: () => nowMs,
    heartbeatMs: 50,
  });
  try {
    await server.start();
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    nowMs = 2000;
    await waitForCondition(
      () => registry.get("inst-a")?.lastHeartbeatMs === 2000,
      120,
    );
    follower.stop();
    nowMs = 3000;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(registry.get("inst-a")?.lastHeartbeatMs, 2000);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime surfaces leader rejection reasons", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-reject-"));
  const socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: () => ({
      kind: "bus.ack",
      requestId: "inst-a:1",
      ok: false,
      message: "Unauthorized Telegram bus envelope.",
    }),
  });
  const stopped: string[] = [];
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    stopReceiving: () => {
      stopped.push("stop");
    },
  });
  try {
    await server.start();
    await assert.rejects(
      () =>
        follower.registerWithLeader(
          { cwd: "/repo" },
          { busSocketPath: socketPath },
        ),
      /Unauthorized Telegram bus envelope/,
    );
    assert.deepEqual(stopped, ["stop"]);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registration runtime derives leader socket when lock omits it", async () => {
  const dir = mkdtempSync(
    join(tmpdir(), "pi-telegram-bus-follower-derived-socket-"),
  );
  const socketPath = join(dir, "bus.sock");
  const registry = createTelegramBusFollowerRegistry();
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      getNowMs: () => 1000,
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:1",
    getLeaderSocketPath: () => socketPath,
  });
  try {
    await server.start();
    assert.equal(await follower.registerWithLeader({ cwd: "/repo" }, {}), true);
    assert.equal(registry.get("inst-a")?.instanceId, "inst-a");
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower queue handoff client rejects a mismatched staged receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-queue-handoff-mismatch-"));
  const socketPath = join(dir, "leader.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
      result: { status: "staged", receiptId: "wrong", sourceUpdateIds: [1] },
    }),
  });
  const client = createTelegramBusFollowerQueueHandoffClient({
    socketPath,
    instanceId: "donor",
    createRequestId: () => "handoff:mismatch",
    getRegistrationGeneration: () => "donor-generation",
  });
  try {
    await server.start();
    await assert.rejects(
      client({
        recipientInstanceId: "recipient",
        recipientRegistrationGeneration: "recipient-generation",
        donorProcessId: 101,
        donorProcessBirthId: "101:start:donor",
        donorSessionGeneration: 1,
        donorAcquisitionId: "donor-acquisition",
        donorAcquiredAtMs: 1000,
        handoffToken: "x".repeat(32),
        payload: {
          kind: "prompt",
          chatId: 7,
          replyToMessageId: 10,
          queueOrder: 1,
          queueLane: "default",
          laneOrder: 1,
          statusSummary: "handoff",
          admissionReceipts: [
            { queueKind: "prompt", receiptId: "receipt-1", sourceUpdateIds: [1] },
          ],
          sourceMessageIds: [10],
          queuedAttachments: [],
          content: [{ type: "text", text: "handoff prompt" }],
          historyText: "handoff",
        },
      }),
      /queue handoff was rejected/u,
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower queue handoff client requires an exact staged acknowledgement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-queue-handoff-client-"));
  const socketPath = join(dir, "leader.sock");
  const received: unknown[] = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope(envelope) {
      received.push(envelope);
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        result: {
          status: "staged",
          receiptId: "receipt-1",
          sourceUpdateIds: [1],
          queueOwner: {
            instanceId: "recipient",
            processId: 202,
            processBirthId: "202:start:recipient",
            sessionGeneration: 2,
            acquisitionId: "recipient-acquisition",
            acquiredAtMs: 2_000,
          },
        },
      };
    },
  });
  const client = createTelegramBusFollowerQueueHandoffClient({
    socketPath,
    instanceId: "donor",
    createRequestId: () => "handoff:1",
    getAuthSecret: () => "secret",
    getRegistrationGeneration: () => "donor-generation",
    getNowMs: () => 2000,
  });
  const payload = {
    kind: "prompt" as const,
    chatId: 7,
    replyToMessageId: 10,
    queueOrder: 1,
    queueLane: "default" as const,
    laneOrder: 1,
    statusSummary: "handoff",
    admissionReceipts: [
      { queueKind: "prompt" as const, receiptId: "receipt-1", sourceUpdateIds: [1] },
    ],
    sourceMessageIds: [10],
    queuedAttachments: [],
    content: [{ type: "text" as const, text: "handoff prompt" }],
    historyText: "handoff",
  };
  try {
    await server.start();
    assert.deepEqual(
      await client({
        recipientInstanceId: "recipient",
        recipientRegistrationGeneration: "recipient-generation",
        donorProcessId: 101,
        donorProcessBirthId: "101:start:donor",
        donorSessionGeneration: 1,
        donorAcquisitionId: "donor-acquisition",
        donorAcquiredAtMs: 1000,
        handoffToken: "x".repeat(32),
        payload,
      }),
      {
        status: "staged",
        receiptId: "receipt-1",
        sourceUpdateIds: [1],
        queueOwner: {
          instanceId: "recipient",
          processId: 202,
          processBirthId: "202:start:recipient",
          sessionGeneration: 2,
          acquisitionId: "recipient-acquisition",
          acquiredAtMs: 2_000,
        },
      },
    );
    assert.deepEqual(received, [
      {
        kind: "follower.offerQueueHandoff",
        requestId: "handoff:1",
        auth: "secret",
        instanceId: "donor",
        registrationGeneration: "donor-generation",
        recipientInstanceId: "recipient",
        recipientRegistrationGeneration: "recipient-generation",
        donorProcessId: 101,
        donorProcessBirthId: "101:start:donor",
        donorSessionGeneration: 1,
        donorAcquisitionId: "donor-acquisition",
        donorAcquiredAtMs: 1000,
        handoffToken: "x".repeat(32),
        payload,
        sentAtMs: 2000,
      },
    ]);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower API caller sends method and multipart voice calls over local transport", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-api-caller-"));
  const socketPath = join(dir, "bus.sock");
  const voicePath = join(dir, "voice output.ogg");
  const received: unknown[] = [];
  let requestSequence = 0;
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => {
      received.push(envelope);
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        result: { message_id: 55 },
      };
    },
  });
  const callApi = createTelegramBusFollowerApiCaller({
    socketPath,
    instanceId: "inst-a",
    createRequestId: () => `inst-a:${++requestSequence}`,
    getRegistrationGeneration: () => "generation-a",
    getNowMs: () => 7000,
  });
  try {
    await server.start();
    assert.deepEqual(await callApi("sendRichMessage", [{ chat_id: 1 }]), {
      message_id: 55,
    });
    assert.deepEqual(
      await callApi("callMultipart", [
        "sendVoice",
        { chat_id: "7", message_thread_id: "42" },
        "voice",
        voicePath,
        "voice output.ogg",
      ]),
      { message_id: 55 },
    );
    assert.deepEqual(received, [
      {
        kind: "follower.callApi",
        requestId: "inst-a:1",
        instanceId: "inst-a",
        registrationGeneration: "generation-a",
        method: "sendRichMessage",
        args: [{ chat_id: 1 }],
        sentAtMs: 7000,
      },
      {
        kind: "follower.callApi",
        requestId: "inst-a:2",
        instanceId: "inst-a",
        registrationGeneration: "generation-a",
        method: "callMultipart",
        args: [
          "sendVoice",
          { chat_id: "7", message_thread_id: "42" },
          "voice",
          voicePath,
          "voice output.ogg",
        ],
        sentAtMs: 7000,
      },
    ]);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower API calls wait for heartbeat recovery before transport", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-api-recovery-"));
  const socketPath = join(dir, "bus.sock");
  const received: unknown[] = [];
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(
    true,
    { chatId: 1, threadId: 2 },
    { generation: "generation-old" },
  );
  registrationState.beginRecovery();
  registrationState.setRegistered(false);
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => {
      received.push(envelope);
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        result: { message_id: 56 },
      };
    },
  });
  const callApi = createTelegramBusFollowerApiCaller({
    socketPath,
    instanceId: "inst-a",
    createRequestId: () => "inst-a:recovery:1",
    getRegistrationGeneration: registrationState.getGeneration,
    waitForRegistrationGeneration: registrationState.waitForGeneration,
    getNowMs: () => 7001,
  });
  try {
    await server.start();
    const delivery = callApi("sendRichMessage", [{ chat_id: 1 }]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received, []);

    registrationState.setRegistered(
      true,
      { chatId: 1, threadId: 2 },
      { generation: "generation-restored" },
    );

    assert.deepEqual(await delivery, { message_id: 56 });
    assert.equal(received.length, 1);
    assert.equal(
      (received[0] as { registrationGeneration?: string })
        .registrationGeneration,
      "generation-restored",
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower API calls fail before transport when registration is not restored", async () => {
  let transportRequested = false;
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.beginRecovery();
  const callApi = createTelegramBusFollowerApiCaller({
    socketPath: () => {
      transportRequested = true;
      return "unused.sock";
    },
    instanceId: "inst-a",
    createRequestId: () => "inst-a:unregistered:1",
    getRegistrationGeneration: registrationState.getGeneration,
    waitForRegistrationGeneration: registrationState.waitForGeneration,
    timeoutMs: 10,
  });

  await assert.rejects(
    () => callApi("sendRichMessage", [{ chat_id: 1 }]),
    /Telegram bus follower is not registered/,
  );
  assert.equal(transportRequested, false);
});

test("Bus follower API calls do not cross an explicit recovery cancellation", async () => {
  let transportRequested = false;
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.beginRecovery();
  const callApi = createTelegramBusFollowerApiCaller({
    socketPath: () => {
      transportRequested = true;
      return "unused.sock";
    },
    instanceId: "inst-a",
    createRequestId: () => "inst-a:cancelled:1",
    getRegistrationGeneration: registrationState.getGeneration,
    waitForRegistrationGeneration: registrationState.waitForGeneration,
  });

  const delivery = callApi("sendRichMessage", [{ chat_id: 1 }]);
  await new Promise((resolve) => setImmediate(resolve));
  registrationState.cancelRecovery();
  registrationState.setRegistered(
    true,
    { chatId: 1, threadId: 2 },
    { generation: "unrelated-generation" },
  );

  await assert.rejects(
    () => delivery,
    /Telegram bus follower is not registered/,
  );
  assert.equal(transportRequested, false);
});

test("Bus follower API caller preserves structured commit-unknown errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-api-ambiguous-"));
  const socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message: "sendMessage response was lost",
      error: { code: "commit-unknown", method: "sendMessage" },
    }),
  });
  const callApi = createTelegramBusFollowerApiCaller({
    socketPath,
    instanceId: "inst-a",
    createRequestId: () => "inst-a:ambiguous:1",
    getRegistrationGeneration: () => "generation-a",
  });
  try {
    await server.start();
    await assert.rejects(
      () => callApi("call", ["sendMessage", { chat_id: 1, text: "hello" }]),
      isTelegramApiCommitUnknownError,
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower API caller preserves structured stale-target evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-api-stale-target-"));
  const socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message: "Bad Request: message thread not found",
      error: { code: "stale-target", chatId: 1, threadId: 2 },
    }),
  });
  const callApi = createTelegramBusFollowerApiCaller({
    socketPath,
    instanceId: "inst-a",
    createRequestId: () => "inst-a:stale-target:1",
    getRegistrationGeneration: () => "generation-a",
  });
  try {
    await server.start();
    const error = await callApi("call", [
      "sendMessage",
      { chat_id: 1, message_thread_id: 2, text: "hello" },
    ]).catch((failure: unknown) => failure);
    assert.deepEqual(getTelegramApiErrorRequestTarget(error), {
      chatId: 1,
      threadId: 2,
    });
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower API caller classifies non-idempotent acknowledgement loss as commit-unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-api-ack-loss-"));
  const socketPath = join(dir, "bus.sock");
  let executions = 0;
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => {
      executions += 1;
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        result: { message_id: 77 },
      };
    },
    shouldDropResponse: () => true,
  });
  const callApi = createTelegramBusFollowerApiCaller({
    socketPath,
    instanceId: "inst-a",
    createRequestId: () => "inst-a:ack-loss:1",
    getRegistrationGeneration: () => "generation-a",
    timeoutMs: 100,
  });
  try {
    await server.start();
    await assert.rejects(
      () => callApi("call", ["sendMessage", { chat_id: 1, text: "hello" }]),
      isTelegramApiCommitUnknownError,
    );
    assert.equal(executions, 1);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower initial registration consumes a pending session handoff after acknowledgement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-handoff-"));
  const socketPath = join(dir, "bus.sock");
  const registrations: Array<{
    target: unknown;
    previousInstanceId: string | undefined;
  }> = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: createTelegramBusFollowerRegistry(),
      provisionFollowerTarget(registration) {
        registrations.push({
          target: registration.target,
          previousInstanceId: registration.previousInstanceId,
        });
        return { chatId: 1, threadId: 2, slot: "B", threadName: "Beryl" };
      },
    }),
  });
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "new-inst",
    createRequestId: () => "new-inst:1",
    registrationRetryAttempts: 1,
    registrationTimeoutMs: 50,
    registrationState: createTelegramBusFollowerRegistrationState(),
  });
  setTelegramFollowerSessionHandoff({
    pid: process.pid,
    instanceId: "old-inst",
    createdAtMs: Date.now(),
    target: { chatId: 1, threadId: 2 },
    slot: "B",
    threadName: "Beryl",
  });
  try {
    await assert.rejects(() =>
      follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
    );
    assert.equal(getTelegramFollowerSessionHandoff()?.instanceId, "old-inst");

    await server.start();
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
      ),
      true,
    );
    assert.deepEqual(registrations, [
      {
        target: { chatId: 1, threadId: 2 },
        previousInstanceId: "old-inst",
      },
    ]);
    assert.equal(getTelegramFollowerSessionHandoff(), undefined);
  } finally {
    follower.stop();
    setTelegramFollowerSessionHandoff(undefined);
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower session replacement preserves a same-process handoff", async () => {
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(
    true,
    { chatId: 1, threadId: 2 },
    { slot: "B", threadName: "Beryl" },
  );
  const events: unknown[] = [];
  let suspended = false;
  const suspend = createTelegramBusFollowerSessionReplacementSuspender({
    registrationState,
    instanceId: "old-inst",
    async suspendPolling() {
      suspended = true;
      registrationState.setRegistered(false);
    },
    recordRuntimeEvent(category, message, details) {
      events.push({ category, message, details });
    },
    getPid: () => 10,
    getNowMs: () => 500,
  });

  await suspend();

  assert.equal(suspended, true);
  assert.equal(registrationState.isRegistered(), false);
  assert.deepEqual(getTelegramFollowerSessionHandoff(), {
    pid: 10,
    instanceId: "old-inst",
    createdAtMs: 500,
    target: { chatId: 1, threadId: 2 },
    slot: "B",
    threadName: "Beryl",
  });
  assert.deepEqual(events, [
    {
      category: "bus",
      message: "Telegram follower registration suspended for session replacement",
      details: {
        phase: "follower-session-handoff",
        instanceId: "old-inst",
        chatId: 1,
        threadId: 2,
      },
    },
  ]);
  setTelegramFollowerSessionHandoff(undefined);
});

test("Bus session replacement preserves the promoted leader binding", async () => {
  const registrationState = createTelegramBusFollowerRegistrationState();
  const events: unknown[] = [];
  const suspend = createTelegramBusFollowerSessionReplacementSuspender({
    registrationState,
    instanceId: "promoted-inst",
    suspendPolling: async () => undefined,
    isLeader: () => true,
    getLeaderBinding: () => ({
      target: { chatId: 1, threadId: 3 },
      slot: "C",
      threadName: "Cinder",
    }),
    getActiveContext: () => ({ cwd: "/repo" }),
    getActiveProfileName: () => "work",
    recordRuntimeEvent(category, message, details) {
      events.push({ category, message, details });
    },
    getPid: () => 10,
    getNowMs: () => 500,
  });

  try {
    await suspend();
    assert.deepEqual(getTelegramLeaderSessionHandoff(), {
      pid: 10,
      instanceId: "promoted-inst",
      createdAtMs: 500,
      profileKey: "profile:work:cwd:/repo",
      target: { chatId: 1, threadId: 3 },
      slot: "C",
      threadName: "Cinder",
    });
    assert.deepEqual(events, [
      {
        category: "bus",
        message: "Telegram leader binding suspended for session replacement",
        details: {
          phase: "leader-session-handoff",
          instanceId: "promoted-inst",
          chatId: 1,
          threadId: 3,
          slot: "C",
          threadName: "Cinder",
        },
      },
    ]);
  } finally {
    setTelegramLeaderSessionHandoff(undefined);
  }
});

test("Bus follower session refresh re-registers with the handed-off target", async () => {
  const registrationState = createTelegramBusFollowerRegistrationState();
  const registrations: unknown[] = [];
  const events: unknown[] = [];
  setTelegramFollowerSessionHandoff({
    pid: process.pid,
    instanceId: "old-inst",
    createdAtMs: Date.now(),
    target: { chatId: 1, threadId: 2 },
    slot: "B",
    threadName: "Beryl",
  });
  const refresh = createTelegramBusFollowerSessionRefreshHook({
    registrationState,
    registrationRuntime: {
      async registerWithLeader(ctx, leader, options) {
        registrations.push({ ctx, leader, options });
        registrationState.setRegistered(
          true,
          options?.target,
          { slot: "B", threadName: "Beryl" },
        );
        return true;
      },
      setContext: () => undefined,
    },
    getLeaderState: () => ({
      kind: "active-elsewhere",
      lock: { pid: 20, busSocketPath: "/tmp/leader.sock" },
    }),
    updateStatus: () => undefined,
    recordRuntimeEvent(category, message, details) {
      events.push({ category, message, details });
    },
  });

  await refresh({}, { cwd: "/repo" });

  assert.deepEqual(registrations, [
    {
      ctx: { cwd: "/repo" },
      leader: { pid: 20, busSocketPath: "/tmp/leader.sock" },
      options: {
        target: { chatId: 1, threadId: 2 },
        previousInstanceId: "old-inst",
      },
    },
  ]);
  assert.equal(registrationState.isRegistered(), true);
  assert.deepEqual(registrationState.getTarget(), { chatId: 1, threadId: 2 });
  assert.equal(getTelegramFollowerSessionHandoff(), undefined);
  assert.deepEqual(events, [
    {
      category: "bus",
      message: "Telegram follower registration restored after session replacement",
      details: {
        phase: "follower-session-restore",
        previousInstanceId: "old-inst",
      },
    },
    {
      category: "bus",
      message: "Telegram follower session context refreshed",
      details: { phase: "follower-session-refresh" },
    },
  ]);
});

test("follower client runtime exposes authenticated queue handoff transport", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-client-handoff-"));
  const socketPath = join(dir, "bus.sock");
  const received: unknown[] = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => {
      received.push(envelope);
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        result: {
          status: "staged",
          receiptId: "receipt-1",
          sourceUpdateIds: [1],
          queueOwner: {
            instanceId: "recipient",
            processId: 202,
            processBirthId: "202:start:recipient",
            sessionGeneration: 2,
            acquisitionId: "recipient-acquisition",
            acquiredAtMs: 2_000,
          },
        },
      };
    },
  });
  const client = createTelegramBusFollowerClientRuntime<
    { cwd: string },
    unknown,
    unknown,
    unknown
  >({
    socketPath,
    instanceId: "donor",
    getApiAuthSecret: () => "secret",
    getRegistrationGeneration: () => "donor-generation",
  });
  try {
    await server.start();
    assert.deepEqual(
      await client.queueHandoff({
        recipientInstanceId: "recipient",
        recipientRegistrationGeneration: "recipient-generation",
        donorProcessId: 101,
        donorProcessBirthId: "101:start:donor",
        donorSessionGeneration: 1,
        donorAcquisitionId: "donor-acquisition",
        donorAcquiredAtMs: 1000,
        handoffToken: "x".repeat(32),
        payload: {
          kind: "prompt",
          chatId: 7,
          replyToMessageId: 10,
          queueOrder: 1,
          queueLane: "default",
          laneOrder: 1,
          statusSummary: "handoff",
          admissionReceipts: [
            { queueKind: "prompt", receiptId: "receipt-1", sourceUpdateIds: [1] },
          ],
          sourceMessageIds: [10],
          queuedAttachments: [],
          content: [{ type: "text", text: "handoff prompt" }],
          historyText: "handoff",
        },
      }),
      {
        status: "staged",
        receiptId: "receipt-1",
        sourceUpdateIds: [1],
        queueOwner: {
          instanceId: "recipient",
          processId: 202,
          processBirthId: "202:start:recipient",
          sessionGeneration: 2,
          acquisitionId: "recipient-acquisition",
          acquiredAtMs: 2_000,
        },
      },
    );
    assert.equal((received[0] as { auth?: string }).auth, "secret");
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("follower client defaults the forwarding timeout to the 30s bus window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-follower-timeout-"));
  const socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: async (envelope) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        result:
          "delivery" in envelope && envelope.delivery
            ? {
                deliveryId: envelope.delivery.deliveryId,
                sourceUpdateId: envelope.delivery.sourceUpdateId,
              }
            : undefined,
      };
    },
  });
  const client = createTelegramBusFollowerClientRuntime<
    { cwd: string },
    unknown,
    unknown,
    unknown
  >({
    socketPath,
    instanceId: "inst-a",
    getRegistrationGeneration: () => "generation-a",
  });
  try {
    await server.start();
    const settlement = await client.foreignOwnedUpdateForwarder.forwardMessage({
      message: {
        message_id: 1,
        chat: { id: 7, type: "supergroup" },
        pi_telegram_source_update_id: 44,
      },
      ownership: {
        instanceId: "inst-a",
        ownerGeneration: "generation-a",
        recipientBindingKey: "manual:owner-a",
      },
      ctx: { cwd: "/repo" },
    });
    assert.deepEqual(settlement, {
      status: "accepted",
      delivery: createTelegramBusFollowerDeliveryIdentity({
        kind: "leader.forwardMessage",
        recipientBindingKey: "manual:owner-a",
        sourceUpdateId: 44,
      }),
    });
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
