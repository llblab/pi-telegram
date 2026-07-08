/**
 * Telegram command routing helpers
 * Zones: telegram controls, pi agent commands, queue controls
 * Owns Telegram slash-command normalization, bot command metadata, and pi-side command registration behind runtime ports
 */

import { pairTelegramUserIfNeeded } from "./config.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "./pi.ts";
import type { TelegramBridgeStatusLineOptions } from "./status.ts";
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

const TELEGRAM_EXTENSION_COMMAND_REGISTRY_KEY = "__piTelegramCommandRegistry__";
const TELEGRAM_BOT_COMMAND_NAME_PATTERN = /^[a-z0-9_]{1,32}$/;

export interface TelegramExtensionCommandContext {
  name: string;
  args: string;
  reply: (text: string) => Promise<void>;
  enqueuePrompt: (prompt: string) => Promise<void>;
}

export interface TelegramExtensionCommandRegistration {
  name: string;
  description?: string;
  order?: number;
  showInMenu?: boolean;
  emoji?: string;
  handler: (ctx: TelegramExtensionCommandContext) => Promise<void> | void;
}

interface RegisteredTelegramExtensionCommand {
  name: string;
  description?: string;
  order: number;
  showInMenu: boolean;
  emoji?: string;
  handler: TelegramExtensionCommandRegistration["handler"];
}

interface TelegramExtensionCommandRegistry {
  commands: Map<string, RegisteredTelegramExtensionCommand>;
}

function getOrCreateTelegramCommandRegistry(): TelegramExtensionCommandRegistry {
  const existing = (globalThis as Record<string, unknown>)[
    TELEGRAM_EXTENSION_COMMAND_REGISTRY_KEY
  ];
  if (
    existing &&
    typeof existing === "object" &&
    existing !== null &&
    "commands" in existing &&
    existing.commands instanceof Map
  ) {
    return existing as TelegramExtensionCommandRegistry;
  }
  const registry: TelegramExtensionCommandRegistry = { commands: new Map() };
  (globalThis as Record<string, unknown>)[
    TELEGRAM_EXTENSION_COMMAND_REGISTRY_KEY
  ] = registry;
  return registry;
}

export function normalizeTelegramExtensionCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}

export function isTelegramExtensionCommandName(name: string): boolean {
  return TELEGRAM_BOT_COMMAND_NAME_PATTERN.test(name);
}

function normalizeTelegramExtensionCommandEmoji(
  emoji: string | undefined,
): string | undefined {
  const normalized = emoji?.trim();
  return normalized ? normalized : undefined;
}

export function registerTelegramCommand(
  registration: TelegramExtensionCommandRegistration,
): () => void {
  const name = normalizeTelegramExtensionCommandName(registration.name);
  const showInMenu = registration.showInMenu ?? false;
  const emoji = normalizeTelegramExtensionCommandEmoji(registration.emoji);
  if (!isTelegramExtensionCommandName(name)) {
    throw new Error(`Invalid Telegram command name: ${registration.name}`);
  }
  if (showInMenu && !emoji) {
    throw new Error(`Visible Telegram command requires emoji: ${name}`);
  }
  if (emoji && emoji.length > 8) {
    throw new Error(`Telegram command emoji is too long: ${name}`);
  }
  if (isTelegramReservedCommandName(name)) {
    throw new Error(
      `Telegram command conflicts with built-in command: ${name}`,
    );
  }
  const registry = getOrCreateTelegramCommandRegistry();
  if (registry.commands.has(name)) {
    throw new Error(`Telegram command is already registered: ${name}`);
  }
  const command: RegisteredTelegramExtensionCommand = {
    name,
    description: registration.description,
    order: registration.order ?? 0,
    showInMenu,
    emoji,
    handler: registration.handler,
  };
  registry.commands.set(name, command);
  return () => {
    if (registry.commands.get(name) === command) registry.commands.delete(name);
  };
}

