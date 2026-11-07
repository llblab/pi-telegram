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
  createTelegramButtonReplyPlanner,
  handleTelegramButtonCallbackQuery,
  markTelegramButtonSelected,
  planTelegramButtonReply,
  type TelegramOutboundButtonAction,
} from "../lib/outbound-buttons.ts";

function questionExpiryPair(kind: "set" | "wizard" = "set", rendering: "html" | "rich" = "html", authority: () => void = () => {}) {
  const records: { key: string; action: TelegramOutboundButtonAction }[] = [], answers: unknown[] = [];
  let captures = 0;
  const store = createTelegramButtonActionStore({ captureSelectionAuthority() { captures++; return authority; } });
  const short = kind === "set" ? { question: "Short", choices: [{ label: "", disabled: true }, "A", "B"], select: 2, timeoutMs: 100 } :
    [{ question: "Short", choices: ["A"], timeoutMs: 100 }, { question: "Next", choices: ["B"] }];
  const plan = planTelegramButtonReply(`<!-- telegram_choice ${JSON.stringify(short)} -->\n<!-- telegram_choice {"question":"Long","choices":["C","D"],"select":2} -->`, {
    questionHeadTail: true, rendering, registerAction(action) { const key = store.register(action); records.push({ key, action }); return key; },
  });
  let markup = plan.replyMarkup!;
  const groups = [...new Set(records.map(record => record.action.completionGroup!))], owner = records[0]!.action.selection!.owner;
  const query = (key?: string) => ({ id: "q", data: key, message: { chat: { id: 42 }, message_id: 201, reply_markup: markup } });
  const click = async (label: string) => handleTelegramButtonCallbackQuery(query(markup.inline_keyboard.flat().find(button => button.text === label)!.callback_data), undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async () => {},
    updateSelectionKeyboard: async (_query, next, guard) => { guard(); markup = next; },
    updateSelectionMessage: async (_query, _markdown, mode, next, guard) => { guard(); assert.equal(mode, rendering); markup = next; },
    enqueueButtonPrompt: (_query, action) => { answers.push(JSON.parse(action.prompt)); },
  });
  return { store, records, answers, groups, owner, query, click, captures: () => captures, markup: () => markup };
}

for (const kind of ["set", "wizard"] as const) for (const rendering of ["html", "rich"] as const)
test(`Question-local expiry retires only its semantic group and regenerates its live neighbor (${kind}/${rendering})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const h = questionExpiryPair(kind, rendering), oldShort = h.records[0]!, long = h.records.find(record => record.action.completionGroup === h.groups[1])!;
  try {
    assert.equal(h.groups.length, 2); assert.equal(h.captures(), 1); assert.equal(long.action.selection!.owner, h.owner);
    t.mock.timers.tick(100);
    assert.equal(h.store.resolve(oldShort.key), undefined); assert.equal(oldShort.action.selection!.prepare(h.query()), undefined);
    assert.equal(h.groups[1]!.deadline!.expiresAt, 86_401_000);
    await h.click("C"); assert.deepEqual(h.answers, []);
    const expired = h.markup().inline_keyboard.flat().filter(button => button.text.startsWith("Expired: "));
    assert.ok(expired.length >= 2); assert.ok(expired.every(button => button.callback_data === "tgbtn:expired" && !button.style));
    if (kind === "set") assert.ok(h.markup().inline_keyboard.flat().some(button => button.disabled && button.text === "\u00a0" && !button.callback_data));
    assert.ok(h.records.filter(record => record.action.completionGroup === h.groups[1]).every(record => record.action.selection!.owner === h.owner && record.action.expiresAt === 86_401_000));
    await h.click("D"); assert.deepEqual(h.answers, [{ question: "Long", answer: ["C", "D"] }]);
    assert.equal(h.captures(), 1, "Expiry or regeneration cannot reacquire footer authority");
    assert.equal(oldShort.action.selection!.prepare(h.query()), undefined);
  } finally { h.store.clear!(); }
});

test("Question-local expiry feedback never reclassifies an already answered neighbor as expired", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const h = questionExpiryPair();
  try {
    await h.click("A"); await h.click("B"); assert.equal(h.answers.length, 1);
    t.mock.timers.tick(100); assert.equal(h.records[0]!.action.selection!.prepare(h.query()), undefined);
    await h.click("C"); await h.click("D"); assert.equal(h.answers.length, 2);
    assert.equal(h.markup().inline_keyboard.flat().some(button => button.text.startsWith("Expired: ")), false, "Consumption stays disabled, not expired");
  } finally { h.store.clear!(); }
});

for (const trigger of ["cleanup", "wrapped-prepare", "raw-prepare"] as const)
test(`Question-local expiry without timer dispatch preserves the neighboring lifetime (${trigger})`, async t => {
  t.mock.timers.enable({ apis: ["Date"] }); t.mock.timers.setTime(1000);
  const h = questionExpiryPair(), short = h.records[0]!, wrapped = trigger === "wrapped-prepare" ? h.store.resolve(short.key) : undefined;
  try {
    t.mock.timers.setTime(1100);
    if (trigger === "wrapped-prepare") assert.equal(wrapped!.selection!.prepare(h.query()), undefined);
    else if (trigger === "raw-prepare") assert.equal(short.action.selection!.prepare(h.query()), undefined);
    else assert.equal(h.store.resolve(short.key), undefined);
    await h.click("C"); await h.click("D"); assert.equal(h.answers.length, 1);
    assert.equal(h.groups[1]!.deadline!.expiresAt, 86_401_000);
  } finally { h.store.clear!(); }
});

test("Question-local expiry through a wrapped guard retires original raw aliases before clock restoration", t => {
  t.mock.timers.enable({ apis: ["Date"] }); t.mock.timers.setTime(1000);
  const h = questionExpiryPair(), raw = h.records[0]!.action.selection!, wrapped = h.store.resolve(h.records[0]!.key)!.selection!;
  try {
    t.mock.timers.setTime(1100); assert.equal(wrapped.prepare(h.query()), undefined);
    t.mock.timers.setTime(1000); assert.doesNotThrow(() => assert.equal(raw.prepare(h.query()), undefined), "Wrapped known expiry terminalizes the original collector: later raw guards must refuse passively, not reenter registration");
  } finally { h.store.clear!(); }
});

test("Question-local expiry remains sticky in a raw collector and cannot silently disable regenerated expiry feedback", t => {
  t.mock.timers.enable({ apis: ["Date"] }); t.mock.timers.setTime(1000);
  const h = questionExpiryPair(), raw = h.records[0]!.action.selection!;
  try {
    t.mock.timers.setTime(1100); assert.equal(raw.prepare(h.query()), undefined);
    t.mock.timers.setTime(1000); assert.equal(raw.prepare(h.query()), undefined, "An observed own deadline cannot revive on clock restoration");
    const long = h.records.find(record => record.action.completionGroup === h.groups[1])!;
    const prepared = h.store.resolve(long.key)!.selection!.prepare(h.query()); assert.ok(prepared);
    assert.ok(prepared.replyMarkup.inline_keyboard.flat().some(button => button.text === "Expired: A" && button.callback_data === "tgbtn:expired"));
    prepared.fail();
  } finally { h.store.clear!(); }
});

test("Question-local expiry remains sticky for a raw prepared update without releasing its footer span", t => {
  t.mock.timers.enable({ apis: ["Date"] }); t.mock.timers.setTime(1000);
  const h = questionExpiryPair();
  try {
    const prepared = h.records[0]!.action.selection!.prepare(h.query()); assert.ok(prepared);
    t.mock.timers.setTime(1100); assert.throws(prepared.assertCurrent, /unavailable/u);
    t.mock.timers.setTime(1000); assert.throws(prepared.assertCurrent, /unavailable/u);
    const long = h.records.find(record => record.action.completionGroup === h.groups[1])!;
    assert.equal(long.action.selection!.prepare(h.query()), undefined, "An issued/prepared footer span stays occupied until its owner settles it");
    prepared.fail();
  } finally { h.store.clear!(); }
});

for (const failure of ["authority", "capacity", "uncertain-prepared"] as const)
test(`Question-local expiry does not narrow footer-wide failure retirement (${failure})`, t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  let current = true; const h = questionExpiryPair("set", "html", () => { if (!current) throw new Error("Original footer owner lost"); });
  const short = h.records[0]!, longRows = h.records.filter(record => record.action.completionGroup === h.groups[1]), longGuard = h.store.resolve(longRows[0]!.key)!;
  try {
    if (failure === "authority") { current = false; assert.equal(h.store.resolve(short.key)!.selection!.prepare(h.query()), undefined); }
    if (failure === "capacity") { t.mock.timers.setTime(1001); for (let i = 0; i < 60; i++) h.store.register({ text: "Other", prompt: "Other" }); }
    if (failure === "uncertain-prepared") { const prepared = h.store.resolve(short.key)!.selection!.prepare(h.query()); assert.ok(prepared); t.mock.timers.tick(100);
      assert.throws(prepared.assertCurrent, /unavailable/u); prepared.fail(); }
    current = true; const currentLong = h.records.filter(record => record.action.completionGroup === h.groups[1]).at(-1)!;
    assert.equal(h.store.resolve(currentLong.key), undefined); assert.equal(longGuard.selection!.prepare(h.query()), undefined);
    assert.deepEqual(h.answers, []);
  } finally { h.store.clear!(); }
});

function privateAgentDefaultFixture(kind: "confirm" | "choice" | "set" | "wizard", rendering: "html" | "rich", ttlMs?: number, timeoutMs?: number) {
  const records: TelegramOutboundButtonAction[] = [], reasons: unknown[] = [];
  const store = createTelegramButtonActionStore({ ...(ttlMs === undefined ? {} : { ttlMs }), recordRuntimeEvent: (_category, _message, details) => { reasons.push(details?.reason); } });
  const common = { question: "Q", ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  const value = kind === "confirm" ? common : kind === "wizard" ?
    [{ ...common, question: "First", choices: ["A"] }, { question: "Last", choices: ["B"] }] :
    { ...common, choices: ["A", "B"], ...(kind === "set" ? { select: 2 } : {}) };
  const planner = createTelegramButtonReplyPlanner({ register(action) { records.push(action); return store.register(action); } }, () => rendering, true);
  const plan = planner(`<!-- ${kind === "confirm" ? "telegram_confirm" : "telegram_choice"} ${JSON.stringify(value)} -->`);
  const deadline = records[0]!.completionGroup!.deadline!; assert.ok(deadline);
  return { store, records, plan, deadline, reasons };
}

for (const kind of ["confirm", "choice", "set", "wizard"] as const) for (const rendering of ["html", "rich"] as const)
test(`Private agent default collector accepts after one hour without renewing steps (${kind}/${rendering})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const h = privateAgentDefaultFixture(kind, rendering), answers: unknown[] = [];
  let markup = h.plan.replyMarkup!;
  const click = async (label: string, data?: string) => handleTelegramButtonCallbackQuery({ id: "q",
    data: data ?? markup.inline_keyboard.flat().find(button => button.text === label)!.callback_data,
    message: { chat: { id: 42 }, message_id: 201, reply_markup: markup },
  }, undefined, { resolveAction: h.store.resolve, answerCallbackQuery: async () => {},
    updateSelectionKeyboard: async (_query, next, guard) => { guard(); markup = next; },
    updateSelectionMessage: async (_query, _markdown, mode, next, guard) => { guard(); assert.equal(mode, rendering); markup = next; },
    enqueueButtonPrompt: (_query, action) => { answers.push(JSON.parse(action.prompt)); } });
  try {
    assert.equal(h.deadline.expiresAt, 86_401_000); assert.ok(h.records.every(action => action.expiresAt === 86_401_000));
    t.mock.timers.tick(3_600_001); const original = markup.inline_keyboard[0]![0]!.callback_data!;
    await click(kind === "confirm" ? "✅ Yes" : "A");
    if (kind === "set" || kind === "wizard") {
      assert.deepEqual(answers, []); t.mock.timers.tick(60_000);
      assert.ok(h.records.every(action => action.completionGroup!.deadline === h.deadline && action.expiresAt === 86_401_000));
      await click("B");
    }
    assert.deepEqual(answers, [kind === "wizard" ? [{ question: "First", answer: "A" }, { question: "Last", answer: "B" }] :
      { question: "Q", answer: kind === "confirm" ? "✅ Yes" : kind === "set" ? ["A", "B"] : "A" }]);
    assert.equal(h.deadline.expiresAt, 86_401_000); await click("", original); assert.equal(answers.length, 1);
  } finally { h.store.clear!(); }
});

