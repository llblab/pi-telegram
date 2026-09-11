/**
 * Telegram bridge binding composition
 * Zones: telegram, pi agent, orchestration
 * Owns pi-facing tool, command, and lifecycle hook registration for the entrypoint
 */

import * as Activity from "./activity.ts";
import * as ActivityVerbosity from "./activity-verbosity.ts";
import * as ChannelPosts from "./channel-posts.ts";
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
import * as Routing from "./routing.ts";
import * as Runtime from "./runtime.ts";
import * as Setup from "./setup.ts";
import * as Status from "./status.ts";
import * as TelegramApi from "./telegram-api.ts";
import type { TelegramTarget } from "./target.ts";
import * as GenerativeApps from "./generative-apps.ts";

type ActivePiModel = NonNullable<Pi.ExtensionContext["model"]>;

type TelegramRuntimeEventRecorder = (
  category: string,
  error: unknown,
  details?: Record<string, unknown>,
) => void;

type TelegramBridgeStatusUpdater =
  Status.TelegramStatusRuntime<Pi.ExtensionContext>["updateStatus"];

type TelegramAgentTargetResolver = NonNullable<
  OutboundAttachments.TelegramOutboundMessageToolRegistrationDeps["resolveAgentTarget"]
>;
type TelegramAgentMessageRouter = NonNullable<
  OutboundAttachments.TelegramOutboundMessageToolRegistrationDeps["routeAgentMessage"]
>;

export interface TelegramQueueBindingRuntime<TContext> {
  mutation: Queue.TelegramQueueMutationController<TContext>;
  dispatchNext: (ctx: TContext) => void;
  watchdog: Queue.TelegramQueueDispatchWatchdogRuntime<TContext>;
}

