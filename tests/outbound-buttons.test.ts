/**
 * Regression tests for Telegram outbound button helpers
 * Exercises assistant-authored button markup extraction, action storage, callback handling, and prompt-turn construction
 */

import assert from "node:assert/strict";
import test from "node:test";
import { sendTelegramNativeMarkdownReply, splitTelegramNativeMarkdown } from "../lib/replies.ts";

import {
  createTelegramButtonActionStore,
  createTelegramButtonPromptTurn,
  handleTelegramButtonCallbackQuery,
  markTelegramButtonSelected,
  planTelegramButtonReply,
} from "../lib/outbound-buttons.ts";

test("Fenced button blocks use the shared grammar in place, independently of footer controls", async () => {
  const store = createTelegramButtonActionStore();
  const binding = { app: "counter", generation: "current", revision: 3 };
  const plan = planTelegramButtonReply([
    "Before.", "```telegram_button",
    '[{Run|counter::next}[{"label":"Wait","disabled":true}{|||true}]]',
    "```", "After.", '<!-- telegram_button {Footer|Explain this.} -->',
  ].join("\n"), { registerAction: store.register, binding });
  assert.match(plan.markdown, /^Before\.\n\n<tg-button-row>/u);
  assert.match(plan.markdown, /<tg-button type="disabled">Wait<\/tg-button>/u);
  assert.match(plan.markdown, /<tg-button type="disabled">\u00a0<\/tg-button>/u);
  assert.match(plan.markdown, /<\/tg-button-row>\n\nAfter\.$/u);
  assert.equal(plan.replyMarkup?.inline_keyboard[0]?.[0]?.text, "Footer");
  const data = plan.markdown.match(/data="([^"]+)"/)?.[1];
  assert.ok(data);
  let invoked = false;
  assert.equal(await handleTelegramButtonCallbackQuery({
    id: "callback", data, message: { chat: { id: 7 }, message_id: 8, message_thread_id: 9 },
  }, undefined, {
    resolveAction: store.resolve,
    answerCallbackQuery: async () => {},
    enqueueButtonPrompt: () => assert.fail("Bound action entered model queue"),
    invokeBoundAction: async (_query, action) => {
      assert.equal(action.prompt, "counter::next");
      assert.deepEqual(action.binding, binding);
      invoked = true;
      return "new";
    },
  }), true);
  assert.equal(invoked, true);
  const ordinary = planTelegramButtonReply('```telegram_button\n{Explain|Explain this section.}\n```', { registerAction: store.register });
  const ordinaryData = ordinary.markdown.match(/data="([^"]+)"/)?.[1];
  assert.ok(ordinaryData);
  let queued = false;
  await handleTelegramButtonCallbackQuery({
    id: "ordinary", data: ordinaryData, message: { chat: { id: 7 }, message_id: 10, message_thread_id: 9 },
  }, undefined, {
    resolveAction: store.resolve,
    answerCallbackQuery: async (_id, text) => { assert.equal(text, "Queued."); },
    enqueueButtonPrompt: (query, action) => {
      assert.equal(query.message?.message_thread_id, 9);
      assert.equal(action.prompt, "Explain this section.");
      queued = true;
    },
  });
  assert.equal(queued, true);
});

