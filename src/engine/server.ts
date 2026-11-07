// Game server: entity system, collision (BSP hull tracing), physics and QuakeC integration.
import { Bsp, BspModel, Hull, CONTENTS_EMPTY, CONTENTS_SOLID, CONTENTS_WATER } from './bsp';
import { Progs } from './progs';
import { installBuiltins } from './builtins';

export const MOVETYPE = { NONE: 0, ANGLENOCLIP: 1, ANGLECLIP: 2, WALK: 3, STEP: 4, FLY: 5, TOSS: 6, PUSH: 7, NOCLIP: 8, FLYMISSILE: 9, BOUNCE: 10, BOUNCEMISSILE: 11, FOLLOW: 12 };
export const SOLID = { NOT: 0, TRIGGER: 1, BBOX: 2, SLIDEBOX: 3, BSP: 4 };
export const FL = { FLY: 1, SWIM: 2, CLIENT: 8, INWATER: 16, MONSTER: 32, GODMODE: 64, NOTARGET: 128, ITEM: 256, ONGROUND: 512, PARTIALGROUND: 1024, WATERJUMP: 2048 };
export const MOVE_NORMAL = 0, MOVE_NOMONSTERS = 1, MOVE_MISSILE = 2;
export const STEPSIZE = 18;
export const TICK = 1 / 72;

export interface Trace {
  allsolid: boolean;
  startsolid: boolean;
  fraction: number;
  endpos: number[];
  normal: number[];
  planeDist: number;
  ent: number; // -1 none
  inopen: boolean;
  inwater: boolean;
}

export interface UserCmd {
  forward: number;
  side: number;
  up: number;
  buttons: number; // 1 fire, 2 jump, 4 use
  impulse: number;
  angles: [number, number, number];
}

export interface StaticEnt {
  model: string;
  frame: number;
  skin: number;
  origin: number[];
  angles: number[];
  effects: number;
}

export interface ServerEvents {
  sound?(ent: number, chan: number, name: string, vol: number, attn: number, org: number[]): void;
  ambient?(org: number[], name: string, vol: number, attn: number): void;
  print?(s: string): void;
  centerprint?(s: string): void;
  lightstyle?(i: number, s: string): void;
  particle?(org: number[], dir: number[], color: number, count: number): void;
  temp?(type: number, a: number[]): void;
  intermission?(): void;
  finale?(text: string): void;
  cdtrack?(a: number, b: number): void;
  killedMonster?(): void;
  foundSecret?(): void;
  sellscreen?(): void;
  stuffcmd?(s: string): void;
  changelevel?(map: string): void;
  damage?(save: number, take: number, from: number[]): void;
  makeStatic?(e: StaticEnt): void;
  setAngles?(a: number[]): void;
  error?(s: string): void;
}

export const DEFAULT_CVARS: Record<string, number> = {
  skill: 1, deathmatch: 0, coop: 0, teamplay: 0, registered: 0, sv_gravity: 800, sv_friction: 4, sv_maxspeed: 320, sv_accelerate: 10,
  sv_airaccelerate: 0.7, sv_stopspeed: 100, sv_maxvelocity: 2000, sv_nostep: 0, sv_aim: 0.93, sv_edgefriction: 2, temp1: 0,
  samelevel: 0, noexit: 0, fraglimit: 0, timelimit: 0, saved1: 0, saved2: 0, saved3: 0, saved4: 0, gamma: 1,
};

export class Server {
  vm: Progs;
  bsp!: Bsp;
  ev: ServerEvents = {};
  cvars: Record<string, number> = { ...DEFAULT_CVARS };
  mapName = '';
  time = 1;
  frametime = TICK;
  numEdicts = 2;
  free: boolean[] = [];
  freeTime: number[] = [];
  models: string[] = [];
  modelBsp: (BspModel | null)[] = [];
  sounds: string[] = [];
  lightstyles: string[] = new Array(64).fill('');
  cmd: UserCmd = { forward: 0, side: 0, up: 0, buttons: 0, impulse: 0, angles: [0, 0, 0] };
  spawnParms: number[] = new Array(16).fill(0);
  serverFlags = 0;
  changelevelIssued = false;
  pendingChange: string | null = null;
  statics: StaticEnt[] = [];
  intermission = false;
  accum = 0;
  active = false;
  lastCheckTime = -1;
  checkPvs: Uint8Array | null = null;
  // cached offsets
  G: Record<string, number> = {};
  F: Record<string, number> = {};
  nf = 0;
  boxHull!: Hull;
  progsBuf: ArrayBuffer;
  loadBsp: (name: string) => ArrayBuffer | null;
  worldMins = [0, 0, 0];

  constructor(progsBuf: ArrayBuffer, loadBsp: (name: string) => ArrayBuffer | null) {
    this.progsBuf = progsBuf;
    this.loadBsp = loadBsp;
    this.vm = new Progs(progsBuf);
    this.initVm();
  }

  private initVm() {
    const vm = this.vm;
    vm.onError = (m) => {
      throw new Error('QC: ' + m);
    };
    installBuiltins(this);
    vm.resolveBuiltins();
    vm.cacheOffsets();
    this.nf = vm.entityFields;
    for (const n of ['self', 'other', 'world', 'time', 'frametime', 'force_retouch', 'mapname', 'deathmatch', 'coop', 'teamplay', 'serverflags',
      'total_secrets', 'total_monsters', 'found_secrets', 'killed_monsters', 'parm1', 'v_forward', 'v_up', 'v_right', 'trace_allsolid', 'trace_startsolid',
      'trace_fraction', 'trace_endpos', 'trace_plane_normal', 'trace_plane_dist', 'trace_ent', 'trace_inopen', 'trace_inwater', 'msg_entity']) {
      const o = vm.globalOfs.get(n);
      if (o !== undefined) this.G[n] = o;
    }
    const fields = ['modelindex', 'absmin', 'absmax', 'ltime', 'movetype', 'solid', 'origin', 'oldorigin', 'velocity', 'angles', 'avelocity', 'punchangle', 'classname',
      'model', 'frame', 'skin', 'effects', 'mins', 'maxs', 'size', 'touch', 'use', 'think', 'blocked', 'nextthink', 'groundentity', 'health', 'flags', 'colormap',
      'team', 'view_ofs', 'button0', 'button1', 'button2', 'impulse', 'fixangle', 'v_angle', 'teleport_time', 'waterlevel', 'watertype', 'ideal_yaw', 'yaw_speed',
      'goalentity', 'enemy', 'owner', 'takedamage', 'dmg_take', 'dmg_save', 'dmg_inflictor', 'items', 'weaponmodel', 'weaponframe', 'currentammo', 'ammo_shells',
      'ammo_nails', 'ammo_rockets', 'ammo_cells', 'weapon', 'armorvalue', 'armortype', 'deadflag', 'netname', 'spawnspawn', 'spawnflags', 'movedir', 'chain', 'idealpitch',
      'gravity', 'targetname', 'target', 'light_lev', 'worldtype', 'message', 'noise'];
    for (const f of fields) {
      const o = vm.fieldOfs.get(f);
      if (o !== undefined) this.F[f] = o;
    }
    this.boxHull = {
      planeNormals: new Float32Array([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1]),
      planeDist: new Float32Array(6),
      planeType: new Uint8Array([0, 0, 1, 1, 2, 2]),
      planenum: new Int32Array([0, 1, 2, 3, 4, 5]),
      children: new Int32Array(12),
      firstclipnode: 0,
      clipMins: [0, 0, 0],
      clipMaxs: [0, 0, 0],
    };
    for (let i = 0; i < 6; i++) {
      const side = i & 1;
      this.boxHull.children[i * 2 + side] = CONTENTS_EMPTY;
      this.boxHull.children[i * 2 + (side ^ 1)] = i !== 5 ? i + 1 : CONTENTS_SOLID;
    }
  }

