/**
 * Regression tests for public package API exports
 * Zones: package boundary, companion extension interop
 * Guards the stable 0.12 public subpaths and the removal of deep lib wildcard exports
 */

import assert from "node:assert/strict";
import test from "node:test";

async function assertPackagePathNotExported(specifier: string): Promise<void> {
  await assert.rejects(
    () => import(specifier),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
}

test("Public package subpaths expose the stable companion-extension API", async () => {
  const [root, inbound, outbound, updates, sections, status, voice, keyboard] =
    await Promise.all([
      import("@llblab/pi-telegram"),
      import("@llblab/pi-telegram/inbound"),
      import("@llblab/pi-telegram/outbound"),
      import("@llblab/pi-telegram/updates"),
      import("@llblab/pi-telegram/sections"),
      import("@llblab/pi-telegram/status"),
      import("@llblab/pi-telegram/voice"),
      import("@llblab/pi-telegram/keyboard"),
    ]);

  assert.deepEqual(Object.keys(root), ["default"]);
  assert.deepEqual(Object.keys(inbound).sort(), [
    "registerTelegramInboundHandler",
  ]);
  assert.deepEqual(Object.keys(outbound).sort(), [
    "recordTelegramRuntimeEvent",
    "registerTelegramOutboundHandler",
  ]);
  assert.deepEqual(Object.keys(updates).sort(), [
    "registerTelegramUpdateHandler",
  ]);
  assert.deepEqual(Object.keys(sections).sort(), [
    "getTelegramSectionDiagnostics",
    "registerTelegramSection",
  ]);
  assert.deepEqual(Object.keys(status).sort(), [
    "registerTelegramStatusLineProvider",
  ]);
  assert.deepEqual(Object.keys(voice).sort(), [
    "TELEGRAM_VOICE_REPLY_MODES",
    "computeVoicePromptContribution",
    "computeVoiceTurnFlags",
    "getTelegramVoiceReplyMode",
    "getTelegramVoiceSendTranscript",
    "isVoiceTurn",
    "registerTelegramVoiceSynthesisProvider",
    "registerTelegramVoiceTranscriptionProvider",
    "shouldSuppressPreviewForVoice",
  ]);
  assert.deepEqual(Object.keys(keyboard), []);
});

test("Package-private lib implementation paths are not exported", async () => {
  await assertPackagePathNotExported("@llblab/pi-telegram/lib/updates.ts");
  await assertPackagePathNotExported("@llblab/pi-telegram/lib/sections.ts");
  await assertPackagePathNotExported("@llblab/pi-telegram/api/updates.ts");
});