export function getTelegramExtensionCommands(): RegisteredTelegramExtensionCommand[] {
  return Array.from(
    getOrCreateTelegramCommandRegistry().commands.values(),
  ).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export function findTelegramExtensionCommand(
  name: string | undefined,
): RegisteredTelegramExtensionCommand | undefined {
  if (!name) return undefined;
  return getOrCreateTelegramCommandRegistry().commands.get(
    normalizeTelegramExtensionCommandName(name),
  );
}

export function clearTelegramExtensionCommands(): void {
  getOrCreateTelegramCommandRegistry().commands.clear();
}

export const TELEGRAM_COMMAND_EMOJI = {
  start: "🟢",
  status: "📊",
  model: "🤖",
  thinking: "🧠",
  compact: "🗜",
  queue: "🔢",
  thread: "🧵",
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
      description: formatTelegramBotCommandDescription("abort", "Abort Pi"),
    },
    {
      command: "stop",
      description: formatTelegramBotCommandDescription(
        "stop",
        "Abort Pi & Clear queue",
      ),
    },
  ];

export const TELEGRAM_BOT_COMMANDS = TELEGRAM_BUILTIN_BOT_COMMANDS;

function getVisibleTelegramExtensionBotCommands(): TelegramBotCommandDefinition[] {
  return getTelegramExtensionCommands()
    .filter((command) => command.showInMenu && command.description)
    .map((command) => ({
      command: command.name,
      description: `${command.emoji} ${command.description ?? command.name}`,
    }));
}

export function getTelegramReservedCommandNames(): string[] {
  return [
    ...TELEGRAM_RESERVED_COMMAND_NAMES,
    ...getTelegramExtensionCommands().map((command) => command.name),
  ];
}

export interface TelegramBotCommandRegistrationDeps {
  setMyCommands: (
    commands: readonly TelegramBotCommandDefinition[],
  ) => Promise<unknown>;
}

export async function registerTelegramBotCommands(
  deps: TelegramBotCommandRegistrationDeps,
): Promise<void> {
  const extensionCommands = getVisibleTelegramExtensionBotCommands();
  if (extensionCommands.length === 0) {
    await deps.setMyCommands(TELEGRAM_BOT_COMMANDS);
    return;
  }
  const compactCommandIndex = TELEGRAM_BOT_COMMANDS.findIndex(
    (command) => command.command === "compact",
  );
  if (compactCommandIndex === -1) {
    await deps.setMyCommands([...TELEGRAM_BOT_COMMANDS, ...extensionCommands]);
    return;
  }
  await deps.setMyCommands([
    ...TELEGRAM_BOT_COMMANDS.slice(0, compactCommandIndex + 1),
    ...extensionCommands,
    ...TELEGRAM_BOT_COMMANDS.slice(compactCommandIndex + 1),
  ]);
}

export function createTelegramBotCommandRegistrar(
  deps: TelegramBotCommandRegistrationDeps,
): () => Promise<void> {
  return () => registerTelegramBotCommands(deps);
}

export interface TelegramBridgeCommandStartPollingOptions {
  force?: boolean;
  forceFreshLeaderThread?: boolean;
}

export interface TelegramBridgeCommandStartPollingResult {
  ok: boolean;
  message?: string;
  canTakeover?: boolean;
  owner?: string;
}

export interface TelegramBridgeCommandRegistrationDeps {
  promptForConfig: (ctx: ExtensionCommandContext, profileName?: string) => Promise<void>;
  getStatusLines: (options?: TelegramBridgeStatusLineOptions) => string[];
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
  getProfileNames?: () => string[];
  activateProfileConfig?: (
    ctx: ExtensionCommandContext,
    profileName: string,
  ) => Promise<boolean>;
}

function parseTelegramProfileArg(args: string): string | undefined {
  const word = args.trim().split(/\s+/)[0];
  if (!word || word.length === 0) return undefined;
  if (word.startsWith("-")) return undefined;
  return word;
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
  const source = owner ?? "another Pi instance";
  return `${action}\n\n${from} ${source}\n${to} ${ctx.cwd}`;
}

