/**
 * Regression tests for Telegram outbound handler helpers
 * Exercises assistant-authored voice/button markup extraction, artifact generation, callbacks, and Telegram upload wiring
 */

import assert from "node:assert/strict";
import test from "node:test";

import { resetTransportReplyDedup } from "../lib/replies.ts";

test.beforeEach(() => {
  resetTransportReplyDedup();
  clearTelegramVoiceProviders();
});

import {
  createTelegramButtonActionStore,
  createTelegramButtonPromptTurn,
  createTelegramOutboundReplyArtifactSender,
  createTelegramOutboundTextPreviewRuntime,
  createTelegramOutboundTextReplyRuntime,
  createTelegramVoiceReplySender,
  getTelegramOutboundProgrammaticHandlers,
  handleTelegramButtonCallbackQuery,
  hasTelegramOutboundHandler,
  planTelegramButtonReply,
  planTelegramVoiceReply,
  registerTelegramOutboundHandler,
  registerTelegramVoiceProvider,
  getTelegramVoiceProviders,
  hasTelegramVoiceProvider,
  clearTelegramVoiceProviders,
  stripTelegramCommentMarkupForPreview,
  stripTelegramVoiceMarkupForPreview,
} from "../lib/outbound-handlers.ts";

const testReplyMarkup = {
  inline_keyboard: [[{ text: "Continue", callback_data: "btn:1" }]],
};

test("Outbound text handler transforms text and markdown replies", async () => {
  const sent: string[] = [];
  const markdownOptions: unknown[] = [];
  const calls: Array<{ command: string; stdin?: string }> = [];
  const runtime = createTelegramOutboundTextReplyRuntime({
    getHandlers: () => [{ type: "text", template: "/tools/translate" }],
    execCommand: async (command, _args, options) => {
      calls.push({ command, stdin: options?.stdin });
      return {
        stdout: `translated:${options?.stdin ?? ""}`,
        stderr: "",
        code: 0,
        killed: false,
      };
    },
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      sent.push(`text:${text}`);
      return 1;
    },
    sendMarkdownReply: async (
      _chatId,
      _replyToMessageId,
      markdown,
      options,
    ) => {
      sent.push(`markdown:${markdown}`);
      markdownOptions.push(options);
      return 2;
    },
  });
  assert.equal(await runtime.sendTextReply(1, 2, "hello"), 1);
  assert.equal(
    await runtime.sendMarkdownReply(1, 2, "**hello**", {
      replyMarkup: testReplyMarkup,
    }),
    2,
  );
  assert.deepEqual(calls, [
    { command: "/tools/translate", stdin: "hello" },
    { command: "/tools/translate", stdin: "**hello**" },
    { command: "/tools/translate", stdin: "Continue" },
  ]);
  assert.deepEqual(sent, [
    "text:translated:hello",
    "markdown:translated:**hello**",
  ]);
  assert.deepEqual(markdownOptions, [
    {
      replyMarkup: {
        inline_keyboard: [
          [{ text: "translated:Continue", callback_data: "btn:1" }],
        ],
      },
    },
  ]);
});

