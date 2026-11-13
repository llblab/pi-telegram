/**
 * Telegram bridge binding composition
 * Zones: telegram, pi agent, orchestration
 * Owns pi-facing tool, command, and lifecycle hook registration for the entrypoint
 */

import * as ActivityVerbosity from "./activity-verbosity.ts";
import * as Activity from "./activity.ts";
import * as BusApi from "./bus-api.ts";
import type { TelegramBusFollowerCommandOwner } from "./bus-follower.ts";
import type { TelegramBusLiveRebindWorkState } from "./bus.ts";
import * as ChannelPosts from "./channel-posts.ts";
import * as CommandTemplates from "./command-templates.ts";
import * as Commands from "./commands.ts";
import * as Config from "./config.ts";
import * as Delivery from "./delivery.ts";
import * as GenerativeApps from "./generative-apps.ts";
import * as Keyboard from "./keyboard.ts";
import * as Lifecycle from "./lifecycle.ts";
import * as Locks from "./locks.ts";
import * as Menu from "./menu.ts";
import * as Model from "./model.ts";
import * as OutboundAttachments from "./outbound-attachments.ts";
import * as OutboundHandlers from "./outbound.ts";
import { captureTelegramOrdinaryCallbackDispatch, hasTelegramOrdinaryCallbackOrigin } from "./outbound-buttons.ts";
import * as Pi from "./pi.ts";
import * as Preview from "./preview.ts";
import * as Prompts from "./prompts.ts";
import * as Queue from "./queue.ts";
import * as Replies from "./replies.ts";
import * as Routing from "./routing.ts";
import * as Runtime from "./runtime.ts";
import * as Setup from "./setup.ts";
import * as Status from "./status.ts";
import type { TelegramTarget } from "./target.ts";
import * as TelegramApi from "./telegram-api.ts";

/** Compose any registered held command over captured recipient effects; no ordinary follower API fallback. */
export function createTelegramFollowerSelectedCommandBinding<
  TContext,
  TModel extends Model.MenuModel = Model.MenuModel,
>(deps: {
  ctx: TContext;
  operationId: string;
  registrationGeneration: string;
  name: string;
  target: TelegramTarget & { threadId: number };
  recipient: Pick<
    TelegramBusFollowerCommandOwner<TContext>,
    "isCurrent" | "assertRecipientCurrent"
  >;
  command: Pick<
    ReturnType<
      typeof Commands.createTelegramCommandHandlerTargetRuntime<
        Commands.TelegramCommandRuntimeMessage,
        TContext
      >
    >,
    "prepareHeldCommand" | "canPrepareHeldCommand"
  >;
  menu?: Omit<
    Menu.TelegramMenuActionRuntimeDeps<TContext, TModel>,
    "sendTextReply" | "sendInteractiveMessage" | "editInteractiveMessage"
  >;
  deliver: Parameters<
    typeof BusApi.createTelegramSelectedMenuTextApi
  >[0]["deliver"];
  recordOwnership: NonNullable<
    Replies.TelegramRenderedMessageDeliveryRuntimeDeps<Menu.TelegramReplyMarkup>["recordOwnership"]
  >;
}): TelegramBusFollowerCommandOwner<TContext> | undefined {
  const {
      ctx,
      operationId,
      registrationGeneration,
      name,
      recipient,
      command,
      deliver,
      recordOwnership,
    } = deps,
    target = { ...deps.target };
  const prepare = command.prepareHeldCommand,
    canPrepare = command.canPrepareHeldCommand;
  const isCurrent = recipient.isCurrent,
    assertRecipientCurrent = recipient.assertRecipientCurrent,
    menu = deps.menu,
    menuPorts = menu && { ...menu };
  if (
    [
      prepare,
      canPrepare,
      isCurrent,
      assertRecipientCurrent,
      deliver,
      recordOwnership,
    ].some((port) => typeof port !== "function") ||
    (menuPorts &&
      [
        menuPorts.getModelMenuState,
        menuPorts.storeModelMenuState,
        menuPorts.getActiveModel,
        menuPorts.getThinkingLevel,
        menuPorts.buildStatusHtml,
        menuPorts.isIdle,
        menuPorts.canOfferInFlightModelSwitch,
      ].some((port) => typeof port !== "function"))
  )
    return undefined;
  const portsCurrent = () =>
    deps.ctx === ctx &&
    deps.operationId === operationId &&
    deps.registrationGeneration === registrationGeneration &&
    deps.name === name &&
    deps.recipient === recipient &&
    recipient.isCurrent === isCurrent &&
    recipient.assertRecipientCurrent === assertRecipientCurrent &&
    deps.command === command &&
    command.prepareHeldCommand === prepare &&
    command.canPrepareHeldCommand === canPrepare &&
    deps.deliver === deliver &&
    deps.recordOwnership === recordOwnership &&
    deps.menu === menu &&
    (!menuPorts ||
      Object.entries(menuPorts).every(
        ([key, value]) => Reflect.get(menu!, key) === value,
      ));
  const current = () =>
    portsCurrent() && isCurrent.call(recipient) && portsCurrent();
  if (!current()) return undefined;
  const api = BusApi.createTelegramSelectedMenuTextApi({
    operationId,
    registrationGeneration,
    target,
    assertAuthority: assertRecipientCurrent,
    deliver,
  });
  const rendered =
    Replies.createTelegramRenderedMessageDeliveryRuntime<Menu.TelegramReplyMarkup>(
      {
        sendMessage: api.sendMessage,
        editMessage: api.editMessageText,
        recordOwnership,
        async sendRichMessage() {
          throw new Error(
            "Selected command has no rich or ordinary API fallback.",
          );
        },
      },
    );
  const menus =
    menuPorts &&
    Menu.createTelegramMenuActionRuntime({
      ...menuPorts,
      sendTextReply: rendered.sendTextReply,
      sendInteractiveMessage: rendered.sendInteractiveMessage,
      editInteractiveMessage: rendered.editInteractiveMessage,
    });
  const effects = {
    sendTextReply: rendered.sendTextReply,
    ...(menus ? { showStatus: menus.sendStatusMessage } : {}),
  };
  if (!canPrepare.call(command, name, effects) || !current()) return undefined;
  return {
    isCurrent: current,
    assertRecipientCurrent,
    prepare(readiness, context, input) {
      if (
        !current() ||
        context !== ctx ||
        input.target.chatId !== target.chatId ||
        input.target.threadId !== target.threadId ||
        input.assertRecipientCurrent !== assertRecipientCurrent
      )
        return undefined;
      const plan = prepare.call(
        command,
        name,
        readiness,
        context,
        input,
        effects,
      );
      return current() ? plan : undefined;
    },
  };
}

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
  requestNextDispatchAnnouncement: () => void;
  cancelNextDispatchAnnouncement: () => void;
  watchdog: Queue.TelegramQueueDispatchWatchdogRuntime<TContext>;
  onTurnEnd: (
    event: Pick<Pi.TurnEndEvent, "turnIndex" | "outcome">,
    ctx: TContext,
  ) => Pi.TurnEndEventResult | undefined;
}

