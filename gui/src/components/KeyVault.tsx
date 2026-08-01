import { useState, useEffect, useCallback } from 'react';
import { KeyRound, Eye, EyeOff, Plus, Trash2, Lock, Unlock } from 'lucide-react';
import {
  unlockVault,
  lockVault,
  isUnlocked,
  listVault,
  addVaultEntry,
  removeVaultEntry,
  hasStoredVault,
} from '../lib/vault';
import type { VaultEntry } from '../lib/vault';

const PROVIDERS = ['anthropic', 'gemini', 'openai', 'deepseek', 'groq', 'openrouter', 'mistral', 'cohere'];

export default function KeyVault() {
  const [passphrase, setPassphrase] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [provider, setProvider] = useState(PROVIDERS[0] ?? 'anthropic');
  const [newKey, setNewKey] = useState('');
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: '' });

  const sync = useCallback(() => {
    setEntries(listVault());
    setUnlocked(isUnlocked());
  }, []);

  useEffect(() => {
    sync();
  }, [sync]);

  const flash = (text: string, error = false) => {
    setStatus({ text, error });
    setTimeout(() => setStatus({ text: '' }), 2500);
  };

  const unlock = async () => {
    try {
      await unlockVault(passphrase);
      sync();
      flash('vault unlocked');
    } catch {
      flash('wrong passphrase or corrupted vault', true);
    }
  };

  const add = () => {
    if (!newKey.trim()) return;
    void addVaultEntry(provider, newKey.trim())
      .then(() => {
        sync();
        setNewKey('');
        flash('key added & encrypted locally');
      })
      .catch(() => flash('failed to save', true));
  };

  const remove = (entry: VaultEntry) => {
    void removeVaultEntry(entry.provider, entry.key)
      .then(() => {
        sync();
        flash('key removed');
      })
      .catch(() => flash('failed to remove', true));
  };

  const exportVault = () => {
    navigator.clipboard?.writeText(entries.map((e) => `${e.provider}=${e.key}`).join('\n')).catch(() => undefined);
    flash('exported to clipboard');
  };

  return (
    <div className="flex flex-col gap-4 max-w-2xl">
      <h2 className="text-sm font-bold tracking-widest text-matrix uppercase flex items-center gap-2">
        <KeyRound className="w-4 h-4" /> Key Vault
      </h2>

      {!unlocked ? (
        <div className="panel p-6 flex flex-col gap-4">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Lock className="w-4 h-4 text-matrix" />
            Encrypted local storage (AES-256-GCM via Web Crypto). Your passphrase never leaves this device.
            {!hasStoredVault() && (
              <span className="text-cyber-neon">First time here: set a passphrase to initialize.</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              type={showPass ? 'text' : 'password'}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void unlock()}
              placeholder="enter passphrase to unlock (or first time: set one)"
              className="flex-1 bg-cyber-bg border border-cyber-border rounded-md px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-matrix/50"
            />
            <button
              onClick={() => setShowPass((s) => !s)}
              className="p-2 border border-cyber-border rounded-md text-slate-400 hover:text-matrix"
            >
              {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
            <button
              onClick={() => void unlock()}
              className="px-4 py-2 rounded-md bg-matrix/15 border border-matrix/50 text-matrix text-xs font-semibold shadow-neon"
            >
              Unlock
            </button>
          </div>
          {status.text && <span className={`text-[11px] ${status.error ? 'text-red-400' : 'text-matrix'}`}>{status.text}</span>}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {entries.length === 0 && (
            <div className="panel p-4 text-center text-xs text-slate-500">
              vault empty - add your first key below. Stored keys are injected automatically into Chat Studio requests.
            </div>
          )}
          {entries.map((entry, i) => (
            <div key={i} className="panel p-3 flex items-center gap-3">
              <span className="text-[10px] uppercase tracking-wider text-cyber-neon w-24">{entry.provider}</span>
              <code className="flex-1 text-[11px] text-slate-300 truncate">{entry.key}</code>
              <button onClick={() => remove(entry)} className="p-1.5 rounded text-slate-500 hover:text-red-400">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}

          <div className="panel p-4 flex flex-col gap-3">
            <div className="flex gap-2">
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="bg-cyber-bg border border-cyber-border rounded-md px-2 py-2 text-xs text-slate-300"
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="paste provider API key..."
                className="flex-1 bg-cyber-bg border border-cyber-border rounded-md px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-matrix/50"
              />
              <button
                onClick={add}
                className="flex items-center gap-1.5 px-3 py-2 rounded-md bg-matrix/15 border border-matrix/50 text-matrix text-xs font-semibold shadow-neon"
              >
                <Plus className="w-4 h-4" /> Add
              </button>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-500">
                keys are sent as <code className="text-cyber-neon">Authorization: Bearer &lt;key&gt;</code> for the matching
                provider - the gateway prefers per-request keys over server env keys.
              </span>
              <div className="flex items-center gap-2">
                <button onClick={exportVault} className="text-[11px] text-cyber-neon hover:underline">
                  export
                </button>
                <button
                  onClick={() => {
                    lockVault();
                    setPassphrase('');
                    sync();
                  }}
                  className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-red-400"
                >
                  <Unlock className="w-3 h-3" /> lock
                </button>
              </div>
            </div>
            {status.text && <span className={`text-[11px] ${status.error ? 'text-red-400' : 'text-matrix'}`}>{status.text}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
