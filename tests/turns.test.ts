/**
 * Regression tests for the Telegram turn-building domain
 * Covers queue-summary formatting, prompt construction, and prompt-turn assembly from messages and downloaded files
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildTelegramPromptTurn,
  buildTelegramPromptTurnRuntime,
  buildTelegramTurnPrompt,
  createTelegramPromptTurnRuntimeBuilder,
  createTelegramQueuedPromptEditRuntime,
  formatTelegramTurnStatusSummary,
  getTelegramVoiceReplyMode,
  truncateTelegramQueueSummary,
  updateQueuedTelegramPromptTurnText,
  updateTelegramPromptTurnText,
} from "../lib/turns.ts";

test("Turn helpers truncate queue summaries predictably", () => {
  assert.equal(
    truncateTelegramQueueSummary("one two three four"),
    "one two three four",
  );
  assert.equal(
    truncateTelegramQueueSummary("one two three four five six"),
    "one two three four five…",
  );
  assert.equal(truncateTelegramQueueSummary("   "), "");
});

test("Turn helpers build prompt text with history and attachments", () => {
  const prompt = buildTelegramTurnPrompt({
    telegramPrefix: "[telegram]",
    rawText: "current message",
    files: [{ path: "/tmp/demo.png", fileName: "demo.png", isImage: true }],
    historyTurns: [{ historyText: "older message" }],
  });
  assert.match(prompt, /^\[telegram\]/);
  assert.match(
    prompt,
    /Earlier Telegram messages arrived after an aborted turn/,
  );
  assert.match(prompt, /1\. older message/);
  assert.match(prompt, /Current Telegram message:\ncurrent message/);
  assert.match(prompt, /\[attachments\] \/tmp\n- \/demo.png/);
});

test("Turn helpers keep attachment outputs with user content before reply context", () => {
  const prompt = buildTelegramTurnPrompt({
    telegramPrefix: "[telegram]",
    rawText: "",
    files: [
      {
        path: "/tmp/voice.ogg",
        fileName: "voice.ogg",
        isImage: false,
      },
    ],
    handlerOutputs: ["transcribed voice"],
    sourceContext: "[reply|from:alice] Earlier message",
  });
  assert.equal(
    prompt,
    "[telegram]\n\n[attachments] /tmp\n- /voice.ogg\n\n[outputs]\n- transcribed voice\n\n[reply|from:alice] Earlier message",
  );
});

test("Turn helpers omit [time] section by default", () => {
  const prompt = buildTelegramTurnPrompt({
    telegramPrefix: "[telegram]",
    rawText: "hello",
    files: [],
  });
  assert.equal(prompt, "[telegram] hello");
});

test("Turn helpers inject [time] as the final context section", () => {
  const prompt = buildTelegramTurnPrompt({
    telegramPrefix: "[telegram]",
    rawText: "current message",
    files: [{ path: "/tmp/demo.png", fileName: "demo.png", isImage: true }],
    handlerOutputs: ["transcript"],
    voiceContext: { "reply mode": "manual" },
    timeLine: "2026-05-16 14:32:10 Europe/Berlin",
  });
  assert.match(
    prompt,
    /^\[telegram\] current message\n\n\[attachments\] \/tmp\n- \/demo\.png\n\n\[outputs\]\n- transcript\n\n\[voice\] reply mode: manual\n\n\[time\] 2026-05-16 14:32:10 Europe\/Berlin$/,
  );
});

test("Turn helpers still inject [time] when raw text is empty", () => {
  const prompt = buildTelegramTurnPrompt({
    telegramPrefix: "[telegram]",
    rawText: "",
    files: [],
    timeLine: "2026-05-16 14:32:10 UTC",
  });
  assert.equal(prompt, "[telegram]\n\n[time] 2026-05-16 14:32:10 UTC");
});

test("Turn runtime builder calls resolveTimeLine with chatId and embeds result", async () => {
  const seen: number[] = [];
  const buildTurn = createTelegramPromptTurnRuntimeBuilder({
    allocateQueueOrder: () => 1,
    downloadFile: async (_fileId, fileName) => `/tmp/${fileName}`,
    resolveTimeLine: (chatId) => {
      seen.push(chatId);
      return "2026-05-16 14:32:10 UTC";
    },
  });
  const turn = await buildTurn([
    { message_id: 42, chat: { id: 7 }, text: "hi" },
  ]);
  assert.deepEqual(seen, [7]);
  assert.match(
    (turn.content[0] as { type: "text"; text: string }).text,
    /\[time\] 2026-05-16 14:32:10 UTC/,
  );
});

test("Turn runtime builder adds explicit thread attribute to Telegram prefix", async () => {
  const buildTurn = createTelegramPromptTurnRuntimeBuilder({
    allocateQueueOrder: () => 1,
    downloadFile: async (_fileId, fileName) => `/tmp/${fileName}`,
    getTelegramThreadLabel: () => "🧭 Axial|bad]name",
  });
  const turn = await buildTurn([
    { message_id: 42, message_thread_id: 7, chat: { id: 7 }, text: "hi" },
  ]);
  assert.equal(
    (turn.content[0] as { type: "text"; text: string }).text,
    "[telegram|thread:🧭 Axial bad name] hi",
  );
});

test("Turn helpers summarize text and attachment-only turns", () => {
  assert.equal(
    formatTelegramTurnStatusSummary("hello there from telegram", []),
    "hello there from telegram",
  );
  assert.equal(
    formatTelegramTurnStatusSummary("", [
      {
        path: "/tmp/report-final-version.txt",
        fileName: "report-final-version.txt",
        isImage: false,
      },
    ]),
    "📎 report-final-version.txt",
  );
  assert.equal(
    formatTelegramTurnStatusSummary("", [
      { path: "/tmp/a.txt", fileName: "a.txt", isImage: false },
      { path: "/tmp/b.txt", fileName: "b.txt", isImage: false },
    ]),
    "📎 2 attachments",
  );
});

test("Turn helpers update queued prompt text for edited Telegram messages", () => {
  const turn = {
    kind: "prompt" as const,
    chatId: 99,
    replyToMessageId: 10,
    sourceMessageIds: [10],
    queueOrder: 1,
    queueLane: "default" as const,
    laneOrder: 1,
    queuedAttachments: [],
    content: [{ type: "text" as const, text: "[telegram] old" }],
    historyText: "old",
    statusSummary: "old",
  };
  const updated = updateTelegramPromptTurnText({
    turn,
    telegramPrefix: "[telegram]",
    rawText: "new edited message",
  });
  assert.equal(updated.content[0]?.type, "text");
  assert.equal(
    (updated.content[0] as { type: "text"; text: string }).text,
    "[telegram] new edited message",
  );
  assert.equal(updated.historyText, "new edited message");
  assert.equal(updated.statusSummary, "new edited message");
  assert.notEqual(updated, turn);
});

test("Turn runtime builder extracts text, downloads files, and allocates order", async () => {
  let nextOrder = 3;
  const downloaded: string[] = [];
  const buildTurn = createTelegramPromptTurnRuntimeBuilder({
    allocateQueueOrder: () => nextOrder++,
    downloadFile: async (fileId, fileName) => {
      downloaded.push(`${fileId}:${fileName}`);
      return `/tmp/${fileName}`;
    },
  });
  const turn = await buildTurn([
    {
      message_id: 11,
      chat: { id: 5 },
      caption: "see file",
      document: { file_id: "doc-1", file_name: "report.txt" },
    },
  ]);
  assert.equal(turn.queueOrder, 3);
  assert.equal(turn.statusSummary, "see file");
  assert.deepEqual(downloaded, ["doc-1:report.txt"]);
  assert.match(
    (turn.content[0] as { type: "text"; text: string }).text,
    /\[attachments\] \/tmp\n- \/report\.txt/,
  );
});

test("Turn runtime builder injects Telegram reply context into prompt turns", async () => {
  const buildTurn = createTelegramPromptTurnRuntimeBuilder({
    allocateQueueOrder: () => 1,
    downloadFile: async (_fileId, fileName) => `/tmp/${fileName}`,
  });
  const turn = await buildTurn([
    {
      message_id: 12,
      chat: { id: 5 },
      text: "Not yet",
      reply_to_message: { text: "Have you seen the latest Claude update?" },
    },
  ]);
  assert.equal(turn.statusSummary, "Not yet");
  assert.equal(
    turn.historyText,
    "Not yet\n\n[reply] Have you seen the latest Claude update?",
  );
  assert.equal(
    (turn.content[0] as { type: "text"; text: string }).text,
    "[telegram] Not yet\n\n[reply] Have you seen the latest Claude update?",
  );
});

test("Turn runtime builder identifies forwarded messages from non-owner users", async () => {
  const buildTurn = createTelegramPromptTurnRuntimeBuilder({
    allocateQueueOrder: () => 1,
    downloadFile: async (_fileId, fileName) => `/tmp/${fileName}`,
    getAllowedUserId: () => 100,
  });
  const turn = await buildTurn([
    {
      message_id: 12,
      chat: { id: 5 },
      from: { id: 100, first_name: "Owner" },
      forward_origin: {
        type: "user",
        sender_user: { id: 200, first_name: "Alice", username: "alice" },
      },
      text: "forwarded text",
    },
  ]);
  assert.equal(
    (turn.content[0] as { type: "text"; text: string }).text,
    "[telegram]\n\n[forward|from:alice] forwarded text",
  );
});

test("Turn runtime builder keeps a same-turn comment before forwarded content", async () => {
  const buildTurn = createTelegramPromptTurnRuntimeBuilder({
    allocateQueueOrder: () => 1,
    downloadFile: async (_fileId, fileName) => `/tmp/${fileName}`,
    getAllowedUserId: () => 100,
  });
  const turn = await buildTurn([
    {
      message_id: 20,
      chat: { id: 5 },
      from: { id: 100, first_name: "Owner" },
      text: "Мой комментарий",
    },
    {
      message_id: 21,
      chat: { id: 5 },
      from: { id: 100, first_name: "Owner" },
      forward_origin: {
        type: "user",
        sender_user: { id: 200, first_name: "Alice", username: "alice" },
      },
      text: "forwarded text",
    },
  ]);
  assert.equal(
    (turn.content[0] as { type: "text"; text: string }).text,
    "[telegram] Мой комментарий\n\n[forward|from:alice] forwarded text",
  );
});

test("Turn runtime builder keeps forwarded Rich media in source attachment context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-forward-rich-"));
  const buildTurn = createTelegramPromptTurnRuntimeBuilder({
    allocateQueueOrder: () => 1,
    downloadFile: async (_fileId, fileName) => {
      const path = join(dir, fileName);
      await writeFile(path, "image");
      return path;
    },
    getAllowedUserId: () => 100,
  });
  const turn = await buildTurn([
    {
      message_id: 20,
      chat: { id: 5 },
      from: { id: 100, first_name: "Owner" },
      text: "Мой комментарий",
    },
    {
      message_id: 21,
      chat: { id: 5 },
      from: { id: 100, first_name: "Owner" },
      forward_origin: {
        type: "user",
        sender_user: { id: 200, first_name: "Alice", username: "alice" },
      },
      rich_message: {
        blocks: [
          { type: "paragraph", text: "forwarded text" },
          {
            type: "photo",
            photo: [{ file_id: "rich-photo", file_size: 100 }],
          },
        ],
      },
    },
  ]);
  assert.equal(
    (turn.content[0] as { type: "text"; text: string }).text,
    [
      "[telegram] Мой комментарий",
      "",
      "[forward|from:alice] forwarded text",
      "",
      `[attachments|from:alice] ${dir}`,
      "- /photo-21-1.jpg",
    ].join("\n"),
  );
  assert.equal(turn.content.filter((item) => item.type === "image").length, 1);
});

test("Turn runtime builder places replied-message attachments in source attachment context", async () => {
  const buildTurn = createTelegramPromptTurnRuntimeBuilder({
    allocateQueueOrder: () => 1,
    downloadFile: async (_fileId, fileName) => `/tmp/${fileName}`,
  });
  const turn = await buildTurn([
    {
      message_id: 12,
      chat: { id: 5 },
      text: "look at this",
      reply_to_message: {
        message_id: 11,
        from: { id: 200, first_name: "Alice" },
        caption: "source image",
        photo: [{ file_id: "photo-1", file_size: 100 }],
      },
    },
  ]);
  assert.equal(
    (turn.content[0] as { type: "text"; text: string }).text,
    "[telegram] look at this\n\n[reply|from:200] source image\n\n[attachments|from:200] /tmp\n- /photo-11.jpg",
  );
});

test("Turn runtime builder keeps current attachments before source reply context", async () => {
  const buildTurn = createTelegramPromptTurnRuntimeBuilder({
    allocateQueueOrder: () => 1,
    downloadFile: async (_fileId, fileName) => `/tmp/${fileName}`,
  });
  const turn = await buildTurn([
    {
      message_id: 12,
      chat: { id: 5 },
      text: "current",
      document: { file_id: "doc-1", file_name: "mine.txt" },
      reply_to_message: {
        message_id: 11,
        from: { id: 200, username: "alice" },
        photo: [{ file_id: "photo-1", file_size: 100 }],
      },
    },
  ]);
  assert.equal(
    (turn.content[0] as { type: "text"; text: string }).text,
    [
      "[telegram] current",
      "",
      "[attachments] /tmp",
      "- /mine.txt",
      "",
      "[reply|from:alice]",
      "",
      "[attachments|from:alice] /tmp",
      "- /photo-11.jpg",
    ].join("\n"),
  );
});

test("Turn runtime builder includes reply block for attachment-only replied messages", async () => {
  const buildTurn = createTelegramPromptTurnRuntimeBuilder({
    allocateQueueOrder: () => 1,
    downloadFile: async (_fileId, fileName) => `/tmp/${fileName}`,
  });
  const turn = await buildTurn([
    {
      message_id: 12,
      chat: { id: 5 },
      text: "what is this?",
      reply_to_message: {
        message_id: 11,
        from: { id: 200, username: "alice" },
        photo: [{ file_id: "photo-1", file_size: 100 }],
      },
    },
  ]);
  assert.equal(
    (turn.content[0] as { type: "text"; text: string }).text,
    "[telegram] what is this?\n\n[reply|from:alice]\n\n[attachments|from:alice] /tmp\n- /photo-11.jpg",
  );
});

test("Turn runtime builder routes inbound handler output into prompt text", async () => {
  const buildTurn = createTelegramPromptTurnRuntimeBuilder<
    {
      message_id: number;
      chat: { id: number };
      voice: { file_id: string; mime_type: string };
    },
    { cwd: string }
  >({
    allocateQueueOrder: () => 1,
    downloadFile: async (_fileId, fileName) => `/tmp/${fileName}`,
    processAttachments: async (files, rawText, ctx) => ({
      rawText,
      promptFiles: files,
      handlerOutputs: [`transcript from ${ctx.cwd}`],
    }),
  });
  const turn = await buildTurn(
    [
      {
        message_id: 12,
        chat: { id: 5 },
        voice: { file_id: "voice-1", mime_type: "audio/ogg" },
      },
    ],
    [],
    { cwd: "/work" },
  );
  assert.equal(turn.statusSummary, "transcript from /work");
  assert.deepEqual(turn.sourceMessageIds, [12]);
  assert.equal(
    turn.historyText,
    "(no text)\n\n[attachments] /tmp\n- /voice-12.ogg\n\n[outputs]\n- transcript from /work",
  );
  assert.equal(
    (turn.content[0] as { type: "text"; text: string }).text,
    "[telegram]\n\n[attachments] /tmp\n- /voice-12.ogg\n\n[outputs]\n- transcript from /work",
  );
});

test("Turn runtime omits voice context when reply mode is only the implicit default", async () => {
  const buildTurn = createTelegramPromptTurnRuntimeBuilder<
    {
      message_id: number;
      chat: { id: number };
      voice: { file_id: string; mime_type: string };
    },
    unknown
  >({
    allocateQueueOrder: () => 1,
    downloadFile: async (_fileId, fileName) => `/tmp/${fileName}`,
    getVoiceReplyMode: () => "manual",
    isVoiceReplyModeConfigured: () => false,
  });
  const turn = await buildTurn([
    {
      message_id: 13,
      chat: { id: 5 },
      voice: { file_id: "voice-1", mime_type: "audio/ogg" },
    },
  ]);
  assert.doesNotMatch(
    (turn.content[0] as { type: "text"; text: string }).text,
    /\[voice\]/,
  );
});

test("Turn builder preserves topic thread target", async () => {
  const turn = await buildTelegramPromptTurnRuntime({
    telegramPrefix: "[telegram]",
    messages: [{ message_id: 14, message_thread_id: 42, chat: { id: -1007 } }],
    queueOrder: 1,
    rawText: "hello",
    files: [],
    statusText: "hello",
    inferImageMimeType: () => undefined,
  });
  assert.deepEqual(turn.target, { chatId: -1007, threadId: 42 });
});

test("Turn builder keeps private bot topic metadata out of prompt prefix", async () => {
  const turn = await buildTelegramPromptTurnRuntime({
    telegramPrefix: "[telegram]",
    messages: [
      {
        message_id: 14,
        message_thread_id: 42,
        chat: { id: 7, type: "private" },
      },
    ],
    queueOrder: 1,
    rawText: "hello",
    files: [],
    statusText: "hello",
    inferImageMimeType: () => undefined,
  });
  assert.equal(
    (turn.content[0] as { type: "text"; text: string }).text,
    "[telegram] hello",
  );
});

test("Turn builder keeps group topic metadata out of prompt prefix", async () => {
  const turn = await buildTelegramPromptTurnRuntime({
    telegramPrefix: "[telegram]",
    messages: [
      {
        message_id: 14,
        message_thread_id: 42,
        chat: { id: -1007, type: "supergroup" },
      },
    ],
    queueOrder: 1,
    rawText: "hello",
    files: [],
    statusText: "hello",
    inferImageMimeType: () => undefined,
  });
  assert.equal(
    (turn.content[0] as { type: "text"; text: string }).text,
    "[telegram] hello",
  );
});

test("Voice reply mode tags turn when voice file present and mode is mirror", async () => {
  const turn = await buildTelegramPromptTurnRuntime({
    telegramPrefix: "[telegram]",
    messages: [{ message_id: 14, chat: { id: 5 } }],
    queueOrder: 1,
    rawText: "transcribed voice message",
    files: [
      {
        path: "/tmp/voice-14.ogg",
        fileName: "voice-14.ogg",
        mimeType: "audio/ogg",
        kind: "voice" as import("../lib/media.ts").TelegramAttachmentKind,
        isImage: false,
      },
    ],
    statusText: "transcribed voice message",
    inferImageMimeType: () => undefined,
    voiceReplyMode: "mirror",
  });
  assert.equal(turn.voiceReplyPreferred, true);
  assert.equal(turn.voiceReplyRequired, false);
  assert.match(
    (turn.content[0] as { type: "text"; text: string }).text,
    /\[voice\] reply mode: mirror/,
  );
});

test("Voice reply mode tags turn with voice-required when mode is always", async () => {
  const turn = await buildTelegramPromptTurnRuntime({
    telegramPrefix: "[telegram]",
    messages: [{ message_id: 15, chat: { id: 5 } }],
    queueOrder: 1,
    rawText: "hello",
    files: [],
    statusText: "hello",
    inferImageMimeType: () => undefined,
    voiceReplyMode: "always",
  });
  assert.equal(turn.voiceReplyPreferred, false);
  assert.equal(turn.voiceReplyRequired, true);
  assert.match(
    (turn.content[0] as { type: "text"; text: string }).text,
    /\[voice\] reply mode: always/,
  );
});

test("Voice reply mode mirror with no voice file stays on the manual text path", async () => {
  const turn = await buildTelegramPromptTurnRuntime({
    telegramPrefix: "[telegram]",
    messages: [{ message_id: 17, chat: { id: 5 } }],
    queueOrder: 1,
    rawText: "hello",
    statusText: "hello",
    files: [],
    inferImageMimeType: () => undefined,
    voiceReplyMode: "mirror",
  });
  assert.equal(turn.voiceReplyPreferred, false);
  assert.equal(turn.voiceReplyRequired, false);
  assert.doesNotMatch(
    (turn.content[0] as { type: "text"; text: string }).text,
    /\[voice\]/,
  );
});

test("Voice reply mode always with voice file present sets voiceReplyRequired only", async () => {
  const turn = await buildTelegramPromptTurnRuntime({
    telegramPrefix: "[telegram]",
    messages: [{ message_id: 18, chat: { id: 5 } }],
    queueOrder: 1,
    rawText: "transcribed voice",
    statusText: "transcribed voice",
    files: [
      {
        path: "/tmp/voice.ogg",
        fileName: "voice.ogg",
        mimeType: "audio/ogg",
        kind: "voice" as import("../lib/media.ts").TelegramAttachmentKind,
        isImage: false,
      },
    ],
    inferImageMimeType: () => undefined,
    voiceReplyMode: "always",
  });
  assert.equal(turn.voiceReplyPreferred, false);
  assert.equal(turn.voiceReplyRequired, true);
  assert.match(
    (turn.content[0] as { type: "text"; text: string }).text,
    /\[voice\] reply mode: always/,
  );
});

test("Turn runtime tags manual mode without voice flags", async () => {
  const turn = await buildTelegramPromptTurnRuntime({
    telegramPrefix: "[telegram]",
    messages: [{ message_id: 16, chat: { id: 5 } }],
    queueOrder: 1,
    rawText: "hello",
    statusText: "hello",
    files: [
      {
        path: "/tmp/voice.ogg",
        fileName: "voice.ogg",
        mimeType: "audio/ogg",
        kind: "voice" as import("../lib/media.ts").TelegramAttachmentKind,
        isImage: false,
      },
    ],
    inferImageMimeType: () => undefined,
    voiceReplyMode: "manual",
  });
  assert.equal(turn.voiceReplyPreferred, false);
  assert.equal(turn.voiceReplyRequired, false);
  assert.match(
    (turn.content[0] as { type: "text"; text: string }).text,
    /\[voice\] reply mode: manual/,
  );
});

test("Turn runtime helper reads image payloads from local files", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-turn-runtime-"));
  const imagePath = join(tempDir, "image.png");
  await writeFile(imagePath, Buffer.from("demo-image"));
  const turn = await buildTelegramPromptTurnRuntime({
    telegramPrefix: "[telegram]",
    messages: [{ message_id: 11, chat: { id: 5 } }],
    queueOrder: 1,
    rawText: "see image",
    files: [
      {
        path: imagePath,
        fileName: "image.png",
        isImage: true,
        mimeType: "image/png",
      },
    ],
    inferImageMimeType: () => undefined,
  });
  assert.deepEqual(turn.content[1], {
    type: "image",
    data: Buffer.from("demo-image").toString("base64"),
    mimeType: "image/png",
  });
});

test("Turn helpers update matching queued prompt items only", () => {
  const prompt = {
    kind: "prompt" as const,
    chatId: 99,
    replyToMessageId: 10,
    sourceMessageIds: [10],
    queueOrder: 1,
    queueLane: "default" as const,
    laneOrder: 1,
    queuedAttachments: [],
    content: [{ type: "text" as const, text: "[telegram] old" }],
    historyText: "old",
    statusSummary: "old",
  };
  const control = {
    kind: "control" as const,
    controlType: "status" as const,
    chatId: 99,
    replyToMessageId: 11,
    queueOrder: 2,
    queueLane: "control" as const,
    laneOrder: 2,
    statusSummary: "status",
    execute: async () => {},
  };
  const result = updateQueuedTelegramPromptTurnText({
    items: [control, prompt],
    sourceMessageId: 10,
    telegramPrefix: "[telegram]",
    rawText: "edited",
  });
  assert.equal(result.changed, true);
  assert.equal(result.items[0], control);
  assert.equal(
    ((result.items[1] as typeof prompt).content[0] as { text: string }).text,
    "[telegram] edited",
  );
  const unchanged = updateQueuedTelegramPromptTurnText({
    items: [control, prompt],
    sourceMessageId: 12,
    telegramPrefix: "[telegram]",
    rawText: "ignored",
  });
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.items, [control, prompt]);
});

test("Turn edit runtime binds queued prompt updates to status", () => {
  const events: string[] = [];
  let items = [
    {
      kind: "prompt" as const,
      chatId: 99,
      replyToMessageId: 10,
      sourceMessageIds: [10],
      queueOrder: 1,
      queueLane: "default" as const,
      laneOrder: 1,
      queuedAttachments: [],
      content: [{ type: "text" as const, text: "[telegram] old" }],
      historyText: "old",
      statusSummary: "old",
    },
  ];
  const runtime = createTelegramQueuedPromptEditRuntime<
    { message_id: number; text?: string },
    string
  >({
    getQueuedItems: () => items,
    setQueuedItems: (nextItems) => {
      items = nextItems as typeof items;
      events.push(`items:${nextItems.length}`);
    },
    updateStatus: (ctx) => {
      events.push(`status:${ctx}`);
    },
  });
  assert.equal(
    runtime.updateFromEditedMessage({ message_id: 10, text: "edited" }, "ctx"),
    true,
  );
  assert.equal(
    (items[0]?.content[0] as { text: string }).text,
    "[telegram] edited",
  );
  assert.deepEqual(events, ["items:1", "status:ctx"]);
});

test("Turn edit runtime keeps reply context prompt-only when queued messages change", () => {
  let items = [
    {
      kind: "prompt" as const,
      chatId: 99,
      replyToMessageId: 10,
      sourceMessageIds: [10],
      queueOrder: 1,
      queueLane: "default" as const,
      laneOrder: 1,
      queuedAttachments: [],
      content: [{ type: "text" as const, text: "[telegram] old" }],
      historyText: "old",
      statusSummary: "old",
    },
  ];
  const runtime = createTelegramQueuedPromptEditRuntime<
    {
      message_id: number;
      text?: string;
      reply_to_message?: { text?: string };
    },
    string
  >({
    getQueuedItems: () => items,
    setQueuedItems: (nextItems) => {
      items = nextItems as typeof items;
    },
    updateStatus: () => {},
  });
  runtime.updateFromEditedMessage(
    {
      message_id: 10,
      text: "edited",
      reply_to_message: { text: "quoted" },
    },
    "ctx",
  );
  assert.equal(
    (items[0]?.content[0] as { text: string }).text,
    "[telegram] edited\n\n[reply] quoted",
  );
  assert.equal(items[0]?.historyText, "edited\n\n[reply] quoted");
  assert.equal(items[0]?.statusSummary, "edited");
});

test("Turn helpers preserve queued prompt attachments when captions are edited", () => {
  const turn = {
    kind: "prompt" as const,
    chatId: 99,
    replyToMessageId: 10,
    sourceMessageIds: [10],
    queueOrder: 1,
    queueLane: "default" as const,
    laneOrder: 1,
    queuedAttachments: [],
    content: [
      {
        type: "text" as const,
        text:
          "[telegram] old caption\n\n" +
          "[attachments] /tmp\n" +
          "- /demo.png\n" +
          "- /report.txt",
      },
      { type: "image" as const, data: "abc", mimeType: "image/png" },
    ],
    historyText:
      "old caption\n\n[attachments] /tmp\n- /demo.png\n- /report.txt",
    statusSummary: "old caption",
  };
  const updated = updateTelegramPromptTurnText({
    turn,
    telegramPrefix: "[telegram]",
    rawText: "new caption",
  });
  assert.equal(
    (updated.content[0] as { type: "text"; text: string }).text,
    "[telegram] new caption\n\n" +
      "[attachments] /tmp\n" +
      "- /demo.png\n" +
      "- /report.txt",
  );
  assert.deepEqual(updated.content[1], turn.content[1]);
  assert.equal(
    updated.historyText,
    "new caption\n\n[attachments] /tmp\n- /demo.png\n- /report.txt",
  );
  assert.equal(updated.statusSummary, "new caption");
});

test("Turn helpers preserve abort-history prompt context when queued turns are edited", () => {
  const turn = {
    kind: "prompt" as const,
    chatId: 99,
    replyToMessageId: 10,
    sourceMessageIds: [10],
    queueOrder: 1,
    queueLane: "default" as const,
    laneOrder: 1,
    queuedAttachments: [],
    content: [
      {
        type: "text" as const,
        text:
          "[telegram]\n\n" +
          "Earlier Telegram messages arrived after an aborted turn. " +
          "Treat them as prior user messages, in order:\n\n" +
          "1. older Current Telegram message: quote\n\n" +
          "Current Telegram message:\nold current",
      },
    ],
    historyText: "old current",
    statusSummary: "old current",
  };
  const updated = updateTelegramPromptTurnText({
    turn,
    telegramPrefix: "[telegram]",
    rawText: "new current",
  });
  assert.equal(
    (updated.content[0] as { type: "text"; text: string }).text,
    "[telegram]\n\n" +
      "Earlier Telegram messages arrived after an aborted turn. " +
      "Treat them as prior user messages, in order:\n\n" +
      "1. older Current Telegram message: quote\n\n" +
      "Current Telegram message:\nnew current",
  );
  assert.equal(updated.historyText, "new current");
  assert.equal(updated.statusSummary, "new current");
});

test("Turn edit preserves voice reply tags", () => {
  const turn = {
    kind: "prompt" as const,
    chatId: 1,
    replyToMessageId: 10,
    sourceMessageIds: [10],
    queueOrder: 1,
    queueLane: "default" as const,
    laneOrder: 1,
    queuedAttachments: [],
    content: [{ type: "text" as const, text: "hello" }],
    historyText: "hello",
    statusSummary: "hello",
    voiceReplyPreferred: true,
    voiceReplyRequired: false,
  };
  const updated = updateTelegramPromptTurnText({
    turn,
    telegramPrefix: "[telegram]",
    rawText: "edited",
  });
  assert.equal(updated.voiceReplyPreferred, true);
  assert.equal(updated.voiceReplyRequired, false);
});

test("Turn helpers assemble prompt turns with text, ids, history, and image payloads", async () => {
  const turn = await buildTelegramPromptTurn({
    telegramPrefix: "[telegram]",
    messages: [
      { message_id: 10, chat: { id: 99 } },
      { message_id: 11, chat: { id: 99 } },
    ],
    historyTurns: [
      {
        kind: "prompt",
        chatId: 99,
        replyToMessageId: 1,
        sourceMessageIds: [1],
        queueOrder: 1,
        queueLane: "default",
        laneOrder: 1,
        queuedAttachments: [],
        content: [{ type: "text", text: "ignored" }],
        historyText: "older message",
        statusSummary: "older",
      },
    ],
    queueOrder: 7,
    rawText: "current message",
    files: [
      {
        path: "/tmp/demo.png",
        fileName: "demo.png",
        isImage: true,
        mimeType: "image/png",
      },
      {
        path: "/tmp/report.txt",
        fileName: "report.txt",
        isImage: false,
      },
    ],
    readBinaryFile: async () => new Uint8Array([1, 2, 3]),
    inferImageMimeType: () => undefined,
  });
  assert.equal(turn.chatId, 99);
  assert.equal(turn.replyToMessageId, 10);
  assert.deepEqual(turn.sourceMessageIds, [10, 11]);
  assert.equal(turn.queueOrder, 7);
  assert.equal(turn.statusSummary, "current message");
  assert.equal(
    turn.historyText,
    "current message\n\n[attachments] /tmp\n- /demo.png\n- /report.txt",
  );
  assert.equal(turn.content.length, 2);
  assert.equal(turn.content[0]?.type, "text");
  assert.match(
    (turn.content[0] as { type: "text"; text: string }).text,
    /Earlier Telegram messages arrived after an aborted turn/,
  );
  assert.deepEqual(turn.content[1], {
    type: "image",
    data: Buffer.from([1, 2, 3]).toString("base64"),
    mimeType: "image/png",
  });
});

test("getTelegramVoiceReplyMode returns default when no config provided", () => {
  assert.equal(getTelegramVoiceReplyMode(), "manual");
  assert.equal(getTelegramVoiceReplyMode(undefined), "manual");
});

test("getTelegramVoiceReplyMode reads frozen config with valid replyMode", () => {
  const frozenConfig = Object.freeze({
    voice: { replyMode: "always" as const },
  });
  assert.equal(getTelegramVoiceReplyMode(frozenConfig), "always");
});

test("getTelegramVoiceReplyMode ignores frozen config with invalid replyMode", () => {
  const frozenConfig = Object.freeze({
    voice: { replyMode: "bad-mode" as any },
  });
  assert.equal(getTelegramVoiceReplyMode(frozenConfig), "manual");
});

test("getTelegramVoiceReplyMode reads config voice.replyMode", () => {
  assert.equal(
    getTelegramVoiceReplyMode({ voice: { replyMode: "mirror" } }),
    "mirror",
  );
  assert.equal(
    getTelegramVoiceReplyMode({ voice: { replyMode: "always" } }),
    "always",
  );
  assert.equal(
    getTelegramVoiceReplyMode({ voice: { replyMode: "manual" } }),
    "manual",
  );
});

test("getTelegramVoiceReplyMode falls back to manual for invalid or missing config", () => {
  assert.equal(
    getTelegramVoiceReplyMode({ voice: { replyMode: "invalid" as any } }),
    "manual",
  );
  assert.equal(getTelegramVoiceReplyMode({ voice: {} }), "manual");
  assert.equal(getTelegramVoiceReplyMode({}), "manual");
  assert.equal(getTelegramVoiceReplyMode(null as any), "manual");
  assert.equal(getTelegramVoiceReplyMode(undefined), "manual");
});
