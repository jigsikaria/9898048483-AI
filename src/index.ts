import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config, allModels, detectProvider, providers } from './config.ts';
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
  const ip = (c.req.header('x-forwarded-for')?.split(',')[0] ?? c.req.header('x-real-ip') ?? 'unknown').trim();

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

  if (customEndpoint && providers[primary]) {
    providers[primary].baseUrl = customEndpoint;
  }

  const providerConfig = providers[primary];
  const baseUrl = providerConfig.baseUrl.replace(/\/$/, '');
  const key = rotator.next(primary);
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

  const authHeader = c.req.header('authorization') ?? c.req.header('x-api-key');
  const overrideProvider = c.req.header('x-provider');
  const customEndpoint = c.req.header('x-custom-endpoint');
  const fallbackHeader = c.req.header('x-fallback');

  const chatBody = pickBody(body);
  const primary = detectProvider(chatBody.model, overrideProvider);
  const chain = buildChain(primary, fallbackHeader);

  if (chatBody.messages.length === 0) {
    return c.json({ error: { message: 'messages is required', type: 'invalid_request' } }, 400);
  }

  // Allow a per-request override of the provider base URL (e.g. LAN Ollama).
  if (customEndpoint && providers[primary]) {
    providers[primary].baseUrl = customEndpoint;
  }

  // Inject per-request key into the rotator pool (single-use, volatile).
  if (authHeader && !authHeader.replace(/^Bearer\s+/i, '').startsWith('sk-env')) {
    const userKey = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (userKey && userKey !== config.gatewayApiKey) {
      rotator.inject?.(primary, userKey);
    }
  }

  try {
    const { provider, response, attempt } = await router.tryChain(chain, chatBody, c.req.raw.headers);
    if (attempt > 1) fallbackEvents += 1;

    if (!response.ok) {
      const errorBody = await response.text();
      logRequest({ method: 'POST', path: '/v1/chat/completions', model: chatBody.model, provider, status: response.status, latencyMs: Date.now() - startedAt, streamed: false, attempt });
      return c.json(JSON.parse(errorBody || '{}'), response.status as 400);
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
          (err) => console.error(`[adapter-os] stream error (${provider}):`, err),
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
  } as const;

  switch (provider) {
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
      return data as unknown as OpenAICompletion;
    }
  }
}

export default app;
export { rotator, router, requestLog };

// ------------------------------------------------------------
// Server bootstrap - runs on `bun run src/index.ts` (Bun) or
// `npm run start:node` (Node via @hono/node-server).
// ------------------------------------------------------------
const isEntry =
  import.meta.url === new URL(`file://${process.argv[1]}`).href ||
  (typeof Bun !== 'undefined' && import.meta.main === true);

if (isEntry) {
  const listen = async () => {
    if (typeof Bun !== 'undefined') {
      // Bun native serve adapter
      Bun.serve({
        port: config.port,
        hostname: config.host,
        fetch: app.fetch,
      });
    } else {
      const { serve } = await import('@hono/node-server');
      serve({ port: config.port, hostname: config.host, fetch: app.fetch });
    }
    console.log(`[adapter-os] Universal AI Gateway v10.0 listening on http://${config.host}:${config.port}`);
    console.log(`[adapter-os] Endpoints: GET /v1/models | POST /v1/chat/completions | GET /health | GET /metrics`);
  };
  void listen();
}
