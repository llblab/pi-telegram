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
  getTelegramHelpText,
  registerTelegramHelpTool,
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

test("Prompt helpers append context-aware system prompt suffixes", () => {
  assert.deepEqual(
    buildTelegramBridgeSystemPrompt({
      prompt: " [telegram] hello",
      systemPrompt: "base",
      telegramPrefix: "[telegram]",
      localSystemPromptSuffix: "\nlocal bridge available",
      telegramTurnSystemPromptSuffix: "\ntelegram turn contract",
    }),
    {
      systemPrompt:
        "base\nlocal bridge available\ntelegram turn contract\n- The current user message came from Telegram.",
    },
  );
  assert.deepEqual(
    buildTelegramBridgeSystemPrompt({
      prompt: "local hello",
      systemPrompt: "base",
      telegramPrefix: "[telegram]",
      localSystemPromptSuffix: "\nlocal bridge available",
      telegramTurnSystemPromptSuffix: "\ntelegram turn contract",
    }),
    { systemPrompt: "base\nlocal bridge available" },
  );
});

test("Prompt helpers keep local prompts on compact safety guidance only", () => {
  const result = createTelegramBeforeAgentStartHook()(
    createBeforeAgentStartEvent("local hello", "base"),
  ).systemPrompt;
  assert.match(result, /Telegram bridge available/);
  assert.doesNotMatch(result, /telegram_help/);
  assert.doesNotMatch(result, /telegram_attach/);
  assert.doesNotMatch(result, /telegram_message/);
  assert.doesNotMatch(result, /37 visible cells/);
  assert.doesNotMatch(result, /telegram_voice text="Short summary"/);
  assert.doesNotMatch(result, /telegram_button: OK/);
  assert.doesNotMatch(result, /The current user message came from Telegram/);
});

test("Prompt helpers add full Telegram-turn guidance for Telegram prompts", () => {
  const hook = createTelegramBeforeAgentStartHook({
    telegramPrefix: "[telegram]",
    localSystemPromptSuffix: "\nlocal bridge available",
    telegramTurnSystemPromptSuffix: "\ntelegram turn contract",
  });
  assert.deepEqual(
    hook(createBeforeAgentStartEvent(" [telegram] hello", "base")),
    {
      systemPrompt:
        "base\nlocal bridge available\ntelegram turn contract\n- The current user message came from Telegram.",
    },
  );
  assert.deepEqual(
    hook(
      createBeforeAgentStartEvent(
        " [telegram|chat:supergroup|thread:42] hello",
        "base",
      ),
    ),
    {
      systemPrompt:
        "base\nlocal bridge available\ntelegram turn contract\n- The current user message came from Telegram.",
    },
  );
  const defaultSystemPrompt = createTelegramBeforeAgentStartHook()(
    createBeforeAgentStartEvent(" [telegram] hello", "base"),
  ).systemPrompt;
  assert.match(
    defaultSystemPrompt,
    /The current user message came from Telegram/,
  );
  assert.match(defaultSystemPrompt, /telegram_help/);
  assert.doesNotMatch(defaultSystemPrompt, /mobile Telegram/);
  assert.doesNotMatch(defaultSystemPrompt, /\$\.\.\.\$.*\$\$\.\.\.\$\$/);
  assert.doesNotMatch(defaultSystemPrompt, /37 visible cells/);
  assert.doesNotMatch(
    defaultSystemPrompt,
    /`\[reply\]` is quoted context only/,
  );
  assert.doesNotMatch(defaultSystemPrompt, /`\[outputs\]` are handler results/);
  assert.doesNotMatch(defaultSystemPrompt, /`\[time\]` is wall-clock context/);
  assert.doesNotMatch(
    defaultSystemPrompt,
    /`\[voice\]` gives reply-mode policy/,
  );
  assert.doesNotMatch(defaultSystemPrompt, /telegram_attach/);
  assert.doesNotMatch(defaultSystemPrompt, /telegram_message/);
  assert.doesNotMatch(
    defaultSystemPrompt,
    /telegram_voice text="Short summary"/,
  );
  assert.doesNotMatch(defaultSystemPrompt, /telegram_button: OK/);
  assert.doesNotMatch(defaultSystemPrompt, /state\.json/);
  assert.doesNotMatch(defaultSystemPrompt, /logs\.jsonl/);
  assert.doesNotMatch(
    defaultSystemPrompt,
    /thread.*visible Thread identity.*not a bus role/s,
  );
  assert.doesNotMatch(
    defaultSystemPrompt,
    /Give yourself a unique thread name/,
  );
  assert.doesNotMatch(defaultSystemPrompt, /telegram_rename_thread/);

  const topicSystemPrompt = createTelegramBeforeAgentStartHook()(
    createBeforeAgentStartEvent(" [telegram|thread:C] hello", "base"),
  ).systemPrompt;
  assert.match(
    topicSystemPrompt,
    /The current user message came from Telegram/,
  );
  assert.doesNotMatch(topicSystemPrompt, /unnamed fresh topic/);
  assert.doesNotMatch(topicSystemPrompt, /telegram_rename_thread/);
});

test("Prompt helpers expose detailed Telegram guidance through agent help tool", async () => {
  const help = getTelegramHelpText();
  assert.match(help, /Assistant-authored Telegram actions/);
  assert.match(help, /telegram_voice text="Short summary"/);
  assert.match(help, /telegram_button: OK/);
  assert.match(help, /inboundHandlers/);
  assert.match(help, /speech-to-text/);
  assert.match(help, /state\.json/);
  assert.match(help, /logs\.jsonl/);
  const namedHelp = getTelegramHelpText("work");
  assert.match(namedHelp, /state\.work\.json/);
  assert.match(namedHelp, /logs\.work\.jsonl/);

  let tool:
    { name?: string; execute: () => Promise<unknown> | unknown } | undefined;
  registerTelegramHelpTool(
    {
      registerTool: (definition: { name?: string; execute: () => unknown }) => {
        tool = definition;
      },
    } as never,
    { getActiveProfileName: () => "work" },
  );
  assert.equal(tool?.name, "telegram_help");
  assert.deepEqual(await tool?.execute(), {
    content: [{ type: "text", text: namedHelp }],
    details: {},
  });
});

test("Prompt helpers leave local prompts private for proactive result push", async () => {
  const hook = createTelegramProactiveBeforeAgentStartHook({
    baseHook: createTelegramBeforeAgentStartHook({
      telegramPrefix: "[telegram]",
      localSystemPromptSuffix: "\nlocal bridge available",
      telegramTurnSystemPromptSuffix: "\ntelegram turn contract",
    }),
    isConfigured: () => true,
    isProactivePushEnabled: () => true,
    isCurrentOwner: () => true,
  });
  const result = await hook(
    createBeforeAgentStartEvent("local prompt", "base"),
    "ctx",
  );
  assert.deepEqual(result, { systemPrompt: "base\nlocal bridge available" });
});

test("Prompt helpers skip suffix injection when Telegram is not configured", async () => {
  const hook = createTelegramProactiveBeforeAgentStartHook({
    baseHook: createTelegramBeforeAgentStartHook({
      telegramPrefix: "[telegram]",
      localSystemPromptSuffix: "\nlocal bridge available",
      telegramTurnSystemPromptSuffix: "\ntelegram turn contract",
    }),
    isConfigured: () => false,
    isProactivePushEnabled: () => true,
    isCurrentOwner: () => true,
  });
  const result = await hook(
    createBeforeAgentStartEvent("[telegram] hello", "base"),
    "ctx",
  );
  assert.deepEqual(result, { systemPrompt: "base" });
});
