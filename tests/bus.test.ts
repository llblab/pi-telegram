/**
 * Regression tests for Telegram multi-instance bus helpers
 * Covers the serializable leader/follower IPC contract and live follower registry behavior
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyTelegramBusTransportError,
  getTelegramBusFollowerEndpoint,
  getTelegramBusLeaderEndpoint,
  getTelegramBusTransportKind,
  getTelegramBusTransportRetryPolicy,
  probeTelegramBusEndpoint,
} from "../lib/bus-transport.ts";
import {
  createTelegramBusFollowerRegistry,
  createTelegramBusForeignOwnedUpdateForwarder,
  createTelegramFollowerApiCallAuthorizer,
  createTelegramBusLocalServer,
  createTelegramBusProcessRuntime,
  createTelegramBusRequestId,
  createTelegramBusRequestIdFactory,
  encodeTelegramBusEnvelope,
  getTelegramBusFollowerSocketPath,
  getTelegramBusSocketPath,
  getTelegramFollowerTargetOwnership,
  isTelegramFollowerApiCallAllowed,
  markTelegramBusAggregateDelivery,
  parseTelegramBusEnvelope,
  resolveTelegramBusSocketPath,
  stripTelegramBusApiMetadata,
  sendTelegramBusLocalEnvelope,
} from "../lib/bus.ts";

test("Bus process runtime resolves live profile endpoints", () => {
  let profileName: string | undefined;
  const runtime = createTelegramBusProcessRuntime({
    getActiveProfileName: () => profileName,
    pid: 42,
    parentPid: 7,
    parentProcessIdentity: "7:start:test",
    createdAtMs: 1000,
  });
  assert.equal(runtime.instanceId, "42:1000");
  assert.equal(runtime.manualFollowerOwnerId, "7:start:test");
  const defaultLeaderPath = runtime.getLeaderSocketPath();
  const defaultFollowerPath = runtime.getFollowerSocketPath();
  profileName = "work";
  assert.notEqual(runtime.getLeaderSocketPath(), defaultLeaderPath);
  assert.notEqual(runtime.getFollowerSocketPath(), defaultFollowerPath);
  assert.match(runtime.getLeaderSocketPath(), /work/);
  assert.match(runtime.getFollowerSocketPath(), /work/);
});

test("Bus process runtime falls back to pid without a parent pid", () => {
  const runtime = createTelegramBusProcessRuntime({
    getActiveProfileName: () => undefined,
    pid: 42,
    parentPid: 0,
    parentProcessIdentity: "42:start:test",
    createdAtMs: 1000,
  });
  assert.equal(runtime.manualFollowerOwnerId, "42:start:test");
});

test("Bus transport boundary derives socket and pipe endpoints", () => {
  assert.equal(
    getTelegramBusLeaderEndpoint({ agentDir: "/agent", platform: "linux" }),
    join("/agent", "tmp", "telegram", "bus.sock"),
  );
  assert.equal(
    getTelegramBusFollowerEndpoint({
      agentDir: "/agent",
      platform: "linux",
      instanceId: "pid:123",
    }),
    join("/agent", "tmp", "telegram", "followers", "pid_123.sock"),
  );
  const pipe = getTelegramBusLeaderEndpoint({
    agentDir: "C:\\Users\\Admin\\.pi\\agent",
    platform: "win32",
  });
  assert.match(pipe, /^\\\\\.\\pipe\\pi-telegram-.+-bus$/);
  assert.equal(getTelegramBusTransportKind(pipe), "pipe");
  assert.equal(getTelegramBusTransportKind("/tmp/bus.sock"), "socket");
  assert.equal(
    getTelegramBusTransportKind(
      resolveTelegramBusSocketPath("C:\\tmp\\legacy.sock", "win32"),
    ),
    "pipe",
  );
  const longMacEndpoint = resolveTelegramBusSocketPath(
    `/var/folders/${"nested/".repeat(20)}bus.sock`,
    "darwin",
  );
  assert.equal(getTelegramBusTransportKind(longMacEndpoint), "socket");
  assert.ok(Buffer.byteLength(longMacEndpoint) < 104);
});

test("Bus transport retry policy is operation-aware", () => {
  const pipe = getTelegramBusLeaderEndpoint({
    agentDir: "C:\\Users\\Admin\\.pi\\agent",
    platform: "win32",
  });
  assert.deepEqual(
    getTelegramBusTransportRetryPolicy({
      endpoint: pipe,
      operation: "operation",
    }),
    { attempts: 3, delayMs: 100 },
  );
  assert.deepEqual(
    getTelegramBusTransportRetryPolicy({
      endpoint: "/tmp/bus.sock",
      operation: "registration",
    }),
    { attempts: 10, delayMs: 150 },
  );
  assert.deepEqual(
    getTelegramBusTransportRetryPolicy({
      endpoint: "/tmp/bus.sock",
      operation: "registration",
      overrides: { attempts: 2, delayMs: 5 },
    }),
    { attempts: 2, delayMs: 5 },
  );
  assert.equal(
    getTelegramBusTransportRetryPolicy({
      endpoint: "/tmp/bus.sock",
      operation: "operation",
    }),
    undefined,
  );
});

test("Bus transport error classifier marks transient IPC failures retryable", () => {
  const error = Object.assign(new Error("connect ENOENT"), {
    code: "ENOENT",
    syscall: "connect",
  });
  assert.deepEqual(classifyTelegramBusTransportError(error), {
    message: "connect ENOENT",
    code: "ENOENT",
    syscall: "connect",
    kind: "connect",
    retryable: true,
  });
  assert.deepEqual(
    classifyTelegramBusTransportError(
      Object.assign(new Error("operation expired"), { code: "ETIMEDOUT" }),
    ),
    {
      message: "operation expired",
      code: "ETIMEDOUT",
      syscall: undefined,
      kind: "timeout",
      retryable: true,
    },
  );
});

test("Bus socket path is scoped under the agent temp directory", () => {
  assert.equal(
    getTelegramBusSocketPath("/agent", "linux"),
    join("/agent", "tmp", "telegram", "bus.sock"),
  );
  assert.equal(
    getTelegramBusFollowerSocketPath("pid:123", "/agent", "linux"),
    join("/agent", "tmp", "telegram", "followers", "pid_123.sock"),
  );
});

test("Bus socket paths isolate named profiles and preserve default Unix paths", () => {
  assert.equal(
    getTelegramBusSocketPath("/agent", "linux", "work"),
    join("/agent", "tmp", "telegram", "bus.work.sock"),
  );
  assert.equal(
    getTelegramBusFollowerSocketPath("pid:123", "/agent", "linux", "work"),
    join("/agent", "tmp", "telegram", "followers", "work", "pid_123.sock"),
  );
  assert.notEqual(
    getTelegramBusSocketPath("/agent", "linux", "work"),
    getTelegramBusSocketPath("/agent", "linux", "personal"),
  );
});

test("Bus socket path uses profile-scoped Windows named pipes on win32", () => {
  assert.match(
    getTelegramBusSocketPath("C:\\Users\\me\\.pi\\agent", "win32"),
    /^\\\\\.\\pipe\\pi-telegram-[A-Za-z0-9_-]{16}-bus$/,
  );
  assert.match(
    getTelegramBusFollowerSocketPath(
      "pid:123/unsafe",
      "C:\\Users\\me\\.pi\\agent",
      "win32",
    ),
    /^\\\\\.\\pipe\\pi-telegram-[A-Za-z0-9_-]{16}-follower-pid_123_unsafe$/,
  );
  assert.match(
    getTelegramBusSocketPath("C:\\Users\\me\\.pi\\agent", "win32", "work"),
    /^\\\\\.\\pipe\\pi-telegram-[A-Za-z0-9_-]{16}-bus-work$/,
  );
  assert.match(
    getTelegramBusFollowerSocketPath(
      "pid:123/unsafe",
      "C:\\Users\\me\\.pi\\agent",
      "win32",
      "work",
    ),
    /^\\\\\.\\pipe\\pi-telegram-[A-Za-z0-9_-]{16}-follower-work-pid_123_unsafe$/,
  );
});

test("Bus request id factory owns one monotonic instance sequence", () => {
  const createRequestId = createTelegramBusRequestIdFactory("inst-a");

  assert.equal(createRequestId(), "inst-a:1");
  assert.equal(createRequestId(), "inst-a:2");
  assert.equal(createRequestId(), "inst-a:3");
});

test("Bus contract encodes and parses follower registration envelopes", () => {
  const envelope = {
    kind: "follower.register" as const,
    requestId: createTelegramBusRequestId({
      instanceId: "inst-a",
      sequence: 1,
    }),
    registration: {
      instanceId: "inst-a",
      profileKey: "repo:/work/project",
      threadName: "Eagle",
      slot: "E",
      cwd: "/work/project",
      pid: 123,
      target: { chatId: -1007, threadId: 42 },
      connectedAtMs: 1000,
    },
  };

  assert.deepEqual(
    parseTelegramBusEnvelope(encodeTelegramBusEnvelope(envelope).trimEnd()),
    envelope,
  );
});

test("Bus contract encodes and parses explicit follower disconnect envelopes", () => {
  const envelope = {
    kind: "follower.disconnect" as const,
    requestId: "inst-a:2",
    instanceId: "inst-a",
    registrationGeneration: "inst-a:1",
    sentAtMs: 2000,
  };

  assert.deepEqual(
    parseTelegramBusEnvelope(encodeTelegramBusEnvelope(envelope).trimEnd()),
    envelope,
  );
});

test("Bus contract encodes and parses follower target replacement envelopes", () => {
  assert.deepEqual(
    parseTelegramBusEnvelope(
      encodeTelegramBusEnvelope({
        kind: "leader.replaceFollowerTarget",
        requestId: "leader:6",
        recipientInstanceId: "inst-b",
        target: { chatId: 7, threadId: 42 },
        oldTarget: { chatId: 7, threadId: 10 },
        reason: "thread-restore",
        sentAtMs: 6000,
      }).trimEnd(),
    ),
    {
      kind: "leader.replaceFollowerTarget",
      requestId: "leader:6",
      recipientInstanceId: "inst-b",
      target: { chatId: 7, threadId: 42 },
      oldTarget: { chatId: 7, threadId: 10 },
      reason: "thread-restore",
      sentAtMs: 6000,
    },
  );
  assert.equal(
    parseTelegramBusEnvelope(
      JSON.stringify({
        kind: "leader.replaceFollowerTarget",
        requestId: "leader:bad",
        recipientInstanceId: "inst-b",
        target: { chatId: 7 },
        reason: "thread-restore",
        sentAtMs: 6000,
      }),
    ),
    undefined,
  );
});

test("Bus contract encodes and parses follower API call envelopes", () => {
  const richBody = {
    chat_id: 1,
    rich_message: {
      markdown: "hi\n\n![](tg://photo?id=result)",
      media: [
        {
          id: "result",
          media: { type: "photo", media: "cached-photo" },
        },
      ],
    },
  };
  assert.deepEqual(
    parseTelegramBusEnvelope(
      encodeTelegramBusEnvelope({
        kind: "follower.callApi",
        requestId: "inst-a:4",
        instanceId: "inst-a",
        method: "sendRichMessage",
        args: [richBody],
        sentAtMs: 4000,
      }).trimEnd(),
    ),
    {
      kind: "follower.callApi",
      requestId: "inst-a:4",
      instanceId: "inst-a",
      method: "sendRichMessage",
      args: [richBody],
      sentAtMs: 4000,
    },
  );
});

test("Bus contract encodes and parses forwarded update envelopes", () => {
  assert.deepEqual(
    parseTelegramBusEnvelope(
      encodeTelegramBusEnvelope({
        kind: "leader.forwardCallback",
        requestId: "leader:2",
        recipientInstanceId: "inst-b",
        query: { id: "cb-1", data: "continue" },
        sentAtMs: 2000,
      }).trimEnd(),
    ),
    {
      kind: "leader.forwardCallback",
      requestId: "leader:2",
      recipientInstanceId: "inst-b",
      query: { id: "cb-1", data: "continue" },
      sentAtMs: 2000,
    },
  );

  assert.deepEqual(
    parseTelegramBusEnvelope(
      encodeTelegramBusEnvelope({
        kind: "leader.forwardReaction",
        requestId: "leader:3",
        recipientInstanceId: "inst-b",
        reactionUpdate: { message_id: 9, new_reaction: [] },
        sentAtMs: 3000,
      }).trimEnd(),
    ),
    {
      kind: "leader.forwardReaction",
      requestId: "leader:3",
      recipientInstanceId: "inst-b",
      reactionUpdate: { message_id: 9, new_reaction: [] },
      sentAtMs: 3000,
    },
  );

  assert.deepEqual(
    parseTelegramBusEnvelope(
      encodeTelegramBusEnvelope({
        kind: "leader.forwardMessage",
        requestId: "leader:4",
        recipientInstanceId: "inst-b",
        message: { message_id: 10 },
        sentAtMs: 4000,
      }).trimEnd(),
    ),
    {
      kind: "leader.forwardMessage",
      requestId: "leader:4",
      recipientInstanceId: "inst-b",
      message: { message_id: 10 },
      sentAtMs: 4000,
    },
  );

  assert.deepEqual(
    parseTelegramBusEnvelope(
      encodeTelegramBusEnvelope({
        kind: "leader.forwardEditedMessage",
        requestId: "leader:5",
        recipientInstanceId: "inst-b",
        message: { message_id: 11 },
        sentAtMs: 5000,
      }).trimEnd(),
    ),
    {
      kind: "leader.forwardEditedMessage",
      requestId: "leader:5",
      recipientInstanceId: "inst-b",
      message: { message_id: 11 },
      sentAtMs: 5000,
    },
  );
});

test("Bus contract rejects malformed envelopes", () => {
  assert.equal(parseTelegramBusEnvelope("not-json"), undefined);
  assert.equal(
    parseTelegramBusEnvelope(JSON.stringify({ kind: "unknown" })),
    undefined,
  );
  assert.equal(
    parseTelegramBusEnvelope(
      JSON.stringify({
        kind: "follower.register",
        requestId: "bad:1",
        registration: { instanceId: "inst", target: { chatId: "bad" } },
      }),
    ),
    undefined,
  );
});

test("Bus follower registry registers, heartbeats, and prunes live instances", () => {
  const registry = createTelegramBusFollowerRegistry();

  assert.deepEqual(
    registry.register({
      instanceId: "inst-a",
      threadName: "alpha",
      target: { chatId: 1 },
      connectedAtMs: 1000,
    }),
    {
      instanceId: "inst-a",
      threadName: "alpha",
      target: { chatId: 1 },
      connectedAtMs: 1000,
      lastHeartbeatMs: 1000,
    },
  );
  registry.register({
    instanceId: "inst-b",
    threadName: "beta",
    target: { chatId: 2, threadId: 20 },
    connectedAtMs: 1500,
  });

  assert.equal(registry.heartbeat("missing", 2000), undefined);
  assert.equal(registry.heartbeat("inst-a", 2200)?.lastHeartbeatMs, 2200);
  assert.deepEqual(
    registry.list().map((follower) => follower.instanceId),
    ["inst-a", "inst-b"],
  );
  assert.deepEqual(
    registry.pruneStale(3000, 1000).map((follower) => follower.instanceId),
    ["inst-b"],
  );
  assert.deepEqual(
    registry.list().map((follower) => follower.instanceId),
    ["inst-a"],
  );
  assert.equal(registry.remove("inst-a"), true);
  registry.register({ instanceId: "inst-c", connectedAtMs: 4000 });
  registry.clear();
  assert.deepEqual(registry.list(), []);
});

test("Bus follower API authorizer delegates message ownership with follower identity", () => {
  const calls: string[] = [];
  const follower = {
    instanceId: "follower-a",
    connectedAtMs: 1,
    lastHeartbeatMs: 2,
    target: { chatId: 7, threadId: 11 },
  };
  const authorize = createTelegramFollowerApiCallAuthorizer({
    isMessageOwned({ chatId, messageId, follower: owner }) {
      calls.push(`${owner.instanceId}:${chatId}:${messageId}`);
      return true;
    },
  });

  assert.equal(
    authorize({
      follower,
      method: "call",
      args: [
        "editMessageText",
        { chat_id: 7, message_thread_id: 11, message_id: 9 },
      ],
    }),
    true,
  );
  assert.deepEqual(calls, ["follower-a:7:9"]);
});

test("Bus follower API allowlist permits scoped own-thread Rich media uploads", () => {
  const follower = {
    instanceId: "inst-a",
    connectedAtMs: 1000,
    lastHeartbeatMs: 1000,
    target: { chatId: 10, threadId: 42 },
  };
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "callMultipart",
      args: [
        "sendVoice",
        { chat_id: 10, message_thread_id: 42 },
        "voice",
        "/tmp/voice.opus",
        "voice.opus",
      ],
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "callMultipart",
      args: [
        "sendVoice",
        { chat_id: "10", message_thread_id: "42" },
        "voice",
        "/tmp/voice.opus",
        "voice.opus",
      ],
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "callMultipart",
      args: [
        "sendAudio",
        { chat_id: 10, message_thread_id: 42 },
        "audio",
        "/tmp/audio.mp3",
        "audio.mp3",
      ],
    }),
    true,
  );
  const richMessage = JSON.stringify({
    markdown: "![](tg://photo?id=photo)",
    media: [
      {
        id: "photo",
        media: { type: "photo", media: "attach://photo_upload" },
      },
    ],
  });
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "callMultipart",
      args: [
        "sendRichMessage",
        {
          chat_id: "10",
          message_thread_id: "42",
          rich_message: richMessage,
        },
        "photo_upload",
        "/tmp/photo.jpg",
        "photo.jpg",
      ],
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "callMultipart",
      args: [
        "sendRichMessage",
        {
          chat_id: "10",
          message_thread_id: "99",
          rich_message: richMessage,
        },
        "photo_upload",
        "/tmp/photo.jpg",
        "photo.jpg",
      ],
    }),
    false,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "callMultipart",
      args: [
        "sendVoice",
        { chat_id: 10 },
        "voice",
        "/tmp/voice.opus",
        "voice.opus",
      ],
    }),
    false,
  );
});

test("Bus follower API allowlist permits chat message edit/delete operations", () => {
  const follower = {
    instanceId: "inst-a",
    connectedAtMs: 1000,
    lastHeartbeatMs: 1000,
    target: { chatId: 100, threadId: 42 },
  };
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["editMessageText", { chat_id: 100, message_id: 9, text: "Next" }],
      isMessageOwned: (chatId, messageId) => chatId === 100 && messageId === 9,
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["deleteMessage", { chat_id: "100", message_id: "9" }],
      isMessageOwned: (chatId, messageId) => chatId === 100 && messageId === 9,
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["deleteMessage", { chat_id: 100, message_id: 10 }],
      isMessageOwned: () => false,
    }),
    false,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["deleteMessage", { chat_id: 101, message_id: 9 }],
      isMessageOwned: () => true,
    }),
    false,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["deleteMessage", { chat_id: 100 }],
    }),
    false,
  );
});

test("Bus follower API allowlist permits bot command registration", () => {
  const follower = {
    instanceId: "inst-a",
    connectedAtMs: 1000,
    lastHeartbeatMs: 1000,
    target: { chatId: 100, threadId: 42 },
  };
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: [
        "setMyCommands",
        { commands: [{ command: "start", description: "Start" }] },
      ],
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["setMyCommands", { commands: [{ command: "start" }] }],
    }),
    false,
  );
});

test("Bus follower API allowlist permits own-chat typing and safe identity reads", () => {
  const follower = {
    instanceId: "inst-a",
    connectedAtMs: 1000,
    lastHeartbeatMs: 1000,
    target: { chatId: 100, threadId: 42 },
  };
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["getMe", {}],
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["sendChatAction", { chat_id: 100, action: "typing" }],
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["sendChatAction", { chat_id: 101, action: "typing" }],
    }),
    false,
  );
});

test("Bus follower API allowlist permits marked aggregate delivery only in its own chat", () => {
  const follower = {
    instanceId: "inst-a",
    connectedAtMs: 1000,
    lastHeartbeatMs: 1000,
    target: { chatId: 100, threadId: 42 },
  };
  const marked = markTelegramBusAggregateDelivery({
    chat_id: 100,
    text: "Aggregate",
  });
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["sendMessage", marked],
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["sendMessage", { chat_id: 100, text: "Unmarked" }],
    }),
    false,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: [
        "sendMessage",
        markTelegramBusAggregateDelivery({ chat_id: 101, text: "Wrong chat" }),
      ],
    }),
    false,
  );
  assert.deepEqual(stripTelegramBusApiMetadata(marked), {
    chat_id: 100,
    text: "Aggregate",
  });
});

test("Bus follower API allowlist permits scoped own-topic rename only", () => {
  const follower = {
    instanceId: "inst-a",
    connectedAtMs: 1000,
    lastHeartbeatMs: 1000,
    target: { chatId: 100, threadId: 42 },
  };
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: [
        "editForumTopic",
        { chat_id: 100, message_thread_id: 42, name: "Qname" },
      ],
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: [
        "editForumTopic",
        { chat_id: 100, message_thread_id: 99, name: "Wrong" },
      ],
    }),
    false,
  );
});

test("Bus follower API allowlist permits scoped own-topic cleanup only", () => {
  const follower = {
    instanceId: "inst-a",
    connectedAtMs: 1000,
    lastHeartbeatMs: 1000,
    target: { chatId: 100, threadId: 42 },
  };
  for (const methodName of ["closeForumTopic", "deleteForumTopic"]) {
    assert.equal(
      isTelegramFollowerApiCallAllowed({
        follower,
        method: "call",
        args: [methodName, { chat_id: 100, message_thread_id: 42 }],
      }),
      true,
    );
    assert.equal(
      isTelegramFollowerApiCallAllowed({
        follower,
        method: "call",
        args: [methodName, { chat_id: 100, message_thread_id: 99 }],
      }),
      false,
    );
  }
});

test("Bus transport probe reports reachable and unreachable endpoints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-probe-"));
  const socketPath = join(dir, "bus.sock");
  const endpoint = resolveTelegramBusSocketPath(socketPath);
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: () => ({ kind: "bus.ack", requestId: "probe", ok: true }),
  });
  try {
    const missing = await probeTelegramBusEndpoint({
      endpoint,
      timeoutMs: 50,
    });
    assert.equal(missing.reachable, false);
    assert.equal(missing.transport, getTelegramBusTransportKind(endpoint));
    await server.start();
    const reachable = await probeTelegramBusEndpoint({
      endpoint,
      timeoutMs: 50,
    });
    assert.deepEqual(reachable, {
      endpoint,
      transport: getTelegramBusTransportKind(endpoint),
      reachable: true,
    });
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local server roundtrips through a bounded long-path fallback", { skip: process.platform === "win32" }, async () => {
  const socketPath = join(
    tmpdir(),
    "pi-telegram-very-long-endpoint-segment".repeat(4),
    "bus.sock",
  );
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
    }),
  });
  try {
    await server.start();
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "follower.heartbeat",
        requestId: "long-path",
        instanceId: "follower-a",
        sentAtMs: 1000,
      },
    });
    assert.equal(response?.kind, "bus.ack");
  } finally {
    await server.stop();
  }
});

test("Bus local server resolves the active profile endpoint on each start", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-profile-switch-"));
  let profileName = "work";
  const getSocketPath = () =>
    getTelegramBusSocketPath(dir, "linux", profileName);
  const server = createTelegramBusLocalServer({
    socketPath: getSocketPath,
    handleEnvelope: () => ({ kind: "bus.ack", requestId: "profile", ok: true }),
  });
  const workSocketPath = getSocketPath();
  try {
    await server.start();
    assert.equal(existsSync(workSocketPath), true);
    await server.stop();
    assert.equal(existsSync(workSocketPath), false);

    profileName = "personal";
    const personalSocketPath = getSocketPath();
    await server.start();
    assert.notEqual(personalSocketPath, workSocketPath);
    assert.equal(existsSync(personalSocketPath), true);
    assert.equal(existsSync(workSocketPath), false);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Old bus server stop cannot invalidate a replacement endpoint generation", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-generation-"));
  const socketPath = join(dir, "bus.sock");
  const first = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: false,
      message: "first",
    }),
  });
  const replacement = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
      message: "replacement",
    }),
  });
  try {
    await first.start();
    await replacement.start();
    await first.stop();

    assert.equal(
      (
        await probeTelegramBusEndpoint({
          endpoint: socketPath,
          timeoutMs: 50,
        })
      ).reachable,
      true,
    );
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "follower.heartbeat",
        requestId: "replacement-generation",
        instanceId: "follower-a",
        sentAtMs: 2000,
      },
    });
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "replacement-generation",
      ok: true,
      message: "replacement",
    });
  } finally {
    await first.stop();
    await replacement.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Stale bus server cannot publish over a replacement endpoint generation", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-publish-fence-"));
  const socketPath = join(dir, "bus.sock");
  let releasePublication: (() => void) | undefined;
  let signalPublicationReady: (() => void) | undefined;
  const publicationReady = new Promise<void>((resolve) => {
    signalPublicationReady = resolve;
  });
  const publicationRelease = new Promise<void>((resolve) => {
    releasePublication = resolve;
  });
  const stale = createTelegramBusLocalServer({
    socketPath,
    beforeEndpointPublication: async () => {
      signalPublicationReady?.();
      await publicationRelease;
    },
    commitEndpointPublication: () => false,
    handleEnvelope: () => undefined,
  });
  const replacement = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => ({
      kind: "bus.ack",
      requestId: envelope.requestId,
      ok: true,
      message: "replacement",
    }),
  });
  try {
    const staleStart = stale.start();
    await publicationReady;
    await replacement.start();
    releasePublication?.();
    await assert.rejects(staleStart, /lost transport ownership/);

    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "follower.heartbeat",
        requestId: "replacement-after-stale-publication",
        instanceId: "follower-a",
        sentAtMs: 2000,
      },
    });
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "replacement-after-stale-publication",
      ok: true,
      message: "replacement",
    });
  } finally {
    releasePublication?.();
    await stale.stop();
    await replacement.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local server rebinds an externally unlinked Unix endpoint", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-rebind-"));
  const socketPath = join(dir, "bus.sock");
  const phases: string[] = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: () => ({ kind: "bus.ack", requestId: "rebind", ok: true }),
    recordTransportEvent: (phase) => phases.push(phase),
  });
  try {
    await server.start();
    unlinkSync(socketPath);
    assert.equal(existsSync(socketPath), false);

    assert.equal(await server.ensureEndpoint(), true);
    assert.equal(existsSync(socketPath), true);
    assert.equal(await server.ensureEndpoint(), false);
    assert.deepEqual(
      phases.filter((phase) => phase.includes("endpoint")),
      ["server-endpoint-missing", "server-endpoint-recovered"],
    );
    assert.equal(
      (
        await probeTelegramBusEndpoint({
          endpoint: socketPath,
          timeoutMs: 50,
        })
      ).reachable,
      true,
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local client transport events include request diagnostics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-client-events-"));
  const socketPath = join(dir, "missing.sock");
  const events: Array<{ phase: string; details: Record<string, unknown> }> = [];
  try {
    await assert.rejects(
      sendTelegramBusLocalEnvelope({
        socketPath,
        envelope: {
          kind: "follower.heartbeat",
          requestId: "inst-a:events",
          instanceId: "inst-a",
          sentAtMs: 2000,
        },
        recordTransportEvent: (phase, details) =>
          events.push({ phase, details }),
      }),
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].phase, "client-failed");
    assert.equal(events[0].details.envelopeKind, "follower.heartbeat");
    assert.equal(events[0].details.requestId, "inst-a:events");
    assert.equal(
      events[0].details.transport,
      getTelegramBusTransportKind(resolveTelegramBusSocketPath(socketPath)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local client classifies response timeouts as transport timeouts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-client-timeout-"));
  const socketPath = join(dir, "bus.sock");
  const events: Array<{ phase: string; details: Record<string, unknown> }> = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: () => undefined,
  });
  try {
    await server.start();
    await assert.rejects(
      sendTelegramBusLocalEnvelope({
        socketPath,
        timeoutMs: 5,
        envelope: {
          kind: "follower.heartbeat",
          requestId: "inst-a:timeout",
          instanceId: "inst-a",
          sentAtMs: 2000,
        },
        recordTransportEvent: (phase, details) =>
          events.push({ phase, details }),
      }),
    );
    assert.equal(events[0].phase, "client-failed");
    assert.equal(events[0].details.code, "ETIMEDOUT");
    assert.equal(events[0].details.kind, "timeout");
    assert.equal(events[0].details.retryable, true);
    assert.equal(events[0].details.requestId, "inst-a:timeout");
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local server memoizes completed and in-flight request results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-ledger-"));
  const socketPath = join(dir, "bus.sock");
  let executions = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createTelegramBusLocalServer({
    socketPath,
    async handleEnvelope(envelope) {
      executions += 1;
      await gate;
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        result: { executions },
      };
    },
  });
  try {
    await server.start();
    const envelope = {
      kind: "follower.heartbeat" as const,
      requestId: "follower-a:ledger:1",
      instanceId: "follower-a",
      sentAtMs: 1000,
    };
    const first = sendTelegramBusLocalEnvelope({ socketPath, envelope });
    const duplicate = sendTelegramBusLocalEnvelope({ socketPath, envelope });
    const deadline = Date.now() + 1000;
    while (executions === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(executions, 1);
    release?.();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    const replayResult = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope,
    });
    assert.deepEqual(firstResult, duplicateResult);
    assert.deepEqual(replayResult, firstResult);
    assert.equal(executions, 1);
  } finally {
    release?.();
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus retry returns the memoized result after the first acknowledgement is lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-ledger-ack-loss-"));
  const socketPath = join(dir, "bus.sock");
  let executions = 0;
  let dropped = false;
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope(envelope) {
      executions += 1;
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
        result: { message_id: 77 },
      };
    },
    shouldDropResponse() {
      if (dropped) return false;
      dropped = true;
      return true;
    },
  });
  try {
    await server.start();
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      timeoutMs: 10,
      retry: { attempts: 2, delayMs: 0 },
      envelope: {
        kind: "follower.callApi",
        requestId: "follower-a:send:1",
        instanceId: "follower-a",
        method: "call",
        args: ["sendMessage", { chat_id: 1, text: "hello" }],
        sentAtMs: 1000,
      },
    });
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "follower-a:send:1",
      ok: true,
      message: undefined,
      result: { message_id: 77 },
    });
    assert.equal(executions, 1);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local server rejects request-id reuse with a changed payload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-ledger-collision-"));
  const socketPath = join(dir, "bus.sock");
  let executions = 0;
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope(envelope) {
      executions += 1;
      return {
        kind: "bus.ack",
        requestId: envelope.requestId,
        ok: true,
      };
    },
  });
  try {
    await server.start();
    const first = {
      kind: "follower.heartbeat" as const,
      requestId: "follower-a:collision:1",
      instanceId: "follower-a",
      sentAtMs: 1000,
    };
    await sendTelegramBusLocalEnvelope({ socketPath, envelope: first });
    const collision = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: { ...first, sentAtMs: 1001 },
    });
    assert.equal(executions, 1);
    assert.deepEqual(collision, {
      kind: "bus.ack",
      requestId: first.requestId,
      ok: false,
      message: "Telegram bus request id was reused with a different payload.",
      error: { code: "request-id-collision" },
    });
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local IPC server reports handler failures as protocol acks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-handler-failure-"));
  const socketPath = join(dir, "bus.sock");
  const events: Array<{ phase: string; details: Record<string, unknown> }> = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: () => {
      throw new Error("boom");
    },
    recordTransportEvent: (phase, details) => events.push({ phase, details }),
  });
  try {
    await server.start();
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "follower.heartbeat",
        requestId: "inst-a:failed-handler",
        instanceId: "inst-a",
        sentAtMs: 2000,
      },
    });
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "inst-a:failed-handler",
      ok: false,
      message: "Telegram bus handler failed.",
    });
    const failure = events.find(
      (event) => event.phase === "server-handler-failed",
    );
    assert.equal(failure?.details.envelopeKind, "follower.heartbeat");
    assert.equal(failure?.details.requestId, "inst-a:failed-handler");
    assert.equal(
      failure?.details.transport,
      getTelegramBusTransportKind(resolveTelegramBusSocketPath(socketPath)),
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local IPC server handles request/response envelopes over a private Unix socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-"));
  const socketPath = join(dir, "bus.sock");
  const received: string[] = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => {
      received.push(envelope.kind);
      return { kind: "bus.ack", requestId: envelope.requestId, ok: true };
    },
  });
  try {
    await server.start();
    if (process.platform !== "win32") {
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    }
    const response = await sendTelegramBusLocalEnvelope({
      socketPath,
      envelope: {
        kind: "follower.heartbeat",
        requestId: "inst-a:2",
        instanceId: "inst-a",
        sentAtMs: 2000,
      },
    });
    assert.deepEqual(response, {
      kind: "bus.ack",
      requestId: "inst-a:2",
      ok: true,
      message: undefined,
    });
    assert.deepEqual(received, ["follower.heartbeat"]);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "Bus local IPC server roundtrips over a Windows named pipe",
  { skip: process.platform !== "win32" },
  async () => {
    const socketPath = getTelegramBusSocketPath(
      join(tmpdir(), `pi-telegram-bus-win-${process.pid}`),
      "win32",
    );
    const received: string[] = [];
    const server = createTelegramBusLocalServer({
      socketPath,
      handleEnvelope: (envelope) => {
        received.push(envelope.kind);
        return { kind: "bus.ack", requestId: envelope.requestId, ok: true };
      },
    });
    try {
      await server.start();
      const response = await sendTelegramBusLocalEnvelope({
        socketPath,
        envelope: {
          kind: "follower.heartbeat",
          requestId: "inst-a:win",
          instanceId: "inst-a",
          sentAtMs: 2000,
        },
      });
      assert.deepEqual(response, {
        kind: "bus.ack",
        requestId: "inst-a:win",
        ok: true,
        message: undefined,
      });
      assert.deepEqual(received, ["follower.heartbeat"]);
    } finally {
      await server.stop();
    }
  },
);

test("Bus foreign-owned update forwarder sends routed update envelopes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-forwarder-"));
  const socketPath = join(dir, "bus.sock");
  const received: unknown[] = [];
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: (envelope) => {
      received.push(envelope);
      return { kind: "bus.ack", requestId: envelope.requestId, ok: true };
    },
  });
  let sequence = 0;
  const forwarder = createTelegramBusForeignOwnedUpdateForwarder({
    socketPath,
    createRequestId: () => `leader:${++sequence}`,
    getNowMs: () => 9000,
  });
  try {
    await server.start();
    assert.equal(
      await forwarder.forwardCallback({
        query: { id: "cb-1" },
        ownership: { instanceId: "inst-b" },
        ctx: "ctx",
      }),
      true,
    );
    assert.equal(
      await forwarder.forwardReaction({
        reactionUpdate: { message_id: 7 },
        ownership: { instanceId: "inst-b" },
        ctx: "ctx",
      }),
      true,
    );
    assert.equal(
      await forwarder.forwardMessage({
        message: { message_id: 8 },
        ownership: {
          instanceId: "inst-b",
          ownerGeneration: "registration-b",
        },
        ctx: "ctx",
      }),
      true,
    );
    assert.equal(
      await forwarder.forwardEditedMessage({
        message: { message_id: 9 },
        ownership: { instanceId: "inst-b" },
        ctx: "ctx",
      }),
      true,
    );
    assert.deepEqual(received, [
      {
        kind: "leader.forwardCallback",
        requestId: "leader:1",
        recipientInstanceId: "inst-b",
        query: { id: "cb-1" },
        sentAtMs: 9000,
      },
      {
        kind: "leader.forwardReaction",
        requestId: "leader:2",
        recipientInstanceId: "inst-b",
        reactionUpdate: { message_id: 7 },
        sentAtMs: 9000,
      },
      {
        kind: "leader.forwardMessage",
        requestId: "leader:3",
        recipientInstanceId: "inst-b",
        recipientRegistrationGeneration: "registration-b",
        message: { message_id: 8 },
        sentAtMs: 9000,
      },
      {
        kind: "leader.forwardEditedMessage",
        requestId: "leader:4",
        recipientInstanceId: "inst-b",
        message: { message_id: 9 },
        sentAtMs: 9000,
      },
    ]);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus foreign-owned update forwarder supports tolerant timeouts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-telegram-bus-forwarder-slow-"));
  const socketPath = join(dir, "bus.sock");
  const server = createTelegramBusLocalServer({
    socketPath,
    async handleEnvelope(envelope) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { kind: "bus.ack", requestId: envelope.requestId, ok: true };
    },
  });
  const forwarder = createTelegramBusForeignOwnedUpdateForwarder({
    socketPath,
    createRequestId: () => "leader:slow",
    timeoutMs: 120,
  });
  try {
    await server.start();
    assert.equal(
      await forwarder.forwardMessage({
        message: { message_id: 8 },
        ownership: { instanceId: "inst-b" },
        ctx: "ctx",
      }),
      true,
    );
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus follower registry resolves followers by target", () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "private",
    target: { chatId: 1 },
    connectedAtMs: 1000,
  });
  registry.register({
    instanceId: "thread",
    target: { chatId: 1, threadId: 2 },
    connectedAtMs: 1000,
  });

  assert.equal(registry.getByTarget({ chatId: 1 })?.instanceId, "private");
  assert.equal(
    registry.getByTarget({ chatId: 1, threadId: 2 })?.instanceId,
    "thread",
  );
  assert.equal(registry.getByTarget({ chatId: 1, threadId: 3 }), undefined);
});

test("Bus follower registry replaces stale registrations by profile and target", () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "follower:old",
    profileKey: "manual:follower",
    target: { chatId: 1, threadId: 2 },
    connectedAtMs: 1000,
  });
  registry.register({
    instanceId: "follower:new",
    profileKey: "manual:follower",
    target: { chatId: 1, threadId: 2 },
    connectedAtMs: 2000,
  });

  assert.equal(registry.get("follower:old"), undefined);
  assert.equal(
    registry.getByTarget({ chatId: 1, threadId: 2 })?.instanceId,
    "follower:new",
  );
  assert.deepEqual(
    registry.list().map((follower) => follower.instanceId),
    ["follower:new"],
  );
});

test("Bus follower target ownership carries the live registration generation", () => {
  assert.deepEqual(
    getTelegramFollowerTargetOwnership({
      target: { chatId: 1, threadId: 2 },
      followers: [
        {
          instanceId: "follower-live",
          target: { chatId: 1, threadId: 2 },
          registrationGeneration: "registration-2",
          connectedAtMs: 2000,
          lastHeartbeatMs: 2001,
        },
      ],
    }),
    {
      instanceId: "follower-live",
      ownerGeneration: "registration-2",
    },
  );
});

test("Bus follower target ownership never treats persisted bindings as live authority", () => {
  assert.equal(
    getTelegramFollowerTargetOwnership({
      target: { chatId: 1, threadId: 2 },
      followers: [],
      currentInstanceId: "leader",
      activeThreadRecords: [
        {
          status: "active",
          instanceId: "follower-a",
          profileKey: "manual:follower-a",
          owner: { kind: "manual-follower" },
          target: { chatId: 1, threadId: 2 },
        },
      ],
    }),
    undefined,
  );
  assert.equal(
    getTelegramFollowerTargetOwnership({
      target: { chatId: 1, threadId: 2 },
      followers: [],
      currentInstanceId: "leader-b",
      activeThreadRecords: [
        {
          status: "active",
          instanceId: "leader-a",
          profileKey: "cwd:/repo",
          owner: { kind: "leader" },
          target: { chatId: 1, threadId: 2 },
        },
      ],
    }),
    undefined,
  );
  assert.equal(
    getTelegramFollowerTargetOwnership({
      target: { chatId: 1, threadId: 2 },
      followers: [],
      currentInstanceId: "leader",
      activeThreadRecords: [
        {
          status: "offline",
          instanceId: "follower-a",
          profileKey: "manual:follower-a",
          owner: { kind: "manual-follower" },
          target: { chatId: 1, threadId: 2 },
        },
      ],
    }),
    undefined,
  );
});

test("Bus follower registry returns defensive copies", () => {
  const registry = createTelegramBusFollowerRegistry();
  const registered = registry.register({
    instanceId: "inst-a",
    target: { chatId: 1, threadId: 2 },
    connectedAtMs: 1000,
  });
  registered.target = { chatId: 99 };

  assert.deepEqual(registry.get("inst-a")?.target, { chatId: 1, threadId: 2 });
  const byTarget = registry.getByTarget({ chatId: 1, threadId: 2 });
  if (byTarget) byTarget.target = { chatId: 99 };
  assert.deepEqual(registry.getByTarget({ chatId: 1, threadId: 2 })?.target, {
    chatId: 1,
    threadId: 2,
  });
});
