// 10-character base62 ID —— only for temporary nodes **before being mounted into SiYuan**.
//
// On persist, node IDs are always assigned by SiYuan (22 characters); see `makeSiyuanId` in `core/map.ts`.
// This generator only serves the brief window where a node appears in the UI first and is written back to the kernel afterwards.
const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function genId(len = 10): string {
  let s = '';
  try {
    const buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    for (let i = 0; i < len; i++) s += ALPHABET[buf[i] % 62];
    return s;
  } catch {
    for (let i = 0; i < len; i++) {
      s += ALPHABET[Math.floor(Math.random() * 62)];
    }
    return s;
  }
}

export function now(): number {
  return Date.now();
}
