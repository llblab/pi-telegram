/**
 * Regression tests for Telegram prompt injection helpers
 * Covers system prompt suffix construction and before-agent-start hook binding
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramBridgeSystemPrompt,
  createTelegramBeforeAgentStartHook,
  createTelegramModelContextAvailabilityBinding,
  createTelegramModelContextAvailabilityRuntime,
  createTelegramProactiveBeforeAgentStartHook,
  TELEGRAM_ATTACH_PROMPT_GUIDELINES,
  type TelegramSystemPrompt,
  TELEGRAM_ATTACH_PROMPT_SNIPPET,
  TELEGRAM_CONNECTED_CONTEXT_MESSAGE,
  TELEGRAM_DISCONNECTED_CONTEXT_MESSAGE,
} from "../lib/prompts.ts";

type BeforeAgentStartHookEvent = Parameters<
  ReturnType<typeof createTelegramBeforeAgentStartHook>
>[0];

function createBeforeAgentStartEvent(
  prompt: string,
  systemPrompt: TelegramSystemPrompt,
): BeforeAgentStartHookEvent {
  return { prompt, systemPrompt } as BeforeAgentStartHookEvent;
}

test("Prompt hooks normalize missing and null system prompts without losing Telegram guidance", async () => {
  for (const systemPrompt of [undefined, null]) {
    const event = { prompt: "[telegram] hello", systemPrompt } as BeforeAgentStartHookEvent;
    const hook = createTelegramBeforeAgentStartHook({
      localSystemPromptSuffix: "local", telegramTurnSystemPromptSuffix: "/telegram",
    });
    assert.equal(hook(event).systemPrompt, "local/telegram\n- The current user message came from Telegram.");
    for (const available of [false, true]) {
      const proactive = createTelegramProactiveBeforeAgentStartHook({
        baseHook: hook, isAvailable: () => available,
      });
      assert.deepEqual(await proactive(event, undefined), {
        systemPrompt: available ? hook(event).systemPrompt : "",
      });
    }
  }
  assert.deepEqual(buildTelegramBridgeSystemPrompt({
    prompt: "local", localSystemPromptSuffix: "suffix", telegramTurnSystemPromptSuffix: "telegram",
  }), { systemPrompt: "suffix" });
});

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

test("Prompt helpers preserve ordered system prompt blocks", () => {
  assert.deepEqual(
    buildTelegramBridgeSystemPrompt({
      prompt: "local hello",
      systemPrompt: ["base", "project context"],
      telegramPrefix: "[telegram]",
      localSystemPromptSuffix: "\nlocal bridge available",
      telegramTurnSystemPromptSuffix: "\ntelegram turn contract",
    }),
    {
      systemPrompt: [
        "base",
        "project context",
        "\nlocal bridge available",
      ],
    },
  );
});

test("Prompt helpers keep local prompts on compact safety guidance only", () => {
  const result = createTelegramBeforeAgentStartHook()(
    createBeforeAgentStartEvent("local hello", "base"),
  ).systemPrompt;
  assert.ok(typeof result === "string");
  assert.match(result, /Telegram session connected/);
  assert.match(result, /connectivity alone is not user intent/);
  assert.match(result, /`telegram-bridge`/);
  assert.match(result, /`generated-control-surface`/);
  assert.match(result, /`generative-apps`/);
  assert.match(result, /bundled Skills in routing order/);
  assert.match(result, /`telegram-bridge` for the transport and turn protocol/);
  assert.match(
    result,
    /`generated-control-surface` when contextual controls materially shorten feedback/,
  );
  assert.match(
    result,
    /`generative-apps` when the interaction warrants a reusable deterministic app/,
  );
  assert.match(
    result,
    /Load a Skill only if its instructions are not already present in the current context/,
  );
  assert.doesNotMatch(result, /telegram_help/);
  assert.doesNotMatch(result, /telegram_attach/);
  assert.doesNotMatch(result, /telegram_message/);
  assert.doesNotMatch(result, /37 visible cells/);
  assert.doesNotMatch(result, /telegram_voice text="Short summary"/);
  assert.doesNotMatch(result, /The current user message came from Telegram/);
});

test("Connection context messages are concise and explicit", () => {
  assert.equal(
    TELEGRAM_CONNECTED_CONTEXT_MESSAGE,
    "Telegram session connected. Use Telegram features for Telegram-originated turns or explicit Telegram requests; connectivity alone is not user intent.",
  );
  assert.equal(
    TELEGRAM_DISCONNECTED_CONTEXT_MESSAGE,
    "Telegram session disconnected. Do not use Telegram delivery, actions, or Telegram-specific reply features unless the user reconnects it.",
  );
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
  assert.ok(typeof defaultSystemPrompt === "string");
  assert.match(
    defaultSystemPrompt,
    /The current user message came from Telegram/,
  );
  assert.match(
    defaultSystemPrompt,
    /Follow the applicable bundled Telegram Skills in routing order/,
  );
  assert.match(defaultSystemPrompt, /load only missing instructions/);
  assert.doesNotMatch(defaultSystemPrompt, /telegram_help/);
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
  assert.doesNotMatch(defaultSystemPrompt, /telegram_voice: Speak this/);
  assert.doesNotMatch(defaultSystemPrompt, /\/telegram_voice/);
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
  assert.ok(typeof topicSystemPrompt === "string");
  assert.match(
    topicSystemPrompt,
    /The current user message came from Telegram/,
  );
  assert.doesNotMatch(topicSystemPrompt, /unnamed fresh topic/);
  assert.doesNotMatch(topicSystemPrompt, /telegram_rename_thread/);
});

test("Prompt helpers leave local prompts private for proactive result push", async () => {
  const hook = createTelegramProactiveBeforeAgentStartHook({
    baseHook: createTelegramBeforeAgentStartHook({
      telegramPrefix: "[telegram]",
      localSystemPromptSuffix: "\nlocal bridge available",
      telegramTurnSystemPromptSuffix: "\ntelegram turn contract",
    }),
    isAvailable: () => true,
  });
  const result = await hook(
    createBeforeAgentStartEvent("local prompt", "base"),
    "ctx",
  );
  assert.deepEqual(result, { systemPrompt: "base\nlocal bridge available" });
});

test("Prompt helpers skip suffix injection when Telegram transport is unavailable", async () => {
  const hook = createTelegramProactiveBeforeAgentStartHook({
    baseHook: createTelegramBeforeAgentStartHook({
      telegramPrefix: "[telegram]",
      localSystemPromptSuffix: "\nlocal bridge available",
      telegramTurnSystemPromptSuffix: "\ntelegram turn contract",
    }),
    isAvailable: () => false,
  });
  const stalePrompt = [
    "base",
    `- telegram_attach: ${TELEGRAM_ATTACH_PROMPT_SNIPPET}`,
    ...TELEGRAM_ATTACH_PROMPT_GUIDELINES.map((line) => `- ${line}`),
  ].join("\n");
  const result = await hook(
    createBeforeAgentStartEvent("[telegram] hello", stalePrompt),
    "ctx",
  );
  assert.deepEqual(result, { systemPrompt: "base" });
});

test("Prompt helpers strip unavailable Telegram tools from each ordered block", async () => {
  const hook = createTelegramProactiveBeforeAgentStartHook({
    isAvailable: () => false,
  });
  const stalePrompt = [
    `base\n- telegram_attach: ${TELEGRAM_ATTACH_PROMPT_SNIPPET}\ntail`,
    "project context",
  ];

  const result = await hook(
    createBeforeAgentStartEvent("[telegram] hello", stalePrompt),
    "ctx",
  );

  assert.deepEqual(result, {
    systemPrompt: ["base\ntail", "project context"],
  });
});

test("Model-context availability binding safely delegates after late composition", () => {
  const calls: string[] = [];
  const binding = createTelegramModelContextAvailabilityBinding();
  binding.reconcile();
  binding.bind({ reconcile: () => calls.push("reconcile") });
  binding.reconcile();
  assert.deepEqual(calls, ["reconcile"]);
});

test("Model-context availability removes only active Telegram tools and restores that subset", () => {
  let available = false;
  let activeTools = [
    "read",
    "telegram_attach",
    "telegram_bind",
    "foreign_tool",
    "telegram_message",
  ];
  const memory = { suspended: false, toolNames: new Set<string>() };
  const runtime = createTelegramModelContextAvailabilityRuntime({
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools = names;
    },
    isAvailable: () => available,
    memory,
  });

  runtime.reconcile();
  assert.deepEqual(activeTools, ["read", "foreign_tool"]);
  assert.deepEqual([...memory.toolNames], [
    "telegram_attach",
    "telegram_bind",
    "telegram_message",
  ]);

  available = true;
  runtime.reconcile();
  assert.deepEqual(activeTools, [
    "read",
    "foreign_tool",
    "telegram_attach",
    "telegram_bind",
    "telegram_message",
  ]);
  assert.equal(memory.toolNames.size, 0);
  assert.equal(memory.suspended, false);
});

test("Model-context availability does not enable a Telegram tool disabled by the operator", () => {
  let available = false;
  let activeTools = ["read", "telegram_message"];
  const runtime = createTelegramModelContextAvailabilityRuntime({
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools = names;
    },
    isAvailable: () => available,
    memory: { suspended: false, toolNames: new Set<string>() },
  });

  runtime.reconcile();
  available = true;
  runtime.reconcile();

  assert.deepEqual(activeTools, ["read", "telegram_message"]);
  assert.equal(activeTools.includes("telegram_attach"), false);
});

test("Model-context availability defers active-tool mutation during an in-flight request", () => {
  let canReconcile = false;
  let activeTools = ["read", "telegram_attach"];
  const runtime = createTelegramModelContextAvailabilityRuntime({
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => {
      activeTools = names;
    },
    isAvailable: () => false,
    canReconcile: () => canReconcile,
    memory: { suspended: false, toolNames: new Set<string>() },
  });

  runtime.reconcile();
  assert.deepEqual(activeTools, ["read", "telegram_attach"]);

  canReconcile = true;
  runtime.reconcile();
  assert.deepEqual(activeTools, ["read"]);
});

test("Model-context availability preserves operator subset across Pi reload defaults", () => {
  let activeTools = ["read", "telegram_message"];
  const memory = { suspended: false, toolNames: new Set<string>() };
  const createRuntime = (isAvailable: () => boolean) =>
    createTelegramModelContextAvailabilityRuntime({
      getActiveTools: () => [...activeTools],
      setActiveTools: (names) => {
        activeTools = names;
      },
      isAvailable,
      memory,
    });

  createRuntime(() => false).reconcile();
  assert.deepEqual(activeTools, ["read"]);
  assert.deepEqual([...memory.toolNames], ["telegram_message"]);

  activeTools = ["read", "telegram_attach", "telegram_message"];
  createRuntime(() => false).reconcile();
  assert.deepEqual(activeTools, ["read"]);
  assert.deepEqual([...memory.toolNames], ["telegram_message"]);

  createRuntime(() => true).reconcile();
  assert.deepEqual(activeTools, ["read", "telegram_message"]);
});