for (const kind of ["confirm", "choice", "set", "wizard"] as const)
test(`Private agent default uses the original nearest timer and existing cutoff readers at 24h (${kind})`, t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const h = privateAgentDefaultFixture(kind, "html"), key = h.plan.replyMarkup!.inline_keyboard[0]![0]!.callback_data!;
  try {
    t.mock.timers.tick(86_400_000 - 1); assert.equal(h.deadline.expiresAt, 86_401_000);
    const raw = h.records[0]!.selection, query = { id: "q", message: { chat: { id: 42 }, message_id: 201, reply_markup: h.plan.replyMarkup } };
    const prepared = raw?.prepare(query); if (raw) { assert.ok(prepared); prepared.assertCurrent(); }
    assert.equal(h.reasons.includes("deadline"), false); t.mock.timers.tick(1);
    assert.equal(h.reasons.includes("deadline"), true, "Timer, not the next resolve, retires the association");
    if (raw) { assert.equal(raw.prepare(query), undefined); assert.throws(prepared!.assertCurrent, /unavailable|expired/u); }
    assert.equal(h.store.resolve(key), undefined);
  } finally { h.store.clear!(); }
});

for (const kind of ["confirm", "choice", "set", "wizard"] as const) for (const shorter of ["producer", "store"] as const)
test(`Private agent default never overrides a shorter original cutoff (${kind}/${shorter})`, t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const h = privateAgentDefaultFixture(kind, "html", shorter === "store" ? 100 : undefined, shorter === "producer" ? 100 : undefined);
  try {
    assert.equal(h.deadline.expiresAt, 1100); t.mock.timers.tick(100);
    assert.equal(h.store.resolve(h.plan.replyMarkup!.inline_keyboard[0]![0]!.callback_data), undefined);
  } finally { h.store.clear!(); }
});

test("Private agent default captures the planner policy once before projection and callback reentry", t => {
  t.mock.timers.enable({ apis: ["Date"] }); t.mock.timers.setTime(1000);
  let reads = 0; const actions: TelegramOutboundButtonAction[] = [];
  const deps = { get questionHeadTail() { reads++; assert.equal(reads, 1); return true as const; },
    registerAction(action: TelegramOutboundButtonAction) { actions.push(action); Object.defineProperty(deps, "questionHeadTail", { value: false }); return `key-${actions.length}`; } };
  planTelegramButtonReply('<!-- telegram_confirm "First" -->\n<!-- telegram_choice {"question":"Last","choices":["A"]} -->', deps);
  assert.equal(reads, 1); assert.equal(actions.length, 3); assert.ok(actions.every(action => action.expiresAt === 86_401_000));
});

test("Private agent default rejects invalid private modes before effects and preserves factory omission", t => {
  t.mock.timers.enable({ apis: ["Date"] }); t.mock.timers.setTime(1000);
  let calls = 0;
  for (const flag of [false, null, 1, "true", {}]) {
    assert.throws(() => planTelegramButtonReply("No declaration", { questionHeadTail: flag as never, registerAction() { calls++; return "x"; } }), TypeError);
    assert.throws(() => planTelegramButtonReply('<!-- telegram_confirm "Q" -->', { questionHeadTail: flag as never, registerAction() { calls++; return "x"; } }), TypeError);
    assert.throws(() => createTelegramButtonReplyPlanner({ register() { calls++; return "x"; } }, () => { calls++; return "html"; }, flag as never), TypeError);
  }
  assert.equal(calls, 0); const actions: TelegramOutboundButtonAction[] = [];
  createTelegramButtonReplyPlanner({ register(action) { actions.push(action); return "x"; } })('<!-- telegram_confirm "Q" -->');
  assert.ok(actions.every(action => action.expiresAt === 3_601_000)); assert.equal(actions.length, 2);
  let callbacks = 0;
  planTelegramButtonReply('<!-- telegram_confirm {"question":"Q","timeoutMs":86400000} -->', { questionHeadTail: true, registerAction() { callbacks++; return "x"; } });
  assert.equal(callbacks, 0, "Private omitted default does not widen explicit numeric wire bounds");
});

for (const artifact of ["source", "compiled"] as const) for (const rendering of ["html", "rich"] as const)
for (const kind of ["ordinary", "question"] as const) for (const phase of ["before-ack", "after-ack"] as const)
for (const cause of ["capacity", "deadline"] as const)
test(`Native button retirement distinguishes early pressure from elapsed TTL (${artifact}/${rendering}/${kind}/${phase}/${cause})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const M = artifact === "source" ? { createTelegramButtonActionStore, planTelegramButtonReply, handleTelegramButtonCallbackQuery } : await import("../dist/lib/outbound-buttons.js");
  const events: Array<Record<string, unknown>> = [], edits: unknown[] = [];
  const store = M.createTelegramButtonActionStore({ captureSelectionAuthority: () => () => {}, recordRuntimeEvent(_c, _m, details) { events.push(details!); } });
  const source = kind === "ordinary" ? rendering === "rich" ? '```telegram_button\n{Private label|private prompt}\n```' : '<!-- telegram_button {Private label|private prompt} -->' :
    `<!-- telegram_confirm ${JSON.stringify({ question: "Private question", ...(cause === "deadline" ? { timeoutMs: 900000 } : {}) })} -->`;
  const plan = M.planTelegramButtonReply(source, { rendering, questionHeadTail: true, registerAction(action) {
    return store.register({ ...action, ...(kind === "ordinary" && cause === "deadline" ? { expiresAt: 901000 } : {}) });
  } });
  const body = { chat_id: 7, message_thread_id: 9, ...(plan.replyMarkup ? { reply_markup: plan.replyMarkup } : {}),
    ...(rendering === "html" ? { text: plan.markdown } : { rich_message: { markdown: plan.markdown } }) };
  let current: Record<string, unknown> = body;
  const prepare = (finish: NonNullable<ReturnType<NonNullable<typeof store.beginPublication>>>, input: Record<string, unknown>) => ({ ...input,
    ...(finish.prepareReplyMarkup ? { reply_markup: finish.prepareReplyMarkup() } : {}),
    ...(finish.prepareRichMessage ? { rich_message: finish.prepareRichMessage() } : {}) });
  store.bindPublicationEditor!(async (target, assertCurrent) => {
    assertCurrent();
    const input = { chat_id: target.chatId, message_id: target.messageId,
      ...(target.replyMarkup ? { reply_markup: target.replyMarkup } : {}), ...(target.richMessage ? { rich_message: target.richMessage } : {}) };
    const finish = store.beginPublication!(target.richMessage ? "editMessageText" : "editMessageReplyMarkup", input)!;
    await finish.ready; assertCurrent(); current = prepare(finish, input); edits.push(current); finish("edited", true);
  });
  const publish = store.beginPublication!(rendering === "html" ? "sendMessage" : "sendRichMessage", body)!;
  assert.ok(publish);
  try {
    if (phase === "after-ack") { current = prepare(publish, body); publish({ message_id: 11 }, true); await store.waitForPublicationIdle!(); }
    t.mock.timers.tick(900000);
    if (cause === "capacity") for (let i = 0; i < 60; i++) store.register({ text: "Pressure", prompt: "private pressure" });
    if (phase === "before-ack") { current = prepare(publish, body); publish({ message_id: 11 }, true); }
    await store.waitForPublicationIdle!();
    const wire = JSON.stringify(current), status = cause === "capacity" ? "tgbtn:capacity" : "tgbtn:expired";
    assert.ok(wire.includes(status), wire);
    assert.match(wire, cause === "capacity" ? /Unavailable: /u : /Expired: /u);
    if (cause === "capacity") assert.doesNotMatch(wire, /Expired: /u, "A fifteen-minute capacity eviction is not a TTL deadline");
    if (phase === "after-ack") assert.ok(edits.length > 0, "The original publication owner must actually update its native surface");
    assert.ok(events.some(event => event.reason === cause && event.ageMs === 900000 && event.createdAtMs === 1000 && event.ttlMs === 86400000));
    let toast: string | undefined;
    await M.handleTelegramButtonCallbackQuery({ id: "status", data: status }, undefined, { resolveAction: store.resolve,
      answerCallbackQuery: async (_id, value) => { toast = value; }, enqueueButtonPrompt: () => assert.fail("Retired status cannot admit work"),
    });
    assert.equal(toast, cause === "capacity" ? "Button removed by the control limit" : "Button action expired");
    assert.doesNotMatch(JSON.stringify(events), /private|Private|tgbtn:/u);
  } finally { store.clear!(); await store.waitForPublicationIdle!(); }
});

for (const artifact of ["source", "compiled"] as const) for (const rendering of ["html", "rich"] as const)
for (const kind of ["ordinary", "question"] as const) for (const age of [900000, 3600000, 86399999, 86400000])
test(`Native published defaults do not become fifteen-minute TTLs (${artifact}/${rendering}/${kind}/${age})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const M = artifact === "source" ? { createTelegramButtonActionStore, planTelegramButtonReply, handleTelegramButtonCallbackQuery } : await import("../dist/lib/outbound-buttons.js");
  const store = M.createTelegramButtonActionStore({ captureSelectionAuthority: () => () => {} });
  const source = kind === "question" ? '<!-- telegram_confirm {"question":"Q"} -->' :
    rendering === "rich" ? '```telegram_button\n{Run|run}\n```' : '<!-- telegram_button {Run|run} -->';
  const plan = M.planTelegramButtonReply(source, { rendering, questionHeadTail: true, registerAction: store.register });
  const key = plan.replyMarkup?.inline_keyboard.flat()[0]?.callback_data ?? /data="(tgbtn:[a-f0-9]{8})"/u.exec(plan.markdown)?.[1];
  assert.ok(key);
  store.bindPublicationEditor!(async (_target, guard) => { guard(); });
  const publish = store.beginPublication!(rendering === "rich" ? "sendRichMessage" : "sendMessage", { chat_id: 7, message_thread_id: 9,
    ...(plan.replyMarkup ? { reply_markup: plan.replyMarkup } : {}), ...(rendering === "rich" ? { rich_message: { markdown: plan.markdown } } : { text: plan.markdown }) });
  assert.ok(publish); publish({ message_id: 11 }, true);
  try {
    t.mock.timers.tick(age); await store.waitForPublicationIdle!();
    let admissions = 0;
    const query = { id: "native-clock", data: key, message: { chat: { id: 7 }, message_id: 11, message_thread_id: 9 } };
    await M.handleTelegramButtonCallbackQuery(query, undefined, { resolveAction: store.resolve, answerCallbackQuery: async () => {},
      enqueueButtonPrompt: () => { admissions++; },
    });
    assert.equal(admissions, age < 86400000 ? 1 : 0, "Native publication/ACK cannot shorten or renew the original default");
    await M.handleTelegramButtonCallbackQuery(query, undefined, { resolveAction: store.resolve, answerCallbackQuery: async () => {},
      enqueueButtonPrompt: () => assert.fail("A consumed or expired original cannot be revived"),
    });
  } finally { store.clear!(); await store.waitForPublicationIdle!(); }
});

for (const data of ["tgbtn:expired", "tgbtn:capacity", "tgbtn:missing", "tgbtn:consumed"])
test(`Unavailable callback copy does not invent an elapsed deadline (${data})`, async () => {
  let toast: string | undefined;
  const handled = await handleTelegramButtonCallbackQuery({ id: "missing", data }, undefined, { resolveAction: () => undefined,
    answerCallbackQuery: async (_id, text) => { toast = text; }, enqueueButtonPrompt: () => assert.fail("Refusal cannot enqueue"),
  });
  assert.equal(handled, true);
  assert.equal(toast, data === "tgbtn:expired" ? "Button action expired" : data === "tgbtn:capacity" ? "Button removed by the control limit" : "Button action unavailable");
});

test("Ordinary prompt buttons retain the 24-hour default while explicit deadlines still win", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const store = createTelegramButtonActionStore();
  const first = store.register({ text: "First", prompt: "first" });
  const head = store.register({ text: "Head", prompt: "head" });
  const short = store.register({ text: "Short", prompt: "short", expiresAt: 1100 });
  t.mock.timers.tick(61 * 60 * 1000);
  assert.equal(store.resolve(short), undefined);
  const resolved = store.resolve(first);
  assert.ok(resolved, "A prompt is not a one-hour question declaration"); assert.equal(resolved.prompt, "first");
  t.mock.timers.tick(24 * 60 * 60 * 1000 - 61 * 60 * 1000 - 1);
  assert.equal(store.resolve(head)!.prompt, "head");
  const last = store.register({ text: "Last", prompt: "last" });
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(store.resolve(last), undefined); store.clear!();
});

