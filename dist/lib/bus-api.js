/**
 * Telegram bus-aware API runtime
 * Zones: multi-instance bus, telegram api transport, live instance routing
 * Wraps the direct Telegram Bot API runtime so follower instances can route outbound calls through the bus leader
 */
import { markTelegramBusCrossTargetDelivery, TelegramBusArtifactIpcError, TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT, hasTelegramBusCapability, parseTelegramBusSelectedMenuTextEffect, parseTelegramBusAttachmentPublicationReceipt, TELEGRAM_BUS_ATTACHMENT_PUBLICATION_RECEIPT, stripTelegramBusApiMetadata, } from "./bus.js";
import { getTelegramAttachmentControlId } from "./delivery.js";
import { buildTelegramAnswerGuestQueryBody, assertTelegramApiCallAuthority, captureTelegramUiAuthorityOptions, isTelegramApiCommitUnknownError, isTelegramMessageNotModifiedError, TelegramApiAuthorityError, isTelegramCallbackQueryExpiredError, TelegramApiCommitUnknownError, isTelegramApiRequestRejected, } from "./telegram-api.js";
/** Capture the original session and direct/follower identity for one agent selection view. */
export function createTelegramButtonSelectionAuthorityCapture(deps) {
    return () => {
        const session = deps.captureSession(), stamp = deps.getTransportStamp(), operator = deps.getAllowedUserId();
        const direct = deps.ownsDirect(), epoch = deps.getLeaderEpoch(), generation = deps.getFollowerGeneration();
        const target = direct ? deps.getLeaderTarget() : deps.getFollowerTarget();
        const capturedTarget = target ? { ...target } : undefined;
        const registration = direct ? undefined : deps.captureFollowerRegistration?.(), isRegistrationCurrent = registration?.isCurrent;
        if (!session || operator === undefined || (direct ? epoch === undefined : generation === undefined || !deps.isFollowerRegistered() ||
            deps.captureFollowerRegistration && !registration))
            return undefined;
        let lost = false;
        return () => {
            try {
                const currentTarget = direct ? deps.getLeaderTarget() : deps.getFollowerTarget();
                lost ||= !session() || !deps.isTransportStampActive(stamp) || deps.getAllowedUserId() !== operator ||
                    deps.ownsDirect() !== direct ||
                    (direct ? deps.getLeaderEpoch() !== epoch :
                        !deps.isFollowerRegistered() || deps.getFollowerGeneration() !== generation ||
                            registration && (registration.isCurrent !== isRegistrationCurrent || isRegistrationCurrent.call(registration) !== true)) ||
                    currentTarget?.chatId !== capturedTarget?.chatId || currentTarget?.threadId !== capturedTarget?.threadId;
                if (lost)
                    throw new Error("Telegram selection owner is unavailable.");
            }
            catch (error) {
                lost = true;
                throw error;
            }
        };
    };
}
/** Original local question provider; remote publication/receiver evidence remains a separate boundary. */
export function createTelegramQuestionAuthorityCapture(deps) {
    const captureSelection = createTelegramButtonSelectionAuthorityCapture(deps);
    const getBotId = deps.getBotId, captureRegistration = deps.captureFollowerRegistration;
    return () => {
        try {
            if (deps.getBotId !== getBotId || deps.captureFollowerRegistration !== captureRegistration)
                return undefined;
            const botId = getBotId();
            if (!Number.isSafeInteger(botId) || botId <= 0)
                return undefined;
            const assertSelection = captureSelection();
            if (!assertSelection)
                return undefined;
            let lost = false, checking = false;
            const assertCurrent = () => {
                if (lost || checking) {
                    lost = true;
                    throw new Error("Telegram question provider is unavailable.");
                }
                checking = true;
                try {
                    assertSelection();
                    if (deps.getBotId !== getBotId || deps.captureFollowerRegistration !== captureRegistration || getBotId() !== botId)
                        throw new Error("Telegram question provider is unavailable.");
                    assertSelection();
                    if (lost || deps.getBotId !== getBotId || deps.captureFollowerRegistration !== captureRegistration)
                        throw new Error("Telegram question provider is unavailable.");
                }
                catch (error) {
                    lost = true;
                    throw error;
                }
                finally {
                    checking = false;
                }
            };
            assertCurrent();
            return assertCurrent;
        }
        catch {
            return undefined;
        }
    };
}
/** Capture Locks and Queue authority only at operation admission, never during root assembly. */
export function createTelegramArtifactTransportAuthorityCapture(transport, stamps) {
    return () => {
        const owned = transport.captureCurrentTransportAuthority(), stamp = stamps.getStamp();
        if (!owned)
            return undefined;
        let lost = false;
        return () => {
            try {
                lost ||= !owned() || !stamps.isActive(stamp);
            }
            catch {
                lost = true;
            }
            return !lost;
        };
    };
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : {};
}
function asBoolean(value) {
    return Boolean(value);
}
function asSentMessage(value) {
    return asRecord(value);
}
function withDefaultThreadTarget(body, target) {
    if (target?.threadId === undefined)
        return body;
    if (body.message_thread_id !== undefined)
        return body;
    return body.chat_id === target.chatId
        ? { ...body, message_thread_id: target.threadId }
        : body;
}
function markFollowerCrossTargetDelivery(body, defaultTarget) {
    if (!defaultTarget || body.chat_id !== defaultTarget.chatId)
        return body;
    const threadId = body.message_thread_id;
    const isDifferentTarget = threadId === undefined
        ? defaultTarget.threadId !== undefined
        : threadId !== defaultTarget.threadId;
    return isDifferentTarget ? markTelegramBusCrossTargetDelivery(body) : body;
}
function rejectTelegramDirectOwnership(method) {
    return Promise.reject(new Error(`Telegram ${method} requires direct transport ownership.`));
}
/** Bound selected-menu projection only; no ordinary/raw API fallback and no activation during preparation. */
export function createTelegramSelectedMenuTextApi(deps) {
    const { operationId, registrationGeneration, assertAuthority, deliver } = deps, target = { ...deps.target };
    if (typeof assertAuthority !== "function" ||
        typeof deliver !== "function" ||
        !operationId?.trim() ||
        operationId.length > 128 ||
        !registrationGeneration?.trim() ||
        registrationGeneration.length > 128 ||
        !Number.isSafeInteger(target.chatId) ||
        target.chatId <= 0 ||
        !Number.isSafeInteger(target.threadId) ||
        target.threadId <= 0)
        throw new TelegramApiAuthorityError(false);
    const invoke = async (edit, raw, options) => {
        let issued = false;
        const assertCurrent = () => {
            try {
                assertAuthority();
            }
            catch {
                throw new TelegramApiAuthorityError(issued);
            }
        };
        try {
            if (options?.assertAuthority !== assertAuthority ||
                Reflect.ownKeys(raw).some((key) => typeof key !== "string" ||
                    ![
                        "chat_id",
                        "message_thread_id",
                        "text",
                        "parse_mode",
                        "reply_markup",
                        ...(edit ? ["message_id"] : ["reply_parameters"]),
                    ].includes(key)))
                throw new TelegramApiAuthorityError(false);
            const body = structuredClone(raw), reply = body.reply_parameters;
            if (body.chat_id !== target.chatId ||
                body.message_thread_id !== target.threadId ||
                (reply !== undefined &&
                    (!reply ||
                        typeof reply !== "object" ||
                        Array.isArray(reply) ||
                        Object.keys(reply).some((key) => !["message_id", "allow_sending_without_reply"].includes(key)) ||
                        reply.allow_sending_without_reply !==
                            true ||
                        !Number.isSafeInteger(reply.message_id) ||
                        reply.message_id <= 0)))
                throw new TelegramApiAuthorityError(false);
            const effect = parseTelegramBusSelectedMenuTextEffect({
                kind: edit ? "edit-text" : "send-text",
                text: body.text,
                ...(body.parse_mode !== undefined
                    ? { parseMode: body.parse_mode }
                    : {}),
                ...(body.reply_markup !== undefined
                    ? { replyMarkup: body.reply_markup }
                    : {}),
                ...(edit
                    ? { messageId: body.message_id }
                    : reply !== undefined
                        ? {
                            replyToMessageId: reply.message_id,
                        }
                        : {}),
            });
            if (!effect)
                throw new TelegramApiAuthorityError(false);
            assertCurrent();
            issued = true;
            const observed = await deliver.call(deps, effect, assertAuthority);
            assertCurrent();
            if (observed.operationId !== operationId ||
                observed.registrationGeneration !== registrationGeneration ||
                observed.effect !== effect.kind ||
                observed.recipient.target.chatId !== target.chatId ||
                observed.recipient.target.threadId !== target.threadId ||
                !Number.isSafeInteger(observed.messageId) ||
                observed.messageId <= 0 ||
                (effect.kind === "edit-text" && observed.messageId !== effect.messageId))
                throw new Error("Selected-menu transport result is unconfirmed.");
            assertCurrent();
            return observed.messageId;
        }
        catch (error) {
            if (error instanceof TelegramApiAuthorityError ||
                isTelegramApiCommitUnknownError(error))
                throw error;
            if (issued)
                throw new TelegramApiCommitUnknownError(edit ? "editMessageText" : "sendMessage", error);
            throw new TelegramApiAuthorityError(false);
        }
    };
    return {
        sendMessage: async (body, options) => ({
            message_id: await invoke(false, body, options),
        }),
        editMessageText: async (body, options) => {
            await invoke(true, body, options);
            return "edited";
        },
    };
}
/** Followers route every chat action through the leader's generic `sendChatAction` call. */
function sendTelegramFollowerChatAction(deps, chatId, action, options) {
    assertTelegramApiCallAuthority(options?.assertAuthority, false);
    const body = withDefaultThreadTarget({
        chat_id: chatId,
        action,
        ...(options?.message_thread_id !== undefined
            ? { message_thread_id: options.message_thread_id }
            : {}),
    }, deps.getDefaultTarget?.());
    // Only plain single-attempt policy crosses IPC; the captured assertion is a local issuance fence.
    const args = ["sendChatAction", body, ...(action === "typing"
            ? [{ maxAttempts: 1, retrySafety: "non-idempotent" }] : [])];
    return deps.callFollowerApi("call", args, options?.assertAuthority
        ? { assertAuthority: options.assertAuthority } : undefined).then(asBoolean);
}
/** Only an acknowledged message location plus its original local authority may be retired. */
export function createTelegramButtonPublicationEditor(api) {
    const edit = api.editMessageReplyMarkup, editText = api.editMessageText;
    return async (publication, assertCurrent) => {
        assertCurrent();
        if (publication.richMessage)
            await editText({ chat_id: publication.chatId, message_id: publication.messageId,
                rich_message: publication.richMessage, ...(publication.replyMarkup ? { reply_markup: publication.replyMarkup } : {}) }, { assertLocalAuthority: assertCurrent });
        else if (publication.replyMarkup)
            await edit(publication.chatId, publication.messageId, publication.replyMarkup, { assertLocalAuthority: assertCurrent });
        assertCurrent();
    };
}
export function createTelegramBusAwareApiRuntime(deps) {
    const originalFollower = { send: deps.callFollowerApi, capture: deps.captureFollowerApiRegistration, bot: deps.getQuestionBotId };
    const captureAuthority = (publication = false) => {
        const publisher = deps.directRuntime, capture = deps.captureQuestionAuthority, role = deps.ownsDirect;
        const keys = ["call", "sendMessage", "sendRichMessage", "editMessageText", "editMessageReplyMarkup"];
        // A direct publication pins methods before even the role/bot/provider callbacks can reenter.
        try {
            const pinnedMethods = publication ? keys.map(key => Object.getOwnPropertyDescriptor(publisher, key)?.value) : undefined;
            const direct = role(), needsBot = publication || !direct;
            if (publication && (direct !== true || !originalFollower.bot || deps.getQuestionBotId !== originalFollower.bot) ||
                direct !== true && direct !== false || !direct && (!originalFollower.capture || !originalFollower.bot || deps.callFollowerApi !== originalFollower.send ||
                deps.captureFollowerApiRegistration !== originalFollower.capture || deps.getQuestionBotId !== originalFollower.bot))
                return undefined;
            const methods = pinnedMethods ?? (direct ? keys.map(key => Object.getOwnPropertyDescriptor(publisher, key)?.value) : []);
            const botId = needsBot ? originalFollower.bot() : undefined;
            if (needsBot && (!Number.isSafeInteger(botId) || botId <= 0))
                return undefined;
            const guards = [capture?.(), ...(!direct ? [originalFollower.capture()] : [])];
            if (guards.some(guard => typeof guard !== "function") || methods.some(method => typeof method !== "function")) {
                for (const guard of guards)
                    if (guard !== undefined && typeof guard !== "function")
                        void Promise.resolve(guard).catch(() => { });
                return undefined;
            }
            const assertions = guards;
            let lost = false, checking = false;
            const bound = () => !lost && deps.captureQuestionAuthority === capture && deps.ownsDirect === role &&
                deps.getQuestionBotId === originalFollower.bot &&
                (direct ? deps.directRuntime === publisher && keys.every((key, index) => Object.getOwnPropertyDescriptor(publisher, key)?.value === methods[index]) :
                    deps.callFollowerApi === originalFollower.send && deps.captureFollowerApiRegistration === originalFollower.capture && deps.getQuestionBotId === originalFollower.bot);
            const assertOriginal = () => {
                for (const assertion of assertions) {
                    const observed = assertion();
                    if (observed !== undefined) {
                        void Promise.resolve(observed).catch(() => { });
                        throw new TelegramApiAuthorityError(false);
                    }
                }
            };
            const assertCurrent = () => {
                if (checking) {
                    lost = true;
                    throw new TelegramApiAuthorityError(false);
                }
                checking = true;
                try {
                    if (!bound() || role() !== direct)
                        throw new TelegramApiAuthorityError(false);
                    assertOriginal();
                    if (!bound() || role() !== direct || needsBot && originalFollower.bot() !== botId)
                        throw new TelegramApiAuthorityError(false);
                    assertOriginal();
                    if (!bound() || role() !== direct)
                        throw new TelegramApiAuthorityError(false);
                }
                catch (error) {
                    lost = true;
                    throw error;
                }
                finally {
                    checking = false;
                }
            };
            assertCurrent();
            return { assertCurrent, botId };
        }
        catch {
            return undefined;
        }
    };
    const captureQuestionAuthority = () => captureAuthority()?.assertCurrent;
    const completePublicationCarrier = (body, result, botId, edit = false) => {
        const data = (value, key) => {
            const property = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key) : undefined;
            if (property && !("value" in property))
                throw new Error("Unconfirmed native carrier");
            return property?.value;
        };
        try {
            const id = data(result, "message_id"), chat = data(body, "chat_id"), thread = data(body, "message_thread_id");
            return Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(chat) &&
                (thread === undefined || Number.isSafeInteger(thread) && thread > 0) &&
                data(data(result, "chat"), "id") === chat && (!edit || id === data(body, "message_id")) &&
                // An omitted edit Thread is joined only by the store's captured physical parent, never inferred here.
                ((edit && thread === undefined) || data(result, "message_thread_id") === thread) &&
                Number.isSafeInteger(botId) && botId > 0 && data(data(result, "from"), "id") === botId && data(data(result, "from"), "is_bot") === true &&
                data(body, "business_connection_id") === undefined && data(result, "business_connection_id") === undefined;
        }
        catch {
            return false;
        }
    };
    const withPublication = async (method, body, operation) => {
        const direct = deps.ownsDirect(), editing = method.startsWith("edit");
        if (!deps.beginButtonPublication || !["sendMessage", "sendRichMessage", "editMessageText", "editMessageReplyMarkup"].includes(method))
            return operation(body, undefined, direct);
        // Capture the original publisher before the observer/queue can reenter or await; never select at ACK.
        const directScope = direct ? captureAuthority(true) : undefined;
        const originalPublisher = direct ? directScope?.assertCurrent : captureQuestionAuthority(), botId = direct ? directScope?.botId : originalPublisher ? originalFollower.bot() : undefined;
        if (!direct)
            assertTelegramApiCallAuthority(originalPublisher, false);
        const settle = deps.beginButtonPublication(method, body);
        // This own data hint selects only a born ordinary candidate, not authority or general direct enrollment.
        const sourceKind = settle && Object.getOwnPropertyDescriptor(settle, "ordinarySource")?.value;
        const directFirst = direct && !editing && sourceKind === "first-send" && !!directScope;
        const directEdit = direct && editing && sourceKind === "known-parent-edit" && !!directScope;
        const assertPublisher = settle && (!direct || directFirst || directEdit) ? originalPublisher : undefined;
        if (!direct || directEdit)
            settle?.restrictQuestionMembership?.(editing ? "known-parent-edit" : "first-send");
        else if (directFirst)
            settle?.restrictQuestionMembership?.("first-send");
        else if (editing && sourceKind === "known-parent-edit")
            settle?.restrictQuestionMembership?.("none");
        let result, succeeded = false, rejected = false;
        let nativeEditResult, receivedNative = false, duplicateNative = false, acceptingNative = true;
        const observeNativeEdit = directEdit ? (value) => {
            if (!acceptingNative)
                return;
            if (receivedNative) {
                duplicateNative = true;
                return;
            }
            receivedNative = true;
            nativeEditResult = value;
        } : undefined;
        try {
            if (settle?.ready)
                await settle.ready;
            const publishedBody = { ...body, ...(settle?.prepareReplyMarkup ? { reply_markup: settle.prepareReplyMarkup() } : {}),
                ...(settle?.prepareRichMessage ? { rich_message: settle.prepareRichMessage() } : {}) };
            settle?.assertPublicationBody?.(publishedBody);
            assertTelegramApiCallAuthority(assertPublisher, false);
            result = await operation(publishedBody, assertPublisher, direct, observeNativeEdit);
            acceptingNative = false;
            assertTelegramApiCallAuthority(assertPublisher, true);
            succeeded = true;
            const carrier = directEdit ? receivedNative && !duplicateNative ? nativeEditResult : undefined : result;
            if ((!direct || directFirst || directEdit) && (!assertPublisher || !completePublicationCarrier(publishedBody, carrier, botId, editing)))
                settle?.restrictQuestionMembership?.("none");
            return result;
        }
        catch (error) {
            rejected = isTelegramApiRequestRejected(error, method) || error instanceof TelegramApiAuthorityError && !error.requestIssued;
            throw error;
        }
        finally {
            acceptingNative = false;
            // Keep public outcomes while the original operation contributes its native carrier separately.
            const followerEdit = !direct && editing;
            const legacyResult = followerEdit && method === "editMessageReplyMarkup" ? undefined :
                followerEdit && (succeeded || result !== undefined) && result !== "unchanged" ? "edited" : result;
            settle?.(legacyResult, succeeded, rejected, followerEdit ? result : directEdit && receivedNative && !duplicateNative ? nativeEditResult : undefined);
        }
    };
    const directUiOptions = (options, publisher) => {
        if (!publisher)
            return options;
        const original = options?.assertLocalAuthority ?? options?.assertAuthority;
        return { assertLocalAuthority() { publisher(); original?.(); publisher(); } };
    };
    const callFollowerUi = async (method, body, options, assertPublisher) => {
        if (options?.assertAuthority)
            throw new TelegramApiAuthorityError(false);
        const captured = options?.assertLocalAuthority;
        const local = assertPublisher ? () => { assertPublisher(); captured?.(); assertPublisher(); } : captured;
        assertTelegramApiCallAuthority(local, false);
        const args = [method, body, ...(local ? [{ maxAttempts: 1, retrySafety: "non-idempotent" }] : [])];
        const result = await deps.callFollowerApi("call", args, local ? { assertAuthority: local } : undefined);
        assertTelegramApiCallAuthority(local, true);
        return result;
    };
    return {
        captureQuestionAuthority,
        captureAttachmentPublication(rawTarget) {
            const target = Object.freeze({ ...rawTarget }), role = deps.ownsDirect, capture = deps.captureAttachmentPublicationRegistration, send = deps.callFollowerApi;
            let scope;
            try {
                if (role() !== false)
                    return undefined;
                scope = capture?.();
            }
            catch {
                return undefined;
            }
            if (!scope)
                return undefined;
            const retained = scope, guard = scope.assertCurrent;
            let lost = false, checking = false, used = false;
            const bound = () => !lost && deps.ownsDirect === role && deps.captureAttachmentPublicationRegistration === capture && deps.callFollowerApi === send && retained.assertCurrent === guard;
            const assertCurrent = () => {
                if (checking) {
                    lost = true;
                    throw new TelegramApiAuthorityError(false);
                }
                checking = true;
                try {
                    if (!bound() || role() !== false || retained.registration.target?.chatId !== target.chatId || retained.registration.target?.threadId !== target.threadId)
                        throw new TelegramApiAuthorityError(false);
                    guard.call(retained);
                    if (!bound() || role() !== false)
                        throw new TelegramApiAuthorityError(false);
                }
                catch (error) {
                    lost = true;
                    throw error;
                }
                finally {
                    checking = false;
                }
            };
            try {
                assertCurrent();
            }
            catch {
                return undefined;
            }
            return Object.freeze({ assertCurrent, async publish(rawBody, assertQuestion) {
                    const body = structuredClone(rawBody), nonce = getTelegramAttachmentControlId(body.reply_markup);
                    assertTelegramApiCallAuthority(assertCurrent, false);
                    if (used || !nonce || body.chat_id !== target.chatId || body.message_thread_id !== target.threadId || typeof body.text !== "string" ||
                        Object.keys(body).some(key => !["chat_id", "message_thread_id", "text", "parse_mode", "reply_markup"].includes(key)))
                        throw new TelegramApiAuthorityError(false);
                    used = true;
                    let invoked = false, returned = false;
                    const assertAuthority = () => { assertCurrent(); assertQuestion(); assertCurrent(); };
                    try {
                        assertTelegramApiCallAuthority(assertAuthority, false);
                        invoked = true;
                        // Exactly two wire arguments: native broker options are reconstructed there, never serialized here.
                        const result = await send("call", ["sendMessage", body], { assertAuthority });
                        returned = true;
                        assertTelegramApiCallAuthority(assertAuthority, true);
                        const record = asRecord(result), receipt = parseTelegramBusAttachmentPublicationReceipt(record[TELEGRAM_BUS_ATTACHMENT_PUBLICATION_RECEIPT]);
                        if (!receipt || receipt.nonce !== nonce || receipt.instanceId !== retained.registration.instanceId || receipt.registrationGeneration !== retained.registration.registrationGeneration ||
                            receipt.registrationIncarnation !== retained.registrationIncarnation || receipt.target.chatId !== target.chatId || receipt.target.threadId !== target.threadId || receipt.messageId !== record.message_id)
                            throw new TelegramApiCommitUnknownError("sendMessage", new Error("Attachment publication receipt is unavailable."));
                        return Object.freeze({ messageId: receipt.messageId, botId: receipt.botId });
                    }
                    catch (error) {
                        if (!isTelegramApiCommitUnknownError(error) && (returned || invoked && !(error instanceof TelegramApiAuthorityError && !error.requestIssued) && !isTelegramApiRequestRejected(error, "sendMessage")))
                            throw new TelegramApiCommitUnknownError("sendMessage", error);
                        throw error;
                    }
                } });
        },
        captureArtifactTransport(rawTarget) {
            const target = { ...rawTarget }, direct = deps.ownsDirect(), nativeSend = deps.directRuntime.callArtifactBytes, reserveArtifact = deps.directRuntime.reserveArtifact, followerSend = deps.callFollowerApi;
            const registration = direct ? undefined : deps.captureFollowerArtifactRegistration?.();
            if (direct ? !nativeSend || !reserveArtifact : !registration ||
                !hasTelegramBusCapability(deps.artifactProtocol, TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT) ||
                !hasTelegramBusCapability(deps.getFollowerProtocol?.(), TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT))
                return undefined;
            const owned = direct ? deps.captureDirectArtifactAuthority?.() : registration?.isCurrent;
            if (!owned)
                return undefined;
            let lost = false;
            const isCurrent = () => {
                try {
                    lost ||= deps.ownsDirect() !== direct || !owned() || deps.directRuntime.callArtifactBytes !== nativeSend || deps.directRuntime.reserveArtifact !== reserveArtifact || deps.callFollowerApi !== followerSend ||
                        !direct && (!hasTelegramBusCapability(deps.artifactProtocol, TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT) || !hasTelegramBusCapability(deps.getFollowerProtocol?.(), TELEGRAM_BUS_CAPABILITY_ARTIFACT_DOCUMENT));
                }
                catch {
                    lost = true;
                }
                return !lost;
            };
            if (!isCurrent())
                return undefined;
            return { isCurrent, async send(input) {
                    let issued = false, messageId;
                    let reservation;
                    const assertAuthority = () => {
                        input.assertAuthority();
                        if (!isCurrent() || input.signal.aborted || Date.now() >= input.expiresAt)
                            throw new TelegramApiAuthorityError(issued);
                    };
                    try {
                        assertAuthority();
                        if (!direct) {
                            // A local callback fences IPC only. The leader independently captures native execution authority.
                            issued = true;
                            const result = await followerSend("sendArtifactDocument", [{ version: 1, registrationIncarnation: registration.incarnation,
                                    target, fileName: input.fileName, byteLength: input.bytes.byteLength, bytesBase64: Buffer.from(input.bytes).toString("base64"),
                                    ...(input.caption !== undefined ? { caption: input.caption } : {}), expiresAt: input.expiresAt }], { assertAuthority });
                            assertAuthority();
                            return result;
                        }
                        reservation = reserveArtifact();
                        if (!reservation)
                            return { effect: "not-issued", reason: "capacity-exceeded" };
                        const result = await nativeSend({ chat_id: String(target.chatId),
                            ...(target.threadId !== undefined ? { message_thread_id: String(target.threadId) } : {}), ...(input.caption !== undefined ? { caption: input.caption } : {}) }, input.bytes, input.fileName, { artifactReservation: reservation, assertAuthority, signal: input.signal, maxAttempts: 1, retryRateLimit: false, retrySafety: "non-idempotent", onRequestIssued() { issued = true; }, onArtifactMessageId(id) { messageId = id; } });
                        if (Number.isSafeInteger(result?.message_id) && result.message_id > 0)
                            messageId = result.message_id;
                        assertAuthority();
                        return { effect: messageId ? "sent" : "unknown", reason: messageId ? "sent" : "commit-unknown", ...(messageId ? { messageId } : {}) };
                    }
                    catch (error) {
                        // Native HTTP observation is monotonic; only the follower IPC owner can disprove its local intent marker.
                        const notIssued = !issued || !direct && error instanceof TelegramBusArtifactIpcError && !error.requestIssued;
                        return { effect: notIssued ? "not-issued" : direct && isTelegramApiRequestRejected(error, "sendDocument") ? "rejected" : "unknown",
                            reason: notIssued ? "invalidated" : direct && isTelegramApiRequestRejected(error, "sendDocument") ? "transport-rejected" : "commit-unknown", ...(messageId ? { messageId } : {}) };
                    }
                    finally {
                        reservation?.release();
                    }
                } };
        },
        call(method, body, options) {
            return withPublication(method, body, (body, assertPublisher, direct) => {
                if (direct)
                    return deps.directRuntime.call(method, body, options);
                // A process-local authority callback cannot cross IPC as an enforceable grant.
                if (options?.assertAuthority)
                    return Promise.reject(new TelegramApiAuthorityError(false));
                if (assertPublisher)
                    return deps.callFollowerApi("call", [method, body, { ...options, maxAttempts: 1, retrySafety: "non-idempotent" }], { assertAuthority: assertPublisher });
                return deps.callFollowerApi("call", [method, body, options]);
            });
        },
        callMultipart(method, fields, fileField, filePath, fileName, options) {
            if (deps.ownsDirect())
                return deps.directRuntime.callMultipart(method, fields, fileField, filePath, fileName, options);
            if (options?.assertAuthority)
                return Promise.reject(new TelegramApiAuthorityError(false));
            return deps.callFollowerApi("callMultipart", [
                method,
                fields,
                fileField,
                filePath,
                fileName,
                options,
            ]);
        },
        downloadFile(fileId, suggestedName, source) {
            // The source names the file (kind-scope-message); dropping it falls back to the bare generated name.
            return deps.ownsDirect()
                ? deps.directRuntime.downloadFile(fileId, suggestedName, source)
                : deps.callFollowerApi("downloadFile", [
                    fileId,
                    suggestedName,
                    ...(source ? [source] : []),
                ]);
        },
        deleteWebhook(signal) {
            return deps.ownsDirect()
                ? deps.directRuntime.deleteWebhook(signal)
                : rejectTelegramDirectOwnership("deleteWebhook");
        },
        getUpdates(body, signal) {
            return deps.ownsDirect()
                ? deps.directRuntime.getUpdates(body, signal)
                : rejectTelegramDirectOwnership("getUpdates");
        },
        setMyCommands(commands, options) {
            if (deps.ownsDirect())
                return deps.directRuntime.setMyCommands(commands, options);
            if (options?.assertAuthority)
                return Promise.reject(new TelegramApiAuthorityError(false));
            return deps
                .callFollowerApi("call", ["setMyCommands", { commands }])
                .then(asBoolean);
        },
        sendChatAction(chatId, action, options) {
            return deps.ownsDirect()
                ? deps.directRuntime.sendChatAction(chatId, action, options)
                : sendTelegramFollowerChatAction(deps, chatId, action, options);
        },
        sendTypingAction(chatId, options) {
            return deps.ownsDirect()
                ? deps.directRuntime.sendTypingAction(chatId, options)
                : sendTelegramFollowerChatAction(deps, chatId, "typing", options);
        },
        sendRecordVoiceAction(chatId, options) {
            return deps.ownsDirect()
                ? deps.directRuntime.sendRecordVoiceAction(chatId, options)
                : sendTelegramFollowerChatAction(deps, chatId, "record_voice", options);
        },
        sendMessageDraft(chatId, draftId, text, options) {
            const body = {
                chat_id: chatId,
                draft_id: draftId,
            };
            if (text !== undefined)
                body.text = text;
            if (options?.parse_mode !== undefined)
                body.parse_mode = options.parse_mode;
            if (options?.entities !== undefined)
                body.entities = options.entities;
            if (options?.message_thread_id !== undefined) {
                body.message_thread_id = options.message_thread_id;
            }
            const scopedBody = withDefaultThreadTarget(body, deps.getDefaultTarget?.());
            return deps.ownsDirect()
                ? deps.directRuntime.sendMessageDraft(chatId, draftId, text, options)
                : deps
                    .callFollowerApi("call", ["sendMessageDraft", scopedBody])
                    .then(asBoolean);
        },
        sendMessage(body, options) {
            const captured = captureTelegramUiAuthorityOptions(options);
            return withPublication("sendMessage", body, (body, assertPublisher, direct) => direct
                ? deps.directRuntime.sendMessage(stripTelegramBusApiMetadata(body), directUiOptions(captured, assertPublisher))
                : callFollowerUi("sendMessage", markFollowerCrossTargetDelivery(body, deps.getDefaultTarget?.()), captured, assertPublisher).then(asSentMessage));
        },
        sendRichMessage(body, options) {
            const captured = captureTelegramUiAuthorityOptions(options);
            return withPublication("sendRichMessage", body, (body, assertPublisher, direct) => {
                if (direct) {
                    const scoped = directUiOptions(captured, assertPublisher);
                    const native = assertPublisher ? { assertAuthority: scoped.assertLocalAuthority, maxAttempts: 1, retrySafety: "non-idempotent" } : options;
                    return deps.directRuntime.sendRichMessage(stripTelegramBusApiMetadata(body), native);
                }
                if (options?.assertAuthority)
                    return Promise.reject(new TelegramApiAuthorityError(false));
                return callFollowerUi("sendRichMessage", markFollowerCrossTargetDelivery(body, deps.getDefaultTarget?.()), undefined, assertPublisher).then(asSentMessage);
            });
        },
        sendRichMessageDraft(body) {
            return deps.ownsDirect()
                ? deps.directRuntime.sendRichMessageDraft(body)
                : deps
                    .callFollowerApi("call", ["sendRichMessageDraft", body])
                    .then(asBoolean);
        },
        async editMessageText(body, options) {
            const captured = captureTelegramUiAuthorityOptions(options);
            const result = await withPublication("editMessageText", body, async (body, assertPublisher, direct, observeNativeEdit) => {
                if (direct) {
                    const scoped = directUiOptions(captured, assertPublisher);
                    return deps.directRuntime.editMessageText(body, observeNativeEdit ? { ...scoped, onNativeEditResult: observeNativeEdit } : scoped);
                }
                try {
                    return await callFollowerUi("editMessageText", body, captured, assertPublisher);
                }
                catch (error) {
                    if (isTelegramMessageNotModifiedError(error)) {
                        assertTelegramApiCallAuthority(captured?.assertLocalAuthority, true);
                        return "unchanged";
                    }
                    throw error;
                }
            });
            return result === "unchanged" ? "unchanged" : "edited";
        },
        async editMessageReplyMarkup(chatId, messageId, replyMarkup, options) {
            const captured = captureTelegramUiAuthorityOptions(options);
            await withPublication("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }, async (body, assertPublisher, direct, observeNativeEdit) => {
                if (direct) {
                    const scoped = directUiOptions(captured, assertPublisher), options = observeNativeEdit ? { ...scoped, onNativeEditResult: observeNativeEdit } : scoped;
                    const authorityOptions = options ? [options] : [];
                    return deps.directRuntime.editMessageReplyMarkup(chatId, messageId, body.reply_markup, ...authorityOptions);
                }
                return callFollowerUi("editMessageReplyMarkup", body, captured, assertPublisher);
            });
        },
        async answerCallbackQuery(callbackQueryId, text, options) {
            const captured = captureTelegramUiAuthorityOptions(options);
            if (deps.ownsDirect()) {
                const authorityOptions = captured ? [captured] : [];
                await deps.directRuntime.answerCallbackQuery(callbackQueryId, text, ...authorityOptions);
                return;
            }
            try {
                await callFollowerUi("answerCallbackQuery", {
                    callback_query_id: callbackQueryId, ...(text !== undefined ? { text } : {}),
                }, captured);
            }
            catch (error) {
                // An answer Telegram rejects as too old can never succeed; retrying it would replay the whole button action.
                // Refusals before delivery (registration, authority, transport) still propagate to the caller.
                if (!isTelegramCallbackQueryExpiredError(error))
                    throw error;
            }
        },
        async answerGuestQuery(guestQueryId, text, options) {
            if (deps.ownsDirect()) {
                await deps.directRuntime.answerGuestQuery(guestQueryId, text, options);
                return;
            }
            await deps.callFollowerApi("call", [
                "answerGuestQuery",
                buildTelegramAnswerGuestQueryBody(guestQueryId, text, options),
            ]);
        },
        answerGuestQueryForInlineMessage(guestQueryId, text, options) {
            // Guest answers can only be edited while this instance owns direct
            // transport; follower forwarding cannot preserve the inline message id.
            return deps.ownsDirect()
                ? deps.directRuntime.answerGuestQueryForInlineMessage(guestQueryId, text, options)
                : rejectTelegramDirectOwnership("answerGuestQueryForInlineMessage");
        },
        editGuestInlineMessage(inlineMessageId, content, options) {
            return deps.ownsDirect()
                ? deps.directRuntime.editGuestInlineMessage(inlineMessageId, content, options)
                : rejectTelegramDirectOwnership("editGuestInlineMessage");
        },
        async deleteMessage(chatId, messageId, options) {
            const assertAuthority = options?.assertAuthority;
            assertTelegramApiCallAuthority(assertAuthority, false);
            if (deps.ownsDirect()) {
                if (assertAuthority)
                    await deps.directRuntime.deleteMessage(chatId, messageId, { assertAuthority });
                else
                    await deps.directRuntime.deleteMessage(chatId, messageId);
            }
            else {
                const args = ["deleteMessage", { chat_id: chatId, message_id: messageId }];
                if (assertAuthority)
                    await deps.callFollowerApi("call", args, { assertAuthority });
                else
                    await deps.callFollowerApi("call", args);
            }
            assertTelegramApiCallAuthority(assertAuthority, true);
        },
        prepareTempDir() {
            return deps.directRuntime.prepareTempDir();
        },
    };
}
