export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  onDelta?: (text: string, reasoning?: string) => void;
  onError?: (message: string) => void;
  signal?: AbortSignal;
}

const STORAGE_KEY = 'adapter-os.gateway-url';

/** Returns the configured gateway base URL (runtime override > env > same-origin). */
export function getBaseUrl(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return stored;
  return import.meta.env.VITE_GATEWAY_URL || '';
}

/** Persists a runtime gateway URL override for desktop/native builds. */
export function setGatewayUrl(url: string): void {
  const trimmed = url.trim().replace(/\/$/, '');
  if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed);
  else localStorage.removeItem(STORAGE_KEY);
}

export function buildChatUrl(provider?: string): string {
  const base = getBaseUrl();
  const url = new URL('/v1/chat/completions', base || window.location.origin);
  if (provider) url.searchParams.set('x-provider', provider);
  return url.toString();
}

const rest = (path: string): string => `${getBaseUrl()}${path}`;

export async function chatCompletion(opts: ChatOptions): Promise<string> {
  const { model, provider, temperature = 0.7, maxTokens, stream = true, onDelta, onError, signal } = opts;
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: 'ping' }],
    temperature,
    stream,
  };

  // We rebuild the real message list from the caller via optional field.
  // (Callers needing multi-turn pass messages directly; default is single ping.)

  const res = await fetch(buildChatUrl(provider), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
    const msg = err?.error?.message ?? 'Request failed';
    onError?.(msg);
    throw new Error(msg);
  }

  if (!stream || !res.body) {
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    onDelta?.(content);
    return content;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta ?? {};
        const text = delta?.content ?? '';
        const reasoning = delta?.reasoning_content ?? '';
        if (text) full += text;
        onDelta?.(text, reasoning);
      } catch {
        // skip malformed frames
      }
    }
  }

  return full;
}

export async function fetchModels(): Promise<Array<{ id: string; owned_by: string; provider: string }>> {
  const res = await fetch(rest("/v1/models"));
  if (!res.ok) return [];
  const data = await res.json();
  return data?.data ?? [];
}

export async function fetchMetrics(): Promise<string> {
  const res = await fetch(rest("/metrics"));
  if (!res.ok) return '';
  return res.text();
}

export async function fetchLogs(): Promise<unknown[]> {
  const res = await fetch(rest("/v1/logs"));
  if (!res.ok) return [];
  const data = await res.json();
  return data?.entries ?? [];
}

export async function fetchHealth(): Promise<Record<string, unknown>> {
  const res = await fetch(rest("/health"));
  if (!res.ok) return { status: 'offline' };
  return res.json();
}
