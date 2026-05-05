/**
 * Tests for Telegram prompt injection helpers
 * Covers system prompt suffix construction, translation injection,
 * debug logging, and log prune mechanism
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

test("Prompt helpers append Telegram-aware system prompt suffixes", () => {
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

test("Prompt helpers build before-agent-start hooks", () => {
  const hook = createTelegramBeforeAgentStartHook({
    telegramPrefix: "[telegram]",
    systemPromptSuffix: "\nbridge active",
  });
  assert.deepEqual(
    hook(createBeforeAgentStartEvent(" [telegram] hello", "base")),
    {
      systemPrompt:
        "base\nbridge active\n- The current user message came from Telegram.",
    },
  );
  const defaultSystemPrompt = createTelegramBeforeAgentStartHook()(
    createBeforeAgentStartEvent(" [telegram] hello", "base"),
  ).systemPrompt;
  assert.match(
    defaultSystemPrompt,
    /The current user message came from Telegram/,
  );
  assert.match(defaultSystemPrompt, /prefer narrow table columns/);
  assert.match(defaultSystemPrompt, /telegram_attach/);
});

// ---------------------------------------------------------------------------
// Translation prompt injection tests
// ---------------------------------------------------------------------------

test("SYSTEM_PROMPT_SUFFIX contains TRANSLATION instructions", () => {
  const hook = createTelegramBeforeAgentStartHook();
  const vnResult = hook(
    createBeforeAgentStartEvent(" [telegram] Xin chào", "base"),
  );
  assert.match(
    vnResult.systemPrompt,
    /TRANSLATION/i,
    "Should contain TRANSLATION heading",
  );
  assert.match(
    vnResult.systemPrompt,
    /auto-detect|not in English/i,
    "Should mention auto-detection for any language",
  );
  assert.match(
    vnResult.systemPrompt,
    /translate.*back|dịch ngược/i,
    "Should mention translating back to original language",
  );
});

test("Telegram messages get TRANSLATION suffix", () => {
  const result = buildTelegramBridgeSystemPrompt({
    prompt: " [telegram] Xin chào bạn",
    systemPrompt: "base",
    telegramPrefix: "[telegram]",
    systemPromptSuffix: "\n**TRANSLATION**: test instruction",
  });
  assert.ok(
    result.systemPrompt.includes("TRANSLATION"),
    "Translation instructions should be in the suffix for Telegram messages",
  );
  assert.ok(
    result.systemPrompt.includes(
      "The current user message came from Telegram",
    ),
    "Telegram context line should be appended",
  );
});

test("Non-Telegram prompts do NOT get Telegram suffix line", () => {
  const result = buildTelegramBridgeSystemPrompt({
    prompt: "local command",
    systemPrompt: "base",
    telegramPrefix: "[telegram]",
    systemPromptSuffix: "\n**TRANSLATION**: test instruction",
  });
  assert.ok(
    !result.systemPrompt.includes(
      "The current user message came from Telegram",
    ),
    "Telegram context line should NOT be appended for local prompts",
  );
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
  // Append more than MAX_LOG_ENTRIES lines
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
  // Count before pruning
  const beforeContent = readFileSync(LOG_FILE, "utf-8");
  const beforeLines = beforeContent.trim().split("\n").filter(Boolean);
  assert.ok(
    beforeLines.length > MAX_LOG_ENTRIES,
    `Should have >${MAX_LOG_ENTRIES} lines before prune`,
  );
  // Prune
  pruneTelegramBridgeLogs();
  // Count after pruning
  const afterContent = readFileSync(LOG_FILE, "utf-8");
  const afterLines = afterContent.trim().split("\n").filter(Boolean);
  assert.ok(
    afterLines.length <= MAX_LOG_ENTRIES,
    `After pruning, should have <=${MAX_LOG_ENTRIES} lines, got ${afterLines.length}`,
  );
  // Verify latest entries are preserved
  const lastParsed = JSON.parse(afterLines[afterLines.length - 1]);
  assert.match(
    lastParsed.prompt,
    /entry-/,
    "Last entry should be from the overflow batch",
  );
});

test("pruneTelegramBridgeLogs handles missing log file gracefully", () => {
  // Should not throw when LOG_FILE doesn't exist
  pruneTelegramBridgeLogs();
  assert.ok(true, "Should not throw when log file is missing");
});

// ---------------------------------------------------------------------------
// Hook integration test
// ---------------------------------------------------------------------------

test("createTelegramBeforeAgentStartHook produces suffix with translation instructions", () => {
  const hook = createTelegramBeforeAgentStartHook();
  const result = hook(
    createBeforeAgentStartEvent(" [telegram] Xin chào bạn", "base"),
  ).systemPrompt;
  assert.match(
    result,
    /TRANSLATION/i,
    "Should include translation instructions",
  );
  assert.match(
    result,
    /The current user message came from Telegram/,
    "Should include Telegram marker",
  );
  assert.match(result, /telegram_attach/, "Should include telegram_attach guidance");
});
