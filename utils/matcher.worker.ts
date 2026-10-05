import { matchQuery } from './matcher';
import type { TrackEntry } from './types';
let cachedTracks: TrackEntry[] | null = null;
export type WorkerIn = {
    type: 'INDEX';
    tracks: TrackEntry[];
} | {
    type: 'MATCH';
    query: ArrayLike<number>;
    tracks?: TrackEntry[];
    topN?: number;
    coarseStep?: number;
};
self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
    const msg = ev.data;
    try {
        if (msg.type === 'INDEX') {
            cachedTracks = msg.tracks;
            (self as any).postMessage({ type: 'INDEXED', count: cachedTracks.length });
            return;
        }
        if (msg.type === 'MATCH') {
            const tracks = msg.tracks ?? cachedTracks;
            if (!tracks) {
                (self as any).postMessage({ type: 'ERROR', message: 'No index loaded in worker' });
                return;
            }
            const query = msg.query instanceof Int32Array ? msg.query : Int32Array.from(msg.query as ArrayLike<number>);
            const { candidates, matchMs } = await matchQuery(query, tracks, {
                topN: msg.topN ?? 3,
                coarseStep: msg.coarseStep ?? 4,
                onProgress: (done, total) => (self as any).postMessage({ type: 'PROGRESS', done, total }),
            });
            (self as any).postMessage({ type: 'DONE', scored: candidates, matchMs });
            return;
        }
    }
    catch (e: any) {
        (self as any).postMessage({ type: 'ERROR', message: String(e?.message ?? e) });
    }
};
export {};
