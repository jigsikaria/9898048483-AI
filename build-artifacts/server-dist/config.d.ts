import type { ProviderConfig, ProviderName, ModelDescriptor } from './types.ts';
export declare const config: {
    port: number;
    host: string;
    gatewayApiKey: string;
    requiredGatewayKey: boolean;
    allowedOrigins: string;
    ipAllowlist: string[];
    rateLimit: {
        enabled: boolean;
        windowMs: number;
        max: number;
    };
    logLevel: string;
    prometheusEnabled: boolean;
    fallbackChain: ProviderName[];
};
export declare const keyFromEnv: (provider: ProviderName) => string[];
export declare const providers: Record<ProviderName, ProviderConfig>;
export declare const allModels: ModelDescriptor[];
export declare function detectProvider(model: string, header?: string): ProviderName;
