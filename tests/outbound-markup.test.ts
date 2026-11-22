/**
 * Regression tests for Telegram outbound markup helpers
 * Exercises delimiter-based assistant action comment parsing, stripping, and voice reply planning
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  collectTelegramHtmlComments,
  formatTelegramUiChoiceRows,
  parseTelegramUiDeclaration,
  getTelegramActionString,
  planTelegramVoiceReply,
  stripTelegramCommentMarkupForDelivery,
  stripTelegramCommentMarkupForPreview,
} from "../lib/outbound-markup.ts";


function uiDeclaration(element: string, payload: unknown) {
  const result = parseTelegramUiDeclaration(element, JSON.stringify(payload));
  assert.ok(result.ok, result.ok ? undefined : result.message);
  return result.declaration;
}

function uiChoice(choices: unknown) {
  const declaration = uiDeclaration("telegram_choice", { question: "Format?", choices });
  assert.equal(declaration.kind, "choice");
  if (declaration.kind !== "choice") throw new Error("Expected Choice");
  return declaration;
}

for (const [label, element, payload] of [
  ["confirm-string", "telegram_confirm", "Continue?"], ["confirm-object", "telegram_confirm", { question: "Continue?" }],
  ["choice", "telegram_choice", { question: "Q", choices: ["A", "B"] }],
  ["set", "telegram_choice", { question: "Q", choices: ["A", "B"], select: 2 }],
  ["wizard", "telegram_choice", [{ question: "First", choices: ["A"] }, { question: "Last", choices: ["B"] }]],
] as const)
test(`Private agent default normalization changes only omitted selection timeouts (${label})`, () => {
  const source = JSON.stringify(payload), legacy = parseTelegramUiDeclaration(element, source), opted = parseTelegramUiDeclaration(element, source, true);
  assert.ok(legacy.ok && opted.ok); assert.equal(legacy.declaration.timeoutMs, 3_600_000); assert.equal(opted.declaration.timeoutMs, 86_400_000);
  if (opted.declaration.kind === "choice") assert.ok(opted.declaration.questions.every(question => question.timeoutMs === 86_400_000));
  assert.ok(Object.isFrozen(opted.declaration));
});

for (const element of ["telegram_text_input", "telegram_attachment"] as const)
test(`Private agent default normalization does not change reserved non-selection defaults (${element})`, () => {
  const source = JSON.stringify({ question: "Q" });
  assert.deepEqual(parseTelegramUiDeclaration(element, source, true), parseTelegramUiDeclaration(element, source));
  const parsed = parseTelegramUiDeclaration(element, source, true); assert.ok(parsed.ok); assert.equal(parsed.declaration.timeoutMs, 300_000);
});

test("Private agent default normalization preserves explicit bounds and each wizard producer deadline", () => {
  for (const mode of [undefined, true] as const) for (const timeoutMs of [1, 1000, 300_000, 3_600_000]) {
    const parsed = parseTelegramUiDeclaration("telegram_confirm", JSON.stringify({ question: "Q", timeoutMs }), mode);
    assert.ok(parsed.ok); assert.equal(parsed.declaration.timeoutMs, timeoutMs);
  }
  for (const timeoutMs of [null, 0, -1, 1.5, "1000", 3_600_001, 86_400_000, 2_147_483_647])
    assert.equal(parseTelegramUiDeclaration("telegram_choice", JSON.stringify({ question: "Q", choices: ["A"], timeoutMs }), true).ok, false);
  const mixed = parseTelegramUiDeclaration("telegram_choice", JSON.stringify([{ question: "First", choices: ["A"], timeoutMs: 1000 }, { question: "Last", choices: ["B"] }]), true);
  assert.ok(mixed.ok && mixed.declaration.kind === "choice");
  assert.deepEqual(mixed.declaration.questions.map(question => question.timeoutMs), [1000, 86_400_000]);
  assert.equal(mixed.declaration.timeoutMs, 86_400_000, "Representation aggregate remains capped, not a new collector deadline");
});

test("Private agent default mode is literal opt-in, never a declaration payload field", () => {
  for (const flag of [false, null, 0, "true", {}, []]) assert.throws(() => parseTelegramUiDeclaration("telegram_confirm", '"Q"', flag as never), TypeError);
  for (const mode of [undefined, true] as const)
    assert.equal(parseTelegramUiDeclaration("telegram_confirm", JSON.stringify({ question: "Q", questionHeadTail: true }), mode).ok, false);
});

test("Agent shorthand keeps transport fields out of authoring and validates exact multi-selection counts", () => {
  assert.deepEqual(uiDeclaration("telegram_confirm", "Continue?"), uiDeclaration("telegram_confirm", { question: "Continue?" }));
  const compact = uiDeclaration("telegram_choice", { question: "Pick two", choices: [["A", "B"], "C"], select: 2 });
  assert.equal(compact.kind, "choice");
  if (compact.kind !== "choice") throw new Error("Expected Choice");
  assert.equal(compact.questions[0]!.select, 2);
  assert.deepEqual(compact.questions[0]!.rows.map(row => row.map(cell => cell.label)), [["A", "B"], ["C"]]);
  for (const select of [0, -1, 1.5, 3, null, true, "2"]) assert.equal(parseTelegramUiDeclaration("telegram_choice",
    JSON.stringify({ question: "Q", choices: ["A", { label: "B", disabled: true }], select })).ok, false);
  const wizard = uiDeclaration("telegram_choice", [{ question: "Q", choices: ["A", "B"] }, { question: "Q", choices: ["C"] }]);
  assert.equal(wizard.kind === "choice" && wizard.batched, true);
});

test("Agent selection defaults to one hour while lower explicit deadlines and private input defaults stay separate", () => {
  const question = { question: "Q", choices: ["A"] };
  assert.equal(uiChoice(question.choices).questions[0]!.timeoutMs, 3_600_000);
  const declared = uiDeclaration("telegram_choice", [{ ...question, timeoutMs: 1000 }, question]);
  assert.equal(declared.kind, "choice");
  if (declared.kind === "choice") assert.deepEqual(declared.questions.map(item => item.timeoutMs), [1000, 3_600_000]);
  assert.equal(uiDeclaration("telegram_confirm", "Q").timeoutMs, 3_600_000);
  assert.equal(uiDeclaration("telegram_confirm", { question: "Q", timeoutMs: 1000 }).timeoutMs, 1000);
});

test("UI wire declarations normalize four strict families without caller-owned authority", () => {
  const confirm = uiDeclaration("telegram_confirm", { question: "Apply?", id: "optional" });
  assert.deepEqual(confirm, { kind: "confirm", id: "optional", question: "Apply?", timeoutMs: 3600000,
    cancelLabel: "❌ No", confirmLabel: "✅ Yes" });
  assert.deepEqual(uiDeclaration("telegram_text_input", { question: "Title?" }),
    { kind: "text_input", question: "Title?", timeoutMs: 300000, cancelLabel: "❌ Cancel", maxLength: 4096, multiline: false });
  assert.deepEqual(uiDeclaration("telegram_attachment", { question: "CSV?", accept: ["TEXT/CSV"] }),
    { kind: "attachment", question: "CSV?", timeoutMs: 300000, cancelLabel: "❌ Cancel",
      accept: ["text/csv"], maxFiles: 1, maxBytes: 10485760 });
  assert.equal(uiChoice([{ label: "CSV" }]).questions[0]!.id, undefined);
  for (const field of ["owner", "scope", "target", "handler", "callback_data", "signal", "nativeAction"]) {
    assert.equal(parseTelegramUiDeclaration("telegram_choice",
      JSON.stringify({ question: "Q", choices: { label: "A" }, [field]: "quit:confirm" })).ok, false);
  }
  assert.equal(parseTelegramUiDeclaration("telegram_wizard", "[]").ok, false);
  assert.equal(parseTelegramUiDeclaration("__proto__", "{}").ok, false);
});

test("UI Choice distinguishes a question, a batch, and button rows; equal question text needs no IDs", () => {
  const question = { question: "Format?", choices: [[{ label: "A" }, { label: "B" }], { label: "C" }] };
  const single = uiDeclaration("telegram_choice", question);
  const batch = uiDeclaration("telegram_choice", [question, question]);
  assert.equal(single.kind, "choice"); assert.equal(batch.kind, "choice");
  if (single.kind !== "choice" || batch.kind !== "choice") return assert.fail();
  assert.equal(single.batched, false); assert.equal(single.questions.length, 1);
  assert.equal(batch.batched, true); assert.equal(batch.questions.length, 2);
  assert.deepEqual(batch.questions[0]!.rows.map(row => row.length), [2, 1]);
  assert.equal(batch.timeoutMs, 3600000);
  assert.equal(uiChoice({ label: "/quit", value: "quit:confirm" }).questions[0]!.rows[0]![0]!.value, "quit:confirm");
  assert.equal(parseTelegramUiDeclaration("telegram_choice", JSON.stringify([question, { label: "not a question" }])).ok, false);
  assert.equal(parseTelegramUiDeclaration("telegram_choice", JSON.stringify([{ ...question, id: "x" }, { ...question, id: "x" }])).ok, false);
});

test("UI declarations are immutable snapshots and preserve disabled/style matrix semantics", () => {
  const original = { question: "Q", choices: [[{ label: "A", value: "a", style: "primary" }],
    { label: "Unavailable", disabled: true }] };
  const normalized = uiDeclaration("telegram_choice", original);
  original.choices.length = 0;
  assert.equal(normalized.kind, "choice");
  if (normalized.kind !== "choice") return assert.fail();
  assert.ok(Object.isFrozen(normalized)); assert.ok(Object.isFrozen(normalized.questions));
  assert.ok(Object.isFrozen(normalized.questions[0])); assert.ok(Object.isFrozen(normalized.questions[0]!.rows));
  assert.ok(Object.isFrozen(normalized.questions[0]!.rows[0])); assert.ok(Object.isFrozen(normalized.questions[0]!.rows[0]![0]));
  assert.equal(normalized.questions[0]!.rows[0]![0]!.style, "primary");
  assert.equal(normalized.questions[0]!.rows[1]![0]!.disabled, true);
  const files = uiDeclaration("telegram_attachment", { question: "Files?" });
  assert.equal(files.kind, "attachment");
  if (files.kind === "attachment") assert.ok(Object.isFrozen(files.accept));
});

test("UI Choice JSON, CML and mixed cells share one lossless semantic matrix", () => {
  const json = [[{ label: "JSON", value: "json", style: "primary" }, { label: "CSV", value: "csv" }],
    { label: "Later", value: "", disabled: true }];
  const cml = '[[{JSON|json|primary}{CSV|csv}]{Later|||1}]';
  const mixed = '[[{"label":"JSON","value":"json","style":"primary"}{CSV|csv}]{Later|||1}]';
  const expected = uiChoice(json).questions[0]!.rows;
  assert.deepEqual(uiChoice(cml).questions[0]!.rows, expected);
  assert.deepEqual(uiChoice(mixed).questions[0]!.rows, expected);
  assert.deepEqual(uiChoice(JSON.stringify(json)).questions[0]!.rows, expected);
  for (const input of [json, cml, mixed, [{ label: 'a|b}\\c', value: 'x}y|z\\' }],
    [{ label: '"value":"not the label"', value: "safe" }]]) {
    const rows = uiChoice(input).questions[0]!.rows;
    for (const format of ["json", "cml"] as const) {
      assert.deepEqual(uiChoice(formatTelegramUiChoiceRows(rows, format)).questions[0]!.rows, rows);
    }
  }
});

test("UI Choice canonical conversions preserve matrix semantics across literal/JSON boundaries", () => {
  const labels = ["JSON", 'a|b}\\\\c', '"value":"decoy"', "{braced}", "[row]", "🧾 CSV", "x,y:z", '"quoted"', "a\\\\b"];
  for (const style of [undefined, "primary", "success", "danger"]) {
    const rows = uiChoice(labels.map((label, index) => [
      { label, value: `value-${index}`, style },
      { label: "Disabled", value: "", disabled: true },
    ])).questions[0]!.rows;
    for (const format of ["json", "cml"] as const) {
      const canonical = formatTelegramUiChoiceRows(rows, format);
      const decoded = uiChoice(canonical).questions[0]!.rows;
      assert.deepEqual(decoded, rows);
      assert.equal(formatTelegramUiChoiceRows(decoded, format), canonical);
    }
  }
});

test("UI Choice round trips preserve explicitly blank disabled labels without revealing their values", () => {
  for (const style of [undefined, "primary", "success", "danger"]) {
    for (const value of ["", "hidden-value", '"value":"private"']) {
      const rows = uiChoice([{ label: "Enabled", value: "ok" },
        { label: "", value, disabled: true, style }]).questions[0]!.rows;
      for (const format of ["json", "cml"] as const) {
        const encoded = formatTelegramUiChoiceRows(rows, format);
        const decoded = uiChoice(encoded).questions[0]!.rows;
        assert.deepEqual(decoded, rows, `${format}, style=${style}, value=${value}`);
        assert.equal(decoded[1]![0]!.label, "");
      }
    }
  }
});

test("UI Choice rejects partial or ambiguous matrix interpretations", () => {
  for (const choices of [[], [[]], [[[]]], [1], [{ label: "a", value: "same" }, { label: "b", value: "same" }],
    [{ label: "Only disabled", disabled: true }], [{ label: "Bad", disabled: "true" }],
    [{ label: "Bad", prompt: "/quit" }], [{ label: "Bad", style: "other" }],
    [{ label: null, value: "A" }], [{ label: "A", value: null }],
    '[{A},{B}', '[{A},,{B}]', '[[[{A}]]]', '[{"label":"A","value":}{B}]',
    '[{A} trailing]', '[{A|a|success|false|extra}]', '[{A|a|unknown}]']) {
    assert.equal(parseTelegramUiDeclaration("telegram_choice", JSON.stringify({ question: "Q", choices })).ok, false,
      JSON.stringify(choices));
  }
});

test("UI wire bounds accept inclusive edges and reject their neighboring invalid region", () => {
  const question = { question: "Q", timeoutMs: 3600000, choices: { label: "A" } };
  assert.equal(uiDeclaration("telegram_choice", Array.from({ length: 32 }, () => question)).kind, "choice");
  const batch = uiDeclaration("telegram_choice", [question, question]);
  if (batch.kind === "choice") assert.equal(batch.timeoutMs, 3600000);
  const cells = Array.from({ length: 64 }, (_, i) => ({ label: String(i) }));
  assert.equal(uiChoice(cells).questions[0]!.rows.length, 64);
  assert.equal(uiChoice([cells.slice(0, 8)]).questions[0]!.rows[0]!.length, 8);
  assert.equal(uiChoice({ label: "a".repeat(128), value: "v".repeat(256) }).kind, "choice");
  for (const payload of [[], Array.from({ length: 33 }, () => question),
    { ...question, choices: [...cells, { label: "65" }] },
    { ...question, choices: [cells.slice(0, 9)] },
    { ...question, choices: { label: "a".repeat(129) } },
    { ...question, question: "Q".repeat(1025) }]) {
    assert.equal(parseTelegramUiDeclaration("telegram_choice", JSON.stringify(payload)).ok, false);
  }
  for (const timeoutMs of [0, -1, 1.5, 3600001, null, "100"]) {
    assert.equal(parseTelegramUiDeclaration("telegram_choice", JSON.stringify({ ...question, timeoutMs })).ok, false);
  }
  assert.equal(uiDeclaration("telegram_text_input", { question: "Q", timeoutMs: 1, maxLength: 16384 }).timeoutMs, 1);
  assert.equal(uiDeclaration("telegram_attachment", { question: "Q", maxFiles: 10, maxBytes: 20971520 }).kind, "attachment");
  for (const [element, fields] of [
    ["telegram_text_input", { maxLength: 16385 }], ["telegram_text_input", { multiline: "false" }],
    ["telegram_attachment", { maxFiles: 11 }], ["telegram_attachment", { maxBytes: 20971521 }],
    ["telegram_attachment", { accept: [] }], ["telegram_attachment", { accept: null }], ["telegram_attachment", { accept: ["text/csv", "TEXT/CSV"] }],
    ["telegram_attachment", { accept: [".csv"] }], ["telegram_attachment", { accept: ["text/*/csv"] }],
  ] as const) assert.equal(parseTelegramUiDeclaration(element, JSON.stringify({ question: "Q", ...fields })).ok, false);
});

