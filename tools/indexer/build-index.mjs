#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveChannel, listAllTracks, pickTranscoding, resolveStreamUrl } from './soundcloud.mjs';
import { fpcalcFile, encodeRawToB64 } from './fingerprint-utils.mjs';
// Zero-dep .env loader: checks CWD/.env, tools/indexer/.env, and project-root/.env
// so `--client-id` / `--channel` can be omitted after first setup.
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
    catch { /* ignore malformed .env */ }
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
                out[key] = next;
                i++;
            }
        }
    }
    return out;
}
function printHelp() {
    console.log(`
Shazamski indexer — SoundCloud channel → Chromaprint index JSON

Usage:
  node build-index.mjs --channel URL --client-id ID --out shazamski-index.json [options]

Required:
  --channel URL        Public SoundCloud channel, e.g. https://soundcloud.com/your-channel
  --client-id ID       Public API key (or env SOUNDCLOUD_CLIENT_ID). Get it free from
                       DevTools Network tab while playing any soundcloud.com track.
  --out FILE           Output JSON path (default: shazamski-index.json)

Options:
  --seconds N          Seconds fingerprinted per track head (default 120, min 60, max 120).
                       90–120 recommended: covers intros while keeping the index small.
  --concurrency N      Parallel ffmpeg+fpcalc jobs (default 3). Use 2–4 to avoid rate limits.
  --limit N            Index only first N tracks (smoke test, e.g. --limit 20).
  --resume/--no-resume Skip ids already in --out (default on when file exists).
  --fpcalc BIN         fpcalc binary name/path (default: fpcalc).
  --ffmpeg BIN         ffmpeg binary name/path (default: ffmpeg).
  --dry-run            List tracks only, no audio work.
  --help               This text.

Examples:
  export SOUNDCLOUD_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  sudo apt install ffmpeg libchromaprint-tools
  node build-index.mjs --channel https://soundcloud.com/my-channel --out shazamski-index.json --limit 20
  node build-index.mjs --channel https://soundcloud.com/my-channel --out shazamski-index.json
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
    const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
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
async function fingerprintTrack(track, ctx) {
    const { seconds, ffmpegBin, fpcalcBin, workDir } = ctx;
    const tr = pickTranscoding(track);
    if (!tr)
        throw new Error('no streamable transcoding');
    const streamUrl = await resolveStreamUrl(tr.url, ctx.clientId);
    const tmpWav = path.join(workDir, `s_${track.id}.wav`);
    try {
        await downloadHeadToWav({ streamUrl, seconds, tmpWav, ffmpegBin });
        const st = fs.statSync(tmpWav);
        if (!st.size || st.size < 44 + 11025 * 2 * 2)
            throw new Error('downloaded clip too small (geo-blocked?)');
        const { raw, duration } = await fpcalcFile(tmpWav, { fpcalcBin, lengthSec: seconds });
        if (!raw || raw.length < 10)
            throw new Error(`fpcalc returned only ${raw?.length ?? 0} sub-fingerprints`);
        return {
            id: track.id,
            title: track.title,
            permalink_url: track.permalink_url,
            artwork_url: track.artwork_url,
            duration_ms: track.duration_ms,
            fp: encodeRawToB64(raw),
            fpLen: raw.length,
            fpDuration: Math.round(duration || seconds),
        };
    }
    finally {
        try {
            fs.unlinkSync(tmpWav);
        }
        catch {
        }
    }
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
    const clientId = args['client-id'] || process.env.SOUNDCLOUD_CLIENT_ID;
    const outPath = args.out || 'shazamski-index.json';
    const seconds = Math.min(120, Math.max(30, Number(args.seconds ?? 120)));
    const concurrency = Math.min(8, Math.max(1, Number(args.concurrency ?? 3)));
    const limit = args.limit ? Number(args.limit) : Infinity;
    const dryRun = !!args['dry-run'];
    const fpcalcBin = args.fpcalc || 'fpcalc';
    const ffmpegBin = args.ffmpeg || 'ffmpeg';
    if (!channel) {
        console.error('Missing --channel. See --help.');
        process.exit(2);
    }
    if (!clientId && !dryRun) {
        console.error('Missing --client-id (or env SOUNDCLOUD_CLIENT_ID). See soundcloud.mjs header for the free DevTools trick.');
        process.exit(2);
    }
    console.log(`[shazamski] Resolving ${channel} …`);
    const user = await resolveChannel(channel, clientId);
    console.log(`[shazamski] Channel: ${user.username} (@${user.permalink}) id=${user.id} (~${user.trackCount} tracks)`);
    console.log('[shazamski] Listing tracks (paginated, ~150 ms/page) …');
    const tracks = [];
    for await (const t of listAllTracks(user.id, clientId)) {
        tracks.push(t);
        if (tracks.length % 500 === 0)
            console.log(`  … ${tracks.length} listed`);
        if (tracks.length >= limit)
            break;
    }
    console.log(`[shazamski] Found ${tracks.length} tracks${Number.isFinite(limit) ? ` (limited to ${limit})` : ''}.`);
    if (dryRun) {
        for (const t of tracks.slice(0, 20))
            console.log(`  - ${t.id} ${t.title}`);
        if (tracks.length > 20)
            console.log(`  … and ${tracks.length - 20} more`);
        return;
    }
    await checkBin(ffmpegBin, ['-version'], 'ffmpeg');
    await checkBin(fpcalcBin, ['-version'], 'fpcalc');
    let existing = [];
    if (fs.existsSync(outPath) && args.resume !== 'false' && args['no-resume'] !== true) {
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
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shazamski-'));
    const ctx = { seconds, ffmpegBin, fpcalcBin, workDir, clientId };
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
    const index = {
        version: 1,
        algorithm: 'chromaprint',
        createdAt: new Date().toISOString(),
        channelUrl: channel,
        trackCount: collected.length,
        tracks: collected,
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
