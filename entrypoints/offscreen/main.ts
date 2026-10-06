import { toMono11025HighQuality, toMono11025, isSilentRms, TARGET_SAMPLE_RATE } from '../../utils/fingerprint';

declare const chrome: any | undefined;
function ns(): any {
  return (globalThis as any).chrome;
}

const WORKLET_PROCESSOR = `
class ShazamskiTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._total = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'DUMP') {
        const out = new Float32Array(this._total);
        let o = 0;
        for (const c of this._chunks) { out.set(c, o); o += c.length; }
        this.port.postMessage({ type: 'CHUNK_DUMP', total: this._total, buf: out.buffer }, [out.buffer]);
        this._chunks = [];
        this._total = 0;
      }
    };
  }
  process(inputs) {
    const inp = inputs && inputs[0];
    if (inp && inp.length) {
      const n = inp[0].length;
      // Downmix on the audio thread to halve what we ship to main.
      const mono = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < inp.length; c++) s += inp[c][i] || 0;
        mono[i] = s / inp.length;
      }
      const copy = new Float32Array(mono);
      this._chunks.push(copy);
      this._total += copy.length;
    }
    return true;
  }
}
registerProcessor('shazamski-tap', ShazamskiTap);
`;

async function captureRawPcm(tabStream: MediaStream, seconds: number, ctx: AudioContext): Promise<Float32Array> {
  const srcRate = ctx.sampleRate;
  const framesNeeded = Math.ceil(srcRate * seconds);
  let workletUrl: string | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  try {
    const blob = new Blob([WORKLET_PROCESSOR], { type: 'application/javascript' });
    workletUrl = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(workletUrl);
    source = ctx.createMediaStreamSource(tabStream);
    // Keep audible: tab -> destination.
    source.connect(ctx.destination);
    workletNode = new AudioWorkletNode(ctx, 'shazamski-tap', { numberOfInputs: 1, numberOfOutputs: 0 });
    source.connect(workletNode);
    // Wait for `seconds`, then dump.
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const monoAtSrcRate: Float32Array = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Worklet dump timed out')), 5000);
      const onMsg = (e: MessageEvent) => {
        if (e.data?.type === 'CHUNK_DUMP') {
          clearTimeout(timer);
          workletNode?.port.removeEventListener('message', onMsg as any);
          resolve(new Float32Array(e.data.buf));
        }
      };
      workletNode!.port.addEventListener('message', onMsg as any);
      workletNode!.port.start();
      workletNode!.port.postMessage({ type: 'DUMP' });
    });
    // Trim/pad to exact length, then high-quality resample to 11025.
    const trimmed = monoAtSrcRate.slice(0, Math.min(monoAtSrcRate.length, framesNeeded + srcRate));
    try {
      return await toMono11025HighQuality([trimmed], srcRate);
    } catch {
      return toMono11025([trimmed], srcRate);
    }
  } finally {
    try {
      source?.disconnect();
    } catch {
      // ignore
    }
    try {
      workletNode?.disconnect();
    } catch {
      // ignore
    }
    if (workletUrl) {
      try {
        URL.revokeObjectURL(workletUrl);
      } catch {
        // ignore
      }
    }
  }
}

async function captureWithStreamId(streamId: string, seconds: number): Promise<{ mono: number[]; seconds: number }> {
  const constraints: any = {
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  };
  let tabStream: MediaStream;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e: any) {
    throw Object.assign(
      new Error(
        'Tab audio stream denied. This tab may be muted, already captured, or a protected page (chrome://, Web Store). Play audio in a normal tab and try again.',
      ),
      { code: 'PERMISSION_DENIED' },
    );
  }
  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx: AudioContext = new Ctx();
  try {
    // Preferred: raw PCM via AudioWorklet — no Opus transcoding, no decode step.
    try {
      const mono = await captureRawPcm(tabStream, seconds, ctx);
      if (!isSilentRms(mono)) return { mono: Array.from(mono), seconds };
      // If raw path captured silence, fall through to the legacy path for a
      // second opinion before reporting NO_AUDIO (avoids worklet-only bugs).
      console.warn('[shazamski:offscreen] raw PCM silent, retrying via MediaRecorder');
    } catch (e) {
      console.warn('[shazamski:offscreen] raw PCM failed, falling back to MediaRecorder', e);
    }
    // Legacy fallback: MediaRecorder -> decode (lossy but broadly compatible).
    const dest = ctx.createMediaStreamDestination();
    const source = ctx.createMediaStreamSource(tabStream);
    source.connect(dest);
    source.connect(ctx.destination);
    try {
      const blob = await recordToBlob(dest.stream, seconds);
      const buffer = await decodeBlob(blob, ctx);
      const mono = await downmixHQ(buffer);
      if (isSilentRms(mono)) {
        const err = new Error('Captured only silence — unmute the tab and turn the volume up.');
        (err as any).code = 'NO_AUDIO';
        throw err;
      }
      return { mono: Array.from(mono), seconds };
    } finally {
      try {
        source.disconnect();
      } catch {
        // ignore
      }
    }
  } finally {
    tabStream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        // ignore
      }
    });
    try {
      await ctx.close();
    } catch {
      // ignore
    }
  }
}

function recordToBlob(stream: MediaStream, seconds: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let mime: string | undefined;
    for (const c of ['audio/webm;codecs=opus', 'audio/webm']) {
      try {
        if ((MediaRecorder as any).isTypeSupported?.(c)) {
          mime = c;
          break;
        }
      } catch {
        // ignore
      }
    }
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      reject(e);
      return;
    }
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data?.size) chunks.push(e.data);
    };
    rec.onerror = () => reject(new Error('Tab recording failed'));
    rec.onstop = () => {
      if (!chunks.length) reject(Object.assign(new Error('No tab audio captured.'), { code: 'NO_AUDIO' }));
      else resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
    };
    rec.start(250);
    setTimeout(() => {
      if (rec.state !== 'inactive') rec.stop();
    }, seconds * 1000);
  });
}

async function decodeBlob(blob: Blob, ctx: AudioContext): Promise<AudioBuffer> {
  const ab = await blob.arrayBuffer();
  return ctx.decodeAudioData(ab.slice(0));
}

async function downmixHQ(buffer: AudioBuffer): Promise<Float32Array> {
  const chans: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c).slice());
  try {
    return await toMono11025HighQuality(chans, buffer.sampleRate);
  } catch {
    return toMono11025(chans, buffer.sampleRate);
  }
  void TARGET_SAMPLE_RATE;
}

function register(): void {
  try {
    ns()?.runtime?.onMessage?.addListener((msg: any, _sender: any, sendResponse: (r: any) => void) => {
      if (!msg || msg.type !== 'OFFSCREEN_CAPTURE_TAB') return false;
      const seconds = Math.min(15, Math.max(3, Number(msg.seconds ?? 10) || 10));
      captureWithStreamId(String(msg.streamId), seconds).then(
        (out) => sendResponse({ ok: true, mono: out.mono, seconds: out.seconds }),
        (e: any) => sendResponse({ ok: false, error: String(e?.message ?? e), errorCode: (e as any)?.code ?? 'UNKNOWN' }),
      );
      return true;
    });
  } catch (e) {
    console.warn('[shazamski:offscreen] listener failed', e);
  }
}

register();
export {};