test("Callback retirement diagnostics distinguish finite reasons without logging prompt data", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const events: Array<Record<string, unknown>> = [];
  const store = createTelegramButtonActionStore({ recordRuntimeEvent(_category, _message, details) { events.push(details!); } });
  const key = store.register({ text: "private label", prompt: "private prompt", expiresAt: 1100 });
  t.mock.timers.tick(100); assert.equal(store.resolve(key), undefined);
  assert.equal(events[0]!.reason, "deadline"); assert.equal(events[0]!.count, 1); assert.equal(events[0]!.ageMs, 100);
  for (let i = 0; i < 61; i++) store.register({ text: "private label", prompt: "private prompt" });
  assert.ok(events.some(event => event.reason === "capacity"));
  const picked = store.register({ text: "private label", prompt: "private prompt" }); store.resolve(picked);
  assert.ok(events.some(event => event.reason === "consumed"));
  store.clear!(); assert.ok(events.some(event => event.reason === "clear"));
  assert.doesNotMatch(JSON.stringify(events), /private|tgbtn:/u);
});

for (const rendering of ["rich", "html"] as const) for (const envelope of ["comment", "fence"] as const)
for (const kind of ["confirm", "choice"] as const)
test(`Declarative ${kind} uses ordinary prompt buttons and post-click-only color (${rendering}/${envelope})`, async () => {
  const store = createTelegramButtonActionStore();
  const payload = kind === "confirm" ? { question: "Apply <report>?", id: "report", confirmStyle: "success" } :
    { question: "Which <format>?", id: "format", choices: [[{ label: "🧾 JSON", value: "counter::danger", style: "success" }, { label: "📊 CSV", value: "csv" }]] };
  const body = JSON.stringify(payload), element = `telegram_${kind}`;
  const source = envelope === "comment" ? `Before.<!-- ${element} ${body} -->After.` : `Before.\n\`\`\`${element}\n${body}\n\`\`\`\nAfter.`;
  const plan = planTelegramButtonReply(source, { registerAction: store.register, rendering,
    binding: { app: "must-not-bind", generation: "old", revision: 1 } });
  assert.match(plan.markdown, /\*\*.*&lt;.*&gt;.*\*\*/u);
  assert.doesNotMatch(plan.markdown, /telegram_(confirm|choice)|<tg-button/u);
  const rows = plan.replyMarkup!.inline_keyboard; assert.equal(rows[0]!.length, 2);
  for (const button of rows.flat()) assert.equal(button.style, undefined, "No initial color, even with selected style declared");
  const data = rows[0]![0]!.callback_data!; assert.match(data, /^tgbtn:/u);
  let admissions = 0, feedback = 0;
  const query = { id: "click", data, message: { chat: { id: 7 }, message_id: 11, message_thread_id: 9, reply_markup: plan.replyMarkup } };
  const deps = { resolveAction: store.resolve, answerCallbackQuery: async () => {},
    invokeBoundAction: async () => assert.fail("Selection data entered the bound-method parser"),
    enqueueButtonPrompt: (_query: unknown, action: Parameters<typeof createTelegramButtonPromptTurn>[0]["action"]) => {
      admissions++; assert.equal(action.binding, undefined);
      assert.deepEqual(JSON.parse(action.prompt), { question: payload.question, answer: kind === "confirm" ? "✅ Yes" : "🧾 JSON" });
      assert.doesNotMatch(action.prompt, /telegram_selection|questionId|version|status/u);
      const turn = createTelegramButtonPromptTurn({ chatId: 7, replyToMessageId: 11, queueOrder: 1, action, target: { chatId: 7, threadId: 9 } });
      assert.equal(turn.kind, "prompt"); assert.deepEqual(turn.target, { chatId: 7, threadId: 9 });
      assert.equal(turn.historyText, action.prompt); assert.deepEqual(turn.sourceMessageIds, [11]);
    }, editMessageReplyMarkup: async (_chat: number, _message: number, markup: NonNullable<typeof plan.replyMarkup>) => {
      feedback++; assert.equal(markup.inline_keyboard[0]![0]!.style, "success"); assert.equal(markup.inline_keyboard[0]![1]!.style, undefined);
      assert.ok(markup.inline_keyboard[0]!.every(button => button.disabled && !button.callback_data));
    } };
  assert.equal(await handleTelegramButtonCallbackQuery(query, undefined, deps), true);
  assert.equal(admissions, 1); assert.equal(feedback, 1);
  assert.equal(await handleTelegramButtonCallbackQuery(query, undefined, deps), true);
  assert.equal(admissions, 1, "Duplicate click never creates a second user prompt");
  assert.equal(store.resolve(rows[0]![1]!.callback_data), undefined, "A spent question retires the unchosen branch immediately");
});

for (const kind of ["confirm", "choice"] as const)
for (const outcome of ["accepted", "refused", "unknown-admission", "unknown-edit"] as const)
test(`Structured single-answer groups close before callbacks without restoring spent branches (${kind}/${outcome})`, async () => {
  const store = createTelegramButtonActionStore();
  const declaration = kind === "confirm" ? { question: "Apply?" } : { question: "Format?", choices: ["A", "B"] };
  const plan = planTelegramButtonReply(`<!-- telegram_${kind} ${JSON.stringify(declaration)} --><!-- telegram_button {"label":"Other","prompt":"Other task"} -->`,
    { registerAction: store.register });
  const markup = plan.replyMarkup!, group = markup.inline_keyboard.flat().filter(button => button.text !== "Other");
  const other = markup.inline_keyboard.flat().find(button => button.text === "Other")!;
  let attempts = 0, edits = 0;
  const query = (data: string | undefined) => ({ id: "q", data, message: { chat: { id: 7 }, message_id: 2, reply_markup: markup } });
  const deps = { resolveAction: store.resolve, answerCallbackQuery: async () => {},
    enqueueButtonPrompt: () => {
      attempts++;
      for (const button of group) assert.equal(store.resolve(button.callback_data), undefined, "Consume the entire question before external queue callbacks");
      if (outcome === "unknown-admission") throw new Error("Unknown admission");
      return outcome !== "refused";
    },
    editMessageReplyMarkup: async (_chat: number, _id: number, closed: typeof markup) => {
      edits++;
      assert.ok(closed.inline_keyboard.flat().filter(button => button.text !== "Other").every(button => button.disabled && !button.callback_data));
      assert.equal(closed.inline_keyboard.flat().find(button => button.text === "Other")!.callback_data, other.callback_data);
      if (outcome === "unknown-edit") throw new Error("Unknown edit");
    } };
  const issued = handleTelegramButtonCallbackQuery(query(group[0]!.callback_data), undefined, deps);
  if (outcome === "unknown-admission") await assert.rejects(issued, /Unknown admission/u); else await issued;
  for (const button of group) await handleTelegramButtonCallbackQuery(query(button.callback_data), undefined, deps);
  assert.equal(attempts, 1); assert.equal(edits, 1);
  assert.equal(store.resolve(other.callback_data)!.prompt, "Other task");
});

test("A completed scalar question cannot be republished by a later collector footer revision", async () => {
  const store = createTelegramButtonActionStore();
  let markup = planTelegramButtonReply('<!-- telegram_confirm {"question":"Apply?"} --><!-- telegram_choice {"question":"Set","choices":["X","Y"],"select":2} -->',
    { registerAction: store.register }).replyMarkup!;
  const prompts: unknown[] = [];
  const click = (label: string) => handleTelegramButtonCallbackQuery({ id: "q",
    data: markup.inline_keyboard.flat().find(button => button.text === label)!.callback_data,
    message: { chat: { id: 7 }, message_id: 11, reply_markup: markup } }, undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async () => {},
    enqueueButtonPrompt: (_query, action) => { prompts.push(JSON.parse(action.prompt)); },
    editMessageReplyMarkup: async (_chat, _id, next) => { markup = next; },
    updateSelectionKeyboard: async (_query, next) => { markup = next; },
  });
  await click("✅ Yes"); await click("X");
  assert.ok(markup.inline_keyboard[0]!.every(button => button.disabled && !button.callback_data));
  await click("Y");
  assert.deepEqual(prompts, [{ question: "Apply?", answer: "✅ Yes" }, { question: "Set", answer: ["X", "Y"] }]);
});

for (const kind of ["multiselect", "wizard"] as const)
test(`Terminal collectors retire remaining associations before transport and final queue admission (${kind})`, async () => {
  const store = createTelegramButtonActionStore();
  const declaration = kind === "wizard" ? [{ question: "Q", choices: ["A", "B", "C"] }] :
    { question: "Q", choices: ["A", "B", "C"], select: 2 };
  let markup = planTelegramButtonReply(`<!-- telegram_choice ${JSON.stringify(declaration)} -->`, { registerAction: store.register }).replyMarkup!;
  let terminalKeys: (string | undefined)[] = [], admissions = 0, edits = 0;
  const click = (label: string) => handleTelegramButtonCallbackQuery({ id: "q",
    data: markup.inline_keyboard.flat().find(button => button.text === label)!.callback_data,
    message: { chat: { id: 7 }, message_id: 11, reply_markup: markup } }, undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async () => {},
    updateSelectionKeyboard: async (_query, next) => {
      for (const key of terminalKeys) assert.equal(store.resolve(key), undefined, "The final decision spends its associations before transport callbacks");
      markup = next; edits++;
    },
    enqueueButtonPrompt: () => {
      admissions++;
      for (const key of terminalKeys) assert.equal(store.resolve(key), undefined);
    },
  });
  if (kind === "multiselect") await click("A");
  terminalKeys = markup.inline_keyboard.flat().map(button => button.callback_data);
  await click(kind === "multiselect" ? "B" : "A");
  assert.equal(admissions, 1); assert.equal(edits, kind === "multiselect" ? 2 : 1);
});

test("Light agent payloads preserve human labels without interpreting command/app-like text", async () => {
  const store = createTelegramButtonActionStore(), plan = planTelegramButtonReply(
    '<!-- telegram_choice {"question":"Select","choices":["counter::danger","/quit"]} -->', { registerAction: store.register });
  const data = plan.replyMarkup!.inline_keyboard[0]![0]!.callback_data;
  let prompt = "";
  await handleTelegramButtonCallbackQuery({ id: "click", data, message: { chat: { id: 7 }, message_id: 8 } }, undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async () => {},
    invokeBoundAction: async () => assert.fail("Bare JSON must not enter method parsing"),
    enqueueButtonPrompt: (_query, action) => { prompt = action.prompt; },
  });
  assert.deepEqual(JSON.parse(prompt), { question: "Select", answer: "counter::danger" });
  assert.deepEqual(Object.keys(JSON.parse(prompt)), ["question", "answer"]);
});

test("Confirmation No is ordinary contextual input, not a hidden SDK decision", async () => {
  const store = createTelegramButtonActionStore(), plan = planTelegramButtonReply('<!-- telegram_confirm {"question":"Apply?"} -->', { registerAction: store.register });
  const data = plan.replyMarkup!.inline_keyboard[0]![1]!.callback_data;
  const action = store.resolve(data)!; assert.ok(action);
  assert.deepEqual(JSON.parse(action.prompt), { question: "Apply?", answer: "❌ No" });
});

