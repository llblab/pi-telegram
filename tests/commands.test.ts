/**
 * Regression tests for Telegram command helpers
 * Covers slash-command normalization, bot suffix stripping, arguments, and non-command input
 */

import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  buildTelegramAppMenuHtml,
  buildTelegramCommandAction,
  isTelegramReservedCommandName,
  formatTelegramCommandEmojiPrefix,
  formatTelegramInvalidInstanceName,
  formatTelegramPiCommandHtml,
  formatTelegramThreadDisplayNameSavedHeading,
  getTelegramProfileCompletions,
  createTelegramAppMenuHtmlBuilder,
  createTelegramBotCommandRegistrar,
  createTelegramThreadDisplayNameRenameBinding,
  createTelegramThreadDisplayNameResetBinding,
  createTelegramCommandControlEnqueueAdapter,
  createTelegramCommandHandler,
  createTelegramCommandHandlerTargetRuntime,
  type TelegramCommandHandlerTargetRuntimeDeps,
  createTelegramCommandOrPromptDispatcher,
  createTelegramCommandTargetQueueRuntime,
  createTelegramCommandTargetRuntime,
  createTelegramSessionActionAssembly,
  createTelegramSessionActionRuntime,
  settleTelegramSessionReplacement,
  TELEGRAM_CONNECT_COMMAND_NAME,
  TELEGRAM_INTERNAL_COMMAND_FLAG,
  TELEGRAM_INTERNAL_MANUAL_USE_MESSAGE,
  type TelegramSessionActionRuntimeDeps,
  executeTelegramCommandAction,
  getTelegramCommandMessageTarget,
  clearTelegramExtensionCommands,
  findTelegramExtensionCommand,
  prepareTelegramSelectedExtensionCommand,
  handleTelegramAbortCommand,
  handleTelegramCompactCommand,
  handleTelegramCompactConfirmationCallback,
  handleTelegramModelCommand,
  handleTelegramNewCommand,
  handleTelegramNewConfirmationCallback,
  openTelegramNewConfirmation,
  handleTelegramNextCommand,
  handleTelegramStopCommand,
  parseTelegramCommand,
  registerTelegramBotCommands,
  registerTelegramCommand,
  registerTelegramBridgeCommands,
  TELEGRAM_APP_MENU_INTRO_HTML,
  TELEGRAM_BOT_COMMANDS,
  TELEGRAM_COMMAND_ACTIONS,
  TELEGRAM_COMMAND_EMOJI,
  TELEGRAM_RESERVED_COMMAND_NAMES,
} from "../lib/commands.ts";
import type { PreparedSelectedCommand, SelectedCommandExecution, SelectedPreparationInput } from "../api/commands.ts";
import { runTelegramPollLoop } from "../lib/polling.ts";
import * as Queue from "../lib/queue.ts";
import * as Turns from "../lib/turns.ts";
import { expandTelegramPromptTemplateCommand } from "../lib/prompt-templates.ts";
import { TELEGRAM_DEFAULT_PROFILE_NAME } from "../lib/paths.ts";
import { createTelegramQueueBindingRuntime, createTelegramFollowerSelectedCommandBinding } from "../lib/bindings.ts";
import { createTelegramMenuActionRuntime, type TelegramModelMenuState } from "../lib/menu.ts";
import { createTelegramQueueMenuRuntime } from "../lib/menu-queue.ts";
import { createTelegramSettingsMenuRuntime } from "../lib/menu-settings.ts";
import { createTelegramOutboundTextReplyRuntime } from "../lib/outbound.ts";
import { createTelegramRenderedMessageDeliveryRuntime, resetTransportReplyDedup } from "../lib/replies.ts";
import { createTelegramActivityPublicationRuntime } from "../lib/activity.ts";
import { TelegramApiAuthorityError, createDefaultTelegramBridgeApiRuntime, createTelegramApiClient, createTelegramBridgeApiRuntime, type TelegramApiCallOptions } from "../lib/telegram-api.ts";
import { createTelegramBusAwareApiRuntime, createTelegramSelectedMenuTextApi } from "../lib/bus-api.ts";
import { withWorkspaceRestoreFixture } from "./fixtures/workspace.ts";
import { createTelegramBusFollowerSelectedMenuCaller, createTelegramBusFollowerRestoreContextGetter, createTelegramBusFollowerRegistrationState, createTelegramBusFollowerLiveRebindRuntime, createTelegramBusFollowerWorkspaceRestoreHandler, createTelegramBusForwardedUpdateReceiverRuntime } from "../lib/bus-follower.ts";
import { createTelegramBusSelectedMenuDeliveryHandler, createTelegramBusLeaderEnvelopeHandler, createTelegramBusLeaderRuntime } from "../lib/bus-leader.ts";
import { createTelegramBusMessageOwnershipRuntime } from "../lib/ownership.ts";
import { createTelegramFollowerApiCallAuthorizer, createTelegramBusFollowerRegistry, createTelegramBusProtocolIdentity, createTelegramBusLocalServer, TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY, type TelegramBusPreparedCommandSource, createTelegramBusLiveRebindController, getTelegramBusFollowerSocketPath, type TelegramBusEnvelope } from "../lib/bus.ts";
import { createTelegramWorkspaceAdmissionLedger } from "../lib/workspace-admission.ts";
import { createTelegramWorkspaceOperationRuntime } from "../lib/workspace-retirement.ts";
import { createTelegramJournalSourceSerialization, createTelegramUpdateJournalStore, createTelegramUpdateJournalBotIdentity, createTelegramUpdateJournalBindingKey, createTelegramUpdateJournalRuntimeBindingResolver, type TelegramJournaledUpdate } from "../lib/journal.ts";
import {
  bindTelegramUpdateAdmissionSource,
  reportTelegramUpdateCompleted,
  reportTelegramUpdateDeferred,
  inspectTelegramDeferredSource,
  inspectTelegramDeferredSourceCompletion,
  prepareTelegramDeferredSourceCompletion,
  assertTelegramUpdateExecutionCurrent,
  type TelegramDeferredSourceCompletionPreparation,
  createTelegramUpdateAdmissionWorkerRuntime,
  createTelegramUpdateAdmissionLifecycleRuntime,
  createTelegramUpdateWorkerRuntime,
  prepareTelegramLiveDeferredInput,
  createTelegramQueueAdmissionSettlementRuntime,
} from "../lib/updates.ts";
import {
  createTelegramTopicTargetStore,
  type TelegramSessionReplacementIntent,
} from "../lib/threads.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "../lib/pi.ts";

type RegisteredBridgeCommand = {
  description: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
  getArgumentCompletions?: (argumentPrefix: string) => unknown;
};

for (const boundary of ["current", "entry", "response", "rebind", "adapter-failure", "unavailable"] as const) {
  test(`Thread rename command binding captures guarded invocation (${boundary})`, async () => {
    const binding = createTelegramThreadDisplayNameRenameBinding();
    const target = { chatId: 7, threadId: 41 };
    let current = boundary !== "entry", calls = 0, replacements = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const assertAuthority = () => { if (!current) throw new Error("Recipient authority lost."); };
    const options = { assertAuthority };
    const observed: unknown[] = [];
    if (boundary !== "unavailable") binding.bind(async (capturedTarget, name, capturedOptions) => {
      calls++;
      observed.push(capturedTarget, name, capturedOptions);
      await held;
      if (boundary === "adapter-failure") throw new Error("Issued result lost.");
      capturedOptions?.assertAuthority?.();
      return { ok: true, threadName: name };
    });
    const pending = binding.rename(target, "Azure", options);
    target.chatId = 8; target.threadId = 99;
    options.assertAuthority = () => { throw new Error("Replaced options must not be borrowed."); };
    if (boundary === "rebind") binding.bind(async () => {
      replacements++; return { ok: true, threadName: "Replacement" };
    });
    if (boundary === "response") current = false;
    release();
    if (boundary === "current") assert.deepEqual(await pending, { ok: true, threadName: "Azure" });
    else if (boundary === "unavailable") assert.deepEqual(await pending,
      { ok: false, message: "Thread display naming is unavailable." });
    else await assert.rejects(pending, boundary === "adapter-failure" ? /Issued result lost/
      : boundary === "rebind" ? /binding.*changed/i : /Recipient authority lost/);
    assert.equal(calls, boundary === "entry" || boundary === "unavailable" ? 0 : 1);
    assert.equal(replacements, 0, "A replacement binding cannot repeat an issued rename");
    if (calls) {
      assert.deepEqual(observed[0], { chatId: 7, threadId: 41 });
      assert.equal(observed[1], "Azure");
      assert.notEqual(observed[2], options);
      assert.equal(typeof (observed[2] as typeof options).assertAuthority, "function");
    }
  });
}

test("Thread rename command binding refuses renewed adapter lifetime at an inner boundary", async () => {
  const binding = createTelegramThreadDisplayNameRenameBinding();
  let issued = 0, published = 0;
  const rename: Parameters<typeof binding.bind>[0] = async (_target, _name, options) => {
    issued++;
    await Promise.resolve();
    binding.bind(rename);
    options?.assertAuthority?.();
    published++;
    return { ok: true };
  };
  binding.bind(rename);
  await assert.rejects(binding.rename({ chatId: 7, threadId: 41 }, "Azure", { assertAuthority() {} }), /binding.*changed/i);
  assert.equal(issued, 1);
  assert.equal(published, 0, "An issued effect cannot publish through a renewed binding lifetime");
});

test("Thread rename command binding refuses late success without an inner adapter fence", async () => {
  const binding = createTelegramThreadDisplayNameRenameBinding();
  let current = true, issued = 0;
  binding.bind(async () => { issued++; await Promise.resolve(); current = false;
    return { ok: true, threadName: "Azure" }; });
  await assert.rejects(binding.rename({ chatId: 7, threadId: 41 }, "Azure", {
    assertAuthority() { if (!current) throw new Error("Recipient authority lost."); },
  }), /Recipient authority lost/);
  assert.equal(issued, 1);
});

test("Thread rename command binding preserves unguarded adapter shape and captures optional Thread", async () => {
  const binding = createTelegramThreadDisplayNameRenameBinding();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const target = { chatId: 7, threadId: undefined as number | undefined };
  let observed: unknown[] = [];
  binding.bind(async (...args) => { observed = args; await held; return { ok: false, message: "ordinary refusal" }; });
  const pending = binding.rename(target, "Azure");
  target.chatId = 8; target.threadId = 99;
  binding.bind(async () => { throw new Error("Replacement must not replay an ordinary rename."); });
  release();
  assert.deepEqual(await pending, { ok: false, message: "ordinary refusal" });
  assert.deepEqual(observed, [{ chatId: 7 }, "Azure"]);
});

for (const boundary of ["current", "entry", "response", "rebind", "adapter-failure", "unavailable"] as const) {
  test(`Thread reset command binding captures guarded invocation (${boundary})`, async () => {
    const binding = createTelegramThreadDisplayNameResetBinding();
    const target = { chatId: 7, threadId: 41 };
    let current = boundary !== "entry", calls = 0, replacements = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const assertAuthority = () => { if (!current) throw new Error("Recipient authority lost."); };
    const options = { assertAuthority };
    const observed: unknown[] = [];
    if (boundary !== "unavailable") binding.bind(async (capturedTarget, capturedOptions) => {
      calls++;
      observed.push(capturedTarget, capturedOptions);
      await held;
      if (boundary === "adapter-failure") throw new Error("Issued reset result lost.");
      capturedOptions?.assertAuthority?.();
      return { ok: true, threadName: "A" };
    });
    const pending = binding.reset(target, options);
    target.chatId = 8; target.threadId = 99;
    options.assertAuthority = () => { throw new Error("Replaced options must not be borrowed."); };
    if (boundary === "rebind") binding.bind(async () => {
      replacements++; return { ok: true, threadName: "Replacement" };
    });
    if (boundary === "response") current = false;
    release();
    if (boundary === "current") assert.deepEqual(await pending, { ok: true, threadName: "A" });
    else if (boundary === "unavailable") assert.deepEqual(await pending,
      { ok: false, message: "Thread display name reset is unavailable." });
    else await assert.rejects(pending, boundary === "adapter-failure" ? /Issued reset result lost/
      : boundary === "rebind" ? /binding.*changed/i : /Recipient authority lost/);
    assert.equal(calls, boundary === "entry" || boundary === "unavailable" ? 0 : 1);
    assert.equal(replacements, 0, "A replacement binding cannot repeat an issued reset");
    if (calls) {
      assert.deepEqual(observed[0], { chatId: 7, threadId: 41 });
      assert.notEqual(observed[1], options);
      assert.equal(typeof (observed[1] as typeof options).assertAuthority, "function");
    }
  });
}

test("Thread reset command binding refuses renewed adapter lifetime at an inner boundary", async () => {
  const binding = createTelegramThreadDisplayNameResetBinding();
  let issued = 0, published = 0;
  const reset: Parameters<typeof binding.bind>[0] = async (_target, options) => {
    issued++;
    await Promise.resolve();
    binding.bind(reset);
    options?.assertAuthority?.();
    published++;
    return { ok: true };
  };
  binding.bind(reset);
  await assert.rejects(binding.reset({ chatId: 7, threadId: 41 }, { assertAuthority() {} }), /binding.*changed/i);
  assert.equal(issued, 1);
  assert.equal(published, 0, "An issued effect cannot publish through a renewed reset binding lifetime");
});

test("Thread reset command binding refuses late success without an inner adapter fence", async () => {
  const binding = createTelegramThreadDisplayNameResetBinding();
  let current = true, issued = 0;
  binding.bind(async () => { issued++; await Promise.resolve(); current = false;
    return { ok: true, threadName: "A" }; });
  await assert.rejects(binding.reset({ chatId: 7, threadId: 41 }, {
    assertAuthority() { if (!current) throw new Error("Recipient authority lost."); },
  }), /Recipient authority lost/);
  assert.equal(issued, 1);
});

test("Thread reset command binding preserves unguarded adapter shape and captures optional Thread", async () => {
  const binding = createTelegramThreadDisplayNameResetBinding();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const target = { chatId: 7, threadId: undefined as number | undefined };
  let observed: unknown[] = [];
  binding.bind(async (...args) => { observed = args; await held; return { ok: false, message: "ordinary refusal" }; });
  const pending = binding.reset(target);
  target.chatId = 8; target.threadId = 99;
  binding.bind(async () => { throw new Error("Replacement must not replay an ordinary reset."); });
  release();
  assert.deepEqual(await pending, { ok: false, message: "ordinary refusal" });
  assert.deepEqual(observed, [{ chatId: 7 }]);
});

function createCommandRegistrationApiHarness() {
  const commands = new Map<string, RegisteredBridgeCommand>();
  const api = {
    registerCommand: (name: string, definition: RegisteredBridgeCommand) => {
      commands.set(name, definition);
    },
  } as unknown as ExtensionAPI;
  return { api, commands };
}

function getRequiredCommand(
  commands: Map<string, RegisteredBridgeCommand>,
  name: string,
): RegisteredBridgeCommand {
  const command = commands.get(name);
  assert.ok(command, `Expected command ${name}`);
  return command;
}

function createBridgeCommandContext(
  notify: (message: string) => void = () => {},
  confirm: (
    title: string,
    prompt: string,
  ) => Promise<boolean> | boolean = () => false,
  select?: (title: string, items: string[]) => Promise<string | undefined>,
): ExtensionCommandContext {
  return {
    cwd: "/repo",
    ui: {
      notify,
      confirm,
      select,
      theme: {
        fg: (_color: string, value: string) => value,
      },
    },
  } as unknown as ExtensionCommandContext;
}

test("Thread display-name headings escape printable-ASCII markup", () => {
  assert.equal(
    formatTelegramThreadDisplayNameSavedHeading("wasd<&>"),
    "<b>✅ Thread display name saved as <i>wasd&lt;&amp;&gt;</i>.</b>",
  );
});

test("Invalid instance-name guidance bolds only its heading and lists items with code dashes", () => {
  assert.equal(
    formatTelegramInvalidInstanceName(
      "Invalid Telegram instance name: it is empty after trimming; use A.",
    ),
    "<b>⚠️ Invalid Thread Display Name:</b>\n\n<code>-</code> It is empty after trimming.\n<code>-</code> Use A.",
  );
});

test("Command helpers expose Telegram bot command definitions", () => {
  assert.deepEqual(TELEGRAM_COMMAND_EMOJI.model, "🤖");
  assert.deepEqual(TELEGRAM_COMMAND_EMOJI.thinking, "🧠");
  assert.equal(formatTelegramCommandEmojiPrefix("model"), "🤖 ");
  assert.equal(
    formatTelegramPiCommandHtml("/telegram-connect <profile>"),
    "<code>/telegram-connect &lt;profile&gt;</code>",
  );
  for (const command of [
    "new",
    "start",
    "compact",
    "next",
    "continue",
    "abort",
    "stop",
  ]) {
    assert.match(TELEGRAM_APP_MENU_INTRO_HTML, new RegExp(` /${command} —`));
  }
  assert.doesNotMatch(
    TELEGRAM_APP_MENU_INTRO_HTML,
    /<code>\/(?:start|name|compact|next|continue|abort|stop|name)<\/code>/,
  );
  const expectedBuiltins = [
    {
      command: "start",
      description: "🟢 Open menu / Pair bridge",
    },
    { command: "compact", description: "🗜 Compact current session" },
    { command: "new", description: "🆕 Start a new session" },
    {
      command: "continue",
      description: "▶️ Queue continue prompt",
    },
    {
      command: "next",
      description: "⏩ Force next turn",
    },
    {
      command: "abort",
      description: "⏹️ Abort Pi",
    },
    {
      command: "stop",
      description: "🟥 Abort Pi & Clear queue",
    },
  ];
  assert.deepEqual(TELEGRAM_BOT_COMMANDS, expectedBuiltins);
});

test("Command helpers register Telegram bot commands through deps", async () => {
  const calls: unknown[] = [];
  await registerTelegramBotCommands({
    setMyCommands: async (commands) => {
      calls.push(commands);
    },
  });
  await createTelegramBotCommandRegistrar({
    setMyCommands: async (commands) => {
      calls.push(commands);
    },
  })();
  assert.deepEqual(calls, [TELEGRAM_BOT_COMMANDS, TELEGRAM_BOT_COMMANDS]);
});

test("Command helpers coalesce concurrent bot command sync", async () => {
  let calls = 0;
  let finish: (() => void) | undefined;
  const registrar = createTelegramBotCommandRegistrar({
    setMyCommands: async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
    },
  });
  const first = registrar();
  const joined = registrar();
  await Promise.resolve();
  assert.equal(calls, 1);
  finish?.();
  await Promise.all([first, joined]);
  await registrar();
  assert.equal(calls, 2);
});

test("Guarded BotFather registrar shares only an identical captured recipient lifetime", async () => {
  const held = Promise.withResolvers<void>(), calls: unknown[] = [];
  let current = true;
  const firstGuard = () => { if (!current) throw new Error("recipient replaced"); };
  const secondGuard = () => {};
  const options = { assertAuthority: firstGuard };
  const registrar = createTelegramBotCommandRegistrar({
    async setMyCommands(commands, supplied) { calls.push([commands, supplied?.assertAuthority]); await held.promise; },
  });
  const first = registrar(options), ordinary = registrar(), second = registrar({ assertAuthority: secondGuard });
  assert.equal(registrar(options), first);
  assert.equal(registrar(), ordinary);
  assert.equal(registrar({ assertAuthority: secondGuard }), second);
  assert.notEqual(first, ordinary);
  assert.notEqual(first, second);
  assert.deepEqual(calls, [[TELEGRAM_BOT_COMMANDS, firstGuard], [TELEGRAM_BOT_COMMANDS, undefined], [TELEGRAM_BOT_COMMANDS, secondGuard]]);
  options.assertAuthority = secondGuard;
  assert.equal(registrar(options), second, "Replaced options cannot borrow the first lifetime");
  current = false;
  await assert.rejects(registrar({ assertAuthority: firstGuard }), /recipient replaced/);
  const result = assert.rejects(first, /recipient replaced/);
  held.resolve();
  await Promise.all([result, ordinary, second]);
  assert.equal(calls.length, 3, "An uncertain guarded request never reissues automatically");
  await registrar({ assertAuthority: secondGuard });
  assert.equal(calls.length, 4, "Settled in-flight state is not a sticky success cache");
});

for (const boundary of ["entry", "adapter", "response", "failure"] as const) {
  test(`Guarded BotFather registrar captures and fences ${boundary} without replay`, async () => {
    let current = boundary !== "entry", calls = 0;
    const held = Promise.withResolvers<void>();
    const options = { assertAuthority() { if (!current) throw new Error("recipient replaced"); } };
    const guard = options.assertAuthority;
    const deps = { async setMyCommands(commands: readonly { command: string; description: string }[], supplied?: Pick<TelegramApiCallOptions, "assertAuthority">) {
      assert.equal(supplied?.assertAuthority, guard);
      assert.deepEqual(commands, TELEGRAM_BOT_COMMANDS);
      calls++;
      if (boundary === "adapter") { current = false; supplied!.assertAuthority!(); }
      await held.promise;
      if (boundary === "failure") throw new Error("sync result lost");
    } };
    const registrar = createTelegramBotCommandRegistrar(deps), first = registrar(options);
    deps.setMyCommands = async () => assert.fail("Captured adapter cannot be replaced during a request");
    options.assertAuthority = () => {};
    if (boundary === "response") current = false;
    const refused = assert.rejects(first, boundary === "failure" ? /sync result lost/ : /recipient replaced/);
    held.resolve();
    await refused;
    assert.equal(calls, boundary === "entry" ? 0 : 1);
    await Promise.resolve();
    assert.equal(calls, boundary === "entry" ? 0 : 1);
  });
}

for (const boundary of ["current", "entry", "response", "parsing", "retry-wait", "guard-replaced"] as const) {
  test(`Guarded BotFather sync composes registrar/bus/direct/client at ${boundary}`, async () => {
    const originalFetch = globalThis.fetch, family = process.env.PI_TELEGRAM_NETWORK_FAMILY;
    delete process.env.PI_TELEGRAM_NETWORK_FAMILY;
    let current = boundary !== "entry", sleeps = 0;
    const requests: Record<string, unknown>[] = [], diagnostics: unknown[] = [];
    const options = { assertAuthority() { if (!current) throw new Error("Private recipient replaced"); } };
    const guard = options.assertAuthority;
    globalThis.fetch = async (input, init) => {
      assert.ok(String(input).endsWith("/setMyCommands"));
      requests.push(JSON.parse(String(init?.body)));
      if (boundary === "response" || boundary === "guard-replaced") current = false;
      if (boundary === "guard-replaced") options.assertAuthority = () => {};
      if (boundary === "retry-wait") return new Response(JSON.stringify({ ok: false, description: "Too Many Requests" }), { status: 429 });
      const response = new Response(JSON.stringify({ ok: true, result: true }));
      if (boundary === "parsing") response.text = async () => { current = false; return JSON.stringify({ ok: true, result: true }); };
      return response;
    };
    const client = createTelegramApiClient(() => "123:fixture");
    const direct = createTelegramBridgeApiRuntime({ client: { ...client,
      call(method, body, supplied) {
        assert.equal(supplied?.assertAuthority, guard);
        return client.call(method, body, { ...supplied, sleep: async () => { sleeps++; current = false; } });
      } }, tempDir: "/unused", maxFileSizeBytes: 1, tempFileMaxAgeMs: 1,
      recordRuntimeEvent(_category, error) { diagnostics.push(error); },
    });
    const bus = createTelegramBusAwareApiRuntime({ directRuntime: direct, ownsDirect: () => true,
      callFollowerApi: async () => assert.fail("Guarded sync cannot become follower IPC") });
    try {
      const sync = createTelegramBotCommandRegistrar({ setMyCommands: bus.setMyCommands })(options);
      if (boundary === "current") await sync;
      else if (boundary === "entry") await assert.rejects(sync, /Private recipient replaced/);
      else await assert.rejects(sync, { name: "TelegramApiAuthorityError", requestIssued: true });
      assert.deepEqual(requests, boundary === "entry" ? [] : [{ commands: TELEGRAM_BOT_COMMANDS }]);
      assert.equal(sleeps, boundary === "retry-wait" ? 1 : 0);
      assert.equal(diagnostics.length, boundary === "current" || boundary === "entry" ? 0 : 1);
    } finally {
      globalThis.fetch = originalFetch;
      if (family === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY; else process.env.PI_TELEGRAM_NETWORK_FAMILY = family;
    }
  });
}

test("Command helpers keep extension Telegram bot commands hidden by default", async () => {
  clearTelegramExtensionCommands();
  const dispose = registerTelegramCommand({
    name: "fresh",
    description: "Start fresh",
    handler: async () => {},
  });
  const calls: unknown[] = [];
  await registerTelegramBotCommands({
    setMyCommands: async (commands) => {
      calls.push(commands);
    },
  });
  assert.deepEqual(calls, [TELEGRAM_BOT_COMMANDS]);
  dispose();
  clearTelegramExtensionCommands();
});

test("Command helpers register extension Telegram bot commands when visible", async () => {
  clearTelegramExtensionCommands();
  const dispose = registerTelegramCommand({
    name: "fresh",
    description: "Start fresh",
    showInMenu: true,
    emoji: "🆕",
    handler: async () => {},
  });
  const calls: unknown[] = [];
  await registerTelegramBotCommands({
    setMyCommands: async (commands) => {
      calls.push(commands);
    },
  });
  assert.deepEqual(calls, [
    [
      ...TELEGRAM_BOT_COMMANDS.slice(0, 5),
      { command: "fresh", description: "🆕 Start fresh" },
      ...TELEGRAM_BOT_COMMANDS.slice(5),
    ],
  ]);
  dispose();
  clearTelegramExtensionCommands();
});

test("Command helpers reject visible extension commands without emoji", () => {
  clearTelegramExtensionCommands();
  assert.throws(
    () =>
      registerTelegramCommand({
        name: "fresh",
        showInMenu: true,
        handler: () => {},
      }),
    /requires emoji/,
  );
  clearTelegramExtensionCommands();
});

test("Command helpers reject invalid and built-in extension command names", () => {
  clearTelegramExtensionCommands();
  assert.throws(
    () => registerTelegramCommand({ name: "compact-all", handler: () => {} }),
    /Invalid Telegram command name/,
  );
  assert.throws(
    () => registerTelegramCommand({ name: "start", handler: () => {} }),
    /conflicts with built-in command/,
  );
  clearTelegramExtensionCommands();
});

test("Command helpers register disposable extension commands", () => {
  clearTelegramExtensionCommands();
  const dispose = registerTelegramCommand({
    name: "/fresh",
    handler: () => {},
  });
  assert.equal(findTelegramExtensionCommand("fresh")?.name, "fresh");
  assert.throws(
    () => registerTelegramCommand({ name: "fresh", handler: () => {} }),
    /already registered/,
  );
  dispose();
  assert.equal(findTelegramExtensionCommand("fresh"), undefined);
  clearTelegramExtensionCommands();
});

function createSelectedExtensionPreparationFixture() {
  clearTelegramExtensionCommands();
  const current = { source: true, recipient: true };
  const authority = {
    assertSourceCurrent() { if (!current.source) throw new Error("Source changed"); },
    assertRecipientCurrent() { if (!current.recipient) throw new Error("Recipient changed"); },
  };
  const command = { name: "producer", args: "exact arguments" };
  let handlerCalls = 0;
  const handler = () => { handlerCalls++; };
  return { command, current, authority, handler, handlerCalls: () => handlerCalls };
}

for (const kind of ["command-only", "generated-prompt"] as const) test(`Selected extension preparation snapshots ${kind} without execution or extra ports`, async () => {
  const f = createSelectedExtensionPreparationFixture();
  const calls: SelectedCommandExecution[] = [];
  const execute = (ctx: SelectedCommandExecution) => { calls.push(ctx); };
  const plan: PreparedSelectedCommand = kind === "command-only" ? { kind, execute } : { kind, prompt: "  exact normal prompt\n" };
  let input: SelectedPreparationInput | undefined, resume!: () => void;
  const selected = { async prepare(value: SelectedPreparationInput) {
    input = value;
    await new Promise<void>(resolve => { resume = resolve; });
    return plan;
  } };
  const dispose = registerTelegramCommand({ name: "/Producer", handler: f.handler, selected });
  try {
    // Caller-owned registration objects cannot replace the captured callback.
    selected.prepare = async () => assert.fail("Preparation callback must be captured at registration");
    const pending = prepareTelegramSelectedExtensionCommand(f.command, f.authority);
    assert.deepEqual(input, { name: "producer", args: "exact arguments" });
    assert.equal(Object.isFrozen(input), true);
    assert.deepEqual(Object.keys(input!), ["name", "args"]);
    f.command.args = "later caller mutation";
    resume();
    const prepared = await pending;
    assert.ok(prepared);
    assert.notEqual(prepared.plan, plan);
    assert.deepEqual(prepared.plan, plan);
    assert.equal(Object.isFrozen(prepared), true);
    assert.equal(Object.isFrozen(prepared.plan), true);
    if (plan.kind === "generated-prompt") plan.prompt = "changed after capture";
    else plan.execute = () => assert.fail("Captured execution must not change");
    assert.deepEqual(prepared.plan, kind === "command-only" ? { kind, execute } : { kind, prompt: "  exact normal prompt\n" });
    assert.deepEqual(calls, []);
    assert.equal(f.handlerCalls(), 0);
    // This fence intentionally has no original/source lifetime; detached replies will combine it with recipient authority.
    f.current.source = false;
    prepared.assertRegistrationCurrent();
    dispose();
    const replacement = registerTelegramCommand({ name: "producer", handler: f.handler, selected: { prepare: () => plan } });
    try { assert.throws(prepared.assertRegistrationCurrent, /registration changed/); }
    finally { replacement(); }
  } finally { dispose(); clearTelegramExtensionCommands(); }
});

for (const outcome of ["missing", "undefined", "throw", "invalid"] as const) test(`Selected extension preparation refuses ${outcome} without invoking ordinary handlers`, async () => {
  const f = createSelectedExtensionPreparationFixture();
  const invalid: unknown[] = [null, [], {}, { kind: "control", prompt: "text" }, { kind: "command-only" },
    { kind: "command-only", execute: "not callable" }, { kind: "generated-prompt", prompt: " \n" },
    { kind: "generated-prompt", prompt: 42 }, { kind: "generated-prompt", prompt: ["one", "two"] },
    { kind: "generated-prompt", prompt: "text", execute() {} },
    { kind: "command-only", execute() {}, prompt: "text" },
    { kind: "generated-prompt", prompt: "text", [Symbol("extra effect")]: () => {} },
    { get kind() { throw new Error("Invalid plan accessor"); } },
    { kind: "generated-prompt", get prompt() { throw new Error("Invalid payload accessor"); } }];
  const values = outcome === "invalid" ? invalid : [undefined];
  try {
    for (const value of values) {
      const dispose = registerTelegramCommand({ name: "producer", handler: f.handler, selected: outcome === "missing" ? undefined : {
        prepare: async () => { if (outcome === "throw") throw new Error("Producer refused"); return value as PreparedSelectedCommand | undefined; },
      } });
      try {
        assert.equal(await prepareTelegramSelectedExtensionCommand(f.command, f.authority), undefined);
        assert.equal(findTelegramExtensionCommand("producer")?.handler, f.handler);
        assert.equal(f.handlerCalls(), 0);
      } finally { dispose(); }
    }
    assert.equal(await prepareTelegramSelectedExtensionCommand({ name: "absent", args: "" }, f.authority), undefined);
  } finally { clearTelegramExtensionCommands(); }
});

for (const boundary of ["before", "await", "copy"] as const) for (const loss of ["source", "recipient", "registration"] as const)
  test(`Selected extension preparation refuses ${loss} loss at ${boundary}`, async () => {
    const f = createSelectedExtensionPreparationFixture();
    let calls = 0, resume!: () => void, replacement: (() => void) | undefined;
    const revoke = () => {
      if (loss !== "registration") f.current[loss] = false;
      else {
        dispose();
        replacement = registerTelegramCommand({ name: "producer", handler: f.handler, selected: { prepare: () => assert.fail("No replacement preparation") } });
      }
    };
    const plan = { kind: "generated-prompt" as const, get prompt() {
      if (boundary === "copy") revoke();
      return "prepared payload";
    } };
    const dispose = registerTelegramCommand({ name: "producer", handler: f.handler, selected: { prepare: async () => {
      calls++;
      if (boundary === "await") await new Promise<void>(resolve => { resume = resolve; });
      return plan;
    } } });
    try {
      if (boundary === "before") {
        if (loss === "registration") {
          // A guard may unregister synchronously before the producer can be invoked.
          f.authority.assertSourceCurrent = revoke;
        } else revoke();
      }
      const pending = prepareTelegramSelectedExtensionCommand(f.command, f.authority);
      if (boundary === "await") { revoke(); resume(); }
      assert.equal(await pending, undefined);
      assert.equal(calls, boundary === "before" ? 0 : 1);
      assert.equal(f.handlerCalls(), 0);
    } finally { dispose(); replacement?.(); clearTelegramExtensionCommands(); }
  });

for (const args of ["--internal", "--internal new", "--internal new forged", "--internal future forged", "--internal=new forged", "work --internal new forged", "--INTERNAL new forged", "--internalize new forged", "--internal new forged extra"]) {
  test(`Connect refuses unavailable or malformed internal dispatch without connection effects (${args})`, async () => {
    const harness = createCommandRegistrationApiHarness();
    const effects: string[] = [], notices: string[] = [];
    registerTelegramBridgeCommands(harness.api, {
      promptForConfig: async () => { effects.push("setup"); },
      getStatusLines: () => [],
      reloadConfig: async () => { effects.push("reload"); },
      hasBotToken: () => { effects.push("token"); return true; },
      startPolling: async () => { effects.push("start"); },
      stopPolling: async () => { effects.push("stop"); },
      updateStatus: () => { effects.push("status"); },
      getSessionGeneration: () => { effects.push("generation"); return 1; },
      activateProfileConfig: async () => { effects.push("profile"); return true; },
    });
    await getRequiredCommand(harness.commands, "telegram-connect").handler(args, createBridgeCommandContext(message => notices.push(message)));
    assert.deepEqual(effects, []);
    assert.deepEqual(notices, [TELEGRAM_INTERNAL_MANUAL_USE_MESSAGE]);
  });
}

test("Connect keeps internal as an ordinary profile name", async () => {
  const harness = createCommandRegistrationApiHarness();
  const profiles: string[] = [];
  let starts = 0;
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => assert.fail("Existing named profile must not enter setup"),
    getStatusLines: () => [], reloadConfig: async () => assert.fail("Do not activate default profile"),
    hasBotToken: () => true,
    startPolling: async () => { starts++; }, stopPolling: async () => {}, updateStatus() {},
    activateProfileConfig: async (_ctx, profile) => { profiles.push(profile); return true; },
  });
  for (const profile of ["internal", "new"])
    await getRequiredCommand(harness.commands, "telegram-connect").handler(profile, createBridgeCommandContext());
  assert.deepEqual(profiles, ["internal", "new"]);
  assert.equal(starts, 2);
});

test("Connect reports an unresolved token reference before prompting setup", async () => {
  const harness = createCommandRegistrationApiHarness();
  const notifications: string[] = [];
  const events: string[] = [];
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => {
      events.push("setup");
    },
    getStatusLines: () => [],
    reloadConfig: async () => {},
    hasBotToken: () => false,
    getBotTokenDiagnostic: () =>
      "Telegram bot token environment variable WORK_BOT_TOKEN is not set.",
    startPolling: async () => {
      events.push("start");
    },
    stopPolling: async () => {},
    updateStatus: () => {},
  });
  const connect = getRequiredCommand(harness.commands, "telegram-connect");
  await connect.handler(
    "",
    createBridgeCommandContext((message) => notifications.push(message)),
  );
  assert.deepEqual(events, ["setup"]);
  assert.deepEqual(notifications, [
    "Telegram bot token environment variable WORK_BOT_TOKEN is not set.",
  ]);
});

test("Command helpers register pi setup and status commands", async () => {
  const harness = createCommandRegistrationApiHarness();
  const events: string[] = [];
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => {
      events.push("setup");
    },
    getStatusLines: () => ["bot: @demo", "polling: stopped"],
    reloadConfig: async () => {
      events.push("reload");
    },
    hasBotToken: () => false,
    startPolling: async () => {
      events.push("start");
    },
    stopPolling: async () => {
      events.push("stop");
    },
    updateStatus: () => {
      events.push("update-status");
    },
  });
  const notifications: string[] = [];
  const ctx = createBridgeCommandContext((message) => {
    notifications.push(message);
  });
  assert.deepEqual(
    [
      "telegram-setup",
      "telegram-status",
      "telegram-connect",
      "telegram-disconnect",
    ].map((name) => getRequiredCommand(harness.commands, name).description),
    [
      "<profile> — Configure Telegram bot token",
      "Show Telegram bridge status",
      "<profile> — Start Telegram bridge",
      "Stop Telegram and delete current thread in Threaded Mode",
    ],
  );
  await getRequiredCommand(harness.commands, "telegram-setup").handler("", ctx);
  await getRequiredCommand(harness.commands, "telegram-status").handler(
    "",
    ctx,
  );
  assert.deepEqual(events, ["setup"]);
  assert.deepEqual(notifications, ["bot: @demo\npolling: stopped"]);
  assert.equal(harness.commands.has("telegram-name"), false);
});

test("Connect rejects Thread naming from Pi commands", async () => {
  const harness = createCommandRegistrationApiHarness();
  const notifications: string[] = [];
  let starts = 0;
  let statusUpdates = 0;
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => {},
    getStatusLines: () => [],
    reloadConfig: async () => {},
    hasBotToken: () => true,
    startPolling: async () => {
      starts += 1;
    },
    stopPolling: async () => {},
    updateStatus: () => {
      statusUpdates += 1;
    },
  });

  const connect = getRequiredCommand(harness.commands, "telegram-connect");
  const ctx = createBridgeCommandContext((message) => {
    notifications.push(message);
  });
  await connect.handler("as=Navigator", ctx);
  await connect.handler("work as=Navigator", ctx);

  assert.equal(starts, 0);
  assert.equal(statusUpdates, 2);
  assert.deepEqual(notifications, [
    "Thread names are configured from Telegram, not from Pi commands.",
    "Thread names are configured from Telegram, not from Pi commands.",
  ]);
});

test("Bare and explicit default setup/connect commands select the same profile", async () => {
  const harness = createCommandRegistrationApiHarness();
  const events: string[] = [];
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async (_ctx, profileName) => {
      events.push(`setup:${profileName ?? "default"}`);
    },
    getStatusLines: () => [],
    reloadConfig: async () => {},
    hasBotToken: () => true,
    startPolling: async () => {
      events.push("start");
    },
    stopPolling: async () => {},
    updateStatus: () => {},
    activateDefaultProfileConfig: async () => {
      events.push("activate:default");
    },
    activateProfileConfig: async (_ctx, profileName) => {
      events.push(`unexpected:${profileName}`);
      return false;
    },
  });
  const ctx = createBridgeCommandContext();
  const setup = getRequiredCommand(harness.commands, "telegram-setup");
  const connect = getRequiredCommand(harness.commands, "telegram-connect");

  await setup.handler("", ctx);
  await setup.handler("default", ctx);
  await connect.handler("", ctx);
  await connect.handler("default", ctx);

  assert.deepEqual(events, [
    "setup:default",
    "setup:default",
    "activate:default",
    "start",
    "activate:default",
    "start",
  ]);
});

