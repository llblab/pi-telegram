/**
 * Regression tests for Telegram outbound handler helpers
 * Exercises assistant-authored voice/button markup extraction, artifact generation, callbacks, and Telegram upload wiring
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { resetTransportReplyDedup } from "../lib/replies.ts";
import { TelegramApiAuthorityError, TelegramApiCommitUnknownError } from "../lib/telegram-api.ts";
import { createTelegramVoiceReplySender as createVoiceSenderWithPorts } from "../lib/outbound-voice.ts";

test.beforeEach(() => {
  resetTransportReplyDedup();
  clearTelegramVoiceSynthesisProviders();
});

import {
  createTelegramButtonActionStore,
  type TelegramOutboundButtonAction,
  createTelegramButtonPromptTurn,
  createTelegramOutboundReplyArtifactSender,
  createTelegramOutboundReplyPlanner,
  createTelegramOutboundTextPreviewRuntime,
  createTelegramOutboundTextReplyRuntime,
  createTelegramVoiceReplySender,
  handleTelegramButtonCallbackQuery,
  planTelegramButtonReply,
  registerTelegramVoiceSynthesisProvider,
  getTelegramVoiceSynthesisProviders,
  hasTelegramVoiceSynthesisProvider,
  clearTelegramVoiceSynthesisProviders,
} from "../lib/outbound.ts";
import {
  planTelegramVoiceReply,
  stripTelegramCommentMarkupForPreview,
} from "../lib/outbound-markup.ts";

const testReplyMarkup = {
  inline_keyboard: [[{ text: "Continue", callback_data: "btn:1" }]],
};

for (const kind of ["confirm", "choice", "set", "wizard"] as const) for (const rendering of ["html", "rich"] as const) for (const enabled of [false, true])
test(`Private outbound question policy captures factory default without changing collectors (${kind}/${rendering}/${enabled})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 }); const records: TelegramOutboundButtonAction[] = [], answers: unknown[] = [];
  let live = true; const binding = { app: "counter", generation: "original", revision: 0, assertCurrent() { assert.ok(live); } };
  const store = createTelegramButtonActionStore();
  const planner = createTelegramOutboundReplyPlanner({ register(action) { records.push(action); return store.register(action); } }, () => rendering, enabled ? true : undefined);
  const body = kind === "confirm" ? { question: "Q" } : kind === "wizard" ? [{ question: "First", choices: ["A"] }, { question: "Last", choices: ["B"] }] : { question: "Q", choices: ["A", "B"], ...(kind === "set" ? { select: 2 } : {}) };
  const plan = planner(`<!-- ${kind === "confirm" ? "telegram_confirm" : "telegram_choice"} ${JSON.stringify(body)} -->`, { binding }); let markup = plan.replyMarkup!;
  try { assert.ok(markup); const deadline = records[0]!.completionGroup!.deadline!; assert.equal(deadline.expiresAt, 1000 + (enabled ? 86_400_000 : 3_600_000));
    assert.ok(records.every(a => a.binding === undefined && a.completionGroup!.deadline === deadline), "Structured selections remain ordinary answer data, not bound-method actions");
    const click = async (label: string) => handleTelegramButtonCallbackQuery({ id: "policy", data: markup.inline_keyboard.flat().find(b => b.text === label)!.callback_data,
      message: { chat: { id: 42 }, message_id: 201, reply_markup: markup } }, undefined, { resolveAction: store.resolve, answerCallbackQuery: async () => {},
      updateSelectionKeyboard: async (_q, next, guard) => { guard(); markup = next; }, updateSelectionMessage: async (_q, _text, mode, next, guard) => { guard(); assert.equal(mode, rendering); markup = next; },
      enqueueButtonPrompt: (_q, action) => { answers.push(JSON.parse(action.prompt)); } });
    if (enabled) t.mock.timers.tick(3_600_001);
    await click(kind === "confirm" ? "✅ Yes" : "A");
    if (kind === "set" || kind === "wizard") { assert.deepEqual(answers, []); t.mock.timers.tick(100); await click("B"); }
    assert.deepEqual(answers, [kind === "wizard" ? [{ question: "First", answer: "A" }, { question: "Last", answer: "B" }] : { question: "Q", answer: kind === "confirm" ? "✅ Yes" : kind === "set" ? ["A", "B"] : "A" }]);
    assert.equal(deadline.expiresAt, 1000 + (enabled ? 86_400_000 : 3_600_000), "Steps/finish are not a renewal or another factory capture");
  } finally { live = false; store.clear!(); }
});

for (const enabled of [false, true]) for (const timeoutMs of [1, 3_600_000, 3_600_001])
test(`Private outbound question policy preserves explicit timeout limits (${enabled}/${timeoutMs})`, t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 }); const actions: TelegramOutboundButtonAction[] = [];
  const plan = createTelegramOutboundReplyPlanner({ register(action) { actions.push(action); return `callback:${actions.length}`; } }, () => "html", enabled ? true : undefined)(`<!-- telegram_choice ${JSON.stringify({ question: "Q", choices: ["A"], timeoutMs })} -->`);
  if (timeoutMs > 3_600_000) { assert.equal(actions.length, 0); assert.equal(plan.replyMarkup, undefined); } else { assert.ok(actions.length); assert.ok(actions.every(a => a.expiresAt === 1000 + timeoutMs)); }
});

for (const invalid of [false, 0, null, {}])
test(`Private outbound question policy validates before dependency access (${JSON.stringify(invalid)})`, () => {
  let touched = 0; const store = { get register() { touched++; return () => "callback"; } };
  assert.throws(() => createTelegramOutboundReplyPlanner(store, () => { touched++; return "html"; }, invalid as true), /head\/tail policy/u); assert.equal(touched, 0);
});

for (const enabled of [false, true])
test(`Private outbound question policy stays constructor-only through rendering and bound values (${enabled})`, t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 }); let flag: true | undefined = enabled ? true : undefined;
  const actions: TelegramOutboundButtonAction[] = [], binding = { app: "counter", generation: "fixed", revision: 0 };
  const planner = createTelegramOutboundReplyPlanner({ register(a) { actions.push(a); return `callback:${actions.length}`; } }, () => { flag = flag ? undefined : true; return "html"; }, flag);
  const plan = planner('Visible.\n<!-- telegram_voice {Speak.|ru} -->\n<!-- telegram_choice {"question":"Q","choices":["counter::increment","/stop"]} -->\n<!-- telegram_button {Run|counter::increment} -->', { binding, questionHeadTail: !enabled } as { binding: typeof binding });
  assert.deepEqual(plan.voiceReplies, [{ text: "Speak.", lang: "ru" }]); assert.match(plan.markdown, /Visible\./u);
  const selections = actions.filter(a => a.promptKind === "selection"); assert.ok(selections.length);
  assert.ok(selections.every(a => a.expiresAt === 1000 + (enabled ? 86_400_000 : 3_600_000) && a.binding === undefined));
  assert.equal(actions.find(a => !a.promptKind)?.binding, binding, "Only ordinary app method controls keep the existing app binding");
  assert.deepEqual(JSON.parse(actions[0]!.prompt), { question: "Q", answer: "counter::increment" });
});

for (const enabled of [false, true])
test(`Private outbound question policy does not accept a declaration-level activation field (${enabled})`, () => {
  let actions = 0; const planner = createTelegramOutboundReplyPlanner({ register() { actions++; return "callback"; } }, () => "html", enabled ? true : undefined);
  const result = planner('<!-- telegram_confirm {"question":"Q","questionHeadTail":true} -->'); assert.equal(actions, 0); assert.equal(result.replyMarkup, undefined);
});

test("Finalized selection declarations use the normal outbound planner and ordinary callback queue", async () => {
  const store = createTelegramButtonActionStore(), planner = createTelegramOutboundReplyPlanner(store);
  const source = 'Before.\n```telegram_choice\n{"question":"Format?","choices":"[[{JSON|json|success}{CSV|csv}]]"}\n```\nAfter.';
  assert.equal(stripTelegramCommentMarkupForPreview(source), "Before.\n\nAfter.");
  const plan = planner(source); assert.match(plan.markdown, /\*\*Format\?\*\*/u);
  assert.equal(plan.replyMarkup!.inline_keyboard[0]![0]!.style, undefined);
  let turn: ReturnType<typeof createTelegramButtonPromptTurn> | undefined;
  const data = plan.replyMarkup!.inline_keyboard[0]![0]!.callback_data;
  await handleTelegramButtonCallbackQuery({ id: "click", data, message: { chat: { id: 7 }, message_id: 8, message_thread_id: 9, reply_markup: plan.replyMarkup } }, undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async () => {},
    enqueueButtonPrompt: (_query, action) => { turn = createTelegramButtonPromptTurn({ chatId: 7, replyToMessageId: 8, queueOrder: 1, action, target: { chatId: 7, threadId: 9 } }); },
  });
  assert.ok(turn); assert.equal(turn.kind, "prompt"); assert.deepEqual(turn.target, { chatId: 7, threadId: 9 });
  assert.deepEqual(JSON.parse(turn.historyText), { question: "Format?", answer: "JSON" });
});

