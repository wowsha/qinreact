// Three.js based renderer for BSP worlds, brush entities, alias models, particles and beams.
import * as THREE from 'three';
import { Bsp } from './bsp';
import { parseMdl, AliasModel } from './mdl';
import type { Assets } from './assets';
import type { Server, StaticEnt } from './server';
import { angleVectors } from './server';

const Q2T = new THREE.Matrix4().set(0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1);
export const toT = (v: number[]) => new THREE.Vector3(-v[1], v[2], -v[0]);

const WORLD_VS = /* glsl */ `
attribute vec2 lmuv;
varying vec2 vUv; varying vec2 vLm; varying vec3 vW;
void main(){ vUv = uv; vLm = lmuv; vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`;
const WORLD_FS = /* glsl */ `
precision highp float;
uniform sampler2D map; uniform sampler2D map2; uniform sampler2D lightmap;
uniform vec4 dl[8]; uniform float time; uniform float mode; uniform vec2 texSize;
varying vec2 vUv; varying vec2 vLm; varying vec3 vW;
void main(){
  if (mode > 1.5) {
    vec3 dir = vW - cameraPosition; dir.y *= 3.0; dir = normalize(dir) * 378.0;
    vec3 back = texture2D(map, (vec2(time*8.0) + dir.xz) / 128.0).rgb;
    vec4 fr = texture2D(map2, (vec2(time*16.0) + dir.xz) / 128.0);
    gl_FragColor = vec4(mix(back, fr.rgb, fr.a), 1.0);
    return;
  }
  vec2 uv = vUv;
  if (mode > 0.5) { uv += 0.125 * vec2(sin(uv.y*texSize.y*0.0491 + time), sin(uv.x*texSize.x*0.0491 + time)); vec4 t = texture2D(map, uv); gl_FragColor = vec4(t.rgb, 1.0); return; }
  vec4 t = texture2D(map, uv);
  float l = texture2D(lightmap, vLm).r;
  for (int i = 0; i < 8; i++) { float d = distance(vW, dl[i].xyz); l += max(dl[i].w - d, 0.0) / 255.0; }
  float lit = mix(min(l * 1.5, 1.0), 1.0, t.a);
  gl_FragColor = vec4(t.rgb * lit, 1.0);
}`;
const ALIAS_BLEND = 0.1; // seconds to blend between animation poses
// Stable per-entity animation phase (like Quake's syncbase), so grouped MDL animations
// of identical monsters do not play in lockstep.
const syncOffset = (e: number) => ((e * 0.6180339887) % 1) * 10;
const ALIAS_VS = /* glsl */ `
attribute vec3 pos2; attribute vec3 nrm2; uniform float mixT;
varying vec2 vUv; varying float vShade;
void main(){ vec3 P = mix(pos2, position, mixT); vec3 Nn = normalize(mix(nrm2, normal, mixT)); vec3 nw = normalize(mat3(modelMatrix)*Nn); vShade = 0.84 + 0.16*dot(nw, normalize(vec3(0.35,0.85,0.4))); vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(P,1.0); }`;
const ALIAS_FS = /* glsl */ `
precision highp float;
uniform sampler2D map; uniform float light; varying vec2 vUv; varying float vShade;
void main(){ vec4 t = texture2D(map, vUv); float l = clamp(light*vShade, 0.0, 1.0); gl_FragColor = vec4(t.rgb*mix(l, 1.0, t.a), 1.0); }`;
const PART_VS = /* glsl */ `
attribute vec3 color; attribute float size; varying vec3 vC; uniform float scale;
void main(){ vC = color; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = max(2.0, size*scale/max(-mv.z,1.0)); gl_Position = projectionMatrix*mv; }`;
const PART_FS = /* glsl */ `precision highp float; varying vec3 vC; void main(){ gl_FragColor = vec4(vC,1.0); }`;

export interface Particle {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  color: number; die: number; grav: number; born: number;
  ramp?: number[]; rate?: number; size?: number;
}
export interface Beam { a: number[]; b: number[]; die: number }
export interface DLight { org: number[]; radius: number }

interface TexSet { prim: THREE.DataTexture[]; alt: THREE.DataTexture[] }

