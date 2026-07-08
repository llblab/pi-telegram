/**
 * Telegram bridge binding composition
 * Zones: telegram, pi agent, orchestration
 * Owns pi-facing tool, command, and lifecycle hook registration for the entrypoint
 */

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
  persistConfig: () => Promise<void>;
  setup: Setup.TelegramSetupGuard;
  activeTurnRuntime: Queue.TelegramActiveTurnStore<Queue.PendingTelegramTurn>;
  lockedPollingRuntime: Locks.TelegramLockedPollingRuntime<Pi.ExtensionContext>;
  stopPolling?: () => Promise<void | string>;
  getStatusLines: (options?: Status.TelegramBridgeStatusLineOptions) => string[];
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
  activeProfileRef?: { current: string | undefined };
}

export function registerTelegramCommandsAndTools({
  pi,
  configStore,
  persistConfig,
  setup,
  activeTurnRuntime,
  lockedPollingRuntime,
  stopPolling,
  getStatusLines,
  buttonActionStore,
  sendMarkdownReply,
  callMultipart,
  getDefaultChatId,
  getDefaultTarget,
  canSendDirect,
  recordRuntimeEvent,
  updateStatus,
  activeProfileRef,
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
  Prompts.registerTelegramHelpTool(pi);
  Commands.registerTelegramBridgeCommands(pi, {
    promptForConfig: (ctx, profileName) => {
      const previousProfileName = configStore.getActiveProfileName();
      const runSetup = Setup.createTelegramSetupPromptRuntime({
        getConfig: configStore.get,
        setConfig: configStore.set,
        setupGuard: setup,
        getMe: TelegramApi.fetchTelegramBotIdentity,
        persistConfig,
        startPolling: lockedPollingRuntime.start,
        updateStatus,
        recordRuntimeEvent,
      });
      if (!profileName) {
        configStore.activateProfile(undefined);
        return runSetup(ctx).finally(() => {
          configStore.activateProfile(previousProfileName);
        });
      }
      if (!Config.isValidTelegramProfileName(profileName)) {
        ctx.ui.notify(`Invalid Telegram profile name: ${profileName}`, "error");
        return Promise.resolve();
      }
      const storedConfig = configStore.getStoredConfig();
      if (!storedConfig.profiles?.[profileName]) {
        configStore.set({
          ...storedConfig,
          profiles: {
            ...(storedConfig.profiles ?? {}),
            [profileName]: { botToken: "" },
          },
        });
      }
      configStore.activateProfile(profileName);
      return runSetup(ctx).finally(() => {
        configStore.activateProfile(previousProfileName);
        ctx.ui.notify(`Profile "${profileName}" saved. Run /telegram-connect ${profileName} to connect.`, "info");
      });
    },
    getStatusLines,
    reloadConfig: configStore.load,
    hasBotToken: configStore.hasBotToken,
    startPolling: lockedPollingRuntime.start,
    stopPolling: stopPolling ?? lockedPollingRuntime.stop,
    updateStatus,
    getProfileNames: () => Config.getTelegramProfileNames(configStore.getStoredConfig()),
    activateProfileConfig: async (_ctx, profileName) => {
      await configStore.load();
      if (!Config.isValidTelegramProfileName(profileName)) return false;
      if (!configStore.activateProfile(profileName)) return false;
      if (activeProfileRef) activeProfileRef.current = profileName;
      return true;
    },
  });
}

interface TelegramLifecycleBindingDeps {
  pi: Pi.ExtensionAPI;
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
  answerGuestQuery: NonNullable<
    Queue.TelegramAgentEndHookRuntimeDeps<
      Queue.PendingTelegramTurn,
      Pi.ExtensionContext,
      Pi.AgentEndEvent["messages"][number],
      Keyboard.TelegramInlineKeyboardMarkup
    >["answerGuestQuery"]
  >;
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
  updateStatus: TelegramBridgeStatusUpdater;
  recordRuntimeEvent: TelegramRuntimeEventRecorder;
}

export function registerTelegramLifecycleRuntimeHooks({
  pi,
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
  sendGuestReply,
  finalizeMarkdownPreview,
  proactivePushChatIdGetter,
  proactivePushTargetGetter,
  isProactivePushEnabled,
  canSendProactivePush,
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
  const outboundReplyPlanner =
    OutboundHandlers.createTelegramOutboundReplyPlanner(buttonActionStore);
  const outboundReplyArtifactSender =
    OutboundHandlers.createTelegramOutboundReplyArtifactSender({
      execCommand: CommandTemplates.execCommandTemplate,
      sendMultipart: callMultipart,
      sendTextReply,
      sendChatAction,
      sendRecordVoiceAction,
      getHandlers: configStore.getOutboundHandlers,
      recordRuntimeEvent,
    });
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
  const startActiveTurnTypingLoop = (ctx: Pi.ExtensionContext): void => {
    const turn = activeTurnRuntime.get();
    promptDispatchRuntime.startTypingLoop(ctx, turn?.chatId, {
      target: turn?.target,
    });
  };
  const compactionObserver = Lifecycle.createTelegramCompactionObserverRuntime({
    setCompactionInProgress: lifecycle.setCompactionInProgress,
    updateStatus,
    startTypingLoop: startActiveTurnTypingLoop,
    stopTypingLoop: typing.stop,
    shouldStartTypingLoop: activeTurnRuntime.has,
    requestDeferredDispatchNextQueuedTelegramTurn:
      deferredQueueDispatchRuntime.request,
    dispatchNextQueuedTelegramTurn,
    recordRuntimeEvent,
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
    ...sessionLifecycleRuntime,
    ...agentLifecycleHooks,
    async onSessionShutdown(event, ctx) {
      compactionObserver.onSessionShutdown();
      await sessionLifecycleRuntime.onSessionShutdown(event, ctx);
    },
    onSessionBeforeCompact: compactionObserver.onSessionBeforeCompact,
    onSessionCompact: compactionObserver.onSessionCompact,
    onAgentStart: agentStartWithDedupReset,
    async onToolExecutionStart(_event, _ctx) {
      agentLifecycleHooks.onToolExecutionStart();
    },
    onToolExecutionUpdate() {},
    async onToolExecutionEnd(_event, ctx) {
      agentLifecycleHooks.onToolExecutionEnd(_event, ctx);
    },
    onAgentEnd: agentLifecycleHooks.onAgentEnd,
    onBeforeAgentStart: Prompts.createTelegramProactiveBeforeAgentStartHook({
      isConfigured: configStore.hasBotToken,
      isProactivePushEnabled,
      isCurrentOwner: lockOwnershipGuard.ownsContext,
    }),
    ...messageActivityHooks,
  });
}
