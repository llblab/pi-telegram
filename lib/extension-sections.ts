/**
 * Telegram Extension Sections registry and callback routing
 * Zones: telegram ui, extension platform, callback routing
 * Owns section registration, token mapping, main-menu/settings row injection, and section callback dispatch
 */

import type { TelegramInlineKeyboardMarkup } from "./keyboard.ts";

import {
  SECTION_REGISTRY_KEY,
  VOICE_EVENT_RECORDER_KEY,
} from "./globals.ts";

// --- Core Types ---

/** @internal */
export type TelegramSectionId = string;

/** @internal */
export type TelegramSectionToken = string;

/** @internal */
export type TelegramSectionCallbackResult = "handled" | "pass";

export interface TelegramSectionView {
  text: string;
  parseMode?: "html" | "plain";
  replyMarkup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramSectionSettingsRegistration {
  label: string;
  order?: number;
  getLabel?: () => string;
  open: (
    ctx: TelegramSectionContext,
  ) => TelegramSectionView | Promise<TelegramSectionView>;
  handleCallback?: (
    ctx: TelegramSectionCallbackContext,
  ) => TelegramSectionCallbackResult | Promise<TelegramSectionCallbackResult>;
}

export interface TelegramSectionRegistration {
  id: TelegramSectionId;
  label: string;
  order?: number;
  render: (
    ctx: TelegramSectionContext,
  ) => TelegramSectionView | Promise<TelegramSectionView>;
  handleCallback?: (
    ctx: TelegramSectionCallbackContext,
  ) => TelegramSectionCallbackResult | Promise<TelegramSectionCallbackResult>;
  settings?: TelegramSectionSettingsRegistration;
}

export interface TelegramSectionContext {
  sectionId: string;
  chatId: number;
  messageId?: number;
  answerCallback(text?: string): Promise<void>;
  edit(view: TelegramSectionView): Promise<void>;
  open(view: TelegramSectionView): Promise<void>;
  enqueuePrompt(prompt: string): Promise<void>;
  callbackData(action: string, payload?: string): string;
  /** Delete the message that triggered this callback (dialog cleanup) */
  deleteMessage(): Promise<void>;
}

export interface TelegramSectionCallbackContext {
  sectionId: string;
  chatId: number;
  messageId?: number;
  action: string;
  payload: string;
  answerCallback(text?: string): Promise<void>;
  edit(view: TelegramSectionView): Promise<void>;
  open(view: TelegramSectionView): Promise<void>;
  enqueuePrompt(prompt: string): Promise<void>;
  callbackData(action: string, payload?: string): string;
  /** Delete the message that triggered this callback (dialog cleanup) */
  deleteMessage(): Promise<void>;
}

/** @internal */
export interface RegisteredTelegramSection {
  id: TelegramSectionId;
  token: TelegramSectionToken;
  label: string;
  order: number;
  registration: TelegramSectionRegistration;
}

/** @internal */
export interface TelegramSectionDiagnostic {
  id: TelegramSectionId;
  token: TelegramSectionToken;
  label: string;
  status: "active" | "stale" | "error";
  lastError?: string;
}

/** @internal */
export interface TelegramSectionRegistry {
  register(section: TelegramSectionRegistration): () => void;
  getSections(): RegisteredTelegramSection[];
  getByToken(
    token: TelegramSectionToken,
  ): RegisteredTelegramSection | undefined;
  getDiagnostics(): TelegramSectionDiagnostic[];
  clear(): void;
}

/** @internal */
export interface TelegramSectionMainMenuRow {
  text: string;
  callback_data: string;
}

/** @internal */
export interface TelegramSectionSettingsRow {
  label: string;
  callback_data: string;
}

// --- Runtime Port Builders ---

/** @internal */
export interface TelegramSectionRuntimeDeps {
  answerCallbackQuery: (id: string, text?: string) => Promise<void>;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "html" | "plain",
    replyMarkup: TelegramInlineKeyboardMarkup,
  ) => Promise<void>;
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "html" | "plain",
    replyMarkup: TelegramInlineKeyboardMarkup,
  ) => Promise<number | undefined>;
  enqueuePrompt: (prompt: string) => Promise<void>;
  deleteMessage: (chatId: number, messageId: number) => Promise<void>;
}

