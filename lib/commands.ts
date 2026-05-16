/**
 * Telegram command routing helpers
 * Zones: telegram controls, pi agent commands, queue controls
 * Owns Telegram slash-command normalization, bot command metadata, and pi-side command registration behind runtime ports
 */

import { pairTelegramUserIfNeeded } from "./config.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "./pi.ts";
import {
  createTelegramControlItemBuilder,
  createTelegramControlQueueController,
  type PendingTelegramControlItem,
} from "./queue.ts";

export interface ParsedTelegramCommand {
  name: string;
  args: string;
}

export interface TelegramBotCommandDefinition {
  command: string;
  description: string;
}

export interface TelegramPromptTemplateMenuCommand {
  command: string;
  description?: string;
}

export const TELEGRAM_COMMAND_EMOJI = {
  start: "🟢",
  status: "📊",
  model: "🤖",
  thinking: "🧠",
  compact: "🗜",
  queue: "🔢",
  next: "⏩",
  continue: "▶️",
  abort: "⏹️",
  stop: "🟥",
} as const;

export type TelegramCommandEmojiName = keyof typeof TELEGRAM_COMMAND_EMOJI;

export function getTelegramCommandEmoji(
  command: TelegramCommandEmojiName,
): string {
  return TELEGRAM_COMMAND_EMOJI[command];
}

export function formatTelegramCommandEmojiPrefix(
  command: TelegramCommandEmojiName,
): string {
  return `${getTelegramCommandEmoji(command)} `;
}

function formatTelegramBotCommandDescription(
  command: TelegramCommandEmojiName,
  description: string,
): string {
  return `${formatTelegramCommandEmojiPrefix(command)}${description}`;
}

export const TELEGRAM_BUILTIN_BOT_COMMANDS: readonly TelegramBotCommandDefinition[] =
  [
    {
      command: "start",
      description: formatTelegramBotCommandDescription(
        "start",
        "Open menu / Pair bridge",
      ),
    },
    {
      command: "compact",
      description: formatTelegramBotCommandDescription(
        "compact",
        "Compact current session",
      ),
    },
    {
      command: "next",
      description: formatTelegramBotCommandDescription(
        "next",
        "Force next turn",
      ),
    },
    {
      command: "continue",
      description: formatTelegramBotCommandDescription(
        "continue",
        "Queue continue prompt",
      ),
    },
    {
      command: "abort",
      description: formatTelegramBotCommandDescription("abort", "Abort π"),
    },
    {
      command: "stop",
      description: formatTelegramBotCommandDescription(
        "stop",
        "Abort π & Clear queue",
      ),
    },
  ];

export const TELEGRAM_BOT_COMMANDS = TELEGRAM_BUILTIN_BOT_COMMANDS;

export interface TelegramBotCommandRegistrationDeps {
  setMyCommands: (
    commands: readonly TelegramBotCommandDefinition[],
  ) => Promise<unknown>;
}

export async function registerTelegramBotCommands(
  deps: TelegramBotCommandRegistrationDeps,
): Promise<void> {
  await deps.setMyCommands(TELEGRAM_BOT_COMMANDS);
}

export function createTelegramBotCommandRegistrar(
  deps: TelegramBotCommandRegistrationDeps,
): () => Promise<void> {
  return () => registerTelegramBotCommands(deps);
}

export interface TelegramBridgeCommandStartPollingOptions {
  force?: boolean;
}

export interface TelegramBridgeCommandStartPollingResult {
  ok: boolean;
  message?: string;
  canTakeover?: boolean;
  owner?: string;
}

export interface TelegramBridgeCommandRegistrationDeps {
  promptForConfig: (ctx: ExtensionCommandContext) => Promise<void>;
  getStatusLines: () => string[];
  reloadConfig: () => Promise<void>;
  hasBotToken: () => boolean;
  startPolling: (
    ctx: ExtensionCommandContext,
    options?: TelegramBridgeCommandStartPollingOptions,
  ) =>
    | void
    | Promise<void | TelegramBridgeCommandStartPollingResult>
    | TelegramBridgeCommandStartPollingResult;
  stopPolling: () => Promise<void | string>;
  updateStatus: (ctx: ExtensionCommandContext) => void;
}

function formatTelegramTakeoverTitle(ctx: ExtensionCommandContext): string {
  return ctx.ui.theme.fg("accent", "pi-telegram");
}

function formatTelegramTakeoverPrompt(
  ctx: ExtensionCommandContext,
  owner?: string,
): string {
  const theme = ctx.ui.theme;
  const action = theme.fg("warning", "move singleton lock here?");
  const from = theme.fg("muted", "from:");
  const to = theme.fg("muted", "to:");
  const source = owner ?? "another π instance";
  return `${action}\n\n${from} ${source}\n${to} ${ctx.cwd}`;
}

