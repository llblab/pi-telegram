/**
 * Explicit public SDK Artifact Delivery producer with one attempt per command.
 * Zones: pi agent, telegram
 * Load with Pi's -e option in the intended session, then invoke /telegram-artifact-smoke send.
 * Loading alone sends nothing. Never repeat an uncertain send to obtain a green receipt.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sendTelegramArtifact } from "@llblab/pi-telegram/delivery";

export default function telegramArtifactLiveAcceptance(pi: ExtensionAPI): void {
  let blocked = false;
  let activeLifetime: AbortController | undefined;
  pi.on("session_shutdown", () => { activeLifetime?.abort(); });
  pi.registerCommand("telegram-artifact-smoke", {
    description: "Send one harmless public SDK document to this instance's Telegram target",
    async handler(args, ctx) {
      if (args.trim() !== "send") {
        ctx.ui.notify("Usage: /telegram-artifact-smoke send. Sends one harmless test document to this instance's target.", "info");
        return;
      }
      if (blocked) {
        ctx.ui.notify("Previous live attempt is active or unresolved. Inspect its receipt; do not resend.", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Let the current agent turn and queued work settle before live acceptance.", "warning");
        return;
      }
      blocked = true;
      const lifetime = new AbortController();
      activeLifetime = lifetime;
      const sessionId = ctx.sessionManager.getSessionId();
      const operationId = randomUUID();
      const directory = mkdtempSync(join(tmpdir(), "pi-telegram-artifact-live-"));
      const name = `telegram-artifact-${operationId}.txt`;
      const path = join(directory, name);
      writeFileSync(path, `Harmless pi-telegram SDK Artifact Delivery live acceptance document.\nOperation: ${operationId}\n`, { mode: 0o600, flag: "wx" });
      const startedAt = new Date().toISOString();
      const result = await sendTelegramArtifact({
        owner: "@llblab/pi-telegram/live-artifact-acceptance",
        scope: { kind: "instance" },
        file: { path, name },
        caption: "SDK Artifact Delivery live acceptance: harmless test document.",
        timeoutMs: 30_000,
        signal: lifetime.signal,
      });
      const report = join(directory, "receipt.json");
      // Retain the source on every outcome: a public terminal result need not mean native I/O drained.
      try {
        writeFileSync(report, JSON.stringify({ operationId, sessionId, pid: process.pid, startedAt,
          endedAt: new Date().toISOString(), source: { path, name }, result }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      } catch (receiptWriteError) {
        throw new Error("Live receipt persistence failed after the SDK returned. Inspect the retained outcome; do not resend.",
          { cause: { artifactResult: result, receiptWriteError } });
      }
      activeLifetime = undefined;
      if (lifetime.signal.aborted) return;
      ctx.ui.notify(result.ok
        ? `SDK document acknowledged. Receipt: ${report}`
        : `SDK document outcome: ${result.reason} (${result.effect}). No retry. Receipt: ${report}`,
      result.ok ? "info" : "warning");
      // Only a persisted, reported success permits a new explicit operation with a fresh UUID.
      if (result.ok) blocked = false;
    },
  });
}
