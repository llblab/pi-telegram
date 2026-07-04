/**
 * Telegram Extension Sections tests
 * Zones: telegram ui, extension platform, callback routing
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTelegramExtensionSectionRegistry,
  getTelegramExtensionSettingsRows,
  getTelegramSectionMainMenuRows,
  parseTelegramSectionCallback,
  handleTelegramSectionOpen,
  handleTelegramSectionCallback,
  handleTelegramSectionSettingsOpen,
  type TelegramSectionRegistration,
  type TelegramSectionCallbackHandlerDeps,
} from "../lib/sections.ts";

function stubSection(
  id: string,
  label: string,
  overrides: Partial<TelegramSectionRegistration> = {},
): TelegramSectionRegistration {
  return {
    id,
    label,
    render: async () => ({ text: `<b>${label}</b>`, parseMode: "html" }),
    ...overrides,
  };
}

function stubDeps(
  overrides: Partial<TelegramSectionCallbackHandlerDeps> = {},
): TelegramSectionCallbackHandlerDeps {
  return {
    answerCallbackQuery: async () => {},
    editInteractiveMessage: async () => {},
    sendInteractiveMessage: async () => undefined,
    enqueuePrompt: async () => {},
    deleteMessage: async () => {},
    ...overrides,
  };
}

// --- Registry ---

test("Registry registers a section and returns a disposer", () => {
  const registry = createTelegramExtensionSectionRegistry();
  const unregister = registry.register(stubSection("@test/section-a", "A"));
  const sections = registry.getSections();
  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, "@test/section-a");
  assert.equal(sections[0].label, "A");
  assert.equal(typeof sections[0].token, "string");
  unregister();
  assert.equal(registry.getSections().length, 0);
});

test("Registry assigns unique tokens to each section", () => {
  const registry = createTelegramExtensionSectionRegistry();
  const u1 = registry.register(stubSection("@test/a", "A"));
  const u2 = registry.register(stubSection("@test/b", "B"));
  const sections = registry.getSections();
  assert.equal(sections.length, 2);
  assert.notEqual(sections[0].token, sections[1].token);
  u1();
  u2();
});

test("Registry rejects duplicate section ids", () => {
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "A"));
  assert.throws(
    () => registry.register(stubSection("@test/a", "A2")),
    /already registered/,
  );
});

test("Registry sorts sections by order then id", () => {
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(stubSection("@test/c", "C", { order: 2 }));
  registry.register(stubSection("@test/a", "A", { order: 0 }));
  registry.register(stubSection("@test/b", "B", { order: 1 }));
  const sections = registry.getSections();
  assert.equal(sections[0].id, "@test/a");
  assert.equal(sections[1].id, "@test/b");
  assert.equal(sections[2].id, "@test/c");
});

test("Registry getByToken resolves token to section", () => {
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "A"));
  const sections = registry.getSections();
  const found = registry.getByToken(sections[0].token);
  assert.ok(found);
  assert.equal(found.id, "@test/a");
});

test("Registry getByToken returns undefined for unknown token", () => {
  const registry = createTelegramExtensionSectionRegistry();
  assert.equal(registry.getByToken("99"), undefined);
});

test("Registry clear removes all sections and resets tokens", () => {
  const registry = createTelegramExtensionSectionRegistry();
  const u1 = registry.register(stubSection("@test/a", "A"));
  registry.clear();
  assert.equal(registry.getSections().length, 0);
  // New registration gets fresh tokens
  const u2 = registry.register(stubSection("@test/b", "B"));
  const sections = registry.getSections();
  assert.equal(sections[0].token, "0");
  u1();
  u2();
});

test("Registry diagnostics reports active and error states", () => {
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "A"));
  let diags = registry.getDiagnostics();
  assert.equal(diags.length, 1);
  assert.equal(diags[0].status, "active");
  assert.equal(diags[0].id, "@test/a");
  registry.recordError("0", "boom");
  diags = registry.getDiagnostics();
  assert.equal(diags[0].status, "error");
  assert.equal(diags[0].lastError, "boom");
  registry.clearError("0");
  assert.equal(registry.getDiagnostics()[0].status, "active");
});

// --- Settings Rows ---

test("getTelegramExtensionSettingsRows returns rows only for sections with settings", () => {
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "A"));
  registry.register(
    stubSection("@test/b", "B", {
      settings: {
        label: "🔧 B Settings",
        open: async () => ({ text: "B settings" }),
      },
    }),
  );
  const rows = getTelegramExtensionSettingsRows(registry);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "🔧 B Settings");
  assert.ok(rows[0].callback_data.startsWith("section:"));
  assert.ok(rows[0].callback_data.endsWith(":settings:open"));
});

test("getTelegramExtensionSettingsRows sorts by settings order", () => {
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(
    stubSection("@test/c", "C", {
      settings: { label: "C", open: async () => ({ text: "C" }), order: 2 },
    }),
  );
  registry.register(
    stubSection("@test/a", "A", {
      settings: { label: "A", open: async () => ({ text: "A" }), order: 0 },
    }),
  );
  const rows = getTelegramExtensionSettingsRows(registry);
  assert.equal(rows[0].label, "A");
  assert.equal(rows[1].label, "C");
});

// --- Menu Rows ---

test("getTelegramSectionMainMenuRows omits sections with failing labels", () => {
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "A"));
  registry.register(
    stubSection("@test/b", "B", {
      getLabel: () => {
        throw new Error("label failed");
      },
    }),
  );
  const rows = getTelegramSectionMainMenuRows(registry);
  assert.deepEqual(
    rows.map((row) => row.text),
    ["A"],
  );
  const diagnostics = registry.getDiagnostics();
  assert.equal(diagnostics[1].status, "error");
  assert.equal(diagnostics[1].lastError, "label failed");
});

test("getTelegramExtensionSettingsRows omits settings with failing labels", () => {
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(
    stubSection("@test/a", "A", {
      settings: { label: "A", open: async () => ({ text: "A" }) },
    }),
  );
  registry.register(
    stubSection("@test/b", "B", {
      settings: {
        label: "B",
        getLabel: () => {
          throw new Error("settings label failed");
        },
        open: async () => ({ text: "B" }),
      },
    }),
  );
  const rows = getTelegramExtensionSettingsRows(registry);
  assert.deepEqual(
    rows.map((row) => row.label),
    ["A"],
  );
  const diagnostics = registry.getDiagnostics();
  assert.equal(diagnostics[1].status, "error");
  assert.equal(diagnostics[1].lastError, "settings label failed");
});

test("successful labels do not clear unrelated runtime diagnostics", () => {
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "A"));
  registry.recordError("0", "callback failed", "callback");
  assert.equal(getTelegramSectionMainMenuRows(registry)[0].text, "A");
  assert.equal(registry.getDiagnostics()[0].status, "error");
  assert.equal(registry.getDiagnostics()[0].lastError, "callback failed");
  registry.clearError("0", "callback");
  assert.equal(registry.getDiagnostics()[0].status, "active");
});

// --- Callback Parsing ---

test("parseTelegramSectionCallback parses section:token:action", () => {
  const result = parseTelegramSectionCallback("section:00:open");
  assert.ok(result);
  assert.equal(result.token, "00");
  assert.equal(result.action, "open");
  assert.equal(result.payload, "");
});

test("parseTelegramSectionCallback parses section:token:action:payload", () => {
  const result = parseTelegramSectionCallback("section:01:toggle:on");
  assert.ok(result);
  assert.equal(result.token, "01");
  assert.equal(result.action, "toggle");
  assert.equal(result.payload, "on");
});

test("parseTelegramSectionCallback parses payload with colons", () => {
  const result = parseTelegramSectionCallback("section:05:nav:path:to:item");
  assert.ok(result);
  assert.equal(result.token, "05");
  assert.equal(result.action, "nav");
  assert.equal(result.payload, "path:to:item");
});

test("parseTelegramSectionCallback returns undefined for non-section data", () => {
  assert.equal(parseTelegramSectionCallback("menu:model"), undefined);
  assert.equal(parseTelegramSectionCallback("settings:list"), undefined);
  assert.equal(parseTelegramSectionCallback(""), undefined);
});

// --- Section Open ---

test("handleTelegramSectionOpen renders section view with back row", async () => {
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(
    stubSection("@test/a", "🗂 A", {
      render: async () => ({
        text: "<b>Hello</b>",
        parseMode: "html",
        replyMarkup: {
          inline_keyboard: [
            [{ text: "Do", callback_data: "section:0:act:do" }],
          ],
        },
      }),
    }),
  );
  let editedText = "";
  let editedMarkup: unknown = undefined;
  const deps = stubDeps({
    editInteractiveMessage: async (
      _chatId,
      _msgId,
      text,
      _mode,
      replyMarkup,
    ) => {
      editedText = text;
      editedMarkup = replyMarkup;
    },
  });
  const handled = await handleTelegramSectionOpen(
    registry,
    "0",
    123,
    456,
    "cb-id",
    deps,
  );
  assert.equal(handled, true);
  assert.equal(editedText, "<b>Hello</b>");
  const markup = editedMarkup as {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
  assert.ok(markup);
  // First row is the Back button
  assert.equal(markup.inline_keyboard[0][0].text, "⬆️ Main menu");
  assert.equal(markup.inline_keyboard[0][0].callback_data, "menu:back");
  // Second row is the section's own button
  assert.equal(markup.inline_keyboard[1][0].text, "Do");
});

test("section callbackData rejects payloads above Telegram's byte limit", async () => {
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(
    stubSection("@test/a", "A", {
      render: async (ctx) => {
        assert.throws(
          () => ctx.callbackData("act", "x".repeat(80)),
          /64 bytes/,
        );
        return { text: "ok" };
      },
    }),
  );
  const handled = await handleTelegramSectionOpen(
    registry,
    "0",
    123,
    456,
    "cb-id",
    stubDeps(),
  );
  assert.equal(handled, true);
});

test("handleTelegramSectionOpen preserves existing back button", async () => {
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(
    stubSection("@test/a", "A", {
      render: async () => ({
        text: "Test",
        replyMarkup: {
          inline_keyboard: [
            [{ text: "⬆️ Main menu", callback_data: "menu:back" }],
            [{ text: "Custom", callback_data: "section:0:custom" }],
          ],
        },
      }),
    }),
  );
  let editedMarkup: unknown = undefined;
  const deps = stubDeps({
    editInteractiveMessage: async (_a, _b, _c, _d, replyMarkup) => {
      editedMarkup = replyMarkup;
    },
  });
  await handleTelegramSectionOpen(registry, "0", 123, 456, "cb-id", deps);
  const markup = editedMarkup as {
    inline_keyboard: Array<Array<{ text: string }>>;
  };
  assert.equal(markup.inline_keyboard.length, 2);
  // No duplicate back row
  assert.equal(markup.inline_keyboard[0][0].text, "⬆️ Main menu");
});

test("handleTelegramSectionOpen handles stale token gracefully", async () => {
  const registry = createTelegramExtensionSectionRegistry();
  let answeredText = "";
  const deps = stubDeps({
    answerCallbackQuery: async (_id, text) => {
      answeredText = text ?? "";
    },
  });
  const handled = await handleTelegramSectionOpen(
    registry,
    "99",
    123,
    456,
    "cb-id",
    deps,
  );
  assert.equal(handled, true);
  assert.ok(answeredText.includes("no longer available"));
});

test("handleTelegramSectionOpen records and clears render errors", async () => {
  const registry = createTelegramExtensionSectionRegistry();
  let fail = true;
  registry.register(
    stubSection("@test/a", "A", {
      render: async () => {
        if (fail) throw new Error("render failed");
        return { text: "ok" };
      },
    }),
  );
  await handleTelegramSectionOpen(registry, "0", 123, 456, "cb-id", stubDeps());
  assert.equal(registry.getDiagnostics()[0].status, "error");
  assert.equal(registry.getDiagnostics()[0].lastError, "render failed");
  fail = false;
  await handleTelegramSectionOpen(registry, "0", 123, 456, "cb-id", stubDeps());
  assert.equal(registry.getDiagnostics()[0].status, "active");
});

// --- Section Callback ---

test("handleTelegramSectionCallback dispatches to section handler", async () => {
  const registry = createTelegramExtensionSectionRegistry();
  let receivedAction = "";
  let receivedPayload = "";
  registry.register(
    stubSection("@test/a", "A", {
      handleCallback: async (ctx) => {
        receivedAction = ctx.action;
        receivedPayload = ctx.payload;
        return "handled" as const;
      },
    }),
  );
  const deps = stubDeps();
  const handled = await handleTelegramSectionCallback(
    registry,
    "0",
    "toggle",
    "on",
    123,
    456,
    "cb-id",
    deps,
  );
  assert.equal(handled, true);
  assert.equal(receivedAction, "toggle");
  assert.equal(receivedPayload, "on");
});

test("handleTelegramSectionCallback falls back to settings handler", async () => {
  const registry = createTelegramExtensionSectionRegistry();
  let settingsAction = "";
  registry.register(
    stubSection("@test/a", "A", {
      handleCallback: async () => "pass" as const,
      settings: {
        label: "Settings",
        open: async () => ({ text: "settings" }),
        handleCallback: async (ctx) => {
          settingsAction = ctx.action;
          return "handled" as const;
        },
      },
    }),
  );
  const deps = stubDeps();
  await handleTelegramSectionCallback(
    registry,
    "0",
    "toggle",
    "off",
    123,
    456,
    "cb-id",
    deps,
  );
  assert.equal(settingsAction, "toggle");
});

test("handleTelegramSectionCallback gives settings-only handlers settings navigation", async () => {
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(
    stubSection("@test/a", "A", {
      settings: {
        label: "Settings",
        open: async () => ({ text: "settings" }),
        handleCallback: async (ctx) => {
          await ctx.edit({ text: "settings detail" });
          return "handled" as const;
        },
      },
    }),
  );
  let editedMarkup: unknown;
  const deps = stubDeps({
    editInteractiveMessage: async (_chat, _message, _text, _mode, markup) => {
      editedMarkup = markup;
    },
  });
  await handleTelegramSectionCallback(
    registry,
    "0",
    "toggle",
    "off",
    123,
    456,
    "cb-id",
    deps,
  );
  const markup = editedMarkup as {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
  };
  assert.equal(markup.inline_keyboard[0][0].text, "⬆️ Back");
  assert.equal(markup.inline_keyboard[0][0].callback_data, "settings:list");
});

test("handleTelegramSectionCallback answers when no handler exists", async () => {
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "A"));
  let answered = false;
  const deps = stubDeps({
    answerCallbackQuery: async () => {
      answered = true;
    },
  });
  const handled = await handleTelegramSectionCallback(
    registry,
    "0",
    "act",
    "",
    123,
    456,
    "cb-id",
    deps,
  );
  assert.equal(handled, true);
  assert.equal(answered, true);
});

test("handleTelegramSectionCallback handles stale token", async () => {
  const registry = createTelegramExtensionSectionRegistry();
  let answeredText = "";
  const deps = stubDeps({
    answerCallbackQuery: async (_id, text) => {
      answeredText = text ?? "";
    },
  });
  const handled = await handleTelegramSectionCallback(
    registry,
    "99",
    "act",
    "",
    123,
    456,
    "cb-id",
    deps,
  );
  assert.equal(handled, true);
  assert.ok(answeredText.includes("no longer available"));
});

// --- Section Settings Open ---

test("handleTelegramSectionSettingsOpen renders settings view", async () => {
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(
    stubSection("@test/a", "A", {
      settings: {
        label: "⚙️ A Settings",
        open: async () => ({
          text: "<b>Settings for A</b>",
          parseMode: "html",
        }),
      },
    }),
  );
  let editedText = "";
  const deps = stubDeps({
    editInteractiveMessage: async (_a, _b, text) => {
      editedText = text;
    },
  });
  const handled = await handleTelegramSectionSettingsOpen(
    registry,
    "0",
    123,
    456,
    "cb-id",
    deps,
  );
  assert.equal(handled, true);
  assert.equal(editedText, "<b>Settings for A</b>");
});

test("handleTelegramSectionSettingsOpen handles section without settings gracefully", async () => {
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "A"));
  let answeredText = "";
  const deps = stubDeps({
    answerCallbackQuery: async (_id, text) => {
      answeredText = text ?? "";
    },
  });
  const handled = await handleTelegramSectionSettingsOpen(
    registry,
    "0",
    123,
    456,
    "cb-id",
    deps,
  );
  assert.equal(handled, true);
  assert.ok(answeredText.includes("no longer available"));
});

// --- Integration: menu-status rows ---

test("buildStatusReplyMarkup includes extension section rows before Settings", async () => {
  // Import dynamically to avoid circular deps in test
  const { buildStatusReplyMarkup } = await import("../lib/menu-status.ts");
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(stubSection("@test/a", "Explorer"));
  registry.register(
    stubSection("@test/b", "Status", {
      getLabel: () => "🟢 Status",
    }),
  );

  const markup = buildStatusReplyMarkup(undefined, "off" as never, 0, registry);
  const rows = markup.inline_keyboard;

  // Find the Settings row index
  const settingsIdx = rows.findIndex(
    (r) => r[0].callback_data === "menu:settings",
  );
  assert.ok(settingsIdx > 0);
  // Queue should be before section rows
  assert.equal(rows[settingsIdx - 3][0].text, "⌛ Queue: 0");
  // Section rows injected between Queue and Settings
  assert.equal(rows[settingsIdx - 2][0].text, "Explorer");
  assert.equal(rows[settingsIdx - 2][0].callback_data, "section:0:open");
  assert.equal(rows[settingsIdx - 1][0].text, "🟢 Status");
  assert.equal(rows[settingsIdx - 1][0].callback_data, "section:1:open");
});

// --- Integration: menu-settings rows ---

test("buildTelegramSettingsMenuReplyMarkup injects extension settings rows", async () => {
  const { buildTelegramSettingsMenuReplyMarkup } =
    await import("../lib/menu-settings.ts");
  const registry = createTelegramExtensionSectionRegistry();
  registry.register(
    stubSection("@test/a", "A", {
      settings: {
        label: "🔧 Extension A",
        open: async () => ({ text: "A settings" }),
      },
    }),
  );

  const markup = buildTelegramSettingsMenuReplyMarkup(
    false,
    false,
    "manual",
    "hidden",
    registry,
  );
  const rows = markup.inline_keyboard;

  // First row: Main menu back
  assert.equal(rows[0][0].callback_data, "menu:back");
  // Second row: extension settings
  assert.equal(rows[1][0].text, "🔧 Extension A");
  assert.ok(rows[1][0].callback_data.startsWith("section:"));
  // Built-in rows follow extension settings
  assert.ok(rows[2][0].text.includes("Voice reply"));
  assert.ok(rows[3][0].text.includes("Time"));
  assert.ok(rows[4][0].text.includes("Rich drafts"));
  assert.ok(rows[5][0].text.includes("Proactive push"));
});
