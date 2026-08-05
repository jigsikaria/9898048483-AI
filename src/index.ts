import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { config, allModels, detectProvider, providers } from './config.ts';
import { log } from './logger.ts';
import { MultiKeyRotator } from './middleware/key-rotator.ts';
import { FallbackRouter } from './middleware/fallback-router.ts';
import { transformStream } from './adapters/stream-transformer.ts';
import type { ChatCompletionRequest, ModelDescriptor, ProviderName, RequestLogEntry } from './types.ts';

const app = new Hono();
const rotator = new MultiKeyRotator();
const router = new FallbackRouter(rotator);

// In-memory request log + rate-limit counters.
const requestLog: RequestLogEntry[] = [];
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
let totalRequests = 0;
let totalTokens = 0;
let fallbackEvents = 0;

/**
 * Best-effort client IP. When `TRUST_PROXY` is set the proxy-provided headers
 * are trusted; otherwise the socket IP injected by the server wrapper (see the
 * bootstrap below) takes precedence, so a client cannot spoof its way past the
 * allowlist or rate limiter.
 */
function clientIp(c: Context): string {
  const forwarded = (c.req.header('x-forwarded-for') ?? '').split(',')[0]?.trim() || undefined;
  const realIp = c.req.header('x-real-ip')?.trim() || undefined;
  if (config.trustProxy) return forwarded ?? realIp ?? 'unknown';
  return realIp ?? forwarded ?? 'unknown';
}

function isValidHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Resolves the effective base URL for a provider, honouring a per-request override. */
function resolveBaseUrl(provider: ProviderName, customEndpoint?: string): string {
  const override = config.allowCustomEndpoint && isValidHttpUrl(customEndpoint) ? customEndpoint : undefined;
  if (customEndpoint && !override) {
    log('warn', `ignoring invalid or disabled x-custom-endpoint: ${customEndpoint}`);
  }
  return (override ?? providers[provider].baseUrl).replace(/\/$/, '');
}

/** Extracts a user-supplied provider key from the request, if any. */
function userKeyFromRequest(c: Context): string | undefined {
  const authHeader = c.req.header('authorization') ?? c.req.header('x-api-key');
  if (!authHeader) return undefined;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token || token === config.gatewayApiKey) return undefined;
  // `sk-env` is a sentinel meaning "use the server-configured env keys".
  if (token.startsWith('sk-env')) return undefined;
  return token;
}

// ------------------------------------------------------------
// Middleware: CORS (works for VS Code, Android Studio, Cursor, mobile)
// ------------------------------------------------------------
app.use('*', cors({
  origin: config.allowedOrigins === '*' ? '*' : config.allowedOrigins.split(','),
  allowMethods: ['GET', 'POST', 'OPTIONS', 'DELETE', 'PUT'],
  allowHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-provider', 'x-custom-endpoint', 'x-fallback'],
  exposeHeaders: ['content-type'],
  maxAge: 86400,
}));

// ------------------------------------------------------------
// Middleware: IP allowlist + gateway key verification + rate limit
// ------------------------------------------------------------
app.use('*', async (c, next) => {
  const ip = clientIp(c);

  if (config.ipAllowlist.length > 0 && !config.ipAllowlist.includes(ip)) {
    return c.json({ error: { message: 'Forbidden: IP not in allowlist', type: 'ip_denied' } }, 403);
  }

  if (config.requiredGatewayKey) {
    const auth = c.req.header('authorization') ?? c.req.header('x-api-key') ?? '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (!token || token !== config.gatewayApiKey) {
      return c.json({ error: { message: 'Unauthorized: invalid gateway key', type: 'gateway_auth_failed' } }, 401);
    }
  }

  if (config.rateLimit.enabled) {
    const bucket = rateBuckets.get(ip) ?? { count: 0, resetAt: Date.now() + config.rateLimit.windowMs };
    if (bucket.resetAt <= Date.now()) {
      bucket.count = 0;
      bucket.resetAt = Date.now() + config.rateLimit.windowMs;
    }
    bucket.count += 1;
    rateBuckets.set(ip, bucket);
    if (bucket.count > config.rateLimit.max) {
      return c.json({ error: { message: 'Rate limit exceeded', type: 'rate_limited' } }, 429);
    }
  }

  return next();
});

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
function logRequest(entry: Omit<RequestLogEntry, 'id' | 'timestamp'>): void {
  requestLog.unshift({ ...entry, id: crypto.randomUUID().slice(0, 8), timestamp: Date.now() });
  if (requestLog.length > 200) requestLog.length = 200;
}

