// BSP (version 29) loader: geometry, textures, lighting, visibility, collision hulls, entity lump.

export const CONTENTS_EMPTY = -1;
export const CONTENTS_SOLID = -2;
export const CONTENTS_WATER = -3;
export const CONTENTS_SLIME = -4;
export const CONTENTS_LAVA = -5;
export const CONTENTS_SKY = -6;

export interface Hull {
  planeNormals: Float32Array; // 3 per plane
  planeDist: Float32Array;
  planeType: Uint8Array;
  planenum: Int32Array; // per clipnode
  children: Int32Array; // 2 per clipnode; >=0 node index, <0 contents
  firstclipnode: number;
  clipMins: [number, number, number];
  clipMaxs: [number, number, number];
}

export interface MipTex {
  name: string;
  width: number;
  height: number;
  mips: (Uint8Array | null)[]; // 4 levels, null if external
}

export interface TexInfo {
  s: [number, number, number, number];
  t: [number, number, number, number];
  miptex: number;
  flags: number;
}

export interface Face {
  planenum: number;
  side: number;
  firstedge: number;
  numedges: number;
  texinfo: number;
  styles: [number, number, number, number];
  lightofs: number;
  // derived
  texMinS: number;
  texMinT: number;
  extS: number;
  extT: number;
  lmW: number;
  lmH: number;
  special: 'none' | 'sky' | 'turb';
}

export interface BspModel {
  mins: [number, number, number];
  maxs: [number, number, number];
  origin: [number, number, number];
  headnode: [number, number, number, number];
  visleafs: number;
  firstface: number;
  numfaces: number;
  hulls: Hull[];
}

export interface Leaf {
  contents: number;
  visofs: number;
  firstmark: number;
  nummarks: number;
  ambient: [number, number, number, number];
}

export type EntDict = Record<string, string>;

export class Bsp {
  planeNormals!: Float32Array;
  planeDist!: Float32Array;
  planeType!: Uint8Array;
  vertices!: Float32Array;
  textures: (MipTex | null)[] = [];
  texinfo: TexInfo[] = [];
  faces: Face[] = [];
  edges!: Uint16Array;
  surfedges!: Int32Array;
  lighting: Uint8Array = new Uint8Array(0);
  visdata: Uint8Array = new Uint8Array(0);
  leafs: Leaf[] = [];
  marksurfaces!: Uint16Array;
  models: BspModel[] = [];
  // raw node tree for point->leaf lookups / light sampling
  nodePlane!: Int32Array;
  nodeChildren!: Int32Array; // raw: >=0 node, <0 => -1-leaf
  nodeFirstFace!: Uint16Array;
  nodeNumFaces!: Uint16Array;
  entities: EntDict[] = [];
  entityText = '';
  numVisLeafs = 0;