export function registerTelegramBridgeCommands(
  pi: ExtensionAPI,
  deps: TelegramBridgeCommandRegistrationDeps,
): void {
  pi.registerCommand("telegram-setup", {
    description: "Configure Telegram bot token",
    handler: async (_args, ctx) => {
      await deps.promptForConfig(ctx);
    },
  });
  pi.registerCommand("telegram-status", {
    description: "Show Telegram bridge status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(deps.getStatusLines().join("\n"), "info");
    },
  });
  pi.registerCommand("telegram-connect", {
    description: "Start the Telegram bridge in this π session",
    handler: async (_args, ctx) => {
      await deps.reloadConfig();
      if (!deps.hasBotToken()) {
        await deps.promptForConfig(ctx);
        return;
      }
      let result = await deps.startPolling(ctx);
      if (result && !result.ok && result.canTakeover) {
        const confirmed = await ctx.ui.confirm(
          formatTelegramTakeoverTitle(ctx),
          formatTelegramTakeoverPrompt(ctx, result.owner),
        );
        if (!confirmed) {
          ctx.ui.notify("Telegram bridge takeover cancelled.", "info");
          deps.updateStatus(ctx);
          return;
        }
        result = await deps.startPolling(ctx, { force: true });
      }
      if (result?.message) {
        ctx.ui.notify(result.message, result.ok ? "info" : "warning");
      }
      deps.updateStatus(ctx);
    },
  });
  pi.registerCommand("telegram-disconnect", {
    description: "Stop the Telegram bridge in this π session",
    handler: async (_args, ctx) => {
      const message = await deps.stopPolling();
      if (message) ctx.ui.notify(message, "info");
      deps.updateStatus(ctx);
    },
  });
}

export const TELEGRAM_RESERVED_COMMAND_NAMES = [
  "stop",
  "abort",
  "next",
  "continue",
  "status",
  "queue",
  "compact",
  "model",
  "thinking",
  "settings",
  "help",
  "start",
] as const;

export type TelegramReservedCommandName =
  (typeof TELEGRAM_RESERVED_COMMAND_NAMES)[number];

const TELEGRAM_RESERVED_COMMAND_NAME_SET = new Set<string>(
  TELEGRAM_RESERVED_COMMAND_NAMES,
);

export function isTelegramReservedCommandName(
  commandName: string | undefined,
): commandName is TelegramReservedCommandName {
  return (
    commandName !== undefined &&
    TELEGRAM_RESERVED_COMMAND_NAME_SET.has(commandName)
  );
}

export type TelegramCommandAction =
  | { kind: "ignore"; executionMode: "ignored" }
  | { kind: "stop"; executionMode: "immediate" }
  | { kind: "abort"; executionMode: "immediate" }
  | { kind: "next"; executionMode: "immediate" }
  | { kind: "continue"; executionMode: "immediate" }
  | { kind: "queue"; executionMode: "immediate" }
  | { kind: "compact"; executionMode: "immediate" }
  | { kind: "status"; executionMode: "immediate" }
  | { kind: "model"; executionMode: "immediate" }
  | { kind: "thinking"; executionMode: "immediate" }
  | { kind: "settings"; executionMode: "immediate" }
  | {
      kind: "help";
      commandName: "help" | "start";
      executionMode: "immediate";
    };

export type TelegramCommandExecutionMode = "ignored" | "immediate";

export interface TelegramCommandActionDeps<TMessage, TContext> {
  handleStop: (message: TMessage, ctx: TContext) => Promise<void>;
  handleAbort: (message: TMessage, ctx: TContext) => Promise<void>;
  handleNext: (message: TMessage, ctx: TContext) => Promise<void>;
  handleContinue: (message: TMessage, ctx: TContext) => Promise<void>;
  handleQueue: (message: TMessage, ctx: TContext) => Promise<void>;
  handleCompact: (message: TMessage, ctx: TContext) => Promise<void>;
  handleStatus: (message: TMessage, ctx: TContext) => Promise<void>;
  handleModel: (message: TMessage, ctx: TContext) => Promise<void>;
  handleThinking: (message: TMessage, ctx: TContext) => Promise<void>;
  handleSettings?: (message: TMessage, ctx: TContext) => Promise<void>;
  handleHelp: (
    message: TMessage,
    commandName: "help" | "start",
    ctx: TContext,
  ) => Promise<void>;
}

export interface TelegramStopCommandDeps {
  hasAbortHandler: () => boolean;
  clearPendingModelSwitch: () => void;
  clearQueuedTelegramItems: () => number;
  setPreserveQueuedTurnsAsHistory: (preserve: boolean) => void;
  abortCurrentTurn: () => void;
  updateStatus: () => void;
  sendTextReply: (text: string) => Promise<void>;
}

export interface TelegramRuntimeEventRecorderPort {
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramCompactCommandDeps extends TelegramRuntimeEventRecorderPort {
  isIdle: () => boolean;
  hasPendingMessages: () => boolean;
  hasActiveTelegramTurn: () => boolean;
  hasDispatchPending: () => boolean;
  hasQueuedTelegramItems: () => boolean;
  isCompactionInProgress: () => boolean;
  setCompactionInProgress: (inProgress: boolean) => void;
  updateStatus: () => void;
  dispatchNextQueuedTelegramTurn: () => void;
  requestDeferredDispatchNextQueuedTelegramTurn?: (
    dispatch: () => void,
  ) => void;
  startTypingLoop?: () => void;
  stopTypingLoop?: () => void;
  compact: (callbacks: {
    onComplete: () => void;
    onError: (error: unknown) => void;
  }) => void;
  sendTextReply: (text: string) => Promise<void>;
}

export type TelegramControlCommandType =
  PendingTelegramControlItem<unknown>["controlType"];

export interface TelegramCommandRuntimeMessage {
  chat: { id: number };
  message_id: number;
  from?: { id?: number };
}

export interface TelegramCommandMessageTarget {
  chatId: number;
  replyToMessageId: number;
}

export interface TelegramCommandTargetRuntimeDeps<TContext> {
  enqueueControlItem: (
    target: TelegramCommandMessageTarget,
    ctx: TContext,
    controlType: TelegramControlCommandType,
    statusSummary: string,
    execute: (ctx: TContext) => Promise<void>,
  ) => void;
  showStatus: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  openModelMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  openSettingsMenu?: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
  ) => Promise<void>;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
  ) => Promise<unknown>;
}

