/**
 * Regression tests for inbound Telegram handlers
 * Covers MIME/type matching, template substitution, fallback failures, and prompt-text routing
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildTelegramInboundHandlerInvocation,
  clearTelegramInboundHandlers,
  processTelegramInboundHandlers,
  registerTelegramInboundHandler,
  telegramInboundHandlerMatchesFile,
} from "../lib/inbound.ts";
import {
  clearTelegramVoiceTranscriptionProviders,
  registerTelegramVoiceTranscriptionProvider,
} from "../lib/voice.ts";

test.beforeEach(() => {
  clearTelegramInboundHandlers();
  clearTelegramVoiceTranscriptionProviders();
});

test("Inbound handlers match MIME wildcards and Telegram file types", () => {
  const voiceFile = {
    path: "/tmp/voice.ogg",
    fileName: "voice.ogg",
    mimeType: "audio/ogg",
    kind: "voice",
  };
  assert.equal(
    telegramInboundHandlerMatchesFile({ mime: "audio/*" }, voiceFile),
    true,
  );
  assert.equal(
    telegramInboundHandlerMatchesFile({ type: "voice" }, voiceFile),
    true,
  );
  assert.equal(
    telegramInboundHandlerMatchesFile({ match: "application/pdf" }, voiceFile),
    false,
  );
  assert.equal(telegramInboundHandlerMatchesFile({}, voiceFile), true);
});

test("Inbound template handlers substitute paths without shell interpolation", async () => {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const file = {
    path: "/tmp/voice one.ogg",
    fileName: "voice one.ogg",
    mimeType: "audio/ogg",
    kind: "voice",
  };
  const result = await processTelegramInboundHandlers({
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

test("Inbound template handlers apply declared defaults", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const file = {
    path: "/tmp/voice one.ogg",
    fileName: "voice one.ogg",
    mimeType: "audio/ogg",
    kind: "voice",
  };
  const result = await processTelegramInboundHandlers({
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

test("Inbound text handlers transform raw prompt text through stdin", async () => {
  const calls: Array<{ command: string; args: string[]; stdin?: string }> = [];
  const result = await processTelegramInboundHandlers({
    files: [],
    rawText: "привет",
    handlers: [
      {
        type: "text",
        template: "/tools/translate --to en --type {type} --mime {mime}",
      },
    ],
    cwd: "/work",
    execCommand: async (command, args, options) => {
      calls.push({ command, args, stdin: options?.stdin });
      return { stdout: "hello", stderr: "", code: 0, killed: false };
    },
  });
  assert.deepEqual(calls, [
    {
      command: "/tools/translate",
      args: ["--to", "en", "--type", "text", "--mime", "text/plain"],
      stdin: "привет",
    },
  ]);
  assert.equal(result.rawText, "hello");
  assert.deepEqual(result.promptFiles, []);
});

test("Inbound text handlers can match raw text by MIME only", async () => {
  const result = await processTelegramInboundHandlers({
    files: [],
    rawText: "bonjour",
    handlers: [
      {
        mime: "text/plain",
        template: "/tools/translate",
      },
    ],
    cwd: "/work",
    execCommand: async (_command, _args, options) => ({
      stdout: `translated:${options?.stdin ?? ""}`,
      stderr: "",
      code: 0,
      killed: false,
    }),
  });
  assert.equal(result.rawText, "translated:bonjour");
});

test("Inbound text handlers keep original text on empty or failed output", async () => {
  const events: string[] = [];
  const result = await processTelegramInboundHandlers({
    files: [],
    rawText: "original",
    handlers: [
      { type: "text", template: "/tools/empty" },
      { type: "text", template: "/tools/fail" },
    ],
    cwd: "/work",
    execCommand: async (command) => ({
      stdout: "",
      stderr: command,
      code: command.endsWith("fail") ? 1 : 0,
      killed: false,
    }),
    recordRuntimeEvent: (category) => {
      events.push(category);
    },
  });
  assert.equal(result.rawText, "original");
  assert.deepEqual(events, ["inbound-text-handler"]);
});

test("Built-in text attachment handling injects text files into outputs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-text-attachment-"));
  const filePath = join(dir, "note.txt");
  await writeFile(filePath, "hello from file\n", "utf8");
  const result = await processTelegramInboundHandlers({
    files: [
      {
        path: filePath,
        fileName: "note.txt",
        mimeType: "text/plain",
        kind: "document",
      },
    ],
    rawText: "see attached",
    handlers: [],
    cwd: "/work",
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
  });
  assert.deepEqual(result.handlerOutputs, ["[note.txt]\nhello from file"]);
});

test("Inbound handler output is bounded before entering prompts", async () => {
  const file = {
    path: "/tmp/huge.pdf",
    fileName: "huge.pdf",
    mimeType: "application/pdf",
    kind: "document",
  };
  const result = await processTelegramInboundHandlers({
    files: [file],
    rawText: "summarize",
    handlers: [{ mime: "application/pdf", template: "/tools/ocr {file}" }],
    cwd: "/work",
    execCommand: async () => ({
      stdout: "x".repeat(13_000),
      stderr: "",
      code: 0,
      killed: false,
    }),
  });

  assert.equal(result.handlerOutputs.length, 1);
  assert.equal(result.handlerOutputs[0]?.length, 12_024);
  assert.match(result.handlerOutputs[0] ?? "", /truncated 1000 chars/);
});

test("Inbound handler failure output is bounded before runtime events", async () => {
  const events: string[] = [];
  const result = await processTelegramInboundHandlers({
    files: [
      {
        path: "/tmp/huge.pdf",
        fileName: "huge.pdf",
        mimeType: "application/pdf",
        kind: "document",
      },
    ],
    rawText: "summarize",
    handlers: [{ mime: "application/pdf", template: "/tools/ocr {file}" }],
    cwd: "/work",
    execCommand: async () => ({
      stdout: "o".repeat(9_000),
      stderr: "e".repeat(8_000),
      code: 1,
      killed: false,
    }),
    recordRuntimeEvent: (category, error) => {
      events.push(
        `${category}:${error instanceof Error ? error.message : String(error)}`,
      );
    },
  });

  assert.deepEqual(result.handlerOutputs, []);
  assert.equal(events.length, 1);
  assert.match(events[0] ?? "", /stderr:\ne{4000}… \[truncated 4000 chars\]/);
  assert.match(events[0] ?? "", /stdout:\no{4000}… \[truncated 5000 chars\]/);
  assert.equal((events[0]?.match(/e/g) ?? []).length < 5000, true);
  assert.equal((events[0]?.match(/o/g) ?? []).length < 5000, true);
});

test("Built-in text attachment handling accepts text wildcards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-telegram-text-attachment-"));
  const filePath = join(dir, "note.md");
  await writeFile(filePath, "# Hello\n", "utf8");
  const result = await processTelegramInboundHandlers({
    files: [
      {
        path: filePath,
        fileName: "note.md",
        mimeType: "text/markdown",
        kind: "document",
      },
    ],
    rawText: "see attached",
    handlers: [],
    cwd: "/work",
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
  });
  assert.deepEqual(result.handlerOutputs, ["[note.md]\n# Hello"]);
});

test("Inbound template invocation keeps args as name declarations only", () => {
  const invocation = buildTelegramInboundHandlerInvocation(
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

test("Inbound template invocation supports inline placeholder defaults", () => {
  const invocation = buildTelegramInboundHandlerInvocation(
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

test("Inbound template handlers resolve relative commands", () => {
  const invocation = buildTelegramInboundHandlerInvocation(
    { template: "./scripts/transcribe {file} ru" },
    { path: "/tmp/a.ogg" },
    "/work",
  );
  assert.deepEqual(invocation, {
    command: "/work/scripts/transcribe",
    args: ["/tmp/a.ogg", "ru"],
  });
});

test("Inbound template handlers append the path when no placeholder is present", () => {
  const invocation = buildTelegramInboundHandlerInvocation(
    { template: "./scripts/transcribe --lang ru" },
    { path: "/tmp/a.ogg" },
    "/work",
  );
  assert.deepEqual(invocation, {
    command: "/work/scripts/transcribe",
    args: ["--lang", "ru", "/tmp/a.ogg"],
  });
});

test("Inbound template composition handlers execute steps in order", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const file = {
    path: "/tmp/voice one.ogg",
    fileName: "voice one.ogg",
    mimeType: "audio/ogg",
    kind: "voice",
  };
  const result = await processTelegramInboundHandlers({
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

test("Inbound template composition wraps timeout and pipes stdout to stdin", async () => {
  const calls: Array<{ command: string; stdin?: string; timeout?: number }> =
    [];
  const result = await processTelegramInboundHandlers({
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

test("Inbound handlers fall back to the next matching handler on failure", async () => {
  const calls: string[] = [];
  const events: Array<{ category: string; details?: Record<string, unknown> }> =
    [];
  const file = {
    path: "/tmp/voice.ogg",
    fileName: "voice.ogg",
    mimeType: "audio/ogg",
    kind: "voice",
  };
  const result = await processTelegramInboundHandlers({
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
      category: "inbound-handler",
      details: { fileName: "voice.ogg", handler: "template" },
    },
  ]);
});

test("Inbound handler failures fall back to normal inbound prompts", async () => {
  const events: Array<{ category: string; details?: Record<string, unknown> }> =
    [];
  const file = {
    path: "/tmp/report.pdf",
    fileName: "report.pdf",
    mimeType: "application/pdf",
    kind: "document",
  };
  const result = await processTelegramInboundHandlers({
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
      category: "inbound-handler",
      details: { fileName: "report.pdf", handler: "template" },
    },
  ]);
});

// --- Critical-step composition tests ---

test("Inbound handler composition: non-critical failure continues to next step", async () => {
  const calls: string[] = [];
  const result = await processTelegramInboundHandlers({
    files: [{ path: "/tmp/in.ogg", mimeType: "audio/ogg", kind: "voice" }],
    rawText: "",
    handlers: [
      {
        type: "voice",
        template: ["scan --file {file}", "transcribe --file {file}"],
      },
    ],
    cwd: "/work",
    execCommand: async (command) => {
      calls.push(command);
      if (command === "scan")
        return { stdout: "", stderr: "skip", code: 1, killed: false };
      return { stdout: "transcribed\n", stderr: "", code: 0, killed: false };
    },
  });
  assert.deepEqual(calls, ["scan", "transcribe"]);
  assert.deepEqual(result.handlerOutputs, ["transcribed"]);
});

test("Programmatic inbound text handlers transform text after configured text handlers", async () => {
  const dispose = registerTelegramInboundHandler(
    "text",
    async ({ text }) => `${text} world`,
  );
  try {
    const result = await processTelegramInboundHandlers({
      files: [],
      rawText: "hello",
      handlers: [
        {
          type: "text",
          template: "uppercase",
        },
      ],
      cwd: "/work",
      execCommand: async (_command, _args, options) => ({
        stdout: String(options?.stdin ?? "").toUpperCase(),
        stderr: "",
        code: 0,
        killed: false,
      }),
    });
    assert.equal(result.rawText, "HELLO world");
  } finally {
    dispose();
  }
});

test("Programmatic inbound media handlers run before voice transcription providers", async () => {
  const disposeInbound = registerTelegramInboundHandler(
    "voice",
    async ({ file }) => ({
      text: `programmatic transcript for ${file?.fileName}`,
    }),
  );
  const disposeProvider = registerTelegramVoiceTranscriptionProvider(
    async () => "provider transcript",
  );
  try {
    const result = await processTelegramInboundHandlers({
      files: [
        {
          path: "/tmp/programmatic.ogg",
          fileName: "programmatic.ogg",
          mimeType: "audio/ogg",
          kind: "voice",
        },
      ],
      rawText: "",
      handlers: [],
      cwd: "/work",
      execCommand: async () => ({
        stdout: "",
        stderr: "",
        code: 0,
        killed: false,
      }),
    });
    assert.deepEqual(result.handlerOutputs, [
      "programmatic transcript for programmatic.ogg",
    ]);
    assert.equal(result.handledFiles[0]?.handler.type, "programmatic");
  } finally {
    disposeInbound();
    disposeProvider();
  }
});

test("Inbound voice transcription providers handle voice files when no handler matches", async () => {
  const dispose = registerTelegramVoiceTranscriptionProvider(async (file) => ({
    text: `provider transcript for ${file.fileName}`,
  }));
  try {
    const result = await processTelegramInboundHandlers({
      files: [
        {
          path: "/tmp/provider.ogg",
          fileName: "provider.ogg",
          mimeType: "audio/ogg",
          kind: "voice",
        },
      ],
      rawText: "",
      handlers: [],
      cwd: "/work",
      execCommand: async () => ({
        stdout: "",
        stderr: "",
        code: 0,
        killed: false,
      }),
    });
    assert.deepEqual(result.handlerOutputs, [
      "provider transcript for provider.ogg",
    ]);
    assert.equal(result.handledFiles[0]?.handler.type, "voice-provider");
  } finally {
    dispose();
  }
});

test("Inbound handlers take precedence over voice transcription providers", async () => {
  const dispose = registerTelegramVoiceTranscriptionProvider(
    async () => "provider transcript",
  );
  try {
    const result = await processTelegramInboundHandlers({
      files: [{ path: "/tmp/in.ogg", mimeType: "audio/ogg", kind: "voice" }],
      rawText: "",
      handlers: [{ type: "voice", template: "transcribe --file {file}" }],
      cwd: "/work",
      execCommand: async () => ({
        stdout: "handler transcript\n",
        stderr: "",
        code: 0,
        killed: false,
      }),
    });
    assert.deepEqual(result.handlerOutputs, ["handler transcript"]);
  } finally {
    dispose();
  }
});

test("Inbound handler composition: critical failure aborts composition", async () => {
  const calls: string[] = [];
  const result = await processTelegramInboundHandlers({
    files: [{ path: "/tmp/in.ogg", mimeType: "audio/ogg", kind: "voice" }],
    rawText: "",
    handlers: [
      {
        type: "voice",
        template: [
          { template: "scan --file {file}", failure: "root" },
          "transcribe --file {file}",
          "summarize --file {file}",
        ],
      },
    ],
    cwd: "/work",
    execCommand: async (command) => {
      calls.push(command);
      if (command === "scan")
        return { stdout: "", stderr: "fatal", code: 1, killed: false };
      return { stdout: "ok\n", stderr: "", code: 0, killed: false };
    },
  });
  assert.deepEqual(calls, ["scan"]);
  assert.deepEqual(result.handlerOutputs, []);
});

test("Inbound handler composition: non-critical failure continues, critical stops", async () => {
  const calls: string[] = [];
  const result = await processTelegramInboundHandlers({
    files: [{ path: "/tmp/in.ogg", mimeType: "audio/ogg", kind: "voice" }],
    rawText: "",
    handlers: [
      {
        type: "voice",
        template: ["step-a", { template: "step-b", failure: "root" }, "step-c"],
      },
    ],
    cwd: "/work",
    execCommand: async (command) => {
      calls.push(command);
      if (command === "step-a")
        return { stdout: "a\n", stderr: "", code: 0, killed: false };
      if (command === "step-b")
        return { stdout: "", stderr: "boom", code: 1, killed: false };
      return { stdout: "c\n", stderr: "", code: 0, killed: false };
    },
  });
  assert.deepEqual(calls, ["step-a", "step-b"]);
  assert.deepEqual(result.handlerOutputs, []);
});
