/**
 * Regression tests for Telegram binding composition
 * Covers lifecycle binding delegation across composed runtimes
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTelegramActivityBindingRuntime,
  createTelegramAgentMessageToolRoutingRuntime,
  createTelegramAssistantOutputBindingRuntime,
  createTelegramQueueBindingRuntime,
  createTelegramGenerativeAppBoundButtonActionInvoker,
  registerTelegramCommandsAndTools,
  registerTelegramLifecycleRuntimeHooks,
} from "../lib/bindings.ts";
import * as Activity from "../lib/activity.ts";
import * as Config from "../lib/config.ts";
import * as Bus from "../lib/bus.ts";
import * as BusApi from "../lib/bus-api.ts";
import * as BusFollower from "../lib/bus-follower.ts";
import * as BusLeader from "../lib/bus-leader.ts";
import type { TelegramBridgeApiRuntime } from "../lib/telegram-api.ts";
import * as Outbound from "../lib/outbound.ts";
import * as OutboundAttachments from "../lib/outbound-attachments.ts";
import * as Queue from "../lib/queue.ts";
import * as Runtime from "../lib/runtime.ts";
import * as GenerativeApps from "../lib/generative-apps.ts";
import type { TelegramQueueAdmissionItemLike } from "../lib/updates.ts";
import type { ExtensionAPI, ExtensionContext } from "../lib/pi.ts";

type RegisteredBindingHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => Promise<unknown> | unknown;

type RegisteredBindingTool = {
  name?: string;
  execute: (
    toolCallId: string,
    params: Record<string, string>,
  ) => Promise<unknown>;
};

function createBindingApiHarness() {
  const handlers = new Map<string, RegisteredBindingHandler>();
  const tools = new Map<string, RegisteredBindingTool>();
  const commands = new Map<string, unknown>();
  const messages: Array<{ message: unknown; options?: unknown }> = [];
  const api = {
    on: (event: string, handler: RegisteredBindingHandler) => {
      handlers.set(event, handler);
    },
    registerTool: (definition: RegisteredBindingTool) => {
      if (definition.name) tools.set(definition.name, definition);
    },
    registerCommand: (name: string, definition: unknown) => {
      commands.set(name, definition);
    },
    sendMessage: (message: unknown, options?: unknown) => {
      messages.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  return { api, handlers, tools, commands, messages };
}

test("Generative App bound-button composition rejects a retained stale revision before delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-binding-app-"));
  const agentDir = join(root, "agent");
  const script = join(root, "counter.mjs");
  const store = Outbound.createTelegramButtonActionStore();
  const edited: string[] = [];
  const sent: string[] = [];
  try {
    await writeFile(
      script,
      `
export function init() { return { state: { count: 0 }, output: "ready" }; }
export function increment({ state }) {
  return { state: { count: state.count + 1 }, output: "next", viewMode: "edit" };
}
`,
      "utf8",
    );
    const installed = await GenerativeApps.installGenerativeApp({ agentDir, app: "counter", script });
    const execution = new AbortController();
    const invoke = createTelegramGenerativeAppBoundButtonActionInvoker({
      agentDir,
      assertExecutionCurrent: () => undefined,
      getExecutionFence: () => ({
        assertCurrent: () => undefined,
        signal: execution.signal,
      }),
      planOutput: Outbound.createTelegramOutboundReplyPlanner(store),
      sendMarkdownReply: async (_chatId, _messageId, markdown) => {
        sent.push(markdown);
      },
      editInteractiveMessage: async (_chatId, _messageId, markdown) => {
        edited.push(markdown);
      },
      recordRuntimeEvent: () => undefined,
    });
    const action = {
      binding: { generation: installed.generation, app: "counter", revision: 0 },
      prompt: "counter::increment",
      text: "Next",
    };
    assert.equal(
      await invoke(
        action,
        { message: { chat: { id: 1 }, message_id: 2 } },
      ),
      "edit",
    );
    assert.deepEqual(edited, ["next"]);
    const invokeWithFallback = createTelegramGenerativeAppBoundButtonActionInvoker({
      agentDir,
      assertExecutionCurrent: () => undefined,
      getExecutionFence: () => ({
        assertCurrent: () => undefined,
        signal: execution.signal,
      }),
      planOutput: Outbound.createTelegramOutboundReplyPlanner(store),
      sendMarkdownReply: async (_chatId, _messageId, markdown) => {
        sent.push(markdown);
      },
      editInteractiveMessage: async () => {
        throw new Error("message not found");
      },
      recordRuntimeEvent: () => undefined,
    });
    assert.equal(
      await invokeWithFallback(
        {
          ...action,
          binding: {
            generation: installed.generation,
            app: "counter",
            revision: 1,
          },
        },
        { message: { chat: { id: 1 }, message_id: 2 } },
      ),
      "new",
    );
    assert.deepEqual(sent, ["next"]);
    await assert.rejects(
      invoke(
        action,
        { message: { chat: { id: 1 }, message_id: 2 } },
      ),
      /action is stale/,
    );
    assert.deepEqual(edited, ["next"]);
    assert.deepEqual(sent, ["next"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Agent message tool routing selects leader or follower composition", async () => {
  let leader = true;
  let followerRegistered = false;
  const calls: string[] = [];
  const runtime = createTelegramAgentMessageToolRoutingRuntime({
    ownsLeader: () => leader,
    ownsDirectDelivery: () => leader,
    isFollowerRegistered: () => followerRegistered,
    getSourceTarget: () => ({ chatId: 7, threadId: 10 }),
    getSourceThreadName: () => "Source",
    local: {
      resolveTarget: (_selector, sourceTarget) => {
        calls.push(`local-resolve:${sourceTarget?.threadId}`);
        return { chatId: 7, threadId: 20 };
      },
      async route(input) {
        calls.push(`local-route:${input.sourceThreadName}`);
      },
    },
    follower: {
      async resolveTarget() {
        calls.push("follower-resolve");
        return { chatId: 7, threadId: 30 };
      },
      async routeMessage() {
        calls.push("follower-route");
      },
    },
  });
  assert.deepEqual(await runtime.resolveAgentTarget({ threadId: 20 }), {
    chatId: 7,
    threadId: 20,
  });
  await runtime.routeAgentMessage({
    target: { chatId: 7, threadId: 20 },
    text: "hello",
    messageId: 1,
  });
  assert.equal(runtime.canSendDirect(), true);
  leader = false;
  followerRegistered = true;
  assert.deepEqual(await runtime.resolveAgentTarget({ threadId: 30 }), {
    chatId: 7,
    threadId: 30,
  });
  await runtime.routeAgentMessage({
    target: { chatId: 7, threadId: 30 },
    text: "hello",
    messageId: 2,
  });
  assert.equal(runtime.canSendDirect(), true);
  assert.deepEqual(calls, [
    "local-resolve:10",
    "local-route:Source",
    "follower-resolve",
    "follower-route",
  ]);
});

test("Queue binding requires durable handoff for every burst item and fails closed on missing settlement", () => {
  for (const mode of ["success", "missing", "uncompleted"] as const) {
    const store = Queue.createTelegramQueueStore<string>();
    const deferredDispatch = Queue.createTelegramDeferredQueueDispatchRuntime<string>();
    deferredDispatch.bind("ctx");
    const committed = new Set<number>();
    const events: string[] = [];
    let available = true;
    const settlement = {
      isItemReady: (item: TelegramQueueAdmissionItemLike) =>
        !committed.has(item.admissionReceipts![0]!.sourceUpdateIds[0]!),
      onPromptHandedOff: (item: TelegramQueueAdmissionItemLike) => {
        const id = item.admissionReceipts![0]!.sourceUpdateIds[0]!;
        events.push(`commit:${id}`);
        if (mode === "success") committed.add(id);
      },
      onItemsDiscarded: () => {}, onControlSettled: () => {},
    };
    const runtime = createTelegramQueueBindingRuntime({
      store, queue: { allocateItemOrder: () => 0 }, deferredDispatch,
      lifecycle: { isCompactionInProgress: () => false, hasDispatchPending: () => false },
      activeTurn: { has: () => false },
      admission: {
        getSettlement: () => available ? settlement : undefined,
        hasPendingQueueMutationForItem: () => false,
      },
      transportStamp: { isActive: () => true },
      promptDispatch: {
        startTypingLoop: () => {},
        onPromptDispatchStart: () => { if (mode === "missing") available = false; },
        onPromptDispatchFailure: () => { events.push("failed"); },
      },
      isIdle: () => true, hasPendingMessages: () => false, updateStatus: () => {},
      sendTextReply: async () => undefined,
      sendUserMessage: () => {
        const item = store.getQueuedItems()[0]!;
        events.push(`send:${item.queueOrder}`);
        if (!committed.has(item.queueOrder)) events.push("uncommitted-send");
        store.setQueuedItems(store.getQueuedItems().slice(1));
      },
    });
    for (let id = 1; id <= 3; id++) {
      runtime.mutation.append({
        kind: "prompt", chatId: 7, replyToMessageId: id, sourceMessageIds: [id],
        admissionReceipts: [{ queueKind: "prompt", receiptId: `receipt-${id}`, sourceUpdateIds: [id] }],
        queueOrder: id, queueLane: "default", laneOrder: id, queuedAttachments: [],
        content: [{ type: "text", text: `prompt-${id}` }], historyText: "", statusSummary: "prompt",
      }, "ctx");
    }
    for (let index = 0; index < 3; index++) runtime.dispatchNext("ctx");
    if (mode === "success") {
      assert.deepEqual(events, ["commit:1", "send:1", "commit:2", "send:2", "commit:3", "send:3"]);
      assert.equal(store.getQueuedItems().length, 0);
    } else {
      assert.ok(!events.some((event) => event.startsWith("send:")));
      assert.ok(events.includes("failed"));
      assert.equal(store.getQueuedItems().length, 3);
      assert.equal(committed.size, 0);
    }
  }
});

test("Queue binding composes mutation, admission, dispatch, and watchdog ports", () => {
  const events: string[] = [];
  const store = Queue.createTelegramQueueStore<string>();
  const deferredDispatch =
    Queue.createTelegramDeferredQueueDispatchRuntime<string>();
  deferredDispatch.bind("ctx");
  let nextLaneOrder = 0;
  let admissionReady = true;
  const runtime = createTelegramQueueBindingRuntime({
    store,
    queue: {
      allocateItemOrder: () => nextLaneOrder++,
    },
    lifecycle: {
      isCompactionInProgress: () => false,
      hasDispatchPending: () => false,
    },
    activeTurn: { has: () => false },
    admission: {
      getSettlement: () => ({
        onItemsDiscarded: (items) => {
          events.push(`discard:${items.length}`);
        },
        isItemReady: () => admissionReady,
        onPromptHandedOff: () => {
          admissionReady = false;
          events.push("prompt-committed");
        },
        onControlSettled: () => {
          events.push("control-settled");
        },
      }),
      hasPendingQueueMutationForItem: () => false,
    },
    transportStamp: { isActive: () => true },
    deferredDispatch,
    promptDispatch: {
      startTypingLoop: () => {},
      onPromptDispatchStart: () => {
        events.push("dispatch-start");
      },
      onPromptDispatchFailure: () => {
        events.push("dispatch-failure");
      },
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    updateStatus: () => {
      events.push("status");
    },
    sendTextReply: async () => undefined,
    sendUserMessage: () => {
      events.push("send");
    },
  });
  runtime.mutation.append(
    {
      kind: "prompt",
      chatId: 7,
      replyToMessageId: 10,
      sourceMessageIds: [10],
      admissionReceipts: [
        {
          queueKind: "prompt",
          receiptId: "prompt-10",
          sourceUpdateIds: [10],
        },
      ],
      queueOrder: 1,
      queueLane: "default",
      laneOrder: 1,
      queuedAttachments: [],
      content: [{ type: "text", text: "prompt" }],
      historyText: "prompt",
      statusSummary: "prompt",
    },
    "ctx",
  );
  assert.equal(
    runtime.mutation.applyReactionByMessageId(
      10,
      { kind: "priority", emoji: "👍" },
      "ctx",
    ),
    true,
  );
  runtime.dispatchNext("ctx");
  assert.equal(runtime.mutation.removeByMessageIds([10], "ctx"), 1);
  assert.equal(nextLaneOrder, 1);
  assert.deepEqual(events, [
    "status",
    "status",
    "dispatch-start",
    "prompt-committed",
    "send",
    "discard:1",
    "status",
  ]);
});

for (const preparation of ["text", "voice", "attachment"] as const) {
for (const replaceRegistration of [false, true]) {
  test(`Follower IPC fences delayed ${preparation} preparation${replaceRegistration ? " across registration replacement" : " before later activity"}`, { timeout: 10_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-publication-"));
    const socketPath = join(dir, "leader.sock");
    const committed: string[] = [];
    const failures: unknown[] = [];
    let generation = "registration-1";
    let requestId = 0;
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const registry = Bus.createTelegramBusFollowerRegistry();
    const register = () => registry.register({
      instanceId: "follower", connectedAtMs: Date.now(),
      registrationGeneration: generation, target: { chatId: 7, threadId: 42 },
    });
    register();
    const server = Bus.createTelegramBusLocalServer({
      socketPath,
      handleEnvelope: BusLeader.createTelegramBusLeaderEnvelopeHandler({
        followerRegistry: registry,
        authSecret: "fixture-secret",
        protocolIdentity: Bus.createTelegramBusProtocolIdentity({ runtimeBuild: "test" }),
        authorizeFollowerApiCall: Bus.isTelegramFollowerApiCallAllowed,
        callApi: async (method, args) => {
          if (method === "callMultipart") {
            assert.equal(args[0], preparation === "voice" ? "sendVoice" : "sendDocument");
            const fields = args[1] as Record<string, string>;
            assert.equal(fields.chat_id, "7");
            assert.equal(fields.message_thread_id, "42");
            committed.push(String(args[0]));
            return { message_id: committed.length };
          }
          assert.equal(method, "call");
          assert.equal(args[0], "sendRichMessage");
          const body = args[1] as { chat_id: number; message_thread_id: number; rich_message: { markdown?: string } };
          assert.equal(body.chat_id, 7);
          assert.equal(body.message_thread_id, 42);
          committed.push(body.rich_message.markdown ?? "tool");
          return { message_id: committed.length };
        },
      }),
    });
    const api = BusApi.createTelegramBusAwareApiRuntime({
      directRuntime: {} as TelegramBridgeApiRuntime,
      ownsDirect: () => false,
      callFollowerApi: BusFollower.createTelegramBusFollowerApiCaller({
        socketPath, instanceId: "follower",
        createRequestId: () => `publication-${++requestId}`,
        getAuthSecret: () => "fixture-secret",
        getRegistrationGeneration: () => generation,
      }),
    });
    const binding = createTelegramActivityBindingRuntime({
      generation: "session",
      assistantOutput: {
        authority: {
          getPreferredTarget: () => ({ chatId: 7, threadId: 42 }),
          getFallbackChatId: () => 7,
          getTransportStamp: () => "stamp",
          isTransportStampActive: () => true,
          ownsDirect: () => false,
          getDirectEpoch: () => undefined,
          isFollowerRegistered: () => true,
          getFollowerGeneration: () => generation,
        },
        sender: {
          sendMessage: api.sendMessage,
          sendRichMessage: api.sendRichMessage,
          editMessage: async () => undefined,
          getAssistantRenderingMode: () => "rich",
          getHandlers: () => [{ type: "text", template: "/fixture/prepare" }],
          execCommand: async (_command, _args, options) => {
            markStarted();
            await gate;
            return { stdout: options?.stdin ?? "", stderr: "", code: 0, killed: false };
          },
        },
        recordRuntimeEvent: (_category, error) => { failures.push(error); },
      },
      activityVerbosity: {
        getActivityMode: () => "tools",
        resolveTarget: () => ({ chatId: 7, threadId: 42 }),
        sendMessage: api.sendMessage,
        sendRichMessage: api.sendRichMessage,
        editMessageText: async () => "edited",
      },
    });
    const startTurn = () => {
      binding.activityRuntime.recordInputSource("extension");
      binding.activityRuntime.onAgentStart();
    };
    const finishTurn = () => {
      binding.activityRuntime.onAgentEnd();
      binding.activityRuntime.onAgentSettled();
    };
    const unregisterVoice = preparation === "voice"
      ? Outbound.registerTelegramVoiceSynthesisProvider(async () => {
          markStarted(); await gate;
          const path = join(dir, "voice.ogg");
          await writeFile(path, "fixture voice bytes");
          return path;
        }, { id: "publication-ipc-fixture" })
      : () => {};
    try {
      await server.start();
      binding.assistantOutputRuntime.start();
      binding.activityRuntime.onSessionStart?.();
      if (preparation === "text") {
        startTurn();
        binding.activityRuntime.onAssistantEvent({ type: "text_end", contentIndex: 0, content: "Prepared final" });
        binding.activityRuntime.onAssistantEvent({ type: "done" });
        finishTurn();
      } else {
        const path = join(dir, "artifact.txt");
        await writeFile(path, "fixture attachment");
        const authority = binding.publicationRuntime.capture();
        await Queue.handleTelegramAgentEndRuntime({
          turn: {
            kind: "prompt", chatId: 7, replyToMessageId: 1,
            target: { chatId: 7, threadId: 42 }, sourceMessageIds: [1],
            queueOrder: 1, queueLane: "default", laneOrder: 1,
            content: [{ type: "text", text: "fixture" }], historyText: "fixture", statusSummary: "fixture",
            queuedAttachments: preparation === "attachment" ? [{ path, fileName: "artifact.txt" }] : [],
          },
          assistant: { text: "Final caption" },
          foldQueuedPromptsIntoHistory: false,
          isTurnTransportActive: authority.isCurrent,
          resetRuntimeState: () => {}, updateStatus: () => {}, dispatchNextQueuedTelegramTurn: () => {},
          scheduleActiveTurnDelivery: (task) => { void binding.publicationRuntime.enqueue(task).catch((error) => failures.push(error)); },
          clearPreview: async () => {}, setPreviewPendingText: () => {}, finalizeMarkdownPreview: async () => false,
          sendMarkdownReply: async (_chat, _reply, text) => {
            await api.sendRichMessage({ chat_id: 7, message_thread_id: 42, rich_message: { markdown: text } });
          },
          sendTextReply: async () => { assert.fail("Unexpected attachment fallback"); },
          sendQueuedAttachments: OutboundAttachments.createTelegramQueuedOutboundAttachmentSender({
            statPath: async (file) => { markStarted(); await gate; return stat(file); },
            sendMultipart: api.callMultipart,
            sendTextReply: async () => { assert.fail("Unexpected attachment failure notice"); },
          }),
          planOutboundReply: preparation === "voice" ? () => ({ markdown: "", voiceText: "Spoken final" }) : undefined,
          sendOutboundReplyArtifacts: Outbound.createTelegramOutboundReplyArtifactSender({
            execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
            sendMultipart: api.callMultipart,
          }),
        });
      }
      await started;
      startTurn();
      binding.activityRuntime.onToolEnd({ toolCallId: "read", toolName: "read", result: "contents", isError: false });
      finishTurn();
      if (preparation !== "text") {
        const authority = binding.publicationRuntime.capture();
        void binding.publicationRuntime.enqueue(async () => {
          if (authority.isCurrent()) await api.sendRichMessage({ chat_id: 7, message_thread_id: 42, rich_message: { markdown: "Following notice" } });
        }).catch((error) => failures.push(error));
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      const prefix: string[] = [];
      assert.deepEqual(committed, prefix);
      if (replaceRegistration) {
        generation = "registration-2";
        register();
      }
      release();
      await binding.publicationRuntime.enqueue(async () => {});
      const expected = preparation === "text"
        ? ["Prepared final", "tool"]
        : preparation === "attachment"
          ? ["sendDocument", "Final caption", "tool", "Following notice"]
          : ["sendVoice", "tool", "Following notice"];
      assert.deepEqual(committed, replaceRegistration ? prefix : expected);
      assert.equal(requestId, replaceRegistration ? prefix.length : expected.length);
      assert.equal(failures.length, replaceRegistration && preparation === "text" ? 1 : 0);
      if (replaceRegistration) {
        if (preparation === "text") assert.match(String(failures[0]), /lost admission authority before transport mutation/);
        startTurn();
        binding.activityRuntime.onAssistantEvent({ type: "text_end", contentIndex: 0, content: "Fresh final" });
        binding.activityRuntime.onAssistantEvent({ type: "done" });
        finishTurn();
        await binding.publicationRuntime.enqueue(async () => {});
        assert.deepEqual(committed, [...prefix, "Fresh final"]);
        assert.equal(requestId, prefix.length + 1);
      }
    } finally {
      release();
      binding.activityRuntime.onSessionShutdown();
      binding.assistantOutputRuntime.stop();
      binding.activityVerbosityRuntime.stop();
      await server.stop();
      unregisterVoice();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
}

test("Activity binding composes bridge fanout and output ordering", async () => {
  const sent: string[] = [];
  const binding = createTelegramActivityBindingRuntime({
    generation: "generation-1",
    assistantOutput: {
      authority: {
        getPreferredTarget: () => ({ chatId: 7, threadId: 42 }),
        getFallbackChatId: () => 7,
        getTransportStamp: () => "stamp-1",
        isTransportStampActive: (stamp) => stamp === "stamp-1",
        ownsDirect: () => true,
        getDirectEpoch: () => 1,
        isFollowerRegistered: () => false,
        getFollowerGeneration: () => undefined,
      },
      sender: {
        sendMessage: async () => ({ message_id: 1 }),
        sendRichMessage: async (body) => {
          sent.push(body.rich_message.markdown ?? "");
          return { message_id: 2 };
        },
        editMessage: async () => undefined,
        getAssistantRenderingMode: () => "rich",
        execCommand: async (_command, _args, options) => ({
          stdout: options?.stdin ?? "",
          stderr: "",
          code: 0,
          killed: false,
        }),
      },
      recordRuntimeEvent: () => undefined,
    },
    activityVerbosity: {
      getActivityMode: () => "quiet",
      resolveTarget: (event) => event.target,
      sendMessage: async () => ({ message_id: 3 }),
      sendRichMessage: async () => ({ message_id: 4 }),
      editMessageText: async () => "edited",
    },
  });
  binding.assistantOutputRuntime.start();
  binding.activityRuntime.onSessionStart?.();
  binding.activityRuntime.recordInputSource("extension");
  binding.activityRuntime.onAgentStart();
  binding.activityRuntime.onAssistantEvent({
    type: "text_end",
    contentIndex: 0,
    content: "public output",
  });
  binding.activityRuntime.onAssistantEvent({ type: "done" });
  binding.activityRuntime.onAgentEnd();
  binding.activityRuntime.onAgentSettled();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await binding.assistantOutputRuntime.waitForIdle();
  assert.deepEqual(sent, ["public output"]);
  binding.activityVerbosityRuntime.stop();
  binding.assistantOutputRuntime.stop();
});

for (const [route, replaceAuthority] of [
  ["direct", false], ["follower", false],
  ["direct", true], ["follower", true],
] as const) {
test(`Activity publication preserves cross-turn order with ${route}${replaceAuthority ? " replacement" : ""}`, async () => {
  const sent: string[] = [];
  let epoch = 1;
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const binding = createTelegramActivityBindingRuntime({
    generation: "ordered-generation",
    assistantOutput: {
      authority: {
        getPreferredTarget: () => ({ chatId: 7, threadId: 42 }),
        getFallbackChatId: () => 7,
        getTransportStamp: () => "stamp",
        isTransportStampActive: () => true,
        ownsDirect: () => route === "direct",
        getDirectEpoch: () => epoch,
        isFollowerRegistered: () => route === "follower",
        getFollowerGeneration: () => `registration-${epoch}`,
      },
      sender: {
        sendMessage: async () => ({ message_id: 1 }),
        sendRichMessage: async () => { markStarted(); await gate; sent.push("assistant"); return { message_id: 2 }; },
        editMessage: async () => undefined,
        getAssistantRenderingMode: () => "rich",
        execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
      },
      recordRuntimeEvent: () => undefined,
    },
    activityVerbosity: {
      getActivityMode: () => "tools",
      resolveTarget: () => ({ chatId: 7, threadId: 42 }),
      sendMessage: async () => { sent.push("tool"); return { message_id: 3 }; },
      sendRichMessage: async () => { sent.push("tool"); return { message_id: 3 }; },
      editMessageText: async () => "edited",
    },
  });
  try {
    binding.assistantOutputRuntime.start();
    binding.activityRuntime.onSessionStart?.();
    binding.activityRuntime.recordInputSource("extension");
    binding.activityRuntime.onAgentStart();
    binding.activityRuntime.onAssistantEvent({ type: "text_end", contentIndex: 0, content: "Checkpoint" });
    binding.activityRuntime.onAssistantEvent({ type: "toolcall_start", contentIndex: 1 });
    binding.activityRuntime.onAgentEnd();
    binding.activityRuntime.onAgentSettled();
    binding.activityRuntime.recordInputSource("extension");
    binding.activityRuntime.onAgentStart();
    binding.activityRuntime.onToolStart({ toolCallId: "read-1", toolName: "read", args: { path: "fixture.txt" } });
    binding.activityRuntime.onToolEnd({ toolCallId: "read-1", toolName: "read", result: "fixture contents", isError: false });
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, []);
    if (replaceAuthority) epoch += 1;
    release();
    await binding.publicationRuntime.enqueue(async () => {});
    assert.deepEqual(sent, replaceAuthority ? ["assistant"] : ["assistant", "tool"]);
    if (replaceAuthority) {
      binding.activityRuntime.onAgentEnd();
      binding.activityRuntime.onAgentSettled();
      binding.activityRuntime.recordInputSource("extension");
      binding.activityRuntime.onAgentStart();
      binding.activityRuntime.onToolEnd({ toolCallId: "read-new", toolName: "read", result: "current output", isError: false });
      await binding.publicationRuntime.enqueue(async () => {});
      assert.deepEqual(sent, ["assistant", "tool"]);
    }
  } finally {
    release();
    binding.activityRuntime.onSessionShutdown();
    binding.assistantOutputRuntime.stop();
    binding.activityVerbosityRuntime.stop();
  }
});
}

test("Assistant output binding composes admission, delivery, and observation", async () => {
  const sent: string[] = [];
  const order: string[] = [];
  const binding = createTelegramAssistantOutputBindingRuntime({
    authority: {
      getPreferredTarget: () => ({ chatId: 7, threadId: 42 }),
      getFallbackChatId: () => 7,
      getTransportStamp: () => "stamp-1",
      isTransportStampActive: (stamp) => stamp === "stamp-1",
      ownsDirect: () => true,
      getDirectEpoch: () => 1,
      isFollowerRegistered: () => false,
      getFollowerGeneration: () => undefined,
    },
    sender: {
      sendMessage: async () => ({ message_id: 1 }),
      sendRichMessage: async (body) => {
        order.push("send");
        sent.push(body.rich_message.markdown ?? "");
        return { message_id: 2 };
      },
      editMessage: async () => undefined,
      getAssistantRenderingMode: () => "rich",
      execCommand: async (_command, _args, options) => ({
        stdout: options?.stdin ?? "",
        stderr: "",
        code: 0,
        killed: false,
      }),
    },
    waitForActivityIdle: async () => {
      order.push("activity-idle");
    },
    recordRuntimeEvent: () => undefined,
  });
  binding.runtime.start();
  binding.observeEvent({
    type: "assistant-segment",
    activityId: "activity-1",
    sequence: 1,
    source: "local",
    timestamp: 1,
    contentIndex: 0,
    text: "public output",
    placement: "final",
  });
  await binding.runtime.waitForIdle();
  assert.deepEqual(sent, ["public output"]);
  assert.deepEqual(order, ["activity-idle", "send"]);
});

function getRequiredBindingHandler(
  handlers: Map<string, RegisteredBindingHandler>,
  name: string,
): RegisteredBindingHandler {
  const handler = handlers.get(name);
  assert.ok(handler, `Expected binding handler ${name}`);
  return handler;
}

test("Command binding does not expose a thread rename tool", () => {
  const harness = createBindingApiHarness();
  registerTelegramCommandsAndTools({
    pi: harness.api,
    configStore: {
      get: () => ({}),
      getAllowedUserId: () => 840585,
      getOutboundHandlers: () => [],
      hasBotToken: () => true,
      load: async () => {},
      persist: async () => {},
      set: () => {},
    },
    setup: { start: () => true, finish: () => {} },
    activeTurnRuntime: { get: () => undefined },
    lockedPollingRuntime: {
      start: async () => ({ ok: true }),
      stop: async () => undefined,
    },
    getStatusLines: () => [],
    buttonActionStore: { register: () => "button-action" },
    sendMarkdownReply: async () => 1,
    callMultipart: async () => ({ ok: true }),
    getDefaultChatId: () => 840585,
    canSendDirect: () => true,
    updateStatus: () => {},
    recordRuntimeEvent: () => {},
  } as unknown as Parameters<typeof registerTelegramCommandsAndTools>[0]);
  assert.equal(harness.tools.has("telegram_rename_thread"), false);
});

test("Command binding scopes a requested Thread name to one polling start", async () => {
  const harness = createBindingApiHarness();
  let requestedThreadName: string | undefined;
  const observed: Array<string | undefined> = [];
  registerTelegramCommandsAndTools({
    pi: harness.api,
    configStore: {
      get: () => ({ botToken: "token" }),
      getStoredConfig: () => ({ botToken: "token" }),
      getActiveProfileName: () => undefined,
      activateProfile: () => true,
      getAllowedUserId: () => 840585,
      getOutboundHandlers: () => [],
      hasBotToken: () => true,
      load: async () => {},
      persist: async () => {},
      set: () => {},
    },
    setup: { start: () => true, finish: () => {} },
    activeTurnRuntime: { get: () => undefined },
    lockedPollingRuntime: {
      start: async () => {
        observed.push(requestedThreadName);
        return { ok: true };
      },
      stop: async () => undefined,
    },
    setRequestedThreadNameForPollingStart(threadName: string | undefined) {
      requestedThreadName = threadName;
    },
    getStatusLines: () => [],
    buttonActionStore: { register: () => "button-action" },
    sendMarkdownReply: async () => 1,
    callMultipart: async () => ({ ok: true }),
    getDefaultChatId: () => 840585,
    canSendDirect: () => true,
    updateStatus: () => {},
    recordRuntimeEvent: () => {},
  } as unknown as Parameters<typeof registerTelegramCommandsAndTools>[0]);
  const connect = harness.commands.get("telegram-connect") as {
    handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  };

  await connect.handler("as=Navigator", {
    cwd: "/repo",
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext);

  assert.deepEqual(observed, ["Navigator"]);
  assert.equal(requestedThreadName, undefined);
});

test("Command binding rejects a missing profile without stopping active polling", async () => {
  const harness = createBindingApiHarness();
  const events: string[] = [];
  let activeProfileName: string | undefined = "active";
  registerTelegramCommandsAndTools({
    pi: harness.api,
    configStore: {
      get: () => ({ botToken: "active-token" }),
      getStoredConfig: () => ({
        profiles: { active: { botToken: "active-token" } },
      }),
      getActiveProfileName: () => activeProfileName,
      activateProfile: (profileName?: string) => {
        events.push(`activate:${profileName ?? "default"}`);
        activeProfileName = profileName;
        return true;
      },
      getAllowedUserId: () => 840585,
      getOutboundHandlers: () => [],
      hasBotToken: () => true,
      load: async () => {
        events.push("load");
      },
      persist: async () => {},
      set: () => {},
    },
    setup: { start: () => true, finish: () => {} },
    activeTurnRuntime: { get: () => undefined },
    lockedPollingRuntime: {
      start: async () => {
        events.push("start");
        return { ok: true };
      },
      stop: async () => {
        events.push("stop");
      },
    },
    getStatusLines: () => [],
    buttonActionStore: { register: () => "button-action" },
    sendMarkdownReply: async () => 1,
    callMultipart: async () => ({ ok: true }),
    getDefaultChatId: () => 840585,
    canSendDirect: () => true,
    updateStatus: () => {
      events.push("status");
    },
    recordRuntimeEvent: () => {},
  } as unknown as Parameters<typeof registerTelegramCommandsAndTools>[0]);
  const connect = harness.commands.get("telegram-connect") as {
    handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  };
  const notifications: string[] = [];
  await connect.handler("missing", {
    cwd: "/repo",
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext);
  assert.equal(activeProfileName, "active");
  assert.deepEqual(events, ["load", "status"]);
  assert.deepEqual(notifications, ['Profile "missing" not found.']);
});

test("Named profile connect completes old teardown before activating new identity", async () => {
  const harness = createBindingApiHarness();
  const events: string[] = [];
  let activeProfileName: string | undefined = "active";
  let stopCompleted = false;
  registerTelegramCommandsAndTools({
    pi: harness.api,
    configStore: {
      get: () => ({ botToken: `${activeProfileName}-token` }),
      getStoredConfig: () => ({
        profiles: {
          active: { botToken: "active-token" },
          work: { botToken: "work-token" },
        },
      }),
      getActiveProfileName: () => activeProfileName,
      activateProfile: (profileName?: string) => {
        assert.equal(stopCompleted, true);
        events.push(`activate:${profileName ?? "default"}`);
        activeProfileName = profileName;
        return true;
      },
      getAllowedUserId: () => 840585,
      getOutboundHandlers: () => [],
      hasBotToken: () => true,
      load: async () => events.push("load"),
      persist: async () => {},
      set: () => {},
    },
    setup: { start: () => true, finish: () => {} },
    activeTurnRuntime: { get: () => undefined },
    lockedPollingRuntime: {
      start: async () => {
        events.push(`start:${activeProfileName}`);
        return { ok: true };
      },
      stop: async () => {
        events.push(`stop:${activeProfileName}`);
        await Promise.resolve();
        stopCompleted = true;
      },
    },
    getStatusLines: () => [],
    buttonActionStore: { register: () => "button-action" },
    sendMarkdownReply: async () => 1,
    callMultipart: async () => ({ ok: true }),
    getDefaultChatId: () => 840585,
    canSendDirect: () => true,
    updateStatus: () => events.push("status"),
    recordRuntimeEvent: () => {},
  } as unknown as Parameters<typeof registerTelegramCommandsAndTools>[0]);

  const connect = harness.commands.get("telegram-connect") as {
    handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  };
  await connect.handler("work", {
    cwd: "/repo",
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext);

  assert.equal(activeProfileName, "work");
  assert.deepEqual(events, [
    "load",
    "stop:active",
    "activate:work",
    "start:work",
    "status",
  ]);
  assert.deepEqual(harness.messages, [
    {
      message: {
        customType: "telegram-connection-state",
        content:
          "Telegram session connected. Use Telegram features for Telegram-originated turns or explicit Telegram requests; connectivity alone is not user intent.",
        display: false,
      },
      options: { deliverAs: "nextTurn" },
    },
  ]);
});

test("Named profile setup cancellation preserves the active runtime", async () => {
  const harness = createBindingApiHarness();
  const events: string[] = [];
  let activeProfileName: string | undefined = "active";
  registerTelegramCommandsAndTools({
    pi: harness.api,
    configStore: {
      get: () => ({ botToken: "active-token" }),
      getStoredConfig: () => ({
        profiles: { active: { botToken: "active-token" } },
      }),
      getActiveProfileName: () => activeProfileName,
      activateProfile: (profileName?: string) => {
        events.push(`activate:${profileName ?? "default"}`);
        activeProfileName = profileName;
        return true;
      },
      getAllowedUserId: () => 840585,
      getOutboundHandlers: () => [],
      hasBotToken: () => true,
      load: async () => undefined,
      persist: async () => {
        events.push("persist");
      },
      set: () => {
        events.push("set");
      },
    },
    setup: {
      start: () => {
        events.push("guard-start");
        return true;
      },
      finish: () => {
        events.push("guard-finish");
      },
    },
    activeTurnRuntime: { get: () => undefined },
    lockedPollingRuntime: {
      start: async () => {
        events.push("start");
        return { ok: true };
      },
      stop: async () => {
        events.push("stop");
      },
    },
    getStatusLines: () => [],
    buttonActionStore: { register: () => "button-action" },
    sendMarkdownReply: async () => 1,
    callMultipart: async () => ({ ok: true }),
    getDefaultChatId: () => 840585,
    canSendDirect: () => true,
    updateStatus: () => {
      events.push("status");
    },
    recordRuntimeEvent: () => {},
  } as unknown as Parameters<typeof registerTelegramCommandsAndTools>[0]);
  const setupCommand = harness.commands.get("telegram-setup") as {
    handler: (args: string, ctx: ExtensionContext) => Promise<void>;
  };
  const notifications: string[] = [];
  await setupCommand.handler("newprofile", {
    cwd: "/repo",
    hasUI: true,
    ui: {
      input: async () => undefined,
      editor: async () => undefined,
      notify: (message: string) => {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext);
  assert.equal(activeProfileName, "active");
  assert.deepEqual(events, ["guard-start", "guard-finish"]);
  assert.deepEqual(notifications, []);
});

test("Named setup preserves a display preference changed while the token form was open", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-setup-display-"));
  const configPath = join(dir, "telegram.json");
  const store = Config.createTelegramConfigStore({ agentDir: dir, configPath, initialConfig: {
    profiles: { default: { botToken: "default-token" },
      work: { botToken: "old-token", threadDisplayMode: "letters" } },
  } });
  await store.persist();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    ok: true, result: { id: 123, username: "testbot" },
  }), { headers: { "content-type": "application/json" } }));
  const harness = createBindingApiHarness();
  registerTelegramCommandsAndTools({
    pi: harness.api, configStore: store, persistConfig: store.persist,
    setup: { start: () => true, finish() {} }, activeTurnRuntime: { get: () => undefined },
    lockedPollingRuntime: { start: async () => ({ ok: true }), stop: async () => "stopped" },
    getStatusLines: () => [], buttonActionStore: { register: () => "button-action" },
    sendMarkdownReply: async () => 1, callMultipart: async () => ({ ok: true }),
    getDefaultChatId: () => 7, canSendDirect: () => true, updateStatus() {}, recordRuntimeEvent() {},
  } as unknown as Parameters<typeof registerTelegramCommandsAndTools>[0]);
  try {
    const setupCommand = harness.commands.get("telegram-setup") as {
      handler(args: string, ctx: ExtensionContext): Promise<void>;
    };
    await setupCommand.handler("work", {
      cwd: "/repo", hasUI: true,
      ui: {
        async editor() {
          const other = Config.createTelegramConfigStore({ agentDir: dir, configPath });
          await other.load(); other.activateProfile("work");
          await Config.setTelegramThreadDisplayMode(other, "directories", () => true);
          return "new-token";
        },
        async input() { return "new-token"; }, notify() {},
      },
    } as unknown as ExtensionContext);
    const saved = await Config.readTelegramConfig(configPath);
    assert.equal(saved.profiles?.work.botToken, "new-token");
    assert.equal(saved.profiles?.work.threadDisplayMode, "directories");
    assert.equal(store.getActiveProfileName(), "work");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Lifecycle binding disconnects only graceful quit and preserves cleanup after failure", async () => {
  const events: string[] = [];
  let disconnectFails = false;
  let automaticCleanupEnabled = true;
  const harness = createBindingApiHarness();
  const deps = {
    pi: harness.api,
    activityRuntime: {
      recordInputSource: () => {},
      onAgentStart: () => {},
      onAssistantEvent: () => {},
      onToolStart: () => {},
      onToolUpdate: () => {},
      onToolEnd: () => {},
      onCompactionStart: () => {},
      onCompactionEnd: () => {},
      onCompactionAbandoned: () => {},
      onAgentEnd: () => {},
      onAgentSettled: () => {},
      onSessionShutdown: () => {},
    },
    publicationRuntime: {
      ...Activity.createTelegramActivityPublicationRuntime(),
      capture: () => ({ target: { chatId: 7 }, isCurrent: () => true }),
    },
    assistantOutputRuntime: { start: () => {}, stop: () => {} },
    sessionLifecycleRuntime: {
      onSessionStart: async () => {
        events.push("session-start");
      },
      onSessionShutdown: async () => {
        events.push("composed-shutdown");
      },
      onModelSelect: () => {
        events.push("model-select");
      },
    },
    configStore: { get: () => ({}), getOutboundHandlers: () => [] },
    abort: { setHandler: () => {}, clearHandler: () => {} },
    typing: { stop: () => {}, waitForIdle: async () => {} },
    progress: {
      start: () => ({ active: true, chatId: 1, text: "", updatedAtMs: 0 }),
      update: () => undefined,
      stop: () => undefined,
      get: () => undefined,
    },
    lifecycle: {
      resetActiveToolExecutions: () => {},
      clearDispatchPending: () => {},
      hasDispatchPending: () => false,
      setFoldQueuedPromptsIntoHistory: () => {},
      shouldFoldQueuedPromptsIntoHistory: () => false,
      getActiveToolExecutions: () => 0,
      setActiveToolExecutions: () => {},
      setCompactionInProgress: () => {},
    },
    activeTurnRuntime: {
      clear: () => {},
      has: () => false,
      set: () => {},
      get: () => undefined,
    },
    telegramQueueStore: {
      getQueuedItems: () => [],
      setQueuedItems: () => {},
    },
    modelSwitchController: {
      clearPendingSwitch: () => {},
      triggerPendingAbort: () => {},
    },
    previewRuntime: {
      resetState: () => undefined,
      clear: () => {},
      setPendingText: () => {},
      onMessageStart: async () => {},
      onMessageUpdate: async () => {},
    },
    promptDispatchRuntime: {
      startTypingLoop: () => events.push("typing:start"),
    },
    deferredQueueDispatchRuntime: { request: () => {} },
    modelContextAvailabilityRuntime: { reconcile: () => {} },
    disconnectOnQuit: async () => {
      events.push("disconnect-on-quit");
      if (disconnectFails) throw new Error("cleanup unavailable");
    },
    resolveAutomaticThreadCleanupEnabled: async () =>
      automaticCleanupEnabled,
    buttonActionStore: { register: () => "button-action" },
    callMultipart: async () => ({ ok: true }),
    sendChatAction: async () => ({ ok: true }),
    sendRecordVoiceAction: async () => ({ ok: true }),
    sendMarkdownReply: async () => ({ ok: true }),
    sendTextReply: async () => ({ ok: true }),
    editInteractiveMessage: async () => undefined,
    deleteMessage: async () => undefined,
    dispatchNextQueuedTelegramTurn: () => {},
    answerGuestQuery: async () => ({ ok: true }),
    sendGuestReply: async () => ({ ok: true }),
    finalizeMarkdownPreview: async () => undefined,
    canSendAgentActivity: () => false,
    updateStatus: () => {},
    recordRuntimeEvent: (
      _category: string,
      _error: unknown,
      details?: { phase?: string },
    ) => {
      if (details?.phase) events.push(`runtime:${details.phase}`);
    },
  } as unknown as Parameters<typeof registerTelegramLifecycleRuntimeHooks>[0];

  registerTelegramLifecycleRuntimeHooks(deps);
  await getRequiredBindingHandler(harness.handlers, "session_before_compact")(
    { type: "session_before_compact" },
    {} as ExtensionContext,
  );
  const shutdown = getRequiredBindingHandler(
    harness.handlers,
    "session_shutdown",
  );
  await shutdown(
    { type: "session_shutdown", reason: "reload" },
    {} as ExtensionContext,
  );
  await shutdown(
    { type: "session_shutdown", reason: "quit" },
    {} as ExtensionContext,
  );
  disconnectFails = true;
  await shutdown(
    { type: "session_shutdown", reason: "quit" },
    {} as ExtensionContext,
  );
  automaticCleanupEnabled = false;
  await shutdown(
    { type: "session_shutdown", reason: "quit" },
    {} as ExtensionContext,
  );

  assert.deepEqual(events, [
    "composed-shutdown",
    "disconnect-on-quit",
    "composed-shutdown",
    "disconnect-on-quit",
    "runtime:automatic-disconnect-on-quit",
    "composed-shutdown",
    "composed-shutdown",
  ]);
});

test("Lifecycle binding routes native typing, previews, and normalized activity", async () => {
  const events: string[] = [];
  const harness = createBindingApiHarness();
  const runtime = Runtime.createTelegramBridgeRuntime();
  let activeTurn = false;
  const deps = {
    pi: harness.api,
    activityRuntime: {
      recordInputSource: (source: string) =>
        events.push(`activity:input:${source}`),
      onAgentStart: (target?: { chatId: number; threadId?: number }) =>
        events.push(
          `activity:agent-start:${target?.threadId ?? target?.chatId ?? "none"}`,
        ),
      onAssistantEvent: (event: { type: string }) =>
        events.push(`activity:assistant:${event.type}`),
      onToolStart: (event: { toolName: string }) =>
        events.push(`activity:tool-start:${event.toolName}`),
      onToolUpdate: (event: { toolName: string }) =>
        events.push(`activity:tool-update:${event.toolName}`),
      onToolEnd: (event: { toolName: string }) =>
        events.push(`activity:tool-end:${event.toolName}`),
      onCompactionStart: (reason: string) =>
        events.push(`activity:compact-start:${reason}`),
      onCompactionEnd: (reason: string) =>
        events.push(`activity:compact-end:${reason}`),
      onCompactionAbandoned: () =>
        events.push("activity:compact-abandoned"),
      onUiPromptStart: (kind: string, title?: string) =>
        events.push(`activity:ui-start:${kind}:${title ?? "none"}`),
      onUiPromptEnd: () => events.push("activity:ui-end"),
      onAgentEnd: () => events.push("activity:agent-end"),
      onAgentSettled: () => events.push("activity:agent-settled"),
      onSessionShutdown: () => events.push("activity:shutdown"),
    },
    publicationRuntime: {
      ...Activity.createTelegramActivityPublicationRuntime(),
      capture: () => ({ target: { chatId: 7 }, isCurrent: () => true }),
    },
    assistantOutputRuntime: {
      start: () => events.push("assistant-output:start"),
      stop: () => events.push("assistant-output:stop"),
    },
    sessionLifecycleRuntime: {
      onSessionStart: async () => {},
      onSessionShutdown: async () => {},
      onModelSelect: () => {},
    },
    configStore: {
      get: () => ({}),
      getOutboundHandlers: () => [],
      hasBotToken: () => true,
    },
    abort: runtime.abort,
    typing: runtime.typing,
    lifecycle: runtime.lifecycle,
    activeTurnRuntime: {
      clear: () => {},
      has: () => activeTurn,
      set: () => {},
      get: () =>
        activeTurn
          ? { chatId: 42, target: { chatId: 42, threadId: 9 } }
          : undefined,
    },
    telegramQueueStore: { getQueuedItems: () => [], setQueuedItems: () => {} },
    modelSwitchController: {
      clearPendingSwitch: () => {},
      triggerPendingAbort: () => {},
    },
    previewRuntime: {
      resetState: () => undefined,
      clear: () => {},
      setPendingText: () => {},
      onMessageStart: async () => events.push("preview:start"),
      onMessageUpdate: async () => events.push("preview:update"),
    },
    promptDispatchRuntime: {
      startTypingLoop: (
        _ctx: ExtensionContext,
        chatId?: number,
        options?: { target?: { threadId?: number } },
      ) =>
        events.push(
          `typing:${chatId ?? "none"}:${options?.target?.threadId ?? "all"}`,
        ),
    },
    deferredQueueDispatchRuntime: { request: () => {} },
    modelContextAvailabilityRuntime: { reconcile: () => {} },
    buttonActionStore: { register: () => "button-action" },
    callMultipart: async () => ({ ok: true }),
    sendChatAction: async () => ({ ok: true }),
    sendRecordVoiceAction: async () => ({ ok: true }),
    sendMarkdownReply: async (
      _chatId: number,
      _replyTo: number | undefined,
      text: string,
    ) => {
      events.push(`send:${text}`);
      return 77;
    },
    sendTextReply: async () => ({ ok: true }),
    editInteractiveMessage: async () => events.push("edit"),
    deleteMessage: async () => undefined,
    dispatchNextQueuedTelegramTurn: () => {},
    answerGuestQuery: async () => ({ ok: true }),
    sendGuestReply: async () => ({ ok: true }),
    finalizeMarkdownPreview: async () => undefined,
    proactivePushTargetGetter: () => ({ chatId: 42, threadId: 8 }),
    canSendAgentActivity: () => true,
    updateStatus: () => {},
    recordRuntimeEvent: () => {},
  } as unknown as Parameters<typeof registerTelegramLifecycleRuntimeHooks>[0];
  registerTelegramLifecycleRuntimeHooks(deps);

  await getRequiredBindingHandler(harness.handlers, "agent_start")(
    { type: "agent_start" },
    { abort: () => undefined } as ExtensionContext,
  );
  activeTurn = true;
  await getRequiredBindingHandler(harness.handlers, "ui_prompt_start")(
    { kind: "confirm", title: "Approve?" },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "ui_prompt_end")(
    {},
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "message_start")(
    { message: {} },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "message_update")(
    {
      message: {},
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "ponder <edge>",
      },
    },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "tool_execution_start")(
    {
      type: "tool_execution_start",
      toolCallId: "1",
      toolName: "read",
      args: { path: "README.md" },
    },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "session_before_compact")(
    { type: "session_before_compact" },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "session_compact")(
    { type: "session_compact" },
    {} as ExtensionContext,
  );
  activeTurn = false;
  await getRequiredBindingHandler(harness.handlers, "agent_end")(
    { type: "agent_end", messages: [] },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "session_before_compact")(
    { type: "session_before_compact" },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "ui_prompt_start")(
    { kind: "confirm", title: "Approve compaction?" },
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "ui_prompt_end")(
    {},
    {} as ExtensionContext,
  );
  await getRequiredBindingHandler(harness.handlers, "session_compact")(
    { type: "session_compact" },
    {} as ExtensionContext,
  );

  await deps.publicationRuntime.enqueue(async () => {});
  const expected = [
    "activity:agent-start:none",
    "typing:42:8",
    "activity:ui-start:confirm:Approve?",
    "activity:ui-end",
    "typing:42:9",
    "typing:42:9",
    "preview:start",
    "typing:42:9",
    "activity:assistant:thinking_delta",
    "typing:42:9",
    "preview:update",
    "typing:42:9",
    "activity:tool-start:read",
    "activity:compact-start:unknown",
    "typing:42:9",
    "send:**🗜 Compaction started.**",
    "activity:compact-end:unknown",
    "send:**✅ Compaction completed.**",
    "activity:agent-end",
    "activity:compact-start:unknown",
    "typing:42:8",
    "send:**🗜 Compaction started.**",
    "activity:ui-start:confirm:Approve compaction?",
    "activity:ui-end",
    "typing:42:8",
    "activity:compact-end:unknown",
    "send:**✅ Compaction completed.**",
  ];
  // Pi hooks keep their order without waiting for the independently delivered projection.
  assert.deepEqual(events.filter((event) => !event.startsWith("send:")), expected.filter((event) => !event.startsWith("send:")));
  assert.deepEqual(events.filter((event) => event.startsWith("send:")), expected.filter((event) => event.startsWith("send:")));
});
