/**
 * Telegram inbound handler pipeline
 * Zones: telegram inbound, command templates, prompt preparation
 * Owns MIME/type matching, command-template execution, fallback handling, and prompt injection before prompt enqueueing
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  buildCommandTemplateInvocation,
  expandCommandTemplateConfigs,
  normalizeCommandTemplateConfig,
  type CommandTemplateConfig,
  type CommandTemplateObjectConfig,
} from "./command-templates.ts";

const DEFAULT_INBOUND_HANDLER_TIMEOUT_MS = 120_000;

type TelegramInboundCommandTemplateConfig =
  | string
  | CommandTemplateObjectConfig;

export interface TelegramInboundHandlerConfig {
  match?: string | string[];
  mime?: string | string[];
  type?: string | string[];
  template?: string | TelegramInboundCommandTemplateConfig[];
  pipe?: TelegramInboundCommandTemplateConfig[];
  args?: string[];
  defaults?: Record<string, unknown>;
  timeout?: number;
}

export interface TelegramInboundHandlerFile {
  path: string;
  fileName?: string;
  mimeType?: string;
  kind?: string;
  isImage?: boolean;
}

export interface TelegramInboundHandlerOutput {
  file: TelegramInboundHandlerFile;
  output: string;
  handler: TelegramInboundHandlerConfig;
}

export interface TelegramInboundHandlerProcessResult<
  TFile extends TelegramInboundHandlerFile = TelegramInboundHandlerFile,
> {
  rawText: string;
  promptFiles: TFile[];
  handlerOutputs: string[];
  handledFiles: TelegramInboundHandlerOutput[];
}

export interface TelegramInboundHandlerExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
}

export interface TelegramInboundHandlerExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface TelegramInboundHandlerRuntimeContext {
  cwd: string;
}

export interface TelegramInboundHandlerRuntimeDeps<TContext> {
  getHandlers: () => TelegramInboundHandlerConfig[] | undefined;
  execCommand: (
    command: string,
    args: string[],
    options?: TelegramInboundHandlerExecOptions,
  ) => Promise<TelegramInboundHandlerExecResult>;
  getCwd: (ctx: TContext) => string;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramInboundHandlerRuntime<TContext> {
  process: <TFile extends TelegramInboundHandlerFile>(
    files: TFile[],
    rawText: string,
    ctx: TContext,
  ) => Promise<TelegramInboundHandlerProcessResult<TFile>>;
}

interface InboundHandlerInvocation {
  command: string;
  args: string[];
}

const BUILT_IN_TEXT_ATTACHMENT_MAX_BYTES = 1_000_000;

function normalizeStringList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value
      .map(String)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function matchesWildcard(pattern: string, value: string | undefined): boolean {
  if (!value) return false;
  const normalizedPattern = pattern.toLowerCase();
  const normalizedValue = value.toLowerCase();
  if (normalizedPattern === "*") return true;
  const escaped = normalizedPattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(normalizedValue);
}

function handlerHasSelectors(
  handler: TelegramInboundHandlerConfig,
): boolean {
  return (
    normalizeStringList(handler.match).length > 0 ||
    normalizeStringList(handler.mime).length > 0 ||
    normalizeStringList(handler.type).length > 0
  );
}

function matchesAnyPattern(
  patterns: string[],
  value: string | undefined,
): boolean {
  return patterns.some((pattern) => matchesWildcard(pattern, value));
}

function isTelegramTextMimeType(mimeType: string | undefined): boolean {
  return matchesWildcard("text/*", mimeType);
}

export function telegramInboundHandlerMatchesFile(
  handler: TelegramInboundHandlerConfig,
  file: TelegramInboundHandlerFile,
): boolean {
  if (!handlerHasSelectors(handler)) return true;
  const matchPatterns = normalizeStringList(handler.match);
  const mimePatterns = normalizeStringList(handler.mime);
  const typePatterns = normalizeStringList(handler.type);
  if (matchesAnyPattern(mimePatterns, file.mimeType)) return true;
  if (matchesAnyPattern(typePatterns, file.kind)) return true;
  if (matchesAnyPattern(matchPatterns, file.mimeType)) return true;
  return matchesAnyPattern(matchPatterns, file.kind);
}

export function findTelegramInboundHandlers(
  handlers: TelegramInboundHandlerConfig[] | undefined,
  file: TelegramInboundHandlerFile,
): TelegramInboundHandlerConfig[] {
  if (!Array.isArray(handlers)) return [];
  return handlers.filter(
    (handler) =>
      !!handler &&
      typeof handler === "object" &&
      telegramInboundHandlerMatchesFile(handler, file),
  );
}

export function findTelegramInboundHandler(
  handlers: TelegramInboundHandlerConfig[] | undefined,
  file: TelegramInboundHandlerFile,
): TelegramInboundHandlerConfig | undefined {
  return findTelegramInboundHandlers(handlers, file)[0];
}

function hasInboundFilePlaceholder(value: string): boolean {
  return /\{file\}/.test(value);
}

function getTelegramInboundHandlerTemplateValues(
  file: TelegramInboundHandlerFile,
  text = "",
): Record<string, string> {
  return {
    file: file.path,
    mime: file.mimeType ?? "",
    text,
    type: file.kind ?? "",
  };
}

function buildTelegramInboundTemplateInvocation(
  handler: CommandTemplateConfig,
  file: TelegramInboundHandlerFile,
  cwd: string,
  appendFileIfMissing = true,
): InboundHandlerInvocation {
  const values = getTelegramInboundHandlerTemplateValues(file);
  const templateConfig = normalizeCommandTemplateConfig(handler);
  const hadFilePlaceholder =
    typeof templateConfig.template === "string"
      ? hasInboundFilePlaceholder(templateConfig.template)
      : false;
  const invocation = buildCommandTemplateInvocation(handler, values, cwd, {
    emptyMessage: "Inbound handler template is empty",
    missingLabel: "inbound handler template",
  });
  if (appendFileIfMissing && !hadFilePlaceholder)
    invocation.args.push(file.path);
  return invocation;
}

export function buildTelegramInboundHandlerInvocation(
  handler: CommandTemplateConfig,
  file: TelegramInboundHandlerFile,
  cwd: string,
  appendFileIfMissing = true,
): InboundHandlerInvocation {
  const { template } = normalizeCommandTemplateConfig(handler);
  if (!template) throw new Error("Inbound handler template is required");
  return buildTelegramInboundTemplateInvocation(
    handler,
    file,
    cwd,
    appendFileIfMissing,
  );
}

function getTelegramInboundHandlerConfiguredTimeout(
  handler: TelegramInboundCommandTemplateConfig,
): number | undefined {
  const timeout = typeof handler === "string" ? undefined : handler.timeout;
  return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
    ? timeout
    : undefined;
}

function getTelegramInboundHandlerTimeout(
  handler: TelegramInboundCommandTemplateConfig,
): number {
  return (
    getTelegramInboundHandlerConfiguredTimeout(handler) ??
    DEFAULT_INBOUND_HANDLER_TIMEOUT_MS
  );
}

function getRemainingTelegramInboundTimeout(
  timeout: number,
  startedAt: number,
): number {
  return Math.max(1, timeout - (Date.now() - startedAt));
}

function getTelegramInboundInitialCompositionStepTimeout(
  handler: TelegramInboundHandlerConfig,
  step: TelegramInboundCommandTemplateConfig,
): number {
  const timeout = getTelegramInboundHandlerTimeout(handler);
  const stepTimeout = getTelegramInboundHandlerConfiguredTimeout(step);
  return stepTimeout === undefined ? timeout : Math.min(stepTimeout, timeout);
}

function getTelegramInboundCompositionStepTimeout(
  handler: TelegramInboundHandlerConfig,
  step: TelegramInboundCommandTemplateConfig,
  startedAt: number,
): number {
  const remaining = getRemainingTelegramInboundTimeout(
    getTelegramInboundHandlerTimeout(handler),
    startedAt,
  );
  const stepTimeout = getTelegramInboundHandlerConfiguredTimeout(step);
  return stepTimeout === undefined
    ? remaining
    : Math.min(stepTimeout, remaining);
}

function getTelegramInboundHandlerKind(
  handler: TelegramInboundHandlerConfig,
): string {
  if (Array.isArray(handler.template) || handler.pipe?.length)
    return "composition";
  if (handler.template) return "template";
  return "unknown";
}

function formatTelegramInboundHandlerFailure(
  result: TelegramInboundHandlerExecResult,
): string {
  const parts = [
    `Inbound handler exited with code ${result.code}${result.killed ? " (killed)" : ""}`,
  ];
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`);
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trimEnd()}`);
  return parts.join("\n\n");
}

async function executeTelegramInboundHandlerInvocation(
  handler: TelegramInboundCommandTemplateConfig,
  file: TelegramInboundHandlerFile,
  cwd: string,
  deps: Pick<TelegramInboundHandlerRuntimeDeps<unknown>, "execCommand">,
  appendFileIfMissing = true,
  timeout = getTelegramInboundHandlerTimeout(handler),
  stdin?: string,
): Promise<string> {
  const invocation = buildTelegramInboundHandlerInvocation(
    handler,
    file,
    cwd,
    appendFileIfMissing,
  );
  const result = await deps.execCommand(invocation.command, invocation.args, {
    cwd,
    timeout,
    ...(typeof handler === "object" && handler.retry !== undefined
      ? { retry: handler.retry }
      : {}),
    ...(stdin !== undefined ? { stdin } : {}),
  });
  if (result.code !== 0)
    throw new Error(formatTelegramInboundHandlerFailure(result));
  return result.stdout;
}

function getTelegramInboundHandlerCompositionSteps(
  handler: TelegramInboundHandlerConfig,
): TelegramInboundCommandTemplateConfig[] {
  if (Array.isArray(handler.template)) {
    return expandCommandTemplateConfigs(
      handler,
    ) as TelegramInboundCommandTemplateConfig[];
  }
  if (handler.pipe?.length) {
    return expandCommandTemplateConfigs({
      ...handler,
      template: handler.pipe,
    }) as TelegramInboundCommandTemplateConfig[];
  }
  return [];
}

function getTelegramTextHandlerFile(): TelegramInboundHandlerFile {
  return {
    path: "",
    fileName: "message.txt",
    mimeType: "text/plain",
    kind: "text",
    isImage: false,
  };
}

function findTelegramTextHandlers(
  handlers: TelegramInboundHandlerConfig[] | undefined,
): TelegramInboundHandlerConfig[] {
  if (!Array.isArray(handlers)) return [];
  const textFile = getTelegramTextHandlerFile();
  return handlers.filter(
    (handler) =>
      !!handler &&
      typeof handler === "object" &&
      handlerHasSelectors(handler) &&
      telegramInboundHandlerMatchesFile(handler, textFile),
  );
}

function buildTelegramTextHandlerInvocation(
  handler: CommandTemplateConfig,
  text: string,
  cwd: string,
): InboundHandlerInvocation {
  const values = getTelegramInboundHandlerTemplateValues(
    getTelegramTextHandlerFile(),
    text,
  );
  const { template } = normalizeCommandTemplateConfig(handler);
  if (!template) throw new Error("Text handler template is required");
  return buildCommandTemplateInvocation(handler, values, cwd, {
    emptyMessage: "Text handler template is empty",
    missingLabel: "text handler template",
  });
}

async function executeTelegramTextHandlerInvocation(
  handler: TelegramInboundCommandTemplateConfig,
  text: string,
  cwd: string,
  deps: Pick<TelegramInboundHandlerRuntimeDeps<unknown>, "execCommand">,
  timeout = getTelegramInboundHandlerTimeout(handler),
): Promise<string> {
  const invocation = buildTelegramTextHandlerInvocation(handler, text, cwd);
  const result = await deps.execCommand(invocation.command, invocation.args, {
    cwd,
    timeout,
    stdin: text,
    ...(typeof handler === "object" && handler.retry !== undefined
      ? { retry: handler.retry }
      : {}),
  });
  if (result.code !== 0)
    throw new Error(formatTelegramInboundHandlerFailure(result));
  return result.stdout;
}

async function executeTelegramTextHandler(
  handler: TelegramInboundHandlerConfig,
  text: string,
  cwd: string,
  deps: Pick<TelegramInboundHandlerRuntimeDeps<unknown>, "execCommand">,
): Promise<string> {
  const steps = getTelegramInboundHandlerCompositionSteps(handler);
  if (steps.length === 0) {
    return (
      await executeTelegramTextHandlerInvocation(handler, text, cwd, deps)
    ).trim();
  }
  const startedAt = Date.now();
  let output = text;
  for (const [index, step] of steps.entries()) {
    try {
      output = await executeTelegramTextHandlerInvocation(
        step,
        output,
        cwd,
        deps,
        index === 0
          ? getTelegramInboundInitialCompositionStepTimeout(handler, step)
          : getTelegramInboundCompositionStepTimeout(handler, step, startedAt),
      );
    } catch (error) {
      if (typeof step === "object" && step.critical) throw error;
      output = "";
    }
    if (index > 0 && !output) output = text;
  }
  return output.trim();
}

async function processTelegramTextHandlers(options: {
  rawText: string;
  handlers?: TelegramInboundHandlerConfig[];
  cwd: string;
  execCommand: TelegramInboundHandlerRuntimeDeps<unknown>["execCommand"];
  recordRuntimeEvent?: TelegramInboundHandlerRuntimeDeps<unknown>["recordRuntimeEvent"];
}): Promise<string> {
  if (!options.rawText) return options.rawText;
  let text = options.rawText;
  for (const handler of findTelegramTextHandlers(options.handlers)) {
    try {
      const output = await executeTelegramTextHandler(
        handler,
        text,
        options.cwd,
        options,
      );
      if (output) text = output;
    } catch (error) {
      options.recordRuntimeEvent?.("inbound-text-handler", error, {
        handler: getTelegramInboundHandlerKind(handler),
      });
    }
  }
  return text;
}

async function readBuiltInTelegramTextAttachment(
  file: TelegramInboundHandlerFile,
): Promise<string | undefined> {
  if (!isTelegramTextMimeType(file.mimeType)) return undefined;
  const content = await readFile(file.path, "utf8");
  const normalized = content.trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > BUILT_IN_TEXT_ATTACHMENT_MAX_BYTES) {
    return undefined;
  }
  const name = file.fileName || basename(file.path);
  return `[${name}]\n${normalized}`;
}

async function executeTelegramInboundHandler(
  handler: TelegramInboundHandlerConfig,
  file: TelegramInboundHandlerFile,
  cwd: string,
  deps: Pick<TelegramInboundHandlerRuntimeDeps<unknown>, "execCommand">,
): Promise<string> {
  const steps = getTelegramInboundHandlerCompositionSteps(handler);
  if (steps.length === 0) {
    const output = await executeTelegramInboundHandlerInvocation(
      handler,
      file,
      cwd,
      deps,
    );
    return output.trim();
  }
  const startedAt = Date.now();
  let output = "";
  for (const [index, step] of steps.entries()) {
    try {
      output = await executeTelegramInboundHandlerInvocation(
        step,
        file,
        cwd,
        deps,
        false,
        index === 0
          ? getTelegramInboundInitialCompositionStepTimeout(handler, step)
          : getTelegramInboundCompositionStepTimeout(handler, step, startedAt),
        index === 0 ? undefined : output,
      );
    } catch (error) {
      if (typeof step === "object" && step.critical) throw error;
      output = "";
    }
  }
  return output.trim();
}

export async function processTelegramInboundHandlers<
  TFile extends TelegramInboundHandlerFile,
>(options: {
  files: TFile[];
  rawText: string;
  handlers?: TelegramInboundHandlerConfig[];
  cwd: string;
  execCommand: TelegramInboundHandlerRuntimeDeps<unknown>["execCommand"];
  recordRuntimeEvent?: TelegramInboundHandlerRuntimeDeps<unknown>["recordRuntimeEvent"];
}): Promise<TelegramInboundHandlerProcessResult<TFile>> {
  const rawText = await processTelegramTextHandlers({
    rawText: options.rawText,
    handlers: options.handlers,
    cwd: options.cwd,
    execCommand: options.execCommand,
    recordRuntimeEvent: options.recordRuntimeEvent,
  });
  const promptFiles: TFile[] = [...options.files];
  const outputs: TelegramInboundHandlerOutput[] = [];
  for (const file of options.files) {
    let hasOutput = false;
    const handlers = findTelegramInboundHandlers(options.handlers, file);
    for (const handler of handlers) {
      try {
        const output = await executeTelegramInboundHandler(
          handler,
          file,
          options.cwd,
          options,
        );
        if (output) {
          outputs.push({ file, output, handler });
          hasOutput = true;
        }
        break;
      } catch (error) {
        options.recordRuntimeEvent?.("inbound-handler", error, {
          fileName: file.fileName || basename(file.path),
          handler: getTelegramInboundHandlerKind(handler),
        });
      }
    }
    if (!hasOutput) {
      try {
        const output = await readBuiltInTelegramTextAttachment(file);
        if (output) outputs.push({ file, output, handler: { type: "text" } });
      } catch (error) {
        options.recordRuntimeEvent?.("inbound-handler", error, {
          fileName: file.fileName || basename(file.path),
          handler: "built-in-text",
        });
      }
    }
  }
  return {
    rawText,
    promptFiles,
    handlerOutputs: outputs.map((output) => output.output),
    handledFiles: outputs,
  };
}

export function createTelegramInboundHandlerRuntime<TContext>(
  deps: TelegramInboundHandlerRuntimeDeps<TContext>,
): TelegramInboundHandlerRuntime<TContext> {
  return {
    process: (files, rawText, ctx) =>
      processTelegramInboundHandlers({
        files,
        rawText,
        handlers: deps.getHandlers(),
        cwd: deps.getCwd(ctx),
        execCommand: deps.execCommand,
        recordRuntimeEvent: deps.recordRuntimeEvent,
      }),
  };
}
