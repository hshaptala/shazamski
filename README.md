# Shazamski

Shazam-like Chrome extension that identifies tab audio **only against one curated public SoundCloud channel** (~8200 old, exclusive, non-commercial tracks).

100% local, zero cost: no AudD, no ACRCloud, no server. You build a Chromaprint fingerprint index once on your PC, load it into the extension, then every identification runs on-device (WASM fingerprint → Web Worker Hamming search → IndexedDB metadata).

Built with **WXT + TypeScript + React**, Chrome Manifest V3.

---

## Contents

- `entrypoints/` — WXT entrypoints
  - `background.ts` — MV3 service worker: owns the tab-capture handshake
  - `offscreen.html` + `offscreen/main.ts` — offscreen document: holds the tab MediaStream, keeps audio audible, records 10 s
  - `popup.html` + `popup/` — React popup: Listen button, Idle → Listening → Identifying → Result / No match
  - `options.html` + `options/` — React options page: channel URL + index file loader + status
- `utils/` — shared library
  - `fingerprint.ts` — mono-11025 resample, `rusty-chromaprint-wasm` adapter (bit-exact), JS chroma fallback (shape-compatible), base64 LE codec, Hamming/BER
  - `matcher.ts` + `matcher.worker.ts` — offset-tolerant Hamming search, worker protocol
  - `index-db.ts` — IndexedDB store for the 20–40 MB index (storage.local is too small)
  - `audio-capture.ts`, `config.ts`, `types.ts`, `sc-utils.ts`
- `tools/indexer/` — offline Node.js indexer (zero-dep, needs `ffmpeg` + `fpcalc` + free SoundCloud `client_id`)
- `public/icons/`, `public/sample-index.json` — icons + 2-track sample index for smoke tests

---

## 1. Build the fingerprint index (once, on your PC)

### 1a. Install free tools

```bash
# Ubuntu/Debian
sudo apt install ffmpeg libchromaprint-tools
# macOS
brew install ffmpeg chromaprint
# Verify
ffmpeg -version
fpcalc -version
node -v   # >= 18
```

`fpcalc` comes from the free Chromaprint package (AcoustID project). `ffmpeg` + `fpcalc` are the only native deps — both free.

### 1b. Get a free SoundCloud `client_id` (no signup, no payment)

The public SoundCloud web player embeds a 32-char hex key in every `api-v2.soundcloud.com` request. To copy it:

1. Open https://soundcloud.com in Chrome, press F12 → **Network** tab.
2. Play any track, type `client_id` in the Network filter.
3. Copy the `client_id=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` value from any request URL.
4. Export it:
   ```bash
   export SOUNDCLOUD_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

This is a public widget key, not a secret. If it stops working (SoundCloud rotates keys every few months), repeat the 30-second copy.

### 1c. Run the indexer

```bash
cd shazamski
# Smoke test: first 20 tracks only (~5 min)
node tools/indexer/build-index.mjs \
  --channel https://soundcloud.com/YOUR-CHANNEL \
  --out shazamski-index.json \
  --seconds 120 --concurrency 3 --limit 20

# Full run: ~8200 tracks (hours; resume-safe)
node tools/indexer/build-index.mjs \
  --channel https://soundcloud.com/YOUR-CHANNEL \
  --out shazamski-index.json \
  --seconds 120 --concurrency 3
```

What it does per track:

1. `resolve` channel URL → user id; paginate `/users/{id}/tracks` (200/page, polite 150 ms delay).
2. Pick the **progressive MP3** transcoding (seekable, Range-friendly); resolve its stream URL.
3. `ffmpeg -t 120 -i STREAM -ar 11025 -ac 1 clip.wav` — downloads **only the first 90–120 s** (~2 MB/track instead of full songs; ~16 GB saved on 8200 tracks).
4. `fpcalc -json -raw clip.wav` → raw int32 sub-fingerprints → base64 little-endian + metadata.
5. Append `{ id, title, permalink_url, artwork_url, duration_ms, fp, fpLen, fpDuration }`.

Other flags: `--seconds 90`, `--concurrency 2`, `--limit N`, `--dry-run` (list only), `--fpcalc/--ffmpeg` paths, `--no-resume`. Re-running with the same `--out` **skips ids already indexed**; failures go to `shazamski-index.json.failures.json` — just re-run to retry.

Expected output: single JSON `{ version:1, algorithm:"chromaprint", channelUrl, trackCount, tracks:[…] }`, roughly **12–30 MB for 8200 tracks** (~1–2 KB/track). `tools/indexer/sample-index.json` shows the exact schema with 2 placeholder tracks.

> **Algorithm note:** `fpcalc`'s default fingerprint string is *compressed* (good for AcoustID, useless for local Hamming). The indexer prefers `fpcalc -raw` (raw int32 list) and otherwise decodes the compressed form (`fingerprint-utils.mjs`). The browser stores raw values for the same reason — BER comparison needs bit-level access.

---

## 2. Load the index into the extension

1. `npm install`, then run dev or build (below) and load the extension.
2. Open **Options** (right-click the toolbar icon → Options, or the *Options* link in the popup).
3. Paste your **SoundCloud channel URL** → Save (stored in `browser.storage.local`, reference only).
4. Under *Fingerprint index*, choose `shazamski-index.json` (or drag & drop). Status shows `N tracks loaded · size · dates`.
5. The popup header updates to `N tracks indexed`. Clearing is one click (*Clear index*).

Storage split is deliberate: `storage.local` (~5 MB cap) holds only config + meta; the real index lives in **IndexedDB** (`shazamski` DB, `tracks` store), which comfortably holds 40 MB.

---

## 3. Develop & build (Chrome, WXT)

```bash
cd shazamski
npm install