export interface TelegramCommandTargetRuntime<
  TMessage extends TelegramCommandRuntimeMessage,
  TContext,
> {
  enqueueControlItem: (
    message: TMessage,
    ctx: TContext,
    controlType: TelegramControlCommandType,
    statusSummary: string,
    execute: (ctx: TContext) => Promise<void>,
  ) => void;
  showStatus: (message: TMessage, ctx: TContext) => Promise<void>;
  openModelMenu: (message: TMessage, ctx: TContext) => Promise<void>;
  openSettingsMenu: (message: TMessage, ctx: TContext) => Promise<void>;
  sendTextReply: (message: TMessage, text: string) => Promise<void>;
}

export function getTelegramCommandMessageTarget(
  message: TelegramCommandRuntimeMessage,
): TelegramCommandMessageTarget {
  return {
    chatId: message.chat.id,
    replyToMessageId: message.message_id,
  };
}

export interface TelegramCommandControlQueueRuntimeDeps<TContext> {
  createControlItem: (options: {
    chatId: number;
    replyToMessageId: number;
    controlType: TelegramControlCommandType;
    statusSummary: string;
    execute: (ctx: TContext) => Promise<void>;
  }) => PendingTelegramControlItem<TContext>;
  appendControlItem: (
    item: PendingTelegramControlItem<TContext>,
    ctx: TContext,
  ) => void;
  dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
}

export function createTelegramCommandControlQueueRuntime<TContext>(
  deps: TelegramCommandControlQueueRuntimeDeps<TContext>,
): TelegramCommandTargetRuntimeDeps<TContext>["enqueueControlItem"] {
  const controlQueueController = createTelegramControlQueueController({
    appendControlItem: deps.appendControlItem,
    dispatchNextQueuedTelegramTurn: deps.dispatchNextQueuedTelegramTurn,
  });
  return createTelegramCommandControlEnqueueAdapter({
    createControlItem: deps.createControlItem,
    enqueueControlItem: controlQueueController.enqueue,
  });
}

export function createTelegramCommandControlEnqueueAdapter<TContext>(deps: {
  createControlItem: (options: {
    chatId: number;
    replyToMessageId: number;
    controlType: TelegramControlCommandType;
    statusSummary: string;
    execute: (ctx: TContext) => Promise<void>;
  }) => PendingTelegramControlItem<TContext>;
  enqueueControlItem: (
    item: PendingTelegramControlItem<TContext>,
    ctx: TContext,
  ) => void;
}): TelegramCommandTargetRuntimeDeps<TContext>["enqueueControlItem"] {
  return (target, ctx, controlType, statusSummary, execute) => {
    deps.enqueueControlItem(
      deps.createControlItem({
        ...target,
        controlType,
        statusSummary,
        execute,
      }),
      ctx,
    );
  };
}

export type TelegramCommandTargetQueueRuntimeDeps<TContext> =
  TelegramCommandControlQueueRuntimeDeps<TContext> &
    Omit<TelegramCommandTargetRuntimeDeps<TContext>, "enqueueControlItem">;

export function createTelegramCommandTargetQueueRuntime<
  TMessage extends TelegramCommandRuntimeMessage,
  TContext,
>(
  deps: TelegramCommandTargetQueueRuntimeDeps<TContext>,
): TelegramCommandTargetRuntime<TMessage, TContext> {
  return createTelegramCommandTargetRuntime({
    enqueueControlItem: createTelegramCommandControlQueueRuntime({
      createControlItem: deps.createControlItem,
      appendControlItem: deps.appendControlItem,
      dispatchNextQueuedTelegramTurn: deps.dispatchNextQueuedTelegramTurn,
    }),
    showStatus: deps.showStatus,
    openModelMenu: deps.openModelMenu,
    openSettingsMenu: deps.openSettingsMenu,
    sendTextReply: deps.sendTextReply,
  });
}

export function createTelegramCommandTargetRuntime<
  TMessage extends TelegramCommandRuntimeMessage,
  TContext,
