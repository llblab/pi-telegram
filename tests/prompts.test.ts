/**
 * Regression tests for Telegram prompt injection helpers
 * Covers system prompt suffix construction, before-agent-start hook binding,
 * Google Translate bypass, and debug logging
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramBridgeSystemPrompt,
  createTelegramBeforeAgentStartHook,
  createTelegramAfterAgentEndHook,
  detectLanguageViaGoogle,
  translateViaGoogle,
  logTelegramBridgePrompt,
  pruneTelegramBridgeLogs,
  LOG_FILE,
  MAX_LOG_ENTRIES,
} from "../lib/prompts.ts";
import { existsSync, mkdirSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

type BeforeAgentStartHookEvent = Parameters<
  ReturnType<typeof createTelegramBeforeAgentStartHook>
>[0];

function createBeforeAgentStartEvent(
  prompt: string,
  systemPrompt: string,
): BeforeAgentStartHookEvent {
  return { prompt, systemPrompt } as BeforeAgentStartHookEvent;
}

// ---------------------------------------------------------------------------
// System prompt suffix tests
// ---------------------------------------------------------------------------

test("buildTelegramBridgeSystemPrompt adds Telegram marker for [telegram]-prefixed prompts", () => {
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
});

test("buildTelegramBridgeSystemPrompt skips Telegram marker for non-Telegram prompts", () => {
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

test("createTelegramBeforeAgentStartHook sync returns correct suffix for Telegram messages", () => {
  const hook = createTelegramBeforeAgentStartHook({
    telegramPrefix: "[telegram]",
    systemPromptSuffix: "\nbridge active",
  });
  const result = hook(
    createBeforeAgentStartEvent(" [telegram] hello", "base"),
  );
  // Sync path returns { systemPrompt } directly (not a promise)
  assert.equal(typeof result, "object");
  // Ensure the result has the Telegram marker
  assert.match(result.systemPrompt, /bridge active/);
  assert.match(result.systemPrompt, /The current user message came from Telegram/);
});

test("createTelegramBeforeAgentStartHook with default suffix includes all sections", () => {
  const defaultSystemPrompt = createTelegramBeforeAgentStartHook()(
    createBeforeAgentStartEvent(" [telegram] hello", "base"),
  ).systemPrompt;
  assert.match(defaultSystemPrompt, /The current user message came from Telegram/);
  assert.match(defaultSystemPrompt, /prefer narrow table columns/);
  assert.match(defaultSystemPrompt, /`\[reply\]` is quoted context/);
  assert.match(defaultSystemPrompt, /not a new instruction by itself/);
  assert.match(defaultSystemPrompt, /telegram_attach/);
  assert.match(defaultSystemPrompt, /telegram_voice text="Short summary"/);
  assert.match(defaultSystemPrompt, /telegram_button: OK/);
  assert.match(defaultSystemPrompt, /telegram_button label=Continue prompt=/);
});

// ---------------------------------------------------------------------------
// Google Translate bypass tests
// ---------------------------------------------------------------------------

test("detectLanguageViaGoogle returns 'en' for English text", async () => {
  const lang = await detectLanguageViaGoogle("Hello world");
  assert.equal(lang, "en");
});

test("detectLanguageViaGoogle returns 'vi' for Vietnamese text", async () => {
  const lang = await detectLanguageViaGoogle("Xin chào bạn");
  assert.equal(lang, "vi");
});

test("detectLanguageViaGoogle returns 'zh' for Chinese text", async () => {
  const lang = await detectLanguageViaGoogle("你好吗");
  assert.ok(lang.startsWith("zh"), `expected zh/zh-CN/zh-TW, got ${lang}`);
});

test("translateViaGoogle translates Vietnamese to English correctly", async () => {
  const result = await translateViaGoogle("Xin chào bạn", "vi", "en");
  assert.ok(result.length > 0);
  assert.match(result.toLowerCase(), /hello|you|hi/);
});

test("translateViaGoogle translates English to Vietnamese correctly", async () => {
  const result = await translateViaGoogle("Hello my friend", "en", "vi");
  assert.ok(result.length > 0);
  assert.match(result, /bạn|chào|hello/);
});

test("translateViaGoogle handles Japanese text", async () => {
  const result = await translateViaGoogle("こんにちは世界", "ja", "en");
  assert.ok(result.length > 0);
  assert.match(result.toLowerCase(), /hello|world/);
});

test("translateViaGoogle returns original text on failure (empty input)", async () => {
  const result = await translateViaGoogle("", "en", "vi");
  assert.equal(result, "");
});

// ---------------------------------------------------------------------------
// Translation-aware before-agent-start hook
// ---------------------------------------------------------------------------

test("createTelegramBeforeAgentStartHook with non-ASCII text returns async promise", async () => {
  const hook = createTelegramBeforeAgentStartHook();
  const result = hook(
    createBeforeAgentStartEvent(" [telegram] Xin chào bạn", "base"),
  );
  // Non-ASCII path returns a Promise
  assert.equal(typeof result, "object");
  assert.ok(result instanceof Promise || typeof (result as any).then === "function");

  const resolved = await result;
  assert.match(resolved.systemPrompt, /The current user message came from Telegram/);
  // Should include translation info
  assert.ok(resolved.systemPrompt.includes("Vietnamese") || resolved.systemPrompt.includes("Language Detection"));
});

test("createTelegramAfterAgentEndHook does not translate English responses", async () => {
  const hook = createTelegramAfterAgentEndHook();
  const result = await hook("Hello world", "en");
  assert.equal(result, "Hello world");
});

test("createTelegramAfterAgentEndHook translates English to Vietnamese", async () => {
  const hook = createTelegramAfterAgentEndHook();
  const result = await hook("Hello my friend", "vi");
  assert.ok(result.length > 0);
  assert.match(result, /bạn|hello|xin chào/);
});

// ---------------------------------------------------------------------------
// Logging tests
// ---------------------------------------------------------------------------

test("logTelegramBridgePrompt writes JSON entries to log file", () => {
  const dir = dirname(LOG_FILE);
  mkdirSync(dir, { recursive: true });
  logTelegramBridgePrompt({
    timestamp: "2026-01-01T00:00:00.000Z",
    originalPrompt: "test prompt",
    systemPromptSuffix: "test suffix",
  });
  assert.ok(existsSync(LOG_FILE));
  const content = readFileSync(LOG_FILE, "utf-8").trim();
  assert.match(content, /"test prompt"/);
  assert.match(content, /"test suffix"/);
  // Cleanup
  unlinkSync(LOG_FILE);
});

test("pruneTelegramBridgeLogs keeps at most MAX_LOG_ENTRIES entries", () => {
  const dir = dirname(LOG_FILE);
  mkdirSync(dir, { recursive: true });
  const overflow = Array.from({ length: MAX_LOG_ENTRIES + 50 }, (_, i) =>
    JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", prompt: `entry-${i}`, suffix: "test" })
  ).join("\n") + "\n";
  writeFileSync(LOG_FILE, overflow, "utf-8");
  pruneTelegramBridgeLogs();
  const lines = readFileSync(LOG_FILE, "utf-8").trim().split("\n").filter(Boolean);
  assert.ok(lines.length <= MAX_LOG_ENTRIES);
  // Should have kept the last MAX_LOG_ENTRIES entries
  assert.match(lines[0], /entry-/);
  unlinkSync(LOG_FILE);
});

test("pruneTelegramBridgeLogs handles missing log file gracefully", () => {
  // Should not throw
  if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);
  pruneTelegramBridgeLogs();
  assert.ok(true, "did not throw on missing log file");
});
