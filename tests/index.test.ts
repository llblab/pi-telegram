/**
 * Regression tests for the Telegram extension entrypoint wiring
 * Covers composition-root binding of tools, commands, lifecycle hooks, and prompt injection
 */

import assert from "node:assert/strict";
import test from "node:test";

import telegramExtension from "../index.ts";
import * as telegramEntrypoint from "../index.ts";
import type { ExtensionAPI, ExtensionContext } from "../lib/pi.ts";

type RegisteredIndexTool = {
  name?: string;
};

type RegisteredIndexCommand = {
  handler: (...args: never[]) => unknown;
};

type RegisteredIndexHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => Promise<unknown> | unknown;

function createIndexApiHarness() {
  const tools = new Map<string, RegisteredIndexTool>();
  const commands = new Map<string, RegisteredIndexCommand>();
  const handlers = new Map<string, RegisteredIndexHandler>();
  const api = {
    on: (event: string, handler: RegisteredIndexHandler) => {
      handlers.set(event, handler);
    },
    registerTool: (definition: RegisteredIndexTool) => {
      if (definition.name) tools.set(definition.name, definition);
    },
    registerCommand: (name: string, definition: RegisteredIndexCommand) => {
      commands.set(name, definition);
    },
  } as unknown as ExtensionAPI;
  return { tools, commands, handlers, api };
}

function getRequiredIndexHandler(
  handlers: Map<string, RegisteredIndexHandler>,
  name: string,
): RegisteredIndexHandler {
  const handler = handlers.get(name);
  assert.ok(handler, `Expected entrypoint handler ${name}`);
  return handler;
}

function createIndexExtensionContext(): ExtensionContext {
  return {} as ExtensionContext;
}

function assertSystemPromptResult(
  value: unknown,
): asserts value is { systemPrompt: string } {
  assert.ok(typeof value === "object" && value !== null);
  assert.equal(typeof Reflect.get(value, "systemPrompt"), "string");
}

test("Extension entrypoint exposes only the default composition root", () => {
  assert.deepEqual(Object.keys(telegramEntrypoint), ["default"]);
});

test("Extension entrypoint wires domain bindings into the pi API", () => {
  const harness = createIndexApiHarness();
  telegramExtension(harness.api);
  assert.deepEqual([...harness.tools.keys()], [
    "telegram_attach",
    "telegram_message",
  ]);
  assert.deepEqual(
    [...harness.commands.keys()],
    [
      "telegram-setup",
      "telegram-status",
      "telegram-connect",
      "telegram-disconnect",
    ],
  );
  assert.deepEqual(
    [...harness.handlers.keys()],
    [
      "session_start",
      "session_shutdown",
      "session_before_compact",
      "session_compact",
      "before_agent_start",
      "model_select",
      "agent_start",
      "tool_execution_start",
      "tool_execution_end",
      "message_start",
      "message_update",
      "agent_end",
    ],
  );
});

test("Extension before-agent-start hook skips Telegram guidance when unconfigured", async () => {
  const harness = createIndexApiHarness();
  telegramExtension(harness.api);
  const handler = getRequiredIndexHandler(
    harness.handlers,
    "before_agent_start",
  );
  const basePrompt = "System base";
  const telegramResult = await handler(
    { systemPrompt: basePrompt, prompt: "[telegram] hello" },
    createIndexExtensionContext(),
  );
  const localResult = await handler(
    { systemPrompt: basePrompt, prompt: "hello" },
    createIndexExtensionContext(),
  );
  assertSystemPromptResult(telegramResult);
  assertSystemPromptResult(localResult);
  assert.equal(telegramResult.systemPrompt, basePrompt);
  assert.equal(localResult.systemPrompt, basePrompt);
});
