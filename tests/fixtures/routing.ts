/** Native routing composition shared by route regressions and cross-domain custody acceptance. Zones: telegram, pi agent, shared utils. */
import * as Bindings from "../../lib/bindings.ts";
import * as Commands from "../../lib/commands.ts";
import * as Delivery from "../../lib/delivery.ts";
import * as Media from "../../lib/media.ts";
import * as Menu from "../../lib/menu.ts";
import * as Model from "../../lib/model.ts";
import * as Outbound from "../../lib/outbound.ts";
import * as Queue from "../../lib/queue.ts";
import * as Routing from "../../lib/routing.ts";
import * as Runtime from "../../lib/runtime.ts";
import * as TextGroups from "../../lib/text-groups.ts";
import * as Threads from "../../lib/threads.ts";
import * as Updates from "../../lib/updates.ts";

export interface TestContext { cwd: string; }
export interface TestModel extends Model.MenuModel { provider: "test"; id: "model"; }
export interface TestUser extends Updates.TelegramUser {}
export interface TestMessage extends Routing.TelegramRoutedMessage {
  date?: number;
  chat: { id: number; type: "private" };
  from?: TestUser;
  message_id: number;
  message_thread_id?: number;
  media_group_id?: string;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
  caption?: string;
  text?: string;
  reply_markup?: Outbound.TelegramOutboundButtonMarkup;
}
export interface TestCallbackQuery extends Routing.TelegramRoutedCallbackQuery {
  id: string;
  from: TestUser;
  message?: TestMessage;
  data?: string;
}
export interface TestUpdate extends Updates.TelegramUpdateFlow {
  update_id?: number;
  message?: TestMessage;
  edited_message?: TestMessage;
  callback_query?: TestCallbackQuery;
}

