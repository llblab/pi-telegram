/**
 * Regression tests for Telegram multi-instance bus helpers
 * Covers the serializable leader/follower IPC contract and live follower registry behavior
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
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
  createTelegramBusLocalServer,
  createTelegramBusProcessRuntime,
  createTelegramBusRequestId,
  encodeTelegramBusEnvelope,
  getTelegramBusFollowerSocketPath,
  getTelegramBusSocketPath,
  getTelegramFollowerTargetOwnership,
  isTelegramFollowerApiCallAllowed,
  parseTelegramBusEnvelope,
  sendTelegramBusLocalEnvelope,
} from "../lib/bus.ts";

test("Bus process runtime resolves live profile endpoints", () => {
  let profileName: string | undefined;
  const runtime = createTelegramBusProcessRuntime({
    getActiveProfileName: () => profileName,
    pid: 42,
    parentPid: 7,
    createdAtMs: 1000,
  });
  assert.equal(runtime.instanceId, "42:1000");
  assert.equal(runtime.manualFollowerOwnerId, "7");
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
    createdAtMs: 1000,
  });
  assert.equal(runtime.manualFollowerOwnerId, "42");
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
    getTelegramBusSocketPath("/agent"),
    join("/agent", "tmp", "telegram", "bus.sock"),
  );
  assert.equal(
    getTelegramBusFollowerSocketPath("pid:123", "/agent"),
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
      threadName: "project",
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
  assert.deepEqual(
    parseTelegramBusEnvelope(
      encodeTelegramBusEnvelope({
        kind: "follower.callApi",
        requestId: "inst-a:4",
        instanceId: "inst-a",
        method: "sendRichMessage",
        args: [{ chat_id: 1, rich_message: { markdown: "hi" } }],
        sentAtMs: 4000,
      }).trimEnd(),
    ),
    {
      kind: "follower.callApi",
      requestId: "inst-a:4",
      instanceId: "inst-a",
      method: "sendRichMessage",
      args: [{ chat_id: 1, rich_message: { markdown: "hi" } }],
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

test("Bus follower API allowlist permits scoped own-thread voice uploads", () => {
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
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["deleteMessage", { chat_id: "100", message_id: "9" }],
    }),
    true,
  );
  assert.equal(
    isTelegramFollowerApiCallAllowed({
      follower,
      method: "call",
      args: ["deleteMessage", { chat_id: 101, message_id: 9 }],
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
  const server = createTelegramBusLocalServer({
    socketPath,
    handleEnvelope: () => ({ kind: "bus.ack", requestId: "probe", ok: true }),
  });
  try {
    const missing = await probeTelegramBusEndpoint({
      endpoint: socketPath,
      timeoutMs: 50,
    });
    assert.equal(missing.reachable, false);
    assert.equal(missing.transport, "socket");
    await server.start();
    const reachable = await probeTelegramBusEndpoint({
      endpoint: socketPath,
      timeoutMs: 50,
    });
    assert.deepEqual(reachable, {
      endpoint: socketPath,
      transport: "socket",
      reachable: true,
    });
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bus local server resolves the active profile endpoint on each start", async () => {
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
    assert.equal(events[0].details.transport, "socket");
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
    assert.equal(failure?.details.transport, "socket");
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
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
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
        ownership: { instanceId: "inst-b" },
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

test("Bus follower target ownership falls back only to follower thread records", () => {
  assert.deepEqual(
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
    { instanceId: "follower-a" },
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