  // ---------- field access helpers ----------
  fget(e: number, f: string) { return this.vm.evF[e * this.nf + this.F[f]]; }
  fset(e: number, f: string, v: number) { this.vm.evF[e * this.nf + this.F[f]] = v; }
  iget(e: number, f: string) { return this.vm.evI[e * this.nf + this.F[f]]; }
  iset(e: number, f: string, v: number) { this.vm.evI[e * this.nf + this.F[f]] = v; }
  vget(e: number, f: string): number[] {
    const p = e * this.nf + this.F[f];
    const a = this.vm.evF;
    return [a[p], a[p + 1], a[p + 2]];
  }
  vset(e: number, f: string, v: ArrayLike<number>) {
    const p = e * this.nf + this.F[f];
    const a = this.vm.evF;
    a[p] = v[0]; a[p + 1] = v[1]; a[p + 2] = v[2];
  }
  gset(n: string, v: number) { this.vm.gF[this.G[n]] = v; }
  gget(n: string) { return this.vm.gF[this.G[n]]; }
  gseti(n: string, v: number) { this.vm.gI[this.G[n]] = v; }
  ggeti(n: string) { return this.vm.gI[this.G[n]]; }
  cv(n: string) { return this.cvars[n] ?? 0; }
  str(e: number, f: string) { return this.vm.str(this.iget(e, f)); }

  // ---------- QC invocation ----------
  callQC(fn: number, self: number, other: number) {
    const vm = this.vm;
    const oldSelf = vm.gI[this.G.self], oldOther = vm.gI[this.G.other];
    const d0 = vm.depth, l0 = vm.localStack.length, xf = vm.xfunction;
    vm.gI[this.G.self] = self;
    vm.gI[this.G.other] = other;
    vm.gF[this.G.time] = this.time;
    try {
      vm.execute(fn);
    } catch (e) {
      vm.depth = d0;
      vm.localStack.length = l0;
      vm.xfunction = xf;
      const msg = (e as Error).message + (xf ? '' : '');
      console.error(msg);
      this.ev.error?.(msg);
    }
    vm.gI[this.G.self] = oldSelf;
    vm.gI[this.G.other] = oldOther;
  }
  callGlobalFn(name: string, self: number) {
    const fn = this.vm.gI[this.vm.gOfs(name)];
    if (fn) this.callQC(fn, self, 0);
  }

  // ---------- edicts ----------
  clearEdict(e: number) {
    const nf = this.nf;
    this.vm.evI.fill(0, e * nf, (e + 1) * nf);
    this.free[e] = false;
  }
  alloc(): number {
    for (let i = 2; i < this.numEdicts; i++) {
      if (this.free[i] && (this.freeTime[i] < 2 || this.time - this.freeTime[i] > 0.5)) {
        this.clearEdict(i);
        return i;
      }
    }
    if (this.numEdicts >= this.vm.maxEdicts) throw new Error('ED_Alloc: no free edicts');
    const e = this.numEdicts++;
    this.clearEdict(e);
    return e;
  }
  freeEdict(e: number) {
    if (e <= 1 && e !== 1) return;
    this.free[e] = true;
    this.freeTime[e] = this.time;
    this.iset(e, 'model', 0);
    this.fset(e, 'takedamage', 0);
    this.fset(e, 'modelindex', 0);
    this.fset(e, 'colormap', 0);
    this.fset(e, 'skin', 0);
    this.fset(e, 'frame', 0);
    this.vset(e, 'origin', [0, 0, 0]);
    this.vset(e, 'angles', [0, 0, 0]);
    this.fset(e, 'nextthink', -1);
    this.fset(e, 'solid', 0);
  }

