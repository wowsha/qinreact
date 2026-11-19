// Quake .dem playback. A demo is a text line (the CD track), then records of
// { int32 length, 3 float view angles, length bytes of NetQuake (protocol 15) server messages }.
// The messages are parsed in full first, so a record that does not end exactly at its
// length shows up as an error. The entity state is then written into a Server's edicts,
// which the renderer already reads.
import { Server, StaticEnt } from './server';
import { Bsp } from './bsp';

const SVC = {
  nop: 1, disconnect: 2, updatestat: 3, version: 4, setview: 5, sound: 6, time: 7, print: 8, stufftext: 9,
  setangle: 10, serverinfo: 11, lightstyle: 12, updatename: 13, updatefrags: 14, clientdata: 15, stopsound: 16,
  updatecolors: 17, particle: 18, damage: 19, spawnstatic: 20, spawnbinary: 21, spawnbaseline: 22,
  temp_entity: 23, setpause: 24, signonnum: 25, centerprint: 26, killedmonster: 27, foundsecret: 28,
  spawnstaticsound: 29, intermission: 30, finale: 31, cdtrack: 32, sellscreen: 33, cutscene: 34,
};
// entity update flags (protocol 15)
const U = {
  MOREBITS: 1 << 0, ORIGIN1: 1 << 1, ORIGIN2: 1 << 2, ORIGIN3: 1 << 3, ANGLE2: 1 << 4, NOLERP: 1 << 5, FRAME: 1 << 6,
  SIGNAL: 1 << 7, ANGLE1: 1 << 8, ANGLE3: 1 << 9, MODEL: 1 << 10, COLORMAP: 1 << 11, SKIN: 1 << 12, EFFECTS: 1 << 13,
  LONGENTITY: 1 << 14,
};
// client data flags
const SU = {
  VIEWHEIGHT: 1 << 0, IDEALPITCH: 1 << 1, PUNCH1: 1 << 2, VELOCITY1: 1 << 5, ONGROUND: 1 << 10, INWATER: 1 << 11,
  WEAPONFRAME: 1 << 12, ARMOR: 1 << 13, WEAPON: 1 << 14,
};

class DemoError extends Error {}

