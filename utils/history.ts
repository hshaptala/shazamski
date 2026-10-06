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

function storageArea(): any {
  const api = (globalThis as any).chrome;
  if (!api?.storage?.local) throw new Error('storage.local unavailable');
  return api.storage.local;
}

export async function getHistory(): Promise<HistoryEntry[]> {
  const out = await storageArea().get([STORAGE_KEY]);
  const entries = out?.[STORAGE_KEY];
  return Array.isArray(entries) ? entries : [];
}

export async function pushHistory(entry: Omit<HistoryEntry, 'id' | 'timestamp'>): Promise<HistoryEntry[]> {
  const next: HistoryEntry = {
    ...entry,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
  };
  const updated = [next, ...(await getHistory())].slice(0, MAX_ENTRIES);
  await storageArea().set({ [STORAGE_KEY]: updated });
  return updated;
}

export async function removeHistoryEntry(id: string): Promise<HistoryEntry[]> {
  const updated = (await getHistory()).filter((e) => e.id !== id);
  await storageArea().set({ [STORAGE_KEY]: updated });
  return updated;
}

export async function clearHistory(): Promise<void> {
  await storageArea().remove([STORAGE_KEY]);
}
