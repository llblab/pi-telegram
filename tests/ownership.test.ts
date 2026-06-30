/**
 * Regression tests for Telegram message ownership helpers
 * Covers live message-id to target/instance ownership used by multi-instance bus routing
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramMessageOwnershipStore } from "../lib/ownership.ts";
import { createTelegramThreadTarget } from "../lib/target.ts";

test("Message ownership records default private targets", () => {
  const store = createTelegramMessageOwnershipStore();
  const record = store.record({
    chatId: 7,
    messageId: 9,
    instanceId: "instance-a",
    now: 100,
  });
  assert.deepEqual(record, {
    chatId: 7,
    messageId: 9,
    target: { chatId: 7 },
    instanceId: "instance-a",
    createdAt: 100,
    updatedAt: 100,
  });
  assert.deepEqual(store.get(7, 9), record);
});

test("Message ownership preserves createdAt when ownership is refreshed", () => {
  const store = createTelegramMessageOwnershipStore();
  store.record({
    chatId: -1007,
    messageId: 11,
    target: createTelegramThreadTarget(-1007, 42),
    instanceId: "instance-a",
    now: 100,
  });
  const refreshed = store.record({
    chatId: -1007,
    messageId: 11,
    target: createTelegramThreadTarget(-1007, 43),
    instanceId: "instance-b",
    now: 150,
  });
  assert.deepEqual(refreshed, {
    chatId: -1007,
    messageId: 11,
    target: createTelegramThreadTarget(-1007, 43),
    instanceId: "instance-b",
    createdAt: 100,
    updatedAt: 150,
  });
});

test("Message ownership can forget a whole target", () => {
  const store = createTelegramMessageOwnershipStore();
  store.record({
    chatId: -1007,
    messageId: 1,
    target: createTelegramThreadTarget(-1007, 42),
    instanceId: "instance-a",
    now: 1,
  });
  store.record({
    chatId: -1007,
    messageId: 2,
    target: createTelegramThreadTarget(-1007, 42),
    instanceId: "instance-a",
    now: 2,
  });
  store.record({
    chatId: -1007,
    messageId: 3,
    target: createTelegramThreadTarget(-1007, 43),
    instanceId: "instance-b",
    now: 3,
  });
  assert.equal(store.forgetTarget(createTelegramThreadTarget(-1007, 42)), 2);
  assert.equal(store.get(-1007, 1), undefined);
  assert.equal(store.get(-1007, 2), undefined);
  assert.equal(store.get(-1007, 3)?.instanceId, "instance-b");
});

test("Message ownership prunes by age and record count", () => {
  const store = createTelegramMessageOwnershipStore();
  store.record({ chatId: 7, messageId: 1, instanceId: "a", now: 10 });
  store.record({ chatId: 7, messageId: 2, instanceId: "a", now: 20 });
  store.record({ chatId: 7, messageId: 3, instanceId: "a", now: 30 });
  assert.equal(store.prune({ now: 40, maxAgeMs: 25 }), 1);
  assert.equal(store.get(7, 1), undefined);
  assert.equal(store.prune({ now: 40, maxRecords: 1 }), 1);
  assert.deepEqual(
    store.entries().map((record) => record.messageId),
    [3],
  );
});
