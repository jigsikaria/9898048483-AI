import { useEffect, useState, useCallback } from 'react';
import { Activity, Server, Timer, ArrowDownUp, Boxes } from 'lucide-react';
import { fetchMetrics, fetchLogs, fetchHealth, fetchModels } from '../lib/api';

interface Props {
  onSelectModel: (model: string) => void;
}

interface LogEntry {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  model: string;
  provider: string;
  status: number;
  latencyMs: number;
  streamed: boolean;
  attempt: number;
}

interface ProviderToggle {
  name: string;
  enabled: boolean;
}

const PROVIDER_LIST = ['anthropic', 'gemini', 'openai', 'deepseek', 'ollama', 'groq', 'openrouter', 'mistral', 'cohere'];

export default function GatewayDashboard({ onSelectModel }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [models, setModels] = useState<Array<{ id: string; provider: string; owned_by: string }>>([]);
  const [health, setHealth] = useState<Record<string, unknown>>({});
  const [metrics, setMetrics] = useState<Record<string, string>>({});
  const [toggles, setToggles] = useState<ProviderToggle[]>(
    PROVIDER_LIST.map((name) => ({ name, enabled: true })),
  );
  const [autoRefresh, setAutoRefresh] = useState(true);

  const refresh = useCallback(async () => {
    const [l, m, h, mt] = await Promise.all([
      fetchLogs(),
      fetchModels(),
      fetchHealth(),
      fetchMetrics(),
    ]);
    setLogs(l as LogEntry[]);
    setModels(m);
    setHealth(h);
    const parsed: Record<string, string> = {};
    for (const line of mt.split('\n')) {
      const match = /^(\w+)\s+([\d.]+)$/.exec(line.trim());
      if (match) parsed[match[1]] = match[2];
    }
    setMetrics(parsed);
  }, []);

  useEffect(() => {
    void refresh();
    if (!autoRefresh) return;
    const id = window.setInterval(refresh, 5000);
    return () => window.clearInterval(id);
  }, [refresh, autoRefresh]);

  const avgLatency = logs.length
    ? Math.round(logs.reduce((sum, l) => sum + l.latencyMs, 0) / logs.length)
    : 0;

  const providerHealth = (health.providers as Record<string, boolean>) ?? {};

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold tracking-widest text-matrix uppercase flex items-center gap-2">
          <GaugeIcon /> Gateway Control Center
        </h2>
        <label className="flex items-center gap-2 text-[11px] text-slate-400">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
            className="accent-matrix"
          />
          auto-refresh 5s
        </label>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={<Timer className="w-4 h-4" />} label="Avg Latency" value={`${avgLatency}ms`} />
        <StatCard icon={<Activity className="w-4 h-4" />} label="Requests" value={metrics.adapter_requests_total ?? '0'} />
        <StatCard
          icon={<ArrowDownUp className="w-4 h-4" />}
          label="Fallbacks"
          value={metrics.adapter_fallback_events_total ?? '0'}
        />
        <StatCard icon={<Boxes className="w-4 h-4" />} label="Models" value={String(models.length)} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Provider toggles */}
        <div className="panel p-4">
          <h3 className="text-xs font-bold text-slate-300 mb-3 tracking-widest uppercase">Provider Matrix</h3>
          <div className="grid grid-cols-3 gap-2">
            {toggles.map((t) => {
              const healthy = providerHealth[t.name];
              return (
                <button
                  key={t.name}
                  onClick={() => setToggles((prev) => prev.map((x) => (x.name === t.name ? { ...x, enabled: !x.enabled } : x)))}
                  className={`flex flex-col items-start gap-1 p-2 rounded-lg border text-left transition-colors ${
                    t.enabled
                      ? healthy
                        ? 'border-matrix/50 bg-matrix/5 text-matrix'
                        : 'border-cyber-border bg-black/30 text-slate-400'
                      : 'border-cyber-border bg-black/20 text-slate-600'
                  }`}
                >
                  <span className="text-[11px] font-semibold">{t.name}</span>
                  <span className="flex items-center gap-1 text-[9px]">
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        t.enabled ? (healthy ? 'bg-matrix' : 'bg-slate-600') : 'bg-slate-700'
                      }`}
                    />
                    {t.enabled ? (healthy ? 'ACTIVE' : 'KEY?') : 'OFF'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Model list */}
        <div className="panel p-4">
          <h3 className="text-xs font-bold text-slate-300 mb-3 tracking-widest uppercase">Model Catalog</h3>
          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
            {models.map((m) => (
              <button
                key={m.id}
                onClick={() => onSelectModel(m.id)}
                className="w-full flex items-center justify-between px-3 py-2 rounded-md bg-black/30 border border-cyber-border hover:border-matrix/50 hover:bg-matrix/5 text-left transition-colors group"
              >
                <span className="text-xs text-slate-300 group-hover:text-matrix">{m.id}</span>
                <span className="text-[9px] text-slate-500 uppercase">{m.provider}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Request log */}
      <div className="panel p-4">
        <h3 className="text-xs font-bold text-slate-300 mb-3 tracking-widest uppercase">Live Request Log</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead>
              <tr className="text-slate-500 border-b border-cyber-border">
                <th className="py-2 pr-4">time</th>
                <th className="py-2 pr-4">model</th>
                <th className="py-2 pr-4">provider</th>
                <th className="py-2 pr-4">status</th>
                <th className="py-2 pr-4">latency</th>
                <th className="py-2">attempt</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-slate-600">
                    no traffic yet - send a message in Chat Studio
                  </td>
                </tr>
              )}
              {logs.map((log) => (
                <tr key={log.id} className="border-b border-cyber-border/40">
                  <td className="py-2 pr-4 text-slate-500">
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </td>
                  <td className="py-2 pr-4 text-matrix">{log.model}</td>
                  <td className="py-2 pr-4 text-cyber-neon">{log.provider}</td>
                  <td className="py-2 pr-4">
                    <span
                      className={`px-1.5 py-0.5 rounded ${
                        log.status < 400 ? 'text-matrix bg-matrix/10' : 'text-red-400 bg-red-400/10'
                      }`}
                    >
                      {log.status}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-slate-300">{log.latencyMs}ms</td>
                  <td className="py-2 text-slate-500">{log.attempt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function GaugeIcon() {
  return <Server className="w-4 h-4" />;
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="panel p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-slate-500">
        {icon}
        <span className="text-[10px] uppercase tracking-widest">{label}</span>
      </div>
      <span className="text-2xl font-bold text-matrix neon-text">{value}</span>
    </div>
  );
}
