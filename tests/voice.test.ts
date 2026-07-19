/**
 * Tests for the voice domain.
 * Covers policy resolution, turn tagging, suppression helpers, the provider registry,
 * and voice-specific markup parsing.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  clearTelegramVoiceTranscriptionProviders,
  computeVoiceTurnFlags,
  getTelegramVoiceReplyMode,
  getTelegramVoiceTranscriptionProviders,
  isVoiceTurn,
  registerTelegramVoiceTranscriptionProvider,
  shouldSuppressPreviewForVoice,
  TELEGRAM_VOICE_REPLY_MODES,
} from "../lib/voice.ts";

import {
  clearTelegramVoiceSynthesisProviders,
  getTelegramVoiceSynthesisProviders,
  hasTelegramVoiceSynthesisProvider,
  planTelegramVoiceReply,
  registerTelegramVoiceSynthesisProvider,
  stripTelegramCommentMarkupForPreview,
} from "../lib/outbound.ts";

// --- Test Setup ---

beforeEach(() => {
  clearTelegramVoiceSynthesisProviders();
  clearTelegramVoiceTranscriptionProviders();
});

afterEach(() => {
  clearTelegramVoiceSynthesisProviders();
  clearTelegramVoiceTranscriptionProviders();
});

// --- Policy Resolution ---

test("voice reply modes expose only hidden, mirror, and always", () => {
  assert.deepEqual(TELEGRAM_VOICE_REPLY_MODES, ["hidden", "mirror", "always"]);
});

test("getTelegramVoiceReplyMode returns 'hidden' by default", () => {
  assert.equal(getTelegramVoiceReplyMode(), "hidden");
  assert.equal(getTelegramVoiceReplyMode(undefined), "hidden");
  assert.equal(getTelegramVoiceReplyMode({}), "hidden");
  assert.equal(getTelegramVoiceReplyMode({ voice: {} }), "hidden");
});

test("getTelegramVoiceReplyMode reads valid mode from config", () => {
  assert.equal(
    getTelegramVoiceReplyMode({ voice: { replyMode: "mirror" } }),
    "mirror",
  );
  assert.equal(
    getTelegramVoiceReplyMode({ voice: { replyMode: "always" } }),
    "always",
  );
  assert.equal(
    getTelegramVoiceReplyMode({ voice: { replyMode: "hidden" } }),
    "hidden",
  );
  assert.equal(
    getTelegramVoiceReplyMode({ voice: { replyMode: "manual" } }),
    "hidden",
  );
});

test("getTelegramVoiceReplyMode ignores invalid config values", () => {
  assert.equal(
    getTelegramVoiceReplyMode({ voice: { replyMode: "invalid" as any } }),
    "hidden",
  );
  assert.equal(
    getTelegramVoiceReplyMode({ voice: { replyMode: "foo" as any } }),
    "hidden",
  );
});

test("getTelegramVoiceReplyMode ignores provider policy without config", () => {
  registerTelegramVoiceSynthesisProvider(
    {
      getVoicePolicy: () => ({ replyMode: "always" }),
    } as any,
    { id: "test-provider-1" },
  );

  assert.equal(getTelegramVoiceReplyMode({}), "hidden");
});

test("getTelegramVoiceReplyMode reads config even when provider returns invalid policy", () => {
  registerTelegramVoiceSynthesisProvider(
    {
      getVoicePolicy: () => ({ replyMode: "invalid" as any }),
    } as any,
    { id: "bad-provider" },
  );

  const result = getTelegramVoiceReplyMode({ voice: { replyMode: "mirror" } });
  assert.equal(result, "mirror");
});

test("getTelegramVoiceReplyMode defaults to hidden despite provider policies", () => {
  registerTelegramVoiceSynthesisProvider(
    {
      getVoicePolicy: () => ({ replyMode: "mirror" }),
    } as any,
    { id: "mirror-provider" },
  );
  registerTelegramVoiceSynthesisProvider(
    {
      getVoicePolicy: () => ({ replyMode: "always" }),
    } as any,
    { id: "always-provider" },
  );

  assert.equal(getTelegramVoiceReplyMode(), "hidden");
});

// --- Turn Tagging Helpers ---

test("computeVoiceTurnFlags works for all modes", () => {
  assert.deepEqual(computeVoiceTurnFlags("mirror", true), {
    voiceReplyPreferred: true,
    voiceReplyRequired: false,
  });

  assert.deepEqual(computeVoiceTurnFlags("mirror", false), {
    voiceReplyPreferred: false,
    voiceReplyRequired: false,
  });

  assert.deepEqual(computeVoiceTurnFlags("always", false), {
    voiceReplyPreferred: false,
    voiceReplyRequired: true,
  });

  assert.deepEqual(computeVoiceTurnFlags("hidden", true), {
    voiceReplyPreferred: false,
    voiceReplyRequired: false,
  });
});

test("isVoiceTurn detects voice-tagged turns correctly", () => {
  assert.equal(isVoiceTurn({ voiceReplyPreferred: true }), true);
  assert.equal(isVoiceTurn({ voiceReplyRequired: true }), true);
  assert.equal(
    isVoiceTurn({ voiceReplyPreferred: true, voiceReplyRequired: true }),
    true,
  );
  assert.equal(
    isVoiceTurn({ voiceReplyPreferred: false, voiceReplyRequired: false }),
    false,
  );
  assert.equal(isVoiceTurn(null), false);
  assert.equal(isVoiceTurn(undefined), false);
  assert.equal(isVoiceTurn({}), false);
});

// --- Preview Suppression ---

test("shouldSuppressPreviewForVoice works correctly", () => {
  assert.equal(
    shouldSuppressPreviewForVoice({ voiceReplyPreferred: true }),
    true,
  );
  assert.equal(
    shouldSuppressPreviewForVoice({ voiceReplyRequired: true }),
    true,
  );
  assert.equal(
    shouldSuppressPreviewForVoice({
      voiceReplyPreferred: false,
      voiceReplyRequired: false,
    }),
    false,
  );
  assert.equal(shouldSuppressPreviewForVoice(null), false);
  assert.equal(shouldSuppressPreviewForVoice(undefined), false);
});

// --- Voice Markup Parsing ---

test("planTelegramVoiceReply extracts simple voice text", () => {
  const result = planTelegramVoiceReply(
    "Hello\n\n<!-- telegram_voice: World -->",
  );
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
  const result = planTelegramVoiceReply(
    "Text\n\n<!-- telegram_voice: This is the voice text -->",
  );
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
  const result = planTelegramVoiceReply(
    "Normal\n\n<!-- telegram_voice: Voice only -->\n\ntext",
  );
  assert.ok(result.markdown.includes("Normal"));
  assert.ok(result.markdown.includes("text"));
  assert.equal(result.voiceText, "Voice only");
  assert.ok(!result.markdown.includes("telegram_voice"));
});

// --- Voice Provider Registry ---

test("Voice synthesis provider registry - basic register / get / has / clear", () => {
  assert.equal(hasTelegramVoiceSynthesisProvider(), false);
  assert.equal(getTelegramVoiceSynthesisProviders().length, 0);

  const dispose1 = registerTelegramVoiceSynthesisProvider(
    () => Promise.resolve("audio.mp3"),
    { id: "p1" },
  );
  assert.equal(hasTelegramVoiceSynthesisProvider(), true);
  assert.equal(getTelegramVoiceSynthesisProviders().length, 1);

  const dispose2 = registerTelegramVoiceSynthesisProvider(
    {
      getVoicePolicy: () => ({ replyMode: "always" }),
      getVoicePromptContribution: () => "Be concise.",
    } as any,
    { id: "p2" },
  );
  assert.equal(getTelegramVoiceSynthesisProviders().length, 2);

  dispose1();
  assert.equal(getTelegramVoiceSynthesisProviders().length, 1);

  dispose2();
  assert.equal(hasTelegramVoiceSynthesisProvider(), false);
});

test("Voice synthesis provider registry accepts both function and object form", () => {
  // Function form (backward compat)
  registerTelegramVoiceSynthesisProvider(() => Promise.resolve("audio1"), {
    id: "fn",
  });

  // Object form
  registerTelegramVoiceSynthesisProvider(
    {
      getVoicePolicy: () => ({ replyMode: "mirror" }),
    } as any,
    { id: "obj" },
  );

  const providers = getTelegramVoiceSynthesisProviders();
  assert.equal(providers.length, 2);
  assert.equal(typeof providers[0], "function");
  assert.equal(typeof providers[1], "object");
});

interface VoiceProviderRegistryFixture {
  label: string;
  generatedId: string;
  fixtureId: string;
  register(value: string, id?: string): () => void;
  count(): number;
}

const voiceProviderRegistries: VoiceProviderRegistryFixture[] = [
  {
    label: "synthesis",
    generatedId: "voice-synthesis-provider-0",
    fixtureId: "fixture-tts",
    register: (value, id) =>
      registerTelegramVoiceSynthesisProvider(
        () => Promise.resolve(value),
        id ? { id } : undefined,
      ),
    count: () => getTelegramVoiceSynthesisProviders().length,
  },
  {
    label: "transcription",
    generatedId: "voice-transcription-provider-0",
    fixtureId: "fixture-stt",
    register: (value, id) =>
      registerTelegramVoiceTranscriptionProvider(
        () => Promise.resolve(value),
        id ? { id } : undefined,
      ),
    count: () => getTelegramVoiceTranscriptionProviders().length,
  },
];

for (const registry of voiceProviderRegistries) {
  test(`Voice ${registry.label} generated ids skip existing registry entries`, () => {
    registry.register("stable", registry.generatedId);
    registry.register("generated");
    assert.equal(registry.count(), 2);
  });

  test(`Voice ${registry.label} stable id stale disposer does not delete replacement`, () => {
    const disposeFirst = registry.register("first", "stable");
    registry.register("second", "stable");
    disposeFirst();
    assert.equal(registry.count(), 1);
  });

  test(`Voice ${registry.label} fixture re-registers cleanly across lifecycle boundaries`, () => {
    const registerFixture = (generation: string) =>
      registry.register(generation, registry.fixtureId);
    const disposeSessionStart = registerFixture("session-start");
    const disposeResume = registerFixture("resume");
    const disposeReload = registerFixture("reload");

    assert.equal(registry.count(), 1);
    disposeSessionStart();
    disposeResume();
    assert.equal(registry.count(), 1);
    disposeReload();
    assert.equal(registry.count(), 0);
  });

  test(`Voice ${registry.label} generated ids do not collide after disposal`, () => {
    const disposeFirst = registry.register("first");
    registry.register("second");
    disposeFirst();
    registry.register("third");
    assert.equal(registry.count(), 2);
  });
}

test("Voice synthesis provider registry clear works reliably for tests", () => {
  registerTelegramVoiceSynthesisProvider(() => Promise.resolve("x"), {
    id: "tmp",
  });
  assert.equal(hasTelegramVoiceSynthesisProvider(), true);

  clearTelegramVoiceSynthesisProviders();
  assert.equal(hasTelegramVoiceSynthesisProvider(), false);
});

// --- Stripping And Generic Parser Interaction ---

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