test("Connect fences invalidated Pi getters and preserves pending intent before inspecting the command context", async () => {
  const { createTelegramConnectionIntentRuntime } = await import("../lib/lifecycle.ts");
  const cases = (["config", "polling", "polling-error"] as const)
    .flatMap((phase) => [false, true].map((withIntent) => ({ phase, withIntent })));
  for (const { phase, withIntent } of cases) {
    const store = {};
    const connectionIntent = withIntent ? createTelegramConnectionIntentRuntime({ store }) : undefined;
    const harness = createCommandRegistrationApiHarness();
    const notifications: string[] = [];
    const events: string[] = [];
    let current = true;
    let generation = 1;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    registerTelegramBridgeCommands(harness.api, {
      promptForConfig: async () => { events.push("setup"); },
      getStatusLines: () => [],
      reloadConfig: async () => {
        events.push("config");
        if (phase === "config") await pending;
      },
      hasBotToken: () => true,
      startPolling: async () => {
        events.push("polling");
        if (phase !== "config") await pending;
        if (phase === "polling-error") {
          throw new Error("This extension ctx is stale after session replacement");
        }
        return { ok: true, message: "Telegram bridge connected." };
      },
      stopPolling: async () => {},
      queueAgentConnectionContext: () => { events.push("context"); },
      updateStatus: () => { events.push("status"); },
      isContextCurrent: (ctx) => !!ctx.sessionManager,
      getSessionGeneration: () => generation,
      connectionIntent,
    });
    const ctx = createBridgeCommandContext((message) => {
      if (!current) throw new Error("This extension ctx is stale after session replacement");
      notifications.push(message);
    });
    Object.defineProperty(ctx, "sessionManager", {
      get() {
        if (!current) throw new Error("This extension ctx is stale after session replacement");
        return {};
      },
    });
    const command = getRequiredCommand(harness.commands, "telegram-connect").handler("", ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    connectionIntent?.suspend({ reason: "resume", cwd: "/repo",
      targetSessionFile: "/destination.jsonl", connected: false });
    current = false;
    generation += 1;
    release();
    await command;
    assert.deepEqual(events, phase === "config" ? ["config"] : ["config", "polling"]);
    assert.deepEqual(notifications, []);
    if (withIntent) {
      assert.ok(createTelegramConnectionIntentRuntime({ store }).resume({ reason: "resume",
        cwd: "/repo", sessionFile: "/destination.jsonl" }));
    }
  }
});

test("Command helpers register pi connect and disconnect commands", async () => {
  const harness = createCommandRegistrationApiHarness();
  const events: string[] = [];
  let hasToken = false;
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => {
      events.push("setup");
    },
    getStatusLines: () => [],
    reloadConfig: async () => {
      events.push("reload");
    },
    hasBotToken: () => hasToken,
    startPolling: async () => {
      events.push("start");
    },
    stopPolling: async () => {
      events.push("stop");
    },
    queueAgentConnectionContext: (connected) => {
      events.push(`context:${connected ? "connected" : "disconnected"}`);
    },
    updateStatus: () => {
      events.push("update-status");
    },
  });
  const ctx = createBridgeCommandContext();
  await getRequiredCommand(harness.commands, "telegram-connect").handler(
    "",
    ctx,
  );
  hasToken = true;
  await getRequiredCommand(harness.commands, "telegram-connect").handler(
    "",
    ctx,
  );
  await getRequiredCommand(harness.commands, "telegram-disconnect").handler(
    "",
    ctx,
  );
  assert.deepEqual(events, [
    "reload",
    "setup",
    "reload",
    "start",
    "context:connected",
    "update-status",
    "stop",
    "context:disconnected",
    "update-status",
  ]);
});

test("Command helpers confirm destructive Threaded Mode disconnects", async () => {
  const harness = createCommandRegistrationApiHarness();
  const events: string[] = [];
  const prompts: string[] = [];
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => undefined,
    getStatusLines: () => [],
    reloadConfig: async () => undefined,
    hasBotToken: () => true,
    startPolling: async () => undefined,
    stopPolling: async () => {
      events.push("stop");
    },
    getDisconnectThreadName: () => "Cinder",
    updateStatus: () => {
      events.push("status");
    },
  });
  const command = getRequiredCommand(
    harness.commands,
    "telegram-disconnect",
  );
  const cancelled = createBridgeCommandContext(
    () => undefined,
    (_title, prompt) => {
      prompts.push(prompt);
      return false;
    },
  );
  await command.handler("", cancelled);
  assert.deepEqual(events, ["status"]);
  assert.match(prompts[0] ?? "", /Cinder/);
  assert.match(prompts[0] ?? "", /Delete Telegram thread/);

  const confirmed = createBridgeCommandContext(
    () => undefined,
    () => true,
  );
  await command.handler("", confirmed);
  assert.deepEqual(events, ["status", "stop", "status"]);
});

test("Command helpers keep failed disconnects actionable and retryable", async () => {
  const harness = createCommandRegistrationApiHarness();
  const notifications: string[] = [];
  const diagnostics: unknown[] = [];
  let statusUpdates = 0;
  registerTelegramBridgeCommands(harness.api, {
    recordConnectionEvent: (error) => { diagnostics.push(error); },
    promptForConfig: async () => undefined,
    getStatusLines: () => [],
    reloadConfig: async () => undefined,
    hasBotToken: () => true,
    startPolling: async () => undefined,
    stopPolling: async () => {
      throw new Error("Telegram thread deletion was not confirmed");
    },
    updateStatus: () => {
      statusUpdates += 1;
    },
  });
  const command = getRequiredCommand(
    harness.commands,
    "telegram-disconnect",
  );
  const ctx = createBridgeCommandContext((message) => {
    notifications.push(message);
  });

  await command.handler("", ctx);
  assert.equal(statusUpdates, 1);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0] ?? "", /keep Pi open/);
  assert.match(notifications[0] ?? "", /telegram-status --debug/);
  assert.match(String(diagnostics[0]), /deletion was not confirmed/);
  assert.ok(!notifications[0]!.includes("deletion was not confirmed"));
});



test("Connection failures keep opaque details in redacted diagnostics, never the TUI", async () => {
  const { createTelegramRuntimeEventRecorder } = await import("../lib/status.ts");
  for (const phase of ["config", "polling", "result"] as const) {
    const harness = createCommandRegistrationApiHarness();
    const notices: string[] = [];
    const recorder = createTelegramRuntimeEventRecorder({ getBotToken: () => "123:secret" });
    const detail = "This extension ctx is stale after session replacement. token 123:secret; use captured withSession internals";
    registerTelegramBridgeCommands(harness.api, {
      promptForConfig: async () => {}, getStatusLines: () => [], hasBotToken: () => true,
      reloadConfig: async () => { if (phase === "config") throw new Error(detail); },
      startPolling: async () => {
        if (phase === "polling") throw new Error(detail);
        return { ok: false, message: detail };
      }, stopPolling: async () => {}, updateStatus() {},
      recordConnectionEvent: (error, eventPhase) => recorder.record("connection", error, { phase: eventPhase }),
    });
    await getRequiredCommand(harness.commands, "telegram-connect").handler("",
      createBridgeCommandContext((text) => { notices.push(text); }));
    assert.deepEqual(notices, ["Telegram connection failed. Check /telegram-status --debug."]);
    const diagnostics = JSON.stringify(recorder.getEvents());
    assert.match(diagnostics, /withSession/);
    assert.match(diagnostics, /redacted-token/);
    assert.ok(!diagnostics.includes("123:secret"));
  }
});

test("Delayed disconnect errors never touch replaced Pi context getters", async () => {
  const harness = createCommandRegistrationApiHarness();
  let generation = 1;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => {}, getStatusLines: () => [], reloadConfig: async () => {},
    hasBotToken: () => true, startPolling: async () => {},
    stopPolling: async () => { await pending; throw new Error("disconnect failed"); },
    updateStatus() { assert.fail("No stale status publication"); },
    getSessionGeneration: () => generation,
    isContextCurrent: () => { assert.equal(generation, 1, "Generation checked before context"); return true; },
  });
  const command = getRequiredCommand(harness.commands, "telegram-disconnect").handler("",
    createBridgeCommandContext(() => { assert.fail("No stale notice"); }));
  generation++;
  release();
  await command;
});

test("Connect diagnoses unrelated startup errors without a raw Pi error banner", async () => {
  const harness = createCommandRegistrationApiHarness();
  const notifications: string[] = [];
  const diagnostics: unknown[] = [];
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => undefined,
    getStatusLines: () => [],
    reloadConfig: async () => undefined,
    hasBotToken: () => true,
    startPolling: async () => {
      throw new Error("network unavailable");
    },
    stopPolling: async () => undefined,
    recordConnectionEvent: (error) => { diagnostics.push(error); },
    updateStatus: () => undefined,
  });

  await getRequiredCommand(harness.commands, "telegram-connect").handler(
    "", createBridgeCommandContext((text) => { notifications.push(text); }),
  );
  assert.deepEqual(notifications, ["Telegram network unavailable. Retry /telegram-connect."]);
  assert.ok(diagnostics.some((error) => String(error).includes("network unavailable")));
});


test("Command helpers move pi polling ownership after confirmation", async () => {
  const harness = createCommandRegistrationApiHarness();
  const events: string[] = [];
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => undefined,
    getStatusLines: () => [],
    reloadConfig: async () => {
      events.push("reload");
    },
    hasBotToken: () => true,
    startPolling: async (_ctx, options) => {
      events.push(options?.force ? "start-force" : "start");
      return options?.force
        ? { ok: true, message: "connected" }
        : { ok: false, canTakeover: true, message: "active elsewhere" };
    },
    stopPolling: async () => undefined,
    updateStatus: () => {
      events.push("update-status");
    },
  });
  const notifications: string[] = [];
  const ctx = createBridgeCommandContext(
    (message) => {
      notifications.push(message);
    },
    () => {
      events.push("confirm");
      return true;
    },
  );
  await getRequiredCommand(harness.commands, "telegram-connect").handler(
    "",
    ctx,
  );
  assert.deepEqual(events, [
    "reload",
    "start",
    "confirm",
    "start-force",
    "update-status",
  ]);
  assert.deepEqual(notifications, ["connected"]);
});

test("Command helpers parse slash commands with args", () => {
  assert.deepEqual(parseTelegramCommand(" /Model@DemoBot  claude opus "), {
    name: "model",
    args: "claude opus",
  });
  assert.deepEqual(parseTelegramCommand("/status"), {
    name: "status",
    args: "",
  });
});

test("Command helpers ignore non-command input and empty names", () => {
  assert.equal(parseTelegramCommand("hello /status"), undefined);
  assert.equal(parseTelegramCommand("/"), undefined);
});

test("Command helpers resolve message reply targets", () => {
  assert.deepEqual(
    getTelegramCommandMessageTarget({ chat: { id: 1 }, message_id: 2 }),
    { chatId: 1, replyToMessageId: 2, threadId: undefined },
  );
  assert.deepEqual(
    getTelegramCommandMessageTarget({
      chat: { id: 1 },
      message_id: 2,
      message_thread_id: 42,
    }),
    { chatId: 1, replyToMessageId: 2, threadId: 42 },
  );
});

test("Command control enqueue adapter builds and enqueues control items", async () => {
  const calls: string[] = [];
  const enqueueControlItem = createTelegramCommandControlEnqueueAdapter<string>(
    {
      createControlItem: (options) => ({
        kind: "control",
        queueLane: "control",
        queueOrder: 0,
        laneOrder: 0,
        chatId: options.chatId,
        replyToMessageId: options.replyToMessageId,
        controlType: options.controlType,
        statusSummary: options.statusSummary,
        execute: options.execute,
      }),
      enqueueControlItem: (item, ctx) => {
        calls.push(`${item.controlType}:${item.statusSummary}:${ctx}`);
        void item.execute(ctx);
      },
    },
  );
  enqueueControlItem(
    { chatId: 7, replyToMessageId: 11 },
    "ctx",
    "status",
    "⚡ status",
    async (ctx) => {
      calls.push(`execute:${ctx}`);
    },
  );
  assert.deepEqual(calls, ["status:⚡ status:ctx", "execute:ctx"]);
});

test("Command target queue runtime binds control queue and chat targets", async () => {
  const calls: string[] = [];
  const runtime = createTelegramCommandTargetQueueRuntime<
    { chat: { id: number }; message_id: number },
    string
  >({
    createControlItem: (options) => ({
      kind: "control",
      queueLane: "control",
      queueOrder: 0,
      laneOrder: 0,
      chatId: options.chatId,
      replyToMessageId: options.replyToMessageId,
      controlType: options.controlType,
      statusSummary: options.statusSummary,
      ...(options.admissionReceipts
        ? { admissionReceipts: options.admissionReceipts }
        : {}),
      execute: options.execute,
    }),
    appendControlItem: (item, ctx) => {
      calls.push(`append:${item.chatId}:${item.replyToMessageId}:${ctx}`);
      void item.execute(ctx);
    },
    dispatchNextQueuedTelegramTurn: (ctx) => {
      calls.push(`dispatch:${ctx}`);
    },
    showStatus: async () => {},
    openModelMenu: async () => {},
    sendTextReply: async () => {},
  });
  runtime.enqueueControlItem(
    { chat: { id: 7 }, message_id: 11 },
    "ctx",
    "status",
    "⚡ status",
    async (ctx) => {
      calls.push(`execute:${ctx}`);
    },
  );
  assert.deepEqual(calls, ["append:7:11:ctx", "execute:ctx", "dispatch:ctx"]);
});

test("Command target queue runtime binds source ids to exact control receipts", () => {
  const events: string[] = [];
  const queuedReceipts: unknown[] = [];
  const reportedReceipts: unknown[] = [];
  const runtime = createTelegramCommandTargetQueueRuntime<
    {
      chat: { id: number };
      message_id: number;
      pi_telegram_source_update_id?: number;
    },
    string
  >({
    createControlItem: (options) => ({
      kind: "control",
      queueLane: "control",
      queueOrder: 0,
      laneOrder: 0,
      chatId: options.chatId,
      replyToMessageId: options.replyToMessageId,
      controlType: options.controlType,
      statusSummary: options.statusSummary,
      ...(options.admissionReceipts
        ? { admissionReceipts: options.admissionReceipts }
        : {}),
      execute: options.execute,
    }),
    appendControlItem: (item) => {
      events.push("append");
      queuedReceipts.push(item.admissionReceipts);
    },
    dispatchNextQueuedTelegramTurn: () => { events.push("dispatch"); },
    getAdmissionScope: () => "profile-a:bot-a",
    getAdmissionJournalBinding: () => "source-journal",
    onControlQueued: (_message, receipt) => {
      events.push("report");
      reportedReceipts.push(receipt);
    },
    showStatus: async () => {},
    openModelMenu: async () => {},
    sendTextReply: async () => {},
  });

  runtime.enqueueControlItem(
    {
      chat: { id: 7 },
      message_id: 11,
      pi_telegram_source_update_id: 91,
    },
    "ctx",
    "status",
    "status",
    async () => {},
  );
  assert.deepEqual(events, ["append", "report", "dispatch"]);
  assert.deepEqual(queuedReceipts, [reportedReceipts]);
  assert.equal((reportedReceipts[0] as Queue.TelegramQueueAdmissionReceipt).journalBindingKey, "source-journal");
  assert.deepEqual(
    (reportedReceipts[0] as { sourceUpdateIds: number[] }).sourceUpdateIds,
    [91],
  );
});

test("Command target runtime binds chat reply targets to command ports", async () => {
  const calls: string[] = [];
  const runtime = createTelegramCommandTargetRuntime<
    { chat: { id: number }; message_id: number },
    string
  >({
    enqueueControlItem: (target, ctx, controlType, statusSummary, execute) => {
      calls.push(
        `enqueue:${target.chatId}:${target.replyToMessageId}:${ctx}:${controlType}:${statusSummary}`,
      );
      void execute(ctx);
    },
    showStatus: async (chatId, replyToMessageId, ctx, threadId) => {
      calls.push(`status:${chatId}:${replyToMessageId}:${ctx}:${threadId}`);
    },
    openModelMenu: async (chatId, replyToMessageId, ctx, threadId) => {
      calls.push(`model:${chatId}:${replyToMessageId}:${ctx}:${threadId}`);
    },
    sendTextReply: async (chatId, replyToMessageId, text, options) => {
      calls.push(
        `reply:${chatId}:${replyToMessageId}:${text}:${options?.parseMode ?? "plain"}:${options?.target?.threadId}`,
      );
    },
  });
  const message = { chat: { id: 7 }, message_id: 11, message_thread_id: 42 };
  runtime.enqueueControlItem(
    message,
    "ctx",
    "status",
    "⚡ status",
    async () => {
      calls.push("execute");
    },
  );
  await runtime.showStatus(message, "ctx");
  await runtime.openModelMenu(message, "ctx");
  await runtime.openSettingsMenu(message, "ctx");
  await runtime.sendTextReply(message, "hello", { parseMode: "HTML" });
  assert.deepEqual(calls, [
    "enqueue:7:11:ctx:status:⚡ status",
    "execute",
    "status:7:11:ctx:42",
    "model:7:11:ctx:42",
    "reply:7:11:<b>🚫 Settings menu is unavailable.</b>:HTML:42",
    "reply:7:11:hello:HTML:42",
  ]);
});

