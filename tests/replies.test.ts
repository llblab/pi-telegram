/**
 * Regression tests for Telegram reply delivery helpers
 * Covers UI/compat rendered-message transport, chunk delivery, native/plain final reply sending, and guest placeholder rotation
 */

import assert from "node:assert/strict";
import test from "node:test";

for (const rendering of ["rich", "html"] as const)
for (const outcome of ["edited", "before-issue", "late-ack", "oversize"] as const)
test(`Single-message assistant edits preserve rendering, target, boundedness and authority (${rendering}/${outcome})`, async () => {
  let current = outcome !== "before-issue", effects = 0;
  const markup = { inline_keyboard: [[{ text: "A", callback_data: "tgbtn:a" }]] };
  const options = { assertLocalAuthority() { if (!current) throw new Error("Owner ended"); } };
  const markdown = outcome === "oversize" ? "x".repeat(33000) : "**Next?**";
  const request = editTelegramSingleMarkdownMessage(7, 11, markdown, rendering, markup, {
    async editMessage(body, captured) {
      effects++;
      assert.equal(captured?.assertLocalAuthority, options.assertLocalAuthority);
      assert.deepEqual(body, { chat_id: 7, message_id: 11, reply_markup: markup,
        ...(rendering === "rich" ? { rich_message: { markdown: "**Next?**" } } : { text: "<b>Next?</b>", parse_mode: "HTML" }) });
      if (outcome === "late-ack") current = false;
    },
  }, options);
  if (outcome === "edited") await request; else await assert.rejects(request);
  assert.equal(effects, outcome === "edited" || outcome === "late-ack" ? 1 : 0);
});

// Transport-level dedup is module-global; reset between tests.
test.beforeEach(() => {
  resetTransportReplyDedup();
});

import {
  buildTelegramGuestPlaceholderFrame,
  buildTelegramReplyParameters,
  withTelegramReplyParameters,
  buildTelegramReplyTransport,
  createGuestMarkdownReplySender,
  createTelegramGuestPlaceholderRuntime,
  createTelegramRenderedMessageDeliveryRuntime,
  createTelegramRenderedMessageRuntime,
  editTelegramRenderedMessage,
  editTelegramSingleMarkdownMessage,
  extractLatestAssistantMessageText,
  extractRunAssistantMessage,
  getAgentMessageText,
  isAssistantAgentMessage,
  isTelegramMarkdownFenceClosing,
  normalizeTelegramNativeMarkdown,
  parseTelegramMarkdownFenceOpening,
  preserveTransportReplyDedupOnNextReset,
  resetTransportReplyDedup,
  sendTelegramNativeMarkdownReply,
  sendTelegramPlainReply,
  sendTelegramRenderedChunks,
  splitTelegramNativeMarkdown,
  TELEGRAM_DISMISSED_GUEST_PLACEHOLDER_TEXT,
  TELEGRAM_GUEST_PLACEHOLDER_FRAME_MS,
  TELEGRAM_GUEST_PLACEHOLDER_FRAMES,
  TELEGRAM_GUEST_PLACEHOLDER_MAX_MS,
  TELEGRAM_GUEST_PLACEHOLDER_MIN_MS,
  TELEGRAM_RICH_MESSAGE_MAX_BLOCKS,
  TELEGRAM_RICH_MESSAGE_MAX_CHARS,
} from "../lib/replies.ts";
import { createAgentStartDedupHook } from "../lib/lifecycle.ts";
import { createTelegramActivityPublicationRuntime } from "../lib/activity.ts";
import { createTelegramThreadTarget } from "../lib/target.ts";
import { createDefaultTelegramBridgeApiRuntime, TelegramApiAuthorityError, TelegramApiCommitUnknownError, TelegramApiFollowerNotAllowedError } from "../lib/telegram-api.ts";
import { createTelegramBusAwareApiRuntime } from "../lib/bus-api.ts";

for (const surface of ["send", "edit"] as const) for (const boundary of ["current", "before", "after"] as const) {
test(`Rendered local UI fence is explicit, snapshotted and retained across overflow (${surface}, ${boundary})`, async () => {
  let current = boundary !== "before", calls = 0, owned = 0;
  const options = { target: { chatId: 7, threadId: 70 }, assertLocalAuthority() { if (!current) throw new Error("UI owner ended"); } };
  const captured = options.assertLocalAuthority;
  const runtime = createTelegramRenderedMessageDeliveryRuntime<unknown>({
    renderTelegramMessage: () => [{ text: "first" }, { text: "second" }, { text: "third" }],
    async sendMessage(body, supplied) {
      calls++; assert.equal(body.message_thread_id, 70); assert.equal(supplied?.assertAuthority, undefined);
      assert.equal(supplied?.assertLocalAuthority, captured); supplied?.assertLocalAuthority?.();
      if (boundary === "after") { options.assertLocalAuthority = () => {}; current = false; }
      return { message_id: calls };
    },
    async editMessage(body, supplied) {
      calls++; assert.equal(body.message_thread_id, 70); assert.equal(supplied?.assertAuthority, undefined);
      assert.equal(supplied?.assertLocalAuthority, captured); supplied?.assertLocalAuthority?.();
      if (boundary === "after") { options.assertLocalAuthority = () => {}; current = false; }
    },
    sendRichMessage: async () => assert.fail("Local UI does not silently authorize rich transport"),
    recordOwnership() { owned++; },
  });
  const work = surface === "send" ? runtime.sendInteractiveMessage(7, "question", "html", {}, options) :
    runtime.editInteractiveMessage(7, 501, "result", "html", {}, options);
  if (boundary === "current") { await work; assert.equal(calls, 3); assert.equal(owned, 3); }
  else { await assert.rejects(work, { name: "TelegramApiAuthorityError", requestIssued: boundary === "after" });
    assert.equal(calls, boundary === "before" ? 0 : 1); assert.equal(owned, 0); }
});
}

type RenderedFenceSurface = "plain" | "interactive" | "edit" | "html" | "native" | "rich";
type RenderedFenceOptions = { target: { chatId: number; threadId: number }; replyToMessageId: number; assertAuthority: () => void };

function createRenderedFenceFixture(options: RenderedFenceOptions, ports: {
  fetch?: () => Promise<Response>;
  render?: () => void;
  record?: () => void;
  direct?: boolean;
  native?: boolean;
} = {}) {
  const originalFetch = globalThis.fetch, networkFamily = process.env.PI_TELEGRAM_NETWORK_FAMILY;
  delete process.env.PI_TELEGRAM_NETWORK_FAMILY;
  const requests: Array<{ method: string; body: Record<string, unknown> }> = [], owned: number[] = [], ipc: unknown[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ method: String(input).split("/").at(-1)!, body: JSON.parse(String(init?.body)) });
    return ports.fetch ? ports.fetch() : new Response(JSON.stringify({ ok: true, result: { message_id: requests.length } }));
  };
  const api = createTelegramBusAwareApiRuntime({
    directRuntime: createDefaultTelegramBridgeApiRuntime({ getBotToken: () => "123:fixture", recordRuntimeEvent() {} }),
    ownsDirect: () => ports.direct !== false,
    async callFollowerApi(method, args) { ipc.push({ method, args }); return { message_id: 99 }; },
  });
  const expectedAuthority = options.assertAuthority;
  const runtime = createTelegramRenderedMessageDeliveryRuntime<unknown>({
    renderTelegramMessage() { ports.render?.(); return [{ text: "first" }, { text: "tail" }]; },
    getAssistantRenderingMode: () => ports.native ? "rich" : "html",
    sendMessage(body, supplied) { assert.equal(supplied?.assertAuthority, expectedAuthority); return api.sendMessage(body, supplied); },
    editMessage(body, supplied) { assert.equal(supplied?.assertAuthority, expectedAuthority); return api.editMessageText(body, supplied); },
    sendRichMessage(body, supplied) { assert.equal(supplied?.assertAuthority, expectedAuthority); return api.sendRichMessage(body, supplied); },
    recordOwnership({ messageId }) { owned.push(messageId); ports.record?.(); },
  });
  return { requests, owned, ipc, runtime,
    restore() {
      globalThis.fetch = originalFetch;
      if (networkFamily === undefined) delete process.env.PI_TELEGRAM_NETWORK_FAMILY;
      else process.env.PI_TELEGRAM_NETWORK_FAMILY = networkFamily;
    },
  };
}

