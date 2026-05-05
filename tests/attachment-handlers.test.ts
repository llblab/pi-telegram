/**
 * Regression tests for inbound Telegram attachment handlers
 * Covers MIME/type matching, template substitution, fallback failures, and prompt-text routing
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramAttachmentHandlerInvocation,
  processTelegramAttachmentHandlers,
  telegramAttachmentHandlerMatchesFile,
} from "../lib/attachment-handlers.ts";

test("Attachment handlers match MIME wildcards and Telegram file types", () => {
  const voiceFile = {
    path: "/tmp/voice.ogg",
    fileName: "voice.ogg",
    mimeType: "audio/ogg",
    kind: "voice",
  };
  assert.equal(
    telegramAttachmentHandlerMatchesFile({ mime: "audio/*" }, voiceFile),
    true,
  );
  assert.equal(
    telegramAttachmentHandlerMatchesFile({ type: "voice" }, voiceFile),
    true,
  );
  assert.equal(
    telegramAttachmentHandlerMatchesFile(
      { match: "application/pdf" },
      voiceFile,
    ),
    false,
  );
  assert.equal(telegramAttachmentHandlerMatchesFile({}, voiceFile), true);
});

test("Attachment template handlers substitute paths without shell interpolation", async () => {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const file = {
    path: "/tmp/voice one.ogg",
    fileName: "voice one.ogg",
    mimeType: "audio/ogg",
    kind: "voice",
  };
  const result = await processTelegramAttachmentHandlers({
    files: [file],
    rawText: "please summarize",
    handlers: [
      {
        mime: "audio/*",
        template: "/opt/transcribe --file={file} --mime {mime} --type {type}",
      },
    ],
    cwd: "/work",
    execCommand: async (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd });
      return {
        stdout: "hello from voice\n",
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });
  assert.deepEqual(calls, [
    {
      command: "/opt/transcribe",
      args: [
        "--file=/tmp/voice one.ogg",
        "--mime",
        "audio/ogg",
        "--type",
        "voice",
      ],
      cwd: "/work",
    },
  ]);
  assert.deepEqual(result.promptFiles, [file]);
  assert.equal(result.rawText, "please summarize");
  assert.deepEqual(result.handlerOutputs, ["hello from voice"]);
});

test("Attachment template handlers apply declared defaults", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const file = {
    path: "/tmp/voice one.ogg",
    fileName: "voice one.ogg",
    mimeType: "audio/ogg",
    kind: "voice",
  };
  const result = await processTelegramAttachmentHandlers({
    files: [file],
    rawText: "",
    handlers: [
      {
        type: "voice",
        template: "/opt/transcribe {file} {lang} {model}",
        args: ["file", "lang", "model"],
        defaults: { lang: "ru", model: "voxtral-mini-latest" },
      },
    ],
    cwd: "/work",
    execCommand: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "voice transcript", stderr: "", code: 0, killed: false };
    },
  });
  assert.deepEqual(calls, [
    {
      command: "/opt/transcribe",
      args: ["/tmp/voice one.ogg", "ru", "voxtral-mini-latest"],
    },
  ]);
  assert.deepEqual(result.handlerOutputs, ["voice transcript"]);
});

test("Attachment template invocation keeps args as name declarations only", () => {
  const invocation = buildTelegramAttachmentHandlerInvocation(
    {
      template: "./scripts/transcribe {file} {lang=ru}",
      args: ["file", "lang"],
    },
    { path: "/tmp/a.ogg" },
    "/work",
  );
  assert.deepEqual(invocation, {
    command: "/work/scripts/transcribe",
    args: ["/tmp/a.ogg", "ru"],
  });
});

test("Attachment template invocation supports inline placeholder defaults", () => {
  const invocation = buildTelegramAttachmentHandlerInvocation(
    {
      template:
        "./scripts/transcribe {file} {lang=ru} {model=voxtral-mini-latest}",
    },
    { path: "/tmp/a.ogg" },
    "/work",
  );
  assert.deepEqual(invocation, {
    command: "/work/scripts/transcribe",
    args: ["/tmp/a.ogg", "ru", "voxtral-mini-latest"],
  });
});

test("Attachment template handlers resolve relative commands", () => {
  const invocation = buildTelegramAttachmentHandlerInvocation(
    { template: "./scripts/transcribe {file} ru" },
    { path: "/tmp/a.ogg" },
    "/work",
  );
  assert.deepEqual(invocation, {
    command: "/work/scripts/transcribe",
    args: ["/tmp/a.ogg", "ru"],
  });
});

test("Attachment template handlers append the path when no placeholder is present", () => {
  const invocation = buildTelegramAttachmentHandlerInvocation(
    { template: "./scripts/transcribe --lang ru" },
    { path: "/tmp/a.ogg" },
    "/work",
  );
  assert.deepEqual(invocation, {
    command: "/work/scripts/transcribe",
    args: ["--lang", "ru", "/tmp/a.ogg"],
  });
});

test("Attachment template composition handlers execute steps in order", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const file = {
    path: "/tmp/voice one.ogg",
    fileName: "voice one.ogg",
    mimeType: "audio/ogg",
    kind: "voice",
  };
  const result = await processTelegramAttachmentHandlers({
    files: [file],
    rawText: "",
    handlers: [
      {
        type: "voice",
        template: [
          "/tools/extract {file} --out /tmp/raw.wav",
          "/tools/transcribe /tmp/raw.wav {lang}",
        ],
        defaults: { lang: "ru" },
      },
    ],
    cwd: "/work",
    execCommand: async (command, args) => {
      calls.push({ command, args });
      return {
        stdout: command.endsWith("transcribe") ? "pipe transcript" : "",
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });
  assert.deepEqual(calls, [
    {
      command: "/tools/extract",
      args: ["/tmp/voice one.ogg", "--out", "/tmp/raw.wav"],
    },
    { command: "/tools/transcribe", args: ["/tmp/raw.wav", "ru"] },
  ]);
  assert.deepEqual(result.handlerOutputs, ["pipe transcript"]);
});

test("Attachment template composition wraps timeout and pipes stdout to stdin", async () => {
  const calls: Array<{ command: string; stdin?: string; timeout?: number }> = [];
  const result = await processTelegramAttachmentHandlers({
    files: [{ path: "/tmp/voice.ogg", mimeType: "audio/ogg", kind: "voice" }],
    rawText: "",
    handlers: [
      {
        type: "voice",
        template: [
          "/tools/extract {file}",
          { template: "/tools/transcribe", timeout: 222 },
        ],
        timeout: 111000,
      },
    ],
    cwd: "/work",
    execCommand: async (command, _args, options) => {
      calls.push({
        command,
        stdin: options?.stdin,
        timeout: options?.timeout,
      });
      return {
        stdout:
          command === "/tools/extract"
            ? "raw transcript\n"
            : `seen:${options?.stdin ?? ""}`,
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });
  assert.deepEqual(calls, [
    { command: "/tools/extract", stdin: undefined, timeout: 111000 },
    { command: "/tools/transcribe", stdin: "raw transcript\n", timeout: 222 },
  ]);
  assert.deepEqual(result.handlerOutputs, ["seen:raw transcript"]);
});

test("Attachment handlers fall back to the next matching handler on failure", async () => {
  const calls: string[] = [];
  const events: Array<{ category: string; details?: Record<string, unknown> }> =
    [];
  const file = {
    path: "/tmp/voice.ogg",
    fileName: "voice.ogg",
    mimeType: "audio/ogg",
    kind: "voice",
  };
  const result = await processTelegramAttachmentHandlers({
    files: [file],
    rawText: "",
    handlers: [
      { type: "voice", template: "/tools/primary {file} ru" },
      { mime: "audio/*", template: "/tools/fallback {file} ru" },
    ],
    cwd: "/work",
    execCommand: async (command) => {
      calls.push(command);
      if (command === "/tools/primary") {
        return { stdout: "", stderr: "primary down", code: 1, killed: false };
      }
      return {
        stdout: "fallback transcript",
        stderr: "",
        code: 0,
        killed: false,
      };
    },
    recordRuntimeEvent: (category, _error, details) => {
      events.push({ category, details });
    },
  });
  assert.deepEqual(calls, ["/tools/primary", "/tools/fallback"]);
  assert.deepEqual(result.handlerOutputs, ["fallback transcript"]);
  assert.deepEqual(events, [
    {
      category: "attachment-handler",
      details: { fileName: "voice.ogg", handler: "template" },
    },
  ]);
});

test("Attachment handler failures fall back to normal attachment prompts", async () => {
  const events: Array<{ category: string; details?: Record<string, unknown> }> =
    [];
  const file = {
    path: "/tmp/report.pdf",
    fileName: "report.pdf",
    mimeType: "application/pdf",
    kind: "document",
  };
  const result = await processTelegramAttachmentHandlers({
    files: [file],
    rawText: "read this",
    handlers: [
      { mime: "application/pdf", template: "/opt/pdf-to-text {file}" },
    ],
    cwd: "/work",
    execCommand: async () => ({
      stdout: "partial",
      stderr: "boom",
      code: 1,
      killed: false,
    }),
    recordRuntimeEvent: (category, _error, details) => {
      events.push({ category, details });
    },
  });
  assert.equal(result.rawText, "read this");
  assert.deepEqual(result.handlerOutputs, []);
  assert.deepEqual(result.promptFiles, [file]);
  assert.deepEqual(events, [
    {
      category: "attachment-handler",
      details: { fileName: "report.pdf", handler: "template" },
    },
  ]);
});

// --- Critical-step composition tests ---

test("Attachment handler composition: non-critical failure continues to next step", async () => {
  const calls: string[] = [];
  const result = await processTelegramAttachmentHandlers({
    files: [{ path: "/tmp/in.ogg", mimeType: "audio/ogg", kind: "voice" }],
    rawText: "",
    handlers: [{
      type: "voice",
      template: [
        "scan --file {file}",
        "transcribe --file {file}",
      ],
    }],
    cwd: "/work",
    execCommand: async (command) => {
      calls.push(command);
      if (command === "scan") return { stdout: "", stderr: "skip", code: 1, killed: false };
      return { stdout: "transcribed\n", stderr: "", code: 0, killed: false };
    },
  });
  assert.deepEqual(calls, ["scan", "transcribe"]);
  assert.deepEqual(result.handlerOutputs, ["transcribed"]);
});

test("Attachment handler composition: critical failure aborts composition", async () => {
  const calls: string[] = [];
  const result = await processTelegramAttachmentHandlers({
    files: [{ path: "/tmp/in.ogg", mimeType: "audio/ogg", kind: "voice" }],
    rawText: "",
    handlers: [{
      type: "voice",
      template: [
        { template: "scan --file {file}", critical: true },
        "transcribe --file {file}",
        "summarize --file {file}",
      ],
    }],
    cwd: "/work",
    execCommand: async (command) => {
      calls.push(command);
      if (command === "scan") return { stdout: "", stderr: "fatal", code: 1, killed: false };
      return { stdout: "ok\n", stderr: "", code: 0, killed: false };
    },
  });
  assert.deepEqual(calls, ["scan"]);
  assert.deepEqual(result.handlerOutputs, []);
});

test("Attachment handler composition: non-critical failure continues, critical stops", async () => {
  const calls: string[] = [];
  const result = await processTelegramAttachmentHandlers({
    files: [{ path: "/tmp/in.ogg", mimeType: "audio/ogg", kind: "voice" }],
    rawText: "",
    handlers: [{
      type: "voice",
      template: [
        "step-a",
        { template: "step-b", critical: true },
        "step-c",
      ],
    }],
    cwd: "/work",
    execCommand: async (command) => {
      calls.push(command);
      if (command === "step-a") return { stdout: "a\n", stderr: "", code: 0, killed: false };
      if (command === "step-b") return { stdout: "", stderr: "boom", code: 1, killed: false };
      return { stdout: "c\n", stderr: "", code: 0, killed: false };
    },
  });
  assert.deepEqual(calls, ["step-a", "step-b"]);
  assert.deepEqual(result.handlerOutputs, []);
});
