/**
 * Operator-only offline cutover for a single installed agent's Telegram runtime state.
 * Zones: maintenance tooling, telegram
 */
import { isAbsolute, resolve } from "node:path";
import { prepareTelegramRuntimeStateColdCutover } from "../dist/lib/locks.js";

const [pathFlag, agentDir, agreement, ...extra] = process.argv.slice(2);
if (pathFlag !== "--agent-dir" || !agentDir || !isAbsolute(agentDir) || resolve(agentDir) !== agentDir ||
    agreement !== "--confirm-all-writers-stopped" || extra.length) {
  console.error("Usage: node prepare-cold-cutover.mjs --agent-dir <absolute-path> --confirm-all-writers-stopped");
  console.error("First stop all processes that can write this agent's Telegram state, and keep old versions stopped.");
  process.exitCode = 2;
} else {
  try {
    prepareTelegramRuntimeStateColdCutover(agentDir);
    console.log("Telegram cold cutover prepared. Start only updated Pi processes and run /telegram-connect. No connection was started.");
  } catch (error) {
    console.error(`Telegram cold cutover not confirmed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
