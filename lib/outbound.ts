/**
 * Telegram outbound surface helpers
 * Zones: telegram outbound, command templates, voice delivery
 * Owns configured outbound handler execution, text transforms, public assistant-output reply composition and mutation fencing, voice-file generation/delivery, runtime-event bridge, and compatibility re-exports; assistant markup parsing lives in outbound-markup and button callback actions live in outbound-buttons
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { TelegramAssistantSegmentEvent } from "./activity.ts";
import { resolveTelegramTempDir } from "./paths.ts";
import * as Replies from "./replies.ts";
import type {
  TelegramEditMessageTextBody,
  TelegramSendMessageBody,
  TelegramSendRichMessageBody,
  TelegramSentMessage,
} from "./telegram-api.ts";

import {
  planTelegramButtonReply,
  type TelegramButtonActionStore,
  type TelegramOutboundButtonMarkup,
} from "./outbound-buttons.ts";
import {
  planTelegramVoiceReply,
  type TelegramVoiceReplyItem,
} from "./outbound-markup.ts";
import { createTelegramVoiceReplySender as createTelegramVoiceReplySenderWithPorts } from "./outbound-voice.ts";
import type { TelegramTarget } from "./target.ts";

const OUTBOUND_HANDLER_REGISTRY_KEY = "__piTelegramOutboundHandlers__";
const VOICE_EVENT_RECORDER_KEY = "__piTelegramVoiceEventRecorder__";

import {
  buildCommandTemplateInvocation,
  expandCommandTemplateConfigs,
  substituteCommandTemplateToken,
  type CommandTemplateObjectConfig,
} from "./command-templates.ts";
const DEFAULT_VOICE_TIMEOUT_MS = 120_000;

// --- Types ---

/**
 * Record a runtime event that appears in `/telegram-status`.
 * Voice synthesis provider extensions can call this to surface diagnostics
 * alongside pi-telegram's own events. Events are silently dropped
 * when pi-telegram is not loaded.
 */
export type TelegramRuntimeEventRecorder = (
  category: string,
  error: unknown,
  details?: Record<string, unknown>,
) => void;

export function bindTelegramRuntimeEventRecorder(
  recorder: TelegramRuntimeEventRecorder,
): void {
  (globalThis as Record<string, unknown>)[VOICE_EVENT_RECORDER_KEY] = recorder;
}

export function recordTelegramRuntimeEvent(
  category: string,
  error: unknown,
  details?: Record<string, unknown>,
): void {
  const recorder = (globalThis as Record<string, unknown>)[
    VOICE_EVENT_RECORDER_KEY
  ];
  if (typeof recorder === "function") {
    (recorder as TelegramRuntimeEventRecorder)(category, error, details);
  }
}

export type TelegramOutboundCommandTemplateConfig =
  string | CommandTemplateObjectConfig;
export interface TelegramOutboundHandlerConfig extends CommandTemplateObjectConfig {
  type?: string;
  match?: string | string[];
  output?: string;
  timeout?: number | string;
}

export {
  normalizeMarkdownAfterVoiceExtraction,
  planTelegramVoiceReply,
  stripTelegramCommentMarkupForDelivery,
  stripTelegramCommentMarkupForPreview,
  stripTelegramVoiceMarkupForPreview,
  type TelegramVoiceReplyItem,
  type TelegramVoiceReplyPlan,
} from "./outbound-markup.ts";

export interface TelegramVoiceExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
  retry?: number;
}

export interface TelegramVoiceExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface TelegramVoiceReplyTurnView {
  chatId: number;
  replyToMessageId: number;
  target?: TelegramTarget;
}

export interface TelegramVoiceReplySenderDeps {
  execCommand: (
    command: string,
    args: string[],
    options?: TelegramVoiceExecOptions,
  ) => Promise<TelegramVoiceExecResult>;
  sendMultipart: (
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
  ) => Promise<unknown>;
  sendTextReply?: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
    options?: { parseMode?: "HTML" },
  ) => Promise<unknown>;
  sendChatAction?: (chatId: number, action: string) => Promise<unknown>;
  sendRecordVoiceAction?: (chatId: number) => Promise<unknown>;
  getHandlers?: () => TelegramOutboundHandlerConfig[] | undefined;
  cwd?: string;
  tempDir?: string;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

