/** Thread-name dialog state tests; no Telegram transport or Workspace mutation. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelegramThreadNameDialogRuntime,
  TELEGRAM_THREAD_NAME_DIALOG_TTL_MS,
} from "../lib/thread-naming.ts";

const target = { chatId: 7, threadId: 42 };

test("Thread-name dialog replaces duplicates and consumes one exact-target name", () => {
  let now = 100;
  const runtime = createTelegramThreadNameDialogRuntime({ nowMs: () => now });
  runtime.open({ scope: "session:1", target, dialogMessageId: 10 });
  runtime.open({ scope: "session:1", target, dialogMessageId: 11 });
  assert.deepEqual(runtime.select({
    scope: "session:1", target, dialogMessageId: 10, action: "cancel",
  }), { kind: "expired" });
  assert.deepEqual(runtime.consumeName({
    scope: "session:1", target: { chatId: 7, threadId: 43 }, text: "Wrong",
  }), { kind: "none" });
  assert.deepEqual(runtime.consumeName({
    scope: "session:1", target, text: "  Navigator  ",
  }), { kind: "name", name: "Navigator" });
  assert.deepEqual(runtime.consumeName({
    scope: "session:1", target, text: "Again",
  }), { kind: "none" });
  assert.equal(runtime.inspect(target), undefined);
  now++;
});

test("Thread-name dialog reset and cancel are consume-once", () => {
  const runtime = createTelegramThreadNameDialogRuntime();
  for (const action of ["reset", "cancel"] as const) {
    runtime.open({ scope: "session:1", target, dialogMessageId: 20 });
    assert.deepEqual(runtime.select({
      scope: "session:1", target, dialogMessageId: 20, action,
    }), { kind: action });
    assert.deepEqual(runtime.select({
      scope: "session:1", target, dialogMessageId: 20, action,
    }), { kind: "expired" });
  }
});

test("Thread-name dialog rejects stale scope, expiry, and empty input", () => {
  let now = 1_000;
  const runtime = createTelegramThreadNameDialogRuntime({ nowMs: () => now });
  runtime.open({ scope: "session:1", target, dialogMessageId: 30 });
  assert.deepEqual(runtime.select({
    scope: "session:2", target, dialogMessageId: 30, action: "cancel",
  }), { kind: "expired" });
  assert.deepEqual(runtime.consumeName({
    scope: "session:1", target, text: "   ",
  }), { kind: "empty" });
  assert.equal(runtime.inspect(target)?.phase, "input");
  now += TELEGRAM_THREAD_NAME_DIALOG_TTL_MS;
  assert.deepEqual(runtime.consumeName({
    scope: "session:1", target, text: "Late",
  }), { kind: "none" });
  assert.equal(runtime.inspect(target), undefined);
});

test("Thread-name dialog scope cleanup invalidates every target in that session", () => {
  const runtime = createTelegramThreadNameDialogRuntime();
  runtime.open({ scope: "session:1", target, dialogMessageId: 40 });
  runtime.open({
    scope: "session:1", target: { chatId: 7, threadId: 43 }, dialogMessageId: 41,
  });
  runtime.open({
    scope: "session:2", target: { chatId: 7, threadId: 44 }, dialogMessageId: 42,
  });
  runtime.clearScope("session:1");
  assert.equal(runtime.inspect(target), undefined);
  assert.equal(runtime.inspect({ chatId: 7, threadId: 43 }), undefined);
  assert.ok(runtime.inspect({ chatId: 7, threadId: 44 }));
});