  // ---------- precache ----------
  precacheModel(name: string) {
    if (!this.models.includes(name)) {
      this.models.push(name);
      this.modelBsp.push(null);
    }
  }
  private bspFiles = new Map<string, Bsp>();
  getBspFile(name: string): Bsp | null {
    let b = this.bspFiles.get(name);
    if (!b) {
      const buf = this.loadBsp(name.replace(/^maps\//, "").replace(/\.bsp$/, "")); // loader adds maps/ and .bsp itself
      if (!buf) return null;
      b = new Bsp(buf);
      this.bspFiles.set(name, b);
    }
    return b;
  }
  precacheSound(name: string) {
    if (!this.sounds.includes(name)) this.sounds.push(name);
  }
  modelIndex(name: string) {
    return this.models.indexOf(name);
  }

  // ---------- level loading ----------
  spawnLevel(map: string): boolean {
    const buf = this.loadBsp(map);
    if (!buf) throw new Error('Cannot load map ' + map);
    this.bsp = new Bsp(buf);
    this.mapName = map;
    this.vm.dynStrings = [];
    this.vm.strCache.clear();
    this.vm.allocEdicts();
    this.vm.depth = 0;
    this.vm.localStack.length = 0;
    // reset globals to progs-initial values
    const g = new DataView(this.progsBuf);
    const ofsGlobals = g.getInt32(12 * 4, true);
    const n = g.getInt32(13 * 4, true);
    new Uint8Array(this.vm.gI.buffer).set(new Uint8Array(this.progsBuf, ofsGlobals, n * 4));
    this.free = [];
    this.freeTime = [];
    this.statics = [];
    this.numEdicts = 2;
    this.free[0] = false;
    this.free[1] = false;
    this.freeTime[0] = this.freeTime[1] = 0;
    this.time = 1;
    this.intermission = false;
    this.changelevelIssued = false;
    this.pendingChange = null;
    this.lightstyles.fill('');
    this.lightstyles[0] = 'm';
    this.lastCheckTime = -1;
    this.checkPvs = null;
    this.models = ['', 'maps/' + map + '.bsp'];
    this.modelBsp = [null, this.bsp.models[0]];
    for (let i = 1; i < this.bsp.models.length; i++) {
      this.models.push('*' + i);
      this.modelBsp.push(this.bsp.models[i]);
    }
    this.sounds = [''];
    this.cmd = { forward: 0, side: 0, up: 0, buttons: 0, impulse: 0, angles: [0, 0, 0] };

    const vm = this.vm;
    this.gset('time', this.time);
    this.gset('frametime', TICK);
    this.gseti('mapname', vm.newString(map));
    this.gset('deathmatch', this.cv('deathmatch'));
    this.gset('coop', this.cv('coop'));
    this.gset('teamplay', this.cv('teamplay'));
    this.gset('serverflags', this.serverFlags);
    this.gseti('world', 0);
    // world entity
    const mi = this.bsp.models[0];
    this.vset(0, 'mins', mi.mins);
    this.vset(0, 'maxs', mi.maxs);
    this.iset(0, 'model', vm.newString('maps/' + map + '.bsp'));
    this.fset(0, 'modelindex', 1);
    this.fset(0, 'solid', SOLID.BSP);
    this.fset(0, 'movetype', MOVETYPE.PUSH);
    this.loadEntities();
    this.active = true;
    // settle
    this.frametime = 0.1;
    this.gset('frametime', 0.1);
    this.physics();
    this.physics();
    this.frametime = TICK;
    this.gset('frametime', TICK);
    return true;
  }

  // ---------- save / load ----------
  saveState() {
    const vm = this.vm;
    return {
      mapName: this.mapName,
      time: this.time,
      numEdicts: this.numEdicts,
      free: this.free.map((f) => !!f),
      freeTime: this.freeTime.slice(),
      ev: Array.from(vm.evI.subarray(0, this.numEdicts * this.nf)),
      g: Array.from(vm.gI),
      dyn: vm.dynStrings.slice(),
      models: this.models.slice(),
      sounds: this.sounds.slice(),
      lightstyles: this.lightstyles.slice(),
      statics: this.statics,
      serverFlags: this.serverFlags,
      spawnParms: this.spawnParms.slice(),
      cvars: this.cvars,
    };
  }

  loadState(s: any) {
    const buf = this.loadBsp(s.mapName);
    if (!buf) throw new Error('missing map ' + s.mapName);
    this.bsp = new Bsp(buf);
    this.mapName = s.mapName;
    const vm = this.vm;
    vm.allocEdicts();
    vm.depth = 0;
    vm.localStack.length = 0;
    vm.strCache.clear();
    vm.dynStrings = s.dyn;
    vm.evI.set(s.ev);
    vm.gI.set(s.g);
    this.numEdicts = s.numEdicts;
    this.free = s.free;
    this.freeTime = s.freeTime;
    this.time = s.time;
    this.models = s.models;
    this.modelBsp = this.models.map((n, i) => (i === 1 ? this.bsp.models[0] : n[0] === '*' ? this.bsp.models[parseInt(n.slice(1))] ?? null : null));
    this.sounds = s.sounds;
    this.lightstyles = s.lightstyles;
    this.statics = s.statics;
    this.serverFlags = s.serverFlags;
    this.spawnParms = s.spawnParms;
    this.cvars = { ...DEFAULT_CVARS, ...s.cvars };
    this.intermission = false;
    this.changelevelIssued = false;
    this.pendingChange = null;
    this.accum = 0;
    this.lastCheckTime = -1;
    this.checkPvs = null;
    this.frametime = TICK;
    this.active = true;
  }

  private parseFieldValue(e: number, key: string, value: string): boolean {
    const vm = this.vm;
    const def = vm.fieldDefs.find((d) => d.name === key);
    if (!def) return false;
    const p = e * this.nf + def.ofs;
    switch (def.type) {
      case 1: vm.evI[p] = vm.newString(value); break;
      case 2: vm.evF[p] = parseFloat(value) || 0; break;
      case 3: {
        const v = value.split(/\s+/).map(parseFloat);
        vm.evF[p] = v[0] || 0; vm.evF[p + 1] = v[1] || 0; vm.evF[p + 2] = v[2] || 0;
        break;
      }
      case 4: vm.evI[p] = parseInt(value) || 0; break;
      case 6: vm.evI[p] = vm.funcByName.get(value) ?? 0; break;
      case 5: vm.evI[p] = vm.fieldOfs.get(value) ?? 0; break;
      default: return false;
    }
    return true;
  }

  private loadEntities() {
    const skill = Math.floor(this.cv('skill'));
    const ents = this.bsp.entities;
    for (let i = 0; i < ents.length; i++) {
      const d = ents[i];
      let e: number;
      if (i === 0) e = 0;
      else e = this.alloc();
      for (const k of Object.keys(d)) {
        if (k.startsWith('_')) continue;
        let key = k;
        let val = d[k];
        if (key === 'angle') {
          this.vset(e, 'angles', [0, parseFloat(val) || 0, 0]);
          continue;
        }
        if (key === 'light') key = 'light_lev';
        this.parseFieldValue(e, key, val);
      }
      const classname = d['classname'];
      if (!classname) {
        if (e) this.freeEdict(e);
        continue;
      }
      if (e !== 0) {
        const sf = this.fget(e, 'spawnflags') | 0;
        if (this.cv('deathmatch') ? sf & 2048 : (skill === 0 && sf & 256) || (skill === 1 && sf & 512) || (skill >= 2 && sf & 1024)) {
          this.freeEdict(e);
          continue;
        }
      }
      const fn = this.vm.funcByName.get(classname);
      if (!fn) {
        this.ev.print?.('No spawn function for ' + classname + '\n');
        if (e) this.freeEdict(e);
        continue;
      }
      this.callQC(fn, e, 0);
      if (e && this.free[e]) continue;
    }
  }

  /** Create the client entity and run connect / spawn QC. */
  connectClient(newGame: boolean) {
    const vm = this.vm;
    const e = 1;
    if (newGame) {
      this.gseti('self', e);
      this.callGlobalFn('SetNewParms', e);
      for (let i = 0; i < 16; i++) this.spawnParms[i] = vm.gF[this.G.parm1 + i];
    }
    this.clearEdict(e);
    this.fset(e, 'colormap', e);
    this.fset(e, 'team', 1);
    this.iset(e, 'netname', vm.newString('player'));
    for (let i = 0; i < 16; i++) vm.gF[this.G.parm1 + i] = this.spawnParms[i];
    this.callGlobalFn('ClientConnect', e);
    this.callGlobalFn('PutClientInServer', e);
  }

  /** Called before changing levels: store parms for next level. */
  saveSpawnParms() {
    this.gseti('self', 1);
    this.callGlobalFn('SetChangeParms', 1);
    for (let i = 0; i < 16; i++) this.spawnParms[i] = this.vm.gF[this.G.parm1 + i];
    this.serverFlags = this.gget('serverflags');
  }

  // ---------- hulls / collision ----------
  hullContents(h: Hull, num: number, p: number[]): number {
    while (num >= 0) {
      const pn = h.planenum[num];
      const t = h.planeType[pn];
      const d = (t < 3 ? p[t] : h.planeNormals[pn * 3] * p[0] + h.planeNormals[pn * 3 + 1] * p[1] + h.planeNormals[pn * 3 + 2] * p[2]) - h.planeDist[pn];
      num = h.children[num * 2 + (d < 0 ? 1 : 0)];
    }
    return num;
  }
  pointContents(p: number[]): number {
    return this.hullContents(this.bsp.models[0].hulls[0], this.bsp.models[0].hulls[0].firstclipnode, p);
  }

  private hullCheck(h: Hull, num: number, p1f: number, p2f: number, p1: number[], p2: number[], tr: Trace): boolean {
    if (num < 0) {
      if (num !== CONTENTS_SOLID) {
        tr.allsolid = false;
        if (num === CONTENTS_EMPTY) tr.inopen = true;
        else tr.inwater = true;
      } else tr.startsolid = true;
      return true;
    }
    const pn = h.planenum[num];
    const t = h.planeType[pn];
    const nx = h.planeNormals[pn * 3], ny = h.planeNormals[pn * 3 + 1], nz = h.planeNormals[pn * 3 + 2], pd = h.planeDist[pn];
    let t1: number, t2: number;
    if (t < 3) {
      t1 = p1[t] - pd;
      t2 = p2[t] - pd;
    } else {
      t1 = nx * p1[0] + ny * p1[1] + nz * p1[2] - pd;
      t2 = nx * p2[0] + ny * p2[1] + nz * p2[2] - pd;
    }
    if (t1 >= 0 && t2 >= 0) return this.hullCheck(h, h.children[num * 2], p1f, p2f, p1, p2, tr);
    if (t1 < 0 && t2 < 0) return this.hullCheck(h, h.children[num * 2 + 1], p1f, p2f, p1, p2, tr);
    const EPS = 0.03125;
    let frac = t1 < 0 ? (t1 + EPS) / (t1 - t2) : (t1 - EPS) / (t1 - t2);
    if (frac < 0) frac = 0;
    if (frac > 1) frac = 1;
    let midf = p1f + (p2f - p1f) * frac;
    let mid = [p1[0] + frac * (p2[0] - p1[0]), p1[1] + frac * (p2[1] - p1[1]), p1[2] + frac * (p2[2] - p1[2])];
    const side = t1 < 0 ? 1 : 0;
    if (!this.hullCheck(h, h.children[num * 2 + side], p1f, midf, p1, mid, tr)) return false;
    if (this.hullContents(h, h.children[num * 2 + (side ^ 1)], mid) !== CONTENTS_SOLID) return this.hullCheck(h, h.children[num * 2 + (side ^ 1)], midf, p2f, mid, p2, tr);
    if (tr.allsolid) return false;
    if (!side) {
      tr.normal = [nx, ny, nz];
      tr.planeDist = pd;
    } else {
      tr.normal = [-nx, -ny, -nz];
      tr.planeDist = -pd;
    }
    while (this.hullContents(h, h.firstclipnode, mid) === CONTENTS_SOLID) {
      frac -= 0.1;
      if (frac < 0) {
        tr.fraction = midf;
        tr.endpos = mid;
        return false;
      }
      midf = p1f + (p2f - p1f) * frac;
      mid = [p1[0] + frac * (p2[0] - p1[0]), p1[1] + frac * (p2[1] - p1[1]), p1[2] + frac * (p2[2] - p1[2])];
    }
    tr.fraction = midf;
    tr.endpos = mid;
    return false;
  }

  newTrace(end: number[]): Trace {
    return { allsolid: true, startsolid: false, fraction: 1, endpos: end.slice(), normal: [0, 0, 0], planeDist: 0, ent: -1, inopen: false, inwater: false };
  }

  hullForEntity(e: number, mins: number[], maxs: number[], offset: number[]): Hull {
    const origin = this.vget(e, 'origin');
    if (this.fget(e, 'solid') === SOLID.BSP) {
      const mi = this.fget(e, 'modelindex') | 0;
      const m = this.modelBsp[mi];
      if (!m) throw new Error('SOLID_BSP with a non-bsp model');
      const sx = maxs[0] - mins[0];
      const h = sx < 3 ? m.hulls[0] : sx <= 32 ? m.hulls[1] : m.hulls[2];
      offset[0] = h.clipMins[0] - mins[0] + origin[0];
      offset[1] = h.clipMins[1] - mins[1] + origin[1];
      offset[2] = h.clipMins[2] - mins[2] + origin[2];
      return h;
    }
    const emins = this.vget(e, 'mins'), emaxs = this.vget(e, 'maxs');
    const bh = this.boxHull;
    for (let i = 0; i < 3; i++) {
      bh.planeDist[i * 2] = emaxs[i] - mins[i];
      bh.planeDist[i * 2 + 1] = emins[i] - maxs[i];
    }
    offset[0] = origin[0]; offset[1] = origin[1]; offset[2] = origin[2];
    return bh;
  }

  clipMoveToEntity(e: number, start: number[], mins: number[], maxs: number[], end: number[]): Trace {
    const tr = this.newTrace(end);
    const offset = [0, 0, 0];
    const h = this.hullForEntity(e, mins, maxs, offset);
    const sl = [start[0] - offset[0], start[1] - offset[1], start[2] - offset[2]];
    const el = [end[0] - offset[0], end[1] - offset[1], end[2] - offset[2]];
    this.hullCheck(h, h.firstclipnode, 0, 1, sl, el, tr);
    if (tr.fraction !== 1) {
      tr.endpos[0] += offset[0]; tr.endpos[1] += offset[1]; tr.endpos[2] += offset[2];
    }
    if (tr.fraction < 1 || tr.startsolid) tr.ent = e;
    return tr;
  }

  move(start: number[], mins: number[], maxs: number[], end: number[], type: number, passEnt: number): Trace {
    let trace = this.clipMoveToEntity(0, start, mins, maxs, end);
    let m2: number[], x2: number[];
    if (type === MOVE_MISSILE) {
      m2 = [-15, -15, -15];
      x2 = [15, 15, 15];
    } else {
      m2 = mins;
      x2 = maxs;
    }
    const bmin = [0, 0, 0], bmax = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      if (end[i] > start[i]) {
        bmin[i] = start[i] + mins[i] - 1;
        bmax[i] = end[i] + maxs[i] + 1;
      } else {
        bmin[i] = end[i] + mins[i] - 1;
        bmax[i] = start[i] + maxs[i] + 1;
      }
      if (type === MOVE_MISSILE) {
        bmin[i] -= 15;
        bmax[i] += 15;
      }
    }
    if (type === MOVE_MISSILE) {
      // original expands box by missile size; keep consistent
    }
    const nf = this.nf, evF = this.vm.evF;
    const oSolid = this.F.solid, oAbsmin = this.F.absmin, oAbsmax = this.F.absmax, oSize = this.F.size, oOwner = this.F.owner, oFlags = this.F.flags;
    const passOwner = passEnt > 0 ? this.vm.evI[passEnt * nf + oOwner] : 0;
    const passSizeX = passEnt > 0 ? evF[passEnt * nf + oSize] : 0;
    for (let i = 1; i < this.numEdicts; i++) {
      if (this.free[i]) continue;
      const b = i * nf;
      const solid = evF[b + oSolid];
      if (solid === SOLID.NOT || i === passEnt) continue;
      if (solid === SOLID.TRIGGER) continue;
      if (type === MOVE_NOMONSTERS && solid !== SOLID.BSP) continue;
      if (bmin[0] > evF[b + oAbsmax] || bmin[1] > evF[b + oAbsmax + 1] || bmin[2] > evF[b + oAbsmax + 2] ||
        bmax[0] < evF[b + oAbsmin] || bmax[1] < evF[b + oAbsmin + 1] || bmax[2] < evF[b + oAbsmin + 2]) continue;
      if (passEnt > 0) {
        if (passSizeX && !evF[b + oSize]) continue;
        if (this.vm.evI[b + oOwner] === passEnt) continue;
        if (passOwner === i) continue;
      }
      let t: Trace;
      if ((evF[b + oFlags] | 0) & FL.MONSTER) t = this.clipMoveToEntity(i, start, m2, x2, end);
      else t = this.clipMoveToEntity(i, start, mins, maxs, end);
      if (t.allsolid || t.startsolid || t.fraction < trace.fraction) {
        t.ent = i;
        if (trace.startsolid) {
          trace = t;
          trace.startsolid = true;
        } else trace = t;
      } else if (t.startsolid) trace.startsolid = true;
    }
    return trace;
  }

  testEntityPosition(e: number): number {
    const o = this.vget(e, 'origin');
    const t = this.move(o, this.vget(e, 'mins'), this.vget(e, 'maxs'), o, MOVE_NORMAL, e);
    return t.startsolid ? (t.ent >= 0 ? t.ent : 0) : -1;
  }

  // ---------- linking ----------
  linkEdict(e: number, touchTriggers: boolean) {
    if (e === 0 || this.free[e]) return;
    const o = this.vget(e, 'origin'), mn = this.vget(e, 'mins'), mx = this.vget(e, 'maxs');
    let amin: number[], amax: number[];
    const ang = this.vget(e, 'angles');
    if (this.fget(e, 'solid') === SOLID.BSP && (ang[0] || ang[1] || ang[2])) {
      let r = 0;
      for (let i = 0; i < 3; i++) r = Math.max(r, Math.abs(mn[i]), Math.abs(mx[i]));
      amin = [o[0] - r, o[1] - r, o[2] - r];
      amax = [o[0] + r, o[1] + r, o[2] + r];
    } else {
      amin = [o[0] + mn[0], o[1] + mn[1], o[2] + mn[2]];
      amax = [o[0] + mx[0], o[1] + mx[1], o[2] + mx[2]];
    }
    if ((this.fget(e, 'flags') | 0) & FL.ITEM) {
      amin[0] -= 15; amin[1] -= 15; amax[0] += 15; amax[1] += 15;
    } else {
      for (let i = 0; i < 3; i++) { amin[i] -= 1; amax[i] += 1; }
    }
    this.vset(e, 'absmin', amin);
    this.vset(e, 'absmax', amax);
    if (this.fget(e, 'solid') === SOLID.NOT) return;
    if (touchTriggers) this.touchLinks(e, amin, amax);
  }

  private touchLinks(e: number, amin: number[], amax: number[]) {
    const nf = this.nf, evF = this.vm.evF, evI = this.vm.evI;
    const oSolid = this.F.solid, oTouch = this.F.touch, oAbsmin = this.F.absmin, oAbsmax = this.F.absmax;
    let list: number[] | null = null;
    for (let i = 1; i < this.numEdicts; i++) {
      if (i === e || this.free[i]) continue;
      const b = i * nf;
      if (evF[b + oSolid] !== SOLID.TRIGGER || !evI[b + oTouch]) continue;
      if (amin[0] > evF[b + oAbsmax] || amin[1] > evF[b + oAbsmax + 1] || amin[2] > evF[b + oAbsmax + 2] ||
        amax[0] < evF[b + oAbsmin] || amax[1] < evF[b + oAbsmin + 1] || amax[2] < evF[b + oAbsmin + 2]) continue;
      (list ??= []).push(i);
    }
    if (!list) return;
    for (const t of list) {
      if (this.free[t] || this.free[e]) continue;
      const tb = t * nf;
      if (evF[tb + oSolid] !== SOLID.TRIGGER || !evI[tb + oTouch]) continue;
      this.callQC(evI[tb + oTouch], t, e);
    }
  }

  impact(e1: number, e2: number) {
    const t1 = this.iget(e1, 'touch');
    if (t1 && this.fget(e1, 'solid') !== SOLID.NOT) this.callQC(t1, e1, e2);
    const t2 = this.iget(e2, 'touch');
    if (t2 && this.fget(e2, 'solid') !== SOLID.NOT) this.callQC(t2, e2, e1);
  }

  // ---------- physics ----------
  clipVelocity(v: number[], n: number[], overbounce: number): { out: number[]; blocked: number } {
    let blocked = 0;
    if (n[2] > 0) blocked |= 1;
    if (!n[2]) blocked |= 2;
    const backoff = (v[0] * n[0] + v[1] * n[1] + v[2] * n[2]) * overbounce;
    const out = [v[0] - n[0] * backoff, v[1] - n[1] * backoff, v[2] - n[2] * backoff];
    for (let i = 0; i < 3; i++) if (out[i] > -0.1 && out[i] < 0.1) out[i] = 0;
    return { out, blocked };
  }

  checkVelocity(e: number) {
    const v = this.vget(e, 'velocity');
    const mv = this.cv('sv_maxvelocity');
    for (let i = 0; i < 3; i++) {
      if (Number.isNaN(v[i])) v[i] = 0;
      if (v[i] > mv) v[i] = mv;
      else if (v[i] < -mv) v[i] = -mv;
    }
    this.vset(e, 'velocity', v);
  }

  addGravity(e: number) {
    const g = this.F.gravity !== undefined ? this.fget(e, 'gravity') : 0;
    const eg = g || 1;
    this.vm.evF[e * this.nf + this.F.velocity + 2] -= eg * this.cv('sv_gravity') * this.frametime;
  }

  runThink(e: number): boolean {
    let thinktime = this.fget(e, 'nextthink');
    if (thinktime <= 0 || thinktime > this.time + this.frametime) return true;
    if (thinktime < this.time) thinktime = this.time;
    this.fset(e, 'nextthink', 0);
    const fn = this.iget(e, 'think');
    this.vm.gF[this.G.time] = thinktime;
    if (fn) this.callQC(fn, e, 0);
    else this.ev.error?.('NULL think function for ' + this.str(e, 'classname'));
    return !this.free[e];
  }

  flyMove(e: number, time: number, stepTrace: { t: Trace | null } | null): number {
    const mins = this.vget(e, 'mins'), maxs = this.vget(e, 'maxs');
    let blocked = 0;
    let vel = this.vget(e, 'velocity');
    let original = vel.slice();
    const primal = vel.slice();
    const planes: number[][] = [];
    let timeLeft = time;
    for (let bump = 0; bump < 4; bump++) {
      vel = this.vget(e, 'velocity');
      if (!vel[0] && !vel[1] && !vel[2]) break;
      const org = this.vget(e, 'origin');
      const end = [org[0] + timeLeft * vel[0], org[1] + timeLeft * vel[1], org[2] + timeLeft * vel[2]];
      const tr = this.move(org, mins, maxs, end, MOVE_NORMAL, e);
      if (tr.allsolid) {
        this.vset(e, 'velocity', [0, 0, 0]);
        return 3;
      }
      if (tr.fraction > 0) {
        this.vset(e, 'origin', tr.endpos);
        original = vel.slice();
        planes.length = 0;
      }
      if (tr.fraction === 1) break;
      if (tr.ent < 0) throw new Error('SV_FlyMove: !trace.ent');
      if (tr.normal[2] > 0.7) {
        blocked |= 1;
        if (this.fget(tr.ent, 'solid') === SOLID.BSP) {
          this.fset(e, 'flags', (this.fget(e, 'flags') | 0) | FL.ONGROUND);
          this.iset(e, 'groundentity', tr.ent);
        }
      }
      if (!tr.normal[2]) {
        blocked |= 2;
        if (stepTrace) stepTrace.t = tr;
      }
      this.impact(e, tr.ent);
      if (this.free[e]) break;
      timeLeft -= timeLeft * tr.fraction;
      if (planes.length >= 5) {
        this.vset(e, 'velocity', [0, 0, 0]);
        break;
      }
      planes.push(tr.normal);
      let i: number, newVel: number[] = [0, 0, 0];
      for (i = 0; i < planes.length; i++) {
        newVel = this.clipVelocity(original, planes[i], 1).out;
        let j: number;
        for (j = 0; j < planes.length; j++) {
          if (j !== i) {
            const p = planes[j];
            if (newVel[0] * p[0] + newVel[1] * p[1] + newVel[2] * p[2] < 0) break;
          }
        }
        if (j === planes.length) break;
      }
      if (i !== planes.length) {
        this.vset(e, 'velocity', newVel);
      } else {
        if (planes.length !== 2) {
          this.vset(e, 'velocity', [0, 0, 0]);
          return 7;
        }
        const a = planes[0], b = planes[1];
        const dir = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const cur = this.vget(e, 'velocity');
        const d = dir[0] * cur[0] + dir[1] * cur[1] + dir[2] * cur[2];
        this.vset(e, 'velocity', [dir[0] * d, dir[1] * d, dir[2] * d]);
      }
      const nv = this.vget(e, 'velocity');
      if (nv[0] * primal[0] + nv[1] * primal[1] + nv[2] * primal[2] <= 0) {
        this.vset(e, 'velocity', [0, 0, 0]);
        return blocked;
      }
    }
    return blocked;
  }

  pushEntity(e: number, push: number[]): Trace {
    const o = this.vget(e, 'origin');
    const end = [o[0] + push[0], o[1] + push[1], o[2] + push[2]];
    const mt = this.fget(e, 'movetype'), sol = this.fget(e, 'solid');
    let type = MOVE_NORMAL;
    if (mt === MOVETYPE.FLYMISSILE) type = MOVE_MISSILE;
    else if (sol === SOLID.TRIGGER || sol === SOLID.NOT) type = MOVE_NOMONSTERS;
    const tr = this.move(o, this.vget(e, 'mins'), this.vget(e, 'maxs'), end, type, e);
    this.vset(e, 'origin', tr.endpos);
    this.linkEdict(e, true);
    if (tr.ent >= 0) this.impact(e, tr.ent);
    return tr;
  }

  tryUnstick(e: number, oldvel: number[]): number {
    const oldorg = this.vget(e, 'origin');
    const dirs = [[2, 0], [0, 2], [-2, 0], [0, -2], [2, 2], [-2, 2], [2, -2], [-2, -2]];
    for (const d of dirs) {
      this.pushEntity(e, [d[0], d[1], 0]);
      this.vset(e, 'velocity', [oldvel[0], oldvel[1], 0]);
      const clip = this.flyMove(e, 0.1, null);
      const o = this.vget(e, 'origin');
      if (Math.abs(oldorg[1] - o[1]) > 4 || Math.abs(oldorg[0] - o[0]) > 4) return clip;
      this.vset(e, 'origin', oldorg);
    }
    this.vset(e, 'velocity', [0, 0, 0]);
    return 7;
  }

  wallFriction(e: number, n: number[]) {
    const f = angleVectors(this.vget(e, 'v_angle')).forward;
    let d = n[0] * f[0] + n[1] * f[1] + n[2] * f[2] + 0.5;
    if (d >= 0) return;
    const v = this.vget(e, 'velocity');
    const i = n[0] * v[0] + n[1] * v[1] + n[2] * v[2];
    const sx = v[0] - n[0] * i, sy = v[1] - n[1] * i;
    v[0] = sx * (1 + d);
    v[1] = sy * (1 + d);
    this.vset(e, 'velocity', v);
  }

  walkMove(e: number) {
    const flags0 = this.fget(e, 'flags') | 0;
    const oldOnGround = flags0 & FL.ONGROUND;
    this.fset(e, 'flags', flags0 & ~FL.ONGROUND);
    const oldorg = this.vget(e, 'origin');
    const oldvel = this.vget(e, 'velocity');
    const st = { t: null as Trace | null };
    let clip = this.flyMove(e, this.frametime, st);
    if (!(clip & 2)) return;
    if (!oldOnGround && this.fget(e, 'waterlevel') === 0) return;
    if (this.fget(e, 'movetype') !== MOVETYPE.WALK) return;
    if (this.cv('sv_nostep')) return;
    if ((this.fget(e, 'flags') | 0) & FL.WATERJUMP) return;
    const nosteporg = this.vget(e, 'origin');
    const nostepvel = this.vget(e, 'velocity');
    this.vset(e, 'origin', oldorg);
    this.pushEntity(e, [0, 0, STEPSIZE]);
    this.vset(e, 'velocity', [oldvel[0], oldvel[1], 0]);
    st.t = null;
    clip = this.flyMove(e, this.frametime, st);
    if (clip) {
      const o = this.vget(e, 'origin');
      if (Math.abs(oldorg[1] - o[1]) < 0.03125 && Math.abs(oldorg[0] - o[0]) < 0.03125) clip = this.tryUnstick(e, oldvel);
    }
    const stt = st.t as Trace | null;
    if (clip & 2 && stt) this.wallFriction(e, stt.normal);
    const down = this.pushEntity(e, [0, 0, -STEPSIZE]);
    if (down.normal[2] > 0.7) {
      if (down.ent >= 0 && this.fget(down.ent, 'solid') === SOLID.BSP) {
        this.fset(e, 'flags', (this.fget(e, 'flags') | 0) | FL.ONGROUND);
        this.iset(e, 'groundentity', down.ent);
      }
    } else {
      this.vset(e, 'origin', nosteporg);
      this.vset(e, 'velocity', nostepvel);
    }
  }

  checkStuck(e: number) {
    if (this.testEntityPosition(e) < 0) {
      this.vset(e, 'oldorigin', this.vget(e, 'origin'));
      return;
    }
    const org = this.vget(e, 'origin');
    this.vset(e, 'origin', this.vget(e, 'oldorigin'));
    if (this.testEntityPosition(e) < 0) {
      this.linkEdict(e, true);
      return;
    }
    for (let z = 0; z < 18; z++)
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++) {
          this.vset(e, 'origin', [org[0] + i, org[1] + j, org[2] + z]);
          if (this.testEntityPosition(e) < 0) {
            this.linkEdict(e, true);
            return;
          }
        }
    this.vset(e, 'origin', org);
  }

