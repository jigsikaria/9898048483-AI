import type { KeyStatus, ProviderName } from '../types.ts';
/**
 * MultiKeyRotator - Load balances across multiple API keys per provider.
 *
 * Round-robin rotation spreads load across all configured keys for a single
 * provider. Keys that start failing (429/5xx) are temporarily quarantined on
 * a cooldown and automatically reintroduced after it expires.
 */
export declare class MultiKeyRotator {
    private readonly keys;
    private readonly cursor;
    constructor();
    private providerKeys;
    /** Returns the next healthy key, cycling round-robin. Null when no key is available. */
    next(provider: ProviderName): string | null;
    /** True when at least one key is configured for the provider (env or injected). */
    hasKeys(provider: ProviderName): boolean;
    /**
     * Record a request result against a key.
     * @param status HTTP status observed from the upstream provider.
     */
    record(provider: ProviderName, key: string, status: number): void;
    /** Marks a key healthy again (used after a successful fallback round). */
    heal(provider: ProviderName, key: string): void;
    /** Adds a volatile per-request key to the pool (e.g. user-supplied Bearer token). */
    inject(provider: ProviderName, key: string): void;
    status(): KeyStatus[];
    /** Re-reads environment keys (used at boot; kept for dynamic reloads). */
    reload(provider?: ProviderName): void;
}
