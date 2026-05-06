/**
 * Regression tests for the Telegram extension entrypoint wiring
 * Covers composition-root binding of tools, commands, lifecycle hooks, and prompt injection
 */

import assert from "node:assert/strict";
import test from "node:test";

import telegramExtension from "../index.ts";
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
  let tool: RegisteredIndexTool | undefined;
  const commands = new Map<string, RegisteredIndexCommand>();
  const handlers = new Map<string, RegisteredIndexHandler>();
  const api = {
    on: (event: string, handler: RegisteredIndexHandler) => {
      handlers.set(event, handler);
    },
    registerTool: (definition: RegisteredIndexTool) => {
      tool = definition;
    },
    registerCommand: (name: string, definition: RegisteredIndexCommand) => {
      commands.set(name, definition);
    },
  } as unknown as ExtensionAPI;
  return { tool: () => tool, commands, handlers, api };
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

test("Extension entrypoint wires domain bindings into the pi API", () => {
  const harness = createIndexApiHarness();
  telegramExtension(harness.api);
  assert.equal(harness.tool()?.name, "telegram_attach");
  assert.deepEqual(
    [...harness.commands.keys()],
    [
      "telegram-setup",
      "telegram-status",
      "telegram-connect",
      "telegram-disconnect",
      "telegram-proactive",
    ],
  );
  assert.deepEqual(
    [...harness.handlers.keys()],
    [
      "session_start",
      "session_shutdown",
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

test("Extension before-agent-start hook appends Telegram-specific guidance", async () => {
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
  assert.match(
    telegramResult.systemPrompt,
    /current user message came from Telegram/,
  );
  assert.match(telegramResult.systemPrompt, /telegram_attach/);
  assert.equal(localResult.systemPrompt.includes("came from Telegram"), false);
});
