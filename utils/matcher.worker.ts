import { matchQuery, warmFpCache, clearFpCache, splitQueryShingles, voteShingles } from './matcher';
import type { TrackEntry } from './types';

let cachedTracks: TrackEntry[] | null = null;
let indexedCount = 0;

export type WorkerIn =
  | { type: 'INDEX'; tracks: TrackEntry[]; prefilterStride?: number }
  | { type: 'MATCH'; query: ArrayLike<number>; topN?: number; coarseStep?: number; withShingles?: boolean }
  | { type: 'FINGERPRINT'; mono: ArrayLike<number>; strictWasm?: boolean }
  | { type: 'CLEAR' }
  | { type: 'PING' };

function post(msg: any): void {
  (self as any).postMessage(msg);
}

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'PING') {
      post({ type: 'PONG', indexed: indexedCount });
      return;
    }
    if (msg.type === 'CLEAR') {
      cachedTracks = null;
      indexedCount = 0;
      clearFpCache();
      post({ type: 'CLEARED' });
      return;
    }
    if (msg.type === 'INDEX') {
      cachedTracks = msg.tracks;
      indexedCount = cachedTracks.length;
      // Decode-once: warm Int32 + downsampled caches so MATCH never pays atob.
      warmFpCache(cachedTracks, msg.prefilterStride ?? 4);
      post({ type: 'INDEXED', count: indexedCount });
      return;
    }
    if (msg.type === 'FINGERPRINT') {
      const { fingerprintMono11025 } = await import('./fingerprint');
      const mono = msg.mono instanceof Float32Array ? msg.mono : Float32Array.from(msg.mono as ArrayLike<number>);
      const res = await fingerprintMono11025(mono, { condition: true, strictWasm: msg.strictWasm ?? true });
      post({ type: 'FINGERPRINT_DONE', fp: Array.from(res.fp), algorithm: res.algorithm, frames: res.frames });
      return;
    }
    if (msg.type === 'MATCH') {
      const tracks = cachedTracks;
      if (!tracks) {
        post({ type: 'ERROR', message: 'No index loaded in worker (send INDEX first)' });
        return;
      }
      const query = msg.query instanceof Int32Array ? msg.query : Int32Array.from(msg.query as ArrayLike<number>);
      const { candidates, matchMs } = await matchQuery(query, tracks, {
        topN: msg.topN ?? 5,
        coarseStep: msg.coarseStep ?? 4,
        onProgress: (done, total) => post({ type: 'PROGRESS', done, total }),
      });
      let shingleVotes: Array<{ id: number; votes: number; meanBer: number }> | undefined;
      if (msg.withShingles && query.length >= 24) {
        try {
          const shingles = splitQueryShingles(query);
          if (shingles.length > 1) {
            const perTop = [];
            for (const sh of shingles) {
              const r = await matchQuery(sh, tracks, { topN: 1, coarseStep: msg.coarseStep ?? 4 });
              perTop.push(r.candidates);
            }
            shingleVotes = voteShingles(perTop, msg.topN ?? 5);
          }
        } catch {
          // shingles are advisory only
        }
      }
      post({ type: 'DONE', scored: candidates, matchMs, shingleVotes });
      return;
    }
  } catch (e: any) {
    post({ type: 'ERROR', message: String(e?.message ?? e) });
  }
};

export {};