for (const rendering of ["rich", "html"] as const) for (const envelope of ["comment", "fence"] as const)
test(`Wizard advances single and exact-N steps without model turns, preserving composed content (${rendering}/${envelope})`, async () => {
  const store = createTelegramButtonActionStore(), prompts: unknown[] = [];
  const questions = [
    { question: "First?", choices: ["PDF", "/quit"] },
    { question: "Second <question>?", choices: [["Charts", "Tables"], ["Notes"]], select: 2 },
    { question: "Third?", choices: [[{ label: "", disabled: true }], ["ZIP", "None"]] },
  ];
  const payload = JSON.stringify(questions);
  const declaration = envelope === "comment" ? `<!-- telegram_choice ${payload} -->` : `\`\`\`telegram_choice\n${payload}\n\`\`\``;
  const plan = planTelegramButtonReply('Intro **unchanged**.\n' + declaration +
    '\n<!-- private evidence never displayed -->\nTail.<!-- telegram_button {"label":"Other","prompt":"independent"} -->',
    { registerAction: store.register, rendering });
  let body = plan.markdown, markup = plan.replyMarkup!, messageEdits = 0, keyboardEdits = 0;
  assert.match(body, /First\?/u); assert.doesNotMatch(body, /Second|Third|private evidence|telegram-choice-/u);
  assert.match(body, /1 \/ 3/u);
  const initial = structuredClone(markup);
  const click = async (label: string, data?: string) => handleTelegramButtonCallbackQuery({
    id: "q", data: data ?? markup.inline_keyboard.flat().find(button => button.text === label)!.callback_data,
    message: { chat: { id: 7 }, message_id: 11, message_thread_id: 9, reply_markup: markup },
  }, undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async () => {},
    invokeBoundAction: async () => assert.fail("No app method or intermediate model call"),
    updateSelectionKeyboard: async (_query, next, guard) => { guard(); markup = next; keyboardEdits++; },
    updateSelectionMessage: async (_query, markdown, mode, next, guard) => {
      guard(); assert.equal(mode, rendering); body = markdown; markup = next; messageEdits++; guard();
    },
    enqueueButtonPrompt: (_query, action) => { prompts.push(JSON.parse(action.prompt)); },
  });
  await click("PDF");
  assert.deepEqual(prompts, []); assert.equal(messageEdits, 1);
  assert.match(body, /Second &lt;question&gt;\?/u); assert.doesNotMatch(body, /First\?|Third/u);
  for (const button of initial.inline_keyboard.flat().filter(button => button.text !== "Other")) await click("", button.callback_data);
  assert.equal(messageEdits, 1); assert.deepEqual(prompts, []);
  await click("Tables");
  assert.equal(keyboardEdits, 1); assert.equal(messageEdits, 1); assert.deepEqual(prompts, []);
  await click("Charts");
  assert.equal(messageEdits, 2); assert.deepEqual(prompts, []);
  assert.match(body, /Third\?/u); assert.doesNotMatch(body, /First\?|Second/u); assert.match(body, /3 \/ 3/u);
  assert.match(body, /Intro \*\*unchanged\*\*\./u); assert.match(body, /Tail\./u);
  assert.ok(markup.inline_keyboard.flat().some(button => button.text === "Other" && button.callback_data));
  await click("ZIP");
  assert.deepEqual(prompts, [
    [{ question: "First?", answer: "PDF" }, { question: "Second <question>?", answer: ["Charts", "Tables"] }, { question: "Third?", answer: "ZIP" }],
  ]);
  assert.equal(messageEdits, 2); assert.equal(keyboardEdits, 2);
});

test("A one-question wizard keeps aggregate shape and needs no message-update port", async () => {
  const store = createTelegramButtonActionStore();
  const plan = planTelegramButtonReply('<!-- telegram_choice [{"question":"Only?","choices":["A"]}] -->', { registerAction: store.register });
  let answer: unknown;
  await handleTelegramButtonCallbackQuery({ id: "q", data: plan.replyMarkup!.inline_keyboard[0]![0]!.callback_data,
    message: { chat: { id: 7 }, message_id: 1, reply_markup: plan.replyMarkup } }, undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async () => {}, updateSelectionKeyboard: async () => {},
    enqueueButtonPrompt: (_query, action) => { answer = JSON.parse(action.prompt); },
  });
  assert.deepEqual(answer, [{ question: "Only?", answer: "A" }]);
});

for (const cancelAfterFirst of [false, true])
test(`Wizard cancellation returns answered steps and the current cancel label only (after-first=${cancelAfterFirst})`, async () => {
  const store = createTelegramButtonActionStore(), prompts: unknown[] = [];
  let markup = planTelegramButtonReply('<!-- telegram_choice [{"question":"First","choices":["A"]},{"question":"Second","choices":["X","Y","Z"],"select":2,"cancelLabel":"❌ Отмена"},{"question":"Unseen","choices":["No"]}] -->',
    { registerAction: store.register }).replyMarkup!;
  const click = (label: string) => handleTelegramButtonCallbackQuery({ id: "q",
    data: markup.inline_keyboard.flat().find(button => button.text.startsWith(label))!.callback_data,
    message: { chat: { id: 7 }, message_id: 1, reply_markup: markup } }, undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async () => {},
    updateSelectionKeyboard: async (_query, next) => { markup = next; },
    updateSelectionMessage: async (_query, _markdown, _mode, next) => { markup = next; },
    enqueueButtonPrompt: (_query, action) => { prompts.push(JSON.parse(action.prompt)); },
  });
  if (cancelAfterFirst) { await click("A"); await click("X"); }
  assert.equal(prompts.length, 0);
  await click(cancelAfterFirst ? "❌ Отмена" : "❌ Cancel");
  assert.deepEqual(prompts, [cancelAfterFirst ? [{ question: "First", answer: "A" }, { question: "Second", answer: "❌ Отмена" }] :
    [{ question: "First", answer: "❌ Cancel" }]]);
});

for (const fault of ["missing-port", "unknown-edit", "deadline", "owner-loss"] as const)
test(`Wizard advancement is one guarded attempt without partial answer/replay (${fault})`, async t => {
  t.mock.timers.enable({ apis: ["Date"] }); t.mock.timers.setTime(1000);
  let current = true, captures = 0, edits = 0, prompts = 0;
  const store = createTelegramButtonActionStore({ captureSelectionAuthority() {
    captures++; return () => { if (!current) throw new Error("Owner ended"); };
  } });
  let markup = planTelegramButtonReply('<!-- telegram_choice [{"question":"One","choices":["A","B"],"timeoutMs":100},{"question":"Two","choices":["C"],"timeoutMs":20}] -->',
    { registerAction: store.register }).replyMarkup!;
  const initial = structuredClone(markup);
  const query = (data: string | undefined) => ({ id: "q", data, message: { chat: { id: 7 }, message_id: 11, reply_markup: markup } });
  const deps = { resolveAction: store.resolve, answerCallbackQuery: async () => {}, enqueueButtonPrompt: () => { prompts++; },
    updateSelectionKeyboard: async () => assert.fail("Advancement must atomically update text and keyboard"),
    ...(fault === "missing-port" ? {} : { updateSelectionMessage: async (_query: unknown, _markdown: string, _mode: string, next: typeof markup, guard: () => void) => {
      edits++; markup = next;
      if (fault === "unknown-edit") throw new Error("Unknown text edit");
      if (fault === "deadline") t.mock.timers.setTime(1020);
      if (fault === "owner-loss") current = false;
      guard();
    } }),
  };
  const pending = handleTelegramButtonCallbackQuery(query(initial.inline_keyboard[0]![0]!.callback_data), undefined, deps);
  if (fault === "missing-port") await pending; else await assert.rejects(pending);
  current = true; t.mock.timers.setTime(1001);
  for (const button of [...initial.inline_keyboard.flat(), ...markup.inline_keyboard.flat()])
    await handleTelegramButtonCallbackQuery(query(button.callback_data), undefined, deps);
  assert.equal(prompts, 0);
  assert.equal(edits, fault === "missing-port" ? 0 : 1);
  assert.equal(captures, 1, "Advancement retains the initial owner rather than recapturing it");
});

test("Variable wizard rows compose with an independently collected set in the same footer", async () => {
  const store = createTelegramButtonActionStore(), results: unknown[] = [];
  const wizard = [{ question: "First", choices: ["A"] }, { question: "Next", choices: [["B", "C"], ["D"], [{ label: "Disabled", disabled: true }]] }];
  const set = { question: "Set", choices: ["X", "Y"], select: 2 };
  const plan = planTelegramButtonReply(`<!-- telegram_choice ${JSON.stringify(wizard)} --><!-- telegram_choice ${JSON.stringify(set)} -->`,
    { registerAction: store.register });
  let markup = plan.replyMarkup!, body = plan.markdown;
  const click = (label: string) => handleTelegramButtonCallbackQuery({ id: "q",
    data: markup.inline_keyboard.flat().find(button => button.text === label)!.callback_data,
    message: { chat: { id: 7 }, message_id: 11, reply_markup: markup } }, undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async () => {},
    updateSelectionKeyboard: async (_query, next) => { markup = next; },
    updateSelectionMessage: async (_query, markdown, _rendering, next) => { body = markdown; markup = next; },
    enqueueButtonPrompt: (_query, action) => { results.push(JSON.parse(action.prompt)); },
  });
  await click("X"); await click("A");
  assert.match(body, /Next/u); assert.match(body, /Set/u);
  assert.ok(markup.inline_keyboard.flat().some(button => button.text === "✓ X"));
  await click("Y"); await click("C");
  assert.deepEqual(results, [{ question: "Set", answer: ["X", "Y"] }, [{ question: "First", answer: "A" }, { question: "Next", answer: "C" }]]);
});

test("An unknown wizard edit closes the shared collector footer, not only the clicked group", async () => {
  const store = createTelegramButtonActionStore();
  let markup = planTelegramButtonReply('<!-- telegram_choice [{"question":"One","choices":["A"]},{"question":"Two","choices":["B"]}] --><!-- telegram_choice {"question":"Set","choices":["X","Y"],"select":2} -->',
    { registerAction: store.register }).replyMarkup!;
  let edits = 0, prompts = 0;
  const deps = { resolveAction: store.resolve, answerCallbackQuery: async () => {}, enqueueButtonPrompt: () => { prompts++; },
    updateSelectionKeyboard: async () => { edits++; },
    updateSelectionMessage: async (_query: unknown, _markdown: string, _rendering: string, next: typeof markup) => {
      edits++; markup = next; throw new Error("ACK lost");
    } };
  const click = (data: string | undefined) => handleTelegramButtonCallbackQuery({ id: "q", data,
    message: { chat: { id: 7 }, message_id: 1, reply_markup: markup } }, undefined, deps);
  await assert.rejects(click(markup.inline_keyboard[0]![0]!.callback_data), /ACK lost/u);
  for (const button of markup.inline_keyboard.flat()) await click(button.callback_data);
  assert.equal(edits, 1); assert.equal(prompts, 0);
});

for (const outcome of ["refused", "unknown"] as const)
test(`Wizard final admission is one attempt even if its result is unavailable (${outcome})`, async () => {
  const store = createTelegramButtonActionStore();
  let markup = planTelegramButtonReply('<!-- telegram_choice [{"question":"First","choices":["A"]},{"question":"Last","choices":["B","C"]}] -->',
    { registerAction: store.register }).replyMarkup!;
  let attempts = 0;
  const deps = { resolveAction: store.resolve, answerCallbackQuery: async () => {},
    updateSelectionKeyboard: async (_query: unknown, next: typeof markup) => { markup = next; },
    updateSelectionMessage: async (_query: unknown, _markdown: string, _rendering: string, next: typeof markup) => { markup = next; },
    enqueueButtonPrompt: () => { attempts++; if (outcome === "unknown") throw new Error("Admission unknown"); return false; } };
  const click = (data: string | undefined) => handleTelegramButtonCallbackQuery({ id: "q", data,
    message: { chat: { id: 7 }, message_id: 1, reply_markup: markup } }, undefined, deps);
  await click(markup.inline_keyboard[0]![0]!.callback_data);
  const beforeFinal = structuredClone(markup);
  const last = click(markup.inline_keyboard[0]![0]!.callback_data);
  if (outcome === "unknown") await assert.rejects(last, /Admission unknown/u); else await last;
  for (const button of beforeFinal.inline_keyboard.flat()) await click(button.callback_data);
  assert.equal(attempts, 1);
});

for (const rendering of ["rich", "html"] as const)
test(`Wizard bounds the longest future question before real action registration (${rendering})`, () => {
  const source = "x".repeat(rendering === "rich" ? 31800 : 3800) +
    '\n<!-- telegram_choice ' + JSON.stringify([{ question: "Short", choices: ["A"] }, { question: "Q".repeat(1024), choices: ["B"] }]) + ' -->';
  const plan = planTelegramButtonReply(source, { rendering, registerAction: () => assert.fail("No partial controls for an uneditable wizard") });
  assert.equal(plan.replyMarkup, undefined);
  assert.match(plan.markdown, /must fit one message/u);
});