export interface RouteHarnessOptions {
  deliveryRuntime?: Delivery.TelegramDeliveryRuntime;
  instanceTarget?: Delivery.TelegramDeliveryTarget;
  config?: unknown;
  configStore?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage, TestCallbackQuery, TestContext, TestModel
  >["configStore"];
  sendStatusMessage?: Menu.TelegramMenuActionRuntime<TestContext, TestModel>["sendStatusMessage"];
  beginCommandEffectWork?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["beginCommandEffectWork"];
  recordRuntimeEvent?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["recordRuntimeEvent"];
  isIdle?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["isIdle"];
  dispatchNextQueuedTelegramTurn?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["dispatchNextQueuedTelegramTurn"];
  requestNextDispatchAnnouncement?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["requestNextDispatchAnnouncement"];
  cancelNextDispatchAnnouncement?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["cancelNextDispatchAnnouncement"];
  menuActions?: Menu.TelegramMenuActionRuntime<TestContext, TestModel>;
  openQueueMenu?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["openQueueMenu"];
  openSettingsMenu?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["openSettingsMenu"];
  sendInteractiveMessage?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage, TestCallbackQuery, TestContext, TestModel
  >["sendInteractiveMessage"];
  editInteractiveMessage?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage, TestCallbackQuery, TestContext, TestModel
  >["editInteractiveMessage"];
  threadStore?: Threads.TelegramTopicTargetStore;
  runWorkspaceOperation?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["runWorkspaceOperation"];
  callApi?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["callApi"];
  answerGuestQueryForInlineMessage?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["answerGuestQueryForInlineMessage"];
  startGuestPlaceholder?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["startGuestPlaceholder"];
  deleteMessage?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["deleteMessage"];
  editSelectionMessage?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["editSelectionMessage"];
  editMessageReplyMarkup?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["editMessageReplyMarkup"];
  workspaceRestoreRecipient?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["workspaceRestoreRecipient"];
  getWorkspaceRestoreStore?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["getWorkspaceRestoreStore"];
  captureOrphanIntentReaderCompatibility?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["captureOrphanIntentReaderCompatibility"];
  captureOrphanCleanupReaderCompatibility?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["captureOrphanCleanupReaderCompatibility"];
  captureWorkspaceExternalProtection?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["captureWorkspaceExternalProtection"];
  inspectRestoreSourceAbandonment?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["inspectRestoreSourceAbandonment"];
  inspectRoutingInputGroupExpiry?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["inspectRoutingInputGroupExpiry"];
  inspectRestoreSourceCompletion?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["inspectRestoreSourceCompletion"];
  inspectRestoreQueuedReceipt?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["inspectRestoreQueuedReceipt"];
  hasWorkspaceRestoreAuthority?: () => boolean;
  hasWorkspaceLiveRebindAuthority?: () => boolean;
  canUsePreDispatchRebind?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["canUsePreDispatchRebind"];
  inspectTemporaryThreadSources?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["inspectTemporaryThreadSources"];
  recoverTemporaryThreadDeadQueueOwners?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["recoverTemporaryThreadDeadQueueOwners"];
  onItemsDiscarded?: Queue.TelegramQueueMutationControllerDeps<TestContext>["onItemsDiscarded"];
  queueAdmission?: Parameters<typeof Bindings.createTelegramQueueBindingRuntime<TestContext>>[0]["admission"];
  hasPendingMessages?: (ctx: TestContext) => boolean;
  liveRebindCommandCompletionTimeoutMs?: number;
  liveRebindCleanupSchedule?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["liveRebindCleanupSchedule"];
  temporaryThreadCleanupDelayMs?: number;
  getSessionGeneration?: () => number;
  foreignOwnedUpdateForwarder?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["foreignOwnedUpdateForwarder"];
  privateDeliveryReplies?: Routing.TelegramPrivateDeliveryReplyPorts;
  getTargetOwnership?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["getTargetOwnership"];
  getMessageOwnership?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["getMessageOwnership"];
  getCurrentLeaderEpoch?: () => number | string | undefined;
  getAdmissionJournalBinding?: () => string | undefined;
  isContextActive?: (ctx: TestContext) => boolean;
  setCurrentLeaderIdentity?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["setCurrentLeaderIdentity"];
  getLiveThreadTargets?: () => Queue.TelegramQueueTarget[];
  getDisplayTitle?: (target: Queue.TelegramQueueTarget) => string | undefined;
  getLocalThreadLabelForTarget?: (
    target: Queue.TelegramQueueTarget,
  ) => string | undefined;
  instanceId?: string;
  isVoiceReplyActive?: () => boolean;
  getCommands?: () => any[];
  mediaGroupRuntime?: Media.TelegramMediaGroupController<
    TestMessage,
    TestContext
  >;
  downloadFile?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["downloadFile"];
  processInbound?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["inboundHandlerRuntime"]["process"];
  invokeBoundButtonAction?: Routing.TelegramInboundRouteRuntimeDeps<
    TestMessage,
    TestCallbackQuery,
    TestContext,
    TestModel
  >["invokeBoundButtonAction"];
  validateThreadName?: (name: string) => string | undefined;
  renameCurrentThread?: Commands.TelegramThreadDisplayNameRenamePort;
  resetCurrentThreadName?: Commands.TelegramThreadDisplayNameResetPort;
  setMyCommands?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["setMyCommands"];
  sendTextReply?: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel>["sendTextReply"];
  observeTextReply?: (
    text: string,
    options: Parameters<
      Routing.TelegramInboundRouteRuntimeDeps<
        TestMessage,
        TestCallbackQuery,
        TestContext,
        TestModel
      >["sendTextReply"]
    >[3],
  ) => void;
}

