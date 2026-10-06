import { hamming, decodeFpBase64ToInt32 } from './fingerprint';
import type { MatchCandidate, MatchConfidence, TrackEntry, TrackSegment } from './types';

export const DEFAULT_NO_MATCH_BER = 0.38;
export const DEFAULT_MIN_GAP = 0.03;

export interface MatchOptions {
  coarseStep?: number;
  topN?: number;
  minQueryFrames?: number;
  noMatchThreshold?: number;
  onProgress?: (done: number, total: number) => void;
  yieldEvery?: number;
  prefilterStride?: number;
  verifyTop?: number;
}

export interface ScoredTrack {
  id: number;
  ber: number;
  offset: number;
  score: number;
  segIndex: number;
  segOffsetSec: number;
}

function berAtOffset(query: Int32Array, target: Int32Array, offset: number): number {
  const n = Math.min(query.length, target.length - offset);
  if (n <= 0) return 1;
  let bits = 0;
  for (let i = 0; i < n; i++) bits += hamming(query[i], target[offset + i]);
  return bits / (n * 32);
}

function berAtOffsetCutoff(query: Int32Array, target: Int32Array, offset: number, cutoff: number): number {
  const n = Math.min(query.length, target.length - offset);
  if (n <= 0) return 1;
  let bits = 0;
  const checkEvery = 8;
  for (let i = 0; i < n; i++) {
    bits += hamming(query[i], target[offset + i]);
    if ((i & (checkEvery - 1)) === checkEvery - 1) {
      if (bits / ((i + 1) * 32) > cutoff) return 1;
    }
  }
  return bits / (n * 32);
}

function downsampleFrames(fp: Int32Array, stride: number): Int32Array {
  const out = new Int32Array(Math.ceil(fp.length / stride));
  for (let i = 0, j = 0; i < fp.length; i += stride, j++) out[j] = fp[i];
  return out;
}

export function bestOffsetForTrack(query: Int32Array, target: Int32Array, coarseStep = 4): { ber: number; offset: number } {
  if (target.length < query.length) {
    const n = Math.min(query.length, target.length);
    let bits = 0;
    for (let i = 0; i < n; i++) bits += hamming(query[i], target[i]);
    return { ber: bits / (Math.max(1, n) * 32), offset: 0 };
  }
  let bestBer = 1;
  let bestOff = 0;
  const maxOff = target.length - query.length;
  for (let off = 0; off <= maxOff; off += coarseStep) {
    const ber = berAtOffsetCutoff(query, target, off, bestBer);
    if (ber < bestBer) {
      bestBer = ber;
      bestOff = off;
      if (ber < 0.05) break;
    }
  }
  const lo = Math.max(0, bestOff - coarseStep);
  const hi = Math.min(maxOff, bestOff + coarseStep);
  for (let off = lo; off <= hi; off++) {
    if (off % coarseStep === 0) continue;
    const ber = berAtOffsetCutoff(query, target, off, bestBer);
    if (ber < bestBer) {
      bestBer = ber;
      bestOff = off;
    }
  }
  return { ber: bestBer, offset: bestOff };
}

function prefilterBer(queryDs: Int32Array, targetDs: Int32Array, coarseStep: number): number {
  if (targetDs.length < queryDs.length) return berAtOffset(queryDs, targetDs, 0);
  let best = 1;
  const maxOff = targetDs.length - queryDs.length;
  const step = Math.max(1, Math.floor(coarseStep / 2));
  for (let off = 0; off <= maxOff; off += step) {
    const ber = berAtOffsetCutoff(queryDs, targetDs, off, best);
    if (ber < best) {
      best = ber;
      if (best < 0.08) break;
    }
  }
  return best;
}

const fpCache = new Map<number, Int32Array>();
const fpDsCache = new Map<string, Int32Array>();
const fpSegCache = new Map<string, Int32Array>();

export function getDecodedFp(track: TrackEntry): Int32Array {
  let v = fpCache.get(track.id);
  if (!v) {
    v = decodeFpBase64ToInt32(track.fp);
    if (fpCache.size > 12000) {
      fpCache.clear();
      fpDsCache.clear();
      fpSegCache.clear();
    }
    fpCache.set(track.id, v);
  }
  return v;
}

export function getDecodedFpDownsampled(track: TrackEntry, stride: number): Int32Array {
  const key = `${track.id}:ds${stride}`;
  let v = fpDsCache.get(key);
  if (!v) {
    v = downsampleFrames(getDecodedFp(track), stride);
    fpDsCache.set(key, v);
  }
  return v;
}

