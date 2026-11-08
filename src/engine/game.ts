// Client side: input, view calculation, HUD, menus, effects and game flow.
import { NetSession } from './net';
import { Assets } from './assets';
import { GameRenderer, DLight, Particle } from './renderer';
import { SoundSystem } from './sound';
import { Server, UserCmd, angleVectors, calcRoll } from './server';

type MenuPage = 'main' | 'single' | 'options' | 'help' | 'quit' | 'multi' | 'saveload' | null;
type State = 'title' | 'loading' | 'playing' | 'finale';

const IT = { SHOTGUN: 1, SSHOTGUN: 2, NAILGUN: 4, SNAILGUN: 8, GLAUNCHER: 16, RLAUNCHER: 32, LIGHTNING: 64, SHELLS: 256, NAILS: 512, ROCKETS: 1024, CELLS: 2048, ARMOR1: 8192, ARMOR2: 16384, ARMOR3: 32768, INVIS: 524288, INVULN: 1048576, SUIT: 2097152, QUAD: 4194304 };
const RAMP1 = [0x6f, 0x6d, 0x6b, 0x69, 0x67, 0x65, 0x63, 0x61];
const RAMP2 = [0x6f, 0x6e, 0x6d, 0x6c, 0x6b, 0x6a, 0x68, 0x66];
const RAMP3 = [0x6d, 0x6b, 6, 5, 4, 3];
const rnd = (n: number) => Math.random() * n;

interface Transient { org: number[]; radius: number; die: number; decay: number; born: number }

export class Game {
  assets: Assets;
  rend: GameRenderer;
  /** The player entity this screen follows (1 unless joined to a co-op host). */
  viewEnt = 1;
  snd: SoundSystem;
  hud: CanvasRenderingContext2D;
  sv: Server | null = null;
  state: State = 'title';
  menu: MenuPage = 'main';
  menuCursor: Record<string, number> = { main: 0, single: 0, options: 1, saveload: 0 };
  helpPage = 0;
  menuMsg = '';
  menuMsgUntil = 0;
  paused = false;
  keys = new Set<string>();
  mouseButtons = 0;
  // Touch devices never get pointer lock, so look and fire must not wait for it.
  touchMode = false;
  viewAngles: [number, number, number] = [0, 0, 0];
  cmd: UserCmd = { forward: 0, side: 0, up: 0, buttons: 0, impulse: 0, angles: [0, 0, 0] };
  sens = 3;
  alwaysRun = true;
  invertMouse = false;
  brightness = 1;
  fovScale = 1;
  hudStyle: 'classic' | 'minimal' = 'minimal';
  W = 640;
  H = 480;
  now = 0;
  last = 0;
  raf = 0;
  levelReady = false;
  loadMap: string | null = null;
  // client fx state
  trans: Transient[] = [];
  lastOrigin = new Map<number, number[]>();
  cshift = { dmg: 0, bonus: 0, dmgColor: [255, 0, 0] };
  dmgPitch = 0;
  dmgRoll = 0;
  dmgTime = 0;
  oldZ = 0;
  oldTime = 0;
  bob = 0;
  faceAnimUntil = 0;
  lastHealth = 100;
  inter = false;
  interTime = 0;
  intermissionAt = 0;
  finaleText = '';
  finaleStart = 0;
  con: { text: string; time: number }[] = [];
  conLine = '';
  center = { text: '', until: 0 };
  ambientQueue: { org: number[]; name: string; vol: number; attn: number }[] = [];
  ambientStarted = false;
  onQuit: () => void = () => {};
  onStatus: (s: string) => void = () => {};
  clientTime = 0;
  saves: (string | null)[] = new Array(8).fill(null);
  // Automatic save: written when a map starts and every 60 s while alive.
  autoRaw: string | null = null;
  // Co-op over the network (see net.ts). Singleplayer leaves this null.
  net: NetSession | null = null;
  onCoop: (() => void) | null = null;
  lastAuto = 0;
  currentMap = '';
  deadAt = 0;

  constructor(public glCanvas: HTMLCanvasElement, public hudCanvas: HTMLCanvasElement, assets: Assets) {
    this.assets = assets;
    this.rend = new GameRenderer(glCanvas, assets);
    this.snd = new SoundSystem(assets.pak);
    this.hud = hudCanvas.getContext('2d')!;
    try {
      const s = JSON.parse(localStorage.getItem('quakejs.opts') || '{}');
      if (typeof s.sens === 'number') this.sens = s.sens;
      if (typeof s.alwaysRun === 'boolean') this.alwaysRun = s.alwaysRun;
      if (typeof s.invert === 'boolean') this.invertMouse = s.invert;
      if (typeof s.vol === 'number') this.snd.volume = s.vol;
      if (typeof s.bright === 'number') this.brightness = s.bright;
      if (s.hud === 'classic' || s.hud === 'minimal') this.hudStyle = s.hud;
      for (let i = 0; i < 8; i++) this.saves[i] = localStorage.getItem('quakejs.save' + i);
      this.autoRaw = localStorage.getItem('quakejs.auto');
    } catch { /* ignore */ }
    this.applyBrightness();
  }

  saveOpts() {
    try {
      localStorage.setItem('quakejs.opts', JSON.stringify({ sens: this.sens, alwaysRun: this.alwaysRun, invert: this.invertMouse, vol: this.snd.volume, bright: this.brightness, hud: this.hudStyle }));
    } catch { /* ignore */ }
  }
  applyBrightness() {
    this.glCanvas.style.filter = `brightness(${this.brightness})`;
  }