for (const element of ["telegram_confirm", "telegram_choice"]) test(`Drafts suppress complete and partial ${element} bodies`, () => {
  for (const body of ['{"question":"Sensitive unfinished declaration', '{"question":"Q"}\n```'])
    assert.equal(stripTelegramCommentMarkupForPreview(`Before.\n\`\`\`${element}\n${body}`), "Before.");
});

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

for (const surface of ["text", "markdown"] as const) {
  for (const loss of ["current", "before", "transform", "response"] as const) {
    test(`Outbound recipient fence ${surface} preserves captured authority across ${loss}`, async () => {
      let current = loss !== "before", handlers = 0, sends = 0;
      const assertAuthority = () => { if (!current) throw new Error("Private recipient details"); };
      const options = { target: { chatId: 7, threadId: 41 }, assertAuthority, replyMarkup: testReplyMarkup };
      const send = async (chatId: number, replyToMessageId: number | undefined, _text: string, supplied?: {
        target?: { chatId: number; threadId?: number }; assertAuthority?: () => void;
      }) => {
        sends++;
        assert.deepEqual([chatId, replyToMessageId, supplied?.target], [7, 11, { chatId: 7, threadId: 41 }]);
        assert.equal(supplied?.assertAuthority, assertAuthority);
        if (loss === "response") { current = false; if (supplied) supplied.assertAuthority = () => {}; }
        return 9;
      };
      const runtime = createTelegramOutboundTextReplyRuntime({
        getHandlers: () => [{ type: "text", template: "/fixture/transform" }],
        execCommand: async () => {
          handlers++;
          await Promise.resolve();
          options.target.chatId = 99; options.target.threadId = 99; options.assertAuthority = () => {};
          if (loss === "transform") current = false;
          return { stdout: "transformed", stderr: "", code: 0, killed: false };
        },
        sendTextReply: send, sendMarkdownReply: send,
      });
      const result = surface === "text" ? runtime.sendTextReply(7, 11, "body", options) : runtime.sendMarkdownReply(7, 11, "body", options);
      if (loss === "current") assert.equal(await result, 9);
      else await assert.rejects(result, error => error instanceof TelegramApiAuthorityError &&
        error.requestIssued === (loss === "response") && error.message === "Telegram API call authority is unavailable.");
      assert.equal(sends, loss === "current" || loss === "response" ? 1 : 0);
      assert.equal(handlers, loss === "before" ? 0 : surface === "markdown" ? 2 : 1);
    });
  }
}