test("UI decoder errors are bounded and do not echo payloads or promote invalid text", () => {
  for (const source of ['{"question":"secret-token",', '{"question":"Q",}', "null", "true", "42",
    JSON.stringify({ question: "bad\nline" }), JSON.stringify({ question: "\ud800" }),
    JSON.stringify({ question: "Q", secret_token: "private" }), " ".repeat(65537)]) {
    const parsed = parseTelegramUiDeclaration("telegram_confirm", source);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.doesNotMatch(parsed.message, /secret-token|secret_token|private|bad/u);
  }
  const exact = JSON.stringify({ question: "Q" });
  assert.equal(parseTelegramUiDeclaration("telegram_confirm", exact + " ".repeat(65536 - exact.length)).ok, true);
});

test("Action string fields trim exactly once without coercion or payload mutation", () => {
  for (const value of [undefined, null, 1, false, {}, [], new String("text"), "", " \t\n"]) {
    assert.equal(getTelegramActionString({ value }, "value"), undefined);
  }
  assert.equal(getTelegramActionString({ value: "\t label \n" }, "value"), "label");
  assert.equal(getTelegramActionString({}, "missing"), undefined);
  let reads = 0;
  const payload = { get value() { reads++; return " text "; } };
  assert.equal(getTelegramActionString(payload, "value"), "text");
  assert.equal(reads, 1);
  assert.ok(Object.getOwnPropertyDescriptor(payload, "value")?.get);
});

