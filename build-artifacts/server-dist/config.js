const int = (key, fallback) => {
    const raw = process.env[key];
    if (raw === undefined || raw === '')
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
};
const str = (key, fallback = '') => process.env[key] || fallback;
const bool = (key, fallback = false) => {
    const raw = process.env[key];
    if (raw === undefined)
        return fallback;
    return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
};
export const config = {
    port: int('PORT', 8787),
    host: str('HOST', '0.0.0.0'),
    gatewayApiKey: str('GATEWAY_API_KEY', 'adapter-os-local'),
    requiredGatewayKey: bool('REQUIRE_GATEWAY_KEY', false),
    allowedOrigins: str('ALLOWED_ORIGINS', '*'),
    ipAllowlist: str('IP_ALLOWLIST', '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    rateLimit: {
        enabled: bool('RATE_LIMIT_ENABLED', true),
        windowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
        max: int('RATE_LIMIT_MAX', 60),
    },
    logLevel: str('LOG_LEVEL', 'info'),
    prometheusEnabled: bool('PROMETHEUS_ENABLED', true),
    fallbackChain: str('FALLBACK_CHAIN', 'anthropic,gemini,deepseek,openrouter,ollama')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
};
export const keyFromEnv = (provider) => {
    const map = {
        anthropic: 'ANTHROPIC_API_KEY',
        gemini: 'GEMINI_API_KEY',
        openai: 'OPENAI_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY',
        ollama: 'OLLAMA_API_KEY',
        vllm: 'VLLM_API_KEY',
        groq: 'GROQ_API_KEY',
        openrouter: 'OPENROUTER_API_KEY',
        mistral: 'MISTRAL_API_KEY',
        cohere: 'COHERE_API_KEY',
    };
    const value = process.env[map[provider]] || '';
    return value
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean);
};
export const providers = {
    anthropic: {
        name: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        envKey: 'ANTHROPIC_API_KEY',
        apiKeyHeader: 'x-api-key',
        openAICompatible: false,
        supportsStreaming: true,
        defaultModel: 'claude-3-5-sonnet-20241022',
    },
    gemini: {
        name: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        envKey: 'GEMINI_API_KEY',
        apiKeyHeader: 'x-goog-api-key',
        openAICompatible: false,
        supportsStreaming: true,
        defaultModel: 'gemini-1.5-pro-latest',
    },
    openai: {
        name: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        envKey: 'OPENAI_API_KEY',
        apiKeyHeader: 'Authorization',
        openAICompatible: true,
        supportsStreaming: true,
        defaultModel: 'gpt-4o',
    },
    deepseek: {
        name: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        envKey: 'DEEPSEEK_API_KEY',
        apiKeyHeader: 'Authorization',
        openAICompatible: true,
        supportsStreaming: true,
        defaultModel: 'deepseek-chat',
    },
    ollama: {
        name: 'ollama',
        baseUrl: str('OLLAMA_BASE_URL', 'http://localhost:11434'),
        envKey: 'OLLAMA_API_KEY',
        apiKeyHeader: 'Authorization',
        openAICompatible: false,
        supportsStreaming: true,
        defaultModel: 'llama3',
    },
    vllm: {
        name: 'vllm',
        baseUrl: str('VLLM_BASE_URL', 'http://localhost:8000'),
        envKey: 'VLLM_API_KEY',
        apiKeyHeader: 'Authorization',
        openAICompatible: true,
        supportsStreaming: true,
        defaultModel: 'meta-llama/Llama-3.1-8B-Instruct',
    },
    groq: {
        name: 'groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        envKey: 'GROQ_API_KEY',
        apiKeyHeader: 'Authorization',
        openAICompatible: true,
        supportsStreaming: true,
        defaultModel: 'llama-3.3-70b-versatile',
    },
    openrouter: {
        name: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
        apiKeyHeader: 'Authorization',
        openAICompatible: true,
        supportsStreaming: true,
        defaultModel: 'anthropic/claude-3.5-sonnet',
    },
    mistral: {
        name: 'mistral',
        baseUrl: 'https://api.mistral.ai/v1',
        envKey: 'MISTRAL_API_KEY',
        apiKeyHeader: 'Authorization',
        openAICompatible: true,
        supportsStreaming: true,
        defaultModel: 'mistral-large-latest',
    },
    cohere: {
        name: 'cohere',
        baseUrl: 'https://api.cohere.com/v2',
        envKey: 'COHERE_API_KEY',
        apiKeyHeader: 'Authorization',
        openAICompatible: true,
        supportsStreaming: true,
        defaultModel: 'command-r-plus',
    },
};
export const allModels = [
    { id: 'claude-3-5-sonnet-20241022', owned_by: 'anthropic', provider: 'anthropic' },
    { id: 'claude-3-5-haiku-20241022', owned_by: 'anthropic', provider: 'anthropic' },
    { id: 'claude-3-opus-20240229', owned_by: 'anthropic', provider: 'anthropic' },
    { id: 'gemini-1.5-pro-latest', owned_by: 'google', provider: 'gemini' },
    { id: 'gemini-1.5-flash-latest', owned_by: 'google', provider: 'gemini' },
    { id: 'gemini-2.0-flash-exp', owned_by: 'google', provider: 'gemini' },
    { id: 'gpt-4o', owned_by: 'openai', provider: 'openai' },
    { id: 'gpt-4o-mini', owned_by: 'openai', provider: 'openai' },
    { id: 'o1-preview', owned_by: 'openai', provider: 'openai' },
    { id: 'deepseek-chat', owned_by: 'deepseek', provider: 'deepseek' },
    { id: 'deepseek-reasoner', owned_by: 'deepseek', provider: 'deepseek' },
    { id: 'llama-3.3-70b-versatile', owned_by: 'meta', provider: 'groq' },
    { id: 'mixtral-8x7b-32768', owned_by: 'mistral', provider: 'groq' },
    { id: 'ollama/llama3', owned_by: 'local', provider: 'ollama' },
    { id: 'ollama/deepseek-r1', owned_by: 'local', provider: 'ollama' },
];
export function detectProvider(model, header) {
    if (header) {
        const normalized = header.toLowerCase();
        if (normalized in providers)
            return normalized;
    }
    const lower = model.toLowerCase();
    if (lower.includes('claude'))
        return 'anthropic';
    if (lower.includes('gemini'))
        return 'gemini';
    if (lower.includes('deepseek'))
        return 'deepseek';
    if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3'))
        return 'openai';
    if (lower.startsWith('ollama/'))
        return 'ollama';
    if (lower.includes('llama') || lower.includes('mixtral') || lower.includes('qwen'))
        return 'groq';
    if (lower.includes('mistral'))
        return 'mistral';
    if (lower.includes('command'))
        return 'cohere';
    return 'openai';
}
//# sourceMappingURL=config.js.map