test("Outbound text handler preserves inline buttons on transformed replies", async () => {
  const sent: Array<{ markdown: string; replyMarkup: unknown }> = [];
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    ["Answer.", "", "<!-- telegram_button: Continue -->"].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );
  const runtime = createTelegramOutboundTextReplyRuntime({
    getHandlers: () => [{ type: "text", template: "/tools/translate" }],
    execCommand: async (_command, _args, options) => ({
      stdout: `translated:${options?.stdin ?? ""}`,
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendTextReply: async () => 1,
    sendMarkdownReply: async (
      _chatId,
      _replyToMessageId,
      markdown,
      options,
    ) => {
      sent.push({ markdown, replyMarkup: options?.replyMarkup });
      return 2;
    },
  });
  await runtime.sendMarkdownReply(1, 2, plan.markdown, {
    replyMarkup: plan.replyMarkup,
  });
  assert.deepEqual(actions, [{ text: "Continue", prompt: "Continue" }]);
  assert.deepEqual(sent, [
    {
      markdown: "translated:Answer.",
      replyMarkup: {
        inline_keyboard: [
          [{ text: "translated:Continue", callback_data: "btn:1" }],
        ],
      },
    },
  ]);
});

test("Outbound text handler transforms finalized markdown previews", async () => {
  const finalized: string[] = [];
  const previewOptions: unknown[] = [];
  const runtime = createTelegramOutboundTextPreviewRuntime({
    getHandlers: () => [{ type: "text", template: "/tools/translate" }],
    execCommand: async (_command, _args, options) => ({
      stdout: `translated:${options?.stdin ?? ""}`,
      stderr: "",
      code: 0,
      killed: false,
    }),
    finalizeMarkdownPreview: async (
      _chatId,
      markdown,
      _replyToMessageId,
      options,
    ) => {
      finalized.push(markdown);
      previewOptions.push(options);
      return true;
    },
  });
  assert.equal(
    await runtime.finalizeMarkdownPreview(1, "**hello**", 2, {
      replyMarkup: testReplyMarkup,
    }),
    true,
  );
  assert.deepEqual(finalized, ["translated:**hello**"]);
  assert.deepEqual(previewOptions, [
    {
      replyMarkup: {
        inline_keyboard: [
          [{ text: "translated:Continue", callback_data: "btn:1" }],
        ],
      },
    },
  ]);
});

test("Outbound text handler keeps original reply on failure", async () => {
  const events: string[] = [];
  const sent: string[] = [];
  const runtime = createTelegramOutboundTextReplyRuntime({
    getHandlers: () => [{ type: "text", template: "/tools/fail" }],
    execCommand: async () => ({
      stdout: "",
      stderr: "boom",
      code: 1,
      killed: false,
    }),
    sendTextReply: async (_chatId, _replyToMessageId, text) => {
      sent.push(text);
      return 1;
    },
    sendMarkdownReply: async () => 2,
    recordRuntimeEvent: (category) => {
      events.push(category);
    },
  });
  assert.equal(await runtime.sendTextReply(1, 2, "original"), 1);
  assert.deepEqual(sent, ["original"]);
  assert.deepEqual(events, ["outbound-text-handler"]);
});

test("Voice reply planner extracts multiline telegram_voice comments", () => {
  const plan = planTelegramVoiceReply(
    [
      "Technical answer.",
      "",
      "<!-- telegram_voice lang=ru rate=+20%",
      "Short speakable summary.",
      "-->",
    ].join("\n"),
  );
  assert.deepEqual(plan, {
    markdown: "Technical answer.",
    voiceText: "Short speakable summary.",
    voiceReplies: [
      { text: "Short speakable summary.", lang: "ru", rate: "+20%" },
    ],
    lang: "ru",
    rate: "+20%",
  });
});

test("Voice reply planner supports compact inline comments", () => {
  const plan = planTelegramVoiceReply(
    "Text before.\n\n<!-- telegram_voice: Inline summary. -->",
  );
  assert.deepEqual(plan, {
    markdown: "Text before.",
    voiceText: "Inline summary.",
    voiceReplies: [{ text: "Inline summary." }],
  });
});

test("Voice reply planner supports text attribute comments", () => {
  const plan = planTelegramVoiceReply(
    'Text before.\n\n<!-- telegram_voice lang=ru rate=+10% text="Inline spoken summary." -->',
  );
  assert.deepEqual(plan, {
    markdown: "Text before.",
    voiceText: "Inline spoken summary.",
    voiceReplies: [
      { text: "Inline spoken summary.", lang: "ru", rate: "+10%" },
    ],
    lang: "ru",
    rate: "+10%",
  });
});

test("Voice reply planner recovers one-line action bodies", () => {
  const plan = planTelegramVoiceReply(
    [
      "Text before.",
      "",
      "<!-- telegram_voice lang=ru rate=+30% -->",
      "Speak this instead of leaking it as text.",
      "-->",
    ].join("\n"),
  );
  assert.deepEqual(plan, {
    markdown: "Text before.",
    voiceText: "Speak this instead of leaking it as text.",
    voiceReplies: [
      {
        text: "Speak this instead of leaking it as text.",
        lang: "ru",
        rate: "+30%",
      },
    ],
    lang: "ru",
    rate: "+30%",
  });
});

test("Voice reply planner keeps multiple telegram_voice blocks as independent artifacts", () => {
  const plan = planTelegramVoiceReply(
    [
      "Technical answer.",
      "",
      "<!-- telegram_voice lang=ru rate=+20%",
      "First summary.",
      "-->",
      "",
      "<!-- telegram_voice lang=en rate=+10%",
      "Second summary.",
      "-->",
    ].join("\n"),
  );
  assert.deepEqual(plan, {
    markdown: "Technical answer.",
    voiceText: "First summary.\n\nSecond summary.",
    voiceReplies: [
      { text: "First summary.", lang: "ru", rate: "+20%" },
      { text: "Second summary.", lang: "en", rate: "+10%" },
    ],
    lang: "en",
    rate: "+10%",
  });
});

test("Voice reply planner strips non-voice comments from delivered markdown", () => {
  const plan = planTelegramVoiceReply(
    ["Visible text.", "", "<!-- internal note -->", "", "Visible tail."].join(
      "\n",
    ),
  );
  assert.deepEqual(plan, {
    markdown: "Visible text.\n\nVisible tail.",
  });
});

test("Voice preview stripping hides closed and currently open telegram_voice blocks", () => {
  assert.equal(
    stripTelegramVoiceMarkupForPreview(
      [
        "Visible text.",
        "",
        "<!-- telegram_voice lang=ru rate=+30%",
        "Hidden voice text streaming now",
      ].join("\n"),
    ),
    "Visible text.",
  );
  assert.equal(
    stripTelegramVoiceMarkupForPreview(
      [
        "Visible text.",
        "",
        "<!-- telegram_voice",
        "Hidden voice text.",
        "-->",
        "",
        "Visible tail.",
      ].join("\n"),
    ),
    "Visible text.\n\nVisible tail.",
  );
});

test("Comment preview stripping hides generic and partial comments", () => {
  assert.equal(
    stripTelegramCommentMarkupForPreview(
      "Visible text.\n\n<!-- hidden -->\n\nVisible tail.",
    ),
    "Visible text.\n\nVisible tail.",
  );
  assert.equal(
    stripTelegramCommentMarkupForPreview(
      [
        "Visible text.",
        "",
        '<!-- telegram_button label="Hidden" -->',
        "Hidden prompt.",
        "-->",
      ].join("\n"),
    ),
    "Visible text.",
  );
  assert.equal(
    stripTelegramCommentMarkupForPreview("Visible text.\n\n<"),
    "Visible text.",
  );
  assert.equal(
    stripTelegramCommentMarkupForPreview("Visible text.\n\n<!"),
    "Visible text.",
  );
  assert.equal(
    stripTelegramCommentMarkupForPreview("Visible text.\n\n<!-"),
    "Visible text.",
  );
  assert.equal(
    stripTelegramCommentMarkupForPreview(
      "Visible text.\n\n<!-- internal note streaming",
    ),
    "Visible text.",
  );
});

test("Outbound comments inside fenced code stay literal", () => {
  const markdown = [
    "Example:",
    "",
    "```md",
    "<!-- telegram_voice lang=ru",
    "Do not speak.",
    "-->",
    "",
    '<!-- telegram_button label="Run"',
    "Do not queue.",
    "-->",
    "```",
  ].join("\n");
  const actions: unknown[] = [];
  assert.deepEqual(planTelegramVoiceReply(markdown), { markdown });
  assert.deepEqual(
    planTelegramButtonReply(markdown, {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    }),
    { markdown },
  );
  assert.deepEqual(actions, []);
  assert.equal(stripTelegramCommentMarkupForPreview(markdown), markdown);
});

test("Outbound comments resume after indented and longer closing fences", () => {
  const markdown = [
    "Example:",
    "",
    "````md",
    "<!-- telegram_button label=Skip -->",
    "   ````",
    "",
    "<!-- telegram_button: OK -->",
  ].join("\n");
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(markdown, {
    registerAction: (action) => {
      actions.push(action);
      return `btn:${actions.length}`;
    },
  });
  assert.equal(
    plan.markdown,
    [
      "Example:",
      "",
      "````md",
      "<!-- telegram_button label=Skip -->",
      "   ````",
    ].join("\n"),
  );
  assert.deepEqual(actions, [{ text: "OK", prompt: "OK" }]);
});

test("Outbound action comments require top-level column-zero markers", () => {
  const markdown = [
    "Visible answer.",
    "",
    "  <!-- telegram_voice lang=ru",
    "Indented voice.",
    "  -->",
    "",
    '> <!-- telegram_button label="OK"',
    "> Quoted prompt.",
    "> -->",
  ].join("\n");
  const actions: unknown[] = [];
  assert.deepEqual(planTelegramVoiceReply(markdown), { markdown });
  assert.deepEqual(
    planTelegramButtonReply(markdown, {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    }),
    { markdown },
  );
  assert.deepEqual(actions, []);
});

test("Button reply planner supports independent label blocks", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      "Visible answer.",
      "",
      '<!-- telegram_button label="OK"',
      "PROMPT",
      "-->",
      "",
      "<!-- telegram_button label='More'",
      "Continue with more detail",
      "-->",
    ].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );
  assert.equal(plan.markdown, "Visible answer.");
  assert.deepEqual(actions, [
    { text: "OK", prompt: "PROMPT" },
    { text: "More", prompt: "Continue with more detail" },
  ]);
  assert.deepEqual(plan.replyMarkup, {
    inline_keyboard: [
      [{ text: "OK", callback_data: "btn:1" }],
      [{ text: "More", callback_data: "btn:2" }],
    ],
  });
});

