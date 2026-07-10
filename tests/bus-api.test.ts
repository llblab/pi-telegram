/**
 * Regression tests for Telegram bus-aware API runtime
 * Verifies follower outbound API calls route through the local bus while leaders use direct transport
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramBusAwareApiRuntime } from "../lib/bus-api.ts";
import type { TelegramBridgeApiRuntime } from "../lib/telegram-api.ts";

function createDirectRuntime(calls: unknown[]): TelegramBridgeApiRuntime {
  return {
    call: async <TResponse>(method: string, body: Record<string, unknown>) => {
      calls.push({ kind: "call", method, body });
      return { ok: true } as TResponse;
    },
    callMultipart: async <TResponse>(
      method: string,
      fields: Record<string, string>,
      fileField: string,
      filePath: string,
      fileName: string,
    ) => {
      calls.push({
        kind: "multipart",
        method,
        fields,
        fileField,
        filePath,
        fileName,
      });
      return { ok: true } as TResponse;
    },
    downloadFile: async (fileId, suggestedName) => {
      calls.push({ kind: "download", fileId, suggestedName });
      return "/tmp/file";
    },
    deleteWebhook: async () => true,
    getUpdates: async () => [],
    setMyCommands: async (commands) => {
      calls.push({ kind: "commands", commands });
      return true;
    },
    sendChatAction: async (chatId, action, options) => {
      calls.push({ kind: "chat-action", chatId, action, options });
      return true;
    },
    sendTypingAction: async (chatId, options) => {
      calls.push({ kind: "typing", chatId, options });
      return true;
    },
    sendRecordVoiceAction: async (chatId, options) => {
      calls.push({ kind: "record-voice", chatId, options });
      return true;
    },
    sendMessageDraft: async (chatId, draftId, text, options) => {
      calls.push({ kind: "draft", chatId, draftId, text, options });
      return true;
    },
    sendMessage: async (body) => {
      calls.push({ kind: "message", body });
      return { message_id: 1 };
    },
    sendRichMessage: async (body) => {
      calls.push({ kind: "rich", body });
      return { message_id: 2 };
    },
    sendRichMessageDraft: async (body) => {
      calls.push({ kind: "rich-draft", body });
      return true;
    },
    editMessageText: async (body) => {
      calls.push({ kind: "edit", body });
      return "edited";
    },
    answerCallbackQuery: async (callbackQueryId, text) => {
      calls.push({ kind: "answer-callback", callbackQueryId, text });
    },
    answerGuestQuery: async (guestQueryId, text) => {
      calls.push({ kind: "answer-guest", guestQueryId, text });
    },
    deleteMessage: async (chatId, messageId) => {
      calls.push({ kind: "delete", chatId, messageId });
    },
    prepareTempDir: async () => 0,
  };
}

test("Bus-aware API runtime uses direct transport while this instance owns Telegram", async () => {
  const directCalls: unknown[] = [];
  const busCalls: unknown[] = [];
  const runtime = createTelegramBusAwareApiRuntime({
    directRuntime: createDirectRuntime(directCalls),
    ownsDirect: () => true,
    callFollowerApi: async (method, args) => {
      busCalls.push({ method, args });
      return { message_id: 99 };
    },
  });

  assert.deepEqual(
    await runtime.sendRichMessage({
      chat_id: 1,
      rich_message: { markdown: "hi" },
    }),
    {
      message_id: 2,
    },
  );
  assert.deepEqual(directCalls, [
    { kind: "rich", body: { chat_id: 1, rich_message: { markdown: "hi" } } },
  ]);
  assert.deepEqual(busCalls, []);
});

test("Bus-aware API runtime routes follower outbound calls through the leader", async () => {
  const directCalls: unknown[] = [];
  const busCalls: unknown[] = [];
  const runtime = createTelegramBusAwareApiRuntime({
    directRuntime: createDirectRuntime(directCalls),
    ownsDirect: () => false,
    callFollowerApi: async (method, args) => {
      busCalls.push({ method, args });
      if (args[0] === "sendRichMessage") return { message_id: 77 };
      if (method === "downloadFile") return "/tmp/leader-photo.png";
      return true;
    },
  });

  assert.deepEqual(
    await runtime.sendRichMessage({
      chat_id: 1,
      rich_message: { markdown: "hi" },
    }),
    {
      message_id: 77,
    },
  );
  assert.equal(
    await runtime.sendChatAction(1, "typing", { message_thread_id: 5 }),
    true,
  );
  assert.equal(
    await runtime.call("sendChatAction", { chat_id: 1, action: "typing" }),
    true,
  );
  assert.equal(
    await runtime.sendMessageDraft(1, 2, "draft", { message_thread_id: 5 }),
    true,
  );
  await runtime.deleteMessage(1, 9);
  await runtime.answerCallbackQuery("cb1", "Done");
  await runtime.answerGuestQuery("guest1", "Hello", { parseMode: "Markdown" });
  await runtime.answerGuestQuery("guest2", undefined, {
    result: {
      type: "photo",
      id: "photo-1",
      photo_file_id: "cached-photo",
      caption: "Result",
    },
  });
  assert.equal(
    await runtime.downloadFile("file1", "photo.png"),
    "/tmp/leader-photo.png",
  );

  assert.deepEqual(directCalls, []);
  assert.deepEqual(busCalls, [
    {
      method: "call",
      args: [
        "sendRichMessage",
        { chat_id: 1, rich_message: { markdown: "hi" } },
      ],
    },
    {
      method: "call",
      args: [
        "sendChatAction",
        { chat_id: 1, action: "typing", message_thread_id: 5 },
      ],
    },
    {
      method: "call",
      args: ["sendChatAction", { chat_id: 1, action: "typing" }, undefined],
    },
    {
      method: "call",
      args: [
        "sendMessageDraft",
        { chat_id: 1, draft_id: 2, text: "draft", message_thread_id: 5 },
      ],
    },
    {
      method: "call",
      args: ["deleteMessage", { chat_id: 1, message_id: 9 }],
    },
    {
      method: "call",
      args: ["answerCallbackQuery", { callback_query_id: "cb1", text: "Done" }],
    },
    {
      method: "call",
      args: [
        "answerGuestQuery",
        {
          guest_query_id: "guest1",
          result: {
            type: "article",
            id: "1",
            title: "Response",
            input_message_content: {
              message_text: "Hello",
              parse_mode: "Markdown",
            },
          },
        },
      ],
    },
    {
      method: "call",
      args: [
        "answerGuestQuery",
        {
          guest_query_id: "guest2",
          result: {
            type: "photo",
            id: "photo-1",
            photo_file_id: "cached-photo",
            caption: "Result",
          },
        },
      ],
    },
    {
      method: "downloadFile",
      args: ["file1", "photo.png"],
    },
  ]);
});

test("Bus-aware API runtime applies follower default thread to scoped actions", async () => {
  const busCalls: unknown[] = [];
  const runtime = createTelegramBusAwareApiRuntime({
    directRuntime: createDirectRuntime([]),
    ownsDirect: () => false,
    getDefaultTarget: () => ({ chatId: 1, threadId: 5 }),
    callFollowerApi: async (method, args) => {
      busCalls.push({ method, args });
      return true;
    },
  });

  await runtime.sendTypingAction(1);
  await runtime.sendRecordVoiceAction(1);
  await runtime.sendMessageDraft(1, 2, "draft");
  await runtime.sendTypingAction(2);

  assert.deepEqual(busCalls, [
    {
      method: "call",
      args: [
        "sendChatAction",
        { chat_id: 1, action: "typing", message_thread_id: 5 },
      ],
    },
    {
      method: "call",
      args: [
        "sendChatAction",
        { chat_id: 1, action: "record_voice", message_thread_id: 5 },
      ],
    },
    {
      method: "call",
      args: [
        "sendMessageDraft",
        { chat_id: 1, draft_id: 2, text: "draft", message_thread_id: 5 },
      ],
    },
    {
      method: "call",
      args: ["sendChatAction", { chat_id: 2, action: "typing" }],
    },
  ]);
});

test("Bus-aware API runtime routes follower multipart uploads through the leader", async () => {
  const busCalls: unknown[] = [];
  const runtime = createTelegramBusAwareApiRuntime({
    directRuntime: createDirectRuntime([]),
    ownsDirect: () => false,
    callFollowerApi: async (method, args) => {
      busCalls.push({ method, args });
      return { ok: true };
    },
  });

  assert.deepEqual(
    await runtime.callMultipart(
      "sendDocument",
      { chat_id: "1" },
      "document",
      "/tmp/a.txt",
      "a.txt",
    ),
    { ok: true },
  );
  assert.deepEqual(busCalls, [
    {
      method: "callMultipart",
      args: [
        "sendDocument",
        { chat_id: "1" },
        "document",
        "/tmp/a.txt",
        "a.txt",
        undefined,
      ],
    },
  ]);
});
