/**
 * Regression tests for the Telegram preview domain
 * Covers preview snapshot decisions, transport selection, runtime flushing, and finalization behavior
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramPreviewFlushText,
  buildTelegramPreviewSnapshot,
  renderTelegramMessage,
  type TelegramRenderedChunk,
  type TelegramRenderMode,
} from "../lib/rendering.ts";
import {
  allocateTelegramDraftId,
  buildTelegramPreviewFinalText,
  clearTelegramPreview,
  createTelegramAssistantMessagePreviewHooks,
  createTelegramAssistantPreviewRuntime,
  createTelegramPreviewController,
  createTelegramPreviewControllerRuntime,
  createTelegramPreviewMessageTransport,
  createTelegramPreviewRenderedChunkTransport,
  createTelegramPreviewRuntimeState,
  finalizeTelegramMarkdownPreview,
  finalizeTelegramPreview,
  flushTelegramPreview,
  handleTelegramAssistantMessagePreviewStart,
  handleTelegramAssistantMessagePreviewUpdate,
  shouldUseTelegramDraftPreview,
} from "../lib/preview.ts";

function createPreviewRuntimeHarness(state?: {
  mode: "draft" | "message";
  draftId?: number;
  messageId?: number;
  pendingText: string;
  lastSentText: string;
  lastSentParseMode?: "HTML";
  lastSentStrategy?: "plain" | "rich-stable-blocks";
  flushTimer?: ReturnType<typeof setTimeout>;
}) {
  let previewState = state;
  let draftSupport: "unknown" | "supported" | "unsupported" = "unknown";
  let nextDraftId = 10;
  const events: string[] = [];
  return {
    events,
    getState: () => previewState,
    getDraftSupport: () => draftSupport,
    setDraftSupport: (support: "unknown" | "supported" | "unsupported") => {
      draftSupport = support;
    },
    deps: {
      getState: () => previewState,
      setState: (nextState: typeof previewState) => {
        previewState = nextState;
      },
      clearScheduledFlush: (nextState: NonNullable<typeof previewState>) => {
        if (!nextState.flushTimer) return;
        clearTimeout(nextState.flushTimer);
        nextState.flushTimer = undefined;
        events.push("clear-timer");
      },
      maxMessageLength: 50,
      renderPreviewText: (markdown: string) => markdown.replaceAll("*", ""),
      getDraftSupport: () => draftSupport,
      setDraftSupport: (support: "unknown" | "supported" | "unsupported") => {
        draftSupport = support;
      },
      allocateDraftId: () => nextDraftId++,
      sendDraft: async (chatId: number, draftId: number, text?: string) => {
        events.push(`draft:${chatId}:${draftId}:${text}`);
      },
      sendMessage: async (
        chatId: number,
        text: string,
        options?: { parseMode?: "HTML" },
      ) => {
        events.push(`send:${chatId}:${text}:${options?.parseMode ?? "plain"}`);
        return { message_id: 77 };
      },
      editMessageText: async (
        chatId: number,
        messageId: number,
        text: string,
        options?: { parseMode?: "HTML" },
      ) => {
        events.push(
          `edit:${chatId}:${messageId}:${text}:${options?.parseMode ?? "plain"}`,
        );
      },
      renderTelegramMessage: (
        text: string,
        options?: { mode?: TelegramRenderMode },
      ): TelegramRenderedChunk[] =>
        options?.mode === "markdown"
          ? [{ text: `markdown:${text}`, parseMode: "HTML" as const }]
          : [{ text: `${options?.mode ?? "plain"}:${text}` }],
      sendRenderedChunks: async (
        chatId: number,
        chunks: Array<{ text: string }>,
      ) => {
        events.push(
          `render-send:${chatId}:${chunks.map((chunk) => chunk.text).join("|")}`,
        );
        return 88;
      },
      editRenderedMessage: async (
        chatId: number,
        messageId: number,
        chunks: Array<{ text: string }>,
      ) => {
        events.push(
          `render-edit:${chatId}:${messageId}:${chunks.map((chunk) => chunk.text).join("|")}`,
        );
        return messageId;
      },
      canSend: undefined as undefined | (() => boolean),
      recordRuntimeEvent: (
        category: string,
        _error: unknown,
        details?: Record<string, unknown>,
      ) => {
        events.push(`${category}:${details?.phase}`);
      },
    },
  };
}

test("Preview helpers build flush text only when the preview changed", () => {
  assert.equal(
    buildTelegramPreviewFlushText({
      state: {
        pendingText: "**hello**",
        lastSentText: "",
      },
      maxMessageLength: 4096,
      renderPreviewText: (markdown) => markdown.replaceAll("*", ""),
    }),
    "hello",
  );
  assert.equal(
    buildTelegramPreviewFlushText({
      state: {
        pendingText: "**hello**",
        lastSentText: "hello",
      },
      maxMessageLength: 4096,
      renderPreviewText: (markdown) => markdown.replaceAll("*", ""),
    }),
    undefined,
  );
});

test("Preview snapshots prefer stable rich blocks and fall back to plain text", () => {
  const richSnapshot = buildTelegramPreviewSnapshot({
    state: {
      pendingText: "```ts\nconst value = 1\n```",
      lastSentText: "",
    },
    maxMessageLength: 100,
    renderPreviewText: (markdown) => markdown.replaceAll("*", ""),
    renderTelegramMessage: (text, options) =>
      options?.mode === "markdown"
        ? [{ text: `<b>${text}</b>`, parseMode: "HTML" as const }]
        : [{ text }],
  });
  assert.deepEqual(richSnapshot, {
    text: "<b>```ts\nconst value = 1\n```</b>",
    parseMode: "HTML",
    sourceText: "```ts\nconst value = 1\n```",
    strategy: "rich-stable-blocks",
  });
  const plainSnapshot = buildTelegramPreviewSnapshot({
    state: {
      pendingText: "**hello**",
      lastSentText: "",
    },
    maxMessageLength: 5,
    renderPreviewText: (markdown) => markdown.replaceAll("*", ""),
    renderTelegramMessage: () => [
      { text: "markdown:too-long", parseMode: "HTML" as const },
    ],
  });
  assert.deepEqual(plainSnapshot, {
    text: "hello",
    sourceText: "**hello**",
    strategy: "plain",
  });
});

test("Preview snapshots append conservative plain tails for incomplete fences, quotes, and lists", () => {
  const renderTelegramMessage = (
    text: string,
    options?: { mode?: TelegramRenderMode },
  ) =>
    options?.mode === "markdown"
      ? [{ text: `<b>${text}</b>`, parseMode: "HTML" as const }]
      : [{ text }];
  const fenceSnapshot = buildTelegramPreviewSnapshot({
    state: {
      pendingText: "## Intro\n\n```ts\nconst value = 1",
      lastSentText: "",
    },
    maxMessageLength: 200,
    renderPreviewText: (markdown) => markdown,
    renderTelegramMessage,
  });
  assert.deepEqual(fenceSnapshot, {
    text: "<b>## Intro</b>\n\n```ts\nconst value = 1",
    parseMode: "HTML",
    sourceText: "## Intro\n\n```ts\nconst value = 1",
    strategy: "rich-stable-blocks",
  });
  const quoteSnapshot = buildTelegramPreviewSnapshot({
    state: {
      pendingText: "## Intro\n\n\n> quoted line",
      lastSentText: "",
    },
    maxMessageLength: 200,
    renderPreviewText: (markdown) => markdown,
    renderTelegramMessage,
  });
  assert.deepEqual(quoteSnapshot, {
    text: "<b>## Intro</b>\n\n\n&gt; quoted line",
    parseMode: "HTML",
    sourceText: "## Intro\n\n\n> quoted line",
    strategy: "rich-stable-blocks",
  });
  const listSnapshot = buildTelegramPreviewSnapshot({
    state: {
      pendingText: "## Intro\n\n\n- first\n- second",
      lastSentText: "",
    },
    maxMessageLength: 200,
    renderPreviewText: (markdown) => markdown,
    renderTelegramMessage,
  });
  assert.deepEqual(listSnapshot, {
    text: "<b>## Intro</b>\n\n\n- first\n- second",
    parseMode: "HTML",
    sourceText: "## Intro\n\n\n- first\n- second",
    strategy: "rich-stable-blocks",
  });
});

test("Preview snapshots omit unstable tails when long-message limits leave no room", () => {
  const snapshot = buildTelegramPreviewSnapshot({
    state: {
      pendingText: "## Intro\n\n- first\n- second\n- third",
      lastSentText: "",
    },
    maxMessageLength: 18,
    renderPreviewText: (markdown) => markdown,
    renderTelegramMessage: (text, options) =>
      options?.mode === "markdown"
        ? [{ text: `<b>${text}</b>`, parseMode: "HTML" as const }]
        : [{ text }],
  });
  assert.deepEqual(snapshot, {
    text: "<b>## Intro</b>",
    parseMode: "HTML",
    sourceText: "## Intro\n\n- first\n- second\n- third",
    strategy: "rich-stable-blocks",
  });
});

test("Preview helpers create state and allocate draft ids", () => {
  assert.deepEqual(createTelegramPreviewRuntimeState("unknown"), {
    mode: "draft",
    pendingText: "",
    lastSentText: "",
  });
  assert.equal(
    createTelegramPreviewRuntimeState("unsupported").mode,
    "message",
  );
  assert.equal(allocateTelegramDraftId(0, 2), 1);
  assert.equal(allocateTelegramDraftId(1, 2), 2);
  assert.equal(allocateTelegramDraftId(2, 2), 1);
});

test("Preview helpers compute final text fallback without reusing rich HTML snapshots", () => {
  assert.equal(
    buildTelegramPreviewFinalText({
      mode: "message",
      pendingText: "   ",
      lastSentText: "saved",
      lastSentStrategy: "plain",
    }),
    "saved",
  );
  assert.equal(
    buildTelegramPreviewFinalText({
      mode: "message",
      pendingText: "   ",
      lastSentText: "<b>saved</b>",
      lastSentParseMode: "HTML",
      lastSentStrategy: "rich-stable-blocks",
    }),
    undefined,
  );
  assert.equal(
    buildTelegramPreviewFinalText({
      mode: "message",
      pendingText: "   ",
      lastSentText: "   ",
    }),
    undefined,
  );
});

test("Preview helpers use drafts only for plain preview snapshots", () => {
  assert.equal(
    shouldUseTelegramDraftPreview({ draftSupport: "unknown" }),
    true,
  );
  assert.equal(
    shouldUseTelegramDraftPreview({
      draftSupport: "supported",
      snapshot: { text: "preview", sourceText: "preview", strategy: "plain" },
    }),
    true,
  );
  assert.equal(
    shouldUseTelegramDraftPreview({
      draftSupport: "supported",
      snapshot: {
        text: "<b>preview</b>",
        parseMode: "HTML",
        sourceText: "preview",
        strategy: "rich-stable-blocks",
      },
    }),
    false,
  );
  assert.equal(
    shouldUseTelegramDraftPreview({ draftSupport: "unsupported" }),
    false,
  );
});

test("Preview message transport adapts Bot API bodies and reply metadata", async () => {
  const calls: unknown[] = [];
  const transport = createTelegramPreviewMessageTransport({
    sendMessage: async (body) => {
      calls.push(body);
      return { message_id: 3 };
    },
    editMessageText: async (body) => {
      calls.push(body);
      return "edited";
    },
    buildReplyParameters: (_chatId, messageId) =>
      messageId === undefined
        ? undefined
        : { message_id: messageId, allow_sending_without_reply: true },
  });
  assert.deepEqual(
    await transport.sendMessage(7, "hello", { parseMode: "HTML" }, 9),
    { message_id: 3 },
  );
  await transport.editMessageText(7, 3, "next", { parseMode: "HTML" });
  assert.deepEqual(calls, [
    {
      chat_id: 7,
      text: "hello",
      parse_mode: "HTML",
      reply_parameters: { message_id: 9, allow_sending_without_reply: true },
    },
    { chat_id: 7, message_id: 3, text: "next", parse_mode: "HTML" },
  ]);
  const defaultCalls: unknown[] = [];
  const defaultTransport = createTelegramPreviewMessageTransport({
    sendMessage: async (body) => {
      defaultCalls.push(body);
      return { message_id: 4 };
    },
    editMessageText: async () => undefined,
  });
  await defaultTransport.sendMessage(7, "default", undefined, 10);
  assert.deepEqual(defaultCalls, [
    {
      chat_id: 7,
      text: "default",
      parse_mode: undefined,
      reply_parameters: { message_id: 10, allow_sending_without_reply: true },
    },
  ]);
});

test("Preview rendered-chunk transport adapts reply context options", async () => {
  const calls: unknown[] = [];
  const transport = createTelegramPreviewRenderedChunkTransport({
    sendRenderedChunks: async (chatId, chunks, options) => {
      calls.push({ chatId, chunks, options });
      return 77;
    },
    editRenderedMessage: async (chatId, messageId, chunks) => {
      calls.push({ chatId, messageId, chunks });
      return messageId;
    },
  });
  const chunks = [{ text: "hello" }];
  assert.equal(await transport.sendRenderedChunks(7, chunks, 9), 77);
  assert.equal(await transport.editRenderedMessage(7, 77, chunks), 77);
  assert.deepEqual(calls, [
    { chatId: 7, chunks, options: { replyToMessageId: 9 } },
    { chatId: 7, messageId: 77, chunks },
  ]);
});

test("Assistant preview runtime binds controller and message hooks", async () => {
  const events: string[] = [];
  let activeTurn: { chatId: number } | undefined = { chatId: 7 };
  const runtime = createTelegramAssistantPreviewRuntime<{
    role: string;
    text?: string;
  }>({
    getActiveTurn: () => activeTurn,
    isAssistantMessage: (message) => message.role === "assistant",
    getMessageText: (message) => message.text ?? "",
    maxMessageLength: 100,
    renderPreviewText: (markdown) => markdown,
    sendDraft: async () => {
      events.push("draft");
    },
    sendMessage: async () => ({ message_id: 22 }),
    editMessageText: async () => {},
    buildReplyParameters: () => undefined,
    renderTelegramMessage: () => [{ text: "done" }],
    sendRenderedChunks: async () => undefined,
    editRenderedMessage: async () => undefined,
  });
  await runtime.onMessageStart({ message: { role: "assistant" } });
  await runtime.onMessageUpdate({
    message: { role: "assistant", text: "hello" },
  });
  assert.equal(runtime.getState()?.pendingText, "hello");
  await runtime.onMessageUpdate({
    message: {
      role: "assistant",
      text: "hello\n\n<!-- telegram_voice\nhidden streaming voice",
    },
  });
  assert.equal(runtime.getState()?.pendingText, "hello");
  activeTurn = undefined;
  await runtime.onMessageUpdate({
    message: { role: "assistant", text: "ignored" },
  });
  assert.equal(runtime.getState()?.pendingText, "hello");
  assert.deepEqual(events, []);
});

test("Assistant preview runtime suppresses text preview for voice-tagged turns", async () => {
  const events: string[] = [];
  const activeTurn = { chatId: 7, voiceReplyPreferred: true };
  const runtime = createTelegramAssistantPreviewRuntime<{
    role: string;
    text?: string;
  }>({
    getActiveTurn: () => activeTurn,
    isAssistantMessage: (message) => message.role === "assistant",
    getMessageText: (message) => message.text ?? "",
    maxMessageLength: 100,
    renderPreviewText: (markdown) => markdown,
    sendDraft: async () => {
      events.push("draft");
    },
    sendMessage: async () => ({ message_id: 22 }),
    editMessageText: async () => {},
    buildReplyParameters: () => undefined,
    renderTelegramMessage: () => [{ text: "done" }],
    sendRenderedChunks: async () => undefined,
    editRenderedMessage: async () => undefined,
  });
  await runtime.onMessageStart({ message: { role: "assistant" } });
  assert.equal(runtime.getState(), undefined);
  await runtime.onMessageUpdate({
    message: { role: "assistant", text: "hello" },
  });
  assert.equal(runtime.getState(), undefined);
  assert.deepEqual(events, []);
});

test("Assistant preview runtime suppresses text preview for voice-required turns", async () => {
  const events: string[] = [];
  const activeTurn = { chatId: 7, voiceReplyRequired: true };
  const runtime = createTelegramAssistantPreviewRuntime<{
    role: string;
    text?: string;
  }>({
    getActiveTurn: () => activeTurn,
    isAssistantMessage: (message) => message.role === "assistant",
    getMessageText: (message) => message.text ?? "",
    maxMessageLength: 100,
    renderPreviewText: (markdown) => markdown,
    sendDraft: async () => {
      events.push("draft");
    },
    sendMessage: async () => ({ message_id: 22 }),
    editMessageText: async () => {},
    buildReplyParameters: () => undefined,
    renderTelegramMessage: () => [{ text: "done" }],
    sendRenderedChunks: async () => undefined,
    editRenderedMessage: async () => undefined,
  });
  await runtime.onMessageStart({ message: { role: "assistant" } });
  assert.equal(runtime.getState(), undefined);
  await runtime.onMessageUpdate({
    message: { role: "assistant", text: "hello" },
  });
  assert.equal(runtime.getState(), undefined);
  assert.deepEqual(events, []);
});

test("Preview controller runtime binds Bot API and rendered-chunk transports", async () => {
  const calls: unknown[] = [];
  const controller = createTelegramPreviewControllerRuntime({
    getDefaultReplyToMessageId: () => 11,
    maxMessageLength: 100,
    renderPreviewText: (markdown) => markdown,
    sendDraft: async () => {},
    sendMessage: async (body) => {
      calls.push(body);
      return { message_id: 22 };
    },
    editMessageText: async (body) => {
      calls.push(body);
    },
    buildReplyParameters: (_chatId, messageId) =>
      messageId === undefined
        ? undefined
        : { message_id: messageId, allow_sending_without_reply: true },
    renderTelegramMessage: () => [{ text: "<b>done</b>", parseMode: "HTML" }],
    sendRenderedChunks: async (chatId, chunks, options) => {
      calls.push({ chatId, chunks, options });
      return 33;
    },
    editRenderedMessage: async () => undefined,
  });
  controller.setState({
    mode: "draft",
    draftId: 1,
    pendingText: "done",
    lastSentText: "done",
  });
  assert.equal(await controller.finalizeMarkdown(7, "done"), true);
  assert.deepEqual(calls, [
    {
      chatId: 7,
      chunks: [{ text: "<b>done</b>", parseMode: "HTML" }],
      options: { replyToMessageId: 11 },
    },
  ]);
});

test("Preview controller owns pending text mutation and state reset", () => {
  const controller = createTelegramPreviewController({
    maxMessageLength: 50,
    renderPreviewText: (markdown) => markdown,
    sendDraft: async () => {},
    sendMessage: async () => ({ message_id: 1 }),
    editMessageText: async () => {},
    renderTelegramMessage: () => [],
    sendRenderedChunks: async () => undefined,
    editRenderedMessage: async () => undefined,
  });
  controller.setPendingText("ignored");
  assert.equal(controller.getState(), undefined);
  controller.setState(controller.createState());
  controller.setPendingText("next markdown");
  assert.equal(controller.getState()?.pendingText, "next markdown");
  controller.resetState();
  assert.equal(controller.getState()?.pendingText, "");
});

test("Preview runtime handles assistant message lifecycle hooks", async () => {
  const events: string[] = [];
  let activeTurn: { chatId: number } | undefined = { chatId: 7 };
  let previewState:
    | {
        mode: "draft" | "message";
        pendingText: string;
        lastSentText: string;
      }
    | undefined = {
    mode: "message",
    pendingText: "previous markdown",
    lastSentText: "",
  };
  const createPreviewState = () => ({
    mode: "message" as const,
    pendingText: "",
    lastSentText: "",
  });
  await handleTelegramAssistantMessagePreviewStart(
    { role: "assistant", text: "new" },
    {
      getActiveTurn: () => activeTurn,
      isAssistantMessage: (message) => message.role === "assistant",
      getState: () => previewState,
      setState: (state) => {
        previewState = state;
        events.push(`set:${state?.pendingText ?? "none"}`);
      },
      createPreviewState,
      finalizePreview: async (chatId) => {
        events.push(`finalize:${chatId}`);
        return true;
      },
      finalizeMarkdownPreview: async (chatId, markdown) => {
        events.push(`markdown:${chatId}:${markdown}`);
        return true;
      },
    },
  );
  await handleTelegramAssistantMessagePreviewUpdate(
    { role: "assistant", text: "hello" },
    {
      getActiveTurn: () => activeTurn,
      isAssistantMessage: (message) => message.role === "assistant",
      getState: () => previewState,
      setState: (state) => {
        previewState = state;
        events.push(`set:${state?.pendingText ?? "none"}`);
      },
      createPreviewState,
      getMessageText: (message) => message.text,
      schedulePreviewFlush: (chatId) => {
        events.push(`flush:${chatId}`);
      },
    },
  );
  activeTurn = undefined;
  await handleTelegramAssistantMessagePreviewUpdate(
    { role: "assistant", text: "ignored" },
    {
      getActiveTurn: () => activeTurn,
      isAssistantMessage: (message) => message.role === "assistant",
      getState: () => previewState,
      setState: (state) => {
        previewState = state;
      },
      createPreviewState,
      getMessageText: (message) => message.text,
      schedulePreviewFlush: () => {
        events.push("unexpected:flush");
      },
    },
  );
  assert.deepEqual(events, ["markdown:7:previous markdown", "set:", "flush:7"]);
  assert.equal(previewState?.pendingText, "hello");
});

test("Preview hook runtime binds assistant message start and update deps", async () => {
  const events: string[] = [];
  let previewState:
    | {
        mode: "draft" | "message";
        pendingText: string;
        lastSentText: string;
      }
    | undefined = {
    mode: "message",
    pendingText: "previous markdown",
    lastSentText: "",
  };
  const hooks = createTelegramAssistantMessagePreviewHooks({
    getActiveTurn: () => ({ chatId: 7 }),
    isAssistantMessage: (message: { role: string; text?: string }) =>
      message.role === "assistant",
    getState: () => previewState,
    setState: (state) => {
      previewState = state;
      events.push(`set:${state?.pendingText ?? "none"}`);
    },
    createPreviewState: () => ({
      mode: "message" as const,
      pendingText: "",
      lastSentText: "",
    }),
    finalizePreview: async (chatId) => {
      events.push(`finalize:${chatId}`);
      return true;
    },
    finalizeMarkdownPreview: async (chatId, markdown) => {
      events.push(`markdown:${chatId}:${markdown}`);
      return true;
    },
    getMessageText: (message) => message.text ?? "",
    schedulePreviewFlush: (chatId) => {
      events.push(`flush:${chatId}`);
    },
  });
  await hooks.onMessageStart({ message: { role: "assistant" } });
  await hooks.onMessageUpdate({
    message: { role: "assistant", text: "next markdown" },
  });
  assert.deepEqual(events, ["markdown:7:previous markdown", "set:", "flush:7"]);
  assert.equal(previewState?.pendingText, "next markdown");
});

test("Preview runtime prefers editable rich previews when stable blocks are available", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    pendingText: "## Intro\n\nTail",
    lastSentText: "",
    flushTimer: setTimeout(() => {}, 1000),
  });
  await flushTelegramPreview(7, harness.deps);
  assert.deepEqual(harness.events, ["send:7:markdown:## Intro\n\nTail:HTML"]);
  assert.equal(harness.getState()?.mode, "message");
  assert.equal(harness.getState()?.messageId, 77);
  assert.equal(harness.getState()?.lastSentText, "markdown:## Intro\n\nTail");
  assert.equal(harness.getState()?.lastSentParseMode, "HTML");
  assert.equal(harness.getState()?.lastSentStrategy, "rich-stable-blocks");
  assert.equal(harness.getDraftSupport(), "unknown");
});

test("Preview runtime preserves original blank-line spacing around conservative tails", async () => {
  const cases = [
    {
      markdown: "Para\n\n\n> Quote",
      expectedEvent: "send:7:markdown:Para\n\n\n&gt; Quote:HTML",
      expectedText: "markdown:Para\n\n\n&gt; Quote",
    },
    {
      markdown: "Para\n\n\n- item",
      expectedEvent: "send:7:markdown:Para\n\n\n- item:HTML",
      expectedText: "markdown:Para\n\n\n- item",
    },
  ];
  for (const testCase of cases) {
    const harness = createPreviewRuntimeHarness({
      mode: "draft",
      pendingText: testCase.markdown,
      lastSentText: "",
      flushTimer: setTimeout(() => {}, 1000),
    });
    await flushTelegramPreview(7, harness.deps);
    assert.deepEqual(harness.events, [testCase.expectedEvent]);
    assert.equal(harness.getState()?.lastSentText, testCase.expectedText);
  }
});

test("Preview runtime keeps heading-to-code spacing readable without source blank lines", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    pendingText: "### Title\n```ts\nconst x = 1\n```",
    lastSentText: "",
    flushTimer: setTimeout(() => {}, 1000),
  });
  harness.deps.renderTelegramMessage = renderTelegramMessage;
  harness.deps.maxMessageLength = 4096;
  await flushTelegramPreview(7, harness.deps);
  assert.deepEqual(harness.events, [
    'send:7:<b>Title</b>\n\n<pre><code class="language-ts">const x = 1</code></pre>:HTML',
  ]);
  assert.equal(
    harness.getState()?.lastSentText,
    '<b>Title</b>\n\n<pre><code class="language-ts">const x = 1</code></pre>',
  );
});

test("Preview runtime can still use and clear plain draft previews", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    pendingText: "**hello**",
    lastSentText: "",
    flushTimer: setTimeout(() => {}, 1000),
  });
  harness.deps.renderTelegramMessage = () => [];
  await flushTelegramPreview(7, harness.deps);
  assert.deepEqual(harness.events, ["draft:7:10:hello"]);
  assert.equal(harness.getState()?.mode, "draft");
  assert.equal(harness.getState()?.draftId, 10);
  assert.equal(harness.getState()?.lastSentText, "hello");
  assert.equal(harness.getState()?.lastSentStrategy, "plain");
  assert.equal(harness.getDraftSupport(), "supported");
  await clearTelegramPreview(7, harness.deps);
  assert.deepEqual(harness.events, ["draft:7:10:hello"]);
  assert.equal(harness.getState(), undefined);
});

test("Preview runtime optional send gate clears without sending", async () => {
  const timer = setTimeout(() => {}, 1000);
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    pendingText: "**hello**",
    lastSentText: "",
    flushTimer: timer,
  });
  harness.deps.canSend = () => false;
  await flushTelegramPreview(7, harness.deps);
  assert.deepEqual(harness.events, []);
  assert.equal(harness.getState(), undefined);
});

test("Preview runtime falls back to editable plain messages when draft delivery fails", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    pendingText: "abcdef",
    lastSentText: "",
  });
  harness.deps.renderTelegramMessage = () => [];
  harness.deps.sendDraft = async () => {
    throw new Error("draft unsupported");
  };
  await flushTelegramPreview(7, harness.deps);
  assert.deepEqual(harness.events, ["send:7:abcdef:plain"]);
  assert.equal(harness.getState()?.mode, "message");
  assert.equal(harness.getState()?.messageId, 77);
  assert.equal(harness.getState()?.lastSentStrategy, "plain");
  assert.equal(harness.getDraftSupport(), "unsupported");
});

test("Preview runtime records transport failures without throwing", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "message",
    messageId: 77,
    pendingText: "next",
    lastSentText: "old",
  });
  harness.setDraftSupport("unsupported");
  const deps = {
    ...harness.deps,
    renderTelegramMessage: () => [],
    editMessageText: async () => {
      throw new Error("fetch failed");
    },
  };
  await flushTelegramPreview(7, deps);
  assert.deepEqual(harness.events, ["preview:flush"]);
});

test("Preview controller runtime forwards runtime-event recorder", async () => {
  const events: string[] = [];
  const runtime = createTelegramPreviewControllerRuntime({
    sendDraft: async () => {
      throw new Error("draft unsupported");
    },
    sendMessage: async () => {
      throw new Error("websocket disconnected");
    },
    editMessageText: async () => undefined,
    sendRenderedChunks: async () => undefined,
    editRenderedMessage: async () => undefined,
    recordRuntimeEvent: (category, error, details) => {
      const message = error instanceof Error ? error.message : String(error);
      events.push(`${category}:${message}:${details?.phase}`);
    },
  });
  runtime.resetState();
  runtime.setPendingText("hello");

  await runtime.flush(7);

  assert.deepEqual(events, ["preview:websocket disconnected:flush"]);
});

test("Preview runtime records final markdown failures and returns false", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    pendingText: "",
    lastSentText: "",
  });
  const deps = {
    ...harness.deps,
    sendRenderedChunks: async () => {
      throw new Error("fetch failed");
    },
  };
  assert.equal(await finalizeTelegramMarkdownPreview(7, "final", deps), false);
  assert.deepEqual(harness.events, ["preview:finalize-markdown"]);
});

test("Preview runtime serializes overlapping flush requests", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "message",
    messageId: 44,
    pendingText: "first",
    lastSentText: "",
  });
  harness.setDraftSupport("unsupported");
  let releaseEdit: (() => void) | undefined;
  harness.deps.editMessageText = async (
    chatId: number,
    messageId: number,
    text: string,
    options?: { parseMode?: "HTML" },
  ) => {
    harness.events.push(
      `edit:${chatId}:${messageId}:${text}:${options?.parseMode ?? "plain"}`,
    );
    if (!releaseEdit) {
      await new Promise<void>((resolve) => {
        releaseEdit = resolve;
      });
    }
  };
  const firstFlush = flushTelegramPreview(7, harness.deps);
  await Promise.resolve();
  const state = harness.getState();
  assert.ok(state);
  state.pendingText = "second";
  const secondFlush = flushTelegramPreview(7, harness.deps);
  releaseEdit?.();
  await Promise.all([firstFlush, secondFlush]);
  assert.deepEqual(harness.events, [
    "edit:7:44:first:plain",
    "edit:7:44:second:plain",
  ]);
  assert.equal(harness.getState()?.lastSentText, "second");
});

test("Preview runtime finalizes plain and markdown previews", async () => {
  const plainHarness = createPreviewRuntimeHarness({
    mode: "message",
    messageId: 44,
    pendingText: "done",
    lastSentText: "",
  });
  plainHarness.setDraftSupport("unsupported");
  plainHarness.deps.renderTelegramMessage = () => [];
  assert.equal(await finalizeTelegramPreview(7, plainHarness.deps), true);
  assert.deepEqual(plainHarness.events, ["edit:7:44:done:plain"]);
  assert.equal(plainHarness.getState(), undefined);
  const markdownHarness = createPreviewRuntimeHarness({
    mode: "message",
    messageId: 55,
    pendingText: "done",
    lastSentText: "",
  });
  markdownHarness.setDraftSupport("unsupported");
  assert.equal(
    await finalizeTelegramMarkdownPreview(7, "**done**", markdownHarness.deps),
    true,
  );
  assert.deepEqual(markdownHarness.events, [
    "edit:7:55:done:plain",
    "render-edit:7:55:markdown:**done**",
  ]);
  assert.equal(markdownHarness.getState(), undefined);
});