test("Button reply planner supports colon label-only shortcut", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    ["Visible answer.", "", "<!-- telegram_button: OK -->"].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );
  assert.equal(plan.markdown, "Visible answer.");
  assert.deepEqual(actions, [{ text: "OK", prompt: "OK" }]);
  assert.deepEqual(plan.replyMarkup, {
    inline_keyboard: [[{ text: "OK", callback_data: "btn:1" }]],
  });
});

test("Button reply planner supports prompt attribute shortcut", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      "Visible answer.",
      "",
      '<!-- telegram_button label=Continue prompt="Continue with the current plan." -->',
    ].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );
  assert.equal(plan.markdown, "Visible answer.");
  assert.deepEqual(actions, [
    { text: "Continue", prompt: "Continue with the current plan." },
  ]);
  assert.deepEqual(plan.replyMarkup, {
    inline_keyboard: [[{ text: "Continue", callback_data: "btn:1" }]],
  });
});

test("Button reply planner recovers one-line action bodies", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      "Visible answer.",
      "",
      '<!-- telegram_button label="Boundary" -->',
      "Where does JAM end and DEOS begin?",
      "-->",
      "",
      '<!-- telegram_button label="Sources" -->',
      "Which DEOS sources are canonical?",
      "-->",
    ].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );
  assert.equal(plan.markdown, "Visible answer.");
  assert.deepEqual(actions, [
    { text: "Boundary", prompt: "Where does JAM end and DEOS begin?" },
    { text: "Sources", prompt: "Which DEOS sources are canonical?" },
  ]);
  assert.deepEqual(plan.replyMarkup, {
    inline_keyboard: [
      [{ text: "Boundary", callback_data: "btn:1" }],
      [{ text: "Sources", callback_data: "btn:2" }],
    ],
  });
});

