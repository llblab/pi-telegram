/**
 * Comprehensive tests for the Voice Domain (lib/voice.ts)
 *
 * This file tests the centralized Voice logic that was introduced in Commit 2.
 * It covers policy resolution, turn tagging, suppression helpers, the provider registry,
 * and voice-specific markup parsing.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  getTelegramVoiceReplyMode,
  computeVoiceTurnFlags,
  isVoiceTurn,
  shouldSuppressPreviewForVoice,
  type TelegramVoiceReplyMode,
  type TelegramVoiceTurnView,
  type TelegramVoiceProvider,
  type TelegramVoiceProviderResult,
} from "../lib/voice.ts";

import {
  registerTelegramVoiceProvider,
  getTelegramVoiceProviders,
  hasTelegramVoiceProvider,
  clearTelegramVoiceProviders,
  planTelegramVoiceReply,
  stripTelegramCommentMarkupForPreview,
  stripTelegramCommentMarkupForDelivery,
  stripTelegramVoiceMarkupForPreview,
  normalizeMarkdownAfterVoiceExtraction,
} from "../lib/outbound-handlers.ts";

// ======================================================
// === Test Setup
// ======================================================

beforeEach(() => {
  clearTelegramVoiceProviders();
});

afterEach(() => {
  clearTelegramVoiceProviders();
});

// ======================================================
// === Policy Resolution
// ======================================================

test("getTelegramVoiceReplyMode returns 'manual' by default", () => {
  assert.equal(getTelegramVoiceReplyMode(), "manual");
  assert.equal(getTelegramVoiceReplyMode(undefined), "manual");
  assert.equal(getTelegramVoiceReplyMode({}), "manual");
  assert.equal(getTelegramVoiceReplyMode({ voice: {} }), "manual");
});

test("getTelegramVoiceReplyMode reads valid mode from config", () => {
  assert.equal(getTelegramVoiceReplyMode({ voice: { replyMode: "mirror" } }), "mirror");
  assert.equal(getTelegramVoiceReplyMode({ voice: { replyMode: "voice" } }), "voice");
  assert.equal(getTelegramVoiceReplyMode({ voice: { replyMode: "manual" } }), "manual");
});

test("getTelegramVoiceReplyMode ignores invalid config values", () => {
  assert.equal(getTelegramVoiceReplyMode({ voice: { replyMode: "invalid" as any } }), "manual");
  assert.equal(getTelegramVoiceReplyMode({ voice: { replyMode: "foo" as any } }), "manual");
});

test("getTelegramVoiceReplyMode respects provider policy via getVoicePolicy()", () => {
  registerTelegramVoiceProvider(
    {
      getVoicePolicy: () => ({ replyMode: "voice" }),
    } as any,
    { id: "test-provider-1" },
  );

  // No (or invalid) config → first provider's policy wins (config has priority only when valid)
  const result = getTelegramVoiceReplyMode({});
  assert.equal(result, "voice");
});

test("getTelegramVoiceReplyMode falls back to config when provider returns invalid policy", () => {
  registerTelegramVoiceProvider(
    {
      getVoicePolicy: () => ({ replyMode: "invalid" as any }),
    } as any,
    { id: "bad-provider" },
  );

  const result = getTelegramVoiceReplyMode({ voice: { replyMode: "mirror" } });
  assert.equal(result, "mirror");
});

test("getTelegramVoiceReplyMode prefers first valid provider policy", () => {
  registerTelegramVoiceProvider(
    {
      getVoicePolicy: () => ({ replyMode: "invalid" as any }),
    } as any,
    { id: "bad" },
  );
  registerTelegramVoiceProvider(
    {
      getVoicePolicy: () => ({ replyMode: "voice" }),
    } as any,
    { id: "good" },
  );

  const result = getTelegramVoiceReplyMode();
  assert.equal(result, "voice");
});

// ======================================================
// === Turn Tagging Helpers
// ======================================================

test("computeVoiceTurnFlags works for all modes", () => {
  assert.deepEqual(computeVoiceTurnFlags("mirror", true), {
    voiceReplyPreferred: true,
    voiceReplyRequired: false,
  });

  assert.deepEqual(computeVoiceTurnFlags("mirror", false), {
    voiceReplyPreferred: false,
    voiceReplyRequired: false,
  });

  assert.deepEqual(computeVoiceTurnFlags("voice", false), {
    voiceReplyPreferred: false,
    voiceReplyRequired: true,
  });

  assert.deepEqual(computeVoiceTurnFlags("manual", true), {
    voiceReplyPreferred: false,
    voiceReplyRequired: false,
  });
});

test("isVoiceTurn detects voice-tagged turns correctly", () => {
  assert.equal(isVoiceTurn({ voiceReplyPreferred: true }), true);
  assert.equal(isVoiceTurn({ voiceReplyRequired: true }), true);
  assert.equal(isVoiceTurn({ voiceReplyPreferred: true, voiceReplyRequired: true }), true);
  assert.equal(isVoiceTurn({ voiceReplyPreferred: false, voiceReplyRequired: false }), false);
  assert.equal(isVoiceTurn(null), false);
  assert.equal(isVoiceTurn(undefined), false);
  assert.equal(isVoiceTurn({}), false);
});

// ======================================================
// === Preview Suppression
// ======================================================

test("shouldSuppressPreviewForVoice works correctly", () => {
  assert.equal(shouldSuppressPreviewForVoice({ voiceReplyPreferred: true }), true);
  assert.equal(shouldSuppressPreviewForVoice({ voiceReplyRequired: true }), true);
  assert.equal(shouldSuppressPreviewForVoice({ voiceReplyPreferred: false, voiceReplyRequired: false }), false);
  assert.equal(shouldSuppressPreviewForVoice(null), false);
  assert.equal(shouldSuppressPreviewForVoice(undefined), false);
});

// ======================================================
// === Voice Markup Parsing (planTelegramVoiceReply)
// ======================================================

test("planTelegramVoiceReply extracts simple voice text", () => {
  const result = planTelegramVoiceReply("Hello\n\n<!-- telegram_voice: World -->");
  assert.equal(result.voiceText, "World");
  assert.ok(result.voiceReplies?.length === 1);
});

test("planTelegramVoiceReply extracts lang and rate attributes", () => {
  const result = planTelegramVoiceReply(
    'Say\n\n<!-- telegram_voice lang="de" rate="1.2": Hallo -->',
  );
  assert.equal(result.lang, "de");
  assert.equal(result.rate, "1.2");
  assert.equal(result.voiceText, "Hallo");
});

test("planTelegramVoiceReply handles colon shorthand form", () => {
  const result = planTelegramVoiceReply("Text\n\n<!-- telegram_voice: This is the voice text -->");
  assert.equal(result.voiceText, "This is the voice text");
  assert.ok(result.voiceReplies?.length === 1);
});

test("planTelegramVoiceReply handles multiple voice blocks", () => {
  const result = planTelegramVoiceReply(
    "First\n\n<!-- telegram_voice: One -->\n\nand second\n\n<!-- telegram_voice: Two -->",
  );
  assert.equal(result.voiceReplies?.length, 2);
  assert.equal(result.voiceText, "One\n\nTwo");
  assert.ok(result.markdown.includes("First"));
  assert.ok(result.markdown.includes("and second"));
  assert.ok(!result.markdown.includes("telegram_voice"));
});

test("planTelegramVoiceReply returns cleaned markdown", () => {
  const result = planTelegramVoiceReply("Normal\n\n<!-- telegram_voice: Voice only -->\n\ntext");
  assert.ok(result.markdown.includes("Normal"));
  assert.ok(result.markdown.includes("text"));
  assert.equal(result.voiceText, "Voice only");
  assert.ok(!result.markdown.includes("telegram_voice"));
});

// ======================================================
// === Voice Provider Registry
// ======================================================

test("Voice provider registry - basic register / get / has / clear", () => {
  assert.equal(hasTelegramVoiceProvider(), false);
  assert.equal(getTelegramVoiceProviders().length, 0);

  const dispose1 = registerTelegramVoiceProvider(() => Promise.resolve("audio.mp3"), { id: "p1" });
  assert.equal(hasTelegramVoiceProvider(), true);
  assert.equal(getTelegramVoiceProviders().length, 1);

  const dispose2 = registerTelegramVoiceProvider(
    {
      getVoicePolicy: () => ({ replyMode: "voice" }),
      getVoicePromptContribution: () => "Be concise.",
    } as any,
    { id: "p2" },
  );
  assert.equal(getTelegramVoiceProviders().length, 2);

  dispose1();
  assert.equal(getTelegramVoiceProviders().length, 1);

  dispose2();
  assert.equal(hasTelegramVoiceProvider(), false);
});

test("Voice provider registry accepts both function and object form", () => {
  // Function form (backward compat)
  registerTelegramVoiceProvider(() => Promise.resolve("audio1"), { id: "fn" });

  // Object form
  registerTelegramVoiceProvider(
    {
      getVoicePolicy: () => ({ replyMode: "mirror" }),
    } as any,
    { id: "obj" },
  );

  const providers = getTelegramVoiceProviders();
  assert.equal(providers.length, 2);
  assert.equal(typeof providers[0], "function");
  assert.equal(typeof providers[1], "object");
});

test("Voice provider registry clear works reliably for tests", () => {
  registerTelegramVoiceProvider(() => Promise.resolve("x"), { id: "tmp" });
  assert.equal(hasTelegramVoiceProvider(), true);

  clearTelegramVoiceProviders();
  assert.equal(hasTelegramVoiceProvider(), false);
});

// ======================================================
// === Stripping & Generic Parser Interaction
// ======================================================

test("stripTelegramCommentMarkupForPreview removes voice blocks and normalizes whitespace", () => {
  const input = "Hello\n\n<!-- telegram_voice: World -->\n\nWorld";
  const result = stripTelegramCommentMarkupForPreview(input);
  assert.ok(!result.includes("telegram_voice"));
  assert.ok(!result.includes("\n\n\n"));
});

test("planTelegramVoiceReply works with the original generic parsers (fence + comment)", () => {
  const input = "Text\n```\ncode\n```\n<!-- telegram_voice: Spoken -->";
  const result = planTelegramVoiceReply(input);
  assert.equal(result.voiceText, "Spoken");
  assert.ok(result.markdown.includes("Text"));
  assert.ok(result.markdown.includes("code"));
});