>(
  deps: TelegramCommandTargetRuntimeDeps<TContext>,
): TelegramCommandTargetRuntime<TMessage, TContext> {
  return {
    enqueueControlItem: (message, ctx, controlType, statusSummary, execute) => {
      deps.enqueueControlItem(
        getTelegramCommandMessageTarget(message),
        ctx,
        controlType,
        statusSummary,
        execute,
      );
    },
    showStatus: (message, ctx) => {
      const target = getTelegramCommandMessageTarget(message);
      return deps.showStatus(target.chatId, target.replyToMessageId, ctx);
    },
    openModelMenu: (message, ctx) => {
      const target = getTelegramCommandMessageTarget(message);
      return deps.openModelMenu(target.chatId, target.replyToMessageId, ctx);
    },
    openSettingsMenu: async (message, ctx) => {
      const target = getTelegramCommandMessageTarget(message);
      if (!deps.openSettingsMenu) {
        await deps.sendTextReply(
          target.chatId,
          target.replyToMessageId,
          "Settings menu is unavailable.",
        );
        return;
      }
      await deps.openSettingsMenu(target.chatId, target.replyToMessageId, ctx);
    },
    sendTextReply: async (message, text) => {
      const target = getTelegramCommandMessageTarget(message);
      await deps.sendTextReply(target.chatId, target.replyToMessageId, text);
    },
  };
}

export interface TelegramCommandOrPromptRuntimeDeps<TMessage, TContext> {
  extractRawText: (messages: TMessage[]) => string;
  handleCommand: (
    commandName: string | undefined,
    message: TMessage,
    ctx: TContext,
  ) => Promise<boolean>;
  expandPromptTemplateCommand?: (
    commandName: string,
    args: string,
  ) => string | undefined;
  replaceMessageText: (message: TMessage, text: string) => TMessage;
  enqueueTurn: (messages: TMessage[], ctx: TContext) => Promise<void>;
}

export interface TelegramCommandRuntimeDeps<
  TMessage extends TelegramCommandRuntimeMessage,
  TContext,
> extends TelegramRuntimeEventRecorderPort {
  hasAbortHandler: () => boolean;
  clearPendingModelSwitch: () => void;
  hasQueuedTelegramItems: () => boolean;
  clearQueuedTelegramItems: (ctx: TContext) => number;
  setPreserveQueuedTurnsAsHistory: (preserve: boolean) => void;
  abortCurrentTurn: () => void;
  isIdle: (ctx: TContext) => boolean;
  hasPendingMessages: (ctx: TContext) => boolean;
  hasActiveTelegramTurn: () => boolean;
  hasDispatchPending: () => boolean;
  isCompactionInProgress: () => boolean;
  setCompactionInProgress: (inProgress: boolean) => void;
  updateStatus: (ctx: TContext) => void;
  dispatchNextQueuedTelegramTurn: (ctx: TContext) => void;
  requestDeferredDispatchNextQueuedTelegramTurn?: (
    dispatch: (ctx: TContext) => void,
  ) => void;
  startTypingLoop?: (ctx: TContext, chatId?: number) => void;
  stopTypingLoop?: () => void;
  enqueueContinueTurn: (message: TMessage, ctx: TContext) => Promise<void>;
  compact: (
    ctx: TContext,
    callbacks: { onComplete: () => void; onError: (error: unknown) => void },
  ) => void;
  enqueueControlItem: (
    message: TMessage,
    ctx: TContext,
    controlType: TelegramControlCommandType,
    statusSummary: string,
    execute: (ctx: TContext) => Promise<void>,
  ) => void;
  showStatus: (message: TMessage, ctx: TContext) => Promise<void>;
  openModelMenu: (message: TMessage, ctx: TContext) => Promise<void>;
  openThinkingMenu: (message: TMessage, ctx: TContext) => Promise<void>;
  openQueueMenu: (message: TMessage, ctx: TContext) => Promise<void>;
  openSettingsMenu?: (message: TMessage, ctx: TContext) => Promise<void>;
  getAllowedUserId: () => number | undefined;
  setAllowedUserId: (userId: number) => void;
  registerBotCommands: () => Promise<void>;
  getPromptTemplateCommands?: () => readonly TelegramPromptTemplateMenuCommand[];
  persistConfig: () => Promise<void>;
  sendTextReply: (message: TMessage, text: string) => Promise<void>;
}

export const TELEGRAM_APP_MENU_INTRO_HTML = [
  "<b>π Telegram</b>",
  "",
  `${formatTelegramCommandEmojiPrefix("start")}/start — Open menu / Pair bridge`,
  `${formatTelegramCommandEmojiPrefix("compact")}/compact — Compact current session`,
  `${formatTelegramCommandEmojiPrefix("next")}/next — Force next turn`,
  `${formatTelegramCommandEmojiPrefix("continue")}/continue — Queue continue prompt`,
  `${formatTelegramCommandEmojiPrefix("abort")}/abort — Abort π`,
  `${formatTelegramCommandEmojiPrefix("stop")}/stop — Abort π & Clear queue`,
].join("\n");

function escapeTelegramCommandMenuHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildTelegramPromptTemplateMenuHtml(
  promptTemplates: readonly TelegramPromptTemplateMenuCommand[] = [],
): string {
  if (promptTemplates.length === 0) return "";
  return promptTemplates
    .map((template) => `🧩 /${escapeTelegramCommandMenuHtml(template.command)}`)
    .join("\n");
}

export function buildTelegramAppMenuHtml(
  statusHtml: string,
  promptTemplates: readonly TelegramPromptTemplateMenuCommand[] = [],
): string {
  const promptTemplateHtml =
    buildTelegramPromptTemplateMenuHtml(promptTemplates);
  if (!promptTemplateHtml)
    return `${TELEGRAM_APP_MENU_INTRO_HTML}\n\n${statusHtml}`;
  return `${TELEGRAM_APP_MENU_INTRO_HTML}\n\n${promptTemplateHtml}\n\n${statusHtml}`;
}

