export const TARGET_SAMPLE_RATE = 11025;
export const BITS = 32;

/** Increment when the query pipeline changes (resample/conditioning/WASM). */
export const PIPELINE_HASH = 'shazamski-pipe-v2';

export function decodeFpBase64ToInt32(b64: string): Int32Array {
  const bin = atob(b64);
  if (bin.length % 4 !== 0)
    throw new Error(`Corrupt fingerprint: byte length ${bin.length} not divisible by 4`);
  const out = new Int32Array(bin.length / 4);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] =
      (bin.charCodeAt(o) |
        (bin.charCodeAt(o + 1) << 8) |
        (bin.charCodeAt(o + 2) << 16) |
        (bin.charCodeAt(o + 3) << 24)) |
      0;
  }
  return out;
}

export function encodeInt32ToBase64(arr: Int32Array | number[]): string {
  const a = arr instanceof Int32Array ? arr : Int32Array.from(arr);
  let bin = '';
  for (let i = 0; i < a.length; i++) {
    const v = a[i] | 0;
    bin += String.fromCharCode(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  return btoa(bin);
}

/**
 * Legacy linear-interpolation resampler. Kept as a synchronous fallback for
 * workers / OfflineAudioContext-unavailable contexts. New code should prefer
 * `toMono11025HighQuality` (browser polyphase, matches ffmpeg quality).
 */
export function toMono11025(channels: Float32Array[], sampleRate: number): Float32Array {
  if (channels.length === 0) throw new Error('No audio channels');
  const len = channels[0].length;
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (const ch of channels) s += ch[i] ?? 0;
    mono[i] = s / channels.length;
  }
  if (sampleRate === TARGET_SAMPLE_RATE) return mono;
  const ratio = sampleRate / TARGET_SAMPLE_RATE;
  const outLen = Math.max(1, Math.floor(len / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const frac = src - i0;
    const a = mono[i0] ?? 0;
    const b = mono[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * High-quality downmix + resample using the browser's polyphase resampler
 * (OfflineAudioContext). This matches `ffmpeg -ar 11025` far better than the
 * linear interpolator above and removes a systematic BER bias.
 */
export async function toMono11025HighQuality(
  channels: Float32Array[],
  sampleRate: number,
): Promise<Float32Array> {
  if (channels.length === 0) throw new Error('No audio channels');
  const Ctx: typeof OfflineAudioContext | undefined =
    (globalThis as any).OfflineAudioContext ?? (globalThis as any).webkitOfflineAudioContext;
  if (!Ctx || sampleRate === TARGET_SAMPLE_RATE) return toMono11025(channels, sampleRate);
  try {
    const frames = channels[0].length;
    const ctx = new Ctx(1, Math.max(1, Math.ceil((frames * TARGET_SAMPLE_RATE) / sampleRate)), TARGET_SAMPLE_RATE);
    const buf = ctx.createBuffer(channels.length, frames, sampleRate);
    for (let c = 0; c < channels.length; c++) buf.getChannelData(c).set(channels[c].subarray(0, frames));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    // Downmix to mono happens in the render: connect through a merger-less path.
    // Simplest bit-exact approach: render stereo then average — but to keep one
    // channel, pre-average into a mono buffer when >1 channel.
    let renderBuf = buf;
    if (channels.length > 1) {
      const mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (const ch of channels) s += ch[i] ?? 0;
        mono[i] = s / channels.length;
      }
      renderBuf = ctx.createBuffer(1, frames, sampleRate);
      renderBuf.getChannelData(0).set(mono);
    }
    src.buffer = renderBuf;
    src.connect(ctx.destination);
    src.start(0);
    const rendered = await ctx.startRendering();
    return rendered.getChannelData(0).slice();
  } catch {
    return toMono11025(channels, sampleRate);
  }
}

export function audioBufferToMono11025(buffer: AudioBuffer): Float32Array {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c).slice());
  }
  return toMono11025(channels, buffer.sampleRate);
}

export async function audioBufferToMono11025HQ(buffer: AudioBuffer): Promise<Float32Array> {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c).slice());
  }
  return toMono11025HighQuality(channels, buffer.sampleRate);
}

// ---------------------------------------------------------------------------
// Query conditioning: DC removal + peak normalize + silence trim
// ---------------------------------------------------------------------------

export interface ConditionedAudio {
  mono: Float32Array;
  rms: number;
  peak: number;
  trimmedSeconds: number;
  silenceRatio: number;
}

