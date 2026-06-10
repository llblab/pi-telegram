/**
 * Regression tests for the Telegram updates domain
 * Covers extraction, authorization, flow classification, execution planning, and runtime execution in one suite
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramUpdateExecutionPlan,
  buildTelegramUpdateExecutionPlanFromUpdate,
  buildTelegramUpdateFlowAction,
  collectTelegramReactionEmojis,
  createTelegramPairedUpdateRuntime,
  createTelegramUpdateRuntime,
  executeTelegramUpdate,
  executeTelegramUpdatePlan,
  extractDeletedTelegramMessageIds,
  getAuthorizedTelegramCallbackQuery,
  getAuthorizedTelegramEditedMessage,
  getAuthorizedTelegramGuestMessage,
  getAuthorizedTelegramMessage,
  handleAuthorizedTelegramReactionUpdate,
  normalizeTelegramReactionEmoji,
  TELEGRAM_PRIORITY_REACTION_EMOJIS,
  TELEGRAM_PRIORITY_REACTIONS,
  TELEGRAM_REMOVAL_REACTION_EMOJIS,
  TELEGRAM_REMOVAL_REACTIONS,
} from "../lib/updates.ts";

const TEST_CONTEXT = "ctx";

test("Update helpers normalize emoji reactions and collect emoji-only entries", () => {
  assert.equal(normalizeTelegramReactionEmoji("👍️"), "👍");
  const emojis = collectTelegramReactionEmojis([
    { type: "emoji", emoji: "👍️" },
    { type: "emoji", emoji: "👎" },
    { type: "custom_emoji" },
  ]);
  assert.deepEqual([...emojis], ["👍", "👎"]);
  assert.deepEqual(
    TELEGRAM_PRIORITY_REACTIONS.map((reaction) => [
      reaction.id,
      reaction.name,
      reaction.emoji,
    ]),
    [
      [10, "like", "👍"],
      [11, "lightning", "⚡"],
      [12, "heart", "❤"],
      [13, "dove", "🕊"],
      [14, "fire", "🔥"],
    ],
  );
  assert.deepEqual(
    TELEGRAM_REMOVAL_REACTIONS.map((reaction) => reaction.id),
    [20, 21, 22, 23, 24],
  );
  assert.deepEqual(TELEGRAM_PRIORITY_REACTION_EMOJIS, [
    "👍",
    "⚡",
    "❤",
    "🕊",
    "🔥",
  ]);
  assert.deepEqual(TELEGRAM_REMOVAL_REACTION_EMOJIS, [
    "👎",
    "👻",
    "💔",
    "💩",
    "🗑",
  ]);
});

test("Update helpers extract deleted business-message ids only from Bot API shapes", () => {
  assert.deepEqual(
    extractDeletedTelegramMessageIds({
      deleted_business_messages: { message_ids: [1, 2] },
    }),
    [1, 2],
  );
  assert.deepEqual(
    extractDeletedTelegramMessageIds({
      deleted_business_messages: { message_ids: [3, "bad"] },
    }),
    [],
  );
  assert.deepEqual(extractDeletedTelegramMessageIds({}), []);
});

test("Paired update runtime binds pairing ports into update routing", async () => {
  const events: string[] = [];
  let allowedUserId: number | undefined;
  const runtime = createTelegramPairedUpdateRuntime({
    getAllowedUserId: () => allowedUserId,
    setAllowedUserId: (userId) => {
      allowedUserId = userId;
      events.push(`set:${userId}`);
    },
    persistConfig: async () => {
      events.push("persist");
    },
    updateStatus: (ctx: string) => {
      events.push(`status:${ctx}`);
    },
    removePendingMediaGroupMessages: () => {},
    removeQueuedTelegramTurnsByMessageIds: () => 0,
    clearQueuedTelegramTurnPriorityByMessageId: () => false,
    prioritizeQueuedTelegramTurnByMessageId: () => false,
    answerCallbackQuery: async () => {},
    answerGuestQuery: async () => {},
    handleAuthorizedTelegramCallbackQuery: async () => {},
    sendTextReply: async () => undefined,
    handleAuthorizedTelegramMessage: async (message, ctx: string) => {
      events.push(`message:${ctx}:${message.message_id ?? "none"}`);
    },
    handleAuthorizedTelegramEditedMessage: () => {},
  });
  await runtime.handleUpdate(
    {
      message: {
        chat: { id: 1, type: "private" },
        from: { id: 42, is_bot: false },
        message_id: 10,
      },
    },
    "ctx",
  );
  assert.deepEqual(events, [
    "set:42",
    "persist",
    "status:ctx",
    "message:ctx:10",
  ]);
});

test("Update routing extracts only private human callback queries", () => {
  assert.equal(
    getAuthorizedTelegramCallbackQuery({
      callback_query: {
        from: { id: 1, is_bot: true },
        message: { chat: { type: "private" } },
      },
    }),
    undefined,
  );
  const query = getAuthorizedTelegramCallbackQuery({
    callback_query: {
      from: { id: 1, is_bot: false },
      message: { chat: { type: "private" } },
    },
  });
  assert.ok(query);
});

test("Update routing extracts private human messages and edited messages separately", () => {
  assert.equal(
    getAuthorizedTelegramMessage({
      message: {
        chat: { type: "group" },
        from: { id: 1, is_bot: false },
      },
    }),
    undefined,
  );
  const directMessage = getAuthorizedTelegramMessage({
    message: {
      chat: { type: "private" },
      from: { id: 1, is_bot: false },
    },
  });
  assert.ok(directMessage);
  const editedMessage = getAuthorizedTelegramEditedMessage({
    edited_message: {
      chat: { type: "private" },
      from: { id: 1, is_bot: false },
    },
  });
  assert.ok(editedMessage);
});

test("Update routing extracts guest messages without private chat filter", () => {
  assert.equal(
    getAuthorizedTelegramGuestMessage({
      guest_message: {
        guest_query_id: "gq-1",
        chat: { type: "supergroup" },
        from: { id: 1, is_bot: true },
      },
    }),
    undefined,
  );
  const guestMessage = getAuthorizedTelegramGuestMessage({
    guest_message: {
      guest_query_id: "gq-1",
      chat: { type: "supergroup" },
      from: { id: 1, is_bot: false },
    },
  });
  assert.ok(guestMessage);
  assert.equal(guestMessage.guest_query_id, "gq-1");
});

test("Update flow prioritizes deleted business-message handling over other update kinds", () => {
  const action = buildTelegramUpdateFlowAction(
    {
      deleted_business_messages: { message_ids: [1, 2] },
      message_reaction: {
        chat: { type: "private" },
        user: { id: 1, is_bot: false },
        message_id: 1,
        old_reaction: [],
        new_reaction: [],
      },
    },
    1,
  );
  assert.deepEqual(action, { kind: "deleted", messageIds: [1, 2] });
});

test("Update flow returns authorized callback, message, and edit actions", () => {
  const callbackAction = buildTelegramUpdateFlowAction(
    {
      callback_query: {
        from: { id: 7, is_bot: false },
        message: { chat: { type: "private" } },
      },
    },
    7,
  );
  assert.equal(callbackAction.kind, "callback");
  assert.deepEqual(
    callbackAction.kind === "callback"
      ? callbackAction.authorization
      : undefined,
    { kind: "allow" },
  );
  const messageAction = buildTelegramUpdateFlowAction({
    message: {
      chat: { type: "private" },
      from: { id: 9, is_bot: false },
    },
  });
  assert.equal(messageAction.kind, "message");
  assert.deepEqual(
    messageAction.kind === "message" ? messageAction.authorization : undefined,
    { kind: "pair", userId: 9 },
  );
  const editAction = buildTelegramUpdateFlowAction(
    {
      edited_message: {
        chat: { type: "private" },
        from: { id: 9, is_bot: false },
      },
    },
    9,
  );
  assert.equal(editAction.kind, "edited-message");
});

test("Update flow classifies guest messages with authorization", () => {
  const guestAction = buildTelegramUpdateFlowAction(
    {
      guest_message: {
        guest_query_id: "gq-1",
        chat: { type: "supergroup" },
        from: { id: 5, is_bot: false },
      },
    },
    5,
  );
  assert.equal(guestAction.kind, "guest");
  assert.deepEqual(
    guestAction.kind === "guest" ? guestAction.authorization : undefined,
    { kind: "allow" },
  );
  const guestDeny = buildTelegramUpdateFlowAction(
    {
      guest_message: {
        guest_query_id: "gq-2",
        chat: { type: "supergroup" },
        from: { id: 6, is_bot: false },
      },
    },
    5,
  );
  assert.equal(guestDeny.kind, "guest");
  assert.deepEqual(
    guestDeny.kind === "guest" ? guestDeny.authorization : undefined,
    { kind: "deny" },
  );
});

test("Update flow ignores unauthorized transport shapes and preserves reaction events", () => {
  const reactionAction = buildTelegramUpdateFlowAction({
    message_reaction: {
      chat: { type: "private" },
      user: { id: 1, is_bot: false },
      message_id: 1,
      old_reaction: [],
      new_reaction: [],
    },
  });
  assert.equal(reactionAction.kind, "reaction");
  const ignored = buildTelegramUpdateFlowAction({
    callback_query: {
      from: { id: 1, is_bot: true },
      message: { chat: { type: "private" } },
    },
  });
  assert.deepEqual(ignored, { kind: "ignore" });
});

test("Update execution plan maps callback and message authorization to side-effect flags", () => {
  const callbackPlan = buildTelegramUpdateExecutionPlan({
    kind: "callback",
    query: {
      from: { id: 1, is_bot: false },
      message: { chat: { type: "private" } },
    },
    authorization: { kind: "deny" },
  });
  assert.deepEqual(callbackPlan, {
    kind: "callback",
    query: {
      from: { id: 1, is_bot: false },
      message: { chat: { type: "private" } },
    },
    shouldPair: false,
    shouldDeny: true,
  });
  const messagePlan = buildTelegramUpdateExecutionPlan({
    kind: "message",
    message: {
      chat: { type: "private" },
      from: { id: 2, is_bot: false },
    },
    authorization: { kind: "pair", userId: 2 },
  });
  assert.equal(messagePlan.kind, "message");
  assert.equal(messagePlan.shouldPair, true);
  assert.equal(messagePlan.shouldNotifyPaired, true);
  assert.equal(messagePlan.shouldDeny, false);
});

test("Update execution plan preserves deleted and reaction actions", () => {
  assert.deepEqual(
    buildTelegramUpdateExecutionPlan({ kind: "deleted", messageIds: [1, 2] }),
    { kind: "deleted", messageIds: [1, 2] },
  );
  const reactionUpdate = {
    chat: { type: "private" },
    user: { id: 1, is_bot: false },
    message_id: 1,
    old_reaction: [],
    new_reaction: [],
  };
  assert.deepEqual(
    buildTelegramUpdateExecutionPlan({
      kind: "reaction",
      reactionUpdate,
    }),
    { kind: "reaction", reactionUpdate },
  );
});

test("Update execution plan maps guest authorization to deny flag", () => {
  const guestMessage = {
    guest_query_id: "gq-1",
    chat: { type: "supergroup" },
    from: { id: 1, is_bot: false },
  };
  const guestPlan = buildTelegramUpdateExecutionPlan({
    kind: "guest",
    guestMessage,
    authorization: { kind: "allow" },
  });
  assert.deepEqual(guestPlan, {
    kind: "guest",
    guestMessage,
    shouldDeny: false,
  });
  const unpairedGuestPlan = buildTelegramUpdateExecutionPlan({
    kind: "guest",
    guestMessage,
    authorization: { kind: "pair", userId: 1 },
  });
  assert.deepEqual(unpairedGuestPlan, {
    kind: "guest",
    guestMessage,
    shouldDeny: true,
  });
});

test("Update execution plan can be built directly from updates", () => {
  const plan = buildTelegramUpdateExecutionPlanFromUpdate(
    {
      callback_query: {
        from: { id: 4, is_bot: false },
        message: { chat: { type: "private" } },
      },
    },
    5,
  );
  assert.equal(plan.kind, "callback");
  assert.equal(plan.kind === "callback" ? plan.shouldDeny : false, true);
});

test("Update runtime controller binds update and reaction ports", async () => {
  const events: string[] = [];
  const runtime = createTelegramUpdateRuntime({
    getAllowedUserId: () => 42,
    removePendingMediaGroupMessages: (messageIds) => {
      events.push(`media:${messageIds.join(",")}`);
    },
    removeQueuedTelegramTurnsByMessageIds: (messageIds, ctx: string) => {
      events.push(`remove:${ctx}:${messageIds.join(",")}`);
      return messageIds.length;
    },
    clearQueuedTelegramTurnPriorityByMessageId: (messageId, ctx: string) => {
      events.push(`clear:${ctx}:${messageId}`);
      return true;
    },
    prioritizeQueuedTelegramTurnByMessageId: (messageId, ctx: string) => {
      events.push(`priority:${ctx}:${messageId}`);
      return true;
    },
    pairTelegramUserIfNeeded: async (userId, ctx: string) => {
      events.push(`pair:${ctx}:${userId}`);
      return true;
    },
    answerCallbackQuery: async (id, text) => {
      events.push(`answer:${id}:${text ?? ""}`);
    },
    answerGuestQuery: async (id, text) => {
      events.push(`guest-answer:${id}:${text ?? ""}`);
    },
    handleAuthorizedTelegramCallbackQuery: async () => {
      events.push("callback");
    },
    sendTextReply: async (chatId, replyToMessageId, text) => {
      events.push(`reply:${chatId}:${replyToMessageId}:${text}`);
      return 1;
    },
    handleAuthorizedTelegramMessage: async (message, ctx: string) => {
      events.push(`message:${ctx}:${message.message_id ?? "none"}`);
    },
    handleAuthorizedTelegramEditedMessage: async (message, ctx: string) => {
      events.push(`edit:${ctx}:${message.message_id ?? "none"}`);
    },
  });
  await runtime.handleAuthorizedReactionUpdate(
    {
      chat: { type: "private" },
      message_id: 9,
      user: { id: 42, is_bot: false },
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👍" }],
    },
    "ctx",
  );
  await runtime.handleUpdate(
    {
      message: {
        chat: { id: 1, type: "private" },
        from: { id: 42, is_bot: false },
        message_id: 10,
      },
    },
    "ctx",
  );
  assert.deepEqual(events, ["priority:ctx:9", "message:ctx:10"]);
});

test("Update runtime routes guest messages through guest handler", async () => {
  const events: string[] = [];
  const runtime = createTelegramUpdateRuntime({
    getAllowedUserId: () => 42,
    removePendingMediaGroupMessages: () => {},
    removeQueuedTelegramTurnsByMessageIds: () => 0,
    clearQueuedTelegramTurnPriorityByMessageId: () => true,
    prioritizeQueuedTelegramTurnByMessageId: () => true,
    pairTelegramUserIfNeeded: async () => false,
    answerCallbackQuery: async () => {},
    answerGuestQuery: async () => {},
    handleAuthorizedTelegramCallbackQuery: async () => {},
    sendTextReply: async () => 1,
    handleAuthorizedTelegramMessage: async () => {},
    handleAuthorizedTelegramEditedMessage: async () => {},
    handleAuthorizedTelegramGuestMessage: async (
      guestMessage,
      _ctx: string,
    ) => {
      events.push(`guest:${guestMessage.guest_query_id}`);
    },
  });
  await runtime.handleUpdate(
    {
      guest_message: {
        guest_query_id: "gq-1",
        chat: { type: "supergroup" },
        from: { id: 42, is_bot: false },
      },
    },
    "ctx",
  );
  assert.deepEqual(events, ["guest:gq-1"]);
});

test("Update runtime denies guest messages before pairing", async () => {
  const events: string[] = [];
  const runtime = createTelegramUpdateRuntime({
    getAllowedUserId: () => undefined,
    removePendingMediaGroupMessages: () => {},
    removeQueuedTelegramTurnsByMessageIds: () => 0,
    clearQueuedTelegramTurnPriorityByMessageId: () => true,
    prioritizeQueuedTelegramTurnByMessageId: () => true,
    pairTelegramUserIfNeeded: async () => false,
    answerCallbackQuery: async () => {},
    answerGuestQuery: async (id, text) => {
      events.push(`guest-deny:${id}:${text ?? ""}`);
    },
    handleAuthorizedTelegramCallbackQuery: async () => {},
    sendTextReply: async () => 1,
    handleAuthorizedTelegramMessage: async () => {},
    handleAuthorizedTelegramEditedMessage: async () => {},
    handleAuthorizedTelegramGuestMessage: async () => {
      events.push("guest-handled");
    },
  });
  await runtime.handleUpdate(
    {
      guest_message: {
        guest_query_id: "gq-unpaired",
        chat: { type: "supergroup" },
        from: { id: 42, is_bot: false },
      },
    },
    "ctx",
  );
  assert.deepEqual(events, ["guest-deny:gq-unpaired:Access denied."]);
});

test("Update runtime answers guest query with access denied for unauthorized users", async () => {
  const events: string[] = [];
  const runtime = createTelegramUpdateRuntime({
    getAllowedUserId: () => 42,
    removePendingMediaGroupMessages: () => {},
    removeQueuedTelegramTurnsByMessageIds: () => 0,
    clearQueuedTelegramTurnPriorityByMessageId: () => true,
    prioritizeQueuedTelegramTurnByMessageId: () => true,
    pairTelegramUserIfNeeded: async () => false,
    answerCallbackQuery: async () => {},
    answerGuestQuery: async (id, text) => {
      events.push(`guest-deny:${id}:${text ?? ""}`);
    },
    handleAuthorizedTelegramCallbackQuery: async () => {},
    sendTextReply: async () => 1,
    handleAuthorizedTelegramMessage: async () => {},
    handleAuthorizedTelegramEditedMessage: async () => {},
    handleAuthorizedTelegramGuestMessage: async () => {
      events.push("guest-handled");
    },
  });
  await runtime.handleUpdate(
    {
      guest_message: {
        guest_query_id: "gq-deny",
        chat: { type: "supergroup" },
        from: { id: 99, is_bot: false },
      },
    },
    "ctx",
  );
  assert.deepEqual(events, ["guest-deny:gq-deny:Access denied."]);
});

test("Update runtime handles authorized reaction priority and removal effects", async () => {
  const events: string[] = [];
  const deps = {
    allowedUserId: 7,
    ctx: TEST_CONTEXT,
    removePendingMediaGroupMessages: (ids: number[]) => {
      events.push(`media:${ids.join(",")}`);
    },
    removeQueuedTelegramTurnsByMessageIds: (ids: number[]) => {
      events.push(`remove:${ids.join(",")}`);
      return ids.length;
    },
    clearQueuedTelegramTurnPriorityByMessageId: (id: number) => {
      events.push(`clear:${id}`);
      return true;
    },
    prioritizeQueuedTelegramTurnByMessageId: (
      id: number,
      _ctx: string,
      emoji?: string,
    ) => {
      events.push(`prioritize:${id}:${emoji}`);
      return true;
    },
  };
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 10,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👍️" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 11,
      old_reaction: [{ type: "emoji", emoji: "👍" }],
      new_reaction: [],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 12,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👎" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 13,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "⚡" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 14,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "❤️" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 15,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "🕊️" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 16,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "🔥" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 17,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "👻" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 18,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "💔" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 19,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "💩" }],
    },
    deps,
  );
  await handleAuthorizedTelegramReactionUpdate(
    {
      chat: { type: "private" },
      user: { id: 7, is_bot: false },
      message_id: 20,
      old_reaction: [],
      new_reaction: [{ type: "emoji", emoji: "🗑️" }],
    },
    deps,
  );
  assert.deepEqual(events, [
    "prioritize:10:👍",
    "clear:11",
    "media:12",
    "remove:12",
    "prioritize:13:⚡",
    "prioritize:14:❤",
    "prioritize:15:🕊",
    "prioritize:16:🔥",
    "media:17",
    "remove:17",
    "media:18",
    "remove:18",
    "media:19",
    "remove:19",
    "media:20",
    "remove:20",
  ]);
});

test("Update runtime executes delete and reaction plans through the right side effects", async () => {
  const events: string[] = [];
  await executeTelegramUpdatePlan(
    { kind: "deleted", messageIds: [1, 2] },
    {
      ctx: TEST_CONTEXT,
      removePendingMediaGroupMessages: (ids) => {
        events.push(`media:${ids.join(",")}`);
      },
      removeQueuedTelegramTurnsByMessageIds: (ids) => {
        events.push(`queue:${ids.join(",")}`);
        return ids.length;
      },
      handleAuthorizedTelegramReactionUpdate: async () => {
        events.push("reaction");
      },
      pairTelegramUserIfNeeded: async () => false,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {},
      handleAuthorizedTelegramEditedMessage: async () => {},
    },
  );
  assert.deepEqual(events, ["media:1,2", "queue:1,2"]);
});

test("Update runtime can execute directly from raw updates", async () => {
  const events: string[] = [];
  await executeTelegramUpdate(
    {
      message: {
        chat: { id: 10, type: "private" },
        message_id: 20,
        from: { id: 7, is_bot: false },
      },
    },
    undefined,
    {
      ctx: TEST_CONTEXT,
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => {
        events.push("pair");
        return true;
      },
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async (_chatId, _replyToMessageId, text) => {
        events.push(`reply:${text}`);
        return undefined;
      },
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
      handleAuthorizedTelegramEditedMessage: async () => {
        events.push("edited-message");
      },
    },
  );
  assert.deepEqual(events, [
    "pair",
    "reply:Telegram bridge paired with this account.",
    "message",
  ]);
});

test("Update runtime swallows only stale context execution errors", async () => {
  const baseDeps = {
    ctx: TEST_CONTEXT,
    removePendingMediaGroupMessages: () => {},
    removeQueuedTelegramTurnsByMessageIds: () => 0,
    handleAuthorizedTelegramReactionUpdate: async () => {},
    pairTelegramUserIfNeeded: async () => false,
    answerCallbackQuery: async () => {},
    answerGuestQuery: async () => {},
    handleAuthorizedTelegramCallbackQuery: async () => {},
    sendTextReply: async () => undefined,
    handleAuthorizedTelegramEditedMessage: async () => {},
  };
  const plan = {
    kind: "message" as const,
    message: {
      chat: { id: 10, type: "private" as const },
      message_id: 20,
      from: { id: 7, is_bot: false },
    },
    shouldPair: false,
    shouldNotifyPaired: false,
    shouldDeny: false,
  };
  await assert.doesNotReject(() =>
    executeTelegramUpdatePlan(plan, {
      ...baseDeps,
      handleAuthorizedTelegramMessage: async () => {
        throw new Error("ctx is stale after session reload");
      },
    }),
  );
  await assert.rejects(
    () =>
      executeTelegramUpdatePlan(plan, {
        ...baseDeps,
        handleAuthorizedTelegramMessage: async () => {
          throw new Error("message handler broke");
        },
      }),
    /message handler broke/,
  );
});

test("Update runtime routes edited messages without creating normal message turns", async () => {
  const events: string[] = [];
  await executeTelegramUpdate(
    {
      edited_message: {
        chat: { id: 10, type: "private" },
        message_id: 20,
        from: { id: 7, is_bot: false },
      },
    },
    7,
    {
      ctx: TEST_CONTEXT,
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => false,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async () => undefined,
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
      handleAuthorizedTelegramEditedMessage: async () => {
        events.push("edited-message");
      },
    },
  );
  assert.deepEqual(events, ["edited-message"]);
});

test("Update runtime handles callback deny and message pair flows", async () => {
  const events: string[] = [];
  await executeTelegramUpdatePlan(
    {
      kind: "callback",
      query: {
        id: "cb",
        from: { id: 1, is_bot: false },
        message: { chat: { type: "private" } },
      },
      shouldPair: true,
      shouldDeny: true,
    },
    {
      ctx: TEST_CONTEXT,
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async (userId) => {
        events.push(`pair:${userId}`);
        return true;
      },
      answerCallbackQuery: async (id, text) => {
        events.push(`answer:${id}:${text}`);
      },
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {
        events.push("callback");
      },
      sendTextReply: async (chatId, replyToMessageId, text) => {
        events.push(`reply:${chatId}:${replyToMessageId}:${text}`);
        return undefined;
      },
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
      handleAuthorizedTelegramEditedMessage: async () => {
        events.push("edited-message");
      },
    },
  );
  await executeTelegramUpdatePlan(
    {
      kind: "message",
      message: {
        chat: { id: 7, type: "private" },
        from: { id: 2, is_bot: false },
        message_id: 9,
      },
      shouldPair: true,
      shouldNotifyPaired: true,
      shouldDeny: false,
    },
    {
      ctx: TEST_CONTEXT,
      removePendingMediaGroupMessages: () => {},
      removeQueuedTelegramTurnsByMessageIds: () => 0,
      handleAuthorizedTelegramReactionUpdate: async () => {},
      pairTelegramUserIfNeeded: async () => true,
      answerCallbackQuery: async () => {},
      answerGuestQuery: async () => {},
      handleAuthorizedTelegramCallbackQuery: async () => {},
      sendTextReply: async (chatId, replyToMessageId, text) => {
        events.push(`reply:${chatId}:${replyToMessageId}:${text}`);
        return undefined;
      },
      handleAuthorizedTelegramMessage: async () => {
        events.push("message");
      },
      handleAuthorizedTelegramEditedMessage: async () => {
        events.push("edited-message");
      },
    },
  );
  assert.deepEqual(events, [
    "pair:1",
    "answer:cb:This bot is not authorized for your account.",
    "reply:7:9:Telegram bridge paired with this account.",
    "message",
  ]);
});
