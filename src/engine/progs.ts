// QuakeC bytecode interpreter (progs.dat version 6).

export const OFS_RETURN = 1;
export const OFS_PARM0 = 4;
export const RESERVED_OFS = 28;

export interface FuncDef {
  first: number;
  parmStart: number;
  locals: number;
  name: string;
  numParms: number;
  parmSize: number[];
}
export interface Def {
  type: number;
  ofs: number;
  name: string;
}

export type Builtin = (vm: Progs) => void;

const MAX_STACK = 32;

export class Progs {
  opc!: Uint16Array;
  sa!: Int16Array;
  sb!: Int16Array;
  sc!: Int16Array;
  globalDefs: Def[] = [];
  fieldDefs: Def[] = [];
  functions: FuncDef[] = [];
  strBytes!: Uint8Array;
  strCache = new Map<number, string>();
  dynStrings: string[] = [];
  gF!: Float32Array;
  gI!: Int32Array;
  numGlobals = 0;
  entityFields = 0;
  maxEdicts = 768;
  evF!: Float32Array;
  evI!: Int32Array;
  globalOfs = new Map<string, number>();
  fieldOfs = new Map<string, number>();
  funcByName = new Map<string, number>();
  builtinsByName = new Map<string, Builtin>();
  fnBuiltin: (Builtin | null)[] = [];
  argc = 0;
  stack: { s: number; f: FuncDef | null }[] = [];
  localStack: number[] = [];
  depth = 0;
  xfunction: FuncDef | null = null;
  trace = false;
  onError: (msg: string) => void = (m) => {
    throw new Error(m);
  };

  constructor(buf: ArrayBuffer) {
    const dv = new DataView(buf);
    if (dv.getInt32(0, true) !== 6) throw new Error('progs.dat: unsupported version');
    const h = (i: number) => dv.getInt32(i * 4, true);
    const ofsStatements = h(2), numStatements = h(3);
    const ofsGlobalDefs = h(4), numGlobalDefs = h(5);
    const ofsFieldDefs = h(6), numFieldDefs = h(7);
    const ofsFunctions = h(8), numFunctions = h(9);
    const ofsStrings = h(10), numStrings = h(11);
    const ofsGlobals = h(12), numGlobals = h(13);
    this.entityFields = h(14);
    this.numGlobals = numGlobals;
    this.strBytes = new Uint8Array(buf.slice(ofsStrings, ofsStrings + numStrings));

    this.opc = new Uint16Array(numStatements);
    this.sa = new Int16Array(numStatements);
    this.sb = new Int16Array(numStatements);
    this.sc = new Int16Array(numStatements);
    for (let i = 0; i < numStatements; i++) {
      const o = ofsStatements + i * 8;
      this.opc[i] = dv.getUint16(o, true);
      this.sa[i] = dv.getInt16(o + 2, true);
      this.sb[i] = dv.getInt16(o + 4, true);
      this.sc[i] = dv.getInt16(o + 6, true);
    }
    const readDefs = (ofs: number, n: number) => {
      const out: Def[] = [];
      for (let i = 0; i < n; i++) {
        const o = ofs + i * 8;
        out.push({ type: dv.getUint16(o, true) & 0x7fff, ofs: dv.getUint16(o + 2, true), name: this.str(dv.getInt32(o + 4, true)) });
      }
      return out;
    };
    this.globalDefs = readDefs(ofsGlobalDefs, numGlobalDefs);
    this.fieldDefs = readDefs(ofsFieldDefs, numFieldDefs);
    for (const d of this.globalDefs) this.globalOfs.set(d.name, d.ofs);
    for (const d of this.fieldDefs) this.fieldOfs.set(d.name, d.ofs);
    for (let i = 0; i < numFunctions; i++) {
      const o = ofsFunctions + i * 36;
      const np = dv.getInt32(o + 24, true);
      const ps: number[] = [];
      for (let k = 0; k < 8; k++) ps.push(dv.getUint8(o + 28 + k));
      const fd: FuncDef = {
        first: dv.getInt32(o, true),
        parmStart: dv.getInt32(o + 4, true),
        locals: dv.getInt32(o + 8, true),
        name: this.str(dv.getInt32(o + 16, true)),
        numParms: np,
        parmSize: ps,
      };
      this.functions.push(fd);
      if (fd.name && !this.funcByName.has(fd.name)) this.funcByName.set(fd.name, i);
    }
    this.fnBuiltin = new Array(numFunctions).fill(null);
    const gbuf = new ArrayBuffer(numGlobals * 4);
    this.gF = new Float32Array(gbuf);
    this.gI = new Int32Array(gbuf);
    const src = new Uint8Array(buf, ofsGlobals, numGlobals * 4);
    new Uint8Array(gbuf).set(src);
    this.allocEdicts();
  }

