/**
 * Telegram outbound handler helpers
 * Zones: telegram outbound, assistant markup, command templates, callback routing
 * Owns assistant-authored outbound markup extraction, configured artifact generation, callback actions, and Telegram outbound delivery
 */

// ======================================================
// === Shared Helpers & Utilities
// ======================================================

import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import type { PendingTelegramTurn } from "./queue.ts";

import {
  VOICE_EVENT_RECORDER_KEY,
  OUTBOUND_HANDLER_REGISTRY_KEY,
} from "./globals.ts";

function buildVoiceReplyParameters(
  replyToPrompt: boolean | undefined,
  replyToMessageId: number | undefined,
): string | undefined {
  if (replyToPrompt === false || replyToMessageId === undefined) return undefined;
  return JSON.stringify({
    message_id: replyToMessageId,
    allow_sending_without_reply: true,
  });
}

async function ensureTelegramVoiceFileFormat(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".opus" || ext === ".ogg") {
    return filePath;
  }
  throw new Error(
    `Voice provider must return .ogg or .opus files, got ${ext}. ` +
      `Providers should handle format conversion internally.`,
  );
}

import { truncateTelegramQueueSummary } from "./queue.ts";
import {
  buildCommandTemplateInvocation,
  expandCommandTemplateConfigs,
  substituteCommandTemplateToken,
  type CommandTemplateObjectConfig,
} from "./command-templates.ts";

const TELEGRAM_BUTTON_CALLBACK_PREFIX = "tgbtn";
const TELEGRAM_BUTTON_ACTION_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_VOICE_TIMEOUT_MS = 120_000;

// ======================================================
// === Types
// ======================================================

/**
 * Record a runtime event that appears in `/telegram-status`.
 * Voice provider extensions (e.g. `pi-xai-voice`) can call this to surface
 * diagnostics alongside pi-telegram's own events. Events are silently dropped
 * when pi-telegram is not loaded.
 */
export function recordTelegramRuntimeEvent(
  category: string,
  error: unknown,
  details?: Record<string, unknown>,
): void {
  const recorder = (globalThis as Record<string, unknown>)[VOICE_EVENT_RECORDER_KEY];
  if (typeof recorder === "function") {
    (recorder as (category: string, error: unknown, details?: Record<string, unknown>) => void)(
      category,
      error,
      details,
    );
  }
}

export type TelegramOutboundCommandTemplateConfig =
  | string
  | CommandTemplateObjectConfig;
export interface TelegramOutboundHandlerConfig extends CommandTemplateObjectConfig {
  type?: string;
  match?: string | string[];
  pipe?: TelegramOutboundCommandTemplateConfig[];
  output?: string;
  timeout?: number;
}

export interface TelegramVoiceReplyItem {
  text: string;
  lang?: string;
  rate?: string;
}

export interface TelegramVoiceReplyPlan {
  markdown: string;
  voiceText?: string;
  voiceReplies?: TelegramVoiceReplyItem[];
  lang?: string;
  rate?: string;
}

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
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

/**
 * What a voice provider can return for a single synthesis.
 * pi-telegram only cares about delivery; the provider (xai-voice etc.) owns
 * text optimisation, speech tags, and whether to return `transcriptText` at all
 * (based on the user's "Send Transcript" toggle).
 *
 * - If `transcriptText` is returned, it is attached as the voice message **caption**.
 * - Separate transcript messages are no longer sent (the old `sendTranscriptAsMessage`
 *   flag is deprecated and ignored for transcript).
 */
export type TelegramVoiceReplyMode = "mirror" | "voice" | "manual";

export type TelegramVoiceProviderResult =
  | string
  | {
      audioPath: string;
      transcriptText?: string;
      sendTranscriptAsMessage?: boolean;
    }
  | undefined;

// --- Programmatic Outbound Handler Registry ---

export type TelegramOutboundProgrammaticHandler = (
  text: string,
  options?: { lang?: string; rate?: string },
) => Promise<string>;

export interface TelegramOutboundHandlerRegistry {
  handlers: Map<string, TelegramOutboundProgrammaticHandler[]>;
}

// ======================================================
// === Outbound Handler Registry (generisch)
// ======================================================