test("Drafts hide complete and unfinished button fences but preserve outer code examples", () => {
  assert.equal(stripTelegramCommentMarkupForPreview('Before\n```telegram_button\n{Hidden|secret prompt}'), 'Before');
  assert.equal(stripTelegramCommentMarkupForPreview('Before\n```telegram_button\n{Hidden}\n```\nAfter'), 'Before\n\nAfter');
  const example = '````markdown\n```telegram_button\n{Literal}\n```\n````';
  assert.equal(stripTelegramCommentMarkupForPreview(example), example);
});

test("Drafts hide relaxed button fences without activating or exposing payloads", () => {
  for (const marker of ["`", "~"]) {
    const opening = ` \t${marker.repeat(4)} \ttelegram_button \t`;
    for (const tail of ["", `\n\t${marker.repeat(5)}\nAfter`]) {
      const preview = stripTelegramCommentMarkupForPreview(`Before\n${opening}\n{Hidden|secret prompt}${tail}`);
      assert.equal(preview, tail ? "Before\n\nAfter" : "Before");
      assert.doesNotMatch(preview, /secret|telegram_button/u);
    }
    const example = `    ${marker.repeat(5)}markdown\n${opening}\n{Literal}\n${marker.repeat(4)}\n    ${marker.repeat(5)}`;
    assert.equal(stripTelegramCommentMarkupForPreview(example), example.trim());
  }
});