function issueRenderedFenceSurface(surface: RenderedFenceSurface, runtime: ReturnType<typeof createRenderedFenceFixture>["runtime"], options: RenderedFenceOptions) {
  if (surface === "plain") return runtime.sendTextReply(7, 21, "text", options);
  if (surface === "interactive") return runtime.sendInteractiveMessage(7, "text", "html", {}, options);
  if (surface === "edit") return runtime.editInteractiveMessage(7, 99, "text", "html", {}, options);
  if (surface === "html") return runtime.sendMarkdownReply(7, 21, "text", options);
  if (surface === "native") return runtime.sendMarkdownReply(7, 21, "x".repeat(33_000), options);
  return runtime.sendSectionRichMessage(7, { markdown: "text" }, options);
}

for (const surface of ["plain", "interactive", "edit", "html", "native", "rich"] as const) {
  for (const revoke of [false, true]) {
    test(`Rendered reply fence ${surface} ${revoke ? "refuses response-time loss" : "retains current authority"} through actual direct API`, async () => {
      let current = true;
      const options = { target: { chatId: 7, threadId: 42 }, replyToMessageId: 21,
        assertAuthority() { if (!current) throw new Error("private recipient diagnostic"); } };
      const f = createRenderedFenceFixture(options, { native: surface === "native", async fetch() {
        await Promise.resolve();
        if (revoke) { current = false; options.assertAuthority = () => {}; }
        return new Response(JSON.stringify({ ok: true, result: { message_id: f.requests.length } }));
      } });
      try {
        const issued = issueRenderedFenceSurface(surface, f.runtime, options);
        if (revoke) {
          await assert.rejects(issued, { name: "TelegramApiAuthorityError", requestIssued: true,
            message: "Telegram API call authority is unavailable." });
          assert.equal(f.requests.length, 1);
          assert.deepEqual(f.owned, []);
        } else {
          await issued;
          assert.equal(f.requests.length, surface === "rich" ? 1 : 2);
          assert.equal(f.owned.length, f.requests.length);
          assert.deepEqual(f.requests.map(({ method }) => method), surface === "edit" ? ["editMessageText", "sendMessage"] :
            Array(f.requests.length).fill(surface === "rich" || surface === "native" ? "sendRichMessage" : "sendMessage"));
        }
        assert.ok(f.requests.every(({ body }) => body.chat_id === 7 && body.message_thread_id === 42));
        assert.ok(f.requests.every(({ body }) => !("assertAuthority" in body)), "Local authority is not wire data.");
        assert.deepEqual(f.ipc, []);
      } finally { f.restore(); }
    });
  }
}

for (const surface of ["plain", "interactive", "edit", "html"] as const) {
  test(`Rendered reply fence ${surface} captures authority before synchronous rendering`, async () => {
    let current = true;
    const options = { target: { chatId: 7, threadId: 42 }, replyToMessageId: 21,
      assertAuthority() { if (!current) throw new Error("recipient replaced"); } };
    const f = createRenderedFenceFixture(options, { render() { current = false; options.assertAuthority = () => {}; } });
    try {
      await assert.rejects(issueRenderedFenceSurface(surface, f.runtime, options), { name: "TelegramApiAuthorityError", requestIssued: false });
      assert.deepEqual(f.requests, []);
      assert.deepEqual(f.owned, []);
      await withTelegramReplyParameters(7, 21, options.target, async (parameters) => assert.equal(parameters?.message_id, 21));
    } finally { f.restore(); }
  });
}

for (const boundary of ["rendering", "response"] as const) {
  test(`Rendered reply fence fixes its target before ${boundary} carrier mutation`, async () => {
    const options = { target: { chatId: 7, threadId: 42 }, replyToMessageId: 21, assertAuthority() {} };
    const mutate = () => { options.target.chatId = 8; options.target.threadId = 84; options.replyToMessageId = 22; };
    const f = createRenderedFenceFixture(options, {
      render: boundary === "rendering" ? mutate : undefined,
      async fetch() { if (boundary === "response") mutate(); return new Response(JSON.stringify({ ok: true, result: { message_id: f.requests.length } })); },
    });
    try {
      await issueRenderedFenceSurface("interactive", f.runtime, options);
      assert.equal(f.requests.length, 2);
      assert.ok(f.requests.every(({ body }) => body.chat_id === 7 && body.message_thread_id === 42));
      assert.deepEqual(f.requests.map(({ body }) => (body.reply_parameters as { message_id?: number } | undefined)?.message_id), [21, undefined]);
    } finally { f.restore(); }
  });
}

test("Rendered reply fence refuses final success after ownership publication revokes recipient", async () => {
  let current = true;
  const options = { target: { chatId: 7, threadId: 42 }, replyToMessageId: 21,
    assertAuthority() { if (!current) throw new Error("recipient replaced"); } };
  const f = createRenderedFenceFixture(options, { record() { current = false; } });
  try {
    await assert.rejects(issueRenderedFenceSurface("rich", f.runtime, options), { name: "TelegramApiAuthorityError", requestIssued: true });
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.owned, [1], "Previously current ownership is not undone or replayed.");
  } finally { f.restore(); }
});

for (const issued of [false, true]) {
  test(`Rendered reply fence ${issued ? "retains issued" : "releases unissued"} reply anchor after authority refusal`, async () => {
    const target = { chatId: 7, threadId: 42 };
    await assert.rejects(sendTelegramRenderedChunks(7, [{ text: "first" }], {
      async sendMessage() { throw new TelegramApiAuthorityError(issued); }, async editMessage() {},
    }, { target, replyToMessageId: 21, assertAuthority() {} }), { requestIssued: issued });
    await withTelegramReplyParameters(7, 21, target, async (parameters) => assert.equal(parameters?.message_id, issued ? undefined : 21));
  });
}

for (const boundary of ["adapter-return", "ownership-publication"] as const) {
  test(`Rendered reply fence rechecks at ${boundary} without issuing later chunks`, async () => {
    let current = true, calls = 0;
    const owned: number[] = [], options = { assertAuthority() { if (!current) throw new Error("recipient replaced"); } };
    await assert.rejects(sendTelegramRenderedChunks(7, [{ text: "first" }, { text: "tail" }], {
      async sendMessage(_body, supplied) {
        assert.equal(supplied?.assertAuthority, options.assertAuthority);
        calls++;
        if (boundary === "adapter-return") current = false;
        return { message_id: 1 };
      },
      async editMessage() {},
      recordOwnership({ messageId }) { owned.push(messageId); current = false; options.assertAuthority = () => {}; },
    }, options), { name: "TelegramApiAuthorityError", requestIssued: true });
    assert.equal(calls, 1);
    assert.deepEqual(owned, boundary === "adapter-return" ? [] : [1]);
  });
}

for (const surface of ["interactive", "edit", "rich"] as const) {
  test(`Rendered reply fence ${surface} cannot serialize recipient authority through follower IPC`, async () => {
    const options = { target: { chatId: 7, threadId: 42 }, replyToMessageId: 21, assertAuthority() {} };
    const f = createRenderedFenceFixture(options, { direct: false });
    try {
      await assert.rejects(issueRenderedFenceSurface(surface, f.runtime, options), { name: "TelegramApiAuthorityError", requestIssued: false });
      assert.deepEqual(f.requests, []); assert.deepEqual(f.owned, []); assert.deepEqual(f.ipc, []);
    } finally { f.restore(); }
  });
}

