/**
 * Telegram inbound attachment handler pipeline
 * Zones: telegram inbound, command templates, prompt preparation
 * Owns MIME/type matching, command-template execution, fallback handling, and prompt injection before prompt enqueueing
 */

import { basename } from "node:path";

import {
  buildCommandTemplateInvocation,
  expandCommandTemplateConfigs,
  normalizeCommandTemplateConfig,
  type CommandTemplateConfig,
  type CommandTemplateObjectConfig,
} from "./command-templates.ts";

const DEFAULT_ATTACHMENT_HANDLER_TIMEOUT_MS = 120_000;

type TelegramAttachmentCommandTemplateConfig =
  | string
  | CommandTemplateObjectConfig;

export interface TelegramAttachmentHandlerConfig {
  match?: string | string[];
  mime?: string | string[];
  type?: string | string[];
  template?: string | TelegramAttachmentCommandTemplateConfig[];
  pipe?: TelegramAttachmentCommandTemplateConfig[];
  args?: string[];
  defaults?: Record<string, unknown>;
  timeout?: number;
}

export interface TelegramAttachmentHandlerFile {
  path: string;
  fileName?: string;
  mimeType?: string;
  kind?: string;
  isImage?: boolean;
}

export interface TelegramAttachmentHandlerOutput {
  file: TelegramAttachmentHandlerFile;
  output: string;
  handler: TelegramAttachmentHandlerConfig;
}

export interface TelegramAttachmentHandlerProcessResult<
  TFile extends TelegramAttachmentHandlerFile = TelegramAttachmentHandlerFile,
> {
  rawText: string;
  promptFiles: TFile[];
  handlerOutputs: string[];
  handledFiles: TelegramAttachmentHandlerOutput[];
}

export interface TelegramAttachmentHandlerExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
}

export interface TelegramAttachmentHandlerExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface TelegramAttachmentHandlerRuntimeContext {
  cwd: string;
}

