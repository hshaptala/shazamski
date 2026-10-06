import { getAllTracks } from './index-db';
import type { TrackEntry } from './types';
import type { ScoredTrack } from './matcher';

let worker: Worker | null = null;
let indexedCount = 0;
let indexedAt = 0;
let inflightIndex: Promise<number> | null = null;

function createWorker(): Worker {
  return new Worker(new URL('./matcher.worker.ts', import.meta.url), { type: 'module' });
}

function getWorker(): Worker {
  if (!worker) worker = createWorker();
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
      try {
        onMsg(ev.data, (v) => {
          clearTimeout(timer);
          resolve(v);
        }, (e) => {
          clearTimeout(timer);
          reject(e);
        });
      } catch (e: any) {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    w.onerror = (e) => {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error('Worker error'));
    };
    try {
      send(w);
    } catch (e: any) {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/**
 * Ensure the persistent worker holds the current index. Decodes once per
 * index version — subsequent Listen calls reuse it with zero track copying.
 */
export async function ensureWorkerIndex(force = false, onProgress?: (done: number, total: number) => void): Promise<number> {
  if (!force && indexedCount > 0 && Date.now() - indexedAt < 10 * 60 * 1000) return indexedCount;
  if (inflightIndex && !force) return inflightIndex;
  inflightIndex = (async () => {
    const tracks: TrackEntry[] = await getAllTracks();
    if (!tracks.length) throw Object.assign(new Error('No index loaded'), { code: 'NO_INDEX' });
    const w = getWorker();
    const count = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worker INDEX timed out')), 60000);
      const prevMsg = w.onmessage;
      const prevErr = w.onerror;
      w.onmessage = (ev: MessageEvent<any>) => {
        const msg = ev.data;
        if (msg?.type === 'INDEXED') {
          clearTimeout(timer);
          w.onmessage = prevMsg as any;
          w.onerror = prevErr as any;
          resolve(msg.count);
        } else if (msg?.type === 'ERROR') {
          clearTimeout(timer);
          w.onmessage = prevMsg as any;
          w.onerror = prevErr as any;
          reject(new Error(msg.message));
        } else if (msg?.type === 'PROGRESS') {
          try {
            onProgress?.(msg.done, msg.total);
          } catch {
            // ignore
          }
        }
      };
      w.onerror = (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error('Worker error'));
      };
      // Structured clone of tracks happens ONCE per index, not per query.
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

export function terminateMatcherWorker(): void {
  try {
    worker?.terminate();
  } catch {
    // ignore
  }
  worker = null;
  indexedCount = 0;
  indexedAt = 0;
}

export interface WorkerMatchResult {
  scored: ScoredTrack[];
  matchMs: number;
  shingleVotes?: Array<{ id: number; votes: number; meanBer: number }>;
}

/**
 * Match using the persistent worker. Transfers the query buffer (no copy)
 * and never re-sends tracks.
 */
export async function matchInPersistentWorker(
  query: Int32Array,
  opts: { topN?: number; coarseStep?: number; withShingles?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<WorkerMatchResult> {
  await ensureWorkerIndex(false, opts.onProgress);
  // Copy into a fresh transferable — the original stays usable by the caller.
  const buf = Int32Array.from(query);
  try {
    return await callWorker<WorkerMatchResult>(
      (w) =>
        w.postMessage(
          { type: 'MATCH', query: buf, topN: opts.topN ?? 5, coarseStep: opts.coarseStep ?? 4, withShingles: opts.withShingles ?? true },
          [buf.buffer as ArrayBuffer],
        ),
      (msg, resolve, reject) => {
        if (msg?.type === 'PROGRESS') {
          try {
            opts.onProgress?.(msg.done, msg.total);
          } catch {
            // ignore
          }
        } else if (msg?.type === 'DONE') {
          resolve({ scored: msg.scored, matchMs: msg.matchMs, shingleVotes: msg.shingleVotes });
        } else if (msg?.type === 'ERROR') {
          reject(new Error(msg.message));
        }
      },
      30000,
    );
  } catch (e) {
    // Worker path failed — fall back to main-thread two-stage match.
    console.warn('[shazamski] persistent worker failed, matching on main thread', e);
    const { matchQuery } = await import('./matcher');
    const tracks = await getAllTracks();
    const { candidates, matchMs } = await matchQuery(query, tracks, {
      topN: opts.topN ?? 5,
      coarseStep: opts.coarseStep ?? 4,
      onProgress: opts.onProgress,
    });
    return { scored: candidates, matchMs };
  }
}

/** Fingerprint inside the worker (keeps popup main thread free). */
export async function fingerprintInWorker(mono: Float32Array, strictWasm = true): Promise<{ fp: Int32Array; algorithm: string; frames: number }> {
  const copy = Float32Array.from(mono);
  try {
    return await callWorker(
      (w) => w.postMessage({ type: 'FINGERPRINT', mono: copy, strictWasm }, [copy.buffer as ArrayBuffer]),
      (msg, resolve, reject) => {
        if (msg?.type === 'FINGERPRINT_DONE') resolve({ fp: Int32Array.from(msg.fp), algorithm: msg.algorithm, frames: msg.frames });
        else if (msg?.type === 'ERROR') reject(new Error(msg.message));
      },
      30000,
    );
  } catch (e) {
    console.warn('[shazamski] worker fingerprint failed, falling back to main thread', e);
    const { fingerprintMono11025 } = await import('./fingerprint');
    const r = await fingerprintMono11025(mono, { condition: true, strictWasm });
    return { fp: r.fp, algorithm: r.algorithm, frames: r.frames };
  }
}
