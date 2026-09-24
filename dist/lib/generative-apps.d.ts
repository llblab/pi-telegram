/**
 * Generative application kernel and Telegram installation adapter
 * Zones: generative application state, isolated methods, pi agent tools
 * Owns Generative App identity, installation, invocation, state history, and telegram_bind
 */
import type { ExtensionAPI } from "./pi.ts";
export declare const GENERATIVE_APP_MIN_REFRESH_AFTER_MS = 2000;
export declare const GENERATIVE_APP_MAX_REFRESH_AFTER_MS: number;
export type GenerativeAppJsonValue = null | boolean | number | string | GenerativeAppJsonValue[] | {
    [key: string]: GenerativeAppJsonValue;
};
export interface GenerativeAppProcessInput {
    command: string;
    args?: string[];
    cwd: string;
    timeoutMs?: number;
}
export interface GenerativeAppProcessResult {
    code: number;
    killed: boolean;
    stderr: string;
    stdout: string;
}
export interface GenerativeAppMethodContext {
    argument?: GenerativeAppJsonValue;
    revision: number;
    run: (input: GenerativeAppProcessInput) => Promise<GenerativeAppProcessResult>;
    signal: AbortSignal;
    state?: GenerativeAppJsonValue;
}
export interface GenerativeAppMethodResult {
    output: string;
    refreshAfterMs?: number;
    state?: GenerativeAppJsonValue;
    viewMode?: "new" | "edit";
}
export interface GenerativeAppBoundAction {
    argument?: GenerativeAppJsonValue;
    method: string;
    app: string;
}
export interface GenerativeAppInvocationResult {
    generation: string;
    method: string;
    output: string;
    app: string;
    revision: number;
    refreshAfterMs?: number;
    stateChanged: boolean;
    viewMode: "new" | "edit";
}
export interface GenerativeAppExecutionFence {
    assertCurrent: () => void;
    signal: AbortSignal;
}
export interface GenerativeAppRuntimeOptions {
    agentDir: string;
    execution?: GenerativeAppExecutionFence;
    methodTimeoutMs?: number;
}
export interface GenerativeAppLiveSurfaceFrame<THandle> {
    digest: string;
    handle: THandle;
}
export interface GenerativeAppLiveSurface<THandle> {
    app: string;
    appGeneration: string;
    appRevision: number;
    handle: THandle;
    initialDigest: string;
    key: string;
    refreshAfterMs: number;
}
export interface GenerativeAppLiveSurfaceRuntime<THandle> {
    open: (surface: GenerativeAppLiveSurface<THandle>) => void;
    cancel: (key: string) => void;
    take: (key: string) => GenerativeAppLiveSurface<THandle> | undefined;
    resume: (surface: GenerativeAppLiveSurface<THandle>, result: GenerativeAppInvocationResult) => Promise<void>;
    refreshNow: (key: string) => Promise<void>;
    shutdown: () => void;
}
export interface GenerativeAppLiveSurfaceRuntimeDeps<THandle> {
    agentDir: string;
    isCurrent: (surface: GenerativeAppLiveSurface<THandle>) => boolean;
    plan: (result: GenerativeAppInvocationResult, handle: THandle) => GenerativeAppLiveSurfaceFrame<THandle>;
    edit: (frame: GenerativeAppLiveSurfaceFrame<THandle>) => Promise<THandle>;
    classifyEditError?: (error: unknown) => {
        kind: "retry";
        retryAfterMs?: number;
    } | {
        kind: "terminal" | "unavailable" | "unknown";
    };
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}
export interface TelegramBindDeliveryHandle {
    readonly target: {
        chatId: number;
        threadId?: number;
    };
    readonly messageIds: readonly number[];
    readonly generation: string;
}
export interface TelegramBindLiveHandle {
    delivery: TelegramBindDeliveryHandle;
    view?: {
        text: string;
        parseMode: "markdown";
        replyMarkup?: unknown;
    };
}
export declare function getTelegramBindLiveSurfaceKey(app: string, profile: string, target: {
    chatId: number;
    threadId?: number;
}): string;
export interface TelegramBindToolRegistrationDeps extends GenerativeAppRuntimeOptions {
    getActiveProfileName?: () => string | undefined;
    liveSurfaceSetTimer?: GenerativeAppLiveSurfaceRuntimeDeps<unknown>["setTimer"];
    liveSurfaceClearTimer?: GenerativeAppLiveSurfaceRuntimeDeps<unknown>["clearTimer"];
    setLiveSurfaceRuntime?: (runtime: GenerativeAppLiveSurfaceRuntime<TelegramBindLiveHandle> | undefined) => void;
    isDeliveryHandleCurrent?: (handle: TelegramBindDeliveryHandle) => boolean;
    editView?: (handle: TelegramBindDeliveryHandle, view: {
        text: string;
        parseMode: "markdown";
        replyMarkup?: unknown;
    }) => Promise<{
        ok: true;
        value: TelegramBindDeliveryHandle;
    } | {
        ok: false;
        reason: string;
        message: string;
        retryAfterMs?: number;
    }>;
    getActiveTurn?: () => {
        chatId: number;
        replyToMessageId: number;
        target?: {
            chatId: number;
            threadId?: number;
        };
    } | undefined;
    planOutput?: (markdown: string, options: {
        binding: {
            generation: string;
            app: string;
            revision: number;
        };
    }) => {
        markdown: string;
        replyMarkup?: unknown;
    };
    sendMarkdownReply?: (chatId: number, replyToMessageId: number, markdown: string, options?: {
        replyMarkup?: unknown;
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => Promise<number | undefined>;
    sendView?: (view: {
        text: string;
        parseMode: "markdown";
        replyMarkup?: unknown;
    }, options: {
        scope: {
            kind: "active-turn";
        };
        replyToMessageId: number;
    }) => Promise<{
        ok: true;
        value: TelegramBindDeliveryHandle;
    } | {
        ok: false;
        reason?: string;
        message: string;
    }>;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export declare function resolveGenerativeAppDir(agentDir: string, app: string): string;
export declare function resolveGenerativeAppModulePath(agentDir: string, app: string): string;
export declare function invokeGenerativeApp(options: GenerativeAppRuntimeOptions & {
    argument?: unknown;
    expectedGeneration?: string;
    expectedRevision?: number;
    method: string;
    app: string;
}): Promise<GenerativeAppInvocationResult>;
export declare function installGenerativeApp(options: GenerativeAppRuntimeOptions & {
    argument?: unknown;
    app: string;
    replace?: boolean;
    script: string;
}): Promise<GenerativeAppInvocationResult>;
export declare function parseGenerativeAppBoundAction(prompt: string): GenerativeAppBoundAction | undefined;
export declare function invokeGenerativeAppBoundAction(options: GenerativeAppRuntimeOptions & {
    expectedGeneration?: string;
    expectedRevision?: number;
    prompt: string;
}): Promise<GenerativeAppInvocationResult | undefined>;
export declare function bindGenerativeApp(options: GenerativeAppRuntimeOptions & {
    argument?: unknown;
    method?: string;
    app: string;
    replace?: boolean;
    script?: string;
}): Promise<GenerativeAppInvocationResult>;
export declare function createGenerativeAppLiveSurfaceRuntime<THandle>(deps: GenerativeAppLiveSurfaceRuntimeDeps<THandle>): GenerativeAppLiveSurfaceRuntime<THandle>;
export declare function formatGenerativeAppToolOutput(output: string): string;
export declare function formatDisplayedGenerativeAppToolOutput(): string;
export declare function formatGenerativeAppToolError(error: unknown): Error;
export declare function registerTelegramBindTool(pi: ExtensionAPI, deps: TelegramBindToolRegistrationDeps): void;
