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
export declare class FallbackRouter {
    private readonly rotator;
    private readonly quarantine;
    constructor(rotator: MultiKeyRotator);
    private isQuarantined;
    /** Default failover predicate: any 4xx/5xx or empty body. */
    static defaultPredicate: FallbackPredicate;
    private buildHeaders;
    private rewriteUrl;
    private buildUpstreamRequest;
    /**
     * Try the chain of providers until one succeeds or the chain is exhausted.
     * The returned Response is a raw upstream response; callers must convert
     * SSE streams via StreamTransformer.
     */
    tryChain(chain: ProviderName[], request: ChatCompletionRequest, headers: Headers, predicate?: FallbackPredicate): Promise<FallbackChainResult>;
    status(): Array<{
        provider: ProviderName;
        quarantined: boolean;
    }>;
}