test("Command helpers build command actions", () => {
  assert.deepEqual(buildTelegramCommandAction("stop"), {
    kind: "stop",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("compact"), {
    kind: "compact",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("status"), {
    kind: "status",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("model"), {
    kind: "model",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("continue"), {
    kind: "continue",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("help"), {
    kind: "help",
    commandName: "help",
    executionMode: "immediate",
  });
  assert.deepEqual(buildTelegramCommandAction("start"), {
    kind: "help",
    commandName: "start",
    executionMode: "immediate",
  });
  assert.deepEqual(Object.keys(TELEGRAM_COMMAND_ACTIONS), [
    ...TELEGRAM_RESERVED_COMMAND_NAMES,
  ]);
  assert.equal(isTelegramReservedCommandName("start"), true);
  assert.equal(isTelegramReservedCommandName("unknown"), false);
  assert.deepEqual(buildTelegramCommandAction("unknown"), {
    kind: "ignore",
    executionMode: "ignored",
  });
  assert.deepEqual(buildTelegramCommandAction(undefined), {
    kind: "ignore",
    executionMode: "ignored",
  });
});

test("Command execution mode contract keeps Telegram controls immediate", () => {
  const cases: Array<[string | undefined, string]> = [
    ["stop", "immediate"],
    ["compact", "immediate"],
    ["help", "immediate"],
    ["start", "immediate"],
    ["continue", "immediate"],
    ["status", "immediate"],
    ["model", "immediate"],
    ["unknown", "ignored"],
    [undefined, "ignored"],
  ];
  assert.deepEqual(
    cases.map(([commandName, _mode]) => [
      commandName,
      buildTelegramCommandAction(commandName).executionMode,
    ]),
    cases,
  );
});

test("Command helpers run stop command side effects", async () => {
  const events: string[] = [];
  await handleTelegramStopCommand({
    hasAbortHandler: () => false,
    clearPendingModelSwitch: () => {
      events.push("clear");
    },
    cancelNextTransitionAnnouncements: () => {
      events.push("cancel-next");
    },
    clearQueuedTelegramItems: () => {
      events.push("clear-queue:2");
      return 2;
    },
    setFoldQueuedPromptsIntoHistory: (fold) => {
      events.push(`fold:${fold}`);
    },
    abortCurrentTurn: () => {
      events.push("unexpected:abort");
    },
    updateStatus: () => {
      events.push("status");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });
  await handleTelegramStopCommand({
    hasAbortHandler: () => true,
    clearPendingModelSwitch: () => {
      events.push("clear");
    },
    cancelNextTransitionAnnouncements: () => {
      events.push("cancel-next");
    },
    clearQueuedTelegramItems: () => {
      events.push("clear-queue:1");
      return 1;
    },
    setFoldQueuedPromptsIntoHistory: (fold) => {
      events.push(`fold:${fold}`);
    },
    abortCurrentTurn: () => {
      events.push("abort");
    },
    updateStatus: () => {
      events.push("status");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });
  assert.deepEqual(events, [
    "clear",
    "cancel-next",
    "clear-queue:2",
    "fold:false",
    "status",
    "reply:<b>💤 No active turn. Cleared 2 queued turns.</b>",
    "clear",
    "cancel-next",
    "clear-queue:1",
    "fold:false",
    "abort",
    "status",
    "reply:<b>⏹️ Aborted current turn. Cleared 1 queued turn.</b>",
  ]);
});

test("Next command renders an emphasized empty queue notice", async () => {
  const replies: Array<{ text: string; parseMode?: "HTML" }> = [];
  await handleTelegramNextCommand({
    hasAbortHandler: () => false,
    isIdle: () => true,
    hasQueuedItems: () => false,
    clearPendingModelSwitch: () => {},
    abortCurrentTurn: () => {},
    dispatchNextQueuedTurn: () => {},
    clearFoldForDispatch: () => {},
    updateStatus: () => {},
    sendTextReply: async (text, options) => {
      replies.push({ text, parseMode: options?.parseMode });
    },
  });

  assert.deepEqual(replies, [
    { text: "<b>⌛ Queue is empty</b>", parseMode: "HTML" },
  ]);
});

test("Next command defers its announcement to queue dispatch before aborting", async () => {
  const events: string[] = [];
  await handleTelegramNextCommand({
    hasAbortHandler: () => true,
    isIdle: () => false,
    hasQueuedItems: () => true,
    clearPendingModelSwitch: () => {},
    abortCurrentTurn: () => events.push("abort"),
    dispatchNextQueuedTurn: () => events.push("dispatch"),
    requestNextDispatchAnnouncement: () => events.push("request-announcement"),
    markActiveTurnNextAbortAnnouncement: () => {
      events.push("mark-abort-announcement");
      return true;
    },
    clearFoldForDispatch: () => events.push("clear-fold"),
    updateStatus: () => events.push("status"),
    sendTextReply: async () => {
      events.push("command-reply");
    },
    getActiveTurnReply: () => {
      events.push("active-turn-snapshot");
      return async () => {
        events.push("active-turn-reply");
      };
    },
  });

  assert.deepEqual(events, [
    "clear-fold",
    "request-announcement",
    "mark-abort-announcement",
    "abort",
    "status",
  ]);
});

test("Idle Next requests a prompt-owned announcement before dispatch", async () => {
  const events: string[] = [];
  await handleTelegramNextCommand({
    hasAbortHandler: () => false,
    isIdle: () => true,
    hasQueuedItems: () => true,
    clearPendingModelSwitch: () => {},
    abortCurrentTurn: () => events.push("abort"),
    dispatchNextQueuedTurn: () => events.push("dispatch"),
    requestNextDispatchAnnouncement: () => events.push("request-announcement"),
    clearFoldForDispatch: () => {},
    updateStatus: () => events.push("status"),
    sendTextReply: async () => {
      events.push("command-reply");
    },
  });
  assert.deepEqual(events, ["request-announcement", "dispatch", "status"]);
});

test("Command helpers scope abort history preservation to Telegram-owned turns", async () => {
  const events: string[] = [];
  const baseDeps = {
    hasAbortHandler: () => true,
    clearPendingModelSwitch: () => {
      events.push("clear");
    },
    cancelNextTransitionAnnouncements: () => {
      events.push("cancel-next");
    },
    abortCurrentTurn: () => {
      events.push("abort");
    },
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => {
      events.push(`fold:${fold}`);
    },
    updateStatus: () => {
      events.push("status");
    },
    sendTextReply: async (text: string) => {
      events.push(`reply:${text}`);
    },
  };
  await handleTelegramAbortCommand({
    ...baseDeps,
    hasActiveTelegramTurn: () => true,
  });
  await handleTelegramAbortCommand({
    ...baseDeps,
    hasActiveTelegramTurn: () => false,
  });
  assert.deepEqual(events, [
    "clear",
    "cancel-next",
    "fold:true",
    "abort",
    "status",
    "reply:<b>⏹️ Aborted current turn.</b>",
    "clear",
    "cancel-next",
    "fold:false",
    "abort",
    "status",
    "reply:<b>⏹️ Aborted current turn.</b>",
  ]);
});

test("Command helpers guard and complete compact command flow", async () => {
  const events: string[] = [];
  await handleTelegramCompactCommand({
    isIdle: () => false,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: (inProgress) => {
      events.push(`set:${inProgress}`);
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    compact: () => {
      events.push("unexpected:compact");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });
  let complete: (() => void) | undefined;
  await handleTelegramCompactCommand({
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: (inProgress) => {
      events.push(`set:${inProgress}`);
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    compact: (callbacks) => {
      events.push("compact");
      complete = callbacks.onComplete;
    },
    startTypingLoop: () => {
      events.push("typing:start");
    },
    stopTypingLoop: () => {
      events.push("typing:stop");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });
  complete?.();
  assert.deepEqual(events, [
    "reply:<b>⏳ Cannot compact while Pi or the Telegram queue is busy. Wait for queued turns to finish or send /abort first.</b>",
    "set:true",
    "status",
    "typing:start",
    "compact",
    "reply:<b>🗜 Compaction started.</b>",
    "typing:stop",
    "set:false",
    "status",
    "dispatch",
    "reply:<b>✅ Compaction completed.</b>",
  ]);
});

test("Command helpers confirm new sessions before requesting replacement", async () => {
  const events: string[] = [];
  await openTelegramNewConfirmation(
    { chatId: 42, threadId: 123, replyToMessageId: 99 },
    {
      sendInteractiveMessage: async (chatId, text, mode, markup, options) => {
        events.push(`${chatId}:${mode}:${text}`);
        events.push(JSON.stringify(markup.inline_keyboard));
        events.push(JSON.stringify(options));
        return 77;
      },
    },
  );
  assert.deepEqual(events, [
    "42:html:<b>Start a new session?</b>",
    '[[{"text":"🆕 Yes, start new","callback_data":"new:confirm"},{"text":"❌ No","callback_data":"new:cancel"}]]',
    '{"target":{"chatId":42,"threadId":123}}',
  ]);
  events.length = 0;
  assert.equal(await handleTelegramNewConfirmationCallback(
    { id: "cancel", data: "new:cancel", message: { chat: { id: 42 }, message_id: 77 } },
    {
      ctx: {},
      answerCallbackQuery: async (id) => { events.push(`answer:${id}`); },
      editInteractiveMessage: async (_chatId, _messageId, text, _mode, markup) => {
        events.push(text);
        events.push(JSON.stringify(markup.inline_keyboard));
      },
      deleteMessage: async () => { events.push("unexpected:delete"); },
      runNew: async () => { events.push("unexpected:run"); },
    },
  ), true);
  assert.deepEqual(events, ["<b>🚫 New session cancelled.</b>", "[]", "answer:cancel"]);
  events.length = 0;
  assert.equal(await handleTelegramNewConfirmationCallback(
    { id: "confirm", data: "new:confirm", message: { chat: { id: 42 }, message_id: 77 } },
    {
      ctx: { id: "ctx" },
      answerCallbackQuery: async (id) => { events.push(`answer:${id}`); },
      editInteractiveMessage: async (_chatId, _messageId, text) => { events.push(text); },
      deleteMessage: async (chatId, messageId) => { events.push(`delete:${chatId}:${messageId}`); },
      runNew: async (ctx) => { events.push(`run:${(ctx as { id: string }).id}`); },
    },
  ), true);
  assert.deepEqual(events, [
    "answer:confirm",
    "delete:42:77",
    "run:ctx",
  ]);
});

test("Command helpers open compact confirmation and handle callbacks", async () => {
  const events: string[] = [];
  const message = { chat: { id: 42 }, message_id: 99, message_thread_id: 123 };
  const handleCommand = createTelegramCommandHandler({
    hasAbortHandler: () => false,
    clearPendingModelSwitch: () => {},
    hasQueuedTelegramItems: () => false,
    clearQueuedTelegramItems: () => 0,
    setFoldQueuedPromptsIntoHistory: () => {},
    abortCurrentTurn: () => {},
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: () => {
      events.push("unexpected:compact");
    },
    updateStatus: () => {},
    dispatchNextQueuedTelegramTurn: () => {},
    compact: () => {},
    enqueueContinueTurn: async () => {},
    enqueueControlItem: () => {},
    showStatus: async () => {},
    openModelMenu: async () => {},
    openThinkingMenu: async () => {},
    openQueueMenu: async () => {},
    getAllowedUserId: () => 1,
    persistAllowedUserId: async () => true,
    registerBotCommands: async () => {},
    sendTextReply: async () => {},
    sendInteractiveMessage: async (
      chatId,
      text,
      mode,
      replyMarkup,
      options,
    ) => {
      events.push(`${chatId}:${mode}:${text}`);
      events.push(JSON.stringify(replyMarkup.inline_keyboard));
      events.push(JSON.stringify(options));
      return 77;
    },
  });
  assert.equal(await handleCommand("compact", message, {}), true);
  assert.deepEqual(events, [
    "42:html:<b>Compact session?</b>",
    '[[{"text":"🗜 Yes, compact","callback_data":"compact:confirm"},{"text":"❌ No","callback_data":"compact:cancel"}]]',
    '{"target":{"chatId":42,"threadId":123}}',
  ]);
  events.length = 0;
  const cancelled = await handleTelegramCompactConfirmationCallback(
    {
      id: "cb-cancel",
      data: "compact:cancel",
      message: { chat: { id: 42 }, message_id: 77 },
    },
    {
      ctx: {},
      answerCallbackQuery: async (id) => {
        events.push(`answer:${id}`);
      },
      editInteractiveMessage: async (chatId, messageId, text, mode, markup) => {
        events.push(`${chatId}:${messageId}:${mode}:${text}`);
        events.push(JSON.stringify(markup.inline_keyboard));
      },
      runCompact: async () => {
        events.push("unexpected:run");
      },
    },
  );
  assert.equal(cancelled, true);
  assert.deepEqual(events, [
    "42:77:html:<b>🚫 Compaction cancelled.</b>",
    "[]",
    "answer:cb-cancel",
  ]);
  events.length = 0;
  const confirmed = await handleTelegramCompactConfirmationCallback(
    {
      id: "cb-confirm",
      data: "compact:confirm",
      message: { chat: { id: 42 }, message_id: 77, message_thread_id: 123 },
    },
    {
      ctx: { id: "ctx" },
      answerCallbackQuery: async (id) => {
        events.push(`answer:${id}`);
      },
      editInteractiveMessage: async (chatId, messageId, text, mode, markup) => {
        events.push(`${chatId}:${messageId}:${mode}:${text}`);
        events.push(JSON.stringify(markup.inline_keyboard));
      },
      runCompact: async (ctx, chatId, messageId, target) => {
        events.push(
          `run:${(ctx as { id: string }).id}:${chatId}:${messageId}:${target?.chatId}:${target?.threadId}`,
        );
      },
    },
  );
  assert.equal(confirmed, true);
  assert.deepEqual(events, [
    "42:77:html:<b>🗜 Compaction started.</b>",
    "[]",
    "answer:cb-confirm",
    "run:ctx:42:77:42:123",
  ]);
});

test("Command helpers defer compact-complete queue dispatch", async () => {
  const events: string[] = [];
  let complete: (() => void) | undefined;
  let deferredDispatch: (() => void) | undefined;
  await handleTelegramCompactCommand({
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: (inProgress) => {
      events.push(`set:${inProgress}`);
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    requestDeferredDispatchNextQueuedTelegramTurn: (dispatch) => {
      events.push("defer");
      deferredDispatch = dispatch;
    },
    compact: (callbacks) => {
      events.push("compact");
      complete = callbacks.onComplete;
    },
    startTypingLoop: () => {
      events.push("typing:start");
    },
    stopTypingLoop: () => {
      events.push("typing:stop");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
  });
  complete?.();
  assert.deepEqual(events, [
    "set:true",
    "status",
    "typing:start",
    "compact",
    "reply:<b>🗜 Compaction started.</b>",
    "typing:stop",
    "set:false",
    "status",
    "defer",
    "reply:<b>✅ Compaction completed.</b>",
  ]);
  deferredDispatch?.();
  assert.deepEqual(events.at(-1), "dispatch");
});

test("Command helpers report compact errors", async () => {
  const events: string[] = [];
  const recordRuntimeEvent = (category: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    events.push(`event:${category}:${message}`);
  };
  let fail: ((error: unknown) => void) | undefined;
  await handleTelegramCompactCommand({
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: (inProgress) => {
      events.push(`set:${inProgress}`);
    },
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    compact: (callbacks) => {
      events.push("compact");
      fail = callbacks.onError;
    },
    startTypingLoop: () => {
      events.push("typing:start");
    },
    stopTypingLoop: () => {
      events.push("typing:stop");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
    recordRuntimeEvent,
  });
  fail?.(new Error("boom"));
  await handleTelegramCompactCommand({
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: (inProgress) => {
      events.push(`throw-set:${inProgress}`);
    },
    updateStatus: () => {
      events.push("throw-status");
    },
    dispatchNextQueuedTelegramTurn: () => {},
    compact: () => {
      throw new Error("sync boom!");
    },
    startTypingLoop: () => {
      events.push("throw-typing:start");
    },
    stopTypingLoop: () => {
      events.push("throw-typing:stop");
    },
    sendTextReply: async (text) => {
      events.push(`reply:${text}`);
    },
    recordRuntimeEvent,
  });
  assert.deepEqual(events, [
    "set:true",
    "status",
    "typing:start",
    "compact",
    "reply:<b>🗜 Compaction started.</b>",
    "typing:stop",
    "set:false",
    "status",
    "dispatch",
    "event:compact:boom",
    "reply:<b>⚠️ Compaction failed! boom.</b>",
    "throw-set:true",
    "throw-status",
    "throw-typing:start",
    "throw-typing:stop",
    "throw-set:false",
    "throw-status",
    "event:compact:sync boom!",
    "reply:<b>⚠️ Compaction failed! sync boom!</b>",
  ]);
});

test("Command helpers execute model controls immediately", async () => {
  const events: string[] = [];
  await handleTelegramModelCommand({
    ctx: "ctx",
    openModelMenu: async (ctx) => {
      events.push(`model:${ctx}`);
    },
  });
  assert.deepEqual(events, ["model:ctx"]);
});

test("Command menu controls propagate non-stale errors", async () => {
  await assert.rejects(
    () =>
      handleTelegramModelCommand({
        ctx: "ctx",
        openModelMenu: async () => {
          throw new Error("menu broke");
        },
      }),
    /menu broke/,
  );
});

test("Command helpers build the unified app menu from commands and status", () => {
  clearTelegramExtensionCommands();
  assert.equal(
    buildTelegramAppMenuHtml(
      "<b>Status:</b> <code>idle</code>\n<b>Context:</b> <code>1%</code>",
    ),
    `${TELEGRAM_APP_MENU_INTRO_HTML}\n\n<b>Status:</b> <code>idle</code>\n<b>Context:</b> <code>1%</code>`,
  );
  assert.equal(
    buildTelegramAppMenuHtml("<b>Status:</b> <code>idle</code>", [
      { command: "review", description: "Review <changes>\nWith details" },
    ]),
    `${TELEGRAM_APP_MENU_INTRO_HTML}\n\n🧩 /review\n\n<b>Status:</b> <code>idle</code>`,
  );
  const dispose = registerTelegramCommand({
    name: "fresh",
    description: "Start fresh",
    showInMenu: true,
    emoji: "🆕",
    handler: () => {},
  });
  const menuWithExtensionCommand = TELEGRAM_APP_MENU_INTRO_HTML.replace(
    "⏩ /next — Force next turn",
    "⏩ /next — Force next turn\n🆕 /fresh — Start fresh",
  );
  assert.equal(
    buildTelegramAppMenuHtml("<b>Status:</b> <code>idle</code>"),
    `${menuWithExtensionCommand}\n\n<b>Status:</b> <code>idle</code>`,
  );
  assert.equal(
    buildTelegramAppMenuHtml("<b>Status:</b> <code>idle</code>", [
      { command: "review", description: "Review changes" },
    ]),
    `${menuWithExtensionCommand}\n\n🧩 /review\n\n<b>Status:</b> <code>idle</code>`,
  );
  dispose();
  clearTelegramExtensionCommands();
  const buildAppMenuHtml = createTelegramAppMenuHtmlBuilder({
    buildStatusHtml: (ctx: string) => `<b>Status ${ctx}</b>`,
  });
  assert.equal(
    buildAppMenuHtml("ctx"),
    `${TELEGRAM_APP_MENU_INTRO_HTML}\n\n<b>Status ctx</b>`,
  );
});

test("Command handler target runtime binds command targets into command handling", async () => {
  const calls: string[] = [];
  let busy = false;
  let queued = false;
  const handleCommand = createTelegramCommandHandlerTargetRuntime<
    {
      chat: { id: number; type?: string };
      message_id: number;
      from?: { id?: number };
    },
    string
  >({
    hasAbortHandler: () => busy,
    clearPendingModelSwitch: () => {},
    hasQueuedTelegramItems: () => queued,
    clearQueuedTelegramItems: () => {
      const count = queued ? 1 : 0;
      queued = false;
      return count;
    },
    setFoldQueuedPromptsIntoHistory: () => {},
    abortCurrentTurn: () => {
      calls.push("abort");
    },
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: () => {},
    updateStatus: () => {},
    dispatchNextQueuedTelegramTurn: (ctx) => {
      calls.push(`dispatch:${ctx}`);
    },
    requestNextDispatchAnnouncement: () => {
      calls.push("request-next-notice");
    },
    markActiveTurnNextAbortAnnouncement: () => {
      calls.push("mark-next-abort");
      return true;
    },
    cancelNextTransitionAnnouncements: () => {
      calls.push("cancel-next-notices");
    },
    enqueueContinueTurn: async (_message, ctx) => {
      calls.push(`continue:${ctx}`);
    },
    compact: () => {},
    requestNewSession: () => {
      calls.push("new-session");
    },
    allocateItemOrder: () => 0,
    allocateControlOrder: () => 0,
    appendControlItem: (item, ctx) => {
      calls.push(
        `append:${item.chatId}:${item.replyToMessageId}:${item.controlType}:${ctx}`,
      );
    },
    showStatus: async (_chatId, _replyToMessageId, ctx) => {
      calls.push(`show:${ctx}`);
    },
    openModelMenu: async () => {},
    openThinkingMenu: async () => {},
    openQueueMenu: async () => {},
    validateThreadName: (name) => name === "bad" ? "Invalid name." : undefined,
    renameCurrentThread: async (_target, name) => {
      calls.push(`rename:${name}`);
      return { ok: true, threadName: name };
    },
    resetCurrentThreadName: async () => {
      calls.push("reset-name");
      return { ok: true, threadName: "A" };
    },
    openThreadNameDialog: async () => {
      calls.push("name-dialog");
    },
    getAllowedUserId: () => 7,
    persistAllowedUserId: async () => true,
    setMyCommands: async () => {},
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      calls.push(`reply:${text}`);
    },
  });
  assert.equal(
    await handleCommand("status", { chat: { id: 7 }, message_id: 11 }, "ctx"),
    true,
  );
  assert.equal(
    await handleCommand(
      "name",
      { chat: { id: 7 }, message_id: 12 },
      "ctx",
      "Navigator",
    ),
    true,
  );
  assert.equal(
    await handleCommand(
      "name",
      { chat: { id: 7 }, message_id: 13 },
      "ctx",
      "A",
    ),
    true,
  );
  assert.equal(
    await handleCommand(
      "name",
      { chat: { id: 7 }, message_id: 14 },
      "ctx",
    ),
    true,
  );
  assert.equal(
    await handleCommand(
      "start",
      {
        chat: { id: -1007, type: "supergroup" },
        message_id: 12,
        from: { id: 7 },
      },
      "ctx",
    ),
    true,
  );
  assert.equal(
    await handleCommand("new", { chat: { id: 7 }, message_id: 15 }, "ctx"),
    true,
  );
  busy = true;
  queued = true;
  assert.equal(
    await handleCommand("next", { chat: { id: 7 }, message_id: 16 }, "ctx"),
    true,
  );
  assert.equal(
    await handleCommand("stop", { chat: { id: 7 }, message_id: 17 }, "ctx"),
    true,
  );
  assert.deepEqual(calls, [
    "show:ctx",
    "rename:Navigator",
    "reply:<b>✅ Thread display name saved as <i>Navigator</i>.</b>",
    "reset-name",
    "reply:<b>✅ Automatic Thread display name restored as <i>A</i>.</b>",
    "name-dialog",
    "show:ctx",
    "new-session",
    "request-next-notice",
    "mark-next-abort",
    "abort",
    "cancel-next-notices",
    "abort",
    "reply:<b>⏹️ Aborted current turn. Cleared 1 queued turn.</b>",
  ]);
});

for (const surface of ["held", "selected"] as const) for (const name of ["continue", "selected_template"] as const) for (const fault of ["current", "same-target", "captured-target", "busy", "enqueue-lost", "report-lost", "recipient-before", "recipient-after", "source-changed",
  "scope-lost", "native-ack-lost", "partial-ack", "worker-stopped", "effect-owner", "bad-receipt", "missing-reader", "missing-disposer", "scope-owner", "scope-binding",
  ...(name === "selected_template" ? ["template-drift", "template-owner", "template-path", "template-before-append", "template-slash"] as const : []),
  ...(surface === "selected" ? ["carrier-anchor-drift", "carrier-chat-drift"] as const : [])] as const) {
  test(`Shared queue registry preserves queue custody and observes only scoped native removal (${surface}/${name}/${fault})`, async () => {
    const f = createFencedCommandTargetFixture(), dir = mkdtempSync(join(tmpdir(), "pi-held-continue-")), path = join(dir, "journal.json");
    const identity = { instanceId: "recipient", processId: process.pid, processBirthId: `${process.pid}:held-continue`, sessionGeneration: 1 };
    const binding = createTelegramUpdateJournalRuntimeBindingResolver({ getProfileName: () => undefined, getBotToken: () => "fixture", getBotId: () => undefined,
      getJournalPath: () => path, getQueueRuntimeIdentity: () => identity, withSourceSerialization: createTelegramJournalSourceSerialization(() => join(dir, "journals.transaction")) })()!;
    const journal = binding.journal, store = Queue.createTelegramQueueStore<typeof f.ctx>();
    const neighbor: Queue.PendingTelegramTurn = { kind: "prompt", chatId: 7, queueOrder: 1, replyToMessageId: 1, target: { chatId: 7, threadId: 10 },
      queueLane: "default", laneOrder: 1, statusSummary: "old work", historyText: "old work", sourceMessageIds: [1], content: [], queuedAttachments: [] };
    store.setQueuedItems([neighbor]);
    let recipientCurrent = false, enqueues = 0, removals = 0, publication = 0, ordinary = 0, expansions = 0;
    const template = { command: "selected_template", path: join(dir, "template.md") },
      expectedText = fault === "template-slash" ? "/stop quoted argument" : "Use quoted argument; tail; quoted argument tail";
    writeFileSync(template.path, `---\ndescription: fixture\n---\n${fault === "template-slash" ? "/stop $1" : "Use $1; $2; $@"}`, "utf8");
    const target = { chatId: 7, threadId: 42 }, originals = { update_id: 100, message: { ...f.message, message_thread_id: fault === "same-target" ? 42 : 10,
      text: name === "continue" ? "/continue@fixture ignored args" : '/selected_template@fixture "quoted argument" tail', reply_to_message: { message_id: 2, text: "captured old reply" } } };
    let item: Queue.PendingTelegramTurn | undefined, selectedOriginal: typeof f.message | undefined;
    f.deps.assertExecutionCurrent = assertTelegramUpdateExecutionCurrent;
    f.deps.enqueueContinueTurn = async () => assert.fail("Held continue cannot fall back to ordinary command admission");
    f.deps.heldTurn = { ...(name === "selected_template" ? { templates: {
      getCommands: () => [template], expand(command: string, args: string) { expansions++; return expandTelegramPromptTemplateCommand(command, args, [template]); },
    } } : {}), async enqueue(message, context, kind, admission) {
      enqueues++; assert.equal(kind, name === "continue" ? "continue" : "prompt"); assert.equal(context, f.ctx); admission.assertCurrent();
      if (fault === "enqueue-lost") throw new Error("Turn preparation unavailable");
      if (fault === "recipient-before") recipientCurrent = false;
      admission.assertCurrent();
      const turn = await Turns.buildTelegramPromptTurnRuntime({ messages: [message], telegramPrefix: "[telegram]", queueOrder: 2,
        rawText: name === "continue" ? "continue" : String(Reflect.get(message, "text")),
        files: [], inferImageMimeType: () => undefined, admissionScope: "held-continue", admissionJournalBinding: binding.recoveryKey });
      if (fault === "template-before-append") writeFileSync(template.path, "Changed expansion");
      admission.assertCurrent();
      item = name === "continue" ? { ...turn, queueLane: "control", laneOrder: 1, statusSummary: "continue" } : turn;
      store.setQueuedItems([...store.getQueuedItems(), item]);
      assert.equal(item.replyToMessageId, fault === "same-target" ? 11 : 0);
      if (fault === "bad-receipt") item.admissionReceipts![0]!.sourceUpdateIds = [101];
      admission.report(item.admissionReceipts ?? []);
      if (fault === "recipient-after") recipientCurrent = false;
      if (fault === "report-lost") throw new Error("Queue report result lost");
    } };
    const commands = createTelegramCommandHandlerTargetRuntime(f.deps);
    let publicationOwner: Parameters<typeof commands.prepareHeldQueueReceipt>[1] | undefined;
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate, typeof f.ctx>({
      journal: { ...journal, inspectSourceCompletion: fault === "missing-reader" ? undefined : journal.inspectSourceCompletion,
        completeQueuedExact: fault === "missing-disposer" ? undefined : (...args) => {
          removals++; const result = journal.completeQueuedExact(...args);
          if (fault === "native-ack-lost") throw new Error("Native removal ACK lost");
          return fault === "partial-ack" ? { ...result, removedUpdateIds: [] } : result;
        } }, getJournalBindingKey: () => binding.recoveryKey, getQueueOwnerIdentity: () => identity,
      hasAuthority: () => true, isContextCurrent: context => context === f.ctx,
      async defaultHandle(update) {
        ordinary++;
        if (surface === "held") assert.fail("Held command cannot replay an update handler");
        selectedOriginal = update.message as typeof f.message;
        reportTelegramUpdateDeferred(selectedOriginal);
      },
      beforeQueueReceiptPublished(receipt, owner, context, current) {
        publicationOwner = { ...owner };
        publication++;
        if (fault === "source-changed") {
          const { exists: _exists, serializedBytes: _bytes, ...snapshot } = journal.read();
          (snapshot.entries[0]!.update.message as { text: string }).text = "changed queued original";
          writeFileSync(path, JSON.stringify(snapshot));
        }
        const scopes = commands.prepareHeldQueueReceipt(fault === "scope-binding" ? { ...receipt, journalBindingKey: "foreign" } : receipt,
          fault === "scope-owner" ? { ...owner, instanceId: "foreign" } : owner, context, current);
        if (fault === "scope-lost") throw new Error("Scope publication result lost");
        return scopes;
      },
    });
    let queueOwnerChecks = 0;
    if (fault === "worker-stopped") {
      const prepare = worker.prepareDeferredQueueAdmission!;
      worker.prepareDeferredQueueAdmission = input => {
        input.signal.addEventListener("abort", event => event.stopImmediatePropagation(), { once: true });
        const queue = prepare.call(worker, input);
        if (!queue) return undefined;
        const current = queue.isCurrent;
        queue.isCurrent = () => { queueOwnerChecks++; return current.call(queue); };
        return queue;
      };
    }
    try {
      worker.start(f.ctx); await worker.waitForDrain();
      const held = surface === "held" ? worker.prepareLiveInput!(f.ctx, [100])! : undefined;
      journal.appendBatch([originals]); worker.signal(); await worker.waitForDrain();
      if (held) assert.ok(held.confirmSaved());
      const readiness = held?.prepareSourceCompletion!();
      assert.equal(commands.canPrepareHeldCommand(name, {}), true);
      assert.equal(expansions, 0, "Registry availability cannot read/expand template bodies");
      const guards = { target, assertSourceCurrent() {}, assertRecipientCurrent() { if (!recipientCurrent) throw new Error("Recipient unavailable"); } };
      const selected = surface === "selected" ? commands.prepareSelectedQueueCommand(parseTelegramCommand(originals.message.text)!, [selectedOriginal!], f.ctx, guards) : undefined;
      const heldPlan = readiness && commands.prepareHeldCommand(name, readiness, f.ctx, guards, {});
      const plan = selected ?? heldPlan;
      assert.ok(plan); const expectedSource = plan.source;
      assert.equal(enqueues, 0); assert.equal(plan.inspectCompletion(), undefined);
      if (heldPlan) assert.ok(held!.prepareStatusConsumption!({ source: plan.source, assertCurrent: guards.assertRecipientCurrent,
        bindCarrier: heldPlan.bindCarrier, execute: heldPlan.execute }));
      const deferred = selectedOriginal && prepareTelegramLiveDeferredInput([selectedOriginal], () => true);
      if (surface === "selected") assert.ok(deferred?.confirmSaved());
      if (fault === "effect-owner") f.deps.heldTurn.enqueue = async () => assert.fail("Replacement cannot inherit issuance");
      if (fault === "template-drift") writeFileSync(template.path, "Changed expansion");
      if (fault === "template-owner") f.deps.heldTurn.templates!.expand = () => assert.fail("Replacement cannot inherit expansion");
      if (fault === "template-path") template.path = join(dir, "other-template.md");
      if (fault === "captured-target") {
        guards.target.chatId = 99; guards.target.threadId = 99;
      }
      if (fault === "carrier-anchor-drift") selectedOriginal!.message_thread_id = 42;
      if (fault === "carrier-chat-drift") selectedOriginal!.chat.id = 99;
      const unissued = ["effect-owner", "template-drift", "template-owner", "template-path", "carrier-anchor-drift", "carrier-chat-drift"].includes(fault);
      recipientCurrent = true;
      if (held) assert.ok(held.release(() => true));
      else { assert.ok(deferred!.beginRelease(() => true)); await plan.execute().catch(() => false); }
      await worker.waitForDrain();
      for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(enqueues, unissued ? 0 : 1); assert.equal(ordinary, surface === "held" ? 0 : 1); assert.deepEqual(f.effects, [], "Admission cannot abort, fold or reply");
      assert.equal(store.getQueuedItems()[0], neighbor, "Existing old-target work stays exact");
      assert.equal(plan.inspectCompletion(), undefined, "Receipt acceptance alone is not source removal");
      const admitted = !unissued && !["enqueue-lost", "recipient-before", "bad-receipt", "template-before-append"].includes(fault);
      assert.equal(publication, admitted ? 1 : 0);
      const ready = admitted && !["recipient-after", "source-changed", "scope-lost", "missing-reader", "missing-disposer", "scope-owner", "scope-binding"].includes(fault);
      const settlement = createTelegramQueueAdmissionSettlementRuntime(worker);
      if (item) {
        assert.deepEqual(item.target, { chatId: 7, threadId: 42 }); assert.equal(item.queueLane, name === "continue" ? "control" : "default");
        assert.equal(item.historyText, name === "continue" ? "continue" : expectedText);
        assert.equal(settlement.isItemReady(item), ready);
      }
      if (fault === "worker-stopped") {
        await worker.stop();
        const before = queueOwnerChecks;
        assert.throws(() => commands.prepareHeldQueueReceipt(item!.admissionReceipts![0]!, publicationOwner!, f.ctx, () => true), /publication authority changed/);
        assert.equal(queueOwnerChecks, before, "A terminal receipt marker refuses fallback without consulting the obsolete queue/context closure");
      }
      if (ready && fault !== "busy" && fault !== "worker-stopped") {
        const result = settlement.onPromptHandedOff(item!, f.ctx);
        assert.equal(result, !["native-ack-lost", "partial-ack"].includes(fault));
      }
      const completed = ready && !["busy", "worker-stopped", "native-ack-lost", "partial-ack"].includes(fault);
      if (admitted && !completed) {
        const beforeScopeInspection = settlement.isItemReady(item!);
        try {
          const scopes = commands.prepareHeldQueueReceipt(item!.admissionReceipts![0]!, publicationOwner!, f.ctx, () => true);
          assert.ok(scopes?.length, "An indexed unconfirmed receipt cannot become ordinary fallback");
        } catch (error) { assert.match(String(error), /Held queue receipt (publication authority changed|original scope is unavailable)/); }
        assert.equal(settlement.isItemReady(item!), beforeScopeInspection, "Read-only scope preparation never repairs publication readiness");
      }
      assert.deepEqual(plan.inspectCompletion(), completed ? expectedSource : undefined);
      assert.equal(removals, ready && fault !== "busy" && fault !== "worker-stopped" ? 1 : 0);
      if (unissued) await assert.rejects(plan.execute(), /owner is unavailable|owner changed/);
      else assert.equal(await plan.execute(), false, "Issued uncertainty never admits a second continuation");
      assert.equal(enqueues, unissued ? 0 : 1);
      if (completed) assert.deepEqual(plan.inspectCompletion(), expectedSource);
      const retained = journal.read().entries.find(entry => entry.updateId === 100);
      if (retained && fault !== "source-changed") assert.deepEqual(retained.update, originals);
    } finally { await worker.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test("Selected queue registry cannot derive native authority from raw messages or groups", () => {
  const f = createFencedCommandTargetFixture();
  f.deps.heldTurn = { async enqueue() { assert.fail("No queue admission"); } };
  const commands = createTelegramCommandHandlerTargetRuntime(f.deps);
  const original = { ...f.message, text: "/continue" }, guards = { target: { chatId: 7, threadId: 42 },
    assertSourceCurrent() { assert.fail("No source activation"); }, assertRecipientCurrent() { assert.fail("No recipient activation"); } };
  assert.equal(commands.prepareSelectedQueueCommand({ name: "continue", args: "" }, [original], f.ctx, guards), undefined);
  for (const messages of [[], [original, original]])
    assert.equal(commands.prepareSelectedQueueCommand({ name: "continue", args: "" }, messages, f.ctx, guards), undefined);
  for (const name of ["status", "abort", "stop", "next", "new", "compact", "unknown"]) {
    const changed = { ...original, text: `/${name}` };
    assert.equal(commands.prepareSelectedQueueCommand({ name, args: "" }, [changed], f.ctx, guards), undefined);
  }
  assert.deepEqual(f.effects, []);
});

for (const mode of ["unregistered", "duplicate", "bad-path", "reserved", "extension", "missing-expander", "unreadable", "wrong-command"] as const) {
  test(`Held template eligibility/preparation refuses without source admission or fallback (${mode})`, () => {
    const f = createFencedCommandTargetFixture(), name = mode === "reserved" ? "model" : "selected_template";
    const command = { command: name, path: mode === "bad-path" ? "" : "/unused/fixture.md" };
    const dispose = mode === "extension" ? registerTelegramCommand({ name, handler() { assert.fail("Extension collision cannot execute"); } }) : undefined;
    let expansions = 0;
    f.deps.heldTurn = { async enqueue() { assert.fail("Refused preparation cannot enqueue"); }, templates: {
      getCommands: () => mode === "unregistered" ? [] : mode === "duplicate" ? [command, { ...command }] : [command],
      expand() { expansions++; throw new Error("Template unavailable"); },
    } };
    if (mode === "missing-expander") f.deps.heldTurn.templates!.expand = undefined!;
    const commands = createTelegramCommandHandlerTargetRuntime(f.deps), availability = mode === "unreadable" || mode === "wrong-command";
    const unreadable = { get snapshot() {
      if (!availability) assert.fail("Unavailable registry entry cannot inspect the original");
      return { update: { update_id: 1, message: { ...f.message, text: mode === "wrong-command" ? "/other_template" : `/${name}` } },
        source: { updateId: 1, journalBindingKey: "fixture", sourceSha256: "a".repeat(64) } };
    }, isCurrent() { assert.fail("Refused expansion cannot acquire a source owner"); }, bindCarrier() { assert.fail("Refused expansion cannot bind a carrier"); } };
    try {
      assert.equal(commands.canPrepareHeldCommand(name, {}), availability); assert.equal(expansions, 0);
      assert.equal(commands.prepareHeldCommand(name, unreadable, f.ctx, { target: { chatId: 7, threadId: 42 },
        assertSourceCurrent() { assert.fail("Refusal cannot activate source authority"); }, assertRecipientCurrent() { assert.fail("Refusal cannot activate a recipient"); } }, {}), undefined);
      assert.equal(expansions, mode === "unreadable" ? 1 : 0); assert.deepEqual(f.effects, []);
    } finally { dispose?.(); }
  });
}

function createFencedCommandTargetFixture() {
  const message = { chat: { id: 7, type: "private" }, message_id: 11, message_thread_id: 41, from: { id: 7, is_bot: false } };
  const ctx = { session: "same-live-session" }, effects: string[] = [], diagnostics: string[] = [];
  let current = true, contextCurrent = true;
  const deps: TelegramCommandHandlerTargetRuntimeDeps<typeof message, typeof ctx> = {
    assertExecutionCurrent(value) {
      assert.equal(value, message);
      if (!current) throw new Error("Command source authority revoked");
    },
    hasAbortHandler: () => true,
    clearPendingModelSwitch: () => { effects.push("clear-model"); },
    hasQueuedTelegramItems: () => false,
    clearQueuedTelegramItems: () => { effects.push("clear-queue"); return 0; },
    setFoldQueuedPromptsIntoHistory: () => { effects.push("fold"); },
    abortCurrentTurn: () => { effects.push("abort"); },
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: () => { effects.push("compact"); },
    updateStatus: () => { effects.push("update"); },
    isContextActive: value => value === ctx && contextCurrent,
    dispatchNextQueuedTelegramTurn: () => { effects.push("dispatch"); },
    enqueueContinueTurn: async () => { effects.push("continue"); },
    compact: () => { effects.push("compact"); },
    requestNewSession: () => { effects.push("new-session"); },
    allocateItemOrder: () => 0,
    allocateControlOrder: () => 0,
    appendControlItem: () => { effects.push("control"); },
    showStatus: async (chat, reply, value, thread) => {
      assert.deepEqual([chat, reply, value, thread], [7, 11, ctx, 41]);
      effects.push("status");
    },
    openModelMenu: async () => { effects.push("model"); },
    openThinkingMenu: async () => { effects.push("thinking"); },
    openQueueMenu: async () => { effects.push("queue"); },
    getAllowedUserId: () => 7,
    persistAllowedUserId: async () => assert.fail("An already paired command cannot pair again"),
    setMyCommands: async () => { effects.push("bot-sync"); },
    sendTextReply: async (chat, reply, _text, options) => {
      assert.deepEqual([chat, reply, options?.target?.threadId], [7, 11, 41]);
      effects.push("reply");
    },
    recordRuntimeEvent(_category, error, detail) {
      diagnostics.push(`${detail?.phase}:${(error as Error).message}`);
    },
  };
  return { message, ctx, deps, effects, diagnostics,
    revoke: () => { current = false; }, replaceContext: () => { contextCurrent = false; } };
}

async function withControlCommandSurface(surface: "selected" | "held", f: ReturnType<typeof createFencedCommandTargetFixture>, name: "stop" | "next",
  admission: Parameters<ReturnType<typeof createTelegramCommandHandlerTargetRuntime<typeof f.message, typeof f.ctx>>["prepareSelectedCommand"]>[3],
  run: (dispatch: () => Promise<boolean>, waitForExecution: () => Promise<void>) => Promise<void>): Promise<void> {
  if (surface === "selected") {
    const handler = createTelegramCommandHandlerTargetRuntime(f.deps), prepare = handler.prepareSelectedCommand;
    const dispatch = prepare({ name, args: "" }, [f.message], f.ctx, admission);
    assert.ok(dispatch);
    await run(dispatch, async () => {});
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "pi-held-control-surface-"));
  const options = { path: join(dir, "journal.json"), botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "fixture" }) };
  const journal = createTelegramUpdateJournalStore(options), key = createTelegramUpdateJournalBindingKey(options);
  const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate, typeof f.ctx>({ journal,
    getJournalBindingKey: () => key, hasAuthority: () => true, isContextCurrent: ctx => ctx === f.ctx,
    getQueueOwnerIdentity: () => ({ instanceId: "held-control", processId: process.pid, processBirthId: `${process.pid}:control`, sessionGeneration: 1 }),
    async defaultHandle() { assert.fail("Held control cannot replay through ordinary admission"); } });
  worker.start(f.ctx);
  try {
    await worker.waitForDrain();
    const held = worker.prepareLiveInput!(f.ctx, [100])!;
    journal.appendBatch([{ update_id: 100, message: { ...f.message, text: `/${name}` } }]);
    worker.signal(); await worker.waitForDrain(); assert.equal(held.confirmSaved(), true);
    const readiness = held.prepareSourceCompletion!()!, bind = readiness.bindCarrier;
    let completed = false;
    readiness.bindCarrier = value => {
      const native = bind(value);
      return native && { ...native, reportCompleted() {
        if (!admission.reportCompleted()) return false;
        completed = native.reportCompleted();
        return completed;
      } };
    };
    f.deps.assertExecutionCurrent = assertTelegramUpdateExecutionCurrent;
    const send = f.deps.sendTextReply;
    const plan = createTelegramCommandHandlerTargetRuntime(f.deps).prepareHeldCommand(name, readiness, f.ctx,
      { target: { chatId: 7, threadId: 42 }, assertSourceCurrent: admission.assertSourceCurrent, assertRecipientCurrent: admission.assertRecipientCurrent },
      { sendTextReply: (chat, anchor, text, options) => send(chat, anchor, text, options) });
    assert.ok(plan);
    const started = Promise.withResolvers<boolean>();
    assert.equal(held.prepareStatusConsumption!({ source: plan.source, assertCurrent: admission.assertRecipientCurrent, bindCarrier: plan.bindCarrier,
      execute() {
        const result = plan.execute();
        void result.then(started.resolve, started.reject);
        return result;
      } }), true);
    let released = false;
    await run(() => {
      if (released) return plan.execute();
      released = true;
      assert.equal(held.release(() => true), true);
      return started.promise;
    }, worker.waitForDrain);
    assert.deepEqual(plan.inspectCompletion(), completed ? readiness.snapshot.source : undefined);
    assert.equal(journal.read().entries.length, completed ? 0 : 1, "Only an exact native completion ACK disposes of the command source");
  } finally { await worker.stop(); rmSync(dir, { recursive: true, force: true }); }
}

for (const mode of ["current", "stale-before", "source-before", "source-during", "failure", "unissued", "issued", "diagnostic-throw", "reset-late"] as const) {
  test(`Detached command scheduling tracks pre-API work and conservative outcome (${mode})`, async () => {
    const f = createFencedCommandTargetFixture(), publication = createTelegramActivityPublicationRuntime();
    const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(); let effects = 0;
    f.deps.beginCommandEffectWork = () => { const work = publication.beginWork();
      if (mode === "stale-before") f.replaceContext(); if (mode === "source-before") f.revoke(); return work; };
    f.deps.showStatus = async () => { effects++; entered.resolve(); await finish.promise;
      if (mode === "unissued") throw new TelegramApiAuthorityError(false);
      if (mode === "issued") throw new TelegramApiAuthorityError(true);
      if (["failure", "diagnostic-throw", "reset-late"].includes(mode)) throw new Error("Unconfirmed started command effect"); };
    if (mode === "diagnostic-throw") f.deps.recordRuntimeEvent = () => { throw new Error("Diagnostics failed"); };
    const command = createTelegramCommandHandlerTargetRuntime(f.deps), accepted = command("status", f.message, f.ctx);
    assert.equal(publication.hasPending(), true, "Reservation precedes the first microtask and source completion"); assert.equal(await accepted, true);
    if (!["stale-before", "source-before"].includes(mode)) {
      await entered.promise; assert.equal(publication.hasPending(), true);
      let ordered = false; await publication.enqueue(async () => { ordered = true; }); assert.equal(ordered, true, "No new serialization");
      if (mode === "source-during") f.revoke();
      if (mode === "reset-late") { publication.reset(); assert.equal(publication.hasPending(), true); }
    }
    finish.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(publication.hasPending(), false); assert.equal(effects, ["stale-before", "source-before"].includes(mode) ? 0 : 1);
    assert.equal(publication.hasUnconfirmed(), ["source-during", "failure", "issued", "diagnostic-throw"].includes(mode));
    publication.reset(); assert.equal(publication.hasUnconfirmed(), false);
  });
}

async function createSelectedExtensionExecutionFixture(execute: (ctx: SelectedCommandExecution) => void | Promise<void>) {
  clearTelegramExtensionCommands();
  const f = createFencedCommandTargetFixture();
  let sourceCurrent = true, recipientCurrent = true, reports = 0;
  const dispose = registerTelegramCommand({ name: "producer", handler: () => assert.fail("No ordinary handler"),
    selected: { prepare: () => ({ kind: "command-only", execute }) } });
  const admission = {
    assertSourceCurrent() { if (!sourceCurrent) throw new Error("Source changed"); },
    assertRecipientCurrent() { if (!recipientCurrent) throw new Error("Recipient changed"); },
    reportCompleted() { reports++; sourceCurrent = false; f.revoke(); return true; },
  };
  const prepared = await prepareTelegramSelectedExtensionCommand({ name: "producer", args: "exact" }, admission);
  assert.ok(prepared);
  return { ...f, prepared, admission, dispose, reports: () => reports,
    revokeSource() { sourceCurrent = false; f.revoke(); },
    revokeRecipient() { recipientCurrent = false; },
    cleanup() { dispose(); clearTelegramExtensionCommands(); } };
}

test("Selected extension execution explicitly reports once without awaiting detached replies", async () => {
  let execution!: SelectedCommandExecution, calls = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = await createSelectedExtensionExecutionFixture(ctx => {
    calls++; execution = ctx;
    ctx.assertCurrent();
    assert.equal(ctx.reportCompleted(), true);
    assert.equal(ctx.reportCompleted(), false);
    ctx.reply("first");
  });
  const replies: string[] = [];
  f.deps.sendTextReply = async (_chat, _reply, text, options) => {
    options?.assertAuthority?.(); replies.push(text); await held; options?.assertAuthority?.();
  };
  try {
    const issue = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedExtensionCommand(f.prepared, [f.message], f.ctx, f.admission);
    assert.ok(issue);
    // The plan and all ports must be captured before ordinary adapter replacement.
    f.admission.reportCompleted = () => assert.fail("No replacement report");
    f.admission.assertRecipientCurrent = () => {};
    f.deps.sendTextReply = async () => assert.fail("No replacement send");
    await issue();
    assert.equal(f.reports(), 1);
    assert.deepEqual(Object.keys(execution), ["assertCurrent", "reportCompleted", "reply"]);
    assert.equal(Object.isFrozen(execution), true);
    assert.throws(execution.assertCurrent, /Source|source/);
    execution.reply("after disposal");
    await issue();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.deepEqual(replies, ["first", "after disposal"]);
    f.revokeRecipient();
    assert.throws(() => execution.reply("stale"), /Recipient/);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.reports(), 1);
    assert.equal(f.diagnostics.length, 2, "Late delivery success refuses without semantic replay");
  } finally { release(); f.cleanup(); }
});

for (const mode of ["return", "throw", "reject", "report-refused", "report-lost", "report-then-throw"] as const)
  test(`Selected extension execution never infers completion or replays (${mode})`, async () => {
    let calls = 0, reportCalls = 0;
    const f = await createSelectedExtensionExecutionFixture(ctx => {
      calls++;
      if (mode.startsWith("report")) {
        if (mode === "report-lost") assert.throws(ctx.reportCompleted, /Report lost/);
        else assert.equal(ctx.reportCompleted(), mode === "report-then-throw");
        assert.equal(ctx.reportCompleted(), false);
      }
      if (mode === "reject") return Promise.reject(new Error("Producer failed"));
      if (mode === "throw" || mode === "report-then-throw") throw new Error("Producer failed");
    });
    f.admission.reportCompleted = () => {
      reportCalls++;
      if (mode === "report-lost") throw new Error("Report lost");
      return mode === "report-then-throw";
    };
    try {
      const issue = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedExtensionCommand(f.prepared, [f.message], f.ctx, f.admission);
      assert.ok(issue);
      if (["throw", "reject", "report-then-throw"].includes(mode)) await assert.rejects(issue(), /Producer failed/);
      else await issue();
      await issue();
      assert.equal(calls, 1);
      assert.equal(reportCalls, mode.startsWith("report") ? 1 : 0);
      assert.deepEqual(f.effects, []);
    } finally { f.cleanup(); }
  });

for (const loss of ["source", "recipient", "registration", "context"] as const)
  for (const boundary of ["preparation", "issuance", "await"] as const)
    test(`Selected extension execution fences ${loss} at ${boundary}`, async () => {
      let calls = 0, release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const f = await createSelectedExtensionExecutionFixture(async ctx => {
        calls++; await held;
        assert.throws(ctx.assertCurrent, /changed|revoked|context/i);
        ctx.reportCompleted();
      });
      const revoke = () => {
        if (loss === "source") f.revokeSource();
        if (loss === "recipient") f.revokeRecipient();
        if (loss === "registration") f.dispose();
        if (loss === "context") f.replaceContext();
      };
      try {
        if (boundary === "preparation") revoke();
        const issue = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedExtensionCommand(f.prepared, [f.message], f.ctx, f.admission);
        if (boundary === "preparation") { assert.equal(issue, undefined); return; }
        assert.ok(issue);
        if (boundary === "issuance") revoke();
        const pending = issue();
        if (boundary === "await") { await issue(); assert.equal(calls, 1); revoke(); release(); }
        await assert.rejects(pending, /changed|revoked|context/i);
        await issue();
        assert.equal(calls, boundary === "await" ? 1 : 0);
        assert.equal(f.reports(), 0);
      } finally { release(); f.cleanup(); }
    });

test("Selected extension command leaf refuses groups and generated branch without effects", async () => {
  const f = await createSelectedExtensionExecutionFixture(() => assert.fail("No execution"));
  try {
    const owner = createTelegramCommandHandlerTargetRuntime(f.deps);
    assert.equal(owner.prepareSelectedExtensionCommand(f.prepared, [], f.ctx, f.admission), undefined);
    assert.equal(owner.prepareSelectedExtensionCommand(f.prepared, [f.message, f.message], f.ctx, f.admission), undefined);
    assert.equal(owner.prepareSelectedExtensionCommand({ ...f.prepared, plan: { kind: "generated-prompt", prompt: "exact" } }, [f.message], f.ctx, f.admission), undefined);
    assert.deepEqual(f.effects, []);
    assert.equal(f.reports(), 0);
  } finally { f.cleanup(); }
});

for (const mode of ["current", "response-loss", "registration-loss", "context-loss", "failed"] as const)
  test(`Selected extension replies retain recipient-only rendered/direct authority (${mode})`, async () => {
    let execution!: SelectedCommandExecution;
    const f = await createSelectedExtensionExecutionFixture(ctx => { execution = ctx; ctx.reportCompleted(); });
    resetTransportReplyDedup();
    const originalFetch = globalThis.fetch, networkFamily = process.env.PI_TELEGRAM_NETWORK_FAMILY;
    delete process.env.PI_TELEGRAM_NETWORK_FAMILY;
    const requests: Record<string, unknown>[] = [], ownership: number[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body))); await held;
      if (mode === "failed") throw new Error("Supplied delivery failure");
      if (mode === "response-loss") f.revokeRecipient();
      if (mode === "registration-loss") f.dispose();
      if (mode === "context-loss") f.replaceContext();
      return new Response(JSON.stringify({ ok: true, result: { message_id: requests.length } }));
    };
    const api = createDefaultTelegramBridgeApiRuntime({ getBotToken: () => "123:fixture", recordRuntimeEvent() {} });
    const rendered = createTelegramRenderedMessageDeliveryRuntime<unknown>({
      renderTelegramMessage: () => [{ text: "first" }, { text: "tail" }],
      sendMessage: api.sendMessage, editMessage: api.editMessageText, sendRichMessage: api.sendRichMessage,
      recordOwnership({ messageId }) { ownership.push(messageId); },
    });
    let finishDelivery!: () => void;
    const delivered = new Promise<void>(resolve => { finishDelivery = resolve; });
    f.deps.sendTextReply = async (...args) => {
      try { await rendered.sendTextReply(...args); } finally { finishDelivery(); }
    };
    try {
      const issue = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedExtensionCommand(f.prepared, [f.message], f.ctx, f.admission);
      assert.ok(issue); await issue();
      // Neither a disposed original, carrier drift nor an ended chooser may cancel this reply.
      f.message.chat.id = 99; f.message.message_thread_id = 88; f.message.message_id = 77;
      execution.reply("exact reply");
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.chat_id, 7);
      assert.equal(requests[0]?.message_thread_id, 41);
      assert.deepEqual(requests[0]?.reply_parameters, { message_id: 11, allow_sending_without_reply: true });
      release();
      await delivered;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.reports(), 1);
      assert.equal(requests.length, mode === "current" ? 2 : 1);
      assert.deepEqual(ownership, mode === "current" ? [1, 2] : []);
      assert.equal(f.diagnostics.length, mode === "current" ? 0 : 1);
    } finally {
      release(); globalThis.fetch = originalFetch;
      if (networkFamily === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY; else process.env.PI_TELEGRAM_NETWORK_FAMILY = networkFamily;
      f.cleanup(); resetTransportReplyDedup();
    }
  });

for (const mode of ["current", "save-retry", "no-owner", "no-native", "wrong-command", "plan-refused", "plan-throw", "owner-replaced", "plan-replaced", "target-mismatch", "drop-branch", "local-lost", "release-lost", "execute-lost", "ack-lost", "peek-recipient", "source-stopped", "getter-copy", "proof-wrong", "proof-missing", "proof-copy", "ipc-current", "ipc-lost", "ipc-late", "ipc-wrong-source", "ipc-execute-lost", "ipc-ack-lost", "ipc-recipient-lost", "ipc-recipient-late", "captured-recipient", "captured-recipient-disposed"] as const) {
  test(`Captured status peer composes native save/apply/release with independent warm ACK (${mode})`, async () => {
    await withWorkspaceRestoreFixture(async w => {
      w.request.source.updateIds = [100];
      const f = createFencedCommandTargetFixture(), registration = createTelegramBusFollowerRegistrationState();
      const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: ["live-thread-rebind-save-v1", "live-thread-rebind-apply-v1", "live-thread-rebind-settle-v1", "live-thread-rebind-command-set-v1", "selected-menu-delivery-v1"] });
      registration.setRegistered(true, w.request.binding.target, { slot: "A", generation: "registration", leaderProtocol: protocol });
      const options = { path: `${w.path}.recipient.json`, botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "fixture" }) }, journal = createTelegramUpdateJournalStore(options), key = createTelegramUpdateJournalBindingKey(options);
      let defaults = 0, prepares = 0, getters = 0, appends = 0, removals = 0, menus = 0, applications = 0, available = true, recipientAvailable = true, observingQuery = false;
      let worker!: ReturnType<typeof createTelegramUpdateWorkerRuntime<typeof f.ctx>>;
      const lifecycle = createTelegramUpdateAdmissionLifecycleRuntime<typeof f.ctx>({ resolveBinding: () => ({ runtimeKey: "status-peer", recoveryKey: key,
        journal: { ...journal, appendBatch(updates) { appends++; return journal.appendBatch(updates); }, removeCompletedExact(...args: Parameters<typeof journal.removeCompletedExact>) {
          removals++; const result = journal.removeCompletedExact(...args); if (mode === "ack-lost" || mode === "ipc-ack-lost") throw new Error("ACK lost"); return result;
        } } }), createWorker(source) {
        const deps = { journal: source, getJournalBindingKey: () => key, hasAuthority: () => true, isContextCurrent: (ctx: typeof f.ctx) => ctx === f.ctx,
          getQueueOwnerIdentity: () => ({ instanceId: "old", processId: process.pid, processBirthId: `${process.pid}:peer`, sessionGeneration: 1 }) };
        return worker = mode === "no-native" ? createTelegramUpdateWorkerRuntime({ ...deps, executeUpdate() { defaults++; return { kind: "complete" }; } })
          : createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate, typeof f.ctx>({ ...deps, async defaultHandle() { defaults++; } });
      } });
      let recipient = () => {
        const intent = w.store.listLiveRebindings()[0];
        if (!available || !recipientAvailable || !intent || intent.phase !== "released") throw new Error("Recipient unavailable");
        assert.deepEqual(registration.getTarget(), w.request.target);
      };
      f.deps.getAllowedUserId = () => 7; f.deps.assertExecutionCurrent = () => { if (!available) throw new Error("Source stale"); };
      f.deps.showStatus = async (_chat, _reply, _ctx, thread, options) => { menus++; assert.equal(thread, w.request.target.threadId); assert.equal(options?.assertAuthority, recipient); };
      const commands = createTelegramCommandHandlerTargetRuntime(f.deps);
      let plan: ReturnType<typeof commands.prepareHeldCommand>;
      const owner = { isCurrent: () => available, assertRecipientCurrent: recipient,
        prepare(readiness: Parameters<typeof commands.prepareHeldCommand>[1], ctx: typeof f.ctx, input: Parameters<typeof commands.prepareHeldCommand>[3]) {
          prepares++; if (mode === "plan-refused") return undefined; if (mode === "plan-throw") throw new Error("Preparation return lost");
          plan = commands.prepareHeldCommand("status", readiness, ctx, input);
          if (plan && (mode === "execute-lost" || mode === "ipc-execute-lost")) { const execute = plan.execute; plan.execute = async () => { await execute(); throw new Error("Execution return lost"); }; }
          return plan;
        } };
      const targetOwner = createTelegramBusFollowerWorkspaceRestoreHandler({ instanceId: "old", getContextAuthority: () => ({ executor: w.auth.executor,
        profileBindingKey: "scope", operatorUserId: 7, cwd: "/repo", sessionId: "session", generation: 1, leaderProtocol: protocol }),
        readRestoreIntent: () => undefined, readLiveRebindIntent: () => w.store.listLiveRebindings()[0], topicTargetStore: w.threads,
        registrationState: { ...registration, setRegistered(...args) { applications++; registration.setRegistered(...args); if (mode === "local-lost") throw new Error("Local reply lost"); } },
        getWorkspaceAdmission: () => createTelegramWorkspaceAdmissionLedger({ path: `${w.path}.status-admission`, profileKey: "scope",
          owner: { processId: process.pid, processBirthId: `${process.pid}:status` }, getProcessLiveness: () => "alive" }) });
      if (mode.startsWith("captured-recipient")) {
        const captured = targetOwner.prepareLiveCommandRecipient({ operationId: w.request.operationId, registrationGeneration: "registration", sessionId: "session", sourceUpdateIds: [100], target: w.request.target }, f.ctx);
        assert.ok(captured); assert.equal(captured.isCurrent(), true); assert.throws(captured.assertRecipientCurrent, /released intent/);
        recipient = captured.assertRecipientCurrent; owner.assertRecipientCurrent = recipient; owner.isCurrent = captured.isCurrent;
      }
      const peer = createTelegramBusFollowerLiveRebindRuntime({ getAdmission: () => lifecycle,
        getCommandOwner(input) { getters++; if (mode === "no-owner" || parseTelegramCommand((input.updates[0]!.message as Record<string, unknown>).text as string)?.name !== "status") return undefined;
          if (mode === "getter-copy") { input.selectedCommand!.target.threadId = 99; input.updates[0]!.message = { text: "/abort" }; }
          return owner;
        }, async applyTarget(input, ctx) { const result = await targetOwner(input, ctx); if (mode === "release-lost" && input.liveRebind?.release) throw new Error("Release reply lost");
          if (observingQuery && mode === "ipc-recipient-late") recipientAvailable = false;
          return result; } });
      const envelope = { kind: "leader.prepareLiveRebind" as const, requestId: "save", recipientInstanceId: "old", recipientRegistrationGeneration: "registration", recipientSessionId: "session",
        recipientBindingKey: key, operationId: w.request.operationId, selectedCommand: { name: "status" as const, target: { ...w.request.target } }, sentAtMs: 1000,
        updates: [{ update_id: 100, message: { message_id: 11, message_thread_id: w.request.target.threadId, chat: { id: 7, type: "private" }, from: { id: 7, is_bot: false }, text: mode === "wrong-command" ? "/model" : "/status" } }] };
      const fields = { requestId: "apply", recipientInstanceId: "old", recipientRegistrationGeneration: "registration", recipientSessionId: "session", recipientBindingKey: key,
        operationId: w.request.operationId, sourceUpdateIds: [100], preparedSource: undefined as TelegramBusPreparedCommandSource | undefined,
        selectedCommand: { name: "status" as const, target: { ...w.request.target } }, sentAtMs: 1000 };
      const apply = { ...fields, kind: "leader.applyLiveRebind" as const, mode: "apply" as const }, release = { ...fields, kind: "leader.settleLiveRebind" as const, mode: "release" as const };
      await lifecycle.onSessionStart(f.ctx); await worker.waitForDrain();
      try {
        const refusal = ["no-owner", "no-native", "wrong-command", "plan-refused", "plan-throw"].includes(mode);
        if (refusal) { assert.throws(() => peer.save(envelope, f.ctx, () => true)); assert.equal(appends, ["plan-refused", "plan-throw"].includes(mode) ? 1 : 0);
          if (prepares) { assert.throws(() => peer.save(envelope, f.ctx, () => true)); assert.equal(prepares, 1); }
          assert.equal(defaults, 0); assert.equal(menus, 0); assert.equal(applications, 0); return; }
        const saved = peer.save(envelope, f.ctx, () => true); assert.deepEqual(saved.selectedCommand, fields.selectedCommand);
        assert.ok(saved.preparedSource); assert.deepEqual(saved.preparedSource, plan!.source);
        apply.preparedSource = { ...saved.preparedSource }; release.preparedSource = { ...saved.preparedSource };
        if (mode === "save-retry") assert.deepEqual(peer.save(envelope, f.ctx, () => true), saved);
        assert.equal(prepares, 1); assert.equal(getters, 1); assert.equal(appends, 1); assert.equal(menus, 0); assert.equal(defaults, 0);
        const before = readFileSync(options.path, "utf8");
        if (mode === "proof-wrong") apply.preparedSource!.sourceSha256 = "f".repeat(64);
        if (mode === "proof-missing") apply.preparedSource = undefined;
        if (mode === "proof-copy") saved.preparedSource!.sourceSha256 = "f".repeat(64);
        if (mode === "owner-replaced") owner.prepare = () => undefined;
        if (mode === "plan-replaced") plan!.execute = async () => true;
        const committed = (await w.store.commitLiveRebind(w.request, { kind: "follower", instanceId: "old", sessionId: "session", generation: "registration" }, w.auth))!;
        if (["owner-replaced", "plan-replaced", "target-mismatch", "drop-branch", "proof-wrong", "proof-missing"].includes(mode)) {
          await assert.rejects(peer.apply({ ...apply, selectedCommand: mode === "drop-branch" ? undefined : mode === "target-mismatch" ? { name: "status", target: { chatId: 7, threadId: 99 } } : apply.selectedCommand }, f.ctx, () => true));
          assert.equal(applications, 0); assert.equal(readFileSync(options.path, "utf8"), before); assert.equal(defaults, 0); return;
        }
        if (mode === "local-lost") { await assert.rejects(peer.apply(apply, f.ctx, () => true)); assert.equal((await peer.apply({ ...apply, mode: "inspect" }, f.ctx, () => true)).status, "applied"); }
        else assert.equal((await peer.apply(apply, f.ctx, () => true)).status, "applied");
        assert.equal(applications, 1); assert.equal(menus, 0); assert.equal(readFileSync(options.path, "utf8"), before);
        w.store.advanceLiveRebind(committed, "release", w.auth);
        if (mode === "release-lost") await assert.rejects(peer.settle(release, f.ctx, () => true)); else assert.equal((await peer.settle(release, f.ctx, () => true)).status, "released");
        await worker.waitForDrain(); await new Promise(resolve => setImmediate(resolve)); await worker.waitForDrain();
        assert.equal(defaults, 0); assert.equal(menus, 1); assert.equal(removals, 1); assert.equal(prepares, 1);
        if (mode === "source-stopped") await worker.stop();
        if (mode === "source-stopped") { await assert.rejects(peer.settle({ ...release, mode: "observe-command" }, f.ctx, () => true)); return; }
        else { const observed = await peer.settle({ ...release, mode: "observe-command" }, f.ctx, () => true);
          assert.ok(observed.status === "command-observed");
          assert.equal(observed.command, mode === "execute-lost" || mode === "ipc-execute-lost" ? "unknown" : "completed");
          assert.equal(!!observed.sourceAck, mode !== "ack-lost" && mode !== "ipc-ack-lost");
          if (mode === "peek-recipient") await assert.rejects(peer.settle({ ...release, mode: "observe-command", recipientSessionId: "other" }, f.ctx, () => true)); }
        if (mode.startsWith("ipc-")) {
          const socketPath = getTelegramBusFollowerSocketPath("old", dirname(w.path)); let observations = 0, dropped = false;
          const receive = createTelegramBusForwardedUpdateReceiverRuntime({ socketPath, instanceId: "old", getAuthSecret: () => "secret", getRegistrationGeneration: () => "registration",
            getRecipientBindingKey: () => "manual:old", getLiveRebindJournalBindingKey: () => key, getSessionId: () => "session", getContext: () => f.ctx,
            getLeaderProtocol: () => protocol, getLocalProtocol: () => protocol, isLiveRebindSaveEnabled: () => true, isLiveRebindApplyEnabled: () => true,
            isLiveRebindSettleEnabled: () => true, isLiveRebindCommandSetEnabled: () => available, handleLiveRebindSave: peer.save, handleLiveRebindApply: peer.apply,
            async handleLiveRebindSettle(envelope, ctx, current) { observations++; const result = await peer.settle(envelope, ctx, current);
              if (mode === "ipc-late") available = false;
              return mode === "ipc-wrong-source" && "sourceAck" in result ? { ...result, sourceAck: { ...result.sourceAck!, sourceSha256: "f".repeat(64) } } : result;
            }, durableAdmission: { async admit() { assert.fail("Observation cannot enter ordinary admission"); } } });
          const server = mode === "ipc-lost" ? createTelegramBusLocalServer({ socketPath, async handleEnvelope(envelope: TelegramBusEnvelope) {
            assert.equal(envelope.kind, "leader.settleLiveRebind"); if (envelope.kind !== "leader.settleLiveRebind") throw new Error("Wrong query");
            observations++; const result = await peer.settle(envelope, f.ctx, () => true); if (!dropped) { dropped = true; return undefined; }
            return { kind: "bus.ack", requestId: envelope.requestId, ok: true, result };
          } }) : receive;
          let observationId = 0;
          const control = createTelegramBusLiveRebindController({ getFollower: () => ({ instanceId: "old", sessionId: "session", registrationGeneration: "registration", slot: "A", cwd: "/repo",
            pid: process.pid, processBirthId: `${process.pid}:status`, sessionGeneration: 1, busSocketPath: socketPath, target: registration.getTarget(), protocol, connectedAtMs: 1, lastHeartbeatMs: 1 }),
            localProtocolIdentity: protocol, getAuthSecret: () => "secret", createRequestId: () => `observe-command-${++observationId}`, timeoutMs: 250 });
          const query = { operationId: w.request.operationId, instanceId: "old", sessionId: "session", recipientBindingKey: key, isCurrent: () => true, mode: "observe-command" as const,
            sourceUpdateIds: [100], slot: "A", target: w.request.target, oldTarget: w.request.binding.target, selectedCommand: release.selectedCommand, preparedSource: release.preparedSource };
          const sourceBefore = readFileSync(options.path, "utf8"); observingQuery = true;
          if (mode === "ipc-recipient-lost") recipientAvailable = false;
          try { await server.start(); if (mode === "ipc-lost") await assert.rejects(control(query), /Timed out|closed/);
            const result = await control(query);
            if (["ipc-late", "ipc-wrong-source", "ipc-recipient-lost", "ipc-recipient-late"].includes(mode)) assert.equal(result, undefined);
            else { assert.equal(result?.status, "command-observed"); if (result?.status === "command-observed") {
              assert.equal(result.command, mode === "ipc-execute-lost" ? "unknown" : "completed"); assert.equal(!!result.sourceAck, mode !== "ipc-ack-lost"); } }
            assert.equal(observations, mode === "ipc-lost" ? 2 : 1); assert.equal(prepares, 1); assert.equal(appends, 1); assert.equal(applications, 1); assert.equal(menus, 1); assert.equal(removals, 1);
            assert.equal(readFileSync(options.path, "utf8"), sourceBefore);
          } finally { await server.stop(); }
          if (mode === "ipc-late" || mode === "ipc-recipient-lost" || mode === "ipc-recipient-late") return;
        }
        assert.equal((await peer.settle(release, f.ctx, () => true)).status, "released"); assert.equal(menus, 1); assert.equal(removals, 1);
        if (mode === "captured-recipient-disposed") { await worker.stop(); recipient(); assert.equal(plan!.inspectCompletion(), undefined); }
        else if (mode === "captured-recipient") recipient();
      } finally { await lifecycle.onSessionShutdown(); }
    }, "follower");
  });
}

test("Held command registry refuses unsupported names and unavailable declared effects before reading a source", () => {
  const f = createFencedCommandTargetFixture(), commands = createTelegramCommandHandlerTargetRuntime(f.deps);
  const unreadable = { get snapshot() { return assert.fail("Rejected preparation cannot read or hold a source"); } } as unknown as Parameters<typeof commands.prepareHeldCommand>[1];
  const admission = { target: { chatId: 7, threadId: 42 }, assertSourceCurrent() { assert.fail("Preparation cannot execute"); },
    assertRecipientCurrent() { assert.fail("Preparation cannot activate a recipient"); } };
  for (const name of ["__proto__", "constructor", "extension", "stop", "continue"]) {
    assert.equal(commands.canPrepareHeldCommand(name), false);
    assert.equal(commands.prepareHeldCommand(name, unreadable, f.ctx, admission), undefined);
  }
  const effects = { showStatus: f.deps.showStatus, sendTextReply: f.deps.sendTextReply };
  for (const name of ["status", "abort"] as const) {
    for (const invalid of [null, {}, { [name === "status" ? "sendTextReply" : "showStatus"]: effects[name === "status" ? "sendTextReply" : "showStatus"] }]) {
      assert.equal(commands.canPrepareHeldCommand(name, invalid as Parameters<typeof commands.prepareHeldCommand>[4]), false);
      assert.equal(commands.prepareHeldCommand(name, unreadable, f.ctx, admission, invalid as Parameters<typeof commands.prepareHeldCommand>[4]), undefined);
    }
  }
  assert.equal(commands.canPrepareHeldCommand("abort"), false);
  assert.equal(commands.canPrepareHeldCommand("status"), true);
  for (const name of ["status", "abort"]) assert.equal(commands.canPrepareHeldCommand(name, effects), true);
  assert.equal(commands.prepareHeldCommand("abort", unreadable, f.ctx, admission), undefined);
  assert.deepEqual(f.effects, []);
});

test("Held control registry refuses incomplete semantic ports before source observation", () => {
  const f = createFencedCommandTargetFixture();
  const unavailable = () => assert.fail("Registry availability cannot execute command semantics or delivery");
  const effects = { sendTextReply: async () => unavailable() };
  const complete = { ...f.deps, cancelNextTransitionAnnouncements: unavailable,
    requestNextDispatchAnnouncement: unavailable, markActiveTurnNextAbortAnnouncement: unavailable };
  const unreadable = { get snapshot() { return assert.fail("Incomplete composition cannot read or hold a source"); } } as unknown as Parameters<ReturnType<typeof createTelegramCommandHandlerTargetRuntime>["prepareHeldCommand"]>[1];
  const admission = { target: { chatId: 7, threadId: 42 }, assertSourceCurrent: unavailable, assertRecipientCurrent: unavailable };
  for (const name of ["stop", "next"] as const) {
    assert.equal(createTelegramCommandHandlerTargetRuntime(complete).canPrepareHeldCommand(name, effects), true);
    const ports = name === "stop" ? ["cancelNextTransitionAnnouncements", "clearQueuedTelegramItems"] : ["requestNextDispatchAnnouncement", "markActiveTurnNextAbortAnnouncement"];
    for (const port of ports) {
      const deps = { ...complete }; Reflect.deleteProperty(deps, port);
      const handler = createTelegramCommandHandlerTargetRuntime(deps);
      assert.equal(handler.canPrepareHeldCommand(name, effects), false);
      assert.equal(handler.prepareHeldCommand(name, unreadable, f.ctx, admission, effects), undefined);
    }
  }
  assert.deepEqual(f.effects, []);
});

for (const name of ["status", "start", "help", "abort"] as const) for (const fault of ["current", "completion-refused", "effect-lost"] as const) {
  test(`Held command registry preserves native completion ordering and detached effects (${name}, ${fault})`, async () => {
    const f = createFencedCommandTargetFixture(), dir = mkdtempSync(join(tmpdir(), "pi-held-command-registry-"));
    const options = { path: join(dir, "journal.json"), botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "fixture" }) };
    const journal = createTelegramUpdateJournalStore(options), binding = createTelegramUpdateJournalBindingKey(options), target = { chatId: 7, threadId: 42 };
    let ordinary = 0, recipientCurrent = false;
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate, typeof f.ctx>({ journal,
      getJournalBindingKey: () => binding, hasAuthority: () => true, isContextCurrent: () => true,
      getQueueOwnerIdentity: () => ({ instanceId: "recipient", processId: process.pid, processBirthId: `${process.pid}:registry`, sessionGeneration: 1 }),
      async defaultHandle() { ordinary++; assert.fail("A held command cannot replay through the ordinary handler"); } });
    worker.start(f.ctx);
    try {
      await worker.waitForDrain();
      const held = worker.prepareLiveInput!(f.ctx, [100])!;
      journal.appendBatch([{ update_id: 100, message: { ...f.message, text: `/${name}`, message_thread_id: 10 } }]);
      worker.signal(); await worker.waitForDrain(); assert.equal(held.confirmSaved(), true);
      const readiness = held.prepareSourceCompletion!()!, bind = readiness.bindCarrier;
      readiness.bindCarrier = value => {
        const completion = bind(value);
        return completion && { ...completion, reportCompleted() {
          f.effects.push("complete");
          return fault === "completion-refused" ? false : completion.reportCompleted();
        } };
      };
      const assertRecipientCurrent = () => { if (!recipientCurrent) throw new Error("Recipient is not released"); };
      f.deps.assertExecutionCurrent = assertTelegramUpdateExecutionCurrent;
      f.deps.showStatus = async () => assert.fail("A supplied menu cannot fall back to ordinary delivery");
      f.deps.sendTextReply = async () => assert.fail("A supplied reply cannot fall back to ordinary delivery");
      const commands = createTelegramCommandHandlerTargetRuntime(f.deps);
      const effects = { async showStatus() { assertRecipientCurrent(); f.effects.push("status"); if (fault === "effect-lost") throw new Error("Effect reply lost"); },
        async sendTextReply() { assertRecipientCurrent(); f.effects.push("reply"); if (fault === "effect-lost") throw new Error("Effect reply lost"); } };
      const plan = commands.prepareHeldCommand(name, readiness, f.ctx, { target, assertSourceCurrent() {}, assertRecipientCurrent }, effects);
      assert.ok(plan); assert.deepEqual(f.effects, []); assert.equal(plan.inspectCompletion(), undefined);
      assert.equal(held.prepareStatusConsumption!({ source: plan.source, assertCurrent: assertRecipientCurrent, bindCarrier: plan.bindCarrier, execute: plan.execute }), true);
      recipientCurrent = true; assert.equal(held.release(() => true), true);
      await worker.waitForDrain(); await new Promise(resolve => setImmediate(resolve)); await worker.waitForDrain();
      const semantics = name === "abort" ? ["clear-model", "fold", "abort", "update"] : [];
      assert.deepEqual(f.effects, [...semantics, "complete", ...(fault === "completion-refused" ? [] : [name === "abort" ? "reply" : "status"])]);
      assert.equal(ordinary, 0);
      assert.deepEqual(plan.inspectCompletion(), fault === "completion-refused" ? undefined : readiness.snapshot.source);
      assert.equal(journal.read().entries.length, fault === "completion-refused" ? 1 : 0);
      assert.equal(await plan.execute(), false); assert.equal(ordinary, 0);
    } finally { await worker.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const mode of ["current", "snapshot-copy", "target-copy", "callback-copy", "before-bind", "source-loss", "recipient-loss", "operator-loss", "changed", "cold", "report-lost", "ack-lost", "other-command", "caption", "album", "control", "bot", "foreign", "group", "no-guard", "report-owner", "inspect-owner", "readiness-owner", "mixed", "bad-target", "native-consumption", "scoped-menu", "scoped-menu-owner", "scoped-menu-missing", "scoped-menu-null"] as const) {
  test(`Held status command captures a pre-binding plan without dispatch/replay (${mode})`, async () => {
    const f = createFencedCommandTargetFixture(), dir = mkdtempSync(join(tmpdir(), "pi-held-status-plan-"));
    const options = { path: join(dir, "journal.json"), botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "fixture" }) }, journal = createTelegramUpdateJournalStore(options);
    const binding = createTelegramUpdateJournalBindingKey(options), target = { chatId: 7, threadId: 42 };
    let carrier: unknown, boundCompletion: TelegramDeferredSourceCompletionPreparation | undefined, defaultCalls = 0, removes = 0, semantic = 0, reports = 0, sourceCurrent = true, recipientCurrent = false, operator = 7;
    const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate, typeof f.ctx>({
      journal: { ...journal, removeCompletedExact(...args: Parameters<typeof journal.removeCompletedExact>) { removes++; const result = journal.removeCompletedExact(...args); if (mode === "ack-lost") throw new Error("ACK lost"); return result; } },
      getJournalBindingKey: () => binding, hasAuthority: () => true, isContextCurrent: () => true,
      getQueueOwnerIdentity: () => ({ instanceId: "recipient", processId: process.pid, processBirthId: `${process.pid}:held-status`, sessionGeneration: 1 }),
      async defaultHandle(update) { defaultCalls++; carrier = update.message; reportTelegramUpdateDeferred(carrier); } });
    worker.start(f.ctx); await worker.waitForDrain();
    const held = worker.prepareLiveInput!(f.ctx, mode === "group" ? [100, 101] : [100])!; assert.ok(held);
    const message: Record<string, unknown> = { message_id: 100, chat: { id: 7, type: "private" }, from: { id: mode === "foreign" ? 8 : 7, is_bot: mode === "bot" }, message_thread_id: 10,
      text: mode === "other-command" ? "/model" : mode === "control" ? "/continue" : "/status@fixture retained args" };
    if (mode === "caption") { delete message.text; message.caption = "/status"; }
    if (mode === "album") message.media_group_id = "album";
    const update = { update_id: 100, message, ...(mode === "mixed" ? { callback_query: { id: "mixed" } } : {}) };
    if (mode === "bad-target") target.threadId = 0;
    journal.appendBatch(mode === "group" ? [update, { ...update, update_id: 101 }] : [update]); worker.signal(); await worker.waitForDrain(); assert.equal(defaultCalls, 0);
    assert.equal(held.confirmSaved(), true);
    const readiness = held.prepareSourceCompletion?.();
    if (["report-owner", "inspect-owner"].includes(mode) && readiness) {
      const bind = readiness.bindCarrier;
      readiness.bindCarrier = value => { boundCompletion = bind(value); return boundCompletion; };
    }
    if (mode === "report-lost" && readiness) {
      const bind = readiness.bindCarrier;
      readiness.bindCarrier = value => { const completion = bind(value); return completion && { ...completion, reportCompleted() {
        reports++; completion.reportCompleted(); throw new Error("Report reply lost");
      } }; };
    }
    f.deps.getAllowedUserId = () => operator;
    f.deps.assertExecutionCurrent = value => { assert.equal(value, carrier); if (!sourceCurrent) throw new Error("Original authority lost"); };
    f.deps.showStatus = async (chat, _reply, ctx, thread, options) => { semantic++; assert.deepEqual([chat, ctx, thread], [7, f.ctx, 42]); assert.equal(options?.assertAuthority, assertRecipient); };
    const assertRecipient = () => { if (!recipientCurrent) throw new Error("Recipient is not applied"); };
    const guards = { target, assertSourceCurrent() { if (!sourceCurrent) throw new Error("Source lost"); }, assertRecipientCurrent: assertRecipient };
    if (mode === "no-guard") Reflect.deleteProperty(guards, "assertRecipientCurrent");
    const before = readFileSync(options.path, "utf8");
    const owner = createTelegramCommandHandlerTargetRuntime(f.deps);
    const menu = { showStatus: f.deps.showStatus };
    if (mode.startsWith("scoped-menu")) f.deps.showStatus = async () => { assert.fail("Scoped menu must not use ordinary Root dispatch"); };
    const scopedMenu = mode === "scoped-menu-null" ? null as unknown as typeof menu : mode === "scoped-menu-missing" ? {} as typeof menu : mode.startsWith("scoped-menu") ? menu : undefined;
    const plan = readiness && owner.prepareHeldCommand("status", readiness, f.ctx, guards, scopedMenu);
    try {
      assert.equal(defaultCalls, 0); assert.equal(semantic, 0); assert.equal(removes, 0); assert.equal(readFileSync(options.path, "utf8"), before);
      if (mode === "scoped-menu-missing" || mode === "scoped-menu-null") { assert.equal(plan, undefined); return; }
      const refuses = ["other-command", "caption", "album", "control", "bot", "foreign", "group", "no-guard", "mixed", "bad-target"].includes(mode);
      if (refuses) { assert.equal(plan, undefined); return; }
      assert.ok(plan); assert.deepEqual(plan.command, { name: "status", args: "retained args" });
      assert.equal(plan.inspectCompletion(), undefined); assert.equal(plan.bindCarrier({}), false);
      if (mode === "snapshot-copy") { const copy = readiness!.snapshot; (copy.update.message as Record<string, unknown>).text = "/abort"; copy.source.sourceSha256 = "f".repeat(64); }
      if (mode === "target-copy") target.threadId = 99;
      if (mode === "callback-copy") guards.assertRecipientCurrent = () => { throw new Error("Replacement cannot enter plan"); };
      if (mode === "before-bind") { await assert.rejects(plan.execute()); assert.equal(semantic, 0); return; }
      if (mode === "native-consumption") {
        const consume = { source: plan.source, assertCurrent: assertRecipient, bindCarrier(value: unknown) { carrier = value; return plan.bindCarrier(value); }, execute: plan.execute };
        assert.equal(held.prepareStatusConsumption?.(consume), true); assert.equal(defaultCalls, 0); assert.equal(semantic, 0);
        recipientCurrent = true; assert.equal(held.release(() => true), true);
        await worker.waitForDrain(); await new Promise(resolve => setImmediate(resolve)); await worker.waitForDrain();
        assert.equal(defaultCalls, 0); assert.equal(semantic, 1); assert.equal(removes, 1);
        assert.deepEqual(plan.inspectCompletion(), readiness!.snapshot.source); assert.equal(await plan.execute(), false);
        return;
      }
      assert.equal(held.release(() => true), true); await worker.waitForDrain(); assert.equal(defaultCalls, 1);
      if (mode === "cold") { await worker.stop(); worker.start(f.ctx); await worker.waitForDrain(); assert.equal(plan.bindCarrier(carrier), false); return; }
      assert.equal(plan.bindCarrier(carrier), true); assert.equal(plan.bindCarrier(carrier), true); assert.equal(plan.bindCarrier({}), false);
      recipientCurrent = true;
      if (mode === "scoped-menu-owner") menu.showStatus = async () => { assert.fail("Never adopt a new menu owner"); };
      if (mode === "report-owner") boundCompletion!.reportCompleted = () => true;
      if (mode === "inspect-owner") boundCompletion!.inspectCompletion = () => ({ ...readiness!.snapshot.source });
      if (mode === "readiness-owner") readiness!.bindCarrier = () => undefined;
      if (mode === "source-loss") sourceCurrent = false;
      if (mode === "recipient-loss") recipientCurrent = false;
      if (mode === "operator-loss") operator = 8;
      if (mode === "changed") journal.markExecutionFailure({ updateId: 100, expectedAttemptCount: 0, failedAtMs: 1, failureClass: "fixture", summary: "changed", disposition: "retry-wait", nextRetryAtMs: Date.now() + 60000 });
      const rejected = ["source-loss", "recipient-loss", "operator-loss", "changed", "report-lost", "report-owner", "inspect-owner", "readiness-owner", "scoped-menu-owner"].includes(mode);
      if (rejected) await assert.rejects(plan.execute()); else { assert.equal(await plan.execute(), true); reports++; }
      await new Promise(resolve => setImmediate(resolve)); await worker.waitForDrain(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(semantic, rejected ? 0 : 1); assert.equal(removes, rejected && mode !== "report-lost" ? 0 : 1);
      assert.deepEqual(plan.inspectCompletion(), rejected && mode !== "report-lost" || mode === "ack-lost" ? undefined : readiness!.snapshot.source);
      if (!rejected || mode === "report-lost") assert.equal(await plan.execute(), false);
      assert.equal(reports, rejected && mode !== "report-lost" ? 0 : 1);
    } finally { await worker.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const scenario of ["current", "render-loss", "response-local", "response-leader", "lost-response", "local-ownership", "publication-loss", "wrong-state", "chunks", "chunk-loss", "edit", "edit-loss", "held-current", "held-render-loss", "held-response-local", "held-chunks", "held-lost-response", "held-edit", "held-edit-loss", "held-busy", "root-current", "root-wire-scope", "root-render-loss", "root-session-loss"] as const) {
  const rootMode = scenario.startsWith("root-"), heldMode = rootMode || scenario.startsWith("held-"), mode = heldMode ? scenario.slice(5) : scenario;
  test(`Selected follower status composes real source disposition/menu/render/IPC owners (${scenario})`, async () => {
    await withWorkspaceRestoreFixture(async workspace => {
      const f = createFencedCommandTargetFixture(); f.message.message_thread_id = 42; f.message.message_id = 100;
      let recipientCurrent = true, leaderCurrent = true, completed = 0, stored = 0;
      const sourceOptions = { path: `${workspace.path}.journal`, botIdentity: createTelegramUpdateJournalBotIdentity({ botToken: "fixture" }) };
      const journal = createTelegramUpdateJournalStore(sourceOptions), binding = createTelegramUpdateJournalBindingKey(sourceOptions);
      let original: unknown;
      const worker = createTelegramUpdateAdmissionWorkerRuntime<TelegramJournaledUpdate, typeof f.ctx>({ journal,
        getJournalBindingKey: () => binding, hasAuthority: () => true, isContextCurrent: () => true,
        getQueueOwnerIdentity: () => ({ instanceId: "old", processId: process.pid, processBirthId: `${process.pid}:follower`, sessionGeneration: 1 }),
        async defaultHandle(update) { if (update.update_id === 100) original = update.message; reportTelegramUpdateDeferred(update.message); } });
      worker.start(f.ctx); await worker.waitForDrain();
      const held = heldMode && !rootMode ? worker.prepareLiveInput!(f.ctx, [100]) : undefined;
      journal.appendBatch((rootMode ? [101] : [100, 101]).map(update_id => ({ update_id, message: { message_id: update_id, chat: { id: 7, type: "private" },
        ...(heldMode ? { from: { id: 7, is_bot: false } } : {}), message_thread_id: 10, text: "/status" } })));
      worker.signal(); await worker.waitForDrain();
      if (heldMode && !rootMode) { assert.ok(held); assert.equal(held.confirmSaved(), true); }
      const readiness = held?.prepareSourceCompletion?.();
      let source = rootMode ? undefined : heldMode ? readiness!.snapshot.source : inspectTelegramDeferredSource(original)!;
      if (!rootMode) assert.ok(source);
      const completion = heldMode ? undefined : prepareTelegramDeferredSourceCompletion(original)!;
      if (!heldMode) { assert.ok(completion); assert.equal(completion.inspectCompletion(), undefined); }
      const neighbor = journal.read().entries.find(value => value.update.update_id === 101);
      workspace.request.source = { journalBindingKey: binding, updateIds: [100] };
      const releaseBinding = async () => {
        const operation = (await workspace.store.commitLiveRebind(workspace.request, { kind: "follower", instanceId: "old", sessionId: "session", generation: "registration" }, workspace.auth))!;
        workspace.store.advanceLiveRebind(operation, "release", workspace.auth);
      };
      if (!heldMode) await releaseBinding();
      let initial = readFileSync(workspace.path, "utf8");
      const protocol = createTelegramBusProtocolIdentity({ runtimeBuild: "fixture", capabilities: rootMode ? ["live-thread-rebind-save-v1", "live-thread-rebind-apply-v1", "live-thread-rebind-settle-v1", "live-thread-rebind-command-set-v1", TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY] : [TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY] });
      const registry = createTelegramBusFollowerRegistry();
      registry.register({ instanceId: "old", registrationGeneration: "registration", sessionId: "session", sessionGeneration: 1, pid: process.pid, processBirthId: `${process.pid}:follower`,
        profileKey: workspace.request.owner.profileKey, cwd: "/repo", slot: "A", target: workspace.request.target, protocol, connectedAtMs: 1 });
      const stateOwner = createTelegramBusFollowerRegistrationState(); stateOwner.setRegistered(true, rootMode ? workspace.request.binding.target : workspace.request.target, { slot: "A", generation: "registration", leaderProtocol: protocol });
      const ledger = createTelegramWorkspaceAdmissionLedger({ path: `${workspace.path}.menu-admission`, profileKey: "bot:menu", owner: { processId: process.pid, processBirthId: `${process.pid}:menu` }, getProcessLiveness: () => "alive" });
      const operations = createTelegramWorkspaceOperationRuntime({ getWorkspaceAdmission: () => ledger });
      const requests: Record<string, unknown>[] = [], remote: number[] = [], local: number[] = [];
      const render = Promise.withResolvers<void>(), http = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
      let sessionGeneration = 1;
      let assertRecipient = () => { if (!recipientCurrent) throw new Error("Recipient replaced"); };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (_url, init) => {
        requests.push(JSON.parse(String(init?.body))); assert.ok(ledger.read().leases.some(lease => lease.operationKind === "workspace.selected-menu-delivery"));
        entered.resolve(); await http.promise;
        if (mode === "response-local" || mode === "edit-loss" && requests.at(-1)?.message_id !== undefined) recipientCurrent = false;
        if (mode === "response-leader") leaderCurrent = false;
        if (mode === "lost-response") throw new Error("Supplied issued response lost");
        return new Response(JSON.stringify({ ok: true, result: { message_id: (requests.at(-1)?.message_id as number | undefined) ?? requests.length } }));
      };
      const direct = createDefaultTelegramBridgeApiRuntime({ getBotToken: () => "123:fixture", recordRuntimeEvent() {} });
      const ownership = createTelegramBusMessageOwnershipRuntime({ instanceId: "leader", getProfileKey: () => "fixture", listFollowers: registry.list });
      const authorize = createTelegramFollowerApiCallAuthorizer({ isMessageOwned: ownership.isOwnedByFollower });
      const leader = createTelegramBusSelectedMenuDeliveryHandler({ followerRegistry: registry, protocolIdentity: protocol,
        workspace: { getScopeKey: () => "bot:menu", captureAuthority: () => ({ ...workspace.auth, isCurrent: () => leaderCurrent }), getStore: () => workspace.store,
          threadStore: workspace.threads, getJournalBindingKey: () => binding, run: operations.run },
        api: { runtime: direct, authorize: rootMode ? authorize : () => true, record(value, assertCurrent) {
          assertCurrent(); ownership.recordFollower(value); assertCurrent(); remote.push(value.messageId);
          return rootMode ? ownership.isOwnedByFollower(value) : true;
        } } });
      const handle = createTelegramBusLeaderEnvelopeHandler({ followerRegistry: registry, authSecret: "secret", protocolIdentity: protocol, selectedMenuDelivery: leader,
        callApi() { assert.fail("No ordinary proxy"); } });
      const endpoint = join(dirname(workspace.path), "status.sock");
      const localServer = createTelegramBusLocalServer({ socketPath: endpoint, handleEnvelope: handle });
      const rootServer = rootMode ? createTelegramBusLeaderRuntime({ socketPath: endpoint, followerRegistry: registry, protocolIdentity: protocol,
        authSecret: "secret", selectedMenuDelivery: leader, isFollowerProcessAlive: () => true, startPolling() {}, stopPolling() {},
        callApi() { assert.fail("Root runtime must not borrow ordinary proxy"); } }) : undefined;
      const server = { start: () => rootServer ? rootServer.startPolling(f.ctx) : localServer.start(), stop: () => rootServer ? rootServer.stopPolling() : localServer.stop() };
      const context = createTelegramBusFollowerRestoreContextGetter<typeof f.ctx>({ capability: TELEGRAM_BUS_CAPABILITY_SELECTED_MENU_DELIVERY,
        isContextCurrent: value => recipientCurrent && value === f.ctx, getSessionId: () => "session", getCwd: () => "/repo", getGeneration: () => sessionGeneration,
        getProfileBindingKey: () => mode === "wire-scope" ? ledger.getProfileKey() : workspace.request.owner.profileKey, getOperatorUserId: () => 7, getAuthenticatedSecret: () => "secret", getLeaderProtocol: stateOwner.getLeaderProtocol,
        getLeaderState: () => ({ kind: "active-elsewhere", lock: { pid: 123, instanceId: "leader", leaderEpoch: "epoch", busSecret: "secret" } }) });
      const caller = createTelegramBusFollowerSelectedMenuCaller({ protocolIdentity: protocol,
        client: { instanceId: "old", socketPath: endpoint, getAuthSecret: () => "secret", getRegistrationGeneration: stateOwner.getGeneration, createRequestId: (() => { let id = 0; return () => `menu:${++id}`; })() },
        recipient: { getContextAuthority: context, getJournalBindingKey: () => binding, getProcessIdentity: () => ({ processId: process.pid, processBirthId: `${process.pid}:follower` }), registrationState: stateOwner } });
      const api = createTelegramSelectedMenuTextApi({ operationId: "restore", registrationGeneration: "registration", target: workspace.request.target, assertAuthority: assertRecipient,
        deliver: (effect, assertAuthority) => caller({ ctx: f.ctx, operationId: "restore", registrationGeneration: "registration", effect, assertAuthority }) });
      resetTransportReplyDedup();
      const rendered = createTelegramRenderedMessageDeliveryRuntime<unknown>({ sendMessage: api.sendMessage, editMessage: api.editMessageText,
        sendRichMessage: async () => assert.fail("No rich/native fallback"), recordOwnership({ messageId }) {
          if (mode === "local-ownership") recipientCurrent = false; assertRecipient(); local.push(messageId); if (mode === "chunk-loss") recipientCurrent = false;
        } });
      const model = { id: "fixture", provider: "fixture", reasoning: true };
      const state: TelegramModelMenuState<typeof model> = { chatId: 7, threadId: 42, messageId: 0, mode: "model", scope: "all", page: 0, scopedModels: [], allModels: [{ model }] };
      const menuPorts = { getModelMenuState: async () => { await render.promise; if (mode === "wrong-state") state.threadId = 99; return state; },
        storeModelMenuState(value: typeof state) { try { if (mode === "publication-loss") recipientCurrent = false; assertRecipient(); assert.equal(value, state); stored++; } finally { if (heldMode) finished.resolve(); } },
        buildStatusHtml: () => ["chunks", "chunk-loss"].includes(mode) ? "status ".repeat(1000) : "<b>Current session</b>", getActiveModel: () => model,
        getThinkingLevel: () => "medium" as const, isIdle: () => mode !== "busy", canOfferInFlightModelSwitch: () => false };
      const menus = createTelegramMenuActionRuntime({ ...menuPorts, sendInteractiveMessage: rendered.sendInteractiveMessage, editInteractiveMessage: rendered.editInteractiveMessage, sendTextReply: rendered.sendTextReply });
      const scopedMenu = { async showStatus(...args: Parameters<typeof menus.sendStatusMessage>) { assert.equal(this, scopedMenu);
        if (heldMode) assert.deepEqual(args, [7, 100, f.ctx, 42, { assertAuthority: assertRecipient }]);
        try { await menus.sendStatusMessage(...args); } finally { finished.resolve(); } } };
      f.deps.showStatus = heldMode ? async () => { assert.fail("Prepared scoped status cannot use ordinary root menu transport"); } : scopedMenu.showStatus.bind(scopedMenu);
      f.deps.getAllowedUserId = () => 7;
      if (heldMode) { f.deps.assertExecutionCurrent = value => { if (rootMode) original = value; assertTelegramUpdateExecutionCurrent(value); };
        const record = f.deps.recordRuntimeEvent; f.deps.recordRuntimeEvent = (...args) => { record?.(...args); finished.resolve(); }; }
      const admission = { assertSourceCurrent() { assert.deepEqual(inspectTelegramDeferredSource(original), source); assert.ok(ledger.read().leases.some(lease => lease.operationKind === "workspace.fixture-chooser")); },
        assertRecipientCurrent: assertRecipient, reportCompleted() { completed++; const accepted = completion!.reportCompleted(); f.revoke(); return accepted; } };
      await server.start();
      try {
        const commands = createTelegramCommandHandlerTargetRuntime(f.deps);
        const beforePreparation = readFileSync(sourceOptions.path, "utf8");
        let rootPlan: ReturnType<typeof commands.prepareHeldCommand>, rootPreparations = 0, rootGetters = 0;
        const targetOwner = rootMode ? createTelegramBusFollowerWorkspaceRestoreHandler({ instanceId: "old",
          getContextAuthority: createTelegramBusFollowerRestoreContextGetter<typeof f.ctx>({ capability: "live-thread-rebind-apply-v1",
            isContextCurrent: value => recipientCurrent && value === f.ctx, getSessionId: () => "session", getCwd: () => "/repo", getGeneration: () => sessionGeneration,
            getProfileBindingKey: ledger.getProfileKey, getOperatorUserId: () => 7, getAuthenticatedSecret: () => "secret", getLeaderProtocol: stateOwner.getLeaderProtocol,
            getLeaderState: () => ({ kind: "active-elsewhere", lock: { pid: 123, instanceId: "leader", leaderEpoch: "epoch", busSecret: "secret" } }) }),
          readRestoreIntent: () => undefined, readLiveRebindIntent: () => workspace.store.listLiveRebindings()[0], topicTargetStore: workspace.threads,
          registrationState: stateOwner, getWorkspaceAdmission: () => ledger }) : undefined;
        const rootCommand = { canPrepareHeldCommand: commands.canPrepareHeldCommand, prepareHeldCommand(...args: Parameters<typeof commands.prepareHeldCommand>) {
          rootPreparations++; rootPlan = commands.prepareHeldCommand(...args);
          if (rootPlan) { const execute = rootPlan.execute; rootPlan.execute = async () => { completed++; return execute(); }; }
          return rootPlan;
        } };
        const rootAdmission = { prepareLiveInput: worker.prepareLiveInput!, appendBatch: journal.appendBatch, getJournalBindingKey: () => binding };
        const peer = rootMode ? createTelegramBusFollowerLiveRebindRuntime({ getAdmission: () => rootAdmission, applyTarget: targetOwner!,
          getCommandOwner(input, ctx) {
            rootGetters++;
            const recipient = targetOwner!.prepareLiveCommandRecipient({ operationId: input.operationId, registrationGeneration: input.recipientRegistrationGeneration,
              sessionId: input.recipientSessionId, sourceUpdateIds: input.updates.map(value => value.update_id), target: input.selectedCommand!.target }, ctx);
            assert.ok(recipient); assert.equal(recipient.isCurrent(), true); assert.throws(recipient.assertRecipientCurrent, /released intent/);
            assertRecipient = recipient.assertRecipientCurrent;
            return createTelegramFollowerSelectedCommandBinding({ name: "status",  ctx, operationId: input.operationId, registrationGeneration: input.recipientRegistrationGeneration,
              target: input.selectedCommand!.target, recipient, command: rootCommand, menu: menuPorts,
              deliver: (effect, assertAuthority) => caller({ ctx, operationId: input.operationId, registrationGeneration: input.recipientRegistrationGeneration, effect, assertAuthority }),
              recordOwnership({ messageId }) { assertRecipient(); local.push(messageId); } });
          } }) : undefined;
        const rootFields = { requestId: "root-status", recipientInstanceId: "old", recipientRegistrationGeneration: "registration", recipientSessionId: "session",
          recipientBindingKey: binding, operationId: "restore", selectedCommand: { name: "status" as const, target: { ...workspace.request.target } }, sentAtMs: 1000 };
        const saved = peer?.save({ ...rootFields, kind: "leader.prepareLiveRebind", updates: [{ update_id: 100, message: {
          message_id: 100, message_thread_id: 10, text: "/status", from: { id: 7, is_bot: false }, chat: { id: 7, type: "private" } } }] }, f.ctx, () => true);
        const afterSave = rootMode ? readFileSync(sourceOptions.path, "utf8") : undefined;
        if (rootMode) { assert.ok(rootPlan); source = saved!.preparedSource; assert.deepEqual(source, rootPlan.source); assert.equal(rootPreparations, 1);
          assert.equal(completed, 0); assert.equal(requests.length, 0); assert.deepEqual(workspace.store.listLiveRebindings(), []); }
        const selected = heldMode && !rootMode ? createTelegramFollowerSelectedCommandBinding({ name: "status",  ctx: f.ctx, operationId: "restore", registrationGeneration: "registration", target: workspace.request.target,
          recipient: { isCurrent: () => recipientCurrent, assertRecipientCurrent: assertRecipient }, command: commands, menu: menuPorts,
          deliver: (effect, assertAuthority) => caller({ ctx: f.ctx, operationId: "restore", registrationGeneration: "registration", effect, assertAuthority }),
          recordOwnership({ messageId }) { assertRecipient(); local.push(messageId); } }) : undefined;
        const plan = rootPlan ?? selected?.prepare(readiness!, f.ctx, { target: workspace.request.target,
          assertSourceCurrent() { assert.ok(held!.isOwnerCurrent()); }, assertRecipientCurrent: assertRecipient });
        let issued = false;
        const issue = rootMode ? async () => {
          if (issued) return false; issued = true;
          assert.equal((await peer!.settle({ ...rootFields, kind: "leader.settleLiveRebind", mode: "release", sourceUpdateIds: [100], preparedSource: saved!.preparedSource }, f.ctx, () => true)).status, "released");
          return true;
        } : heldMode ? async () => {
          if (issued) return false;
          issued = true; assert.ok(plan); assert.ok(held!.prepareStatusConsumption!({ source: plan.source, assertCurrent: assertRecipient,
            bindCarrier(value) { original = value; return plan.bindCarrier(value); }, async execute() { completed++; return plan.execute(); } }));
          return held!.release(() => { assertRecipient(); return true; });
        } : commands.prepareSelectedMenuCommand({ name: "status", args: "" }, [f.message], f.ctx, admission)!;
        assert.ok(issue);
        if (heldMode) { assert.ok(plan); assert.equal(completed, 0); assert.equal(requests.length, 0);
          if (!rootMode) assert.equal(readFileSync(sourceOptions.path, "utf8"), beforePreparation);
          assert.deepEqual(workspace.store.listLiveRebindings(), []);
          if (rootMode) {
            await workspace.store.commitLiveRebind(workspace.request, { kind: "follower", instanceId: "old", sessionId: "session", generation: "registration" }, workspace.auth);
            assert.equal((await peer!.apply({ ...rootFields, kind: "leader.applyLiveRebind", mode: "apply", sourceUpdateIds: [100], preparedSource: saved!.preparedSource }, f.ctx, () => true)).status, "applied");
            assert.equal(readFileSync(sourceOptions.path, "utf8"), afterSave, "Binding/application preserve exact saved originals");
            const live = workspace.store.listLiveRebindings()[0]!; workspace.store.advanceLiveRebind(live, "release", workspace.auth);
          } else await releaseBinding();
          initial = readFileSync(workspace.path, "utf8"); }
        await operations.run({ operationId: "chooser", operationKind: "workspace.fixture-chooser", scopes: [{ kind: "profile" }] }, async () => { assert.equal(await issue(), true); });
        assert.deepEqual(ledger.read().leases, [], "Real chooser lease ended before menu rendering");
        await worker.waitForDrain(); await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(inspectTelegramDeferredSourceCompletion(original), source); assert.deepEqual(heldMode ? plan!.inspectCompletion() : completion!.inspectCompletion(), source);
        if (!heldMode) assert.equal(completion!.reportCompleted(), false); assert.equal(journal.read().entries.some(value => value.update.update_id === 100), false);
        await worker.stop(); assert.equal(inspectTelegramDeferredSourceCompletion(original), undefined, "Original worker authority is genuinely disposed");
        assert.equal(heldMode ? plan!.inspectCompletion() : completion!.inspectCompletion(), undefined);
        assert.equal(await issue(), false);
        if (rootMode) { assert.equal(rootGetters, 1); assert.equal(rootPreparations, 1); assertRecipient(); }
        if (mode === "render-loss") recipientCurrent = false;
        if (mode === "session-loss") sessionGeneration++;
        render.resolve();
        if (!["render-loss", "session-loss", "wire-scope"].includes(mode)) await Promise.race([entered.promise, finished.promise.then(() => { assert.fail("No native API attempt"); })]);
        http.resolve(); await finished.promise; await new Promise(resolve => setImmediate(resolve));
        const success = ["current", "chunks", "edit", "edit-loss", "busy"].includes(mode);
        assert.equal(stored, success ? 1 : 0); assert.equal(completed, 1);
        assert.equal(requests.length, ["render-loss", "session-loss", "wire-scope"].includes(mode) ? 0 : mode === "chunks" ? 2 : 1);
        for (const body of requests) { assert.equal(body.chat_id, 7); assert.equal(body.message_thread_id, 42); assert.equal(body.parse_mode, "HTML"); assert.equal(body.reply_parameters, undefined); }
        if (success) { assert.equal(state.mode, "status"); assert.equal(state.messageId, requests.length); assert.ok(requests.at(-1)?.reply_markup); }
        if (mode === "chunks") { assert.equal(requests[0]?.reply_markup, undefined); assert.deepEqual(local, [1, 2]); }
        if (mode === "response-local") assert.deepEqual(remote, [1], "Later local-only loss cannot cancel delegated remote ownership");
        if (["edit", "edit-loss"].includes(mode)) {
          const editing = rendered.editInteractiveMessage(7, state.messageId, "<b>Updated</b>", "html", { inline_keyboard: [] }, { target: workspace.request.target, assertAuthority: assertRecipient });
          if (mode === "edit-loss") await assert.rejects(editing); else await editing;
          assert.equal(requests.at(-1)?.message_id, state.messageId); assert.deepEqual(requests.at(-1)?.reply_markup, { inline_keyboard: [] });
          assert.equal(requests.at(-1)?.message_thread_id, undefined, "Edit target is certified by the wire recipient/ownership, not an unsupported Bot API field");
        }
        assert.equal(readFileSync(workspace.path, "utf8"), initial); assert.deepEqual(journal.read().entries.find(value => value.update.update_id === 101), neighbor);
        assert.deepEqual(ledger.read().leases, []); assert.deepEqual(workspace.threads.listPendingCleanups(), []);
      } finally { render.resolve(); http.resolve(); await worker.stop(); await server.stop(); globalThis.fetch = originalFetch; resetTransportReplyDedup(); }
    }, "follower");
  });
}

function createSelectedMenuAdapterFixture(mode: "current" | "state-await" | "response" | "reload" | "state-target" | "store-loss", noModels = false) {
  const f = createFencedCommandTargetFixture();
  resetTransportReplyDedup();
  const originalFetch = globalThis.fetch, networkFamily = process.env.PI_TELEGRAM_NETWORK_FAMILY;
  delete process.env.PI_TELEGRAM_NETWORK_FAMILY;
  let recipientCurrent = true, completions = 0, stored = 0, release!: () => void;
  const prepared = new Promise<void>(resolve => { release = resolve; });
  const requests: Record<string, unknown>[] = [], ownership: number[] = [];
  const assertRecipientCurrent = () => { if (!recipientCurrent) throw new Error("Private selected recipient replaced"); };
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (mode === "response") recipientCurrent = false;
    return new Response(JSON.stringify({ ok: true, result: { message_id: requests.length } }));
  };
  const api = createDefaultTelegramBridgeApiRuntime({ getBotToken: () => "123:fixture", recordRuntimeEvent() {} });
  const rendered = createTelegramRenderedMessageDeliveryRuntime<unknown>({
    renderTelegramMessage: () => [{ text: "menu-first" }, { text: "menu-tail" }],
    sendMessage(body, options) { assert.equal(options?.assertAuthority, assertRecipientCurrent); return api.sendMessage(body, options); },
    editMessage: api.editMessageText,
    sendRichMessage: api.sendRichMessage,
    recordOwnership({ messageId }) { ownership.push(messageId); },
  });
  const outbound = createTelegramOutboundTextReplyRuntime({
    execCommand: async () => assert.fail("No configured handler"),
    sendTextReply: rendered.sendTextReply, sendMarkdownReply: rendered.sendMarkdownReply,
  });
  const model = { id: "model", provider: "fixture", reasoning: true };
  const state: TelegramModelMenuState<typeof model> = {
    chatId: 7, threadId: 41, messageId: 0, mode: "model", scope: "all", page: 0,
    scopedModels: [], allModels: noModels ? [] : [{ model }],
  };
  const getModelMenuState = async (chatId: number, ctx: typeof f.ctx, threadId?: number) => {
    assert.deepEqual([chatId, ctx, threadId], [7, f.ctx, 41]);
    if (mode === "state-await") await prepared;
    if (mode === "state-target") state.threadId = 99;
    return state;
  };
  const storeModelMenuState = (value: typeof state) => {
    assert.equal(value, state); stored++;
    assert.deepEqual([value.chatId, value.threadId], [7, 41]);
    assert.equal(Object.values(value).includes(assertRecipientCurrent), false, "Callback state retains no delivery authority");
    if (mode === "store-loss") recipientCurrent = false;
  };
  const common = { getModelMenuState, storeModelMenuState,
    sendInteractiveMessage: rendered.sendInteractiveMessage, editInteractiveMessage: rendered.editInteractiveMessage };
  const menus = createTelegramMenuActionRuntime({ ...common,
    getActiveModel: () => model, getThinkingLevel: () => "medium" as const,
    buildStatusHtml: () => "status", isIdle: () => true, canOfferInFlightModelSwitch: () => false,
    sendTextReply: outbound.sendTextReply,
  });
  const queue = createTelegramQueueMenuRuntime({ ...common,
    telegramQueueStore: { getQueuedItems: () => [], setQueuedItems() { assert.fail("No queue mutation"); }, hasQueuedItems: () => false },
    queueMutationRuntime: { append() { assert.fail("No append"); }, reorder() { assert.fail("No reorder"); },
      clear: () => assert.fail("No clear"), removeByMessageIds: () => assert.fail("No removal"),
      applyReactionByMessageId: () => assert.fail("No reaction mutation") },
    getStoredModelMenuState: () => undefined, answerCallbackQuery: async () => assert.fail("No callback replay"),
    updateStatusMessage: async () => assert.fail("No update"), updateStatus: () => assert.fail("No update"),
  });
  const noMutation = async () => assert.fail("Menu issuance cannot mutate settings");
  const settings = createTelegramSettingsMenuRuntime({ ...common,
    reloadConfig: async () => { if (mode === "reload") await prepared; },
    getStoredModelMenuState: () => undefined, answerCallbackQuery: async () => assert.fail("No callback replay"),
    areDraftPreviewsEnabled: () => false, getAssistantRenderingMode: () => "rich" as const,
    getActivityVerbosity: () => "quiet" as const, getTimeInjectionMode: () => "hidden" as const,
    getVoiceReplyMode: () => "manual" as const, isVoiceReplyModeConfigured: () => false,
    isAutomaticThreadCleanupEnabled: () => false, setDraftPreviewsEnabled: noMutation,
    setAssistantRenderingMode: noMutation, setActivityVerbosity: noMutation, setVoiceReplyMode: noMutation,
    setTimeInjectionMode: noMutation, setAutomaticThreadCleanupEnabled: noMutation,
  });
  f.deps.showStatus = menus.sendStatusMessage;
  f.deps.openModelMenu = menus.openModelMenu;
  f.deps.openThinkingMenu = (message, ctx, options) => menus.openThinkingMenu(message.chat.id, message.message_id, ctx, message.message_thread_id, options);
  f.deps.openQueueMenu = (message, ctx, options) => queue.openQueueMenu(message.chat.id, message.message_id, ctx, message.message_thread_id, options);
  f.deps.openSettingsMenu = settings.openSettingsMenu;
  const admission = { assertSourceCurrent() {}, assertRecipientCurrent,
    reportCompleted() { completions++; f.revoke(); return true; } };
  return { ...f, admission, requests, ownership, state, release,
    revokeRecipient() { recipientCurrent = false; admission.assertRecipientCurrent = () => {}; },
    counts: () => ({ completions, stored }),
    restore() { globalThis.fetch = originalFetch; if (networkFamily === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY; else process.env.PI_TELEGRAM_NETWORK_FAMILY = networkFamily; },
  };
}

for (const command of ["status", "model", "thinking", "queue", "settings"] as const) {
  for (const mode of ["current", "state-await", "response"] as const) {
    test(`Selected menu adapter ${command} fences ${mode} through menu/rendered/direct owners`, async () => {
      const f = createSelectedMenuAdapterFixture(mode);
      try {
        const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedMenuCommand(
          { name: command, args: "" }, [f.message], f.ctx, f.admission)!;
        assert.equal(await dispatch(), true);
        assert.equal(await dispatch(), false);
        await new Promise<void>(resolve => setImmediate(resolve));
        if (mode === "state-await") {
          assert.deepEqual(f.requests, []);
          f.revokeRecipient();
          f.message.chat.id = 99; f.message.message_thread_id = 99;
          f.release();
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        assert.deepEqual(f.counts(), { completions: 1, stored: mode === "current" ? 1 : 0 });
        assert.equal(f.requests.length, mode === "current" ? 2 : mode === "response" ? 1 : 0);
        assert.equal(f.ownership.length, mode === "current" ? 2 : 0);
        assert.ok(f.requests.every(body => body.chat_id === 7 && body.message_thread_id === 41 && !("assertAuthority" in body)));
        assert.equal(f.diagnostics.length, mode === "current" ? 0 : 1);
        assert.ok(f.diagnostics.every(text => text.includes("Telegram API call authority is unavailable.") && !text.includes("Private")));
        assert.deepEqual(f.effects, [], "Menus create no prompt/control, fold, abort or queue mutation");
      } finally { f.release(); f.restore(); }
    });
  }
}

for (const mode of ["reload", "state-target", "store-loss"] as const) {
  test(`Selected menu adapter protects detached ${mode} boundary`, async () => {
    const f = createSelectedMenuAdapterFixture(mode);
    try {
      const command = mode === "reload" ? "settings" : "status";
      const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedMenuCommand(
        { name: command, args: "" }, [f.message], f.ctx, f.admission)!;
      assert.equal(await dispatch(), true);
      await new Promise<void>(resolve => setImmediate(resolve));
      if (mode === "reload") { f.revokeRecipient(); f.release(); await new Promise<void>(resolve => setImmediate(resolve)); }
      assert.deepEqual(f.counts(), { completions: 1, stored: mode === "store-loss" ? 1 : 0 });
      assert.equal(f.requests.length, mode === "reload" ? 0 : 2);
      assert.ok(f.requests.every(body => body.chat_id === 7 && body.message_thread_id === 41));
      assert.equal(f.diagnostics.length, 1);
      assert.equal(await dispatch(), false, "Issued/lost rendering never repeats");
    } finally { f.release(); f.restore(); }
  });
}

for (const mode of ["current", "response"] as const) {
  test(`Selected menu adapter carries ${mode} authority through model notice/outbound`, async () => {
    const f = createSelectedMenuAdapterFixture(mode, true);
    try {
      const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedMenuCommand(
        { name: "model", args: "" }, [f.message], f.ctx, f.admission)!;
      assert.equal(await dispatch(), true);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(f.counts(), { completions: 1, stored: 0 });
      assert.equal(f.requests.length, mode === "current" ? 2 : 1);
      assert.equal(f.diagnostics.length, mode === "current" ? 0 : 1);
      assert.equal(f.requests[0]?.message_thread_id, 41);
      assert.deepEqual(f.requests[0]?.reply_parameters, { message_id: 11, allow_sending_without_reply: true });
      assert.equal(await dispatch(), false);
    } finally { f.restore(); }
  });
}

for (const command of ["status", "model", "thinking", "queue", "settings"] as const) {
  for (const outcome of ["release", "reject", "recipient-lost"] as const) {
    test(`Selected menu ${command} holds its captured release barrier (${outcome})`, async () => {
      const f = createFencedCommandTargetFixture(), gate = Promise.withResolvers<void>();
      f.deps.openSettingsMenu = async () => { f.effects.push("settings"); };
      let reports = 0, recipientCurrent = true;
      const admission = {
        assertSourceCurrent() { assert.equal(reports, 0); },
        assertRecipientCurrent() { if (!recipientCurrent) throw new Error("Recipient ended"); },
        reportCompleted() { reports++; f.revoke(); return true; },
        beforeEffects: () => gate.promise,
      };
      const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedMenuCommand(
        { name: command, args: "" }, [f.message], f.ctx, admission)!;
      admission.beforeEffects = async () => assert.fail("A replacement admission port cannot release the prepared command");
      const running = dispatch();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(reports, 1);
      assert.deepEqual(f.effects, [], "Acceptance cannot issue menu effects before release");
      assert.equal(await dispatch(), false, "An accepted but held command is already one-shot");
      if (outcome === "reject") gate.reject(new Error("Release refused"));
      else { recipientCurrent = outcome !== "recipient-lost"; gate.resolve(); }
      if (outcome === "release") assert.equal(await running, true);
      else await assert.rejects(running, /Release refused|Recipient ended/);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(f.effects, outcome === "release" ? [command] : []);
      assert.equal(reports, 1);
      assert.equal(await dispatch(), false);
    });
  }
}

for (const command of ["status", "model", "thinking", "queue", "settings"] as const) {
  test(`Selected menu command separates completion from detached recipient authority (${command})`, async () => {
    const f = createFencedCommandTargetFixture();
    f.deps.openSettingsMenu = async () => { f.effects.push("settings"); };
    let sourceCurrent = true, completions = 0, finish!: () => void;
    const delivery = new Promise<void>(resolve => { finish = resolve; });
    const originalEffect = command === "status" ? f.deps.showStatus : undefined;
    if (command === "status") f.deps.showStatus = async (...args) => {
      await originalEffect!(...args);
      await delivery;
      f.effects.push("delivered");
    };
    const bound = bindTelegramUpdateAdmissionSource({ update_id: 1, message: f.message }, outcome => {
      assert.equal(outcome.kind, "complete"); completions++;
    });
    Object.assign(f.message, bound.message);
    if (command === "thinking") f.deps.openThinkingMenu = async message => {
      assert.equal(reportTelegramUpdateCompleted(message), false, "Detached carrier cannot report another source completion");
      assert.equal(Reflect.get(message, "pi_telegram_source_update_id"), undefined);
      f.effects.push("thinking");
    };
    const handle = createTelegramCommandHandlerTargetRuntime(f.deps);
    const dispatch = handle.prepareSelectedMenuCommand({ name: command, args: "" }, [f.message], f.ctx, {
      assertSourceCurrent() { assert.ok(sourceCurrent); },
      assertRecipientCurrent() { assert.ok(true); },
      reportCompleted() {
        const reported = reportTelegramUpdateCompleted(f.message);
        sourceCurrent = false; f.revoke();
        return reported;
      },
    });
    assert.ok(dispatch);
    if (command === "status") {
      f.message.chat.id = 99; f.message.message_id = 99; f.message.message_thread_id = 99;
      f.deps.showStatus = async () => assert.fail("Prepared command retains its menu adapter");
    }
    assert.equal(await dispatch(), true, "Semantic completion cannot await delivery or borrow revoked source authority");
    assert.equal(await dispatch(), false, "One warm command cannot repeat completion or menu issuance");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completions, 1);
    assert.deepEqual(f.effects, [command]);
    finish();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.effects, command === "status" ? ["status", "delivered"] : [command]);
    assert.deepEqual(f.diagnostics, []);
  });
}

for (const mode of ["source-before", "recipient-before", "report-refused", "report-lost", "recipient-after-report",
  "recipient-before-effect", "recipient-during-effect", "context-replaced", "effect-failed"] as const) {
  test(`Selected menu command fences completion and one-shot effects (${mode})`, async () => {
    const f = createFencedCommandTargetFixture();
    let sourceCurrent = true, recipientCurrent = true, completions = 0;
    let finish!: () => void;
    const delivery = new Promise<void>(resolve => { finish = resolve; });
    const assertRecipientCurrent = () => { if (!recipientCurrent) throw new Error("Selected recipient revoked"); };
    f.deps.showStatus = async () => {
      f.effects.push("status");
      await delivery;
      assertRecipientCurrent();
      if (mode === "effect-failed") throw new Error("Menu response lost");
      f.effects.push("delivered");
    };
    const handle = createTelegramCommandHandlerTargetRuntime(f.deps);
    const dispatch = handle.prepareSelectedMenuCommand({ name: "status", args: "" }, [f.message], f.ctx, {
      assertSourceCurrent() { if (!sourceCurrent) throw new Error("Selected source revoked"); }, assertRecipientCurrent,
      reportCompleted() {
        completions++; sourceCurrent = false; f.revoke();
        if (mode === "report-lost") throw new Error("Completion hint lost");
        if (mode === "recipient-after-report") recipientCurrent = false;
        return mode !== "report-refused";
      },
    })!;
    sourceCurrent = mode !== "source-before"; recipientCurrent = mode !== "recipient-before";
    const result = dispatch();
    if (mode === "recipient-before-effect") recipientCurrent = false;
    if (mode === "context-replaced") f.replaceContext();
    if (["source-before", "recipient-before", "recipient-after-report", "report-lost"].includes(mode))
      await assert.rejects(result, /revoked|hint lost/);
    else assert.equal(await result, mode !== "report-refused");
    if (mode !== "source-before" && mode !== "recipient-before") assert.equal(await dispatch(), false);
    await new Promise<void>(resolve => setImmediate(resolve));
    const started = ["recipient-during-effect", "effect-failed"].includes(mode);
    assert.deepEqual(f.effects, started ? ["status"] : []);
    if (mode === "recipient-during-effect") recipientCurrent = false;
    finish();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.effects, started ? ["status"] : []);
    assert.equal(completions, ["source-before", "recipient-before"].includes(mode) ? 0 : 1);
    assert.deepEqual(f.diagnostics, mode === "recipient-before-effect" || mode === "recipient-during-effect"
      ? ["menu-render:Selected recipient revoked"] : mode === "effect-failed" ? ["menu-render:Menu response lost"] : []);
  });
}

for (const mode of ["ready", "source-unavailable", "recipient-unavailable", "completion-unavailable", "source-stale", "recipient-stale",
  "execution-stale", "captured-source", "captured-report", "captured-execution", "recipient-observation-source-loss"] as const) {
  test(`Selected status preparation establishes and captures owners without execution (${mode})`, async () => {
    const f = createFencedCommandTargetFixture();
    let sourceCurrent = mode !== "source-stale", recipientCurrent = mode !== "recipient-stale", reports = 0, preparing = true;
    const admission = { assertSourceCurrent() { assert.ok(sourceCurrent, "Source unavailable"); },
      assertRecipientCurrent() { assert.ok(recipientCurrent, "Recipient unavailable"); if (!preparing && mode === "recipient-observation-source-loss") sourceCurrent = false; },
      reportCompleted() { reports++; sourceCurrent = false; f.revoke(); return true; } };
    if (mode === "source-unavailable") admission.assertSourceCurrent = undefined!;
    if (mode === "recipient-unavailable") admission.assertRecipientCurrent = undefined!;
    if (mode === "completion-unavailable") admission.reportCompleted = undefined!;
    if (mode === "execution-stale") f.revoke();
    const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedMenuCommand({ name: "status", args: "" }, [f.message], f.ctx, admission);
    const ready = !["source-unavailable", "recipient-unavailable", "completion-unavailable"].includes(mode);
    assert.equal(!!dispatch, ready);
    assert.deepEqual(f.effects, []); assert.equal(reports, 0, "Preparation cannot execute, complete or send");
    preparing = false;
    if (!dispatch) return;
    if (mode === "captured-source") admission.assertSourceCurrent = () => assert.fail("Captured source owner was replaced");
    if (mode === "captured-report") admission.reportCompleted = () => assert.fail("Captured completion owner was replaced");
    if (mode === "captured-execution") f.deps.assertExecutionCurrent = () => assert.fail("Captured execution owner was replaced");
    if (["source-stale", "recipient-stale", "execution-stale", "recipient-observation-source-loss"].includes(mode)) {
      await assert.rejects(dispatch(), /Source unavailable|Recipient unavailable|Command source authority revoked/); assert.equal(reports, 0);
    }
    else { assert.equal(await dispatch(), true); assert.equal(await dispatch(), false); assert.equal(reports, 1); }
  });
}

test("Selected settings menu keeps the target adapter's unavailable notice without fallback admission", async () => {
  const f = createFencedCommandTargetFixture(), handle = createTelegramCommandHandlerTargetRuntime(f.deps);
  let completions = 0;
  const dispatch = handle.prepareSelectedMenuCommand({ name: "settings", args: "" }, [f.message], f.ctx, {
    assertSourceCurrent() {}, assertRecipientCurrent() {}, reportCompleted() { completions++; return true; },
  })!;
  assert.equal(await dispatch(), true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.effects, ["reply"]);
  assert.equal(completions, 1);
  assert.equal(await dispatch(), false);
});

for (const mode of ["current", "idle", "telegram-active", "source-before", "recipient-before", "clear-loss", "abort-loss", "abort-throw",
  "report-refused", "report-lost", "report-recipient-loss", "delivery-loss", "delivery-failed", "captured"] as const) {
  test(`Selected abort command completes semantic effects before guarded reply (${mode})`, async () => {
    const f = createFencedCommandTargetFixture(), held = Promise.withResolvers<void>();
    let sourceCurrent = mode !== "source-before", recipientCurrent = mode !== "recipient-before", reports = 0, sends = 0;
    const assertRecipientCurrent = () => { if (!recipientCurrent) throw new Error("Recipient revoked"); };
    f.deps.hasAbortHandler = () => mode !== "idle";
    f.deps.hasActiveTelegramTurn = () => mode === "telegram-active";
    f.deps.clearPendingModelSwitch = () => { f.effects.push("clear-model"); if (mode === "clear-loss") sourceCurrent = false; };
    f.deps.cancelNextTransitionAnnouncements = () => { f.effects.push("cancel-next"); };
    f.deps.setFoldQueuedPromptsIntoHistory = fold => { f.effects.push(`fold:${fold}`); };
    f.deps.abortCurrentTurn = () => {
      f.effects.push("abort");
      if (mode === "abort-loss") recipientCurrent = false;
      if (mode === "abort-throw") throw new Error("Abort result lost");
    };
    f.deps.sendTextReply = async (chatId, anchor, text, options) => {
      assert.deepEqual([chatId, anchor, options?.target?.threadId], [7, 11, 41]);
      assert.equal(options?.assertAuthority, assertRecipientCurrent);
      assert.equal(text, mode === "idle" ? "<b>💤 No active turn.</b>" : "<b>⏹️ Aborted current turn.</b>");
      assert.equal(reports, 1); sends++;
      await held.promise;
      if (mode === "delivery-failed") throw new Error("Reply result lost");
      options?.assertAuthority?.();
    };
    const admission = {
      assertSourceCurrent() { if (!sourceCurrent) throw new Error("Source revoked"); }, assertRecipientCurrent,
      reportCompleted() {
        reports++; sourceCurrent = false; f.revoke();
        if (mode === "report-lost") throw new Error("Completion result lost");
        if (mode === "report-recipient-loss") recipientCurrent = false;
        return mode !== "report-refused";
      },
    };
    const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedCommand({ name: "abort", args: "retained" }, [f.message], f.ctx, admission)!;
    if (mode === "captured") {
      f.message.chat.id = 99; f.message.message_id = 99; f.message.message_thread_id = 99;
      f.deps.abortCurrentTurn = () => assert.fail("Cannot borrow replaced semantic port");
      admission.reportCompleted = () => assert.fail("Cannot borrow replaced completion port");
      f.deps.sendTextReply = async () => assert.fail("Cannot borrow replaced reply port");
    }
    const result = dispatch();
    const rejects = !["current", "idle", "telegram-active", "captured"].includes(mode);
    const observed = rejects ? assert.rejects(result, /revoked|lost|refused/) : result.then(value => assert.equal(value, true));
    if (mode === "delivery-loss") { recipientCurrent = false; admission.assertRecipientCurrent = () => {}; }
    const semanticRan = !["source-before", "recipient-before", "clear-loss"].includes(mode);
    const reported = semanticRan && !["abort-loss", "abort-throw"].includes(mode);
    assert.equal(reports, reported ? 1 : 0);
    assert.equal(sends, ["current", "idle", "telegram-active", "captured", "delivery-loss", "delivery-failed"].includes(mode) ? 1 : 0);
    assert.deepEqual(f.effects, !semanticRan ? ["source-before", "recipient-before"].includes(mode) ? [] : ["clear-model"]
      : mode === "idle" ? ["clear-model", "cancel-next"]
      : ["clear-model", "cancel-next", `fold:${mode === "telegram-active"}`, "abort", ...(["abort-loss", "abort-throw"].includes(mode) ? [] : ["update"])]);
    held.resolve(); await observed;
    if (!["source-before", "recipient-before"].includes(mode)) assert.equal(await dispatch(), false, "Issued abort/completion/reply is never repeated");
    assert.ok(!f.effects.includes("clear-queue"));
  });
}

test("Command reply projection preserves source, anchors and explicit delivery authority", async () => {
  for (const mode of ["source", "current", "replacement", "selected", "foreign-chat", "all", "revoked"] as const) {
    const message = Object.freeze({ chat: Object.freeze({ id: 7 }), message_id: 11, message_thread_id: 41 });
    const calls: unknown[][] = [];
    let resolutions = 0;
    const options = mode === "selected" ? { assertAuthority() {} } : undefined;
    const runtime = createTelegramCommandTargetRuntime<typeof message, string>({
      enqueueControlItem() { assert.fail("Reply projection cannot change command admission"); },
      getReplyTarget() {
        resolutions++;
        if (mode === "revoked") throw new Error("Recipient unavailable");
        if (mode === "source") return undefined;
        return { chatId: mode === "foreign-chat" ? 8 : 7,
          threadId: mode === "all" ? undefined : mode === "current" ? 41 : 44 };
      },
      async showStatus(chat, anchor, _ctx, thread) { calls.push(["status", chat, anchor, thread]); },
      async openModelMenu(chat, anchor, _ctx, thread) { calls.push(["model", chat, anchor, thread]); },
      async openSettingsMenu(chat, anchor, _ctx, thread) { calls.push(["settings", chat, anchor, thread]); },
      async sendTextReply(chat, anchor, _text, captured) { calls.push(["text", chat, anchor, captured?.target?.threadId]); },
    });
    const actions = [
      () => runtime.showStatus(message, "ctx", options),
      () => runtime.openModelMenu(message, "ctx", options),
      () => runtime.openSettingsMenu(message, "ctx", options),
      () => runtime.sendTextReply(message, "notice", options),
    ];
    if (["foreign-chat", "all", "revoked"].includes(mode)) {
      for (const action of actions) await assert.rejects(async () => action(), /recipient chat|Thread reply to All|Recipient unavailable/);
      assert.deepEqual(calls, [], mode);
    } else {
      for (const action of actions) await action();
      const moved = mode === "replacement";
      assert.deepEqual(calls, ["status", "model", "settings", "text"].map(kind => [kind, 7, moved ? undefined : 11, moved ? 44 : 41]), mode);
    }
    assert.equal(resolutions, mode === "selected" ? 0 : 4, mode);
    assert.deepEqual(message, { chat: { id: 7 }, message_id: 11, message_thread_id: 41 }, mode);
  }
});

for (const mode of ["entry-mutation", "await-mutation"] as const) {
  test(`Command text target adapter captures recipient callback/options across ${mode}`, async () => {
    const held = Promise.withResolvers<void>(), message = { chat: { id: 7 }, message_id: 11, message_thread_id: 41 };
    let current = true, checks = 0, sends = 0;
    const options: { parseMode?: "HTML"; assertAuthority?: () => void } = { parseMode: "HTML" };
    const assertAuthority = () => {
      checks++;
      if (!current) throw new Error("Recipient revoked");
      if (mode === "entry-mutation") { options.assertAuthority = () => {}; options.parseMode = undefined; message.message_thread_id = 99; }
    };
    options.assertAuthority = assertAuthority;
    const deps = { enqueueControlItem() { assert.fail("No admission"); }, showStatus: async () => {}, openModelMenu: async () => {},
      async sendTextReply(chatId: number, anchor: number | undefined, _text: string, captured?: Parameters<TelegramCommandHandlerTargetRuntimeDeps<typeof message, string>["sendTextReply"]>[3]) {
        assert.deepEqual([chatId, anchor, captured?.target?.threadId, captured?.parseMode], [7, 11, 41, "HTML"]);
        assert.equal(captured?.assertAuthority, assertAuthority); sends++; await held.promise;
      } };
    const runtime = createTelegramCommandTargetRuntime<typeof message, string>(deps);
    const result = runtime.sendTextReply(message, "notice", options);
    assert.equal(sends, 1);
    deps.sendTextReply = async () => assert.fail("Cannot borrow a replacement adapter");
    options.assertAuthority = () => {}; current = false;
    held.resolve(); await assert.rejects(result, /Recipient revoked/);
    assert.equal(checks, 2);
  });
}

for (const commandName of ["compact", "new"] as const) {
  const prepare = commandName === "compact" ? "prepareSelectedCompactCommand" : "prepareSelectedNewCommand";
  const confirmationHtml = commandName === "compact" ? "<b>Compact session?</b>" : "<b>Start a new session?</b>";
  const confirmationMarkup = [[{ text: commandName === "compact" ? "🗜 Yes, compact" : "🆕 Yes, start new", callback_data: commandName + ":confirm" },
    { text: "❌ No", callback_data: commandName + ":cancel" }]];
test(`Selected ${commandName} requires its single confirmation leaf and interactive port before admission`, () => {
  const f = createFencedCommandTargetFixture();
  const admission = { assertSourceCurrent() { assert.fail("No source"); }, assertRecipientCurrent() { assert.fail("No recipient"); }, reportCompleted() { assert.fail("No report"); } };
  const command = { name: commandName, args: "" };
  assert.equal(createTelegramCommandHandlerTargetRuntime(f.deps)[prepare](command, [f.message], f.ctx, admission), undefined);
  f.deps.sendInteractiveMessage = async () => assert.fail("No confirmation");
  const handler = createTelegramCommandHandlerTargetRuntime(f.deps);
  for (const name of [commandName === "compact" ? "new" : "compact", "name", "status", "extension"]) assert.equal(handler[prepare]({ ...command, name }, [f.message], f.ctx, admission), undefined);
  for (const messages of [[], [f.message, f.message]]) assert.equal(handler[prepare](command, messages, f.ctx, admission), undefined);
  assert.deepEqual(f.effects, []);
});

for (const mode of ["current", "classic", "busy", "captured", "source-entry", "execution-entry", "recipient-entry", "recipient-source-loss",
  "report-refused", "report-lost", "recipient-after-report", "context-replaced", "recipient-before-effect", "recipient-response", "response-lost", "missing-id"] as const) {
  test(`Selected ${commandName} handles confirmation once without borrowing compaction or delivery (${mode})`, async () => {
    const f = createFencedCommandTargetFixture(), held = Promise.withResolvers<void>();
    if (mode === "classic") Reflect.deleteProperty(f.message, "message_thread_id");
    let source = mode !== "source-entry", recipient = mode !== "recipient-entry", reports = 0, sends = 0, delivered = 0;
    if (mode === "execution-entry") f.revoke();
    const assertRecipientCurrent = () => {
      if (!recipient) throw new Error("Recipient revoked");
      if (mode === "recipient-source-loss") source = false;
    };
    f.deps.sendInteractiveMessage = async (chatId, text, format, markup, options) => {
      assert.equal(reports, 1, "Handled semantics precedes detached delivery");
      assert.deepEqual([chatId, text, format, options?.target], [7, confirmationHtml, "html",
        mode === "classic" ? { chatId: 7 } : { chatId: 7, threadId: 41 }]);
      assert.deepEqual(markup.inline_keyboard, confirmationMarkup);
      assert.equal(options?.assertAuthority, assertRecipientCurrent); options?.assertAuthority?.(); sends++;
      await held.promise;
      options?.assertAuthority?.();
      if (mode === "response-lost") throw new Error("Confirmation response lost");
      delivered++;
      return mode === "missing-id" ? undefined : 99;
    };
    if (mode === "busy") {
      f.deps.isIdle = () => assert.fail("Confirmation does not inspect or interrupt current work");
      f.deps.hasPendingMessages = () => assert.fail("Confirmation does not inspect pending Pi work");
      f.deps.hasActiveTelegramTurn = () => assert.fail("Confirmation does not inspect active Telegram work");
      f.deps.hasDispatchPending = () => assert.fail("Confirmation does not inspect pending dispatch");
      f.deps.hasQueuedTelegramItems = () => assert.fail("Confirmation does not inspect or clear the queue");
      f.deps.isCompactionInProgress = () => assert.fail("Confirmation does not run compaction");
    }
    const admission = { assertSourceCurrent() { if (!source) throw new Error("Source revoked"); }, assertRecipientCurrent,
      reportCompleted() { reports++; source = false; f.revoke(); if (mode === "report-lost") throw new Error("Report lost");
        if (mode === "recipient-after-report") recipient = false; return mode !== "report-refused"; } };
    const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps)[prepare]({ name: commandName, args: "ordinary ignored args" }, [f.message], f.ctx, admission)!;
    if (mode === "captured") {
      f.message.chat.id = 99; f.message.message_thread_id = 99;
      f.deps.sendInteractiveMessage = async () => assert.fail("Cannot borrow replacement transport");
      admission.reportCompleted = () => assert.fail("Cannot borrow replacement completion");
      admission.assertRecipientCurrent = () => {};
    }
    const result = dispatch();
    if (mode === "recipient-before-effect") recipient = false;
    if (mode === "context-replaced") f.replaceContext();
    const entryLoss = ["source-entry", "execution-entry", "recipient-entry", "recipient-source-loss"].includes(mode);
    if (entryLoss || mode === "report-lost" || mode === "recipient-after-report") await assert.rejects(result, /revoked|lost/);
    else assert.equal(await result, mode !== "report-refused");
    if (!entryLoss) assert.equal(await dispatch(), false, "Issued/reporting warm attempt never repeats");
    await new Promise<void>(resolve => setImmediate(resolve));
    const sendExpected = ["current", "classic", "busy", "captured", "recipient-response", "response-lost", "missing-id"].includes(mode);
    assert.equal(reports, entryLoss ? 0 : 1); assert.equal(sends, sendExpected ? 1 : 0);
    assert.equal(delivered, 0, "Held confirmation is not handled-semantic completion");
    if (mode === "recipient-response") recipient = false;
    held.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(delivered, sendExpected && !["recipient-response", "response-lost"].includes(mode) ? 1 : 0);
    assert.deepEqual(f.effects, [], "No compaction/new session, busy-work mutation, prompt/control admission, fold or menu");
    assert.deepEqual(f.diagnostics, ["recipient-before-effect", "recipient-response"].includes(mode) ? ["confirmation-render:Recipient revoked"]
      : mode === "response-lost" ? ["confirmation-render:Confirmation response lost"] : []);
  });
}

for (const boundary of ["current", "render-loss", "response-loss"] as const) {
  test(`Selected ${commandName} carries independent authority into actual rendered/direct owners (${boundary})`, async () => {
    const f = createFencedCommandTargetFixture(), originalFetch = globalThis.fetch, networkFamily = process.env.PI_TELEGRAM_NETWORK_FAMILY;
    delete process.env.PI_TELEGRAM_NETWORK_FAMILY; resetTransportReplyDedup();
    let source = true, recipient = true, reports = 0, requests = 0, owned = 0;
    const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
    const assertRecipientCurrent = () => { if (!recipient) throw new Error("Recipient revoked"); };
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)); assert.equal(reports, 1);
      assert.deepEqual([body.chat_id, body.message_thread_id, body.text], [7, 41, confirmationHtml]);
      assert.equal(body.reply_to_message_id, undefined); assert.equal(body.reply_parameters, undefined);
      requests++; entered.resolve(); await held.promise;
      if (boundary === "response-loss") recipient = false;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }));
    };
    const api = createDefaultTelegramBridgeApiRuntime({ getBotToken: () => "123:fixture", recordRuntimeEvent() {} });
    const rendered = createTelegramRenderedMessageDeliveryRuntime<unknown>({
      renderTelegramMessage(text) { if (boundary === "render-loss") recipient = false; return [{ text }]; },
      sendMessage(body, options) { assert.equal(options?.assertAuthority, assertRecipientCurrent); return api.sendMessage(body, options); },
      editMessage: api.editMessageText, sendRichMessage: api.sendRichMessage, recordOwnership() { owned++; },
    });
    f.deps.sendInteractiveMessage = rendered.sendInteractiveMessage;
    try {
      const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps)[prepare]({ name: commandName, args: "" }, [f.message], f.ctx, {
        assertSourceCurrent() { assert.ok(source); }, assertRecipientCurrent,
        reportCompleted() { reports++; source = false; f.revoke(); return true; },
      })!;
      assert.equal(await dispatch(), true); assert.equal(await dispatch(), false);
      if (boundary !== "render-loss") await entered.promise;
      held.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(requests, boundary === "render-loss" ? 0 : 1); assert.equal(owned, boundary === "current" ? 1 : 0);
      assert.equal(reports, 1); assert.deepEqual(f.effects, []);
      assert.equal(f.diagnostics.length, boundary === "current" ? 0 : 1);
      if (boundary !== "current") assert.match(f.diagnostics[0]!, /^confirmation-render:/);
    } finally {
      held.resolve(); globalThis.fetch = originalFetch; resetTransportReplyDedup();
      if (networkFamily === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY; else process.env.PI_TELEGRAM_NETWORK_FAMILY = networkFamily;
    }
  });
}

}