test("Button reply planner requires prompt attribute for closed heads", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      "Visible answer.",
      "",
      '<!-- telegram_button label="Closed" -->',
      "",
      "Visible tail.",
    ].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );
  assert.equal(plan.markdown, "Visible answer.\n\nVisible tail.");
  assert.deepEqual(actions, []);
});

test("Button reply planner bounds inline-closed body recovery", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      "Visible answer.",
      "",
      '<!-- telegram_button label="Long" -->',
      "First body line.",
      "Second body line.",
      "-->",
    ].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );
  assert.equal(
    plan.markdown,
    [
      "Visible answer.",
      "",
      "First body line.",
      "Second body line.",
      "-->",
    ].join("\n"),
  );
  assert.deepEqual(actions, []);
});

test("Button action store resolves generated callback data", () => {
  const store = createTelegramButtonActionStore();
  const callbackData = store.register({ text: "Next", prompt: "Go next" });
  assert.match(callbackData, /^tgbtn:[a-f0-9-]+/);
  assert.deepEqual(store.resolve(callbackData), {
    text: "Next",
    prompt: "Go next",
  });
  assert.equal(store.resolve("other:1"), undefined);
});

test("Button callback handler enqueues prompt actions", async () => {
  const events: unknown[] = [];
  await assert.equal(
    await handleTelegramButtonCallbackQuery(
      {
        id: "callback-1",
        data: "btn:1",
        message: { message_id: 22, chat: { id: 7 } },
      },
      { id: "ctx" },
      {
        resolveAction: () => ({ text: "Continue", prompt: "Continue now" }),
        answerCallbackQuery: async (id, text) => {
          events.push({ answer: id, text });
        },
        enqueueButtonPrompt: (query, action, ctx) => {
          events.push({ query, action, ctx });
        },
      },
    ),
    true,
  );
  assert.deepEqual(events, [
    {
      query: {
        id: "callback-1",
        data: "btn:1",
        message: { message_id: 22, chat: { id: 7 } },
      },
      action: { text: "Continue", prompt: "Continue now" },
      ctx: { id: "ctx" },
    },
    { answer: "callback-1", text: "Queued." },
  ]);
});