test("Action comments depend only on delimiters and payload, retaining exact source spans", () => {
  const raw = '<!-- telegram_voice {Speak.|en} -->';
  for (const [before, after] of [
    ["", ""], [" ", " "], ["    ", ""], ["\t", ""], [" \t  ", ""],
    ["Text ", " tail"], ["> ", ""], ["- ", ""], ["1. ", ""],
    ["`", "`"], ["```md\n", "\n```"], ["~~~~md\n", "\n~~~~"],
    ["\\", ""],
  ]) {
    const markdown = `Before\r\n${before}${raw}${after}\r\nAfter`;
    const { comments } = collectTelegramHtmlComments(markdown);
    assert.equal(comments.length, 1);
    assert.equal(comments[0]?.raw, raw);
    assert.equal(markdown.slice(comments[0]!.start, comments[0]!.end), raw);
    const plan = planTelegramVoiceReply(markdown);
    assert.deepEqual(plan.voiceReplies, [{ text: "Speak.", lang: "en" }]);
    assert.equal(plan.markdown, `Before\r\n${before}${after}\r\nAfter`);
  }
});

test("Adjacent comments on one line are independent and open tails never activate", () => {
  const first = '<!-- telegram_voice {First.} -->';
  const second = '<!-- telegram_voice {Second.} -->';
  const markdown = `Text ${first}${second} tail <!-- telegram_voice {Unfinished.}`;
  const result = collectTelegramHtmlComments(markdown);
  assert.deepEqual(result.comments.map((comment) => comment.raw), [first, second]);
  assert.equal(result.openCommentStart, markdown.lastIndexOf("<!--"));
  assert.deepEqual(planTelegramVoiceReply(markdown).voiceReplies, [
    { text: "First." }, { text: "Second." },
  ]);
  assert.equal(planTelegramVoiceReply(markdown).markdown, "Text  tail");
  for (const tail of ["<", "<!", "<!-", "<!-- private"]) {
    assert.equal(stripTelegramCommentMarkupForPreview(`Text ${tail}`), "Text");
    assert.equal(stripTelegramCommentMarkupForDelivery(`Text ${tail}`), "Text");
  }
  for (const literal of ["&lt;!-- telegram_voice {Example.} --&gt;", "< !-- telegram_voice {Invalid.} -->"]) {
    assert.deepEqual(collectTelegramHtmlComments(literal).comments, []);
    assert.equal(planTelegramVoiceReply(literal).voiceReplies, undefined);
  }
});

