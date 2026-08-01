import { keyFromEnv } from '../config.ts';
import type { KeyStatus, ProviderName } from '../types.ts';

interface RotatedKey {
  value: string;
  failures: number;
  healthy: boolean;
  cooldownUntil: number;
}

/**
 * MultiKeyRotator - Load balances across multiple API keys per provider.
 *
 * Round-robin rotation spreads load across all configured keys for a single
 * provider. Keys that start failing (429/5xx) are temporarily quarantined on
 * a cooldown and automatically reintroduced after it expires.
 */
export class MultiKeyRotator {
  private readonly keys = new Map<ProviderName, RotatedKey[]>();
  private readonly cursor = new Map<ProviderName, number>();

  constructor() {
    for (const provider of [
      'anthropic',
      'gemini',
      'openai',
      'deepseek',
      'ollama',
      'vllm',
      'groq',
      'openrouter',
      'mistral',
      'cohere',
    ] as const) {
      const pool = keyFromEnv(provider);
      this.keys.set(provider, pool.map((value) => ({ value, failures: 0, healthy: true, cooldownUntil: 0 })));
      this.cursor.set(provider, 0);
    }
  }

  private providerKeys(provider: ProviderName): RotatedKey[] {
    return this.keys.get(provider) ?? [];
  }

  /** Returns the next healthy key, cycling round-robin. Null when no key is available. */
  next(provider: ProviderName): string | null {
    const pool = this.providerKeys(provider);
    if (pool.length === 0) return null;

    const now = Date.now();
    const start = this.cursor.get(provider) ?? 0;
    const size = pool.length;

    for (let i = 0; i < size; i++) {
      const index = (start + i) % size;
      const key = pool[index];
      if (!key) continue;
      if (key.healthy && key.cooldownUntil <= now) {
        this.cursor.set(provider, (index + 1) % size);
        return key.value;
      }
    }

    // Every key is cooling down - allow the oldest cooldown to pass.
    const oldest = pool.reduce<RotatedKey | null>((acc, k) => {
      if (!acc || k.cooldownUntil < acc.cooldownUntil) return k;
      return acc;
    }, null);

    if (!oldest) return null;
    this.cursor.set(provider, 0);
    return oldest.value;
  }

  /** True when at least one key is configured for the provider (env or injected). */
  hasKeys(provider: ProviderName): boolean {
    return this.providerKeys(provider).length > 0;
  }

  /**
   * Record a request result against a key.
   * @param status HTTP status observed from the upstream provider.
   */
  record(provider: ProviderName, key: string, status: number): void {
    const pool = this.providerKeys(provider);
    const entry = pool.find((k) => k.value === key);
    if (!entry) return;

    if (status === 429 || status >= 500) {
      entry.failures += 1;
      if (entry.failures >= 2) {
        entry.healthy = false;
        entry.cooldownUntil = Date.now() + Math.min(60_000 * entry.failures, 5 * 60_000);
      }
    } else {
      entry.failures = 0;
      entry.healthy = true;
      entry.cooldownUntil = 0;
    }
  }

  /** Marks a key healthy again (used after a successful fallback round). */
  heal(provider: ProviderName, key: string): void {
    this.record(provider, key, 200);
  }

  /** Adds a volatile per-request key to the pool (e.g. user-supplied Bearer token). */
  inject(provider: ProviderName, key: string): void {
    const pool = this.providerKeys(provider);
    if (pool.some((k) => k.value === key)) return;
    pool.unshift({ value: key, failures: 0, healthy: true, cooldownUntil: 0 });
  }

  status(): KeyStatus[] {
    const result: KeyStatus[] = [];
    for (const [provider, pool] of this.keys.entries()) {
      if (pool.length === 0) continue;
      const healthy = pool.filter((k) => k.healthy && k.cooldownUntil <= Date.now()).length;
      result.push({
        provider,
        healthy: healthy > 0,
        lastUsedAt: null,
        failures: pool.reduce((sum, k) => sum + k.failures, 0),
      });
    }
    return result;
  }

  /** Re-reads environment keys (used at boot; kept for dynamic reloads). */
  reload(provider?: ProviderName): void {
    const targets: ProviderName[] = provider ? [provider] : [...this.keys.keys()];
    for (const p of targets) {
      this.keys.set(p, keyFromEnv(p).map((value) => ({ value, failures: 0, healthy: true, cooldownUntil: 0 })));
      this.cursor.set(p, 0);
    }
  }
}