test("Outbound text runtime skips comment-only planned replies", async () => {
  const sent: string[] = [];
  const handlerCalls: string[] = [];
  const runtime = createTelegramOutboundTextReplyRuntime({
    getHandlers: () => [{ type: "text", template: "/tools/translate" }],
    execCommand: async (command) => {
      handlerCalls.push(command);
      return { stdout: "unexpected", stderr: "", code: 0, killed: false };
    },
    sendTextReply: async () => 1,
    sendMarkdownReply: async (_chatId, _replyToMessageId, markdown) => {
      sent.push(markdown);
      return 2;
    },
  });

  assert.equal(
    await runtime.sendMarkdownReply(
      1,
      2,
      " \n<!-- companion_extension private state -->\n ",
    ),
    undefined,
  );
  assert.deepEqual(handlerCalls, []);
  assert.deepEqual(sent, []);
});

test("Outbound text handler preserves inline buttons on transformed replies", async () => {
  const sent: Array<{ markdown: string; replyMarkup: unknown }> = [];
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    ["Answer.", "", '<!-- telegram_button {"value":"Continue"} -->'].join("\n"),
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

test("Voice reply planner extracts multiline JSON telegram_voice comments", () => {
  const plan = planTelegramVoiceReply(
    [
      "Technical answer.",
      "",
      "<!-- telegram_voice {",
      '  "text": "Short speakable summary.",',
      '  "lang": "ru",',
      '  "rate": "+20%"',
      "} -->",
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

test("Voice reply planner supports escaped lines in JSON comments", () => {
  const plan = planTelegramVoiceReply(
    [
      "Visible answer.",
      "",
      '<!-- telegram_voice {"text":"Первая строка.\\nВторая строка.","lang":"ru","rate":"+5%"} -->',
    ].join("\n"),
  );
  assert.deepEqual(plan, {
    markdown: "Visible answer.",
    voiceText: "Первая строка.\nВторая строка.",
    voiceReplies: [
      { text: "Первая строка.\nВторая строка.", lang: "ru", rate: "+5%" },
    ],
    lang: "ru",
    rate: "+5%",
  });
});

test("Voice reply planner supports compact JSON comments", () => {
  const plan = planTelegramVoiceReply(
    'Text before.\n\n<!-- telegram_voice {"text":"Inline summary."} -->',
  );
  assert.deepEqual(plan, {
    markdown: "Text before.",
    voiceText: "Inline summary.",
    voiceReplies: [{ text: "Inline summary." }],
  });
});

test("Voice reply planner supports positional compact action cells", () => {
  const plan = planTelegramVoiceReply(
    [
      "Text before.",
      "",
      "<!-- telegram_voice {Short spoken summary.} -->",
      "<!-- telegram_voice {Résumé bref.|fr} -->",
      "<!-- telegram_voice {Fast summary.|en|+10%} -->",
      String.raw`<!-- telegram_voice {Use A \| B and C\}|en} -->`,
    ].join("\n"),
  );
  assert.deepEqual(plan, {
    markdown: "Text before.",
    voiceText:
      "Short spoken summary.\n\nRésumé bref.\n\nFast summary.\n\nUse A | B and C}",
    voiceReplies: [
      { text: "Short spoken summary." },
      { text: "Résumé bref.", lang: "fr" },
      { text: "Fast summary.", lang: "en", rate: "+10%" },
      { text: "Use A | B and C}", lang: "en" },
    ],
    lang: "en",
    rate: "+10%",
  });
});

test("Voice reply planner retains text-attribute compatibility", () => {
  const plan = planTelegramVoiceReply(
    'Text before.\n\n<!-- telegram_voice lang="ru" rate="+10%" text="Inline spoken summary." -->',
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

test("Voice reply planner extracts canonical payloads and compatible attributes from tolerant envelopes", () => {
  const plan = planTelegramVoiceReply(
    [
      "Text before.",
      "",
      '<!-- telegram_voice: JSON noise {"text":"Structured voice.","lang":"en"} trailing -->',
      '<!-- telegram_voice JSON {"text":"Trailing comma voice.",} -->',
      '<!-- telegram_voice noise [draft {After bracket noise.} -->',
      '<!-- telegram_voices ignored unknown=Unquoted value="Attribute voice." rate=+10% trailing -->',
    ].join("\n"),
  );
  assert.deepEqual(plan, {
    markdown: "Text before.",
    voiceText:
      "Structured voice.\n\nTrailing comma voice.\n\nAfter bracket noise.\n\nAttribute voice.",
    voiceReplies: [
      { text: "Structured voice.", lang: "en" },
      { text: "Trailing comma voice." },
      { text: "After bracket noise." },
      { text: "Attribute voice.", rate: "+10%" },
    ],
    lang: "en",
    rate: "+10%",
  });
});

test("Voice reply planner retains complete legacy attribute actions", () => {
  const plan = planTelegramVoiceReply(
    [
      "Text before.",
      "",
      '<!-- telegram_voice text="Speak this instead of leaking it as text." lang="ru" rate="+30%" -->',
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
      '<!-- telegram_voice text="First summary." lang="ru" rate="+20%" -->',
      "",
      '<!-- telegram_voice {"text":"Second summary.","lang":"en","rate":"+10%"} -->',
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
        '<!-- telegram_button {"label":"Hidden","prompt":"Hidden prompt."} -->',
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

test("Combined replies extract action comments before any Markdown fence rendering", () => {
  for (const fence of ["md", "telegram_button"]) {
    const markdown = [
      "Visible answer.",
      `\`\`\`${fence}`,
      "<!-- telegram_voice {Speak.|ru} -->",
      "<!-- telegram_button {Run|Do it.} -->",
      "```",
    ].join("\n");
    const actions: unknown[] = [];
    const plan = createTelegramOutboundReplyPlanner({
      register: (action) => { actions.push(action); return "tgbtn:test"; },
    })(markdown);
    assert.deepEqual(actions, [{ text: "Run", prompt: "Do it." }]);
    assert.deepEqual(plan.voiceReplies, [{ text: "Speak.", lang: "ru" }]);
    assert.equal(plan.replyMarkup?.inline_keyboard[0]?.[0]?.text, "Run");
    assert.doesNotMatch(plan.markdown, /<!--|-->/u);
    assert.match(plan.markdown, /Visible answer\./u);
  }
});

test("Footer comments activate on both sides of longer Markdown fences", () => {
  const markdown = [
    "Example:",
    "",
    "````md",
    "<!-- telegram_button label=Skip -->",
    "   ````",
    "",
    '<!-- telegram_button {"value":"OK"} -->',
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
      "",
      "   ````",
    ].join("\n"),
  );
  assert.deepEqual(actions, [{ text: "Skip", prompt: "Skip" }, { text: "OK", prompt: "OK" }]);
});

test("Outbound action comments ignore indentation, surrounding text and neighboring actions", () => {
  const markdown = 'Visible <!-- telegram_voice {Speak.} --><!-- telegram_button {OK|Continue.} --> answer.';
  const actions: unknown[] = [];
  const plan = createTelegramOutboundReplyPlanner({
    register: (action) => { actions.push(action); return "tgbtn:test"; },
  })(markdown);
  assert.equal(plan.markdown, "Visible  answer.");
  assert.deepEqual(plan.voiceReplies, [{ text: "Speak." }]);
  assert.deepEqual(actions, [{ text: "OK", prompt: "Continue." }]);
  assert.equal(plan.replyMarkup?.inline_keyboard[0]?.[0]?.text, "OK");
  assert.equal(stripTelegramCommentMarkupForPreview(markdown), "Visible  answer.");
});

test("Button reply planner supports independent action comments", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      "Visible answer.",
      "",
      '<!-- telegram_button {"label":"OK","prompt":"PROMPT"} -->',
      "",
      '<!-- telegram_button label="More" prompt="Continue with more detail" -->',
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

test("Outbound reply planner strips voice and button markup without losing artifacts", () => {
  const actions: unknown[] = [];
  const plan = createTelegramOutboundReplyPlanner({
    register: (action) => {
      actions.push(action);
      return `btn:${actions.length}`;
    },
  })(
    [
      "Visible answer.",
      "",
      '<!-- telegram_voice {"text":"Speak this summary."} -->',
      "",
      '<!-- telegram_button label="Continue" prompt="Continue with context." -->',
    ].join("\n"),
  );
  assert.equal(plan.markdown, "Visible answer.");
  assert.equal(plan.voiceText, "Speak this summary.");
  assert.deepEqual(plan.voiceReplies, [{ text: "Speak this summary." }]);
  assert.deepEqual(actions, [
    { text: "Continue", prompt: "Continue with context." },
  ]);
  assert.deepEqual(plan.replyMarkup, {
    inline_keyboard: [[{ text: "Continue", callback_data: "btn:1" }]],
  });
});

test("Button reply planner supports compact value payload", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    ["Visible answer.", "", '<!-- telegram_button {"value":"OK"} -->'].join("\n"),
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

test("Button reply planner retains prompt-attribute compatibility", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      "Visible answer.",
      "",
      '<!-- telegram_button label="Continue" prompt="Continue with the current plan." -->',
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

test("Button reply planner accepts complete JSON actions", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      "Visible answer.",
      "",
      '<!-- telegram_button {"label":"Boundary","prompt":"Where does JAM end and DEOS begin?"} -->',
      "",
      '<!-- telegram_button {"label":"Sources","prompt":"Which DEOS sources are canonical?"} -->',
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

test("Button reply planner mirrors a lone label into its prompt", () => {
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
  assert.deepEqual(actions, [{ text: "Closed", prompt: "Closed" }]);
});

test("Button reply planner ignores text outside a closed button envelope", () => {
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
  assert.deepEqual(actions, [{ text: "Long", prompt: "Long" }]);
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
    { answer: "callback-1", text: "Queued" },
  ]);
});

test("Button callback handler refuses missing history without inventing a deadline", async () => {
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
    { id: "callback-1", text: "Button action unavailable" },
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
      queueLane: "priority",
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

test("Voice reply sender includes thread target fields and scoped reply parameters", async () => {
  const events: unknown[] = [];
  const dispose = registerTelegramVoiceSynthesisProvider(
    async () => "/tmp/voice.opus",
  );
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async (method, fields, fileField, filePath, fileName) => {
      events.push({ method, fields, fileField, filePath, fileName });
    },
  });
  await sendVoiceReply(
    { chatId: 10, replyToMessageId: 20, target: { chatId: 10, threadId: 42 } },
    "hello",
    { replyToPrompt: true },
  );
  assert.deepEqual(events, [
    {
      method: "sendVoice",
      fields: {
        chat_id: "10",
        message_thread_id: "42",
        reply_parameters:
          '{"message_id":20,"allow_sending_without_reply":true}',
      },
      fileField: "voice",
      filePath: "/tmp/voice.opus",
      fileName: "voice.opus",
    },
  ]);
  dispose();
});

test("Voice reply sender can suppress prompt reply metadata for secondary voice", async () => {
  const events: unknown[] = [];
  const dispose = registerTelegramVoiceSynthesisProvider(
    async () => "/tmp/voice.opus",
  );
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
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
  const dispose = registerTelegramVoiceSynthesisProvider(async (text) => {
    return `/tmp/${text}.opus`;
  });
  const sendOutboundReplyArtifacts = createTelegramOutboundReplyArtifactSender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
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

test("Outbound artifact sender treats a plan without voice content as a no-op", async () => {
  const events: unknown[] = [];
  const sendOutboundReplyArtifacts = createTelegramOutboundReplyArtifactSender({
    execCommand: async () => {
      events.push("exec");
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
    sendMultipart: async (method, fields, fileField, filePath, fileName) => {
      events.push({ method, fields, fileField, filePath, fileName });
    },
  });
  await sendOutboundReplyArtifacts({ chatId: 10, replyToMessageId: 20 }, {});
  await sendOutboundReplyArtifacts(
    { chatId: 10, replyToMessageId: 20 },
    { voiceReplies: [] },
  );
  assert.deepEqual(events, []);
});

test("Outbound artifact sender still fails when voice content cannot be delivered", async () => {
  const sendOutboundReplyArtifacts = createTelegramOutboundReplyArtifactSender({
    execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    sendMultipart: async () => {
      throw new Error("unexpected upload");
    },
  });
  await assert.rejects(
    sendOutboundReplyArtifacts(
      { chatId: 10, replyToMessageId: 20 },
      { voiceText: "hello" },
    ),
    /every voice synthesis provider failed/,
  );
});

test("Voice reply sender prefers configured outbound voice handlers over registered synthesis providers", async () => {
  const events: unknown[] = [];
  const voiceTempDir = join(tmpdir(), "pi-telegram-voice-handler-test");
  const dispose = registerTelegramVoiceSynthesisProvider(async () => {
    events.push("provider-called");
    return "/tmp/provider.opus";
  });
  const sendVoiceReply = createTelegramVoiceReplySender({
    tempDir: voiceTempDir,
    getHandlers: () => [
      {
        type: "voice",
        template: "tts --write-media {ogg}",
        output: "ogg",
      },
    ],
    execCommand: async () => ({
      stdout: "ok",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async (_method, _fields, _fileField, filePath) => {
      events.push(filePath);
    },
  });

  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello");

  assert.equal(events.length, 1);
  assert.equal(dirname(events[0] as string), voiceTempDir);
  assert.match(basename(events[0] as string), /^.+-voice\.ogg$/);
  dispose();
});

test("Voice reply sender falls back from configured handlers to registered synthesis providers", async () => {
  const events: unknown[] = [];
  const dispose = registerTelegramVoiceSynthesisProvider(
    async () => "/tmp/provider.opus",
  );
  const sendVoiceReply = createTelegramVoiceReplySender({
    getHandlers: () => [{ type: "voice", template: "/missing/tts" }],
    execCommand: async () => {
      throw new Error("configured handler failed");
    },
    sendMultipart: async (_method, _fields, _fileField, filePath) => {
      events.push(filePath);
    },
    recordRuntimeEvent: (_category, error) => {
      events.push((error as Error).message);
    },
  });

  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello");

  assert.ok(events.includes("configured handler failed"));
  assert.equal(events.at(-1), "/tmp/provider.opus");
  dispose();
});

test("Voice reply sender uses configured outbound voice handlers when no provider is registered", async () => {
  const execCalls: unknown[] = [];
  const voiceTempDir = join(tmpdir(), "pi-telegram-voice-handler-test");
  const uploads: unknown[] = [];
  const sendVoiceReply = createTelegramVoiceReplySender({
    tempDir: voiceTempDir,
    getHandlers: () => [
      {
        type: "voice",
        template: ["tts --write-media {mp3}", "ffmpeg -i {mp3} {ogg}"],
        output: "ogg",
      },
    ],
    execCommand: async (command, args, options) => {
      execCalls.push({ command, args, stdin: options?.stdin });
      return {
        stdout: command === "tts" ? "mp3-ready" : "ogg-ready",
        stderr: "",
        code: 0,
        killed: false,
      };
    },
    sendMultipart: async (method, fields, fileField, filePath, fileName) => {
      uploads.push({ method, fields, fileField, filePath, fileName });
    },
  });

  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello", {
    replyToPrompt: true,
  });

  assert.equal(execCalls.length, 2);
  const firstExec = execCalls[0] as {
    command: string;
    args: string[];
    stdin: string;
  };
  const secondExec = execCalls[1] as {
    command: string;
    args: string[];
    stdin: string;
  };
  assert.equal(firstExec.command, "tts");
  assert.equal(firstExec.stdin, "hello");
  assert.equal(dirname(firstExec.args[1]), voiceTempDir);
  assert.match(basename(firstExec.args[1]), /^.+-voice\.mp3$/);
  assert.equal(secondExec.command, "ffmpeg");
  assert.equal(secondExec.stdin, "mp3-ready");
  assert.equal(dirname(secondExec.args[1]), voiceTempDir);
  assert.match(basename(secondExec.args[1]), /^.+-voice\.mp3$/);
  assert.equal(dirname(secondExec.args[2]), voiceTempDir);
  assert.match(basename(secondExec.args[2]), /^.+-voice\.ogg$/);
  assert.equal(uploads.length, 1);
  const upload = uploads[0] as {
    method: string;
    fields: Record<string, string>;
    fileField: string;
    filePath: string;
    fileName: string;
  };
  assert.equal(upload.method, "sendVoice");
  assert.deepEqual(upload.fields, {
    chat_id: "10",
    reply_parameters: '{"message_id":20,"allow_sending_without_reply":true}',
  });
  assert.equal(upload.fileField, "voice");
  assert.equal(dirname(upload.filePath), voiceTempDir);
  assert.match(basename(upload.filePath), /^.+-voice\.ogg$/);
  assert.match(upload.fileName, /^.+-voice\.ogg$/);
});

for (const source of ["template", "programmatic", "provider"] as const) {
  test(`Voice ${source} upload uncertainty never advances to another provider`, async () => {
    const failure = new TelegramApiCommitUnknownError("sendVoice", new Error("Lost acknowledgement"));
    let uploads = 0;
    let fallbackSynthesis = 0;
    const disposeFirst = registerTelegramVoiceSynthesisProvider(async () => "/fixture/first.opus");
    const disposeNext = registerTelegramVoiceSynthesisProvider(async () => {
      fallbackSynthesis += 1;
      return "/fixture/next.opus";
    });
    const send = createVoiceSenderWithPorts({
      execCommand: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
      sendMultipart: async () => { uploads += 1; throw failure; },
    }, {
      findVoiceHandlers: () => source === "template" ? [{}] : [],
      generateVoiceFile: async () => "/fixture/template.opus",
      getProgrammaticVoiceHandlers: () => source === "programmatic" ? [async () => "/fixture/programmatic.opus"] : [],
    });
    try {
      await assert.rejects(send({ chatId: 10, replyToMessageId: 20 }, "One reply"), (error) => error === failure);
      assert.equal(uploads, 1);
      assert.equal(fallbackSynthesis, 0);
    } finally {
      disposeFirst(); disposeNext();
    }
  });
}

test("Voice reply sender falls back to the next voice synthesis provider", async () => {
  const events: unknown[] = [];
  const dispose1 = registerTelegramVoiceSynthesisProvider(async () => {
    throw new Error("provider 1 failed");
  });
  const dispose2 = registerTelegramVoiceSynthesisProvider(async () => {
    return "/tmp/good.opus";
  });
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
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
  const dispose = registerTelegramVoiceSynthesisProvider(
    async () => "/tmp/voice.opus",
  );
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async (method, fields, fileField, filePath, fileName) => {
      events.push({ method, fields, fileField, filePath, fileName });
    },
  });
  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello");
  dispose();
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

test("Voice synthesis provider registration and invocation", async () => {
  clearTelegramVoiceSynthesisProviders();
  const calls: string[] = [];
  assert.equal(hasTelegramVoiceSynthesisProvider(), false);
  const dispose = registerTelegramVoiceSynthesisProvider(async (text) => {
    calls.push(text);
    return `/tmp/voice-${text.length}.opus`;
  });
  assert.equal(hasTelegramVoiceSynthesisProvider(), true);
  const providers = getTelegramVoiceSynthesisProviders();
  assert.equal(providers.length, 1);
  const result = await providers[0]("hello", {});
  assert.equal(result, "/tmp/voice-5.opus");
  assert.deepEqual(calls, ["hello"]);
  dispose();
  assert.equal(hasTelegramVoiceSynthesisProvider(), false);
});

test("Voice synthesis provider registry supports multiple providers", async () => {
  clearTelegramVoiceSynthesisProviders();
  assert.equal(getTelegramVoiceSynthesisProviders().length, 0);
  const dispose1 = registerTelegramVoiceSynthesisProvider(
    async () => "/tmp/voice1.opus",
  );
  const dispose2 = registerTelegramVoiceSynthesisProvider(
    async () => "/tmp/voice2.opus",
  );
  assert.equal(getTelegramVoiceSynthesisProviders().length, 2);
  assert.equal(hasTelegramVoiceSynthesisProvider(), true);
  // returned array should be a copy
  const providers = getTelegramVoiceSynthesisProviders();
  providers.pop();
  assert.equal(getTelegramVoiceSynthesisProviders().length, 2);
  dispose1();
  assert.equal(getTelegramVoiceSynthesisProviders().length, 1);
  dispose2();
  assert.equal(getTelegramVoiceSynthesisProviders().length, 0);
});

test("Voice reply sender passes replyMarkup to sendMultipart", async () => {
  const fields: Record<string, unknown>[] = [];
  const dispose = registerTelegramVoiceSynthesisProvider(
    async () => "/tmp/voice.opus",
  );
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
  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello", {
    replyMarkup: {
      inline_keyboard: [[{ text: "OK", callback_data: "btn:1" }]],
    },
  });
  assert.equal(fields.length, 1);
  assert.ok(
    typeof (fields[0] as Record<string, unknown>).reply_markup === "string",
  );
  dispose();
});

test("Voice reply sender only passes replyMarkup to first successful voice reply", async () => {
  const fields: Record<string, unknown>[] = [];
  const disposeFail = registerTelegramVoiceSynthesisProvider(async () => {
    throw new Error("Provider 1 failed");
  });
  const disposeSuccess = registerTelegramVoiceSynthesisProvider(
    async () => "/tmp/voice.opus",
  );
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
  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello", {
    replyMarkup: {
      inline_keyboard: [[{ text: "OK", callback_data: "btn:1" }]],
    },
  });
  assert.equal(fields.length, 1);
  assert.ok(
    typeof (fields[0] as Record<string, unknown>).reply_markup === "string",
  );
  disposeFail();
  disposeSuccess();
});

test("Voice reply sender throws when every handler fails", async () => {
  clearTelegramVoiceSynthesisProviders();
  const events: unknown[] = [];
  const dispose = registerTelegramVoiceSynthesisProvider(async () => {
    throw new Error("handler 1 failed");
  });
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 1,
      killed: false,
    }),
    sendMultipart: async () => {
      events.push("sendMultipart");
    },
    recordRuntimeEvent: (category, error) => {
      events.push(`error:${category}:${(error as Error).message}`);
    },
  });
  await assert.rejects(
    async () =>
      await sendVoiceReply({ chatId: 1, replyToMessageId: 2 }, "hello", {
        replyToPrompt: false,
      }),
    /Failed to send voice reply: every voice synthesis provider and outbound voice handler failed/,
  );
  dispose();
  assert.equal(hasTelegramVoiceSynthesisProvider(), false);
  assert.ok(events.length >= 2);
  assert.ok(events.some((e) => (e as string).includes("handler 1 failed")));
  assert.ok(
    events.some((e) =>
      (e as string).includes(
        "every voice synthesis provider and outbound voice handler failed",
      ),
    ),
  );
});

test("Voice reply sender skips provider that returns undefined and tries next", async () => {
  const events: unknown[] = [];
  const dispose1 = registerTelegramVoiceSynthesisProvider(
    async () => undefined,
  );
  const dispose2 = registerTelegramVoiceSynthesisProvider(
    async () => "/tmp/voice.opus",
  );
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async (method, fields, fileField, filePath, fileName) => {
      events.push({ method, fields, fileField, filePath, fileName });
    },
    recordRuntimeEvent: () => {},
  });
  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello");
  assert.equal(events.length, 1);
  assert.equal(
    (events[0] as Record<string, unknown>).filePath,
    "/tmp/voice.opus",
  );
  dispose1();
  dispose2();
});

test("Voice reply sender records event when provider returns empty string", async () => {
  const events: unknown[] = [];
  const dispose1 = registerTelegramVoiceSynthesisProvider(async () => "");
  const dispose2 = registerTelegramVoiceSynthesisProvider(
    async () => "/tmp/voice.opus",
  );
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async () => {},
    recordRuntimeEvent: (category, error, details) => {
      events.push(
        `error:${category}:${(error as Error).message}:${details?.phase}`,
      );
    },
  });
  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello");
  assert.ok(events.some((e) => (e as string).includes("voice-provider-skip")));
  dispose1();
  dispose2();
});

test("Voice reply sender accepts Opus files", async () => {
  const events: unknown[] = [];
  const dispose = registerTelegramVoiceSynthesisProvider(
    async () => "/tmp/response.opus",
  );
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async (_method, _fields, _fileField, filePath, fileName) => {
      events.push({ filePath, fileName });
    },
    recordRuntimeEvent: () => {},
  });
  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello");
  const fileEvent = events.find(
    (e) => (e as Record<string, unknown>).filePath !== undefined,
  ) as Record<string, unknown>;
  assert.equal(fileEvent.filePath, "/tmp/response.opus");
  assert.equal(fileEvent.fileName, "response.opus");
  dispose();
});

test("Voice reply sender accepts OGG files", async () => {
  const events: unknown[] = [];
  const dispose = registerTelegramVoiceSynthesisProvider(
    async () => "/tmp/response.ogg",
  );
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async (_method, _fields, _fileField, filePath, fileName) => {
      events.push({ filePath, fileName });
    },
    recordRuntimeEvent: () => {},
  });
  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello");
  const fileEvent = events.find(
    (e) => (e as Record<string, unknown>).filePath !== undefined,
  ) as Record<string, unknown>;
  assert.equal(fileEvent.filePath, "/tmp/response.ogg");
  assert.equal(fileEvent.fileName, "response.ogg");
  dispose();
});

test("Voice reply sender throws for non-ogg files", async () => {
  const dispose = registerTelegramVoiceSynthesisProvider(
    async () => "/tmp/response.mp3",
  );
  const sendVoiceReply = createTelegramVoiceReplySender({
    execCommand: async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    }),
    sendMultipart: async () => {
      throw new Error("should not be called");
    },
    recordRuntimeEvent: () => {},
  });
  await assert.rejects(
    sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello"),
    /Failed to send voice reply: every voice synthesis provider and outbound voice handler failed./,
  );
  dispose();
});