// --- Programmatic Outbound Handler Registry ---

export type TelegramOutboundProgrammaticHandler = (
  text: string,
  options?: { lang?: string; rate?: string },
) => Promise<string>;

export interface TelegramOutboundHandlerRegistry {
  handlers: Map<string, TelegramOutboundProgrammaticHandler[]>;
}

// --- Programmatic Outbound Handler Registry Runtime ---

function getOrCreateOutboundHandlerRegistry(): TelegramOutboundHandlerRegistry {
  const existing = (globalThis as Record<string, unknown>)[
    OUTBOUND_HANDLER_REGISTRY_KEY
  ];
  if (
    existing &&
    typeof existing === "object" &&
    existing !== null &&
    "handlers" in existing &&
    existing.handlers instanceof Map
  ) {
    return existing as TelegramOutboundHandlerRegistry;
  }
  const registry: TelegramOutboundHandlerRegistry = {
    handlers: new Map(),
  };
  (globalThis as Record<string, unknown>)[OUTBOUND_HANDLER_REGISTRY_KEY] =
    registry;
  return registry;
}

export function registerTelegramOutboundHandler(
  kind: string,
  handler: TelegramOutboundProgrammaticHandler,
): () => void {
  const registry = getOrCreateOutboundHandlerRegistry();
  const list = registry.handlers.get(kind) ?? [];
  list.push(handler);
  registry.handlers.set(kind, list);
  return () => {
    const updated = registry.handlers.get(kind) ?? [];
    const index = updated.indexOf(handler);
    if (index !== -1) {
      updated.splice(index, 1);
      registry.handlers.set(kind, updated);
    }
  };
}

export function hasTelegramOutboundHandler(kind: string): boolean {
  const registry = getOrCreateOutboundHandlerRegistry();
  const list = registry.handlers.get(kind);
  return !!list && list.length > 0;
}

export function getTelegramOutboundProgrammaticHandlers(
  kind: string,
): TelegramOutboundProgrammaticHandler[] {
  const registry = getOrCreateOutboundHandlerRegistry();
  return [...(registry.handlers.get(kind) ?? [])];
}

export interface TelegramOutboundTextReplyRuntimeDeps<TReplyMarkup = unknown> {
  execCommand: TelegramVoiceReplySenderDeps["execCommand"];
  getHandlers?: () => TelegramOutboundHandlerConfig[] | undefined;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
    options?: { parseMode?: "HTML"; target?: TelegramTarget },
  ) => Promise<number | undefined>;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: { replyMarkup?: TReplyMarkup; target?: TelegramTarget },
  ) => Promise<number | undefined>;
  cwd?: string;
  recordRuntimeEvent?: TelegramVoiceReplySenderDeps["recordRuntimeEvent"];
}

