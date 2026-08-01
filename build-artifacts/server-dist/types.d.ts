export type ProviderName = 'anthropic' | 'gemini' | 'openai' | 'deepseek' | 'ollama' | 'vllm' | 'groq' | 'openrouter' | 'mistral' | 'cohere';
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;
}
export interface ChatCompletionRequest {
    model: string;
    messages: ChatMessage[];
    temperature?: number;
    max_tokens?: number;
    max_output_tokens?: number;
    stream?: boolean;
    top_p?: number;
    stop?: string | string[];
    frequency_penalty?: number;
    presence_penalty?: number;
    n?: number;
    tools?: unknown[];
    tool_choice?: unknown;
}
export interface ProviderConfig {
    name: ProviderName;
    baseUrl: string;
    envKey: string;
    apiKeyHeader: string;
    openAICompatible: boolean;
    supportsStreaming: boolean;
    defaultModel: string;
}
export interface GatewayContext {
    provider: ProviderName;
    requestBody: ChatCompletionRequest;
    systemPrompt: string;
    messages: ChatMessage[];
    resolvedKey: string | null;
    attempt: number;
}
export interface ModelDescriptor {
    id: string;
    object?: 'model';
    owned_by: string;
    provider: ProviderName;
}
export interface KeyStatus {
    provider: ProviderName;
    healthy: boolean;
    lastUsedAt: number | null;
    failures: number;
}
export interface RequestLogEntry {
    id: string;
    timestamp: number;
    method: string;
    path: string;
    model: string;
    provider: ProviderName;
    status: number;
    latencyMs: number;
    streamed: boolean;
    attempt: number;
}
