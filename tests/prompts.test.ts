/**
 * Tests for Telegram prompt injection helpers
 * Covers system prompt suffix construction, Google Translate bypass integration,
 * language detection, debug logging, and log prune mechanism
 */

import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildTelegramBridgeSystemPrompt,
  createTelegramBeforeAgentStartHook,
  createTelegramAfterAgentEndHook,
  logTelegramBridgePrompt,
  MAX_LOG_ENTRIES,
  pruneTelegramBridgeLogs,
} from "../lib/prompts.ts";

type BeforeAgentStartHookEvent = Parameters<
  ReturnType<typeof createTelegramBeforeAgentStartHook>
>[0];

function createBeforeAgentStartEvent(
  prompt: string,
  systemPrompt: string,
): BeforeAgentStartHookEvent {
  return { prompt, systemPrompt } as BeforeAgentStartHookEvent;
}

const LOG_FILE = join(homedir(), ".pi", "agent", "logs", "telegram-bridge.log");

// ---------------------------------------------------------------------------
// Existing regression tests (must still pass)
// ---------------------------------------------------------------------------

test("buildTelegramBridgeSystemPrompt appends suffix and Telegram marker", () => {
  assert.deepEqual(
    buildTelegramBridgeSystemPrompt({
      prompt: " [telegram] hello",
      systemPrompt: "base",
      telegramPrefix: "[telegram]",
      systemPromptSuffix: "\nbridge active",
    }),
    {
      systemPrompt:
        "base\nbridge active\n- The current user message came from Telegram.",
    },
  );
  assert.deepEqual(
    buildTelegramBridgeSystemPrompt({
      prompt: "local hello",
      systemPrompt: "base",
      telegramPrefix: "[telegram]",
      systemPromptSuffix: "\nbridge active",
    }),
    { systemPrompt: "base\nbridge active" },
  );
});

// ---------------------------------------------------------------------------
// Hook behavior: sync path (English/ASCII)
// ---------------------------------------------------------------------------

test("createTelegramBeforeAgentStartHook sync path for English Telegram messages", async () => {
  const hook = createTelegramBeforeAgentStartHook({
    telegramPrefix: "[telegram]",
    systemPromptSuffix: "\nbase suffix",
  });
  const result = await hook(
    createBeforeAgentStartEvent(" [telegram] Hello world", "base"),
  );
  assert.ok(
    result.systemPrompt.includes("base suffix"),
    "Should include base suffix",
  );
  assert.ok(
    result.systemPrompt.includes("The current user message came from Telegram"),
    "Should include Telegram marker",
  );
  assert.ok(
    !result.systemPrompt.includes("Language Detection"),
    "Should NOT include language detection for English",
  );
});

test("createTelegramBeforeAgentStartHook sync path for non-Telegram messages", () => {
  const hook = createTelegramBeforeAgentStartHook({
    telegramPrefix: "[telegram]",
    systemPromptSuffix: "\nbase suffix",
  });
  const result = hook(
    createBeforeAgentStartEvent("local command", "base"),
  );
  assert.equal(result.systemPrompt, "base\nbase suffix");
  assert.ok(
    !result.systemPrompt.includes("The current user message came from Telegram"),
    "Should NOT include Telegram marker for local messages",
  );
});

// ---------------------------------------------------------------------------
// Hook behavior: async path (non-English)
// ---------------------------------------------------------------------------

test("createTelegramBeforeAgentStartHook async path for non-English Telegram messages", async () => {
  const hook = createTelegramBeforeAgentStartHook({
    telegramPrefix: "[telegram]",
  });
  const result = await hook(
    createBeforeAgentStartEvent(" [telegram] Xin chào bạn", "base"),
  );
  assert.ok(
    result.systemPrompt.includes("Language Detection"),
    "Should include language detection section",
  );
  assert.ok(
    result.systemPrompt.includes("Vietnamese"),
    "Should detect Vietnamese",
  );
  assert.ok(
    result.systemPrompt.includes("English Translation"),
    "Should include English translation",
  );
  assert.ok(
    result.systemPrompt.includes("Respond in Vietnamese"),
    "Should instruct LLM to respond in Vietnamese",
  );
  assert.ok(
    result.systemPrompt.includes("The current user message came from Telegram"),
    "Should include Telegram marker",
  );
});