test("Markup stripping removes every HTML comment from Telegram surfaces", () => {
  const markdown = [
    "Visible <!-- inline --> text.",
    "",
    "> Quoted <!-- private quote --> text.",
    "",
    "- Listed <!-- private list --> text.",
    "",
    "```md",
    "<!-- private code example -->",
    "const visible = true;",
    "```",
  ].join("\n");
  const delivery = stripTelegramCommentMarkupForDelivery(markdown);
  const preview = stripTelegramCommentMarkupForPreview(markdown);

  assert.equal(delivery, preview);
  assert.doesNotMatch(delivery, /<!--|-->/u);
  assert.match(delivery, /Visible  text\./u);
  assert.match(delivery, /> Quoted  text\./u);
  assert.match(delivery, /- Listed  text\./u);
  assert.match(delivery, /const visible = true;/u);
  assert.equal(
    stripTelegramCommentMarkupForDelivery(
      " \n<!-- first -->\n<!-- second -->\n ",
    ),
    "",
  );
  assert.equal(
    stripTelegramCommentMarkupForPreview("Visible\n\n<!-- streaming private tail"),
    "Visible",
  );
});

test("Voice reply planner retains legacy attribute compatibility", () => {
  const plan = planTelegramVoiceReply(
    [
      "Visible answer.",
      "",
      '<!-- telegram_voice {"text":"JSON voice.","lang":"ru"} -->',
      '<!-- telegram_voice {"text":"Rated JSON voice.","rate":"+10%"} -->',
      '<!-- telegram_voice text="Attribute voice." lang="en" -->',
      '<!-- telegram_voice {"value":"JSON value voice."} -->',
      '<!-- telegram_voice value="Attribute value voice." -->',
      '<!-- telegram_voice {"value":"Fallback voice.","text":"Explicit voice."} -->',
      '<!-- telegram_voice {Keep this voice.} [unrelated envelope text] -->',
    ].join("\n"),
  );

  assert.equal(plan.markdown, "Visible answer.");
  assert.deepEqual(plan.voiceReplies, [
    { text: "JSON voice.", lang: "ru" },
    { text: "Rated JSON voice.", rate: "+10%" },
    { text: "Attribute voice.", lang: "en" },
    { text: "JSON value voice." },
    { text: "Attribute value voice." },
    { text: "Explicit voice." },
    { text: "Keep this voice." },
  ]);
});