for (const surface of ["interactive", "native", "rich"] as const) {
  for (const refusedChunk of surface === "rich" ? [0] : [0, 1]) {
    test(`Reply refusal preserves ${surface} ownership and stops at chunk ${refusedChunk} without relocation`, async () => {
      const target = { chatId: 7, threadId: 42 };
      const options = { target, replyToMessageId: 21 };
      const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
      const owned: Array<{ chatId: number; messageId: number; target?: { chatId: number; threadId?: number } }> = [];
      let rejection: TelegramApiFollowerNotAllowedError | undefined;
      const send = async (method: string, body: Record<string, unknown>) => {
        const index = requests.length;
        requests.push({ method, body: structuredClone(body) });
        if (index === refusedChunk) {
          rejection = new TelegramApiFollowerNotAllowedError(
            "Telegram bus API call is not allowed for this follower.", target, method,
          );
          throw rejection;
        }
        return { message_id: 100 + index };
      };
      const runtime = createTelegramRenderedMessageDeliveryRuntime<unknown>({
        renderTelegramMessage: () => [{ text: "first" }, { text: "tail" }],
        sendMessage: (body) => send("sendMessage", body),
        sendRichMessage: (body) => send("sendRichMessage", body),
        editMessage: async () => { throw new Error("Refusal must not become an edit"); },
        recordOwnership: (entry) => owned.push(entry),
      });
      const issue = () => surface === "interactive"
        ? runtime.sendInteractiveMessage(7, "menu", "html", {}, options)
        : surface === "native"
          ? runtime.sendMarkdownReply(7, 21, "x".repeat(33_000), options)
          : runtime.sendSectionRichMessage(7, { markdown: "section" }, options);
      await assert.rejects(issue, (error) => error === rejection && rejection !== undefined);
      assert.equal(requests.length, refusedChunk + 1, "No replay of earlier chunks or replacement send");
      assert.ok(requests.every(({ body }) => body.chat_id === 7 && body.message_thread_id === 42));
      assert.deepEqual(owned, refusedChunk === 0 ? [] : [{ chatId: 7, messageId: 100, target }],
        "Only acknowledged chunks own messages, in their captured Thread");
      assert.deepEqual(options, { target: { chatId: 7, threadId: 42 }, replyToMessageId: 21 },
        "A refusal cannot change the caller's target or reply anchor");
    });
  }
}

test("Reply helpers extract assistant message text and metadata", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "question" }] },
    {
      role: "assistant",
      stopReason: "error",
      errorMessage: "boom",
      content: [
        { type: "text", text: " hello " },
        { type: "image", source: "ignored" },
        { type: "text", text: "world " },
      ],
    },
  ];
  assert.equal(isAssistantAgentMessage(messages[1]), true);
  assert.equal(getAgentMessageText(messages[1]), "hello world");
  assert.deepEqual(extractLatestAssistantMessageText(messages), {
    text: "hello world",
    stopReason: "error",
    errorMessage: "boom",
  });
});

test("Run assistant extraction keeps the preserved answer when the final message is suppressed", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "question" }] },
    {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "preserved answer" }],
    },
    { role: "custom", customType: "state-flow-validation" },
    { role: "assistant", stopReason: "stop", content: [] },
  ];
  assert.deepEqual(extractRunAssistantMessage(messages), {
    text: "preserved answer",
    stopReason: "stop",
    errorMessage: undefined,
    recoveredFromEarlier: true,
  });
});

test("Run assistant extraction never promotes tool-use prefaces or errors", () => {
  assert.deepEqual(
    extractRunAssistantMessage([
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "text", text: "Let me check." }],
      },
      { role: "assistant", stopReason: "stop", content: [] },
    ]),
    { text: undefined, stopReason: "stop", errorMessage: undefined },
  );
  assert.deepEqual(
    extractRunAssistantMessage([
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "boom",
        content: [],
      },
    ]),
    { text: undefined, stopReason: "error", errorMessage: "boom" },
  );
  assert.deepEqual(
    extractRunAssistantMessage([
      {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "latest" }],
      },
    ]),
    { text: "latest", stopReason: "stop", errorMessage: undefined },
  );
});

test("Reply transport forwards send and edit operations through delivery helpers", async () => {
  const events: string[] = [];
  const transport = buildTelegramReplyTransport({
    sendMessage: async (body) => {
      events.push(`send:${body.chat_id}:${body.text}`);
      return { message_id: 5 };
    },
    editMessage: async (body) => {
      events.push(`edit:${body.chat_id}:${body.message_id}:${body.text}`);
    },
  });
  assert.equal(await transport.sendRenderedChunks(7, [{ text: "one" }]), 5);
  assert.equal(await transport.editRenderedMessage(7, 9, [{ text: "two" }]), 9);
  assert.deepEqual(events, ["send:7:one", "edit:7:9:two"]);
});

test("Reply delivery includes thread target on rendered chunks", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const ownership: Array<Record<string, unknown>> = [];
  await sendTelegramRenderedChunks(
    -1007,
    [{ text: "one" }, { text: "two" }],
    {
      sendMessage: async (body) => {
        sentBodies.push(body);
        return { message_id: sentBodies.length };
      },
      editMessage: async () => {},
      recordOwnership: (input) => {
        ownership.push(input);
      },
    },
    { target: createTelegramThreadTarget(-1007, 42) },
  );
  assert.deepEqual(
    sentBodies.map((body) => body.message_thread_id),
    [42, 42],
  );
  assert.deepEqual(
    ownership.map((record) => record.messageId),
    [1, 2],
  );
  assert.deepEqual(ownership[0]?.target, createTelegramThreadTarget(-1007, 42));
});

test("Reply delivery includes thread target on rendered edits and continuation chunks", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const editedBodies: Array<Record<string, unknown>> = [];
  const ownership: Array<Record<string, unknown>> = [];
  await editTelegramRenderedMessage(
    -1007,
    9,
    [{ text: "one" }, { text: "two" }],
    {
      sendMessage: async (body) => {
        sentBodies.push(body);
        return { message_id: sentBodies.length };
      },
      editMessage: async (body) => {
        editedBodies.push(body);
      },
      recordOwnership: (input) => {
        ownership.push(input);
      },
    },
    { target: createTelegramThreadTarget(-1007, 42) },
  );
  assert.equal(editedBodies[0]?.message_thread_id, 42);
  assert.equal(sentBodies[0]?.message_thread_id, 42);
  assert.deepEqual(
    ownership.map((record) => record.messageId),
    [9, 1],
  );
});

test("Reply delivery sends chunks and applies reply markup only to the last chunk", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const messageId = await sendTelegramRenderedChunks(
    7,
    [{ text: "one" }, { text: "two", parseMode: "HTML" }],
    {
      sendMessage: async (body) => {
        sentBodies.push(body);
        return { message_id: sentBodies.length };
      },
      editMessage: async () => {},
    },
    {
      replyMarkup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
    },
  );
  assert.equal(messageId, 2);
  assert.deepEqual(sentBodies, [
    { chat_id: 7, text: "one", parse_mode: undefined, reply_markup: undefined },
    {
      chat_id: 7,
      text: "two",
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
    },
  ]);
});

test("Reply delivery rejects generated buttons above Telegram callback limit", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  await assert.rejects(
    () =>
      sendTelegramRenderedChunks(
        7,
        [{ text: "one" }],
        {
          sendMessage: async (body) => {
            sentBodies.push(body);
            return { message_id: sentBodies.length };
          },
          editMessage: async () => {},
        },
        {
          replyMarkup: {
            inline_keyboard: [
              [{ text: "Too long", callback_data: "x".repeat(65) }],
            ],
          },
        },
      ),
    /exceeds 64 bytes/,
  );
  assert.deepEqual(sentBodies, []);
});

