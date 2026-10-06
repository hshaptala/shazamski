#!/usr/bin/env node
import fs from 'node:fs';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function decodeB64ToRaw(b64) {
  const buf = Buffer.from(b64, 'base64');
  const out = new Int32Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt32LE(i * 4);
  return out;
}

function popcount32(x) {
  x >>>= 0;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function berAtOffset(query, target, offset) {
  const n = Math.min(query.length, target.length - offset);
  if (n <= 0) return 1;
  let bits = 0;
  for (let i = 0; i < n; i++) bits += popcount32((query[i] ^ target[offset + i]) >>> 0);
  return bits / (n * 32);
}

function bestOffset(query, target, coarseStep = 4) {
  if (target.length < query.length) return berAtOffset(query, target, 0);
  let best = 1;
  const maxOff = target.length - query.length;
  for (let off = 0; off <= maxOff; off += coarseStep) {
    const b = berAtOffset(query, target, off);
    if (b < best) { best = b; if (b < 0.05) break; }
  }
  return best;
}

function noisyCopy(raw, p, rand) {
  const out = Int32Array.from(raw);
  for (let i = 0; i < out.length; i++) {
    let w = out[i] | 0;
    let mask = 0;
    for (let b = 0; b < 32; b++) if (rand() < p) mask |= (1 << b) >>> 0;
    out[i] = (w ^ mask) | 0;
  }
  return out;
}

function quantiles(sorted, qs) {
  return qs.map((q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) {
    console.log('Usage: node tools/eval/eval-match.mjs --index FILE [--trials 300] [--query-frames 40] [--seed 42]');
    process.exit(0);
  }
  const indexPath = args.index || process.env.SHAZAMSKI_INDEX || 'shazamski-index.json';
  const trials = Math.max(10, Number(args.trials ?? 300));
  const queryFrames = Math.max(10, Number(args['query-frames'] ?? 40));
  const seed = Number(args.seed ?? 42);
  const rand = rng(seed);

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const tracks = (index.tracks ?? []).filter((t) => typeof t.fp === 'string' && (t.fpLen ?? 0) >= queryFrames + 8);
  if (!tracks.length) {
    console.error('No usable tracks (need fpLen >= queryFrames+8).');
    process.exit(2);
  }
  console.log(`[eval] ${tracks.length} usable tracks from ${indexPath} · trials=${trials} · queryFrames=${queryFrames} · seed=${seed}`);
  const decoded = tracks.map((t) => ({ id: t.id, fp: decodeB64ToRaw(t.fp) }));

  const scenarios = [
    { name: 'clean (p=0.02)', p: 0.02 },
    { name: 'opus-like (p=0.08)', p: 0.08 },
    { name: 'noisy bar (p=0.15)', p: 0.15 },
  ];
  for (const sc of scenarios) {
    const bers = [];
    const ranks = [];
    const t0 = Date.now();
    for (let i = 0; i < trials; i++) {
      const ti = Math.floor(rand() * decoded.length);
      const target = decoded[ti].fp;
      const maxOff = target.length - queryFrames;
      const off = Math.floor(rand() * (maxOff + 1));
      const slice = target.slice(off, off + queryFrames);
      const query = noisyCopy(slice, sc.p, rand);
      const sampleIdx = new Set([ti]);
      while (sampleIdx.size < Math.min(500, decoded.length)) sampleIdx.add(Math.floor(rand() * decoded.length));
      let bestId = -1; let bestBer = 1; let secondBer = 1;
      for (const idx of sampleIdx) {
        const b = bestOffset(query, decoded[idx].fp, 4);
        if (b < bestBer) { secondBer = bestBer; bestBer = b; bestId = decoded[idx].id; }
        else if (b < secondBer) secondBer = b;
      }
      bers.push(bestBer);
      ranks.push(bestId === decoded[ti].id ? 1 : 0);
    }
    bers.sort((a, b) => a - b);
    const [p50, p90, p99] = quantiles(bers, [0.5, 0.9, 0.99]);
    const recallAt = (thr) => bers.filter((b) => b <= thr).length / bers.length;
    const top1 = ranks.reduce((a, b) => a + b, 0) / ranks.length;
    const ms = Date.now() - t0;
    console.log(`\n[${sc.name}] top1-in-500: ${(top1 * 100).toFixed(1)}% · BER p50=${p50.toFixed(3)} p90=${p90.toFixed(3)} p99=${p99.toFixed(3)} · ${ms}ms`);
    console.log(`  recall @0.15=${(recallAt(0.15) * 100).toFixed(1)}%  @0.30=${(recallAt(0.30) * 100).toFixed(1)}%  @0.38=${(recallAt(0.38) * 100).toFixed(1)}%  @0.42=${(recallAt(0.42) * 100).toFixed(1)}%`);
  }
  console.log('\n[eval] Tune STRONG/LIKELY/WEAK thresholds so clean≈@0.15, opus-like≈@0.30, and noisy stays under the no-match line.');
}

main().catch((e) => { console.error('[eval] FATAL:', e?.message ?? e); process.exit(1); });
