/**
 * pi SDK adapter boundary
 * Zones: pi agent sdk boundary, shared adapters
 * Owns direct pi SDK imports and exposes narrow bridge-facing helpers/types for the extension composition layer
 */

import { types } from "node:util";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type {
  AgentEndEvent,
  AgentSettledEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  MessageEndEvent,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SlashCommandInfo,
  TurnEndEvent,
  TurnEndEventResult,
  UIPromptEndEvent,
  UIPromptStartEvent,
} from "@earendil-works/pi-coding-agent";

export type {
  AgentEndEvent,
  AgentSettledEvent,
  AgentStartEvent,
  AssistantMessageEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  MessageEndEvent,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  SlashCommandInfo,
  TurnEndEvent,
  TurnEndEventResult,
  UIPromptEndEvent,
  UIPromptStartEvent,
};

export interface SessionCompactFailedEvent {
  type: "session_compact_failed";
  reason: "manual" | "threshold" | "overflow";
  errorMessage?: string;
  aborted: boolean;
  willRetry: boolean;
  fromExtension: boolean;
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: unknown;
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

export interface PiSettingsManager {
  reload: () => Promise<void>;
  flush: () => Promise<void>;
  getEnabledModels: () => string[] | undefined;
  setEnabledModels: (patterns: string[] | undefined) => void;
}

export type PiSlashCommandInfo = SlashCommandInfo;
export type PiRunMode = "tui" | "rpc" | "json" | "print";

function isPiRunMode(value: unknown): value is PiRunMode {
  return (
    value === "tui" || value === "rpc" || value === "json" || value === "print"
  );
}

/** Pi rejects a context captured before session replacement with a stale-context error; this is not a domain failure. */
export function isPiStaleContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("stale after session") ||
      error.message.includes("stale ctx"))
  );
}

export function getExtensionContextMode(ctx: unknown): PiRunMode | undefined {
  const mode =
    typeof ctx === "object" && ctx !== null
      ? (ctx as { mode?: unknown }).mode
      : undefined;
  return isPiRunMode(mode) ? mode : undefined;
}

export function isExtensionContextPassiveRunMode(ctx: unknown): boolean {
  const mode = getExtensionContextMode(ctx);
  return mode === "print" || mode === "json";
}

export function canStartPollingInExtensionContext(ctx: unknown): boolean {
  return !isExtensionContextPassiveRunMode(ctx);
}

export function formatPollingStartBlockedByRunMode(ctx: unknown): string {
  const mode = getExtensionContextMode(ctx);
  return mode
    ? `Telegram polling is unavailable in Pi ${mode} mode. Use /telegram-connect from a long-lived Pi session.`
    : "Telegram polling is unavailable in this Pi run mode.";
}

export function getSessionCompactionReason(
  event: unknown,
): "manual" | "threshold" | "overflow" | "unknown" {
  const reason =
    event && typeof event === "object" && "reason" in event
      ? (event as { reason?: unknown }).reason
      : undefined;
  return reason === "manual" || reason === "threshold" || reason === "overflow"
    ? reason
    : "unknown";
}

const COMMAND_PROVIDER_KEY = Symbol("original Pi command callable");
const commandProviderIsProxy = types.isProxy;
const commandProviderOwn = Object.getOwnPropertyDescriptor;
const commandProviderApply = Reflect.apply;
const commandProviderArray = Array.isArray;
function commandProviderData(value: object, key: string) {
  const descriptor = commandProviderOwn(value, key);
  // A native accessor descriptor has no own value; do not consult its prototype.
  return descriptor && commandProviderOwn(descriptor, "value")?.value;
}
const commandProviderUnavailable = () => new Error("Pi command provider callable is unavailable.");

/** Original API callable only, not API activity, catalog/resource lifetime or source authority. */
export interface PiCommandProviderCapture {
  assertCallable(): void;
  getCommands: ExtensionAPI["getCommands"];
}

