/**
 * Regression tests for Telegram command helpers
 * Covers slash-command normalization, bot suffix stripping, arguments, and non-command input
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramAppMenuHtml,
  buildTelegramCommandAction,
  isTelegramReservedCommandName,
  formatTelegramCommandEmojiPrefix,
  createTelegramAppMenuHtmlBuilder,
  createTelegramBotCommandRegistrar,
  createTelegramCommandControlEnqueueAdapter,
  createTelegramCommandControlQueueRuntime,
  createTelegramCommandHandler,
  createTelegramCommandHandlerTargetRuntime,
  createTelegramCommandOrPromptRuntime,
  createTelegramCommandTargetQueueRuntime,
  createTelegramCommandTargetRuntime,
  executeTelegramCommandAction,
  getTelegramCommandExecutionMode,
  getTelegramCommandMessageTarget,
  clearTelegramExtensionCommands,
  findTelegramExtensionCommand,
  handleTelegramAbortCommand,
  handleTelegramCompactCommand,
  handleTelegramCompactConfirmationCallback,
  handleTelegramModelCommand,
  handleTelegramStatusCommand,
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
import type { ExtensionAPI, ExtensionCommandContext } from "../lib/pi.ts";

type RegisteredBridgeCommand = {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

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

test("Command helpers expose Telegram bot command definitions", () => {
  assert.deepEqual(TELEGRAM_COMMAND_EMOJI.model, "🤖");
  assert.deepEqual(TELEGRAM_COMMAND_EMOJI.thinking, "🧠");
  assert.equal(formatTelegramCommandEmojiPrefix("model"), "🤖 ");
  const expectedBuiltins = [
    {
      command: "start",
      description: "🟢 Open menu / Pair bridge",
    },
    { command: "compact", description: "🗜 Compact current session" },
    {
      command: "next",
      description: "⏩ Force next turn",
    },
    {
      command: "continue",
      description: "▶️ Queue continue prompt",
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

test("Command helpers keep extension Telegram bot commands hidden by default", async () => {
  clearTelegramExtensionCommands();
  const dispose = registerTelegramCommand({
    name: "new",
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
    name: "new",
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
      TELEGRAM_BOT_COMMANDS[0],
      TELEGRAM_BOT_COMMANDS[1],
      { command: "new", description: "🆕 Start fresh" },
      ...TELEGRAM_BOT_COMMANDS.slice(2),
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
        name: "new",
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
    name: "/new",
    handler: () => {},
  });
  assert.equal(findTelegramExtensionCommand("new")?.name, "new");
  assert.throws(
    () => registerTelegramCommand({ name: "new", handler: () => {} }),
    /already registered/,
  );
  dispose();
  assert.equal(findTelegramExtensionCommand("new"), undefined);
  clearTelegramExtensionCommands();
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
  await getRequiredCommand(harness.commands, "telegram-setup").handler("", ctx);
  await getRequiredCommand(harness.commands, "telegram-status").handler(
    "",
    ctx,
  );
  assert.deepEqual(events, ["setup"]);
  assert.deepEqual(notifications, ["bot: @demo\npolling: stopped"]);
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
    "update-status",
    "stop",
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
  let statusUpdates = 0;
  registerTelegramBridgeCommands(harness.api, {
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

  await assert.rejects(
    async () => command.handler("", ctx),
    /deletion was not confirmed/,
  );
  assert.equal(statusUpdates, 1);
  assert.match(notifications[0] ?? "", /Keep this Pi session open/);
  assert.match(notifications[0] ?? "", /telegram-status --debug/);
  assert.match(notifications[0] ?? "", /retry \/telegram-disconnect/);
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

test("Command control queue runtime builds, enqueues, and dispatches control items", async () => {
  const calls: string[] = [];
  const enqueueControlItem = createTelegramCommandControlQueueRuntime<string>({
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
    appendControlItem: (item, ctx) => {
      calls.push(`append:${item.controlType}:${ctx}`);
      void item.execute(ctx);
    },
    dispatchNextQueuedTelegramTurn: (ctx) => {
      calls.push(`dispatch:${ctx}`);
    },
  });
  enqueueControlItem(
    { chatId: 7, replyToMessageId: 11 },
    "ctx",
    "model",
    "⚙ model",
    async (ctx) => {
      calls.push(`execute:${ctx}`);
    },
  );
  assert.deepEqual(calls, ["append:model:ctx", "execute:ctx", "dispatch:ctx"]);
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
        `reply:${chatId}:${replyToMessageId}:${text}:${options?.target?.threadId}`,
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
  await runtime.sendTextReply(message, "hello");
  assert.deepEqual(calls, [
    "enqueue:7:11:ctx:status:⚡ status",
    "execute",
    "status:7:11:ctx:42",
    "model:7:11:ctx:42",
    "reply:7:11:Settings menu is unavailable.:42",
    "reply:7:11:hello:42",
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
      getTelegramCommandExecutionMode(buildTelegramCommandAction(commandName)),
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
    "clear-queue:2",
    "fold:false",
    "status",
    "reply:No active turn. Cleared 2 queued turns.",
    "clear",
    "clear-queue:1",
    "fold:false",
    "abort",
    "status",
    "reply:Aborted current turn. Cleared 1 queued turn.",
  ]);
});

test("Command helpers scope abort history preservation to Telegram-owned turns", async () => {
  const events: string[] = [];
  const baseDeps = {
    hasAbortHandler: () => true,
    clearPendingModelSwitch: () => {
      events.push("clear");
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
    "fold:true",
    "abort",
    "status",
    "reply:Aborted current turn.",
    "clear",
    "fold:false",
    "abort",
    "status",
    "reply:Aborted current turn.",
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
    "reply:Cannot compact while Pi or the Telegram queue is busy. Wait for queued turns to finish or send /abort first.",
    "set:true",
    "status",
    "typing:start",
    "compact",
    "reply:🗜 Compaction started.",
    "typing:stop",
    "set:false",
    "status",
    "dispatch",
    "reply:✅ Compaction completed.",
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
    setAllowedUserId: () => {},
    registerBotCommands: async () => {},
    persistConfig: async () => {},
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
    "42:77:plain:Compaction cancelled.",
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
    "42:77:plain:🗜 Compaction started.",
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
    "reply:🗜 Compaction started.",
    "typing:stop",
    "set:false",
    "status",
    "defer",
    "reply:✅ Compaction completed.",
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
      throw new Error("sync boom");
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
    "reply:🗜 Compaction started.",
    "typing:stop",
    "set:false",
    "status",
    "dispatch",
    "event:compact:boom",
    "reply:Compaction failed: boom",
    "throw-set:true",
    "throw-status",
    "throw-typing:start",
    "throw-typing:stop",
    "throw-set:false",
    "throw-status",
    "event:compact:sync boom",
    "reply:Compaction failed: sync boom",
  ]);
});

test("Command helpers execute status and model controls immediately", async () => {
  const events: string[] = [];
  await handleTelegramStatusCommand({
    ctx: "ctx",
    showStatus: async (ctx) => {
      events.push(`show:${ctx}`);
    },
  });
  await handleTelegramModelCommand({
    ctx: "ctx",
    openModelMenu: async (ctx) => {
      events.push(`model:${ctx}`);
    },
  });
  assert.deepEqual(events, ["show:ctx", "model:ctx"]);
});

test("Command menu controls swallow only stale context errors", async () => {
  await handleTelegramStatusCommand({
    ctx: "ctx",
    showStatus: async () => {
      throw new Error("ctx is stale after session reload");
    },
  });
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
    name: "new",
    description: "Start fresh",
    showInMenu: true,
    emoji: "🆕",
    handler: () => {},
  });
  const menuWithExtensionCommand = TELEGRAM_APP_MENU_INTRO_HTML.replace(
    "⏩ /next — Force next turn",
    "🆕 /new — Start fresh\n⏩ /next — Force next turn",
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
  const handleCommand = createTelegramCommandHandlerTargetRuntime<
    {
      chat: { id: number; type?: string };
      message_id: number;
      from?: { id?: number };
    },
    string
  >({
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
    updateStatus: () => {},
    dispatchNextQueuedTelegramTurn: (ctx) => {
      calls.push(`dispatch:${ctx}`);
    },
    enqueueContinueTurn: async (_message, ctx) => {
      calls.push(`continue:${ctx}`);
    },
    compact: () => {},
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
    getAllowedUserId: () => 7,
    setAllowedUserId: () => {},
    setMyCommands: async () => {},
    persistConfig: async () => {},
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
  assert.deepEqual(calls, ["show:ctx", "show:ctx"]);
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
    setAllowedUserId: (userId: number) => {
      allowedUserId = userId;
      events.push(`pair:${userId}`);
    },
    registerBotCommands: async () => {
      events.push("register");
    },
    persistConfig: async () => {
      events.push("persist");
    },
    sendTextReply: async (nextMessage: typeof message, text: string) => {
      events.push(`reply:${nextMessage.message_id}:${text}`);
    },
  };
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
  assert.equal(allowedUserId, 7);
  assert.deepEqual(events, [
    "show:42",
    "model:42",
    "thinking:42",
    "register",
    "pair:7",
    "persist",
    "status",
    "show:42",
    "register",
    "show:42",
    "continue:99",
    "continue:99",
    "compact:true",
    "status",
    "typing:start:42:42:123",
    "compact:start",
    "reply:99:🗜 Compaction started.",
    "typing:stop",
    "compact:false",
    "status",
    "dispatch",
    "reply:99:✅ Compaction completed.",
    "clear-switch",
    "clear-queue",
    "fold:false",
    "abort",
    "status",
    "reply:99:Aborted current turn.",
  ]);
});

test("Command runtime does not first-pair from group start", async () => {
  const events: string[] = [];
  let allowedUserId: number | undefined;
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
    },
    openModelMenu: async () => {},
    openThinkingMenu: async () => {},
    openQueueMenu: async () => {},
    getAllowedUserId: () => allowedUserId,
    setAllowedUserId: (userId: number) => {
      allowedUserId = userId;
      events.push(`pair:${userId}`);
    },
    registerBotCommands: async () => {
      events.push("register");
    },
    persistConfig: async () => {
      events.push("persist");
    },
    sendTextReply: async (_message: typeof message, text: string) => {
      events.push(`reply:${text}`);
    },
  });

  assert.equal(await handleCommand("start", message, {}), true);
  assert.equal(allowedUserId, undefined);
  assert.deepEqual(events, ["register", "show"]);
});

test("Command or prompt runtime routes commands before enqueue fallback", async () => {
  const events: string[] = [];
  const runtime = createTelegramCommandOrPromptRuntime<
    { text: string },
    { id: string }
  >({
    extractRawText: (messages) =>
      messages.map((message) => message.text).join(" "),
    handleCommand: async (commandName, message, ctx) => {
      events.push(`command:${commandName ?? "none"}:${message.text}:${ctx.id}`);
      return commandName === "status";
    },
    executeExtensionCommand: async (command, message, ctx) => {
      events.push(
        `extension:${command.name}:${command.args}:${message.text}:${ctx.id}`,
      );
      return command.name === "review";
    },
    expandPromptTemplateCommand: (commandName, args) =>
      commandName === "review" ? `expanded:${args}` : undefined,
    replaceMessageText: (message, text) => ({ ...message, text }),
    enqueueTurn: async (messages, ctx) => {
      events.push(`enqueue:${messages.length}:${messages[0]?.text}:${ctx.id}`);
    },
  });
  await runtime.dispatchMessages([{ text: "/status" }], { id: "ctx" });
  await runtime.dispatchMessages([{ text: "/review staged" }], { id: "ctx" });
  await runtime.dispatchMessages([{ text: "/fix_tests now" }], { id: "ctx" });
  await runtime.dispatchMessages([{ text: "hello" }], { id: "ctx" });
  await runtime.dispatchMessages([], { id: "ctx" });
  assert.deepEqual(events, [
    "command:status:/status:ctx",
    "command:review:/review staged:ctx",
    "extension:review:staged:/review staged:ctx",
    "command:fix_tests:/fix_tests now:ctx",
    "extension:fix_tests:now:/fix_tests now:ctx",
    "enqueue:1:/fix_tests now:ctx",
    "command:none:hello:ctx",
    "enqueue:1:hello:ctx",
  ]);
});

test("Command or prompt runtime can ignore non-prompt message batches", async () => {
  const events: string[] = [];
  const runtime = createTelegramCommandOrPromptRuntime<
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
  await runtime.dispatchMessages([{ service: true }], { id: "ctx" });
  await runtime.dispatchMessages([{ service: true, text: "hello" }], {
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
      { kind: "help", commandName: "start", executionMode: "immediate" },
      {},
      {},
      deps,
    ),
    true,
  );
  assert.deepEqual(events, ["stop", "help:start"]);
});
