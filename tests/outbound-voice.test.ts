/**
 * Regression tests for Telegram outbound voice delivery helpers
 * Exercises direct voice-sender ownership after extraction from outbound.ts
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { execCommandTemplate } from "../lib/command-templates.ts";
import type { TelegramOutboundHandlerConfig } from "../lib/config.ts";
import {
  findTelegramOutboundHandlers,
  generateTelegramVoiceReplyFile,
} from "../lib/outbound.ts";
import { createTelegramVoiceReplySender } from "../lib/outbound-voice.ts";
import { createTelegramThreadTarget } from "../lib/target.ts";
import {
  clearTelegramVoiceSynthesisProviders,
  registerTelegramVoiceSynthesisProvider,
} from "../lib/voice.ts";

test.beforeEach(() => {
  clearTelegramVoiceSynthesisProviders();
});

test(
  "Outbound voice sender executes a Windows cmd handler and uploads its ogg artifact",
  { skip: process.platform !== "win32" },
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-outbound-voice-cmd-"));
    const scriptPath = join(tempDir, "voice-writer.cmd");
    await writeFile(
      scriptPath,
      "@echo off\r\n>\"%~1\" echo OggS\r\n",
      "utf8",
    );
    const handlers = [{
      type: "voice",
      template: `"${scriptPath}" {ogg}`,
      output: "ogg",
    }];
    const uploads: Array<{ filePath: string; content: string }> = [];
    const diagnostics: string[] = [];
    const sendVoice = createTelegramVoiceReplySender(
      {
        execCommand: execCommandTemplate,
        getHandlers: () => handlers,
        tempDir,
        sendMultipart: async (_method, _fields, _fileField, filePath) => {
          uploads.push({
            filePath,
            content: await readFile(filePath, "utf8"),
          });
        },
        recordRuntimeEvent: (_category, error, details) => {
          diagnostics.push(
            `${String(details?.phase)}:${error instanceof Error ? error.message : String(error)}`,
          );
        },
      },
      {
        findVoiceHandlers: (configured) =>
          findTelegramOutboundHandlers(
            configured as TelegramOutboundHandlerConfig[] | undefined,
            "voice",
          ),
        generateVoiceFile: (text, options) =>
          generateTelegramVoiceReplyFile(text, options),
      },
    );
    try {
      await sendVoice(
        { chatId: 1, replyToMessageId: 2 },
        "hello from Windows",
      ).catch((error) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify(diagnostics)}`,
        );
      });
      assert.equal(uploads.length, 1);
      assert.match(uploads[0]?.filePath ?? "", /-voice\.ogg$/u);
      assert.equal(uploads[0]?.content, "OggS\r\n");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

test("Outbound voice sender uploads provider opus result with reply markup", async () => {
  registerTelegramVoiceSynthesisProvider(
    async () => "/tmp/direct.opus",
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
