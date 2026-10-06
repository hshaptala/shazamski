export interface TrackSegment {
  offsetSec: number;
  fp: string;
  fpLen: number;
  fpDuration?: number;
}

export interface TrackEntry {
  id: number;
  title: string;
  permalink_url: string;
  artwork_url: string | null;
  duration_ms: number;
  fp: string;
  fpLen: number;
  fpDuration?: number;
  segs?: TrackSegment[];
  source?: string;
}

export interface IndexFile {
  version: 1;
  algorithm: 'chromaprint';
  createdAt: string;
  channelUrl: string;
  channelUrls?: string[];
  trackCount: number;
  tracks: TrackEntry[];
  fpcalcVersion?: string;
  targetSampleRate?: number;
  algorithmHash?: string;
  coverage?: 'head' | 'multi-window' | 'full';
}

export interface IndexMeta {
  channelUrl: string;
  channelUrls?: string[];
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
    source?: string | null;
  };
  score: number;
  ber: number;
  offset: number;
  segIndex?: number;
  segOffsetSec?: number;
}

export interface MatchConfidence {
  ber: number;
  gap: number;
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