export interface TelegramInlineKeyboardLike {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface TelegramOutboundTextTransformOptions<TReplyMarkup = unknown> {
  handlers?: TelegramOutboundHandlerConfig[];
  cwd?: string;
  execCommand: TelegramVoiceReplySenderDeps["execCommand"];
  recordRuntimeEvent?: TelegramVoiceReplySenderDeps["recordRuntimeEvent"];
  replyMarkup?: TReplyMarkup;
}

export interface TelegramOutboundTextTransformResult<TReplyMarkup = unknown> {
  text: string;
  replyMarkup?: TReplyMarkup;
}

export interface TelegramOutboundTextPreviewRuntimeDeps<
  TReplyMarkup = unknown,
> {
  execCommand: TelegramVoiceReplySenderDeps["execCommand"];
  getHandlers?: () => TelegramOutboundHandlerConfig[] | undefined;
  finalizeMarkdownPreview: (
    chatId: number,
    markdown: string,
    replyToMessageId: number,
    options?: { replyMarkup?: TReplyMarkup },
  ) => Promise<boolean>;
  cwd?: string;
  recordRuntimeEvent?: TelegramVoiceReplySenderDeps["recordRuntimeEvent"];
}

// --- Voice Reply Timeout Helpers ---

function resolveOutboundNumericControlField(
  value: number | string | undefined,
  values: Record<string, unknown>,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  const resolved =
    typeof value === "string"
      ? substituteCommandTemplateToken(value, values, label)
      : value;
  if (resolved === "") return undefined;
  const numeric = Number(resolved);
  if (!Number.isFinite(numeric) || numeric < 0)
    throw new Error(`Command template ${label} must be a non-negative number.`);
  return numeric;
}

function getVoiceReplyConfiguredTimeout(
  config: TelegramOutboundCommandTemplateConfig | undefined,
): number | undefined {
  const timeout = typeof config === "string" ? undefined : config?.timeout;
  return resolveOutboundNumericControlField(timeout, {}, "timeout");
}

function getVoiceReplyTimeout(
  config: TelegramOutboundCommandTemplateConfig | undefined,
): number {
  return getVoiceReplyConfiguredTimeout(config) ?? DEFAULT_VOICE_TIMEOUT_MS;
}

function getRemainingVoiceReplyTimeout(
  timeout: number,
  startedAt: number,
): number {
  return Math.max(1, timeout - (Date.now() - startedAt));
}

function getVoiceReplyCompositionStepTimeout(
  handlerTimeout: number,
  step: TelegramOutboundCommandTemplateConfig,
  startedAt: number,
): number {
  const remaining = getRemainingVoiceReplyTimeout(handlerTimeout, startedAt);
  const stepTimeout = getVoiceReplyConfiguredTimeout(step);
  return stepTimeout === undefined
    ? remaining
    : Math.min(stepTimeout, remaining);
}

function formatVoiceReplyExecutionFailure(
  label: string,
  result: TelegramVoiceExecResult,
): string {
  const parts = [
    `${label} exited with code ${result.code}${result.killed ? " (killed)" : ""}`,
  ];
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`);
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trimEnd()}`);
  return parts.join("\n\n");
}

async function runVoiceReplyCommand(
  label: string,
  config: TelegramOutboundCommandTemplateConfig,
  values: Record<string, string>,
  options: {
    cwd: string;
    timeout: number;
    execCommand: TelegramVoiceReplySenderDeps["execCommand"];
    stdin?: string;
  },
): Promise<TelegramVoiceExecResult> {
  if (!options.execCommand) {
    throw new Error("execCommand is required for command template execution");
  }
  const invocation = buildCommandTemplateInvocation(
    config,
    values,
    options.cwd,
    {
      emptyMessage: "Outbound voice template is empty",
      missingLabel: "outbound voice template",
    },
  );
  const result = await options.execCommand(
    invocation.command,
    invocation.args,
    {
      cwd: options.cwd,
      timeout: options.timeout,
      ...(typeof config === "object" && config.retry !== undefined
        ? {
            retry: resolveOutboundNumericControlField(
              config.retry,
              {},
              "retry",
            ),
          }
        : {}),
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    },
  );
  if (result.code !== 0)
    throw new Error(formatVoiceReplyExecutionFailure(label, result));
  return result;
}

function normalizeOutboundHandlerStringList(
  value: string | string[] | undefined,
): string[] {
  if (Array.isArray(value))
    return value
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function outboundHandlerMatchesType(
  handler: TelegramOutboundHandlerConfig,
  type: string,
): boolean {
  const selectors = [
    ...normalizeOutboundHandlerStringList(handler.type),
    ...normalizeOutboundHandlerStringList(handler.match),
  ];
  if (selectors.length === 0) return false;
  return selectors.includes(type);
}

export function findTelegramOutboundHandlers(
  handlers: TelegramOutboundHandlerConfig[] | undefined,
  type: string,
): TelegramOutboundHandlerConfig[] {
  if (!Array.isArray(handlers)) return [];
  return handlers.filter(
    (handler) =>
      !!handler &&
      typeof handler === "object" &&
      outboundHandlerMatchesType(handler, type),
  );
}

function getTelegramVoiceHandlerCompositionSteps(
  handler: TelegramOutboundHandlerConfig,
): TelegramOutboundCommandTemplateConfig[] {
  if (Array.isArray(handler.template)) {
    return expandCommandTemplateConfigs(
      handler,
    ) as TelegramOutboundCommandTemplateConfig[];
  }
  return [];
}

function extractVoiceReplyPath(stdout: string): string {
  const path = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!path) throw new Error("Voice generator did not print an output path");
  return path;
}

