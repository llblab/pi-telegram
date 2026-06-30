/**
 * Telegram target regression tests
 * Zones: telegram transport, routing, multi-instance bus
 * Covers private and thread target identity helpers used by future multi-instance routing
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  areTelegramTargetsEqual,
  createTelegramPrivateTarget,
  createTelegramThreadTarget,
  getTelegramTargetKey,
  getTelegramTargetThreadParams,
  isTelegramThreadTarget,
} from "../lib/target.ts";

test("Telegram target helpers model private chat targets", () => {
  const target = createTelegramPrivateTarget(7);
  assert.deepEqual(target, { chatId: 7 });
  assert.equal(getTelegramTargetKey(target), "7:private");
  assert.equal(isTelegramThreadTarget(target), false);
  assert.deepEqual(getTelegramTargetThreadParams(target), {});
});

test("Telegram target helpers model topic thread targets", () => {
  const target = createTelegramThreadTarget(-100123, 42);
  assert.deepEqual(target, { chatId: -100123, threadId: 42 });
  assert.equal(getTelegramTargetKey(target), "-100123:42");
  assert.equal(isTelegramThreadTarget(target), true);
  assert.deepEqual(getTelegramTargetThreadParams(target), {
    message_thread_id: 42,
  });
});

test("Telegram target equality includes thread identity", () => {
  assert.equal(
    areTelegramTargetsEqual(
      createTelegramThreadTarget(1, 2),
      createTelegramThreadTarget(1, 2),
    ),
    true,
  );
  assert.equal(
    areTelegramTargetsEqual(
      createTelegramThreadTarget(1, 2),
      createTelegramThreadTarget(1, 3),
    ),
    false,
  );
  assert.equal(
    areTelegramTargetsEqual(
      createTelegramPrivateTarget(1),
      createTelegramThreadTarget(1, 2),
    ),
    false,
  );
});
