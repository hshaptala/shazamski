import type { MatchCandidate } from './types';

export interface HistoryEntry {
  id: string;
  timestamp: number;
  candidates: MatchCandidate[];
  matchMs: number;
  captureSeconds: number;
}

const STORAGE_KEY = 'shazamski.history';
const MAX_ENTRIES = 30;

function storageArea(): any | null {
  try {
    const api = (globalThis as any).chrome;
    if (api?.storage?.local) return api.storage.local;
  } catch {
    // ignore
  }
  return null;
}

function memFallback(): HistoryEntry[] {
  try {
    const raw = (globalThis as any).localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeMemFallback(entries: HistoryEntry[]): void {
  try {
    (globalThis as any).localStorage?.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // ignore (private mode etc.)
  }
}

export async function getHistory(): Promise<HistoryEntry[]> {
  const area = storageArea();
  if (!area) return memFallback();
  try {
    const out = await area.get([STORAGE_KEY]);
    const entries = out?.[STORAGE_KEY];
    return Array.isArray(entries) ? entries : [];
  } catch {
    return memFallback();
  }
}

export async function pushHistory(entry: Omit<HistoryEntry, 'id' | 'timestamp'>): Promise<HistoryEntry[]> {
  const next: HistoryEntry = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  };
  const current = await getHistory();
  const updated = [next, ...current].slice(0, MAX_ENTRIES);
  const area = storageArea();
  if (area) {
    try {
      await area.set({ [STORAGE_KEY]: updated });
    } catch {
      writeMemFallback(updated);
    }
  } else {
    writeMemFallback(updated);
  }
  return updated;
}

export async function removeHistoryEntry(id: string): Promise<HistoryEntry[]> {
  const current = await getHistory();
  const updated = current.filter((e) => e.id !== id);
  const area = storageArea();
  if (area) {
    try {
      await area.set({ [STORAGE_KEY]: updated });
    } catch {
      writeMemFallback(updated);
    }
  } else {
    writeMemFallback(updated);
  }
  return updated;
}

export async function clearHistory(): Promise<void> {
  const area = storageArea();
  if (area) {
    try {
      await area.remove([STORAGE_KEY]);
    } catch {
      // ignore
    }
  }
  writeMemFallback([]);
}