export function createTelegramAppMenuHtmlBuilder<TContext>(deps: {
  buildStatusHtml: (ctx: TContext) => string;
  getPromptTemplateCommands?: () => readonly TelegramPromptTemplateMenuCommand[];
}): (ctx: TContext) => string {
  return function buildTelegramAppMenuHtmlForContext(ctx) {
    return buildTelegramAppMenuHtml(
      deps.buildStatusHtml(ctx),
      deps.getPromptTemplateCommands?.(),
    );
  };
}

function getTelegramCommandErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseTelegramCommand(
  text: string,
): ParsedTelegramCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const [head, ...tail] = trimmed.split(/\s+/);
  const name = head.slice(1).split("@")[0]?.toLowerCase();
  if (!name) return undefined;
  return { name, args: tail.join(" ").trim() };
}

export const TELEGRAM_COMMAND_ACTIONS = {
  stop: { kind: "stop", executionMode: "immediate" },
  abort: { kind: "abort", executionMode: "immediate" },
  next: { kind: "next", executionMode: "immediate" },
  continue: { kind: "continue", executionMode: "immediate" },
  status: { kind: "status", executionMode: "immediate" },
  queue: { kind: "queue", executionMode: "immediate" },
  compact: { kind: "compact", executionMode: "immediate" },
  model: { kind: "model", executionMode: "immediate" },
  thinking: { kind: "thinking", executionMode: "immediate" },
  settings: { kind: "settings", executionMode: "immediate" },
  help: { kind: "help", commandName: "help", executionMode: "immediate" },
  start: { kind: "help", commandName: "start", executionMode: "immediate" },
} as const satisfies Record<TelegramReservedCommandName, TelegramCommandAction>;

export function buildTelegramCommandAction(
  commandName: string | undefined,
): TelegramCommandAction {
  if (!isTelegramReservedCommandName(commandName)) {
    return { kind: "ignore", executionMode: "ignored" };
  }
  return TELEGRAM_COMMAND_ACTIONS[commandName];
}

export function getTelegramCommandExecutionMode(
  action: TelegramCommandAction,
): TelegramCommandExecutionMode {
  return action.executionMode;
}

function formatTelegramQueuedTurnCount(count: number): string {
  return count === 1 ? "1 queued turn" : `${count} queued turns`;
}

export async function handleTelegramStopCommand(
  deps: TelegramStopCommandDeps,
): Promise<void> {
  deps.clearPendingModelSwitch();
  const clearedCount = deps.clearQueuedTelegramItems();
  deps.setPreserveQueuedTurnsAsHistory(false);
  if (!deps.hasAbortHandler()) {
    const clearedSuffix =
      clearedCount > 0
        ? ` Cleared ${formatTelegramQueuedTurnCount(clearedCount)}.`
        : "";
    if (clearedCount > 0) deps.updateStatus();
    await deps.sendTextReply(`No active turn.${clearedSuffix}`);
    return;
  }
  deps.abortCurrentTurn();
  deps.updateStatus();
  const clearedSuffix =
    clearedCount > 0
      ? ` Cleared ${formatTelegramQueuedTurnCount(clearedCount)}.`
      : "";
  await deps.sendTextReply(`Aborted current turn.${clearedSuffix}`);
}

export async function handleTelegramAbortCommand(deps: {
  hasAbortHandler: () => boolean;
  clearPendingModelSwitch: () => void;
  abortCurrentTurn: () => void;
  setPreserveForIdle: () => void;
  updateStatus: () => void;
  sendTextReply: (text: string) => Promise<void>;
}): Promise<void> {
  deps.clearPendingModelSwitch();
  if (!deps.hasAbortHandler()) {
    await deps.sendTextReply("No active turn.");
    return;
  }
  deps.setPreserveForIdle();
  deps.abortCurrentTurn();
  deps.updateStatus();
  await deps.sendTextReply("Aborted current turn.");
}

export async function handleTelegramNextCommand(deps: {
  hasAbortHandler: () => boolean;
  isIdle: () => boolean;
  hasQueuedItems: () => boolean;
  clearPendingModelSwitch: () => void;
  abortCurrentTurn: () => void;
  dispatchNextQueuedTurn: () => void;
  setPreserveForDispatch: () => void;
  updateStatus: () => void;
  sendTextReply: (text: string) => Promise<void>;
}): Promise<void> {
  deps.clearPendingModelSwitch();
  if (!deps.hasQueuedItems()) {
    await deps.sendTextReply("<b>Queue is empty.</b>");
    return;
  }
  if (!deps.isIdle() && deps.hasAbortHandler()) {
    deps.setPreserveForDispatch();
    deps.abortCurrentTurn();
    deps.updateStatus();
    await deps.sendTextReply(
      "Aborted current turn. Dispatching next queued turn.",
    );
    return;
  }
  if (!deps.isIdle()) {
    await deps.sendTextReply("π is busy. Send /abort or /stop first.");
    return;
  }
  deps.dispatchNextQueuedTurn();
  deps.updateStatus();
  await deps.sendTextReply("Dispatching next queued turn.");
}