test("Reply delivery applies reply parameters only to the first chunk", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  await sendTelegramRenderedChunks(
    7,
    [{ text: "one" }, { text: "two" }],
    {
      sendMessage: async (body) => {
        sentBodies.push(body);
        return { message_id: sentBodies.length };
      },
      editMessage: async () => {},
    },
    { replyToMessageId: 42 },
  );
  assert.deepEqual(sentBodies[0]?.reply_parameters, {
    message_id: 42,
    allow_sending_without_reply: true,
  });
  assert.equal("reply_parameters" in (sentBodies[1] ?? {}), false);
});

test("Reply delivery edits the first chunk and sends remaining chunks separately", async () => {
  const editedBodies: Array<Record<string, unknown>> = [];
  const sentBodies: Array<Record<string, unknown>> = [];
  const result = await editTelegramRenderedMessage(
    7,
    99,
    [{ text: "first", parseMode: "HTML" }, { text: "second" }],
    {
      sendMessage: async (body) => {
        sentBodies.push(body);
        return { message_id: 123 };
      },
      editMessage: async (body) => {
        editedBodies.push(body);
      },
    },
    {
      replyMarkup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
    },
  );
  assert.equal(result, 123);
  assert.deepEqual(editedBodies, [
    {
      chat_id: 7,
      message_id: 99,
      text: "first",
      parse_mode: "HTML",
      reply_markup: undefined,
    },
  ]);
  assert.deepEqual(sentBodies, [
    {
      chat_id: 7,
      text: "second",
      parse_mode: undefined,
      reply_markup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
    },
  ]);
  assert.equal("reply_parameters" in (sentBodies[0] ?? {}), false);
});

test("Reply runtime bundles text, native markdown, and UI/compat interactive delivery", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const richSent: Array<Record<string, unknown>> = [];
  const edited: Array<Record<string, unknown>> = [];
  const runtime = createTelegramRenderedMessageRuntime({
    renderTelegramMessage: (text, options) => [
      { text: `${options?.mode ?? "plain"}:${text}` },
    ],
    replyTransport: buildTelegramReplyTransport({
      sendMessage: async (body) => {
        sent.push(body);
        return { message_id: sent.length };
      },
      editMessage: async (body) => {
        edited.push(body);
      },
    }),
    sendRichMessage: async (body) => {
      richSent.push(body);
      return { message_id: 77 };
    },
  });
  assert.equal(await runtime.sendTextReply(7, 42, "hello"), 1);
  assert.equal(
    await runtime.sendMarkdownReply(
      7,
      43,
      "**hello** /start https://example.com",
    ),
    77,
  );
  assert.equal(
    await runtime.sendInteractiveMessage(
      7,
      "menu",
      "html",
      {
        inline_keyboard: [],
      },
      { replyToMessageId: 44 },
    ),
    2,
  );
  await runtime.editInteractiveMessage(7, 9, "menu", "html", {
    inline_keyboard: [],
  });
  assert.deepEqual(
    sent.map((body) => body.text),
    ["plain:hello", "html:menu"],
  );
  assert.deepEqual(richSent, [
    {
      chat_id: 7,
      rich_message: { markdown: "**hello** /start https://example.com" },
      reply_markup: undefined,
      reply_parameters: {
        message_id: 43,
        allow_sending_without_reply: true,
      },
    },
  ]);
  assert.deepEqual(sent[0]?.reply_parameters, {
    message_id: 42,
    allow_sending_without_reply: true,
  });
  assert.deepEqual(sent[1]?.reply_markup, { inline_keyboard: [] });
  assert.deepEqual(sent[1]?.reply_parameters, {
    message_id: 44,
    allow_sending_without_reply: true,
  });
  assert.deepEqual(
    edited.map((body) => body.text),
    ["html:menu"],
  );
});

test("Plain reply includes thread target on rendered messages", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const runtime = createTelegramRenderedMessageRuntime({
    renderTelegramMessage: (text) => [{ text }],
    replyTransport: buildTelegramReplyTransport({
      sendMessage: async (body) => {
        sentBodies.push(body);
        return { message_id: 1 };
      },
      editMessage: async () => {},
    }),
    sendRichMessage: async () => ({ message_id: 77 }),
  });
  await runtime.sendTextReply(-1007, 9, "hello", {
    target: createTelegramThreadTarget(-1007, 42),
  });
  assert.equal(sentBodies[0]?.message_thread_id, 42);
  assert.deepEqual(sentBodies[0]?.reply_parameters, {
    message_id: 9,
    allow_sending_without_reply: true,
  });
  assert.equal("reply_to_message_id" in (sentBodies[0] ?? {}), false);
});

test("Native Markdown reply anchors only the first rich chunk in thread targets", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const ownership: Array<Record<string, unknown>> = [];
  const first = "a".repeat(TELEGRAM_RICH_MESSAGE_MAX_CHARS - 10);
  const second = "b".repeat(30);
  const target = createTelegramThreadTarget(-1007, 42);
  await sendTelegramNativeMarkdownReply(
    -1007,
    9,
    `${first}\n\n${second}`,
    {
      recordOwnership: (input) => {
        ownership.push(input);
      },
      sendRichMessage: async (body) => {
        sentBodies.push(body);
        return { message_id: sentBodies.length };
      },
    },
    { target },
  );
  assert.equal(sentBodies.length, 2);
  assert.equal(sentBodies[0]?.message_thread_id, 42);
  assert.equal(sentBodies[1]?.message_thread_id, 42);
  assert.deepEqual(sentBodies[0]?.reply_parameters, {
    message_id: 9,
    allow_sending_without_reply: true,
  });
  assert.equal("reply_parameters" in (sentBodies[1] ?? {}), false);
  assert.deepEqual(ownership, [
    { chatId: -1007, messageId: 1, target },
    { chatId: -1007, messageId: 2, target },
  ]);
});

test("Reply runtime can send markdown through native rich messages", async () => {
  const richBodies: Array<Record<string, unknown>> = [];
  const sentBodies: Array<Record<string, unknown>> = [];
  const runtime = createTelegramRenderedMessageRuntime({
    renderTelegramMessage: (text, options) => [
      { text: `${options?.mode ?? "plain"}:${text}` },
    ],
    replyTransport: buildTelegramReplyTransport({
      sendMessage: async (body) => {
        sentBodies.push(body);
        return { message_id: sentBodies.length };
      },
      editMessage: async () => {},
    }),
    sendRichMessage: async (body) => {
      richBodies.push(body);
      return { message_id: 77 };
    },
  });
  assert.equal(
    await runtime.sendMarkdownReply(7, 43, "# hello", {
      replyMarkup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
    }),
    77,
  );
  assert.deepEqual(richBodies, [
    {
      chat_id: 7,
      rich_message: { markdown: "# hello" },
      reply_markup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
      reply_parameters: {
        message_id: 43,
        allow_sending_without_reply: true,
      },
    },
  ]);
  assert.deepEqual(sentBodies, []);
});

test("Reply runtime uses native rich messages for anchored thread markdown replies", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const richBodies: Array<Record<string, unknown>> = [];
  const target = createTelegramThreadTarget(-1007, 42);
  const runtime = createTelegramRenderedMessageRuntime({
    renderTelegramMessage: (text, options) => [
      { text: `${options?.mode ?? "plain"}:${text}`, parseMode: "HTML" },
    ],
    replyTransport: buildTelegramReplyTransport({
      sendMessage: async (body) => {
        sentBodies.push(body);
        return { message_id: sentBodies.length };
      },
      editMessage: async () => {},
    }),
    sendRichMessage: async (body) => {
      richBodies.push(body);
      return { message_id: 77 };
    },
  });

  assert.equal(
    await runtime.sendMarkdownReply(-1007, 43, "# hello", {
      replyMarkup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
      target,
    }),
    77,
  );

  assert.deepEqual(sentBodies, []);
  assert.deepEqual(richBodies, [
    {
      chat_id: -1007,
      rich_message: { markdown: "# hello" },
      reply_markup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
      reply_parameters: {
        message_id: 43,
        allow_sending_without_reply: true,
      },
      message_thread_id: 42,
    },
  ]);
});

