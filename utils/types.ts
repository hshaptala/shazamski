export interface TrackSegment {
  /** Offset of this window from track start, in seconds. */
  offsetSec: number;
  /** Base64 LE int32 fingerprint for this window. */
  fp: string;
  /** Number of sub-fingerprints in this window. */
  fpLen: number;
  /** Window length in seconds (as fingerprinted). */
  fpDuration?: number;
}

export interface TrackEntry {
  id: number;
  title: string;
  permalink_url: string;
  artwork_url: string | null;
  duration_ms: number;
  /** Primary (head) fingerprint, base64 LE int32. Always present for compat. */
  fp: string;
  fpLen: number;
  fpDuration?: number;
  /**
   * Optional extra windows (e.g. 60-180s) for long tracks / mixes.
   * Matchers search `fp` first, then each segment.
   */
  segs?: TrackSegment[];
}

export interface IndexFile {
  version: 1;
  algorithm: 'chromaprint';
  createdAt: string;
  channelUrl: string;
  trackCount: number;
  tracks: TrackEntry[];
  /** fpcalc version string used at index time (drift detection). */
  fpcalcVersion?: string;
  /** Query-side sample rate the index expects. */
  targetSampleRate?: number;
  /** Content hash of the fingerprinting pipeline (WASM version + params). */
  algorithmHash?: string;
  /** How the index was windowed: head-only or multi-window. */
  coverage?: 'head' | 'multi-window' | 'full';
}

export interface IndexMeta {
  channelUrl: string;
  trackCount: number;
  createdAt: string;
  loadedAt: string;
  bytesApprox: number;
  fpcalcVersion?: string;
  algorithmHash?: string;
  coverage?: string;
}

export interface ChannelConfig {
  channelUrl: string;
}

export type PopupPhase = 'idle' | 'requesting-permission' | 'listening' | 'identifying' | 'result' | 'no-match' | 'error';

export interface MatchCandidate {
  track: {
    id: number;
    title: string;
    permalink_url: string;
    artwork_url: string | null;
    duration_ms: number;
  };
  score: number;
  ber: number;
  offset: number;
  /** Which window matched (0 = head fp, >0 = segs[i-1]). */
  segIndex?: number;
  segOffsetSec?: number;
}

export interface MatchConfidence {
  ber: number;
  /** (secondBest.ber - best.ber): larger = more discriminative. */
  gap: number;
  /** Fraction of query frames actually compared (0..1). */
  coverage: number;
  verdict: 'STRONG' | 'LIKELY' | 'WEAK' | 'NO_MATCH';
}

export interface ListenResult {
  ok: boolean;
  candidates: MatchCandidate[];
  captureMethod: 'tab';
  captureSeconds: number;
  matchMs: number;
  error?: string;
  errorCode?: 'NO_INDEX' | 'PERMISSION_DENIED' | 'NO_AUDIO' | 'TABCAPTURE_UNSUPPORTED' | 'OFFSCREEN_FAILED' | 'FINGERPRINT_FAILED' | 'UNKNOWN';
}

export interface BackgroundListenRequest {
  type: 'SHAZAMSKI_LISTEN';
  method: 'tab';
  seconds?: number;
}

export interface OffscreenCaptureRequest {
  type: 'OFFSCREEN_CAPTURE_TAB';
  seconds: number;
  streamId: string;
}
