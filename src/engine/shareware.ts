// Optional shareware download from the Internet Archive. The archive is a third-party host:
// the file is checked against a known MD5 before anything is used, and the game data is
// only read in the browser (it is never stored or re-hosted by this project).

export const SHAREWARE_URL = 'https://archive.org/download/Quake_802/quake106.zip';
export const SHAREWARE_MD5 = '8cee4d03ee092909fdb6a4f84f0c1357';

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

/** MD5 (RFC 1321) of a byte array, as lowercase hex. */
export function md5Hex(data: Uint8Array): string {
  const len = data.length;
  const n = Math.floor((len + 8) / 64) + 1;
  const size = n * 64;
  const buf = new Uint8Array(size);
  buf.set(data);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(size - 8, (len * 8) >>> 0, true);
  view.setUint32(size - 4, Math.floor((len * 8) / 2 ** 32), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Array<number>(16);
  for (let off = 0; off < size; off += 64) {
    for (let j = 0; j < 16; j++) M[j] = view.getUint32(off + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  let hex = '';
  for (const w of [a0, b0, c0, d0]) {
    for (let k = 0; k < 4; k++) hex += ((w >>> (k * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
}

/** Read id1/pak0.pak out of a zip archive (stored or deflate entries). */
export async function extractPak(zip: ArrayBuffer): Promise<ArrayBuffer> {
  const v = new DataView(zip);
  const u8 = new Uint8Array(zip);
  let eocd = -1;
  for (let i = v.byteLength - 22; i >= Math.max(0, v.byteLength - 22 - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not a zip archive.');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const names = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('The zip archive is damaged.');
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true);
    const clen = v.getUint16(p + 32, true);
    const loff = v.getUint32(p + 42, true);
    const name = names.decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!/(^|\/)id1\/pak0\.pak$/i.test(name)) continue;
    const start = loff + 30 + v.getUint16(loff + 26, true) + v.getUint16(loff + 28, true);
    const data = u8.subarray(start, start + csize);
    if (method === 0) return data.slice().buffer;
    if (method === 8) {
      const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).arrayBuffer();
    }
    throw new Error('Unsupported compression in the zip archive.');
  }
  throw new Error('id1/pak0.pak was not found in this archive.');
}

/** Download the shareware archive, check it, and return the pak0.pak bytes. */
export async function fetchShareware(): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(SHAREWARE_URL);
  } catch {
    throw new Error('Could not download the shareware from the Internet Archive (the browser may block it). Save quake106.zip yourself and drop it here.');
  }
  if (!res.ok) throw new Error(`The Internet Archive returned HTTP ${res.status}. Save quake106.zip yourself and drop it here.`);
  const zip = await res.arrayBuffer();
  if (md5Hex(new Uint8Array(zip)) !== SHAREWARE_MD5) {
    throw new Error('The downloaded file does not match the expected shareware archive (checksum mismatch).');
  }
  return extractPak(zip);
}