for (const rendering of ["rich", "html"] as const) for (const envelope of ["comment", "fence"] as const)
test(`Exact-N selection toggles locally, preserves siblings and admits only the final label set (${rendering}/${envelope})`, async () => {
  const store = createTelegramButtonActionStore(), prompts: string[] = [];
  const payload = JSON.stringify({ question: "Pick two", select: 2, choices: [["A", { label: "B", style: "success", value: "/quit" }], [{ label: "Off", disabled: true }, "C"]] });
  const source = envelope === "comment" ? `<!-- telegram_choice ${payload} -->` : `\`\`\`telegram_choice\n${payload}\n\`\`\``;
  const plan = planTelegramButtonReply(source + '\n<!-- telegram_button {"label":"Other","prompt":"independent"} -->', { registerAction: store.register, rendering });
  let markup = plan.replyMarkup!;
  const first = markup.inline_keyboard.flat().find(button => button.text === "A")!.callback_data!;
  const stale = markup.inline_keyboard.flat().find(button => button.text === "B")!.callback_data!;
  const other = markup.inline_keyboard.flat().find(button => button.text === "Other")!.callback_data!;
  assert.ok(markup.inline_keyboard.flat().every(button => !button.style));
  const click = async (label: string, data?: string) => {
    const callbackData = data ?? markup.inline_keyboard.flat().find(button => button.text === label)!.callback_data;
    await handleTelegramButtonCallbackQuery({ id: "click", data: callbackData,
      message: { chat: { id: 7 }, message_id: 12, message_thread_id: 9, reply_markup: markup } }, undefined, {
      resolveAction: store.resolve, answerCallbackQuery: async () => {},
      invokeBoundAction: async () => assert.fail("A collector is not an app method"),
      updateSelectionKeyboard: async (_query, next, assertCurrent) => { assertCurrent(); markup = next; assertCurrent(); },
      enqueueButtonPrompt: (_query, action) => { prompts.push(action.prompt); },
    });
  };
  await click("B");
  assert.deepEqual(prompts, []);
  assert.equal(markup.inline_keyboard.flat().find(button => button.text === "✓ B")!.style, "success");
  assert.ok(markup.inline_keyboard.flat().some(button => /1\/2$/u.test(button.text)));
  assert.equal(store.resolve(first), undefined, "All old sibling keys are retired in the same owner");
  await click("", stale);
  assert.deepEqual(prompts, []);
  await click("✓ B");
  assert.equal(markup.inline_keyboard.flat().find(button => button.text === "B")!.style, undefined);
  assert.ok(markup.inline_keyboard.flat().some(button => /0\/2$/u.test(button.text)));
  await click("C");
  await click("A");
  assert.deepEqual(prompts.map(prompt => JSON.parse(prompt)), [{ question: "Pick two", answer: ["A", "C"] }]);
  assert.ok(markup.inline_keyboard.flat().filter(button => button.text !== "Other").every(button => button.disabled));
  assert.equal(markup.inline_keyboard.flat().find(button => button.text === "Other")!.callback_data, other);
  assert.equal(store.resolve(other)!.prompt, "independent");
});

for (const fault of ["no-port", "unknown-edit", "late-deadline", "partial-keyboard", "duplicate-keyboard"] as const)
test(`Multiselect refuses missing/uncertain publication without an answer or replay (${fault})`, async t => {
  t.mock.timers.enable({ apis: ["Date"] }); t.mock.timers.setTime(1000);
  const store = createTelegramButtonActionStore();
  const plan = planTelegramButtonReply('<!-- telegram_choice {"question":"Pick two","choices":["A","B","C"],"select":2,"timeoutMs":10} -->', { registerAction: store.register });
  let markup = plan.replyMarkup!, prompts = 0, edits = 0;
  const original = structuredClone(markup), first = markup.inline_keyboard[0]![0]!.callback_data!;
  if (fault === "partial-keyboard") markup.inline_keyboard.pop();
  if (fault === "duplicate-keyboard") markup.inline_keyboard.push([...markup.inline_keyboard[0]!]);
  const query = { id: "x", data: first, message: { chat: { id: 7 }, message_id: 12, reply_markup: markup } };
  const deps = {
    resolveAction: store.resolve, answerCallbackQuery: async () => {},
    enqueueButtonPrompt: () => { prompts++; },
    ...(fault === "no-port" ? {} : { updateSelectionKeyboard: async (_query: unknown, next: typeof markup, assertCurrent: () => void) => {
      edits++; markup = next;
      if (fault === "unknown-edit") throw new Error("Unknown API outcome");
      if (fault === "late-deadline") t.mock.timers.setTime(1010);
      assertCurrent();
    } }),
  };
  if (fault === "unknown-edit" || fault === "late-deadline")
    await assert.rejects(handleTelegramButtonCallbackQuery(query, undefined, deps));
  else await handleTelegramButtonCallbackQuery(query, undefined, deps);
  assert.equal(prompts, 0);
  assert.equal(edits, fault === "unknown-edit" || fault === "late-deadline" ? 1 : 0);
  for (const button of [...original.inline_keyboard.flat(), ...markup.inline_keyboard.flat()]) {
    await handleTelegramButtonCallbackQuery({ ...query, data: button.callback_data }, undefined, deps);
  }
  assert.equal(prompts, 0, "No lost edit can renew the collector or synthesize a partial answer");
});

function questionDeadlineHarness(kind: "confirm" | "choice" | "set" | "wizard", ttlMs = 24 * 3_600_000) {
  const reasons: unknown[] = [], records = new Map<string, TelegramOutboundButtonAction>();
  const store = createTelegramButtonActionStore({ ttlMs, recordRuntimeEvent: (_category, _message, details) => { reasons.push(details?.reason); } });
  const value = kind === "confirm" ? { question: "Q", timeoutMs: 1000 } : kind === "wizard" ?
    [{ question: "First", choices: ["A"], timeoutMs: 1000 }, { question: "Last", choices: ["B"], timeoutMs: 1000 }] :
    { question: "Q", choices: ["A", "B", "C"], timeoutMs: 1000, ...(kind === "set" ? { select: 2 } : {}) };
  const plan = planTelegramButtonReply(`<!-- ${kind === "confirm" ? "telegram_confirm" : "telegram_choice"} ${JSON.stringify(value)} -->`, {
    registerAction(action) { const key = store.register(action); records.set(key, action); return key; },
  });
  const first = [...records.values()][0]!, deadline = first.completionGroup?.deadline; assert.ok(deadline);
  return { store, plan, records, deadline, reasons };
}

for (const kind of ["confirm", "choice", "set", "wizard"] as const)
test(`Question deadline is one monotone owner and rearms the existing timer (${kind})`, t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const { store, plan, deadline, reasons, records } = questionDeadlineHarness(kind, 100);
  try {
    assert.ok(Object.isFrozen(deadline)); assert.equal(deadline.expiresAt, 1100, "Original store TTL clips the declaration for every reader");
    assert.equal([...records.values()][0]!.expiresAt, 2000, "Declaration snapshots are not a second effective lifetime owner");
    assert.throws(() => { (deadline as { expiresAt: number }).expiresAt = 9999; }, TypeError);
    deadline.shorten(1050); deadline.shorten(1060); deadline.shorten(Infinity); deadline.shorten(NaN);
    assert.equal(deadline.expiresAt, 1050);
    t.mock.timers.tick(49); assert.equal(reasons.includes("deadline"), false);
    t.mock.timers.tick(1); assert.equal(reasons.includes("deadline"), true, "Shortening must rearm, not wait for the original timer");
    assert.equal(store.resolve(plan.replyMarkup!.inline_keyboard[0]![0]!.callback_data), undefined);
  } finally { store.clear!(); }
});

for (const phase of ["partial", "terminal", "wizard-step", "wizard-terminal"] as const)
test(`Question deadline reaches original prepared collectors without store/timer fallback (${phase})`, t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const { store, plan, deadline, records } = questionDeadlineHarness(phase.startsWith("wizard") ? "wizard" : "set");
  let markup = plan.replyMarkup!;
  const prepare = (label: string) => {
    const key = markup.inline_keyboard.flat().find(button => button.text === label)!.callback_data!;
    const raw = records.get(key)!; assert.ok(raw.selection);
    const update = raw.selection.prepare({ id: "q", data: key, message: { chat: { id: 7 }, message_id: 12, reply_markup: markup } });
    assert.ok(update); return update;
  };
  try {
    if (phase === "terminal" || phase === "wizard-terminal") { const first = prepare("A"); first.commit(); markup = first.replyMarkup; }
    const update = prepare(phase === "terminal" || phase === "wizard-terminal" ? "B" : "A");
    deadline.shorten(1010); t.mock.timers.setTime(1010);
    assert.throws(update.assertCurrent, /unavailable/u); assert.throws(update.commit, /unavailable/u);
  } finally { store.clear!(); }
});

for (const kind of ["set", "wizard"] as const)
test(`Question deadline rejects a raw late collector before an expiry callback (${kind})`, t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const { store, plan, deadline, records } = questionDeadlineHarness(kind);
  try {
    const key = plan.replyMarkup!.inline_keyboard[0]![0]!.callback_data!, raw = records.get(key)!; assert.ok(raw.selection);
    deadline.shorten(1010); t.mock.timers.setTime(1010);
    let result: unknown;
    assert.doesNotThrow(() => { result = raw.selection!.prepare({ id: "q", data: key, message: { chat: { id: 7 }, message_id: 12, reply_markup: plan.replyMarkup } }); });
    assert.equal(result, undefined);
  } finally { store.clear!(); }
});

test("Question deadline regenerated rows retain the same owner and can shorten again", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const { store, plan, deadline, records } = questionDeadlineHarness("wizard"); let markup = plan.replyMarkup!;
  try {
    deadline.shorten(1100); t.mock.timers.setTime(1050);
    const first = markup.inline_keyboard[0]![0]!.callback_data!;
    await handleTelegramButtonCallbackQuery({ id: "q", data: first, message: { chat: { id: 7 }, message_id: 12, reply_markup: markup } }, undefined, {
      resolveAction: store.resolve, answerCallbackQuery: async () => {}, enqueueButtonPrompt: () => assert.fail("Only one step"),
      updateSelectionKeyboard: async (_query, next, assertCurrent) => { assertCurrent(); markup = next; },
      updateSelectionMessage: async (_query, _markdown, _rendering, next, assertCurrent) => { assertCurrent(); markup = next; },
    });
    const next = markup.inline_keyboard[0]![0]!.callback_data!; assert.notEqual(next, first);
    const raw = records.get(next)!; assert.equal(raw.completionGroup?.deadline, deadline); assert.equal(raw.expiresAt, 1100);
    deadline.shorten(1075); t.mock.timers.setTime(1075);
    assert.equal(raw.selection!.prepare({ id: "q", data: next, message: { chat: { id: 7 }, message_id: 12, reply_markup: markup } }), undefined);
    assert.equal(store.resolve(next), undefined);
  } finally { store.clear!(); }
});

for (const kind of ["confirm", "set", "wizard"] as const)
test(`Question deadline refuses another store without spending original questions or capacity (${kind})`, t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const { store, plan, deadline, records } = questionDeadlineHarness(kind), foreign = createTelegramButtonActionStore();
  try {
    const key = plan.replyMarkup!.inline_keyboard[0]![0]!.callback_data!, original = records.get(key)!;
    assert.throws(() => deadline.bindStore(() => {}), /already has an owner/u);
    const retained = Array.from({ length: 60 }, (_, i) => foreign.register({ text: String(i), prompt: String(i) }));
    assert.throws(() => foreign.register(original), /already has an owner/u);
    assert.equal(foreign.resolve(retained[0])?.prompt, "0", "Refused ownership cannot spend an unrelated capacity slot");
    assert.equal(deadline.expiresAt, 2000);
    const active = store.resolve(key); assert.ok(active, "Refused adoption cannot retire the original question");
    if (active.selection) assert.ok(active.selection.prepare({ id: "q", data: key, message: { chat: { id: 7 }, message_id: 12, reply_markup: plan.replyMarkup } }));
  } finally { store.clear!(); foreign.clear!(); }
});

for (const phase of ["partial", "terminal", "wizard-step", "wizard-terminal"] as const)
test(`Agent selection store deadline fences in-flight publication before timer dispatch (${phase})`, async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const store = createTelegramButtonActionStore({ ttlMs: 10 });
  const wizard = phase.startsWith("wizard"), declaration = wizard ?
    [{ question: "First", choices: ["A"] }, { question: "Last", choices: ["B"] }] :
    { question: "Set", choices: ["A", "B", "C"], select: 2 };
  let markup = planTelegramButtonReply(`<!-- telegram_choice ${JSON.stringify(declaration)} -->`, { registerAction: store.register }).replyMarkup!;
  let late = phase === "partial" || phase === "wizard-step", prompts = 0;
  const edit = async (next: typeof markup, assertCurrent: () => void) => {
    if (late) t.mock.timers.setTime(1010);
    assertCurrent(); markup = next;
  };
  const click = (label: string) => handleTelegramButtonCallbackQuery({ id: "q", data: markup.inline_keyboard.flat().find(button => button.text === label)!.callback_data,
    message: { chat: { id: 7 }, message_id: 12, reply_markup: markup } }, undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async () => {}, enqueueButtonPrompt: () => { prompts++; },
    updateSelectionKeyboard: async (_query, next, assertCurrent) => edit(next, assertCurrent),
    updateSelectionMessage: async (_query, _markdown, _rendering, next, assertCurrent) => edit(next, assertCurrent),
  });
  try {
    if (!late) { await click("A"); late = true; }
    await assert.rejects(click(phase === "partial" || phase === "wizard-step" ? "A" : "B"), /unavailable/u);
    assert.equal(prompts, 0, "Store expiry is a real cutoff even when the original declaration lives longer");
  } finally { store.clear!(); }
});

