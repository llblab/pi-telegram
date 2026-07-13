# `/reload` Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/reload` pi-side command to pi-telegram that calls `ctx.reload()` so changes to extensions/skills/prompts/themes/context-files apply live over Telegram without restarting the bridge.

**Architecture:** One new `pi.registerCommand("reload", ...)` registration in `registerTelegramBridgeCommands` (`lib/commands.ts`), sibling to `telegram-setup|status|connect|disconnect`. `/reload` is intentionally NOT added to `TELEGRAM_RESERVED_COMMAND_NAMES`, so pi-telegram's command runtime ignores it as a control and passes it through to pi, which resolves the registered handler in an `ExtensionCommandContext` exposing `ctx.reload()`. pi's turn-serial model queues it after any in-flight turn (Option B).

**Tech Stack:** TypeScript (run via `node --experimental-strip-types`), `node:test` + `node:assert/strict`. Verify with `npm run validate` (typecheck + tests + audit + pack:check).

**Spec:** `docs/superpowers/specs/2026-07-13-reload-command-design.md`
**Upstream issue:** llblab/pi-telegram#124

## Global Constraints

- Follow existing command registration pattern verbatim (`lib/commands.ts:346-420`).
- Follow existing test harness in `tests/commands.test.ts` (`createCommandRegistrationApiHarness`, `createBridgeCommandContext`).
- Do NOT touch `TELEGRAM_RESERVED_COMMAND_NAMES`, `TELEGRAM_COMMAND_ACTIONS`, or the bot menu — `/reload` is a pass-through pi command, not an immediate control.
- `ctx.reload()` is confirmed on `ExtensionCommandContext` (pi-core `dist/index.d.ts`).
- One commit per task; conventional-commit messages.

---

### Task 1: `/reload` command (TDD)

**Files:**
- Modify: `lib/commands.ts` (add registration after `telegram-disconnect`, ~L420, before the closing `}`)
- Modify: `tests/commands.test.ts` (extend `createBridgeCommandContext` with optional `reload`; add reload tests)

**Interfaces:**
- Consumes: `ExtensionCommandContext.reload(): Promise<void>` (pi-core), `ExtensionCommandContext.ui.notify(message, level)`
- Produces: a registered command named `reload` with handler `(args, ctx) => Promise<void>` that calls `ctx.reload()` and notifies.

- [ ] **Step 1: Extend test helper with optional `reload`**

In `tests/commands.test.ts`, change `createBridgeCommandContext` to accept an optional `reload`:

```ts
function createBridgeCommandContext(
  notify: (message: string, level?: string) => void = () => {},
  confirm: () => Promise<boolean> | boolean = () => false,
  select?: (title: string, items: string[]) => Promise<string | undefined>,
  reload: () => Promise<void> | void = () => {},
): ExtensionCommandContext {
  return {
    cwd: "/repo",
    reload,
    ui: {
      notify,
      confirm,
      select,
      theme: {
        fg: (_color: string, value: string) => value,
      },
    },
  } as unknown as ExtensionCommandContext;
}
```

- [ ] **Step 2: Write failing tests (registration + success + failure)**

Append to `tests/commands.test.ts`:

```ts
test("Command helpers register pi reload command that reloads runtime and notifies", async () => {
  const harness = createCommandRegistrationApiHarness();
  const events: string[] = [];
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => {},
    getStatusLines: () => [],
    reloadConfig: async () => {},
    hasBotToken: () => false,
    startPolling: async () => {},
    stopPolling: async () => {},
    updateStatus: () => {},
  });
  const reloadCommand = getRequiredCommand(harness.commands, "reload");
  assert.ok(reloadCommand.description && reloadCommand.description.length > 0);

  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = createBridgeCommandContext(
    (message, level) => notifications.push({ message, level }),
    () => false,
    undefined,
    async () => {
      events.push("reload");
    },
  );
  await reloadCommand.handler("", ctx);
  assert.deepEqual(events, ["reload"]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "info");
});

test("Command helpers report reload errors without rethrowing", async () => {
  const harness = createCommandRegistrationApiHarness();
  registerTelegramBridgeCommands(harness.api, {
    promptForConfig: async () => {},
    getStatusLines: () => [],
    reloadConfig: async () => {},
    hasBotToken: () => false,
    startPolling: async () => {},
    stopPolling: async () => {},
    updateStatus: () => {},
  });
  const reloadCommand = getRequiredCommand(harness.commands, "reload");
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = createBridgeCommandContext(
    (message, level) => notifications.push({ message, level }),
    () => false,
    undefined,
    async () => {
      throw new Error("boom");
    },
  );
  await reloadCommand.handler("", ctx); // must not throw
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "error");
  assert.match(notifications[0].message, /boom/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd ~/projects/pi-telegram && npm test -- --test-name-pattern="reload" 2>&1 | tail -20` (or `node --experimental-strip-types --test tests/*.test.ts`)
Expected: FAIL — `getRequiredCommand` throws `Expected command reload` (not yet registered).

- [ ] **Step 4: Implement the command**

In `lib/commands.ts`, inside `registerTelegramBridgeCommands`, after the `telegram-disconnect` block (after its `});` and before the function's closing `}`), add:

```ts
  pi.registerCommand("reload", {
    description: "Reload pi runtime: extensions, skills, prompts, themes, and context files",
    handler: async (_args, ctx) => {
      try {
        await ctx.reload();
        ctx.ui.notify(
          "Reloaded extensions, skills, prompts, themes, and context files.",
          "info",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Reload failed: ${message}`, "error");
      }
    },
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/projects/pi-telegram && node --experimental-strip-types --test tests/commands.test.ts 2>&1 | tail -15`
Expected: PASS (all command tests, including the two new reload tests).

- [ ] **Step 6: Commit**

```bash
cd ~/projects/pi-telegram
git add lib/commands.ts tests/commands.test.ts
git commit -m "feat(commands): add /reload command to reload pi runtime live"
```

---

### Task 2: CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md` (add new version heading + entry at top)

- [ ] **Step 1: Add entry**

Insert at the top of `CHANGELOG.md` (above `## 0.20.6`):

```markdown
## Unreleased

- `[Reload Command]` Added a `/reload` command that calls pi's `ctx.reload()` to reload extensions, skills, prompts, themes, and context files live from Telegram without restarting the bridge. Because pi serializes turns, `/reload` sent during an active turn runs after it completes. Success and failure surface through `ctx.ui.notify`. Impact: skill, prompt, context-file, and extension changes — including extension config such as `~/.pi/web-search.json` — can now be picked up over Telegram without dropping the connection or interrupting the current turn.
```

- [ ] **Step 2: Commit**

```bash
cd ~/projects/pi-telegram
git add CHANGELOG.md
git commit -m "docs(changelog): note /reload command"
```

---

### Task 3: Full validation gate

- [ ] **Step 1: Run the validate script**

Run: `cd ~/projects/pi-telegram && npm run validate 2>&1 | tail -30`
Expected: typecheck passes, all tests pass (existing suite + new), audit clean, pack:check clean.

- [ ] **Step 2: If anything fails, fix and re-run until green.**

---

## Definition of done

- `/reload` registered, dispatches to `ctx.reload()`, notifies on success/error, never throws out of the handler.
- New unit tests pass; `npm run validate` is fully green.
- Two commits on `feat/reload-command`: implementation (+tests) and CHANGELOG.
- Branch pushed to `pinion05/pi-telegram` (PR itself opened separately — out of scope of "until just before PR").
