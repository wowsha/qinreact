import Peer, { type DataConnection, type PeerOptions } from 'peerjs';
import type { Server } from './server';

// Peer-to-peer co-op. The host runs the simulation and streams its entity memory to the
// joiner as deltas: only the words that changed since the last update. The two browsers
// find each other through a PeerJS signalling broker, so the invite can be one link.
// Game data then flows directly between the browsers over WebRTC.

export type Role = 'host' | 'client';

const PUMP_MS = 50;

// Signalling broker. The public PeerJS cloud is used unless a build sets VITE_PEER_HOST
// (for example a local PeerServer for testing).
const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
const PEER_OPTIONS: PeerOptions = env.VITE_PEER_HOST
  ? { host: env.VITE_PEER_HOST, port: Number(env.VITE_PEER_PORT ?? 9000), path: '/', secure: env.VITE_PEER_SECURE === 'true' }
  : {};

// Invite ids are short and random. Knowing the id is enough to join, so share it only with the friend.
const newInviteId = () => 'qr-' + Math.random().toString(36).slice(2, 12);

export class NetSession {
  role: Role;
  peer: Peer | null = null;
  conn: DataConnection | null = null;
  open = false;
  status = '';
  /** Host: returns the full state as JSON (the game's save snapshot). */
  fullSender: (() => string) | null = null;
  /** Joiner: called with the full state and the joiner's own player entity, then with each delta. */
  onFull: ((raw: string, ent: number) => void) | null = null;
  onDelta: ((m: any) => void) | null = null;
  onStatus: (() => void) | null = null;

  // host: the joiner's player entity in the current level, and its latest input
  private remoteEnt = 0;
  private remoteSv: Server | null = null;
  private inCmd: any = null;

  private needFull = false;
  private lastSv: Server | null = null;
  private lastMap = '';
  private lastEv: Int32Array | null = null;
  private lastG: Int32Array | null = null;
  private lastFree: boolean[] = [];
  private lastDyn = 0;
  private lastLs = '';
  private lastPump = 0;

  constructor(role: Role) {
    this.role = role;
  }

  private setStatus(s: string) {
    this.status = s;
    this.onStatus?.();
  }

  private attach(conn: DataConnection) {
    this.conn = conn;
    conn.on('open', () => {
      this.open = true;
      this.setStatus('Connected');
      if (this.role === 'host') this.needFull = true;
    });
    conn.on('close', () => {
      this.open = false;
      this.setStatus('Disconnected');
    });
    conn.on('error', () => this.setStatus('Connection error'));
    conn.on('data', (data) => {
      const m = data as any;
      if (m.k === 'full') this.onFull?.(m.raw, m.ent);
      else if (m.k === 'd') this.onDelta?.(m);
      else if (m.k === 'cmd') this.inCmd = m.c;
    });
    if (conn.open) {
      this.open = true;
      this.setStatus('Connected');
    }
  }

