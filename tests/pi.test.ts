/**
 * Regression tests for the pi SDK adapter boundary
 * Covers narrow bridge-facing helpers over concrete pi context contracts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  canStartPollingInExtensionContext,
  compactExtensionContext,
  createExtensionApiRuntimePorts,
  createScopedModelPatternPersister,
  type ExtensionContext,
  getExtensionContextCwd,
  formatPollingStartBlockedByRunMode,
  getExtensionContextMode,
  getExtensionContextModel,
  hasExtensionContextPendingMessages,
  isExtensionContextIdle,
  isExtensionContextPassiveRunMode,
} from "../lib/pi.ts";

type PiRuntimeApiHarness = Parameters<
  typeof createExtensionApiRuntimePorts
>[0] & {
  events: string[];
};

type PiRuntimeModel = Parameters<PiRuntimeApiHarness["setModel"]>[0];

function createHarnessModel(id: string): PiRuntimeModel {
  return { id } as PiRuntimeModel;
}

function getHarnessModelId(model: PiRuntimeModel): string {
  return String(Reflect.get(Object(model), "id"));
}

test("Pi context mode helpers feature-detect passive run modes", () => {
  assert.equal(getExtensionContextMode({ mode: "print" }), "print");
  assert.equal(getExtensionContextMode({ mode: "bogus" }), undefined);
  assert.equal(isExtensionContextPassiveRunMode({ mode: "print" }), true);
  assert.equal(isExtensionContextPassiveRunMode({ mode: "json" }), true);
  assert.equal(isExtensionContextPassiveRunMode({ mode: "rpc" }), false);
  assert.equal(isExtensionContextPassiveRunMode({}), false);
  assert.equal(canStartPollingInExtensionContext({ mode: "tui" }), true);
  assert.equal(canStartPollingInExtensionContext({ mode: "rpc" }), true);
  assert.equal(canStartPollingInExtensionContext({ mode: "json" }), false);
  assert.equal(canStartPollingInExtensionContext({ mode: "print" }), false);
  assert.equal(canStartPollingInExtensionContext({}), true);
  assert.equal(
    formatPollingStartBlockedByRunMode({ mode: "json" }),
    "Telegram polling is unavailable in Pi json mode. Use /telegram-connect from a long-lived Pi session.",
  );
});

test("Pi API runtime ports bind methods without losing receiver context", async () => {
  const api: PiRuntimeApiHarness = {
    events: [],
    sendUserMessage(content, options) {
      this.events.push(
        `send:${String(content)}:${options?.deliverAs ?? "default"}`,
      );
    },
    async exec(command, args) {
      this.events.push(`exec:${command}:${args.join(",")}`);
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    },
    getCommands() {
      this.events.push("commands");
      return [];
    },
    getThinkingLevel() {
      this.events.push("get-thinking");
      return "high";
    },
    setThinkingLevel(level) {
      this.events.push(`thinking:${String(level)}`);
    },
    getActiveTools() {
      this.events.push("get-tools");
      return ["read"];
    },
    setActiveTools(names) {
      this.events.push(`set-tools:${names.join(",")}`);
    },
    async setModel(model) {
      this.events.push(`model:${getHarnessModelId(model)}`);
      return true;
    },
  };
  const runtime = createExtensionApiRuntimePorts(api);
  runtime.sendUserMessage("hello", { deliverAs: "followUp" });
  assert.deepEqual(await runtime.exec("cmd", ["arg"]), {
    stdout: "ok",
    stderr: "",
    code: 0,
    killed: false,
  });
  assert.deepEqual(runtime.getCommands(), []);
  assert.equal(runtime.getThinkingLevel(), "high");
  runtime.setThinkingLevel("low");
  assert.deepEqual(runtime.getActiveTools(), ["read"]);
  runtime.setActiveTools(["read", "telegram_help"]);
  assert.equal(await runtime.setModel(createHarnessModel("gpt-5")), true);
  assert.deepEqual(api.events, [
    "send:hello:followUp",
    "exec:cmd:arg",
    "commands",
    "get-thinking",
    "thinking:low",
    "get-tools",
    "set-tools:read,telegram_help",
    "model:gpt-5",
  ]);
});

test("Pi scoped model persister invalidates cached inputs without clearing live menus", async () => {
  const events: string[] = [];
  const persist = createScopedModelPatternPersister({
    createSettingsManager: (cwd) => ({
      reload: async () => {},
      flush: async () => {
        events.push("flush");
      },
      getEnabledModels: () => undefined,
      setEnabledModels: (patterns) => {
        events.push(`set:${cwd}:${patterns?.join(",") ?? "all"}`);
      },
    }),
    clearCachedModelMenuInputs: () => {
      events.push("clear-cache");
    },
  });
  await persist(["openai/gpt-5"], { cwd: "/tmp/project" } as ExtensionContext);
  assert.deepEqual(events, [
    "set:/tmp/project:openai/gpt-5",
    "flush",
    "clear-cache",
  ]);
});

test("Pi context helpers expose model, idle, pending-message, and compact adapters", () => {
  const model = { provider: "openai", id: "gpt-5", name: "GPT-5" };
  const events: string[] = [];
  const ctx = {
    model,
    isIdle: () => true,
    hasPendingMessages: () => false,
    cwd: "/tmp/project",
    compact: (callbacks: { onComplete: () => void }) => {
      events.push("compact");
      callbacks.onComplete();
    },
  } as unknown as ExtensionContext;
  compactExtensionContext(ctx, {
    onComplete: () => {
      events.push("complete");
    },
    onError: () => {
      events.push("error");
    },
  });
  assert.equal(getExtensionContextModel(ctx), model);
  assert.equal(getExtensionContextCwd(ctx), "/tmp/project");
  assert.equal(isExtensionContextIdle(ctx), true);
  assert.equal(hasExtensionContextPendingMessages(ctx), false);
  assert.deepEqual(events, ["compact", "complete"]);
});
