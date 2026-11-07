/**
 * Telegram outbound button helpers
 * Zones: telegram outbound, assistant markup, callback routing
 * Owns assistant-authored telegram_button extraction, button action storage, callback handling, and prompt-turn construction
 */
import { type GenerativeAppCallbackOwner } from "./generative-apps.ts";
import { type TelegramQuestionLifetimeOwner } from "./delivery.ts";
import type { TelegramInlineKeyboardButtonStyle, TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import { type PendingTelegramTurn, type TelegramQueueTarget } from "./queue.ts";
type TelegramButtonRetirementReason = "deadline" | "capacity" | "consumed" | "owner-lost" | "publication-lost" | "clear" | "superseded" | "admission-failed";
export interface TelegramOutboundButtonBinding {
    assertCurrent?: () => void;
    generation: string;
    app: string;
    revision: number;
}
export interface TelegramOutboundButtonAction {
    text: string;
    prompt: string;
    /** Compiler-owned routing class; selection values never enter the bound-method parser. */
    promptKind?: "selection";
    /** Process-local finite collector; never serialized into a prompt or SDK result. */
    selection?: TelegramButtonSelectionAction;
    /** One structured question; ordinary prompt peers intentionally have no shared completion group. */
    completionGroup?: TelegramButtonCompletionGroup;
    /** Store-produced consumed callback IDs used only to retire the old keyboard. */
    completedCallbacks?: readonly string[];
    /** The publication owner, not a stale callback query, owns all visual retirement. */
    publicationManaged?: true;
    binding?: TelegramOutboundButtonBinding;
    selectedStyle?: TelegramInlineKeyboardButtonStyle;
    disabled?: true;
    /** Optional declaration deadline; enforced by the existing action store, without another timer. */
    expiresAt?: number;
}
/** @internal Exact native store dispatch origin, not invocation/result or footer-transition authority. */
export interface TelegramOrdinaryCallbackDispatch {
    readonly binding: TelegramOutboundButtonBinding;
    readonly prompt: string;
    readonly assertCurrent: () => void;
    readonly assertObservedCurrent: () => void;
    /** @internal One exact native invocation; not an effect executor. */
    readonly takeInvocation?: () => object | undefined;
    readonly captureReadOnlySuccessor?: (binding: unknown, invocation: unknown) => Readonly<GenerativeAppCallbackOwner> | undefined;
}
/** @internal Classifies original versus absent provenance, including spent/refused native origins. Grants no dispatch. */
export declare function hasTelegramOrdinaryCallbackOrigin(action: unknown): boolean;
/** @internal One attempt on the original resolved action/query; foreign actions are not probed. */
export declare function captureTelegramOrdinaryCallbackDispatch(action: unknown, query: unknown): Readonly<TelegramOrdinaryCallbackDispatch> | undefined;
interface TelegramButtonQuestionDeadline {
    readonly expiresAt: number;
    readonly bindStore: (notify: () => void) => void;
    readonly shorten: (expiresAt: number) => void;
}
/** @internal Native producer deadline; no answer, SDK membership or publication authority. */
export declare function createTelegramButtonQuestionDeadline(expiresAt: number): Readonly<TelegramButtonQuestionDeadline>;
interface TelegramButtonCompletionGroup {
    readonly deadline?: Readonly<TelegramButtonQuestionDeadline>;
    readonly retire?: (reason?: TelegramButtonRetirementReason) => void;
    readonly complete?: (callbackData: string) => void;
}
interface TelegramButtonSelectionAction {
    readonly owner: object;
    readonly revision: number;
    readonly requiresMessageUpdate?: boolean;
    readonly prepare: (query: TelegramButtonCallbackQuery) => TelegramButtonSelectionUpdate | undefined;
}
interface TelegramButtonSelectionUpdate {
    readonly replyMarkup: TelegramOutboundButtonMarkup;
    readonly message?: {
        readonly markdown: string;
        readonly rendering: "rich" | "html";
    };
    readonly prompt?: string;
    readonly assertCurrent: () => void;
    readonly commit: () => void;
    readonly fail: () => void;
}
export interface TelegramOutboundButtonStoredAction extends TelegramOutboundButtonAction {
    createdAt: number;
}
export type TelegramOutboundButtonMarkup = TelegramInlineKeyboardMarkup;
export interface TelegramButtonReplyPlan {
    markdown: string;
    replyMarkup?: TelegramOutboundButtonMarkup;
}
export type TelegramButtonPublicationObserver = (method: string, body: Readonly<Record<string, unknown>>) => (((result: unknown, succeeded: boolean, rejected?: boolean, nativeEditResult?: unknown) => void) & {
    ordinarySource?: "first-send" | "known-parent-edit";
    ready?: Promise<void>;
    prepareReplyMarkup?: () => unknown;
    prepareRichMessage?: () => unknown;
    assertPublicationBody?: (body: Readonly<Record<string, unknown>>) => void;
    restrictQuestionMembership?: (policy: "first-send" | "known-parent-edit" | "none") => void;
}) | undefined;
export interface TelegramButtonPublicationRichMessage {
    markdown: string;
    is_rtl?: boolean;
    skip_entity_detection?: boolean;
}
export type TelegramButtonPublicationEditor = (target: Readonly<{
    chatId: number;
    messageId: number;
    replyMarkup?: TelegramOutboundButtonMarkup;
    richMessage?: TelegramButtonPublicationRichMessage;
}>, assertCurrent: () => void) => Promise<void>;
export interface TelegramButtonActionStore {
    /** Private synchronous native SDK subscriber; not a public admission surface. */
    onQuestionAdmission?: (admission: unknown) => void;
    observeAppOwner?: (owner: Readonly<{
        app: string;
        generation: string;
        revision?: number;
        reset?: boolean;
    }>) => void;
    beginPublication?: TelegramButtonPublicationObserver;
    /** Private read-only first physical app/SDK parent snapshot; no refresh transition or membership grant. */
    capturePublicationSource?: (handle: Readonly<{
        target: Readonly<{
            chatId: number;
            threadId?: number;
        }>;
        messageIds: readonly number[];
    }>, binding: unknown) => Readonly<{
        assertCurrent: () => void;
    }> | undefined;
    bindPublicationEditor?: (editor: TelegramButtonPublicationEditor) => void;
    waitForPublicationIdle?: () => Promise<void>;
    clear?: () => void;
    /** @internal Optional main-side native result origin; never a method-routing binding. */
    register: (action: TelegramOutboundButtonAction, questionResultBinding?: unknown) => string;
    resolve: (callbackData: string | undefined, query?: TelegramButtonCallbackQuery) => TelegramOutboundButtonAction | undefined;
}
export interface TelegramButtonCallbackQuery {
    id: string;
    data?: string;
    message?: {
        message_id?: number;
        message_thread_id?: number;
        chat?: {
            id?: number;
        };
        reply_markup?: TelegramOutboundButtonMarkup;
    };
}
export interface TelegramButtonCallbackHandlerDeps<TContext = unknown> {
    resolveAction: (callbackData: string | undefined, query?: TelegramButtonCallbackQuery) => TelegramOutboundButtonAction | undefined;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    enqueueButtonPrompt: (query: TelegramButtonCallbackQuery, action: TelegramOutboundButtonAction, ctx: TContext) => boolean | void;
    invokeBoundAction?: (query: TelegramButtonCallbackQuery, action: TelegramOutboundButtonAction, ctx: TContext) => Promise<false | "new" | "edit">;
    updateSelectionMessage?: (query: TelegramButtonCallbackQuery, markdown: string, rendering: "rich" | "html", replyMarkup: TelegramOutboundButtonMarkup, assertCurrent: () => void) => Promise<void>;
    updateSelectionKeyboard?: (query: TelegramButtonCallbackQuery, replyMarkup: TelegramOutboundButtonMarkup, assertCurrent: () => void) => Promise<void>;
    editMessageReplyMarkup?: (chatId: number, messageId: number, replyMarkup: TelegramOutboundButtonMarkup) => Promise<void>;
}
export declare function createTelegramButtonActionStore(options?: {
    ttlMs?: number;
    /** Private native row-to-dispatch origin; no invocation, completion or consumed-edit grant. */
    ordinaryCallbackDispatch?: true | "qualified";
    /** Private one-row read-only transition with an unchanged complete original physical preimage. */
    ordinaryReadOnlyParent?: true;
    /** Private fully drained native HTML feedback projection, not legacy editor success. */
    ordinaryFeedbackParent?: true;
    /** Private whole Rich/keyboard projection through one original native text edit. */
    ordinaryRichFeedbackParent?: true;
    /** Private one queued original projection, fully drained by the native result ACK. */
    ordinaryQueuedFeedbackParent?: true;
    /** Private one native result ACK retained by its original still-running feedback editor. */
    ordinaryDeferredFeedbackParent?: true;
    /** Private one finite SDK admission while the original deferred editor still owns the result. */
    ordinaryDeferredSdkTail?: true;
    /** Original app origin at birth; independent mode keeps selection separate from SDK cohort eligibility. */
    questionAppOrigin?: true | "independent";
    /** Private one consumed read-only parent with a complete pure native question successor roster. */
    ordinaryQuestionParent?: true;
    /** Private one original retained group beside a fresh deferred read-only successor roster. */
    ordinaryRetainedQuestionParent?: true;
    captureSelectionAuthority?: () => (() => void) | undefined;
    recordFailure?: (error: unknown) => void;
    /** Original native question/publication membership, captured once at group birth. */
    captureQuestionLifetimeOwner?: () => Readonly<TelegramQuestionLifetimeOwner> | undefined;
    /** Private native app reader; omitted/foreign ordinary bindings stay outside coordinated membership. */
    captureOrdinaryBindingOwner?: (binding: unknown) => Readonly<GenerativeAppCallbackOwner> | undefined;
    recordRuntimeEvent?: (category: string, message: unknown, details?: Record<string, unknown>) => void;
}): TelegramButtonActionStore;
interface TelegramButtonPlannerDeps {
    /** Private omitted-deadline normalization only; not a shared-ownership or root activation grant. */
    questionHeadTail?: true;
    registerAction: (action: TelegramOutboundButtonAction) => string;
    binding?: TelegramOutboundButtonBinding;
    rendering?: "rich" | "html";
}
export declare function planTelegramButtonReply(markdown: string, deps: TelegramButtonPlannerDeps): TelegramButtonReplyPlan;
export declare function createTelegramButtonReplyPlanner(store: Pick<TelegramButtonActionStore, "register">, getRenderingMode?: () => "rich" | "html", questionHeadTail?: true): (markdown: string) => TelegramButtonReplyPlan;
export declare function createTelegramButtonPromptTurn(options: {
    chatId: number;
    replyToMessageId: number;
    queueOrder: number;
    action: TelegramOutboundButtonAction;
    target?: TelegramQueueTarget;
    telegramPrefix?: string;
}): PendingTelegramTurn;
export declare function markTelegramButtonSelected(replyMarkup: TelegramOutboundButtonMarkup, callbackData: string, selectedStyle?: TelegramInlineKeyboardButtonStyle): TelegramOutboundButtonMarkup | undefined;
export declare function handleTelegramButtonCallbackQuery<TContext = unknown>(query: TelegramButtonCallbackQuery, ctx: TContext, deps: TelegramButtonCallbackHandlerDeps<TContext>): Promise<boolean>;
export {};