  private openPeer(id?: string): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id, PEER_OPTIONS) : new Peer(PEER_OPTIONS);
      this.peer = peer;
      peer.on('open', () => resolve(peer));
      peer.on('error', (err) => {
        this.setStatus(`Could not reach the matchmaking server (${err.type}).`);
        reject(err);
      });
    });
  }

  // ---- host: create an invite. The returned id goes into the invite link.
  async createInvite(): Promise<string> {
    const id = newInviteId();
    const peer = await this.openPeer(id);
    peer.on('connection', (conn) => {
      // One friend at a time.
      if (this.conn && this.conn.open) {
        conn.close();
        return;
      }
      this.attach(conn);
    });
    this.setStatus('Invite ready. Send the link to your friend.');
    return id;
  }

  // ---- joiner: connect to the host's invite id
  async join(inviteId: string): Promise<void> {
    await this.openPeer();
    this.setStatus('Connecting...');
    this.attach(this.peer!.connect(inviteId, { reliable: true }));
  }

  close() {
    if (this.role === 'host' && this.remoteSv && this.remoteEnt) this.remoteSv.removeRemotePlayer(this.remoteEnt);
    this.remoteEnt = 0;
    this.remoteSv = null;
    this.inCmd = null;
    this.open = false;
    this.conn?.close();
    this.peer?.destroy();
    this.peer = null;
    this.conn = null;
  }

  private send(m: unknown) {
    if (this.open && this.conn?.open) this.conn.send(m);
  }

  // ---- joiner: send this frame's input to the host
  sendCmd(c: { forward: number; side: number; up: number; buttons: number; impulse: number; angles: number[] }) {
    this.send({ k: 'cmd', c: { forward: c.forward, side: c.side, up: c.up, buttons: c.buttons, impulse: c.impulse, angles: [c.angles[0], c.angles[1], c.angles[2]] } });
  }

  // ---- host: called after each simulation step
  pump(sv: Server) {
    if (this.role !== 'host' || !this.open || !this.fullSender) return;
    // A new level gets a new player entity for the joiner.
    if (sv !== this.remoteSv) {
      this.remoteSv = sv;
      this.remoteEnt = sv.addRemotePlayer();
      this.needFull = true;
    }
    // Input from the joiner drives their player entity from the next tick.
    if (this.inCmd) sv.remoteCmds.set(this.remoteEnt, this.inCmd);
    const now = performance.now();
    if (!this.needFull && now - this.lastPump < PUMP_MS) return;
    this.lastPump = now;

    if (this.needFull || sv !== this.lastSv || sv.mapName !== this.lastMap) {
      this.needFull = false;
      this.send({ k: 'full', raw: this.fullSender(), ent: this.remoteEnt });
      this.lastSv = sv;
      this.lastMap = sv.mapName;
      this.lastEv = Int32Array.from(sv.vm.evI);
      this.lastG = Int32Array.from(sv.vm.gI);
      this.lastFree = sv.free.map((f: boolean) => !!f);
      this.lastDyn = sv.vm.dynStrings.length;
      this.lastLs = JSON.stringify(sv.lightstyles);
      return;
    }

    const vm = sv.vm;
    const ev: number[] = [];
    const le = this.lastEv!;
    for (let i = 0; i < le.length; i++) {
      const v = vm.evI[i];
      if (v !== le[i]) { ev.push(i, v); le[i] = v; }
    }
    const g: number[] = [];
    const lg = this.lastG!;
    for (let i = 0; i < lg.length; i++) {
      const v = vm.gI[i];
      if (v !== lg[i]) { g.push(i, v); lg[i] = v; }
    }
    const fr: number[] = [];
    for (let i = 0; i < sv.numEdicts; i++) {
      const f = !!sv.free[i];
      if (f !== this.lastFree[i]) { fr.push(i, f ? 1 : 0); this.lastFree[i] = f; }
    }
    const dy = vm.dynStrings.length > this.lastDyn ? vm.dynStrings.slice(this.lastDyn) : [];
    this.lastDyn = vm.dynStrings.length;
    const ls = JSON.stringify(sv.lightstyles);
    const lsChanged = ls !== this.lastLs;
    this.lastLs = ls;
    this.send({ k: 'd', t: sv.time, ne: sv.numEdicts, ev, g, fr, dy, ls: lsChanged ? sv.lightstyles : null });
  }
}

/** Joiner: apply one delta from the host to the local server. */
export function applyDelta(sv: Server, m: any) {
  const vm = sv.vm;
  const ev = m.ev as number[];
  for (let i = 0; i < ev.length; i += 2) vm.evI[ev[i]] = ev[i + 1];
  const g = m.g as number[];
  for (let i = 0; i < g.length; i += 2) vm.gI[g[i]] = g[i + 1];
  const fr = m.fr as number[];
  for (let i = 0; i < fr.length; i += 2) sv.free[fr[i]] = !!fr[i + 1];
  for (const s of m.dy as string[]) vm.dynStrings.push(s);
  if (m.ls) sv.lightstyles = m.ls;
  sv.numEdicts = m.ne;
  sv.time = m.t;
}