test("Selected bare name requires a single dialog leaf and its publication port before admission", () => {
  const f = createFencedCommandTargetFixture();
  const admission = { assertSourceCurrent() { assert.fail("No source"); }, assertRecipientCurrent() { assert.fail("No recipient"); }, reportCompleted() { assert.fail("No report"); } };
  const command = { name: "name", args: "" };
  assert.equal(createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedNameDialogCommand(command, [f.message], f.ctx, admission), undefined);
  f.deps.openThreadNameDialog = async () => undefined;
  const handler = createTelegramCommandHandlerTargetRuntime(f.deps);
  for (const name of ["help", "status", "extension"]) assert.equal(handler.prepareSelectedNameDialogCommand({ ...command, name }, [f.message], f.ctx, admission), undefined);
  assert.equal(handler.prepareSelectedNameDialogCommand({ ...command, args: "Navigator" }, [f.message], f.ctx, admission), undefined);
  for (const messages of [[], [f.message, f.message]]) assert.equal(handler.prepareSelectedNameDialogCommand(command, messages, f.ctx, admission), undefined);
  assert.deepEqual(f.effects, []);
});

for (const mode of ["current", "void-result", "owner-throw", "source-entry", "recipient-entry", "source-result", "recipient-result",
  "publication-loss", "publication-source-loss", "publication-final-observation", "report-refused", "report-lost", "captured"] as const) {
  test(`Selected bare name completes only the current exact dialog publication (${mode})`, async () => {
    const f = createFencedCommandTargetFixture(), delivery = Promise.withResolvers<void>();
    let source = mode !== "source-entry", recipient = mode !== "recipient-entry", reports = 0, opens = 0, proofs = 0;
    const assertRecipientCurrent = () => {
      if (!recipient) throw new Error("Recipient revoked");
      if (mode === "publication-final-observation" && proofs > 0) publicationCurrent = false;
    };
    let publicationCurrent = true;
    const admission = { assertSourceCurrent() { if (!source) throw new Error("Source revoked"); }, assertRecipientCurrent,
      reportCompleted() { reports++; source = false; f.revoke(); if (mode === "report-lost") throw new Error("Report lost"); return mode !== "report-refused"; } };
    f.deps.openThreadNameDialog = async (message, ctx, options) => {
      assert.deepEqual(message, { chat: { id: 7, type: "private" }, message_id: 11, message_thread_id: 41 });
      assert.equal(ctx, f.ctx); assert.equal(options?.assertRecipientCurrent, assertRecipientCurrent);
      assert.equal(typeof options?.assertSemanticCurrent, "function"); options?.assertSemanticCurrent(); opens++;
      await delivery.promise; options?.assertRecipientCurrent();
      if (mode === "owner-throw") throw new Error("Owner lost");
      if (mode === "void-result") return undefined;
      return { assertPublished() { proofs++; if (mode === "publication-loss" || !publicationCurrent) throw new Error("Publication lost"); if (mode === "publication-source-loss") source = false; } };
    };
    const command = { name: "name", args: "  " };
    const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedNameDialogCommand(command, [f.message], f.ctx, admission)!;
    if (mode === "captured") {
      command.args = "Changed"; f.message.message_id = 99; f.message.message_thread_id = 99;
      f.deps.openThreadNameDialog = async () => assert.fail("No replaced owner");
      admission.reportCompleted = () => assert.fail("No replaced report");
    }
    const result = dispatch(), success = mode === "current" || mode === "captured";
    const observed = success ? result.then(value => assert.equal(value, true)) : assert.rejects(result, /revoked|lost|refused|publication/i);
    assert.equal(reports, 0, "Held delivery is not publication completion");
    if (mode === "source-result") source = false;
    if (mode === "recipient-result") recipient = false;
    delivery.resolve(); await observed;
    assert.equal(opens, mode.endsWith("entry") ? 0 : 1);
    assert.equal(reports, success || mode.startsWith("report-") ? 1 : 0);
    if (success) assert.ok(proofs > 0);
    if (!mode.endsWith("entry")) assert.equal(await dispatch(), false, "Issued dialog/report cannot repeat");
    assert.deepEqual(f.effects, [], "Dialog completion cannot borrow menu/prompt/queue semantics");
  });
}