test("Button callback handler consumes expired button callbacks", async () => {
  const events: unknown[] = [];
  assert.equal(
    await handleTelegramButtonCallbackQuery(
      { id: "callback-1", data: "tgbtn:missing" },
      {},
      {
        resolveAction: () => undefined,
        answerCallbackQuery: async (id, text) => {
          events.push({ id, text });
        },
        enqueueButtonPrompt: () => {
          events.push("unexpected:enqueue");
        },
      },
    ),
    true,
  );
  assert.deepEqual(events, [
    { id: "callback-1", text: "Button action expired." },
  ]);
});

test("Button prompt turns use Telegram prompt content", () => {
  assert.deepEqual(
    createTelegramButtonPromptTurn({
      chatId: 7,
      replyToMessageId: 22,
      queueOrder: 3,
      action: { text: "Continue", prompt: "Continue now" },
    }),
    {
      kind: "prompt",
      chatId: 7,
      replyToMessageId: 22,
      sourceMessageIds: [22],
      queueOrder: 3,
      queueLane: "default",
      laneOrder: 3,
      queuedAttachments: [],
      content: [{ type: "text", text: "[telegram] Continue now" }],
      historyText: "Continue now",
      statusSummary: "Continue",
    },
  );
  assert.deepEqual(testReplyMarkup, {
    inline_keyboard: [[{ text: "Continue", callback_data: "btn:1" }]],
  });
});

test("Voice reply sender can suppress prompt reply metadata for secondary voice", async () => {
  const events: unknown[] = [];
  const dispose = registerTelegramVoiceProvider(async () => "/tmp/voice.opus");
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    sendMultipart: async (method, fields, fileField, filePath, fileName) => {
      events.push({ method, fields, fileField, filePath, fileName });
    },
  });
  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello", {
    replyToPrompt: false,
  });
  assert.deepEqual(events, [
    {
      method: "sendVoice",
      fields: { chat_id: "10" },
      fileField: "voice",
      filePath: "/tmp/voice.opus",
      fileName: "voice.opus",
    },
  ]);
  dispose();
});

