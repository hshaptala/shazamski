import { TARGET_SAMPLE_RATE } from './fingerprint';

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