function buildTelegramSectionContext(
  sectionId: string,
  token: TelegramSectionToken,
  chatId: number,
  messageId: number | undefined,
  callbackQueryId: string | undefined,
  deps: TelegramSectionRuntimeDeps,
  backCallback = "menu:back",
  backLabel = "⬆️ Main menu",
): TelegramSectionContext {
  return {
    sectionId,
    chatId,
    messageId,
    answerCallback: (text) =>
      callbackQueryId
        ? deps.answerCallbackQuery(callbackQueryId, text)
        : Promise.resolve(),
    edit: (view) =>
      messageId !== undefined
        ? deps.editInteractiveMessage(
            chatId,
            messageId,
            view.text,
            view.parseMode ?? "html",
            prependBackRow(view.replyMarkup, backCallback, backLabel),
          )
        : Promise.resolve(),
    open: (view) =>
      deps
        .sendInteractiveMessage(
          chatId,
          view.text,
          view.parseMode ?? "html",
          view.replyMarkup ?? { inline_keyboard: [] },
        )
        .then(() => {}),
    enqueuePrompt: deps.enqueuePrompt,
    callbackData: (action, payload) =>
      payload
        ? `section:${token}:${action}:${payload}`
        : `section:${token}:${action}`,
    deleteMessage: () =>
      messageId !== undefined
        ? deps.deleteMessage(chatId, messageId)
        : Promise.resolve(),
  };
}

function buildTelegramSectionCallbackContext(
  sectionId: string,
  token: TelegramSectionToken,
  chatId: number,
  messageId: number | undefined,
  action: string,
  payload: string,
  callbackQueryId: string,
  deps: TelegramSectionRuntimeDeps,
  backCallback = "menu:back",
  backLabel = "⬆️ Back",
): TelegramSectionCallbackContext {
  return {
    sectionId,
    chatId,
    messageId,
    action,
    payload,
    answerCallback: (text) => deps.answerCallbackQuery(callbackQueryId, text),
    edit: (view) =>
      messageId !== undefined
        ? deps.editInteractiveMessage(
            chatId,
            messageId,
            view.text,
            view.parseMode ?? "html",
            prependBackRow(view.replyMarkup, backCallback, backLabel),
          )
        : Promise.resolve(),
    open: (view) =>
      deps
        .sendInteractiveMessage(
          chatId,
          view.text,
          view.parseMode ?? "html",
          view.replyMarkup ?? { inline_keyboard: [] },
        )
        .then(() => {}),
    enqueuePrompt: deps.enqueuePrompt,
    callbackData: (action, payload) =>
      payload
        ? `section:${token}:${action}:${payload}`
        : `section:${token}:${action}`,
    deleteMessage: () =>
      messageId !== undefined
        ? deps.deleteMessage(chatId, messageId)
        : Promise.resolve(),
  };
}

// --- GlobalThis Bridge ---

/** @internal */
export function setGlobalTelegramSectionRegistry(
  registry: TelegramSectionRegistry,
): void {
  globalThis[SECTION_REGISTRY_KEY] = registry;
}

/**
 * Register a Telegram Extension Section from any pi extension.
 * Returns a disposer. Throws if no section registry is active.
 *

 */
export function registerTelegramSection(
  section: TelegramSectionRegistration,
): () => void {
  const registry = globalThis[SECTION_REGISTRY_KEY];
  if (!registry) {
    // If no registry is ready yet, we simply can't register.
    // This should normally not happen in normal usage.
    try {
      const record = (globalThis as any)[VOICE_EVENT_RECORDER_KEY];
      if (typeof record === "function") {
        record("section-registration", new Error("Registry not ready yet"), {
          id: section.id,
        });
      }
    } catch {}

    return () => {};
  }

  return registry.register(section);
}

/**
 * Get current section diagnostics. Returns empty array when registry is absent.
 */
/** @internal */
export function getTelegramSectionDiagnostics(): TelegramSectionDiagnostic[] {
  const registry = globalThis[SECTION_REGISTRY_KEY];
  return registry ? registry.getDiagnostics() : [];
}

// --- Registry ---

const MAIN_MENU_ROW = {
  text: "⬆️ Main menu",
  callback_data: "menu:back",
} as const;

const BACK_NAV_ROW = {
  text: "⬆️ Back",
} as const;

