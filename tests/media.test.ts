/**
 * Regression tests for Telegram media and text extraction helpers
 * Covers inbound file-info collection, text extraction, media groups, id collection, and history formatting
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  collectTelegramFileInfos,
  collectTelegramMessageIds,
  createTelegramMediaGroupController,
  createTelegramMediaGroupDispatchRuntime,
  downloadTelegramMessageFiles,
  extractFirstTelegramMessageText,
  extractTelegramMessagePromptText,
  extractTelegramMessagesPromptText,
  extractTelegramMessagesText,
  formatTelegramHistoryText,
  getTelegramMediaGroupKey,
  guessMediaType,
  queueTelegramMediaGroupMessage,
  removePendingTelegramMediaGroupMessages,
  type TelegramMediaGroupState,
} from "../lib/media.ts";

type TestTimer = ReturnType<typeof setTimeout>;

function createTestTimer(id: number): TestTimer {
  return id as unknown as TestTimer;
}

function getTestTimerId(timer: TestTimer): number {
  return timer as unknown as number;
}

test("Media helpers collect file infos across Telegram message variants", () => {
  const files = collectTelegramFileInfos([
    {
      message_id: 1,
      text: "hello",
      photo: [
        { file_id: "small", file_size: 1 },
        { file_id: "large", file_size: 10 },
      ],
      document: {
        file_id: "doc",
        file_name: "report.png",
        mime_type: "image/png",
      },
      voice: {
        file_id: "voice",
        mime_type: "audio/ogg",
      },
      sticker: {
        file_id: "sticker",
      },
    },
  ]);
  assert.deepEqual(
    files.map((file) => ({
      id: file.file_id,
      name: file.fileName,
      image: file.isImage,
    })),
    [
      { id: "large", name: "photo-1.jpg", image: true },
      { id: "doc", name: "report.png", image: true },
      { id: "voice", name: "voice-1.ogg", image: false },
      { id: "sticker", name: "sticker-1.webp", image: true },
    ],
  );
});

test("Media helpers download collected file infos", async () => {
  const downloaded = await downloadTelegramMessageFiles(
    [
      {
        message_id: 3,
        document: {
          file_id: "doc-id",
          file_name: "report.pdf",
          mime_type: "application/pdf",
        },
      },
    ],
    {
      downloadFile: async (fileId, fileName) => `/tmp/${fileId}-${fileName}`,
    },
  );
  assert.deepEqual(downloaded, [
    {
      path: "/tmp/doc-id-report.pdf",
      fileName: "report.pdf",
      isImage: false,
      mimeType: "application/pdf",
      kind: "document",
    },
  ]);
});

test("Media helpers extract text, ids, and history summaries", () => {
  const messages = [
    { message_id: 1, text: "first" },
    { message_id: 2, caption: "second" },
    { message_id: 2, text: "duplicate id" },
  ];
  assert.equal(
    extractTelegramMessagesText(messages),
    "first\n\nsecond\n\nduplicate id",
  );
  assert.equal(extractFirstTelegramMessageText(messages), "first");
  assert.deepEqual(collectTelegramMessageIds(messages), [1, 2]);
  assert.equal(
    formatTelegramHistoryText(
      "hello",
      [{ path: "/tmp/demo.txt" }],
      ["transcript"],
    ),
    "hello\n\n[attachments] /tmp\n- /demo.txt\n\n[outputs]\n- transcript",
  );
});

test("Media helpers keep raw text command-safe and add reply context only for prompts", () => {
  const repliedCommand = {
    message_id: 1,
    text: "/status",
    reply_to_message: { text: "quoted context" },
  };
  const captionReply = {
    message_id: 2,
    caption: "caption reply",
    reply_to_message: { caption: "quoted caption" },
  };
  assert.equal(extractFirstTelegramMessageText([repliedCommand]), "/status");
  assert.equal(extractTelegramMessagesText([repliedCommand]), "/status");
  assert.equal(
    extractTelegramMessagePromptText(repliedCommand),
    "/status\n\n[reply] quoted context",
  );
  assert.equal(
    extractTelegramMessagesPromptText([captionReply]),
    "caption reply\n\n[reply] quoted caption",
  );
});

test("Media helpers prefer rich-message text for reply context", () => {
  const message = {
    message_id: 1,
    text: "current",
    reply_to_message: {
      text: "## Raw **Markdown** fallback",
      rich_message: {
        blocks: [
          { type: "heading", text: "Rendered heading", size: 2 },
          {
            type: "paragraph",
            text: ["Plain ", { type: "bold", text: "reply" }, " text"],
          },
          {
            type: "list",
            items: [
              {
                label: "1.",
                blocks: [{ type: "paragraph", text: "First item" }],
              },
            ],
          },
        ],
      },
    },
  };
  assert.equal(
    extractTelegramMessagePromptText(message),
    "current\n\n[reply] Rendered heading\n\nPlain reply text\n\n1. First item",
  );
});

test("Media helpers truncate long reply context for prompt text", () => {
  const longQuote = `${"a".repeat(1000)} extra`;
  assert.equal(
    extractTelegramMessagesPromptText([
      {
        message_id: 1,
        text: "current",
        reply_to_message: { text: longQuote },
      },
    ]),
    `current\n\n[reply] ${"a".repeat(1000)}…`,
  );
});

test("Media helpers infer image media types from file paths", () => {
  assert.equal(guessMediaType("/tmp/demo.png"), "image/png");
  assert.equal(guessMediaType("/tmp/demo.txt"), undefined);
});

test("Media helpers key messages by chat and media group", () => {
  assert.equal(
    getTelegramMediaGroupKey({
      message_id: 1,
      chat: { id: 7 },
      media_group_id: "album",
    }),
    "7:private:album",
  );
  assert.equal(
    getTelegramMediaGroupKey({
      message_id: 1,
      chat: { id: 7 },
      message_thread_id: 42,
      media_group_id: "album",
    }),
    "7:thread:42:album",
  );
  assert.equal(
    getTelegramMediaGroupKey({ message_id: 1, chat: { id: 7 } }),
    undefined,
  );
});

test("Media helpers replace debounce timers and dispatch grouped messages", () => {
  const groups = new Map<
    string,
    TelegramMediaGroupState<{
      message_id: number;
      chat: { id: number };
      media_group_id?: string;
    }>
  >();
  const cleared: number[] = [];
  const callbacks: Array<() => void> = [];
  const dispatched: number[][] = [];
  let nextTimer = 1;
  const setTimer = (callback: () => void): TestTimer => {
    callbacks.push(callback);
    return createTestTimer(nextTimer++);
  };
  const clearTimer = (timer: TestTimer): void => {
    cleared.push(getTestTimerId(timer));
  };
  assert.equal(
    queueTelegramMediaGroupMessage({
      message: { message_id: 1, chat: { id: 7 }, media_group_id: "album" },
      groups,
      debounceMs: 100,
      setTimer,
      clearTimer,
      dispatchMessages: (messages) =>
        dispatched.push(messages.map((message) => message.message_id)),
    }),
    true,
  );
  queueTelegramMediaGroupMessage({
    message: { message_id: 2, chat: { id: 7 }, media_group_id: "album" },
    groups,
    debounceMs: 100,
    setTimer,
    clearTimer,
    dispatchMessages: (messages) =>
      dispatched.push(messages.map((message) => message.message_id)),
  });
  assert.deepEqual(cleared, [1]);
  callbacks.at(-1)?.();
  assert.deepEqual(dispatched, [[1, 2]]);
  assert.equal(groups.size, 0);
});

test("Media group controller owns timers, removal, and cleanup", () => {
  const cleared: number[] = [];
  const callbacks: Array<() => void> = [];
  const dispatched: number[][] = [];
  let nextTimer = 1;
  const controller = createTelegramMediaGroupController<{
    message_id: number;
    chat: { id: number };
    media_group_id?: string;
  }>({
    debounceMs: 100,
    setTimer: (callback) => {
      callbacks.push(callback);
      return createTestTimer(nextTimer++);
    },
    clearTimer: (timer) => {
      cleared.push(getTestTimerId(timer));
    },
  });
  assert.equal(
    controller.queueMessage({
      message: { message_id: 1, chat: { id: 7 }, media_group_id: "album" },
      dispatchMessages: (messages) =>
        dispatched.push(messages.map((message) => message.message_id)),
    }),
    true,
  );
  controller.queueMessage({
    message: { message_id: 2, chat: { id: 7 }, media_group_id: "album" },
    dispatchMessages: (messages) =>
      dispatched.push(messages.map((message) => message.message_id)),
  });
  assert.deepEqual(cleared, [1]);
  assert.equal(controller.removeMessages([2]), 1);
  assert.deepEqual(cleared, [1, 2]);
  callbacks.at(-1)?.();
  assert.equal(dispatched.length, 0);
  controller.queueMessage({
    message: { message_id: 3, chat: { id: 7 }, media_group_id: "album" },
    dispatchMessages: (messages) =>
      dispatched.push(messages.map((message) => message.message_id)),
  });
  controller.clear();
  assert.deepEqual(cleared, [1, 2, 3]);
});

test("Media group dispatch runtime handles immediate and grouped messages", async () => {
  const callbacks: Array<() => void> = [];
  const dispatched: Array<{ ids: number[]; ctx: string }> = [];
  const controller = createTelegramMediaGroupController<
    {
      message_id: number;
      chat: { id: number };
      media_group_id?: string;
    },
    string
  >({
    setTimer: (callback) => {
      callbacks.push(callback);
      return createTestTimer(callbacks.length);
    },
    clearTimer: () => {},
  });
  const runtime = createTelegramMediaGroupDispatchRuntime({
    mediaGroups: controller,
    dispatchMessages: async (messages, ctx: string) => {
      dispatched.push({
        ids: messages.map((message) => message.message_id),
        ctx,
      });
    },
  });
  await runtime.handleMessage({ message_id: 1, chat: { id: 7 } }, "ctx-a");
  await runtime.handleMessage(
    { message_id: 2, chat: { id: 7 }, media_group_id: "album" },
    "ctx-b",
  );
  await runtime.handleMessage(
    { message_id: 3, chat: { id: 7 }, media_group_id: "album" },
    "ctx-b",
  );
  callbacks.at(-1)?.();
  assert.deepEqual(dispatched, [
    { ids: [1], ctx: "ctx-a" },
    { ids: [2, 3], ctx: "ctx-b" },
  ]);
});

test("Media helpers remove pending groups by message id", () => {
  const groups = new Map<
    string,
    TelegramMediaGroupState<{ message_id: number; chat: { id: number } }>
  >();
  groups.set("7:album", {
    messages: [
      { message_id: 1, chat: { id: 7 } },
      { message_id: 2, chat: { id: 7 } },
    ],
    flushTimer: createTestTimer(10),
  });
  const cleared: number[] = [];
  assert.equal(
    removePendingTelegramMediaGroupMessages(groups, [2], (timer) => {
      cleared.push(getTestTimerId(timer));
    }),
    1,
  );
  assert.deepEqual(cleared, [10]);
  assert.equal(groups.size, 0);
});
