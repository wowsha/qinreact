// Alias model (.mdl, "IDPO" v6) loader.

export interface Pose {
  pos: Float32Array; // 3 floats per triangle corner (original winding)
  nrm: Float32Array; // 3 floats per triangle corner (smooth, outward)
}
export interface AliasFrame {
  name: string;
  poses: Pose[];
  endTimes: number[]; // cumulative interval end times (group frames); single pose => [0]
}
export interface AliasSkin {
  frames: Uint8Array[];
  endTimes: number[];
}

export interface AliasModel {
  name: string;
  scale: [number, number, number];
  translate: [number, number, number];
  skinW: number;
  skinH: number;
  skins: AliasSkin[];
  numCorners: number;
  uvs: Float32Array; // 2 per corner
  frames: AliasFrame[];
  flags: number;
  radius: number;
  mins: [number, number, number];
  maxs: [number, number, number];
}

export function parseMdl(buf: ArrayBuffer, name: string): AliasModel {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  if (dv.getInt32(0, true) !== 0x4f504449) throw new Error('bad mdl magic ' + name);
  if (dv.getInt32(4, true) !== 6) throw new Error('bad mdl version ' + name);
  const f = (o: number) => dv.getFloat32(o, true);
  const scale: [number, number, number] = [f(8), f(12), f(16)];
  const translate: [number, number, number] = [f(20), f(24), f(28)];
  const radius = f(32);
  const numskins = dv.getInt32(48, true);
  const skinW = dv.getInt32(52, true);
  const skinH = dv.getInt32(56, true);
  const numverts = dv.getInt32(60, true);
  const numtris = dv.getInt32(64, true);
  const numframes = dv.getInt32(68, true);
  const flags = dv.getInt32(76, true);
  let p = 84;
  const skins: AliasSkin[] = [];
  const ssz = skinW * skinH;
  for (let i = 0; i < numskins; i++) {
    const group = dv.getInt32(p, true);
    p += 4;
    if (group === 0) {
      skins.push({ frames: [u8.slice(p, p + ssz)], endTimes: [0] });
      p += ssz;
    } else {
      const n = dv.getInt32(p, true);
      p += 4;
      const times: number[] = [];
      for (let k = 0; k < n; k++) times.push(f(p + k * 4));
      p += n * 4;
      const fr: Uint8Array[] = [];
      for (let k = 0; k < n; k++) {
        fr.push(u8.slice(p, p + ssz));
        p += ssz;
      }
      skins.push({ frames: fr, endTimes: times });
    }
  }
  const onseam = new Uint8Array(numverts);
  const st = new Int32Array(numverts);
  const tt = new Int32Array(numverts);
  for (let i = 0; i < numverts; i++) {
    onseam[i] = dv.getInt32(p, true) ? 1 : 0;
    st[i] = dv.getInt32(p + 4, true);
    tt[i] = dv.getInt32(p + 8, true);
    p += 12;
  }
  const cornerVert = new Uint16Array(numtris * 3);
  const uvs = new Float32Array(numtris * 6);
  for (let i = 0; i < numtris; i++) {
    const front = dv.getInt32(p, true);
    for (let k = 0; k < 3; k++) {
      const vi = dv.getInt32(p + 4 + k * 4, true);
      cornerVert[i * 3 + k] = vi;
      let s = st[vi];
      if (onseam[vi] && !front) s += skinW / 2;
      uvs[(i * 3 + k) * 2] = (s + 0.5) / skinW;
      uvs[(i * 3 + k) * 2 + 1] = (tt[vi] + 0.5) / skinH;
    }
    p += 16;
  }
  const numCorners = numtris * 3;
  const mins: [number, number, number] = [1e9, 1e9, 1e9];
  const maxs: [number, number, number] = [-1e9, -1e9, -1e9];

  const readPose = (q: number): Pose => {
    const vx = new Float32Array(numverts * 3);
    for (let i = 0; i < numverts; i++) {
      for (let c = 0; c < 3; c++) {
        const v = u8[q + i * 4 + c] * scale[c] + translate[c];
        vx[i * 3 + c] = v;
        if (v < mins[c]) mins[c] = v;
        if (v > maxs[c]) maxs[c] = v;
      }
    }
    const pos = new Float32Array(numCorners * 3);
    for (let i = 0; i < numCorners; i++) {
      const v = cornerVert[i];
      pos[i * 3] = vx[v * 3];
      pos[i * 3 + 1] = vx[v * 3 + 1];
      pos[i * 3 + 2] = vx[v * 3 + 2];
    }
    // smooth normals per original vertex
    const acc = new Float32Array(numverts * 3);
    for (let t = 0; t < numtris; t++) {
      const a = cornerVert[t * 3], b = cornerVert[t * 3 + 1], c = cornerVert[t * 3 + 2];
      const e1x = vx[b * 3] - vx[a * 3], e1y = vx[b * 3 + 1] - vx[a * 3 + 1], e1z = vx[b * 3 + 2] - vx[a * 3 + 2];
      const e2x = vx[c * 3] - vx[a * 3], e2y = vx[c * 3 + 1] - vx[a * 3 + 1], e2z = vx[c * 3 + 2] - vx[a * 3 + 2];
      // clockwise winding => outward normal = e2 x e1
      const nx = e2y * e1z - e2z * e1y, ny = e2z * e1x - e2x * e1z, nz = e2x * e1y - e2y * e1x;
      for (const v of [a, b, c]) {
        acc[v * 3] += nx;
        acc[v * 3 + 1] += ny;
        acc[v * 3 + 2] += nz;
      }
    }
    const nrm = new Float32Array(numCorners * 3);
    for (let i = 0; i < numCorners; i++) {
      const v = cornerVert[i];
      let x = acc[v * 3], y = acc[v * 3 + 1], z = acc[v * 3 + 2];
      const l = Math.hypot(x, y, z) || 1;
      nrm[i * 3] = x / l;
      nrm[i * 3 + 1] = y / l;
      nrm[i * 3 + 2] = z / l;
    }
    return { pos, nrm };
  };
  const readName = (q: number) => {
    let s = '';
    for (let i = 0; i < 16 && u8[q + i] !== 0; i++) s += String.fromCharCode(u8[q + i]);
    return s;
  };
  const frames: AliasFrame[] = [];
  for (let i = 0; i < numframes; i++) {
    const type = dv.getInt32(p, true);
    p += 4;
    if (type === 0) {
      p += 8; // bbox min/max trivertx
      const nm = readName(p);
      p += 16;
      frames.push({ name: nm, poses: [readPose(p)], endTimes: [0] });
      p += numverts * 4;
    } else {
      const n = dv.getInt32(p, true);
      p += 4 + 8;
      const times: number[] = [];
      for (let k = 0; k < n; k++) times.push(f(p + k * 4));
      p += n * 4;
      const poses: Pose[] = [];
      let nm = '';
      for (let k = 0; k < n; k++) {
        p += 8;
        nm = readName(p);
        p += 16;
        poses.push(readPose(p));
        p += numverts * 4;
      }
      frames.push({ name: nm, poses, endTimes: times });
    }
  }
  return { name, scale, translate, skinW, skinH, skins, numCorners, uvs, frames, flags, radius, mins, maxs };
}
