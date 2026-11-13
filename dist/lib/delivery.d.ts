/**
 * Telegram target-aware operational delivery and logical message lifecycle
 * Zones: telegram delivery, extension API, runtime binding
 * Owns the public extension delivery contract, authorized scope resolution, operational rendering adapter, per-target serialization, chunk reconciliation, generation-fenced logical handles, explicit confirmation/choice/text answer lifecycles, and process-local runtime membrane; composes the established reply renderer with bus-aware Telegram API ports and excludes bot clients, Pi contexts, and consumer-extension policy
 */
import { type TelegramTextSourceUseInput } from "./journal.ts";
import { type TelegramInlineKeyboardButtonStyle, type TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import { type TelegramTarget } from "./target.ts";
import { type TelegramBridgeApiRuntime, type TelegramAttachmentConsumerLease } from "./telegram-api.ts";
export type TelegramDeliveryParseMode = "plain" | "html" | "markdown";
export interface TelegramDeliveryView {
    text: string;
    parseMode?: TelegramDeliveryParseMode;
    replyMarkup?: TelegramInlineKeyboardMarkup;
}
export type TelegramDeliveryTarget = TelegramTarget;
export type TelegramDeliveryScope = {
    kind: "active-turn";
} | {
    kind: "instance";
} | {
    kind: "aggregate";
} | {
    kind: "target";
    target: TelegramDeliveryTarget;
};
export interface TelegramArtifactRequest {
    owner: string;
    scope: Exclude<TelegramDeliveryScope, {
        kind: "aggregate";
    }>;
    file: {
        path: string;
        name: string;
    };
    caption?: string;
    timeoutMs: number;
    signal: AbortSignal;
}
export interface TelegramArtifactReceipt {
    readonly kind: "document";
    readonly target: Readonly<TelegramDeliveryTarget>;
    readonly generation: string;
    readonly messageId: number;
    readonly fileName: string;
    readonly byteLength: number;
}
export type TelegramArtifactEffect = "not-issued" | "rejected" | "unknown";
export type TelegramArtifactFailureReason = "runtime-unavailable" | "target-unavailable" | "target-unauthorized" | "capacity-exceeded" | "source-unavailable" | "source-invalid" | "source-changed" | "size-exceeded" | "aborted" | "expired" | "invalidated" | "transport-rejected" | "transport-failed" | "commit-unknown";
export type TelegramArtifactResult = {
    ok: true;
    receipt: TelegramArtifactReceipt;
} | {
    ok: false;
    reason: TelegramArtifactFailureReason;
    effect: TelegramArtifactEffect;
    message: string;
    observedReceipt?: TelegramArtifactReceipt;
};
export interface TelegramDeliveryHandle {
    readonly target: TelegramDeliveryTarget;
    readonly messageIds: readonly number[];
    readonly generation: string;
}
export type TelegramDeliveryFailureReason = "runtime-unavailable" | "target-unavailable" | "target-unauthorized" | "stale-handle" | "invalid-view" | "commit-unknown" | "message-unavailable" | "rate-limited" | "transport-retryable" | "transport-failed";
export type TelegramDeliveryResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    reason: TelegramDeliveryFailureReason;
    message: string;
    /** Exact Telegram flood-control delay when supplied by the API. */
    retryAfterMs?: number;
    /** Successfully materialized state that callers may edit or delete to recover. */
    partial?: T;
};
export interface SendTelegramViewOptions {
    scope: TelegramDeliveryScope;
    replyToMessageId?: number;
}
export type TelegramDeliveryChatAction = "typing" | "upload_document" | "upload_photo" | "record_voice";
export type TelegramTaskViewStatus = "running" | "completed" | "failed" | "cancelled";
export interface TelegramTaskViewState {
    status: TelegramTaskViewStatus;
    text: string;
    /** Producer-reported fraction; omission means indeterminate, not zero. */
    progress?: number;
}
export interface TelegramTaskViewRequest {
    owner: string;
    scope: Exclude<TelegramDeliveryScope, {
        kind: "aggregate";
    }>;
    title: string;
    state: TelegramTaskViewState;
    cancellable?: boolean;
    cancelLabel?: string;
    timeoutMs: number;
    signal: AbortSignal;
}
export type TelegramTaskViewEnd = Exclude<TelegramTaskViewStatus, "running"> | "closed" | "expired" | "aborted" | "invalidated";
export type TelegramTaskViewCancellation = {
    readonly status: "requested";
} | {
    readonly status: "closed";
    readonly reason: TelegramTaskViewEnd;
};
export type TelegramTaskViewUpdateResult = {
    ok: true;
    value: {
        readonly revision: number;
        readonly status: "applied" | "superseded";
    };
} | {
    ok: false;
    reason: TelegramDeliveryFailureReason;
    message: string;
    effect: "not-issued" | "unknown";
};
export interface TelegramTaskViewHandle {
    readonly id: string;
    readonly target: Readonly<TelegramDeliveryTarget>;
    readonly generation: string;
    /** Projection lifetime only, never proof of task execution or completion. */
    readonly result: Promise<{
        readonly status: TelegramTaskViewEnd;
    }>;
    readonly cancellation: Promise<TelegramTaskViewCancellation>;
    update(state: TelegramTaskViewState): Promise<TelegramTaskViewUpdateResult>;
    /** Retire the projection, not the producer's task. */
    close(): void;
}
export type TelegramTaskViewOpenResult = {
    ok: true;
    handle: TelegramTaskViewHandle;
} | {
    ok: false;
    reason: TelegramConfirmFailureReason;
    message: string;
    effect: "not-issued" | "unknown";
};
/** @internal */
export interface TelegramDeliveryTaskViewPort {
    openTaskView(request: TelegramTaskViewRequest, isBindingCurrent?: () => boolean): Promise<TelegramTaskViewOpenResult>;
    acceptTaskCancel(query: TelegramDeliveryConfirmationCallback, assertAuthority?: () => void): {
        handled: false;
    } | {
        handled: true;
        accepted: false;
    } | {
        handled: true;
        accepted: true;
        assertCurrent(): void;
    };
}
export interface TelegramConfirmRequest {
    owner: string;
    scope: Exclude<TelegramDeliveryScope, {
        kind: "aggregate";
    }>;
    question: string;
    confirmLabel: string;
    cancelLabel: string;
    confirmStyle?: TelegramInlineKeyboardButtonStyle;
    /** Defaults to 24 hours; explicit deadlines are not renewed by UI activity. */
    timeoutMs?: number;
    signal: AbortSignal;
}
export interface TelegramChoiceOption {
    readonly id: string;
    readonly label: string;
    readonly style?: TelegramInlineKeyboardButtonStyle;
    readonly disabled?: boolean;
}
export interface TelegramChoiceRequest {
    owner: string;
    scope: Exclude<TelegramDeliveryScope, {
        kind: "aggregate";
    }>;
    question: string;
    choices: readonly TelegramChoiceOption[];
    cancelLabel: string;
    /** Defaults to 24 hours; explicit deadlines are not renewed by UI activity. */
    timeoutMs?: number;
    signal: AbortSignal;
}
export type TelegramChoiceDecision = {
    status: "selected";
    choiceId: string;
} | {
    status: "cancelled" | "expired" | "aborted" | "invalidated";
};
export interface TelegramChoiceHandle {
    readonly id: string;
    readonly target: Readonly<TelegramDeliveryTarget>;
    readonly generation: string;
    readonly result: Promise<TelegramChoiceDecision>;
}
export type TelegramChoiceFailureReason = TelegramConfirmFailureReason;
export type TelegramChoiceOpenResult = {
    ok: true;
    handle: TelegramChoiceHandle;
} | {
    ok: false;
    reason: TelegramChoiceFailureReason;
    message: string;
};
/** @internal */
export interface TelegramDeliveryChoicePort {
    openChoice(request: TelegramChoiceRequest): Promise<TelegramChoiceOpenResult>;
    acceptChoice(query: TelegramDeliveryConfirmationCallback, assertAuthority?: () => void): TelegramDeliveryChoiceAcceptance;
}
/** @internal */
export type TelegramDeliveryChoiceAcceptance = {
    handled: false;
} | {
    handled: true;
    accepted: false;
} | {
    handled: true;
    accepted: true;
    handle: TelegramChoiceHandle;
    decision: TelegramChoiceDecision;
    assertCurrent: () => void;
};
/** Internal foundation only: public exposure waits for inbound custody and stale-reply routing. */
export interface TelegramTextInputRequest {
    owner: string;
    scope: Exclude<TelegramDeliveryScope, {
        kind: "aggregate";
    }>;
    question: string;
    cancelLabel: string;
    /** Defaults to 24 hours; explicit deadlines are not renewed by UI activity. */
    timeoutMs?: number;
    signal: AbortSignal;
    maxLength?: number;
    multiline?: boolean;
}
/** @internal Private native question/SDK result only; no accepting source composition or public opener. */
export interface TelegramAttachmentQuestionRequest extends Omit<TelegramTextInputRequest, "maxLength" | "multiline" | "timeoutMs"> {
    timeoutMs: number;
    accept?: readonly string[];
    maxFiles?: number;
    maxBytes?: number;
}
export type TelegramAttachmentQuestionEnd = {
    readonly status: "cancelled" | "expired" | "aborted" | "invalidated";
};
/** Native provider/SDK custody only. The positive result receipt below is a separate boundary. */
export interface TelegramAttachmentSdkCustody {
    readonly assertAcknowledged: () => void;
}
/** Actual cancelled SDK result before any handoff attempt; not source/file disposition or business authority. */
export interface TelegramAttachmentCancellationReceipt {
    readonly kind: "cancelled";
    readonly assertAcknowledged: () => void;
}
/** Actual expiry/producer-abort SDK result before handoff; invalidation and raw clock/signal flags are not this fact. */
export interface TelegramAttachmentEndReceipt {
    readonly kind: "ended";
    readonly reason: "expired" | "aborted";
    readonly assertAcknowledged: () => void;
}
/** Private structured output; consumer disposal never disposes the source or grants execution. */
export interface TelegramAttachmentProducerFiles {
    readonly lease: Readonly<TelegramAttachmentConsumerLease>;
    readonly dispose: () => Promise<boolean>;
}
export interface TelegramAttachmentProducerReceipt {
    readonly kind: "sdk-result";
    readonly assertAcknowledged: () => void;
}
export type TelegramAttachmentFileProvider = (custody: Readonly<TelegramAttachmentSdkCustody>) => Readonly<TelegramAttachmentProducerFiles>;
export type TelegramAttachmentQuestionDecision = TelegramAttachmentQuestionEnd | (TelegramAttachmentProducerFiles & {
    readonly status: "submitted";
});
export interface TelegramAttachmentQuestionHandle {
    readonly id: string;
    readonly target: Readonly<TelegramDeliveryTarget>;
    readonly generation: string;
    readonly result: Promise<TelegramAttachmentQuestionDecision>;
}
export type TelegramAttachmentQuestionOpenResult = {
    ok: true;
    handle: TelegramAttachmentQuestionHandle;
} | {
    ok: false;
    reason: TelegramConfirmFailureReason;
    message: string;
};
export interface TelegramAttachmentReceiverIdentity extends TelegramTextInputReceiverIdentity {
}
/** Mechanical question arbitration only; never a source/file pin, answer or producer receipt. */
export interface TelegramAttachmentSourceReservation {
    readonly assertCurrent: () => void;
    /** Native definitive validation refusal only: retire this slot, never source/file custody. */
    readonly decline: () => void;
    /** Optional private native SDK result capability, not source disposition or business authority. */
    readonly handoff?: (materialize: TelegramAttachmentFileProvider) => Readonly<TelegramAttachmentProducerReceipt>;
    /** Historical cancellation only; cannot revive the consumed waiting receiver/reservation. */
    readonly getCancellationReceipt?: () => Readonly<TelegramAttachmentCancellationReceipt> | undefined;
    /** Actual expired/aborted SDK history only, without source/file disposition or receiver renewal. */
    readonly getEndReceipt?: () => Readonly<TelegramAttachmentEndReceipt> | undefined;
}
/** Frozen declaration evidence; reservation is an explicit separate act, never an acquisition/file-use grant. */
export interface TelegramAttachmentReceiverGuard extends TelegramTextInputReceiverGuard {
    readonly constraints: Readonly<{
        accept: readonly string[];
        maxFiles: number;
        maxBytes: number;
    }>;
    readonly deadline: number;
    /** Private native capability. Older observation-only receivers cannot admit sources. */
    readonly reserveSource?: (owner: object) => Readonly<TelegramAttachmentSourceReservation> | undefined;
}
export type TelegramAttachmentQuestionAcceptance = {
    handled: false;
} | {
    handled: true;
    accepted: false;
} | {
    handled: true;
    accepted: true;
    handle: TelegramAttachmentQuestionHandle;
    decision: TelegramAttachmentQuestionEnd;
    assertCurrent: () => void;
};
export type TelegramTextInputDecision = {
    status: "submitted";
    text: string;
} | {
    status: "cancelled" | "expired" | "aborted" | "invalidated" | "replaced";
};
export interface TelegramTextInputHandle {
    readonly id: string;
    readonly target: Readonly<TelegramDeliveryTarget>;
    readonly generation: string;
    readonly result: Promise<TelegramTextInputDecision>;
}
export type TelegramTextInputOpenResult = {
    ok: true;
    handle: TelegramTextInputHandle;
} | {
    ok: false;
    reason: TelegramConfirmFailureReason | "replaced";
    message: string;
};
export interface TelegramTextInputMessage {
    message_id?: number;
    from?: {
        id?: number;
    };
    chat?: {
        id?: number;
    };
    message_thread_id?: number;
    text?: string;
    edit_date?: number;
    reply_to_message?: {
        message_id?: number;
    };
}
/** Routing evidence only. It cannot restore a receiver or authorize answer delivery. */
type TelegramPrivateInputReplySource<K extends "text" | "attachment"> = {
    kind: K;
    requestId: string;
    messageId: number;
    target: Readonly<TelegramDeliveryTarget>;
} | {
    kind: "unavailable";
};
export type TelegramTextInputReplySource = TelegramPrivateInputReplySource<"text">;
/** Private provenance hint only; cannot admit input, restore a receiver or release a source. */
export type TelegramAttachmentReplySource = TelegramPrivateInputReplySource<"attachment">;
/** @internal Exact SDK control shape; a publication hint, never a receiver or action grant. */
export declare function getTelegramTextInputControlId(replyMarkup: unknown): string | undefined;
/** @internal Exact control hint only; never receiver or source authority. */
export declare function getTelegramAttachmentControlId(replyMarkup: unknown): string | undefined;
/** @internal A side-effect-free receiver query reports its configured bot only while the whole private-input path is ready. */
export declare function readTelegramTextInputReceiverBotId(read: ((target: Readonly<TelegramDeliveryTarget>) => number | undefined) | undefined, target: Readonly<TelegramDeliveryTarget>): number | undefined;
/** @internal Only an original message from the configured bot can label an SDK reply. */
export declare function readTelegramTextInputReplySource(message: unknown, botId: number | undefined): TelegramTextInputReplySource | undefined;
/** @internal Configured-own-bot hints only, independent of content/file validation and receiver lifetime. */
export declare function readTelegramAttachmentReplySource(message: unknown, botId: number | undefined): TelegramAttachmentReplySource | undefined;
/** @internal Process-local observation only; never answer or execution authority. */
export interface TelegramTextInputReceiverIdentity {
    requestId: string;
    messageId: number;
    operatorId: number;
    botId: number;
    profile: string;
    target: Readonly<TelegramDeliveryTarget>;
}
/** @internal An observed failure permanently invalidates this guard. */
export interface TelegramTextInputReceiverGuard {
    readonly assertCurrent: () => void;
}
/** @internal Known native question non-submission only; never a physical source ACK or disposition grant. */
export interface TelegramTextInputNonUseObservation {
    readonly reason: "cancelled" | "expired" | "aborted" | "replaced";
    readonly assertCurrent: () => void;
}
export interface TelegramTextInputNativeNonUseIdentity {
    readonly requestId: string;
    readonly generation: string;
    readonly profile: string;
    readonly operatorId: number;
    readonly botId: number;
    readonly target: Readonly<TelegramDeliveryTarget>;
    readonly reason: TelegramTextInputNonUseObservation["reason"];
}
/** @internal Original local Input observation, including pre-ACK opening. Not fresh-source or answer authority. */
export interface TelegramTextInputSourceSelection extends TelegramTextInputReceiverGuard {
    /** Original receiver binding for negative source protection only; survives this Input's terminal state, never binding loss. */
    readonly assertOriginalBinding: () => void;
    /** Finite non-use observation of this captured entry; no result/answer/history lookup. */
    readonly captureNonUse: () => Readonly<TelegramTextInputNonUseObservation> | undefined;
    readonly requestId: string;
    readonly generation: string;
    readonly profile: string;
    readonly operatorId: number;
    readonly botId: number;
    readonly target: Readonly<TelegramDeliveryTarget>;
}
export interface TelegramTextInputSourceUse {
    readonly source: Readonly<TelegramTextSourceUseInput>;
    readonly requestId: string;
    readonly generation: string;
}
export type TelegramTextInputAcceptance = {
    handled: false;
} | {
    handled: true;
    accepted: false;
    reason: "unavailable" | "invalid-source" | "invalid-answer";
} | {
    handled: true;
    accepted: true;
    handle: TelegramTextInputHandle;
    decision: TelegramTextInputDecision;
    assertCurrent: () => void;
};
export type TelegramConfirmDecision = {
    status: "confirmed" | "cancelled" | "expired" | "aborted" | "invalidated";
};
export interface TelegramConfirmHandle {
    readonly id: string;
    readonly target: Readonly<TelegramDeliveryTarget>;
    readonly generation: string;
    readonly result: Promise<TelegramConfirmDecision>;
}
export type TelegramConfirmFailureReason = TelegramDeliveryFailureReason | "aborted" | "expired" | "invalidated" | "capacity-exceeded";
export type TelegramConfirmOpenResult = {
    ok: true;
    handle: TelegramConfirmHandle;
} | {
    ok: false;
    reason: TelegramConfirmFailureReason;
    message: string;
};
/** @internal */
export interface TelegramDeliveryConfirmationCallback {
    data?: string;
    from?: {
        id?: number;
    };
    message?: {
        chat?: {
            id?: number;
        };
        message_id?: number;
        message_thread_id?: number;
    };
}
/** @internal */
export interface TelegramOwnedConfirmation {
    confirmedData: string;
    cancelledData: string;
    publish(target: TelegramDeliveryTarget, html: string, markup: TelegramInlineKeyboardMarkup, assertAuthority: () => void): Promise<number | undefined>;
}
/** @internal */
export interface TelegramDeliveryConfirmationPort {
    openConfirmation(request: TelegramConfirmRequest, owned?: TelegramOwnedConfirmation): Promise<TelegramConfirmOpenResult>;
    acceptConfirmation(query: TelegramDeliveryConfirmationCallback, assertAuthority?: () => void): TelegramDeliveryConfirmationAcceptance;
}
/** @internal */
export type TelegramDeliveryConfirmationAcceptance = {
    handled: false;
} | {
    handled: true;
    accepted: false;
} | {
    handled: true;
    accepted: true;
    handle: TelegramConfirmHandle;
    decision: TelegramConfirmDecision;
    assertCurrent: () => void;
    callbackData?: string;
};
/** @internal Shared private question policy; not an authoring or SDK result surface. */
export declare const TELEGRAM_QUESTION_TAIL_MS = 3600000;
/** @internal */
export interface TelegramDeliveryRuntime {
    readonly generation: string;
    sendArtifact?: (request: TelegramArtifactRequest, isBindingCurrent: () => boolean) => Promise<TelegramArtifactResult>;
    openTaskView?: TelegramDeliveryTaskViewPort["openTaskView"];
    acceptTaskCancel?: TelegramDeliveryTaskViewPort["acceptTaskCancel"];
    openConfirmation?: TelegramDeliveryConfirmationPort["openConfirmation"];
    acceptConfirmation?: TelegramDeliveryConfirmationPort["acceptConfirmation"];
    openChoice?: TelegramDeliveryChoicePort["openChoice"];
    acceptChoice?: TelegramDeliveryChoicePort["acceptChoice"];
    /** Private native question/SDK result only. No accepting source composition, lifecycle/public opener or root binding. */
    openAttachmentQuestion?: (request: TelegramAttachmentQuestionRequest) => Promise<TelegramAttachmentQuestionOpenResult>;
    captureAttachmentReceiver?: (identity: TelegramAttachmentReceiverIdentity) => TelegramAttachmentReceiverGuard | undefined;
    acceptAttachmentCancel?: (query: TelegramDeliveryConfirmationCallback, assertAuthority?: () => void) => TelegramAttachmentQuestionAcceptance;
    openTextInput?: (request: TelegramTextInputRequest) => Promise<TelegramTextInputOpenResult>;
    acceptTextInput?: (message: TelegramTextInputMessage, assertAuthority?: () => void, edited?: boolean, expectedRequestId?: string) => TelegramTextInputAcceptance;
    /** Exact marked-reply collector; older unversioned kernels must not silently ignore request identity. */
    acceptTextInputReply?: (message: TelegramTextInputMessage, requestId: string, assertAuthority?: () => void, edited?: boolean) => TelegramTextInputAcceptance;
    acceptTextInputCancel?: (query: TelegramDeliveryConfirmationCallback, assertAuthority?: () => void) => TelegramTextInputAcceptance;
    captureTextInputReceiver?: (identity: TelegramTextInputReceiverIdentity) => TelegramTextInputReceiverGuard | undefined;
    captureTextInputSource?: (target: TelegramDeliveryTarget) => Readonly<TelegramTextInputSourceSelection> | undefined;
    /** Private opt-in original SDK owner, not an agent-publication or source-completion receipt. */
    captureQuestionLifetimeOwner?: (binding?: unknown) => Readonly<TelegramQuestionLifetimeOwner> | undefined;
    hasPendingTarget?: (target: TelegramDeliveryTarget) => boolean;
    shutdown: () => void;
    sendView: (view: TelegramDeliveryView, options: SendTelegramViewOptions) => Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
    editView: (handle: TelegramDeliveryHandle, view: TelegramDeliveryView) => Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
    deleteView: (handle: TelegramDeliveryHandle) => Promise<TelegramDeliveryResult<void>>;
    sendChatAction: (action: TelegramDeliveryChatAction, scope: TelegramDeliveryScope) => Promise<TelegramDeliveryResult<void>>;
}
/** @internal Native SDK admission view; fields alone are not admission authority. */
export interface TelegramQuestionAdmission {
    readonly target: Readonly<TelegramDeliveryTarget>;
    readonly at: number;
}
/** @internal Original same-instance SDK scope; no method selects a later runtime. */
export interface TelegramQuestionLifetimeOwner {
    /** Opaque original scope, not a question admission/publication receipt. Aliases retain this same native token. */
    readonly scope: object;
    readonly assertScope: (scope: unknown) => void;
    readonly target: Readonly<TelegramDeliveryTarget>;
    readonly assertCurrent: () => void;
    /** Private data-only original history; not fresh provider/receiver currentness. */
    readonly assertObservedCurrent?: () => void;
    /** Verify an actual same-runtime synchronous SDK admission and return its original demotion clock. */
    readonly assertAdmission: (admission: unknown) => number;
    /** Private finite SDK demotion event, even after entry termination; only within its original synchronous scope. */
    readonly assertAdmissionEvent?: (admission: unknown) => number;
    /** Native non-match is undefined; a matching event with uncertain authority throws. Guards are native-only, synchronous and void. */
    readonly matchAdmissionEvent?: (admission: unknown, finalUse?: Readonly<{
        assertAuthority?: () => void;
        assertCurrent: () => void;
    }>) => number | undefined;
    /** One original snapshot/application; a local cohort seals native peers and a synchronous data-only final-use guard. */
    readonly captureTail: (cohort?: Readonly<{
        scopes: readonly object[];
        assertCurrent: () => void;
        /** Original native authority only; no SDK/provider callbacks. Runs before the data-only barrier. */
        assertAuthority?: () => void;
    }>) => (() => void);
}
/** @internal */
export interface TelegramDeliveryTargetResolverDeps {
    getActiveTurnTarget: () => TelegramDeliveryTarget | undefined;
    getInstanceTarget: () => TelegramDeliveryTarget | undefined;
    getAggregateTarget: () => TelegramDeliveryTarget | undefined;
    isExplicitTargetAuthorized: (target: TelegramDeliveryTarget) => boolean;
}
/** @internal */
export interface TelegramDeliveryRenderedChunk {
    text: string;
    parseMode: TelegramDeliveryParseMode;
}
/** @internal */
export interface TelegramDeliveryTransportOptions {
    assertAuthority?: () => void;
    replyToMessageId?: number;
    replyMarkup?: TelegramInlineKeyboardMarkup | null;
}
/** @internal */
export interface TelegramDeliveryRuntimeDeps extends TelegramDeliveryTargetResolverDeps {
    /** Private SDK-only head/tail checkpoint; production/agent coordination is not wired by this option. */
    questionHeadTail?: true;
    /** Private synchronous SDK-only admission scope; production composition remains unbound. */
    onQuestionAdmission?: (admission: Readonly<TelegramQuestionAdmission>) => void;
    /** Private original runtime provider; capture once on first eligible question/scope admission, never renew after loss. */
    captureQuestionAuthority?: () => (() => void) | undefined;
    captureArtifactTransport?: (target: TelegramDeliveryTarget, scope: TelegramArtifactRequest["scope"]) => ReturnType<NonNullable<TelegramBridgeApiRuntime["captureArtifactTransport"]>>;
    generation: string;
    getConfirmationAuthority?: () => {
        profile: string;
        operatorId: number;
    } | undefined;
    /** Private native original-publication port and complete-path readiness; both remain unbound in production. */
    publishAttachmentQuestion?: (...args: Parameters<TelegramDeliveryRuntimeDeps["sendChunk"]>) => Promise<number | Readonly<{
        messageId: number;
        assertCurrent: () => void;
    }>>;
    getAttachmentReceiverBotId?: (target: Readonly<TelegramDeliveryTarget>) => number | undefined;
    /** Transport adapters must provide this query; isolated pure-kernel fixtures need no bot transport. */
    getTextInputReceiverBotId?: (target: Readonly<TelegramDeliveryTarget>) => number | undefined;
    captureDrain?: () => (() => void) | undefined;
    renderView: (view: TelegramDeliveryView) => readonly TelegramDeliveryRenderedChunk[];
    sendChunk: (target: TelegramDeliveryTarget, chunk: TelegramDeliveryRenderedChunk, options: TelegramDeliveryTransportOptions) => Promise<number>;
    editChunk: (target: TelegramDeliveryTarget, messageId: number, chunk: TelegramDeliveryRenderedChunk, options: TelegramDeliveryTransportOptions) => Promise<void>;
    deleteMessage: (target: TelegramDeliveryTarget, messageId: number) => Promise<void>;
    sendChatAction: (target: TelegramDeliveryTarget, action: TelegramDeliveryChatAction) => Promise<void>;
    recordFailure?: (operation: "send" | "edit" | "delete" | "chat-action", error: unknown, target?: TelegramDeliveryTarget) => void;
}
/** @internal */
export interface TelegramBridgeDeliveryRuntimeDeps {
    /** Private opt-in; concrete transport composition requires an original provider, never current target permission alone. */
    questionHeadTail?: TelegramDeliveryRuntimeDeps["questionHeadTail"];
    onQuestionAdmission?: TelegramDeliveryRuntimeDeps["onQuestionAdmission"];
    captureQuestionAuthority?: TelegramDeliveryRuntimeDeps["captureQuestionAuthority"];
    generation: string;
    getProfileName?: () => string | undefined;
    /** Private opt-in only; production leaves this unbound until the full Attachment privacy path is proved. */
    getAttachmentReceiverBotId?: (target: Readonly<TelegramDeliveryTarget>) => number | undefined;
    /** Missing/older receivers stay unavailable; a valid ID requires current local and peer collection/disposition readiness. */
    getTextInputReceiverBotId?: (target: Readonly<TelegramDeliveryTarget>) => number | undefined;
    captureDrain?: () => (() => void) | undefined;
    getTargetPolicyView: () => TelegramDeliveryTargetPolicyView;
    getActiveTurnTarget: () => TelegramDeliveryTarget | undefined;
    getActiveTurnIdentity?: () => object | undefined;
    captureArtifactSession?: () => (() => boolean) | undefined;
    isTransportActive?: () => boolean;
    api: Pick<TelegramBridgeApiRuntime, "sendMessage" | "editMessageText" | "deleteMessage" | "sendChatAction" | "captureArtifactTransport" | "captureAttachmentPublication">;
    recordOwnership: (input: {
        chatId: number;
        messageId: number;
        target: TelegramDeliveryTarget;
    }) => void;
    captureInputPublication?: (target: TelegramDeliveryTarget) => (messageId: number) => void;
    recordFailure?: TelegramDeliveryRuntimeDeps["recordFailure"];
}
/** @internal */
export declare function createTelegramDeliveryLifecycleHooks(createRuntime: () => TelegramDeliveryRuntime): {
    onSessionStart: () => Promise<void>;
    onSessionShutdown: () => Promise<void>;
    hasPendingTarget: (target: TelegramDeliveryTarget) => boolean | undefined;
} & TelegramDeliveryConfirmationPort & TelegramDeliveryChoicePort & TelegramDeliveryTaskViewPort;
export declare function createTelegramDeliveryGenerationSeed(instanceId: string): string;
/** @internal */
export declare function createTelegramBridgeDeliveryLifecycleHooks<TTransportStamp>(deps: Omit<TelegramBridgeDeliveryRuntimeDeps, "generation" | "isTransportActive"> & {
    generationSeed: string;
    getTransportStamp?: () => TTransportStamp;
    isTransportStampActive?: (stamp: TTransportStamp) => boolean;
    /** Local native transport lifetime, independent from coordinated-question or private-input readiness. */
    captureRuntimeAuthority?: () => (() => void) | undefined;
    /** Production falls back to independent questions when original publication authority is unavailable. */
    coordinateQuestionsWhenAuthorized?: true;
    onTransportRefreshFailure?: (error: unknown) => void;
}): ReturnType<typeof createTelegramDeliveryLifecycleHooks> & {
    onTransportChanged(): Promise<void>;
    requestTransportRefresh(): void;
};
/** @internal */
export interface TelegramDeliveryTargetPolicyView {
    canDeliver: boolean;
    ownsDirect: boolean;
    threaded?: boolean;
    allowedChatId?: number;
    followerTarget?: TelegramDeliveryTarget;
    leaderTarget?: TelegramDeliveryTarget;
    liveTargets?: readonly TelegramDeliveryTarget[];
}
/** @internal */
export interface TelegramDeliveryTargetPolicyRuntime {
    getTargetPolicyView(): TelegramDeliveryTargetPolicyView;
    getActiveTurnTarget(): TelegramDeliveryTarget | undefined;
}
/** @internal */
export declare function createTelegramDeliveryTargetPolicyRuntime(deps: {
    ownsDirect(): boolean;
    isThreadedMode?(): boolean;
    isFollowerRegistered(): boolean;
    getAllowedChatId(): number | undefined;
    getFollowerTarget(): TelegramDeliveryTarget | undefined;
    getLeaderTarget(): TelegramDeliveryTarget | undefined;
    listThreadRecords(): readonly {
        target: TelegramDeliveryTarget;
    }[];
    getActiveTurnTarget(): TelegramDeliveryTarget | undefined;
    getActiveGuestQueryId(): string | undefined;
}): TelegramDeliveryTargetPolicyRuntime;
/** @internal */
export declare function resolveTelegramDeliveryInstanceTarget(view: TelegramDeliveryTargetPolicyView): TelegramDeliveryTarget | undefined;
/** @internal */
export declare function resolveTelegramDeliveryAggregateTarget(view: TelegramDeliveryTargetPolicyView): TelegramDeliveryTarget | undefined;
/** @internal */
export declare function isTelegramDeliveryExplicitTargetAuthorized(candidate: TelegramDeliveryTarget, view: TelegramDeliveryTargetPolicyView): boolean;
/** @internal */
export declare function createTelegramDeliveryRuntime(deps: TelegramDeliveryRuntimeDeps): TelegramDeliveryRuntime;
/** @internal */
export declare function createTelegramBridgeDeliveryRuntime(deps: TelegramBridgeDeliveryRuntimeDeps): TelegramDeliveryRuntime;
/** One public operation resolves the current optional port and captures every binding, including equal-object rebinds. */
export declare function sendTelegramArtifact(raw: TelegramArtifactRequest): Promise<TelegramArtifactResult>;
/** @internal */
export declare function bindTelegramDeliveryRuntime(runtime: TelegramDeliveryRuntime): () => void;
/** @internal */
export declare function clearTelegramDeliveryRuntime(): void;
/** @internal Original native registry/runtime binding, captured once at group admission; never an ACK-time lookup. */
export declare function captureTelegramQuestionLifetimeOwner(): Readonly<TelegramQuestionLifetimeOwner> | undefined;
/** @internal */
export declare function isTelegramDeliveryHandleCurrent(handle: TelegramDeliveryHandle): boolean;
export declare function sendTelegramView(view: TelegramDeliveryView, options: SendTelegramViewOptions): Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
export declare function openTelegramTaskView(raw: TelegramTaskViewRequest): Promise<TelegramTaskViewOpenResult>;
/** @internal Reserved Attachment controls fail softly without a compatible receiver; never model input. */
export declare function acceptTelegramAttachmentQuestionCallback(query: TelegramDeliveryConfirmationCallback, assertAuthority?: () => void): TelegramAttachmentQuestionAcceptance;
/** @internal Reserved Task View controls never become model input, even in older bindings. */
export declare function acceptTelegramTaskViewCallback(query: TelegramDeliveryConfirmationCallback, assertAuthority?: () => void): ReturnType<TelegramDeliveryTaskViewPort["acceptTaskCancel"]>;
export declare function openTelegramChoice(request: TelegramChoiceRequest): Promise<TelegramChoiceOpenResult>;
/** @internal Marked SDK replies never fall back to an unversioned or absent collector. */
export declare function acceptTelegramTextInputReply(message: TelegramTextInputMessage, requestId: string, assertAuthority?: () => void, edited?: boolean): TelegramTextInputAcceptance;
/** @internal Status/cancel controls remain reserved even without a compatible runtime. */
export declare function acceptTelegramTextInputCallback(query: TelegramDeliveryConfirmationCallback, assertAuthority?: () => void): TelegramTextInputAcceptance;
/** @internal */
export declare function acceptTelegramChoiceCallback(query: TelegramDeliveryConfirmationCallback, assertAuthority?: () => void): TelegramDeliveryChoiceAcceptance;
export declare function openTelegramConfirm(request: TelegramConfirmRequest): Promise<TelegramConfirmOpenResult>;
/** @internal */
export declare function acceptTelegramConfirmationCallback(query: TelegramDeliveryConfirmationCallback, assertAuthority?: () => void): TelegramDeliveryConfirmationAcceptance;
export declare function editTelegramView(handle: TelegramDeliveryHandle, view: TelegramDeliveryView): Promise<TelegramDeliveryResult<TelegramDeliveryHandle>>;
export declare function deleteTelegramView(handle: TelegramDeliveryHandle): Promise<TelegramDeliveryResult<void>>;
export declare function sendTelegramChatAction(action: TelegramDeliveryChatAction, options: {
    scope: TelegramDeliveryScope;
}): Promise<TelegramDeliveryResult<void>>;
export {};
