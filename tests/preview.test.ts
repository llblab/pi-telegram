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
  shouldSuppressPreviewForGuestTurn,
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

test("Draft throttle sends immediately then the latest snapshot at two seconds without debounce starvation", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const drafts: Array<{ text: string | undefined; at: number }> = [];
  const preview = createTelegramAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true, getMessageText: (message) => message.text,
    sendDraft: async (_chat, _id, text) => { drafts.push({ text, at: Date.now() }); },
    sendMarkdownReply: async () => 100,
  });
  try {
    preview.resetState();
    await preview.onMessageUpdate({ message: { text: "First" } }); await preview.flush(7);
    await preview.onMessageUpdate({ message: { text: "Discarded intermediate" } }); await preview.flush(7);
    t.mock.timers.tick(1000);
    await preview.onMessageUpdate({ message: { text: "Latest" } }); await preview.flush(7);
    t.mock.timers.tick(999);
    assert.deepEqual(drafts, [{ text: "First", at: 10_000 }]);
    t.mock.timers.tick(1); await preview.flush(7);
    assert.deepEqual(drafts, [{ text: "First", at: 10_000 }, { text: "Latest", at: 12_000 }]);
  } finally { preview.invalidate(); }
});

test("Final publication cancels the draft throttle timer without waiting for its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const effects: string[] = [];
  const preview = createTelegramAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true, getMessageText: (message) => message.text,
    sendDraft: async (_chat, _id, text) => { effects.push(`draft:${text}`); },
    sendMarkdownReply: async () => { effects.push("final"); return 100; },
  });
  try {
    preview.resetState();
    await preview.onMessageUpdate({ message: { text: "First" } }); await preview.flush(7);
    await preview.onMessageUpdate({ message: { text: "Queued tail" } }); await preview.flush(7);
    const state = preview.getState()!;
    assert.ok(state.flushTimer);
    assert.equal(await preview.finalizeMarkdown(7, "Complete answer", 21), true);
    assert.equal(Date.now(), 10_000);
    assert.equal(state.flushTimer, undefined);
    t.mock.timers.tick(2000); await Promise.resolve();
    assert.deepEqual(effects, ["draft:First", "final"]);
  } finally { preview.invalidate(); }
});

test("Replacing a throttled preview cancels old text and retains the interval with the new target", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  let threadId = 42;
  const drafts: Array<{ text: string | undefined; thread: number | undefined }> = [];
  const preview = createTelegramAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7, target: { chatId: 7, threadId } }),
    isAssistantMessage: () => true, getMessageText: (message) => message.text,
    sendDraft: async (_chat, _id, text, options) => { drafts.push({ text, thread: options?.message_thread_id }); },
    sendMarkdownReply: async () => 100,
  });
  try {
    preview.resetState();
    await preview.onMessageUpdate({ message: { text: "First" } }); await preview.flush(7);
    await preview.onMessageUpdate({ message: { text: "Obsolete" } }); await preview.flush(7);
    const old = preview.getState()!;
    threadId = 43; preview.resetState();
    assert.equal(old.flushTimer, undefined);
    await preview.onMessageUpdate({ message: { text: "Replacement" } }); await preview.flush(7);
    t.mock.timers.tick(2000); await preview.flush(7);
    assert.deepEqual(drafts, [{ text: "First", thread: 42 }, { text: "Replacement", thread: 43 }]);
  } finally { preview.invalidate(); }
});

test("Slow draft requests remain single-flight and coalesce updates past the throttle deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const texts: string[] = [];
  const preview = createTelegramAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true, getMessageText: (message) => message.text,
    sendDraft: async (_chat, _id, text) => { texts.push(text!); if (texts.length === 1) await gate; },
    sendMarkdownReply: async () => 100,
  });
  preview.resetState();
  await preview.onMessageUpdate({ message: { text: "First" } });
  const flush = preview.getState()?.flushPromise;
  try {
    t.mock.timers.tick(2500);
    await preview.onMessageUpdate({ message: { text: "Intermediate" } });
    await preview.onMessageUpdate({ message: { text: "Latest" } });
    assert.deepEqual(texts, ["First"]);
    release(); await flush;
    assert.deepEqual(texts, ["First", "Latest"]);
  } finally { release(); await flush; preview.invalidate(); }
});