function getDecodedSeg(trackId: number, segIndex: number, seg: TrackSegment): Int32Array {
  const key = `${trackId}:seg:${segIndex}`;
  let v = fpSegCache.get(key);
  if (!v) {
    v = decodeFpBase64ToInt32(seg.fp);
    fpSegCache.set(key, v);
  }
  return v;
}

export function warmFpCache(tracks: TrackEntry[], stride = 4): void {
  for (const t of tracks) {
    try {
      getDecodedFp(t);
      getDecodedFpDownsampled(t, stride);
    } catch {
      throw new Error(`Corrupt fingerprint in index (track ${t.id})`);
    }
  }
}

export function clearFpCache(): void {
  fpCache.clear();
  fpDsCache.clear();
  fpSegCache.clear();
}

function scoreTrackAllWindows(query: Int32Array, track: TrackEntry, target: Int32Array, coarseStep: number): { ber: number; offset: number; segIndex: number; segOffsetSec: number } {
  let best = bestOffsetForTrack(query, target, coarseStep);
  let segIndex = 0;
  let segOffsetSec = 0;
  if (track.segs) {
    for (let i = 0; i < track.segs.length; i++) {
      const seg = track.segs[i];
      let segFp: Int32Array;
      try {
        segFp = getDecodedSeg(track.id, i, seg);
      } catch {
        throw new Error(`Corrupt segment fingerprint (track ${track.id}, seg ${i})`);
      }
      if (segFp.length < 4) continue;
      const r = bestOffsetForTrack(query, segFp, coarseStep);
      if (r.ber < best.ber) {
        best = r;
        segIndex = i + 1;
        segOffsetSec = seg.offsetSec;
        if (best.ber < 0.03) break;
      }
    }
  }
  return { ber: best.ber, offset: best.offset, segIndex, segOffsetSec };
}

export async function matchQuery(query: Int32Array, tracks: TrackEntry[], opts: MatchOptions = {}): Promise<{ candidates: ScoredTrack[]; matchMs: number }> {
  const t0 = performance.now();
  const { coarseStep = 4, topN = 3, minQueryFrames = 8, onProgress, yieldEvery = 400, prefilterStride = 4, verifyTop = 200 } = opts;
  if (query.length < minQueryFrames) return { candidates: [], matchMs: performance.now() - t0 };
  const queryDs = downsampleFrames(query, prefilterStride);
  const pre: Array<{ idx: number; ber: number }> = [];
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    let target: Int32Array;
    let targetDs: Int32Array;
    try {
      target = getDecodedFp(track);
      targetDs = getDecodedFpDownsampled(track, prefilterStride);
    } catch {
      throw new Error(`Corrupt fingerprint in index (track ${track.id})`);
    }
    if (target.length < 4) continue;
    let ber = prefilterBer(queryDs, targetDs, coarseStep);
    if (track.segs) {
      for (let s = 0; s < track.segs.length; s++) {
        try {
          const segFp = getDecodedSeg(track.id, s, track.segs[s]);
          const b = prefilterBer(queryDs, downsampleFrames(segFp, prefilterStride), coarseStep);
          if (b < ber) ber = b;
        } catch {
          throw new Error(`Corrupt segment fingerprint (track ${track.id}, seg ${s})`);
        }
      }
    }
    pre.push({ idx: i, ber });
    if (onProgress && (i % 400 === 0 || i === tracks.length - 1)) onProgress(Math.floor((i + 1) / 2), tracks.length);
    if (yieldEvery > 0 && i % (yieldEvery * 2) === 0 && i > 0) await new Promise((r2) => setTimeout(r2, 0));
  }
  pre.sort((a, b) => a.ber - b.ber);
  const shortlist = pre.slice(0, Math.min(verifyTop, pre.length));
  const verified: ScoredTrack[] = [];
  for (let k = 0; k < shortlist.length; k++) {
    const track = tracks[shortlist[k].idx];
    let target: Int32Array;
    try {
      target = getDecodedFp(track);
    } catch {
      throw new Error(`Corrupt fingerprint in index (track ${track.id})`);
    }
    const r = scoreTrackAllWindows(query, track, target, coarseStep);
    verified.push({ id: track.id, ber: r.ber, offset: r.offset, score: 1 - r.ber, segIndex: r.segIndex, segOffsetSec: r.segOffsetSec });
    if (onProgress && (k % 50 === 0 || k === shortlist.length - 1)) onProgress(Math.floor(tracks.length / 2 + ((k + 1) / shortlist.length) * (tracks.length / 2)), tracks.length);
    if (yieldEvery > 0 && k % yieldEvery === 0 && k > 0) await new Promise((r2) => setTimeout(r2, 0));
    if (verified.length >= topN) {
      const best = verified.reduce((m, v) => (v.ber < m.ber ? v : m), verified[0]);
      if (best.ber < 0.03 && k >= Math.min(50, shortlist.length - 1)) break;
    }
  }
  verified.sort((a, b) => a.ber - b.ber);
  return { candidates: verified.slice(0, topN), matchMs: performance.now() - t0 };
}