export function createTelegramQueueBindingRuntime<TContext>(deps: {
  store: Queue.TelegramQueueStateStore<TContext>;
  queue: Pick<Runtime.TelegramBridgeRuntime["queue"], "allocateItemOrder">;
  lifecycle: Pick<
    Runtime.TelegramBridgeRuntime["lifecycle"],
    "isCompactionInProgress" | "hasDispatchPending"
  > & Partial<Pick<Runtime.TelegramBridgeRuntime["lifecycle"], "getActiveToolExecutions">>;
  activeTurn: Pick<Queue.TelegramActiveTurnStore, "has"> & Partial<Pick<Queue.TelegramActiveTurnStore, "get">>;
  admission: {
    getSettlement: () =>
      | {
          onItemsDiscarded: (
            items: readonly Queue.TelegramQueueItem<TContext>[],
            ctx: TContext,
          ) => boolean;
          isItemReady: (item: Queue.TelegramQueueItem<TContext>) => boolean;
          onPromptHandedOff?: (
            item: Pick<Queue.PendingTelegramTurn, "admissionReceipts">,
            ctx: TContext,
          ) => boolean;
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
  isContextCurrent?: (ctx: TContext) => boolean;
  isContextAborted?: (ctx: TContext) => boolean;
  isShutdownRequested?: () => boolean;
  updateStatus: (ctx: TContext, error?: string) => void;
  sendTextReply: Queue.TelegramQueueDispatchRuntimeDeps<TContext>["sendTextReply"];
  sendUserMessage: Queue.TelegramQueueDispatchRuntimeDeps<TContext>["sendUserMessage"];
  reconcileNextDispatchAnnouncementReplyOwnership?: (
    item: Queue.PendingTelegramTurn,
  ) => void;
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
    return settlement.onItemsDiscarded(durableItems, ctx) === true;
  };
  const settlePromptPacket = (items: readonly Queue.PendingTelegramTurn[], ctx: TContext): boolean => {
    const receipts = items.flatMap(item => item.admissionReceipts ?? []);
    return receipts.length === 0 || deps.admission.getSettlement()?.onPromptHandedOff?.({ admissionReceipts: receipts }, ctx) === true;
  };
  const mutation = Queue.createTelegramQueueMutationController({
    ...deps.store,
    hasPendingDispatch: deps.lifecycle.hasDispatchPending,
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
    hasDispatchContext: () => !deps.isShutdownRequested?.() && deps.deferredDispatch.isBound(),
    getDispatchGeneration: deps.deferredDispatch.getGeneration,
    isDispatchGenerationActive: generation => !deps.isShutdownRequested?.() && deps.deferredDispatch.isGenerationActive(generation),
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
      return settlement.onPromptHandedOff(item, ctx) === true;
    },
    steerDispatch: {
      commitPacket: settlePromptPacket,
      isContextCurrent: (ctx: TContext) => !deps.isShutdownRequested?.() && deps.isContextCurrent?.(ctx) === true,
      canSubmit: (ctx: TContext) => !deps.isShutdownRequested?.() && deps.isContextAborted?.(ctx) === false &&
        deps.isIdle(ctx) && !deps.hasPendingMessages(ctx) && !deps.lifecycle.isCompactionInProgress() &&
        !deps.activeTurn.has() && (deps.lifecycle.getActiveToolExecutions?.() ?? 0) === 0,
    },
    onControlSettled(item, ctx) {
      deps.admission.getSettlement()?.onControlSettled(item, ctx);
    },
    onPromptSkipped(item, ctx) {
      return settleDiscardedItems([item], ctx);
    },
    updateStatus: deps.updateStatus,
    sendTextReply: deps.sendTextReply,
    reconcileNextDispatchAnnouncementReplyOwnership:
      deps.reconcileNextDispatchAnnouncementReplyOwnership,
    recordRuntimeEvent: deps.recordRuntimeEvent,
    ...deps.promptDispatch,
    sendUserMessage: deps.sendUserMessage,
  });
  const steer = Queue.createTelegramSteerBoundaryRuntime({
    ...deps.store,
    getGeneration: deps.deferredDispatch.getGeneration,
    isContextCurrent: (ctx: TContext) => !deps.isShutdownRequested?.() && deps.isContextCurrent?.(ctx) === true,
    isBlocked: (ctx: TContext) =>
      deps.isShutdownRequested?.() === true || deps.isContextAborted?.(ctx) !== false || !deps.deferredDispatch.isBound() ||
      deps.isIdle(ctx) || deps.hasPendingMessages(ctx) ||
      deps.lifecycle.isCompactionInProgress() || deps.lifecycle.hasDispatchPending() ||
      (deps.lifecycle.getActiveToolExecutions?.() ?? 0) > 0 ||
      (deps.activeTurn.has() && !deps.activeTurn.get?.()),
    isItemReady(item: Queue.TelegramQueueItem<TContext>) {
      return deps.transportStamp.isActive(item.transportStamp) &&
        !deps.admission.hasPendingQueueMutationForItem(item) &&
        (deps.admission.getSettlement()?.isItemReady(item) ?? (item.admissionReceipts?.length ?? 0) === 0);
    },
    isItemCurrent: (item) => deps.transportStamp.isActive(item.transportStamp) &&
      !deps.admission.hasPendingQueueMutationForItem(item),
    getActiveTurn: () => deps.activeTurn.get?.(),
    commitPacket: settlePromptPacket,
    discardItem: (item, ctx) => settleDiscardedItems([item], ctx),
    updateStatus: deps.updateStatus,
    recordRuntimeEvent: deps.recordRuntimeEvent,
  });
  return {
    mutation,
    onTurnEnd: steer.onTurnEnd,
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

export interface TelegramGenerativeAppLiveSurfaceBinding {
  get: () =>
    | GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.TelegramBindLiveHandle>
    | undefined;
  set: (
    runtime:
      | GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.TelegramBindLiveHandle>
      | undefined,
  ) => void;
  shutdown: () => void;
}

export function createTelegramGenerativeAppLiveSurfaceBinding(): TelegramGenerativeAppLiveSurfaceBinding {
  let current:
    | GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.TelegramBindLiveHandle>
    | undefined;
  return {
    get() {
      return current;
    },
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

export function createTelegramGenerativeAppBoundButtonActionInvoker<
  TQuery extends {
    message?: {
      chat?: { id?: number };
      message_id?: number;
      message_thread_id?: number;
    };
  },
>(deps: {
  agentDir: string;
  /** @internal Native callback-worker ownership only; no disposition or successor permission. */
  callbackWorkerDrain?: true;
  /** @internal App-only predecessor; bound mode preserves legacy unbound prompts without fabricating lineage. */
  callbackSuccessor?: true | "bound";
  /** @internal Qualified mode joins issued native origins without requiring provenance for legacy execution. */
  callbackDispatch?: true | "qualified";
  onOwnerObserved?: GenerativeApps.GenerativeAppRuntimeOptions["onOwnerObserved"];
  assertExecutionCurrent: (query: TQuery) => void;
  getExecutionFence: (
    query: TQuery,
  ) => GenerativeApps.GenerativeAppExecutionFence | undefined;
  getActiveProfileName?: () => string | undefined;
  getLiveSurfaceRuntime?: () =>
    | GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.TelegramBindLiveHandle>
    | undefined;
  planOutput: ReturnType<
    typeof OutboundHandlers.createTelegramOutboundReplyPlanner
  >;
  sendMarkdownReply: (
    chatId: number,
    replyToMessageId: number,
    markdown: string,
    options?: { replyMarkup?: OutboundHandlers.TelegramOutboundButtonMarkup; target?: TelegramTarget },
  ) => Promise<unknown>;
  editInteractiveMessage?: (
    chatId: number,
    messageId: number,
    markdown: string,
    mode: "markdown",
    replyMarkup: OutboundHandlers.TelegramOutboundButtonMarkup,
  ) => Promise<void>;
  /** App output uses its configured Markdown carrier; harness-owned interactive menus stay HTML. */
  editMarkdownMessage?: (
    chatId: number,
    messageId: number,
    markdown: string,
    replyMarkup: OutboundHandlers.TelegramOutboundButtonMarkup,
    options?: Parameters<typeof Replies.editTelegramSingleMarkdownMessage>[6],
  ) => Promise<void>;
  recordRuntimeEvent: TelegramRuntimeEventRecorder;
}): (
  action: OutboundHandlers.TelegramOutboundButtonAction,
  query: TQuery,
) => Promise<false | "new" | "edit"> {
  const editMarkdownMessage = deps.editMarkdownMessage;
  const callbackWorkerDrain = deps.callbackWorkerDrain;
  if (callbackWorkerDrain !== undefined && callbackWorkerDrain !== true) throw new Error("Callback worker drain must be true or omitted.");
  const callbackSuccessor = deps.callbackSuccessor;
  if (callbackSuccessor !== undefined && callbackSuccessor !== true && callbackSuccessor !== "bound" || callbackSuccessor && !callbackWorkerDrain) throw new Error("Callback successor requires true or bound and original worker drain.");
  const captureExecution = callbackWorkerDrain ? deps.getExecutionFence : undefined;
  const callbackDispatch = deps.callbackDispatch;
  if (callbackDispatch !== undefined && callbackDispatch !== true && callbackDispatch !== "qualified" || callbackDispatch && !callbackSuccessor) throw new Error("Callback dispatch requires true or qualified and original successor policy.");
  if (callbackWorkerDrain && typeof captureExecution !== "function") throw new Error("Callback worker execution capture is unavailable.");
  return async (action, query) => {
    let boundAction: GenerativeApps.GenerativeAppBoundAction | undefined;
    let handedOff:
      | GenerativeApps.GenerativeAppLiveSurface<GenerativeApps.TelegramBindLiveHandle>
      | undefined;
    try {
      const originalBinding = callbackSuccessor ? action.binding : undefined;
      const getBinding = () => callbackSuccessor ? originalBinding : action.binding;
      const successorEnabled = callbackSuccessor === true || callbackSuccessor === "bound" && originalBinding !== undefined;
      if (callbackDispatch && action.promptKind === "selection" || callbackDispatch === true && !getBinding()) return false;
      const dispatchRequired = callbackDispatch === true || callbackDispatch === "qualified" && hasTelegramOrdinaryCallbackOrigin(action);
      const capturedExecution = dispatchRequired && captureExecution ? Reflect.apply(captureExecution, deps, [query]) : undefined;
      const originalDispatchCheck = capturedExecution?.assertCurrent, originalDispatchSignal = capturedExecution?.signal;
      const dispatchExecution = capturedExecution && typeof originalDispatchCheck === "function" && originalDispatchSignal instanceof AbortSignal ?
        Object.freeze({ signal: originalDispatchSignal, assertCurrent: () => Reflect.apply(originalDispatchCheck, capturedExecution, []) }) : undefined;
      const dispatch = dispatchRequired ? captureTelegramOrdinaryCallbackDispatch(action, query) : undefined;
      if (dispatchRequired && !dispatch) throw new Error("Telegram ordinary callback dispatch is unavailable.");
      if (dispatchRequired && (!dispatchExecution || typeof dispatchExecution.assertCurrent !== "function" || !(dispatchExecution.signal instanceof AbortSignal))) throw new Error("Callback dispatch execution is unavailable.");
      const invocation = dispatch?.takeInvocation?.();
      if (dispatchRequired && !invocation) throw new Error("Generative App callback invocation is unavailable.");
      // Only buttons emitted by a Generative App carry a binding. An unbound button is ordinary model text
      // (`std::map`, `a::b(c)`): malformed or uninstalled-app prompts fall through to the normal prompt plane.
      if (!getBinding()) {
        try {
          boundAction = GenerativeApps.parseGenerativeAppBoundAction(
            action.prompt,
          );
        } catch {
          return false;
        }
        if (
          boundAction &&
          !(await GenerativeApps.isGenerativeAppInstalled(
            deps.agentDir,
            boundAction.app,
          ))
        ) {
          boundAction = undefined;
        }
      } else {
        boundAction = GenerativeApps.parseGenerativeAppBoundAction(
          action.prompt,
        );
      }
      if (!boundAction) return false;
      if (successorEnabled && (!getBinding() || getBinding()!.app !== boundAction.app)) throw new Error("Generative App callback origin is unavailable.");
      deps.assertExecutionCurrent(query);
      const chatId = query.message?.chat?.id;
      const messageId = query.message?.message_id, threadId = query.message?.message_thread_id;
      if (typeof chatId !== "number" || typeof messageId !== "number") {
        throw new Error("Generative App callback target is unavailable.");
      }
      const target = Object.freeze({ chatId, ...(threadId !== undefined ? { threadId } : {}) });
      const liveSurfaces = deps.getLiveSurfaceRuntime?.();
      handedOff = liveSurfaces?.take(
        GenerativeApps.getTelegramBindLiveSurfaceKey(
          boundAction.app,
          deps.getActiveProfileName?.() ?? "default",
          {
            chatId,
            ...(threadId !== undefined ? { threadId } : {}),
          },
        ),
      );
      const execution = dispatchRequired ? dispatchExecution : captureExecution ? Reflect.apply(captureExecution, deps, [query]) : undefined;
      const originalExecutionCheck = execution?.assertCurrent;
      const assertResultExecutionCurrent = () => {
        deps.assertExecutionCurrent(query);
        if (originalExecutionCheck) Reflect.apply(originalExecutionCheck, execution, []);
      };
      const result = await GenerativeApps.invokeGenerativeApp({
        ...(invocation ? { callbackInvocation: invocation } : {}),
        ...(callbackWorkerDrain ? { callbackWorkerDrain: true } : {}),
        ...(successorEnabled ? { callbackBinding: originalBinding } : {}),
        agentDir: deps.agentDir,
        onOwnerObserved: deps.onOwnerObserved, recordRuntimeEvent: deps.recordRuntimeEvent,
        ...(callbackWorkerDrain ? (execution ? { execution } : {}) : deps.getExecutionFence(query)
          ? { execution: deps.getExecutionFence(query) }
          : {}),
        ...(boundAction.argument !== undefined
          ? { argument: boundAction.argument }
          : {}),
        ...(getBinding()?.app === boundAction.app
          ? {
              expectedGeneration: getBinding()!.generation,
              expectedRevision: getBinding()!.revision,
              assertCallbackOwner: getBinding()!.assertCurrent,
            }
          : {}),
        method: boundAction.method,
        app: boundAction.app,
      });
      assertResultExecutionCurrent();
      const successor = GenerativeApps.getGenerativeAppCallbackBinding(result);
      if (dispatch) {
        if (callbackDispatch === "qualified" && GenerativeApps.getGenerativeAppCallbackInvocationKind(successor, invocation) === "state-written") {
          if (!GenerativeApps.captureGenerativeAppCallbackOwner(successor)) throw new Error("Generative App callback result is unavailable.");
        } else if (!dispatch.captureReadOnlySuccessor?.(successor, invocation)) throw new Error("Generative App callback invocation successor is unavailable.");
      }
      const reply = deps.planOutput(result.output, {
        binding: successor,
      });
      if (handedOff && liveSurfaces) {
        try {
          await liveSurfaces.resume(handedOff, result);
          deps.assertExecutionCurrent(query);
          return "edit";
        } catch (error) {
          deps.recordRuntimeEvent("generative-app", error, {
            phase: "bound-action-live-edit-fallback",
            app: boundAction.app,
            method: boundAction.method,
          });
        }
      }
      if (result.viewMode === "edit" && (editMarkdownMessage || deps.editInteractiveMessage)) {
        let editFailed = false;
        try {
          const markup = reply.replyMarkup ?? { inline_keyboard: [] };
          if (editMarkdownMessage) await Reflect.apply(editMarkdownMessage, deps, [chatId, messageId, reply.markdown, markup, {
            assertLocalAuthority: assertResultExecutionCurrent,
          }]);
          else await deps.editInteractiveMessage!(chatId, messageId, reply.markdown, "markdown", markup);
        } catch (error) {
          editFailed = true;
          deps.recordRuntimeEvent("generative-app", error, {
            phase: "bound-action-edit-fallback",
            app: boundAction.app,
            method: boundAction.method,
          });
        }
        assertResultExecutionCurrent();
        if (!editFailed) return "edit";
      }
      assertResultExecutionCurrent();
      await deps.sendMarkdownReply(chatId, messageId, reply.markdown, {
        replyMarkup: reply.replyMarkup, target,
      });
      assertResultExecutionCurrent();
      return "new";
    } catch (error) {
      if (handedOff) deps.getLiveSurfaceRuntime?.()?.open(handedOff);
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
  prepareTelegramPreview?: () =>
    Activity.TelegramAssistantOutputPreparation | undefined;
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
    prepareSend: (event) =>
      event.source === "telegram" ? deps.prepareTelegramPreview?.() : undefined,
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
  hasPending: Activity.TelegramActivityPublicationRuntime["hasPending"];
  beginWork: Activity.TelegramActivityPublicationRuntime["beginWork"];
  hasUnconfirmed: Activity.TelegramActivityPublicationRuntime["hasUnconfirmed"];
  capture: () => {
    target?: Queue.TelegramQueueTarget;
    isCurrent: () => boolean;
  };
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
  captureDrain?: () => (() => void) | undefined;
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
  const publication = Activity.createTelegramActivityPublicationRuntime({ captureDrain: deps.captureDrain });
  const assistantOutputBinding = createTelegramAssistantOutputBindingRuntime({
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
    captureDrain: deps.captureDrain,
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
      hasPending: publication.hasPending,
      beginWork: publication.beginWork,
      hasUnconfirmed: publication.hasUnconfirmed,
      capture() {
        const authority = assistantOutputBinding.authority.captureAuthority();
        return {
          target: authority.target ? { ...authority.target } : undefined,
          isCurrent: () =>
            assistantOutputBinding.authority.isAuthorityActive(authority),
        };
      },
    },
  };
}

/** Fresh current work projection; a snapshot is not a cleanup grant or target-application ACK. */
export function createTelegramLiveTargetWorkObserver<TContext>(deps: {
  queue: Pick<Queue.TelegramQueueStateStore<TContext>, "getQueuedItems">;
  activeTurn: Pick<Queue.TelegramActiveTurnStore, "get">;
  lifecycle: Pick<
    Runtime.TelegramBridgeRuntime["lifecycle"],
    "hasDispatchPending" | "isCompactionInProgress" | "getActiveToolExecutions"
  >;
  isIdle(ctx: TContext): boolean;
  hasPendingMessages(ctx: TContext): boolean;
  hasPendingControl(): boolean;
  publication: Pick<
    TelegramBridgePublicationRuntime,
    "hasPending" | "hasUnconfirmed"
  >;
  activity: Pick<Activity.TelegramActivityRuntime, "hasPending">;
  delivery: Pick<
    ReturnType<typeof Delivery.createTelegramDeliveryLifecycleHooks>,
    "hasPendingTarget"
  >;
  api: Pick<TelegramApi.TelegramApiTargetActivityRuntime, "hasPendingTarget">;
}): (
  target: TelegramTarget & { threadId: number },
  ctx: TContext,
) => TelegramBusLiveRebindWorkState {
  return (target, ctx) => {
    const work = Queue.observeTelegramTargetQueueWork(
      target,
      deps.activeTurn.get(),
      deps.queue.getQueuedItems(),
    );
    const flags = [
      deps.isIdle(ctx),
      deps.hasPendingMessages(ctx),
      deps.lifecycle.hasDispatchPending(),
      deps.lifecycle.isCompactionInProgress(),
      deps.hasPendingControl(),
    ];
    const tools = deps.lifecycle.getActiveToolExecutions();
    const publication = deps.publication.hasPending(),
      unconfirmed = deps.publication.hasUnconfirmed?.(),
      activity = deps.activity.hasPending?.(),
      delivery = deps.delivery.hasPendingTarget(target),
      api = deps.api.hasPendingTarget(target);
    const unknown =
      work.unknown ||
      flags.some((flag) => typeof flag !== "boolean") ||
      !Number.isSafeInteger(tools) ||
      tools < 0 ||
      unconfirmed !== false ||
      [publication, activity, delivery, api].some(
        (flag) => typeof flag !== "boolean",
      );
    return {
      sessionBusy:
        flags[0] !== true || flags.slice(1).some(Boolean) || tools > 0,
      targetWork: work.protected,
      deliveryPending:
        publication === true ||
        activity === true ||
        delivery === true ||
        api === true,
      unknown,
    };
  };
}

interface TelegramCommandsAndToolsBindingDeps {
  pi: Pi.ExtensionAPI;
  handleInternalAction:
    Commands.TelegramSessionActionRuntime["handleInternalAction"];
  agentDir: string;
  configStore: Config.TelegramConfigStore;
  persistConfig: (config?: Config.TelegramConfig) => Promise<void>;
  setup: Setup.TelegramSetupGuard;
  activeTurnRuntime: Queue.TelegramActiveTurnStore<Queue.PendingTelegramTurn>;
  lockedPollingRuntime: Locks.TelegramLockedPollingRuntime<Pi.ExtensionContext>;
  stopPolling?: () => Promise<void | string>;
  getDisconnectThreadName?: () => string | undefined;
  onTransportChanged?: () => Promise<void> | void;
  /** Read the selected profile's canonical projection only after this connect published an approved envelope reset. */
  refreshProfileStateAfterReset?: () => Promise<void>;
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
  mutateChannelPost(input: {
    action: "edit" | "delete";
    operationId: string;
    mutationId: string;
    markdown?: string;
  }): Promise<ChannelPosts.TelegramChannelPostRecord>;
  callMultipart: OutboundHandlers.TelegramVoiceReplySenderDeps["sendMultipart"];
  getDefaultChatId: () => number | undefined;
  getDefaultTarget?: () => OutboundAttachments.TelegramQueuedOutboundAttachmentTurnView["target"];
  resolveAgentTarget?: OutboundAttachments.TelegramOutboundMessageToolRegistrationDeps["resolveAgentTarget"];
  routeAgentMessage?: OutboundAttachments.TelegramOutboundMessageToolRegistrationDeps["routeAgentMessage"];
  canSendDirect: () => boolean;
  setGenerativeAppLiveSurfaceRuntime?: (
    runtime:
      | GenerativeApps.GenerativeAppLiveSurfaceRuntime<GenerativeApps.TelegramBindLiveHandle>
      | undefined,
  ) => void;
  updateStatus: TelegramBridgeStatusUpdater;
  isContextCurrent: (ctx: Pi.ExtensionContext) => boolean;
  getSessionGeneration: () => number;
  connectionIntent: NonNullable<
    Commands.TelegramBridgeCommandRegistrationDeps["connectionIntent"]
  >;
  recordRuntimeEvent: TelegramRuntimeEventRecorder;
}

export function registerTelegramCommandsAndTools({
  pi,
  handleInternalAction,
  agentDir,
  configStore,
  persistConfig,
  setup,
  activeTurnRuntime,
  lockedPollingRuntime,
  stopPolling,
  getDisconnectThreadName,
  onTransportChanged,
  refreshProfileStateAfterReset,
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
  setGenerativeAppLiveSurfaceRuntime,
  recordRuntimeEvent,
  updateStatus,
  isContextCurrent,
  getSessionGeneration,
  connectionIntent,
}: TelegramCommandsAndToolsBindingDeps): void {
  GenerativeApps.registerTelegramBindTool(pi, {
    agentDir,
    onOwnerObserved: buttonActionStore.observeAppOwner,
    capturePublicationSource: buttonActionStore.capturePublicationSource,
    getActiveProfileName: configStore.getActiveProfileName,
    getActiveTurn: activeTurnRuntime.get,
    ...(setGenerativeAppLiveSurfaceRuntime
      ? { setLiveSurfaceRuntime: setGenerativeAppLiveSurfaceRuntime }
      : {}),
    isDeliveryHandleCurrent: Delivery.isTelegramDeliveryHandleCurrent,
    editView: (handle, view) =>
      Delivery.editTelegramView(
        handle as Delivery.TelegramDeliveryHandle,
        view as Delivery.TelegramDeliveryView,
      ),
    planOutput: OutboundHandlers.createTelegramOutboundReplyPlanner(
      buttonActionStore,
      Config.createTelegramConfigControls(configStore)
        .getAssistantRenderingMode,
      true,
      true,
    ),
    sendMarkdownReply,
    sendView: (view, options) =>
      Delivery.sendTelegramView(view as Delivery.TelegramDeliveryView, options),
    recordRuntimeEvent,
  });
  ChannelPosts.registerTelegramChannelPostMutationTool(pi, {
    mutate: mutateChannelPost,
  });
  ChannelPosts.registerTelegramChannelPostListTool(pi, {
    list: listChannelPosts,
  });
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
    planMessage: OutboundHandlers.createTelegramOutboundReplyPlanner(
      buttonActionStore,
      Config.createTelegramConfigControls(configStore)
        .getAssistantRenderingMode,
      true,
      true,
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
    handleInternalAction,
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
            configStore.setProfile(profileName, profile);
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
          ctx.ui.notify(
            `Profile "${profileName}" saved and connected.`,
            "info",
          );
        }
      }
    },
    getStatusLines,
    reloadConfig: configStore.load,
    hasBotToken: configStore.hasBotToken,
    getBotTokenDiagnostic: configStore.getBotTokenDiagnostic,
    startPolling: lockedPollingRuntime.start,
    recordConnectionEvent: (error, phase) =>
      recordRuntimeEvent("connection", error, { phase }),
    stopPolling: stopPolling ?? lockedPollingRuntime.stop,
    getDisconnectThreadName,
    queueAgentConnectionContext,
    updateStatus,
    isContextCurrent,
    getSessionGeneration,
    connectionIntent,
    getProfileNames: () =>
      Config.getTelegramProfileNames(configStore.getStoredConfig()),
    activateDefaultProfileConfig: async (ctx, isCurrent) => {
      const previousProfileName = configStore.getActiveProfileName();
      await configStore.load();
      if (!isCurrent()) return;
      const selectedConfig = configStore.getStoredConfig();
      const selectedToken = configStore.getBotToken(Config.TELEGRAM_DEFAULT_PROFILE_NAME);
      const isSelectionCurrent = (expectedProfile = previousProfileName) => {
        if (!isCurrent()) return false;
        if (configStore.getStoredConfig() !== selectedConfig ||
          configStore.getActiveProfileName() !== (expectedProfile === Config.TELEGRAM_DEFAULT_PROFILE_NAME ? undefined : expectedProfile) ||
          configStore.getBotToken(Config.TELEGRAM_DEFAULT_PROFILE_NAME) !== selectedToken)
          throw new Error("Telegram connection profile selection changed.");
        return true;
      };
      const reset = selectedToken ? lockedPollingRuntime.prepareConnection(ctx, isSelectionCurrent) : false;
      if (!isSelectionCurrent()) return;
      if (previousProfileName) {
        await (stopPolling ?? lockedPollingRuntime.stop)();
        if (!isSelectionCurrent()) return;
      }
      configStore.activateProfile(undefined);
      if (!isSelectionCurrent(Config.TELEGRAM_DEFAULT_PROFILE_NAME)) return;
      if (reset) {
        if (!refreshProfileStateAfterReset) throw new Error("Telegram profile refresh after state reset is unavailable.");
        await refreshProfileStateAfterReset();
        if (!isSelectionCurrent(Config.TELEGRAM_DEFAULT_PROFILE_NAME)) return;
      }
      await onTransportChanged?.();
      isSelectionCurrent(Config.TELEGRAM_DEFAULT_PROFILE_NAME);
    },
    activateProfileConfig: async (ctx, profileName, isCurrent) => {
      const previousProfileName = configStore.getActiveProfileName();
      await configStore.load();
      if (!isCurrent()) return false;
      if (!Config.isValidTelegramProfileName(profileName)) return false;
      const storedConfig = configStore.getStoredConfig();
      if (!storedConfig.profiles?.[profileName]) return false;
      const selectedToken = configStore.getBotToken(profileName);
      const isSelectionCurrent = (expectedProfile = previousProfileName) => {
        if (!isCurrent()) return false;
        if (configStore.getStoredConfig() !== storedConfig ||
          configStore.getActiveProfileName() !== (expectedProfile === Config.TELEGRAM_DEFAULT_PROFILE_NAME ? undefined : expectedProfile) ||
          configStore.getBotToken(profileName) !== selectedToken)
          throw new Error("Telegram connection profile selection changed.");
        return true;
      };
      const reset = selectedToken ? lockedPollingRuntime.prepareConnection(ctx, isSelectionCurrent) : false;
      if (!isSelectionCurrent()) return false;
      if (previousProfileName !== profileName) {
        await (stopPolling ?? lockedPollingRuntime.stop)();
        if (!isSelectionCurrent()) return false;
      }
      if (!configStore.activateProfile(profileName)) return false;
      if (!isSelectionCurrent(profileName)) return false;
      if (reset) {
        if (!refreshProfileStateAfterReset) throw new Error("Telegram profile refresh after state reset is unavailable.");
        await refreshProfileStateAfterReset();
        if (!isSelectionCurrent(profileName)) return false;
      }
      await onTransportChanged?.();
      return isSelectionCurrent(profileName);
    },
  });
}

interface TelegramLifecycleBindingDeps {
  pi: Pi.ExtensionAPI;
  publicationRuntime: TelegramBridgePublicationRuntime;
  activityRuntime: Activity.TelegramActivityRuntime;
  activityVerbosityRuntime?: ActivityVerbosity.TelegramActivityVerbosityRuntime;
  diagnostics?: { onSessionStart(): void; onSessionShutdown(): Promise<void> };
  assistantOutputRuntime: Pick<
    Activity.TelegramAssistantOutputRuntime,
    | "start"
    | "beginTurn"
    | "hasAdmittedTelegramIntermediate"
    | "waitForIdle"
    | "stop"
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
  onSessionStarted?: (
    event: Pi.SessionStartEvent,
    ctx: Pi.ExtensionContext,
  ) => void;
  shutdownGenerativeAppLiveSurfaces?: () => void;
  resolveAutomaticThreadCleanupEnabled?: () => boolean | Promise<boolean>;
  buttonActionStore: OutboundHandlers.TelegramButtonActionStore;
  callMultipart: (...args: Parameters<TelegramApi.TelegramBridgeApiRuntime["callMultipart"]>) => Promise<unknown>;
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
  onSteerTurnEnd?: TelegramQueueBindingRuntime<Pi.ExtensionContext>["onTurnEnd"];
  onPromptHandedOff?: (
    turn: Queue.PendingTelegramTurn,
    ctx: Pi.ExtensionContext,
  ) => void;
  answerGuestQuery: TelegramApi.TelegramBridgeApiRuntime["answerGuestQuery"];
  editGuestInlineMessage?: TelegramApi.TelegramBridgeApiRuntime["editGuestInlineMessage"];
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
  getSessionGeneration?: () => number;
  isTurnTransportActive?: (turn: Queue.PendingTelegramTurn) => boolean;
  updateStatus: TelegramBridgeStatusUpdater;
  recordRuntimeEvent: TelegramRuntimeEventRecorder;
  /** Settled-session hint for owners that wait on agent idleness, such as old-tab cleanup after a live rebind. */
  onSessionSettled?: (ctx: Pi.ExtensionContext) => void;
}

export function registerTelegramLifecycleRuntimeHooks({
  pi,
  publicationRuntime,
  activityRuntime,
  activityVerbosityRuntime,
  diagnostics,
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
  onSessionStarted,
  shutdownGenerativeAppLiveSurfaces,
  resolveAutomaticThreadCleanupEnabled,
  buttonActionStore,
  callMultipart,
  sendChatAction,
  sendRecordVoiceAction,
  sendMarkdownReply,
  sendTextReply,
  dispatchNextQueuedTelegramTurn,
  onSteerTurnEnd,
  onPromptHandedOff,
  answerGuestQuery,
  editGuestInlineMessage,
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
  getSessionGeneration,
  isTurnTransportActive,
  updateStatus,
  recordRuntimeEvent,
  onSessionSettled,
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
    options?: { isDeliveryActive?: () => boolean },
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
      guestInlineMessageId: turn.guestInlineMessageId,
      editGuestInlineMessage,
      isDeliveryActive: options?.isDeliveryActive,
      stagingChatId,
      stagingTarget,
      attachment,
      caption,
      sendMultipart: (method, fields, fileField, path, name) =>
        callMultipart(method, fields, fileField, path, name, {
          assertAuthority() {
            if (options?.isDeliveryActive?.() === false) throw new Error("Guest attachment upload lost authority.");
          },
        }),
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
      true,
      true,
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
  let pendingFinalPublication:
    | {
        turn: Queue.PendingTelegramTurn;
        reservation: Activity.TelegramActivityPublicationReservation;
      }
    | undefined;
  const cancelPendingFinalPublication = (): void => {
    pendingFinalPublication?.reservation.cancel();
    pendingFinalPublication = undefined;
  };
  const recordPublicationFailure = (error: unknown): void => {
    recordRuntimeEvent("delivery", error, {
      phase: "agent-end-background-delivery",
    });
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
    isAssistantAlreadyPublished: (assistant) =>
      !!assistant.text &&
      assistantOutputRuntime.hasAdmittedTelegramIntermediate(assistant.text),
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
      const reservation =
        matches && pending ? pending.reservation : publicationRuntime.reserve();
      return {
        schedule: (task) => {
          void reservation.publish(task).catch(recordPublicationFailure);
        },
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
  const agentStartWithDedupReset = Lifecycle.createAgentStartDedupHook(
    agentLifecycleHooks.onAgentStart,
    Replies.resetTransportReplyDedup,
    scheduleActiveTurnDelivery,
  );
  let uiPromptActive = false;
  const startAgentActivityTypingLoop = (ctx: Pi.ExtensionContext): boolean => {
    if (uiPromptActive || !canSendAgentActivity(ctx)) return false;
    const turn = activeTurnRuntime.get();
    const target = turn?.target ?? proactivePushTargetGetter();
    return (
      promptDispatchRuntime.startTypingLoop(
        ctx,
        turn?.chatId ?? target?.chatId,
        { target, ensure: true },
      ) !== false
    );
  };
  const startActiveTurnTypingLoop = (ctx: Pi.ExtensionContext): void => {
    if (uiPromptActive) return;
    const turn = activeTurnRuntime.get();
    promptDispatchRuntime.startTypingLoop(ctx, turn?.chatId, {
      target: turn?.target,
      ensure: true,
    });
  };
  let observedAutomaticCompaction = false;
  let agentWorkActive = false;
  const prepareCompactionNotice = (
    text: string,
    ctx: Pi.ExtensionContext,
  ): (() => Promise<void>) => {
    const authority = publicationRuntime.capture();
    const turn = activeTurnRuntime.get();
    const selectedTarget = turn?.target ?? authority.target;
    const target = selectedTarget ? { ...selectedTarget } : undefined;
    const replyToMessageId = turn?.replyToMessageId;
    return async () => {
      if (!target || !isSessionContextActive(ctx) || !authority.isCurrent())
        return;
      if (turn && isTurnTransportActive?.(turn) === false) return;
      try {
        await sendMarkdownReply(target.chatId, replyToMessageId, text, {
          target,
        });
      } catch (error) {
        recordRuntimeEvent("delivery", error, { phase: "compaction-notice" });
      }
    };
  };
  const sendCompactionNotice = (
    text: string,
    ctx: Pi.ExtensionContext,
  ): void => {
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
      isContextActive: isSessionContextActive,
      getSessionGeneration,
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
    ...(onSteerTurnEnd ? {
      onTurnEnd(event: Pi.TurnEndEvent, ctx: Pi.ExtensionContext) {
        const result = onSteerTurnEnd(event, ctx);
        return result ? { ...result, entries: [...event.entries, ...(result.entries ?? [])] } : undefined;
      },
    } : {}),
    onInput(event) {
      activityRuntime.recordInputSource(event.source ?? "unknown");
    },
    async onSessionStart(event, ctx) {
      buttonActionStore.clear?.();
      diagnostics?.onSessionStart();
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
      const generation = getSessionGeneration?.();
      const isCurrent = () => (!getSessionGeneration || Object.is(getSessionGeneration(), generation)) && isSessionContextActive(ctx);
      if (!isCurrent()) return;
      buttonActionStore.clear?.();
      const buttonsStopped = buttonActionStore.waitForPublicationIdle?.();
      const diagnosticsStopped = diagnostics?.onSessionShutdown();
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
      const stopped = await Promise.allSettled([diagnosticsStopped, buttonsStopped]);
      for (const outcome of stopped) if (outcome.status === "rejected") throw outcome.reason;
      if (!isCurrent()) return;
      if (event.reason === "quit" && disconnectOnQuit) {
        try {
          const automaticCleanupEnabled =
            (await resolveAutomaticThreadCleanupEnabled?.()) ?? true;
          if (!isCurrent()) return;
          if (automaticCleanupEnabled) await disconnectOnQuit();
        } catch (error) {
          recordRuntimeEvent("session", error, {
            phase: "automatic-disconnect-on-quit",
          });
        }
      }
      if (!isCurrent()) return;
      await sessionLifecycleRuntime.onSessionShutdown(event, ctx);
    },
    async onSessionBeforeCompact(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      const shouldNotify = !(lifecycle.isCompactionInProgress?.() ?? false);
      if (shouldNotify) observedAutomaticCompaction = true;
      activityRuntime.onCompactionStart(Pi.getSessionCompactionReason(event));
      compactionObserver.onSessionBeforeCompact(event, ctx);
      if (shouldNotify)
        sendCompactionNotice(
          Commands.TELEGRAM_COMPACTION_STARTED_MARKDOWN,
          ctx,
        );
    },
    async onSessionCompact(event, ctx) {
      if (!isSessionContextActive(ctx)) return;
      activityRuntime.onCompactionEnd(Pi.getSessionCompactionReason(event));
      compactionObserver.onSessionCompact(event, ctx);
      if (observedAutomaticCompaction) {
        observedAutomaticCompaction = false;
        sendCompactionNotice(
          Commands.TELEGRAM_COMPACTION_COMPLETED_MARKDOWN,
          ctx,
        );
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
      const generation = getSessionGeneration?.();
      agentWorkActive = true;
      cancelPendingFinalPublication();
      await agentStartWithDedupReset(event, ctx);
      if (!isSessionContextActive(ctx) || (getSessionGeneration && !Object.is(getSessionGeneration(), generation))) return;
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
      if (
        event.message.role !== "assistant" ||
        event.message.stopReason === "toolUse" ||
        event.message.stopReason === "aborted"
      )
        return;
      const turn = activeTurnRuntime.get();
      if (!turn || turn.guestQueryId || pendingFinalPublication?.turn === turn)
        return;
      cancelPendingFinalPublication();
      const assistant = Replies.extractLatestAssistantMessageText([
        event.message,
      ]);
      if (
        !assistant.text &&
        assistant.stopReason !== "error" &&
        turn.queuedAttachments.length === 0
      )
        return;
      pendingFinalPublication = {
        turn,
        reservation: publicationRuntime.reserve(),
      };
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
      if (
        pendingFinalPublication &&
        pendingFinalPublication.turn !== activeTurnRuntime.get()
      ) {
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
        if (pendingFinalPublication === pending)
          cancelPendingFinalPublication();
      }
      if (!isSessionContextActive(ctx)) return;
      agentWorkActive = false;
      activityRuntime.onAgentSettled();
      modelContextAvailabilityRuntime.reconcile();
      onSessionSettled?.(ctx);
    },
    onBeforeAgentStart: Prompts.createTelegramProactiveBeforeAgentStartHook({
      reconcileAvailability: modelContextAvailabilityRuntime.reconcile,
      isAvailable: canSendAgentActivity,
    }),
  });
}
