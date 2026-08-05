import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Hono } from 'hono';

const ENV_KEYS = [
  'REQUIRE_GATEWAY_KEY',
  'GATEWAY_API_KEY',
  'IP_ALLOWLIST',
  'RATE_LIMIT_ENABLED',
  'RATE_LIMIT_MAX',
  'RATE_LIMIT_WINDOW_MS',
  'TRUST_PROXY',
  'ALLOW_CUSTOM_ENDPOINT',
  'LOG_LEVEL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.unstubAllGlobals();
  vi.resetModules();
});

interface Gateway {
  app: Hono;
  module: typeof import('../index.ts');
}

async function importGateway(env: Record<string, string> = {}): Promise<Gateway> {
  vi.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries({ LOG_LEVEL: 'error', ...env })) process.env[key] = value;
  const module = await import('../index.ts');
  return { app: module.default, module };
}

const okCompletion = {
  id: 'chatcmpl-ok',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function chatRequest(app: Hono, overrides: { body?: Record<string, unknown>; headers?: Record<string, string> } = {}) {
  return app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...overrides.headers },
    body: JSON.stringify(overrides.body ?? { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
  });
}

describe('gateway security middleware', () => {
  it('rejects requests with a wrong gateway key when required', async () => {
    const { app } = await importGateway({ REQUIRE_GATEWAY_KEY: 'true', GATEWAY_API_KEY: 'secret' });

    const denied = await app.request('/v1/models', { headers: { authorization: 'Bearer wrong' } });
    expect(denied.status).toBe(401);

    const allowed = await app.request('/v1/models', { headers: { authorization: 'Bearer secret' } });
    expect(allowed.status).toBe(200);
  });

  it('enforces the IP allowlist using the socket IP when not trusting a proxy', async () => {
    const { app } = await importGateway({ IP_ALLOWLIST: '10.0.0.1', TRUST_PROXY: 'false' });

    const denied = await app.request('/v1/models', {
      headers: { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '10.0.0.1' },
    });
    expect(denied.status).toBe(403);

    const allowed = await app.request('/v1/models', {
      headers: { 'x-real-ip': '10.0.0.1', 'x-forwarded-for': '1.2.3.4' },
    });
    expect(allowed.status).toBe(200);
  });

  it('prefers the forwarded header when a proxy is trusted', async () => {
    const { app } = await importGateway({ IP_ALLOWLIST: '10.0.0.1', TRUST_PROXY: 'true' });

    const res = await app.request('/v1/models', {
      headers: { 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '10.0.0.1' },
    });
    expect(res.status).toBe(200);
  });

  it('rate limits per client IP once the budget is exhausted', async () => {
    const { app } = await importGateway({
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_MAX: '2',
      RATE_LIMIT_WINDOW_MS: '60000',
    });

    await app.request('/v1/models', { headers: { 'x-real-ip': '1.1.1.1' } });
    await app.request('/v1/models', { headers: { 'x-real-ip': '1.1.1.1' } });
    const third = await app.request('/v1/models', { headers: { 'x-real-ip': '1.1.1.1' } });
    expect(third.status).toBe(429);

    const other = await app.request('/v1/models', { headers: { 'x-real-ip': '2.2.2.2' } });
    expect(other.status).toBe(200);
  });

  it('does not leak a spoofed forwarded header into the rate limit key', async () => {
    const { app } = await importGateway({
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_MAX: '2',
      RATE_LIMIT_WINDOW_MS: '60000',
      TRUST_PROXY: 'false',
    });

    // Rotating x-forwarded-for does not create new buckets when not trusting proxies.
    await app.request('/v1/models', { headers: { 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '8.8.8.1' } });
    await app.request('/v1/models', { headers: { 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '8.8.8.2' } });
    const third = await app.request('/v1/models', { headers: { 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '8.8.8.3' } });
    expect(third.status).toBe(429);
  });
});