test("Fenced singleton JSON/CML cells are equivalent and labels cannot inject Rich markup", () => {
  for (const payload of ['{Run|do-it}', '{"label":"Run","prompt":"do-it"}']) {
    const plan = planTelegramButtonReply(`\`\`\`telegram_button\n${payload}\n\`\`\``, {
      registerAction: (action) => {
        assert.deepEqual(action, { text: "Run", prompt: "do-it" });
        return "tgbtn:test";
      },
    });
    assert.equal(plan.markdown, '<tg-button-row><tg-button type="callback_data" data="tgbtn:test">Run</tg-button></tg-button-row>');
    assert.equal(plan.replyMarkup, undefined);
  }
  const plan = planTelegramButtonReply('```telegram_button\n' + JSON.stringify({
    label: '</tg-button><tg-button type="url">$USD`_*', prompt: "private prompt",
  }) + '\n```', { registerAction: () => "tgbtn:safe" });
  assert.equal((plan.markdown.match(/<tg-button /g) ?? []).length, 1);
  assert.ok(!plan.markdown.includes("private prompt"));
  assert.match(plan.markdown, /&#60;/u);
});

test("Only complete standalone exact-name fences activate; examples remain literal", () => {
  for (const source of [
    '````markdown\n```telegram_button\n{Run}\n```\n````',
    '~~~markdown\n```telegram_button\n{Run}\n```\n~~~',
    '```text\n```telegram_button\n{Run}\n```',
    '> ```telegram_button\n> {Run}\n> ```',
    '    ```telegram_button\n    {Run}\n    ```',
    '```telegram_button_extra\n{Run}\n```',
    '```telegram_button extra\n{Run}\n```',
    'Text <!--\n```telegram_button\n{Run}\n```\n-->',
  ]) {
    const plan = planTelegramButtonReply(source, {
      registerAction: () => assert.fail(`Activated a literal example: ${source}`),
    });
    assert.equal(plan.markdown, source.trim());
  }
  for (const source of [
    '```telegram_button\n{Run}',
    '```telegram_button\n[{Valid}{Bad|}]\n```',
    '```telegram_button\n{Run} trailing\n```',
    '```telegram_button\n<!-- telegram_button {Run} -->\n```',
    '```telegram_button\n[[' + Array(9).fill('{Run}').join('') + ']]\n```',
    '```telegram_button\n{' + 'x'.repeat(32768) + '}\n```',
  ]) {
    const plan = planTelegramButtonReply(source, {
      registerAction: () => assert.fail("Invalid or incomplete block registered callbacks"),
    });
    assert.equal(plan.markdown, "");
    assert.equal(plan.replyMarkup, undefined);
  }
});

test("Native sends preserve in-body controls, target ownership and chunk boundaries", async () => {
  const row = '<tg-button-row><tg-button type="callback_data" data="tgbtn:test">Run</tg-button></tg-button-row>';
  const markdown = `${'x'.repeat(32760)}\n\n${row}\n\nTail`;
  const chunks = splitTelegramNativeMarkdown(markdown);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.filter((chunk) => chunk.includes(row)).length, 1);
  assert.ok(chunks.every((chunk) => !chunk.includes('<tg-button-row>') || chunk.includes('</tg-button-row>')));
  const many = splitTelegramNativeMarkdown(Array(501).fill(row).join('\n\n'));
  assert.ok(many.length > 1);
  assert.ok(many.every((chunk) => (chunk.match(/<tg-button-row>/g) ?? []).length <= 500));
  const target = { chatId: 7, threadId: 9 };
  const ownership: unknown[] = [];
  let sends = 0;
  await sendTelegramNativeMarkdownReply(7, 5, markdown, {
    recordOwnership: (value) => { ownership.push(value); },
    sendRichMessage: async (body) => {
      assert.equal(body.message_thread_id, 9);
      assert.deepEqual(body.rich_message, { markdown: chunks[sends], skip_entity_detection: true });
      assert.equal(body.reply_parameters?.message_id, sends === 0 ? 5 : undefined);
      sends += 1;
      return { message_id: sends };
    },
  }, { target });
  assert.equal(sends, chunks.length);
  assert.deepEqual(ownership, chunks.map((_chunk, index) => ({ chatId: 7, messageId: index + 1, target })));
});

test("HTML compatibility projects fenced controls into the existing footer keyboard", () => {
  const plan = planTelegramButtonReply('Before\n```telegram_button\n[{Run}{Wait|||1}]\n```\nAfter', {
    rendering: "html", registerAction: () => "tgbtn:run",
  });
  assert.equal(plan.markdown, "Before\n\nAfter");
  assert.deepEqual(plan.replyMarkup, { inline_keyboard: [
    [{ text: "Run", callback_data: "tgbtn:run" }], [{ text: "Wait", disabled: {} }],
  ] });
});

test("Button reply planner strips telegram_button markup and registers actions", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      "Visible answer.",
      "",
      '<!-- telegram_button {"label":"Run","prompt":"Run the workflow."} -->',
      "",
      "Tail.",
    ].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );

  assert.equal(plan.markdown, "Visible answer.\n\nTail.");
  assert.deepEqual(actions, [{ text: "Run", prompt: "Run the workflow." }]);
  assert.deepEqual(plan.replyMarkup, {
    inline_keyboard: [[{ text: "Run", callback_data: "btn:1" }]],
  });
});

