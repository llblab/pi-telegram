/**
 * Telegram queue menu UI helpers
 * Zones: telegram ui, queue controls, menu composition
 * Owns queue-menu rendering, queue item callbacks, and queue-menu runtime adapters while core queue mechanics stay in queue
 */

import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";
import type { TelegramModelMenuState } from "./menu.ts";
import type { MenuModel } from "./model.ts";
import * as Queue from "./queue.ts";

// --- Queue Menu ---

type TelegramQueueMenuReplyMarkup = TelegramInlineKeyboardMarkup;
interface TelegramQueueMenuItem {
  chatId: number;
  replyToMessageId: number;
  isPriority: boolean;
  hasAttachments: boolean;
  statusSummary: string;
  promptText: string;
}
function getTelegramQueueItemPromptText<Context>(
  item: Queue.TelegramQueueItem<Context>,
): string {
  if (item.kind !== "prompt") return item.statusSummary;
  return item.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim() || item.statusSummary;
}
function toTelegramQueueMenuItems<Context>(
  items: readonly Queue.TelegramQueueItem<Context>[],
): TelegramQueueMenuItem[] {
  return items.map(function toTelegramQueueMenuItem(item) {
    return {
      chatId: item.chatId,
      replyToMessageId: item.replyToMessageId,
      isPriority: item.queueLane === "priority",
      hasAttachments:
        item.kind === "prompt" && item.queuedAttachments.length > 0,
      statusSummary: item.statusSummary,
      promptText: getTelegramQueueItemPromptText(item),
    };
  });
}
function buildTelegramQueueMenuReplyMarkup(
  items: readonly TelegramQueueMenuItem[],
): TelegramQueueMenuReplyMarkup {
  const backRow = [{ text: "⬆️ Main menu", callback_data: "menu:back" }];
  if (items.length === 0) return { inline_keyboard: [backRow] };
  const rows = items.map(function buildTelegramQueueMenuRow(item, index) {
    const prefix = item.isPriority ? "⚡ " : item.hasAttachments ? "📎 " : "";
    const label = `${index + 1}. ${prefix}${item.statusSummary}`;
    return [
      {
        text: label,
        callback_data: `queue:pick:${item.chatId}:${item.replyToMessageId}`,
      },
    ];
  });
  return { inline_keyboard: [backRow, ...rows] };
}
function findTelegramQueueItem<Context>(
  items: readonly Queue.TelegramQueueItem<Context>[],
  chatId: number,
  replyToMessageId: number,
): Queue.TelegramQueueItem<Context> | undefined {
  return items.find(function matchesTelegramQueueItem(item) {
    return item.chatId === chatId && item.replyToMessageId === replyToMessageId;
  });
}
function findTelegramQueueMenuItem(
  items: readonly TelegramQueueMenuItem[],
  chatId: number,
  replyToMessageId: number,
): TelegramQueueMenuItem | undefined {
  return items.find(function matchesTelegramQueueMenuItem(item) {
    return item.chatId === chatId && item.replyToMessageId === replyToMessageId;
  });
}
function escapeTelegramQueueMenuHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function getTelegramQueueMenuItemText(item: TelegramQueueMenuItem): string {
  return escapeTelegramQueueMenuHtml(item.promptText);
}
function buildTelegramQueueItemSubmenuReplyMarkup(
  chatId: number,
  replyToMessageId: number,
  isPriority: boolean,
): TelegramQueueMenuReplyMarkup {
  const priorityLabel = isPriority ? "🐢 Deprioritize" : "⚡ Prioritize";
  return {
    inline_keyboard: [
      [{ text: "⬆️ Back", callback_data: "queue:list" }],
      [
        {
          text: priorityLabel,
          callback_data: `queue:prio:${chatId}:${replyToMessageId}`,
        },
      ],
      [
        {
          text: "❌ Cancel",
          callback_data: `queue:cancel:${chatId}:${replyToMessageId}`,
        },
      ],
    ],
  };
}
interface TelegramQueueMenuCallbackDeps<Context = unknown> {
  getQueuedItems: () => TelegramQueueMenuItem[];
  findItem: (
    chatId: number,
    replyToMessageId: number,
  ) => TelegramQueueMenuItem | undefined;
  togglePriority: (chatId: number, replyToMessageId: number) => boolean;
  cancelItem: (
    chatId: number,
    replyToMessageId: number,
    ctx: Context,
  ) => boolean;
  updateQueueMessage: (
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup: TelegramQueueMenuReplyMarkup,
  ) => Promise<number | undefined>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  updateStatus: (ctx: Context) => void;
}
async function handleTelegramQueueMenuCallback<Context>(
  callbackQueryId: string,
  data: string,
  replyChatId: number,
  replyMessageId: number,
  ctx: Context,
  deps: TelegramQueueMenuCallbackDeps<Context>,
): Promise<boolean> {
  if (!data.startsWith("queue:")) return false;
  if (data === "queue:noop") {
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  if (data === "queue:list") {
    await updateTelegramQueueMenuList(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      deps,
    );
    return true;
  }
  const pickMatch = data.match(/^queue:pick:(\d+):(\d+)$/);
  if (pickMatch) {
    await handleTelegramQueueMenuPick(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      Number(pickMatch[1]),
      Number(pickMatch[2]),
      deps,
    );
    return true;
  }
  const prioMatch = data.match(/^queue:prio:(\d+):(\d+)$/);
  if (prioMatch) {
    await handleTelegramQueueMenuPriority(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      Number(prioMatch[1]),
      Number(prioMatch[2]),
      ctx,
      deps,
    );
    return true;
  }
  const cancelMatch = data.match(/^queue:cancel:(\d+):(\d+)$/);
  if (cancelMatch) {
    await handleTelegramQueueMenuCancel(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      Number(cancelMatch[1]),
      Number(cancelMatch[2]),
      ctx,
      deps,
    );
    return true;
  }
  return false;
}
function getTelegramQueueMenuListText(
  items: readonly TelegramQueueMenuItem[],
): string {
  if (items.length === 0) return "<b>Queue is empty.</b>";
  return "<b>Queue:</b>";
}
async function updateTelegramQueueMenuList<Context>(
  callbackQueryId: string,
  replyChatId: number,
  replyMessageId: number,
  deps: TelegramQueueMenuCallbackDeps<Context>,
  notice?: string,
): Promise<void> {
  const items = deps.getQueuedItems();
  await deps.updateQueueMessage(
    replyChatId,
    replyMessageId,
    getTelegramQueueMenuListText(items),
    buildTelegramQueueMenuReplyMarkup(items),
  );
  await deps.answerCallbackQuery(callbackQueryId, notice);
}
async function refreshStaleTelegramQueueMenuItem<Context>(
  callbackQueryId: string,
  replyChatId: number,
  replyMessageId: number,
  deps: TelegramQueueMenuCallbackDeps<Context>,
): Promise<void> {
  await updateTelegramQueueMenuList(
    callbackQueryId,
    replyChatId,
    replyMessageId,
    deps,
    "Item no longer in queue.",
  );
}
async function handleTelegramQueueMenuPick<Context>(
  callbackQueryId: string,
  replyChatId: number,
  replyMessageId: number,
  chatId: number,
  msgId: number,
  deps: TelegramQueueMenuCallbackDeps<Context>,
): Promise<void> {
  const item = deps.findItem(chatId, msgId);
  if (!item) {
    return refreshStaleTelegramQueueMenuItem(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      deps,
    );
  }
  await deps.updateQueueMessage(
    replyChatId,
    replyMessageId,
    getTelegramQueueMenuItemText(item),
    buildTelegramQueueItemSubmenuReplyMarkup(chatId, msgId, item.isPriority),
  );
  await deps.answerCallbackQuery(callbackQueryId);
}
async function handleTelegramQueueMenuPriority<Context>(
  callbackQueryId: string,
  replyChatId: number,
  replyMessageId: number,
  chatId: number,
  msgId: number,
  ctx: Context,
  deps: TelegramQueueMenuCallbackDeps<Context>,
): Promise<void> {
  const item = deps.findItem(chatId, msgId);
  if (!item) {
    return refreshStaleTelegramQueueMenuItem(
      callbackQueryId,
      replyChatId,
      replyMessageId,
      deps,
    );
  }
  deps.togglePriority(chatId, msgId);
  deps.updateStatus(ctx);
  const updated = deps.findItem(chatId, msgId);
  const newPriority = updated?.isPriority ?? !item.isPriority;
  await deps.updateQueueMessage(
    replyChatId,
    replyMessageId,
    getTelegramQueueMenuItemText(item),
    buildTelegramQueueItemSubmenuReplyMarkup(chatId, msgId, newPriority),
  );
  await deps.answerCallbackQuery(
    callbackQueryId,
    newPriority ? "Prioritized." : "Deprioritized.",
  );
}
async function handleTelegramQueueMenuCancel<Context>(
  callbackQueryId: string,
  replyChatId: number,
  replyMessageId: number,
  chatId: number,
  msgId: number,
  ctx: Context,
  deps: TelegramQueueMenuCallbackDeps<Context>,
): Promise<void> {
  const removed = deps.cancelItem(chatId, msgId, ctx);
  deps.updateStatus(ctx);
  await updateTelegramQueueMenuList(
    callbackQueryId,
    replyChatId,
    replyMessageId,
    deps,
    removed ? "Removed from queue." : "Item not found.",
  );
}

interface TelegramQueueMenuCallbackQuery {
  id: string;
  data?: string;
  message?: { chat?: { id?: number }; message_id?: number };
}
interface TelegramQueueMenuRuntime<Context> {
  openQueueMenu: (
    chatId: number,
    replyToMessageId: number,
    ctx: Context,
  ) => Promise<void>;
  handleCallbackQuery: (
    query: TelegramQueueMenuCallbackQuery,
    ctx: Context,
  ) => Promise<boolean>;
}
export function createTelegramQueueMenuRuntime<
  Context,
  TModel extends MenuModel = MenuModel,
>(deps: {
  telegramQueueStore: Queue.TelegramQueueStateStore<Context>;
  queueMutationRuntime: Queue.TelegramQueueMutationController<Context>;
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "html",
    replyMarkup: TelegramQueueMenuReplyMarkup,
  ) => Promise<number | undefined>;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "html",
    replyMarkup: TelegramQueueMenuReplyMarkup,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  getModelMenuState: (
    chatId: number,
    ctx: Context,
  ) => Promise<TelegramModelMenuState<TModel>>;
  getStoredModelMenuState: (
    messageId: number | undefined,
  ) => TelegramModelMenuState<TModel> | undefined;
  storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
  updateStatusMessage: (
    state: TelegramModelMenuState<TModel>,
    ctx: Context,
  ) => Promise<void>;
  updateStatus: (ctx: Context) => void;
}): TelegramQueueMenuRuntime<Context> {
  const sendQueueMenuMessage = createQueueMenuSendMessageAdapter(
    deps.sendInteractiveMessage,
  );
  const editQueueMenuMessage = createQueueMenuEditMessageAdapter(
    deps.editInteractiveMessage,
  );
  return {
    openQueueMenu: createOpenQueueMenu<Context, TModel>({
      getQueuedItems: deps.telegramQueueStore.getQueuedItems,
      getModelMenuState: deps.getModelMenuState,
      storeModelMenuState: deps.storeModelMenuState,
      sendInteractiveMessage: sendQueueMenuMessage,
    }),
    handleCallbackQuery: createQueueMenuCallbackHandler<Context, TModel>({
      telegramQueueStore: deps.telegramQueueStore,
      queueMutationRuntime: deps.queueMutationRuntime,
      editInteractiveMessage: editQueueMenuMessage,
      getStoredModelMenuState: deps.getStoredModelMenuState,
      updateStatusMessage: deps.updateStatusMessage,
      answerCallbackQuery: deps.answerCallbackQuery,
      updateStatus: deps.updateStatus,
    }),
  };
}
function createOpenQueueMenu<
  Context,
  TModel extends MenuModel = MenuModel,
