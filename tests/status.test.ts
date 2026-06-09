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
  clearTelegramStatusLineProviders,
  createTelegramBridgeStatusRuntime,
  createTelegramRuntimeEventRecorder,
  createTelegramStatusHtmlBuilder,
  createTelegramStatusRuntime,
  getTelegramStatusBarProcessingStatus,
  recordStructuredTelegramRuntimeEvent,
  recordTelegramRuntimeEvent,
  registerTelegramStatusLineProvider,
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
      queuedStatus: " +1",
    }),
    "<accent>telegram</accent> <warning>active</warning><success> +1</success>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: false,
      processing: true,
      processingStatus: "dispatching",
      queuedStatus: " +1",
    }),
    "<accent>telegram</accent> <warning>active</warning><success> +1</success>",
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
      compactionInProgress: true,
      processing: false,
      queuedStatus: "",
    }),
    "<accent>telegram</accent> <warning>compacting</warning>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: false,
      paired: true,
      compactionInProgress: false,
      processing: true,
      processingStatus: "queued",
      queuedStatus: " +2",
    }),
    "<accent>telegram</accent> <muted>disconnected</muted><success> +2</success>",
  );
  assert.equal(
    buildTelegramStatusBarText(theme, {
      hasBotToken: true,
      pollingActive: true,
      paired: false,
      compactionInProgress: false,
      processing: true,
      processingStatus: "queued",
      queuedStatus: " +1",
    }),
    "<accent>telegram</accent> <warning>awaiting pairing</warning><success> +1</success>",
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

test("Status runtime propagates status update failures to safety wrappers", () => {
  const runtime = createTelegramStatusRuntime({
    getStatusBarState: () => ({
      hasBotToken: true,
      pollingActive: true,
      paired: true,
      compactionInProgress: false,
      processing: false,
      queuedStatus: "",
    }),
    getBridgeStatusLineState: () => ({
      botUsername: undefined,
      allowedUserId: undefined,
      pollingActive: false,
      lastUpdateId: undefined,
      pendingDispatch: false,
      compactionInProgress: false,
      activeToolExecutions: 0,
      pendingModelSwitch: false,
      queuedItems: [],
      recentRuntimeEvents: [],
    }),
  });
  assert.throws(
    () =>
      runtime.updateStatus({
        ui: {
          theme: { fg: (_token: string, text: string) => text },
          setStatus: () => {
            throw new Error("ctx is stale after session reload");
          },
        },
      }),
    /stale after session/,
  );
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
    "active",
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

test("Bridge status runtime stays active while tools run after queue changes", () => {
  const events: string[] = [];
  const runtime = createTelegramBridgeStatusRuntime({
    getConfig: () => ({
      botToken: "token",
      botUsername: "demo_bot",
      allowedUserId: 7,
    }),
    isPollingActive: () => true,
    getActiveSourceMessageIds: () => undefined,
    hasActiveTurn: () => false,
    hasDispatchPending: () => false,
    isCompactionInProgress: () => false,
    getActiveToolExecutions: () => 1,
    hasPendingModelSwitch: () => false,
    getQueuedItems: () => [],
    formatQueuedStatus: () => "",
    getRecentRuntimeEvents: () => [],
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
    "telegram:<accent>telegram</accent> <warning>active</warning>",
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
    formatQueuedStatus: () => " +1",
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
    "telegram:<accent>telegram</accent> <warning>active</warning><success> +1</success>",
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
    "- summary: api=1",
    "- 1970-01-01T00:00:01.000Z api: ok",
  ]);
});

test("Bridge status lines distinguish unknown bot identity from missing config", () => {
  const base = {
    allowedUserId: 42,
    pollingActive: true,
    lastUpdateId: 100,
    pendingDispatch: false,
    compactionInProgress: false,
    activeToolExecutions: 0,
    pendingModelSwitch: false,
    queuedItems: [],
    recentRuntimeEvents: [],
  };
  assert.equal(
    buildTelegramBridgeStatusLines({ ...base, hasBotToken: true })[1],
    "- bot: unknown",
  );
  assert.equal(
    buildTelegramBridgeStatusLines({ ...base, hasBotToken: false })[1],
    "- bot: not configured",
  );
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
    "- summary: api:sendMessage=1",
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

test("Status HTML builder includes companion status lines", () => {
  clearTelegramStatusLineProviders();
  const unregisterCodex = registerTelegramStatusLineProvider(
    ({ activeModel }) =>
      activeModel?.contextWindow === 1000
        ? { label: "codex", value: "████ 23.7h" }
        : undefined,
    { id: "@scope/codex" },
  );
  const unregisterBroken = registerTelegramStatusLineProvider(
    () => {
      throw new Error("optional provider failed");
    },
    { id: "@scope/broken" },
  );
  try {
    const buildStatusHtml = createTelegramStatusHtmlBuilder({
      getActiveModel: () => ({ contextWindow: 1000 }),
    });
    const html = buildStatusHtml({
      sessionManager: { getEntries: () => [] },
      getContextUsage: () => ({ percent: 0, contextWindow: undefined }),
      isIdle: () => true,
      modelRegistry: { isUsingOAuth: () => false },
    });
    assert.match(html, /Context.*0\.0%\/1\.0k/s);
    assert.match(html, /Codex.*████ 23\.7h/s);
  } finally {
    unregisterCodex();
    unregisterBroken();
    clearTelegramStatusLineProviders();
  }
});

test("Status HTML builder shows compacting while compact is running", () => {
  const buildStatusHtml = createTelegramStatusHtmlBuilder({
    getActiveModel: () => undefined,
    isCompactionInProgress: () => true,
  });
  const html = buildStatusHtml({
    sessionManager: { getEntries: () => [] },
    getContextUsage: () => ({ percent: 0, contextWindow: 1000 }),
    isIdle: () => true,
    modelRegistry: { isUsingOAuth: () => false },
  });
  assert.match(html, /Status.*compacting/s);
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
      "- summary: api:sendMessage=1, poll=1",
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
    "- summary: api:sendMessage=1",
    '- 1970-01-01T00:00:01.000Z api:sendMessage: token <redacted-token> failed (token="<redacted-token>", retryable=true)',
  ]);
});

test("Runtime event recording bounds messages and string details", () => {
  const events: TelegramRuntimeEvent[] = [];
  recordStructuredTelegramRuntimeEvent(
    events,
    {
      category: "handler",
      error: new Error("x".repeat(1200)),
      details: { output: "y".repeat(1200) },
    },
    { maxEvents: 3, now: 1000 },
  );

  assert.equal(events[0]?.message.length, 1023);
  assert.match(events[0]?.message ?? "", /truncated 200 chars/);
  assert.equal(String(events[0]?.details?.output).length, 1023);
  assert.match(String(events[0]?.details?.output), /truncated 200 chars/);
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