test("Button reply planner retains legacy attribute compatibility", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      '<!-- telegram_button {"label":"JSON","prompt":"Run JSON."} -->',
      '<!-- telegram_button {"label":"Styled JSON","prompt":"Run styled JSON.","selected_style":"success"} -->',
      '<!-- telegram_button label="Attributes" prompt="Run attributes." -->',
      '<!-- telegram_button {"value":"JSON value"} -->',
      '<!-- telegram_button value="Attribute value" -->',
      '<!-- telegram_button {"value":"Fallback prompt","label":"Explicit label"} -->',
    ].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );

  assert.deepEqual(actions, [
    { text: "JSON", prompt: "Run JSON." },
    {
      text: "Styled JSON",
      prompt: "Run styled JSON.",
      selectedStyle: "success",
    },
    { text: "Attributes", prompt: "Run attributes." },
    { text: "JSON value", prompt: "JSON value" },
    { text: "Attribute value", prompt: "Attribute value" },
    { text: "Explicit label", prompt: "Fallback prompt" },
  ]);
  assert.deepEqual(plan.replyMarkup, {
    inline_keyboard: [
      [{ text: "JSON", callback_data: "btn:1" }],
      [{ text: "Styled JSON", callback_data: "btn:2" }],
      [{ text: "Attributes", callback_data: "btn:3" }],
      [{ text: "JSON value", callback_data: "btn:4" }],
      [{ text: "Attribute value", callback_data: "btn:5" }],
      [{ text: "Explicit label", callback_data: "btn:6" }],
    ],
  });
});

test("Button reply planner expands JSON arrays, compact rows, and the telegram_buttons alias", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      '<!-- telegram_button [{"label":"⬆️ Up","prompt":"/"},[{"value":"⬅️ Previous"},{"value":"➡️ Next"}],{"label":"📁 etc","prompt":"/etc"},{"label":"📁 home","prompt":"/home","selected_style":"success"}] -->',
      '<!-- telegram_buttons [{"value":"Next"},{"label":"Refresh","prompt":"/"}] -->',
      '<!-- telegram_buttons {"label":"Single alias","prompt":"One more."} -->',
    ].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );

  assert.deepEqual(actions, [
    { text: "⬆️ Up", prompt: "/" },
    { text: "⬅️ Previous", prompt: "⬅️ Previous" },
    { text: "➡️ Next", prompt: "➡️ Next" },
    { text: "📁 etc", prompt: "/etc" },
    { text: "📁 home", prompt: "/home", selectedStyle: "success" },
    { text: "Next", prompt: "Next" },
    { text: "Refresh", prompt: "/" },
    { text: "Single alias", prompt: "One more." },
  ]);
  assert.deepEqual(plan.replyMarkup, {
    inline_keyboard: [
      [{ text: "⬆️ Up", callback_data: "btn:1" }],
      [
        { text: "⬅️ Previous", callback_data: "btn:2" },
        { text: "➡️ Next", callback_data: "btn:3" },
      ],
      [{ text: "📁 etc", callback_data: "btn:4" }],
      [{ text: "📁 home", callback_data: "btn:5" }],
      [{ text: "Next", callback_data: "btn:6" }],
      [{ text: "Refresh", callback_data: "btn:7" }],
      [{ text: "Single alias", callback_data: "btn:8" }],
    ],
  });
});

test("Button reply planner leaves compact-row width to the renderer profile", () => {
  let nextId = 0;
  const plan = planTelegramButtonReply(
    '<!-- telegram_button [[{"value":"1"},{"value":"2"},{"value":"3"},{"value":"4"},{"value":"5"},{"value":"6"},{"value":"7"},{"value":"8"}]] -->',
    { registerAction: () => `btn:${++nextId}` },
  );

  assert.deepEqual(plan.replyMarkup?.inline_keyboard, [
    [
      { text: "1", callback_data: "btn:1" },
      { text: "2", callback_data: "btn:2" },
      { text: "3", callback_data: "btn:3" },
      { text: "4", callback_data: "btn:4" },
      { text: "5", callback_data: "btn:5" },
      { text: "6", callback_data: "btn:6" },
      { text: "7", callback_data: "btn:7" },
      { text: "8", callback_data: "btn:8" },
    ],
  ]);
});