test("Agent selection revisions retain their original store lifetime before timer dispatch", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const store = createTelegramButtonActionStore({ ttlMs: 10 });
  let markup = planTelegramButtonReply('<!-- telegram_choice [{"question":"One","choices":["A"]},{"question":"Two","choices":["B"]}] -->', { registerAction: store.register }).replyMarkup!;
  try {
    t.mock.timers.setTime(1005);
    await handleTelegramButtonCallbackQuery({ id: "q", data: markup.inline_keyboard[0]![0]!.callback_data,
      message: { chat: { id: 7 }, message_id: 12, reply_markup: markup } }, undefined, {
      resolveAction: store.resolve, answerCallbackQuery: async () => {}, enqueueButtonPrompt: () => assert.fail("Advancement is not a final answer"),
      updateSelectionKeyboard: async (_query, next, assertCurrent) => { assertCurrent(); markup = next; },
      updateSelectionMessage: async (_query, _markdown, _rendering, next, assertCurrent) => { assertCurrent(); markup = next; },
    });
    const key = markup.inline_keyboard[0]![0]!.callback_data!;
    const peer = markup.inline_keyboard.at(-1)![0]!.callback_data!; assert.notEqual(peer, key);
    t.mock.timers.setTime(1009); assert.ok(store.resolve(peer));
    t.mock.timers.setTime(1010); assert.equal(store.resolve(key), undefined, "Rendering the next step cannot renew the original group's TTL");
  } finally { store.clear!(); }
});

test("Agent selection original store lifetime drives timer retirement after a revision", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const reasons: unknown[] = [], store = createTelegramButtonActionStore({ ttlMs: 10,
    recordRuntimeEvent: (_category, _message, details) => { reasons.push(details?.reason); } });
  let markup = planTelegramButtonReply('<!-- telegram_choice [{"question":"One","choices":["A"]},{"question":"Two","choices":["B"]}] -->', { registerAction: store.register }).replyMarkup!;
  try {
    t.mock.timers.tick(5);
    await handleTelegramButtonCallbackQuery({ id: "q", data: markup.inline_keyboard[0]![0]!.callback_data,
      message: { chat: { id: 7 }, message_id: 12, reply_markup: markup } }, undefined, {
      resolveAction: store.resolve, answerCallbackQuery: async () => {}, enqueueButtonPrompt: () => assert.fail("Only a step"),
      updateSelectionKeyboard: async (_query, next, assertCurrent) => { assertCurrent(); markup = next; },
      updateSelectionMessage: async (_query, _markdown, _rendering, next, assertCurrent) => { assertCurrent(); markup = next; },
    });
    t.mock.timers.tick(4); assert.equal(reasons.includes("deadline"), false);
    t.mock.timers.tick(1); assert.equal(reasons.includes("deadline"), true);
    assert.equal(store.resolve(markup.inline_keyboard[0]![0]!.callback_data), undefined);
  } finally { store.clear!(); }
});

test("Agent selection observed store expiry stays spent after logical retirement and clock restoration", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const store = createTelegramButtonActionStore({ ttlMs: 10 });
  let markup = planTelegramButtonReply('<!-- telegram_choice {"question":"Set","choices":["A","B"],"select":2} -->', { registerAction: store.register }).replyMarkup!;
  const prepare = (label: string) => {
    const data = markup.inline_keyboard.flat().find(button => button.text === label)!.callback_data!;
    const query = { id: "q", data, message: { chat: { id: 7 }, message_id: 12, reply_markup: markup } };
    const action = store.resolve(data, query); assert.ok(action?.selection);
    const update = action.selection.prepare(query); assert.ok(update); return update;
  };
  try {
    const first = prepare("A"); first.commit(); markup = first.replyMarkup;
    const final = prepare("B"); assert.ok(final.prompt);
    t.mock.timers.setTime(1010); assert.throws(final.assertCurrent, /unavailable/u);
    t.mock.timers.setTime(1000); assert.throws(final.assertCurrent, /unavailable/u);
    assert.throws(final.commit, /unavailable/u);
  } finally { store.clear!(); }
});

test("Pending selection edit fences concurrent stale clicks and uses the original message target", async () => {
  const store = createTelegramButtonActionStore(), ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const plan = planTelegramButtonReply('<!-- telegram_choice {"question":"Two","choices":["A","B","C"],"select":2} -->', { registerAction: store.register });
  let markup = plan.replyMarkup!, edits = 0, prompts = 0;
  const initial = markup;
  const query = (data: string | undefined, chatId = 7) => ({ id: "q", data, message: { chat: { id: chatId }, message_id: 22, message_thread_id: 9, reply_markup: markup } });
  const deps = {
    resolveAction: store.resolve, answerCallbackQuery: async () => {}, enqueueButtonPrompt: () => { prompts++; },
    updateSelectionKeyboard: async (_query: unknown, next: typeof markup, assertCurrent: () => void) => {
      edits++; if (edits === 1) { ready.resolve(); await release.promise; }
      assertCurrent(); markup = next;
    },
  };
  const first = handleTelegramButtonCallbackQuery(query(initial.inline_keyboard[0]![0]!.callback_data), undefined, deps);
  await ready.promise;
  await handleTelegramButtonCallbackQuery(query(initial.inline_keyboard[1]![0]!.callback_data), undefined, deps);
  assert.equal(edits, 1); assert.equal(prompts, 0);
  release.resolve(); await first;
  const wrongTarget = markup.inline_keyboard[1]![0]!.callback_data;
  await handleTelegramButtonCallbackQuery(query(wrongTarget, 8), undefined, deps);
  assert.equal(edits, 1); assert.equal(prompts, 0);
  await handleTelegramButtonCallbackQuery(query(markup.inline_keyboard[2]![0]!.callback_data), undefined, deps);
  assert.equal(prompts, 1); assert.equal(edits, 2);
});

for (const disposition of ["cancel", "refused-queue", "throwing-queue"] as const)
test(`Multiselect completion is consumed before queue callbacks, without partial/duplicate prompts (${disposition})`, async () => {
  const store = createTelegramButtonActionStore();
  let markup = planTelegramButtonReply('<!-- telegram_choice {"question":"Two","choices":["A","B","C"],"select":2} -->', { registerAction: store.register }).replyMarkup!;
  let attempts = 0; const answers: unknown[] = [];
  const query = (data: string | undefined) => ({ id: "q", data, message: { chat: { id: 7 }, message_id: 2, reply_markup: markup } });
  const deps = { resolveAction: store.resolve, answerCallbackQuery: async () => {},
    updateSelectionKeyboard: async (_query: unknown, next: typeof markup) => { markup = next; },
    enqueueButtonPrompt: (_query: unknown, action: { prompt: string }) => {
      attempts++; answers.push(JSON.parse(action.prompt));
      if (disposition === "throwing-queue") throw new Error("Unknown admission");
      return false;
    } };
  const initial = structuredClone(markup);
  if (disposition === "cancel")
    await handleTelegramButtonCallbackQuery(query(markup.inline_keyboard.at(-1)![0]!.callback_data), undefined, deps);
  else {
    await handleTelegramButtonCallbackQuery(query(markup.inline_keyboard[0]![0]!.callback_data), undefined, deps);
    const pending = handleTelegramButtonCallbackQuery(query(markup.inline_keyboard[1]![0]!.callback_data), undefined, deps);
    if (disposition === "throwing-queue") await assert.rejects(pending, /Unknown admission/u); else await pending;
  }
  for (const button of initial.inline_keyboard.flat()) await handleTelegramButtonCallbackQuery(query(button.callback_data), undefined, deps);
  assert.equal(attempts, 1);
  assert.deepEqual(answers, [{ question: "Two", answer: disposition === "cancel" ? "❌ Cancel" : ["A", "B"] }]);
});

test("Independent collectors share a bounded footer revision without overwriting each other", async () => {
  const store = createTelegramButtonActionStore(), ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const question = (name: string) => `<!-- telegram_choice ${JSON.stringify({ question: name, choices: [name + "A", name + "B"], select: 2 })} -->`;
  let markup = planTelegramButtonReply(question("One") + question("Two"), { registerAction: store.register }).replyMarkup!;
  let edits = 0; const prompts: unknown[] = [];
  const click = async (label: string, data?: string) => handleTelegramButtonCallbackQuery({ id: "x",
    data: data ?? markup.inline_keyboard.flat().find(button => button.text === label)!.callback_data,
    message: { chat: { id: 7 }, message_id: 12, reply_markup: markup } }, undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async () => {}, enqueueButtonPrompt: (_query, action) => { prompts.push(JSON.parse(action.prompt)); },
    updateSelectionKeyboard: async (_query, next, assertCurrent) => {
      edits++; if (edits === 1) { ready.resolve(); await release.promise; }
      assertCurrent(); markup = next;
    },
  });
  const staleTwo = markup.inline_keyboard.flat().find(button => button.text === "TwoA")!.callback_data;
  const first = click("OneA"); await ready.promise;
  await click("", staleTwo); assert.equal(edits, 1);
  release.resolve(); await first;
  await click("TwoA");
  assert.ok(markup.inline_keyboard.flat().some(button => button.text === "✓ OneA"));
  assert.ok(markup.inline_keyboard.flat().some(button => button.text === "✓ TwoA"));
  await click("OneB"); await click("TwoB");
  assert.deepEqual(prompts, [{ question: "One", answer: ["OneA", "OneB"] }, { question: "Two", answer: ["TwoA", "TwoB"] }]);
});

for (const loss of ["before-click", "during-edit"] as const)
test(`Selection publication captures one sticky owner across revisions and async edits (${loss})`, async () => {
  let current = true, captures = 0, prompts = 0, edits = 0;
  const store = createTelegramButtonActionStore({ captureSelectionAuthority() {
    captures++; return () => { if (!current) throw new Error("Owner lost"); };
  } });
  let markup = planTelegramButtonReply('<!-- telegram_choice {"question":"Two","choices":["A","B","C"],"select":2} -->', { registerAction: store.register }).replyMarkup!;
  const query = (data: string | undefined) => ({ id: "q", data, message: { chat: { id: 7 }, message_id: 2, reply_markup: markup } });
  const deps = { resolveAction: store.resolve, answerCallbackQuery: async () => {}, enqueueButtonPrompt: () => { prompts++; },
    updateSelectionKeyboard: async (_query: unknown, next: typeof markup, assertCurrent: () => void) => {
      edits++; markup = next; current = false; assertCurrent();
    } };
  if (loss === "before-click") current = false;
  const pending = handleTelegramButtonCallbackQuery(query(markup.inline_keyboard[0]![0]!.callback_data), undefined, deps);
  if (loss === "during-edit") await assert.rejects(pending, /Owner lost/u); else await pending;
  current = true;
  for (const button of markup.inline_keyboard.flat()) await handleTelegramButtonCallbackQuery(query(button.callback_data), undefined, deps);
  assert.equal(captures, 1, "A new revision must not borrow replacement session or transport authority");
  assert.equal(prompts, 0);
  assert.equal(edits, loss === "before-click" ? 0 : 1);
});

test("Selection budget preflight uses the same comment removal as final fence rendering", () => {
  const choices = Array.from({ length: 33 }, (_, index) => `Option ${index}`);
  const block = `\`\`\`telegram_choice\n${JSON.stringify({ question: "Q", choices })}\n\`\`\`<!-- telegram_button {"label":"Other","prompt":"separate"} -->\n`;
  let selections = 0;
  planTelegramButtonReply(block.repeat(2), { registerAction: action => {
    if (action.promptKind === "selection") selections++;
    return "tgbtn:test";
  } });
  assert.equal(selections, 0, "Comment extraction cannot bypass whole-answer selection capacity");
});

test("Declaration deadlines use existing button storage without renewal or an extra timer", t => {
  t.mock.timers.enable({ apis: ["Date"] }); t.mock.timers.setTime(1000);
  const store = createTelegramButtonActionStore();
  const plan = planTelegramButtonReply('<!-- telegram_confirm {"question":"Apply?","timeoutMs":20} -->', { registerAction: store.register });
  t.mock.timers.setTime(1020);
  assert.equal(store.resolve(plan.replyMarkup!.inline_keyboard[0]![0]!.callback_data), undefined);
});

test("Recognized invalid, incomplete and over-budget declarations register no partial controls", () => {
  const valid = '<!-- telegram_confirm {"question":"Apply?"} -->';
  const oversized = `<!-- telegram_choice ${JSON.stringify([1, 2].map(index => ({ question: `Q${index}`, choices: Array.from({ length: 33 }, (_, value) => ({ label: `${value}` })) })))} -->`;
  for (const source of [valid.repeat(17), oversized, '```telegram_choice\n{"question":"Partial"}',
    '<!-- telegram_choice [{"question":"OK","choices":{"label":"A"}},{"question":"Broken","choices":[]}] -->',
    '<!-- telegram_choice {"question":"Q","choices":{"label":"A"},"handler":"execute"} -->']) {
    const plan = planTelegramButtonReply(source, { registerAction: () => assert.fail("Invalid declaration published a callback") });
    assert.equal(plan.replyMarkup, undefined);
  }
  const independent = planTelegramButtonReply('<!-- telegram_choice {} -->' + valid, { registerAction: () => "tgbtn:valid" });
  assert.equal(independent.replyMarkup!.inline_keyboard[0]!.length, 2);
});