  checkWater(e: number): boolean {
    const o = this.vget(e, 'origin'), mn = this.vget(e, 'mins'), mx = this.vget(e, 'maxs'), vo = this.vget(e, 'view_ofs');
    const pt = [o[0], o[1], o[2] + mn[2] + 1];
    this.fset(e, 'waterlevel', 0);
    this.fset(e, 'watertype', CONTENTS_EMPTY);
    let cont = this.pointContents(pt);
    if (cont <= CONTENTS_WATER) {
      this.fset(e, 'watertype', cont);
      this.fset(e, 'waterlevel', 1);
      pt[2] = o[2] + (mn[2] + mx[2]) * 0.5;
      cont = this.pointContents(pt);
      if (cont <= CONTENTS_WATER) {
        this.fset(e, 'waterlevel', 2);
        pt[2] = o[2] + vo[2];
        cont = this.pointContents(pt);
        if (cont <= CONTENTS_WATER) this.fset(e, 'waterlevel', 3);
      }
    }
    return this.fget(e, 'waterlevel') > 1;
  }

  checkWaterTransition(e: number) {
    const cont = this.pointContents(this.vget(e, 'origin'));
    if (!this.fget(e, 'watertype')) {
      this.fset(e, 'watertype', cont);
      this.fset(e, 'waterlevel', 1);
      return;
    }
    if (cont <= CONTENTS_WATER) {
      if (this.fget(e, 'watertype') === CONTENTS_EMPTY) this.startSound(e, 0, 'misc/h2ohit1.wav', 255, 1);
      this.fset(e, 'watertype', cont);
      this.fset(e, 'waterlevel', 1);
    } else {
      if (this.fget(e, 'watertype') !== CONTENTS_EMPTY) this.startSound(e, 0, 'misc/h2ohit1.wav', 255, 1);
      this.fset(e, 'watertype', CONTENTS_EMPTY);
      this.fset(e, 'waterlevel', cont);
    }
  }