test("Button reply planner decodes compact matrix literals", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    String.raw`<!-- telegram_button [{  Up  | / }[{1}{2}{3}{4}{5}{6}{7}{8}]{Stop|music-player::stop|danger}{A {["x"], v1: \| B|C:\\Games\}}] -->`,
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );

  assert.deepEqual(actions, [
    { text: "Up", prompt: "/" },
    { text: "1", prompt: "1" },
    { text: "2", prompt: "2" },
    { text: "3", prompt: "3" },
    { text: "4", prompt: "4" },
    { text: "5", prompt: "5" },
    { text: "6", prompt: "6" },
    { text: "7", prompt: "7" },
    { text: "8", prompt: "8" },
    {
      text: "Stop",
      prompt: "music-player::stop",
      selectedStyle: "danger",
    },
    { text: 'A {["x"], v1: | B', prompt: "C:\\Games}" },
  ]);
  assert.deepEqual(
    plan.replyMarkup?.inline_keyboard.map((row) =>
      row.map((button) => button.text),
    ),
    [
      ["Up"],
      ["1", "2", "3", "4", "5", "6", "7", "8"],
      ["Stop"],
      ['A {["x"], v1: | B'],
    ],
  );
});

test("Button reply planner preserves semantics across adaptive JSON and CML compression", () => {
  const sources = [
    '[[{"label":"Pause","prompt":"music::pause"},{"value":"Next"}],{"value":"Status"}]',
    '[[{"label":"Pause","prompt":"music::pause"}{"value":"Next"}]{"value":"Status"}]',
    '[[{"label":"Pause","prompt":"music::pause"},{Next}],{Status}]',
    '[[{Pause|music::pause}{Next}]{Status}]',
  ];
  for (const source of sources) {
    const actions: unknown[] = [];
    const plan = planTelegramButtonReply(
      `<!-- telegram_button ${source} -->`,
      {
        registerAction: (action) => {
          actions.push(action);
          return `btn:${actions.length}`;
        },
      },
    );
    assert.deepEqual(actions, [
      { text: "Pause", prompt: "music::pause" },
      { text: "Next", prompt: "Next" },
      { text: "Status", prompt: "Status" },
    ]);
    assert.deepEqual(
      plan.replyMarkup?.inline_keyboard.map((row) =>
        row.map((button) => button.text),
      ),
      [["Pause", "Next"], ["Status"]],
    );
  }
});

test("Button reply planner extracts the JSON-to-CML gradient from tolerant envelopes", () => {
  const cases = [
    ['<!-- telegram_button {"label":"text","prompt":"text"} -->', [["text"]]],
    ['<!-- telegram_button JSON {"label":"trailing","prompt":"trailing",} -->', [["trailing"]]],
    ["<!-- telegram_button noise [draft {after noise} -->", [["after noise"]]],
    ["<!-- telegram_button noise [{after orphan opener} -->", [["after orphan opener"]]],
    ["<!-- telegram_button {label|prompt} -->", [["label"]]],
    ["<!-- telegram_button [{label|prompt}] -->", [["label"]]],
    ["<!-- telegram_button [{|e2}{|e4}] -->", [["e2"], ["e4"]]],
    ["<!-- telegram_button {prompt} -->", [["prompt"]]],
    ["<!-- telegram_button [{prompt}] -->", [["prompt"]]],
    ['<!-- telegram_button noise {Say "yes"|speak} trailing -->', [['Say "yes"']]],
    ["<!-- telegram_button noise {Open [draft|open} trailing -->", [["Open [draft"]]],
    ["<!-- telegram_button [[{prompt}]] -->", [["prompt"]]],
    ["<!-- telegram_button [[{one}{two}]] -->", [["one", "two"]]],
    ["<!-- telegram_button [[{one},{two}]] -->", [["one", "two"]]],
    ["<!-- telegram_button [[{one},{two},],] -->", [["one", "two"]]],
    [
      '<!-- telegram_button [[{"label":"text","prompt":"text"},{prompt}]] -->',
      [["text", "prompt"]],
    ],
    [
      '<!-- telegram_button: CML [[{"label":"text"},{"prompt":"text"}{prompt}]] -->',
      [["text", "text", "prompt"]],
    ],
    [
      '<!-- telegram_buttons something [{"label":"text"}{"prompt":"text"},{prompt}] what? -->',
      [["text"], ["text"], ["prompt"]],
    ],
    [
      "<!-- telegram_button ignored label=Label prompt=Prompt trailing -->",
      [["Label"]],
    ],
  ] as const;

  for (const [comment, expectedRows] of cases) {
    let nextId = 0;
    const plan = planTelegramButtonReply(comment, {
      registerAction: () => `btn:${++nextId}`,
    });
    assert.deepEqual(
      plan.replyMarkup?.inline_keyboard.map((row) =>
        row.map((button) => button.text),
      ),
      expectedRows,
      comment,
    );
  }
});