function pickBody(body: Record<string, unknown>): ChatCompletionRequest {
  return {
    model: String(body.model ?? 'gpt-4o'),
    messages: (body.messages as ChatCompletionRequest['messages']) ?? [],
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
    stream: Boolean(body.stream),
    ...(body.top_p !== undefined ? { top_p: body.top_p as number } : {}),
    ...(body.stop !== undefined ? { stop: body.stop as string | string[] } : {}),
    ...(body.max_output_tokens !== undefined ? { max_output_tokens: body.max_output_tokens as number } : {}),
    ...(body.frequency_penalty !== undefined ? { frequency_penalty: body.frequency_penalty as number } : {}),
    ...(body.presence_penalty !== undefined ? { presence_penalty: body.presence_penalty as number } : {}),
    ...(body.n !== undefined ? { n: body.n as number } : {}),
    ...(body.tools !== undefined ? { tools: body.tools as unknown[] } : {}),
    ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice as unknown } : {}),
  };
}

function buildChain(primary: ProviderName, headerChain?: string): ProviderName[] {
  const headerList = headerChain
    ?.split(',')
    .map((s) => s.trim().toLowerCase() as ProviderName)
    .filter((p) => p in providers) ?? [];
  const candidate = headerList.length > 0 ? headerList : config.fallbackChain;
  const chain = [primary, ...candidate.filter((p) => p !== primary)];
  return [...new Set(chain)];
}

// ------------------------------------------------------------
// Health + Metadata
// ------------------------------------------------------------
app.get('/', (c) => c.json({
  status: 'online',
  engine: '9898048483 Adapter OS v10.0 Universal AI Gateway',
  version: '10.0.0',
  timestamp: new Date().toISOString(),
  providers: Object.values(providers).map((p) => p.name),
  endpoints: ['/v1/models', '/v1/chat/completions', '/health', '/metrics', '/v1/logs'],
}));

app.get('/health', (c) => c.json({
  status: 'healthy',
  uptime: process.uptime(),
  providers: Object.fromEntries(
    Object.keys(providers).map((p) => [p, rotator.status().some((s) => s.provider === p && s.healthy)]),
  ),
}));

// ------------------------------------------------------------
// GET /v1/models - Aggregated catalog across all providers
// ------------------------------------------------------------
app.get('/v1/models', (c) => {
  const list: ModelDescriptor[] = allModels.map((m) => ({ ...m, object: 'model' as const }));
  return c.json({ object: 'list', data: list });
});

// ------------------------------------------------------------
// GET /v1/models/{id} - OpenAI-compatible model lookup
// ------------------------------------------------------------
app.get('/v1/models/:id', (c) => {
  const id = c.req.param('id');
  const found = allModels.find((m) => m.id === id);
  if (!found) return c.json({ error: { message: `Unknown model: ${id}`, type: 'model_not_found' } }, 404);
  return c.json(found);
});

// ------------------------------------------------------------
// GET /metrics + GET /v1/logs - Observability
// ------------------------------------------------------------
app.get('/metrics', (c) => {
  if (!config.prometheusEnabled) return c.json({ error: { message: 'Metrics disabled' } }, 404);
  const lines = [
    '# HELP adapter_requests_total Total proxy requests',
    '# TYPE adapter_requests_total counter',
    `adapter_requests_total ${totalRequests}`,
    '# HELP adapter_tokens_total Total proxied tokens',
    '# TYPE adapter_tokens_total counter',
    `adapter_tokens_total ${totalTokens}`,
    '# HELP adapter_fallback_events_total Failover events',
    '# TYPE adapter_fallback_events_total counter',
    `adapter_fallback_events_total ${fallbackEvents}`,
  ];
  return c.text(lines.join('\n'), 200, { 'content-type': 'text/plain; version=0.0.4' });
});

app.get('/v1/logs', (c) => c.json({ total: requestLog.length, entries: requestLog.slice(0, 50) }));