export function registerTelegramBridgeCommands(
  pi: ExtensionAPI,
  deps: TelegramBridgeCommandRegistrationDeps,
): void {
  pi.registerCommand("telegram-setup", {
    description: "Configure Telegram bot token. Use /telegram-setup <name> for named profiles.",
    handler: async (args, ctx) => {
      await deps.promptForConfig(ctx, parseTelegramProfileArg(args));
    },
  });
  pi.registerCommand("telegram-status", {
    description: "Show Telegram bridge status",
    handler: async (args, ctx) => {
      const verbose = /(^|\s)(--debug|debug|--verbose|verbose)(\s|$)/i.test(
        args,
      );
      ctx.ui.notify(deps.getStatusLines({ verbose }).join("\n"), "info");
    },
  });
  pi.registerCommand("telegram-connect", {
    description: "Start the Telegram bridge. Use /telegram-connect <name> for named profiles.",
    handler: async (args, ctx) => {
      const profileName = parseTelegramProfileArg(args);
      if (profileName && deps.activateProfileConfig) {
        const ok = await deps.activateProfileConfig(ctx, profileName);
        if (!ok) {
          ctx.ui.notify(`Profile "${profileName}" not found.`, "error");
          deps.updateStatus(ctx);
          return;
        }
        ctx.ui.notify(`Activated profile "${profileName}".`, "info");
      } else {
        await deps.reloadConfig();
      }
      if (!deps.hasBotToken()) {
        const profileNames = deps.getProfileNames?.() ?? [];
        if (!profileName && profileNames.length > 0) {
          ctx.ui.notify(
            `No default Telegram profile configured. Available profiles: ${profileNames.join(", ")}. Use /telegram-connect <profileName> or /telegram-setup to create a default profile.`,
            "info",
          );
          deps.updateStatus(ctx);
          return;
        }
        await deps.promptForConfig(ctx, profileName);
        return;
      }
      let result = await deps.startPolling(ctx, {
        forceFreshLeaderThread: true,
      });
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
        result = await deps.startPolling(ctx, {
          force: true,
          forceFreshLeaderThread: true,
        });
      }
      if (result?.message) {
        ctx.ui.notify(result.message, result.ok ? "info" : "warning");
      }
      deps.updateStatus(ctx);
    },
  });
  pi.registerCommand("telegram-disconnect", {
    description: "Stop the Telegram bridge in this Pi session",
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
  setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
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

export interface TelegramCompactConfirmationReplyMarkup {
  inline_keyboard: { text: string; callback_data: string }[][];
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
  suppressStartNotice?: boolean;
}

export interface TelegramCompactConfirmationDeps {
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: TelegramCompactConfirmationReplyMarkup,
    options?: { target?: { chatId: number; threadId?: number } },
  ) => Promise<number | undefined>;
}

export interface TelegramCompactConfirmationCallbackQuery {
  id: string;
  data?: string;
  message?: {
    chat?: { id?: number };
    message_id?: number;
    message_thread_id?: number;
  };
}

export interface TelegramCompactConfirmationCallbackDeps<TContext> {
  ctx: TContext;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "markdown" | "html" | "plain",
    replyMarkup: TelegramCompactConfirmationReplyMarkup,
  ) => Promise<void>;
  runCompact: (
    ctx: TContext,
    chatId: number,
    replyToMessageId: number,
    target?: { chatId: number; threadId?: number },
  ) => Promise<void>;
}

export type TelegramControlCommandType =
  PendingTelegramControlItem<unknown>["controlType"];

export interface TelegramCommandRuntimeMessage {
  chat: { id: number; type?: string; title?: string };
  message_id: number;
  message_thread_id?: number;
  from?: { id?: number };
}

export interface TelegramCommandMessageTarget {
  chatId: number;
  threadId?: number;
  replyToMessageId: number;
}

function canPairTelegramUserFromCommandMessage(
  message: TelegramCommandRuntimeMessage,
): boolean {
  return message.chat.type === undefined || message.chat.type === "private";
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
    threadId?: number,
  ) => Promise<void>;
  openModelMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
    threadId?: number,
  ) => Promise<void>;
  openSettingsMenu?: (
    chatId: number,
    replyToMessageId: number,
    ctx: TContext,
    threadId?: number,
  ) => Promise<void>;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number,
    text: string,
    options?: { target?: { chatId: number; threadId?: number } },
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
    threadId:
      typeof message.message_thread_id === "number"
        ? message.message_thread_id
        : undefined,
    replyToMessageId: message.message_id,
  };
}