test("Button reply planner preserves label and prompt semantics across shorthand forms", () => {
  const actions: unknown[] = [];
  planTelegramButtonReply(
    [
      "<!-- telegram_button {Label|Prompt} -->",
      "<!-- telegram_button [{|e2}{|e4}] -->",
      '<!-- telegram_button {"label":"Label only"} -->',
      '<!-- telegram_button {"prompt":"Prompt only"} -->',
    ].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );
  assert.deepEqual(actions, [
    { text: "Label", prompt: "Prompt" },
    { text: "e2", prompt: "e2" },
    { text: "e4", prompt: "e4" },
    { text: "Label only", prompt: "Label only" },
    { text: "Prompt only", prompt: "Prompt only" },
  ]);
});

test("Compact button style accepts exactly the selected-style enum", () => {
  for (const selectedStyle of ["primary", "success", "danger"] as const) {
    const actions: unknown[] = [];
    planTelegramButtonReply(
      [
        `<!-- telegram_button {Run|run-now|${selectedStyle}} -->`,
        `<!-- telegram_button {|retry-now|${selectedStyle}} -->`,
      ].join("\n"),
      {
        registerAction: (action) => {
          actions.push(action);
          return "tgbtn:styled";
        },
      },
    );
    assert.deepEqual(actions, [
      { text: "Run", prompt: "run-now", selectedStyle },
      { text: "retry-now", prompt: "retry-now", selectedStyle },
    ]);
  }
});

test("Disabled buttons normalize JSON and CML without registering prompt or bound actions", () => {
  for (const prompt of ["Continue the task.", "counter::next"]) {
    for (const payload of [
      `{|${prompt}||1}`,
      `{|${prompt}|danger|1}`,
      JSON.stringify({ prompt, disabled: true }),
      `prompt="${prompt}" disabled="true"`,
    ]) {
      const plan = planTelegramButtonReply(`<!-- telegram_button ${payload} -->`, {
        binding: { app: "counter", generation: "current", revision: 2 },
        registerAction: () => assert.fail("Disabled controls must have no action identity"),
      });
      assert.deepEqual(plan.replyMarkup, {
        inline_keyboard: [[{ text: prompt, disabled: {} }]],
      });
      assert.equal(plan.markdown, "☑️ **Choose an option:**");
    }
  }
});

test("Disabled cells need neither a prompt nor a label, with JSON/CML parity", () => {
  for (const [payload, text] of [
    ["{Next|||1}", "Next"],
    ["{Next|||true}", "Next"],
    ["{|||true}", "\u00a0"],
    ['{"label":"Next","disabled":true}', "Next"],
    ["{|||1}", "\u00a0"],
    ['{"disabled":true}', "\u00a0"],
    ["{Next||danger|1}", "Next"],
  ]) {
    const plan = planTelegramButtonReply(`<!-- telegram_button ${payload} -->`, {
      registerAction: () => assert.fail("Disabled cells have no action"),
    });
    assert.deepEqual(plan.replyMarkup, { inline_keyboard: [[{ text, disabled: {} }]] });
  }
  const plan = planTelegramButtonReply('<!-- telegram_button [[{|||1}{Next|||1}]{Run}] -->', {
    registerAction: (action) => {
      assert.deepEqual(action, { text: "Run", prompt: "Run" });
      return "btn:run";
    },
  });
  assert.deepEqual(plan.replyMarkup?.inline_keyboard, [
    [{ text: "\u00a0", disabled: {} }, { text: "Next", disabled: {} }],
    [{ text: "Run", callback_data: "btn:run" }],
  ]);
});