npm run dev            # dev + HMR (load .output/chrome-mv3-dev unpacked)
npm run typecheck      # tsc --noEmit

npm run build          # → .output/chrome-mv3/
npm run zip            # store-ready zip
```

Load unpacked: `chrome://extensions` → Developer mode → Load unpacked → `.output/chrome-mv3`.

`wxt.config.ts` declares `storage` + `activeTab` + `tabCapture` + `offscreen` permissions, SoundCloud host permissions, and React via `@wxt-dev/module-react`.

---

## 4. Use it

1. Play audio in a browser tab.
2. Click the toolbar icon → **🎧 Listen** (tab audio only — no microphone, no picker).
3. Watch Idle → Listening (live dot + seconds) → Identifying (worker progress) → **Result card** (artwork, title, duration, confidence badge, *Open on SoundCloud*) or *No match* with tips.

Error states are explicit: no index (→ Options link), permission denied, silence (unmute/turn up), protected pages (`chrome://`, Web Store — identify audio in a normal tab).

---

## 5. Audio capture notes

- **Tab audio only, no microphone:** capture runs in an offscreen document via `chrome.tabCapture`, routed so your music keeps playing aloud while 10 s are recorded.
- Service workers cannot hold MediaStreams, so the background only handshakes stream ids; recording lives in `entrypoints/offscreen/main.ts`.
- Protected pages (`chrome://`, Chrome Web Store) cannot be captured — identify audio playing in a normal tab.
- Tab capture needs an active-tab user gesture; the extension never requests microphone access.

---

## 6. Architecture overview

```
SoundCloud channel
      │  tools/indexer (Node, once, on your PC)
      │  resolve → paginate → ffmpeg head (120 s) → fpcalc -raw → base64 LE
      ▼
shazamski-index.json (12–30 MB)
      │  Options page → IndexedDB `tracks` (+ meta in storage.local)
      ▼
Popup [Listen] ──▶ background ──streamId──▶ offscreen (record 10 s, audible)
      ▼ mono 11025 PCM
fingerprint.ts: rusty-chromaprint-wasm (bit-exact) → Int32Array, else JS fallback
      ▼ query sub-fps (~20–60)
matcher.worker.ts: coarse slide (step 4) + refine, BER = Hamming/32, top-3, < 2 s / 8200 tracks
      ▼
Result card (title, artwork, duration, confidence, SoundCloud link)
```

**Matching math:** for each track, slide the query across the stored head at step 4, score each offset by mean bit-error-rate, refine ±4 around the best, keep lowest BER. `score = 1 − BER`; thresholds: `< 0.15` strong, `< 0.30` likely, `< 0.42` weak-but-shown, above → *No match*. Early exit on near-perfect hits + cooperative yields keep the worker responsive; `fpCache` avoids re-decoding base64 on repeat queries.

**Why raw fingerprints:** the AcoustID-compressed string cannot be Hamming-compared without full decode, and offset-tolerant search needs per-frame bits. Raw int32 arrays (≈800 B/track head) are the compact sweet spot.

---

## 7. Production notes & limits

- **WASM wiring:** `npm i rusty-chromaprint-wasm` is already a dependency; `fingerprint.ts` probes all known export shapes (`fingerprint_audio`, `fingerprint`, `Fingerprinter` class…) and falls back to the bundled JS chroma fingerprinter if the pack layout drifts. For bit-exact matching, **index and query must use the same algorithm** — production = WASM/fpcalc on both sides. The JS fallback is shape-compatible (still Hamming-searchable) for smoke tests only.
- **First-2-minutes scope:** the index covers track heads; clips from deep in a 10-minute mix may miss. The popup says so in its no-match tips.
- **Out of scope:** paid APIs, continuous monitoring, SoundCloud uploads/edits, Firefox/Safari.
- **Privacy:** everything runs locally; the extension makes zero network calls during identification (only SoundCloud link-outs you click).

---

## 8. Troubleshooting

- `fpcalc not found` → install `libchromaprint-tools` / `brew install chromaprint`.
- `ffmpeg not found` → install ffmpeg, ensure PATH.
- `resolve failed (401/403)` → refresh your `client_id` via the DevTools trick.
- `no streamable transcoding` → track is geo-blocked or private; it lands in `.failures.json`, skipped gracefully.
- Popup says *only silence* → unmute, raise volume, ensure the right tab is playing.
- `Tab capture unavailable` on `chrome://` → expected; identify audio in a normal tab.
- Large index `.json` parse hangs the Options tab → normal for 30 MB; the loader yields before `JSON.parse` and reports progress per 500-track chunk.

---

## License

MIT — do what you want; attribution appreciated. Chromaprint © Lukáš Lalinský (MIT); SoundCloud content belongs to its uploaders — this tool only fingerprints public streams you could already hear.