test("Reply runtime does not fall back to HTML when native rich message delivery fails", async () => {
  const sentBodies: Array<Record<string, unknown>> = [];
  const runtime = createTelegramRenderedMessageRuntime({
    renderTelegramMessage: (text, options) => [
      { text: `${options?.mode ?? "plain"}:${text}`, parseMode: "HTML" },
    ],
    replyTransport: buildTelegramReplyTransport({
      sendMessage: async (body) => {
        sentBodies.push(body);
        return { message_id: sentBodies.length };
      },
      editMessage: async () => {},
    }),
    sendRichMessage: async () => {
      throw new Error("rich unsupported");
    },
  });
  await assert.rejects(() => runtime.sendMarkdownReply(7, 43, "# hello"), {
    message: "rich unsupported",
  });
  assert.deepEqual(sentBodies, []);
});

test("Reply delivery runtime exposes transport and UI/compat rendered-message helpers", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const runtime = createTelegramRenderedMessageDeliveryRuntime({
    renderTelegramMessage: (text, options) => [
      { text: `${options?.mode ?? "plain"}:${text}` },
    ],
    sendMessage: async (body) => {
      sent.push(body);
      return { message_id: sent.length };
    },
    editMessage: async () => {},
    sendRichMessage: async () => ({ message_id: 99 }),
  });
  assert.equal(await runtime.sendTextReply(7, 42, "hello"), 1);
  assert.equal(
    await runtime.replyTransport.sendRenderedChunks(7, [{ text: "raw" }]),
    2,
  );
  assert.deepEqual(
    sent.map((body) => body.text),
    ["plain:hello", "raw"],
  );
});

test("Guest replies answer with native Rich Markdown content", async () => {
  const calls: Array<{
    guestQueryId: string;
    text?: string;
    options?: {
      richMessage?: { markdown?: string; skip_entity_detection?: boolean };
    };
  }> = [];
  const sendGuestReply = createGuestMarkdownReplySender({
    answerGuestQuery: async (guestQueryId, text, options) => {
      calls.push({ guestQueryId, text, options });
    },
  });
  await sendGuestReply("guest-1", "**hello** /start");
  assert.deepEqual(calls, [
    {
      guestQueryId: "guest-1",
      text: undefined,
      options: {
        richMessage: {
          markdown: "**hello** /start",
        },
      },
    },
  ]);
});

test("Native Markdown delivery normalizes space-after-marker blockquotes outside code", () => {
  const markdown = "> quoted\n\n```md\n> quoted code\n```";
  assert.equal(
    normalizeTelegramNativeMarkdown(markdown),
    ">quoted\n\n```md\n> quoted code\n```",
  );
});

test("Native Markdown delivery neutralizes indented list markers that break Rich Markdown", () => {
  const markdown = [
    "**HEAD**",
    "",
    "  - alpha/beta gamma-delta with `inline.code`",
    "",
    "END",
  ].join("\n");
  assert.equal(
    normalizeTelegramNativeMarkdown(markdown),
    [
      "**HEAD**",
      "",
      "\u00A0\u00A0- alpha/beta gamma-delta with `inline.code`",
      "",
      "END",
    ].join("\n"),
  );
});

test("Native Markdown delivery preserves top-level list markers", () => {
  assert.equal(
    normalizeTelegramNativeMarkdown("- plain\n  - nested\n\t- tabbed"),
    "- plain\n\u00A0\u00A0- nested\n\u00A0\u00A0- tabbed",
  );
});

test("Native Markdown delivery converts multiline display math to math fences", () => {
  const markdown = [
    "Block math:",
    "",
    "$$",
    "\\int_0^1 x^2 dx = \\frac{1}{3}",
    "$$",
    "",
    "```md",
    "$$",
    "literal fenced math delimiters",
    "$$",
    "```",
  ].join("\n");
  assert.equal(
    normalizeTelegramNativeMarkdown(markdown),
    [
      "Block math:",
      "",
      "```math",
      "\\int_0^1 x^2 dx = \\frac{1}{3}",
      "```",
      "",
      "```md",
      "$$",
      "literal fenced math delimiters",
      "$$",
      "```",
    ].join("\n"),
  );
});

test("Native Markdown delivery preserves Bot API 10.2 structured blocks", async () => {
  const source = [
    "# Structured report",
    "",
    "| Metric | Value |",
    "|:-------|------:|",
    "| Speed | **42 ms** |",
    "",
    "Inline formula: $x^2 + y^2$.",
    "",
    "$$",
    "E = mc^2",
    "$$",
    "",
    "```ts",
    "const ready = true;",
    "```",
    "",
    "<details open><summary>Evidence</summary>",
    "",
    "- unordered item",
    "1. ordered item",
    "",
    "> quoted evidence",
    "",
    "</details>",
  ].join("\n");
  const expected = source
    .replace("$$\nE = mc^2\n$$", "```math\nE = mc^2\n```")
    .replace("> quoted evidence", ">quoted evidence");

  assert.equal(normalizeTelegramNativeMarkdown(source), expected);
  const bodies: Array<Record<string, unknown>> = [];
  await sendTelegramNativeMarkdownReply(7, undefined, source, {
    sendRichMessage: async (body) => {
      bodies.push(body);
      return { message_id: 1 };
    },
  });
  assert.deepEqual(bodies, [
    {
      chat_id: 7,
      rich_message: {
        markdown: expected,
      },
      reply_markup: undefined,
    },
  ]);
});

test("Native Markdown delivery ignores math delimiters inside fences when pairing", () => {
  const markdown = ["$$", "```md", "$$", "```"].join("\n");
  assert.equal(normalizeTelegramNativeMarkdown(markdown), markdown);
});

test("Native Markdown splitter keeps truncation-risk fixture intact", () => {
  const markdown = [
    "**HEAD**",
    "",
    "  - alpha/beta gamma-delta with `inline.code`",
    "",
    "END",
  ].join("\n");
  const chunks = splitTelegramNativeMarkdown(markdown);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0] ?? "", /inline\.code/);
  assert.match(chunks[0] ?? "", /END$/);
});

test("Native Markdown delivery sends normalized risky fixture without losing tail text", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  await sendTelegramNativeMarkdownReply(
    7,
    undefined,
    [
      "**HEAD**",
      "",
      "  - alpha/beta gamma-delta with `inline.code`",
      "",
      "END",
    ].join("\n"),
    {
      sendRichMessage: async (body) => {
        bodies.push(body);
        return { message_id: bodies.length };
      },
    },
  );
  const markdown =
    (bodies[0]?.rich_message as { markdown?: string })?.markdown ?? "";
  assert.match(markdown, /^\*\*HEAD\*\*/);
  assert.match(
    markdown,
    /\u00A0\u00A0- alpha\/beta gamma-delta with `inline\.code`/,
  );
  assert.match(markdown, /END$/);
});

