import { useEffect, useState } from 'react';
import type { IndexFile, IndexMeta } from '../../utils/types';
import { getChannelConfig, setChannelConfig, setIndexMeta, clearIndexMeta } from '../../utils/config';
import { clearTracks, countTracks, getMeta, putMeta, putTracks } from '../../utils/index-db';
import { invalidateWorkerIndex } from '../../utils/matcher-client';
function fmtBytes(n: number): string {
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function validateIndex(json: any): asserts json is IndexFile {
    if (!json || typeof json !== 'object')
        throw new Error('Not a JSON object.');
    if (json.version !== 1)
        throw new Error(`Unsupported index version (${String(json.version)}). Rebuild with the current indexer.`);
    if (!Array.isArray(json.tracks))
        throw new Error('Index has no tracks array.');
    if (json.tracks.length === 0)
        throw new Error('Index contains zero tracks.');
    const t = json.tracks[0];
    if (typeof t?.id !== 'number' || typeof t?.fp !== 'string' || typeof t?.permalink_url !== 'string') {
        throw new Error('Track entries look corrupt (missing id/fp/permalink_url).');
    }
}
export default function App() {
    const [channelUrl, setChannelUrl] = useState('');
    const [savedTick, setSavedTick] = useState<string | null>(null);
    const [meta, setMeta] = useState<IndexMeta | null>(null);
    const [count, setCount] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<string>('');
    const [error, setError] = useState<string | null>(null);
    const [dragOver, setDragOver] = useState(false);
    useEffect(() => {
        (async () => {
            try {
                const [cfg, m, n] = await Promise.all([
                    getChannelConfig().catch(() => ({ channelUrl: '' })),
                    getMeta().catch(() => null),
                    countTracks().catch(() => 0),
                ]);
                setChannelUrl(cfg.channelUrl ?? '');
                setMeta(m);
                setCount(n);
            }
            catch (e) {
                console.warn(e);
            }
        })();
        document.body.style.minWidth = '480px';
        const root = document.getElementById('root');
        if (root)
            root.style.width = '100%';
    }, []);
    async function saveChannel() {
        setError(null);
        const parts = channelUrl.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
        const bad = parts.find((v) => !/^https:\/\/(www\.)?soundcloud\.com\//.test(v));
        if (bad) {
            setError(`"${bad}" does not look like a SoundCloud channel URL (expected https://soundcloud.com/…). Separate multiple channels with commas.`);
            return;
        }
        await setChannelConfig({ channelUrl: parts.join(', ') });
        setChannelUrl(parts.join(', '));
        setSavedTick(new Date().toLocaleTimeString());
        setTimeout(() => setSavedTick(null), 2500);
    }
    async function loadFile(file: File) {
        setError(null);
        setBusy(true);
        setProgress(`Reading ${file.name}…`);
        try {
            const text = await file.text();
            setProgress(`Parsing ${(text.length / 1024 / 1024).toFixed(1)} MB… (large indexes take a few seconds)`);
            await new Promise((r) => setTimeout(r, 30));
            const json = JSON.parse(text);
            validateIndex(json);
            setProgress(`Storing ${json.tracks.length.toLocaleString()} tracks…`);
            await clearTracks();
            await putTracks(json.tracks, (done, total) => {
                setProgress(`Storing… ${done.toLocaleString()} / ${total.toLocaleString()}`);
            });
            const channelUrls = Array.isArray(json.channelUrls)
                ? json.channelUrls.filter((u: any) => typeof u === 'string')
                : [];
            const metaOut: IndexMeta = {
                channelUrl: String(json.channelUrl ?? channelUrls[0] ?? channelUrl.trim() ?? ''),
                channelUrls: channelUrls.length ? channelUrls : undefined,
                trackCount: json.tracks.length,
                createdAt: String(json.createdAt ?? new Date().toISOString()),
                loadedAt: new Date().toISOString(),
                bytesApprox: text.length,
                fpcalcVersion: typeof json.fpcalcVersion === 'string' ? json.fpcalcVersion : undefined,
                algorithmHash: typeof json.algorithmHash === 'string' ? json.algorithmHash : undefined,
                coverage: typeof json.coverage === 'string' ? json.coverage : 'head',
            };
            await putMeta(metaOut);
            await setIndexMeta(metaOut);
            invalidateWorkerIndex();
            setMeta(metaOut);
            setCount(json.tracks.length);
            setProgress(`Done — ${json.tracks.length.toLocaleString()} tracks ready.`);
        }
        catch (e: any) {
            setError(`Could not load index: ${e?.message ?? e}`);
            setProgress('');
        }
        finally {
            setBusy(false);
        }
    }
    async function clearIndex() {
        if (!confirm('Remove all indexed fingerprints from this browser?'))
            return;
        await clearTracks();
        await clearIndexMeta();
        invalidateWorkerIndex();
        setMeta(null);
        setCount(0);
        setProgress('Index cleared.');
    }
    return (<div className="app" style={{ maxWidth: 640, margin: '24px auto' }}>
      <div className="brand">
        <div className="brand-mark">S</div>
        <div>
          <h1>Shazamski — Options</h1>
          <p>Chrome build · local-first · zero cost</p>
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: '0 0 8px' }}>1 · SoundCloud channels</h3>
        <div className="muted" style={{ marginBottom: 8 }}>
          The channels your offline index was built from (comma-separated for
          multi-channel indexes). Stored for reference — matching always uses the loaded index
          below, never the network.
        </div>
        <div className="row">
          <input value={channelUrl} onChange={(e) => setChannelUrl(e.target.value)} placeholder="https://soundcloud.com/channel-a, https://soundcloud.com/channel-b" style={{
            flex: 1,
            background: '#0f1319',
            border: '1px solid #334052',
            borderRadius: 10,
            color: 'inherit',
            padding: '9px 10px',
            fontSize: 13,
        }}/>
          <button className="btn primary" onClick={saveChannel}>
            Save
          </button>
        </div>
        {savedTick && <div className="muted small" style={{ marginTop: 6 }}>Saved ✓ ({savedTick})</div>}
      </div>

      <div className="card">
        <h3 style={{ margin: '0 0 8px' }}>2 · Fingerprint index</h3>
        <div className="muted" style={{ marginBottom: 8 }}>
          Build <code>shazamski-index.json</code> once on your PC with <code>tools/indexer</code> (see README), then
          load it here. Stored in IndexedDB — 20–40 MB is fine.
        </div>

        <div onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
        }} onDragLeave={() => setDragOver(false)} onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f)
                void loadFile(f);
        }} style={{
            border: `2px dashed ${dragOver ? '#ff7a33' : '#334052'}`,
            borderRadius: 12,
            padding: 18,
            textAlign: 'center',
            background: dragOver ? '#1d1409' : 'transparent',
        }}>
          <input type="file" accept=".json,application/json" disabled={busy} onChange={(e) => {
            const f = e.target.files?.[0];
            if (f)
                void loadFile(f);
            e.target.value = '';
        }}/>
          <div className="muted small" style={{ marginTop: 6 }}>
            …or drag &amp; drop shazamski-index.json here
          </div>
        </div>

        {(progress || busy) && <div className="muted" style={{ marginTop: 8 }}>{progress}</div>}
        {error && (<div className="error" style={{ marginTop: 8 }}>
            {error}
          </div>)}

        <div className="card" style={{ marginTop: 10, background: '#0f1319' }}>
          <div className="muted small">STATUS</div>
          <div style={{ fontSize: 14, marginTop: 4 }}>
            {(count ?? 0).toLocaleString()} tracks loaded
            {meta ? ` · index built ${new Date(meta.createdAt).toLocaleDateString()}` : ''}
          </div>
          {meta && (<div className="muted small" style={{ marginTop: 4 }}>
              {fmtBytes(meta.bytesApprox)} · loaded {new Date(meta.loadedAt).toLocaleString()}
              {meta.coverage ? ` · ${meta.coverage}` : ''}
              {meta.fpcalcVersion ? ` · fpcalc ${meta.fpcalcVersion}` : ''}
            </div>)}
          {meta && (meta.channelUrls?.length ? meta.channelUrls : meta.channelUrl ? [meta.channelUrl] : []).length > 0 && (
            <div className="muted small" style={{ marginTop: 4 }}>
              Channels ({(meta.channelUrls?.length ?? 1)}): {(meta.channelUrls ?? [meta.channelUrl]).join(', ')}
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn ghost" onClick={clearIndex} disabled={busy || !count}>
              Clear index
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ margin: '0 0 8px' }}>3 · Capture notes</h3>
        <div className="hint">
          • <b>Tab audio only</b> (no microphone): captures the playing tab via an offscreen document — your music
          keeps playing aloud while we record 10 s.<br />• Protected pages (chrome://, Chrome Web Store) cannot be
          captured — identify audio playing in a normal tab.
        </div>
      </div>

      <div className="hint">
        Build the index: <code>node tools/indexer/build-index.mjs --channel URL --client-id ID --out
        shazamski-index.json</code> — full guide in README.md.
      </div>
    </div>);
}