class NativePiCommandProvider implements PiCommandProviderCapture {
  #owner: { api: Pick<ExtensionAPI, "getCommands">; get: ExtensionAPI["getCommands"]; ports: PiExtensionApiRuntimePorts;
    portGet: ExtensionAPI["getCommands"]; capture: NonNullable<PiExtensionApiRuntimePorts["captureCommandProvider"]>; lost: boolean; busy: boolean };
  readonly assertCallable = () => {
    if (this.#owner.busy) { this.#owner.lost = true; throw commandProviderUnavailable(); }
    this.#assertFields();
  };
  readonly getCommands = (): ReturnType<ExtensionAPI["getCommands"]> => {
    this.assertCallable(); const owner = this.#owner; owner.busy = true;
    try {
      const value = commandProviderApply(owner.get, owner.api, []);
      this.#assertFields();
      if (!commandProviderArray(value)) throw commandProviderUnavailable();
      return value;
    } catch (error) { owner.lost = true; throw error; }
    finally { owner.busy = false; }
  };
  constructor(key: symbol, api: Pick<ExtensionAPI, "getCommands">, get: ExtensionAPI["getCommands"], ports: PiExtensionApiRuntimePorts,
    portGet: ExtensionAPI["getCommands"], capture: NonNullable<PiExtensionApiRuntimePorts["captureCommandProvider"]>) {
    if (key !== COMMAND_PROVIDER_KEY) throw commandProviderUnavailable();
    this.#owner = { api, get, ports, portGet, capture, lost: false, busy: false };
    Object.freeze(this);
  }
  #assertFields(): void {
    const owner = this.#owner;
    if (owner.lost || commandProviderData(owner.api, "getCommands") !== owner.get ||
      commandProviderData(owner.ports, "getCommands") !== owner.portGet ||
      commandProviderData(owner.ports, "captureCommandProvider") !== owner.capture) {
      owner.lost = true; throw commandProviderUnavailable();
    }
  }
  static read(value: unknown, ports: PiExtensionApiRuntimePorts): Readonly<PiCommandProviderCapture> | undefined {
    if (!value || typeof value !== "object" || !(#owner in value) || value.#owner.ports !== ports) return undefined;
    value.assertCallable(); return value;
  }
}
const readNativePiCommandProvider = NativePiCommandProvider.read;

/** Intrinsic non-match probes no supplied DTO/receiver fields and does not revoke the genuine owner. */
export function readPiCommandProviderCapture(value: unknown, ports: PiExtensionApiRuntimePorts): Readonly<PiCommandProviderCapture> | undefined {
  return readNativePiCommandProvider(value, ports);
}

export interface PiExtensionApiRuntimePorts {
  sendUserMessage: ExtensionAPI["sendUserMessage"];
  exec: ExtensionAPI["exec"];
  getCommands: ExtensionAPI["getCommands"];
  getThinkingLevel: ExtensionAPI["getThinkingLevel"];
  setThinkingLevel: ExtensionAPI["setThinkingLevel"];
  getActiveTools: ExtensionAPI["getActiveTools"];
  setActiveTools: ExtensionAPI["setActiveTools"];
  setModel: ExtensionAPI["setModel"];
  registerCommand: ExtensionAPI["registerCommand"];
  captureCommandProvider?(): Readonly<PiCommandProviderCapture>;
}

export function createExtensionApiRuntimePorts(
  api: Pick<
    ExtensionAPI,
    | "sendUserMessage"
    | "exec"
    | "getCommands"
    | "getThinkingLevel"
    | "setThinkingLevel"
    | "getActiveTools"
    | "setActiveTools"
    | "setModel"
    | "registerCommand"
  >,
  commandProvider?: true,
): PiExtensionApiRuntimePorts {
  const refusal = () => new TypeError("Original Pi command provider requires true and an own-data callable.");
  if (commandProvider !== undefined && commandProvider !== true) throw refusal();
  let original: ExtensionAPI["getCommands"] | undefined;
  if (commandProvider) {
    if (!api || typeof api !== "object" || commandProviderIsProxy(api)) throw refusal();
    original = commandProviderData(api, "getCommands");
    if (typeof original !== "function" || commandProviderIsProxy(original)) throw refusal();
  }
  const ports: PiExtensionApiRuntimePorts = {
    sendUserMessage: (content, options) =>
      api.sendUserMessage(content, options),
    exec: (command, args, options) => api.exec(command, args, options),
    getCommands: () => api.getCommands(),
    getThinkingLevel: () => api.getThinkingLevel(),
    setThinkingLevel: (level) => api.setThinkingLevel(level),
    getActiveTools: () => api.getActiveTools(),
    setActiveTools: (names) => api.setActiveTools(names),
    setModel: (model) => api.setModel(model),
    registerCommand: (name, options) => api.registerCommand(name, options),
  };
  if (original) {
    const capture: NonNullable<PiExtensionApiRuntimePorts["captureCommandProvider"]> = () => readNativePiCommandProvider(provider, ports)!;
    const provider = new NativePiCommandProvider(COMMAND_PROVIDER_KEY, api, original, ports, ports.getCommands, capture);
    ports.captureCommandProvider = capture;
  }
  return ports;
}

type PiSettingsManagerFactory = {
  create: (cwd: string) => unknown | PromiseLike<unknown>;
};

type HostSettingsManager = {
  reload?: () => void | PromiseLike<void>;
  flush?: () => void | PromiseLike<void>;
  getEnabledModels?: () => unknown;
  setEnabledModels?: (patterns: string[] | undefined) => void;
  get?: (key: string) => unknown;
  set?: (key: string, value: unknown) => void;
};

function readEnabledModels(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
  ) {
    return [...value];
  }
  throw new TypeError(
    "Host settings enabledModels must be a string array or undefined.",
  );
}