export async function handleTelegramContinueCommand<TMessage, TContext>(
  message: TMessage,
  ctx: TContext,
  deps: {
    enqueueContinueTurn: (message: TMessage, ctx: TContext) => Promise<void>;
  },
): Promise<void> {
  await deps.enqueueContinueTurn(message, ctx);
}

function dispatchNextQueuedTelegramTurnAfterCompact(
  deps: Pick<
    TelegramCompactCommandDeps,
    | "dispatchNextQueuedTelegramTurn"
    | "requestDeferredDispatchNextQueuedTelegramTurn"
  >,
): void {
  if (deps.requestDeferredDispatchNextQueuedTelegramTurn) {
    deps.requestDeferredDispatchNextQueuedTelegramTurn(
      deps.dispatchNextQueuedTelegramTurn,
    );
    return;
  }
  deps.dispatchNextQueuedTelegramTurn();
}

export async function handleTelegramCompactCommand(
  deps: TelegramCompactCommandDeps,
): Promise<void> {
  if (
    !deps.isIdle() ||
    deps.hasPendingMessages() ||
    deps.hasActiveTelegramTurn() ||
    deps.hasDispatchPending() ||
    deps.hasQueuedTelegramItems() ||
    deps.isCompactionInProgress()
  ) {
    await deps.sendTextReply(
      "Cannot compact while π or the Telegram queue is busy. Wait for queued turns to finish or send /abort first.",
    );
    return;
  }
  deps.setCompactionInProgress(true);
  deps.updateStatus();
  let compactionStillInProgress = true;
  try {
    deps.compact({
      onComplete: () => {
        compactionStillInProgress = false;
        deps.stopTypingLoop?.();
        deps.setCompactionInProgress(false);
        deps.updateStatus();
        dispatchNextQueuedTelegramTurnAfterCompact(deps);
        void deps.sendTextReply("Compaction completed.");
      },
      onError: (error) => {
        compactionStillInProgress = false;
        deps.stopTypingLoop?.();
        deps.setCompactionInProgress(false);
        deps.updateStatus();
        dispatchNextQueuedTelegramTurnAfterCompact(deps);
        deps.recordRuntimeEvent?.("compact", error);
        const errorMessage = getTelegramCommandErrorMessage(error);
        void deps.sendTextReply(`Compaction failed: ${errorMessage}`);
      },
    });
  } catch (error) {
    compactionStillInProgress = false;
    deps.stopTypingLoop?.();
    deps.setCompactionInProgress(false);
    deps.updateStatus();
    deps.recordRuntimeEvent?.("compact", error);
    const errorMessage = getTelegramCommandErrorMessage(error);
    await deps.sendTextReply(`Compaction failed: ${errorMessage}`);
    return;
  }
  await deps.sendTextReply("Compaction started.");
  if (compactionStillInProgress) deps.startTypingLoop?.();
}

function isTelegramStaleContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("stale after session") ||
      error.message.includes("stale ctx"))
  );
}

export async function handleTelegramStatusCommand<TContext>(deps: {
  ctx: TContext;
  showStatus: (ctx: TContext) => Promise<void>;
}): Promise<void> {
  try {
    await deps.showStatus(deps.ctx);
  } catch (error) {
    if (!isTelegramStaleContextError(error)) throw error;
  }
}

export async function handleTelegramModelCommand<TContext>(deps: {
  ctx: TContext;
  openModelMenu: (ctx: TContext) => Promise<void>;
}): Promise<void> {
  try {
    await deps.openModelMenu(deps.ctx);
  } catch (error) {
    if (!isTelegramStaleContextError(error)) throw error;
  }
}

export async function executeTelegramCommandAction<TMessage, TContext>(
  action: TelegramCommandAction,
  message: TMessage,
  ctx: TContext,
  deps: TelegramCommandActionDeps<TMessage, TContext>,
): Promise<boolean> {
  switch (action.kind) {
    case "ignore":
      return false;
    case "stop":
      await deps.handleStop(message, ctx);
      return true;
    case "abort":
      await deps.handleAbort(message, ctx);
      return true;
    case "next":
      await deps.handleNext(message, ctx);
      return true;
    case "continue":
      await deps.handleContinue(message, ctx);
      return true;
    case "queue":
      await deps.handleQueue(message, ctx);
      return true;
    case "compact":
      await deps.handleCompact(message, ctx);
      return true;
    case "status":
      await deps.handleStatus(message, ctx);
      return true;
    case "model":
      await deps.handleModel(message, ctx);
      return true;
    case "thinking":
      await deps.handleThinking(message, ctx);
      return true;
    case "settings":
      if (!deps.handleSettings) return false;
      await deps.handleSettings(message, ctx);
      return true;
    case "help":
      await deps.handleHelp(message, action.commandName, ctx);
      return true;
  }
}

export interface TelegramCommandHandlerTargetRuntimeDeps<
  TMessage extends TelegramCommandRuntimeMessage,
  TContext,
>
  extends
    Omit<
      TelegramCommandRuntimeDeps<TMessage, TContext>,
      | "enqueueControlItem"
      | "showStatus"
      | "openModelMenu"
      | "openSettingsMenu"
      | "sendTextReply"
      | "registerBotCommands"
    >,
    Omit<TelegramCommandTargetQueueRuntimeDeps<TContext>, "createControlItem">,
    TelegramBotCommandRegistrationDeps {
  allocateItemOrder: () => number;
  allocateControlOrder: () => number;
}