test("Mixed matrices preserve disabled cells and enabled selection/binding semantics", () => {
  const actions: unknown[] = [];
  const binding = { app: "counter", generation: "current", revision: 2 };
  const plan = planTelegramButtonReply(
    '<!-- telegram_button [[{Wait|counter::next||1}{Next|counter::next||false}]{Run|run|success|0}{"value":"Again","disabled":false}] -->',
    {
      binding,
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );
  assert.deepEqual(actions, [
    { text: "Next", prompt: "counter::next", binding },
    { text: "Run", prompt: "run", selectedStyle: "success", binding },
    { text: "Again", prompt: "Again", binding },
  ]);
  assert.deepEqual(plan.replyMarkup, {
    inline_keyboard: [
      [{ text: "Wait", disabled: {} }, { text: "Next", callback_data: "btn:1" }],
      [{ text: "Run", callback_data: "btn:2" }],
      [{ text: "Again", callback_data: "btn:3" }],
    ],
  });
  const selected = markTelegramButtonSelected(plan.replyMarkup!, "btn:1");
  assert.deepEqual(selected?.inline_keyboard[0], [
    { text: "Wait", disabled: {} },
    { text: "Next", callback_data: "btn:1", style: "primary" },
  ]);
});

test("Invalid disabled values reject an entire matrix without activating peers", () => {
  for (const cell of [
    "{x|y||TRUE}", "{x|y||False}", "{x|y||2}", "{x|y||}",
    "{|||false}",
    "{x|y||1|extra}", "{x|y|unknown|1}", "{x|||0}", "{|||0}",
    '{"disabled":false}',
    ...["true", 1, 0, null, {}, []].map((disabled) => JSON.stringify({ value: "x", disabled })),
  ]) {
    const plan = planTelegramButtonReply(`<!-- telegram_button [{Valid}${cell}] -->`, {
      registerAction: () => assert.fail(`Invalid matrix registered an action: ${cell}`),
    });
    assert.equal(plan.replyMarkup, undefined, cell);
    assert.equal(plan.markdown, "", cell);
  }
});

test("Disabled stored actions cannot invoke an app or enqueue a prompt", async () => {
  const store = createTelegramButtonActionStore();
  const data = store.register({ text: "Wait", prompt: "counter::next", disabled: true });
  const answers: unknown[] = [];
  assert.equal(await handleTelegramButtonCallbackQuery({ id: "query", data }, undefined, {
    resolveAction: store.resolve,
    answerCallbackQuery: async (...args) => { answers.push(args); },
    enqueueButtonPrompt: () => assert.fail("Disabled prompt was queued"),
    invokeBoundAction: async () => assert.fail("Disabled method was invoked"),
    editMessageReplyMarkup: async () => assert.fail("Disabled button was selected"),
  }), true);
  assert.deepEqual(answers, [["query", "Button action unavailable."]]);
});

test("Button reply planner rejects payloads without a valid button shape", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    [
      '<!-- telegram_button [{"value":"Valid"},null] -->',
      '<!-- telegram_button [1,2] -->',
      '<!-- telegram_button [[]] -->',
      '<!-- telegram_button [[[{"value":"Nested too deeply"}]]] -->',
      '<!-- telegram_button unknown=data -->',
      '<!-- telegram_button {"label":"Must not become CML","prompt":} -->',
      '<!-- telegram_button [{broken|} prompt=Must-not-recover] -->',
    ].join("\n"),
    {
      registerAction: (action) => {
        actions.push(action);
        return `btn:${actions.length}`;
      },
    },
  );

  assert.equal(plan.markdown, "");
  assert.deepEqual(plan.replyMarkup, undefined);
  assert.deepEqual(actions, []);
});

test("Button reply planner rejects malformed compact matrix literals atomically", () => {
  for (const payload of [
    "{}",
    "{   }",
    "{x|}",
    "{x|   }",
    "{|}",
    "{||danger}",
    "{x|y|unknown}",
    "{x|y|}",
    "{x||danger}",
    "{x|y|danger|extra}",
    String.raw`{x\q}`,
    "{x\\",
    "[]",
    "[[]]",
    "{x",
    "[{x}}]",
    "[[[{deep}]]]",
    "[,{a}]",
    "[{a},,{b}]",
    "{x|line\nbreak}",
  ]) {
    const actions: unknown[] = [];
    const plan = planTelegramButtonReply(
      `<!-- telegram_button ${payload} -->`,
      {
        registerAction: (action) => {
          actions.push(action);
          return `btn:${actions.length}`;
        },
      },
    );
    assert.equal(plan.markdown, "");
    assert.deepEqual(plan.replyMarkup, undefined);
    assert.deepEqual(actions, []);
  }
});