class AliasVis {
  mesh: THREE.Mesh;
  geom: THREE.BufferGeometry;
  pos: THREE.BufferAttribute;
  nrm: THREE.BufferAttribute;
  lastPose: unknown = null;
  pos2: THREE.BufferAttribute;
  nrm2: THREE.BufferAttribute;
  blend0 = -1e9;
  lastSkin = -1;
  mat: THREE.ShaderMaterial;
  constructor(public model: AliasModel, skins: THREE.DataTexture[]) {
    const n = model.numCorners;
    this.geom = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.nrm = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.nrm.setUsage(THREE.DynamicDrawUsage);
    const uv = new Float32Array(n * 2);
    for (let t = 0; t < n / 3; t++)
      for (let k = 0; k < 3; k++) {
        const s = t * 3 + (k === 0 ? 0 : k === 1 ? 2 : 1);
        uv[(t * 3 + k) * 2] = model.uvs[s * 2];
        uv[(t * 3 + k) * 2 + 1] = model.uvs[s * 2 + 1];
      }
    this.pos2 = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.nrm2 = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.pos2.setUsage(THREE.DynamicDrawUsage);
    this.nrm2.setUsage(THREE.DynamicDrawUsage);
    this.geom.setAttribute('position', this.pos);
    this.geom.setAttribute('normal', this.nrm);
    this.geom.setAttribute('pos2', this.pos2);
    this.geom.setAttribute('nrm2', this.nrm2);
    this.geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: skins[0] }, light: { value: 1 }, mixT: { value: 1 } },
      vertexShader: ALIAS_VS, fragmentShader: ALIAS_FS, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geom, this.mat);
    this.mesh.frustumCulled = false;
  }
  setPose(frame: number, time: number, skins: THREE.DataTexture[], skin: number, skinTime: number) {
    const m = this.model;
    const fr = m.frames[frame] ?? m.frames[0];
    let pi = 0;
    if (fr.poses.length > 1) {
      const total = fr.endTimes[fr.endTimes.length - 1] || 1;
      const t = time % total;
      while (pi < fr.endTimes.length - 1 && t >= fr.endTimes[pi]) pi++;
    }
    const pose = fr.poses[pi];
    if (pose !== this.lastPose) {
      // Blend from the pose on screen to the new one over ALIAS_BLEND seconds.
      const first = this.lastPose === null;
      if (!first) {
        // Start the new blend from what is on screen right now (possibly mid-blend),
        // so an interrupted transition does not snap.
        const m = this.mat.uniforms.mixT.value as number;
        const p2 = this.pos2.array as Float32Array, n2 = this.nrm2.array as Float32Array;
        const p1 = this.pos.array as Float32Array, n1 = this.nrm.array as Float32Array;
        for (let i = 0; i < p2.length; i++) p2[i] += (p1[i] - p2[i]) * m;
        for (let i = 0; i < n2.length; i++) n2[i] += (n1[i] - n2[i]) * m;
        this.blend0 = time;
      }
      this.lastPose = pose;
      const p = this.pos.array as Float32Array, nn = this.nrm.array as Float32Array;
      const tris = m.numCorners / 3;
      for (let t = 0; t < tris; t++) {
        for (let k = 0; k < 3; k++) {
          const d = (t * 3 + k) * 3;
          const s = (t * 3 + (k === 0 ? 0 : k === 1 ? 2 : 1)) * 3;
          p[d] = pose.pos[s]; p[d + 1] = pose.pos[s + 1]; p[d + 2] = pose.pos[s + 2];
          nn[d] = pose.nrm[s]; nn[d + 1] = pose.nrm[s + 1]; nn[d + 2] = pose.nrm[s + 2];
        }
      }
      this.pos.needsUpdate = true;
      this.nrm.needsUpdate = true;
      if (first) {
        (this.pos2.array as Float32Array).set(this.pos.array as Float32Array);
        (this.nrm2.array as Float32Array).set(this.nrm.array as Float32Array);
      }
      this.pos2.needsUpdate = true;
      this.nrm2.needsUpdate = true;
    }
    this.mat.uniforms.mixT.value = Math.min(1, Math.max(0, (time - this.blend0) / ALIAS_BLEND));
    const sk = m.skins[skin] ?? m.skins[0];
    let si = 0;
    if (sk && sk.frames.length > 1) {
      const total = sk.endTimes[sk.endTimes.length - 1] || 1;
      const t = skinTime % total;
      while (si < sk.endTimes.length - 1 && t >= sk.endTimes[si]) si++;
    }
    const key = (Math.min(skin, m.skins.length - 1)) * 64 + si;
    if (key !== this.lastSkin) {
      this.lastSkin = key;
      this.mat.uniforms.map.value = skins[this.skinIndex(skin, si, skins)];
    }
  }
  private skinIndex(skin: number, si: number, skins: THREE.DataTexture[]) {
    let idx = 0;
    const m = this.model;
    const s = Math.min(skin, m.skins.length - 1);
    for (let i = 0; i < s; i++) idx += m.skins[i].frames.length;
    return Math.min(idx + si, skins.length - 1);
  }
}