test("Voice reply sender falls back to next handler when sendMultipart throws", async () => {
  const fields: Record<string, unknown>[] = [];
  let callCount = 0;
  const dispose1 = registerTelegramVoiceSynthesisProvider(
    async () => "/tmp/voice1.opus",
  );
  const dispose2 = registerTelegramVoiceSynthesisProvider(
    async () => "/tmp/voice2.opus",
  );
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
  await sendVoiceReply({ chatId: 10, replyToMessageId: 20 }, "hello");
  assert.equal(callCount, 2);
  assert.equal(fields.length, 1);
  assert.equal((fields[0] as Record<string, unknown>).chat_id, "10");
  dispose1();
  dispose2();
});

test("Outbound text handlers honour when guards on handlers and composition steps", async () => {
  const calls: string[] = [];
  const sent: string[] = [];
  const runtime = createTelegramOutboundTextReplyRuntime({
    getHandlers: () => [
      { type: "text", when: false, template: "/tools/off" },
      { type: "text", template: [{ when: "!text", template: "/tools/skip" }, "/tools/upper"] },
    ],
    execCommand: async (command, _args, options) => {
      calls.push(command);
      return { stdout: `${command}:${options?.stdin ?? ""}`, stderr: "", code: 0, killed: false };
    },
    sendTextReply: async (_chatId, _replyTo, text) => { sent.push(text); return 1; },
    sendMarkdownReply: async () => 2,
  });
  await runtime.sendTextReply(1, 2, "hello");
  assert.deepEqual(calls, ["/tools/upper"]);
  assert.deepEqual(sent, ["/tools/upper:hello"]);
});