test("Button reply planner supplies visible text and stores selected style for a button-only reply", () => {
  const actions: unknown[] = [];
  const plan = planTelegramButtonReply(
    '<!-- telegram_button label="Continue" prompt="Continue now." selected_style="danger" -->',
    {
      registerAction: (action) => {
        actions.push(action);
        return "tgbtn:continue";
      },
    },
  );

  assert.equal(plan.markdown, "☑️ **Choose an option:**");
  assert.deepEqual(actions, [
    { text: "Continue", prompt: "Continue now.", selectedStyle: "danger" },
  ]);
  assert.deepEqual(plan.replyMarkup, {
    inline_keyboard: [
      [{ text: "Continue", callback_data: "tgbtn:continue" }],
    ],
  });
});

test("Button reply planner retains hidden Generative App revision binding in stored actions", () => {
  const store = createTelegramButtonActionStore();
  const plan = planTelegramButtonReply(
    "<!-- telegram_button {Next|counter::increment} -->",
    {
      registerAction: store.register,
      binding: { generation: "generation-a", app: "counter", revision: 4 },
    },
  );
  const callbackData = plan.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data;
  assert.deepEqual(store.resolve(callbackData), {
    binding: { generation: "generation-a", app: "counter", revision: 4 },
    prompt: "counter::increment",
    text: "Next",
  });
});

test("Button action store resolves registered actions once and expires old entries", () => {
  const store = createTelegramButtonActionStore();
  const callbackData = store.register({
    text: "Run",
    prompt: "Do it.",
    selectedStyle: "primary",
  });

  assert.deepEqual(store.resolve(callbackData), {
    text: "Run",
    prompt: "Do it.",
    selectedStyle: "primary",
  });
  assert.equal(store.resolve(callbackData), undefined);
  assert.equal(store.resolve("other:callback"), undefined);

  const expiringStore = createTelegramButtonActionStore({ ttlMs: -1 });
  const expiredCallbackData = expiringStore.register({
    text: "Expired",
    prompt: "Too late.",
  });
  assert.equal(expiringStore.resolve(expiredCallbackData), undefined);
});

test("Button prompt turn preserves prompt text and queue metadata", () => {
  const turn = createTelegramButtonPromptTurn({
    chatId: 10,
    replyToMessageId: 20,
    queueOrder: 30,
    action: { text: "Run", prompt: "Run this now." },
    target: { chatId: 10, threadId: 40 },
    telegramPrefix: "[telegram|thread:Nimbus]",
  });

  assert.equal(turn.kind, "prompt");
  assert.equal(turn.chatId, 10);
  assert.deepEqual(turn.target, { chatId: 10, threadId: 40 });
  assert.equal(turn.replyToMessageId, 20);
  assert.equal(turn.queueLane, "priority");
  assert.deepEqual(turn.sourceMessageIds, [20]);
  assert.deepEqual(turn.content, [
    { type: "text", text: "[telegram|thread:Nimbus] Run this now." },
  ]);
  assert.equal(turn.historyText, "Run this now.");
  assert.equal(turn.statusSummary, "Run");
});

test("Button callback handler keeps successful bound actions successful when old styling fails", async () => {
  const answered: string[] = [];
  const invoked: string[] = [];
  const edited: unknown[] = [];
  const handled = await handleTelegramButtonCallbackQuery(
    {
      id: "q-bound",
      data: "tgbtn:bound",
      message: {
        message_id: 2,
        chat: { id: 1 },
        reply_markup: {
          inline_keyboard: [
            [{ text: "Next", callback_data: "tgbtn:bound" }],
          ],
        },
      },
    },
    "ctx",
    {
      resolveAction: () => ({ text: "Next", prompt: "music::next" }),
      answerCallbackQuery: async (_id, text) => {
        answered.push(text ?? "");
      },
      invokeBoundAction: async (_query, action) => {
        invoked.push(action.prompt);
        return "new";
      },
      enqueueButtonPrompt: () => {
        throw new Error("bound actions must not enter the model queue");
      },
      editMessageReplyMarkup: async (chatId, messageId, replyMarkup) => {
        edited.push({ chatId, messageId, replyMarkup });
        throw new Error("old message cannot be restyled");
      },
    },
  );
  assert.equal(handled, true);
  assert.deepEqual(invoked, ["music::next"]);
  assert.deepEqual(answered, ["Done."]);
  assert.equal(edited.length, 1);
});

