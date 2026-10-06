import { getAllTracks } from './index-db';
import type { TrackEntry } from './types';
import type { ScoredTrack } from './matcher';

let worker: Worker | null = null;
let indexedCount = 0;
let indexedAt = 0;
let inflightIndex: Promise<number> | null = null;

function getWorker(): Worker {
  if (!worker) worker = new Worker(new URL('./matcher.worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

function callWorker<T>(send: (w: Worker) => void, onMsg: (msg: any, resolve: (v: T) => void, reject: (e: Error) => void) => void, timeoutMs = 30000): Promise<T> {
  const w = getWorker();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      w.onmessage = null as any;
      w.onerror = null as any;
      reject(new Error('Matcher worker timed out'));
    }, timeoutMs);
    w.onmessage = (ev: MessageEvent<any>) => {
      onMsg(ev.data, (v) => {
        clearTimeout(timer);
        resolve(v);
      }, (e) => {
        clearTimeout(timer);
        reject(e);
      });
    };
    w.onerror = (e) => {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error('Worker error'));
    };
    send(w);
  });
}

export async function ensureWorkerIndex(force = false, onProgress?: (done: number, total: number) => void): Promise<number> {
  if (!force && indexedCount > 0 && Date.now() - indexedAt < 10 * 60 * 1000) return indexedCount;
  if (inflightIndex && !force) return inflightIndex;
  inflightIndex = (async () => {
    const tracks: TrackEntry[] = await getAllTracks();
    if (!tracks.length) throw Object.assign(new Error('No index loaded'), { code: 'NO_INDEX' });
    const w = getWorker();
    const count = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker INDEX timed out')), 60000);
      w.onmessage = (ev: MessageEvent<any>) => {
        const msg = ev.data;
        if (msg?.type === 'INDEXED') {
          clearTimeout(timer);
          w.onmessage = null as any;
          w.onerror = null as any;
          resolve(msg.count);
        } else if (msg?.type === 'ERROR') {
          clearTimeout(timer);
          w.onmessage = null as any;
          w.onerror = null as any;
          reject(new Error(msg.message));
        } else if (msg?.type === 'PROGRESS') {
          onProgress?.(msg.done, msg.total);
        }
      };
      w.onerror = (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error('Worker error'));
      };
      w.postMessage({ type: 'INDEX', tracks, prefilterStride: 4 });
    });
    indexedCount = count;
    indexedAt = Date.now();
    inflightIndex = null;
    return count;
  })();
  try {
    return await inflightIndex;
  } catch (e) {
    inflightIndex = null;
    throw e;
  }
}

export function invalidateWorkerIndex(): void {
  indexedCount = 0;
  indexedAt = 0;
}

export interface WorkerMatchResult {
  scored: ScoredTrack[];
  matchMs: number;
  shingleVotes?: Array<{ id: number; votes: number; meanBer: number }>;
}

export async function matchInPersistentWorker(query: Int32Array, opts: { topN?: number; coarseStep?: number; withShingles?: boolean; onProgress?: (done: number, total: number) => void } = {}): Promise<WorkerMatchResult> {
  await ensureWorkerIndex(false, opts.onProgress);
  const buf = Int32Array.from(query);
  return callWorker<WorkerMatchResult>(
    (w) =>
      w.postMessage(
        { type: 'MATCH', query: buf, topN: opts.topN ?? 5, coarseStep: opts.coarseStep ?? 4, withShingles: opts.withShingles ?? true },
        [buf.buffer as ArrayBuffer],
      ),
    (msg, resolve, reject) => {
      if (msg?.type === 'PROGRESS') opts.onProgress?.(msg.done, msg.total);
      else if (msg?.type === 'DONE') resolve({ scored: msg.scored, matchMs: msg.matchMs, shingleVotes: msg.shingleVotes });
      else if (msg?.type === 'ERROR') reject(new Error(msg.message));
    },
    30000,
  );
}
