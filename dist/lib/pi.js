/**
 * pi SDK adapter boundary
 * Zones: pi agent sdk boundary, shared adapters
 * Owns direct pi SDK imports and exposes narrow bridge-facing helpers/types for the extension composition layer
 */
import { types } from "node:util";
function isPiRunMode(value) {
    return (value === "tui" || value === "rpc" || value === "json" || value === "print");
}
/** Pi rejects a context captured before session replacement with a stale-context error; this is not a domain failure. */
export function isPiStaleContextError(error) {
    return (error instanceof Error &&
        (error.message.includes("stale after session") ||
            error.message.includes("stale ctx")));
}
export function getExtensionContextMode(ctx) {
    const mode = typeof ctx === "object" && ctx !== null
        ? ctx.mode
        : undefined;
    return isPiRunMode(mode) ? mode : undefined;
}
export function isExtensionContextPassiveRunMode(ctx) {
    const mode = getExtensionContextMode(ctx);
    return mode === "print" || mode === "json";
}
export function canStartPollingInExtensionContext(ctx) {
    return !isExtensionContextPassiveRunMode(ctx);
}
export function formatPollingStartBlockedByRunMode(ctx) {
    const mode = getExtensionContextMode(ctx);
    return mode
        ? `Telegram polling is unavailable in Pi ${mode} mode. Use /telegram-connect from a long-lived Pi session.`
        : "Telegram polling is unavailable in this Pi run mode.";
}
export function getSessionCompactionReason(event) {
    const reason = event && typeof event === "object" && "reason" in event
        ? event.reason
        : undefined;
    return reason === "manual" || reason === "threshold" || reason === "overflow"
        ? reason
        : "unknown";
}
const COMMAND_PROVIDER_KEY = Symbol("original Pi command callable");
const commandProviderIsProxy = types.isProxy;
const commandProviderOwn = Object.getOwnPropertyDescriptor;
const commandProviderApply = Reflect.apply;
const commandProviderArray = Array.isArray;
function commandProviderData(value, key) {
    const descriptor = commandProviderOwn(value, key);
    // A native accessor descriptor has no own value; do not consult its prototype.
    return descriptor && commandProviderOwn(descriptor, "value")?.value;
}
const commandProviderUnavailable = () => new Error("Pi command provider callable is unavailable.");
class NativePiCommandProvider {
    #owner;
    assertCallable = () => {
        if (this.#owner.busy) {
            this.#owner.lost = true;
            throw commandProviderUnavailable();
        }
        this.#assertFields();
    };
    getCommands = () => {
        this.assertCallable();
        const owner = this.#owner;
        owner.busy = true;
        try {
            const value = commandProviderApply(owner.get, owner.api, []);
            this.#assertFields();
            if (!commandProviderArray(value))
                throw commandProviderUnavailable();
            return value;
        }
        catch (error) {
            owner.lost = true;
            throw error;
        }
        finally {
            owner.busy = false;
        }
    };
    constructor(key, api, get, ports, portGet, capture) {
        if (key !== COMMAND_PROVIDER_KEY)
            throw commandProviderUnavailable();
        this.#owner = { api, get, ports, portGet, capture, lost: false, busy: false };
        Object.freeze(this);
    }
    #assertFields() {
        const owner = this.#owner;
        if (owner.lost || commandProviderData(owner.api, "getCommands") !== owner.get ||
            commandProviderData(owner.ports, "getCommands") !== owner.portGet ||
            commandProviderData(owner.ports, "captureCommandProvider") !== owner.capture) {
            owner.lost = true;
            throw commandProviderUnavailable();
        }
    }
    static read(value, ports) {
        if (!value || typeof value !== "object" || !(#owner in value) || value.#owner.ports !== ports)
            return undefined;
        value.assertCallable();
        return value;
    }
}
const readNativePiCommandProvider = NativePiCommandProvider.read;
/** Intrinsic non-match probes no supplied DTO/receiver fields and does not revoke the genuine owner. */
export function readPiCommandProviderCapture(value, ports) {
    return readNativePiCommandProvider(value, ports);
}
export function createExtensionApiRuntimePorts(api, commandProvider) {
    const refusal = () => new TypeError("Original Pi command provider requires true and an own-data callable.");
    if (commandProvider !== undefined && commandProvider !== true)
        throw refusal();
    let original;
    if (commandProvider) {
        if (!api || typeof api !== "object" || commandProviderIsProxy(api))
            throw refusal();
        original = commandProviderData(api, "getCommands");
        if (typeof original !== "function" || commandProviderIsProxy(original))
            throw refusal();
    }
    const ports = {
        sendUserMessage: (content, options) => api.sendUserMessage(content, options),
        exec: (command, args, options) => api.exec(command, args, options),
        getCommands: () => api.getCommands(),
        getThinkingLevel: () => api.getThinkingLevel(),
        setThinkingLevel: (level) => api.setThinkingLevel(level),
        getActiveTools: () => api.getActiveTools(),
        setActiveTools: (names) => api.setActiveTools(names),
        setModel: (model) => api.setModel(model),
        registerCommand: (name, options) => api.registerCommand(name, options),
    };
    if (original) {
        const capture = () => readNativePiCommandProvider(provider, ports);
        const provider = new NativePiCommandProvider(COMMAND_PROVIDER_KEY, api, original, ports, ports.getCommands, capture);
        ports.captureCommandProvider = capture;
    }
    return ports;
}
function readEnabledModels(value) {
    if (value === undefined)
        return undefined;
    if (Array.isArray(value) &&
        value.every((entry) => typeof entry === "string")) {
        return [...value];
    }
    throw new TypeError("Host settings enabledModels must be a string array or undefined.");
}
export function normalizeSettingsManager(manager) {
    if (typeof manager !== "object" || manager === null) {
        throw new TypeError("Host settings manager must be an object.");
    }
    const host = manager;
    if (typeof host.flush !== "function") {
        throw new TypeError("Host settings manager must provide flush().");
    }
    const read = typeof host.getEnabledModels === "function"
        ? () => host.getEnabledModels.call(host)
        : typeof host.get === "function"
            ? () => host.get.call(host, "enabledModels")
            : undefined;
    const write = typeof host.setEnabledModels === "function"
        ? (patterns) => host.setEnabledModels.call(host, patterns)
        : typeof host.set === "function"
            ? (patterns) => host.set.call(host, "enabledModels", patterns ?? [])
            : undefined;
    if (!read || !write) {
        throw new TypeError("Host settings manager must provide enabled-model read and write capabilities.");
    }
    return {
        reload: async () => {
            await host.reload?.call(host);
        },
        flush: async () => {
            await host.flush.call(host);
        },
        getEnabledModels: () => readEnabledModels(read()),
        setEnabledModels: write,
    };
}
export async function createSettingsManager(cwd, hostFactory) {
    // Pi returns its legacy settings surface synchronously. Compatible hosts may
    // resolve a generic settings service asynchronously; normalize both once at
    // the SDK boundary instead of leaking host distinctions into menu domains.
    // The package entrypoint supplies its statically loader-mapped host export.
    // Standalone domain consumers retain lazy native resolution and cold imports.
    const factory = hostFactory ?? (await import("@earendil-works/pi-coding-agent")).SettingsManager;
    return normalizeSettingsManager(await factory.create(cwd));
}
export function createScopedModelPatternPersister(deps) {
    return async (patterns, ctx) => {
        const settingsManager = await deps.createSettingsManager(ctx.cwd);
        settingsManager.setEnabledModels(patterns.length > 0 ? patterns : undefined);
        await settingsManager.flush();
        deps.clearCachedModelMenuInputs();
    };
}
export function getExtensionContextModel(ctx) {
    return ctx.model;
}
export function getExtensionContextCwd(ctx) {
    return ctx.cwd;
}
export function getExtensionContextSessionId(ctx) {
    // Minimal hosts and stale contexts may omit a session manager; absence is not an invented ID.
    return ctx?.sessionManager?.getSessionId?.();
}
export function isExtensionContextIdle(ctx) {
    return ctx.isIdle();
}
export function isExtensionContextAbortRequested(ctx) {
    return ctx.signal?.aborted === true;
}
export function hasExtensionContextPendingMessages(ctx) {
    return ctx.hasPendingMessages();
}
export function compactExtensionContext(ctx, callbacks) {
    return ctx.compact(callbacks);
}