  entityCenter(e: number): number[] {
    const o = this.vget(e, 'origin'), mn = this.vget(e, 'mins'), mx = this.vget(e, 'maxs');
    return [o[0] + (mn[0] + mx[0]) * 0.5, o[1] + (mn[1] + mx[1]) * 0.5, o[2] + (mn[2] + mx[2]) * 0.5];
  }

  startSound(e: number, chan: number, name: string, vol: number, attn: number) {
    this.ev.sound?.(e, chan, name, vol, attn, this.entityCenter(e));
  }

  // ---- movetypes ----
  physicsToss(e: number) {
    if (!this.runThink(e)) return;
    if ((this.fget(e, 'flags') | 0) & FL.ONGROUND) return;
    this.checkVelocity(e);
    const mt = this.fget(e, 'movetype');
    if (mt !== MOVETYPE.FLY && mt !== MOVETYPE.FLYMISSILE) this.addGravity(e);
    const ang = this.vget(e, 'angles'), av = this.vget(e, 'avelocity');
    this.vset(e, 'angles', [ang[0] + av[0] * this.frametime, ang[1] + av[1] * this.frametime, ang[2] + av[2] * this.frametime]);
    const v = this.vget(e, 'velocity');
    const tr = this.pushEntity(e, [v[0] * this.frametime, v[1] * this.frametime, v[2] * this.frametime]);
    if (tr.fraction === 1) return;
    if (this.free[e]) return;
    const backoff = mt === MOVETYPE.BOUNCE ? 1.5 : 1;
    const cv = this.clipVelocity(this.vget(e, 'velocity'), tr.normal, backoff);
    this.vset(e, 'velocity', cv.out);
    if (tr.normal[2] > 0.7) {
      if (cv.out[2] < 60 || mt !== MOVETYPE.BOUNCE) {
        this.fset(e, 'flags', (this.fget(e, 'flags') | 0) | FL.ONGROUND);
        this.iset(e, 'groundentity', tr.ent);
        this.vset(e, 'velocity', [0, 0, 0]);
        this.vset(e, 'avelocity', [0, 0, 0]);
      }
    }
    this.checkWaterTransition(e);
  }