test("Outbound artifact sender sends multiple voice replies independently", async () => {
  const events: unknown[] = [];
  const dispose = registerTelegramVoiceProvider(async (text) => {
    return `/tmp/${text}.opus`;
  });
  const sendOutboundReplyArtifacts = createTelegramOutboundReplyArtifactSender({
    execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    sendMultipart: async (method, fields, fileField, filePath, fileName) => {
      events.push({ method, fields, fileField, filePath, fileName });
    },
  });
  await sendOutboundReplyArtifacts(
    { chatId: 10, replyToMessageId: 20 },
    {
      voiceReplies: [
        { text: "one", lang: "ru" },
        { text: "two", lang: "en" },
      ],
    },
    { replyToPrompt: true },
  );
  assert.deepEqual(events, [
    {
      method: "sendVoice",
      fields: {
        chat_id: "10",
        reply_parameters:
          '{"message_id":20,"allow_sending_without_reply":true}',
      },
      fileField: "voice",
      filePath: "/tmp/one.opus",
      fileName: "one.opus",
    },
    {
      method: "sendVoice",
      fields: { chat_id: "10" },
      fileField: "voice",
      filePath: "/tmp/two.opus",
      fileName: "two.opus",
    },
  ]);
  dispose();
});

test("Voice reply sender falls back to the next voice provider", async () => {
  const events: unknown[] = [];
  const dispose1 = registerTelegramVoiceProvider(async () => {
    throw new Error("provider 1 failed");
  });
  const dispose2 = registerTelegramVoiceProvider(async () => {
    return "/tmp/good.opus";
  });
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    sendMultipart: async (method, fields, fileField, filePath, fileName) => {
      events.push({ method, fields, fileField, filePath, fileName });
    },
  });
  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello");
  assert.deepEqual(events, [
    {
      method: "sendVoice",
      fields: {
        chat_id: "10",
        reply_parameters:
          '{"message_id":20,"allow_sending_without_reply":true}',
      },
      fileField: "voice",
      filePath: "/tmp/good.opus",
      fileName: "good.opus",
    },
  ]);
  dispose1();
  dispose2();
});

test("Voice reply sender uploads generated ogg via sendVoice", async () => {
  const events: unknown[] = [];
  const dispose = registerTelegramVoiceProvider(async () => "/tmp/voice.opus");
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    sendMultipart: async (method, fields, fileField, filePath, fileName) => {
      events.push({ method, fields, fileField, filePath, fileName });
    },
  });
  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello");
  assert.deepEqual(events, [
    {
      method: "sendVoice",
      fields: {
        chat_id: "10",
        reply_parameters:
          '{"message_id":20,"allow_sending_without_reply":true}',
      },
      fileField: "voice",
      filePath: "/tmp/voice.opus",
      fileName: "voice.opus",
    },
  ]);
});

// --- Critical-step composition tests ---

// --- Combined profile: CI-like pipeline (composition + retry + critical) ---

test("Voice provider registration and invocation", async () => {
  clearTelegramVoiceProviders();
  const calls: string[] = [];
  assert.equal(hasTelegramVoiceProvider(), false);
  const dispose = registerTelegramVoiceProvider(async (text) => {
    calls.push(text);
    return `/tmp/voice-${text.length}.opus`;
  });
  assert.equal(hasTelegramVoiceProvider(), true);
  const providers = getTelegramVoiceProviders();
  assert.equal(providers.length, 1);
  const result = await providers[0]("hello", {});
  assert.equal(result, "/tmp/voice-5.opus");
  assert.deepEqual(calls, ["hello"]);
  dispose();
  assert.equal(hasTelegramVoiceProvider(), false);
});

test("Voice provider registry supports multiple providers", async () => {
  clearTelegramVoiceProviders();
  assert.equal(getTelegramVoiceProviders().length, 0);
  const dispose1 = registerTelegramVoiceProvider(async () => "/tmp/voice1.opus");
  const dispose2 = registerTelegramVoiceProvider(async () => "/tmp/voice2.opus");
  assert.equal(getTelegramVoiceProviders().length, 2);
  assert.equal(hasTelegramVoiceProvider(), true);
  // returned array should be a copy
  const providers = getTelegramVoiceProviders();
  providers.pop();
  assert.equal(getTelegramVoiceProviders().length, 2);
  dispose1();
  assert.equal(getTelegramVoiceProviders().length, 1);
  dispose2();
  assert.equal(getTelegramVoiceProviders().length, 0);
});

