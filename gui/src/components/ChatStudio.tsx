import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Square, Cpu, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage } from '../lib/api';
import { buildChatUrl } from '../lib/api';
import { getVaultKey } from '../lib/vault';

interface Props {
  model: string;
  provider: string;
  onModelChange: (model: string) => void;
  onProviderChange: (provider: string) => void;
}

interface DisplayMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
  streaming?: boolean;
}

const PROVIDERS = [
  'auto',
  'anthropic',
  'gemini',
  'openai',
  'deepseek',
  'groq',
  'openrouter',
  'ollama',
  'mistral',
  'cohere',
];

function resolveProvider(model: string, override: string): string {
  if (override && override !== 'auto') return override;
  const lower = model.toLowerCase();
  if (lower.includes('claude')) return 'anthropic';
  if (lower.includes('gemini')) return 'gemini';
  if (lower.includes('deepseek')) return 'deepseek';
  if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3')) return 'openai';
  if (lower.startsWith('ollama/')) return 'ollama';
  if (lower.includes('llama') || lower.includes('mixtral')) return 'groq';
  if (lower.includes('mistral')) return 'mistral';
  return 'openai';
}

const MODELS = [
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022',
  'gemini-2.0-flash-exp',
  'gemini-1.5-pro-latest',
  'gpt-4o',
  'gpt-4o-mini',
  'deepseek-chat',
  'deepseek-reasoner',
  'llama-3.3-70b-versatile',
  'ollama/deepseek-r1',
];

