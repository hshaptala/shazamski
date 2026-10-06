#!/usr/bin/env node
import fs from 'node:fs';

function parseArgs(argv) {
  const out = { in: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--in') out.in.push(argv[++i]);
    else if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] == null ? true : argv[++i];
    else out.in.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h || !args.out || !args.in.length) {
    console.log(`Usage:
  node tools/indexer/merge-indexes.mjs --out multi.json a.json b.json [c.json …]

Merges per-channel indexes without re-fingerprinting. Duplicates (same id)
are kept once (first file wins); channelUrls is the union of inputs.`);
    process.exit(args.help || args.h ? 0 : 2);
  }
  const seen = new Map();
  const channelUrls = [];
  const pushUrl = (u) => {
    if (!u || typeof u !== 'string') return;
    if (!channelUrls.some((x) => x.toLowerCase() === u.toLowerCase())) channelUrls.push(u);
  };
  for (const file of args.in) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(j.tracks)) throw new Error(`${file}: no tracks array`);
    if (Array.isArray(j.channelUrls)) j.channelUrls.forEach(pushUrl);
    if (typeof j.channelUrl === 'string') pushUrl(j.channelUrl);
    let added = 0;
    for (const t of j.tracks) {
      if (seen.has(t.id)) continue;
      if (!t.source && typeof j.channelUrl === 'string') t.source = j.channelUrl;
      seen.set(t.id, t);
      added++;
    }
    console.log(`[merge] ${file}: ${j.tracks.length} tracks, ${added} new`);
  }
  const tracks = [...seen.values()].sort((a, b) => a.id - b.id);
  const merged = {
    version: 1,
    algorithm: 'chromaprint',
    createdAt: new Date().toISOString(),
    channelUrl: channelUrls[0] ?? '',
    channelUrls,
    trackCount: tracks.length,
    tracks,
  };
  for (const file of args.in) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of ['fpcalcVersion', 'targetSampleRate', 'algorithmHash', 'coverage']) {
      if (merged[k] === undefined && j[k] !== undefined) merged[k] = j[k];
    }
    if (merged.coverage !== undefined) break;
  }
  fs.writeFileSync(args.out, JSON.stringify(merged));
  console.log(`[merge] Wrote ${args.out}: ${tracks.length} tracks from ${channelUrls.length} channel(s) (${(fs.statSync(args.out).size / 1024 / 1024).toFixed(1)} MB)`);
  if (channelUrls.length) console.log(`[merge] Channels: ${channelUrls.join(', ')}`);
}

main();
