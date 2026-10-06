import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

let cachedVersion = null;

export async function fpcalcVersion(fpcalcBin = 'fpcalc') {
  if (cachedVersion) return cachedVersion;
  try {
    const { stdout, stderr } = await execFileAsync(fpcalcBin, ['-version'], { timeout: 15000 });
    const text = `${stdout ?? ''} ${stderr ?? ''}`.trim().split('\n')[0].slice(0, 120);
    cachedVersion = text || 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

export async function fpcalcFile(wavPath, { fpcalcBin = 'fpcalc', lengthSec = 120 } = {}) {
  const attempts = [
    [fpcalcBin, ['-json', '-raw', '-length', String(lengthSec), wavPath]],
    [fpcalcBin, ['-raw', '-length', String(lengthSec), wavPath]],
    [fpcalcBin, ['-json', '-length', String(lengthSec), wavPath]],
  ];
  let lastErr;
  for (const [bin, args] of attempts) {
    try {
      const { stdout } = await execFileAsync(bin, args, { maxBuffer: 32 * 1024 * 1024 });
      const parsed = parseFpcalcOutput(stdout, args.includes('-raw'));
      if (parsed) return parsed;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`fpcalc failed on ${wavPath}: ${lastErr?.message ?? lastErr}`);
}

function parseFpcalcOutput(stdout, rawMode) {
  const text = stdout.trim();
  if (text.startsWith('{')) {
    const j = JSON.parse(text);
    const fpStr = String(j.fingerprint ?? '');
    const duration = Number(j.duration ?? 0);
    if (!fpStr) return null;
    if (rawMode || fpStr.includes(',')) {
      return { raw: parseRawList(fpStr), duration };
    }
    return { raw: decodeCompressedFingerprint(fpStr), duration };
  }
  const m = text.match(/FINGERPRINT=(.+)/);
  const fpStr = (m ? m[1] : text.split('\n')[0]).trim();
  const dm = text.match(/DURATION=(\d+)/);
  const duration = dm ? Number(dm[1]) : 0;
  if (fpStr.includes(',')) return { raw: parseRawList(fpStr), duration };
  return { raw: decodeCompressedFingerprint(fpStr), duration };
}

function parseRawList(s) {
  const parts = s.split(',').map((x) => x.trim()).filter((x) => x.length);
  const out = new Int32Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i]) | 0;
  return out;
}

export function decodeCompressedFingerprint(b64) {
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length < 1) return new Int32Array(0);
  let pos = 1;
  const out = [];
  let last = 0;
  const readVarint = () => {
    let v = 0;
    let shift = 0;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v >>> 0;
  };
  while (pos < bytes.length) {
    const v = readVarint();
    void v;
    out.push(0);
    break;
  }
  pos = 1;
  out.length = 0;
  last = 0;
  while (pos < bytes.length) {
    let v = 0;
    let shift = 0;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
      if (shift > 35) break;
    }
    v >>>= 0;
    if (v & 1) {
      let ev = 0;
      let eshift = 0;
      while (pos < bytes.length) {
        const b = bytes[pos++];
        ev |= (b & 0x7f) << eshift;
        eshift += 7;
        if ((b & 0x80) === 0) break;
      }
      last = ev | 0;
      out.push(last);
    } else {
      const delta = v >> 1;
      const zig = (delta >> 1) ^ -(delta & 1);
      last = (last + zig) | 0;
      out.push(last);
    }
  }
  return Int32Array.from(out);
}

export function encodeRawToB64(raw) {
  const buf = Buffer.alloc(raw.length * 4);
  for (let i = 0; i < raw.length; i++) buf.writeInt32LE(raw[i] | 0, i * 4);
  return buf.toString('base64');
}

export function decodeB64ToRaw(b64) {
  const buf = Buffer.from(b64, 'base64');
  const out = new Int32Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt32LE(i * 4);
  return out;
}

/** Hamming distance between two raw fingerprints (for eval tooling). */
export function hamming32(a, b) {
  let x = (a ^ b) >>> 0;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Mean bit-error-rate of query vs target at a fixed offset (eval use). */
export function berAtOffset(query, target, offset = 0) {
  const n = Math.min(query.length, target.length - offset);
  if (n <= 0) return 1;
  let bits = 0;
  for (let i = 0; i < n; i++) bits += hamming32(query[i], target[offset + i]);
  return bits / (n * 32);
}
