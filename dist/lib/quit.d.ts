export interface TelegramQuitScope {
    readonly profileKey: string;
    readonly botId: number;
    readonly ownerUserId: number;
    readonly chatId: number;
    readonly threadId: number;
    readonly instanceId: string;
    readonly processBirthId: string;
    readonly sessionId: string;
    readonly sessionGeneration: number;
    readonly transportGeneration: string;
}
declare const QUIESCENCE_KEYS: readonly ["agent", "piMessages", "telegramQueue", "dispatch", "compaction", "groupedInput", "acceptedInput", "delivery"];
type Quiescence = Record<typeof QUIESCENCE_KEYS[number], "clear" | "busy" | "unknown">;
export interface TelegramQuitSnapshot {
    readonly scope: TelegramQuitScope;
    readonly automaticCleanup: boolean;
    readonly quiescence: Readonly<Quiescence>;
    readonly transport: {
        readonly role: "leader" | "follower";
        readonly cohortKey: string;
        readonly survivorCount: number;
        readonly quitSupported: boolean;
        readonly failoverReady: boolean;
    };
}
interface QuitGateLease {
    isCurrent(): boolean;
    reopen(): void;
    seal(): boolean;
}
export interface TelegramQuitAdmissionGate {
    readonly scope: TelegramQuitScope;
    enter(scope: TelegramQuitScope): (() => void) | undefined;
    tryClose(scope: TelegramQuitScope): QuitGateLease | undefined;
    invalidate(): void;
    getPhase(): "open" | "closing" | "sealed" | "retired";
}
/** Local only. A future bus adapter must enforce this at the leader as well. */
export declare function createTelegramQuitAdmissionGate(scope: TelegramQuitScope): TelegramQuitAdmissionGate;
export interface TelegramQuitSource {
    readonly scope: TelegramQuitScope;
    readonly actorUserId: number;
    readonly messageId: number;
}
export interface TelegramQuitConfirmation extends TelegramQuitSource {
    readonly token: string;
    readonly expiresAtMs: number;
    readonly snapshot: TelegramQuitSnapshot;
}
export interface TelegramQuitCleanupConsent {
    readonly scope: TelegramQuitScope;
    readonly operationId: string;
    readonly updateId: number;
    readonly automaticCleanup: boolean;
}
export interface TelegramQuitExecutionFence {
    readonly signal: AbortSignal;
    assertCurrent(): void;
}
export type TelegramQuitFailure = "unavailable" | "denied" | "busy" | "unknown" | "unsupported" | "changed" | "expired" | "stale" | "cancelled" | "refresh-failed" | "acknowledgement-failed" | "outcome-unknown";
type Failure = {
    ok: false;
    reason: TelegramQuitFailure;
};
type Phase = "offered" | "confirming" | "armed" | "finalizing" | "disconnecting" | "left-running" | "shutdown-requested" | "outcome-unknown";
export type TelegramQuitDeleteFirstResult = {
    readonly status: "deleted";
    readonly deletion: TelegramQuitDeletionResult;
} | {
    readonly status: "refused";
    readonly reason: "busy" | "unknown" | "changed" | "unsupported";
} | {
    readonly status: "disconnected-unconfirmed";
} | {
    readonly status: "outcome-unknown";
};
export interface TelegramQuitFoundationDeps {
    gate: TelegramQuitAdmissionGate;
    /** Fresh synchronous projection; missing evidence fails closed. Never a diagnostic snapshot. */
    readSnapshot(): TelegramQuitSnapshot | undefined;
    /** Refresh asynchronous policy/peer sources without retaining obsolete runtime contexts. */
    refresh(fence: TelegramQuitExecutionFence): Promise<void>;
    acknowledge(confirmation: TelegramQuitConfirmation, fence: TelegramQuitExecutionFence): Promise<boolean>;
    /** Existing immediate path. A delete-first adapter leaves this as a non-effecting compatibility port. */
    shutdown(consent: TelegramQuitCleanupConsent): void;
    /** Optional v1 path: exact leader close/delete before any native shutdown decision. */
    deleteFirst?: (consent: TelegramQuitCleanupConsent, fence: TelegramQuitExecutionFence) => Promise<TelegramQuitDeleteFirstResult>;
    /** Synchronous final local evidence check after confirmed deletion. Must never schedule a later retry. */
    afterDeletion?: (consent: TelegramQuitCleanupConsent, deletion: TelegramQuitDeletionResult) => TelegramQuitExitResult;
    onFailure?: (reason: TelegramQuitFailure) => void;
    now?: () => number;
    confirmationTtlMs?: number;
}
declare const EXIT_IDENTITY_KEYS: readonly ["profileKey", "botId", "ownerUserId", "chatId", "instanceId", "processBirthId", "sessionId", "sessionGeneration"];
export declare function resolveTelegramQuitFinalAcceptedInput(journalEntryCount: number | undefined, disconnected: boolean): "clear" | "busy" | "unknown";
export interface TelegramQuitExitSnapshot {
    /** Fresh Pi/session identity; the deleted Thread and disconnected transport are deliberately absent. */
    readonly identity: Pick<TelegramQuitScope, typeof EXIT_IDENTITY_KEYS[number]>;
    readonly connection: "disconnected" | "connected" | "unknown";
    readonly quiescence: Readonly<Quiescence>;
}
/** Local evidence from the existing exact-operation cleanup adapter, not a new wire/persistence format. */
export interface TelegramQuitDeletionResult {
    readonly scope: TelegramQuitScope;
    readonly operationId: string;
    readonly confirmed: boolean;
}
export type TelegramQuitFollowerDisconnectAttempt = {
    readonly status: "refused";
    readonly reason: "busy" | "unknown" | "changed" | "unsupported";
} | {
    readonly status: "disconnected";
    readonly outcome: {
        readonly instanceId: string;
        readonly registrationGeneration: string;
        readonly target?: {
            readonly chatId: number;
            readonly threadId: number;
        };
        readonly deletion?: {
            readonly kind: "follower-disconnect-result";
            readonly instanceId: string;
            readonly registrationGeneration: string;
            readonly target: {
                readonly chatId: number;
                readonly threadId: number;
            };
            readonly threadDeletion: "confirmed" | "unconfirmed";
        };
    };
};
/** Adapt the already-correlated follower result into one exact consent-bound deletion decision. */
export declare function createTelegramFollowerDeleteFirstPort(deps: {
    scope: TelegramQuitScope;
    registrationGeneration: string;
    disconnect(): Promise<TelegramQuitFollowerDisconnectAttempt | undefined>;
}): (consent: TelegramQuitCleanupConsent, fence: TelegramQuitExecutionFence) => Promise<TelegramQuitDeleteFirstResult>;
export type TelegramQuitExitResult = {
    readonly status: "shutdown-requested" | "shutdown-outcome-unknown";
} | {
    readonly status: "left-running";
    readonly reason: "cleanup-unconfirmed" | "consent-unavailable" | "session-changed" | "connected" | "busy" | "unknown";
};
/** One synchronous exit decision AFTER separately authorized deletion/disconnection.
 * Does not issue cleanup, establish remote admission/settlement, or schedule a later quit.
 * The same consent owner must survive cleanup; transport removal is not session replacement.
 */
