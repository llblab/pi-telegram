/**
 * Telegram bridge binding composition
 * Zones: telegram, pi agent, orchestration
 * Owns pi-facing tool, command, and lifecycle hook registration for the entrypoint
 */

import * as Activity from "./activity.ts";
import * as CommandTemplates from "./command-templates.ts";
import * as Commands from "./commands.ts";
import * as Config from "./config.ts";
import * as Keyboard from "./keyboard.ts";
import * as Lifecycle from "./lifecycle.ts";
import * as Locks from "./locks.ts";
import * as Model from "./model.ts";
import * as OutboundAttachments from "./outbound-attachments.ts";
import * as OutboundHandlers from "./outbound.ts";
import * as Pi from "./pi.ts";
import * as Preview from "./preview.ts";
import * as Prompts from "./prompts.ts";
import * as Queue from "./queue.ts";
import * as Replies from "./replies.ts";
import * as Runtime from "./runtime.ts";
import * as Setup from "./setup.ts";
import * as Status from "./status.ts";
import * as TelegramApi from "./telegram-api.ts";

type ActivePiModel = NonNullable<Pi.ExtensionContext["model"]>;

type TelegramRuntimeEventRecorder = (
  category: string,
  error: unknown,
  details?: Record<string, unknown>,
) => void;

type TelegramBridgeStatusUpdater =
  Status.TelegramStatusRuntime<Pi.ExtensionContext>["updateStatus"];

interface TelegramCommandsAndToolsBindingDeps {
  pi: Pi.ExtensionAPI;
  configStore: Config.TelegramConfigStore;
  persistConfig: (config?: Config.TelegramConfig) => Promise<void>;
  setup: Setup.TelegramSetupGuard;
  activeTurnRuntime: Queue.TelegramActiveTurnStore<Queue.PendingTelegramTurn>;
  lockedPollingRuntime: Locks.TelegramLockedPollingRuntime<Pi.ExtensionContext>;
  stopPolling?: () => Promise<void | string>;
  onTransportChanged?: () => Promise<void> | void;
  getStatusLines: (
    options?: Status.TelegramBridgeStatusLineOptions,
  ) => string[];
  buttonActionStore: OutboundHandlers.TelegramButtonActionStore;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: { replyMarkup?: unknown },
  ) => Promise<number | undefined>;
  callMultipart: OutboundHandlers.TelegramVoiceReplySenderDeps["sendMultipart"];
  getDefaultChatId: () => number | undefined;
  getDefaultTarget?: () => OutboundAttachments.TelegramQueuedOutboundAttachmentTurnView["target"];
  canSendDirect: () => boolean;
  updateStatus: TelegramBridgeStatusUpdater;
  recordRuntimeEvent: TelegramRuntimeEventRecorder;
}

export function registerTelegramCommandsAndTools({
  pi,
  configStore,
  persistConfig,
  setup,
  activeTurnRuntime,
  lockedPollingRuntime,
  stopPolling,
  onTransportChanged,
  getStatusLines,
  buttonActionStore,
  sendMarkdownReply,
  callMultipart,
  getDefaultChatId,
  getDefaultTarget,
  canSendDirect,
  recordRuntimeEvent,
  updateStatus,
}: TelegramCommandsAndToolsBindingDeps): void {
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
    canSendDirect,
    planMessage:
      OutboundHandlers.createTelegramOutboundReplyPlanner(buttonActionStore),
    sendMarkdownMessage: (chatId, markdown, options) =>
      sendMarkdownReply(chatId, undefined, markdown, options),
    recordRuntimeEvent,
  });
  Prompts.registerTelegramHelpTool(pi, {
    getActiveProfileName: configStore.getActiveProfileName,
  });
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
      } else {
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
            const profile = Config.getTelegramProfileFields(
              setupConfigStore.get(),
            );
            if (!profile) {
              throw new Error(
                `Telegram profile "${profileName}" has no token.`,
              );
            }
            await configStore.load();
            const latestConfig = configStore.getStoredConfig();
            configStore.activateProfile(undefined);
            configStore.set({
              ...latestConfig,
              profiles: {
                ...(latestConfig.profiles ?? {}),
                [profileName]: profile,
              },
            });
            configStore.activateProfile(profileName);
            await onTransportChanged?.();
            await persistConfig(configStore.get());
          } catch (error) {
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
        persistConfig: persistSetupConfig,
        startPolling: lockedPollingRuntime.start,
        updateStatus,
        recordRuntimeEvent,
      });
      const completion = await runSetup(ctx);
      if (profileName && completion.status === "success") {
        ctx.ui.notify(`Profile "${profileName}" saved and connected.`, "info");
      }
    },
    getStatusLines,
    reloadConfig: configStore.load,
    hasBotToken: configStore.hasBotToken,
    startPolling: lockedPollingRuntime.start,
    stopPolling: stopPolling ?? lockedPollingRuntime.stop,
    updateStatus,
    getProfileNames: () =>
      Config.getTelegramProfileNames(configStore.getStoredConfig()),
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
      if (!Config.isValidTelegramProfileName(profileName)) return false;
      const storedConfig = configStore.getStoredConfig();
      if (!storedConfig.profiles?.[profileName]) return false;
      if (previousProfileName !== profileName) {
        await (stopPolling ?? lockedPollingRuntime.stop)();
      }
      if (!configStore.activateProfile(profileName)) return false;
      await onTransportChanged?.();
      return true;
    },
  });
}

