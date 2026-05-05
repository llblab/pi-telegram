/**
 * Regression tests for Telegram status helpers
 * Covers runtime diagnostics lines and recent-event redaction/ring-buffer behavior
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTelegramBridgeStatusLines,
  buildTelegramRuntimeEventLines,
  buildTelegramStatusBarText,
  createTelegramBridgeStatusRuntime,
  createTelegramRuntimeEventRecorder,
  createTelegramStatusHtmlBuilder,
  createTelegramStatusRuntime,
  getTelegramStatusBarProcessingStatus,
  recordStructuredTelegramRuntimeEvent,
  recordTelegramRuntimeEvent,
  type TelegramRuntimeEvent,
} from "../lib/status.ts";

test("Status bar text renders bridge connection and queue states", () => {
  const theme = {
    fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
  };
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: false,
      pollingActive: false,
      paired: false,
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
    }),
    "<accent>telegram</accent> <muted>not configured</muted>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: false,
      processing: true,
      queuedStatus: " +1: [next]",
    }),
    "<accent>telegram</accent> <accent>processing</accent><muted> +1: [next]</muted>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: false,
      processing: true,
      processingStatus: "dispatching",
      queuedStatus: " +1: [next]",
    }),
    "<accent>telegram</accent> <accent>dispatching</accent><muted> +1: [next]</muted>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: false,
      processing: true,
      processingStatus: "active",
      queuedStatus: "",
    }),
    "<accent>telegram</accent> <warning>active</warning>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
      error: "typing failed",
    }),
    "<accent>telegram</accent> <error>error</error> <muted>typing failed</muted>",
  );
});

test("Status runtime updates the status bar and exposes bridge lines", () => {
  const events: string[] = [];
  const ctx = {
    ui: {
      theme: {
        fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
      },
      setStatus: (key: string, text: string) => {
        events.push(`${key}:${text}`);
      },
    },
  };
  const runtime = createTelegramStatusRuntime({
    getStatusBarState: (_ctx, error) => ({
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
      error,
    }),
    getBridgeStatusLineState: () => ({
      botUsername: "demo_bot",
      allowedUserId: 7,
      lockState: "active here",
      pollingActive: true,
      lastUpdateId: 10,
      pendingDispatch: false,
      compactionInProgress: false,
      activeToolExecutions: 0,
      pendingModelSwitch: false,
      queuedItems: [],
      recentRuntimeEvents: [],
    }),
  });
  runtime.updateStatus(ctx, "demo error");
  assert.equal(
    events[0],
    "telegram:<accent>telegram</accent> <error>error</error> <muted>demo error</muted>",
  );
  assert.deepEqual(runtime.getStatusLines().slice(0, 3), [
    "connection:",
    "- bot: @demo_bot",
    "- allowed user: 7",
  ]);
});

test("Status bar processing labels prefer the most specific live state", () => {
  assert.equal(
    getTelegramStatusBarProcessingStatus({
      hasActiveTurn: true,
      hasPendingDispatch: true,
      hasPendingModelSwitch: true,
      activeToolExecutions: 1,
      queuedItems: 1,
    }),
    "model",
  );
  assert.equal(
    getTelegramStatusBarProcessingStatus({
      hasActiveTurn: false,
      hasPendingDispatch: false,
      hasPendingModelSwitch: false,
      activeToolExecutions: 1,
      queuedItems: 1,
    }),
    "tool running",
  );
  assert.equal(
    getTelegramStatusBarProcessingStatus({
      hasActiveTurn: false,
      hasPendingDispatch: true,
      hasPendingModelSwitch: false,
      activeToolExecutions: 0,
      queuedItems: 1,
    }),
    "dispatching",
  );
  assert.equal(
    getTelegramStatusBarProcessingStatus({
      hasActiveTurn: false,
      hasPendingDispatch: false,
      hasPendingModelSwitch: false,
      activeToolExecutions: 0,
      queuedItems: 1,
    }),
    "queued",
  );
});

test("Bridge status runtime builds status state from live ports", () => {
  const events: string[] = [];
  const runtime = createTelegramBridgeStatusRuntime({
    getConfig: () => ({
      botToken: "token",
      botUsername: "demo_bot",
      allowedUserId: 7,
      lastUpdateId: 99,
    }),
    isPollingActive: () => true,
    getActiveSourceMessageIds: () => [1, 2],
    hasActiveTurn: () => false,
    hasDispatchPending: () => true,
    isCompactionInProgress: () => false,
    getActiveToolExecutions: () => 3,
    hasPendingModelSwitch: () => true,
    getQueuedItems: () => [{ queueLane: "control" as const }],
    formatQueuedStatus: () => " +1: [⚡ status]",
    getRecentRuntimeEvents: () => [
      { at: 1000, category: "api", message: "ok" },
    ],
    getRuntimeLockState: () => "active here",
  });
  runtime.updateStatus({
    ui: {
      theme: {
        fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
      },
      setStatus: (key: string, text: string) => {
        events.push(`${key}:${text}`);
      },
    },
  });
  assert.equal(
    events[0],
    "telegram:<accent>telegram</accent> <accent>model</accent><muted> +1: [⚡ status]</muted>",
  );
  assert.deepEqual(runtime.getStatusLines(), [
    "connection:",
    "- bot: @demo_bot",
    "- allowed user: 7",
    "- owner: active here",
    "",
    "polling:",
    "- state: running",
    "- last update id: 99",
    "",
    "execution:",
    "- active turn: 1,2",
    "- pending dispatch: yes",
    "- compaction: idle",
    "- active tools: 3",
    "- pending model switch: yes",
    "",
    "queue:",
    "- queued turns: 1",
    "- lanes: control=1, priority=0, default=0",
    "",
    "recent runtime events:",
    "- 1970-01-01T00:00:01.000Z api: ok",
  ]);
});

test("Bridge status lines include queue lanes and recent runtime events", () => {
  const lines = buildTelegramBridgeStatusLines({
    botUsername: "demo_bot",
    allowedUserId: 42,
    pollingActive: true,
    lastUpdateId: 100,
    activeSourceMessageIds: [7, 8],
    pendingDispatch: true,
    compactionInProgress: false,
    activeToolExecutions: 2,
    pendingModelSwitch: true,
    queuedItems: [
      { queueLane: "control" },
      { queueLane: "priority" },
      { queueLane: "default" },
      { queueLane: "default" },
    ],
    recentRuntimeEvents: [
      { at: 1, category: "api:sendMessage", message: "rate limited" },
    ],
  });
  assert.deepEqual(lines, [
    "connection:",
    "- bot: @demo_bot",
    "- allowed user: 42",
    "",
    "polling:",
    "- state: running",
    "- last update id: 100",
    "",
    "execution:",
    "- active turn: 7,8",
    "- pending dispatch: yes",
    "- compaction: idle",
    "- active tools: 2",
    "- pending model switch: yes",
    "",
    "queue:",
    "- queued turns: 4",
    "- lanes: control=1, priority=1, default=2",
    "",
    "recent runtime events:",
    "- 1970-01-01T00:00:00.001Z api:sendMessage: rate limited",
  ]);
});

test("Status HTML builder binds active model lookup", () => {
  const model = { provider: "openai", id: "gpt-5", contextWindow: 1000 };
  const buildStatusHtml = createTelegramStatusHtmlBuilder({
    getActiveModel: () => model,
  });
  const html = buildStatusHtml({
    sessionManager: { getEntries: () => [] },
    getContextUsage: () => ({ percent: 0, contextWindow: undefined }),
    isIdle: () => true,
    modelRegistry: { isUsingOAuth: () => false },
  });
  assert.match(html, /Status.*idle/s);
  assert.match(html, /Context.*0\.0%\/1\.0k/s);
});

test("Runtime event lines render the recent-event ring newest first", () => {
  assert.deepEqual(buildTelegramRuntimeEventLines([]), [
    "recent runtime events: none",
  ]);
  assert.deepEqual(
    buildTelegramRuntimeEventLines([
      { at: 0, category: "poll", message: "started" },
      { at: 1000, category: "api:sendMessage", message: "rate limited" },
    ]),
    [
      "recent runtime events:",
      "- 1970-01-01T00:00:01.000Z api:sendMessage: rate limited",
      "- 1970-01-01T00:00:00.000Z poll: started",
    ],
  );
});

test("Structured runtime event recording redacts messages and details", () => {
  const events: TelegramRuntimeEvent[] = [];
  recordStructuredTelegramRuntimeEvent(
    events,
    {
      category: "api",
      error: new Error("token 123:abc failed"),
      details: { method: "sendMessage", token: "123:abc", retryable: true },
    },
    { botToken: "123:abc", maxEvents: 3, now: 1000 },
  );
  assert.deepEqual(events, [
    {
      at: 1000,
      category: "api",
      message: "token <redacted-token> failed",
      details: {
        method: "sendMessage",
        token: "<redacted-token>",
        retryable: true,
      },
    },
  ]);
  assert.deepEqual(buildTelegramRuntimeEventLines(events), [
    "recent runtime events:",
    '- 1970-01-01T00:00:01.000Z api:sendMessage: token <redacted-token> failed (token="<redacted-token>", retryable=true)',
  ]);
});

test("Runtime event recorder owns redacted bounded event state", () => {
  const recorder = createTelegramRuntimeEventRecorder({
    getBotToken: () => "123:abc",
    maxEvents: 1,
    now: () => 1000,
  });
  recorder.record("api", new Error("token 123:abc failed"), {
    method: "sendMessage",
  });
  recorder.record("poll", "ok");
  assert.deepEqual(recorder.getEvents(), [
    { at: 1000, category: "poll", message: "ok" },
  ]);
  recorder.clear();
  assert.deepEqual(recorder.getEvents(), []);
});

test("Runtime event recording redacts bot tokens and keeps a bounded ring", () => {
  const events: TelegramRuntimeEvent[] = [];
  recordTelegramRuntimeEvent(events, "one", new Error("token 123:abc failed"), {
    botToken: "123:abc",
    maxEvents: 3,
    now: 1,
  });
  assert.deepEqual(events, [
    { at: 1, category: "one", message: "token <redacted-token> failed" },
  ]);
  recordTelegramRuntimeEvent(events, "two", "plain", {
    botToken: "123:abc",
    maxEvents: 3,
    now: 2,
  });
  recordTelegramRuntimeEvent(events, "three", "last", {
    botToken: "123:abc",
    maxEvents: 2,
    now: 3,
  });
  assert.deepEqual(events, [
    { at: 2, category: "two", message: "plain" },
    { at: 3, category: "three", message: "last" },
  ]);
});