test("Button callback handler answers bound-action failures without queue fallback", async () => {
  const answered: string[] = [];
  await assert.rejects(
    handleTelegramButtonCallbackQuery(
      {
        id: "q-bound-failed",
        data: "tgbtn:bound-failed",
        message: { message_id: 2, chat: { id: 1 } },
      },
      "ctx",
      {
        resolveAction: () => ({ text: "Broken", prompt: "music::broken" }),
        answerCallbackQuery: async (_id, text) => {
          answered.push(text ?? "");
        },
        invokeBoundAction: async () => {
          throw new Error("app failed");
        },
        enqueueButtonPrompt: () => {
          throw new Error("failed bound actions must not enter the model queue");
        },
      },
    ),
    /app failed/,
  );
  assert.deepEqual(answered, ["Generative App action failed."]);
});

test("Button callback handler enqueues owned actions, marks the selected button, and consumes expired buttons", async () => {
  const answered: string[] = [];
  const enqueued: unknown[] = [];
  const edited: unknown[] = [];
  const handled = await handleTelegramButtonCallbackQuery(
    {
      id: "q1",
      data: "tgbtn:live",
      message: {
        message_id: 2,
        chat: { id: 1 },
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🚀 Run", callback_data: "tgbtn:live" },
              { text: "Wait", callback_data: "tgbtn:wait" },
            ],
          ],
        },
      },
    },
    "ctx",
    {
      resolveAction: () => ({
        text: "Run",
        prompt: "Run it.",
        selectedStyle: "danger",
      }),
      answerCallbackQuery: async (_id, text) => {
        answered.push(text ?? "");
      },
      enqueueButtonPrompt: (query, action, ctx) => {
        enqueued.push({ query, action, ctx });
      },
      editMessageReplyMarkup: async (chatId, messageId, replyMarkup) => {
        edited.push({ chatId, messageId, replyMarkup });
      },
    },
  );

  assert.equal(handled, true);
  assert.deepEqual(answered, ["Queued."]);
  assert.equal(enqueued.length, 1);
  assert.deepEqual(edited, [
    {
      chatId: 1,
      messageId: 2,
      replyMarkup: {
        inline_keyboard: [
          [
            {
              text: "🚀 Run",
              callback_data: "tgbtn:live",
              style: "danger",
            },
            { text: "Wait", callback_data: "tgbtn:wait" },
          ],
        ],
      },
    },
  ]);

  const expired = await handleTelegramButtonCallbackQuery(
    { id: "q2", data: "tgbtn:expired" },
    "ctx",
    {
      resolveAction: () => undefined,
      answerCallbackQuery: async (_id, text) => {
        answered.push(text ?? "");
      },
      enqueueButtonPrompt: () => {
        throw new Error("must not enqueue expired buttons");
      },
    },
  );

  assert.equal(expired, true);
  assert.deepEqual(answered, ["Queued.", "Button action expired."]);

  const duplicate = await handleTelegramButtonCallbackQuery(
    {
      id: "q3",
      data: "tgbtn:duplicate",
      message: {
        message_id: 3,
        chat: { id: 1 },
        reply_markup: {
          inline_keyboard: [
            [{ text: "Run", callback_data: "tgbtn:duplicate" }],
          ],
        },
      },
    },
    "ctx",
    {
      resolveAction: () => ({ text: "Run", prompt: "Run it." }),
      answerCallbackQuery: async (_id, text) => {
        answered.push(text ?? "");
      },
      enqueueButtonPrompt: () => false,
      editMessageReplyMarkup: async () => {
        throw new Error("must not mark a prompt that was not queued");
      },
    },
  );
  assert.equal(duplicate, true);
  assert.deepEqual(answered, [
    "Queued.",
    "Button action expired.",
    "Already queued.",
  ]);
});
