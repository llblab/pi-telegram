/**
 * Regression tests for Telegram reply delivery helpers
 * Covers rendered-message transport, chunk delivery, and plain or markdown final reply sending
 */

import assert from "node:assert/strict";
import test from "node:test";

// Transport-level dedup is module-global; reset between tests.
test.beforeEach(() => {
  resetTransportReplyDedup();
});

import {
  buildTelegramReplyParameters,
  buildTelegramReplyTransport,
  createReplyDedupRuntime,
  createTelegramRenderedMessageDeliveryRuntime,
  createTelegramRenderedMessageRuntime,
  dedupSendTextReply,
  editTelegramRenderedMessage,
  extractLatestAssistantMessageText,
  getAgentMessageText,
  isAssistantAgentMessage,
  resetTransportReplyDedup,
  sendTelegramMarkdownReply,
  sendTelegramPlainReply,
  sendTelegramRenderedChunks,
} from "../lib/replies.ts";
import { createDedupAgentStartHook } from "../lib/lifecycle.ts";

test("Reply helpers extract assistant message text and metadata", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "question" }] },
    {
      role: "assistant",
      stopReason: "error",
      errorMessage: "boom",
      content: [
        { type: "text", text: " hello " },
        { type: "image", source: "ignored" },
        { type: "text", text: "world " },
      ],
    },
  ];
  assert.equal(isAssistantAgentMessage(messages[1]), true);
  assert.equal(getAgentMessageText(messages[1]), "hello world");
  assert.deepEqual(extractLatestAssistantMessageText(messages), {
    text: "hello world",
    stopReason: "error",
    errorMessage: "boom",
  });
});

test("Reply transport forwards send and edit operations through delivery helpers", async () => {
  const events: string[] = [];
  const transport = buildTelegramReplyTransport({
    sendMessage: async (body) => {
      events.push(`send:${body.chat_id}:${body.text}`);
      return { message_id: 5 };
    },
    editMessage: async (body) => {
      events.push(`edit:${body.chat_id}:${body.message_id}:${body.text}`);
    },
  });
  assert.equal(await transport.sendRenderedChunks(7, [{ text: "one" }]), 5);
  assert.equal(await transport.editRenderedMessage(7, 9, [{ text: "two" }]), 9);
  assert.deepEqual(events, ["send:7:one", "edit:7:9:two"]);
});

test("Reply delivery sends chunks and applies reply markup only to the last chunk", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const messageId = await sendTelegramRenderedChunks(
    7,
    [{ text: "one" }, { text: "two", parseMode: "HTML" }],
    {
      sendMessage: async (body) => {
        sentBodies.push(body);
        return { message_id: sentBodies.length };
      },
      editMessage: async () => {},
    },
    {
      replyMarkup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
    },
  );
  assert.equal(messageId, 2);
  assert.deepEqual(sentBodies, [
    { chat_id: 7, text: "one", parse_mode: undefined, reply_markup: undefined },
    {
      chat_id: 7,
      text: "two",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
    },
  ]);
});

test("Reply delivery rejects generated buttons above Telegram callback limit", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  await assert.rejects(
    () =>
      sendTelegramRenderedChunks(
        7,
        [{ text: "one" }],
        {
          sendMessage: async (body) => {
            sentBodies.push(body);
            return { message_id: sentBodies.length };
          },
          editMessage: async () => {},
        },
        {
          replyMarkup: {
            inline_keyboard: [[{ text: "Too long", callback_data: "x".repeat(65) }]],
          },
        },
      ),
    /exceeds 64 bytes/,
  );
  assert.deepEqual(sentBodies, []);
});

test("Reply delivery applies reply parameters only to the first chunk", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  await sendTelegramRenderedChunks(
    7,
    [{ text: "one" }, { text: "two" }],
    {
      sendMessage: async (body) => {
        sentBodies.push(body);
        return { message_id: sentBodies.length };
      },
      editMessage: async () => {},
    },
    { replyToMessageId: 42 },
  );
  assert.deepEqual(sentBodies[0]?.reply_parameters, {
    message_id: 42,
    allow_sending_without_reply: true,
  });
  assert.equal("reply_parameters" in (sentBodies[1] ?? {}), false);
});

test("Reply delivery edits the first chunk and sends remaining chunks separately", async () => {
  const editedBodies: Array<Record<string, unknown>> = [];
  const sentBodies: Array<Record<string, unknown>> = [];
  const result = await editTelegramRenderedMessage(
    7,
    99,
    [{ text: "first", parseMode: "HTML" }, { text: "second" }],
    {
      sendMessage: async (body) => {
        sentBodies.push(body);
        return { message_id: 123 };
      },
      editMessage: async (body) => {
        editedBodies.push(body);
      },
    },
    {
      replyMarkup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
    },
  );
  assert.equal(result, 123);
  assert.deepEqual(editedBodies, [
    {
      chat_id: 7,
      message_id: 99,
      text: "first",
      parse_mode: "HTML",
      reply_markup: undefined,
    },
  ]);
  assert.deepEqual(sentBodies, [
    {
      chat_id: 7,
      text: "second",
      parse_mode: undefined,
      reply_markup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
    },
  ]);
  assert.equal("reply_parameters" in (sentBodies[0] ?? {}), false);
});

