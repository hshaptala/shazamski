import { toMono11025, isSilent, TARGET_SAMPLE_RATE } from '../../utils/fingerprint';
declare const chrome: any | undefined;
function ns(): any {
    return (globalThis as any).chrome;
}
async function captureWithStreamId(streamId: string, seconds: number): Promise<{
    mono: number[];
    seconds: number;
}> {
    const constraints: any = {
        audio: {
            mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: streamId,
            },
        },
        video: false,
    };
    let tabStream: MediaStream;
    try {
        tabStream = await navigator.mediaDevices.getUserMedia(constraints);
    }
    catch (e: any) {
        throw Object.assign(new Error('Tab audio stream denied. This tab may be muted, already captured, or a protected page (chrome://, Web Store). Play audio in a normal tab and try again.'), { code: 'PERMISSION_DENIED' });
    }
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx: AudioContext = new Ctx();
    let dest: MediaStreamAudioDestinationNode;
    let source: MediaStreamAudioSourceNode;
    try {
        source = ctx.createMediaStreamSource(tabStream);
        dest = ctx.createMediaStreamDestination();
        source.connect(dest);
        source.connect(ctx.destination);
    }
    catch (e) {
        tabStream.getTracks().forEach((t) => t.stop());
        try {
            await ctx.close();
        }
        catch {
        }
        throw e;
    }
    try {
        const blob = await recordToBlob(dest.stream, seconds);
        const buffer = await decodeBlob(blob, ctx);
        const mono = downmix(buffer);
        if (isSilent(mono)) {
            const err = new Error('Captured only silence — unmute the tab and turn the volume up.');
            (err as any).code = 'NO_AUDIO';
            throw err;
        }
        return { mono: Array.from(mono), seconds };
    }
    finally {
        try {
            source.disconnect();
        }
        catch {
        }
        tabStream.getTracks().forEach((t) => {
            try {
                t.stop();
            }
            catch {
            }
        });
        try {
            await ctx.close();
        }
        catch {
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
            }
            catch {
            }
        }
        let rec: MediaRecorder;
        try {
            rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        }
        catch (e) {
            reject(e);
            return;
        }
        const chunks: Blob[] = [];
        rec.ondataavailable = (e) => {
            if (e.data?.size)
                chunks.push(e.data);
        };
        rec.onerror = () => reject(new Error('Tab recording failed'));
        rec.onstop = () => {
            if (!chunks.length)
                reject(Object.assign(new Error('No tab audio captured.'), { code: 'NO_AUDIO' }));
            else
                resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
        };
        rec.start(250);
        setTimeout(() => {
            if (rec.state !== 'inactive')
                rec.stop();
        }, seconds * 1000);
    });
}
async function decodeBlob(blob: Blob, ctx: AudioContext): Promise<AudioBuffer> {
    const ab = await blob.arrayBuffer();
    return ctx.decodeAudioData(ab.slice(0));
}
function downmix(buffer: AudioBuffer): Float32Array {
    const chans: Float32Array[] = [];
    for (let c = 0; c < buffer.numberOfChannels; c++)
        chans.push(buffer.getChannelData(c).slice());
    return toMono11025(chans, buffer.sampleRate);
    void TARGET_SAMPLE_RATE;
}
function register(): void {
    try {
        ns()?.runtime?.onMessage?.addListener((msg: any, _sender: any, sendResponse: (r: any) => void) => {
            if (!msg || msg.type !== 'OFFSCREEN_CAPTURE_TAB')
                return false;
            const seconds = Math.min(15, Math.max(5, Number(msg.seconds ?? 10) || 10));
            captureWithStreamId(String(msg.streamId), seconds).then((out) => sendResponse({ ok: true, mono: out.mono, seconds: out.seconds }), (e: any) => sendResponse({ ok: false, error: String(e?.message ?? e), errorCode: (e as any)?.code ?? 'UNKNOWN' }));
            return true;
        });
    }
    catch (e) {
        console.warn('[shazamski:offscreen] listener failed', e);
    }
}
register();
export {};