  physicsStep(e: number) {
    const flags = this.fget(e, 'flags') | 0;
    if (!(flags & (FL.ONGROUND | FL.FLY | FL.SWIM))) {
      const hit = this.vm.evF[e * this.nf + this.F.velocity + 2] < this.cv('sv_gravity') * -0.1;
      this.addGravity(e);
      this.checkVelocity(e);
      this.flyMove(e, this.frametime, null);
      this.linkEdict(e, true);
      if ((this.fget(e, 'flags') | 0) & FL.ONGROUND) {
        if (hit) this.startSound(e, 0, 'demon/dland2.wav', 255, 1);
      }
    }
    this.runThink(e);
    this.checkWaterTransition(e);
  }

  pushMove(pusher: number, movetime: number) {
    const vel = this.vget(pusher, 'velocity');
    if (!vel[0] && !vel[1] && !vel[2]) {
      this.fset(pusher, 'ltime', this.fget(pusher, 'ltime') + movetime);
      return;
    }
    const move = [vel[0] * movetime, vel[1] * movetime, vel[2] * movetime];
    const amin = this.vget(pusher, 'absmin'), amax = this.vget(pusher, 'absmax');
    const mins = [amin[0] + move[0], amin[1] + move[1], amin[2] + move[2]];
    const maxs = [amax[0] + move[0], amax[1] + move[1], amax[2] + move[2]];
    const pushorig = this.vget(pusher, 'origin');
    this.vset(pusher, 'origin', [pushorig[0] + move[0], pushorig[1] + move[1], pushorig[2] + move[2]]);
    this.fset(pusher, 'ltime', this.fget(pusher, 'ltime') + movetime);
    this.linkEdict(pusher, false);
    const moved: { e: number; from: number[] }[] = [];
    for (let check = 1; check < this.numEdicts; check++) {
      if (this.free[check]) continue;
      const mt = this.fget(check, 'movetype');
      if (mt === MOVETYPE.PUSH || mt === MOVETYPE.NONE || mt === MOVETYPE.FOLLOW || mt === MOVETYPE.NOCLIP) continue;
      const flags = this.fget(check, 'flags') | 0;
      if (!(flags & FL.ONGROUND && this.iget(check, 'groundentity') === pusher)) {
        const cmin = this.vget(check, 'absmin'), cmax = this.vget(check, 'absmax');
        if (cmin[0] >= maxs[0] || cmin[1] >= maxs[1] || cmin[2] >= maxs[2] || cmax[0] <= mins[0] || cmax[1] <= mins[1] || cmax[2] <= mins[2]) continue;
        if (this.testEntityPosition(check) < 0) continue;
      }
      if (mt !== MOVETYPE.WALK) this.fset(check, 'flags', (this.fget(check, 'flags') | 0) & ~FL.ONGROUND);
      const entorig = this.vget(check, 'origin');
      moved.push({ e: check, from: entorig });
      this.fset(pusher, 'solid', SOLID.NOT);
      this.pushEntity(check, move);
      this.fset(pusher, 'solid', SOLID.BSP);
      if (this.testEntityPosition(check) >= 0) {
        const cm = this.vget(check, 'mins'), cx = this.vget(check, 'maxs');
        if (cm[0] === cx[0]) continue;
        const sol = this.fget(check, 'solid');
        if (sol === SOLID.NOT || sol === SOLID.TRIGGER) {
          cm[0] = cm[1] = 0;
          cx[0] = cm[0]; cx[1] = cm[1]; cx[2] = cm[2];
          this.vset(check, 'mins', cm);
          this.vset(check, 'maxs', cx);
          continue;
        }
        this.vset(check, 'origin', entorig);
        this.linkEdict(check, true);
        this.vset(pusher, 'origin', pushorig);
        this.linkEdict(pusher, false);
        this.fset(pusher, 'ltime', this.fget(pusher, 'ltime') - movetime);
        const blocked = this.iget(pusher, 'blocked');
        if (blocked) this.callQC(blocked, pusher, check);
        for (const m of moved) {
          this.vset(m.e, 'origin', m.from);
          this.linkEdict(m.e, false);
        }
        return;
      }
    }
  }

