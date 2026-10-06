import { toMono11025HighQuality, isSilentRms } from '../../utils/fingerprint';

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
  const blob = new Blob([WORKLET_PROCESSOR], { type: 'application/javascript' });
  const workletUrl = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(workletUrl);
    const source = ctx.createMediaStreamSource(tabStream);
    source.connect(ctx.destination);
    const workletNode = new AudioWorkletNode(ctx, 'shazamski-tap', { numberOfInputs: 1, numberOfOutputs: 0 });
    source.connect(workletNode);
    try {
      await new Promise((r) => setTimeout(r, seconds * 1000));
      const monoAtSrcRate: Float32Array = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Worklet dump timed out')), 5000);
        const onMsg = (e: MessageEvent) => {
          if (e.data?.type === 'CHUNK_DUMP') {
            clearTimeout(timer);
            workletNode.port.removeEventListener('message', onMsg as any);
            resolve(new Float32Array(e.data.buf));
          }
        };
        workletNode.port.addEventListener('message', onMsg as any);
        workletNode.port.start();
        workletNode.port.postMessage({ type: 'DUMP' });
      });
      return toMono11025HighQuality([monoAtSrcRate.slice(0, Math.min(monoAtSrcRate.length, framesNeeded + srcRate))], srcRate);
    } finally {
      source.disconnect();
      workletNode.disconnect();
    }
  } finally {
    URL.revokeObjectURL(workletUrl);
  }
}

async function captureWithStreamId(streamId: string, seconds: number): Promise<{ mono: number[]; seconds: number }> {
  let tabStream: MediaStream;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    } as any);
  } catch {
    throw Object.assign(
      new Error('Tab audio stream denied. This tab may be muted, already captured, or a protected page (chrome://, Web Store). Play audio in a normal tab and try again.'),
      { code: 'PERMISSION_DENIED' },
    );
  }
  const ctx: AudioContext = new window.AudioContext();
  try {
    const mono = await captureRawPcm(tabStream, seconds, ctx);
    if (isSilentRms(mono)) {
      const err = new Error('Captured only silence — unmute the tab and turn the volume up.');
      (err as any).code = 'NO_AUDIO';
      throw err;
    }
    return { mono: Array.from(mono), seconds };
  } finally {
    tabStream.getTracks().forEach((t) => t.stop());
    await ctx.close();
  }
}

function register(): void {
  ns()?.runtime?.onMessage?.addListener((msg: any, _sender: any, sendResponse: (r: any) => void) => {
    if (!msg || msg.type !== 'OFFSCREEN_CAPTURE_TAB') return false;
    const seconds = Math.min(15, Math.max(3, Number(msg.seconds ?? 10) || 10));
    captureWithStreamId(String(msg.streamId), seconds).then(
      (out) => sendResponse({ ok: true, mono: out.mono, seconds: out.seconds }),
      (e: any) => sendResponse({ ok: false, error: String(e?.message ?? e), errorCode: (e as any)?.code ?? 'UNKNOWN' }),
    );
    return true;
  });
}

register();
export {};
