/**
 * Regression tests for Telegram message ownership helpers
 * Covers live message-id to target/instance ownership used by multi-instance bus routing
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramBusMessageOwnershipRuntime,
  createTelegramMessageOwnershipStore,
} from "../lib/ownership.ts";
import { createTelegramThreadTarget } from "../lib/target.ts";

test("Bus ownership runtime scopes follower authority to registration generation", () => {
  let followers = [
    {
      instanceId: "follower-a",
      connectedAtMs: 10,
      registrationGeneration: "generation-a",
    },
  ];
  const runtime = createTelegramBusMessageOwnershipRuntime({
    instanceId: "leader",
    getProfileKey: () => "default",
    listFollowers: () => followers,
  });
  runtime.recordRouted({
    chatId: 7,
    messageId: 9,
    target: { chatId: 7, threadId: 11 },
    instanceId: "follower-a",
  });

  assert.equal(
    runtime.isOwnedByFollower({
      chatId: 7,
      messageId: 9,
      follower: followers[0]!,
    }),
    true,
  );
  followers = [
    {
      instanceId: "follower-a",
      connectedAtMs: 20,
      registrationGeneration: "generation-b",
    },
  ];
  assert.equal(runtime.store.get(7, 9), undefined);
  assert.equal(
    runtime.isOwnedByFollower({
      chatId: 7,
      messageId: 9,
      follower: followers[0]!,
    }),
    false,
  );
});

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

test("Message ownership isolates bot profiles and rejects stale follower generations", () => {
  let profileKey = "work";
  let liveGeneration = "follower-a:100";
  const store = createTelegramMessageOwnershipStore({
    getProfileKey: () => profileKey,
    isOwnerGenerationLive: (record) =>
      record.ownerGeneration === liveGeneration,
  });
  store.record({
    chatId: 7,
    messageId: 9,
    instanceId: "follower-a",
    ownerGeneration: "follower-a:100",
    now: 100,
  });
  assert.equal(store.get(7, 9)?.instanceId, "follower-a");

  profileKey = "personal";
  assert.equal(store.get(7, 9), undefined);
  store.record({
    chatId: 7,
    messageId: 9,
    instanceId: "follower-b",
    ownerGeneration: "follower-b:200",
    now: 200,
  });
  liveGeneration = "follower-b:200";
  assert.equal(store.get(7, 9)?.instanceId, "follower-b");

  profileKey = "work";
  liveGeneration = "follower-a:101";
  assert.equal(store.get(7, 9), undefined);
  assert.equal(store.entries().length, 2);
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
