/**
 * Regression tests for Telegram prompt injection helpers
 * Covers system prompt suffix construction and before-agent-start hook binding
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramBridgeSystemPrompt,
  createTelegramBeforeAgentStartHook,
  createTelegramProactiveBeforeAgentStartHook,
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
  assert.match(defaultSystemPrompt, /37 visible cells/);
  assert.match(defaultSystemPrompt, /`\[reply\]` is quoted context/);
  assert.match(defaultSystemPrompt, /not a new instruction by itself/);
  assert.match(
    defaultSystemPrompt,
    /`\[outputs\]` contains inbound-handler stdout/,
  );
  assert.match(defaultSystemPrompt, /`\[time\]` gives the wall-clock time/);
  assert.match(defaultSystemPrompt, /relative-date requests/);
  assert.match(defaultSystemPrompt, /`\[voice\]` describes Telegram voice reply policy/);
  assert.match(defaultSystemPrompt, /`manual` means answer normally/);
  assert.match(defaultSystemPrompt, /`mirror` means voice input prefers a voice reply/);
  assert.match(defaultSystemPrompt, /`always` means the final reply is expected to be converted to voice/);
  assert.match(defaultSystemPrompt, /telegram_attach/);
  assert.match(defaultSystemPrompt, /telegram_message/);
  assert.match(defaultSystemPrompt, /buttons/);
  assert.match(defaultSystemPrompt, /telegram_voice text="Short summary"/);
  assert.match(defaultSystemPrompt, /telegram_button: OK/);
  assert.match(defaultSystemPrompt, /telegram_button label=Continue prompt=/);
  assert.match(defaultSystemPrompt, /Do not render button JSON/);
  assert.match(defaultSystemPrompt, /do not invent standalone button tools/);
  assert.match(defaultSystemPrompt, /inside code fences, block quotes, lists/);
  assert.match(
    defaultSystemPrompt,
    /do not call\/register transport\/TTS\/text-to-OGG tools/,
  );
  assert.match(defaultSystemPrompt, /no specific summary format is required/);
});

test("Prompt helpers leave local prompts private for proactive result push", async () => {
  const hook = createTelegramProactiveBeforeAgentStartHook({
    baseHook: createTelegramBeforeAgentStartHook({
      telegramPrefix: "[telegram]",
      systemPromptSuffix: "\nbridge active",
    }),
    isConfigured: () => true,
    isProactivePushEnabled: () => true,
    isCurrentOwner: () => true,
  });
  const result = await hook(
    createBeforeAgentStartEvent("local prompt", "base"),
    "ctx",
  );
  assert.deepEqual(result, { systemPrompt: "base\nbridge active" });
});

test("Prompt helpers skip suffix injection when Telegram is not configured", async () => {
  const hook = createTelegramProactiveBeforeAgentStartHook({
    baseHook: createTelegramBeforeAgentStartHook({
      telegramPrefix: "[telegram]",
      systemPromptSuffix: "\nbridge active",
    }),
    isConfigured: () => false,
    isProactivePushEnabled: () => true,
    isCurrentOwner: () => true,
  });
  const result = await hook(
    createBeforeAgentStartEvent("local prompt", "base"),
    "ctx",
  );
  assert.deepEqual(result, { systemPrompt: "base" });
});