>(deps: {
  getQueuedItems: () => Queue.TelegramQueueItem<Context>[];
  getModelMenuState: (
    chatId: number,
    ctx: Context,
  ) => Promise<TelegramModelMenuState<TModel>>;
  storeModelMenuState: (state: TelegramModelMenuState<TModel>) => void;
  sendInteractiveMessage: (
    chatId: number,
    replyToMessageId: number,
    text: string,
    replyMarkup: TelegramQueueMenuReplyMarkup,
  ) => Promise<number | undefined>;
}) {
  return async function openQueueMenu(
    chatId: number,
    replyToMessageId: number,
    ctx: Context,
  ): Promise<void> {
    const state = await deps.getModelMenuState(chatId, ctx);
    const menuItems = toTelegramQueueMenuItems(deps.getQueuedItems());
    const text = getTelegramQueueMenuListText(menuItems);
    const messageId = await deps.sendInteractiveMessage(
      chatId,
      replyToMessageId,
      text,
      buildTelegramQueueMenuReplyMarkup(menuItems),
    );
    if (messageId === undefined) return;
    state.messageId = messageId;
    state.mode = "queue";
    deps.storeModelMenuState(state);
  };
}
function createQueueMenuCallbackHandler<
  Context,
  TModel extends MenuModel = MenuModel,
