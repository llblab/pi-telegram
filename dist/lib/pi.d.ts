/**
 * pi SDK adapter boundary
 * Zones: pi agent sdk boundary, shared adapters
 * Owns direct pi SDK imports and exposes narrow bridge-facing helpers/types for the extension composition layer
 */
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { type AgentEndEvent, type AgentSettledEvent, type AgentStartEvent, type BeforeAgentStartEvent, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type InputEvent, type MessageEndEvent, type SessionBeforeCompactEvent, type SessionCompactEvent, type SessionShutdownEvent, type SessionStartEvent, type SlashCommandInfo, type UIPromptEndEvent, type UIPromptStartEvent } from "@earendil-works/pi-coding-agent";
export type { AgentEndEvent, AgentSettledEvent, AgentStartEvent, AssistantMessageEvent, BeforeAgentStartEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext, InputEvent, MessageEndEvent, SessionBeforeCompactEvent, SessionCompactEvent, SessionShutdownEvent, SessionStartEvent, SlashCommandInfo, UIPromptEndEvent, UIPromptStartEvent, };
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
export declare function getExtensionContextMode(ctx: unknown): PiRunMode | undefined;
export declare function isExtensionContextPassiveRunMode(ctx: unknown): boolean;
export declare function canStartPollingInExtensionContext(ctx: unknown): boolean;
export declare function formatPollingStartBlockedByRunMode(ctx: unknown): string;
export declare function getSessionCompactionReason(event: unknown): "manual" | "threshold" | "overflow" | "unknown";
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
}
export declare function createExtensionApiRuntimePorts(api: Pick<ExtensionAPI, "sendUserMessage" | "exec" | "getCommands" | "getThinkingLevel" | "setThinkingLevel" | "getActiveTools" | "setActiveTools" | "setModel" | "registerCommand">): PiExtensionApiRuntimePorts;
export declare function normalizeSettingsManager(manager: unknown): PiSettingsManager;
export declare function createSettingsManager(cwd: string): Promise<PiSettingsManager>;
export declare function createScopedModelPatternPersister(deps: {
    createSettingsManager: (cwd: string) => PiSettingsManager | PromiseLike<PiSettingsManager>;
    clearCachedModelMenuInputs: () => void;
}): (patterns: string[], ctx: ExtensionContext) => Promise<void>;
export declare function getExtensionContextModel(ctx: ExtensionContext): ExtensionContext["model"];
export declare function getExtensionContextCwd(ctx: ExtensionContext): string;
export declare function getExtensionContextSessionId(ctx: ExtensionContext): string;
export declare function isExtensionContextIdle(ctx: ExtensionContext): boolean;
export declare function hasExtensionContextPendingMessages(ctx: ExtensionContext): boolean;
export declare function compactExtensionContext(ctx: ExtensionContext, callbacks: Parameters<ExtensionContext["compact"]>[0]): ReturnType<ExtensionContext["compact"]>;