test("Voice reply sender passes replyMarkup to sendMultipart", async () => {
  const fields: Record<string, unknown>[] = [];
  const dispose = registerTelegramVoiceProvider( async () => "/tmp/voice.opus");
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async (_method, f) => {
      fields.push(f);
    },
    recordRuntimeEvent: () => {},
  });
  await sendVoiceReply(
    { chatId: 10, replyToMessageId: 20 },
    "hello",
    {
      replyMarkup: { inline_keyboard: [[{ text: "OK", callback_data: "btn:1" }]] },
    },
  );
  assert.equal(fields.length, 1);
  assert.ok(
    typeof (fields[0] as Record<string, unknown>).reply_markup === "string",
  );
  dispose();
});

test("Voice reply sender only passes replyMarkup to first successful voice reply", async () => {
  const fields: Record<string, unknown>[] = [];
  const disposeFail = registerTelegramVoiceProvider(async () => {
    throw new Error("Provider 1 failed");
  });
  const disposeSuccess = registerTelegramVoiceProvider(async () => "/tmp/voice.opus");
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async (_method, f) => {
      fields.push(f);
    },
    recordRuntimeEvent: () => {},
  });
  await sendVoiceReply(
    { chatId: 10, replyToMessageId: 20 },
    "hello",
    {
      replyMarkup: { inline_keyboard: [[{ text: "OK", callback_data: "btn:1" }]] },
    },
  );
  assert.equal(fields.length, 1);
  assert.ok(
    typeof (fields[0] as Record<string, unknown>).reply_markup === "string",
  );
  disposeFail();
  disposeSuccess();
});

test("Voice reply sender throws when every handler fails", async () => {
  clearTelegramVoiceProviders();
  const events: unknown[] = [];
  const dispose = registerTelegramVoiceProvider( async () => {
    throw new Error("handler 1 failed");
  });
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({ stdout: "", stderr: "", code: 1, killed: false }),
    sendMultipart: async () => {
      events.push("sendMultipart");
    },
    recordRuntimeEvent: (category, error) => {
      events.push(`error:${category}:${(error as Error).message}`);
    },
  });
  await assert.rejects(
    async () =>
      await sendVoiceReply(
        { chatId: 1, replyToMessageId: 2 },
        "hello",
        { replyToPrompt: false },
      ),
    /Failed to send voice reply: every voice provider failed/,
  );
  dispose();
  assert.equal(hasTelegramVoiceProvider(), false);
  assert.ok(events.length >= 2);
  assert.ok(events.some((e) => (e as string).includes("handler 1 failed")));
  assert.ok(events.some((e) => (e as string).includes("every voice provider failed")));
});

test("Voice reply sender skips provider that returns undefined and tries next", async () => {
  const events: unknown[] = [];
  const dispose1 = registerTelegramVoiceProvider(async () => undefined);
  const dispose2 = registerTelegramVoiceProvider(async () => "/tmp/voice.opus");
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    sendMultipart: async (method, fields, fileField, filePath, fileName) => {
      events.push({ method, fields, fileField, filePath, fileName });
    },
    recordRuntimeEvent: () => {},
  });
  await sendVoiceReply(
    { chatId: 10, replyToMessageId: 20 },
    "hello",
  );
  assert.equal(events.length, 1);
  assert.equal((events[0] as Record<string, unknown>).filePath, "/tmp/voice.opus");
  dispose1();
  dispose2();
});

test("Voice reply sender records event when provider returns empty string", async () => {
  const events: unknown[] = [];
  const dispose1 = registerTelegramVoiceProvider(async () => "");
  const dispose2 = registerTelegramVoiceProvider(async () => "/tmp/voice.opus");
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async () => {},
    recordRuntimeEvent: (category, error, details) => {
      events.push(`error:${category}:${(error as Error).message}:${details?.phase}`);
    },
  });
  await sendVoiceReply(
    { chatId: 10, replyToMessageId: 20 },
    "hello",
  );
  assert.ok(events.some((e) => (e as string).includes("voice-provider-skip")));
  dispose1();
  dispose2();
});

