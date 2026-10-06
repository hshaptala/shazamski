#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveChannel, listAllTracks, pickTranscoding, resolveStreamUrl } from './soundcloud.mjs';
import { fpcalcFile, fpcalcVersion, encodeRawToB64 } from './fingerprint-utils.mjs';
for (const p of [
    path.join(process.cwd(), '.env'),
    path.join(path.dirname(new URL(import.meta.url).pathname), '.env'),
    path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '.env'),
]) {
    try {
        if (fs.existsSync(p)) {
            for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
                const t = line.trim();
                if (!t || t.startsWith('#') || !t.includes('='))
                    continue;
                const i = t.indexOf('=');
                const k = t.slice(0, i).trim();
                let v = t.slice(i + 1).trim();
                if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
                    v = v.slice(1, -1);
                if (!(k in process.env))
                    process.env[k] = v;
            }
            break;
        }
    }
    catch { }
}
const execFileAsync = promisify(execFile);
function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next == null || next.startsWith('--'))
                out[key] = true;
            else {
                if (key === 'channel') {
                    if (out[key] === undefined) out[key] = next;
                    else if (Array.isArray(out[key])) out[key].push(next);
                    else out[key] = [out[key], next];
                } else {
                    out[key] = next;
                }
                i++;
            }
        }
    }
    return out;
}
function collectChannels(args) {
    const raw = [];
    const pushList = (v) => {
        if (v == null) return;
        const arr = Array.isArray(v) ? v : [v];
        for (const item of arr) {
            for (const part of String(item).split(/[\s,]+/)) {
                const t = part.trim().replace(/\/+$/, '');
                if (t) raw.push(t);
            }
        }
    };
    pushList(args.channel);
    pushList(process.env.SHAZAMSKI_CHANNEL);
    if (process.env.SHAZAMSKI_ARTIST) {
        for (const slug of String(process.env.SHAZAMSKI_ARTIST).split(/[\s,]+/)) {
            const t = slug.trim().replace(/^\/+|\/+$/g, '');
            if (t) raw.push(`https://soundcloud.com/${t}`);
        }
    }
    const seen = new Set();
    const out = [];
    for (const c of raw) {
        const norm = c.toLowerCase();
        if (!seen.has(norm)) { seen.add(norm); out.push(c); }
    }
    return out;
}
function printHelp() {
    console.log(`
Shazamski indexer — SoundCloud channel → Chromaprint index JSON

Usage:
  node build-index.mjs --channel URL [--channel URL …] --client-id ID --out shazamski-index.json [options]

  Multi-channel: repeat --channel, or pass a comma-separated list. Each track
  is tagged with its source channel; duplicates (same SoundCloud id) are kept
  once. Use tools/indexer/merge-indexes.mjs to combine existing per-channel
  JSON files without re-fingerprinting.

Required:
  --channel URL        Public SoundCloud channel, e.g. https://soundcloud.com/your-channel
                       Repeatable: --channel A --channel B. Or comma-separated:
                       --channel https://soundcloud.com/a,https://soundcloud.com/b
  --client-id ID       Public API key (or env SOUNDCLOUD_CLIENT_ID). Get it free from
                       DevTools Network tab while playing any soundcloud.com track.
  --out FILE           Output JSON path (default: shazamski-index.json)

Options:
  --seconds N          Seconds fingerprinted per window head (default 120, min 30, max 180).
                       90–180 recommended: covers intros while keeping the index small.
  --cover MODE         head (default) = first --seconds only; multi = head + mid window
                       (60s offset) for tracks >3min; full = windows every 60s up to 4
                       windows/track. Multi/full fix deep-mix misses at ~2-4x size.
  --windows SPEC       Explicit windows "off:len,off:len" in seconds, e.g. "0:120,60:120".
                       Overrides --cover/--seconds when given.
  --concurrency N      Parallel ffmpeg+fpcalc jobs (default 8).
  --limit N            Index only first N tracks per channel (smoke test, e.g. --limit 20).
  --resume/--no-resume Skip ids already in --out (default on when file exists).
  --fpcalc BIN         fpcalc binary name/path (default: fpcalc).
  --ffmpeg BIN         ffmpeg binary name/path (default: ffmpeg).
  --dry-run            List tracks only, no audio work.
  --help               This text.

  Every option also reads .env (CLI wins): SOUNDCLOUD_CLIENT_ID, SHAZAMSKI_CHANNEL
  (or SHAZAMSKI_ARTIST slug — both accept comma-separated lists), SHAZAMSKI_OUT,
  SHAZAMSKI_SECONDS, SHAZAMSKI_CONCURRENCY,
  SHAZAMSKI_LIMIT, SHAZAMSKI_FPCALC, SHAZAMSKI_FFMPEG, SHAZAMSKI_DRY_RUN=1, SHAZAMSKI_NO_RESUME=1.

Examples:
  export SOUNDCLOUD_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  sudo apt install ffmpeg libchromaprint-tools
  node build-index.mjs --channel https://soundcloud.com/my-channel --out shazamski-index.json --limit 20
  node build-index.mjs --channel https://soundcloud.com/my-channel --out shazamski-index.json
  # two channels, one file:
  node build-index.mjs --channel https://soundcloud.com/a --channel https://soundcloud.com/b --out multi.json
  # or comma-separated (same thing):
  node build-index.mjs --channel https://soundcloud.com/a,https://soundcloud.com/b --out multi.json
  # .env alternative: SHAZAMSKI_CHANNEL="https://soundcloud.com/a, https://soundcloud.com/b"
`);
}
async function checkBin(bin, probeArgs, label) {
    try {
        await execFileAsync(bin, probeArgs);
        return true;
    }
    catch (e) {
        const msg = e?.message ?? '';
        if (/ENOENT|not found/i.test(msg)) {
            throw new Error(`${label} binary "${bin}" not found in PATH. Install it and retry.`);
        }
        return true;
    }
}
async function downloadHeadToWav({ streamUrl, seconds, tmpWav, ffmpegBin }) {
    return downloadWindowToWav({ streamUrl, offsetSec: 0, seconds, tmpWav, ffmpegBin });
}
async function downloadWindowToWav({ streamUrl, offsetSec = 0, seconds, tmpWav, ffmpegBin }) {
    const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        ...(offsetSec > 0 ? ['-ss', String(offsetSec)] : []),
        '-i',
        streamUrl,
        '-t',
        String(seconds),
        '-ar',
        '11025',
        '-ac',
        '1',
        '-f',
        'wav',
        tmpWav,
    ];
    await execFileAsync(ffmpegBin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
}
function windowsForTrack(durationMs, seconds, mode, explicit) {
    if (explicit?.length) return explicit;
    if (mode === 'head') return [{ offsetSec: 0, seconds }];
    const durSec = Math.max(0, Math.round((durationMs || 0) / 1000));
    if (mode === 'multi') {
        if (durSec >= 200) return [{ offsetSec: 0, seconds }, { offsetSec: 60, seconds: Math.min(seconds, Math.max(30, durSec - 60)) }];
        return [{ offsetSec: 0, seconds }];
    }
    if (mode === 'full') {
        const out = [{ offsetSec: 0, seconds }];
        for (let off = 60; off + 30 < durSec && out.length < 4; off += 60) {
            out.push({ offsetSec: off, seconds: Math.min(seconds, durSec - off) });
        }
        return out;
    }
    return [{ offsetSec: 0, seconds }];
}
function parseWindowsSpec(spec, fallbackSeconds) {
    if (!spec) return null;
    const out = [];
    for (const part of String(spec).split(',')) {
        const m = part.trim().match(/^(\d+(?:\.\d+)?)\s*[:\-]\s*(\d+(?:\.\d+)?)$/) || part.trim().match(/^(\d+(?:\.\d+)?)$/);
        if (!m) throw new Error(`Bad --windows entry "${part}" (expected "off:len")`);
        if (m[2] !== undefined) out.push({ offsetSec: Number(m[1]), seconds: Math.min(180, Math.max(15, Number(m[2]))) });
        else out.push({ offsetSec: 0, seconds: Math.min(180, Math.max(15, Number(m[1]) || fallbackSeconds)) });
    }
    return out.length ? out : null;
}
async function fingerprintTrack(track, ctx) {
    const { seconds, ffmpegBin, fpcalcBin, workDir, cover, explicitWindows } = ctx;
    const tr = pickTranscoding(track);
    if (!tr)
        throw new Error('no streamable transcoding');
    const streamUrl = await resolveStreamUrl(tr.url, ctx.clientId);
    const windows = windowsForTrack(track.duration_ms, seconds, cover, explicitWindows);
    const segs = [];
    let primary = null;
    for (let w = 0; w < windows.length; w++) {
        const { offsetSec, seconds: len } = windows[w];
        const tmpWav = path.join(workDir, `s_${track.id}_${w}.wav`);
        try {
            await downloadWindowToWav({ streamUrl, offsetSec, seconds: len, tmpWav, ffmpegBin });
            const st = fs.statSync(tmpWav);
            if (!st.size || st.size < 44 + 11025 * 2 * 2)
                throw new Error('downloaded clip too small (geo-blocked?)');
            const { raw, duration } = await fpcalcFile(tmpWav, { fpcalcBin, lengthSec: len });
            if (!raw || raw.length < 10)
                throw new Error(`fpcalc returned only ${raw?.length ?? 0} sub-fingerprints`);
            const entry = {
                fp: encodeRawToB64(raw),
                fpLen: raw.length,
                fpDuration: Math.round(duration || len),
                offsetSec,
            };
            if (w === 0) primary = entry;
            else segs.push(entry);
        }
        finally {
            try {
                fs.unlinkSync(tmpWav);
            }
            catch {
            }
        }
    }
    if (!primary) throw new Error('no windows fingerprinted');
    const out = {
        id: track.id,
        title: track.title,
        permalink_url: track.permalink_url,
        artwork_url: track.artwork_url,
        duration_ms: track.duration_ms,
        fp: primary.fp,
        fpLen: primary.fpLen,
        fpDuration: primary.fpDuration,
        source: track._source || undefined,
    };
    if (segs.length) out.segs = segs;
    return out;
}
async function runPool(items, concurrency, fn, onItem) {
    const results = new Array(items.length);
    let next = 0;
    let done = 0;
    const failures = [];
    async function worker() {
        while (true) {
            const i = next++;
            if (i >= items.length)
                return;
            try {
                results[i] = await fn(items[i], i);
            }
            catch (e) {
                failures.push({ item: items[i], error: String(e?.message ?? e) });
                results[i] = null;
            }
            finally {
                done++;
                onItem?.(done, items.length);
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return { results, failures };
}
async function main() {
    const args = parseArgs(process.argv);
    if (args.help || args.h) {
        printHelp();
        process.exit(0);
    }
    const channel = args.channel || process.env.SHAZAMSKI_CHANNEL
        || (process.env.SHAZAMSKI_ARTIST ? `https://soundcloud.com/${process.env.SHAZAMSKI_ARTIST}` : undefined);
    void channel;
    const channels = collectChannels(args);
    const clientId = args['client-id'] || process.env.SOUNDCLOUD_CLIENT_ID;
    const outPath = args.out || process.env.SHAZAMSKI_OUT || 'shazamski-index.json';
    const seconds = Math.min(180, Math.max(30, Number(args.seconds ?? process.env.SHAZAMSKI_SECONDS ?? 120)));
    const concurrency = Math.min(16, Math.max(1, Number(args.concurrency ?? process.env.SHAZAMSKI_CONCURRENCY ?? 8)));
    const limit = args.limit ? Number(args.limit) : (process.env.SHAZAMSKI_LIMIT ? Number(process.env.SHAZAMSKI_LIMIT) : Infinity);
    const dryRun = !!args['dry-run'] || ['1', 'true', 'yes'].includes((process.env.SHAZAMSKI_DRY_RUN ?? '').toLowerCase());
    const fpcalcBin = args.fpcalc || process.env.SHAZAMSKI_FPCALC || 'fpcalc';
    const ffmpegBin = args.ffmpeg || process.env.SHAZAMSKI_FFMPEG || 'ffmpeg';
    const cover = String(args.cover || process.env.SHAZAMSKI_COVER || 'head').toLowerCase();
    if (!['head', 'multi', 'full'].includes(cover)) {
        console.error('Bad --cover (expected head|multi|full).');
        process.exit(2);
    }
    let explicitWindows = null;
    try {
        explicitWindows = parseWindowsSpec(args.windows || process.env.SHAZAMSKI_WINDOWS, seconds);
    } catch (e) {
        console.error(`Bad --windows: ${e?.message ?? e}`);
        process.exit(2);
    }
    const noResume = args['no-resume'] === true || args.resume === 'false' || ['1', 'true', 'yes'].includes((process.env.SHAZAMSKI_NO_RESUME ?? '').toLowerCase());
    if (!channels.length) {
        console.error('Missing --channel. See --help.');
        process.exit(2);
    }
    if (!clientId && !dryRun) {
        console.error('Missing --client-id (or env SOUNDCLOUD_CLIENT_ID). See soundcloud.mjs header for the free DevTools trick.');
        process.exit(2);
    }
    const tracks = [];
    const seenTrackIds = new Set();
    let dupes = 0;
    for (const channel of channels) {
        console.log(`[shazamski] Resolving ${channel} …`);
        const user = await resolveChannel(channel, clientId);
        console.log(`[shazamski] Channel: ${user.username} (@${user.permalink}) id=${user.id} (~${user.trackCount} tracks)`);
        console.log('[shazamski] Listing tracks (paginated, ~150 ms/page) …');
        let listed = 0;
        for await (const t of listAllTracks(user.id, clientId)) {
            if (seenTrackIds.has(t.id)) { dupes++; continue; }
            seenTrackIds.add(t.id);
            tracks.push({ ...t, _source: channel });
            listed++;
            if (tracks.length % 500 === 0)
                console.log(`  … ${tracks.length} listed (total across ${channels.length} channel(s))`);
            if (listed >= limit)
                break;
        }
        console.log(`[shazamski] ${channel}: ${listed} tracks${Number.isFinite(limit) ? ` (limited to ${limit})` : ''}.`);
    }
    console.log(`[shazamski] Found ${tracks.length} unique tracks across ${channels.length} channel(s)${dupes ? ` (${dupes} cross-channel duplicates skipped)` : ''}.`);
    if (dryRun) {
        for (const t of tracks.slice(0, 20))
            console.log(`  - ${t.id} ${t.title} [${t._source}]`);
        if (tracks.length > 20)
            console.log(`  … and ${tracks.length - 20} more`);
        return;
    }
    await checkBin(ffmpegBin, ['-version'], 'ffmpeg');
    await checkBin(fpcalcBin, ['-version'], 'fpcalc');
    let existing = [];
    if (fs.existsSync(outPath) && !noResume) {
        try {
            const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
            if (Array.isArray(prev.tracks)) {
                existing = prev.tracks;
                console.log(`[shazamski] Resume: ${existing.length} tracks already in ${outPath}.`);
            }
        }
        catch {
            console.log('[shazamski] Existing out file unreadable — starting fresh.');
        }
    }
    const haveIds = new Set(existing.map((t) => t.id));
    const todo = tracks.filter((t) => !haveIds.has(t.id));
    console.log(`[shazamski] To fingerprint: ${todo.length} (skipping ${existing.length} already done).`);
    const fpcalcVer = await fpcalcVersion(fpcalcBin);
    console.log(`[shazamski] fpcalc: ${fpcalcVer} · cover=${explicitWindows ? explicitWindows.map((w) => `${w.offsetSec}:${w.seconds}`).join(',') : cover} · seconds=${seconds}`);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shazamski-'));
    const ctx = { seconds, ffmpegBin, fpcalcBin, workDir, clientId, cover, explicitWindows };
    const t0 = Date.now();
    const collected = [...existing];
    const { results, failures } = await runPool(todo, concurrency, (t) => fingerprintTrack(t, ctx), (done, total) => {
        const el = ((Date.now() - t0) / 1000).toFixed(0);
        process.stdout.write(`\r[shazamski] ${done}/${total} done, ${failuresPreview()} fail · ${el}s`);
    });
    function failuresPreview() {
        return '';
    }
    process.stdout.write('\n');
    let okCount = 0;
    for (const r of results) {
        if (r) {
            collected.push(r);
            okCount++;
        }
    }
    collected.sort((a, b) => a.id - b.id);
    const coverage = explicitWindows ? (explicitWindows.length > 1 ? 'multi-window' : 'head') : (cover === 'head' ? 'head' : cover === 'multi' ? 'multi-window' : 'full');
    const prevUrls = [];
    try {
        const prevRaw = fs.existsSync(outPath) && !noResume ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : null;
        if (Array.isArray(prevRaw?.channelUrls)) prevUrls.push(...prevRaw.channelUrls);
        else if (typeof prevRaw?.channelUrl === 'string' && prevRaw.channelUrl) prevUrls.push(prevRaw.channelUrl);
    } catch { }
    const channelUrls = [...prevUrls, ...channels].filter(
        (u, i, a) => a.findIndex((x) => x.toLowerCase() === u.toLowerCase()) === i,
    );
    const index = {
        version: 1,
        algorithm: 'chromaprint',
        createdAt: new Date().toISOString(),
        channelUrl: channelUrls[0] ?? channels[0],
        channelUrls,
        trackCount: collected.length,
        tracks: collected,
        fpcalcVersion: fpcalcVer,
        targetSampleRate: 11025,
        algorithmHash: 'chromaprint-fpcalc-raw-le-v1',
        coverage,
    };
    fs.writeFileSync(outPath, JSON.stringify(index));
    const mb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
    console.log(`[shazamski] Wrote ${outPath}: ${collected.length} tracks, ${mb} MB (${okCount} new this run).`);
    if (failures.length) {
        console.log(`[shazamski] ${failures.length} failures (first 15):`);
        for (const f of failures.slice(0, 15))
            console.log(`  - ${f.item.id} ${f.item.title}: ${f.error}`);
        fs.writeFileSync(outPath + '.failures.json', JSON.stringify(failures.map((f) => ({ id: f.item.id, title: f.item.title, error: f.error })), null, 2));
        console.log(`[shazamski] Full failure list → ${outPath}.failures.json (re-run to retry; resume skips successes).`);
    }
    try {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
    catch {
    }
}
main().catch((e) => {
    console.error('[shazamski] FATAL:', e?.message ?? e);
    process.exit(1);
});