function getVoiceReplyOutputPath(
  config: TelegramOutboundHandlerConfig,
  values: Record<string, string>,
  stdout: string,
): string {
  const output = config.output ?? "stdout";
  if (output === "stdout") return extractVoiceReplyPath(stdout);
  const keyMatch = output.match(/^\{?([A-Za-z_][A-Za-z0-9_-]*)\}?$/);
  if (keyMatch && Object.hasOwn(values, keyMatch[1])) {
    return values[keyMatch[1]] ?? "";
  }
  return output.replace(
    /\{([A-Za-z_][A-Za-z0-9_-]*)\}/g,
    (_match, key: string) => values[key] ?? "",
  );
}

function getVoiceReplyTemplateValues(
  text: string,
  options: { lang?: string; rate?: string; mp3Path: string; oggPath: string },
): Record<string, string> {
  return {
    text,
    type: "voice",
    mp3: options.mp3Path,
    ogg: options.oggPath,
    ...(options.lang ? { lang: options.lang } : {}),
    ...(options.rate ? { rate: options.rate } : {}),
  };
}

function getDefaultTelegramVoiceTempDir(): string {
  return resolveTelegramTempDir();
}

async function generateTelegramVoiceReplyFileWithHandler(
  text: string,
  options: {
    lang?: string;
    rate?: string;
    handler: TelegramOutboundHandlerConfig;
    tempDir: string;
    cwd: string;
    timeout: number;
    execCommand: TelegramVoiceReplySenderDeps["execCommand"];
  },
): Promise<string> {
  await mkdir(options.tempDir, { recursive: true });
  const artifactId = randomUUID();
  const values = getVoiceReplyTemplateValues(text, {
    lang: options.lang,
    rate: options.rate,
    mp3Path: join(options.tempDir, `${artifactId}-voice.mp3`),
    oggPath: join(options.tempDir, `${artifactId}-voice.ogg`),
  });
  const steps = getTelegramVoiceHandlerCompositionSteps(options.handler);
  if (steps.length > 0) {
    const startedAt = Date.now();
    let stdout = text;
    for (const [index, step] of steps.entries()) {
      try {
        const result = await runVoiceReplyCommand(
          `Outbound voice template step ${index + 1}`,
          step,
          values,
          {
            cwd: options.cwd,
            timeout: getVoiceReplyCompositionStepTimeout(
              options.timeout,
              step,
              startedAt,
            ),
            execCommand: options.execCommand,
            stdin: stdout,
          },
        );
        stdout = result.stdout;
      } catch (error) {
        if (typeof step === "object" && step.failure === "root") throw error;
        stdout = "";
      }
    }
    return getVoiceReplyOutputPath(options.handler, values, stdout);
  }
  const result = await runVoiceReplyCommand(
    "Outbound voice template",
    options.handler,
    values,
    {
      cwd: options.cwd,
      timeout: options.timeout,
      execCommand: options.execCommand,
      stdin: text,
    },
  );
  return getVoiceReplyOutputPath(options.handler, values, result.stdout);
}

export async function generateTelegramVoiceReplyFile(
  text: string,
  options: {
    lang?: string;
    rate?: string;
    handler?: TelegramOutboundHandlerConfig;
    tempDir?: string;
    cwd?: string;
    execCommand: TelegramVoiceReplySenderDeps["execCommand"];
  },
): Promise<string | undefined> {
  const handler = options.handler;
  if (!handler?.template) return undefined;
  return generateTelegramVoiceReplyFileWithHandler(text, {
    lang: options.lang,
    rate: options.rate,
    handler,
    tempDir: options.tempDir ?? getDefaultTelegramVoiceTempDir(),
    cwd: options.cwd ?? process.cwd(),
    timeout: getVoiceReplyTimeout(handler),
    execCommand: options.execCommand,
  });
}

