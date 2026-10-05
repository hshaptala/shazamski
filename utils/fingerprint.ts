export const TARGET_SAMPLE_RATE = 11025;
export const BITS = 32;
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
export function toMono11025(channels: Float32Array[], sampleRate: number): Float32Array {
    if (channels.length === 0)
        throw new Error('No audio channels');
    const len = channels[0].length;
    const mono = new Float32Array(len);
    for (let i = 0; i < len; i++) {
        let s = 0;
        for (const ch of channels)
            s += ch[i] ?? 0;
        mono[i] = s / channels.length;
    }
    if (sampleRate === TARGET_SAMPLE_RATE)
        return mono;
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
export function audioBufferToMono11025(buffer: AudioBuffer): Float32Array {
    const channels: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) {
        channels.push(buffer.getChannelData(c).slice());
    }
    return toMono11025(channels, buffer.sampleRate);
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
    return (POPCOUNT_TABLE[x & 0xff] +
        POPCOUNT_TABLE[(x >>> 8) & 0xff] +
        POPCOUNT_TABLE[(x >>> 16) & 0xff] +
        POPCOUNT_TABLE[(x >>> 24) & 0xff]);
}
export function hamming(a: number, b: number): number {
    return popcount32((a ^ b) >>> 0);
}
type WasmModule = Record<string, any>;
let wasmReady: Promise<WasmModule | null> | null = null;
let wasmFailedLogged = false;
async function loadWasm(): Promise<WasmModule | null> {
    if (wasmReady)
        return wasmReady;
    wasmReady = (async () => {
        try {
            const mod: WasmModule = await import('rusty-chromaprint-wasm');
            try {
                if (typeof mod.default === 'function')
                    await mod.default();
                else if (typeof mod.init === 'function')
                    await mod.init();
                else if (typeof mod.initSync === 'function') {
                }
            }
            catch {
            }
            return mod;
        }
        catch (e) {
            if (!wasmFailedLogged) {
                wasmFailedLogged = true;
                console.warn('[shazamski] rusty-chromaprint-wasm unavailable, using JS fallback fingerprinter.', e);
            }
            return null;
        }
    })();
    return wasmReady;
}
async function tryWasmFingerprint(mod: WasmModule, mono11025: Float32Array): Promise<Int32Array | null> {
    const attempts: Array<() => any> = [
        () => typeof mod.fingerprint_audio === 'function' && mod.fingerprint_audio(mono11025, TARGET_SAMPLE_RATE),
        () => typeof mod.fingerprint === 'function' && mod.fingerprint(mono11025, TARGET_SAMPLE_RATE),
        () => typeof mod.fingerprintAudio === 'function' && mod.fingerprintAudio(mono11025, TARGET_SAMPLE_RATE),
        () => typeof mod.fpcalc === 'function' && mod.fpcalc(mono11025, TARGET_SAMPLE_RATE),
    ];
    for (const fn of attempts) {
        try {
            const r = fn();
            if (!r)
                continue;
            const v = r instanceof Promise ? await r : r;
            const arr = normalizeWasmResult(v);
            if (arr && arr.length >= 8)
                return arr;
        }
        catch {
        }
    }
    try {
        const Cls = mod.Fingerprinter ?? mod.FingerprinterWasm ?? mod.Chromaprint;
        if (typeof Cls === 'function') {
            const inst = new Cls(TARGET_SAMPLE_RATE, 1);
            if (typeof inst.feed === 'function') {
                const maybe = inst.feed(mono11025);
                if (maybe instanceof Promise)
                    await maybe;
            }
            else if (typeof inst.consume === 'function') {
                const maybe = inst.consume(mono11025);
                if (maybe instanceof Promise)
                    await maybe;
            }
            const fin = inst.finish?.() ?? inst.finish_fingerprint?.() ?? inst.get_fingerprint?.() ?? inst.fingerprint?.();
            const v = fin instanceof Promise ? await fin : fin;
            const arr = normalizeWasmResult(v);
            if (arr && arr.length >= 8)
                return arr;
            if (typeof inst.free === 'function') {
                try {
                    inst.free();
                }
                catch {
                }
            }
        }
    }
    catch {
    }
    return null;
}
function normalizeWasmResult(v: any): Int32Array | null {
    if (!v)
        return null;
    if (v instanceof Int32Array)
        return v;
    if (v instanceof Uint32Array)
        return new Int32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    if (Array.isArray(v))
        return Int32Array.from(v);
    if (v.fingerprint)
        return normalizeWasmResult(v.fingerprint);
    if (v.fp)
        return normalizeWasmResult(v.fp);
    if (ArrayBuffer.isView(v)) {
        const u8 = new Uint8Array((v as any).buffer, (v as any).byteOffset, (v as any).byteLength);
        if (u8.byteLength % 4 === 0)
            return new Int32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
    }
    return null;
}
function fftMagnitudes(frame: Float32Array): Float32Array {
    const n = frame.length;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
        re[i] = frame[i] * w;
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
    void 0;
    const mags = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++)
        mags[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    return mags;
}
function fftMagnitudesCorrect(frame: Float32Array): Float32Array {
    const n = frame.length;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++)
            r |= ((i >>> b) & 1) << (bits - 1 - b);
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
    for (let i = 0; i < n / 2; i++)
        mags[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
    return mags;
}
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
            for (let k = loBin; k <= hiBin; k++)
                e += mags[k] * mags[k];
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
            if (freqDiff + 0.5 * timeDiff > 0)
                word |= 1 << (b % 32);
        }
        out[f] = word | 0;
    }
    void fftMagnitudes;
    return out;
}
export interface FingerprintResult {
    fp: Int32Array;
    algorithm: 'chromaprint-wasm' | 'js-fallback';
}
export async function fingerprintMono11025(mono11025: Float32Array): Promise<FingerprintResult> {
    if (mono11025.length < TARGET_SAMPLE_RATE * 2) {
        console.warn(`[shazamski] very short clip (${(mono11025.length / TARGET_SAMPLE_RATE).toFixed(1)}s) — matching will be unreliable`);
    }
    const mod = await loadWasm();
    if (mod) {
        const wasmFp = await tryWasmFingerprint(mod, mono11025);
        if (wasmFp)
            return { fp: wasmFp, algorithm: 'chromaprint-wasm' };
        console.warn('[shazamski] WASM loaded but no known export produced a fingerprint; using JS fallback.');
    }
    return { fp: jsFallbackFingerprint(mono11025), algorithm: 'js-fallback' };
}
export async function fingerprintAudioBuffer(buffer: AudioBuffer): Promise<FingerprintResult> {
    return fingerprintMono11025(audioBufferToMono11025(buffer));
}
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