export function normalizeSettingsManager(manager: unknown): PiSettingsManager {
  if (typeof manager !== "object" || manager === null) {
    throw new TypeError("Host settings manager must be an object.");
  }
  const host = manager as HostSettingsManager;
  if (typeof host.flush !== "function") {
    throw new TypeError("Host settings manager must provide flush().");
  }
  const read =
    typeof host.getEnabledModels === "function"
      ? () => host.getEnabledModels!.call(host)
      : typeof host.get === "function"
        ? () => host.get!.call(host, "enabledModels")
        : undefined;
  const write =
    typeof host.setEnabledModels === "function"
      ? (patterns: string[] | undefined) =>
          host.setEnabledModels!.call(host, patterns)
      : typeof host.set === "function"
        ? (patterns: string[] | undefined) =>
            host.set!.call(host, "enabledModels", patterns ?? [])
        : undefined;
  if (!read || !write) {
    throw new TypeError(
      "Host settings manager must provide enabled-model read and write capabilities.",
    );
  }
  return {
    reload: async () => {
      await host.reload?.call(host);
    },
    flush: async () => {
      await host.flush!.call(host);
    },
    getEnabledModels: () => readEnabledModels(read()),
    setEnabledModels: write,
  };
}

export async function createSettingsManager(
  cwd: string,
): Promise<PiSettingsManager> {
  // Pi returns its legacy settings surface synchronously. Compatible hosts may
  // resolve a generic settings service asynchronously; normalize both once at
  // the SDK boundary instead of leaking host distinctions into menu domains.
  // Queue and transport helpers must not load the whole host SDK during cold Root imports.
  const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const factory = SettingsManager as unknown as PiSettingsManagerFactory;
  return normalizeSettingsManager(await factory.create(cwd));
}

export function createScopedModelPatternPersister(deps: {
  createSettingsManager: (
    cwd: string,
  ) => PiSettingsManager | PromiseLike<PiSettingsManager>;
  clearCachedModelMenuInputs: () => void;
}): (patterns: string[], ctx: ExtensionContext) => Promise<void> {
  return async (patterns, ctx) => {
    const settingsManager = await deps.createSettingsManager(ctx.cwd);
    settingsManager.setEnabledModels(
      patterns.length > 0 ? patterns : undefined,
    );
    await settingsManager.flush();
    deps.clearCachedModelMenuInputs();
  };
}

export function getExtensionContextModel(
  ctx: ExtensionContext,
): ExtensionContext["model"] {
  return ctx.model;
}

export function getExtensionContextCwd(ctx: ExtensionContext): string {
  return ctx.cwd;
}

export function getExtensionContextSessionId(ctx: ExtensionContext): string;
export function getExtensionContextSessionId(
  ctx: ExtensionContext | undefined,
): string | undefined;
export function getExtensionContextSessionId(
  ctx: ExtensionContext | undefined,
): string | undefined {
  // Minimal hosts and stale contexts may omit a session manager; absence is not an invented ID.
  return ctx?.sessionManager?.getSessionId?.();
}

export function isExtensionContextIdle(ctx: ExtensionContext): boolean {
  return ctx.isIdle();
}

export function isExtensionContextAbortRequested(ctx: ExtensionContext): boolean {
  return ctx.signal?.aborted === true;
}

export function hasExtensionContextPendingMessages(
  ctx: ExtensionContext,
): boolean {
  return ctx.hasPendingMessages();
}

export function compactExtensionContext(
  ctx: ExtensionContext,
  callbacks: Parameters<ExtensionContext["compact"]>[0],
): ReturnType<ExtensionContext["compact"]> {
  return ctx.compact(callbacks);
}