export interface TelegramCommandControlQueueRuntimeDeps<TContext> {
  createControlItem: (options: {
    chatId: number;
    target?: { chatId: number; threadId?: number };
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
    target?: { chatId: number; threadId?: number };
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
      return deps.showStatus(
        target.chatId,
        target.replyToMessageId,
        ctx,
        target.threadId,
      );
    },
    openModelMenu: (message, ctx) => {
      const target = getTelegramCommandMessageTarget(message);
      return deps.openModelMenu(
        target.chatId,
        target.replyToMessageId,
        ctx,
        target.threadId,
      );
    },
    openSettingsMenu: async (message, ctx) => {
      const target = getTelegramCommandMessageTarget(message);
      if (!deps.openSettingsMenu) {
        await deps.sendTextReply(
          target.chatId,
          target.replyToMessageId,
          "Settings menu is unavailable.",
          { target },
        );
        return;
      }
      await deps.openSettingsMenu(
        target.chatId,
        target.replyToMessageId,
        ctx,
        target.threadId,
      );
    },
    sendTextReply: async (message, text) => {
      const target = getTelegramCommandMessageTarget(message);
      await deps.sendTextReply(target.chatId, target.replyToMessageId, text, {
        target,
      });
    },
  };
}

export interface TelegramCommandOrPromptRuntimeDeps<TMessage, TContext> {
  extractRawText: (messages: TMessage[]) => string;
  shouldIgnoreMessages?: (messages: TMessage[]) => boolean;
  handleCommand: (
    commandName: string | undefined,
    message: TMessage,
    ctx: TContext,
  ) => Promise<boolean>;
  executeExtensionCommand?: (
    command: ParsedTelegramCommand,
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
  setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
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
  startTypingLoop?: (
    ctx: TContext,
    chatId?: number,
    options?: { target?: { chatId: number; threadId?: number } },
  ) => void;
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
  handleForumBootstrap?: (
    message: TMessage,
    ctx: TContext,
  ) => Promise<string | undefined>;
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
  sendInteractiveMessage?: TelegramCompactConfirmationDeps["sendInteractiveMessage"];
}

export const TELEGRAM_APP_MENU_INTRO_HTML = [
  "<b>Pi Telegram</b>",
  "",
  `${formatTelegramCommandEmojiPrefix("start")}/start — Open menu / Pair bridge`,
  `${formatTelegramCommandEmojiPrefix("compact")}/compact — Compact current session`,
  `${formatTelegramCommandEmojiPrefix("next")}/next — Force next turn`,
  `${formatTelegramCommandEmojiPrefix("continue")}/continue — Queue continue prompt`,
  `${formatTelegramCommandEmojiPrefix("abort")}/abort — Abort Pi`,
  `${formatTelegramCommandEmojiPrefix("stop")}/stop — Abort Pi & Clear queue`,
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

function buildTelegramExtensionCommandMenuLines(): string[] {
  return getTelegramExtensionCommands()
    .filter((command) => command.showInMenu)
    .map((command) => {
      const prefix = `${escapeTelegramCommandMenuHtml(command.emoji ?? "")} /${escapeTelegramCommandMenuHtml(command.name)}`;
      if (!command.description) return prefix;
      return `${prefix} — ${escapeTelegramCommandMenuHtml(command.description)}`;
    });
}

function buildTelegramAppMenuIntroHtml(): string {
  const extensionLines = buildTelegramExtensionCommandMenuLines();
  if (extensionLines.length === 0) return TELEGRAM_APP_MENU_INTRO_HTML;
  return [
    "<b>Pi Telegram</b>",
    "",
    `${formatTelegramCommandEmojiPrefix("start")}/start — Open menu / Pair bridge`,
    `${formatTelegramCommandEmojiPrefix("compact")}/compact — Compact current session`,
    ...extensionLines,
    `${formatTelegramCommandEmojiPrefix("next")}/next — Force next turn`,
    `${formatTelegramCommandEmojiPrefix("continue")}/continue — Queue continue prompt`,
    `${formatTelegramCommandEmojiPrefix("abort")}/abort — Abort Pi`,
    `${formatTelegramCommandEmojiPrefix("stop")}/stop — Abort Pi & Clear queue`,
  ].join("\n");
}

export function buildTelegramAppMenuHtml(
  statusHtml: string,
  promptTemplates: readonly TelegramPromptTemplateMenuCommand[] = [],
): string {
  const introHtml = buildTelegramAppMenuIntroHtml();
  const promptTemplateHtml =
    buildTelegramPromptTemplateMenuHtml(promptTemplates);
  if (!promptTemplateHtml) return `${introHtml}\n\n${statusHtml}`;
  return `${introHtml}\n\n${promptTemplateHtml}\n\n${statusHtml}`;
}

export function createTelegramAppMenuHtmlBuilder<TContext>(deps: {
  buildStatusHtml: (ctx: TContext) => string;
  getPromptTemplateCommands?: () => readonly TelegramPromptTemplateMenuCommand[];
}): (ctx: TContext) => string {
  return (ctx) => {
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
  deps.setFoldQueuedPromptsIntoHistory(false);
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
  hasActiveTelegramTurn: () => boolean;
  clearPendingModelSwitch: () => void;
  abortCurrentTurn: () => void;
  setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
  updateStatus: () => void;
  sendTextReply: (text: string) => Promise<void>;
}): Promise<void> {
  deps.clearPendingModelSwitch();
  if (!deps.hasAbortHandler()) {
    await deps.sendTextReply("No active turn.");
    return;
  }
  deps.setFoldQueuedPromptsIntoHistory(deps.hasActiveTelegramTurn());
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
  clearFoldForDispatch: () => void;
  updateStatus: () => void;
  sendTextReply: (text: string) => Promise<void>;
}): Promise<void> {
  deps.clearPendingModelSwitch();
  if (!deps.hasQueuedItems()) {
    await deps.sendTextReply("<b>Queue is empty.</b>");
    return;
  }
  if (!deps.isIdle() && deps.hasAbortHandler()) {
    deps.clearFoldForDispatch();
    deps.abortCurrentTurn();
    deps.updateStatus();
    await deps.sendTextReply(
      "Aborted current turn. Dispatching next queued turn.",
    );
    return;
  }
  if (!deps.isIdle()) {
    await deps.sendTextReply("Pi is busy. Send /abort or /stop first.");
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

export function buildTelegramCompactConfirmationReplyMarkup(): TelegramCompactConfirmationReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: "🗜 Yes, compact", callback_data: "compact:confirm" },
        { text: "❌ No", callback_data: "compact:cancel" },
      ],
    ],
  };
}