  allocEdicts() {
    const ebuf = new ArrayBuffer(this.maxEdicts * this.entityFields * 4);
    this.evF = new Float32Array(ebuf);
    this.evI = new Int32Array(ebuf);
  }

  // ---- strings ----
  str(ofs: number): string {
    if (ofs >= this.strBytes.length) return this.dynStrings[ofs - this.strBytes.length] ?? '';
    if (ofs < 0) return '';
    let s = this.strCache.get(ofs);
    if (s !== undefined) return s;
    s = '';
    for (let i = ofs; i < this.strBytes.length && this.strBytes[i] !== 0; i++) s += String.fromCharCode(this.strBytes[i]);
    this.strCache.set(ofs, s);
    return s;
  }
  newString(s: string): number {
    this.dynStrings.push(s);
    return this.strBytes.length + this.dynStrings.length - 1;
  }

  resolveBuiltins() {
    for (let i = 0; i < this.functions.length; i++) {
      const f = this.functions[i];
      if (f.first < 0) {
        const b = this.builtinsByName.get(f.name);
        this.fnBuiltin[i] = b ?? ((vm: Progs) => vm.onError('unimplemented builtin ' + f.name + ' (#' + -f.first + ')'));
      }
    }
  }

  // ---- helpers for builtins ----
  fparm(i: number) { return this.gF[OFS_PARM0 + i * 3]; }
  iparm(i: number) { return this.gI[OFS_PARM0 + i * 3]; }
  vparm(i: number, out: number[] = [0, 0, 0]) {
    const o = OFS_PARM0 + i * 3;
    out[0] = this.gF[o]; out[1] = this.gF[o + 1]; out[2] = this.gF[o + 2];
    return out;
  }
  sparm(i: number) { return this.str(this.gI[OFS_PARM0 + i * 3]); }
  retF(v: number) { this.gF[OFS_RETURN] = v; }
  retI(v: number) { this.gI[OFS_RETURN] = v; }
  retV(x: number, y: number, z: number) { this.gF[OFS_RETURN] = x; this.gF[OFS_RETURN + 1] = y; this.gF[OFS_RETURN + 2] = z; }
  retS(s: string) { this.gI[OFS_RETURN] = this.newString(s); }

  gOfs(name: string) {
    const o = this.globalOfs.get(name);
    if (o === undefined) throw new Error('missing global ' + name);
    return o;
  }
  fOfs(name: string) {
    const o = this.fieldOfs.get(name);
    if (o === undefined) throw new Error('missing field ' + name);
    return o;
  }

  private enterFunction(f: FuncDef, s: number): number {
    if (this.depth >= MAX_STACK) this.onError('stack overflow');
    this.stack[this.depth] = { s, f: this.xfunction };
    this.depth++;
    const c = f.locals;
    for (let i = 0; i < c; i++) this.localStack.push(this.gI[f.parmStart + i]);
    let o = f.parmStart;
    for (let i = 0; i < f.numParms; i++) {
      for (let j = 0; j < f.parmSize[i]; j++) this.gI[o++] = this.gI[OFS_PARM0 + i * 3 + j];
    }
    this.xfunction = f;
    return f.first - 1;
  }
  private leaveFunction(): number {
    if (this.depth <= 0) this.onError('prog stack underflow');
    const f = this.xfunction!;
    const c = f.locals;
    for (let i = c - 1; i >= 0; i--) this.gI[f.parmStart + i] = this.localStack.pop()!;
    this.depth--;
    const fr = this.stack[this.depth];
    this.xfunction = fr.f;
    return fr.s;
  }

