import { useState, useEffect, useCallback } from 'react';
import { MessageSquare, Gauge, Plug, KeyRound, Boxes, BadgeDollarSign } from 'lucide-react';
import ChatStudio from './components/ChatStudio';
import GatewayDashboard from './components/GatewayDashboard';
import IDEConfigurator from './components/IDEConfigurator';
import KeyVault from './components/KeyVault';
import ProHub from './components/ProHub';
import { fetchHealth, getBaseUrl, setGatewayUrl } from './lib/api';

type Tab = 'chat' | 'gateway' | 'ide' | 'vault' | 'pro';

const TABS: Array<{ id: Tab; label: string; icon: typeof MessageSquare }> = [
  { id: 'chat', label: 'Chat Studio', icon: MessageSquare },
  { id: 'gateway', label: 'Gateway Control', icon: Gauge },
  { id: 'ide', label: 'IDE Guide', icon: Plug },
  { id: 'vault', label: 'Key Vault', icon: KeyRound },
  { id: 'pro', label: 'Pro Hub', icon: BadgeDollarSign },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('chat');
  const [health, setHealth] = useState<{ status: string } | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>('claude-3-5-sonnet-20241022');
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [gatewayUrl, setGatewayUrlInput] = useState<string>(getBaseUrl());
  const [showGatewaySettings, setShowGatewaySettings] = useState(false);

  const refreshHealth = useCallback(async () => {
    const h = await fetchHealth();
    setHealth({ status: String(h.status ?? 'offline') });
  }, []);

  useEffect(() => {
    void refreshHealth();
    const id = window.setInterval(refreshHealth, 10_000);
    return () => window.clearInterval(id);
  }, [refreshHealth]);

  const selectModel = (model: string) => {
    setSelectedModel(model);
    setTab('chat');
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-cyber-border bg-cyber-panel/80 backdrop-blur px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Boxes className="w-6 h-6 text-matrix" />
          <div>
            <h1 className="text-sm font-bold tracking-widest uppercase text-matrix neon-text">
              Adapter OS v10.0
            </h1>
            <p className="text-[10px] text-slate-500">Universal AI Gateway & Cross-Platform Suite</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowGatewaySettings((s) => !s)}
            className={`inline-flex items-center gap-2 text-[10px] px-2 py-1 rounded-full border transition-colors ${
              showGatewaySettings
                ? 'text-cyber-neon border-cyber-neon/50 bg-cyber-neon/10'
                : 'text-slate-400 border-cyber-border hover:text-slate-200'
            }`}
          >
            <Boxes className="w-3 h-3" />
            ENDPOINT
          </button>
          <span
            className={`inline-flex items-center gap-2 text-[10px] px-2 py-1 rounded-full border ${
              health?.status === 'healthy'
                ? 'text-matrix border-matrix/40 bg-matrix/10'
                : 'text-red-400 border-red-400/40 bg-red-400/10'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-current animate-pulse" />
            GATEWAY {health?.status === 'healthy' ? 'ONLINE' : 'OFFLINE'}
          </span>
        </div>
      </header>

      {showGatewaySettings && (
        <div className="border-b border-cyber-border bg-cyber-panel/60 px-4 py-2 flex items-center gap-2">
          <span className="text-[10px] text-slate-500 whitespace-nowrap">Gateway URL</span>
          <input
            value={gatewayUrl}
            onChange={(e) => setGatewayUrlInput(e.target.value)}
            onBlur={() => {
              setGatewayUrl(gatewayUrl);
              void refreshHealth();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setGatewayUrl(gatewayUrl);
                void refreshHealth();
              }
            }}
            placeholder="http://localhost:8787 (or remote URL)"
            className="flex-1 bg-cyber-bg border border-cyber-border rounded-md px-2 py-1 text-xs text-cyber-neon focus:outline-none focus:border-matrix/50 max-w-md"
          />
          <span className="text-[9px] text-slate-600">
            leave empty for same-origin (Vite dev proxy / Tauri bundled server)
          </span>
        </div>
      )}

      <nav className="flex items-center gap-1 px-4 pt-3 overflow-x-auto">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-t-lg border-b-2 transition-colors whitespace-nowrap ${
              tab === id
                ? 'border-matrix text-matrix bg-cyber-panel/60'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </nav>

      <main className="flex-1 p-4 max-w-6xl w-full mx-auto">
        {tab === 'chat' && (
          <ChatStudio
            model={selectedModel}
            provider={selectedProvider}
            onModelChange={setSelectedModel}
            onProviderChange={setSelectedProvider}
          />
        )}
        {tab === 'gateway' && <GatewayDashboard onSelectModel={selectModel} />}
        {tab === 'ide' && <IDEConfigurator />}
        {tab === 'vault' && <KeyVault />}
        {tab === 'pro' && <ProHub />}
      </main>
    </div>
  );
}
