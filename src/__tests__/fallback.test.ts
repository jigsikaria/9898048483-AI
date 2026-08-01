import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FallbackRouter } from '../middleware/fallback-router.ts';
import { MultiKeyRotator } from '../middleware/key-rotator.ts';
import type { ChatCompletionRequest } from '../types.ts';

type MockFetch = ReturnType<typeof vi.fn>;
let capturedRequests: Request[] = [];

const okJson = (data: unknown): Response =>
  new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

function requestFor(model: string, messages?: ChatCompletionRequest['messages']): ChatCompletionRequest {
  return {
    model,
    messages: messages ?? [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ],
    stream: false,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  capturedRequests = [];
});

describe('FallbackRouter', () => {
  it('routes to the first healthy provider and reports attempt=1', async () => {
    process.env.OPENAI_API_KEY = 'ok';
    const rotator = new MultiKeyRotator();
    const router = new FallbackRouter(rotator);

    const mock = vi.fn(async (req: Request) => {
      capturedRequests.push(req);
      return okJson({ id: 'ok', object: 'chat.completion' });
    });
    vi.stubGlobal('fetch', mock);

    const result = await router.tryChain(['openai'], requestFor('gpt-4o'), new Headers());
    expect(result.provider).toBe('openai');
    expect(result.attempt).toBe(1);
    expect(result.response.status).toBe(200);
    expect(capturedRequests[0]?.url).toContain('/chat/completions');
    expect(capturedRequests[0]?.headers.get('authorization')).toBe('Bearer ok');
  });

  it('fails over to the next provider when the primary errors', async () => {
    process.env.ANTHROPIC_API_KEY = 'a-key';
    process.env.GEMINI_API_KEY = 'g-key';
    const rotator = new MultiKeyRotator();
    const router = new FallbackRouter(rotator);

    const mock = vi.fn(async (req: Request) => {
      capturedRequests.push(req);
      if (req.url.includes('anthropic')) {
        return new Response(JSON.stringify({ error: { type: 'rate_limit_error' } }), { status: 429 });
      }
      return okJson({ text: 'gemini reply' });
    });
    vi.stubGlobal('fetch', mock);

    const result = await router.tryChain(['anthropic', 'gemini'], requestFor('claude-3-5-sonnet-20241022'), new Headers());
    expect(capturedRequests.length).toBe(2);
    expect(capturedRequests[0]?.url).toContain('api.anthropic.com');
    expect(capturedRequests[1]?.url).toContain('generativelanguage.googleapis.com');
    expect(result.provider).toBe('gemini');
    expect(result.attempt).toBe(2);
    expect(result.response.status).toBe(200);
  });

  it('quarantines a failed provider so later chains skip it', async () => {
    process.env.ANTHROPIC_API_KEY = 'a-key';
    process.env.GEMINI_API_KEY = 'g-key';
    const rotator = new MultiKeyRotator();
    const router = new FallbackRouter(rotator);

    const mock = vi.fn(async (req: Request) => {
      capturedRequests.push(req);
      return req.url.includes('anthropic')
        ? new Response(JSON.stringify({ error: { type: 'rate_limit_error' } }), { status: 429 })
        : okJson({ text: 'ok' });
    });
    vi.stubGlobal('fetch', mock);

    await router.tryChain(['anthropic', 'gemini'], requestFor('claude-3-5-sonnet-20241022'), new Headers());
    expect(router.status().some((s) => s.provider === 'anthropic' && s.quarantined)).toBe(true);

    // Second chain starts fresh but must skip the quarantined anthropic.
    capturedRequests = [];
    const result = await router.tryChain(['anthropic', 'gemini'], requestFor('claude-3-5-sonnet-20241022'), new Headers());
    expect(capturedRequests.some((r) => r.url.includes('anthropic'))).toBe(false);
    expect(result.provider).toBe('gemini');
  });

  it('exhausts the chain and returns the last error when all providers fail', async () => {
    process.env.OPENAI_API_KEY = 'o';
    const rotator = new MultiKeyRotator();
    const router = new FallbackRouter(rotator);

    const mock = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'down' } }), { status: 503 }));
    vi.stubGlobal('fetch', mock);

    const result = await router.tryChain(['openai'], requestFor('gpt-4o'), new Headers());
    expect(result.response.status).toBe(503);
    const body = await result.response.json().catch(() => ({}));
    expect(body.error.type).toBe('fallback_chain_exhausted');
  });
});

describe('Protocol request building', () => {
  let mock: MockFetch;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'a-key';
    process.env.GEMINI_API_KEY = 'g-key';
    process.env.OLLAMA_API_KEY = '';
    mock = vi.fn(async (req: Request) => {
      capturedRequests.push(req);
      return okJson({});
    });
    vi.stubGlobal('fetch', mock);
  });

  it('builds an Anthropic messages payload with extracted system + x-api-key header', async () => {
    const rotator = new MultiKeyRotator();
    const router = new FallbackRouter(rotator);
    await router.tryChain(['anthropic'], requestFor('claude-3-5-sonnet-20241022'), new Headers());

    const req = capturedRequests[0] as Request;
    expect(req.url).toContain('api.anthropic.com');
    expect(req.url.endsWith('/messages')).toBe(true);
    expect(req.headers.get('x-api-key')).toBe('a-key');
    expect(req.headers.get('anthropic-version')).toBe('2023-06-01');

    const body = await req.json() as Record<string, unknown>;
    expect(body.system).toBe('You are helpful.');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body.max_tokens).toBe(4096);
  });

  it('builds a Gemini request with model-content mapping and path-embedded key', async () => {
    const rotator = new MultiKeyRotator();
    const router = new FallbackRouter(rotator);
    await router.tryChain(['gemini'], requestFor('gemini-1.5-pro-latest'), new Headers());

    const req = capturedRequests[0] as Request;
    expect(req.url).toContain('streamGenerateContent?alt=sse');
    expect(req.url).toContain('key=g-key');

    const body = await req.json() as Record<string, unknown>;
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are helpful.' }] });
  });

  it('builds an Ollama native chat payload on /api/chat without the ollama/ prefix', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const rotator = new MultiKeyRotator();
    const router = new FallbackRouter(rotator);
    await router.tryChain(['ollama'], requestFor('ollama/llama3'), new Headers());

    const req = capturedRequests[0] as Request;
    expect(req.url).toBe('http://localhost:11434/api/chat');

    const body = await req.json() as Record<string, unknown>;
    expect(body.model).toBe('llama3');
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ]);
  });
});
