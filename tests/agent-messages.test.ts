/**
 * Cross-instance Telegram agent message regressions
 * Zones: multi-instance bus, inbound routing, operational delivery
 * Mirrors lib/agent-messages.ts and protects live resolution, attribution, and routing fences.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramAgentMessageRuntime } from "../lib/agent-messages.ts";
import { createTelegramBusFollowerRegistry } from "../lib/bus.ts";
import type { TelegramRoutedMessage } from "../lib/routing.ts";
import { TELEGRAM_INTERNAL_AGENT_MESSAGE } from "../lib/updates.ts";

test("Agent message runtime resolves live names and injects attributed turns", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({
    instanceId: "hazel",
    connectedAtMs: 1,
    target: { chatId: 7, threadId: 99 },
    threadName: "Hazel",
  });
  const updates: Array<{
    message: TelegramRoutedMessage;
    [TELEGRAM_INTERNAL_AGENT_MESSAGE]?: true;
  }> = [];
  const runtime = createTelegramAgentMessageRuntime({
    instanceId: "isle",
    getAllowedChatId: () => 7,
    getLeaderTarget: () => ({ chatId: 7, threadId: 42 }),
    getLeaderThreadName: () => "Isle",
    followerRegistry: registry,
    getContext: () => ({ id: "ctx" }),
    handleUpdate: async (update: {
      message: TelegramRoutedMessage;
      [TELEGRAM_INTERNAL_AGENT_MESSAGE]?: true;
    }) => {
      updates.push(update);
    },
    getNowMs: () => 5_000,
  });
  assert.deepEqual(
    runtime.resolveTarget(
      { threadName: "hAzEl" },
      { chatId: 7, threadId: 42 },
    ),
    { chatId: 7, threadId: 99 },
  );
  assert.equal(
    runtime.resolveTarget(
      { threadName: "Isle" },
      { chatId: 7, threadId: 42 },
    ),
    undefined,
  );
  await runtime.route({
    sourceTarget: { chatId: 7, threadId: 42 },
    sourceThreadName: "Isle",
    message: {
      target: { chatId: 7, threadId: 99 },
      messageId: 101,
      text: "Review the release",
    },
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0]![TELEGRAM_INTERNAL_AGENT_MESSAGE], true);
  assert.equal(updates[0]!.message.message_thread_id, 99);
  assert.equal(updates[0]!.message.pi_telegram_agent_source_thread, "Isle");
  assert.equal(updates[0]!.message.text, "Review the release");
});

test("Agent resolution uses acknowledged labels only for live targets and preserves numeric dispatch across mode changes", async () => {
  const registry = createTelegramBusFollowerRegistry();
  registry.register({ instanceId: "peer", connectedAtMs: 1,
    target: { chatId: 7, threadId: 99 }, threadName: "Briar" });
  const titles = new Map([[42, "A"], [99, "B"], [100, "C"]]);
  const updates: Array<{ message: TelegramRoutedMessage }> = [];
  const runtime = createTelegramAgentMessageRuntime({
    instanceId: "leader", getAllowedChatId: () => 7,
    getLeaderTarget: () => ({ chatId: 7, threadId: 42 }), getLeaderThreadName: () => "Anchor",
    getDisplayTitle: ({ chatId, threadId }) => chatId === 7 ? titles.get(threadId!) : undefined,
    followerRegistry: registry, getContext: () => ({}),
    handleUpdate: async (update: { message: TelegramRoutedMessage }) => { updates.push(update); },
  });
  const selected = runtime.resolveTarget({ threadName: " b " });
  assert.deepEqual(selected, { chatId: 7, threadId: 99 });
  assert.equal(runtime.resolveTarget({ threadName: "Briar" }), undefined);
  assert.equal(runtime.resolveTarget({ threadName: "C" }), undefined);
  assert.equal(runtime.resolveTarget({ threadId: 100 }), undefined);
  assert.equal(runtime.resolveTarget({ threadName: "A" }, { chatId: 7, threadId: 42 }), undefined);
  assert.equal(runtime.resolveTarget({ threadName: "B", chatId: 8 }), undefined);
  titles.set(99, "a");
  assert.equal(runtime.resolveTarget({ threadName: "A" }), undefined);
  titles.set(42, "repo_a"); titles.set(99, "repo_b");
  assert.deepEqual(runtime.resolveTarget({ threadName: "REPO_B" }), selected);
  await runtime.route({ sourceTarget: { chatId: 7, threadId: 42 }, sourceThreadName: "Anchor",
    message: { target: selected!, messageId: 1, text: "Review" } });
  assert.equal(updates[0]?.message.message_thread_id, 99);
  assert.equal(updates[0]?.message.pi_telegram_agent_source_thread, "repo_a");
  assert.equal(registry.get("peer")?.threadName, "Briar");
  registry.remove("peer");
  assert.equal(runtime.resolveTarget({ threadName: "repo_b" }), undefined);
  await assert.rejects(runtime.route({ message: { target: selected!, messageId: 2, text: "Review" } }), /no longer live/);
  assert.equal(updates.length, 1);
});

test("Agent message runtime rejects unknown, ambiguous, and cross-chat targets", () => {
  const registry = createTelegramBusFollowerRegistry();
  for (const instanceId of ["a", "b"]) {
    registry.register({
      instanceId,
      connectedAtMs: 1,
      target: { chatId: 7, threadId: instanceId === "a" ? 10 : 11 },
      threadName: "Hazel",
    });
  }
  const runtime = createTelegramAgentMessageRuntime({
    instanceId: "leader",
    getAllowedChatId: () => 7,
    getLeaderTarget: () => undefined,
    getLeaderThreadName: () => undefined,
    followerRegistry: registry,
    getContext: () => undefined,
    handleUpdate: async () => {},
  });
  assert.equal(runtime.resolveTarget({ threadName: "Missing" }), undefined);
  assert.equal(runtime.resolveTarget({ threadName: "Hazel" }), undefined);
  assert.equal(
    runtime.resolveTarget({ chatId: 8, threadId: 10 }),
    undefined,
  );
});