test("Sealed preview ignores late updates while a replacement preview can stream", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const drafts: string[] = [];
  const preview = createTelegramAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7, replyToMessageId: 55 }),
    isAssistantMessage: () => true,
    getMessageText: (message) => message.text,
    sendDraft: async (_chat, _id, text) => { if (text) drafts.push(text); },
    sendMarkdownReply: async () => { assert.fail("No permanent publication expected"); },
  });
  preview.resetState();
  await preview.onMessageUpdate({ message: { text: "First draft." } });
  await preview.flush(7);
  preview.seal();
  await preview.onMessageUpdate({ message: { text: "Obsolete late update." } });
  await preview.flush(7);
  assert.equal(preview.getState()?.pendingText, "First draft.");
  t.mock.timers.tick(2000);
  preview.resetState();
  await preview.onMessageUpdate({ message: { text: "Replacement draft." } });
  await preview.flush(7);
  assert.deepEqual(drafts, ["First draft.", "Replacement draft."]);
  preview.invalidate();
});

test("Native Markdown finalizer drains only the issued draft and suppresses queued and late drafts", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    draftId: 10,
    pendingText: "draft body",
    lastSentText: "",
  });
  const releases: Array<() => void> = [];
  let sends = 0;
  harness.deps.sendDraft = async (chatId, draftId, text) => {
    harness.events.push(`draft-start:${chatId}:${draftId}:${text}`);
    if (++sends === 1) await new Promise<void>((resolve) => {
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
  harness.getState()!.pendingText = "queued follow-up draft";
  const followUp = flushTelegramPreview(7, harness.deps);
  const finalize = finalizeMarkdown(7, "final body", 55);
  const lateFlush = flushTelegramPreview(7, harness.deps);
  await Promise.resolve();
  assert.deepEqual(harness.events, ["draft-start:7:10:draft body"]);
  releases.shift()?.();
  await Promise.all([flush, followUp, lateFlush, finalize]);
  assert.deepEqual(harness.events, [
    "draft-start:7:10:draft body",
    "draft-finish:7:10:draft body",
    "final:7:55:final body",
  ]);
  assert.equal(harness.getState(), undefined);
});

test("A deferred draft does not consume its latest text snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const texts: string[] = [];
  const preview = createTelegramAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true,
    getMessageText: (message) => message.text,
    sendDraft: async (_chat, _draft, text) => { texts.push(text!); return texts.length > 1; },
    sendMarkdownReply: async () => 100,
  });
  try {
    preview.resetState();
    preview.setPendingText("Latest snapshot");
    await preview.flush(7);
    assert.equal(preview.getState()?.lastSentText, "");
    t.mock.timers.tick(2000);
    await preview.flush(7);
    assert.equal(preview.getState()?.lastSentText, "Latest snapshot");
    assert.deepEqual(texts, ["Latest snapshot", "Latest snapshot"]);
  } finally { preview.invalidate(); }
});

test("Prepared final rechecks delivery authority after its original draft flush", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let active = true;
  const effects: string[] = [];
  const preview = createTelegramAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true,
    getMessageText: (message) => message.text,
    sendDraft: async () => { effects.push("draft"); await gate; },
    sendMarkdownReply: async () => { effects.push("final"); return 1; },
  });
  preview.resetState();
  await preview.onMessageUpdate({ message: { text: "Original draft." } });
  const original = preview.getState();
  const prepared = preview.prepareDelivery(() => active);
  const result = prepared.finalizeMarkdownPreview(7, "Final.", 21);
  try {
    active = false; release();
    assert.equal(await result, false);
    prepared.setPreviewPendingText("stale mutation");
    await prepared.clearPreview(7);
    assert.deepEqual(effects, ["draft"]);
    assert.equal(preview.getState(), original);
    assert.equal(original?.pendingText, "Original draft.");
  } finally { release(); await result; preview.invalidate(); }
});