// ------------------------------------------------------------
// POST /v1/embeddings - OpenAI-compatible embeddings passthrough
// (used by Copilot BYOK, chat tools and RAG pipelines)
// ------------------------------------------------------------
app.post('/v1/embeddings', async (c) => {
  const startedAt = Date.now();
  totalRequests += 1;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request' } }, 400);
  }

  const model = String(body.model ?? 'text-embedding-3-small');
  const input = body.input;
  if (input === undefined || input === '') {
    return c.json({ error: { message: 'input is required', type: 'invalid_request' } }, 400);
  }

  const overrideProvider = c.req.header('x-provider');
  const customEndpoint = c.req.header('x-custom-endpoint');
  const primary = detectProvider(model, overrideProvider);

  if (!['openai', 'mistral', 'vllm', 'cohere', 'deepseek', 'groq', 'openrouter'].includes(primary)) {
    return c.json(
      { error: { message: `${primary} does not expose an OpenAI-compatible /embeddings endpoint`, type: 'unsupported' } },
      400,
    );
  }

  const baseUrl = resolveBaseUrl(primary, customEndpoint);
  const key = userKeyFromRequest(c) ?? rotator.next(primary);
  const endpoint = `${baseUrl}/embeddings`;

  const headers = new Headers({ 'content-type': 'application/json' });
  if (primary === 'ollama' || primary === 'vllm') headers.set('authorization', `Bearer ${key ?? 'ollama'}`);
  else headers.set('authorization', `Bearer ${key ?? ''}`);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input }),
    });
    rotator.record(primary, key ?? '', response.status);
    logRequest({ method: 'POST', path: '/v1/embeddings', model, provider: primary, status: response.status, latencyMs: Date.now() - startedAt, streamed: false, attempt: 1 });
    const data = await response.json().catch(() => ({}));
    return c.json(data, response.status as 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logRequest({ method: 'POST', path: '/v1/embeddings', model, provider: primary, status: 502, latencyMs: Date.now() - startedAt, streamed: false, attempt: 1 });
    return c.json({ error: { message, type: 'adapter_error' } }, 502);
  }
});

// ------------------------------------------------------------
// POST /v1/chat/completions - The universal chat endpoint
// ------------------------------------------------------------
app.post('/v1/chat/completions', async (c) => {
  const startedAt = Date.now();
  totalRequests += 1;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request' } }, 400);
  }

  const overrideProvider = c.req.header('x-provider');
  const customEndpoint = c.req.header('x-custom-endpoint');
  const fallbackHeader = c.req.header('x-fallback');

  const chatBody = pickBody(body);
  const primary = detectProvider(chatBody.model, overrideProvider);
  const chain = buildChain(primary, fallbackHeader);

  if (chatBody.messages.length === 0) {
    return c.json({ error: { message: 'messages is required', type: 'invalid_request' } }, 400);
  }

  // Per-request provider base URL override (e.g. LAN Ollama). Scoped to this
  // request only — it never mutates the shared provider registry.
  const baseUrlOverrides =
    customEndpoint && isValidHttpUrl(customEndpoint) && config.allowCustomEndpoint
      ? { [primary]: customEndpoint }
      : undefined;
  if (customEndpoint && !baseUrlOverrides) {
    log('warn', `ignoring invalid or disabled x-custom-endpoint: ${customEndpoint}`);
  }

  // Per-request key override (e.g. from the GUI Key Vault). Scoped to this
  // request only — it is never added to the shared rotation pool.
  const userKey = userKeyFromRequest(c);
  const keyOverrides = userKey ? { [primary]: userKey } : undefined;

  // Friendly 502 when the user selected a cloud provider but no API key is
  // configured anywhere in the chain (env, vault or per-request override).
  // Only an explicitly-requested local provider (ollama/vllm) bypasses this.
  const canServe =
    primary === 'ollama' ||
    primary === 'vllm' ||
    Boolean(userKey) ||
    chain.some((p) => p !== 'ollama' && p !== 'vllm' && rotator.hasKeys(p));
  if (!canServe) {
    return c.json(
      {
        error: {
          message: 'API Key missing for provider. Please add your key in the Key Vault tab or .env file.',
          type: 'missing_api_key',
          providers: chain,
        },
      },
      502,
    );
  }

  try {
    const { provider, response, attempt } = await router.tryChain(
      chain,
      chatBody,
      c.req.raw.headers,
      undefined,
      { baseUrlOverrides, keyOverrides },
    );
    if (attempt > 1) fallbackEvents += 1;

    if (!response.ok) {
      const errorBody = await response.text();
      logRequest({ method: 'POST', path: '/v1/chat/completions', model: chatBody.model, provider, status: response.status, latencyMs: Date.now() - startedAt, streamed: false, attempt });
      let parsed: unknown;
      try {
        parsed = JSON.parse(errorBody || '{}');
      } catch {
        parsed = { error: { message: errorBody || 'Upstream error', type: 'upstream_error' } };
      }
      return c.json(parsed, response.status as 400);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const shouldStream = chatBody.stream || contentType.includes('text/event-stream');

    if (shouldStream) {
      if (response.body) {
        const requestId = crypto.randomUUID().slice(0, 12);
        const transformed = transformStream(
          response.body,
          provider,
          chatBody.model,
          requestId,
          (err) => log('error', `stream error (${provider}):`, err),
          (usage) => {
            totalTokens += usage.total_tokens;
          },
        );
        logRequest({ method: 'POST', path: '/v1/chat/completions', model: chatBody.model, provider, status: 200, latencyMs: Date.now() - startedAt, streamed: true, attempt });
        return new Response(transformed, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-provider': provider,
            'x-request-id': requestId,
          },
        });
      }
    }

    // Non-streaming: convert provider-native response into OpenAI shape.
    const raw = await response.json().catch(() => ({})) as Record<string, unknown>;
    const openAI = toOpenAICompletion(provider, raw, chatBody.model);
    totalTokens += (openAI.usage?.total_tokens ?? 0);
    logRequest({ method: 'POST', path: '/v1/chat/completions', model: chatBody.model, provider, status: 200, latencyMs: Date.now() - startedAt, streamed: false, attempt });
    return c.json(openAI);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logRequest({ method: 'POST', path: '/v1/chat/completions', model: chatBody.model, provider: primary, status: 500, latencyMs: Date.now() - startedAt, streamed: false, attempt: 0 });
    return c.json({ error: { message, type: 'adapter_error' } }, 500);
  }
});