test("Native Markdown delivery escapes dollar ticker atoms outside code", () => {
  const markdown = [
    "Токен $BLDR может ломать math parsing.",
    "Bold ticker **$BTC** тоже ломает rich parsing.",
    "Токен $NTVE, $VETO. и $NTVE/Bucket тоже опасны.",
    "Inline code: `$BLDR`, formula $x^2 + y^2$, and explicit math $BTC$ stay unchanged.",
    "```md",
    "$BLDR in code fence",
    "```",
  ].join("\n");
  assert.equal(
    normalizeTelegramNativeMarkdown(markdown),
    [
      "Токен \\$BLDR может ломать math parsing.",
      "Bold ticker **\\$BTC** тоже ломает rich parsing.",
      "Токен \\$NTVE, \\$VETO. и \\$NTVE/Bucket тоже опасны.",
      "Inline code: `$BLDR`, formula $x^2 + y^2$, and explicit math $BTC$ stay unchanged.",
      "```md",
      "$BLDR in code fence",
      "```",
    ].join("\n"),
  );
});

test("Native Markdown splitter prefers paragraph boundaries", () => {
  const first = "a".repeat(TELEGRAM_RICH_MESSAGE_MAX_CHARS - 10);
  const second = "b".repeat(30);
  const chunks = splitTelegramNativeMarkdown(`${first}\n\n${second}`);
  assert.deepEqual(chunks, [first, second]);
  assert.ok(
    chunks.every((chunk) => chunk.length <= TELEGRAM_RICH_MESSAGE_MAX_CHARS),
  );
});

test("Native Markdown splitter falls back to hard limits for long atoms", () => {
  const chunks = splitTelegramNativeMarkdown(
    "x".repeat(TELEGRAM_RICH_MESSAGE_MAX_CHARS + 5),
  );
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.length, TELEGRAM_RICH_MESSAGE_MAX_CHARS);
  assert.equal(chunks[1], "xxxxx");
});

test("Native Markdown splitter keeps fenced code blocks together when possible", () => {
  const codeBlock = `\`\`\`ts\n${"x\n\n".repeat(100)}\`\`\``;
  const prefix = "a".repeat(TELEGRAM_RICH_MESSAGE_MAX_CHARS - codeBlock.length);
  const chunks = splitTelegramNativeMarkdown(
    `${prefix}\n\n${codeBlock}\n\ntail`,
  );
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1], `${codeBlock}\n\ntail`);
});

test("Native Markdown splitter rewraps oversized fenced code blocks", () => {
  const chunks = splitTelegramNativeMarkdown(
    `\`\`\`ts\n${"x".repeat(TELEGRAM_RICH_MESSAGE_MAX_CHARS + 500)}\n\`\`\``,
  );
  assert.ok(chunks.length > 1);
  assert.ok(
    chunks.every((chunk) => chunk.length <= TELEGRAM_RICH_MESSAGE_MAX_CHARS),
  );
  assert.ok(chunks.every((chunk) => chunk.startsWith("```ts\n")));
  assert.ok(chunks.every((chunk) => chunk.endsWith("\n```")));
  const contentLength = chunks
    .map((chunk) => chunk.split("\n").slice(1, -1).join("\n").length)
    .reduce((sum, length) => sum + length, 0);
  assert.equal(contentLength, TELEGRAM_RICH_MESSAGE_MAX_CHARS + 500);
});

test("Native Markdown splitter rewraps oversized display math blocks", () => {
  const chunks = splitTelegramNativeMarkdown(
    `$$\n${"x".repeat(TELEGRAM_RICH_MESSAGE_MAX_CHARS + 500)}\n$$`,
  );
  assert.ok(chunks.length > 1);
  assert.ok(
    chunks.every((chunk) => chunk.length <= TELEGRAM_RICH_MESSAGE_MAX_CHARS),
  );
  assert.ok(chunks.every((chunk) => chunk.startsWith("```math\n")));
  assert.ok(chunks.every((chunk) => chunk.endsWith("\n```")));
});

test("Native Markdown splitter rewraps oversized inline formatting blocks", () => {
  const chunks = splitTelegramNativeMarkdown(
    `**${"x".repeat(TELEGRAM_RICH_MESSAGE_MAX_CHARS + 500)}**`,
  );
  assert.ok(chunks.length > 1);
  assert.ok(
    chunks.every((chunk) => chunk.length <= TELEGRAM_RICH_MESSAGE_MAX_CHARS),
  );
  assert.ok(chunks.every((chunk) => chunk.startsWith("**")));
  assert.ok(chunks.every((chunk) => chunk.endsWith("**")));
  assert.equal(
    chunks
      .map((chunk) => chunk.slice(2, -2).length)
      .reduce((sum, length) => sum + length, 0),
    TELEGRAM_RICH_MESSAGE_MAX_CHARS + 500,
  );
});

test("Native Markdown splitter respects the rich-message block limit for lists", () => {
  const markdown = Array.from(
    { length: TELEGRAM_RICH_MESSAGE_MAX_BLOCKS + 5 },
    (_, index) => `- item ${index + 1}`,
  ).join("\n");
  const chunks = splitTelegramNativeMarkdown(markdown);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]?.split("\n").length, TELEGRAM_RICH_MESSAGE_MAX_BLOCKS);
  assert.equal(chunks[1]?.split("\n").length, 5);
});

test("Native Markdown delivery attaches reply metadata first and markup last", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const markdown = `${"a".repeat(TELEGRAM_RICH_MESSAGE_MAX_CHARS - 10)}\n\n${"b".repeat(30)}`;
  const lastId = await sendTelegramNativeMarkdownReply(
    7,
    42,
    markdown,
    {
      sendRichMessage: async (body) => {
        bodies.push(body);
        return { message_id: bodies.length };
      },
    },
    {
      replyMarkup: {
        inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
      },
    },
  );
  assert.equal(lastId, 2);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0]?.reply_parameters, {
    message_id: 42,
    allow_sending_without_reply: true,
  });
  assert.equal("reply_markup" in (bodies[0] ?? {}), true);
  assert.equal(bodies[0]?.reply_markup, undefined);
  assert.equal("reply_parameters" in (bodies[1] ?? {}), false);
  assert.deepEqual(bodies[1]?.reply_markup, {
    inline_keyboard: [[{ text: "ok", callback_data: "noop" }]],
  });
  assert.deepEqual(
    (bodies[0]?.rich_message as { markdown?: string })?.markdown,
    "a".repeat(TELEGRAM_RICH_MESSAGE_MAX_CHARS - 10),
  );
  assert.deepEqual(
    (bodies[1]?.rich_message as { markdown?: string })?.markdown,
    "b".repeat(30),
  );
});

test("Reply runtime sends plain replies using the requested parse mode", async () => {
  const sent: string[] = [];
  const messageId = await sendTelegramPlainReply(
    "hello",
    {
      renderTelegramMessage: (_text, options) => [
        { text: options?.mode === "html" ? "html" : "plain" },
      ],
      sendRenderedChunks: async (chunks) => {
        sent.push(chunks[0]?.text ?? "");
        return 7;
      },
    },
    { parseMode: "HTML" },
  );
  assert.equal(messageId, 7);
  assert.deepEqual(sent, ["html"]);
});

for (const unknownAck of [false, true]) {
  test(`Reply anchor ${unknownAck ? "is retained after unknown ACK" : "survives a rejected send"}`, async () => {
    const error = unknownAck ? new TelegramApiCommitUnknownError("sendVoice", new Error("Lost ACK")) : new Error("Rejected upload");
    await assert.rejects(withTelegramReplyParameters(7, 21, undefined, async (parameters) => {
      assert.equal(parameters?.message_id, 21);
      throw error;
    }), (caught) => caught === error);
    preserveTransportReplyDedupOnNextReset(7, 21);
    resetTransportReplyDedup();
    const anchors: Array<number | undefined> = [];
    for (const text of ["Fallback", "Following answer"]) {
      await sendTelegramNativeMarkdownReply(7, 21, text, {
        sendRichMessage: async (body) => { anchors.push(body.reply_parameters?.message_id); return { message_id: 100 }; },
      });
    }
    assert.deepEqual(anchors, [unknownAck ? undefined : 21, undefined]);
  });
}

