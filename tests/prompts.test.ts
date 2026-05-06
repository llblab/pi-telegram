/**
 * Regression tests for Telegram prompt injection helpers
 * Covers system prompt suffix construction and before-agent-start hook binding
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramBridgeSystemPrompt,
  createTelegramBeforeAgentStartHook,
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
  assert.match(defaultSystemPrompt, /`\[reply\]` is quoted context/);
  assert.match(defaultSystemPrompt, /not a new instruction by itself/);
  assert.match(
    defaultSystemPrompt,
    /`\[outputs\]` contains inbound-handler stdout/,
  );
  assert.match(defaultSystemPrompt, /telegram_attach/);
  assert.match(defaultSystemPrompt, /telegram_voice text="Short summary"/);
  assert.match(defaultSystemPrompt, /telegram_button: OK/);
  assert.match(defaultSystemPrompt, /telegram_button label=Continue prompt=/);
  assert.match(
    defaultSystemPrompt,
    /do not call or register transport\/TTS\/text-to-OGG tools/,
  );
  assert.match(defaultSystemPrompt, /no specific summary format is required/);
});
