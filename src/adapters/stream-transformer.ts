import type { ProviderName } from '../types.ts';

/**
 * StreamTransformer - Universal SSE streaming converter.
 *
 * Normalizes the SSE output of every provider into the OpenAI
 * `text/event-stream` protocol (`data: {...}\n\n` with a final `[DONE]`),
 * including chunk-id, role, content deltas and usage accounting.
 */

export interface OpenAIChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string | null; reasoning_content?: string | null };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function sseEncode(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export function sseDone(): Uint8Array {
  return encoder.encode('data: [DONE]\n\n');
}

export function sseKeepAlive(): Uint8Array {
  return encoder.encode(': keep-alive\n\n');
}

/** Splits raw SSE bytes into lines, returning parsed `data:` payloads. */
async function* parseSseLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = stream.getReader();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (line === '') continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        if (data === '') continue;
        try {
          yield JSON.parse(data);
        } catch {
          // Skip malformed keep-alive or partial frames.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const makeChunk = (
  id: string,
  model: string,
  delta: OpenAIChatChunk['choices'][0]['delta'],
  finish: string | null = null,
  usage?: OpenAIChatChunk['usage'],
): OpenAIChatChunk => ({
  id: `chatcmpl-${id}`,
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(usage ? { usage } : {}),
});

/** Pipes a Uint8Array stream through a provider-specific converter. */
export function transformStream(
  source: ReadableStream<Uint8Array>,
  provider: ProviderName,
  model: string,
  requestId: string,
  onError?: (err: unknown) => void,
): ReadableStream<Uint8Array> {
  const lineGen = parseSseLines(source);
  let started = false;

  let chunkGen: AsyncGenerator<Uint8Array>;
  switch (provider) {
    case 'anthropic':
      chunkGen = anthropicToOpenAI(lineGen, model, requestId);
      break;
    case 'gemini':
      chunkGen = geminiToOpenAI(lineGen, model, requestId);
      break;
    default:
      chunkGen = passthroughToOpenAI(lineGen, model, requestId);
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(sseKeepAlive());
      }
      try {
        const { done, value } = await chunkGen.next();
        if (done) {
          controller.enqueue(sseDone());
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        onError?.(err);
        controller.enqueue(sseDone());
        controller.error(err);
      }
    },
    cancel() {
      void chunkGen.return?.(undefined);
    },
  });
}

/**
 * OpenAI-compatible passthrough (OpenAI, DeepSeek, Groq, OpenRouter, Mistral,
 * vLLM, Cohere). Extracts `reasoning_content` for DeepSeek reasoner models
 * so clients can render think-token traces.
 */
async function* passthroughToOpenAI(
  source: AsyncGenerator<unknown>,
  model: string,
  requestId: string,
): AsyncGenerator<Uint8Array> {
  for await (const raw of source) {
    const chunk = raw as Partial<OpenAIChatChunk>;
    if (!chunk || typeof chunk !== 'object') continue;
    const delta = chunk.choices?.[0]?.delta ?? {};
    const finish = chunk.choices?.[0]?.finish_reason ?? null;

    const reasoning = (delta as Record<string, unknown>).reasoning_content;
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      yield sseEncode(makeChunk(requestId, model, { role: 'assistant', reasoning_content: reasoning }));
    }
    const content = delta.content;
    if (typeof content === 'string' && content.length > 0) {
      yield sseEncode(makeChunk(requestId, model, { content }));
    }
    if (finish) {
      yield sseEncode(makeChunk(requestId, model, {}, finish));
    }
    if (chunk.usage) {
      yield sseEncode(makeChunk(requestId, model, {}, null, chunk.usage as OpenAIChatChunk['usage']));
    }
  }
}

/**
 * Anthropic SSE (`event: content_block_delta` / `message_delta`) to OpenAI SSE.
 * Handles text deltas and aggregates input/output usage from final events.
 */
async function* anthropicToOpenAI(
  source: AsyncGenerator<unknown>,
  model: string,
  requestId: string,
): AsyncGenerator<Uint8Array> {
  let finished = false;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const raw of source) {
    const event = raw as { type: string; delta?: { type: string; text?: string }; usage?: { input_tokens: number; output_tokens: number }; message?: { usage?: { input_tokens: number; output_tokens: number } } };
    if (!event || typeof event !== 'object') continue;

    switch (event.type) {
      case 'message_start': {
        const usage = event.message?.usage;
        if (usage) {
          inputTokens = usage.input_tokens ?? 0;
          outputTokens = usage.output_tokens ?? 0;
        }
        yield sseEncode(makeChunk(requestId, model, { role: 'assistant' }));
        break;
      }
      case 'content_block_delta': {
        if (event.delta?.type === 'text_delta' && event.delta.text) {
          yield sseEncode(makeChunk(requestId, model, { content: event.delta.text }));
        }
        break;
      }
      case 'message_delta': {
        if (event.usage) {
          inputTokens = event.usage.input_tokens ?? inputTokens;
          outputTokens = event.usage.output_tokens ?? outputTokens;
        }
        if (!finished) {
          finished = true;
          yield sseEncode(makeChunk(requestId, model, {}, 'stop'));
        }
        break;
      }
      case 'message_stop': {
        if (!finished) {
          finished = true;
          yield sseEncode(makeChunk(requestId, model, {}, 'stop'));
        }
        break;
      }
      default:
        break;
    }
  }

  if (inputTokens > 0 || outputTokens > 0) {
    yield sseEncode(makeChunk(requestId, model, {}, null, {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    }));
  }
}

/**
 * Gemini SSE (`data: {...}` lines with candidates[].content.parts[].text) to
 * OpenAI SSE. Also ingests `usageMetadata` when present.
 */
async function* geminiToOpenAI(
  source: AsyncGenerator<unknown>,
  model: string,
  requestId: string,
): AsyncGenerator<Uint8Array> {
  let roleSent = false;
  let finished = false;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const raw of source) {
    const payload = raw as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      text?: string;
    };
    if (!payload || typeof payload !== 'object') continue;

    if (payload.usageMetadata) {
      inputTokens = payload.usageMetadata.promptTokenCount ?? 0;
      outputTokens = payload.usageMetadata.candidatesTokenCount ?? 0;
    }

    const text = payload.text ?? payload.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (text) {
      if (!roleSent) {
        roleSent = true;
        yield sseEncode(makeChunk(requestId, model, { role: 'assistant' }));
      }
      yield sseEncode(makeChunk(requestId, model, { content: text }));
    }

    const finishReason = payload.candidates?.[0]?.finishReason;
    if (finishReason && !finished) {
      finished = true;
      yield sseEncode(makeChunk(requestId, model, {}, 'stop'));
    }
  }

  if (!finished) {
    yield sseEncode(makeChunk(requestId, model, {}, 'stop'));
  }
  if (inputTokens > 0 || outputTokens > 0) {
    yield sseEncode(makeChunk(requestId, model, {}, null, {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    }));
  }
}

/**
 * Converts an OpenAI-compatible request stream flag for providers that need
 * `stream: true` forced before forwarding.
 */
export function withStreamFlag(body: Record<string, unknown>, stream: boolean): Record<string, unknown> {
  return { ...body, stream };
}

/** Strips `stream: false` from a passthrough body and forces `stream: true`. */
export function forceStreaming(body: Record<string, unknown>): Record<string, unknown> {
  return withStreamFlag(body, true);
}