test("Selected explicit name refuses dialogs, groups, other leaves and missing mutation ports before admission", () => {
  const f = createFencedCommandTargetFixture();
  const admission = { assertSourceCurrent() { assert.fail("No source"); }, assertRecipientCurrent() { assert.fail("No recipient"); }, reportCompleted() { assert.fail("No report"); } };
  f.deps.renameCurrentThread = async () => ({ ok: true });
  f.deps.resetCurrentThreadName = async () => ({ ok: true });
  const handler = createTelegramCommandHandlerTargetRuntime(f.deps), command = { name: "name", args: "Navigator" };
  for (const name of ["help", "status", "continue", "extension"]) assert.equal(handler.prepareSelectedNameCommand({ ...command, name }, [f.message], f.ctx, admission), undefined);
  for (const args of ["", "   "]) assert.equal(handler.prepareSelectedNameCommand({ ...command, args }, [f.message], f.ctx, admission), undefined);
  for (const messages of [[], [f.message, f.message]]) assert.equal(handler.prepareSelectedNameCommand(command, messages, f.ctx, admission), undefined);
  assert.equal(createTelegramCommandHandlerTargetRuntime({ ...f.deps, renameCurrentThread: undefined }).prepareSelectedNameCommand(command, [f.message], f.ctx, admission), undefined);
  assert.equal(createTelegramCommandHandlerTargetRuntime({ ...f.deps, resetCurrentThreadName: undefined }).prepareSelectedNameCommand({ ...command, args: "A" }, [f.message], f.ctx, admission), undefined);
  assert.deepEqual(f.effects, []);
});