export function createRouteHarness(options: RouteHarnessOptions = {}) {
  const events: string[] = [];
  const model: TestModel = { provider: "test", id: "model" };
  const bridgeRuntime = Runtime.createTelegramBridgeRuntime();
  const activeTurnRuntime = Queue.createTelegramActiveTurnStore();
  const telegramQueueStore = Queue.createTelegramQueueStore<TestContext>();
  const buttonActionStore = Outbound.createTelegramButtonActionStore();
  const deferredDispatch = Queue.createTelegramDeferredQueueDispatchRuntime<TestContext>();
  deferredDispatch.bind({ cwd: "/repo" });
  const queueBinding = options.queueAdmission && Bindings.createTelegramQueueBindingRuntime<TestContext>({
    store: telegramQueueStore, queue: bridgeRuntime.queue, lifecycle: bridgeRuntime.lifecycle, activeTurn: activeTurnRuntime,
    admission: options.queueAdmission, deferredDispatch, transportStamp: { isActive: () => true },
    promptDispatch: { startTypingLoop() {}, onPromptDispatchStart() {}, onPromptDispatchFailure() {} },
    isIdle: options.isIdle ?? (() => true), hasPendingMessages: options.hasPendingMessages ?? (() => false), updateStatus: () => events.push("status"),
    sendTextReply: async () => { events.push("queue-notice"); }, sendUserMessage: () => events.push("queue-model-send"),
  });
  const queueMutationRuntime = queueBinding?.mutation ?? Queue.createTelegramQueueMutationController({
    ...telegramQueueStore,
    hasPendingDispatch: bridgeRuntime.lifecycle.hasDispatchPending,
    allocateLaneOrder: bridgeRuntime.queue.allocateItemOrder,
    onItemsDiscarded: options.onItemsDiscarded,
    updateStatus: () => events.push("status"),
  });
  const currentModelRuntime = Model.createCurrentModelRuntime<
    TestContext,
    TestModel
  >({
    getContextModel: () => model,
    updateStatus: () => events.push("status"),
  });
  const modelSwitchController =
    Model.createTelegramModelSwitchControllerRuntime<
      TestContext,
      Model.ScopedTelegramModel<TestModel>
    >({
      isIdle: () => true,
      getActiveTurn: activeTurnRuntime.get,
      getAbortHandler: bridgeRuntime.abort.getHandler,
      hasAbortHandler: bridgeRuntime.abort.hasHandler,
      getActiveToolExecutions: bridgeRuntime.lifecycle.getActiveToolExecutions,
      allocateItemOrder: bridgeRuntime.queue.allocateItemOrder,
      allocateControlOrder: bridgeRuntime.queue.allocateControlOrder,
      appendQueuedItem: queueMutationRuntime.append,
      updateStatus: () => events.push("status"),
    });
  const menuActions: Menu.TelegramMenuActionRuntime<TestContext, TestModel> = {
    updateModelMenuMessage: async () => undefined,
    updateThinkingMenuMessage: async () => undefined,
    updateStatusMessage: async () => undefined,
    sendStatusMessage: async (...args) => {
      events.push("status-menu");
      await options.sendStatusMessage?.(...args);
    },
    openModelMenu: async () => undefined,
    openThinkingMenu: async () => undefined,
  };
  const routingDeps: Routing.TelegramInboundRouteRuntimeDeps<TestMessage, TestCallbackQuery, TestContext, TestModel> = {
    configStore: options.configStore ?? {
      get: () => (options.config ?? {}) as never,
      getAllowedUserId: () => 7,
      persistAllowedUserId: async () => true,
      persist: async () => undefined,
    },
    callApi: options.callApi,
    workspaceRestoreRecipient: options.workspaceRestoreRecipient,
    getWorkspaceRestoreStore: options.getWorkspaceRestoreStore,
    captureOrphanIntentReaderCompatibility: options.captureOrphanIntentReaderCompatibility,
    captureOrphanCleanupReaderCompatibility: options.captureOrphanCleanupReaderCompatibility,
    captureWorkspaceExternalProtection: options.captureWorkspaceExternalProtection,
    inspectRestoreSourceAbandonment: options.inspectRestoreSourceAbandonment,
    inspectRoutingInputGroupExpiry: options.inspectRoutingInputGroupExpiry,
    inspectRestoreSourceCompletion: options.inspectRestoreSourceCompletion,
    inspectRestoreQueuedReceipt: options.inspectRestoreQueuedReceipt,
    hasWorkspaceRestoreAuthority: options.hasWorkspaceRestoreAuthority,
    hasWorkspaceLiveRebindAuthority: options.hasWorkspaceLiveRebindAuthority,
    canUsePreDispatchRebind: options.canUsePreDispatchRebind,
    inspectTemporaryThreadSources: options.inspectTemporaryThreadSources,
    recoverTemporaryThreadDeadQueueOwners: options.recoverTemporaryThreadDeadQueueOwners,
    temporaryThreadCleanupDelayMs: options.temporaryThreadCleanupDelayMs,
    liveRebindCleanupSchedule: options.liveRebindCleanupSchedule,
    liveRebindCommandCompletionTimeoutMs: options.liveRebindCommandCompletionTimeoutMs,
    getSessionGeneration: options.getSessionGeneration,
    foreignOwnedUpdateForwarder: options.foreignOwnedUpdateForwarder,
    privateDeliveryReplies: options.privateDeliveryReplies,
    getTargetOwnership: options.getTargetOwnership,
    getMessageOwnership: options.getMessageOwnership,
    getCurrentInstanceId: () => options.instanceId ?? "leader-a",
    getAdmissionScope: () => "profile-a:bot-a",
    getAdmissionJournalBinding: options.getAdmissionJournalBinding,
    isContextActive: options.isContextActive,
    getLiveThreadTargets: options.getLiveThreadTargets,
    getDisplayTitle: options.getDisplayTitle,
    getLocalThreadLabelForTarget: options.getLocalThreadLabelForTarget,
    getCurrentLeaderEpoch: options.getCurrentLeaderEpoch,
    setCurrentLeaderIdentity: options.setCurrentLeaderIdentity,
    bridgeRuntime,
    activeTurnRuntime,
    mediaGroupRuntime:
      options.mediaGroupRuntime ??
      Media.createTelegramMediaGroupController<TestMessage, TestContext>(),
    textGroupRuntime: TextGroups.createTelegramTextGroupController<
      TestMessage,
      TestContext
    >({ forwardCommentWaitMs: false }),
    telegramQueueStore,
    queueMutationRuntime,
    modelMenuRuntime: Menu.createTelegramModelMenuRuntime<TestModel>(),
    currentModelRuntime,
    modelSwitchController,
    menuActions: options.menuActions ?? menuActions,
    openQueueMenu: options.openQueueMenu ?? (async () => undefined),
    openSettingsMenu: options.openSettingsMenu,
    queueMenuCallbackHandler: async () => false,
    inboundHandlerRuntime: {
      process:
        options.processInbound ??
        (async (files, rawText) => ({
          rawText,
          promptFiles: files,
          handlerOutputs: [],
          handledFiles: [],
        })),
    },
    threadStore: options.threadStore,
    runWorkspaceOperation: options.runWorkspaceOperation,
    buttonActionStore,
    invokeBoundButtonAction: options.invokeBoundButtonAction,
    updateStatus: () => events.push("status"),
    dispatchNextQueuedTelegramTurn: options.dispatchNextQueuedTelegramTurn ?? queueBinding?.dispatchNext ?? (() => events.push("dispatch")),
    requestNextDispatchAnnouncement: options.requestNextDispatchAnnouncement ?? queueBinding?.requestNextDispatchAnnouncement,
    cancelNextDispatchAnnouncement: options.cancelNextDispatchAnnouncement ?? queueBinding?.cancelNextDispatchAnnouncement,
    answerCallbackQuery: async (_id, text) => {
      if (text) events.push(`answer:${text}`);
    },
    answerGuestQuery: async () => undefined,
    answerGuestQueryForInlineMessage: options.answerGuestQueryForInlineMessage,
    startGuestPlaceholder: options.startGuestPlaceholder,
    editMessageReplyMarkup: options.editMessageReplyMarkup,
    editSelectionMessage: options.editSelectionMessage,
    editInteractiveMessage: options.editInteractiveMessage,
    sendInteractiveMessage: options.sendInteractiveMessage ??  (async (_chatId, text, mode, replyMarkup, sendOptions) => {
      events.push(`interactive:${mode}:${text}`);
      events.push(`markup:${JSON.stringify(replyMarkup)}`);
      events.push(`interactive-options:${JSON.stringify(sendOptions ?? {})}`);
      return 99;
    }),
    sendTextReply: options.sendTextReply ?? (async (_chatId, _replyToMessageId, text, replyOptions) => {
      options.observeTextReply?.(text, replyOptions);
      events.push(`reply:${text}`);
      if (typeof replyOptions?.target?.threadId === "number") {
        events.push(
          `reply-target:${replyOptions.target.chatId}:${replyOptions.target.threadId}`,
        );
      }
      return undefined;
    }),
    deleteMessage:
      options.deleteMessage ??
      (async (chatId, messageId) => {
        events.push(`delete-message:${chatId}:${messageId}`);
      }),
    setMyCommands: options.setMyCommands ?? (async () => undefined),
    validateThreadName: options.validateThreadName,
    renameCurrentThread: options.renameCurrentThread,
    resetCurrentThreadName: options.resetCurrentThreadName,
    getCommands: options.getCommands ?? (() => []),
    downloadFile:
      options.downloadFile ??
      (async (_fileId, fileName) => `/tmp/${fileName}`),
    getThinkingLevel: () => "high",
    setThinkingLevel: () => undefined,
    isVoiceReplyActive: options.isVoiceReplyActive,
    setModel: async () => true,
    sendUserMessage: (message, opts) => {
      events.push(`user:${message}:${opts?.deliverAs ?? "default"}`);
    },
    isIdle: options.isIdle ?? (() => true),
    hasPendingMessages: () => false,
    compact: () => undefined,
    beginCommandEffectWork: options.beginCommandEffectWork,
    recordRuntimeEvent: options.recordRuntimeEvent ?? ((category, error) => {
      events.push(`event:${category}:${String(error)}`);
    }),
  };
  const delivery = options.deliveryRuntime ?? Delivery.createTelegramDeliveryRuntime({
    generation: `fixture:${options.instanceId ?? "route"}`,
    getConfirmationAuthority: () => ({ profile: "default", operatorId: routingDeps.configStore.getAllowedUserId()! }),
    getActiveTurnTarget: () => activeTurnRuntime.get()?.target,
    getInstanceTarget: () => options.instanceTarget ?? ({ chatId: routingDeps.configStore.getAllowedUserId()! }),
    getAggregateTarget: () => undefined,
    isExplicitTargetAuthorized: target => target.chatId === routingDeps.configStore.getAllowedUserId(),
    renderView: view => [{ text: view.text, parseMode: view.parseMode ?? "plain" }],
    async sendChunk() { throw new Error("Native questions must use their captured publisher"); },
    async editChunk() {},
    async deleteMessage() {},
    async sendChatAction() {},
  });
  routingDeps.confirmations = {
    openChoice: request => delivery.openChoice!(request),
    acceptChoice: (query, guard) => delivery.acceptChoice!(query, guard),
    openConfirmation: (request, owned) => delivery.openConfirmation!(request, owned),
    acceptConfirmation: (query, guard) => delivery.acceptConfirmation!(query, guard),
  };
  const routeRuntime = Routing.createTelegramInboundRouteRuntime<TestUpdate, TestMessage, TestCallbackQuery, TestContext, TestModel>(routingDeps);
  return { buttonActionStore, bridgeRuntime, events, routeRuntime, routingDeps, telegramQueueStore, activeTurnRuntime, queueBinding, deliveryRuntime: delivery };
}
