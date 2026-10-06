import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListenResult, MatchCandidate, PopupPhase } from '../../utils/types';
import { countTracks, getAllTracks, getMeta } from '../../utils/index-db';
import { fingerprintMono11025, fingerprintQuality, getWasmFingerprintFn } from '../../utils/fingerprint';
import { captureTabViaBackground } from '../../utils/audio-capture';
import { confidenceOf, DEFAULT_NO_MATCH_BER, toCandidates } from '../../utils/matcher';
import { ensureWorkerIndex, matchInPersistentWorker, invalidateWorkerIndex } from '../../utils/matcher-client';
import { clearHistory, getHistory, pushHistory, removeHistoryEntry, type HistoryEntry } from '../../utils/history';

const SHORT_SECONDS = 6;
const EXTENDED_SECONDS = 12;
/** BER at or below this counts as a confident (STRONG) match — show only the top track. */
const STRONG_BER = 0.15;

function fmtDuration(ms: number): string {
  if (!ms || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtBer(ber: number): string {
  return `${Math.round((1 - ber) * 100)}%`;
}
function openOptions(): void {
  const api = (globalThis as any).chrome;
  try {
    if (api?.runtime?.openOptionsPage) api.runtime.openOptionsPage();
    else window.open(api.runtime.getURL('options.html'), '_blank');
  } catch {
    window.open('options.html', '_blank');
  }
}
/** Open a SoundCloud link in a background tab so the popup stays open. */
function openTrack(url: string): void {
  const api = (globalThis as any).chrome;
  try {
    if (api?.tabs?.create) {
      api.tabs.create({ url, active: false });
      return;
    }
  } catch {
    // fall through to window.open
  }
  window.open(url, '_blank', 'noopener');
}
function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

interface AttemptResult {
  scored: Array<{ id: number; ber: number; offset: number; score: number; segIndex: number; segOffsetSec: number }>;
  matchMs: number;
  shingleVotes?: Array<{ id: number; votes: number; meanBer: number }>;
  queryFrames: number;
  algorithm: string;
  captureSeconds: number;
}

async function listenOnce(
  seconds: number,
  onProgress: (p: number) => void,
  setStatus: (s: string) => void,
): Promise<AttemptResult> {
  setStatus(`Listening to this tab… (${seconds}s, audio keeps playing)`);
  const cap = await captureTabViaBackground(seconds);
  onProgress(0.35);
  setStatus('Fingerprinting…');
  // Fingerprint on the popup thread would block UI; the worker path is tried
  // inside matchInPersistentWorker only for matching, so fingerprint here with
  // strict=false but surface the algorithm so a JS-fallback result is flagged.
  const { fp: query, algorithm } = await fingerprintMono11025(cap.mono11025, { condition: true, strictWasm: false });
  const q = fingerprintQuality(cap.mono11025, query.length);
  if (!q.ok) {
    throw Object.assign(new Error(`Clip unusable (${q.reason}) — turn the volume up and try again.`), { code: 'NO_AUDIO' });
  }
  if (query.length < 8) {
    throw Object.assign(new Error('Clip too short to identify — try again with audio playing.'), { code: 'NO_AUDIO' });
  }
  console.debug(`[shazamski] fingerprint: ${query.length} sub-fps via ${algorithm} (wasm fn: ${getWasmFingerprintFn() ?? 'n/a'})`);
  setStatus('Matching against your SoundCloud index…');
  const { scored, matchMs, shingleVotes } = await matchInPersistentWorker(query, {
    topN: 5,
    coarseStep: 4,
    withShingles: query.length >= 24,
    onProgress: (done, total) => onProgress(0.4 + 0.55 * (done / Math.max(1, total))),
  });
  onProgress(1);
  return { scored: scored as any, matchMs, shingleVotes, queryFrames: query.length, algorithm, captureSeconds: seconds };
}

export default function App() {
  const [phase, setPhase] = useState<PopupPhase>('idle');
  const [statusLine, setStatusLine] = useState('Ready');
  const [progress, setProgress] = useState(0);
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [trackCount, setTrackCount] = useState<number | null>(null);
  const [usedMethod, setUsedMethod] = useState<'tab' | null>(null);
  const [usedSeconds, setUsedSeconds] = useState<number>(SHORT_SECONDS);
  const [elapsed, setElapsed] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [warnFallback, setWarnFallback] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const [n, meta] = await Promise.all([countTracks().catch(() => 0), getMeta().catch(() => null)]);
        setTrackCount(n);
        if (meta && n === 0) setTrackCount(meta.trackCount);
        if (n > 0) {
          // Warm the persistent worker in the background (decode-once).
          ensureWorkerIndex(false).catch(() => {});
        }
      } catch {
        setTrackCount(0);
      }
      try {
        setHistory(await getHistory());
      } catch {
        // history is best-effort
      }
    })();
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, []);
  const fail = useCallback((message: string, code?: ListenResult['errorCode']) => {
    void code;
    setError(message);
    setPhase('error');
    setStatusLine('Something went wrong');
    setProgress(0);
    if (timerRef.current) window.clearInterval(timerRef.current);
  }, []);
  const listen = useCallback(async () => {
    setError(null);
    setCandidates([]);
    setUsedMethod(null);
    setWarnFallback(false);
    setProgress(0);
    const n = await countTracks().catch(() => 0);
    if (!n) {
      fail('No fingerprint index loaded yet. Open Options and load your shazamski-index.json first.', 'NO_INDEX');
      return;
    }
    try {
      await ensureWorkerIndex(false, (done, total) => setProgress(0.05 * (done / Math.max(1, total))));
    } catch (e: any) {
      // ensure failure surfaces as NO_INDEX only when truly empty
      if (String(e?.message ?? '').includes('No index')) {
        fail('No fingerprint index loaded yet. Open Options and load your shazamski-index.json first.', 'NO_INDEX');
        return;
      }
      invalidateWorkerIndex();
    }
    const stopTimer = () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
    const tickElapsed = (capSeconds: number) => {
      const t0 = Date.now();
      setElapsed(0);
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = window.setInterval(() => {
        setElapsed(Math.min(capSeconds, (Date.now() - t0) / 1000));
        setProgress((p) => Math.min(0.35, (Date.now() - t0) / 1000 / capSeconds / 3 + p * 0.001));
      }, 200);
    };
    try {
      setPhase('listening');
      tickElapsed(SHORT_SECONDS);
      setProgress(0.02);
      // --- Attempt 1: fast 6s pass ---
      let first: AttemptResult;
      try {
        first = await listenOnce(SHORT_SECONDS, (p) => setProgress(p * 0.6), setStatusLine);
      } finally {
        stopTimer();
      }
      setPhase('identifying');
      const tracks = await getAllTracks();
      const byId = new Map(tracks.map((t) => [t.id, t]));
      const firstConv = confidenceOf(first.scored as any, first.queryFrames, DEFAULT_NO_MATCH_BER);
      console.debug(`[shazamski] pass1 ${first.captureSeconds}s ${Math.round(first.matchMs)}ms top BER=${first.scored[0]?.ber?.toFixed(3) ?? 'n/a'} gap=${firstConv.gap.toFixed(3)} ${firstConv.verdict}`);
      if (first.algorithm !== 'chromaprint-wasm') setWarnFallback(true);

      const ambiguous =
        firstConv.verdict === 'WEAK' ||
        (firstConv.verdict === 'LIKELY' && firstConv.gap < 0.03) ||
        (first.scored[0] && first.scored[0].ber > 0.22 && first.scored[0].ber <= 0.42);
      let best = first;
      let bestConv = firstConv;
      // --- Attempt 2 (only when ambiguous): 12s extended clip ---
      if (ambiguous) {
        setStatusLine(`Close call (${fmtBer(first.scored[0]?.ber ?? 1)}) — recording ${EXTENDED_SECONDS}s for a second opinion…`);
        setPhase('listening');
        tickElapsed(EXTENDED_SECONDS);
        try {
          const second = await listenOnce(EXTENDED_SECONDS, (p) => setProgress(0.6 + p * 0.4), setStatusLine);
          const secondConv = confidenceOf(second.scored as any, second.queryFrames, DEFAULT_NO_MATCH_BER);
          console.debug(`[shazamski] pass2 ${second.captureSeconds}s ${Math.round(second.matchMs)}ms top BER=${second.scored[0]?.ber?.toFixed(3) ?? 'n/a'} gap=${secondConv.gap.toFixed(3)} ${secondConv.verdict}`);
          // Prefer the more discriminative verdict; tie-break on lower BER.
          const rank = (v: string) => ({ STRONG: 0, LIKELY: 1, WEAK: 2, NO_MATCH: 3 })[v as string] ?? 4;
          if (rank(secondConv.verdict) < rank(bestConv.verdict) || (secondConv.verdict === bestConv.verdict && (second.scored[0]?.ber ?? 1) < (best.scored[0]?.ber ?? 1))) {
            best = second;
            bestConv = secondConv;
          }
          if (second.algorithm !== 'chromaprint-wasm') setWarnFallback(true);
        } catch (e: any) {
          // Extended pass is best-effort: keep the first pass on failure.
          console.warn('[shazamski] extended pass failed, keeping first pass', e);
        } finally {
          stopTimer();
        }
        setPhase('identifying');
      }
      setProgress(1);
      setUsedMethod('tab');
      setUsedSeconds(best.captureSeconds);
      const { candidates: top, isNoMatch } = toCandidates(best.scored as any, byId, 0.42);
      // Shingle agreement as a tie-break signal in logs (advisory).
      if (best.shingleVotes?.length) {
        console.debug('[shazamski] shingle votes', best.shingleVotes.slice(0, 3));
      }
      if (isNoMatch) {
        const shown = top.slice(0, 1);
        setPhase('no-match');
        setStatusLine(
          top.length ? `No confident match (closest ${Math.round((1 - top[0].ber) * 100)}% — below threshold).` : 'No match in this channel.',
        );
        setCandidates(shown);
        if (shown.length) {
          try {
            setHistory(await pushHistory({ candidates: shown, matchMs: best.matchMs, captureSeconds: best.captureSeconds }));
          } catch {
            // history is best-effort
          }
        }
      } else {
        setPhase('result');
        setStatusLine(`Identified in ${Math.round(best.matchMs)} ms · ${best.captureSeconds}s clip`);
        // Strong match → show only the top track, not the runners-up.
        const shown = top.length && top[0].ber <= STRONG_BER ? top.slice(0, 1) : top.slice(0, 3);
        setCandidates(shown);
        try {
          setHistory(await pushHistory({ candidates: shown, matchMs: best.matchMs, captureSeconds: best.captureSeconds }));
        } catch {
          // history is best-effort
        }
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const code = (e?.code ?? 'UNKNOWN') as ListenResult['errorCode'];
      fail(msg, code === 'UNKNOWN' ? undefined : (code as any));
    } finally {
      stopTimer();
    }
  }, [fail]);
  const busy = phase === 'listening' || phase === 'identifying';
  return (
    <div className="app">
      <div className="brand">
        <div className="brand-mark">S</div>
        <div>
          <h1>Shazamski</h1>
          <p>{trackCount == null ? 'Checking index…' : `${trackCount.toLocaleString()} tracks indexed`} · Chrome</p>
        </div>
      </div>

      <div className="status">
        <span className={`dot ${phase === 'listening' ? 'live' : busy ? 'busy' : phase === 'result' ? 'ok' : ''}`} />
        <span>
          {statusLine}
          {phase === 'listening' ? ` ${elapsed.toFixed(0)}s` : ''}
        </span>
      </div>
      {busy && (
        <div className="progress">
          <div style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}

      <button className="listen-btn" onClick={listen} disabled={busy}>
        {phase === 'listening' ? '● Listening…' : phase === 'identifying' ? '◌ Identifying…' : '🎧 Listen'}
      </button>

      {usedMethod && (phase === 'result' || phase === 'no-match') && (
        <div className="muted small">
          Captured from tab audio · {usedSeconds}s clip
          {usedSeconds >= EXTENDED_SECONDS ? ' · extended for accuracy' : ' · fast pass'}
        </div>
      )}
      {warnFallback && (phase === 'result' || phase === 'no-match') && (
        <div className="hint" style={{ marginTop: 6 }}>
          Fingerprinted with the JS fallback (WASM unavailable) — results may be less accurate. Reload the extension and try again for a
          bit-exact match.
        </div>
      )}

      {error && (
        <div className="error">
          {error}
          {error.includes('No fingerprint index') && (
            <>
              {' '}
              <span className="link" onClick={openOptions}>
                Open Options
              </span>
            </>
          )}
        </div>
      )}

      {phase === 'no-match' && (
        <div className="card">
          <div className="muted">No confident match in your channel.</div>
          <div className="hint" style={{ marginTop: 6 }}>
            Tips: turn the tab volume up and record closer to a drop or hook. The index covers the first ~2 min of each track
            (multi-window indexes also cover later sections).
          </div>
        </div>
      )}

      {(phase === 'result' || (phase === 'no-match' && candidates.length > 0)) && candidates.length > 1 && (
        <div className="muted small">Links open in a background tab so you can check all {candidates.length} without losing results.</div>
      )}

      {(phase === 'result' || (phase === 'no-match' && candidates.length > 0)) &&
        candidates.map((c) => (
          <div className="card" key={c.track.id}>
            <div className="result">
              {c.track.artwork_url ? (
                <img src={c.track.artwork_url} alt="" />
              ) : (
                <img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==" />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="title">{c.track.title}</div>
                <div className="meta">
                  {fmtDuration(c.track.duration_ms)} · {fmtBer(c.ber)} match
                  {c.segIndex ? ` · @${Math.round(c.segOffsetSec ?? 0)}s` : ''}
                </div>
              </div>
              <span className={`conf ${c.ber > 0.3 ? 'weak' : ''}`}>{c.ber <= STRONG_BER ? 'STRONG' : c.ber <= 0.3 ? 'LIKELY' : 'WEAK'}</span>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn primary" style={{ flex: 1 }} onClick={() => openTrack(c.track.permalink_url)} title="Opens in a background tab — popup stays open">
                Open on SoundCloud
              </button>
              <button className="btn" onClick={listen} disabled={busy}>
                Retry
              </button>
            </div>
          </div>
        ))}

      {phase === 'idle' && trackCount === 0 && (
        <div className="hint">
          No index loaded. <span className="link" onClick={openOptions}>Open Options</span> to load your shazamski-index.json (built once on
          your PC — see README).
        </div>
      )}

      <div className="history">
        <div className="history-head">
          <span className="history-title">History{history.length ? ` (${history.length})` : ''}</span>
          {history.length > 0 && (
            <button
              className="btn ghost small-btn"
              onClick={async () => {
                await clearHistory();
                setHistory([]);
                setExpandedId(null);
              }}
            >
              Clear
            </button>
          )}
        </div>
        {history.length === 0 ? (
          <div className="hint">No identifications yet. Results are saved here so closing the popup never loses them.</div>
        ) : (
          history.map((h) => {
            const open = expandedId === h.id;
            const top = h.candidates[0];
            return (
              <div className="card history-card" key={h.id}>
                <div className="row history-row" onClick={() => setExpandedId(open ? null : h.id)} style={{ cursor: 'pointer' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="history-main">{top ? top.track.title : 'No confident match'}</div>
                    <div className="meta">
                      {fmtTime(h.timestamp)}
                      {top ? ` · ${fmtBer(top.ber)} match` : ''}
                      {h.candidates.length > 1 ? ` · +${h.candidates.length - 1} more` : ''}
                    </div>
                  </div>
                  <span className="muted small">{open ? '▾' : '▸'}</span>
                  <button
                    className="btn ghost small-btn"
                    onClick={async (e) => {
                      e.stopPropagation();
                      setHistory(await removeHistoryEntry(h.id));
                      if (expandedId === h.id) setExpandedId(null);
                    }}
                    title="Remove from history"
                  >
                    ✕
                  </button>
                </div>
                {open && (
                  <div className="history-detail">
                    {h.candidates.map((c) => (
                      <div className="result history-result" key={c.track.id}>
                        {c.track.artwork_url ? <img src={c.track.artwork_url} alt="" /> : null}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="title">{c.track.title}</div>
                          <div className="meta">
                            {fmtDuration(c.track.duration_ms)} · {fmtBer(c.ber)} match
                          </div>
                        </div>
                        <button className="btn small-btn" onClick={() => openTrack(c.track.permalink_url)} title="Opens in a background tab — popup stays open">
                          Open
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="footer">
        <span className="muted small">100% local · zero cost</span>
        <span className="link small" onClick={openOptions}>
          Options
        </span>
      </div>
    </div>
  );
}
