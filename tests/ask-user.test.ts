/**
 * Regression tests for Telegram ask_user fallback helpers
 * Covers forwarding pi-ask-user prompts to Telegram-visible replies during active turns
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramAskUserFallbackMarkdown,
  createTelegramAskUserToolCallGuard,
  planTelegramAskUserFallbackReply,
} from "../lib/ask-user.ts";
import type { PendingTelegramTurn } from "../lib/queue.ts";

function createActiveTurn(): PendingTelegramTurn {
  return {
    kind: "prompt",
    chatId: 123,
    replyToMessageId: 456,
    sourceMessageIds: [456],
    queuedAttachments: [],
    content: [{ type: "text", text: "[telegram] do something" }],
    historyText: "do something",
    queueOrder: 1,
    queueLane: "default",
    laneOrder: 1,
    statusSummary: "do something",
  };
}

test("Ask-user fallback markdown renders question, context, options, and freeform hint", () => {
  const markdown = buildTelegramAskUserFallbackMarkdown({
    question: "Which path should I use?",
    context: "Repo is clean.",
    options: [
      "Current repo",
      { title: "Other path", description: "Type a custom folder" },
    ],
    allowFreeform: true,
  });

  assert.match(markdown, /\*\*Question\*\*/);
  assert.match(markdown, /Which path should I use\?/);
  assert.match(markdown, /\*\*Context\*\*/);
  assert.match(markdown, /Repo is clean\./);
  assert.match(markdown, /Choose an option or reply with your own answer\./);
  assert.match(markdown, /Current repo/);
  assert.match(markdown, /Other path — Type a custom folder/);
  assert.doesNotMatch(markdown, /telegram_button/);
});

test("Ask-user fallback reply plan registers direct button actions without comment markup", () => {
  const actions: Array<{ text: string; prompt: string }> = [];
  const plan = planTelegramAskUserFallbackReply(
    {
      question: "Which path should I use?",
      context: "Repo is clean.",
      options: [
        "A --> B",
        { title: "Other path", description: "Type a custom folder" },
      ],
      allowFreeform: true,
    },
    {
      registerButtonAction(action) {
        actions.push(action);
        return `tgbtn:${actions.length}`;
      },
    },
  );

  assert.doesNotMatch(plan.markdown, /<!--/);
  assert.deepEqual(plan.replyMarkup, {
    inline_keyboard: [
      [{ text: "A --> B", callback_data: "tgbtn:1" }],
      [{ text: "Other path", callback_data: "tgbtn:2" }],
    ],
  });
  assert.equal(actions[0]?.text, "A --> B");
  assert.match(actions[0]?.prompt ?? "", /User selected "A --> B"/);
  assert.match(actions[1]?.prompt ?? "", /Option details:\nType a custom folder/);
});

test("Ask-user tool-call guard forwards active Telegram prompts and blocks hidden UI", async () => {
  const sent: Array<{
    chatId: number;
    replyToMessageId: number | undefined;
    markdown: string;
    replyMarkup?: unknown;
  }> = [];
  const guard = createTelegramAskUserToolCallGuard({
    getActiveTurn: createActiveTurn,
    registerButtonAction: () => "tgbtn:test",
    sendMarkdownReply: async (chatId, replyToMessageId, markdown, options) => {
      sent.push({
        chatId,
        replyToMessageId,
        markdown,
        replyMarkup: options?.replyMarkup,
      });
      return 99;
    },
  });

  const result = await guard(
    {
      toolName: "ask_user",
      input: {
        question: "Which path should I use?",
        options: ["Current repo"],
      },
    },
    {},
  );

  assert.deepEqual(result, {
    block: true,
    reason: "ask_user was forwarded to Telegram for this active turn; wait for the user's Telegram reply instead of opening a hidden local UI prompt.",
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    chatId: 123,
    replyToMessageId: 456,
    markdown:
      "**Question**\nWhich path should I use?\n\n**Options**\n1. Current repo\n\nChoose an option or reply with your own answer.",
    replyMarkup: { inline_keyboard: [[{ text: "Current repo", callback_data: "tgbtn:test" }]] },
  });
});

test("Ask-user tool-call guard forwards guest-mode active turns through guest replies", async () => {
  const guestReplies: Array<{ guestQueryId: string; markdown: string }> = [];
  const turn = createActiveTurn();
  turn.chatId = 0;
  turn.replyToMessageId = 0;
  turn.guestQueryId = "guest-1";
  const guard = createTelegramAskUserToolCallGuard({
    getActiveTurn: () => turn,
    registerButtonAction: () => {
      throw new Error("guest ask_user should not register unreachable buttons");
    },
    sendMarkdownReply: async () => {
      throw new Error("normal chat sender should not be used for guests");
    },
    sendGuestReply: async (guestQueryId, markdown) => {
      guestReplies.push({ guestQueryId, markdown });
    },
  });

  const result = await guard(
    {
      toolName: "ask_user",
      input: { question: "Guest question?", options: ["A", "B"] },
    },
    {},
  );

  assert.equal(result?.block, true);
  assert.deepEqual(guestReplies, [
    {
      guestQueryId: "guest-1",
      markdown:
        "**Question**\nGuest question?\n\n**Options**\n1. A\n2. B\n\nChoose an option or reply with your own answer.",
    },
  ]);
});

test("Ask-user tool-call guard passes through non-Telegram or non-ask_user calls", async () => {
  let sends = 0;
  const guard = createTelegramAskUserToolCallGuard({
    getActiveTurn: () => undefined,
    registerButtonAction: () => "tgbtn:test",
    sendMarkdownReply: async () => {
      sends += 1;
      return undefined;
    },
  });

  assert.equal(
    await guard({ toolName: "ask_user", input: { question: "Q?" } }, {}),
    undefined,
  );
  assert.equal(
    await guard({ toolName: "bash", input: { command: "pwd" } }, {}),
    undefined,
  );
  assert.equal(sends, 0);
});

test("Ask-user tool-call guard blocks with final-reply guidance when forwarding fails", async () => {
  const events: Array<{ category: string; message: string }> = [];
  const guard = createTelegramAskUserToolCallGuard({
    getActiveTurn: createActiveTurn,
    registerButtonAction: () => "tgbtn:test",
    sendMarkdownReply: async () => {
      throw new Error("Telegram send failed");
    },
    recordRuntimeEvent(category, error) {
      events.push({
        category,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const result = await guard(
    { toolName: "ask_user", input: { question: "Q?" } },
    {},
  );

  assert.deepEqual(events, [
    { category: "ask-user", message: "Telegram send failed" },
  ]);
  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /Ask the question in your final Telegram reply/);
});