  constructor(buf: ArrayBuffer) {
    const dv = new DataView(buf);
    const version = dv.getInt32(0, true);
    if (version !== 29) throw new Error('Unsupported BSP version ' + version);
    const lump = (i: number) => ({ ofs: dv.getInt32(4 + i * 8, true), len: dv.getInt32(8 + i * 8, true) });
    const L = Array.from({ length: 15 }, (_, i) => lump(i));

    // entities
    {
      const u8 = new Uint8Array(buf, L[0].ofs, L[0].len);
      let s = '';
      for (let i = 0; i < u8.length && u8[i] !== 0; i++) s += String.fromCharCode(u8[i]);
      this.entityText = s;
      this.entities = parseEntityText(s);
    }
    // planes
    {
      const n = L[1].len / 20;
      this.planeNormals = new Float32Array(n * 3);
      this.planeDist = new Float32Array(n);
      this.planeType = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const o = L[1].ofs + i * 20;
        this.planeNormals[i * 3] = dv.getFloat32(o, true);
        this.planeNormals[i * 3 + 1] = dv.getFloat32(o + 4, true);
        this.planeNormals[i * 3 + 2] = dv.getFloat32(o + 8, true);
        this.planeDist[i] = dv.getFloat32(o + 12, true);
        this.planeType[i] = dv.getInt32(o + 16, true);
      }
    }
    // textures
    {
      const o = L[2].ofs;
      const n = dv.getInt32(o, true);
      for (let i = 0; i < n; i++) {
        const mo = dv.getInt32(o + 4 + i * 4, true);
        if (mo < 0) {
          this.textures.push(null);
          continue;
        }
        const b = o + mo;
        let name = '';
        for (let j = 0; j < 16 && dv.getUint8(b + j) !== 0; j++) name += String.fromCharCode(dv.getUint8(b + j));
        const width = dv.getUint32(b + 16, true);
        const height = dv.getUint32(b + 20, true);
        const mips: (Uint8Array | null)[] = [];
        for (let m = 0; m < 4; m++) {
          const off = dv.getUint32(b + 24 + m * 4, true);
          const sz = (width >> m) * (height >> m);
          mips.push(off ? new Uint8Array(buf, b + off, sz) : null);
        }
        this.textures.push({ name, width, height, mips });
      }
    }
    // vertices
    this.vertices = new Float32Array(L[3].len / 4);
    for (let i = 0; i < this.vertices.length; i++) this.vertices[i] = dv.getFloat32(L[3].ofs + i * 4, true);
    // vis, lighting
    this.visdata = new Uint8Array(buf.slice(L[4].ofs, L[4].ofs + L[4].len));
    this.lighting = new Uint8Array(buf.slice(L[8].ofs, L[8].ofs + L[8].len));
    // texinfo
    {
      const n = L[6].len / 40;
      for (let i = 0; i < n; i++) {
        const o = L[6].ofs + i * 40;
        const f = (k: number) => dv.getFloat32(o + k * 4, true);
        this.texinfo.push({ s: [f(0), f(1), f(2), f(3)], t: [f(4), f(5), f(6), f(7)], miptex: dv.getInt32(o + 32, true), flags: dv.getInt32(o + 36, true) });
      }
    }
    // edges, surfedges
    this.edges = new Uint16Array(L[12].len / 2);
    for (let i = 0; i < this.edges.length; i++) this.edges[i] = dv.getUint16(L[12].ofs + i * 2, true);
    this.surfedges = new Int32Array(L[13].len / 4);
    for (let i = 0; i < this.surfedges.length; i++) this.surfedges[i] = dv.getInt32(L[13].ofs + i * 4, true);
    // faces
    {
      const n = L[7].len / 20;
      for (let i = 0; i < n; i++) {
        const o = L[7].ofs + i * 20;
        const face: Face = {
          planenum: dv.getInt16(o, true),
          side: dv.getInt16(o + 2, true),
          firstedge: dv.getInt32(o + 4, true),
          numedges: dv.getInt16(o + 8, true),
          texinfo: dv.getInt16(o + 10, true),
          styles: [dv.getUint8(o + 12), dv.getUint8(o + 13), dv.getUint8(o + 14), dv.getUint8(o + 15)],
          lightofs: dv.getInt32(o + 16, true),
          texMinS: 0, texMinT: 0, extS: 0, extT: 0, lmW: 0, lmH: 0, special: 'none',
        };
        this.calcFaceExtents(face);
        this.faces.push(face);
      }
    }
    // leafs
    {
      const n = L[10].len / 28;
      for (let i = 0; i < n; i++) {
        const o = L[10].ofs + i * 28;
        this.leafs.push({
          contents: dv.getInt32(o, true),
          visofs: dv.getInt32(o + 4, true),
          firstmark: dv.getUint16(o + 20, true),
          nummarks: dv.getUint16(o + 22, true),
          ambient: [dv.getUint8(o + 24), dv.getUint8(o + 25), dv.getUint8(o + 26), dv.getUint8(o + 27)],
        });
      }
    }
    this.marksurfaces = new Uint16Array(L[11].len / 2);
    for (let i = 0; i < this.marksurfaces.length; i++) this.marksurfaces[i] = dv.getUint16(L[11].ofs + i * 2, true);
    // nodes (hull 0)
    const nn = L[5].len / 24;
    this.nodePlane = new Int32Array(nn);
    this.nodeChildren = new Int32Array(nn * 2);
    this.nodeFirstFace = new Uint16Array(nn);
    this.nodeNumFaces = new Uint16Array(nn);
    for (let i = 0; i < nn; i++) {
      const o = L[5].ofs + i * 24;
      this.nodePlane[i] = dv.getInt32(o, true);
      this.nodeChildren[i * 2] = dv.getInt16(o + 4, true);
      this.nodeChildren[i * 2 + 1] = dv.getInt16(o + 6, true);
      this.nodeFirstFace[i] = dv.getUint16(o + 20, true);
      this.nodeNumFaces[i] = dv.getUint16(o + 22, true);
    }
    // hull 0 as clipnode-style
    const h0children = new Int32Array(nn * 2);
    for (let i = 0; i < nn * 2; i++) {
      const c = this.nodeChildren[i];
      h0children[i] = c >= 0 ? c : this.leafs[-1 - c].contents;
    }
    // clipnodes
    const cn = L[9].len / 8;
    const cnPlane = new Int32Array(cn);
    const cnChildren = new Int32Array(cn * 2);
    for (let i = 0; i < cn; i++) {
      const o = L[9].ofs + i * 8;
      cnPlane[i] = dv.getInt32(o, true);
      cnChildren[i * 2] = dv.getInt16(o + 4, true);
      cnChildren[i * 2 + 1] = dv.getInt16(o + 6, true);
    }
    // models
    {
      const n = L[14].len / 64;
      for (let i = 0; i < n; i++) {
        const o = L[14].ofs + i * 64;
        const f = (k: number) => dv.getFloat32(o + k * 4, true);
        const headnode: [number, number, number, number] = [dv.getInt32(o + 36, true), dv.getInt32(o + 40, true), dv.getInt32(o + 44, true), dv.getInt32(o + 48, true)];
        const mk = (planenum: Int32Array, children: Int32Array, first: number, cm: [number, number, number], cx: [number, number, number]): Hull => ({
          planeNormals: this.planeNormals, planeDist: this.planeDist, planeType: this.planeType, planenum, children, firstclipnode: first, clipMins: cm, clipMaxs: cx,
        });
        this.models.push({
          mins: [f(0), f(1), f(2)], maxs: [f(3), f(4), f(5)], origin: [f(6), f(7), f(8)], headnode,
          visleafs: dv.getInt32(o + 52, true), firstface: dv.getInt32(o + 56, true), numfaces: dv.getInt32(o + 60, true),
          hulls: [
            mk(this.nodePlane, h0children, headnode[0], [0, 0, 0], [0, 0, 0]),
            mk(cnPlane, cnChildren, headnode[1], [-16, -16, -24], [16, 16, 32]),
            mk(cnPlane, cnChildren, headnode[2], [-32, -32, -24], [32, 32, 64]),
          ],
        });
      }
    }
    this.numVisLeafs = this.models[0].visleafs;
  }

  private calcFaceExtents(face: Face) {
    const ti = this.texinfo[face.texinfo];
    const tex = this.textures[ti.miptex];
    const nm = tex ? tex.name.toLowerCase() : '';
    face.special = nm.startsWith('sky') ? 'sky' : nm.startsWith('*') ? 'turb' : 'none';
    let minS = 1e9, minT = 1e9, maxS = -1e9, maxT = -1e9;
    for (let i = 0; i < face.numedges; i++) {
      const v = this.faceVertexIndex(face, i);
      const x = this.vertices[v * 3], y = this.vertices[v * 3 + 1], z = this.vertices[v * 3 + 2];
      const s = x * ti.s[0] + y * ti.s[1] + z * ti.s[2] + ti.s[3];
      const t = x * ti.t[0] + y * ti.t[1] + z * ti.t[2] + ti.t[3];
      if (s < minS) minS = s;
      if (s > maxS) maxS = s;
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    const bmS = Math.floor(minS / 16), bmT = Math.floor(minT / 16);
    const bxS = Math.ceil(maxS / 16), bxT = Math.ceil(maxT / 16);
    face.texMinS = bmS * 16;
    face.texMinT = bmT * 16;
    face.extS = (bxS - bmS) * 16;
    face.extT = (bxT - bmT) * 16;
    face.lmW = bxS - bmS + 1;
    face.lmH = bxT - bmT + 1;
  }

  faceVertexIndex(face: Face, i: number) {
    const se = this.surfedges[face.firstedge + i];
    return se >= 0 ? this.edges[se * 2] : this.edges[-se * 2 + 1];
  }

  leafForPoint(x: number, y: number, z: number, headnode = 0): number {
    let n = headnode;
    while (n >= 0) {
      const p = this.nodePlane[n];
      const t = this.planeType[p];
      const d = (t < 3 ? (t === 0 ? x : t === 1 ? y : z) : this.planeNormals[p * 3] * x + this.planeNormals[p * 3 + 1] * y + this.planeNormals[p * 3 + 2] * z) - this.planeDist[p];
      n = this.nodeChildren[n * 2 + (d < 0 ? 1 : 0)];
    }
    return -1 - n;
  }

  /** PVS for a leaf as a bit array over leaf indices (bit i => leaf i+1). */
  decompressVis(leaf: number): Uint8Array {
    const rowBytes = (this.numVisLeafs + 7) >> 3;
    const out = new Uint8Array(rowBytes);
    const vofs = this.leafs[leaf].visofs;
    if (leaf === 0 || vofs < 0 || this.visdata.length === 0) {
      out.fill(0xff);
      return out;
    }
    let ip = vofs, op = 0;
    while (op < rowBytes) {
      const b = this.visdata[ip++];
      if (b !== 0) {
        out[op++] = b;
        continue;
      }
      let c = this.visdata[ip++];
      while (c-- > 0 && op < rowBytes) out[op++] = 0;
    }
    return out;
  }

  /** Light level sampled below a point (0..~255). styleScale(style) returns 0..~2 multiplier. */
  lightPoint(sx: number, sy: number, sz: number, styleScale: (s: number) => number): number {
    const ex = sx, ey = sy, ez = sz - 2048;
    const r = this.recLight(0, sx, sy, sz, ex, ey, ez, styleScale);
    return r < 0 ? 0 : r;
  }
  private recLight(n: number, sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, sc: (s: number) => number): number {
    if (n < 0) return -1;
    const p = this.nodePlane[n];
    const nx = this.planeNormals[p * 3], ny = this.planeNormals[p * 3 + 1], nz = this.planeNormals[p * 3 + 2], pd = this.planeDist[p];
    const front = sx * nx + sy * ny + sz * nz - pd;
    const back = ex * nx + ey * ny + ez * nz - pd;
    const side = front < 0 ? 1 : 0;
    if (back < 0 === front < 0) return this.recLight(this.nodeChildren[n * 2 + side], sx, sy, sz, ex, ey, ez, sc);
    const frac = front / (front - back);
    const mx = sx + (ex - sx) * frac, my = sy + (ey - sy) * frac, mz = sz + (ez - sz) * frac;
    const r = this.recLight(this.nodeChildren[n * 2 + side], sx, sy, sz, mx, my, mz, sc);
    if (r >= 0) return r;
    const ff = this.nodeFirstFace[n];
    for (let i = 0; i < this.nodeNumFaces[n]; i++) {
      const face = this.faces[ff + i];
      if (face.special !== 'none') continue;
      const ti = this.texinfo[face.texinfo];
      const s = mx * ti.s[0] + my * ti.s[1] + mz * ti.s[2] + ti.s[3];
      const t = mx * ti.t[0] + my * ti.t[1] + mz * ti.t[2] + ti.t[3];
      if (s < face.texMinS || t < face.texMinT) continue;
      const ds = s - face.texMinS, dt = t - face.texMinT;
      if (ds > face.extS || dt > face.extT) continue;
      if (face.lightofs < 0) return 0;
      const lx = ds >> 4, ly = dt >> 4;
      let total = 0;
      for (let st = 0; st < 4 && face.styles[st] !== 255; st++) {
        const o = face.lightofs + st * face.lmW * face.lmH + ly * face.lmW + lx;
        total += this.lighting[o] * sc(face.styles[st]);
      }
      return total;
    }
    return this.recLight(this.nodeChildren[n * 2 + (side ^ 1)], mx, my, mz, ex, ey, ez, sc);
  }
}

export function parseEntityText(s: string): EntDict[] {
  const out: EntDict[] = [];
  const re = /"([^"]*)"|([{}])/g;
  let m: RegExpExecArray | null;
  let cur: EntDict | null = null;
  let key: string | null = null;
  while ((m = re.exec(s))) {
    if (m[2] === '{') {
      cur = {};
      key = null;
    } else if (m[2] === '}') {
      if (cur) out.push(cur);
      cur = null;
    } else if (cur) {
      if (key === null) key = m[1];
      else {
        cur[key] = m[1];
        key = null;
      }
    }
  }
  return out;
}