test("Reply runtime bundles text, markdown, and interactive rendered-message delivery", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const edited: Array<Record<string, unknown>> = [];
  const runtime = createTelegramRenderedMessageRuntime({
    renderTelegramMessage: (text, options) => [
      { text: `${options?.mode ?? "plain"}:${text}` },
    ],
    replyTransport: buildTelegramReplyTransport({
      sendMessage: async (body) => {
        sent.push(body);
        return { message_id: sent.length };
      },
      editMessage: async (body) => {
        edited.push(body);
      },
    }),
  });
  assert.equal(await runtime.sendTextReply(7, 42, "hello"), 1);
  assert.equal(await runtime.sendMarkdownReply(7, 43, "**hello**"), 2);
  assert.equal(
    await runtime.sendInteractiveMessage(7, "menu", "html", {
      inline_keyboard: [],
    }),
    3,
  );
  await runtime.editInteractiveMessage(7, 9, "menu", "html", {
    inline_keyboard: [],
  });
  assert.deepEqual(
    sent.map((body) => body.text),
    ["plain:hello", "markdown:**hello**", "html:menu"],
  );
  assert.deepEqual(sent[0]?.reply_parameters, {
    message_id: 42,
    allow_sending_without_reply: true,
  });
  assert.deepEqual(sent[1]?.reply_parameters, {
    message_id: 43,
    allow_sending_without_reply: true,
  });
  assert.deepEqual(sent[2]?.reply_markup, { inline_keyboard: [] });
  assert.deepEqual(
    edited.map((body) => body.text),
    ["html:menu"],
  );
});

test("Reply delivery runtime exposes transport and rendered-message helpers", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const runtime = createTelegramRenderedMessageDeliveryRuntime({
    renderTelegramMessage: (text, options) => [
      { text: `${options?.mode ?? "plain"}:${text}` },
    ],
    sendMessage: async (body) => {
      sent.push(body);
      return { message_id: sent.length };
    },
    editMessage: async () => {},
  });
  assert.equal(await runtime.sendTextReply(7, 42, "hello"), 1);
  assert.equal(
    await runtime.replyTransport.sendRenderedChunks(7, [{ text: "raw" }]),
    2,
  );
  assert.deepEqual(
    sent.map((body) => body.text),
    ["plain:hello", "raw"],
  );
});

test("Reply runtime sends plain replies using the requested parse mode", async () => {
  const sent: string[] = [];
  const messageId = await sendTelegramPlainReply(
    "hello",
    {
      renderTelegramMessage: (_text, options) => [
        { text: options?.mode === "html" ? "html" : "plain" },
      ],
      sendRenderedChunks: async (chunks) => {
        sent.push(chunks[0]?.text ?? "");
        return 7;
      },
    },
    { parseMode: "HTML" },
  );
  assert.equal(messageId, 7);
  assert.deepEqual(sent, ["html"]);
});

test("Reply runtime falls back to plain delivery when markdown rendering yields no chunks", async () => {
  const calls: Array<string> = [];
  const messageId = await sendTelegramMarkdownReply("hello", {
    renderTelegramMessage: (_text, options) => {
      if (options?.mode === "markdown") return [];
      return [{ text: options?.mode ?? "plain" }];
    },
    sendRenderedChunks: async (chunks) => {
      calls.push(chunks[0]?.text ?? "");
      return 9;
    },
  });
  assert.equal(messageId, 9);
  assert.deepEqual(calls, ["plain"]);
});

test("Transport reply dedup scopes repeated prompt message ids by chat", () => {
  assert.deepEqual(buildTelegramReplyParameters(1, 42), {
    message_id: 42,
    allow_sending_without_reply: true,
  });
  assert.equal(buildTelegramReplyParameters(1, 42), undefined);
  assert.deepEqual(buildTelegramReplyParameters(2, 42), {
    message_id: 42,
    allow_sending_without_reply: true,
  });
  resetTransportReplyDedup();
  assert.deepEqual(buildTelegramReplyParameters(1, 42), {
    message_id: 42,
    allow_sending_without_reply: true,
  });
});

test("Reply dedup tracks first reply per prompt message id and resets", () => {
  const dedup = createReplyDedupRuntime();
  assert.equal(dedup.shouldReply(42), true);
  assert.equal(dedup.shouldReply(42), false);
  assert.equal(dedup.shouldReply(99), true);
  dedup.reset();
  assert.equal(dedup.shouldReply(42), true);
});

test("Dedup wrapper suppresses reply_to_message_id after the first message in a turn", async () => {
  const dedup = createReplyDedupRuntime();
  const passedReplyIds: Array<number | undefined> = [];
  const inner = async (
    _chatId: number,
    replyToMessageId: number | undefined,
  ) => {
    passedReplyIds.push(replyToMessageId);
    return 1;
  };
  const wrapped = dedupSendTextReply(dedup, inner);
  await wrapped(7, 42, "first");
  await wrapped(7, 42, "second");
  await wrapped(7, 99, "other");
  assert.deepEqual(passedReplyIds, [42, undefined, 99]);
});

test("Dedup reset fires on agent_start through lifecycle hook", async () => {
  const dedup = createReplyDedupRuntime();
  dedup.shouldReply(42); // marks replied
  let agentStartCalled = false;
  const hook = createDedupAgentStartHook(dedup, async () => {
    agentStartCalled = true;
  });
  await hook(
    {} as Parameters<typeof hook>[0],
    {} as Parameters<typeof hook>[1],
  );
  assert.equal(agentStartCalled, true);
  assert.equal(
    dedup.shouldReply(42),
    true,
    "reset clears previous reply state",
  );
});