/** Remove DC offset and peak-normalize to 0.95. Returns fresh array. */
export function removeDcAndNormalize(mono: Float32Array, targetPeak = 0.95): Float32Array {
  let mean = 0;
  const step = Math.max(1, Math.floor(mono.length / 8192));
  let n = 0;
  for (let i = 0; i < mono.length; i += step) {
    mean += mono[i];
    n++;
  }
  mean /= Math.max(1, n);
  const out = new Float32Array(mono.length);
  let peak = 0;
  for (let i = 0; i < mono.length; i++) {
    const v = mono[i] - mean;
    out[i] = v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  if (peak > 1e-6) {
    const g = targetPeak / peak;
    // Don't amplify near-silence into noise: cap gain at 8x.
    const gc = Math.min(g, 8);
    for (let i = 0; i < out.length; i++) out[i] *= gc;
  }
  return out;
}

function frameRms(mono: Float32Array, start: number, len: number): number {
  let s = 0;
  const end = Math.min(mono.length, start + len);
  for (let i = start; i < end; i++) s += mono[i] * mono[i];
  const count = Math.max(1, end - start);
  return Math.sqrt(s / count);
}

/**
 * Trim leading/trailing silence using an RMS VAD (20ms windows).
 * Returns the trimmed view (copy) + stats.
 */
export function trimSilence(
  mono: Float32Array,
  sampleRate = TARGET_SAMPLE_RATE,
  thresholdRms = 0.015,
): { mono: Float32Array; trimmedSeconds: number; silenceRatio: number } {
  const win = Math.max(64, Math.floor(sampleRate * 0.02));
  let first = 0;
  let last = mono.length;
  const nWin = Math.ceil(mono.length / win);
  let silentWins = 0;
  let firstFound = false;
  let lastAudible = 0;
  for (let w = 0; w < nWin; w++) {
    const r = frameRms(mono, w * win, win);
    if (r < thresholdRms) {
      silentWins++;
    } else {
      if (!firstFound) {
        first = w * win;
        firstFound = true;
      }
      lastAudible = (w + 1) * win;
    }
  }
  last = firstFound ? Math.min(mono.length, lastAudible + win) : mono.length;
  // Keep at least 2s so very quiet clips still produce frames.
  if (!firstFound || last - first < sampleRate * 2) {
    return { mono, trimmedSeconds: 0, silenceRatio: silentWins / Math.max(1, nWin) };
  }
  const trimmedSeconds = (first + (mono.length - last)) / sampleRate;
  return { mono: mono.slice(first, last), trimmedSeconds, silenceRatio: silentWins / Math.max(1, nWin) };
}

/** Full conditioning pipeline used before fingerprinting a query. */
export function conditionQueryMono(mono: Float32Array): ConditionedAudio {
  const normed = removeDcAndNormalize(mono);
  const { mono: trimmed, trimmedSeconds, silenceRatio } = trimSilence(normed);
  let sum = 0;
  const step = Math.max(1, Math.floor(trimmed.length / 4096));
  let peak = 0;
  let c = 0;
  for (let i = 0; i < trimmed.length; i += step) {
    const v = trimmed[i];
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    c++;
  }
  return { mono: trimmed, rms: Math.sqrt(sum / Math.max(1, c)), peak, trimmedSeconds, silenceRatio };
}

// ---------------------------------------------------------------------------
// Bit helpers
// ---------------------------------------------------------------------------

const POPCOUNT_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i;
    let c = 0;
    while (v) {
      c += v & 1;
      v >>>= 1;
    }
    t[i] = c;
  }
  return t;
})();

export function popcount32(x: number): number {
  x >>>= 0;
  return (
    POPCOUNT_TABLE[x & 0xff] +
    POPCOUNT_TABLE[(x >>> 8) & 0xff] +
    POPCOUNT_TABLE[(x >>> 16) & 0xff] +
    POPCOUNT_TABLE[(x >>> 24) & 0xff]
  );
}

export function hamming(a: number, b: number): number {
  return popcount32((a ^ b) >>> 0);
}

// ---------------------------------------------------------------------------
// WASM Chromaprint (pinned, strict)
// ---------------------------------------------------------------------------

type WasmModule = Record<string, any>;
let wasmReady: Promise<WasmModule | null> | null = null;
let wasmFailedLogged = false;
let wasmFingerprintFn: string | null = null;

async function loadWasm(): Promise<WasmModule | null> {
  if (wasmReady) return wasmReady;
  wasmReady = (async () => {
    try {
      const mod: WasmModule = await import('rusty-chromaprint-wasm');
      try {
        if (typeof mod.default === 'function') await mod.default();
        else if (typeof mod.init === 'function') await mod.init();
      } catch {
        // init is best-effort; exports may already be usable
      }
      return mod;
    } catch (e) {
      if (!wasmFailedLogged) {
        wasmFailedLogged = true;
        console.warn('[shazamski] rusty-chromaprint-wasm unavailable, using JS fallback fingerprinter.', e);
      }
      return null;
    }
  })();
  return wasmReady;
}

