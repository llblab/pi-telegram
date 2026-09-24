/**
 * Telegram bridge config and pairing helpers
 * Zones: telegram config, pairing, filesystem
 * Owns persisted bot/session pairing state, local config storage, live config controls, authorization policy, and first-user pairing side effects
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { resolveAgentDir, resolveTelegramConfigPath, TELEGRAM_DEFAULT_PROFILE_NAME, } from "./paths.js";
export { TELEGRAM_DEFAULT_PROFILE_NAME } from "./paths.js";
import { withTelegramFileTransaction } from "./locks.js";
const CONFIG_RUNTIME_KEY = "__piTelegramConfigRuntime__";
const CONFIG_REPLACE_RETRY_ATTEMPTS = 5;
const CONFIG_REPLACE_RETRY_DELAY_MS = 25;
function isRetryableConfigReplaceError(error) {
    const code = error?.code;
    return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}
function sleepConfigReplaceRetry(ms) {
    if (ms <= 0)
        return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function replaceTelegramConfigFile(tempPath, configPath) {
    for (let attempt = 0; attempt < CONFIG_REPLACE_RETRY_ATTEMPTS; attempt += 1) {
        try {
            renameSync(tempPath, configPath);
            return;
        }
        catch (error) {
            if (!isRetryableConfigReplaceError(error) ||
                attempt === CONFIG_REPLACE_RETRY_ATTEMPTS - 1) {
                throw error;
            }
            sleepConfigReplaceRetry(CONFIG_REPLACE_RETRY_DELAY_MS * (attempt + 1));
        }
    }
}
function getConfigPath() {
    return resolveTelegramConfigPath();
}
const TELEGRAM_BOT_TOKEN_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Parse a persisted bot-token value. `$NAME` and `${NAME}` are exact
 * environment-variable references. Any other `$`-prefixed value is malformed
 * rather than a literal secret so a broken reference fails closed.
 */
