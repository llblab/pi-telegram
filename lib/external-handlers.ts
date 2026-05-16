/**
 * External Telegram handler registry
 * Zones: telegram transport, layered extension interop
 * Lets other pi extensions hook into the polling loop without owning their own getUpdates connection
 */

/**
 * Verdict returned by an interceptor.
 *
 * - `"consume"` — the interceptor handled this update; pi-telegram skips default routing.
 * - `"pass"` (or `void`/`undefined`) — pi-telegram routes the update normally.
 */
export type TelegramExternalHandlerVerdict = "consume" | "pass";

export type TelegramExternalHandler = (
  update: unknown,
) =>
  | TelegramExternalHandlerVerdict
  | void
  | Promise<TelegramExternalHandlerVerdict | void>;

export interface TelegramExternalHandlerRegistry {
  /** Schema version of this registry shape. */
  readonly version: 1;
  /**
   * Register an interceptor. Returns a disposer that removes it.
   *
   * Interceptors are invoked in registration order on every Telegram update,
   * before pi-telegram's own routing. The first interceptor that returns
   * `"consume"` wins and stops the chain for that update.
   */
  add: (handler: TelegramExternalHandler) => () => void;
  /**
   * Run all registered interceptors against an update.
   *
   * Used by pi-telegram's polling runtime; layered extensions should call
   * {@link onTelegramExternalUpdate} or `add` instead of dispatching directly.
   */
  dispatch: (update: unknown) => Promise<TelegramExternalHandlerVerdict>;
}

import { EXTERNAL_HANDLER_REGISTRY_KEY } from "./globals.ts";

const REGISTRY_KEY = EXTERNAL_HANDLER_REGISTRY_KEY;

/**
 * Validate that a value on `globalThis` matches the full v1 registry contract.
 *
 * pi-telegram's polling runtime invokes `dispatch`, so a partial object that
 * only carries `version` and `add` (which an early draft of the zero-coupling
 * docs showed) would silently break the first update. We treat any object
 * tagged `version === 1` but missing required methods as malformed and
 * replace it with a fresh, fully-formed registry. Layered extensions that
 * follow the full documented shape are unaffected; ones that don't lose any
 * handlers they registered against the malformed object, which is the
 * desired fail-loud-during-development behavior.
 */
function isValidV1Registry(
  candidate: unknown,
): candidate is TelegramExternalHandlerRegistry {
  if (!candidate || typeof candidate !== "object") return false;
  const r = candidate as Partial<TelegramExternalHandlerRegistry>;
  return (
    r.version === 1 &&
    typeof r.add === "function" &&
    typeof r.dispatch === "function"
  );
}

function getOrCreateRegistry(): TelegramExternalHandlerRegistry {
  const g = globalThis as Record<string, unknown>;
  const existing = g[REGISTRY_KEY];
  if (isValidV1Registry(existing)) return existing;
  const handlers = new Set<TelegramExternalHandler>();
  const registry: TelegramExternalHandlerRegistry = {
    version: 1,
    add(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async dispatch(update) {
      for (const handler of handlers) {
        try {
          const result = await handler(update);
          if (result === "consume") return "consume";
        } catch {
          // External handler errors must not break polling.
        }
      }
      return "pass";
    },
  };
  g[REGISTRY_KEY] = registry;
  return registry;
}

/**
 * Called by pi-telegram's own runtime to obtain the registry it dispatches
 * through. Layered extensions should not call this; use
 * {@link onTelegramExternalUpdate} instead.
 */
export function getTelegramExternalHandlerRegistry(): TelegramExternalHandlerRegistry {
  return getOrCreateRegistry();
}

export interface TelegramExternalHandlerWrapDeps<TUpdate, TContext> {
  defaultHandle: (update: TUpdate, ctx: TContext) => Promise<void>;
  registry?: TelegramExternalHandlerRegistry;
}
export type TelegramExternalInterceptorWrapDeps<TUpdate, TContext> =
  TelegramExternalHandlerWrapDeps<TUpdate, TContext>;

/**
 * Wrap a default polling `handleUpdate` with the external interceptor registry.
 *
 * Returned function dispatches `update` through registered interceptors first;
 * if any returns `"consume"`, default routing is skipped for that update.
 *
 * Composition-root callers (pi-telegram's `index.ts`) should use this builder
 * instead of writing the lifting logic inline.
 */
export function createTelegramExternalHandleUpdate<TUpdate, TContext>(
  deps: TelegramExternalHandlerWrapDeps<TUpdate, TContext>,
): (update: TUpdate, ctx: TContext) => Promise<void> {
  const registry = deps.registry ?? getOrCreateRegistry();
  const { defaultHandle } = deps;
  return async function handleInterceptedUpdate(update, ctx) {
    const verdict = await registry.dispatch(update);
    if (verdict === "consume") return;
    await defaultHandle(update, ctx);
  };
}

/**
 * Register an interceptor that runs before pi-telegram routes a Telegram
 * update through its built-in handlers (commands, app menu, queue menu,
 * model menu, default prompt routing).
 *
 * This is the recommended public surface for layered extensions that share
 * the same bot and pi process with pi-telegram (single bot ↔ single
 * `getUpdates` poller).
 *
 * Returns a disposer that removes the interceptor.
 *
 * @example
 * ```ts
 * import { onTelegramExternalUpdate } from "@llblab/pi-telegram/lib/external-handlers.ts";
 *
 * const off = onTelegramExternalUpdate(async (update) => {
 *   const cb = (update as { callback_query?: { data?: string } }).callback_query;
 *   if (!cb?.data?.startsWith("myext:")) return "pass";
 *   await handleMyCallback(cb);
 *   return "consume"; // skip pi-telegram's default routing for this update
 * });
 *
 * // later, e.g. on session shutdown:
 * off();
 * ```
 *
 * Extensions that prefer zero coupling can also reach the registry directly
 * via `globalThis[EXTERNAL_HANDLER_REGISTRY_KEY]` (versioned object,
 * see {@link TelegramExternalHandlerRegistry}). This avoids importing
 * `@llblab/pi-telegram` and tolerates either install order.
 */
export function onTelegramExternalUpdate(
  handler: TelegramExternalHandler,
): () => void {
  return getOrCreateRegistry().add(handler);
}