test("createTelegramBeforeAgentStartHook handles Arabic messages correctly", async () => {
  const hook = createTelegramBeforeAgentStartHook({
    telegramPrefix: "[telegram]",
  });
  const result = await hook(
    createBeforeAgentStartEvent(" [telegram] \u0645\u0631\u062d\u0628\u0627", "base"),
  );
  assert.ok(
    result.systemPrompt.includes("Language Detection"),
    "Should include language detection section",
  );
  assert.ok(
    result.systemPrompt.includes("Arabic") || result.systemPrompt.includes("ar"),
    "Should detect Arabic",
  );
  assert.ok(
    result.systemPrompt.includes("Respond in Arabic"),
    "Should instruct LLM to respond in Arabic",
  );
});

// ---------------------------------------------------------------------------
// afterAgentEnd hook
// ---------------------------------------------------------------------------

test("createTelegramAfterAgentEndHook returns response unchanged for English", async () => {
  const hook = createTelegramAfterAgentEndHook();
  const result = await hook("Hello there", "en");
  assert.equal(result, "Hello there");
});

test("createTelegramAfterAgentEndHook returns response unchanged for auto", async () => {
  const hook = createTelegramAfterAgentEndHook();
  const result = await hook("Hello there", "auto");
  assert.equal(result, "Hello there");
});

// ---------------------------------------------------------------------------
// Debug logging tests
// ---------------------------------------------------------------------------

test("logTelegramBridgePrompt writes JSON entries to log file", () => {
  const testEntry = {
    timestamp: "2026-01-01T00:00:00.000Z",
    originalPrompt: " [telegram] Xin chào",
    systemPromptSuffix: "\ntest suffix",
  };
  logTelegramBridgePrompt(testEntry);
  assert.ok(
    existsSync(LOG_FILE),
    "Log file should exist after writing",
  );
  const content = readFileSync(LOG_FILE, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const lastLine = JSON.parse(lines[lines.length - 1]);
  assert.equal(lastLine.ts, testEntry.timestamp, "Timestamp should match");
  assert.ok(
    lastLine.prompt.includes("Xin chào"),
    "Prompt should be logged",
  );
  assert.ok(lastLine.suffix, "Suffix should be logged");
});

test("pruneTelegramBridgeLogs keeps at most MAX_LOG_ENTRIES entries", () => {
  const overflow = MAX_LOG_ENTRIES + 50;
  for (let i = 0; i < overflow; i++) {
    appendFileSync(
      LOG_FILE,
      JSON.stringify({
        ts: new Date().toISOString(),
        prompt: `entry-${i}`,
        suffix: "",
      }) + "\n",
      "utf-8",
    );
  }
  const beforeContent = readFileSync(LOG_FILE, "utf-8");
  const beforeLines = beforeContent.trim().split("\n").filter(Boolean);
  assert.ok(
    beforeLines.length > MAX_LOG_ENTRIES,
    `Should have >${MAX_LOG_ENTRIES} lines before prune`,
  );
  pruneTelegramBridgeLogs();
  const afterContent = readFileSync(LOG_FILE, "utf-8");
  const afterLines = afterContent.trim().split("\n").filter(Boolean);
  assert.ok(
    afterLines.length <= MAX_LOG_ENTRIES,
    `After pruning, should have <=${MAX_LOG_ENTRIES} lines, got ${afterLines.length}`,
  );
  const lastParsed = JSON.parse(afterLines[afterLines.length - 1]);
  assert.match(
    lastParsed.prompt,
    /entry-/,
    "Last entry should be from the overflow batch",
  );
});

test("pruneTelegramBridgeLogs handles missing log file gracefully", () => {
  pruneTelegramBridgeLogs();
  assert.ok(true, "Should not throw when log file is missing");
});
