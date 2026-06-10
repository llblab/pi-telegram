/**
 * Regression tests for Telegram outbound button helpers
 * Exercises assistant-authored button markup extraction, action storage, callback handling, and prompt-turn construction
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramButtonActionStore,
  createTelegramButtonPromptTurn,
  handleTelegramButtonCallbackQuery,
  planTelegramButtonReply,
} from "../lib/outbound-buttons.ts";

test("Button reply planner strips telegram_button markup and registers actions", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      "Visible answer.",
      "",
      '<!-- telegram_button label="Run" -->',
      "Run the workflow.",
      "-->",
      "",
      "Tail.",
    ].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );

  assert.equal(plan.markdown, "Visible answer.\n\nTail.");
  assert.deepEqual(actions, [{ text: "Run", prompt: "Run the workflow." }]);
  assert.deepEqual(plan.replyMarkup, {
    inline_keyboard: [[{ text: "Run", callback_data: "btn:1" }]],
  });
});

test("Button action store resolves registered actions once and expires old entries", () => {
  const store = createTelegramButtonActionStore();
  const callbackData = store.register({ text: "Run", prompt: "Do it." });

  assert.deepEqual(store.resolve(callbackData), {
    text: "Run",
    prompt: "Do it.",
  });
  assert.equal(store.resolve(callbackData), undefined);
  assert.equal(store.resolve("other:callback"), undefined);

  const expiringStore = createTelegramButtonActionStore({ ttlMs: -1 });
  const expiredCallbackData = expiringStore.register({
    text: "Expired",
    prompt: "Too late.",
  });
  assert.equal(expiringStore.resolve(expiredCallbackData), undefined);
});

test("Button prompt turn preserves prompt text and queue metadata", () => {
  const turn = createTelegramButtonPromptTurn({
    chatId: 10,
    replyToMessageId: 20,
    queueOrder: 30,
    action: { text: "Run", prompt: "Run this now." },
  });

  assert.equal(turn.kind, "prompt");
  assert.equal(turn.chatId, 10);
  assert.equal(turn.replyToMessageId, 20);
  assert.equal(turn.queueLane, "default");
  assert.deepEqual(turn.sourceMessageIds, [20]);
  assert.deepEqual(turn.content, [
    { type: "text", text: "[telegram] Run this now." },
  ]);
  assert.equal(turn.historyText, "Run this now.");
  assert.equal(turn.statusSummary, "Run");
});

test("Button callback handler enqueues owned actions and consumes expired buttons", async () => {
  const answered: string[] = [];
  const enqueued: unknown[] = [];
  const handled = await handleTelegramButtonCallbackQuery(
    {
      id: "q1",
      data: "tgbtn:live",
      message: { message_id: 2, chat: { id: 1 } },
    },
    "ctx",
    {
      resolveAction: () => ({ text: "Run", prompt: "Run it." }),
      answerCallbackQuery: async (_id, text) => {
        answered.push(text ?? "");
      },
      enqueueButtonPrompt: (query, action, ctx) => {
        enqueued.push({ query, action, ctx });
      },
    },
  );

  assert.equal(handled, true);
  assert.deepEqual(answered, ["Queued."]);
  assert.equal(enqueued.length, 1);

  const expired = await handleTelegramButtonCallbackQuery(
    { id: "q2", data: "tgbtn:expired" },
    "ctx",
    {
      resolveAction: () => undefined,
      answerCallbackQuery: async (_id, text) => {
        answered.push(text ?? "");
      },
      enqueueButtonPrompt: () => {
        throw new Error("must not enqueue expired buttons");
      },
    },
  );

  assert.equal(expired, true);
  assert.deepEqual(answered, ["Queued.", "Button action expired."]);
});