export declare function createTelegramQuitAfterDeletion(deps: {
    consent: TelegramQuitCleanupConsent;
    getCleanupConsent(scope: TelegramQuitScope): TelegramQuitCleanupConsent | undefined;
    readExitSnapshot(): TelegramQuitExitSnapshot | undefined;
    /** Invoke only the public shutdown API of the captured Pi session. */
    shutdown(): void;
    onShutdownError?: (error: unknown) => void;
}): {
    finish(deletion: TelegramQuitDeletionResult | undefined): TelegramQuitExitResult;
};
/** No caller in extension.ts: this prepares Q1 without exposing a shutdown command. */
export declare function createTelegramQuitFoundation(deps: TelegramQuitFoundationDeps): {
    prepare(source: TelegramQuitSource): {
        ok: true;
        confirmation: TelegramQuitConfirmation;
    } | Failure;
    confirm(source: TelegramQuitSource & {
        token: string;
        updateId: number;
    }): Promise<{
        ok: true;
    } | Failure>;
    /** Only the journal owner's exact post-completion hook may call this. Never await it in the worker. */
    onUpdateCompleted(updateId: number, scope: TelegramQuitScope): void;
    cancel(source: TelegramQuitSource & {
        token: string;
    }): boolean;
    getCleanupConsent: (scope: TelegramQuitScope) => TelegramQuitCleanupConsent | undefined;
    /** Bind this same resolver into local deletion and preservation before teardown.
     * Normal terminal quit retains its existing resolver. Lost committed consent is
     * unavailable, never permission to fall back to a more destructive live setting.
     */
    resolveAutomaticThreadCleanupEnabled(scope: TelegramQuitScope, resolveTerminalPolicy: () => boolean | Promise<boolean>): boolean | Promise<boolean>;
    getPhase(): Phase | "idle" | "disposed";
    getExitResult(): TelegramQuitExitResult | undefined;
    dispose(): void;
};
export interface TelegramQuitCommandMessage {
    readonly chatId: number;
    readonly threadId: number;
    readonly actorUserId: number;
}
export interface TelegramQuitCommandCallbackQuery {
    readonly id: string;
    readonly data?: string;
    readonly from?: {
        readonly id?: number;
    };
    readonly message?: {
        readonly chat?: {
            readonly id?: number;
        };
        readonly message_id?: number;
        readonly message_thread_id?: number;
    };
}
export interface TelegramQuitCommandReplyMarkup {
    readonly inline_keyboard: ReadonlyArray<ReadonlyArray<{
        readonly text: string;
        readonly callback_data: string;
    }>>;
}
export interface TelegramQuitCommandControllerDeps {
    readonly foundation: Omit<TelegramQuitFoundationDeps, "acknowledge" | "onFailure"> & {
        readonly onFailure?: (reason: TelegramQuitFailure) => void;
    };
    sendInteractiveMessage(chatId: number, text: string, mode: "html", replyMarkup: TelegramQuitCommandReplyMarkup, options: {
        target: {
            chatId: number;
            threadId: number;
        };
    }): Promise<number | undefined>;
    editInteractiveMessage(chatId: number, messageId: number, text: string, mode: "html", replyMarkup: TelegramQuitCommandReplyMarkup): Promise<void>;
    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}