/** Which WASM entry point was successfully used (for diagnostics). */
export function getWasmFingerprintFn(): string | null {
  return wasmFingerprintFn;
}

function int16FromMono(mono11025: Float32Array): Int16Array {
  const i16 = new Int16Array(mono11025.length);
  for (let i = 0; i < mono11025.length; i++) {
    const s = Math.max(-1, Math.min(1, mono11025[i]));
    i16[i] = Math.round(s * 32767);
  }
  return i16;
}

/**
 * Pinned WASM fingerprint path. Tries known-good export shapes in a fixed
 * order and records which one worked, so drift is visible in logs instead of
 * silently falling back to an incompatible algorithm.
 */
async function tryWasmFingerprint(mod: WasmModule, mono11025: Float32Array): Promise<Int32Array | null> {
  const i16 = int16FromMono(mono11025);
  // 1. fingerprint_audio / fingerprintFromSamples style (preferred, bit-exact)
  for (const name of ['fingerprintFromSamples', 'fingerprint_audio', 'fingerprintAudio', 'fingerprint']) {
    const fn = mod?.[name];
    if (typeof fn === 'function') {
      try {
        const r = await fn(TARGET_SAMPLE_RATE, 1, i16);
        const arr = normalizeWasmResult(r && r.raw ? r.raw : r);
        if (arr && arr.length >= 8) {
          wasmFingerprintFn = name;
          return arr;
        }
      } catch {
        // try next shape
      }
    }
  }
  // 2. Fingerprinter class
  try {
    const Cls = mod.Fingerprinter;
    if (typeof Cls === 'function') {
      const inst = new Cls();
      try {
        inst.start(TARGET_SAMPLE_RATE, 1);
        inst.consume(i16);
        inst.finish();
        const arr = normalizeWasmResult(inst.getFingerprint?.() ?? inst.fingerprint?.());
        if (arr && arr.length >= 8) {
          wasmFingerprintFn = 'Fingerprinter';
          return arr;
        }
      } finally {
        try {
          inst.free();
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // fall through
  }
  return null;
}

function normalizeWasmResult(v: any): Int32Array | null {
  if (!v) return null;
  if (v instanceof Int32Array) return v;
  if (v instanceof Uint32Array) return new Int32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  if (Array.isArray(v)) return Int32Array.from(v);
  if (v.fingerprint) return normalizeWasmResult(v.fingerprint);
  if (v.fp) return normalizeWasmResult(v.fp);
  if (ArrayBuffer.isView(v)) {
    const u8 = new Uint8Array((v as any).buffer, (v as any).byteOffset, (v as any).byteLength);
    if (u8.byteLength % 4 === 0) return new Int32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
  }
  return null;
}

// ---------------------------------------------------------------------------
// JS fallback (NOT bit-compatible with fpcalc — smoke tests only)
// ---------------------------------------------------------------------------

function fftMagnitudesCorrect(frame: Float32Array): Float32Array {
  const n = frame.length;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    re[r] = frame[i] * w;
    im[r] = 0;
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + len / 2] * cwr - im[i + j + len / 2] * cwi;
        const vi = re[i + j + len / 2] * cwi + im[i + j + len / 2] * cwr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr;
        im[i + j + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  const mags = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) mags[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  return mags;
}

/**
 * Shape-compatible fallback only. WILL NOT match an fpcalc-built index at
 * production thresholds — callers must treat `js-fallback` results as
 * unreliable and surface it in the UI.
 */
export function jsFallbackFingerprint(mono11025: Float32Array): Int32Array {
  const N = 4096;
  const HOP = 2048;
  if (mono11025.length < N) {
    const padded = new Float32Array(N);
    padded.set(mono11025);
    mono11025 = padded;
  }
  const frameCount = 1 + Math.floor((mono11025.length - N) / HOP);
  const bandsPerFrame: Float32Array[] = [];
  const frame = new Float32Array(N);
  for (let f = 0; f < frameCount; f++) {
    frame.set(mono11025.subarray(f * HOP, f * HOP + N));
    const mags = fftMagnitudesCorrect(frame);
    const bands = new Float32Array(32);
    const minHz = 300;
    const maxHz = 5500;
    for (let b = 0; b < 32; b++) {
      const lo = minHz * Math.pow(maxHz / minHz, b / 32);
      const hi = minHz * Math.pow(maxHz / minHz, (b + 1) / 32);
      const loBin = Math.max(1, Math.floor(lo / (TARGET_SAMPLE_RATE / N)));
      const hiBin = Math.min(mags.length - 1, Math.ceil(hi / (TARGET_SAMPLE_RATE / N)));
      let e = 0;
      for (let k = loBin; k <= hiBin; k++) e += mags[k] * mags[k];
      bands[b] = Math.log1p(e / Math.max(1, hiBin - loBin + 1));
    }
    bandsPerFrame.push(bands);
  }
  const out = new Int32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let word = 0;
    const cur = bandsPerFrame[f];
    const prev = f > 0 ? bandsPerFrame[f - 1] : cur;
    for (let b = 0; b < 32; b++) {
      const freqDiff = cur[b] - (b > 0 ? cur[b - 1] : cur[b]);
      const timeDiff = cur[b] - prev[b];
      if (freqDiff + 0.5 * timeDiff > 0) word |= 1 << (b % 32);
    }
    out[f] = word | 0;
  }
  return out;
}

export interface FingerprintResult {
  fp: Int32Array;
  algorithm: 'chromaprint-wasm' | 'js-fallback';
  conditioned: boolean;
  frames: number;
  rms: number;
}

export interface FingerprintOptions {
  /** Default true: DC-remove + normalize + silence-trim before FP. */
  condition?: boolean;
  /**
   * Default true: throw FINGERPRINT_FAILED when WASM is unavailable instead
   * of silently returning an incompatible JS fingerprint.
   */
  strictWasm?: boolean;
}

export async function fingerprintMono11025(
  mono11025: Float32Array,
  opts: FingerprintOptions = {},
): Promise<FingerprintResult> {
  const { condition = true, strictWasm = false } = opts;
  let mono = mono11025;
  let conditioned = false;
  let rms = 0;
  if (condition) {
    const c = conditionQueryMono(mono11025);
    mono = c.mono;
    rms = c.rms;
    conditioned = true;
  }
  if (mono.length < TARGET_SAMPLE_RATE * 2) {
    console.warn(
      `[shazamski] very short clip (${(mono.length / TARGET_SAMPLE_RATE).toFixed(1)}s) — matching will be unreliable`,
    );
  }
  const mod = await loadWasm();
  if (mod) {
    const wasmFp = await tryWasmFingerprint(mod, mono);
    if (wasmFp) return { fp: wasmFp, algorithm: 'chromaprint-wasm', conditioned, frames: wasmFp.length, rms };
    console.warn('[shazamski] WASM loaded but no known export produced a fingerprint; using JS fallback.');
  }
  if (strictWasm) {
    const err = new Error(
      'Chromaprint WASM unavailable — refusing JS fallback (it cannot match the fpcalc index). Reload the extension and try again.',
    );
    (err as any).code = 'FINGERPRINT_FAILED';
    throw err;
  }
  const fp = jsFallbackFingerprint(mono);
  return { fp, algorithm: 'js-fallback', conditioned, frames: fp.length, rms };
}

export async function fingerprintAudioBuffer(
  buffer: AudioBuffer,
  opts: FingerprintOptions = {},
): Promise<FingerprintResult> {
  return fingerprintMono11025(audioBufferToMono11025(buffer), opts);
}

/** Legacy mean-abs silence check (kept for compat). Prefer `isSilentRms`. */
export function isSilent(mono: Float32Array, threshold = 0.002): boolean {
  let sum = 0;
  const step = Math.max(1, Math.floor(mono.length / 4096));
  let n = 0;
  for (let i = 0; i < mono.length; i += step) {
    sum += Math.abs(mono[i]);
    n++;
  }
  return sum / Math.max(1, n) < threshold;
}

/** RMS-based silence check — robust to DC offset and single spikes. */
export function isSilentRms(mono: Float32Array, thresholdRms = 0.008): boolean {
  let sum = 0;
  const step = Math.max(1, Math.floor(mono.length / 4096));
  let n = 0;
  for (let i = 0; i < mono.length; i += step) {
    const v = mono[i];
    sum += v * v;
    n++;
  }
  return Math.sqrt(sum / Math.max(1, n)) < thresholdRms;
}

export interface FingerprintQuality {
  frames: number;
  seconds: number;
  rms: number;
  peak: number;
  silenceRatio: number;
  ok: boolean;
  reason?: string;
}

export function fingerprintQuality(mono: Float32Array, frames: number): FingerprintQuality {
  const c = conditionQueryMono(mono);
  const seconds = mono.length / TARGET_SAMPLE_RATE;
  if (frames < 8) return { frames, seconds, rms: c.rms, peak: c.peak, silenceRatio: c.silenceRatio, ok: false, reason: 'too-short' };
  if (c.rms < 0.005) return { frames, seconds, rms: c.rms, peak: c.peak, silenceRatio: c.silenceRatio, ok: false, reason: 'too-quiet' };
  if (c.silenceRatio > 0.85) return { frames, seconds, rms: c.rms, peak: c.peak, silenceRatio: c.silenceRatio, ok: false, reason: 'mostly-silence' };
  return { frames, seconds, rms: c.rms, peak: c.peak, silenceRatio: c.silenceRatio, ok: true };
}
