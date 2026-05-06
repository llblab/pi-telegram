/**
 * Regression tests for the Telegram outbound attachments domain
 * Covers outbound attachment queueing and delivery behavior in one domain-level suite
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createTelegramQueuedOutboundAttachmentSender,
  getTelegramOutboundAttachmentByteLimitFromEnv,
  queueTelegramOutboundAttachments,
  registerTelegramOutboundAttachmentTool,
  sendQueuedTelegramOutboundAttachments,
  TELEGRAM_OUTBOUND_ATTACHMENT_DEFAULT_MAX_BYTES,
  type TelegramOutboundAttachmentQueueTargetView,
  type TelegramQueuedOutboundAttachmentTurnView,
} from "../lib/outbound-attachments.ts";
import type { ExtensionAPI } from "../lib/pi.ts";

function createAttachmentQueueTarget(
  queuedAttachments: TelegramOutboundAttachmentQueueTargetView["queuedAttachments"] = [],
): TelegramOutboundAttachmentQueueTargetView {
  return { queuedAttachments };
}

function createAttachmentTurn(
  queuedAttachments = [{ path: "/tmp/a.png", fileName: "a.png" }],
): TelegramQueuedOutboundAttachmentTurnView {
  return { chatId: 1, replyToMessageId: 2, queuedAttachments };
}

type RegisteredAttachmentTool = {
  name?: string;
  execute: (
    toolCallId: string,
    params: { paths: string[] },
  ) => Promise<{ details: { paths: string[] } }>;
};

test("Outbound attachment byte-limit helpers own the outbound file default", () => {
  assert.equal(
    TELEGRAM_OUTBOUND_ATTACHMENT_DEFAULT_MAX_BYTES,
    50 * 1024 * 1024,
  );
  assert.equal(
    getTelegramOutboundAttachmentByteLimitFromEnv(
      { PI_TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES: "12345" },
      ["PI_TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES"],
      99,
    ),
    12345,
  );
  assert.equal(
    getTelegramOutboundAttachmentByteLimitFromEnv(
      {
        PI_TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES: "0",
        TELEGRAM_MAX_ATTACHMENT_SIZE_BYTES: "bad",
      },
      [
        "PI_TELEGRAM_OUTBOUND_ATTACHMENT_MAX_BYTES",
        "TELEGRAM_MAX_ATTACHMENT_SIZE_BYTES",
      ],
      99,
    ),
    99,
  );
});

test("Outbound attachment tool registration delegates queueing", async () => {
  let tool: RegisteredAttachmentTool | undefined;
  const api = {
    registerTool: (definition: RegisteredAttachmentTool) => {
      tool = definition;
    },
  } as unknown as ExtensionAPI;
  const activeTurn = createAttachmentQueueTarget();
  registerTelegramOutboundAttachmentTool(api, {
    maxAttachmentsPerTurn: 2,
    getActiveTurn: () => activeTurn,
    statPath: async () => ({ isFile: () => true }),
  });
  assert.equal(tool?.name, "telegram_attach");
  assert.ok(tool);
  const result = await tool.execute("tool-call", { paths: ["/tmp/report.md"] });
  assert.deepEqual(activeTurn.queuedAttachments, [
    { path: "/tmp/report.md", fileName: "report.md" },
  ]);
  assert.deepEqual(result.details.paths, ["/tmp/report.md"]);
});

test("Outbound attachment queueing adds files to the active Telegram turn", async () => {
  const activeTurn = createAttachmentQueueTarget();
  const result = await queueTelegramOutboundAttachments({
    activeTurn,
    paths: ["/tmp/demo.txt"],
    maxAttachmentsPerTurn: 2,
    statPath: async () => ({ isFile: () => true }),
  });
  assert.deepEqual(activeTurn.queuedAttachments, [
    { path: "/tmp/demo.txt", fileName: "demo.txt" },
  ]);
  assert.deepEqual(result.details.paths, ["/tmp/demo.txt"]);
  assert.equal(result.content[0]?.text, "\nQueued 1 Telegram attachment(s).");
});

test("Outbound attachment queueing uses the domain stat fallback", async () => {
  const tempDir = await mkdtemp(
    join(tmpdir(), "pi-telegram-attachment-queue-"),
  );
  const filePath = join(tempDir, "demo.txt");
  await writeFile(filePath, "demo", "utf8");
  const activeTurn = createAttachmentQueueTarget();
  const result = await queueTelegramOutboundAttachments({
    activeTurn,
    paths: [filePath],
    maxAttachmentsPerTurn: 1,
  });
  assert.deepEqual(result.details.paths, [filePath]);
});

test("Outbound attachment queueing rejects oversized files", async () => {
  await assert.rejects(
    () =>
      queueTelegramOutboundAttachments({
        activeTurn: createAttachmentQueueTarget(),
        paths: ["/tmp/large.bin"],
        maxAttachmentsPerTurn: 1,
        maxAttachmentSizeBytes: 10,
        statPath: async () => ({ isFile: () => true, size: 11 }),
      }),
    {
      message:
        "Attachment exceeds size limit (11 bytes > 10 bytes): /tmp/large.bin",
    },
  );
});

test("Outbound attachment queueing stays atomic when a later file is rejected", async () => {
  const activeTurn = createAttachmentQueueTarget();
  await assert.rejects(
    () =>
      queueTelegramOutboundAttachments({
        activeTurn,
        paths: ["/tmp/ok.txt", "/tmp/large.bin"],
        maxAttachmentsPerTurn: 2,
        maxAttachmentSizeBytes: 10,
        statPath: async (path) => ({
          isFile: () => true,
          size: path.endsWith("large.bin") ? 11 : 1,
        }),
      }),
    {
      message:
        "Attachment exceeds size limit (11 bytes > 10 bytes): /tmp/large.bin",
    },
  );
  assert.deepEqual(activeTurn.queuedAttachments, []);
});

test("Outbound attachment queueing rejects missing turns, non-files, and full queues", async () => {
  await assert.rejects(
    () =>
      queueTelegramOutboundAttachments({
        activeTurn: undefined,
        paths: ["/tmp/demo.txt"],
        maxAttachmentsPerTurn: 1,
        statPath: async () => ({ isFile: () => true }),
      }),
    { message: /active Telegram turn/ },
  );
  await assert.rejects(
    () =>
      queueTelegramOutboundAttachments({
        activeTurn: createAttachmentQueueTarget(),
        paths: ["/tmp/demo.txt"],
        maxAttachmentsPerTurn: 1,
        statPath: async () => ({ isFile: () => false }),
      }),
    { message: "Not a file: /tmp/demo.txt" },
  );
  await assert.rejects(
    () =>
      queueTelegramOutboundAttachments({
        activeTurn: createAttachmentQueueTarget([
          { path: "/tmp/a.txt", fileName: "a.txt" },
        ]),
        paths: ["/tmp/demo.txt"],
        maxAttachmentsPerTurn: 1,
        statPath: async () => ({ isFile: () => true }),
      }),
    { message: "Attachment limit reached (1)" },
  );
});

test("Outbound attachment delivery includes reply parameters for uploads", async () => {
  const sentFields: Array<Record<string, string>> = [];
  await sendQueuedTelegramOutboundAttachments(createAttachmentTurn(), {
    sendMultipart: async (_method, fields) => {
      sentFields.push(fields);
    },
    sendTextReply: async () => undefined,
  });
  assert.deepEqual(sentFields, [
    {
      chat_id: "1",
      reply_parameters: JSON.stringify({
        message_id: 2,
        allow_sending_without_reply: true,
      }),
    },
  ]);
});

test("Outbound attachment delivery chooses photo vs document methods from file paths", async () => {
  const sent: Array<string> = [];
  await sendQueuedTelegramOutboundAttachments(
    createAttachmentTurn([
      { path: "/tmp/a.png", fileName: "a.png" },
      { path: "/tmp/b.txt", fileName: "b.txt" },
    ]),
    {
      sendMultipart: async (
        method,
        _fields,
        fileField,
        _filePath,
        fileName,
      ) => {
        sent.push(`${method}:${fileField}:${fileName}`);
      },
      sendTextReply: async () => undefined,
    },
  );
  assert.deepEqual(sent, [
    "sendPhoto:photo:a.png",
    "sendDocument:document:b.txt",
  ]);
});

test("Outbound attachment delivery uses the domain stat fallback for size checks", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "pi-telegram-attachment-"));
  const filePath = join(tempDir, "large.txt");
  await writeFile(filePath, "too large", "utf8");
  const replies: string[] = [];
  await sendQueuedTelegramOutboundAttachments(
    createAttachmentTurn([{ path: filePath, fileName: "large.txt" }]),
    {
      sendMultipart: async () => {
        throw new Error("unexpected upload");
      },
      sendTextReply: async (_chatId, _replyToMessageId, text) => {
        replies.push(text);
      },
      maxAttachmentSizeBytes: 4,
    },
  );
  assert.deepEqual(replies, [
    "Failed to send attachment large.txt: Attachment exceeds size limit (9 bytes > 4 bytes)",
  ]);
});

test("Outbound attachment delivery checks attachment sizes before upload", async () => {
  const replies: string[] = [];
  const sent: string[] = [];
  await sendQueuedTelegramOutboundAttachments(createAttachmentTurn(), {
    maxAttachmentSizeBytes: 10,
    statPath: async () => ({ size: 11 }),
    sendMultipart: async () => {
      sent.push("sent");
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return undefined;
    },
  });
  assert.deepEqual(sent, []);
  assert.deepEqual(replies, [
    "Failed to send attachment a.png: Attachment exceeds size limit (11 bytes > 10 bytes)",
  ]);
});

test("Outbound attachment delivery reports per-file failures via text replies", async () => {
  const replies: string[] = [];
  const runtimeEvents: string[] = [];
  await sendQueuedTelegramOutboundAttachments(createAttachmentTurn(), {
    sendMultipart: async () => {
      throw new Error("upload failed");
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
      return undefined;
    },
    recordRuntimeEvent: (category, error, details) => {
      const message = error instanceof Error ? error.message : String(error);
      runtimeEvents.push(`${category}:${message}:${details?.fileName}`);
    },
  });
  assert.deepEqual(replies, ["Failed to send attachment a.png: upload failed"]);
  assert.deepEqual(runtimeEvents, ["attachment:upload failed:a.png"]);
});

test("Outbound attachment sender runtime binds delivery ports", async () => {
  const sent: string[] = [];
  const sendQueuedAttachments = createTelegramQueuedOutboundAttachmentSender({
    sendMultipart: async (method, _fields, fileField, _filePath, fileName) => {
      sent.push(`${method}:${fileField}:${fileName}`);
    },
    sendTextReply: async () => undefined,
    statPath: async () => ({ size: 1 }),
  });
  await sendQueuedAttachments(createAttachmentTurn());
  assert.deepEqual(sent, ["sendPhoto:photo:a.png"]);
});

test("Outbound attachment sender runtime applies the default outbound size limit", async () => {
  const replies: string[] = [];
  const sendQueuedAttachments = createTelegramQueuedOutboundAttachmentSender({
    sendMultipart: async () => {
      throw new Error("unexpected upload");
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      replies.push(text);
    },
    statPath: async () => ({
      size: TELEGRAM_OUTBOUND_ATTACHMENT_DEFAULT_MAX_BYTES + 1,
    }),
  });
  await sendQueuedAttachments(createAttachmentTurn());
  assert.deepEqual(replies, [
    `Failed to send attachment a.png: Attachment exceeds size limit (${TELEGRAM_OUTBOUND_ATTACHMENT_DEFAULT_MAX_BYTES + 1} bytes > ${TELEGRAM_OUTBOUND_ATTACHMENT_DEFAULT_MAX_BYTES} bytes)`,
  ]);
});
