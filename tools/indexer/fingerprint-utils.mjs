import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

let cachedVersion = null;

export async function fpcalcVersion(fpcalcBin = 'fpcalc') {
  if (cachedVersion) return cachedVersion;
  try {
    const { stdout, stderr } = await execFileAsync(fpcalcBin, ['-version'], { timeout: 15000 });
    cachedVersion = `${stdout ?? ''} ${stderr ?? ''}`.trim().split('\n')[0].slice(0, 120) || 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

export async function fpcalcFile(wavPath, { fpcalcBin = 'fpcalc', lengthSec = 120 } = {}) {
  try {
    const { stdout } = await execFileAsync(fpcalcBin, ['-json', '-raw', '-length', String(lengthSec), wavPath], { maxBuffer: 32 * 1024 * 1024 });
    const text = stdout.trim();
    const j = JSON.parse(text);
    const fpStr = String(j.fingerprint ?? '');
    if (!fpStr) throw new Error('empty fingerprint');
    return { raw: parseRawList(fpStr), duration: Number(j.duration ?? 0) };
  } catch (e) {
    throw new Error(`fpcalc failed on ${wavPath}: ${e?.message ?? e}`);
  }
}

function parseRawList(s) {
  const parts = s.split(',').map((x) => x.trim()).filter((x) => x.length);
  const out = new Int32Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i]) | 0;
  return out;
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

export function hamming32(a, b) {
  let x = (a ^ b) >>> 0;
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function berAtOffset(query, target, offset = 0) {
  const n = Math.min(query.length, target.length - offset);
  if (n <= 0) return 1;
  let bits = 0;
  for (let i = 0; i < n; i++) bits += hamming32(query[i], target[offset + i]);
  return bits / (n * 32);
}