test("Declaration names are exact, enclosing code is literal, decoded strings are never rescanned", () => {
  const literal = '````markdown\n```telegram_confirm\n{"question":"Example"}\n```\n````';
  assert.equal(planTelegramButtonReply(literal, { registerAction: () => assert.fail("Literal example activated") }).markdown, literal);
  assert.equal(planTelegramButtonReply('<!-- telegram_confirmation {"question":"Wrong name"} -->', { registerAction: () => assert.fail("Suffix activated") }).replyMarkup, undefined);
  const plan = planTelegramButtonReply('<!-- telegram_choice {"question":"\\u003c!-- telegram_button --\\u003e","choices":{"label":"Literal","value":"/quit"}} -->', { registerAction: action => {
    assert.deepEqual(JSON.parse(action.prompt), { question: "<!-- telegram_button -->", answer: "Literal" }); return "tgbtn:literal";
  } });
  assert.doesNotMatch(plan.markdown, /<!--/u); assert.match(plan.markdown, /&lt;!--/u);
});

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
    answerCallbackQuery: async (_id, text) => { assert.equal(text, "Queued"); },
    enqueueButtonPrompt: (query, action) => {
      assert.equal(query.message?.message_thread_id, 9);
      assert.equal(action.prompt, "Explain this section.");
      queued = true;
    },
  });
  assert.equal(queued, true);
});

test("Fenced top-level button sequences are vertical aliases for explicit matrices", () => {
  const sources = [
    '{First|one}\n{Second|two}',
    '{"label":"First","prompt":"one"}\n{"label":"Second","prompt":"two"}',
    '[{First|one}{Second|two}]',
  ];
  for (const source of sources) {
    const actions: unknown[] = [];
    const plan = planTelegramButtonReply(`\`\`\`telegram_button\n${source}\n\`\`\``, {
      registerAction: (action) => {
        actions.push(action);
        return `tgbtn:${actions.length}`;
      },
    });
    assert.deepEqual(actions, [
      { text: "First", prompt: "one" },
      { text: "Second", prompt: "two" },
    ]);
    assert.equal((plan.markdown.match(/<tg-button-row>/g) ?? []).length, 2);
  }
  const horizontal = planTelegramButtonReply(
    '```telegram_button\n[[{First|one}{Second|two}]]\n```',
    { registerAction: () => "tgbtn:test" },
  );
  assert.equal((horizontal.markdown.match(/<tg-button-row>/g) ?? []).length, 1);
  assert.equal((horizontal.markdown.match(/<tg-button /g) ?? []).length, 2);
  for (const source of [
    '{Valid|one}\n{"label":"Broken","prompt":}',
    '{Valid|one}\n{Broken|}',
    '[{Valid|one}]\n[{Broken|}]',
    '[{Valid|one}]\n[]',
    '[{Valid|one}]\n[{"label":"Broken","prompt":}]',
    '[{Valid|one}]\n[{Valid|two}] trailing',
    '{Valid|one} trailing',
  ]) {
    const plan = planTelegramButtonReply(`\`\`\`telegram_button\n${source}\n\`\`\``, {
      registerAction: () => assert.fail("Malformed sequence registered callbacks"),
    });
    assert.equal(plan.markdown, "");
    assert.equal(plan.replyMarkup, undefined);
  }
});