interface ModelGroup {
  group: THREE.Group;
  mats: { mat: THREE.ShaderMaterial; tex: number }[];
}

export class GameRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  viewScene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(73.74, 4 / 3, 1, 8000);
  root = new THREE.Group();
  viewRoot = new THREE.Group();
  bsp: Bsp | null = null;
  models: ModelGroup[] = [];
  brushGroups = new Map<string, ModelGroup>();
  texCache = new Map<number, THREE.DataTexture>();
  texSets = new Map<number, TexSet>();
  skyTex: [THREE.DataTexture, THREE.DataTexture] | null = null;
  lmTex: THREE.DataTexture | null = null;
  lmData: Uint8Array = new Uint8Array(4);
  lmW = 1024;
  lmH = 4;
  faceRect: Int32Array = new Int32Array(0);
  animFaces: number[] = [];
  scales = new Float32Array(64).fill(256);
  styleStr: string[] = new Array(64).fill('');
  lastStyleTick = -1;
  dlU = { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 0, 0)) };
  timeU = { value: 0 };
  lmU = { value: null as THREE.DataTexture | null };
  aliasCache = new Map<string, { model: AliasModel; skins: THREE.DataTexture[] } | null>();
  entVis = new Map<number, AliasVis & { name: string }>();
  staticVis: (AliasVis & { name: string; st: StaticEnt })[] = [];
  weaponVis: (AliasVis & { name: string }) | null = null;
  particles: Particle[] = [];
  partGeom: THREE.BufferGeometry;
  partPoints: THREE.Points;
  beamGeom: THREE.BufferGeometry;
  beamLines: THREE.LineSegments;
  beams: Beam[] = [];
  width = 640;
  height = 480;
  missingTex: THREE.DataTexture;

  constructor(public canvas: HTMLCanvasElement, public assets: Assets) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 1);
    this.root.matrixAutoUpdate = false;
    this.root.matrix.copy(Q2T);
    this.root.matrixWorldNeedsUpdate = true;
    this.viewRoot.matrixAutoUpdate = false;
    this.viewRoot.matrix.copy(Q2T);
    this.viewRoot.matrixWorldNeedsUpdate = true;
    this.scene.add(this.root);
    this.viewScene.add(this.viewRoot);
    this.camera.matrixAutoUpdate = true;
    this.missingTex = this.makeTex(new Uint8Array([90, 90, 90, 0, 40, 40, 40, 0, 40, 40, 40, 0, 90, 90, 90, 0]), 2, 2);
    // particles
    const MAXP = 4096;
    this.partGeom = new THREE.BufferGeometry();
    this.partGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXP * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.partGeom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAXP * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.partGeom.setAttribute('size', new THREE.BufferAttribute(new Float32Array(MAXP), 1).setUsage(THREE.DynamicDrawUsage));
    this.partGeom.setDrawRange(0, 0);
    this.partPoints = new THREE.Points(this.partGeom, new THREE.ShaderMaterial({ vertexShader: PART_VS, fragmentShader: PART_FS, uniforms: { scale: { value: 500 } } }));
    this.partPoints.frustumCulled = false;
    this.root.add(this.partPoints);
    this.beamGeom = new THREE.BufferGeometry();
    this.beamGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 8 * 6), 3).setUsage(THREE.DynamicDrawUsage));
    this.beamGeom.setDrawRange(0, 0);
    this.beamLines = new THREE.LineSegments(this.beamGeom, new THREE.LineBasicMaterial({ color: 0xb8c8ff }));
    this.beamLines.frustumCulled = false;
    this.root.add(this.beamLines);
  }

  setSize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // horizontal FOV 90 at 4:3 => vertical 73.74, kept constant (Hor+)
    this.camera.fov = 73.74;
    this.camera.updateProjectionMatrix();
    (this.partPoints.material as THREE.ShaderMaterial).uniforms.scale.value = (h * 0.5) / Math.tan((73.74 * Math.PI) / 360) * 1.6;
  }

  makeTex(rgba: Uint8Array, w: number, h: number, mip = true) {
    const t = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = mip ? THREE.NearestMipmapLinearFilter : THREE.NearestFilter;
    t.generateMipmaps = mip;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  }
  paletteToRGBA(data: Uint8Array, w: number, h: number, transparent0 = false): Uint8Array {
    const pal = this.assets.palette;
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const c = data[i];
      out[i * 4] = pal[c * 3];
      out[i * 4 + 1] = pal[c * 3 + 1];
      out[i * 4 + 2] = pal[c * 3 + 2];
      out[i * 4 + 3] = transparent0 ? (c === 0 ? 0 : 255) : c >= 224 ? 255 : 0;
    }
    return out;
  }

  // ---------------- level ----------------
  private disposeGroup(g: { group: THREE.Group; mats: { mat: THREE.ShaderMaterial }[] }) {
    this.root.remove(g.group);
    g.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const m of g.mats) m.mat.dispose();
  }

  clearLevel() {
    for (const m of this.models) this.disposeGroup(m);
    this.models = [];
    for (const g of this.brushGroups.values()) this.disposeGroup(g);
    this.brushGroups.clear();
    for (const v of this.entVis.values()) this.root.remove(v.mesh);
    this.entVis.clear();
    for (const v of this.staticVis) this.root.remove(v.mesh);
    this.staticVis = [];
    this.particles.length = 0;
    this.beams.length = 0;
    this.texCache.forEach((t) => t.dispose());
    this.texCache.clear();
    this.texSets.clear();
    this.lmTex?.dispose();
    this.lmTex = null;
  }

  loadLevel(sv: Server) {
    this.clearLevel();
    const bsp = (this.bsp = sv.bsp);
    this.scales.fill(256);
    this.styleStr.fill('');
    this.lastStyleTick = -1;
    this.buildLightmaps(bsp);
    this.buildSky(bsp);
    this.buildTexSets(bsp);
    for (let mi = 0; mi < bsp.models.length; mi++) this.models.push(this.buildModel(bsp, mi));
    for (let i = 0; i < this.models.length; i++) {
      this.models[i].group.visible = i === 0;
      this.root.add(this.models[i].group);
    }
    for (let i = 0; i < 64; i++) if (sv.lightstyles[i]) this.styleStr[i] = sv.lightstyles[i];
    this.updateStyles(0, true);
  }

  setLightstyle(i: number, s: string) {
    this.styleStr[i] = s;
    this.lastStyleTick = -1;
  }

  private buildLightmaps(bsp: Bsp) {
    const W = 1024;
    const rect = new Int32Array(bsp.faces.length * 2).fill(-1);
    let x = 2, y = 0, rowH = 1;
    for (let i = 0; i < bsp.faces.length; i++) {
      const f = bsp.faces[i];
      if (f.special !== 'none' || f.lightofs < 0) continue;
      const w = f.lmW + 1, h = f.lmH + 1;
      if (x + w > W) {
        x = 0;
        y += rowH;
        rowH = 0;
      }
      rect[i * 2] = x;
      rect[i * 2 + 1] = y;
      x += w;
      if (h > rowH) rowH = h;
    }
    let H = y + rowH + 1;
    H = Math.max(4, (H + 3) & ~3);
    this.lmW = W;
    this.lmH = H;
    this.faceRect = rect;
    this.lmData = new Uint8Array(W * H);
    this.animFaces = [];
    for (let i = 0; i < bsp.faces.length; i++) {
      if (rect[i * 2] < 0) continue;
      const f = bsp.faces[i];
      if (f.styles[0] !== 0 || f.styles[1] !== 255) this.animFaces.push(i);
      this.writeFaceLight(bsp, i);
    }
    const t = new THREE.DataTexture(this.lmData, W, H, THREE.RedFormat, THREE.UnsignedByteType);
    t.magFilter = t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
    this.lmTex = t;
    this.lmU.value = t;
  }

  private writeFaceLight(bsp: Bsp, fi: number) {
    const f = bsp.faces[fi];
    const rx = this.faceRect[fi * 2], ry = this.faceRect[fi * 2 + 1];
    const n = f.lmW * f.lmH;
    const W = this.lmW;
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let s = 0; s < 4; s++) {
        const st = f.styles[s];
        if (st === 255) break;
        sum += bsp.lighting[f.lightofs + s * n + j] * this.scales[st];
      }
      const v = sum / 256;
      const lx = j % f.lmW, ly = (j / f.lmW) | 0;
      this.lmData[(ry + ly) * W + rx + lx] = v > 255 ? 255 : v;
    }
  }

  updateStyles(time: number, force = false) {
    const tick = Math.floor(time * 10);
    if (tick === this.lastStyleTick && !force) return;
    this.lastStyleTick = tick;
    const changed = new Set<number>();
    for (let i = 0; i < 64; i++) {
      const s = this.styleStr[i];
      const ns = s.length ? (s.charCodeAt(tick % s.length) - 97) * 22 : 256;
      if (ns !== this.scales[i]) {
        this.scales[i] = ns;
        changed.add(i);
      }
    }
    if (!this.bsp || !this.lmTex || (!changed.size && !force)) return;
    for (const fi of this.animFaces) {
      const f = this.bsp.faces[fi];
      let hit = force;
      for (let s = 0; s < 4 && f.styles[s] !== 255 && !hit; s++) if (changed.has(f.styles[s])) hit = true;
      if (hit) this.writeFaceLight(this.bsp, fi);
    }
    this.lmTex.needsUpdate = true;
  }

  styleScale = (s: number) => this.scales[s] / 256;

  private buildSky(bsp: Bsp) {
    this.skyTex = null;
    for (const t of bsp.textures) {
      if (t && t.name.toLowerCase().startsWith('sky') && t.mips[0] && t.width === 256 && t.height === 128) {
        const pal = this.assets.palette;
        const back = new Uint8Array(128 * 128 * 4), front = new Uint8Array(128 * 128 * 4);
        for (let y = 0; y < 128; y++)
          for (let x = 0; x < 128; x++) {
            const cb = t.mips[0][y * 256 + 128 + x];
            const cf = t.mips[0][y * 256 + x];
            const o = (y * 128 + x) * 4;
            back[o] = pal[cb * 3]; back[o + 1] = pal[cb * 3 + 1]; back[o + 2] = pal[cb * 3 + 2]; back[o + 3] = 255;
            front[o] = pal[cf * 3]; front[o + 1] = pal[cf * 3 + 1]; front[o + 2] = pal[cf * 3 + 2]; front[o + 3] = cf === 0 ? 0 : 255;
          }
        this.skyTex = [this.makeTex(back, 128, 128, false), this.makeTex(front, 128, 128, false)];
        break;
      }
    }
  }

  private extraTex = new WeakMap<Bsp, Map<number, THREE.DataTexture>>();
  private texture(bsp: Bsp, idx: number): THREE.DataTexture {
    // world textures and item-BSP textures share indexes, so cache per BSP file
    let cache = this.texCache;
    if (bsp !== this.bsp) {
      let m = this.extraTex.get(bsp);
      if (!m) { m = new Map(); this.extraTex.set(bsp, m); }
      cache = m;
    }
    let t = cache.get(idx);
    if (t) return t;
    const mt = bsp.textures[idx];
    if (!mt || !mt.mips[0]) return this.missingTex;
    t = this.makeTex(this.paletteToRGBA(mt.mips[0], mt.width, mt.height), mt.width, mt.height);
    cache.set(idx, t);
    return t;
  }

  private buildTexSets(bsp: Bsp) {
    this.texSets.clear();
    const byBase = new Map<string, { prim: [number, number][]; alt: [number, number][] }>();
    bsp.textures.forEach((t, i) => {
      if (!t || t.name[0] !== '+') return;
      const c = t.name[1].toLowerCase();
      const base = t.name.slice(2).toLowerCase();
      let e = byBase.get(base);
      if (!e) byBase.set(base, (e = { prim: [], alt: [] }));
      if (c >= '0' && c <= '9') e.prim.push([c.charCodeAt(0) - 48, i]);
      else e.alt.push([c.charCodeAt(0) - 97, i]);
    });
    bsp.textures.forEach((t, i) => {
      if (!t || t.name[0] !== '+') return;
      const e = byBase.get(t.name.slice(2).toLowerCase())!;
      const c = t.name[1].toLowerCase();
      const isPrim = c >= '0' && c <= '9';
      const sortf = (a: [number, number], b: [number, number]) => a[0] - b[0];
      const prim = e.prim.slice().sort(sortf).map((p) => this.texture(bsp, p[1]));
      const alt = e.alt.slice().sort(sortf).map((p) => this.texture(bsp, p[1]));
      this.texSets.set(i, isPrim ? { prim, alt: alt.length ? alt : prim } : { prim: alt, alt: prim.length ? prim : alt });
    });
  }

  private buildModel(bsp: Bsp, mi: number): ModelGroup {
    const m = bsp.models[mi];
    const group = new THREE.Group();
    const buckets = new Map<number, { pos: number[]; uv: number[]; lm: number[]; idx: number[] }>();
    const W = this.lmW, H = this.lmH;
    // Separate BSPs (pickup models) have their own face numbering, so the world's
    // face rectangles and atlas do not apply to them. They render fully lit instead.
    const ownBsp = bsp !== this.bsp;
    const lmTex = ownBsp ? { value: this.whiteLightmap() } : this.lmU;
    for (let fi = m.firstface; fi < m.firstface + m.numfaces; fi++) {
      const f = bsp.faces[fi];
      const ti = bsp.texinfo[f.texinfo];
      const tex = bsp.textures[ti.miptex];
      if (tex && tex.name.toLowerCase() === 'clip') continue;
      let b = buckets.get(ti.miptex);
      if (!b) buckets.set(ti.miptex, (b = { pos: [], uv: [], lm: [], idx: [] }));
      const tw = tex ? tex.width : 64, th = tex ? tex.height : 64;
      const base = b.pos.length / 3;
      const rx = ownBsp ? -1 : this.faceRect[fi * 2], ry = ownBsp ? -1 : this.faceRect[fi * 2 + 1];
      for (let k = 0; k < f.numedges; k++) {
        const v = bsp.faceVertexIndex(f, k);
        const x = bsp.vertices[v * 3], y = bsp.vertices[v * 3 + 1], z = bsp.vertices[v * 3 + 2];
        b.pos.push(x, y, z);
        const s = x * ti.s[0] + y * ti.s[1] + z * ti.s[2] + ti.s[3];
        const t = x * ti.t[0] + y * ti.t[1] + z * ti.t[2] + ti.t[3];
        b.uv.push(s / tw, t / th);
        if (rx >= 0) b.lm.push((rx + (s - f.texMinS) / 16 + 0.5) / W, (ry + (t - f.texMinT) / 16 + 0.5) / H);
        else b.lm.push(0.5 / W, 0.5 / H);
      }
      for (let k = 1; k < f.numedges - 1; k++) b.idx.push(base, base + k + 1, base + k);
    }
    const mats: ModelGroup['mats'] = [];
    for (const [texIdx, b] of buckets) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setAttribute('lmuv', new THREE.Float32BufferAttribute(b.lm, 2));
      g.setIndex(b.idx);
      const tex = bsp.textures[texIdx];
      const name = tex ? tex.name.toLowerCase() : '';
      const mode = name.startsWith('sky') ? 2 : name.startsWith('*') ? 1 : 0;
      const mat = new THREE.ShaderMaterial({
        vertexShader: WORLD_VS, fragmentShader: WORLD_FS,
        uniforms: {
          map: { value: mode === 2 && this.skyTex ? this.skyTex[0] : this.texture(bsp, texIdx) },
          map2: { value: this.skyTex ? this.skyTex[1] : this.missingTex },
          lightmap: lmTex, dl: this.dlU, time: this.timeU, mode: { value: mode },
          texSize: { value: new THREE.Vector2(tex?.width ?? 64, tex?.height ?? 64) },
        },
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      group.add(mesh);
      mats.push({ mat, tex: texIdx });
    }
    return { group, mats };
  }

  private whiteLm: THREE.DataTexture | null = null;
  private whiteLightmap(): THREE.DataTexture {
    if (!this.whiteLm) {
      this.whiteLm = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      this.whiteLm.needsUpdate = true;
    }
    return this.whiteLm;
  }

  // ---------------- alias models ----------------
  getAlias(name: string) {
    let a = this.aliasCache.get(name);
    if (a !== undefined) return a;
    a = null;
    const buf = this.assets.pak.getBuffer(name);
    if (buf) {
      try {
        const model = parseMdl(buf, name);
        const skins: THREE.DataTexture[] = [];
        for (const sk of model.skins) for (const fr of sk.frames) skins.push(this.makeTex(this.paletteToRGBA(fr, model.skinW, model.skinH), model.skinW, model.skinH, true));
        if (!skins.length) skins.push(this.missingTex);
        a = { model, skins };
      } catch (e) {
        console.error('mdl', name, e);
      }
    }
    this.aliasCache.set(name, a);
    return a;
  }
  modelFlags(name: string) {
    return name.endsWith('.mdl') ? this.getAlias(name)?.model.flags ?? 0 : 0;
  }

  private makeVis(name: string): (AliasVis & { name: string }) | null {
    const a = this.getAlias(name);
    if (!a) return null;
    const v = new AliasVis(a.model, a.skins) as AliasVis & { name: string };
    v.name = name;
    return v;
  }

  addStatic(st: StaticEnt) {
    const v = this.makeVis(st.model) as (AliasVis & { name: string; st: StaticEnt }) | null;
    if (!v) return;
    v.st = st;
    v.mesh.position.set(st.origin[0], st.origin[1], st.origin[2]);
    this.setRot(v.mesh, st.angles);
    this.root.add(v.mesh);
    this.staticVis.push(v);
  }

  private setRot(o: THREE.Object3D, a: number[]) {
    const d = Math.PI / 180;
    o.rotation.set(a[2] * d, -a[0] * d, a[1] * d, 'ZYX');
  }

  // ---------------- particles / beams ----------------
  private updateParticles(time: number, dt: number) {
    const pal = this.assets.palette;
    const pos = this.partGeom.getAttribute('position') as THREE.BufferAttribute;
    const col = this.partGeom.getAttribute('color') as THREE.BufferAttribute;
    const siz = this.partGeom.getAttribute('size') as THREE.BufferAttribute;
    let n = 0;
    const alive: Particle[] = [];
    for (const p of this.particles) {
      if (time > p.die) continue;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vz -= p.grav * dt;
      alive.push(p);
      if (n >= 4096) continue;
      let c = p.color;
      if (p.ramp) c = p.ramp[Math.min(p.ramp.length - 1, Math.floor((time - p.born) * (p.rate ?? 10)))];
      pos.setXYZ(n, p.x, p.y, p.z);
      col.setXYZ(n, pal[c * 3] / 255, pal[c * 3 + 1] / 255, pal[c * 3 + 2] / 255);
      siz.setX(n, p.size ?? 1.2);
      n++;
    }
    this.particles = alive;
    this.partGeom.setDrawRange(0, n);
    pos.needsUpdate = col.needsUpdate = siz.needsUpdate = true;
  }

  private updateBeams(time: number) {
    const attr = this.beamGeom.getAttribute('position') as THREE.BufferAttribute;
    let n = 0;
    this.beams = this.beams.filter((b) => b.die > time);
    for (const b of this.beams.slice(0, 60)) {
      const segs = 7;
      let prev = b.a;
      for (let i = 1; i <= segs; i++) {
        const f = i / segs;
        const j = i === segs ? 0 : 6;
        const cur = [b.a[0] + (b.b[0] - b.a[0]) * f + (Math.random() - 0.5) * j, b.a[1] + (b.b[1] - b.a[1]) * f + (Math.random() - 0.5) * j, b.a[2] + (b.b[2] - b.a[2]) * f + (Math.random() - 0.5) * j];
        attr.setXYZ(n++, prev[0], prev[1], prev[2]);
        attr.setXYZ(n++, cur[0], cur[1], cur[2]);
        prev = cur;
      }
    }
    this.beamGeom.setDrawRange(0, n);
    attr.needsUpdate = true;
  }

  /** Light at a point (0..1) from lightmaps plus dynamic lights. */
  lightAt(org: number[], dlights: DLight[]) {
    let l = this.bsp ? this.bsp.lightPoint(org[0], org[1], org[2] + 4, this.styleScale) : 128;
    for (const d of dlights) {
      const dist = Math.hypot(d.org[0] - org[0], d.org[1] - org[1], d.org[2] - org[2]);
      if (dist < d.radius) l += d.radius - dist;
    }
    return Math.max(l, 20) / 255;
  }

  // ---------------- frame ----------------
  render(sv: Server, p: {
    origin: number[]; angles: number[]; time: number; dt: number; dlights: DLight[];
    weapon: { model: string; frame: number; origin: number[]; angles: number[] } | null; drawWorld: boolean; hideEntities: boolean;
  }) {
    const { time } = p;
    this.timeU.value = time;
    this.updateStyles(time);
    for (let i = 0; i < 8; i++) {
      const u = this.dlU.value[i];
      const d = p.dlights[i];
      if (d) {
        const t = toT(d.org);
        u.set(t.x, t.y, t.z, d.radius);
      } else u.set(0, 0, 0, 0);
    }
    // camera
    const av = angleVectors(p.angles);
    const f = toT(av.forward), r = toT(av.right), u = toT(av.up);
    const m = new THREE.Matrix4().makeBasis(r, u, f.clone().negate());
    this.camera.quaternion.setFromRotationMatrix(m);
    this.camera.position.copy(toT(p.origin));
    this.camera.updateMatrixWorld(true);

    // texture animation
    const frameIdx = Math.floor(time * 10);
    const ents = new Map<number, number>(); // submodel -> entity frame
    const seen = new Set<number>();
    const seenBrush = new Set<string>();
    const hasSub = new Set<number>();
    if (!p.hideEntities) {
      for (let e = 1; e < sv.numEdicts; e++) {
        if (sv.free[e]) continue;
        if (!sv.vm.str(sv.iget(e, 'model'))) continue; // model cleared by QC (e.g. picked-up armor)
        const mi = sv.fget(e, 'modelindex') | 0;
        if (!mi) continue;
        const name = sv.models[mi];
        if (!name) continue;
        const origin = sv.lerpOrigin(e), angles = sv.lerpAngles(e);
        if (name[0] === '*') {
          const n = parseInt(name.slice(1));
          const mg = this.models[n];
          if (!mg) continue;
          mg.group.visible = true;
          mg.group.position.set(origin[0], origin[1], origin[2]);
          this.setRot(mg.group, angles);
          hasSub.add(n);
          ents.set(n, sv.fget(e, 'frame'));
        } else if (name.endsWith('.bsp')) {
          const bf = sv.getBspFile(name);
          if (!bf) continue;
          let bg = this.brushGroups.get(name);
          if (!bg) {
            bg = this.buildModel(bf, 0);
            this.brushGroups.set(name, bg);
            this.root.add(bg.group);
          }
          bg.group.visible = true;
          bg.group.position.set(origin[0], origin[1], origin[2]);
          this.setRot(bg.group, angles);
          seenBrush.add(name);
        } else if (e !== 1 && name.endsWith('.mdl')) {
          let v = this.entVis.get(e);
          if (v && v.name !== name) {
            this.root.remove(v.mesh);
            this.entVis.delete(e);
            v = undefined;
          }
          if (!v) {
            const nv = this.makeVis(name);
            if (!nv) continue;
            v = nv;
            this.entVis.set(e, v);
            this.root.add(v.mesh);
          }
          seen.add(e);
          v.mesh.visible = true;
          const ang = angles.slice();
          if (v.model.flags & 8) ang[1] = (100 * time) % 360;
          v.mesh.position.set(origin[0], origin[1], origin[2]);
          this.setRot(v.mesh, ang);
          const a = this.getAlias(name)!;
          v.setPose(sv.fget(e, 'frame') | 0, time + syncOffset(e), a.skins, sv.fget(e, 'skin') | 0, time);
          v.mat.uniforms.light.value = this.lightAt(origin, p.dlights);
        }
      }
    }
    for (let i = 1; i < this.models.length; i++) if (!hasSub.has(i)) this.models[i].group.visible = false;
    for (const [n, g] of this.brushGroups) if (!seenBrush.has(n)) g.group.visible = false;
    this.models[0] && (this.models[0].group.visible = p.drawWorld);
    for (const [e, v] of this.entVis) {
      if (!seen.has(e)) {
        this.root.remove(v.mesh);
        this.entVis.delete(e);
      }
    }
    // animated textures per model
    for (let i = 0; i < this.models.length; i++) {
      const mg = this.models[i];
      if (!mg.group.visible) continue;
      const altFrame = (ents.get(i) ?? 0) !== 0;
      for (const mm of mg.mats) {
        const set = this.texSets.get(mm.tex);
        if (!set) continue;
        const list = altFrame ? set.alt : set.prim;
        if (list.length) mm.mat.uniforms.map.value = list[frameIdx % list.length];
      }
    }
    for (const s of this.staticVis) {
      const a = this.getAlias(s.name)!;
      s.setPose(s.st.frame | 0, time, a.skins, s.st.skin | 0, time);
      s.mat.uniforms.light.value = this.lightAt(s.st.origin, p.dlights);
    }
    this.updateParticles(time, p.dt);
    this.updateBeams(time);

    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);

    // view model
    if (this.weaponVis && (!p.weapon || this.weaponVis.name !== p.weapon.model)) {
      this.viewRoot.remove(this.weaponVis.mesh);
      this.weaponVis = null;
    }
    if (p.weapon && p.weapon.model) {
      if (!this.weaponVis) {
        const v = this.makeVis(p.weapon.model);
        if (v) {
          this.weaponVis = v;
          this.viewRoot.add(v.mesh);
        }
      }
      if (this.weaponVis) {
        const v = this.weaponVis;
        v.mesh.position.set(p.weapon.origin[0], p.weapon.origin[1], p.weapon.origin[2]);
        this.setRot(v.mesh, p.weapon.angles);
        const a = this.getAlias(v.name)!;
        v.setPose(p.weapon.frame | 0, time, a.skins, 0, time);
        v.mat.uniforms.light.value = Math.max(this.lightAt(p.origin, p.dlights), 24 / 255);
        this.renderer.clearDepth();
        this.renderer.render(this.viewScene, this.camera);
      }
    }
  }
}
