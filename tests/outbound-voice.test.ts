/**
 * Regression tests for Telegram outbound voice delivery helpers
 * Exercises direct voice-sender ownership after extraction from outbound.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramVoiceReplySender } from "../lib/outbound-voice.ts";
import { createTelegramThreadTarget } from "../lib/target.ts";
import {
  clearTelegramVoiceSynthesisProviders,
  registerTelegramVoiceSynthesisProvider,
} from "../lib/voice.ts";

test.beforeEach(() => {
  clearTelegramVoiceSynthesisProviders();
});

test("Outbound voice sender uploads provider opus result with reply markup and transcript", async () => {
  registerTelegramVoiceSynthesisProvider(
    async () => ({ audioPath: "/tmp/direct.opus", transcriptText: "spoken" }),
    { id: "direct-test" },
  );
  const uploads: unknown[] = [];
  const actions: unknown[] = [];
  const sendVoice = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendRecordVoiceAction: async (chatId) => {
      actions.push(chatId);
    },
    sendMultipart: async (...args) => {
      uploads.push(args);
    },
  });

  await sendVoice({ chatId: 1, replyToMessageId: 2 }, "hello", {
    replyMarkup: { inline_keyboard: [] },
    replyToPrompt: true,
  });

  assert.deepEqual(actions, [1]);
  assert.deepEqual(uploads, [
    [
      "sendVoice",
      {
        chat_id: "1",
        caption: "spoken",
        reply_parameters: JSON.stringify({
          message_id: 2,
          allow_sending_without_reply: true,
        }),
        reply_markup: JSON.stringify({ inline_keyboard: [] }),
      },
      "voice",
      "/tmp/direct.opus",
      "direct.opus",
    ],
  ]);
});

test("Outbound voice sender uploads voice into thread target", async () => {
  registerTelegramVoiceSynthesisProvider(async () => "/tmp/direct.ogg", {
    id: "thread-test",
  });
  const uploads: unknown[] = [];
  const sendVoice = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async (...args) => {
      uploads.push(args);
    },
  });

  await sendVoice(
    {
      chatId: -1007,
      replyToMessageId: 2,
      target: createTelegramThreadTarget(-1007, 42),
    },
    "hello",
  );

  const fields = (uploads[0] as unknown[])[1] as Record<string, string>;
  assert.equal(fields.chat_id, "-1007");
  assert.equal(fields.message_thread_id, "42");
  assert.equal(
    fields.reply_parameters,
    JSON.stringify({
      message_id: 2,
      allow_sending_without_reply: true,
    }),
  );
});

test("Outbound voice sender records and throws when every source fails", async () => {
  const events: Array<{ category: string; message: string; phase?: unknown }> =
    [];
  const sendVoice = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async () => {},
    recordRuntimeEvent: (category, error, details) => {
      events.push({
        category,
        message: (error as Error).message,
        phase: details?.phase,
      });
    },
  });

  await assert.rejects(
    sendVoice({ chatId: 1, replyToMessageId: 2 }, "hello"),
    /every voice synthesis provider and outbound voice handler failed/,
  );
  assert.deepEqual(events, [
    {
      category: "voice",
      message:
        "Failed to send voice reply: every voice synthesis provider and outbound voice handler failed.",
      phase: "send",
    },
  ]);
});