  physicsPusher(e: number) {
    const oldltime = this.fget(e, 'ltime');
    const thinktime = this.fget(e, 'nextthink');
    let movetime: number;
    if (thinktime < oldltime + this.frametime) {
      movetime = thinktime - oldltime;
      if (movetime < 0) movetime = 0;
    } else movetime = this.frametime;
    if (movetime) {
      const av = this.vget(e, 'avelocity');
      if (av[0] || av[1] || av[2]) {
        const a = this.vget(e, 'angles');
        this.vset(e, 'angles', [a[0] + av[0] * movetime, a[1] + av[1] * movetime, a[2] + av[2] * movetime]);
      }
      this.pushMove(e, movetime);
    }
    const lt = this.fget(e, 'ltime');
    if (thinktime > oldltime && thinktime <= lt) {
      this.fset(e, 'nextthink', 0);
      this.vm.gF[this.G.time] = this.time;
      const fn = this.iget(e, 'think');
      if (fn) this.callQC(fn, e, 0);
    }
  }

  // ---- client movement ----
  userFriction(e: number) {
    const vel = this.vget(e, 'velocity');
    const speed = Math.hypot(vel[0], vel[1]);
    if (!speed) return;
    const o = this.vget(e, 'origin'), mn = this.vget(e, 'mins');
    const start = [o[0] + (vel[0] / speed) * 16, o[1] + (vel[1] / speed) * 16, o[2] + mn[2]];
    const stop = [start[0], start[1], start[2] - 34];
    const tr = this.move(start, [0, 0, 0], [0, 0, 0], stop, MOVE_NOMONSTERS, e);
    const friction = tr.fraction === 1 ? this.cv('sv_friction') * this.cv('sv_edgefriction') : this.cv('sv_friction');
    const control = speed < this.cv('sv_stopspeed') ? this.cv('sv_stopspeed') : speed;
    let ns = speed - this.frametime * control * friction;
    if (ns < 0) ns = 0;
    ns /= speed;
    this.vset(e, 'velocity', [vel[0] * ns, vel[1] * ns, vel[2] * ns]);
  }

  accelerate(e: number, wishspeed: number, wd: number[]) {
    const v = this.vget(e, 'velocity');
    const cur = v[0] * wd[0] + v[1] * wd[1] + v[2] * wd[2];
    const add = wishspeed - cur;
    if (add <= 0) return;
    let as = this.cv('sv_accelerate') * this.frametime * wishspeed;
    if (as > add) as = add;
    this.vset(e, 'velocity', [v[0] + as * wd[0], v[1] + as * wd[1], v[2] + as * wd[2]]);
  }
  airAccelerate(e: number, wishspeed: number, wv: number[]) {
    const wl = Math.hypot(wv[0], wv[1], wv[2]);
    let wishspd = wl;
    const wd = wl ? [wv[0] / wl, wv[1] / wl, wv[2] / wl] : [0, 0, 0];
    if (wishspd > 30) wishspd = 30;
    const v = this.vget(e, 'velocity');
    const cur = v[0] * wd[0] + v[1] * wd[1] + v[2] * wd[2];
    const add = wishspd - cur;
    if (add <= 0) return;
    let as = this.cv('sv_accelerate') * wishspeed * this.frametime;
    if (as > add) as = add;
    this.vset(e, 'velocity', [v[0] + as * wd[0], v[1] + as * wd[1], v[2] + as * wd[2]]);
  }

  airMove(e: number) {
    const ang = this.vget(e, 'angles');
    const av = angleVectors(ang);
    let fmove = this.cmd.forward, smove = this.cmd.side;
    if (this.time < this.fget(e, 'teleport_time') && fmove < 0) fmove = 0;
    const wishvel = [0, 0, 0];
    for (let i = 0; i < 3; i++) wishvel[i] = av.forward[i] * fmove + av.right[i] * smove;
    if (this.fget(e, 'movetype') !== MOVETYPE.WALK) wishvel[2] = this.cmd.up;
    else wishvel[2] = 0;
    let wishspeed = Math.hypot(wishvel[0], wishvel[1], wishvel[2]);
    const wd = wishspeed ? [wishvel[0] / wishspeed, wishvel[1] / wishspeed, wishvel[2] / wishspeed] : [0, 0, 0];
    const maxs = this.cv('sv_maxspeed');
    if (wishspeed > maxs) {
      for (let i = 0; i < 3; i++) wishvel[i] = (wishvel[i] * maxs) / wishspeed;
      wishspeed = maxs;
    }
    if (this.fget(e, 'movetype') === MOVETYPE.NOCLIP) {
      this.vset(e, 'velocity', wishvel);
    } else if ((this.fget(e, 'flags') | 0) & FL.ONGROUND) {
      this.userFriction(e);
      this.accelerate(e, wishspeed, wd);
    } else {
      this.airAccelerate(e, wishspeed, wishvel);
    }
  }

  waterMove(e: number) {
    const av = angleVectors(this.vget(e, 'v_angle'));
    const wishvel = [0, 0, 0];
    for (let i = 0; i < 3; i++) wishvel[i] = av.forward[i] * this.cmd.forward + av.right[i] * this.cmd.side;
    if (!this.cmd.forward && !this.cmd.side && !this.cmd.up) wishvel[2] -= 60;
    else wishvel[2] += this.cmd.up;
    let wishspeed = Math.hypot(wishvel[0], wishvel[1], wishvel[2]);
    const maxs = this.cv('sv_maxspeed');
    if (wishspeed > maxs) {
      for (let i = 0; i < 3; i++) wishvel[i] = (wishvel[i] * maxs) / wishspeed;
      wishspeed = maxs;
    }
    wishspeed *= 0.7;
    const v = this.vget(e, 'velocity');
    const speed = Math.hypot(v[0], v[1], v[2]);
    let newspeed = 0;
    if (speed) {
      newspeed = speed - this.frametime * speed * this.cv('sv_friction');
      if (newspeed < 0) newspeed = 0;
      const k = newspeed / speed;
      v[0] *= k; v[1] *= k; v[2] *= k;
    }
    this.vset(e, 'velocity', v);
    if (!wishspeed) return;
    const add = wishspeed - newspeed;
    if (add <= 0) return;
    const wl = Math.hypot(wishvel[0], wishvel[1], wishvel[2]);
    let as = this.cv('sv_accelerate') * wishspeed * this.frametime;
    if (as > add) as = add;
    this.vset(e, 'velocity', [v[0] + (as * wishvel[0]) / wl, v[1] + (as * wishvel[1]) / wl, v[2] + (as * wishvel[2]) / wl]);
  }

  waterJump(e: number) {
    if (this.time > this.fget(e, 'teleport_time') || !this.fget(e, 'waterlevel')) {
      this.fset(e, 'flags', (this.fget(e, 'flags') | 0) & ~FL.WATERJUMP);
      this.fset(e, 'teleport_time', 0);
    }
    const md = this.vget(e, 'movedir');
    const v = this.vget(e, 'velocity');
    v[0] = md[0];
    v[1] = md[1];
    this.vset(e, 'velocity', v);
  }

  /** Apply the latest user command (SV_ClientThink). */
  clientThink(e: number) {
    if (this.fget(e, 'movetype') === MOVETYPE.NONE) return;
    // punch angle decay
    const pa = this.vget(e, 'punchangle');
    let len = Math.hypot(pa[0], pa[1], pa[2]);
    if (len) {
      const nl = Math.max(0, len - 10 * this.frametime);
      const k = nl / len;
      this.vset(e, 'punchangle', [pa[0] * k, pa[1] * k, pa[2] * k]);
    }
    if (this.fget(e, 'health') <= 0) return;
    const va = this.vget(e, 'v_angle');
    const pa2 = this.vget(e, 'punchangle');
    const angles = [va[0] + pa2[0], va[1] + pa2[1], va[2] + pa2[2]];
    const cur = this.vget(e, 'angles');
    const roll = calcRoll(cur, this.vget(e, 'velocity')) * 4;
    if (!this.fget(e, 'fixangle')) {
      this.vset(e, 'angles', [-angles[0] / 3, angles[1], roll]);
    }
    if ((this.fget(e, 'flags') | 0) & FL.WATERJUMP) {
      this.waterJump(e);
      return;
    }
    if (this.fget(e, 'waterlevel') >= 2 && this.fget(e, 'movetype') !== MOVETYPE.NOCLIP) {
      this.waterMove(e);
      return;
    }
    this.airMove(e);
  }