function getOutboundTextTemplateValues(text: string): Record<string, string> {
  return { text, type: "text" };
}

async function transformTelegramOutboundTextWithHandler(
  text: string,
  options: {
    handler: TelegramOutboundHandlerConfig;
    cwd: string;
    execCommand: TelegramVoiceReplySenderDeps["execCommand"];
  },
): Promise<string> {
  const values = getOutboundTextTemplateValues(text);
  const steps = getTelegramVoiceHandlerCompositionSteps(options.handler);
  if (steps.length > 0) {
    const startedAt = Date.now();
    let stdout = text;
    for (const [index, step] of steps.entries()) {
      try {
        const result = await runVoiceReplyCommand(
          `Outbound text template step ${index + 1}`,
          step,
          values,
          {
            cwd: options.cwd,
            timeout: getVoiceReplyCompositionStepTimeout(
              getVoiceReplyTimeout(options.handler),
              step,
              startedAt,
            ),
            execCommand: options.execCommand,
            stdin: stdout,
          },
        );
        stdout = result.stdout;
      } catch (error) {
        if (typeof step === "object" && step.failure === "root") throw error;
        stdout = "";
      }
      if (!stdout) stdout = text;
    }
    return stdout.trim() || text;
  }
  const result = await runVoiceReplyCommand(
    "Outbound text template",
    options.handler,
    values,
    {
      cwd: options.cwd,
      timeout: getVoiceReplyTimeout(options.handler),
      execCommand: options.execCommand,
      stdin: text,
    },
  );
  return result.stdout.trim() || text;
}

export async function transformTelegramOutboundText(
  text: string,
  options: {
    handlers?: TelegramOutboundHandlerConfig[];
    cwd?: string;
    execCommand: TelegramVoiceReplySenderDeps["execCommand"];
    recordRuntimeEvent?: TelegramVoiceReplySenderDeps["recordRuntimeEvent"];
  },
): Promise<string> {
  let transformed = text;
  for (const handler of findTelegramOutboundHandlers(
    options.handlers,
    "text",
  )) {
    try {
      transformed = await transformTelegramOutboundTextWithHandler(
        transformed,
        {
          handler,
          cwd: options.cwd ?? process.cwd(),
          execCommand: options.execCommand,
        },
      );
    } catch (error) {
      options.recordRuntimeEvent?.("outbound-text-handler", error, {
        handler: outboundHandlerMatchesType(handler, "text")
          ? "text"
          : "unknown",
      });
    }
  }
  return transformed;
}

function isTelegramInlineKeyboardLike(
  replyMarkup: unknown,
): replyMarkup is TelegramInlineKeyboardLike {
  if (!replyMarkup || typeof replyMarkup !== "object") return false;
  const keyboard = (replyMarkup as { inline_keyboard?: unknown })
    .inline_keyboard;
  return Array.isArray(keyboard);
}

async function transformTelegramOutboundReplyMarkup<TReplyMarkup>(
  replyMarkup: TReplyMarkup | undefined,
  options: Omit<TelegramOutboundTextTransformOptions, "replyMarkup">,
): Promise<TReplyMarkup | undefined> {
  if (!isTelegramInlineKeyboardLike(replyMarkup)) return replyMarkup;
  const translatedRows = [];
  for (const row of replyMarkup.inline_keyboard) {
    const translatedRow = [];
    for (const button of row) {
      const text = await transformTelegramOutboundText(button.text, options);
      translatedRow.push({ ...button, text });
    }
    translatedRows.push(translatedRow);
  }
  return { ...replyMarkup, inline_keyboard: translatedRows } as TReplyMarkup;
}

export async function transformTelegramOutboundTextReply<
  TReplyMarkup = unknown,
