const encoder = new TextEncoder();
const decoder = new TextDecoder();
export function sseEncode(payload) {
    return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}
export function sseDone() {
    return encoder.encode('data: [DONE]\n\n');
}
export function sseKeepAlive() {
    return encoder.encode(': keep-alive\n\n');
}
/** Splits raw SSE bytes into lines, returning parsed `data:` payloads. */
async function* parseSseLines(stream) {
    const reader = stream.getReader();
    let buffer = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, boundary).trim();
                buffer = buffer.slice(boundary + 1);
                if (line === '')
                    continue;
                if (!line.startsWith('data:'))
                    continue;
                const data = line.slice(5).trim();
                if (data === '[DONE]')
                    return;
                if (data === '')
                    continue;
                try {
                    yield JSON.parse(data);
                }
                catch {
                    // Skip malformed keep-alive or partial frames.
                }
            }
        }
    }
    finally {
        reader.releaseLock();
    }
}
const makeChunk = (id, model, delta, finish = null, usage) => ({
    id: `chatcmpl-${id}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
});
/** Pipes a Uint8Array stream through a provider-specific converter. */
export function transformStream(source, provider, model, requestId, onError) {
    const lineGen = parseSseLines(source);
    let started = false;
    let chunkGen;
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
    return new ReadableStream({
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
            }
            catch (err) {
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
async function* passthroughToOpenAI(source, model, requestId) {
    for await (const raw of source) {
        const chunk = raw;
        if (!chunk || typeof chunk !== 'object')
            continue;
        const delta = chunk.choices?.[0]?.delta ?? {};
        const finish = chunk.choices?.[0]?.finish_reason ?? null;
        const reasoning = delta.reasoning_content;
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
            yield sseEncode(makeChunk(requestId, model, {}, null, chunk.usage));
        }
    }
}
/**
 * Anthropic SSE (`event: content_block_delta` / `message_delta`) to OpenAI SSE.
 * Handles text deltas and aggregates input/output usage from final events.
 */
async function* anthropicToOpenAI(source, model, requestId) {
    let finished = false;
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const raw of source) {
        const event = raw;
        if (!event || typeof event !== 'object')
            continue;
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
async function* geminiToOpenAI(source, model, requestId) {
    let roleSent = false;
    let finished = false;
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const raw of source) {
        const payload = raw;
        if (!payload || typeof payload !== 'object')
            continue;
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
export function withStreamFlag(body, stream) {
    return { ...body, stream };
}
/** Strips `stream: false` from a passthrough body and forces `stream: true`. */
export function forceStreaming(body) {
    return withStreamFlag(body, true);
}
//# sourceMappingURL=stream-transformer.js.map