test("A later chunk failure does not release an already delivered prompt anchor", async () => {
  let count = 0;
  await assert.rejects(sendTelegramRenderedChunks(7, [{ text: "First" }, { text: "Second" }], {
    sendMessage: async (body) => {
      count += 1;
      assert.equal(body.reply_parameters?.message_id, count === 1 ? 21 : undefined);
      if (count === 2) throw new Error("Second chunk rejected");
      return { message_id: 100 };
    },
    editMessage: async () => {},
  }, { replyToMessageId: 21 }), /Second chunk rejected/);
  await withTelegramReplyParameters(7, 21, undefined, async (parameters) => { assert.equal(parameters, undefined); });
});

test("Starting a new turn resets quoting behind the previous turn's queued final", async () => {
  const publication = createTelegramActivityPublicationRuntime();
  const anchors: Array<number | undefined> = [];
  const reply = async () => {
    await sendTelegramNativeMarkdownReply(7, 21, "Answer", {
      sendRichMessage: async (body) => { anchors.push(body.reply_parameters?.message_id); return { message_id: 100 }; },
    });
  };
  await reply();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const blocker = publication.enqueue(() => gate);
  const oldFinal = publication.enqueue(reply);
  const start = createAgentStartDedupHook(async () => {}, resetTransportReplyDedup, (task) => { void publication.enqueue(task); });
  try {
    await start({ type: "agent_start" }, {} as Parameters<typeof start>[1]);
    const first = publication.enqueue(reply);
    const following = publication.enqueue(reply);
    release();
    await Promise.all([blocker, oldFinal, first, following]);
    assert.deepEqual(anchors, [21, undefined, 21, undefined]);
  } finally { release(); publication.reset(); }
});

