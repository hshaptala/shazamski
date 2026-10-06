export const TARGET_SAMPLE_RATE = 11025;
export const BITS = 32;
export const PIPELINE_HASH = 'shazamski-pipe-v2';

export function decodeFpBase64ToInt32(b64: string): Int32Array {
  const bin = atob(b64);
  if (bin.length % 4 !== 0) throw new Error(`Corrupt fingerprint: byte length ${bin.length} not divisible by 4`);
  const out = new Int32Array(bin.length / 4);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = (bin.charCodeAt(o) | (bin.charCodeAt(o + 1) << 8) | (bin.charCodeAt(o + 2) << 16) | (bin.charCodeAt(o + 3) << 24)) | 0;
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

export async function toMono11025HighQuality(channels: Float32Array[], sampleRate: number): Promise<Float32Array> {
  if (channels.length === 0) throw new Error('No audio channels');
  if (sampleRate === TARGET_SAMPLE_RATE) {
    if (channels.length === 1) return channels[0].slice();
    const len = channels[0].length;
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (const ch of channels) s += ch[i] ?? 0;
      mono[i] = s / channels.length;
    }
    return mono;
  }
  const Ctx: typeof OfflineAudioContext | undefined = (globalThis as any).OfflineAudioContext ?? (globalThis as any).webkitOfflineAudioContext;
  if (!Ctx) throw new Error('OfflineAudioContext unavailable for resampling');
  const frames = channels[0].length;
  const ctx = new Ctx(1, Math.max(1, Math.ceil((frames * TARGET_SAMPLE_RATE) / sampleRate)), TARGET_SAMPLE_RATE);
  let input: Float32Array;
  if (channels.length === 1) {
    input = channels[0].subarray(0, frames);
  } else {
    input = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (const ch of channels) s += ch[i] ?? 0;
      input[i] = s / channels.length;
    }
  }
  const buf = ctx.createBuffer(1, frames, sampleRate);
  buf.getChannelData(0).set(input);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

export async function audioBufferToMono11025HQ(buffer: AudioBuffer): Promise<Float32Array> {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c).slice());
  return toMono11025HighQuality(channels, buffer.sampleRate);
}

export interface ConditionedAudio {
  mono: Float32Array;
  rms: number;
  peak: number;
  trimmedSeconds: number;
  silenceRatio: number;
}

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
    const gc = Math.min(targetPeak / peak, 8);
    for (let i = 0; i < out.length; i++) out[i] *= gc;
  }
  return out;
}

function frameRms(mono: Float32Array, start: number, len: number): number {
  let s = 0;
  const end = Math.min(mono.length, start + len);
  for (let i = start; i < end; i++) s += mono[i] * mono[i];
  return Math.sqrt(s / Math.max(1, end - start));
}

export function trimSilence(mono: Float32Array, sampleRate = TARGET_SAMPLE_RATE, thresholdRms = 0.015): { mono: Float32Array; trimmedSeconds: number; silenceRatio: number } {
  const win = Math.max(64, Math.floor(sampleRate * 0.02));
  const nWin = Math.ceil(mono.length / win);
  let silentWins = 0;
  let first = 0;
  let lastAudible = 0;
  let found = false;
  for (let w = 0; w < nWin; w++) {
    if (frameRms(mono, w * win, win) < thresholdRms) {
      silentWins++;
    } else {
      if (!found) {
        first = w * win;
        found = true;
      }
      lastAudible = (w + 1) * win;
    }
  }
  if (!found || lastAudible + win - first < sampleRate * 2) return { mono, trimmedSeconds: 0, silenceRatio: silentWins / Math.max(1, nWin) };
  const last = Math.min(mono.length, lastAudible + win);
  return { mono: mono.slice(first, last), trimmedSeconds: (first + (mono.length - last)) / sampleRate, silenceRatio: silentWins / Math.max(1, nWin) };
}

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
  return POPCOUNT_TABLE[x & 0xff] + POPCOUNT_TABLE[(x >>> 8) & 0xff] + POPCOUNT_TABLE[(x >>> 16) & 0xff] + POPCOUNT_TABLE[(x >>> 24) & 0xff];
}

export function hamming(a: number, b: number): number {
  return popcount32((a ^ b) >>> 0);
}

type WasmModule = Record<string, any>;
let wasmReady: Promise<WasmModule | null> | null = null;
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
        throw new Error('Chromaprint WASM init failed');
      }
      return mod;
    } catch {
      return null;
    }
  })();
  return wasmReady;
}

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

async function tryWasmFingerprint(mod: WasmModule, mono11025: Float32Array): Promise<Int32Array | null> {
  const i16 = int16FromMono(mono11025);
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
        throw new Error('Chromaprint WASM fingerprint call failed');
      }
    }
  }
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
          throw new Error('Chromaprint WASM cleanup failed');
        }
      }
    }
  } catch {
    return null;
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

export interface FingerprintResult {
  fp: Int32Array;
  algorithm: 'chromaprint-wasm';
  conditioned: boolean;
  frames: number;
  rms: number;
}

export async function fingerprintMono11025(mono11025: Float32Array): Promise<FingerprintResult> {
  const c = conditionQueryMono(mono11025);
  const mod = await loadWasm();
  if (!mod) {
    const err = new Error('Chromaprint WASM unavailable — reload the extension and try again.');
    (err as any).code = 'FINGERPRINT_FAILED';
    throw err;
  }
  const wasmFp = await tryWasmFingerprint(mod, c.mono);
  if (!wasmFp) {
    const err = new Error('Chromaprint WASM produced no fingerprint — reload the extension and try again.');
    (err as any).code = 'FINGERPRINT_FAILED';
    throw err;
  }
  return { fp: wasmFp, algorithm: 'chromaprint-wasm', conditioned: true, frames: wasmFp.length, rms: c.rms };
}

export async function fingerprintAudioBuffer(buffer: AudioBuffer): Promise<FingerprintResult> {
  return fingerprintMono11025(await audioBufferToMono11025HQ(buffer));
}

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
