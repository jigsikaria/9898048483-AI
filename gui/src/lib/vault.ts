export interface VaultEntry {
  provider: string;
  key: string;
  note?: string;
}

const STORAGE_KEY = 'adapter-os.vault.v1';
let passphrase: string | null = null;
let cache: VaultEntry[] = [];

function deriveKey(pass: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyBytes = new Uint8Array(new TextEncoder().encode(pass));
  const saltBytes = new Uint8Array(salt);
  return crypto.subtle.importKey('raw', keyBytes, 'PBKDF2', false, ['deriveKey']).then((baseKey) =>
    crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 100_000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    ),
  );
}

async function encrypt(entries: VaultEntry[]): Promise<void> {
  if (!passphrase) return;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(entries)),
  );
  const merged = new Uint8Array(salt.length + iv.length + cipher.byteLength);
  merged.set(salt, 0);
  merged.set(iv, salt.length);
  merged.set(new Uint8Array(cipher), salt.length + iv.length);
  localStorage.setItem(STORAGE_KEY, btoa(String.fromCharCode(...merged)));
}

async function decrypt(pass: string): Promise<VaultEntry[]> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  const salt = new Uint8Array(bytes.slice(0, 16));
  const iv = new Uint8Array(bytes.slice(16, 28));
  const cipher = bytes.slice(28);
  const key = await deriveKey(pass, salt);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(plain)) as VaultEntry[];
}

/** Unlocks the vault for the session. Throws on wrong passphrase. */
export async function unlockVault(pass: string): Promise<void> {
  const entries = await decrypt(pass);
  passphrase = pass;
  cache = entries;
}

/** Locks the vault (clears the in-memory passphrase). */
export function lockVault(): void {
  passphrase = null;
  cache = [];
}

export function isUnlocked(): boolean {
  return passphrase !== null;
}

export function listVault(): VaultEntry[] {
  return cache;
}

export async function addVaultEntry(provider: string, key: string, note?: string): Promise<void> {
  cache = [...cache.filter((e) => !(e.provider === provider && e.key === key)), { provider, key, note }];
  await encrypt(cache);
}

export async function removeVaultEntry(provider: string, key: string): Promise<void> {
  cache = cache.filter((e) => !(e.provider === provider && e.key === key));
  await encrypt(cache);
}

export async function clearVault(): Promise<void> {
  cache = [];
  await encrypt(cache);
}

/** Returns the decrypted key for a provider, or null when unavailable. */
export function getVaultKey(provider: string): string | null {
  if (!passphrase) return null;
  const entry = cache.find((e) => e.provider === provider);
  return entry?.key ?? null;
}

export function hasStoredVault(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}