/** Private UI/composition adapter. It does not register `/quit` or a callback route. */
export declare function createTelegramQuitCommandController(deps: TelegramQuitCommandControllerDeps): {
    foundation: {
        prepare(source: TelegramQuitSource): {
            ok: true;
            confirmation: TelegramQuitConfirmation;
        } | Failure;
        confirm(source: TelegramQuitSource & {
            token: string;
            updateId: number;
        }): Promise<{
            ok: true;
        } | Failure>;
        /** Only the journal owner's exact post-completion hook may call this. Never await it in the worker. */
        onUpdateCompleted(updateId: number, scope: TelegramQuitScope): void;
        cancel(source: TelegramQuitSource & {
            token: string;
        }): boolean;
        getCleanupConsent: (scope: TelegramQuitScope) => TelegramQuitCleanupConsent | undefined;
        /** Bind this same resolver into local deletion and preservation before teardown.
         * Normal terminal quit retains its existing resolver. Lost committed consent is
         * unavailable, never permission to fall back to a more destructive live setting.
         */
        resolveAutomaticThreadCleanupEnabled(scope: TelegramQuitScope, resolveTerminalPolicy: () => boolean | Promise<boolean>): boolean | Promise<boolean>;
        getPhase(): Phase | "idle" | "disposed";
        getExitResult(): TelegramQuitExitResult | undefined;
        dispose(): void;
    };
    open(message: TelegramQuitCommandMessage): Promise<{
        ok: true;
    } | Failure>;
    handleCallback(query: TelegramQuitCommandCallbackQuery, updateId: number): Promise<boolean>;
    onUpdateCompleted(updateId: number): void;
    dispose(): void;
};
/**
 * Defers `/quit` UI publication until its command update is durably complete, then forwards
 * every later durable completion to the confirmation controller. Memory-only scheduling is
 * intentionally safe to lose: replay can request again, while no cleanup authority exists yet.
 */
