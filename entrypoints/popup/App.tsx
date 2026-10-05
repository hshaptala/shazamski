import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListenResult, MatchCandidate, PopupPhase } from '../../utils/types';
import { countTracks, getAllTracks, getMeta } from '../../utils/index-db';
import { fingerprintMono11025 } from '../../utils/fingerprint';
import { captureTabViaBackground } from '../../utils/audio-capture';
import { toCandidates } from '../../utils/matcher';
const CAPTURE_SECONDS = 10;
function fmtDuration(ms: number): string {
    if (!ms || ms <= 0)
        return '—';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtBer(ber: number): string {
    return `${Math.round((1 - ber) * 100)}%`;
}
function openOptions(): void {
    const api = (globalThis as any).chrome;
    try {
        if (api?.runtime?.openOptionsPage)
            api.runtime.openOptionsPage();
        else
            window.open(api.runtime.getURL('options.html'), '_blank');
    }
    catch {
        window.open('options.html', '_blank');
    }
}
async function matchInWorker(query: Int32Array, onWorkerProgress: (done: number, total: number) => void): Promise<{
    scored: Array<{
        id: number;
        ber: number;
        offset: number;
        score: number;
    }>;
    matchMs: number;
}> {
    const tracks = await getAllTracks();
    if (!tracks.length)
        throw Object.assign(new Error('No index loaded'), { code: 'NO_INDEX' });
    try {
        const worker = new Worker(new URL('../../utils/matcher.worker.ts', import.meta.url), { type: 'module' });
        try {
            const result = await new Promise<{
                scored: any[];
                matchMs: number;
            }>((resolve, reject) => {
                const timer = setTimeout(() => {
                    try {
                        worker.terminate();
                    }
                    catch {
                    }
                    reject(new Error('Matcher worker timed out'));
                }, 20000);
                worker.onmessage = (ev: MessageEvent<any>) => {
                    const msg = ev.data;
                    if (msg?.type === 'PROGRESS')
                        onWorkerProgress(msg.done, msg.total);
                    else if (msg?.type === 'DONE') {
                        clearTimeout(timer);
                        resolve({ scored: msg.scored, matchMs: msg.matchMs });
                    }
                    else if (msg?.type === 'ERROR') {
                        clearTimeout(timer);
                        reject(new Error(msg.message));
                    }
                };
                worker.onerror = (e) => {
                    clearTimeout(timer);
                    reject(e instanceof Error ? e : new Error('Worker error'));
                };
                worker.postMessage({
                    type: 'MATCH',
                    query: Array.from(query),
                    tracks,
                    topN: 3,
                    coarseStep: 4,
                });
            });
            return result;
        }
        finally {
            try {
                worker.terminate();
            }
            catch {
            }
        }
    }
    catch (e) {
        console.warn('[shazamski] worker failed, matching on main thread', e);
        const { matchQuery } = await import('../../utils/matcher');
        const { candidates, matchMs } = await matchQuery(query, tracks, {
            onProgress: onWorkerProgress,
        });
        return { scored: candidates, matchMs };
    }
}
export default function App() {
    const [phase, setPhase] = useState<PopupPhase>('idle');
    const [statusLine, setStatusLine] = useState('Ready');
    const [progress, setProgress] = useState(0);
    const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [trackCount, setTrackCount] = useState<number | null>(null);
    const [usedMethod, setUsedMethod] = useState<'tab' | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const timerRef = useRef<number | null>(null);
    useEffect(() => {
        (async () => {
            try {
                const [n, meta] = await Promise.all([countTracks().catch(() => 0), getMeta().catch(() => null)]);
                setTrackCount(n);
                if (meta && n === 0)
                    setTrackCount(meta.trackCount);
            }
            catch {
                setTrackCount(0);
            }
        })();
        return () => {
            if (timerRef.current)
                window.clearInterval(timerRef.current);
        };
    }, []);
    const fail = useCallback((message: string, code?: ListenResult['errorCode']) => {
        void code;
        setError(message);
        setPhase('error');
        setStatusLine('Something went wrong');
        setProgress(0);
        if (timerRef.current)
            window.clearInterval(timerRef.current);
    }, []);
    const listen = useCallback(async () => {
        setError(null);
        setCandidates([]);
        setUsedMethod(null);
        setProgress(0);
        const n = await countTracks().catch(() => 0);
        if (!n) {
            fail('No fingerprint index loaded yet. Open Options and load your shazamski-index.json first.', 'NO_INDEX');
            return;
        }
        let mono: Float32Array;
        try {
            setPhase('listening');
            setStatusLine(`Listening to this tab… (${CAPTURE_SECONDS}s, audio keeps playing)`);
            tickElapsed();
            const cap = await captureTabViaBackground(CAPTURE_SECONDS);
            mono = cap.mono11025;
        }
        catch (e: any) {
            const msg = String(e?.message ?? e);
            const code = (e?.code ?? 'UNKNOWN') as ListenResult['errorCode'];
            fail(msg, code === 'UNKNOWN' ? undefined : (code as any));
            return;
        }
        finally {
            if (timerRef.current)
                window.clearInterval(timerRef.current);
        }
        setUsedMethod('tab');
        try {
            setPhase('identifying');
            setStatusLine('Fingerprinting…');
            setProgress(0.05);
            const { fp: query, algorithm } = await fingerprintMono11025(mono!);
            console.debug(`[shazamski] fingerprint: ${query.length} sub-fps via ${algorithm}`);
            if (query.length < 8) {
                fail('Clip too short to identify — try again with audio playing.', 'NO_AUDIO');
                return;
            }
            setStatusLine('Matching against your SoundCloud index…');
            const { scored, matchMs } = await matchInWorker(query, (done, total) => setProgress(0.1 + 0.85 * (done / Math.max(1, total))));
            setProgress(1);
            const tracks = await getAllTracks();
            const byId = new Map(tracks.map((t) => [t.id, t]));
            const { candidates: top, isNoMatch } = toCandidates(scored as any, byId, 0.42);
            console.debug(`[shazamski] match took ${Math.round(matchMs)}ms, top BER=${top[0]?.ber?.toFixed(3) ?? 'n/a'}`);
            if (isNoMatch) {
                setPhase('no-match');
                setStatusLine(top.length
                    ? `No confident match (closest ${(Math.round((1 - top[0].ber) * 100))}% — below threshold).`
                    : 'No match in this channel.');
                setCandidates(top.slice(0, 1));
            }
            else {
                setPhase('result');
                setStatusLine(`Identified in ${Math.round(matchMs)} ms`);
                setCandidates(top);
            }
        }
        catch (e: any) {
            fail(String(e?.message ?? e));
        }
        function tickElapsed() {
            const t0 = Date.now();
            setElapsed(0);
            if (timerRef.current)
                window.clearInterval(timerRef.current);
            timerRef.current = window.setInterval(() => {
                setElapsed(Math.min(CAPTURE_SECONDS, (Date.now() - t0) / 1000));
                setProgress(Math.min(0.95, (Date.now() - t0) / 1000 / CAPTURE_SECONDS));
            }, 200);
        }
    }, [fail]);
    const busy = phase === 'listening' || phase === 'identifying';
    return (<div className="app">
      <div className="brand">
        <div className="brand-mark">S</div>
        <div>
          <h1>Shazamski</h1>
          <p>
            {trackCount == null ? 'Checking index…' : `${trackCount.toLocaleString()} tracks indexed`} · Chrome
          </p>
        </div>
      </div>

      <div className="status">
        <span className={`dot ${phase === 'listening' ? 'live' : busy ? 'busy' : phase === 'result' ? 'ok' : ''}`}/>
        <span>
          {statusLine}
          {phase === 'listening' ? ` ${elapsed.toFixed(0)}s` : ''}
        </span>
      </div>
      {busy && (<div className="progress">
          <div style={{ width: `${Math.round(progress * 100)}%` }}/>
        </div>)}

      <button className="listen-btn" onClick={listen} disabled={busy}>
        {phase === 'listening' ? '● Listening…' : phase === 'identifying' ? '◌ Identifying…' : '🎧 Listen'}
      </button>

      {usedMethod && (phase === 'result' || phase === 'no-match') && (<div className="muted small">Captured from tab audio · {CAPTURE_SECONDS}s clip</div>)}

      {error && (<div className="error">
          {error}
          {error.includes('No fingerprint index') && (<>
              {' '}
              <span className="link" onClick={openOptions}>
                Open Options
              </span>
            </>)}
        </div>)}

      {phase === 'no-match' && (<div className="card">
          <div className="muted">No confident match in your channel.</div>
          <div className="hint" style={{ marginTop: 6 }}>
            Tips: turn the tab volume up and record closer to a drop or hook. The index only covers
            the first ~2 min of each track.
          </div>
        </div>)}

      {(phase === 'result' || (phase === 'no-match' && candidates.length > 0)) &&
            candidates.map((c) => (<div className="card" key={c.track.id}>
            <div className="result">
              {c.track.artwork_url ? (<img src={c.track.artwork_url} alt=""/>) : (<img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="/>)}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="title">{c.track.title}</div>
                <div className="meta">
                  {fmtDuration(c.track.duration_ms)} · {fmtBer(c.ber)} match
                </div>
              </div>
              <span className={`conf ${c.ber > 0.3 ? 'weak' : ''}`}>{c.ber <= 0.15 ? 'STRONG' : c.ber <= 0.3 ? 'LIKELY' : 'WEAK'}</span>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <a className="btn primary" style={{ flex: 1 }} href={c.track.permalink_url} target="_blank" rel="noreferrer">
                Open on SoundCloud
              </a>
              <button className="btn" onClick={listen} disabled={busy}>
                Retry
              </button>
            </div>
          </div>))}

      {phase === 'idle' && trackCount === 0 && (<div className="hint">
          No index loaded. <span className="link" onClick={openOptions}>Open Options</span> to load your
          shazamski-index.json (built once on your PC — see README).
        </div>)}

      <div className="footer">
        <span className="muted small">100% local · zero cost</span>
        <span className="link small" onClick={openOptions}>
          Options
        </span>
      </div>
    </div>);
}