for (const kind of ["rename", "reset"] as const) {
  for (const mode of ["current", "failed-result", "source-entry", "recipient-entry", "source-result", "recipient-result", "owner-throw", "report-refused", "report-lost", "report-recipient-loss", "reply-loss", "captured"] as const) {
    test(`Selected explicit name completes the exact owner result before independent reply (${kind}/${mode})`, async () => {
      const f = createFencedCommandTargetFixture(), owner = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>();
      let source = mode !== "source-entry", recipient = mode !== "recipient-entry", reports = 0, mutations = 0, sends = 0;
      const assertRecipientCurrent = () => { if (!recipient) throw new Error("Recipient revoked"); };
      const effect = async (target: { chatId: number; threadId?: number }, options?: { assertAuthority?: () => void }) => {
        options?.assertAuthority?.();
        assert.deepEqual(target, { chatId: 7, threadId: 41, replyToMessageId: 11 });
        assert.equal(typeof options?.assertAuthority, "function", "Mutation must receive exact semantic authority");
        mutations++; target.threadId = 99;
        await owner.promise;
        options?.assertAuthority?.();
        if (mode === "owner-throw") throw new Error("Owner result lost");
        return mode === "failed-result" ? { ok: false, message: "Not saved" } : { ok: true, threadName: "Confirmed" };
      };
      f.deps.renameCurrentThread = async (target, name, options) => { assert.equal(name, "Navigator"); return effect(target, options); };
      f.deps.resetCurrentThreadName = effect;
      f.deps.sendTextReply = async (chat, anchor, text, options) => {
        assert.deepEqual([chat, anchor, options?.target?.threadId], [7, 11, 41]);
        assert.equal(options?.assertAuthority, assertRecipientCurrent);
        assert.equal(options?.parseMode, "HTML");
        assert.equal(text, mode === "failed-result" ? "<b>⚠️ Not saved</b>" : kind === "rename"
          ? "<b>✅ Thread display name saved as <i>Confirmed</i>.</b>" : "<b>✅ Automatic Thread display name restored as <i>Confirmed</i>.</b>");
        assert.equal(reports, 1); sends++;
        await reply.promise; options?.assertAuthority?.();
      };
      const admission = {
        assertSourceCurrent() { if (!source) throw new Error("Source revoked"); }, assertRecipientCurrent,
        reportCompleted() {
          reports++; source = false; f.revoke();
          if (mode === "report-lost") throw new Error("Report lost");
          if (mode === "report-recipient-loss") recipient = false;
          return mode !== "report-refused";
        },
      };
      const command = { name: "name", args: kind === "rename" ? " Navigator " : " A " };
      const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedNameCommand(command, [f.message], f.ctx, admission)!;
      if (mode === "captured") {
        command.args = "Changed"; f.message.chat.id = 99; f.message.message_id = 99; f.message.message_thread_id = 99;
        f.deps.renameCurrentThread = async () => assert.fail("No replaced rename");
        f.deps.resetCurrentThreadName = async () => assert.fail("No replaced reset");
        f.deps.sendTextReply = async () => assert.fail("No replaced reply");
        admission.reportCompleted = () => assert.fail("No replaced report");
      }
      const result = dispatch();
      const success = ["current", "failed-result", "captured"].includes(mode);
      const observed = success ? result.then(value => assert.equal(value, true)) : assert.rejects(result, /revoked|lost|refused/);
      assert.equal(reports, 0, "Held mutation is not semantic completion");
      if (mode === "source-result") source = false;
      if (mode === "recipient-result") recipient = false;
      owner.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
      const completed = !["source-entry", "recipient-entry", "source-result", "recipient-result", "owner-throw"].includes(mode);
      assert.equal(reports, completed ? 1 : 0);
      assert.equal(mutations, ["source-entry", "recipient-entry"].includes(mode) ? 0 : 1);
      assert.equal(sends, success || mode === "reply-loss" ? 1 : 0);
      if (mode === "reply-loss") { recipient = false; admission.assertRecipientCurrent = () => {}; }
      reply.resolve(); await observed;
      if (!["source-entry", "recipient-entry"].includes(mode)) assert.equal(await dispatch(), false, "Issued owner/report/reply cannot repeat");
      assert.deepEqual(f.effects, [], "Naming cannot touch queue/abort/fold/dispatch semantics");
    });
  }
}

for (const mode of ["invalid", "validation-loss", "format-loss"] as const) {
  test(`Selected explicit name fences validation and result formatting (${mode})`, async () => {
    const f = createFencedCommandTargetFixture();
    let source = true, reports = 0, mutations = 0, sends = 0;
    f.deps.validateThreadName = () => { if (mode === "validation-loss") source = false; return mode === "invalid" ? "Invalid Telegram Thread display name: printable ASCII required" : undefined; };
    f.deps.renameCurrentThread = async (_target, _name, options) => {
      options?.assertAuthority?.(); mutations++;
      return { ok: true, get threadName() { if (mode === "format-loss") source = false; return "Confirmed"; } };
    };
    f.deps.sendTextReply = async (_chat, _anchor, text, options) => { sends++; assert.match(text, /Printable ASCII/); assert.equal(typeof options?.assertAuthority, "function"); };
    const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedNameCommand({ name: "name", args: "bad" }, [f.message], f.ctx, {
      assertSourceCurrent() { if (!source) throw new Error("Source revoked"); }, assertRecipientCurrent() {}, reportCompleted() { reports++; source = false; f.revoke(); return true; },
    })!;
    if (mode === "invalid") assert.equal(await dispatch(), true); else await assert.rejects(dispatch(), /revoked/);
    assert.deepEqual([reports, mutations, sends], mode === "invalid" ? [1, 0, 1] : mode === "validation-loss" ? [0, 0, 0] : [0, 1, 0]);
    assert.equal(await dispatch(), false);
  });
}

for (const boundary of ["mutation", "completion"] as const) {
  test(`Selected explicit name refuses source loss inside recipient observation before ${boundary}`, async () => {
    const f = createFencedCommandTargetFixture();
    let source = true, effectDone = false, issuing = false, resultChecks = 0, mutations = 0, reports = 0;
    f.deps.renameCurrentThread = async (_target, _name, options) => {
      issuing = true; options?.assertAuthority?.(); issuing = false;
      mutations++; effectDone = true; return { ok: true };
    };
    const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedNameCommand({ name: "name", args: "Navigator" }, [f.message], f.ctx, {
      assertSourceCurrent() { if (!source) throw new Error("Source revoked"); },
      assertRecipientCurrent() { if (boundary === "mutation" && issuing || boundary === "completion" && effectDone && ++resultChecks === 2) source = false; },
      reportCompleted() { reports++; return true; },
    })!;
    await assert.rejects(dispatch(), /revoked/);
    assert.deepEqual([mutations, reports], boundary === "mutation" ? [0, 0] : [1, 0]);
    assert.deepEqual(f.effects, []);
  });
}

for (const kind of ["rename", "reset"] as const) {
  for (const mode of ["current", "mutation-response-loss", "reply-response-loss"] as const) {
    test(`Selected explicit name composes captured binding/rendered/direct ports (${kind}/${mode})`, async () => {
      const f = createFencedCommandTargetFixture(), originalFetch = globalThis.fetch, networkFamily = process.env.PI_TELEGRAM_NETWORK_FAMILY;
      delete process.env.PI_TELEGRAM_NETWORK_FAMILY; resetTransportReplyDedup();
      const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
      let source = true, recipient = true, reports = 0, publications = 0;
      const requests: Record<string, unknown>[] = [], ownership: number[] = [];
      globalThis.fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body)); requests.push(body);
        if (body.name && mode === "mutation-response-loss" || !body.name && requests.length === 2) {
          entered.resolve(); await held.promise;
        }
        return new Response(JSON.stringify({ ok: true, result: body.name ? true : { message_id: requests.length } }));
      };
      try {
        const api = createDefaultTelegramBridgeApiRuntime({ getBotToken: () => "123:fixture", recordRuntimeEvent() {} });
        const mutation = async (target: { chatId: number; threadId?: number }, options?: { assertAuthority?: () => void }) => {
          await api.call("editForumTopic", { chat_id: target.chatId, message_thread_id: target.threadId, name: "Confirmed" }, options);
          options?.assertAuthority?.(); publications++; return { ok: true, threadName: "Confirmed" };
        };
        const rename = createTelegramThreadDisplayNameRenameBinding(), reset = createTelegramThreadDisplayNameResetBinding();
        rename.bind((target, _name, options) => mutation(target, options)); reset.bind(mutation);
        f.deps.renameCurrentThread = rename.rename; f.deps.resetCurrentThreadName = reset.reset;
        const rendered = createTelegramRenderedMessageDeliveryRuntime<unknown>({
          renderTelegramMessage: () => [{ text: "name-first" }, { text: "name-tail" }], sendMessage: api.sendMessage,
          editMessage: api.editMessageText, sendRichMessage: api.sendRichMessage, recordOwnership({ messageId }) { ownership.push(messageId); },
        });
        f.deps.sendTextReply = rendered.sendTextReply;
        const admission = {
          assertSourceCurrent() { if (!source) throw new Error("Source revoked"); },
          assertRecipientCurrent() { if (!recipient) throw new Error("Recipient revoked"); },
          reportCompleted() { reports++; source = false; f.revoke(); return true; },
        };
        const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedNameCommand({ name: "name", args: kind === "rename" ? "Navigator" : "A" }, [f.message], f.ctx, admission)!;
        const result = dispatch();
        const observed = mode === "current" ? result.then(value => assert.equal(value, true)) : assert.rejects(result, /authority is unavailable/);
        await entered.promise;
        assert.deepEqual([reports, publications], mode === "mutation-response-loss" ? [0, 0] : [1, 1]);
        if (mode === "mutation-response-loss") source = false;
        if (mode === "reply-response-loss") { recipient = false; admission.assertRecipientCurrent = () => {}; }
        held.resolve(); await observed;
        assert.equal(await dispatch(), false);
        assert.equal(requests.length, mode === "current" ? 3 : mode === "mutation-response-loss" ? 1 : 2);
        assert.equal(ownership.length, mode === "current" ? 2 : 0);
        assert.ok(requests.every(body => body.chat_id === 7 && body.message_thread_id === 41 && !("assertAuthority" in body)));
        if (mode !== "mutation-response-loss") assert.deepEqual(requests[1]?.reply_parameters, { message_id: 11, allow_sending_without_reply: true });
        assert.deepEqual(f.effects, []);
      } finally {
        held.resolve(); globalThis.fetch = originalFetch;
        if (networkFamily === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY; else process.env.PI_TELEGRAM_NETWORK_FAMILY = networkFamily;
      }
    });
  }
}

test("Selected start refuses non-owner first contact, groups and other commands without source admission", () => {
  const f = createFencedCommandTargetFixture();
  const admission = { assertSourceCurrent() { assert.fail("No source"); }, assertRecipientCurrent() { assert.fail("No recipient"); }, reportCompleted() { assert.fail("No completion"); } };
  const handler = createTelegramCommandHandlerTargetRuntime(f.deps), start = { name: "start", args: "" };
  for (const name of ["status", "help", "stop", "continue", "new", "extension", "template"])
    assert.equal(handler.prepareSelectedStartCommand({ name, args: "" }, [f.message], f.ctx, admission), undefined);
  for (const messages of [[], [f.message, f.message]]) assert.equal(handler.prepareSelectedStartCommand(start, messages, f.ctx, admission), undefined);
  for (const message of [{ ...f.message, from: undefined }, { ...f.message, from: { id: 8, is_bot: false } },
    { ...f.message, from: { id: 7, is_bot: true } }, { ...f.message, chat: { id: 7, type: "group" } }])
    assert.equal(handler.prepareSelectedStartCommand(start, [message as typeof f.message], f.ctx, admission), undefined);
  assert.equal(createTelegramCommandHandlerTargetRuntime({ ...f.deps, getAllowedUserId: () => undefined }).prepareSelectedStartCommand(start, [f.message], f.ctx, admission), undefined);
  assert.deepEqual(f.effects, []);
});

for (const mode of ["plain", "bootstrap-notice", "bootstrap-empty", "captured"] as const) {
  test(`Selected start completes authenticated semantics before detached bootstrap/menu/sync (${mode})`, async () => {
    const f = createFencedCommandTargetFixture(), held = Promise.withResolvers<string | undefined>();
    let sourceCurrent = true, reports = 0, checks = 0;
    const assertRecipientCurrent = () => { checks++; };
    if (mode !== "plain") f.deps.handleForumBootstrap = async (message, ctx, options) => {
      assert.deepEqual([message.chat.id, message.message_id, message.message_thread_id, ctx], [7, 11, 41, f.ctx]);
      assert.equal(options?.assertAuthority, assertRecipientCurrent);
      assert.equal(Reflect.get(message, "pi_telegram_source_update_id"), undefined);
      assert.equal(reportTelegramUpdateCompleted(message), false, "Detached bootstrap cannot consume the source");
      f.effects.push("bootstrap"); await held.promise; options?.assertAuthority?.(); return held.promise;
    };
    f.deps.showStatus = async (chat, anchor, ctx, thread, options) => {
      assert.deepEqual([chat, anchor, ctx, thread], [7, 11, f.ctx, 41]);
      assert.equal(options?.assertAuthority, assertRecipientCurrent); f.effects.push("status");
    };
    f.deps.setMyCommands = async (_commands, options) => {
      assert.equal(options?.assertAuthority, assertRecipientCurrent); f.effects.push("bot-sync");
    };
    const bound = bindTelegramUpdateAdmissionSource({ update_id: 1, message: f.message }, outcome => { assert.equal(outcome.kind, "complete"); });
    Object.assign(f.message, bound.message);
    const admission = { assertSourceCurrent() { assert.ok(sourceCurrent); }, assertRecipientCurrent,
      reportCompleted() { reports++; sourceCurrent = false; f.revoke(); return reportTelegramUpdateCompleted(f.message); } };
    const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedStartCommand({ name: "start", args: "deep-link" }, [f.message], f.ctx, admission)!;
    if (mode === "captured") {
      f.message.chat.id = 99; f.message.message_id = 99; f.message.message_thread_id = 99; f.message.from.id = 99;
      f.deps.showStatus = async () => assert.fail("No replaced menu");
      f.deps.handleForumBootstrap = async () => assert.fail("No replaced bootstrap");
      f.deps.setMyCommands = async () => assert.fail("No replaced sync");
      admission.reportCompleted = () => assert.fail("No replaced report");
    }
    assert.equal(await dispatch(), true); assert.equal(reports, 1);
    assert.equal(await dispatch(), false);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.effects, mode === "plain" ? ["status", "bot-sync"] : ["bootstrap", "bot-sync"]);
    held.resolve(mode === "bootstrap-empty" ? undefined : "Forum ready");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.effects, mode === "plain" ? ["status", "bot-sync"] : ["bootstrap", "bot-sync", ...(mode === "bootstrap-empty" ? [] : ["reply"]), "status"]);
    assert.equal(reports, 1); assert.ok(checks > 1); assert.deepEqual(f.diagnostics, []);
  });
}

for (const mode of ["source-before", "recipient-before", "owner-changed", "source-after-pair", "owner-after-pair", "report-refused", "report-lost",
  "report-recipient-loss", "context-replaced", "bootstrap-loss", "bootstrap-failed", "reply-loss", "sync-loss"] as const) {
  test(`Selected start fences semantic and detached uncertainty without warm replay (${mode})`, async () => {
    const f = createFencedCommandTargetFixture(), held = Promise.withResolvers<string | undefined>();
    let sourceCurrent = mode !== "source-before", recipientCurrent = mode !== "recipient-before", reports = 0;
    const assertRecipientCurrent = () => { if (!recipientCurrent) throw new Error("Recipient revoked"); };
    if (["bootstrap-loss", "bootstrap-failed", "reply-loss"].includes(mode)) f.deps.handleForumBootstrap = async (_message, _ctx, options) => {
      f.effects.push("bootstrap"); await held.promise;
      options?.assertAuthority?.();
      if (mode === "bootstrap-failed") throw new Error("Bootstrap result lost");
      return "Forum ready";
    };
    if (mode === "reply-loss") f.deps.sendTextReply = async (_chat, _anchor, _text, options) => {
      f.effects.push("reply"); recipientCurrent = false; options?.assertAuthority?.();
    };
    if (mode === "sync-loss") f.deps.setMyCommands = async (_commands, options) => {
      f.effects.push("bot-sync"); await held.promise; options?.assertAuthority?.();
    };
    const admission = { assertSourceCurrent() { if (!sourceCurrent) throw new Error("Source revoked"); }, assertRecipientCurrent,
      reportCompleted() {
        reports++; sourceCurrent = false; f.revoke();
        if (mode === "report-lost") throw new Error("Completion result lost");
        if (mode === "report-recipient-loss") recipientCurrent = false;
        return mode !== "report-refused";
      } };
    let owner = 7;
    f.deps.getAllowedUserId = () => owner;
    const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedStartCommand({ name: "start", args: "" }, [f.message], f.ctx, admission)!;
    if (mode === "owner-changed") owner = 8;
    const result = dispatch();
    if (mode === "source-after-pair") sourceCurrent = false;
    if (mode === "owner-after-pair") owner = 8;
    if (mode === "context-replaced") f.replaceContext();
    if (["source-before", "recipient-before", "owner-changed", "source-after-pair", "owner-after-pair", "report-lost", "report-recipient-loss"].includes(mode))
      await assert.rejects(result, /revoked|unavailable|lost/);
    else assert.equal(await result, mode !== "report-refused");
    await new Promise<void>(resolve => setImmediate(resolve));
    if (mode === "bootstrap-loss" || mode === "sync-loss") recipientCurrent = false;
    admission.assertRecipientCurrent = () => {};
    held.resolve("Forum ready"); await new Promise<void>(resolve => setImmediate(resolve));
    const effects = mode.startsWith("bootstrap") ? ["bootstrap", "bot-sync"] : mode === "reply-loss" ? ["bootstrap", "bot-sync", "reply"]
      : mode === "sync-loss" ? ["status", "bot-sync"] : [];
    assert.deepEqual(f.effects, effects);
    assert.equal(reports, ["source-before", "recipient-before", "owner-changed", "source-after-pair", "owner-after-pair"].includes(mode) ? 0 : 1);
    if (!["source-before", "recipient-before", "owner-changed"].includes(mode)) assert.equal(await dispatch(), false);
    assert.equal(f.diagnostics.length, ["bootstrap-loss", "bootstrap-failed", "reply-loss", "sync-loss"].includes(mode) ? 1 : 0);
  });
}

test("Selected help refuses other command leaves, groups and unauthenticated private sources", () => {
  const f = createFencedCommandTargetFixture();
  const admission = { assertSourceCurrent() { assert.fail("No source admission"); }, assertRecipientCurrent() { assert.fail("No recipient"); }, reportCompleted() { assert.fail("No completion"); } };
  const handler = createTelegramCommandHandlerTargetRuntime(f.deps), help = { name: "help", args: "" };
  for (const name of ["start", "status", "stop", "continue", "compact", "new", "name", "extension", "template"])
    assert.equal(handler.prepareSelectedHelpCommand({ name, args: "" }, [f.message], f.ctx, admission), undefined);
  for (const messages of [[], [f.message, f.message]]) assert.equal(handler.prepareSelectedHelpCommand(help, messages, f.ctx, admission), undefined);
  for (const message of [{ ...f.message, from: undefined }, { ...f.message, from: { id: 8, is_bot: false } },
    { ...f.message, from: { id: 7, is_bot: true } }, { ...f.message, chat: { id: 7, type: "group" } }])
    assert.equal(handler.prepareSelectedHelpCommand(help, [message as typeof f.message], f.ctx, admission), undefined);
  assert.equal(createTelegramCommandHandlerTargetRuntime({ ...f.deps, getAllowedUserId: () => undefined }).prepareSelectedHelpCommand(help, [f.message], f.ctx, admission), undefined);
  assert.deepEqual(f.effects, []);
});

for (const mode of ["current", "captured", "source-before", "recipient-before", "owner-before", "source-after-pair", "owner-after-pair",
  "report-refused", "report-lost", "report-recipient-loss", "context-replaced"] as const) {
  test(`Selected help completes only authenticated semantics and never runs start bootstrap (${mode})`, async () => {
    const f = createFencedCommandTargetFixture();
    let sourceCurrent = mode !== "source-before", recipientCurrent = mode !== "recipient-before", owner: number | undefined = 7, reports = 0;
    const assertRecipientCurrent = () => { if (!recipientCurrent) throw new Error("Recipient revoked"); };
    f.deps.getAllowedUserId = () => owner;
    f.deps.handleForumBootstrap = async () => assert.fail("Help must not issue start-only bootstrap");
    f.deps.showStatus = async (chat, anchor, ctx, thread, options) => {
      assert.deepEqual([chat, anchor, ctx, thread], [7, 11, f.ctx, 41]);
      assert.equal(options?.assertAuthority, assertRecipientCurrent); f.effects.push("status");
    };
    f.deps.setMyCommands = async (_commands, options) => {
      assert.equal(options?.assertAuthority, assertRecipientCurrent); f.effects.push("bot-sync");
    };
    const admission = { assertSourceCurrent() { if (!sourceCurrent) throw new Error("Source revoked"); }, assertRecipientCurrent,
      reportCompleted() {
        reports++; sourceCurrent = false; f.revoke();
        if (mode === "report-lost") throw new Error("Completion result lost");
        if (mode === "report-recipient-loss") recipientCurrent = false;
        return mode !== "report-refused";
      } };
    const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedHelpCommand({ name: "help", args: "ignored" }, [f.message], f.ctx, admission)!;
    if (mode === "owner-before") owner = undefined;
    if (mode === "captured") {
      f.message.chat.id = 99; f.message.message_id = 99; f.message.message_thread_id = 99; f.message.from.id = 99;
      f.deps.showStatus = async () => assert.fail("No replaced menu adapter");
      f.deps.setMyCommands = async () => assert.fail("No replaced sync adapter");
      admission.reportCompleted = () => assert.fail("No replaced completion");
    }
    const result = dispatch();
    if (mode === "source-after-pair") sourceCurrent = false;
    if (mode === "owner-after-pair") owner = undefined;
    if (mode === "context-replaced") f.replaceContext();
    if (["source-before", "recipient-before", "owner-before", "source-after-pair", "owner-after-pair", "report-lost", "report-recipient-loss"].includes(mode))
      await assert.rejects(result, /revoked|unavailable|lost/);
    else assert.equal(await result, mode !== "report-refused");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(reports, ["source-before", "recipient-before", "owner-before", "source-after-pair", "owner-after-pair"].includes(mode) ? 0 : 1);
    assert.deepEqual(f.effects, mode === "current" || mode === "captured" ? ["status", "bot-sync"] : []);
    if (!["source-before", "recipient-before", "owner-before"].includes(mode)) assert.equal(await dispatch(), false);
    assert.deepEqual(f.diagnostics, []);
  });
}

for (const command of ["start", "help"] as const) {
test(`Selected ${command} cannot turn a drifting authenticated owner into cold pairing`, async () => {
  const f = createFencedCommandTargetFixture();
  let reads = 0, reports = 0;
  f.deps.getAllowedUserId = () => ++reads === 4 ? undefined : 7;
  const handler = createTelegramCommandHandlerTargetRuntime(f.deps);
  const dispatch = handler[command === "start" ? "prepareSelectedStartCommand" : "prepareSelectedHelpCommand"]({ name: command, args: "" }, [f.message], f.ctx, {
    assertSourceCurrent() {}, assertRecipientCurrent() {}, reportCompleted() { reports++; return true; },
  })!;
  await assert.rejects(dispatch(), /cannot acquire pairing authority/);
  assert.equal(await dispatch(), false); assert.equal(reports, 0); assert.deepEqual(f.effects, []);
});
}