test("Voice reply sender accepts Opus files", async () => {
  const events: unknown[] = [];
  const dispose = registerTelegramVoiceProvider(async () => "/tmp/response.opus");
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    sendMultipart: async (_method, _fields, _fileField, filePath, fileName) => {
      events.push({ filePath, fileName });
    },
    recordRuntimeEvent: () => {},
  });
  await sendVoiceReply(
    { chatId: 10, replyToMessageId: 20 },
    "hello",
  );
  const fileEvent = events.find((e) =>
    (e as Record<string, unknown>).filePath !== undefined,
  ) as Record<string, unknown>;
  assert.equal(fileEvent.filePath, "/tmp/response.opus");
  assert.equal(fileEvent.fileName, "response.opus");
  dispose();
});

test("Voice reply sender accepts OGG files", async () => {
  const events: unknown[] = [];
  const dispose = registerTelegramVoiceProvider(async () => "/tmp/response.ogg");
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    sendMultipart: async (_method, _fields, _fileField, filePath, fileName) => {
      events.push({ filePath, fileName });
    },
    recordRuntimeEvent: () => {},
  });
  await sendVoiceReply(
    { chatId: 10, replyToMessageId: 20 },
    "hello",
  );
  const fileEvent = events.find((e) =>
    (e as Record<string, unknown>).filePath !== undefined,
  ) as Record<string, unknown>;
  assert.equal(fileEvent.filePath, "/tmp/response.ogg");
  assert.equal(fileEvent.fileName, "response.ogg");
  dispose();
});

test("Voice reply sender throws for non-ogg files", async () => {
  const dispose = registerTelegramVoiceProvider(async () => "/tmp/response.mp3");
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    sendMultipart: async () => {
      throw new Error("should not be called");
    },
    recordRuntimeEvent: () => {},
  });
  await assert.rejects(
    sendVoiceReply(
      { chatId: 10, replyToMessageId: 20 },
      "hello",
    ),
    /Failed to send voice reply: every voice provider failed./,
  );
  dispose();
});

test("Voice reply sender falls back to next handler when sendMultipart throws", async () => {
  const fields: Record<string, unknown>[] = [];
  let callCount = 0;
  const dispose1 = registerTelegramVoiceProvider( async () => "/tmp/voice1.opus");
  const dispose2 = registerTelegramVoiceProvider( async () => "/tmp/voice2.opus");
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async (_method, f) => {
      callCount++;
      if (callCount === 1) throw new Error("network error");
      fields.push(f);
    },
    recordRuntimeEvent: () => {},
  });
  await sendVoiceReply(
    { chatId: 10, replyToMessageId: 20 },
    "hello",
  );
  assert.equal(callCount, 2);
  assert.equal(fields.length, 1);
  assert.equal((fields[0] as Record<string, unknown>).chat_id, "10");
  dispose1();
  dispose2();
});

test("Voice reply sender accepts provider returning { audioPath }", async () => {
  const events: unknown[] = [];
  const dispose = registerTelegramVoiceProvider(async () => ({ audioPath: "/tmp/response.ogg" }));
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    sendMultipart: async (_method, _fields, _fileField, filePath, fileName) => {
      events.push({ filePath, fileName });
    },
    recordRuntimeEvent: () => {},
  });
  await sendVoiceReply(
    { chatId: 10, replyToMessageId: 20 },
    "hello",
  );
  const fileEvent = events.find((e) =>
    (e as Record<string, unknown>).filePath !== undefined,
  ) as Record<string, unknown>;
  assert.equal(fileEvent.filePath, "/tmp/response.ogg");
  assert.equal(fileEvent.fileName, "response.ogg");
  dispose();
});

test("Voice reply sender passes transcriptText as caption", async () => {
  const fields: Record<string, unknown>[] = [];
  const dispose = registerTelegramVoiceProvider(async () => ({
    audioPath: "/tmp/response.ogg",
    transcriptText: "Clean text without speech tags",
  }));
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    sendMultipart: async (_method, f) => {
      fields.push(f);
    },
    recordRuntimeEvent: () => {},
  });
  await sendVoiceReply(
    { chatId: 10, replyToMessageId: 20 },
    "hello",
  );
  assert.equal(fields.length, 1);
  assert.equal((fields[0] as Record<string, unknown>).chat_id, "10");
  assert.equal((fields[0] as Record<string, unknown>).caption, "Clean text without speech tags");
  dispose();
});
