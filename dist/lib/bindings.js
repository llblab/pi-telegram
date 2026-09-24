/**
 * Telegram bridge binding composition
 * Zones: telegram, pi agent, orchestration
 * Owns pi-facing tool, command, and lifecycle hook registration for the entrypoint
 */
import * as Activity from "./activity.js";
import * as ActivityVerbosity from "./activity-verbosity.js";
import * as ChannelPosts from "./channel-posts.js";
import * as CommandTemplates from "./command-templates.js";
import * as Commands from "./commands.js";
import * as Config from "./config.js";
import * as Delivery from "./delivery.js";
import * as Lifecycle from "./lifecycle.js";
import * as OutboundAttachments from "./outbound-attachments.js";
import * as OutboundHandlers from "./outbound.js";
import * as Pi from "./pi.js";
import * as Prompts from "./prompts.js";
import * as Queue from "./queue.js";
import * as Replies from "./replies.js";
import * as Routing from "./routing.js";
import * as Runtime from "./runtime.js";
import * as Setup from "./setup.js";
import * as TelegramApi from "./telegram-api.js";
import * as GenerativeApps from "./generative-apps.js";
export function createTelegramQueueBindingRuntime(deps) {
    const settleDiscardedItems = (items, ctx) => {
        const durableItems = items.filter((item) => (item.admissionReceipts?.length ?? 0) > 0);
        if (durableItems.length === 0)
            return true;
        const settlement = deps.admission.getSettlement();
        if (!settlement)
            return false;
        return settlement.onItemsDiscarded(durableItems, ctx) === true;
    };
    const mutation = Queue.createTelegramQueueMutationController({
        ...deps.store,
        allocateLaneOrder: deps.queue.allocateItemOrder,
        onItemsDiscarded(items, ctx) {
            if (!settleDiscardedItems(items, ctx)) {
                throw new Error("Telegram queue items could not be discarded durably.");
            }
        },
        updateStatus: deps.updateStatus,
        recordRuntimeEvent: deps.recordRuntimeEvent,
    });
    const dispatch = Queue.createTelegramQueueDispatchRuntime({
        ...deps.store,
        isCompactionInProgress: deps.lifecycle.isCompactionInProgress,
        hasActiveTurn: deps.activeTurn.has,
        hasDispatchPending: deps.lifecycle.hasDispatchPending,
        isIdle: deps.isIdle,
        hasPendingMessages: deps.hasPendingMessages,
        hasDispatchContext: deps.deferredDispatch.isBound,
        getDispatchGeneration: deps.deferredDispatch.getGeneration,
        isDispatchGenerationActive: deps.deferredDispatch.isGenerationActive,
        isQueueItemTransportActive(item) {
            return deps.transportStamp.isActive(item.transportStamp);
        },
        hasPendingInboundQueueMutationForItem(item) {
            return deps.admission.hasPendingQueueMutationForItem(item);
        },
        isQueueItemAdmissionReady(item) {
            return (deps.admission.getSettlement()?.isItemReady(item) ??
                (item.admissionReceipts?.length ?? 0) === 0);
        },
        commitPromptDispatch(item, ctx) {
            if ((item.admissionReceipts?.length ?? 0) === 0)
                return true;
            const settlement = deps.admission.getSettlement();
            if (!settlement?.onPromptHandedOff)
                return false;
            return settlement.onPromptHandedOff(item, ctx) === true;
        },
        onControlSettled(item, ctx) {
            deps.admission.getSettlement()?.onControlSettled(item, ctx);
        },
        onPromptSkipped(item, ctx) {
            return settleDiscardedItems([item], ctx);
        },
        updateStatus: deps.updateStatus,
        sendTextReply: deps.sendTextReply,
        reconcileNextDispatchAnnouncementReplyOwnership: deps.reconcileNextDispatchAnnouncementReplyOwnership,
        recordRuntimeEvent: deps.recordRuntimeEvent,
        ...deps.promptDispatch,
        sendUserMessage: deps.sendUserMessage,
    });
    return {
        mutation,
        dispatchNext: dispatch.dispatchNext,
        requestNextDispatchAnnouncement: dispatch.requestNextDispatchAnnouncement,
        cancelNextDispatchAnnouncement: dispatch.cancelNextDispatchAnnouncement,
        watchdog: Queue.createTelegramQueueDispatchWatchdogRuntime({
            hasQueuedItems: deps.store.hasQueuedItems,
            dispatchNextQueuedTelegramTurn: dispatch.dispatchNext,
            recordRuntimeEvent: deps.recordRuntimeEvent,
        }),
    };
}
export function createTelegramGenerativeAppLiveSurfaceBinding() {
    let current;
    return {
        get() { return current; },
        set(runtime) {
            current?.shutdown();
            current = runtime;
        },
        shutdown() {
            current?.shutdown();
            current = undefined;
        },
    };
}
export function createTelegramGenerativeAppBoundButtonActionInvoker(deps) {
    return async (action, query) => {
        let boundAction;
        let handedOff;
        try {
            boundAction = GenerativeApps.parseGenerativeAppBoundAction(action.prompt);
            if (!boundAction)
                return false;
            deps.assertExecutionCurrent(query);
            const chatId = query.message?.chat?.id;
            const messageId = query.message?.message_id;
            if (typeof chatId !== "number" || typeof messageId !== "number") {
                throw new Error("Generative App callback target is unavailable.");
            }
            const liveSurfaces = deps.getLiveSurfaceRuntime?.();
            handedOff = liveSurfaces?.take(GenerativeApps.getTelegramBindLiveSurfaceKey(boundAction.app, deps.getActiveProfileName?.() ?? "default", {
                chatId,
                ...(query.message?.message_thread_id !== undefined
                    ? { threadId: query.message.message_thread_id }
                    : {}),
            }));
            const result = await GenerativeApps.invokeGenerativeApp({
                agentDir: deps.agentDir,
                ...(deps.getExecutionFence(query)
                    ? { execution: deps.getExecutionFence(query) }
                    : {}),
                ...(boundAction.argument !== undefined
                    ? { argument: boundAction.argument }
                    : {}),
                ...(action.binding?.app === boundAction.app
                    ? {
                        expectedGeneration: action.binding.generation,
                        expectedRevision: action.binding.revision,
                    }
                    : {}),
                method: boundAction.method,
                app: boundAction.app,
            });
            deps.assertExecutionCurrent(query);
            const reply = deps.planOutput(result.output, {
                binding: {
                    generation: result.generation,
                    app: result.app,
                    revision: result.revision,
                },
            });
            if (handedOff && liveSurfaces) {
                try {
                    await liveSurfaces.resume(handedOff, result);
                    deps.assertExecutionCurrent(query);
                    return "edit";
                }
                catch (error) {
                    deps.recordRuntimeEvent("generative-app", error, {
                        phase: "bound-action-live-edit-fallback",
                        app: boundAction.app,
                        method: boundAction.method,
                    });
                }
            }
            if (result.viewMode === "edit" && deps.editInteractiveMessage) {
                let editFailed = false;
                try {
                    await deps.editInteractiveMessage(chatId, messageId, reply.markdown, "markdown", reply.replyMarkup ?? { inline_keyboard: [] });
                }
                catch (error) {
                    editFailed = true;
                    deps.recordRuntimeEvent("generative-app", error, {
                        phase: "bound-action-edit-fallback",
                        app: boundAction.app,
                        method: boundAction.method,
                    });
                }
                deps.assertExecutionCurrent(query);
                if (!editFailed)
                    return "edit";
            }
            deps.assertExecutionCurrent(query);
            await deps.sendMarkdownReply(chatId, messageId, reply.markdown, {
                replyMarkup: reply.replyMarkup,
            });
            deps.assertExecutionCurrent(query);
            return "new";
        }
        catch (error) {
            if (handedOff)
                deps.getLiveSurfaceRuntime?.()?.open(handedOff);
            deps.recordRuntimeEvent("generative-app", error, {
                phase: "bound-action",
                ...(boundAction
                    ? { app: boundAction.app, method: boundAction.method }
                    : {}),
            });
            throw error;
        }
    };
}
export function createTelegramAgentMessageToolRoutingRuntime(deps) {
    return {
        async resolveAgentTarget(selector) {
            if (!deps.ownsLeader())
                return deps.follower.resolveTarget(selector);
            const target = deps.local.resolveTarget(selector, deps.getSourceTarget());
            if (!target) {
                throw new Error("Telegram agent target is unavailable, ambiguous, or not live.");
            }
            return target;
        },
        async routeAgentMessage(message) {
            if (!deps.ownsLeader())
                return deps.follower.routeMessage(message);
            await deps.local.route({
                sourceTarget: deps.getSourceTarget(),
                sourceThreadName: deps.getSourceThreadName(),
                message,
            });
        },
        canSendDirect() {
            return deps.ownsDirectDelivery() || deps.isFollowerRegistered();
        },
    };
}
export function createTelegramAssistantOutputBindingRuntime(deps) {
    const authority = Routing.createTelegramAssistantOutputAuthorityRuntime(deps.authority);
    const sendOutput = OutboundHandlers.createTelegramAssistantOutputSender(deps.sender);
    const runtime = Activity.createTelegramAssistantOutputRuntime({
        ...authority,
        enqueue: deps.enqueue,
        prepareSend: (event) => event.source === "telegram" ? deps.prepareTelegramPreview?.() : undefined,
        async send(event, authority, isAuthorityActive) {
            await deps.waitForActivityIdle?.();
            if (!isAuthorityActive())
                return;
            await sendOutput(event, authority, isAuthorityActive);
        },
        recordFailure(event, error) {
            deps.recordRuntimeEvent("proactive-push", error, {
                activityId: event.activityId,
                sequence: event.sequence,
                placement: event.placement,
            });
        },
    });
    return {
        runtime,
        authority,
        observeEvent(event) {
            if (event.type === "assistant-segment")
                runtime.accept(event);
        },
    };
}
/** Compose public activity fanout, verbosity, and assistant output ordering. */
export function createTelegramActivityBindingRuntime(deps) {
    const publication = Activity.createTelegramActivityPublicationRuntime();
    const assistantOutputBinding = createTelegramAssistantOutputBindingRuntime({
        ...deps.assistantOutput,
        enqueue: publication.enqueue,
    });
    const activityVerbosityRuntime = ActivityVerbosity.createTelegramActivityVerbosityRuntime({
        ...deps.activityVerbosity,
        enqueue: publication.enqueue,
        captureAuthority: assistantOutputBinding.authority.captureAuthority,
        isAuthorityActive: assistantOutputBinding.authority.isAuthorityActive,
        recordFailure(operation, event, error) {
            deps.assistantOutput.recordRuntimeEvent("activity", error, {
                operation,
                eventType: event.type,
                activityId: event.activityId,
            });
        },
    });
    const activityRuntime = Activity.createTelegramActivityBridgeRuntime({
        generation: deps.generation,
        observeEvent(event) {
            assistantOutputBinding.observeEvent(event);
            activityVerbosityRuntime.accept(event);
        },
        recordFailure(handlerId, event, error) {
            deps.assistantOutput.recordRuntimeEvent("activity", error, {
                handlerId,
                eventType: event.type,
                activityId: event.activityId,
            });
        },
    });
    return {
        activityRuntime: {
            ...activityRuntime,
            onSessionStart() {
                publication.reset();
                activityRuntime.onSessionStart?.();
            },
            onSessionShutdown() {
                publication.reset();
                activityRuntime.onSessionShutdown();
            },
        },
        activityVerbosityRuntime,
        assistantOutputRuntime: assistantOutputBinding.runtime,
        publicationRuntime: {
            enqueue: publication.enqueue,
            reserve: publication.reserve,
            capture() {
                const authority = assistantOutputBinding.authority.captureAuthority();
                return {
                    target: authority.target ? { ...authority.target } : undefined,
                    isCurrent: () => assistantOutputBinding.authority.isAuthorityActive(authority),
                };
            },
        },
    };
}
export function registerTelegramCommandsAndTools({ pi, agentDir, configStore, persistConfig, setup, activeTurnRuntime, lockedPollingRuntime, stopPolling, recoverPollingStart, getDisconnectThreadName, onTransportChanged, getStatusLines, buttonActionStore, sendMarkdownReply, sendChannelMarkdownMessage, sendChannelMediaMessage, listChannelPosts, mutateChannelPost, callMultipart, getDefaultChatId, getDefaultTarget, resolveAgentTarget, routeAgentMessage, canSendDirect, setGenerativeAppLiveSurfaceRuntime, recordRuntimeEvent, updateStatus, }) {
    GenerativeApps.registerTelegramBindTool(pi, {
        agentDir,
        getActiveProfileName: configStore.getActiveProfileName,
        getActiveTurn: activeTurnRuntime.get,
        ...(setGenerativeAppLiveSurfaceRuntime
            ? { setLiveSurfaceRuntime: setGenerativeAppLiveSurfaceRuntime }
            : {}),
        isDeliveryHandleCurrent: Delivery.isTelegramDeliveryHandleCurrent,
        editView: (handle, view) => Delivery.editTelegramView(handle, view),
        planOutput: OutboundHandlers.createTelegramOutboundReplyPlanner(buttonActionStore, Config.createTelegramConfigControls(configStore).getAssistantRenderingMode),
        sendMarkdownReply,
        sendView: (view, options) => Delivery.sendTelegramView(view, options),
        recordRuntimeEvent,
    });
    ChannelPosts.registerTelegramChannelPostMutationTool(pi, { mutate: mutateChannelPost });
    ChannelPosts.registerTelegramChannelPostListTool(pi, { list: listChannelPosts });
    OutboundAttachments.registerTelegramOutboundAttachmentTool(pi, {
        getActiveTurn: activeTurnRuntime.get,
        getDefaultChatId,
        getDefaultTarget,
        canSendDirect,
        sendMultipart: callMultipart,
        recordRuntimeEvent,
    });
    OutboundAttachments.registerTelegramOutboundMessageTool(pi, {
        getDefaultChatId,
        getDefaultTarget,
        getActiveTurn: activeTurnRuntime.get,
        resolveAgentTarget,
        routeAgentMessage,
        canSendDirect,
        planMessage: OutboundHandlers.createTelegramOutboundReplyPlanner(buttonActionStore, Config.createTelegramConfigControls(configStore).getAssistantRenderingMode),
        sendMarkdownMessage: (chatId, markdown, options) => sendMarkdownReply(chatId, undefined, markdown, options),
        sendChannelMarkdownMessage,
        sendChannelMediaMessage,
        recordRuntimeEvent,
    });
    const queueAgentConnectionContext = (connected) => {
        pi.sendMessage({
            customType: "telegram-connection-state",
            content: connected
                ? Prompts.TELEGRAM_CONNECTED_CONTEXT_MESSAGE
                : Prompts.TELEGRAM_DISCONNECTED_CONTEXT_MESSAGE,
            display: false,
        }, { deliverAs: "nextTurn" });
    };
    Commands.registerTelegramBridgeCommands(pi, {
        promptForConfig: async (ctx, profileName) => {
            const nextProfileName = profileName ?? undefined;
            if (profileName && !Config.isValidTelegramProfileName(profileName)) {
                ctx.ui.notify(`Invalid Telegram profile name: ${profileName}`, "error");
                return;
            }
            const previousProfileName = configStore.getActiveProfileName();
            let setupConfigStore = configStore;
            let persistSetupConfig = persistConfig;
            if (!profileName) {
                if (previousProfileName !== nextProfileName) {
                    await (stopPolling ?? lockedPollingRuntime.stop)();
                }
                configStore.activateProfile(undefined);
                await onTransportChanged?.();
            }
            else {
                const storedConfig = configStore.getStoredConfig();
                setupConfigStore = Config.createTelegramConfigStore({
                    initialConfig: {
                        ...storedConfig,
                        profiles: {
                            ...(storedConfig.profiles ?? {}),
                            [profileName]: storedConfig.profiles?.[profileName] ?? {
                                botToken: "",
                            },
                        },
                    },
                });
                setupConfigStore.activateProfile(profileName);
                persistSetupConfig = async () => {
                    try {
                        if (previousProfileName !== profileName) {
                            await (stopPolling ?? lockedPollingRuntime.stop)();
                        }
                        const profile = Config.getTelegramProfileFields(setupConfigStore.get());
                        if (!profile) {
                            throw new Error(`Telegram profile "${profileName}" has no token.`);
                        }
                        await configStore.load();
                        const latestProfile = configStore.getStoredConfig().profiles?.[profileName];
                        configStore.setProfile(profileName, {
                            ...profile,
                            threadDisplayMode: latestProfile?.threadDisplayMode,
                        });
                        configStore.activateProfile(profileName);
                        await onTransportChanged?.();
                        await persistConfig(configStore.get());
                    }
                    catch (error) {
                        await configStore.load().catch(() => undefined);
                        configStore.activateProfile(previousProfileName);
                        await onTransportChanged?.();
                        throw error;
                    }
                };
            }
            const runSetup = Setup.createTelegramSetupPromptRuntime({
                getConfig: setupConfigStore.get,
                setConfig: setupConfigStore.set,
                setupGuard: setup,
                getMe: TelegramApi.fetchTelegramBotIdentity,
                resolveBotToken: (value) => Config.resolveTelegramBotToken(value, process.env),
                describeBotToken: (value) => Config.getTelegramBotTokenDiagnostic(value, process.env),
                persistConfig: persistSetupConfig,
                startPolling: lockedPollingRuntime.start,
                updateStatus,
                recordRuntimeEvent,
            });
            const completion = await runSetup(ctx);
            if (completion.status === "success") {
                queueAgentConnectionContext(true);
                if (profileName) {
                    ctx.ui.notify(`Profile "${profileName}" saved and connected.`, "info");
                }
            }
        },
        getStatusLines,
        reloadConfig: configStore.load,
        hasBotToken: configStore.hasBotToken,
        getBotTokenDiagnostic: configStore.getBotTokenDiagnostic,
        startPolling: async (ctx, options) => {
            try {
                return await lockedPollingRuntime.start(ctx, options);
            }
            catch (error) {
                recordRuntimeEvent("recovery", error, { phase: "polling-start" });
                throw error;
            }
        },
        stopPolling: stopPolling ?? lockedPollingRuntime.stop,
        recoverPollingStart,
        getDisconnectThreadName,
        queueAgentConnectionContext,
        updateStatus,
        getProfileNames: () => Config.getTelegramProfileNames(configStore.getStoredConfig()),
        activateDefaultProfileConfig: async () => {
            const previousProfileName = configStore.getActiveProfileName();
            await configStore.load();
            if (previousProfileName) {
                await (stopPolling ?? lockedPollingRuntime.stop)();
            }
            configStore.activateProfile(undefined);
            await onTransportChanged?.();
        },
        activateProfileConfig: async (_ctx, profileName) => {
            const previousProfileName = configStore.getActiveProfileName();
            await configStore.load();
            if (!Config.isValidTelegramProfileName(profileName))
                return false;
            const storedConfig = configStore.getStoredConfig();
            if (!storedConfig.profiles?.[profileName])
                return false;
            if (previousProfileName !== profileName) {
                await (stopPolling ?? lockedPollingRuntime.stop)();
            }
            if (!configStore.activateProfile(profileName))
                return false;
            await onTransportChanged?.();
            return true;
        },
    });
}
export function registerTelegramLifecycleRuntimeHooks({ pi, publicationRuntime, activityRuntime, activityVerbosityRuntime, assistantOutputRuntime, sessionLifecycleRuntime, configStore, abort, typing, lifecycle, activeTurnRuntime, telegramQueueStore, modelSwitchController, previewRuntime, promptDispatchRuntime, deferredQueueDispatchRuntime, modelContextAvailabilityRuntime, disconnectOnQuit, onSessionStarted, shutdownGenerativeAppLiveSurfaces, resolveAutomaticThreadCleanupEnabled, buttonActionStore, callMultipart, sendChatAction, sendRecordVoiceAction, sendMarkdownReply, sendTextReply, dispatchNextQueuedTelegramTurn, onPromptHandedOff, answerGuestQuery, deleteMessage, sendGuestReply, editGuestReply, stopGuestPlaceholder, preparePreviewDelivery, finalizeMarkdownPreview, proactivePushTargetGetter, getAssistantRenderingMode, recordMessageOwnership, canSendAgentActivity, isSessionContextActive = () => true, isTurnTransportActive, updateStatus, recordRuntimeEvent, }) {
    const agentEndResetter = Runtime.createTelegramAgentEndResetter({
        abort,
        typing,
        clearActiveTurn: activeTurnRuntime.clear,
        resetToolExecutions: lifecycle.resetActiveToolExecutions,
        clearPendingModelSwitch: modelSwitchController.clearPendingSwitch,
        clearDispatchPending: lifecycle.clearDispatchPending,
    });
    const queuedAttachmentSender = OutboundAttachments.createTelegramQueuedOutboundAttachmentSender({
        sendMultipart: callMultipart,
        sendTextReply,
        recordRuntimeEvent,
    });
    const richAttachmentSender = OutboundAttachments.createTelegramRichOutboundAttachmentSender({
        sendMultipart: callMultipart,
        getRenderingMode: getAssistantRenderingMode,
        recordOwnership: recordMessageOwnership,
        recordRuntimeEvent,
    });
    const sendGuestAttachment = async (turn, attachment, caption) => {
        const stagingTarget = proactivePushTargetGetter();
        const stagingChatId = stagingTarget?.chatId;
        if (stagingChatId === undefined) {
            throw new Error("Guest attachment staging requires a paired Telegram chat");
        }
        await OutboundAttachments.deliverTelegramGuestCachedAttachment({
            guestQueryId: turn.guestQueryId,
            stagingChatId,
            stagingTarget,
            attachment,
            caption,
            sendMultipart: callMultipart,
            answerGuestQuery: (guestQueryId, result) => answerGuestQuery(guestQueryId, undefined, { result }),
            answerGuestText: (guestQueryId, text) => answerGuestQuery(guestQueryId, text),
            fallbackText: caption ||
                "Telegram bridge could not deliver the requested attachment.",
            deleteMessage,
            recordRuntimeEvent,
        });
    };
    const outboundReplyPlanner = OutboundHandlers.createTelegramOutboundReplyPlanner(buttonActionStore, getAssistantRenderingMode);
    const voiceReplySenderDeps = {
        execCommand: CommandTemplates.execCommandTemplate,
        sendMultipart: callMultipart,
        sendTextReply,
        sendChatAction,
        sendRecordVoiceAction,
        getHandlers: configStore.getOutboundHandlers,
        recordRuntimeEvent,
    };
    const outboundReplyArtifactSender = OutboundHandlers.createTelegramOutboundReplyArtifactSender(voiceReplySenderDeps);
    const sendGuestVoiceReply = async (turn, plan, caption) => {
        const stagingTarget = proactivePushTargetGetter();
        const stagingChatId = stagingTarget?.chatId;
        if (stagingChatId === undefined) {
            throw new Error("Guest voice staging requires a paired Telegram chat");
        }
        const guestVoiceSender = OutboundHandlers.createTelegramOutboundReplyArtifactSender({
            ...voiceReplySenderDeps,
            sendChatAction: undefined,
            sendRecordVoiceAction: undefined,
            sendMultipart: async (_method, _fields, _fileField, filePath, fileName) => {
                try {
                    await OutboundAttachments.deliverTelegramGuestCachedAttachment({
                        guestQueryId: turn.guestQueryId,
                        stagingChatId,
                        stagingTarget,
                        attachment: { path: filePath, fileName },
                        caption,
                        sendMultipart: callMultipart,
                        answerGuestQuery: (guestQueryId, result) => answerGuestQuery(guestQueryId, undefined, { result }),
                        answerGuestText: (guestQueryId, text) => answerGuestQuery(guestQueryId, text),
                        fallbackText: caption || "Telegram bridge could not deliver the voice reply.",
                        deleteMessage,
                        recordRuntimeEvent,
                    });
                }
                catch (error) {
                    recordRuntimeEvent("delivery", error, {
                        phase: "guest-voice-answer",
                        guestQueryId: turn.guestQueryId,
                    });
                }
                return {};
            },
        });
        await guestVoiceSender(turn, {
            ...plan,
            ...(plan.voiceReplies?.length
                ? { voiceReplies: [plan.voiceReplies[0]] }
                : {}),
        }, { replyToPrompt: false });
    };
    let pendingFinalPublication;
    const cancelPendingFinalPublication = () => {
        pendingFinalPublication?.reservation.cancel();
        pendingFinalPublication = undefined;
    };
    const recordPublicationFailure = (error) => {
        recordRuntimeEvent("delivery", error, { phase: "agent-end-background-delivery" });
    };
    const scheduleActiveTurnDelivery = (task) => {
        void publicationRuntime.enqueue(task).catch(recordPublicationFailure);
    };
    const agentLifecycleHooks = Queue.createTelegramAgentLifecycleHooks({
        setAbortHandler: Runtime.createTelegramContextAbortHandlerSetter(abort),
        getQueuedItems: telegramQueueStore.getQueuedItems,
        hasPendingDispatch: lifecycle.hasDispatchPending,
        hasActiveTurn: activeTurnRuntime.has,
        resetToolExecutions: lifecycle.resetActiveToolExecutions,
        resetPendingModelSwitch: modelSwitchController.clearPendingSwitch,
        setQueuedItems: telegramQueueStore.setQueuedItems,
        clearDispatchPending: lifecycle.clearDispatchPending,
        setFoldQueuedPromptsIntoHistory: lifecycle.setFoldQueuedPromptsIntoHistory,
        setActiveTurn: activeTurnRuntime.set,
        onPromptHandedOff: (turn, ctx) => {
            assistantOutputRuntime.beginTurn();
            onPromptHandedOff?.(turn, ctx);
        },
        createPreviewState: previewRuntime.resetState,
        startTypingLoop: (ctx) => {
            const turn = activeTurnRuntime.get();
            promptDispatchRuntime.startTypingLoop(ctx, turn?.chatId, {
                target: turn?.target,
            });
        },
        updateStatus,
        getActiveTurn: activeTurnRuntime.get,
        loadConfig: configStore.load,
        extractAssistant: Replies.extractRunAssistantMessage,
        isAssistantAlreadyPublished: (assistant) => !!assistant.text && assistantOutputRuntime.hasAdmittedTelegramIntermediate(assistant.text),
        getFoldQueuedPromptsIntoHistory: lifecycle.shouldFoldQueuedPromptsIntoHistory,
        resetRuntimeState: agentEndResetter,
        isSessionActive: isSessionContextActive,
        isTurnTransportActive,
        waitForTypingIdle: typing.waitForIdle,
        dispatchNextQueuedTelegramTurn,
        requestDeferredDispatchNextQueuedTelegramTurn: deferredQueueDispatchRuntime.request,
        scheduleActiveTurnDelivery,
        reserveActiveTurnDelivery() {
            const pending = pendingFinalPublication;
            pendingFinalPublication = undefined;
            const matches = pending?.turn === activeTurnRuntime.get();
            if (!matches)
                pending?.reservation.cancel();
            const reservation = matches && pending ? pending.reservation : publicationRuntime.reserve();
            return {
                schedule: (task) => { void reservation.publish(task).catch(recordPublicationFailure); },
                cancel: reservation.cancel,
            };
        },
        preparePreviewDelivery,
        preparePreviewClear: previewRuntime.prepareClear,
        clearPreview: previewRuntime.clear,
        setPreviewPendingText: previewRuntime.setPendingText,
        finalizeMarkdownPreview,
        sendMarkdownReply,
        sendTextReply,
        sendQueuedAttachments: queuedAttachmentSender,
        sendRichAttachmentReply: richAttachmentSender,
        answerGuestQuery,
        sendGuestReply,
        editGuestReply,
        stopGuestPlaceholder,
        sendGuestAttachment,
        sendGuestVoiceReply,
        planOutboundReply: outboundReplyPlanner,
        sendOutboundReplyArtifacts: outboundReplyArtifactSender,
        recordRuntimeEvent,
        getActiveToolExecutions: lifecycle.getActiveToolExecutions,
        setActiveToolExecutions: lifecycle.setActiveToolExecutions,
        triggerPendingModelSwitchAbort: modelSwitchController.triggerPendingAbort,
    });
    Lifecycle.setResetTransportReplyDedup(Replies.resetTransportReplyDedup);
    const agentStartWithDedupReset = Lifecycle.createAgentStartDedupHook(agentLifecycleHooks.onAgentStart, scheduleActiveTurnDelivery);
    let uiPromptActive = false;
    const startAgentActivityTypingLoop = (ctx) => {
        if (uiPromptActive || !canSendAgentActivity(ctx))
            return false;
        const turn = activeTurnRuntime.get();
        const target = turn?.target ?? proactivePushTargetGetter();
        return (promptDispatchRuntime.startTypingLoop(ctx, turn?.chatId ?? target?.chatId, { target }) !== false);
    };
    const startActiveTurnTypingLoop = (ctx) => {
        if (uiPromptActive)
            return;
        const turn = activeTurnRuntime.get();
        promptDispatchRuntime.startTypingLoop(ctx, turn?.chatId, {
            target: turn?.target,
        });
    };
    let observedAutomaticCompaction = false;
    let agentWorkActive = false;
    const prepareCompactionNotice = (text, ctx) => {
        const authority = publicationRuntime.capture();
        const turn = activeTurnRuntime.get();
        const selectedTarget = turn?.target ?? authority.target;
        const target = selectedTarget ? { ...selectedTarget } : undefined;
        const replyToMessageId = turn?.replyToMessageId;
        return async () => {
            if (!target || !isSessionContextActive(ctx) || !authority.isCurrent())
                return;
            if (turn && isTurnTransportActive?.(turn) === false)
                return;
            try {
                await sendMarkdownReply(target.chatId, replyToMessageId, text, { target });
            }
            catch (error) {
                recordRuntimeEvent("delivery", error, { phase: "compaction-notice" });
            }
        };
    };
    const sendCompactionNotice = (text, ctx) => {
        scheduleActiveTurnDelivery(prepareCompactionNotice(text, ctx));
    };
    const compactionObserver = Lifecycle.createTelegramCompactionObserverRuntime({
        isContextActive: isSessionContextActive,
        setCompactionInProgress: lifecycle.setCompactionInProgress,
        updateStatus,
        startTypingLoop: startAgentActivityTypingLoop,
        stopTypingLoop: typing.stop,
        requestDeferredDispatchNextQueuedTelegramTurn: deferredQueueDispatchRuntime.request,
        dispatchNextQueuedTelegramTurn,
        recordRuntimeEvent,
        onCompactionAbandoned: () => {
            observedAutomaticCompaction = false;
            activityRuntime.onCompactionAbandoned();
        },
    });
    const messageActivityTypingHooks = Lifecycle.createTelegramMessageActivityTypingHooks({
        hasActiveTurn: activeTurnRuntime.has,
        startTypingLoop: startActiveTurnTypingLoop,
        onMessageStart: previewRuntime.onMessageStart,
        onMessageUpdate: previewRuntime.onMessageUpdate,
        recordRuntimeEvent,
    });
    const messageActivityHooks = messageActivityTypingHooks;
    Lifecycle.registerTelegramLifecycleHooks(pi, {
        isSessionActive: isSessionContextActive,
        ...sessionLifecycleRuntime,
        ...agentLifecycleHooks,
        onInput(event) {
            activityRuntime.recordInputSource(event.source ?? "unknown");
        },
        async onSessionStart(event, ctx) {
            cancelPendingFinalPublication();
            previewRuntime.invalidate();
            assistantOutputRuntime.start();
            activityRuntime.onSessionStart?.();
            activityVerbosityRuntime?.reset();
            modelContextAvailabilityRuntime.reconcile();
            await sessionLifecycleRuntime.onSessionStart(event, ctx);
            onSessionStarted?.(event, ctx);
        },
        async onSessionShutdown(event, ctx) {
            if (!isSessionContextActive(ctx))
                return;
            shutdownGenerativeAppLiveSurfaces?.();
            agentLifecycleHooks.clearRetainedAgentEnd();
            activityRuntime.onSessionShutdown();
            activityVerbosityRuntime?.reset();
            assistantOutputRuntime.stop();
            observedAutomaticCompaction = false;
            agentWorkActive = false;
            cancelPendingFinalPublication();
            uiPromptActive = false;
            compactionObserver.onSessionShutdown();
            if (event.reason === "quit" && disconnectOnQuit) {
                try {
                    const automaticCleanupEnabled = (await resolveAutomaticThreadCleanupEnabled?.()) ?? true;
                    if (automaticCleanupEnabled)
                        await disconnectOnQuit();
                }
                catch (error) {
                    recordRuntimeEvent("session", error, {
                        phase: "automatic-disconnect-on-quit",
                    });
                }
            }
            await sessionLifecycleRuntime.onSessionShutdown(event, ctx);
        },
        async onSessionBeforeCompact(event, ctx) {
            if (!isSessionContextActive(ctx))
                return;
            const shouldNotify = !(lifecycle.isCompactionInProgress?.() ?? false);
            if (shouldNotify)
                observedAutomaticCompaction = true;
            activityRuntime.onCompactionStart(Pi.getSessionCompactionReason(event));
            compactionObserver.onSessionBeforeCompact(event, ctx);
            if (shouldNotify)
                sendCompactionNotice(Commands.TELEGRAM_COMPACTION_STARTED_MARKDOWN, ctx);
        },
        async onSessionCompact(event, ctx) {
            if (!isSessionContextActive(ctx))
                return;
            activityRuntime.onCompactionEnd(Pi.getSessionCompactionReason(event));
            compactionObserver.onSessionCompact(event, ctx);
            if (observedAutomaticCompaction) {
                observedAutomaticCompaction = false;
                sendCompactionNotice(Commands.TELEGRAM_COMPACTION_COMPLETED_MARKDOWN, ctx);
            }
        },
        async onSessionCompactFailed(event, ctx) {
            if (!isSessionContextActive(ctx))
                return;
            const shouldNotify = observedAutomaticCompaction;
            compactionObserver.onSessionCompactFailed(event, ctx);
            if (!shouldNotify)
                return;
            const notice = event.aborted
                ? "**⚠️ Compaction cancelled.**"
                : "**⚠️ Compaction failed.**";
            sendCompactionNotice(notice, ctx);
        },
        async onAgentStart(event, ctx) {
            if (!isSessionContextActive(ctx))
                return;
            agentWorkActive = true;
            cancelPendingFinalPublication();
            await agentStartWithDedupReset(event, ctx);
            const turn = activeTurnRuntime.get();
            activityRuntime.onAgentStart(turn?.target, turn?.replyToMessageId);
            startAgentActivityTypingLoop(ctx);
        },
        async onToolExecutionStart(event, ctx) {
            if (!isSessionContextActive(ctx))
                return;
            agentLifecycleHooks.onToolExecutionStart();
            activityRuntime.onToolStart({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
            });
        },
        onToolExecutionUpdate(event, ctx) {
            if (!isSessionContextActive(ctx))
                return;
            activityRuntime.onToolUpdate({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                update: event.partialResult,
            });
        },
        async onToolExecutionEnd(event, ctx) {
            if (!isSessionContextActive(ctx))
                return;
            activityRuntime.onToolEnd({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                result: event.result,
                isError: event.isError,
            });
            agentLifecycleHooks.onToolExecutionEnd(event, ctx);
        },
        async onMessageStart(event, ctx) {
            if (!isSessionContextActive(ctx))
                return;
            await messageActivityHooks.onMessageStart(event, ctx);
        },
        async onMessageUpdate(event, ctx) {
            if (!isSessionContextActive(ctx))
                return;
            if (event.assistantMessageEvent) {
                activityRuntime.onAssistantEvent(event.assistantMessageEvent);
            }
            await messageActivityHooks.onMessageUpdate(event, ctx);
        },
        onMessageEnd(event, ctx) {
            if (!isSessionContextActive(ctx))
                return;
            if (event.message.role === "assistant") {
                previewRuntime.seal();
                activityRuntime.onAssistantMessageEnd(event.message.stopReason);
            }
            if (event.message.role !== "assistant" || event.message.stopReason === "toolUse" || event.message.stopReason === "aborted")
                return;
            const turn = activeTurnRuntime.get();
            if (!turn || turn.guestQueryId || pendingFinalPublication?.turn === turn)
                return;
            cancelPendingFinalPublication();
            const assistant = Replies.extractLatestAssistantMessageText([event.message]);
            if (!assistant.text && assistant.stopReason !== "error" && turn.queuedAttachments.length === 0)
                return;
            pendingFinalPublication = { turn, reservation: publicationRuntime.reserve() };
        },
        onUiPromptStart(event, ctx) {
            if (!isSessionContextActive(ctx))
                return;
            uiPromptActive = true;
            typing.stop();
            activityRuntime.onUiPromptStart(event.kind, event.title);
            updateStatus(ctx);
        },
        onUiPromptEnd(_event, ctx) {
            if (!isSessionContextActive(ctx))
                return;
            uiPromptActive = false;
            activityRuntime.onUiPromptEnd();
            if (agentWorkActive || lifecycle.isCompactionInProgress()) {
                startAgentActivityTypingLoop(ctx);
            }
            updateStatus(ctx);
        },
        async onAgentEnd(event, ctx) {
            if (!isSessionContextActive(ctx))
                return;
            if (pendingFinalPublication && pendingFinalPublication.turn !== activeTurnRuntime.get()) {
                cancelPendingFinalPublication();
                return;
            }
            activityRuntime.onAgentEnd();
            await agentLifecycleHooks.onAgentEnd(event, ctx);
        },
        async onAgentSettled(event, ctx) {
            if (!isSessionContextActive(ctx))
                return;
            const pending = pendingFinalPublication;
            try {
                await agentLifecycleHooks.onAgentSettled(event, ctx);
            }
            finally {
                if (pendingFinalPublication === pending)
                    cancelPendingFinalPublication();
            }
            if (!isSessionContextActive(ctx))
                return;
            agentWorkActive = false;
            activityRuntime.onAgentSettled();
            modelContextAvailabilityRuntime.reconcile();
        },
        onBeforeAgentStart: Prompts.createTelegramProactiveBeforeAgentStartHook({
            reconcileAvailability: modelContextAvailabilityRuntime.reconcile,
            isAvailable: canSendAgentActivity,
        }),
    });
}
