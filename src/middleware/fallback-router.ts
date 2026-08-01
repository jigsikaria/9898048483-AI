import { providers } from '../config.ts';
import { MultiKeyRotator } from './key-rotator.ts';
import type { ChatCompletionRequest, ProviderName } from '../types.ts';

export interface UpstreamResponse {
  provider: ProviderName;
  response: Response;
  key: string | null;
}

export interface FallbackChainResult {
  provider: ProviderName;
  response: Response;
  attempt: number;
}

export type FallbackPredicate = (status: number, bodyText: string) => boolean;

/**
 * FallbackRouter - Automatic error detection and route failover.
 *
 * On a failed upstream attempt it moves to the next provider in the chain
 * (or the provider specified via the x-provider header / x-fallback header).
 * The failed provider is quarantined in-memory so subsequent requests skip it.
 */
export class FallbackRouter {
  private readonly rotator: MultiKeyRotator;
  private readonly quarantine = new Map<ProviderName, number>();

  constructor(rotator: MultiKeyRotator) {
    this.rotator = rotator;
  }

  private isQuarantined(provider: ProviderName): boolean {
    const until = this.quarantine.get(provider);
    if (until === undefined) return false;
    if (until <= Date.now()) {
      this.quarantine.delete(provider);
      return false;
    }
    return true;
  }

  /** Default failover predicate: any 4xx/5xx or empty body. */
  static defaultPredicate: FallbackPredicate = (status, bodyText) => {
    if (status === 400 && bodyText.toLowerCase().includes('context_length_exceeded')) return true;
    return status >= 400;
  };

  private buildHeaders(provider: ProviderName, key: string, headers: Headers): Headers {
    const upstream = new Headers(headers);
    const providerConfig = providers[provider];

    if (providerConfig.name === 'anthropic') {
      upstream.set('x-api-key', key);
      upstream.set('anthropic-version', '2023-06-01');
    } else if (providerConfig.name === 'gemini') {
      upstream.set('x-goog-api-key', key);
    } else if (providerConfig.name === 'ollama' || providerConfig.name === 'vllm') {
      upstream.delete('authorization');
      upstream.set('authorization', `Bearer ${key || 'ollama'}`);
    } else {
      upstream.set('authorization', `Bearer ${key}`);
    }
    upstream.set('content-type', 'application/json');
    return upstream;
  }

  private rewriteUrl(provider: ProviderName, baseUrl: string): string {
    if (provider === 'ollama') {
      return `${baseUrl}/api/chat`;
    }
    return `${baseUrl}/chat/completions`;
  }

  private async buildUpstreamRequest(
    provider: ProviderName,
    request: ChatCompletionRequest,
    headers: Headers,
    key: string | null,
  ): Promise<Request> {
    const providerConfig = providers[provider];
    const baseUrl = providerConfig.baseUrl.replace(/\/$/, '');
    const url = this.rewriteUrl(provider, baseUrl);
    const upstreamHeaders = this.buildHeaders(provider, key ?? '', headers);

    let body: unknown = request;
    let finalUrl = url;

    // Gemini uses path-embedded keys and a native message format.
    if (provider === 'gemini') {
      const modelId = request.model.replace(/^gemini-/, 'gemini-');
      finalUrl = `${baseUrl}/models/${modelId}:streamGenerateContent?alt=sse${key ? `&key=${encodeURIComponent(key ?? '')}` : ''}`;
      const contents = request.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));
      const systemText = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      body = {
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        generationConfig: {
          temperature: request.temperature ?? 0.7,
          ...(request.max_tokens ? { maxOutputTokens: request.max_tokens } : {}),
          ...(request.top_p !== undefined ? { topP: request.top_p } : {}),
          ...(request.stop ? { stopSequences: Array.isArray(request.stop) ? request.stop : [request.stop] } : {}),
        },
      };
    }

    // Anthropic uses the messages API with a separate system field.
    if (provider === 'anthropic') {
      const systemText = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const messages = request.messages.filter((m) => m.role !== 'system');
      finalUrl = `${baseUrl}/messages`;
      body = {
        model: request.model,
        max_tokens: request.max_tokens ?? 4096,
        temperature: request.temperature ?? 0.7,
        ...(systemText ? { system: systemText } : {}),
        messages,
        ...(request.stream ? { stream: true } : {}),
      };
    }

    // Ollama native chat API.
    if (provider === 'ollama') {
      const messages = [
        ...request.messages.filter((m) => m.role === 'system').map((m) => ({ role: 'system' as const, content: m.content })),
        ...request.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
      ];
      body = {
        model: request.model.replace(/^ollama\//, ''),
        messages,
        stream: request.stream ?? false,
        options: {
          temperature: request.temperature ?? 0.7,
          num_predict: request.max_tokens,
        },
      };
    }

    return new Request(finalUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });
  }

  /**
   * Try the chain of providers until one succeeds or the chain is exhausted.
   * The returned Response is a raw upstream response; callers must convert
   * SSE streams via StreamTransformer.
   */
  async tryChain(
    chain: ProviderName[],
    request: ChatCompletionRequest,
    headers: Headers,
    predicate: FallbackPredicate = FallbackRouter.defaultPredicate,
  ): Promise<FallbackChainResult> {
    let lastError: { status: number; body: string } | null = null;
    let missingKey = false;
    let attempt = 1;

    for (const provider of chain) {
      if (this.isQuarantined(provider)) {
        attempt += 1;
        continue;
      }

      const requiresKey = provider !== 'ollama' && provider !== 'vllm';
      const key = this.rotator.next(provider);
      if (requiresKey && !key) {
        missingKey = true;
        attempt += 1;
        continue;
      }

      const upstream = await this.buildUpstreamRequest(provider, request, headers, key);
      let response: Response;
      try {
        response = await fetch(upstream);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = { status: 502, body: JSON.stringify({ error: { message, type: 'network_error' } }) };
        this.rotator.record(provider, key ?? '', 502);
        attempt += 1;
        continue;
      }

      this.rotator.record(provider, key ?? '', response.status);

      if (response.ok) {
        return { provider, response, attempt };
      }

      const bodyText = await response.clone().text();
      lastError = { status: response.status, body: bodyText };

      if (predicate(response.status, bodyText)) {
        this.quarantine.set(provider, Date.now() + 30_000);
      }
      attempt += 1;
    }

    const missingKeyError =
      missingKey && lastError === null
        ? JSON.stringify({
            error: {
              message: 'API Key missing for provider. Please add your key in the Key Vault tab or .env file.',
              type: 'missing_api_key',
              attempt,
            },
          })
        : null;

    const fallback: Response = new Response(
      missingKeyError ??
        JSON.stringify({
          error: {
            message: lastError?.body || 'All providers failed',
            type: 'fallback_chain_exhausted',
            attempt,
          },
        }),
      { status: lastError?.status ?? 502, headers: { 'content-type': 'application/json' } },
    );
    return { provider: chain[0] ?? 'openai', response: fallback, attempt };
  }

  status(): Array<{ provider: ProviderName; quarantined: boolean }> {
    return [...this.quarantine.keys()].map((provider) => ({ provider, quarantined: true }));
  }
}
