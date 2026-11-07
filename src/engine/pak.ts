// PAK archive + WAD2 parsing. Pure data layer, no DOM dependencies.

export interface PakEntry {
  name: string;
  offset: number;
  length: number;
}

export class Pak {
  entries = new Map<string, PakEntry>();
  constructor(public buffer: ArrayBuffer) {
    const dv = new DataView(buffer);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'PACK') throw new Error('Not a PAK file (bad magic "' + magic + '")');
    const dirOfs = dv.getInt32(4, true);
    const dirLen = dv.getInt32(8, true);
    if (dirLen % 64 !== 0 || dirOfs < 12 || dirOfs + dirLen > buffer.byteLength) throw new Error('Corrupt PAK directory');
    const n = dirLen / 64;
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < n; i++) {
      const base = dirOfs + i * 64;
      let name = '';
      for (let j = 0; j < 56 && bytes[base + j] !== 0; j++) name += String.fromCharCode(bytes[base + j]);
      const offset = dv.getInt32(base + 56, true);
      const length = dv.getInt32(base + 60, true);
      this.entries.set(name.toLowerCase(), { name, offset, length });
    }
  }
  has(name: string) {
    return this.entries.has(name.toLowerCase());
  }
  /** Returns a view (no copy) of the file or null. */
  get(name: string): Uint8Array | null {
    const e = this.entries.get(name.toLowerCase());
    if (!e) return null;
    return new Uint8Array(this.buffer, e.offset, e.length);
  }
  /** Returns an aligned copy as ArrayBuffer so typed-array/DataView reads are safe. */
  getBuffer(name: string): ArrayBuffer | null {
    const v = this.get(name);
    if (!v) return null;
    return v.slice().buffer;
  }
  list(prefix = '') {
    const out: string[] = [];
    for (const k of this.entries.keys()) if (k.startsWith(prefix)) out.push(k);
    return out;
  }
}

export interface WadLump {
  name: string;
  type: number;
  data: Uint8Array;
}

export class Wad {
  lumps = new Map<string, WadLump>();
  constructor(data: Uint8Array) {
    const buf = data.slice().buffer;
    const dv = new DataView(buf);
    const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
    if (magic !== 'WAD2' && magic !== 'WAD3') throw new Error('bad WAD magic');
    const n = dv.getInt32(4, true);
    const tab = dv.getInt32(8, true);
    for (let i = 0; i < n; i++) {
      const b = tab + i * 32;
      const filepos = dv.getInt32(b, true);
      const size = dv.getInt32(b + 8, true);
      const type = dv.getUint8(b + 12);
      let name = '';
      for (let j = 0; j < 16 && data[b + 16 + j] !== 0; j++) name += String.fromCharCode(data[b + 16 + j]);
      this.lumps.set(name.toLowerCase(), { name, type, data: new Uint8Array(buf, filepos, size) });
    }
  }
  get(name: string) {
    return this.lumps.get(name.toLowerCase())?.data ?? null;
  }
}

/** An 8-bit paletted picture (qpic: width,height,data). Index 255 = transparent. */
export interface Pic {
  width: number;
  height: number;
  data: Uint8Array;
}

export function parsePic(d: Uint8Array): Pic {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const width = dv.getInt32(0, true);
  const height = dv.getInt32(4, true);
  return { width, height, data: d.subarray(8, 8 + width * height) };
}

export function picToRGBA(pic: Pic, palette: Uint8Array, transparent255 = true): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pic.width * pic.height * 4);
  for (let i = 0; i < pic.width * pic.height; i++) {
    const c = pic.data[i];
    out[i * 4] = palette[c * 3];
    out[i * 4 + 1] = palette[c * 3 + 1];
    out[i * 4 + 2] = palette[c * 3 + 2];
    out[i * 4 + 3] = transparent255 && c === 255 ? 0 : 255;
  }
  return out;
}