for (const command of ["start", "help"] as const) {
for (const mode of ["current", "response-loss", "held-loss"] as const) {
  test(`Selected ${command} detaches actual BotFather registrar/bus/direct/client sync (${mode})`, async () => {
    const f = createFencedCommandTargetFixture(), held = Promise.withResolvers<void>();
    const originalFetch = globalThis.fetch, family = process.env.PI_TELEGRAM_NETWORK_FAMILY;
    delete process.env.PI_TELEGRAM_NETWORK_FAMILY;
    let current = true, reports = 0;
    const requests: unknown[] = [], assertRecipientCurrent = () => { if (!current) throw new Error("Recipient revoked"); };
    globalThis.fetch = async (input, init) => {
      assert.ok(String(input).endsWith("/setMyCommands")); requests.push(JSON.parse(String(init?.body)));
      assert.equal(reports, 1, "HTTP cannot delay selected command completion");
      await held.promise;
      if (mode === "response-loss") current = false;
      return new Response(JSON.stringify({ ok: true, result: true }));
    };
    const direct = createDefaultTelegramBridgeApiRuntime({ getBotToken: () => "123:fixture", recordRuntimeEvent() {} });
    const bus = createTelegramBusAwareApiRuntime({ directRuntime: direct, ownsDirect: () => true,
      callFollowerApi: async () => assert.fail("No guarded follower IPC") });
    f.deps.setMyCommands = bus.setMyCommands;
    try {
      const handler = createTelegramCommandHandlerTargetRuntime(f.deps);
      const dispatch = handler[command === "start" ? "prepareSelectedStartCommand" : "prepareSelectedHelpCommand"]({ name: command, args: "" }, [f.message], f.ctx, {
        assertSourceCurrent() {}, assertRecipientCurrent, reportCompleted() { reports++; f.revoke(); return true; },
      })!;
      assert.equal(await dispatch(), true); await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(reports, 1); assert.deepEqual(f.effects, ["status"]);
      assert.deepEqual(requests, [{ commands: TELEGRAM_BOT_COMMANDS }]);
      if (mode === "held-loss") current = false;
      held.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(await dispatch(), false); assert.equal(requests.length, 1);
      assert.equal(f.diagnostics.length, mode === "current" ? 0 : 1);
      if (mode !== "current") assert.ok(f.diagnostics[0]?.startsWith("bot-command-sync:"));
    } finally {
      held.resolve(); globalThis.fetch = originalFetch;
      if (family === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY; else process.env.PI_TELEGRAM_NETWORK_FAMILY = family;
    }
  });
}

for (const mode of ["current", "state-await", "response"] as const) {
  test(`Selected ${command} composes actual main menu/rendered/direct recipient boundaries (${mode})`, async () => {
    const f = createSelectedMenuAdapterFixture(mode);
    try {
      const handler = createTelegramCommandHandlerTargetRuntime(f.deps);
      const dispatch = handler[command === "start" ? "prepareSelectedStartCommand" : "prepareSelectedHelpCommand"]({ name: command, args: "" }, [f.message], f.ctx, f.admission)!;
      assert.equal(await dispatch(), true); assert.equal(await dispatch(), false);
      await new Promise<void>(resolve => setImmediate(resolve));
      if (mode === "state-await") { f.revokeRecipient(); f.release(); await new Promise<void>(resolve => setImmediate(resolve)); }
      assert.deepEqual(f.counts(), { completions: 1, stored: mode === "current" ? 1 : 0 });
      assert.equal(f.requests.length, mode === "current" ? 2 : mode === "response" ? 1 : 0);
      assert.equal(f.ownership.length, mode === "current" ? 2 : 0);
      assert.ok(f.requests.every(body => body.chat_id === 7 && body.message_thread_id === 41 && !("assertAuthority" in body)));
      assert.deepEqual(f.effects, ["bot-sync"]);
      assert.equal(f.diagnostics.length, mode === "current" ? 0 : mode === "response" ? 2 : 1);
      if (mode === "response") assert.ok(f.diagnostics.some(value => value.startsWith("bot-command-sync:")));
    } finally { f.release(); f.restore(); }
  });
}

}

for (const branch of ["idle-empty", "idle-cleared", "busy-empty", "busy-cleared"] as const) {
  for (const mode of ["current", "captured", "report-refused", "report-lost"] as const) {
    test(`Selected stop completes queue/abort semantics before guarded reply (${branch}, ${mode})`, async () => {
      const f = createFencedCommandTargetFixture(), held = Promise.withResolvers<void>();
      let sourceCurrent = true, reports = 0, sends = 0;
      const busy = branch.startsWith("busy"), cleared = branch.endsWith("cleared") ? 2 : 0;
      const assertRecipientCurrent = () => {};
      f.deps.hasAbortHandler = () => busy;
      f.deps.cancelNextTransitionAnnouncements = () => { f.effects.push("cancel-next"); };
      f.deps.clearQueuedTelegramItems = ctx => { assert.equal(ctx, f.ctx); f.effects.push("clear-queue"); return cleared; };
      f.deps.setFoldQueuedPromptsIntoHistory = fold => { assert.equal(fold, false); f.effects.push("fold:false"); };
      f.deps.sendTextReply = async (chat, anchor, text, options) => {
        assert.deepEqual([chat, anchor, options?.target?.threadId], [7, 11, 41]);
        assert.equal(options?.assertAuthority, assertRecipientCurrent);
        assert.equal(text, `<b>${busy ? "⏹️ Aborted current turn." : "💤 No active turn."}${cleared ? " Cleared 2 queued turns." : ""}</b>`);
        assert.equal(reports, 1); sends++; await held.promise;
      };
      const admission = {
        assertSourceCurrent() { if (!sourceCurrent) throw new Error("Source revoked"); }, assertRecipientCurrent,
        reportCompleted() {
          reports++; f.effects.push("complete"); sourceCurrent = false; f.revoke();
          if (mode === "report-lost") throw new Error("Completion lost");
          return mode !== "report-refused";
        },
      };
      const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedCommand({ name: "stop", args: "retained" }, [f.message], f.ctx, admission)!;
      if (mode === "captured") {
        f.message.chat.id = 99; f.message.message_id = 99; f.message.message_thread_id = 99;
        f.deps.clearQueuedTelegramItems = () => assert.fail("Cannot borrow replaced discard port");
        f.deps.cancelNextTransitionAnnouncements = () => assert.fail("Cannot borrow replaced notice port");
        f.deps.abortCurrentTurn = () => assert.fail("Cannot borrow replaced abort port");
        f.deps.sendTextReply = async () => assert.fail("Cannot borrow replaced reply port");
        admission.reportCompleted = () => assert.fail("Cannot borrow replaced completion");
      }
      const result = dispatch(), rejected = mode === "report-refused" || mode === "report-lost";
      const observed = rejected ? assert.rejects(result, /refused|lost/) : result.then(value => assert.equal(value, true));
      assert.equal(reports, 1, "Completion does not wait for reply delivery");
      assert.equal(sends, rejected ? 0 : 1);
      assert.deepEqual(f.effects, ["clear-model", "cancel-next", "clear-queue", "fold:false",
        ...(busy ? ["abort", "update"] : cleared ? ["update"] : []), "complete"]);
      assert.equal(await dispatch(), false, "Issued discard, abort, completion and reply never repeat");
      held.resolve(); await observed;
    });
  }
}

for (const loss of ["source-before", "recipient-before", "clear-model", "cancel-next", "clear-queue", "discard-throw", "fold:false",
  "abort", "abort-throw", "update", "report-recipient", "reply", "reply-failed"] as const) {
  test(`Selected stop fences later semantics and cannot replay uncertain disposal (${loss})`, async () => {
    const f = createFencedCommandTargetFixture(), held = Promise.withResolvers<void>();
    let sourceCurrent = loss !== "source-before", recipientCurrent = loss !== "recipient-before", reports = 0, sends = 0;
    const assertRecipientCurrent = () => { if (!recipientCurrent) throw new Error("Recipient revoked"); };
    const effect = (name: string) => {
      f.effects.push(name);
      if (loss === name) { if (name === "clear-queue") sourceCurrent = false; else recipientCurrent = false; }
      if (loss === "discard-throw" && name === "clear-queue" || loss === "abort-throw" && name === "abort") throw new Error("Effect lost");
    };
    f.deps.clearPendingModelSwitch = () => effect("clear-model");
    f.deps.cancelNextTransitionAnnouncements = () => effect("cancel-next");
    f.deps.clearQueuedTelegramItems = () => { effect("clear-queue"); return 2; };
    f.deps.setFoldQueuedPromptsIntoHistory = fold => effect(`fold:${fold}`);
    f.deps.abortCurrentTurn = () => effect("abort");
    f.deps.updateStatus = () => effect("update");
    f.deps.sendTextReply = async (_chat, _anchor, _text, options) => {
      sends++; await held.promise;
      if (loss === "reply-failed") throw new Error("Reply lost");
      options?.assertAuthority?.();
    };
    const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedCommand({ name: "stop", args: "" }, [f.message], f.ctx, {
      assertSourceCurrent() { if (!sourceCurrent) throw new Error("Source revoked"); }, assertRecipientCurrent,
      reportCompleted() { reports++; sourceCurrent = false; f.revoke(); if (loss === "report-recipient") recipientCurrent = false; return true; },
    })!;
    const result = dispatch(), observed = assert.rejects(result, /revoked|lost/);
    if (loss === "reply") recipientCurrent = false;
    const expected = ["clear-model", "cancel-next", "clear-queue", "fold:false", "abort", "update"];
    assert.deepEqual(f.effects, loss.endsWith("before") ? [] : ["report-recipient", "reply", "reply-failed"].includes(loss) ? expected
      : expected.slice(0, expected.indexOf(loss === "discard-throw" ? "clear-queue" : loss === "abort-throw" ? "abort" : loss) + 1));
    assert.equal(reports, ["report-recipient", "reply", "reply-failed"].includes(loss) ? 1 : 0);
    assert.equal(sends, ["reply", "reply-failed"].includes(loss) ? 1 : 0);
    held.resolve(); await observed;
    if (!loss.endsWith("before")) assert.equal(await dispatch(), false);
  });
}

for (const surface of ["selected", "held"] as const) for (const mode of ["current", "missing", "refused", "lost", "partial", "authority-after-discard"] as const) {
  test(`Selected stop uses actual queue binding discard acknowledgement before completion (${surface}, ${mode})`, async () => {
    const f = createFencedCommandTargetFixture(), store = Queue.createTelegramQueueStore<typeof f.ctx>();
    const active = Queue.createTelegramActiveTurnStore(), held = Promise.withResolvers<void>(), events: string[] = [];
    const turn = (id: number): Queue.PendingTelegramTurn => ({ kind: "prompt", chatId: 7, target: { chatId: 7, threadId: id },
      replyToMessageId: id, queueOrder: id, queueLane: "default", laneOrder: id, statusSummary: "waiting",
      admissionReceipts: [{ queueKind: "prompt", receiptId: `receipt-${id}`, sourceUpdateIds: [id, id + 1] }],
      sourceMessageIds: [id, id + 1], queuedAttachments: [], content: [{ type: "text", text: "waiting" }], historyText: "waiting" });
    const waiting = turn(60), control: Queue.PendingTelegramControlItem<typeof f.ctx> = { kind: "control", controlType: "status", chatId: 7,
      target: { chatId: 7, threadId: 61 }, replyToMessageId: 61, queueOrder: 61, queueLane: "control", laneOrder: 61, statusSummary: "control",
      admissionReceipts: [{ queueKind: "control", receiptId: "receipt-62", sourceUpdateIds: [62] }], execute: async () => assert.fail("No control execution") };
    active.set(turn(50)); active.markNextAbortAnnouncement();
    store.setQueuedItems([waiting, control]);
    const deferred = Queue.createTelegramDeferredQueueDispatchRuntime<typeof f.ctx>(); deferred.bind(f.ctx);
    let current = true, reports = 0, discards = 0, blocked = true, modelSends = 0;
    const runtime = createTelegramQueueBindingRuntime({
      store, queue: { allocateItemOrder: () => 1 }, lifecycle: { isCompactionInProgress: () => blocked, hasDispatchPending: () => blocked },
      activeTurn: active, deferredDispatch: deferred, transportStamp: { isActive: () => true },
      admission: { hasPendingQueueMutationForItem: () => false, getSettlement: () => mode === "missing" ? undefined : {
        isItemReady: item => (item.admissionReceipts?.length ?? 0) === 0, onControlSettled() {}, onItemsDiscarded(items, ctx) {
          assert.equal(ctx, f.ctx); assert.deepEqual(items, [waiting, control]);
          assert.deepEqual(items.flatMap(item => item.admissionReceipts!.flatMap(receipt => receipt.sourceUpdateIds)), [60, 61, 62]);
          discards++; events.push("discard");
          if (mode === "lost") throw new Error("Discard ACK lost");
          if (mode === "partial") events.push("prefix-only");
          if (mode === "authority-after-discard") current = false;
          return mode === "current" || mode === "authority-after-discard";
        },
      } },
      promptDispatch: { startTypingLoop() {}, onPromptDispatchStart() {}, onPromptDispatchFailure: () => assert.fail("No dispatch failure") },
      isIdle: () => !blocked, hasPendingMessages: () => blocked, updateStatus: () => events.push("queue-status"),
      sendTextReply: async () => assert.fail("Superseded queue notice cannot return"), sendUserMessage: () => { modelSends++; },
    });
    runtime.requestNextDispatchAnnouncement();
    f.deps.cancelNextTransitionAnnouncements = () => { active.clearNextAbortAnnouncement(); runtime.cancelNextDispatchAnnouncement(); events.push("cancel-next"); };
    f.deps.clearQueuedTelegramItems = runtime.mutation.clear;
    f.deps.abortCurrentTurn = () => events.push("abort");
    f.deps.sendTextReply = async () => { events.push("reply"); await held.promise; };
    const admission = {
      assertSourceCurrent() {}, assertRecipientCurrent() { if (!current) throw new Error("Recipient revoked"); },
      reportCompleted() { reports++; events.push("complete"); f.revoke(); return true; },
    };
    await withControlCommandSurface(surface, f, "stop", admission, async (dispatch, waitForExecution) => {
      const result = dispatch(), observed = mode === "current" ? result.then(value => assert.equal(value, true)) : assert.rejects(result, /durably|lost|revoked/);
      await waitForExecution();
      assert.equal(reports, mode === "current" ? 1 : 0);
      assert.equal(discards, mode === "missing" ? 0 : 1);
      assert.deepEqual(store.getQueuedItems(), ["current", "authority-after-discard"].includes(mode) ? [] : [waiting, control]);
      assert.deepEqual(waiting.target, { chatId: 7, threadId: 60 });
      assert.deepEqual(active.get()?.target, { chatId: 7, threadId: 50 }, "Stop does not redirect or erase active work");
      assert.equal(active.get()?.announceNextAbortOnEnd, undefined);
      assert.ok(!events.includes("abort") || mode === "current", "Unconfirmed queued disposal cannot borrow abort/completion proof");
      assert.equal(await dispatch(), false);
      held.resolve(); await observed;
      assert.deepEqual(events, ["cancel-next", ...(mode === "missing" ? [] : ["discard"]), ...(mode === "partial" ? ["prefix-only"] : []),
        ...(["current", "authority-after-discard"].includes(mode) ? ["queue-status"] : []), ...(mode === "current" ? ["abort", "complete", "reply"] : [])]);
      assert.equal(modelSends, 0);
      if (mode === "current") {
        const fresh = { ...turn(70), admissionReceipts: [] };
        store.setQueuedItems([fresh]); blocked = false;
        await Queue.handleTelegramAgentEndRuntime({
          turn: active.get(), assistant: { stopReason: "aborted" }, foldQueuedPromptsIntoHistory: false,
          resetRuntimeState: active.clear, updateStatus() {}, dispatchNextQueuedTelegramTurn: () => runtime.dispatchNext(f.ctx),
          clearPreview: async () => {}, setPreviewPendingText() {}, finalizeMarkdownPreview: async () => false,
          sendMarkdownReply: async () => {}, sendQueuedAttachments: async () => {},
          sendTextReply: async () => assert.fail("Superseded active abort notice cannot return"),
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(modelSends, 1, "Subsequent work dispatches without either superseded transition notice");
        assert.deepEqual(fresh.target, { chatId: 7, threadId: 70 });
        assert.equal(discards, 1); assert.equal(reports, 1);
      }
    });
  });
}

test("Selected registry refuses unsupported sources/effects and exposes no per-command aliases", () => {
  const f = createFencedCommandTargetFixture();
  f.deps.cancelNextTransitionAnnouncements = () => assert.fail("No cancellation");
  f.deps.requestNextDispatchAnnouncement = () => assert.fail("No notices");
  f.deps.markActiveTurnNextAbortAnnouncement = () => assert.fail("No marker");
  const admission = { assertSourceCurrent() { assert.fail("No source grant"); }, assertRecipientCurrent() { assert.fail("No recipient grant"); },
    reportCompleted() { assert.fail("No completion"); } };
  const handler = createTelegramCommandHandlerTargetRuntime(f.deps);
  for (const name of ["status", "abort", "stop", "next"]) {
    assert.equal(typeof handler.prepareSelectedCommand({ name, args: "" }, [f.message], f.ctx, admission), "function");
    for (const messages of [[], [f.message, f.message]])
      assert.equal(handler.prepareSelectedCommand({ name, args: "" }, messages, f.ctx, admission), undefined);
  }
  for (const name of ["continue", "new", "compact", "name", "help", "start", "model", "thinking", "queue", "settings", "extension", "template", "unknown"])
    assert.equal(handler.prepareSelectedCommand({ name, args: "" }, [f.message], f.ctx, admission), undefined);
  for (const [name, missing] of [["stop", "cancelNextTransitionAnnouncements"], ["stop", "clearQueuedTelegramItems"],
    ["next", "requestNextDispatchAnnouncement"], ["next", "markActiveTurnNextAbortAnnouncement"]] as const) {
    const deps = { ...f.deps, [missing]: undefined } as unknown as typeof f.deps;
    assert.equal(createTelegramCommandHandlerTargetRuntime(deps).prepareSelectedCommand({ name, args: "" }, [f.message], f.ctx, admission), undefined);
  }
  for (const retired of ["prepareSelectedAbortCommand", "prepareSelectedStopCommand", "prepareSelectedNextCommand"])
    assert.equal(Object.hasOwn(handler, retired), false);
  assert.deepEqual(f.effects, []);
});

for (const branch of ["empty", "busy-no-abort", "busy-abort", "idle"] as const) {
  for (const mode of ["current", "captured", "report-refused", "report-lost"] as const) {
    test(`Selected next command completes once at its own semantic boundary (${branch}, ${mode})`, async () => {
      const f = createFencedCommandTargetFixture(), held = Promise.withResolvers<void>();
      let sourceCurrent = true, reports = 0, sends = 0;
      const assertRecipientCurrent = () => {};
      f.deps.hasQueuedTelegramItems = () => branch !== "empty";
      f.deps.isIdle = () => branch === "idle";
      f.deps.hasAbortHandler = () => branch === "busy-abort";
      f.deps.requestNextDispatchAnnouncement = () => { f.effects.push("request-next"); };
      f.deps.markActiveTurnNextAbortAnnouncement = () => { f.effects.push("mark-active"); return true; };
      f.deps.sendTextReply = async (chat, anchor, text, options) => {
        assert.deepEqual([chat, anchor, options?.target?.threadId], [7, 11, 41]);
        assert.equal(options?.assertAuthority, assertRecipientCurrent);
        assert.equal(text, branch === "empty" ? "<b>⌛ Queue is empty</b>" : "<b>⏳ Pi is busy. Send /abort or /stop first.</b>");
        assert.equal(reports, 1); sends++; await held.promise;
      };
      const admission = {
        assertSourceCurrent() { if (!sourceCurrent) throw new Error("Source revoked"); }, assertRecipientCurrent,
        reportCompleted() {
          reports++; f.effects.push("complete"); sourceCurrent = false; f.revoke();
          if (mode === "report-lost") throw new Error("Completion lost");
          return mode !== "report-refused";
        },
      };
      const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedCommand({ name: "next", args: "retained" }, [f.message], f.ctx, admission)!;
      if (mode === "captured") {
        f.message.chat.id = 99; f.message.message_id = 99; f.message.message_thread_id = 99;
        f.deps.dispatchNextQueuedTelegramTurn = () => assert.fail("Cannot borrow replaced dispatch");
        f.deps.requestNextDispatchAnnouncement = () => assert.fail("Cannot borrow replaced notice port");
        admission.reportCompleted = () => assert.fail("Cannot borrow replaced completion");
      }
      const result = dispatch(), rejected = mode === "report-refused" || mode === "report-lost";
      const observed = rejected ? assert.rejects(result, /refused|lost/) : result.then(value => assert.equal(value, true));
      assert.equal(reports, 1, "No await between last synchronous semantic effect and completion");
      assert.equal(sends, !rejected && (branch === "empty" || branch === "busy-no-abort") ? 1 : 0);
      assert.deepEqual(f.effects, ["clear-model", ...(branch === "idle" ? ["request-next", "dispatch", "update"]
        : branch === "busy-abort" ? ["fold", "request-next", "mark-active", "abort", "update"] : []), "complete"]);
      assert.equal(await dispatch(), false, "No replay even when completion is refused or lost");
      held.resolve(); await observed;
    });
  }
}

for (const loss of ["source-before", "recipient-before", "clear-model", "request-next", "mark-active", "abort", "update", "report-recipient", "reply", "effect-throw"] as const) {
  test(`Selected next command refuses later effects after authority/result loss (${loss})`, async () => {
    const f = createFencedCommandTargetFixture(), held = Promise.withResolvers<void>();
    let sourceCurrent = loss !== "source-before", recipientCurrent = loss !== "recipient-before", reports = 0, sends = 0;
    const assertRecipientCurrent = () => { if (!recipientCurrent) throw new Error("Recipient revoked"); };
    const effect = (name: string) => {
      f.effects.push(name);
      if (loss === name) recipientCurrent = false;
      if (loss === "effect-throw" && name === "abort") throw new Error("Abort lost");
    };
    f.deps.hasQueuedTelegramItems = () => loss !== "reply";
    f.deps.isIdle = () => false;
    f.deps.clearPendingModelSwitch = () => effect("clear-model");
    f.deps.requestNextDispatchAnnouncement = () => effect("request-next");
    f.deps.markActiveTurnNextAbortAnnouncement = () => { effect("mark-active"); return true; };
    f.deps.abortCurrentTurn = () => effect("abort");
    f.deps.updateStatus = () => effect("update");
    f.deps.sendTextReply = async (_chat, _anchor, _text, options) => {
      sends++; await held.promise; options?.assertAuthority?.();
    };
    const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedCommand({ name: "next", args: "" }, [f.message], f.ctx, {
      assertSourceCurrent() { if (!sourceCurrent) throw new Error("Source revoked"); }, assertRecipientCurrent,
      reportCompleted() { reports++; sourceCurrent = false; f.revoke(); if (loss === "report-recipient") recipientCurrent = false; return true; },
    })!;
    const result = dispatch(), observed = assert.rejects(result, /revoked|lost/);
    if (loss === "reply") recipientCurrent = false;
    const expected = ["clear-model", "fold", "request-next", "mark-active", "abort", "update"];
    assert.deepEqual(f.effects, loss.endsWith("before") ? [] : loss === "reply" ? ["clear-model"]
      : loss === "report-recipient" ? expected : expected.slice(0, expected.indexOf(loss === "effect-throw" ? "abort" : loss) + 1));
    assert.equal(reports, ["report-recipient", "reply"].includes(loss) ? 1 : 0);
    assert.equal(sends, loss === "reply" ? 1 : 0);
    held.resolve(); await observed;
    if (!loss.endsWith("before")) assert.equal(await dispatch(), false);
  });
}

for (const surface of ["selected", "held"] as const) for (const mode of ["idle", "telegram-busy", "local-busy", "notice-failed", "superseded"] as const) {
  test(`Selected next leaf keeps prompt-owned transitions through real queue owners (${surface}, ${mode})`, async () => {
    const f = createFencedCommandTargetFixture(), events: string[] = [], held = Promise.withResolvers<void>();
    const active = Queue.createTelegramActiveTurnStore();
    const turn = (id: number, threadId: number): Queue.PendingTelegramTurn => ({ kind: "prompt", chatId: 7,
      target: { chatId: 7, threadId }, replyToMessageId: id, queueOrder: id, queueLane: "default", laneOrder: id,
      statusSummary: `turn ${id}`, sourceMessageIds: [id], queuedAttachments: [], content: [{ type: "text", text: `turn ${id}` }], historyText: `turn ${id}` });
    const next = turn(21, 61), tail = turn(22, 62), interrupted = turn(20, 60);
    let queued: Queue.TelegramQueueItem<typeof f.ctx>[] = [next, tail], idle = mode === "idle", reports = 0;
    if (mode !== "idle" && mode !== "local-busy") active.set(interrupted);
    const dispatcher = Queue.createTelegramQueueDispatchController<typeof f.ctx>({
      getQueuedItems: () => queued, setQueuedItems: items => { queued = items; }, canDispatch: () => idle && !active.has(),
      updateStatus() {}, sendTextReply: async (chat, anchor, _text, options) => {
        assert.deepEqual([chat, anchor, options?.target?.threadId], [7, 21, 61]);
        events.push("queued-notice"); await held.promise; return 100;
      }, onPromptDispatchStart: () => events.push("dispatch-start"), sendUserMessage: () => events.push("model-send"),
      onPromptDispatchFailure: () => assert.fail("No dispatch failure"),
    });
    f.deps.hasQueuedTelegramItems = () => queued.length > 0;
    f.deps.isIdle = () => idle;
    f.deps.requestNextDispatchAnnouncement = dispatcher.requestNextDispatchAnnouncement;
    f.deps.markActiveTurnNextAbortAnnouncement = active.markNextAbortAnnouncement;
    f.deps.dispatchNextQueuedTelegramTurn = dispatcher.dispatchNext;
    f.deps.abortCurrentTurn = () => events.push("abort");
    f.deps.sendTextReply = async () => assert.fail("Command must not own lifecycle notices");
    const admission = { assertSourceCurrent() {}, assertRecipientCurrent() {}, reportCompleted() { reports++; f.revoke(); events.push("complete"); return true; } };
    await withControlCommandSurface(surface, f, "next", admission, async (dispatch) => {
      assert.equal(await dispatch(), true);
      assert.equal(reports, 1); assert.equal(await dispatch(), false);
      assert.deepEqual(next.target, { chatId: 7, threadId: 61 });
      assert.deepEqual(tail.target, { chatId: 7, threadId: 62 });
      if (mode !== "idle") {
        assert.deepEqual(events, ["abort", "complete"]);
        assert.deepEqual(queued, [next, tail], "Aborting does not clear or rebind waiting work");
        if (mode === "superseded") { active.clearNextAbortAnnouncement(); dispatcher.cancelNextDispatchAnnouncement(); }
        idle = true;
        if (mode === "local-busy") dispatcher.dispatchNext(f.ctx);
        else await Queue.handleTelegramAgentEndRuntime({
          turn: active.get(), assistant: { stopReason: "aborted" }, foldQueuedPromptsIntoHistory: false,
          resetRuntimeState: active.clear, updateStatus() {}, dispatchNextQueuedTelegramTurn: () => dispatcher.dispatchNext(f.ctx),
          clearPreview: async () => {}, setPreviewPendingText() {}, finalizeMarkdownPreview: async () => false,
          sendMarkdownReply: async () => {}, sendQueuedAttachments: async () => {},
          sendTextReply: async (chat, anchor, _text, options) => {
            assert.deepEqual([chat, anchor, options?.target?.threadId], [7, 20, 60]);
            events.push("abort-notice"); if (mode === "notice-failed") throw new Error("Notice lost");
          }, recordRuntimeEvent: (_category, _error, detail) => events.push(`diagnostic:${detail?.phase}`),
        });
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      if (mode === "superseded") assert.deepEqual(events, ["abort", "complete", "dispatch-start", "model-send"]);
      else {
        assert.ok(events.includes("queued-notice")); assert.ok(!events.includes("model-send"), "Held notice does not hold semantic completion but precedes model send");
        if (mode === "telegram-busy" || mode === "notice-failed") assert.ok(events.indexOf("abort-notice") < events.indexOf("queued-notice"));
        if (mode === "notice-failed") assert.ok(events.includes("diagnostic:next-abort-announcement"));
      }
      held.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(events.filter(value => value === "model-send").length, 1);
      assert.equal(reports, 1); assert.deepEqual(queued, [next, tail]);
    });
  });
}

for (const guard of ["compaction", "pending-dispatch", "pending-messages", "tools-busy"] as const) {
  test(`Held next uses ordinary queue readiness and preserves waiting receipts (${guard})`, async () => {
    const f = createFencedCommandTargetFixture(), store = Queue.createTelegramQueueStore<typeof f.ctx>(), active = Queue.createTelegramActiveTurnStore();
    const turn: Queue.PendingTelegramTurn = { kind: "prompt", chatId: 7, target: { chatId: 7, threadId: 61 }, replyToMessageId: 61,
      queueOrder: 1, queueLane: "default", laneOrder: 1, statusSummary: "waiting", sourceMessageIds: [61], queuedAttachments: [],
      admissionReceipts: [{ queueKind: "prompt", receiptId: "waiting", sourceUpdateIds: [201] }], content: [{ type: "text", text: "waiting" }], historyText: "waiting" };
    store.setQueuedItems([turn]);
    const before = JSON.stringify(turn), deferred = Queue.createTelegramDeferredQueueDispatchRuntime<typeof f.ctx>(); deferred.bind(f.ctx);
    let blocked = true, dispatched = false, commits = 0, reports = 0, sends = 0, notices = 0, aborts = 0;
    const idle = () => guard !== "tools-busy" || !blocked;
    const queue = createTelegramQueueBindingRuntime({ store, queue: { allocateItemOrder: () => 2 }, activeTurn: active, deferredDispatch: deferred,
      lifecycle: { isCompactionInProgress: () => guard === "compaction" && blocked,
        hasDispatchPending: () => dispatched || guard === "pending-dispatch" && blocked },
      isIdle: idle, hasPendingMessages: () => guard === "pending-messages" && blocked, transportStamp: { isActive: () => true },
      admission: { hasPendingQueueMutationForItem: () => false, getSettlement: () => ({ isItemReady: () => true,
        onItemsDiscarded() { assert.fail("Next must not discard waiting work"); }, onControlSettled() { assert.fail("No queue control execution"); },
        onPromptHandedOff(item, ctx) { assert.equal(item, turn); assert.equal(ctx, f.ctx); assert.equal(blocked, false); commits++; return true; } }) },
      promptDispatch: { startTypingLoop() {}, onPromptDispatchStart() { dispatched = true; }, onPromptDispatchFailure() { assert.fail("No dispatch failure"); } },
      updateStatus() {}, async sendTextReply(chat, anchor, _text, options) {
        assert.deepEqual([chat, anchor, options?.target?.threadId], [7, 61, 61]); notices++; return 1;
      }, sendUserMessage() { sends++; },
    });
    f.deps.hasQueuedTelegramItems = store.hasQueuedItems; f.deps.isIdle = idle;
    f.deps.requestNextDispatchAnnouncement = queue.requestNextDispatchAnnouncement;
    f.deps.markActiveTurnNextAbortAnnouncement = active.markNextAbortAnnouncement;
    f.deps.dispatchNextQueuedTelegramTurn = queue.dispatchNext; f.deps.abortCurrentTurn = () => { aborts++; };
    f.deps.sendTextReply = async () => assert.fail("Next must not capture queue-owned notices as a command reply");
    await withControlCommandSurface("held", f, "next", { assertSourceCurrent() {}, assertRecipientCurrent() {},
      reportCompleted() { reports++; return true; } }, async dispatch => {
      assert.equal(await dispatch(), true); assert.equal(reports, 1); assert.equal(aborts, guard === "tools-busy" ? 1 : 0);
      assert.equal(commits, 0); assert.equal(sends, 0); assert.equal(notices, 0);
      assert.deepEqual(store.getQueuedItems(), [turn]); assert.equal(JSON.stringify(turn), before);
      assert.equal(await dispatch(), false);
      blocked = false; queue.dispatchNext(f.ctx); await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(commits, 1); assert.equal(sends, 1); assert.equal(notices, 1);
      queue.dispatchNext(f.ctx); assert.equal(commits, 1); assert.equal(sends, 1); assert.equal(reports, 1);
      assert.deepEqual(turn.target, { chatId: 7, threadId: 61 });
    });
  });
}

for (const mode of ["dispatch-throw", "dispatch-loss"] as const) {
  test(`Selected next idle dispatch uncertainty cannot complete or repeat (${mode})`, async () => {
    const f = createFencedCommandTargetFixture();
    let current = true, reports = 0, dispatches = 0;
    f.deps.hasQueuedTelegramItems = () => true;
    f.deps.requestNextDispatchAnnouncement = () => { f.effects.push("request-next"); };
    f.deps.markActiveTurnNextAbortAnnouncement = () => assert.fail("Idle command cannot mark active work");
    f.deps.dispatchNextQueuedTelegramTurn = () => {
      dispatches++; if (mode === "dispatch-throw") throw new Error("Dispatch lost"); current = false;
    };
    const dispatch = createTelegramCommandHandlerTargetRuntime(f.deps).prepareSelectedCommand({ name: "next", args: "" }, [f.message], f.ctx, {
      assertSourceCurrent() { if (!current) throw new Error("Source revoked"); }, assertRecipientCurrent() {},
      reportCompleted() { reports++; return true; },
    })!;
    await assert.rejects(dispatch(), /lost|revoked/);
    assert.equal(await dispatch(), false); assert.equal(dispatches, 1); assert.equal(reports, 0);
    assert.deepEqual(f.effects, ["clear-model", "request-next"]);
  });
}





test("Selected menu preparation refuses other command semantics and groups without effects", () => {
  const f = createFencedCommandTargetFixture(), handle = createTelegramCommandHandlerTargetRuntime(f.deps);
  const admission = { assertSourceCurrent() { assert.fail("Unsupported command cannot acquire source authority"); },
    assertRecipientCurrent() { assert.fail("Unsupported command cannot acquire recipient authority"); },
    reportCompleted() { assert.fail("Unsupported command cannot complete"); } };
  for (const name of ["start", "help", "name", "new", "compact", "stop", "abort", "next", "continue", "extension", "template", "unknown"])
    assert.equal(handle.prepareSelectedMenuCommand({ name, args: "retained" }, [f.message], f.ctx, admission), undefined);
  for (const messages of [[], [f.message, f.message]])
    assert.equal(handle.prepareSelectedMenuCommand({ name: "status", args: "" }, messages, f.ctx, admission), undefined);
  assert.deepEqual(f.effects, []);
});

for (const command of ["status", "help", "start"] as const) {
  for (const mode of ["current", "source-revoked", "context-replaced"] as const) {
    test(`Command target adapter preserves detached source and context authority (${command}, ${mode})`, async () => {
      const f = createFencedCommandTargetFixture(), handle = createTelegramCommandHandlerTargetRuntime(f.deps);
      const handled = handle(command, f.message, f.ctx);
      if (mode === "source-revoked") f.revoke();
      if (mode === "context-replaced") f.replaceContext();
      assert.equal(await handled, true);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(f.effects, mode === "current" ? command === "status" ? ["status"] : ["status", "bot-sync"] : []);
      assert.equal(f.diagnostics.length, mode === "source-revoked" ? command === "status" ? 1 : 2 : 0);
    });
  }
}

for (const boundary of ["bootstrap-with-reply", "bootstrap-without-reply", "reply"] as const) {
  test(`Command target adapter rechecks source authority inside detached start effects (${boundary})`, async () => {
    const f = createFencedCommandTargetFixture();
    let finish!: (value: string | undefined) => void, finishReply!: () => void;
    const bootstrap = new Promise<string | undefined>(resolve => { finish = resolve; });
    const reply = new Promise<void>(resolve => { finishReply = resolve; });
    f.deps.handleForumBootstrap = async () => { f.effects.push("bootstrap"); return bootstrap; };
    f.deps.sendTextReply = async () => { f.effects.push("reply"); await reply; };
    const handle = createTelegramCommandHandlerTargetRuntime(f.deps);
    assert.equal(await handle("start", f.message, f.ctx), true);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.effects, ["bootstrap", "bot-sync"], "Semantic command completion must not wait for menu delivery");
    if (boundary === "reply") {
      finish("Forum ready");
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(f.effects, ["bootstrap", "bot-sync", "reply"]);
    }
    f.revoke();
    finish(boundary === "bootstrap-without-reply" ? undefined : "Forum ready");
    finishReply();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.effects, boundary === "reply" ? ["bootstrap", "bot-sync", "reply"] : ["bootstrap", "bot-sync"]);
    assert.deepEqual(f.diagnostics, ["menu-render:Command source authority revoked"]);
  });
}

test("Command target adapter refuses revoked authority before direct control effects", async () => {
  const f = createFencedCommandTargetFixture(), handle = createTelegramCommandHandlerTargetRuntime(f.deps);
  f.revoke();
  await assert.rejects(handle("stop", f.message, f.ctx), /Command source authority revoked/);
  assert.deepEqual(f.effects, []);
});

test("Command target adapter refuses a rename result after source authority changes", async () => {
  const f = createFencedCommandTargetFixture();
  f.deps.renameCurrentThread = async () => { f.effects.push("rename"); f.revoke(); return { ok: true }; };
  const handle = createTelegramCommandHandlerTargetRuntime(f.deps);
  await assert.rejects(handle("name", f.message, f.ctx, "Navigator"), /Command source authority revoked/);
  assert.deepEqual(f.effects, ["rename"]);
});

test("Command target adapter records lost authority after an issued detached effect without replay", async () => {
  const f = createFencedCommandTargetFixture();
  f.deps.showStatus = async () => { f.effects.push("status"); f.revoke(); };
  const handle = createTelegramCommandHandlerTargetRuntime(f.deps);
  assert.equal(await handle("status", f.message, f.ctx), true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.effects, ["status"]);
  assert.deepEqual(f.diagnostics, ["menu-render:Command source authority revoked"]);
});

test("Command runtime routes commands through runtime ports", async () => {
  const events: string[] = [];
  const message = {
    chat: { id: 42 },
    message_id: 99,
    message_thread_id: 123,
    from: { id: 7 },
  };
  let allowedUserId: number | undefined;
  let compactComplete: (() => void) | undefined;
  let contextActive = true;
  const deps = {
    hasAbortHandler: () => true,
    clearPendingModelSwitch: () => {
      events.push("clear-switch");
    },
    hasQueuedTelegramItems: () => false,
    clearQueuedTelegramItems: () => {
      events.push("clear-queue");
      return 0;
    },
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => {
      events.push(`fold:${fold}`);
    },
    abortCurrentTurn: () => {
      events.push("abort");
    },
    isIdle: (ctx: { idle: boolean }) => ctx.idle,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: (inProgress: boolean) => {
      events.push(`compact:${inProgress}`);
    },
    updateStatus: () => {
      events.push("status");
    },
    isContextActive: () => contextActive,
    dispatchNextQueuedTelegramTurn: () => {
      events.push("dispatch");
    },
    compact: (
      _ctx: { idle: boolean },
      callbacks: { onComplete: () => void },
    ) => {
      events.push("compact:start");
      compactComplete = callbacks.onComplete;
    },
    startTypingLoop: (
      _ctx: { idle: boolean },
      chatId?: number,
      options?: { target?: { chatId: number; threadId?: number } },
    ) => {
      events.push(
        `typing:start:${chatId ?? "default"}:${options?.target?.chatId ?? "none"}:${options?.target?.threadId ?? "all"}`,
      );
    },
    stopTypingLoop: () => {
      events.push("typing:stop");
    },
    enqueueControlItem: async (
      nextMessage: typeof message,
      _ctx: { idle: boolean },
      controlType: "status" | "model",
      statusSummary: string,
      execute: (ctx: { idle: boolean }) => Promise<void>,
    ) => {
      events.push(
        `enqueue:${nextMessage.message_id}:${controlType}:${statusSummary}`,
      );
      await execute({ idle: true });
    },
    enqueueContinueTurn: async (nextMessage: typeof message) => {
      events.push(`continue:${nextMessage.message_id}`);
    },
    showStatus: async (nextMessage: typeof message) => {
      events.push(`show:${nextMessage.chat.id}`);
    },
    openModelMenu: async (nextMessage: typeof message) => {
      events.push(`model:${nextMessage.chat.id}`);
    },
    openThinkingMenu: async (nextMessage: typeof message) => {
      events.push(`thinking:${nextMessage.chat.id}`);
    },
    openQueueMenu: async (nextMessage: typeof message) => {
      events.push(`queue:${nextMessage.chat.id}`);
    },
    getAllowedUserId: () => allowedUserId,
    persistAllowedUserId: async (userId: number) => {
      events.push(`pair:${userId}`, "persist");
      allowedUserId = userId;
      return true;
    },
    registerBotCommands: async () => {
      events.push("register");
    },
    sendTextReply: async (nextMessage: typeof message, text: string) => {
      events.push(`reply:${nextMessage.message_id}:${text}`);
    },
  };
  for (const failedPublication of [true, false]) {
    const blocked = createTelegramCommandHandler({ ...deps,
      persistAllowedUserId: async () => {
        if (failedPublication) throw new Error("pairing publication failed");
        return false;
      },
    });
    if (failedPublication) await assert.rejects(blocked("start", message, { idle: true }), /pairing publication failed/);
    else assert.equal(await blocked("start", message, { idle: true }), true);
    assert.deepEqual(events, [], "Rejected pairing must not schedule menu, status, or command synchronization");
    assert.equal(allowedUserId, undefined);
  }
  const handleCommand = createTelegramCommandHandler(deps);
  assert.equal(await handleCommand("status", message, { idle: true }), true);
  assert.equal(await handleCommand("model", message, { idle: true }), true);
  assert.equal(await handleCommand("thinking", message, { idle: true }), true);
  assert.equal(await handleCommand("debug", message, { idle: true }), false);
  assert.equal(await handleCommand("start", message, { idle: true }), true);
  assert.equal(await handleCommand("help", message, { idle: true }), true);
  assert.equal(await handleCommand("continue", message, { idle: true }), true);
  assert.equal(await handleCommand("continue", message, { idle: false }), true);
  assert.equal(await handleCommand("compact", message, { idle: true }), true);
  compactComplete?.();
  assert.equal(await handleCommand("stop", message, { idle: true }), true);
  assert.equal(await handleCommand("unknown", message, { idle: true }), false);
  const eventCountBeforeStaleCommand = events.length;
  contextActive = false;
  assert.equal(await handleCommand("status", message, { idle: true }), true);
  await Promise.resolve();
  assert.equal(events.length, eventCountBeforeStaleCommand);
  assert.equal(allowedUserId, 7);
  assert.deepEqual(events, [
    "show:42",
    "model:42",
    "thinking:42",
    "pair:7",
    "persist",
    "status",
    "show:42",
    "register",
    "show:42",
    "register",
    "continue:99",
    "continue:99",
    "compact:true",
    "status",
    "typing:start:42:42:123",
    "compact:start",
    "reply:99:<b>🗜 Compaction started.</b>",
    "typing:stop",
    "compact:false",
    "status",
    "dispatch",
    "reply:99:<b>✅ Compaction completed.</b>",
    "clear-switch",
    "clear-queue",
    "fold:false",
    "abort",
    "status",
    "reply:99:<b>⏹️ Aborted current turn.</b>",
  ]);
});

test("Command admission advances polling while start-menu effects remain unsettled", async () => {
  const events: string[] = [];
  const persistedOffsets: number[] = [];
  let allowedUserId: number | undefined;
  let finishMenu: (() => void) | undefined;
  let failRegistration: ((error: Error) => void) | undefined;
  const message = {
    chat: { id: -1001, type: "supergroup" },
    message_id: 55,
    from: { id: 77 },
  };
  const handleCommand = createTelegramCommandHandler({
    hasAbortHandler: () => false,
    clearPendingModelSwitch: () => {},
    hasQueuedTelegramItems: () => false,
    clearQueuedTelegramItems: () => 0,
    setFoldQueuedPromptsIntoHistory: () => {},
    abortCurrentTurn: () => {},
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    isCompactionInProgress: () => false,
    setCompactionInProgress: () => {},
    updateStatus: () => {
      events.push("status");
    },
    dispatchNextQueuedTelegramTurn: () => {},
    enqueueContinueTurn: async () => {},
    compact: () => {},
    enqueueControlItem: () => {},
    showStatus: async () => {
      events.push("show");
      await new Promise<void>((resolve) => {
        finishMenu = resolve;
      });
      events.push("show:done");
    },
    openModelMenu: async () => {},
    openThinkingMenu: async () => {},
    openQueueMenu: async () => {},
    getAllowedUserId: () => allowedUserId,
    persistAllowedUserId: async (userId: number) => {
      events.push(`pair:${userId}`, "persist");
      allowedUserId = userId;
      return true;
    },
    registerBotCommands: async () => {
      events.push("register");
      await new Promise<void>((_resolve, reject) => {
        failRegistration = reject;
      });
    },
    sendTextReply: async (_message: typeof message, text: string) => {
      events.push(`reply:${text}`);
    },
    recordRuntimeEvent: (category, error, details) => {
      events.push(
        `runtime:${category}:${error instanceof Error ? error.message : String(error)}:${details?.phase}`,
      );
    },
  });
  const controller = new AbortController();
  const config = { botToken: "123:abc", lastUpdateId: 999 };
  let acceptedThroughUpdateId = 0;
  let getUpdatesCalls = 0;

  await runTelegramPollLoop({
    ctx: {},
    signal: controller.signal,
    config,
    deleteWebhook: async () => {},
    getUpdates: async () => {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) return [{ update_id: 1, message }];
      controller.abort();
      throw new DOMException("stop", "AbortError");
    },
    persistConfig: async () => {
      assert.fail("config persistence must not own the polling cursor");
    },
    appendUpdateBatch: (_updates, cursor) => {
      acceptedThroughUpdateId = cursor!;
      persistedOffsets.push(cursor!);
    },
    getAcceptedThroughUpdateId: () => acceptedThroughUpdateId,
    getJournalEntryCount: () => 0,
    signalUpdateWorker() {
      void handleCommand("start", message, {}).then((handled) => {
        assert.equal(handled, true);
      });
    },
    onErrorStatus: () => {},
    onStatusReset: () => {},
    sleep: async () => {},
  });

  assert.equal(allowedUserId, undefined);
  assert.equal(getUpdatesCalls, 2);
  assert.equal(config.lastUpdateId, 999);
  assert.equal(acceptedThroughUpdateId, 1);
  assert.deepEqual(persistedOffsets, [1]);
  assert.deepEqual(events.slice(0, 2), ["show", "register"]);
  assert.equal(events.includes("show:done"), false);

  finishMenu?.();
  failRegistration?.(new Error("sync failed"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(events.includes("show:done"), true);
  assert.equal(
    events.includes(
      "runtime:telegram-command:sync failed:bot-command-sync",
    ),
    true,
  );
});

test("Command or prompt dispatcher routes commands before enqueue fallback", async () => {
  const events: string[] = [], tail = { text: "neighbor" };
  const dispatchMessages = createTelegramCommandOrPromptDispatcher<
    { text: string },
    { id: string }
  >({
    extractRawText: (messages) =>
      messages.map((message) => message.text).join(" "),
    handleCommand: async (commandName, message, ctx, args) => {
      events.push(`command:${commandName ?? "none"}:${args ?? "none"}:${message.text}:${ctx.id}`);
      return commandName === "status";
    },
    executeExtensionCommand: async (command, message, ctx) => {
      events.push(
        `extension:${command.name}:${command.args}:${message.text}:${ctx.id}`,
      );
      return command.name === "review";
    },
    expandPromptTemplateCommand: (commandName, args) =>
      ["review", "triage"].includes(commandName) ? `expanded:${args}` : undefined,
    replaceMessageText: (message, text) => ({ ...message, text }),
    enqueueTurn: async (messages, ctx) => {
      if (messages.length === 2) assert.equal(messages[1], tail, "Template expansion preserves the original group tail");
      events.push(`enqueue:${messages.length}:${messages[0]?.text}:${ctx.id}`);
    },
  });
  await dispatchMessages([{ text: "/status" }], { id: "ctx" });
  await dispatchMessages([{ text: "/review staged" }], { id: "ctx" });
  await dispatchMessages([{ text: "/fix_tests now" }], { id: "ctx" });
  await dispatchMessages([{ text: "hello" }], { id: "ctx" });
  await dispatchMessages([{ text: "/triage captured" }, tail], { id: "ctx" });
  await dispatchMessages([], { id: "ctx" });
  assert.deepEqual(events, [
    "command:status::/status:ctx",
    "command:review:staged:/review staged:ctx",
    "extension:review:staged:/review staged:ctx",
    "command:fix_tests:now:/fix_tests now:ctx",
    "extension:fix_tests:now:/fix_tests now:ctx",
    "enqueue:1:/fix_tests now:ctx",
    "command:none:none:hello:ctx",
    "enqueue:1:hello:ctx",
    "command:triage:captured neighbor:/triage captured:ctx",
    "extension:triage:captured neighbor:/triage captured:ctx",
    "enqueue:2:expanded:captured neighbor:ctx",
  ]);
});

test("Command or prompt dispatcher rejects stale delegated command effects", async () => {
  let current = true;
  let enqueues = 0;
  const dispatchMessages = createTelegramCommandOrPromptDispatcher<
    { text: string },
    { id: string }
  >({
    extractRawText: (messages) => messages[0]?.text ?? "",
    handleCommand: async () => {
      current = false;
      return false;
    },
    replaceMessageText: (message, text) => ({ ...message, text }),
    enqueueTurn: async () => {
      enqueues += 1;
    },
    assertExecutionCurrent() {
      if (!current) throw new DOMException("Aborted", "AbortError");
    },
  });

  await assert.rejects(
    dispatchMessages([{ text: "stale" }], { id: "ctx" }),
    /Abort/u,
  );
  assert.equal(enqueues, 0);
});

test("Command or prompt dispatcher rejects stale extension command completion", async () => {
  let current = true;
  let enqueues = 0;
  const dispatchMessages = createTelegramCommandOrPromptDispatcher<
    { text: string },
    { id: string }
  >({
    extractRawText: (messages) => messages[0]?.text ?? "",
    handleCommand: async () => false,
    executeExtensionCommand: async () => {
      current = false;
      return false;
    },
    replaceMessageText: (message, text) => ({ ...message, text }),
    enqueueTurn: async () => {
      enqueues += 1;
    },
    assertExecutionCurrent() {
      if (!current) throw new DOMException("Aborted", "AbortError");
    },
  });

  await assert.rejects(
    dispatchMessages([{ text: "/extension" }], { id: "ctx" }),
    /Abort/u,
  );
  assert.equal(enqueues, 0);
});

test("Command or prompt dispatcher can ignore non-prompt message batches", async () => {
  const events: string[] = [];
  const dispatchMessages = createTelegramCommandOrPromptDispatcher<
    { text?: string; service?: boolean },
    { id: string }
  >({
    extractRawText: (messages) =>
      messages.map((message) => message.text ?? "").join(" "),
    shouldIgnoreMessages: (messages) =>
      messages.every((message) => message.service && !message.text),
    handleCommand: async () => {
      events.push("command");
      return false;
    },
    replaceMessageText: (message, text) => ({ ...message, text }),
    enqueueTurn: async (messages) => {
      events.push(`enqueue:${messages.length}`);
    },
  });
  await dispatchMessages([{ service: true }], { id: "ctx" });
  await dispatchMessages([{ service: true, text: "hello" }], {
    id: "ctx",
  });
  assert.deepEqual(events, ["command", "enqueue:1"]);
});

test("Command helpers execute command actions through provided handlers", async () => {
  const events: string[] = [];
  const deps = {
    handleStop: async () => {
      events.push("stop");
    },
    handleName: async (_message: unknown, _ctx: unknown, name: string) => {
      events.push(`name:${name}`);
    },
    handleCompact: async () => {
      events.push("compact");
    },
    handleStatus: async () => {
      events.push("status");
    },
    handleModel: async () => {
      events.push("model");
    },
    handleThinking: async () => {
      events.push("thinking");
    },
    handleHelp: async (_message: unknown, commandName: "help" | "start") => {
      events.push(`help:${commandName}`);
    },
    handleAbort: async () => {
      events.push("abort");
    },
    handleNext: async () => {
      events.push("next");
    },
    handleContinue: async () => {
      events.push("continue");
    },
    handleQueue: async () => {
      events.push("queue");
    },
    handleNew: async () => {
      events.push("new");
    },
  };
  assert.equal(
    await executeTelegramCommandAction(
      { kind: "ignore", executionMode: "ignored" },
      {},
      {},
      deps,
    ),
    false,
  );
  assert.equal(
    await executeTelegramCommandAction(
      { kind: "stop", executionMode: "immediate" },
      {},
      {},
      deps,
    ),
    true,
  );
  assert.equal(
    await executeTelegramCommandAction(
      { kind: "name", executionMode: "immediate" },
      {},
      {},
      deps,
      "Navigator",
    ),
    true,
  );
  assert.equal(
    await executeTelegramCommandAction(
      { kind: "new", executionMode: "immediate" },
      {},
      {},
      deps,
    ),
    true,
  );
  assert.equal(
    await executeTelegramCommandAction(
      { kind: "help", commandName: "start", executionMode: "immediate" },
      {},
      {},
      deps,
    ),
    true,
  );
  assert.deepEqual(events, ["stop", "name:Navigator", "new", "help:start"]);
});

function createNewSessionCommandDeps(
  overrides: Partial<Parameters<typeof handleTelegramNewCommand>[0]> = {},
) {
  const replies: string[] = [];
  const runtimeEvents: unknown[] = [];
  let requests = 0;
  const deps = {
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasActiveTelegramTurn: () => false,
    hasDispatchPending: () => false,
    hasQueuedTelegramItems: () => false,
    isCompactionInProgress: () => false,
    requestNewSession: () => {
      requests += 1;
    },
    sendTextReply: async (text: string) => {
      replies.push(text);
    },
    recordRuntimeEvent: (_category: string, error: unknown) => {
      runtimeEvents.push(error);
    },
    ...overrides,
  };
  return { deps, replies, runtimeEvents, get requests() { return requests; } };
}

test("New session command gates on busy state and schedules without a false result notice", async () => {
  const busy = createNewSessionCommandDeps({ isIdle: () => false });
  await handleTelegramNewCommand(busy.deps);
  assert.equal(busy.replies.length, 1);
  assert.match(busy.replies[0]!, /⏳/);
  assert.match(busy.replies[0]!, /Cannot start a new session while Pi or the Telegram queue is busy\./);

  const unavailable = createNewSessionCommandDeps({
    requestNewSession: undefined,
  });
  await handleTelegramNewCommand(unavailable.deps);
  assert.equal(unavailable.replies.length, 1);
  assert.match(unavailable.replies[0]!, /🚫/);

  const started = createNewSessionCommandDeps();
  await handleTelegramNewCommand(started.deps);
  assert.deepEqual(started.replies, []);
  assert.equal(started.requests, 1);
  assert.deepEqual(started.runtimeEvents, []);
});
function createRuntimeHarness() {
  const bridge = createCommandRegistrationApiHarness();
  const dispatched: string[] = [];
  const failures: unknown[] = [];
  const results: string[] = [];
  const prepared: number[] = [];
  const api = {
    sendUserMessage: async (content: string, options: Parameters<TelegramSessionActionRuntimeDeps["sendUserMessage"]>[1]) => {
      assert.deepEqual(options, { expandPromptTemplates: true });
      dispatched.push(content);
    },
    notifyResult: async (_target: unknown, result: string) => {
      results.push(result);
    },
    prepareReplacement: async (_ctx: unknown, updateId: number) => {
      prepared.push(updateId);
    },
    recordRuntimeEvent: (_category: string, error: unknown) => {
      failures.push(error);
    },
  } as unknown as TelegramSessionActionRuntimeDeps;
  const runtime = createTelegramSessionActionRuntime(api);
  const unexpected = () => assert.fail("Internal dispatch cannot enter ordinary Connect");
  registerTelegramBridgeCommands(bridge.api, {
    handleInternalAction: runtime.handleInternalAction,
    promptForConfig: async () => unexpected(), getStatusLines: unexpected,
    reloadConfig: async () => unexpected(), hasBotToken: unexpected,
    startPolling: unexpected, stopPolling: async () => unexpected(), updateStatus: unexpected,
    getSessionGeneration: unexpected, isContextCurrent: unexpected,
  });
  assert.equal(bridge.commands.has("telegram-internal"), false);
  return { commands: bridge.commands, dispatched, failures, prepared, results, runtime };
}

function createCommandContext(
  newSession: (options?: { withSession?: () => Promise<void> }) => Promise<{ cancelled: boolean }>,
  notices: string[] = [],
): ExtensionCommandContext {
  return {
    newSession,
    ui: { notify: (message: string) => { notices.push(message); } },
  } as unknown as ExtensionCommandContext;
}

const target = { chatId: 7, threadId: 8, messageId: 9 };

function getInternalCommandToken(content: string): string {
  const prefix = `/${TELEGRAM_CONNECT_COMMAND_NAME} ${TELEGRAM_INTERNAL_COMMAND_FLAG} new `;
  assert.ok(content.startsWith(prefix));
  const token = content.slice(prefix.length);
  assert.match(token, /^[0-9a-f-]{36}$/);
  return token;
}

test("Successor settlement claims once before retrying terminal delivery", async () => {
  const intent = { continuity: "workspace-thread" as const,
    cwd: "/repo", profileName: "default", sourceSessionId: "old",
    sourceUpdateId: 1, target: { chatId: 7, threadId: 8 }, messageId: 9,
    createdAtMs: 1000, expiresAtMs: 2000 };
  let reads = 0;
  let edits = 0;
  let clears = 0;
  const result = await settleTelegramSessionReplacement({
    getIntent: async () => { reads += 1; return intent; },
    hasSuccessorContinuity: () => reads > 1,
    editSuccess: async () => { edits += 1; return edits === 1
      ? { ok: false, retryable: true } : { ok: true }; },
    clearIntent: async () => { clears += 1; return true; },
    profileName: "default", cwd: "/repo", sessionId: "new", now: () => 1000,
    sleep: async () => {},
  });
  assert.equal(result, "settled");
  assert.equal(edits, 2);
  assert.equal(clears, 1);
  assert.equal(await settleTelegramSessionReplacement({
    getIntent: async () => undefined, hasSuccessorContinuity: () => false,
    editSuccess: async () => ({ ok: true }), clearIntent: async () => true,
    profileName: "default", cwd: "/repo", sessionId: "new",
  }), "none");
});

test("Successor settlement rejects mismatches, expiry, and lost cleanup acknowledgement", async () => {
  const intent = { continuity: "workspace-thread" as const,
    cwd: "/repo", profileName: "default", sourceSessionId: "old",
    sourceUpdateId: 1, target: { chatId: 7, threadId: 8 }, messageId: 9,
    createdAtMs: 1000, expiresAtMs: 2000 };
  const base = { getIntent: async () => intent, hasSuccessorContinuity: () => true,
    editSuccess: async () => ({ ok: true }), clearIntent: async () => true,
    profileName: "default", cwd: "/repo", sessionId: "new", now: () => 1000 };
  assert.equal(await settleTelegramSessionReplacement({ ...base, cwd: "/other" }), "stale");
  assert.equal(await settleTelegramSessionReplacement({ ...base, now: () => 2000 }), "expired");
  let deliveredWithoutClaim = false;
  assert.equal(await settleTelegramSessionReplacement({ ...base,
    editSuccess: async () => { deliveredWithoutClaim = true; return { ok: true }; },
    clearIntent: async () => false }), "failed");
  assert.equal(deliveredWithoutClaim, false);
});

test("Classic session action publishes chat continuity without a Workspace binding", async () => {
  const dispatched: string[] = [];
  const intents: unknown[] = [];
  let workspaceLookups = 0;
  const assembly = createTelegramSessionActionAssembly({
    sendUserMessage: async (content) => {
      assert.equal(typeof content, "string");
      dispatched.push(content as string);
    },
    store: {
      load: async () => {}, refresh: async () => {},
      getWorkspaceBindingByTarget: () => { workspaceLookups += 1; return undefined; },
      getSessionReplacementIntent: () => undefined,
      commitSessionReplacementIntent: async (intent) => { intents.push(intent); return true; },
      removeSessionReplacementIntent: async () => true,
    },
    getProfileName: () => undefined,
    ownsPersistence: () => true,
    sendResult: async () => ({ ok: true }),
    handoffTtlMs: 30_000,
    now: () => 1000,
  });
  assert.equal(assembly.action.scheduleAfterUpdate(41, { chatId: 7, messageId: 9 }), true);
  assembly.action.onUpdateCompleted(41);
  await Promise.resolve();
  await assembly.action.handleInternalAction(
    `new ${getInternalCommandToken(dispatched[0]!)}`, {
    cwd: "/repo",
    sessionManager: { getSessionId: () => "session-old" },
    newSession: async () => ({ cancelled: false }),
  } as unknown as ExtensionCommandContext);
  assert.equal(workspaceLookups, 0);
  assert.deepEqual(intents, [{
    continuity: "classic-chat", cwd: "/repo", profileName: "default",
    sourceSessionId: "session-old", sourceUpdateId: 41,
    target: { chatId: 7 }, messageId: 9, createdAtMs: 1000, expiresAtMs: 31_000,
  }]);
});

test("Follower Thread session action publishes and settles through leader-mediated authority", async () => {
  const threadTarget = { chatId: 7, threadId: 8 };
  const createHarness = (options: {
    registered?: boolean;
    publish?: (intent: TelegramSessionReplacementIntent) => Promise<boolean>;
  } = {}) => {
    const dispatched: string[] = [];
    const requests: Array<{ operation: string; intent: TelegramSessionReplacementIntent }> = [];
    const localCommits: TelegramSessionReplacementIntent[] = [];
    const localRemovals: TelegramSessionReplacementIntent[] = [];
    const results: string[] = [];
    const state = { registered: options.registered ?? true, refreshes: 0, rekeyed: false,
      intent: undefined as TelegramSessionReplacementIntent | undefined };
    const assembly = createTelegramSessionActionAssembly({
      sendUserMessage: async (content) => { dispatched.push(content as string); },
      store: {
        load: async () => {},
        refresh: async () => { state.refreshes += 1; },
        getWorkspaceBindingByTarget: (_target, sessionId) =>
          sessionId === undefined || sessionId === (state.rekeyed ? "session-new" : "session-old")
            ? { cwd: "/repo", sessionId: state.rekeyed ? "session-new" : "session-old",
                slot: "B", threadName: "Beacon", target: threadTarget }
            : undefined,
        getSessionReplacementIntent: () => state.intent,
        commitSessionReplacementIntent: async (intent, isCurrent) => {
          localCommits.push(intent);
          return isCurrent();
        },
        removeSessionReplacementIntent: async (intent) => { localRemovals.push(intent); return true; },
      },
      getProfileName: () => undefined,
      ownsPersistence: () => false,
      follower: {
        instanceId: "follower-a",
        isRegisteredFor: (target) => state.registered &&
          target.chatId === threadTarget.chatId && target.threadId === threadTarget.threadId,
        async requestSessionReplacement(operation, intent) {
          requests.push({ operation, intent });
          if (operation === "publish") {
            return options.publish ? options.publish(intent) : true;
          }
          return true;
        },
      },
      sendResult: async (_target, html) => { results.push(html); return { ok: true }; },
      handoffTtlMs: 30_000,
      now: () => 1000,
    });
    const run = async () => {
      assert.equal(assembly.action.scheduleAfterUpdate(41, { ...threadTarget, messageId: 9 }), true);
      assembly.action.onUpdateCompleted(41);
      await new Promise<void>((resolve) => setImmediate(resolve));
      let newSessions = 0;
      await assembly.action.handleInternalAction(
        `new ${getInternalCommandToken(dispatched.at(-1)!)}`, {
        cwd: "/repo",
        sessionManager: { getSessionId: () => "session-old" },
        newSession: async () => { newSessions += 1; return { cancelled: false }; },
      } as unknown as ExtensionCommandContext);
      return newSessions;
    };
    return { assembly, requests, localCommits, localRemovals, results, state, run };
  };

  const success = createHarness();
  assert.equal(await success.run(), 1);
  assert.equal(success.state.refreshes, 1);
  assert.deepEqual(success.localCommits, []);
  assert.deepEqual(success.requests, [{ operation: "publish", intent: {
    continuity: "workspace-thread", cwd: "/repo", profileName: "default",
    sourceSessionId: "session-old", sourceUpdateId: 41, target: threadTarget,
    messageId: 9, slot: "B", threadName: "Beacon", createdAtMs: 1000,
    expiresAtMs: 31_000, sourceInstanceId: "follower-a",
  } }]);
  assert.deepEqual(success.results, []);

  // The successor claims only after the leader re-keyed its binding and its
  // own follower registration is live again.
  // Successor settlement uses the real clock; publish a live copy of the intent.
  const liveAtMs = Date.now();
  const intent = { ...success.requests[0]!.intent,
    createdAtMs: liveAtMs, expiresAtMs: liveAtMs + 30_000 };
  success.state.intent = intent;
  success.state.registered = false;
  success.state.rekeyed = true;
  let delivered!: () => void;
  const delivery = new Promise<void>((resolve) => { delivered = resolve; });
  const sendResultCount = () => success.results.length;
  success.assembly.settlement.onSessionStart({ cwd: "/repo",
    sessionManager: { getSessionId: () => "session-new" } } as unknown as ExtensionContext);
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  assert.equal(success.requests.length, 1);
  success.state.registered = true;
  const poll = setInterval(() => { if (sendResultCount() > 0) delivered(); }, 10);
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([delivery, new Promise<never>((_, reject) => {
      guard = setTimeout(() => reject(new Error("Successor settlement did not deliver.")), 2_000);
    })]);
  } finally { clearInterval(poll); if (guard) clearTimeout(guard); }
  assert.deepEqual(success.requests.slice(1), [{ operation: "settle", intent }]);
  assert.deepEqual(success.localRemovals, []);
  assert.deepEqual(success.results, ["<b>🆕 New session started.</b>"]);

  for (const publish of [
    async () => false,
    async () => { throw new Error("Stale Telegram bus follower registration generation."); },
  ]) {
    const rejected = createHarness({ publish });
    assert.equal(await rejected.run(), 0);
    assert.deepEqual(rejected.localCommits, []);
    assert.deepEqual(rejected.results, ["<b>⚠️ New session failed.</b>"]);
  }

  const unregistered = createHarness({ registered: false });
  assert.equal(await unregistered.run(), 0);
  assert.deepEqual(unregistered.requests, []);
  assert.equal(unregistered.localCommits.length, 1);
  assert.equal(unregistered.localCommits[0]!.sourceInstanceId, undefined);
  assert.deepEqual(unregistered.results, ["<b>⚠️ New session failed.</b>"]);
});

test("Classic successor settles once across same-process and process-replacement startup", async () => {
  for (const replaceProcess of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), "pi-telegram-classic-new-"));
    const path = join(dir, "targets.json");
    try {
      const sourceStore = createTelegramTopicTargetStore({ path, getNowMs: () => 1000 });
      const dispatched: string[] = [];
      const source = createTelegramSessionActionAssembly({
        sendUserMessage: async (content) => {
          assert.equal(typeof content, "string");
          dispatched.push(content as string);
        }, store: sourceStore,
        getProfileName: () => undefined, ownsPersistence: () => true,
        sendResult: async () => { throw new Error("source must not publish success"); },
        handoffTtlMs: 30_000, now: () => 1000,
      });
      source.action.scheduleAfterUpdate(41, { chatId: 7, messageId: 9 });
      source.action.onUpdateCompleted(41);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await source.action.handleInternalAction(
        `new ${getInternalCommandToken(dispatched[0]!)}`, {
        cwd: "/repo", sessionManager: { getSessionId: () => "session-old" },
        newSession: async () => ({ cancelled: false }),
      } as unknown as ExtensionCommandContext);
      assert.equal(sourceStore.getSessionReplacementIntent()?.continuity, "classic-chat");

      const successorStore = replaceProcess
        ? createTelegramTopicTargetStore({ path, getNowMs: () => 2000 })
        : sourceStore;
      const deliveries: Array<{ target: unknown; html: string }> = [];
      let delivered!: () => void;
      const delivery = new Promise<void>((resolve) => { delivered = resolve; });
      const settle = () => settleTelegramSessionReplacement({
        async getIntent() {
          await successorStore.refresh?.();
          return successorStore.getSessionReplacementIntent();
        },
        hasSuccessorContinuity: (intent) => intent.continuity === "classic-chat",
        editSuccess: async (intent) => {
          deliveries.push({ target: intent.target,
            html: "<b>🆕 New session started.</b>" });
          delivered();
          return { ok: true };
        },
        clearIntent: (intent) => successorStore.removeSessionReplacementIntent(
          intent, () => true,
        ),
        profileName: "default", cwd: "/repo", sessionId: "session-new",
        now: () => 2000, sleep: async () => {},
      });
      assert.equal(await settle(), "settled");
      await delivery;
      assert.deepEqual(deliveries, [{
        target: { chatId: 7 }, html: "<b>🆕 New session started.</b>",
      }]);
      await successorStore.refresh?.();
      assert.equal(successorStore.getSessionReplacementIntent(), undefined);
      assert.equal(await settle(), "none");
      assert.equal(deliveries.length, 1);
      assert.deepEqual(successorStore.listWorkspaceBindings(), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("Session action dispatch waits for the exact durable update completion", async () => {
  const harness = createRuntimeHarness();
  assert.equal(harness.runtime.scheduleAfterUpdate(41, target), true);
  harness.runtime.onUpdateCompleted(40);
  await Promise.resolve();
  assert.deepEqual(harness.dispatched, []);
  harness.runtime.onUpdateCompleted(41);
  await Promise.resolve();
  assert.equal(harness.dispatched.length, 1);
  getInternalCommandToken(harness.dispatched[0]!);
});

test("Session action requires its one-use dispatch token and leaves success to successor settlement", async () => {
  const harness = createRuntimeHarness();
  assert.equal(harness.runtime.scheduleAfterUpdate(7, target), true);
  assert.equal(harness.runtime.scheduleAfterUpdate(8, target), false);
  harness.runtime.onUpdateCompleted(7);
  await Promise.resolve();
  assert.equal(harness.runtime.hasPending(), true);
  let calls = 0;
  const command = getRequiredCommand(harness.commands, TELEGRAM_CONNECT_COMMAND_NAME);
  const notices: string[] = [];
  const token = getInternalCommandToken(harness.dispatched[0]!);
  const invalid = ["--internal", "--internal new", "--internal new manual",
    `--internal future ${token}`, `--internal new ${token} extra`,
    `work --internal new ${token}`, `--internal=new ${token}`,
    `--INTERNAL new ${token}`, `--internalize new ${token}`];
  for (const args of invalid) {
    await command.handler(args, createCommandContext(async () => {
      calls += 1;
      return { cancelled: false };
    }, notices));
    assert.equal(harness.runtime.hasPending(), true, args);
    assert.equal(calls, 0, args);
  }
  await command.handler(
    `${TELEGRAM_INTERNAL_COMMAND_FLAG} new ${getInternalCommandToken(harness.dispatched[0]!)}`,
    createCommandContext(async (options) => {
      calls += 1;
      assert.equal(options, undefined);
      return { cancelled: false };
    }),
  );
  await command.handler(
    `${TELEGRAM_INTERNAL_COMMAND_FLAG} new ${getInternalCommandToken(harness.dispatched[0]!)}`,
    createCommandContext(async () => {
      calls += 1;
      return { cancelled: false };
    }, notices),
  );
  assert.equal(calls, 1);
  assert.deepEqual(notices, Array(invalid.length + 1).fill(TELEGRAM_INTERNAL_MANUAL_USE_MESSAGE));
  assert.deepEqual(harness.prepared, [7]);
  assert.deepEqual(harness.results, []);
  assert.equal(harness.runtime.hasPending(), false);
});

test("Session action does not replace before durable preparation succeeds", async () => {
  let replacements = 0;
  const failingDispatch: string[] = [], results: string[] = [];
  const failures: unknown[] = [];
  const failing = createTelegramSessionActionRuntime({
    sendUserMessage: async (content) => {
      assert.equal(typeof content, "string");
      failingDispatch.push(content as string);
    },
    prepareReplacement: async () => { throw new Error("persist failed"); },
    notifyResult: async (_target, result) => { results.push(result); },
    recordRuntimeEvent: (_category, error) => { failures.push(error); },
  } as TelegramSessionActionRuntimeDeps);
  failing.scheduleAfterUpdate(18, target);
  failing.onUpdateCompleted(18);
  await Promise.resolve();
  await failing.handleInternalAction(
    `new ${getInternalCommandToken(failingDispatch[0]!)}`,
    createCommandContext(async () => {
      replacements += 1;
      return { cancelled: false };
    }),
  );
  assert.equal(replacements, 0);
  assert.deepEqual(results, ["failure"]);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /persist failed/);
});

test("Session action contains failures and emits a terminal failure result", async () => {
  const harness = createRuntimeHarness();
  harness.runtime.scheduleAfterUpdate(9, target);
  harness.runtime.onUpdateCompleted(9);
  await Promise.resolve();
  const command = getRequiredCommand(harness.commands, TELEGRAM_CONNECT_COMMAND_NAME);
  await command.handler(
    `${TELEGRAM_INTERNAL_COMMAND_FLAG} new ${getInternalCommandToken(harness.dispatched[0]!)}`,
    createCommandContext(async () => {
      throw new Error("replacement failed");
    }),
  );
  assert.deepEqual(harness.results, ["failure"]);
  assert.equal(harness.failures.length, 1);
  assert.match(String(harness.failures[0]), /replacement failed/);
  assert.equal(harness.runtime.hasPending(), false);
});

test("Profile completions list every name and mark only the active profile", () => {
  const deps = {
    getProfileNames: () => ["work", "personal", "Build"],
    getActiveProfileName: () => "work",
  };
  assert.deepEqual(getTelegramProfileCompletions(deps, ""), [
    { value: "work", label: "work", description: "active profile" },
    { value: "personal", label: "personal" },
    { value: "Build", label: "Build" },
  ]);
  assert.deepEqual(getTelegramProfileCompletions(deps, "p"), [
    { value: "personal", label: "personal" },
  ]);
  assert.deepEqual(getTelegramProfileCompletions(deps, "W"), [
    { value: "work", label: "work", description: "active profile" },
  ]);
  assert.deepEqual(getTelegramProfileCompletions(deps, "b"), [
    { value: "Build", label: "Build" },
  ]);
  // startsWith only: a substring elsewhere in the name is not a match.
  assert.equal(getTelegramProfileCompletions(deps, "ork"), null);
  const items = getTelegramProfileCompletions(deps, "")!;
  assert.equal(
    items.filter((item) => item.description !== undefined).length,
    1,
  );
  assert.deepEqual(
    getTelegramProfileCompletions(
      { getProfileNames: () => ["a", "b"] },
      "",
    ),
    [
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ],
  );
});

test("Profile completions refuse missing matches, missing profiles and finished words", () => {
  const deps = {
    getProfileNames: () => ["alpha", "beta"],
    getActiveProfileName: () => "alpha",
  };
  assert.equal(getTelegramProfileCompletions(deps, "zzz"), null);
  assert.equal(
    getTelegramProfileCompletions({ getProfileNames: () => [] }, ""),
    null,
  );
  assert.equal(getTelegramProfileCompletions({}, ""), null);
  assert.equal(getTelegramProfileCompletions(deps, "alpha beta"), null);
  assert.equal(getTelegramProfileCompletions(deps, "alpha "), null);
});

test("Setup and connect commands both complete the profile argument", async () => {
  const harness = createCommandRegistrationApiHarness();
  const deps = {
    promptForConfig: async () => {},
    getStatusLines: () => [],
    reloadConfig: async () => {},
    hasBotToken: () => true,
    startPolling: async () => {},
    stopPolling: async () => {},
    updateStatus: () => {},
    getProfileNames: () => ["work", "personal"],
    getActiveProfileName: () => "work",
  };
  registerTelegramBridgeCommands(harness.api, deps);
  for (const name of ["telegram-setup", "telegram-connect"]) {
    const command = getRequiredCommand(harness.commands, name);
    assert.equal(typeof command.getArgumentCompletions, "function");
    assert.deepEqual(command.getArgumentCompletions!(""), getTelegramProfileCompletions(deps, ""));
    assert.deepEqual(command.getArgumentCompletions!("w"), getTelegramProfileCompletions(deps, "w"));
    assert.equal(command.getArgumentCompletions!("zzz"), null);
  }
});

function createNoDefaultProfileConnectHarness(options: {
  profileNames: string[];
  activeProfileName?: string;
  selectedLabel?: string;
  hasUI?: boolean;
}) {
  const harness = createCommandRegistrationApiHarness();
  const events: string[] = [];
  const notifications: string[] = [];
  const activated: string[] = [];
  const selectCalls: Array<{ title: string; items: string[] }> = [];
  let tokenReady = false;
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => {
      events.push("setup");
    },
    getStatusLines: () => [],
    reloadConfig: async () => {
      events.push("reload");
    },
    hasBotToken: () => tokenReady,
    startPolling: async () => {
      events.push("start");
    },
    stopPolling: async () => {},
    updateStatus: () => {
      events.push("status");
    },
    getProfileNames: () => options.profileNames,
    ...("activeProfileName" in options
      ? { getActiveProfileName: () => options.activeProfileName }
      : {}),
    activateProfileConfig: async (_ctx, profileName) => {
      activated.push(profileName);
      tokenReady = true;
      return true;
    },
  });
  const ctx = createBridgeCommandContext(
    (message) => {
      notifications.push(message);
    },
    () => false,
    async (title, items) => {
      selectCalls.push({ title, items });
      return options.selectedLabel;
    },
  );
  (ctx as unknown as { hasUI: boolean }).hasUI = options.hasUI ?? true;
  return { harness, events, notifications, activated, selectCalls, ctx };
}

test("Connect without a default profile offers a menu and connects the chosen profile", async () => {
  const f = createNoDefaultProfileConnectHarness({
    profileNames: ["alpha", "beta"],
    activeProfileName: "beta",
    selectedLabel: "beta (active)",
  });
  await getRequiredCommand(f.harness.commands, "telegram-connect").handler("", f.ctx);
  assert.deepEqual(f.selectCalls, [
    { title: "Select Telegram profile", items: ["alpha", "beta (active)"] },
  ]);
  assert.deepEqual(f.activated, ["beta"]);
  assert.deepEqual(f.events, ["reload", "start", "status"]);
  assert.ok(
    f.notifications.some((message) => message.includes('Activated profile "beta".')),
  );
  assert.ok(
    !f.notifications.some((message) => message.includes("No default Telegram profile")),
  );
});

test("Connect profile menu cancellation ends without connecting", async () => {
  const f = createNoDefaultProfileConnectHarness({
    profileNames: ["alpha", "beta"],
    activeProfileName: "beta",
    selectedLabel: undefined,
  });
  await getRequiredCommand(f.harness.commands, "telegram-connect").handler("", f.ctx);
  assert.equal(f.selectCalls.length, 1);
  assert.deepEqual(f.activated, []);
  assert.deepEqual(f.events, ["reload", "status"]);
  assert.deepEqual(f.notifications, []);
});

test("Connect without a default profile connects the only profile without a menu when interactive", async () => {
  const f = createNoDefaultProfileConnectHarness({
    profileNames: ["solo"],
    hasUI: true,
  });
  await getRequiredCommand(f.harness.commands, "telegram-connect").handler("", f.ctx);
  assert.deepEqual(f.selectCalls, []);
  assert.deepEqual(f.activated, ["solo"]);
  assert.deepEqual(f.events, ["reload", "start", "status"]);
  assert.ok(
    f.notifications.some((message) => message.includes('Activated profile "solo".')),
  );
  assert.ok(
    !f.notifications.some((message) => message.includes("No default Telegram profile")),
  );
});

test("Connect without a default profile notifies without connecting when headless", async () => {
  const f = createNoDefaultProfileConnectHarness({
    profileNames: ["solo"],
    hasUI: false,
  });
  await getRequiredCommand(f.harness.commands, "telegram-connect").handler("", f.ctx);
  assert.deepEqual(f.selectCalls, []);
  assert.deepEqual(f.activated, []);
  assert.deepEqual(f.events, ["reload", "status"]);
  assert.ok(
    f.notifications.some((message) =>
      message.includes(
        "No default Telegram profile configured. Available profiles: solo.",
      ),
    ),
  );
  assert.ok(
    !f.notifications.some((message) => message.includes('Activated profile "solo".')),
  );
});

test("Profile completions mark the default profile active when the active dep returns undefined", () => {
  const deps = {
    getProfileNames: () => [TELEGRAM_DEFAULT_PROFILE_NAME, "work"],
    getActiveProfileName: (): string | undefined => undefined,
  };
  assert.deepEqual(getTelegramProfileCompletions(deps, ""), [
    {
      value: TELEGRAM_DEFAULT_PROFILE_NAME,
      label: TELEGRAM_DEFAULT_PROFILE_NAME,
      description: "active profile",
    },
    { value: "work", label: "work" },
  ]);
  assert.deepEqual(getTelegramProfileCompletions(deps, "d"), [
    {
      value: TELEGRAM_DEFAULT_PROFILE_NAME,
      label: TELEGRAM_DEFAULT_PROFILE_NAME,
      description: "active profile",
    },
  ]);
});

test("Connect profile menu marks the default profile active when the active dep returns undefined", async () => {
  const f = createNoDefaultProfileConnectHarness({
    profileNames: [TELEGRAM_DEFAULT_PROFILE_NAME, "work"],
    activeProfileName: undefined,
    selectedLabel: `${TELEGRAM_DEFAULT_PROFILE_NAME} (active)`,
  });
  await getRequiredCommand(f.harness.commands, "telegram-connect").handler("", f.ctx);
  assert.deepEqual(f.selectCalls, [
    {
      title: "Select Telegram profile",
      items: [`${TELEGRAM_DEFAULT_PROFILE_NAME} (active)`, "work"],
    },
  ]);
  assert.deepEqual(f.activated, [TELEGRAM_DEFAULT_PROFILE_NAME]);
  assert.deepEqual(f.events, ["reload", "start", "status"]);
  assert.ok(
    f.notifications.some((message) =>
      message.includes(`Activated profile "${TELEGRAM_DEFAULT_PROFILE_NAME}".`),
    ),
  );
});

test("Connect profile menu shows no active mark without the active-profile dep", async () => {
  const f = createNoDefaultProfileConnectHarness({
    profileNames: ["alpha", "beta"],
    selectedLabel: "alpha",
  });
  await getRequiredCommand(f.harness.commands, "telegram-connect").handler("", f.ctx);
  assert.deepEqual(f.selectCalls, [
    { title: "Select Telegram profile", items: ["alpha", "beta"] },
  ]);
  assert.deepEqual(f.activated, ["alpha"]);
  assert.deepEqual(f.events, ["reload", "start", "status"]);
});
