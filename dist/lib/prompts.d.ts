/**
 * Telegram prompt injection helpers
 * Zones: pi agent prompts, telegram guidance
 * Owns Telegram-specific system prompt suffixes injected into pi agent turns
 */
import type { BeforeAgentStartEvent } from "./pi.ts";
export declare const TELEGRAM_CONNECTED_CONTEXT_MESSAGE = "Telegram session connected. Use Telegram features for Telegram-originated turns or explicit Telegram requests; connectivity alone is not user intent.";
export declare const TELEGRAM_DISCONNECTED_CONTEXT_MESSAGE = "Telegram session disconnected. Do not use Telegram delivery, actions, or Telegram-specific reply features unless the user reconnects it.";
export declare const TELEGRAM_ATTACH_PROMPT_SNIPPET = "Queue files for the active Telegram reply; outside Telegram turns, send files directly to Telegram.";
export declare const TELEGRAM_ATTACH_PROMPT_GUIDELINES: readonly ["When handling a [telegram] message and the user asked for a file or generated artifact, call telegram_attach with the local path instead of only mentioning the path in text.", "When a local/TUI user explicitly asks to send a generated file to Telegram, telegram_attach can deliver it to the paired/default Telegram chat even without an active Telegram turn.", "For an explicit thread target, provide chat_id plus thread_id; registered multi-instance followers default to their assigned thread target."];
export declare const TELEGRAM_MESSAGE_PROMPT_SNIPPET = "Send direct Telegram Markdown text when the user explicitly asks for Telegram delivery to a concrete chat, channel, or live Pi Thread outside the normal reply flow.";
export declare const TELEGRAM_MESSAGE_PROMPT_GUIDELINES: readonly ["Use telegram_message only when the user explicitly asks to send a message to Telegram from the local/TUI side, or names a concrete Telegram delivery target.", "For an explicitly requested channel post, pass its exact numeric id or public @username as chat_id; no local channel registry is required, and Telegram remains the authority on the bot's posting permission.", "For an explicitly requested channel media post, pass one local .jpg/.jpeg/.png/.webp photo or .mp4 video as media; the text becomes its caption (max 1024 characters), and albums or other media types are rejected.", "For a live Pi thread target, provide thread as its case-insensitive name or numeric id; the bridge sends visibly and admits one attributed turn to that live instance. Unknown, ambiguous, same, or offline targets fail before sending.", "Add buttons by embedding the same top-level telegram_button HTML comments used in normal Telegram replies; Telegram does not support standalone buttons.", "During an active Telegram turn, omit telegram_message for the current target and answer normally; use thread only when the user requests delivery to a different live Pi thread."];
export interface TelegramModelContextAvailabilityMemory {
    suspended: boolean;
    toolNames: Set<string>;
}
export interface TelegramModelContextAvailabilityRuntime {
    reconcile: () => void;
}
export interface TelegramModelContextAvailabilityBinding extends TelegramModelContextAvailabilityRuntime {
    bind: (runtime: TelegramModelContextAvailabilityRuntime) => void;
}
export declare function createTelegramModelContextAvailabilityBinding(): TelegramModelContextAvailabilityBinding;
export declare function createTelegramModelContextAvailabilityRuntime(deps: {
    getActiveTools: () => string[];
    setActiveTools: (names: string[]) => void;
    isAvailable: () => boolean;
    canReconcile?: () => boolean;
    memory?: TelegramModelContextAvailabilityMemory;
}): TelegramModelContextAvailabilityRuntime;
export type TelegramSystemPrompt = string | string[];
type TelegramBeforeAgentStartEvent = Omit<BeforeAgentStartEvent, "systemPrompt"> & {
    systemPrompt?: TelegramSystemPrompt | null;
};
type TelegramBeforeAgentStartResult = {
    systemPrompt: TelegramSystemPrompt;
};
type TelegramBeforeAgentStartHook = (event: TelegramBeforeAgentStartEvent) => TelegramBeforeAgentStartResult;
export declare function buildTelegramBridgeSystemPrompt(options: {
    prompt: string;
    systemPrompt?: TelegramSystemPrompt | null;
    telegramPrefix?: string;
    localSystemPromptSuffix: string;
    telegramTurnSystemPromptSuffix: string;
}): TelegramBeforeAgentStartResult;
export declare function createTelegramBeforeAgentStartHook(options?: {
    telegramPrefix?: string;
    localSystemPromptSuffix?: string;
    telegramTurnSystemPromptSuffix?: string;
}): TelegramBeforeAgentStartHook;
export interface TelegramProactivePromptHookDeps<TContext> {
    baseHook?: TelegramBeforeAgentStartHook;
    reconcileAvailability?: () => void;
    isAvailable: (ctx: TContext) => boolean;
}
export declare function createTelegramProactiveBeforeAgentStartHook<TContext>(deps: TelegramProactivePromptHookDeps<TContext>): (event: TelegramBeforeAgentStartEvent, ctx: TContext) => Promise<TelegramBeforeAgentStartResult>;
export {};