  /** Execute a progs function by number. Globals self/other/etc. must be set up by caller. */
  execute(fnum: number) {
    if (fnum <= 0 || fnum >= this.functions.length) {
      this.onError('execute: bad function number ' + fnum);
      return;
    }
    const f = this.functions[fnum];
    if (f.first < 0) {
      this.argc = 0;
      this.fnBuiltin[fnum]!(this);
      return;
    }
    const exitDepth = this.depth;
    const gF = this.gF, gI = this.gI;
    const opc = this.opc, sa = this.sa, sb = this.sb, sc = this.sc;
    const nf = this.entityFields;
    let s = this.enterFunction(f, -1);
    let count = 0;
    for (;;) {
      s++;
      if (++count > 2000000) {
        this.onError('runaway loop error');
        return;
      }
      const a = sa[s], b = sb[s], c = sc[s];
      switch (opc[s]) {
        case 0: // DONE
        case 43: // RETURN
          gI[OFS_RETURN] = gI[a];
          gI[OFS_RETURN + 1] = gI[a + 1];
          gI[OFS_RETURN + 2] = gI[a + 2];
          s = this.leaveFunction();
          if (this.depth === exitDepth) return;
          break;
        case 1: gF[c] = gF[a] * gF[b]; break;
        case 2: gF[c] = gF[a] * gF[b] + gF[a + 1] * gF[b + 1] + gF[a + 2] * gF[b + 2]; break;
        case 3: { const k = gF[a]; gF[c] = k * gF[b]; gF[c + 1] = k * gF[b + 1]; gF[c + 2] = k * gF[b + 2]; break; }
        case 4: { const k = gF[b]; gF[c] = k * gF[a]; gF[c + 1] = k * gF[a + 1]; gF[c + 2] = k * gF[a + 2]; break; }
        case 5: gF[c] = gF[a] / gF[b]; break;
        case 6: gF[c] = gF[a] + gF[b]; break;
        case 7: gF[c] = gF[a] + gF[b]; gF[c + 1] = gF[a + 1] + gF[b + 1]; gF[c + 2] = gF[a + 2] + gF[b + 2]; break;
        case 8: gF[c] = gF[a] - gF[b]; break;
        case 9: gF[c] = gF[a] - gF[b]; gF[c + 1] = gF[a + 1] - gF[b + 1]; gF[c + 2] = gF[a + 2] - gF[b + 2]; break;
        case 10: gF[c] = gF[a] === gF[b] ? 1 : 0; break;
        case 11: gF[c] = gF[a] === gF[b] && gF[a + 1] === gF[b + 1] && gF[a + 2] === gF[b + 2] ? 1 : 0; break;
        case 12: gF[c] = this.str(gI[a]) === this.str(gI[b]) ? 1 : 0; break;
        case 13: case 14: gF[c] = gI[a] === gI[b] ? 1 : 0; break;
        case 15: gF[c] = gF[a] !== gF[b] ? 1 : 0; break;
        case 16: gF[c] = gF[a] !== gF[b] || gF[a + 1] !== gF[b + 1] || gF[a + 2] !== gF[b + 2] ? 1 : 0; break;
        case 17: gF[c] = this.str(gI[a]) !== this.str(gI[b]) ? 1 : 0; break;
        case 18: case 19: gF[c] = gI[a] !== gI[b] ? 1 : 0; break;
        case 20: gF[c] = gF[a] <= gF[b] ? 1 : 0; break;
        case 21: gF[c] = gF[a] >= gF[b] ? 1 : 0; break;
        case 22: gF[c] = gF[a] < gF[b] ? 1 : 0; break;
        case 23: gF[c] = gF[a] > gF[b] ? 1 : 0; break;
        case 24: case 26: case 27: case 28: case 29: { // LOAD_F/S/ENT/FLD/FNC
          const e = gI[a];
          if (e < 0 || e >= this.maxEdicts) { this.onError('load from bad entity ' + e); return; }
          gI[c] = this.evI[e * nf + gI[b]];
          break;
        }
        case 25: { // LOAD_V
          const e = gI[a];
          if (e < 0 || e >= this.maxEdicts) { this.onError('load from bad entity ' + e); return; }
          const p = e * nf + gI[b];
          gI[c] = this.evI[p]; gI[c + 1] = this.evI[p + 1]; gI[c + 2] = this.evI[p + 2];
          break;
        }
        case 30: { // ADDRESS
          const e = gI[a];
          if (e < 0 || e >= this.maxEdicts) { this.onError('address of bad entity ' + e); return; }
          gI[c] = e * nf + gI[b];
          break;
        }
        case 31: case 33: case 34: case 35: case 36: gI[b] = gI[a]; break;
        case 32: gI[b] = gI[a]; gI[b + 1] = gI[a + 1]; gI[b + 2] = gI[a + 2]; break;
        case 37: case 39: case 40: case 41: case 42: this.evI[gI[b]] = gI[a]; break;
        case 38: { const p = gI[b]; this.evI[p] = gI[a]; this.evI[p + 1] = gI[a + 1]; this.evI[p + 2] = gI[a + 2]; break; }
        case 44: gF[c] = gF[a] ? 0 : 1; break;
        case 45: gF[c] = gF[a] || gF[a + 1] || gF[a + 2] ? 0 : 1; break;
        case 46: gF[c] = !gI[a] || this.str(gI[a]) === '' ? 1 : 0; break;
        case 47: gF[c] = gI[a] === 0 ? 1 : 0; break;
        case 48: gF[c] = gI[a] === 0 ? 1 : 0; break;
        case 49: if (gI[a]) s += b - 1; break;
        case 50: if (!gI[a]) s += b - 1; break;
        case 51: case 52: case 53: case 54: case 55: case 56: case 57: case 58: case 59: {
          this.argc = opc[s] - 51;
          const fnum = gI[a];
          if (fnum <= 0 || fnum >= this.functions.length) { this.onError('NULL function called'); return; }
          const nfn = this.functions[fnum];
          if (nfn.first < 0) {
            this.fnBuiltin[fnum]!(this);
          } else {
            s = this.enterFunction(nfn, s);
          }
          break;
        }
        case 60: { // STATE
          const self = gI[this.gSelf];
          const p = self * nf;
          this.evF[p + this.fNextthink] = gF[this.gTime] + 0.1;
          this.evF[p + this.fFrame] = gF[a];
          this.evI[p + this.fThink] = gI[b];
          break;
        }
        case 61: s += a - 1; break;
        case 62: gF[c] = gF[a] && gF[b] ? 1 : 0; break;
        case 63: gF[c] = gF[a] || gF[b] ? 1 : 0; break;
        case 64: gF[c] = (gF[a] | 0) & (gF[b] | 0); break;
        case 65: gF[c] = (gF[a] | 0) | (gF[b] | 0); break;
        default:
          this.onError('Bad opcode ' + opc[s]);
          return;
      }
    }
  }

  gSelf = 0;
  gTime = 0;
  fNextthink = 0;
  fFrame = 0;
  fThink = 0;
  cacheOffsets() {
    this.gSelf = this.gOfs('self');
    this.gTime = this.gOfs('time');
    this.fNextthink = this.fOfs('nextthink');
    this.fFrame = this.fOfs('frame');
    this.fThink = this.fOfs('think');
  }
}
