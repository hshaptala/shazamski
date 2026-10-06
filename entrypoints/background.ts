declare const chrome: any | undefined;
const OFFSCREEN_PATH = 'offscreen.html';
const OFFSCREEN_REASONS: any[] = ['USER_MEDIA' as any];
async function api(): Promise<any> {
    const ns = (globalThis as any).chrome;
    if (!ns)
        throw new Error('Extension API unavailable');
    return ns;
}
async function hasOffscreen(): Promise<boolean> {
    const ns = await api();
    return !!(ns?.offscreen && typeof ns.offscreen.createDocument === 'function');
}
async function ensureOffscreenDocument(): Promise<void> {
    const ns = await api();
    if (!(await hasOffscreen()))
        throw new Error('OFFSCREEN_UNSUPPORTED');
    try {
        const clients = await ns.clients?.matchAll?.({ includeUncontrolled: true });
        void clients;
    }
    catch {
    }
    try {
        if (typeof ns.offscreen.hasDocument === 'function') {
            const exists = await ns.offscreen.hasDocument();
            if (exists)
                return;
        }
        else if (typeof ns.runtime.getContexts === 'function') {
            const ctxs = await ns.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
            if (ctxs?.length)
                return;
        }
    }
    catch {
    }
    await ns.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: OFFSCREEN_REASONS,
        justification: 'Capture tab audio for local song identification while keeping playback audible.',
    });
}
async function getActiveTabId(): Promise<number | undefined> {
    const ns = await api();
    try {
        const tabs = await ns.tabs.query({ active: true, lastFocusedWindow: true });
        const id = tabs?.[0]?.id;
        return typeof id === 'number' ? id : undefined;
    }
    catch {
        return undefined;
    }
}
function getMediaStreamId(targetTabId?: number): Promise<string> {
    return api().then((ns) => new Promise<string>((resolve, reject) => {
        try {
            if (!ns?.tabCapture?.getMediaStreamId) {
                reject(new Error('tabCapture.getMediaStreamId unavailable'));
                return;
            }
            const opts: any = targetTabId != null ? { targetTabId } : {};
            ns.tabCapture.getMediaStreamId(opts, (streamId: string) => {
                const err = ns.runtime?.lastError;
                if (err)
                    reject(new Error(err.message || 'getMediaStreamId failed'));
                else if (!streamId)
                    reject(new Error('Empty media stream id'));
                else
                    resolve(streamId);
            });
        }
        catch (e) {
            reject(e);
        }
    }));
}
async function askOffscreen(payload: any, timeoutMs = 30000): Promise<any> {
    const ns = await api();
    return new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
            if (!done) {
                done = true;
                reject(new Error('Offscreen capture timed out'));
            }
        }, timeoutMs);
        ns.runtime.sendMessage(payload, (resp: any) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            const lastErr = ns.runtime?.lastError;
            if (lastErr)
                reject(new Error(lastErr.message || 'Offscreen messaging failed'));
            else
                resolve(resp);
        });
    });
}
async function handleTabListen(seconds: number): Promise<any> {
    const ns = await api();
    void ns;
    if (!(await hasOffscreen())) {
        return {
            ok: false,
            error: 'Tab audio capture is only available in Chromium browsers (Chrome, Edge, …). This browser has no tab-audio API.',
            errorCode: 'TABCAPTURE_UNSUPPORTED',
        };
    }
    try {
        await ensureOffscreenDocument();
    }
    catch (e: any) {
        return { ok: false, error: `Could not start audio helper: ${e?.message ?? e}`, errorCode: 'OFFSCREEN_FAILED' };
    }
    let streamId: string;
    try {
        const tabId = await getActiveTabId();
        streamId = await getMediaStreamId(tabId);
    }
    catch (e: any) {
        return {
            ok: false,
            error: `Tab audio is not available for this tab (${e?.message ?? 'unknown'}). Play audio in a normal tab and try again.`,
            errorCode: 'TABCAPTURE_UNSUPPORTED',
        };
    }
    try {
        const resp = await askOffscreen({ type: 'OFFSCREEN_CAPTURE_TAB', seconds, streamId }, (seconds + 15) * 1000);
        if (!resp?.ok) {
            return {
                ok: false,
                error: resp?.error ?? 'Tab recording failed',
                errorCode: resp?.errorCode ?? 'UNKNOWN',
            };
        }
        return { ok: true, mono: resp.mono, seconds: resp.seconds ?? seconds, method: 'tab' };
    }
    catch (e: any) {
        return { ok: false, error: e?.message ?? 'Tab recording failed', errorCode: 'UNKNOWN' };
    }
}
async function routeMessage(msg: any): Promise<any> {
    if (!msg || msg.type !== 'SHAZAMSKI_LISTEN')
        return undefined;
    const seconds = Math.min(15, Math.max(3, Number(msg.seconds ?? 6) || 6));
    return handleTabListen(seconds);
}
import { defineBackground } from 'wxt/utils/define-background';
function register(): void {
    try {
        const ns = (globalThis as any).chrome;
        ns?.runtime?.onMessage?.addListener((msg: any, _sender: any, sendResponse: (r: any) => void) => {
            routeMessage(msg)
                .then((res) => {
                if (res !== undefined)
                    sendResponse(res);
            })
                .catch((e: any) => sendResponse({ ok: false, error: String(e?.message ?? e), errorCode: 'UNKNOWN' }));
            return true;
        });
    }
    catch (e) {
        console.warn('[shazamski:bg] listener registration failed', e);
    }
}
export default defineBackground(() => {
    register();
});