export default function ChatStudio({ model, provider, onModelChange, onProviderChange }: Props) {
  const [messages, setMessages] = useState<DisplayMessage[]>([
    {
      role: 'assistant',
      content:
        'Gateway online. Stream me a prompt and I will route it through the universal adapter chain.',
    },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [alert, setAlert] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const activeKey = getVaultKey(resolveProvider(model, provider));

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    setAlert(null);

    const history: DisplayMessage[] = messages.filter((m) => m.role !== 'system');
    const historyPayload: ChatMessage[] = history.map((m) => ({ role: m.role, content: m.content }));
    if (systemPrompt.trim()) {
      historyPayload.unshift({ role: 'system', content: systemPrompt });
    }

    const userMsg: DisplayMessage = { role: 'user', content: text };
    const assistantMsg: DisplayMessage = { role: 'assistant', content: '', reasoning: '', streaming: true };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    const controller = new AbortController();
    abortRef.current = controller;

    const accumulate = (delta: string, reasoning?: string) => {
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.streaming) {
          last.content += delta;
          if (reasoning) last.reasoning = (last.reasoning ?? '') + reasoning;
        }
        return next;
      });
    };

    const effectiveMessages = [...historyPayload, { role: 'user' as const, content: text }];

    try {
      const vaultKey = getVaultKey(resolveProvider(model, provider));
      const res = await fetch(buildChatUrl(provider || undefined), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(vaultKey ? { authorization: `Bearer ${vaultKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: effectiveMessages,
          temperature,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
        throw new Error(err?.error?.message ?? 'Request failed');
      }

      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

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
            if (delta?.content) accumulate(delta.content);
            if (delta?.reasoning_content) accumulate('', delta.reasoning_content);
          } catch {
            // ignore malformed frames
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        accumulate('\n\n_[stopped by user]_');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        accumulate(`\n\n_Error: ${message}_`);
        setAlert({ kind: 'error', text: message });
      }
    } finally {
      setMessages((prev) => prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
      setBusy(false);
      abortRef.current = null;
    }
  }, [input, messages, busy, model, systemPrompt, temperature]);

  const stop = () => {
    abortRef.current?.abort();
  };

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-160px)]">
      {/* Controls */}
      <div className="panel p-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-matrix" />
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            className="bg-cyber-bg border border-cyber-border rounded-md px-2 py-1.5 text-xs text-matrix focus:outline-none focus:border-matrix/60"
          >
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        <select
          value={provider}
          onChange={(e) => onProviderChange(e.target.value)}
          className="bg-cyber-bg border border-cyber-border rounded-md px-2 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-matrix/60"
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              provider: {p}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-[10px] text-slate-400">
          temp
          <input
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value))}
            className="accent-matrix"
          />
          {temperature.toFixed(1)}
        </label>

        <div className="flex-1" />

        <span
          className={`text-[10px] px-2 py-1 rounded-md border ${
            activeKey ? 'text-matrix border-matrix/40 bg-matrix/10' : 'text-slate-600 border-cyber-border'
          }`}
          title={activeKey ? 'Injected from Key Vault' : 'No vault key - server env keys will be used'}
        >
          {activeKey ? 'vault key active' : 'server keys'}
        </span>

        <button
          onClick={() => setMessages([{ role: 'assistant', content: 'Session reset. Ready for new input.' }])}
          className="text-[10px] text-slate-400 hover:text-slate-200 px-2 py-1 border border-cyber-border rounded-md"
        >
          clear
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto panel p-4 space-y-4">
        {alert && (
          <div
            className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-xs msg-in ${
              alert.kind === 'error'
                ? 'border-red-400/50 bg-red-500/10 text-red-300'
                : 'border-cyber-neon/50 bg-cyber-neon/10 text-cyber-neon'
            }`}
            role="alert"
          >
            <span className="leading-relaxed">{alert.text}</span>
            <button
              onClick={() => setAlert(null)}
              className="shrink-0 opacity-60 hover:opacity-100 text-[10px] uppercase tracking-wider"
            >
              dismiss
            </button>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-lg px-4 py-3 msg-in ${
                msg.role === 'user'
                  ? 'bg-cyber-neon/15 border border-cyber-neon/40'
                  : 'bg-black/40 border border-cyber-border'
              }`}
            >
              {msg.reasoning && (
                <details className="mb-2 text-[11px] text-slate-500">
                  <summary className="cursor-pointer text-slate-400">reasoning trace</summary>
                  <div className="mt-1 whitespace-pre-wrap font-mono">{msg.reasoning}</div>
                </details>
              )}
              {msg.content ? (
                <div className="code-scroll text-sm leading-relaxed">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                    components={{
                      a: (props) => (
                        <a {...props} className="text-cyber-neon underline" target="_blank" rel="noreferrer" />
                      ),
                      code: (props) => <code {...props} className="bg-black/50 px-1 py-0.5 rounded text-[12px]" />,
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                </div>
              ) : (
                msg.streaming && (
                  <div className="flex items-center gap-2 text-matrix text-sm">
                    <Sparkles className="w-4 h-4 animate-pulse" />
                    streaming
                    <span className="inline-flex gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-matrix animate-bounce" />
                      <span className="w-1.5 h-1.5 rounded-full bg-matrix animate-bounce [animation-delay:150ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-matrix animate-bounce [animation-delay:300ms]" />
                    </span>
                  </div>
                )
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* System prompt + input */}
      <div className="panel p-3 space-y-2">
        <input
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="system prompt (optional) - e.g. You are a senior Rust engineer..."
          className="w-full bg-cyber-bg border border-cyber-border rounded-md px-3 py-2 text-xs text-slate-300 focus:outline-none focus:border-matrix/50"
        />
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
            rows={2}
            className="flex-1 bg-cyber-bg border border-cyber-border rounded-md px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-matrix/50 resize-none"
          />
          {busy ? (
            <button
              onClick={stop}
              className="flex items-center gap-2 px-4 py-2.5 rounded-md bg-red-500/20 border border-red-400/50 text-red-300 text-xs font-semibold hover:bg-red-500/30"
            >
              <Square className="w-4 h-4" />
              Stop
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!input.trim()}
              className="flex items-center gap-2 px-4 py-2.5 rounded-md bg-matrix/15 border border-matrix/50 text-matrix text-xs font-semibold shadow-neon hover:bg-matrix/25 disabled:opacity-40 disabled:shadow-none"
            >
              <Send className="w-4 h-4" />
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
