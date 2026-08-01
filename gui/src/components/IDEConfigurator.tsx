import { useState, useEffect } from 'react';
import { Copy, Check, Code2 } from 'lucide-react';

interface ToolConfig {
  id: string;
  name: string;
  description: string;
  language: string;
  filename: string;
  content: (endpoint: string) => string;
}

const TOOLS: ToolConfig[] = [
  {
    id: 'continue',
    name: 'VS Code - Continue.dev',
    description: 'OpenAI-compatible config for the Continue extension.',
    language: 'json',
    filename: 'config.json',
    content: (endpoint) => `{
  "models": [
    {
      "title": "AdapterOS",
      "provider": "openai",
      "model": "claude-3-5-sonnet-20241022",
      "apiBase": "${endpoint}",
      "apiKey": "your-gateway-key"
    }
  ]
}`,
  },
  {
    id: 'copilot',
    name: 'VS Code - GitHub Copilot BYOK',
    description: 'Bring-your-own-key OpenAI-compatible endpoint.',
    language: 'json',
    filename: 'settings.json (user)',
    content: (endpoint) => `{
  "github.copilot.advanced.chat.chatModelOverride": "${endpoint}/v1/chat/completions",
  "github.copilot.advanced.chat.embeddingModelOverride": "${endpoint}/v1/embeddings",
  "github.copilot.advanced.chat.experimental": {
    "apiBaseUrl": "${endpoint}"
  }
}`,
  },
  {
    id: 'cursor',
    name: 'Cursor AI',
    description: 'OpenAI base URL override for Cursor.',
    language: 'json',
    filename: '.cursor/config.json',
    content: (endpoint) => `{
  "openaiBaseUrl": "${endpoint}",
  "openaiApiKey": "your-gateway-key"
}`,
  },
  {
    id: 'jetbrains',
    name: 'JetBrains IDEs',
    description: 'OpenAI plugin endpoint for IntelliJ / Android Studio.',
    language: 'text',
    filename: 'Settings > Tools > OpenAI',
    content: (endpoint) => `OpenAI plugin configuration:
  - Base URL: ${endpoint}
  - Model:    claude-3-5-sonnet-20241022
  - API Key:  your-gateway-key

Alternatively for Continue in JetBrains, use the same config.json
as the VS Code Continue snippet.`,
  },
  {
    id: 'android',
    name: 'Android Studio',
    description: 'Android Studio AI Assistant / Continue plugin.',
    language: 'text',
    filename: 'Continue config.json',
    content: (endpoint) => `{
  "models": [
    {
      "title": "AdapterOS",
      "provider": "openai",
      "model": "gemini-2.0-flash-exp",
      "apiBase": "${endpoint}",
      "apiKey": "your-gateway-key"
    }
  ]
}`,
  },
  {
    id: 'obsidian',
    name: 'Obsidian',
    description: 'Copilot / Text Generator plugin endpoint.',
    language: 'text',
    filename: 'Obsidian plugin settings',
    content: (endpoint) => `Text Generator / Copilot plugin:
  - Custom Endpoint: ${endpoint}/v1/chat/completions
  - API Key:         your-gateway-key
  - Model:           deepseek-chat`,
  },
  {
    id: 'chatbox',
    name: 'Chatbox Desktop',
    description: 'Add as a custom OpenAI-compatible provider.',
    language: 'text',
    filename: 'Chatbox settings',
    content: (endpoint) => `Add provider -> Custom:
  - Name:    AdapterOS
  - Type:    OpenAI API Compatible
  - API Host: ${endpoint}
  - API Key:  your-gateway-key
  - Model:    claude-3-5-sonnet-20241022`,
  },
  {
    id: 'zed',
    name: 'Zed Editor',
    description: 'OpenAI-compatible model config.',
    language: 'json',
    filename: 'settings.json',
    content: (endpoint) => `{
  "language_models": {
    "openai": {
      "api_base_url": "${endpoint}",
      "api_key": "your-gateway-key",
      "model": "claude-3-5-sonnet-20241022"
    }
  }
}`,
  },
];

const DEFAULT_ENDPOINT = 'http://localhost:8787/v1';

export default function IDEConfigurator() {
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copy = async (tool: ToolConfig) => {
    try {
      await navigator.clipboard.writeText(tool.content(endpoint));
      setCopiedId(tool.id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // clipboard unavailable (mobile webview) - show inline fallback
      setCopiedId('blocked');
      setTimeout(() => setCopiedId(null), 1800);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-sm font-bold tracking-widest text-matrix uppercase flex items-center gap-2">
          <Code2 className="w-4 h-4" /> IDE Integration Guide
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500">Gateway endpoint:</span>
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            className="bg-cyber-bg border border-cyber-border rounded-md px-2 py-1 text-xs text-cyber-neon focus:outline-none focus:border-matrix/50 w-56"
          />
        </div>
      </div>

      <p className="text-xs text-slate-400">
        One gateway, zero-config everywhere. Copy the snippet below into the matching IDE and start using any model.
      </p>

      <div className="grid md:grid-cols-2 gap-3">
        {TOOLS.map((tool) => (
          <div key={tool.id} className="panel p-4 flex flex-col gap-3">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-xs font-bold text-slate-200">{tool.name}</h3>
                <p className="text-[10px] text-slate-500 mt-1">{tool.description}</p>
                <span className="text-[9px] text-cyber-neon">{tool.filename}</span>
              </div>
              <button
                onClick={() => void copy(tool)}
                className={`flex items-center gap-1.5 text-[10px] px-2.5 py-1.5 rounded-md border transition-colors ${
                  copiedId === tool.id
                    ? 'border-matrix/60 text-matrix bg-matrix/10'
                    : 'border-cyber-border text-slate-300 hover:border-matrix/50 hover:text-matrix'
                }`}
              >
                {copiedId === tool.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedId === tool.id ? (copiedId === 'blocked' ? 'copied?' : 'copied') : 'copy'}
              </button>
            </div>
            <pre className="bg-black/50 rounded-lg p-3 overflow-x-auto text-[10px] leading-relaxed text-slate-300">
              <code>{tool.content(endpoint)}</code>
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
