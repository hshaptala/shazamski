import { TARGET_SAMPLE_RATE, isSilentRms, toMono11025HighQuality, toMono11025 } from './fingerprint';

export type CaptureMethod = 'tab';
export interface CapturedAudio {
  mono11025: Float32Array;
  sampleRate: number;
  seconds: number;
  method: CaptureMethod;
}

function extApi(): any {
  return (globalThis as any).chrome;
}

export async function recordStream(stream: MediaStream, seconds: number, method: CaptureMethod): Promise<CapturedAudio> {
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve, reject) => {
    rec.onerror = () => reject(new Error('Recording failed'));
    rec.onstop = () => resolve();
  });
  rec.start(250);
  await sleep(seconds * 1000);
  if (rec.state !== 'inactive') rec.stop();
  await stopped;
  if (!chunks.length) {
    const err = new Error('Captured only silence — is any audio playing?');
    (err as any).code = 'NO_AUDIO';
    throw err;
  }
  const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
  const buf = await blobToAudioBuffer(blob);
  const mono = await audioBufferToMonoHQ(buf, TARGET_SAMPLE_RATE);
  if (isSilentRms(mono)) {
    const err = new Error('Captured only silence — turn the volume up and try again.');
    (err as any).code = 'NO_AUDIO';
    throw err;
  }
  return { mono11025: mono, sampleRate: TARGET_SAMPLE_RATE, seconds, method };
}

function pickMime(): string | undefined {
  try {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (const c of candidates) {
      if (typeof MediaRecorder !== 'undefined' && (MediaRecorder as any).isTypeSupported?.(c)) return c;
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function blobToAudioBuffer(blob: Blob): Promise<AudioBuffer> {
  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx: AudioContext = new Ctx();
  try {
    const ab = await blob.arrayBuffer();
    return await ctx.decodeAudioData(ab);
  } finally {
    try {
      await ctx.close();
    } catch {
      // ignore
    }
  }
}

/** High-quality (polyphase) path with linear fallback. */
async function audioBufferToMonoHQ(buffer: AudioBuffer, targetRate: number): Promise<Float32Array> {
  void targetRate;
  const chans: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c).slice());
  try {
    return await toMono11025HighQuality(chans, buffer.sampleRate);
  } catch {
    return toMono11025(chans, buffer.sampleRate);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function captureTabViaBackground(seconds = 10): Promise<CapturedAudio> {
  const api = extApi();
  if (!api?.runtime?.sendMessage) throw new Error('Extension runtime unavailable');
  const res = await api.runtime.sendMessage({ type: 'SHAZAMSKI_LISTEN', method: 'tab', seconds });
  if (!res?.ok) {
    const err = new Error(res?.error ?? 'Tab capture failed');
    (err as any).code = res?.errorCode ?? 'UNKNOWN';
    throw err;
  }
  const mono = Float32Array.from(res.mono as number[]);
  return { mono11025: mono, sampleRate: TARGET_SAMPLE_RATE, seconds: res.seconds ?? seconds, method: 'tab' };
}