  // ------------------------------------------------------------ lifecycle
  start() {
    this.last = performance.now();
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      this.frame(t);
    };
    this.raf = requestAnimationFrame(loop);
  }
  destroy() {
    cancelAnimationFrame(this.raf);
    this.snd.stopAll();
    if (document.pointerLockElement) document.exitPointerLock();
    this.rend.renderer.dispose();
  }
  resize(w: number, h: number) {
    this.W = Math.max(320, Math.floor(w));
    this.H = Math.max(200, Math.floor(h));
    this.rend.setSize(this.W, this.H);
    this.hudCanvas.width = this.W;
    this.hudCanvas.height = this.H;
  }

  // ------------------------------------------------------------ level flow
  private makeServer() {
    const progs = this.assets.pak.getBuffer('progs.dat');
    if (!progs) throw new Error('progs.dat missing from PAK');
    const sv = new Server(progs, (n) => this.assets.bsp(n));
    this.wire(sv);
    (globalThis as any).__game = this;
    return sv;
  }

  private wire(sv: Server) {
    sv.ev = {
      sound: (e, ch, name, vol, attn, org) => {
        // Item pickups play items/*.wav; log them so pickups show in the console.
        if (name.startsWith('items/')) console.log(`[qinreact] pickup sound ${name}`);
        this.snd.play(e, ch, name, vol, attn, org);
      },
      ambient: (org, name, vol, attn) => {
        this.ambientQueue.push({ org, name, vol, attn });
      },
      print: (s) => this.conPrint(s),
      centerprint: (s) => {
        console.log(`[qinreact] center: ${s.replace(/\n/g, ' / ')}`);
        this.center = { text: s, until: this.now + 2000 };
      },
      lightstyle: (i, s) => this.rend.setLightstyle(i, s),
      particle: (org, dir, color, count) => (count >= 255 ? this.particleExplosion(org) : this.runParticles(org, dir, color, count)),
      temp: (t, a) => this.tempEntity(t, a),
      intermission: () => {
        console.log('[qinreact] intermission');
        this.inter = true;
        this.interTime = sv.time;
        this.intermissionAt = this.now;
        if (document.pointerLockElement) document.exitPointerLock();
      },
      finale: (text) => {
        this.state = 'finale';
        this.finaleText = text;
        this.finaleStart = this.now;
        if (document.pointerLockElement) document.exitPointerLock();
      },
      stuffcmd: (s) => this.stuffcmd(s),
      damage: (save, take, from) => this.onDamage(save, take, from),
      makeStatic: (st) => {
        sv.statics.push(st);
        if (this.levelReady) this.rend.addStatic(st);
      },
      setAngles: (a) => {
        this.viewAngles = [a[0], a[1], 0];
      },
      error: (m) => this.conPrint('\x01' + m + '\n'),
    };
  }

  queued: { map: string; newGame: boolean; wait: number } | null = null;

  newGame() {
    this.menu = null;
    this.paused = false;
    this.sv = this.makeServer();
    this.sv.serverFlags = 0;
    this.queueLevel('start', true);
  }

  /** Show the loading plaque for a frame, then load. */
  queueLevel(map: string, newGame: boolean) {
    this.state = 'loading';
    this.queued = { map, newGame, wait: 2 };
  }

  startLevel(map: string, newGame: boolean) {
    const sv = this.sv!;
    this.state = 'loading';
    this.conLine = '';
    this.levelReady = false;
    this.inter = false;
    this.trans = [];
    this.lastOrigin.clear();
    this.ambientQueue = [];
    this.snd.stopAll();
    this.ambientStarted = false;
    this.cshift.dmg = 0;
    this.cshift.bonus = 0;
    this.dmgTime = 0;
    this.keys.clear();
    this.cmd.impulse = 0;
    try {
      if (!newGame) sv.saveSpawnParms();
      sv.spawnLevel(map);
      sv.connectClient(newGame);
      this.rend.loadLevel(sv);
      for (const s of sv.statics) this.rend.addStatic(s);
      this.levelReady = true;
      this.lastHealth = sv.fget(this.viewEnt, 'health');
      const a = sv.vget(this.viewEnt, 'angles');
      this.viewAngles = [a[0], a[1], 0];
      this.state = 'playing';
      console.log(`[qinreact] loaded map ${map} (${sv.numEdicts} edicts, ${sv.statics.length} static entities, newGame=${newGame})`);
      this.oldZ = sv.vget(this.viewEnt, 'origin')[2];
      this.currentMap = map;
      this.deadAt = 0;
      this.lastAuto = this.now;
      this.autosave();
      this.onStatus('');
    } catch (e) {
      console.error('[qinreact] failed to load map', map, e);
      this.conPrint('\x01Could not load map ' + map + ': ' + (e as Error).message + '\n');
      if (map !== 'start') {
        this.startLevel('start', true);
      } else {
        this.state = 'title';
        this.menu = 'main';
      }
    }
  }

  // ------------------------------------------------------------ input
  onKeyDown(ev: KeyboardEvent): boolean {
    this.snd.resume();
    const k = ev.code;
    if (this.menu || this.state === 'title') {
      this.menuKey(ev);
      return true;
    }
    if (this.state === 'finale') {
      if (this.now - this.finaleStart > 1500 && (k === 'Space' || k === 'Enter' || k === 'Escape')) this.exitToTitle();
      return true;
    }
    if (k === 'Escape') {
      this.menu = 'main';
      if (document.pointerLockElement) document.exitPointerLock();
      return true;
    }
    if (k === 'KeyP' && !ev.repeat) {
      this.paused = !this.paused;
      return true;
    }
    this.keys.add(k);
    if (/^Digit[1-8]$/.test(k)) this.cmd.impulse = parseInt(k.slice(5));
    if (k === 'KeyF1') return true;
    return ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ControlLeft', 'Tab'].includes(k);
  }
  onKeyUp(ev: KeyboardEvent) {
    this.keys.delete(ev.code);
  }
  onMouseMove(dx: number, dy: number) {
    if (!this.touchMode && document.pointerLockElement !== this.glCanvas && document.pointerLockElement !== this.hudCanvas) return;
    if (this.menu || this.state !== 'playing' || this.paused) return;
    const s = this.sens * 0.022;
    this.viewAngles[1] -= dx * s;
    this.viewAngles[0] += dy * s * (this.invertMouse ? -1 : 1);
    this.clampPitch();
  }
  clampPitch() {
    if (this.viewAngles[0] > 80) this.viewAngles[0] = 80;
    if (this.viewAngles[0] < -70) this.viewAngles[0] = -70;
  }
  onMouseDown(b: number) {
    this.snd.resume();
    if (this.menu || this.state === 'title') return;
    if (this.state === 'finale') {
      if (this.now - this.finaleStart > 1500) this.exitToTitle();
      return;
    }
    if (!this.touchMode && !document.pointerLockElement && !this.inter) {
      this.hudCanvas.requestPointerLock?.();
      return;
    }
    this.mouseButtons |= 1 << b;
  }
  onMouseUp(b: number) {
    this.mouseButtons &= ~(1 << b);
  }
  onWheel(dy: number) {
    if (this.state !== 'playing' || this.menu) return;
    this.cmd.impulse = dy < 0 ? 10 : 12;
  }
  onPointerLockChange() {
    if (this.touchMode) return;
    if (!document.pointerLockElement && this.state === 'playing' && !this.menu && !this.inter) {
      this.menu = 'main';
    }
  }

  exitToTitle() {
    this.state = 'title';
    this.menu = 'main';
    this.sv = null;
    this.levelReady = false;
    this.snd.stopAll();
    this.inter = false;
    this.paused = false;
  }

  buildCmd(): UserCmd {
    const k = this.keys;
    const c = this.cmd;
    let speed = 1;
    const shift = k.has('ShiftLeft') || k.has('ShiftRight');
    if (this.alwaysRun !== shift) speed = 2;
    c.forward = ((k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0)) * 200 * speed;
    c.side = ((k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0)) * 350 * speed;
    c.up = (k.has('KeyF') ? 1 : 0) * 200 - (k.has('KeyC') ? 1 : 0) * 200;
    c.buttons = 0;
    if (k.has('ControlLeft') || k.has('ControlRight') || this.mouseButtons & 1) c.buttons |= 1;
    if (k.has('Space') || this.mouseButtons & 2) c.buttons |= 2;
    c.angles = [this.viewAngles[0], this.viewAngles[1], 0];
    return c;
  }

  // ------------------------------------------------------------ messages
  // Quake sends one message as several print calls (e.g. "You got the" + "shells"),
  // so fragments are joined until a newline or a short pause with no more output.
  private conTimer: ReturnType<typeof setTimeout> | null = null;
  conPrint(s: string) {
    for (const ch of s) {
      if (ch === '\n') this.conFlush();
      else this.conLine += ch;
    }
    if (this.conLine.trim() && this.conTimer === null) this.conTimer = setTimeout(() => this.conFlush(), 50);
  }
  conFlush() {
    if (this.conTimer !== null) {
      clearTimeout(this.conTimer);
      this.conTimer = null;
    }
    if (this.conLine.trim()) {
      console.log(`[qinreact] ${this.conLine.trim()}`);
      this.con.push({ text: this.conLine, time: this.now });
      if (this.con.length > 40) this.con.shift();
    }
    this.conLine = '';
  }

  stuffcmd(s: string) {
    for (const line of s.split('\n')) {
      const t = line.trim().split(/\s+/);
      if (t[0] === 'bf') this.cshift.bonus = 50;
      else if (t[0] === 'v_cshift') {
        // contents shifts are computed locally; ignore QC resets
      }
    }
  }

  onDamage(save: number, take: number, from: number[]) {
    const sv = this.sv!;
    let count = save * 0.5 + take * 0.5;
    if (count < 10) count = 10;
    this.cshift.dmg = Math.min(150, this.cshift.dmg + 3 * count);
    const armor = sv.fget(this.viewEnt, 'armorvalue');
    this.cshift.dmgColor = save > take && armor > 0 ? [220, 50, 50] : save > 0 ? [220, 50, 50] : [255, 0, 0];
    if (take > 0) this.cshift.dmgColor = [255, 0, 0];
    const org = sv.vget(this.viewEnt, 'origin');
    let dx = from[0] - org[0], dy = from[1] - org[1], dz = from[2] - org[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    const av = angleVectors(this.viewAngles);
    const side = dx * av.right[0] + dy * av.right[1] + dz * av.right[2];
    const fwd = dx * av.forward[0] + dy * av.forward[1] + dz * av.forward[2];
    this.dmgRoll = count * side * 0.6;
    this.dmgPitch = count * fwd * 0.6;
    this.dmgTime = 0.5;
    this.faceAnimUntil = this.now + 1000;
  }

  // ------------------------------------------------------------ particles / effects
  private P(p: Partial<Particle> & { x: number; y: number; z: number }) {
    const t = this.sv?.time ?? 0;
    this.rend.particles.push({ vx: 0, vy: 0, vz: 0, color: 0, die: t + 1, grav: 0, born: t, ...p });
  }
  runParticles(org: number[], dir: number[], color: number, count: number) {
    const t = this.sv!.time;
    for (let i = 0; i < count; i++) {
      this.P({
        x: org[0] + rnd(16) - 8, y: org[1] + rnd(16) - 8, z: org[2] + rnd(16) - 8,
        vx: dir[0] * 15, vy: dir[1] * 15, vz: dir[2] * 15,
        color: (color & ~7) + ((Math.random() * 8) | 0), die: t + 0.1 * ((Math.random() * 5) | 0) + 0.1, grav: 20,
      });
    }
  }
  particleExplosion(org: number[]) {
    const t = this.sv!.time;
    for (let i = 0; i < 300; i++) {
      const ramp = i & 1 ? RAMP1 : RAMP2;
      const start = (Math.random() * 3) | 0;
      this.P({
        x: org[0] + rnd(32) - 16, y: org[1] + rnd(32) - 16, z: org[2] + rnd(32) - 16,
        vx: rnd(512) - 256, vy: rnd(512) - 256, vz: rnd(512) - 256,
        ramp: ramp.slice(start), rate: 10, color: ramp[start], die: t + 0.8 - start * 0.1, grav: 0, born: t, size: 1.6,
      });
    }
  }
  blobExplosion(org: number[]) {
    const t = this.sv!.time;
    for (let i = 0; i < 200; i++) {
      this.P({
        x: org[0] + rnd(32) - 16, y: org[1] + rnd(32) - 16, z: org[2] + rnd(32) - 16,
        vx: rnd(128) - 64, vy: rnd(128) - 64, vz: rnd(128) - 64,
        color: i & 1 ? 66 + ((Math.random() * 6) | 0) : 150 + ((Math.random() * 6) | 0), die: t + 1 + rnd(0.4), grav: 0,
      });
    }
  }
  teleportSplash(org: number[]) {
    const t = this.sv!.time;
    for (let i = -16; i < 16; i += 4)
      for (let j = -16; j < 16; j += 4)
        for (let k = -24; k < 32; k += 4) {
          const d = [j * 8, i * 8, k * 8];
          const l = Math.hypot(d[0], d[1], d[2]) || 1;
          const v = 50 + rnd(64);
          this.P({ x: org[0] + i + rnd(4), y: org[1] + j + rnd(4), z: org[2] + k + rnd(4), vx: (d[0] / l) * v, vy: (d[1] / l) * v, vz: (d[2] / l) * v, color: 7 + ((Math.random() * 8) | 0), die: t + 0.2 + rnd(0.3), grav: 0 });
        }
  }
  lavaSplash(org: number[]) {
    const t = this.sv!.time;
    for (let i = -16; i < 16; i += 2)
      for (let j = -16; j < 16; j += 2) {
        const d = [j * 8 + rnd(8), i * 8 + rnd(8), 256];
        const l = Math.hypot(d[0], d[1], d[2]);
        const v = 50 + rnd(64);
        this.P({ x: org[0] + d[0], y: org[1] + d[1], z: org[2] + rnd(64), vx: (d[0] / l) * v, vy: (d[1] / l) * v, vz: (d[2] / l) * v, color: 224 + ((Math.random() * 8) | 0), die: t + 2 + rnd(0.64), grav: 40 });
      }
  }
  trail(from: number[], to: number[], type: number) {
    const t = this.sv!.time;
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.01 || len > 600) return;
    const step = type < 128 ? 3 : 3;
    const n = Math.min(40, Math.floor(len / step));
    for (let i = 0; i < n; i++) {
      const f = (i * step) / len;
      const x = from[0] + dx * f, y = from[1] + dy * f, z = from[2] + dz * f;
      switch (type) {
        case 0: this.P({ x: x + rnd(6) - 3, y: y + rnd(6) - 3, z: z + rnd(6) - 3, ramp: RAMP3.slice((Math.random() * 4) | 0), rate: 8, die: t + 0.6, vz: 8, size: 1.6 }); break;
        case 1: this.P({ x: x + rnd(6) - 3, y: y + rnd(6) - 3, z: z + rnd(6) - 3, ramp: RAMP3.slice(2), rate: 6, die: t + 0.5, vz: 8, size: 1.6 }); break;
        case 2: case 4: this.P({ x: x + rnd(6) - 3, y: y + rnd(6) - 3, z: z + rnd(6) - 3, color: 67 + ((Math.random() * 4) | 0), die: t + 1.5, grav: 120, vx: rnd(8) - 4, vy: rnd(8) - 4 }); break;
        case 3: case 5: this.P({ x, y, z, color: type === 3 ? 52 + (i & 4) * 2 : 230 + (i & 4) * 2, die: t + 0.5, vx: type === 3 ? (i & 1 ? 30 : -30) : 0 }); break;
        default: this.P({ x, y, z, color: 9 * 16 + 8 + ((Math.random() * 4) | 0), die: t + 0.3 });
      }
    }
  }

  dlight(org: number[], radius: number, dur: number, decay = 0) {
    this.trans.push({ org, radius, die: this.now + dur * 1000, decay, born: this.now });
  }

  tempEntity(type: number, a: number[]) {
    const sv = this.sv!;
    const pos = [a[0], a[1], a[2]];
    const snd = (name: string) => this.snd.play(-1, 0, name, 255, 1, pos);
    switch (type) {
      case 0: case 1: case 2: {
        this.runParticles(pos, [0, 0, 0], 0, type === 0 ? 10 : 20);
        if (type !== 2) {
          const r = (Math.random() * 5) | 0;
          if (r >= 1 && r <= 3) snd(`weapons/ric${r}.wav`);
          else if (r === 4) snd('weapons/tink1.wav');
        }
        break;
      }
      case 3: this.particleExplosion(pos); this.dlight(pos, 350, 0.5, 300); snd('weapons/r_exp3.wav'); break;
      case 4: this.blobExplosion(pos); snd('weapons/r_exp3.wav'); break;
      case 5: case 6: case 9: this.rend.beams.push({ a: a.slice(1, 4), b: a.slice(4, 7), die: sv.time + 0.2 }); break;
      case 7: this.runParticles(pos, [0, 0, 0], 20, 30); snd('wizard/hit.wav'); break;
      case 8: this.runParticles(pos, [0, 0, 0], 226, 20); snd('hknight/hit.wav'); break;
      case 10: this.lavaSplash(pos); break;
      case 11: this.teleportSplash(pos); break;
      case 12: this.particleExplosion(pos); this.dlight(pos, 350, 0.5, 300); snd('weapons/r_exp3.wav'); break;
      case 13: this.rend.beams.push({ a: a.slice(1, 4), b: a.slice(4, 7), die: sv.time + 0.2 }); break;
    }
  }

  // ------------------------------------------------------------ frame
  frame(t: number) {
    this.now = t;
    let dt = (t - this.last) / 1000;
    this.last = t;
    if (dt > 0.1) dt = 0.1;
    if (this.W < 10) return;
    if (this.queued && this.state === 'loading') {
      this.drawOverlay();
      if (--this.queued.wait <= 0) {
        const q = this.queued;
        this.queued = null;
        this.startLevel(q.map, q.newGame);
        if ((this.state as State) === 'playing') this.resumeGame();
      }
      return;
    }
    const sv = this.sv;
    const running = this.state === 'playing' && sv && !this.menu && !this.paused;
    if (this.state === 'playing' && sv && !this.inter && (!this.net || this.net.role === 'host')) {
      if (sv.fget(this.viewEnt, 'health') <= 0) {
        // Dead: after a short pause, any fire, jump or Enter reloads the newest save.
        if (!this.deadAt) this.deadAt = this.now;
        const pressed = (this.mouseButtons & 1) || this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.keys.has('Space') || this.keys.has('Enter');
        if (this.now - this.deadAt > 1500 && pressed) {
          this.respawn();
          return;
        }
      } else {
        this.deadAt = 0;
        if (running && this.now - this.lastAuto > 60000) this.autosave();
      }
    }
    if (this.state === 'playing' && sv) {
      if (running) {
        const turn = 140 * dt * (this.alwaysRun !== (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) ? 1.5 : 1);
        if (this.keys.has('ArrowLeft')) this.viewAngles[1] += turn;
        if (this.keys.has('ArrowRight')) this.viewAngles[1] -= turn;
        const cmd = this.buildCmd();
        // A co-op joiner does not simulate: the host's state arrives over the network.
        if (!this.net || this.net.role === 'host') sv.update(dt, cmd);
        if (this.net?.role === 'host') this.net.pump(sv);
        // The joiner sends its input to the host, which moves this player.
        if (this.net?.role === 'client') {
          this.net.sendCmd(cmd);
          cmd.impulse = 0;
        }
        this.clientTime += dt;
        if (sv.pendingChange) {
          const map = sv.pendingChange;
          sv.pendingChange = null;
          this.queueLevel(map, false);
          return;
        }
        this.decay(dt);
        this.entityEffects();
      }
      this.renderWorld(dt, !!running);
    } else {
      this.hud.clearRect(0, 0, this.W, this.H);
      this.rend.renderer.clear(true, true, true);
    }
    this.drawOverlay();
  }

  private decay(dt: number) {
    this.cshift.dmg = Math.max(0, this.cshift.dmg - dt * 150);
    this.cshift.bonus = Math.max(0, this.cshift.bonus - dt * 100);
    this.dmgTime = Math.max(0, this.dmgTime - dt);
  }

  private entityEffects() {
    const sv = this.sv!;
    if (!this.ambientStarted && this.snd.ctx && this.snd.ctx.state === 'running') {
      this.ambientStarted = true;
      for (const a of this.ambientQueue) this.snd.ambient(a.org, a.name, a.vol, a.attn);
    }
    for (let e = 1; e < sv.numEdicts; e++) {
      if (sv.free[e]) {
        this.lastOrigin.delete(e);
        continue;
      }
      const mi = sv.fget(e, 'modelindex') | 0;
      const effects = sv.fget(e, 'effects') | 0;
      const org = sv.vget(e, 'origin');
      if (effects & 2) {
        const av = angleVectors(sv.vget(e, 'angles'));
        sv.fset(e, 'effects', effects & ~2); // one-shot: QuakeC never clears it here, so consume it
        this.trans.push({ org: [org[0] + av.forward[0] * 18, org[1] + av.forward[1] * 18, org[2] + av.forward[2] * 18 + (e === this.viewEnt ? 22 : 0)], radius: 200, die: this.now + 100, decay: 0, born: this.now });
      }
      if (effects & 4) this.trans.push({ org: org.slice(), radius: 400, die: this.now + 100, decay: 0, born: this.now });
      if (effects & 8) this.trans.push({ org: org.slice(), radius: 200, die: this.now + 100, decay: 0, born: this.now });
      if (!mi) continue;
      const name = sv.models[mi];
      if (!name || !name.endsWith('.mdl')) continue;
      const flags = this.rend.modelFlags(name);
      if (flags & 1) this.trans.push({ org: org.slice(), radius: 200, die: this.now + 100, decay: 0, born: this.now });
      const trailType = flags & 1 ? 0 : flags & 2 ? 1 : flags & 4 ? 2 : flags & 32 ? 4 : flags & 16 ? 3 : flags & 64 ? 5 : flags & 128 ? 6 : -1;
      const prev = this.lastOrigin.get(e);
      if (trailType >= 0 && prev) this.trail(prev, org, trailType);
      this.lastOrigin.set(e, org);
    }
  }

  private renderWorld(dt: number, running: boolean) {
    const sv = this.sv!;
    const e = 1;
    const org = sv.vget(e, 'origin');
    const vo = sv.vget(e, 'view_ofs');
    const vel = sv.vget(e, 'velocity');
    const time = sv.time;
    const health = sv.fget(e, 'health');
    // bob
    const cycle0 = (time - Math.floor(time / 0.6) * 0.6) / 0.6;
    const cycle = cycle0 < 0.5 ? (Math.PI * cycle0) / 0.5 : Math.PI + (Math.PI * (cycle0 - 0.5)) / 0.5;
    let bob = Math.hypot(vel[0], vel[1]) * 0.02;
    bob = bob * 0.3 + bob * 0.7 * Math.sin(cycle);
    bob = Math.max(-7, Math.min(4, bob));
    if (this.inter || this.state !== 'playing') bob = 0;
    const orgR = sv.lerpOrigin(e);
    const eye = [orgR[0] + vo[0] + 1 / 32, orgR[1] + vo[1] + 1 / 32, orgR[2] + vo[2] + bob + 1 / 32];
    // stair smoothing
    const onGround = ((sv.fget(e, 'flags') | 0) & 512) !== 0;
    if (onGround && org[2] - this.oldZ > 0) {
      const st = Math.max(0, Math.min(0.1, (this.now - this.oldTime) / 1000));
      this.oldZ += st * 80;
      if (this.oldZ > org[2]) this.oldZ = org[2];
      if (org[2] - this.oldZ > 12) this.oldZ = org[2] - 12;
      eye[2] += this.oldZ - org[2];
    } else this.oldZ = org[2];
    this.oldTime = this.now;
    // angles
    const pa = sv.vget(e, 'punchangle');
    const roll = calcRoll(this.viewAngles, vel);
    const kick = this.dmgTime / 0.5;
    const ang = [
      this.viewAngles[0] + pa[0] + this.dmgPitch * kick,
      this.viewAngles[1] + pa[1],
      roll + pa[2] + this.dmgRoll * kick + (health <= 0 ? 80 : 0) * 0,
    ];
    const time2 = this.inter ? this.interTime : time;
    void time2;
    // dynamic lights
    this.trans = this.trans.filter((d) => d.die > this.now);
    const lights: DLight[] = [];
    for (const d of this.trans) {
      let r = d.radius;
      if (d.decay) r = Math.max(0, r - ((this.now - d.born) / 1000) * d.decay);
      if (r > 0) lights.push({ org: d.org, radius: r });
    }
    // sort: nearest first, max 8
    lights.sort((a, b) => Math.hypot(a.org[0] - eye[0], a.org[1] - eye[1], a.org[2] - eye[2]) - Math.hypot(b.org[0] - eye[0], b.org[1] - eye[1], b.org[2] - eye[2]));
    lights.length = Math.min(lights.length, 8);
    // view weapon
    let weapon = null as null | { model: string; frame: number; origin: number[]; angles: number[] };
    const items = sv.fget(e, 'items') | 0;
    const wm = sv.vm.str(sv.iget(e, 'weaponmodel'));
    if (wm && !this.inter && health > 0 && !(items & IT.INVIS)) {
      const av = angleVectors([ang[0], ang[1], 0]);
      // Gun sways forward/back along the view direction (Ironwail-style), not up/down.
      const sway = bob * 0.6;
      const wo = [eye[0] - 1 / 32 + av.forward[0] * sway, eye[1] - 1 / 32 + av.forward[1] * sway, eye[2] - bob - 1 / 32 + 1];
      weapon = { model: wm, frame: sv.fget(e, 'weaponframe'), origin: [wo[0], wo[1], wo[2]], angles: [-ang[0], ang[1], 0] };
    }
    this.rend.render(sv, { origin: eye, angles: ang, time, dt: running ? dt : 0, dlights: lights, weapon, drawWorld: true, hideEntities: false });
    // audio listener
    const av = angleVectors(ang);
    this.snd.update(eye, av.right);
    this.eyeContents = sv.pointContents(eye);
    this.hud.clearRect(0, 0, this.W, this.H);
  }
  eyeContents = -1;

  // ------------------------------------------------------------ drawing helpers
  private get S() {
    return Math.max(1, Math.floor(Math.min(this.W / 320, this.H / 200) * 0.7));
  }
  private ox() { return Math.floor((this.W - 320 * this.S) / 2); }
  private oy() { return Math.floor((this.H - 200 * this.S) / 2); }
  private pic(name: string, x: number, y: number, bottom = false) {
    const c = this.assets.canvas(name);
    if (!c) return;
    const S = this.S;
    const ctx = this.hud;
    ctx.imageSmoothingEnabled = false;
    const py = bottom ? this.H + y * S : this.oy() + y * S;
    ctx.drawImage(c, this.ox() + x * S, py, c.width * S, c.height * S);
  }
  private picW(name: string) {
    return this.assets.canvas(name)?.width ?? 0;
  }
  private picH(name: string) {
    return this.assets.canvas(name)?.height ?? 0;
  }
  private ch(code: number, x: number, y: number, bottom = false) {
    const c = this.assets.conchars;
    if (!c) return;
    const S = this.S;
    const ctx = this.hud;
    ctx.imageSmoothingEnabled = false;
    const py = bottom ? this.H + y * S : this.oy() + y * S;
    ctx.drawImage(c, (code & 15) * 8, (code >> 4) * 8, 8, 8, this.ox() + x * S, py, 8 * S, 8 * S);
  }
  private text(s: string, x: number, y: number, bronze = false) {
    for (let i = 0; i < s.length; i++) this.ch((s.charCodeAt(i) & 255) + (bronze ? 128 : 0), x + i * 8, y);
  }
  private textPx(s: string, px: number, py: number) {
    const c = this.assets.conchars;
    if (!c) return;
    const S = this.S;
    const ctx = this.hud;
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i) & 255;
      ctx.drawImage(c, (code & 15) * 8, (code >> 4) * 8, 8, 8, px + i * 8 * S, py, 8 * S, 8 * S);
    }
  }
  private textC(s: string, y: number) {
    this.text(s, 160 - s.length * 4, y);
  }

  private drawNum(x: number, y: number, num: number, digits: number, red: boolean) {
    let s = String(Math.trunc(num));
    if (s.length > digits) s = s.slice(s.length - digits);
    x += (digits - s.length) * 24;
    for (const c of s) {
      const nm = c === '-' ? 'minus' : c;
      this.pic(`${red ? 'anum' : 'num'}_${nm}`, x, y, true);
      x += 24;
    }
  }

  private drawMinimalHud() {
    const sv = this.sv!;
    const e = 1;
    const items = sv.fget(e, 'items') | 0;
    const health = sv.fget(e, 'health') | 0;
    const armor = sv.fget(e, 'armorvalue') | 0;
    const ammo = sv.fget(e, 'currentammo') | 0;
    const y = -30;
    let face = 'face1';
    if (items & IT.INVIS && items & IT.INVULN) face = 'face_inv2';
    else if (items & IT.QUAD) face = 'face_quad';
    else if (items & IT.INVIS) face = 'face_invis';
    else if (items & IT.INVULN) face = 'face_invul1';
    else {
      const f = health >= 100 ? 4 : Math.max(0, Math.floor(health / 20));
      face = (this.now < this.faceAnimUntil ? 'face_p' : 'face') + (5 - f);
    }
    this.pic(face, 4, y, true);
    this.drawNum(32, y, health, 3, health <= 25);
    const an = items & IT.ARMOR3 ? 3 : items & IT.ARMOR2 ? 2 : items & IT.ARMOR1 ? 1 : 0;
    if (an) {
      const ay = y - 24;
      this.pic(`sb_armor${an}`, 4, ay, true);
      this.drawNum(32, ay, armor, 3, armor <= 25);
    }
    const ai = items & IT.SHELLS ? 'shells' : items & IT.NAILS ? 'nails' : items & IT.ROCKETS ? 'rocket' : items & IT.CELLS ? 'cells' : '';
    if (ai) {
      const ix = 320 - 4 - this.picW(`sb_${ai}`);
      this.pic(`sb_${ai}`, ix, y, true);
      this.drawNum(ix - 4 - 3 * 24, y, ammo, 3, ammo <= 10);
    }
  }

  private drawStatusBar() {
    const sv = this.sv!;
    const e = 1;
    const items = sv.fget(e, 'items') | 0;
    const health = sv.fget(e, 'health') | 0;
    const armor = sv.fget(e, 'armorvalue') | 0;
    const ammo = sv.fget(e, 'currentammo') | 0;
    const weapon = sv.fget(e, 'weapon') | 0;
    const ab = -24; // sbar row (virtual px from bottom)
    // opaque background: the classic bar was drawing over the view
    this.hud.fillStyle = '#000';
    this.hud.fillRect(0, this.H - 48 * this.S, this.W, 48 * this.S);
    // inventory bar
    this.pic('ibar', 0, ab - 24, true);
    const wn = ['shotgun', 'sshotgun', 'nailgun', 'snailgun', 'rlaunch', 'srlaunch', 'lightng'];
    for (let i = 0; i < 7; i++) {
      if (items & (1 << i)) this.pic(`${weapon === 1 << i ? 'inv2' : 'inv'}_${wn[i]}`, i * 24, ab - 16, true);
    }
    const ammos = [sv.fget(e, 'ammo_shells'), sv.fget(e, 'ammo_nails'), sv.fget(e, 'ammo_rockets'), sv.fget(e, 'ammo_cells')];
    for (let i = 0; i < 4; i++) {
      const s = String(Math.trunc(ammos[i])).padStart(3, ' ');
      for (let k = 0; k < 3; k++) if (s[k] !== ' ') this.ch(18 + s.charCodeAt(k) - 48, (6 * i + 1 + k) * 8 - 2, ab - 24 + 0, true);
    }
    const itn = ['key1', 'key2', 'invis', 'invuln', 'suit', 'quad'];
    for (let i = 0; i < 6; i++) if (items & (1 << (17 + i))) this.pic(`sb_${itn[i]}`, 192 + i * 16, ab - 16, true);
    for (let i = 0; i < 4; i++) if (items & (1 << (28 + i))) this.pic(`sb_sigil${i + 1}`, 320 - 32 + i * 8, ab - 16, true);
    // main bar
    this.pic('sbar', 0, ab, true);
    if (items & IT.INVULN) {
      this.pic('disc', 0, ab, true);
      this.drawNum(24, ab, 666, 3, true);
    } else {
      const an = items & IT.ARMOR3 ? 3 : items & IT.ARMOR2 ? 2 : items & IT.ARMOR1 ? 1 : 0;
      if (an) this.pic(`sb_armor${an}`, 0, ab, true);
      if (an) this.drawNum(24, ab, armor, 3, armor <= 25);
    }
    // face
    let face = 'face1';
    if (items & IT.INVIS && items & IT.INVULN) face = 'face_inv2';
    else if (items & IT.QUAD) face = 'face_quad';
    else if (items & IT.INVIS) face = 'face_invis';
    else if (items & IT.INVULN) face = 'face_invul1';
    else {
      const f = health >= 100 ? 4 : Math.max(0, Math.floor(health / 20));
      face = (this.now < this.faceAnimUntil ? 'face_p' : 'face') + (5 - f);
    }
    this.pic(face, 112, ab, true);
    this.drawNum(136, ab, health, 3, health <= 25);
    const ai = items & IT.SHELLS ? 'shells' : items & IT.NAILS ? 'nails' : items & IT.ROCKETS ? 'rocket' : items & IT.CELLS ? 'cells' : '';
    if (ai) this.pic(`sb_${ai}`, 224, ab, true);
    if (ai) this.drawNum(248, ab, ammo, 3, ammo <= 10);
  }

  private drawOverlay() {
    const ctx = this.hud;
    const S = this.S;
    if (this.state === 'playing' && this.sv) {
      const sv = this.sv;
      // screen blends
      const blends: number[][] = [];
      const c = this.eyeContents;
      if (c === -3) blends.push([130, 80, 50, 128]);
      else if (c === -5) blends.push([255, 80, 0, 150]);
      else if (c === -4) blends.push([0, 25, 5, 150]);
      const items = sv.fget(this.viewEnt, 'items') | 0;
      if (items & IT.QUAD) blends.push([0, 0, 255, 30]);
      else if (items & IT.SUIT) blends.push([0, 255, 0, 20]);
      else if (items & IT.INVIS) blends.push([100, 100, 100, 100]);
      else if (items & IT.INVULN) blends.push([255, 255, 0, 30]);
      if (this.cshift.bonus > 0) blends.push([215, 186, 69, this.cshift.bonus]);
      if (this.cshift.dmg > 0) blends.push([...this.cshift.dmgColor, this.cshift.dmg]);
      let a = 0, r = 0, g = 0, b = 0;
      for (const bl of blends) {
        const a2 = bl[3] / 255;
        if (!a2) continue;
        a = a + a2 * (1 - a);
        const k = a2 / a;
        r = r * (1 - k) + bl[0] * k;
        g = g * (1 - k) + bl[1] * k;
        b = b * (1 - k) + bl[2] * k;
      }
      if (a > 0) {
        ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${Math.min(0.9, a)})`;
        ctx.fillRect(0, 0, this.W, this.H);
      }
      if (this.inter) this.drawIntermission();
      else {
        if (this.hudStyle === 'minimal') this.drawMinimalHud();
        else this.drawStatusBar();
        // center print
        if (this.center.until > this.now) {
          const lines = this.center.text.split('\n');
          let y = 70 - Math.floor((lines.length * 8) / 2) + 0;
          for (const l of lines) {
            this.textC(l, y);
            y += 8;
          }
        }
      }
      // notify lines
      let py = 4;
      const recent = this.con.filter((l) => this.now - l.time < 3000).slice(-4);
      for (const l of recent) {
        this.textPx(l.text, 4, py);
        py += 8 * this.S;
      }
      if (this.paused && !this.menu) {
        const w = this.picW('gfx/pause.lmp'), h = this.picH('gfx/pause.lmp');
        this.pic('gfx/pause.lmp', (320 - w) / 2, (200 - 48 - h) / 2);
      }
    } else if (this.state === 'loading') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.W, this.H);
      const w = this.picW('gfx/loading.lmp'), h = this.picH('gfx/loading.lmp');
      this.pic('gfx/loading.lmp', (320 - w) / 2, (200 - 48 - h) / 2);
    } else if (this.state === 'title') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.W, this.H);
      const c = this.assets.canvas('gfx/conback.lmp');
      if (c) {
        ctx.globalAlpha = 0.5;
        ctx.imageSmoothingEnabled = false;
        const sc = Math.max(this.W / c.width, this.H / c.height);
        ctx.drawImage(c, (this.W - c.width * sc) / 2, (this.H - c.height * sc) / 2, c.width * sc, c.height * sc);
        ctx.globalAlpha = 1;
      }
    } else if (this.state === 'finale') {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, this.W, this.H);
      const n = Math.floor((this.now - this.finaleStart) / 1000 * 40);
      const txt = this.finaleText.slice(0, n);
      let x = 8, y = 16;
      for (const chr of txt) {
        if (chr === '\n') { x = 8; y += 8; continue; }
        this.ch(chr.charCodeAt(0) & 255, x, y);
        x += 8;
        if (x > 304) { x = 8; y += 8; }
      }
      if (this.now - this.finaleStart > 1500) this.textC('Press Space to continue', 188);
    }
    if (this.menu || this.state === 'title') this.drawMenu();
    void S;
  }

  private drawIntermission() {
    const sv = this.sv!;
    this.pic('gfx/complete.lmp', 64, 24);
    this.pic('gfx/inter.lmp', 0, 56);
    const t = Math.floor(this.interTime);
    const mins = Math.floor(t / 60), secs = t - mins * 60;
    const dn = (x: number, y: number, n: number, d: number) => {
      let s = String(n);
      if (s.length > d) s = s.slice(s.length - d);
      x += (d - s.length) * 24;
      for (const c of s) {
        this.pic(`num_${c}`, x, y);
        x += 24;
      }
    };
    dn(160, 64, mins, 3);
    this.pic('num_colon', 234, 64);
    this.pic(`num_${Math.floor(secs / 10)}`, 246, 64);
    this.pic(`num_${secs % 10}`, 266, 64);
    dn(160, 104, sv.gget('found_secrets') | 0, 3);
    this.pic('num_slash', 232, 104);
    dn(240, 104, sv.gget('total_secrets') | 0, 3);
    dn(160, 144, sv.gget('killed_monsters') | 0, 3);
    this.pic('num_slash', 232, 144);
    dn(240, 144, sv.gget('total_monsters') | 0, 3);
  }

  // ------------------------------------------------------------ menu
  private menuKey(ev: KeyboardEvent) {
    const k = ev.code;
    const inGame = this.state === 'playing' && !!this.sv;
    const up = k === 'ArrowUp' || k === 'KeyW';
    const down = k === 'ArrowDown' || k === 'KeyS';
    const left = k === 'ArrowLeft' || k === 'KeyA';
    const right = k === 'ArrowRight' || k === 'KeyD';
    const enter = k === 'Enter' || k === 'Space' || k === 'NumpadEnter';
    const cur = (page: string, n: number) => {
      if (up) this.menuCursor[page] = (this.menuCursor[page] + n - 1) % n;
      if (down) this.menuCursor[page] = (this.menuCursor[page] + 1) % n;
    };
    const back = (to: MenuPage) => {
      this.menu = to;
      if (!to && inGame) this.resumeGame();
    };
    switch (this.menu ?? 'main') {
      case 'main':
        if (k === 'Escape') {
          if (inGame) back(null);
          return;
        }
        cur('main', 5);
        if (enter) {
          switch (this.menuCursor.main) {
            case 0: this.menu = 'single'; break;
            case 1: this.menu = 'multi'; this.menuMsgUntil = this.now + 2500; break;
            case 2: this.menu = 'options'; break;
            case 3: this.menu = 'help'; this.helpPage = 0; break;
            case 4: this.menu = 'quit'; break;
          }
        }
        break;
      case 'single':
        if (k === 'Escape') return back('main');
        cur('single', 3);
        if (enter) {
          if (this.menuCursor.single === 0) this.newGame();
          else {
            this.menuCursor.saveload = 0;
            this.menu = 'saveload';
          }
        }
        break;
      case 'saveload': {
        if (k === 'Escape') return back('single');
        cur('saveload', 9);
        if (enter) {
          const slot = this.menuCursor.saveload;
          if (slot === 8) {
            if (this.menuCursor.single === 2) {
              this.menuMsg = 'Autosave is automatic';
              this.menuMsgUntil = this.now + 2000;
            } else if (this.autoRaw) this.loadRaw(this.autoRaw);
            else {
              this.menuMsg = 'No autosave yet';
              this.menuMsgUntil = this.now + 2000;
            }
          } else if (this.menuCursor.single === 2) {
            if (inGame && this.sv) {
              try {
                const data = this.snapshotRaw();
                localStorage.setItem('quakejs.save' + slot, data);
                this.saves[slot] = data;
                this.menuMsg = 'Game saved';
              } catch {
                this.menuMsg = 'Save failed (storage full?)';
              }
              this.menuMsgUntil = this.now + 2000;
            } else {
              this.menuMsg = 'Not playing a game';
              this.menuMsgUntil = this.now + 2000;
            }
          } else if (this.saves[slot]) this.loadGame(slot);
        }
        break;
      }
      case 'multi':
        if (enter) this.onCoop?.();
        if (k === 'Escape' || enter) back('main');
        break;
      case 'options': {
        if (k === 'Escape') return back('main');
        cur('options', 6);
        const c = this.menuCursor.options;
        const dir = left ? -1 : right || enter ? 1 : 0;
        if (dir) {
          if (c === 0 && enter) {
            this.sens = 3; this.alwaysRun = true; this.invertMouse = false; this.brightness = 1; this.snd.setVolume(0.7);
          } else if (c === 1) this.sens = Math.max(1, Math.min(11, this.sens + dir * 0.5));
          else if (c === 2) this.snd.setVolume(Math.max(0, Math.min(1, this.snd.volume + dir * 0.1)));
          else if (c === 3) this.alwaysRun = !this.alwaysRun;
          else if (c === 4) this.invertMouse = !this.invertMouse;
          else if (c === 5) this.hudStyle = this.hudStyle === 'minimal' ? 'classic' : 'minimal';
          this.applyBrightness();
          this.saveOpts();
        }
        break;
      }
      case 'help':
        if (k === 'Escape') return back('main');
        if (right || enter || up) this.helpPage = (this.helpPage + 1) % 6;
        if (left || down) this.helpPage = (this.helpPage + 5) % 6;
        break;
      case 'quit':
        if (k === 'KeyY' || k === 'Enter') {
          this.snd.stopAll();
          this.onQuit();
        } else if (k === 'KeyN' || k === 'Escape') back('main');
        break;
    }
  }

  resumeGame() {
    if (this.state === 'playing' && !this.inter) this.hudCanvas.requestPointerLock?.();
  }

  // Saves carry a real-time stamp so the newest one can be found for respawning.
  snapshotRaw(): string {
    return JSON.stringify({ ...this.sv!.saveState(), savedAt: Date.now() });
  }
  autosave(): boolean {
    const sv = this.sv;
    if (!sv || this.state !== 'playing' || this.inter || sv.fget(this.viewEnt, 'health') <= 0) return false;
    this.lastAuto = this.now;
    try {
      const data = this.snapshotRaw();
      localStorage.setItem('quakejs.auto', data);
      this.autoRaw = data;
      return true;
    } catch {
      return false;
    }
  }
  // The newest of the autosave and the eight manual saves.
  private newestSave(): string | null {
    let best: string | null = null;
    let bestT = -1;
    for (const r of [this.autoRaw, ...this.saves]) {
      if (!r) continue;
      let t = 0;
      try { t = JSON.parse(r).savedAt ?? 0; } catch { continue; }
      if (t > bestT) { bestT = t; best = r; }
    }
    return best;
  }
  respawn() {
    this.deadAt = 0;
    const raw = this.newestSave();
    if (raw) this.loadRaw(raw);
    else this.queueLevel(this.currentMap, true);
  }

  loadGame(slot: number) {
    this.loadRaw(this.saves[slot]);
  }
  /** Co-op: the player entity this screen follows and draws from. */
  setViewEnt(e: number) {
    this.viewEnt = e;
    this.rend.viewEnt = e;
  }
  loadRaw(raw: string | null) {
    if (!raw) return;
    try {
      const snap = JSON.parse(raw);
      this.currentMap = snap.mapName ?? this.currentMap;
      this.sv = this.makeServer();
      this.state = 'loading';
      this.levelReady = false;
      this.sv.loadState(snap);
      this.rend.loadLevel(this.sv);
      for (const s of this.sv.statics) this.rend.addStatic(s);
      this.levelReady = true;
      this.ambientQueue = [];
      this.snd.stopAll();
      this.ambientStarted = false;
      this.state = 'playing';
      this.menu = null;
      this.inter = false;
      this.lastOrigin.clear();
      const a = this.sv.vget(this.viewEnt, 'v_angle');
      this.viewAngles = [a[0], a[1], 0];
      this.resumeGame();
    } catch (e) {
      console.error(e);
      this.menuMsg = 'Load failed';
      this.menuMsgUntil = this.now + 2000;
      this.state = this.sv ? 'playing' : 'title';
    }
  }

  private box(x: number, y: number, w: number, h: number) {
    const ctx = this.hud, S = this.S;
    ctx.fillStyle = 'rgba(30,18,8,0.9)';
    ctx.fillRect(this.ox() + x * S, this.oy() + y * S, w * S, h * S);
    ctx.strokeStyle = '#8b5a2b';
    ctx.lineWidth = S;
    ctx.strokeRect(this.ox() + x * S, this.oy() + y * S, w * S, h * S);
  }

  private drawMenu() {
    const ctx = this.hud;
    const page = this.menu ?? 'main';
    if (this.state === 'playing') {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, this.W, this.H);
    }
    const dot = () => (Math.floor(this.now / 100) % 6) + 1;
    const plaque = () => this.pic('gfx/qplaque.lmp', 16, 4);
    const title = (n: string) => this.pic(n, (320 - this.picW(n)) / 2, 4);
    switch (page) {
      case 'main':
        plaque();
        title('gfx/ttl_main.lmp');
        this.pic('gfx/mainmenu.lmp', 72, 32);
        this.pic(`gfx/menudot${dot()}.lmp`, 54, 32 + this.menuCursor.main * 20);
        break;
      case 'single':
        plaque();
        title('gfx/ttl_sgl.lmp');
        this.pic('gfx/sp_menu.lmp', 72, 32);
        this.pic(`gfx/menudot${dot()}.lmp`, 54, 32 + this.menuCursor.single * 20);
        break;
      case 'saveload': {
        const saving = this.menuCursor.single === 2;
        title(saving ? 'gfx/p_save.lmp' : 'gfx/p_load.lmp');
        for (let i = 0; i < 9; i++) {
          let label = '--- UNUSED SLOT ---';
          const s = i < 8 ? this.saves[i] : this.autoRaw;
          if (i === 8) label = s ? 'AUTO' : 'AUTO (none yet)';
          if (s) {
            try {
              const j = JSON.parse(s);
              label = `${i === 8 ? 'AUTO: ' : ''}${j.mapName} (${Math.floor(j.time)}s)`;
            } catch { label = 'saved game'; }
          }
          this.text(label, 16, 32 + 8 * i);
        }
        this.ch(12 + (Math.floor(this.now / 250) & 1), 8, 32 + this.menuCursor.saveload * 8);
        break;
      }
      case 'multi':
        plaque();
        title('gfx/p_multi.lmp');
        this.box(40, 80, 240, 40);
        this.textC('Co-op over the network', 94);
        this.textC('press Enter to set up', 104);
        break;
      case 'options': {
        plaque();
        title('gfx/p_option.lmp');
        const rows: [string, string | null][] = [
          ['Reset to defaults', null], ['Mouse Speed', 'sens'], ['Sound Volume', 'vol'], ['Always Run', 'run'], ['Invert Mouse', 'inv'], ['HUD Style', 'hud'],
        ];
        rows.forEach(([label], i) => this.text(label, 16, 32 + i * 8));
        this.ch(12 + (Math.floor(this.now / 250) & 1), 200, 32 + this.menuCursor.options * 8);
        const slider = (y: number, r: number) => {
          this.ch(128, 220 - 8, y);
          for (let i = 0; i < 10; i++) this.ch(129, 220 + i * 8, y);
          this.ch(130, 220 + 80, y);
          this.ch(131, 220 + 8 * 9 * r, y);
        };
        slider(32 + 8, (this.sens - 1) / 10);
        slider(32 + 16, this.snd.volume);
        this.text(this.alwaysRun ? 'on' : 'off', 220, 32 + 24);
        this.text(this.invertMouse ? 'on' : 'off', 220, 32 + 32);
        this.text(this.hudStyle === 'minimal' ? 'minimal' : 'classic', 220, 32 + 40);
        this.textC('Arrows: select / adjust   Esc: back', 180);
        break;
      }
      case 'help':
        this.pic(`gfx/help${this.helpPage}.lmp`, 0, 0);
        break;
      case 'quit':
        this.box(56, 76, 208, 48);
        this.textC('Are you sure you want to', 88);
        this.textC('quit this game? (Y/N)', 100);
        break;
    }
    if (this.menuMsgUntil > this.now && this.menuMsg) {
      this.box(60, 150, 200, 20);
      this.textC(this.menuMsg, 156);
    }
  }
}
