import { hamming, decodeFpBase64ToInt32 } from './fingerprint';
import type { MatchCandidate, TrackEntry } from './types';
export interface MatchOptions {
    coarseStep?: number;
    topN?: number;
    minQueryFrames?: number;
    noMatchThreshold?: number;
    onProgress?: (done: number, total: number) => void;
    yieldEvery?: number;
}
export interface ScoredTrack {
    id: number;
    ber: number;
    offset: number;
    score: number;
}
function berAtOffset(query: Int32Array, target: Int32Array, offset: number): number {
    const n = Math.min(query.length, target.length - offset);
    if (n <= 0)
        return 1;
    let bits = 0;
    for (let i = 0; i < n; i++)
        bits += hamming(query[i], target[offset + i]);
    return bits / (n * 32);
}
export function bestOffsetForTrack(query: Int32Array, target: Int32Array, coarseStep = 4): {
    ber: number;
    offset: number;
} {
    if (target.length < query.length) {
        const n = Math.min(query.length, target.length);
        let bits = 0;
        for (let i = 0; i < n; i++)
            bits += hamming(query[i], target[i]);
        return { ber: bits / (Math.max(1, n) * 32), offset: 0 };
    }
    let bestBer = 1;
    let bestOff = 0;
    const maxOff = target.length - query.length;
    for (let off = 0; off <= maxOff; off += coarseStep) {
        const ber = berAtOffset(query, target, off);
        if (ber < bestBer) {
            bestBer = ber;
            bestOff = off;
            if (ber < 0.05)
                break;
        }
    }
    const lo = Math.max(0, bestOff - coarseStep);
    const hi = Math.min(maxOff, bestOff + coarseStep);
    for (let off = lo; off <= hi; off++) {
        if (off % coarseStep === 0)
            continue;
        const ber = berAtOffset(query, target, off);
        if (ber < bestBer) {
            bestBer = ber;
            bestOff = off;
        }
    }
    return { ber: bestBer, offset: bestOff };
}
const fpCache = new Map<number, Int32Array>();
export function getDecodedFp(track: TrackEntry): Int32Array {
    let v = fpCache.get(track.id);
    if (!v) {
        v = decodeFpBase64ToInt32(track.fp);
        if (fpCache.size > 12000)
            fpCache.clear();
        fpCache.set(track.id, v);
    }
    return v;
}
export function clearFpCache(): void {
    fpCache.clear();
}
export async function matchQuery(query: Int32Array, tracks: TrackEntry[], opts: MatchOptions = {}): Promise<{
    candidates: ScoredTrack[];
    matchMs: number;
}> {
    const t0 = performance.now();
    const { coarseStep = 4, topN = 3, minQueryFrames = 8, onProgress, yieldEvery = 400 } = opts;
    if (query.length < minQueryFrames) {
        return { candidates: [], matchMs: performance.now() - t0 };
    }
    const scored: ScoredTrack[] = [];
    for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i];
        let target: Int32Array;
        try {
            target = getDecodedFp(track);
        }
        catch {
            continue;
        }
        if (target.length < 4)
            continue;
        const { ber, offset } = bestOffsetForTrack(query, target, coarseStep);
        scored.push({ id: track.id, ber, offset, score: 1 - ber });
        if (onProgress && (i % 200 === 0 || i === tracks.length - 1)) {
            try {
                onProgress(i + 1, tracks.length);
            }
            catch {
            }
        }
        if (yieldEvery > 0 && i % yieldEvery === 0 && i > 0) {
            await new Promise((r) => setTimeout(r, 0));
        }
    }
    scored.sort((a, b) => a.ber - b.ber);
    return { candidates: scored.slice(0, topN), matchMs: performance.now() - t0 };
}
export function toCandidates(scored: ScoredTrack[], byId: Map<number, TrackEntry>, noMatchThreshold = 0.38): {
    candidates: MatchCandidate[];
    isNoMatch: boolean;
} {
    const candidates: MatchCandidate[] = [];
    for (const s of scored) {
        const t = byId.get(s.id);
        if (!t)
            continue;
        candidates.push({
            track: {
                id: t.id,
                title: t.title,
                permalink_url: t.permalink_url,
                artwork_url: t.artwork_url,
                duration_ms: t.duration_ms,
            },
            score: s.score,
            ber: s.ber,
            offset: s.offset,
        });
    }
    const isNoMatch = candidates.length === 0 || candidates[0].ber > noMatchThreshold;
    return { candidates, isNoMatch };
}