test("Late rejected reply cannot release a replacement generation's anchor", async () => {
  let reject!: (error: Error) => void;
  const original = withTelegramReplyParameters(7, 21, undefined, () => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const rejected = assert.rejects(original, /Old failure/);
  resetTransportReplyDedup();
  await withTelegramReplyParameters(7, 21, undefined, async () => {});
  reject(new Error("Old failure")); await rejected;
  await withTelegramReplyParameters(7, 21, undefined, async (parameters) => { assert.equal(parameters, undefined); });
});

for (const native of [false, true]) {
  test(`${native ? "Native" : "HTML"} rejected send preserves the first successful reply anchor`, async () => {
    const anchors: Array<number | undefined> = [];
    const send = async (body: { reply_parameters?: { message_id: number } }) => {
      anchors.push(body.reply_parameters?.message_id);
      if (anchors.length === 1) throw new Error("Rejected send");
      return { message_id: 100 };
    };
    const reply = () => native
      ? sendTelegramNativeMarkdownReply(7, 21, "Answer", { sendRichMessage: send })
      : sendTelegramRenderedChunks(7, [{ text: "Answer" }], { sendMessage: send, editMessage: async () => {} }, { replyToMessageId: 21 });
    await assert.rejects(reply(), /Rejected send/);
    await reply(); await reply();
    assert.deepEqual(anchors, [21, 21, undefined]);
  });
}

test("Transport reply dedup scopes repeated prompt message ids by chat and thread", () => {
  assert.equal(buildTelegramReplyParameters(1, 0), undefined);
  assert.deepEqual(buildTelegramReplyParameters(1, 42), {
    message_id: 42,
    allow_sending_without_reply: true,
  });
  assert.equal(buildTelegramReplyParameters(1, 42), undefined);
  assert.deepEqual(buildTelegramReplyParameters(2, 42), {
    message_id: 42,
    allow_sending_without_reply: true,
  });
  assert.deepEqual(
    buildTelegramReplyParameters(1, 42, { chatId: 1, threadId: 10 }),
    {
      message_id: 42,
      allow_sending_without_reply: true,
    },
  );
  assert.equal(
    buildTelegramReplyParameters(1, 42, { chatId: 1, threadId: 10 }),
    undefined,
  );
  assert.deepEqual(
    buildTelegramReplyParameters(1, 42, { chatId: 1, threadId: 11 }),
    {
      message_id: 42,
      allow_sending_without_reply: true,
    },
  );
  resetTransportReplyDedup();
  assert.deepEqual(buildTelegramReplyParameters(1, 42), {
    message_id: 42,
    allow_sending_without_reply: true,
  });
});

test("Transport reply dedup preserves a dispatch notice through one agent-start reset", () => {
  const target = { chatId: 1, threadId: 10 };
  assert.deepEqual(buildTelegramReplyParameters(1, 42, target), {
    message_id: 42,
    allow_sending_without_reply: true,
  });
  preserveTransportReplyDedupOnNextReset(1, 42, target);
  resetTransportReplyDedup();
  assert.equal(buildTelegramReplyParameters(1, 42, target), undefined);
  resetTransportReplyDedup();
  assert.deepEqual(buildTelegramReplyParameters(1, 42, target), {
    message_id: 42,
    allow_sending_without_reply: true,
  });
});

interface GuestPlaceholderTestTimer {
  id: number;
}

function createGuestPlaceholderTimers() {
  let nextId = 1;
  let currentMs = 0;
  const callbacks = new Map<number, { callback: () => void; ms: number }>();
  const scheduledDelays: number[] = [];
  return {
    scheduledDelays,
    now: () => currentMs,
    pendingCount: () => callbacks.size,
    advance(ms: number) {
      currentMs += ms;
    },
    setTimer(callback: () => void, ms: number) {
      scheduledDelays.push(ms);
      const timer = { id: nextId++ };
      callbacks.set(timer.id, { callback, ms });
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer(timer: ReturnType<typeof setTimeout>) {
      callbacks.delete((timer as unknown as GuestPlaceholderTestTimer).id);
    },
    async fire() {
      const entry = callbacks.entries().next();
      if (entry.done) throw new Error("No guest placeholder timer is pending");
      const [id, scheduled] = entry.value;
      callbacks.delete(id);
      currentMs += scheduled.ms;
      scheduled.callback();
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

test("Guest placeholder frames step the globe every frame and grow the dots every two seconds", () => {
  assert.equal(TELEGRAM_GUEST_PLACEHOLDER_FRAME_MS, 1_000);
  assert.equal(TELEGRAM_GUEST_PLACEHOLDER_FRAMES.length, 6);
  assert.equal(
    buildTelegramGuestPlaceholderFrame(0),
    "<b>🌎 Working on it.</b>",
  );
  assert.equal(
    buildTelegramGuestPlaceholderFrame(1),
    "<b>🌍 Working on it.</b>",
  );
  assert.equal(
    buildTelegramGuestPlaceholderFrame(2),
    "<b>🌏 Working on it..</b>",
  );
  assert.equal(
    buildTelegramGuestPlaceholderFrame(3),
    "<b>🌎 Working on it..</b>",
  );
  assert.equal(
    buildTelegramGuestPlaceholderFrame(4),
    "<b>🌍 Working on it...</b>",
  );
  assert.equal(
    buildTelegramGuestPlaceholderFrame(5),
    "<b>🌏 Working on it...</b>",
  );
  assert.equal(
    buildTelegramGuestPlaceholderFrame(6),
    buildTelegramGuestPlaceholderFrame(0),
  );
  assert.equal(
    buildTelegramGuestPlaceholderFrame(-1),
    buildTelegramGuestPlaceholderFrame(5),
  );
});

test("Guest placeholder runtime edits the inline message once per interval", async () => {
  const edits: Array<[string, string]> = [];
  const timers = createGuestPlaceholderTimers();
  const runtime = createTelegramGuestPlaceholderRuntime({
    editGuestInlineMessage: async (inlineMessageId, content) => {
      edits.push([inlineMessageId, content.text]);
    },
    intervalMs: 1_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  runtime.start("inline-1");
  assert.deepEqual(edits, []);
  assert.equal(timers.pendingCount(), 1);
  assert.deepEqual(timers.scheduledDelays, [1_000]);
  await timers.fire();
  assert.deepEqual(edits, [["inline-1", "<b>🌍 Working on it.</b>"]]);
  assert.equal(timers.pendingCount(), 1);
  await timers.fire();
  assert.deepEqual(edits[1], ["inline-1", "<b>🌏 Working on it..</b>"]);
  await timers.fire();
  assert.deepEqual(edits[2], ["inline-1", "<b>🌎 Working on it..</b>"]);
  await runtime.stop("inline-1");
  assert.equal(timers.pendingCount(), 0);
});

test("Guest placeholder dismissal stops rotation and visually clears the inline message", async () => {
  const edits: Array<[string, string, string]> = [];
  const timers = createGuestPlaceholderTimers();
  const runtime = createTelegramGuestPlaceholderRuntime({
    editGuestInlineMessage: async (inlineMessageId, content) => {
      edits.push([inlineMessageId, content.text, content.parseMode]);
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  runtime.start("inline-1");
  await runtime.dismiss("inline-1");
  assert.equal(timers.pendingCount(), 0);
  assert.deepEqual(edits, [[
    "inline-1",
    TELEGRAM_DISMISSED_GUEST_PLACEHOLDER_TEXT,
    "HTML",
  ]]);
});

test("Guest placeholder rotation completes whole cycles for at least 20 seconds and holds the final frame", async () => {
  const edits: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const timers = createGuestPlaceholderTimers();
  const runtime = createTelegramGuestPlaceholderRuntime({
    editGuestInlineMessage: async (_inlineMessageId, content) => {
      edits.push(content.text);
    },
    recordRuntimeEvent: (_category, _error, details) => {
      events.push(details ?? {});
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: timers.now,
  });
  assert.equal(TELEGRAM_GUEST_PLACEHOLDER_MIN_MS, 20_000);
  assert.equal(TELEGRAM_GUEST_PLACEHOLDER_MAX_MS, 26_000);
  runtime.start("inline-1");
  for (let fired = 0; fired < 40 && timers.pendingCount() > 0; fired += 1) {
    await timers.fire();
  }
  // Four full six-frame cycles end with the cycle's last frame at 23 s.
  assert.equal(edits.length, 23);
  assert.equal(edits.at(-1), "<b>🌏 Working on it...</b>");
  assert.equal(timers.pendingCount(), 0);
  assert.deepEqual(events, [
    {
      phase: "guest-placeholder-capped",
      minMs: 20_000,
      maxMs: 26_000,
      elapsedMs: 23_000,
      step: 23,
    },
  ]);
  await runtime.stop("inline-1");
});

test("Guest placeholder rotation still finishes a whole cycle when frames run slower", async () => {
  const edits: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const timers = createGuestPlaceholderTimers();
  const runtime = createTelegramGuestPlaceholderRuntime({
    editGuestInlineMessage: async (_inlineMessageId, content) => {
      edits.push(content.text);
    },
    recordRuntimeEvent: (_category, _error, details) => {
      events.push(details ?? {});
    },
    intervalMs: 1_300,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: timers.now,
  });
  runtime.start("inline-1");
  for (let fired = 0; fired < 40 && timers.pendingCount() > 0; fired += 1) {
    await timers.fire();
  }
  // The first cycle end at/after 20 s is step 17 (three cycles at 1.3 s frames).
  assert.equal(edits.length, 17);
  assert.equal(edits.at(-1), "<b>🌏 Working on it...</b>");
  assert.deepEqual(events, [
    {
      phase: "guest-placeholder-capped",
      minMs: 20_000,
      maxMs: 26_000,
      elapsedMs: 22_100,
      step: 17,
    },
  ]);
  await runtime.stop("inline-1");
});

test("Guest placeholder safety bound stops a slow stream mid-cycle instead of reaching the flood wall", async () => {
  const edits: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const timers = createGuestPlaceholderTimers();
  const runtime = createTelegramGuestPlaceholderRuntime({
    editGuestInlineMessage: async (_inlineMessageId, content) => {
      edits.push(content.text);
      timers.advance(1_800);
    },
    recordRuntimeEvent: (_category, _error, details) => {
      events.push(details ?? {});
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: timers.now,
  });
  runtime.start("inline-1");
  for (let fired = 0; fired < 40 && timers.pendingCount() > 0; fired += 1) {
    await timers.fire();
  }
  assert.equal(edits.length, 9);
  assert.equal(edits.at(-1), "<b>🌎 Working on it..</b>");
  assert.deepEqual(events, [
    {
      phase: "guest-placeholder-capped",
      minMs: 20_000,
      maxMs: 26_000,
      elapsedMs: 25_200,
      step: 9,
    },
  ]);
  await runtime.stop("inline-1");
});

test("Guest placeholder stop waits for the in-flight frame and cancels the loop", async () => {
  const edits: string[] = [];
  let releaseEdit: (() => void) | undefined;
  const timers = createGuestPlaceholderTimers();
  const runtime = createTelegramGuestPlaceholderRuntime({
    editGuestInlineMessage: async (_inlineMessageId, content) => {
      edits.push(content.text);
      await new Promise<void>((resolve) => {
        releaseEdit = resolve;
      });
    },
    intervalMs: 1_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  runtime.start("inline-1");
  await timers.fire();
  assert.equal(edits.length, 1);
  let settled = false;
  const stopping = runtime.stop("inline-1").then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseEdit?.();
  await stopping;
  assert.equal(settled, true);
  assert.equal(timers.pendingCount(), 0);
  await runtime.stop("inline-1");
});

test("Guest placeholder edit failures stay fail-open and honor retry_after", async () => {
  const events: Array<Record<string, unknown>> = [];
  const timers = createGuestPlaceholderTimers();
  let attempts = 0;
  const runtime = createTelegramGuestPlaceholderRuntime({
    editGuestInlineMessage: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("Too Many Requests"), {
          retryAfterSeconds: 2,
        });
      }
    },
    recordRuntimeEvent: (_category, _error, details) => {
      events.push(details ?? {});
    },
    intervalMs: 1_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  runtime.start("inline-1");
  await timers.fire();
  assert.deepEqual(events, [
    { phase: "guest-placeholder-edit", retryAfterMs: 2_000 },
  ]);
  assert.deepEqual(timers.scheduledDelays, [1_000, 2_000]);
  await timers.fire();
  assert.equal(attempts, 2);
  assert.deepEqual(timers.scheduledDelays, [1_000, 2_000, 1_000]);
  await runtime.stop("inline-1");
});

test("Guest placeholder stopAll cancels every pending loop", async () => {
  const timers = createGuestPlaceholderTimers();
  const runtime = createTelegramGuestPlaceholderRuntime({
    editGuestInlineMessage: async () => {},
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  runtime.start("inline-1");
  runtime.start("inline-2");
  assert.equal(timers.pendingCount(), 2);
  runtime.stopAll();
  assert.equal(timers.pendingCount(), 0);
  await runtime.stop("inline-1");
});

test("Markdown fences open on three markers and close only on a long-enough matching run", () => {
  assert.equal(parseTelegramMarkdownFenceOpening("plain"), undefined);
  assert.equal(parseTelegramMarkdownFenceOpening("    ```"), undefined);
  const fence = parseTelegramMarkdownFenceOpening("  ````ts");
  assert.deepEqual(fence, { marker: "`", length: 4 });
  assert.equal(isTelegramMarkdownFenceClosing("```", fence!), false);
  assert.equal(isTelegramMarkdownFenceClosing("~~~~", fence!), false);
  assert.equal(isTelegramMarkdownFenceClosing("````` ", fence!), true);
  assert.equal(isTelegramMarkdownFenceClosing("```` code", fence!), false);
});
