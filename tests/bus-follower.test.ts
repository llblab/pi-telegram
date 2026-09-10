/**
 * Regression tests for Telegram multi-instance bus follower helpers
 * Covers follower registration, forwarded update receiving, and follower-routed API calls
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTelegramBusFollowerApiCaller,
  createTelegramBusFollowerClientRuntime,
  createTelegramBusFollowerControlState,
  createTelegramBusFollowerDurableAdmissionRuntime,
  createTelegramBusFollowerSourceReferenceAdmissionRuntime,
  createTelegramBusFollowerPairedAdmission,
  createTelegramBusFollowerHeartbeatRecoveryHandler,
  createTelegramBusFollowerInputCustodyPorts,
  type TelegramBusFollowerInputCustodyBundle,
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
  type TelegramBusEnvelope,
  createTelegramBusFollowerRegistry,
  createTelegramBusFollowerTargetController,
  createTelegramBusProtocolIdentity,
  createTelegramBusLocalServer as createRawTelegramBusLocalServer,
  resolveTelegramBusSocketPath,
  sendTelegramBusLocalEnvelope,
  TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
  TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
  TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT,
  TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME,
  TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE,
} from "../lib/bus.ts";
import { getTelegramBusTransportKind } from "../lib/bus-transport.ts";
import { createTelegramConfigStore } from "../lib/config.ts";
import { createTelegramUpdateJournalBotIdentity, createTelegramUpdateJournalStore } from "../lib/journal.ts";
import {
  createTelegramBusFollowerTargetProvisioner,
  createTelegramBusLeaderEnvelopeHandler as createRawTelegramBusLeaderEnvelopeHandler,
} from "../lib/bus-leader.ts";
import {
  createTelegramTopicTargetStore,
  createTelegramWorkspaceBindingIdentity,
  getTelegramLeaderSessionHandoff,
  setTelegramLeaderSessionHandoff,
} from "../lib/threads.ts";
import {
  getTelegramApiErrorRequestTarget,
  isTelegramApiCommitUnknownError,
} from "../lib/telegram-api.ts";
import { createTelegramWorkspaceAdmissionLedger } from "../lib/workspace-admission.ts";

const TEST_BUS_PROTOCOL_IDENTITY = createTelegramBusProtocolIdentity({
  runtimeBuild: "test",
  capabilities: [
    TELEGRAM_BUS_CAPABILITY_DURABLE_FOLLOWER_ADMISSION,
    TELEGRAM_BUS_CAPABILITY_QUEUE_HANDOFF,
    TELEGRAM_BUS_CAPABILITY_WORKSPACE_FOLLOWER_AUTO_CONNECT,
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
  store.upsertWorkspaceBinding({
    ...createTelegramWorkspaceBindingIdentity("/repo")!,
    target: { chatId: 42, threadId: 11 }, slot: "E", threadName: "Ember",
    displayTitle: "repo_e", updatedAtMs: 100,
  });
  await store.persist();
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
    assert.equal(store.getWorkspaceBinding("/repo")?.threadName, "Ember");
    assert.equal(store.getWorkspaceBinding("/repo")?.displayTitle, "repo_e");
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

test("Bus follower promotion is rejected before leadership acquisition by a retained fence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-promotion-fence-"));
  const admission = createTelegramWorkspaceAdmissionLedger({
    path: join(dir, "workspace-admission.json"),
    profileKey: "profile:follower-promotion",
    owner: {
      processId: process.pid,
      processBirthId: `${process.pid}:follower-promotion-test`,
    },
    getProcessLiveness: () => "alive",
  });
  const fence = admission.acquireRetirementFence({
    operationId: "follower-promotion-fence",
    retirementIntentId: "follower-promotion-intent",
    bindingKey: "follower-promotion-binding",
    slot: "E",
    target: { chatId: 42, threadId: 11 },
    leaderEpoch: 1,
    retirementRequestedAtMs: 1,
  });
  assert.equal(fence.kind, "acquired");
  let leadershipAttempted = false;
  const promote = createTelegramBusFollowerPromotionHandler({
    topicTargetStore: createTelegramTopicTargetStore({
      path: join(dir, "state.json"),
    }),
    instanceId: "inst-a",
    getActiveProfileName: () => "work",
    getWorkspaceAdmission: () => admission,
    startLeader: async () => {
      leadershipAttempted = true;
      return true;
    },
    recordRuntimeEvent() {},
  });
  try {
    await assert.rejects(
      promote(
        { cwd: "/repo" },
        { target: { chatId: 42, threadId: 11 }, slot: "E" },
        {},
      ),
      /blocked by retirement/u,
    );
    assert.equal(leadershipAttempted, false);
  } finally {
    if (fence.kind === "acquired") {
      admission.releaseUnissuedRetirementFence(fence.fence);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower promotion rejects slotless authority at global capacity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-promotion-capacity-"));
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json") });
  store.upsert({
    profileKey: "manual:inst-a",
    owner: { kind: "manual-follower", instanceId: "inst-a" },
    target: { chatId: 42, threadId: 11 },
    status: "active",
    createdAtMs: 1,
    updatedAtMs: 1,
    instanceId: "inst-a",
  });
  for (const [index, slot] of Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ").entries()) {
    store.upsertWorkspaceBinding({
      ...createTelegramWorkspaceBindingIdentity(`/retained/${index}`)!,
      target: { chatId: 42, threadId: 100 + index },
      slot,
      updatedAtMs: index + 1,
    });
  }
  await store.persist();
  const promote = createTelegramBusFollowerPromotionHandler({
    topicTargetStore: store,
    instanceId: "inst-a",
    getActiveProfileName: () => undefined,
    startLeader: async (_ctx: { cwd: string }, _election, onAcquired) => {
      await onAcquired();
      return true;
    },
    recordRuntimeEvent: () => undefined,
  });
  try {
    await assert.rejects(promote(
      { cwd: "/repo" },
      { target: { chatId: 42, threadId: 11 } },
      {},
    ), /promotion slot authority is unavailable/u);
    const retained = store.getByProfileKey("manual:inst-a");
    assert.equal(retained?.owner?.kind, "manual-follower");
    assert.equal(retained?.slot, undefined);
    assert.equal(store.getByProfileKey("cwd:/repo"), undefined);
  } finally {
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
        } else if (envelope.kind === "leader.forwardEditedMessage") {
          received.push({
            kind: "edited-message",
            message: envelope.message,
            ctx,
          });
        } else {
          assert.fail("custody wake entered legacy durable admission");
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
          registrationGeneration: "generation-b",
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

test("Follower paired admission extracts only exact human senders from canonical forwarded kinds", () => {
  for (const kind of ["message", "edited_message", "callback_query", "message_reaction"]) {
    for (const scenario of ["valid", "bot", "missing-flag", "invalid-flag", "wrong-author-field", "invalid-id", "anonymous", "source-mismatch", "extra-carrier", "invalid-carrier", "unsupported-kind", "bad-position"] as const) {
      let checked = 0;
      let published = 0;
      let fenced = 0;
      const gate = createTelegramBusFollowerPairedAdmission({
        profileName: "work", tokenSha256: "a".repeat(64),
        assertExecutionCurrent: () => { fenced++; },
        configStore: { withPairedUserAdmission(profile, hash, userId, publish, fence) {
          checked++;
          assert.equal(profile, "work");
          assert.equal(hash, "a".repeat(64));
          assert.equal(userId, 7);
          fence?.();
          return { admitted: true, value: publish() };
        } },
      });
      const sender: Record<string, unknown> = { id: 7, is_bot: false };
      if (scenario === "bot") sender.is_bot = true;
      if (scenario === "missing-flag") delete sender.is_bot;
      if (scenario === "invalid-flag") sender.is_bot = "false";
      if (scenario === "invalid-id") sender.id = 0;
      const authorField = kind === "message_reaction" ? "user" : "from";
      const carrier: Record<string, unknown> = {
        pi_telegram_source_update_id: scenario === "source-mismatch" ? 21 : 20,
        [authorField]: sender,
        forward_origin: { sender_user: { id: 99, is_bot: false } },
        message: { from: { id: 99, is_bot: true } },
      };
      if (scenario === "wrong-author-field") { delete carrier[authorField]; carrier[authorField === "user" ? "from" : "user"] = sender; }
      if (scenario === "anonymous") carrier[kind === "message_reaction" ? "actor_chat" : "sender_chat"] = null;
      const update = { update_id: 20, [scenario === "unsupported-kind" ? "guest_message" : kind]: carrier };
      if (scenario === "invalid-carrier") Object.assign(update, { [kind]: null });
      if (scenario === "extra-carrier") Object.assign(update, { [kind === "message" ? "edited_message" : "message"]: {} });
      if (scenario === "bad-position") Object.assign(update, { pi_telegram_forward_comment_batch_position: "invalid" });
      const result = gate([update], () => { published++; return "published"; });
      const valid = scenario === "valid";
      assert.deepEqual(result, valid ? { admitted: true, value: "published" } : { admitted: false }, `${kind}/${scenario}`);
      assert.equal(checked, Number(valid));
      assert.equal(published, Number(valid));
      assert.equal(fenced, Number(valid));
      if (valid) {
        assert.deepEqual(gate([], () => assert.fail("empty publication")), { admitted: false });
        assert.deepEqual(gate([update, update], () => assert.fail("batch publication")), { admitted: false });
      }
    }
  }
});

test("Paired follower receiver preserves provenance, unordered v1 admission and post-lock wakeup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-paired-receiver-"));
  const configPath = join(dir, "telegram.json");
  const journalPath = join(dir, "inbox.json");
  const socketPath = join(dir, "receiver.sock");
  const identity = createTelegramUpdateJournalBotIdentity({ botToken: "fixture-token" });
  writeFileSync(configPath, JSON.stringify({ profiles: { work: { botToken: "fixture-token" } } }));
  const config = createTelegramConfigStore({ agentDir: dir, configPath });
  await config.load();
  config.activateProfile("work");
  const ledger = createTelegramWorkspaceAdmissionLedger({
    path: join(dir, "admission.json"), profileKey: "fixture:work",
    owner: { processId: process.pid, processBirthId: `${process.pid}:receiver` }, getProcessLiveness: () => "alive",
  });
  let current = true;
  let failPublication = false;
  let checks = 0;
  let signals = 0;
  const assertCurrent = () => { checks++; if (!current) throw new Error("stale fixture receiver"); };
  const pairedGate = createTelegramBusFollowerPairedAdmission({
    profileName: "work", tokenSha256: identity.tokenSha256, configStore: config, assertExecutionCurrent: assertCurrent,
  });
  const journal = createTelegramUpdateJournalStore({
    path: journalPath, profileName: "work", botIdentity: identity, workspaceAdmission: ledger,
    withPairedAdmission: pairedGate,
    onPublicationBoundary: () => { assertCurrent(); if (failPublication) throw new Error("fixture publication failed"); },
  });
  const durableAdmission = createTelegramBusFollowerDurableAdmissionRuntime({
    journal,
    signalWorker: () => {
      assert.equal(existsSync(`${configPath}.transaction`), false);
      assert.equal(existsSync(`${journalPath}.transaction`), false);
      assert.deepEqual(ledger.read().leases, []);
      assert.equal(config.getAllowedUserId(), 7);
      signals++;
    },
  });
  const receiver = createTelegramBusForwardedUpdateReceiverRuntime({
    socketPath, instanceId: "fixture", getAuthSecret: () => "fixture-auth",
    getRegistrationGeneration: () => "generation", getRecipientBindingKey: () => "binding", getContext: () => "ctx",
    durableAdmission,
  });
  const kinds = ["leader.forwardMessage", "leader.forwardEditedMessage", "leader.forwardCallback", "leader.forwardReaction"] as const;
  let requests = 0;
  const envelope = (kind: typeof kinds[number], id: number, sender = 7): TelegramBusEnvelope => {
    const base = { requestId: `request:${id}:${++requests}`, auth: "fixture-auth", recipientInstanceId: "fixture",
      recipientRegistrationGeneration: "generation", sentAtMs: 1,
      delivery: createTelegramBusFollowerDeliveryIdentity({ kind, recipientBindingKey: "binding", sourceUpdateId: id }) };
    const carrier = { pi_telegram_source_update_id: id, from: { id: sender, is_bot: false },
      user: { id: sender, is_bot: false }, chat: { id: 7, type: "private" }, message_id: id,
      old_reaction: [], new_reaction: [], id: `query:${id}` };
    if (kind === "leader.forwardCallback") return { ...base, kind, query: carrier };
    if (kind === "leader.forwardReaction") return { ...base, kind, reactionUpdate: carrier };
    if (kind === "leader.forwardMessage") return { ...base, kind, message: carrier, forwardCommentBatchPosition: "forward" };
    return { ...base, kind, message: carrier };
  };
  const send = async (value: TelegramBusEnvelope) => {
    const response = await sendTelegramBusLocalEnvelope({ socketPath, envelope: value });
    assert.equal(response?.kind, "bus.ack");
    if (response?.kind !== "bus.ack") throw new Error("missing fixture ACK");
    return response;
  };
  try {
    await receiver.start();
    assert.equal((await send(envelope(kinds[0], 40))).ok, false);
    assert.equal(existsSync(journalPath), false);
    assert.equal(signals, 0);
    assert.equal(config.getAllowedUserId(), undefined);
    const peer = createTelegramConfigStore({ agentDir: dir, configPath });
    await peer.load();
    assert.equal(peer.activateProfile("work"), true);
    assert.equal(await peer.persistAllowedUserId(7), true);
    const granted = readFileSync(configPath, "utf8");
    for (const [index, kind] of kinds.entries()) {
      const response = await send(envelope(kind, 40 - index * 10));
      assert.equal(response.ok, true, `${kind}: ${response.message}`);
    }
    assert.equal(signals, 4);
    assert.equal(journal.read().version, 1);
    assert.equal(journal.read().acceptedThroughUpdateId, undefined);
    assert.deepEqual(journal.read().entries.map((entry) => entry.updateId), [10, 20, 30, 40]);
    const before = checks;
    assert.equal((await send({ ...envelope(kinds[0], 50), auth: "wrong" })).ok, false);
    assert.equal((await send({ ...envelope(kinds[0], 50), recipientRegistrationGeneration: "stale" } as TelegramBusEnvelope)).ok, false);
    assert.equal((await send({ ...envelope(kinds[0], 50), delivery: createTelegramBusFollowerDeliveryIdentity({
      kind: kinds[0], recipientBindingKey: "wrong", sourceUpdateId: 50,
    }) } as TelegramBusEnvelope)).ok, false);
    assert.equal(checks, before, "Provenance rejection must precede config admission");
    for (const kind of kinds) assert.equal((await send(envelope(kind, 50, 8))).ok, false);
    current = false;
    assert.equal((await send(envelope(kinds[0], 50))).ok, false);
    current = true; failPublication = true;
    assert.equal((await send(envelope(kinds[0], 50))).ok, false);
    assert.equal(signals, 4);
    assert.deepEqual(journal.read().entries.map((entry) => entry.updateId), [10, 20, 30, 40]);
    assert.deepEqual(ledger.read().leases, []);
    assert.equal(readFileSync(configPath, "utf8"), granted);
  } finally {
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower custody ports follow lifecycle bundle replacement without cached authority", async () => {
  let accepts = 0;
  let wakes = 0;
  let bundle: TelegramBusFollowerInputCustodyBundle<string> | undefined = {
      acceptHandoff() { accepts += 1; return { duplicate: false }; },
      wakeSource() { wakes += 1; },
      resolveForwardReference({ sourceUpdateId }) { return { sourceRecoveryKey: "journal:source",
        source: { updateId: sourceUpdateId, owner: {
          acquisitionId: "acquisition", handoffId: "handoff" } } }; },
    };
  const ports = createTelegramBusFollowerInputCustodyPorts<string>({
    getInputCustodyBus: () => bundle });
  const source = { journalBindingKey: "journal:source", tokenSha256: "a".repeat(64), updateId: 43 };
  const handoffEnvelope = { kind: "leader.offerInputCustodyHandoff" as const,
    requestId: "leader:handoff", recipientInstanceId: "recipient",
    recipientRegistrationGeneration: "g1", recipientBindingKey: "workspace:recipient",
    sourceRecoveryKey: "journal:source", source, handoffId: "handoff", sentAtMs: 1 };
  assert.deepEqual(ports.handleInputCustodyHandoff(handoffEnvelope, "ctx"), { duplicate: false });
  const delivery = createTelegramBusFollowerDeliveryIdentity({ kind: "leader.wakeInputCustody",
    recipientBindingKey: "workspace:recipient", sourceUpdateId: 43,
    sourceRecoveryKey: "journal:source",
    sourceClaim: { acquisitionId: "acquisition", handoffId: "handoff" } });
  await ports.sourceReferenceAdmission.admit({ kind: "leader.wakeInputCustody",
    requestId: "leader:wake", recipientInstanceId: "recipient",
    recipientRegistrationGeneration: "g1", delivery, sentAtMs: 2 }, "ctx");
  assert.deepEqual([accepts, wakes], [1, 1]);
  assert.equal(ports.resolveInputCustodyReference({ sourceUpdateId: 43,
    recipientBindingKey: "workspace:recipient" })?.source.updateId, 43);
  bundle = undefined;
  assert.equal(ports.isSourceReferenceAdmissionEnabled(), false);
  assert.equal(ports.resolveInputCustodyReference({ sourceUpdateId: 43,
    recipientBindingKey: "workspace:recipient" }), undefined);
  assert.throws(() => ports.handleInputCustodyHandoff(handoffEnvelope, "ctx"),
    /bus binding is unavailable/);
  await assert.rejects(ports.sourceReferenceAdmission.admit({ kind: "leader.wakeInputCustody",
    requestId: "leader:wake-stale", recipientInstanceId: "recipient",
    recipientRegistrationGeneration: "g2", delivery, sentAtMs: 3 }, "ctx"),
  /bus binding is unavailable/);
  assert.deepEqual([accepts, wakes], [1, 1]);
});

test("Bus follower receiver invalidates custody ports across downgrade and reconnect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-custody-port-reconnect-"));
  const socketPath = join(dir, "follower.sock");
  let generation = "g1";
  let firstAccepts = 0;
  let secondAccepts = 0;
  let secondWakes = 0;
  const makeBundle = (accept: () => void, wake: () => void): TelegramBusFollowerInputCustodyBundle<string> => ({
    acceptHandoff() { accept(); return { duplicate: false }; },
    wakeSource() { wake(); },
    resolveForwardReference() { return undefined; },
  });
  let bundle: TelegramBusFollowerInputCustodyBundle<string> | undefined =
    makeBundle(() => { firstAccepts += 1; }, () => {});
  const ports = createTelegramBusFollowerInputCustodyPorts<string>({
    getInputCustodyBus: () => bundle });
  const receiver = createTelegramBusForwardedUpdateReceiverRuntime({ socketPath,
    instanceId: "recipient", getAuthSecret: () => "secret",
    getRegistrationGeneration: () => generation,
    getRecipientBindingKey: () => "workspace:recipient", getContext: () => "ctx",
    durableAdmission: { async admit() { assert.fail("legacy admission invoked"); } },
    hasAuthenticatedSourceReferenceTransport: () => true, ...ports,
  });
  const source = { journalBindingKey: "journal:source", tokenSha256: "a".repeat(64), updateId: 43 };
  const sendHandoff = (requestId: string, requestedGeneration: string) =>
    sendTelegramBusLocalEnvelope({ socketPath, envelope: {
      kind: "leader.offerInputCustodyHandoff", requestId,
      recipientInstanceId: "recipient", recipientRegistrationGeneration: requestedGeneration,
      recipientBindingKey: "workspace:recipient", sourceRecoveryKey: "journal:source",
      source, handoffId: "handoff", sentAtMs: 1, auth: "secret" } });
  try {
    await receiver.start();
    assert.equal((await sendHandoff("leader:first", "g1"))?.kind, "bus.ack");
    assert.equal(firstAccepts, 1);
    bundle = undefined;
    const downgraded = await sendHandoff("leader:downgraded", "g1");
    assert.equal(downgraded?.kind === "bus.ack" && downgraded.ok, false);
    assert.equal(firstAccepts, 1);
    generation = "g2";
    bundle = makeBundle(() => { secondAccepts += 1; }, () => { secondWakes += 1; });
    assert.equal((await sendHandoff("leader:second", "g2"))?.kind, "bus.ack");
    const stale = await sendHandoff("leader:stale", "g1");
    assert.equal(stale?.kind === "bus.ack" && stale.ok, false);
    const delivery = createTelegramBusFollowerDeliveryIdentity({ kind: "leader.wakeInputCustody",
      recipientBindingKey: "workspace:recipient", sourceUpdateId: 43,
      sourceRecoveryKey: "journal:source",
      sourceClaim: { acquisitionId: "acquisition", handoffId: "handoff" } });
    const wake = await sendTelegramBusLocalEnvelope({ socketPath, envelope: {
      kind: "leader.wakeInputCustody", requestId: "leader:wake", recipientInstanceId: "recipient",
      recipientRegistrationGeneration: "g2", delivery, sentAtMs: 2, auth: "secret" } });
    assert.equal(wake?.kind === "bus.ack" && wake.ok, true);
    assert.deepEqual([firstAccepts, secondAccepts, secondWakes], [1, 1, 1]);
  } finally { await receiver.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("Bus follower source-reference admission wakes durable custody without journaling a copy", async () => {
  const delivery = createTelegramBusFollowerDeliveryIdentity({
    kind: "leader.wakeInputCustody", recipientBindingKey: "workspace:recipient", sourceUpdateId: 43,
    sourceRecoveryKey: "journal:source-43",
    sourceClaim: { acquisitionId: "acquisition-43", handoffId: "handoff-43" } });
  const wakes: unknown[] = [];
  const admission = createTelegramBusFollowerSourceReferenceAdmissionRuntime({
    wakeSource(input, ctx) { wakes.push({ input, ctx }); },
  });
  const result = await admission.admit({ kind: "leader.wakeInputCustody", requestId: "leader:ref",
    recipientInstanceId: "recipient", recipientRegistrationGeneration: "g1", delivery,
    sentAtMs: 2_000 }, "ctx");
  assert.deepEqual(result, { deliveryId: delivery.deliveryId, sourceUpdateId: 43 });
  assert.deepEqual(wakes, [{ input: { deliveryId: delivery.deliveryId, sourceUpdateId: 43,
    recipientBindingKey: "workspace:recipient", sourceRecoveryKey: "journal:source-43",
    sourceClaim: { acquisitionId: "acquisition-43", handoffId: "handoff-43" } }, ctx: "ctx" }]);
  const legacyDelivery = createTelegramBusFollowerDeliveryIdentity({ kind: "leader.forwardMessage",
    recipientBindingKey: "workspace:recipient", sourceUpdateId: 43 });
  await assert.rejects(admission.admit({ kind: "leader.forwardMessage", requestId: "leader:mixed",
    recipientInstanceId: "recipient", recipientRegistrationGeneration: "g1",
    delivery: legacyDelivery, message: { pi_telegram_source_update_id: 43 }, sentAtMs: 2_001 }, "ctx"),
  /requires a recovery key/);
  assert.equal(wakes.length, 1);
  const missingClaim = createTelegramBusFollowerDeliveryIdentity({ kind: "leader.forwardMessage",
    recipientBindingKey: "workspace:recipient", sourceUpdateId: 43,
    sourceRecoveryKey: "journal:source-43" });
  await assert.rejects(admission.admit({ kind: "leader.forwardMessage", requestId: "leader:no-claim",
    recipientInstanceId: "recipient", recipientRegistrationGeneration: "g1",
    delivery: missingClaim, message: { pi_telegram_source_update_id: 43 }, sentAtMs: 2_002 }, "ctx"),
  /requires exact claim evidence/);
  assert.equal(wakes.length, 1);
});

test("Bus follower receiver gates source-reference wake across replay and replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-source-reference-"));
  const socketPath = join(dir, "follower.sock");
  const delivery = createTelegramBusFollowerDeliveryIdentity({ kind: "leader.wakeInputCustody",
    recipientBindingKey: "workspace:recipient", sourceUpdateId: 43,
    sourceRecoveryKey: "journal:source-43",
    sourceClaim: { acquisitionId: "acquisition-43", handoffId: "handoff-43" } });
  const wakes: unknown[] = [];
  const sourceReferenceAdmission = createTelegramBusFollowerSourceReferenceAdmissionRuntime({
    wakeSource(input) { wakes.push(input); },
  });
  let legacyAdmissions = 0;
  const createReceiver = (withWake: boolean) => createTelegramBusForwardedUpdateReceiverRuntime({
    socketPath, instanceId: "recipient", getRegistrationGeneration: () => "g2",
    getRecipientBindingKey: () => "workspace:recipient", isSourceReferenceAdmissionEnabled: () => true,
    hasAuthenticatedSourceReferenceTransport: () => true,
    ...(withWake ? { sourceReferenceAdmission } : {}),
    durableAdmission: { async admit() { legacyAdmissions += 1; throw new Error("legacy copy invoked"); } },
    getContext: () => "ctx",
  });
  const send = async (requestId: string, generation = "g2") => {
    const response = await sendTelegramBusLocalEnvelope({ socketPath,
      envelope: { kind: "leader.wakeInputCustody", requestId, recipientInstanceId: "recipient",
        recipientRegistrationGeneration: generation, delivery, sentAtMs: 2_000 } });
    if (response?.kind !== "bus.ack") throw new Error("missing bus ACK");
    return response;
  };
  let receiver = createReceiver(true);
  try {
    await receiver.start();
    assert.equal((await send("leader:ref-1")).ok, true);
    assert.equal((await send("leader:ref-2")).ok, true);
    assert.equal((await send("leader:stale", "g1")).ok, false);
    assert.deepEqual(wakes, [{ deliveryId: delivery.deliveryId, sourceUpdateId: 43,
      recipientBindingKey: "workspace:recipient", sourceRecoveryKey: "journal:source-43",
      sourceClaim: { acquisitionId: "acquisition-43", handoffId: "handoff-43" } },
    { deliveryId: delivery.deliveryId, sourceUpdateId: 43,
      recipientBindingKey: "workspace:recipient", sourceRecoveryKey: "journal:source-43",
      sourceClaim: { acquisitionId: "acquisition-43", handoffId: "handoff-43" } }]);
    assert.equal(legacyAdmissions, 0);
    await receiver.stop();
    receiver = createReceiver(false);
    await receiver.start();
    const unavailable = await send("leader:no-wake");
    assert.equal(unavailable.ok, false);
    assert.match(unavailable.message ?? "", /enabled without a wake authority/);
    assert.equal(legacyAdmissions, 0);
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
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 }, { generation: "g" });
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
      registrationGeneration: "g",
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

test("Follower target replacement is rejected before store mutation by a retained fence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-replacement-fence-"));
  const admission = createTelegramWorkspaceAdmissionLedger({
    path: join(dir, "workspace-admission.json"),
    profileKey: "profile:follower-replacement",
    owner: {
      processId: process.pid,
      processBirthId: `${process.pid}:follower-replacement-test`,
    },
    getProcessLiveness: () => "alive",
  });
  const fence = admission.acquireRetirementFence({
    operationId: "follower-replacement-fence",
    retirementIntentId: "follower-replacement-intent",
    bindingKey: "follower-replacement-binding",
    slot: "E",
    target: { chatId: 42, threadId: 10 },
    leaderEpoch: 1,
    retirementRequestedAtMs: 1,
  });
  assert.equal(fence.kind, "acquired");
  const registrationState = createTelegramBusFollowerRegistrationState();
  registrationState.setRegistered(
    true,
    { chatId: 42, threadId: 10 },
    { generation: "g", slot: "E" },
  );
  let loaded = false;
  const handler = createTelegramBusFollowerTargetReplacementHandler({
    topicTargetStore: {
      async load() {
        loaded = true;
      },
      list: () => [],
      markStaleByTarget: () => true,
      upsert: (record) => record,
      async persist() {},
    },
    registrationState,
    instanceId: "inst-a",
    getManualFollowerProfileKey: () => "manual:a",
    manualFollowerOwnerId: "a",
    getWorkspaceAdmission: () => admission,
    getSyncState: () => ({}),
    setSyncState() {},
    updateStatus() {},
  });
  try {
    await assert.rejects(
      async () => {
        await handler(
          {
            target: { chatId: 42, threadId: 11 },
            oldTarget: { chatId: 42, threadId: 10 },
            reason: "thread-restore",
            registrationGeneration: "g",
          },
          "ctx",
        );
      },
      /blocked by retirement/u,
    );
    assert.equal(loaded, false);
    assert.deepEqual(registrationState.getTarget(), {
      chatId: 42,
      threadId: 10,
    });
  } finally {
    if (fence.kind === "acquired") {
      admission.releaseUnissuedRetirementFence(fence.fence);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Follower target replacement rechecks generation and old target after store load", async () => {
  for (const replacement of [
    { generation: "new", target: { chatId: 42, threadId: 10 } },
    { generation: "g", target: { chatId: 42, threadId: 12 } },
    { generation: "g", target: { chatId: 42, threadId: 10 }, storeTarget: { chatId: 42, threadId: 12 } },
  ]) {
    const state = createTelegramBusFollowerRegistrationState();
    state.setRegistered(true, { chatId: 42, threadId: 10 }, { generation: "g" });
    const handler = createTelegramBusFollowerTargetReplacementHandler({
      topicTargetStore: {
        load: async () => { state.setRegistered(true, replacement.target, replacement); },
        list: () => replacement.storeTarget ? [{
          profileKey: "manual:f", instanceId: "f", target: replacement.storeTarget,
          status: "active", createdAtMs: 1, updatedAtMs: 1,
        }] : [],
        markStaleByTarget: () => { assert.fail("stale authority mutated binding"); },
        upsert: () => { assert.fail("stale authority upserted binding"); },
        persist: async () => { assert.fail("stale authority persisted binding"); },
      },
      registrationState: state,
      instanceId: "f", getManualFollowerProfileKey: () => "manual:f", manualFollowerOwnerId: "f",
      getSyncState: () => ({}), setSyncState: () => assert.fail("stale sync mutation"), updateStatus: () => {},
    });
    await assert.rejects(async () => handler({ target: { chatId: 42, threadId: 11 }, oldTarget: { chatId: 42, threadId: 10 }, registrationGeneration: "g", reason: "thread-restore" }, "ctx"), /replacement (authority|target)/);
    assert.deepEqual(state.getTarget(), replacement.target);
  }
});

test("Follower restore does not acknowledge a generation replaced during persistence", async () => {
  const state = createTelegramBusFollowerRegistrationState();
  state.setRegistered(true, { chatId: 42, threadId: 10 }, {
    generation: "old", slot: "A",
  });
  const replacement = { chatId: 42, threadId: 12 };
  const handler = createTelegramBusFollowerTargetReplacementHandler({
    topicTargetStore: {
      load: async () => {},
      list: () => [],
      markStaleByTarget: () => true,
      upsert: (record) => record,
      persist: async () => { state.setRegistered(true, replacement, {
        generation: "new", slot: "A",
      }); },
    },
    registrationState: state,
    instanceId: "f", getManualFollowerProfileKey: () => "manual:f", manualFollowerOwnerId: "f",
    getSyncState: () => ({}),
    setSyncState: () => assert.fail("obsolete completion changed sync state"),
    updateStatus: () => assert.fail("obsolete completion updated status"),
  });
  await assert.rejects(async () => handler({ target: { chatId: 42, threadId: 11 }, oldTarget: { chatId: 42, threadId: 10 }, registrationGeneration: "old", reason: "thread-restore" }, "ctx"), /replacement authority/);
  assert.deepEqual(state.getTarget(), replacement);
  assert.equal(state.getGeneration(), "new");
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
  registrationState.setRegistered(true, { chatId: 42, threadId: 10 }, {
    generation: "g", slot: "A",
  });
  await handler(
    {
      target: { chatId: 42, threadId: 11 },
      oldTarget: { chatId: 42, threadId: 10 },
      reason: "thread-restore",
      registrationGeneration: "g",
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
      provisionFollowerTarget: () => ({ chatId: 7, threadId: 42, slot: "A" }),
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
    assert.equal(registrationState.getSlot(), "A");
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

test("Bus follower restore-only registration exits quietly without a remembered Workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-follower-auto-connect-"));
  const socketPath = join(dir, "bus.sock");
  let restoreOnly = false;
  const registry = createTelegramBusFollowerRegistry();
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      provisionFollowerTarget(_registration, options) {
        restoreOnly = options?.existingWorkspaceBindingOnly === true;
        return undefined;
      },
    }),
  });
  const state = createTelegramBusFollowerRegistrationState();
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => "inst-a:restore:1",
    registrationState: state,
  });
  try {
    await server.start();
    assert.equal(
      await follower.registerWithLeader(
        { cwd: "/repo" },
        { busSocketPath: socketPath },
        { restoreWorkspace: true },
      ),
      false,
    );
    assert.equal(restoreOnly, true);
    assert.equal(state.isRegistered(), false);
    assert.equal(registry.get("inst-a"), undefined);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Restore-only registration carries its acknowledged title before the first heartbeat without allocating missing Workspaces", { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-display-auto-connect-"));
  const socketPath = join(dir, "bus.sock");
  const store = createTelegramTopicTargetStore({ path: join(dir, "state.json"), getNowMs: () => 1000 });
  store.upsertWorkspaceBinding({ ...createTelegramWorkspaceBindingIdentity("/repo")!,
    target: { chatId: 7, threadId: 42 }, slot: "A", threadName: "Anchor",
    displayTitle: "repo_a", updatedAtMs: 1 });
  const calls: string[] = [];
  let syncState = {};
  const provisionFollowerTarget = createTelegramBusFollowerTargetProvisioner({
    getAllowedUserId: () => 7, topicTargetStore: store,
    async callApi<TResponse>(method: string) {
      calls.push(method);
      if (method === "createForumTopic") throw new Error("restore-only startup must not create a Thread");
      return { ok: true } as TResponse;
    },
    getSyncState: () => syncState, setSyncState(state) { syncState = state; },
    recordRuntimeEvent() {}, getNowMs: () => 1000,
  });
  const registry = createTelegramBusFollowerRegistry();
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test",
    capabilities: [...TEST_BUS_PROTOCOL_IDENTITY.capabilities, TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE] });
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry, protocolIdentity: protocol,
      getThreadDisplayMode: () => "directories", provisionFollowerTarget,
      getFollowerDisplayTitle(follower) {
        return store.listWorkspaceBindings().find((binding) =>
          binding.target.chatId === follower.target?.chatId &&
          binding.target.threadId === follower.target?.threadId,
        )?.displayTitle;
      },
    }),
  });
  const state = createTelegramBusFollowerRegistrationState();
  let titleAtRegistration: string | undefined;
  let sequence = 0;
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "reopened", protocolIdentity: protocol,
    createRequestId: () => `reopened:${++sequence}`, registrationState: state,
    heartbeatMs: 60_000,
    onRegistered() { titleAtRegistration = state.getDisplayTitle(); },
  });
  const missingState = createTelegramBusFollowerRegistrationState();
  const missing = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "missing", protocolIdentity: protocol,
    createRequestId: () => `missing:${++sequence}`, registrationState: missingState,
  });
  try {
    await store.persist();
    await server.start();
    assert.equal(await follower.registerWithLeader({ cwd: "/repo/" }, { busSocketPath: socketPath },
      { restoreWorkspace: true }), true);
    assert.equal(titleAtRegistration, "repo_a");
    assert.equal(state.getThreadName(), "Anchor");
    assert.equal(state.getDisplayTitle(), "repo_a");
    assert.deepEqual(state.getTarget(), { chatId: 7, threadId: 42 });
    assert.equal(state.getSlot(), "A");
    assert.equal(await missing.registerWithLeader({ cwd: "/missing" }, { busSocketPath: socketPath },
      { restoreWorkspace: true }), false);
    assert.equal(missingState.isRegistered(), false);
    assert.equal(store.hasWorkspaceBinding("/missing"), false);
    assert.equal(registry.get("missing"), undefined);
    assert.deepEqual(calls, ["sendMessage"]);
  } finally {
    follower.stop(); missing.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Heartbeat ACK carries display titles without changing the follower's stable name", { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-display-heartbeat-"));
  const socketPath = join(dir, "bus.sock");
  const state = createTelegramBusFollowerRegistrationState();
  let shown!: () => void;
  const updated = new Promise<void>((resolve) => { shown = resolve; });
  let displayTitle: string | undefined;
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: createTelegramBusFollowerRegistry(),
      provisionFollowerTarget: () => ({ chatId: 7, threadId: 42, slot: "A", threadName: "Anchor" }),
      getFollowerDisplayTitle: () => displayTitle,
    }),
  });
  let sequence = 0;
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "inst-a",
    createRequestId: () => `inst-a:${++sequence}`,
    registrationState: state,
    heartbeatMs: 5,
    onDisplayTitleChanged() {
      shown();
      throw new Error("UI unavailable");
    },
  });
  try {
    await server.start();
    await follower.registerWithLeader({ cwd: "/repo" }, { busSocketPath: socketPath });
    displayTitle = "extensions_a";
    await updated;
    assert.equal(state.getDisplayTitle(), "extensions_a");
    assert.equal(state.getThreadName(), "Anchor");
    assert.equal(state.isRegistered(), true);
    assert.equal(state.setDisplayTitle("obsolete", "wrong-generation"), false);
    assert.equal(state.getDisplayTitle(), "extensions_a");
    follower.stop();
    assert.equal(state.getDisplayTitle(), undefined);
  } finally {
    follower.stop();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Follower display setting requests negotiate capability and reject lost leader authority", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-display-setting-ipc-"));
  const socketPath = join(dir, "bus.sock");
  const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "test",
    capabilities: [...TEST_BUS_PROTOCOL_IDENTITY.capabilities, TELEGRAM_BUS_CAPABILITY_THREAD_DISPLAY_MODE] });
  let epoch = 1;
  const modes: string[] = [];
  const server = createTelegramBusLocalServer({ socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      protocolIdentity: protocol,
      followerRegistry: createTelegramBusFollowerRegistry(),
      getCurrentLeaderEpoch: () => epoch,
      provisionFollowerTarget: () => ({ chatId: 7, threadId: 42, slot: "A" }),
      async applyThreadDisplayMode(mode, isCurrent) {
        assert.equal(isCurrent(), true);
        modes.push(mode);
        if (mode === "names") epoch++;
      },
    }),
  });
  const state = createTelegramBusFollowerRegistrationState();
  let sequence = 0;
  const follower = createTelegramBusFollowerRegistrationRuntime({
    instanceId: "follower", protocolIdentity: protocol, registrationState: state,
    createRequestId: () => `follower:${++sequence}`,
  });
  try {
    await server.start();
    await follower.registerWithLeader({ cwd: "/repo" }, { busSocketPath: socketPath });
    await follower.setThreadDisplayMode?.("directories");
    assert.deepEqual(modes, ["directories"]);
    await assert.rejects(follower.setThreadDisplayMode!("names"), /stale registration/);
    state.setRegistered(true, state.getTarget(), {
      generation: state.getGeneration(), leaderProtocol: TEST_BUS_PROTOCOL_IDENTITY,
    });
    await assert.rejects(follower.setThreadDisplayMode!("letters"), /do not support/);
    assert.deepEqual(modes, ["directories", "names"]);
  } finally {
    follower.stop(); await server.stop(); rmSync(dir, { recursive: true, force: true });
  }
});

test("Registration title admission rejects malformed titles and requires target and generation", () => {
  const state = createTelegramBusFollowerRegistrationState();
  const target = { chatId: 7, threadId: 42 };
  for (const displayTitle of ["", "  ", "x".repeat(129)]) {
    state.setRegistered(true, target, { generation: "one", displayTitle });
    assert.equal(state.getDisplayTitle(), undefined);
  }
  state.setRegistered(true, target, { displayTitle: "repo" });
  assert.equal(state.getDisplayTitle(), undefined);
  state.setRegistered(true, undefined, { generation: "one", displayTitle: "repo" });
  assert.equal(state.getDisplayTitle(), undefined);
  state.setRegistered(true, target, { generation: "one", displayTitle: "repo", threadName: "Anchor" });
  assert.equal(state.getDisplayTitle(), "repo");
  assert.equal(state.getThreadName(), "Anchor");
  state.setRegistered(false);
  assert.equal(state.getDisplayTitle(), undefined);
});

test("Follower metadata refresh keeps the display title only within one target and generation", () => {
  const state = createTelegramBusFollowerRegistrationState();
  const target = { chatId: 7, threadId: 42 };
  state.setRegistered(true, target, { generation: "one", threadName: "Anchor" });
  assert.equal(state.setDisplayTitle("repo_a", "one"), true);
  state.setRegistered(true, target, { generation: "one", threadName: "Navigator" });
  assert.equal(state.getDisplayTitle(), "repo_a");
  assert.equal(state.getThreadName(), "Navigator");
  state.setRegistered(true, target, { generation: "two", threadName: "Navigator" });
  assert.equal(state.getDisplayTitle(), undefined);
  state.setDisplayTitle("repo_a", "two");
  state.setRegistered(true, { chatId: 7, threadId: 43 }, { generation: "two", threadName: "Navigator" });
  assert.equal(state.getDisplayTitle(), undefined);
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
        return { chatId: -1007, threadId: 42, slot: "A" };
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
        return { chatId: -1007, threadId: 42, slot: "A" };
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
      slot: "A",
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
    capabilities: [TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME],
  });
  const followerProtocol = createTelegramBusProtocolIdentity({
    runtimeBuild: "0.28.1",
    capabilities: [TELEGRAM_BUS_CAPABILITY_WORKSPACE_THREAD_RENAME],
  });
  const registrationState = createTelegramBusFollowerRegistrationState();
  let disconnects = 0;
  const renames: string[] = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: createTelegramBusLeaderEnvelopeHandler({
      followerRegistry: registry,
      protocolIdentity: leaderProtocol,
      getNowMs: () => 1000,
      provisionFollowerTarget() {
        return { chatId: 7, threadId: 42, slot: "A" };
      },
      onFollowerDisconnected() {
        disconnects += 1;
      },
      renameFollowerThread(_follower, threadName) {
        renames.push(threadName);
        return { threadName };
      },
      resetFollowerThreadName() {
        return { threadName: "A" };
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
      target: { chatId: 7, threadId: 42, slot: "A" },
      slot: "A",
    });
    assert.deepEqual(registrationState.getLeaderProtocol(), leaderProtocol);
    assert.equal(await follower.renameThread?.(
      { chatId: 7, threadId: 42 }, "Navigator",
    ), "Navigator");
    assert.deepEqual(renames, ["Navigator"]);
    assert.equal(registry.get("inst-a")?.threadName, "Navigator");
    assert.equal(registrationState.getThreadName(), "Navigator");
    assert.equal(await follower.resetThreadName?.(
      { chatId: 7, threadId: 42 },
    ), "A");
    assert.equal(registry.get("inst-a")?.threadName, "A");
    assert.equal(registrationState.getThreadName(), "A");
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
      500,
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