class MsgReader {
  p = 0;
  constructor(readonly b: Uint8Array) {}
  get end() { return this.p >= this.b.length; }
  byte(): number {
    if (this.p >= this.b.length) throw new DemoError(`message ends early at byte ${this.p}`);
    return this.b[this.p++];
  }
  char(): number { const v = this.byte(); return v > 127 ? v - 256 : v; }
  ushort(): number { const lo = this.byte(); return lo | (this.byte() << 8); }
  short(): number { return (this.ushort() << 16) >> 16; }
  long(): number { const a = this.byte(), b = this.byte(), c = this.byte(), d = this.byte(); return a | (b << 8) | (c << 16) | (d << 24); }
  float(): number {
    const dv = new DataView(this.b.buffer, this.b.byteOffset + this.p, 4);
    this.p += 4;
    return dv.getFloat32(0, true);
  }
  coord(): number { return this.short() / 8; }
  angle(): number { return this.char() * (360 / 256); }
  string(): string {
    let s = '';
    for (;;) {
      const c = this.byte();
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
}

interface EntState {
  model: number; frame: number; colormap: number; skin: number; effects: number;
  origin: number[]; angles: number[];
}
type Op =
  | { k: 'upd'; e: number; model?: number; frame?: number; colormap?: number; skin?: number; effects?: number; o: (number | undefined)[]; a: (number | undefined)[] }
  | { k: 'base'; e: number; st: EntState }
  | { k: 'static'; model: number; frame: number; skin: number; origin: number[]; angles: number[] }
  | { k: 'time'; v: number }
  | { k: 'print'; s: string }
  | { k: 'center'; s: string }
  | { k: 'light'; i: number; s: string }
  | { k: 'particle'; org: number[]; dir: number[]; color: number; count: number }
  | { k: 'temp'; t: number; a: number[] }
  | { k: 'client'; c: ClientData }
  | { k: 'serverinfo'; map: string; models: string[]; sounds: string[] }
  | { k: 'end' };
interface ClientData {
  viewHeight: number; velocity: number[]; punch: number[]; items: number; onGround: boolean;
  weaponFrame: number; armor: number; weaponModel: number; health: number; currentAmmo: number; ammo: number[]; weapon: number;
}
export interface DemoRecord { time: number; angles: number[]; ops: Op[] }

function readClientData(r: MsgReader): ClientData {
  const bits = r.ushort();
  const c: ClientData = {
    viewHeight: 22, velocity: [0, 0, 0], punch: [0, 0, 0], items: 0, onGround: false,
    weaponFrame: 0, armor: 0, weaponModel: 0, health: 0, currentAmmo: 0, ammo: [0, 0, 0, 0], weapon: 0,
  };
  if (bits & SU.VIEWHEIGHT) c.viewHeight = r.char();
  if (bits & SU.IDEALPITCH) r.char();
  // punch and velocity are per axis: punch x, velocity x, punch y, velocity y, ...
  for (let i = 0; i < 3; i++) {
    if (bits & (SU.PUNCH1 << i)) c.punch[i] = r.char();
    if (bits & (SU.VELOCITY1 << i)) c.velocity[i] = r.char() * 16;
  }
  c.items = r.long(); // always sent
  c.onGround = !!(bits & SU.ONGROUND);
  if (bits & SU.WEAPONFRAME) c.weaponFrame = r.byte();
  if (bits & SU.ARMOR) c.armor = r.byte();
  if (bits & SU.WEAPON) c.weaponModel = r.byte();
  c.health = r.short();
  c.currentAmmo = r.byte();
  c.ammo = [r.byte(), r.byte(), r.byte(), r.byte()]; // shells, nails, rockets, cells
  c.weapon = r.byte(); // active weapon
  return c;
}

/** Parse one record's messages into ops. Throws DemoError if they do not fit the record. */
export function parseMessages(data: Uint8Array): Op[] {
  const ops: Op[] = [];
  try {
    parseInto(data, ops);
  } catch (e) {
    if (e instanceof DemoError) e.message += ` (after ${ops.length} messages, last ${JSON.stringify(ops[ops.length - 1]?.k)})`;
    throw e;
  }
  return ops;
}

function parseInto(data: Uint8Array, ops: Op[]): void {
  const r = new MsgReader(data);
  while (!r.end) {
    const cmd = r.byte();
    if (cmd & 0x80) {
      // entity update; the top bit is U.SIGNAL
      let bits = cmd;
      if (bits & U.MOREBITS) bits |= r.byte() << 8;
      const e = bits & U.LONGENTITY ? r.ushort() : r.byte();
      const op: Extract<Op, { k: 'upd' }> = { k: 'upd', e, o: [undefined, undefined, undefined], a: [undefined, undefined, undefined] };
      if (bits & U.MODEL) op.model = r.byte();
      if (bits & U.FRAME) op.frame = r.byte();
      if (bits & U.COLORMAP) op.colormap = r.byte();
      if (bits & U.SKIN) op.skin = r.byte();
      if (bits & U.EFFECTS) op.effects = r.byte();
      if (bits & U.ORIGIN1) op.o[0] = r.coord();
      if (bits & U.ANGLE1) op.a[0] = r.angle();
      if (bits & U.ORIGIN2) op.o[1] = r.coord();
      if (bits & U.ANGLE2) op.a[1] = r.angle();
      if (bits & U.ORIGIN3) op.o[2] = r.coord();
      if (bits & U.ANGLE3) op.a[2] = r.angle();
      ops.push(op);
      continue;
    }
    switch (cmd) {
      case SVC.nop: break;
      case SVC.disconnect: ops.push({ k: 'end' }); return;
      case SVC.updatestat: r.byte(); r.long(); break;
      case SVC.version: { const v = r.long(); if (v !== 15) throw new DemoError(`protocol ${v} (only 15 is supported)`); break; }
      case SVC.setview: r.ushort(); break;
      case SVC.sound: {
        const mask = r.byte();
        if (mask & 1) r.byte();
        if (mask & 2) r.byte();
        r.ushort(); r.byte(); r.coord(); r.coord(); r.coord();
        break;
      }
      case SVC.time: ops.push({ k: 'time', v: r.float() }); break;
      case SVC.print: ops.push({ k: 'print', s: r.string() }); break;
      case SVC.stufftext: r.string(); break;
      case SVC.setangle: r.angle(); r.angle(); r.angle(); break;
      case SVC.serverinfo: {
        const proto = r.long();
        if (proto !== 15) throw new DemoError(`serverinfo protocol ${proto}`);
        r.byte(); r.byte();
        r.string(); // level title, e.g. "the Necropolis"
        const models = [''];
        for (;;) { const s = r.string(); if (!s) break; models.push(s); }
        const sounds = [''];
        for (;;) { const s = r.string(); if (!s) break; sounds.push(s); }
        // the map file is the first model: "maps/e1m1.bsp"
        const map = (models[1] ?? '').replace(/^maps\//, '').replace(/\.bsp$/, '');
        ops.push({ k: 'serverinfo', map, models, sounds });
        break;
      }
      case SVC.lightstyle: { const i = r.byte(); ops.push({ k: 'light', i, s: r.string() }); break; }
      case SVC.updatename: r.byte(); r.string(); break;
      case SVC.updatefrags: r.byte(); r.short(); break;
      case SVC.clientdata: ops.push({ k: 'client', c: readClientData(r) }); break;
      case SVC.stopsound: r.ushort(); break;
      case SVC.updatecolors: r.byte(); r.byte(); break;
      case SVC.particle: {
        const org = [r.coord(), r.coord(), r.coord()];
        const dir = [r.char() / 16, r.char() / 16, r.char() / 16];
        const count = r.byte();
        const color = r.byte();
        ops.push({ k: 'particle', org, dir, color, count });
        break;
      }
      case SVC.damage: r.byte(); r.byte(); r.coord(); r.coord(); r.coord(); break;
      case SVC.spawnstatic: case SVC.spawnbaseline: {
        const e = cmd === SVC.spawnbaseline ? r.ushort() : -1;
        const model = r.byte(), frame = r.byte(), colormap = r.byte(), skin = r.byte();
        const origin = [0, 0, 0], angles = [0, 0, 0];
        for (let i = 0; i < 3; i++) { origin[i] = r.coord(); angles[i] = r.angle(); }
        if (cmd === SVC.spawnbaseline) {
          ops.push({ k: 'base', e, st: { model, frame, colormap, skin, effects: 0, origin, angles } });
        } else {
          ops.push({ k: 'static', model, frame, skin, origin, angles });
        }
        break;
      }
      case SVC.temp_entity: {
        const t = r.byte();
        let a: number[];
        if (t === 5 || t === 6 || t === 9) { // lightning: entity, start, end
          const ent = r.ushort();
          a = [ent, r.coord(), r.coord(), r.coord(), r.coord(), r.coord(), r.coord()];
        } else if (t === 12) { // explosion2: position, colour range
          a = [r.coord(), r.coord(), r.coord()];
          r.byte(); r.byte();
        } else if (t >= 0 && t <= 11) {
          a = [r.coord(), r.coord(), r.coord()];
        } else throw new DemoError(`temp entity ${t}`);
        ops.push({ k: 'temp', t, a });
        break;
      }
      case SVC.setpause: r.byte(); break;
      case SVC.signonnum: r.byte(); break;
      case SVC.centerprint: ops.push({ k: 'center', s: r.string() }); break;
      case SVC.killedmonster: case SVC.foundsecret: break;
      case SVC.spawnstaticsound: r.coord(); r.coord(); r.coord(); r.byte(); r.byte(); r.byte(); break;
      case SVC.intermission: break;
      case SVC.finale: r.string(); break;
      case SVC.cdtrack: r.byte(); r.byte(); break;
      case SVC.sellscreen: break;
      case SVC.cutscene: r.string(); break;
      default: throw new DemoError(`unknown server message ${cmd} at byte ${r.p - 1}`);
    }
  }
}

/** Split a .dem file into records and parse each one. */
export function parseDemo(buf: ArrayBuffer): DemoRecord[] {
  const b = new Uint8Array(buf);
  let p = 0;
  while (p < b.length && b[p] !== 10) p++; // "cd track" line
  p++;
  const dv = new DataView(buf);
  const recs: DemoRecord[] = [];
  let time = 0;
  while (p + 16 <= b.length) {
    const len = dv.getInt32(p, true);
    p += 4;
    if (len < 0 || p + 12 + len > b.length) break;
    const angles = [dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true)];
    p += 12;
    const data = b.subarray(p, p + len);
    p += len;
    const ops = parseMessages(data);
    for (const op of ops) if (op.k === 'time') time = op.v;
    recs.push({ time, angles, ops });
  }
  return recs;
}

export interface DemoSink {
  print(s: string): void;
  centerprint(s: string): void;
  lightstyle(i: number, s: string): void;
  particle(org: number[], dir: number[], color: number, count: number): void;
  temp(t: number, a: number[]): void;
  staticEntity(st: StaticEnt): void;
  view(angles: number[]): void;
}

/** Plays parsed records against a Server: the world, entity state and the view. */
export class DemoPlayer {
  private recs: DemoRecord[];
  private cur = -1; // index of the record the server currently holds
  private clock = 0;
  private worldLoaded = false;
  private ents = new Map<number, EntState>();
  private names = new Map<string, number>();

  constructor(private sv: Server, private sink: DemoSink, buf: ArrayBuffer) {
    this.recs = parseDemo(buf);
    if (!this.recs.length) throw new DemoError('demo has no records');
  }

  get records() { return this.recs.length; }

  /** Apply the first record's serverinfo so the world exists before rendering starts. */
  loadWorld(): void {
    const sv = this.sv;
    const info = this.recs[0].ops.find((o): o is Extract<Op, { k: 'serverinfo' }> => o.k === 'serverinfo');
    if (!info) throw new DemoError('demo does not start with serverinfo');
    const buf = sv.loadBsp(info.map);
    if (!buf) throw new DemoError('map ' + info.map + ' is not in the PAK');
    sv.bsp = new Bsp(buf);
    sv.mapName = info.map;
    sv.models = info.models;
    sv.modelBsp = info.models.map(() => null);
    sv.sounds = info.sounds;
    sv.numEdicts = 2;
    sv.free = [];
    sv.free[0] = false;
    sv.free[1] = false;
    sv.lightstyles.fill('');
    this.worldLoaded = true;
    this.clock = this.recs[0].time;
  }

  private strIndex(name: string): number {
    let i = this.names.get(name);
    if (i === undefined) {
      i = this.sv.vm.newString(name);
      this.names.set(name, i);
    }
    return i;
  }

  private edict(e: number) {
    const sv = this.sv;
    if (e >= sv.vm.maxEdicts) return false;
    if (e >= sv.numEdicts) sv.numEdicts = e + 1;
    sv.free[e] = false;
    return true;
  }

  private write(e: number, st: EntState) {
    const sv = this.sv;
    if (!this.edict(e)) return;
    const name = st.model ? sv.models[st.model] ?? '' : '';
    sv.iset(e, 'model', name ? this.strIndex(name) : 0);
    sv.fset(e, 'modelindex', st.model);
    sv.fset(e, 'frame', st.frame);
    sv.fset(e, 'skin', st.skin);
    sv.fset(e, 'colormap', st.colormap);
    sv.fset(e, 'effects', st.effects);
    sv.vset(e, 'origin', st.origin);
    sv.vset(e, 'angles', st.angles);
  }

  private applyClient(c: ClientData) {
    const sv = this.sv;
    const e = 1;
    if (!this.edict(e)) return;
    sv.vset(e, 'view_ofs', [0, 0, c.viewHeight]);
    sv.vset(e, 'velocity', c.velocity);
    sv.vset(e, 'punchangle', c.punch);
    sv.fset(e, 'health', c.health);
    sv.fset(e, 'items', c.items);
    sv.fset(e, 'armorvalue', c.armor);
    sv.fset(e, 'weaponframe', c.weaponFrame);
    sv.fset(e, 'weapon', c.weapon);
    sv.fset(e, 'ammo_shells', c.ammo[0]);
    sv.fset(e, 'ammo_nails', c.ammo[1]);
    sv.fset(e, 'ammo_rockets', c.ammo[2]);
    sv.fset(e, 'ammo_cells', c.ammo[3]);
    sv.fset(e, 'currentammo', c.currentAmmo);
    const wm = c.weaponModel ? sv.models[c.weaponModel] ?? '' : '';
    sv.iset(e, 'weaponmodel', wm ? this.strIndex(wm) : 0);
    sv.fset(e, 'flags', ((sv.fget(e, 'flags') | 0) & ~512) | (c.onGround ? 512 : 0));
  }

  private apply(rec: DemoRecord): boolean {
    const sv = this.sv;
    sv.time = rec.time;
    for (const op of rec.ops) {
      switch (op.k) {
        case 'serverinfo': break; // the world was loaded by loadWorld()
        case 'time': break;
        case 'end': return false;
        case 'print': this.sink.print(op.s); break;
        case 'center': this.sink.centerprint(op.s); break;
        case 'light': this.sv.lightstyles[op.i] = op.s; this.sink.lightstyle(op.i, op.s); break;
        case 'particle': this.sink.particle(op.org, op.dir, op.color, op.count); break;
        case 'temp': this.sink.temp(op.t, op.a); break;
        case 'static': {
          const name = this.sv.models[op.model] ?? '';
          const st: StaticEnt = { model: name, frame: op.frame, skin: op.skin, origin: op.origin, angles: op.angles, effects: 0 };
          this.sink.staticEntity(st);
          break;
        }
        case 'base': this.ents.set(op.e, { ...op.st }); this.write(op.e, op.st); break;
        case 'upd': {
          const st = this.ents.get(op.e) ?? { model: 0, frame: 0, colormap: 0, skin: 0, effects: 0, origin: [0, 0, 0], angles: [0, 0, 0] };
          if (op.model !== undefined) st.model = op.model;
          if (op.frame !== undefined) st.frame = op.frame;
          if (op.colormap !== undefined) st.colormap = op.colormap;
          if (op.skin !== undefined) st.skin = op.skin;
          if (op.effects !== undefined) st.effects = op.effects;
          for (let i = 0; i < 3; i++) {
            if (op.o[i] !== undefined) st.origin[i] = op.o[i]!;
            if (op.a[i] !== undefined) st.angles[i] = op.a[i]!;
          }
          this.ents.set(op.e, st);
          this.write(op.e, st);
          break;
        }
        case 'client': this.applyClient(op.c); break;
      }
    }
    return true;
  }

  /**
   * Advance playback by dt seconds. Returns false when the demo has ended.
   * The server holds the record after the render time and keeps the one before it as a
   * snapshot, so positions and view angles blend smoothly between the two.
   */
  advance(dt: number): boolean {
    if (!this.worldLoaded) return false;
    this.clock += dt;
    const R = this.clock;
    const recs = this.recs;
    if (this.cur < 0) {
      this.cur = 0;
      this.apply(recs[0]);
    }
    while (this.cur + 1 < recs.length && recs[this.cur].time <= R) {
      this.cur++;
      this.sv.netSnapshot();
      if (!this.apply(recs[this.cur])) return false;
    }
    if (this.cur === recs.length - 1 && R >= recs[this.cur].time) return false;
    const a = this.cur > 0 ? recs[this.cur - 1] : recs[this.cur];
    const b = recs[this.cur];
    const span = b.time - a.time;
    const t = span > 0 ? Math.min(1, Math.max(0, (R - a.time) / span)) : 1;
    this.sv.netMode = true;
    this.sv.netAlpha = t;
    const ang = [0, 1, 2].map((i) => {
      const d = ((((b.angles[i] - a.angles[i]) % 360) + 540) % 360) - 180; // shortest way round
      return a.angles[i] + d * t;
    });
    this.sink.view(ang);
    return true;
  }
}