test("Adjacent top-level button groups normalize to one matrix without changing rows or actions", () => {
  const vertical = '[{First|one}{Second|two}]';
  const cases = [
    ['[{First|one}]\n[{Second|two}]', vertical],
    ['[{First|one}], [{Second|two}]', vertical],
    ['{First|one}\n[{Second|two}]', vertical],
    ['[{"label":"First","prompt":"one"}]\n{Second|two}', vertical],
    ['[[{First|one}{Second|two}]]\n[{Third|three}]', '[[{First|one}{Second|two}]{Third|three}]'],
    ['[{First|one}]\n[{Unavailable|||1}]', '[{First|one}{Unavailable|||1}]'],
  ];
  for (const rendering of ["rich", "html"] as const) {
    for (const wrapper of ["fence", "comment"] as const) {
      const plan = (payload: string) => {
        const actions: unknown[] = [];
        const markdown = wrapper === "fence"
          ? `\`\`\`telegram_button\n${payload}\n\`\`\``
          : `<!-- telegram_button ${payload} -->`;
        const reply = planTelegramButtonReply(markdown, {
          rendering,
          registerAction: (action) => {
            actions.push(action);
            return `tgbtn:${actions.length}`;
          },
        });
        return { ...reply, actions };
      };
      for (const [source, canonical] of cases) {
        assert.deepEqual(plan(source!), plan(canonical!), `${rendering}/${wrapper}: ${source}`);
      }
    }
  }
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

test("Fenced button delimiters tolerate horizontal whitespace, marker type and length", () => {
  for (const rendering of ["rich", "html"] as const) {
    for (const payload of ['{Run|Do it.}', '{"label":"Run","prompt":"Do it."}']) {
      const plan = (markdown: string) => planTelegramButtonReply(markdown, {
        rendering,
        registerAction: (action) => {
          assert.deepEqual(action, { text: "Run", prompt: "Do it." });
          return "tgbtn:test";
        },
      });
      const canonical = plan(`Before\n\`\`\`telegram_button\n${payload}\n\`\`\`\nAfter`);
      for (const marker of ["`", "~"]) {
        for (const length of [3, 5]) {
          for (const indent of ["", "    ", " \t"]) {
            for (const gap of ["", " \t"]) {
              for (const newline of ["\n", "\r\n"]) {
                const source = ["Before", `${indent}${marker.repeat(length)}${gap}telegram_button \t`,
                  `${indent}${payload}`, `\t${marker.repeat(length + 1)} \t`, "After"].join(newline);
                const actual = plan(source);
                assert.deepEqual({ ...actual, markdown: actual.markdown.replace(/\r\n/g, "\n") }, canonical, source);
              }
            }
          }
        }
      }
    }
  }
});

test("Fenced button closure must match the opening marker and minimum length", () => {
  for (const [opening, closing] of [
    ["```` telegram_button", "```"],
    ["~~~ telegram_button", "```"],
    ["``` telegram_button", "~~~"],
    ["~~~~ telegram_button", "~~~"],
    ["``` telegram_button", "``` trailing"],
    ["``` telegram_button", "Text ```"],
  ]) {
    const plan = planTelegramButtonReply(`${opening}\n{Run|Do it.}\n${closing}`, {
      registerAction: () => assert.fail("Mismatched closing delimiter registered a callback"),
    });
    assert.equal(plan.markdown, "");
    assert.equal(plan.replyMarkup, undefined);
  }
  for (const marker of ["`", "~"]) {
    const plan = planTelegramButtonReply(`  ${marker.repeat(4)} telegram_button\n[{Valid|one}{Broken|}]\n${marker.repeat(5)}`, {
      registerAction: () => assert.fail("Relaxed wrapper bypassed payload validation"),
    });
    assert.equal(plan.markdown, "");
    assert.equal(plan.replyMarkup, undefined);
  }
});

test("Indented outer fences protect examples and parsing resumes after their closure", () => {
  for (const marker of ["`", "~"]) {
    for (const indent of [" ", "    ", "\t"]) {
      const example = `${indent}${marker.repeat(4)} markdown\n  ~~~ telegram_button\n{Example|Do not queue.}\n  ~~~\n${indent}${marker.repeat(4)}`;
      const actions: unknown[] = [];
      const plan = planTelegramButtonReply(`${example}\n\n\t\`\`\`\` telegram_button\n{Run|Do it.}\n\`\`\`\``, {
        registerAction: (action) => { actions.push(action); return "tgbtn:test"; },
      });
      assert.deepEqual(actions, [{ text: "Run", prompt: "Do it." }]);
      assert.ok(plan.markdown.startsWith(example.trimStart()));
      assert.equal((plan.markdown.match(/<tg-button-row>/g) ?? []).length, 1);
    }
  }
});

test("Only complete standalone exact-name fences activate; examples remain literal", () => {
  for (const source of [
    '````markdown\n```telegram_button\n{Run}\n```\n````',
    '~~~markdown\n```telegram_button\n{Run}\n```\n~~~',
    '```text\n```telegram_button\n{Run}\n```',
    '> ```telegram_button\n> {Run}\n> ```',
    '- ```telegram_button\n  {Run}\n  ```',
    'Text ```telegram_button\n{Run}\n```',
    '```telegram_buttons\n{Run}\n```',
    '```TELEGRAM_BUTTON\n{Run}\n```',
    '``telegram_button\n{Run}\n``',
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
      assert.deepEqual(body.rich_message, { markdown: chunks[sends] });
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

test("Footer buttons ignore horizontal indentation in both rendering modes", () => {
  for (const rendering of ["rich", "html"] as const) {
    for (const prefix of ["", " ", "   ", "    ", "\t", " \t  "]) {
      for (const payload of ['{📋 Карта владельцев|Покажи карту тестов.}', '{"label":"📋 Карта владельцев","prompt":"Покажи карту тестов."}']) {
        const actions: unknown[] = [];
        const plan = planTelegramButtonReply(`Before\r\n${prefix}<!-- telegram_button ${payload} -->\r\nAfter`, {
          rendering,
          registerAction: (action) => { actions.push(action); return "tgbtn:test"; },
        });
        assert.deepEqual(actions, [{ text: "📋 Карта владельцев", prompt: "Покажи карту тестов." }]);
        assert.deepEqual(plan.replyMarkup, { inline_keyboard: [[{ text: "📋 Карта владельцев", callback_data: "tgbtn:test" }]] });
        assert.doesNotMatch(plan.markdown, /<!--|-->/u);
      }
    }
  }
});

test("Footer buttons activate independently of surrounding Markdown and same-line neighbors", () => {
  const raw = '<!-- telegram_button {Run|Do it.} -->';
  for (const [before, after] of [
    ["Text ", " tail"], ["> ", ""], ["  - ", ""], ["1. ", ""],
    ["`", "`"], ["```md\n", "\n```"], ["    ```\n", "\n    ```"],
  ]) {
    const actions: unknown[] = [];
    const plan = planTelegramButtonReply(before + raw + raw + after, {
      registerAction: (action) => { actions.push(action); return `tgbtn:${actions.length}`; },
    });
    assert.deepEqual(actions, [{ text: "Run", prompt: "Do it." }, { text: "Run", prompt: "Do it." }]);
    assert.equal(plan.replyMarkup?.inline_keyboard.length, 2);
    assert.doesNotMatch(plan.markdown, /<!--|-->/u);
  }
  const plan = planTelegramButtonReply('```telegram_button\n<!-- telegram_button {Run|Do it.} -->\n```', {
    registerAction: () => "tgbtn:test",
  });
  assert.equal(plan.replyMarkup?.inline_keyboard[0]?.[0]?.text, "Run");
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
  assert.deepEqual(answers, [["query", "Button action unavailable"]]);
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

test("One nearest-deadline timer expires callback state without another input", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const store = createTelegramButtonActionStore();
  let retired = 0;
  const group = { retire() { retired++; } };
  const early = store.register({ text: "Early", prompt: "Early", completionGroup: group, expiresAt: 1100 });
  const sibling = store.register({ text: "Sibling", prompt: "Sibling", completionGroup: group, expiresAt: 1100 });
  const later = store.register({ text: "Later", prompt: "Later", expiresAt: 1200 });
  t.mock.timers.tick(99); assert.equal(retired, 0);
  t.mock.timers.tick(1); assert.equal(retired, 1, "The timer retires the whole group without resolve/register");
  assert.equal(store.resolve(early), undefined); assert.equal(store.resolve(sibling), undefined);
  t.mock.timers.tick(100); assert.equal(store.resolve(later), undefined);
  store.clear!();
});

test("Callback expiry keeps only one unref timer and fences cancelled timer generations", t => {
  t.mock.timers.enable({ apis: ["Date"] }); t.mock.timers.setTime(1000);
  const pending = new Set<{ callback: () => void; unrefed: boolean }>();
  t.mock.method(globalThis, "setTimeout", ((callback: () => void) => {
    const handle = { callback, unrefed: false, unref() { this.unrefed = true; return this; } };
    pending.add(handle); return handle;
  }) as unknown as typeof setTimeout);
  t.mock.method(globalThis, "clearTimeout", ((handle: unknown) => { pending.delete(handle as typeof pending extends Set<infer T> ? T : never); }) as typeof clearTimeout);
  const store = createTelegramButtonActionStore();
  for (let i = 0; i < 60; i++) store.register({ text: String(i), prompt: String(i), expiresAt: 1100 });
  assert.equal(pending.size, 1);
  const cancelled = [...pending][0]!;
  assert.equal(cancelled.unrefed, true);
  store.clear!(); assert.equal(pending.size, 0);
  let retired = 0;
  store.register({ text: "Next", prompt: "Next", expiresAt: 1200, completionGroup: { retire() { retired++; } } });
  const next = [...pending][0]!;
  t.mock.timers.setTime(1300);
  cancelled.callback();
  assert.equal(retired, 0); assert.equal(pending.size, 1, "Old timer cannot touch the successor timer or its records");
  pending.delete(next); next.callback();
  assert.equal(retired, 1); assert.equal(pending.size, 0);
});

test("Callback expiry keeps the original collector deadline through regeneration", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const store = createTelegramButtonActionStore();
  let markup = planTelegramButtonReply('<!-- telegram_choice {"question":"Two","choices":["A","B"],"select":2,"timeoutMs":100} -->',
    { registerAction: store.register }).replyMarkup!;
  let prompts = 0;
  t.mock.timers.tick(90);
  await handleTelegramButtonCallbackQuery({ id: "q", data: markup.inline_keyboard[0]![0]!.callback_data,
    message: { chat: { id: 7 }, message_id: 11, reply_markup: markup } }, undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async () => {}, enqueueButtonPrompt: () => { prompts++; },
    updateSelectionKeyboard: async (_query, next) => { markup = next; },
  });
  t.mock.timers.tick(10);
  for (const button of markup.inline_keyboard.flat()) assert.equal(store.resolve(button.callback_data), undefined);
  assert.equal(prompts, 0);
});

test("Session-style clear retires in-flight collectors but permits a fresh successor", async () => {
  const store = createTelegramButtonActionStore(), ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const plan = planTelegramButtonReply('<!-- telegram_choice {"question":"Two","choices":["A","B"],"select":2} -->',
    { registerAction: store.register });
  let prompts = 0;
  const pending = handleTelegramButtonCallbackQuery({ id: "q", data: plan.replyMarkup!.inline_keyboard[0]![0]!.callback_data,
    message: { chat: { id: 7 }, message_id: 11, reply_markup: plan.replyMarkup } }, undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async () => {}, enqueueButtonPrompt: () => { prompts++; },
    updateSelectionKeyboard: async (_query, _markup, guard) => { ready.resolve(); await release.promise; guard(); },
  });
  await ready.promise; store.clear!();
  const next = store.register({ text: "Successor", prompt: "Successor" });
  release.resolve(); await assert.rejects(pending, /unavailable/u);
  assert.equal(prompts, 0); assert.equal(store.resolve(next)!.prompt, "Successor");
});

test("Retirement and diagnostic failures cannot interrupt timer cleanup or restore associations", t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); t.mock.timers.setTime(1000);
  const failures: unknown[] = [];
  const store = createTelegramButtonActionStore({ recordFailure(error) { failures.push(error); throw new Error("Diagnostic failed"); } });
  const failure = new Error("Retirement observer failed");
  const first = store.register({ text: "A", prompt: "A", expiresAt: 1100, completionGroup: { retire() { throw failure; } } });
  let retired = 0;
  const second = store.register({ text: "B", prompt: "B", expiresAt: 1100, completionGroup: { retire() { retired++; } } });
  t.mock.timers.tick(100);
  assert.equal(retired, 1); assert.deepEqual(failures, [failure]);
  assert.equal(store.resolve(first), undefined); assert.equal(store.resolve(second), undefined);
});

test("Callback storage retains at most sixty plain associations, evicting the oldest", () => {
  const store = createTelegramButtonActionStore();
  const keys = Array.from({ length: 61 }, (_, index) => store.register({ text: String(index), prompt: String(index) }));
  assert.equal(store.resolve(keys[0]), undefined);
  assert.equal(keys.slice(1).filter(key => store.resolve(key)).length, 60);
});

test("Capacity retirement removes complete scalar groups without retaining one unchosen branch", () => {
  const store = createTelegramButtonActionStore();
  const question = planTelegramButtonReply('<!-- telegram_confirm {"question":"Q"} -->', { registerAction: store.register }).replyMarkup!;
  const newer = Array.from({ length: 59 }, (_, index) => store.register({ text: String(index), prompt: String(index) }));
  for (const button of question.inline_keyboard.flat()) assert.equal(store.resolve(button.callback_data), undefined);
  assert.equal(newer.filter(key => store.resolve(key)).length, 59);
});

test("Logical scalar completion also prohibits re-registering an escaped old group descriptor", () => {
  const store = createTelegramButtonActionStore();
  const captured: Parameters<typeof store.register>[0][] = [];
  const plan = planTelegramButtonReply('<!-- telegram_confirm {"question":"Q"} -->', {
    registerAction(action) { captured.push(action); return store.register(action); },
  });
  store.resolve(plan.replyMarkup!.inline_keyboard[0]![0]!.callback_data);
  for (const action of captured) assert.throws(() => store.register(action), /retired/u);
  const fresh = store.register({ text: "New independent request", prompt: "New independent request" });
  assert.ok(store.resolve(fresh));
});

test("A direct oversized registration group fails closed and cannot be renewed", () => {
  const store = createTelegramButtonActionStore(), group = Object.freeze({});
  const keys = Array.from({ length: 60 }, () => store.register({ text: "A", prompt: "A", completionGroup: group }));
  assert.throws(() => store.register({ text: "Overflow", prompt: "Overflow", completionGroup: group }), /exceeds capacity/u);
  for (const key of keys) assert.equal(store.resolve(key), undefined);
  assert.throws(() => store.register({ text: "Retry", prompt: "Retry", completionGroup: group }), /retired/u);
});

for (const kind of ["telegram_button", "telegram_choice", "wizard"] as const)
test(`An oversized callback publication refuses before any real registrations (${kind})`, () => {
  const labels = Array.from({ length: 61 }, (_, index) => String(index));
  const payload = kind === "telegram_button" ? labels.map(label => ({ label, prompt: label })) :
    kind === "wizard" ? [{ question: "First", choices: ["A"] }, { question: "Wide", choices: labels.slice(0, 60) }] :
    { question: "Q", choices: labels };
  const element = kind === "wizard" ? "telegram_choice" : kind;
  const plan = planTelegramButtonReply(`<!-- ${element} ${JSON.stringify(payload)} -->`, {
    registerAction: () => assert.fail("No partial publication or collateral eviction"),
  });
  assert.equal(plan.replyMarkup, undefined);
  assert.match(plan.markdown, /60-callback capacity/u);
});

test("Capacity preflight includes future wizard widths and counts disabled cells as zero callbacks", () => {
  const store = createTelegramButtonActionStore();
  const disabled = [{ label: "", disabled: true }, { label: "Off", disabled: true }];
  const plan = planTelegramButtonReply(`<!-- telegram_choice ${JSON.stringify({ question: "Q",
    choices: [...Array.from({ length: 60 }, (_, index) => String(index)), ...disabled] })} -->`, { registerAction: store.register });
  assert.equal(plan.replyMarkup!.inline_keyboard.flat().filter(button => button.callback_data).length, 60);
  const wizard = [{ question: "One", choices: ["A"] }, { question: "Two", choices: ["B", "C", "D", "E"] }];
  const legacy = Array.from({ length: 56 }, (_, index) => ({ label: String(index), prompt: String(index) }));
  const refused = planTelegramButtonReply(`<!-- telegram_choice ${JSON.stringify(wizard)} --><!-- telegram_button ${JSON.stringify(legacy)} -->`, {
    registerAction: () => assert.fail("Future step plus independent controls exceeds capacity"),
  });
  assert.equal(refused.replyMarkup, undefined);
  assert.match(refused.markdown, /60-callback capacity/u);
});

for (const pending of [false, true])
test(`Collector generations preserve original eviction age and cannot survive retirement (pending=${pending})`, async t => {
  t.mock.timers.enable({ apis: ["Date"] }); t.mock.timers.setTime(1000);
  const store = createTelegramButtonActionStore(), ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let markup = planTelegramButtonReply('<!-- telegram_choice {"question":"Two","choices":["A","B"],"select":2} -->',
    { registerAction: store.register }).replyMarkup!;
  t.mock.timers.setTime(2000);
  const other = Array.from({ length: 57 }, (_, index) => store.register({ text: String(index), prompt: String(index) }));
  let prompts = 0;
  const first = handleTelegramButtonCallbackQuery({ id: "q", data: markup.inline_keyboard[0]![0]!.callback_data,
    message: { chat: { id: 7 }, message_id: 11, reply_markup: markup } }, undefined, {
    resolveAction: store.resolve, answerCallbackQuery: async () => {}, enqueueButtonPrompt: () => { prompts++; },
    updateSelectionKeyboard: async (_query, next, guard) => {
      markup = next; ready.resolve(); if (pending) await release.promise; guard();
    },
  });
  await ready.promise;
  if (!pending) await first;
  const collector = markup.inline_keyboard.flat().map(button => button.callback_data);
  t.mock.timers.setTime(3000);
  const newest = store.register({ text: "Newest", prompt: "Newest" });
  if (pending) { release.resolve(); await assert.rejects(first, /unavailable/u); }
  for (const key of collector) assert.equal(store.resolve(key), undefined, "A refreshed footer is still the oldest interaction");
  assert.equal(prompts, 0);
  assert.equal(other.filter(key => store.resolve(key)).length, 57);
  assert.equal(store.resolve(newest)!.prompt, "Newest");
});

test("App-bound callbacks retire superseded views without invalidating other apps", () => {
  const store = createTelegramButtonActionStore();
  const binding = { app: "counter", generation: "g", revision: 1 };
  const old = [1, 2].map(index => store.register({ text: String(index), prompt: "counter::next", binding }));
  const unrelated = store.register({ text: "Other", prompt: "other::next", binding: { ...binding, app: "other" } });
  const current = store.register({ text: "Current", prompt: "counter::next", binding: { ...binding, revision: 2 } });
  assert.throws(() => store.register({ text: "Stale", prompt: "counter::next", binding }), /revision is stale/u);
  for (const key of old) assert.equal(store.resolve(key), undefined);
  assert.ok(store.resolve(current)); assert.ok(store.resolve(unrelated));
});

test("Scalar attempts spend their whole group before captured authority observations", () => {
  let store: ReturnType<typeof createTelegramButtonActionStore>, keys: string[] = [], observations = 0;
  store = createTelegramButtonActionStore({ captureSelectionAuthority: () => () => {
    observations++;
    for (const key of keys) assert.equal(store.resolve(key), undefined, "Authority callbacks cannot replay the in-progress decision");
  } });
  const plan = planTelegramButtonReply('<!-- telegram_confirm "Proceed?" -->', { registerAction: store.register });
  keys = plan.replyMarkup!.inline_keyboard.flat().map(button => button.callback_data!);
  assert.equal(store.resolve(keys[0])!.prompt, '{"question":"Proceed?","answer":"✅ Yes"}');
  assert.equal(observations, 1);
});

test("Caught admission reentry poisons only the attempted collector, not the whole store", () => {
  let store: ReturnType<typeof createTelegramButtonActionStore>;
  const captured: Parameters<typeof store.register>[0][] = [];
  planTelegramButtonReply('<!-- telegram_choice [{"question":"Q","choices":["A"]}] -->', {
    registerAction(action) { captured.push(action); return "tgbtn:seed"; },
  });
  let reenter = true;
  store = createTelegramButtonActionStore({ captureSelectionAuthority() {
    if (reenter) { reenter = false; assert.throws(() => store.register({ text: "Reentry", prompt: "Reentry" }), /reentered/u); }
    return () => {};
  } });
  assert.throws(() => store.register(captured[0]!), /admission is unavailable/u);
  assert.throws(() => store.register(captured[0]!), /retired/u);
  const key = store.register({ text: "Independent", prompt: "Independent" });
  assert.equal(store.resolve(key)!.prompt, "Independent");
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
  assert.deepEqual(answered, ["Done"]);
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
  assert.deepEqual(answered, ["Generative App action failed"]);
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
  assert.deepEqual(answered, ["Queued"]);
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
              disabled: {},
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
  assert.deepEqual(answered, ["Queued", "Button action expired"]);

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
    "Queued",
    "Button action expired",
    "Already queued",
  ]);
});