>(
  text: string,
  options: TelegramOutboundTextTransformOptions<TReplyMarkup>,
): Promise<TelegramOutboundTextTransformResult<TReplyMarkup>> {
  const transformOptions = {
    handlers: options.handlers,
    cwd: options.cwd,
    execCommand: options.execCommand,
    recordRuntimeEvent: options.recordRuntimeEvent,
  };
  const transformedText = await transformTelegramOutboundText(
    text,
    transformOptions,
  );
  const replyMarkup = await transformTelegramOutboundReplyMarkup(
    options.replyMarkup,
    transformOptions,
  );
  return { text: transformedText, ...(replyMarkup ? { replyMarkup } : {}) };
}

export function createTelegramOutboundTextReplyRuntime<TReplyMarkup = unknown>(
  deps: TelegramOutboundTextReplyRuntimeDeps<TReplyMarkup>,
): Pick<
  TelegramOutboundTextReplyRuntimeDeps<TReplyMarkup>,
  "sendTextReply" | "sendMarkdownReply"
> {
  return {
    sendTextReply: async (chatId, replyToMessageId, text, options) => {
      const transformed = await transformTelegramOutboundText(text, {
        handlers: deps.getHandlers?.(),
        cwd: deps.cwd,
        execCommand: deps.execCommand,
        recordRuntimeEvent: deps.recordRuntimeEvent,
      });
      return deps.sendTextReply(chatId, replyToMessageId, transformed, options);
    },
    sendMarkdownReply: async (chatId, replyToMessageId, markdown, options) => {
      const transformed = await transformTelegramOutboundTextReply(markdown, {
        handlers: deps.getHandlers?.(),
        cwd: deps.cwd,
        execCommand: deps.execCommand,
        recordRuntimeEvent: deps.recordRuntimeEvent,
        replyMarkup: options?.replyMarkup,
      });
      return deps.sendMarkdownReply(
        chatId,
        replyToMessageId,
        transformed.text,
        {
          ...options,
          ...(transformed.replyMarkup
            ? { replyMarkup: transformed.replyMarkup }
            : {}),
        },
      );
    },
  };
}

export function createTelegramOutboundTextPreviewRuntime<
  TReplyMarkup = unknown,
>(
  deps: TelegramOutboundTextPreviewRuntimeDeps<TReplyMarkup>,
): Pick<
  TelegramOutboundTextPreviewRuntimeDeps<TReplyMarkup>,
  "finalizeMarkdownPreview"
> {
  return {
    finalizeMarkdownPreview: async (
      chatId,
      markdown,
      replyToMessageId,
      options,
    ) => {
      const transformed = await transformTelegramOutboundTextReply(markdown, {
        handlers: deps.getHandlers?.(),
        cwd: deps.cwd,
        execCommand: deps.execCommand,
        recordRuntimeEvent: deps.recordRuntimeEvent,
        replyMarkup: options?.replyMarkup,
      });
      return deps.finalizeMarkdownPreview(
        chatId,
        transformed.text,
        replyToMessageId,
        {
          ...options,
          ...(transformed.replyMarkup
            ? { replyMarkup: transformed.replyMarkup }
            : {}),
        },
      );
    },
  };
}

export interface TelegramOutboundReplyPlan<TReplyMarkup = unknown> {
  markdown: string;
  replyMarkup?: TReplyMarkup;
  voiceText?: string;
  voiceReplies?: TelegramVoiceReplyItem[];
  lang?: string;
  rate?: string;
}

// --- Voice Policy Re-Exports ---
export {
  clearTelegramVoiceSynthesisProviders,
  clearTelegramVoiceTranscriptionProviders,
  computeVoicePromptContribution,
  computeVoiceTurnFlags,
  getTelegramVoiceReplyMode,
  getTelegramVoiceSynthesisProviders,
  getTelegramVoiceTranscriptionProviders,
  hasTelegramVoiceSynthesisProvider,
  hasTelegramVoiceTranscriptionProvider,
  isVoiceTurn,
  registerTelegramVoiceSynthesisProvider,
  registerTelegramVoiceTranscriptionProvider,
  shouldSuppressPreviewForVoice,
  type TelegramVoiceReplyMode,
  type TelegramVoiceSynthesisProvider,
  type TelegramVoiceSynthesisProviderResult,
  type TelegramVoiceTranscriptionFile,
  type TelegramVoiceTranscriptionProvider,
  type TelegramVoiceTranscriptionProviderResult,
  type TelegramVoiceTurnView,
} from "./voice.ts";