test("Native Markdown finalizer stops when preview generation changes during flush", async () => {
  const harness = createPreviewRuntimeHarness({
    mode: "draft",
    draftId: 10,
    pendingText: "old draft",
    lastSentText: "",
  });
  let release: (() => void) | undefined;
  harness.deps.sendDraft = async () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  let finalSends = 0;
  const finalizeMarkdown = createTelegramNativeMarkdownPreviewFinalizer({
    getState: harness.deps.getState,
    clear: (chatId) => clearTelegramPreview(chatId, harness.deps),
    discard: () => harness.deps.setState(undefined),
    sendMarkdownReply: async () => {
      finalSends += 1;
      return 88;
    },
  });
  const flush = flushTelegramPreview(7, harness.deps);
  await Promise.resolve();
  const finalize = finalizeMarkdown(7, "old final", 55);
  await Promise.resolve();
  harness.deps.setState({
    mode: "draft",
    draftId: 11,
    pendingText: "new draft",
    lastSentText: "",
  });
  release?.();

  assert.equal(await finalize, false);
  await flush;
  assert.equal(finalSends, 0);
  assert.equal(harness.getState()?.draftId, 11);
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

test("Assistant preview rollover does not republish intermediate assistant text", async () => {
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
  assert.deepEqual(events, []);
  assert.equal(runtime.getState()?.pendingText, "");
});

test("Preview rollover waits for admitted publication without holding the message-start hook", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const drafts: string[] = [];
  const runtime = createTelegramAssistantPreviewRuntime<{ text: string }>({
    getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true,
    getMessageText: (message) => message.text,
    sendDraft: async (_chat, _id, text) => {
      drafts.push(text ?? "clear");
      if (drafts.length === 1) await gate;
    },
    sendMarkdownReply: async () => { assert.fail("Preview must not publish intermediate text"); },
  });
  runtime.resetState();
  await runtime.onMessageUpdate({ message: { text: "Old draft." } });
  const preparation = runtime.preparePublication()!;
  let started = false;
  const start = runtime.onMessageStart({ message: { text: "" } }).then(() => { started = true; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(started, true);
    await runtime.onMessageUpdate({ message: { text: "Next draft." } });
    assert.deepEqual(drafts, ["Old draft."]);
    release();
    await preparation.wait();
    assert.deepEqual(drafts, ["Old draft."], "Next draft must also wait for the permanent publication");
    t.mock.timers.tick(2000);
    preparation.settle();
    await runtime.flush(7);
    assert.deepEqual(drafts, ["Old draft.", "Next draft."]);
  } finally {
    release(); preparation.settle(); await start; await runtime.flush(7); runtime.invalidate();
  }
});

for (const operation of ["final", "clear"] as const) {
  test(`Preview rollover carries issued draft authority into ${operation} without a new update`, async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const effects: string[] = [];
    const runtime = createTelegramAssistantPreviewRuntime<{ text: string }>({
      getActiveTurn: () => ({ chatId: 7 }), isAssistantMessage: () => true,
      getMessageText: (message) => message.text,
      sendDraft: async (_chat, _id, text) => { effects.push(text ? "draft" : "clear"); if (text) await gate; },
      sendMarkdownReply: async () => { effects.push("final"); return 1; },
    });
    runtime.resetState();
    await runtime.onMessageUpdate({ message: { text: "Old draft." } });
    await runtime.onMessageStart({ message: { text: "" } });
    const delivery = operation === "final" ? runtime.finalizeMarkdown(7, "Final.") : runtime.prepareClear(7)();
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(effects, ["draft"]);
      release(); await delivery;
      assert.deepEqual(effects, ["draft", operation]);
    } finally { release(); await delivery; runtime.invalidate(); }
  });
}

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

test("Assistant preview runtime suppresses text preview for guest turns", async () => {
  const events: string[] = [];
  const activeTurn = { chatId: 0, guestQueryId: "guest-1" };
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
  assert.equal(shouldSuppressPreviewForGuestTurn(activeTurn), true);
  assert.equal(shouldSuppressPreviewForGuestTurn({ guestQueryId: "" }), false);
  assert.equal(shouldSuppressPreviewForGuestTurn(null), false);
  assert.equal(shouldSuppressPreviewForGuestTurn(undefined), false);
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
