/**
 * Regression tests for the Telegram preview domain
 * Covers native rich draft previews, safe-prefix selection, and finalization behavior
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateTelegramDraftId,
  buildTelegramPreviewFinalText,
  clearTelegramPreview,
  createTelegramAssistantPreviewRuntime,
  createTelegramNativeMarkdownPreviewFinalizer,
  createTelegramPreviewControllerRuntime,
  createTelegramPreviewRuntimeState,
  finalizeTelegramPreview,
  flushTelegramPreview,
  getSafeTelegramRichMarkdownDraftPrefix,
  shouldUseTelegramDraftPreview,
  type TelegramPreviewRuntimeState,
} from "../lib/preview.ts";
import { createTelegramThreadTarget } from "../lib/target.ts";

function createPreviewRuntimeHarness(state?: TelegramPreviewRuntimeState) {
  let previewState = state;
  let draftSupport: "unknown" | "supported" = "unknown";
  let nextDraftId = 10;
  const events: string[] = [];
  return {
    events,
    getState: () => previewState,
    getDraftSupport: () => draftSupport,
    deps: {
      getState: () => previewState,
      setState: (nextState: TelegramPreviewRuntimeState | undefined) => {
        previewState = nextState;
      },
      maxMessageLength: 100,
      getDraftSupport: () => draftSupport,
      setDraftSupport: (support: "unknown" | "supported") => {
        draftSupport = support;
      },
      allocateDraftId: () => nextDraftId++,
      sendDraft: async (
        chatId: number,
        draftId: number,
        text?: string,
        _options?: { message_thread_id?: number },
      ) => {
        events.push(`draft:${chatId}:${draftId}:${text}`);
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

test("Preview helpers create draft-only state and allocate draft ids", () => {
  assert.deepEqual(createTelegramPreviewRuntimeState(), {
    mode: "draft",
    pendingText: "",
    lastSentText: "",
  });
  assert.equal(allocateTelegramDraftId(0, 2), 1);
  assert.equal(allocateTelegramDraftId(1, 2), 2);
  assert.equal(allocateTelegramDraftId(2, 2), 1);
});

test("Preview final text prefers pending text then last sent draft text", () => {
  assert.equal(
    buildTelegramPreviewFinalText({
      mode: "draft",
      pendingText: "  final  ",
      lastSentText: "old",
    }),
    "final",
  );
  assert.equal(
    buildTelegramPreviewFinalText({
      mode: "draft",
      pendingText: "   ",
      lastSentText: "  old  ",
    }),
    "old",
  );
  assert.equal(
    buildTelegramPreviewFinalText({
      mode: "draft",
      pendingText: "   ",
      lastSentText: "   ",
    }),
    undefined,
  );
});

test("Preview helpers always use native rich drafts", () => {
  assert.equal(
    shouldUseTelegramDraftPreview({ draftSupport: "unknown" }),
    true,
  );
  assert.equal(
    shouldUseTelegramDraftPreview({
      draftSupport: "supported",
      snapshot: { text: "ok" },
    }),
    true,
  );
});

test("Native Markdown draft prefix keeps only structurally closed Markdown", () => {
  assert.equal(
    getSafeTelegramRichMarkdownDraftPrefix("**Bold** and *italic*", 100),
    "**Bold** and *italic*",
  );
  assert.equal(
    getSafeTelegramRichMarkdownDraftPrefix("**Bold** and *ita", 100),
    "**Bold** and",
  );
  assert.equal(
    getSafeTelegramRichMarkdownDraftPrefix("**Heading still streaming", 100),
    undefined,
  );
  assert.equal(
    getSafeTelegramRichMarkdownDraftPrefix("Before\n\n```ts\nconst x = 1", 100),
    "Before",
  );
  assert.equal(
    getSafeTelegramRichMarkdownDraftPrefix(
      "Before\n\n```ts\nconst x = 1\n```",
      100,
    ),
    "Before\n\n```ts\nconst x = 1\n```",
  );
  assert.equal(
    getSafeTelegramRichMarkdownDraftPrefix(
      "[OpenAI](https://openai.com) and [half",
      100,
    ),
    "[OpenAI](https://openai.com) and",
  );
  assert.equal(
    getSafeTelegramRichMarkdownDraftPrefix("Block math:\n\n$$\nx^2", 100),
    "Block math:",
  );
  assert.equal(
    getSafeTelegramRichMarkdownDraftPrefix(
      "<!-- telegram_button label=Ok",
      100,
    ),
    undefined,
  );
});

test("Preview runtime sends only safe native markdown draft prefixes", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    draftId: 10,
    pendingText: "**Bold** and *ita",
    lastSentText: "",
  });
  await flushTelegramPreview(7, harness.deps);
  assert.deepEqual(harness.events, ["draft:7:10:**Bold** and"]);
  assert.equal(harness.getState()?.lastSentText, "**Bold** and");
  assert.equal(harness.getDraftSupport(), "supported");
});

test("Preview runtime sends draft previews into thread target", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    draftId: 10,
    pendingText: "thread draft",
    lastSentText: "",
  });
  const sentOptions: unknown[] = [];
  harness.deps.sendDraft = async (
    _chatId: number,
    _draftId: number,
    _text?: string,
    options?: { message_thread_id?: number },
  ) => {
    sentOptions.push(options);
  };
  await flushTelegramPreview(7, harness.deps, {
    target: createTelegramThreadTarget(7, 42),
  });
  assert.deepEqual(sentOptions, [{ message_thread_id: 42 }]);
});

test("Preview runtime clears thread drafts in thread target", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    draftId: 10,
    pendingText: "new draft",
    lastSentText: "",
  });
  const sentOptions: unknown[] = [];
  harness.deps.sendDraft = async (
    _chatId: number,
    _draftId: number,
    _text?: string,
    options?: { message_thread_id?: number },
  ) => {
    sentOptions.push(options);
  };
  await clearTelegramPreview(7, harness.deps, {
    target: createTelegramThreadTarget(7, 42),
  });
  assert.deepEqual(sentOptions, [{ message_thread_id: 42 }]);
});

test("Preview runtime does not send thinking placeholder for unsafe draft tails", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    pendingText: "<!-- telegram_button label=Ok",
    lastSentText: "",
  });
  await flushTelegramPreview(7, harness.deps);
  assert.deepEqual(harness.events, []);
  assert.equal(harness.getState()?.draftId, undefined);
  assert.equal(harness.getState()?.lastSentText, "");
});

test("Preview runtime skips unchanged unsafe draft tails", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    pendingText: "**Bold** and *ita",
    lastSentText: "**Bold** and",
  });
  await flushTelegramPreview(7, harness.deps);
  assert.deepEqual(harness.events, []);
});

test("Preview runtime records draft failures without plain fallback", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    draftId: 10,
    pendingText: "abcdef",
    lastSentText: "",
  });
  harness.deps.sendDraft = async () => {
    throw new Error("draft rejected partial markdown");
  };
  await flushTelegramPreview(7, harness.deps);
  assert.deepEqual(harness.events, ["preview:draft"]);
  assert.equal(harness.getState()?.mode, "draft");
  assert.equal(harness.getDraftSupport(), "unknown");
});

test("Preview runtime serializes overlapping flush requests", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    draftId: 44,
    pendingText: "first",
    lastSentText: "",
  });
  let releaseDraft: (() => void) | undefined;
  harness.deps.sendDraft = async (chatId, draftId, text) => {
    harness.events.push(`draft:${chatId}:${draftId}:${text}`);
    if (!releaseDraft) {
      await new Promise<void>((resolve) => {
        releaseDraft = resolve;
      });
    }
  };
  const firstFlush = flushTelegramPreview(7, harness.deps);
  await Promise.resolve();
  const state = harness.getState();
  assert.ok(state);
  state.pendingText = "second";
  const secondFlush = flushTelegramPreview(7, harness.deps);
  releaseDraft?.();
  await Promise.all([firstFlush, secondFlush]);
  assert.deepEqual(harness.events, ["draft:7:44:first", "draft:7:44:second"]);
  assert.equal(harness.getState()?.lastSentText, "second");
});

test("Preview runtime clears active rich draft on explicit clear", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    draftId: 10,
    pendingText: "new draft",
    lastSentText: "",
  });
  await clearTelegramPreview(7, harness.deps);
  assert.deepEqual(harness.events, ["draft:7:10:undefined"]);
  assert.equal(harness.getState(), undefined);
});

test("Preview runtime optional send gate clears without sending new content", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    pendingText: "**hello**",
    lastSentText: "",
  });
  harness.deps.canSend = () => false;
  await flushTelegramPreview(7, harness.deps);
  assert.deepEqual(harness.events, []);
  assert.equal(harness.getState(), undefined);
});

test("Native Markdown finalizer waits for active draft flush before final reply", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    draftId: 10,
    pendingText: "draft body",
    lastSentText: "",
  });
  const releases: Array<() => void> = [];
  harness.deps.sendDraft = async (chatId, draftId, text) => {
    harness.events.push(`draft-start:${chatId}:${draftId}:${text}`);
    await new Promise<void>((resolve) => {
      releases.push(resolve);
    });
    harness.events.push(`draft-finish:${chatId}:${draftId}:${text}`);
  };
  const finalizeMarkdown = createTelegramNativeMarkdownPreviewFinalizer({
    getState: harness.deps.getState,
    clear: (chatId) => clearTelegramPreview(chatId, harness.deps),
    discard: () => harness.deps.setState(undefined),
    sendMarkdownReply: async (chatId, replyToMessageId, markdown) => {
      harness.events.push(
        `final:${chatId}:${replyToMessageId ?? "none"}:${markdown}`,
      );
      return 88;
    },
  });
  const flush = flushTelegramPreview(7, harness.deps);
  await Promise.resolve();
  const finalize = finalizeMarkdown(7, "final body", 55);
  await Promise.resolve();
  assert.deepEqual(harness.events, ["draft-start:7:10:draft body"]);
  releases.shift()?.();
  await Promise.all([flush, finalize]);
  assert.deepEqual(harness.events, [
    "draft-start:7:10:draft body",
    "draft-finish:7:10:draft body",
    "final:7:55:final body",
  ]);
  assert.equal(harness.getState(), undefined);
});

test("Plain preview finalization does not send fallback messages", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    draftId: 10,
    pendingText: "final body",
    lastSentText: "final",
  });
  assert.equal(await finalizeTelegramPreview(7, harness.deps), false);
  assert.deepEqual(harness.events, ["draft:7:10:final body"]);
  assert.equal(harness.getState(), undefined);
});

test("Assistant preview runtime finalizes previous markdown through native reply sender", async () => {
  const events: string[] = [];
  const runtime = createTelegramAssistantPreviewRuntime<{
    role: string;
    text?: string;
  }>({
    getActiveTurn: () => ({
      chatId: 7,
      replyToMessageId: 24,
      target: createTelegramThreadTarget(7, 42),
    }),
    isAssistantMessage: (message) => message.role === "assistant",
    getMessageText: (message) => message.text ?? "",
    maxMessageLength: 100,
    sendDraft: async () => {},
    sendMarkdownReply: async (chatId, replyToMessageId, markdown, options) => {
      events.push(
        `native-final:${chatId}:${replyToMessageId ?? "none"}:${markdown}:${
          options?.target?.threadId ?? "private"
        }`,
      );
      return 99;
    },
  });
  runtime.setState({
    mode: "draft",
    pendingText: "**previous**",
    lastSentText: "**previous**",
  });
  await runtime.onMessageStart({ message: { role: "assistant" } });
  assert.deepEqual(events, ["native-final:7:24:**previous**:42"]);
  assert.equal(runtime.getState()?.pendingText, "");
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
    sendDraft: async () => {
      events.push("draft");
    },
    sendMarkdownReply: async () => undefined,
  });
  await runtime.onMessageStart({ message: { role: "assistant" } });
  assert.equal(runtime.getState(), undefined);
  await runtime.onMessageUpdate({
    message: { role: "assistant", text: "hello" },
  });
  assert.equal(runtime.getState(), undefined);
  assert.deepEqual(events, []);
});

test("Preview controller runtime binds Bot API draft transport", async () => {
  const events: string[] = [];
  const runtime = createTelegramPreviewControllerRuntime({
    sendDraft: async (chatId, draftId, text) => {
      events.push(`draft:${chatId}:${draftId}:${text}`);
    },
    maxDraftId: 10,
  });
  runtime.resetState();
  runtime.setPendingText("hello".repeat(60));
  await runtime.flush(7);
  assert.deepEqual(events, [`draft:7:1:${"hello".repeat(60)}`]);
});