// ------------------------------------------------------------
// Provider-native -> OpenAI completion normalization
// ------------------------------------------------------------
interface OpenAICompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function toOpenAICompletion(
  provider: ProviderName,
  data: Record<string, unknown>,
  requestedModel: string,
): OpenAICompletion {
  const base = {
    id: `chatcmpl-${crypto.randomUUID().slice(0, 12)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
  } as const;  switch (provider) {
    case 'anthropic': {
      const content = (data.content as Array<{ type?: string; text?: string }> | undefined)
        ?.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
      const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      return {
        ...base,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: usage?.input_tokens ?? 0,
          completion_tokens: usage?.output_tokens ?? 0,
          total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
        },
      };
    }
    case 'gemini': {
      const candidates = data.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined;
      const text = candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const usage = data.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
      return {
        ...base,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: usage?.promptTokenCount ?? 0,
          completion_tokens: usage?.candidatesTokenCount ?? 0,
          total_tokens: (usage?.promptTokenCount ?? 0) + (usage?.candidatesTokenCount ?? 0),
        },
      };
    }
    case 'ollama': {
      const content = (data.message as { content?: string } | undefined)?.content ?? '';
      const evalCount = data.eval_count as number | undefined;
      return {
        ...base,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: (data.prompt_eval_count as number | undefined) ?? 0,
          completion_tokens: evalCount ?? 0,
          total_tokens: ((data.prompt_eval_count as number | undefined) ?? 0) + (evalCount ?? 0),
        },
      };
    }
    default: {
      // OpenAI-compatible passthrough (OpenAI, DeepSeek, Groq, OpenRouter, Mistral, Cohere, vLLM).
      // Normalize the envelope so a non-conforming 200 body still yields a valid
      // chat.completion shape instead of being cast through unvalidated.
      const passthrough = data as Partial<OpenAICompletion>;
      return {
        ...base,
        id: typeof passthrough.id === 'string' ? passthrough.id : base.id,
        model: requestedModel,
        choices: Array.isArray(passthrough.choices) ? passthrough.choices : [],
        usage: passthrough.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    }
  }
}

export default app;
export { rotator, router, requestLog, toOpenAICompletion };

// ------------------------------------------------------------
// Server bootstrap - runs on `bun run src/index.ts` (Bun) or
// `npm run start:node` (Node via @hono/node-server).
// ------------------------------------------------------------
const isEntry =
  import.meta.url === new URL(`file://${process.argv[1]}`).href ||
  (typeof Bun !== 'undefined' && import.meta.main === true);

if (isEntry) {
  const listen = async () => {
    // When not behind a trusted proxy, tag each request with the real socket
    // IP so the allowlist / rate limiter cannot be bypassed with a spoofed
    // X-Forwarded-For header.
    const withSocketIp = async (request: Request, socketIp: string | null | undefined): Promise<Response> => {
      if (config.trustProxy || !socketIp) return app.fetch(request);
      const headers = new Headers(request.headers);
      headers.set('x-real-ip', socketIp);
      return app.fetch(new Request(request, { headers }));
    };

    if (typeof Bun !== 'undefined') {
      // Bun native serve adapter
      Bun.serve({
        port: config.port,
        hostname: config.host,
        fetch: (request, server) => {
          const ip = server?.requestIP?.(request)?.address;
          return withSocketIp(request, ip);
        },
      });
    } else {
      const { serve } = await import('@hono/node-server');
      serve({
        port: config.port,
        hostname: config.host,
        fetch: (request, env) => {
          const incoming = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
          return withSocketIp(request, incoming?.socket?.remoteAddress);
        },
      });
    }
    log('info', `Universal AI Gateway v10.0 listening on http://${config.host}:${config.port}`);
    log('info', `Endpoints: GET /v1/models | POST /v1/chat/completions | GET /health | GET /metrics`);
  };
  void listen();
}
