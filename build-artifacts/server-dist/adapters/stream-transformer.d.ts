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
        delta: {
            role?: string;
            content?: string | null;
            reasoning_content?: string | null;
        };
        finish_reason: string | null;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
export declare function sseEncode(payload: unknown): Uint8Array;
export declare function sseDone(): Uint8Array;
export declare function sseKeepAlive(): Uint8Array;
/** Pipes a Uint8Array stream through a provider-specific converter. */
export declare function transformStream(source: ReadableStream<Uint8Array>, provider: ProviderName, model: string, requestId: string, onError?: (err: unknown) => void): ReadableStream<Uint8Array>;
/**
 * Converts an OpenAI-compatible request stream flag for providers that need
 * `stream: true` forced before forwarding.
 */
export declare function withStreamFlag(body: Record<string, unknown>, stream: boolean): Record<string, unknown>;
/** Strips `stream: false` from a passthrough body and forces `stream: true`. */
export declare function forceStreaming(body: Record<string, unknown>): Record<string, unknown>;