export interface TelegramAttachmentHandlerRuntimeDeps<TContext> {
  getHandlers: () => TelegramAttachmentHandlerConfig[] | undefined;
  execCommand: (
    command: string,
    args: string[],
    options?: TelegramAttachmentHandlerExecOptions,
  ) => Promise<TelegramAttachmentHandlerExecResult>;
  getCwd: (ctx: TContext) => string;
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramAttachmentHandlerRuntime<TContext> {
  process: <TFile extends TelegramAttachmentHandlerFile>(
    files: TFile[],
    rawText: string,
    ctx: TContext,
  ) => Promise<TelegramAttachmentHandlerProcessResult<TFile>>;
}

interface AttachmentHandlerInvocation {
  command: string;
  args: string[];
}

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
  handler: TelegramAttachmentHandlerConfig,
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

export function telegramAttachmentHandlerMatchesFile(
  handler: TelegramAttachmentHandlerConfig,
  file: TelegramAttachmentHandlerFile,
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

export function findTelegramAttachmentHandlers(
  handlers: TelegramAttachmentHandlerConfig[] | undefined,
  file: TelegramAttachmentHandlerFile,
): TelegramAttachmentHandlerConfig[] {
  if (!Array.isArray(handlers)) return [];
  return handlers.filter(
    (handler) =>
      !!handler &&
      typeof handler === "object" &&
      telegramAttachmentHandlerMatchesFile(handler, file),
  );
}

export function findTelegramAttachmentHandler(
  handlers: TelegramAttachmentHandlerConfig[] | undefined,
  file: TelegramAttachmentHandlerFile,
): TelegramAttachmentHandlerConfig | undefined {
  return findTelegramAttachmentHandlers(handlers, file)[0];
}

function hasAttachmentFilePlaceholder(value: string): boolean {
  return /\{file\}/.test(value);
}

function getTelegramAttachmentHandlerTemplateValues(
  file: TelegramAttachmentHandlerFile,
): Record<string, string> {
  return {
    file: file.path,
    mime: file.mimeType ?? "",
    type: file.kind ?? "",
  };
}

function buildTelegramAttachmentTemplateInvocation(
  handler: CommandTemplateConfig,
  file: TelegramAttachmentHandlerFile,
  cwd: string,
  appendFileIfMissing = true,
): AttachmentHandlerInvocation {
  const values = getTelegramAttachmentHandlerTemplateValues(file);
  const templateConfig = normalizeCommandTemplateConfig(handler);
  const hadFilePlaceholder =
    typeof templateConfig.template === "string"
      ? hasAttachmentFilePlaceholder(templateConfig.template)
      : false;
  const invocation = buildCommandTemplateInvocation(handler, values, cwd, {
    emptyMessage: "Attachment handler template is empty",
    missingLabel: "attachment handler template",
  });
  if (appendFileIfMissing && !hadFilePlaceholder)
    invocation.args.push(file.path);
  return invocation;
}

export function buildTelegramAttachmentHandlerInvocation(
  handler: CommandTemplateConfig,
  file: TelegramAttachmentHandlerFile,
  cwd: string,
  appendFileIfMissing = true,
): AttachmentHandlerInvocation {
  const { template } = normalizeCommandTemplateConfig(handler);
  if (!template) throw new Error("Attachment handler template is required");
  return buildTelegramAttachmentTemplateInvocation(
    handler,
    file,
    cwd,
    appendFileIfMissing,
  );
}

function getTelegramAttachmentHandlerConfiguredTimeout(
  handler: TelegramAttachmentCommandTemplateConfig,
): number | undefined {
  const timeout = typeof handler === "string" ? undefined : handler.timeout;
  return typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
    ? timeout
    : undefined;
}

function getTelegramAttachmentHandlerTimeout(
  handler: TelegramAttachmentCommandTemplateConfig,
): number {
  return (
    getTelegramAttachmentHandlerConfiguredTimeout(handler) ??
    DEFAULT_ATTACHMENT_HANDLER_TIMEOUT_MS
  );
}

function getRemainingTelegramAttachmentTimeout(
  timeout: number,
  startedAt: number,
): number {
  return Math.max(1, timeout - (Date.now() - startedAt));
}

function getTelegramAttachmentCompositionStepTimeout(
  handler: TelegramAttachmentHandlerConfig,
  step: TelegramAttachmentCommandTemplateConfig,
  startedAt: number,
): number {
  const remaining = getRemainingTelegramAttachmentTimeout(
    getTelegramAttachmentHandlerTimeout(handler),
    startedAt,
  );
  const stepTimeout = getTelegramAttachmentHandlerConfiguredTimeout(step);
  return stepTimeout === undefined ? remaining : Math.min(stepTimeout, remaining);
}

function getTelegramAttachmentHandlerKind(
  handler: TelegramAttachmentHandlerConfig,
): string {
  if (Array.isArray(handler.template) || handler.pipe?.length)
    return "composition";
  if (handler.template) return "template";
  return "unknown";
}

function formatTelegramAttachmentHandlerFailure(
  result: TelegramAttachmentHandlerExecResult,
): string {
  const parts = [
    `Attachment handler exited with code ${result.code}${result.killed ? " (killed)" : ""}`,
  ];
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`);
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trimEnd()}`);
  return parts.join("\n\n");
}

async function executeTelegramAttachmentHandlerInvocation(
  handler: TelegramAttachmentCommandTemplateConfig,
  file: TelegramAttachmentHandlerFile,
  cwd: string,
  deps: Pick<TelegramAttachmentHandlerRuntimeDeps<unknown>, "execCommand">,
  appendFileIfMissing = true,
  timeout = getTelegramAttachmentHandlerTimeout(handler),
  stdin?: string,
): Promise<string> {
  const invocation = buildTelegramAttachmentHandlerInvocation(
    handler,
    file,
    cwd,
    appendFileIfMissing,
  );
  const result = await deps.execCommand(invocation.command, invocation.args, {
    cwd,
    timeout,
    ...(typeof handler === "object" && handler.retry !== undefined ? { retry: handler.retry } : {}),
    ...(stdin !== undefined ? { stdin } : {}),
  });
  if (result.code !== 0)
    throw new Error(formatTelegramAttachmentHandlerFailure(result));
  return result.stdout;
}

function getTelegramAttachmentHandlerCompositionSteps(
  handler: TelegramAttachmentHandlerConfig,
): TelegramAttachmentCommandTemplateConfig[] {
  if (Array.isArray(handler.template)) {
    return expandCommandTemplateConfigs(
      handler,
    ) as TelegramAttachmentCommandTemplateConfig[];
  }
  if (handler.pipe?.length) {
    return expandCommandTemplateConfigs({
      ...handler,
      template: handler.pipe,
    }) as TelegramAttachmentCommandTemplateConfig[];
  }
  return [];
}

async function executeTelegramAttachmentHandler(
  handler: TelegramAttachmentHandlerConfig,
  file: TelegramAttachmentHandlerFile,
  cwd: string,
  deps: Pick<TelegramAttachmentHandlerRuntimeDeps<unknown>, "execCommand">,
): Promise<string> {
  const steps = getTelegramAttachmentHandlerCompositionSteps(handler);
  if (steps.length === 0) {
    const output = await executeTelegramAttachmentHandlerInvocation(
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
      output = await executeTelegramAttachmentHandlerInvocation(
        step,
        file,
        cwd,
        deps,
        false,
        getTelegramAttachmentCompositionStepTimeout(handler, step, startedAt),
        index === 0 ? undefined : output,
      );
    } catch (error) {
      if (typeof step === "object" && step.critical) throw error;
      output = "";
    }
  }
  return output.trim();
}

export async function processTelegramAttachmentHandlers<
  TFile extends TelegramAttachmentHandlerFile,
>(options: {
  files: TFile[];
  rawText: string;
  handlers?: TelegramAttachmentHandlerConfig[];
  cwd: string;
  execCommand: TelegramAttachmentHandlerRuntimeDeps<unknown>["execCommand"];
  recordRuntimeEvent?: TelegramAttachmentHandlerRuntimeDeps<unknown>["recordRuntimeEvent"];
}): Promise<TelegramAttachmentHandlerProcessResult<TFile>> {
  const promptFiles: TFile[] = [...options.files];
  const outputs: TelegramAttachmentHandlerOutput[] = [];
  for (const file of options.files) {
    const handlers = findTelegramAttachmentHandlers(options.handlers, file);
    for (const handler of handlers) {
      try {
        const output = await executeTelegramAttachmentHandler(
          handler,
          file,
          options.cwd,
          options,
        );
        if (output) outputs.push({ file, output, handler });
        break;
      } catch (error) {
        options.recordRuntimeEvent?.("attachment-handler", error, {
          fileName: file.fileName || basename(file.path),
          handler: getTelegramAttachmentHandlerKind(handler),
        });
      }
    }
  }
  return {
    rawText: options.rawText,
    promptFiles,
    handlerOutputs: outputs.map((output) => output.output),
    handledFiles: outputs,
  };
}

export function createTelegramAttachmentHandlerRuntime<TContext>(
  deps: TelegramAttachmentHandlerRuntimeDeps<TContext>,
): TelegramAttachmentHandlerRuntime<TContext> {
  return {
    process: (files, rawText, ctx) =>
      processTelegramAttachmentHandlers({
        files,
        rawText,
        handlers: deps.getHandlers(),
        cwd: deps.getCwd(ctx),
        execCommand: deps.execCommand,
        recordRuntimeEvent: deps.recordRuntimeEvent,
      }),
  };
}
