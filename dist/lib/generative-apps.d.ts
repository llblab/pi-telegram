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
export interface GenerativeAppOwnerObservation {
    app: string;
    generation: string;
    revision?: number;
    reset?: boolean;
}
export interface GenerativeAppCallbackBinding {
    app: string;
    generation: string;
    revision: number;
    assertCurrent: () => void;
}
/** @internal Original filesystem guard and data-only observed history; neither is source-use or receiver authority. */
export interface GenerativeAppCallbackOwner {
    readonly assertCurrent: () => void;
    readonly assertObservedCurrent: () => void;
    /** @internal Opaque pre-worker snapshot on this exact native refresh result; not a membership certificate. */
    readonly originalPublicationSource?: unknown;
    /** @internal Exact native predecessor only; not a row disposition or business-effect receipt. */
    readonly captureReadOnlySuccessor?: (binding: unknown, invocation?: unknown, origin?: object) => Readonly<GenerativeAppCallbackOwner> | undefined;
    /** @internal One native app invocation, bound to a hidden original producer origin and exact decoded prompt. */
    readonly createCallbackInvocation?: (prompt: string, origin: object, authority?: Readonly<{
        assertCurrent: () => void;
        assertObservedCurrent: () => void;
    }>) => object;
}
/** @internal Capture only an existing original native owner; foreign/copy/unavailable bindings are never probed or adopted. */
export declare function captureGenerativeAppCallbackOwner(binding: unknown): Readonly<GenerativeAppCallbackOwner> | undefined;
/** @internal Historical native outcome for this exact claimed invocation; not parent or effect-execution authority. */
export declare function getGenerativeAppCallbackInvocationKind(binding: unknown, invocation: unknown): "read-only" | "state-written" | undefined;
/** @internal Data-only exact native refresh association; the store must authenticate its opaque source. */
export declare function getGenerativeAppRefreshPublicationSource(binding: unknown): Readonly<{
    source: unknown;
    predecessor: Readonly<GenerativeAppCallbackOwner>;
}> | undefined;
export declare function getGenerativeAppCallbackBinding(result: GenerativeAppInvocationResult): GenerativeAppCallbackBinding;
export interface GenerativeAppRuntimeOptions {
    agentDir: string;
    onOwnerObserved?: (owner: GenerativeAppOwnerObservation) => void;
    assertCallbackOwner?: () => void;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
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
    /** @internal Original native app producer for this surface lifetime; not SDK/physical-parent or callback authority. */
    originalAppBinding?: GenerativeAppCallbackBinding;
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
    /** @internal Constructor-pinned, synchronous pre-worker capture; no execution or SDK membership grant. */
    capturePublicationSource?: (handle: THandle, binding: GenerativeAppCallbackBinding) => Readonly<{
        assertCurrent: () => void;
    }> | undefined;
    onOwnerObserved?: GenerativeAppRuntimeOptions["onOwnerObserved"];
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
    /** @internal Original store-owned snapshot, addressed by the existing SDK-managed handle. */
    capturePublicationSource?: GenerativeAppLiveSurfaceRuntimeDeps<TelegramBindDeliveryHandle>["capturePublicationSource"];
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
        binding: GenerativeAppCallbackBinding;
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
export declare function isGenerativeAppInstalled(agentDir: string, app: string): Promise<boolean>;
export declare function resolveGenerativeAppModulePath(agentDir: string, app: string): string;
export declare function invokeGenerativeApp(options: GenerativeAppRuntimeOptions & {
    argument?: unknown;
    expectedGeneration?: string;
    expectedRevision?: number;
    method: string;
    app: string;
    /** @internal Keep callback work owned until native termination settles and the worker exits. */
    callbackWorkerDrain?: true;
    /** @internal Native original binding; only the drain opt-in can record read-only lineage. */
    callbackBinding?: unknown;
    /** @internal One native producer-bound invocation; never copied into worker data. */
    callbackInvocation?: unknown;
    /** @internal Opaque original snapshot stays main-side; only a drained native refresh may carry it. */
    originalPublicationSource?: unknown;
}): Promise<GenerativeAppInvocationResult>;
export declare function installGenerativeApp(options: GenerativeAppRuntimeOptions & {
    argument?: unknown;
    app: string;
    replace?: boolean;
    script: string;
}): Promise<GenerativeAppInvocationResult>;
export declare function parseGenerativeAppBoundAction(prompt: string): GenerativeAppBoundAction | undefined;
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