interface TelegramLifecycleBindingDeps {
  pi: Pi.ExtensionAPI;
  activityRuntime: Activity.TelegramActivityRuntime;
  sessionLifecycleRuntime: Pick<
    Lifecycle.TelegramLifecycleRegistrationDeps,
    "onSessionStart" | "onSessionShutdown" | "onModelSelect"
  >;
  configStore: Pick<
    Config.TelegramConfigStore,
    "get" | "getOutboundHandlers" | "hasBotToken" | "load"
  >;
  abort: Runtime.TelegramRuntimeAbortPort;
  typing: Runtime.TelegramRuntimeTypingPort;
  lifecycle: Runtime.TelegramRuntimeLifecyclePort;
  activeTurnRuntime: Queue.TelegramActiveTurnStore<Queue.PendingTelegramTurn>;
  telegramQueueStore: Queue.TelegramQueueStore<Pi.ExtensionContext>;
  modelSwitchController: Model.TelegramModelSwitchController<
    Pi.ExtensionContext,
    Model.ScopedTelegramModel<ActivePiModel>
  >;
  previewRuntime: Preview.TelegramAssistantPreviewRuntime<
    Pi.AgentEndEvent["messages"][number],
    Keyboard.TelegramInlineKeyboardMarkup
  >;
  promptDispatchRuntime: Runtime.TelegramPromptDispatchRuntime<Pi.ExtensionContext>;
  deferredQueueDispatchRuntime: Queue.TelegramDeferredQueueDispatchRuntime<Pi.ExtensionContext>;
  lockOwnershipGuard: Pick<
    Locks.TelegramLockOwnershipGuard<Pi.ExtensionContext>,
    "ownsContext"
  >;
  buttonActionStore: OutboundHandlers.TelegramButtonActionStore;
  callMultipart: OutboundHandlers.TelegramVoiceReplySenderDeps["sendMultipart"];
  sendChatAction: NonNullable<
    OutboundHandlers.TelegramVoiceReplySenderDeps["sendChatAction"]
  >;
  sendRecordVoiceAction: NonNullable<
    OutboundHandlers.TelegramVoiceReplySenderDeps["sendRecordVoiceAction"]
  >;
  sendMarkdownReply: Queue.TelegramAgentEndHookRuntimeDeps<
    Queue.PendingTelegramTurn,
    Pi.ExtensionContext,
    Pi.AgentEndEvent["messages"][number],
    Keyboard.TelegramInlineKeyboardMarkup
  >["sendMarkdownReply"];
  sendTextReply: Queue.TelegramAgentEndHookRuntimeDeps<
    Queue.PendingTelegramTurn,
    Pi.ExtensionContext,
    Pi.AgentEndEvent["messages"][number],
    Keyboard.TelegramInlineKeyboardMarkup
  >["sendTextReply"] &
    NonNullable<OutboundHandlers.TelegramVoiceReplySenderDeps["sendTextReply"]>;
  dispatchNextQueuedTelegramTurn: (ctx: Pi.ExtensionContext) => void;
  answerGuestQuery: TelegramApi.TelegramBridgeApiRuntime["answerGuestQuery"];
  deleteMessage: TelegramApi.TelegramBridgeApiRuntime["deleteMessage"];
  sendGuestReply: NonNullable<
    Queue.TelegramAgentEndHookRuntimeDeps<
      Queue.PendingTelegramTurn,
      Pi.ExtensionContext,
      Pi.AgentEndEvent["messages"][number],
      Keyboard.TelegramInlineKeyboardMarkup
    >["sendGuestReply"]
  >;
  finalizeMarkdownPreview: Queue.TelegramAgentEndHookRuntimeDeps<
    Queue.PendingTelegramTurn,
    Pi.ExtensionContext,
    Pi.AgentEndEvent["messages"][number],
    Keyboard.TelegramInlineKeyboardMarkup
  >["finalizeMarkdownPreview"];
  proactivePushChatIdGetter: () => number | undefined;
  proactivePushTargetGetter: () => Queue.TelegramQueueTarget | undefined;
  isProactivePushEnabled: () => boolean;
  canSendProactivePush: (ctx: Pi.ExtensionContext) => boolean;
  canSendAgentActivity: (ctx: Pi.ExtensionContext) => boolean;
  isSessionContextActive: (ctx: Pi.ExtensionContext) => boolean;
  isTurnTransportActive?: (turn: Queue.PendingTelegramTurn) => boolean;
  updateStatus: TelegramBridgeStatusUpdater;
  recordRuntimeEvent: TelegramRuntimeEventRecorder;
}