  physicsClient(e: number) {
    this.vm.gF[this.G.time] = this.time;
    this.callGlobalFn('PlayerPreThink', e);
    this.checkVelocity(e);
    const mt = this.fget(e, 'movetype');
    switch (mt) {
      case MOVETYPE.NONE:
        if (!this.runThink(e)) return;
        break;
      case MOVETYPE.WALK:
        if (!this.runThink(e)) return;
        if (!this.checkWater(e) && !((this.fget(e, 'flags') | 0) & FL.WATERJUMP)) this.addGravity(e);
        this.checkStuck(e);
        this.walkMove(e);
        break;
      case MOVETYPE.TOSS:
      case MOVETYPE.BOUNCE:
        this.physicsToss(e);
        break;
      case MOVETYPE.FLY:
        if (!this.runThink(e)) return;
        this.flyMove(e, this.frametime, null);
        break;
      case MOVETYPE.NOCLIP: {
        if (!this.runThink(e)) return;
        const o = this.vget(e, 'origin'), v = this.vget(e, 'velocity');
        this.vset(e, 'origin', [o[0] + this.frametime * v[0], o[1] + this.frametime * v[1], o[2] + this.frametime * v[2]]);
        break;
      }
      default:
        this.ev.error?.('SV_Physics_client: bad movetype ' + mt);
    }
    this.linkEdict(e, true);
    this.vm.gF[this.G.time] = this.time;
    this.callGlobalFn('PlayerPostThink', e);
  }

  physics() {
    const vm = this.vm;
    vm.gI[this.G.self] = 0;
    vm.gI[this.G.other] = 0;
    vm.gF[this.G.time] = this.time;
    vm.gF[this.G.frametime] = this.frametime;
    const sf = vm.gI[vm.gOfs('StartFrame')];
    if (sf) this.callQC(sf, 0, 0);
    for (let e = 0; e < this.numEdicts; e++) {
      if (this.free[e]) continue;
      if (vm.gF[this.G.force_retouch]) this.linkEdict(e, true);
      if (e === 1) {
        this.physicsClient(e);
        continue;
      }
      const mt = this.fget(e, 'movetype');
      switch (mt) {
        case MOVETYPE.PUSH: this.physicsPusher(e); break;
        case MOVETYPE.NONE: this.runThink(e); break;
        case MOVETYPE.FOLLOW: this.runThink(e); break;
        case MOVETYPE.NOCLIP: {
          if (!this.runThink(e)) break;
          const o = this.vget(e, 'origin'), v = this.vget(e, 'velocity');
          this.vset(e, 'origin', [o[0] + this.frametime * v[0], o[1] + this.frametime * v[1], o[2] + this.frametime * v[2]]);
          this.linkEdict(e, false);
          break;
        }
        case MOVETYPE.STEP: this.physicsStep(e); break;
        case MOVETYPE.WALK:
          if (this.runThink(e)) {
            if (!this.checkWater(e) && !((this.fget(e, 'flags') | 0) & FL.WATERJUMP)) this.addGravity(e);
            this.checkStuck(e);
            this.walkMove(e);
          }
          break;
        case MOVETYPE.TOSS:
        case MOVETYPE.BOUNCE:
        case MOVETYPE.BOUNCEMISSILE:
        case MOVETYPE.FLY:
        case MOVETYPE.FLYMISSILE:
          this.physicsToss(e);
          break;
        default:
          if (e !== 0) this.ev.error?.('SV_Physics: bad movetype ' + mt + ' on ' + this.str(e, 'classname'));
      }
    }
    if (vm.gF[this.G.force_retouch] > 0) vm.gF[this.G.force_retouch]--;
    this.time += this.frametime;
  }

  /** Advance by real time using fixed ticks. Returns number of ticks run. */
  update(dt: number, cmd: UserCmd): number {
    if (!this.active) return 0;
    this.accum += Math.min(dt, 0.25);
    let n = 0;
    while (this.accum >= TICK) {
      this.accum -= TICK;
      this.tick(cmd);
      n++;
      if (this.pendingChange) break;
    }
    return n;
  }

  // ---- interpolation: positions saved at the start of each physics tick
  private prevOrg = new Map<number, number[]>();
  private prevAng = new Map<number, number[]>();
  private snapshotPrev() {
    this.prevOrg.clear();
    this.prevAng.clear();
    for (let e = 1; e < this.numEdicts; e++) {
      if (this.free[e]) continue;
      this.prevOrg.set(e, Array.from(this.vget(e, 'origin')));
      this.prevAng.set(e, Array.from(this.vget(e, 'angles')));
    }
  }
  /** Fraction (0..1) of the current physics tick that has already elapsed. */
  alpha(): number {
    return Math.min(1, Math.max(0, this.accum / TICK));
  }
  lerpOrigin(e: number): number[] {
    const c = this.vget(e, 'origin');
    const p = this.prevOrg.get(e);
    if (!p || Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]) > 128) return Array.from(c); // teleport: no blending
    const a = this.alpha();
    return [0, 1, 2].map((i) => p[i] + (c[i] - p[i]) * a);
  }
  lerpAngles(e: number): number[] {
    const c = this.vget(e, 'angles');
    const p = this.prevAng.get(e);
    if (!p) return Array.from(c);
    const a = this.alpha();
    return [0, 1, 2].map((i) => {
      const d = ((((c[i] - p[i]) % 360) + 540) % 360) - 180; // shortest way round
      return p[i] + d * a;
    });
  }

  tick(cmd: UserCmd) {
    this.snapshotPrev();
    const e = 1;
    this.cmd = cmd;
    // read client move
    this.vset(e, 'v_angle', cmd.angles);
    this.fset(e, 'button0', cmd.buttons & 1);
    this.fset(e, 'button2', (cmd.buttons & 2) >> 1);
    this.fset(e, 'button1', (cmd.buttons & 4) >> 2);
    if (cmd.impulse) {
      this.fset(e, 'impulse', cmd.impulse);
      cmd.impulse = 0;
    }
    this.clientThink(e);
    this.physics();
    // client data: angle fixing and damage
    if (this.fget(e, 'fixangle')) {
      const a = this.vget(e, 'angles');
      this.ev.setAngles?.(a);
      this.vset(e, 'v_angle', a);
      this.fset(e, 'fixangle', 0);
    }
    const take = this.fget(e, 'dmg_take'), save = this.fget(e, 'dmg_save');
    if (take || save) {
      const inf = this.iget(e, 'dmg_inflictor');
      let from = this.vget(e, 'origin');
      if (inf) {
        const o = this.vget(inf, 'origin'), m = this.vget(inf, 'mins'), x = this.vget(inf, 'maxs');
        from = [o[0] + (m[0] + x[0]) * 0.5, o[1] + (m[1] + x[1]) * 0.5, o[2] + (m[2] + x[2]) * 0.5];
      }
      this.ev.damage?.(save, take, from);
      this.fset(e, 'dmg_take', 0);
      this.fset(e, 'dmg_save', 0);
    }
  }
}

export function angleVectors(a: number[]) {
  const d2r = Math.PI / 180;
  const sy = Math.sin(a[1] * d2r), cy = Math.cos(a[1] * d2r);
  const sp = Math.sin(a[0] * d2r), cp = Math.cos(a[0] * d2r);
  const sr = Math.sin(a[2] * d2r), cr = Math.cos(a[2] * d2r);
  return {
    forward: [cp * cy, cp * sy, -sp],
    right: [-sr * sp * cy + cr * sy, -sr * sp * sy - cr * cy, -sr * cp],
    up: [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp],
  };
}

export function calcRoll(angles: number[], velocity: number[]) {
  const r = angleVectors(angles).right;
  let side = velocity[0] * r[0] + velocity[1] * r[1] + velocity[2] * r[2];
  const sign = side < 0 ? -1 : 1;
  side = Math.abs(side);
  const value = 2.0, speed = 200;
  return (side < speed ? (side * value) / speed : value) * sign;
}
