/**
 * Regression tests for Telegram multi-instance bus helpers
 * Covers the serializable leader/follower IPC contract and live follower registry behavior
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTelegramBusFollowerRegistry,
  createTelegramBusForeignOwnedUpdateForwarder,
  createTelegramBusLocalServer,
  createTelegramBusRequestId,
  encodeTelegramBusEnvelope,
  getTelegramBusFollowerSocketPath,
  getTelegramBusSocketPath,
  isTelegramFollowerApiCallAllowed,
  parseTelegramBusEnvelope,
  sendTelegramBusLocalEnvelope,
} from "../lib/bus.ts";
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

test("Bus socket path uses Windows named pipes on win32", () => {
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
