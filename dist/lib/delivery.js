/**
 * Telegram target-aware operational delivery and logical message lifecycle
 * Zones: telegram delivery, extension API, runtime binding
 * Owns the public extension delivery contract, authorized scope resolution, operational rendering adapter, per-target serialization, chunk reconciliation, generation-fenced logical handles, explicit confirmation/choice/text answer lifecycles, and process-local runtime membrane; composes the established reply renderer with bus-aware Telegram API ports and excludes bot clients, Pi contexts, and consumer-extension policy
 */
import { randomBytes } from "node:crypto";
import { readTelegramNativeTextSourceUse } from "./journal.js";
import { normalizeTelegramAttachmentRequestConstraints } from "./media.js";
import { captureTelegramArtifactSource, validateTelegramArtifactFile, TelegramArtifactSourceError } from "./outbound-attachments.js";
import { assertTelegramInlineKeyboardCallbackData, } from "./keyboard.js";
import { escapeHtml } from "./rendering.js";
import { isTelegramArtifactCaption, isWireRecord } from "./wire.js";
import { renderTelegramMessage, withTelegramReplyParameters, } from "./replies.js";
import { areTelegramTargetsEqual as areDeliveryTargetsEqual, getTelegramTargetThreadParams, } from "./target.js";
import { captureTelegramDrainObserver } from "./machine.js";
import { getTelegramApiRetryAfterMs, isRetryableTelegramApiError, isTelegramApiCommitUnknownError, isTelegramApiRequestRejected, TelegramApiCommitUnknownError, TelegramApiAuthorityError, isTelegramMessageUnavailableError, } from "./telegram-api.js";
const TELEGRAM_DELIVERY_RUNTIME_KEY = "__piTelegramDeliveryRuntime__";
class TelegramDeliveryTransportGenerationError extends Error {
    constructor() {
        super("Telegram Delivery transport generation is no longer active.");
        this.name = "TelegramDeliveryTransportGenerationError";
    }
}
function snapshotArtifactRequest(request) {
    if (!request || typeof request.owner !== "string" || !request.owner.trim() || !request.file)
        throw new TypeError("Invalid artifact declaration.");
    const owner = request.owner, path = request.file.path, name = request.file.name, caption = request.caption, timeoutMs = request.timeoutMs, signal = request.signal, scope = request.scope;
    validateTelegramArtifactFile(path, name);
    if (!scope || !["active-turn", "instance", "target"].includes(scope.kind) ||
        scope.kind === "target" && (!scope.target || !Number.isSafeInteger(scope.target.chatId) || scope.target.chatId <= 0 ||
            scope.target.threadId !== undefined && (!Number.isSafeInteger(scope.target.threadId) || scope.target.threadId <= 0)) ||
        caption !== undefined && !isTelegramArtifactCaption(caption) ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || !(signal instanceof AbortSignal))
        throw new TypeError("Invalid artifact declaration.");
    return { owner, file: { path, name }, caption, timeoutMs, signal, scope: scope.kind === "target" ? { kind: "target", target: cloneTarget(scope.target) } : { kind: scope.kind } };
}
const artifactFailure = (reason, effect = "not-issued", observedReceipt) => ({
    ok: false, reason, effect, message: "Telegram artifact delivery did not complete.", ...(observedReceipt ? { observedReceipt } : {}),
});
function taskViewUpdateFailure(attempted = false) {
    return { ok: false, reason: attempted ? "commit-unknown" : "stale-handle", effect: attempted ? "unknown" : "not-issued",
        message: attempted ? "Task View update may have committed." : "Task View is not updateable." };
}
function snapshotTaskViewState(value) {
    const status = value?.status, text = value?.text, progress = value?.progress;
    if (!["running", "completed", "failed", "cancelled"].includes(status) || typeof text !== "string" ||
        !text.trim() || !text.isWellFormed() || text.length > 2048 ||
        progress !== undefined && (!Number.isFinite(progress) || progress < 0 || progress > 1))
        throw new TypeError("Task View requires a valid status, plain text up to 2048 characters and optional progress from 0 to 1.");
    return Object.freeze({ status, text, ...(progress === undefined ? {} : { progress }) });
}
function snapshotTaskViewRequest(value) {
    const owner = value?.owner, title = value?.title, timeoutMs = value?.timeoutMs, signal = value?.signal, scope = value?.scope, cancellable = value?.cancellable === undefined ? false : value.cancellable, cancelLabel = value?.cancelLabel === undefined ? "❌ Request cancel" : value.cancelLabel;
    if (typeof owner !== "string" || !owner.trim() || owner.length > 256 || typeof title !== "string" || !title.trim() ||
        !title.isWellFormed() || title.length > 128 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 ||
        !(signal instanceof AbortSignal) || typeof cancellable !== "boolean" || typeof cancelLabel !== "string" ||
        !cancelLabel.trim() || !cancelLabel.isWellFormed() || cancelLabel.length > 64 || !scope ||
        !["active-turn", "instance", "target"].includes(scope.kind) || scope.kind === "target" &&
        (!Number.isSafeInteger(scope.target?.chatId) || scope.target.chatId <= 0 || scope.target.threadId !== undefined &&
            (!Number.isSafeInteger(scope.target.threadId) || scope.target.threadId <= 0)))
        throw new TypeError("Invalid Task View declaration.");
    return { owner, title, timeoutMs, signal, cancellable, cancelLabel, state: snapshotTaskViewState(value.state),
        scope: scope.kind === "target" ? { kind: "target", target: Object.freeze(cloneTarget(scope.target)) } : { kind: scope.kind } };
}
function hasTextControlCharacter(value) { return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value); }
/** Shared exact-Reply and Source-bound answer validity; not a policy for media, commands or Source selection. */
function isValidTextInputAnswer(text, maxLength, multiline) {
    return text.trim() !== "" && text.length <= maxLength && text.isWellFormed() && !hasTextControlCharacter(text) &&
        (multiline || !/[\r\n\u2028\u2029]/u.test(text));
}
function snapshotAttachmentQuestion(raw) {
    const { owner, question, cancelLabel, timeoutMs, signal } = raw;
    if ([owner, question, cancelLabel].some((value, i) => typeof value !== "string" || !value.trim() ||
        !value.isWellFormed() || value.length > [256, 1024, 64][i] || hasTextControlCharacter(value)) ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 || !(signal instanceof AbortSignal))
        throw new TypeError("Invalid Attachment question declaration.");
    const maxFiles = raw.maxFiles === undefined ? 1 : raw.maxFiles;
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 10)
        throw new TypeError("Invalid Attachment file count.");
    const { accept, maxBytes } = normalizeTelegramAttachmentRequestConstraints({
        accept: raw.accept === undefined ? ["*/*"] : raw.accept, maxBytes: raw.maxBytes === undefined ? 10_485_760 : raw.maxBytes
    });
    const scope = raw.scope?.kind === "target" ? Object.freeze({ kind: "target", target: Object.freeze(cloneTarget(raw.scope.target)) })
        : Object.freeze({ kind: raw.scope?.kind });
    return Object.freeze({ owner, question, cancelLabel, timeoutMs, signal, scope, accept, maxFiles, maxBytes });
}
/** @internal Exact SDK control shape; a publication hint, never a receiver or action grant. */
export function getTelegramTextInputControlId(replyMarkup) {
    return getPrivateInputControlId(replyMarkup, "tginput");
}
/** @internal Exact control hint only; never receiver or source authority. */
export function getTelegramAttachmentControlId(replyMarkup) {
    return getPrivateInputControlId(replyMarkup, "tgattach");
}
function getPrivateInputControlId(replyMarkup, prefix) {
    if (!isWireRecord(replyMarkup) || !Array.isArray(replyMarkup.inline_keyboard) || replyMarkup.inline_keyboard.length !== 1)
        return undefined;
    const row = replyMarkup.inline_keyboard[0];
    if (!Array.isArray(row) || row.length !== 1 || !isWireRecord(row[0]) || typeof row[0].text !== "string" || !row[0].text.trim() ||
        typeof row[0].callback_data !== "string" || row[0].disabled !== undefined)
        return undefined;
    return (prefix === "tginput" ? /^tginput:([a-f0-9]{32}):cancel$/u : /^tgattach:([a-f0-9]{32}):cancel$/u).exec(row[0].callback_data)?.[1];
}
/** @internal A side-effect-free receiver query reports its configured bot only while the whole private-input path is ready. */
export function readTelegramTextInputReceiverBotId(read, target) {
    try {
        const botId = read?.(Object.freeze(cloneTarget(target)));
        return Number.isSafeInteger(botId) && botId > 0 ? botId : undefined;
    }
    catch {
        return undefined;
    }
}
/** @internal Only an original message from the configured bot can label an SDK reply. */
export function readTelegramTextInputReplySource(message, botId) {
    return readPrivateInputReplySource(message, botId, "text");
}
/** @internal Configured-own-bot hints only, independent of content/file validation and receiver lifetime. */
export function readTelegramAttachmentReplySource(message, botId) {
    return readPrivateInputReplySource(message, botId, "attachment");
}
function readPrivateInputReplySource(message, botId, kind) {
    if (!Number.isSafeInteger(botId) || botId <= 0 || !isWireRecord(message))
        return undefined;
    const reply = message.reply_to_message;
    if (!isWireRecord(reply) || !isWireRecord(reply.from) || reply.from.id !== botId || reply.from.is_bot !== true ||
        !isWireRecord(reply.reply_markup) || !Array.isArray(reply.reply_markup.inline_keyboard))
        return undefined;
    const rows = reply.reply_markup.inline_keyboard;
    // Real SDK input messages have one control; bounded scanning also refuses malformed reserved controls.
    const prefix = kind === "text" ? "tginput:" : "tgattach:", otherPrefix = kind === "text" ? "tgattach:" : "tginput:";
    let privateControl = false, mixed = false, requestId, controls = 0;
    for (const row of rows.slice(0, 65)) {
        if (!Array.isArray(row))
            continue;
        for (const button of row.slice(0, 8)) {
            if (!isWireRecord(button) || typeof button.callback_data !== "string")
                continue;
            if (button.callback_data.startsWith(otherPrefix))
                mixed = true;
            if (!button.callback_data.startsWith(prefix))
                continue;
            privateControl = true;
            controls++;
            requestId = (kind === "text" ? /^tginput:([a-f0-9]{32}):cancel$/u : /^tgattach:([a-f0-9]{32}):cancel$/u).exec(button.callback_data)?.[1];
        }
    }
    if (!privateControl)
        return undefined;
    if (mixed || controls !== 1 || rows.length !== 1 || !Array.isArray(rows[0]) || rows[0].length !== 1 || !requestId ||
        !Number.isSafeInteger(reply.message_id) || reply.message_id <= 0 ||
        !isWireRecord(reply.chat) || reply.chat.type !== "private" || !Number.isSafeInteger(reply.chat.id) ||
        reply.chat.id <= 0 ||
        (reply.message_thread_id !== undefined && (!Number.isSafeInteger(reply.message_thread_id) || reply.message_thread_id <= 0)) ||
        ["business_connection_id", "guest_query_id", "ephemeral_message_id"].some(key => Reflect.has(reply, key) || Reflect.has(message, key))) {
        return Object.freeze({ kind: "unavailable" });
    }
    return Object.freeze({ kind, requestId, messageId: reply.message_id, target: Object.freeze({
            chatId: reply.chat.id, ...(reply.message_thread_id !== undefined ? { threadId: reply.message_thread_id } : {}),
        }) });
}
const TEXT_INPUT_NON_USE_KEY = Symbol("native Text Input non-use");
class NativeTextInputNonUse {
    reason;
    assertCurrent;
    #identity;
    #assert;
    constructor(key, identity, guard) {
        if (key !== TEXT_INPUT_NON_USE_KEY)
            throw new TelegramDeliveryTransportGenerationError();
        this.reason = identity.reason;
        this.assertCurrent = guard;
        this.#identity = identity;
        this.#assert = guard;
        Object.freeze(this);
    }
    static read(value) {
        value.#assert();
        return value.#identity;
    }
}
const TEXT_INPUT_SOURCE_USE_KEY = Symbol("native Text Input physical-source use");
const textSourceUseDate = Date, textSourceUseNow = Date.now, textSourceUseFreeze = Object.freeze, textSourceUseAssign = Object.assign;
const textSourceUseDescriptor = Object.getOwnPropertyDescriptor, textSourceUseApply = Reflect.apply, textSourceUseMapGet = Map.prototype.get;
const textSourceUseData = (value, key) => {
    const descriptor = textSourceUseDescriptor(value, key);
    return descriptor && textSourceUseDescriptor(descriptor, "value")?.value;
};
class NativeTextInputSourceUse {
    #fact;
    #cleanup;
    constructor(key, fact, cleanup) {
        if (key !== TEXT_INPUT_SOURCE_USE_KEY)
            throw new TelegramDeliveryTransportGenerationError();
        textSourceUseAssign(this, fact);
        this.#fact = fact;
        this.#cleanup = cleanup;
        textSourceUseFreeze(this);
    }
    static read(value) { return value.#fact; }
    static drain(value) {
        const cleanup = value.#cleanup;
        value.#cleanup = undefined;
        cleanup?.();
    }
}
const readNativeSourceUseInput = readTelegramNativeTextSourceUse;
const TEXT_INPUT_SELECTION_KEY = Symbol("native Text Input selection");
class NativeTextInputSourceSelection {
    #runtime;
    #capture;
    #lost = false;
    #submit;
    constructor(key, runtime, capture, selection, submit) {
        if (key !== TEXT_INPUT_SELECTION_KEY)
            throw new TelegramDeliveryTransportGenerationError();
        Object.assign(this, selection);
        this.#runtime = runtime;
        this.#capture = capture;
        this.#submit = submit;
        Object.freeze(this);
    }
    static origin(value, runtime) {
        if (value.#runtime !== runtime)
            throw new TelegramDeliveryTransportGenerationError();
        if (value.#lost || Object.getOwnPropertyDescriptor(runtime, "captureTextInputSource")?.value !== value.#capture) {
            value.#lost = true;
            throw new TelegramDeliveryTransportGenerationError();
        }
        return value;
    }
    static submit(value, runtime, source) {
        if (value.#runtime !== runtime)
            throw new TelegramDeliveryTransportGenerationError();
        try {
            if (value.#lost || Object.getOwnPropertyDescriptor(runtime, "captureTextInputSource")?.value !== value.#capture)
                throw new TelegramDeliveryTransportGenerationError();
            return value.#submit(source);
        }
        catch (error) {
            value.#lost = true;
            throw error;
        }
    }
    static read(value, runtime) {
        if (value.#runtime !== runtime)
            throw new TelegramDeliveryTransportGenerationError();
        const current = () => !value.#lost && Object.getOwnPropertyDescriptor(runtime, "captureTextInputSource")?.value === value.#capture;
        try {
            if (!current())
                throw new TelegramDeliveryTransportGenerationError();
            value.assertCurrent();
            if (!current())
                throw new TelegramDeliveryTransportGenerationError();
            return value;
        }
        catch (error) {
            value.#lost = true;
            throw error;
        }
    }
}
const TELEGRAM_QUESTION_HEAD_MS = 86_400_000;
/** @internal Shared private question policy; not an authoring or SDK result surface. */
export const TELEGRAM_QUESTION_TAIL_MS = 3_600_000;
function transitionTelegramQuestion(phase, event) {
    if (phase !== "opening" && phase !== "waiting")
        return phase;
    if (event.kind === "published")
        return "waiting";
    if (event.status === "confirmed" || event.status === "selected" || event.status === "submitted" || event.status === "cancelled") {
        if (phase === "opening")
            return phase;
        if (event.expired)
            return "expired";
    }
    return event.status;
}
const QUESTION_ADMISSION_KEY = Symbol("native question admission");
class NativeQuestionAdmission {
    #facts;
    target;
    at;
    constructor(key, target, at, facts) {
        if (key !== QUESTION_ADMISSION_KEY)
            throw new Error("Question admission is unavailable.");
        this.#facts = facts;
        this.target = Object.freeze(cloneTarget(target));
        this.at = at;
        Object.freeze(this);
    }
    static read(value) { return { ...value.#facts, target: value.target, at: value.at }; }
}
const readNativeQuestionAdmission = NativeQuestionAdmission.read;
const QUESTION_LIFETIME_SCOPE_KEY = Symbol("native question lifetime scope");
class NativeQuestionLifetimeScope {
    #facts;
    constructor(key, facts) {
        if (key !== QUESTION_LIFETIME_SCOPE_KEY)
            throw new Error("Question lifetime scope is unavailable.");
        this.#facts = facts;
        Object.freeze(this);
    }
    static read(value) { return { ...value.#facts }; }
}
const readNativeQuestionLifetimeScope = NativeQuestionLifetimeScope.read;
function captureTelegramBridgeQuestionPolicy(deps) {
    const questionHeadTail = deps.questionHeadTail;
    if (questionHeadTail !== undefined && questionHeadTail !== true)
        throw new TypeError("Question head/tail policy must be true or omitted.");
    if (!questionHeadTail)
        return { questionHeadTail };
    const observer = deps.onQuestionAdmission, capture = deps.captureQuestionAuthority;
    if (observer !== undefined && typeof observer !== "function")
        throw new TypeError("Question admission observer must be a function or omitted.");
    if (capture !== undefined && typeof capture !== "function")
        throw new TypeError("Question authority capture must be a function or omitted.");
    return { questionHeadTail, onQuestionAdmission: observer && (admission => observer.call(deps, admission)),
        captureQuestionAuthority: capture ? () => capture.call(deps) : () => undefined };
}
/** @internal */
export function createTelegramDeliveryLifecycleHooks(createRuntime) {
    let runtime;
    let unbind;
    const stopCurrentRuntime = () => {
        unbind?.();
        unbind = undefined;
        runtime?.shutdown();
        runtime = undefined;
    };
    return {
        hasPendingTarget: (target) => runtime?.hasPendingTarget?.(target),
        openTaskView: (request, current) => runtime?.openTaskView?.(request, current) ??
            Promise.resolve({ ok: false, reason: "runtime-unavailable", effect: "not-issued", message: "Task View runtime is unavailable." }),
        acceptTaskCancel: (query, authority) => runtime?.acceptTaskCancel?.(query, authority) ??
            (query.data?.startsWith("tgtask:") ? { handled: true, accepted: false } : { handled: false }),
        openChoice: request => runtime?.openChoice?.(request) ??
            Promise.resolve({ ok: false, reason: "runtime-unavailable", message: "Choice runtime is unavailable." }),
        acceptChoice: (query, assertAuthority) => runtime?.acceptChoice?.(query, assertAuthority) ??
            (query.data?.startsWith("tgchoice:") ? { handled: true, accepted: false } : { handled: false }),
        openConfirmation: (request, owned) => runtime?.openConfirmation?.(request, owned) ??
            Promise.resolve({ ok: false, reason: "runtime-unavailable", message: "Confirmation runtime is unavailable." }),
        acceptConfirmation: (query, assertAuthority) => runtime?.acceptConfirmation?.(query, assertAuthority) ??
            (query.data?.startsWith("tgconfirm:") ? { handled: true, accepted: false } : { handled: false }),
        onSessionStart: async () => {
            stopCurrentRuntime();
            runtime = createRuntime();
            unbind = bindTelegramDeliveryRuntime(runtime);
        },
        onSessionShutdown: async () => {
            stopCurrentRuntime();
        },
    };
}
export function createTelegramDeliveryGenerationSeed(instanceId) {
    return `${instanceId}:${Date.now()}`;
}
/** @internal */
export function createTelegramBridgeDeliveryLifecycleHooks(deps) {
    const questionPolicy = captureTelegramBridgeQuestionPolicy(deps);
    const captureRuntimeAuthority = deps.captureRuntimeAuthority, onTransportRefreshFailure = deps.onTransportRefreshFailure;
    const coordinateWhenAuthorized = deps.coordinateQuestionsWhenAuthorized;
    if (captureRuntimeAuthority !== undefined && typeof captureRuntimeAuthority !== "function")
        throw new TypeError("Delivery runtime authority capture must be a function or omitted.");
    if (coordinateWhenAuthorized !== undefined && (coordinateWhenAuthorized !== true || !questionPolicy.questionHeadTail || !questionPolicy.captureQuestionAuthority || !captureRuntimeAuthority))
        throw new TypeError("Conditional question coordination requires original question and native runtime captures.");
    let generationSequence = 0, sessionActive = false;
    let runtimeAuthority, runtimeStamp, questionAuthority;
    let preparedAuthority, preparedQuestionAuthority;
    const current = (guard) => {
        if (!guard)
            return false;
        try {
            const observed = guard();
            if (observed === undefined)
                return true;
            void Promise.resolve(observed).catch(() => { });
        }
        catch { /* A failed original scope cannot be revived by a new capture. */ }
        return false;
    };
    const captureQuestion = () => {
        const value = questionPolicy.captureQuestionAuthority?.();
        if (value !== undefined && typeof value !== "function") {
            void Promise.resolve(value).catch(() => { });
            throw new TypeError("Question publication authority must be a native guard or unavailable.");
        }
        return value;
    };
    const captureAuthority = () => {
        const value = captureRuntimeAuthority?.();
        if (value !== undefined && typeof value !== "function") {
            void Promise.resolve(value).catch(() => { });
            throw new TypeError("Delivery runtime authority must be a native guard or unavailable.");
        }
        return value;
    };
    const hooks = createTelegramDeliveryLifecycleHooks(() => {
        runtimeAuthority = preparedAuthority ? preparedAuthority.value : captureAuthority();
        preparedAuthority = undefined;
        questionAuthority = coordinateWhenAuthorized ? preparedQuestionAuthority ? preparedQuestionAuthority.value : runtimeAuthority ? captureQuestion() : undefined : undefined;
        preparedQuestionAuthority = undefined;
        // Pin this generation's provider rather than a future runtime's mutable capture.
        const originalQuestionAuthority = questionAuthority;
        const policy = coordinateWhenAuthorized
            ? originalQuestionAuthority ? { ...questionPolicy, captureQuestionAuthority: () => originalQuestionAuthority } : {}
            : questionPolicy;
        const transportStamp = deps.getTransportStamp?.();
        runtimeStamp = transportStamp;
        // Preserve ordinary per-generation dependency reads without re-reading pinned private policy getters.
        const remaining = {};
        for (const key of Reflect.ownKeys(deps)) {
            if (key === "questionHeadTail" || key === "onQuestionAdmission" || key === "captureQuestionAuthority" || key === "captureRuntimeAuthority" || key === "onTransportRefreshFailure" || key === "coordinateQuestionsWhenAuthorized" ||
                !Object.getOwnPropertyDescriptor(deps, key)?.enumerable)
                continue;
            Object.defineProperty(remaining, key, { value: Reflect.get(deps, key), enumerable: true });
        }
        return createTelegramBridgeDeliveryRuntime({
            ...remaining, ...policy,
            generation: `${deps.generationSeed}:${++generationSequence}`,
            isTransportActive: transportStamp !== undefined && deps.isTransportStampActive
                ? () => deps.isTransportStampActive?.(transportStamp) ?? false
                : undefined,
        });
    });
    const lifecycle = {
        ...hooks,
        async onSessionStart() {
            sessionActive = true;
            preparedAuthority = undefined;
            preparedQuestionAuthority = undefined;
            try {
                await hooks.onSessionStart();
            }
            catch (error) {
                sessionActive = false;
                runtimeAuthority = undefined;
                questionAuthority = undefined;
                runtimeStamp = undefined;
                throw error;
            }
        },
        async onSessionShutdown() {
            sessionActive = false;
            runtimeAuthority = undefined;
            questionAuthority = undefined;
            runtimeStamp = undefined;
            preparedAuthority = undefined;
            preparedQuestionAuthority = undefined;
            await hooks.onSessionShutdown();
        },
        async onTransportChanged() {
            if (!sessionActive)
                return;
            if (!captureRuntimeAuthority) {
                await hooks.onSessionStart();
                return;
            }
            const stampCurrent = runtimeStamp === undefined || deps.isTransportStampActive?.(runtimeStamp) !== false;
            const runtimeCurrent = current(runtimeAuthority) && stampCurrent;
            if (runtimeCurrent && (!coordinateWhenAuthorized || current(questionAuthority)))
                return;
            let next, nextQuestion;
            try {
                next = runtimeCurrent ? runtimeAuthority : captureAuthority();
                nextQuestion = coordinateWhenAuthorized && next ? captureQuestion() : undefined;
            }
            catch (error) {
                runtimeAuthority = undefined;
                questionAuthority = undefined;
                runtimeStamp = undefined;
                await hooks.onSessionShutdown();
                throw error;
            }
            if (stampCurrent && (runtimeCurrent || !runtimeAuthority && !next) && !questionAuthority && !nextQuestion)
                return;
            preparedAuthority = { value: next };
            preparedQuestionAuthority = { value: nextQuestion };
            try {
                await hooks.onSessionStart();
            }
            catch (error) {
                runtimeAuthority = undefined;
                questionAuthority = undefined;
                runtimeStamp = undefined;
                throw error;
            }
            finally {
                preparedAuthority = undefined;
                preparedQuestionAuthority = undefined;
            }
        },
    };
    return {
        ...lifecycle,
        requestTransportRefresh() {
            void lifecycle.onTransportChanged().catch(error => {
                try {
                    const reported = onTransportRefreshFailure?.(error);
                    if (reported)
                        void Promise.resolve(reported).catch(() => { });
                }
                catch { /* Diagnostics cannot reject a detached lifecycle notification. */ }
            });
        },
    };
}
class NativeDeliveryRuntimeRegistry {
    runtime;
    binding;
    #native = true;
    static read(value) { if (!value.#native)
        throw new Error("Question binding is unavailable."); return value; }
}
const readNativeDeliveryRuntimeRegistry = NativeDeliveryRuntimeRegistry.read;
const QUESTION_BINDING_KEY = Symbol("native question runtime binding");
class NativeQuestionRuntimeBinding {
    #facts;
    constructor(key, registry, runtime) {
        if (key !== QUESTION_BINDING_KEY)
            throw new Error("Question binding is unavailable.");
        this.#facts = { registry, runtime, binding: this, capture: Object.getOwnPropertyDescriptor(runtime, "captureQuestionLifetimeOwner")?.value, active: true };
        Object.freeze(this);
    }
    static read(key, value) {
        if (key !== QUESTION_BINDING_KEY)
            throw new Error("Question binding is unavailable.");
        return value.#facts;
    }
}
const nativeQuestionBindingReader = NativeQuestionRuntimeBinding.read;
const readNativeQuestionBinding = (value) => nativeQuestionBindingReader(QUESTION_BINDING_KEY, value);
function questionBindingCurrent(facts) {
    // Native objects plus own data descriptors: final-use checks must never invoke dependency getters.
    if (facts.active && (Object.getOwnPropertyDescriptor(globalThis, TELEGRAM_DELIVERY_RUNTIME_KEY)?.value !== facts.registry ||
        Object.getOwnPropertyDescriptor(facts.registry, "runtime")?.value !== facts.runtime ||
        Object.getOwnPropertyDescriptor(facts.registry, "binding")?.value !== facts.binding ||
        Object.getOwnPropertyDescriptor(facts.runtime, "captureQuestionLifetimeOwner")?.value !== facts.capture))
        facts.active = false;
    return facts.active;
}
function currentQuestionBinding(runtime) {
    try {
        const registry = readNativeDeliveryRuntimeRegistry(Object.getOwnPropertyDescriptor(globalThis, TELEGRAM_DELIVERY_RUNTIME_KEY)?.value);
        const binding = Object.getOwnPropertyDescriptor(registry, "binding")?.value;
        const facts = readNativeQuestionBinding(binding);
        return (!runtime || facts.runtime === runtime) && questionBindingCurrent(facts) ? { registry, binding, facts } : undefined;
    }
    catch {
        return undefined;
    }
}
function retireQuestionBinding(binding) {
    try {
        readNativeQuestionBinding(binding).active = false;
    }
    catch { /* Legacy bindings confer no native question certificate. */ }
}
function getTelegramDeliveryRuntimeRegistry() {
    const globals = globalThis;
    const existing = globals[TELEGRAM_DELIVERY_RUNTIME_KEY];
    if (existing && typeof existing === "object" && "runtime" in existing) {
        return existing;
    }
    const registry = new NativeDeliveryRuntimeRegistry();
    globals[TELEGRAM_DELIVERY_RUNTIME_KEY] = registry;
    return registry;
}
function failure(reason, message, partial, retryAfterMs) {
    const retry = retryAfterMs === undefined ? {} : { retryAfterMs };
    return partial === undefined
        ? { ok: false, reason, message, ...retry }
        : { ok: false, reason, message, partial, ...retry };
}
function classifyTelegramDeliveryTransportError(error) {
    if (isTelegramApiCommitUnknownError(error))
        return { reason: "commit-unknown" };
    if (isTelegramMessageUnavailableError(error))
        return { reason: "message-unavailable" };
    const retryAfterMs = getTelegramApiRetryAfterMs(error);
    if (retryAfterMs !== undefined)
        return { reason: "rate-limited", retryAfterMs };
    if (isRetryableTelegramApiError(error))
        return { reason: "transport-retryable" };
    return { reason: "transport-failed" };
}
/** @internal */
export function createTelegramDeliveryTargetPolicyRuntime(deps) {
    return {
        getTargetPolicyView() {
            const ownsDirect = deps.ownsDirect();
            return {
                canDeliver: ownsDirect || deps.isFollowerRegistered(),
                ownsDirect,
                threaded: deps.isThreadedMode?.() === true,
                allowedChatId: deps.getAllowedChatId(),
                followerTarget: deps.getFollowerTarget(),
                leaderTarget: deps.getLeaderTarget(),
                liveTargets: deps.listThreadRecords().map((record) => record.target),
            };
        },
        getActiveTurnTarget() {
            return deps.getActiveGuestQueryId()
                ? undefined
                : deps.getActiveTurnTarget();
        },
    };
}
function isThreadedDelivery(view) {
    return view.threaded === true || view.followerTarget?.threadId !== undefined || view.leaderTarget?.threadId !== undefined;
}
/** @internal */
export function resolveTelegramDeliveryInstanceTarget(view) {
    if (!view.canDeliver)
        return undefined;
    const target = view.followerTarget ?? view.leaderTarget ??
        (view.allowedChatId === undefined ? undefined : { chatId: view.allowedChatId });
    return target && (!isThreadedDelivery(view) || target.threadId !== undefined) ? target : undefined;
}
/** @internal */
export function resolveTelegramDeliveryAggregateTarget(view) {
    return !view.canDeliver || view.allowedChatId === undefined || isThreadedDelivery(view)
        ? undefined
        : { chatId: view.allowedChatId };
}
/** @internal */
export function isTelegramDeliveryExplicitTargetAuthorized(candidate, view) {
    if (!view.canDeliver ||
        view.allowedChatId === undefined ||
        candidate.chatId !== view.allowedChatId) {
        return false;
    }
    if (candidate.threadId === undefined)
        return !isThreadedDelivery(view);
    if (view.followerTarget) {
        return areDeliveryTargetsEqual(candidate, view.followerTarget);
    }
    if (!view.ownsDirect)
        return false;
    if (view.leaderTarget &&
        areDeliveryTargetsEqual(candidate, view.leaderTarget)) {
        return true;
    }
    return (view.liveTargets ?? []).some(function (target) {
        return areDeliveryTargetsEqual(candidate, target);
    });
}
function cloneTarget(target) {
    return target.threadId === undefined
        ? { chatId: target.chatId }
        : { chatId: target.chatId, threadId: target.threadId };
}
function targetKey(target) {
    return `${target.chatId}:${target.threadId ?? "root"}`;
}
function resolveTelegramDeliveryTarget(scope, deps) {
    if (scope.kind === "target") {
        if (!deps.isExplicitTargetAuthorized(scope.target)) {
            return failure("target-unauthorized", "Telegram delivery target is not authorized for this runtime.");
        }
        return { ok: true, value: cloneTarget(scope.target) };
    }
    const target = scope.kind === "active-turn"
        ? deps.getActiveTurnTarget()
        : scope.kind === "instance"
            ? deps.getInstanceTarget()
            : deps.getAggregateTarget();
    if (!target) {
        return failure("target-unavailable", `Telegram delivery ${scope.kind} target is unavailable.`);
    }
    return { ok: true, value: cloneTarget(target) };
}
function createTelegramDeliveryTargetQueue(captureDrain) {
    const queues = new Map();
    async function run(target, operation) {
        const key = targetKey(target);
        const notifyDrained = captureTelegramDrainObserver(captureDrain);
        const previous = queues.get(key) ?? Promise.resolve();
        const current = previous.then(operation, operation);
        const settled = current.then(() => { }, () => { });
        queues.set(key, settled);
        try {
            return await current;
        }
        finally {
            if (queues.get(key) === settled) {
                queues.delete(key);
                notifyDrained();
            }
        }
    }
    return {
        run,
        hasPendingTarget: (target) => queues.has(targetKey(target)),
    };
}
function getChunkTransportOptions(view, index, chunkCount, replyToMessageId, editing = false) {
    const isFirst = index === 0;
    const isLast = index === chunkCount - 1;
    return {
        ...(isFirst && replyToMessageId !== undefined ? { replyToMessageId } : {}),
        ...(isLast
            ? { replyMarkup: view.replyMarkup ?? (editing ? null : undefined) }
            : editing
                ? { replyMarkup: null }
                : {}),
    };
}
/** @internal */
export function createTelegramDeliveryRuntime(deps) {
    const questionHeadTail = deps.questionHeadTail;
    if (questionHeadTail !== undefined && questionHeadTail !== true)
        throw new TypeError("Question head/tail policy must be true or omitted.");
    const onQuestionAdmission = questionHeadTail ? deps.onQuestionAdmission : undefined;
    if (onQuestionAdmission !== undefined && typeof onQuestionAdmission !== "function")
        throw new TypeError("Question admission observer must be a function or omitted.");
    const captureQuestionAuthority = questionHeadTail ? deps.captureQuestionAuthority : undefined;
    if (captureQuestionAuthority !== undefined && typeof captureQuestionAuthority !== "function")
        throw new TypeError("Question authority capture must be a function or omitted.");
    let questionProviderAttempted = false, questionProviderLost = false, questionProviderChecking = false;
    let originalQuestionAuthority;
    const assertQuestionProvider = () => {
        if (!captureQuestionAuthority)
            return;
        if (questionProviderLost || questionProviderChecking) {
            questionProviderLost = true;
            throw new Error("Question original provider is unavailable.");
        }
        questionProviderChecking = true;
        try {
            if (!questionProviderAttempted) {
                questionProviderAttempted = true;
                const captured = captureQuestionAuthority.call(deps);
                if (typeof captured !== "function") {
                    if (captured !== undefined)
                        void Promise.resolve(captured).catch(() => { });
                    throw new Error("Question original provider is unavailable.");
                }
                originalQuestionAuthority = captured;
            }
            const returned = originalQuestionAuthority();
            if (returned !== undefined) {
                void Promise.resolve(returned).catch(() => { });
                throw new Error("Question original provider is unavailable.");
            }
            if (questionProviderLost)
                throw new Error("Question original provider is unavailable.");
        }
        catch {
            questionProviderLost = true;
            throw new Error("Question original provider is unavailable.");
        }
        finally {
            questionProviderChecking = false;
        }
    };
    const questionLifetimeRuntime = Object.freeze({});
    let active = true;
    let artifactBusy = false;
    const artifactTargets = new Map();
    const getInputReceiverBotId = deps.getTextInputReceiverBotId, getInputReceiverTarget = deps.getInstanceTarget;
    const questions = new Map();
    const sourceAuthority = deps.getConfirmationAuthority, sourceAuthorize = deps.isExplicitTargetAuthorized, sourceGeneration = deps.generation;
    const questionLifetimePortsCurrent = () => active && !questionProviderLost && deps.generation === sourceGeneration && deps.getConfirmationAuthority === sourceAuthority &&
        deps.isExplicitTargetAuthorized === sourceAuthorize;
    let inputSourceObservation;
    let questionOwnerObservation;
    const readInputReceiverTarget = () => {
        let target;
        try {
            if (deps.getInstanceTarget === getInputReceiverTarget) {
                const current = getInputReceiverTarget.call(deps);
                if (current)
                    target = cloneTarget(current);
            }
            if (deps.getInstanceTarget !== getInputReceiverTarget)
                target = undefined;
        }
        catch {
            target = undefined;
        }
        // A later equal address cannot revive an Input whose original receiver scope was observed lost.
        for (const entry of questions.values())
            if (entry.kind === "text" && (!target || !areDeliveryTargetsEqual(entry.handle.target, target)))
                entry.receiverTargetLost = true;
        return target;
    };
    const inputReceiverTargetCurrent = (entry) => {
        if (entry.receiverTargetLost || entry.observingReceiverTarget) {
            entry.receiverTargetLost = true;
            return false;
        }
        entry.observingReceiverTarget = true;
        try {
            const target = readInputReceiverTarget();
            if (!target || entry.receiverTargetLost || !areDeliveryTargetsEqual(entry.handle.target, target)) {
                entry.receiverTargetLost = true;
                return false;
            }
            return true;
        }
        finally {
            entry.observingReceiverTarget = false;
        }
    };
    const getAttachmentBotId = deps.getAttachmentReceiverBotId, publishAttachment = deps.publishAttachmentQuestion;
    const attachmentAuthority = deps.getConfirmationAuthority, attachmentAuthorize = deps.isExplicitTargetAuthorized;
    const attachmentPortsCurrent = () => !!getAttachmentBotId && !!publishAttachment &&
        deps.getAttachmentReceiverBotId === getAttachmentBotId && deps.publishAttachmentQuestion === publishAttachment &&
        deps.getConfirmationAuthority === attachmentAuthority && deps.isExplicitTargetAuthorized === attachmentAuthorize;
    const inputReceiverCurrent = (entry) => entry.kind === "attachment"
        ? attachmentPortsCurrent() && readTelegramTextInputReceiverBotId(getAttachmentBotId, entry.handle.target) === entry.botId && attachmentPortsCurrent()
        : entry.kind !== "text" || inputReceiverTargetCurrent(entry) &&
            (!getInputReceiverBotId || readTelegramTextInputReceiverBotId(getInputReceiverBotId, entry.handle.target) === entry.botId) && inputReceiverTargetCurrent(entry);
    const tasks = new Map();
    // Private generation-local retirement evidence only; cross-reload privacy still needs inbound provenance.
    const retiredTextInputs = new Map();
    const pruneRetiredTextInputs = () => {
        const now = Date.now();
        for (const [key, expires] of retiredTextInputs)
            if (expires <= now)
                retiredTextInputs.delete(key);
        while (retiredTextInputs.size > 512)
            retiredTextInputs.delete(retiredTextInputs.keys().next().value);
    };
    const rememberTextInput = (entry) => {
        if (entry.messageId === undefined)
            return;
        pruneRetiredTextInputs();
        retiredTextInputs.set(`${entry.handle.target.chatId}:${entry.messageId}`, Date.now() + 3_600_000);
        pruneRetiredTextInputs();
    };
    const handleBindings = new WeakMap();
    const targetQueue = createTelegramDeliveryTargetQueue(() => {
        const notify = deps.captureDrain?.();
        return () => active ? notify?.() : undefined;
    });
    const runForTarget = targetQueue.run;
    const render = (view) => {
        const chunks = deps.renderView(view);
        if (chunks.length === 0 ||
            chunks.some((chunk) => typeof chunk.text !== "string" || chunk.text.trim().length === 0)) {
            return failure("invalid-view", "Telegram delivery view rendered no content.");
        }
        return { ok: true, value: chunks };
    };
    const inactive = () => failure("runtime-unavailable", "Telegram delivery runtime generation is inactive.");
    const transportFailure = (operation, error, target, partial) => {
        try {
            const recorded = deps.recordFailure?.(operation, error, target);
            if (recorded)
                void Promise.resolve(recorded).catch(() => undefined);
        }
        catch { /* Diagnostics cannot replace the transport outcome. */ }
        if (error instanceof TelegramDeliveryTransportGenerationError) {
            return inactive();
        }
        const classified = classifyTelegramDeliveryTransportError(error);
        return failure(classified.reason, classified.reason === "commit-unknown"
            ? `Telegram delivery ${operation} may have committed before transport failed.`
            : `Telegram delivery ${operation} failed.`, partial, classified.retryAfterMs);
    };
    const createHandle = (target, messageIds) => {
        const canonicalTarget = Object.freeze(cloneTarget(target));
        const canonicalMessageIds = Object.freeze([...messageIds]);
        const handle = Object.freeze({
            target: canonicalTarget,
            messageIds: canonicalMessageIds,
            generation: deps.generation,
        });
        handleBindings.set(handle, {
            target: canonicalTarget,
            messageIds: canonicalMessageIds,
        });
        return handle;
    };
    const resolveHandle = (handle) => {
        if (!active)
            return inactive();
        const binding = handleBindings.get(handle);
        if (!binding || handle.generation !== deps.generation) {
            return failure("stale-handle", "Telegram delivery handle belongs to an inactive runtime generation.");
        }
        const authorized = resolveTelegramDeliveryTarget({ kind: "target", target: binding.target }, deps);
        if (!authorized.ok) {
            return failure(authorized.reason, authorized.message);
        }
        return { ok: true, value: binding };
    };
    const questionFailure = (reason, message) => ({ ok: false, reason, message });
    const cleanupQuestion = (entry, status) => {
        if (!active || !entry.delivery || entry.cleanupStarted ||
            (entry.kind === "confirmation" && entry.owned && (status === "confirmed" || status === "cancelled")))
            return;
        entry.cleanupStarted = true;
        const delivery = entry.delivery, label = entry.kind === "choice" ? "Choice" : entry.kind === "text" ? "Text input" : entry.kind === "attachment" ? "Attachment request" : "Confirmation";
        const text = status === "confirmed" || status === "selected" || status === "submitted" ? `✅ ${label} received.`
            : status === "expired" ? `⌛ ${label} expired.`
                : status === "invalidated" ? `⌛ ${label} unavailable.`
                    : status === "replaced" ? `ℹ️ ${label} replaced.` : `❌ ${label} cancelled.`;
        void runForTarget(entry.handle.target, async () => {
            const assertAuthority = () => {
                if (entry.kind !== "attachment")
                    assertQuestionProvider();
                const authority = deps.getConfirmationAuthority?.();
                if (!resolveHandle(delivery).ok || authority?.profile !== entry.authority.profile ||
                    authority?.operatorId !== entry.authority.operatorId || !inputReceiverCurrent(entry))
                    throw new TelegramDeliveryTransportGenerationError();
                if (entry.kind !== "attachment")
                    assertQuestionProvider();
                if (!active || entry.kind !== "attachment" && questionProviderLost)
                    throw new TelegramDeliveryTransportGenerationError();
            };
            assertAuthority();
            await deps.editChunk(entry.handle.target, delivery.messageIds[0], {
                text: `<b>${text}</b>`, parseMode: "html",
            }, { replyMarkup: { inline_keyboard: entry.kind === "text" || entry.kind === "attachment"
                        ? [[{ text: "ℹ️ Request status", callback_data: `${entry.kind === "text" ? "tginput" : "tgattach"}:${entry.handle.id}:cancel` }]] : [] }, assertAuthority });
        }).catch(error => { transportFailure("edit", error, entry.handle.target); });
    };
    const finishQuestion = (entry, status, value, files) => {
        if ((status === "selected" && (entry.kind !== "choice" || value === undefined)) ||
            (status === "submitted" && (entry.kind === "attachment" ? files === undefined : entry.kind !== "text" || value === undefined)) ||
            (status === "confirmed" && entry.kind !== "confirmation"))
            return false;
        const next = transitionTelegramQuestion(entry.phase, { kind: "settle", status, expired: Date.now() >= entry.deadline });
        if (next === entry.phase || next === "opening" || next === "waiting")
            return false;
        // Narrow each producer's result; neither public request can manufacture the other's answer.
        if (entry.kind === "confirmation") {
            if (next === "selected" || next === "submitted" || next === "replaced")
                return false;
            entry.phase = next;
            questions.delete(entry.handle.id);
            entry.dispose();
            entry.resolve(Object.freeze({ status: next }));
        }
        else if (entry.kind === "choice") {
            if (next === "confirmed" || next === "submitted" || next === "replaced")
                return false;
            entry.phase = next;
            questions.delete(entry.handle.id);
            entry.dispose();
            entry.resolve(next === "selected" ? Object.freeze({ status: next, choiceId: value }) : Object.freeze({ status: next }));
        }
        else if (entry.kind === "attachment") {
            if (next === "confirmed" || next === "selected" || next === "replaced")
                return false;
            entry.phase = next;
            questions.delete(entry.handle.id);
            entry.dispose();
            entry.resolve(next === "submitted" ? Object.freeze({ status: next, lease: files.lease, dispose: files.dispose }) : Object.freeze({ status: next }));
            const reservation = entry.sourceReservation;
            if (reservation && !reservation.lost && !reservation.checking && !reservation.handoffIssued) {
                if (next === "cancelled")
                    reservation.cancellation = Object.freeze({ kind: "cancelled", assertAcknowledged() {
                            if (!reservation.cancellation)
                                throw new TelegramDeliveryTransportGenerationError();
                        } });
                else if (next === "expired" || next === "aborted")
                    reservation.endReceipt = Object.freeze({ kind: "ended", reason: next, assertAcknowledged() {
                            if (!reservation.endReceipt)
                                throw new TelegramDeliveryTransportGenerationError();
                        } });
            }
        }
        else {
            if (next === "confirmed" || next === "selected")
                return false;
            entry.phase = next;
            if (!entry.publicationPending)
                questions.delete(entry.handle.id);
            entry.dispose();
            rememberTextInput(entry);
            entry.resolve(next === "submitted" ? Object.freeze({ status: next, text: value }) : Object.freeze({ status: next }));
        }
        if (active)
            entry.notifyDrain();
        cleanupQuestion(entry, next);
        return next === status;
    };
    // Observation is separate from the legacy collector/publication settlement effects.
    const observeQuestion = (entry, readAuthority = deps.getConfirmationAuthority, authorizeTarget = deps.isExplicitTargetAuthorized, admittedEvent = false) => {
        if (!admittedEvent && Date.now() >= entry.deadline)
            return "expired";
        try {
            if (entry.kind === "attachment")
                entry.publicationCurrent?.();
            else
                assertQuestionProvider();
        }
        catch {
            return "invalidated";
        }
        const authority = readAuthority?.call(deps);
        if (!active || !authority || authority.profile !== entry.authority.profile ||
            authority.operatorId !== entry.authority.operatorId ||
            !authorizeTarget.call(deps, entry.handle.target) || !inputReceiverCurrent(entry))
            return "invalidated";
        try {
            if (entry.kind !== "attachment")
                assertQuestionProvider();
        }
        catch {
            return "invalidated";
        }
        return !active || entry.kind !== "attachment" && questionProviderLost ? "invalidated" : undefined;
    };
    const questionCurrent = (entry) => {
        if (entry.phase !== "opening" && entry.phase !== "waiting")
            return false;
        const failure = observeQuestion(entry);
        if (failure) {
            finishQuestion(entry, failure);
            return false;
        }
        return entry.phase === "opening" || entry.phase === "waiting";
    };
    const shortenQuestionTails = (entries, at) => {
        for (const entry of entries) {
            if (entry.kind === "attachment" || questions.get(entry.handle.id) !== entry ||
                entry.phase !== "opening" && entry.phase !== "waiting")
                continue;
            const deadline = Math.min(entry.deadline, at + TELEGRAM_QUESTION_TAIL_MS);
            if (deadline < entry.deadline) {
                entry.deadline = deadline;
                entry.armExpiry?.();
            }
        }
    };
    const captureQuestionLifetimeOwner = (binding) => {
        if (questionOwnerObservation) {
            questionOwnerObservation.lost = true;
            return undefined;
        }
        if (!questionHeadTail || !active || !sourceAuthority)
            return undefined;
        const observation = { lost: false };
        questionOwnerObservation = observation;
        try {
            const bindingFacts = binding === undefined ? undefined : readNativeQuestionBinding(binding);
            if (bindingFacts && (bindingFacts.runtime !== runtime || !questionBindingCurrent(bindingFacts)))
                return undefined;
            assertQuestionProvider();
            const authority = sourceAuthority.call(deps), currentTarget = readInputReceiverTarget();
            if (!authority || typeof authority.profile !== "string" || !authority.profile ||
                !Number.isSafeInteger(authority.operatorId) || authority.operatorId <= 0 || !currentTarget ||
                !Number.isSafeInteger(currentTarget.chatId) || currentTarget.chatId <= 0 ||
                currentTarget.threadId !== undefined && (!Number.isSafeInteger(currentTarget.threadId) || currentTarget.threadId <= 0))
                return undefined;
            const profile = authority.profile, operatorId = authority.operatorId, target = Object.freeze(cloneTarget(currentTarget));
            let lost = false, checking = false, checkingAdmission = false, checkingScope = false, captured = false;
            const unavailable = () => new Error("Question lifetime owner is unavailable.");
            const scopeCurrent = () => {
                const current = sourceAuthority.call(deps), receiver = readInputReceiverTarget();
                return current?.profile === profile && current.operatorId === operatorId && !!receiver && areDeliveryTargetsEqual(receiver, target);
            };
            const assertCurrent = () => {
                if (lost || checking) {
                    lost = true;
                    throw unavailable();
                }
                checking = true;
                try {
                    assertQuestionProvider();
                    if (observation.lost || bindingFacts && (!questionBindingCurrent(bindingFacts) || runtime.captureQuestionLifetimeOwner !== captureQuestionLifetimeOwner) ||
                        !questionLifetimePortsCurrent() || !scopeCurrent() || !sourceAuthorize.call(deps, target) || !scopeCurrent() || observation.lost || lost ||
                        !questionLifetimePortsCurrent() || bindingFacts && (!questionBindingCurrent(bindingFacts) || runtime.captureQuestionLifetimeOwner !== captureQuestionLifetimeOwner))
                        throw unavailable();
                    assertQuestionProvider();
                    if (!active || observation.lost || lost || questionProviderLost || bindingFacts && !questionBindingCurrent(bindingFacts))
                        throw unavailable();
                }
                catch {
                    lost = true;
                    throw unavailable();
                }
                finally {
                    checking = false;
                }
            };
            assertCurrent();
            const assertObservedCurrent = () => {
                if (!active || lost || observation.lost || questionProviderLost || bindingFacts && !questionBindingCurrent(bindingFacts)) {
                    lost = true;
                    throw unavailable();
                }
            };
            const scope = new NativeQuestionLifetimeScope(QUESTION_LIFETIME_SCOPE_KEY, { runtime: questionLifetimeRuntime, profile, operatorId, target, binding: bindingFacts?.binding, assertAvailable: assertObservedCurrent });
            const matchAdmissionEvent = (value, finalUse) => {
                if (checking || checkingAdmission || checkingScope) {
                    lost = true;
                    throw unavailable();
                }
                let admission;
                try {
                    admission = readNativeQuestionAdmission(value);
                }
                catch {
                    return undefined;
                }
                if (admission.runtime !== questionLifetimeRuntime || bindingFacts && admission.binding !== bindingFacts.binding)
                    return undefined;
                checkingAdmission = true;
                try {
                    if (admission.profile !== profile || admission.operatorId !== operatorId) {
                        admission.assertEventCurrent();
                        lost = true;
                        throw unavailable();
                    }
                    if (!areDeliveryTargetsEqual(admission.target, target))
                        return undefined;
                    let assertHead, assertAuthority;
                    if (finalUse !== undefined) {
                        checking = true;
                        try {
                            assertHead = finalUse?.assertCurrent;
                            assertAuthority = finalUse?.assertAuthority;
                            if (typeof assertHead !== "function" || assertAuthority !== undefined && typeof assertAuthority !== "function")
                                throw unavailable();
                        }
                        finally {
                            checking = false;
                        }
                    }
                    assertCurrent();
                    admission.assertEventCurrent();
                    assertCurrent();
                    checking = true;
                    try {
                        for (const guard of [assertAuthority, assertHead])
                            if (guard) {
                                const returned = guard();
                                if (returned !== undefined) {
                                    void Promise.resolve(returned).catch(() => { });
                                    throw unavailable();
                                }
                                assertObservedCurrent();
                                admission.assertEventCurrent(true);
                            }
                    }
                    finally {
                        checking = false;
                    }
                    assertObservedCurrent();
                    admission.assertEventCurrent(true);
                    return admission.at;
                }
                finally {
                    checkingAdmission = false;
                }
            };
            return Object.freeze({ scope, target, assertCurrent, assertObservedCurrent, matchAdmissionEvent, assertScope(value) {
                    if (checking || checkingScope || checkingAdmission) {
                        lost = true;
                        throw unavailable();
                    }
                    let peer;
                    try {
                        peer = readNativeQuestionLifetimeScope(value);
                    }
                    catch {
                        throw unavailable();
                    }
                    if (peer.runtime !== questionLifetimeRuntime || peer.profile !== profile || peer.operatorId !== operatorId ||
                        peer.binding !== bindingFacts?.binding || !areDeliveryTargetsEqual(peer.target, target))
                        throw unavailable();
                    checkingScope = true;
                    try {
                        // Same-runtime owners share the constructor-pinned providers. Read the matching current scope here;
                        // the peer check reads only sticky history, so nested publications do not reenter the peer's active guard.
                        assertCurrent();
                        peer.assertAvailable();
                        assertCurrent();
                        peer.assertAvailable();
                    }
                    finally {
                        checkingScope = false;
                    }
                }, assertAdmission(value) {
                    if (checking || checkingAdmission || checkingScope) {
                        lost = true;
                        throw unavailable();
                    }
                    let admission;
                    try {
                        admission = readNativeQuestionAdmission(value);
                    }
                    catch {
                        throw unavailable();
                    }
                    if (admission.runtime !== questionLifetimeRuntime || bindingFacts && admission.binding !== bindingFacts.binding)
                        throw unavailable();
                    checkingAdmission = true;
                    try {
                        if (admission.profile !== profile || admission.operatorId !== operatorId) {
                            admission.assertCurrent();
                            lost = true;
                            throw unavailable();
                        }
                        if (!areDeliveryTargetsEqual(admission.target, target))
                            throw unavailable();
                        assertCurrent();
                        admission.assertCurrent();
                        assertCurrent();
                        return admission.at;
                    }
                    finally {
                        checkingAdmission = false;
                    }
                }, assertAdmissionEvent(value) {
                    const at = matchAdmissionEvent(value);
                    if (at === undefined)
                        throw unavailable();
                    return at;
                }, captureTail(cohort) {
                    if (captured) {
                        if (checking)
                            lost = true;
                        throw unavailable();
                    }
                    captured = true;
                    // Snapshot before even cohort getters can admit newer questions. Never reselect at application.
                    const at = Date.now(), entries = [...questions.values()].filter(entry => entry.kind !== "attachment" &&
                        (entry.phase === "opening" || entry.phase === "waiting") && entry.authority.profile === profile &&
                        entry.authority.operatorId === operatorId && areDeliveryTargetsEqual(entry.handle.target, target));
                    const peers = [];
                    let assertHead, assertHeadAuthority;
                    if (cohort !== undefined) {
                        if (checking) {
                            lost = true;
                            throw unavailable();
                        }
                        checking = true;
                        try {
                            const scopes = cohort?.scopes;
                            assertHead = cohort?.assertCurrent;
                            assertHeadAuthority = cohort?.assertAuthority;
                            if (!Array.isArray(scopes) || !scopes.length || typeof assertHead !== "function" ||
                                assertHeadAuthority !== undefined && typeof assertHeadAuthority !== "function")
                                throw unavailable();
                            const count = scopes.length;
                            for (let index = 0; index < count; index++) {
                                const peer = readNativeQuestionLifetimeScope(scopes[index]);
                                if (peer.runtime !== questionLifetimeRuntime || peer.profile !== profile || peer.operatorId !== operatorId ||
                                    peer.binding !== bindingFacts?.binding || !areDeliveryTargetsEqual(peer.target, target))
                                    throw unavailable();
                                peers.push(peer);
                            }
                        }
                        catch {
                            throw unavailable();
                        }
                        finally {
                            checking = false;
                        }
                    }
                    const assertCohort = () => {
                        if (!assertHead)
                            return;
                        for (const peer of peers)
                            peer.assertAvailable();
                        checking = true;
                        try {
                            if (assertHeadAuthority) {
                                const returned = assertHeadAuthority();
                                if (returned !== undefined) {
                                    void Promise.resolve(returned).catch(() => { });
                                    throw unavailable();
                                }
                                for (const peer of peers)
                                    peer.assertAvailable();
                                if (lost || observation.lost || questionProviderLost || !active)
                                    throw unavailable();
                            }
                            const returned = assertHead();
                            if (returned !== undefined) {
                                void Promise.resolve(returned).catch(() => { });
                                throw unavailable();
                            }
                        }
                        finally {
                            checking = false;
                        }
                        // No provider callbacks after this barrier and before irreversible SDK shortening.
                        for (const peer of peers)
                            peer.assertAvailable();
                        if (lost || observation.lost || questionProviderLost || !active)
                            throw unavailable();
                    };
                    assertCurrent();
                    assertCohort();
                    let applied = false;
                    return Object.freeze(() => {
                        if (applied) {
                            if (checking)
                                lost = true;
                            throw unavailable();
                        }
                        applied = true;
                        assertCurrent();
                        assertCohort();
                        shortenQuestionTails(entries, at);
                    });
                } });
        }
        catch {
            return undefined;
        }
        finally {
            questionOwnerObservation = undefined;
        }
    };
    async function openQuestion(spec) {
        const request = spec.request, label = spec.kind === "choice" ? "Choice" : spec.kind === "text" ? "Text input" : spec.kind === "attachment" ? "Attachment request" : "Confirmation";
        const suppliedTimeoutMs = request.timeoutMs;
        const timeoutMs = suppliedTimeoutMs === undefined && spec.kind !== "attachment" ? TELEGRAM_QUESTION_HEAD_MS : suppliedTimeoutMs;
        const signal = request.signal, owner = request.owner, question = request.question, cancelLabel = request.cancelLabel;
        if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
            throw new TypeError(`${label} timeoutMs must be an integer from 1 to 2147483647.`);
        if (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")
            throw new TypeError(`${label} requires an AbortSignal.`);
        if (!["active-turn", "instance", "target"].includes(request.scope?.kind))
            throw new TypeError(`${label} scope is invalid.`);
        if ([owner, question, cancelLabel].some(value => typeof value !== "string" || !value.trim()))
            throw new TypeError(`${label} owner and text must be nonempty strings.`);
        const validStyle = (style) => style === undefined || (typeof style === "string" && ["primary", "success", "danger"].includes(style));
        let choices = [], maxLength = 4096, multiline = false;
        if (spec.kind === "choice") {
            if (!Array.isArray(spec.request.choices) || spec.request.choices.length < 1 || spec.request.choices.length > 64)
                throw new TypeError("Choice requires from 1 to 64 options.");
            choices = Object.freeze(spec.request.choices.map(option => Object.freeze({
                id: option?.id, label: option?.label, style: option?.style, disabled: option?.disabled,
            })));
            const ids = new Set();
            for (const option of choices) {
                if (typeof option.id !== "string" || !option.id.trim() || ids.has(option.id) ||
                    typeof option.label !== "string" || !option.label.trim() || !validStyle(option.style) ||
                    (option.disabled !== undefined && typeof option.disabled !== "boolean"))
                    throw new TypeError("Choice options require unique nonempty IDs, labels, valid styles and boolean disabled flags.");
                ids.add(option.id);
            }
        }
        else if (spec.kind === "text") {
            const suppliedLength = spec.request.maxLength, suppliedMultiline = spec.request.multiline;
            maxLength = suppliedLength === undefined ? 4096 : suppliedLength;
            multiline = suppliedMultiline === undefined ? false : suppliedMultiline;
            if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 16_384 || typeof multiline !== "boolean")
                throw new TypeError("Text input requires a maxLength from 1 to 16384 and a boolean multiline flag.");
        }
        else if (spec.kind === "confirmation") {
            if (typeof spec.request.confirmLabel !== "string" || !spec.request.confirmLabel.trim())
                throw new TypeError("Confirmation owner and text must be nonempty strings.");
            if (!validStyle(spec.request.confirmStyle))
                throw new TypeError("Confirmation style is invalid.");
        }
        const admittedAt = Date.now(), publishOwned = spec.kind === "confirmation" ? spec.owned?.publish : undefined;
        if (!active)
            return questionFailure("runtime-unavailable", "Question runtime is inactive.");
        if (signal.aborted)
            return questionFailure("aborted", `${label} was aborted.`);
        if (spec.kind !== "text" && questions.size + tasks.size >= 256)
            return questionFailure("capacity-exceeded", "Too many questions are pending.");
        try {
            if (spec.kind !== "attachment")
                assertQuestionProvider();
        }
        catch {
            return questionFailure("runtime-unavailable", "Question original provider is unavailable.");
        }
        const resolved = resolveTelegramDeliveryTarget(request.scope, deps);
        if (!resolved.ok)
            return questionFailure(resolved.reason, resolved.message);
        const observedAuthority = deps.getConfirmationAuthority?.();
        const authority = spec.kind === "attachment" && observedAuthority
            ? { profile: observedAuthority.profile, operatorId: observedAuthority.operatorId } : observedAuthority;
        if (!authority || spec.kind === "attachment" && (typeof authority.profile !== "string" || !authority.profile.trim() ||
            !Number.isSafeInteger(authority.operatorId) || authority.operatorId <= 0))
            return questionFailure("runtime-unavailable", "Question authority is unavailable.");
        const botId = spec.kind === "text" ? readTelegramTextInputReceiverBotId(getInputReceiverBotId, resolved.value)
            : spec.kind === "attachment" ? readTelegramTextInputReceiverBotId(getAttachmentBotId, resolved.value) : undefined;
        if (spec.kind === "attachment" && (!attachmentPortsCurrent() || botId === undefined))
            return questionFailure("runtime-unavailable", "Attachment receiver/publication is unavailable.");
        if (spec.kind === "text" && getInputReceiverBotId && botId === undefined)
            return questionFailure("runtime-unavailable", "Text Input receiver is unavailable.");
        if (spec.kind === "text") {
            const receiverTarget = readInputReceiverTarget();
            if (!receiverTarget)
                return questionFailure("target-unavailable", "Text Input receiver target is unavailable.");
            if (!areDeliveryTargetsEqual(receiverTarget, resolved.value))
                return questionFailure("target-unauthorized", "Text Input requires its original instance receiver target.");
        }
        const id = randomBytes(16).toString("hex");
        if (questions.has(id))
            return questionFailure("runtime-unavailable", "Question identity is unavailable.");
        const keyboard = spec.kind === "confirmation" ? { inline_keyboard: [[
                    { text: spec.request.confirmLabel, callback_data: `tgconfirm:${id}:yes`, ...(spec.request.confirmStyle ? { style: spec.request.confirmStyle } : {}) },
                    { text: cancelLabel, callback_data: `tgconfirm:${id}:no` },
                ]] } : spec.kind === "text" || spec.kind === "attachment" ? { inline_keyboard: [[{ text: cancelLabel,
                        callback_data: `${spec.kind === "text" ? "tginput" : "tgattach"}:${id}:cancel` }]] } : { inline_keyboard: [
                ...choices.map((option, index) => [{ text: option.label, ...(option.style ? { style: option.style } : {}),
                        ...(option.disabled ? { disabled: {} } : { callback_data: `tgchoice:${id}:${index}` }) }]),
                [{ text: cancelLabel, callback_data: `tgchoice:${id}:cancel` }],
            ] };
        const view = { text: `<b>${escapeHtml(question)}</b>${spec.kind === "attachment" ? "\nReply to this message with the requested attachment(s)." : ""}`,
            parseMode: "html", replyMarkup: keyboard };
        const rendered = render(view);
        if (!rendered.ok)
            return questionFailure(rendered.reason, rendered.message);
        if (rendered.value.length !== 1)
            return questionFailure("invalid-view", "A question must fit one message.");
        const identity = { id, target: Object.freeze(cloneTarget(resolved.value)), generation: deps.generation };
        const base = {
            owner, authority: { ...authority }, deadline: admittedAt + (questionHeadTail && spec.kind !== "attachment" ? Math.min(timeoutMs, TELEGRAM_QUESTION_HEAD_MS) : timeoutMs),
            phase: "opening", dispose() { }, notifyDrain: captureTelegramDrainObserver(deps.captureDrain),
        };
        let entry;
        if (spec.kind === "confirmation") {
            const result = Promise.withResolvers();
            entry = { ...base, kind: "confirmation", handle: Object.freeze({ ...identity, result: result.promise }), resolve: result.resolve,
                owned: spec.owned ? { confirmedData: spec.owned.confirmedData, cancelledData: spec.owned.cancelledData } : undefined };
        }
        else if (spec.kind === "choice") {
            const result = Promise.withResolvers();
            entry = { ...base, kind: "choice", choices, handle: Object.freeze({ ...identity, result: result.promise }), resolve: result.resolve };
        }
        else if (spec.kind === "attachment") {
            const result = Promise.withResolvers();
            entry = { ...base, kind: "attachment", botId: botId,
                constraints: Object.freeze({ accept: spec.request.accept, maxFiles: spec.request.maxFiles, maxBytes: spec.request.maxBytes }),
                handle: Object.freeze({ ...identity, result: result.promise }), resolve: result.resolve };
        }
        else {
            const result = Promise.withResolvers();
            entry = { ...base, kind: "text", maxLength, multiline, botId, publicationPending: true,
                handle: Object.freeze({ ...identity, result: result.promise }), resolve: result.resolve };
        }
        if (entry.kind === "text" || questionHeadTail && entry.kind !== "attachment") {
            const observed = signal.aborted ? "aborted" : observeQuestion(entry);
            const failure = signal.aborted ? "aborted" : Date.now() >= entry.deadline ? "expired" : observed;
            if (failure)
                return questionFailure(failure, "Question ended before opening completed.");
        }
        const predecessors = spec.kind === "text" ? [...questions.values()].filter((prior) => prior.kind === "text" && (prior.phase === "opening" || prior.phase === "waiting") &&
            (prior.receiverTargetLost || prior.authority.profile === base.authority.profile && prior.authority.operatorId === base.authority.operatorId &&
                prior.botId === botId && areDeliveryTargetsEqual(prior.handle.target, identity.target))) : [];
        if (spec.kind === "text" && questions.size + tasks.size - predecessors.filter(prior => !prior.publicationPending).length >= 256)
            return questionFailure("capacity-exceeded", "Too many questions are pending.");
        const onAbort = () => { finishQuestion(entry, "aborted"); };
        let timer, expiryGeneration = 0;
        entry.armExpiry = () => {
            const generation = ++expiryGeneration;
            if (timer !== undefined)
                clearTimeout(timer);
            if (entry.phase !== "opening" && entry.phase !== "waiting")
                return;
            timer = setTimeout(() => { if (generation === expiryGeneration)
                finishQuestion(entry, "expired"); }, Math.max(1, entry.deadline - Date.now()));
            timer.unref?.();
        };
        entry.armExpiry();
        entry.dispose = () => { expiryGeneration++; if (timer !== undefined)
            clearTimeout(timer); signal.removeEventListener("abort", onAbort); };
        const admissionBinding = onQuestionAdmission ? currentQuestionBinding(runtime)?.facts : undefined;
        const demoted = questionHeadTail && spec.kind !== "attachment" ? [...questions.values()].filter(prior => prior.kind !== "attachment" && (prior.phase === "opening" || prior.phase === "waiting") &&
            !(prior.kind === "text" && predecessors.includes(prior)) &&
            prior.authority.profile === entry.authority.profile && prior.authority.operatorId === entry.authority.operatorId &&
            areDeliveryTargetsEqual(prior.handle.target, entry.handle.target)) : [];
        // Reserve the successor and demote only captured predecessors before disposal/observers can reenter.
        questions.set(id, entry);
        const demotedAt = Date.now();
        shortenQuestionTails(demoted, demotedAt);
        if (onQuestionAdmission && entry.kind !== "attachment") {
            let live = true, lost = false, checking = false, eventLost = false, checkingEvent = false;
            const scopeCurrent = () => {
                const current = (!admissionBinding || questionBindingCurrent(admissionBinding)) && questionLifetimePortsCurrent();
                if (!current)
                    eventLost = true;
                return current;
            };
            const current = () => live && !lost && !eventLost && scopeCurrent() && questions.get(id) === entry &&
                (entry.phase === "opening" || entry.phase === "waiting") && !signal.aborted && Date.now() < entry.deadline;
            const assertCurrent = () => {
                if (checking || checkingEvent) {
                    eventLost = true;
                    lost = true;
                    throw new Error("Question admission is unavailable.");
                }
                if (!current()) {
                    lost = true;
                    throw new Error("Question admission is unavailable.");
                }
                checking = true;
                try {
                    let failure;
                    try {
                        failure = observeQuestion(entry, sourceAuthority, sourceAuthorize);
                    }
                    catch (error) {
                        eventLost = true;
                        throw error;
                    }
                    if (failure === "invalidated")
                        eventLost = true;
                    if (failure || !current())
                        throw new Error("Question admission is unavailable.");
                }
                catch (error) {
                    lost = true;
                    throw error;
                }
                finally {
                    checking = false;
                }
            };
            const assertEventCurrent = (observed) => {
                if (checking || checkingEvent || !live || !active || eventLost || !Number.isFinite(demotedAt) || questionProviderLost ||
                    admissionBinding && !questionBindingCurrent(admissionBinding)) {
                    eventLost = true;
                    throw new Error("Question admission event is unavailable.");
                }
                if (observed)
                    return;
                checkingEvent = true;
                try {
                    if (!scopeCurrent() || observeQuestion(entry, sourceAuthority, sourceAuthorize, true) || !scopeCurrent() || eventLost)
                        throw new Error("Question admission event is unavailable.");
                }
                catch (error) {
                    eventLost = true;
                    throw error;
                }
                finally {
                    checkingEvent = false;
                }
            };
            let returned;
            try {
                returned = onQuestionAdmission(new NativeQuestionAdmission(QUESTION_ADMISSION_KEY, entry.handle.target, demotedAt, { runtime: questionLifetimeRuntime, profile: entry.authority.profile, operatorId: entry.authority.operatorId, binding: admissionBinding?.binding, assertCurrent, assertEventCurrent }));
            }
            catch { /* A failed private observer cannot replay or roll back an already admitted SDK head. */ }
            finally {
                live = false;
            }
            if (returned !== undefined)
                void Promise.resolve(returned).catch(() => { });
        }
        for (const prior of predecessors)
            finishQuestion(prior, Date.now() >= prior.deadline ? "expired" : prior.receiverTargetLost ? "invalidated" : "replaced");
        if (entry.phase === "opening") {
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted)
                onAbort();
        }
        const opened = () => {
            if (entry.kind === "confirmation")
                return { ok: true, handle: entry.handle };
            if (entry.kind === "choice")
                return { ok: true, handle: entry.handle };
            if (entry.kind === "attachment")
                return { ok: true, handle: entry.handle };
            return { ok: true, handle: entry.handle };
        };
        const assertAuthority = () => {
            // Let an issued API call preserve uncertainty before settling an opening receiver as invalidated.
            if (!inputReceiverCurrent(entry) || !questionCurrent(entry))
                throw new TelegramDeliveryTransportGenerationError();
        };
        const publish = runForTarget(entry.handle.target, async () => {
            try {
                assertAuthority();
                const publication = publishOwned
                    ? await publishOwned(entry.handle.target, view.text, keyboard, assertAuthority)
                    : await (entry.kind === "attachment" ? publishAttachment : deps.sendChunk).call(deps, entry.handle.target, rendered.value[0], { replyMarkup: keyboard, assertAuthority });
                if (publication === undefined)
                    throw new Error("Question returned no message identity.");
                if (entry.kind === "attachment" && typeof publication !== "number") {
                    const guard = publication.assertCurrent;
                    if (typeof guard !== "function")
                        throw new Error("Attachment publication scope is unavailable.");
                    entry.publicationCurrent = () => { if (publication.assertCurrent !== guard)
                        throw new TelegramDeliveryTransportGenerationError(); guard.call(publication); };
                }
                const messageId = entry.kind === "attachment" && typeof publication !== "number" ? publication.messageId : publication;
                if (typeof messageId !== "number" || !Number.isSafeInteger(messageId) || messageId <= 0)
                    throw new Error("Question returned no message identity.");
                entry.messageId = messageId;
                if (entry.kind === "text" && entry.phase === "opening") {
                    pruneRetiredTextInputs();
                    if (retiredTextInputs.has(`${entry.handle.target.chatId}:${messageId}`)) {
                        finishQuestion(entry, "invalidated");
                        return questionFailure("invalidated", "Text Input publication identity was reused.");
                    }
                }
                entry.delivery = createHandle(entry.handle.target, [messageId]);
                if (entry.kind === "text" && entry.phase !== "opening" && entry.phase !== "waiting")
                    rememberTextInput(entry);
                if (!questionCurrent(entry)) {
                    const status = entry.phase === "expired" || entry.phase === "aborted" || entry.phase === "replaced" ? entry.phase : "invalidated";
                    cleanupQuestion(entry, status);
                    return questionFailure(status, "Question ended during delivery.");
                }
                entry.phase = transitionTelegramQuestion(entry.phase, { kind: "published" });
                return opened();
            }
            catch (error) {
                const pending = entry.phase === "opening" || entry.phase === "waiting";
                if (pending || !(error instanceof TelegramDeliveryTransportGenerationError)) {
                    const failure = transportFailure("send", error, entry.handle.target);
                    if (pending && !failure.ok)
                        entry.openingFailure = questionFailure(failure.reason, failure.message);
                }
                if (pending)
                    finishQuestion(entry, "invalidated");
                const status = entry.phase === "expired" || entry.phase === "aborted" || entry.phase === "replaced" ? entry.phase : "invalidated";
                return entry.openingFailure ?? questionFailure(status, "Question ended during delivery.");
            }
        }).finally(() => {
            if (entry.kind !== "text")
                return;
            entry.publicationPending = false;
            if (entry.phase !== "opening" && entry.phase !== "waiting" && questions.get(id) === entry) {
                questions.delete(id);
                if (active)
                    entry.notifyDrain();
            }
        });
        const terminated = entry.handle.result.then((decision) => decision.status === "confirmed" || decision.status === "selected" || decision.status === "submitted" || decision.status === "cancelled"
            ? opened() : entry.openingFailure ?? questionFailure(decision.status, "Question ended before opening completed."));
        return Promise.race([publish, terminated]);
    }
    const canAnswer = (entry, query, assertAuthority) => {
        if (entry.phase !== "waiting" || query.from?.id !== entry.authority.operatorId ||
            query.message?.chat?.id !== entry.handle.target.chatId ||
            query.message?.message_thread_id !== entry.handle.target.threadId ||
            query.message?.message_id !== entry.messageId || !questionCurrent(entry))
            return false;
        assertAuthority?.();
        return entry.kind === "attachment" || !captureQuestionAuthority || questionCurrent(entry);
    };
    const acceptedAuthority = (entry) => () => {
        if (entry.kind !== "attachment")
            assertQuestionProvider();
        const authority = deps.getConfirmationAuthority?.();
        if (entry.kind === "attachment")
            entry.publicationCurrent?.();
        if (!active || authority?.profile !== entry.authority.profile || authority?.operatorId !== entry.authority.operatorId ||
            !deps.isExplicitTargetAuthorized(entry.handle.target) || !inputReceiverCurrent(entry))
            throw new TelegramDeliveryTransportGenerationError();
        if (entry.kind !== "attachment")
            assertQuestionProvider();
        if (!active || entry.kind !== "attachment" && questionProviderLost)
            throw new TelegramDeliveryTransportGenerationError();
    };
    const captureTextInputSource = (inputTarget) => {
        if (inputSourceObservation) {
            inputSourceObservation.lost = true;
            return undefined;
        }
        let target;
        try {
            if (!isWireRecord(inputTarget))
                return undefined;
            const fields = Object.getOwnPropertyDescriptors(inputTarget);
            if (Reflect.ownKeys(fields).some(key => key !== "chatId" && key !== "threadId") ||
                !fields.chatId || !Object.hasOwn(fields.chatId, "value") || typeof fields.chatId.value !== "number" ||
                !Number.isSafeInteger(fields.chatId.value) || fields.chatId.value <= 0 ||
                (fields.threadId && (!Object.hasOwn(fields.threadId, "value") || (fields.threadId.value !== undefined &&
                    (!Number.isSafeInteger(fields.threadId.value) || fields.threadId.value <= 0)))))
                return undefined;
            target = Object.freeze({ chatId: fields.chatId.value, ...(fields.threadId?.value === undefined ? {} : { threadId: fields.threadId.value }) });
        }
        catch {
            return undefined;
        }
        const candidates = [...questions.values()].filter((entry) => entry.kind === "text" && (entry.phase === "opening" || entry.phase === "waiting") && areDeliveryTargetsEqual(entry.handle.target, target));
        if (candidates.length !== 1 || !sourceAuthority || !getInputReceiverBotId)
            return undefined;
        const entry = candidates[0], requestId = entry.handle.id, profile = entry.authority.profile, operatorId = entry.authority.operatorId, botId = entry.botId;
        if (typeof botId !== "number" || !Number.isSafeInteger(botId) || botId <= 0)
            return undefined;
        let valid = true, bindingValid = true;
        const assertOriginalBinding = () => {
            if (inputSourceObservation) {
                inputSourceObservation.lost = true;
                bindingValid = false;
                throw new TelegramDeliveryTransportGenerationError();
            }
            const observation = { lost: false };
            inputSourceObservation = observation;
            const current = () => active && !questionProviderLost && bindingValid && !observation.lost && deps.generation === sourceGeneration &&
                deps.getConfirmationAuthority === sourceAuthority && deps.isExplicitTargetAuthorized === sourceAuthorize &&
                deps.getTextInputReceiverBotId === getInputReceiverBotId && deps.getInstanceTarget === getInputReceiverTarget &&
                entry.handle.id === requestId && entry.handle.generation === sourceGeneration && entry.botId === botId &&
                entry.authority.profile === profile && entry.authority.operatorId === operatorId && areDeliveryTargetsEqual(entry.handle.target, target);
            try {
                if (!current())
                    throw new TelegramDeliveryTransportGenerationError();
                assertQuestionProvider();
                const first = sourceAuthority.call(deps);
                if (first?.profile !== profile || first.operatorId !== operatorId || !sourceAuthorize.call(deps, target) ||
                    !inputReceiverCurrent(entry) || !current())
                    throw new TelegramDeliveryTransportGenerationError();
                const final = sourceAuthority.call(deps);
                if (final?.profile !== profile || final.operatorId !== operatorId || !current() || !inputReceiverCurrent(entry) || !current())
                    throw new TelegramDeliveryTransportGenerationError();
                assertQuestionProvider();
                if (!current())
                    throw new TelegramDeliveryTransportGenerationError();
            }
            catch {
                bindingValid = false;
                throw new TelegramDeliveryTransportGenerationError();
            }
            finally {
                inputSourceObservation = undefined;
            }
        };
        const eligible = () => questions.get(requestId) === entry && (entry.phase === "opening" || entry.phase === "waiting") && Date.now() < entry.deadline &&
            [...questions.values()].filter(candidate => candidate.kind === "text" &&
                (candidate.phase === "opening" || candidate.phase === "waiting") && areDeliveryTargetsEqual(candidate.handle.target, target)).length === 1;
        const assertCurrent = () => {
            try {
                if (!valid || !eligible())
                    throw new TelegramDeliveryTransportGenerationError();
                assertOriginalBinding();
                if (!eligible())
                    throw new TelegramDeliveryTransportGenerationError();
            }
            catch {
                valid = false;
                throw new TelegramDeliveryTransportGenerationError();
            }
        };
        let nonUseLive = true, checkingNonUse = false, nonUse;
        const observeNonUseReason = () => {
            if (!nonUseLive || checkingNonUse) {
                nonUseLive = false;
                throw new TelegramDeliveryTransportGenerationError();
            }
            checkingNonUse = true;
            try {
                assertOriginalBinding();
                const reason = entry.phase;
                assertOriginalBinding();
                if (!nonUseLive)
                    throw new TelegramDeliveryTransportGenerationError();
                if (entry.phase !== reason || (reason !== "cancelled" && reason !== "expired" && reason !== "aborted" && reason !== "replaced"))
                    return undefined;
                return reason;
            }
            catch {
                nonUseLive = false;
                throw new TelegramDeliveryTransportGenerationError();
            }
            finally {
                checkingNonUse = false;
            }
        };
        const captureNonUse = () => {
            const reason = observeNonUseReason();
            if (reason === undefined)
                return undefined;
            if (!nonUse)
                nonUse = new NativeTextInputNonUse(TEXT_INPUT_NON_USE_KEY, Object.freeze({ requestId, generation: sourceGeneration, profile, operatorId, botId, target, reason }), () => {
                    if (observeNonUseReason() !== reason) {
                        nonUseLive = false;
                        throw new TelegramDeliveryTransportGenerationError();
                    }
                });
            nonUse.assertCurrent();
            return nonUse;
        };
        try {
            assertCurrent();
        }
        catch {
            return undefined;
        }
        let sourceUseAttempted = false;
        const submitSource = (source) => {
            if (sourceUseAttempted) {
                valid = false;
                throw new TelegramDeliveryTransportGenerationError();
            }
            sourceUseAttempted = true;
            const input = readNativeSourceUseInput(source), association = input.association, text = input.text;
            if (association.requestNonce !== requestId || association.receiver.deliveryGeneration !== sourceGeneration ||
                association.operatorUserId !== operatorId || input.profile !== profile || input.botId !== botId ||
                !areDeliveryTargetsEqual(association.target, target) || !isValidTextInputAnswer(text, entry.maxLength, entry.multiline))
                throw new TelegramDeliveryTransportGenerationError();
            assertCurrent();
            if (entry.phase !== "waiting" || entry.publicationPending || !entry.delivery || !entry.messageId)
                throw new TelegramDeliveryTransportGenerationError();
            // All semantic/provider callbacks precede the original Source's one-shot trusted-data barrier.
            readNativeSourceUseInput(source, true);
            if (!active || questionProviderLost || !valid || !bindingValid ||
                textSourceUseData(textSourceUseDate, "now") !== textSourceUseNow ||
                textSourceUseData(runtime, "captureTextInputSource") !== captureTextInputSource ||
                textSourceUseApply(textSourceUseMapGet, questions, [requestId]) !== entry ||
                entry.phase !== "waiting" || entry.publicationPending || textSourceUseNow() >= entry.deadline)
                throw new TelegramDeliveryTransportGenerationError();
            entry.phase = "submitted";
            const fact = new NativeTextInputSourceUse(TEXT_INPUT_SOURCE_USE_KEY, textSourceUseFreeze({ source: input, requestId, generation: sourceGeneration }), () => {
                try {
                    entry.dispose();
                    rememberTextInput(entry);
                    cleanupQuestion(entry, "submitted");
                }
                finally {
                    if (questions.get(requestId) === entry)
                        questions.delete(requestId);
                    if (active)
                        entry.notifyDrain();
                }
            });
            entry.resolve(textSourceUseFreeze({ status: "submitted", text }));
            return fact;
        };
        return new NativeTextInputSourceSelection(TEXT_INPUT_SELECTION_KEY, runtime, captureTextInputSource, { requestId, generation: sourceGeneration, profile, operatorId, botId, target, assertCurrent, assertOriginalBinding, captureNonUse }, submitSource);
    };
    function captureInputReceiver(kind, identity) {
        const { requestId, messageId, operatorId, botId, profile } = identity;
        const target = Object.freeze(cloneTarget(identity.target));
        const readAuthority = deps.getConfirmationAuthority, authorizeTarget = deps.isExplicitTargetAuthorized;
        const readBot = kind === "text" ? deps.getTextInputReceiverBotId : deps.getAttachmentReceiverBotId;
        const bound = () => kind === "text" ? deps.getTextInputReceiverBotId === readBot : attachmentPortsCurrent();
        const entry = questions.get(requestId);
        if (!entry || entry.kind !== kind || !readAuthority || !readBot || !bound() ||
            readBot !== (kind === "text" ? getInputReceiverBotId : getAttachmentBotId) ||
            !Number.isSafeInteger(botId) || botId <= 0 || entry.botId !== botId || entry.messageId !== messageId ||
            entry.authority.profile !== profile || entry.authority.operatorId !== operatorId || !areDeliveryTargetsEqual(entry.handle.target, target))
            return undefined;
        let valid = true;
        const assertCurrent = () => {
            try {
                if (!valid || deps.getConfirmationAuthority !== readAuthority || deps.isExplicitTargetAuthorized !== authorizeTarget ||
                    !bound() || observeQuestion(entry, readAuthority, authorizeTarget) !== undefined)
                    throw new TelegramDeliveryTransportGenerationError();
                const authorized = authorizeTarget.call(deps, target), authority = readAuthority.call(deps);
                if (!authorized || authority?.profile !== profile || authority.operatorId !== operatorId ||
                    !active || entry.phase !== "waiting" || questions.get(requestId) !== entry || Date.now() >= entry.deadline ||
                    entry.messageId !== messageId || entry.botId !== botId || deps.getConfirmationAuthority !== readAuthority ||
                    deps.isExplicitTargetAuthorized !== authorizeTarget || !bound() ||
                    [...questions.values()].filter(candidate => (candidate.kind === "text" || candidate.kind === "attachment") &&
                        candidate.messageId === messageId && candidate.handle.target.chatId === target.chatId).length !== 1)
                    throw new TelegramDeliveryTransportGenerationError();
            }
            catch {
                valid = false;
                throw new TelegramDeliveryTransportGenerationError();
            }
        };
        try {
            assertCurrent();
        }
        catch {
            return undefined;
        }
        if (entry.kind !== "attachment")
            return Object.freeze({ assertCurrent });
        const reserveSource = (owner) => {
            if (!owner || typeof owner !== "object")
                throw new TypeError("Invalid Attachment source reservation owner.");
            const prior = entry.sourceReservation;
            if (prior && prior.owner !== owner)
                return undefined;
            if (prior) {
                if (!prior.scope) {
                    prior.lost = true;
                    throw new TelegramDeliveryTransportGenerationError();
                }
                prior.scope.assertCurrent();
                return prior.scope;
            }
            if (entry.reservedSourceOwners?.has(owner))
                throw new TelegramDeliveryTransportGenerationError();
            (entry.reservedSourceOwners ??= new WeakSet()).add(owner);
            // Consume this reservation before authority callbacks, including caught reentry. Decline never renews an old owner.
            const record = { owner, lost: false, checking: false };
            entry.sourceReservation = record;
            const assertReservation = () => {
                if (record.lost || record.checking) {
                    record.lost = true;
                    throw new TelegramDeliveryTransportGenerationError();
                }
                record.checking = true;
                try {
                    assertCurrent();
                    if (record.lost || entry.sourceReservation !== record)
                        throw new TelegramDeliveryTransportGenerationError();
                }
                catch (error) {
                    record.lost = true;
                    throw error;
                }
                finally {
                    record.checking = false;
                }
            };
            assertReservation();
            record.scope = Object.freeze({ assertCurrent: assertReservation, getCancellationReceipt: () => record.cancellation, getEndReceipt: () => record.endReceipt, decline() {
                    if (record.handoffIssued) {
                        record.lost = true;
                        throw new TelegramDeliveryTransportGenerationError();
                    }
                    assertReservation();
                    record.lost = true;
                    entry.sourceReservation = undefined;
                }, handoff(materialize) {
                    if (record.handoffIssued || typeof materialize !== "function") {
                        record.lost = true;
                        throw new TelegramDeliveryTransportGenerationError();
                    }
                    // Consume before observations. The SDK takes custody of this exact provider, not a boolean receipt supplied by it.
                    record.handoffIssued = true;
                    record.provider = materialize;
                    try {
                        assertReservation();
                        const custody = Object.freeze({ assertAcknowledged() {
                                assertReservation();
                                if (record.provider !== materialize)
                                    throw new TelegramDeliveryTransportGenerationError();
                            } });
                        const output = materialize(custody);
                        const fields = isWireRecord(output) ? Object.getOwnPropertyDescriptors(output) : undefined;
                        const lease = fields?.lease?.value, dispose = fields?.dispose?.value;
                        const leaseFields = isWireRecord(lease) && Object.isFrozen(lease) ? Object.getOwnPropertyDescriptors(lease) : undefined;
                        const files = leaseFields?.files?.value, expiresAt = leaseFields?.expiresAt?.value, ended = leaseFields?.ended?.value;
                        if (!Object.isFrozen(output) || !fields || Object.keys(fields).length !== 2 || typeof dispose !== "function" ||
                            !lease || !leaseFields || Object.keys(leaseFields).length !== 3 || !Array.isArray(files) || !Object.isFrozen(files) ||
                            typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || !(ended instanceof Promise) ||
                            files.length < 1 || files.length > entry.constraints.maxFiles)
                            throw new TelegramDeliveryTransportGenerationError();
                        let bytes = 0;
                        for (let i = 0; i < files.length; i++) {
                            const file = Object.getOwnPropertyDescriptor(files, String(i))?.value;
                            const data = isWireRecord(file) && Object.isFrozen(file) ? Object.getOwnPropertyDescriptors(file) : undefined;
                            if (!data || data.expiresAt?.value !== expiresAt || typeof data.path?.value !== "string" || !data.path.value ||
                                !Number.isSafeInteger(data.byteLength?.value) || data.byteLength.value < 0 || !isWireRecord(data.metadata?.value) ||
                                !Object.isFrozen(data.metadata.value))
                                throw new TelegramDeliveryTransportGenerationError();
                            bytes += data.byteLength.value;
                            if (!Number.isSafeInteger(bytes) || bytes > entry.constraints.maxBytes)
                                throw new TelegramDeliveryTransportGenerationError();
                        }
                        assertReservation();
                        if (Date.now() >= expiresAt)
                            throw new TelegramDeliveryTransportGenerationError();
                        const delivered = finishQuestion(entry, "submitted", undefined, Object.freeze({ lease, dispose }));
                        if (!delivered)
                            throw new TelegramDeliveryTransportGenerationError();
                        return Object.freeze({ kind: "sdk-result", assertAcknowledged() {
                                if (!delivered)
                                    throw new TelegramDeliveryTransportGenerationError();
                            } });
                    }
                    catch (error) {
                        record.lost = true;
                        throw error;
                    }
                } });
            return record.scope;
        };
        return Object.freeze({ assertCurrent, constraints: entry.constraints, deadline: entry.deadline, reserveSource });
    }
    const openTaskView = async (raw, isBindingCurrent = () => true) => {
        const request = snapshotTaskViewRequest(raw), deadline = Date.now() + request.timeoutMs;
        const failOpen = (reason, effect = "not-issued") => ({ ok: false, reason, effect, message: "Telegram Task View did not open." });
        if (!active)
            return failOpen("runtime-unavailable");
        if (request.signal.aborted)
            return failOpen("aborted");
        if (questions.size + tasks.size >= 256)
            return failOpen("capacity-exceeded");
        const resolved = resolveTelegramDeliveryTarget(request.scope, deps);
        if (!resolved.ok)
            return failOpen(resolved.reason);
        const readAuthority = deps.getConfirmationAuthority, authorize = deps.isExplicitTargetAuthorized, send = deps.sendChunk, edit = deps.editChunk;
        const authority = readAuthority?.call(deps);
        if (!authority || !authority.profile || !Number.isSafeInteger(authority.operatorId) || authority.operatorId <= 0)
            return failOpen("runtime-unavailable");
        const capturedAuthority = { ...authority }, target = Object.freeze(cloneTarget(resolved.value)), id = randomBytes(16).toString("hex");
        const result = Promise.withResolvers();
        const cancellation = Promise.withResolvers();
        let latest = request.state, pending, inflight, queued = false, revision = 0, opening = true, terminalPending = latest.status !== "running", requested = false, cancelIssued = false, lost = false, checking = false, sendAttempted = false;
        let ended, delivery;
        let openingFailure, cleanupStarted = false;
        const notify = captureTelegramDrainObserver(deps.captureDrain);
        const taskView = (state, closed = false) => {
            const status = state.status === "running" ? "In progress" : state.status === "completed" ? "Completed"
                : state.status === "failed" ? "Failed" : "Cancelled";
            return { text: `<b>📊 ${escapeHtml(request.title)}</b>\n${escapeHtml(state.text)}\n${status}` +
                    (state.progress === undefined ? "" : ` · ${Math.round(state.progress * 100)}%`) +
                    (closed ? "\n<b>🚫 View closed.</b>" : requested && state.status === "running"
                        ? "\n<b>⏳ Cancellation requested; waiting for producer acknowledgement.</b>" : ""), parseMode: "html",
                replyMarkup: { inline_keyboard: !closed && state.status === "running" && request.cancellable && !requested
                        ? [[{ text: request.cancelLabel, callback_data: `tgtask:${id}:cancel` }]] : [] } };
        };
        const oneChunk = (view) => {
            const rendered = render(view);
            if (!rendered.ok || rendered.value.length !== 1)
                throw new TypeError("A Task View must fit one message.");
            return rendered.value[0];
        };
        const assertScope = (live = true) => {
            if (checking) {
                lost = true;
                throw new TelegramDeliveryTransportGenerationError();
            }
            checking = true;
            try {
                const current = readAuthority?.call(deps);
                if (lost || !active || isBindingCurrent() !== true || deps.getConfirmationAuthority !== readAuthority ||
                    deps.isExplicitTargetAuthorized !== authorize || deps.sendChunk !== send || deps.editChunk !== edit ||
                    current?.profile !== capturedAuthority.profile || current?.operatorId !== capturedAuthority.operatorId ||
                    !authorize.call(deps, target) || (delivery && !resolveHandle(delivery).ok) ||
                    (live && (ended !== undefined || tasks.get(id) !== entry)) || lost || !active || isBindingCurrent() !== true ||
                    deps.getConfirmationAuthority !== readAuthority || deps.isExplicitTargetAuthorized !== authorize ||
                    deps.sendChunk !== send || deps.editChunk !== edit)
                    throw new TelegramDeliveryTransportGenerationError();
            }
            catch (error) {
                lost = true;
                throw error;
            }
            finally {
                checking = false;
            }
        };
        const cleanupProjection = () => {
            if (cleanupStarted)
                return;
            if (active && delivery && !lost) {
                cleanupStarted = true;
                const view = taskView(latest, true);
                void runForTarget(target, async () => {
                    const chunk = oneChunk(view);
                    assertScope(false);
                    await edit.call(deps, target, delivery.messageIds[0], chunk, {
                        replyMarkup: view.replyMarkup, assertAuthority: () => assertScope(false),
                    });
                }).catch(error => { transportFailure("edit", error, target); });
            }
        };
        const finish = (status, cleanup = true) => {
            if (ended !== undefined)
                return;
            ended = status;
            tasks.delete(id);
            clearTimeout(timer);
            request.signal.removeEventListener("abort", abort);
            result.resolve(Object.freeze({ status }));
            if (!requested)
                cancellation.resolve(Object.freeze({ status: "closed", reason: status }));
            pending?.resolve?.(taskViewUpdateFailure());
            pending = undefined;
            inflight?.resolve?.(taskViewUpdateFailure(inflight.attempted));
            if (cleanup)
                cleanupProjection();
            if (active && !targetQueue.hasPendingTarget(target))
                notify();
        };
        const current = () => {
            if (ended !== undefined)
                return false;
            if (Date.now() >= deadline) {
                finish("expired");
                return false;
            }
            if (request.signal.aborted) {
                finish("aborted");
                return false;
            }
            try {
                assertScope();
                return true;
            }
            catch {
                finish("invalidated", false);
                return false;
            }
        };
        const assertLive = () => { if (!current())
            throw new TelegramDeliveryTransportGenerationError(); };
        const pump = () => {
            if (queued || opening || !pending || !current())
                return;
            queued = true;
            let issued;
            void runForTarget(target, async () => {
                assertLive();
                issued = pending;
                inflight = issued;
                pending = undefined;
                if (!issued)
                    return;
                const view = taskView(issued.state);
                const chunk = oneChunk(view);
                assertLive();
                issued.attempted = true;
                try {
                    await edit.call(deps, target, delivery.messageIds[0], chunk, { replyMarkup: view.replyMarkup, assertAuthority: assertLive });
                    assertLive();
                }
                catch (error) {
                    // Fence queued disposal before the target queue releases this actual attempt.
                    lost = true;
                    throw error;
                }
                issued.resolve?.({ ok: true, value: Object.freeze({ revision: issued.revision, status: "applied" }) });
                if (issued.state.status !== "running")
                    finish(issued.state.status, false);
            }).catch(error => {
                issued?.resolve?.(taskViewUpdateFailure(issued.attempted));
                finish("invalidated", false);
                transportFailure("edit", error, target);
            }).finally(() => { inflight = undefined; queued = false; pump(); });
        };
        const queueUpdate = (state, resolve) => {
            pending?.resolve?.({ ok: true, value: Object.freeze({ revision: pending.revision, status: "superseded" }) });
            latest = state;
            pending = { state, revision: ++revision, resolve };
            pump();
        };
        const handle = Object.freeze({ id, target, generation: deps.generation, result: result.promise,
            cancellation: cancellation.promise,
            update(value) {
                const state = snapshotTaskViewState(value);
                if (!current() || opening || terminalPending)
                    return Promise.resolve(taskViewUpdateFailure());
                const view = taskView(state);
                oneChunk(view);
                if (!current() || terminalPending)
                    return Promise.resolve(taskViewUpdateFailure());
                if (state.status !== "running")
                    terminalPending = true;
                return new Promise(resolve => queueUpdate(state, resolve));
            },
            close() { finish("closed"); }, });
        const entry = { handle, finish,
            accept(query, assertAuthority) {
                if (opening || terminalPending || cancelIssued || requested || !request.cancellable || query.from?.id !== capturedAuthority.operatorId ||
                    query.message?.chat?.id !== target.chatId || query.message.message_thread_id !== target.threadId ||
                    query.message.message_id !== delivery?.messageIds[0] || Reflect.has(query.message, "business_connection_id") || !current())
                    return { handled: true, accepted: false };
                cancelIssued = true;
                try {
                    assertAuthority?.();
                    assertLive();
                }
                catch (error) {
                    finish("invalidated", false);
                    throw error;
                }
                requested = true;
                cancellation.resolve(Object.freeze({ status: "requested" }));
                if (!pending)
                    queueUpdate(latest);
                return { handled: true, accepted: true, assertCurrent: () => assertScope(false) };
            },
        };
        const abort = () => finish("aborted");
        const timer = setTimeout(() => finish("expired"), Math.max(1, deadline - Date.now()));
        timer.unref?.();
        tasks.set(id, entry);
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted)
            abort();
        const published = runForTarget(target, async () => {
            try {
                const view = taskView(latest), chunk = oneChunk(view);
                assertLive();
                sendAttempted = true;
                const messageId = await send.call(deps, target, chunk, { replyMarkup: view.replyMarkup, assertAuthority: assertLive });
                if (!Number.isSafeInteger(messageId) || messageId <= 0)
                    throw new Error("Task View has no message identity.");
                delivery = createHandle(target, [messageId]);
                if (ended !== undefined)
                    cleanupProjection();
                assertLive();
                opening = false;
                if (latest.status !== "running")
                    finish(latest.status, false);
                return { ok: true, handle };
            }
            catch (error) {
                const failureResult = transportFailure("send", error, target);
                openingFailure = failOpen(!failureResult.ok ? failureResult.reason : "invalidated", sendAttempted ? "unknown" : "not-issued");
                finish("invalidated", false);
                return openingFailure;
            }
        });
        const terminated = result.promise.then((value) => ["completed", "failed", "cancelled"].includes(value.status) && delivery ? { ok: true, handle }
            : openingFailure ?? failOpen(value.status === "expired" || value.status === "aborted" ? value.status : "invalidated", sendAttempted ? "unknown" : "not-issued"));
        return Promise.race([published, terminated]);
    };
    const runtime = {
        generation: deps.generation,
        captureQuestionLifetimeOwner,
        openTaskView,
        acceptTaskCancel(query, assertAuthority) {
            if (!query.data?.startsWith("tgtask:"))
                return { handled: false };
            assertAuthority?.();
            const match = /^tgtask:([a-f0-9]{32}):cancel$/u.exec(query.data);
            return (match && tasks.get(match[1])?.accept(query, assertAuthority)) || { handled: true, accepted: false };
        },
        hasPendingTarget: target => [...artifactTargets.values()].some(value => areDeliveryTargetsEqual(value, target)) || targetQueue.hasPendingTarget(target) ||
            [...questions.values()].some(entry => areDeliveryTargetsEqual(entry.handle.target, target)) ||
            [...tasks.values()].some(entry => areDeliveryTargetsEqual(entry.handle.target, target)),
        shutdown() {
            active = false;
            for (const entry of [...questions.values()])
                finishQuestion(entry, "invalidated");
            for (const entry of [...tasks.values()])
                entry.finish("invalidated", false);
        },
        async sendArtifact(raw, isBindingCurrent) {
            const request = snapshotArtifactRequest(raw), expiresAt = Date.now() + request.timeoutMs;
            if (!active || !isBindingCurrent())
                return artifactFailure("runtime-unavailable");
            const resolved = resolveTelegramDeliveryTarget(request.scope, deps);
            if (!resolved.ok)
                return artifactFailure(resolved.reason === "target-unauthorized" ? "target-unauthorized" : "target-unavailable");
            const target = Object.freeze(cloneTarget(resolved.value));
            if (artifactBusy)
                return artifactFailure("capacity-exceeded");
            artifactBusy = true;
            let transport;
            try {
                transport = deps.captureArtifactTransport?.(target, request.scope);
            }
            catch { /* Missing authority refuses before disclosure. */ }
            if (!transport) {
                artifactBusy = false;
                return artifactFailure("runtime-unavailable");
            }
            const operationKey = randomBytes(16).toString("hex");
            artifactTargets.set(operationKey, target);
            const notify = captureTelegramDrainObserver(deps.captureDrain), controller = new AbortController();
            let phase = "capture", lost = false;
            const assertCurrent = () => {
                const currentTarget = request.scope.kind === "active-turn" ? deps.getActiveTurnTarget() : request.scope.kind === "instance" ? deps.getInstanceTarget() : target;
                lost ||= !active || !isBindingCurrent() || !transport.isCurrent() || !deps.isExplicitTargetAuthorized(target) || !currentTarget || !areDeliveryTargetsEqual(target, currentTarget);
                if (lost || request.signal.aborted || controller.signal.aborted || Date.now() >= expiresAt)
                    throw new TelegramApiAuthorityError(phase === "transport");
            };
            let settleWait;
            const ended = new Promise(resolve => { settleWait = resolve; });
            const stopWait = (reason) => {
                clearTimeout(timer);
                controller.abort();
                settleWait(artifactFailure(reason, phase === "capture" ? "not-issued" : "unknown"));
            };
            const abort = () => stopWait("aborted");
            request.signal.addEventListener("abort", abort, { once: true });
            const timer = setTimeout(() => stopWait("expired"), request.timeoutMs);
            timer.unref?.();
            const work = (async () => {
                try {
                    assertCurrent();
                    const bytes = await captureTelegramArtifactSource(request.file.path);
                    assertCurrent();
                    return await runForTarget(target, async () => {
                        assertCurrent();
                        phase = "transport";
                        const result = await transport.send({ bytes, fileName: request.file.name, caption: request.caption, expiresAt,
                            signal: controller.signal, assertAuthority: assertCurrent });
                        const receipt = Number.isSafeInteger(result.messageId) && result.messageId > 0 ? Object.freeze({ kind: "document", target,
                            generation: deps.generation, messageId: result.messageId, fileName: request.file.name, byteLength: bytes.byteLength }) : undefined;
                        try {
                            assertCurrent();
                        }
                        catch {
                            return artifactFailure("invalidated", result.effect === "not-issued" ? "not-issued" : "unknown", receipt);
                        }
                        if (result.effect === "sent" && receipt)
                            return { ok: true, receipt };
                        const reason = result.effect === "rejected" ? "transport-rejected" : result.effect === "unknown" || result.effect === "sent" ? "commit-unknown" :
                            result.reason === "capacity-exceeded" ? "capacity-exceeded" : "invalidated";
                        return artifactFailure(reason, result.effect === "sent" ? "unknown" : result.effect, receipt);
                    });
                }
                catch (error) {
                    try {
                        const recorded = deps.recordFailure?.("send", error, target);
                        if (recorded)
                            void Promise.resolve(recorded).catch(() => undefined);
                    }
                    catch { /* Origin diagnostics cannot replace a bounded result. */ }
                    if (error instanceof TelegramArtifactSourceError)
                        return artifactFailure(error.reason);
                    return artifactFailure(request.signal.aborted ? "aborted" : Date.now() >= expiresAt ? "expired" : "invalidated", phase === "capture" ? "not-issued" : "unknown");
                }
                finally {
                    clearTimeout(timer);
                    request.signal.removeEventListener("abort", abort);
                    artifactBusy = false;
                    artifactTargets.delete(operationKey);
                    notify();
                }
            })();
            if (request.signal.aborted)
                abort();
            return Promise.race([work, ended]);
        },
        openConfirmation(request, owned) { return openQuestion({ kind: "confirmation", request, owned }); },
        openChoice(request) { return openQuestion({ kind: "choice", request }); },
        openAttachmentQuestion(raw) { return openQuestion({ kind: "attachment", request: snapshotAttachmentQuestion(raw) }); },
        captureAttachmentReceiver(identity) { return captureInputReceiver("attachment", identity); },
        acceptAttachmentCancel(query, assertAuthority) {
            if (!query.data?.startsWith("tgattach:"))
                return { handled: false };
            assertAuthority?.();
            const match = /^tgattach:([a-f0-9]{32}):cancel$/u.exec(query.data), entry = match ? questions.get(match[1]) : undefined;
            if (entry?.kind !== "attachment" || !canAnswer(entry, query, assertAuthority) || !finishQuestion(entry, "cancelled"))
                return { handled: true, accepted: false };
            return { handled: true, accepted: true, handle: entry.handle, decision: Object.freeze({ status: "cancelled" }), assertCurrent: acceptedAuthority(entry) };
        },
        openTextInput(request) { return openQuestion({ kind: "text", request }); },
        captureTextInputReceiver(identity) { return captureInputReceiver("text", identity); },
        captureTextInputSource,
        acceptTextInputReply(message, requestId, assertAuthority, edited = false) {
            assertAuthority?.();
            if (!/^[a-f0-9]{32}$/u.test(requestId))
                return { handled: true, accepted: false, reason: "invalid-source" };
            return runtime.acceptTextInput(message, assertAuthority, edited, requestId);
        },
        acceptTextInput(message, assertAuthority, edited = false, expectedRequestId) {
            const replyId = message.reply_to_message?.message_id, chatId = message.chat?.id;
            if (!Number.isSafeInteger(replyId) || replyId <= 0 || chatId === undefined)
                return { handled: false };
            pruneRetiredTextInputs();
            const matches = [...questions.values()].filter((candidate) => candidate.kind === "text" && candidate.messageId === replyId && candidate.handle.target.chatId === chatId);
            if (matches.length > 1) {
                assertAuthority?.();
                return { handled: true, accepted: false, reason: "invalid-source" };
            }
            const entry = matches[0];
            if (!entry) {
                if (!retiredTextInputs.has(`${chatId}:${replyId}`))
                    return { handled: false };
                assertAuthority?.();
                return { handled: true, accepted: false, reason: "unavailable" };
            }
            assertAuthority?.();
            if (expectedRequestId !== undefined && entry.handle.id !== expectedRequestId)
                return { handled: true, accepted: false, reason: "invalid-source" };
            if (!Number.isSafeInteger(message.message_id) || message.message_id <= 0 ||
                ["business_connection_id", "guest_query_id", "ephemeral_message_id"].some(key => Reflect.has(message, key))) {
                return { handled: true, accepted: false, reason: "invalid-source" };
            }
            const query = { from: message.from, message: { chat: message.chat, message_thread_id: message.message_thread_id, message_id: replyId } };
            if (!canAnswer(entry, query, assertAuthority))
                return { handled: true, accepted: false,
                    reason: entry.phase === "waiting" ? "invalid-source" : "unavailable" };
            const text = message.text;
            const hasNonText = ["caption", "media_group_id", "document", "photo", "voice", "audio", "video", "video_note",
                "animation", "sticker", "contact", "location", "venue", "poll", "dice", "game"].some(key => Reflect.has(message, key));
            if (edited || message.edit_date !== undefined || hasNonText || typeof text !== "string" ||
                !isValidTextInputAnswer(text, entry.maxLength, entry.multiline))
                return { handled: true, accepted: false, reason: "invalid-answer" };
            if (!questionCurrent(entry) || !finishQuestion(entry, "submitted", text))
                return { handled: true, accepted: false, reason: "unavailable" };
            return { handled: true, accepted: true, handle: entry.handle, decision: Object.freeze({ status: "submitted", text }),
                assertCurrent: acceptedAuthority(entry) };
        },
        acceptTextInputCancel(query, assertAuthority) {
            if (!query.data?.startsWith("tginput:"))
                return { handled: false };
            assertAuthority?.();
            const match = /^tginput:([a-f0-9]{32}):cancel$/u.exec(query.data);
            const entry = match ? questions.get(match[1]) : undefined;
            if (entry?.kind !== "text" || !canAnswer(entry, query, assertAuthority) || !finishQuestion(entry, "cancelled")) {
                return { handled: true, accepted: false, reason: "unavailable" };
            }
            return { handled: true, accepted: true, handle: entry.handle, decision: Object.freeze({ status: "cancelled" }),
                assertCurrent: acceptedAuthority(entry) };
        },
        acceptConfirmation(query, assertAuthority) {
            if (!query.data?.startsWith("tgconfirm:"))
                return { handled: false };
            assertAuthority?.();
            const match = /^tgconfirm:([a-f0-9]{32}):(yes|no)$/u.exec(query.data);
            const entry = match ? questions.get(match[1]) : undefined;
            if (entry?.kind !== "confirmation" || !canAnswer(entry, query, assertAuthority))
                return { handled: true, accepted: false };
            const status = match[2] === "yes" ? "confirmed" : "cancelled";
            if (!finishQuestion(entry, status))
                return { handled: true, accepted: false };
            return { handled: true, accepted: true, handle: entry.handle, decision: { status }, assertCurrent: acceptedAuthority(entry),
                ...(entry.owned ? { callbackData: status === "confirmed" ? entry.owned.confirmedData : entry.owned.cancelledData } : {}) };
        },
        acceptChoice(query, assertAuthority) {
            if (!query.data?.startsWith("tgchoice:"))
                return { handled: false };
            assertAuthority?.();
            const match = /^tgchoice:([a-f0-9]{32}):(cancel|0|[1-9][0-9]?)$/u.exec(query.data);
            const entry = match ? questions.get(match[1]) : undefined;
            if (entry?.kind !== "choice" || !canAnswer(entry, query, assertAuthority))
                return { handled: true, accepted: false };
            const option = match[2] === "cancel" ? undefined : entry.choices[Number(match[2])];
            if (match[2] !== "cancel" && (!option || option.disabled))
                return { handled: true, accepted: false };
            const decision = option ? { status: "selected", choiceId: option.id } : { status: "cancelled" };
            if (!finishQuestion(entry, decision.status, option?.id))
                return { handled: true, accepted: false };
            return { handled: true, accepted: true, handle: entry.handle, decision, assertCurrent: acceptedAuthority(entry) };
        },
        async sendView(view, options) {
            if (!active)
                return inactive();
            const resolved = resolveTelegramDeliveryTarget(options.scope, deps);
            if (!resolved.ok)
                return failure(resolved.reason, resolved.message);
            const rendered = render(view);
            if (!rendered.ok)
                return failure(rendered.reason, rendered.message);
            const target = resolved.value;
            return runForTarget(target, async () => {
                if (!active)
                    return inactive();
                const messageIds = [];
                try {
                    for (const [index, chunk] of rendered.value.entries()) {
                        if (!active)
                            return inactive();
                        const messageId = await deps.sendChunk(target, chunk, getChunkTransportOptions(view, index, rendered.value.length, options.replyToMessageId));
                        messageIds.push(messageId);
                        if (!active)
                            return inactive();
                    }
                    return { ok: true, value: createHandle(target, messageIds) };
                }
                catch (error) {
                    return active
                        ? transportFailure("send", error, target, messageIds.length > 0
                            ? createHandle(target, messageIds)
                            : undefined)
                        : inactive();
                }
            });
        },
        async editView(handle, view) {
            const resolved = resolveHandle(handle);
            if (!resolved.ok)
                return failure(resolved.reason, resolved.message);
            const rendered = render(view);
            if (!rendered.ok)
                return failure(rendered.reason, rendered.message);
            const target = resolved.value.target;
            return runForTarget(target, async () => {
                if (!active)
                    return inactive();
                const visibleMessageIds = [...resolved.value.messageIds];
                try {
                    const sharedCount = Math.min(visibleMessageIds.length, rendered.value.length);
                    for (let index = 0; index < sharedCount; index += 1) {
                        if (!active)
                            return inactive();
                        await deps.editChunk(target, visibleMessageIds[index], rendered.value[index], getChunkTransportOptions(view, index, rendered.value.length, undefined, true));
                        if (!active)
                            return inactive();
                    }
                    for (let index = sharedCount; index < rendered.value.length; index += 1) {
                        if (!active)
                            return inactive();
                        visibleMessageIds.push(await deps.sendChunk(target, rendered.value[index], getChunkTransportOptions(view, index, rendered.value.length)));
                        if (!active)
                            return inactive();
                    }
                    const removedMessageIds = visibleMessageIds.slice(rendered.value.length);
                    for (const messageId of removedMessageIds) {
                        if (!active)
                            return inactive();
                        await deps.deleteMessage(target, messageId);
                        visibleMessageIds.splice(visibleMessageIds.indexOf(messageId), 1);
                        if (!active)
                            return inactive();
                    }
                    return {
                        ok: true,
                        value: createHandle(target, visibleMessageIds),
                    };
                }
                catch (error) {
                    return active
                        ? transportFailure("edit", error, target, createHandle(target, visibleMessageIds))
                        : inactive();
                }
            });
        },
        async deleteView(handle) {
            const resolved = resolveHandle(handle);
            if (!resolved.ok)
                return failure(resolved.reason, resolved.message);
            const target = resolved.value.target;
            return runForTarget(target, async () => {
                if (!active)
                    return inactive();
                try {
                    for (const messageId of resolved.value.messageIds) {
                        if (!active)
                            return inactive();
                        await deps.deleteMessage(target, messageId);
                        if (!active)
                            return inactive();
                    }
                    return { ok: true, value: undefined };
                }
                catch (error) {
                    return active
                        ? transportFailure("delete", error, target)
                        : inactive();
                }
            });
        },
        async sendChatAction(action, scope) {
            if (!active)
                return inactive();
            const resolved = resolveTelegramDeliveryTarget(scope, deps);
            if (!resolved.ok)
                return failure(resolved.reason, resolved.message);
            const target = resolved.value;
            return runForTarget(target, async () => {
                if (!active)
                    return inactive();
                try {
                    await deps.sendChatAction(target, action);
                    if (!active)
                        return inactive();
                    return { ok: true, value: undefined };
                }
                catch (error) {
                    return active
                        ? transportFailure("chat-action", error, target)
                        : inactive();
                }
            });
        },
    };
    return runtime;
}
/** @internal */
export function createTelegramBridgeDeliveryRuntime(deps) {
    const questionPolicy = captureTelegramBridgeQuestionPolicy(deps);
    const getPolicyView = deps.getTargetPolicyView;
    const getInputReceiverBotId = deps.getTextInputReceiverBotId;
    const assertTransportActive = () => {
        if (deps.isTransportActive?.() === false) {
            throw new TelegramDeliveryTransportGenerationError();
        }
    };
    const assertOutputTarget = (target) => {
        if (isThreadedDelivery(getPolicyView()) && target.threadId === undefined)
            throw new Error("Telegram All is input-only in Threaded Mode.");
    };
    const getAttachmentBotId = deps.getAttachmentReceiverBotId, readAttachmentProfile = deps.getProfileName, readAttachmentTransport = deps.isTransportActive, captureAttachmentOrigin = deps.captureInputPublication, attachmentApi = deps.api, sendAttachment = deps.api.sendMessage, captureAttachmentPeer = deps.api.captureAttachmentPublication;
    const publishAttachmentQuestion = getAttachmentBotId ? async (rawTarget, rawChunk, options) => {
        const target = Object.freeze(cloneTarget(rawTarget)), markup = structuredClone(options.replyMarkup);
        const text = rawChunk.text, parseMode = rawChunk.parseMode, assertQuestion = options.assertAuthority;
        if (!getTelegramAttachmentControlId(markup) || options.replyToMessageId !== undefined)
            throw new Error("Attachment publication requires an exact private question.");
        const direct = getPolicyView().ownsDirect, profile = readAttachmentProfile?.call(deps), botId = readTelegramTextInputReceiverBotId(getAttachmentBotId, target);
        const peer = direct ? undefined : captureAttachmentPeer?.call(attachmentApi, target), peerGuard = peer?.assertCurrent, publishPeer = peer?.publish;
        let lost = false, checking = false, receiptReturned = false;
        let record, assertOrigin;
        const portsCurrent = () => deps.getTargetPolicyView === getPolicyView && deps.getProfileName === readAttachmentProfile &&
            deps.isTransportActive === readAttachmentTransport && deps.getAttachmentReceiverBotId === getAttachmentBotId &&
            deps.captureInputPublication === captureAttachmentOrigin && deps.api === attachmentApi && deps.api.sendMessage === sendAttachment &&
            deps.api.captureAttachmentPublication === captureAttachmentPeer && peer?.assertCurrent === peerGuard && peer?.publish === publishPeer &&
            record?.assertCurrent === assertOrigin;
        const assertNative = () => {
            if (lost || typeof direct !== "boolean" || !profile || botId === undefined || !portsCurrent())
                throw new TelegramDeliveryTransportGenerationError();
            assertTransportActive();
            assertOutputTarget(target);
            const policy = getPolicyView();
            if (policy.ownsDirect !== direct || !direct && (!peer || !peerGuard || !publishPeer) || !policy.canDeliver || !isTelegramDeliveryExplicitTargetAuthorized(target, policy) ||
                readAttachmentProfile?.call(deps) !== profile || readTelegramTextInputReceiverBotId(getAttachmentBotId, target) !== botId || !portsCurrent())
                throw new TelegramDeliveryTransportGenerationError();
            if (!direct) {
                peerGuard.call(peer);
                assertOrigin?.call(record);
            }
            if (lost || !portsCurrent() || getPolicyView().ownsDirect !== direct)
                throw new TelegramDeliveryTransportGenerationError();
        };
        const assertRetained = () => {
            if (checking) {
                lost = true;
                throw new TelegramDeliveryTransportGenerationError();
            }
            checking = true;
            try {
                assertNative();
            }
            catch (error) {
                lost = true;
                throw error;
            }
            finally {
                checking = false;
            }
        };
        const assertPublication = () => {
            assertRetained();
            assertQuestion?.();
            assertRetained();
        };
        assertPublication();
        record = captureAttachmentOrigin?.call(deps, target);
        assertOrigin = record?.assertCurrent;
        if (!record || !direct && !assertOrigin)
            throw new Error("Attachment publication ownership is unavailable.");
        assertPublication();
        try {
            const body = { chat_id: target.chatId, text,
                ...(parseMode === "html" ? { parse_mode: "HTML" } : {}), ...getTelegramTargetThreadParams(target), reply_markup: markup };
            const sent = direct ? await sendAttachment.call(attachmentApi, body, { assertAuthority: assertPublication }) : await publishPeer.call(peer, body, assertPublication);
            receiptReturned = true;
            assertPublication();
            const messageId = "message_id" in sent ? sent.message_id : sent.messageId;
            if (!Number.isSafeInteger(messageId) || messageId <= 0 || "botId" in sent && sent.botId !== botId)
                throw new Error("Attachment publication receipt is unavailable.");
            record(messageId);
            assertPublication();
            return direct ? messageId : Object.freeze({ messageId, assertCurrent: assertRetained });
        }
        catch (error) {
            // Invocation alone is not HTTP issuance proof; an unexplained failure still cannot certify no effect.
            const refusedBeforeIssue = error instanceof TelegramApiAuthorityError && !error.requestIssued;
            if (!isTelegramApiCommitUnknownError(error) && (receiptReturned || !refusedBeforeIssue && !isTelegramApiRequestRejected(error, "sendMessage")))
                throw new TelegramApiCommitUnknownError("sendMessage", error);
            throw error;
        }
    } : undefined;
    const uiAuthority = (target, assertCurrent) => {
        const assertAuthority = () => { assertTransportActive(); assertOutputTarget(target); assertCurrent(); };
        return getPolicyView().ownsDirect ? { assertAuthority } : { assertLocalAuthority: assertAuthority };
    };
    return createTelegramDeliveryRuntime({
        ...questionPolicy,
        generation: deps.generation,
        captureDrain: deps.captureDrain,
        captureArtifactTransport(target, scope) {
            const transport = deps.api.captureArtifactTransport?.(target), session = deps.captureArtifactSession?.();
            const turn = scope.kind === "active-turn" ? deps.getActiveTurnIdentity?.() : undefined;
            const profile = deps.getProfileName?.(), direct = getPolicyView().ownsDirect;
            if (!transport || !session || scope.kind === "active-turn" && !turn)
                return undefined;
            let lost = false;
            const isCurrent = () => {
                try {
                    lost ||= !session() || !transport.isCurrent() || deps.isTransportActive?.() === false || deps.getProfileName?.() !== profile ||
                        getPolicyView().ownsDirect !== direct || scope.kind === "active-turn" && deps.getActiveTurnIdentity?.() !== turn ||
                        !isTelegramDeliveryExplicitTargetAuthorized(target, getPolicyView());
                }
                catch {
                    lost = true;
                }
                return !lost;
            };
            return isCurrent() ? { isCurrent, async send(input) {
                    const result = await transport.send(input);
                    if (result.effect !== "sent" || !Number.isSafeInteger(result.messageId) || result.messageId <= 0)
                        return result;
                    try {
                        if (!isCurrent())
                            throw new TelegramDeliveryTransportGenerationError();
                        deps.recordOwnership({ chatId: target.chatId, target, messageId: result.messageId });
                        if (!isCurrent())
                            throw new TelegramDeliveryTransportGenerationError();
                        return result;
                    }
                    catch (error) {
                        try {
                            const recorded = deps.recordFailure?.("send", error, target);
                            if (recorded)
                                void Promise.resolve(recorded).catch(() => undefined);
                        }
                        catch { /* Origin diagnostics are non-authoritative. */ }
                        return { effect: "unknown", reason: "commit-unknown", messageId: result.messageId };
                    }
                } } : undefined;
        },
        getAttachmentReceiverBotId: getAttachmentBotId ? target => readTelegramTextInputReceiverBotId(getAttachmentBotId, target) : undefined,
        publishAttachmentQuestion,
        getTextInputReceiverBotId: target => readTelegramTextInputReceiverBotId(getInputReceiverBotId, target),
        getConfirmationAuthority() {
            const profile = deps.getProfileName?.(), view = getPolicyView();
            return profile && view.canDeliver && view.allowedChatId !== undefined && deps.isTransportActive?.() !== false
                ? { profile, operatorId: view.allowedChatId } : undefined;
        },
        getActiveTurnTarget() {
            const target = deps.getActiveTurnTarget();
            return target && (!isThreadedDelivery(getPolicyView()) || target.threadId !== undefined) ? target : undefined;
        },
        getInstanceTarget() {
            return resolveTelegramDeliveryInstanceTarget(getPolicyView());
        },
        getAggregateTarget() {
            return resolveTelegramDeliveryAggregateTarget(getPolicyView());
        },
        isExplicitTargetAuthorized(target) {
            return isTelegramDeliveryExplicitTargetAuthorized(target, getPolicyView());
        },
        renderView(view) {
            assertTelegramInlineKeyboardCallbackData(view.replyMarkup);
            return renderTelegramMessage(view.text, {
                mode: view.parseMode ?? "plain",
            }).map(function (chunk) {
                return {
                    text: chunk.text,
                    parseMode: chunk.parseMode === "HTML" ? "html" : "plain",
                };
            });
        },
        async sendChunk(target, chunk, options) {
            assertTransportActive();
            assertOutputTarget(target);
            options.assertAuthority?.();
            if (getTelegramAttachmentControlId(options.replyMarkup))
                throw new Error("Attachment publication requires its dedicated original owner.");
            const inputId = getTelegramTextInputControlId(options.replyMarkup);
            const botId = inputId ? readTelegramTextInputReceiverBotId(getInputReceiverBotId, target) : undefined;
            if (inputId && botId === undefined)
                throw new Error("Text Input receiver is unavailable.");
            const assertPublication = inputId ? () => {
                if (readTelegramTextInputReceiverBotId(getInputReceiverBotId, target) !== botId)
                    throw new TelegramDeliveryTransportGenerationError();
                options.assertAuthority?.();
            } : options.assertAuthority;
            const recordInput = inputId ? deps.captureInputPublication?.({ ...target }) : undefined;
            if (inputId && !recordInput)
                throw new Error("Text Input publication ownership is unavailable.");
            let receiptReturned = false;
            try {
                const sent = await withTelegramReplyParameters(target.chatId, options.replyToMessageId, target, (replyParameters) => {
                    const body = {
                        chat_id: target.chatId,
                        text: chunk.text,
                        ...(chunk.parseMode === "html"
                            ? { parse_mode: "HTML" }
                            : {}),
                        ...getTelegramTargetThreadParams(target),
                        ...(replyParameters ? { reply_parameters: replyParameters } : {}),
                        ...(options.replyMarkup
                            ? { reply_markup: options.replyMarkup }
                            : {}),
                    };
                    return assertPublication
                        ? deps.api.sendMessage(body, uiAuthority(target, assertPublication))
                        : deps.api.sendMessage(body);
                });
                receiptReturned = true;
                assertTransportActive();
                assertPublication?.();
                if (recordInput)
                    recordInput(sent.message_id);
                else
                    deps.recordOwnership({ chatId: target.chatId, messageId: sent.message_id, target });
                return sent.message_id;
            }
            catch (error) {
                if (inputId && !isTelegramApiCommitUnknownError(error) &&
                    (receiptReturned || error instanceof TelegramApiAuthorityError && error.requestIssued)) {
                    throw new TelegramApiCommitUnknownError("sendMessage", error);
                }
                throw error;
            }
        },
        async editChunk(target, messageId, chunk, options) {
            assertTransportActive();
            assertOutputTarget(target);
            options.assertAuthority?.();
            const body = {
                chat_id: target.chatId,
                message_id: messageId,
                text: chunk.text,
                ...(chunk.parseMode === "html" ? { parse_mode: "HTML" } : {}),
                reply_markup: options.replyMarkup === null
                    ? { inline_keyboard: [] } : options.replyMarkup,
            };
            if (options.assertAuthority)
                await deps.api.editMessageText(body, uiAuthority(target, options.assertAuthority));
            else
                await deps.api.editMessageText(body);
        },
        deleteMessage(target, messageId) {
            assertTransportActive();
            return deps.api.deleteMessage(target.chatId, messageId);
        },
        async sendChatAction(target, action) {
            assertTransportActive();
            assertOutputTarget(target);
            await deps.api.sendChatAction(target.chatId, action, {
                message_thread_id: target.threadId,
            });
        },
        recordFailure: deps.recordFailure,
    });
}
function getBoundTelegramDeliveryRuntime() {
    const runtime = getTelegramDeliveryRuntimeRegistry().runtime;
    return (runtime ??
        failure("runtime-unavailable", "Telegram delivery runtime is unavailable in this Pi session."));
}
function isFailure(value) {
    return "ok" in value;
}
function validateView(view) {
    if (typeof view.text !== "string" || view.text.trim().length === 0) {
        return failure("invalid-view", "Telegram delivery view text is empty.");
    }
    return undefined;
}
async function runDeliveryOperation(operation) {
    const runtime = getBoundTelegramDeliveryRuntime();
    if (isFailure(runtime))
        return runtime;
    try {
        return await operation(runtime);
    }
    catch {
        return failure("transport-failed", "Telegram delivery failed.");
    }
}
/** One public operation resolves the current optional port and captures every binding, including equal-object rebinds. */
export function sendTelegramArtifact(raw) {
    const request = snapshotArtifactRequest(raw), registry = getTelegramDeliveryRuntimeRegistry(), { runtime, binding } = registry;
    if (!runtime?.sendArtifact || !binding)
        return Promise.resolve(artifactFailure("runtime-unavailable"));
    const send = runtime.sendArtifact;
    let lost = false;
    const current = () => { lost ||= registry.runtime !== runtime || registry.binding !== binding || runtime.sendArtifact !== send; return !lost; };
    return send.call(runtime, request, current);
}
/** @internal */
export function bindTelegramDeliveryRuntime(runtime) {
    const registry = getTelegramDeliveryRuntimeRegistry();
    retireQuestionBinding(registry.binding);
    if (registry.runtime !== runtime)
        registry.runtime?.shutdown();
    registry.runtime = runtime;
    let binding;
    try {
        binding = new NativeQuestionRuntimeBinding(QUESTION_BINDING_KEY, readNativeDeliveryRuntimeRegistry(registry), runtime);
    }
    catch {
        binding = {};
    }
    registry.binding = binding;
    return () => {
        if (registry.runtime === runtime && registry.binding === binding) {
            retireQuestionBinding(binding);
            registry.runtime = undefined;
            registry.binding = undefined;
        }
    };
}
/** @internal */
export function clearTelegramDeliveryRuntime() {
    const registry = getTelegramDeliveryRuntimeRegistry();
    retireQuestionBinding(registry.binding);
    registry.runtime?.shutdown();
    registry.runtime = undefined;
    registry.binding = undefined;
}
/** @internal Original native registry/runtime binding, captured once at group admission; never an ACK-time lookup. */
export function captureTelegramQuestionLifetimeOwner() {
    const original = currentQuestionBinding();
    if (!original)
        return undefined;
    const { facts, binding } = original, runtime = facts.runtime, capture = runtime.captureQuestionLifetimeOwner;
    if (!capture)
        return undefined;
    try {
        const owner = capture.call(runtime, binding);
        if (!owner || !questionBindingCurrent(facts) || runtime.captureQuestionLifetimeOwner !== capture ||
            readNativeQuestionLifetimeScope(owner.scope).binding !== binding)
            return undefined;
        owner.assertCurrent();
        return questionBindingCurrent(facts) && runtime.captureQuestionLifetimeOwner === capture ? owner : undefined;
    }
    catch {
        return undefined;
    }
}
/** @internal */
export function isTelegramDeliveryHandleCurrent(handle) {
    const runtime = getTelegramDeliveryRuntimeRegistry().runtime;
    return runtime !== undefined && runtime.generation === handle.generation;
}
export async function sendTelegramView(view, options) {
    const invalid = validateView(view);
    if (invalid)
        return invalid;
    return runDeliveryOperation((runtime) => runtime.sendView(view, options));
}
export function openTelegramTaskView(raw) {
    const request = snapshotTaskViewRequest(raw), registry = getTelegramDeliveryRuntimeRegistry(), { runtime, binding } = registry;
    const open = runtime?.openTaskView;
    if (!runtime || !binding || !open)
        return Promise.resolve({ ok: false, reason: "runtime-unavailable", effect: "not-issued", message: "Task View is unavailable." });
    let valid = true;
    const current = () => { valid &&= registry.runtime === runtime && registry.binding === binding && runtime.openTaskView === open; return valid; };
    return open.call(runtime, request, current);
}
/** @internal Reserved Attachment controls fail softly without a compatible receiver; never model input. */
export function acceptTelegramAttachmentQuestionCallback(query, assertAuthority) {
    if (!query.data?.startsWith("tgattach:"))
        return { handled: false };
    assertAuthority?.();
    const runtime = getBoundTelegramDeliveryRuntime();
    return !isFailure(runtime) && runtime.acceptAttachmentCancel ? runtime.acceptAttachmentCancel(query, assertAuthority) : { handled: true, accepted: false };
}
/** @internal Reserved Task View controls never become model input, even in older bindings. */
export function acceptTelegramTaskViewCallback(query, assertAuthority) {
    if (!query.data?.startsWith("tgtask:"))
        return { handled: false };
    assertAuthority?.();
    const runtime = getBoundTelegramDeliveryRuntime();
    return !isFailure(runtime) && runtime.acceptTaskCancel ? runtime.acceptTaskCancel(query, assertAuthority)
        : { handled: true, accepted: false };
}
export async function openTelegramChoice(request) {
    const runtime = getBoundTelegramDeliveryRuntime();
    if (isFailure(runtime))
        return { ok: false, reason: "runtime-unavailable", message: "Telegram delivery runtime is unavailable." };
    return runtime.openChoice ? runtime.openChoice(request)
        : { ok: false, reason: "runtime-unavailable", message: "Choice delivery is unavailable." };
}
/** @internal Marked SDK replies never fall back to an unversioned or absent collector. */
export function acceptTelegramTextInputReply(message, requestId, assertAuthority, edited = false) {
    assertAuthority?.();
    const runtime = getBoundTelegramDeliveryRuntime();
    return !isFailure(runtime) && runtime.acceptTextInputReply ? runtime.acceptTextInputReply(message, requestId, assertAuthority, edited)
        : { handled: true, accepted: false, reason: "unavailable" };
}
/** @internal Status/cancel controls remain reserved even without a compatible runtime. */
export function acceptTelegramTextInputCallback(query, assertAuthority) {
    if (!query.data?.startsWith("tginput:"))
        return { handled: false };
    assertAuthority?.();
    const runtime = getBoundTelegramDeliveryRuntime();
    return !isFailure(runtime) && runtime.acceptTextInputCancel ? runtime.acceptTextInputCancel(query, assertAuthority)
        : { handled: true, accepted: false, reason: "unavailable" };
}
/** @internal */
export function acceptTelegramChoiceCallback(query, assertAuthority) {
    if (!query.data?.startsWith("tgchoice:"))
        return { handled: false };
    assertAuthority?.();
    const runtime = getBoundTelegramDeliveryRuntime();
    return !isFailure(runtime) && runtime.acceptChoice ? runtime.acceptChoice(query, assertAuthority)
        : { handled: true, accepted: false };
}
export async function openTelegramConfirm(request) {
    const runtime = getBoundTelegramDeliveryRuntime();
    if (isFailure(runtime))
        return { ok: false, reason: "runtime-unavailable", message: "Telegram delivery runtime is unavailable." };
    return runtime.openConfirmation
        ? runtime.openConfirmation(request)
        : { ok: false, reason: "runtime-unavailable", message: "Confirmation delivery is unavailable." };
}
/** @internal */
export function acceptTelegramConfirmationCallback(query, assertAuthority) {
    if (!query.data?.startsWith("tgconfirm:"))
        return { handled: false };
    assertAuthority?.();
    const runtime = getBoundTelegramDeliveryRuntime();
    return !isFailure(runtime) && runtime.acceptConfirmation
        ? runtime.acceptConfirmation(query, assertAuthority)
        : { handled: true, accepted: false };
}
export async function editTelegramView(handle, view) {
    const invalid = validateView(view);
    if (invalid)
        return invalid;
    return runDeliveryOperation((runtime) => {
        if (runtime.generation !== handle.generation) {
            return Promise.resolve(failure("stale-handle", "Telegram delivery handle belongs to an inactive runtime generation."));
        }
        return runtime.editView(handle, view);
    });
}
export async function deleteTelegramView(handle) {
    return runDeliveryOperation((runtime) => {
        if (runtime.generation !== handle.generation) {
            return Promise.resolve(failure("stale-handle", "Telegram delivery handle belongs to an inactive runtime generation."));
        }
        return runtime.deleteView(handle);
    });
}
export async function sendTelegramChatAction(action, options) {
    return runDeliveryOperation((runtime) => runtime.sendChatAction(action, options.scope));
}