function prependBackRow(
  replyMarkup: TelegramInlineKeyboardMarkup | undefined,
  backCallback: string,
  backLabel?: string,
): TelegramInlineKeyboardMarkup {
  const backRow = {
    text: backLabel ?? BACK_NAV_ROW.text,
    callback_data: backCallback,
  };
  if (!replyMarkup || replyMarkup.inline_keyboard.length === 0) {
    return { inline_keyboard: [[backRow]] };
  }
  const firstRow = replyMarkup.inline_keyboard[0];
  const firstIsBack =
    firstRow.length === 1 && firstRow[0].callback_data === backCallback;
  if (firstIsBack) return replyMarkup;
  return {
    inline_keyboard: [[backRow], ...replyMarkup.inline_keyboard],
  };
}

/** @internal */
export function createTelegramExtensionSectionRegistry(): TelegramSectionRegistry {
  const sections = new Map<TelegramSectionToken, RegisteredTelegramSection>();
  const errors = new Map<TelegramSectionToken, string>();
  let nextToken = 0;

  function register(section: TelegramSectionRegistration): () => void {
    const token = String(nextToken++);
    const registered: RegisteredTelegramSection = {
      id: section.id,
      token,
      label: section.label,
      order: section.order ?? 0,
      registration: section,
    };
    sections.set(token, registered);
    return () => {
      sections.delete(token);
      errors.delete(token);
    };
  }

  function getSections(): RegisteredTelegramSection[] {
    return [...sections.values()].sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.id.localeCompare(b.id);
    });
  }

  function getByToken(
    token: TelegramSectionToken,
  ): RegisteredTelegramSection | undefined {
    return sections.get(token);
  }

  function getDiagnostics(): TelegramSectionDiagnostic[] {
    return getSections().map((s) => ({
      id: s.id,
      token: s.token,
      label: s.label,
      status: errors.has(s.token) ? "error" : "active",
      lastError: errors.get(s.token),
    }));
  }

  function clear(): void {
    sections.clear();
    errors.clear();
    nextToken = 0;
  }

  return { register, getSections, getByToken, getDiagnostics, clear };
}

/** @internal */
export function getTelegramExtensionSettingsRows(
  registry: TelegramSectionRegistry,
): TelegramSectionSettingsRow[] {
  return registry
    .getSections()
    .filter((s) => s.registration.settings)
    .sort((a, b) => {
      const orderA = a.registration.settings!.order ?? 0;
      const orderB = b.registration.settings!.order ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      return a.id.localeCompare(b.id);
    })
    .map((s) => ({
      label:
        s.registration.settings!.getLabel?.() ?? s.registration.settings!.label,
      callback_data: `section:${s.token}:settings:open`,
    }));
}

/** @internal */
export function getTelegramSectionMainMenuRows(
  registry: TelegramSectionRegistry,
): TelegramSectionMainMenuRow[] {
  return registry.getSections().map((s) => ({
    text: s.label,
    callback_data: `section:${s.token}:open`,
  }));
}

/** @internal */
export function parseTelegramSectionCallback(
  data: string,
): { token: string; action: string; payload: string } | undefined {
  if (!data.startsWith("section:")) return undefined;
  const rest = data.slice("section:".length);
  const firstColon = rest.indexOf(":");
  if (firstColon === -1) return undefined;
  const token = rest.slice(0, firstColon);
  const afterToken = rest.slice(firstColon + 1);
  const secondColon = afterToken.indexOf(":");
  if (secondColon === -1) {
    return { token, action: afterToken, payload: "" };
  }
  return {
    token,
    action: afterToken.slice(0, secondColon),
    payload: afterToken.slice(secondColon + 1),
  };
}

/** @internal */
export interface TelegramSectionCallbackHandlerDeps {
  answerCallbackQuery: (id: string, text?: string) => Promise<void>;
  editInteractiveMessage: (
    chatId: number,
    messageId: number,
    text: string,
    mode: "html" | "plain",
    replyMarkup: TelegramInlineKeyboardMarkup,
  ) => Promise<void>;
  sendInteractiveMessage: (
    chatId: number,
    text: string,
    mode: "html" | "plain",
    replyMarkup: TelegramInlineKeyboardMarkup,
  ) => Promise<number | undefined>;
  enqueuePrompt: (prompt: string) => Promise<void>;
  deleteMessage: (chatId: number, messageId: number) => Promise<void>;
}