function getOrCreateOutboundHandlerRegistry(): TelegramOutboundHandlerRegistry {
  const existing = (globalThis as Record<string, unknown>)[OUTBOUND_HANDLER_REGISTRY_KEY];
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
  (globalThis as Record<string, unknown>)[OUTBOUND_HANDLER_REGISTRY_KEY] = registry;
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


/**
 * View passed to a voice provider's optional prompt contribution hook.
 * Allows providers (e.g. pi-xai-voice) to supply voice-specific LLM instructions
 * for clean TTS output (e.g. "Reply ONLY with the spoken text. NO thinking...").
 * pi-telegram itself stays minimal and does not hard-code voice LLM guidance.
 */
export interface TelegramVoiceTurnView {
  voiceReplyPreferred?: boolean;
  voiceReplyRequired?: boolean;
  hasVoiceInput?: boolean;
  /** The original text from the user (before any rewriting). */
  userText?: string;
}

/**
 * Voice provider for TTS synthesis + optional prompt contribution.
 * The function part receives text + optional `{ lang?, rate? }`.
 * Returns a Promise resolving to either:
 *   - the file path of the generated audio file (`string`)
 *   - `{ audioPath, transcriptText? }` where `audioPath` is the file path and
 *     `transcriptText` is the clean caption shown below the voice message
 *   - `undefined` to skip voice delivery for this text
 *
 * The optional `getVoicePromptContribution` (if provided) is called by the bridge
 * when building the agent prompt for a voice-tagged turn. The provider returns
 * the exact text to append (or undefined). This is the seam that lets voice
 * providers own all voice-specific LLM guidance while the bridge only offers
 * the registration and delivery interfaces.
 */
export interface TelegramVoiceProvider {
  (
    text: string,
    options?: { lang?: string; rate?: string },
  ): Promise<TelegramVoiceProviderResult>;

  /**
   * Optional hook that allows the voice provider to supply the current voice policy
   * (e.g. replyMode). The bridge will call this when it needs to know the active policy
   * for a voice-tagged turn.
   *
   * This replaces the previous global fallback mechanism.
   */
  getVoicePolicy?: () => { replyMode?: TelegramVoiceReplyMode };

  getVoicePromptContribution?: (view: TelegramVoiceTurnView) => string | undefined;
}

/**
 * Register a voice provider for outbound voice reply delivery.
 *
 * Voice provider extensions call this to register a TTS backend.
 * The bridge detects the presence of a registered provider at delivery time
 * and routes voice replies through it.
 *
 * The provider may be a function (backward-compatible) or an object implementing
 * `TelegramVoiceProvider` (with optional `getVoicePromptContribution` for
 * provider-owned LLM guidance on voice turns).
 *
 * @example
 * ```typescript
 * import { registerTelegramVoiceProvider } from "@llblab/pi-telegram";
 *
 * const dispose = registerTelegramVoiceProvider(myVoiceProvider, {
 *   id: "xai",
 * });
 * ```
 *
 * @param provider - Function or object. Function receives text + optional
 *   `{ lang?, rate? }` and returns the audio path / object / undefined.
 *   Object form may also provide:
 *   - `getVoicePolicy()` → returns current voice policy (e.g. replyMode). The bridge
 *     will call this when it needs to determine the active voice reply policy.
 *   - `getVoicePromptContribution(view)` → supplies voice-specific LLM instructions
 *     that the bridge injects into the prompt for voice-tagged turns.
 * @param options.id - Stable identifier for the provider.
 * @returns Disposer function that unregisters the provider.
 */
// ======================================================
// === Voice Provider Registry
// ======================================================

/**
 * Voice providers are registered separately from normal outbound handlers.
 *
 * Reason: Voice providers can implement additional methods:
 *   - getVoicePolicy() → returns current reply mode (mirror/voice/manual)
 *   - getVoicePromptContribution(view) → LLM instructions for voice turns
 *
 * The bridge calls these methods to tag turns and inject voice-specific guidance.
 * Delivery (sending the actual audio) is handled in the Voice Delivery section below.
 */

export interface TelegramOutboundTextReplyRuntimeDeps<TReplyMarkup = unknown> {
  execCommand: TelegramVoiceReplySenderDeps["execCommand"];
  getHandlers?: () => TelegramOutboundHandlerConfig[] | undefined;
  sendTextReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    text: string,
    options?: { parseMode?: "HTML" },
  ) => Promise<number | undefined>;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: { replyMarkup?: TReplyMarkup },
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

export interface TelegramOutboundTextPreviewRuntimeDeps<TReplyMarkup = unknown> {
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

interface TelegramTopLevelHtmlComment {
  raw: string;
  content: string;
  start: number;
  end: number;
}

interface TelegramTopLevelFenceState {
  marker: "`" | "~";
  length: number;
}

function isTelegramActionCommentContent(content: string): boolean {
  const normalizedContent = content.replace(/^\s+/, "");
  const [head = ""] = normalizedContent.split(/\r?\n/, 1);
  return ["telegram_voice", "telegram_button"].some((command) => {
    if (!head.startsWith(command)) return false;
    const nextChar = head[command.length];
    return nextChar === undefined || /\s|:/.test(nextChar);
  });
}

function getMarkdownLineEnd(markdown: string, offset: number): number {
  const newlineIndex = markdown.indexOf("\n", offset);
  return newlineIndex === -1 ? markdown.length : newlineIndex + 1;
}

function getMarkdownLineText(
  markdown: string,
  offset: number,
  end: number,
): string {
  return markdown.slice(offset, end).replace(/\r?\n$/, "");
}

function getTopLevelOpeningFence(
  line: string,
): TelegramTopLevelFenceState | undefined {
  const match = line.match(/^(?: {0,3})(`{3,}|~{3,})/);
  const sequence = match?.[1];
  if (!sequence) return undefined;
  return {
    marker: sequence[0] as "`" | "~",
    length: sequence.length,
  };
}

function isTopLevelClosingFence(
  line: string,
  fence: TelegramTopLevelFenceState,
): boolean {
  const match = line.match(/^(?: {0,3})(`{3,}|~{3,})([ \t]*)$/);
  const sequence = match?.[1];
  return (
    !!sequence &&
    sequence[0] === fence.marker &&
    sequence.length >= fence.length
  );
}

function collectInlineClosedTelegramActionBody(
  markdown: string,
  bodyStart: number,
  commentContent: string,
): { content: string; end: number } | undefined {
  const bodyLineEnd = getMarkdownLineEnd(markdown, bodyStart);
  const bodyLine = getMarkdownLineText(markdown, bodyStart, bodyLineEnd);
  const closeLineEnd = getMarkdownLineEnd(markdown, bodyLineEnd);
  const closeLine = getMarkdownLineText(markdown, bodyLineEnd, closeLineEnd);
  const hasRecoverableBody =
    isTelegramActionCommentContent(commentContent) &&
    bodyLine.trim() !== "" &&
    !bodyLine.startsWith("<!--") &&
    !bodyLine.startsWith("-->") &&
    closeLine === "-->";
  if (!hasRecoverableBody) return undefined;
  return {
    content: `${commentContent.trimEnd()}\n${bodyLine}`,
    end: bodyLineEnd + 3,
  };
}

function collectTopLevelHtmlComments(markdown: string): {
  comments: TelegramTopLevelHtmlComment[];
  openCommentStart?: number;
} {
  const comments: TelegramTopLevelHtmlComment[] = [];
  let offset = 0;
  let fence: TelegramTopLevelFenceState | undefined;
  while (offset < markdown.length) {
    const lineEnd = getMarkdownLineEnd(markdown, offset);
    const line = getMarkdownLineText(markdown, offset, lineEnd);
    if (fence) {
      if (isTopLevelClosingFence(line, fence)) fence = undefined;
      offset = lineEnd;
      continue;
    }
    const nextFence = getTopLevelOpeningFence(line);
    if (nextFence) {
      fence = nextFence;
      offset = lineEnd;
      continue;
    }
    if (line.startsWith("<!--")) {
      const closeIndex = markdown.indexOf("-->", offset + 4);
      if (closeIndex === -1) return { comments, openCommentStart: offset };
      let end = closeIndex + 3;
      let raw = markdown.slice(offset, end);
      let content = raw.slice(4, -3);
      const closeColumn = closeIndex - offset;
      const closesOnOpeningLine = closeIndex < lineEnd;
      const hasOnlyWhitespaceAfterClose =
        line.slice(closeColumn + 3).trim() === "";
      const inlineBody =
        closesOnOpeningLine && hasOnlyWhitespaceAfterClose
          ? collectInlineClosedTelegramActionBody(markdown, lineEnd, content)
          : undefined;
      if (inlineBody) {
        end = inlineBody.end;
        raw = markdown.slice(offset, end);
        content = inlineBody.content;
      }
      comments.push({ raw, content, start: offset, end });
      offset = getMarkdownLineEnd(markdown, end);
      continue;
    }
    offset = lineEnd;
  }
  return { comments };
}






/**
 * Parse a Markdown reply for `telegram_voice` blocks and build a voice reply plan.
 * Returns the stripped Markdown, extracted voice text, and any per-block
 * `lang` / `rate` overrides found in the markup.
 */
// ======================================================
// === Voice Delivery
// ======================================================

/**
 * Voice Delivery
 *
 * This section contains everything needed to actually deliver voice messages
 * (calling providers, sending via Telegram, handling transcripts, etc.).
 *
 * Important separation:
 * - All policy, tagging, and voice-specific decision logic lives in `lib/voice.ts`.
 * - This module only executes the delivery based on what voice.ts has decided.
 */


/**
 * Voice Delivery
 *
 * This section is responsible for the actual sending of voice messages
 * through registered providers. It handles:
 *   - Calling voice providers (TTS)
 *   - Ensuring OGG/Opus format
 *   - Sending the voice message via Telegram
 *   - Handling transcript (as caption or separate message)
 *
 * Note: The decision *whether* something should be voice (policy, tagging)
 * lives in `lib/voice.ts`. This module only executes the delivery.
 */

function extractVoiceResult(result: any): { filePath: string; transcriptText?: string } {
  if (typeof result === "string") {
    return { filePath: result };
  }
  return {
    filePath: result.audioPath,
    transcriptText: result.transcriptText,
  };
}

async function sendVoiceChatAction(deps: TelegramVoiceReplySenderDeps, chatId: number) {
  if (deps.sendRecordVoiceAction) {
    await deps.sendRecordVoiceAction(chatId).catch(() => {});
  } else {
    await deps.sendChatAction?.(chatId, "record_voice").catch(() => {});
  }
}


// --- Voice Reply Timeout Helpers ---

function getVoiceReplyConfiguredTimeout(
  config: TelegramOutboundCommandTemplateConfig | undefined,
): number | undefined {
  const timeout = typeof config === "string" ? undefined : config?.timeout;
  return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
    ? timeout
    : undefined;
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
        ? { retry: config.retry }
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
  if (handler.pipe?.length) {
    return expandCommandTemplateConfigs({
      ...handler,
      template: handler.pipe,
    }) as TelegramOutboundCommandTemplateConfig[];
  }
  return [];
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
        if (typeof step === "object" && step.critical) throw error;
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
  for (const handler of findTelegramOutboundHandlers(options.handlers, "text")) {
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
        handler: outboundHandlerMatchesType(handler, "text") ? "text" : "unknown",
      });
    }
  }
  return transformed;
}

function isTelegramInlineKeyboardLike(
  replyMarkup: unknown,
): replyMarkup is TelegramInlineKeyboardLike {
  if (!replyMarkup || typeof replyMarkup !== "object") return false;
  const keyboard = (replyMarkup as { inline_keyboard?: unknown }).inline_keyboard;
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

export async function transformTelegramOutboundTextReply<TReplyMarkup = unknown>(
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
      return deps.sendMarkdownReply(chatId, replyToMessageId, transformed.text, {
        ...options,
        ...(transformed.replyMarkup
          ? { replyMarkup: transformed.replyMarkup }
          : {}),
      });
    },
  };
}

export function createTelegramOutboundTextPreviewRuntime<TReplyMarkup = unknown>(
  deps: TelegramOutboundTextPreviewRuntimeDeps<TReplyMarkup>,
): Pick<
  TelegramOutboundTextPreviewRuntimeDeps<TReplyMarkup>,
  "finalizeMarkdownPreview"
> {
  return {
    finalizeMarkdownPreview: async (chatId, markdown, replyToMessageId, options) => {
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

// Re-export the new Voice policy/tagging layer from the dedicated voice.ts module
// (Voice v2 domain split). The Voice registry, parsing, and delivery
// stay in this file (original Voice Support location) and are imported by
// voice.ts for the policy resolution that needs to ask providers for their policy.
//
// NOTE: This creates a deliberate import cycle (voice.ts ↔ outbound-handlers.ts).
// It is accepted because it keeps the voice domain cohesive while the heavy
// Telegram-specific parser + delivery logic lives in outbound-handlers.
// See tests/invariants.test.ts (the "Voice domain stays free of local domain imports" check
// explicitly allows this one cycle).
export {
  getTelegramVoiceReplyMode,
  computeVoiceTurnFlags,
  isVoiceTurn,
  shouldSuppressPreviewForVoice,
  computeVoicePromptContribution,
} from "./voice.ts";

import { VOICE_PROVIDER_REGISTRY_KEY } from "./globals.ts";


// ======================================================
// === Voice Provider Registry (restored to outbound-handlers.ts for load + original location)
// ======================================================

function getOrCreateVoiceProviderRegistry(): Map<string, TelegramVoiceProvider> {
  const existing = (globalThis as Record<string, unknown>)[VOICE_PROVIDER_REGISTRY_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, TelegramVoiceProvider>;
  }
  const registry = new Map<string, TelegramVoiceProvider>();
  (globalThis as Record<string, unknown>)[VOICE_PROVIDER_REGISTRY_KEY] = registry;
  return registry;
}

export function registerTelegramVoiceProvider(
  provider: TelegramVoiceProvider | ((text: string, options?: { lang?: string; rate?: string }) => Promise<string | { audioPath: string; transcriptText?: string } | undefined>),
  options?: { id?: string },
): () => void {
  const registry = getOrCreateVoiceProviderRegistry();
  const id = options?.id ?? `voice-provider-${registry.size}`;
  let normalized: TelegramVoiceProvider;
  if (typeof provider === "function") {
    // Non-mutating wrapper for function-form providers.
    // Explicitly forward the known hooks so we don't rely on Object.assign
    // copying prototype or non-enumerable properties.
    const wrapper = Object.assign(
      (text: string, options?: { lang?: string; rate?: string }) => provider(text, options),
      {
        getVoicePolicy: (provider as any).getVoicePolicy,
        getVoicePromptContribution: undefined,
      },
    ) as TelegramVoiceProvider;
    normalized = wrapper;
  } else {
    normalized = provider;
  }
  registry.set(id, normalized);
  return () => {
    registry.delete(id);
  };
}

export function getTelegramVoiceProviders(): TelegramVoiceProvider[] {
  return Array.from(getOrCreateVoiceProviderRegistry().values());
}

export function hasTelegramVoiceProvider(): boolean {
  return getOrCreateVoiceProviderRegistry().size > 0;
}

export function clearTelegramVoiceProviders(): void {
  getOrCreateVoiceProviderRegistry().clear();
}

// ======================================================
// === Voice Delivery
// ======================================================

/**
 * Creates a function that sends voice replies using registered voice providers.
 *
 * This is the main entry point for delivering voice messages.
 * The actual decision logic (when to use voice) lives in `lib/voice.ts`.
 */
export function createTelegramVoiceReplySender(
  deps: TelegramVoiceReplySenderDeps,
) {
  return async function sendVoiceReply(
    turn: TelegramVoiceReplyTurnView,
    text: string,
    options?: { lang?: string; rate?: string; replyToPrompt?: boolean; replyMarkup?: unknown },
  ): Promise<void> {
    const providers = getTelegramVoiceProviders();

    for (const [index, provider] of providers.entries()) {
      let voiceFilePath: string | undefined;
      let originalFilePath: string | undefined;

      try {
        if (typeof provider !== "function") {
          deps.recordRuntimeEvent?.("voice", new Error("Registered voice provider is not callable (policy-only object?)"), {
            phase: "voice-provider-skip",
          });
          continue;
        }

        const providerResult = await provider(text, {
          lang: options?.lang,
          rate: options?.rate,
        });

        if (!providerResult) {
          deps.recordRuntimeEvent?.("voice", new Error("Voice provider returned empty path"), {
            phase: "voice-provider-skip",
          });
          continue;
        }

        const { filePath, transcriptText } = extractVoiceResult(providerResult);
        voiceFilePath = await ensureTelegramVoiceFileFormat(filePath);
        originalFilePath = filePath;

        // Show "recording voice" action
        await sendVoiceChatAction(deps, turn.chatId);

        const replyParameters = buildVoiceReplyParameters(
          options?.replyToPrompt,
          turn.replyToMessageId,
        );

        await deps.sendMultipart(
          "sendVoice",
          {
            chat_id: String(turn.chatId),
            ...(transcriptText ? { caption: transcriptText } : {}),
            ...(replyParameters ? { reply_parameters: replyParameters } : {}),
            ...(options?.replyMarkup !== undefined && options?.replyMarkup !== null
              ? {
                  reply_markup:
                    typeof options.replyMarkup === "string"
                      ? options.replyMarkup
                      : JSON.stringify(options.replyMarkup),
                }
              : {}),
          },
          "voice",
          voiceFilePath,
          basename(voiceFilePath),
        );

        // Transcript is attached as caption when the provider returns transcriptText
        // (controlled by the "Send Transcript" toggle in the Voice extension).
        // We no longer support sending transcript as a separate message (user feedback:
        // separate message approach is unwanted; caption-only is the desired "on" behavior,
        // and off means provider should not return transcriptText at all).

        return;
      } catch (error) {
        deps.recordRuntimeEvent?.("voice", error, { phase: "send" });
      } finally {
        if (voiceFilePath && voiceFilePath !== originalFilePath) {
          await unlink(voiceFilePath).catch(() => {});
        }
      }
    }

    const errorMessage = "Failed to send voice reply: every voice provider failed.";
    deps.recordRuntimeEvent?.("voice", new Error(errorMessage), { phase: "send" });
    throw new Error(errorMessage);
  };
}

export interface TelegramOutboundButtonAction {
  text: string;
  prompt: string;
}

export interface TelegramOutboundButtonStoredAction extends TelegramOutboundButtonAction {
  createdAt: number;
}

export type TelegramOutboundButtonMarkup = TelegramInlineKeyboardMarkup;

export interface TelegramButtonReplyPlan {
  markdown: string;
  replyMarkup?: TelegramOutboundButtonMarkup;
}

export interface TelegramButtonActionStore {
  register: (action: TelegramOutboundButtonAction) => string;
  resolve: (
    callbackData: string | undefined,
  ) => TelegramOutboundButtonAction | undefined;
}

export interface TelegramButtonCallbackQuery {
  id: string;
  data?: string;
  message?: {
    message_id?: number;
    chat?: { id?: number };
  };
}

export interface TelegramButtonCallbackHandlerDeps<TContext = unknown> {
  resolveAction: (
    callbackData: string | undefined,
  ) => TelegramOutboundButtonAction | undefined;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  enqueueButtonPrompt: (
    query: TelegramButtonCallbackQuery,
    action: TelegramOutboundButtonAction,
    ctx: TContext,
  ) => void;
}

function nowMs(): number {
  return Date.now();
}

function normalizeMarkdownAfterButtonExtraction(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

export function replaceTopLevelHtmlComments(
  markdown: string,
  replacer: (comment: TelegramTopLevelHtmlComment) => string,
): string {
  const { comments } = collectTopLevelHtmlComments(markdown);
  if (comments.length === 0) return markdown;
  let result = "";
  let offset = 0;
  for (const comment of comments) {
    result += markdown.slice(offset, comment.start);
    result += replacer(comment);
    offset = comment.end;
  }
  return result + markdown.slice(offset);
}

export function findTopLevelOpenOrPartialHtmlCommentIndex(markdown: string): number {
  const { openCommentStart } = collectTopLevelHtmlComments(markdown);
  if (openCommentStart !== undefined) return openCommentStart;
  let offset = 0;
  let fence: TelegramTopLevelFenceState | undefined;
  while (offset < markdown.length) {
    const lineEnd = getMarkdownLineEnd(markdown, offset);
    const line = getMarkdownLineText(markdown, offset, lineEnd);
    const isLastLine = lineEnd >= markdown.length;
    if (fence) {
      if (isTopLevelClosingFence(line, fence)) fence = undefined;
      offset = lineEnd;
      continue;
    }
    const nextFence = getTopLevelOpeningFence(line);
    if (nextFence) {
      fence = nextFence;
      offset = lineEnd;
      continue;
    }
    if (isLastLine && (line === "<" || line === "<!" || line === "<!-")) {
      return offset;
    }
    offset = lineEnd;
  }
  return -1;
}

export function parseTopLevelTelegramComment(
  comment: TelegramTopLevelHtmlComment,
  command: string,
): { head: string; body?: string } | undefined {
  let normalizedContent = comment.content.replace(/^\s+/, "");
  // Support both <!-- telegram_voice ... --> and <!--!telegram_voice ... --> forms
  normalizedContent = normalizedContent.replace(/^!/, "");
  const [rawHead = "", ...bodyLines] = normalizedContent.split(/\r?\n/);
  let head = rawHead.trimStart();
  // Only tolerate the '!' prefix (used in <!--!telegram_voice ... --> form).
  // We intentionally do *not* do a broad strip of arbitrary non-letter characters
  // to preserve the "column-zero only" + "must start with telegram_voice" contract.
  if (!head.startsWith(command)) return undefined;
  const nextChar = head[command.length];
  if (nextChar !== undefined && !/\s|:/.test(nextChar)) return undefined;
  return {
    head: head.slice(command.length),
    ...(bodyLines.length > 0 ? { body: bodyLines.join("\n") } : {}),
  };
}

// ======================================================
// === Voice-specific Comment Parsing Helpers
// (only for telegram_voice — live in voice.ts, but the generic base is above)
// ======================================================

/**
 * Extracts label and prompt from a telegram_button comment string.
 */
export function parseTelegramCommentAttributes(input: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of input.matchAll(
    /([A-Za-z_][A-Za-z0-9_-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/g,
  )) {
    const key = match[1];
    const value = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (value) attributes[key] = value;
  }
  return attributes;
}

function parseButtonsCommentAttributes(input: string): {
  label?: string;
  prompt?: string;
} {
  const attributes = parseTelegramCommentAttributes(input);
  return {
    ...(attributes.label ? { label: attributes.label } : {}),
    ...(attributes.prompt ? { prompt: attributes.prompt } : {}),
  };
}

/**
 * Parses the content of a telegram_button comment into button rows.
 * Supports simple forms and forms with explicit label + prompt.
 */
function parseButtonsCommentRows(
  head: string,
  body: string | undefined,
): TelegramOutboundButtonAction[][] {
  const trimmedHead = head.trim();

  if (body === undefined) {
    if (trimmedHead.startsWith(":")) {
      const label = trimmedHead.slice(1).trim();
      return label ? [[{ text: label, prompt: label }]] : [];
    }
    const attributes = parseButtonsCommentAttributes(head);
    return attributes.label && attributes.prompt
      ? [[{ text: attributes.label, prompt: attributes.prompt }]]
      : [];
  }

  const label = parseButtonsCommentAttributes(head).label;
  const prompt = body.trim();
  if (!label || !prompt) return [];
  return [[{ text: label, prompt }]];
}


// ======================================================
// === Button & Action Handling
// ======================================================

// The generic comment parsing helpers (replaceTopLevelHtmlComments, etc.)
// live locally in this file (used by both Voice and Button parsing).

export function normalizeMarkdownAfterVoiceExtraction(markdown: string): string {
  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

function parseVoiceReplyAttributes(input: string): {
  lang?: string;
  rate?: string;
  text?: string;
} {
  const attributes = parseTelegramCommentAttributes(input);
  return {
    ...(attributes.lang ? { lang: attributes.lang } : {}),
    ...(attributes.rate ? { rate: attributes.rate } : {}),
    ...(attributes.text ? { text: attributes.text } : {}),
  };
}

function parseVoiceCommentBody(
  head: string,
  body: string | undefined,
): {
  attrs: string;
  text: string;
} {
  const trimmedHead = head.trim();
  if (body !== undefined) {
    return { attrs: trimmedHead.replace(/^:/, "").trim(), text: body.trim() };
  }
  // Always look for the first colon (that is not inside quotes) to separate attributes from text.
  // This handles both simple ": text" and "attributes: text" forms.
  let colonIndex = -1;
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < trimmedHead.length; i++) {
    const char = trimmedHead[i];
    if (inQuote) {
      if (char === quoteChar) inQuote = false;
    } else {
      if (char === '"' || char === "'") {
        inQuote = true;
        quoteChar = char;
      } else if (char === ':') {
        colonIndex = i;
        break;
      }
    }
  }
  if (colonIndex > 0) {
    const attrsPart = trimmedHead.slice(0, colonIndex).trim();
    const textPart = trimmedHead.slice(colonIndex + 1).trim();
    const attrs = parseVoiceReplyAttributes(attrsPart);
    return { attrs: attrsPart, text: textPart || attrs.text || '', ...attrs };
  }
  if (trimmedHead.startsWith(":")) {
    return { attrs: "", text: trimmedHead.slice(1).trim() };
  }
  const attrs = parseVoiceReplyAttributes(trimmedHead);
  return { attrs: trimmedHead, text: attrs.text ?? "" };
}

export function stripTelegramCommentMarkupForPreview(markdown: string): string {
  const withoutClosedBlocks = replaceTopLevelHtmlComments(markdown, () => "");
  const openBlockIndex =
    findTopLevelOpenOrPartialHtmlCommentIndex(withoutClosedBlocks);
  const previewMarkdown =
    openBlockIndex >= 0
      ? withoutClosedBlocks.slice(0, openBlockIndex)
      : withoutClosedBlocks;
  return normalizeMarkdownAfterVoiceExtraction(previewMarkdown);
}

export function stripTelegramCommentMarkupForDelivery(markdown: string): string {
  const withoutClosedBlocks = replaceTopLevelHtmlComments(markdown, () => "");
  const openBlockIndex =
    findTopLevelOpenOrPartialHtmlCommentIndex(withoutClosedBlocks);
  const deliveryMarkdown =
    openBlockIndex >= 0
      ? withoutClosedBlocks.slice(0, openBlockIndex)
      : withoutClosedBlocks;
  return normalizeMarkdownAfterVoiceExtraction(deliveryMarkdown);
}

export function stripTelegramVoiceMarkupForPreview(markdown: string): string {
  return stripTelegramCommentMarkupForPreview(markdown);
}

/**
 * Parse a Markdown reply for `telegram_voice` blocks and build a voice reply plan.
 */
export function planTelegramVoiceReply(
  markdown: string,
): TelegramVoiceReplyPlan {
  const voiceReplies: TelegramVoiceReplyItem[] = [];
  let lang: string | undefined;
  let rate: string | undefined;
  const stripped = replaceTopLevelHtmlComments(markdown, (comment) => {
    let command = parseTopLevelTelegramComment(comment, "telegram_voice");
    if (!command) {
      // Robust fallback for Voice-specific comments.
      // Reached only for certain edge-case extractions from collectTopLevelHtmlComments
      // (e.g. comments with unusual leading characters or legacy forms that survive the
      // normalization in parseTopLevelTelegramComment but still contain "telegram_voice").
      // This path is intentionally narrow and not exercised by current documented usage.
      let content = comment.content.replace(/^\s+/, "").replace(/^!/, "");
      if (content.startsWith("telegram_voice")) {
        const headPart = content.slice("telegram_voice".length).trim();
        command = { head: headPart, body: undefined };
      }
    }
    if (!command) return "";
    const parsed = parseVoiceCommentBody(command.head, command.body);
    const attrs = parseVoiceReplyAttributes(parsed.attrs);
    if (parsed.text) {
      voiceReplies.push({
        text: parsed.text,
        ...(attrs.lang ? { lang: attrs.lang } : {}),
        ...(attrs.rate ? { rate: attrs.rate } : {}),
      });
    }
    if (attrs.lang) lang = attrs.lang;
    if (attrs.rate) rate = attrs.rate;
    return "";
  });
  const voiceText = voiceReplies
    .map((reply) => reply.text)
    .join("\n\n")
    .trim();
  return {
    markdown: stripTelegramCommentMarkupForDelivery(stripped),
    ...(voiceText ? { voiceText } : {}),
    ...(voiceReplies.length > 0 ? { voiceReplies } : {}),
    ...(lang ? { lang } : {}),
    ...(rate ? { rate } : {}),
  };
}

// ======================================================
// === Button & Action Handling
// ======================================================

/**
 * Handles assistant-authored buttons (<!-- telegram_button -->) and their callbacks.
 * Supports both simple buttons and buttons that enqueue a prompt when clicked.
 */

/**
 * Creates an in-memory store for button actions.
 * Buttons can be registered with a prompt that gets enqueued when the button is clicked.
 * Old actions are automatically cleaned up after the configured TTL.
 */
export function createTelegramButtonActionStore(
  options: { ttlMs?: number } = {},
): TelegramButtonActionStore {
  const ttlMs = options.ttlMs ?? TELEGRAM_BUTTON_ACTION_TTL_MS;
  const actions = new Map<string, TelegramOutboundButtonStoredAction>();
  function cleanup(currentTime: number): void {
    for (const [key, action] of actions) {
      if (currentTime - action.createdAt > ttlMs) actions.delete(key);
    }
  }
  return {
    register: (action) => {
      const currentTime = nowMs();
      cleanup(currentTime);

      // Short random key for the callback_data (e.g. tgbtn:abcd1234)
      const key = `${TELEGRAM_BUTTON_CALLBACK_PREFIX}:${randomUUID().slice(0, 8)}`;
      actions.set(key, { ...action, createdAt: currentTime });
      return key;
    },
    resolve: (callbackData) => {
      if (!callbackData?.startsWith(`${TELEGRAM_BUTTON_CALLBACK_PREFIX}:`)) {
        return undefined;
      }

      const currentTime = nowMs();
      cleanup(currentTime);

      const action = actions.get(callbackData);
      if (!action) return undefined;

      return { text: action.text, prompt: action.prompt };
    },
  };
}

/**
 * Parses assistant markdown for `<!-- telegram_button -->` blocks
 * and builds a button plan (inline keyboard + registered actions).
 * Supports both simple label-only buttons and buttons with explicit prompts.
 */
export function planTelegramButtonReply(
  markdown: string,
  deps: { registerAction: (action: TelegramOutboundButtonAction) => string },
): TelegramButtonReplyPlan {
  const keyboard: TelegramOutboundButtonMarkup["inline_keyboard"] = [];
  const stripped = replaceTopLevelHtmlComments(markdown, (comment) => {
    const command = parseTopLevelTelegramComment(comment, "telegram_button");
    if (!command) return comment.raw;
    const rows = parseButtonsCommentRows(command.head, command.body);
    for (const row of rows) {
      keyboard.push(
        row.map((button) => ({
          text: button.text,
          callback_data: deps.registerAction(button),
        })),
      );
    }
    return "";
  });
  return {
    markdown: normalizeMarkdownAfterButtonExtraction(stripped),
    ...(keyboard.length > 0
      ? { replyMarkup: { inline_keyboard: keyboard } }
      : {}),
  };
}

/**
 * Creates a thin planner that combines `planTelegramButtonReply` with a given action store.
 * Mainly used to keep the call site clean when planning button replies from the artifact sender.
 */
export function createTelegramButtonReplyPlanner(
  store: Pick<TelegramButtonActionStore, "register">,
): (markdown: string) => TelegramButtonReplyPlan {
  return (markdown) =>
    planTelegramButtonReply(markdown, { registerAction: store.register });
}

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
// ======================================================
// === Outbound Reply Artifacts
// ======================================================

/**
 * Creates a sender that can deliver planned replies which may contain
 * voice, text, and attachments (artifacts). Used after agent responses.
 *
 * This is the main integration point where button replies and voice replies
 * are combined and sent out.
 */

export function createTelegramOutboundReplyArtifactSender(
  deps: TelegramVoiceReplySenderDeps,
) {
  const sendVoiceReply = createTelegramVoiceReplySender(deps);
  return async function sendOutboundReplyArtifacts(
    turn: TelegramVoiceReplyTurnView,
    plan: Pick<
      TelegramOutboundReplyPlan,
      "voiceText" | "voiceReplies" | "lang" | "rate" | "replyMarkup"
    >,
    options?: { replyToPrompt?: boolean },
  ): Promise<void> {
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
      throw new Error("Failed to send voice reply: every voice provider failed.");
    }
  };
}

export function createTelegramButtonPromptTurn(options: {
  chatId: number;
  replyToMessageId: number;
  queueOrder: number;
  action: TelegramOutboundButtonAction;
}): PendingTelegramTurn {
  const prompt = `[telegram] ${options.action.prompt}`;
  return {
    kind: "prompt",
    chatId: options.chatId,
    replyToMessageId: options.replyToMessageId,
    sourceMessageIds: [options.replyToMessageId],
    queueOrder: options.queueOrder,
    queueLane: "default",
    laneOrder: options.queueOrder,
    queuedAttachments: [],
    content: [{ type: "text", text: prompt }],
    historyText: options.action.prompt,
    statusSummary: truncateTelegramQueueSummary(
      options.action.text || options.action.prompt,
    ),
  };
}

/**
 * Handles a button callback query.
 * Resolves the stored action, answers the callback, and enqueues the associated prompt if present.
 * Returns true if the query was handled by this system (even if the action had expired).
 */
export async function handleTelegramButtonCallbackQuery<TContext = unknown>(
  query: TelegramButtonCallbackQuery,
  ctx: TContext,
  deps: TelegramButtonCallbackHandlerDeps<TContext>,
): Promise<boolean> {
  const action = deps.resolveAction(query.data);

  // Unknown / expired button (we only own tgbtn: keys)
  if (!action) {
    if (query.data?.startsWith(`${TELEGRAM_BUTTON_CALLBACK_PREFIX}:`)) {
      await deps.answerCallbackQuery(query.id, "Button action expired.");
      return true;
    }
    return false;
  }

  // Invalid message context (should not happen for private chat buttons)
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (typeof chatId !== "number" || typeof messageId !== "number") {
    await deps.answerCallbackQuery(query.id, "Button action expired.");
    return true;
  }

  deps.enqueueButtonPrompt(query, action, ctx);
  await deps.answerCallbackQuery(query.id, "Queued.");
  return true;
}