export function createTelegramQueueBindingRuntime<TContext>(deps: {
  store: Queue.TelegramQueueStateStore<TContext>;
  queue: Pick<Runtime.TelegramBridgeRuntime["queue"], "allocateItemOrder">;
  lifecycle: Pick<
    Runtime.TelegramBridgeRuntime["lifecycle"],
    "isCompactionInProgress" | "hasDispatchPending"
  >;
  activeTurn: Pick<Queue.TelegramActiveTurnStore, "has">;
  admission: {
    getSettlement: () =>
      | {
          onItemsDiscarded: (
            items: readonly Queue.TelegramQueueItem<TContext>[],
            ctx: TContext,
          ) => void;
          isItemReady: (item: Queue.TelegramQueueItem<TContext>) => boolean;
          onPromptHandedOff?: (
            item: Queue.PendingTelegramTurn,
            ctx: TContext,
          ) => void;
          onControlSettled: (
            item: Queue.PendingTelegramControlItem<TContext>,
            ctx: TContext,
          ) => void;
        }
      | undefined;
    hasPendingQueueMutationForItem: (
      item: Queue.TelegramQueueItem<TContext>,
    ) => boolean;
  };
  transportStamp: Pick<Queue.TelegramTransportStampRuntime, "isActive">;
  deferredDispatch: Pick<
    Queue.TelegramDeferredQueueDispatchRuntime<TContext>,
    "isBound" | "getGeneration" | "isGenerationActive"
  >;
  promptDispatch: Runtime.TelegramPromptDispatchRuntime<TContext>;
  isIdle: (ctx: TContext) => boolean;
  hasPendingMessages: (ctx: TContext) => boolean;
  updateStatus: (ctx: TContext, error?: string) => void;
  sendTextReply: Queue.TelegramQueueDispatchRuntimeDeps<TContext>["sendTextReply"];
  sendUserMessage: Queue.TelegramQueueDispatchRuntimeDeps<TContext>["sendUserMessage"];
  recordRuntimeEvent?: TelegramRuntimeEventRecorder;
}): TelegramQueueBindingRuntime<TContext> {
  const settleDiscardedItems = (
    items: readonly Queue.TelegramQueueItem<TContext>[],
    ctx: TContext,
  ): boolean => {
    const durableItems = items.filter(
      (item) => (item.admissionReceipts?.length ?? 0) > 0,
    );
    if (durableItems.length === 0) return true;
    const settlement = deps.admission.getSettlement();
    if (!settlement) return false;
    settlement.onItemsDiscarded(durableItems, ctx);
    return durableItems.every((item) => !settlement.isItemReady(item));
  };
  const mutation = Queue.createTelegramQueueMutationController({
    ...deps.store,
    allocateLaneOrder: deps.queue.allocateItemOrder,
    onItemsDiscarded(items, ctx) {
      if (!settleDiscardedItems(items, ctx)) {
        throw new Error(
          "Telegram queue items could not be discarded durably.",
        );
      }
    },
    updateStatus: deps.updateStatus,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  const dispatchNext = Queue.createTelegramQueueDispatchRuntime({
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
      return (
        deps.admission.getSettlement()?.isItemReady(item) ??
        (item.admissionReceipts?.length ?? 0) === 0
      );
    },
    commitPromptDispatch(item, ctx) {
      if ((item.admissionReceipts?.length ?? 0) === 0) return true;
      const settlement = deps.admission.getSettlement();
      if (!settlement?.onPromptHandedOff) return false;
      settlement.onPromptHandedOff(item, ctx);
      return !settlement.isItemReady(item);
    },
    onControlSettled(item, ctx) {
      deps.admission.getSettlement()?.onControlSettled(item, ctx);
    },
    onPromptSkipped(item, ctx) {
      return settleDiscardedItems([item], ctx);
    },
    updateStatus: deps.updateStatus,
    sendTextReply: deps.sendTextReply,
    recordRuntimeEvent: deps.recordRuntimeEvent,
    ...deps.promptDispatch,
    sendUserMessage: deps.sendUserMessage,
  }).dispatchNext;
  return {
    mutation,
    dispatchNext,
    watchdog: Queue.createTelegramQueueDispatchWatchdogRuntime({
      hasQueuedItems: deps.store.hasQueuedItems,
      dispatchNextQueuedTelegramTurn: dispatchNext,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    }),
  };
}

export function createTelegramGenerativeAppBoundButtonActionInvoker<
  TQuery extends {
    message?: { chat?: { id?: number }; message_id?: number };
  },
>(deps: {
  agentDir: string;
  assertExecutionCurrent: (query: TQuery) => void;
  getExecutionFence: (query: TQuery) => GenerativeApps.GenerativeAppExecutionFence | undefined;
  planOutput: ReturnType<typeof OutboundHandlers.createTelegramOutboundReplyPlanner>;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number,
    markdown: string,
    options?: { replyMarkup?: OutboundHandlers.TelegramOutboundButtonMarkup },
  ) => Promise<unknown>;
  editInteractiveMessage?: (
    chatId: number,
    messageId: number,
    markdown: string,
    mode: "markdown",
    replyMarkup: OutboundHandlers.TelegramOutboundButtonMarkup,
  ) => Promise<void>;
  recordRuntimeEvent: TelegramRuntimeEventRecorder;
}): (
  action: OutboundHandlers.TelegramOutboundButtonAction,
  query: TQuery,
) => Promise<false | "new" | "edit"> {
  return async (action, query) => {
    let boundAction: GenerativeApps.GenerativeAppBoundAction | undefined;
    try {
      boundAction = GenerativeApps.parseGenerativeAppBoundAction(action.prompt);
      if (!boundAction) return false;
      deps.assertExecutionCurrent(query);
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
      const chatId = query.message?.chat?.id;
      const messageId = query.message?.message_id;
      if (typeof chatId !== "number" || typeof messageId !== "number") {
        throw new Error("Generative App callback target is unavailable.");
      }
      const reply = deps.planOutput(result.output, {
        binding: {
          generation: result.generation,
          app: result.app,
          revision: result.revision,
        },
      });
      if (result.viewMode === "edit" && deps.editInteractiveMessage) {
        let editFailed = false;
        try {
          await deps.editInteractiveMessage(
            chatId,
            messageId,
            reply.markdown,
            "markdown",
            reply.replyMarkup ?? { inline_keyboard: [] },
          );
        } catch (error) {
          editFailed = true;
          deps.recordRuntimeEvent("generative-app", error, {
            phase: "bound-action-edit-fallback",
            app: boundAction.app,
            method: boundAction.method,
          });
        }
        deps.assertExecutionCurrent(query);
        if (!editFailed) return "edit";
      }
      deps.assertExecutionCurrent(query);
      await deps.sendMarkdownReply(chatId, messageId, reply.markdown, {
        replyMarkup: reply.replyMarkup,
      });
      deps.assertExecutionCurrent(query);
      return "new";
    } catch (error) {
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

export interface TelegramAgentMessageToolRoutingRuntime {
  resolveAgentTarget: TelegramAgentTargetResolver;
  routeAgentMessage: TelegramAgentMessageRouter;
  canSendDirect: () => boolean;
}

export function createTelegramAgentMessageToolRoutingRuntime(deps: {
  ownsLeader: () => boolean;
  ownsDirectDelivery: () => boolean;
  isFollowerRegistered: () => boolean;
  getSourceTarget: () => TelegramTarget | undefined;
  getSourceThreadName: () => string | undefined;
  local: {
    resolveTarget: (
      selector: Parameters<TelegramAgentTargetResolver>[0],
      sourceTarget?: TelegramTarget,
    ) => Awaited<ReturnType<TelegramAgentTargetResolver>> | undefined;
    route: (input: {
      sourceTarget?: TelegramTarget;
      sourceThreadName?: string;
      message: Parameters<TelegramAgentMessageRouter>[0];
    }) => Promise<void>;
  };
  follower: {
    resolveTarget: TelegramAgentTargetResolver;
    routeMessage: TelegramAgentMessageRouter;
  };
}): TelegramAgentMessageToolRoutingRuntime {
  return {
    async resolveAgentTarget(selector) {
      if (!deps.ownsLeader()) return deps.follower.resolveTarget(selector);
      const target = deps.local.resolveTarget(selector, deps.getSourceTarget());
      if (!target) {
        throw new Error(
          "Telegram agent target is unavailable, ambiguous, or not live.",
        );
      }
      return target;
    },
    async routeAgentMessage(message) {
      if (!deps.ownsLeader()) return deps.follower.routeMessage(message);
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

export interface TelegramAssistantOutputBindingRuntime<TTransportStamp> {
  runtime: Activity.TelegramAssistantOutputRuntime;
  observeEvent: (event: Activity.TelegramActivityEvent) => void;
  authority: Routing.TelegramAssistantOutputAuthorityRuntime<TTransportStamp>;
}

export function createTelegramAssistantOutputBindingRuntime<
  TTransportStamp,
>(deps: {
  authority: {
    getPreferredTarget: () =>
      | OutboundAttachments.TelegramQueuedOutboundAttachmentTurnView["target"]
      | undefined;
    getFallbackChatId: () => number | undefined;
    getTransportStamp: () => TTransportStamp;
    isTransportStampActive: (stamp: TTransportStamp) => boolean;
    ownsDirect: () => boolean;
    getDirectEpoch: () => number | string | undefined;
    isFollowerRegistered: () => boolean;
    getFollowerGeneration: () => string | undefined;
  };
  sender: Parameters<
    typeof OutboundHandlers.createTelegramAssistantOutputSender<TTransportStamp>
  >[0];
  waitForActivityIdle?: () => Promise<void>;
  prepareTelegramPreview?: () => Activity.TelegramAssistantOutputPreparation | undefined;
  enqueue?: Activity.TelegramActivityPublicationRuntime["enqueue"];
  recordRuntimeEvent: TelegramRuntimeEventRecorder;
}): TelegramAssistantOutputBindingRuntime<TTransportStamp> {
  const authority = Routing.createTelegramAssistantOutputAuthorityRuntime(
    deps.authority,
  );
  const sendOutput =
    OutboundHandlers.createTelegramAssistantOutputSender<TTransportStamp>(
      deps.sender,
    );
  const runtime = Activity.createTelegramAssistantOutputRuntime({
    ...authority,
    enqueue: deps.enqueue,
    prepareSend: (event) => event.source === "telegram" ? deps.prepareTelegramPreview?.() : undefined,
    async send(event, authority, isAuthorityActive) {
      await deps.waitForActivityIdle?.();
      if (!isAuthorityActive()) return;
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
      if (event.type === "assistant-segment") runtime.accept(event);
    },
  };
}

type TelegramAssistantOutputAuthority<TTransportStamp> = ReturnType<
  Routing.TelegramAssistantOutputAuthorityRuntime<TTransportStamp>["captureAuthority"]
>;

export interface TelegramBridgePublicationRuntime {
  enqueue: Activity.TelegramActivityPublicationRuntime["enqueue"];
  reserve: Activity.TelegramActivityPublicationRuntime["reserve"];
  capture: () => { target?: Queue.TelegramQueueTarget; isCurrent: () => boolean };
}

export interface TelegramActivityBindingRuntime {
  publicationRuntime: TelegramBridgePublicationRuntime;
  activityRuntime: Activity.TelegramActivityRuntime;
  activityVerbosityRuntime: ActivityVerbosity.TelegramActivityVerbosityRuntime;
  assistantOutputRuntime: Activity.TelegramAssistantOutputRuntime;
}

/** Compose public activity fanout, verbosity, and assistant output ordering. */
export function createTelegramActivityBindingRuntime<TTransportStamp>(deps: {
  generation: string;
  assistantOutput: Omit<
    Parameters<
      typeof createTelegramAssistantOutputBindingRuntime<TTransportStamp>
    >[0],
    "waitForActivityIdle" | "enqueue"
  >;
  activityVerbosity: Omit<
    Parameters<
      typeof ActivityVerbosity.createTelegramActivityVerbosityRuntime<
        TelegramAssistantOutputAuthority<TTransportStamp>
      >
    >[0],
    "captureAuthority" | "isAuthorityActive" | "recordFailure" | "enqueue"
  >;
}): TelegramActivityBindingRuntime {
  const publication = Activity.createTelegramActivityPublicationRuntime();
  const assistantOutputBinding =
    createTelegramAssistantOutputBindingRuntime({
      ...deps.assistantOutput,
      enqueue: publication.enqueue,
    });
  const activityVerbosityRuntime =
    ActivityVerbosity.createTelegramActivityVerbosityRuntime({
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

interface TelegramCommandsAndToolsBindingDeps {
  pi: Pi.ExtensionAPI;
  agentDir: string;
  configStore: Config.TelegramConfigStore;
  persistConfig: (config?: Config.TelegramConfig) => Promise<void>;
  setup: Setup.TelegramSetupGuard;
  activeTurnRuntime: Queue.TelegramActiveTurnStore<Queue.PendingTelegramTurn>;
  lockedPollingRuntime: Locks.TelegramLockedPollingRuntime<Pi.ExtensionContext>;
  stopPolling?: () => Promise<void | string>;
  recoverPollingStart?: Commands.TelegramBridgeCommandRegistrationDeps["recoverPollingStart"];
  getDisconnectThreadName?: () => string | undefined;
  setRequestedThreadNameForPollingStart?: (
    threadName: string | undefined,
  ) => void;
  validateThreadName?: Commands.TelegramBridgeCommandRegistrationDeps["validateThreadName"];
  onTransportChanged?: () => Promise<void> | void;
  getStatusLines: (
    options?: Status.TelegramBridgeStatusLineOptions,
  ) => string[];
  buttonActionStore: OutboundHandlers.TelegramButtonActionStore;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number | undefined,
    markdown: string,
    options?: {
      replyMarkup?: unknown;
      target?: { chatId: number; threadId?: number };
    },
  ) => Promise<number | undefined>;
  sendChannelMarkdownMessage: NonNullable<
    OutboundAttachments.TelegramOutboundMessageToolRegistrationDeps["sendChannelMarkdownMessage"]
  >;
  sendChannelMediaMessage: NonNullable<
    OutboundAttachments.TelegramOutboundMessageToolRegistrationDeps["sendChannelMediaMessage"]
  >;
  listChannelPosts: ChannelPosts.TelegramChannelPostJournalStore["list"];
  mutateChannelPost(input: { action: "edit" | "delete"; operationId: string;
    mutationId: string; markdown?: string }): Promise<ChannelPosts.TelegramChannelPostRecord>;
  callMultipart: OutboundHandlers.TelegramVoiceReplySenderDeps["sendMultipart"];
  getDefaultChatId: () => number | undefined;
  getDefaultTarget?: () => OutboundAttachments.TelegramQueuedOutboundAttachmentTurnView["target"];
  resolveAgentTarget?: OutboundAttachments.TelegramOutboundMessageToolRegistrationDeps["resolveAgentTarget"];
  routeAgentMessage?: OutboundAttachments.TelegramOutboundMessageToolRegistrationDeps["routeAgentMessage"];
  canSendDirect: () => boolean;
  updateStatus: TelegramBridgeStatusUpdater;
  recordRuntimeEvent: TelegramRuntimeEventRecorder;
}

export function registerTelegramCommandsAndTools({
  pi,
  agentDir,
  configStore,
  persistConfig,
  setup,
  activeTurnRuntime,
  lockedPollingRuntime,
  stopPolling,
  recoverPollingStart,
  getDisconnectThreadName,
  setRequestedThreadNameForPollingStart,
  validateThreadName,
  onTransportChanged,
  getStatusLines,
  buttonActionStore,
  sendMarkdownReply,
  sendChannelMarkdownMessage,
  sendChannelMediaMessage,
  listChannelPosts,
  mutateChannelPost,
  callMultipart,
  getDefaultChatId,
  getDefaultTarget,
  resolveAgentTarget,
  routeAgentMessage,
  canSendDirect,
  recordRuntimeEvent,
  updateStatus,
}: TelegramCommandsAndToolsBindingDeps): void {
  GenerativeApps.registerTelegramBindTool(pi, {
    agentDir,
    getActiveTurn: activeTurnRuntime.get,
    planOutput: OutboundHandlers.createTelegramOutboundReplyPlanner(
      buttonActionStore,
      Config.createTelegramConfigControls(configStore).getAssistantRenderingMode,
    ),
    sendMarkdownReply,
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
    planMessage:
      OutboundHandlers.createTelegramOutboundReplyPlanner(
        buttonActionStore,
        Config.createTelegramConfigControls(configStore).getAssistantRenderingMode,
      ),
    sendMarkdownMessage: (chatId, markdown, options) =>
      sendMarkdownReply(chatId, undefined, markdown, options),
    sendChannelMarkdownMessage,
    sendChannelMediaMessage,
    recordRuntimeEvent,
  });
  const queueAgentConnectionContext = (connected: boolean): void => {
    pi.sendMessage(
      {
        customType: "telegram-connection-state",
        content: connected
          ? Prompts.TELEGRAM_CONNECTED_CONTEXT_MESSAGE
          : Prompts.TELEGRAM_DISCONNECTED_CONTEXT_MESSAGE,
        display: false,
      },
      { deliverAs: "nextTurn" },
    );
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
            const latestProfile = configStore.getStoredConfig().profiles?.[profileName];
            configStore.setProfile(profileName, {
              ...profile,
              threadDisplayMode: latestProfile?.threadDisplayMode,
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
        resolveBotToken: (value) =>
          Config.resolveTelegramBotToken(value, process.env),
        describeBotToken: (value) =>
          Config.getTelegramBotTokenDiagnostic(value, process.env),
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
      setRequestedThreadNameForPollingStart?.(options?.requestedThreadName);
      try {
        return await lockedPollingRuntime.start(ctx, options);
      } catch (error) {
        recordRuntimeEvent("recovery", error, { phase: "polling-start" });
        throw error;
      } finally {
        setRequestedThreadNameForPollingStart?.(undefined);
      }
    },
    stopPolling: stopPolling ?? lockedPollingRuntime.stop,
    recoverPollingStart,
    getDisconnectThreadName,
    validateThreadName,
    queueAgentConnectionContext,
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
  publicationRuntime: TelegramBridgePublicationRuntime;
  activityRuntime: Activity.TelegramActivityRuntime;
  activityVerbosityRuntime?: ActivityVerbosity.TelegramActivityVerbosityRuntime;
  assistantOutputRuntime: Pick<
    Activity.TelegramAssistantOutputRuntime,
    "start" | "waitForIdle" | "stop"
  >;
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
  modelContextAvailabilityRuntime: Prompts.TelegramModelContextAvailabilityRuntime;
  disconnectOnQuit?: () => Promise<unknown>;
  resolveAutomaticThreadCleanupEnabled?: () => boolean | Promise<boolean>;
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
  onPromptHandedOff?: (
    turn: Queue.PendingTelegramTurn,
    ctx: Pi.ExtensionContext,
  ) => void;
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
  editGuestReply?: Queue.TelegramAgentEndHookRuntimeDeps<
    Queue.PendingTelegramTurn,
    Pi.ExtensionContext,
    Pi.AgentEndEvent["messages"][number],
    Keyboard.TelegramInlineKeyboardMarkup
  >["editGuestReply"];
  stopGuestPlaceholder?: Queue.TelegramAgentEndHookRuntimeDeps<
    Queue.PendingTelegramTurn,
    Pi.ExtensionContext,
    Pi.AgentEndEvent["messages"][number],
    Keyboard.TelegramInlineKeyboardMarkup
  >["stopGuestPlaceholder"];
  preparePreviewDelivery?: Queue.TelegramAgentEndRuntimeDeps<Queue.PendingTelegramTurn>["preparePreviewDelivery"];
  finalizeMarkdownPreview: Queue.TelegramAgentEndHookRuntimeDeps<
    Queue.PendingTelegramTurn,
    Pi.ExtensionContext,
    Pi.AgentEndEvent["messages"][number],
    Keyboard.TelegramInlineKeyboardMarkup
  >["finalizeMarkdownPreview"];
  proactivePushTargetGetter: () => Queue.TelegramQueueTarget | undefined;
  getAssistantRenderingMode: () => "rich" | "html";
  recordMessageOwnership?: (input: {
    chatId: number;
    messageId: number;
    target?: Queue.TelegramQueueTarget;
  }) => void;
  canSendAgentActivity: (ctx: Pi.ExtensionContext) => boolean;
  isSessionContextActive: (ctx: Pi.ExtensionContext) => boolean;
  isTurnTransportActive?: (turn: Queue.PendingTelegramTurn) => boolean;
  updateStatus: TelegramBridgeStatusUpdater;
  recordRuntimeEvent: TelegramRuntimeEventRecorder;
}

export function registerTelegramLifecycleRuntimeHooks({
  pi,
  publicationRuntime,
  activityRuntime,
  activityVerbosityRuntime,
  assistantOutputRuntime,
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
  modelContextAvailabilityRuntime,
  disconnectOnQuit,
  resolveAutomaticThreadCleanupEnabled,
  buttonActionStore,
  callMultipart,
  sendChatAction,
  sendRecordVoiceAction,
  sendMarkdownReply,
  sendTextReply,
  dispatchNextQueuedTelegramTurn,
  onPromptHandedOff,
  answerGuestQuery,
  deleteMessage,
  sendGuestReply,
  editGuestReply,
  stopGuestPlaceholder,
  preparePreviewDelivery,
  finalizeMarkdownPreview,
  proactivePushTargetGetter,
  getAssistantRenderingMode,
  recordMessageOwnership,
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
  const richAttachmentSender =
    OutboundAttachments.createTelegramRichOutboundAttachmentSender({
      sendMultipart: callMultipart,
      getRenderingMode: getAssistantRenderingMode,
      recordOwnership: recordMessageOwnership,
      recordRuntimeEvent,
    });
  const sendGuestAttachment = async (
    turn: Queue.PendingTelegramTurn,
    attachment: Queue.QueuedAttachment,
    caption?: string,
  ): Promise<void> => {
    const stagingTarget = proactivePushTargetGetter();
    const stagingChatId = stagingTarget?.chatId;
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
    OutboundHandlers.createTelegramOutboundReplyPlanner(
      buttonActionStore,
      getAssistantRenderingMode,
    );
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
    const stagingChatId = stagingTarget?.chatId;
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
  let pendingFinalPublication: {
    turn: Queue.PendingTelegramTurn;
    reservation: Activity.TelegramActivityPublicationReservation;
  } | undefined;
  const cancelPendingFinalPublication = (): void => {
    pendingFinalPublication?.reservation.cancel();
    pendingFinalPublication = undefined;
  };
  const recordPublicationFailure = (error: unknown): void => {
    recordRuntimeEvent("delivery", error, { phase: "agent-end-background-delivery" });
  };
  const scheduleActiveTurnDelivery = (task: () => Promise<void>): void => {
    void publicationRuntime.enqueue(task).catch(recordPublicationFailure);
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
    onPromptHandedOff,
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
    getFoldQueuedPromptsIntoHistory:
      lifecycle.shouldFoldQueuedPromptsIntoHistory,
    resetRuntimeState: agentEndResetter,
    isSessionActive: isSessionContextActive,
    isTurnTransportActive,
    waitForTypingIdle: typing.waitForIdle,
    dispatchNextQueuedTelegramTurn,
    requestDeferredDispatchNextQueuedTelegramTurn:
      deferredQueueDispatchRuntime.request,
    scheduleActiveTurnDelivery,
    reserveActiveTurnDelivery() {
      const pending = pendingFinalPublication;
      pendingFinalPublication = undefined;
      const matches = pending?.turn === activeTurnRuntime.get();
      if (!matches) pending?.reservation.cancel();
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
  const agentStartWithDedupReset = Lifecycle.createAgentStartDedupHook(
    agentLifecycleHooks.onAgentStart,
    scheduleActiveTurnDelivery,
  );
  let uiPromptActive = false;
  const startAgentActivityTypingLoop = (ctx: Pi.ExtensionContext): boolean => {
    if (uiPromptActive || !canSendAgentActivity(ctx)) return false;
    const turn = activeTurnRuntime.get();
    const target = turn?.target ?? proactivePushTargetGetter();
    promptDispatchRuntime.startTypingLoop(ctx, turn?.chatId ?? target?.chatId, {
      target,
    });
    return true;
  };
  const startActiveTurnTypingLoop = (ctx: Pi.ExtensionContext): void => {
    if (uiPromptActive) return;
    const turn = activeTurnRuntime.get();
    promptDispatchRuntime.startTypingLoop(ctx, turn?.chatId, {
      target: turn?.target,
    });
  };
  let observedAutomaticCompaction = false;
  let agentWorkActive = false;
  const prepareCompactionNotice = (text: string, ctx: Pi.ExtensionContext): (() => Promise<void>) => {
    const authority = publicationRuntime.capture();
    const turn = activeTurnRuntime.get();
    const selectedTarget = turn?.target ?? authority.target;
    const target = selectedTarget ? { ...selectedTarget } : undefined;
    const replyToMessageId = turn?.replyToMessageId;
    return async () => {
      if (!target || !isSessionContextActive(ctx) || !authority.isCurrent()) return;
      if (turn && isTurnTransportActive?.(turn) === false) return;
      try {
        await sendMarkdownReply(target.chatId, replyToMessageId, text, { target });
      } catch (error) {
        recordRuntimeEvent("delivery", error, { phase: "compaction-notice" });
      }
    };
  };
  const sendCompactionNotice = (text: string, ctx: Pi.ExtensionContext): void => {
    scheduleActiveTurnDelivery(prepareCompactionNotice(text, ctx));
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
    onCompactionAbandoned: () => {
      observedAutomaticCompaction = false;
      activityRuntime.onCompactionAbandoned();
    },
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
      cancelPendingFinalPublication();
      previewRuntime.invalidate();
      assistantOutputRuntime.start();
      activityRuntime.onSessionStart?.();
      activityVerbosityRuntime?.reset();
      modelContextAvailabilityRuntime.reconcile();
      await sessionLifecycleRuntime.onSessionStart(event, ctx);
    },
    async onSessionShutdown(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
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
          const automaticCleanupEnabled =
            (await resolveAutomaticThreadCleanupEnabled?.()) ?? true;
          if (automaticCleanupEnabled) await disconnectOnQuit();
        } catch (error) {
          recordRuntimeEvent("session", error, {
            phase: "automatic-disconnect-on-quit",
          });
        }
      }
      await sessionLifecycleRuntime.onSessionShutdown(event, ctx);
    },
    async onSessionBeforeCompact(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      const shouldNotify = !(lifecycle.isCompactionInProgress?.() ?? false);
      if (shouldNotify) observedAutomaticCompaction = true;
      activityRuntime.onCompactionStart(Pi.getSessionCompactionReason(event));
      compactionObserver.onSessionBeforeCompact(event, ctx);
      if (shouldNotify) sendCompactionNotice(Commands.TELEGRAM_COMPACTION_STARTED_MARKDOWN, ctx);
    },
    async onSessionCompact(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      activityRuntime.onCompactionEnd(Pi.getSessionCompactionReason(event));
      compactionObserver.onSessionCompact(event, ctx);
      if (observedAutomaticCompaction) {
        observedAutomaticCompaction = false;
        sendCompactionNotice(Commands.TELEGRAM_COMPACTION_COMPLETED_MARKDOWN, ctx);
      }
    },
    async onSessionCompactFailed(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      const shouldNotify = observedAutomaticCompaction;
      compactionObserver.onSessionCompactFailed(event, ctx);
      if (!shouldNotify) return;
      const notice = event.aborted
        ? "**⚠️ Compaction cancelled.**"
        : "**⚠️ Compaction failed.**";
      sendCompactionNotice(notice, ctx);
    },
    async onAgentStart(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      agentWorkActive = true;
      cancelPendingFinalPublication();
      await agentStartWithDedupReset(event, ctx);
      const turn = activeTurnRuntime.get();
      activityRuntime.onAgentStart(turn?.target, turn?.replyToMessageId);
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
    onMessageEnd(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      if (event.message.role === "assistant") {
        previewRuntime.seal();
        activityRuntime.onAssistantMessageEnd(event.message.stopReason);
      }
      if (event.message.role !== "assistant" || event.message.stopReason === "toolUse" || event.message.stopReason === "aborted") return;
      const turn = activeTurnRuntime.get();
      if (!turn || turn.guestQueryId || pendingFinalPublication?.turn === turn) return;
      cancelPendingFinalPublication();
      const assistant = Replies.extractLatestAssistantMessageText([event.message]);
      if (!assistant.text && assistant.stopReason !== "error" && turn.queuedAttachments.length === 0) return;
      pendingFinalPublication = { turn, reservation: publicationRuntime.reserve() };
    },
    onUiPromptStart(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      uiPromptActive = true;
      typing.stop();
      activityRuntime.onUiPromptStart(event.kind, event.title);
      updateStatus(ctx);
    },
    onUiPromptEnd(_event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      uiPromptActive = false;
      activityRuntime.onUiPromptEnd();
      if (agentWorkActive || lifecycle.isCompactionInProgress()) {
        startAgentActivityTypingLoop(ctx);
      }
      updateStatus(ctx);
    },
    async onAgentEnd(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      if (pendingFinalPublication && pendingFinalPublication.turn !== activeTurnRuntime.get()) {
        cancelPendingFinalPublication();
        return;
      }
      activityRuntime.onAgentEnd();
      await agentLifecycleHooks.onAgentEnd(event, ctx);
    },
    async onAgentSettled(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      const pending = pendingFinalPublication;
      try {
        await agentLifecycleHooks.onAgentSettled(event, ctx);
      } finally {
        if (pendingFinalPublication === pending) cancelPendingFinalPublication();
      }
      if (!isSessionContextActive(ctx)) return;
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
