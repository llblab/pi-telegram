import type { TelegramThreadDisplayMode } from "./config.ts";
import type { TelegramTopicTargetStore, TelegramWorkspaceDisplayBinding, TelegramWorkspaceThreadBinding } from "./threads.ts";
import type { TelegramApiCallOptions } from "./telegram-api.ts";
/** Pure directory tokenization shared by previews, initial titles, and reconciliation. */
export declare function tokenizeTelegramDirectorySegment(segment: string): string[];
/** Maps one leader-captured authenticated owner roster onto retained binding identities. */
export declare function resolveTelegramLiveWorkspaceBindingKeys(bindings: readonly TelegramWorkspaceThreadBinding[], leaderTarget: {
    chatId: number;
    threadId?: number;
} | undefined, followers: readonly {
    target?: {
        chatId: number;
        threadId?: number;
    };
}[]): ReadonlySet<string>;
/** Missing or ambiguous metadata yields no label rather than inventing identity. */
export declare function resolveTelegramWorkspaceDisplayNames(bindings: readonly TelegramWorkspaceDisplayBinding[], mode: TelegramThreadDisplayMode, liveBindingKeys?: ReadonlySet<string>): Map<string, string>;
export declare function resolveTelegramInitialWorkspaceDisplayName(input: {
    bindings: readonly TelegramWorkspaceDisplayBinding[];
    binding: TelegramWorkspaceDisplayBinding;
    mode: TelegramThreadDisplayMode;
    preserveRetainedManualName?: boolean;
    liveBindingKeys?: ReadonlySet<string>;
}): string | undefined;
export declare function applyTelegramThreadDisplaySetting(mode: TelegramThreadDisplayMode, deps: {
    getProfileKey(): string | undefined;
    ownsLeader(): boolean;
    getLeaderSetter(): ((mode: TelegramThreadDisplayMode) => Promise<void>) | undefined;
    getFollowerSetter(): ((mode: TelegramThreadDisplayMode) => Promise<void>) | undefined;
    reloadConfig(): Promise<void>;
}): Promise<void>;
export interface TelegramThreadDisplayReconcilerDeps {
    store: Pick<TelegramTopicTargetStore, "listWorkspaceBindings" | "setWorkspaceDisplayTitle" | "persist">;
    getMode(): TelegramThreadDisplayMode;
    getProfileKey(): string;
    getLeaderEpoch(): string | number | undefined;
    captureBindingAuthority(binding: TelegramWorkspaceThreadBinding): (() => boolean) | undefined;
    captureLiveBindingKeys(bindings: readonly TelegramWorkspaceThreadBinding[]): ReadonlySet<string>;
    callApi<TResponse>(method: string, body: Record<string, unknown>, options?: TelegramApiCallOptions): Promise<TResponse>;
}
export declare function createTelegramThreadDisplaySettingsRuntime(deps: {
    getTarget(): {
        chatId: number;
        threadId?: number;
    } | undefined;
    getBinding(target: {
        chatId: number;
        threadId?: number;
    }): {
        manualThreadName?: string;
    } | undefined;
    apply(mode: TelegramThreadDisplayMode): Promise<void>;
    reset(target: {
        chatId: number;
        threadId?: number;
    }): Promise<{
        ok: boolean;
        message?: string;
    }>;
}): {
    isCustom(): boolean;
    setMode(mode: TelegramThreadDisplayMode): Promise<void>;
};
/** Caller owns triggering and reporting; no timer or background retry is created. */
export declare function createTelegramThreadDisplayReconciler(deps: TelegramThreadDisplayReconcilerDeps): {
    reconcile(): Promise<{
        changed: number;
    }>;
};