describe('gateway request handling', () => {
  it('returns a friendly 502 when a cloud provider has no key anywhere', async () => {
    const { app } = await importGateway();
    const res = await chatRequest(app);
    expect(res.status).toBe(502);
    const body = await res.json().catch(() => ({}));
    expect(body.error.type).toBe('missing_api_key');
  });

  it('serves a cloud provider with a per-request user key even without env keys', async () => {
    const { app } = await importGateway();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(okCompletion), { status: 200 })));

    const res = await chatRequest(app, { headers: { authorization: 'Bearer user-key-1' } });
    expect(res.status).toBe(200);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('uses the user key only for that request and falls back to env keys later', async () => {
    const { app } = await importGateway({ OPENAI_API_KEY: 'env-key' });

    const auths: (string | null)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (req: Request) => {
        auths.push(req.headers.get('authorization'));
        return new Response(JSON.stringify(okCompletion), { status: 200 });
      }),
    );

    await chatRequest(app, { headers: { authorization: 'Bearer user-key-1' } });
    await chatRequest(app);

    expect(auths[0]).toBe('Bearer user-key-1');
    expect(auths[1]).toBe('Bearer env-key');
  });

  it('applies x-custom-endpoint per request without mutating the global registry', async () => {
    const { app } = await importGateway({ OPENAI_API_KEY: 'env-key' });

    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (req: Request) => {
        urls.push(req.url);
        return new Response(JSON.stringify(okCompletion), { status: 200 });
      }),
    );

    await chatRequest(app, { headers: { 'x-custom-endpoint': 'http://custom.local' } });
    expect(urls[0]).toMatch(/^http:\/\/custom\.local\/chat\/completions/);

    // Next request without the header must go to the default endpoint.
    await chatRequest(app);
    expect(urls[1]).toMatch(/^https:\/\/api\.openai\.com\/v1\/chat\/completions/);
  });

  it('ignores invalid custom endpoints', async () => {
    const { app } = await importGateway({ OPENAI_API_KEY: 'env-key' });

    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (req: Request) => {
        urls.push(req.url);
        return new Response(JSON.stringify(okCompletion), { status: 200 });
      }),
    );

    await chatRequest(app, { headers: { 'x-custom-endpoint': 'ftp://not-http' } });
    expect(urls[0]).toMatch(/^https:\/\/api\.openai\.com\/v1\/chat\/completions/);
  });

  it('does not crash on a non-JSON upstream error body and preserves its message', async () => {
    const { app } = await importGateway({ OPENAI_API_KEY: 'env-key' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Gateway upstream text', { status: 502 })));

    const res = await chatRequest(app);
    expect(res.status).toBe(502);
    const body = await res.json().catch(() => ({}));
    expect(body.error.message).toBe('Bad Gateway upstream text');
    expect(body.error.type).toBe('fallback_chain_exhausted');
  });

  it('forwards OpenAI chat params to the upstream body', async () => {
    const { app } = await importGateway({ OPENAI_API_KEY: 'env-key' });

    let upstreamBody: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (req: Request) => {
        upstreamBody = await req.clone().json();
        return new Response(JSON.stringify(okCompletion), { status: 200 });
      }),
    );

    await chatRequest(app, {
      body: {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        n: 2,
        tools: [{ type: 'function', function: { name: 'f' } }],
        tool_choice: 'auto',
        frequency_penalty: 0.5,
        presence_penalty: 0.2,
        max_output_tokens: 512,
      },
    });

    expect(upstreamBody.n).toBe(2);
    expect(upstreamBody.tools).toHaveLength(1);
    expect(upstreamBody.tool_choice).toBe('auto');
    expect(upstreamBody.frequency_penalty).toBe(0.5);
    expect(upstreamBody.presence_penalty).toBe(0.2);
    expect(upstreamBody.max_output_tokens).toBe(512);
  });
});

describe('toOpenAICompletion normalization', () => {
  it('converts Anthropic responses to OpenAI shape with usage mapping', async () => {
    const { module } = await importGateway();
    const out = module.toOpenAICompletion(
      'anthropic',
      { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 3, output_tokens: 5 } },
      'claude-x',
    );
    expect(out.choices[0]?.message.content).toBe('hi');
    expect(out.usage.total_tokens).toBe(8);
  });

  it('normalizes OpenAI-compatible passthrough envelopes', async () => {
    const { module } = await importGateway();
    const out = module.toOpenAICompletion(
      'openai',
      { choices: [{ index: 0, message: { role: 'assistant', content: 'yo' }, finish_reason: 'stop' }] },
      'gpt-4o',
    );
    expect(out.model).toBe('gpt-4o');
    expect(out.id.startsWith('chatcmpl-')).toBe(true);
    expect(out.object).toBe('chat.completion');
    expect(out.choices).toHaveLength(1);
  });

  it('does not throw on a non-conforming 200 body', async () => {
    const { module } = await importGateway();
    const out = module.toOpenAICompletion('openai', { foo: 'bar' }, 'gpt-4o');
    expect(out.choices).toEqual([]);
    expect(out.usage.total_tokens).toBe(0);
  });
});