test("Voice reply planner ignores payloads outside the canonical action shape", () => {
  const plan = planTelegramVoiceReply(
    [
      '<!-- telegram_voice [{"text":"Array is unsupported."}] -->',
      '<!-- telegram_voice {"lang":"ru"} -->',
      '<!-- telegram_voice {"text": -->',
      '<!-- telegram_voice {"text":"Must not become CML","rate":} -->',
      '<!-- telegram_voice unknown="Speak this." -->',
      '<!-- telegram_voice [broken text=Must-not-recover] -->',
      '<!-- telegram_voice [[{Matrix is unsupported.}]] -->',
      '<!-- telegram_voice {|en} -->',
      '<!-- telegram_voice {Too|many|voice|atoms} -->',
    ].join("\n"),
  );

  assert.equal(plan.voiceText, undefined);
  assert.equal(plan.voiceReplies, undefined);
  assert.equal(plan.markdown, "");
});

test("Voice reply planner extracts multiple voice replies and cleans markdown", () => {
  const plan = planTelegramVoiceReply(
    [
      "Visible answer.",
      "",
      '<!-- telegram_voice {"text":"Первый ответ.","lang":"ru","rate":"+20%"} -->',
      "",
      '<!-- telegram_voice lang="en" text="Second answer." -->',
      "",
      "Tail.",
    ].join("\n"),
  );

  assert.equal(plan.markdown, "Visible answer.\n\nTail.");
  assert.equal(plan.voiceText, "Первый ответ.\n\nSecond answer.");
  assert.deepEqual(plan.voiceReplies, [
    { text: "Первый ответ.", lang: "ru", rate: "+20%" },
    { text: "Second answer.", lang: "en" },
  ]);
  assert.equal(plan.lang, "en");
  assert.equal(plan.rate, "+20%");
});