export function createTelegramCommandHandlerTargetRuntime<
  TMessage extends TelegramCommandRuntimeMessage,
  TContext,
>(
  deps: TelegramCommandHandlerTargetRuntimeDeps<TMessage, TContext>,
): (
  commandName: string | undefined,
  message: TMessage,
  ctx: TContext,
) => Promise<boolean> {
  const commandTargetRuntime = createTelegramCommandTargetQueueRuntime<
    TMessage,
    TContext
  >({
    createControlItem: createTelegramControlItemBuilder<TContext>({
      allocateItemOrder: deps.allocateItemOrder,
      allocateControlOrder: deps.allocateControlOrder,
    }),
    appendControlItem: deps.appendControlItem,
    dispatchNextQueuedTelegramTurn: deps.dispatchNextQueuedTelegramTurn,
    showStatus: deps.showStatus,
    openModelMenu: deps.openModelMenu,
    openSettingsMenu: deps.openSettingsMenu,
    sendTextReply: deps.sendTextReply,
  });
  return createTelegramCommandHandler({
    hasAbortHandler: deps.hasAbortHandler,
    clearPendingModelSwitch: deps.clearPendingModelSwitch,
    hasQueuedTelegramItems: deps.hasQueuedTelegramItems,
    clearQueuedTelegramItems: deps.clearQueuedTelegramItems,
    setPreserveQueuedTurnsAsHistory: deps.setPreserveQueuedTurnsAsHistory,
    abortCurrentTurn: deps.abortCurrentTurn,
    isIdle: deps.isIdle,
    hasPendingMessages: deps.hasPendingMessages,
    hasActiveTelegramTurn: deps.hasActiveTelegramTurn,
    hasDispatchPending: deps.hasDispatchPending,
    isCompactionInProgress: deps.isCompactionInProgress,
    setCompactionInProgress: deps.setCompactionInProgress,
    updateStatus: deps.updateStatus,
    dispatchNextQueuedTelegramTurn: deps.dispatchNextQueuedTelegramTurn,
    startTypingLoop: deps.startTypingLoop,
    stopTypingLoop: deps.stopTypingLoop,
    enqueueContinueTurn: deps.enqueueContinueTurn,
    compact: deps.compact,
    enqueueControlItem: commandTargetRuntime.enqueueControlItem,
    showStatus: commandTargetRuntime.showStatus,
    openModelMenu: commandTargetRuntime.openModelMenu,
    openThinkingMenu: deps.openThinkingMenu,
    openQueueMenu: deps.openQueueMenu,
    openSettingsMenu: commandTargetRuntime.openSettingsMenu,
    getAllowedUserId: deps.getAllowedUserId,
    setAllowedUserId: deps.setAllowedUserId,
    registerBotCommands: createTelegramBotCommandRegistrar({
      setMyCommands: deps.setMyCommands,
    }),
    persistConfig: deps.persistConfig,
    sendTextReply: commandTargetRuntime.sendTextReply,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
}

export function createTelegramCommandHandler<
  TMessage extends TelegramCommandRuntimeMessage,
  TContext,
>(deps: TelegramCommandRuntimeDeps<TMessage, TContext>) {
  return async function handleTelegramCommand(
    commandName: string | undefined,
    message: TMessage,
    ctx: TContext,
  ): Promise<boolean> {
    return handleTelegramCommandRuntime(commandName, message, ctx, deps);
  };
}

export function createTelegramCommandOrPromptRuntime<TMessage, TContext>(
  deps: TelegramCommandOrPromptRuntimeDeps<TMessage, TContext>,
) {
  return {
    dispatchMessages: async (
      messages: TMessage[],
      ctx: TContext,
    ): Promise<void> => {
      const firstMessage = messages[0];
      if (!firstMessage) return;
      const command = parseTelegramCommand(deps.extractRawText(messages));
      const handled = await deps.handleCommand(
        command?.name,
        firstMessage,
        ctx,
      );
      if (handled) return;
      if (command?.name && deps.expandPromptTemplateCommand) {
        const expanded = deps.expandPromptTemplateCommand(
          command.name,
          command.args,
        );
        if (expanded !== undefined) {
          await deps.enqueueTurn(
            [
              deps.replaceMessageText(firstMessage, expanded),
              ...messages.slice(1),
            ],
            ctx,
          );
          return;
        }
      }
      await deps.enqueueTurn(messages, ctx);
    },
  };
}

async function handleTelegramCommandRuntime<
  TMessage extends TelegramCommandRuntimeMessage,
  TContext,
>(
  commandName: string | undefined,
  message: TMessage,
  ctx: TContext,
  deps: TelegramCommandRuntimeDeps<TMessage, TContext>,
): Promise<boolean> {
  const sendReplyFor = (nextMessage: TMessage) => (text: string) =>
    deps.sendTextReply(nextMessage, text);
  const updateStatusFor = (commandCtx: TContext) => () =>
    deps.updateStatus(commandCtx);
  return executeTelegramCommandAction(
    buildTelegramCommandAction(commandName),
    message,
    ctx,
    {
      handleStop: async (nextMessage, commandCtx) => {
        await handleTelegramStopCommand({
          hasAbortHandler: deps.hasAbortHandler,
          clearPendingModelSwitch: deps.clearPendingModelSwitch,
          clearQueuedTelegramItems: () =>
            deps.clearQueuedTelegramItems(commandCtx),
          setPreserveQueuedTurnsAsHistory: deps.setPreserveQueuedTurnsAsHistory,
          abortCurrentTurn: deps.abortCurrentTurn,
          updateStatus: updateStatusFor(commandCtx),
          sendTextReply: sendReplyFor(nextMessage),
        });
      },
      handleAbort: async (nextMessage, commandCtx) => {
        await handleTelegramAbortCommand({
          hasAbortHandler: deps.hasAbortHandler,
          clearPendingModelSwitch: deps.clearPendingModelSwitch,
          abortCurrentTurn: deps.abortCurrentTurn,
          setPreserveForIdle: () => deps.setPreserveQueuedTurnsAsHistory(true),
          updateStatus: updateStatusFor(commandCtx),
          sendTextReply: sendReplyFor(nextMessage),
        });
      },
      handleNext: async (nextMessage, commandCtx) => {
        await handleTelegramNextCommand({
          hasAbortHandler: deps.hasAbortHandler,
          isIdle: () => deps.isIdle(commandCtx),
          hasQueuedItems: deps.hasQueuedTelegramItems,
          clearPendingModelSwitch: deps.clearPendingModelSwitch,
          abortCurrentTurn: deps.abortCurrentTurn,
          dispatchNextQueuedTurn: () =>
            deps.dispatchNextQueuedTelegramTurn(commandCtx),
          setPreserveForDispatch: () =>
            deps.setPreserveQueuedTurnsAsHistory(false),
          updateStatus: updateStatusFor(commandCtx),
          sendTextReply: sendReplyFor(nextMessage),
        });
      },
      handleContinue: async (nextMessage, commandCtx) => {
        await handleTelegramContinueCommand(nextMessage, commandCtx, {
          enqueueContinueTurn: deps.enqueueContinueTurn,
        });
      },
      handleQueue: async (nextMessage, commandCtx) => {
        await deps.openQueueMenu(nextMessage, commandCtx);
      },
      handleCompact: async (nextMessage, commandCtx) => {
        await handleTelegramCompactCommand({
          isIdle: () => deps.isIdle(commandCtx),
          hasPendingMessages: () => deps.hasPendingMessages(commandCtx),
          hasActiveTelegramTurn: deps.hasActiveTelegramTurn,
          hasDispatchPending: deps.hasDispatchPending,
          hasQueuedTelegramItems: deps.hasQueuedTelegramItems,
          isCompactionInProgress: deps.isCompactionInProgress,
          setCompactionInProgress: deps.setCompactionInProgress,
          updateStatus: updateStatusFor(commandCtx),
          dispatchNextQueuedTelegramTurn: () =>
            deps.dispatchNextQueuedTelegramTurn(commandCtx),
          requestDeferredDispatchNextQueuedTelegramTurn:
            deps.requestDeferredDispatchNextQueuedTelegramTurn
              ? (dispatch) =>
                  deps.requestDeferredDispatchNextQueuedTelegramTurn?.(() =>
                    dispatch(),
                  )
              : undefined,
          compact: (callbacks) => deps.compact(commandCtx, callbacks),
          startTypingLoop: deps.startTypingLoop
            ? () => deps.startTypingLoop?.(commandCtx, nextMessage.chat.id)
            : undefined,
          stopTypingLoop: deps.stopTypingLoop,
          sendTextReply: sendReplyFor(nextMessage),
          recordRuntimeEvent: deps.recordRuntimeEvent,
        });
      },
      handleStatus: async (nextMessage, commandCtx) => {
        await deps.showStatus(nextMessage, commandCtx);
      },
      handleModel: async (nextMessage, commandCtx) => {
        await handleTelegramModelCommand<TContext>({
          ctx: commandCtx,
          openModelMenu: (controlCtx) =>
            deps.openModelMenu(nextMessage, controlCtx),
        });
      },
      handleThinking: async (nextMessage, commandCtx) => {
        await deps.openThinkingMenu(nextMessage, commandCtx);
      },
      handleSettings: deps.openSettingsMenu
        ? async (nextMessage, commandCtx) => {
            await deps.openSettingsMenu?.(nextMessage, commandCtx);
          }
        : undefined,
      handleHelp: async (nextMessage, _nextCommandName, commandCtx) => {
        try {
          await deps.registerBotCommands();
        } catch (error) {
          const errorMessage = getTelegramCommandErrorMessage(error);
          await deps.sendTextReply(
            nextMessage,
            `Warning: failed to register bot commands menu: ${errorMessage}`,
          );
        }
        if (nextMessage.from?.id !== undefined) {
          await pairTelegramUserIfNeeded(nextMessage.from.id, {
            allowedUserId: deps.getAllowedUserId(),
            ctx: undefined,
            setAllowedUserId: deps.setAllowedUserId,
            persistConfig: deps.persistConfig,
            updateStatus: updateStatusFor(commandCtx),
          });
        }
        await deps.showStatus(nextMessage, commandCtx);
      },
    },
  );
}