export function getTelegramBotTokenReference(value) {
    const trimmed = value?.trim();
    if (!trimmed)
        return undefined;
    if (!trimmed.startsWith("$"))
        return { kind: "literal", token: trimmed };
    const body = trimmed.startsWith("${") && trimmed.endsWith("}")
        ? trimmed.slice(2, -1)
        : trimmed.slice(1);
    return TELEGRAM_BOT_TOKEN_ENV_NAME_PATTERN.test(body)
        ? { kind: "environment", variable: body }
        : { kind: "malformed" };
}
/** Resolve a persisted token at a validation/activation boundary. */
export function resolveTelegramBotToken(value, env = process.env) {
    const reference = getTelegramBotTokenReference(value);
    if (reference?.kind === "literal")
        return reference.token;
    if (reference?.kind !== "environment")
        return undefined;
    return env[reference.variable]?.trim() || undefined;
}
/** Redacted diagnostic for an unresolved or malformed token reference. */
export function getTelegramBotTokenDiagnostic(value, env = process.env) {
    const reference = getTelegramBotTokenReference(value);
    if (reference?.kind === "malformed") {
        return "Telegram bot token environment reference is malformed; use $NAME or ${NAME}.";
    }
    if (reference?.kind !== "environment")
        return undefined;
    if (resolveTelegramBotToken(value, env))
        return undefined;
    return `Telegram bot token environment variable ${reference.variable} is not set.`;
}
const TELEGRAM_THREAD_DISPLAY_MODES = [
    "letters", "names", "directory-snake", "directory-title",
];
export function resolveTelegramThreadDisplayMode(config) {
    return TELEGRAM_THREAD_DISPLAY_MODES.includes(config.threadDisplayMode)
        ? config.threadDisplayMode
        : "letters";
}
export async function setTelegramThreadDisplayMode(store, mode, isCurrent) {
    if (!TELEGRAM_THREAD_DISPLAY_MODES.includes(mode)) {
        throw new Error("Invalid Telegram Thread display mode.");
    }
    const profile = store.getActiveProfileName();
    const current = () => isCurrent() && store.getActiveProfileName() === profile;
    if (!current())
        throw new Error("Telegram Thread display setting lost authority.");
    await store.load();
    if (!current() || !store.hasBotToken()) {
        throw new Error("Telegram Thread display setting lost its configured profile.");
    }
    await store.persist({ ...store.get(), threadDisplayMode: mode }, { isCurrent: current });
    if (!current())
        throw new Error("Telegram Thread display setting changed during persistence.");
}
/** Profile names must contain only lowercase ASCII letters and digits; max 32 chars. */
const TELEGRAM_PROFILE_NAME_PATTERN = /^[a-z0-9]{1,32}$/;
const TELEGRAM_RESERVED_PROFILE_NAMES = new Set([
    "main",
    "active",
]);
export function isValidTelegramProfileName(name) {
    return (TELEGRAM_PROFILE_NAME_PATTERN.test(name) &&
        !TELEGRAM_RESERVED_PROFILE_NAMES.has(name));
}
/** List defined profile names. */
export function getTelegramProfileNames(config) {
    return Object.keys(config.profiles ?? {}).sort();
}
export function createTelegramConfigBotIdGetter(store) {
    return () => store.get().botId;
}
export function createTelegramActiveProfileKeyGetter(store) {
    return () => store.getActiveProfileName() ?? TELEGRAM_DEFAULT_PROFILE_NAME;
}
export function setGlobalTelegramConfigRuntime(runtime) {
    const globals = globalThis;
    if (runtime)
        globals[CONFIG_RUNTIME_KEY] = runtime;
    else
        delete globals[CONFIG_RUNTIME_KEY];
}
export function updateTelegramVoiceConfig(voice) {
    const runtime = globalThis[CONFIG_RUNTIME_KEY];
    if (!runtime || typeof runtime.updateVoiceConfig !== "function")
        return false;
    runtime.updateVoiceConfig(voice);
    return true;
}
function isEmptyTelegramConfig(config) {
    return Object.keys(config).length === 0;
}
async function loadLatestTelegramConfig(configStore) {
    if (!configStore.load)
        return;
    const before = configStore.get();
    await configStore.load();
    if (!isEmptyTelegramConfig(before) &&
        isEmptyTelegramConfig(configStore.get())) {
        configStore.set(before);
    }
}
export function bindGlobalTelegramConfigRuntime(configStore) {
    setGlobalTelegramConfigRuntime({
        updateVoiceConfig(voice) {
            const current = configStore.get();
            const next = {
                ...current,
                voice: { ...(current.voice ?? {}), ...voice },
            };
            configStore.set(next);
            void configStore.persist(next);
        },
    });
}
function getInvalidTelegramConfigRecoveryPath(configPath) {
    return `${configPath}.invalid-${process.pid}-${Date.now()}`;
}
export async function readTelegramConfig(configPath, options = {}) {
    if (!existsSync(configPath))
        return {};
    const content = readFileSync(configPath, "utf8");
    try {
        return JSON.parse(content);
    }
    catch {
        // Atomic config publication makes ordinary reads safe without serialization.
        // Acquire the transaction only before destructive invalid-file recovery.
        return withTelegramFileTransaction(`${configPath}.transaction`, () => {
            if (!existsSync(configPath))
                return {};
            const identity = statSync(configPath);
            const currentContent = readFileSync(configPath, "utf8");
            try {
                return JSON.parse(currentContent);
            }
            catch (error) {
                const currentIdentity = statSync(configPath);
                if (currentIdentity.dev !== identity.dev ||
                    currentIdentity.ino !== identity.ino ||
                    currentIdentity.size !== identity.size ||
                    currentIdentity.mtimeMs !== identity.mtimeMs) {
                    throw new Error(`Telegram config changed while validating invalid content: ${configPath}`, { cause: error });
                }
                const recoveryPath = getInvalidTelegramConfigRecoveryPath(configPath);
                renameSync(configPath, recoveryPath);
                options.onInvalidConfig?.({ configPath, recoveryPath, error });
                return {};
            }
        });
    }
}
export async function writeTelegramConfig(agentDir, configPath, config) {
    await mkdir(agentDir, { recursive: true });
    const tempConfigPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempConfigPath, JSON.stringify(config, null, "\t") + "\n", {
        encoding: "utf8",
        mode: 0o600,
    });
    await chmod(tempConfigPath, 0o600);
    await rename(tempConfigPath, configPath);
    await chmod(configPath, 0o600);
}
function isPlainConfigRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function cloneTelegramConfig(value) {
    return structuredClone(value);
}
function configValuesEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function mergeTelegramConfigDelta(base, desired, latest) {
    const merged = cloneTelegramConfig(latest);
    for (const key of new Set([...Object.keys(base), ...Object.keys(desired)])) {
        const baseHas = Object.hasOwn(base, key);
        const desiredHas = Object.hasOwn(desired, key);
        const baseValue = base[key];
        const desiredValue = desired[key];
        if (baseHas === desiredHas && configValuesEqual(baseValue, desiredValue)) {
            continue;
        }
        if (!desiredHas) {
            delete merged[key];
            continue;
        }
        if (isPlainConfigRecord(desiredValue) &&
            (!baseHas || isPlainConfigRecord(baseValue))) {
            merged[key] = mergeTelegramConfigDelta(isPlainConfigRecord(baseValue) ? baseValue : {}, desiredValue, isPlainConfigRecord(merged[key]) ? merged[key] : {});
            continue;
        }
        merged[key] = cloneTelegramConfig(desiredValue);
    }
    return merged;
}
function readTelegramConfigForTransaction(configPath) {
    if (!existsSync(configPath))
        return {};
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isPlainConfigRecord(parsed)) {
        throw new Error(`Invalid Telegram config object: ${configPath}`);
    }
    return parsed;
}
function writeTelegramConfigInTransaction(agentDir, configPath, config) {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const tempConfigPath = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(tempConfigPath, `${JSON.stringify(config, null, "\t")}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
    chmodSync(tempConfigPath, 0o600);
    try {
        replaceTelegramConfigFile(tempConfigPath, configPath);
        chmodSync(configPath, 0o600);
    }
    finally {
        try {
            unlinkSync(tempConfigPath);
        }
        catch {
            /* rename consumed the temp file or cleanup is best effort */
        }
    }
}
export function getTelegramProfileFields(config) {
    const token = config.botToken?.trim();
    if (!token)
        return undefined;
    const legacyCursor = config
        .lastUpdateId;
    return {
        botToken: token,
        ...(config.botUsername !== undefined
            ? { botUsername: config.botUsername }
            : {}),
        ...(config.botId !== undefined ? { botId: config.botId } : {}),
        ...(config.allowedUserId !== undefined
            ? { allowedUserId: config.allowedUserId }
            : {}),
        ...(config.threadDisplayMode !== undefined
            ? { threadDisplayMode: config.threadDisplayMode }
            : {}),
        ...(legacyCursor !== undefined ? { lastUpdateId: legacyCursor } : {}),
    };
}
function omitTelegramRootProfileFields(config) {
    const { botToken: _botToken, botUsername: _botUsername, botId: _botId, allowedUserId: _allowedUserId, threadDisplayMode: _threadDisplayMode, lastUpdateId: _lastUpdateId, ...sharedConfig } = config;
    return sharedConfig;
}
function omitRetiredProactivePush(config) {
    const assistant = config.assistant;
    if (!assistant || !Object.hasOwn(assistant, "proactivePush")) {
        return { config, changed: false };
    }
    const { proactivePush: _proactivePush, ...remainingAssistant } = assistant;
    const next = { ...config };
    if (Object.keys(remainingAssistant).length > 0) {
        next.assistant = remainingAssistant;
    }
    else {
        delete next.assistant;
    }
    return { config: next, changed: true };
}
export function normalizeTelegramDefaultProfileConfig(config) {
    const retiredProactivePush = omitRetiredProactivePush(config);
    config = retiredProactivePush.config;
    const hasLegacyRootProfile = [
        "botToken",
        "botUsername",
        "botId",
        "allowedUserId",
        "threadDisplayMode",
        "lastUpdateId",
    ].some((field) => Object.hasOwn(config, field));
    if (!hasLegacyRootProfile) {
        return { config, changed: retiredProactivePush.changed };
    }
    const canonicalProfile = config.profiles?.[TELEGRAM_DEFAULT_PROFILE_NAME];
    const legacyToken = config.botToken?.trim();
    if (Object.hasOwn(config, "botToken") && !legacyToken) {
        throw new Error("Legacy Telegram default profile has no bot token");
    }
    const legacyProfile = {
        ...(legacyToken ? { botToken: legacyToken } : {}),
        ...(config.botUsername !== undefined
            ? { botUsername: config.botUsername }
            : {}),
        ...(config.botId !== undefined ? { botId: config.botId } : {}),
        ...(config.allowedUserId !== undefined
            ? { allowedUserId: config.allowedUserId }
            : {}),
        ...(config.threadDisplayMode !== undefined
            ? { threadDisplayMode: config.threadDisplayMode }
            : {}),
        ...(config
            .lastUpdateId !== undefined
            ? {
                lastUpdateId: config
                    .lastUpdateId,
            }
            : {}),
    };
    if (!canonicalProfile && !legacyToken) {
        throw new Error("Legacy Telegram default profile has no bot token");
    }
    const hasConflict = canonicalProfile
        ? Object.entries(legacyProfile).some(([field, value]) => Object.hasOwn(canonicalProfile, field) &&
            !configValuesEqual(canonicalProfile[field], value))
        : false;
    if (hasConflict) {
        throw new Error("Conflicting Telegram default profile identity at root and profiles.default");
    }
    const normalizedProfile = canonicalProfile
        ? { ...legacyProfile, ...canonicalProfile }
        : legacyProfile;
    return {
        config: {
            ...omitTelegramRootProfileFields(config),
            profiles: {
                ...(config.profiles ?? {}),
                [TELEGRAM_DEFAULT_PROFILE_NAME]: normalizedProfile,
            },
        },
        changed: true,
    };
}
function applyTelegramProfile(config, profileName) {
    const effectiveProfileName = profileName ?? TELEGRAM_DEFAULT_PROFILE_NAME;
    const profile = config.profiles?.[effectiveProfileName];
    if (!profile)
        return omitTelegramRootProfileFields(config);
    return {
        ...omitTelegramRootProfileFields(config),
        ...profile,
    };
}
function storeTelegramEffectiveConfig(baseConfig, nextConfig, profileName) {
    const effectiveProfileName = profileName ?? TELEGRAM_DEFAULT_PROFILE_NAME;
    const profile = getTelegramProfileFields(nextConfig);
    const profiles = { ...(baseConfig.profiles ?? {}) };
    if (profile)
        profiles[effectiveProfileName] = profile;
    else
        delete profiles[effectiveProfileName];
    return {
        ...omitTelegramRootProfileFields(nextConfig),
        profiles: Object.keys(profiles).length > 0 ? profiles : undefined,
    };
}
export function createTelegramConfigStore(options = {}) {
    let config = normalizeTelegramDefaultProfileConfig(cloneTelegramConfig(options.initialConfig ?? {})).config;
    let persistedConfig = {};
    let mutationVersion = 0;
    let persistQueue = Promise.resolve();
    let activeProfileName;
    let lastLoadRecoveredInvalidConfig = false;
    const agentDir = options.agentDir ?? resolveAgentDir();
    const configPath = options.configPath ?? getConfigPath();
    const env = options.env ?? process.env;
    const getEffectiveConfig = () => applyTelegramProfile(config, activeProfileName);
    const setEffectiveConfig = (nextConfig) => {
        config = storeTelegramEffectiveConfig(config, nextConfig, activeProfileName);
        mutationVersion += 1;
    };
    const adoptPersistedConfig = (merged, preserveLocalChanges) => {
        // Local edits are relative to the latest observation, not a queued write's older request baseline.
        const nextConfig = preserveLocalChanges
            ? mergeTelegramConfigDelta(persistedConfig, config, merged)
            : cloneTelegramConfig(merged);
        persistedConfig = cloneTelegramConfig(merged);
        config = nextConfig;
    };
    const withPersistedPairingProfile = (profileName, tokenSha256, observe) => {
        if ((profileName !== TELEGRAM_DEFAULT_PROFILE_NAME && !isValidTelegramProfileName(profileName)) ||
            !/^[a-f0-9]{64}$/u.test(tokenSha256)) {
            throw new Error("Invalid Telegram pairing admission identity.");
        }
        return withTelegramFileTransaction(`${configPath}.transaction`, () => {
            const latest = readTelegramConfigForTransaction(configPath);
            const profile = latest.profiles?.[profileName];
            const resolvedToken = typeof profile?.botToken === "string"
                ? resolveTelegramBotToken(profile.botToken, env)
                : undefined;
            if (!profile || !resolvedToken ||
                createHash("sha256").update(resolvedToken).digest("hex") !== tokenSha256 ||
                (profile.allowedUserId !== undefined &&
                    (!Number.isSafeInteger(profile.allowedUserId) || profile.allowedUserId <= 0))) {
                throw new Error("Telegram pairing admission authority is unavailable or changed.");
            }
            return observe(latest, profile);
        });
    };
    return {
        get: getEffectiveConfig,
        getStoredConfig: () => config,
        set: setEffectiveConfig,
        setProfile: (profileName, profile) => {
            config = {
                ...omitTelegramRootProfileFields(config),
                profiles: {
                    ...(config.profiles ?? {}),
                    [profileName]: cloneTelegramConfig(profile),
                },
            };
            mutationVersion += 1;
        },
        update: (mutate) => {
            const nextConfig = getEffectiveConfig();
            mutate(nextConfig);
            setEffectiveConfig(nextConfig);
        },
        activateProfile: (profileName) => {
            const normalizedProfileName = !profileName || profileName === TELEGRAM_DEFAULT_PROFILE_NAME
                ? undefined
                : profileName;
            if (normalizedProfileName && !config.profiles?.[normalizedProfileName]) {
                return false;
            }
            activeProfileName = normalizedProfileName;
            return true;
        },
        getActiveProfileName: () => activeProfileName,
        getBotToken: () => resolveTelegramBotToken(getEffectiveConfig().botToken, env),
        getBotTokenDiagnostic: () => getTelegramBotTokenDiagnostic(getEffectiveConfig().botToken, env),
        hasBotToken: () => !!resolveTelegramBotToken(getEffectiveConfig().botToken, env),
        getAllowedUserId: () => getEffectiveConfig().allowedUserId,
        getLegacyPollingCursor: () => getEffectiveConfig()
            .lastUpdateId,
        removeLegacyPollingCursor: () => {
            const next = {
                ...getEffectiveConfig(),
            };
            delete next.lastUpdateId;
            setEffectiveConfig(next);
        },
        getInboundHandlers: () => [
            ...(config.inboundHandlers ?? []),
            ...(config.attachmentHandlers ?? []),
        ],
        getAttachmentHandlers: () => config.attachmentHandlers,
        getOutboundHandlers: () => config.outboundHandlers,
        setAllowedUserId: (userId) => {
            const nextConfig = getEffectiveConfig();
            nextConfig.allowedUserId = userId;
            setEffectiveConfig(nextConfig);
        },
        withSourceSerialization: (operation) => withTelegramFileTransaction(`${configPath}.transaction`, operation),
        withPairingAdmission: (profileName, tokenSha256, publish) => withPersistedPairingProfile(profileName, tokenSha256, (_latest, profile) => publish(profile.allowedUserId === undefined)),
        withPairedUserAdmission: (profileName, tokenSha256, userId, publish, assertExecutionCurrent) => {
            if (!Number.isSafeInteger(userId) || userId <= 0)
                return { admitted: false };
            assertExecutionCurrent?.();
            return withPersistedPairingProfile(profileName, tokenSha256, (latest, profile) => {
                if (profile.allowedUserId !== userId)
                    return { admitted: false };
                assertExecutionCurrent?.();
                const current = getEffectiveConfig();
                const previousOwner = persistedConfig.profiles?.[profileName]?.allowedUserId;
                if ((activeProfileName ?? TELEGRAM_DEFAULT_PROFILE_NAME) !== profileName ||
                    current.botToken !== profile.botToken ||
                    (current.allowedUserId !== undefined && current.allowedUserId !== userId) ||
                    (current.allowedUserId === undefined && previousOwner !== undefined)) {
                    throw new Error("Telegram paired admission lost local profile authority.");
                }
                // Observation is not a local edit; queued persistence still adopts its own fresh disk result.
                adoptPersistedConfig(latest, true);
                return { admitted: true, value: publish() };
            });
        },
        persistAllowedUserId: (userId, assertExecutionCurrent, commitIfOwned) => {
            const profileName = activeProfileName;
            const profileKey = profileName ?? TELEGRAM_DEFAULT_PROFILE_NAME;
            const botToken = getEffectiveConfig().botToken;
            const previousOwner = getEffectiveConfig().allowedUserId;
            const assertCurrent = () => {
                assertExecutionCurrent?.();
                if (activeProfileName !== profileName || getEffectiveConfig().botToken !== botToken ||
                    getEffectiveConfig().allowedUserId !== previousOwner) {
                    throw new Error("Telegram pairing lost its originating profile authority.");
                }
            };
            const pairing = persistQueue.then(() => {
                assertCurrent();
                if (!Number.isSafeInteger(userId) || userId <= 0)
                    throw new Error("Invalid Telegram pairing user ID.");
                let merged;
                const publish = () => {
                    merged = withTelegramFileTransaction(`${configPath}.transaction`, () => {
                        const latest = readTelegramConfigForTransaction(configPath);
                        const profile = latest.profiles?.[profileKey];
                        if (!botToken || profile?.botToken !== botToken) {
                            throw new Error("Telegram pairing profile is unavailable or changed.");
                        }
                        assertCurrent();
                        if (profile.allowedUserId !== undefined)
                            return latest;
                        const next = { ...latest, profiles: { ...latest.profiles,
                                [profileKey]: { ...profile, allowedUserId: userId } } };
                        writeTelegramConfigInTransaction(agentDir, configPath, next);
                        return next;
                    });
                };
                if (commitIfOwned) {
                    if (!commitIfOwned(publish))
                        throw new Error("Telegram pairing lost transport ownership before publication.");
                }
                else {
                    publish();
                }
                if (!merged)
                    throw new Error("Telegram pairing publication did not execute.");
                adoptPersistedConfig(merged, true);
                return merged.profiles?.[profileKey]?.allowedUserId === userId;
            });
            persistQueue = pairing.then(() => undefined, () => undefined);
            return pairing;
        },
        load: async () => {
            lastLoadRecoveredInvalidConfig = false;
            const loadedConfig = await readTelegramConfig(configPath, {
                onInvalidConfig: (recovery) => {
                    lastLoadRecoveredInvalidConfig = true;
                    options.recordRuntimeEvent?.("config", recovery.error, {
                        phase: "load",
                        configPath: recovery.configPath,
                        recoveryPath: recovery.recoveryPath,
                    });
                },
            });
            let normalized;
            try {
                normalized = normalizeTelegramDefaultProfileConfig(loadedConfig);
            }
            catch (error) {
                options.recordRuntimeEvent?.("config", error, {
                    phase: "default-profile-normalize",
                    configPath,
                });
                throw error;
            }
            config = normalized.changed
                ? withTelegramFileTransaction(`${configPath}.transaction`, () => {
                    const latestConfig = readTelegramConfigForTransaction(configPath);
                    const latestNormalized = normalizeTelegramDefaultProfileConfig(latestConfig);
                    if (latestNormalized.changed) {
                        writeTelegramConfigInTransaction(agentDir, configPath, latestNormalized.config);
                    }
                    return latestNormalized.config;
                })
                : normalized.config;
            persistedConfig = cloneTelegramConfig(config);
            mutationVersion += 1;
        },
        didLastLoadRecoverInvalidConfig: () => lastLoadRecoveredInvalidConfig,
        persist: (nextConfig = getEffectiveConfig(), options) => {
            const profileName = activeProfileName;
            const desiredConfig = storeTelegramEffectiveConfig(config, cloneTelegramConfig(nextConfig), profileName);
            const baseConfig = cloneTelegramConfig(persistedConfig);
            const capturedMutationVersion = mutationVersion;
            const persist = persistQueue.then(() => {
                const mergedConfig = withTelegramFileTransaction(`${configPath}.transaction`, () => {
                    if (options?.isCurrent && !options.isCurrent()) {
                        throw new Error("Telegram config update lost its originating authority.");
                    }
                    const latestConfig = readTelegramConfigForTransaction(configPath);
                    const merged = mergeTelegramConfigDelta(baseConfig, desiredConfig, latestConfig);
                    if (!configValuesEqual(latestConfig, merged)) {
                        writeTelegramConfigInTransaction(agentDir, configPath, merged);
                    }
                    return merged;
                });
                adoptPersistedConfig(mergedConfig, mutationVersion !== capturedMutationVersion);
            });
            persistQueue = persist.catch(() => undefined);
            return persist;
        },
    };
}
export function createTelegramDraftPreviewsChecker(configStore) {
    return () => {
        const config = configStore.get();
        return (config.assistant?.draftPreviews ??
            config.draftPreviews ??
            config.richDraftPreviews ??
            true);
    };
}
export function createTelegramDraftPreviewsSetter(configStore) {
    return async (enabled) => {
        await loadLatestTelegramConfig(configStore);
        const { draftPreviews: _legacyDraftPreviews, richDraftPreviews: _legacyRichDraftPreviews, ...current } = configStore.get();
        const config = {
            ...current,
            assistant: { ...current.assistant, draftPreviews: enabled },
        };
        configStore.set(config);
        await configStore.persist(config);
    };
}
export function createTelegramAssistantRenderingModeGetter(configStore) {
    return () => {
        const config = configStore.get();
        const mode = config.assistant?.rendering ?? config.assistantRendering;
        return mode === "html" ? "html" : "rich";
    };
}
export function createTelegramAssistantRenderingModeSetter(configStore) {
    return async (mode) => {
        await loadLatestTelegramConfig(configStore);
        const { assistantRendering: _legacyAssistantRendering, ...current } = configStore.get();
        const config = {
            ...current,
            assistant: { ...current.assistant, rendering: mode },
        };
        configStore.set(config);
        await configStore.persist(config);
    };
}
export function createTelegramActivityVerbosityGetter(configStore) {
    return () => {
        const assistant = configStore.get().assistant;
        if (assistant?.activity !== undefined) {
            if (assistant.activity === "thinking" ||
                assistant.activity === "tools" ||
                assistant.activity === "verbose") {
                return assistant.activity;
            }
            return "quiet";
        }
        if (assistant?.activityVerbosity !== undefined) {
            return assistant.activityVerbosity === "verbose" ? "verbose" : "quiet";
        }
        return "verbose";
    };
}
export function createTelegramActivityVerbosityRefresher(configStore) {
    return () => loadLatestTelegramConfig(configStore);
}
export function createTelegramActivityVerbositySetter(configStore) {
    return async (verbosity) => {
        await loadLatestTelegramConfig(configStore);
        const current = configStore.get();
        const { activityVerbosity: _legacyActivityVerbosity, ...assistant } = current.assistant ?? {};
        const config = {
            ...current,
            assistant: {
                ...assistant,
                activity: verbosity,
            },
        };
        configStore.set(config);
        await configStore.persist(config);
    };
}
export function createTelegramVoiceReplyModeGetter(configStore) {
    return () => {
        const mode = configStore.get().voice?.replyMode;
        return mode === "mirror" || mode === "always" ? mode : "manual";
    };
}
export function createTelegramVoiceReplyModeConfiguredChecker(configStore) {
    return () => {
        const mode = configStore.get().voice?.replyMode;
        return mode === "mirror" || mode === "always";
    };
}
export function createTelegramVoiceReplyModeSetter(configStore) {
    return async (replyMode) => {
        await loadLatestTelegramConfig(configStore);
        const current = configStore.get();
        if (replyMode === undefined ||
            replyMode === "manual" ||
            replyMode === "hidden") {
            const { replyMode: _replyMode, ...remainingVoice } = current.voice ?? {};
            const next = { ...current };
            if (Object.keys(remainingVoice).length > 0)
                next.voice = remainingVoice;
            else
                delete next.voice;
            configStore.set(next);
            await configStore.persist(next);
            return;
        }
        const next = { ...current, voice: { ...(current.voice ?? {}), replyMode } };
        configStore.set(next);
        await configStore.persist(next);
    };
}
function getSystemTimezone() {
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return tz && tz.length > 0 ? tz : "UTC";
    }
    catch {
        return "UTC";
    }
}
export function resolveTelegramTimeConfig(raw, timeInjection = undefined) {
    const injectionMode = timeInjection === undefined
        ? "interval"
        : timeInjection === "always" || timeInjection === "interval"
            ? timeInjection
            : "hidden";
    const interval = typeof raw?.interval === "number" && raw.interval > 0
        ? raw.interval
        : 60 * 60 * 1000;
    const timezone = getSystemTimezone();
    return { injectionMode, interval, timezone };
}
export function createTelegramTimeConfigGetter(configStore) {
    return () => {
        const config = configStore.get();
        return resolveTelegramTimeConfig(config.time, config.assistant?.timeInjection);
    };
}
export function createTelegramTimeInjectionModeGetter(configStore) {
    return () => {
        const config = configStore.get();
        return resolveTelegramTimeConfig(config.time, config.assistant?.timeInjection).injectionMode;
    };
}
export function createTelegramTimeInjectionModeSetter(configStore) {
    return async (injectionMode) => {
        await loadLatestTelegramConfig(configStore);
        const current = configStore.get();
        const next = {
            ...current,
            assistant: {
                ...(current.assistant ?? {}),
                timeInjection: injectionMode,
            },
        };
        configStore.set(next);
        await configStore.persist(next);
    };
}
export function createTelegramProactivePushChatIdGetter(getTarget) {
    return () => getTarget()?.chatId;
}
export function createTelegramProactivePushTargetGetter(deps) {
    return () => {
        const activeTarget = deps.getActiveTurnTarget();
        if (activeTarget)
            return activeTarget;
        const assignedTarget = deps.getAssignedTarget();
        if (assignedTarget)
            return assignedTarget;
        const chatId = deps.getAllowedUserId();
        return typeof chatId === "number" ? { chatId } : undefined;
    };
}
export function createTelegramAutomaticThreadCleanupChecker(configStore) {
    return () => configStore.get().threads?.automaticCleanup ?? true;
}
export function createTelegramAutomaticThreadCleanupResolver(configStore) {
    return async () => {
        await loadLatestTelegramConfig(configStore);
        if (configStore.didLastLoadRecoverInvalidConfig?.()) {
            throw new Error("Thread cleanup setting is unavailable after invalid Telegram config recovery.");
        }
        return createTelegramAutomaticThreadCleanupChecker(configStore)();
    };
}
export function createTelegramAutomaticThreadCleanupSetter(configStore) {
    return async (enabled) => {
        await loadLatestTelegramConfig(configStore);
        const current = configStore.get();
        const config = {
            ...current,
            threads: { ...current.threads, automaticCleanup: enabled },
        };
        configStore.set(config);
        await configStore.persist(config);
    };
}
export function createTelegramConfigControls(configStore) {
    return {
        areDraftPreviewsEnabled: createTelegramDraftPreviewsChecker(configStore),
        setDraftPreviewsEnabled: createTelegramDraftPreviewsSetter(configStore),
        getAssistantRenderingMode: createTelegramAssistantRenderingModeGetter(configStore),
        setAssistantRenderingMode: createTelegramAssistantRenderingModeSetter(configStore),
        getActivityVerbosity: createTelegramActivityVerbosityGetter(configStore),
        refreshActivityVerbosity: createTelegramActivityVerbosityRefresher(configStore),
        setActivityVerbosity: createTelegramActivityVerbositySetter(configStore),
        getVoiceReplyMode: createTelegramVoiceReplyModeGetter(configStore),
        isVoiceReplyModeConfigured: createTelegramVoiceReplyModeConfiguredChecker(configStore),
        setVoiceReplyMode: createTelegramVoiceReplyModeSetter(configStore),
        getTimeInjectionMode: createTelegramTimeInjectionModeGetter(configStore),
        setTimeInjectionMode: createTelegramTimeInjectionModeSetter(configStore),
        isAutomaticThreadCleanupEnabled: createTelegramAutomaticThreadCleanupChecker(configStore),
        resolveAutomaticThreadCleanupEnabled: createTelegramAutomaticThreadCleanupResolver(configStore),
        setAutomaticThreadCleanupEnabled: createTelegramAutomaticThreadCleanupSetter(configStore),
    };
}
export function getTelegramAuthorizationState(userId, allowedUserId) {
    if (allowedUserId === undefined) {
        return { kind: "pair", userId };
    }
    if (userId === allowedUserId) {
        return { kind: "allow" };
    }
    return { kind: "deny" };
}
function isTelegramStaleContextError(error) {
    return (error instanceof Error &&
        (error.message.includes("stale after session") ||
            error.message.includes("stale ctx")));
}
export async function pairTelegramUserIfNeeded(userId, deps) {
    const authorization = getTelegramAuthorizationState(userId, deps.allowedUserId);
    if (authorization.kind !== "pair")
        return authorization.kind === "allow";
    deps.assertExecutionCurrent?.();
    const allowed = await deps.persistAllowedUserId(authorization.userId, deps.assertExecutionCurrent);
    deps.assertExecutionCurrent?.();
    if (!allowed)
        return false;
    try {
        deps.updateStatus(deps.ctx);
    }
    catch (error) {
        if (!isTelegramStaleContextError(error))
            throw error;
    }
    return true;
}
export function createTelegramUserPairingRuntime(deps) {
    return {
        pairIfNeeded: (userId, ctx, assertExecutionCurrent) => pairTelegramUserIfNeeded(userId, {
            allowedUserId: deps.getAllowedUserId(),
            ctx,
            persistAllowedUserId: deps.persistAllowedUserId,
            updateStatus: deps.updateStatus,
            assertExecutionCurrent,
        }),
    };
}