>(deps: {
  telegramQueueStore: Queue.TelegramQueueStateStore<Context>;
  queueMutationRuntime: Queue.TelegramQueueMutationController<Context>;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup: TelegramQueueMenuReplyMarkup,
  ) => Promise<number | undefined>;
  getStoredModelMenuState: (
    messageId: number | undefined,
  ) => TelegramModelMenuState<TModel> | undefined;
  updateStatusMessage: (
    state: TelegramModelMenuState<TModel>,
    ctx: Context,
  ) => Promise<void>;
  answerCallbackQuery: (
    callbackQueryId: string,
    text?: string,
  ) => Promise<void>;
  updateStatus: (ctx: Context) => void;
}) {
  return async function queueMenuCallbackHandler(
    query: TelegramQueueMenuCallbackQuery,
    ctx: Context,
  ): Promise<boolean> {
    const data = query.data;
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (!data || typeof chatId !== "number" || typeof messageId !== "number")
      return false;
    if (data === "status:queue") {
      const state = deps.getStoredModelMenuState(messageId);
      if (!state) {
        await deps.answerCallbackQuery(
          query.id,
          "Interactive message expired.",
        );
        return true;
      }
      const menuItems = toTelegramQueueMenuItems(
        deps.telegramQueueStore.getQueuedItems(),
      );
      await deps.editInteractiveMessage(
        chatId,
        messageId,
        getTelegramQueueMenuListText(menuItems),
        buildTelegramQueueMenuReplyMarkup(menuItems),
      );
      state.mode = "queue";
      await deps.answerCallbackQuery(query.id);
      return true;
    }
    if (!data.startsWith("queue:")) return false;
    const getQueueSnapshot = function getQueueSnapshot() {
      return deps.telegramQueueStore.getQueuedItems();
    };
    const toMenuItems = function toMenuItems() {
      return toTelegramQueueMenuItems(getQueueSnapshot());
    };
    const findItem = function findItem(cId: number, rId: number) {
      return findTelegramQueueMenuItem(toMenuItems(), cId, rId);
    };
    return handleTelegramQueueMenuCallback(
      query.id,
      data,
      chatId,
      messageId,
      ctx,
      {
        getQueuedItems: toMenuItems,
        findItem,
        togglePriority: function togglePriority(cId, rId) {
          return toggleQueuedTelegramPromptPriority(cId, rId, ctx, {
            getQueueSnapshot,
            queueMutationRuntime: deps.queueMutationRuntime,
          });
        },
        cancelItem: function cancelItem(cId, rId, c) {
          return cancelQueuedTelegramItem(cId, rId, c, {
            getQueueSnapshot,
            queueMutationRuntime: deps.queueMutationRuntime,
          });
        },
        updateQueueMessage: deps.editInteractiveMessage,
        answerCallbackQuery: deps.answerCallbackQuery,
        updateStatus: deps.updateStatus,
      },
    );
  };
}
function toggleQueuedTelegramPromptPriority<Context>(
  chatId: number,
  replyToMessageId: number,
  ctx: Context,
  deps: {
    getQueueSnapshot: () => Queue.TelegramQueueItem<Context>[];
    queueMutationRuntime: Queue.TelegramQueueMutationController<Context>;
  },
): boolean {
  const item = findTelegramQueueItem(
    deps.getQueueSnapshot(),
    chatId,
    replyToMessageId,
  );
  if (!item) return false;
  if (item.queueLane === "priority") {
    deps.queueMutationRuntime.clearPriorityByMessageId(replyToMessageId, ctx);
  } else {
    deps.queueMutationRuntime.prioritizeByMessageId(replyToMessageId, ctx);
  }
  return true;
}
function cancelQueuedTelegramItem<Context>(
  chatId: number,
  replyToMessageId: number,
  ctx: Context,
  deps: {
    getQueueSnapshot: () => Queue.TelegramQueueItem<Context>[];
    queueMutationRuntime: Queue.TelegramQueueMutationController<Context>;
  },
): boolean {
  const item = findTelegramQueueItem(
    deps.getQueueSnapshot(),
    chatId,
    replyToMessageId,
  );
  if (!item) return false;
  return (
    deps.queueMutationRuntime.removeByMessageIds([item.replyToMessageId], ctx) >
    0
  );
}
function createQueueMenuSendMessageAdapter(
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "html",
    replyMarkup: TelegramQueueMenuReplyMarkup,
  ) => Promise<number | undefined>,
) {
  return function queueMenuSendMessage(
    chatId: number,
    _replyToMessageId: number,
    text: string,
    replyMarkup: TelegramQueueMenuReplyMarkup,
  ): Promise<number | undefined> {
    return sendInteractiveMessage(chatId, text, "html", replyMarkup);
  };
}
function createQueueMenuEditMessageAdapter(
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "html",
    replyMarkup: TelegramQueueMenuReplyMarkup,
  ) => Promise<void>,
) {
  return function queueMenuEditMessage(
    chatId: number,
    messageId: number,
    text: string,
    replyMarkup: TelegramQueueMenuReplyMarkup,
  ): Promise<number | undefined> {
    return editInteractiveMessage(
      chatId,
      messageId,
      text,
      "html",
      replyMarkup,
    ).then(function () {
      return undefined as number | undefined;
    });
  };
}