export function createTelegramVoiceReplySender(
  deps: TelegramVoiceReplySenderDeps,
) {
  return createTelegramVoiceReplySenderWithPorts(deps, {
    findVoiceHandlers: (handlers) =>
      findTelegramOutboundHandlers(
        handlers as TelegramOutboundHandlerConfig[] | undefined,
        "voice",
      ),
    generateVoiceFile: (text, options) =>
      generateTelegramVoiceReplyFile(text, {
        lang: options.lang,
        rate: options.rate,
        handler: options.handler,
        tempDir: options.tempDir,
        cwd: options.cwd,
        execCommand: options.execCommand,
      }),
    getProgrammaticVoiceHandlers: () =>
      getTelegramOutboundProgrammaticHandlers("voice"),
  });
}

export {
  createTelegramButtonActionStore,
  createTelegramButtonPromptTurn,
  createTelegramButtonReplyPlanner,
  handleTelegramButtonCallbackQuery,
  planTelegramButtonReply,
  type TelegramButtonActionStore,
  type TelegramButtonCallbackHandlerDeps,
  type TelegramButtonCallbackQuery,
  type TelegramButtonReplyPlan,
  type TelegramOutboundButtonAction,
  type TelegramOutboundButtonMarkup,
  type TelegramOutboundButtonStoredAction,
} from "./outbound-buttons.ts";

export function createTelegramOutboundReplyPlanner(
  store: Pick<TelegramButtonActionStore, "register">,
): (
  markdown: string,
) => TelegramOutboundReplyPlan<TelegramOutboundButtonMarkup> {
  return (markdown) => {
    const buttonReply = planTelegramButtonReply(markdown, {
      registerAction: store.register,
    });

    // Button replies can also contain <!-- telegram_voice --> markup
    const voiceReply = planTelegramVoiceReply(buttonReply.markdown);

    return {
      markdown: voiceReply.markdown,
      ...(buttonReply.replyMarkup
        ? { replyMarkup: buttonReply.replyMarkup }
        : {}),
      ...(voiceReply.voiceText ? { voiceText: voiceReply.voiceText } : {}),
      ...(voiceReply.voiceReplies
        ? { voiceReplies: voiceReply.voiceReplies }
        : {}),
      ...(voiceReply.lang ? { lang: voiceReply.lang } : {}),
      ...(voiceReply.rate ? { rate: voiceReply.rate } : {}),
    };
  };
}

/**
 * Create an artifact sender that delivers planned voice replies for a turn.
 * Iterates over `voiceReplies` (or a single `voiceText`) and sends each as
 * a Telegram voice message via the voice reply sender. Throws if no voice
 * reply could be delivered.
 */

// --- Outbound Reply Artifacts ---

export function createTelegramOutboundReplyArtifactSender(
  deps: TelegramVoiceReplySenderDeps,
) {
  const sendVoiceReply = createTelegramVoiceReplySender(deps);
  return async (
    turn: TelegramVoiceReplyTurnView,
    plan: Pick<
      TelegramOutboundReplyPlan,
      "voiceText" | "voiceReplies" | "lang" | "rate" | "replyMarkup"
    >,
    options?: { replyToPrompt?: boolean },
  ): Promise<void> => {
    // Normalize voice replies: either use explicit voiceReplies array or fall back to voiceText
    const voiceReplies = plan.voiceReplies?.length
      ? plan.voiceReplies
      : plan.voiceText
        ? [{ text: plan.voiceText, lang: plan.lang, rate: plan.rate }]
        : [];

    let anyDelivered = false;

    for (const reply of voiceReplies) {
      try {
        await sendVoiceReply(turn, reply.text, {
          lang: reply.lang ?? plan.lang,
          rate: reply.rate ?? plan.rate,
          // Only attach reply parameters to the first voice message
          replyToPrompt: options?.replyToPrompt === true && !anyDelivered,
          replyMarkup: !anyDelivered ? plan.replyMarkup : undefined,
        });
        anyDelivered = true;
      } catch {
        // sendVoiceReply already recorded the error; continue to next reply
      }
    }

    if (!anyDelivered) {
      throw new Error(
        "Failed to send voice reply: every voice synthesis provider failed.",
      );
    }
  };
}