export function splitQueryShingles(query: Int32Array, shingleLen = 0, hop = 0): Int32Array[] {
  if (query.length < 16) return [query];
  const len = shingleLen > 0 ? shingleLen : Math.max(20, Math.floor(query.length / 2));
  const step = hop > 0 ? hop : Math.max(8, Math.floor(len / 2));
  if (query.length <= len) return [query];
  const out: Int32Array[] = [];
  for (let s = 0; s + len <= query.length; s += step) out.push(query.slice(s, s + len));
  if (out.length === 0) out.push(query);
  return out.slice(0, 5);
}

export interface ShingleVote {
  id: number;
  votes: number;
  meanBer: number;
}

export function voteShingles(perShingleTop: ScoredTrack[][], topN = 3): ShingleVote[] {
  const byId = new Map<number, { votes: number; berSum: number }>();
  for (const top of perShingleTop) {
    if (!top.length) continue;
    const t = top[0];
    const e = byId.get(t.id) ?? { votes: 0, berSum: 0 };
    e.votes += 1;
    e.berSum += t.ber;
    byId.set(t.id, e);
  }
  return [...byId.entries()]
    .map(([id, v]) => ({ id, votes: v.votes, meanBer: v.berSum / v.votes }))
    .sort((a, b) => b.votes - a.votes || a.meanBer - b.meanBer)
    .slice(0, topN);
}

export function confidenceOf(scored: ScoredTrack[], queryLen: number, noMatchThreshold = DEFAULT_NO_MATCH_BER): MatchConfidence {
  if (!scored.length) return { ber: 1, gap: 0, coverage: 0, verdict: 'NO_MATCH' };
  const best = scored[0];
  const second = scored[1];
  const gap = second ? Math.max(0, second.ber - best.ber) : 0.5;
  const coverage = Math.min(1, queryLen / Math.max(1, queryLen));
  if (best.ber > noMatchThreshold) return { ber: best.ber, gap, coverage, verdict: 'NO_MATCH' };
  if (best.ber <= 0.15 && gap >= 0.02) return { ber: best.ber, gap, coverage, verdict: 'STRONG' };
  if (best.ber <= 0.15) return { ber: best.ber, gap, coverage, verdict: 'LIKELY' };
  if (best.ber <= 0.3 && gap >= DEFAULT_MIN_GAP) return { ber: best.ber, gap, coverage, verdict: 'LIKELY' };
  if (best.ber <= 0.3) return { ber: best.ber, gap, coverage, verdict: 'WEAK' };
  if (gap >= 0.05) return { ber: best.ber, gap, coverage, verdict: 'WEAK' };
  return { ber: best.ber, gap, coverage, verdict: 'NO_MATCH' };
}

export function toCandidates(scored: ScoredTrack[], byId: Map<number, TrackEntry>, noMatchThreshold = DEFAULT_NO_MATCH_BER): { candidates: MatchCandidate[]; isNoMatch: boolean; confidence: MatchConfidence } {
  const candidates: MatchCandidate[] = [];
  for (const s of scored) {
    const t = byId.get(s.id);
    if (!t) continue;
    candidates.push({
      track: { id: t.id, title: t.title, permalink_url: t.permalink_url, artwork_url: t.artwork_url, duration_ms: t.duration_ms, source: t.source ?? null },
      score: s.score,
      ber: s.ber,
      offset: s.offset,
      segIndex: s.segIndex,
      segOffsetSec: s.segOffsetSec,
    });
  }
  const conf = confidenceOf(scored, 1, noMatchThreshold);
  return { candidates, isNoMatch: candidates.length === 0 || conf.verdict === 'NO_MATCH', confidence: conf };
}