export async function handleTelegramSectionOpen(
  registry: TelegramSectionRegistry,
  token: TelegramSectionToken,
  chatId: number,
  messageId: number,
  callbackQueryId: string,
  deps: TelegramSectionCallbackHandlerDeps,
): Promise<boolean> {
  const section = registry.getByToken(token);
  if (!section) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "This section is no longer available.",
    );
    return true;
  }
  try {
    const sectionCtx = buildTelegramSectionContext(
      section.id,
      token,
      chatId,
      messageId,
      callbackQueryId,
      deps,
    );
    const view = await section.registration.render(sectionCtx);
    const viewWithBack = {
      ...view,
      replyMarkup: prependBackRow(
        view.replyMarkup,
        "menu:back",
        "⬆️ Main menu",
      ),
    };
    await deps.editInteractiveMessage(
      chatId,
      messageId,
      viewWithBack.text,
      viewWithBack.parseMode ?? "html",
      viewWithBack.replyMarkup,
    );
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.answerCallbackQuery(
      callbackQueryId,
      `Section error: ${message}`,
    );
    return true;
  }
}

export async function handleTelegramSectionCallback(
  registry: TelegramSectionRegistry,
  token: TelegramSectionToken,
  action: string,
  payload: string,
  chatId: number,
  messageId: number,
  callbackQueryId: string,
  deps: TelegramSectionCallbackHandlerDeps,
): Promise<boolean> {
  const section = registry.getByToken(token);
  if (!section) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "This section is no longer available.",
    );
    return true;
  }
  // Try main handleCallback first, then settings handleCallback as fallback
  const handler =
    section.registration.handleCallback ??
    section.registration.settings?.handleCallback;
  if (!handler) {
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  }
  try {
    const ctx = buildTelegramSectionCallbackContext(
      section.id,
      token,
      chatId,
      messageId,
      action,
      payload,
      callbackQueryId,
      deps,
      `section:${token}:open`,
    );
    let result = await handler(ctx);
    // Fallback: if main handler passed and settings handler exists, try settings
    // with the correct navigation context (back → settings list)
    if (
      result === "pass" &&
      handler !== section.registration.settings?.handleCallback &&
      section.registration.settings?.handleCallback
    ) {
      const settingsCtx = buildTelegramSectionCallbackContext(
        section.id,
        token,
        chatId,
        messageId,
        action,
        payload,
        callbackQueryId,
        deps,
        "settings:list",
      );
      result = await section.registration.settings.handleCallback(settingsCtx);
    }
    if (result === "pass") {
      await deps.answerCallbackQuery(callbackQueryId);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.answerCallbackQuery(
      callbackQueryId,
      `Section error: ${message}`,
    );
    return true;
  }
}

export async function handleTelegramSectionSettingsOpen(
  registry: TelegramSectionRegistry,
  token: TelegramSectionToken,
  chatId: number,
  messageId: number,
  callbackQueryId: string,
  deps: TelegramSectionCallbackHandlerDeps,
): Promise<boolean> {
  const section = registry.getByToken(token);
  if (!section || !section.registration.settings) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "This section is no longer available.",
    );
    return true;
  }
  try {
    const sectionCtx = buildTelegramSectionContext(
      section.id,
      token,
      chatId,
      messageId,
      callbackQueryId,
      deps,
      "settings:list",
      "⬆️ Back",
    );
    const view = await section.registration.settings.open(sectionCtx);
    const viewWithBack = {
      ...view,
      replyMarkup: prependBackRow(view.replyMarkup, "settings:list", "⬆️ Back"),
    };
    await deps.editInteractiveMessage(
      chatId,
      messageId,
      viewWithBack.text,
      viewWithBack.parseMode ?? "html",
      viewWithBack.replyMarkup,
    );
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.answerCallbackQuery(
      callbackQueryId,
      `Section error: ${message}`,
    );
    return true;
  }
}

export async function handleTelegramSectionSettingsCallback(
  registry: TelegramSectionRegistry,
  token: TelegramSectionToken,
  action: string,
  payload: string,
  chatId: number,
  messageId: number,
  callbackQueryId: string,
  deps: TelegramSectionCallbackHandlerDeps,
): Promise<boolean> {
  const section = registry.getByToken(token);
  if (!section || !section.registration.settings?.handleCallback) {
    await deps.answerCallbackQuery(
      callbackQueryId,
      "This section is no longer available.",
    );
    return true;
  }
  try {
    const ctx = buildTelegramSectionCallbackContext(
      section.id,
      token,
      chatId,
      messageId,
      action,
      payload,
      callbackQueryId,
      deps,
      `settings:list`,
    );
    const result = await section.registration.settings.handleCallback(ctx);
    if (result === "pass") {
      await deps.answerCallbackQuery(callbackQueryId);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.answerCallbackQuery(
      callbackQueryId,
      `Section error: ${message}`,
    );
    return true;
  }
}