// --- Public Assistant Output Delivery ---

export interface TelegramAssistantOutputMutationFence {
  run: <TArgs extends unknown[], TResult>(
    mutation: (...args: TArgs) => Promise<TResult>,
    ...args: TArgs
  ) => Promise<TResult>;
}

export interface TelegramAssistantOutputDeliveryAuthority<TTransportStamp> {
  transportStamp: TTransportStamp;
  route: "direct" | "follower" | "none";
  directEpoch?: number | string;
  followerGeneration?: string;
  target?: TelegramTarget;
}

export function createTelegramAssistantOutputMutationFence(
  isAuthorityActive: () => boolean,
): TelegramAssistantOutputMutationFence {
  return {
    run(mutation, ...args) {
      if (!isAuthorityActive()) {
        return Promise.reject(
          new Error(
            "Assistant output lost admission authority before transport mutation.",
          ),
        );
      }
      return mutation(...args);
    },
  };
}

export function createTelegramAssistantOutputSender<
  TTransportStamp,
  TReplyMarkup = unknown,
>(deps: {
  recordOwnership?: Replies.TelegramReplyOwnershipRecorder["record"];
  sendMessage: (
    body: TelegramSendMessageBody,
  ) => Promise<TelegramSentMessage>;
  sendRichMessage: (
    body: TelegramSendRichMessageBody,
  ) => Promise<TelegramSentMessage>;
  editMessage: (
    body: TelegramEditMessageTextBody,
  ) => Promise<unknown>;
  getAssistantRenderingMode: () => "rich" | "html";
  execCommand: TelegramOutboundTextReplyRuntimeDeps<TReplyMarkup>["execCommand"];
  getHandlers?: TelegramOutboundTextReplyRuntimeDeps<TReplyMarkup>["getHandlers"];
  recordRuntimeEvent?: TelegramOutboundTextReplyRuntimeDeps<TReplyMarkup>["recordRuntimeEvent"];
}): (
  event: TelegramAssistantSegmentEvent,
  authority: TelegramAssistantOutputDeliveryAuthority<TTransportStamp>,
  isAuthorityActive: () => boolean,
) => Promise<void> {
  return async function sendAssistantOutput(
    event,
    authority,
    isAuthorityActive,
  ) {
    const target = authority.target;
    if (!target) {
      throw new Error("Assistant output has no authorized Telegram target.");
    }
    const mutationFence =
      createTelegramAssistantOutputMutationFence(isAuthorityActive);
    const replyRuntime = Replies.createTelegramRenderedMessageDeliveryRuntime({
      recordOwnership: deps.recordOwnership,
      sendMessage(body) {
        return mutationFence.run(deps.sendMessage, body);
      },
      sendRichMessage(body) {
        return mutationFence.run(deps.sendRichMessage, body);
      },
      getAssistantRenderingMode: deps.getAssistantRenderingMode,
      editMessage(body) {
        return mutationFence.run(deps.editMessage, body);
      },
    });
    const outboundRuntime = createTelegramOutboundTextReplyRuntime({
      sendTextReply: replyRuntime.sendTextReply,
      sendMarkdownReply: replyRuntime.sendMarkdownReply,
      execCommand: deps.execCommand,
      getHandlers: deps.getHandlers,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    });
    await outboundRuntime.sendMarkdownReply(
      target.chatId,
      undefined,
      event.text,
      { target },
    );
  };
}