export function registerTelegramLifecycleRuntimeHooks({
  pi,
  activityRuntime,
  sessionLifecycleRuntime,
  configStore,
  abort,
  typing,
  lifecycle,
  activeTurnRuntime,
  telegramQueueStore,
  modelSwitchController,
  previewRuntime,
  promptDispatchRuntime,
  deferredQueueDispatchRuntime,
  lockOwnershipGuard,
  buttonActionStore,
  callMultipart,
  sendChatAction,
  sendRecordVoiceAction,
  sendMarkdownReply,
  sendTextReply,
  dispatchNextQueuedTelegramTurn,
  answerGuestQuery,
  deleteMessage,
  sendGuestReply,
  finalizeMarkdownPreview,
  proactivePushChatIdGetter,
  proactivePushTargetGetter,
  isProactivePushEnabled,
  canSendProactivePush,
  canSendAgentActivity,
  isSessionContextActive = () => true,
  isTurnTransportActive,
  updateStatus,
  recordRuntimeEvent,
}: TelegramLifecycleBindingDeps): void {
  const agentEndResetter = Runtime.createTelegramAgentEndResetter({
    abort,
    typing,
    clearActiveTurn: activeTurnRuntime.clear,
    resetToolExecutions: lifecycle.resetActiveToolExecutions,
    clearPendingModelSwitch: modelSwitchController.clearPendingSwitch,
    clearDispatchPending: lifecycle.clearDispatchPending,
  });
  const queuedAttachmentSender =
    OutboundAttachments.createTelegramQueuedOutboundAttachmentSender({
      sendMultipart: callMultipart,
      sendTextReply,
      recordRuntimeEvent,
    });
  const sendGuestAttachment = async (
    turn: Queue.PendingTelegramTurn,
    attachment: Queue.QueuedAttachment,
    caption?: string,
  ): Promise<void> => {
    const stagingTarget = proactivePushTargetGetter();
    const stagingChatId = stagingTarget?.chatId ?? proactivePushChatIdGetter();
    if (stagingChatId === undefined) {
      throw new Error(
        "Guest attachment staging requires a paired Telegram chat",
      );
    }
    await OutboundAttachments.deliverTelegramGuestCachedAttachment({
      guestQueryId: turn.guestQueryId!,
      stagingChatId,
      stagingTarget,
      attachment,
      caption,
      sendMultipart: callMultipart,
      answerGuestQuery: (guestQueryId, result) =>
        answerGuestQuery(guestQueryId, undefined, { result }),
      answerGuestText: (guestQueryId, text) =>
        answerGuestQuery(guestQueryId, text),
      fallbackText:
        caption ||
        "Telegram bridge could not deliver the requested attachment.",
      deleteMessage,
      recordRuntimeEvent,
    });
  };
  const outboundReplyPlanner =
    OutboundHandlers.createTelegramOutboundReplyPlanner(buttonActionStore);
  const voiceReplySenderDeps = {
    execCommand: CommandTemplates.execCommandTemplate,
    sendMultipart: callMultipart,
    sendTextReply,
    sendChatAction,
    sendRecordVoiceAction,
    getHandlers: configStore.getOutboundHandlers,
    recordRuntimeEvent,
  };
  const outboundReplyArtifactSender =
    OutboundHandlers.createTelegramOutboundReplyArtifactSender(
      voiceReplySenderDeps,
    );
  const sendGuestVoiceReply = async (
    turn: Queue.PendingTelegramTurn,
    plan: OutboundHandlers.TelegramOutboundReplyPlan,
    caption?: string,
  ): Promise<void> => {
    const stagingTarget = proactivePushTargetGetter();
    const stagingChatId = stagingTarget?.chatId ?? proactivePushChatIdGetter();
    if (stagingChatId === undefined) {
      throw new Error("Guest voice staging requires a paired Telegram chat");
    }
    const guestVoiceSender =
      OutboundHandlers.createTelegramOutboundReplyArtifactSender({
        ...voiceReplySenderDeps,
        sendChatAction: undefined,
        sendRecordVoiceAction: undefined,
        sendMultipart: async (
          _method,
          _fields,
          _fileField,
          filePath,
          fileName,
        ) => {
          try {
            await OutboundAttachments.deliverTelegramGuestCachedAttachment({
              guestQueryId: turn.guestQueryId!,
              stagingChatId,
              stagingTarget,
              attachment: { path: filePath, fileName },
              caption,
              sendMultipart: callMultipart,
              answerGuestQuery: (guestQueryId, result) =>
                answerGuestQuery(guestQueryId, undefined, { result }),
              answerGuestText: (guestQueryId, text) =>
                answerGuestQuery(guestQueryId, text),
              fallbackText:
                caption || "Telegram bridge could not deliver the voice reply.",
              deleteMessage,
              recordRuntimeEvent,
            });
          } catch (error) {
            recordRuntimeEvent("delivery", error, {
              phase: "guest-voice-answer",
              guestQueryId: turn.guestQueryId,
            });
          }
          return {};
        },
      });
    await guestVoiceSender(
      turn,
      {
        ...plan,
        ...(plan.voiceReplies?.length
          ? { voiceReplies: [plan.voiceReplies[0]!] }
          : {}),
      },
      { replyToPrompt: false },
    );
  };
  const agentLifecycleHooks = Queue.createTelegramAgentLifecycleHooks<
    Queue.PendingTelegramTurn,
    Pi.ExtensionContext,
    unknown,
    Keyboard.TelegramInlineKeyboardMarkup
  >({
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
    extractAssistant: Replies.extractLatestAssistantMessageText,
    getFoldQueuedPromptsIntoHistory:
      lifecycle.shouldFoldQueuedPromptsIntoHistory,
    resetRuntimeState: agentEndResetter,
    isSessionActive: isSessionContextActive,
    isTurnTransportActive,
    waitForTypingIdle: typing.waitForIdle,
    dispatchNextQueuedTelegramTurn,
    requestDeferredDispatchNextQueuedTelegramTurn:
      deferredQueueDispatchRuntime.request,
    scheduleActiveTurnDelivery(task) {
      const timer = setTimeout(() => {
        void task().catch((error) => {
          recordRuntimeEvent("delivery", error, {
            phase: "agent-end-background-delivery",
          });
        });
      }, 0);
      timer.unref?.();
    },
    clearPreview: previewRuntime.clear,
    setPreviewPendingText: previewRuntime.setPendingText,
    finalizeMarkdownPreview,
    sendMarkdownReply,
    sendTextReply,
    sendQueuedAttachments: queuedAttachmentSender,
    answerGuestQuery,
    sendGuestReply,
    sendGuestAttachment,
    sendGuestVoiceReply,
    planOutboundReply: outboundReplyPlanner,
    sendOutboundReplyArtifacts: outboundReplyArtifactSender,
    getDefaultChatId: proactivePushChatIdGetter,
    getDefaultTarget: proactivePushTargetGetter,
    isProactivePushEnabled,
    canSendProactivePush,
    recordRuntimeEvent,
    getActiveToolExecutions: lifecycle.getActiveToolExecutions,
    setActiveToolExecutions: lifecycle.setActiveToolExecutions,
    triggerPendingModelSwitchAbort: modelSwitchController.triggerPendingAbort,
  });
  Lifecycle.setResetTransportReplyDedup(Replies.resetTransportReplyDedup);
  const agentStartWithDedupReset = Lifecycle.createAgentStartDedupHook(
    agentLifecycleHooks.onAgentStart,
  );
  const startAgentActivityTypingLoop = (ctx: Pi.ExtensionContext): boolean => {
    if (!canSendAgentActivity(ctx)) return false;
    const turn = activeTurnRuntime.get();
    const target = turn?.target ?? proactivePushTargetGetter();
    promptDispatchRuntime.startTypingLoop(
      ctx,
      turn?.chatId ?? target?.chatId ?? proactivePushChatIdGetter(),
      { target },
    );
    return true;
  };
  const startActiveTurnTypingLoop = (ctx: Pi.ExtensionContext): void => {
    const turn = activeTurnRuntime.get();
    promptDispatchRuntime.startTypingLoop(ctx, turn?.chatId, {
      target: turn?.target,
    });
  };
  const compactionObserver = Lifecycle.createTelegramCompactionObserverRuntime({
    isContextActive: isSessionContextActive,
    setCompactionInProgress: lifecycle.setCompactionInProgress,
    updateStatus,
    startTypingLoop: startAgentActivityTypingLoop,
    stopTypingLoop: typing.stop,
    requestDeferredDispatchNextQueuedTelegramTurn:
      deferredQueueDispatchRuntime.request,
    dispatchNextQueuedTelegramTurn,
    recordRuntimeEvent,
    onCompactionAbandoned: activityRuntime.onCompactionAbandoned,
  });
  const messageActivityTypingHooks =
    Lifecycle.createTelegramMessageActivityTypingHooks({
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
      previewRuntime.invalidate();
      activityRuntime.onSessionStart?.();
      await sessionLifecycleRuntime.onSessionStart(event, ctx);
    },
    async onSessionShutdown(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      activityRuntime.onSessionShutdown();
      compactionObserver.onSessionShutdown();
      await sessionLifecycleRuntime.onSessionShutdown(event, ctx);
    },
    onSessionBeforeCompact(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      activityRuntime.onCompactionStart(Pi.getSessionCompactionReason(event));
      compactionObserver.onSessionBeforeCompact(event, ctx);
    },
    onSessionCompact(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      activityRuntime.onCompactionEnd(Pi.getSessionCompactionReason(event));
      compactionObserver.onSessionCompact(event, ctx);
    },
    async onAgentStart(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      await agentStartWithDedupReset(event, ctx);
      activityRuntime.onAgentStart(activeTurnRuntime.get()?.target);
      startAgentActivityTypingLoop(ctx);
    },
    async onToolExecutionStart(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      agentLifecycleHooks.onToolExecutionStart();
      activityRuntime.onToolStart({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
    },
    onToolExecutionUpdate(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      activityRuntime.onToolUpdate({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        update: event.partialResult,
      });
    },
    async onToolExecutionEnd(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      activityRuntime.onToolEnd({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      });
      agentLifecycleHooks.onToolExecutionEnd(event, ctx);
    },
    async onMessageStart(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      await messageActivityHooks.onMessageStart(event, ctx);
    },
    async onMessageUpdate(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      if (event.assistantMessageEvent) {
        activityRuntime.onAssistantEvent(
          event.assistantMessageEvent as Activity.TelegramAssistantStreamEvent,
        );
      }
      await messageActivityHooks.onMessageUpdate(event, ctx);
    },
    async onAgentEnd(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      activityRuntime.onAgentEnd();
      await agentLifecycleHooks.onAgentEnd(event, ctx);
    },
    onAgentSettled(_event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      activityRuntime.onAgentSettled();
    },
    onBeforeAgentStart: Prompts.createTelegramProactiveBeforeAgentStartHook({
      isConfigured: configStore.hasBotToken,
      isProactivePushEnabled,
      isCurrentOwner: lockOwnershipGuard.ownsContext,
    }),
  });
}