export function getTelegramCompactConfirmationHtml(): string {
  return "<b>Compact session?</b>";
}

export async function openTelegramCompactConfirmation(
  target: TelegramCommandMessageTarget,
  deps: TelegramCompactConfirmationDeps,
): Promise<void> {
  await deps.sendInteractiveMessage(
    target.chatId,
    getTelegramCompactConfirmationHtml(),
    "html",
    buildTelegramCompactConfirmationReplyMarkup(),
    target.threadId !== undefined
      ? { target: { chatId: target.chatId, threadId: target.threadId } }
      : undefined,
  );
}

export async function handleTelegramCompactConfirmationCallback<TContext>(
  query: TelegramCompactConfirmationCallbackQuery,
  deps: TelegramCompactConfirmationCallbackDeps<TContext>,
): Promise<boolean> {
  if (query.data !== "compact:confirm" && query.data !== "compact:cancel") {
    return false;
  }
  const callbackMessage = query.message;
  const chatId = callbackMessage?.chat?.id;
  const messageId = callbackMessage?.message_id;
  if (typeof chatId !== "number" || typeof messageId !== "number") {
    await deps.answerCallbackQuery(query.id, "Interactive message expired.");
    return true;
  }
  if (query.data === "compact:cancel") {
    await deps.editInteractiveMessage(
      chatId,
      messageId,
      "Compaction cancelled.",
      "plain",
      { inline_keyboard: [] },
    );
    await deps.answerCallbackQuery(query.id);
    return true;
  }
  await deps.editInteractiveMessage(
    chatId,
    messageId,
    `${formatTelegramCommandEmojiPrefix("compact")}Compaction started.`,
    "plain",
    { inline_keyboard: [] },
  );
  await deps.answerCallbackQuery(query.id);
  const threadId = callbackMessage?.message_thread_id;
  await deps.runCompact(
    deps.ctx,
    chatId,
    messageId,
    typeof threadId === "number" ? { chatId, threadId } : { chatId },
  );
  return true;
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
      "Cannot compact while Pi or the Telegram queue is busy. Wait for queued turns to finish or send /abort first.",
    );
    return;
  }
  deps.setCompactionInProgress(true);
  deps.updateStatus();
  deps.startTypingLoop?.();
  try {
    deps.compact({
      onComplete: () => {
        deps.stopTypingLoop?.();
        deps.setCompactionInProgress(false);
        deps.updateStatus();
        dispatchNextQueuedTelegramTurnAfterCompact(deps);
        void deps.sendTextReply("✅ Compaction completed.");
      },
      onError: (error) => {
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
    deps.stopTypingLoop?.();
    deps.setCompactionInProgress(false);
    deps.updateStatus();
    deps.recordRuntimeEvent?.("compact", error);
    const errorMessage = getTelegramCommandErrorMessage(error);
    await deps.sendTextReply(`Compaction failed: ${errorMessage}`);
    return;
  }
  if (!deps.suppressStartNotice) {
    await deps.sendTextReply(
      `${formatTelegramCommandEmojiPrefix("compact")}Compaction started.`,
    );
  }
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
    setFoldQueuedPromptsIntoHistory: deps.setFoldQueuedPromptsIntoHistory,
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
    sendInteractiveMessage: deps.sendInteractiveMessage,
    enqueueControlItem: commandTargetRuntime.enqueueControlItem,
    showStatus: commandTargetRuntime.showStatus,
    openModelMenu: commandTargetRuntime.openModelMenu,
    openThinkingMenu: deps.openThinkingMenu,
    openQueueMenu: deps.openQueueMenu,
    openSettingsMenu: commandTargetRuntime.openSettingsMenu,
    handleForumBootstrap: deps.handleForumBootstrap,
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
  return async (
    commandName: string | undefined,
    message: TMessage,
    ctx: TContext,
  ): Promise<boolean> => {
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
      if (deps.shouldIgnoreMessages?.(messages)) return;
      const command = parseTelegramCommand(deps.extractRawText(messages));
      const handled = await deps.handleCommand(
        command?.name,
        firstMessage,
        ctx,
      );
      if (handled) return;
      if (command && deps.executeExtensionCommand) {
        const handledByExtension = await deps.executeExtensionCommand(
          command,
          messages[0]!,
          ctx,
        );
        if (handledByExtension) return;
      }
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
          setFoldQueuedPromptsIntoHistory: deps.setFoldQueuedPromptsIntoHistory,
          abortCurrentTurn: deps.abortCurrentTurn,
          updateStatus: updateStatusFor(commandCtx),
          sendTextReply: sendReplyFor(nextMessage),
        });
      },
      handleAbort: async (nextMessage, commandCtx) => {
        await handleTelegramAbortCommand({
          hasAbortHandler: deps.hasAbortHandler,
          hasActiveTelegramTurn: deps.hasActiveTelegramTurn,
          clearPendingModelSwitch: deps.clearPendingModelSwitch,
          abortCurrentTurn: deps.abortCurrentTurn,
          setFoldQueuedPromptsIntoHistory: deps.setFoldQueuedPromptsIntoHistory,
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
          clearFoldForDispatch: () =>
            deps.setFoldQueuedPromptsIntoHistory(false),
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
        if (deps.sendInteractiveMessage) {
          await openTelegramCompactConfirmation(
            getTelegramCommandMessageTarget(nextMessage),
            { sendInteractiveMessage: deps.sendInteractiveMessage },
          );
          return;
        }
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
            ? () =>
                deps.startTypingLoop?.(commandCtx, nextMessage.chat.id, {
                  target: getTelegramCommandMessageTarget(nextMessage),
                })
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
      handleHelp: async (nextMessage, nextCommandName, commandCtx) => {
        try {
          await deps.registerBotCommands();
        } catch (error) {
          const errorMessage = getTelegramCommandErrorMessage(error);
          await deps.sendTextReply(
            nextMessage,
            `Warning: failed to register bot commands menu: ${errorMessage}`,
          );
        }
        if (
          nextMessage.from?.id !== undefined &&
          canPairTelegramUserFromCommandMessage(nextMessage)
        ) {
          await pairTelegramUserIfNeeded(nextMessage.from.id, {
            allowedUserId: deps.getAllowedUserId(),
            ctx: undefined,
            setAllowedUserId: deps.setAllowedUserId,
            persistConfig: deps.persistConfig,
            updateStatus: updateStatusFor(commandCtx),
          });
        }
        const forumBootstrapMessage =
          nextCommandName === "start"
            ? await deps.handleForumBootstrap?.(nextMessage, commandCtx)
            : undefined;
        if (forumBootstrapMessage) {
          await deps.sendTextReply(nextMessage, forumBootstrapMessage);
        }
        await deps.showStatus(nextMessage, commandCtx);
      },
    },
  );
}
