import fs from 'node:fs';
import { Pak, Wad } from '../src/engine/pak';
import { Bsp } from '../src/engine/bsp';
import { parseMdl } from '../src/engine/mdl';
const buf = fs.readFileSync(process.argv[2]);
const pak = new Pak(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
const wad = new Wad(pak.get('gfx.wad')!);
console.log('wad:', [...wad.lumps.keys()].join(' '));
for (const m of ['start','e1m1','e1m2','e1m3','e1m4','e1m5','e1m6','e1m7','e1m8']) {
  const bsp = new Bsp(pak.getBuffer('maps/'+m+'.bsp')!);
  let good = 0, bad = 0, lumTotal = 0;
  for (let fi = 0; fi < bsp.models[0].numfaces; fi++) {
    const f = bsp.faces[fi];
    const v = (k: number) => { const i = bsp.faceVertexIndex(f, k); return [bsp.vertices[i*3], bsp.vertices[i*3+1], bsp.vertices[i*3+2]]; };
    const a = v(0), b = v(f.numedges - 1 > 1 ? 2 : 1), c = v(1);
    // triangle (0, k+1, k) with k=1 => (a, v2, v1)
    const p = [b[0]-a[0], b[1]-a[1], b[2]-a[2]], q = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
    const n = [p[1]*q[2]-p[2]*q[1], p[2]*q[0]-p[0]*q[2], p[0]*q[1]-p[1]*q[0]];
    const pn = [bsp.planeNormals[f.planenum*3], bsp.planeNormals[f.planenum*3+1], bsp.planeNormals[f.planenum*3+2]];
    const d = (n[0]*pn[0]+n[1]*pn[1]+n[2]*pn[2]) * (f.side ? -1 : 1);
    if (d > 0) good++; else if (d < 0) bad++;
    if (f.lightofs >= 0) lumTotal += (f.lmW+1)*(f.lmH+1);
  }
  console.log(m, 'faces CCW-correct', good, 'wrong', bad, 'lm texels', lumTotal, 'leafs', bsp.leafs.length, 'models', bsp.models.length);
}
for (const n of pak.list('progs/')) if (n.endsWith('.mdl')) {
  const m = parseMdl(pak.getBuffer(n)!, n);
  // signed volume using reversed winding (a,c,b)
  const p = m.frames[0].poses[0]; let vol = 0;
  for (let t = 0; t < m.numCorners/3; t++) {
    const A = [p.pos[t*9], p.pos[t*9+1], p.pos[t*9+2]], B = [p.pos[t*9+6], p.pos[t*9+7], p.pos[t*9+8]], C = [p.pos[t*9+3], p.pos[t*9+4], p.pos[t*9+5]];
    vol += A[0]*(B[1]*C[2]-B[2]*C[1]) - A[1]*(B[0]*C[2]-B[2]*C[0]) + A[2]*(B[0]*C[1]-B[1]*C[0]);
  }
  process.stdout.write(`${n.slice(6)}:${vol>0?'+':'-'}(f${m.frames.length},s${m.skins.length},fl${m.flags}) `);
}
console.log();