export declare function createTelegramQuitLifecycleController(deps: {
    controller: ReturnType<typeof createTelegramQuitCommandController>;
    onOpenResult?: (result: {
        ok: true;
    } | Failure) => void;
    recordError?: (error: unknown) => void;
}): {
    requestOpen(message: TelegramQuitCommandMessage, updateId: number): boolean;
    onUpdateCompleted(updateId: number): void;
    hasPendingOpen(): boolean;
    dispose(): void;
};
export interface TelegramQuitProductionRuntime<TMessage, TQuery, TContext> {
    request(message: TMessage, ctx: TContext): Promise<void>;
    handleCallback(query: TQuery, ctx: TContext, updateId: number | undefined): Promise<boolean>;
    onUpdateCompleted(updateId: number): void;
    resolveTerminalCleanup(fallback: () => boolean | Promise<boolean>): boolean | Promise<boolean>;
    dispose(): void;
}
export declare function createTelegramQuitProductionBinding<TMessage, TQuery, TContext>(): {
    bind(next: TelegramQuitProductionRuntime<TMessage, TQuery, TContext>): void;
    request(message: TMessage, ctx: TContext): Promise<void>;
    handleCallback(query: TQuery, ctx: TContext, updateId: number | undefined): Promise<boolean>;
    onUpdateCompleted(updateId: number): void;
    resolveTerminalCleanup(fallback: () => boolean | Promise<boolean>): boolean | Promise<boolean>;
    reset(): void;
    dispose(): void;
};
/** Production-facing adapter; orchestration stays here while extension.ts supplies narrow owner ports. */
export declare function createTelegramQuitProductionRuntime<TMessage, TQuery extends TelegramQuitCommandCallbackQuery, TContext>(deps: {
    readScope(ctx: TContext): TelegramQuitScope | undefined;
    readQuiescence(ctx: TContext, target: {
        chatId: number;
        threadId: number;
    }, callbackUpdateId: number | undefined): TelegramQuitSnapshot["quiescence"];
    readExitSnapshot(ctx: TContext, scope: TelegramQuitScope): TelegramQuitExitSnapshot | undefined;
    readMessage(message: TMessage): TelegramQuitCommandMessage | undefined;
    getExecutionUpdateId(message: TMessage): number | undefined;
    disconnect(): Promise<TelegramQuitFollowerDisconnectAttempt | undefined>;
    shutdown(ctx: TContext): void;
    sendInteractiveMessage: TelegramQuitCommandControllerDeps["sendInteractiveMessage"];
    editInteractiveMessage: TelegramQuitCommandControllerDeps["editInteractiveMessage"];
    answerCallbackQuery: TelegramQuitCommandControllerDeps["answerCallbackQuery"];
    rejectCommand(message: TMessage, text: string): Promise<void>;
    recordError(error: unknown, phase: string): void;
}): {
    request(message: TMessage, ctx: TContext): Promise<void>;
    handleCallback(query: TQuery, ctx: TContext, updateId: number | undefined): Promise<boolean>;
    onUpdateCompleted(updateId: number): void;
    resolveTerminalCleanup(fallback: () => boolean | Promise<boolean>): boolean | Promise<boolean>;
    dispose: () => void;
};
export {};
