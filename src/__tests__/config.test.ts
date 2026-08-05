import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'PORT',
  'HOST',
  'GATEWAY_API_KEY',
  'REQUIRE_GATEWAY_KEY',
  'ALLOWED_ORIGINS',
  'IP_ALLOWLIST',
  'RATE_LIMIT_ENABLED',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_MAX',
  'LOG_LEVEL',
  'PROMETHEUS_ENABLED',
  'FALLBACK_CHAIN',
  'TRUST_PROXY',
  'ALLOW_CUSTOM_ENDPOINT',
  'UPSTREAM_TIMEOUT_MS',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OLLAMA_BASE_URL',
];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

async function loadConfig(env: Record<string, string> = {}): Promise<typeof import('../config.ts')> {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  return import('../config.ts');
}

describe('config parsing', () => {
  it('parses integers with fallbacks', async () => {
    const { config } = await loadConfig({ PORT: '1234', UPSTREAM_TIMEOUT_MS: 'notanumber' });
    expect(config.port).toBe(1234);
    expect(config.upstreamTimeoutMs).toBe(60_000);
    expect(config.rateLimit.max).toBe(60);
  });

  it('parses booleans from 1/true/yes/on', async () => {
    const { config } = await loadConfig({
      REQUIRE_GATEWAY_KEY: 'true',
      TRUST_PROXY: 'yes',
      ALLOW_CUSTOM_ENDPOINT: '0',
      PROMETHEUS_ENABLED: 'on',
    });
    expect(config.requiredGatewayKey).toBe(true);
    expect(config.trustProxy).toBe(true);
    expect(config.allowCustomEndpoint).toBe(false);
    expect(config.prometheusEnabled).toBe(true);
  });

  it('parses comma-separated lists with trimming and deduplication', async () => {
    const { config } = await loadConfig({
      IP_ALLOWLIST: ' 1.2.3.4, 5.6.7.8 ',
      FALLBACK_CHAIN: 'openai, anthropic ,openrouter, anthropic',
    });
    expect(config.ipAllowlist).toEqual(['1.2.3.4', '5.6.7.8']);
    expect(config.fallbackChain).toEqual(['openai', 'anthropic', 'openrouter']);
  });

  it('maps provider env keys, splitting and trimming comma-separated keys', async () => {
    const { keyFromEnv } = await loadConfig({ ANTHROPIC_API_KEY: 'k1, k2, ' });
    expect(keyFromEnv('anthropic')).toEqual(['k1', 'k2']);
    expect(keyFromEnv('openai')).toEqual([]);
  });

  it('detects providers from model names and honours a header override', async () => {
    const { detectProvider } = await loadConfig();
    expect(detectProvider('claude-3-5-sonnet-20241022')).toBe('anthropic');
    expect(detectProvider('gemini-2.0-flash-exp')).toBe('gemini');
    expect(detectProvider('gpt-4o')).toBe('openai');
    expect(detectProvider('deepseek-chat')).toBe('deepseek');
    expect(detectProvider('gpt-4o', 'anthropic')).toBe('anthropic');
  });

  it('defaults the Ollama base URL to localhost', async () => {
    const { providers } = await loadConfig();
    expect(providers.ollama.baseUrl).toBe('http://localhost:11434');
  });
});
