import type { Server } from './server';

// Peer-to-peer co-op over WebRTC. The host runs the simulation and streams its entity
// memory to the joiner as deltas: only the words that changed since the last update.
// Connection codes are copied by hand, so no signalling server is needed.
// Peers only exchange local (host) addresses, so this works on the same network.
// Set iceServers to a STUN server to connect across different networks.

export type Role = 'host' | 'client';

const RTC_CONFIG: RTCConfiguration = { iceServers: [] };
const PUMP_MS = 50;

// Wait for ICE gathering to finish so the code carries every candidate. Some browsers
// never report 'complete' (gathering can stall), so give up after a short wait and
// send whatever candidates were found.
const ICE_WAIT_MS = 3000;
const waitForIce = (pc: RTCPeerConnection): Promise<void> =>
  new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', done);
      resolve();
    };
    const done = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, ICE_WAIT_MS);
    pc.addEventListener('icegatheringstatechange', done);
  });

// Codes are the SDP, deflated and written as URL-safe base64, to keep them short enough to paste.
const toB64Url = (u8: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64Url = (code: string): Uint8Array => {
  const s = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
const pipe = async (bytes: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> =>
  new Uint8Array(await new Response(new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(t as any)).arrayBuffer());
const encode = async (d: RTCSessionDescription): Promise<string> =>
  toB64Url(await pipe(new TextEncoder().encode(JSON.stringify({ t: d.type, s: d.sdp })), new CompressionStream('deflate-raw')));
const decode = async (code: string): Promise<RTCSessionDescriptionInit> => {
  const o = JSON.parse(new TextDecoder().decode(await pipe(fromB64Url(code.trim()), new DecompressionStream('deflate-raw'))));
  return { type: o.t, sdp: o.s };
};

export class NetSession {
  role: Role;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null = null;
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
    this.pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(this.pc.connectionState)) {
        this.open = false;
        this.setStatus('Connection lost');
      }
    };
  }

  private setStatus(s: string) {
    this.status = s;
    this.onStatus?.();
  }

  private attach(dc: RTCDataChannel) {
    this.dc = dc;
    dc.onopen = () => {
      this.open = true;
      this.setStatus('Connected');
      if (this.role === 'host') this.needFull = true;
    };
    dc.onclose = () => {
      this.open = false;
      this.setStatus('Disconnected');
    };
    dc.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.k === 'full') this.onFull?.(m.raw, m.ent);
      else if (m.k === 'd') this.onDelta?.(m);
      else if (m.k === 'cmd') this.inCmd = m.c;
    };
  }

  // ---- host: create an invite, then accept the joiner's answer
  async createInvite(): Promise<string> {
    this.attach(this.pc.createDataChannel('qinreact'));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitForIce(this.pc);
    this.setStatus('Invite ready. Send it to your friend, then paste their answer.');
    return encode(this.pc.localDescription!);
  }
  async acceptAnswer(code: string) {
    this.setStatus('Connecting...');
    await this.pc.setRemoteDescription(await decode(code));
  }

  // ---- joiner: take the host's invite and create an answer
  async createAnswer(inviteCode: string): Promise<string> {
    this.pc.ondatachannel = (e) => this.attach(e.channel);
    await this.pc.setRemoteDescription(await decode(inviteCode));
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitForIce(this.pc);
    this.setStatus('Answer ready. Send it back to the host.');
    return encode(this.pc.localDescription!);
  }

  close() {
    if (this.role === 'host' && this.remoteSv && this.remoteEnt) this.remoteSv.removeRemotePlayer(this.remoteEnt);
    this.remoteEnt = 0;
    this.remoteSv = null;
    this.inCmd = null;
    this.open = false;
    this.dc?.close();
    this.pc.close();
  }

  private send(m: unknown) {
    if (this.open && this.dc?.readyState === 'open') this.dc.send(JSON.stringify(m));
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
